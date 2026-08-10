// shared.js: Common utilities for Gmail One-Click Cleaner extension pages
// Extracted from popup.js, options.js, diagnostics.js, progress.js, stats.js
// to eliminate duplication across extension pages.

"use strict";

const GCC = (() => {
  // =========================
  // Chrome API Detection
  // =========================

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

  // =========================
  // Promisify Chrome APIs
  // =========================

  const promisify = (fn, ...args) =>
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

  // =========================
  // Storage Helpers
  // =========================

  const storageGet = async (area, keys) => {
    if (!hasChromeStorage(area)) return {};
    try {
      return await promisify(chrome.storage[area].get.bind(chrome.storage[area]), keys);
    } catch (e) {
      console.warn(`[GCC] storageGet(${area}) failed:`, e?.message || e);
      return {};
    }
  };

  const storageSet = async (area, obj) => {
    if (!hasChromeStorage(area)) return;
    await promisify(chrome.storage[area].set.bind(chrome.storage[area]), obj);
  };

  // =========================
  // Messaging
  // =========================

  // Returns the service worker's reply on success. On failure, returns
  // an object shaped { error, code } so callers (and diagnostics) can
  // tell why the send dropped instead of just seeing a null. Callers
  // reading resp?.field already fall through correctly: the error shape
  // has neither `stats` nor `log` etc.
  const sendMessage = (msg) =>
    new Promise((resolve) => {
      if (!hasChrome()) return resolve({ error: "chrome runtime unavailable", code: "no_chrome" });
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) {
            const text = lastErr.message || String(lastErr) || "no listener";
            resolve({ error: text, code: "send_failed" });
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        resolve({ error: e?.message || String(e) || "threw", code: "threw" });
      }
    });

  // =========================
  // Localization (7.13)
  // =========================
  // Wrapper over chrome.i18n with inline-English fallback. Pages keep
  // their English text in the markup / call sites; when a catalog
  // message exists for the browser's locale it wins, otherwise the
  // fallback ships unchanged. Test environments and the plain-HTTP
  // render harness have no chrome.i18n, so they always see English.

  const i18nRaw = (key, subs) => {
    try {
      if (typeof chrome !== "undefined" && chrome.i18n?.getMessage) {
        return chrome.i18n.getMessage(key, subs) || "";
      }
    } catch {
      // chrome.i18n unavailable (tests, plain pages) -> fallback wins
    }
    return "";
  };

  const t = (key, fallback, subs) => i18nRaw(key, subs) || fallback;

  // Static-markup pass: elements opt in with data-i18n (textContent)
  // and data-i18n-label / data-i18n-title / data-i18n-placeholder
  // (attributes). Elements with child markup keep their children: the
  // attribute goes on a plain span around the text instead.
  const I18N_ATTR_MAP = Object.freeze([
    ["data-i18n-label", "aria-label"],
    ["data-i18n-title", "title"],
    ["data-i18n-placeholder", "placeholder"]
  ]);

  const applyI18n = (root) => {
    const scope = root || (typeof document !== "undefined" ? document : null);
    if (!scope || !i18nRaw("appName")) return false;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      const msg = i18nRaw(el.getAttribute("data-i18n"));
      if (msg) el.textContent = msg;
    });
    for (const [dataAttr, attr] of I18N_ATTR_MAP) {
      scope.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
        const msg = i18nRaw(el.getAttribute(dataAttr));
        if (msg) el.setAttribute(attr, msg);
      });
    }
    return true;
  };

  const i18n = Object.freeze({ t, apply: applyI18n });

  // =========================
  // Install source (7.13)
  // =========================
  // chrome.management.getSelf needs no permission and reports how this
  // copy was installed. "normal" = store, "development" = unpacked,
  // "admin" = enterprise policy; "sideload"/"other" = planted by
  // third-party software, the exact channel abused for bot-farm user
  // inflation and repack distribution. Unknown errs toward trusted so
  // a flaky API can never lock out a real user.

  const INSTALL_SOURCE_KEY = "installSource";
  const UNTRUSTED_INSTALL_TYPES = Object.freeze(["sideload", "other"]);

  const installSourceIsUntrusted = (type) =>
    UNTRUSTED_INSTALL_TYPES.includes(String(type || ""));

  const getInstallSource = async () => {
    try {
      if (hasChrome() && chrome.management?.getSelf) {
        const info = await promisify(
          chrome.management.getSelf.bind(chrome.management)
        );
        if (info?.installType) return info.installType;
      }
    } catch {
      // fall through to the worker's cached value
    }
    const r = await storageGet("local", INSTALL_SOURCE_KEY);
    return r?.[INSTALL_SOURCE_KEY]?.installType || "unknown";
  };

  const installSource = Object.freeze({
    KEY: INSTALL_SOURCE_KEY,
    UNTRUSTED_TYPES: UNTRUSTED_INSTALL_TYPES,
    isUntrusted: installSourceIsUntrusted,
    get: getInstallSource
  });

  // =========================
  // DOM Helpers
  // =========================

  const $ = (id) => document.getElementById(id);

  const $$ = (sel) => document.querySelectorAll(sel);

  const qs = (sel) => {
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  };

  const createEl = (tag, attrs, children) => {
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
  };

  // =========================
  // Toast Notifications
  // =========================

  const TOAST_ICONS = Object.freeze({
    success: "\u2705",
    error: "\u274C",
    warning: "\u26A0\uFE0F",
    info: "\u2139\uFE0F"
  });

  const showToast = (message, type = "info", duration = 3000, containerSel = ".toast-container") => {
    const container = typeof containerSel === "string"
      ? document.querySelector(containerSel)
      : containerSel;

    if (!container) {
      console.log(`[Toast ${type}] ${message}`);
      return null;
    }

    const toast = createEl("div", {
      className: `toast toast-${type}`,
      role: "alert"
    });

    const icon = TOAST_ICONS[type];
    if (icon) {
      toast.appendChild(createEl("span", { "aria-hidden": "true", textContent: icon }));
    }
    toast.appendChild(createEl("span", { textContent: message }));

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));

    const timer = setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    }, duration);

    // Return a dismiss function
    return () => {
      clearTimeout(timer);
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    };
  };

  // =========================
  // Formatting
  // =========================

  const formatNumber = (n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) return "0";
    return n.toLocaleString();
  };

  const formatMb = (mb) => {
    if (!mb || mb < 0.01) return "0 MB";
    if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
    return mb.toFixed(1) + " MB";
  };

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

  const formatDuration = (ms) => {
    if (!ms) return "-";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m + "m " + (s % 60) + "s";
  };

  const formatDate = (ts) => {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return "-";
    }
  };

  const relativeTime = (ts) => {
    if (!ts || !Number.isFinite(ts)) return "-";
    const diff = Date.now() - ts;
    const justNow = t("relJustNow", "just now");
    if (diff < 0) return justNow;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return justNow;
    if (mins < 60) return t("relMinsAgo", mins + "m ago", [String(mins)]);
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t("relHoursAgo", hrs + "h ago", [String(hrs)]);
    const days = Math.floor(hrs / 24);
    return t("relDaysAgo", days + "d ago", [String(days)]);
  };

  // =========================
  // Security Helpers
  // =========================

  const HTML_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const HTML_ESCAPE_RE = /[&<>"']/g;

  const escapeHtml = (str) => {
    if (typeof str !== "string") return "";
    return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
  };

  // =========================
  // General Utilities
  // =========================

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  const debounce = (fn, delay) => {
    let timeoutId = null;
    return (...args) => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delay);
    };
  };

  const clone = (obj) => {
    if (typeof structuredClone === "function") {
      try { return structuredClone(obj); } catch { /* structuredClone may fail on non-cloneable objects, fall through */ }
    }
    try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
  };

  const truncate = (str, maxLength = 120) => {
    if (typeof str !== "string") return "";
    return str.length > maxLength ? str.slice(0, maxLength - 3) + "..." : str;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // =========================
  // Keyboard Shortcut Helper
  // =========================

  const onKeyboard = (bindings) => {
    document.addEventListener("keydown", (e) => {
      for (const binding of bindings) {
        const ctrl = binding.ctrl ?? false;
        const shift = binding.shift ?? false;
        const key = binding.key;

        const ctrlMatch = ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
        const shiftMatch = shift ? e.shiftKey : !e.shiftKey;

        if (e.key === key && ctrlMatch && shiftMatch) {
          e.preventDefault();
          binding.handler(e);
          return;
        }
      }
    });
  };

  // =========================
  // Theme Manager
  // =========================
  // System-aware light/dark theme. Stored preference takes priority.
  // Pages call theme.init() once after DOM ready; theme.toggle() flips
  // between light/dark, and theme.set("system") returns to OS preference.

  const THEME_KEY = "uiTheme";
  const VALID_THEMES = ["light", "dark", "system"];

  const resolveSystemTheme = () => {
    try {
      return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
      return "dark";
    }
  };

  const applyTheme = (theme) => {
    const resolved = theme === "system" ? resolveSystemTheme() : theme;
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-pref", theme);
  };

  const getStoredTheme = async () => {
    const r = await storageGet("local", THEME_KEY);
    const v = r?.[THEME_KEY];
    return VALID_THEMES.includes(v) ? v : "system";
  };

  const themeInit = async () => {
    const pref = await getStoredTheme();
    applyTheme(pref);
    try {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const listener = async () => {
        const current = await getStoredTheme();
        if (current === "system") applyTheme("system");
      };
      if (mq.addEventListener) mq.addEventListener("change", listener);
      else if (mq.addListener) mq.addListener(listener);
    } catch {
      // matchMedia listener unavailable in some test environments
    }
    return pref;
  };

  const themeSet = async (pref) => {
    if (!VALID_THEMES.includes(pref)) pref = "system";
    await storageSet("local", { [THEME_KEY]: pref });
    applyTheme(pref);
    return pref;
  };

  const themeToggle = async () => {
    const current = await getStoredTheme();
    const resolved = current === "system" ? resolveSystemTheme() : current;
    return await themeSet(resolved === "dark" ? "light" : "dark");
  };

  const theme = Object.freeze({
    init: themeInit,
    set: themeSet,
    get: getStoredTheme,
    toggle: themeToggle,
    resolveSystem: resolveSystemTheme
  });

  // =========================
  // Visibility-aware Polling
  // =========================
  // Pauses interval while the document is hidden so background tabs
  // do not waste CPU re-querying chrome.storage or re-rendering DOM.

  const pollingInterval = (fn, ms) => {
    let id = null;
    const start = () => {
      if (id !== null) return;
      id = setInterval(fn, ms);
    };
    const stop = () => {
      if (id === null) return;
      clearInterval(id);
      id = null;
    };
    const visHandler = () => {
      if (document.hidden) {
        stop();
      } else {
        // Run once immediately on resume so the user sees fresh data.
        try { fn(); } catch (e) { console.warn("[GCC] pollingInterval handler threw:", e); }
        start();
      }
    };
    document.addEventListener("visibilitychange", visHandler);
    if (!document.hidden) start();
    return () => {
      document.removeEventListener("visibilitychange", visHandler);
      stop();
    };
  };

  // =========================
  // Storage size + safe sync set
  // =========================
  // chrome.storage.sync has an 8KB-per-item / 102KB-total quota.
  // Hand-rolled estimator avoids depending on TextEncoder being polyfilled.

  const SYNC_LIMIT_ITEM = 8192;
  const SYNC_LIMIT_TOTAL = 102400;

  const estimateStorageBytes = (obj) => {
    try {
      return new Blob([JSON.stringify(obj ?? null)]).size;
    } catch {
      const s = JSON.stringify(obj ?? null) || "";
      return s.length * 2;
    }
  };

  const safeSyncSet = async (data, label = "data") => {
    if (!hasChromeStorage("sync")) {
      throw new Error("chrome.storage.sync not available");
    }
    for (const [key, value] of Object.entries(data || {})) {
      const size = estimateStorageBytes({ [key]: value });
      if (size > SYNC_LIMIT_ITEM) {
        throw new Error(
          `${label} too large for sync storage (${Math.round(size / 1024)}KB, max 8KB). ` +
          "Remove some entries or shorten values."
        );
      }
    }
    await storageSet("sync", data);
  };

  // =========================
  // Gmail Query Validation
  // =========================
  // Catches custom queries that would bypass global guards or hit
  // protected mail. The list mirrors the guard set in contentScript.js;
  // operators preceded by - (negation) are allowed.

  const DANGEROUS_QUERY_TOKENS = [
    "is:starred",
    "is:important",
    "label:starred",
    "label:important",
    "label:imap_starred",
    "in:sent",
    "in:drafts",
    // 8.10: `in:chats` is the operator Gmail documents, and the plural
    // walked straight past the singular entry that had guarded this
    // since the list was written. The matcher anchors each token with
    // \b, and the trailing "s" is a word character, so `in:chat\b` never
    // fired on `in:chats`. This file's own REPORT_HEADLINE_QUERY excludes
    // `-in:chats`, which is what gave the typo away. Both spellings stay
    // listed: neither belongs in a bulk-delete rule.
    "in:chat",
    "in:chats",
    "in:scheduled",
    // 8.8: Trash and Spam are the views where Gmail's delete control
    // means "Delete forever". A rule scoped to either destroys mail
    // permanently, and Restore cannot help because it looks for exactly
    // the `in:trash` mail such a rule removes. Kept in lockstep with the
    // engine's own copy in contentScript.js.
    "in:trash",
    "in:spam",
    // 8.12: the same three additions as the engine's copy, in lockstep.
    // `label:trash` / `label:spam` are Gmail synonyms for the two above,
    // so the 8.8 refusal only ever covered one spelling. `in:anywhere`
    // is a superset of both and sat on AGE_REQUIRED_TOKENS alone, so it
    // needed nothing but an age qualifier to reach mail that delete
    // removes permanently and Restore cannot find.
    "label:trash",
    "label:spam",
    "in:anywhere"
  ];

  // Operators that target the entire mailbox without an age filter make
  // it easy to delete recent mail. We require an age qualifier when these
  // are used so the user has to opt in explicitly.
  const AGE_REQUIRED_TOKENS = ["in:inbox", "in:all", "in:anywhere"];
  const AGE_QUALIFIERS = /\bolder_than:|newer_than:|after:|before:/i;

  // =========================
  // Protected keywords (subject shield)
  // =========================
  // A global, user-editable list of words/phrases that protect any
  // matching message by SUBJECT from every cleanup rule -- the content
  // complement to the sender whitelist. Mirrors the always-on Safe-Mode
  // subject guard but under the user's control. We sanitize aggressively
  // so a keyword can never break out of the `subject:( ... )` group it is
  // injected into: strip the quoting / grouping / boolean operators Gmail
  // would otherwise interpret, collapse whitespace, dedupe case-
  // insensitively, cap length and count. The failure mode of this feature
  // is always "protect more mail", which is the safe direction.

  const MAX_PROTECT_KEYWORDS = 25;
  const MAX_PROTECT_KEYWORD_LEN = 50;

  const sanitizeProtectKeywords = (input) => {
    const arr = Array.isArray(input)
      ? input
      : (typeof input === "string" ? input.split("\n") : []);
    const out = [];
    const seen = new Set();
    for (const raw of arr) {
      if (typeof raw !== "string") continue;
      // Drop characters that would terminate or re-scope the subject group
      // ( ) { } " and the leading - that would flip it to an exclusion.
      const cleaned = raw
        .replace(/["(){}]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[-\s]+/, "")
        .trim()
        .slice(0, MAX_PROTECT_KEYWORD_LEN)
        .trim();
      if (!cleaned) continue;
      // A bare boolean operator on its own is meaningless and dangerous.
      if (/^(or|and)$/i.test(cleaned)) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
      if (out.length >= MAX_PROTECT_KEYWORDS) break;
    }
    return out;
  };

  // Build a Gmail `-subject:( ... )` exclusion from sanitized keywords.
  // Multi-word phrases are quoted so they match as a phrase; single words
  // are left bare. Returns "" when there is nothing to protect.
  const buildSubjectExclusion = (keywords) => {
    const cleaned = sanitizeProtectKeywords(keywords);
    if (cleaned.length === 0) return "";
    const terms = cleaned.map((k) => (/\s/.test(k) ? `"${k}"` : k));
    return `-subject:(${terms.join(" OR ")})`;
  };

  // The project's own ceiling for a single Gmail search. 8.0 made it a
  // named constant because the Storage X-ray purge builder has to pack
  // addresses against it, and a second hardcoded 512 would drift.
  const MAX_QUERY_CHARS = 512;

  // Gmail age tokens ("6m", "1y") in days. The engine has its own copy
  // because a content script cannot reach GCC; a test pins the two
  // together over the whole token set, the same arrangement as
  // scoreSmartSignals.
  //
  // 8.9: added because the popup has to compare two ages that come from
  // two different controls. The Storage X-ray has its own age select,
  // and the run ALSO carries the Clean tab's Minimum Age, which
  // applyGlobalGuards appends whenever it is stricter. Whichever wins is
  // what the purge really does, and the caveat under the numbers has to
  // name that one.
  const AGE_TOKEN_DAYS = Object.freeze({ d: 1, w: 7, m: 30, y: 365 });

  const ageTokenDays = (token) => {
    const parsed = /^(\d+)\s*([dwmy])$/i.exec(String(token || "").trim());
    if (!parsed) return null;
    const n = parseInt(parsed[1], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n * AGE_TOKEN_DAYS[parsed[2].toLowerCase()];
  };

  // The stricter (older) of two age tokens, or null when neither is set.
  const strictestAgeToken = (a, b) => {
    const days = [a, b]
      .map((token) => ({ token, days: ageTokenDays(token) }))
      .filter((entry) => entry.days !== null);
    if (!days.length) return null;
    return days.reduce((max, entry) => (entry.days > max.days ? entry : max)).token;
  };

  const validateGmailQuery = (rawQuery) => {
    const errors = [];
    const warnings = [];
    const q = String(rawQuery || "").trim();

    if (!q) {
      errors.push("Query is empty");
      return { valid: false, errors, warnings };
    }
    if (q.length > MAX_QUERY_CHARS) {
      errors.push(`Query is too long (${q.length} chars, max ${MAX_QUERY_CHARS})`);
    }

    const lower = q.toLowerCase();

    // A leading "(" or "{" opens a group, so `(is:starred)` and Gmail's
    // OR-group `{is:starred is:unread}` are every bit as positive as the
    // bare token. The engine's copy of this test was anchored for the
    // paren in 7.14.2 and this one was not, so the Options page happily
    // saved a rule the engine then refused on every run: the user got a
    // "starred cleanup" that silently never ran. The brace form was worse
    // and is fixed on both sides here: nothing refused it at all.
    for (const token of DANGEROUS_QUERY_TOKENS) {
      const negated = new RegExp(`(^|[\\s({])-\\s*${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      const positive = new RegExp(`(^|[\\s({])${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      if (positive.test(lower) && !negated.test(lower)) {
        errors.push(`Query targets protected mail: "${token}". Add "-${token}" to exclude.`);
      }
    }

    for (const token of AGE_REQUIRED_TOKENS) {
      const re = new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      if (re.test(lower) && !AGE_QUALIFIERS.test(lower)) {
        warnings.push(`Query uses "${token}" with no age filter; consider adding "older_than:" so recent mail is protected.`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  };

  // =========================
  // Notifications
  // =========================
  // Lightweight wrapper around chrome.notifications. Best-effort; if the
  // API or permission is missing the call resolves false instead of
  // throwing so callers can keep going.

  const notify = async ({ title, message, iconUrl, id = "" } = {}) => {
    try {
      if (typeof chrome === "undefined" || !chrome.notifications?.create) return false;
      // Only the four properties every browser accepts. Firefox rejects
      // notification options it does not implement (e.g. priority) with
      // a type error instead of ignoring them.
      const opts = {
        type: "basic",
        iconUrl: iconUrl || (chrome.runtime?.getURL?.("icons/icon128.png") || ""),
        title: String(title || "Gmail Cleaner"),
        message: String(message || "")
      };
      return await new Promise((resolve) => {
        try {
          chrome.notifications.create(id || "", opts, () => {
            const err = chrome.runtime?.lastError;
            if (err) {
              console.warn("[GCC] notification failed:", err.message || err);
              resolve(false);
            } else {
              resolve(true);
            }
          });
        } catch (e) {
          console.warn("[GCC] notify threw:", e?.message || e);
          resolve(false);
        }
      });
    } catch {
      return false;
    }
  };

  // =========================
  // Download helper (JSON / text)
  // =========================

  const downloadFile = ({ filename, data, type = "application/json" }) => {
    const blob = data instanceof Blob ? data : new Blob([typeof data === "string" ? data : JSON.stringify(data, null, 2)], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch {}
      URL.revokeObjectURL(url);
    }, 200);
  };

  // =========================
  // Error classification for chrome messaging
  // =========================
  // Distinguishes "tab closed / no listener" (recoverable, often expected
  // when the popup closes faster than the content script attaches) from
  // permission/host errors (user action required) and unknown failures.

  const TAB_CLOSED_FRAGMENTS = [
    "receiving end does not exist",
    "no tab with id",
    "tab was closed",
    "the message port closed",
    "could not establish connection"
  ];
  const PERMISSION_FRAGMENTS = [
    "cannot access",
    "blocked by client",
    "cannot be scripted",
    "extensions can't access",
    "the extensions gallery cannot be scripted"
  ];

  const classifyChromeError = (err) => {
    const msg = String(err?.message || err || "").toLowerCase();
    if (!msg) return { kind: "unknown", message: "" };
    if (TAB_CLOSED_FRAGMENTS.some((f) => msg.includes(f))) {
      return { kind: "tab_closed", message: msg };
    }
    if (PERMISSION_FRAGMENTS.some((f) => msg.includes(f))) {
      return { kind: "permission", message: msg };
    }
    return { kind: "other", message: msg };
  };

  // =========================
  // Pro license (7.0)
  // =========================
  // Lifetime Pro keys are minted server-side at purchase and verified
  // HERE, locally, against the embedded public key. The extension never
  // phones home: no activation server, no license pings, nothing. A key
  // is three dot-separated parts: "GCC1.<payload b64url>.<sig b64url>"
  // where sig is an ECDSA P-256 / SHA-256 signature (raw r||s) over the
  // exact payload bytes.

  const PRO = Object.freeze({
    PRICE_LABEL: "$9.99 lifetime",
    BUY_URL: "https://buy.stripe.com/7sY4gA07N9RE1MIc3VdUY04",
    SUPPORT_URL: "https://github.com/TiltedLunar123/gmail-one-click-cleaner#pro",
    // Self-serve key recovery: re-issues the key to the address that
    // paid, for buyers who no longer have the post-checkout link.
    RECOVER_URL: "https://gmail-cleaner-pro.netlify.app/recover.html",
    SUPPORT_EMAIL: "hilgendorfjude@gmail.com",
    STORAGE_KEY: "proLicense",
    // 8.13: a refund window, promised in the product and not only on
    // the buy page. Every surface that quotes it reads it from here, so
    // the window can never say 30 days in one place and 14 in another.
    //
    // Worth knowing before changing this: a refunded key keeps working.
    // Verification is offline by design, there is no revocation list,
    // and adding one would mean the extension phoning home, which is
    // the one thing the whole product promises it never does. So the
    // guarantee is honoured on trust, and the honest reading is that it
    // costs a refunded sale rather than buying back the licence.
    GUARANTEE_DAYS: 30,
    GUARANTEE_LABEL: "30-day money-back guarantee"
  });

  // What the one payment actually buys, in the order the popup presents
  // them. This list exists because there was no single answer: the
  // Options page told buyers "Bulk unsubscribe is unlocked", which was
  // the whole truth in 7.0 and has been wrong since 7.2, 7.8, 7.12 and
  // 8.0 each added a pillar without touching that sentence. Someone who
  // paid $9.99 read it and was told they had bought one fifth of it.
  const PRO_FEATURES = Object.freeze([
    "Bulk unsubscribe from every mailing list you tick",
    // 8.13: the ranked list itself is free now, so this line names only
    // what the payment actually adds. Selling someone a list they can
    // already see is the same defect the comment above describes, just
    // pointing the other way.
    "The one-click Storage X-ray purge, for the senders you tick",
    "The full Smart Suggestions list, and bulk apply",
    "Every step of the Mailbox Report, and the whole-plan run",
    "Auto-Pilot, the weekly sweep that archives without being asked",
    "Pro Settings: your own recovery label, the Auto-Pilot interval, and a deeper Smart scan"
  ]);

  const LICENSE_PUBLIC_JWK = Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: "H__q7WFppVTV82Txv9zzk-D_uiTwt5qDda_wYvUlq_8",
    y: "3o5uhLw4utuNyDMaGJrIY3Dgbw14PVPWlsMg68lpFhY"
  });

  const b64urlToBytes = (input) => {
    const b64 = String(input).replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  // Parse without verifying: shape check + payload decode.
  const parseLicenseKey = (rawKey) => {
    const key = String(rawKey || "").trim();
    const parts = key.split(".");
    if (parts.length !== 3 || parts[0] !== "GCC1") {
      return { ok: false, reason: "That does not look like a license key." };
    }
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
      return { ok: false, reason: "The key contains invalid characters." };
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    } catch {
      return { ok: false, reason: "The key payload is unreadable." };
    }
    if (!payload || payload.v !== 1 || payload.plan !== "pro") {
      return { ok: false, reason: "The key payload is not a Pro license." };
    }
    return { ok: true, key, payloadPart: parts[1], sigPart: parts[2], payload };
  };

  // Full cryptographic verification. Returns { valid, reason, payload }.
  // jwkOverride exists so the test suite can verify against an ephemeral
  // keypair; production callers pass only the key.
  const verifyLicense = async (rawKey, jwkOverride = null) => {
    const parsed = parseLicenseKey(rawKey);
    if (!parsed.ok) return { valid: false, reason: parsed.reason, payload: null };
    try {
      const pubKey = await crypto.subtle.importKey(
        "jwk",
        jwkOverride || LICENSE_PUBLIC_JWK,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      const valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pubKey,
        b64urlToBytes(parsed.sigPart),
        new TextEncoder().encode(parsed.payloadPart)
      );
      return valid
        ? { valid: true, reason: "", payload: parsed.payload }
        : { valid: false, reason: "The key signature is invalid.", payload: null };
    } catch (e) {
      return { valid: false, reason: "Verification failed: " + (e?.message || "unknown error"), payload: null };
    }
  };

  // Read the stored key (sync storage, follows the user across devices)
  // and verify it. Never throws.
  // =========================
  // Where the licence lives (8.6)
  // =========================
  // It used to live in chrome.storage.sync alone, which is one area and
  // therefore one way to lose it. sync is the right primary (it roams to
  // the buyer's other machines) but it is also the one that fails: it
  // has an 8KB per-item ceiling, a write quota, and it is the area that
  // goes away under enterprise policy or a signed-out profile.
  //
  // The key is now written to BOTH areas and read from either, and
  // whichever copy is missing gets healed from the one that survived. A
  // paid key should take two independent failures to lose, not one.
  //
  // What this cannot cover: chrome.storage of both kinds is scoped to
  // the extension ID, so a build loaded from a new folder is a new
  // extension with empty storage. That is what the manifest `key` in
  // the unpacked build is for.

  const readLicenseArea = async (area) => {
    try {
      const data = await storageGet(area, [PRO.STORAGE_KEY]);
      const value = data?.[PRO.STORAGE_KEY];
      return typeof value === "string" && value ? value : "";
    } catch {
      return "";
    }
  };

  // Everything stored, sync first, deduped. getState walks the whole
  // list rather than stopping at the first non-empty string: a stale or
  // corrupt value in one area must not be able to shadow a good key in
  // the other, which is the entire reason for keeping two.
  const readLicenseCandidates = async () => {
    const out = [];
    const seen = new Set();
    for (const area of ["sync", "local"]) {
      const key = await readLicenseArea(area);
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push({ key, from: area });
      }
    }
    return out;
  };

  // "What is stored", for callers that want the raw answer.
  const readStoredLicenseKey = async () => {
    const candidates = await readLicenseCandidates();
    return candidates[0] || { key: "", from: null };
  };

  // Put a verified key back into whichever area lost it. Only ever
  // called for a key that verified: copying an unverifiable string
  // around would just spread it.
  const healLicenseCopy = async (key, from) => {
    const other = from === "sync" ? "local" : "sync";
    try {
      const existing = await storageGet(other, [PRO.STORAGE_KEY]);
      if (existing?.[PRO.STORAGE_KEY] === key) return;
      if (other === "sync") await safeSyncSet({ [PRO.STORAGE_KEY]: key }, "license key");
      else await storageSet("local", { [PRO.STORAGE_KEY]: key });
    } catch {
      // The surviving copy is still doing its job.
    }
  };

  // Both areas, and a success in either is a success. A key that reached
  // only one of them is still a key the user keeps.
  const writeLicenseKey = async (rawKey) => {
    const value = typeof rawKey === "string" ? rawKey : "";
    const results = await Promise.allSettled([
      safeSyncSet({ [PRO.STORAGE_KEY]: value }, "license key"),
      storageSet("local", { [PRO.STORAGE_KEY]: value })
    ]);
    const wrote = results.filter((r) => r.status === "fulfilled").length;
    if (!wrote) {
      throw results[0]?.reason || new Error("Could not save the key to storage.");
    }
    return { syncOk: results[0].status === "fulfilled", localOk: results[1].status === "fulfilled" };
  };

  // jwkOverride mirrors verifyLicense's: it exists so the suite can
  // drive this against an ephemeral keypair instead of needing the
  // production signing key to be present anywhere near a test.
  const getLicenseState = async (jwkOverride) => {
    try {
      const candidates = await readLicenseCandidates();
      if (!candidates.length) return { active: false, key: "", payload: null };
      let lastCheck = null;
      for (const candidate of candidates) {
        const check = await verifyLicense(candidate.key, jwkOverride);
        lastCheck = check;
        if (!check.valid) continue;
        await healLicenseCopy(candidate.key, candidate.from);
        return { active: true, key: candidate.key, payload: check.payload };
      }
      // Nothing verified. Report the last reason rather than inventing
      // one, and hand back no key.
      return { active: false, key: "", payload: lastCheck?.payload || null };
    } catch {
      return { active: false, key: "", payload: null };
    }
  };

  // Which Pro gate sent someone to checkout. Stripe stores this on the
  // Checkout Session as client_reference_id, so `npm run analytics`
  // can answer "which upsell actually converts" from the sales record
  // itself. This is NOT telemetry: nothing is sent from the extension,
  // nothing is recorded for people who do not buy, and the value is a
  // fixed surface label with no user data in it. Stripe silently drops
  // an unusable value, and the sanitiser below can only ever produce a
  // usable one, so checkout cannot break here.
  const buyUrl = (source) => {
    const clean = String(source || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    return clean ? `${PRO.BUY_URL}?client_reference_id=gcc_${clean}` : PRO.BUY_URL;
  };

  const license = Object.freeze({
    PRO,
    FEATURES: PRO_FEATURES,
    parse: parseLicenseKey,
    verify: verifyLicense,
    getState: getLicenseState,
    read: readStoredLicenseKey,
    save: writeLicenseKey,
    buyUrl
  });

  // =========================
  // Pro settings (8.12)
  // =========================
  // Three knobs a licence unlocks. They are settings on machinery Pro
  // already owns, never a fence around something that used to be free:
  // every default below is exactly what the extension did in 8.11, so a
  // free install, a copy whose key was removed, and a Pro user who never
  // opens this card all behave identically.
  //
  // `effective()` is the ONLY supported way to read them, and it takes
  // the licence state as an argument. Reading storage.sync directly
  // would leave a value chosen while Pro was active still applying after
  // the key is removed, which is the one way a setting like this can
  // quietly change what an unattended run does.
  const PRO_SETTINGS_KEY = "proSettings";

  const PRO_SETTINGS_DEFAULTS = Object.freeze({
    // The recovery label tag-before-delete writes. The engine has
    // defaulted this to "GmailCleaner" since v3; it simply had no UI.
    labelPrefix: "GmailCleaner",
    // Auto-Pilot's sweep interval. Weekly is what 7.12 shipped.
    autoPilotIntervalDays: 7,
    // How many senders the Smart scan measures before ranking.
    smartScanDepth: "standard",

    // 8.13. Same rule as the three above: every default is what 8.12
    // did, so a free install and an untouched card are identical.
    //
    // How many senders one unattended sweep acts on. 25 is
    // AUTOPILOT_MAX_PER_RUN, hardcoded since 7.12.
    autoPilotMaxSenders: 25,
    // An age floor Auto-Pilot adds on top of everything else. Empty is
    // 8.12's behaviour: the sweep already carries the rule's own
    // older_than and the Clean tab's Minimum Age, and this can only
    // ever be stacked on when it is STRICTER than both, so it narrows
    // an unattended run and can never widen one.
    autoPilotMinAge: "",
    // How many recovery-log entries survive. One entry per rule per
    // run, capped at 60 since 8.0. Raising it lengthens the window in
    // which a run can still be restored, and costs only local storage.
    undoLogEntries: 60
  });

  const PRO_SETTINGS_LIMITS = Object.freeze({
    LABEL_MAX: 32,
    INTERVAL_DAYS: Object.freeze([7, 14, 30]),
    DEPTHS: Object.freeze(["standard", "deep"]),
    MAX_SENDERS: Object.freeze([10, 25, 50]),
    // "" is a real choice here, not a missing one: it means "add no
    // floor of my own". It has to stay in the allow-list for that
    // reason, and nothing may test this value for truthiness.
    MIN_AGES: Object.freeze(["", "1m", "3m", "6m", "1y"]),
    UNDO_ENTRIES: Object.freeze([60, 150, 300]),
    // Signal and veto budgets move TOGETHER. The engine measures at most
    // SIGNAL senders and then runs correspondence vetoes on at most VETO
    // of them; raising the first alone would let the scan measure twenty
    // senders and then silently drop five before they could be vetted.
    DEPTH_SIGNAL_SENDERS: Object.freeze({ standard: 10, deep: 20 }),
    DEPTH_VETO_SENDERS: Object.freeze({ standard: 15, deep: 30 })
  });

  // Gmail label rules that actually matter here. A double quote would
  // break `label:"<name>"`, which is the query one-click Restore is built
  // on, so a prefix carrying one would produce runs that cannot be
  // undone. A forward slash makes Gmail nest the label instead of
  // creating it, which silently files recovery tags somewhere else.
  const LABEL_PREFIX_BANNED_RE = /["\\/]|[\u0000-\u001f]/;

  const validateLabelPrefix = (raw) => {
    const collapsed = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!collapsed) {
      return { ok: true, value: PRO_SETTINGS_DEFAULTS.labelPrefix, reset: true, error: "" };
    }
    if (collapsed.length > PRO_SETTINGS_LIMITS.LABEL_MAX) {
      return { ok: false, value: "", error: `Keep the label under ${PRO_SETTINGS_LIMITS.LABEL_MAX + 1} characters.` };
    }
    if (LABEL_PREFIX_BANNED_RE.test(collapsed)) {
      return { ok: false, value: "", error: 'A label cannot contain " \\ / or control characters.' };
    }
    return { ok: true, value: collapsed, reset: false, error: "" };
  };

  const proSettingsEffective = (stored, isPro) => {
    const out = { ...PRO_SETTINGS_DEFAULTS };
    if (!isPro || !stored || typeof stored !== "object") return out;

    const label = validateLabelPrefix(stored.labelPrefix);
    if (label.ok) out.labelPrefix = label.value;

    const days = Number(stored.autoPilotIntervalDays);
    if (PRO_SETTINGS_LIMITS.INTERVAL_DAYS.includes(days)) out.autoPilotIntervalDays = days;

    const depth = String(stored.smartScanDepth || "");
    if (PRO_SETTINGS_LIMITS.DEPTHS.includes(depth)) out.smartScanDepth = depth;

    const senders = Number(stored.autoPilotMaxSenders);
    if (PRO_SETTINGS_LIMITS.MAX_SENDERS.includes(senders)) out.autoPilotMaxSenders = senders;

    // Deliberately NOT `stored.autoPilotMinAge || ""`: the empty string
    // is the "no extra floor" choice, and an allow-list membership test
    // is the only read that treats it as the answer it is.
    if (typeof stored.autoPilotMinAge === "string"
      && PRO_SETTINGS_LIMITS.MIN_AGES.includes(stored.autoPilotMinAge)) {
      out.autoPilotMinAge = stored.autoPilotMinAge;
    }

    const undoEntries = Number(stored.undoLogEntries);
    if (PRO_SETTINGS_LIMITS.UNDO_ENTRIES.includes(undoEntries)) out.undoLogEntries = undoEntries;

    return out;
  };

  // The two numbers the Smart scan config carries. Kept as one function
  // per budget so a caller cannot send one and forget the other.
  const smartScanBudget = (depth) => {
    const key = PRO_SETTINGS_LIMITS.DEPTHS.includes(depth) ? depth : "standard";
    return {
      smartSignalSenders: PRO_SETTINGS_LIMITS.DEPTH_SIGNAL_SENDERS[key],
      smartVetoSenders: PRO_SETTINGS_LIMITS.DEPTH_VETO_SENDERS[key]
    };
  };

  const readProSettings = async (isPro) => {
    const stored = await storageGet("sync", PRO_SETTINGS_KEY);
    return proSettingsEffective(stored?.[PRO_SETTINGS_KEY], isPro);
  };

  const proSettings = Object.freeze({
    KEY: PRO_SETTINGS_KEY,
    DEFAULTS: PRO_SETTINGS_DEFAULTS,
    LIMITS: PRO_SETTINGS_LIMITS,
    validateLabelPrefix,
    effective: proSettingsEffective,
    smartScanBudget,
    read: readProSettings
  });

  // =========================
  // Browser + store identity (7.1)
  // =========================
  // The extension ships from three stores. Store-facing links (rating
  // prompt, share button) resolve per browser at runtime via userAgent:
  // Edge carries "Edg/", Firefox carries "Firefox/", every other
  // Chromium falls back to the Chrome Web Store. Edge users are pointed
  // at the Chrome listing on purpose: the extension installs from there
  // in Edge and reviews pool in one place. The Firefox listing URL uses
  // the gecko add-on ID, which AMO resolves regardless of what slug the
  // listing ends up with.

  const CWS_LISTING = "https://chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc";
  const AMO_LISTING = "https://addons.mozilla.org/firefox/addon/gmail-one-click-cleaner@gmail-cleaner-pro.netlify.app/";

  // 8.6: the published policy, the same URL both store listings point
  // at, so what the extension shows and what the stores show cannot
  // drift. Hosted rather than bundled on purpose: a copy shipped inside
  // the package is frozen at whatever the last release said, and a
  // stale privacy policy is worse than none. Opening it is a link, not
  // a request: the extension still makes no network calls of its own.
  const PRIVACY_URL = "https://secplusmastery.com/extensions#gmail-one-click-cleaner-privacy";

  const detectBrowser = (uaOverride) => {
    const ua = String(
      uaOverride ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")
    );
    if (/\bFirefox\//.test(ua)) return "firefox";
    if (/\bEdg\//.test(ua)) return "edge";
    return "chrome";
  };

  const storeLinks = (uaOverride) => {
    const which = detectBrowser(uaOverride);
    if (which === "firefox") {
      return { browser: which, listing: AMO_LISTING, reviews: AMO_LISTING + "reviews/" };
    }
    return { browser: which, listing: CWS_LISTING, reviews: CWS_LISTING + "/reviews" };
  };

  // =========================
  // Gmail host access (7.1)
  // =========================
  // Chrome and Edge grant host_permissions at install. Firefox (127+)
  // does too, but the user can revoke them any time from about:addons,
  // and older profiles may carry the pre-127 not-granted default.
  // check() errs toward true so the grant banner can never block a
  // browser where the permissions API misbehaves; a genuinely missing
  // grant still surfaces when injection fails, and the banner shows on
  // the next popup open. request() must run inside a user gesture.

  const GMAIL_ORIGINS = Object.freeze({ origins: ["https://mail.google.com/*"] });

  const gmailAccess = Object.freeze({
    ORIGINS: GMAIL_ORIGINS,
    check: async () => {
      try {
        if (!hasChrome() || !chrome.permissions?.contains) return true;
        return Boolean(await promisify(
          chrome.permissions.contains.bind(chrome.permissions),
          GMAIL_ORIGINS
        ));
      } catch {
        return true;
      }
    },
    request: async () => {
      try {
        if (!hasChrome() || !chrome.permissions?.request) return false;
        return Boolean(await promisify(
          chrome.permissions.request.bind(chrome.permissions),
          GMAIL_ORIGINS
        ));
      } catch {
        return false;
      }
    }
  });

  // =========================
  // Storage X-ray (7.2)
  // =========================
  // Pure logic for the storage feature: the engine's tiered scan sends
  // per-sender lower-bound MB estimates; these helpers rank them for
  // display and build the Pro purge query. The purge is an ordinary
  // cleanup run (rulesOverride), so every guard, the tag-before-delete
  // safety net and the recovery log apply to it unchanged.

  // Strict email shape doubles as query-injection protection: anything
  // that passes cannot break out of the from:(...) group it is placed
  // in. Mirrors the engine's unsubscribe sender validation.
  const STORAGE_EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.][a-z0-9!#$%&'*+/=?^_`{|}~.-]*@[a-z0-9.-]+\.[a-z]{2,}$/;

  const STORAGE_XRAY_LIMITS = Object.freeze({
    MAX_PURGE_PER_RUN: 25,
    MAX_LIST: 100,
    FREE_VISIBLE: 3,
    // Matches the smallest scan tier so a purge only ever touches mail
    // the X-ray actually counted.
    PURGE_SIZE_FLOOR: "larger:5M",
    VALID_AGES: Object.freeze(["", "6m", "1y", "2y"])
  });

  const sanitizeStorageEmails = (input) => {
    if (!Array.isArray(input)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of input) {
      if (typeof raw !== "string") continue;
      const email = raw.trim().toLowerCase();
      if (!email || email.length > 320) continue;
      if (!STORAGE_EMAIL_RE.test(email)) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      out.push(email);
      if (out.length >= STORAGE_XRAY_LIMITS.MAX_PURGE_PER_RUN) break;
    }
    return out;
  };

  // "" when nothing valid survives; callers must treat that as a no-op.
  //
  // 8.0: this used to return one string, and 25 long addresses produced
  // ~1,270 characters against the project's own 512-char ceiling in
  // validateGmailQuery, which the rulesOverride path never called. The
  // builder now packs addresses into as many from:() groups as the
  // ceiling allows and returns them all; the purge runs them as ordinary
  // multi-rule cleanup, which the engine already does. buildPurgeQuery
  // keeps its single-string shape for existing callers and tests, and
  // returns the FIRST chunk only when the list overflows, so nothing can
  // silently emit an over-length query again.
  const purgeQueryChunks = (emails, age = "") => {
    const clean = sanitizeStorageEmails(emails);
    if (clean.length === 0) return [];
    const ageToken = STORAGE_XRAY_LIMITS.VALID_AGES.includes(age) && age
      ? ` older_than:${age}`
      : "";
    const suffix = `) ${STORAGE_XRAY_LIMITS.PURGE_SIZE_FLOOR}${ageToken}`;
    const budget = MAX_QUERY_CHARS - "from:(".length - suffix.length;

    const out = [];
    let group = [];
    let groupLen = 0;
    for (const email of clean) {
      // " OR " only costs anything from the second address onward.
      const cost = email.length + (group.length ? 4 : 0);
      if (group.length && groupLen + cost > budget) {
        out.push(`from:(${group.join(" OR ")}${suffix}`);
        group = [];
        groupLen = 0;
      }
      // A single address longer than the whole budget cannot be packed;
      // dropping it is the safe failure (the purge just misses a sender)
      // and sanitizeStorageEmails already caps addresses at 320 chars.
      if (email.length > budget) continue;
      group.push(email);
      groupLen += group.length === 1 ? email.length : cost;
    }
    if (group.length) out.push(`from:(${group.join(" OR ")}${suffix}`);
    return out;
  };

  const buildStoragePurgeQuery = (emails, age = "") => {
    const chunks = purgeQueryChunks(emails, age);
    return chunks.length ? chunks[0] : "";
  };

  // Normalize a stored/scanned sender list for display: shape-check,
  // rank by estimated MB (count breaks ties), cap the list.
  const rankStorageSenders = (senders) => {
    if (!Array.isArray(senders)) return [];
    return senders
      .filter((s) => s && typeof s.email === "string" && STORAGE_EMAIL_RE.test(s.email))
      .map((s) => ({
        email: s.email,
        name: typeof s.name === "string" ? s.name.slice(0, 120) : "",
        count: Math.max(1, Math.min(99999, Number(s.count) || 1)),
        estMb: Math.max(0, Math.min(1024 * 1024, Math.round(Number(s.estMb) || 0))),
        status: typeof s.status === "string" ? s.status.slice(0, 30) : "",
        statusAt: Number(s.statusAt) || 0
      }))
      .sort((a, b) => b.estMb - a.estMb || b.count - a.count)
      .slice(0, STORAGE_XRAY_LIMITS.MAX_LIST);
  };

  const storageXray = Object.freeze({
    LIMITS: STORAGE_XRAY_LIMITS,
    sanitizeEmails: sanitizeStorageEmails,
    buildPurgeQuery: buildStoragePurgeQuery,
    buildPurgeQueries: purgeQueryChunks,
    rankSenders: rankStorageSenders
  });

  // =========================
  // Mailbox Report (8.0)
  // =========================
  // The report is one read-only scan that renders the whole mailbox as a
  // ranked cleanup plan. Every band below is a plain Gmail search the
  // engine already knows how to run: openSearch, then read the result
  // count. No new selectors, no new Gmail verbs, nothing opened.
  //
  // Two rules keep the numbers honest:
  //   1. Only the three size bands carry an MB figure, they are mutually
  //      disjoint (larger:/smaller: pairs), and each email is credited
  //      its tier FLOOR. So the headline is a defensible "at least".
  //   2. Noise and inbox bands overlap the size bands and each other, so
  //      their counts are never summed into a headline figure. A plan run
  //      passes them as separate rules and reports what actually moved.
  //
  // Nothing here reconciles against Google's 15 GB bar: that quota is
  // shared with Drive and Photos and the extension can never see it.

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

  // Scoped away from mail no band could ever match and no run would
  // ever touch. A bare `older_than:6m` searches all mail, which
  // includes Sent, Drafts and Chats, so a mailbox full of sent mail
  // produced a five-figure headline over a plan with no steps in it.
  // in:sent and in:drafts are on the refusal list precisely because
  // the cleaner must never act on them; counting them as an
  // opportunity was the same mistake pointed the other way.
  const REPORT_HEADLINE_QUERY = "older_than:6m -in:sent -in:drafts -in:chats";

  const REPORT_LIMITS = Object.freeze({
    // One headline query plus one per band, with headroom. The engine
    // asserts against this so a future band cannot quietly turn a fast
    // scan into a minutes-long one (smartScan already spends up to 63).
    MAX_QUERIES: 15,
    MAX_PLAN_RULES: 10,
    // Senders are attributed for the two biggest bands only; the sample
    // is what Gmail already rendered on screen.
    SENDER_SAMPLE_CAP: 25,
    TOP_SENDERS: 5,
    MAX_COUNT: 10000000
  });

  const REPORT_BAND_BY_ID = new Map(REPORT_BANDS.map((b) => [b.id, b]));

  const buildReportQueries = () => {
    const out = [{ id: "__headline", query: REPORT_HEADLINE_QUERY }];
    for (const band of REPORT_BANDS) out.push({ id: band.id, query: band.query });
    return out;
  };

  const clampReportCount = (value) => {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, REPORT_LIMITS.MAX_COUNT);
  };

  // rawCounts: { [bandId]: number }. Unknown ids are dropped, missing
  // ids become zero-count bands so the report always has a full shape.
  const foldReportBands = (rawCounts) => {
    const counts = rawCounts && typeof rawCounts === "object" ? rawCounts : {};
    return REPORT_BANDS.map((band) => {
      const count = clampReportCount(counts[band.id]);
      return {
        id: band.id,
        kind: band.kind,
        action: band.action,
        query: band.query,
        count,
        estMb: band.mbFloor ? count * band.mbFloor : 0
      };
    });
  };

  // Deterministic: MB first, then count, then the order bands are
  // declared in. Ties never depend on object key order, so the free band
  // is the same on every render of the same scan.
  const rankReportBands = (bands) => {
    const list = Array.isArray(bands) ? bands.filter((b) => b && REPORT_BAND_BY_ID.has(b.id)) : [];
    const order = new Map(REPORT_BANDS.map((b, i) => [b.id, i]));
    return list
      .map((b) => {
        const def = REPORT_BAND_BY_ID.get(b.id);
        const count = clampReportCount(b.count);
        return {
          id: b.id,
          kind: def.kind,
          action: def.action,
          query: def.query,
          count,
          // Derived, never trusted from the caller. The headline says
          // "at least N MB", and that is only honest while every MB
          // figure is this band's own floor times a clamped count. A
          // stored report that came back corrupted would otherwise
          // inflate the one number the copy promises is conservative.
          estMb: def.mbFloor ? count * def.mbFloor : 0,
          // 8.10: carried, not rebuilt. 8.9 taught the engine to mark a
          // band whose search timed out so the popup could say "not
          // measured" instead of printing a confident 0, and the worker
          // persists the flag -- but this function rebuilds every band
          // from the field list above, and `measured` was not on it. The
          // popup re-ranks at ingest AND at render, so the flag died
          // before it ever reached the branch written to read it and the
          // whole honesty fix has never once appeared on screen. Absent
          // still means true, the same reading the worker uses.
          measured: b.measured !== false,
          cleanedAt: Number(b.cleanedAt) || 0
        };
      })
      .sort((a, b) =>
        b.estMb - a.estMb ||
        b.count - a.count ||
        order.get(a.id) - order.get(b.id));
  };

  // The one band a free user may act on, so the mechanism proves itself
  // on their own mail before they are asked for money. Structural, not a
  // counter: the same scan always yields the same band.
  const freeReportBandId = (bands) => {
    const ranked = rankReportBands(bands);
    for (const band of ranked) {
      if (band.count > 0) return band.id;
    }
    return null;
  };

  const reportTotals = (bands) => {
    const ranked = rankReportBands(bands);
    let largeMb = 0;
    let bandedCount = 0;
    for (const band of ranked) {
      if (band.kind === "size") largeMb += band.estMb;
      bandedCount += band.count;
    }
    return { largeMb, bandedCount };
  };

  // Queries for a purge run. Every one is re-validated here because this
  // is the last stop before the destructive path: an id that is not a
  // known band, or a query that trips the dangerous-token matcher or the
  // length ceiling, is dropped rather than run.
  const bandPurgeRules = (bandIds) => {
    if (!Array.isArray(bandIds)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of bandIds) {
      if (typeof raw !== "string") continue;
      const band = REPORT_BAND_BY_ID.get(raw);
      if (!band || seen.has(band.id)) continue;
      seen.add(band.id);
      const check = validateGmailQuery(band.query);
      if (!check.valid) continue;
      out.push(band.query);
      if (out.length >= REPORT_LIMITS.MAX_PLAN_RULES) break;
    }
    return out;
  };

  // Which steps "Run the whole plan" actually runs, 8.7.
  //
  // A run carries ONE archiveInsteadOfDelete for all of its rules, and
  // the plan used to pass every remaining step into a single run with
  // `archive = bands.some(archive)`. The two inbox bands archive, and a
  // mailbox with old Inbox mail is the mailbox this report is for, so in
  // practice the flag was almost always true: the large-attachment steps
  // sold as "at least N MB" were ARCHIVED, which frees no storage at
  // all, under a button whose own subtitle said "then Trash".
  //
  // Deleting the archive steps instead is not an option: those bands
  // exist because Inbox mail should be filed, not thrown away. So the
  // plan runs one action group, the one the top-ranked remaining step
  // belongs to, and the caller reports the rest. Running the delete
  // group first is not hardcoded; ranking already puts the MB steps on
  // top when there are any.
  const reportPlanGroup = (bands) => {
    const remaining = rankReportBands(bands).filter((b) => b.count > 0 && !b.cleanedAt);
    if (!remaining.length) return { ids: [], action: "", deferred: 0 };
    const action = remaining[0].action === "archive" ? "archive" : "delete";
    const ids = [];
    let deferred = 0;
    for (const band of remaining) {
      if (band.action === action) ids.push(band.id);
      else deferred++;
    }
    return { ids, action, deferred };
  };

  // Free users get the report in full and one working purge. Pro unlocks
  // the rest and the whole-plan run.
  const isBandUnlocked = (bandId, bands, licenseActive) => {
    if (licenseActive) return Boolean(REPORT_BAND_BY_ID.has(bandId));
    return Boolean(bandId) && bandId === freeReportBandId(bands);
  };

  const reportUpsellLine = (bands) => {
    const ranked = rankReportBands(bands);
    const locked = ranked.filter((b) => b.count > 0).slice(1);
    if (locked.length === 0) {
      return t("reportUpsellNone", "Pro is $9.99 once: it unlocks every step of the plan and one-click Run the whole plan.");
    }
    // One band's own count is exact, so a single locked step can state
    // it. More than one CANNOT be summed: the bands overlap by design
    // (an old 6MB promo in the Inbox is in sizeBig, promotions,
    // newsletters and inboxOld at once), so adding them counts the same
    // message up to four times, and this line is read at the moment
    // money changes hands. The rule is stated a few hundred lines up:
    // band counts are never summed into a headline figure. The largest
    // locked band is a measured number about one real band, so that is
    // what gets shown.
    if (locked.length === 1) {
      const only = locked[0].count.toLocaleString();
      return t("reportUpsellOne", `1 more step is holding ${only} emails. Pro clears it for $9.99.`, [only]);
    }
    const biggest = locked.reduce((max, b) => Math.max(max, b.count), 0).toLocaleString();
    return t(
      "reportUpsellMany",
      `${locked.length} more steps are locked, the largest holding ${biggest} emails. Pro clears them for $9.99.`,
      [String(locked.length), biggest]
    );
  };

  const report = Object.freeze({
    BANDS: REPORT_BANDS,
    HEADLINE_QUERY: REPORT_HEADLINE_QUERY,
    LIMITS: REPORT_LIMITS,
    buildQueries: buildReportQueries,
    foldBands: foldReportBands,
    rankBands: rankReportBands,
    freeBandId: freeReportBandId,
    totals: reportTotals,
    bandPurgeRules,
    planGroup: reportPlanGroup,
    isBandUnlocked,
    upsellLine: reportUpsellLine
  });

  // =========================
  // Sender avatars (8.4)
  // =========================
  // Recognition marks for the Unsubscribe list, so a row is something
  // you can spot rather than a line of text to read.
  //
  // Favicons are the obvious way to build this and are the reason this
  // file does it the hard way instead. Fetching an icon per sender
  // means one request per sender to whoever serves it, which hands a
  // third party the list of who mails you, and it would put the first
  // network call into an extension whose whole claim is that it makes
  // none. Everything below is arithmetic on the address string: same
  // input, same mark, no request, works offline.

  // Second-level labels that are still part of the public suffix, so
  // the brand sits one label further left: bbc.co.uk, myer.com.au.
  const AVATAR_PUBLIC_SLD = Object.freeze(new Set([
    "co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go",
    "in", "id", "mil", "sch", "gouv", "asn"
  ]));

  // 700-weight tones: saturated enough to read on the dark popup, dark
  // enough that white sits above 4.5:1 on every one of them, so the
  // same swatch works in both themes without a second palette.
  const AVATAR_PALETTE = Object.freeze([
    "#1d4ed8", "#0e7490", "#047857", "#4d7c0f", "#a16207", "#c2410c",
    "#b91c1c", "#be185d", "#7e22ce", "#4338ca", "#0f766e", "#6d28d9"
  ]);

  // FNV-1a. Deterministic and dependency-free; the point is only that
  // one brand always lands on one colour, never that it is unguessable.
  const avatarHash = (input) => {
    let h = 0x811c9dc5;
    const s = String(input || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };

  const avatarHost = (email) => {
    const raw = String(email || "").toLowerCase().trim();
    const at = raw.lastIndexOf("@");
    if (at < 0) return "";
    return raw.slice(at + 1).replace(/[^a-z0-9.-]/g, "").replace(/^\.+|\.+$/g, "");
  };

  // The label a person would call the sender: substack, bbc, walmart.
  //
  // Take the registrable label, the one immediately left of the public
  // suffix, and ignore everything to its left. That collapses
  // news.substack.com, email.substack.com and e.mail.substack.com onto
  // one brand for free.
  //
  // An earlier version of this instead stripped a hardcoded list of
  // delivery subdomains (news, email, mail, mg...) from the left. It
  // was both longer and wrong: news.co.uk is a real registrable domain
  // whose brand is "news", and stripping by name turned it into "co".
  const avatarBrand = (email) => {
    const host = avatarHost(email);
    if (!host) return "";
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 1) return parts[0] || "";
    const suffixLabels =
      parts.length > 2 &&
      AVATAR_PUBLIC_SLD.has(parts[parts.length - 2]) &&
      parts[parts.length - 1].length === 2
        ? 2
        : 1;
    const brandIndex = parts.length - 1 - suffixLabels;
    return (brandIndex >= 0 ? parts[brandIndex] : parts[0]) || "";
  };

  const avatarInitial = (email, name) => {
    const fromBrand = avatarBrand(email).match(/[a-z0-9]/);
    if (fromBrand) return fromBrand[0].toUpperCase();
    const fromName = String(name || "").match(/[\p{L}\p{N}]/u);
    if (fromName) return fromName[0].toUpperCase();
    const local = String(email || "").split("@")[0] || "";
    const fromLocal = local.match(/[\p{L}\p{N}]/u);
    return fromLocal ? fromLocal[0].toUpperCase() : "?";
  };

  // Everything a row needs to draw its mark. `fg` is always white
  // because every palette entry was chosen to clear 4.5:1 against it.
  const senderAvatar = (email, name) => {
    const brand = avatarBrand(email);
    const host = avatarHost(email);
    // Key the colour on the brand, not the address, so three addresses
    // at one company share a swatch and read as one group in the list.
    const seed = brand || host || String(email || "").toLowerCase();
    return Object.freeze({
      brand,
      host,
      initial: avatarInitial(email, name),
      bg: AVATAR_PALETTE[avatarHash(seed) % AVATAR_PALETTE.length],
      fg: "#ffffff"
    });
  };

  const avatar = Object.freeze({
    PALETTE: AVATAR_PALETTE,
    hash: avatarHash,
    host: avatarHost,
    brand: avatarBrand,
    initial: avatarInitial,
    forSender: senderAvatar
  });

  // =========================
  // Popup UI policy (7.3)
  // =========================
  // Pure decision logic behind the tabbed popup, kept here so it is
  // unit-testable: which banner wins when several want to show, when a
  // finished run earns the rating ask, whether the reassurance block
  // starts open, and the number-led first lines of the Pro upsells.
  // The popup owns the DOM; these own the rules.

  // One banner at a time. An untrusted install source outranks
  // everything (the user may not even know this copy exists), a
  // missing Gmail grant blocks every feature, snooze explains why
  // schedules are quiet, and the pin hint is mere marketing, so that
  // is the priority order.
  const pickBanner = ({ sourceUntrusted = false, accessNeeded = false, snoozed = false, pinEligible = false } = {}) => {
    if (sourceUntrusted) return "source";
    if (accessNeeded) return "access";
    if (snoozed) return "snooze";
    if (pinEligible) return "pin";
    return null;
  };

  // A run earns the rating ask only when it was real (not a dry run)
  // and big enough that the user just felt the benefit. 7.9.1 lowered
  // the bar: repeat maintenance runs clean far less than a first sweep
  // but belong to the happiest users, and they never reached 200.
  const RATING_MIN_CLEANED = 50;
  const RATING_MIN_FREED_MB = 25;

  const ratingRunQualifies = ({ dryRun = false, cleaned = 0, freedMb = 0 } = {}) => {
    if (dryRun) return false;
    const count = Number(cleaned) || 0;
    const mb = Number(freedMb) || 0;
    return count >= RATING_MIN_CLEANED || mb >= RATING_MIN_FREED_MB;
  };

  // 8.13: qualifying used to be only half the gate. One "Maybe later"
  // then silenced the ask for 90 days (8.0) or forever (7.3), on a
  // listing whose weakest ranking input is its handful of ratings, so
  // in practice almost nobody was asked twice. Now every qualifying run
  // asks, bounded by two things so that "every run" cannot become
  // nagging:
  //
  //   - a short cooldown after a refusal, so somebody clearing out a
  //     backlog in one sitting is asked once that day, not five times;
  //   - a hard stop after a few refusals, because three "no"s is an
  //     answer and the fourth ask is just noise.
  //
  // Going to the store, or the explicit "Don't ask again", sets `done`
  // and ends it permanently. The two are stored the same way on
  // purpose: whichever the user picked, they have decided.
  const RATING_ASK_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 3;
  const RATING_MAX_DISMISSALS = 3;

  // And never on somebody's first run. A first cleanup is the one most
  // likely to be a nervous try of an unfamiliar tool, and asking for
  // five stars before the user has decided they trust it is how you
  // earn a two. The counter is `runSuccessCount`, bumped when a run
  // starts, so it already reads 1 while the first run's own result is
  // on screen; asking from the second means requiring 2.
  const RATING_MIN_RUNS = 2;

  const shouldAskForRating = (stored, now = Date.now(), runs = 0) => {
    const ask = stored && typeof stored === "object" ? stored : {};
    if (ask.done) return false;
    if ((Number(runs) || 0) < RATING_MIN_RUNS) return false;
    if ((Number(ask.dismissals) || 0) >= RATING_MAX_DISMISSALS) return false;
    const last = Number(ask.lastDismissedAt) || 0;
    // Never refused, or refused at an unreadable time: ask.
    if (!last) return true;
    return (Number(now) || 0) - last >= RATING_ASK_COOLDOWN_MS;
  };

  // The 8.12 and earlier key was a single `ratingPromptDismissed`, a
  // timestamp or a bare `true`, written by BOTH "Maybe later" and the
  // rate button. It cannot tell the two apart, so it is read as one
  // refusal rather than as a decision: an existing user who once said
  // "later" gets asked again, which is the entire point of this change,
  // and is not sent straight back to the store either.
  const migrateRatingAsk = (stored, legacy) => {
    if (stored && typeof stored === "object") return stored;
    if (!legacy) return {};
    const at = Number(legacy);
    return { dismissals: 1, lastDismissedAt: Number.isFinite(at) && at > 0 ? at : 0 };
  };

  const noteRatingDismissed = (stored, now = Date.now()) => {
    const ask = stored && typeof stored === "object" ? stored : {};
    return {
      ...ask,
      dismissals: (Number(ask.dismissals) || 0) + 1,
      lastDismissedAt: Number(now) || 0
    };
  };

  const noteRatingDone = (stored) => {
    const ask = stored && typeof stored === "object" ? stored : {};
    return { ...ask, done: true };
  };

  // First lines of the Pro upsells. Lead with the user's own scan
  // numbers once a scan exists; before that, fall back to the static
  // pitch. Claims mirror what the features do: the user picks the
  // senders, and storage figures are floor estimates.
  const subsUpsellLine = (senderCount) => {
    const n = Math.max(0, Math.floor(Number(senderCount) || 0));
    if (!n) return t("subsUpsellNone", "One $9.99 payment unlocks bulk unsubscribe forever.");
    if (n === 1) return t("subsUpsellOne", "Found 1 mailing list emailing you. Pro unsubscribes from the ones you pick for $9.99.");
    return t("subsUpsellMany", `Found ${n} mailing lists emailing you. Pro unsubscribes from the ones you pick for $9.99.`, [String(n)]);
  };

  const xrayUpsellLine = (senderCount, totalMb) => {
    const n = Math.max(0, Math.floor(Number(senderCount) || 0));
    const mb = Math.max(0, Number(totalMb) || 0);
    // 8.13: the list is no longer the thing being sold, so this no
    // longer offers to unlock it. Every ranked sender is on screen for
    // free; what $9.99 buys is the purge button underneath them.
    if (!n || !mb) return t("xrayUpsellNone", "Pro is $9.99 once: it purges the senders you tick, in one click.");
    const mbText = formatMb(mb);
    if (n === 1) return t("xrayUpsellOne", `1 sender is holding at least ${mbText}. Pro purges the ones you pick for $9.99.`, [mbText]);
    return t("xrayUpsellMany", `${n} senders are holding at least ${mbText}. Pro purges the ones you pick for $9.99.`, [String(n), mbText]);
  };

  // 7.4: post-run recap. The popup closes itself when a run starts, so
  // most runs finish with nobody watching; on the next open the newest
  // unseen real (non dry-run) history entry is replayed through the
  // result view, once. The "seen" marker is a local timestamp: an entry
  // counts as unseen only while it is newer than the marker.
  //
  // The marker is stamped slightly ahead of "now" because the history
  // entry for a live-finished run is written by the service worker a
  // beat AFTER the popup's done handler fires; without the skew that
  // same run would come back as a recap on the next open. Nothing real
  // can start and finish inside the skew window, so it hides no runs.
  const RECAP_SEEN_SKEW_MS = 5000;

  const recapSeenMarker = (now) => (Number(now) || 0) + RECAP_SEEN_SKEW_MS;

  const pickRecapEntry = (history, lastSeenTs) => {
    if (!Array.isArray(history)) return null;
    const seen = Number(lastSeenTs) || 0;
    let newest = null;
    for (const entry of history) {
      if (!entry || typeof entry !== "object" || entry.dryRun) continue;
      const ts = Number(entry.timestamp) || 0;
      if (ts <= seen) continue;
      if (!newest || ts > (Number(newest.timestamp) || 0)) newest = entry;
    }
    return newest;
  };

  // History entries carry deleted/archived counts but not the run's
  // action; a run books everything under one of the two, so archived
  // hits with zero deletions read as an archive run.
  const recapAction = (entry) => {
    const archived = Number(entry?.archived) || 0;
    const deleted = Number(entry?.deleted) || 0;
    return archived > 0 && deleted === 0 ? "archive" : "trash";
  };

  const recapCleanedCount = (entry) =>
    (Number(entry?.deleted) || 0) + (Number(entry?.archived) || 0);

  // 7.8: first line of the Suggested locked row. Leads with how many
  // ranked suggestions sit behind the free cap; before a scan produces
  // any, falls back to the static pitch.
  const smartUpsellLine = (hiddenCount) => {
    const n = Math.max(0, Math.floor(Number(hiddenCount) || 0));
    if (!n) return t("smartUpsellNone", "Pro is $9.99 once: it unlocks the full suggestion list and bulk apply.");
    if (n === 1) return t("smartUpsellOne", "1 more suggestion ready. Pro unlocks the full list and applies them in bulk for $9.99.");
    return t("smartUpsellMany", `${n} more suggestions ready. Pro unlocks the full list and applies them in bulk for $9.99.`, [String(n)]);
  };

  // 7.12: first line of the locked Auto-Pilot row. Leads with how many
  // suggestions are sitting there right now; before a scan produces
  // any, falls back to the static pitch.
  const autoPilotUpsellLine = (suggestionCount) => {
    const n = Math.max(0, Math.floor(Number(suggestionCount) || 0));
    if (!n) return t("apUpsellNone", "Pro is $9.99 once: Auto-Pilot keeps your inbox clean every week, automatically.");
    if (n === 1) return t("apUpsellOne", "1 suggestion is sitting here right now. Auto-Pilot sweeps them for you every week on Pro ($9.99 once).");
    return t("apUpsellMany", `${n} suggestions are sitting here right now. Auto-Pilot sweeps them for you every week on Pro ($9.99 once).`, [String(n)]);
  };

  const popupUi = Object.freeze({
    RATING_MIN_CLEANED,
    RATING_MIN_FREED_MB,
    RATING_ASK_COOLDOWN_MS,
    RATING_MAX_DISMISSALS,
    RATING_MIN_RUNS,
    RECAP_SEEN_SKEW_MS,
    pickBanner,
    ratingRunQualifies,
    shouldAskForRating,
    migrateRatingAsk,
    noteRatingDismissed,
    noteRatingDone,
    subsUpsellLine,
    xrayUpsellLine,
    smartUpsellLine,
    autoPilotUpsellLine,
    pickRecapEntry,
    recapSeenMarker,
    recapAction,
    recapCleanedCount
  });

  // =========================
  // Restore eligibility (7.6)
  // =========================
  // Pure policy behind the recovery log's Restore button. A run can be
  // restored only when it left a label to search for: the engine tags
  // mail before moving it, so the label is the one identifier that
  // cannot drag unrelated mail back (sender-based guessing could).
  // Delete-mode runs additionally race Gmail's ~30-day Trash retention.
  // Entries missing any needed field simply do not offer restore.

  const RESTORE_TRASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

  const restoreEligibility = (entry, now = Date.now()) => {
    if (!entry || typeof entry !== "object") {
      return { eligible: false, restored: false, reason: "This entry cannot be restored." };
    }
    if (entry.restoredAt) {
      return { eligible: false, restored: true, reason: "Already restored." };
    }
    const label = typeof entry.tagLabel === "string" ? entry.tagLabel.trim() : "";
    // taggingFailed must be a recorded false: an entry that never said
    // whether its label actually landed offers no safe search target.
    if (!label || entry.taggingFailed !== false) {
      return {
        eligible: false,
        restored: false,
        reason: "No label was applied on this run, so there is nothing safe to search for."
      };
    }
    const action = entry.action === "archive" ? "archive" : "delete";
    const ts = Number(entry.timestamp) || 0;
    if (action === "delete" && (!ts || now - ts > RESTORE_TRASH_WINDOW_MS)) {
      return {
        eligible: false,
        restored: false,
        reason: "Gmail keeps Trash for about 30 days and this run is older than that."
      };
    }
    return { eligible: true, restored: false, reason: "", label, action };
  };

  const restore = Object.freeze({
    TRASH_WINDOW_MS: RESTORE_TRASH_WINDOW_MS,
    eligibility: restoreEligibility
  });

  // =========================
  // Smart Suggestions (7.8)
  // =========================
  // Pure policy behind the Suggested section on the Clean tab. The
  // engine's smartScan gathers per-sender signals (volume, unread
  // ratio, share of old mail, machine-address shape) and hard-vetoes
  // starred / whitelisted / corresponded-with senders BEFORE anything
  // is persisted; these helpers turn the survivors into ranked,
  // explainable recommendations and map each one onto an EXISTING run
  // path. Nothing here executes anything: the output is a
  // rulesOverride query (or an unsubscribe sender list) that walks the
  // same guarded paths every other run does.

  const SMART_LIMITS = Object.freeze({
    MAX_LIST: 50,
    FREE_VISIBLE: 3,
    MAX_BULK_PER_RUN: 25,
    DISMISS_TTL_MS: 90 * 24 * 60 * 60 * 1000,
    MAX_FEEDBACK: 300,
    DOMAIN_BOOST: 6
  });

  const SMART_ACTIONS = Object.freeze(["deleteOld", "archiveAll", "purgeLarge", "unsubscribe"]);

  const SMART_ACTION_LABELS = Object.freeze({
    deleteOld: "Delete old mail",
    archiveAll: "Archive all",
    purgeLarge: "Purge large mail",
    unsubscribe: "Unsubscribe"
  });

  const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

  // Signals -> 0..100. Never-opened mail is the strongest clutter
  // signal, so the unread ratio carries the biggest share; volume is
  // log-scaled so a 10k-email sender cannot drown every other signal.
  const smartScore = (signals) => {
    const s = signals || {};
    const count = Math.max(0, Number(s.count) || 0);
    if (!count) return 0;
    const volumePts = Math.min(25, Math.round(Math.log10(count + 1) * 10));
    const unreadPts = Math.round(45 * clamp01(s.unreadRatio));
    const oldPts = Math.round(15 * clamp01(s.oldShare));
    const shapePts = s.shape ? 15 : 0;
    return Math.min(100, volumePts + unreadPts + oldPts + shapePts);
  };

  // Whitelist entry semantics, mirrored from the engine's query
  // builder: exact email, *@domain wildcard, bare domain (which also
  // covers subdomains).
  const whitelistCoversSender = (entry, email) => {
    const e = String(entry || "").trim().toLowerCase();
    if (!e) return false;
    if (e.startsWith("*@")) return email.endsWith(e.slice(1));
    if (e.includes("@")) return email === e;
    return email.endsWith("@" + e) || email.endsWith("." + e);
  };

  // Hard vetoes win over any score. Engine-side flags (starred,
  // corresponded) ride in on signals; whitelist and protected keywords
  // are re-checked here because the user can change both after a scan.
  // Protected keywords shield mail by subject, so the sender-level
  // reading is conservative: a protected word in the address or the
  // display name disqualifies the sender.
  const smartVetoReasons = (sender, config = {}) => {
    const reasons = [];
    const email = String(sender?.email || "").trim().toLowerCase();
    if (!STORAGE_EMAIL_RE.test(email)) reasons.push("invalid");
    const sig = sender?.signals || {};
    if (sig.starred) reasons.push("starred");
    if (sig.corresponded) reasons.push("correspondence");
    const wl = Array.isArray(config.whitelist) ? config.whitelist : [];
    if (email && wl.some((entry) => whitelistCoversSender(entry, email))) {
      reasons.push("whitelisted");
    }
    const kw = Array.isArray(config.protectKeywords) ? config.protectKeywords : [];
    const hay = (email + " " + String(sender?.name || "")).toLowerCase();
    if (kw.some((k) => {
      const key = String(k || "").trim().toLowerCase();
      return key && hay.includes(key);
    })) {
      reasons.push("protected");
    }
    return reasons;
  };

  // Feedback map: { bySender: { email: { action, at } } }. Bounded so
  // it can never grow past a few storage KB: past the cap the oldest
  // entries fall off first.
  const smartRecordFeedback = (feedback, email, action, now = Date.now()) => {
    const bySender = { ...(feedback?.bySender || {}) };
    const clean = String(email || "").trim().toLowerCase();
    if (STORAGE_EMAIL_RE.test(clean) && (action === "applied" || action === "dismissed")) {
      bySender[clean] = { action, at: Number(now) || 0 };
    }
    const entries = Object.entries(bySender);
    if (entries.length > SMART_LIMITS.MAX_FEEDBACK) {
      entries.sort((a, b) => (Number(a[1]?.at) || 0) - (Number(b[1]?.at) || 0));
      return { bySender: Object.fromEntries(entries.slice(entries.length - SMART_LIMITS.MAX_FEEDBACK)) };
    }
    return { bySender };
  };

  // A dismissal silences the sender for 90 days, then decays so a
  // still-noisy sender can come back.
  const smartIsDismissed = (feedback, email, now = Date.now()) => {
    const fb = feedback?.bySender?.[String(email || "").trim().toLowerCase()];
    if (!fb || fb.action !== "dismissed") return false;
    return (now - (Number(fb.at) || 0)) < SMART_LIMITS.DISMISS_TTL_MS;
  };

  // An applied suggestion boosts future senders from the same domain a
  // little: the user showed intent to clean that kind of mail.
  const smartDomainBoost = (feedback, email) => {
    const domain = String(email || "").toLowerCase().split("@")[1] || "";
    if (!domain) return 0;
    for (const [addr, fb] of Object.entries(feedback?.bySender || {})) {
      if (fb?.action === "applied" && (addr.split("@")[1] || "") === domain) {
        return SMART_LIMITS.DOMAIN_BOOST;
      }
    }
    return 0;
  };

  const smartRankSenders = (senders, feedback, now = Date.now()) => {
    if (!Array.isArray(senders)) return [];
    return senders
      .filter((s) => s && typeof s.email === "string" && STORAGE_EMAIL_RE.test(s.email.trim().toLowerCase()))
      .filter((s) => !smartIsDismissed(feedback, s.email, now))
      .map((s) => {
        const stored = typeof s.score === "number" && Number.isFinite(s.score)
          ? s.score
          : smartScore(s.signals);
        return {
          ...s,
          email: s.email.trim().toLowerCase(),
          name: typeof s.name === "string" ? s.name.slice(0, 120) : "",
          estCount: Math.max(0, Math.min(999999, Number(s.estCount) || 0)),
          score: Math.min(100, Math.max(0, stored) + smartDomainBoost(feedback, s.email))
        };
      })
      .sort((a, b) => b.score - a.score || b.estCount - a.estCount)
      .slice(0, SMART_LIMITS.MAX_LIST);
  };

  // The one call sites should use: vetoes first (they beat any score),
  // then feedback-aware ranking.
  const smartRecommend = (senders, feedback, config = {}, now = Date.now()) => {
    if (!Array.isArray(senders)) return [];
    return smartRankSenders(
      senders.filter((s) => smartVetoReasons(s, config).length === 0),
      feedback,
      now
    );
  };

  // Map a recommendation onto an existing run path. cleanup rules ride
  // rulesOverride (every guard, tag-before-delete, undo and stats
  // apply); unsubscribe rides the existing Pro unsubscribe engine.
  // Returns null when the sender or action cannot make a safe rule.
  const smartBuildActionRule = (sender, action) => {
    const email = String(sender?.email || "").trim().toLowerCase();
    if (!STORAGE_EMAIL_RE.test(email) || email.length > 320) return null;
    if (!SMART_ACTIONS.includes(action)) return null;
    if (action === "unsubscribe") {
      return { runKind: "unsubscribe", senders: [email] };
    }
    if (action === "purgeLarge") {
      const query = buildStoragePurgeQuery([email], "6m");
      return query ? { runKind: "cleanup", query, archive: false } : null;
    }
    if (action === "archiveAll") {
      return { runKind: "cleanup", query: `from:(${email})`, archive: true };
    }
    return { runKind: "cleanup", query: `from:(${email}) older_than:6m`, archive: false };
  };

  // Bulk apply (Pro), 8.7.
  //
  // The old bulk path collapsed every checked card into ONE deleteOld
  // query and ran it with archive:false. Each card, though, leads with
  // the action the scan measured for that sender and states the count
  // that action will reach, so the button under them did something
  // different from what they promised, twice over:
  //
  //   - an archiveAll card reading "Archives 200 now" had its mail sent
  //     to Trash, which is the destructive direction and the one
  //     mistake this product cannot make;
  //   - a purgeLarge card reading "Deletes 40 large emails now" ran the
  //     generic older_than:6m instead of its own larger:5M, so it took
  //     every old message from that sender rather than the big ones.
  //
  // A run carries one archiveInsteadOfDelete for all of its rules, so
  // one click cannot honour both groups. This plans the group the
  // top-most checked card belongs to and reports the rest as deferred;
  // the caller says so and the user clicks again. Doing less than was
  // asked is the safe direction, and it is the same idiom the 25-per-run
  // cap has used for releases.
  //
  // Senders whose action is `unsubscribe` are not cleanup at all (they
  // ride the unsubscribe engine) and are never planned here.
  // Pack addresses into as many `from:( ... )<suffix>` groups as the
  // 512-character ceiling allows. Identical reasoning to the storage
  // x-ray's purgeQueryChunks, which learned it first: an over-length
  // query is not a smaller version of the query, it is a different one,
  // and the caller has already told the user what the full list will do.
  // `suffix` starts with the closing paren so callers own their own
  // trailing operators.
  const packSenderGroups = (emails, suffix) => {
    const budget = MAX_QUERY_CHARS - "from:(".length - suffix.length;
    const out = [];
    let group = [];
    let groupLen = 0;
    for (const email of emails) {
      // " OR " only costs anything from the second address onward.
      const cost = email.length + (group.length ? 4 : 0);
      if (group.length && groupLen + cost > budget) {
        out.push(`from:(${group.join(" OR ")}${suffix}`);
        group = [];
        groupLen = 0;
      }
      // An address longer than the whole budget cannot be packed at all;
      // dropping it misses one sender, which is the safe failure.
      if (email.length > budget) continue;
      group.push(email);
      groupLen += group.length === 1 ? email.length : cost;
    }
    if (group.length) out.push(`from:(${group.join(" OR ")}${suffix}`);
    return out;
  };

  const smartBulkPlan = (senders) => {
    const empty = { rules: [], emails: [], archive: false, action: "", deferred: 0, deferredUnsub: 0 };
    if (!Array.isArray(senders) || !senders.length) return empty;

    const valid = [];
    // 8.11: unsubscribe cards ride the unsubscribe engine, not a cleanup
    // rule, so they can never be part of this plan. They used to be
    // dropped by a bare `continue` that touched no counter, which meant
    // the caller had nothing to report: tick three unsubscribe cards and
    // two archive cards, press Apply selected, and the run took two
    // while the popup said nothing about the other three. Counted
    // separately from `deferred` because the remedy is different -
    // pressing Apply again will never pick them up, they need their own
    // button or the Unsubscribe tab.
    let deferredUnsub = 0;
    for (const sender of senders) {
      const email = String(sender?.email || "").trim().toLowerCase();
      if (!STORAGE_EMAIL_RE.test(email) || email.length > 320) continue;
      const action = smartResolvedAction(sender);
      if (action === "unsubscribe") { deferredUnsub++; continue; }
      valid.push({ email, action });
    }
    if (!valid.length) return { ...empty, deferredUnsub };

    // Order is the ranked order the cards were rendered in, so "the
    // group the first checked card is in" is the group at the top of
    // what the user was looking at.
    const lead = valid[0].action;
    const chosen = [];
    const seen = new Set();
    let deferred = 0;
    for (const item of valid) {
      if (item.action !== lead) { deferred++; continue; }
      if (seen.has(item.email)) continue;
      if (chosen.length >= SMART_LIMITS.MAX_BULK_PER_RUN) { deferred++; continue; }
      seen.add(item.email);
      chosen.push(item.email);
    }
    if (!chosen.length) return { ...empty, deferredUnsub };

    // Every member shares the action, so they share the query shape, and
    // an OR group is one search instead of twenty-five. The shapes are
    // the same ones buildActionRule emits for a single card, which is
    // what makes the counts on the cards the counts this run will
    // honour.
    //
    // 8.8: this packed all twenty-five into ONE from:() group. Twenty-
    // five realistic newsletter addresses come to around 870 characters
    // against the 512 the project enforces in validateGmailQuery, and
    // nothing on the rulesOverride path calls that validator, so the
    // over-length string went to Gmail exactly as the storage x-ray's
    // did before 8.0 chunked it. Same fix, same reason: the run takes
    // the whole set as separate rules, which the engine already does.
    let suffix;
    if (lead === "purgeLarge") suffix = ") larger:5M older_than:6m";
    else if (lead === "archiveAll") suffix = ")";
    else suffix = ") older_than:6m";

    return {
      rules: packSenderGroups(chosen, suffix),
      emails: chosen,
      archive: lead === "archiveAll",
      action: lead,
      deferred,
      deferredUnsub
    };
  };

  // Bulk apply (Pro): one cleanup run over every checked sender, the
  // same conservative shape as deleteOld. An empty list when nothing
  // valid survives; callers must treat that as a no-op.
  //
  // 8.7: kept for the callers that genuinely mean "one deleteOld query
  // over these addresses" and for the tests that pin its shape. The
  // suggestion list uses smartBulkPlan above.
  const smartBuildBulkRules = (emails) => {
    if (!Array.isArray(emails)) return [];
    const clean = [];
    const seen = new Set();
    for (const raw of emails) {
      if (typeof raw !== "string") continue;
      const email = raw.trim().toLowerCase();
      if (!email || email.length > 320 || !STORAGE_EMAIL_RE.test(email) || seen.has(email)) continue;
      seen.add(email);
      clean.push(email);
      if (clean.length >= SMART_LIMITS.MAX_BULK_PER_RUN) break;
    }
    if (!clean.length) return [];
    return packSenderGroups(clean, ") older_than:6m");
  };

  // 8.8: the singular form keeps its shape for existing callers and
  // tests, and returns the FIRST chunk when the list overflows, so no
  // path can quietly emit an over-length query again. Same contract the
  // storage x-ray's buildPurgeQuery has had since 8.0.
  const smartBuildBulkRule = (emails) => {
    const chunks = smartBuildBulkRules(emails);
    return chunks.length ? chunks[0] : "";
  };

  // Which action a card leads with. Storage hogs get the purge. An
  // active flood the user never opens (recent mail still arriving,
  // nearly all unread) leads with the Pro unsubscribe: deleting it
  // would not stop the next batch. Mail whose flow has mostly stopped
  // gets the delete, everything else the reversible archive. The
  // unsubscribe branch requires a measured oldShare: without recency
  // data the card never claims a sender is still flooding.
  const SMART_UNSUB_MIN_UNREAD = 0.8;
  const SMART_UNSUB_MAX_OLD_SHARE = 0.6;
  const SMART_UNSUB_MIN_COUNT = 10;

  const smartPrimaryAction = (sender) => {
    const sig = sender?.signals || {};
    if ((Number(sig.estMb) || 0) >= 100) return "purgeLarge";
    const oldShare = Number(sig.oldShare);
    if (
      (Number(sig.count) || 0) >= SMART_UNSUB_MIN_COUNT &&
      clamp01(sig.unreadRatio) >= SMART_UNSUB_MIN_UNREAD &&
      Number.isFinite(oldShare) &&
      clamp01(oldShare) <= SMART_UNSUB_MAX_OLD_SHARE
    ) {
      return "unsubscribe";
    }
    if (clamp01(sig.unreadRatio) >= 0.5) return "deleteOld";
    return "archiveAll";
  };

  // Plain-English reason line, e.g. "142 emails, 96% unread, mostly
  // older than 6 months".
  const smartReasonText = (sender) => {
    const sig = sender?.signals || {};
    const count = Math.max(0, Number(sender?.estCount ?? sig.count) || 0);
    const countText = count.toLocaleString();
    const parts = [
      count === 1
        ? t("reasonOneEmail", "1 email")
        : t("reasonManyEmails", `${countText} emails`, [countText])
    ];
    const unread = Number(sig.unreadRatio);
    if (Number.isFinite(unread) && unread > 0) {
      const pct = String(Math.round(clamp01(unread) * 100));
      parts.push(t("reasonPctUnread", `${pct}% unread`, [pct]));
    }
    if (clamp01(sig.oldShare) >= 0.5) parts.push(t("reasonMostlyOld", "mostly older than 6 months"));
    if (sig.shape) parts.push(t("reasonNoReply", "no-reply sender"));
    const mb = Number(sig.estMb) || 0;
    if (mb >= 50) parts.push(t("reasonAtLeastMb", `at least ${formatMb(mb)}`, [formatMb(mb)]));
    return parts.join(t("reasonJoin", ", "));
  };

  // 8.6: the action the SCAN measured, when it recorded one. Deciding
  // again in the popup is how the number and the button drifted apart:
  // the engine measures one query and the card offers a different one
  // the moment the policy or the stored signals disagree.
  const smartResolvedAction = (sender) =>
    SMART_ACTIONS.includes(sender?.action) ? sender.action : smartPrimaryAction(sender);

  // The one line on a card that is a promise rather than a description.
  // reasonText describes the sender's mail and stays true either way;
  // this is the count measured through the same guards the button
  // applies. Nothing is returned when the scan did not measure it (an
  // unsubscribe card, or a suggestion stored before 8.6), because
  // saying nothing beats a number that might not be honoured.
  const smartActionCountText = (sender) => {
    const raw = sender?.reachable;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return "";
    const action = smartResolvedAction(sender);
    if (action === "unsubscribe") return "";
    const n = Math.max(0, Math.round(raw)).toLocaleString();
    if (action === "archiveAll") return t("smartWillArchive", `Archives ${n} now`, [n]);
    if (action === "purgeLarge") return t("smartWillPurge", `Deletes ${n} large emails now`, [n]);
    return t("smartWillDelete", `Deletes ${n} now`, [n]);
  };

  const smart = Object.freeze({
    LIMITS: SMART_LIMITS,
    ACTIONS: SMART_ACTIONS,
    ACTION_LABELS: SMART_ACTION_LABELS,
    score: smartScore,
    vetoReasons: smartVetoReasons,
    recordFeedback: smartRecordFeedback,
    isDismissed: smartIsDismissed,
    rankSenders: smartRankSenders,
    recommend: smartRecommend,
    buildActionRule: smartBuildActionRule,
    buildBulkRule: smartBuildBulkRule,
    buildBulkRules: smartBuildBulkRules,
    bulkPlan: smartBulkPlan,
    primaryAction: smartPrimaryAction,
    resolvedAction: smartResolvedAction,
    reasonText: smartReasonText,
    actionCountText: smartActionCountText
  });

  // =========================
  // Accessible tablist (7.3)
  // =========================
  // Minimal WAI-ARIA tabs behavior: roving tabindex, arrow-key
  // navigation with wrap-around, Home/End, and automatic activation
  // (moving focus selects the tab). Panels are resolved through each
  // tab's aria-controls and toggled with the hidden attribute.

  const tablist = (root, { onSelect } = {}) => {
    if (!root) return null;
    const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return null;

    const panelOf = (tab) => {
      const id = tab.getAttribute("aria-controls");
      return id ? document.getElementById(id) : null;
    };

    const select = (tabOrId, { focus = false } = {}) => {
      const target = typeof tabOrId === "string"
        ? tabs.find((t) => t.id === tabOrId)
        : tabOrId;
      if (!target || !tabs.includes(target)) return;
      for (const t of tabs) {
        const active = t === target;
        t.setAttribute("aria-selected", active ? "true" : "false");
        t.setAttribute("tabindex", active ? "0" : "-1");
        const panel = panelOf(t);
        if (panel) panel.hidden = !active;
      }
      if (focus) target.focus();
      if (typeof onSelect === "function") onSelect(target.id);
    };

    root.addEventListener("click", (e) => {
      const tab = e.target?.closest?.('[role="tab"]');
      if (tab && tabs.includes(tab)) select(tab);
    });

    root.addEventListener("keydown", (e) => {
      const idx = tabs.indexOf(document.activeElement);
      if (idx < 0) return;
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next < 0) return;
      e.preventDefault();
      select(tabs[next], { focus: true });
    });

    const initial = tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0];
    select(initial);

    return Object.freeze({
      select: (id) => select(id),
      selectedId: () =>
        tabs.find((t) => t.getAttribute("aria-selected") === "true")?.id || null
    });
  };

  // =========================
  // Public API
  // =========================

  return Object.freeze({
    // Chrome detection
    hasChrome,
    hasChromeStorage,
    hasChromeTabs,
    hasChromeScripting,

    // Chrome wrappers
    promisify,
    storageGet,
    storageSet,
    sendMessage,

    // DOM
    $,
    $$,
    qs,
    createEl,

    // Toast
    TOAST_ICONS,
    showToast,

    // Formatting
    formatNumber,
    formatMb,
    formatBytes,
    formatDuration,
    formatDate,
    relativeTime,

    // Security
    escapeHtml,

    // Utilities
    clamp,
    debounce,
    clone,
    truncate,
    sleep,
    onKeyboard,

    // New in 5.0
    theme,
    pollingInterval,
    safeSyncSet,
    estimateStorageBytes,
    SYNC_LIMIT_ITEM,
    SYNC_LIMIT_TOTAL,
    validateGmailQuery,
    ageTokenDays,
    strictestAgeToken,
    MAX_QUERY_CHARS,
    sanitizeProtectKeywords,
    buildSubjectExclusion,
    MAX_PROTECT_KEYWORDS,
    DANGEROUS_QUERY_TOKENS,
    AGE_REQUIRED_TOKENS,
    notify,
    downloadFile,
    classifyChromeError,

    // New in 7.0
    license,

    // New in 7.1
    detectBrowser,
    storeLinks,
    PRIVACY_URL,
    gmailAccess,

    // New in 7.2
    storageXray,

    // New in 7.3
    popupUi,
    tablist,

    // New in 7.6
    restore,

    // New in 7.8
    smart,

    // New in 7.13
    i18n,
    installSource,

    // New in 8.0
    report,

    // New in 8.4
    avatar,

    // New in 8.12
    proSettings
  });
})();
