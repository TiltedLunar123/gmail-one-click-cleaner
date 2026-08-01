// popup.js
document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  // 7.13: swap the inline English for catalog messages BEFORE anything
  // captures label text (originalLabel below must see the final copy).
  // No-ops outside a real extension context, so tests and the plain
  // HTTP render harness keep their English markup.
  GCC.i18n.apply(document);
  const t = GCC.i18n.t;

  // =========================
  // Constants & Configuration
  // =========================

  const POPUP_VERSION = "8.2.0";

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

    // 8.0: which tab was open last. The popup used to reset to Clean on
    // every open, so a user working through the report or a sender list
    // had to re-navigate every single time.
    ACTIVE_TAB: "activeTab",

    // 8.0: which senders were ticked on the Unsubscribe tab. The
    // license check ran BEFORE the checkboxes were read and then closed
    // the popup, so the people who lost their triage were exactly the
    // people who had just decided to pay.
    SUBS_CHECKED: "subsCheckedEmails",

    // 8.0: the "Bought Pro? Paste your key" strip, dismissed.
    ACTIVATE_HINT_DISMISSED: "activateHintDismissed",

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
    // True only when THIS popup instance injected the running engine.
    // Distinguishes "my run" from a schedule or Auto-Pilot sweep the popup
    // merely detected through the active-run marker.
    startedRunHere: false,
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
      running: null,
      // 8.0: which senders were ticked, so a trip to checkout does not
      // throw the triage away.
      checked: new Set()
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

    // 8.0 Mailbox Report: the stored band scan and which report run
    // (if any) this popup instance is watching.
    report: {
      bands: [],
      cleanableCount: 0,
      largeMb: 0,
      topSenders: [],
      updatedAt: 0,
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

  // Reports whether the reload actually happened, so a caller can fall
  // back to a fresh tab when the old one turned out to be gone.
  const tabsReload = async (tabId) => {
    if (!GCC.hasChromeTabs() || typeof chrome.tabs.reload !== "function") return false;
    try {
      await GCC.promisify(chrome.tabs.reload.bind(chrome.tabs), tabId);
      return true;
    } catch (e) {
      log("warn", "tabs.reload failed", e);
      return false;
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
    skipUnreadEl: $("skipUnread"),
    skipLabeledEl: $("skipLabeled"),

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

    rateBtn: $("rateBtn"),
    shareBtn: $("shareBtn"),

    toastContainer: $("toastContainer"),
    accountSelector: $("accountSelector"),
    openStatsBtn: $("openStats"),

    // 5.0
    themeSwitcher: $("themeSwitcher"),
    snoozeBanner: $("snoozeBanner"),
    snoozeBannerText: $("snoozeBannerText"),

    // 7.1 Gmail host access (Firefox lets users revoke it)
    gmailAccessBanner: $("gmailAccessBanner"),
    gmailAccessBtn: $("gmailAccessBtn"),

    // 7.13 install-source guard
    installSourceBanner: $("installSourceBanner"),
    installSourceStoreBtn: $("installSourceStoreBtn"),
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

    // 8.0 Mailbox Report
    tabReport: $("tabReport"),
    tabUnsubLock: $("tabUnsubLock"),
    tabStorageLock: $("tabStorageLock"),
    reportStamp: $("reportStamp"),
    reportIntro: $("reportIntro"),
    reportScanBtn: $("reportScanBtn"),
    reportScanLabel: $("reportScanLabel"),
    reportScanSub: $("reportScanSub"),
    reportStatus: $("reportStatus"),
    reportHero: $("reportHero"),
    reportHeroCount: $("reportHeroCount"),
    reportHeroLabel: $("reportHeroLabel"),
    reportHeroMb: $("reportHeroMb"),
    reportList: $("reportList"),
    reportPlanBtn: $("reportPlanBtn"),
    reportPlanBtnSub: $("reportPlanBtnSub"),
    reportUpsell: $("reportUpsell"),
    reportUpsellText: $("reportUpsellText"),
    reportBuyLink: $("reportBuyLink"),
    reportEnterKey: $("reportEnterKey"),
    autoPilotProPill: $("autoPilotProPill"),
    reportNote: $("reportNote"),

    // 8.0 Pro proof panel
    proPanel: $("proPanel"),
    proPanelLead: $("proPanelLead"),
    proPanelBuy: $("proPanelBuy"),
    proPanelKey: $("proPanelKey"),
    proPanelBack: $("proPanelBack"),
    proPanelClose: $("proPanelClose"),
    activateHint: $("activateHint"),
    activateHintBtn: $("activateHintBtn"),
    activateHintClose: $("activateHintClose"),
    rateBtnLabel: $("rateBtnLabel"),

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
      label: t("btnStarted", "started"),
      sub: t("btnStartedSub", "check the progress tab"),
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
    if (note) {
      note.textContent = action === "archive"
        ? t("resultArchiveNote", "(all archived to All Mail)")
        : t("resultTrashNote", "(all moved to Trash)");
    }
    elements.resultSummary.classList.add("show");
  };

  const hideResultSummary = () => {
    elements.resultSummary?.classList.remove("show");
  };

  // 8.0: the Rate button here used to show after EVERY run, including
  // dry runs and two-email maintenance sweeps, which walked straight
  // around the deliberately gated ask in #ratingPrompt. It now answers
  // to the same rule.
  const showSuccessCtas = (run) => {
    elements.successCtas?.classList.add("show");
    if (!elements.rateBtn) return;
    const earned = !run || GCC.popupUi.ratingRunQualifies(run);
    elements.rateBtn.hidden = !earned;
  };
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
    guardSkipImportant: Boolean(elements.skipImportantEl?.checked),
    // Sent explicitly, because the engine reads a MISSING key as "on"
    // (`config.guardSkipUnread !== false`). Leaving them out was what
    // made both guards permanent and invisible.
    guardSkipUnread: Boolean(elements.skipUnreadEl?.checked),
    guardSkipUserLabels: Boolean(elements.skipLabeledEl?.checked)
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
    // Restored with `!== false` so a config saved before these existed
    // keeps the old behaviour instead of silently switching the guards off.
    if (elements.skipUnreadEl) elements.skipUnreadEl.checked = ui.guardSkipUnread !== false;
    if (elements.skipLabeledEl) elements.skipLabeledEl.checked = ui.guardSkipUserLabels !== false;

    [elements.dryRunEl, elements.reviewModeEl, elements.safeModeEl,
     elements.skipStarredEl, elements.skipImportantEl,
     elements.skipUnreadEl, elements.skipLabeledEl].forEach(syncSwitchAria);
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

  // With an expectedRunId this only drops the marker when it is still
  // the one we claimed. Start paths pass theirs so that an error on the
  // way up (no Gmail tab, scripting refused) cannot wipe the claim of a
  // different run that is genuinely in flight. Terminal handlers still
  // clear unconditionally: by then the run they describe is over.
  const clearActiveRun = async (expectedRunId = null) => {
    if (expectedRunId) {
      const current = await getActiveRun();
      if (current && current.runId !== expectedRunId) return;
    }
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
        // 7.15: lastConfig is not a preferences record, it is what the
        // progress page re-injects with. A Storage X-ray purge or a Smart
        // apply writes a SENDER-SCOPED config there, and buildConfig()
        // only knows about target presets, so toggling any control in a
        // reopened popup while that run was live replaced the scope with
        // the full rule set. A later reconnect then swept everything the
        // rules match instead of the handful of senders the user picked.
        // While a run holds the marker, the UI snapshot is still worth
        // saving; the config it would run with is not.
        const cfg = await buildConfig();
        if (await getActiveRun()) {
          await storageSet("session", { [STORAGE_KEYS.LAST_UI]: captureUiSnapshot() });
          await storageSet("local", { [STORAGE_KEYS.LAST_UI]: captureUiSnapshot() });
          log("info", "autosaved ui only (run in progress)");
          return;
        }
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
        pill.textContent = tab.title
          ? tab.title.replace(/ - Gmail.*$/, "").slice(0, 25)
          : t("accountPill", "Account " + tab.account, [String(tab.account)]);
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

  // 7.12: no Gmail tab is not the user's problem to fix. Every run
  // path opens one automatically and waits for it to finish loading.
  // The tab opens in the BACKGROUND on purpose: an active tab steals
  // focus, which closes this popup and kills the run mid-start (the
  // engine drives background Gmail tabs fine; schedules always have).
  // On failure the reason lands in setStatusFn and null comes back.
  const GMAIL_OPEN_TIMEOUT_MS = 30000;

  const openGmailAndWait = async (setStatusFn) => {
    setStatusFn(t("gmailOpening", "No Gmail tab open. Opening Gmail for you..."));
    const created = await tabsCreate({ url: CONFIG.GMAIL_INBOX_URL, active: false });
    if (!created?.id) {
      setStatusFn(t("gmailOpenFailed", "Could not open Gmail. Open mail.google.com and try again."));
      return null;
    }
    showToast(t("gmailOpeningToast", "opening gmail in the background…"), "info");
    const deadline = Date.now() + GMAIL_OPEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await GCC.sleep(400);
      let tab = null;
      try {
        tab = await GCC.promisify(chrome.tabs.get.bind(chrome.tabs), created.id);
      } catch {
        setStatusFn(t("gmailTabClosedEarly", "The Gmail tab closed before it finished loading."));
        return null;
      }
      if (tab?.status !== "complete") continue;
      if (tab.url?.startsWith(CONFIG.GMAIL_URL)) {
        // Let the Gmail app paint before the engine starts querying.
        await GCC.sleep(1200);
        return tab;
      }
      // Signed-out profiles bounce to accounts.google.com, where the
      // extension has no host access and injection cannot work.
      if (tab.url) {
        await tabsUpdate(tab.id, { active: true });
        setStatusFn(t("gmailSignInFirst", "Sign in to Gmail in the tab that just opened, then run again."));
        return null;
      }
    }
    setStatusFn(t("gmailTooSlow", "Gmail is taking too long to load. Try again in a moment."));
    return null;
  };

  // Every run kind funnels through here: reuse an open Gmail tab or
  // auto-open one and wait for it.
  const findOrOpenGmailTab = async (setStatusFn) => {
    const existing = await findGmailTab();
    if (existing?.id) return existing;
    return await openGmailAndWait(setStatusFn);
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

  // A progress page never leaves its finished state once a run ends, so
  // merely focusing a leftover tab for a NEW run handed the user a dead
  // dashboard: Cancel stayed disabled reading "Run finished" and the
  // auto-reconnect was already stopped. Reusing the tab now reloads it.
  // The reload is explicit rather than a re-navigation to the same URL,
  // because tabs.update is only documented to navigate, and the URL a
  // leftover tab already carries is the one we would navigate it to.
  // Callers run the already-attached guard first, so in the ordinary
  // case no live dashboard is reachable here; a run whose tab refuses
  // the attached probe can still be reloaded, and that page reconnects
  // on load, costing only the log lines already on screen.
  const openProgressTab = async (gmailTabId) => {
    const progressUrl = chrome.runtime.getURL(`progress.html?gmailTabId=${gmailTabId}`);
    const existing = await findProgressTab(gmailTabId);
    if (!existing?.id) {
      await tabsCreate({ url: progressUrl, active: true });
      return;
    }
    // findProgressTab matched this tab on the same gmailTabId, so it is
    // already pointed at the right URL and only needs a fresh document.
    if (!(await tabsReload(existing.id))) {
      await tabsCreate({ url: progressUrl, active: true });
      return;
    }
    await tabsUpdate(existing.id, { active: true });
  };

  // True when the engine is already running in that tab. A tab that
  // cannot answer reads as not attached, so the injection still gets its
  // attempt and surfaces the real error instead of a wrong refusal.
  const isEngineAttached = async (tabId) => {
    try {
      const [result] = await scriptingExecuteScript({
        target: { tabId },
        func: () => !!window.GCC_ATTACHED
      });
      return result?.result === true;
    } catch {
      return false;
    }
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

    showToast(t("monthlyApplied", "monthly preset applied"), "success");
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
      showToast(t("targetCleared", "target cleared - using full rule set"), "info");
      return;
    }

    state.activePreset = key;
    state.rulesOverride = preset.rules.slice();
    updateTargetChips();

    const chipKeys = { promotions: "chipPromotions", attachments: "chipAttachments", social: "chipSocial", noreply: "chipNoreply" };
    const localizedLabel = t(chipKeys[key] || "", preset.label);
    showToast(t("targetingOnly", `targeting ${preset.label.toLowerCase()} only`, [localizedLabel]), "success");
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
    const [accessOk, snoozeUntil, pinFlag, pinned, installType] = await Promise.all([
      GCC.gmailAccess.check(),
      getSnoozeUntil(),
      storageGet("local", STORAGE_KEYS.PIN_DISMISSED),
      getPinnedState(),
      GCC.installSource.get()
    ]);

    const which = GCC.popupUi.pickBanner({
      sourceUntrusted: GCC.installSource.isUntrusted(installType),
      accessNeeded: !accessOk,
      snoozed: Boolean(snoozeUntil),
      pinEligible: !pinFlag?.[STORAGE_KEYS.PIN_DISMISSED] && pinned !== true
    });

    if (which === "snooze" && elements.snoozeBannerText) {
      const days = Math.max(1, Math.ceil((snoozeUntil - Date.now()) / (24 * 60 * 60 * 1000)));
      elements.snoozeBannerText.textContent = days === 1
        ? t("snoozeOneDay", "Schedules snoozed (~1 day left). Manual runs still work.")
        : t("snoozeManyDays", `Schedules snoozed (~${days} days left). Manual runs still work.`, [String(days)]);
    }

    elements.installSourceBanner?.classList.toggle("show", which === "source");
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
    const stored = r?.[STORAGE_KEYS.RATING_DISMISSED];
    // A legacy `true` carries no date, so stamp one now and let the TTL
    // run from here rather than either forgetting the dismissal or
    // honouring it forever.
    if (stored === true) {
      await storageSet("local", { [STORAGE_KEYS.RATING_DISMISSED]: Date.now() });
      hideRatingPrompt();
      return;
    }
    if (ratingDismissalActive(stored)) {
      hideRatingPrompt();
      return;
    }
    elements.ratingPrompt.classList.add("show");
  };

  // 8.0: "Maybe later" used to mean "never again for the life of this
  // install", which permanently silenced the ask on a listing whose
  // weakest ranking input is its handful of ratings. It now expires
  // after 90 days, the same TTL the suggestion dismissals already use.
  // A legacy `true` (written before this change) is honoured for that
  // same window from now rather than reset, so nobody is re-prompted
  // the day they update.
  const RATING_DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 90;

  const ratingDismissalActive = (stored) => {
    if (!stored) return false;
    const at = Number(stored);
    // Unparseable means "dismissed at some unknown time"; staying quiet
    // is the polite failure.
    if (!Number.isFinite(at) || at <= 0) return true;
    return Date.now() - at < RATING_DISMISS_TTL_MS;
  };

  const dismissRatingPrompt = async () => {
    elements.ratingPrompt?.classList.remove("show");
    await storageSet("local", { [STORAGE_KEYS.RATING_DISMISSED]: Date.now() });
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
      const when = GCC.relativeTime(entry.timestamp);
      elements.recapNote.textContent =
        t("recapDynamic", `Recap: your last cleanup finished ${when}, while the popup was closed.`, [when]);
      elements.recapNote.hidden = false;
    }
    showSuccessCtas({ dryRun: false, cleaned, freedMb });
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
      guardSkipUnread: elements.skipUnreadEl?.checked ?? true,
      guardSkipUserLabels: elements.skipLabeledEl?.checked ?? true,
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
    // 8.1: Maximum arms the same guard as Deep. It reaches younger mail
    // and uncategorised bulk, so it is the last thing that should ever
    // start on a single click.
    const needsArming = intensity === "deep" || intensity === "maximum";
    if (needsArming && !elements.dryRunEl?.checked) {
      if (!state.deepConfirmArmed) {
        state.deepConfirmArmed = true;
        const isMax = intensity === "maximum";
        setRunButtonState({
          disabled: false,
          label: isMax
            ? t("maxConfirmLabel", "confirm maximum clean?")
            : t("deepConfirmLabel", "confirm deep clean?"),
          sub: t("deepConfirmSub", "click again to run it - dry run is the safe preview"),
          state: BUTTON_STATES.IDLE
        });
        setStatus(isMax
          ? t("maxConfirmStatus", "maximum reaches recent mail and your Inbox - click run again to confirm")
          : t("deepConfirmStatus", "deep targets many categories - click run again to confirm"), STATUS_TYPES.WARNING);
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
      setStatus(t("allowAccessStatus", "allow Gmail access above, then run again"), STATUS_TYPES.WARNING);
      showToast(t("accessNeededToast", "gmail access needed"), "warning");
      return;
    }

    state.isRunning = true;
    showFormState();

    setRunButtonState({
      disabled: true,
      label: t("btnStarting", "starting…"),
      sub: t("btnStartingSub", "finding gmail tab"),
      state: BUTTON_STATES.LOADING
    });
    setStatus(t("findingTabStatus", "finding a gmail tab…"), STATUS_TYPES.RUNNING);
    showProgress(10);

    let claimedRunId = null;
    try {
      const gmailTab = await findOrOpenGmailTab((m) => setStatus(m, STATUS_TYPES.RUNNING));
      if (!gmailTab?.id) {
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
            ? t("alreadyRunningToast", "a cleanup is already running")
            : t("otherPopupToast", "another popup just started a cleanup"),
          "warning"
        );
        setStatus(t("alreadyInProgress", "cleanup already in progress"), STATUS_TYPES.WARNING, true);
        resetRunButton();
        hideProgress();
        state.isRunning = false;
        return;
      }
      claimedRunId = claim.claim.runId;

      state.currentGmailTabId = gmailTab.id;
      state.startedRunHere = true;
      showQuickActions();
      updateProgress(30);

      const config = await buildConfig();
      config.runId = claimedRunId;
      await persistLastConfig(config);

      setRunButtonState({
        disabled: true,
        label: config.dryRun ? t("btnDryRunning", "dry-run…") : t("btnRunning", "running…"),
        sub: config.dryRun
          ? t("btnCountingSub", "counting matches")
          : (config.archiveInsteadOfDelete
            ? t("btnMovingArchiveSub", "tagging then moving to all mail")
            : t("btnMovingTrashSub", "tagging then moving to trash")),
        state: BUTTON_STATES.RUNNING
      });

      setStatus(
        config.dryRun
          ? t("dryStartedStatus", "dry-run started, opening progress…")
          : t("liveStartedStatus", "live started, opening progress…"),
        STATUS_TYPES.RUNNING
      );
      updateProgress(55);

      // Refuse before anything opens: a run already attached to this
      // Gmail tab leaves this one nothing to start, and opening a
      // dashboard for it would only strand the user on a page that never
      // receives an update.
      if (await isEngineAttached(gmailTab.id)) {
        log("info", "Content script already attached, skipping injection");
        showToast(t("alreadyRunningToast", "a cleanup is already running"), "warning");
        await clearActiveRun(claimedRunId);
        claimedRunId = null;
        resetRunButton();
        hideProgress();
        state.isRunning = false;
        return;
      }

      // Progress page opens before the injection because this popup
      // usually closes as soon as that tab takes focus.
      await openProgressTab(gmailTab.id);
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

      // "Successful start" counter (best effort)
      await bumpRunCount();

      updateProgress(100);
      showButtonSuccess();
      showToast(t("cleanupStartedToast", "cleanup started"), "success");

      setTimeout(safeClosePopup, 200);
    } catch (err) {
      const msg = err?.message || String(err);
      log("error", "runCleanup error:", err);

      setStatus(t("errorPrefix", `error: ${msg}`, [msg]), STATUS_TYPES.ERROR);
      showToast(t("failedPrefix", `failed: ${msg}`, [msg]), "error");

      resetRunButton();
      hideProgress();
      hideQuickActions();

      state.isRunning = false;
      state.currentGmailTabId = null;
      if (claimedRunId) await clearActiveRun(claimedRunId);
    }
  };

  // =========================
  // Subscriptions: scan + bulk unsubscribe (7.0)
  // =========================
  // The scan is free; executing unsubscribes is the Pro feature. The
  // gate lives here in the UI: the engine itself is not license-aware.

  const SUBS_STATUS_LABELS = Object.freeze({
    unsubscribed: { text: t("subsStatusUnsubscribed", "Unsubscribed"), cls: "ok" },
    manual: { text: t("subsStatusManual", "Manual step needed"), cls: "warn" },
    no_button: { text: t("subsStatusNoButton", "No 1-click option"), cls: "warn" },
    no_dialog: { text: t("subsStatusUnconfirmed", "Unconfirmed"), cls: "warn" },
    unknown_dialog: { text: t("subsStatusUnconfirmed", "Unconfirmed"), cls: "warn" },
    not_found: { text: t("subsStatusNotFound", "No mail found"), cls: "warn" },
    error: { text: t("subsStatusFailed", "Failed"), cls: "err" }
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
    // 8.0: the pill used to unhide only when the license was ALREADY
    // active, so it rewarded buyers and told free users nothing. It now
    // always shows and simply changes what it says, and the tab bar
    // carries a small padlock, so a user who never opens a tab still
    // learns a paid tier exists.
    // 8.2: these pills exist to tell a FREE user a paid tier is there.
    // Once a licence verifies they are just noise on every section, and
    // the Auto-Pilot one was static markup that nothing ever updated, so
    // it sat there in gold saying "Pro" to people who had bought it.
    // Hide all three when active; the footer still confirms the licence.
    for (const pill of [elements.subsProPill, elements.xrayProPill, elements.autoPilotProPill]) {
      if (!pill) continue;
      if (active) {
        pill.setAttribute("hidden", "");
      } else {
        pill.removeAttribute("hidden");
        pill.classList.remove("is-active");
        pill.textContent = t("proShort", "Pro");
      }
    }
    // These are SVG elements, and `hidden` is an HTMLElement property.
    // Assigning it on an SVGElement sets a plain JS property and never
    // reflects to the attribute, so the padlock stayed on the tabs even
    // after a licence verified. Set the attribute directly.
    for (const lock of [elements.tabUnsubLock, elements.tabStorageLock]) {
      if (!lock) continue;
      if (active) lock.setAttribute("hidden", "");
      else lock.removeAttribute("hidden");
    }
    if (elements.subsUpsell) elements.subsUpsell.hidden = active;
    if (elements.unsubBtnSub) {
      elements.unsubBtnSub.textContent = active
        ? t("unsubActiveSub", "Uses Gmail's own Unsubscribe control")
        : t("proPriceSub", "Pro · $19.99 lifetime");
    }
    if (elements.unsubBtn) elements.unsubBtn.classList.toggle("locked", !active);
    if (elements.subsBuyLink) elements.subsBuyLink.href = GCC.license.buyUrl("unsubscribe");
    if (elements.proPromoBuy) elements.proPromoBuy.href = GCC.license.buyUrl("popup_promo");
    if (elements.proPromo) elements.proPromo.hidden = active;

    // 7.2 storage X-ray shares the same license.
    if (elements.xrayBuyLink) elements.xrayBuyLink.href = GCC.license.buyUrl("storage_xray");
    if (elements.xrayPurgeBtn) elements.xrayPurgeBtn.classList.toggle("locked", !active);
    if (elements.xrayPurgeBtnSub) {
      elements.xrayPurgeBtnSub.textContent = active
        ? t("smartBulkSub", "Tagged first, then Trash - undo applies")
        : t("xrayProSub", "Pro · $19.99 once (Google One is $20 every year)");
    }
    renderXrayList();

    // 7.8 Smart Suggestions share the same license: the scan and the
    // top picks are free, the full list and bulk apply are Pro.
    if (elements.smartBuyLink) elements.smartBuyLink.href = GCC.license.buyUrl("smart_suggestions");
    if (elements.smartBulkBtn) elements.smartBulkBtn.classList.toggle("locked", !active);
    renderSmartList();

    // 8.0 Mailbox Report shares the same license: the report is free
    // and complete, the top-ranked step is free to run, the rest is Pro.
    renderReport();
  };

  // 7.12: locked Pro controls go straight to checkout. The click on
  // "Unsubscribe selected" or the Auto-Pilot toggle already said "I
  // want this"; making the user hunt for a second Get Pro link is
  // where the sale gets lost. Falls back to the inline upsell (which
  // carries the same link) when a tab cannot open.
  const openProCheckout = async (fallbackUpsell, source) => {
    const tab = await tabsCreate({ url: GCC.license.buyUrl(source), active: true });
    if (tab) {
      setTimeout(safeClosePopup, 150);
      return;
    }
    if (fallbackUpsell) fallbackUpsell.hidden = false;
    showToast(t("checkoutFailedToast", "could not open checkout - use the Get Pro link"), "warning");
  };

  // 8.0: 7.12's straight-to-checkout was half right. It is correct that
  // a second hunt for a Get Pro link loses sales, but the destination
  // was a raw Stripe card form from a developer the user has never
  // heard of, and three of the six gates did not even state the price
  // at the moment of the click. The panel below costs a decided buyer
  // one extra click and gives everybody else the pitch: their own scan
  // number, what the four pillars do, and the three facts that until
  // now existed only on a landing page nothing linked to. The Get Pro
  // button performs exactly the old jump with exactly the old
  // attribution label, so tools/analytics.mjs keeps working.
  const proPanelState = { source: null, fallbackUpsell: null, lastFocus: null };

  // The panel leads with the same number the surface's own inline
  // upsell would have shown, so the pitch is always about this user's
  // mailbox and never a generic claim.
  const xrayRankedMb = () =>
    state.xray.senders.reduce((sum, s) => sum + (Number(s.estMb) || 0), 0);

  const hiddenSmartCount = () =>
    Math.max(0, state.smart.visibleCount - GCC.smart.LIMITS.FREE_VISIBLE);

  const openProPanel = (source, { lead = "", fallbackUpsell = null } = {}) => {
    if (!elements.proPanel) {
      // No panel in this document (a trimmed test fixture): keep the
      // old behaviour rather than silently swallowing the click.
      openProCheckout(fallbackUpsell, source).catch(() => {});
      return;
    }
    proPanelState.source = source;
    proPanelState.fallbackUpsell = fallbackUpsell;
    proPanelState.lastFocus = document.activeElement;

    if (elements.proPanelLead) {
      elements.proPanelLead.textContent = lead
        || t("proPanelLeadDefault", "One payment unlocks every paid feature, forever.");
    }
    elements.proPanel.hidden = false;
    elements.proPanelBuy?.focus();
  };

  // Hoisted out of setupEventListeners in 8.0: the report and the Pro
  // panel wire it before the listener block reaches its old definition,
  // and a const arrow read before its initializer throws.
  const openProOptions = async () => {
    await tabsCreate({ url: chrome.runtime.getURL("options.html#pro"), active: true });
    setTimeout(safeClosePopup, 150);
  };

  const closeProPanel = () => {
    if (!elements.proPanel || elements.proPanel.hidden) return;
    elements.proPanel.hidden = true;
    try {
      proPanelState.lastFocus?.focus?.();
    } catch {
      // The control that opened the panel can be gone after a re-render.
    }
    proPanelState.lastFocus = null;
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
      ? t("nOfMSelected", `${checked} of ${total} selected`, [String(checked), String(total)])
      : (total === 1
        ? t("oneSenderFound", "1 sender found")
        : t("nSendersFound", `${total} senders found`, [String(total)]));
  };

  // 7.3: once a scan exists, the upsell leads with the user's own
  // numbers; before that it keeps the static pitch from the markup.
  const updateSubsUpsellCopy = () => {
    if (!elements.subsUpsellText) return;
    elements.subsUpsellText.textContent =
      GCC.popupUi.subsUpsellLine(state.subs.senders.length);
  };

  const persistSubsSelection = () => {
    storageSet("local", { [STORAGE_KEYS.SUBS_CHECKED]: getCheckedSubEmails().slice(0, 200) })
      .catch(() => {});
  };

  const loadSubsSelection = async () => {
    try {
      const r = await storageGet("local", STORAGE_KEYS.SUBS_CHECKED);
      const list = r?.[STORAGE_KEYS.SUBS_CHECKED];
      state.subs.checked = new Set(Array.isArray(list) ? list.filter((e) => typeof e === "string") : []);
    } catch {
      state.subs.checked = new Set();
    }
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
      checkbox.addEventListener("change", () => {
        updateSubsCount();
        persistSubsSelection();
      });
      if (sender.status === "unsubscribed") checkbox.disabled = true;
      // 8.0: restore a selection the user made before they were sent to
      // checkout. handleUnsubscribe checks the licence BEFORE it reads
      // the checkboxes and then closes the popup, so the people who
      // lost their triage were exactly the people about to pay.
      if (state.subs.checked.has(sender.email) && !checkbox.disabled) checkbox.checked = true;

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
        count.textContent = sender.count === 1
          ? t("reasonOneEmail", "1 email")
          : t("reasonManyEmails", `${sender.count} emails`, [String(sender.count)]);
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

    const gmailTab = await findOrOpenGmailTab(setStatusFn);
    if (!gmailTab) return null;

    if (await isEngineAttached(gmailTab.id)) {
      showToast("another run is already in progress", "warning");
      return null;
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
      setSubsStatus(t("subsScanning", "Scanning your mailbox for subscription senders..."));
      showSkeletonRows(elements.subsList, 4);
      const tabId = await injectSubscriptionRun("subscriptionScan");
      if (tabId === null) {
        state.subs.running = null;
        if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = false;
        return;
      }
    } catch (err) {
      log("error", "scan start failed", err);
      showToast(t("scanFailedPrefix", `scan failed: ${err?.message || "unknown error"}`, [err?.message || "unknown error"]), "error");
      setSubsStatus("");
      state.subs.running = null;
      if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = false;
    }
  };

  const handleUnsubscribe = async () => {
    if (state.subs.running) return;

    if (!state.subs.licenseActive) {
      openProPanel("unsubscribe_locked", {
        lead: GCC.popupUi.subsUpsellLine(state.subs.senders.length),
        fallbackUpsell: elements.subsUpsell
      });
      return;
    }

    const emails = getCheckedSubEmails();
    if (!emails.length) {
      showToast(t("pickOneSender", "pick at least one sender first"), "warning");
      return;
    }
    const capped = emails.slice(0, 25);
    if (emails.length > capped.length) {
      showToast(t("firstTwentyFive", "running the first 25; re-run for the rest"), "info");
    }

    try {
      state.subs.running = "unsubscribe";
      if (elements.unsubBtn) elements.unsubBtn.disabled = true;
      if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = true;
      setSubsStatus(capped.length === 1
        ? t("unsubbingOne", "Unsubscribing from 1 sender...")
        : t("unsubbingMany", `Unsubscribing from ${capped.length} senders...`, [String(capped.length)]));
      const tabId = await injectSubscriptionRun("unsubscribe", capped);
      if (tabId === null) {
        state.subs.running = null;
        if (elements.unsubBtn) elements.unsubBtn.disabled = false;
        if (elements.scanSubsBtn) elements.scanSubsBtn.disabled = false;
      }
    } catch (err) {
      log("error", "unsubscribe start failed", err);
      showToast(t("unsubFailedPrefix", `unsubscribe failed: ${err?.message || "unknown error"}`, [err?.message || "unknown error"]), "error");
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
      setSubsStatus(t("failedDetail", `Failed: ${detail || "unknown error"}`, [detail || "unknown error"]));
      showToast(
        runKind === "unsubscribe"
          ? t("unsubRunFailed", "unsubscribe run failed")
          : t("scanFailedToast", "scan failed"),
        "error"
      );
      finishSubsRun();
      return;
    }
    if (phase === "cancelled") {
      setSubsStatus(t("stoppedStatus", "Stopped."));
      finishSubsRun();
      return;
    }

    if (runKind === "subscriptionScan" && Array.isArray(msg.scanSenders)) {
      // Merge stored statuses (the service worker persists them) after a
      // short beat; render the fresh list immediately for responsiveness.
      state.subs.senders = msg.scanSenders;
      renderSubsList();
      setSubsStatus(status || t("scanComplete", "Scan complete."));
      setTimeout(() => { loadStoredSubscriptions().catch(() => {}); }, 400);
      showToast(t("subsScanCompleteToast", "subscription scan complete"), "success");
    } else if (runKind === "unsubscribe" && Array.isArray(msg.unsubResults)) {
      const byEmail = Object.create(null);
      for (const r of msg.unsubResults) byEmail[r.sender] = r.status;
      for (const sender of state.subs.senders) {
        if (byEmail[sender.email]) sender.status = byEmail[sender.email];
      }
      renderSubsList();
      setSubsStatus(status || t("unsubRunComplete", "Unsubscribe run complete."));
      const okCount = msg.unsubResults.filter((r) => r.status === "unsubscribed").length;
      showToast(
        okCount === 1
          ? t("unsubbedFromOne", "unsubscribed from 1 sender")
          : t("unsubbedFromMany", `unsubscribed from ${okCount} senders`, [String(okCount)]),
        okCount ? "success" : "warning"
      );
    }
    finishSubsRun();
  };

  // =========================
  // Mailbox Report (8.0)
  // =========================
  // The landing tab. One read-only scan counts what is actually in the
  // mailbox and turns it into a ranked plan. The report itself is free
  // and complete, and the top-ranked step is free to run, so the
  // mechanism proves itself on the user's own mail before anyone is
  // asked for money. Every other step and "Run the whole plan" are Pro.
  //
  // Running a step is not a new engine surface: it is an ordinary
  // cleanup whose rulesOverride is the band's query, exactly like the
  // X-ray purge below, so tagging, the whitelist, protected keywords,
  // Minimum Age, dry run, the undo log and Restore all apply unchanged.

  const REPORT_LABELS = Object.freeze({
    sizeHuge: { title: "Huge attachments", desc: "Over 25 MB, older than 6 months" },
    sizeLarge: { title: "Large attachments", desc: "10 to 25 MB, older than 6 months" },
    sizeBig: { title: "Big attachments", desc: "5 to 10 MB, older than 6 months" },
    promotions: { title: "Old promotions", desc: "Promotions tab, older than 6 months" },
    social: { title: "Old social mail", desc: "Social tab, older than 6 months" },
    updates: { title: "Old updates", desc: "Updates tab, older than a year" },
    forums: { title: "Old forum mail", desc: "Forums tab, older than a year" },
    newsletters: { title: "Old newsletters", desc: "Carries an unsubscribe link, older than a year" },
    inboxAncient: { title: "Inbox, 5 years and older", desc: "Archived out of the Inbox, never deleted" },
    inboxOld: { title: "Inbox, 1 to 5 years old", desc: "Archived out of the Inbox, never deleted" }
  });

  const reportBandTitle = (id) =>
    t(`reportBand_${id}`, REPORT_LABELS[id]?.title || id);

  const reportBandDesc = (id) =>
    t(`reportBandDesc_${id}`, REPORT_LABELS[id]?.desc || "");

  const setReportStatus = (text) => {
    if (elements.reportStatus) elements.reportStatus.textContent = text || "";
  };

  const showSkeletonRows = (container, count) => {
    if (!container) return;
    container.textContent = "";
    for (let i = 0; i < count; i++) {
      const row = document.createElement("div");
      row.className = "skeleton-row";
      row.setAttribute("aria-hidden", "true");
      container.appendChild(row);
    }
  };

  const renderReport = () => {
    if (!elements.reportList) return;
    const active = state.subs.licenseActive;
    const ranked = GCC.report.rankBands(state.report.bands).filter((b) => b.count > 0);
    const freeId = GCC.report.freeBandId(state.report.bands);
    const totals = GCC.report.totals(state.report.bands);

    const scanned = Boolean(state.report.updatedAt);
    if (elements.reportHero) elements.reportHero.hidden = !scanned;
    // Once the number is on screen the pitch for the scan is dead
    // weight, and the scan button becomes a rescan.
    if (elements.reportIntro) elements.reportIntro.hidden = scanned;
    if (elements.reportScanLabel && scanned) {
      elements.reportScanLabel.textContent = t("reportRescanMain", "Scan again");
    }
    if (elements.reportScanSub && scanned) {
      elements.reportScanSub.textContent = t("reportRescanSub", "Free · updates the counts below");
    }
    if (elements.reportScanBtn) elements.reportScanBtn.classList.toggle("is-compact", scanned);
    if (elements.reportHeroCount) {
      elements.reportHeroCount.textContent = Number(state.report.cleanableCount || 0).toLocaleString();
    }
    if (elements.reportHeroMb) {
      elements.reportHeroMb.textContent = totals.largeMb
        ? t("reportHeroMb", `At least ${totals.largeMb.toLocaleString()} MB of it is large mail`, [totals.largeMb.toLocaleString()])
        : "";
    }
    if (elements.reportStamp && state.report.updatedAt) {
      elements.reportStamp.textContent = GCC.relativeTime
        ? GCC.relativeTime(state.report.updatedAt)
        : "";
    }
    if (elements.reportNote) elements.reportNote.hidden = !state.report.updatedAt;

    elements.reportList.textContent = "";

    if (!state.report.updatedAt) {
      if (elements.reportPlanBtn) elements.reportPlanBtn.hidden = true;
      if (elements.reportUpsell) elements.reportUpsell.hidden = true;
      const empty = document.createElement("div");
      empty.className = "scan-empty";
      empty.innerHTML =
        '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
      const text = document.createElement("span");
      text.textContent = t(
        "reportEmpty",
        "The scan counts old promotions, big attachments, forgotten newsletters and inbox mail you never archived, then ranks them so you can clear the biggest first."
      );
      empty.appendChild(text);
      elements.reportList.appendChild(empty);
      return;
    }

    if (ranked.length === 0) {
      const empty = document.createElement("div");
      empty.className = "scan-empty";
      const text = document.createElement("span");
      text.textContent = t("reportNothing", "Nothing matched the plan. Your mailbox is already clean.");
      empty.appendChild(text);
      elements.reportList.appendChild(empty);
      if (elements.reportPlanBtn) elements.reportPlanBtn.hidden = true;
      if (elements.reportUpsell) elements.reportUpsell.hidden = true;
      return;
    }

    for (const band of ranked) {
      const unlocked = GCC.report.isBandUnlocked(band.id, state.report.bands, active);
      const row = document.createElement("div");
      row.className = "report-row";
      if (!active && band.id === freeId) row.classList.add("is-free");
      if (band.cleanedAt) row.classList.add("is-done");
      row.setAttribute("role", "listitem");

      const main = document.createElement("div");
      main.className = "report-row-main";
      const title = document.createElement("div");
      title.className = "report-row-title";
      title.textContent = reportBandTitle(band.id);
      const meta = document.createElement("div");
      meta.className = "report-row-meta";
      meta.textContent = [
        reportBandDesc(band.id),
        band.action === "archive"
          ? t("reportActionArchive", "archives")
          : t("reportActionDelete", "to Trash")
      ].filter(Boolean).join(" · ");
      main.appendChild(title);
      main.appendChild(meta);

      // The figures get their own column so a long band description can
      // never truncate the number, which is the thing the row is for.
      const figures = document.createElement("div");
      figures.className = "report-row-figures";
      const count = document.createElement("span");
      count.className = "report-row-count";
      count.textContent = band.count.toLocaleString();
      figures.appendChild(count);
      if (band.estMb) {
        const mb = document.createElement("span");
        mb.className = "report-row-mb";
        mb.textContent = t("reportAtLeastMb", `at least ${band.estMb.toLocaleString()} MB`, [band.estMb.toLocaleString()]);
        figures.appendChild(mb);
      }

      row.appendChild(main);
      row.appendChild(figures);

      if (band.cleanedAt) {
        const done = document.createElement("span");
        done.className = "report-row-done";
        done.textContent = t("reportDone", "Cleared");
        row.appendChild(done);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "report-row-btn";
        btn.setAttribute("data-band", band.id);
        if (unlocked) {
          btn.textContent = t("reportRunStep", "Run");
          btn.setAttribute(
            "aria-label",
            t("reportRunStepAria", `Run this step: ${reportBandTitle(band.id)}`, [reportBandTitle(band.id)])
          );
        } else {
          btn.classList.add("is-locked");
          btn.innerHTML =
            '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>';
          const span = document.createElement("span");
          span.textContent = t("proShort", "Pro");
          btn.appendChild(span);
          btn.setAttribute(
            "aria-label",
            t("reportLockedAria", `Unlock this step with Pro: ${reportBandTitle(band.id)}`, [reportBandTitle(band.id)])
          );
        }
        row.appendChild(btn);
      }

      elements.reportList.appendChild(row);
    }

    if (elements.reportPlanBtn) elements.reportPlanBtn.hidden = ranked.length < 2;
    if (elements.reportPlanBtn) elements.reportPlanBtn.classList.toggle("locked", !active);
    if (elements.reportPlanBtnSub) {
      elements.reportPlanBtnSub.textContent = active
        ? t("smartBulkSub", "Tagged first, then Trash - undo applies")
        : t("proPriceSub", "Pro · $19.99 lifetime");
    }
    if (elements.reportUpsell) elements.reportUpsell.hidden = active;
    if (elements.reportUpsellText && !active) {
      elements.reportUpsellText.textContent = GCC.report.upsellLine(state.report.bands);
    }
  };

  const loadStoredReport = async () => {
    try {
      const res = await GCC.sendMessage({ type: "gmailCleanerGetReport" });
      const stored = res?.report;
      if (!stored?.bands) return;
      state.report.bands = GCC.report.rankBands(stored.bands);
      state.report.cleanableCount = Number(stored.cleanableCount) || 0;
      state.report.largeMb = Number(stored.largeMb) || 0;
      state.report.topSenders = Array.isArray(stored.topSenders) ? stored.topSenders : [];
      state.report.updatedAt = Number(stored.updatedAt) || 0;
    } catch {
      // A missing report is the normal first-run state.
    }
    // Render either way: the pre-scan empty state is what a first-time
    // user sees, and it must not depend on a storage read succeeding.
    renderReport();
  };

  const finishReportRun = () => {
    state.report.running = null;
    if (elements.reportScanBtn) elements.reportScanBtn.disabled = false;
  };

  const handleReportProgress = (msg) => {
    const { phase, status, detail } = msg;

    if (phase === "error") {
      setReportStatus(detail || t("reportFailed", "Report failed."));
      if (elements.reportList) elements.reportList.textContent = "";
      renderReport();
      finishReportRun();
      return;
    }
    if (phase === "cancelled") {
      setReportStatus(t("reportCancelled", "Report cancelled."));
      renderReport();
      finishReportRun();
      return;
    }
    if (!msg.done) {
      setReportStatus(status || detail || "");
      return;
    }

    if (Array.isArray(msg.bands)) {
      state.report.bands = GCC.report.rankBands(msg.bands);
      state.report.cleanableCount = Number(msg.cleanableCount) || 0;
      state.report.largeMb = Number(msg.largeMb) || 0;
      state.report.topSenders = Array.isArray(msg.topSenders) ? msg.topSenders : [];
      state.report.updatedAt = Date.now();
      renderReport();
      setReportStatus(status || t("scanComplete", "Scan complete."));
      // The worker persists the same payload; re-read it shortly after
      // so the stored cleanedAt marks come back in.
      setTimeout(() => { loadStoredReport().catch(() => {}); }, 400);
      showToast(t("reportCompleteToast", "mailbox report ready"), "success");
    }
    finishReportRun();
  };

  const handleReportScan = async () => {
    if (state.report.running) return;
    try {
      state.report.running = "reportScan";
      if (elements.reportScanBtn) elements.reportScanBtn.disabled = true;
      setReportStatus(t("reportScanning", "Reading your mailbox..."));
      showSkeletonRows(elements.reportList, 4);
      // Read-only, like the other scans: the engine needs nothing from
      // the cleanup form to count search results.
      const tabId = await injectEngineRun(
        { runKind: "reportScan", debugMode: state.debugMode },
        setReportStatus
      );
      if (tabId === null) {
        state.report.running = null;
        if (elements.reportScanBtn) elements.reportScanBtn.disabled = false;
        renderReport();
      }
    } catch (err) {
      log("error", "report scan start failed", err);
      showToast(t("scanFailedPrefix", `scan failed: ${err?.message || "unknown error"}`, [err?.message || "unknown error"]), "error");
      setReportStatus("");
      state.report.running = null;
      if (elements.reportScanBtn) elements.reportScanBtn.disabled = false;
      renderReport();
    }
  };

  // Running a plan step. A clone of handleXrayPurge below, down to the
  // ordering of the claim, the attached-engine guard and the pending
  // marker, because that ordering is the product of several fixes: a
  // refused duplicate run must not leave a scoped config or a dangling
  // marker behind.
  const startReportRun = async (bandIds, { source }) => {
    if (state.isRunning || state.report.running) return;

    const rules = GCC.report.bandPurgeRules(bandIds);
    if (!rules.length) {
      showToast(t("reportNoSteps", "no steps selected"), "warning");
      return;
    }

    // Every band in one run must agree on the action, and the engine
    // takes one archiveInsteadOfDelete for the whole run. Archive is
    // the gentler outcome, so a mixed selection archives: doing less
    // than asked is always the safe direction.
    const bands = GCC.report.rankBands(state.report.bands);
    const chosen = bands.filter((b) => bandIds.includes(b.id));
    const anyArchive = chosen.some((b) => b.action === "archive");

    state.isRunning = true;
    let claimedRunId = null;
    try {
      if (!(await GCC.gmailAccess.check())) {
        refreshBanners().catch(() => {});
        setReportStatus(t("allowAccessFirst", "Allow Gmail access at the top of this popup first."));
        showToast(t("accessNeededToast", "gmail access needed"), "warning");
        state.isRunning = false;
        return;
      }

      const gmailTab = await findOrOpenGmailTab(setReportStatus);
      if (!gmailTab?.id) {
        state.isRunning = false;
        return;
      }

      const claim = await tryClaimRun(gmailTab.id);
      if (!claim.ok) {
        showToast(t("alreadyRunningToast", "a cleanup is already running"), "warning");
        state.isRunning = false;
        return;
      }
      claimedRunId = claim.claim.runId;

      const config = await buildConfig();
      config.runId = claim.claim.runId;
      config.rulesOverride = rules;
      config.archiveInsteadOfDelete = anyArchive;
      state.currentGmailTabId = gmailTab.id;
      state.startedRunHere = true;
      setReportStatus(config.dryRun
        ? t("reportDryCounting", "Dry run: counting what this step would clear...")
        : t("reportRunning", "Running the plan..."));

      if (await isEngineAttached(gmailTab.id)) {
        showToast(t("alreadyRunningToast", "a cleanup is already running"), "warning");
        await clearActiveRun(claimedRunId);
        claimedRunId = null;
        state.isRunning = false;
        return;
      }

      await persistLastConfig(config);

      if (!config.dryRun) {
        GCC.sendMessage({
          type: "gmailCleanerReportPurgeStarted",
          runId: config.runId,
          bandIds: chosen.map((b) => b.id)
        }).catch(() => {});
      }

      await openProgressTab(gmailTab.id);

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
      showToast(config.dryRun ? t("reportDryStarted", "plan dry run started") : t("reportStarted", "plan started"), "success");
      setTimeout(safeClosePopup, 200);
    } catch (err) {
      const m = err?.message || String(err);
      log("error", `startReportRun (${source}) error:`, err);
      setReportStatus(t("failedToStart", `Failed to start: ${m}`, [m]));
      showToast(t("reportFailedPrefix", `plan failed: ${m}`, [m]), "error");
      if (claimedRunId) await clearActiveRun(claimedRunId);
      state.isRunning = false;
      state.currentGmailTabId = null;
    }
  };

  const handleReportBandClick = async (bandId) => {
    const active = state.subs.licenseActive;
    if (!GCC.report.isBandUnlocked(bandId, state.report.bands, active)) {
      openProPanel("report_band_locked", {
        lead: GCC.report.upsellLine(state.report.bands),
        fallbackUpsell: elements.reportUpsell
      });
      return;
    }
    await startReportRun([bandId], { source: "band" });
  };

  const handleReportPlan = async () => {
    if (!state.subs.licenseActive) {
      openProPanel("report_plan_locked", {
        lead: GCC.report.upsellLine(state.report.bands),
        fallbackUpsell: elements.reportUpsell
      });
      return;
    }
    const ids = GCC.report.rankBands(state.report.bands)
      .filter((b) => b.count > 0 && !b.cleanedAt)
      .map((b) => b.id);
    await startReportRun(ids, { source: "plan" });
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
      ? t("nOfMSelected", `${checked} of ${total} selected`, [String(checked), String(total)])
      : (total === 1
        ? t("oneSenderRanked", "1 sender ranked")
        : t("nSendersRanked", `${total} senders ranked`, [String(total)]));
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
      const countText = GCC.formatNumber(totalCount);
      elements.xrayTotalSub.textContent = totalCount === 1
        ? t("reclaimableOne", "reclaimable across 1 large email")
        : t("reclaimableMany", `reclaimable across ${countText} large emails`, [countText]);
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
        chip.textContent = t("purgedChip", "Purged");
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
      locked.appendChild(document.createTextNode(
        hidden.length === 1
          ? t("xrayLockedOne", "1 more sender holding ")
          : t("xrayLockedMany", `${hidden.length} more senders holding `, [String(hidden.length)])
      ));
      locked.appendChild(strong);
      locked.appendChild(document.createTextNode(t("xrayLockedTail", " - Pro unlocks the full list and one-click purge.")));
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
      setXrayStatus(t("xraySizing", "Sizing up your mailbox..."));
      showSkeletonRows(elements.xrayList, 3);
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
      showToast(t("scanFailedPrefix", `scan failed: ${err?.message || "unknown error"}`, [err?.message || "unknown error"]), "error");
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
      setXrayStatus(t("failedDetail", `Failed: ${detail || "unknown error"}`, [detail || "unknown error"]));
      showToast(t("xrayScanFailed", "storage scan failed"), "error");
      finishXrayRun();
      return;
    }
    if (phase === "cancelled") {
      setXrayStatus(t("stoppedStatus", "Stopped."));
      finishXrayRun();
      return;
    }

    if (Array.isArray(msg.scanSenders)) {
      state.xray.senders = GCC.storageXray.rankSenders(msg.scanSenders);
      state.xray.totalMb = Number(msg.totalMb) || 0;
      state.xray.totalCount = Number(msg.totalCount) || 0;
      renderXrayList();
      setXrayStatus(status || t("scanComplete", "Scan complete."));
      setTimeout(() => { loadStoredStorageScan().catch(() => {}); }, 400);
      showToast(t("xrayScanCompleteToast", "storage scan complete"), "success");
    }
    finishXrayRun();
  };

  // Purge = a normal cleanup run scoped by rulesOverride, so it walks
  // the exact same path as the Run button: claim, progress tab, inject.
  const handleXrayPurge = async () => {
    if (state.isRunning || state.xray.running) return;

    if (!state.subs.licenseActive) {
      openProPanel("storage_xray_locked", {
        lead: GCC.popupUi.xrayUpsellLine(state.xray.senders.length, xrayRankedMb()),
        fallbackUpsell: elements.xrayUpsell
      });
      return;
    }

    const emails = getCheckedXrayEmails();
    if (!emails.length) {
      showToast(t("pickOneSender", "pick at least one sender first"), "warning");
      return;
    }

    const age = elements.xrayAge?.value || "";
    // 8.0: buildPurgeQuery returns only the FIRST chunk, because a
    // single string cannot hold 25 long addresses inside the project's
    // 512-character ceiling. The run takes the whole set as separate
    // rules, which the engine already supports; using the singular API
    // here would silently skip every sender past the first chunk.
    const purgeQueries = GCC.storageXray.buildPurgeQueries(emails, age);
    if (!purgeQueries.length) {
      showToast(t("noValidSenders", "no valid senders selected"), "warning");
      return;
    }
    const targeted = GCC.storageXray.sanitizeEmails(emails);

    state.isRunning = true;
    let claimedRunId = null;
    try {
      if (!(await GCC.gmailAccess.check())) {
        refreshBanners().catch(() => {});
        setXrayStatus(t("allowAccessFirst", "Allow Gmail access at the top of this popup first."));
        showToast(t("accessNeededToast", "gmail access needed"), "warning");
        state.isRunning = false;
        return;
      }

      const gmailTab = await findOrOpenGmailTab(setXrayStatus);
      if (!gmailTab?.id) {
        state.isRunning = false;
        return;
      }

      const claim = await tryClaimRun(gmailTab.id);
      if (!claim.ok) {
        showToast(t("alreadyRunningToast", "a cleanup is already running"), "warning");
        state.isRunning = false;
        return;
      }
      claimedRunId = claim.claim.runId;

      const config = await buildConfig();
      config.runId = claim.claim.runId;
      config.rulesOverride = purgeQueries;
      // 7.15: the global Minimum Age stays. Nulling it here predated the
      // engine learning to compare ages: applyGlobalGuards now appends the
      // floor only when it is STRICTER than the age the rule already
      // carries, so it can never narrow this query by accident, and
      // dropping it threw away a setting the user deliberately chose
      // ("only clean mail older than a year" meant it).
      state.currentGmailTabId = gmailTab.id;
      state.startedRunHere = true;
      setXrayStatus(config.dryRun
        ? t("purgeDryCounting", "Dry run: counting what a purge would remove...")
        : (targeted.length === 1
          ? t("purgingOne", "Purging large mail from 1 sender...")
          : t("purgingMany", `Purging large mail from ${targeted.length} senders...`, [String(targeted.length)])));

      if (await isEngineAttached(gmailTab.id)) {
        showToast(t("alreadyRunningToast", "a cleanup is already running"), "warning");
        await clearActiveRun(claimedRunId);
        claimedRunId = null;
        state.isRunning = false;
        return;
      }

      // The progress tab re-injects from lastConfig when it has to
      // reconnect. Without this the stored config is still the last full
      // cleanup, so a reconnect would drop the sender scope and sweep the
      // whole rule set instead of the senders the user picked.
      //
      // Persisted AFTER the duplicate-run guard for the same reason the
      // purge marker is: a refused run must not leave its scoped config
      // behind as the thing a later reconnect would run.
      await persistLastConfig(config);

      // Register the target list so the background can mark rows
      // purged when the run finishes (this popup will be long closed).
      // Registered after the guard: a refused run leaves no marker
      // waiting on a run that never starts.
      if (!config.dryRun) {
        GCC.sendMessage({
          type: "gmailCleanerStorageXrayPurgeStarted",
          runId: config.runId,
          senders: targeted
        }).catch(() => {});
      }

      await openProgressTab(gmailTab.id);

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
      showToast(config.dryRun ? t("purgeDryStarted", "purge dry run started") : t("purgeStarted", "purge started"), "success");
      setTimeout(safeClosePopup, 200);
    } catch (err) {
      const msg = err?.message || String(err);
      log("error", "handleXrayPurge error:", err);
      setXrayStatus(t("failedToStart", `Failed to start: ${msg}`, [msg]));
      showToast(t("purgeFailedPrefix", `purge failed: ${msg}`, [msg]), "error");
      if (claimedRunId) await clearActiveRun(claimedRunId);
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
      ? t("nOfMSelected", `${checked} of ${total} selected`, [String(checked), String(total)])
      : (total === 1
        ? t("oneSuggestion", "1 suggestion")
        : t("nSuggestions", `${total} suggestions`, [String(total)]));
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
    const ACTION_KEY = { deleteOld: "actionDeleteOld", archiveAll: "actionArchiveAll", purgeLarge: "actionPurgeLarge", unsubscribe: "actionUnsubscribe" };
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "smart-apply-btn";
    applyBtn.textContent = t(ACTION_KEY[action] || "actionCleanUp", GCC.smart.ACTION_LABELS[action] || "Clean up");
    applyBtn.addEventListener("click", () => handleSmartApply(sender, action));
    actions.appendChild(applyBtn);

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "smart-dismiss-btn";
    dismiss.textContent = t("dismissBtn", "Dismiss");
    dismiss.setAttribute("aria-label", t("dismissAria", `Dismiss the suggestion for ${sender.email}`, [sender.email]));
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
      setSmartStatus(t("smartScanning", "Scanning for suggestions (this one takes a minute or two)..."));
      showSkeletonRows(elements.smartList, 3);
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
      showToast(t("scanFailedPrefix", `scan failed: ${err?.message || "unknown error"}`, [err?.message || "unknown error"]), "error");
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
      setSmartStatus(t("failedDetail", `Failed: ${detail || "unknown error"}`, [detail || "unknown error"]));
      showToast(t("smartScanFailed", "suggestion scan failed"), "error");
      finishSmartRun();
      return;
    }
    if (phase === "cancelled") {
      setSmartStatus(t("stoppedStatus", "Stopped."));
      finishSmartRun();
      return;
    }

    if (Array.isArray(msg.scanSenders)) {
      setSmartStatus(status || t("scanComplete", "Scan complete."));
      // The worker union-merges rescans; read the authoritative list
      // back after it lands.
      setTimeout(() => { loadStoredSmartScan().catch(() => {}); }, 400);
      showToast(t("smartScanCompleteToast", "suggestion scan complete"), "success");
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
    let claimedRunId = null;
    try {
      if (!(await GCC.gmailAccess.check())) {
        refreshBanners().catch(() => {});
        setSmartStatus(t("allowAccessFirst", "Allow Gmail access at the top of this popup first."));
        showToast(t("accessNeededToast", "gmail access needed"), "warning");
        state.isRunning = false;
        return;
      }

      const gmailTab = await findOrOpenGmailTab(setSmartStatus);
      if (!gmailTab?.id) {
        state.isRunning = false;
        return;
      }

      const claim = await tryClaimRun(gmailTab.id);
      if (!claim.ok) {
        showToast(t("alreadyRunningToast", "a cleanup is already running"), "warning");
        state.isRunning = false;
        return;
      }

      claimedRunId = claim.claim.runId;

      const config = await buildConfig();
      config.runId = claim.claim.runId;
      config.rulesOverride = queries;
      // 7.15: the global Minimum Age stays, and it matters most here.
      // "Archive all" builds `from:(sender)` with NO age scope at all, so
      // nulling the floor let a suggestion act on mail that arrived
      // today even when the user had set "older than 1 year".
      // applyGlobalGuards only appends the floor when it is stricter than
      // the rule's own age, so the queries that do carry one are
      // unaffected.
      // The suggestion names its own action; it overrides the form's
      // action dropdown for this run only.
      config.archiveInsteadOfDelete = Boolean(archive);
      state.currentGmailTabId = gmailTab.id;
      state.startedRunHere = true;
      setSmartStatus(config.dryRun
        ? t("smartDryCounting", "Dry run: counting what this suggestion would clean...")
        : (emails.length === 1
          ? t("cleaningOne", "Cleaning up 1 sender...")
          : t("cleaningMany", `Cleaning up ${emails.length} senders...`, [String(emails.length)])));

      if (await isEngineAttached(gmailTab.id)) {
        showToast(t("alreadyRunningToast", "a cleanup is already running"), "warning");
        await clearActiveRun(claimedRunId);
        claimedRunId = null;
        state.isRunning = false;
        return;
      }

      // The progress tab re-injects from lastConfig when it has to
      // reconnect. Without this the stored config is still the last full
      // cleanup, so a reconnect would drop the sender scope and the action
      // override and sweep the whole rule set instead. Persisted after the
      // duplicate-run guard so a refused run leaves nothing scoped behind.
      await persistLastConfig(config);

      // Stamped after the guard so a refused run leaves no marker
      // waiting on a run that never starts.
      if (!config.dryRun) {
        GCC.sendMessage({
          type: "gmailCleanerSmartApplyStarted",
          runId: config.runId,
          senders: emails
        }).catch(() => {});
      }

      await openProgressTab(gmailTab.id);

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
      showToast(config.dryRun ? t("smartDryStarted", "suggestion dry run started") : t("smartApplied", "suggestion applied"), "success");
      setTimeout(safeClosePopup, 200);
    } catch (err) {
      const msg = err?.message || String(err);
      log("error", "startSmartApplyRun error:", err);
      setSmartStatus(t("failedToStart", `Failed to start: ${msg}`, [msg]));
      showToast(t("applyFailedPrefix", `apply failed: ${msg}`, [msg]), "error");
      if (claimedRunId) await clearActiveRun(claimedRunId);
      state.isRunning = false;
      state.currentGmailTabId = null;
    }
  };

  const handleSmartApply = async (sender, action) => {
    const rule = GCC.smart.buildActionRule(sender, action);
    if (!rule) {
      showToast(t("noSafeRule", "could not build a safe rule for this sender"), "warning");
      return;
    }

    // The unsubscribe action rides the existing Pro path with its
    // existing gate; everything else is a free cleanup run.
    if (rule.runKind === "unsubscribe") {
      if (!state.subs.licenseActive) {
        openProPanel("smart_unsub_locked", {
          lead: GCC.popupUi.smartUpsellLine(hiddenSmartCount()),
          fallbackUpsell: elements.smartUpsell
        });
        return;
      }
      if (state.subs.running) return;
      state.subs.running = "unsubscribe";
      setSmartStatus(t("unsubbingFrom", `Unsubscribing from ${sender.email}...`, [sender.email]));
      const tabId = await injectSubscriptionRun("unsubscribe", rule.senders);
      if (tabId === null) state.subs.running = null;
      return;
    }

    await startSmartApplyRun([sender.email], [rule.query], rule.archive);
  };

  const handleSmartBulkApply = async () => {
    if (!state.subs.licenseActive) {
      openProPanel("smart_bulk_locked", {
        lead: GCC.popupUi.smartUpsellLine(hiddenSmartCount()),
        fallbackUpsell: elements.smartUpsell
      });
      return;
    }
    const emails = getCheckedSmartEmails();
    if (!emails.length) {
      showToast(t("pickOneSuggestion", "pick at least one suggestion first"), "warning");
      return;
    }
    const query = GCC.smart.buildBulkRule(emails);
    if (!query) {
      showToast(t("noValidSenders", "no valid senders selected"), "warning");
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
    showToast(t("dismissed90", "dismissed for 90 days"), "info");
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
    if (elements.autoPilotBuyLink) elements.autoPilotBuyLink.href = GCC.license.buyUrl("autopilot");

    let statusText = "";
    if (active && ap?.enabled) {
      if (ap.pendingStage) {
        statusText = t("apSweepRunning", "A sweep is running right now.");
      } else if (ap.lastRun && ap.lastRun.at) {
        const n = Math.max(0, Number(ap.lastRun.count) || 0);
        const nText = GCC.formatNumber(n);
        const when = GCC.relativeTime(ap.lastRun.at);
        statusText = ap.lastRun.dryRun
          ? t("apLastSweepDry", `Last sweep would have archived ${nText} emails, ${when}.`, [nText, when])
          : t("apLastSweepLive", `Last sweep archived ${nText} emails, ${when}.`, [nText, when]);
      } else {
        statusText = t("apFirstSweepSoon", "First sweep runs soon as a preview. Nothing is archived until you confirm below.");
      }
    }
    if (elements.autoPilotStatus) elements.autoPilotStatus.textContent = statusText;

    const showConfirm = Boolean(active && ap?.enabled && !ap?.confirmed && ap?.preview);
    if (elements.autoPilotConfirm) elements.autoPilotConfirm.hidden = !showConfirm;
    if (showConfirm && elements.autoPilotConfirmText) {
      const n = Math.max(0, Number(ap.preview.count) || 0);
      const nText = GCC.formatNumber(n);
      elements.autoPilotConfirmText.textContent =
        t("apPreviewConfirm", `Auto-Pilot preview: would have archived ${nText} emails. Turn on for real?`, [nText]);
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
      openProPanel("autopilot_locked", {
        lead: GCC.popupUi.autoPilotUpsellLine(state.smart.visibleCount),
        fallbackUpsell: elements.autoPilotUpsell
      });
      return;
    }
    const resp = await GCC.sendMessage({ type: "gmailCleanerSetAutoPilot", enabled: wanted });
    if (resp?.ok && resp.autoPilot) {
      state.autoPilot = resp.autoPilot;
      showToast(
        wanted ? t("apOnToast", "Auto-Pilot on - the first sweep is a preview") : t("apOffToast", "Auto-Pilot off"),
        wanted ? "success" : "info"
      );
    } else {
      showToast(
        resp?.error === "pro_required"
          ? t("apNeedsPro", "Auto-Pilot needs an active Pro license")
          : t("apUpdateFailed", "could not update Auto-Pilot"),
        "warning"
      );
    }
    renderAutoPilot();
  };

  const handleAutoPilotConfirm = async () => {
    const resp = await GCC.sendMessage({ type: "gmailCleanerConfirmAutoPilot" });
    if (resp?.ok && resp.autoPilot) {
      state.autoPilot = resp.autoPilot;
      showToast(t("apLiveToast", "Auto-Pilot is live - weekly sweeps now archive for real"), "success");
    } else {
      showToast(t("apConfirmFailed", "could not confirm Auto-Pilot"), "warning");
    }
    renderAutoPilot();
  };

  // =========================
  // Quick actions
  // =========================

  const handleCancel = async () => {
    const tabId = state.currentGmailTabId;
    if (!tabId) {
      showToast(t("noActiveCleanup", "no active cleanup found"), "warning");
      return;
    }

    try {
      const resp = await tabsSendMessage(tabId, { type: "gmailCleanerCancel" });
      if (resp?.ok) {
        showToast(t("cancelConfirmed", "cancel confirmed"), "info");
        setStatus(t("cleanupCancelled", "cleanup cancelled"), STATUS_TYPES.WARNING, true);
        await clearActiveRun();
        hideQuickActions();
        resetRunButton();
        state.isRunning = false;
        state.currentGmailTabId = null;
        hideProgress();
      } else {
        showToast(t("cancelUnconfirmed", "cancel sent but unconfirmed"), "warning");
        setStatus(t("cancelRequested", "cancel requested"), STATUS_TYPES.WARNING, true);
      }
    } catch (err) {
      // Issue #19: distinguish "tab closed" (recoverable) from real
      // errors so we don't tell the user "tab unreachable" when in fact
      // host permission was revoked or the service worker crashed.
      const kind = err?.gccKind || GCC.classifyChromeError(err).kind;
      if (kind === "tab_closed" || kind === "no_chrome") {
        showToast(t("tabUnreachable", "gmail tab unreachable, clearing state"), "warning");
      } else if (kind === "permission") {
        showToast(t("permDeniedToast", "permission denied; reload Gmail and retry"), "error");
        setStatus(t("permDeniedStatus", "can't reach Gmail (permissions)"), STATUS_TYPES.ERROR, true);
      } else {
        showToast(t("cancelFailedPrefix", `cancel failed: ${err?.message || "unknown error"}`, [err?.message || "unknown error"]), "error");
        setStatus(t("cancelErrorPrefix", `cancel error: ${err?.message || "unknown"}`, [err?.message || "unknown"]), STATUS_TYPES.ERROR, true);
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
      showToast(t("noActiveCleanup", "no active cleanup found"), "warning");
      return;
    }

    const existing = await findProgressTab(tabId);
    if (existing?.id) {
      // Focusing without reloading is right for a run THIS popup started:
      // the dashboard is already following it and a reload would throw
      // away the log. For a run the popup only learned about from the
      // active-run marker (a schedule or an Auto-Pilot sweep), any
      // leftover progress tab belongs to an older, finished run: it sits
      // frozen on "Run finished" with Cancel disabled and its
      // auto-reconnect already stopped, so the user is handed a dead
      // dashboard for a live cleanup they cannot stop.
      if (!state.startedRunHere && !(await tabsReload(existing.id))) {
        await tabsCreate({
          url: chrome.runtime.getURL(`progress.html?gmailTabId=${tabId}`),
          active: true
        });
        setTimeout(safeClosePopup, 150);
        return;
      }
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
      showToast(t("openRulesFailed", "failed to open rules"), "error");
    }
  };

  const openDiagnostics = async () => {
    try {
      await tabsCreate({ url: chrome.runtime.getURL("diagnostics.html") });
      setTimeout(safeClosePopup, 150);
    } catch (e) {
      log("error", "openDiagnostics failed", e);
      showToast(t("openDiagFailed", "failed to open diagnostics"), "error");
    }
  };

  const openStats = async () => {
    try {
      await tabsCreate({ url: chrome.runtime.getURL("stats.html") });
      setTimeout(safeClosePopup, 150);
    } catch (e) {
      log("error", "openStats failed", e);
      showToast(t("openStatsFailed", "failed to open stats"), "error");
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
          showToast(t("linkCopied", "link copied"), "success");
        } else {
          await tabsCreate({ url, active: true });
          showToast(t("openedShareLink", "opened share link"), "info");
        }
      } catch {
        await tabsCreate({ url, active: true });
        showToast(t("openedShareLink", "opened share link"), "info");
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
        if (elements.proPanel && !elements.proPanel.hidden) {
          closeProPanel();
          return;
        }
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
          showToast(elements.dryRunEl.checked ? t("dryOnToast", "dry run on") : t("dryOffToast", "dry run off"), "info");
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
        // 8.0: the mailbox report renders into the Report tab.
        if (msg.runKind === "reportScan") {
          handleReportProgress(msg);
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
          setStatus(t("canceledStatus", "canceled"), STATUS_TYPES.WARNING, true);
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
          setStatus(t("errorPrefix", `error: ${m}`, [m]), STATUS_TYPES.ERROR);
          showToast(t("failedPrefix", `failed: ${m}`, [m]), "error");
          // 7.4: layout-change errors carry a machine-readable code; the
          // detail already explains it, so just point at Diagnostics.
          if (msg.code === "gmail_layout_changed") {
            showToast(t("layoutChangedToast", "open Diagnostics (footer) for run details and updates"), "info", 6000);
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

          showSuccessCtas({
            dryRun: stats?.mode === "dry",
            cleaned: count,
            freedMb
          });
          maybeShowRatingForRun({
            dryRun: stats?.mode === "dry",
            cleaned: count,
            freedMb
          }).catch(() => {});
          setStatus(t("cleanupCompleteStatus", "cleanup complete"), STATUS_TYPES.SUCCESS, true);

          GCC.showToast(
            t("cleanupCompleteToast", "Cleanup complete! View recovery log in Stats to undo."),
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
    setStatus(t("looksRunningStatus", "looks like a cleanup is already running"), STATUS_TYPES.RUNNING);
    showProgress(35);

    showToast(t("activeDetectedToast", "active cleanup detected"), "info", 2000);

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
      elements.skipImportantEl,
      elements.skipUnreadEl,
      elements.skipLabeledEl
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
      elements.onbNextBtn.textContent = t("gotIt", "Got it");
    }
  };

  const setupEventListeners = () => {
    elements.runBtn.addEventListener("click", runCleanup);

    // 8.0 Mailbox Report.
    elements.reportScanBtn?.addEventListener("click", () => {
      handleReportScan().catch((e) => log("error", "report scan failed", e));
    });
    elements.reportList?.addEventListener("click", (e) => {
      const btn = e.target.closest?.("[data-band]");
      if (!btn) return;
      handleReportBandClick(btn.getAttribute("data-band")).catch((err) =>
        log("error", "report band run failed", err));
    });
    elements.reportPlanBtn?.addEventListener("click", () => {
      handleReportPlan().catch((e) => log("error", "report plan failed", e));
    });
    elements.reportBuyLink?.addEventListener("click", () => {
      openProPanel("report_upsell", { lead: GCC.report.upsellLine(state.report.bands) });
    });
    elements.reportEnterKey?.addEventListener("click", openProOptions);

    // 8.0 Pro proof panel. The buy button performs the same jump the
    // gates used to perform directly, with the same attribution label.
    elements.proPanelBuy?.addEventListener("click", () => {
      const source = proPanelState.source || "pro_panel";
      const fallback = proPanelState.fallbackUpsell;
      closeProPanel();
      openProCheckout(fallback, source).catch((e) => log("error", "checkout failed", e));
    });
    elements.proPanelKey?.addEventListener("click", () => {
      closeProPanel();
      openProOptions();
    });
    elements.proPanelBack?.addEventListener("click", closeProPanel);
    elements.proPanelClose?.addEventListener("click", closeProPanel);

    elements.activateHintBtn?.addEventListener("click", openProOptions);
    elements.activateHintClose?.addEventListener("click", () => {
      if (elements.activateHint) elements.activateHint.hidden = true;
      storageSet("local", { [STORAGE_KEYS.ACTIVATE_HINT_DISMISSED]: Date.now() }).catch(() => {});
    });

    // Remember which tab the user was last on.
    elements.tabBar?.addEventListener("click", (e) => {
      const tab = e.target.closest?.('[role="tab"]');
      if (tab?.id) rememberActiveTab(tab.id);
    });
    elements.tabBar?.addEventListener("keyup", () => {
      const selected = elements.tabBar?.querySelector('[role="tab"][aria-selected="true"]');
      if (selected?.id) rememberActiveTab(selected.id);
    });

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

    // 8.0: #rateBtn was a hardcoded Chrome Web Store anchor with no
    // handler, and the Firefox build shipped the same literal, so a
    // Firefox user who had just had a great cleanup was sent to a store
    // where they cannot review, under a button naming the wrong one.
    elements.rateBtn?.addEventListener("click", async () => {
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
      persistSubsSelection();
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
    // the locked toggle's click lands on the label and goes straight
    // to checkout.
    elements.autoPilotToggle?.addEventListener("change", handleAutoPilotToggle);
    elements.autoPilotConfirmBtn?.addEventListener("click", handleAutoPilotConfirm);
    elements.autoPilotToggle?.closest("label")?.addEventListener("click", () => {
      if (state.subs.licenseActive) return;
      openProPanel("autopilot_toggle_locked", {
        lead: GCC.popupUi.autoPilotUpsellLine(state.smart.visibleCount),
        fallbackUpsell: elements.autoPilotUpsell
      });
    });

    // 7.1 Gmail host access grant (must run inside this click gesture)
    elements.gmailAccessBtn?.addEventListener("click", async () => {
      const granted = await GCC.gmailAccess.request();
      if (granted) {
        await refreshBanners();
        setStatus("", STATUS_TYPES.INFO);
        showToast(t("accessGranted", "gmail access granted"), "success");
      } else {
        showToast(t("accessNotGranted", "access was not granted"), "warning");
      }
    });

    // 7.13 install-source guard: the banner's one action opens the
    // official listing for this browser so the user can reinstall.
    elements.installSourceStoreBtn?.addEventListener("click", async () => {
      await tabsCreate({ url: GCC.storeLinks().listing, active: true });
      setTimeout(safeClosePopup, 150);
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
      badge.setAttribute("aria-label", t("versionAria", `Version ${version}`, [version]));
    } catch (e) {
      log("warn", "syncVersionBadge failed", e);
    }
  };

  // 8.0: the tab bar always reset to Clean, so a user working through a
  // sender list or the report had to navigate back on every open. The
  // Report tab is the markup default because it is the one surface that
  // tells a new user something about their own mailbox.
  const restoreActiveTab = async () => {
    if (!state.tabs) return;
    try {
      const r = await storageGet("local", STORAGE_KEYS.ACTIVE_TAB);
      const id = r?.[STORAGE_KEYS.ACTIVE_TAB];
      if (typeof id === "string" && document.getElementById(id)) state.tabs.select(id);
    } catch {
      // Falls back to the markup default, which is fine.
    }
  };

  const rememberActiveTab = (id) => {
    if (typeof id !== "string" || !id) return;
    storageSet("local", { [STORAGE_KEYS.ACTIVE_TAB]: id }).catch(() => {});
  };

  // Buyers land back from Stripe with a key and no obvious place to put
  // it: activate.html tells them to right-click the toolbar icon and
  // find Options. Anyone who has run a cleanup but has no license sees
  // one line offering the shortcut.
  const maybeShowActivateHint = async () => {
    if (!elements.activateHint) return;
    if (state.subs.licenseActive) return;
    try {
      const r = await storageGet("local", [STORAGE_KEYS.RUN_COUNT, STORAGE_KEYS.ACTIVATE_HINT_DISMISSED]);
      if (r?.[STORAGE_KEYS.ACTIVATE_HINT_DISMISSED]) return;
      if (!(Number(r?.[STORAGE_KEYS.RUN_COUNT]) > 0)) return;
      elements.activateHint.hidden = false;
      // One strip at a time. Someone who already bought does not need
      // the pitch stacked on top of the place to redeem it.
      if (elements.proPromo) elements.proPromo.hidden = true;
    } catch {
      // Best effort only; the footer Pro button is always there.
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
    await restoreActiveTab();

    setupEventListeners();

    await initAdvancedDisclosure();
    await restoreLastConfig();
    await restoreActiveRunUI();
    // 7.4: replay the last unseen cleanup (active runs win inside).
    await maybeShowPostRunRecap().catch((e) => log("warn", "recap failed", e));
    await refreshBanners();
    await maybeShowOnboarding();

    loadGmailAccounts();

    // 7.0 subscriptions: license badge + last scan (both best-effort).
    refreshLicenseUi().catch((e) => log("warn", "license ui failed", e));
    // The remembered tick list has to land before the list renders.
    await loadSubsSelection();
    loadStoredSubscriptions().catch((e) => log("warn", "subs load failed", e));
    // 7.2 storage X-ray: last scan (best-effort).
    loadStoredStorageScan().catch((e) => log("warn", "xray load failed", e));
    // 7.8 Smart Suggestions: disclosure state + stored scan.
    await initSmartDisclosure();
    loadStoredSmartScan().catch((e) => log("warn", "smart load failed", e));
    // 7.12 Auto-Pilot: settings snapshot (best-effort).
    loadAutoPilot().catch((e) => log("warn", "autopilot load failed", e));
    // 8.0 Mailbox Report: last scan (best-effort).
    loadStoredReport().catch((e) => log("warn", "report load failed", e));
    maybeShowActivateHint().catch((e) => log("warn", "activate hint failed", e));

    log("info", "ready");
  };

  init().catch((e) => {
    console.error("[Gmail Cleaner Popup] init failed:", e);
    setStatus("init error", STATUS_TYPES.ERROR);
  });
});
