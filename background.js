// background.js: Service Worker (Manifest V3)
// Handles: scheduled cleanups, messaging coordination, undo/backup, stats persistence

(() => {
  "use strict";

  const SW_VERSION = "7.12.0";

  // =========================
  // Storage Keys
  // =========================

  const STORAGE_KEYS = Object.freeze({
    SCHEDULES: "schedules",
    STATS: "cleanupStats",
    UNDO_LOG: "undoLog",
    ACTIVE_RUN: "activeRun",
    WHITELIST: "whitelist",
    PROTECT_KEYWORDS: "protectKeywords",
    WHITELIST_SUGGESTIONS: "whitelistSuggestions",
    SNOOZE_UNTIL: "snoozeUntil",
    NOTIFY_ENABLED: "notifyOnComplete",
    SUBSCRIPTIONS: "subscriptionScan",
    STORAGE_XRAY: "storageXray",
    XRAY_PENDING: "storageXrayPendingPurge",
    LAYOUT_CHANGE: "layoutChangeNotice",
    SMART_SCAN: "smartScan",
    SMART_FEEDBACK: "smartFeedback",
    SMART_PENDING: "smartPendingApply",
    AUTOPILOT: "autoPilot",
    AUTOPILOT_STATE: "autoPilotState"
  });

  // chrome.storage.sync caps: 8KB per item, 102KB total. The options
  // page enforces this for rules; this helper duplicates the check for
  // anything the SW writes (schedules, whitelist edits). Issue #10.
  const SYNC_LIMIT_ITEM = 8192;

  function estimateBytes(obj) {
    try { return new Blob([JSON.stringify(obj ?? null)]).size; }
    catch { return (JSON.stringify(obj ?? null) || "").length * 2; }
  }

  async function safeSyncSet(data, label = "data") {
    for (const [key, value] of Object.entries(data || {})) {
      const size = estimateBytes({ [key]: value });
      if (size > SYNC_LIMIT_ITEM) {
        throw new Error(`${label} too large for sync (${Math.round(size / 1024)}KB, max 8KB)`);
      }
    }
    await chrome.storage.sync.set(data);
  }

  // Serialize read-modify-write operations against chrome.storage.local.
  // recordStats / recordUndoEntry / recordSenderHits /
  // recordSenderInteraction each do get -> mutate -> set, and the content
  // script fires several of them per pass. Run concurrently, their gets
  // read stale data and their sets clobber one another (lost updates).
  // Chaining each through this queue guarantees one completes before the
  // next reads.
  let _storageChain = Promise.resolve();
  function withStorageLock(fn) {
    const next = _storageChain.then(fn, fn);
    // Keep the chain alive even if fn rejects.
    _storageChain = next.then(() => {}, () => {});
    return next;
  }

  // =========================
  // Alarm Names
  // =========================

  const ALARM_PREFIX = "gcc_schedule_";
  const STATS_CLEANUP_ALARM = "gcc_stats_cleanup";
  const AUTOPILOT_ALARM = "gcc_autopilot";

  // =========================
  // Lifecycle
  // =========================

  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(`[GCC SW] Installed/Updated (${details.reason}), v${SW_VERSION}`);

    // Set up periodic stats cleanup alarm (once per day)
    chrome.alarms.create(STATS_CLEANUP_ALARM, { periodInMinutes: 1440 });

    // Restore saved schedules
    await restoreScheduledAlarms();
    await restoreAutoPilotAlarm();
  });

  chrome.runtime.onStartup.addListener(async () => {
    console.log("[GCC SW] Browser startup");
    await restoreScheduledAlarms();
    await restoreAutoPilotAlarm();
  });

  // Clean up ACTIVE_RUN if the Gmail tab is closed mid-run
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    try {
      const result = await chrome.storage.session?.get?.(STORAGE_KEYS.ACTIVE_RUN)
        || await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_RUN);
      const run = result?.[STORAGE_KEYS.ACTIVE_RUN];
      if (run && run.gmailTabId === tabId) {
        console.log("[GCC SW] Gmail tab closed, clearing ACTIVE_RUN");
        await chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: null });
        await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null });
      }
    } catch (e) {
      console.error("[GCC SW] tabs.onRemoved cleanup failed:", e);
    }
  });

  // =========================
  // Alarm Handler (Scheduled Cleanups)
  // =========================

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === STATS_CLEANUP_ALARM) {
      await pruneOldStats();
      return;
    }

    if (alarm.name === AUTOPILOT_ALARM) {
      await runAutoPilot();
      return;
    }

    if (alarm.name.startsWith(ALARM_PREFIX)) {
      const scheduleId = alarm.name.replace(ALARM_PREFIX, "");
      await runScheduledCleanup(scheduleId);
    }
  });

  async function restoreScheduledAlarms() {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
      const schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];

      // Clear old alarms and recreate
      const existingAlarms = await chrome.alarms.getAll();
      for (const alarm of existingAlarms) {
        if (alarm.name.startsWith(ALARM_PREFIX)) {
          await chrome.alarms.clear(alarm.name);
        }
      }

      const now = Date.now();
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        const alarmName = ALARM_PREFIX + schedule.id;
        const periodMinutes = schedule.intervalMinutes || 10080; // default weekly
        // chrome.alarms.create resets the period timer on every call, so
        // recreating alarms on each startup/install would perpetually
        // defer a long interval on machines that restart often. Anchor
        // the next fire to lastRun + interval instead. Overdue schedules
        // fire shortly; brand-new ones fire ~1 min out.
        const lastRun = Number(schedule.lastRun) || 0;
        const nextDue = lastRun ? lastRun + periodMinutes * 60 * 1000 : now + 60 * 1000;
        chrome.alarms.create(alarmName, {
          when: nextDue > now ? nextDue : now + 60 * 1000,
          periodInMinutes: periodMinutes
        });
      }

      console.log(`[GCC SW] Restored ${schedules.filter(s => s.enabled).length} scheduled alarms`);
    } catch (e) {
      console.error("[GCC SW] Failed to restore alarms", e);
    }
  }

  async function getSnoozeUntil() {
    try {
      const r = await chrome.storage.local.get(STORAGE_KEYS.SNOOZE_UNTIL);
      const v = Number(r?.[STORAGE_KEYS.SNOOZE_UNTIL] || 0);
      return Number.isFinite(v) && v > Date.now() ? v : 0;
    } catch { return 0; }
  }

  async function hasActiveRun() {
    try {
      const sess = await chrome.storage.session?.get?.(STORAGE_KEYS.ACTIVE_RUN);
      const local = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_RUN);
      const run = sess?.[STORAGE_KEYS.ACTIVE_RUN] || local?.[STORAGE_KEYS.ACTIVE_RUN] || null;
      if (!run || typeof run !== "object" || !run.gmailTabId || !run.startedAt) return null;
      // TTL guard: 2h, same as popup. Stale entries are cleared.
      if (Date.now() - run.startedAt > 1000 * 60 * 60 * 2) {
        await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null });
        await chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: null });
        return null;
      }
      return run;
    } catch { return null; }
  }

  async function runScheduledCleanup(scheduleId) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 5000;

    // Honour snooze / vacation mode before doing any work.
    const snoozeUntil = await getSnoozeUntil();
    if (snoozeUntil) {
      console.log(`[GCC SW] Snooze active until ${new Date(snoozeUntil).toISOString()}, skipping schedule ${scheduleId}`);
      return;
    }

    // Issue #6: don't stomp on a manual run that's currently in flight.
    // The content script's GCC_ATTACHED guard catches duplicate
    // injection, but we'd still overwrite window.GMAIL_CLEANER_CONFIG
    // before the inner check sees the dup, mutating the active run.
    const active = await hasActiveRun();
    if (active) {
      console.log(`[GCC SW] Manual run in progress on tab ${active.gmailTabId}, skipping schedule ${scheduleId}`);
      return;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await chrome.storage.sync.get([STORAGE_KEYS.SCHEDULES, STORAGE_KEYS.PROTECT_KEYWORDS]);
        const schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];
        const schedule = schedules.find(s => s.id === scheduleId);

        if (!schedule || !schedule.enabled) return;

        // 6.1: scheduled runs honour the global protected-keyword shield.
        // Passed raw; the engine's sanitizeConfig cleans + caps it.
        const protectKeywords = Array.isArray(result?.[STORAGE_KEYS.PROTECT_KEYWORDS])
          ? result[STORAGE_KEYS.PROTECT_KEYWORDS]
          : [];

        // Find a Gmail tab
        const gmailTabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
        if (!gmailTabs.length) {
          console.log("[GCC SW] No Gmail tab found for scheduled cleanup, skipping");
          return;
        }

        // Prefer active Gmail tab, fall back to first
        const gmailTab = gmailTabs.find(t => t.active) || gmailTabs[0];

        // Verify tab is still valid before using it
        try {
          await chrome.tabs.get(gmailTab.id);
        } catch {
          console.log("[GCC SW] Selected Gmail tab no longer valid, skipping");
          return;
        }

        // Claim ACTIVE_RUN so any concurrently-opened popup sees the
        // schedule in flight and refuses to start. Issue #6.
        const runId = `sched_${scheduleId}_${Date.now()}`;
        const claim = { gmailTabId: gmailTab.id, runId, startedAt: Date.now(), source: "schedule" };
        try {
          await chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: claim });
        } catch {}
        await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: claim });

        const config = {
          intensity: schedule.intensity || "light",
          dryRun: false,
          safeMode: true,
          tagBeforeDelete: true,
          tagLabelPrefix: "GmailCleaner",
          guardSkipStarred: true,
          guardSkipImportant: true,
          guardSkipUnread: true,
          guardSkipUserLabels: true,
          minAge: schedule.minAge || "3m",
          archiveInsteadOfDelete: schedule.action === "archive",
          debugMode: false,
          reviewMode: false,
          whitelist: schedule.whitelist || [],
          protectKeywords,
          version: SW_VERSION,
          scheduled: true,
          scheduleId,
          runId
        };

        // Inject config and content script
        await chrome.scripting.executeScript({
          target: { tabId: gmailTab.id },
          func: (cfg) => { window.GMAIL_CLEANER_CONFIG = cfg; },
          args: [config]
        });

        await chrome.scripting.executeScript({
          target: { tabId: gmailTab.id },
          files: ["contentScript.js"]
        });

        // Update last run timestamp (quota-safe write).
        schedule.lastRun = Date.now();
        await safeSyncSet({ [STORAGE_KEYS.SCHEDULES]: schedules }, "schedules");

        console.log(`[GCC SW] Scheduled cleanup started: ${scheduleId}`);
        return; // Success, exit retry loop
      } catch (e) {
        console.error(`[GCC SW] Scheduled cleanup attempt ${attempt + 1} failed:`, e);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
  }

  // =========================
  // Message Router
  // =========================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg?.type) return;

    // Validate sender: only accept messages from this extension or Gmail tabs
    const isExtensionPage = sender.id === chrome.runtime.id && !sender.tab;
    const isGmailTab = sender.tab?.url?.startsWith("https://mail.google.com/");
    const isContentScript = sender.id === chrome.runtime.id && sender.tab;

    if (!isExtensionPage && !isGmailTab && !isContentScript) {
      console.warn("[GCC SW] Rejected message from unexpected sender:", sender);
      return;
    }

    switch (msg.type) {
      // Progress messages from content script already reach all extension
      // pages via chrome.runtime.sendMessage, no re-broadcast needed.
      // 7.5: layout-change errors additionally leave a small record
      // (timestamp + detail) so the Diagnostics page the popup points
      // at has something to show. Latest record wins; fire-and-forget
      // because the progress path must never block on storage.
      case "gmailCleanerProgress":
        if (msg.phase === "error" && msg.code === "gmail_layout_changed") {
          try {
            const write = chrome.storage.local.set({
              [STORAGE_KEYS.LAYOUT_CHANGE]: {
                at: Date.now(),
                detail: typeof msg.detail === "string" ? msg.detail.slice(0, 300) : ""
              }
            });
            write?.catch?.(() => {});
          } catch (e) {
            console.warn("[GCC SW] Failed to record layout change:", e);
          }
        }
        // Auto-Pilot (7.12): terminal progress messages drive the
        // sweep's stage machine. Fire-and-forget like the layout
        // record, and only terminal messages touch storage so the
        // per-pass progress beats stay free.
        if (msg.done || msg.phase === "done" || msg.phase === "cancelled" || msg.phase === "error") {
          withStorageLock(() => handleAutoPilotProgress(msg))
            .catch((e) => console.warn("[GCC SW] autopilot progress failed:", e?.message || e));
        }
        break;

      // Stats recording
      case "gmailCleanerRecordStats":
        withStorageLock(() => recordStats(msg.data)).then(() => sendResponse({ ok: true }));
        return true;

      // Undo log
      case "gmailCleanerRecordUndo":
        withStorageLock(() => recordUndoEntry(msg.data)).then(() => sendResponse({ ok: true }));
        return true;

      // 7.6: a finished restore run marks the log entries it emptied.
      case "gmailCleanerRecordRestore":
        withStorageLock(() => recordRestoreOutcome(msg.data)).then(() => sendResponse({ ok: true }));
        return true;

      case "gmailCleanerGetUndoLog":
        getUndoLog().then(log => sendResponse({ ok: true, log }));
        return true;

      case "gmailCleanerClearUndoLog":
        clearUndoLog().then(() => sendResponse({ ok: true }));
        return true;

      // Stats retrieval
      case "gmailCleanerGetStats":
        getStats().then(stats => sendResponse({ ok: true, stats }));
        return true;

      // Schedule management
      case "gmailCleanerGetSchedules":
        getSchedules().then(schedules => sendResponse({ ok: true, schedules }));
        return true;

      case "gmailCleanerSaveSchedule":
        saveSchedule(msg.schedule)
          .then(() => restoreScheduledAlarms())
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "save failed" }));
        return true;

      case "gmailCleanerDeleteSchedule":
        deleteSchedule(msg.scheduleId)
          .then(() => restoreScheduledAlarms())
          .then(() => sendResponse({ ok: true }));
        return true;

      // Whitelist suggestions
      case "gmailCleanerGetWhitelistSuggestions":
        getWhitelistSuggestions().then(suggestions => sendResponse({ ok: true, suggestions }));
        return true;

      case "gmailCleanerRecordSenderInteraction":
        withStorageLock(() => recordSenderInteraction(msg.data)).then(() => sendResponse({ ok: true }));
        return true;

      // Ping
      case "gmailCleanerSwPing":
        sendResponse({ ok: true, version: SW_VERSION });
        break;

      // Multi-account: list Gmail tabs
      case "gmailCleanerListGmailTabs":
        listGmailTabs().then(tabs => sendResponse({ ok: true, tabs }));
        return true;

      // Snooze / vacation mode (5.0)
      case "gmailCleanerGetSnooze":
        getSnoozeUntil().then(until => sendResponse({ ok: true, until }));
        return true;

      case "gmailCleanerSetSnooze":
        setSnooze(msg.days).then((until) => sendResponse({ ok: true, until }));
        return true;

      // Add a sender to the global whitelist (called from stats top-senders UI)
      case "gmailCleanerAddToWhitelist":
        addToWhitelist(msg.sender)
          .then((added) => sendResponse({ ok: true, added }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      // Capture sender hits during cleanup to feed the top-senders dashboard
      case "gmailCleanerRecordSenders":
        withStorageLock(() => recordSenderHits(msg.senders)).then(() => sendResponse({ ok: true }));
        return true;

      // Subscriptions (7.0): persist the latest scan so the popup can
      // render it any time, merging in statuses from earlier runs.
      case "gmailCleanerSubscriptionScanResult":
        withStorageLock(() => recordSubscriptionScan(msg.senders)).then(() => sendResponse({ ok: true }));
        return true;

      // Subscriptions (7.0): per-sender unsubscribe outcomes.
      case "gmailCleanerRecordUnsubscribes":
        withStorageLock(() => recordUnsubscribeResults(msg.results)).then(() => sendResponse({ ok: true }));
        return true;

      case "gmailCleanerGetSubscriptions":
        chrome.storage.local.get(STORAGE_KEYS.SUBSCRIPTIONS)
          .then((r) => sendResponse({ ok: true, scan: r?.[STORAGE_KEYS.SUBSCRIPTIONS] || null }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      // Storage X-ray (7.2): persist the latest tiered size scan.
      case "gmailCleanerStorageScanResult":
        withStorageLock(() => recordStorageScan(msg.senders, msg.totalMb, msg.totalCount))
          .then(() => sendResponse({ ok: true }));
        return true;

      case "gmailCleanerGetStorageScan":
        chrome.storage.local.get(STORAGE_KEYS.STORAGE_XRAY)
          .then((r) => sendResponse({ ok: true, scan: r?.[STORAGE_KEYS.STORAGE_XRAY] || null }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      // Storage X-ray (7.2): the popup registers which senders a purge
      // run targets; gmailCleanerDone consumes it (the popup usually
      // closes long before the run finishes).
      case "gmailCleanerStorageXrayPurgeStarted":
        withStorageLock(() => recordPendingStoragePurge(msg.runId, msg.senders))
          .then(() => sendResponse({ ok: true }));
        return true;

      // Smart Suggestions (7.8): persist the latest recommendation
      // scan, union-merged so senders measured on earlier scans keep
      // their place while new ones join.
      case "gmailCleanerSmartScanResult":
        withStorageLock(() => recordSmartScan(msg.senders)).then(() => sendResponse({ ok: true }));
        return true;

      case "gmailCleanerGetSmartScan":
        chrome.storage.local.get([STORAGE_KEYS.SMART_SCAN, STORAGE_KEYS.SMART_FEEDBACK])
          .then((r) => sendResponse({
            ok: true,
            scan: r?.[STORAGE_KEYS.SMART_SCAN] || null,
            feedback: r?.[STORAGE_KEYS.SMART_FEEDBACK] || null
          }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      // Smart Suggestions (7.8): dismissals arrive directly from the
      // popup; "applied" is only ever written by the pending-apply
      // marker below, once a real run confirms.
      case "gmailCleanerSmartFeedback":
        withStorageLock(() => recordSmartFeedback([{ email: msg.email, action: msg.action }]))
          .then(() => sendResponse({ ok: true }));
        return true;

      // Smart Suggestions (7.8): the popup registers which senders an
      // apply run targets; gmailCleanerDone consumes it, same marker
      // pattern as the X-ray purge.
      case "gmailCleanerSmartApplyStarted":
        withStorageLock(() => recordPendingSmartApply(msg.runId, msg.senders))
          .then(() => sendResponse({ ok: true }));
        return true;

      // Auto-Pilot (7.12): popup settings surface.
      case "gmailCleanerGetAutoPilot":
        getAutoPilotForPopup()
          .then((autoPilot) => sendResponse({ ok: true, autoPilot }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      case "gmailCleanerSetAutoPilot":
        setAutoPilotEnabled(Boolean(msg.enabled))
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      case "gmailCleanerConfirmAutoPilot":
        confirmAutoPilot()
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      case "gmailCleanerDone":
        // Clean up active run state when cleanup finishes
        chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: null })
          .catch(e => console.warn("[GCC SW] session clear on done failed:", e));
        chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null })
          .catch(e => console.warn("[GCC SW] local clear on done failed:", e));
        // Storage X-ray (7.2): if this run was a registered purge, mark
        // its senders in the stored scan.
        if (msg.summary) {
          withStorageLock(() => resolvePendingStoragePurge(msg.summary))
            .catch((e) => console.warn("[GCC SW] purge resolve failed:", e?.message || e));
        }
        // Smart Suggestions (7.8): if this run was a registered apply,
        // record "applied" feedback for its senders.
        if (msg.summary) {
          withStorageLock(() => resolvePendingSmartApply(msg.summary))
            .catch((e) => console.warn("[GCC SW] smart apply resolve failed:", e?.message || e));
        }
        // Auto-Pilot (7.12): if this run was the sweep's apply stage,
        // close it out (preview tally or live last-run summary).
        if (msg.summary) {
          withStorageLock(() => resolveAutoPilotDone(msg.summary))
            .catch((e) => console.warn("[GCC SW] autopilot resolve failed:", e?.message || e));
        }
        // Surface a desktop notification if the user opted in.
        if (msg.summary) {
          maybeNotifyDone(msg.summary).catch((e) =>
            console.warn("[GCC SW] notify on done failed:", e?.message || e)
          );
        }
        break;

      default:
        // Unknown types still get a response so callers don't hang.
        sendResponse({ ok: false, error: "unknown message type" });
        break;
    }
  });

  // =========================
  // Snooze / vacation
  // =========================

  async function setSnooze(days) {
    const ms = Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000;
    if (!ms) {
      await chrome.storage.local.set({ [STORAGE_KEYS.SNOOZE_UNTIL]: null });
      return 0;
    }
    const until = Date.now() + ms;
    await chrome.storage.local.set({ [STORAGE_KEYS.SNOOZE_UNTIL]: until });
    return until;
  }

  // =========================
  // Whitelist mutation (used by stats top-senders Protect button)
  // =========================

  async function addToWhitelist(sender) {
    const s = String(sender || "").trim();
    if (!s) throw new Error("empty sender");
    const r = await chrome.storage.sync.get(STORAGE_KEYS.WHITELIST);
    const wl = Array.isArray(r?.[STORAGE_KEYS.WHITELIST]) ? r[STORAGE_KEYS.WHITELIST] : [];
    if (wl.includes(s)) return false;
    wl.push(s);
    if (wl.length > 200) wl.shift();
    await safeSyncSet({ [STORAGE_KEYS.WHITELIST]: wl }, "whitelist");
    return true;
  }

  // =========================
  // Top senders accumulation
  // =========================
  // The content script samples sender addresses from the Gmail list view
  // before each delete batch and forwards them here. We aggregate counts
  // into stats.topSenders, capped to 200 entries to keep storage small.

  async function recordSenderHits(senders) {
    if (!Array.isArray(senders) || senders.length === 0) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STATS);
      const stats = result?.[STORAGE_KEYS.STATS] || {};
      // Write back a complete stats shape so a topSenders-only object
      // never reaches recordStats, which would throw on categoryBreakdown.
      stats.totalRuns = stats.totalRuns || 0;
      stats.totalDeleted = stats.totalDeleted || 0;
      stats.totalArchived = stats.totalArchived || 0;
      stats.totalFreedMb = stats.totalFreedMb || 0;
      stats.history = Array.isArray(stats.history) ? stats.history : [];
      stats.categoryBreakdown = stats.categoryBreakdown || {};
      stats.dailyStats = stats.dailyStats || {};
      const map = Object.create(null);
      for (const entry of stats.topSenders || []) {
        if (entry?.sender) map[entry.sender] = { count: entry.count || 0, lastSeen: entry.lastSeen || 0 };
      }
      for (const raw of senders) {
        const s = String(raw || "").trim().toLowerCase();
        if (!s || s.length > 200) continue;
        if (!map[s]) map[s] = { count: 0, lastSeen: 0 };
        map[s].count += 1;
        map[s].lastSeen = Date.now();
      }
      const merged = Object.entries(map)
        .map(([sender, v]) => ({ sender, count: v.count, lastSeen: v.lastSeen }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 200);
      stats.topSenders = merged;
      await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
    } catch (e) {
      console.error("[GCC SW] recordSenderHits failed:", e);
    }
  }

  // =========================
  // Subscriptions store (7.0)
  // =========================
  // One local-storage object: { updatedAt, senders: [{ email, name,
  // count, status, statusAt }] }. A fresh scan replaces the sender list
  // but keeps the unsubscribe status of senders it sees again, so "done"
  // badges survive a re-scan. Statuses come from the content script:
  // unsubscribed | manual | no_button | no_dialog | not_found | error.

  async function recordSubscriptionScan(senders) {
    if (!Array.isArray(senders)) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SUBSCRIPTIONS);
      const prev = result?.[STORAGE_KEYS.SUBSCRIPTIONS] || {};
      const prevStatus = Object.create(null);
      for (const entry of prev.senders || []) {
        if (entry?.email && entry.status) {
          prevStatus[entry.email] = { status: entry.status, statusAt: entry.statusAt || 0 };
        }
      }
      const clean = [];
      for (const raw of senders.slice(0, 200)) {
        const email = String(raw?.email || "").trim().toLowerCase();
        if (!email || email.length > 320 || !email.includes("@")) continue;
        clean.push({
          email,
          name: String(raw?.name || "").slice(0, 120),
          count: Math.max(1, Math.min(9999, Number(raw?.count) || 1)),
          status: prevStatus[email]?.status || "",
          statusAt: prevStatus[email]?.statusAt || 0
        });
      }
      await chrome.storage.local.set({
        [STORAGE_KEYS.SUBSCRIPTIONS]: { updatedAt: Date.now(), senders: clean }
      });
    } catch (e) {
      console.error("[GCC SW] recordSubscriptionScan failed:", e);
    }
  }

  async function recordUnsubscribeResults(results) {
    if (!Array.isArray(results) || results.length === 0) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SUBSCRIPTIONS);
      const scan = result?.[STORAGE_KEYS.SUBSCRIPTIONS] || { updatedAt: 0, senders: [] };
      const byEmail = Object.create(null);
      for (const entry of scan.senders || []) {
        if (entry?.email) byEmail[entry.email] = entry;
      }
      let unsubscribedNow = 0;
      for (const r of results) {
        const email = String(r?.sender || "").trim().toLowerCase();
        const status = String(r?.status || "").slice(0, 30);
        if (!email || !status) continue;
        if (status === "unsubscribed") unsubscribedNow += 1;
        if (byEmail[email]) {
          byEmail[email].status = status;
          byEmail[email].statusAt = Date.now();
        } else {
          scan.senders = Array.isArray(scan.senders) ? scan.senders : [];
          scan.senders.push({ email, name: "", count: 1, status, statusAt: Date.now() });
        }
      }
      await chrome.storage.local.set({ [STORAGE_KEYS.SUBSCRIPTIONS]: scan });

      // Lifetime counter rides on the stats object the dashboard reads.
      if (unsubscribedNow > 0) {
        const statsResult = await chrome.storage.local.get(STORAGE_KEYS.STATS);
        const stats = statsResult?.[STORAGE_KEYS.STATS] || {};
        stats.totalUnsubscribed = (Number(stats.totalUnsubscribed) || 0) + unsubscribedNow;
        await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
      }
    } catch (e) {
      console.error("[GCC SW] recordUnsubscribeResults failed:", e);
    }
  }

  // =========================
  // Storage X-ray store (7.2)
  // =========================
  // One local-storage object: { updatedAt, totalMb, totalCount,
  // senders: [{ email, name, count, estMb, status, statusAt }] }. A
  // fresh scan replaces the list but keeps each sender's purge status,
  // mirroring the subscriptions store. Purge marking is indirect: the
  // popup registers { runId, senders } when it starts a purge run, and
  // the engine's gmailCleanerDone (which carries runId, dryRun and the
  // affected count) resolves it, because the popup closes long before
  // the run finishes.

  async function recordStorageScan(senders, totalMb, totalCount) {
    if (!Array.isArray(senders)) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STORAGE_XRAY);
      const prev = result?.[STORAGE_KEYS.STORAGE_XRAY] || {};
      const prevStatus = Object.create(null);
      for (const entry of prev.senders || []) {
        if (entry?.email && entry.status) {
          prevStatus[entry.email] = { status: entry.status, statusAt: entry.statusAt || 0 };
        }
      }
      const clean = [];
      for (const raw of senders.slice(0, 100)) {
        const email = String(raw?.email || "").trim().toLowerCase();
        if (!email || email.length > 320 || !email.includes("@")) continue;
        clean.push({
          email,
          name: String(raw?.name || "").slice(0, 120),
          count: Math.max(1, Math.min(99999, Number(raw?.count) || 1)),
          estMb: Math.max(0, Math.min(1024 * 1024, Math.round(Number(raw?.estMb) || 0))),
          status: prevStatus[email]?.status || "",
          statusAt: prevStatus[email]?.statusAt || 0
        });
      }
      await chrome.storage.local.set({
        [STORAGE_KEYS.STORAGE_XRAY]: {
          updatedAt: Date.now(),
          totalMb: Math.max(0, Math.round(Number(totalMb) || 0)),
          totalCount: Math.max(0, Math.round(Number(totalCount) || 0)),
          senders: clean
        }
      });
    } catch (e) {
      console.error("[GCC SW] recordStorageScan failed:", e);
    }
  }

  async function recordPendingStoragePurge(runId, senders) {
    const id = String(runId || "");
    const list = Array.isArray(senders)
      ? senders.filter((s) => typeof s === "string").slice(0, 25)
      : [];
    if (!id || list.length === 0) return;
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.XRAY_PENDING]: { runId: id, senders: list, startedAt: Date.now() }
      });
    } catch (e) {
      console.error("[GCC SW] recordPendingStoragePurge failed:", e);
    }
  }

  async function resolvePendingStoragePurge(summary) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.XRAY_PENDING);
      const pending = result?.[STORAGE_KEYS.XRAY_PENDING];
      if (!pending?.runId) return;

      // Stale guard: a pending marker beyond the popup's 2h run TTL is
      // dead weight from an interrupted run.
      const stale = Date.now() - (Number(pending.startedAt) || 0) > 1000 * 60 * 60 * 2;
      if (String(summary?.runId || "") !== pending.runId) {
        if (stale) await chrome.storage.local.set({ [STORAGE_KEYS.XRAY_PENDING]: null });
        return;
      }

      // This run was the purge: consume the marker either way, but only
      // mark senders when mail was actually affected for real.
      await chrome.storage.local.set({ [STORAGE_KEYS.XRAY_PENDING]: null });
      if (summary?.dryRun || !(Number(summary?.count) > 0)) return;

      const scanResult = await chrome.storage.local.get(STORAGE_KEYS.STORAGE_XRAY);
      const scan = scanResult?.[STORAGE_KEYS.STORAGE_XRAY];
      if (!scan?.senders) return;
      const targeted = new Set(pending.senders);
      let touched = 0;
      for (const entry of scan.senders) {
        if (entry?.email && targeted.has(entry.email)) {
          entry.status = "purged";
          entry.statusAt = Date.now();
          touched++;
        }
      }
      if (touched > 0) {
        await chrome.storage.local.set({ [STORAGE_KEYS.STORAGE_XRAY]: scan });
      }
    } catch (e) {
      console.error("[GCC SW] resolvePendingStoragePurge failed:", e);
    }
  }

  // =========================
  // Smart Suggestions store (7.8)
  // =========================
  // Two local-storage objects. smartScan { updatedAt, senders: [{
  // email, name, score, signals, estCount }] } is UNION-merged across
  // rescans: each scan only measures a handful of senders, so senders
  // from earlier scans keep their place and a re-measured sender takes
  // its fresh values. smartFeedback { bySender: { email: { action,
  // at } } } drives the popup's ranking (dismissed = silenced 90 days,
  // applied = same-domain boost); the map is bounded and the oldest
  // entries fall off first. Bounding mirrors GCC.smart.recordFeedback,
  // duplicated here because the worker is self-contained.

  const SMART_EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  const SMART_MAX_LIST = 50;
  const SMART_MAX_FEEDBACK = 300;

  function sanitizeSmartSignals(raw) {
    const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
    const signals = {
      count: Math.max(0, Math.min(999999, Number(raw?.count) || 0)),
      unreadRatio: clamp01(raw?.unreadRatio),
      oldShare: clamp01(raw?.oldShare),
      shape: Boolean(raw?.shape)
    };
    const estMb = Math.max(0, Math.min(1024 * 1024, Math.round(Number(raw?.estMb) || 0)));
    if (estMb > 0) signals.estMb = estMb;
    return signals;
  }

  async function recordSmartScan(senders) {
    if (!Array.isArray(senders)) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SMART_SCAN);
      const prev = result?.[STORAGE_KEYS.SMART_SCAN] || {};
      const byEmail = Object.create(null);
      for (const entry of prev.senders || []) {
        if (entry?.email) byEmail[entry.email] = entry;
      }
      for (const raw of senders.slice(0, SMART_MAX_LIST)) {
        const email = String(raw?.email || "").trim().toLowerCase();
        if (!email || email.length > 320 || !SMART_EMAIL_RE.test(email)) continue;
        byEmail[email] = {
          email,
          name: String(raw?.name || "").slice(0, 120),
          score: Math.max(0, Math.min(100, Math.round(Number(raw?.score) || 0))),
          signals: sanitizeSmartSignals(raw?.signals),
          estCount: Math.max(0, Math.min(999999, Number(raw?.estCount) || 0))
        };
      }
      const merged = Object.values(byEmail)
        .sort((a, b) => b.score - a.score || b.estCount - a.estCount)
        .slice(0, SMART_MAX_LIST);
      await chrome.storage.local.set({
        [STORAGE_KEYS.SMART_SCAN]: { updatedAt: Date.now(), senders: merged }
      });
    } catch (e) {
      console.error("[GCC SW] recordSmartScan failed:", e);
    }
  }

  async function recordSmartFeedback(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SMART_FEEDBACK);
      const bySender = { ...(result?.[STORAGE_KEYS.SMART_FEEDBACK]?.bySender || {}) };
      for (const raw of entries) {
        const email = String(raw?.email || "").trim().toLowerCase();
        const action = raw?.action === "applied" ? "applied"
          : raw?.action === "dismissed" ? "dismissed" : "";
        if (!action || !email || email.length > 320 || !SMART_EMAIL_RE.test(email)) continue;
        bySender[email] = { action, at: Date.now() };
      }
      let list = Object.entries(bySender);
      if (list.length > SMART_MAX_FEEDBACK) {
        list.sort((a, b) => (Number(a[1]?.at) || 0) - (Number(b[1]?.at) || 0));
        list = list.slice(list.length - SMART_MAX_FEEDBACK);
      }
      await chrome.storage.local.set({
        [STORAGE_KEYS.SMART_FEEDBACK]: { bySender: Object.fromEntries(list) }
      });
    } catch (e) {
      console.error("[GCC SW] recordSmartFeedback failed:", e);
    }
  }

  async function recordPendingSmartApply(runId, senders) {
    const id = String(runId || "");
    const list = Array.isArray(senders)
      ? senders.filter((s) => typeof s === "string").slice(0, 25)
      : [];
    if (!id || list.length === 0) return;
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.SMART_PENDING]: { runId: id, senders: list, startedAt: Date.now() }
      });
    } catch (e) {
      console.error("[GCC SW] recordPendingSmartApply failed:", e);
    }
  }

  async function resolvePendingSmartApply(summary) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SMART_PENDING);
      const pending = result?.[STORAGE_KEYS.SMART_PENDING];
      if (!pending?.runId) return;

      // Stale guard, same TTL as the purge marker.
      const stale = Date.now() - (Number(pending.startedAt) || 0) > 1000 * 60 * 60 * 2;
      if (String(summary?.runId || "") !== pending.runId) {
        if (stale) await chrome.storage.local.set({ [STORAGE_KEYS.SMART_PENDING]: null });
        return;
      }

      // This run was the apply: consume the marker either way, but only
      // record feedback when mail was actually affected for real.
      await chrome.storage.local.set({ [STORAGE_KEYS.SMART_PENDING]: null });
      if (summary?.dryRun || !(Number(summary?.count) > 0)) return;

      await recordSmartFeedback(pending.senders.map((email) => ({ email, action: "applied" })));
    } catch (e) {
      console.error("[GCC SW] resolvePendingSmartApply failed:", e);
    }
  }

  // =========================
  // Pro license check (7.12)
  // =========================
  // Auto-Pilot runs unattended, so the worker verifies the stored key
  // itself before every run instead of trusting a flag the popup set.
  // The parse + ECDSA P-256 verify duplicate GCC.license (the worker is
  // self-contained and cannot load shared.js); the autopilot test suite
  // pins the public JWK and the verify behavior against the shared
  // implementation. The keypair and key format are frozen: this block
  // only READS keys, exactly like the popup gates do.

  const LICENSE_PUBLIC_JWK = Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: "H__q7WFppVTV82Txv9zzk-D_uiTwt5qDda_wYvUlq_8",
    y: "3o5uhLw4utuNyDMaGJrIY3Dgbw14PVPWlsMg68lpFhY"
  });

  const LICENSE_STORAGE_KEY = "proLicense";

  // Test seam only: the autopilot suite verifies against an ephemeral
  // keypair. Never set outside tests; production always verifies
  // against LICENSE_PUBLIC_JWK.
  let _testLicenseJwk = null;

  function b64urlToBytes(input) {
    const b64 = String(input).replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function verifyProLicenseKey(rawKey) {
    const key = String(rawKey || "").trim();
    const parts = key.split(".");
    if (parts.length !== 3 || parts[0] !== "GCC1") return false;
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    } catch {
      return false;
    }
    if (!payload || payload.v !== 1 || payload.plan !== "pro") return false;
    try {
      const pubKey = await crypto.subtle.importKey(
        "jwk",
        _testLicenseJwk || LICENSE_PUBLIC_JWK,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pubKey,
        b64urlToBytes(parts[2]),
        new TextEncoder().encode(parts[1])
      );
    } catch {
      return false;
    }
  }

  async function hasProLicense() {
    try {
      const r = await chrome.storage.sync.get(LICENSE_STORAGE_KEY);
      const key = r?.[LICENSE_STORAGE_KEY];
      if (!key) return false;
      return await verifyProLicenseKey(key);
    } catch {
      return false;
    }
  }

  // =========================
  // Auto-Pilot (7.12, Pro)
  // =========================
  // A weekly scheduled Smart Suggestions sweep: read-only smartScan,
  // then one archive-only cleanup over the top recommendations. It
  // composes machinery that already exists (the alarm anchoring above,
  // the smartScan run kind, the rulesOverride cleanup path and the
  // smartPendingApply marker); nothing here touches new Gmail DOM.
  //
  // Storage:
  //   sync  autoPilot        { enabled, confirmed, lastRunAt }
  //   local autoPilotState   { pending, preview, lastRun }
  //     pending: { stage: "scan"|"apply", runId, dryRun, observedCount,
  //                startedAt } while a sweep is in flight
  //     preview: { count, at } the first sweep's dry-run tally, kept
  //              until the user confirms live mode
  //     lastRun: { at, count, dryRun } the compact popup summary
  //
  // Preview-first: until autoPilot.confirmed is true every sweep runs
  // as a dry run. The popup shows "would have archived N" with a
  // one-time confirm; only after that do sweeps go live. Guardrails on
  // live sweeps: archive only (never delete), at most
  // AUTOPILOT_MAX_PER_RUN senders, tag-before-action stays on, and the
  // engine's whitelist / protected-keyword / starred / important
  // guards all apply unchanged.

  const AUTOPILOT_INTERVAL_MINUTES = 10080; // weekly
  const AUTOPILOT_MAX_PER_RUN = 25; // mirrors GCC.smart.LIMITS.MAX_BULK_PER_RUN
  const AUTOPILOT_DISMISS_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  const AUTOPILOT_DOMAIN_BOOST = 6;
  const AUTOPILOT_PENDING_TTL_MS = 1000 * 60 * 60 * 2; // same as run TTL

  async function getAutoPilotConfig() {
    try {
      const r = await chrome.storage.sync.get(STORAGE_KEYS.AUTOPILOT);
      const cfg = r?.[STORAGE_KEYS.AUTOPILOT];
      return {
        enabled: Boolean(cfg?.enabled),
        confirmed: Boolean(cfg?.confirmed),
        lastRunAt: Number(cfg?.lastRunAt) || 0
      };
    } catch {
      return { enabled: false, confirmed: false, lastRunAt: 0 };
    }
  }

  async function getAutoPilotState() {
    try {
      const r = await chrome.storage.local.get(STORAGE_KEYS.AUTOPILOT_STATE);
      const s = r?.[STORAGE_KEYS.AUTOPILOT_STATE];
      return s && typeof s === "object" ? s : {};
    } catch {
      return {};
    }
  }

  async function setAutoPilotState(patch) {
    const state = await getAutoPilotState();
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTOPILOT_STATE]: { ...state, ...patch }
    });
  }

  async function restoreAutoPilotAlarm() {
    try {
      const cfg = await getAutoPilotConfig();
      await chrome.alarms.clear(AUTOPILOT_ALARM);
      if (!cfg.enabled) return;
      // Same anchoring as the schedules above: next fire is last run
      // plus the interval, so browser restarts never defer the sweep;
      // a brand-new enable fires the preview about a minute out.
      const now = Date.now();
      const nextDue = cfg.lastRunAt
        ? cfg.lastRunAt + AUTOPILOT_INTERVAL_MINUTES * 60 * 1000
        : now + 60 * 1000;
      chrome.alarms.create(AUTOPILOT_ALARM, {
        when: nextDue > now ? nextDue : now + 60 * 1000,
        periodInMinutes: AUTOPILOT_INTERVAL_MINUTES
      });
    } catch (e) {
      console.error("[GCC SW] restoreAutoPilotAlarm failed:", e);
    }
  }

  // ---- recommendation selection ----
  // Engine-local copies of the GCC.smart policy pieces the sweep needs
  // (whitelist coverage, protected keywords, dismissal TTL, domain
  // boost, ranking, the bulk rule). Duplicated because the worker is
  // self-contained; the autopilot test suite pins each one against the
  // shared implementation so they cannot drift.

  function autoPilotWhitelistCovers(entry, email) {
    const e = String(entry || "").trim().toLowerCase();
    if (!e) return false;
    if (e.startsWith("*@")) return email.endsWith(e.slice(1));
    if (e.includes("@")) return email === e;
    return email.endsWith("@" + e) || email.endsWith("." + e);
  }

  function autoPilotSenderVetoed(sender, whitelist, protectKeywords) {
    const email = String(sender?.email || "").trim().toLowerCase();
    if (!SMART_EMAIL_RE.test(email)) return true;
    const sig = sender?.signals || {};
    if (sig.starred || sig.corresponded) return true;
    if ((whitelist || []).some((w) => autoPilotWhitelistCovers(w, email))) return true;
    const hay = (email + " " + String(sender?.name || "")).toLowerCase();
    return (protectKeywords || []).some((k) => {
      const key = String(k || "").trim().toLowerCase();
      return key && hay.includes(key);
    });
  }

  function autoPilotIsDismissed(feedback, email, now) {
    const fb = feedback?.bySender?.[String(email || "").trim().toLowerCase()];
    if (!fb || fb.action !== "dismissed") return false;
    return (now - (Number(fb.at) || 0)) < AUTOPILOT_DISMISS_TTL_MS;
  }

  function autoPilotDomainBoost(feedback, email) {
    const domain = String(email || "").toLowerCase().split("@")[1] || "";
    if (!domain) return 0;
    for (const [addr, fb] of Object.entries(feedback?.bySender || {})) {
      if (fb?.action === "applied" && (addr.split("@")[1] || "") === domain) {
        return AUTOPILOT_DOMAIN_BOOST;
      }
    }
    return 0;
  }

  function autoPilotPickSenders(senders, feedback, whitelist, protectKeywords, now = Date.now()) {
    if (!Array.isArray(senders)) return [];
    return senders
      .filter((s) => s && typeof s.email === "string")
      .filter((s) => !autoPilotSenderVetoed(s, whitelist, protectKeywords))
      .filter((s) => !autoPilotIsDismissed(feedback, s.email, now))
      .map((s) => ({
        email: s.email.trim().toLowerCase(),
        score: Math.min(100, Math.max(0, Number(s.score) || 0) + autoPilotDomainBoost(feedback, s.email)),
        estCount: Math.max(0, Math.min(999999, Number(s.estCount) || 0))
      }))
      .sort((a, b) => b.score - a.score || b.estCount - a.estCount)
      .slice(0, AUTOPILOT_MAX_PER_RUN)
      .map((s) => s.email);
  }

  function autoPilotBuildRule(emails) {
    if (!Array.isArray(emails)) return "";
    const clean = [];
    const seen = new Set();
    for (const raw of emails) {
      if (typeof raw !== "string") continue;
      const email = raw.trim().toLowerCase();
      if (!email || email.length > 320 || !SMART_EMAIL_RE.test(email) || seen.has(email)) continue;
      seen.add(email);
      clean.push(email);
      if (clean.length >= AUTOPILOT_MAX_PER_RUN) break;
    }
    if (!clean.length) return "";
    return `from:(${clean.join(" OR ")}) older_than:6m`;
  }

  // ---- run stages ----
  // MV3 restarts the worker between the alarm, the scan finishing and
  // the apply finishing, so every stage transition lives in storage
  // (autoPilotState.pending) and is driven by the messages the engine
  // already sends: smartScan progress "done" starts the apply, the
  // cleanup's gmailCleanerDone (which carries runId) closes it out.

  async function findGmailTabForAutoPilot() {
    const gmailTabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
    if (!gmailTabs.length) return null;
    const gmailTab = gmailTabs.find((t) => t.active) || gmailTabs[0];
    try {
      await chrome.tabs.get(gmailTab.id);
    } catch {
      return null;
    }
    return gmailTab;
  }

  async function runAutoPilot() {
    try {
      const cfg = await getAutoPilotConfig();
      if (!cfg.enabled) return;

      if (!(await hasProLicense())) {
        console.log("[GCC SW] Auto-Pilot: no valid Pro license, skipping sweep");
        return;
      }

      // Scheduled work honours snooze / vacation mode.
      if (await getSnoozeUntil()) {
        console.log("[GCC SW] Auto-Pilot: snooze active, skipping sweep");
        return;
      }

      // Never stomp a run in flight (manual or scheduled).
      if (await hasActiveRun()) {
        console.log("[GCC SW] Auto-Pilot: another run is active, skipping sweep");
        return;
      }

      const state = await getAutoPilotState();
      const pending = state.pending;
      if (pending && Date.now() - (Number(pending.startedAt) || 0) < AUTOPILOT_PENDING_TTL_MS) {
        console.log("[GCC SW] Auto-Pilot: previous sweep still pending, skipping");
        return;
      }

      const gmailTab = await findGmailTabForAutoPilot();
      if (!gmailTab) {
        console.log("[GCC SW] Auto-Pilot: no Gmail tab open, skipping sweep");
        return;
      }

      // Stage 1: the read-only smart scan. Known senders from earlier
      // scans ride along so discovery costs nothing extra for them.
      const [syncData, localData] = await Promise.all([
        chrome.storage.sync.get([STORAGE_KEYS.WHITELIST, STORAGE_KEYS.PROTECT_KEYWORDS]),
        chrome.storage.local.get([
          STORAGE_KEYS.SMART_SCAN,
          STORAGE_KEYS.SUBSCRIPTIONS,
          STORAGE_KEYS.STORAGE_XRAY
        ])
      ]);
      const whitelist = Array.isArray(syncData?.[STORAGE_KEYS.WHITELIST])
        ? syncData[STORAGE_KEYS.WHITELIST]
        : [];
      const protectKeywords = Array.isArray(syncData?.[STORAGE_KEYS.PROTECT_KEYWORDS])
        ? syncData[STORAGE_KEYS.PROTECT_KEYWORDS]
        : [];
      const known = new Map();
      for (const src of [
        localData?.[STORAGE_KEYS.SMART_SCAN]?.senders,
        localData?.[STORAGE_KEYS.SUBSCRIPTIONS]?.senders,
        localData?.[STORAGE_KEYS.STORAGE_XRAY]?.senders
      ]) {
        for (const s of src || []) {
          if (!s?.email || known.has(s.email)) continue;
          known.set(s.email, {
            email: s.email,
            name: s.name || "",
            count: Number(s.estCount ?? s.count) || 1,
            estMb: Number(s.signals?.estMb ?? s.estMb) || 0
          });
          if (known.size >= 100) break;
        }
      }

      await setAutoPilotState({
        pending: { stage: "scan", startedAt: Date.now() }
      });

      const scanConfig = {
        runKind: "smartScan",
        whitelist,
        protectKeywords,
        smartKnownSenders: [...known.values()],
        debugMode: false,
        version: SW_VERSION
      };

      await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        func: (cfg2) => { window.GMAIL_CLEANER_CONFIG = cfg2; },
        args: [scanConfig]
      });
      await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        files: ["contentScript.js"]
      });

      console.log("[GCC SW] Auto-Pilot: scan stage started");
    } catch (e) {
      console.error("[GCC SW] runAutoPilot failed:", e);
      await setAutoPilotState({ pending: null }).catch(() => {});
    }
  }

  // Stage 2: the scan finished; pick the top recommendations and run
  // one archive-only cleanup over them.
  async function startAutoPilotApply() {
    let claimedRunId = "";
    try {
      const cfg = await getAutoPilotConfig();
      if (!cfg.enabled || !(await hasProLicense())) {
        await setAutoPilotState({ pending: null });
        return;
      }

      const [syncData, localData] = await Promise.all([
        chrome.storage.sync.get([STORAGE_KEYS.WHITELIST, STORAGE_KEYS.PROTECT_KEYWORDS]),
        chrome.storage.local.get([STORAGE_KEYS.SMART_SCAN, STORAGE_KEYS.SMART_FEEDBACK])
      ]);
      const whitelist = Array.isArray(syncData?.[STORAGE_KEYS.WHITELIST])
        ? syncData[STORAGE_KEYS.WHITELIST]
        : [];
      const protectKeywords = Array.isArray(syncData?.[STORAGE_KEYS.PROTECT_KEYWORDS])
        ? syncData[STORAGE_KEYS.PROTECT_KEYWORDS]
        : [];
      const senders = autoPilotPickSenders(
        localData?.[STORAGE_KEYS.SMART_SCAN]?.senders,
        localData?.[STORAGE_KEYS.SMART_FEEDBACK],
        whitelist,
        protectKeywords
      );
      const rule = autoPilotBuildRule(senders);

      if (!rule) {
        // Nothing safe to sweep: record the visit so the popup can say
        // so, and anchor the next weekly fire.
        const now = Date.now();
        await setAutoPilotState({
          pending: null,
          lastRun: { at: now, count: 0, dryRun: !cfg.confirmed }
        });
        await safeSyncSet(
          { [STORAGE_KEYS.AUTOPILOT]: { ...cfg, lastRunAt: now } },
          "autoPilot"
        );
        console.log("[GCC SW] Auto-Pilot: no eligible suggestions, nothing to sweep");
        return;
      }

      const gmailTab = await findGmailTabForAutoPilot();
      if (!gmailTab || (await hasActiveRun())) {
        await setAutoPilotState({ pending: null });
        return;
      }

      const dryRun = !cfg.confirmed;
      const runId = `autopilot_${Date.now()}`;

      // Claim the run marker so a popup opened mid-sweep refuses to
      // start a second run, exactly like scheduled cleanups do.
      const claim = { gmailTabId: gmailTab.id, runId, startedAt: Date.now(), source: "autopilot" };
      try {
        await chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: claim });
      } catch {}
      await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: claim });
      claimedRunId = runId;

      // Live sweeps register the pending-apply marker so confirmed
      // applies feed the same feedback loop popup applies do.
      if (!dryRun) {
        await recordPendingSmartApply(runId, senders);
      }

      await setAutoPilotState({
        pending: { stage: "apply", runId, dryRun, senderCount: senders.length, startedAt: Date.now() }
      });

      const config = {
        // Archive only in v1: never delete, whatever the per-sender
        // recommendation would have led with.
        archiveInsteadOfDelete: true,
        rulesOverride: [rule],
        // The rule carries its own older_than:6m; a global minimum age
        // would stack a second, stricter filter on top.
        minAge: null,
        intensity: "light",
        dryRun,
        safeMode: true,
        tagBeforeDelete: true,
        tagLabelPrefix: "GmailCleaner",
        guardSkipStarred: true,
        guardSkipImportant: true,
        guardSkipUnread: true,
        guardSkipUserLabels: true,
        reviewMode: false,
        debugMode: false,
        whitelist,
        protectKeywords,
        version: SW_VERSION,
        scheduled: true,
        runId
      };

      await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        func: (cfg2) => { window.GMAIL_CLEANER_CONFIG = cfg2; },
        args: [config]
      });
      await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        files: ["contentScript.js"]
      });

      console.log(`[GCC SW] Auto-Pilot: ${dryRun ? "preview (dry run)" : "live"} apply started over ${senders.length} sender(s)`);
    } catch (e) {
      console.error("[GCC SW] startAutoPilotApply failed:", e);
      await setAutoPilotState({ pending: null }).catch(() => {});
      // Injection never happened, so no gmailCleanerDone will arrive
      // to release the claim; a stale claim would block manual runs
      // for the whole 2h TTL. Release it only if it is still ours.
      if (claimedRunId) {
        try {
          const r = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_RUN);
          if (r?.[STORAGE_KEYS.ACTIVE_RUN]?.runId === claimedRunId) {
            await chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: null });
            await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null });
          }
        } catch {}
      }
    }
  }

  // Progress messages drive the stage machine. The scan's "done"
  // launches the apply; the apply's "done" stats carry the would-have
  // count a dry run reports (the gmailCleanerDone summary books dry
  // runs as zero, so the count is captured here).
  async function handleAutoPilotProgress(msg) {
    try {
      const state = await getAutoPilotState();
      const pending = state.pending;
      if (!pending) return;

      if (Date.now() - (Number(pending.startedAt) || 0) > AUTOPILOT_PENDING_TTL_MS) {
        await setAutoPilotState({ pending: null });
        return;
      }

      const terminal = msg.done || msg.phase === "done" || msg.phase === "cancelled" || msg.phase === "error";
      if (!terminal) return;

      if (pending.stage === "scan" && msg.runKind === "smartScan") {
        if (msg.phase === "done") {
          // Serialize behind the store writes the scan just queued so
          // the apply reads the union-merged sender list.
          withStorageLock(() => startAutoPilotApply())
            .catch((e) => console.warn("[GCC SW] autopilot apply stage failed:", e?.message || e));
        } else {
          await setAutoPilotState({ pending: null });
        }
        return;
      }

      if (pending.stage === "apply" && !msg.runKind) {
        if (msg.phase === "done" && msg.stats) {
          const modeMatches = (msg.stats.mode === "dry") === Boolean(pending.dryRun);
          if (modeMatches) {
            await setAutoPilotState({
              pending: { ...pending, observedCount: Math.max(0, Number(msg.stats.runCount) || 0) }
            });
          }
        } else if (msg.phase === "error" || msg.phase === "cancelled") {
          await setAutoPilotState({ pending: null });
        }
      }
    } catch (e) {
      console.warn("[GCC SW] handleAutoPilotProgress failed:", e?.message || e);
    }
  }

  // gmailCleanerDone carries the runId, so it is the authoritative
  // close-out for the apply stage.
  async function resolveAutoPilotDone(summary) {
    try {
      const state = await getAutoPilotState();
      const pending = state.pending;
      if (!pending || pending.stage !== "apply") return;
      if (String(summary?.runId || "") !== String(pending.runId || "")) return;

      const cfg = await getAutoPilotConfig();
      const now = Date.now();
      const count = Number.isFinite(Number(pending.observedCount))
        ? Number(pending.observedCount)
        : Math.max(0, Number(summary?.count) || 0);
      const patch = {
        pending: null,
        lastRun: { at: now, count, dryRun: Boolean(pending.dryRun) }
      };
      if (pending.dryRun) {
        // The anti-1-star mechanism: the first sweep's would-have tally
        // waits in the popup for an explicit "turn on for real".
        patch.preview = { count, at: now };
      } else {
        patch.preview = null;
      }
      await setAutoPilotState(patch);
      await safeSyncSet(
        { [STORAGE_KEYS.AUTOPILOT]: { ...cfg, lastRunAt: now } },
        "autoPilot"
      );
      console.log(`[GCC SW] Auto-Pilot: sweep finished (${pending.dryRun ? "preview" : "live"}, ${count} affected)`);
    } catch (e) {
      console.error("[GCC SW] resolveAutoPilotDone failed:", e);
    }
  }

  // ---- popup-facing settings ----

  async function getAutoPilotForPopup() {
    const [cfg, state] = await Promise.all([getAutoPilotConfig(), getAutoPilotState()]);
    return {
      enabled: cfg.enabled,
      confirmed: cfg.confirmed,
      lastRun: state.lastRun || null,
      preview: state.preview || null,
      pendingStage: state.pending?.stage || null
    };
  }

  async function setAutoPilotEnabled(enabled) {
    const cfg = await getAutoPilotConfig();
    if (enabled && !(await hasProLicense())) {
      return { ok: false, error: "pro_required" };
    }
    const next = { ...cfg, enabled: Boolean(enabled) };
    await safeSyncSet({ [STORAGE_KEYS.AUTOPILOT]: next }, "autoPilot");
    if (!enabled) {
      await setAutoPilotState({ pending: null });
    }
    await restoreAutoPilotAlarm();
    return { ok: true, autoPilot: await getAutoPilotForPopup() };
  }

  async function confirmAutoPilot() {
    const cfg = await getAutoPilotConfig();
    if (!(await hasProLicense())) {
      return { ok: false, error: "pro_required" };
    }
    await safeSyncSet(
      { [STORAGE_KEYS.AUTOPILOT]: { ...cfg, confirmed: true } },
      "autoPilot"
    );
    await setAutoPilotState({ preview: null });
    return { ok: true, autoPilot: await getAutoPilotForPopup() };
  }

  // =========================
  // Completion notification
  // =========================

  async function maybeNotifyDone(summary) {
    try {
      const pref = await chrome.storage.local.get(STORAGE_KEYS.NOTIFY_ENABLED);
      if (!pref?.[STORAGE_KEYS.NOTIFY_ENABLED]) return;
      if (!chrome.notifications?.create) return;
      const count = Number(summary?.count || 0);
      const action = summary?.action === "archive" ? "archived" : "moved to Trash";
      const title = `Gmail Cleaner - ${count} ${count === 1 ? "email" : "emails"} ${action}`;
      const msg = summary?.dryRun
        ? "Dry run finished. No mail was touched."
        : `Estimated ~${summary?.freedMb || 0} MB freed. Open Stats for details.`;
      // Keep to the four properties every browser accepts: Firefox
      // rejects notification options it does not implement (priority,
      // buttons, requireInteraction) with a type error.
      await new Promise((resolve) => {
        chrome.notifications.create("", {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title,
          message: msg
        }, () => resolve());
      });
    } catch (e) {
      console.warn("[GCC SW] maybeNotifyDone error:", e?.message || e);
    }
  }

  // =========================
  // Stats Persistence
  // =========================

  async function recordStats(data) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STATS);
      // recordSenderHits can persist a stats object holding only
      // topSenders before the first full run finishes, so a loaded
      // object may be missing the fields below. Backfill each one rather
      // than trusting the stored shape, or categoryBreakdown[cat] throws
      // on a partial object.
      const stats = result?.[STORAGE_KEYS.STATS] || {};
      stats.totalRuns = stats.totalRuns || 0;
      stats.totalDeleted = stats.totalDeleted || 0;
      stats.totalArchived = stats.totalArchived || 0;
      stats.totalFreedMb = stats.totalFreedMb || 0;
      stats.history = Array.isArray(stats.history) ? stats.history : [];
      stats.categoryBreakdown = stats.categoryBreakdown || {};
      stats.dailyStats = stats.dailyStats || {};

      stats.totalRuns++;
      stats.totalDeleted += data.deleted || 0;
      stats.totalArchived += data.archived || 0;
      stats.totalFreedMb += data.freedMb || 0;

      // Category breakdown
      if (data.perQuery) {
        for (const q of data.perQuery) {
          const cat = q.label || "Other";
          if (!stats.categoryBreakdown[cat]) {
            stats.categoryBreakdown[cat] = { count: 0, runs: 0 };
          }
          stats.categoryBreakdown[cat].count += q.count || 0;
          stats.categoryBreakdown[cat].runs++;
        }
      }

      // Daily stats
      const today = new Date().toISOString().slice(0, 10);
      if (!stats.dailyStats[today]) {
        stats.dailyStats[today] = { deleted: 0, archived: 0, freedMb: 0, runs: 0 };
      }
      stats.dailyStats[today].deleted += data.deleted || 0;
      stats.dailyStats[today].archived += data.archived || 0;
      stats.dailyStats[today].freedMb += data.freedMb || 0;
      stats.dailyStats[today].runs++;

      // Run history (keep last 50)
      stats.history.unshift({
        timestamp: Date.now(),
        deleted: data.deleted || 0,
        archived: data.archived || 0,
        freedMb: data.freedMb || 0,
        intensity: data.intensity || "normal",
        dryRun: data.dryRun || false,
        duration: data.duration || 0,
        perQuery: data.perQuery || []
      });
      if (stats.history.length > 50) stats.history.length = 50;

      await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
    } catch (e) {
      console.error("[GCC SW] recordStats failed:", e);
    }
  }

  async function getStats() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STATS);
      return result?.[STORAGE_KEYS.STATS] || {
        totalRuns: 0,
        totalDeleted: 0,
        totalArchived: 0,
        totalFreedMb: 0,
        history: [],
        categoryBreakdown: {},
        dailyStats: {}
      };
    } catch (e) {
      console.error("[GCC SW] getStats failed:", e);
      return null;
    }
  }

  async function pruneOldStats() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STATS);
      const stats = result?.[STORAGE_KEYS.STATS];
      if (!stats?.dailyStats) return;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      for (const date of Object.keys(stats.dailyStats)) {
        if (date < cutoffStr) delete stats.dailyStats[date];
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
    } catch (e) {
      console.error("[GCC SW] pruneOldStats failed:", e);
    }
  }

  // =========================
  // Undo / Backup System
  // =========================

  async function recordUndoEntry(data) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.UNDO_LOG);
      const log = result?.[STORAGE_KEYS.UNDO_LOG] || [];

      // Issue #9: also record the sample of message IDs sniffed from the
      // Gmail list before deletion. We cap to 50 per entry so the log
      // can still hold the last 20 runs without ballooning local
      // storage. Real recovery uses the label, but the IDs let advanced
      // users locate specific threads in Trash.
      const sampledIds = Array.isArray(data.sampledMessageIds)
        ? data.sampledMessageIds.slice(0, 50)
        : [];

      log.unshift({
        id: `undo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        query: data.query || "",
        label: data.label || "",
        count: data.count || 0,
        action: data.action || "delete",
        tagLabel: data.tagLabel || "",
        intensity: data.intensity || "normal",
        // 5.0 additions for issue #9 partial fix:
        sampledMessageIds: sampledIds,
        sampledSenderCount: Number(data.sampledSenderCount || 0),
        taggingFailed: Boolean(data.taggingFailed)
      });

      // Keep last 20 runs
      if (log.length > 20) log.length = 20;

      await chrome.storage.local.set({ [STORAGE_KEYS.UNDO_LOG]: log });
    } catch (e) {
      console.error("[GCC SW] recordUndoEntry failed:", e);
    }
  }

  // 7.6: a restore run that finished clean (its label search came back
  // empty) stamps restoredAt on every entry it covered. Restoring by
  // label moves back ALL trash/archive mail carrying that label, so
  // every same-label same-mode entry recorded before the restore
  // started is covered by it; entries recorded afterwards belong to a
  // newer run and stay restorable. Additive field only: nothing else
  // about the entry shape changes.
  async function recordRestoreOutcome(data) {
    const tagLabel = String(data?.tagLabel || "").trim();
    const action = data?.action === "archive" ? "archive" : "delete";
    const count = Math.max(0, Math.round(Number(data?.count) || 0));
    const startedAt = Number(data?.startedAt) || Date.now();
    if (!tagLabel || count <= 0) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.UNDO_LOG);
      const log = result?.[STORAGE_KEYS.UNDO_LOG] || [];
      let touched = 0;
      for (const entry of log) {
        if (!entry || entry.restoredAt) continue;
        if (entry.tagLabel !== tagLabel) continue;
        if ((entry.action || "delete") !== action) continue;
        if ((Number(entry.timestamp) || 0) > startedAt) continue;
        entry.restoredAt = Date.now();
        touched++;
      }
      if (touched > 0) {
        await chrome.storage.local.set({ [STORAGE_KEYS.UNDO_LOG]: log });
      }
    } catch (e) {
      console.error("[GCC SW] recordRestoreOutcome failed:", e);
    }
  }

  async function getUndoLog() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.UNDO_LOG);
      return result?.[STORAGE_KEYS.UNDO_LOG] || [];
    } catch (e) {
      console.error("[GCC SW] getUndoLog failed:", e);
      return [];
    }
  }

  async function clearUndoLog() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.UNDO_LOG]: [] });
    } catch (e) {
      console.error("[GCC SW] clearUndoLog failed:", e);
    }
  }

  // =========================
  // Schedule Management
  // =========================

  async function getSchedules() {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
      return result?.[STORAGE_KEYS.SCHEDULES] || [];
    } catch (e) {
      console.error("[GCC SW] getSchedules failed:", e);
      return [];
    }
  }

  async function saveSchedule(schedule) {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
      const schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];

      const idx = schedules.findIndex(s => s.id === schedule.id);
      if (idx >= 0) {
        schedules[idx] = schedule;
      } else {
        schedules.push(schedule);
      }

      // Issue #10: validate quota before writing so users get a clear
      // error rather than silent truncation.
      try {
        await safeSyncSet({ [STORAGE_KEYS.SCHEDULES]: schedules }, "schedules");
      } catch (e) {
        // Surface the failure to whoever called us via the throw chain.
        throw e;
      }
    } catch (e) {
      console.error("[GCC SW] saveSchedule failed:", e);
      throw e;
    }
  }

  async function deleteSchedule(scheduleId) {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
      let schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];
      schedules = schedules.filter(s => s.id !== scheduleId);
      await chrome.storage.sync.set({ [STORAGE_KEYS.SCHEDULES]: schedules });

      // Clear alarm
      await chrome.alarms.clear(ALARM_PREFIX + scheduleId);
    } catch (e) {
      console.error("[GCC SW] deleteSchedule failed:", e);
    }
  }

  // =========================
  // Whitelist Suggestions
  // =========================

  async function recordSenderInteraction(data) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.WHITELIST_SUGGESTIONS);
      const interactions = result?.[STORAGE_KEYS.WHITELIST_SUGGESTIONS] || {};

      const sender = data.sender;
      if (!sender) return;

      if (!interactions[sender]) {
        interactions[sender] = { opens: 0, replies: 0, lastSeen: 0 };
      }

      if (data.type === "open") interactions[sender].opens++;
      if (data.type === "reply") interactions[sender].replies++;
      interactions[sender].lastSeen = Date.now();

      await chrome.storage.local.set({ [STORAGE_KEYS.WHITELIST_SUGGESTIONS]: interactions });
    } catch (e) {
      console.error("[GCC SW] recordSenderInteraction failed:", e);
    }
  }

  async function getWhitelistSuggestions() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.WHITELIST_SUGGESTIONS);
      const interactions = result?.[STORAGE_KEYS.WHITELIST_SUGGESTIONS] || {};

      // Score senders by interaction frequency
      const scored = Object.entries(interactions)
        .map(([sender, data]) => ({
          sender,
          score: (data.opens || 0) * 1 + (data.replies || 0) * 3,
          opens: data.opens || 0,
          replies: data.replies || 0,
          lastSeen: data.lastSeen || 0
        }))
        .filter(s => s.score >= 3) // Minimum threshold
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

      return scored;
    } catch (e) {
      console.error("[GCC SW] getWhitelistSuggestions failed:", e);
      return [];
    }
  }

  // =========================
  // Multi-Account Support
  // =========================

  async function listGmailTabs() {
    try {
      const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
      return tabs.map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        account: extractAccountFromUrl(t.url)
      }));
    } catch (e) {
      console.error("[GCC SW] listGmailTabs failed:", e);
      return [];
    }
  }

  function extractAccountFromUrl(url) {
    try {
      const match = url.match(/\/mail\/u\/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch (e) {
      console.error("[GCC SW] extractAccountFromUrl failed:", e);
      return 0;
    }
  }

  // Test seam, mirroring the content script's GCC_TEST_MODE pattern:
  // the autopilot suite pins the worker's duplicated policy pieces
  // against GCC.smart / GCC.license. Production never sets the flag.
  if (typeof globalThis !== "undefined" && globalThis.GCC_SW_TEST_MODE) {
    globalThis.GCC_SW_INTERNALS = {
      LICENSE_PUBLIC_JWK,
      verifyProLicenseKey,
      hasProLicense,
      autoPilotWhitelistCovers,
      autoPilotSenderVetoed,
      autoPilotIsDismissed,
      autoPilotDomainBoost,
      autoPilotPickSenders,
      autoPilotBuildRule,
      runAutoPilot,
      restoreAutoPilotAlarm,
      setTestLicenseJwk: (jwk) => { _testLicenseJwk = jwk; }
    };
  }
})();
