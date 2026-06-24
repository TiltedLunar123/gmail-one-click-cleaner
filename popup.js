// popup.js
document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  // =========================
  // Constants & Configuration
  // =========================

  const POPUP_VERSION = "6.1.0";

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
    LAST_UI: "lastUiSnapshot",
    DEBUG_MODE: "debugMode",
    WHITELIST: "whitelist",
    PROTECT_KEYWORDS: "protectKeywords",

    TIP_INTENT: "lastTipIntentAt",
    TIP_SOURCE: "lastTipIntentSource",

    PIN_DISMISSED: "pinHintDismissed",
    ONBOARDED: "onboardedAt",

    RUN_COUNT: "runSuccessCount",
    RATING_DISMISSED: "ratingPromptDismissed",

    SNOOZE_UNTIL: "snoozeUntil",
    NOTIFY_ENABLED: "notifyOnComplete",

    ACTIVE_RUN: "activeRun" // { gmailTabId, runId, startedAt }
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

    autosaveTimer: null,

    // 6.0 focused "target" presets: a one-off rule set for the next run.
    // Transient (not persisted) -- cleared when the user touches the
    // intensity dropdown, since that means "use the full rule set".
    rulesOverride: null,
    activePreset: null
  };

  // 6.0: one-click category targets. Each runs a small, safe rule set
  // (all age-guarded) instead of the full intensity sweep. The engine
  // still applies global guards (min age, whitelist, skip starred, etc.).
  const TARGET_PRESETS = Object.freeze({
    promotions: {
      label: "Promotions",
      rules: ["category:promotions older_than:3m", "\"unsubscribe\" older_than:6m"]
    },
    attachments: {
      label: "Big attachments",
      rules: ["larger:10M", "has:attachment larger:5M older_than:1y"]
    },
    social: {
      label: "Social & updates",
      rules: [
        "category:social older_than:6m",
        "category:updates older_than:6m",
        "category:forums older_than:6m"
      ]
    },
    noreply: {
      label: "No-reply & newsletters",
      rules: [
        "has:newsletter older_than:6m",
        "from:(no-reply@ OR donotreply@ OR \"do-not-reply\") older_than:6m"
      ]
    }
  });

  // =========================
  // Utilities (delegating to GCC shared)
  // =========================

  const $ = GCC.$;
  const $$ = GCC.$$;

  const log = (level, ...args) => {
    const prefix = "[Gmail Cleaner Popup]";
    if (level === "error") console.error(prefix, ...args);
    else if (level === "warn") console.warn(prefix, ...args);
    else if (state.debugMode) console.log(prefix, ...args);
  };

  const safeClosePopup = () => {
    try {
      window.close();
    } catch {
      // Expected: window.close() can fail in some browser contexts
    }
  };

  // =========================
  // Chrome wrappers (with popup-specific logging)
  // =========================

  const storageGet = async (area, keys) => {
    if (!GCC.hasChromeStorage(area)) return {};
    try {
      return await GCC.promisify(chrome.storage[area].get.bind(chrome.storage[area]), keys);
    } catch (e) {
      log("warn", `storage.${area}.get failed`, e);
      return {};
    }
  };

  const storageSet = async (area, obj) => {
    if (!GCC.hasChromeStorage(area)) return;
    try {
      await GCC.promisify(chrome.storage[area].set.bind(chrome.storage[area]), obj);
    } catch (e) {
      log("warn", `storage.${area}.set failed`, e);
    }
  };

  const tabsQuery = async (queryInfo) => {
    if (!GCC.hasChromeTabs()) return [];
    try {
      return await GCC.promisify(chrome.tabs.query.bind(chrome.tabs), queryInfo);
    } catch (e) {
      log("error", "tabs.query failed", e);
      return [];
    }
  };

  const tabsCreate = async (createProps) => {
    if (!GCC.hasChromeTabs()) return null;
    try {
      return await GCC.promisify(chrome.tabs.create.bind(chrome.tabs), createProps);
    } catch (e) {
      log("error", "tabs.create failed", e);
      return null;
    }
  };

  const tabsUpdate = async (tabId, updateProps) => {
    if (!GCC.hasChromeTabs()) return null;
    try {
      return await GCC.promisify(chrome.tabs.update.bind(chrome.tabs), tabId, updateProps);
    } catch (e) {
      log("warn", "tabs.update failed", e);
      return null;
    }
  };

  // Throws on any failure; callers should use GCC.classifyChromeError to
  // tell "tab closed" (recoverable) apart from permission/SW errors
  // (user-actionable). Issue #19.
  const tabsSendMessage = async (tabId, message) => {
    if (!GCC.hasChromeTabs()) {
      const e = new Error("chrome.tabs unavailable");
      e.gccKind = "no_chrome";
      throw e;
    }
    try {
      return await GCC.promisify(chrome.tabs.sendMessage.bind(chrome.tabs), tabId, message);
    } catch (e) {
      const cls = GCC.classifyChromeError(e);
      log("warn", "tabs.sendMessage failed", { kind: cls.kind, msg: cls.message });
      const wrapped = e instanceof Error ? e : new Error(String(e));
      wrapped.gccKind = cls.kind;
      throw wrapped;
    }
  };

  const scriptingExecuteScript = async (details) => {
    if (!GCC.hasChromeScripting()) throw new Error("Chrome scripting API not available");
    return await GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), details);
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
    targetChips: $("targetChips"),

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
    openStatsBtn: $("openStats"),

    // 5.0
    themeSwitcher: $("themeSwitcher"),
    snoozeBanner: $("snoozeBanner"),
    snoozeBannerText: $("snoozeBannerText"),
    kbdHelpBtn: $("kbdHelpBtn"),
    kbdHelp: $("keyboardHelp"),
    kbdHelpClose: $("kbdHelpClose"),
    onboardingBackdrop: $("onboardingBackdrop"),
    onbNextBtn: $("onbNextBtn"),
    onbSkipBtn: $("onbSkipBtn")
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
  // Toasts (delegating to GCC.showToast with popup's container)
  // =========================

  const showToast = (message, type = "info", duration = CONFIG.TOAST_DURATION_MS) => {
    const container = elements.toastContainer;
    if (!container) {
      log("warn", `[toast:${type}]`, message);
      return null;
    }
    return GCC.showToast(message, type, duration, container);
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
    const pcent = GCC.clamp(Number(percent || 0), 0, 100);
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
    const pcent = GCC.clamp(Number(percent || 0), 0, 100);
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
    if (elements.resultSize) elements.resultSize.textContent = GCC.formatBytes(freedBytes);
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

  // 6.1: global protected keywords (subject shield). Sanitized here via
  // the shared helper so the engine always receives a clean list.
  const getProtectKeywords = async () => {
    const r = await storageGet("sync", STORAGE_KEYS.PROTECT_KEYWORDS);
    return GCC.sanitizeProtectKeywords(r?.[STORAGE_KEYS.PROTECT_KEYWORDS]);
  };

  // We persist the raw UI snapshot (preserves "monthly" as the user
  // picked it) AND the engine-normalised config (legacy callers and
  // diagnostics). On restore we read the UI snapshot directly, which
  // removes the dead monthly back-mapping branch from issue #22.
  const captureUiSnapshot = () => ({
    intensity: elements.intensityEl?.value || "normal",
    actionType: elements.actionTypeEl?.value || "trash",
    minAge: elements.minAgeEl?.value || "",
    dryRun: Boolean(elements.dryRunEl?.checked),
    reviewMode: Boolean(elements.reviewModeEl?.checked),
    safeMode: Boolean(elements.safeModeEl?.checked),
    guardSkipStarred: Boolean(elements.skipStarredEl?.checked),
    guardSkipImportant: Boolean(elements.skipImportantEl?.checked)
  });

  const persistLastConfig = async (config) => {
    const ui = captureUiSnapshot();
    await storageSet("session", { [STORAGE_KEYS.LAST_CONFIG]: config, [STORAGE_KEYS.LAST_UI]: ui });
    await storageSet("local", { [STORAGE_KEYS.LAST_CONFIG]: config, [STORAGE_KEYS.LAST_UI]: ui });
  };

  const setSelectIfHasValue = (el, val) => {
    if (!el || typeof val !== "string") return;
    const escaped = val.replace(/"/g, '\\"');
    if (el.querySelector(`option[value="${escaped}"]`)) el.value = val;
  };

  const restoreLastConfig = async () => {
    let ui = null;

    const s = await storageGet("session", STORAGE_KEYS.LAST_UI);
    ui = s?.[STORAGE_KEYS.LAST_UI] || null;

    if (!ui) {
      const l = await storageGet("local", STORAGE_KEYS.LAST_UI);
      ui = l?.[STORAGE_KEYS.LAST_UI] || null;
    }

    // Fallback: migrate from pre-5.0 lastConfig if no UI snapshot exists.
    if (!ui) {
      const legacy = (await storageGet("session", STORAGE_KEYS.LAST_CONFIG))?.[STORAGE_KEYS.LAST_CONFIG]
        || (await storageGet("local", STORAGE_KEYS.LAST_CONFIG))?.[STORAGE_KEYS.LAST_CONFIG]
        || null;
      if (legacy && typeof legacy === "object") {
        ui = {
          intensity: legacy.intensity || "normal",
          actionType: legacy.archiveInsteadOfDelete ? "archive" : "trash",
          minAge: legacy.minAge || "",
          dryRun: Boolean(legacy.dryRun),
          reviewMode: Boolean(legacy.reviewMode),
          safeMode: Boolean(legacy.safeMode),
          guardSkipStarred: legacy.guardSkipStarred !== false,
          guardSkipImportant: legacy.guardSkipImportant !== false
        };
      }
    }

    if (!ui || typeof ui !== "object") return;

    setSelectIfHasValue(elements.intensityEl, ui.intensity);
    setSelectIfHasValue(elements.actionTypeEl, ui.actionType);
    setSelectIfHasValue(elements.minAgeEl, ui.minAge);

    if (elements.dryRunEl) elements.dryRunEl.checked = Boolean(ui.dryRun);
    if (elements.reviewModeEl) elements.reviewModeEl.checked = Boolean(ui.reviewMode);
    if (elements.safeModeEl) elements.safeModeEl.checked = Boolean(ui.safeMode);
    if (elements.skipStarredEl) elements.skipStarredEl.checked = Boolean(ui.guardSkipStarred);
    if (elements.skipImportantEl) elements.skipImportantEl.checked = Boolean(ui.guardSkipImportant);

    [elements.dryRunEl, elements.reviewModeEl, elements.safeModeEl,
     elements.skipStarredEl, elements.skipImportantEl].forEach(syncSwitchAria);
  };

  const setActiveRun = async (gmailTabId, runId) => {
    const payload = { gmailTabId, runId: runId || generateRunId(), startedAt: Date.now() };
    await storageSet("session", { [STORAGE_KEYS.ACTIVE_RUN]: payload });
    await storageSet("local", { [STORAGE_KEYS.ACTIVE_RUN]: payload });
    return payload;
  };

  const generateRunId = () => {
    try {
      if (crypto?.randomUUID) return crypto.randomUUID();
    } catch {}
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  };

  // Best-effort atomic claim: read+write the marker, then re-read after a
  // micro-pause and confirm our runId is still present. If two popups
  // claim simultaneously the second write wins and the loser sees
  // someone else's runId, aborting cleanly. Fully atomic CAS isn't
  // available in chrome.storage, but this closes the practical race
  // window from issue #20.
  const tryClaimRun = async (gmailTabId) => {
    const existing = await getActiveRun();
    if (existing) return { ok: false, reason: "already_active", existing };
    const claim = await setActiveRun(gmailTabId);
    await new Promise((r) => setTimeout(r, 40));
    const verify = await getActiveRun();
    if (!verify || verify.runId !== claim.runId) {
      return { ok: false, reason: "lost_race", existing: verify };
    }
    return { ok: true, claim };
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

  // Snooze / vacation mode: while a future timestamp lives in storage we
  // surface a banner in the popup. Schedules read the same key and skip
  // their alarm callback if it's set.
  const getSnoozeUntil = async () => {
    const r = await storageGet("local", STORAGE_KEYS.SNOOZE_UNTIL);
    const v = Number(r?.[STORAGE_KEYS.SNOOZE_UNTIL] || 0);
    return Number.isFinite(v) && v > Date.now() ? v : 0;
  };

  // Setter is reserved for a future popup-side snooze quick-action; the
  // options page is currently the only place that mutates snooze.
  // eslint-disable-next-line no-unused-vars
  const setSnoozeFor = async (days) => {
    const ms = Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000;
    if (!ms) {
      await storageSet("local", { [STORAGE_KEYS.SNOOZE_UNTIL]: null });
      return 0;
    }
    const until = Date.now() + ms;
    await storageSet("local", { [STORAGE_KEYS.SNOOZE_UNTIL]: until });
    return until;
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
    if (!GCC.hasChromeTabs()) return null;

    // Multi-account: if user selected a specific tab, use it
    if (state.currentGmailTabId) {
      try {
        const tabs = await tabsQuery({ url: `${CONFIG.GMAIL_URL}*` });
        const selected = tabs.find(t => t.id === state.currentGmailTabId);
        if (selected) return selected;
      } catch (e) {
        log("warn", "findGmailTab selected tab lookup failed", e);
      }
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
    if (!GCC.hasChrome() || !chrome.runtime?.sendMessage) return;
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
          elements.accountSelector.querySelectorAll(".account-pill").forEach(pill => pill.classList.remove("active"));
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
    if (!GCC.hasChrome() || !chrome.runtime?.sendMessage || !elements.wlSuggestions) return;
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
    if (!GCC.hasChromeTabs() || !GCC.hasChrome()) return null;
    try {
      const base = chrome.runtime.getURL("progress.html");
      const tabs = await tabsQuery({ url: `${base}*` });
      for (const t of tabs || []) {
        if (!t?.url) continue;
        try {
          const u = new URL(t.url);
          const id = u.searchParams.get("gmailTabId");
          if (String(id) === String(gmailTabId)) return t;
        } catch {
          // Invalid URL - skip this tab
        }
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
    // Monthly is a full (light) sweep, so drop any one-category target.
    clearTargetPreset();

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

  // 6.0 focused target presets.
  const updateTargetChips = () => {
    const chips = elements.targetChips?.querySelectorAll("[data-preset]");
    if (!chips) return;
    chips.forEach((chip) => {
      const isActive = chip.getAttribute("data-preset") === state.activePreset;
      chip.setAttribute("aria-pressed", isActive ? "true" : "false");
      chip.classList.toggle("active", isActive);
    });
  };

  const clearTargetPreset = () => {
    if (!state.activePreset && !state.rulesOverride) return;
    state.activePreset = null;
    state.rulesOverride = null;
    updateTargetChips();
  };

  const handleTargetPreset = (key) => {
    const preset = TARGET_PRESETS[key];
    if (!preset) return;

    // Toggle off if the same chip is clicked again.
    if (state.activePreset === key) {
      clearTargetPreset();
      showToast("target cleared - using full rule set", "info");
      return;
    }

    state.activePreset = key;
    state.rulesOverride = preset.rules.slice();
    updateTargetChips();

    showToast(`targeting ${preset.label.toLowerCase()} only`, "success");
    elements.runBtn?.focus();
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
    const protectKeywords = await getProtectKeywords();

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
      protectKeywords,
      debugMode: Boolean(state.debugMode),
      version: POPUP_VERSION,
      // 6.0: focused target preset, if one is active (one run only).
      ...(Array.isArray(state.rulesOverride) && state.rulesOverride.length
        ? { rulesOverride: state.rulesOverride }
        : {})
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

    let claimedRunId = null;
    try {
      const gmailTab = await findGmailTab();
      if (!gmailTab?.id) {
        showOpenGmailHelper();
        resetRunButton();
        hideProgress();
        state.isRunning = false;
        return;
      }

      // Atomic-style claim: do this before any side effect so a second
      // popup opened in parallel can't slip through (issue #20).
      const claim = await tryClaimRun(gmailTab.id);
      if (!claim.ok) {
        log("info", "Claim failed", claim);
        showToast(
          claim.reason === "already_active"
            ? "a cleanup is already running"
            : "another popup just started a cleanup",
          "warning"
        );
        setStatus("cleanup already in progress", STATUS_TYPES.WARNING, true);
        resetRunButton();
        hideProgress();
        state.isRunning = false;
        return;
      }
      claimedRunId = claim.claim.runId;

      state.currentGmailTabId = gmailTab.id;
      showQuickActions();
      updateProgress(30);

      const config = await buildConfig();
      config.runId = claimedRunId;
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
      updateProgress(75);

      // Check if content script is already attached
      let alreadyAttached = false;
      try {
        const [result] = await scriptingExecuteScript({
          target: { tabId: gmailTab.id },
          func: () => !!window.GCC_ATTACHED
        });
        alreadyAttached = result?.result === true;
      } catch {
        // Tab might not be ready, proceed with injection
      }

      if (alreadyAttached) {
        log("info", "Content script already attached, skipping injection");
        showToast("cleanup already running", "warning");
        await clearActiveRun();
        claimedRunId = null;
        resetRunButton();
        hideProgress();
        state.isRunning = false;
        return;
      }

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
      if (claimedRunId) await clearActiveRun();
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
      const resp = await tabsSendMessage(tabId, { type: "gmailCleanerCancel" });
      if (resp?.ok) {
        showToast("cancel confirmed", "info");
        setStatus("cleanup cancelled", STATUS_TYPES.WARNING, true);
        await clearActiveRun();
        hideQuickActions();
        resetRunButton();
        state.isRunning = false;
        state.currentGmailTabId = null;
        hideProgress();
      } else {
        showToast("cancel sent but unconfirmed", "warning");
        setStatus("cancel requested", STATUS_TYPES.WARNING, true);
      }
    } catch (err) {
      // Issue #19: distinguish "tab closed" (recoverable) from real
      // errors so we don't tell the user "tab unreachable" when in fact
      // host permission was revoked or the service worker crashed.
      const kind = err?.gccKind || GCC.classifyChromeError(err).kind;
      if (kind === "tab_closed" || kind === "no_chrome") {
        showToast("gmail tab unreachable, clearing state", "warning");
      } else if (kind === "permission") {
        showToast("permission denied; reload Gmail and retry", "error");
        setStatus("can't reach Gmail (permissions)", STATUS_TYPES.ERROR, true);
      } else {
        showToast(`cancel failed: ${err?.message || "unknown error"}`, "error");
        setStatus(`cancel error: ${err?.message || "unknown"}`, STATUS_TYPES.ERROR, true);
      }
      await clearActiveRun();
      hideQuickActions();
      resetRunButton();
      state.isRunning = false;
      state.currentGmailTabId = null;
      hideProgress();
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
      // Esc: prefer closing modals before closing the popup.
      if (e.key === "Escape") {
        if (elements.kbdHelp?.classList.contains("show")) {
          hideKeyboardHelp();
          return;
        }
        if (elements.onboardingBackdrop?.classList.contains("show")) {
          dismissOnboarding();
          return;
        }
        safeClosePopup();
        return;
      }

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

      // "?" opens the keyboard help modal (Shift+/ on most layouts).
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        const tag = document.activeElement?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault();
          showKeyboardHelp();
        }
      }
    });
  };

  // =========================
  // Runtime message hook (optional, best effort)
  // =========================

  const setupRuntimeMessages = () => {
    if (!GCC.hasChrome() || !chrome.runtime?.onMessage?.addListener) return;

    chrome.runtime.onMessage.addListener((msg) => {
      try {
        if (!msg || typeof msg !== "object") return;

        // The engine and progress page broadcast a single message type --
        // "gmailCleanerProgress" -- and encode lifecycle in `phase`
        // (query / pass-progress / done / cancelled / error), with the
        // final summary in `stats`. (Older popup builds listened for
        // gmailCleanerDone/Canceled/Error types that are never sent.)
        if (msg.type !== "gmailCleanerProgress") return;

        const { phase, status, detail, percent, stats, done } = msg;
        const terminal = done || phase === "done" || phase === "cancelled" || phase === "error";

        if (typeof percent === "number") {
          const pct = GCC.clamp(percent, 0, 100);
          showProgress(pct);
          updateProgress(pct);
        }

        const line = status || detail;
        if (line && !terminal) setStatus(String(line), STATUS_TYPES.RUNNING);

        if (phase === "cancelled") {
          hideProgress();
          hideQuickActions();
          resetRunButton();
          setStatus("canceled", STATUS_TYPES.WARNING, true);
          state.isRunning = false;
          state.currentGmailTabId = null;
          clearActiveRun().catch(() => {});
          return;
        }

        if (phase === "error") {
          const m = detail ? String(detail) : "unknown error";
          hideProgress();
          hideQuickActions();
          resetRunButton();
          setStatus(`error: ${m}`, STATUS_TYPES.ERROR);
          showToast(`failed: ${m}`, "error");
          state.isRunning = false;
          state.currentGmailTabId = null;
          clearActiveRun().catch(() => {});
          return;
        }

        if (phase === "done" || done) {
          hideProgress();
          hideQuickActions();
          resetRunButton();

          const action = stats?.action === "archive" ? "archive" : "trash";
          const count = Number(stats?.runCount ?? stats?.totalDeleted ?? 0);
          const freedBytes = Number(stats?.totalFreedMb || 0) * 1024 * 1024;
          showResultSummary({ count, freedBytes, action });

          showSuccessCtas();
          setStatus("cleanup complete", STATUS_TYPES.SUCCESS, true);

          GCC.showToast(
            `Cleanup complete! View recovery log in Stats to undo.`,
            "success",
            8000,
            elements.toastContainer
          );

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
        // Changing the intensity means "use the full rule set", so it
        // supersedes any one-category target preset.
        if (el === elements.intensityEl) clearTargetPreset();
        scheduleAutosave();
      });
    });
  };

  const wireTargetPresets = () => {
    const chips = elements.targetChips?.querySelectorAll("[data-preset]");
    if (!chips) return;
    chips.forEach((chip) => {
      chip.addEventListener("click", () => handleTargetPreset(chip.getAttribute("data-preset")));
    });
  };

  // =========================
  // Theme switcher (5.0)
  // =========================

  const wireThemeSwitcher = async () => {
    if (!elements.themeSwitcher) return;
    const current = await GCC.theme.get();
    for (const btn of elements.themeSwitcher.querySelectorAll("button[data-theme-value]")) {
      btn.setAttribute("aria-pressed", btn.dataset.themeValue === current ? "true" : "false");
      btn.addEventListener("click", async () => {
        const applied = await GCC.theme.set(btn.dataset.themeValue);
        elements.themeSwitcher.querySelectorAll("button[data-theme-value]").forEach((b) => {
          b.setAttribute("aria-pressed", b.dataset.themeValue === applied ? "true" : "false");
        });
      });
    }
  };

  // =========================
  // Snooze banner (5.0)
  // =========================

  const refreshSnoozeBanner = async () => {
    if (!elements.snoozeBanner) return;
    const until = await getSnoozeUntil();
    if (until && elements.snoozeBannerText) {
      const days = Math.max(1, Math.ceil((until - Date.now()) / (24 * 60 * 60 * 1000)));
      elements.snoozeBannerText.textContent = `Schedules snoozed (~${days} day${days === 1 ? "" : "s"} left). Manual runs still work.`;
      elements.snoozeBanner.classList.add("show");
    } else {
      elements.snoozeBanner.classList.remove("show");
    }
  };

  // =========================
  // Keyboard help modal (5.0)
  // =========================

  const showKeyboardHelp = () => elements.kbdHelp?.classList.add("show");
  const hideKeyboardHelp = () => elements.kbdHelp?.classList.remove("show");

  // =========================
  // Onboarding wizard (5.0)
  // =========================

  const maybeShowOnboarding = async () => {
    if (!elements.onboardingBackdrop) return;
    const r = await storageGet("local", STORAGE_KEYS.ONBOARDED);
    if (r?.[STORAGE_KEYS.ONBOARDED]) return;
    elements.onboardingBackdrop.classList.add("show");
  };

  const dismissOnboarding = async () => {
    elements.onboardingBackdrop?.classList.remove("show");
    await storageSet("local", { [STORAGE_KEYS.ONBOARDED]: Date.now() });
  };

  const advanceOnboarding = () => {
    if (!elements.onboardingBackdrop) return;
    const steps = elements.onboardingBackdrop.querySelectorAll("[data-onb-step]");
    const dots = elements.onboardingBackdrop.querySelectorAll("[data-onb-dot]");
    const currentIdx = Array.from(steps).findIndex((el) => !el.hidden);
    if (currentIdx < 0) return;
    if (currentIdx >= steps.length - 1) {
      dismissOnboarding();
      return;
    }
    steps[currentIdx].hidden = true;
    steps[currentIdx + 1].hidden = false;
    dots.forEach((d, i) => d.classList.toggle("active", i <= currentIdx + 1));
    if (elements.onbNextBtn && currentIdx + 1 === steps.length - 1) {
      elements.onbNextBtn.textContent = "Got it";
    }
  };

  const setupEventListeners = () => {
    elements.runBtn.addEventListener("click", runCleanup);

    elements.monthlyCleanBtn?.addEventListener("click", handleMonthlyClean);
    wireTargetPresets();

    elements.pinHintClose?.addEventListener("click", dismissPinHint);
    elements.kbdHelpBtn?.addEventListener("click", showKeyboardHelp);
    elements.kbdHelpClose?.addEventListener("click", hideKeyboardHelp);
    elements.kbdHelp?.addEventListener("click", (e) => {
      if (e.target === elements.kbdHelp) hideKeyboardHelp();
    });
    elements.onbNextBtn?.addEventListener("click", advanceOnboarding);
    elements.onbSkipBtn?.addEventListener("click", dismissOnboarding);

    elements.ratingBtn?.addEventListener("click", async () => {
      await tabsCreate({
        url: "https://chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc/reviews",
        active: true
      });
      dismissRatingPrompt();
      setTimeout(safeClosePopup, 150);
    });
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

  const syncVersionBadge = () => {
    const badge = $("versionBadge");
    if (!badge) return;
    try {
      const version = chrome?.runtime?.getManifest?.()?.version;
      if (!version) return;
      const text = `v${version}`;
      badge.textContent = text;
      badge.setAttribute("aria-label", `Version ${version}`);
    } catch (e) {
      log("warn", "syncVersionBadge failed", e);
    }
  };

  const init = async () => {
    state.debugMode = await getDebugModeSetting();
    log("info", `init v${POPUP_VERSION}`);

    // Theme has to apply before paint to avoid a flash.
    await GCC.theme.init();
    await wireThemeSwitcher();

    syncVersionBadge();
    setupEventListeners();

    await checkPinHint();
    await restoreLastConfig();
    await restoreActiveRunUI();
    await maybeShowRatingPrompt();
    await refreshSnoozeBanner();
    await maybeShowOnboarding();

    loadGmailAccounts();
    loadWhitelistSuggestions();

    log("info", "ready");
  };

  init().catch((e) => {
    console.error("[Gmail Cleaner Popup] init failed:", e);
    setStatus("init error", STATUS_TYPES.ERROR);
  });
});
