/**
 * 9.4, the unsubscribe receipts ledger. Two facts that were carried the
 * wrong way round.
 *
 * The `guards` snapshot exists so the popup can stop printing a
 * `clearable` figure once the safety switches move: the number was
 * measured through one set of switches and means nothing against
 * another. writeReceiptList's comment said an undefined argument leaves
 * whatever was stored, so a write that is not a verification cannot
 * erase it. storage.local.set replaces the value under a key rather than
 * merging into it, so leaving the property off deleted the snapshot on
 * every unsubscribe run and every Clear, and the protection was off.
 *
 * The mirror image sat twenty lines away. recordVerifyResults spreads
 * `...prev` and then conditionally sets `clearable`, so on a RE-check
 * whose reach search failed the previous run's number survived and got
 * today's checkedAt stamped on it. Its comment says "absent rather than
 * zeroed when the reach search did not answer", and absent has to be
 * written, not merely not-set.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BG_SRC = fs.readFileSync(path.join(ROOT, "background.js"), "utf-8");

let storageBacking;
let listeners;
let INTERNALS;

const makeStorageArea = (name) => ({
  get: async (keys) => {
    const store = storageBacking[name];
    const out = {};
    const list = keys === null || keys === undefined
      ? Object.keys(store)
      : (Array.isArray(keys) ? keys : [keys]);
    for (const k of list) if (k in store) out[k] = store[k];
    return out;
  },
  // Object.assign is the real semantics: set REPLACES a key's value.
  // That is the whole bug, so the stub must not be kinder than Chrome.
  set: async (obj) => { Object.assign(storageBacking[name], obj); },
  remove: async (keys) => {
    for (const k of (Array.isArray(keys) ? keys : [keys])) delete storageBacking[name][k];
  }
});

const RECEIPTS_KEY = "unsubReceipts";

beforeAll(() => {
  storageBacking = { local: {}, sync: {}, session: {} };
  listeners = [];
  globalThis.chrome = {
    runtime: {
      id: "test",
      lastError: null,
      getManifest: () => ({ version: "9.4.0" }),
      getURL: (p) => `chrome-extension://test/${p}`,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onMessageExternal: { addListener: () => {} },
      onSuspend: { addListener: () => {} },
      sendMessage: async () => ({ ok: true })
    },
    storage: {
      local: makeStorageArea("local"),
      sync: makeStorageArea("sync"),
      session: makeStorageArea("session"),
      onChanged: { addListener: () => {} }
    },
    alarms: {
      create: () => {}, clear: async () => true, getAll: async () => [],
      onAlarm: { addListener: () => {} }
    },
    tabs: {
      query: async () => [], get: async (id) => ({ id, url: "https://mail.google.com/mail/u/0/" }),
      sendMessage: async () => ({ ok: true }),
      onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} }
    },
    scripting: { executeScript: async () => [{ result: null }] },
    notifications: { create: (id, opts, cb) => { if (cb) cb(); } },
    i18n: { getMessage: () => "" },
    management: { getSelf: async () => ({ installType: "normal" }) },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} }
  };
  globalThis.GCC_SW_TEST_MODE = true;
  // eslint-disable-next-line no-new-func
  new Function(BG_SRC)();
  INTERNALS = globalThis.GCC_SW_INTERNALS;
  expect(INTERNALS).toBeTruthy();
});

afterAll(() => {
  delete globalThis.GCC_SW_TEST_MODE;
  delete globalThis.GCC_SW_INTERNALS;
});

beforeEach(() => {
  storageBacking = { local: {}, sync: {}, session: {} };
});

const send = (msg) => new Promise((resolve) => {
  let answered = false;
  const respond = (r) => { answered = true; resolve(r); };
  for (const fn of listeners) fn(msg, { id: "test" }, respond);
  setTimeout(() => { if (!answered) resolve(undefined); }, 250);
});

const GUARDS = Object.freeze({
  safeMode: true,
  minAge: "6m",
  guardSkipStarred: true,
  guardSkipImportant: true,
  guardSkipUnread: true,
  guardSkipUserLabels: false
});

const seedLedger = (list, guards) => {
  storageBacking.local[RECEIPTS_KEY] = {
    updatedAt: Date.now() - 1000,
    list,
    ...(guards === undefined ? {} : { guards })
  };
};

const readLedger = () => storageBacking.local[RECEIPTS_KEY];

describe("the guards snapshot survives a write that is not a verification", () => {
  test("a Clear over some senders leaves the snapshot in place", async () => {
    seedLedger(
      [{ email: "a@x.com", at: 3, checkedAt: 2, verdict: "still", clearable: 40 }],
      GUARDS
    );
    const before = readLedger().guards;
    expect(before).toEqual(GUARDS);

    await send({ type: "gmailCleanerReceiptsCleared", senders: ["a@x.com"] });

    const after = readLedger();
    expect(after.list[0].clearedAt).toBeGreaterThan(0);
    // The write happened, and the snapshot is still there.
    expect(after.guards).toEqual(GUARDS);
  });

  test("a verification that sends no guards does not erase the stored ones", async () => {
    seedLedger([{ email: "a@x.com", at: 3, checkedAt: 2, verdict: "" }], GUARDS);

    await send({
      type: "gmailCleanerRecordVerifyResults",
      results: [{ sender: "a@x.com", verdict: "still_sending", since: 5, clearable: 12 }]
    });

    expect(readLedger().guards).toEqual(GUARDS);
  });

  test("a verification that DOES send guards replaces them", async () => {
    seedLedger([{ email: "a@x.com", at: 3, checkedAt: 2, verdict: "" }], GUARDS);
    const fresh = { ...GUARDS, safeMode: false, minAge: "1y" };

    await send({
      type: "gmailCleanerRecordVerifyResults",
      results: [{ sender: "a@x.com", verdict: "still_sending", since: 5, clearable: 12 }],
      guards: fresh
    });

    expect(readLedger().guards.safeMode).toBe(false);
    expect(readLedger().guards.minAge).toBe("1y");
  });

  test("an empty ledger still writes no snapshot rather than inventing one", async () => {
    seedLedger([{ email: "a@x.com", at: 3, checkedAt: 2, verdict: "" }], undefined);

    await send({
      type: "gmailCleanerRecordVerifyResults",
      results: [{ sender: "a@x.com", verdict: "still_sending", since: 5, clearable: 12 }]
    });

    expect(readLedger().guards).toBeUndefined();
  });
});

describe("a recheck that could not measure does not keep the old number", () => {
  test("a failed reach search drops clearable rather than inheriting it", async () => {
    seedLedger(
      [{
        email: "a@x.com", at: 3, checkedAt: 100, verdict: "still",
        clearable: 431, clearableExact: true
      }],
      GUARDS
    );

    // The engine answers with a verdict but no clearable: the guarded
    // reach search is the half that failed.
    await send({
      type: "gmailCleanerRecordVerifyResults",
      results: [{ sender: "a@x.com", verdict: "still_sending", since: 9 }]
    });

    const row = readLedger().list.find((r) => r.email === "a@x.com");
    expect(row.checkedAt).toBeGreaterThan(100);
    expect(row.since).toBe(9);
    expect("clearable" in row).toBe(false);
    expect("clearableExact" in row).toBe(false);
  });

  test("a recheck that DOES measure overwrites the old number", async () => {
    seedLedger(
      [{ email: "a@x.com", at: 3, checkedAt: 100, verdict: "still", clearable: 431 }],
      GUARDS
    );

    await send({
      type: "gmailCleanerRecordVerifyResults",
      results: [{ sender: "a@x.com", verdict: "still_sending", since: 9, clearable: 12, clearableExact: true }]
    });

    const row = readLedger().list.find((r) => r.email === "a@x.com");
    expect(row.clearable).toBe(12);
    expect(row.clearableExact).toBe(true);
  });
});
