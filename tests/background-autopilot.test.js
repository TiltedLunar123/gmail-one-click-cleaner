/**
 * @jest-environment node
 *
 * Auto-Pilot (7.12): the weekly scheduled Smart Suggestions sweep in
 * the service worker. Three concerns:
 *   1. The worker's duplicated policy pieces (license public key,
 *      recommendation ranking, the bulk rule) are pinned against the
 *      shared GCC implementations so they cannot drift.
 *   2. The settings messages gate on a verified Pro license.
 *   3. The alarm-driven stage machine: scan, then an archive-only
 *      apply that is a dry-run preview until the user confirms, with
 *      caps and guards intact and all state in storage (MV3 restarts
 *      the worker between stages).
 */

const fs = require("fs");
const path = require("path");

// ---- shared GCC (the pin reference) ----
const sharedCode = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const iifeMatch = sharedCode.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
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
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

// ---- worker under test ----
let onMessageCb;
let onAlarmCb;
let storageBacking;
let INTERNALS;
// 8.7: the worker confirms every injection by asking the engine which
// run it is, so the mock models a booting engine that answers with the
// run id it was just handed. `swallowedBy` stands in for the case the
// confirmation exists to catch: something else was already attached, so
// the injection produced no engine of ours.
let lastInjectedRunId = "";
let swallowedBy = null;

// One factory for the executeScript mock. A test that needs the attach
// probe to answer "attached" swaps in another of these rather than
// hand-rolling one: the run-id capture below is what the injection
// confirmation reads, and a hand-rolled copy that omitted it made every
// later test in the file look like a swallowed injection.
const makeExecuteScript = (attached) => jest.fn(async (details) => {
  if (details.func && !details.args && !details.files) return [{ result: attached }];
  if (details.args?.[0]?.runId) lastInjectedRunId = details.args[0].runId;
  executed.push(details);
  return [{ result: null }];
});

function resetStorage() {
  storageBacking = { local: {}, sync: {}, session: {} };
}

function makeStorageArea(area) {
  return {
    get: jest.fn(async (keys) => {
      if (typeof keys === "string") {
        return { [keys]: storageBacking[area][keys] ?? undefined };
      }
      if (Array.isArray(keys)) {
        const result = {};
        for (const k of keys) result[k] = storageBacking[area][k] ?? undefined;
        return result;
      }
      return { ...storageBacking[area] };
    }),
    set: jest.fn(async (obj) => {
      Object.assign(storageBacking[area], obj);
    })
  };
}

const executed = [];

// tabId -> url, or null to make chrome.tabs.get throw as it does for a
// closed tab. Empty means "every tab is the account the scan measured".
let tabUrls = {};

beforeAll(() => {
  resetStorage();
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn((cb) => { onMessageCb = cb; }) },
      sendMessage: jest.fn().mockRejectedValue(new Error("no listener")),
      getURL: jest.fn((p) => `chrome-extension://test/${p}`),
      lastError: null
    },
    storage: {
      local: makeStorageArea("local"),
      sync: makeStorageArea("sync"),
      session: makeStorageArea("session")
    },
    alarms: {
      create: jest.fn(),
      clear: jest.fn(async () => true),
      getAll: jest.fn(async () => []),
      onAlarm: { addListener: jest.fn((cb) => { onAlarmCb = cb; }) }
    },
    tabs: {
      query: jest.fn(async () => [{ id: 7, active: true, url: "https://mail.google.com/mail/u/0/" }]),
      // 8.11: the real chrome.tabs.get returns a url whenever the `tabs`
      // permission is held, and this returned a bare {id}. The apply
      // stage now checks that the tab it was handed is still the Gmail
      // mailbox the scan measured, so a tab with no url is a tab it
      // (correctly) refuses. tabUrls lets a test move a tab to another
      // account, which is the case the check exists for.
      get: jest.fn(async (id) => {
        if (Object.prototype.hasOwnProperty.call(tabUrls, id)) {
          if (tabUrls[id] === null) throw new Error("No tab with id: " + id);
          return { id, url: tabUrls[id] };
        }
        return { id, url: "https://mail.google.com/mail/u/0/" };
      }),
      sendMessage: jest.fn(async (_tabId, msg) => {
        if (msg?.type !== "gmailCleanerPing") return { ok: true };
        return {
          ok: true,
          phase: "running",
          version: "test",
          runId: swallowedBy !== null ? swallowedBy : lastInjectedRunId
        };
      }),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: {
      // The attach probe is the only call that passes a bare func with
      // no args and no files. It is a read, not an injection, so it
      // answers "nothing attached" and stays out of the injection log.
      executeScript: makeExecuteScript(false)
    },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) }
  };

  globalThis.GCC_SW_TEST_MODE = true;
  const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");
  new Function(code)();
  INTERNALS = globalThis.GCC_SW_INTERNALS;
});

afterAll(() => {
  delete globalThis.GCC_SW_TEST_MODE;
  delete globalThis.GCC_SW_INTERNALS;
});

beforeEach(() => {
  resetStorage();
  executed.length = 0;
  lastInjectedRunId = "";
  swallowedBy = null;
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  tabUrls = {};
  chrome.tabs.query = jest.fn(async () => [{ id: 7, active: true, url: "https://mail.google.com/mail/u/0/" }]);
  chrome.tabs.get = jest.fn(async (id) => {
    if (Object.prototype.hasOwnProperty.call(tabUrls, id)) {
      if (tabUrls[id] === null) throw new Error("No tab with id: " + id);
      return { id, url: tabUrls[id] };
    }
    return { id, url: "https://mail.google.com/mail/u/0/" };
  });
  chrome.alarms.create.mockClear();
  chrome.alarms.clear.mockClear();
  INTERNALS.setTestLicenseJwk(null);
});

// 8.9: was 60ms, which stopped being enough margin. startAutoPilotApply
// runs fire-and-forget through withStorageLock, and claimRun now waits
// 40ms mid-chain to re-read the run marker and confirm it is still ours.
// Add a licence verification (real WebCrypto) and a tab probe on either
// side of that and 60ms is most of the budget, so under parallel jest
// workers this file failed roughly one run in five, in whichever test
// read pending.runId first. The window is a production requirement, so
// the harness is what gives.
const settle = () => new Promise((r) => setTimeout(r, 200));

// 8.7: the engine echoes the run id it was given on a smartScan's
// terminal messages, and Auto-Pilot's stage machine now requires it, so
// a test that stands in for that engine has to send it too. Reading it
// back out of the pending state is exactly what the real engine does
// with the config it was injected with.
const scanDone = async (extra = {}) => dispatch({
  type: "gmailCleanerProgress",
  runKind: "smartScan",
  phase: "done",
  done: true,
  runId: storageBacking.local.autoPilotState?.pending?.runId,
  ...extra
});

const dispatch = async (msg) => {
  const sendResponse = jest.fn();
  onMessageCb(msg, { id: "test-extension-id" }, sendResponse);
  await settle();
  return sendResponse;
};

// ---- test license helpers ----
// An ephemeral P-256 keypair signs GCC1-format keys the same way the
// real service does; the worker verifies them via its test JWK seam.
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

async function makeKeypair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pair, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

async function mintTestKey(pair, payload = { v: 1, plan: "pro", sid: "abc", iat: 1 }) {
  const payloadPart = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(payloadPart)
  );
  return `GCC1.${payloadPart}.${b64url(new Uint8Array(sig))}`;
}

async function armValidLicense() {
  const { pair, jwk } = await makeKeypair();
  INTERNALS.setTestLicenseJwk(jwk);
  storageBacking.sync.proLicense = await mintTestKey(pair);
}

// ---- fixtures ----
const scanSender = (email, score, over = {}) => ({
  email,
  name: "Sender",
  score,
  signals: { count: 200, unreadRatio: 0.9, oldShare: 0.7, shape: true },
  estCount: 200,
  ...over
});

describe("license verification (duplicated, pinned against GCC.license)", () => {
  test("the embedded public JWK equals the one in shared.js", () => {
    const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");
    const shared = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
    const jwkOf = (src) => {
      const m = src.match(/kty: "EC",\s*crv: "P-256",\s*x: "([^"]+)",\s*y: "([^"]+)"/);
      return m && { x: m[1], y: m[2] };
    };
    expect(jwkOf(bg)).toEqual(jwkOf(shared));
    expect(INTERNALS.LICENSE_PUBLIC_JWK.x).toBe(jwkOf(shared).x);
    expect(INTERNALS.LICENSE_PUBLIC_JWK.y).toBe(jwkOf(shared).y);
  });

  test("worker and GCC.license agree on a valid key and on tampering", async () => {
    const { pair, jwk } = await makeKeypair();
    const key = await mintTestKey(pair);
    INTERNALS.setTestLicenseJwk(jwk);
    expect(await INTERNALS.verifyProLicenseKey(key)).toBe(true);
    expect((await GCC.license.verify(key, jwk)).valid).toBe(true);

    const tampered = key.slice(0, -4) + (key.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await INTERNALS.verifyProLicenseKey(tampered)).toBe(false);
    expect((await GCC.license.verify(tampered, jwk)).valid).toBe(false);
  });

  test("garbage and non-pro payloads are rejected", async () => {
    expect(await INTERNALS.verifyProLicenseKey("")).toBe(false);
    expect(await INTERNALS.verifyProLicenseKey("GCC1.not-a-key")).toBe(false);
    expect(await INTERNALS.verifyProLicenseKey("nope.a.b")).toBe(false);
    const { pair, jwk } = await makeKeypair();
    INTERNALS.setTestLicenseJwk(jwk);
    const basic = await mintTestKey(pair, { v: 1, plan: "basic", sid: "x", iat: 1 });
    expect(await INTERNALS.verifyProLicenseKey(basic)).toBe(false);
  });
});

describe("pin: recommendation selection matches GCC.smart", () => {
  const feedback = {
    bySender: {
      "dismissed@x.com": { action: "dismissed", at: Date.now() - 1000 },
      "boosted@shop.com": { action: "applied", at: Date.now() - 1000 }
    }
  };
  const senders = [
    scanSender("big@x.com", 90),
    scanSender("dismissed@x.com", 95),
    scanSender("wl@corp.com", 85),
    scanSender("tax@x.com", 80, { name: "Tax notices" }),
    scanSender("deals@shop.com", 40),
    scanSender("mid@x.com", 60)
  ];
  const config = { whitelist: ["*@corp.com"], protectKeywords: ["tax"] };

  test("same survivors in the same order as GCC.smart.recommend", () => {
    const expected = GCC.smart
      .recommend(senders, feedback, config)
      .slice(0, 25)
      .map((s) => s.email);
    const got = INTERNALS.autoPilotPickSenders(
      senders, feedback, config.whitelist, config.protectKeywords
    );
    expect(got).toEqual(expected);
    expect(got).not.toContain("dismissed@x.com");
    expect(got).not.toContain("wl@corp.com");
    expect(got).not.toContain("tax@x.com");
  });

  test("caps at 25 senders per sweep", () => {
    const many = Array.from({ length: 40 }, (_, i) => scanSender(`s${i}@bulk.com`, 50 + (i % 30)));
    expect(INTERNALS.autoPilotPickSenders(many, {}, [], []).length).toBe(25);
  });
});

// 8.10: every assertion below fails against the 8.9.1 source.
//
// The sweep applies ONE rule shape, `from:(...) older_than:6m` with
// archive forced on, to every sender it takes. The scan has picked a
// per-sender action since 8.6 and measured THAT action's guarded query,
// and recordSmartScan stores the action beside the count it belongs to.
// The sweep read the count and ignored the action, so a card measured
// through `larger:5M` handed Auto-Pilot every message that sender had
// sent in six months.
describe("8.10: the sweep only takes senders its own rule can honour", () => {
  const withAction = (email, action, over = {}) =>
    scanSender(email, 80, { action, reachable: 40, ...over });

  test("purgeLarge is deferred: its count was measured through larger:5M", () => {
    const picked = INTERNALS.autoPilotPickSenders(
      [withAction("big@shop.com", "purgeLarge")], {}, [], []
    );
    expect(picked).toEqual([]);
    // The rule the sweep would have built is not the one the card sold.
    expect(GCC.smart.buildActionRule({ email: "big@shop.com" }, "purgeLarge").query)
      .toContain("larger:5M");
    expect(INTERNALS.autoPilotBuildRules(["big@shop.com"])[0])
      .not.toContain("larger:5M");
  });

  test("unsubscribe is deferred: it moves no mail and carries no reachable", () => {
    // Deliberately no `reachable`, which is how the engine reports an
    // unsubscribe card. The 8.6 held-back filter reads a MISSING
    // reachable as "not measured" and lets it through, so the action
    // check is the only thing standing between an Unsubscribe card and
    // six months of that sender's mail being archived.
    const sender = scanSender("flood@list.com", 95, { action: "unsubscribe" });
    expect(sender.reachable).toBeUndefined();
    expect(INTERNALS.autoPilotPickSenders([sender], {}, [], [])).toEqual([]);
  });

  test("deleteOld and archiveAll are swept: the rule matches or narrows", () => {
    const picked = INTERNALS.autoPilotPickSenders(
      [withAction("old@x.com", "deleteOld"), withAction("all@y.com", "archiveAll")],
      {}, [], []
    );
    expect(picked).toEqual(["old@x.com", "all@y.com"]);
  });

  test("an entry with no action predates 8.6 and keeps the old behaviour", () => {
    const legacy = scanSender("legacy@x.com", 70);
    expect(legacy.action).toBeUndefined();
    expect(INTERNALS.autoPilotPickSenders([legacy], {}, [], [])).toEqual(["legacy@x.com"]);
  });

  test("deferred senders are counted, not silently dropped", () => {
    const senders = [
      withAction("old@x.com", "deleteOld"),
      withAction("big@shop.com", "purgeLarge"),
      scanSender("flood@list.com", 95, { action: "unsubscribe" })
    ];
    expect(INTERNALS.autoPilotPickSenders(senders, {}, [], [])).toEqual(["old@x.com"]);
    expect(INTERNALS.autoPilotDeferredCount(senders, {}, [], [])).toBe(2);
  });

  test("a sender vetoed for safety is not counted as deferred", () => {
    // Whitelisted, dismissed and guard-emptied senders were never
    // candidates. Reporting them as "waiting for you" would send the
    // user looking for suggestions that are not there.
    const senders = [
      withAction("wl@corp.com", "purgeLarge"),
      withAction("empty@x.com", "purgeLarge", { reachable: 0 })
    ];
    expect(INTERNALS.autoPilotDeferredCount(senders, {}, ["*@corp.com"], [])).toBe(0);
  });

  // 8.8: both sides return a LIST now. One from:() group could not hold
  // twenty-five realistic addresses inside the 512-character ceiling,
  // and Auto-Pilot is the copy nobody watches run.
  test("the bulk rules equal GCC.smart.buildBulkRules", () => {
    const emails = ["a@x.com", "B@Y.com", "junk )", "a@x.com", "c@z.com"];
    expect(INTERNALS.autoPilotBuildRules(emails)).toEqual(GCC.smart.buildBulkRules(emails));
    expect(INTERNALS.autoPilotBuildRules([])).toEqual([]);
    expect(INTERNALS.autoPilotBuildRules(["not-an-email"])).toEqual([]);
  });

  test("a full sweep stays inside the query ceiling the shared copy enforces", () => {
    const long = Array.from({ length: 25 }, (_, i) =>
      `no-reply.marketing.department-${String(i).padStart(2, "0")}@news.long-company-domain-example.com`);
    const rules = INTERNALS.autoPilotBuildRules(long);
    expect(rules.length).toBeGreaterThan(1);
    for (const rule of rules) expect(rule.length).toBeLessThanOrEqual(GCC.MAX_QUERY_CHARS);
    // Nobody is dropped on the way: the sweep still covers all 25.
    const packed = rules.join(" ");
    for (const email of long) expect(packed).toContain(email);
    expect(INTERNALS.autoPilotBuildRules(long)).toEqual(GCC.smart.buildBulkRules(long));
  });
});

describe("settings messages", () => {
  test("get returns defaults when nothing is stored", async () => {
    const resp = await dispatch({ type: "gmailCleanerGetAutoPilot" });
    expect(resp).toHaveBeenCalledWith({
      ok: true,
      autoPilot: { enabled: false, confirmed: false, lastRun: null, preview: null, pendingStage: null }
    });
  });

  test("enabling without a valid license is refused", async () => {
    storageBacking.sync.proLicense = "GCC1.bogus.bogus";
    const resp = await dispatch({ type: "gmailCleanerSetAutoPilot", enabled: true });
    expect(resp.mock.calls[0][0]).toMatchObject({ ok: false, error: "pro_required" });
    expect(storageBacking.sync.autoPilot).toBeUndefined();
  });

  test("enabling with a valid license stores the setting and arms the alarm", async () => {
    await armValidLicense();
    const resp = await dispatch({ type: "gmailCleanerSetAutoPilot", enabled: true });
    expect(resp.mock.calls[0][0]).toMatchObject({ ok: true });
    expect(storageBacking.sync.autoPilot).toMatchObject({ enabled: true, confirmed: false });
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      "gcc_autopilot",
      expect.objectContaining({ periodInMinutes: 10080 })
    );
  });

  test("disabling keeps confirmed but clears the alarm and any pending sweep", async () => {
    await armValidLicense();
    storageBacking.sync.autoPilot = { enabled: true, confirmed: true, lastRunAt: 5 };
    storageBacking.local.autoPilotState = { pending: { stage: "scan", startedAt: Date.now() } };
    await dispatch({ type: "gmailCleanerSetAutoPilot", enabled: false });
    expect(storageBacking.sync.autoPilot).toMatchObject({ enabled: false, confirmed: true });
    expect(storageBacking.local.autoPilotState.pending).toBeNull();
    expect(chrome.alarms.clear).toHaveBeenCalledWith("gcc_autopilot");
  });

  test("confirm flips confirmed and clears the stored preview", async () => {
    await armValidLicense();
    storageBacking.sync.autoPilot = { enabled: true, confirmed: false, lastRunAt: 0 };
    storageBacking.local.autoPilotState = { preview: { count: 12, at: 1 } };
    const resp = await dispatch({ type: "gmailCleanerConfirmAutoPilot" });
    expect(resp.mock.calls[0][0]).toMatchObject({ ok: true });
    expect(storageBacking.sync.autoPilot.confirmed).toBe(true);
    expect(storageBacking.local.autoPilotState.preview).toBeNull();
  });
});

describe("the sweep stage machine", () => {
  const enableWithSuggestions = async ({ confirmed = false } = {}) => {
    await armValidLicense();
    storageBacking.sync.autoPilot = { enabled: true, confirmed, lastRunAt: 0 };
    storageBacking.local.smartScan = {
      updatedAt: 1,
      senders: [scanSender("news@shop.com", 90), scanSender("deals@mall.com", 70)]
    };
  };

  const fireAlarm = async () => {
    await onAlarmCb({ name: "gcc_autopilot" });
    await settle();
  };

  test("the alarm starts a read-only smart scan and stores the pending marker", async () => {
    await enableWithSuggestions();
    await fireAlarm();
    // Two executeScript calls: config injection + content script.
    expect(executed.length).toBe(2);
    const cfg = executed[0].args[0];
    expect(cfg.runKind).toBe("smartScan");
    expect(executed[1].files).toEqual(["contentScript.js"]);
    expect(storageBacking.local.autoPilotState.pending).toMatchObject({ stage: "scan" });
  });

  // 8.11. The scan's numbers are not private to Auto-Pilot: recordSmartScan
  // writes them into the same smartScan store the popup's suggestion cards
  // read, and overwrites whatever the user's own scan measured. So the scan
  // has to measure through the guards the popup's BUTTONS apply, which is
  // what 8.6 taught the popup's own scan and never taught this one. A user
  // who turned Skip Unread off got "Deletes 200 now" on a card measured with
  // `-is:unread` still attached, and a button that reached the unread mail
  // too.
  test("the scan measures through the user's switches, not the engine defaults", async () => {
    await enableWithSuggestions();
    storageBacking.local.lastUiSnapshot = {
      safeMode: true,
      minAge: "1y",
      guardSkipStarred: true,
      guardSkipImportant: false,
      guardSkipUnread: false,
      guardSkipUserLabels: true
    };
    await fireAlarm();

    const cfg = executed[0].args[0];
    expect(cfg.runKind).toBe("smartScan");
    expect(cfg.guardSkipUnread).toBe(false);
    expect(cfg.guardSkipImportant).toBe(false);
    expect(cfg.guardSkipStarred).toBe(true);
    expect(cfg.guardSkipUserLabels).toBe(true);
    expect(cfg.safeMode).toBe(true);
    expect(cfg.minAge).toBe("1y");
  });

  test("no stored snapshot still means every guard on", async () => {
    // sanitizeConfig reads a missing guard as ON, so the fix must not be
    // able to turn one OFF for someone who has never opened the popup.
    // Boolean() on an absent key would have done exactly that.
    await enableWithSuggestions();
    delete storageBacking.local.lastUiSnapshot;
    await fireAlarm();

    const cfg = executed[0].args[0];
    expect(cfg.guardSkipStarred).toBe(true);
    expect(cfg.guardSkipImportant).toBe(true);
    expect(cfg.guardSkipUnread).toBe(true);
    expect(cfg.guardSkipUserLabels).toBe(true);
    expect(cfg.minAge).toBeNull();
  });

  test("the sweep's own apply stays maximally conservative regardless", async () => {
    // The scan above may now measure a WIDER set than the sweep will act
    // on. That direction is safe and deliberate: the apply keeps its
    // hardcoded guards, so it can only ever take less than was counted.
    await enableWithSuggestions({ confirmed: true });
    storageBacking.local.lastUiSnapshot = {
      guardSkipStarred: false,
      guardSkipImportant: false,
      guardSkipUnread: false,
      guardSkipUserLabels: false
    };
    await fireAlarm();
    // Drop the scan's two executeScript calls so the next pair is the
    // apply's, the way the sibling tests below read it.
    executed.length = 0;
    await scanDone();

    const applyCfg = executed[0].args[0];
    expect(applyCfg.guardSkipStarred).toBe(true);
    expect(applyCfg.guardSkipImportant).toBe(true);
    expect(applyCfg.guardSkipUnread).toBe(true);
    expect(applyCfg.guardSkipUserLabels).toBe(true);
    expect(applyCfg.safeMode).toBe(true);
    expect(applyCfg.archiveInsteadOfDelete).toBe(true);
  });

  test("an engine already attached to the tab skips the whole sweep", async () => {
    // Scans and restores attach without claiming ACTIVE_RUN, so the
    // marker check cannot see them. Injecting anyway would be swallowed
    // by the content script's duplicate guard and leave the sweep
    // pending, with the apply stage's claim stranded for its full TTL.
    await enableWithSuggestions();
    chrome.scripting.executeScript = makeExecuteScript(true);

    await fireAlarm();

    expect(executed.length).toBe(0);
    expect(storageBacking.local.autoPilotState?.pending ?? null).toBeNull();

    chrome.scripting.executeScript = makeExecuteScript(false);
  });

  test("scan done leads to a dry-run, archive-only apply while unconfirmed", async () => {
    await enableWithSuggestions({ confirmed: false });
    await fireAlarm();
    executed.length = 0;

    await scanDone({ scanSenders: [] });

    expect(executed.length).toBe(2);
    const cfg = executed[0].args[0];
    expect(cfg.dryRun).toBe(true);
    expect(cfg.archiveInsteadOfDelete).toBe(true);
    expect(cfg.scheduled).toBe(true);
    expect(cfg.tagBeforeDelete).toBe(true);
    expect(cfg.rulesOverride).toHaveLength(1);
    expect(cfg.rulesOverride[0]).toContain("from:(");
    expect(cfg.rulesOverride[0]).toContain("news@shop.com");
    expect(cfg.rulesOverride[0]).toContain("older_than:6m");
    expect(storageBacking.local.autoPilotState.pending).toMatchObject({ stage: "apply", dryRun: true });
    // Dry runs never register the applied-feedback marker.
    expect(storageBacking.local.smartPendingApply).toBeUndefined();
    // The claim blocks a popup run starting mid-sweep.
    expect(storageBacking.local.activeRun).toMatchObject({ source: "autopilot" });
  });

  test("the preview's would-have count lands in state and waits for the confirm", async () => {
    await enableWithSuggestions({ confirmed: false });
    await fireAlarm();
    await scanDone();
    const runId = storageBacking.local.autoPilotState.pending.runId;

    // The engine reports the dry-run tally in the done stats, then
    // sends gmailCleanerDone (which books dry runs as count 0).
    await dispatch({
      type: "gmailCleanerProgress", phase: "done", done: true,
      stats: { mode: "dry", runCount: 37 }
    });
    await dispatch({
      type: "gmailCleanerDone",
      // 8.16: `outcome: "completed"` is part of every done summary the engine
      // sends now, and the resolvers below refuse to stamp a "you have finished
      // this" mark on a summary that cannot prove the run finished. Cancelled,
      // errored and stopped-short runs are covered in tests/sweep-8-16.test.js.
      summary: { count: 0, freedMb: 0, action: "archive", dryRun: true, runId, outcome: "completed" }
    });

    const state = storageBacking.local.autoPilotState;
    expect(state.pending).toBeNull();
    expect(state.preview).toMatchObject({ count: 37 });
    expect(state.lastRun).toMatchObject({ count: 37, dryRun: true });
    expect(storageBacking.sync.autoPilot.lastRunAt).toBeGreaterThan(0);
  });

  test("a confirmed sweep runs live and registers the pending-apply marker", async () => {
    await enableWithSuggestions({ confirmed: true });
    await fireAlarm();
    executed.length = 0;
    await scanDone();

    const cfg = executed[0].args[0];
    expect(cfg.dryRun).toBe(false);
    expect(cfg.archiveInsteadOfDelete).toBe(true);
    expect(storageBacking.local.smartPendingApply).toMatchObject({
      senders: expect.arrayContaining(["news@shop.com", "deals@mall.com"])
    });

    const runId = storageBacking.local.autoPilotState.pending.runId;
    await dispatch({
      type: "gmailCleanerProgress", phase: "done", done: true,
      stats: { mode: "live", runCount: 14 }
    });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 14, freedMb: 3, action: "archive", dryRun: false, runId, outcome: "completed" }
    });

    const state = storageBacking.local.autoPilotState;
    expect(state.pending).toBeNull();
    expect(state.preview).toBeNull();
    expect(state.lastRun).toMatchObject({ count: 14, dryRun: false });
    // The live apply also fed the smart feedback loop via the marker.
    expect(storageBacking.local.smartFeedback.bySender["news@shop.com"].action).toBe("applied");
  });

  test("a sweep with nothing eligible records a zero run and stops", async () => {
    await armValidLicense();
    storageBacking.sync.autoPilot = { enabled: true, confirmed: true, lastRunAt: 0 };
    storageBacking.local.smartScan = { updatedAt: 1, senders: [] };
    await fireAlarm();
    executed.length = 0;
    await scanDone();
    expect(executed.length).toBe(0);
    expect(storageBacking.local.autoPilotState.lastRun).toMatchObject({ count: 0 });
    expect(storageBacking.local.autoPilotState.pending).toBeNull();
  });

  test("no sweep without a valid license, under snooze, or during another run", async () => {
    await enableWithSuggestions();
    INTERNALS.setTestLicenseJwk(null); // stored key no longer verifies
    await fireAlarm();
    expect(executed.length).toBe(0);

    await enableWithSuggestions();
    storageBacking.local.snoozeUntil = Date.now() + 60_000;
    await fireAlarm();
    expect(executed.length).toBe(0);
    delete storageBacking.local.snoozeUntil;

    await enableWithSuggestions();
    storageBacking.local.activeRun = { gmailTabId: 3, runId: "manual", startedAt: Date.now() };
    await fireAlarm();
    expect(executed.length).toBe(0);
  });

  test("no Gmail tab means the sweep skips cleanly", async () => {
    await enableWithSuggestions();
    chrome.tabs.query = jest.fn(async () => []);
    await fireAlarm();
    expect(executed.length).toBe(0);
    expect(storageBacking.local.autoPilotState?.pending ?? null).toBeNull();
  });

  test("a failed scan clears the pending marker", async () => {
    await enableWithSuggestions();
    await fireAlarm();
    // The engine stamps its run id on the error branch too, and the
    // stage machine requires it: an error from a scan the user started
    // must not clear a pending sweep that is still out there.
    await scanDone({ phase: "error", detail: "boom" });
    expect(storageBacking.local.autoPilotState.pending).toBeNull();
  });

  test("a failed apply injection releases the run claim and the marker", async () => {
    await enableWithSuggestions();
    await fireAlarm();
    // The engine never starts, so no gmailCleanerDone will arrive to
    // clean up; the worker must release its own claim. The attach probe
    // still answers truthfully, otherwise the apply would bail at that
    // guard instead of reaching the claim it needs to release.
    chrome.scripting.executeScript = jest.fn(async (details) => {
      if (details.func && !details.args && !details.files) return [{ result: false }];
      throw new Error("tab gone");
    });
    await scanDone();
    expect(storageBacking.local.autoPilotState.pending).toBeNull();
    expect(storageBacking.local.activeRun ?? null).toBeNull();
    chrome.scripting.executeScript = makeExecuteScript(false);
  });
});
