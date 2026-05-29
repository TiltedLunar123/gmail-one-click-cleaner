// shared.js — Common utilities for Gmail One-Click Cleaner extension pages
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
      const opts = {
        type: "basic",
        iconUrl: iconUrl || (chrome.runtime?.getURL?.("icons/icon128.png") || ""),
        title: String(title || "Gmail Cleaner"),
        message: String(message || ""),
        priority: 1
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
    DANGEROUS_QUERY_TOKENS,
    AGE_REQUIRED_TOKENS,
    notify,
    downloadFile,
    classifyChromeError
  });
})();
