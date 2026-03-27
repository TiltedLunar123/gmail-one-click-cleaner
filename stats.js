// stats.js — Statistics Dashboard Logic

(() => {
  "use strict";

  // =========================
  // DOM Refs
  // =========================

  const $ = (id) => document.getElementById(id);

  const ui = {
    totalRuns: $("totalRuns"),
    totalDeleted: $("totalDeleted"),
    totalFreed: $("totalFreed"),
    totalArchived: $("totalArchived"),
    chartBars: $("chartBars"),
    chartLabels: $("chartLabels"),
    categoryList: $("categoryList"),
    historyBody: $("historyBody"),
    undoList: $("undoList"),
    refreshUndoBtn: $("refreshUndoBtn"),
    clearUndoBtn: $("clearUndoBtn"),
    toastContainer: $("toastContainer")
  };

  // =========================
  // Helpers
  // =========================

  const hasChromeRuntime = () => {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage;
    } catch { return false; }
  };

  const sendMsg = (msg) => new Promise((resolve) => {
    if (!hasChromeRuntime()) return resolve(null);
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime?.lastError) resolve(null);
      else resolve(resp);
    });
  });

  const formatNumber = (n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) return "0";
    return n.toLocaleString();
  };

  const formatMb = (mb) => {
    if (!mb || mb < 0.01) return "0 MB";
    if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
    return mb.toFixed(1) + " MB";
  };

  const formatDuration = (ms) => {
    if (!ms) return "-";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m + "m " + (s % 60) + "s";
  };

  const formatDate = (ts) => {
    try { return new Date(ts).toLocaleString(); }
    catch { return "-"; }
  };

  const relativeTime = (ts) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.floor(hrs / 24);
    return days + "d ago";
  };

  const escapeHtml = (str) => {
    const div = document.createElement("div");
    div.textContent = String(str || "");
    return div.innerHTML;
  };

  const showToast = (message, type = "info") => {
    if (!ui.toastContainer) return;
    const toast = document.createElement("div");
    toast.className = "toast toast-" + type;
    toast.textContent = message;
    ui.toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  };

  // =========================
  // Safe DOM builders (no innerHTML)
  // =========================

  function createEl(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, val] of Object.entries(attrs)) {
        if (key === "className") el.className = val;
        else if (key === "textContent") el.textContent = val;
        else if (key === "style" && typeof val === "object") Object.assign(el.style, val);
        else el.setAttribute(key, val);
      }
    }
    if (children) {
      for (const child of (Array.isArray(children) ? children : [children])) {
        if (typeof child === "string") el.appendChild(document.createTextNode(child));
        else if (child) el.appendChild(child);
      }
    }
    return el;
  }

  // =========================
  // Load Stats
  // =========================

  async function loadStats() {
    const resp = await sendMsg({ type: "gmailCleanerGetStats" });
    const stats = resp?.stats;

    if (!stats) {
      console.log("[Stats] No stats data available");
      return;
    }

    // Overview cards
    if (ui.totalRuns) ui.totalRuns.textContent = formatNumber(stats.totalRuns);
    if (ui.totalDeleted) ui.totalDeleted.textContent = formatNumber(stats.totalDeleted);
    if (ui.totalFreed) ui.totalFreed.textContent = formatMb(stats.totalFreedMb);
    if (ui.totalArchived) ui.totalArchived.textContent = formatNumber(stats.totalArchived);

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
        createEl("div", { className: "no-data", textContent: "No activity in the last 30 days" })
      );
      return;
    }

    days.forEach((day, i) => {
      const pct = Math.max(2, (values[i] / maxVal) * 100);
      const tooltip = createEl("div", {
        className: "tooltip",
        textContent: day.slice(5) + ": " + formatNumber(values[i])
      });
      const bar = createEl("div", { className: "chart-bar" }, [tooltip]);
      bar.style.height = pct + "%";
      ui.chartBars.appendChild(bar);

      const label = createEl("span", {
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
        createEl("div", { className: "empty-state", textContent: "No category data yet" })
      );
      return;
    }

    const maxCount = Math.max(...entries.map(e => e[1].count), 1);

    for (const [name, data] of entries) {
      const pct = Math.round((data.count / maxCount) * 100);
      const fill = createEl("div", { className: "category-bar-fill" });
      fill.style.width = pct + "%";

      const item = createEl("div", { className: "category-item" }, [
        createEl("span", { className: "category-name", textContent: name }),
        createEl("span", { className: "category-count", textContent: formatNumber(data.count) }),
        createEl("div", { className: "category-bar-bg" }, [fill])
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
      const td = createEl("td", { textContent: "No run history yet" });
      td.setAttribute("colspan", "6");
      td.className = "empty-state";
      ui.historyBody.appendChild(createEl("tr", {}, [td]));
      return;
    }

    for (const run of history.slice(0, 25)) {
      const count = (run.deleted || 0) + (run.archived || 0);

      let tagClass, tagText;
      if (run.dryRun) { tagClass = "tag tag-info"; tagText = "dry run"; }
      else if (run.archived) { tagClass = "tag tag-success"; tagText = "archive"; }
      else { tagClass = "tag tag-danger"; tagText = "delete"; }

      const row = createEl("tr", {}, [
        createEl("td", { textContent: formatDate(run.timestamp) }),
        createEl("td", { textContent: run.intensity || "normal" }),
        createEl("td", { textContent: formatNumber(count) }),
        createEl("td", { textContent: formatMb(run.freedMb) }),
        createEl("td", { textContent: formatDuration(run.duration) }),
        createEl("td", {}, [createEl("span", { className: tagClass, textContent: tagText })])
      ]);
      ui.historyBody.appendChild(row);
    }
  }

  // =========================
  // Undo Log
  // =========================

  async function loadUndoLog() {
    const resp = await sendMsg({ type: "gmailCleanerGetUndoLog" });
    const log = resp?.log || [];

    if (!ui.undoList) return;
    ui.undoList.textContent = "";

    if (log.length === 0) {
      ui.undoList.appendChild(
        createEl("div", { className: "empty-state", textContent: "No recovery entries" })
      );
      return;
    }

    for (const entry of log) {
      const tagClass = entry.action === "archive" ? "tag tag-success" : "tag tag-danger";
      const tagText = entry.action === "archive" ? "archived" : "deleted";

      const metaParts = [relativeTime(entry.timestamp)];
      if (entry.tagLabel) metaParts.push("Label: " + entry.tagLabel);

      const findUrl = "https://mail.google.com/mail/u/0/#search/label:" +
        encodeURIComponent(entry.tagLabel || "GmailCleaner");

      const findLink = createEl("a", {
        className: "btn btn-sm",
        href: findUrl,
        target: "_blank",
        rel: "noopener",
        textContent: "Find in Gmail"
      });

      const info = createEl("div", { className: "undo-info" }, [
        createEl("strong", { textContent: entry.label || entry.query || "Unknown" }),
        document.createTextNode(" "),
        createEl("span", { className: tagClass, textContent: tagText }),
        document.createTextNode(" "),
        createEl("span", { className: "", textContent: formatNumber(entry.count) + " emails" }),
        createEl("div", { className: "undo-meta", textContent: metaParts.join(" \u00B7 ") })
      ]);
      info.querySelector("span:last-of-type").style.color = "var(--primary)";
      info.querySelector("span:last-of-type").style.fontWeight = "600";

      ui.undoList.appendChild(createEl("div", { className: "undo-item" }, [info, findLink]));
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
      showToast("Refreshed", "success");
    });

    ui.clearUndoBtn?.addEventListener("click", async () => {
      if (!confirm("Clear all recovery log entries?")) return;
      await sendMsg({ type: "gmailCleanerClearUndoLog" });
      await loadUndoLog();
      showToast("Log cleared", "success");
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
