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
      get: jest.fn(async (id) => ({ id })),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: {
      executeScript: jest.fn(async (details) => {
        executed.push(details);
        return [];
      })
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
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  chrome.tabs.query = jest.fn(async () => [{ id: 7, active: true, url: "https://mail.google.com/mail/u/0/" }]);
  chrome.tabs.get = jest.fn(async (id) => ({ id }));
  chrome.alarms.create.mockClear();
  chrome.alarms.clear.mockClear();
  INTERNALS.setTestLicenseJwk(null);
});

const settle = () => new Promise((r) => setTimeout(r, 60));

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

  test("the bulk rule equals GCC.smart.buildBulkRule", () => {
    const emails = ["a@x.com", "B@Y.com", "junk )", "a@x.com", "c@z.com"];
    expect(INTERNALS.autoPilotBuildRule(emails)).toBe(GCC.smart.buildBulkRule(emails));
    expect(INTERNALS.autoPilotBuildRule([])).toBe("");
    expect(INTERNALS.autoPilotBuildRule(["not-an-email"])).toBe("");
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

  test("scan done leads to a dry-run, archive-only apply while unconfirmed", async () => {
    await enableWithSuggestions({ confirmed: false });
    await fireAlarm();
    executed.length = 0;

    await dispatch({ type: "gmailCleanerProgress", runKind: "smartScan", phase: "done", done: true, scanSenders: [] });

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
    await dispatch({ type: "gmailCleanerProgress", runKind: "smartScan", phase: "done", done: true });
    const runId = storageBacking.local.autoPilotState.pending.runId;

    // The engine reports the dry-run tally in the done stats, then
    // sends gmailCleanerDone (which books dry runs as count 0).
    await dispatch({
      type: "gmailCleanerProgress", phase: "done", done: true,
      stats: { mode: "dry", runCount: 37 }
    });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 0, freedMb: 0, action: "archive", dryRun: true, runId }
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
    await dispatch({ type: "gmailCleanerProgress", runKind: "smartScan", phase: "done", done: true });

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
      summary: { count: 14, freedMb: 3, action: "archive", dryRun: false, runId }
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
    await dispatch({ type: "gmailCleanerProgress", runKind: "smartScan", phase: "done", done: true });
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
    await dispatch({ type: "gmailCleanerProgress", runKind: "smartScan", phase: "error", done: true, detail: "boom" });
    expect(storageBacking.local.autoPilotState.pending).toBeNull();
  });

  test("a failed apply injection releases the run claim and the marker", async () => {
    await enableWithSuggestions();
    await fireAlarm();
    // The engine never starts, so no gmailCleanerDone will arrive to
    // clean up; the worker must release its own claim.
    chrome.scripting.executeScript = jest.fn(async () => { throw new Error("tab gone"); });
    await dispatch({ type: "gmailCleanerProgress", runKind: "smartScan", phase: "done", done: true });
    expect(storageBacking.local.autoPilotState.pending).toBeNull();
    expect(storageBacking.local.activeRun ?? null).toBeNull();
    chrome.scripting.executeScript = jest.fn(async (details) => { executed.push(details); return []; });
  });
});
