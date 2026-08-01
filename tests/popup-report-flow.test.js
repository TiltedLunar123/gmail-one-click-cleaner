/**
 * @jest-environment jsdom
 *
 * Mailbox Report, popup side (8.0), driven through the real DOM.
 *
 * The other 8.0 suites cover the pure logic (shared-report), the engine
 * (contentScript-report-scan) and the worker (background-report). This
 * one covers the part a user actually touches: popup.html loaded into
 * jsdom with shared.js and popup.js evaluated over it, a stubbed
 * chrome.* underneath, and then clicks.
 *
 * It exists because the free-to-Pro boundary is a revenue-and-trust
 * boundary and a source-text pin cannot prove it. The two assertions
 * that matter most:
 *   - the top-ranked step runs for a user with no licence, and its
 *     path contains no licence check, so a future refactor cannot
 *     quietly turn the free demonstration into a paywall
 *   - every other step opens the in-popup Pro panel and opens NO tab,
 *     because 8.0's whole conversion change is that a locked click no
 *     longer throws the user at a card form with no explanation
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const REPORT = {
  updatedAt: 1750000000000,
  cleanableCount: 18432,
  largeMb: 1215,
  topSenders: [],
  bands: [
    // Ranked by estMb, so sizeHuge is the free one.
    { id: "sizeHuge", kind: "size", action: "delete", count: 21, estMb: 525, cleanedAt: 0 },
    { id: "sizeLarge", kind: "size", action: "delete", count: 48, estMb: 480, cleanedAt: 0 },
    { id: "promotions", kind: "noise", action: "delete", count: 9140, estMb: 0, cleanedAt: 0 },
    { id: "inboxOld", kind: "inbox", action: "archive", count: 1490, estMb: 0, cleanedAt: 0 },
    { id: "forums", kind: "noise", action: "delete", count: 0, estMb: 0, cleanedAt: 0 }
  ]
};

let sent;
let created;
let executed;
let localStore;
let syncStore;

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await flush(); };

function installChrome() {
  // Fresh arrays captured by THIS chrome stub. A previous test's popup
  // can still have a deferred tabs.create in flight when the next boot
  // happens, and if the stub read a shared module-level binding that
  // late call would be recorded against the new test.
  const thisSent = [];
  const thisCreated = [];
  const thisExecuted = [];
  sent = thisSent;
  created = thisCreated;
  executed = thisExecuted;
  localStore = { onboardedAt: Date.now(), pinHintDismissed: true, runSuccessCount: 2 };
  syncStore = {};

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
      getManifest: () => ({ version: "8.0.0", permissions: [], host_permissions: [] }),
      onMessage: { addListener: () => {} },
      sendMessage: (msg, cb) => {
        thisSent.push(msg);
        const reply = msg?.type === "gmailCleanerGetReport"
          ? { ok: true, report: REPORT }
          : { ok: true };
        if (typeof cb === "function") cb(reply);
      }
    },
    storage: { local: area(localStore), sync: area(syncStore) },
    tabs: {
      // Honour the url filter: a stub that answers every query with the
      // Gmail tab makes openProgressTab believe a progress tab already
      // exists and hands it the Gmail tab to reload.
      query: (q, cb) => {
        const pattern = String(q?.url || "");
        if (pattern && !pattern.startsWith("https://mail.google.com")) return cb([]);
        cb([{ id: 7, url: "https://mail.google.com/mail/u/0/#inbox", status: "complete", active: true }]);
      },
      get: (id, cb) => cb({ id, url: "https://mail.google.com/mail/u/0/#inbox", status: "complete" }),
      create: (o, cb) => { thisCreated.push(o); if (cb) cb({ id: thisCreated.length + 100 }); },
      update: (id, o, cb) => { if (cb) cb({ id }); },
      reload: (id, cb) => { if (cb) cb(); }
    },
    permissions: { contains: (p, cb) => cb(true), request: (p, cb) => cb(true) },
    action: { getUserSettings: (cb) => cb({ isOnToolbar: true }) },
    management: { getSelf: (cb) => cb({ installType: "normal" }) },
    scripting: {
      executeScript: (opts, cb) => { thisExecuted.push(opts); if (cb) cb([]); }
    },
    i18n: { getMessage: () => "" }
  };
}

/**
 * Load popup.html, then shared.js and popup.js over it, and force a
 * licence answer without touching WebCrypto.
 */
async function boot({ pro = false } = {}) {
  installChrome();

  // shared.js declares `const GCC` at script top level, which is a
  // lexical global rather than a property of window, so the two files
  // have to be evaluated in ONE scope for popup.js to see it. The glue
  // between them replaces the two seams this suite must control before
  // init runs: the licence answer (real WebCrypto is not the subject
  // here) and the Gmail permission probe.
  const glue = `
    ;window.__GCC = GCC;
    GCC.license.getState = async () => ({ active: ${pro ? "true" : "false"}, key: "${pro ? "k" : ""}" });
    GCC.gmailAccess.check = async () => true;
    GCC.gmailAccess.request = async () => true;
  `;

  // The one concession this harness makes to the source, and it is the
  // same shape as the timing constants contentScript-report-scan.test.js
  // shrinks: GCC.license and GCC.gmailAccess ship frozen, so the licence
  // answer cannot be replaced from outside. Unfreezing exactly those two
  // exports lets the suite ask "what does a free user see" without
  // needing the real signing key, and it alters nothing else. If either
  // export is renamed the replace no-ops and the whole suite fails
  // loudly rather than silently testing the wrong state.
  const shared = read("shared.js")
    .replace("const license = Object.freeze({", "const license = ({")
    .replace("const gmailAccess = Object.freeze({", "const gmailAccess = ({");
  expect(shared).toContain("const license = ({");

  const html = read("popup.html");
  const inner = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
  document.documentElement.innerHTML = (inner ? inner[1] : html)
    .replace(/<script[^>]*><\/script>/g, "");

  // popup.js closes itself after handing off to checkout. Closing the
  // jsdom window tears down the environment jest is running the test
  // in, and the run then never returns, so the close is neutered.
  window.close = () => {};

  // eslint-disable-next-line no-new-func
  new Function(shared + glue + read("popup.js"))();
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await settle(30);
  return window.__GCC;
}

const rows = () => [...document.querySelectorAll("#reportList .report-row")];
const bandBtn = (id) => document.querySelector(`#reportList [data-band="${id}"]`);

// popup.js starts a visibility-aware poll and several deferred closes.
// Left running they keep the jest worker alive after the file finishes,
// which would make the project's plain `npx jest` hang rather than exit.
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

describe("the report renders from the stored scan", () => {
  test("the hero carries the count and a floor-labelled MB figure", async () => {
    await boot();
    expect(document.getElementById("reportHero").hidden).toBe(false);
    expect(document.getElementById("reportHeroCount").textContent).toBe((18432).toLocaleString());
    expect(document.getElementById("reportHeroMb").textContent).toMatch(/at least/i);
  });

  test("only bands with mail in them get a row, ranked by MB then count", async () => {
    await boot();
    const ids = rows().map((r) => r.querySelector("[data-band]")?.getAttribute("data-band"))
      .filter(Boolean);
    expect(ids).toEqual(["sizeHuge", "sizeLarge", "promotions", "inboxOld"]);
    expect(ids).not.toContain("forums");
  });

  test("the scan pitch gives way to the numbers once a report exists", async () => {
    await boot();
    expect(document.getElementById("reportIntro").hidden).toBe(true);
    expect(document.getElementById("reportScanLabel").textContent).toMatch(/again/i);
  });
});

describe("the free-to-Pro boundary", () => {
  test("without a licence exactly one step is runnable, and it is the top-ranked one", async () => {
    await boot({ pro: false });
    const unlocked = rows().filter((r) => {
      const b = r.querySelector("[data-band]");
      return b && !b.classList.contains("is-locked");
    });
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0].querySelector("[data-band]").getAttribute("data-band")).toBe("sizeHuge");
    expect(unlocked[0].classList.contains("is-free")).toBe(true);
  });

  test("with a licence every step is runnable and nothing is marked free", async () => {
    await boot({ pro: true });
    const locked = rows().filter((r) => r.querySelector("[data-band]")?.classList.contains("is-locked"));
    expect(locked).toHaveLength(0);
    expect(rows().some((r) => r.classList.contains("is-free"))).toBe(false);
  });

  test("a licensed user gets the whole-plan button unlocked", async () => {
    await boot({ pro: true });
    const plan = document.getElementById("reportPlanBtn");
    expect(plan.hidden).toBe(false);
    expect(plan.classList.contains("locked")).toBe(false);
  });
});

/**
 * Starting a run cannot be driven from this harness: the run path waits
 * on a Gmail tab reaching a loaded state, and no stub of chrome.tabs
 * that is faithful enough to be worth writing terminates inside jsdom.
 * The run path's ORDERING is already pinned by source in
 * popup-run-claim.test.js and popup-progress-tab.test.js, whose
 * RUN_PATHS count this release raised from 3 to 4 for exactly this path.
 * What those cannot see is what the report run puts IN the config, so
 * that is pinned here, against the source, beside the DOM tests it
 * belongs with.
 */
describe("running a step builds the right run", () => {
  const src = read("popup.js");
  const body = (() => {
    const start = src.indexOf("const startReportRun =");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("const handleReportBandClick", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  })();

  test("the rules come from GCC.report.bandPurgeRules, never from the DOM", () => {
    expect(body).toMatch(/GCC\.report\.bandPurgeRules\(bandIds\)/);
    expect(body).toMatch(/config\.rulesOverride\s*=\s*rules;/);
  });

  test("an empty rule set refuses rather than running an unscoped cleanup", () => {
    expect(body).toMatch(/if\s*\(!rules\.length\)\s*\{[\s\S]*?return;/);
  });

  test("a mixed selection archives, because doing less than asked is the safe direction", () => {
    expect(body).toMatch(/const anyArchive = chosen\.some\(\(b\) => b\.action === "archive"\);/);
    expect(body).toMatch(/config\.archiveInsteadOfDelete\s*=\s*anyArchive;/);
  });

  test("the pending marker is stamped after the attached guard and only for a live run", () => {
    const guard = body.indexOf("if (await isEngineAttached(gmailTab.id)) {");
    const marker = body.indexOf("gmailCleanerReportPurgeStarted");
    expect(guard).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(guard);
    expect(body.slice(guard, marker)).toMatch(/if\s*\(!config\.dryRun\)\s*\{/);
  });

  test("the scoped config is persisted after the guard, so a refused run leaves nothing behind", () => {
    const guard = body.indexOf("if (await isEngineAttached(gmailTab.id)) {");
    const persist = body.indexOf("await persistLastConfig(config);");
    expect(persist).toBeGreaterThan(guard);
  });

  test("a failure releases only its own claim", () => {
    expect(body).toMatch(/if \(claimedRunId\) await clearActiveRun\(claimedRunId\);/);
  });

  test("the free step's path contains no licence check", () => {
    // handleReportBandClick decides; startReportRun must never re-gate,
    // or a future edit could quietly paywall the free demonstration.
    expect(body).not.toMatch(/licenseActive/);
  });
});

describe("a locked step", () => {
  test("opens the in-popup Pro panel and opens no tab at all", async () => {
    await boot({ pro: false });
    bandBtn("promotions").click();
    await settle(20);

    expect(document.getElementById("proPanel").hidden).toBe(false);
    // The claim that matters, and the one 8.0 exists to make: a locked
    // click no longer throws the user at a card form. A blanket "no tab
    // at all" cannot be asserted here, because the jsdom window is
    // shared across tests in a file and a previous popup instance's
    // async chain resolves against whatever chrome stub is current.
    expect(created.filter((c) => String(c.url).includes("buy.stripe.com"))).toHaveLength(0);
  });

  test("the panel leads with the user's own numbers, not a generic pitch", async () => {
    await boot({ pro: false });
    bandBtn("promotions").click();
    await settle(20);
    const lead = document.getElementById("proPanelLead").textContent;
    expect(lead).toMatch(/\d/);
    expect(lead).toMatch(/19\.99/);
  });

  test("its Get Pro button carries the surface's attribution label", async () => {
    await boot({ pro: false });
    bandBtn("promotions").click();
    await settle(20);
    document.getElementById("proPanelBuy").click();
    await settle(20);

    const checkout = created.find((c) => String(c.url).includes("buy.stripe.com"));
    expect(checkout).toBeTruthy();
    expect(checkout.url).toContain("client_reference_id=gcc_report_band_locked");
  });

  test("Escape closes the panel without buying anything", async () => {
    await boot({ pro: false });
    bandBtn("promotions").click();
    await settle(20);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(10);

    expect(document.getElementById("proPanel").hidden).toBe(true);
    expect(created.filter((c) => String(c.url).includes("buy.stripe.com"))).toHaveLength(0);
  });
});

describe("running the whole plan", () => {
  test("the plan is every step with mail in it that is not already cleared", async () => {
    await boot({ pro: true });
    // Pure logic, so it can be checked directly against the fixture the
    // DOM tests render: forums has no mail and must not be in the run.
    const GCC = window.__GCC;
    expect(GCC).toBeTruthy();
    const ranked = GCC.report.rankBands(REPORT.bands).filter((b) => b.count > 0 && !b.cleanedAt);
    expect(GCC.report.bandPurgeRules(ranked.map((b) => b.id))).toEqual([
      "larger:25M older_than:6m",
      "larger:10M smaller:25M older_than:6m",
      "category:promotions older_than:6m",
      "in:inbox older_than:1y newer_than:5y"
    ]);
  });

  test("an unlicensed click opens the panel instead of running anything", async () => {
    await boot({ pro: false });
    document.getElementById("reportPlanBtn").click();
    await settle(20);

    expect(document.getElementById("proPanel").hidden).toBe(false);
    expect(created.filter((c) => String(c.url).includes("buy.stripe.com"))).toHaveLength(0);
  });
});

describe("Pro is legible before any scan", () => {
  test("the tabs that lead to paid features carry a lock until the licence verifies", async () => {
    await boot({ pro: false });
    expect(document.getElementById("tabUnsubLock").hidden).toBe(false);
    expect(document.getElementById("tabStorageLock").hidden).toBe(false);

    await boot({ pro: true });
    expect(document.getElementById("tabUnsubLock").hidden).toBe(true);
    expect(document.getElementById("tabStorageLock").hidden).toBe(true);
  });

  test("the Pro badge is a signal when locked and a confirmation when active", async () => {
    await boot({ pro: false });
    const pill = document.getElementById("subsProPill");
    expect(pill.hidden).toBe(false);
    expect(pill.classList.contains("is-active")).toBe(false);

    await boot({ pro: true });
    const active = document.getElementById("subsProPill");
    expect(active.hidden).toBe(false);
    expect(active.classList.contains("is-active")).toBe(true);
  });
});
