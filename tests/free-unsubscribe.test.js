/**
 * @jest-environment jsdom
 *
 * 8.17: every unpaid install gets three free unsubscribes, once.
 *
 * The counter is local, has no clock, and is charged only against
 * senders that actually came back `unsubscribed`. A read that failed
 * is not a read that said zero-used: remaining(null) is 0 so a broken
 * store cannot mint a fresh three on every open.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const LOCALES = ["en", "de", "es", "fr", "ja", "pt_BR", "ru"];
const FREE_KEYS = [
  "unsubFreeSubStart",
  "unsubFreeSubOne",
  "unsubFreeSubMany",
  "subsFreeLeftStart",
  "subsFreeLeftOne",
  "subsFreeLeftMany",
  "subsFreeUsedUp",
  "firstFreeUnsubOne",
  "firstFreeUnsubs"
];

const catalog = (l) =>
  JSON.parse(read(path.join("_locales", l, "messages.json")));

const sharedCode = read("shared.js");
const iifeMatch = sharedCode.match(/const GCC = ([\s\S]*);[\s]*$/);
const loadGcc = (chromeStub) => new Function("document", "window", "chrome",
  `return ${iifeMatch[1]}`)(
  {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      className: "", setAttribute: () => {}, appendChild: () => {},
      style: {}, classList: { add: () => {}, remove: () => {} },
      remove: () => {}
    }),
    addEventListener: () => {}
  },
  {},
  chromeStub || { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

const GCC = loadGcc();
const F = GCC.freeUnsub;

const SENDERS = [
  { email: "a@list.example", name: "List A", count: 12 },
  { email: "b@list.example", name: "List B", count: 8 },
  { email: "c@list.example", name: "List C", count: 4 },
  { email: "d@list.example", name: "List D", count: 3 },
  { email: "e@list.example", name: "List E", count: 2 }
];

// A Smart card names its own action, so `action` is enough to make the
// first card an unsubscribe without hand-tuning the signal thresholds
// (smartResolvedAction takes sender.action when it is a known one).
const SMART_SENDERS = [
  { email: "a@list.example", name: "List A", action: "unsubscribe", estCount: 140,
    signals: { count: 140, unreadRatio: 0.95, oldShare: 0.1, estMb: 4 } },
  { email: "b@list.example", name: "List B", action: "unsubscribe", estCount: 90,
    signals: { count: 90, unreadRatio: 0.9, oldShare: 0.1, estMb: 3 } }
];

let executed;
let localStore;
let syncStore;
let failLocalKeys;
let messageListeners;

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await flush(); };

function installChrome({ failLocal = false, used } = {}) {
  const thisExecuted = [];
  executed = thisExecuted;
  messageListeners = [];
  failLocalKeys = new Set(failLocal ? ["freeUnsubUsed"] : []);
  localStore = {
    onboardedAt: Date.now(),
    pinHintDismissed: true,
    runSuccessCount: 2
  };
  if (used !== undefined) localStore.freeUnsubUsed = used;
  syncStore = {};

  const area = (store, name) => ({
    get: (keys, cb) => {
      const list = keys === null || keys === undefined
        ? Object.keys(store)
        : (Array.isArray(keys) ? keys : [keys]);
      if (name === "local" && list.some((k) => failLocalKeys.has(k))) {
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
      getManifest: () => ({ version: "8.18.1", permissions: [], host_permissions: [] }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: (msg, cb) => {
        let reply = { ok: true };
        if (msg?.type === "gmailCleanerGetSubscriptions") {
          reply = { ok: true, scan: { senders: SENDERS } };
        } else if (msg?.type === "gmailCleanerGetSmartScan") {
          reply = {
            ok: true,
            scan: { senders: SMART_SENDERS, updatedAt: 1 },
            feedback: { bySender: {} }
          };
        }
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

async function boot({ pro = false, failLocal = false, used } = {}) {
  installChrome({ failLocal, used });

  const glue = `
    ;window.__GCC = GCC;
    GCC.license.getState = async () => ({ active: ${pro ? "true" : "false"}, key: "${pro ? "k" : ""}" });
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
  return window.__GCC;
}

const unsubConfigs = () =>
  executed.filter((o) => Array.isArray(o?.args) && o.args[0]?.runKind === "unsubscribe");

const tickAll = () => {
  document.querySelectorAll("#subsList input[type='checkbox']:not(:disabled)")
    .forEach((cb) => { cb.checked = true; });
};

const fireProgress = (msg) => {
  for (const fn of messageListeners) fn(msg);
};

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

describe("GCC.freeUnsub.remaining", () => {
  test("never used is the full allowance", () => {
    expect(F.remaining(undefined)).toBe(3);
    expect(F.remaining(0)).toBe(3);
  });

  test("partially used counts down", () => {
    expect(F.remaining(1)).toBe(2);
    expect(F.remaining(2)).toBe(1);
  });

  test("fully used is 0", () => {
    expect(F.remaining(3)).toBe(0);
  });

  test("over-used clamps to 0", () => {
    expect(F.remaining(4)).toBe(0);
    expect(F.remaining(99)).toBe(0);
  });

  test("a garbage value denies the free run", () => {
    expect(F.remaining("nope")).toBe(0);
    expect(F.remaining({})).toBe(0);
    expect(F.remaining(NaN)).toBe(0);
    expect(F.remaining(-1)).toBe(0);
  });

  test("null meaning unreadable is 0, not 3", () => {
    expect(F.remaining(null)).toBe(0);
  });
});

describe("GCC.freeUnsub.spend", () => {
  test("a normal spend adds the ok count", () => {
    expect(F.spend(undefined, 1)).toBe(1);
    expect(F.spend(1, 1)).toBe(2);
  });

  test("an okCount of 0 spends nothing", () => {
    expect(F.spend(1, 0)).toBe(1);
    expect(F.spend(undefined, 0)).toBe(0);
  });

  test("a negative or NaN okCount spends nothing", () => {
    expect(F.spend(1, -3)).toBe(1);
    expect(F.spend(1, NaN)).toBe(1);
    expect(F.spend(1, Infinity)).toBe(1);
  });

  test("a spend that would exceed LIMIT clamps to LIMIT", () => {
    expect(F.spend(1, 10)).toBe(3);
    expect(F.spend(2, 2)).toBe(3);
  });

  test("an unreadable stored value stays fully used", () => {
    expect(F.spend(null, 1)).toBe(3);
    expect(F.spend(null, 0)).toBe(3);
  });
});

describe("GCC.freeUnsub.readOrNull", () => {
  test("a rejected local read is null, not missing", async () => {
    const stub = {
      runtime: { lastError: null },
      storage: { local: { get: (_keys, cb) => {} } }
    };
    stub.storage.local.get = (_keys, cb) => {
      stub.runtime.lastError = { message: "storage unavailable" };
      cb(undefined);
      stub.runtime.lastError = null;
    };
    const g = loadGcc(stub);
    expect(await g.freeUnsub.readOrNull()).toBeNull();
    expect(g.freeUnsub.remaining(null)).toBe(0);
  });
});

describe("the Lists tab, unlicensed with allowance", () => {
  test("runs instead of opening the paywall", async () => {
    await boot({ pro: false });
    tickAll();
    document.getElementById("unsubBtn").click();
    await settle(40);

    expect(document.getElementById("proPanel").hidden).toBe(true);
    expect(unsubConfigs().some((c) => c.args[0].unsubSenders.length === 3)).toBe(true);
  });

  test("caps the run to the remaining allowance, not 25", async () => {
    await boot({ pro: false, used: 1 });
    tickAll();
    document.getElementById("unsubBtn").click();
    await settle(40);

    expect(document.getElementById("proPanel").hidden).toBe(true);
    expect(unsubConfigs().some((c) => c.args[0].unsubSenders.length === 2)).toBe(true);
  });

  test("the remaining count is on the tab before a click", async () => {
    await boot({ pro: false });
    expect(document.getElementById("unsubBtnSub").textContent).toMatch(/3 free unsubscribes left/i);
    expect(document.getElementById("subsUpsellText").textContent).toMatch(/3 free unsubscribes left/i);
  });
});

describe("the Lists tab, unlicensed at 0", () => {
  test("opens the existing paywall and injects nothing", async () => {
    await boot({ pro: false, used: 3 });
    tickAll();
    document.getElementById("unsubBtn").click();
    await settle(40);

    expect(document.getElementById("proPanel").hidden).toBe(false);
  });

  test("an unreadable counter is treated as 0, not as never used", async () => {
    await boot({ pro: false, failLocal: true });
    tickAll();
    document.getElementById("unsubBtn").click();
    await settle(40);

    expect(document.getElementById("proPanel").hidden).toBe(false);
    expect(localStore.freeUnsubUsed).toBeUndefined();
  });
});

describe("a finished unsubscribe run charges only real unsubscribes", () => {
  test("a cancelled run charges nothing", async () => {
    await boot({ pro: false });
    tickAll();
    document.getElementById("unsubBtn").click();
    await settle(40);

    fireProgress({
      type: "gmailCleanerProgress",
      runKind: "unsubscribe",
      phase: "cancelled",
      done: true,
      unsubResults: [{ sender: "a@list.example", status: "unsubscribed" }]
    });
    await settle(20);

    expect(localStore.freeUnsubUsed).toBeUndefined();
  });

  test("an errored run charges nothing", async () => {
    await boot({ pro: false });
    tickAll();
    document.getElementById("unsubBtn").click();
    await settle(40);

    fireProgress({
      type: "gmailCleanerProgress",
      runKind: "unsubscribe",
      phase: "error",
      done: true,
      detail: "tab closed",
      unsubResults: [{ sender: "a@list.example", status: "unsubscribed" }]
    });
    await settle(20);

    expect(localStore.freeUnsubUsed).toBeUndefined();
  });

  test("a run where 2 of 3 come back manual charges only 1", async () => {
    await boot({ pro: false });
    tickAll();
    document.getElementById("unsubBtn").click();
    await settle(40);

    fireProgress({
      type: "gmailCleanerProgress",
      runKind: "unsubscribe",
      phase: "done",
      done: true,
      unsubResults: [
        { sender: "a@list.example", status: "unsubscribed" },
        { sender: "b@list.example", status: "manual" },
        { sender: "c@list.example", status: "no_button" }
      ]
    });
    await settle(20);

    expect(localStore.freeUnsubUsed).toBe(1);
    expect(document.getElementById("unsubBtnSub").textContent).toMatch(/2 free unsubscribes left/i);
  });

  // The gate reads unreadable as fully used so it refuses, which is
  // right. Writing that same number back is not: it would spend all
  // three on one storage hiccup, and nothing ever gives them back.
  // Same shape as the four write-side reads 8.16 fixed.
  test("a read that fails at spend time leaves the counter alone", async () => {
    await boot({ pro: false, used: 1 });
    tickAll();
    document.getElementById("unsubBtn").click();
    await settle(40);

    // The run went out under a good read; the store breaks before it lands.
    failLocalKeys.add("freeUnsubUsed");

    fireProgress({
      type: "gmailCleanerProgress",
      runKind: "unsubscribe",
      phase: "done",
      done: true,
      unsubResults: [{ sender: "a@list.example", status: "unsubscribed" }]
    });
    await settle(20);

    expect(localStore.freeUnsubUsed).toBe(1);
  });
});

describe("a Smart card spends the same three", () => {
  const smartUnsubBtn = () => document.querySelector("#smartList .smart-apply-btn");

  test("an unlicensed user with allowance runs instead of seeing the paywall", async () => {
    await boot({ pro: false });
    const before = unsubConfigs().length;
    smartUnsubBtn().click();
    await settle(40);

    expect(unsubConfigs().length).toBe(before + 1);
    expect(document.getElementById("proPanel").hidden).toBe(true);
  });

  test("the card sends exactly the one sender it names", async () => {
    await boot({ pro: false });
    smartUnsubBtn().click();
    await settle(40);

    const cfg = unsubConfigs().pop();
    expect(cfg.args[0].unsubSenders).toEqual(["a@list.example"]);
  });

  test("an unlicensed user at 0 gets the paywall and injects nothing", async () => {
    await boot({ pro: false, used: 3 });
    const before = unsubConfigs().length;
    smartUnsubBtn().click();
    await settle(40);

    expect(unsubConfigs().length).toBe(before);
    expect(document.getElementById("proPanel").hidden).toBe(false);
  });

  test("an unreadable counter sends a Smart click to the paywall too", async () => {
    await boot({ pro: false, failLocal: true });
    const before = unsubConfigs().length;
    smartUnsubBtn().click();
    await settle(40);

    expect(unsubConfigs().length).toBe(before);
    expect(document.getElementById("proPanel").hidden).toBe(false);
  });

  test("a Smart unsubscribe costs exactly 1 and the Lists tab agrees", async () => {
    await boot({ pro: false });
    const before = unsubConfigs().length;
    smartUnsubBtn().click();
    await settle(40);
    // Without this the done message alone would satisfy the charge and
    // the test would pass against a Smart button that never ran.
    expect(unsubConfigs().length).toBe(before + 1);

    fireProgress({
      type: "gmailCleanerProgress",
      runKind: "unsubscribe",
      phase: "done",
      done: true,
      unsubResults: [{ sender: "a@list.example", status: "unsubscribed" }]
    });
    await settle(20);

    expect(localStore.freeUnsubUsed).toBe(1);
    // The count the other button advertises has to move with it.
    expect(document.getElementById("unsubBtnSub").textContent)
      .toMatch(/2 free unsubscribes left/i);
  });

  test("a Smart run that comes back manual costs nothing", async () => {
    await boot({ pro: false });
    const before = unsubConfigs().length;
    smartUnsubBtn().click();
    await settle(40);
    expect(unsubConfigs().length).toBe(before + 1);

    fireProgress({
      type: "gmailCleanerProgress",
      runKind: "unsubscribe",
      phase: "done",
      done: true,
      unsubResults: [{ sender: "a@list.example", status: "manual" }]
    });
    await settle(20);

    expect(localStore.freeUnsubUsed).toBe(0);
  });
});

describe("the three-copy rule", () => {
  test("the new keys exist in all 7 locale files", () => {
    for (const locale of LOCALES) {
      const cat = catalog(locale);
      for (const key of FREE_KEYS) {
        expect(cat[key]).toBeDefined();
        expect(typeof cat[key].message).toBe("string");
        expect(cat[key].message.length).toBeGreaterThan(3);
      }
    }
  });

  test("the HTML fallbacks and the t() fallbacks name the same 3", () => {
    const html = read("popup.html");
    expect(html).toContain('data-i18n="unsubFreeSubStart"');
    expect(html).toContain("3 free unsubscribes left");
    expect(html).toContain('data-i18n="subsFreeLeftStart"');

    const popup = read("popup.js");
    expect(popup).toContain('t("unsubFreeSubStart", "3 free unsubscribes left")');
    expect(popup).toContain('t("unsubFreeSubOne", "1 free unsubscribe left")');
    expect(popup).toContain('t("subsFreeUsedUp", "Your 3 free unsubscribes are used up.")');
    expect(popup).toContain('t("firstFreeUnsubOne", "using your 1 free unsubscribe; Pro unlocks the rest")');
  });

  test("English catalog matches the t() fallbacks", () => {
    const en = catalog("en");
    expect(en.unsubFreeSubStart.message).toBe("3 free unsubscribes left");
    expect(en.unsubFreeSubOne.message).toBe("1 free unsubscribe left");
    expect(en.unsubFreeSubMany.message).toBe("$1 free unsubscribes left");
    expect(en.subsFreeUsedUp.message).toBe("Your 3 free unsubscribes are used up.");
    expect(en.firstFreeUnsubOne.message).toBe("using your 1 free unsubscribe; Pro unlocks the rest");
    expect(en.firstFreeUnsubs.message).toBe("using your $1 free unsubscribes; Pro unlocks the rest");
  });
});

describe("the allowance never widens anything else", () => {
  // Both unsubscribe buttons share the allowance, so the pin is no
  // longer "Smart never mentions it" but "neither one decides alone".
  // Two gates drift; that drift is what let the Lists tab advertise a
  // count the Smart card would not honour.
  test("both unsubscribe entry points go through the one gate", () => {
    const popup = read("popup.js");
    const lists = popup.slice(
      popup.indexOf("const handleUnsubscribe = async () => {"),
      popup.indexOf("const finishSubsRun = () => {")
    );
    const smart = popup.slice(
      popup.indexOf("const handleSmartApply = async (sender, action) => {"),
      popup.indexOf("const handleSmartBulkApply = async () => {")
    );
    expect(lists).toContain("await allowedUnsubCount(");
    expect(smart).toContain("await allowedUnsubCount(");
    // Neither may read the counter or size its own cap.
    expect(lists).not.toContain("GCC.freeUnsub.remaining");
    expect(smart).not.toContain("GCC.freeUnsub.remaining");
    expect(smart).not.toMatch(/\.slice\(0,/);
  });

  test("the counter is spent in exactly one place", () => {
    const popup = read("popup.js");
    expect(popup.match(/GCC\.freeUnsub\.spend\(/g)).toHaveLength(1);
    expect(popup.match(/await allowedUnsubCount\(/g)).toHaveLength(2);
  });

  test("X-ray and Smart bulk apply still gate on the licence alone", () => {
    const popup = read("popup.js");
    const xray = popup.slice(
      popup.indexOf("const handleXrayPurge = async () => {"),
      popup.indexOf("const handleSmartScan = async () => {")
    );
    expect(xray).toContain("if (!state.subs.licenseActive)");
    expect(xray).not.toContain("allowedUnsubCount");

    // Bulk apply stays paid: PRO_FEATURES sells "bulk apply" by name,
    // which is a line a user can actually infer. One card is not bulk.
    const bulk = popup.slice(
      popup.indexOf("const handleSmartBulkApply = async () => {"),
      popup.indexOf("const handleSmartDismiss = (email) => {")
    );
    expect(bulk).toContain("if (!state.subs.licenseActive)");
    expect(bulk).not.toContain("allowedUnsubCount");
  });

  // The markup fallback now opens on the free allowance, so the cached
  // Pro hint has to paint it out or a buyer's first 200ms says they are
  // on the free tier. Paint only: 8.12 built the hint so it could never
  // become a gate, and the gate is still the real verify.
  test("the cached Pro hint repaints the sub-label without becoming a gate", () => {
    const popup = read("popup.js");
    const hint = popup.slice(
      popup.indexOf("const applyLicenseHint = async () => {"),
      popup.indexOf("const refreshLicenseUi = async () => {")
    );
    expect(hint).toContain("applyProChrome(true)");
    expect(hint).toContain("elements.unsubBtnSub");
    expect(hint).toContain('t("unsubActiveSub"');
    // Structural, not textual: a comment mentioning the flag is fine,
    // an ASSIGNMENT to it is the thing that would turn a cached hint
    // into a gate. Pinning the bare name fails on its own explanation.
    expect(hint).not.toMatch(/state\.subs\.licenseActive\s*=[^=]/);
  });
});
