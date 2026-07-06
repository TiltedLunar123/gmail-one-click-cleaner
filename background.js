// background.js: Service Worker (Manifest V3)
// Handles: scheduled cleanups, messaging coordination, undo/backup, stats persistence

(() => {
  "use strict";

  const SW_VERSION = "7.1.0";

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
    SUBSCRIPTIONS: "subscriptionScan"
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

  // =========================
  // Lifecycle
  // =========================

  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(`[GCC SW] Installed/Updated (${details.reason}), v${SW_VERSION}`);

    // Set up periodic stats cleanup alarm (once per day)
    chrome.alarms.create(STATS_CLEANUP_ALARM, { periodInMinutes: 1440 });

    // Restore saved schedules
    await restoreScheduledAlarms();
  });

  chrome.runtime.onStartup.addListener(async () => {
    console.log("[GCC SW] Browser startup");
    await restoreScheduledAlarms();
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
      case "gmailCleanerProgress":
        break;

      // Stats recording
      case "gmailCleanerRecordStats":
        withStorageLock(() => recordStats(msg.data)).then(() => sendResponse({ ok: true }));
        return true;

      // Undo log
      case "gmailCleanerRecordUndo":
        withStorageLock(() => recordUndoEntry(msg.data)).then(() => sendResponse({ ok: true }));
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

      case "gmailCleanerDone":
        // Clean up active run state when cleanup finishes
        chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: null })
          .catch(e => console.warn("[GCC SW] session clear on done failed:", e));
        chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null })
          .catch(e => console.warn("[GCC SW] local clear on done failed:", e));
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
})();
