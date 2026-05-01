// stats.js — Statistics Dashboard Logic
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
  toastContainer: GCC.$("toastContainer")
};

// =========================
// Load Stats
// =========================

async function loadStats() {
  const resp = await GCC.sendMessage({ type: "gmailCleanerGetStats" });
  const stats = resp?.stats;

  if (!stats) {
    console.log("[Stats] No stats data available");
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
// Undo Log
// =========================

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

    const metaParts = [GCC.relativeTime(entry.timestamp)];
    if (entry.tagLabel) metaParts.push("Label: " + entry.tagLabel);

    const findUrl = "https://mail.google.com/mail/u/0/#search/label:" +
      encodeURIComponent(entry.tagLabel || "GmailCleaner");

    const findLink = GCC.createEl("a", {
      className: "btn btn-sm",
      href: findUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      textContent: "Find in Gmail"
    });

    const info = GCC.createEl("div", { className: "undo-info" }, [
      GCC.createEl("strong", { textContent: entry.label || entry.query || "Unknown" }),
      document.createTextNode(" "),
      GCC.createEl("span", { className: tagClass, textContent: tagText }),
      document.createTextNode(" "),
      GCC.createEl("span", { className: "", textContent: GCC.formatNumber(entry.count) + " emails" }),
      GCC.createEl("div", { className: "undo-meta", textContent: metaParts.join(" \u00B7 ") })
    ]);
    info.querySelector("span:last-of-type").style.color = "var(--primary)";
    info.querySelector("span:last-of-type").style.fontWeight = "600";

    ui.undoList.appendChild(GCC.createEl("div", { className: "undo-item" }, [info, findLink]));
  }
}

// =========================
// Init
// =========================

async function init() {
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

  // Auto-refresh every 30s
  setInterval(loadStats, 30000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
})();
