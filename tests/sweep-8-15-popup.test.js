/**
 * @jest-environment jsdom
 *
 * 8.15, the behavioural half of the safety-list fix, driven through the
 * real popup: popup.html in jsdom with shared.js and popup.js evaluated
 * over it, a stubbed chrome.* underneath, and then a click on Run.
 *
 * The defect it pins: popup.js answered a REJECTED chrome.storage.sync
 * read with `{}`, and getWhitelist / getProtectKeywords turned that into
 * `[]`. The engine emits `-from:` and `-subject:` exclusions from that
 * list and from nowhere else, and it never re-reads storage, so a
 * one-second sync hiccup produced a cleanup with no Never Delete list
 * and no protected keywords at all, reported as an ordinary success on
 * every surface.
 *
 * A source pin cannot prove this one. The whole question is what the
 * page does when a promise rejects, so the suite has to run it.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

let executed;
let localStore;
let syncStore;
let failSyncKeys;

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await flush(); };

function installChrome() {
  const thisExecuted = [];
  executed = thisExecuted;
  localStore = { onboardedAt: Date.now(), pinHintDismissed: true, runSuccessCount: 2 };
  syncStore = { whitelist: ["boss@work.com"], protectKeywords: ["invoice"] };
  failSyncKeys = new Set();

  const area = (store, name) => ({
    get: (keys, cb) => {
      const list = keys === null || keys === undefined
        ? Object.keys(store)
        : (Array.isArray(keys) ? keys : [keys]);
      if (name === "sync" && list.some((k) => failSyncKeys.has(k))) {
        // Exactly how Chrome reports a failed read: the callback still
        // fires, and runtime.lastError carries the reason. GCC.promisify
        // turns that into a rejection.
        chrome.runtime.lastError = { message: "storage unavailable" };
        cb(undefined);
        chrome.runtime.lastError = null;
        return;
      }
      const out = {};
      for (const k of list) if (k in store) out[k] = store[k];
      cb(out);
    },
    set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
    remove: (keys, cb) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
      if (cb) cb();
    }
  });

  global.chrome = {
    runtime: {
      id: "test",
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: "8.15.0", permissions: [], host_permissions: [] }),
      onMessage: { addListener: () => {} },
      sendMessage: (msg, cb) => {
        const reply = msg?.type === "gmailCleanerClaimRun"
          ? { ok: true, claim: { runId: "run-1", gmailTabId: 7 } }
          : { ok: true };
        if (typeof cb === "function") cb(reply);
      }
    },
    storage: { local: area(localStore, "local"), sync: area(syncStore, "sync") },
    tabs: {
      query: (q, cb) => {
        const pattern = String(q?.url || "");
        if (pattern && !pattern.startsWith("https://mail.google.com")) return cb([]);
        cb([{ id: 7, url: "https://mail.google.com/mail/u/0/#inbox", status: "complete", active: true }]);
      },
      get: (id, cb) => cb({ id, url: "https://mail.google.com/mail/u/0/#inbox", status: "complete" }),
      create: (o, cb) => { if (cb) cb({ id: 101 }); },
      update: (id, o, cb) => { if (cb) cb({ id }); },
      reload: (id, cb) => { if (cb) cb(); }
    },
    permissions: { contains: (p, cb) => cb(true), request: (p, cb) => cb(true) },
    action: { getUserSettings: (cb) => cb({ isOnToolbar: true }) },
    management: { getSelf: (cb) => cb({ installType: "normal" }) },
    scripting: {
      executeScript: (opts, cb) => { thisExecuted.push(opts); if (cb) cb([{ result: false }]); }
    },
    i18n: { getMessage: () => "" }
  };
}

async function boot() {
  installChrome();

  // shared.js declares `const GCC` at script top level, so the two files
  // have to be evaluated in ONE scope. The licence answer and the Gmail
  // permission probe are the two seams replaced here, exactly as
  // popup-report-flow.test.js does it.
  const glue = `
    ;window.__GCC = GCC;
    GCC.license.getState = async () => ({ active: false, key: "" });
    GCC.gmailAccess.check = async () => true;
    GCC.gmailAccess.request = async () => true;
  `;

  const shared = read("shared.js")
    .replace("const license = Object.freeze({", "const license = ({")
    .replace("const gmailAccess = Object.freeze({", "const gmailAccess = ({");
  expect(shared).toContain("const license = ({");

  const html = read("popup.html");
  const inner = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
  document.documentElement.innerHTML = (inner ? inner[1] : html)
    .replace(/<script[^>]*><\/script>/g, "");

  window.close = () => {};

  // eslint-disable-next-line no-new-func
  new Function(shared + glue + read("popup.js"))();
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await settle(30);
}

const injectedEngine = () =>
  executed.filter((o) => Array.isArray(o?.files) && o.files.includes("contentScript.js"));

const statusText = () => document.getElementById("status")?.textContent || "";

// popup.js starts a visibility-aware poll and several deferred closes.
const timers = { intervals: [], timeouts: [] };
const realSetInterval = global.setInterval;
const realSetTimeout = global.setTimeout;

beforeEach(() => {
  document.documentElement.innerHTML = "";
  delete window.GCC;
  global.setInterval = (...a) => { const id = realSetInterval(...a); timers.intervals.push(id); return id; };
  global.setTimeout = (...a) => { const id = realSetTimeout(...a); timers.timeouts.push(id); return id; };
  window.setInterval = global.setInterval;
  window.setTimeout = global.setTimeout;
});

afterEach(() => {
  for (const id of timers.intervals) clearInterval(id);
  for (const id of timers.timeouts) clearTimeout(id);
  timers.intervals.length = 0;
  timers.timeouts.length = 0;
  global.setInterval = realSetInterval;
  global.setTimeout = realSetTimeout;
  window.setInterval = realSetInterval;
  window.setTimeout = realSetTimeout;
});

describe("a cleanup will not run without the safety lists", () => {
  test("a working read still runs, and hands the engine both lists", async () => {
    // The control. Without it, "no engine was injected" would pass for
    // any reason at all, including a harness that never got as far as
    // the run.
    await boot();
    document.getElementById("runCleanup").click();
    await settle(40);

    expect(injectedEngine()).toHaveLength(1);
    const configCall = executed.find((o) => Array.isArray(o?.args) && o.args[0]?.whitelist);
    expect(configCall.args[0].whitelist).toEqual(["boss@work.com"]);
    expect(configCall.args[0].protectKeywords).toEqual(["invoice"]);
  });

  test("a failed whitelist read stops the run instead of running without it", async () => {
    await boot();
    failSyncKeys.add("whitelist");

    document.getElementById("runCleanup").click();
    await settle(40);

    expect(injectedEngine()).toHaveLength(0);
    expect(statusText().toLowerCase()).toMatch(/could not be read/);
  });

  test("a failed protected-keywords read stops it too", async () => {
    // The keyword shield goes out through the same path and was lost the
    // same way: no -subject: exclusion, so mail the user shielded by
    // subject was in scope.
    await boot();
    failSyncKeys.add("protectKeywords");

    document.getElementById("runCleanup").click();
    await settle(40);

    expect(injectedEngine()).toHaveLength(0);
    expect(statusText().toLowerCase()).toMatch(/could not be read/);
  });

  test("a read-only scan refuses on the same terms", async () => {
    // The Mailbox Report predicts what its own Clean button will do. A
    // scan that silently dropped the exclusions would agree with an
    // over-broad purge, so the parity surface could not show the loss.
    await boot();
    failSyncKeys.add("whitelist");

    document.getElementById("reportScanBtn").click();
    await settle(40);

    expect(injectedEngine()).toHaveLength(0);
  });
});
