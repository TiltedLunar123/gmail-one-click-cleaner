(() => {
  "use strict";

  // =========================
  // Constants & Configuration
  // =========================

  const PROGRESS_VERSION = "4.0.0";

  const CONFIG = Object.freeze({
    MAX_LOG_ENTRIES: 300,
    TOAST_DURATION_MS: 3000,
    TIP_THRESHOLD_COUNT: 50,
    RECONNECT_TIMEOUT_MS: 5000,
    AUTO_RECONNECT_INTERVAL_MS: 30000,
    AUTO_RECONNECT_STALE_MS: 60000,
    MAX_AUTO_RECONNECT_ATTEMPTS: 3
  });

  const PHASES = Object.freeze({
    BOOT: "boot",
    STARTING: "starting",
    QUERY: "query",
    QUERY_DONE: "query-done",
    TAG: "tag",
    REVIEW: "review",
    DONE: "done",
    CANCELLED: "cancelled",
    ERROR: "error"
  });

  const PHASE_LABELS = Object.freeze({
    [PHASES.BOOT]: "boot",
    [PHASES.STARTING]: "starting",
    [PHASES.QUERY]: "running queries",
    [PHASES.QUERY_DONE]: "query finished",
    [PHASES.TAG]: "tagging",
    [PHASES.REVIEW]: "reviewing",
    [PHASES.DONE]: "done",
    [PHASES.CANCELLED]: "cancelled",
    [PHASES.ERROR]: "error"
  });

  const LOG_LEVELS = Object.freeze({
    INFO: "info",
    SUCCESS: "success",
    WARNING: "warning",
    ERROR: "error"
  });

  // =========================
  // Parse URL Parameters
  // =========================

  const parseGmailTabId = () => {
    try {
      const params = new URLSearchParams(location.search);
      const raw = params.get("gmailTabId");
      if (raw === null || raw === "") return null;

      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  };

  const gmailTabId = parseGmailTabId();

  // =========================
  // State Management
  // =========================

  const state = {
    lastPhase: PHASES.STARTING,
    done: false,
    mode: "live",
    logsExpanded: false, // "expanded" = max height removed
    rows: [],
    tipShown: false,
    isReconnecting: false,
    logHistory: [],
    startTime: Date.now(),
    toastTimer: null,
    lastMessageTime: Date.now(),
    autoReconnectTimer: null,
    autoReconnectAttempts: 0
  };

  // =========================
  // DOM Element Cache
  // =========================

  const ui = {
    // Progress elements
    barInner: document.getElementById("barInner"),
    percentText: document.getElementById("percentText"),
    progressBar: document.querySelector(".bar"),

    // Status elements
    status: document.getElementById("status"),
    statusSpinner: document.querySelector("#status .spinner"),
    statusText: document.getElementById("statusText"),
    tags: document.getElementById("tags"),

    // Version pill (optional)
    versionPill: document.getElementById("versionPill"),

    // Log elements
    details: document.getElementById("details"),
    copyLogsBtn: document.getElementById("copyLogsBtn"),
    clearLogsBtn: document.getElementById("clearLogsBtn"),

    // Control buttons
    cancel: document.getElementById("cancelBtn"),
    reconnect: document.getElementById("reconnectBtn"),
    reinject: document.getElementById("reinjectBtn"),
    toggleLogs: document.getElementById("toggleLogs"),

    // Summary elements
    summary: document.getElementById("summary"),
    table: document.getElementById("summaryTable"),
    tipPrompt: document.getElementById("tipPrompt"),

    // Review modal
    reviewModal: document.getElementById("reviewModal"),
    modalCount: document.getElementById("modalCount"),
    modalQuery: document.getElementById("modalQuery"),
    modalSkipBtn: document.getElementById("modalSkipBtn"),
    modalProceedBtn: document.getElementById("modalProceedBtn"),

    // Log filter
    logFilter: document.getElementById("logFilter"),

    // Single toast element (matches your HTML)
    toast: document.getElementById("toast")
  };

  const tbody = ui.table?.querySelector("tbody") || null;

  // =========================
  // Utility Functions
  // =========================

  const hasChromeRuntime = () => {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime;
    } catch {
      return false;
    }
  };

  const hasChromeTabs = () => {
    try {
      return hasChromeRuntime() && !!chrome.tabs;
    } catch {
      return false;
    }
  };

  const hasChromeScripting = () => {
    try {
      return hasChromeRuntime() && !!chrome.scripting;
    } catch {
      return false;
    }
  };

  const hasChromeStorage = (type = "sync") => {
    try {
      return (
        typeof chrome !== "undefined" &&
        chrome?.storage?.[type] &&
        typeof chrome.storage[type].get === "function"
      );
    } catch {
      return false;
    }
  };

  // Promisify chrome.* callback APIs
  const p = (fn, ...args) =>
    new Promise((resolve, reject) => {
      try {
        fn(...args, (result) => {
          const err = chrome?.runtime?.lastError;
          if (err) reject(err);
          else resolve(result);
        });
      } catch (e) {
        reject(e);
      }
    });

  const getTimestamp = () => {
    const now = new Date();
    return now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  };

  const formatDuration = (ms) => {
    if (ms == null || ms < 0) return "–";
    const sec = ms / 1000;
    return sec.toFixed(sec >= 10 ? 0 : 1) + "s";
  };

  const formatNumber = (num) => {
    if (typeof num !== "number" || !Number.isFinite(num)) return "0";
    return num.toLocaleString();
  };

  const formatMB = (mb) => {
    const n = Number(mb);
    if (!Number.isFinite(n) || n <= 0) return "0";
    return n >= 10 ? n.toFixed(0) : n.toFixed(1);
  };

  const log = (level, ...args) => {
    const prefix = "[Gmail Cleaner Progress]";
    const fn = console[level] || console.log;
    fn.call(console, prefix, ...args);
  };

  // =========================
  // Toast Notifications (single element)
  // =========================

  const TOAST_ICONS = Object.freeze({
    success: "✅",
    error: "❌",
    warning: "⚠️",
    info: "ℹ️"
  });

  const showToast = (message, type = "info", duration = CONFIG.TOAST_DURATION_MS) => {
    if (!ui.toast) {
      log("info", `[Toast ${type}]`, message);
      return;
    }

    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }

    const icon = TOAST_ICONS[type] || TOAST_ICONS.info;
    ui.toast.textContent = `${icon} ${message}`;

    ui.toast.classList.remove("success", "error", "warning");
    if (type === "success") ui.toast.classList.add("success");
    else if (type === "error") ui.toast.classList.add("error");
    else if (type === "warning") ui.toast.classList.add("warning");

    ui.toast.classList.add("show");

    state.toastTimer = setTimeout(() => {
      ui.toast.classList.remove("show");
      state.toastTimer = null;
    }, duration);
  };

  // =========================
  // Status Management
  // =========================

  const setStatus = (message) => {
    if (ui.statusSpinner) ui.statusSpinner.hidden = true;
    if (ui.statusText) ui.statusText.textContent = message || "";
  };

  const setStatusLoading = (message) => {
    if (ui.statusSpinner) ui.statusSpinner.hidden = false;
    if (ui.statusText) ui.statusText.textContent = message || "";
  };

  // map your internal phases to the CSS phase colors in the HTML
  const phaseToCssPhase = (phase) => {
    if (phase === PHASES.ERROR) return "error";
    if (phase === PHASES.DONE || phase === PHASES.CANCELLED) return "complete";
    if (phase === PHASES.TAG) return "cleaning";
    if (phase === PHASES.QUERY || phase === PHASES.QUERY_DONE || phase === PHASES.REVIEW) return "searching";
    return "starting";
  };

  const setPhaseTag = (phase) => {
    if (!ui.tags) return;

    const label = PHASE_LABELS[phase] || phase || "starting";
    ui.tags.textContent = label;

    // Use the CSS-friendly phase bucket for styling
    ui.tags.setAttribute("data-phase", phaseToCssPhase(phase || "starting"));
  };

  // =========================
  // Progress Bar
  // =========================

  const setPercent = (p) => {
    const percent = Math.max(0, Math.min(100, Number.isFinite(p) ? p : 0));

    if (ui.barInner) {
      ui.barInner.style.width = `${percent}%`;
      if (percent >= 100) ui.barInner.setAttribute("data-complete", "true");
      else ui.barInner.removeAttribute("data-complete");
    }

    if (ui.percentText) ui.percentText.textContent = `${percent.toFixed(0)}%`;
    if (ui.progressBar) ui.progressBar.setAttribute("aria-valuenow", String(Math.round(percent)));
  };

  // =========================
  // Logging System
  // =========================

  const appendLog = (line, level = LOG_LEVELS.INFO) => {
    if (!ui.details) return;

    const emptyState = ui.details.querySelector(".empty-state");
    if (emptyState) emptyState.remove();

    const timestamp = getTimestamp();
    const entry = `[${timestamp}] ${line}`;

    state.logHistory.push(entry);
    if (state.logHistory.length > CONFIG.MAX_LOG_ENTRIES) state.logHistory.shift();

    const div = document.createElement("div");
    div.className = `log-entry log-${level}`;

    const ts = document.createElement("span");
    ts.className = "log-timestamp";
    ts.textContent = `[${timestamp}]`;

    div.appendChild(ts);
    div.appendChild(document.createTextNode(` ${line}`));
    ui.details.appendChild(div);

    while (ui.details.children.length > CONFIG.MAX_LOG_ENTRIES) {
      ui.details.removeChild(ui.details.firstChild);
    }

    ui.details.scrollTop = ui.details.scrollHeight;
  };

  const clearLogs = () => {
    if (!ui.details) return;

    ui.details.replaceChildren();
    state.logHistory = [];

    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "Log cleared";
    ui.details.appendChild(emptyState);

    showToast("log cleared", "info");
  };

  const filterLogs = (query) => {
    if (!ui.details) return;
    const entries = ui.details.querySelectorAll(".log-entry");
    const q = (query || "").toLowerCase().trim();

    for (const entry of entries) {
      if (!q || entry.textContent.toLowerCase().includes(q)) {
        entry.style.display = "";
      } else {
        entry.style.display = "none";
      }
    }
  };

  const copyLogs = async () => {
    if (state.logHistory.length === 0) {
      showToast("no logs to copy", "warning");
      return;
    }

    const content = [
      "Gmail Cleaner Progress Log",
      `Generated: ${new Date().toISOString()}`,
      `Gmail Tab ID: ${gmailTabId || "unknown"}`,
      "---",
      ...state.logHistory
    ].join("\n");

    try {
      await navigator.clipboard.writeText(content);
      showToast("log copied", "success");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = content;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();

      try {
        document.execCommand("copy");
        showToast("log copied", "success");
      } catch {
        showToast("failed to copy", "error");
      }

      document.body.removeChild(textarea);
    }
  };

  // =========================
  // Summary & Stats
  // =========================

  const renderStatsSummary = (stats) => {
    if (!ui.summary) return;
    ui.summary.replaceChildren();
    if (!stats) return;

    const mode = stats.mode === "dry" ? "dry" : "live";
    state.mode = mode;

    const chips = [];

    if (mode === "dry") {
      chips.push(["Mode", "Dry-run"]);
      const wouldCleanTotal = (stats.totalWouldDelete || 0) + (stats.totalWouldArchive || 0);
      if (wouldCleanTotal > 0) chips.push(["Would clean", formatNumber(wouldCleanTotal)]);
    } else {
      chips.push(["Mode", "Live"]);
      const cleanedTotal = (stats.totalDeleted || 0) + (stats.totalArchived || 0);
      if (cleanedTotal > 0) chips.push(["Cleaned", formatNumber(cleanedTotal)]);
    }

    if (typeof stats.totalQueries === "number") chips.push(["Queries", formatNumber(stats.totalQueries)]);

    // Freed storage if provided by content script
    const freedMb =
      Number(stats.totalFreedMb ?? stats.freedMb ?? stats.totalFreedMB ?? stats.freedMB);
    if (Number.isFinite(freedMb) && freedMb > 0) chips.push(["Freed", `${formatMB(freedMb)} MB`]);

    const duration = Date.now() - state.startTime;
    if (duration > 1000) chips.push(["Duration", formatDuration(duration)]);

    for (const [label, value] of chips) {
      const pill = document.createElement("span");
      pill.className = "pill";

      const labelText = document.createTextNode(`${label}: `);
      const strong = document.createElement("strong");
      strong.textContent = value;

      pill.appendChild(labelText);
      pill.appendChild(strong);
      ui.summary.appendChild(pill);
    }
  };

  // =========================
  // Per-query table
  // HTML columns: Query | Mode | Count | Freed MB | Duration
  // =========================

  const renderRowsTable = () => {
    if (!ui.table || !tbody) return;

    if (state.rows.length === 0) {
      ui.table.style.display = "none";
      tbody.replaceChildren();
      return;
    }

    ui.table.style.display = "table";
    tbody.replaceChildren();

    const fragment = document.createDocumentFragment();

    for (const row of state.rows) {
      const tr = document.createElement("tr");

      // Query/Label
      const tdQuery = document.createElement("td");
      tdQuery.textContent = row.label || row.query || "(unknown)";
      tdQuery.title = row.query || "";
      tr.appendChild(tdQuery);

      // Mode
      const tdMode = document.createElement("td");
      const modeTag = document.createElement("span");
      modeTag.className = "tag";
      modeTag.textContent = row.mode === "dry" ? "dry-run" : "live";
      tdMode.appendChild(modeTag);
      tr.appendChild(tdMode);

      // Count
      const tdCount = document.createElement("td");
      tdCount.textContent = formatNumber(row.count || 0);
      tr.appendChild(tdCount);

      // Freed MB
      const tdFreed = document.createElement("td");
      const freed = Number(row.freedMb);
      tdFreed.textContent = Number.isFinite(freed) && freed > 0 ? formatMB(freed) : "0";
      tr.appendChild(tdFreed);

      // Duration
      const tdDuration = document.createElement("td");
      tdDuration.textContent = formatDuration(row.durationMs);
      tr.appendChild(tdDuration);

      fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);
  };

  const maybeShowTipPrompt = (stats) => {
    if (!ui.tipPrompt || state.tipShown) return;
    if (!stats) return;

    const mode = stats.mode === "dry" ? "dry" : "live";
    if (mode !== "live") return;

    const cleanedTotal = (stats.totalDeleted || 0) + (stats.totalArchived || 0);
    if (cleanedTotal < CONFIG.TIP_THRESHOLD_COUNT) return;

    ui.tipPrompt.style.display = "block";
    state.tipShown = true;
  };

  // =========================
  // Button State Management
  // =========================

  const setButtonLoading = (btn, loading, loadingText) => {
    if (!btn) return;

    btn.disabled = loading;

    if (loading) {
      btn.classList.add("loading");
      btn.setAttribute("aria-busy", "true");
      if (loadingText) {
        btn.dataset.originalText = btn.textContent || "";
        btn.textContent = loadingText;
      }
    } else {
      btn.classList.remove("loading");
      btn.removeAttribute("aria-busy");
      if (btn.dataset.originalText) {
        btn.textContent = btn.dataset.originalText;
        delete btn.dataset.originalText;
      }
    }
  };

  const updateButtonsForDone = (phase) => {
    if (ui.cancel) {
      ui.cancel.disabled = true;
      ui.cancel.classList.remove("loading");

      if (phase === PHASES.CANCELLED) ui.cancel.textContent = "Run cancelled";
      else if (phase === PHASES.ERROR) ui.cancel.textContent = "Run ended with error";
      else ui.cancel.textContent = "Run finished";
    }

    if (ui.reconnect) ui.reconnect.disabled = true;
    if (ui.reinject) ui.reinject.disabled = true;
  };

  // =========================
  // Review Modal
  // =========================

  const openReviewModal = (label, count, query) => {
    if (!ui.reviewModal) return;

    if (ui.modalCount) {
      ui.modalCount.textContent =
        typeof count === "number" ? formatNumber(count) : String(count || "many");
    }
    if (ui.modalQuery) ui.modalQuery.textContent = label || query || "";

    try {
      ui.reviewModal.showModal();
    } catch (err) {
      log("error", "Failed to show review modal:", err);
    }
  };

  const closeReviewModal = () => {
    if (!ui.reviewModal) return;
    try {
      ui.reviewModal.close();
    } catch {
      // ignore
    }
  };

  const sendReviewSignal = async (signal) => {
    if (!gmailTabId) {
      appendLog("Cannot send review signal: Gmail tab ID missing", LOG_LEVELS.ERROR);
      return;
    }
    if (!hasChromeTabs()) {
      appendLog("Cannot send review signal: chrome.tabs unavailable", LOG_LEVELS.ERROR);
      return;
    }

    try {
      const type = signal === "resume" ? "gmailCleanerResume" : "gmailCleanerSkip";
      await p(chrome.tabs.sendMessage.bind(chrome.tabs), gmailTabId, { type });

      appendLog(`Review decision: ${signal.toUpperCase()}`, LOG_LEVELS.SUCCESS);
      setPhaseTag(PHASES.QUERY);
      setStatusLoading("Continuing cleanup...");
    } catch (err) {
      log("error", "Failed to send review signal:", err);
      appendLog(`Error sending review signal: ${err?.message || err}`, LOG_LEVELS.ERROR);
      showToast("failed to send review signal", "error");
    }
  };

  // =========================
  // Storage Operations
  // =========================

  const saveStatsToStorage = async (stats) => {
    if (!hasChromeStorage("sync")) return;
    try {
      const finishedAt = Date.now();
      const statsToSave = { ...stats, finishedAt };
      await p(chrome.storage.sync.set.bind(chrome.storage.sync), { lastRunStats: statsToSave });
    } catch (err) {
      log("warn", "Failed to save stats to storage:", err);
    }
  };

  const getLastConfig = async () => {
    // session first
    if (hasChromeStorage("session")) {
      try {
        const result = await p(chrome.storage.session.get.bind(chrome.storage.session), "lastConfig");
        if (result?.lastConfig) return result.lastConfig;
      } catch {
        // fall through
      }
    }

    // local fallback
    if (hasChromeStorage("local")) {
      try {
        const result = await p(chrome.storage.local.get.bind(chrome.storage.local), "lastConfig");
        return result?.lastConfig || null;
      } catch {
        // ignore
      }
    }

    return null;
  };

  // =========================
  // Done Handler
  // =========================

  const handleDone = (msg) => {
    state.done = true;
    stopAutoReconnect();
    const phase = msg.phase || PHASES.DONE;

    setPhaseTag(phase);
    setPercent(msg.percent ?? 100);
    updateButtonsForDone(phase);

    if (msg.stats) {
      renderStatsSummary(msg.stats);
      if (phase === PHASES.DONE) {
        maybeShowTipPrompt(msg.stats);
        saveStatsToStorage(msg.stats);
      }
    }

    const summary = msg.detail || "All queries processed.";
    appendLog(`Run finished: ${summary}`, LOG_LEVELS.SUCCESS);

    if (phase === PHASES.DONE) showToast("cleanup completed", "success");
    else if (phase === PHASES.CANCELLED) showToast("cleanup cancelled", "warning");
    else if (phase === PHASES.ERROR) showToast("cleanup ended with error", "error");
  };

  // =========================
  // Message Handler
  // =========================

  const handleProgressMessage = (message) => {
    if (!message) return;

    // Review request
    if (message.type === "gmailCleanerRequestReview") {
      appendLog(`Review requested for: ${message.label || message.query || "(unknown)"}`, LOG_LEVELS.INFO);
      setPhaseTag(PHASES.REVIEW);
      setStatus("Waiting for your review...");
      openReviewModal(message.label, message.count, message.query);
      return;
    }

    if (message.type !== "gmailCleanerProgress") return;

    // Track last message time for auto-reconnect
    state.lastMessageTime = Date.now();
    state.autoReconnectAttempts = 0;

    const { phase, status, detail, percent, stats } = message;

    // Status — show spinner for all active (non-terminal) phases
    const isActivePhase = phase && ![PHASES.DONE, PHASES.CANCELLED, PHASES.ERROR].includes(phase);
    if (status) {
      if (isActivePhase) setStatusLoading(status);
      else setStatus(status);

      appendLog(status + (detail ? ` — ${detail}` : ""), LOG_LEVELS.INFO);
    } else if (detail) {
      if (isActivePhase && !status) setStatusLoading(detail);
      appendLog(detail, LOG_LEVELS.INFO);
    }

    // Progress
    if (typeof percent === "number") setPercent(percent);

    // Phase
    if (phase) {
      state.lastPhase = phase;
      setPhaseTag(phase);
    }

    // Query finished -> table row
    if (phase === PHASES.QUERY_DONE) {
      const freedMb =
        Number(message.freedMb ?? message.freedMB ?? message.freed_mb ?? message.freed) ||
        (Number.isFinite(Number(message.freedBytes)) ? Number(message.freedBytes) / (1024 * 1024) : 0);

      state.rows.push({
        query: message.query || "",
        label: message.label || "",
        count: message.count || 0,
        mode: message.mode || stats?.mode || state.mode || "live",
        durationMs: message.durationMs ?? null,
        freedMb
      });

      renderRowsTable();
    }

    // Summary
    if (stats) renderStatsSummary(stats);

    // Completion
    if (message.done || phase === PHASES.DONE || phase === PHASES.CANCELLED || phase === PHASES.ERROR) {
      handleDone(message);
    }

    // Error detail logging
    if (phase === PHASES.ERROR) {
      if (ui.cancel) ui.cancel.disabled = true;
      appendLog(`Error details: ${detail || "unknown error"}`, LOG_LEVELS.ERROR);
    }

    if (phase === PHASES.CANCELLED) {
      appendLog("Run cancelled by user.", LOG_LEVELS.WARNING);
    }
  };

  // =========================
  // Button Handlers
  // =========================

  const handleCancel = async () => {
    if (!gmailTabId) {
      appendLog("Cannot cancel: Gmail tab ID missing.", LOG_LEVELS.ERROR);
      showToast("cannot cancel: no tab id", "error");
      return;
    }
    if (!hasChromeTabs()) {
      appendLog("Cannot cancel: chrome.tabs unavailable.", LOG_LEVELS.ERROR);
      showToast("cannot cancel: tabs unavailable", "error");
      return;
    }

    setButtonLoading(ui.cancel, true, "Cancelling…");
    appendLog("Sending cancel signal...", LOG_LEVELS.INFO);

    try {
      await p(chrome.tabs.sendMessage.bind(chrome.tabs), gmailTabId, { type: "gmailCleanerCancel" });
      appendLog(`Cancel signal sent to Gmail tab ${gmailTabId}.`, LOG_LEVELS.SUCCESS);
      showToast("cancel sent", "info");
    } catch (err) {
      log("error", "Failed to send cancel message:", err);
      appendLog(`Failed to send cancel message: ${err?.message || err}`, LOG_LEVELS.ERROR);
      showToast("failed to cancel", "error");
      setButtonLoading(ui.cancel, false);
    }
  };

  const handleReconnect = async () => {
    if (!gmailTabId) {
      appendLog("Cannot reconnect: Gmail tab ID missing.", LOG_LEVELS.ERROR);
      showToast("cannot reconnect: no tab id", "error");
      return;
    }
    if (!hasChromeTabs()) {
      appendLog("Cannot reconnect: chrome.tabs unavailable.", LOG_LEVELS.ERROR);
      showToast("cannot reconnect: tabs unavailable", "error");
      return;
    }
    if (state.isReconnecting) return;

    state.isReconnecting = true;
    setButtonLoading(ui.reconnect, true, "Reconnecting…");
    appendLog("Pinging Gmail content script…", LOG_LEVELS.INFO);

    try {
      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Reconnect timeout")), CONFIG.RECONNECT_TIMEOUT_MS);

        chrome.tabs.sendMessage(gmailTabId, { type: "gmailCleanerPing" }, (resp) => {
          clearTimeout(timeout);
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) reject(new Error(lastErr.message));
          else resolve(resp);
        });
      });

      if (!response?.ok) {
        appendLog("Reconnect: script responded but not ok.", LOG_LEVELS.WARNING);
        setStatus("Reconnect: script responded but not ok.");
        showToast("reconnect partial", "warning");
      } else {
        appendLog(`Reconnect OK. Phase: ${response.phase || "unknown"}`, LOG_LEVELS.SUCCESS);
        setStatus("Reconnected to Gmail tab.");
        showToast("reconnected", "success");
      }
    } catch (err) {
      log("error", "Reconnect error:", err);
      appendLog(`Reconnect failed: ${err?.message || err}`, LOG_LEVELS.ERROR);
      setStatus("Reconnect failed. Try Re-inject.");
      showToast("reconnect failed", "error");
    } finally {
      setButtonLoading(ui.reconnect, false);
      state.isReconnecting = false;
    }
  };

  const handleReinject = async () => {
    if (!gmailTabId) {
      appendLog("Cannot re-inject: Gmail tab ID missing.", LOG_LEVELS.ERROR);
      showToast("cannot re-inject: no tab id", "error");
      return;
    }
    if (!hasChromeScripting()) {
      appendLog("Cannot re-inject: chrome.scripting unavailable.", LOG_LEVELS.ERROR);
      showToast("cannot re-inject: scripting unavailable", "error");
      return;
    }

    setButtonLoading(ui.reinject, true, "Re-injecting…");
    appendLog("Re-injecting cleaner into Gmail tab…", LOG_LEVELS.INFO);
    setStatusLoading("Re-injecting cleaner into Gmail tab…");

    try {
      // Clear the duplicate-injection guard so the script can re-attach
      await p(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: gmailTabId },
        func: () => { window.GCC_ATTACHED = false; }
      });

      const cfg = await getLastConfig();

      if (cfg) {
        await p(chrome.scripting.executeScript.bind(chrome.scripting), {
          target: { tabId: gmailTabId },
          func: (config) => {
            window.GMAIL_CLEANER_CONFIG = config || window.GMAIL_CLEANER_CONFIG || {};
          },
          args: [cfg]
        });
      }

      await p(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: gmailTabId },
        files: ["contentScript.js"]
      });

      appendLog("Re-injected content script into Gmail tab.", LOG_LEVELS.SUCCESS);
      setStatus("Cleaner re-injected. It should resume sending progress shortly.");
      showToast("re-injected", "success");
    } catch (err) {
      log("error", "Re-inject error:", err);
      appendLog(`Re-inject error: ${err?.message || err}`, LOG_LEVELS.ERROR);
      setStatus("Re-inject failed. Close this and start a new run from the popup.");
      showToast("re-inject failed", "error");
    } finally {
      setButtonLoading(ui.reinject, false);
    }
  };

  const handleToggleLogs = () => {
    if (!ui.details || !ui.toggleLogs) return;

    // If logsExpanded=true -> collapse to default height
    state.logsExpanded = !state.logsExpanded;

    if (state.logsExpanded) {
      ui.details.style.maxHeight = "none";
      ui.details.style.overflowY = "visible";
      ui.toggleLogs.textContent = "Collapse";
      ui.toggleLogs.setAttribute("aria-pressed", "true");
    } else {
      ui.details.style.maxHeight = "240px";
      ui.details.style.overflowY = "auto";
      ui.toggleLogs.textContent = "Logs";
      ui.toggleLogs.setAttribute("aria-pressed", "false");
    }
  };

  // =========================
  // Keyboard Shortcuts
  // =========================

  const setupKeyboardShortcuts = () => {
    document.addEventListener("keydown", (e) => {
      // Escape
      if (e.key === "Escape") {
        if (ui.reviewModal?.open) {
          closeReviewModal();
          sendReviewSignal("skip");
          return;
        }
        if (!state.done && ui.cancel && !ui.cancel.disabled) {
          handleCancel();
          return;
        }
      }

      // Ctrl/Cmd + Shift + C copy logs (avoids hijacking normal copy)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        copyLogs();
      }

      // Enter in review modal -> proceed
      if (e.key === "Enter" && ui.reviewModal?.open) {
        e.preventDefault();
        closeReviewModal();
        sendReviewSignal("resume");
      }
    });
  };

  // =========================
  // Auto-Reconnect
  // =========================

  const stopAutoReconnect = () => {
    if (state.autoReconnectTimer) {
      clearInterval(state.autoReconnectTimer);
      state.autoReconnectTimer = null;
    }
  };

  const autoReconnectTick = async () => {
    if (state.done || state.isReconnecting || !gmailTabId) return;

    const elapsed = Date.now() - state.lastMessageTime;
    if (elapsed < CONFIG.AUTO_RECONNECT_STALE_MS) return;

    if (state.autoReconnectAttempts >= CONFIG.MAX_AUTO_RECONNECT_ATTEMPTS) {
      appendLog("Auto-reconnect: max attempts reached. Use manual buttons.", LOG_LEVELS.WARNING);
      stopAutoReconnect();
      return;
    }

    state.autoReconnectAttempts++;
    state.isReconnecting = true;
    log("info", `Auto-reconnect attempt ${state.autoReconnectAttempts}/${CONFIG.MAX_AUTO_RECONNECT_ATTEMPTS}`);
    appendLog(`Auto-reconnecting… (attempt ${state.autoReconnectAttempts})`, LOG_LEVELS.INFO);
    setStatusLoading("Auto-reconnecting…");

    // Step 1: Try pinging the existing content script
    try {
      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), CONFIG.RECONNECT_TIMEOUT_MS);
        chrome.tabs.sendMessage(gmailTabId, { type: "gmailCleanerPing" }, (resp) => {
          clearTimeout(timeout);
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) reject(new Error(lastErr.message));
          else resolve(resp);
        });
      });

      if (response?.ok) {
        appendLog("Auto-reconnect: content script is alive.", LOG_LEVELS.SUCCESS);
        setStatusLoading("Reconnected — waiting for progress…");
        state.autoReconnectAttempts = 0;
        state.isReconnecting = false;
        return;
      }
    } catch {
      // Ping failed — try re-injecting
    }

    // Step 2: Re-inject the content script
    if (!hasChromeScripting()) {
      appendLog("Auto-reconnect: scripting unavailable, cannot re-inject.", LOG_LEVELS.ERROR);
      state.isReconnecting = false;
      return;
    }

    try {
      // Clear the duplicate-injection guard so the script can re-attach
      await p(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: gmailTabId },
        func: () => { window.GCC_ATTACHED = false; }
      });

      const cfg = await getLastConfig();

      if (cfg) {
        await p(chrome.scripting.executeScript.bind(chrome.scripting), {
          target: { tabId: gmailTabId },
          func: (config) => {
            window.GMAIL_CLEANER_CONFIG = config || window.GMAIL_CLEANER_CONFIG || {};
          },
          args: [cfg]
        });
      }

      await p(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: gmailTabId },
        files: ["contentScript.js"]
      });

      appendLog("Auto-reconnect: re-injected content script.", LOG_LEVELS.SUCCESS);
      setStatusLoading("Re-injected — waiting for progress…");
      showToast("auto-reconnected", "success");
    } catch (err) {
      appendLog(`Auto-reconnect failed: ${err?.message || err}`, LOG_LEVELS.ERROR);
      if (state.autoReconnectAttempts >= CONFIG.MAX_AUTO_RECONNECT_ATTEMPTS) {
        setStatus("Auto-reconnect failed. Try manual Reconnect / Re-inject.");
        showToast("auto-reconnect failed", "error");
      }
    } finally {
      state.isReconnecting = false;
    }
  };

  const startAutoReconnect = () => {
    stopAutoReconnect();
    state.autoReconnectAttempts = 0;
    state.lastMessageTime = Date.now();
    state.autoReconnectTimer = setInterval(autoReconnectTick, CONFIG.AUTO_RECONNECT_INTERVAL_MS);
  };

  // =========================
  // Event Listeners
  // =========================

  const wireEventListeners = () => {
    ui.cancel?.addEventListener("click", handleCancel);
    ui.reconnect?.addEventListener("click", handleReconnect);
    ui.reinject?.addEventListener("click", handleReinject);
    ui.toggleLogs?.addEventListener("click", handleToggleLogs);

    ui.copyLogsBtn?.addEventListener("click", copyLogs);
    ui.clearLogsBtn?.addEventListener("click", clearLogs);
    ui.logFilter?.addEventListener("input", (e) => filterLogs(e.target.value));

    ui.modalProceedBtn?.addEventListener("click", () => {
      closeReviewModal();
      sendReviewSignal("resume");
    });

    ui.modalSkipBtn?.addEventListener("click", () => {
      closeReviewModal();
      sendReviewSignal("skip");
    });

    ui.reviewModal?.addEventListener("click", (e) => {
      if (e.target === ui.reviewModal) {
        closeReviewModal();
        sendReviewSignal("skip");
      }
    });

    setupKeyboardShortcuts();

    if (hasChromeRuntime() && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        try {
          handleProgressMessage(msg);
        } catch (err) {
          log("error", "Error handling progress message:", err);
        }
      });
    }
  };

  // =========================
  // Initialization
  // =========================

  const init = () => {
    log("info", `Progress page v${PROGRESS_VERSION} initializing...`);

    if (ui.versionPill) ui.versionPill.textContent = `v${PROGRESS_VERSION}`;

    // align toggle button initial pressed state (your HTML starts aria-pressed="true")
    if (ui.toggleLogs) {
      const pressed = ui.toggleLogs.getAttribute("aria-pressed") === "true";
      state.logsExpanded = pressed; // treat "pressed" as expanded
      if (pressed && ui.details) {
        ui.details.style.maxHeight = "none";
        ui.details.style.overflowY = "visible";
        ui.toggleLogs.textContent = "Collapse";
      } else if (ui.details) {
        ui.details.style.maxHeight = "240px";
        ui.details.style.overflowY = "auto";
        ui.toggleLogs.textContent = "Logs";
      }
    }

    if (!gmailTabId) {
      setStatus("Could not read Gmail tab ID from URL. Close this and try again.");
      appendLog("Missing or invalid gmailTabId in query string.", LOG_LEVELS.ERROR);

      if (ui.cancel) ui.cancel.disabled = true;
      if (ui.reconnect) ui.reconnect.disabled = true;
      if (ui.reinject) ui.reinject.disabled = true;

      showToast("missing gmail tab id", "error");
      return;
    }

    setPhaseTag(PHASES.STARTING);
    setPercent(0);

    setStatusLoading(`Waiting for Gmail tab ${gmailTabId} to send progress…`);
    appendLog(`Connected to Gmail tab ${gmailTabId}`, LOG_LEVELS.INFO);

    wireEventListeners();
    startAutoReconnect();

    log("info", "Progress page ready.");
  };

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
