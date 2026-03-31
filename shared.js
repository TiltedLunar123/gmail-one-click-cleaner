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
    } catch {
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

  const sendMessage = (msg) =>
    new Promise((resolve) => {
      if (!hasChrome()) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime?.lastError) resolve(null);
          else resolve(resp);
        });
      } catch {
        resolve(null);
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

  const escapeHtml = (str) => {
    if (typeof str !== "string") return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
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
      try { return structuredClone(obj); } catch { /* fall through */ }
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

        if (e.key === key &&
            (ctrl ? (e.ctrlKey || e.metaKey) : true) &&
            (shift ? e.shiftKey : true)) {
          e.preventDefault();
          binding.handler(e);
          return;
        }
      }
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
    onKeyboard
  });
})();
