(() => {
  "use strict";

  const GCC_CONTENT_VERSION = "6.0.0";

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
    MAX_HISTORY_ENTRIES: 10,
    // Large-batch warning threshold. When a single pass selects more
    // than this many threads we surface a warning and sample senders so
    // the user can review afterwards. This does NOT pause the run --
    // the soft cap / huge-run confirmations are the actual stop gates.
    LARGE_BATCH_WARN_THRESHOLD: 2000,
    // Wall-clock limit for Review Mode. If the progress tab is closed
    // without sending resume/skip, the engine would otherwise wait
    // forever; after this it treats the query as skipped so the run
    // can finish cleanly.
    REVIEW_RESPONSE_TIMEOUT_MS: 10 * 60 * 1000,
    // 5.0.1: hard wall-time cap per query. With 6 retries and 30s max
    // backoff plus ~20s timeouts, a single misbehaving query could pin
    // the run for >10 minutes. Abandon and move on after this much
    // wall clock so the rest of the rules still get to run.
    QUERY_WALL_TIME_BUDGET_MS: 5 * 60 * 1000
  });

  // 5.0 defense-in-depth: tokens we refuse to honour even if a user
  // wrote them into a custom rule by hand. Mirrors the popup-side
  // validator (GCC.DANGEROUS_QUERY_TOKENS in shared.js) so the engine
  // refuses to send unsafe queries to Gmail even if the validator was
  // bypassed somehow. Issue #8.
  const DANGEROUS_QUERY_TOKENS = [
    "is:starred",
    "is:important",
    "label:starred",
    "label:important",
    "label:imap_starred",
    "in:sent",
    "in:drafts",
    "in:chat",
    "in:scheduled"
  ];

  function queryHasDangerousToken(rawQuery) {
    const lower = String(rawQuery || "").toLowerCase();
    return DANGEROUS_QUERY_TOKENS.some((token) => {
      const negated = new RegExp(`(^|\\s)-\\s*${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      const positive = new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      return positive.test(lower) && !negated.test(lower);
    });
  }

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

  const hasChromeRuntime = () => {
    try {
      // Don't cache: chrome.runtime can become invalid after extension
      // update/reload. Accessing chrome.runtime.id throws if invalidated.
      return (
        typeof chrome !== "undefined" &&
        !!chrome.runtime?.id &&
        typeof chrome.runtime.sendMessage === "function"
      );
    } catch {
      return false;
    }
  };

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

  const _debouncedSend = debounce((msg) => {
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

  const safeSend = (msg) => {
    // Phase-changing and done messages must not be debounced away
    if (msg.phase && msg.phase !== "debug") {
      safeSendImmediate(msg);
    } else {
      _debouncedSend(msg);
    }
  };

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

  // Atomic-style guard: set flag immediately to prevent race between check and set
  if (window.GCC_ATTACHED) {
    safeSendImmediate({
      phase: "boot",
      status: "Already attached",
      detail: "Duplicate inject ignored.",
      percent: 0
    });
    return;
  }
  window.GCC_ATTACHED = Date.now(); // Truthy + timestamp for debugging

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
  // One-shot guard so selector-rot telemetry warns at most once per run.
  let SELECTOR_ROT_WARNED = false;

  // v3.3: dynamic backoff for throttling
  let dynamicBackoffMs = TIMING.RATE_LIMIT_BACKOFF_START_MS;

  // Double-click guard: track last checkbox click time
  let lastMasterCheckboxClickTime = 0;
  const DOUBLE_CLICK_GUARD_MS = 500;

  // Whitelist entry shapes accepted by the query builder. Keep in sync
  // with options.js isValidWhitelistEntry -- the options UI is the
  // authoritative validator, this is the defence-in-depth copy that
  // catches values written to storage by hand.
  const WHITELIST_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
  const WHITELIST_WILDCARD_EMAIL = /^\*@([a-z0-9.-]+\.[a-z]{2,})$/i;
  const WHITELIST_DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;
  const isValidWhitelistEntry = (s) => {
    if (typeof s !== "string") return false;
    const trimmed = s.trim();
    if (!trimmed) return false;
    if (/\s/.test(trimmed)) return false;
    return WHITELIST_EMAIL.test(trimmed)
      || WHITELIST_WILDCARD_EMAIL.test(trimmed)
      || WHITELIST_DOMAIN.test(trimmed);
  };

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
      // 5.0 additions: scheduled / runId propagate from the SW so the
      // engine knows it's unattended (issue #7) and can identify
      // itself in undo log entries (issue #6 race detection).
      scheduled: Boolean(config.scheduled),
      runId: typeof config.runId === "string" ? config.runId : "",
      scheduleId: typeof config.scheduleId === "string" ? config.scheduleId : "",
      whitelist: Array.isArray(config.whitelist)
        ? config.whitelist.map((s) => (typeof s === "string" ? s.trim() : ""))
            .filter((s) => isValidWhitelistEntry(s))
        : [],
      // 6.0: optional one-off focused rule set from a popup "target"
      // preset. When present and non-empty it replaces the stored rule
      // set for this run only. Entries are trimmed, capped, and refused
      // if they target protected mail -- same boundary as custom rules.
      rulesOverride: Array.isArray(config.rulesOverride)
        ? config.rulesOverride
            .map((s) => (typeof s === "string" ? s.trim() : ""))
            .filter((s) => s && !queryHasDangerousToken(s))
            .slice(0, 25)
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

  // Current Gmail hides "Label as" inside the toolbar overflow ("More
  // email options") menu. These tokens locate that overflow button so
  // tag-before-delete can reach the moved Labels control.
  const MORE_OPTIONS_TOKENS = Object.freeze([
    "More email options", "More options", "More",
    "Más opciones", "Más", "Plus d'options", "Plus",
    "Weitere Optionen", "Mehr", "Mais opções", "Mais",
    "Altre opzioni", "Altro", "Meer opties", "Meer",
    "Fler alternativ", "Flere", "Więcej opcji", "Więcej",
    "Diğer seçenekler", "Ещё", "المزيد", "その他", "더보기", "更多"
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
      // Only check known Gmail UI banner/notification areas, not email content
      const uiAreas = [
        ...qsa("div[role='alert']"),
        ...qsa("div[role='status']"),
        ...qsa("div.b8.UC"),
        ...qsa("div[aria-live='assertive']"),
        ...qsa("div[aria-live='polite']")
      ];
      // Fallback: if no specific areas found, check toolbar area only
      if (uiAreas.length === 0) {
        const toolbar = findToolbarRoot();
        if (toolbar) uiAreas.push(toolbar);
      }
      for (const area of uiAreas) {
        const nodes = [area, ...qsa("div, span", area)];
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
      }
    } catch {
      // ignore
    }
    return null;
  }

  async function backoff(reason = "throttle", errorMessage = "") {
    const toast = findRateLimitText();
    // 5.0.1: include the underlying error text so the log says exactly
    // what the engine was waiting for. "Backoff 3339ms (timeout)" is
    // useless; "Backoff 3339ms (timeout: Action processing timed out)"
    // is debuggable.
    const detail = toast || errorMessage;
    const msg = detail ? `${reason}: ${detail}` : reason;

    // Add 10-30% random jitter to prevent synchronized retries
    const jitter = dynamicBackoffMs * (0.1 + Math.random() * 0.2);
    const backoffWithJitter = Math.ceil(dynamicBackoffMs + jitter);

    safeSend({
      phase: "debug",
      detail: `Backoff ${backoffWithJitter}ms (${msg})`
    });

    await cancellableSleep(backoffWithJitter, () => CANCELLED);

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
          sendResponse({ ok: false, error: "Unknown message type" });
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
      "div[role='toolbar'] [role='checkbox']",
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
      "div.ya",
      "div[role='complementary']"
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
      description = "condition",
      onTick = null
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

      // 5.0.5: optional per-tick callback so long waits can surface
      // intermediate "still working" beats to the progress page.
      if (onTick) {
        try { onTick(Date.now() - start); } catch (e) {
          debugLog("waitFor onTick threw", { error: e?.message });
        }
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
    // Set timestamp immediately to prevent concurrent calls from passing the guard
    lastMasterCheckboxClickTime = now;

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
      checkbox.click();

      // Poll for state change instead of fixed sleep. We watch for
      // either the master's own aria-checked flipping OR real
      // selection appearing on rows (tr.x7).
      await waitFor(
        () => {
          const newState = getCheckboxState(checkbox);
          if (newState !== stateBefore) return true;
          const cnt = extractSelectedCount();
          return cnt !== null && cnt > 0;
        },
        {
          timeout: TIMING.SELECTION_VERIFY_TIMEOUT,
          interval: 50,
          description: "checkbox state change"
        }
      );

      // 5.0.7: Gmail's current UI accepts the master `.click()` and
      // toggles the master's own aria-checked, but the row-level
      // selection model is NOT populated (verified by live DOM
      // inspection against mail.google.com). Visual checkmarks on
      // rows are CSS-only; Gmail's delete handler reads from its
      // internal selection model and finds 0 → no actual delete.
      //
      // Detect that case (master flipped but tr.x7 count is 0) and
      // fall through to clicking each row checkbox individually.
      // Per-row clicks DO populate the real selection model.
      const stateAfter = getCheckboxState(checkbox);
      let selectedCountAfter = extractSelectedCount();

      if ((selectedCountAfter ?? 0) === 0) {
        const fallbackCount = await selectAllVisibleRowsIndividually();
        if (fallbackCount > 0) {
          selectedCountAfter = fallbackCount;
          safeSend({
            phase: "debug",
            detail: `Master click didn't propagate; fell back to per-row select (${fallbackCount} rows)`
          });
        }
      }

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
      const didChange = stateBefore !== stateAfter;
      const hasSelections = selectedCountAfter !== null && selectedCountAfter > 0;

      if (didChange || hasSelections) {
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

  // 5.0.7: per-row selection as a reliable fallback when the master
  // checkbox click visually selects rows but doesn't populate Gmail's
  // internal selection model. Iterates every visible row checkbox and
  // clicks the unchecked ones. Returns the post-action selected count.
  async function selectAllVisibleRowsIndividually() {
    const grid = qs(SELECTORS.grid);
    if (!grid) return 0;
    const rows = qsa('tr[role="row"]', grid);
    let clicked = 0;
    for (const r of rows) {
      const cb = r.querySelector('[role="checkbox"]');
      if (!cb) continue;
      if (cb.getAttribute("aria-checked") === "true") continue;
      try {
        cb.click();
        clicked++;
      } catch (e) {
        debugLog("Per-row click threw", { error: e?.message });
      }
    }
    // Brief settle so x7 class lands on all clicked rows.
    if (clicked > 0) await sleep(TIMING.CHECKBOX_SETTLE_DELAY);
    return extractSelectedCount() ?? 0;
  }

  // =========================
  // Button finder utilities
  // =========================

  function findButtonByTokens(tokens, primaryPattern, root = findToolbarRoot() || document) {
    const buttons = qsa("div[role='button'], button, span[role='button']", root);

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

  // Locate the toolbar "More email options" overflow button. Scored by
  // token match plus the presence of aria-haspopup (the overflow always
  // opens a menu), so we don't mistake a plain icon button for it.
  function findMoreOptionsButton() {
    const root = findToolbarRoot() || document;
    const buttons = qsa("div[role='button'], button, span[role='button']", root);
    let best = null;
    let bestScore = 0;
    for (const el of buttons) {
      const label = getElementLabel(el).toLowerCase();
      if (!label) continue;
      let score = 0;
      for (const token of MORE_OPTIONS_TOKENS) {
        if (label.includes(token.toLowerCase())) score += 2;
      }
      if (/\bmore\b|más|d'options|mehr|weitere|mais|altr|meer|więcej|diğer|ещё/i.test(label)) score += 2;
      const popup = getAttr(el, "aria-haspopup");
      if (popup && popup !== "false") score += 3;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore > 0 ? /** @type {HTMLElement} */ (best) : null;
  }

  // Find the "Label as" item inside an open Gmail menu (role="menu").
  function findLabelMenuItemIn(menuRoot) {
    if (!menuRoot) return null;
    const items = qsa(
      "div[role='menuitem'], li[role='menuitem'], span[role='menuitem'], div[role='menuitemcheckbox']",
      menuRoot
    );
    for (const el of items) {
      const label = getElementLabel(el).toLowerCase();
      if (!label) continue;
      if (LABEL_BUTTON_TOKENS.some((t) => label.includes(t.toLowerCase())) || /label|libell|etiquet|etichett/i.test(label)) {
        return /** @type {HTMLElement} */ (el);
      }
    }
    return null;
  }

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
   * Count visible email rows in the result grid. Returns null when the
   * grid isn't present (e.g. results still loading).
   */
  function getGridRowCount() {
    const main = qs(SELECTORS.main);
    if (!main) return null;
    const grid = qs(SELECTORS.grid, main);
    if (!grid) return null;
    return qsa("tr[role='row']", grid).length;
  }

  /**
   * Detect Gmail's post-action "Conversation(s) moved to Trash. Undo."
   * toast, strong positive evidence the action actually happened. We
   * look in alert/status regions for text containing "Undo" and one of
   * the action-result tokens.
   */
  function findUndoToast() {
    const regions = [
      ...qsa("div[role='alert']"),
      ...qsa("div[role='status']"),
      ...qsa("div[aria-live='assertive']"),
      ...qsa("div[aria-live='polite']")
    ];
    for (const region of regions) {
      const text = getTextContent(region).toLowerCase();
      if (!text || !text.includes("undo")) continue;
      // Common action confirmation words across locales / actions.
      if (/(moved to trash|archived|moved to bin|deleted|removed|delet|trash|gelöscht|supprim|elimina|movido|enviado|verschoben)/i.test(text)) {
        return region;
      }
    }
    return null;
  }

  /**
   * Wait for Gmail to process an action (list refresh, spinner, etc.).
   * v5.0.6 requires positive evidence the action happened, a null
   * selection count is no longer treated as success because
   * extractSelectedCount returns null both when "0 selected" AND when
   * Gmail's selection text drifts to a layout we don't recognise. The
   * false positive caused the engine to report "0 affected" while
   * blissfully moving on, even when no rows were actually deleted.
   *
   * Acceptable success signals (any one is enough):
   *   - Selection count dropped to 0 (from a known positive start)
   *   - Selection count dropped > 50% (chunked delete on bulk)
   *   - Grid row count decreased (visible rows removed)
   *   - hasNoResults() (page settled empty)
   *   - Undo toast visible (Gmail confirmed an action)
   *
   * @returns {Promise<{ ok: boolean, signal: string, startRowCount: number|null, endRowCount: number|null }>}
   */
  async function waitForActionProcessing() {
    const startSelectedCount = extractSelectedCount();
    const startRowCount = getGridRowCount();

    let lastSignal = "";

    const processed = await waitFor(
      () => {
        const currentCount = extractSelectedCount();
        const currentRowCount = getGridRowCount();

        if (
          startSelectedCount !== null && startSelectedCount > 0 &&
          (currentCount === 0 || (currentCount !== null && currentCount < startSelectedCount * 0.5))
        ) {
          lastSignal = "selection-dropped";
          return true;
        }

        if (
          startRowCount !== null && currentRowCount !== null &&
          currentRowCount < startRowCount
        ) {
          lastSignal = "rows-removed";
          return true;
        }

        if (hasNoResults()) {
          lastSignal = "no-results";
          return true;
        }

        if (findUndoToast()) {
          lastSignal = "undo-toast";
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

    const endRowCount = getGridRowCount();
    debugLog("Action processing wait result", {
      processed: !!processed,
      signal: lastSignal,
      startSelected: startSelectedCount,
      endSelected: extractSelectedCount(),
      startRowCount,
      endRowCount
    });

    return { ok: !!processed, signal: lastSignal, startRowCount, endRowCount };
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

    // 6.0: a focused "target" preset overrides the stored rule set for
    // this run. Already sanitized in sanitizeConfig; safe-mode filtering
    // and the per-query global guards still apply below / downstream.
    if (Array.isArray(CONFIG.rulesOverride) && CONFIG.rulesOverride.length > 0) {
      debugLog("Using focused rules override", { count: CONFIG.rulesOverride.length });
      return stripRisky([...CONFIG.rulesOverride]);
    }

    try {
      if (hasChromeStorage("sync")) {
        const result = await new Promise((resolve) => {
          chrome.storage.sync.get("rules", resolve);
        });

        const allRules = result?.rules ?? DEFAULT_RULES;
        // Make a mutable copy of the rule set
        const set = [...(allRules[intensity] ?? allRules.normal ?? DEFAULT_RULES.normal)];

        // Load and merge custom rules BEFORE applying safe mode filter
        try {
          const customResult = await new Promise((resolve) => {
            chrome.storage.sync.get("customRules", resolve);
          });
          const customRules = customResult?.customRules || [];
          for (const cr of customRules) {
            if (!cr.query || typeof cr.query !== "string") continue;
            const trimmed = cr.query.trim();
            // Issue #8: refuse dangerous custom queries at the engine
            // boundary so a hand-edited rule that bypassed the options
            // validator still can't target starred / sent / imap_starred
            // mail. We log + skip silently rather than abort the run.
            if (queryHasDangerousToken(trimmed)) {
              debugLog("Refusing dangerous custom rule", { query: trimmed });
              safeSend({
                phase: "debug",
                detail: `Custom rule skipped (targets protected mail): ${trimmed}`
              });
              continue;
            }
            set.push(trimmed);
          }
        } catch (e) {
          debugLog("Failed to load custom rules", { error: e?.message });
        }

        // Apply safe mode filter to ALL rules including custom
        return stripRisky(set);
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
        if (/\s|\bOR\b|\bAND\b|[{}()]/i.test(trimmed)) {
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
      const unit = (sizeMatch[2] || "m");

      if (unit === "m") { /* already in MB */ }
      else if (unit === "k") val = val / 1024;
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
    const currentHash = location.hash;
    const targetHash = hash;

    if (!location.href.startsWith(base)) {
      location.href = base + hash;
    } else if (currentHash === targetHash) {
      // Same hash - force reload by going to inbox then back
      location.hash = "#inbox";
      await sleep(TIMING.DOM_SETTLE_DELAY);
      location.hash = hash;
    } else {
      location.hash = hash;
    }

    // 5.0.5: also accept Gmail's empty-state UI as a valid "search
    // settled" signal. Before this fix, any query that legitimately
    // returned zero matches (very common with `larger:20M` once the
    // global guards strip starred / important / unread / user-labeled
    // mail) would never satisfy `rows.length > 0`, time out at 20 s,
    // and retry 6 times, pinning the run for ~2 minutes on a query
    // that should resolve immediately. `td.TC` is Gmail's empty-state
    // container; it only appears after the search has actually
    // finished and produced zero results, so it's safe to treat as
    // "loaded". `hasNoResults()` downstream then records the query
    // cleanly with count=0.
    const ok = await waitFor(
      () => {
        const main = qs(SELECTORS.main);
        if (!main) return false;

        const grid = qs(SELECTORS.grid, main);
        if (grid) {
          const rows = qsa("tr", grid);
          if (rows.length > 0) return true;
          // Empty grid is ambiguous (loading vs no results). Only
          // treat as settled when the empty-state container is
          // present too.
          if (qs("td.TC", main)) return true;
          return false;
        }

        // No grid yet, fall back to the list container or the empty
        // state UI on its own (some Gmail layouts skip the table).
        if (qs("td.TC", main)) return true;
        return qs(SELECTORS.listContainer, main);
      },
      {
        timeout: TIMING.WAIT_SEARCH_TIMEOUT,
        description: "Gmail search results",
        onTick: (elapsedMs) => {
          // Every ~5s of waiting, surface a progress beat so the
          // user knows the script isn't dead, just waiting on
          // Gmail to render.
          if (elapsedMs > 0 && elapsedMs % 5000 < TIMING.WAIT_DEFAULT_INTERVAL) {
            safeSend({
              phase: "debug",
              detail: `Still waiting for search results (${Math.round(elapsedMs / 1000)}s)...`
            });
          }
        }
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

  // Captures a short label snapshot from an element so progress logs
  // can show which exact button we picked. Helps diagnose cases where
  // findButtonByTokens scored the wrong control.
  function describeButton(el) {
    if (!el) return "none";
    const aria = getAttr(el, "aria-label");
    const tooltip = getAttr(el, "data-tooltip");
    const title = getAttr(el, "title");
    const text = getTextContent(el).slice(0, 40);
    return (aria || tooltip || title || text || "unlabeled").slice(0, 80);
  }

  async function tryDeleteAction() {
    const btn = findDeleteButton();
    if (btn) {
      const label = describeButton(btn);
      try {
        btn.click();
        debugLog("Clicked delete button", { label });
        safeSend({ phase: "debug", detail: `Clicked delete button: "${label}"` });
        return true;
      } catch (e) {
        debugLog("Failed to click delete button", { label, error: e?.message });
        safeSend({ phase: "debug", detail: `Delete click threw: ${e?.message || e}` });
      }
    }

    debugLog("Delete button not found, no keyboard fallback");
    safeSend({ phase: "debug", detail: "Delete button not found in toolbar" });
    return false;
  }

  async function tryArchiveAction() {
    const btn = findArchiveButton();
    if (btn) {
      const label = describeButton(btn);
      try {
        btn.click();
        debugLog("Clicked archive button", { label });
        safeSend({ phase: "debug", detail: `Clicked archive button: "${label}"` });
        return true;
      } catch (e) {
        debugLog("Failed to click archive button", { label, error: e?.message });
        safeSend({ phase: "debug", detail: `Archive click threw: ${e?.message || e}` });
      }
    }

    debugLog("Archive button not found, no keyboard fallback");
    safeSend({ phase: "debug", detail: "Archive button not found in toolbar" });
    return false;
  }

  // Open Gmail's "Label as" search input. Tries, in order: a direct
  // toolbar Labels button (older Gmail), the "More email options"
  // overflow menu (current Gmail moved Labels in there), then the "l"
  // keyboard shortcut. Returns the input element or null.
  async function openLabelInput() {
    const getInput = () =>
      waitForElement(SELECTORS.labelInputs, { timeout: TIMING.LABEL_DIALOG_TIMEOUT });

    const direct = findLabelButton();
    if (direct) {
      try { direct.click(); } catch (e) { debugLog("Direct label click threw", { error: e?.message }); }
      const input = await getInput();
      if (input) return input;
    }

    const more = findMoreOptionsButton();
    if (more) {
      try { more.click(); } catch (e) { debugLog("More-options click threw", { error: e?.message }); }
      const menu = await waitForElement(["div[role='menu']"], { timeout: TIMING.LABEL_DIALOG_TIMEOUT });
      if (menu) {
        const item = findLabelMenuItemIn(menu);
        if (item) {
          try { item.click(); } catch (e) { debugLog("Label menuitem click threw", { error: e?.message }); }
          const input = await getInput();
          if (input) return input;
        }
      }
      // Couldn't complete the menu path -- close it so we don't leave an
      // overflow menu open over the toolbar.
      dispatchKeyEvent("Escape", "Escape");
    }

    // Last resort: Gmail's "Label as" hotkey. Only fires if the user has
    // keyboard shortcuts enabled, but it's harmless otherwise.
    dispatchKeyEvent("l", "KeyL");
    return (await getInput()) || null;
  }

  async function applyTagLabel(labelName) {
    if (!labelName?.trim()) return false;

    const input = await openLabelInput();
    if (!input || !(input instanceof HTMLInputElement)) {
      safeSend({
        phase: "tag",
        status: "Label control not found; skipping tag.",
        detail: labelName
      });
      return false;
    }

    try {
      input.focus();

      // Use React-compatible value setting via native input setter
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));

        nativeInputValueSetter.call(input, labelName);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        // Fallback for non-React environments
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.value = labelName;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }

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

    // Check for empty grid (works regardless of language)
    const grid = qs(SELECTORS.grid, mainRoot);
    if (grid) {
      const rows = qsa("tr[role='row']", grid);
      // If grid exists but has zero data rows, it's no results
      if (rows.length === 0) return true;
    }

    // Check for "no results" text in any language - look for the specific
    // Gmail empty state container
    const emptyStateEls = qsa("td.TC", mainRoot);
    if (emptyStateEls.length > 0) {
      return true;
    }

    // Fallback: check known text indicators
    const spans = qsa("span, div.UI", mainRoot);
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
  // 5.0.7: Gmail's current UI no longer surfaces "N selected" text
  // anywhere inside div[role="main"], verified by direct DOM
  // inspection on the live app. The reliable selection signal is the
  // `x7` class Gmail adds to every selected `tr[role="row"]`. We
  // count those rows; if the grid isn't present we fall back to the
  // legacy text scrape so older Gmail layouts still work.
  function extractSelectedCount() {
    const mainRoot = getMainRoot();

    // Primary signal (current Gmail): row.x7 count.
    const grid = qs(SELECTORS.grid, mainRoot);
    if (grid) {
      const selectedRows = qsa('tr[role="row"].x7', grid);
      if (selectedRows.length > 0) return selectedRows.length;
      // Also try checkbox-state count as cross-check (selected rows
      // have their inner checkbox aria-checked="true").
      const checked = qsa('tr[role="row"] [role="checkbox"][aria-checked="true"]', grid);
      if (checked.length > 0) return checked.length;
    }

    // Legacy fallback: scrape "N selected" text. Older Gmail layouts
    // and a few locale variations still emit this so we keep the path.
    const spans = qsa("span", mainRoot);
    for (const el of spans) {
      const text = getTextContent(el);
      if (!text || !/selected/i.test(text)) continue;
      const allMatch = text.match(/all\s+([\d,.\s]+)\s+conversations?\s+.*selected/i);
      if (allMatch) {
        const n = parseInt(allMatch[1].replace(/[,.\s]/g, ""), 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
      const firstMatch = text.match(/([\d,]+)/);
      if (firstMatch) {
        const n = parseInt(firstMatch[1].replace(/[,.\s]/g, ""), 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }

    return null;
  }

  // =========================
  // Pre-action sampler (issue #9 / top senders)
  // =========================
  // Pulls a capped sample of (sender, threadId) tuples from the visible
  // Gmail rows so the undo log can include real identifiers and the
  // top-senders dashboard can rank inbox noisy senders.
  //
  // Selectors are Gmail's stable list classes; we fall back to generic
  // role=row patterns if those drift. Best-effort, failure here must
  // not block deletion.

  function sampleListRows({ maxSamples = 50 } = {}) {
    const out = { senders: [], threadIds: [] };
    try {
      const root = getMainRoot() || document;
      const candidates = qsa('tr[role="row"]', root);
      const limit = Math.min(candidates.length, maxSamples);
      const senderSet = new Set();
      const idSet = new Set();

      for (let i = 0; i < limit; i++) {
        const row = candidates[i];
        if (!row) continue;

        // Sender: Gmail puts it in span[email] or as a name attribute.
        const senderEl =
          row.querySelector('span[email]') ||
          row.querySelector('[email]') ||
          row.querySelector('.yW span[name]');

        if (senderEl) {
          const email = (senderEl.getAttribute("email") || "").trim().toLowerCase();
          const name = (senderEl.getAttribute("name") || senderEl.textContent || "").trim();
          const key = email || name;
          if (key && !senderSet.has(key)) {
            senderSet.add(key);
            out.senders.push(key);
          }
        }

        // Thread id: Gmail's row has a legacy thread token in either
        // its id attribute or in a child data attribute.
        const threadAttr = row.getAttribute("data-legacy-thread-id")
          || row.getAttribute("data-thread-id")
          || row.getAttribute("id")
          || "";
        if (threadAttr && !idSet.has(threadAttr)) {
          idSet.add(threadAttr);
          out.threadIds.push(threadAttr);
        }
      }
    } catch (e) {
      debugLog("sampleListRows failed", { error: e?.message });
    }
    return out;
  }

  // Holds the last batch's samples so the undo recorder can attach
  // them to the runtime message. Reset between queries.
  let lastBatchSamples = { senders: [], threadIds: [] };

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

    // Selector-rot telemetry: rows are clearly present but our selection
    // detectors saw nothing, even after the master + per-row fallback.
    // That usually means Gmail reshuffled its row/selection classes.
    if ((initialSelectedCount ?? 0) === 0 && (getGridRowCount() ?? 0) > 0 && !SELECTOR_ROT_WARNED) {
      SELECTOR_ROT_WARNED = true;
      safeSend({
        phase: "warning",
        status: "Selection not detected on a non-empty list.",
        detail: "Gmail's layout may have changed; deletion could be unreliable. Please report this."
      });
    }

    let bulkSelected = false;
    let bulkAllSelected = false;
    const selectAllResult = await clickSelectAllConversations();

    if (selectAllResult.success) {
      bulkSelected = true;
      // A confirmed "all N conversations selected" banner means Gmail will
      // act on EVERY matching conversation in one shot, not just the
      // visible page -- the affected count must then use the match total.
      bulkAllSelected =
        selectAllResult.reason === "all-selected-indicator" ||
        findAllConversationsSelectedIndicator();
      debugLog("Bulk selection result", { ...selectAllResult, bulkAllSelected });

      const finalCount = extractSelectedCount();
      safeSend({
        phase: "debug",
        detail: `Bulk selection: ${initialSelectedCount ?? "?"} → ${finalCount ?? "?"}${bulkAllSelected ? " (all matching)" : ""}`
      });
    }

    const selectedCount = extractSelectedCount() ?? initialSelectedCount;
    const actionWord = CONFIG.archiveInsteadOfDelete ? "archive" : "delete";

    // Run-level soft cap guardrail
    if (!CONFIG.dryRun) {
      const projectedTotal = liveRunProcessedSoFar + (selectedCount ?? 0);

      if (projectedTotal > GUARDRAILS.RUN_SOFT_CAP && !window.GCC_CONFIRMED_SOFT_CAP) {
        // Issue #7: confirm() blocks the Gmail tab indefinitely if no
        // user is around. Scheduled cleanups run unattended, so we
        // auto-decline (which stops cleanly) instead of hanging the
        // tab waiting for a click that will never come.
        if (CONFIG.scheduled) {
          debugLog("Scheduled run hit soft cap, declining unattended", { projectedTotal });
          safeSend({
            phase: "debug",
            detail: `Scheduled run paused at soft cap (${projectedTotal.toLocaleString()} >= ${GUARDRAILS.RUN_SOFT_CAP.toLocaleString()}). Skipping.`
          });
          return { deleted: false, count: 0, reason: "scheduled-soft-cap-declined" };
        }

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

    // Tag before action. Track whether it actually worked so the undo
    // log can honestly record when recovery-by-label is unavailable.
    let taggingFailed = false;
    if (!CONFIG.dryRun && tagLabel && CONFIG.tagBeforeDelete) {
      try {
        const tagged = await applyTagLabel(tagLabel);
        taggingFailed = !tagged;
      } catch (e) {
        taggingFailed = true;
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
      // Issue #7: same scheduled-run guard as the soft-cap above.
      if (CONFIG.scheduled) {
        debugLog("Scheduled run hit huge-run threshold, declining unattended", { estimatedTotal });
        safeSend({
          phase: "debug",
          detail: `Scheduled run paused at huge-run threshold (~${estimatedTotal.toLocaleString()}). Skipping.`
        });
        return { deleted: false, count: 0, reason: "scheduled-huge-run-declined" };
      }

      const confirmed = confirm(
        `About to delete ~${estimatedTotal.toLocaleString()} conversations. Continue?`
      );

      if (!confirmed) {
        debugLog("User cancelled at huge-run confirmation", { estimatedTotal });
        return { deleted: false, count: 0, reason: "user-cancelled" };
      }

      window.GCC_CONFIRMED_HUGE = true;
    }

    // Large single batch suggests the rule matched far more than
    // expected. We don't block here (the soft-cap / huge-run gates do
    // that) but we DO warn and sample so the user can review afterwards.
    if (!CONFIG.dryRun && (selectedCount ?? 0) > GUARDRAILS.LARGE_BATCH_WARN_THRESHOLD) {
      safeSend({
        phase: "warning",
        status: `Large batch detected (${(selectedCount ?? 0).toLocaleString()})`,
        detail: "Sampling senders before action so you can review afterwards.",
      });
    }

    const countBeforeAction = extractSelectedCount();
    const rowsBeforeAction = getGridRowCount();
    // Capture the match total BEFORE the action: once Gmail deletes the
    // selection, its "of N" results count disappears, so a bulk-all count
    // can't be recovered afterwards.
    const totalBeforeAction = bulkAllSelected ? estimateTotalResults() : null;
    safeSend({
      phase: "debug",
      detail: `Executing ${actionWord} on ${countBeforeAction ?? "?"} items (visible rows: ${rowsBeforeAction ?? "?"})`
    });

    // Issue #9: sample sender addresses and message thread IDs from
    // the Gmail list rows before action so the undo log carries
    // searchable identifiers, not just a metadata summary. Capped to
    // 50 to keep the payload small and the operation fast (this runs
    // synchronously on the DOM before the click).
    const sampledRows = sampleListRows({ maxSamples: 50 });
    if (sampledRows.senders.length > 0 && hasChromeRuntime()) {
      try {
        chrome.runtime.sendMessage({
          type: "gmailCleanerRecordSenders",
          senders: sampledRows.senders
        });
      } catch (e) {
        debugLog("Failed to send sender samples to background", { error: e?.message });
      }
    }
    // Stash on a function-scoped var so recordUndo can read it after
    // tryDeleteAction completes.
    lastBatchSamples = sampledRows;

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

    // Verify action completed. 5.0.6: returns a {ok, signal,
    // startRowCount, endRowCount} object so we can derive a real
    // affected count even when Gmail's "N selected" text doesn't
    // render in a layout extractSelectedCount recognises.
    const verification = await waitForActionProcessing();
    debugLog("Action processing completed", verification);

    if (!verification.ok) {
      const rl = findRateLimitText();
      if (rl) throw new RateLimitError(rl);
      throw new TimeoutError("Action processing timed out (Gmail did not refresh selection/results).");
    }

    const countAfterAction = extractSelectedCount();
    safeSend({
      phase: "debug",
      detail: `Action verified by: ${verification.signal} (selected: ${countBeforeAction ?? "?"}→${countAfterAction ?? "cleared"}, rows: ${verification.startRowCount ?? "?"}→${verification.endRowCount ?? "?"})`
    });

    // Derive the actual affected count from the strongest signal:
    //  - bulk-all confirmed: Gmail removes EVERY matching conversation in
    //    one action, so use the match total captured before the action.
    //  - per-viewport: the visible selection (x7 rows) we clicked is
    //    exactly what Gmail removed, so countBeforeAction is accurate. We
    //    deliberately do NOT trust a row-count delta first here: Gmail
    //    backfills the list with fresh rows after a delete, which can make
    //    the delta read ~0 even though a full page was removed.
    //  - empty after action: everything visible was acted on.
    let affectedCount;
    if (bulkAllSelected) {
      affectedCount = (selectedCount && selectedCount > 0)
        ? selectedCount
        : (totalBeforeAction || rowsBeforeAction || 0);
    } else if (countBeforeAction !== null && countBeforeAction !== undefined && countBeforeAction > 0) {
      affectedCount = countBeforeAction;
    } else if (verification.signal === "no-results" && rowsBeforeAction !== null && rowsBeforeAction !== undefined) {
      affectedCount = rowsBeforeAction;
    } else if (
      verification.startRowCount !== null && verification.startRowCount !== undefined &&
      verification.endRowCount !== null && verification.endRowCount !== undefined &&
      verification.startRowCount > verification.endRowCount
    ) {
      affectedCount = verification.startRowCount - verification.endRowCount;
    } else {
      affectedCount = 0;
    }

    liveRunProcessedSoFar += affectedCount;

    return { deleted: true, count: affectedCount, bulkSelected, taggingFailed };
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
    const start = Date.now();

    while (!REVIEW_SIGNAL && !CANCELLED) {
      // Don't wait forever: if the progress tab was closed without a
      // resume/skip, treat the query as skipped so the run can finish.
      if (Date.now() - start > GUARDRAILS.REVIEW_RESPONSE_TIMEOUT_MS) {
        debugLog("Review response timed out; treating as skip");
        safeSend({
          phase: "warning",
          status: "Review timed out; skipping this rule.",
          detail: "No response received, so the run continues with the next rule."
        });
        return "skip";
      }
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

    try {
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

          // Report per-pass progress
          safeSend({
            phase: "pass-progress",
            detail: `${label}: pass ${pass}/${TIMING.PASS_CAP}, ${queryDeletedCount} affected so far`,
            queryLabel: label,
            passNumber: pass,
            passTotal: TIMING.PASS_CAP,
            queryDeletedCount
          });

          // Record undo entry for recovery. 5.0 attaches a sample of
          // message IDs and sender count so recovery isn't purely
          // dependent on the optional tag label (issue #9).
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
                  intensity: CONFIG.intensity,
                  sampledMessageIds: lastBatchSamples.threadIds.slice(0, 50),
                  sampledSenderCount: lastBatchSamples.senders.length,
                  taggingFailed: Boolean(result.taggingFailed)
                }
              });
            }
          } catch (e) {
            debugLog("Failed to record undo entry", { error: e?.message });
          }
          // Reset for next pass; the next sample is taken fresh.
          lastBatchSamples = { senders: [], threadIds: [] };

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
          const errMsg = e?.message || String(e);

          // 5.0.1 per-query wall-time budget. Even with the per-pass
          // retry cap, a query that consistently hits 20s waits + 30s
          // backoffs can pin the run for >10 minutes. Bail to the next
          // query so the run as a whole keeps moving.
          const elapsedMs = Date.now() - start;
          if ((isRL || isTO) && elapsedMs > GUARDRAILS.QUERY_WALL_TIME_BUDGET_MS) {
            safeSend({
              phase: "warning",
              status: `Skipping ${label} after ${Math.round(elapsedMs / 1000)}s`,
              detail: `Repeated ${isRL ? "rate-limit" : "timeout"} signals; moving to next rule. Last error: ${errMsg}`
            });
            recordQueryStats({
              query,
              label,
              count: queryDeletedCount,
              mode: CONFIG.dryRun ? "dry" : "live",
              durationMs: elapsedMs
            });
            deescalateBackoff();
            return;
          }

          if ((isRL || isTO) && retries < TIMING.RATE_LIMIT_MAX_RETRIES_PER_PASS) {
            retries++;
            // 5.0.1 surface the retry counter so the user sees forward
            // motion through the retry budget.
            safeSend({
              phase: "debug",
              detail: `${label}: retry ${retries}/${TIMING.RATE_LIMIT_MAX_RETRIES_PER_PASS} after ${isRL ? "rate limit" : "timeout"}`
            });
            await backoff(isRL ? "rate-limited" : "timeout", errMsg);
            continue;
          }

          // 5.0.2 retries exhausted on a known-transient error: skip
          // this query and let the run continue. Previously this
          // re-threw, which propagated up to main() and aborted the
          // entire cleanup on the first stubborn rule. Cancellation
          // and unexpected errors still propagate.
          if (isRL || isTO) {
            safeSend({
              phase: "warning",
              status: `Skipping ${label} after ${retries} retries`,
              detail: `Last error: ${errMsg}. Run continues with the next rule.`
            });
            recordQueryStats({
              query,
              label,
              count: queryDeletedCount,
              mode: CONFIG.dryRun ? "dry" : "live",
              durationMs: elapsedMs
            });
            deescalateBackoff();
            return;
          }

          throw e;
        }
      }
    }
    } catch (e) {
      // Record partial stats even on failure
      if (!(e instanceof CancellationError)) {
        recordQueryStats({
          query,
          label,
          count: queryDeletedCount,
          mode: CONFIG.dryRun ? "dry" : "live",
          durationMs: Date.now() - start
        });
      }
      throw e;
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
      action: CONFIG.archiveInsteadOfDelete ? "archive" : "delete",
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
    SELECTOR_ROT_WARNED = false;
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

      // Issue #7: the end-of-run alert() also blocks the Gmail tab.
      // Skip it for unattended scheduled runs, the desktop
      // notification (if opted in) and the stats page surface the
      // outcome instead.
      if (!CONFIG.dryRun && stats.totalDeleted > 0 && !CONFIG.scheduled) {
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
      // Notify background to clean up ACTIVE_RUN state and trigger an
      // opt-in completion notification (5.0).
      try {
        if (hasChromeRuntime()) {
          chrome.runtime.sendMessage({
            type: "gmailCleanerDone",
            summary: {
              count: stats.totalDeleted || 0,
              freedMb: Math.round((stats.totalFreedMb || 0) * 10) / 10,
              action: CONFIG.archiveInsteadOfDelete ? "archive" : "delete",
              dryRun: Boolean(CONFIG.dryRun),
              intensity: CONFIG.intensity,
              scheduled: Boolean(CONFIG.scheduled),
              runId: CONFIG.runId || ""
            }
          });
        }
      } catch (e) {
        debugLog("Failed to send done message to background", { error: e?.message });
      }
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
      extractSelectedCount,
      findMoreOptionsButton,
      findLabelMenuItemIn,
      findAllConversationsSelectedIndicator,
      queryHasDangerousToken,
      buildFinalStats
    };
  }

  startMain();
})();