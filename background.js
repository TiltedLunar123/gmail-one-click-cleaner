// background.js — Service Worker (Manifest V3)
// Handles: scheduled cleanups, messaging coordination, undo/backup, stats persistence

(() => {
  "use strict";

  const SW_VERSION = "4.0.0";

  // =========================
  // Storage Keys
  // =========================

  const STORAGE_KEYS = Object.freeze({
    SCHEDULES: "schedules",
    STATS: "cleanupStats",
    UNDO_LOG: "undoLog",
    ACTIVE_RUN: "activeRun",
    WHITELIST_SUGGESTIONS: "whitelistSuggestions"
  });

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

      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        const alarmName = ALARM_PREFIX + schedule.id;
        chrome.alarms.create(alarmName, {
          periodInMinutes: schedule.intervalMinutes || 10080 // default weekly
        });
      }

      console.log(`[GCC SW] Restored ${schedules.filter(s => s.enabled).length} scheduled alarms`);
    } catch (e) {
      console.error("[GCC SW] Failed to restore alarms", e);
    }
  }

  async function runScheduledCleanup(scheduleId) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 5000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
        const schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];
        const schedule = schedules.find(s => s.id === scheduleId);

        if (!schedule || !schedule.enabled) return;

        // Find a Gmail tab
        const gmailTabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
        if (!gmailTabs.length) {
          console.log("[GCC SW] No Gmail tab found for scheduled cleanup, skipping");
          return;
        }

        const gmailTab = gmailTabs[0];
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
          version: SW_VERSION,
          scheduled: true,
          scheduleId
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

        // Update last run timestamp
        schedule.lastRun = Date.now();
        await chrome.storage.sync.set({ [STORAGE_KEYS.SCHEDULES]: schedules });

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

    switch (msg.type) {
      // Forward progress messages to all extension pages
      case "gmailCleanerProgress":
        broadcastToExtensionPages(msg, sender.tab?.id);
        break;

      // Stats recording
      case "gmailCleanerRecordStats":
        recordStats(msg.data).then(() => sendResponse({ ok: true }));
        return true;

      // Undo log
      case "gmailCleanerRecordUndo":
        recordUndoEntry(msg.data).then(() => sendResponse({ ok: true }));
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
        saveSchedule(msg.schedule).then(() => {
          restoreScheduledAlarms();
          sendResponse({ ok: true });
        });
        return true;

      case "gmailCleanerDeleteSchedule":
        deleteSchedule(msg.scheduleId).then(() => {
          restoreScheduledAlarms();
          sendResponse({ ok: true });
        });
        return true;

      // Whitelist suggestions
      case "gmailCleanerGetWhitelistSuggestions":
        getWhitelistSuggestions().then(suggestions => sendResponse({ ok: true, suggestions }));
        return true;

      case "gmailCleanerRecordSenderInteraction":
        recordSenderInteraction(msg.data).then(() => sendResponse({ ok: true }));
        return true;

      // Ping
      case "gmailCleanerSwPing":
        sendResponse({ ok: true, version: SW_VERSION });
        break;

      // Multi-account: list Gmail tabs
      case "gmailCleanerListGmailTabs":
        listGmailTabs().then(tabs => sendResponse({ ok: true, tabs }));
        return true;

      case "gmailCleanerDone":
        // Clean up active run state when cleanup finishes
        chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: null }).catch(() => {});
        chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null }).catch(() => {});
        broadcastToExtensionPages(msg, sender.tab?.id);
        break;

      default:
        break;
    }
  });

  async function broadcastToExtensionPages(msg, excludeTabId) {
    try {
      // Get all extension tabs (progress page, stats page, etc.)
      const extensionUrl = chrome.runtime.getURL("");
      const tabs = await chrome.tabs.query({ url: extensionUrl + "*" });
      for (const tab of tabs) {
        if (tab.id && tab.id !== excludeTabId) {
          chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
        }
      }
    } catch {
      // Ignore errors when no extension tabs are open
    }
  }

  // =========================
  // Stats Persistence
  // =========================

  async function recordStats(data) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STATS);
      const stats = result?.[STORAGE_KEYS.STATS] || {
        totalRuns: 0,
        totalDeleted: 0,
        totalArchived: 0,
        totalFreedMb: 0,
        history: [],
        categoryBreakdown: {},
        dailyStats: {}
      };

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
    } catch {
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

      log.unshift({
        id: `undo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        query: data.query || "",
        label: data.label || "",
        count: data.count || 0,
        action: data.action || "delete",
        tagLabel: data.tagLabel || "",
        intensity: data.intensity || "normal"
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
    } catch {
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
    } catch {
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

      await chrome.storage.sync.set({ [STORAGE_KEYS.SCHEDULES]: schedules });
    } catch (e) {
      console.error("[GCC SW] saveSchedule failed:", e);
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
    } catch {
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
    } catch {
      return [];
    }
  }

  function extractAccountFromUrl(url) {
    try {
      const match = url.match(/\/mail\/u\/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }
})();
