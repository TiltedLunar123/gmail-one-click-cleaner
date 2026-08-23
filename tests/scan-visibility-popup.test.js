/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/"}
 *
 * The popup admits a scan is running (8.23).
 *
 * A browser action popup is destroyed the instant focus moves, and the
 * five claimless run kinds drive the user's VISIBLE Gmail tab through up
 * to fifteen searches (sixty-three for smartScan). So the ordinary way to
 * watch a scan work is to click into Gmail, which kills the only surface
 * reporting it.
 *
 * On reopening, the popup showed nothing at all: refreshRunBanner did
 * `if (!resp.run) { hideRunBanner(); return null; }`, and `resp.run` is
 * the ACTIVE_RUN claim, which a scan never takes. The worker had already
 * computed engineReachable/engineRunning and sent them; the popup threw
 * them away. The user was told their mailbox was idle while their Gmail
 * tab was visibly working.
 *
 * Show is deliberately NOT offered here. The progress page is built for
 * cleanup runs and its recovery affordance re-injects `lastConfig`, which
 * for a scan is the last full CLEANUP config: offering it would put a
 * delete sweep one confirm away from a read-only scan.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 14) => { for (let i = 0; i < n; i++) await flush(); };

let runStateReply;
let localStore;
let sentResets;
let messageListeners;
let runStateCalls;

function installChrome() {
  const thisResets = [];
  const thisListeners = [];
  const thisRunStateCalls = [];
  sentResets = thisResets;
  messageListeners = thisListeners;
  runStateCalls = thisRunStateCalls;
  localStore = { onboardedAt: Date.now(), pinHintDismissed: true, runSuccessCount: 2 };
  const syncStore = {};

  const area = (store) => ({
    get: (keys, cb) => {
      const out = {};
      const list = keys === null || keys === undefined
        ? Object.keys(store)
        : (Array.isArray(keys) ? keys : [keys]);
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
      getManifest: () => ({ version: "8.22.0", permissions: [], host_permissions: [] }),
      onMessage: { addListener: (fn) => { thisListeners.push(fn); } },
      sendMessage: (msg, cb) => {
        let reply = { ok: true };
        if (msg?.type === "gmailCleanerRunState") {
          thisRunStateCalls.push(msg);
          reply = runStateReply;
        }
        if (msg?.type === "gmailCleanerForceReset") {
          thisResets.push(msg);
          reply = { ok: false, reason: "engine_running", cancelSent: true };
        }
        if (typeof cb === "function") cb(reply);
      }
    },
    storage: { local: area(localStore), sync: area(syncStore) },
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
    scripting: { executeScript: (opts, cb) => { if (cb) cb([]); } },
    i18n: { getMessage: () => "" }
  };
}

async function boot() {
  installChrome();
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

const banner = () => document.getElementById("runBanner");
const title = () => document.getElementById("runBannerTitle").textContent.trim();
const text = () => document.getElementById("runBannerText").textContent.trim();
const showBtn = () => document.getElementById("runBannerShowBtn");
const resetBtn = () => document.getElementById("runBannerResetBtn");
const isShown = () => banner().classList.contains("show");

const SCAN_STATE = (kind, tabId = 12) => ({
  ok: true,
  run: null,
  engineReachable: true,
  engineRunning: true,
  engineTabId: tabId,
  engineRunKind: kind
});

const timers = { intervals: [], timeouts: [] };
const realSetInterval = global.setInterval;
const realSetTimeout = global.setTimeout;

beforeEach(() => {
  document.documentElement.innerHTML = "";
  delete window.GCC;
  runStateReply = { ok: true, run: null, engineReachable: false, engineRunning: false, engineTabId: null, engineRunKind: "" };
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
});

describe("a scan with no claim raises the banner", () => {
  test("reopening mid-scan says so instead of showing an idle popup", async () => {
    runStateReply = SCAN_STATE("reportScan");
    await boot();

    // The bug: hideRunBanner ran because resp.run was null, so this was false.
    expect(isShown()).toBe(true);
    expect(banner().classList.contains("is-stuck")).toBe(false);
    expect(title().length).toBeGreaterThan(0);
    // It must not borrow the cleanup copy: nothing is being deleted and
    // there is no progress page to open.
    expect(text()).not.toMatch(/progress page/i);
  });

  test.each([
    ["reportScan"], ["storageScan"], ["smartScan"], ["subscriptionScan"]
  ])("%s raises it", async (kind) => {
    runStateReply = SCAN_STATE(kind);
    await boot();
    expect(isShown()).toBe(true);
  });

  test("unsubscribe is named as itself, not as a read", async () => {
    runStateReply = SCAN_STATE("reportScan");
    await boot();
    const readTitle = title();

    runStateReply = SCAN_STATE("unsubscribe");
    await boot();
    // It opens messages and it changes things, so it must not hide behind
    // the same wording as a read-only scan.
    expect(title()).not.toBe(readTitle);
  });

  test("Show is not offered, because the progress page would re-inject the last cleanup config", async () => {
    runStateReply = SCAN_STATE("reportScan");
    await boot();
    expect(showBtn().hidden).toBe(true);
  });

  test("Reset is offered and aims at the tab the engine is actually in", async () => {
    runStateReply = SCAN_STATE("smartScan", 12);
    await boot();
    expect(resetBtn().hidden).toBe(false);

    resetBtn().dispatchEvent(new window.Event("click"));
    await settle(20);

    expect(sentResets.length).toBeGreaterThan(0);
    expect(sentResets[0].tabId).toBe(12);
  });
});

describe("the banner retracts itself", () => {
  test("a scan that finishes while the popup is open takes the banner down", async () => {
    runStateReply = SCAN_STATE("reportScan");
    await boot();
    expect(isShown()).toBe(true);

    // The engine's terminal broadcast, and a worker that now answers
    // "nothing is running" because the run really has ended.
    runStateReply = { ok: true, run: null, engineReachable: true, engineRunning: false, engineTabId: null, engineRunKind: "" };
    messageListeners.forEach((fn) =>
      fn({ type: "gmailCleanerProgress", runKind: "reportScan", phase: "done", done: true, bands: [] })
    );
    await settle(20);

    expect(isShown()).toBe(false);
  });

  test("a mid-run progress beat neither takes it down nor re-asks the worker", async () => {
    runStateReply = SCAN_STATE("reportScan");
    await boot();
    const asked = runStateCalls.length;

    // A scan emits a beat per query, and each re-ask costs the worker a
    // ping to every mailbox tab. Only a terminal message changes anything
    // the banner is showing, so only a terminal message is worth asking.
    for (let i = 0; i < 5; i++) {
      messageListeners.forEach((fn) =>
        fn({ type: "gmailCleanerProgress", runKind: "reportScan", phase: "query", status: "Reading..." })
      );
    }
    await settle(20);

    expect(isShown()).toBe(true);
    expect(runStateCalls.length).toBe(asked);
  });
});

describe("an unrecognised run kind", () => {
  test.each([["toString"], ["constructor"], ["__proto__"], ["somethingNew"]])(
    "%s is described generically instead of throwing",
    async (kind) => {
      runStateReply = SCAN_STATE(kind);
      await boot();
      // A plain object lookup answers "toString" with an inherited
      // function, and destructuring one throws, which would lose the
      // whole banner rather than one word of it.
      expect(isShown()).toBe(true);
      expect(title().length).toBeGreaterThan(0);
    }
  );
});

describe("the states that already worked keep working", () => {
  test("nothing running and nothing claimed leaves the banner down", async () => {
    await boot();
    expect(isShown()).toBe(false);
  });

  test("a claimed cleanup still offers Show", async () => {
    runStateReply = {
      ok: true,
      run: { runId: "r-1", gmailTabId: 7, startedAt: Date.now() },
      engineReachable: true,
      engineRunning: true,
      engineTabId: 7,
      engineRunKind: "cleanup"
    };
    await boot();
    expect(isShown()).toBe(true);
    expect(banner().classList.contains("is-stuck")).toBe(false);
    expect(showBtn().hidden).toBe(false);
  });

  test("a claim whose engine is gone still reads as stuck", async () => {
    runStateReply = {
      ok: true,
      run: { runId: "r-1", gmailTabId: 7, startedAt: Date.now() },
      engineReachable: false,
      engineRunning: false,
      engineTabId: null,
      engineRunKind: ""
    };
    await boot();
    expect(isShown()).toBe(true);
    expect(banner().classList.contains("is-stuck")).toBe(true);
  });

  test("a worker that cannot answer leaves the banner down", async () => {
    runStateReply = { ok: false };
    await boot();
    expect(isShown()).toBe(false);
  });
});
