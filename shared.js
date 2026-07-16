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
    if (diff < 0) return "just now";
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.floor(hrs / 24);
    return days + "d ago";
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
    "in:chat",
    "in:scheduled"
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

  const validateGmailQuery = (rawQuery) => {
    const errors = [];
    const warnings = [];
    const q = String(rawQuery || "").trim();

    if (!q) {
      errors.push("Query is empty");
      return { valid: false, errors, warnings };
    }
    if (q.length > 512) {
      errors.push(`Query is too long (${q.length} chars, max 512)`);
    }

    const lower = q.toLowerCase();

    for (const token of DANGEROUS_QUERY_TOKENS) {
      const negated = new RegExp(`(^|\\s)-\\s*${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      const positive = new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
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
    STORAGE_KEY: "proLicense"
  });

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
  const getLicenseState = async () => {
    try {
      const data = await storageGet("sync", [PRO.STORAGE_KEY]);
      const key = data?.[PRO.STORAGE_KEY];
      if (!key) return { active: false, key: "", payload: null };
      const check = await verifyLicense(key);
      return { active: check.valid, key: check.valid ? key : "", payload: check.payload };
    } catch {
      return { active: false, key: "", payload: null };
    }
  };

  const license = Object.freeze({
    PRO,
    parse: parseLicenseKey,
    verify: verifyLicense,
    getState: getLicenseState
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
  const STORAGE_EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

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
  const buildStoragePurgeQuery = (emails, age = "") => {
    const clean = sanitizeStorageEmails(emails);
    if (clean.length === 0) return "";
    const ageToken = STORAGE_XRAY_LIMITS.VALID_AGES.includes(age) && age
      ? ` older_than:${age}`
      : "";
    return `from:(${clean.join(" OR ")}) ${STORAGE_XRAY_LIMITS.PURGE_SIZE_FLOOR}${ageToken}`;
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
    rankSenders: rankStorageSenders
  });

  // =========================
  // Popup UI policy (7.3)
  // =========================
  // Pure decision logic behind the tabbed popup, kept here so it is
  // unit-testable: which banner wins when several want to show, when a
  // finished run earns the rating ask, whether the reassurance block
  // starts open, and the number-led first lines of the Pro upsells.
  // The popup owns the DOM; these own the rules.

  // One banner at a time. A missing Gmail grant blocks every feature,
  // snooze explains why schedules are quiet, and the pin hint is mere
  // marketing, so that is the priority order.
  const pickBanner = ({ accessNeeded = false, snoozed = false, pinEligible = false } = {}) => {
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

  // First lines of the Pro upsells. Lead with the user's own scan
  // numbers once a scan exists; before that, fall back to the static
  // pitch. Claims mirror what the features do: the user picks the
  // senders, and storage figures are floor estimates.
  const subsUpsellLine = (senderCount) => {
    const n = Math.max(0, Math.floor(Number(senderCount) || 0));
    if (!n) return "One $9.99 payment unlocks bulk unsubscribe forever.";
    return `Found ${n} mailing list${n === 1 ? "" : "s"} emailing you. Pro unsubscribes from the ones you pick for $9.99.`;
  };

  const xrayUpsellLine = (senderCount, totalMb) => {
    const n = Math.max(0, Math.floor(Number(senderCount) || 0));
    const mb = Math.max(0, Number(totalMb) || 0);
    if (!n || !mb) return "Pro is $9.99 once: it unlocks the full ranked list and one-click purge.";
    const who = n === 1 ? "1 sender is" : `${n} senders are`;
    return `${who} holding at least ${formatMb(mb)}. Pro purges the ones you pick for $9.99.`;
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
    if (!n) return "Pro is $9.99 once: it unlocks the full suggestion list and bulk apply.";
    return `${n} more suggestion${n === 1 ? "" : "s"} ready. Pro unlocks the full list and applies them in bulk for $9.99.`;
  };

  // 7.12: first line of the locked Auto-Pilot row. Leads with how many
  // suggestions are sitting there right now; before a scan produces
  // any, falls back to the static pitch.
  const autoPilotUpsellLine = (suggestionCount) => {
    const n = Math.max(0, Math.floor(Number(suggestionCount) || 0));
    if (!n) return "Pro is $9.99 once: Auto-Pilot keeps your inbox clean every week, automatically.";
    return `${n} suggestion${n === 1 ? " is" : "s are"} sitting here right now. Auto-Pilot sweeps them for you every week on Pro ($9.99 once).`;
  };

  const popupUi = Object.freeze({
    RATING_MIN_CLEANED,
    RATING_MIN_FREED_MB,
    RECAP_SEEN_SKEW_MS,
    pickBanner,
    ratingRunQualifies,
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

  // Bulk apply (Pro): one cleanup run over every checked sender, the
  // same conservative shape as deleteOld. "" when nothing valid
  // survives; callers must treat that as a no-op.
  const smartBuildBulkRule = (emails) => {
    if (!Array.isArray(emails)) return "";
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
    if (!clean.length) return "";
    return `from:(${clean.join(" OR ")}) older_than:6m`;
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
    const parts = [`${count.toLocaleString()} email${count === 1 ? "" : "s"}`];
    const unread = Number(sig.unreadRatio);
    if (Number.isFinite(unread) && unread > 0) {
      parts.push(`${Math.round(clamp01(unread) * 100)}% unread`);
    }
    if (clamp01(sig.oldShare) >= 0.5) parts.push("mostly older than 6 months");
    if (sig.shape) parts.push("no-reply sender");
    const mb = Number(sig.estMb) || 0;
    if (mb >= 50) parts.push(`at least ${formatMb(mb)}`);
    return parts.join(", ");
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
    primaryAction: smartPrimaryAction,
    reasonText: smartReasonText
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
    gmailAccess,

    // New in 7.2
    storageXray,

    // New in 7.3
    popupUi,
    tablist,

    // New in 7.6
    restore,

    // New in 7.8
    smart
  });
})();
