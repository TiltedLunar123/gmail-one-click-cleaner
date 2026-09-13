/**
 * @jest-environment node
 *
 * 9.7: a recovery log entry did not know which mailbox it came from.
 *
 * Every run since 9.2 has been careful about WHICH signed-in account it
 * acts on: the report is stamped with one, the launcher refuses a
 * report from another, the popup's Open Trash lands in the account the
 * run used. The recovery log, which exists so a run can be undone, never
 * recorded it. So the Stats page's Restore took "whichever Gmail tab is
 * active", searched account 0 for a label that lives in account 1, and
 * reported "Nothing left to restore" about mail that was sitting in the
 * other mailbox's Trash the whole time.
 *
 * The worker already reads the account off the sending tab for the
 * report (recordReportScan), never off the payload, so the engine cannot
 * claim one. The undo router now does the same. Only the account INDEX
 * is kept, which tells two open mailboxes apart and is not an address.
 */
const fs = require("fs");
const path = require("path");

const WORKER = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");

let onMessageCb;
let storageBacking;

function resetStorage() {
  storageBacking = { local: {}, sync: {}, session: {} };
}

function makeStorageArea(area) {
  return {
    get: jest.fn(async (keys) => {
      const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
      if (typeof keys === "string") return { [keys]: clone(storageBacking[area][keys]) };
      if (Array.isArray(keys)) {
        const result = {};
        for (const k of keys) result[k] = clone(storageBacking[area][k]);
        return result;
      }
      return clone({ ...storageBacking[area] });
    }),
    set: jest.fn(async (obj) => { Object.assign(storageBacking[area], JSON.parse(JSON.stringify(obj))); }),
    remove: jest.fn(async (key) => { delete storageBacking[area][key]; })
  };
}

beforeAll(() => {
  resetStorage();
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn((cb) => { onMessageCb = cb; }) },
      sendMessage: jest.fn(async () => undefined),
      setUninstallURL: jest.fn(),
      getURL: jest.fn((p) => `chrome-extension://test/${p}`),
      lastError: null
    },
    storage: {
      local: makeStorageArea("local"),
      sync: makeStorageArea("sync"),
      session: makeStorageArea("session")
    },
    alarms: {
      create: jest.fn(), clear: jest.fn(async () => true),
      getAll: jest.fn(async () => []), onAlarm: { addListener: jest.fn() }
    },
    tabs: { query: jest.fn(async () => []), get: jest.fn(async (id) => ({ id })), onRemoved: { addListener: jest.fn() } },
    scripting: { executeScript: jest.fn(async () => []) },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) },
    management: { getSelf: jest.fn((cb) => cb({ installType: "normal" })) }
  };
  new Function(WORKER)();
});

beforeEach(() => {
  resetStorage();
  chrome.storage.local = makeStorageArea("local");
  jest.clearAllMocks();
});

const recordUndo = async (data, tab) => {
  const sendResponse = jest.fn();
  onMessageCb(
    { type: "gmailCleanerRecordUndo", data },
    { id: "test-extension-id", tab },
    sendResponse
  );
  await new Promise((r) => setTimeout(r, 40));
  return storageBacking.local.undoLog || [];
};

const PASS = (extra = {}) => ({
  runId: "run-1",
  query: "category:promotions older_than:6m",
  label: "Promotions",
  count: 50,
  action: "delete",
  tagLabel: "GmailCleaner - Promotions",
  taggingFailed: false,
  ...extra
});

describe("the account is read off the sending tab", () => {
  test("a run in the second signed-in mailbox records account 1", async () => {
    const log = await recordUndo(PASS(), { id: 7, url: "https://mail.google.com/mail/u/1/#search/x" });
    expect(log).toHaveLength(1);
    expect(log[0].account).toBe("1");
  });

  test("the default mailbox records account 0, absent segment included", async () => {
    const log = await recordUndo(PASS(), { id: 7, url: "https://mail.google.com/mail/#inbox" });
    expect(log[0].account).toBe("0");
  });

  test("a tab that is not a mailbox records no account rather than a guess", async () => {
    // The engine refuses to run there, so this is belt and braces, but
    // an empty string is the shape every reader treats as "unknown".
    const log = await recordUndo(PASS(), { id: 7, url: "https://mail.google.com/chat/u/0/#chat/home" });
    expect(log[0].account).toBe("");
  });

  test("the payload cannot claim an account of its own", async () => {
    const log = await recordUndo(PASS({ account: "3" }), { id: 7, url: "https://mail.google.com/mail/u/1/" });
    expect(log[0].account).toBe("1");
  });

  test("a later pass of the same rule in the same run keeps the account the run started with", async () => {
    await recordUndo(PASS(), { id: 7, url: "https://mail.google.com/mail/u/2/" });
    const log = await recordUndo(PASS({ count: 30 }), { id: 7, url: "https://mail.google.com/mail/u/2/" });
    expect(log).toHaveLength(1);
    expect(log[0].count).toBe(80);
    expect(log[0].account).toBe("2");
  });

  test("an entry written before this release has no account and is not invented one", async () => {
    storageBacking.local.undoLog = [{
      id: "old", runId: "run-old", label: "Social", tagLabel: "GmailCleaner - Social",
      action: "delete", count: 5, timestamp: Date.now()
    }];
    const log = await recordUndo(PASS(), { id: 7, url: "https://mail.google.com/mail/u/1/" });
    const old = log.find((e) => e.id === "old");
    expect(old).toBeDefined();
    expect(old).not.toHaveProperty("account");
  });
});
