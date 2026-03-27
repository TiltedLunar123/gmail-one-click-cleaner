(() => {
  "use strict";

  // =========================
  // Constants & Configuration
  // =========================

  const OPTIONS_VERSION = "3.5.0";

  const CONFIG = Object.freeze({
    TOAST_DURATION_MS: 3000,
    DEBOUNCE_DELAY_MS: 300,
    SAVE_SUCCESS_DURATION_MS: 2000,
    MAX_WHITELIST_ENTRIES: 100,
    MAX_RULES_PER_CATEGORY: 50
  });

  const STORAGE_KEYS = Object.freeze({
    RULES: "rules",
    DEBUG_MODE: "debugMode",
    WHITELIST: "whitelist"
  });

  const RULE_KEYS = Object.freeze(["light", "normal", "deep"]);

  // Keep these in sync with the content script defaults.
  const DEFAULT_RULES = Object.freeze({
    light: Object.freeze([
      "larger:20M",
      "has:attachment larger:10M older_than:6m",
      "category:promotions older_than:1y",
      "category:social older_than:1y",
      "\"unsubscribe\" older_than:2y"
    ]),
    normal: Object.freeze([
      "larger:20M",
      "has:attachment larger:10M older_than:6m",
      "has:attachment larger:5M older_than:2y",
      "category:promotions older_than:3m",
      "category:promotions older_than:1y",
      "category:social older_than:6m",
      "category:updates older_than:6m",
      "category:forums older_than:6m",
      "has:newsletter older_than:6m",
      "\"unsubscribe\" older_than:1y",
      "from:(no-reply@ OR donotreply@ OR \"do-not-reply\") older_than:6m"
    ]),
    deep: Object.freeze([
      "larger:20M",
      "has:attachment larger:10M older_than:3m",
      "has:attachment larger:5M older_than:1y",
      "category:promotions older_than:2m",
      "category:promotions older_than:6m",
      "category:social older_than:3m",
      "category:social older_than:6m",
      "category:updates older_than:3m",
      "category:forums older_than:3m",
      "has:newsletter older_than:3m",
      "\"unsubscribe\" older_than:6m",
      "from:(no-reply@ OR donotreply@ OR \"do-not-reply\") older_than:3m"
    ])
  });

  // =========================
  // State Management
  // =========================

  const state = {
    saving: false,
    hasUnsavedChanges: false,
    initialData: null
  };

  // =========================
  // Utility Functions
  // =========================

  /** @param {string} id */
  const $ = (id) => document.getElementById(id);

  /** @param {string} selector */
  const qs = (selector) => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  /** @template T @param {T} obj @returns {T} */
  const clone = (obj) => {
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(obj);
      } catch {
        // fall through
      }
    }
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return obj;
    }
  };

  /** @template {(...args:any[])=>any} T @param {T} fn @param {number} delay @returns {T} */
  const debounce = (fn, delay) => {
    let timeoutId = null;
    return /** @type {T} */ ((...args) => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delay);
    });
  };

  const hasSyncStorage = () => {
    try {
      return (
        typeof chrome !== "undefined" &&
        !!chrome?.storage?.sync &&
        typeof chrome.storage.sync.get === "function" &&
        typeof chrome.storage.sync.set === "function"
      );
    } catch {
      return false;
    }
  };

  const storageGet = (keys) =>
    new Promise((resolve) => {
      chrome.storage.sync.get(keys, resolve);
    });

  const storageSet = (obj) =>
    new Promise((resolve, reject) => {
      chrome.storage.sync.set(obj, () => {
        if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

  const getDateStamp = () => new Date().toISOString().slice(0, 10);

  const safeConfirmLabel = (s) => String(s || "").replace(/[\r\n\t]/g, " ").trim();

  // =========================
  // Toast Notifications
  // =========================

  /** @typedef {"success"|"error"|"warning"|"info"} ToastType */

  const TOAST_ICONS = Object.freeze({
    success: "✅",
    error: "❌",
    warning: "⚠️",
    info: "ℹ️"
  });

  /**
   * @param {string} message
   * @param {ToastType} [type="info"]
   * @param {number} [duration]
   */
  const showToast = (message, type = "info", duration = CONFIG.TOAST_DURATION_MS) => {
    const container = qs(".toast-container");
    if (!container) {
      console.log(`[Toast ${type}] ${message}`);
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

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.parentNode && toast.parentNode.removeChild(toast), 300);
    }, duration);
  };

  const srStatus = (msg) => {
    const el = $("srStatus");
    if (el) el.textContent = msg || "";
  };

  // =========================
  // Button State Management
  // =========================

  const getPrimaryLabelNode = (btn) => btn?.querySelector?.(".save-text") || null;

  /**
   * @param {HTMLButtonElement | null} btn
   * @param {boolean} loading
   * @param {string} [loadingText]
   */
  const setButtonLoading = (btn, loading, loadingText) => {
    if (!btn) return;

    btn.disabled = loading;

    const labelNode = getPrimaryLabelNode(btn);

    if (loading) {
      btn.classList.add("loading");
      btn.setAttribute("aria-busy", "true");

      if (loadingText) {
        if (labelNode) {
          btn.dataset.originalText = labelNode.textContent || "";
          labelNode.textContent = loadingText;
        } else {
          btn.dataset.originalText = btn.textContent || "";
          btn.textContent = loadingText;
        }
      }
    } else {
      btn.classList.remove("loading");
      btn.removeAttribute("aria-busy");

      if (btn.dataset.originalText) {
        if (labelNode) labelNode.textContent = btn.dataset.originalText;
        else btn.textContent = btn.dataset.originalText;
        delete btn.dataset.originalText;
      }
    }
  };

  /** @param {HTMLButtonElement | null} btn */
  const showButtonSuccess = (btn) => {
    if (!btn) return;

    btn.classList.add("success");
    const labelNode = getPrimaryLabelNode(btn);
    const originalText = labelNode ? labelNode.textContent : btn.textContent;

    if (labelNode) labelNode.textContent = "Saved!";
    else btn.textContent = "Saved!";

    setTimeout(() => {
      btn.classList.remove("success");
      if (labelNode) labelNode.textContent = originalText || "Save rules";
      else btn.textContent = originalText || "Save rules";
    }, CONFIG.SAVE_SUCCESS_DURATION_MS);
  };

  // =========================
  // Unsaved Changes Tracking
  // =========================

  const updateUnsavedIndicator = () => {
    const indicator = $("unsavedIndicator");
    if (!indicator) return;

    indicator.classList.toggle("show", !!state.hasUnsavedChanges);

    document.title = state.hasUnsavedChanges
      ? "• Gmail One-Click Cleaner – Rules & Settings"
      : "Gmail One-Click Cleaner – Rules & Settings";
  };

  const markUnsaved = () => {
    state.hasUnsavedChanges = true;
    updateUnsavedIndicator();
  };

  const clearUnsaved = () => {
    state.hasUnsavedChanges = false;
    updateUnsavedIndicator();
  };

  const hasDataChanged = () => {
    if (!state.initialData) return false;
    const currentData = collectAllData();
    return JSON.stringify(currentData) !== JSON.stringify(state.initialData);
  };

  // =========================
  // Char / Line Counters (optional enhancement)
  // =========================

  const countLines = (value) => {
    const lines = String(value || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return lines.length;
  };

  const updateCountFor = (textareaId, countElId) => {
    const ta = $(textareaId);
    const el = $(countElId);
    if (!ta || !el) return;

    const n = countLines(ta.value);
    el.textContent = `${n} line${n === 1 ? "" : "s"}`;
    el.style.display = "block";
  };

  const updateAllCounts = () => {
    updateCountFor("light", "lightCount");
    updateCountFor("normal", "normalCount");
    updateCountFor("deep", "deepCount");
    updateCountFor("whitelist", "whitelistCount");
  };

  // =========================
  // Rules & Settings Helpers
  // =========================

  const uniqTrimmed = (arr) => {
    const out = [];
    const seen = new Set();
    for (const raw of arr || []) {
      if (typeof raw !== "string") continue;
      const s = raw.trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  };

  /**
   * @param {any} rules
   * @returns {{ light: string[]; normal: string[]; deep: string[] }}
   */
  const normalizeRules = (rules) => {
    if (!rules || typeof rules !== "object") return clone(DEFAULT_RULES);

    const out = { light: [], normal: [], deep: [] };

    for (const key of RULE_KEYS) {
      const source = Array.isArray(rules[key]) ? rules[key] : DEFAULT_RULES[key];
      out[key] = uniqTrimmed(source).slice(0, CONFIG.MAX_RULES_PER_CATEGORY);
    }

    // Ensure Normal exists (your “recommended” baseline)
    if (out.normal.length === 0) out.normal = uniqTrimmed(DEFAULT_RULES.normal);

    return out;
  };

  /**
   * Accept:
   * - user@domain.com
   * - *@domain.com
   * - domain.com / sub.domain.com
   * @param {string} entry
   */
  const isValidWhitelistEntry = (entry) => {
    const s = String(entry || "").trim();
    if (!s) return false;
    if (/\s/.test(s)) return false;

    const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
    const WILDCARD_EMAIL = /^\*@([a-z0-9.-]+\.[a-z]{2,})$/i;
    const DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;

    return EMAIL.test(s) || WILDCARD_EMAIL.test(s) || DOMAIN.test(s);
  };

  /**
   * @param {any} whitelist
   * @returns {string[]}
   */
  const normalizeWhitelist = (whitelist) => {
    if (!Array.isArray(whitelist)) return [];
    return uniqTrimmed(whitelist)
      .filter((s) => isValidWhitelistEntry(s))
      .slice(0, CONFIG.MAX_WHITELIST_ENTRIES);
  };

  /**
   * @param {{ light?: string[]; normal?: string[]; deep?: string[] }} rules
   */
  const renderRules = (rules) => {
    RULE_KEYS.forEach((key) => {
      const el = $(key);
      if (el) el.value = (rules[key] || []).join("\n");
    });
    updateAllCounts();
  };

  /**
   * @param {{ debugMode?: boolean; whitelist?: string[] }} settings
   */
  const renderSettings = (settings) => {
    const debugEl = $("debugMode");
    if (debugEl) debugEl.checked = Boolean(settings.debugMode);

    const whitelistEl = $("whitelist");
    if (whitelistEl) {
      const normalizedWhitelist = normalizeWhitelist(settings.whitelist);
      whitelistEl.value = normalizedWhitelist.join("\n");
    }
    updateAllCounts();
  };

  /** @param {string} id */
  const readLines = (id) => {
    const el = $(id);
    if (!el || !el.value) return [];
    return uniqTrimmed(
      el.value.split("\n").map((s) => String(s || "").trim()).filter(Boolean)
    );
  };

  /**
   * @returns {{ rules: { light: string[]; normal: string[]; deep: string[] }; debugMode: boolean; whitelist: string[] }}
   */
  const collectAllData = () => {
    /** @type {{light:string[]; normal:string[]; deep:string[]}} */
    const rules = { light: [], normal: [], deep: [] };
    RULE_KEYS.forEach((key) => (rules[key] = readLines(key)));

    const debugEl = $("debugMode");
    const debugMode = debugEl ? debugEl.checked : false;

    const whitelist = normalizeWhitelist(readLines("whitelist"));

    return { rules, debugMode, whitelist };
  };

  // =========================
  // Load / Save
  // =========================

  const loadData = async () => {
    try {
      if (!hasSyncStorage()) {
        console.warn("[Gmail Cleaner] Sync storage not available, using defaults.");
        renderRules(clone(DEFAULT_RULES));
        renderSettings({ debugMode: false, whitelist: [] });
        state.initialData = collectAllData();
        clearUnsaved();
        return;
      }

      const data = await storageGet([STORAGE_KEYS.RULES, STORAGE_KEYS.DEBUG_MODE, STORAGE_KEYS.WHITELIST]);

      const normalizedRules = normalizeRules(data[STORAGE_KEYS.RULES]);
      renderRules(normalizedRules);

      renderSettings({
        debugMode: Boolean(data[STORAGE_KEYS.DEBUG_MODE]),
        whitelist: data[STORAGE_KEYS.WHITELIST] || []
      });

      state.initialData = collectAllData();
      clearUnsaved();
      srStatus("Settings loaded.");
    } catch (err) {
      console.error("[Gmail Cleaner] Failed to load settings:", err);
      showToast("Failed to load settings", "error");
      renderRules(clone(DEFAULT_RULES));
      renderSettings({ debugMode: false, whitelist: [] });
      state.initialData = collectAllData();
      clearUnsaved();
      srStatus("Failed to load settings.");
    }
  };

  /**
   * @param {{ rules: { light: string[]; normal: string[]; deep: string[] }; whitelist: string[] }} data
   */
  const validateData = (data) => {
    const errors = [];

    // Keep Normal non-empty.
    if (!data?.rules?.normal || data.rules.normal.length === 0) {
      errors.push("Normal rules cannot be empty");
    }

    // Validate whitelist entries
    (data?.whitelist || []).forEach((entry, index) => {
      if (!isValidWhitelistEntry(entry)) {
        errors.push(`Invalid whitelist entry at line ${index + 1}: "${entry}"`);
      }
    });

    return { valid: errors.length === 0, errors };
  };

  /**
   * @param {Event|null} [evt]
   * @param {{ silent?: boolean; successToast?: string }} [opts]
   */
  const saveData = async (evt = null, opts = {}) => {
    evt?.preventDefault?.();

    if (state.saving) return;
    state.saving = true;

    const btn = /** @type {HTMLButtonElement|null} */ ($("save"));
    setButtonLoading(btn, true, "Saving...");
    srStatus("Saving settings...");

    try {
      const data = collectAllData();
      const validation = validateData(data);

      if (!validation.valid) {
        showToast(validation.errors[0], "warning");
        console.warn("[Gmail Cleaner] Validation errors:", validation.errors);
        // still allow save, but warn
      }

      if (!hasSyncStorage()) throw new Error("Chrome sync storage is not available");

      await storageSet({
        [STORAGE_KEYS.RULES]: normalizeRules(data.rules),
        [STORAGE_KEYS.DEBUG_MODE]: !!data.debugMode,
        [STORAGE_KEYS.WHITELIST]: normalizeWhitelist(data.whitelist)
      });

      state.initialData = collectAllData();
      clearUnsaved();

      if (!opts.silent) {
        showToast(opts.successToast || "Settings saved successfully!", "success");
        showButtonSuccess(btn);
      }

      srStatus("Settings saved.");
    } catch (err) {
      console.error("[Gmail Cleaner] Failed to save:", err);
      showToast(`Failed to save: ${err?.message || "Unknown error"}`, "error");
      srStatus("Failed to save settings.");
    } finally {
      setButtonLoading(btn, false);
      state.saving = false;
    }
  };

  // =========================
  // Unsaved Change Listeners
  // =========================

  const setupChangeListeners = () => {
    const textareas = ["light", "normal", "deep", "whitelist"];
    const checkboxes = ["debugMode"];

    const onPotentialChange = debounce(() => {
      updateAllCounts();
      hasDataChanged() ? markUnsaved() : clearUnsaved();
    }, CONFIG.DEBOUNCE_DELAY_MS);

    textareas.forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("input", onPotentialChange);
    });

    checkboxes.forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("change", () => (hasDataChanged() ? markUnsaved() : clearUnsaved()));
    });

    window.addEventListener("beforeunload", (e) => {
      if (!state.hasUnsavedChanges) return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    });
  };

  // =========================
  // Restore Defaults
  // =========================

  const showConfirmDialog = () =>
    new Promise((resolve) => {
      const dialog = /** @type {HTMLDialogElement|null} */ ($("confirmDialog"));

      if (!dialog || typeof dialog.showModal !== "function") {
        resolve(
          confirm(
            "Restore default rules and settings?\n\nThis replaces your current settings.\n" +
              "This cannot be undone unless you have a backup."
          )
        );
        return;
      }

      const cancelBtn = $("dialogCancelBtn");
      const confirmBtn = $("dialogConfirmBtn");

      const cleanup = () => {
        cancelBtn?.removeEventListener("click", onCancel);
        confirmBtn?.removeEventListener("click", onConfirm);
        dialog.removeEventListener("close", onClose);
      };

      const onCancel = () => dialog.close("cancel");
      const onConfirm = () => dialog.close("confirm");
      const onClose = () => {
        const ok = dialog.returnValue === "confirm";
        cleanup();
        resolve(ok);
      };

      cancelBtn?.addEventListener("click", onCancel);
      confirmBtn?.addEventListener("click", onConfirm);
      dialog.addEventListener("close", onClose);

      dialog.showModal();
    });

  const restoreDefaults = async () => {
    const confirmed = await showConfirmDialog();
    if (!confirmed) return;

    renderRules(clone(DEFAULT_RULES));
    renderSettings({ debugMode: false, whitelist: [] });
    markUnsaved();

    await saveData(null, { silent: true });
    clearUnsaved();

    showToast("Settings restored to defaults", "success");
    srStatus("Defaults restored.");
  };

  // =========================
  // Import / Export
  // =========================

  const exportConfig = async () => {
    const btn = /** @type {HTMLButtonElement|null} */ ($("exportBtn"));
    setButtonLoading(btn, true);

    try {
      const current = collectAllData();

      const exportObj = {
        rules: normalizeRules(current.rules),
        debugMode: !!current.debugMode,
        whitelist: normalizeWhitelist(current.whitelist),
        exportedAt: new Date().toISOString(),
        version: OPTIONS_VERSION,
        extensionName: "Gmail One-Click Cleaner"
      };

      const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `gmail-cleaner-config-${getDateStamp()}.json`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);

      showToast("Configuration exported successfully", "success");
      srStatus("Configuration exported.");
    } catch (err) {
      console.error("[Gmail Cleaner] Export failed:", err);
      showToast(`Export failed: ${err?.message || "Unknown error"}`, "error");
      srStatus("Export failed.");
    } finally {
      setButtonLoading(btn, false);
    }
  };

  const triggerImport = () => {
    const fileInput = /** @type {HTMLInputElement|null} */ ($("importFile"));
    if (!fileInput) return;
    fileInput.value = "";
    fileInput.click();
  };

  /**
   * @param {any} json
   * @returns {{ valid: boolean; errors: string[] }}
   */
  const validateImport = (json) => {
    const errors = [];

    if (!json || typeof json !== "object") {
      errors.push("Invalid JSON format");
      return { valid: false, errors };
    }

    if (!json.rules || typeof json.rules !== "object") {
      errors.push("Missing or invalid 'rules' property");
    } else {
      const hasRules = RULE_KEYS.some((key) => Array.isArray(json.rules[key]) && json.rules[key].length > 0);
      if (!hasRules) errors.push("Configuration has no valid rules");
    }

    if (json.whitelist && !Array.isArray(json.whitelist)) errors.push("'whitelist' must be an array");

    return { valid: errors.length === 0, errors };
  };

  /** @param {Event} evt */
  const handleImportFile = async (evt) => {
    const fileInput = /** @type {HTMLInputElement} */ (evt.target);
    const file = fileInput.files?.[0];
    if (!file) return;

    const btn = /** @type {HTMLButtonElement|null} */ ($("importBtn"));
    setButtonLoading(btn, true);
    srStatus("Importing configuration...");

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      const validation = validateImport(json);
      if (!validation.valid) throw new Error(validation.errors.join("; "));

      const ruleCount = RULE_KEYS.reduce((sum, key) => sum + (json.rules?.[key]?.length || 0), 0);
      const whitelistCount = Array.isArray(json.whitelist) ? json.whitelist.length : 0;

      const name = safeConfirmLabel(file.name);

      const confirmMsg =
        `Import configuration from "${name}"?\n\n` +
        `• ${ruleCount} total rules\n` +
        `• ${whitelistCount} whitelist entries\n` +
        `• Debug mode: ${json.debugMode ? "On" : "Off"}\n\n` +
        `This will replace your current settings.`;

      if (!confirm(confirmMsg)) {
        fileInput.value = "";
        srStatus("Import cancelled.");
        return;
      }

      if (!hasSyncStorage()) throw new Error("Chrome sync storage is not available");

      await storageSet({
        [STORAGE_KEYS.RULES]: normalizeRules(json.rules),
        [STORAGE_KEYS.DEBUG_MODE]: !!json.debugMode,
        [STORAGE_KEYS.WHITELIST]: normalizeWhitelist(json.whitelist)
      });

      await loadData();
      clearUnsaved();

      showToast("Configuration imported successfully!", "success");
      srStatus("Configuration imported.");
    } catch (err) {
      console.error("[Gmail Cleaner] Import error:", err);

      if (err instanceof SyntaxError) showToast("Invalid JSON file format", "error");
      else showToast(`Import failed: ${err?.message || "Unknown error"}`, "error");

      srStatus("Import failed.");
    } finally {
      fileInput.value = "";
      setButtonLoading(btn, false);
    }
  };

  // =========================
  // Keyboard Shortcuts
  // =========================

  const setupKeyboardShortcuts = () => {
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveData();
      }

      if (e.key === "Escape") {
        const dialog = /** @type {HTMLDialogElement|null} */ ($("confirmDialog"));
        if (dialog && dialog.open) dialog.close("cancel");
      }
    });
  };

  // =========================
  // Initialization
  // =========================

  const setupEventListeners = () => {
    const saveBtn = $("save");
    saveBtn?.addEventListener("click", (e) => saveData(e));

    const restoreBtn = $("restoreDefaultsBtn");
    restoreBtn?.addEventListener("click", restoreDefaults);

    const exportBtn = $("exportBtn");
    exportBtn?.addEventListener("click", exportConfig);

    const importBtn = $("importBtn");
    importBtn?.addEventListener("click", triggerImport);

    const fileInput = $("importFile");
    fileInput?.addEventListener("change", handleImportFile);

    setupChangeListeners();
    setupKeyboardShortcuts();
  };

  const init = async () => {
    console.log(`[Gmail Cleaner] Options page v${OPTIONS_VERSION} initializing...`);
    setupEventListeners();
    await loadData();
    updateAllCounts();
    console.log("[Gmail Cleaner] Options page ready.");
  };

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // =========================
  // Custom Rules Editor
  // =========================

  const CUSTOM_RULES_KEY = "customRules";

  async function loadCustomRules() {
    if (!hasSyncStorage()) return [];
    try {
      const result = await storageGet(CUSTOM_RULES_KEY);
      return result?.[CUSTOM_RULES_KEY] || [];
    } catch { return []; }
  }

  async function saveCustomRules(rules) {
    if (!hasSyncStorage()) return;
    await storageSet({ [CUSTOM_RULES_KEY]: rules });
  }

  async function renderCustomRules() {
    const container = $("customRulesList");
    if (!container) return;

    const rules = await loadCustomRules();
    container.textContent = "";

    if (rules.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "text-align:center; padding:16px; color:var(--text-muted); font-size:13px;";
      empty.textContent = "No custom rules yet. Add one below.";
      container.appendChild(empty);
      return;
    }

    rules.forEach((rule, idx) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:8px; padding:8px 12px; background:rgba(15,23,42,0.4); border:1px solid rgba(255,255,255,0.06); border-radius:8px;";

      const query = document.createElement("code");
      query.style.cssText = "flex:1; font-size:12px; color:var(--text-main); word-break:break-all;";
      query.textContent = rule.query;

      const action = document.createElement("span");
      action.style.cssText = "font-size:11px; padding:2px 8px; border-radius:9999px; font-weight:600; text-transform:uppercase;";
      if (rule.action === "archive") {
        action.style.background = "rgba(16,185,129,0.15)";
        action.style.color = "#10b981";
      } else if (rule.action === "label") {
        action.style.background = "rgba(56,189,248,0.15)";
        action.style.color = "#0ea5e9";
      } else {
        action.style.background = "rgba(239,68,68,0.15)";
        action.style.color = "#ef4444";
      }
      action.textContent = rule.action;

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "\u00D7";
      deleteBtn.title = "Remove rule";
      deleteBtn.style.cssText = "background:none; border:none; color:#ef4444; font-size:18px; cursor:pointer; padding:0 4px; line-height:1;";
      deleteBtn.addEventListener("click", async () => {
        const allRules = await loadCustomRules();
        allRules.splice(idx, 1);
        await saveCustomRules(allRules);
        renderCustomRules();
        showToast("Rule removed", "success");
      });

      row.appendChild(query);
      row.appendChild(action);
      row.appendChild(deleteBtn);
      container.appendChild(row);
    });
  }

  const addCustomRuleBtn = $("addCustomRuleBtn");
  const newCustomQuery = $("newCustomQuery");
  const newCustomAction = $("newCustomAction");

  if (addCustomRuleBtn) {
    addCustomRuleBtn.addEventListener("click", async () => {
      const query = (newCustomQuery?.value || "").trim();
      if (!query) {
        showToast("Enter a Gmail search query", "warning");
        return;
      }
      const action = newCustomAction?.value || "delete";
      const rules = await loadCustomRules();
      if (rules.length >= 20) {
        showToast("Maximum 20 custom rules", "warning");
        return;
      }
      rules.push({ query, action, createdAt: Date.now() });
      await saveCustomRules(rules);
      if (newCustomQuery) newCustomQuery.value = "";
      renderCustomRules();
      showToast("Custom rule added", "success");
    });
  }

  renderCustomRules();

  // =========================
  // Scheduled Cleanups
  // =========================

  const sendSwMessage = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime?.lastError) resolve(null);
        else resolve(resp);
      });
    } catch { resolve(null); }
  });

  async function renderSchedules() {
    const container = $("schedulesList");
    if (!container) return;

    const resp = await sendSwMessage({ type: "gmailCleanerGetSchedules" });
    const schedules = resp?.schedules || [];
    container.textContent = "";

    if (schedules.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "text-align:center; padding:16px; color:var(--text-muted); font-size:13px;";
      empty.textContent = "No scheduled cleanups. Add one below.";
      container.appendChild(empty);
      return;
    }

    const freqLabels = { "1440": "Daily", "10080": "Weekly", "43200": "Monthly" };

    schedules.forEach((schedule) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:8px; padding:10px 12px; background:rgba(15,23,42,0.4); border:1px solid rgba(255,255,255,0.06); border-radius:8px;";

      const info = document.createElement("div");
      info.style.cssText = "flex:1;";

      const title = document.createElement("div");
      title.style.cssText = "font-size:13px; font-weight:500; color:var(--text-main);";
      title.textContent = (freqLabels[String(schedule.intervalMinutes)] || "Custom") + " " + schedule.intensity + " clean";

      const meta = document.createElement("div");
      meta.style.cssText = "font-size:11px; color:var(--text-muted); margin-top:2px;";
      meta.textContent = "Min age: " + (schedule.minAge || "3m") +
        (schedule.lastRun ? " \u00B7 Last: " + new Date(schedule.lastRun).toLocaleDateString() : "");

      info.appendChild(title);
      info.appendChild(meta);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = schedule.enabled ? "Enabled" : "Disabled";
      toggle.style.cssText = "padding:4px 10px; border-radius:9999px; font-size:11px; font-weight:600; border:1px solid; cursor:pointer;";
      if (schedule.enabled) {
        toggle.style.background = "rgba(16,185,129,0.15)";
        toggle.style.borderColor = "rgba(16,185,129,0.3)";
        toggle.style.color = "#10b981";
      } else {
        toggle.style.background = "rgba(100,116,139,0.15)";
        toggle.style.borderColor = "rgba(100,116,139,0.3)";
        toggle.style.color = "#64748b";
      }
      toggle.addEventListener("click", async () => {
        schedule.enabled = !schedule.enabled;
        await sendSwMessage({ type: "gmailCleanerSaveSchedule", schedule });
        renderSchedules();
        showToast(schedule.enabled ? "Schedule enabled" : "Schedule disabled", "info");
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "\u00D7";
      deleteBtn.title = "Remove schedule";
      deleteBtn.style.cssText = "background:none; border:none; color:#ef4444; font-size:18px; cursor:pointer; padding:0 4px; line-height:1;";
      deleteBtn.addEventListener("click", async () => {
        await sendSwMessage({ type: "gmailCleanerDeleteSchedule", scheduleId: schedule.id });
        renderSchedules();
        showToast("Schedule removed", "success");
      });

      row.appendChild(info);
      row.appendChild(toggle);
      row.appendChild(deleteBtn);
      container.appendChild(row);
    });
  }

  const addScheduleBtn = $("addScheduleBtn");
  if (addScheduleBtn) {
    addScheduleBtn.addEventListener("click", async () => {
      const interval = $("scheduleInterval")?.value || "10080";
      const intensity = $("scheduleIntensity")?.value || "light";
      const minAge = $("scheduleAge")?.value || "3m";

      const schedule = {
        id: "sched_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        enabled: true,
        intervalMinutes: parseInt(interval, 10),
        intensity,
        minAge,
        action: "delete",
        whitelist: [],
        createdAt: Date.now(),
        lastRun: null
      };

      await sendSwMessage({ type: "gmailCleanerSaveSchedule", schedule });
      renderSchedules();
      showToast("Schedule created", "success");
    });
  }

  renderSchedules();
})();
