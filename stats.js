// stats.js: Statistics Dashboard Logic
// Depends on shared.js (GCC namespace)

(() => {
"use strict";

// =========================
// DOM Refs
// =========================

const ui = {
  totalRuns: GCC.$("totalRuns"),
  totalDeleted: GCC.$("totalDeleted"),
  totalFreed: GCC.$("totalFreed"),
  totalArchived: GCC.$("totalArchived"),
  chartBars: GCC.$("chartBars"),
  chartLabels: GCC.$("chartLabels"),
  categoryList: GCC.$("categoryList"),
  historyBody: GCC.$("historyBody"),
  undoList: GCC.$("undoList"),
  refreshUndoBtn: GCC.$("refreshUndoBtn"),
  clearUndoBtn: GCC.$("clearUndoBtn"),
  restoreStatus: GCC.$("restoreStatus"),
  toastContainer: GCC.$("toastContainer"),
  topSendersList: GCC.$("topSendersList"),
  themeSwitcher: GCC.$("themeSwitcher")
};

// =========================
// Load Stats
// =========================

async function loadStats() {
  const resp = await GCC.sendMessage({ type: "gmailCleanerGetStats" });
  const stats = resp?.stats;

  if (!stats || resp?.error) {
    console.log("[Stats] No stats data available", resp?.error || "");
    return;
  }

  // Overview cards
  if (ui.totalRuns) ui.totalRuns.textContent = GCC.formatNumber(stats.totalRuns);
  if (ui.totalDeleted) ui.totalDeleted.textContent = GCC.formatNumber(stats.totalDeleted);
  if (ui.totalFreed) ui.totalFreed.textContent = GCC.formatMb(stats.totalFreedMb);
  if (ui.totalArchived) ui.totalArchived.textContent = GCC.formatNumber(stats.totalArchived);

  // Daily activity chart
  renderDailyChart(stats.dailyStats || {});

  // Category breakdown
  renderCategories(stats.categoryBreakdown || {});

  // Run history
  renderHistory(stats.history || []);

  // Top senders (new in 5.0)
  renderTopSenders(stats.topSenders || []);
}

// =========================
// Top Senders Intelligence
// =========================

function renderTopSenders(senders) {
  if (!ui.topSendersList) return;
  ui.topSendersList.textContent = "";

  if (!Array.isArray(senders) || senders.length === 0) {
    ui.topSendersList.appendChild(
      GCC.createEl("div", { className: "empty-state" }, [
        GCC.createEl("p", { textContent: "No sender data yet. Senders are recorded as cleanups run." })
      ])
    );
    return;
  }

  const max = Math.max(...senders.map((s) => s.count || 0), 1);
  const wrapper = GCC.createEl("div", { className: "top-senders-list" });

  for (const entry of senders.slice(0, 15)) {
    const pct = Math.round(((entry.count || 0) / max) * 100);
    const fill = GCC.createEl("div", { className: "category-bar-fill" });
    fill.style.width = pct + "%";

    const findUrl = "https://mail.google.com/mail/u/0/#search/from:" + encodeURIComponent(entry.sender || "");
    const findLink = GCC.createEl("a", {
      className: "btn btn-sm",
      href: findUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      textContent: "Search"
    });

    const whitelistBtn = GCC.createEl("button", {
      className: "btn btn-sm btn-success",
      type: "button",
      textContent: "Protect"
    });
    whitelistBtn.addEventListener("click", async () => {
      const resp = await GCC.sendMessage({ type: "gmailCleanerAddToWhitelist", sender: entry.sender });
      if (resp?.ok) {
        GCC.showToast("Added to whitelist", "success");
        whitelistBtn.disabled = true;
        whitelistBtn.textContent = "Protected";
      } else {
        GCC.showToast(resp?.error || "Could not add to whitelist", "error");
      }
    });

    const row = GCC.createEl("div", { className: "category-item" }, [
      GCC.createEl("span", { className: "category-name", textContent: entry.sender || "unknown" }),
      GCC.createEl("span", { className: "category-count", textContent: GCC.formatNumber(entry.count) }),
      GCC.createEl("div", { className: "category-bar-bg" }, [fill]),
      findLink,
      whitelistBtn
    ]);
    wrapper.appendChild(row);
  }
  ui.topSendersList.appendChild(wrapper);
}

// =========================
// Daily Chart
// =========================

function renderDailyChart(dailyStats) {
  if (!ui.chartBars || !ui.chartLabels) return;

  ui.chartBars.textContent = "";
  ui.chartLabels.textContent = "";

  // Get last 30 days
  const days = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const values = days.map(d => {
    const day = dailyStats[d];
    return day ? (day.deleted || 0) + (day.archived || 0) : 0;
  });

  const maxVal = Math.max(...values, 1);

  if (maxVal === 0 || values.every(v => v === 0)) {
    ui.chartBars.appendChild(
      GCC.createEl("div", { className: "no-data", textContent: "No activity in the last 30 days" })
    );
    return;
  }

  days.forEach((day, i) => {
    const pct = Math.max(2, (values[i] / maxVal) * 100);
    const tooltip = GCC.createEl("div", {
      className: "tooltip",
      textContent: day.slice(5) + ": " + GCC.formatNumber(values[i])
    });
    const bar = GCC.createEl("div", { className: "chart-bar" }, [tooltip]);
    bar.style.height = pct + "%";
    ui.chartBars.appendChild(bar);

    const label = GCC.createEl("span", {
      textContent: i % 5 === 0 ? day.slice(5) : ""
    });
    ui.chartLabels.appendChild(label);
  });
}

// =========================
// Category Breakdown
// =========================

function renderCategories(breakdown) {
  if (!ui.categoryList) return;

  const entries = Object.entries(breakdown).sort((a, b) => b[1].count - a[1].count);
  ui.categoryList.textContent = "";

  if (entries.length === 0) {
    ui.categoryList.appendChild(
      GCC.createEl("div", { className: "empty-state" }, [
        GCC.createEl("p", { textContent: "No category data yet. Run a cleanup to see breakdowns." })
      ])
    );
    return;
  }

  const maxCount = Math.max(...entries.map(e => e[1].count), 1);

  for (const [name, data] of entries) {
    const pct = Math.round((data.count / maxCount) * 100);
    const fill = GCC.createEl("div", { className: "category-bar-fill" });
    fill.style.width = pct + "%";

    const item = GCC.createEl("div", { className: "category-item" }, [
      GCC.createEl("span", { className: "category-name", textContent: name }),
      GCC.createEl("span", { className: "category-count", textContent: GCC.formatNumber(data.count) }),
      GCC.createEl("div", { className: "category-bar-bg" }, [fill])
    ]);
    ui.categoryList.appendChild(item);
  }
}

// =========================
// Run History
// =========================

function renderHistory(history) {
  if (!ui.historyBody) return;
  ui.historyBody.textContent = "";

  if (history.length === 0) {
    const td = GCC.createEl("td", { textContent: "No run history yet. Complete a cleanup to see results." });
    td.setAttribute("colspan", "6");
    td.className = "empty-state";
    ui.historyBody.appendChild(GCC.createEl("tr", {}, [td]));
    return;
  }

  for (const run of history.slice(0, 25)) {
    const count = (run.deleted || 0) + (run.archived || 0);

    let tagClass, tagText;
    if (run.dryRun) { tagClass = "tag tag-info"; tagText = "dry run"; }
    else if (run.archived) { tagClass = "tag tag-success"; tagText = "archive"; }
    else { tagClass = "tag tag-danger"; tagText = "delete"; }

    const row = GCC.createEl("tr", {}, [
      GCC.createEl("td", { textContent: GCC.formatDate(run.timestamp) }),
      GCC.createEl("td", { textContent: run.intensity || "normal" }),
      GCC.createEl("td", { textContent: GCC.formatNumber(count) }),
      GCC.createEl("td", { textContent: GCC.formatMb(run.freedMb) }),
      GCC.createEl("td", { textContent: GCC.formatDuration(run.duration) }),
      GCC.createEl("td", {}, [GCC.createEl("span", { className: tagClass, textContent: tagText })])
    ]);
    ui.historyBody.appendChild(row);
  }
}

// =========================
// Undo Log + Restore (7.6)
// =========================
// Restore drives the engine (runKind "restoreRun") in a Gmail tab: it
// searches the run's label, selects everything, and clicks Gmail's own
// move-back-to-Inbox control. One restore at a time; progress comes
// back as gmailCleanerProgress messages and the finished outcome is
// persisted on the log entry by the service worker.

const restoreState = {
  running: false,
  entryId: null,
  tabId: null,
  button: null,
  noteEl: null
};

const setRestoreStatus = (text) => {
  if (ui.restoreStatus) ui.restoreStatus.textContent = text || "";
};

const tabsQuery = (info) =>
  GCC.promisify(chrome.tabs.query.bind(chrome.tabs), info);

const tabsSendMessage = (tabId, message) =>
  GCC.promisify(chrome.tabs.sendMessage.bind(chrome.tabs), tabId, message);

const scriptingExecuteScript = (details) =>
  GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), details);

async function findGmailTab() {
  if (!GCC.hasChromeTabs()) return null;
  try {
    const tabs = await tabsQuery({ url: "https://mail.google.com/*" });
    if (!tabs?.length) return null;
    return tabs.find((t) => t.active) || tabs[0];
  } catch {
    return null;
  }
}

// 7.12: no Gmail tab open is handled for the user, same as the popup.
// The tab opens in the background (this page keeps focus and streams
// restore progress) and the wait tolerates Gmail's slow first paint.
const GMAIL_OPEN_TIMEOUT_MS = 30000;

async function openGmailAndWait() {
  let created = null;
  try {
    created = await GCC.promisify(chrome.tabs.create.bind(chrome.tabs), {
      url: "https://mail.google.com/mail/u/0/#inbox",
      active: false
    });
  } catch {
    return null;
  }
  if (!created?.id) return null;
  GCC.showToast("Opening Gmail in the background...", "info");
  const deadline = Date.now() + GMAIL_OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await GCC.sleep(400);
    let tab = null;
    try {
      tab = await GCC.promisify(chrome.tabs.get.bind(chrome.tabs), created.id);
    } catch {
      return null;
    }
    if (tab?.status !== "complete") continue;
    if (tab.url?.startsWith("https://mail.google.com/")) {
      await GCC.sleep(1200);
      return tab;
    }
    if (tab.url) {
      // Signed-out redirect: no host access there, nothing to inject.
      GCC.showToast("Sign in to Gmail in the tab that just opened, then retry", "warning");
      return null;
    }
  }
  GCC.showToast("Gmail is taking too long to load, try again shortly", "warning");
  return null;
}

// Same injection shape the popup uses for the auxiliary run kinds:
// refuse without the Gmail grant, auto-open Gmail when no tab exists,
// refuse a tab that already has a run attached, then config +
// contentScript.js.
async function injectRestoreRun(entry) {
  if (!GCC.hasChromeScripting() || !GCC.hasChromeTabs()) {
    GCC.showToast("Extension APIs unavailable on this page", "error");
    return null;
  }
  if (!(await GCC.gmailAccess.check())) {
    GCC.showToast("Allow Gmail access from the extension popup first", "warning");
    return null;
  }
  let gmailTab = await findGmailTab();
  if (!gmailTab) {
    setRestoreStatus("No Gmail tab open. Opening Gmail...");
    gmailTab = await openGmailAndWait();
    if (!gmailTab) {
      setRestoreStatus("");
      GCC.showToast("Could not get a Gmail tab ready, try again", "warning");
      return null;
    }
  }

  try {
    const [attached] = await scriptingExecuteScript({
      target: { tabId: gmailTab.id },
      func: () => !!window.GCC_ATTACHED
    });
    if (attached?.result === true) {
      GCC.showToast("Another run is already in progress", "warning");
      return null;
    }
  } catch {
    // Tab might not be ready; the injection below surfaces real errors.
  }

  await scriptingExecuteScript({
    target: { tabId: gmailTab.id },
    func: (cfg) => {
      window.GMAIL_CLEANER_CONFIG = cfg;
    },
    args: [{
      runKind: "restoreRun",
      restoreLabel: entry.tagLabel,
      restoreAction: entry.action === "archive" ? "archive" : "delete"
    }]
  });
  await scriptingExecuteScript({
    target: { tabId: gmailTab.id },
    files: ["contentScript.js"]
  });
  return gmailTab.id;
}

function resetRestoreState() {
  restoreState.running = false;
  restoreState.entryId = null;
  restoreState.tabId = null;
  restoreState.button = null;
  restoreState.noteEl = null;
}

async function cancelActiveRestore() {
  if (!restoreState.tabId) return;
  setRestoreStatus("Cancelling restore...");
  try {
    await tabsSendMessage(restoreState.tabId, { type: "gmailCleanerCancel" });
  } catch {
    // The tab may already be gone; the terminal message (or its
    // absence) settles the UI either way.
  }
}

async function handleRestoreClick(entry, btn, note) {
  if (restoreState.running) {
    if (restoreState.entryId === entry.id) {
      await cancelActiveRestore();
    } else {
      GCC.showToast("A restore is already running", "warning");
    }
    return;
  }

  restoreState.running = true;
  restoreState.entryId = entry.id || "";
  restoreState.button = btn;
  restoreState.noteEl = note;
  btn.textContent = "Cancel";
  note.hidden = false;
  note.textContent = "Starting restore...";
  setRestoreStatus("Starting restore...");

  let tabId = null;
  try {
    tabId = await injectRestoreRun(entry);
  } catch (e) {
    GCC.showToast("Restore failed to start: " + (e?.message || "unknown error"), "error");
  }

  if (tabId === null) {
    resetRestoreState();
    btn.textContent = "Restore";
    note.hidden = true;
    note.textContent = "";
    setRestoreStatus("");
    return;
  }
  restoreState.tabId = tabId;
}

function handleRestoreProgress(msg) {
  const { phase, status, detail, done } = msg;
  const line = [status, detail].filter(Boolean).join(" ");

  if (!done && phase !== "done") {
    if (restoreState.noteEl) {
      restoreState.noteEl.hidden = false;
      restoreState.noteEl.textContent = line || "Restoring...";
    }
    setRestoreStatus(line);
    return;
  }

  const restored = Number(msg.restoredCount) || 0;
  if (phase === "done") {
    setRestoreStatus(status || "Restore finished.");
    GCC.showToast(
      restored > 0
        ? GCC.formatNumber(restored) + " moved back to Inbox"
        : "nothing left to restore",
      restored > 0 ? "success" : "info"
    );
  } else if (phase === "cancelled") {
    setRestoreStatus(line || "Restore cancelled.");
    GCC.showToast("restore cancelled", "warning");
  } else {
    setRestoreStatus(line || "Restore failed.");
    GCC.showToast("restore did not finish", "error");
  }

  if (restoreState.noteEl) restoreState.noteEl.textContent = line;
  resetRestoreState();
  // The service worker persists restoredAt just before the terminal
  // message lands; the short beat keeps the reload behind that write.
  setTimeout(() => {
    loadUndoLog().catch(() => {});
  }, 600);
}

async function loadUndoLog() {
  const resp = await GCC.sendMessage({ type: "gmailCleanerGetUndoLog" });
  const log = resp?.log || [];

  if (!ui.undoList) return;
  ui.undoList.textContent = "";

  if (log.length === 0) {
    ui.undoList.appendChild(
      GCC.createEl("div", { className: "empty-state" }, [
        GCC.createEl("p", { textContent: "No recovery entries. Tagged emails appear here after cleanup." })
      ])
    );
    return;
  }

  for (const entry of log) {
    const tagClass = entry.action === "archive" ? "tag tag-success" : "tag tag-danger";
    const tagText = entry.action === "archive" ? "archived" : "deleted";
    const verdict = GCC.restore.eligibility(entry);

    const metaParts = [GCC.relativeTime(entry.timestamp)];
    if (entry.tagLabel) metaParts.push("Label: " + entry.tagLabel);
    if (verdict.restored) metaParts.push("Restored " + GCC.relativeTime(entry.restoredAt));

    const findUrl = "https://mail.google.com/mail/u/0/#search/label:" +
      encodeURIComponent(entry.tagLabel || "GmailCleaner");

    const findLink = GCC.createEl("a", {
      className: "btn btn-sm",
      href: findUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      textContent: "Find in Gmail"
    });

    const countEl = GCC.createEl("span", {
      textContent: GCC.formatNumber(entry.count) + " emails"
    });
    countEl.style.color = "var(--primary)";
    countEl.style.fontWeight = "600";

    const note = GCC.createEl("div", { className: "undo-restore-note", hidden: "" });

    const info = GCC.createEl("div", { className: "undo-info" }, [
      GCC.createEl("strong", { textContent: entry.label || entry.query || "Unknown" }),
      document.createTextNode(" "),
      GCC.createEl("span", { className: tagClass, textContent: tagText }),
      document.createTextNode(" "),
      countEl,
      GCC.createEl("div", { className: "undo-meta", textContent: metaParts.join(" \u00B7 ") })
    ]);

    const actions = GCC.createEl("div", { className: "undo-actions" }, [findLink]);

    if (verdict.restored) {
      actions.appendChild(GCC.createEl("span", { className: "tag tag-success", textContent: "Restored" }));
    } else if (verdict.eligible) {
      const restoreBtn = GCC.createEl("button", {
        className: "btn btn-sm btn-success undo-restore-btn",
        type: "button",
        textContent: "Restore"
      });
      restoreBtn.addEventListener("click", () => {
        handleRestoreClick(entry, restoreBtn, note).catch(() => {});
      });
      // A refresh mid-run re-renders the list; hand the fresh nodes to
      // the active run so its progress stays visible and the button
      // keeps offering Cancel.
      if (restoreState.running && restoreState.entryId === (entry.id || "")) {
        restoreBtn.textContent = "Cancel";
        restoreState.button = restoreBtn;
        restoreState.noteEl = note;
        note.hidden = false;
      }
      actions.appendChild(restoreBtn);
    } else {
      const disabledBtn = GCC.createEl("button", {
        className: "btn btn-sm undo-restore-btn",
        type: "button",
        textContent: "Restore",
        disabled: "",
        "aria-disabled": "true",
        title: verdict.reason
      });
      actions.appendChild(disabledBtn);
      info.appendChild(GCC.createEl("div", {
        className: "undo-restore-reason",
        textContent: verdict.reason
      }));
    }

    info.appendChild(note);

    ui.undoList.appendChild(GCC.createEl("div", { className: "undo-item" }, [info, actions]));
  }
}

// =========================
// Init
// =========================

async function init() {
  await GCC.theme.init();
  wireThemeSwitcher();

  await loadStats();
  await loadUndoLog();

  // Event listeners
  ui.refreshUndoBtn?.addEventListener("click", async () => {
    await loadUndoLog();
    GCC.showToast("Refreshed", "success");
  });

  ui.clearUndoBtn?.addEventListener("click", async () => {
    if (!confirm("Clear all recovery log entries?")) return;
    await GCC.sendMessage({ type: "gmailCleanerClearUndoLog" });
    await loadUndoLog();
    GCC.showToast("Log cleared", "success");
  });

  // 7.6: live progress from a restore run started on this page.
  if (GCC.hasChrome() && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type !== "gmailCleanerProgress" || msg.runKind !== "restoreRun") return;
      try {
        handleRestoreProgress(msg);
      } catch (e) {
        console.warn("[Stats] restore progress handler failed:", e);
      }
    });
  }

  // Auto-refresh every 30s, visibility-aware so we pause when the
  // stats tab is in the background (issue #17).
  GCC.pollingInterval(loadStats, 30000);
}

async function wireThemeSwitcher() {
  if (!ui.themeSwitcher) return;
  const current = await GCC.theme.get();
  for (const btn of ui.themeSwitcher.querySelectorAll("button[data-theme-value]")) {
    btn.setAttribute("aria-pressed", btn.dataset.themeValue === current ? "true" : "false");
    btn.addEventListener("click", async () => {
      const pref = btn.dataset.themeValue;
      const applied = await GCC.theme.set(pref);
      ui.themeSwitcher.querySelectorAll("button[data-theme-value]").forEach((b) => {
        b.setAttribute("aria-pressed", b.dataset.themeValue === applied ? "true" : "false");
      });
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
})();
