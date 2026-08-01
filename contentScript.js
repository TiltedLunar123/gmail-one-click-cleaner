(() => {
  "use strict";

  const GCC_CONTENT_VERSION = "8.5.0";

  // =========================
  // Timing & behavior constants
  // =========================

  const TIMING = Object.freeze({
    PASS_CAP: 150,
    WAIT_DEFAULT_TIMEOUT: 15000,
    WAIT_DEFAULT_INTERVAL: 200,
    WAIT_TOOLBAR_TIMEOUT: 8000,
    WAIT_SEARCH_TIMEOUT: 20000,
    // Beat after a hash navigation before we start sampling results, so
    // the poll doesn't read the previous query's rows that Gmail leaves
    // painted for the first frame of the in-place transition.
    SEARCH_TRANSITION_DELAY: 400,
    POST_ACTION_DELAY_MS: 800,
    BETWEEN_PASS_SLEEP_MS: 650,
    LABEL_DIALOG_TIMEOUT: 1200,
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
    // Shorter than the review timeout because the user is right there
    // watching a run they just started, and because timing out here
    // STOPS the run rather than skipping one rule.
    GUARD_RESPONSE_TIMEOUT_MS: 5 * 60 * 1000,
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
      // A leading "(" opens a group, so `(is:starred)` is every bit as
      // positive as a bare `is:starred`. Anchoring on whitespace alone let
      // the parenthesised form past this refusal, and applyGlobalGuards
      // then skipped adding `-is:starred` because the token did appear in
      // the query. Both protections failed on the same string.
      //
      // 7.15: `{` opens Gmail's documented OR group, so `{is:starred
      // is:unread}` was the same escape hatch one character over. Every
      // grouping character Gmail accepts belongs in this class.
      const negated = new RegExp(`(^|[\\s({])-\\s*${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      const positive = new RegExp(`(^|[\\s({])${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
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

  // 7.4: Gmail moved or removed a control the engine cannot work
  // without. Raised only on the hard signals (results on screen but no
  // selection control; tag-before-delete with no way into the label
  // dialog), never on empty result sets, so the run ends with a
  // specific explanation instead of wrong-looking zero counts or a
  // silent loss of the tag safety net. The code field rides the
  // existing phase:"error" progress message as an optional extra.
  class GmailLayoutError extends Error {
    constructor(message) {
      super(message);
      this.name = "GmailLayoutError";
      this.code = "gmail_layout_changed";
    }
  }

  const layoutChangedMessage = (what) =>
    `Gmail changed its layout: ${what}. ` +
    "Nothing was touched beyond what already completed. " +
    "An update usually follows within days.";

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
  // Separate from REVIEW_SIGNAL on purpose: a leftover "resume" from
  // Review Mode must never be read as consent to a 20,000-message run.
  let GUARD_SIGNAL = null;
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

  // Protected keywords (subject shield). Self-contained mirror of
  // GCC.sanitizeProtectKeywords / GCC.buildSubjectExclusion from shared.js
  // -- the content script is injected into Gmail and can't reference GCC,
  // so (like the whitelist regexes above) we keep a defence-in-depth copy
  // here. Strips the quoting / grouping / boolean operators that would let
  // a keyword escape the `subject:( ... )` group it is injected into.
  const MAX_PROTECT_KEYWORDS = 25;
  const MAX_PROTECT_KEYWORD_LEN = 50;

  function sanitizeProtectKeywords(input) {
    const arr = Array.isArray(input)
      ? input
      : (typeof input === "string" ? input.split("\n") : []);
    const out = [];
    const seen = new Set();
    for (const raw of arr) {
      if (typeof raw !== "string") continue;
      const cleaned = raw
        .replace(/["(){}]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[-\s]+/, "")
        .trim()
        .slice(0, MAX_PROTECT_KEYWORD_LEN)
        .trim();
      if (!cleaned) continue;
      if (/^(or|and)$/i.test(cleaned)) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
      if (out.length >= MAX_PROTECT_KEYWORDS) break;
    }
    return out;
  }

  function buildSubjectExclusion(keywords) {
    const cleaned = sanitizeProtectKeywords(keywords);
    if (cleaned.length === 0) return "";
    const terms = cleaned.map((k) => (/\s/.test(k) ? `"${k}"` : k));
    return `-subject:(${terms.join(" OR ")})`;
  }

  const sanitizeConfig = (config) => {
    if (!config || typeof config !== "object") {
      config = {};
    }

    const validIntensities = ["light", "normal", "deep", "maximum"];
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
        : [],
      // 6.1: global protected keywords. Any query gets a
      // `-subject:( ... )` exclusion appended so matching mail is never
      // touched. Sanitized here (defence-in-depth) so a hand-written
      // storage value can't break out of the subject group.
      protectKeywords: sanitizeProtectKeywords(config.protectKeywords),
      // 7.0: what this injection should do. "cleanup" (default) runs the
      // rules engine; "subscriptionScan" / "unsubscribe" run the
      // subscriptions engine. 7.2 adds "storageScan" (read-only size
      // tiers), 7.6 adds "restoreRun" (move a logged run's mail back to
      // the Inbox), 7.8 adds "smartScan" (read-only recommendation
      // scan). 8.0 adds "reportScan" (read-only mailbox report).
      // unsubSenders is re-sanitized at run start; keeping raw strings
      // here is fine.
      runKind: ["cleanup", "subscriptionScan", "unsubscribe", "storageScan", "restoreRun", "smartScan", "reportScan"].includes(config.runKind)
        ? config.runKind
        : "cleanup",
      unsubSenders: Array.isArray(config.unsubSenders)
        ? config.unsubSenders.filter((s) => typeof s === "string").slice(0, 25)
        : [],
      // 7.8 smart scan: senders earlier scans already measured, so the
      // discovery phase can include them without spending queries.
      // Re-sanitized (strict email shape) at run start.
      smartKnownSenders: Array.isArray(config.smartKnownSenders)
        ? config.smartKnownSenders.slice(0, 100)
        : [],
      // 7.6 restore run: the undo entry's label and mode. Double quotes
      // are stripped so the label can never break out of the quoted
      // label:"..." term it is placed in.
      restoreLabel: typeof config.restoreLabel === "string"
        ? config.restoreLabel.replace(/"/g, "").trim().slice(0, 120)
        : "",
      restoreAction: config.restoreAction === "archive" ? "archive" : "delete"
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

  // 7.5: widened to the same locale set as DELETE_LABEL_TOKENS. Button
  // names verified against Google's localized Gmail help pages.
  const ARCHIVE_LABEL_TOKENS = Object.freeze([
    "Archive", "Archived", "Archiver", "Archivar",
    "Archivé", "Archivieren", "Arquivar", "Archivia", "Archivio",
    "Archiveren", "Arkivera", "Arkivér", "Arkiver",
    "Archiwizuj", "Arşivle", "Архивировать", "أرشفة",
    "アーカイブ", "보관처리", "归档", "封存"
  ]);

  // 7.5: widened to the same locale set as DELETE_LABEL_TOKENS. Note
  // pt-BR Gmail calls labels "Marcadores"; nl/de Gmail keep "Labels".
  const LABEL_BUTTON_TOKENS = Object.freeze([
    "Labels", "Label", "Label as", "Libellés",
    "Etiquetas", "Etiquette", "Etichette", "Märken",
    "Marcadores", "Etiketter", "Etykiety", "Etiketler",
    "Ярлыки", "تصنيفات", "ラベル", "라벨", "标签", "標籤"
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

  // 7.5: Gmail's own wording for the header Unsubscribe control and the
  // confirm button in its dialog, one entry per CONFIRM_TOKENS locale,
  // verified against Google's localized Gmail help pages. Matched as
  // EXACT whole text (see buildExactTokenMatcher): substring matching
  // would let "Unsubscribe and block" pass as a plain confirm, and
  // would collide prefix pairs like "取消" (cancel) inside "取消訂閱"
  // (unsubscribe). Locales whose label could not be verified are left
  // out on purpose: an unmatched dialog stays "unknown" and is
  // dismissed, which is the safe failure.
  const UNSUBSCRIBE_TOKENS = Object.freeze([
    "Unsubscribe", "Darse de baja", "Se désabonner",
    "Abbestellen", "Cancelar inscrição", "Annulla iscrizione",
    "Afmelden", "Avsluta prenumeration", "Frameld",
    "Meld deg av", "Anuluj subskrypcję", "E-posta listesinden çık",
    "Отказаться от рассылки", "إلغاء الاشتراك",
    "登録解除", "メーリングリストの登録解除",
    "수신 거부", "退订", "取消訂閱"
  ]);

  // Dismiss buttons in the unsubscribe dialog: Google's standard dialog
  // vocabulary. Clicking one of these is behaviorally identical to the
  // Escape fallback, so a stale entry cannot cause a wrong unsubscribe.
  const UNSUB_CANCEL_TOKENS = Object.freeze([
    "Cancel", "No thanks", "Close", "Dismiss", "Got it",
    "Cancelar", "Annuler", "Abbrechen", "Annulla",
    "Annuleren", "Avbryt", "Annuller", "Anuluj",
    "İptal", "Отмена", "إلغاء",
    "キャンセル", "취소", "取消"
  ]);

  // The "go to website" hand-off for senders without one-click support.
  // A bulk run must never follow it, so recognizing it only makes the
  // engine skip the sender instead of reporting an unknown dialog.
  const UNSUB_WEBSITE_TOKENS = Object.freeze([
    "Go to website", "Ir al sitio web", "Accéder au site Web",
    "Website aufrufen", "Acessar o site", "Vai al sito web",
    "Naar website", "Öppna webbplatsen", "Gå til website",
    "Gå til nettstedet", "Wejdź na stronę", "Web sitesine git",
    "Перейти на сайт", "الانتقال إلى الموقع الإلكتروني",
    "ウェブサイトに移動", "웹사이트로 이동", "前往网站", "前往網站"
  ]);

  // 7.6 restore run: Gmail's own wording for the controls that move
  // mail back to the Inbox, one entry per DELETE_LABEL_TOKENS locale,
  // verified against Google's localized Gmail help pages (the archive
  // article for "Move to Inbox", the delete article for "Move to" and
  // the trash view's example destination). The direct button appears in
  // All Mail / archive views; the Trash toolbar instead offers a
  // "Move to" menu whose items are folder names, so all three shapes
  // are needed. Locales whose wording could not be verified are left
  // out on purpose: an unmatched toolbar does nothing, and mail that
  // stays in Trash remains recoverable, which is the safe failure.
  const MOVE_TO_INBOX_TOKENS = Object.freeze([
    "Move to Inbox", "Mover a Recibidos",
    "Placer dans la boîte de réception", "In Posteingang verschieben",
    "Mover para a Caixa de entrada", "Sposta in Posta in arrivo",
    "Naar inbox verplaatsen", "Flytta till inkorgen",
    "Flyt til Indbakke", "Flytt til Innboksen",
    "Przenieś do Odebranych", "Gelen Kutusuna Taşı",
    "Поместить во входящие", "نقل إلى البريد الوارد",
    "受信トレイに移動", "받은편지함으로 이동",
    "移至收件箱", "移至收件匣"
  ]);

  // The Trash toolbar's "Move to" menu opener. Matched as EXACT whole
  // text only: several locales use very short words (ja "移動", ko
  // "이동", zh "移至") that would substring-match unrelated controls.
  // Danish is deliberately absent: its help page words the recovery
  // step as the full "Flyt til Indbakke", so the standalone form could
  // not be verified.
  const MOVE_TO_TOKENS = Object.freeze([
    "Move to", "Mover a", "Déplacer vers", "Verschieben",
    "Mover para", "Sposta in", "Verplaatsen naar", "Flytta till",
    "Flytt til", "Przenieś do", "Şuraya taşı", "Переместить в",
    "نقل إلى", "移動", "이동", "移至"
  ]);

  // The Inbox entry inside the "Move to" menu, i.e. each locale's name
  // for the Inbox itself. Exact whole text only: a user label whose
  // name merely contains the word must never be picked. nl keeps the
  // older "Postvak IN" alongside the English fallback because Google's
  // Dutch pages currently use both.
  const INBOX_TOKENS = Object.freeze([
    "Inbox", "Recibidos", "Boîte de réception", "Posteingang",
    "Caixa de entrada", "Posta in arrivo", "Postvak IN",
    "Inkorgen", "Indbakke", "Innboks", "Innboksen",
    "Odebrane", "Gelen Kutusu", "Входящие", "البريد الوارد",
    "受信トレイ", "받은편지함", "收件箱", "收件匣"
  ]);

  // INVERSE-SAFETY DENY-LIST. The Trash toolbar also holds "Delete
  // forever", the one control in this flow that destroys mail past
  // recovery. Every restore finder refuses a candidate whose label
  // contains any of these strings, no matter how well it scores.
  // Substring matching is deliberate here: over-matching on the deny
  // side only skips a candidate, which is always safe. Strings come
  // from the same localized help pages; ar carries the researched
  // phrase plus its bare stem and ko both spacing forms, so grammar
  // and spacing variants of the same researched wording stay covered.
  const DELETE_FOREVER_TOKENS = Object.freeze([
    "Delete forever", "Eliminar definitivamente",
    "Supprimer définitivement", "Endgültig löschen",
    "Excluir definitivamente", "Elimina definitivamente",
    "Definitief verwijderen", "Radera permanent",
    "Slet for evigt", "Slett for godt", "Usuń na zawsze",
    "Kalıcı olarak sil", "Удалить навсегда",
    "الحذف نهائيًا", "حذف نهائي",
    "完全に削除", "영구 삭제", "영구삭제",
    "永久删除", "永久刪除"
  ]);

  // Exact whole-text matching for dialog button safety. Both the tokens
  // and the candidate text go through the same normalization (trim,
  // collapse whitespace, case-fold), so locale case quirks like the
  // Turkish dotted I stay consistent on both sides.
  const normalizeControlText = (text) =>
    (text || "").replace(/\s+/g, " ").trim().toLowerCase();

  const buildExactTokenMatcher = (tokens) => {
    const wanted = new Set(tokens.map(normalizeControlText));
    return (text) => wanted.has(normalizeControlText(text));
  };

  const isUnsubscribeLabel = buildExactTokenMatcher(UNSUBSCRIBE_TOKENS);
  const isUnsubCancelLabel = buildExactTokenMatcher(UNSUB_CANCEL_TOKENS);
  const isUnsubWebsiteLabel = buildExactTokenMatcher(UNSUB_WEBSITE_TOKENS);

  const isMoveToMenuLabel = buildExactTokenMatcher(MOVE_TO_TOKENS);
  const isInboxLabel = buildExactTokenMatcher(INBOX_TOKENS);

  // Deny check for the restore finders. Substring on normalized text so
  // a merged or suffixed label ("Delete forever (empty trash)") is
  // still refused; see DELETE_FOREVER_TOKENS for why over-matching is
  // fine here.
  const DELETE_FOREVER_NORMALIZED = Object.freeze(
    DELETE_FOREVER_TOKENS.map(normalizeControlText)
  );
  const isDeleteForeverLabel = (text) => {
    const norm = normalizeControlText(text);
    if (!norm) return false;
    return DELETE_FOREVER_NORMALIZED.some((token) => norm.includes(token));
  };

  // v3.3: throttling / temporary error tokens. 7.5 adds the major
  // locales so adaptive backoff engages off-English too. Detection-side
  // only (a false positive just slows the run down), but every entry
  // stays a phrase, never a lone common word. Stems are used where they
  // cover several polite endings of the same sentence.
  const RATE_LIMIT_TOKENS = Object.freeze([
    "too many requests",
    "try again later",
    "temporary problem",
    "please wait",
    "we're sorry",
    "were sorry",
    "something went wrong",
    "action could not be completed",
    "server error",
    "inténtalo de nuevo más tarde",
    "se ha producido un error",
    "demasiadas solicitudes",
    "réessayez plus tard",
    "une erreur s'est produite",
    "trop de requêtes",
    "es später erneut",
    "ein fehler ist aufgetreten",
    "zu viele anfragen",
    "tente novamente mais tarde",
    "ocorreu um erro",
    "muitas solicitações",
    "riprova più tardi",
    "si è verificato un errore",
    "troppe richieste",
    "probeer het later opnieuw",
    "er is iets misgegaan",
    "te veel verzoeken",
    "försök igen senare",
    "något gick fel",
    "prøv igen senere",
    "noget gik galt",
    "prøv på nytt senere",
    "noe gikk galt",
    "spróbuj ponownie później",
    "coś poszło nie tak",
    "zbyt wiele żądań",
    "daha sonra tekrar deneyin",
    "bir hata oluştu",
    "çok fazla istek",
    "повторите попытку позже",
    "произошла ошибка",
    "слишком много запросов",
    "حاول مرة أخرى",
    "حدث خطأ",
    "しばらくしてからもう一度",
    "エラーが発生しました",
    "リクエストが多すぎます",
    "나중에 다시 시도",
    "오류가 발생했습니다",
    "요청이 너무 많습니다",
    "请稍后再试",
    "出了点问题",
    "请求过多",
    "請稍後再試",
    "發生錯誤"
  ]);

  // 7.5: body-text discovery term for the subscription scan, keyed by
  // Gmail UI language. The English literal only matches mail that
  // contains the English word, so non-English mailboxes pick the term
  // their newsletters actually print. Recall-side only: a miss just
  // leaves discovery to the category: queries, exactly like before.
  const SUBSCRIPTION_SEARCH_TERMS = Object.freeze({
    en: "unsubscribe",
    es: "darse de baja",
    fr: "désabonner",
    de: "abbestellen",
    pt: "cancelar inscrição",
    it: "annulla iscrizione",
    nl: "afmelden",
    sv: "avsluta prenumeration",
    da: "frameld",
    no: "meld deg av",
    pl: "anuluj subskrypcję",
    tr: "listeden çık",
    ru: "отказаться от рассылки",
    ar: "إلغاء الاشتراك",
    ja: "配信停止",
    ko: "수신거부",
    zh: "退订"
  });

  // Gmail stamps its UI language on <html lang>. One term per run:
  // stacking every language into an OR query would blow past Gmail's
  // search-length limits for no recall gain on a single-language inbox.
  function getSubscriptionSearchTerm() {
    let lang = "";
    try {
      lang = (document.documentElement?.lang || "").toLowerCase();
    } catch {
      // Fall through to English.
    }
    if (lang === "zh-tw" || lang === "zh-hk") return "取消訂閱";
    const base = lang.split("-")[0];
    return SUBSCRIPTION_SEARCH_TERMS[base] || SUBSCRIPTION_SEARCH_TERMS.en;
  }

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

        case "gmailCleanerScanSubscriptions":
          debugLog("Received subscription scan message");
          startSubscriptionScan();
          sendResponse({ ok: true });
          break;

        case "gmailCleanerUnsubscribeSenders":
          debugLog("Received unsubscribe message", {
            count: Array.isArray(msg.senders) ? msg.senders.length : 0
          });
          startUnsubscribeRun(Array.isArray(msg.senders) ? msg.senders : []);
          sendResponse({ ok: true });
          break;

        case "gmailCleanerSkip":
          REVIEW_SIGNAL = "skip";
          sendResponse({ ok: true });
          break;

        case "gmailCleanerGuardProceed":
          GUARD_SIGNAL = "proceed";
          sendResponse({ ok: true });
          break;

        case "gmailCleanerGuardStop":
          GUARD_SIGNAL = "stop";
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
      "div[role='menu'] input[aria-label*='Label']",
      "div[role='menu'] input[type='text']",
      "input[aria-label*='Label as']",
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
    ],
    // 7.0 subscriptions: the subject cell is the safest click target to
    // open a conversation from the list (the sender cell can trigger the
    // hover card, and the checkbox cell toggles selection instead).
    subjectCell: [
      "td.xY.a4W",
      "td.a4W"
    ],
    // Signals that a conversation is open in reading view.
    messageOpen: [
      "div[role='main'] h2.hP",
      "div[role='main'] div.adn",
      "div[role='main'] div.ha"
    ],
    // Gmail's native header Unsubscribe control (rendered next to the
    // sender for mail with List-Unsubscribe). span.Ca carries
    // role='link' and the literal text "Unsubscribe" on current Gmail.
    headerUnsubscribe: [
      "div[role='main'] span.Ca"
    ],
    // Message body container: unsubscribe links inside it belong to the
    // sender, not Gmail, and must never be driven by the engine.
    messageBody: "div.a3s"
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

    // Per-row selection first: clicking each row's own checkbox is what
    // populates Gmail's internal selection model, which the Delete
    // handler reads. A single click on the master checkbox only paints
    // the visual checked state on current Gmail builds, so rows look
    // selected (extractSelectedCount reports a number) while Gmail's
    // model stays empty and Delete is a no-op. Rows are unchecked right
    // after a search, so per-row clicks land as real selections. Fall
    // through to the master only when this finds nothing to click.
    const perRowCount = await selectAllVisibleRowsIndividually();
    if (perRowCount > 0) {
      safeSend({ phase: "debug", detail: `Selected ${perRowCount} rows individually` });
      return { success: true, reason: "per-row" };
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

    // The "select all matching" link only ever lives in the selection
    // banner, never in the conversation rows. Scanning the whole list
    // root walks thousands of spans and calls getComputedStyle on every
    // text match, which thrashes layout for tens of seconds on a large
    // result page. Restrict the scan to the banner areas; if those
    // selectors miss, the specific-selector fallback below still runs,
    // and a genuine miss just means we delete the visible page per pass.
    const searchRoots = bannerAreas;

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
      // Closure link: needs the real pointer/mouse sequence, not .click().
      fireMouseSequence(link);

      await sleep(TIMING.SELECT_ALL_SETTLE_DELAY);

      // Verify selection increased
      const countAfter = extractSelectedCount();
      debugLog("After select all conversations click", { countBefore, countAfter });

      // 7.15: the strongest signal is also the only language-independent
      // one. Gmail offers "select all N that match this search" while a
      // single page is selected and withdraws it the moment the whole
      // match set is selected, so the link we just clicked being gone is
      // proof it took effect. The text indicator below is English-shaped
      // and silently reported "page only" on every other locale, which
      // sized the soft cap and the huge-run confirm against ~50 rows
      // while Gmail deleted the entire result set.
      const linkConsumed = !findSelectAllConversationsLink();
      if (linkConsumed) {
        safeSend({
          phase: "debug",
          detail: "Bulk selection verified: the select-all-matching link is gone"
        });
        return { success: true, reason: "link-consumed", countBefore, countAfter };
      }

      // Check if we see "All conversations selected" or similar indicator
      const allSelectedIndicator = findAllConversationsSelectedIndicator();

      if (allSelectedIndicator) {
        safeSend({
          phase: "debug",
          detail: "Bulk selection verified via 'all selected' indicator"
        });
        return { success: true, reason: "all-selected-indicator", countBefore, countAfter };
      }

      if (countAfter !== null && countBefore !== null && countAfter > countBefore) {
        safeSend({
          phase: "debug",
          detail: `Bulk selection successful: ${countBefore} → ${countAfter}`
        });
        return { success: true, reason: "count-increased", countBefore, countAfter };
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
  // The confirm button inside a dialog, matched EXACTLY against the
  // localized token table. Doubles as the structural test for "is this
  // the bulk confirmation dialog": Gmail only puts an OK/Confirm control
  // on a dialog that is waiting for exactly that.
  function findBulkConfirmButton(dialog) {
    const buttons = qsa("button, div[role='button']", dialog);
    for (const btn of buttons) {
      const lowerText = getTextContent(btn).toLowerCase();
      const name = getAttr(btn, "name").toLowerCase();
      const isConfirmButton = CONFIRM_TOKENS.some(token =>
        lowerText === token.toLowerCase() || name === token.toLowerCase()
      );
      if (isConfirmButton) return btn;
    }
    return null;
  }

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
          // 7.15: the phrases above are English, so on every other locale
          // the dialog was never found, the wait timed out, the bulk
          // action stayed unconfirmed and the whole pass silently did
          // nothing. The button tokens were already localized, so accept
          // any dialog that carries one: it is the same structure-first
          // rule the unsubscribe path uses, and an exact token match on a
          // confirm control is a tighter test than the prose ever was.
          if (findBulkConfirmButton(d)) return d;
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

    const confirmBtn = findBulkConfirmButton(dialog);
    if (confirmBtn) {
      try {
        const text = getTextContent(confirmBtn);
        fireMouseSequence(confirmBtn);
        await sleep(TIMING.DOM_SETTLE_DELAY);
        debugLog("Clicked OK on bulk confirmation dialog", { buttonText: text });
        safeSend({ phase: "debug", detail: "Confirmed bulk action dialog" });
        return true;
      } catch (e) {
        debugLog("Failed to click confirmation button", { error: e?.message });
      }
    }

    const primaryBtn = qs("button[name='ok'], button.J-at1-auR", dialog);
    if (primaryBtn) {
      try {
        fireMouseSequence(primaryBtn);
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

  /**
   * Drop any rule that targets protected mail, log it, and tell the user.
   * Shared by the stored intensity lists and custom rules so the engine
   * boundary refuses the same strings wherever they came from.
   * @param {string[]} rules
   * @param {string} kind
   * @returns {string[]}
   */
  function refuseDangerousRules(rules, kind) {
    const kept = [];
    for (const raw of rules) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (queryHasDangerousToken(trimmed)) {
        debugLog(`Refusing dangerous ${kind}`, { query: trimmed });
        safeSend({
          phase: "debug",
          detail: `${kind === "rule" ? "Rule" : "Custom rule"} skipped (targets protected mail): ${trimmed}`
        });
        continue;
      }
      kept.push(trimmed);
    }
    return kept;
  }

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
        // Make a mutable copy of the rule set.
        //
        // 7.15: the stored intensity lists get the SAME refusal as custom
        // rules and target presets. They are free-text areas on the
        // Options page whose save path never asked validateGmailQuery,
        // and it saves even when validation fails, so "is:starred
        // older_than:1y" typed into the Normal box reached the engine
        // unfiltered. applyGlobalGuards then skipped adding -is:starred
        // because the token was already in the query, and a year of
        // starred mail went to Trash with both protections down.
        const set = refuseDangerousRules(
          [...(allRules[intensity] ?? allRules.normal ?? DEFAULT_RULES.normal)],
          "rule"
        );

        // Load and merge custom rules BEFORE applying safe mode filter
        try {
          const customResult = await new Promise((resolve) => {
            chrome.storage.sync.get("customRules", resolve);
          });
          const customRules = customResult?.customRules || [];
          for (const cr of customRules) {
            if (!cr.query || typeof cr.query !== "string") continue;
            const trimmed = cr.query.trim();

            // 7.15: honour the per-rule Action the Options page saves and
            // shows as a chip. The rule set was merged by QUERY only, so
            // the action was dropped and every custom rule ran with the
            // run's action: a rule the user set to "Label only" or
            // "Archive" was deleting their mail, which is the opposite of
            // what the page told them it would do.
            //
            // A run cannot change action per rule, so the rule is skipped
            // rather than executed as something more destructive than it
            // asks for. A delete rule still runs in an archive run, which
            // is gentler than requested and therefore always safe.
            const ruleAction = typeof cr.action === "string" ? cr.action : "delete";
            const canHonour = ruleAction === "delete"
              || (ruleAction === "archive" && CONFIG.archiveInsteadOfDelete);
            if (!canHonour) {
              debugLog("Skipping custom rule the run cannot honour", { query: trimmed, ruleAction });
              safeSend({
                phase: "debug",
                detail: ruleAction === "label"
                  ? `Custom rule skipped (set to "Label only", which a cleanup run does not do): ${trimmed}`
                  : `Custom rule skipped (set to "Archive"; run this cleanup in Archive mode to use it): ${trimmed}`
              });
              continue;
            }
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

  // Gmail's relative-age units, as the approximate day counts Gmail itself
  // uses. Only needed to rank two ages against each other, so the rounding
  // in "m" and "y" is not material.
  const AGE_UNIT_DAYS = Object.freeze({ d: 1, w: 7, m: 30, y: 365 });

  /**
   * "6m" -> 180. Null when the value is not an age Gmail would accept.
   * @param {string} raw
   * @returns {number | null}
   */
  function ageTokenToDays(raw) {
    const parsed = /^(\d+)\s*([dwmy])$/i.exec(String(raw || "").trim());
    if (!parsed) return null;
    const n = parseInt(parsed[1], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n * AGE_UNIT_DAYS[parsed[2].toLowerCase()];
  }

  /**
   * The strictest (oldest) `older_than:` a query already carries, in days.
   * @param {string} query
   * @returns {number | null}
   */
  function strictestOlderThanDays(query) {
    // Only a positive age describes what the rule keeps. A negated
    // `-older_than:6m` means "newer than 6m", so counting it as the rule's
    // own floor would suppress a stricter global floor that belongs there.
    const re = /(?:^|[\s(])older_than:(\d+\s*[dwmy])/gi;
    let strictest = null;
    let match;
    while ((match = re.exec(String(query || ""))) !== null) {
      const days = ageTokenToDays(match[1]);
      if (days !== null && (strictest === null || days > strictest)) strictest = days;
    }
    return strictest;
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

    // Minimum Age is a floor the user set ("only clean mail older than
    // this"), so it has to beat a rule that asks for less. Testing whether
    // the query merely mentions older_than made the setting a no-op on the
    // entire stock rule set, because every built-in rule carries one. Now
    // it is appended whenever it is genuinely stricter than the rule's own
    // age; a looser floor is dropped so it can never relax a tight rule.
    if (CONFIG.minAge) {
      const ruleDays = strictestOlderThanDays(parts[0]);
      const floorDays = ageTokenToDays(CONFIG.minAge);
      if (ruleDays === null || (floorDays !== null && floorDays > ruleDays)) {
        parts.push(`older_than:${CONFIG.minAge}`);
      }
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
        // 7.15: `*@domain.com` is a shape the Options page documents and
        // accepts, and Smart Suggestions already reads it as "the whole
        // domain". The query builder used to emit it verbatim, but Gmail
        // has no wildcard in `from:`, so `-from:*@bank.com` excluded
        // nothing and the most important safety setting in the extension
        // silently protected no one. `from:bank.com` is Gmail's own
        // domain form and is what the user meant.
        const wildcardDomain = /^\*@(.+)$/.exec(trimmed);
        parts.push(`-from:${wildcardDomain ? wildcardDomain[1] : trimmed}`);
      }
    }

    // 6.1: global protected-keyword shield. Appended as its own
    // `-subject:( ... )` clause; it ANDs with any Safe-Mode subject guard
    // (both narrow the match), so the two coexisting is correct.
    if (Array.isArray(CONFIG.protectKeywords) && CONFIG.protectKeywords.length > 0) {
      const exclusion = buildSubjectExclusion(CONFIG.protectKeywords);
      if (exclusion) parts.push(exclusion);
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

    // Identity of the result list currently on screen, captured BEFORE we
    // navigate. Gmail swaps search results in place on a hash change and
    // leaves the previous query's rows painted for a beat, so "the grid
    // has rows" is true on the very first frame and is NOT proof the new
    // query loaded. The old check returned on those leftover rows, so the
    // engine acted on a stale / mid-transition page: every query resolved
    // in well under a second and selected nothing. We compare against this
    // signature to wait until the list has actually turned over.
    const listSignature = () => {
      const main = qs(SELECTORS.main);
      const grid = main ? qs(SELECTORS.grid, main) : null;
      const rows = grid ? qsa('tr[role="row"]', grid) : [];
      const first = rows[0];
      const id = first
        ? (first.getAttribute("data-legacy-thread-id")
            || first.getAttribute("id")
            || getTextContent(first).slice(0, 60))
        : "";
      return { count: rows.length, id };
    };
    const before = listSignature();

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

    // Let Gmail begin tearing down the previous result set before we start
    // sampling, so the poll below doesn't latch onto the stale rows still
    // on screen for the first frame after the hash change.
    await sleep(TIMING.SEARCH_TRANSITION_DELAY);

    let lastSig = null;
    let stableTicks = 0;

    // Accept the page as loaded when, after the transition delay:
    //  - Gmail's empty-state container (td.TC) is present (zero matches), or
    //  - the grid shows data rows AND the list has stopped changing. A list
    //    that turned over from the previous query (different first row or
    //    row count) settles after one stable tick; one that still looks
    //    identical to the previous query (overlapping same-category rules,
    //    or Gmail slow to transition) needs a longer stable streak so we
    //    never mistake un-cleared stale rows for the freshly loaded set.
    //    `td.TC` keeps legitimately-empty queries (common once the global
    //    guards strip starred / important / unread / user-labeled mail)
    //    resolving immediately instead of timing out.
    const ok = await waitFor(
      () => {
        const main = qs(SELECTORS.main);
        if (!main) return false;

        if (qs("td.TC", main)) return true;

        const grid = qs(SELECTORS.grid, main);
        if (!grid) return false;

        const sig = listSignature();
        if (sig.count === 0) {
          lastSig = sig;
          stableTicks = 0;
          return false;
        }

        const stable = lastSig && sig.id === lastSig.id && sig.count === lastSig.count;
        stableTicks = stable ? stableTicks + 1 : 0;
        lastSig = sig;

        const turnedOver = sig.id !== before.id || sig.count !== before.count;
        if (turnedOver) return stableTicks >= 1;
        return stableTicks >= 3;
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

  // Gmail's toolbar action controls (Delete, Archive, the bulk-confirm
  // dialog buttons, the "select all matching" link, the overflow menu)
  // are Closure widgets that react to a real pointer/mouse press, not to
  // a synthetic element.click(). A plain .click() flips nothing in their
  // handlers, so the action is a silent no-op: that is the root cause of
  // the "selects rows but never deletes" bug (verified on the live 2026
  // Gmail DOM: selecting a row works via .click(), but clicking Delete
  // the same way does nothing, while a full pointerdown/mousedown/
  // mouseup/click sequence does move the message to Trash). Row
  // checkboxes deliberately keep their plain .click(); they respond to
  // the click event, and adding mousedown there can toggle twice and
  // cancel the selection.
  function fireMouseSequence(el) {
    if (!el) return false;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      rect = { left: 0, top: 0, width: 0, height: 0 };
    }
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0
    };
    const PointerCtor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    const pointerBits = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    const send = (type, Ctor, extra) => {
      try {
        el.dispatchEvent(new Ctor(type, { ...base, ...extra }));
      } catch (e) {
        debugLog("fireMouseSequence event failed", { type, error: e?.message });
      }
    };
    send("pointerdown", PointerCtor, { ...pointerBits, buttons: 1 });
    send("mousedown", MouseEvent, { buttons: 1 });
    send("pointerup", PointerCtor, { ...pointerBits, buttons: 0 });
    send("mouseup", MouseEvent, { buttons: 0 });
    send("click", MouseEvent, { buttons: 0 });
    return true;
  }

  // Dispatch hover events so Gmail opens a hover-driven submenu. The
  // "Label as" entry in the overflow menu is a submenu (aria-haspopup),
  // not a direct control, so it expands on pointer-over rather than a
  // click. This is the pointer-over half of a real mouse interaction.
  function hoverElement(el) {
    if (!el) return;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      rect = { left: 0, top: 0, width: 0, height: 0 };
    }
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    const PointerCtor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    const send = (type, Ctor, extra) => {
      try {
        el.dispatchEvent(new Ctor(type, { ...base, ...extra }));
      } catch (e) {
        debugLog("hoverElement event failed", { type, error: e?.message });
      }
    };
    send("pointerover", PointerCtor, { pointerId: 1, pointerType: "mouse", isPrimary: true });
    send("mouseover", MouseEvent, {});
    send("mouseenter", MouseEvent, {});
    send("mousemove", MouseEvent, {});
  }

  function isElementVisible(el) {
    if (!el) return false;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      return false;
    }
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  // Find the visible Gmail menu with the most menu items. Gmail keeps
  // several hidden role=menu nodes in the DOM (help menu, hover menus),
  // so the first match is often the wrong one; we want the menu actually
  // on screen, which is the overflow action menu we just opened.
  function findVisibleMenu() {
    const menus = qsa("div[role='menu']").filter(isElementVisible);
    menus.sort(
      (a, b) =>
        qsa("[role^='menuitem']", b).length - qsa("[role^='menuitem']", a).length
    );
    return menus[0] || null;
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
        fireMouseSequence(btn);
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
        fireMouseSequence(btn);
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
      try { fireMouseSequence(direct); } catch (e) { debugLog("Direct label click threw", { error: e?.message }); }
      const input = await getInput();
      if (input) return input;
    }

    const more = findMoreOptionsButton();
    if (more) {
      try { fireMouseSequence(more); } catch (e) { debugLog("More-options click threw", { error: e?.message }); }
      // Resolve the menu that actually opened on screen, not the first
      // (often hidden) role=menu in the DOM.
      const menu = await waitFor(findVisibleMenu, {
        timeout: TIMING.LABEL_DIALOG_TIMEOUT,
        interval: 80,
        description: "overflow menu"
      });
      if (menu) {
        const item = findLabelMenuItemIn(menu);
        if (item) {
          // "Label as" is a hover submenu on current Gmail, not a direct
          // control, so expand it by hovering and then look for the
          // label search/create input inside.
          hoverElement(item);
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
    const hotkeyInput = await getInput();
    if (hotkeyInput) return hotkeyInput;

    // 7.4 hard layout signal: no Labels button, no "More email options"
    // overflow menu, and the hotkey went nowhere. Tag-before-delete has
    // no way in at all, which reads as Gmail restructuring its toolbar,
    // not a one-off flake (those leave the More button findable).
    if (!direct && !more) {
      throw new GmailLayoutError(layoutChangedMessage(
        "the More email options menu is missing, so mail cannot be tagged before it is moved"
      ));
    }
    return null;
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

  // Digit-group separators Gmail uses across locales: comma (en), full
  // stop (de/es/pt) and space (fr/ru). JavaScript's \s already covers the
  // non-breaking and narrow no-break spaces those builds emit.
  const COUNT_SEPARATORS = /[,.\s]/g;

  function digitsToCount(raw) {
    const n = parseInt(String(raw || "").replace(COUNT_SEPARATORS, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // The pagination string is always a range plus a total, in one order or
  // the other: "1-50 of 3,200" (en), "1-50 von 3.200" (de),
  // "1-50 sur 3 200" (fr), and the same in reverse order in ko/zh.
  // Anything longer than a short label is a container's concatenated
  // text, not the counter.
  const MAX_COUNTER_TEXT_LENGTH = 60;
  const COUNT_RANGE_RE = /(\d[\d,.\s]*?)\s*[-\u2013\u2014~\uff5e]\s*(\d[\d,.\s]*)/;
  const COUNT_NUMBER_RE = /\d[\d,.\s]*/g;

  /**
   * Total results behind Gmail's "showing X of Y" counter.
   *
   * 7.15: the English-only reading was a safety hole, not a cosmetic gap.
   * Every guardrail that stops a runaway bulk delete is sized against
   * this number, so on a German or Japanese Gmail the soft cap and the
   * huge-run confirm were measured against the ~50 rows in the viewport
   * instead of the real match set. The structural pass below reads the
   * counter without knowing the word for "of": find the "1-50" range,
   * then take the remaining number when it is at least the end of that
   * range. Locale order does not matter, so ko/zh (total first) work too.
   * @param {string} text
   * @returns {number | null}
   */
  function parseCountFromText(text) {
    if (!text || typeof text !== "string") return null;

    // "about" sits between "of" and the number on estimated totals
    // ("1-50 of about 3,200"). Without the optional group the digits
    // never start where the pattern expects them and the whole estimate
    // comes back null, so the caller silently falls back to the row
    // count for the current page.
    // Guard applies to EVERY branch now, not just the range one. The
    // counter's own node is short; anything long is an ancestor whose
    // concatenated text happens to contain the word "of".
    if (text.length > MAX_COUNTER_TEXT_LENGTH) return null;

    const ofMatch = text.match(/\bof\s+(?:about\s+)?([\d,.\s]+)/i);
    if (ofMatch) {
      const n = digitsToCount(ofMatch[1]);
      if (n !== null) return n;
    }

    const aboutMatch = text.match(/\babout\s+([\d,.\s]+)\s+results/i);
    if (aboutMatch) {
      const n = digitsToCount(aboutMatch[1]);
      if (n !== null) return n;
    }

    if (text.length > MAX_COUNTER_TEXT_LENGTH) return null;

    const range = COUNT_RANGE_RE.exec(text);
    if (!range) return null;
    const rangeStart = digitsToCount(range[1]);
    const rangeEnd = digitsToCount(range[2]);
    if (rangeStart === null || rangeEnd === null || rangeStart > rangeEnd) return null;

    // Everything outside the matched range is a candidate total. Taking
    // the largest keeps a stray page number from winning, and requiring
    // it to reach the end of the range rejects text that merely happens
    // to carry a dash and some digits.
    const rest = text.slice(0, range.index) + " " + text.slice(range.index + range[0].length);
    let best = null;
    let m;
    COUNT_NUMBER_RE.lastIndex = 0;
    while ((m = COUNT_NUMBER_RE.exec(rest)) !== null) {
      const n = digitsToCount(m[0]);
      if (n !== null && n >= rangeEnd && (best === null || n > best)) best = n;
    }
    return best;
  }

  // 8.3: this only ever searched div[role="main"], and Gmail renders the
  // "1-50 of 1,234" counter in the TOOLBAR, outside that element. So on a
  // normal result page the total was never found, and every caller fell
  // back to getGridRowCount(): one page, fifty rows. That is why the
  // Mailbox Report showed 50 against band after band on a mailbox holding
  // tens of thousands of messages, and why the guardrails that size a run
  // were reading a page instead of a match set. Search main first, then
  // the toolbar, then the document.
  function estimateTotalResults() {
    const scopes = [];
    const main = qs(SELECTORS.main);
    if (main) scopes.push(main);
    const toolbar = findToolbarRoot();
    if (toolbar) scopes.push(toolbar);
    scopes.push(document);

    const seen = new Set();
    for (const scope of scopes) {
      if (!scope || seen.has(scope)) continue;
      seen.add(scope);
      for (const el of qsa("span, div", scope)) {
        const count = parseCountFromText(getTextContent(el));
        if (count !== null) return count;
      }
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
      // 7.4 hard layout signal: result rows are on screen but neither
      // the per-row checkboxes nor the master select-all exist. That is
      // not "nothing matched" (hasNoResults returned above for that);
      // it is Gmail's list markup changing under us.
      if (checkboxResult.reason === "not-found" && (getGridRowCount() ?? 0) > 0) {
        throw new GmailLayoutError(layoutChangedMessage(
          "search results are on screen but the select-all checkbox is missing, so nothing can be selected"
        ));
      }
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
      // "link-consumed" is the same fact observed structurally, which is
      // the only form of it that survives a non-English Gmail.
      bulkAllSelected =
        selectAllResult.reason === "link-consumed" ||
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

    // 7.14.2: extractSelectedCount reports the selected rows in the
    // viewport (`tr.x7`), which is one page. Once "select all N
    // conversations" is confirmed, Gmail acts on every match instead, so
    // measuring the page would let a 40,000-conversation sweep sail past
    // guardrails sized for it. Capture the match total here, before the
    // action clears the "of N" text that carries it.
    const matchTotal = bulkSelected ? estimateTotalResults() : null;
    const effectiveCount = bulkAllSelected
      ? Math.max(matchTotal ?? 0, selectedCount ?? 0)
      : selectedCount;

    // 7.15: guardrails and the affected count answer two different
    // questions and must not share one figure. Booking stays honest and
    // only claims the match total once bulk-all is actually confirmed.
    // The guardrails ask "how much could this click touch", so the
    // moment the select-all-matching link has been CLICKED the answer is
    // the match total, verified or not: an unverifiable bulk selection
    // that turns out to be real would otherwise walk straight past the
    // soft cap and the huge-run confirm on a viewport-sized count.
    const guardrailCount = bulkSelected
      ? Math.max(matchTotal ?? 0, effectiveCount ?? 0)
      : effectiveCount;

    // Run-level soft cap guardrail
    if (!CONFIG.dryRun) {
      const projectedTotal = liveRunProcessedSoFar + (guardrailCount ?? 0);

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

        const confirmed = await askGuardrail({
          kind: "softCap",
          count: projectedTotal,
          actionWord
        });

        if (!confirmed) {
          debugLog("User cancelled at soft cap confirmation", { projectedTotal });
          // 8.0: this used to end the query and let the run carry on to
          // the next rule. The old confirm() said "Continue anyway?",
          // which was vague enough to survive that; the new dialog's
          // safe choice is labelled "Stop the run" and promises that
          // stopping leaves everything untouched, so it has to. The
          // guardrail is a judgment about the whole run (the matching
          // consent, GCC_CONFIRMED_SOFT_CAP, is run-scoped too), and a
          // timeout takes this path as well, where continuing would be
          // the worst possible reading of silence.
          CANCELLED = true;
          throw new CancellationError("Run stopped at the large-run guardrail");
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
        // 7.4: a layout-change signal is not a skippable tag hiccup;
        // deleting without the promised tag safety net is exactly the
        // silent breakage it exists to stop. Let it end the run before
        // this selection is acted on.
        if (e instanceof GmailLayoutError) throw e;
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
      // Dry Run is the safe preview, so it has to quote the same figure a
      // live run would act on. Using the viewport count here reported ~50
      // for a confirmed "all 12,400 conversations" batch.
      const estimated = guardrailCount ?? estimateTotalResults() ?? 0;
      debugLog("Dry run page estimate", { estimated, bulkSelected });
      return { deleted: false, count: estimated, reason: "dry-run", bulkSelected };
    }

    const estimatedTotal = guardrailCount ?? estimateTotalResults();

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

      const confirmed = await askGuardrail({
        kind: "hugeRun",
        count: estimatedTotal,
        actionWord: "delete"
      });

      if (!confirmed) {
        debugLog("User cancelled at huge-run confirmation", { estimatedTotal });
        // Same reasoning as the soft cap above: the dialog offers to
        // stop the run, so declining stops the run.
        CANCELLED = true;
        throw new CancellationError("Run stopped at the huge-run guardrail");
      }

      window.GCC_CONFIRMED_HUGE = true;
    }

    // Large single batch suggests the rule matched far more than
    // expected. We don't block here (the soft-cap / huge-run gates do
    // that) but we DO warn and sample so the user can review afterwards.
    // Measured against the guardrail figure, not the viewport: Gmail
    // pages at most 100 rows, so comparing the selected-row count with a
    // 2,000 threshold meant this warning could never fire, least of all
    // on the bulk-all sweeps it exists for.
    if ((guardrailCount ?? 0) > GUARDRAILS.LARGE_BATCH_WARN_THRESHOLD) {
      safeSend({
        phase: "warning",
        status: `Large batch detected (${(guardrailCount ?? 0).toLocaleString()})`,
        detail: "Sampling senders before action so you can review afterwards.",
      });
    }

    const countBeforeAction = extractSelectedCount();
    const rowsBeforeAction = getGridRowCount();
    // The bulk-all match total lives in matchTotal, captured with the
    // selection above: once Gmail acts, its "of N" results count is gone
    // and the figure cannot be recovered.
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

    // Last chance to honour Cancel. The per-query loops check it, but the
    // stretch between selecting a page and clicking Delete covers tagging,
    // an optional confirm() and several settle sleeps -- easily tens of
    // seconds, and the user who cancels in there expects nothing to move.
    // The batch may already carry its recovery label by now; that is inert
    // and gets reused if the same mail is cleaned later.
    //
    // This throws rather than returning a no-op result: a plain return
    // reads to processQuery as "nothing to act on", and on a single-rule
    // run (every Storage X-ray purge and Smart apply is one rule) the loop
    // would then fall through to the success summary and report a cancelled
    // run as finished.
    if (CANCELLED) {
      debugLog("Cancelled before action click");
      throw new CancellationError("Run cancelled before the action fired");
    }

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
      // The match total is the only figure that describes a bulk-all
      // action; selectedCount is the viewport and would undercount by
      // orders of magnitude, dragging liveRunProcessedSoFar (and so the
      // soft cap) down with it. effectiveCount is the same figure the
      // guardrails were measured against, so a misparsed "of N" smaller
      // than the visible selection cannot make the books worse than the
      // viewport count either.
      affectedCount = effectiveCount || rowsBeforeAction || 0;
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
    perQuery: [],
    // 8.0: every label this run actually applied, so the completion
    // screen can show the user what their mail was tagged with instead
    // of only promising that it was.
    tagLabels: []
  };

  function resetStats() {
    stats.totalDeleted = 0;
    stats.totalWouldDelete = 0;
    stats.totalFreedMb = 0;
    stats.perQuery = [];
    stats.tagLabels = [];
  }

  // 8.0: the two big-run guardrails used to be native confirm() calls
  // raised inside the Gmail tab, which every run path had just pushed
  // into the background by focusing the progress dashboard. The last
  // line of defence against a 20,000-message mistake was a dialog on a
  // tab nobody was looking at, and it blocked Gmail's JS while it
  // waited (which is what made a "healthy engine stops answering pings"
  // bug possible in 7.14). The question now goes to the progress page,
  // on its own signal so a stale review answer can never confirm a
  // destructive run. No answer means no run: the timeout declines.
  async function askGuardrail({ kind, count, actionWord }) {
    if (!hasChromeRuntime()) {
      // No extension messaging (unit fixtures, or a torn-down context).
      // Keep the original behaviour rather than silently proceeding.
      return confirm(
        `Gmail Cleaner: this run is about to ${actionWord} about ${count.toLocaleString()} conversations.\n\nContinue anyway?`
      );
    }

    GUARD_SIGNAL = null;

    safeSendImmediate({
      phase: "guardrail",
      status: "Waiting for your confirmation",
      detail: `This run would ${actionWord} about ${count.toLocaleString()} conversations.`,
      guardKind: kind,
      guardCount: count
    });

    safeSendImmediate({
      type: "gmailCleanerRequestGuardrail",
      guardKind: kind,
      count,
      actionWord
    });

    const start = Date.now();
    while (!GUARD_SIGNAL && !CANCELLED) {
      if (Date.now() - start > GUARDRAILS.GUARD_RESPONSE_TIMEOUT_MS) {
        safeSend({
          phase: "warning",
          status: "No confirmation received; stopping.",
          detail: "A run this large needs an explicit confirm, so nothing was touched."
        });
        return false;
      }
      await sleep(TIMING.REVIEW_POLL_INTERVAL);
    }

    return GUARD_SIGNAL === "proceed";
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
    if (tagLabel && !stats.tagLabels.includes(tagLabel)) stats.tagLabels.push(tagLabel);
    const guardedQuery = applyGlobalGuards(query);
    const start = Date.now();
    let pass = 0;
    let queryDeletedCount = 0;
    let hasReviewedThisQuery = false;

    // Each query is a fresh selection context. Reset the master-checkbox
    // double-click guard so a fast-completing previous query cannot block
    // this query's first checkbox click; the 500ms guard only needs to
    // stop rapid re-clicks within one selection, not across queries.
    lastMasterCheckboxClickTime = 0;

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
                  // 8.0: the worker merges passes of the same rule in
                  // the same run into one log entry, and this is what
                  // identifies "the same run".
                  runId: CONFIG.runId || "",
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

      // The pass cap is the only way out of the loop that records
      // nothing: every other exit returns after recordQueryStats. A rule
      // with more mail than 150 passes can clear therefore vanished from
      // the run summary entirely, and the user was never told the rule
      // had stopped short rather than finished.
      safeSend({
        phase: "warning",
        status: `${label} stopped at the pass limit`,
        detail: `Cleared ${queryDeletedCount.toLocaleString()} so far; run the cleaner again to continue this rule.`
      });
      recordQueryStats({
        query,
        label,
        count: queryDeletedCount,
        mode: CONFIG.dryRun ? "dry" : "live",
        durationMs: Date.now() - start
      });
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

  /**
   * The synced copy of a run summary, with the raw Gmail queries removed.
   *
   * 7.15: lastRunStats goes to chrome.storage.SYNC, which Chrome and
   * Firefox replicate to the signed-in account. `perQuery[].query` is the
   * literal search string, and for a Storage X-ray purge or a Smart
   * apply that string is a list of sender addresses harvested from the
   * user's own mailbox, so every one of those runs quietly shipped third
   * party addresses off the device and contradicted the published claim
   * that scanned addresses stay local. Nothing renders the query (the
   * Diagnostics card reads counts and links only), and dropping it also
   * keeps a long run under the 8KB per-item sync quota.
   * @param {any} doneStats
   */
  function stripQueriesForSync(doneStats) {
    if (!doneStats || typeof doneStats !== "object") return doneStats;
    const perQuery = Array.isArray(doneStats.perQuery)
      ? doneStats.perQuery.map((entry) => ({
        label: entry?.label,
        count: entry?.count,
        mode: entry?.mode,
        durationMs: entry?.durationMs
      }))
      : doneStats.perQuery;
    return { ...doneStats, perQuery };
  }

  async function saveLastRunStats(doneStats) {
    if (!hasChromeStorage("sync")) return;

    try {
      await new Promise((resolve) => {
        chrome.storage.sync.set({ lastRunStats: stripQueriesForSync(doneStats) }, resolve);
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
      tagLabels: [...stats.tagLabels],
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

  // =========================
  // Subscriptions: scan + bulk unsubscribe (7.0)
  // =========================
  // Scan (free): sample the senders behind Gmail's subscription-style
  // mail so the popup can show "who is filling this mailbox".
  // Unsubscribe (Pro-gated in the popup): for each chosen sender, open
  // one of their messages and drive Gmail's own header Unsubscribe
  // control plus its confirmation dialog. The engine never touches
  // unsubscribe links inside message bodies; those belong to the sender
  // and can point anywhere.

  const SUBSCRIPTIONS = Object.freeze({
    MAX_SENDERS: 200,
    MAX_UNSUB_PER_RUN: 25,
    ROW_SAMPLE_CAP: 100,
    OPEN_MESSAGE_TIMEOUT: 12000,
    UNSUB_DIALOG_TIMEOUT: 5000,
    DIALOG_CLOSE_TIMEOUT: 4000,
    BETWEEN_SENDERS_MS: 1200
  });

  // The three discovery searches. Query 1 carries the localized
  // body-text term (7.5); the two category: queries are byte-identical
  // to 7.0 and keep their recall on any mailbox.
  function buildSubscriptionScanQueries() {
    return [
      `"${getSubscriptionSearchTerm()}" newer_than:1y`,
      "category:promotions newer_than:1y",
      "category:updates \"unsubscribe\" newer_than:1y"
    ];
  }

  // One entry per visible row (deliberately not deduped: the duplicate
  // count is the volume signal the popup ranks senders by).
  function sampleSubscriptionRows({ cap = SUBSCRIPTIONS.ROW_SAMPLE_CAP } = {}) {
    const out = [];
    try {
      const rows = qsa('tr[role="row"]', getMainRoot());
      const limit = Math.min(rows.length, cap);
      for (let i = 0; i < limit; i++) {
        const senderEl =
          rows[i].querySelector("span[email]") ||
          rows[i].querySelector("[email]");
        if (!senderEl) continue;
        const email = getAttr(senderEl, "email").toLowerCase();
        if (!email || !email.includes("@")) continue;
        out.push({
          email,
          name: getAttr(senderEl, "name") || getTextContent(senderEl)
        });
      }
    } catch (e) {
      debugLog("sampleSubscriptionRows failed", { error: e?.message });
    }
    return out;
  }

  // Strict email shape doubles as query-injection protection: anything
  // that passes cannot break out of the from:(...) group it is placed in.
  function sanitizeSenderList(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of input) {
      if (typeof raw !== "string") continue;
      const email = raw.trim().toLowerCase();
      if (email.length > 320) continue;
      if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      out.push(email);
      if (out.length >= SUBSCRIPTIONS.MAX_UNSUB_PER_RUN) break;
    }
    return out;
  }

  // Gmail's native header Unsubscribe control in an open conversation.
  // Primary: span.Ca (role=link), trusted structurally since 7.5: Gmail
  // renders that class on the header control in every UI language, and
  // the old English text check vetoed it on every non-English account.
  // Fallback: any link/button in the reading view whose whole text is
  // one of the localized unsubscribe labels. Both paths refuse hits
  // inside the message body (sender-controlled markup) and inside list
  // rows (inline row actions).
  function findHeaderUnsubscribeControl() {
    const main = getMainRoot();
    for (const el of qsa(SELECTORS.headerUnsubscribe.join(", "), main)) {
      if (el.closest(SELECTORS.messageBody)) continue;
      if (el.closest('tr[role="row"]')) continue;
      return el;
    }
    for (const el of qsa('[role="link"], [role="button"]', main)) {
      if (!isUnsubscribeLabel(getTextContent(el))) continue;
      if (el.closest(SELECTORS.messageBody)) continue;
      if (el.closest('tr[role="row"]')) continue;
      return el;
    }
    return null;
  }

  // Classify the confirmation dialog. Gmail shows either a direct
  // confirm (Cancel / Unsubscribe buttons) or, for senders without
  // one-click support, a "go to website" hand-off that a bulk run must
  // not follow. 7.5: classification runs on the localized token tables,
  // exact whole text only. A button that matches nothing leaves the
  // dialog "unknown", and unknown dialogs are dismissed, never clicked.
  function resolveUnsubscribeDialog(dlg) {
    const result = { confirmBtn: null, cancelBtn: null, kind: "unknown" };
    if (!dlg) return result;
    for (const btn of qsa('button, [role="button"]', dlg)) {
      const text = getTextContent(btn);
      if (isUnsubscribeLabel(text)) {
        result.confirmBtn = btn;
        result.kind = "confirm";
      } else if (isUnsubCancelLabel(text)) {
        result.cancelBtn = btn;
      } else if (isUnsubWebsiteLabel(text) || /(go to|visit).*(website|site)/i.test(text)) {
        result.kind = "manual";
      }
    }
    return result;
  }

  function dismissDialog(dlg) {
    const { cancelBtn } = resolveUnsubscribeDialog(dlg);
    if (cancelBtn) {
      fireMouseSequence(cancelBtn);
    } else {
      dispatchKeyEvent("Escape", "Escape", { keyCode: 27 });
    }
  }

  // Open a conversation from the current result list, preferring one
  // that is already read so the run changes as little mailbox state as
  // possible.
  //
  // 8.2: this preferred `zE` and its comment called that "already
  // read". In Gmail `tr.zA.zE` is the UNREAD row; a read row carries
  // `yO`. So the unsubscribe run was systematically opening unread mail
  // and marking it read, which is the one side effect the preference
  // existed to avoid. The fixture in tests/contentScript-subscriptions
  // marked every row `zA zE`, so no test could tell the difference.
  // Prefer `yO`, fall back to any row that is not flagged unread, then
  // to the first row.
  async function openMessageFromCurrentList() {
    const rows = qsa('tr[role="row"]', getMainRoot());
    if (!rows.length || hasNoResults()) {
      return { opened: false, reason: "no_results" };
    }
    const row =
      rows.find((r) => r.classList.contains("yO")) ||
      rows.find((r) => !r.classList.contains("zE")) ||
      rows[0];
    const cell = qsFirst(SELECTORS.subjectCell, row);
    fireMouseSequence(cell || row);
    const opened = await waitFor(
      () => qsFirst(SELECTORS.messageOpen),
      { timeout: SUBSCRIPTIONS.OPEN_MESSAGE_TIMEOUT, description: "open conversation" }
    );
    if (!opened) return { opened: false, reason: "open_timeout" };
    await sleep(TIMING.DOM_SETTLE_DELAY);
    return { opened: true };
  }

  // Drive header Unsubscribe + confirm dialog on the open conversation.
  async function unsubscribeCurrentMessage() {
    const control = findHeaderUnsubscribeControl();
    if (!control) return { status: "no_button" };

    fireMouseSequence(control);

    const dlg = await waitFor(
      () => qsFirst(SELECTORS.bulkConfirmDialog),
      { timeout: SUBSCRIPTIONS.UNSUB_DIALOG_TIMEOUT, description: "unsubscribe dialog" }
    );
    if (!dlg) return { status: "no_dialog" };

    const { confirmBtn, kind } = resolveUnsubscribeDialog(dlg);
    if (kind !== "confirm" || !confirmBtn) {
      dismissDialog(dlg);
      return { status: kind === "manual" ? "manual" : "unknown_dialog" };
    }

    // Last chance to honour Cancel, for the same reason the delete path
    // has one: the loop checks CANCELLED once per sender, and getting
    // here costs a search, a message open and a dialog wait. Confirming
    // an unsubscribe is irreversible and it tells the sender the address
    // is live, so a user who cancelled must not have one sent for them.
    if (CANCELLED) {
      dismissDialog(dlg);
      throw new CancellationError("Unsubscribe cancelled before the confirmation");
    }

    fireMouseSequence(confirmBtn);
    await waitFor(
      () => !qsFirst(SELECTORS.bulkConfirmDialog),
      { timeout: SUBSCRIPTIONS.DIALOG_CLOSE_TIMEOUT, description: "dialog close" }
    );
    return { status: "unsubscribed" };
  }

  async function subscriptionScan() {
    if (RUNNING) {
      debugLog("Run already in progress, ignoring scan request");
      return;
    }
    RUNNING = true;
    CANCELLED = false;
    const originHash = location.hash;
    const bySender = new Map();
    let failedQueries = 0;

    try {
      if (!isGmailTab()) {
        alert("Gmail Cleaner: please run this from a Gmail tab.");
        return;
      }

      const queries = buildSubscriptionScanQueries();

      safeSendImmediate({
        runKind: "subscriptionScan",
        phase: "starting",
        status: "Scanning for subscriptions...",
        detail: `${queries.length} discovery searches.`,
        percent: 0
      });
      for (let i = 0; i < queries.length; i++) {
        if (CANCELLED) throw new CancellationError("Scan cancelled by user");

        safeSendImmediate({
          runKind: "subscriptionScan",
          phase: "running",
          status: `Scanning (${i + 1}/${queries.length})...`,
          detail: queries[i],
          percent: Math.round((i / queries.length) * 100)
        });

        try {
          await openSearch(queries[i]);
        } catch (e) {
          if (e instanceof CancellationError) throw e;
          debugLog("Scan query failed, continuing", { query: queries[i], error: e?.message });
          failedQueries++;
          continue;
        }

        for (const entry of sampleSubscriptionRows()) {
          const existing = bySender.get(entry.email);
          if (existing) {
            existing.count += 1;
          } else {
            bySender.set(entry.email, { email: entry.email, name: entry.name, count: 1 });
          }
        }
      }

      const senders = [...bySender.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, SUBSCRIPTIONS.MAX_SENDERS);

      try {
        if (hasChromeRuntime()) {
          chrome.runtime.sendMessage({
            type: "gmailCleanerSubscriptionScanResult",
            senders
          });
        }
      } catch (e) {
        debugLog("Failed to send scan result to background", { error: e?.message });
      }

      safeSendImmediate({
        runKind: "subscriptionScan",
        phase: "done",
        status: senders.length
          ? `Found ${senders.length} subscription senders.`
          : (failedQueries === queries.length
            ? "Gmail did not respond to the scan."
            : "Found 0 subscription senders."),
        detail: senders.length
          ? `Pick the ones you never read and unsubscribe in one pass.${failedQueries ? ` ${failedQueries} of ${queries.length} searches timed out, so this list is incomplete.` : ""}`
          : (failedQueries === queries.length
            ? "Every search timed out. Reload the Gmail tab and try again."
            : "No subscription-style mail found in the last year."),
        percent: 100,
        done: true,
        failedQueries,
        scanSenders: senders
      });
    } catch (e) {
      if (e instanceof CancellationError) {
        safeSendImmediate({
          runKind: "subscriptionScan",
          phase: "cancelled",
          status: "Scan cancelled.",
          detail: "Stopped by user.",
          done: true,
          percent: 100
        });
      } else {
        logError(e, "subscription scan");
        safeSendImmediate({
          runKind: "subscriptionScan",
          phase: "error",
          status: "Scan failed.",
          detail: e instanceof Error ? e.message : String(e),
          done: true,
          percent: 100
        });
      }
    } finally {
      RUNNING = false;
      try {
        if (typeof window !== "undefined") window.GCC_ATTACHED = false;
      } catch {}
      try {
        if (originHash && location.hash !== originHash) location.hash = originHash;
      } catch {}
    }
  }

  async function unsubscribeRun(rawSenders) {
    if (RUNNING) {
      debugLog("Run already in progress, ignoring unsubscribe request");
      return;
    }
    RUNNING = true;
    CANCELLED = false;
    const originHash = location.hash;
    const senders = sanitizeSenderList(rawSenders);
    const results = [];

    try {
      if (!isGmailTab()) {
        alert("Gmail Cleaner: please run this from a Gmail tab.");
        return;
      }

      if (!senders.length) {
        safeSendImmediate({
          runKind: "unsubscribe",
          phase: "done",
          status: "Nothing to unsubscribe.",
          detail: "No valid sender addresses were provided.",
          percent: 100,
          done: true,
          unsubResults: []
        });
        return;
      }

      safeSendImmediate({
        runKind: "unsubscribe",
        phase: "starting",
        status: `Unsubscribing from ${senders.length} sender${senders.length === 1 ? "" : "s"}...`,
        detail: "Driving Gmail's own Unsubscribe control for each sender.",
        percent: 0
      });

      for (let i = 0; i < senders.length; i++) {
        if (CANCELLED) throw new CancellationError("Unsubscribe run cancelled by user");
        const email = senders[i];

        safeSendImmediate({
          runKind: "unsubscribe",
          phase: "running",
          status: `Unsubscribing (${i + 1}/${senders.length})...`,
          detail: email,
          percent: Math.round((i / senders.length) * 100)
        });

        let status = "error";
        try {
          await openSearch(`from:(${email})`);
          const openResult = await openMessageFromCurrentList();
          if (!openResult.opened) {
            status = openResult.reason === "no_results" ? "not_found" : "error";
          } else {
            status = (await unsubscribeCurrentMessage()).status;
          }
        } catch (e) {
          if (e instanceof CancellationError) throw e;
          debugLog("Unsubscribe failed for sender", { email, error: e?.message });
          status = "error";
        }

        results.push({ sender: email, status });
        await sleep(SUBSCRIPTIONS.BETWEEN_SENDERS_MS);
      }

      try {
        if (hasChromeRuntime()) {
          chrome.runtime.sendMessage({
            type: "gmailCleanerRecordUnsubscribes",
            results
          });
        }
      } catch (e) {
        debugLog("Failed to send unsubscribe results to background", { error: e?.message });
      }

      const okCount = results.filter((r) => r.status === "unsubscribed").length;
      safeSendImmediate({
        runKind: "unsubscribe",
        phase: "done",
        status: `Unsubscribed from ${okCount} of ${results.length} senders.`,
        detail: okCount === results.length
          ? "All done. Their future mail stops at the source."
          : "Some senders offer no one-click unsubscribe; those are marked for manual follow-up.",
        percent: 100,
        done: true,
        unsubResults: results
      });
    } catch (e) {
      if (e instanceof CancellationError) {
        safeSendImmediate({
          runKind: "unsubscribe",
          phase: "cancelled",
          status: "Unsubscribe run cancelled.",
          detail: "Stopped by user.",
          done: true,
          percent: 100,
          unsubResults: results
        });
      } else {
        logError(e, "unsubscribe run");
        safeSendImmediate({
          runKind: "unsubscribe",
          phase: "error",
          status: "Unsubscribe run failed.",
          detail: e instanceof Error ? e.message : String(e),
          done: true,
          percent: 100,
          unsubResults: results
        });
      }
    } finally {
      RUNNING = false;
      try {
        if (typeof window !== "undefined") window.GCC_ATTACHED = false;
      } catch {}
      try {
        if (originHash && location.hash !== originHash) location.hash = originHash;
      } catch {}
    }
  }

  function startSubscriptionScan() {
    if (!RUNNING) {
      subscriptionScan().catch((e) => logError(e, "startSubscriptionScan"));
    }
  }

  function startUnsubscribeRun(senders) {
    if (!RUNNING) {
      unsubscribeRun(senders).catch((e) => logError(e, "startUnsubscribeRun"));
    }
  }

  // =========================
  // Storage X-ray: tiered size scan (7.2)
  // =========================
  // Read-only, like the subscription scan: walk size-tier searches and
  // attribute each visible row the tier's floor MB. The result is a
  // deliberate LOWER BOUND per sender ("at least this much"), built
  // from Gmail's own larger:/smaller: operators; the scan never opens
  // messages and never reads bodies. Purging is not a new run kind:
  // the popup starts a normal cleanup whose rulesOverride is a
  // from:(...) larger: query, so tagging, global guards, undo and
  // stats all apply unchanged.

  const STORAGE_XRAY = Object.freeze({
    TIER_QUERIES: Object.freeze([
      "larger:25M",
      "larger:10M smaller:25M",
      "larger:5M smaller:10M"
    ]),
    MAX_SENDERS: 100,
    ROW_SAMPLE_CAP: 100
  });

  // Fold one page of sampled rows into the per-sender accumulator.
  // Extracted pure so the DOM-fixture tests can drive it directly.
  function foldStorageSample(bySender, entries, mbPerEmail) {
    const mb = Number(mbPerEmail) || 0;
    for (const entry of entries) {
      const existing = bySender.get(entry.email);
      if (existing) {
        existing.count += 1;
        existing.estMb += mb;
      } else {
        bySender.set(entry.email, {
          email: entry.email,
          name: entry.name,
          count: 1,
          estMb: mb
        });
      }
    }
    return bySender;
  }

  async function storageScan() {
    if (RUNNING) {
      debugLog("Run already in progress, ignoring storage scan request");
      return;
    }
    RUNNING = true;
    CANCELLED = false;
    const originHash = location.hash;
    const bySender = new Map();
    let failedQueries = 0;

    try {
      if (!isGmailTab()) {
        alert("Gmail Cleaner: please run this from a Gmail tab.");
        return;
      }

      safeSendImmediate({
        runKind: "storageScan",
        phase: "starting",
        status: "Scanning for space hogs...",
        detail: `${STORAGE_XRAY.TIER_QUERIES.length} size-tier searches.`,
        percent: 0
      });

      const queries = STORAGE_XRAY.TIER_QUERIES;
      for (let i = 0; i < queries.length; i++) {
        if (CANCELLED) throw new CancellationError("Scan cancelled by user");

        safeSendImmediate({
          runKind: "storageScan",
          phase: "running",
          status: `Sizing up your mailbox (${i + 1}/${queries.length})...`,
          detail: queries[i],
          percent: Math.round((i / queries.length) * 100)
        });

        try {
          // 8.5: guarded, because the purge button beside these numbers
          // runs applyGlobalGuards. Counting raw here promised big mail
          // that -is:unread and -has:userlabels then held back.
          await openSearch(applyGlobalGuards(queries[i]));
        } catch (e) {
          if (e instanceof CancellationError) throw e;
          // 8.2: this used to be swallowed. If every tier timed out the
          // scan still reported a tidy "No large mail found", which is a
          // different claim from "Gmail never answered" and sent people
          // looking for a bug in the wrong place.
          failedQueries++;
          debugLog("Storage tier query failed, continuing", { query: queries[i], error: e?.message });
          continue;
        }

        foldStorageSample(
          bySender,
          sampleSubscriptionRows({ cap: STORAGE_XRAY.ROW_SAMPLE_CAP }),
          estimateMbPerEmail(queries[i])
        );
      }

      const senders = [...bySender.values()]
        .map((s) => ({ ...s, estMb: Math.round(s.estMb) }))
        .sort((a, b) => b.estMb - a.estMb || b.count - a.count)
        .slice(0, STORAGE_XRAY.MAX_SENDERS);
      const totalMb = senders.reduce((sum, s) => sum + s.estMb, 0);
      const totalCount = senders.reduce((sum, s) => sum + s.count, 0);

      try {
        if (hasChromeRuntime()) {
          chrome.runtime.sendMessage({
            type: "gmailCleanerStorageScanResult",
            senders,
            totalMb,
            totalCount
          });
        }
      } catch (e) {
        debugLog("Failed to send storage scan result to background", { error: e?.message });
      }

      safeSendImmediate({
        runKind: "storageScan",
        phase: "done",
        status: senders.length
          ? `Found at least ${totalMb.toLocaleString()} MB in large mail.`
          : (failedQueries === queries.length
            ? "Gmail did not respond to the scan."
            : "No large mail found."),
        detail: senders.length
          ? `${totalCount.toLocaleString()} large emails across ${senders.length} senders.${failedQueries ? ` ${failedQueries} of ${queries.length} searches timed out, so this is a partial result.` : ""}`
          : (failedQueries === queries.length
            ? "Every search timed out. Reload the Gmail tab and try again."
            : "Nothing bigger than 5 MB turned up."),
        failedQueries,
        percent: 100,
        done: true,
        scanSenders: senders,
        totalMb,
        totalCount
      });
    } catch (e) {
      if (e instanceof CancellationError) {
        safeSendImmediate({
          runKind: "storageScan",
          phase: "cancelled",
          status: "Scan cancelled.",
          detail: "Stopped by user.",
          done: true,
          percent: 100
        });
      } else {
        logError(e, "storage scan");
        safeSendImmediate({
          runKind: "storageScan",
          phase: "error",
          status: "Scan failed.",
          detail: e instanceof Error ? e.message : String(e),
          done: true,
          percent: 100
        });
      }
    } finally {
      RUNNING = false;
      try {
        if (typeof window !== "undefined") window.GCC_ATTACHED = false;
      } catch {}
      try {
        if (originHash && location.hash !== originHash) location.hash = originHash;
      } catch {}
    }
  }

  function startStorageScan() {
    if (!RUNNING) {
      storageScan().catch((e) => logError(e, "startStorageScan"));
    }
  }

  // =========================
  // Mailbox Report (8.0)
  // =========================
  // The cheapest scan in the product and the one that finally answers
  // "what is actually in here". Each band is one search plus one count
  // read: openSearch, then countCurrentResults. Nothing is opened,
  // nothing is selected, nothing moves.
  //
  // Engine-local copy of GCC.report.BANDS, for the same reason
  // scoreSmartSignals is duplicated: the content script runs inside
  // Gmail and cannot reference GCC. tests/shared-report.test.js pins
  // the two tables against each other, so they cannot drift.

  const REPORT_BANDS = Object.freeze([
    Object.freeze({ id: "sizeHuge", kind: "size", query: "larger:25M older_than:6m", mbFloor: 25, action: "delete" }),
    Object.freeze({ id: "sizeLarge", kind: "size", query: "larger:10M smaller:25M older_than:6m", mbFloor: 10, action: "delete" }),
    Object.freeze({ id: "sizeBig", kind: "size", query: "larger:5M smaller:10M older_than:6m", mbFloor: 5, action: "delete" }),
    Object.freeze({ id: "promotions", kind: "noise", query: "category:promotions older_than:6m", mbFloor: 0, action: "delete" }),
    Object.freeze({ id: "social", kind: "noise", query: "category:social older_than:6m", mbFloor: 0, action: "delete" }),
    Object.freeze({ id: "updates", kind: "noise", query: "category:updates older_than:1y", mbFloor: 0, action: "delete" }),
    Object.freeze({ id: "forums", kind: "noise", query: "category:forums older_than:1y", mbFloor: 0, action: "delete" }),
    Object.freeze({ id: "newsletters", kind: "noise", query: "\"unsubscribe\" older_than:1y", mbFloor: 0, action: "delete" }),
    Object.freeze({ id: "inboxAncient", kind: "inbox", query: "in:inbox older_than:5y", mbFloor: 0, action: "archive" }),
    Object.freeze({ id: "inboxOld", kind: "inbox", query: "in:inbox older_than:1y newer_than:5y", mbFloor: 0, action: "archive" })
  ]);

  const REPORT = Object.freeze({
    HEADLINE_QUERY: "older_than:6m",
    // Hard budget. The scan spends one search per entry below; a future
    // band cannot quietly turn a fast scan into a minutes-long one.
    MAX_QUERIES: 15,
    SENDER_SAMPLE_CAP: 25,
    TOP_SENDERS: 5,
    // Sender attribution costs nothing extra (the rows are already on
    // screen from the band's own search) but it is only meaningful for
    // bands with real volume, so only the biggest few are sampled.
    SENDER_BANDS: 2
  });

  async function reportScan() {
    if (RUNNING) {
      debugLog("Run already in progress, ignoring report scan request");
      return;
    }
    RUNNING = true;
    CANCELLED = false;
    const originHash = location.hash;

    try {
      if (!isGmailTab()) {
        alert("Gmail Cleaner: please run this from a Gmail tab.");
        return;
      }

      // 8.5: every band is measured through applyGlobalGuards, the same
      // filter the purge runs through, so a band's number is the number
      // its Clean button will act on. Counting raw is what made a band
      // read 5,000 and then clear nothing: `category:updates` is
      // notification mail nobody opens, and the purge's own
      // `-is:unread` removed all of it.
      //
      // The headline is measured BOTH ways. The difference is the mail
      // the guards are holding back, which is the one number that
      // explains an empty-looking report, and it costs one search.
      const steps = [
        { id: "__headlineRaw", query: REPORT.HEADLINE_QUERY, guarded: false },
        { id: "__headline", query: REPORT.HEADLINE_QUERY, guarded: true }
      ].concat(REPORT_BANDS.map((b) => ({ id: b.id, query: b.query, guarded: true })));

      // Count the sender-attribution re-runs too. They are cheap but
      // they are still searches, and a future band added without
      // counting them would quietly breach the ceiling this exists to
      // hold. Refusing is safe: the report simply does not run.
      const budget = steps.length + REPORT.SENDER_BANDS;
      if (budget > REPORT.MAX_QUERIES) {
        throw new Error(`Report query budget exceeded (${budget} > ${REPORT.MAX_QUERIES})`);
      }

      safeSendImmediate({
        runKind: "reportScan",
        phase: "starting",
        status: "Reading your mailbox...",
        detail: `${steps.length} read-only searches. Nothing is opened or moved.`,
        percent: 0
      });

      const counts = Object.create(null);
      let cleanableCount = 0;
      let unguardedCount = 0;

      for (let i = 0; i < steps.length; i++) {
        if (CANCELLED) throw new CancellationError("Scan cancelled by user");

        const searchQuery = steps[i].guarded
          ? applyGlobalGuards(steps[i].query)
          : steps[i].query;

        safeSendImmediate({
          runKind: "reportScan",
          phase: "running",
          status: `Measuring your mailbox (${i + 1}/${steps.length})...`,
          detail: searchQuery,
          percent: Math.round((i / steps.length) * 100)
        });

        try {
          await openSearch(searchQuery);
        } catch (e) {
          if (e instanceof CancellationError) throw e;
          // One failed band must not lose the whole report. Mirrors the
          // per-tier catch in storageScan.
          debugLog("Report band query failed, continuing", { query: searchQuery, error: e?.message });
          continue;
        }

        const count = countCurrentResults();
        if (steps[i].id === "__headlineRaw") {
          unguardedCount = count;
        } else if (steps[i].id === "__headline") {
          cleanableCount = count;
        } else {
          counts[steps[i].id] = count;
        }
      }

      // What the guards are holding back. Never negative: the guarded
      // query is a strict subset of the raw one, but a failed search on
      // either side leaves a zero behind and the subtraction would
      // otherwise invent a nonsense figure.
      const guardedOutCount = Math.max(0, unguardedCount - cleanableCount);

      const bands = REPORT_BANDS.map((band) => {
        const count = Math.max(0, Math.floor(Number(counts[band.id]) || 0));
        return {
          id: band.id,
          kind: band.kind,
          action: band.action,
          count,
          estMb: band.mbFloor ? count * band.mbFloor : 0
        };
      });

      // Sender attribution for the biggest bands. This DOES cost a
      // search each: the last search executed was the final band, not
      // this one, so the band has to be re-opened for its rows to be on
      // screen. Capped at SENDER_BANDS and counted in the budget above.
      const topSenders = [];
      const senderBands = bands
        .filter((b) => b.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, REPORT.SENDER_BANDS);

      for (const band of senderBands) {
        if (CANCELLED) throw new CancellationError("Scan cancelled by user");
        const def = REPORT_BANDS.find((b) => b.id === band.id);
        if (!def) continue;
        try {
          // Guarded, like the count it is attributing. Sampling the raw
          // band would name senders whose mail the purge will not touch.
          await openSearch(applyGlobalGuards(def.query));
        } catch (e) {
          if (e instanceof CancellationError) throw e;
          continue;
        }
        const rows = sampleSubscriptionRows({ cap: REPORT.SENDER_SAMPLE_CAP });
        const tally = new Map();
        for (const row of rows) {
          const existing = tally.get(row.email);
          if (existing) {
            existing.count += 1;
          } else {
            tally.set(row.email, { email: row.email, name: row.name, count: 1 });
          }
        }
        const ranked = [...tally.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, REPORT.TOP_SENDERS);
        if (ranked.length) topSenders.push({ bandId: band.id, senders: ranked });
      }

      const largeMb = bands
        .filter((b) => b.kind === "size")
        .reduce((sum, b) => sum + b.estMb, 0);

      try {
        if (hasChromeRuntime()) {
          chrome.runtime.sendMessage({
            type: "gmailCleanerReportScanResult",
            bands,
            cleanableCount,
            largeMb,
            topSenders,
            guardedOutCount
          });
        }
      } catch (e) {
        debugLog("Failed to send report scan result to background", { error: e?.message });
      }

      const bandedTotal = bands.reduce((sum, b) => sum + b.count, 0);

      safeSendImmediate({
        runKind: "reportScan",
        phase: "done",
        status: cleanableCount
          ? `${cleanableCount.toLocaleString()} emails are older than 6 months.`
          : "Nothing older than 6 months turned up.",
        detail: bandedTotal
          ? `Plan ready: ${bands.filter((b) => b.count > 0).length} steps, at least ${largeMb.toLocaleString()} MB in large mail.`
          : "Your mailbox is already clean.",
        percent: 100,
        done: true,
        bands,
        cleanableCount,
        largeMb,
        topSenders
      });
    } catch (e) {
      if (e instanceof CancellationError) {
        safeSendImmediate({
          runKind: "reportScan",
          phase: "cancelled",
          status: "Report cancelled.",
          detail: "Stopped by user.",
          done: true,
          percent: 100
        });
      } else {
        logError(e, "report scan");
        safeSendImmediate({
          runKind: "reportScan",
          phase: "error",
          status: "Report failed.",
          detail: e instanceof Error ? e.message : String(e),
          done: true,
          percent: 100
        });
      }
    } finally {
      RUNNING = false;
      try {
        if (typeof window !== "undefined") window.GCC_ATTACHED = false;
      } catch {}
      try {
        if (originHash && location.hash !== originHash) location.hash = originHash;
      } catch {}
    }
  }

  function startReportScan() {
    if (!RUNNING) {
      reportScan().catch((e) => logError(e, "startReportScan"));
    }
  }

  // =========================
  // Smart Suggestions scan (7.8)
  // =========================
  // Read-only, like the subscription and storage scans: discover heavy
  // senders, measure how the user actually treats their mail (unread
  // ratio, old-mail share, machine-address shape) and hard-veto
  // anything that looks like a human relationship BEFORE it can be
  // recommended. The scan recommends; it never acts. Applying a
  // suggestion is an ordinary cleanup run (rulesOverride) started from
  // the popup, so every guard, tag-before-delete, undo and stats apply
  // unchanged.

  const SMART_SCAN = Object.freeze({
    // Signal queries cost 3 searches per sender, veto queries up to 2
    // more, so both phases are hard-capped: at most 10 senders get
    // measured and at most 15 correspondence checks run per scan.
    MAX_SIGNAL_SENDERS: 10,
    MAX_VETO_SENDERS: 15,
    MAX_KNOWN_SENDERS: 100,
    MAX_RESULTS: 50,
    ROW_SAMPLE_CAP: 100
  });

  // Strict email shape doubles as query-injection protection, the same
  // boundary as sanitizeSenderList: anything that passes cannot break
  // out of the from:( ... ) / to:( ... ) group it is placed in.
  const SMART_EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.][a-z0-9!#$%&'*+/=?^_`{|}~.-]*@[a-z0-9.-]+\.[a-z]{2,}$/;

  // Machine-sender local-part shapes. A hit is a clutter SIGNAL that
  // raises the score; it is never a veto.
  const SMART_SHAPE_RE = /(no-?reply|do-?not-?reply|donotreply|notifications?|newsletters?|marketing|mailer|bounces?)/;

  function smartSenderShape(email) {
    const local = String(email || "").toLowerCase().split("@")[0] || "";
    return SMART_SHAPE_RE.test(local);
  }

  function sanitizeSmartKnownSenders(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of input) {
      const email = String(raw?.email || "").trim().toLowerCase();
      if (!email || email.length > 320 || !SMART_EMAIL_RE.test(email)) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      out.push({
        email,
        name: String(raw?.name || "").slice(0, 120),
        count: Math.max(1, Math.min(99999, Number(raw?.count) || 1)),
        estMb: Math.max(0, Math.min(1024 * 1024, Math.round(Number(raw?.estMb) || 0)))
      });
      if (out.length >= SMART_SCAN.MAX_KNOWN_SENDERS) break;
    }
    return out;
  }

  // Whitelist semantics mirrored from the query builder: exact email,
  // *@domain wildcard, bare domain (subdomains included). Whitelisted
  // senders are dropped before a single query is spent on them.
  function smartSenderWhitelisted(email, whitelist) {
    const target = String(email || "").toLowerCase();
    for (const raw of whitelist || []) {
      const entry = String(raw || "").trim().toLowerCase();
      if (!entry) continue;
      if (entry.startsWith("*@")) {
        if (target.endsWith(entry.slice(1))) return true;
      } else if (entry.includes("@")) {
        if (target === entry) return true;
      } else if (target.endsWith("@" + entry) || target.endsWith("." + entry)) {
        return true;
      }
    }
    return false;
  }

  // Protected keywords shield mail by subject; the sender-level
  // reading is conservative: a protected word anywhere in the address
  // or display name disqualifies the sender from recommendations.
  function smartSenderProtected(email, name, protectKeywords) {
    const hay = (String(email || "") + " " + String(name || "")).toLowerCase();
    for (const raw of protectKeywords || []) {
      const key = String(raw || "").trim().toLowerCase();
      if (key && hay.includes(key)) return true;
    }
    return false;
  }

  function buildSmartSignalQueries(email) {
    return Object.freeze({
      base: `from:(${email})`,
      unread: `from:(${email}) is:unread older_than:1m`,
      old: `from:(${email}) older_than:6m`
    });
  }

  function buildSmartVetoQueries(email) {
    return Object.freeze({
      starred: `from:(${email}) is:starred`,
      sent: `in:sent to:(${email})`
    });
  }

  // How many conversations the current result page represents: the
  // pagination total when Gmail shows one, else the visible row count,
  // zero once the empty state settled.
  function countCurrentResults() {
    if (hasNoResults()) return 0;
    const total = estimateTotalResults();
    if (Number.isFinite(total) && total > 0) return total;
    return getGridRowCount() ?? 0;
  }

  // Engine-local copy of GCC.smart.score: the content script runs
  // inside Gmail and cannot reference GCC. The smart-scan test suite
  // pins the two implementations against each other.
  function scoreSmartSignals(signals) {
    const s = signals || {};
    const count = Math.max(0, Number(s.count) || 0);
    if (!count) return 0;
    const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
    const volumePts = Math.min(25, Math.round(Math.log10(count + 1) * 10));
    const unreadPts = Math.round(45 * clamp01(s.unreadRatio));
    const oldPts = Math.round(15 * clamp01(s.oldShare));
    const shapePts = s.shape ? 15 : 0;
    return Math.min(100, volumePts + unreadPts + oldPts + shapePts);
  }

  // Signal sampling for one sender. fetchCount(query) -> count is
  // injected so fixtures can drive this without Gmail navigation; the
  // live runner passes an openSearch wrapper. A sender whose base
  // query matches nothing short-circuits: no further queries.
  async function gatherSmartSignals(sender, fetchCount) {
    const queries = buildSmartSignalQueries(sender.email);
    const total = await fetchCount(queries.base);
    if (!total) return null;
    const unread = await fetchCount(queries.unread);
    const old = await fetchCount(queries.old);
    const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
    const signals = {
      count: total,
      unreadRatio: clamp01(unread / total),
      oldShare: clamp01(old / total),
      shape: smartSenderShape(sender.email)
    };
    if (Number(sender.estMb) > 0) signals.estMb = Number(sender.estMb);
    return signals;
  }

  // Hard vetoes, one query at a time; the first hit stops the rest.
  // Starred mail means the user curates this sender; any row in Sent
  // addressed to them means a human relationship.
  async function runSmartVetoes(email, fetchCount) {
    const queries = buildSmartVetoQueries(email);
    if (await fetchCount(queries.starred)) return { vetoed: true, reason: "starred" };
    if (await fetchCount(queries.sent)) return { vetoed: true, reason: "correspondence" };
    return { vetoed: false, reason: "" };
  }

  async function smartScan() {
    if (RUNNING) {
      debugLog("Run already in progress, ignoring smart scan request");
      return;
    }
    RUNNING = true;
    CANCELLED = false;
    const originHash = location.hash;

    const fetchCount = async (query) => {
      if (CANCELLED) throw new CancellationError("Scan cancelled by user");
      await openSearch(query);
      return countCurrentResults();
    };

    try {
      if (!isGmailTab()) {
        alert("Gmail Cleaner: please run this from a Gmail tab.");
        return;
      }

      safeSendImmediate({
        runKind: "smartScan",
        phase: "starting",
        status: "Looking for easy wins...",
        detail: "Finding heavy senders, then checking how you treat their mail.",
        percent: 0
      });

      // Discovery: the subscription discovery searches, then the
      // senders earlier scans already measured (zero extra queries).
      const bySender = new Map();
      const discovery = buildSubscriptionScanQueries();
      for (let i = 0; i < discovery.length; i++) {
        if (CANCELLED) throw new CancellationError("Scan cancelled by user");
        safeSendImmediate({
          runKind: "smartScan",
          phase: "running",
          status: `Finding senders (${i + 1}/${discovery.length})...`,
          detail: discovery[i],
          percent: Math.round((i / discovery.length) * 20)
        });
        try {
          await openSearch(discovery[i]);
        } catch (e) {
          if (e instanceof CancellationError) throw e;
          debugLog("Smart discovery query failed, continuing", { query: discovery[i], error: e?.message });
          continue;
        }
        for (const entry of sampleSubscriptionRows({ cap: SMART_SCAN.ROW_SAMPLE_CAP })) {
          const existing = bySender.get(entry.email);
          if (existing) {
            existing.count += 1;
          } else {
            bySender.set(entry.email, { email: entry.email, name: entry.name, count: 1, estMb: 0 });
          }
        }
      }
      for (const known of sanitizeSmartKnownSenders(CONFIG.smartKnownSenders)) {
        const existing = bySender.get(known.email);
        if (existing) {
          // Counts describe the same mailbox, so merging takes the
          // larger claim instead of double-counting.
          existing.count = Math.max(existing.count, known.count);
          existing.estMb = Math.max(existing.estMb || 0, known.estMb);
          if (!existing.name) existing.name = known.name;
        } else {
          bySender.set(known.email, { ...known });
        }
      }

      // Free vetoes before any per-sender query is spent, then the
      // heaviest senders win the capped signal budget.
      const candidates = [...bySender.values()]
        .filter((s) => SMART_EMAIL_RE.test(s.email))
        .filter((s) => !smartSenderWhitelisted(s.email, CONFIG.whitelist))
        .filter((s) => !smartSenderProtected(s.email, s.name, CONFIG.protectKeywords))
        .sort((a, b) => b.count - a.count)
        .slice(0, SMART_SCAN.MAX_SIGNAL_SENDERS);

      const scored = [];
      for (let i = 0; i < candidates.length; i++) {
        safeSendImmediate({
          runKind: "smartScan",
          phase: "running",
          status: `Measuring senders (${i + 1}/${candidates.length})...`,
          detail: candidates[i].email,
          percent: 20 + Math.round((i / Math.max(1, candidates.length)) * 50)
        });
        let signals = null;
        try {
          signals = await gatherSmartSignals(candidates[i], fetchCount);
        } catch (e) {
          if (e instanceof CancellationError) throw e;
          debugLog("Smart signal sampling failed, skipping sender", { email: candidates[i].email, error: e?.message });
          continue;
        }
        if (!signals) continue;
        scored.push({
          email: candidates[i].email,
          name: candidates[i].name || "",
          score: scoreSmartSignals(signals),
          signals,
          estCount: signals.count
        });
      }
      scored.sort((a, b) => b.score - a.score);

      const senders = [];
      let vetoBudget = SMART_SCAN.MAX_VETO_SENDERS;
      for (let i = 0; i < scored.length; i++) {
        if (vetoBudget <= 0 || senders.length >= SMART_SCAN.MAX_RESULTS) break;
        vetoBudget -= 1;
        safeSendImmediate({
          runKind: "smartScan",
          phase: "running",
          status: `Checking relationships (${i + 1}/${scored.length})...`,
          detail: scored[i].email,
          percent: 70 + Math.round((i / Math.max(1, scored.length)) * 30)
        });
        let verdict = null;
        try {
          verdict = await runSmartVetoes(scored[i].email, fetchCount);
        } catch (e) {
          if (e instanceof CancellationError) throw e;
          // A veto check that cannot complete fails SAFE: the sender
          // is simply not recommended this scan.
          debugLog("Smart veto check failed, dropping sender", { email: scored[i].email, error: e?.message });
          continue;
        }
        if (verdict.vetoed) {
          debugLog("Smart candidate vetoed", { email: scored[i].email, reason: verdict.reason });
          continue;
        }
        senders.push(scored[i]);
      }

      try {
        if (hasChromeRuntime()) {
          chrome.runtime.sendMessage({
            type: "gmailCleanerSmartScanResult",
            senders
          });
        }
      } catch (e) {
        debugLog("Failed to send smart scan result to background", { error: e?.message });
      }

      safeSendImmediate({
        runKind: "smartScan",
        phase: "done",
        status: senders.length
          ? `Found ${senders.length} suggestion${senders.length === 1 ? "" : "s"}.`
          : "No suggestions this time.",
        detail: senders.length
          ? "Each one comes with the reason and a one-click cleanup."
          : "Nothing stood out as safe, obvious clutter.",
        percent: 100,
        done: true,
        scanSenders: senders
      });
    } catch (e) {
      if (e instanceof CancellationError) {
        safeSendImmediate({
          runKind: "smartScan",
          phase: "cancelled",
          status: "Scan cancelled.",
          detail: "Stopped by user.",
          done: true,
          percent: 100
        });
      } else {
        logError(e, "smart scan");
        safeSendImmediate({
          runKind: "smartScan",
          phase: "error",
          status: "Scan failed.",
          detail: e instanceof Error ? e.message : String(e),
          done: true,
          percent: 100
        });
      }
    } finally {
      RUNNING = false;
      try {
        if (typeof window !== "undefined") window.GCC_ATTACHED = false;
      } catch {}
      try {
        if (originHash && location.hash !== originHash) location.hash = originHash;
      } catch {}
    }
  }

  function startSmartScan() {
    if (!RUNNING) {
      smartScan().catch((e) => logError(e, "startSmartScan"));
    }
  }

  // =========================
  // Restore run (7.6)
  // =========================
  // Every tag-before-delete cleanup labels its mail before moving it,
  // and Gmail keeps Trash for 30 days, so a logged run is mechanically
  // reversible: search the run's label, select everything, and drive
  // Gmail's own move-back-to-Inbox control. That is ALL this engine
  // does. It never deletes, archives, or marks anything; its only
  // mutating click is the verified move-back control, and every finder
  // below refuses "Delete forever" via the deny-list before scoring.

  // Delete-mode runs sit in Trash; archive-mode runs sit outside the
  // Inbox under the label. Both searches are pure Gmail operators plus
  // the quoted label name (quotes inside the label are stripped by
  // sanitizeConfig and again here for the test-facing callers).
  function buildRestoreQuery(label, action) {
    const clean = String(label || "").replace(/"/g, "").trim();
    if (!clean) return "";
    const labelTerm = `label:"${clean}"`;
    return action === "archive"
      ? `${labelTerm} -in:inbox`
      : `in:trash ${labelTerm}`;
  }

  // The deny scan reads EVERY label surface, not just the first
  // non-empty one the way getElementLabel does: a control whose
  // aria-label reads harmlessly but whose tooltip says "Delete forever"
  // must still be refused.
  function hasDeleteForeverMarking(el) {
    return (
      isDeleteForeverLabel(getAttr(el, "aria-label")) ||
      isDeleteForeverLabel(getAttr(el, "data-tooltip")) ||
      isDeleteForeverLabel(getAttr(el, "title")) ||
      isDeleteForeverLabel(getTextContent(el))
    );
  }

  // Candidate walk shared by the two toolbar finders: toolbar-scoped
  // buttons, minus anything inside a list row or a message body (both
  // can carry sender-controlled or per-row text), minus anything on the
  // deny-list. The deny check runs BEFORE any scoring so a "Delete
  // forever" control can never win, no matter what its label also says.
  function restoreCandidates(root) {
    const scope = root || findToolbarRoot() || document;
    return qsa("div[role='button'], button, span[role='button']", scope)
      .filter((el) => !el.closest("tr[role='row']"))
      .filter((el) => !el.closest(SELECTORS.messageBody))
      .filter((el) => !hasDeleteForeverMarking(el));
  }

  // The direct "Move to Inbox" button (All Mail / archive views, and
  // some Trash layouts). Exact whole-text scores highest; a label that
  // contains the full phrase with extra words (tooltip shortcut hints)
  // still scores. Single words never match: the tokens are the full
  // localized phrases.
  function findMoveToInboxButton(root) {
    let best = null;
    let bestScore = 0;
    for (const el of restoreCandidates(root)) {
      const norm = normalizeControlText(getElementLabel(el));
      if (!norm) continue;
      let score = 0;
      for (const token of MOVE_TO_INBOX_TOKENS) {
        const wanted = normalizeControlText(token);
        if (norm === wanted) score += 5;
        else if (norm.includes(wanted)) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best ? /** @type {HTMLElement} */ (best) : null;
  }

  // The Trash toolbar's "Move to" menu opener. Exact whole text only
  // (see MOVE_TO_TOKENS for why), so a miss here just means the direct
  // button was the only chance and the run reports honestly.
  function findMoveToMenuButton(root) {
    for (const el of restoreCandidates(root)) {
      if (isMoveToMenuLabel(getElementLabel(el))) {
        return /** @type {HTMLElement} */ (el);
      }
    }
    return null;
  }

  // The Inbox entry inside the opened "Move to" menu. Exact whole text
  // against the localized Inbox names; user labels that merely contain
  // the word never match, and deny-listed items are refused outright.
  function findInboxMenuItemIn(menuRoot) {
    if (!menuRoot) return null;
    const items = qsa(
      "div[role='menuitem'], li[role='menuitem'], span[role='menuitem'], div[role='menuitemcheckbox']",
      menuRoot
    );
    for (const el of items) {
      if (hasDeleteForeverMarking(el)) continue;
      if (isInboxLabel(getElementLabel(el))) {
        return /** @type {HTMLElement} */ (el);
      }
    }
    return null;
  }

  // Drive whichever move-back control this view offers: the direct
  // button first, then the "Move to" menu with its Inbox item. Finding
  // neither does nothing and says so; the selection is left alone and
  // the mail stays where it was, still recoverable.
  async function driveMoveBackControl() {
    const direct = findMoveToInboxButton();
    if (direct) {
      safeSend({ phase: "debug", detail: `Clicked move-to-inbox button: "${describeButton(direct)}"` });
      fireMouseSequence(direct);
      return { clicked: true, how: "direct" };
    }

    const opener = findMoveToMenuButton();
    if (!opener) {
      return { clicked: false, reason: "no-restore-control" };
    }
    fireMouseSequence(opener);
    const menu = await waitFor(findVisibleMenu, {
      timeout: TIMING.LABEL_DIALOG_TIMEOUT,
      interval: 80,
      description: "move-to menu"
    });
    const item = menu ? findInboxMenuItemIn(menu) : null;
    if (!item) {
      // Close the menu we opened; nothing was clicked inside it.
      dispatchKeyEvent("Escape", "Escape");
      return { clicked: false, reason: menu ? "no-inbox-item" : "no-restore-control" };
    }
    safeSend({ phase: "debug", detail: `Clicked Inbox in the move-to menu: "${describeButton(item)}"` });
    fireMouseSequence(item);
    return { clicked: true, how: "menu" };
  }

  // One page-level restore pass: select everything (including the bulk
  // "select all conversations that match" banner), drive the move-back
  // control, confirm the bulk dialog if Gmail asks, and verify the list
  // actually changed. Mirrors actOnCurrentPageIfAny's counting so the
  // reported number means the same thing cleanup counts mean.
  async function restoreCurrentPage() {
    if (hasNoResults()) {
      return { moved: false, count: 0, reason: "no-results" };
    }

    await waitFor(findToolbarRoot, {
      timeout: TIMING.WAIT_TOOLBAR_TIMEOUT,
      description: "toolbar"
    });

    const checkboxResult = await clickMasterCheckbox();
    if (!checkboxResult.success) {
      if (checkboxResult.reason === "not-found" && (getGridRowCount() ?? 0) > 0) {
        throw new GmailLayoutError(layoutChangedMessage(
          "the run's mail is on screen but the select-all checkbox is missing, so nothing can be selected"
        ));
      }
      return { moved: false, count: 0, reason: `selection: ${checkboxResult.reason}` };
    }

    await sleep(TIMING.CHECKBOX_SETTLE_DELAY);

    const selectAllResult = await clickSelectAllConversations();
    const bulkAllSelected = selectAllResult.success &&
      (selectAllResult.reason === "all-selected-indicator" || findAllConversationsSelectedIndicator());

    const selectedCount = extractSelectedCount();
    const rowsBefore = getGridRowCount();
    const totalBefore = bulkAllSelected ? estimateTotalResults() : null;

    // Same reasoning as the cleanup path: selecting a page, opening the
    // Move-to menu and settling takes long enough that a user who hits
    // Cancel in the middle of it expects nothing to move. Throwing keeps
    // restoreRun from reading a no-op return as "this pass found
    // nothing" and reporting the run as finished.
    if (CANCELLED) {
      debugLog("Cancelled before restore click");
      throw new CancellationError("Restore cancelled before the move fired");
    }

    const driveResult = await driveMoveBackControl();
    if (!driveResult.clicked) {
      return { moved: false, count: 0, reason: driveResult.reason };
    }

    if (selectAllResult.success) {
      await handleBulkConfirmation();
    }

    await sleep(TIMING.POST_ACTION_DELAY_MS);

    const verification = await waitForActionProcessing();
    if (!verification.ok) {
      const rl = findRateLimitText();
      if (rl) throw new RateLimitError(rl);
      throw new TimeoutError("Restore processing timed out (Gmail did not refresh the result list).");
    }

    let movedCount;
    if (bulkAllSelected) {
      // 7.15: this preferred the viewport over the match total, which is
      // the exact inversion of the cleanup fix. A confirmed bulk-all
      // restore moves every match, so a 4,200-thread recovery reported
      // "50 restored" and the log looked like the restore had barely
      // run. Take the larger figure, as the cleanup path does.
      movedCount = Math.max(totalBefore ?? 0, selectedCount ?? 0) || rowsBefore || 0;
    } else if (selectedCount !== null && selectedCount !== undefined && selectedCount > 0) {
      movedCount = selectedCount;
    } else if (verification.signal === "no-results" && rowsBefore !== null && rowsBefore !== undefined) {
      movedCount = rowsBefore;
    } else if (
      verification.startRowCount !== null && verification.startRowCount !== undefined &&
      verification.endRowCount !== null && verification.endRowCount !== undefined &&
      verification.startRowCount > verification.endRowCount
    ) {
      movedCount = verification.startRowCount - verification.endRowCount;
    } else {
      movedCount = 0;
    }

    return { moved: true, count: movedCount };
  }

  // A stop that leaves labeled mail behind, phrased in plain words for
  // the recovery log page. The mail is untouched and stays recoverable,
  // so every one of these is inconvenient, never dangerous.
  function restoreStopMessage(reason, action) {
    const place = action === "archive" ? "All Mail" : "Trash";
    if (reason === "no-restore-control" || reason === "no-inbox-item") {
      return {
        status: "Could not find Gmail's Move to Inbox control.",
        detail: `Nothing was changed in this pass. The mail stays in ${place} and can still be moved back by hand.`
      };
    }
    if (reason === "rate-limited" || reason === "timeout") {
      return {
        status: "Gmail stopped responding to the restore.",
        detail: `The remaining mail stays in ${place}. Run Restore again in a few minutes to pick up where it left off.`
      };
    }
    return {
      status: "Restore stopped early.",
      detail: `Selection failed (${reason}). The remaining mail stays in ${place}.`
    };
  }

  async function restoreRun() {
    if (RUNNING) {
      debugLog("Run already in progress, ignoring restore request");
      return;
    }
    RUNNING = true;
    CANCELLED = false;
    const runStartedAt = Date.now();
    const originHash = location.hash;
    const action = CONFIG.restoreAction;
    let restoredTotal = 0;
    let completedClean = false;
    let stopReason = null;

    try {
      if (!isGmailTab()) {
        alert("Gmail Cleaner: please run this from a Gmail tab.");
        return;
      }

      const query = buildRestoreQuery(CONFIG.restoreLabel, action);
      if (!query) {
        safeSendImmediate({
          runKind: "restoreRun",
          phase: "error",
          status: "Restore could not start.",
          detail: "This run has no label recorded, so there is nothing safe to search for.",
          done: true,
          percent: 100,
          restoredCount: 0
        });
        return;
      }

      safeSendImmediate({
        runKind: "restoreRun",
        phase: "starting",
        status: "Restoring this run...",
        detail: query,
        percent: 0
      });

      let pass = 0;
      let retries = 0;
      while (pass < TIMING.PASS_CAP) {
        if (CANCELLED) throw new CancellationError("Restore run cancelled by user");

        try {
          await openSearch(query);

          if (hasNoResults()) {
            completedClean = true;
            break;
          }

          safeSendImmediate({
            runKind: "restoreRun",
            phase: "running",
            status: `Restoring (pass ${pass + 1})...`,
            detail: restoredTotal > 0
              ? `${restoredTotal.toLocaleString()} moved back to Inbox so far.`
              : "Selecting the run's mail.",
            percent: Math.min(90, 10 + pass * 20)
          });

          const result = await restoreCurrentPage();

          if (!result.moved) {
            // The list can empty between the search settling and the
            // pass starting; that is a finished restore, not a stop.
            if (result.reason === "no-results") {
              completedClean = true;
            } else {
              stopReason = result.reason;
            }
            break;
          }

          restoredTotal += result.count;
          pass++;
          retries = 0;
          deescalateBackoff();
          await sleep(TIMING.BETWEEN_PASS_SLEEP_MS);
        } catch (e) {
          if (e instanceof CancellationError || e instanceof GmailLayoutError) throw e;
          const isRL = e instanceof RateLimitError;
          const isTO = e instanceof TimeoutError;
          if (!isRL && !isTO) throw e;

          const elapsedMs = Date.now() - runStartedAt;
          if (elapsedMs > GUARDRAILS.QUERY_WALL_TIME_BUDGET_MS ||
              retries >= TIMING.RATE_LIMIT_MAX_RETRIES_PER_PASS) {
            stopReason = isRL ? "rate-limited" : "timeout";
            break;
          }
          retries++;
          safeSend({
            phase: "debug",
            detail: `Restore: retry ${retries}/${TIMING.RATE_LIMIT_MAX_RETRIES_PER_PASS} after ${isRL ? "rate limit" : "timeout"}`
          });
          await backoff(isRL ? "rate-limited" : "timeout", e?.message || String(e));
        }
      }

      // Only a clean completion (the search came back empty) marks the
      // log entries restored: a partial pass leaves labeled mail behind
      // that a later Restore should still be offered for. Re-running is
      // idempotent either way because the search only matches mail that
      // has not been moved back yet.
      if (completedClean && restoredTotal > 0 && hasChromeRuntime()) {
        try {
          chrome.runtime.sendMessage({
            type: "gmailCleanerRecordRestore",
            data: {
              tagLabel: CONFIG.restoreLabel,
              action,
              count: restoredTotal,
              startedAt: runStartedAt
            }
          });
        } catch (e) {
          debugLog("Failed to record restore outcome", { error: e?.message });
        }
      }

      if (!completedClean) {
        const stop = restoreStopMessage(stopReason || "unknown", action);
        safeSendImmediate({
          runKind: "restoreRun",
          phase: "error",
          status: stop.status,
          detail: restoredTotal > 0
            ? `${restoredTotal.toLocaleString()} conversation${restoredTotal === 1 ? " was" : "s were"} moved back to Inbox first. ${stop.detail}`
            : stop.detail,
          done: true,
          percent: 100,
          restoredCount: restoredTotal
        });
        return;
      }

      safeSendImmediate({
        runKind: "restoreRun",
        phase: "done",
        status: restoredTotal > 0
          ? `${restoredTotal.toLocaleString()} conversation${restoredTotal === 1 ? "" : "s"} moved back to Inbox.`
          : "Nothing left to restore for this run.",
        detail: restoredTotal > 0
          ? "The mail is back in your Inbox with the run's label still on it."
          : "The run's label matched no mail: it was already restored, or Gmail has emptied it from Trash.",
        percent: 100,
        done: true,
        restoredCount: restoredTotal
      });
    } catch (e) {
      if (e instanceof CancellationError) {
        safeSendImmediate({
          runKind: "restoreRun",
          phase: "cancelled",
          status: "Restore cancelled.",
          detail: restoredTotal > 0
            ? `${restoredTotal.toLocaleString()} conversation${restoredTotal === 1 ? " was" : "s were"} already moved back to Inbox. Run Restore again for the rest.`
            : "Stopped by user. Nothing was moved.",
          done: true,
          percent: 100,
          restoredCount: restoredTotal
        });
      } else {
        logError(e, "restore run");
        const errorPayload = {
          runKind: "restoreRun",
          phase: "error",
          status: "Restore failed.",
          detail: e instanceof Error ? e.message : String(e),
          done: true,
          percent: 100,
          restoredCount: restoredTotal
        };
        if (e instanceof GmailLayoutError) errorPayload.code = e.code;
        safeSendImmediate(errorPayload);
      }
    } finally {
      RUNNING = false;
      try {
        if (typeof window !== "undefined") window.GCC_ATTACHED = false;
      } catch {}
      try {
        if (originHash && location.hash !== originHash) location.hash = originHash;
      } catch {}
    }
  }

  function startRestoreRun() {
    if (!RUNNING) {
      restoreRun().catch((e) => logError(e, "startRestoreRun"));
    }
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

      // A cancel that lands during the last rule would otherwise fall
      // straight out of the loop and into the success summary, because the
      // check above only runs before a rule starts.
      if (CANCELLED) {
        throw new CancellationError("Run cancelled by user");
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

        const errorPayload = {
          phase: "error",
          status: "Error occurred.",
          detail: errorMessage,
          done: true,
          percent: 100
        };
        // 7.4: optional machine-readable marker so the popup can point
        // layout-change failures at Diagnostics. Additive only; the
        // message shape is otherwise unchanged.
        if (e instanceof GmailLayoutError) errorPayload.code = e.code;
        safeSendImmediate(errorPayload);

        debugLog("Run errored", { message: errorMessage });
      }
    } finally {
      RUNNING = false;
      // Clear the attach guard so the next Start (or re-inject) is not
      // blocked. The flag marks a run in progress; once main() exits the
      // page can accept a fresh run without a manual re-inject. It stays
      // set for the whole run, so concurrent injection is still blocked.
      try {
        if (typeof window !== "undefined") window.GCC_ATTACHED = false;
      } catch {}
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
      estimateTotalResults,
      sanitizeConfig,
      clickSelectAllConversations,
      handleBulkConfirmation,
      findMasterCheckbox,
      scoreCheckboxCandidate,
      extractSelectedCount,
      findMoreOptionsButton,
      findLabelMenuItemIn,
      findAllConversationsSelectedIndicator,
      // 7.4 layout-change detection + locale-audit fixtures
      GmailLayoutError,
      clickMasterCheckbox,
      openLabelInput,
      actOnCurrentPageIfAny,
      hasNoResults,
      getGridRowCount,
      sampleListRows,
      queryHasDangerousToken,
      sanitizeProtectKeywords,
      buildSubjectExclusion,
      buildFinalStats,
      SUBSCRIPTIONS,
      sampleSubscriptionRows,
      sanitizeSenderList,
      findHeaderUnsubscribeControl,
      resolveUnsubscribeDialog,
      // 7.5 locale fixtures
      findRateLimitText,
      findArchiveButton,
      findLabelButton,
      getSubscriptionSearchTerm,
      buildSubscriptionScanQueries,
      STORAGE_XRAY,
      foldStorageSample,
      estimateMbPerEmail,
      // 7.8 smart scan fixtures
      SMART_SCAN,
      smartSenderShape,
      sanitizeSmartKnownSenders,
      smartSenderWhitelisted,
      smartSenderProtected,
      buildSmartSignalQueries,
      buildSmartVetoQueries,
      countCurrentResults,
      scoreSmartSignals,
      gatherSmartSignals,
      runSmartVetoes,
      // 7.6 restore fixtures
      buildRestoreQuery,
      isDeleteForeverLabel,
      hasDeleteForeverMarking,
      findMoveToInboxButton,
      findMoveToMenuButton,
      findInboxMenuItemIn,
      driveMoveBackControl,
      restoreCurrentPage,
      // 8.0 mailbox report fixtures
      REPORT,
      REPORT_BANDS,
      reportScan
    };
  }

  // Injection bootstrap: the popup / service worker injects config, then
  // this file, and the run starts here. 7.0 routes by runKind so the
  // subscriptions engine shares one injection path with cleanups.
  if (CONFIG.runKind === "subscriptionScan") {
    startSubscriptionScan();
  } else if (CONFIG.runKind === "unsubscribe") {
    startUnsubscribeRun(CONFIG.unsubSenders);
  } else if (CONFIG.runKind === "storageScan") {
    startStorageScan();
  } else if (CONFIG.runKind === "smartScan") {
    startSmartScan();
  } else if (CONFIG.runKind === "reportScan") {
    startReportScan();
  } else if (CONFIG.runKind === "restoreRun") {
    startRestoreRun();
  } else {
    startMain();
  }
})();