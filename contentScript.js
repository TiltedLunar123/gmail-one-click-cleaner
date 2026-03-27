(() => {
  "use strict";

  const GCC_CONTENT_VERSION = "4.0.0";

  // =========================
  // Timing & behavior constants
  // =========================

  const TIMING = Object.freeze({
    PASS_CAP: 150,
    WAIT_DEFAULT_TIMEOUT: 15000,
    WAIT_DEFAULT_INTERVAL: 200,
    WAIT_TOOLBAR_TIMEOUT: 8000,
    WAIT_SEARCH_TIMEOUT: 20000,
    POST_ACTION_DELAY_MS: 800,
    BETWEEN_PASS_SLEEP_MS: 650,
    LABEL_DIALOG_TIMEOUT: 5000,
    KEYBOARD_ACTION_DELAY: 250,
    DOM_SETTLE_DELAY: 300,
    CHECKBOX_SETTLE_DELAY: 250,
    LABEL_APPLY_DELAY: 400,
    REVIEW_POLL_INTERVAL: 200,
    BULK_CONFIRM_TIMEOUT: 3000,
    SELECT_ALL_SETTLE_DELAY: 500,
    SELECTION_VERIFY_TIMEOUT: 2000,
    LIST_REFRESH_TIMEOUT: 5000,
    MIN_SLEEP_INTERVAL: 10,

    // v3.3: adaptive throttling / auto-recover
    RATE_LIMIT_BACKOFF_START_MS: 1500,
    RATE_LIMIT_BACKOFF_MAX_MS: 30000,
    RATE_LIMIT_BACKOFF_MULTIPLIER: 1.8,
    RATE_LIMIT_BACKOFF_DEESCALATE: 0.6,
    RATE_LIMIT_MAX_RETRIES_PER_PASS: 6
  });

  // UI position thresholds
  const UI_THRESHOLDS = Object.freeze({
    TOOLBAR_TOP_POSITION: 200
  });

  // Run-level guardrails
  const GUARDRAILS = Object.freeze({
    RUN_SOFT_CAP: 10000,
    HUGE_RUN_CONFIRM_THRESHOLD: 20000,
    MAX_HISTORY_ENTRIES: 10
  });

  // v3.4: Safe Mode additional subject guard (protect receipts, orders, shipping, etc.)
  const SAFE_MODE_SUBJECT_GUARD = Object.freeze(
    '-subject:(receipt OR invoice OR "order" OR shipped OR shipping OR tracking OR delivered OR delivery OR confirmation OR refund OR return)'
  );

  // =========================
  // Boot & basic utilities
  // =========================

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  const cancellableSleep = async (ms, isCancelled) => {
    const start = Date.now();
    const interval = Math.max(TIMING.MIN_SLEEP_INTERVAL, Math.min(100, ms));

    while (Date.now() - start < ms) {
      if (isCancelled()) {
        throw new CancellationError("Operation cancelled during sleep");
      }
      await sleep(interval);
    }
  };

  class CancellationError extends Error {
    constructor(message = "Cancelled") {
      super(message);
      this.name = "CancellationError";
    }
  }

  class TimeoutError extends Error {
    constructor(message = "Operation timed out") {
      super(message);
      this.name = "TimeoutError";
    }
  }

  // v3.3: treat Gmail "try again later" states as recoverable
  class RateLimitError extends Error {
    constructor(message = "Rate limited / temporary Gmail error") {
      super(message);
      this.name = "RateLimitError";
    }
  }

  const hasChromeRuntime = (() => {
    let cached = null;
    return () => {
      if (cached !== null) return cached;
      try {
        cached = (
          typeof chrome !== "undefined" &&
          chrome?.runtime &&
          typeof chrome.runtime.sendMessage === "function"
        );
      } catch {
        cached = false;
      }
      return cached;
    };
  })();

  function hasChromeStorage(type = "sync") {
    try {
      return (
        typeof chrome !== "undefined" &&
        chrome?.storage?.[type] &&
        typeof chrome.storage[type].get === "function"
      );
    } catch {
      return false;
    }
  }

  const qs = (selector, root = document) => {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  };

  const qsa = (selector, root = document) => {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  };

  const qsFirst = (selectors, root = document) => {
    for (const selector of selectors) {
      const el = qs(selector, root);
      if (el) return el;
    }
    return null;
  };

  const getTextContent = (el) => {
    if (!el) return "";
    return (el.textContent || el.innerText || "").trim();
  };

  const getAttr = (el, attr) => {
    if (!el) return "";
    return (el.getAttribute(attr) || "").trim();
  };

  const getElementLabel = (el) => {
    return (
      getAttr(el, "aria-label") ||
      getAttr(el, "data-tooltip") ||
      getAttr(el, "title") ||
      getTextContent(el)
    );
  };

  const logError = (err, context = "") => {
    try {
      console.error("[GmailCleaner Error]", context, err);
    } catch {
      // Ignore logging failures.
    }
  };

  const debounce = (fn, delay) => {
    let timeoutId = null;
    return (...args) => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delay);
    };
  };

  const safeSend = debounce((msg) => {
    try {
      if (hasChromeRuntime()) {
        chrome.runtime.sendMessage({
          type: "gmailCleanerProgress",
          timestamp: Date.now(),
          version: GCC_CONTENT_VERSION,
          ...msg
        });
      }
    } catch (e) {
      logError(e, "safeSend");
    }
  }, 50);

  const safeSendImmediate = (msg) => {
    try {
      if (hasChromeRuntime()) {
        chrome.runtime.sendMessage({
          type: "gmailCleanerProgress",
          timestamp: Date.now(),
          version: GCC_CONTENT_VERSION,
          ...msg
        });
      }
    } catch (e) {
      logError(e, "safeSendImmediate");
    }
  };

  if (window.GCC_ATTACHED) {
    safeSendImmediate({
      phase: "boot",
      status: "Already attached",
      detail: "Duplicate inject ignored.",
      percent: 0
    });
    return;
  }
  window.GCC_ATTACHED = true;

  const cleanup = () => {
    window.GCC_ATTACHED = false;
    CANCELLED = true;
  };

  window.addEventListener("beforeunload", cleanup, { once: true });
  window.addEventListener("unload", cleanup, { once: true });

  safeSendImmediate({
    phase: "boot",
    status: "Content script attached",
    detail: `Initializing (v${GCC_CONTENT_VERSION})...`,
    percent: 0
  });

  // =========================
  // Config / runtime flags
  // =========================

  let CANCELLED = false;
  let RUNNING = false;
  let REVIEW_SIGNAL = null;
  let liveRunProcessedSoFar = 0;

  // v3.3: dynamic backoff for throttling
  let dynamicBackoffMs = TIMING.RATE_LIMIT_BACKOFF_START_MS;

  // Double-click guard: track last checkbox click time
  let lastMasterCheckboxClickTime = 0;
  const DOUBLE_CLICK_GUARD_MS = 500;

  const sanitizeConfig = (config) => {
    if (!config || typeof config !== "object") {
      config = {};
    }
    
    const validIntensities = ["light", "normal", "deep"];
    const validAgePattern = /^\d+[dwmy]$/i;

    return {
      intensity: validIntensities.includes(config.intensity)
        ? config.intensity
        : "normal",
      dryRun: Boolean(config.dryRun),
      safeMode: Boolean(config.safeMode),
      tagBeforeDelete: config.tagBeforeDelete !== false,
      tagLabelPrefix: typeof config.tagLabelPrefix === "string" && config.tagLabelPrefix.trim()
        ? config.tagLabelPrefix.trim()
        : "GmailCleaner",
      guardSkipStarred: config.guardSkipStarred !== false,
      guardSkipImportant: config.guardSkipImportant !== false,
      // v3.4: safety default ON
      guardSkipUnread: config.guardSkipUnread !== false,
      // v3.3: safety default ON
      guardSkipUserLabels: config.guardSkipUserLabels !== false,
      minAge: typeof config.minAge === "string" && validAgePattern.test(config.minAge)
        ? config.minAge
        : null,
      archiveInsteadOfDelete: Boolean(config.archiveInsteadOfDelete),
      debugMode: Boolean(config.debugMode),
      reviewMode: Boolean(config.reviewMode),
      whitelist: Array.isArray(config.whitelist)
        ? config.whitelist.filter((s) => {
            if (typeof s !== "string") return false;
            const trimmed = s.trim();
            if (!trimmed) return false;
            // Reject entries with spaces or search operators that could break queries
            if (/\s|OR|AND|{|}|\(|\)/i.test(trimmed)) return false;
            return true;
          })
        : []
    };
  };

  const CONFIG = sanitizeConfig(window.GMAIL_CLEANER_CONFIG || {});

  const debugLog = (message, data = {}) => {
    if (!CONFIG.debugMode) return;
    try {
      console.log(
        `[GmailCleaner ${new Date().toISOString()}]`,
        message,
        Object.keys(data).length > 0 ? data : ""
      );
    } catch {
      // Ignore logging failures.
    }
  };

  // =========================
  // Language tokens for i18n
  // =========================

  const DELETE_LABEL_TOKENS = Object.freeze([
    "Delete", "Trash", "Bin", "Move to trash",
    "Eliminar", "Papelera", "Supprimer", "Corbeille",
    "Löschen", "Papierkorb", "Excluir", "Lixeira",
    "Elimina", "Cestino", "Verwijderen", "Prullenbak",
    "Ta bort", "Slet", "Slett", "Usuń", "Kosz",
    "Sil", "Удалить", "حذف", "削除", "삭제", "删除"
  ]);

  const ARCHIVE_LABEL_TOKENS = Object.freeze([
    "Archive", "Archived", "Archiver", "Archivar",
    "Archivé", "Archivieren", "Arquivar", "Archivia", "Archivio"
  ]);

  const LABEL_BUTTON_TOKENS = Object.freeze([
    "Labels", "Label", "Label as", "Libellés",
    "Etiquetas", "Etiquette", "Etichette", "Märken"
  ]);

  const SELECT_ALL_TOKENS = Object.freeze([
    "Select all", "Seleccionar todo", "Tout sélectionner",
    "Alle auswählen", "Selecionar tudo", "Seleziona tutto",
    "Alles selecteren", "Välj alla", "Vælg alle",
    "Velg alle", "Zaznacz wszystko", "Tümünü seç",
    "Выбрать все", "تحديد الكل", "すべて選択", "모두 선택", "全选"
  ]);

  // Extended patterns for "Select all conversations that match this search"
  const SELECT_ALL_CONVERSATIONS_PATTERNS = Object.freeze([
    /select\s+all\s+.*conversations/i,
    /select\s+all\s+.*that\s+match/i,
    /select\s+all\s+.*matching/i,
    /all\s+\d+\s+conversations/i,
    /seleccionar\s+todas?\s+las?\s+conversacion/i,
    /tout\s+sélectionner/i,
    /alle\s+.*\s+auswählen/i,
    /selecionar\s+todas?\s+as?\s+conversa/i
  ]);

  const CONFIRM_TOKENS = Object.freeze([
    "OK", "Confirm", "Yes", "Continue",
    "Aceptar", "Sí", "Confirmer", "Oui",
    "Bestätigen", "Ja", "Confirmar", "Sim",
    "Conferma", "Bevestigen", "Bekräfta",
    "Bekræft", "Bekreft", "Potwierdź", "Tak",
    "Onayla", "Evet", "Подтвердить", "Да",
    "موافق", "確認", "확인", "确认"
  ]);

  // v3.3: throttling / temporary error tokens
  const RATE_LIMIT_TOKENS = Object.freeze([
    "too many requests",
    "try again later",
    "temporary problem",
    "please wait",
    "we're sorry",
    "were sorry",
    "something went wrong",
    "action could not be completed",
    "server error"
  ]);

  const isGmailTab = () => {
    try {
      return location.host === "mail.google.com";
    } catch {
      return false;
    }
  };

  const getGmailUserIndex = () => {
    try {
      const match = location.pathname.match(/\/mail\/u\/(\d+)\//);
      return match?.[1] ?? "0";
    } catch {
      return "0";
    }
  };

  const getGmailBaseUrl = () => {
    const userIdx = getGmailUserIndex();
    return `${location.origin}/mail/u/${userIdx}/`;
  };

  // v3.3: backoff helpers
  function findRateLimitText() {
    try {
      const nodes = qsa("div, span");
      for (const n of nodes) {
        const t = getTextContent(n);
        if (!t) continue;
        const lower = t.toLowerCase();
        for (const tok of RATE_LIMIT_TOKENS) {
          if (lower.includes(tok)) {
            return t.slice(0, 160);
          }
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  async function backoff(reason = "throttle") {
    const toast = findRateLimitText();
    const msg = toast ? `${reason}: ${toast}` : reason;

    safeSend({
      phase: "debug",
      detail: `Backoff ${dynamicBackoffMs}ms (${msg})`
    });

    await cancellableSleep(dynamicBackoffMs, () => CANCELLED);

    dynamicBackoffMs = Math.min(
      TIMING.RATE_LIMIT_BACKOFF_MAX_MS,
      Math.ceil(dynamicBackoffMs * TIMING.RATE_LIMIT_BACKOFF_MULTIPLIER)
    );
  }

  function deescalateBackoff() {
    dynamicBackoffMs = Math.max(
      TIMING.RATE_LIMIT_BACKOFF_START_MS,
      Math.floor(dynamicBackoffMs * TIMING.RATE_LIMIT_BACKOFF_DEESCALATE)
    );
  }

  // =========================
  // Messaging from popup/progress UI
  // =========================

  if (hasChromeRuntime() && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg?.type) return;

      switch (msg.type) {
        case "gmailCleanerCancel":
          CANCELLED = true;
          REVIEW_SIGNAL = "cancel";
          debugLog("Received cancel message");
          sendResponse({ ok: true });
          break;

        case "gmailCleanerPing":
          sendResponse({
            ok: true,
            phase: RUNNING ? "running" : "idle",
            version: GCC_CONTENT_VERSION
          });
          break;

        case "gmailCleanerStart":
          debugLog("Received start message");
          startMain();
          sendResponse({ ok: true });
          break;

        case "gmailCleanerResume":
          REVIEW_SIGNAL = "resume";
          sendResponse({ ok: true });
          break;

        case "gmailCleanerSkip":
          REVIEW_SIGNAL = "skip";
          sendResponse({ ok: true });
          break;

        default:
          break;
      }
    });
  }

  // =========================
  // DOM selectors & helpers
  // =========================

  const SELECTORS = Object.freeze({
    main: "div[role='main']",
    grid: "table[role='grid']",
    listContainer: "div[gh='tl']",
    toolbar: ["div[gh='mtb']", "div[role='toolbar']"],
    // Toolbar-specific checkbox selectors (avoid row checkboxes)
    toolbarCheckbox: [
      "div[gh='mtb'] div[role='checkbox']",
      "div[gh='mtb'] span[role='checkbox']",
      "div[role='toolbar'] div[role='checkbox']",
      "div[aria-label='Select'] div[role='checkbox']",
      "div[aria-label^='Select'] div[role='checkbox']"
    ],
    // Row containers to avoid
    rowContainers: [
      "tr[role='row']",
      "tr",
      "tbody tr",
      "table[role='grid'] tr"
    ],
    labelInputs: [
      "div[role='dialog'] input[aria-label*='Label as']",
      "div[role='dialog'] input[aria-label*='Apply one or more labels']",
      "div[role='dialog'] input[type='text']"
    ],
    noResultsIndicators: [
      "No messages matched your search",
      "Your search did not match any conversations"
    ],
    selectAllBanner: [
      "span[role='link']",
      "span.bqY a",
      "div.ya span[role='link']",
      "div.aeH span[role='link']"
    ],
    bulkConfirmDialog: [
      "div[role='alertdialog']",
      "div[role='dialog'][data-is-confirm]",
      "div.Kj-JD"
    ],
    selectionInfoBar: [
      "div.aeH",
      "div[gh='tl'] > div.aeH",
      "div.ya"
    ]
  });

  const getMainRoot = () => qs(SELECTORS.main) || document;

  const findToolbarRoot = () => qsFirst(SELECTORS.toolbar);

  // =========================
  // Generic DOM wait helper
  // =========================

  async function waitFor(
    fn,
    {
      timeout = TIMING.WAIT_DEFAULT_TIMEOUT,
      interval = TIMING.WAIT_DEFAULT_INTERVAL,
      description = "condition"
    } = {}
  ) {
    const start = Date.now();
    let lastError = null;

    while (Date.now() - start < timeout) {
      if (CANCELLED) {
        throw new CancellationError(`Cancelled while waiting for ${description}`);
      }

      try {
        const value = await fn();
        if (value) return value;
      } catch (e) {
        lastError = e;
      }

      await sleep(interval);
    }

    debugLog(`waitFor timed out: ${description}`, {
      timeout,
      lastError: lastError?.message
    });

    return null;
  }

  async function waitForElement(selectors, { timeout = TIMING.WAIT_DEFAULT_TIMEOUT, root = document } = {}) {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];
    return waitFor(
      () => qsFirst(selectorList, root),
      { timeout, description: `element matching ${selectorList.join(" | ")}` }
    );
  }

  // =========================
  // Master Checkbox Detection (FIXED)
  // =========================

  /**
   * Check if an element is inside a message row (to avoid row checkboxes).
   * @param {Element} el
   * @returns {boolean}
   */
  function isInsideMessageRow(el) {
    // Check if element is inside any row container
    for (const selector of SELECTORS.rowContainers) {
      if (el.closest(selector)) {
        // But make sure it's not in the header row
        const row = el.closest(selector);
        // Header rows typically don't have data attributes or are first in their container
        if (row && row.querySelector("td[role='gridcell']")) {
          return true; // It's a data row, not header
        }
      }
    }
    return false;
  }

  /**
   * Check if an element is in the toolbar area.
   * @param {Element} el
   * @returns {boolean}
   */
  function isInToolbarArea(el) {
    return !!(
      el.closest("div[gh='mtb']") ||
      el.closest("div[role='toolbar']") ||
      el.closest("div[aria-label='Select']") ||
      el.closest("div[aria-label^='Select']")
    );
  }

  /**
   * Score a checkbox candidate - higher score = more likely to be master checkbox.
   * @param {Element} el
   * @returns {{score: number, reasons: string[]}}
   */
  function scoreCheckboxCandidate(el) {
    let score = 0;
    const reasons = [];

    // Strong positive: in toolbar area
    if (isInToolbarArea(el)) {
      score += 10;
      reasons.push("in-toolbar");
    }

    // Strong negative: inside a message row
    if (isInsideMessageRow(el)) {
      score -= 20;
      reasons.push("in-message-row");
    }

    // Positive: has "Select" in aria-label
    const label = getElementLabel(el).toLowerCase();
    if (label.includes("select")) {
      score += 5;
      reasons.push("has-select-label");
    }

    // Positive: parent has "Select" label
    const parent = el.parentElement;
    if (parent) {
      const parentLabel = getElementLabel(parent).toLowerCase();
      if (parentLabel.includes("select")) {
        score += 3;
        reasons.push("parent-has-select-label");
      }
    }

    // Positive: near the top of the page (toolbar is usually at top)
    try {
      const rect = el.getBoundingClientRect();
      if (rect && rect.top < UI_THRESHOLDS.TOOLBAR_TOP_POSITION) {
        score += 2;
        reasons.push("near-top");
      }
    } catch {
      // getBoundingClientRect can fail in some edge cases
    }

    // Positive: has a dropdown sibling (the "Select" dropdown arrow)
    if (parent) {
      const hasDropdownSibling = parent.querySelector("div[aria-haspopup='true'], div[aria-expanded]");
      if (hasDropdownSibling) {
        score += 4;
        reasons.push("has-dropdown-sibling");
      }
    }

    // Negative: inside a table grid body
    if (el.closest("tbody")) {
      score -= 10;
      reasons.push("inside-tbody");
    }

    return { score, reasons };
  }

  /**
   * Find the best master checkbox candidate.
   * @returns {{element: Element | null, score: number, allCandidates: Array}}
   */
  function findMasterCheckbox() {
    // First, try toolbar-specific selectors
    const toolbarCheckboxes = [];
    for (const selector of SELECTORS.toolbarCheckbox) {
      toolbarCheckboxes.push(...qsa(selector));
    }

    // Also get all checkboxes as fallback
    const allCheckboxes = qsa("div[role='checkbox'], span[role='checkbox']");

    // Combine and deduplicate
    const allCandidates = [...new Set([...toolbarCheckboxes, ...allCheckboxes])];

    debugLog("Master checkbox candidates found", {
      toolbarCount: toolbarCheckboxes.length,
      totalCount: allCandidates.length
    });

    // Score each candidate
    const scored = allCandidates.map(el => {
      const { score, reasons } = scoreCheckboxCandidate(el);
      const ariaChecked = getAttr(el, "aria-checked");
      const label = getElementLabel(el);
      return { el, score, reasons, ariaChecked, label };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Log all candidates for debugging
    if (CONFIG.debugMode) {
      debugLog("Checkbox candidates scored", {
        candidates: scored.slice(0, 5).map(c => ({
          score: c.score,
          reasons: c.reasons,
          ariaChecked: c.ariaChecked,
          label: c.label.substring(0, 50)
        }))
      });
    }

    const best = scored.length > 0 ? scored[0] : null;

    if (best && best.score < 0) {
      debugLog("Warning: best checkbox has negative score, might be wrong element", {
        score: best.score,
        reasons: best.reasons
      });
    }

    safeSend({
      phase: "debug",
      detail: `Found ${allCandidates.length} checkbox candidates, best score: ${best?.score ?? "none"}`
    });

    return {
      element: best?.el ?? null,
      score: best?.score ?? 0,
      allCandidates: scored
    };
  }

  /**
   * Get the current checked state of a checkbox element.
   * @param {Element} el
   * @returns {"true" | "false" | "mixed" | "unknown"}
   */
  function getCheckboxState(el) {
    if (!el) return "unknown";
    
    const ariaChecked = getAttr(el, "aria-checked");
    if (ariaChecked === "true" || ariaChecked === "false" || ariaChecked === "mixed") {
      return ariaChecked;
    }
    // Try checking for visual state via classes
    const classList = el.className || "";
    if (typeof classList === "string" && (classList.includes("checked") || classList.includes("selected"))) {
      return "true";
    }
    return "unknown";
  }

  /**
   * Click the master checkbox with proper validation (FIXED).
   * @returns {Promise<{success: boolean, reason: string}>}
   */
  async function clickMasterCheckbox() {
    // Double-click guard
    const now = Date.now();
    if (now - lastMasterCheckboxClickTime < DOUBLE_CLICK_GUARD_MS) {
      debugLog("Double-click guard triggered, skipping click");
      return { success: false, reason: "double-click-guard" };
    }

    const { element: checkbox, score } = findMasterCheckbox();

    if (!checkbox) {
      debugLog("No master checkbox found");
      safeSend({ phase: "debug", detail: "Master checkbox not found" });
      return { success: false, reason: "not-found" };
    }

    // Check current state
    const stateBefore = getCheckboxState(checkbox);
    debugLog("Master checkbox state before click", {
      state: stateBefore,
      score,
      label: getElementLabel(checkbox)
    });

    // If already checked, we might not need to click (but for "select all" flow, we usually do)
    // For safety, we'll click anyway but log it
    if (stateBefore === "true") {
      debugLog("Checkbox already checked, clicking anyway to trigger banner");
    }

    try {
      lastMasterCheckboxClickTime = now;
      checkbox.click();

      await sleep(TIMING.CHECKBOX_SETTLE_DELAY);

      // Verify the click had an effect
      const stateAfter = getCheckboxState(checkbox);
      const selectedCountAfter = extractSelectedCount();

      debugLog("Master checkbox clicked", {
        scorePicked: score,
        stateBefore,
        stateAfter,
        selectedCount: selectedCountAfter,
        label: getElementLabel(checkbox)
      });

      safeSend({
        phase: "debug",
        detail: `Master checkbox clicked (score: ${score}, state: ${stateBefore} → ${stateAfter}, selected: ${selectedCountAfter ?? "unknown"})`
      });

      // Consider it a success if state changed OR if we now have selections
      const stateChanged = stateBefore !== stateAfter;
      const hasSelections = selectedCountAfter !== null && selectedCountAfter > 0;

      if (stateChanged || hasSelections) {
        return { success: true, reason: "clicked" };
      } else {
        debugLog("Warning: checkbox click may not have worked", { stateBefore, stateAfter });
        return { success: true, reason: "clicked-unverified" };
      }
    } catch (e) {
      debugLog("Failed to click master checkbox", { error: e?.message });
      return { success: false, reason: "click-error" };
    }
  }

  // =========================
  // Button finder utilities
  // =========================

  function findButtonByTokens(tokens, primaryPattern, root = findToolbarRoot() || document) {
    const buttons = qsa("div[role='button'], button", root);

    const scored = [];

    for (const el of buttons) {
      const label = getElementLabel(el).toLowerCase();
      let score = 0;

      for (const token of tokens) {
        if (label.includes(token.toLowerCase())) {
          score += 2;
        }
      }

      if (primaryPattern.test(label)) {
        score += 3;
      }

      const child = el.querySelector("[aria-label],[data-tooltip],[title]");
      if (child) {
        const childLabel = getElementLabel(child).toLowerCase();
        if (primaryPattern.test(childLabel)) {
          score += 1;
        }
      }

      if (score > 0) {
        scored.push({ el, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.length > 0 ? /** @type {HTMLElement} */ (scored[0].el) : null;
  }

  const findDeleteButton = () =>
    findButtonByTokens(DELETE_LABEL_TOKENS, /delete|trash|bin/i);

  const findArchiveButton = () =>
    findButtonByTokens(ARCHIVE_LABEL_TOKENS, /archive/i);

  const findLabelButton = () =>
    findButtonByTokens(LABEL_BUTTON_TOKENS, /label/i);

  // =========================
  // True Bulk Delete Helpers (FIXED)
  // =========================

  /**
   * Find the "Select all conversations that match this search" link.
   * @returns {Element | null}
   */
  function findSelectAllConversationsLink() {
    const mainRoot = getMainRoot();

    // Look in selection banner area first
    const bannerAreas = [];
    for (const selector of SELECTORS.selectionInfoBar) {
      bannerAreas.push(...qsa(selector, mainRoot));
    }

    // If we found banner areas, search within them first
    const searchRoots = bannerAreas.length > 0 ? [...bannerAreas, mainRoot] : [mainRoot];

    for (const root of searchRoots) {
      // Look for spans and links
      const candidates = qsa("span, a", root);

      for (const el of candidates) {
        const text = getTextContent(el);
        const lowerText = text.toLowerCase();

        // Check against patterns
        const matchesPattern = SELECT_ALL_CONVERSATIONS_PATTERNS.some(pattern =>
          pattern.test(text)
        );

        // Also check for simple "Select all" + "conversations" combo
        const hasSelectAll = SELECT_ALL_TOKENS.some(token =>
          lowerText.includes(token.toLowerCase())
        );
        const hasConversations = /conversation|message|correo|nachricht|messag/i.test(lowerText);

        if (matchesPattern || (hasSelectAll && hasConversations)) {
          // Verify it's actually clickable
          const role = getAttr(el, "role");
          const isLink = role === "link" || el.tagName === "A";
          const hasClickHandler = el.onclick !== null;
          const cursorPointer = window.getComputedStyle(el).cursor === "pointer";
          const inAnchor = el.closest("a") !== null;

          if (isLink || hasClickHandler || cursorPointer || inAnchor || hasSelectAll) {
            debugLog("Found select all conversations link", {
              text: text.substring(0, 100),
              role,
              isLink,
              cursorPointer
            });
            return el;
          }
        }
      }
    }

    // Fallback: look for any link with role="link" in banner selectors
    for (const selector of SELECTORS.selectAllBanner) {
      const links = qsa(selector, mainRoot);
      for (const link of links) {
        const text = getTextContent(link);
        if (/select|conversation|all/i.test(text)) {
          debugLog("Found fallback select all link", { text: text.substring(0, 100) });
          return link;
        }
      }
    }

    return null;
  }

  /**
   * Click the "Select all conversations" link and verify it worked.
   * @returns {Promise<{success: boolean, reason: string, countBefore: number | null, countAfter: number | null}>}
   */
  async function clickSelectAllConversations() {
    // Wait for Gmail to render the banner after checkbox click
    await sleep(TIMING.CHECKBOX_SETTLE_DELAY);

    const countBefore = extractSelectedCount();
    debugLog("Before select all conversations", { countBefore });

    const link = findSelectAllConversationsLink();

    if (!link) {
      debugLog("No 'Select all conversations' link found");
      safeSend({ phase: "debug", detail: "Select all conversations link not found" });
      return { success: false, reason: "link-not-found", countBefore, countAfter: null };
    }

    const linkText = getTextContent(link);
    debugLog("Clicking select all conversations link", { text: linkText.substring(0, 100) });
    safeSend({ phase: "debug", detail: `Clicking: "${linkText.substring(0, 60)}"` });

    try {
      // Try clicking the element itself
      link.click();

      await sleep(TIMING.SELECT_ALL_SETTLE_DELAY);

      // Verify selection increased
      const countAfter = extractSelectedCount();
      debugLog("After select all conversations click", { countBefore, countAfter });

      // Check if we see "All conversations selected" or similar indicator
      const allSelectedIndicator = findAllConversationsSelectedIndicator();

      if (countAfter !== null && countBefore !== null && countAfter > countBefore) {
        safeSend({
          phase: "debug",
          detail: `Bulk selection successful: ${countBefore} → ${countAfter}`
        });
        return { success: true, reason: "count-increased", countBefore, countAfter };
      }

      if (allSelectedIndicator) {
        safeSend({
          phase: "debug",
          detail: "Bulk selection verified via 'all selected' indicator"
        });
        return { success: true, reason: "all-selected-indicator", countBefore, countAfter };
      }

      // Even if we can't verify, consider it attempted
      debugLog("Select all clicked but could not verify effect");
      return { success: true, reason: "clicked-unverified", countBefore, countAfter };

    } catch (e) {
      debugLog("Failed to click select all link", { error: e?.message });
      return { success: false, reason: "click-error", countBefore, countAfter: null };
    }
  }

  /**
   * Look for an indicator that all conversations are selected.
   * @returns {boolean}
   */
  function findAllConversationsSelectedIndicator() {
    const mainRoot = getMainRoot();
    const spans = qsa("span", mainRoot);

    for (const span of spans) {
      const text = getTextContent(span).toLowerCase();
      if (
        (text.includes("all") && text.includes("selected")) ||
        text.includes("clear selection") ||
        /all\s+\d+\s+conversations?\s+(are\s+)?selected/i.test(text)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Handle the bulk action confirmation dialog.
   * @returns {Promise<boolean>}
   */
  async function handleBulkConfirmation() {
    const dialog = await waitFor(
      () => {
        const dialogs = qsa("div[role='alertdialog'], div[role='dialog']");
        for (const d of dialogs) {
          const text = getTextContent(d).toLowerCase();
          if (
            text.includes("confirm") ||
            text.includes("are you sure") ||
            text.includes("bulk") ||
            text.includes("this action") ||
            text.includes("conversations will be") ||
            text.includes("affect all")
          ) {
            return d;
          }
        }
        return null;
      },
      {
        timeout: TIMING.BULK_CONFIRM_TIMEOUT,
        interval: 100,
        description: "bulk confirmation dialog"
      }
    );

    if (!dialog) {
      debugLog("No bulk confirmation dialog appeared");
      return false;
    }

    debugLog("Bulk confirmation dialog detected", {
      text: getTextContent(dialog).substring(0, 200)
    });

    safeSend({ phase: "debug", detail: "Handling bulk confirmation dialog" });

    const buttons = qsa("button, div[role='button']", dialog);

    for (const btn of buttons) {
      const text = getTextContent(btn);
      const lowerText = text.toLowerCase();
      const name = getAttr(btn, "name").toLowerCase();

      const isConfirmButton = CONFIRM_TOKENS.some(token =>
        lowerText === token.toLowerCase() ||
        name === token.toLowerCase()
      );

      if (isConfirmButton) {
        try {
          btn.click();
          await sleep(TIMING.DOM_SETTLE_DELAY);
          debugLog("Clicked OK on bulk confirmation dialog", { buttonText: text });
          safeSend({ phase: "debug", detail: "Confirmed bulk action dialog" });
          return true;
        } catch (e) {
          debugLog("Failed to click confirmation button", { error: e?.message });
        }
      }
    }

    const primaryBtn = qs("button[name='ok'], button.J-at1-auR", dialog);
    if (primaryBtn) {
      try {
        primaryBtn.click();
        await sleep(TIMING.DOM_SETTLE_DELAY);
        debugLog("Clicked fallback primary button on dialog");
        return true;
      } catch (e) {
        debugLog("Failed to click fallback button", { error: e?.message });
      }
    }

    debugLog("Could not find confirmation button in dialog");
    return false;
  }

  /**
   * Wait for Gmail to process an action (list refresh, spinner, etc.).
   * @returns {Promise<boolean>}
   */
  async function waitForActionProcessing() {
    const startSelectedCount = extractSelectedCount();

    const processed = await waitFor(
      () => {
        const currentCount = extractSelectedCount();

        if (currentCount === null || currentCount === 0) {
          return true;
        }

        if (startSelectedCount !== null && currentCount < startSelectedCount * 0.5) {
          return true;
        }

        if (hasNoResults()) {
          return true;
        }

        return false;
      },
      {
        timeout: TIMING.LIST_REFRESH_TIMEOUT,
        interval: 200,
        description: "action processing"
      }
    );

    debugLog("Action processing wait result", {
      processed: !!processed,
      startCount: startSelectedCount,
      endCount: extractSelectedCount()
    });

    return !!processed;
  }

  // =========================
  // Rules: build query list
  // =========================

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

  async function getRules(intensity) {
    const riskyCategories = ["category:updates", "category:forums"];

    const stripRisky = (rules) => {
      if (!CONFIG.safeMode) return rules;
      return rules.filter((q) =>
        !riskyCategories.some((cat) => q.includes(cat))
      );
    };

    try {
      if (hasChromeStorage("sync")) {
        const result = await new Promise((resolve) => {
          chrome.storage.sync.get("rules", resolve);
        });

        const allRules = result?.rules ?? DEFAULT_RULES;
        const set = allRules[intensity] ?? allRules.normal ?? DEFAULT_RULES.normal;

        // Also load custom rules
        try {
          const customResult = await new Promise((resolve) => {
            chrome.storage.sync.get("customRules", resolve);
          });
          const customRules = customResult?.customRules || [];
          if (customRules.length > 0) {
            for (const cr of customRules) {
              if (cr.query && typeof cr.query === "string") {
                set.push(cr.query.trim());
              }
            }
          }
        } catch (e) {
          debugLog("Failed to load custom rules", { error: e?.message });
        }

        return stripRisky([...set]);
      }
    } catch (e) {
      debugLog("Failed to load rules from storage", { error: e?.message });
    }

    const fallback = DEFAULT_RULES[intensity] ?? DEFAULT_RULES.normal;
    return stripRisky([...fallback]);
  }

  const QUERY_LABEL_MAP = Object.freeze([
    [/larger:/, "Big attachments"],
    [/category:promotions/, "Promotions"],
    [/category:social/, "Social"],
    [/category:updates/, "Updates"],
    [/category:forums/, "Forums"],
    [/newsletter|unsubscribe/, "Newsletters"],
    [/no-reply|donotreply|do-not-reply/, "No-reply"]
  ]);

  function labelQuery(query) {
    if (!query) return "Other";
    const lowerQuery = query.toLowerCase();

    for (const [pattern, label] of QUERY_LABEL_MAP) {
      if (pattern.test(lowerQuery)) {
        return label;
      }
    }

    return "Other";
  }

  function applyGlobalGuards(raw) {
    const parts = [(raw || "").trim()];
    if (!parts[0]) return "";

    // v3.4: Safe Mode subject protection (always on when safeMode is enabled)
    if (CONFIG.safeMode && !/-subject:\(/i.test(parts[0])) {
      parts.push(SAFE_MODE_SUBJECT_GUARD);
    }

    if (CONFIG.guardSkipStarred && !/is:starred/i.test(parts[0])) {
      parts.push("-is:starred");
    }

    if (CONFIG.guardSkipImportant && !/is:important/i.test(parts[0])) {
      parts.push("-is:important");
    }

    if (CONFIG.guardSkipUnread && !/is:unread/i.test(parts[0])) {
      parts.push("-is:unread");
    }

    // v3.3 safety: never touch anything the user labeled
    // Gmail search token: has:userlabels (user-applied labels). We exclude it.
    if (CONFIG.guardSkipUserLabels && !/has:userlabels/i.test(parts[0])) {
      parts.push("-has:userlabels");
    }

    if (CONFIG.minAge && !/older_than:\d+[dwmy]/i.test(parts[0])) {
      parts.push(`older_than:${CONFIG.minAge}`);
    }

    for (const sender of CONFIG.whitelist) {
      const trimmed = sender.trim();
      if (trimmed) {
        // Sanitize: reject entries containing Gmail search operators that could
        // break query intent (e.g. "user@test.com OR attacker@evil.com")
        if (/\s|OR|AND|{|}|\(|\)/i.test(trimmed)) {
          debugLog("Skipping suspicious whitelist entry", { entry: trimmed });
          continue;
        }
        parts.push(`-from:${trimmed}`);
      }
    }

    return parts.join(" ").trim();
  }

  // =========================
  // MB / Size Helpers
  // =========================

  function estimateMbPerEmail(query) {
    if (!query) return 0.05;
    const lower = query.toLowerCase();

    const sizeMatch = lower.match(/larger:(\d+)(m|k|b)?/);
    if (sizeMatch) {
      let val = parseFloat(sizeMatch[1]);
      const unit = (sizeMatch[2] || "b");

      if (unit === "k") val = val / 1024;
      else if (unit === "b") val = val / (1024 * 1024);

      return val;
    }

    if (lower.includes("has:attachment") || lower.includes("filename:")) {
      return 2.0;
    }

    return 0.05;
  }

  // =========================
  // Navigation & actions
  // =========================

  async function openSearch(query) {
    const base = getGmailBaseUrl();
    const hash = `#search/${encodeURIComponent(query)}`;

    if (!location.href.startsWith(base)) {
      location.href = base + hash;
    } else {
      location.hash = hash;
    }

    const ok = await waitFor(
      () => {
        const main = qs(SELECTORS.main);
        return main && (qs(SELECTORS.grid, main) || qs(SELECTORS.listContainer, main));
      },
      {
        timeout: TIMING.WAIT_SEARCH_TIMEOUT,
        description: "Gmail search results"
      }
    );

    if (!ok) {
      throw new TimeoutError(
        "Timed out waiting for Gmail search results. Gmail might still be loading or the layout changed."
      );
    }

    await sleep(TIMING.DOM_SETTLE_DELAY);
  }

  function dispatchKeyEvent(key, code, options = {}) {
    try {
      const event = new KeyboardEvent("keydown", {
        key,
        code,
        bubbles: true,
        cancelable: true,
        ...options
      });
      document.body.dispatchEvent(event);
      return true;
    } catch (e) {
      debugLog("Failed to dispatch key event", { key, error: e?.message });
      return false;
    }
  }

  async function tryDeleteAction() {
    const btn = findDeleteButton();
    if (btn) {
      try {
        btn.click();
        debugLog("Clicked delete button");
        return true;
      } catch (e) {
        debugLog("Failed to click delete button", { error: e?.message });
      }
    }

    if (dispatchKeyEvent("#", "Digit3", { shiftKey: true })) {
      await sleep(TIMING.KEYBOARD_ACTION_DELAY);
      return true;
    }

    if (dispatchKeyEvent("Delete", "Delete")) {
      await sleep(TIMING.KEYBOARD_ACTION_DELAY);
      return true;
    }

    return false;
  }

  async function tryArchiveAction() {
    const btn = findArchiveButton();
    if (btn) {
      try {
        btn.click();
        debugLog("Clicked archive button");
        return true;
      } catch (e) {
        debugLog("Failed to click archive button", { error: e?.message });
      }
    }

    if (dispatchKeyEvent("e", "KeyE")) {
      await sleep(TIMING.KEYBOARD_ACTION_DELAY);
      return true;
    }

    if (dispatchKeyEvent("y", "KeyY")) {
      await sleep(TIMING.KEYBOARD_ACTION_DELAY);
      return true;
    }

    return false;
  }

  async function applyTagLabel(labelName) {
    if (!labelName?.trim()) return false;

    const btn = findLabelButton();
    if (!btn) {
      safeSend({
        phase: "tag",
        status: "Label button not found; skipping tag.",
        detail: labelName
      });
      return false;
    }

    try {
      btn.click();
    } catch (e) {
      debugLog("Failed to click label button", { error: e?.message });
      return false;
    }

    const input = await waitForElement(SELECTORS.labelInputs, {
      timeout: TIMING.LABEL_DIALOG_TIMEOUT
    });

    if (!input || !(input instanceof HTMLInputElement)) {
      safeSend({
        phase: "tag",
        status: "Label input not found; skipping tag.",
        detail: labelName
      });
      return false;
    }

    try {
      input.focus();
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));

      input.value = labelName;
      input.dispatchEvent(new Event("input", { bubbles: true }));

      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true
      });
      input.dispatchEvent(enterEvent);

      await sleep(TIMING.LABEL_APPLY_DELAY);

      safeSend({
        phase: "tag",
        status: "Tagged selection before action.",
        detail: labelName
      });

      return true;
    } catch (e) {
      debugLog("Failed to apply tag label", { labelName, error: e?.message });
      return false;
    }
  }

  // =========================
  // Result detection helpers
  // =========================

  function hasNoResults() {
    const mainRoot = getMainRoot();

    const grid = qs(SELECTORS.grid, mainRoot);
    if (grid) {
      const rows = qsa("tr[role='row']", grid);
      if (rows.length === 0) return true;
    }

    const spans = qsa("span", mainRoot);
    return spans.some((el) => {
      const text = getTextContent(el);
      return SELECTORS.noResultsIndicators.some((indicator) =>
        text.includes(indicator)
      );
    });
  }

  function parseCountFromText(text) {
    if (!text || typeof text !== "string") return null;

    const ofMatch = text.match(/\bof\s+([\d,.\s]+)/i);
    if (ofMatch) {
      const n = parseInt(ofMatch[1].replace(/[,.\s]/g, ""), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }

    const aboutMatch = text.match(/\babout\s+([\d,.\s]+)\s+results/i);
    if (aboutMatch) {
      const n = parseInt(aboutMatch[1].replace(/[,.\s]/g, ""), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }

    return null;
  }

  function estimateTotalResults() {
    const mainRoot = getMainRoot();
    const nodes = qsa("span, div", mainRoot);

    for (const el of nodes) {
      const text = getTextContent(el);
      const count = parseCountFromText(text);
      if (count !== null) return count;
    }

    return null;
  }

  /**
   * Extract the "X selected" count from Gmail's selection banner.
   * @returns {number | null}
   */
  function extractSelectedCount() {
    const mainRoot = getMainRoot();
    const spans = qsa("span", mainRoot);

    for (const el of spans) {
      const text = getTextContent(el);
      if (!text) continue;

      // Match patterns like "50 selected", "All 1,234 conversations selected"
      if (/selected/i.test(text)) {
        const matches = text.match(/([\d,.\s]+)/g);
        if (matches && matches.length > 0) {
          // Get the largest number (likely the count, not page info)
          let maxCount = 0;
          for (const match of matches) {
            const cleaned = match.replace(/[,.\s]/g, "");
            if (cleaned) {
              const n = parseInt(cleaned, 10);
              if (Number.isFinite(n) && n > maxCount) {
                maxCount = n;
              }
            }
          }
          if (maxCount > 0) return maxCount;
        }
      }
    }

    return null;
  }

  // =========================
  // Page action routine (FIXED)
  // =========================

  async function actOnCurrentPageIfAny(tagLabel) {
    if (hasNoResults()) {
      debugLog("No results on current page");
      return { deleted: false, count: 0, reason: "No results" };
    }

    await waitFor(findToolbarRoot, {
      timeout: TIMING.WAIT_TOOLBAR_TIMEOUT,
      description: "toolbar"
    });

    const checkboxResult = await clickMasterCheckbox();
    if (!checkboxResult.success) {
      debugLog("Master checkbox click failed", { reason: checkboxResult.reason });
      safeSend({ phase: "debug", detail: `Checkbox click failed: ${checkboxResult.reason}` });
      return { deleted: false, count: 0, reason: `Checkbox: ${checkboxResult.reason}` };
    }

    await sleep(TIMING.CHECKBOX_SETTLE_DELAY);

    const initialSelectedCount = extractSelectedCount();
    debugLog("Initial selection count", { count: initialSelectedCount });
    safeSend({ phase: "debug", detail: `Initial selected: ${initialSelectedCount ?? "unknown"}` });

    let bulkSelected = false;
    const selectAllResult = await clickSelectAllConversations();

    if (selectAllResult.success) {
      bulkSelected = true;
      debugLog("Bulk selection result", selectAllResult);

      const finalCount = extractSelectedCount();
      safeSend({
        phase: "debug",
        detail: `Bulk selection: ${initialSelectedCount ?? "?"} → ${finalCount ?? "?"}`
      });
    }

    const selectedCount = extractSelectedCount() ?? initialSelectedCount;
    const actionWord = CONFIG.archiveInsteadOfDelete ? "archive" : "delete";

    // Run-level soft cap guardrail
    if (!CONFIG.dryRun) {
      const projectedTotal = liveRunProcessedSoFar + (selectedCount ?? 0);

      if (projectedTotal > GUARDRAILS.RUN_SOFT_CAP && !window.GCC_CONFIRMED_SOFT_CAP) {
        const confirmed = confirm(
          `Gmail Cleaner: this run is about to ${actionWord} about ${projectedTotal.toLocaleString()} conversations.\n\n` +
          "If your inbox is very large, you may want to start with a smaller rule set, Dry Run, or Safe Mode.\n\n" +
          "Continue anyway?"
        );

        if (!confirmed) {
          debugLog("User cancelled at soft cap confirmation", { projectedTotal });
          return { deleted: false, count: 0, reason: "user-soft-cap-cancelled" };
        }

        window.GCC_CONFIRMED_SOFT_CAP = true;
      }
    }

    // Tag before action
    if (!CONFIG.dryRun && tagLabel && CONFIG.tagBeforeDelete) {
      try {
        await applyTagLabel(tagLabel);
      } catch (e) {
        safeSend({
          phase: "tag",
          status: "Error while tagging; continuing without tag.",
          detail: String(e?.message || e)
        });
      }
    }

    // Dry-run
    if (CONFIG.dryRun) {
      const estimated = selectedCount ?? estimateTotalResults() ?? 0;
      debugLog("Dry run page estimate", { estimated, bulkSelected });
      return { deleted: false, count: estimated, reason: "dry-run", bulkSelected };
    }

    const estimatedTotal = selectedCount ?? estimateTotalResults();

    // Huge run confirmation
    if (
      !CONFIG.archiveInsteadOfDelete &&
      estimatedTotal &&
      estimatedTotal > GUARDRAILS.HUGE_RUN_CONFIRM_THRESHOLD &&
      !window.GCC_CONFIRMED_HUGE
    ) {
      const confirmed = confirm(
        `About to delete ~${estimatedTotal.toLocaleString()} conversations. Continue?`
      );

      if (!confirmed) {
        debugLog("User cancelled at huge-run confirmation", { estimatedTotal });
        return { deleted: false, count: 0, reason: "user-cancelled" };
      }

      window.GCC_CONFIRMED_HUGE = true;
    }

    const countBeforeAction = extractSelectedCount();
    safeSend({ phase: "debug", detail: `Executing ${actionWord} on ${countBeforeAction ?? "?"} items` });

    const actionSuccess = CONFIG.archiveInsteadOfDelete
      ? await tryArchiveAction()
      : await tryDeleteAction();

    if (!actionSuccess) {
      const reason = CONFIG.archiveInsteadOfDelete
        ? "No archive button"
        : "No delete button";
      debugLog("No action button found", { reason });
      safeSend({ phase: "debug", detail: `Action failed: ${reason}` });
      return { deleted: false, count: 0, reason };
    }

    // Handle bulk confirmation dialog
    if (bulkSelected) {
      const confirmedBulk = await handleBulkConfirmation();
      debugLog("Bulk confirmation result", { confirmedBulk });
    }

    // Wait for Gmail to process
    await sleep(TIMING.POST_ACTION_DELAY_MS);

    // Verify action completed
    const actionProcessed = await waitForActionProcessing();
    debugLog("Action processing completed", { processed: actionProcessed });

    // v3.3: if Gmail shows temporary issue, treat as retryable
    if (!actionProcessed) {
      const rl = findRateLimitText();
      if (rl) throw new RateLimitError(rl);
      throw new TimeoutError("Action processing timed out (Gmail did not refresh selection/results).");
    }

    const countAfterAction = extractSelectedCount();
    safeSend({
      phase: "debug",
      detail: `Action complete. Before: ${countBeforeAction ?? "?"}, After: ${countAfterAction ?? "cleared"}`
    });

    liveRunProcessedSoFar += selectedCount ?? 0;

    return { deleted: true, count: selectedCount ?? 0, bulkSelected };
  }

  // =========================
  // Stats & per-query processing
  // =========================

  const stats = {
    totalDeleted: 0,
    totalWouldDelete: 0,
    totalFreedMb: 0,
    perQuery: []
  };

  function resetStats() {
    stats.totalDeleted = 0;
    stats.totalWouldDelete = 0;
    stats.totalFreedMb = 0;
    stats.perQuery = [];
  }

  async function waitForReviewResponse() {
    REVIEW_SIGNAL = null;

    while (!REVIEW_SIGNAL && !CANCELLED) {
      await sleep(TIMING.REVIEW_POLL_INTERVAL);
    }

    return REVIEW_SIGNAL;
  }

  function recordQueryStats({ query, label, count, mode, durationMs }) {
    const queryStats = { query, label, count, mode, durationMs };
    stats.perQuery.push(queryStats);

    safeSend({
      phase: "query-done",
      ...queryStats
    });

    debugLog("Query completed", queryStats);
  }

  async function processQuery(query, idx, total) {
    const label = labelQuery(query);
    const tagLabel = !CONFIG.dryRun && CONFIG.tagBeforeDelete
      ? `${CONFIG.tagLabelPrefix} - ${label}`
      : null;
    const guardedQuery = applyGlobalGuards(query);
    const start = Date.now();
    let pass = 0;
    let queryDeletedCount = 0;
    let hasReviewedThisQuery = false;

    const mbPerEmail = estimateMbPerEmail(guardedQuery);

    debugLog("Processing query", {
      rawQuery: query,
      guardedQuery,
      index: idx + 1,
      total,
      dryRun: CONFIG.dryRun,
      mbPerEmail
    });

    safeSend({
      phase: "debug",
      detail: `Starting query ${idx + 1}/${total}: ${label}`
    });

    while (pass < TIMING.PASS_CAP) {
      if (CANCELLED) {
        throw new CancellationError("Query processing cancelled");
      }

      const percent = Math.round((idx / total) * 100);
      safeSend({
        phase: "query",
        status: `Cleaning ${label} (${idx + 1}/${total})`,
        detail: `Pass ${pass + 1}`,
        percent
      });

      // v3.3: per-pass retry loop (rate limit / timeouts)
      let retries = 0;

      while (true) {
        if (CANCELLED) throw new CancellationError("Query processing cancelled");

        try {
          await openSearch(guardedQuery);

          if (hasNoResults()) {
            const durationMs = Date.now() - start;
            const mode = CONFIG.dryRun ? "dry" : "live";

            safeSend({ detail: `No results for: ${guardedQuery}` });

            recordQueryStats({
              query,
              label,
              count: CONFIG.dryRun ? 0 : queryDeletedCount,
              mode,
              durationMs
            });

            deescalateBackoff();
            return;
          }

          // Review Mode (fixed: always record on skip)
          if (CONFIG.reviewMode && !hasReviewedThisQuery && !CONFIG.dryRun) {
            const estimated = estimateTotalResults() ?? "many";

            safeSend({
              phase: "review",
              status: "Paused for review",
              detail: `Found ~${estimated} items for "${label}". Waiting for input...`,
              queryLabel: label,
              queryCount: estimated
            });

            safeSendImmediate({
              type: "gmailCleanerRequestReview",
              label,
              query: guardedQuery,
              count: estimated
            });

            const signal = await waitForReviewResponse();

            if (signal === "skip") {
              debugLog("User skipped query via Review Mode", { label });
              recordQueryStats({
                query,
                label,
                count: queryDeletedCount,
                mode: "live",
                durationMs: Date.now() - start
              });
              deescalateBackoff();
              return;
            }

            if (signal === "cancel") {
              debugLog("User cancelled via Review Mode", { label });
              CANCELLED = true;
              throw new CancellationError("Run cancelled by user (review mode)");
            }

            hasReviewedThisQuery = true;
          }

          const result = await actOnCurrentPageIfAny(tagLabel);

          // success path: ease off throttling
          deescalateBackoff();

          if (CONFIG.dryRun) {
            const durationMs = Date.now() - start;
            const count = result.count || estimateTotalResults() || 0;

            stats.totalWouldDelete += count;

            safeSend({ detail: `Dry-Run: would affect ${count} for: ${guardedQuery}` });

            recordQueryStats({ query, label, count, mode: "dry", durationMs });
            return;
          }

          if (!result.deleted) {
            const durationMs = Date.now() - start;

            safeSend({ detail: `Nothing to act on for: ${guardedQuery} (${result.reason})` });

            recordQueryStats({
              query,
              label,
              count: queryDeletedCount,
              mode: "live",
              durationMs
            });
            return;
          }

          const affectedThisPass = result.count || 0;
          queryDeletedCount += affectedThisPass;
          stats.totalDeleted += affectedThisPass;
          stats.totalFreedMb += (affectedThisPass * mbPerEmail);
          pass++;

          // Record undo entry for recovery
          try {
            if (hasChromeRuntime() && result.deleted && result.count > 0) {
              chrome.runtime.sendMessage({
                type: "gmailCleanerRecordUndo",
                data: {
                  query: guardedQuery,
                  label,
                  count: result.count,
                  action: CONFIG.archiveInsteadOfDelete ? "archive" : "delete",
                  tagLabel: tagLabel || "",
                  intensity: CONFIG.intensity
                }
              });
            }
          } catch {}

          debugLog("Live pass completed", {
            query,
            pass,
            affectedThisPass,
            queryDeletedCount,
            totalDeleted: stats.totalDeleted,
            freedMbSoFar: stats.totalFreedMb,
            bulkSelected: result.bulkSelected
          });

          safeSend({
            phase: "debug",
            detail: `Pass ${pass} complete: ${affectedThisPass} affected, total: ${queryDeletedCount}`
          });

          // If bulk delete worked, likely exhausted in one pass
          if (result.bulkSelected && affectedThisPass > 50) {
            debugLog("Bulk delete completed - checking if more remain");
            await sleep(TIMING.BETWEEN_PASS_SLEEP_MS);

            await openSearch(guardedQuery);
            if (hasNoResults()) {
              const durationMs = Date.now() - start;
              recordQueryStats({
                query,
                label,
                count: queryDeletedCount,
                mode: "live",
                durationMs
              });
              return;
            }
          }

          await sleep(TIMING.BETWEEN_PASS_SLEEP_MS);

          if (hasNoResults()) {
            const durationMs = Date.now() - start;

            recordQueryStats({
              query,
              label,
              count: queryDeletedCount,
              mode: "live",
              durationMs
            });
            return;
          }

          break;

        } catch (e) {
          const isRL = e instanceof RateLimitError;
          const isTO = e instanceof TimeoutError;

          if ((isRL || isTO) && retries < TIMING.RATE_LIMIT_MAX_RETRIES_PER_PASS) {
            retries++;
            await backoff(isRL ? "rate-limited" : "timeout");
            continue;
          }

          throw e;
        }
      }
    }
  }

  // =========================
  // History & Stats Persistence
  // =========================

  async function saveRunHistory(doneStats) {
    if (!hasChromeStorage("local")) return;

    try {
      const result = await new Promise((resolve) => {
        chrome.storage.local.get("runHistory", resolve);
      });

      const history = Array.isArray(result?.runHistory) ? result.runHistory : [];
      history.unshift(doneStats);

      if (history.length > GUARDRAILS.MAX_HISTORY_ENTRIES) {
        history.length = GUARDRAILS.MAX_HISTORY_ENTRIES;
      }

      await new Promise((resolve) => {
        chrome.storage.local.set({ runHistory: history }, resolve);
      });

      debugLog("Saved run history", { historyLength: history.length });
    } catch (e) {
      debugLog("Failed to save history", { error: e?.message });
    }
  }

  async function updateProStats(doneStats) {
    if (!hasChromeStorage("sync")) return;

    try {
      const result = await new Promise((resolve) => {
        chrome.storage.sync.get(["proStatus", "proLifetimeStats"], resolve);
      });

      if (!result?.proStatus?.isPro) return;

      const prev = result.proLifetimeStats || {};
      const runCount = doneStats.mode === "dry"
        ? doneStats.totalWouldDelete || 0
        : doneStats.totalDeleted || 0;

      const next = {
        totalRuns: (prev.totalRuns || 0) + 1,
        totalDeleted: (prev.totalDeleted || 0) + (doneStats.totalDeleted || 0),
        totalWouldDelete: (prev.totalWouldDelete || 0) + (doneStats.totalWouldDelete || 0),
        totalQueries: (prev.totalQueries || 0) + (doneStats.totalQueries || 0),
        totalFreedMb: (prev.totalFreedMb || 0) + (doneStats.totalFreedMb || 0),
        biggestRun: Math.max(prev.biggestRun || 0, runCount)
      };

      await new Promise((resolve) => {
        chrome.storage.sync.set({ proLifetimeStats: next }, resolve);
      });

      debugLog("Updated Pro stats", next);
    } catch (e) {
      debugLog("Failed to update Pro stats", { error: e?.message });
    }
  }

  async function saveLastRunStats(doneStats) {
    if (!hasChromeStorage("sync")) return;

    try {
      await new Promise((resolve) => {
        chrome.storage.sync.set({ lastRunStats: doneStats }, resolve);
      });
    } catch (e) {
      debugLog("Failed to save last run stats", { error: e?.message });
    }
  }

  // =========================
  // Main driver
  // =========================

  function buildFinalStats(totalQueries) {
    const mode = CONFIG.dryRun ? "dry" : "live";
    const runCount = mode === "dry"
      ? stats.totalWouldDelete
      : stats.totalDeleted;

    let sizeBucket = "tiny";
    if (runCount >= 500 && runCount < 2500) sizeBucket = "small";
    else if (runCount >= 2500 && runCount < 10000) sizeBucket = "medium";
    else if (runCount >= 10000) sizeBucket = "huge";

    const baseUrl = getGmailBaseUrl();

    return {
      mode,
      totalDeleted: stats.totalDeleted,
      totalWouldDelete: stats.totalWouldDelete,
      totalFreedMb: stats.totalFreedMb,
      totalQueries,
      perQuery: [...stats.perQuery],
      runCount,
      sizeBucket,
      isHugeRun: runCount >= 5000,
      finishedAt: Date.now(),
      version: GCC_CONTENT_VERSION,
      links: {
        trash: `${baseUrl}#trash`,
        allMail: `${baseUrl}#all`
      }
    };
  }

  function buildHumanSummary(doneStats, totalQueries) {
    const { runCount, mode } = doneStats;

    if (runCount === 0) {
      return mode === "dry"
        ? "Dry run finished: nothing matched your rules. No conversations would be changed."
        : "Cleanup finished: nothing matched your rules. No conversations were deleted or archived.";
    }

    if (mode === "dry") {
      return `Dry run finished: would affect about ${runCount.toLocaleString()} conversations across ${totalQueries} queries.`;
    }

    if (CONFIG.archiveInsteadOfDelete) {
      return `Cleanup finished: ${stats.totalDeleted.toLocaleString()} conversations archived across ${totalQueries} queries.`;
    }

    const mbStr = stats.totalFreedMb < 1
      ? "<1"
      : Math.round(stats.totalFreedMb).toLocaleString();

    return `Deleted ${stats.totalDeleted.toLocaleString()} emails / freed ${mbStr} MB (all in Trash).`;
  }

  async function main() {
    if (RUNNING) {
      debugLog("Run already in progress, ignoring start request");
      return;
    }

    RUNNING = true;
    const runStartTime = Date.now();

    CANCELLED = false;
    REVIEW_SIGNAL = null;
    liveRunProcessedSoFar = 0;
    lastMasterCheckboxClickTime = 0;
    window.GCC_CONFIRMED_SOFT_CAP = false;
    window.GCC_CONFIRMED_HUGE = false;
    resetStats();

    // v3.3: reset throttling each run
    dynamicBackoffMs = TIMING.RATE_LIMIT_BACKOFF_START_MS;

    debugLog("Run starting", {
      intensity: CONFIG.intensity,
      dryRun: CONFIG.dryRun,
      archiveInsteadOfDelete: CONFIG.archiveInsteadOfDelete,
      reviewMode: CONFIG.reviewMode,
      safeMode: CONFIG.safeMode,
      guardSkipUnread: CONFIG.guardSkipUnread,
      guardSkipUserLabels: CONFIG.guardSkipUserLabels
    });

    try {
      if (!isGmailTab()) {
        alert("Gmail Cleaner: please run this from a Gmail tab.");
        return;
      }

      const rawRules = await getRules(CONFIG.intensity);
      const rules = rawRules.filter((q) => typeof q === "string" && q.trim());
      const totalQueries = rules.length;

      if (totalQueries === 0) {
        const emptyStats = buildFinalStats(0);

        safeSendImmediate({
          phase: "done",
          status: "No rules to run.",
          detail: "Rule set is empty.",
          percent: 100,
          done: true,
          stats: emptyStats
        });

        debugLog("Run aborted: no rules");
        return;
      }

      safeSend({
        phase: "starting",
        status: "Starting Gmail cleanup...",
        detail: [
          `Level: ${CONFIG.intensity}`,
          `${totalQueries} queries`,
          CONFIG.archiveInsteadOfDelete ? "Mode: Archive" : "Mode: Delete",
          CONFIG.minAge ? `Min age: ${CONFIG.minAge}` : null,
          CONFIG.reviewMode ? "Review mode enabled" : null,
          CONFIG.safeMode ? "Safe mode: protects receipts/shipping + skips updates/forums rules" : null,
          CONFIG.guardSkipUnread ? "Safety: skip unread" : null,
          CONFIG.guardSkipUserLabels ? "Safety: skip user-labeled mail" : null
        ].filter(Boolean).join(". ") + ".",
        percent: 0
      });

      for (let i = 0; i < rules.length; i++) {
        if (CANCELLED) {
          throw new CancellationError("Run cancelled by user");
        }
        await processQuery(rules[i], i, totalQueries);
      }

      const doneStats = buildFinalStats(totalQueries);
      const humanSummary = buildHumanSummary(doneStats, totalQueries);

      await Promise.allSettled([
        saveRunHistory(doneStats),
        updateProStats(doneStats),
        saveLastRunStats(doneStats)
      ]);

      // Record stats to background service worker
      try {
        if (hasChromeRuntime()) {
          chrome.runtime.sendMessage({
            type: "gmailCleanerRecordStats",
            data: {
              deleted: CONFIG.archiveInsteadOfDelete ? 0 : stats.totalDeleted,
              archived: CONFIG.archiveInsteadOfDelete ? stats.totalDeleted : 0,
              freedMb: stats.totalFreedMb,
              intensity: CONFIG.intensity,
              dryRun: CONFIG.dryRun,
              duration: Date.now() - runStartTime,
              perQuery: stats.perQuery
            }
          });
        }
      } catch (e) {
        debugLog("Failed to record stats", { error: e?.message });
      }

      safeSendImmediate({
        phase: "done",
        status: "Cleanup finished.",
        detail: humanSummary,
        percent: 100,
        done: true,
        stats: doneStats
      });

      debugLog("Run finished", {
        mode: doneStats.mode,
        runCount: doneStats.runCount,
        sizeBucket: doneStats.sizeBucket,
        freedMb: doneStats.totalFreedMb
      });

      if (!CONFIG.dryRun && stats.totalDeleted > 0) {
        const destination = CONFIG.archiveInsteadOfDelete ? "All Mail" : "Trash";

        alert(
          `${humanSummary}\n\n` +
          `Check ${destination} if you need to restore anything.`
        );
      }

    } catch (e) {
      const isCancellation = e instanceof CancellationError ||
        (e instanceof Error && e.message.includes("Cancelled"));

      if (isCancellation) {
        safeSendImmediate({
          phase: "cancelled",
          status: "Run cancelled.",
          detail: "Stopped by user.",
          done: true,
          percent: 100
        });

        debugLog("Run cancelled", {
          totalDeleted: stats.totalDeleted,
          totalWouldDelete: stats.totalWouldDelete
        });
      } else {
        const errorMessage = e instanceof Error ? e.message : String(e);

        logError(e, "main run");

        safeSendImmediate({
          phase: "error",
          status: "Error occurred.",
          detail: errorMessage,
          done: true,
          percent: 100
        });

        debugLog("Run errored", { message: errorMessage });
      }
    } finally {
      RUNNING = false;
    }
  }

  function startMain() {
    if (!RUNNING) {
      main().catch((e) => logError(e, "startMain"));
    }
  }

  if (typeof window !== "undefined" && window.GCC_TEST_MODE) {
    window.GCC_INTERNALS = {
      CONFIG,
      TIMING,
      GUARDRAILS,
      stats,
      labelQuery,
      applyGlobalGuards,
      parseCountFromText,
      sanitizeConfig,
      clickSelectAllConversations,
      handleBulkConfirmation,
      findMasterCheckbox,
      scoreCheckboxCandidate,
      extractSelectedCount
    };
  }

  startMain();
})();