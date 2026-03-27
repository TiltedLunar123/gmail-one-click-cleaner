// popup.js
document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  // =========================
  // Constants & Configuration
  // =========================

  const POPUP_VERSION = "4.0.0";

  const CONFIG = Object.freeze({
    TOAST_DURATION_MS: 3000,
    BUTTON_SUCCESS_DURATION_MS: 1500,
    STATUS_CLEAR_DELAY_MS: 5000,
    AUTOSAVE_DEBOUNCE_MS: 250,

    GMAIL_URL: "https://mail.google.com/",
    GMAIL_INBOX_URL: "https://mail.google.com/mail/u/0/#inbox",

    RATING_THRESHOLD_RUNS: 2,
    ACTIVE_RUN_TTL_MS: 1000 * 60 * 60 * 2 // 2h best effort TTL
  });

  const STORAGE_KEYS = Object.freeze({
    LAST_CONFIG: "lastConfig",
    DEBUG_MODE: "debugMode",
    WHITELIST: "whitelist",

    TIP_INTENT: "lastTipIntentAt",
    TIP_SOURCE: "lastTipIntentSource",

    PIN_DISMISSED: "pinHintDismissed",

    RUN_COUNT: "runSuccessCount",
    RATING_DISMISSED: "ratingPromptDismissed",

    ACTIVE_RUN: "activeRun" // { gmailTabId, startedAt }
  });

  const BUTTON_STATES = Object.freeze({
    IDLE: "idle",
    LOADING: "loading",
    RUNNING: "running",
    SUCCESS: "success"
  });

  const STATUS_TYPES = Object.freeze({
    INFO: "info",
    SUCCESS: "success",
    WARNING: "warning",
    ERROR: "error",
    RUNNING: "running"
  });

  // =========================
  // State
  // =========================

  const state = {
    isRunning: false,
    currentGmailTabId: null,
    debugMode: false,
    buttonState: BUTTON_STATES.IDLE,

    autosaveTimer: null
  };

  // =========================
  // Utilities
  // =========================

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  const hasChrome = () => {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime;
    } catch {
      return false;
    }
  };

  const hasChromeStorage = (area = "local") => {
    try {
      return hasChrome() && chrome.storage && chrome.storage[area] && typeof chrome.storage[area].get === "function";
    } catch {
      return false;
    }
  };

  const hasChromeTabs = () => {
    try {
      return hasChrome() && !!chrome.tabs;
    } catch {
      return false;
    }
  };

  const hasChromeScripting = () => {
    try {
      return hasChrome() && !!chrome.scripting;
    } catch {
      return false;
    }
  };

  const log = (level, ...args) => {
    const prefix = "[Gmail Cleaner Popup]";
    if (level === "error") console.error(prefix, ...args);
    else if (level === "warn") console.warn(prefix, ...args);
    else if (state.debugMode) console.log(prefix, ...args);
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

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  const formatBytes = (bytes) => {
    const b = Number(bytes || 0);
    if (!Number.isFinite(b) || b <= 0) return "0 MB";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const rounded = i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
    return `${rounded} ${units[i]}`;
  };

  const safeClosePopup = () => {
    try {
      window.close();
    } catch {}
  };

  // =========================
  // Chrome wrappers
  // =========================

  const storageGet = async (area, keys) => {
    if (!hasChromeStorage(area)) return {};
    try {
      return await p(chrome.storage[area].get.bind(chrome.storage[area]), keys);
    } catch (e) {
      log("warn", `storage.${area}.get failed`, e);
      return {};
    }
  };

  const storageSet = async (area, obj) => {
    if (!hasChromeStorage(area)) return;
    try {
      await p(chrome.storage[area].set.bind(chrome.storage[area]), obj);
    } catch (e) {
      log("warn", `storage.${area}.set failed`, e);
    }
  };

  const tabsQuery = async (queryInfo) => {
    if (!hasChromeTabs()) return [];
    try {
      return await p(chrome.tabs.query.bind(chrome.tabs), queryInfo);
    } catch (e) {
      log("error", "tabs.query failed", e);
      return [];
    }
  };

  const tabsCreate = async (createProps) => {
    if (!hasChromeTabs()) return null;
    try {
      return await p(chrome.tabs.create.bind(chrome.tabs), createProps);
    } catch (e) {
      log("error", "tabs.create failed", e);
      return null;
    }
  };

  const tabsUpdate = async (tabId, updateProps) => {
    if (!hasChromeTabs()) return null;
    try {
      return await p(chrome.tabs.update.bind(chrome.tabs), tabId, updateProps);
    } catch (e) {
      log("warn", "tabs.update failed", e);
      return null;
    }
  };

  const tabsSendMessage = async (tabId, message) => {
    if (!hasChromeTabs()) return null;
    try {
      return await p(chrome.tabs.sendMessage.bind(chrome.tabs), tabId, message);
    } catch (e) {
      log("warn", "tabs.sendMessage failed", e);
      throw e;
    }
  };

  const scriptingExecuteScript = async (details) => {
    if (!hasChromeScripting()) throw new Error("Chrome scripting API not available");
    return await p(chrome.scripting.executeScript.bind(chrome.scripting), details);
  };

  // =========================
  // DOM Cache
  // =========================

  const elements = {
    runBtn: $("runCleanup"),
    statusEl: $("status"),
    intensityEl: $("intensity"),
    actionTypeEl: $("actionType"),
    minAgeEl: $("minAge"),

    monthlyCleanBtn: $("monthlyCleanBtn"),

    pinHint: $("pinHint"),
    pinHintClose: $("pinHintClose"),

    dryRunEl: $("dryRun"),
    reviewModeEl: $("reviewMode"),
    safeModeEl: $("safeMode"),
    skipStarredEl: $("skipStarred"),
    skipImportantEl: $("skipImportant"),

    openOptionsBtn: $("openOptions"),
    openDiagnosticsBtn: $("openDiagnostics"),

    progressBar: $("progressBar"),
    progressBarInner: $("progressBarInner"),
    quickActions: $("quickActions"),
    cancelBtn: $("cancelBtn"),
    openProgressBtn: $("openProgressBtn"),

    resultSummary: $("resultSummary"),
    resultCount: $("resultCount"),
    resultSize: $("resultSize"),
    successCtas: $("successCtas"),

    ratingPrompt: $("ratingPrompt"),
    ratingDismiss: $("ratingDismiss"),
    ratingBtn: $("ratingBtn"),

    shareBtn: $("shareBtn"),

    toastContainer: $("toastContainer"),
    accountSelector: $("accountSelector"),
    wlSuggestions: $("wlSuggestions"),
    openStatsBtn: $("openStats")
  };

  const critical = ["runBtn", "statusEl", "intensityEl", "dryRunEl", "safeModeEl"];
  const missing = critical.filter((k) => !elements[k]);
  if (missing.length) {
    console.error("[Gmail Cleaner Popup] Missing critical DOM elements:", missing);
    return;
  }

  const runLabelSpan = elements.runBtn.querySelector(".label");
  const runSubSpan = elements.runBtn.querySelector(".sub");
  const originalLabel = runLabelSpan?.textContent || "Run Cleaner";
  const originalSub = runSubSpan?.textContent || "Items are tagged before action";

  // =========================
  // Toasts
  // =========================

  const TOAST_ICONS = Object.freeze({
    success: "✅",
    error: "❌",
    warning: "⚠️",
    info: "ℹ️"
  });

  const showToast = (message, type = "info", duration = CONFIG.TOAST_DURATION_MS) => {
    const container = elements.toastContainer;
    if (!container) {
      log("warn", `[toast:${type}]`, message);
      return;
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", "alert");

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = TOAST_ICONS[type] || TOAST_ICONS.info;

    const text = document.createElement("span");
    text.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(text);
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("show"));

    window.setTimeout(() => {
      toast.classList.remove("show");
      window.setTimeout(() => toast.remove(), 250);
    }, duration);
  };

  // =========================
  // Status
  // =========================

  let statusClearTimeout = null;

  const setStatus = (message, type = STATUS_TYPES.INFO, autoClear = false) => {
    const el = elements.statusEl;
    if (!el) return;

    if (statusClearTimeout) {
      clearTimeout(statusClearTimeout);
      statusClearTimeout = null;
    }

    el.className = "status";

    if (type === STATUS_TYPES.SUCCESS) el.classList.add("status-success");
    else if (type === STATUS_TYPES.ERROR) el.classList.add("status-error");
    else if (type === STATUS_TYPES.WARNING) el.classList.add("status-warning");
    else if (type === STATUS_TYPES.RUNNING) el.classList.add("status-running");

    el.textContent = message || "";

    if (autoClear && message) {
      statusClearTimeout = setTimeout(() => {
        el.textContent = "";
        el.className = "status";
      }, CONFIG.STATUS_CLEAR_DELAY_MS);
    }
  };

  const resetRunButton = () => {
    elements.runBtn.disabled = false;
    elements.runBtn.classList.remove("loading", "running", "success");
    if (runLabelSpan) runLabelSpan.textContent = originalLabel;
    if (runSubSpan) runSubSpan.textContent = originalSub;
    elements.runBtn.removeAttribute("aria-busy");
    state.buttonState = BUTTON_STATES.IDLE;
  };

  const setRunButtonState = ({ disabled, label, sub, state: btnState }) => {
    const btn = elements.runBtn;
    btn.disabled = Boolean(disabled);

    btn.classList.remove("loading", "running", "success");
    if (btnState && btnState !== BUTTON_STATES.IDLE) btn.classList.add(btnState);
    state.buttonState = btnState || state.buttonState;

    if (typeof label === "string") {
      if (runLabelSpan) runLabelSpan.textContent = label;
      else btn.textContent = label;
    }
    if (typeof sub === "string" && runSubSpan) runSubSpan.textContent = sub;

    if (btnState === BUTTON_STATES.LOADING || btnState === BUTTON_STATES.RUNNING) {
      btn.setAttribute("aria-busy", "true");
    } else {
      btn.removeAttribute("aria-busy");
    }
  };

  const showButtonSuccess = () => {
    setRunButtonState({
      disabled: true,
      label: "started",
      sub: "check the progress tab",
      state: BUTTON_STATES.SUCCESS
    });

    setTimeout(() => {
      resetRunButton();
    }, CONFIG.BUTTON_SUCCESS_DURATION_MS);
  };

  // =========================
  // Progress UI (best effort)
  // =========================

  const showProgress = (percent = 0) => {
    if (!elements.progressBar) return;
    const pcent = clamp(Number(percent || 0), 0, 100);
    elements.progressBar.classList.add("show");
    elements.progressBar.setAttribute("aria-valuenow", String(pcent));
    if (elements.progressBarInner) elements.progressBarInner.style.width = `${pcent}%`;
  };

  const hideProgress = () => {
    if (!elements.progressBar) return;
    elements.progressBar.classList.remove("show");
    if (elements.progressBarInner) elements.progressBarInner.style.width = "0%";
  };

  const updateProgress = (percent) => {
    if (!elements.progressBar) return;
    const pcent = clamp(Number(percent || 0), 0, 100);
    elements.progressBar.setAttribute("aria-valuenow", String(pcent));
    if (elements.progressBarInner) elements.progressBarInner.style.width = `${pcent}%`;
  };

  const showQuickActions = () => {
    if (elements.quickActions) elements.quickActions.classList.add("show");
  };

  const hideQuickActions = () => {
    if (elements.quickActions) elements.quickActions.classList.remove("show");
  };

  const showResultSummary = ({ count = 0, freedBytes = 0, action = "trash" } = {}) => {
    if (!elements.resultSummary) return;
    if (elements.resultCount) elements.resultCount.textContent = String(Math.max(0, Number(count || 0)));
    if (elements.resultSize) elements.resultSize.textContent = formatBytes(freedBytes);
    const note = elements.resultSummary.querySelector("span[style]");
    if (note) note.textContent = action === "archive" ? "(all archived to All Mail)" : "(all moved to Trash)";
    elements.resultSummary.classList.add("show");
  };

  const hideResultSummary = () => {
    elements.resultSummary?.classList.remove("show");
  };

  const showSuccessCtas = () => elements.successCtas?.classList.add("show");
  const hideSuccessCtas = () => elements.successCtas?.classList.remove("show");

  // =========================
  // Accessibility helpers
  // =========================

  const syncSwitchAria = (inputEl) => {
    if (!inputEl) return;
    if (inputEl.getAttribute("role") === "switch") {
      inputEl.setAttribute("aria-checked", String(!!inputEl.checked));
    }
  };

  // =========================
  // Storage helpers
  // =========================

  const getDebugModeSetting = async () => {
    const r = await storageGet("sync", STORAGE_KEYS.DEBUG_MODE);
    return Boolean(r?.[STORAGE_KEYS.DEBUG_MODE]);
  };

  const getWhitelist = async () => {
    const r = await storageGet("sync", STORAGE_KEYS.WHITELIST);
    const wl = r?.[STORAGE_KEYS.WHITELIST];
    return Array.isArray(wl) ? wl : [];
  };

  const persistLastConfig = async (config) => {
    await storageSet("session", { [STORAGE_KEYS.LAST_CONFIG]: config });
    await storageSet("local", { [STORAGE_KEYS.LAST_CONFIG]: config });
  };

  const restoreLastConfig = async () => {
    let cfg = null;

    const s = await storageGet("session", STORAGE_KEYS.LAST_CONFIG);
    cfg = s?.[STORAGE_KEYS.LAST_CONFIG] || null;

    if (!cfg) {
      const l = await storageGet("local", STORAGE_KEYS.LAST_CONFIG);
      cfg = l?.[STORAGE_KEYS.LAST_CONFIG] || null;
    }

    if (!cfg || typeof cfg !== "object") return;

    if (cfg.intensity && elements.intensityEl) {
      const v =
        cfg.intensity === "light" && elements.intensityEl.querySelector('option[value="monthly"]')
          ? "monthly"
          : cfg.intensity;
      if (elements.intensityEl.querySelector(`option[value="${v}"]`)) elements.intensityEl.value = v;
    }

    if (elements.actionTypeEl) {
      elements.actionTypeEl.value = cfg.archiveInsteadOfDelete ? "archive" : "trash";
    }

    if (elements.minAgeEl) {
      const v = cfg.minAge || "";
      if (elements.minAgeEl.querySelector(`option[value="${v}"]`)) elements.minAgeEl.value = v;
      else elements.minAgeEl.value = "";
    }

    if (typeof cfg.dryRun === "boolean" && elements.dryRunEl) elements.dryRunEl.checked = cfg.dryRun;
    if (typeof cfg.reviewMode === "boolean" && elements.reviewModeEl) elements.reviewModeEl.checked = cfg.reviewMode;
    if (typeof cfg.safeMode === "boolean" && elements.safeModeEl) elements.safeModeEl.checked = cfg.safeMode;

    if (typeof cfg.guardSkipStarred === "boolean" && elements.skipStarredEl) elements.skipStarredEl.checked = cfg.guardSkipStarred;
    if (typeof cfg.guardSkipImportant === "boolean" && elements.skipImportantEl) elements.skipImportantEl.checked = cfg.guardSkipImportant;

    // keep aria-checked accurate
    syncSwitchAria(elements.dryRunEl);
    syncSwitchAria(elements.reviewModeEl);
    syncSwitchAria(elements.safeModeEl);
    syncSwitchAria(elements.skipStarredEl);
    syncSwitchAria(elements.skipImportantEl);
  };

  const setActiveRun = async (gmailTabId) => {
    const payload = { gmailTabId, startedAt: Date.now() };
    await storageSet("session", { [STORAGE_KEYS.ACTIVE_RUN]: payload });
    await storageSet("local", { [STORAGE_KEYS.ACTIVE_RUN]: payload });
  };

  const clearActiveRun = async () => {
    await storageSet("session", { [STORAGE_KEYS.ACTIVE_RUN]: null });
    await storageSet("local", { [STORAGE_KEYS.ACTIVE_RUN]: null });
  };

  const getActiveRun = async () => {
    const s = await storageGet("session", STORAGE_KEYS.ACTIVE_RUN);
    let run = s?.[STORAGE_KEYS.ACTIVE_RUN] || null;

    if (!run) {
      const l = await storageGet("local", STORAGE_KEYS.ACTIVE_RUN);
      run = l?.[STORAGE_KEYS.ACTIVE_RUN] || null;
    }

    if (!run || typeof run !== "object") return null;
    if (!run.gmailTabId || !run.startedAt) return null;

    if (Date.now() - run.startedAt > CONFIG.ACTIVE_RUN_TTL_MS) {
      await clearActiveRun();
      return null;
    }
    return run;
  };

  const scheduleAutosave = () => {
    if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(async () => {
      try {
        const cfg = await buildConfig();
        await persistLastConfig(cfg);
        log("info", "autosaved config");
      } catch (e) {
        log("warn", "autosave failed", e);
      }
    }, CONFIG.AUTOSAVE_DEBOUNCE_MS);
  };

  // =========================
  // Gmail tab management
  // =========================

  const findGmailTab = async () => {
    if (!hasChromeTabs()) return null;

    // Multi-account: if user selected a specific tab, use it
    if (state.currentGmailTabId) {
      try {
        const tabs = await tabsQuery({ url: `${CONFIG.GMAIL_URL}*` });
        const selected = tabs.find(t => t.id === state.currentGmailTabId);
        if (selected) return selected;
      } catch {}
    }

    const active = await tabsQuery({ active: true, currentWindow: true });
    const activeTab = active?.[0];
    if (activeTab?.url?.startsWith(CONFIG.GMAIL_URL)) return activeTab;

    const cur = await tabsQuery({ url: `${CONFIG.GMAIL_URL}*`, currentWindow: true });
    if (cur?.length) return cur.find((t) => t.active) || cur[0];

    const all = await tabsQuery({ url: `${CONFIG.GMAIL_URL}*` });
    if (all?.length) return all.find((t) => t.active) || all[0];

    return null;
  };

  // =========================
  // Multi-Account Support
  // =========================

  const loadGmailAccounts = async () => {
    if (!hasChrome() || !chrome.runtime?.sendMessage) return;
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "gmailCleanerListGmailTabs" }, resolve);
      });
      const tabs = resp?.tabs || [];
      if (tabs.length <= 1 || !elements.accountSelector) return;

      elements.accountSelector.style.display = "flex";
      elements.accountSelector.textContent = "";

      tabs.forEach((tab, idx) => {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "account-pill" + (idx === 0 ? " active" : "");
        pill.textContent = tab.title ? tab.title.replace(/ - Gmail.*$/, "").slice(0, 25) : "Account " + tab.account;
        pill.dataset.tabId = tab.id;
        pill.addEventListener("click", () => {
          elements.accountSelector.querySelectorAll(".account-pill").forEach(p => p.classList.remove("active"));
          pill.classList.add("active");
          state.currentGmailTabId = tab.id;
        });
        elements.accountSelector.appendChild(pill);
      });
    } catch (e) {
      log("warn", "loadGmailAccounts failed", e);
    }
  };

  // =========================
  // Whitelist Suggestions
  // =========================

  const loadWhitelistSuggestions = async () => {
    if (!hasChrome() || !chrome.runtime?.sendMessage || !elements.wlSuggestions) return;
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "gmailCleanerGetWhitelistSuggestions" }, resolve);
      });
      const suggestions = resp?.suggestions || [];
      if (suggestions.length === 0) return;

      const currentWhitelist = await getWhitelist();

      const filtered = suggestions.filter(s => !currentWhitelist.includes(s.sender));
      if (filtered.length === 0) return;

      elements.wlSuggestions.style.display = "flex";
      elements.wlSuggestions.textContent = "";

      const label = document.createElement("span");
      label.style.fontSize = "10px";
      label.style.color = "#64748b";
      label.style.marginRight = "4px";
      label.textContent = "Protect:";
      elements.wlSuggestions.appendChild(label);

      filtered.slice(0, 5).forEach(s => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "wl-suggest-chip";
        chip.textContent = "+ " + s.sender;
        chip.title = "Add to whitelist (opens: " + s.opens + ", replies: " + s.replies + ")";
        chip.addEventListener("click", async () => {
          const wl = await getWhitelist();
          if (!wl.includes(s.sender)) {
            wl.push(s.sender);
            await storageSet("sync", { whitelist: wl });
            showToast("added " + s.sender + " to whitelist", "success");
            chip.remove();
          }
        });
        elements.wlSuggestions.appendChild(chip);
      });
    } catch (e) {
      log("warn", "loadWhitelistSuggestions failed", e);
    }
  };

  const showOpenGmailHelper = () => {
    setStatus("open gmail first, then try again", STATUS_TYPES.WARNING);

    const existing = elements.statusEl.querySelector(".open-gmail-helper");
    if (existing) return;

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "open-gmail-helper quick-action-btn";
    openBtn.textContent = "open gmail";
    openBtn.style.marginTop = "8px";

    openBtn.addEventListener("click", async () => {
      const existingGmail = await findGmailTab();
      if (existingGmail?.id) {
        await tabsUpdate(existingGmail.id, { active: true });
        showToast("switching to gmail…", "info");
        setTimeout(safeClosePopup, 150);
        return;
      }

      await tabsCreate({ url: CONFIG.GMAIL_INBOX_URL, active: true });
      showToast("opening gmail…", "info");
      setTimeout(safeClosePopup, 150);
    });

    elements.statusEl.appendChild(openBtn);
  };

  const removeOpenGmailHelper = () => {
    elements.statusEl?.querySelector(".open-gmail-helper")?.remove();
  };

  const findProgressTab = async (gmailTabId) => {
    if (!hasChromeTabs() || !hasChrome()) return null;
    try {
      const base = chrome.runtime.getURL("progress.html");
      const tabs = await tabsQuery({ url: `${base}*` });
      for (const t of tabs || []) {
        if (!t?.url) continue;
        try {
          const u = new URL(t.url);
          const id = u.searchParams.get("gmailTabId");
          if (String(id) === String(gmailTabId)) return t;
        } catch {}
      }
    } catch (e) {
      log("warn", "findProgressTab failed", e);
    }
    return null;
  };

  // =========================
  // Features: Monthly preset, pin hint, rating
  // =========================

  const handleMonthlyClean = async () => {
    if (elements.intensityEl) {
      const hasMonthly = !!elements.intensityEl.querySelector('option[value="monthly"]');
      elements.intensityEl.value = hasMonthly ? "monthly" : "light";
    }
    if (elements.actionTypeEl) elements.actionTypeEl.value = "trash";
    if (elements.minAgeEl) elements.minAgeEl.value = "3m";
    if (elements.safeModeEl) elements.safeModeEl.checked = true;

    syncSwitchAria(elements.safeModeEl);

    showToast("monthly preset applied", "success");
    elements.runBtn.focus();
    try {
      elements.runBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {}

    scheduleAutosave();
  };

  const checkPinHint = async () => {
    if (!elements.pinHint) return;
    const r = await storageGet("local", STORAGE_KEYS.PIN_DISMISSED);
    if (!r?.[STORAGE_KEYS.PIN_DISMISSED]) elements.pinHint.classList.add("show");
  };

  const dismissPinHint = async () => {
    elements.pinHint?.classList.remove("show");
    await storageSet("local", { [STORAGE_KEYS.PIN_DISMISSED]: true });
  };

  const maybeShowRatingPrompt = async () => {
    if (!elements.ratingPrompt) return;
    const r = await storageGet("local", [STORAGE_KEYS.RUN_COUNT, STORAGE_KEYS.RATING_DISMISSED]);
    const dismissed = Boolean(r?.[STORAGE_KEYS.RATING_DISMISSED]);
    const count = Number(r?.[STORAGE_KEYS.RUN_COUNT] || 0);

    if (!dismissed && count >= CONFIG.RATING_THRESHOLD_RUNS) {
      elements.ratingPrompt.classList.add("show");
    }
  };

  const dismissRatingPrompt = async () => {
    elements.ratingPrompt?.classList.remove("show");
    await storageSet("local", { [STORAGE_KEYS.RATING_DISMISSED]: true });
  };

  const bumpRunCount = async () => {
    const r = await storageGet("local", STORAGE_KEYS.RUN_COUNT);
    const count = Number(r?.[STORAGE_KEYS.RUN_COUNT] || 0) + 1;
    await storageSet("local", { [STORAGE_KEYS.RUN_COUNT]: count });
  };

  // =========================
  // Build config
  // =========================

  const buildConfig = async () => {
    const whitelist = await getWhitelist();

    let intensity = elements.intensityEl?.value || "normal";
    if (intensity === "monthly") intensity = "light";

    return {
      intensity,
      dryRun: Boolean(elements.dryRunEl?.checked),
      safeMode: Boolean(elements.safeModeEl?.checked),
      archiveInsteadOfDelete: elements.actionTypeEl?.value === "archive",
      minAge: elements.minAgeEl?.value || null,
      guardSkipStarred: elements.skipStarredEl?.checked ?? true,
      guardSkipImportant: elements.skipImportantEl?.checked ?? true,
      reviewMode: Boolean(elements.reviewModeEl?.checked),
      whitelist,
      debugMode: Boolean(state.debugMode),
      version: POPUP_VERSION
    };
  };

  // =========================
  // Run cleanup
  // =========================

  const runCleanup = async () => {
    if (state.isRunning) return;

    // Warn on deep intensity
    const intensity = elements.intensityEl?.value || "normal";
    if (intensity === "deep" && !elements.dryRunEl?.checked) {
      const confirmed = confirm(
        "Deep intensity is aggressive and will target many categories.\n\n" +
        "Consider using Dry Run first to preview what would be cleaned.\n\n" +
        "Continue with deep cleanup?"
      );
      if (!confirmed) return;
    }

    state.isRunning = true;
    removeOpenGmailHelper();
    hideResultSummary();
    hideSuccessCtas();

    setRunButtonState({
      disabled: true,
      label: "starting…",
      sub: "finding gmail tab",
      state: BUTTON_STATES.LOADING
    });
    setStatus("finding a gmail tab…", STATUS_TYPES.RUNNING);
    showProgress(10);

    try {
      const gmailTab = await findGmailTab();
      if (!gmailTab?.id) {
        showOpenGmailHelper();
        resetRunButton();
        hideProgress();
        state.isRunning = false;
        return;
      }

      state.currentGmailTabId = gmailTab.id;
      showQuickActions();
      updateProgress(30);

      const config = await buildConfig();
      await persistLastConfig(config);

      const destination = config.archiveInsteadOfDelete ? "all mail" : "trash";
      const modeLabel = config.dryRun ? "dry-run" : "live";

      setRunButtonState({
        disabled: true,
        label: config.dryRun ? "dry-run…" : "running…",
        sub: config.dryRun ? "counting matches" : `tagging then moving to ${destination}`,
        state: BUTTON_STATES.RUNNING
      });

      setStatus(`${modeLabel} started, opening progress…`, STATUS_TYPES.RUNNING);
      updateProgress(55);

      // Open progress page first (popup usually closes after this)
      const progressUrl = chrome.runtime.getURL(`progress.html?gmailTabId=${gmailTab.id}`);

      // If a progress tab already exists for this Gmail tab, reuse it
      const existingProgress = await findProgressTab(gmailTab.id);
      if (existingProgress?.id) await tabsUpdate(existingProgress.id, { active: true });
      else await tabsCreate({ url: progressUrl, active: true });

      // Inject config + content script into Gmail tab
      updateProgress(75);

      await scriptingExecuteScript({
        target: { tabId: gmailTab.id },
        func: (cfg) => {
          window.GMAIL_CLEANER_CONFIG = cfg;
        },
        args: [config]
      });

      await scriptingExecuteScript({
        target: { tabId: gmailTab.id },
        files: ["contentScript.js"]
      });

      await setActiveRun(gmailTab.id);

      // "Successful start" counter (best effort)
      await bumpRunCount();

      updateProgress(100);
      showButtonSuccess();
      showToast("cleanup started", "success");

      setTimeout(safeClosePopup, 200);
    } catch (err) {
      const msg = err?.message || String(err);
      log("error", "runCleanup error:", err);

      setStatus(`error: ${msg}`, STATUS_TYPES.ERROR);
      showToast(`failed: ${msg}`, "error");

      resetRunButton();
      hideProgress();
      hideQuickActions();

      state.isRunning = false;
      state.currentGmailTabId = null;
      await clearActiveRun();
    }
  };

  // =========================
  // Quick actions
  // =========================

  const handleCancel = async () => {
    const tabId = state.currentGmailTabId;
    if (!tabId) {
      showToast("no active cleanup found", "warning");
      return;
    }

    try {
      await tabsSendMessage(tabId, { type: "gmailCleanerCancel" });
      showToast("cancel sent", "info");
      setStatus("cancel requested", STATUS_TYPES.WARNING, true);
      await clearActiveRun();
      hideQuickActions();
      resetRunButton();
      state.isRunning = false;
      state.currentGmailTabId = null;
      hideProgress();
    } catch {
      showToast("could not cancel (is gmail tab still open?)", "warning");
    }
  };

  const handleOpenProgress = async () => {
    const tabId = state.currentGmailTabId;
    if (!tabId) {
      showToast("no active cleanup", "warning");
      return;
    }

    const existing = await findProgressTab(tabId);
    if (existing?.id) {
      await tabsUpdate(existing.id, { active: true });
      setTimeout(safeClosePopup, 150);
      return;
    }

    const progressUrl = chrome.runtime.getURL(`progress.html?gmailTabId=${tabId}`);
    await tabsCreate({ url: progressUrl, active: true });
    setTimeout(safeClosePopup, 150);
  };

  // =========================
  // Navigation
  // =========================

  const openOptions = async () => {
    try {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else await tabsCreate({ url: chrome.runtime.getURL("options.html") });
      setTimeout(safeClosePopup, 150);
    } catch (e) {
      log("error", "openOptions failed", e);
      showToast("failed to open rules", "error");
    }
  };

  const openDiagnostics = async () => {
    try {
      await tabsCreate({ url: chrome.runtime.getURL("diagnostics.html") });
      setTimeout(safeClosePopup, 150);
    } catch (e) {
      log("error", "openDiagnostics failed", e);
      showToast("failed to open diagnostics", "error");
    }
  };

  const openStats = async () => {
    try {
      await tabsCreate({ url: chrome.runtime.getURL("stats.html") });
      setTimeout(safeClosePopup, 150);
    } catch (e) {
      log("error", "openStats failed", e);
      showToast("failed to open stats", "error");
    }
  };

  // =========================
  // Tip links + Share
  // =========================

  const setupTipLinks = () => {
    const tipLinks = $$('a[href*="buymeacoffee.com"], a[href*="cash.app"]');
    tipLinks.forEach((link) => {
      link.addEventListener("click", async (e) => {
        e.preventDefault();

        const url = link.href;
        const source = url.includes("buymeacoffee.com") ? "buymeacoffee" : "cashapp";

        await tabsCreate({ url, active: true });
        await storageSet("local", {
          [STORAGE_KEYS.TIP_INTENT]: Date.now(),
          [STORAGE_KEYS.TIP_SOURCE]: source
        });

        setTimeout(safeClosePopup, 150);
      });
    });
  };

  const setupShare = () => {
    if (!elements.shareBtn) return;
    elements.shareBtn.addEventListener("click", async () => {
      const url = "https://chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc?utm_source=share";
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          showToast("link copied", "success");
        } else {
          await tabsCreate({ url, active: true });
          showToast("opened share link", "info");
        }
      } catch {
        await tabsCreate({ url, active: true });
        showToast("opened share link", "info");
      }
    });
  };

  // =========================
  // Keyboard
  // =========================

  const setupKeyboardShortcuts = () => {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") safeClosePopup();

      // Enter runs cleaner (but not while a select is focused)
      if (e.key === "Enter" && !e.repeat) {
        const tag = document.activeElement?.tagName;
        const isFormControl = tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA";
        if (!isFormControl && !state.isRunning) {
          e.preventDefault();
          runCleanup();
        }
      }

      // Ctrl/Cmd + D toggles dry run
      if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (elements.dryRunEl) {
          elements.dryRunEl.checked = !elements.dryRunEl.checked;
          syncSwitchAria(elements.dryRunEl);
          showToast(`dry run ${elements.dryRunEl.checked ? "on" : "off"}`, "info");
          scheduleAutosave();
        }
      }
    });
  };

  // =========================
  // Runtime message hook (optional, best effort)
  // =========================

  const setupRuntimeMessages = () => {
    if (!hasChrome() || !chrome.runtime?.onMessage?.addListener) return;

    chrome.runtime.onMessage.addListener((msg) => {
      try {
        if (!msg || typeof msg !== "object") return;

        // Expecting optional message shapes from contentScript/progress page:
        // { type: "gmailCleanerProgress", percent, message }
        // { type: "gmailCleanerDone", count, freedBytes, action }
        // { type: "gmailCleanerError", message }
        // { type: "gmailCleanerCanceled" }
        if (msg.type === "gmailCleanerProgress") {
          const pct = clamp(Number(msg.percent ?? 0), 0, 100);
          showProgress(pct);
          updateProgress(pct);
          if (msg.message) setStatus(String(msg.message), STATUS_TYPES.RUNNING);
          return;
        }

        if (msg.type === "gmailCleanerDone") {
          hideProgress();
          hideQuickActions();
          resetRunButton();

          const action = msg.action === "archive" ? "archive" : "trash";
          showResultSummary({
            count: Number(msg.count || 0),
            freedBytes: Number(msg.freedBytes || 0),
            action
          });

          showSuccessCtas();
          setStatus("cleanup complete", STATUS_TYPES.SUCCESS, true);

          state.isRunning = false;
          state.currentGmailTabId = null;
          clearActiveRun().catch(() => {});
          return;
        }

        if (msg.type === "gmailCleanerCanceled") {
          hideProgress();
          hideQuickActions();
          resetRunButton();
          setStatus("canceled", STATUS_TYPES.WARNING, true);
          state.isRunning = false;
          state.currentGmailTabId = null;
          clearActiveRun().catch(() => {});
          return;
        }

        if (msg.type === "gmailCleanerError") {
          const m = msg.message ? String(msg.message) : "unknown error";
          hideProgress();
          hideQuickActions();
          resetRunButton();
          setStatus(`error: ${m}`, STATUS_TYPES.ERROR);
          showToast(`failed: ${m}`, "error");
          state.isRunning = false;
          state.currentGmailTabId = null;
          clearActiveRun().catch(() => {});
        }
      } catch (e) {
        log("warn", "onMessage handler failed", e);
      }
    });
  };

  // =========================
  // Init
  // =========================

  const restoreActiveRunUI = async () => {
    const run = await getActiveRun();
    if (!run) return;

    state.currentGmailTabId = run.gmailTabId;
    showQuickActions();
    setStatus("looks like a cleanup is already running", STATUS_TYPES.RUNNING);
    showProgress(35);

    showToast("active cleanup detected", "info", 2000);

    // keep progress visible for a beat, then hide (UI is best effort anyway)
    setTimeout(() => hideProgress(), 800);
  };

  const wireAutosave = () => {
    const watch = [
      elements.intensityEl,
      elements.actionTypeEl,
      elements.minAgeEl,
      elements.dryRunEl,
      elements.reviewModeEl,
      elements.safeModeEl,
      elements.skipStarredEl,
      elements.skipImportantEl
    ].filter(Boolean);

    watch.forEach((el) => {
      el.addEventListener("change", () => {
        syncSwitchAria(el);
        scheduleAutosave();
      });
    });
  };

  const setupEventListeners = () => {
    elements.runBtn.addEventListener("click", runCleanup);

    elements.monthlyCleanBtn?.addEventListener("click", handleMonthlyClean);

    elements.pinHintClose?.addEventListener("click", dismissPinHint);

    elements.ratingBtn?.addEventListener("click", dismissRatingPrompt);
    elements.ratingDismiss?.addEventListener("click", dismissRatingPrompt);

    // Make star row clickable + keyboard-accessible (optional)
    const stars = $$(".rating-star");
    const activateStar = () => {
      try {
        elements.ratingBtn?.click();
      } catch {}
    };
    stars.forEach((s) => {
      s.addEventListener("click", activateStar);
      s.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activateStar();
        }
      });
    });

    elements.cancelBtn?.addEventListener("click", handleCancel);
    elements.openProgressBtn?.addEventListener("click", handleOpenProgress);

    elements.openOptionsBtn?.addEventListener("click", openOptions);
    elements.openDiagnosticsBtn?.addEventListener("click", openDiagnostics);
    elements.openStatsBtn?.addEventListener("click", openStats);

    setupTipLinks();
    setupShare();
    setupKeyboardShortcuts();
    setupRuntimeMessages();
    wireAutosave();
  };

  const init = async () => {
    state.debugMode = await getDebugModeSetting();
    log("info", `init v${POPUP_VERSION}`);

    setupEventListeners();

    await checkPinHint();
    await restoreLastConfig();
    await restoreActiveRunUI();
    await maybeShowRatingPrompt();

    loadGmailAccounts();
    loadWhitelistSuggestions();

    log("info", "ready");
  };

  init().catch((e) => {
    console.error("[Gmail Cleaner Popup] init failed:", e);
    setStatus("init error", STATUS_TYPES.ERROR);
  });
});
