// popup.js
document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  // =========================
  // Constants & Configuration
  // =========================

  const POPUP_VERSION = "7.12.0";

  const CONFIG = Object.freeze({
    TOAST_DURATION_MS: 3000,
    BUTTON_SUCCESS_DURATION_MS: 1500,
    STATUS_CLEAR_DELAY_MS: 5000,
    AUTOSAVE_DEBOUNCE_MS: 250,

    GMAIL_URL: "https://mail.google.com/",
    GMAIL_INBOX_URL: "https://mail.google.com/mail/u/0/#inbox",

    ACTIVE_RUN_TTL_MS: 1000 * 60 * 60 * 2 // 2h best effort TTL
  });

  const STORAGE_KEYS = Object.freeze({
    LAST_CONFIG: "lastConfig",
    LAST_UI: "lastUiSnapshot",
    DEBUG_MODE: "debugMode",
    WHITELIST: "whitelist",
    PROTECT_KEYWORDS: "protectKeywords",

    PIN_DISMISSED: "pinHintDismissed",
    ONBOARDED: "onboardedAt",

    RUN_COUNT: "runSuccessCount",
    RATING_DISMISSED: "ratingPromptDismissed",

    // 7.3: whether the Advanced disclosure was left open.
    ADVANCED_OPEN: "advancedOpen",

    // 7.8: whether the Suggested disclosure was left open.
    SMART_OPEN: "smartSectionOpen",

    // 7.4: post-run recap. STATS mirrors the service worker's stats key
    // (read-only here); RECAP_SEEN is the "already shown" timestamp.
    STATS: "cleanupStats",
    RECAP_SEEN: "recapSeenAt",

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

    // 7.3 tabbed layout: handle returned by GCC.tablist.
    tabs: null,

    // 7.1 deep-clean confirmation. window.confirm() is a silent no-op
    // inside Firefox popups, so the guard is an inline two-click arm
    // instead of a modal. Armed state expires after a short window.
    deepConfirmArmed: false,
    deepConfirmTimer: null,

    // 6.0 focused "target" presets: a one-off rule set for the next run.
    // Transient (not persisted) -- cleared when the user touches the
    // intensity dropdown, since that means "use the full rule set".
    rulesOverride: null,
    activePreset: null,

    // 7.0 subscriptions: license state + last scan, and which
    // subscription run (if any) this popup instance is watching.
    subs: {
      licenseActive: false,
      senders: [],
      running: null
    },

    // 7.2 storage X-ray: last scan + totals. Pro gating reads
    // state.subs.licenseActive (one license, one flag).
    xray: {
      senders: [],
      totalMb: 0,
      totalCount: 0,
      running: null
    },

    // 7.8 Smart Suggestions: stored scan + feedback, plus the config
    // pieces the render-time veto re-check needs. visibleCount feeds
    // the toolbar counter.
    smart: {
      senders: [],
      feedback: { bySender: {} },
      whitelist: [],
      protectKeywords: [],
      visibleCount: 0,
      running: null
    },

    // 7.12 Auto-Pilot: the worker's settings + last-run snapshot
    // ({ enabled, confirmed, lastRun, preview, pendingStage }).
    autoPilot: null
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

    // 7.3 tabbed layout
    tabBar: $("popupTabs"),
    cleanForm: $("cleanForm"),
    cleanResult: $("cleanResult"),
    resultBackBtn: $("resultBackBtn"),
    advancedSection: $("advancedSection"),

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

    // 7.4 post-run recap
    recapNote: $("recapNote"),

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

    // 7.1 Gmail host access (Firefox lets users revoke it)
    gmailAccessBanner: $("gmailAccessBanner"),
    gmailAccessBtn: $("gmailAccessBtn"),
    kbdHelpBtn: $("kbdHelpBtn"),
    kbdHelp: $("keyboardHelp"),
    kbdHelpClose: $("kbdHelpClose"),
    onboardingBackdrop: $("onboardingBackdrop"),
    onbNextBtn: $("onbNextBtn"),
    onbSkipBtn: $("onbSkipBtn"),

    // 7.0 subscriptions
    subsProPill: $("subsProPill"),
    scanSubsBtn: $("scanSubsBtn"),
    subsStatus: $("subsStatus"),
    subsToolbar: $("subsToolbar"),
    subsSelectAll: $("subsSelectAll"),
    subsCount: $("subsCount"),
    subsList: $("subsList"),
    unsubBtn: $("unsubBtn"),
    unsubBtnSub: $("unsubBtnSub"),
    subsUpsell: $("subsUpsell"),
    subsUpsellText: $("subsUpsellText"),
    subsBuyLink: $("subsBuyLink"),
    subsEnterKey: $("subsEnterKey"),
    footerProBtn: $("footerProBtn"),
    proPromo: $("proPromo"),
    proPromoBuy: $("proPromoBuy"),
    proPromoKey: $("proPromoKey"),

    // 7.2 storage X-ray
    xrayProPill: $("xrayProPill"),
    xrayScanBtn: $("xrayScanBtn"),
    xrayStatus: $("xrayStatus"),
    xrayTotal: $("xrayTotal"),
    xrayTotalMb: $("xrayTotalMb"),
    xrayTotalSub: $("xrayTotalSub"),
    xrayToolbar: $("xrayToolbar"),
    xraySelectAll: $("xraySelectAll"),
    xrayCount: $("xrayCount"),
    xrayList: $("xrayList"),
    xrayAgeRow: $("xrayAgeRow"),
    xrayAge: $("xrayAge"),
    xrayPurgeBtn: $("xrayPurgeBtn"),
    xrayPurgeBtnSub: $("xrayPurgeBtnSub"),
    xrayUpsell: $("xrayUpsell"),
    xrayUpsellText: $("xrayUpsellText"),
    xrayBuyLink: $("xrayBuyLink"),
    xrayEnterKey: $("xrayEnterKey"),

    // 7.8 Smart Suggestions
    smartSection: $("smartSection"),
    smartScanBtn: $("smartScanBtn"),
    smartStatus: $("smartStatus"),
    smartToolbar: $("smartToolbar"),
    smartSelectAll: $("smartSelectAll"),
    smartCount: $("smartCount"),
    smartList: $("smartList"),
    smartBulkBtn: $("smartBulkBtn"),
    smartBulkBtnSub: $("smartBulkBtnSub"),
    smartUpsell: $("smartUpsell"),
    smartUpsellText: $("smartUpsellText"),
    smartBuyLink: $("smartBuyLink"),
    smartEnterKey: $("smartEnterKey"),

    // 7.12 Auto-Pilot
    autoPilotToggle: $("autoPilotToggle"),
    autoPilotStatus: $("autoPilotStatus"),
    autoPilotConfirm: $("autoPilotConfirm"),
    autoPilotConfirmText: $("autoPilotConfirmText"),
    autoPilotConfirmBtn: $("autoPilotConfirmBtn"),
    autoPilotUpsell: $("autoPilotUpsell"),
    autoPilotUpsellText: $("autoPilotUpsellText"),
    autoPilotBuyLink: $("autoPilotBuyLink")
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

  const hideRatingPrompt = () => elements.ratingPrompt?.classList.remove("show");

  // 7.4: the recap marker only shows while the result view is replaying
  // the last cleanup; a live done and the back button both clear it.
  const hideRecapNote = () => {
    if (elements.recapNote) elements.recapNote.hidden = true;
  };

  // 7.3: the Clean tab swaps between the form and the post-run result.
  // The result view owns the summary, the CTAs and the rating ask; the
  // back button (or starting another run) returns to the form.
  const showResultState = () => {
    if (!elements.cleanForm || !elements.cleanResult) return;
    elements.cleanForm.hidden = true;
    elements.cleanResult.hidden = false;
  };

  const showFormState = () => {
    hideResultSummary();
    hideSuccessCtas();
    hideRatingPrompt();
    hideRecapNote();
    if (!elements.cleanForm || !elements.cleanResult) return;
    elements.cleanResult.hidden = true;
    elements.cleanForm.hidden = false;
  };

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

  // 7.12: the browser knows whether the toolbar icon is already
  // pinned (chrome.action.getUserSettings, Chrome 91+ / Firefox 90+).
  // true / false when the API answers, null when it is unavailable so
  // the caller falls back to the dismissal flag alone.
  const getPinnedState = async () => {
    try {
      if (!GCC.hasChrome() || !chrome.action?.getUserSettings) return null;
      const settings = await chrome.action.getUserSettings();
      return typeof settings?.isOnToolbar === "boolean" ? settings.isOnToolbar : null;
    } catch {
      return null;
    }
  };

  // 7.3: at most one banner shows at a time. Eligibility for all three
  // is gathered here and GCC.popupUi.pickBanner arbitrates (Gmail
  // access, then snooze, then pin hint), so a grant or a dismissal
  // re-runs the whole decision instead of leaving stale banners up.
  // The pin hint needs BOTH: never dismissed and not already pinned;
  // dismissing it is permanent (a local flag that never expires).
  const refreshBanners = async () => {
    const [accessOk, snoozeUntil, pinFlag, pinned] = await Promise.all([
      GCC.gmailAccess.check(),
      getSnoozeUntil(),
      storageGet("local", STORAGE_KEYS.PIN_DISMISSED),
      getPinnedState()
    ]);

    const which = GCC.popupUi.pickBanner({
      accessNeeded: !accessOk,
      snoozed: Boolean(snoozeUntil),
      pinEligible: !pinFlag?.[STORAGE_KEYS.PIN_DISMISSED] && pinned !== true
    });

    if (which === "snooze" && elements.snoozeBannerText) {
      const days = Math.max(1, Math.ceil((snoozeUntil - Date.now()) / (24 * 60 * 60 * 1000)));
      elements.snoozeBannerText.textContent =
        `Schedules snoozed (~${days} day${days === 1 ? "" : "s"} left). Manual runs still work.`;
    }

    elements.gmailAccessBanner?.classList.toggle("show", which === "access");
    elements.snoozeBanner?.classList.toggle("show", which === "snooze");
    elements.pinHint?.classList.toggle("show", which === "pin");
    return accessOk;
  };

  const dismissPinHint = async () => {
    elements.pinHint?.classList.remove("show");
    await storageSet("local", { [STORAGE_KEYS.PIN_DISMISSED]: true });
    refreshBanners().catch(() => {});
  };

  // 7.3: the rating ask fires right after a run worth bragging about (a
  // real, non-dry cleanup past the size thresholds) instead of counting
  // popup opens. "Maybe later" still suppresses it for good.
  const maybeShowRatingForRun = async (run) => {
    if (!elements.ratingPrompt) return;
    if (!GCC.popupUi.ratingRunQualifies(run)) {
      hideRatingPrompt();
      return;
    }
    const r = await storageGet("local", STORAGE_KEYS.RATING_DISMISSED);
    if (Boolean(r?.[STORAGE_KEYS.RATING_DISMISSED])) {
      hideRatingPrompt();
      return;
    }
    elements.ratingPrompt.classList.add("show");
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

  // 7.4: post-run recap. The popup closes itself when a run starts, so
  // the 7.3 result screen (and its earned rating ask) almost never had
  // an audience. On open, the newest unseen real cleanup from the
  // lifetime history replays through the same result view, marked by
  // the recap note. Marker semantics live in GCC.popupUi; both the
  // recap and the live done path stamp it so no run shows twice.
  const markRecapSeen = async () => {
    await storageSet("local", {
      [STORAGE_KEYS.RECAP_SEEN]: GCC.popupUi.recapSeenMarker(Date.now())
    });
  };

  const showRecapForEntry = (entry) => {
    const cleaned = GCC.popupUi.recapCleanedCount(entry);
    const freedMb = Number(entry.freedMb) || 0;

    showResultState();
    showResultSummary({
      count: cleaned,
      freedBytes: freedMb * 1024 * 1024,
      action: GCC.popupUi.recapAction(entry)
    });
    if (elements.recapNote) {
      elements.recapNote.textContent =
        `Recap: your last cleanup finished ${GCC.relativeTime(entry.timestamp)}, while the popup was closed.`;
      elements.recapNote.hidden = false;
    }
    showSuccessCtas();
  };

  const maybeShowPostRunRecap = async () => {
    if (!elements.cleanForm || !elements.cleanResult) return;

    // A run in flight owns the Clean tab; leave the marker alone so the
    // finished run still gets its recap on the next open.
    if (await getActiveRun()) return;

    const r = await storageGet("local", [STORAGE_KEYS.STATS, STORAGE_KEYS.RECAP_SEEN]);
    const entry = GCC.popupUi.pickRecapEntry(
      r?.[STORAGE_KEYS.STATS]?.history,
      r?.[STORAGE_KEYS.RECAP_SEEN]
    );
    if (!entry) return;

    showRecapForEntry(entry);

    // Seen is seen, whatever the rating gate decides below.
    await markRecapSeen();

    await maybeShowRatingForRun({
      dryRun: Boolean(entry.dryRun),
      cleaned: GCC.popupUi.recapCleanedCount(entry),
      freedMb: Number(entry.freedMb) || 0
    });
  };

  // 7.3: the Advanced disclosure keeps its open state across popup
  // opens, same local-flag pattern as the pin hint dismissal.
  const initAdvancedDisclosure = async () => {
    if (!elements.advancedSection) return;
    const r = await storageGet("local", STORAGE_KEYS.ADVANCED_OPEN);
    elements.advancedSection.open = Boolean(r?.[STORAGE_KEYS.ADVANCED_OPEN]);
    elements.advancedSection.addEventListener("toggle", () => {
      storageSet("local", {
        [STORAGE_KEYS.ADVANCED_OPEN]: Boolean(elements.advancedSection.open)
      }).catch(() => {});
    });
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

  const disarmDeepConfirm = () => {
    if (state.deepConfirmTimer) clearTimeout(state.deepConfirmTimer);
    state.deepConfirmTimer = null;
    const wasArmed = state.deepConfirmArmed;
    state.deepConfirmArmed = false;
    if (wasArmed && state.buttonState === BUTTON_STATES.IDLE) resetRunButton();
  };

  const runCleanup = async () => {
    if (state.isRunning) return;

    // Warn on deep intensity. Inline two-click confirmation instead of
    // window.confirm(): modals are a silent no-op in Firefox popups,
    // which would have made live deep cleans unstartable there.
    const intensity = elements.intensityEl?.value || "normal";
    if (intensity === "deep" && !elements.dryRunEl?.checked) {
      if (!state.deepConfirmArmed) {
        state.deepConfirmArmed = true;
        setRunButtonState({
          disabled: false,
          label: "confirm deep clean?",
          sub: "click again to run it - dry run is the safe preview",
          state: BUTTON_STATES.IDLE
        });
        setStatus("deep targets many categories - click run again to confirm", STATUS_TYPES.WARNING);
        if (state.deepConfirmTimer) clearTimeout(state.deepConfirmTimer);
        state.deepConfirmTimer = setTimeout(disarmDeepConfirm, 8000);
        return;
      }
      disarmDeepConfirm();
    } else if (state.deepConfirmArmed) {
      disarmDeepConfirm();
    }

    // Host access gate: Chrome grants it at install; Firefox users can
    // revoke it (or hold a pre-127 profile that never granted it).
    if (!(await GCC.gmailAccess.check())) {
      refreshBanners().catch(() => {});
      setStatus("allow Gmail access above, then run again", STATUS_TYPES.WARNING);
      showToast("gmail access needed", "warning");
      return;
    }

    state.isRunning = true;
    removeOpenGmailHelper();
    showFormState();

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
  // Subscriptions: scan + bulk unsubscribe (7.0)
  // =========================
  // The scan is free; executing unsubscribes is the Pro feature. The
  // gate lives here in the UI: the engine itself is not license-aware.

  const SUBS_STATUS_LABELS = Object.freeze({
    unsubscribed: { text: "Unsubscribed", cls: "ok" },
    manual: { text: "Manual step needed", cls: "warn" },
    no_button: { text: "No 1-click option", cls: "warn" },
    no_dialog: { text: "Unconfirmed", cls: "warn" },
    unknown_dialog: { text: "Unconfirmed", cls: "warn" },
    not_found: { text: "No mail found", cls: "warn" },
    error: { text: "Failed", cls: "err" }
  });

  const setSubsStatus = (text) => {
    if (elements.subsStatus) elements.subsStatus.textContent = text || "";
  };

  const refreshLicenseUi = async () => {
    try {
      const licenseState = await GCC.license.getState();
      state.subs.licenseActive = licenseState.active;
    } catch {
      state.subs.licenseActive = false;
    }
    const active = state.subs.licenseActive;
    if (elements.subsProPill) elements.subsProPill.hidden = !active;
    if (elements.subsUpsell) elements.subsUpsell.hidden = active;
    if (elements.unsubBtnSub) {
      elements.unsubBtnSub.textContent = active
        ? "Uses Gmail's own Unsubscribe control"
        : "Pro · $9.99 lifetime";
    }
    if (elements.unsubBtn) elements.unsubBtn.classList.toggle("locked", !active);
    if (elements.subsBuyLink) elements.subsBuyLink.href = GCC.license.PRO.BUY_URL;
    if (elements.proPromoBuy) elements.proPromoBuy.href = GCC.license.PRO.BUY_URL;
    if (elements.proPromo) elements.proPromo.hidden = active;

    // 7.2 storage X-ray shares the same license.
    if (elements.xrayProPill) elements.xrayProPill.hidden = !active;
    if (elements.xrayBuyLink) elements.xrayBuyLink.href = GCC.license.PRO.BUY_URL;
    if (elements.xrayPurgeBtn) elements.xrayPurgeBtn.classList.toggle("locked", !active);
    if (elements.xrayPurgeBtnSub) {
      elements.xrayPurgeBtnSub.textContent = active
        ? "Tagged first, then Trash - undo applies"
        : "Pro · $9.99 once (Google One is $20 every year)";
    }
    renderXrayList();

    // 7.8 Smart Suggestions share the same license: the scan and the
    // top picks are free, the full list and bulk apply are Pro.
    if (elements.smartBuyLink) elements.smartBuyLink.href = GCC.license.PRO.BUY_URL;
    if (elements.smartBulkBtn) elements.smartBulkBtn.classList.toggle("locked", !active);
    renderSmartList();
  };

  const getCheckedSubEmails = () =>
    (elements.subsList
      ? Array.from(elements.subsList.querySelectorAll("input[type='checkbox']:checked"))
      : []
    ).map((cb) => cb.getAttribute("data-email")).filter(Boolean);

  const updateSubsCount = () => {
    if (!elements.subsCount) return;
    const total = state.subs.senders.length;
    const checked = getCheckedSubEmails().length;
    elements.subsCount.textContent = checked
      ? `${checked} of ${total} selected`
      : `${total} sender${total === 1 ? "" : "s"} found`;
  };

  // 7.3: once a scan exists, the upsell leads with the user's own
  // numbers; before that it keeps the static pitch from the markup.
  const updateSubsUpsellCopy = () => {
    if (!elements.subsUpsellText) return;
    elements.subsUpsellText.textContent =
      GCC.popupUi.subsUpsellLine(state.subs.senders.length);
  };

  const renderSubsList = () => {
    if (!elements.subsList) return;
    updateSubsUpsellCopy();
    elements.subsList.textContent = "";
    const senders = state.subs.senders;
    const hasSenders = senders.length > 0;
    if (elements.subsToolbar) elements.subsToolbar.hidden = !hasSenders;
    if (elements.unsubBtn) elements.unsubBtn.hidden = !hasSenders;
    if (!hasSenders) {
      updateSubsCount();
      return;
    }

    for (const sender of senders) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("data-email", sender.email);
      checkbox.addEventListener("change", updateSubsCount);
      if (sender.status === "unsubscribed") checkbox.disabled = true;

      const name = document.createElement("span");
      name.className = "subs-row-name";
      name.textContent = sender.name || sender.email;

      const email = document.createElement("span");
      email.className = "subs-row-email";
      email.textContent = sender.name ? sender.email : "";

      const text = document.createElement("span");
      text.className = "subs-row-text";
      text.appendChild(name);
      if (email.textContent) text.appendChild(email);

      const label = document.createElement("label");
      label.className = "subs-row-label";
      label.appendChild(checkbox);
      label.appendChild(text);

      const row = document.createElement("div");
      row.className = "subs-row";
      row.setAttribute("role", "listitem");
      row.appendChild(label);

      const statusMeta = SUBS_STATUS_LABELS[sender.status];
      if (statusMeta) {
        const chip = document.createElement("span");
        chip.className = `subs-row-status ${statusMeta.cls}`;
        chip.textContent = statusMeta.text;
        row.appendChild(chip);
      } else {
        const count = document.createElement("span");
        count.className = "subs-row-count";
        count.textContent = `${sender.count} email${sender.count === 1 ? "" : "s"}`;
        row.appendChild(count);
      }

      elements.subsList.appendChild(row);
    }
    updateSubsCount();
  };

  const loadStoredSubscriptions = async () => {
    if (!GCC.hasChrome() || !chrome.runtime?.sendMessage) return;
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "gmailCleanerGetSubscriptions" }, resolve);
      });
      if (resp?.ok && resp.scan?.senders) {
        state.subs.senders = resp.scan.senders;
        renderSubsList();
      }
    } catch (e) {
      log("warn", "loadStoredSubscriptions failed", e);
    }
  };

  // Shared injection path for the auxiliary run kinds (subscription
  // scan / unsubscribe / storage scan). Returns the Gmail tab id, or
  // null when the run could not start. setStatusFn receives the
  // user-facing reason on refusal.
  const injectEngineRun = async (config, setStatusFn) => {
    if (!(await GCC.gmailAccess.check())) {
      refreshBanners().catch(() => {});
      setStatusFn("Allow Gmail access at the top of this popup first.");
      showToast("gmail access needed", "warning");
      return null;
    }

    const gmailTab = await findGmailTab();
    if (!gmailTab) {
      showToast("open Gmail in a tab first", "warning");
      setStatusFn("Open mail.google.com in a tab, then try again.");
      return null;
    }

    try {
      const [attached] = await scriptingExecuteScript({
        target: { tabId: gmailTab.id },
        func: () => !!window.GCC_ATTACHED
      });
      if (attached?.result === true) {
        showToast("another run is already in progress", "warning");
        return null;
      }
    } catch {
      // Tab might not be ready; the injection below will surface real errors.
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
    return gmailTab.id;
  };

  const injectSubscriptionRun = (runKind, unsubSenders = []) =>
    injectEngineRun({ runKind, unsubSenders, debugMode: state.debugMode }, setSubsStatus);

  const handleScanSubscriptions = async () => {
    if (state.subs.running) return;
    try {
      state.subs.running = "subscriptionScan";
      if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = true;
      setSubsStatus("Scanning your mailbox for subscription senders...");
      const tabId = await injectSubscriptionRun("subscriptionScan");
      if (tabId === null) {
        state.subs.running = null;
        if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = false;
        return;
      }
    } catch (err) {
      log("error", "scan start failed", err);
      showToast(`scan failed: ${err?.message || "unknown error"}`, "error");
      setSubsStatus("");
      state.subs.running = null;
      if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = false;
    }
  };

  const handleUnsubscribe = async () => {
    if (state.subs.running) return;

    if (!state.subs.licenseActive) {
      if (elements.subsUpsell) elements.subsUpsell.hidden = false;
      showToast("bulk unsubscribe is a Pro feature ($9.99, one-time)", "info");
      return;
    }

    const emails = getCheckedSubEmails();
    if (!emails.length) {
      showToast("pick at least one sender first", "warning");
      return;
    }
    const capped = emails.slice(0, 25);
    if (emails.length > capped.length) {
      showToast("running the first 25; re-run for the rest", "info");
    }

    try {
      state.subs.running = "unsubscribe";
      if (elements.unsubBtn) elements.unsubBtn.disabled = true;
      if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = true;
      setSubsStatus(`Unsubscribing from ${capped.length} sender${capped.length === 1 ? "" : "s"}...`);
      const tabId = await injectSubscriptionRun("unsubscribe", capped);
      if (tabId === null) {
        state.subs.running = null;
        if (elements.unsubBtn) elements.unsubBtn.disabled = false;
        if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = false;
      }
    } catch (err) {
      log("error", "unsubscribe start failed", err);
      showToast(`unsubscribe failed: ${err?.message || "unknown error"}`, "error");
      setSubsStatus("");
      state.subs.running = null;
      if (elements.unsubBtn) elements.unsubBtn.disabled = false;
      if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = false;
    }
  };

  const finishSubsRun = () => {
    state.subs.running = null;
    if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = false;
    if (elements.unsubBtn) elements.unsubBtn.disabled = false;
  };

  // Progress messages from the subscriptions engine carry runKind; the
  // main cleanup listener routes them here and returns early.
  const handleSubsProgress = (msg) => {
    const { runKind, phase, status, detail, done } = msg;

    if (!done && phase !== "done") {
      const line = [status, detail].filter(Boolean).join(" ");
      if (line) setSubsStatus(line);
      return;
    }

    if (phase === "error") {
      setSubsStatus(`Failed: ${detail || "unknown error"}`);
      showToast(runKind === "unsubscribe" ? "unsubscribe run failed" : "scan failed", "error");
      finishSubsRun();
      return;
    }
    if (phase === "cancelled") {
      setSubsStatus("Stopped.");
      finishSubsRun();
      return;
    }

    if (runKind === "subscriptionScan" && Array.isArray(msg.scanSenders)) {
      // Merge stored statuses (the service worker persists them) after a
      // short beat; render the fresh list immediately for responsiveness.
      state.subs.senders = msg.scanSenders;
      renderSubsList();
      setSubsStatus(status || "Scan complete.");
      setTimeout(() => { loadStoredSubscriptions().catch(() => {}); }, 400);
      showToast("subscription scan complete", "success");
    } else if (runKind === "unsubscribe" && Array.isArray(msg.unsubResults)) {
      const byEmail = Object.create(null);
      for (const r of msg.unsubResults) byEmail[r.sender] = r.status;
      for (const sender of state.subs.senders) {
        if (byEmail[sender.email]) sender.status = byEmail[sender.email];
      }
      renderSubsList();
      setSubsStatus(status || "Unsubscribe run complete.");
      const okCount = msg.unsubResults.filter((r) => r.status === "unsubscribed").length;
      showToast(`unsubscribed from ${okCount} sender${okCount === 1 ? "" : "s"}`, okCount ? "success" : "warning");
    }
    finishSubsRun();
  };

  // =========================
  // Storage X-ray (7.2)
  // =========================
  // Scan is free and read-only; the full ranked list and the purge are
  // Pro. The purge itself is an ordinary cleanup run whose rule set is
  // a from:(...) larger: query built in GCC.storageXray, so every
  // global guard, tag-before-delete and the recovery log apply.

  const setXrayStatus = (text) => {
    if (elements.xrayStatus) elements.xrayStatus.textContent = text || "";
  };

  const getCheckedXrayEmails = () =>
    (elements.xrayList
      ? Array.from(elements.xrayList.querySelectorAll("input[type='checkbox']:checked"))
      : []
    ).map((cb) => cb.getAttribute("data-email")).filter(Boolean);

  const updateXrayCount = () => {
    if (!elements.xrayCount) return;
    const total = state.xray.senders.length;
    const checked = getCheckedXrayEmails().length;
    elements.xrayCount.textContent = checked
      ? `${checked} of ${total} selected`
      : `${total} sender${total === 1 ? "" : "s"} ranked`;
  };

  const renderXrayTotals = () => {
    if (!elements.xrayTotal) return;
    const { totalMb, totalCount } = state.xray;
    if (!totalMb && !state.xray.senders.length) {
      elements.xrayTotal.classList.remove("show");
      return;
    }
    if (elements.xrayTotalMb) {
      elements.xrayTotalMb.textContent = `≥ ${GCC.formatMb(totalMb)}`;
    }
    if (elements.xrayTotalSub) {
      elements.xrayTotalSub.textContent =
        `reclaimable across ${GCC.formatNumber(totalCount)} large email${totalCount === 1 ? "" : "s"}`;
    }
    elements.xrayTotal.classList.add("show");
  };

  // 7.3: number-led upsell. The MB figure is the sum of the ranked
  // senders' floor estimates, so the claim can never overshoot what the
  // scan actually measured.
  const updateXrayUpsellCopy = () => {
    if (!elements.xrayUpsellText) return;
    const senders = state.xray.senders;
    const mbSum = senders.reduce((sum, s) => sum + (Number(s.estMb) || 0), 0);
    elements.xrayUpsellText.textContent =
      GCC.popupUi.xrayUpsellLine(senders.length, mbSum);
  };

  const renderXrayList = () => {
    if (!elements.xrayList) return;
    updateXrayUpsellCopy();
    elements.xrayList.textContent = "";
    const active = state.subs.licenseActive;
    const senders = state.xray.senders;
    const hasSenders = senders.length > 0;

    renderXrayTotals();
    if (elements.xrayToolbar) elements.xrayToolbar.hidden = !hasSenders || !active;
    if (elements.xrayPurgeBtn) elements.xrayPurgeBtn.hidden = !hasSenders;
    if (elements.xrayAgeRow) elements.xrayAgeRow.classList.toggle("show", hasSenders && active);
    if (elements.xrayUpsell && hasSenders && !active) elements.xrayUpsell.hidden = false;
    if (!hasSenders) {
      updateXrayCount();
      return;
    }

    const freeCap = GCC.storageXray.LIMITS.FREE_VISIBLE;
    const visible = active ? senders : senders.slice(0, freeCap);

    for (const sender of visible) {
      const text = document.createElement("span");
      text.className = "subs-row-text";
      const name = document.createElement("span");
      name.className = "subs-row-name";
      name.textContent = sender.name || sender.email;
      text.appendChild(name);
      if (sender.name) {
        const email = document.createElement("span");
        email.className = "subs-row-email";
        email.textContent = sender.email;
        text.appendChild(email);
      }

      const row = document.createElement("div");
      row.className = "subs-row";
      row.setAttribute("role", "listitem");

      if (active) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.setAttribute("data-email", sender.email);
        checkbox.addEventListener("change", updateXrayCount);
        const label = document.createElement("label");
        label.className = "subs-row-label";
        label.appendChild(checkbox);
        label.appendChild(text);
        row.appendChild(label);
      } else {
        row.appendChild(text);
      }

      if (sender.status === "purged") {
        const chip = document.createElement("span");
        chip.className = "subs-row-status ok";
        chip.textContent = "Purged";
        row.appendChild(chip);
      }

      const mb = document.createElement("span");
      mb.className = "xray-mb";
      mb.textContent = `≥ ${GCC.formatMb(sender.estMb)}`;
      row.appendChild(mb);

      elements.xrayList.appendChild(row);
    }

    if (!active && senders.length > freeCap) {
      const hidden = senders.slice(freeCap);
      const hiddenMb = hidden.reduce((sum, s) => sum + (Number(s.estMb) || 0), 0);
      const locked = document.createElement("div");
      locked.className = "xray-locked";
      const strong = document.createElement("span");
      strong.className = "xray-locked-mb";
      strong.textContent = `≥ ${GCC.formatMb(hiddenMb)}`;
      locked.appendChild(document.createTextNode(`${hidden.length} more sender${hidden.length === 1 ? "" : "s"} holding `));
      locked.appendChild(strong);
      locked.appendChild(document.createTextNode(" - Pro unlocks the full list and one-click purge."));
      elements.xrayList.appendChild(locked);
    }

    updateXrayCount();
  };

  const loadStoredStorageScan = async () => {
    if (!GCC.hasChrome() || !chrome.runtime?.sendMessage) return;
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "gmailCleanerGetStorageScan" }, resolve);
      });
      if (resp?.ok && resp.scan?.senders) {
        state.xray.senders = GCC.storageXray.rankSenders(resp.scan.senders);
        state.xray.totalMb = Number(resp.scan.totalMb) || 0;
        state.xray.totalCount = Number(resp.scan.totalCount) || 0;
        renderXrayList();
      }
    } catch (e) {
      log("warn", "loadStoredStorageScan failed", e);
    }
  };

  const handleScanStorage = async () => {
    if (state.xray.running) return;
    try {
      state.xray.running = "storageScan";
      if (elements.xrayScanBtn) elements.xrayScanBtn.disabled = true;
      setXrayStatus("Sizing up your mailbox...");
      const tabId = await injectEngineRun(
        { runKind: "storageScan", debugMode: state.debugMode },
        setXrayStatus
      );
      if (tabId === null) {
        state.xray.running = null;
        if (elements.xrayScanBtn) elements.xrayScanBtn.disabled = false;
      }
    } catch (err) {
      log("error", "storage scan start failed", err);
      showToast(`scan failed: ${err?.message || "unknown error"}`, "error");
      setXrayStatus("");
      state.xray.running = null;
      if (elements.xrayScanBtn) elements.xrayScanBtn.disabled = false;
    }
  };

  const finishXrayRun = () => {
    state.xray.running = null;
    if (elements.xrayScanBtn) elements.xrayScanBtn.disabled = false;
  };

  const handleXrayProgress = (msg) => {
    const { phase, status, detail, done } = msg;

    if (!done && phase !== "done") {
      const line = [status, detail].filter(Boolean).join(" ");
      if (line) setXrayStatus(line);
      return;
    }

    if (phase === "error") {
      setXrayStatus(`Failed: ${detail || "unknown error"}`);
      showToast("storage scan failed", "error");
      finishXrayRun();
      return;
    }
    if (phase === "cancelled") {
      setXrayStatus("Stopped.");
      finishXrayRun();
      return;
    }

    if (Array.isArray(msg.scanSenders)) {
      state.xray.senders = GCC.storageXray.rankSenders(msg.scanSenders);
      state.xray.totalMb = Number(msg.totalMb) || 0;
      state.xray.totalCount = Number(msg.totalCount) || 0;
      renderXrayList();
      setXrayStatus(status || "Scan complete.");
      setTimeout(() => { loadStoredStorageScan().catch(() => {}); }, 400);
      showToast("storage scan complete", "success");
    }
    finishXrayRun();
  };

  // Purge = a normal cleanup run scoped by rulesOverride, so it walks
  // the exact same path as the Run button: claim, progress tab, inject.
  const handleXrayPurge = async () => {
    if (state.isRunning || state.xray.running) return;

    if (!state.subs.licenseActive) {
      if (elements.xrayUpsell) elements.xrayUpsell.hidden = false;
      showToast("purging is a Pro feature ($9.99, one-time)", "info");
      return;
    }

    const emails = getCheckedXrayEmails();
    if (!emails.length) {
      showToast("pick at least one sender first", "warning");
      return;
    }

    const age = elements.xrayAge?.value || "";
    const purgeQuery = GCC.storageXray.buildPurgeQuery(emails, age);
    if (!purgeQuery) {
      showToast("no valid senders selected", "warning");
      return;
    }
    const targeted = GCC.storageXray.sanitizeEmails(emails);

    state.isRunning = true;
    try {
      if (!(await GCC.gmailAccess.check())) {
        refreshBanners().catch(() => {});
        setXrayStatus("Allow Gmail access at the top of this popup first.");
        showToast("gmail access needed", "warning");
        state.isRunning = false;
        return;
      }

      const gmailTab = await findGmailTab();
      if (!gmailTab?.id) {
        showOpenGmailHelper();
        state.isRunning = false;
        return;
      }

      const claim = await tryClaimRun(gmailTab.id);
      if (!claim.ok) {
        showToast("a cleanup is already running", "warning");
        state.isRunning = false;
        return;
      }

      const config = await buildConfig();
      config.runId = claim.claim.runId;
      config.rulesOverride = [purgeQuery];
      // The purge query carries its own older_than; the global minimum
      // age would stack a second, stricter filter on top.
      config.minAge = null;

      state.currentGmailTabId = gmailTab.id;
      setXrayStatus(config.dryRun
        ? "Dry run: counting what a purge would remove..."
        : `Purging large mail from ${targeted.length} sender${targeted.length === 1 ? "" : "s"}...`);

      // Register the target list so the background can mark rows
      // purged when the run finishes (this popup will be long closed).
      if (!config.dryRun) {
        GCC.sendMessage({
          type: "gmailCleanerStorageXrayPurgeStarted",
          runId: config.runId,
          senders: targeted
        }).catch(() => {});
      }

      const progressUrl = chrome.runtime.getURL(`progress.html?gmailTabId=${gmailTab.id}`);
      const existingProgress = await findProgressTab(gmailTab.id);
      if (existingProgress?.id) await tabsUpdate(existingProgress.id, { active: true });
      else await tabsCreate({ url: progressUrl, active: true });

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
        showToast("cleanup already running", "warning");
        await clearActiveRun();
        state.isRunning = false;
        return;
      }

      await scriptingExecuteScript({
        target: { tabId: gmailTab.id },
        func: (cfg) => { window.GMAIL_CLEANER_CONFIG = cfg; },
        args: [config]
      });
      await scriptingExecuteScript({
        target: { tabId: gmailTab.id },
        files: ["contentScript.js"]
      });

      await bumpRunCount();
      showToast(config.dryRun ? "purge dry run started" : "purge started", "success");
      setTimeout(safeClosePopup, 200);
    } catch (err) {
      const msg = err?.message || String(err);
      log("error", "handleXrayPurge error:", err);
      setXrayStatus(`Failed to start: ${msg}`);
      showToast(`purge failed: ${msg}`, "error");
      await clearActiveRun();
      state.isRunning = false;
      state.currentGmailTabId = null;
    }
  };

  // =========================
  // Smart Suggestions (7.8)
  // =========================
  // The scan is free and read-only; the full ranked list and bulk
  // apply are Pro. Applying a suggestion is an ordinary cleanup run
  // whose rule set comes from GCC.smart.buildActionRule, so every
  // global guard, tag-before-delete, dry-run, undo and the recap apply
  // unchanged. Dismissals and confirmed applies feed the local
  // feedback map that ranks future suggestions.

  const setSmartStatus = (text) => {
    if (elements.smartStatus) elements.smartStatus.textContent = text || "";
  };

  const getCheckedSmartEmails = () =>
    (elements.smartList
      ? Array.from(elements.smartList.querySelectorAll("input[type='checkbox']:checked"))
      : []
    ).map((cb) => cb.getAttribute("data-email")).filter(Boolean);

  const updateSmartCount = () => {
    if (!elements.smartCount) return;
    const total = state.smart.visibleCount;
    const checked = getCheckedSmartEmails().length;
    elements.smartCount.textContent = checked
      ? `${checked} of ${total} selected`
      : `${total} suggestion${total === 1 ? "" : "s"}`;
  };

  const buildSmartCard = (sender, { withCheckbox }) => {
    const card = document.createElement("div");
    card.className = "subs-row smart-card";
    card.setAttribute("role", "listitem");

    const top = document.createElement("div");
    top.className = "smart-card-top";

    const text = document.createElement("span");
    text.className = "subs-row-text";
    const name = document.createElement("span");
    name.className = "subs-row-name";
    name.textContent = sender.name || sender.email;
    text.appendChild(name);
    if (sender.name) {
      const email = document.createElement("span");
      email.className = "subs-row-email";
      email.textContent = sender.email;
      text.appendChild(email);
    }

    if (withCheckbox) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("data-email", sender.email);
      checkbox.addEventListener("change", updateSmartCount);
      const label = document.createElement("label");
      label.className = "subs-row-label";
      label.appendChild(checkbox);
      label.appendChild(text);
      top.appendChild(label);
    } else {
      top.appendChild(text);
    }

    const reason = document.createElement("div");
    reason.className = "smart-reason";
    reason.textContent = GCC.smart.reasonText(sender);

    const actions = document.createElement("div");
    actions.className = "smart-card-actions";
    const action = GCC.smart.primaryAction(sender);
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "smart-apply-btn";
    applyBtn.textContent = GCC.smart.ACTION_LABELS[action] || "Clean up";
    applyBtn.addEventListener("click", () => handleSmartApply(sender, action));
    actions.appendChild(applyBtn);

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "smart-dismiss-btn";
    dismiss.textContent = "Dismiss";
    dismiss.setAttribute("aria-label", `Dismiss the suggestion for ${sender.email}`);
    dismiss.addEventListener("click", () => handleSmartDismiss(sender.email));
    actions.appendChild(dismiss);

    card.appendChild(top);
    card.appendChild(reason);
    card.appendChild(actions);
    return card;
  };

  const renderSmartList = () => {
    if (!elements.smartList) return;
    elements.smartList.textContent = "";
    const active = state.subs.licenseActive;
    // Vetoes beat any score (whitelist and protected keywords can
    // change after a scan), then feedback-aware ranking.
    const eligible = GCC.smart.recommend(
      state.smart.senders,
      state.smart.feedback,
      { whitelist: state.smart.whitelist, protectKeywords: state.smart.protectKeywords }
    );
    const hasAny = eligible.length > 0;
    state.smart.visibleCount = eligible.length;

    if (elements.smartToolbar) elements.smartToolbar.hidden = !hasAny || !active;
    if (elements.smartBulkBtn) elements.smartBulkBtn.hidden = !hasAny || !active;
    if (elements.smartUpsell) elements.smartUpsell.hidden = active || !hasAny;
    if (elements.smartUpsellText && !active) {
      const hidden = Math.max(0, eligible.length - GCC.smart.LIMITS.FREE_VISIBLE);
      elements.smartUpsellText.textContent = GCC.popupUi.smartUpsellLine(hidden);
    }
    if (!hasAny) {
      updateSmartCount();
      renderAutoPilot();
      return;
    }

    const freeCap = GCC.smart.LIMITS.FREE_VISIBLE;
    const visible = active ? eligible : eligible.slice(0, freeCap);
    for (const sender of visible) {
      elements.smartList.appendChild(buildSmartCard(sender, { withCheckbox: active }));
    }

    if (!active && eligible.length > freeCap) {
      const locked = document.createElement("div");
      locked.className = "xray-locked";
      locked.textContent = GCC.popupUi.smartUpsellLine(eligible.length - freeCap);
      elements.smartList.appendChild(locked);
    }

    updateSmartCount();
    // The Auto-Pilot upsell leads with the fresh suggestion count.
    renderAutoPilot();
  };

  const loadStoredSmartScan = async () => {
    if (!GCC.hasChrome() || !chrome.runtime?.sendMessage) return;
    try {
      state.smart.whitelist = await getWhitelist();
      state.smart.protectKeywords = await getProtectKeywords();
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "gmailCleanerGetSmartScan" }, resolve);
      });
      if (resp?.ok) {
        state.smart.senders = Array.isArray(resp.scan?.senders) ? resp.scan.senders : [];
        state.smart.feedback = resp.feedback && typeof resp.feedback === "object"
          ? resp.feedback
          : { bySender: {} };
        renderSmartList();
      }
    } catch (e) {
      log("warn", "loadStoredSmartScan failed", e);
    }
  };

  // Senders earlier scans already measured ride into the smart scan's
  // discovery phase for free.
  const buildSmartKnownSenders = () => {
    const byEmail = new Map();
    for (const s of state.subs.senders || []) {
      if (!s?.email) continue;
      byEmail.set(s.email, { email: s.email, name: s.name || "", count: Number(s.count) || 1, estMb: 0 });
    }
    for (const s of state.xray.senders || []) {
      if (!s?.email) continue;
      const existing = byEmail.get(s.email);
      if (existing) {
        existing.count = Math.max(existing.count, Number(s.count) || 1);
        existing.estMb = Math.max(existing.estMb, Number(s.estMb) || 0);
      } else {
        byEmail.set(s.email, { email: s.email, name: s.name || "", count: Number(s.count) || 1, estMb: Number(s.estMb) || 0 });
      }
    }
    return [...byEmail.values()].slice(0, 100);
  };

  const handleSmartScan = async () => {
    if (state.smart.running) return;
    try {
      state.smart.running = "smartScan";
      if (elements.smartScanBtn) elements.smartScanBtn.disabled = true;
      setSmartStatus("Scanning for suggestions (this one takes a minute or two)...");
      const tabId = await injectEngineRun(
        {
          runKind: "smartScan",
          debugMode: state.debugMode,
          whitelist: await getWhitelist(),
          protectKeywords: await getProtectKeywords(),
          smartKnownSenders: buildSmartKnownSenders()
        },
        setSmartStatus
      );
      if (tabId === null) {
        state.smart.running = null;
        if (elements.smartScanBtn) elements.smartScanBtn.disabled = false;
      }
    } catch (err) {
      log("error", "smart scan start failed", err);
      showToast(`scan failed: ${err?.message || "unknown error"}`, "error");
      setSmartStatus("");
      state.smart.running = null;
      if (elements.smartScanBtn) elements.smartScanBtn.disabled = false;
    }
  };

  const finishSmartRun = () => {
    state.smart.running = null;
    if (elements.smartScanBtn) elements.smartScanBtn.disabled = false;
  };

  const handleSmartProgress = (msg) => {
    const { phase, status, detail, done } = msg;

    if (!done && phase !== "done") {
      const line = [status, detail].filter(Boolean).join(" ");
      if (line) setSmartStatus(line);
      return;
    }

    if (phase === "error") {
      setSmartStatus(`Failed: ${detail || "unknown error"}`);
      showToast("suggestion scan failed", "error");
      finishSmartRun();
      return;
    }
    if (phase === "cancelled") {
      setSmartStatus("Stopped.");
      finishSmartRun();
      return;
    }

    if (Array.isArray(msg.scanSenders)) {
      setSmartStatus(status || "Scan complete.");
      // The worker union-merges rescans; read the authoritative list
      // back after it lands.
      setTimeout(() => { loadStoredSmartScan().catch(() => {}); }, 400);
      showToast("suggestion scan complete", "success");
      if (elements.smartSection) elements.smartSection.open = true;
    }
    finishSmartRun();
  };

  // One shared runner for single-card apply and Pro bulk apply: a
  // normal cleanup scoped by rulesOverride, with the pending-apply
  // marker stamped pre-inject so the worker can confirm "applied" on
  // the matching done message (the popup closes long before then).
  const startSmartApplyRun = async (emails, queries, archive) => {
    if (state.isRunning || state.smart.running) return;

    state.isRunning = true;
    try {
      if (!(await GCC.gmailAccess.check())) {
        refreshBanners().catch(() => {});
        setSmartStatus("Allow Gmail access at the top of this popup first.");
        showToast("gmail access needed", "warning");
        state.isRunning = false;
        return;
      }

      const gmailTab = await findGmailTab();
      if (!gmailTab?.id) {
        showOpenGmailHelper();
        state.isRunning = false;
        return;
      }

      const claim = await tryClaimRun(gmailTab.id);
      if (!claim.ok) {
        showToast("a cleanup is already running", "warning");
        state.isRunning = false;
        return;
      }

      const config = await buildConfig();
      config.runId = claim.claim.runId;
      config.rulesOverride = queries;
      // The suggestion's query carries its own age scope; the global
      // minimum age would stack a second, stricter filter on top.
      config.minAge = null;
      // The suggestion names its own action; it overrides the form's
      // action dropdown for this run only.
      config.archiveInsteadOfDelete = Boolean(archive);

      state.currentGmailTabId = gmailTab.id;
      setSmartStatus(config.dryRun
        ? "Dry run: counting what this suggestion would clean..."
        : `Cleaning up ${emails.length} sender${emails.length === 1 ? "" : "s"}...`);

      if (!config.dryRun) {
        GCC.sendMessage({
          type: "gmailCleanerSmartApplyStarted",
          runId: config.runId,
          senders: emails
        }).catch(() => {});
      }

      const progressUrl = chrome.runtime.getURL(`progress.html?gmailTabId=${gmailTab.id}`);
      const existingProgress = await findProgressTab(gmailTab.id);
      if (existingProgress?.id) await tabsUpdate(existingProgress.id, { active: true });
      else await tabsCreate({ url: progressUrl, active: true });

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
        showToast("cleanup already running", "warning");
        await clearActiveRun();
        state.isRunning = false;
        return;
      }

      await scriptingExecuteScript({
        target: { tabId: gmailTab.id },
        func: (cfg) => { window.GMAIL_CLEANER_CONFIG = cfg; },
        args: [config]
      });
      await scriptingExecuteScript({
        target: { tabId: gmailTab.id },
        files: ["contentScript.js"]
      });

      await bumpRunCount();
      showToast(config.dryRun ? "suggestion dry run started" : "suggestion applied", "success");
      setTimeout(safeClosePopup, 200);
    } catch (err) {
      const msg = err?.message || String(err);
      log("error", "startSmartApplyRun error:", err);
      setSmartStatus(`Failed to start: ${msg}`);
      showToast(`apply failed: ${msg}`, "error");
      await clearActiveRun();
      state.isRunning = false;
      state.currentGmailTabId = null;
    }
  };

  const handleSmartApply = async (sender, action) => {
    const rule = GCC.smart.buildActionRule(sender, action);
    if (!rule) {
      showToast("could not build a safe rule for this sender", "warning");
      return;
    }

    // The unsubscribe action rides the existing Pro path with its
    // existing gate; everything else is a free cleanup run.
    if (rule.runKind === "unsubscribe") {
      if (!state.subs.licenseActive) {
        if (elements.smartUpsell) elements.smartUpsell.hidden = false;
        showToast("bulk unsubscribe is a Pro feature ($9.99, one-time)", "info");
        return;
      }
      if (state.subs.running) return;
      state.subs.running = "unsubscribe";
      setSmartStatus(`Unsubscribing from ${sender.email}...`);
      const tabId = await injectSubscriptionRun("unsubscribe", rule.senders);
      if (tabId === null) state.subs.running = null;
      return;
    }

    await startSmartApplyRun([sender.email], [rule.query], rule.archive);
  };

  const handleSmartBulkApply = async () => {
    if (!state.subs.licenseActive) {
      if (elements.smartUpsell) elements.smartUpsell.hidden = false;
      showToast("bulk apply is a Pro feature ($9.99, one-time)", "info");
      return;
    }
    const emails = getCheckedSmartEmails();
    if (!emails.length) {
      showToast("pick at least one suggestion first", "warning");
      return;
    }
    const query = GCC.smart.buildBulkRule(emails);
    if (!query) {
      showToast("no valid senders selected", "warning");
      return;
    }
    // Marker list = the sanitized set the query actually targets.
    const targeted = GCC.storageXray.sanitizeEmails(emails);
    await startSmartApplyRun(targeted, [query], false);
  };

  const handleSmartDismiss = (email) => {
    state.smart.feedback = GCC.smart.recordFeedback(state.smart.feedback, email, "dismissed");
    renderSmartList();
    GCC.sendMessage({ type: "gmailCleanerSmartFeedback", email, action: "dismissed" }).catch(() => {});
    showToast("dismissed for 90 days", "info");
  };

  // Open state persists across popup opens, same local-flag pattern
  // as the Advanced disclosure.
  const initSmartDisclosure = async () => {
    if (!elements.smartSection) return;
    const r = await storageGet("local", STORAGE_KEYS.SMART_OPEN);
    elements.smartSection.open = Boolean(r?.[STORAGE_KEYS.SMART_OPEN]);
    elements.smartSection.addEventListener("toggle", () => {
      storageSet("local", {
        [STORAGE_KEYS.SMART_OPEN]: Boolean(elements.smartSection.open)
      }).catch(() => {});
    });
  };

  // =========================
  // Auto-Pilot (7.12, Pro)
  // =========================
  // The worker owns the schedule and the sweeps; the popup only reads
  // the settings snapshot and flips the toggle. Free users see the
  // toggle locked with the usual number-led upsell. The preview
  // confirm is an inline button (window.confirm is a silent no-op in
  // Firefox popups): until it is clicked every scheduled sweep stays a
  // dry run.

  const renderAutoPilot = () => {
    if (!elements.autoPilotToggle) return;
    const active = state.subs.licenseActive;
    const ap = state.autoPilot;

    elements.autoPilotToggle.disabled = !active;
    elements.autoPilotToggle.checked = Boolean(active && ap?.enabled);
    syncSwitchAria(elements.autoPilotToggle);

    if (elements.autoPilotUpsell) elements.autoPilotUpsell.hidden = active;
    if (elements.autoPilotUpsellText && !active) {
      elements.autoPilotUpsellText.textContent =
        GCC.popupUi.autoPilotUpsellLine(state.smart.visibleCount);
    }
    if (elements.autoPilotBuyLink) elements.autoPilotBuyLink.href = GCC.license.PRO.BUY_URL;

    let statusText = "";
    if (active && ap?.enabled) {
      if (ap.pendingStage) {
        statusText = "A sweep is running right now.";
      } else if (ap.lastRun && ap.lastRun.at) {
        const n = Math.max(0, Number(ap.lastRun.count) || 0);
        const verb = ap.lastRun.dryRun ? "would have archived" : "archived";
        statusText = `Last sweep ${verb} ${GCC.formatNumber(n)} email${n === 1 ? "" : "s"}, ${GCC.relativeTime(ap.lastRun.at)}.`;
      } else {
        statusText = "First sweep runs soon as a preview. Nothing is archived until you confirm below.";
      }
    }
    if (elements.autoPilotStatus) elements.autoPilotStatus.textContent = statusText;

    const showConfirm = Boolean(active && ap?.enabled && !ap?.confirmed && ap?.preview);
    if (elements.autoPilotConfirm) elements.autoPilotConfirm.hidden = !showConfirm;
    if (showConfirm && elements.autoPilotConfirmText) {
      const n = Math.max(0, Number(ap.preview.count) || 0);
      elements.autoPilotConfirmText.textContent =
        `Auto-Pilot preview: would have archived ${GCC.formatNumber(n)} email${n === 1 ? "" : "s"}. Turn on for real?`;
    }
  };

  const loadAutoPilot = async () => {
    if (GCC.hasChrome() && chrome.runtime?.sendMessage) {
      const resp = await GCC.sendMessage({ type: "gmailCleanerGetAutoPilot" });
      if (resp?.ok && resp.autoPilot) state.autoPilot = resp.autoPilot;
    }
    renderAutoPilot();
  };

  const handleAutoPilotToggle = async () => {
    const wanted = Boolean(elements.autoPilotToggle?.checked);
    if (!state.subs.licenseActive) {
      elements.autoPilotToggle.checked = false;
      syncSwitchAria(elements.autoPilotToggle);
      if (elements.autoPilotUpsell) elements.autoPilotUpsell.hidden = false;
      showToast("Auto-Pilot is a Pro feature ($9.99, one-time)", "info");
      return;
    }
    const resp = await GCC.sendMessage({ type: "gmailCleanerSetAutoPilot", enabled: wanted });
    if (resp?.ok && resp.autoPilot) {
      state.autoPilot = resp.autoPilot;
      showToast(
        wanted ? "Auto-Pilot on - the first sweep is a preview" : "Auto-Pilot off",
        wanted ? "success" : "info"
      );
    } else {
      showToast(
        resp?.error === "pro_required"
          ? "Auto-Pilot needs an active Pro license"
          : "could not update Auto-Pilot",
        "warning"
      );
    }
    renderAutoPilot();
  };

  const handleAutoPilotConfirm = async () => {
    const resp = await GCC.sendMessage({ type: "gmailCleanerConfirmAutoPilot" });
    if (resp?.ok && resp.autoPilot) {
      state.autoPilot = resp.autoPilot;
      showToast("Auto-Pilot is live - weekly sweeps now archive for real", "success");
    } else {
      showToast("could not confirm Auto-Pilot", "warning");
    }
    renderAutoPilot();
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
  // Share
  // =========================

  const setupShare = () => {
    if (!elements.shareBtn) return;
    elements.shareBtn.addEventListener("click", async () => {
      // Firefox users share the AMO listing; Chrome, Edge and other
      // Chromiums share the Chrome Web Store one (installable in all).
      const url = GCC.storeLinks().listing + "?utm_source=share";
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

      // Enter runs cleaner (but not while a select is focused, and not
      // on a tab, where Enter must activate the tab itself)
      if (e.key === "Enter" && !e.repeat) {
        const active = document.activeElement;
        const tag = active?.tagName;
        const isFormControl = tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA";
        const isTab = active?.getAttribute?.("role") === "tab";
        if (!isFormControl && !isTab && !state.isRunning) {
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

        // 7.0/7.2: auxiliary engine messages carry runKind and have
        // their own UI; keep them out of the cleanup progress logic.
        if (msg.runKind === "storageScan") {
          handleXrayProgress(msg);
          return;
        }
        // 7.8: the suggestion scan renders into the Suggested section.
        if (msg.runKind === "smartScan") {
          handleSmartProgress(msg);
          return;
        }
        // 7.6: restore runs are started and watched from the recovery
        // log on the Stats page; the popup has no surface for them.
        if (msg.runKind === "restoreRun") return;
        if (msg.runKind) {
          handleSubsProgress(msg);
          return;
        }

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
          state.tabs?.select("tabClean");
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
          state.tabs?.select("tabClean");
          setStatus(`error: ${m}`, STATUS_TYPES.ERROR);
          showToast(`failed: ${m}`, "error");
          // 7.4: layout-change errors carry a machine-readable code; the
          // detail already explains it, so just point at Diagnostics.
          if (msg.code === "gmail_layout_changed") {
            showToast("open Diagnostics (footer) for run details and updates", "info", 6000);
          }
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
          const freedMb = Number(stats?.totalFreedMb || 0);
          const freedBytes = freedMb * 1024 * 1024;

          // The result view replaces the Clean form; jump there so the
          // outcome is visible even if another tab had focus.
          state.tabs?.select("tabClean");
          hideRecapNote();
          showResultState();
          showResultSummary({ count, freedBytes, action });

          // 7.4: a live result counts as seen; without the marker this
          // same run would come back as a recap on the next open.
          markRecapSeen().catch(() => {});

          showSuccessCtas();
          maybeShowRatingForRun({
            dryRun: stats?.mode === "dry",
            cleaned: count,
            freedMb
          }).catch(() => {});
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

          // If this run was an X-ray purge, the background just marked
          // the senders; refresh the stored scan so chips update.
          setTimeout(() => { loadStoredStorageScan().catch(() => {}); }, 600);
          // Same for a smart apply: the worker just recorded the
          // "applied" feedback; refresh so ranking reflects it.
          setTimeout(() => { loadStoredSmartScan().catch(() => {}); }, 600);
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
        // Any config change invalidates an armed deep-clean confirm.
        disarmDeepConfirm();
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
      // Reviews land on the store this browser installed from.
      await tabsCreate({ url: GCC.storeLinks().reviews, active: true });
      dismissRatingPrompt();
      setTimeout(safeClosePopup, 150);
    });
    elements.ratingDismiss?.addEventListener("click", dismissRatingPrompt);

    // 7.3: leave the post-run result view and return to the form.
    elements.resultBackBtn?.addEventListener("click", () => {
      showFormState();
      elements.runBtn?.focus();
    });

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

    // 7.0 subscriptions
    elements.scanSubsBtn?.addEventListener("click", handleScanSubscriptions);
    elements.unsubBtn?.addEventListener("click", handleUnsubscribe);
    elements.subsSelectAll?.addEventListener("change", () => {
      const checked = !!elements.subsSelectAll.checked;
      elements.subsList
        ?.querySelectorAll("input[type='checkbox']:not(:disabled)")
        .forEach((cb) => { cb.checked = checked; });
      updateSubsCount();
    });

    // 7.2 storage X-ray
    elements.xrayScanBtn?.addEventListener("click", handleScanStorage);
    elements.xrayPurgeBtn?.addEventListener("click", handleXrayPurge);
    elements.xraySelectAll?.addEventListener("change", () => {
      const checked = !!elements.xraySelectAll.checked;
      elements.xrayList
        ?.querySelectorAll("input[type='checkbox']:not(:disabled)")
        .forEach((cb) => { cb.checked = checked; });
      updateXrayCount();
    });
    const openProOptions = async () => {
      await tabsCreate({ url: chrome.runtime.getURL("options.html#pro"), active: true });
      setTimeout(safeClosePopup, 150);
    };
    elements.subsEnterKey?.addEventListener("click", openProOptions);
    elements.proPromoKey?.addEventListener("click", openProOptions);
    elements.footerProBtn?.addEventListener("click", openProOptions);
    elements.xrayEnterKey?.addEventListener("click", openProOptions);
    elements.smartEnterKey?.addEventListener("click", openProOptions);

    // 7.8 Smart Suggestions
    elements.smartScanBtn?.addEventListener("click", handleSmartScan);
    elements.smartBulkBtn?.addEventListener("click", handleSmartBulkApply);
    elements.smartSelectAll?.addEventListener("change", () => {
      const checked = !!elements.smartSelectAll.checked;
      elements.smartList
        ?.querySelectorAll("input[type='checkbox']:not(:disabled)")
        .forEach((cb) => { cb.checked = checked; });
      updateSmartCount();
    });

    // 7.12 Auto-Pilot. A disabled checkbox fires no change event, so
    // the locked-state pitch hangs off a click on the label itself.
    elements.autoPilotToggle?.addEventListener("change", handleAutoPilotToggle);
    elements.autoPilotConfirmBtn?.addEventListener("click", handleAutoPilotConfirm);
    elements.autoPilotToggle?.closest("label")?.addEventListener("click", () => {
      if (state.subs.licenseActive) return;
      if (elements.autoPilotUpsell) elements.autoPilotUpsell.hidden = false;
      showToast("Auto-Pilot is a Pro feature ($9.99, one-time)", "info");
    });

    // 7.1 Gmail host access grant (must run inside this click gesture)
    elements.gmailAccessBtn?.addEventListener("click", async () => {
      const granted = await GCC.gmailAccess.request();
      if (granted) {
        await refreshBanners();
        setStatus("", STATUS_TYPES.INFO);
        showToast("gmail access granted", "success");
      } else {
        showToast("access was not granted", "warning");
      }
    });

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

    // 7.3: tab bar (WAI-ARIA tabs semantics live in GCC.tablist).
    state.tabs = GCC.tablist(elements.tabBar);

    setupEventListeners();

    await initAdvancedDisclosure();
    await restoreLastConfig();
    await restoreActiveRunUI();
    // 7.4: replay the last unseen cleanup (active runs win inside).
    await maybeShowPostRunRecap().catch((e) => log("warn", "recap failed", e));
    await refreshBanners();
    await maybeShowOnboarding();

    loadGmailAccounts();
    loadWhitelistSuggestions();

    // 7.0 subscriptions: license badge + last scan (both best-effort).
    refreshLicenseUi().catch((e) => log("warn", "license ui failed", e));
    loadStoredSubscriptions().catch((e) => log("warn", "subs load failed", e));
    // 7.2 storage X-ray: last scan (best-effort).
    loadStoredStorageScan().catch((e) => log("warn", "xray load failed", e));
    // 7.8 Smart Suggestions: disclosure state + stored scan.
    await initSmartDisclosure();
    loadStoredSmartScan().catch((e) => log("warn", "smart load failed", e));
    // 7.12 Auto-Pilot: settings snapshot (best-effort).
    loadAutoPilot().catch((e) => log("warn", "autopilot load failed", e));

    log("info", "ready");
  };

  init().catch((e) => {
    console.error("[Gmail Cleaner Popup] init failed:", e);
    setStatus("init error", STATUS_TYPES.ERROR);
  });
});
