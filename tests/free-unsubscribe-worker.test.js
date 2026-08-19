/**
 * @jest-environment node
 *
 * 8.19: the three free unsubscribes are spent in the service worker.
 *
 * 8.17 charged them from the popup's own progress handler, which only
 * runs while that popup is still open. A browser action popup is
 * destroyed the moment the user clicks anything outside it, and an
 * unsubscribe run opens one message per sender for up to twenty-five
 * senders, so most runs finished with nobody there: the counter was
 * never charged and the allowance came back on the next open. The engine
 * has always posted its per-sender results to the worker, and the worker
 * is the surface that survives, so that is where the spend belongs. Same
 * reasoning as storageXrayPendingPurge and smartPendingApply.
 *
 * These are behavioural: the worker is loaded for real and driven
 * through its own message router.
 */

let onMessageCb;
let storageBacking;
let failLocalKeys;

function resetStorage() {
  storageBacking = { local: {}, sync: {}, session: {} };
  failLocalKeys = new Set();
}

function makeStorageArea(area) {
  const guard = (keys) => {
    if (area !== "local") return;
    const names = typeof keys === "string" ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
    for (const k of names) {
      if (failLocalKeys.has(k)) throw new Error(`storage unavailable: ${k}`);
    }
  };
  return {
    get: jest.fn(async (keys) => {
      guard(keys);
      if (typeof keys === "string") return { [keys]: storageBacking[area][keys] ?? undefined };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = storageBacking[area][k] ?? undefined;
        return out;
      }
      return { ...storageBacking[area] };
    }),
    set: jest.fn(async (obj) => {
      guard(obj);
      Object.assign(storageBacking[area], obj);
    })
  };
}

let INTERNALS;

beforeAll(() => {
  resetStorage();
  globalThis.GCC_SW_TEST_MODE = true;
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn((cb) => { onMessageCb = cb; }) },
      onMessageExternal: { addListener: jest.fn() },
      sendMessage: jest.fn().mockRejectedValue(new Error("no listener")),
      setUninstallURL: jest.fn((_url, cb) => cb && cb()),
      getManifest: jest.fn(() => ({ version: "test" })),
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
      onAlarm: { addListener: jest.fn() }
    },
    tabs: {
      query: jest.fn(async () => []),
      get: jest.fn(async (id) => ({ id })),
      sendMessage: jest.fn(async () => ({ ok: false })),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: { executeScript: jest.fn(async () => []) },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) },
    management: { getSelf: jest.fn((cb) => cb({ installType: "normal" })) },
    i18n: { getMessage: jest.fn(() => "") },
    permissions: { contains: jest.fn((_o, cb) => cb(true)) }
  };

  const fs = require("fs");
  const path = require("path");
  new Function(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8"))();
  INTERNALS = globalThis.GCC_SW_INTERNALS;
});

afterAll(() => {
  delete globalThis.GCC_SW_TEST_MODE;
  delete globalThis.GCC_SW_INTERNALS;
});

beforeEach(() => {
  resetStorage();
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  jest.clearAllMocks();
  INTERNALS.setTestLicenseJwk(null);
});

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const dispatch = async (msg) => {
  const sendResponse = jest.fn();
  onMessageCb(msg, { id: "test-extension-id", tab: { id: 7, url: "https://mail.google.com/mail/u/0/" } }, sendResponse);
  await settle();
  return sendResponse;
};

const reportRun = (results) =>
  dispatch({ type: "gmailCleanerRecordUnsubscribes", results });

// An ephemeral P-256 keypair, signing GCC1 keys the way the real minting
// service does. Same seam the autopilot suite uses.
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

async function armValidLicense() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const raw = await crypto.subtle.exportKey("jwk", pair.publicKey);
  INTERNALS.setTestLicenseJwk({ kty: raw.kty, crv: raw.crv, x: raw.x, y: raw.y });
  const payloadPart = b64url(Buffer.from(JSON.stringify({ v: 1, plan: "pro", sid: "s", iat: 1 }), "utf8"));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(payloadPart)
  );
  storageBacking.sync.proLicense = `GCC1.${payloadPart}.${b64url(new Uint8Array(sig))}`;
}

const KEY = "freeUnsubUsed";

describe("the worker charges the free allowance", () => {
  test("a run with nobody watching still spends what it used", async () => {
    // The whole point: no popup is involved anywhere in this test.
    await reportRun([{ sender: "a@list.example", status: "unsubscribed" }]);
    expect(storageBacking.local[KEY]).toBe(1);
  });

  test("only senders that really came back unsubscribed cost anything", async () => {
    await reportRun([
      { sender: "a@list.example", status: "unsubscribed" },
      { sender: "b@list.example", status: "manual" },
      { sender: "c@list.example", status: "no_button" },
      { sender: "d@list.example", status: "not_found" },
      { sender: "e@list.example", status: "error" }
    ]);
    expect(storageBacking.local[KEY]).toBe(1);
  });

  test("a run where none succeed costs nothing and writes nothing", async () => {
    await reportRun([
      { sender: "a@list.example", status: "manual" },
      { sender: "b@list.example", status: "no_button" }
    ]);
    expect(storageBacking.local[KEY]).toBeUndefined();
  });

  test("spending accumulates across runs and stops at three", async () => {
    await reportRun([{ sender: "a@list.example", status: "unsubscribed" }]);
    expect(storageBacking.local[KEY]).toBe(1);
    await reportRun([
      { sender: "b@list.example", status: "unsubscribed" },
      { sender: "c@list.example", status: "unsubscribed" }
    ]);
    expect(storageBacking.local[KEY]).toBe(3);
    // Past the limit it saturates rather than running away.
    await reportRun([{ sender: "d@list.example", status: "unsubscribed" }]);
    expect(storageBacking.local[KEY]).toBe(3);
  });

  test("a run the user cancelled still charges the senders it really unsubscribed", async () => {
    // 8.17 exempted cancelled runs because the charge lived after the
    // loop on the happy path. Being unsubscribed cannot be undone, and
    // an exemption here is a free unsubscribe for anyone who presses
    // Stop, which is the same hole in a second form.
    await reportRun([
      { sender: "a@list.example", status: "unsubscribed" },
      { sender: "b@list.example", status: "unsubscribed" }
    ]);
    expect(storageBacking.local[KEY]).toBe(2);
  });
});

describe("what the worker refuses to charge", () => {
  test("a Pro licence has no allowance to spend", async () => {
    await armValidLicense();
    await reportRun([{ sender: "a@list.example", status: "unsubscribed" }]);
    expect(storageBacking.local[KEY]).toBeUndefined();
  });

  test("a licence state that cannot be established spends nothing", async () => {
    // readLicenseState only answers "unknown" when BOTH areas are
    // unreachable, and guessing "free" there would spend somebody's
    // allowance off a failed read.
    chrome.storage.sync.get = jest.fn(async () => { throw new Error("sync down"); });
    failLocalKeys.add("proLicense");
    await reportRun([{ sender: "a@list.example", status: "unsubscribed" }]);
    expect(storageBacking.local[KEY]).toBeUndefined();
  });

  test("a counter that cannot be read is left alone rather than written full", async () => {
    storageBacking.local[KEY] = 1;
    failLocalKeys.add(KEY);
    await reportRun([{ sender: "a@list.example", status: "unsubscribed" }]);
    // Still 1: not bumped, and emphatically not set to the limit.
    expect(storageBacking.local[KEY]).toBe(1);
  });

  test("a stored counter that is nonsense refuses rather than minting a fresh three", async () => {
    storageBacking.local[KEY] = -5;
    await reportRun([{ sender: "a@list.example", status: "unsubscribed" }]);
    expect(storageBacking.local[KEY]).toBe(3);
  });

  test("the rest of the message's work still happens when the charge is skipped", async () => {
    await armValidLicense();
    await reportRun([{ sender: "a@list.example", status: "unsubscribed" }]);
    // The lifetime counter and the sender status are not the allowance
    // and must not be gated behind it.
    expect(storageBacking.local.cleanupStats.totalUnsubscribed).toBe(1);
    expect(storageBacking.local.subscriptionScan.senders[0]).toMatchObject({
      email: "a@list.example",
      status: "unsubscribed"
    });
  });
});

describe("the worker's arithmetic matches the shared copy", () => {
  // The worker cannot load shared.js, so it carries its own. These are
  // the two functions, driven through the router, against the table
  // GCC.freeUnsub.spend defines.
  const CASES = [
    [undefined, 1, 1],
    [0, 3, 3],
    [1, 1, 2],
    [2, 5, 3],
    [3, 1, 3],
    ["2", 1, 3]
  ];
  test.each(CASES)("stored %p plus %p unsubscribed lands on %p", async (stored, ok, expected) => {
    if (stored !== undefined) storageBacking.local[KEY] = stored;
    await reportRun(
      Array.from({ length: ok }, (_, i) => ({ sender: `s${i}@list.example`, status: "unsubscribed" }))
    );
    expect(storageBacking.local[KEY]).toBe(expected);
  });
});
