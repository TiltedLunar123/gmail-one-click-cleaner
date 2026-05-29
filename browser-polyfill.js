// browser-polyfill.js — Minimal cross-browser compatibility shim
// Enables Firefox (WebExtensions) and Edge support alongside Chrome
// Based on webextension-polyfill patterns

(() => {
  "use strict";

  // If browser API already exists (Firefox), wrap it to match Chrome patterns
  // If only chrome exists (Chrome/Edge), create browser as alias
  if (typeof globalThis.browser !== "undefined" && globalThis.browser.runtime) {
    // Firefox — browser API exists, ensure chrome also works
    if (typeof globalThis.chrome === "undefined") {
      globalThis.chrome = globalThis.browser;
    }
    return;
  }

  if (typeof globalThis.chrome === "undefined" || !globalThis.chrome.runtime) {
    // Neither API available — not in an extension context
    return;
  }

  // Chrome/Edge — create promisified browser.* namespace
  const chrome = globalThis.chrome;

  function wrapAsyncMethod(api, method) {
    return function (...args) {
      return new Promise((resolve, reject) => {
        try {
          api[method](...args, (result) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(result);
            }
          });
        } catch (e) {
          reject(e);
        }
      });
    };
  }

  function wrapApi(api, asyncMethods) {
    if (!api) return api;
    const wrapped = {};

    for (const key of Object.keys(api)) {
      if (typeof api[key] === "function") {
        if (asyncMethods.includes(key)) {
          wrapped[key] = wrapAsyncMethod(api, key);
        } else {
          wrapped[key] = api[key].bind(api);
        }
      } else if (typeof api[key] === "object" && api[key] !== null) {
        wrapped[key] = api[key];
      } else {
        wrapped[key] = api[key];
      }
    }

    // Preserve event listeners
    for (const key of Object.keys(api)) {
      if (api[key]?.addListener) {
        wrapped[key] = api[key];
      }
    }

    return wrapped;
  }

  const browser = {
    runtime: {
      ...chrome.runtime,
      sendMessage: wrapAsyncMethod(chrome.runtime, "sendMessage"),
      getURL: chrome.runtime.getURL.bind(chrome.runtime),
      onMessage: chrome.runtime.onMessage,
      onInstalled: chrome.runtime.onInstalled,
      onStartup: chrome.runtime.onStartup
    }
  };

  // Wrap tabs API
  if (chrome.tabs) {
    browser.tabs = wrapApi(chrome.tabs, ["query", "create", "update", "sendMessage", "remove"]);
    browser.tabs.onUpdated = chrome.tabs.onUpdated;
    browser.tabs.onRemoved = chrome.tabs.onRemoved;
  }

  // Wrap storage API
  if (chrome.storage) {
    browser.storage = {};
    for (const area of ["local", "sync", "session"]) {
      if (chrome.storage[area]) {
        browser.storage[area] = wrapApi(chrome.storage[area], ["get", "set", "remove", "clear"]);
        if (chrome.storage[area].onChanged) {
          browser.storage[area].onChanged = chrome.storage[area].onChanged;
        }
      }
    }
    if (chrome.storage.onChanged) {
      browser.storage.onChanged = chrome.storage.onChanged;
    }
  }

  // Wrap scripting API
  if (chrome.scripting) {
    browser.scripting = wrapApi(chrome.scripting, ["executeScript", "insertCSS", "removeCSS"]);
  }

  // Wrap alarms API
  if (chrome.alarms) {
    browser.alarms = wrapApi(chrome.alarms, ["create", "get", "getAll", "clear", "clearAll"]);
    browser.alarms.onAlarm = chrome.alarms.onAlarm;
  }

  // Wrap permissions API
  if (chrome.permissions) {
    browser.permissions = wrapApi(chrome.permissions, ["contains", "request", "remove", "getAll"]);
  }

  globalThis.browser = browser;
})();
