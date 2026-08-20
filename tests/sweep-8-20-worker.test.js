/**
 * @jest-environment node
 *
 * 8.20: two worker writes that could fail and still answer "done".
 *
 * saveSchedule has rethrown since Issue #10, and its router turns that
 * into { ok: false } for the Options page to show. Its two neighbours
 * never learned:
 *
 *   - deleteSchedule swallowed its own failure AND its router had no
 *     catch at all, so a delete that did not happen answered { ok: true }
 *     and the Options page toasted "Schedule removed" over a schedule
 *     still in sync storage with its alarm still armed. The next
 *     unattended cleanup then ran on a schedule the user had watched
 *     themselves delete. The error branch was already written on the
 *     Options side and nothing could reach it.
 *
 *   - clearUndoLog swallowed too, and the Stats page toasted "Log
 *     cleared" without reading the reply. That log is the record of what
 *     was deleted and how to get it back.
 *
 * Behavioural: the worker is loaded for real and driven through its own
 * message router, with the storage area made to fail for one key.
 */

let onMessageCb;
let storageBacking;
let failKeys;

function resetStorage() {
  storageBacking = { local: {}, sync: {}, session: {} };
  failKeys = new Set();
}

function makeStorageArea(area) {
  const guard = (keys) => {
    const names = typeof keys === "string"
      ? [keys]
      : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
    for (const k of names) {
      if (failKeys.has(`${area}:${k}`)) throw new Error(`storage unavailable: ${k}`);
    }
  };
  return {
    get: jest.fn(async (keys) => {
      if (typeof keys === "string") return { [keys]: storageBacking[area][keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = storageBacking[area][k];
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

let clearedAlarms;

beforeAll(() => {
  resetStorage();
  clearedAlarms = [];
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
      clear: jest.fn(async (name) => { clearedAlarms.push(name); return true; }),
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
  // eslint-disable-next-line no-new-func
  new Function(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8"))();
});

afterAll(() => {
  delete globalThis.GCC_SW_TEST_MODE;
  delete globalThis.GCC_SW_INTERNALS;
  delete global.chrome;
});

beforeEach(() => {
  resetStorage();
  clearedAlarms.length = 0;
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  jest.clearAllMocks();
});

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const dispatch = async (msg) => {
  const sendResponse = jest.fn();
  onMessageCb(msg, { id: "test-extension-id" }, sendResponse);
  await settle();
  return sendResponse;
};

const SCHEDULE = {
  id: "sched_1",
  name: "Weekly tidy",
  enabled: true,
  intensity: "normal",
  hour: 3,
  days: [1]
};

describe("a delete that did not happen does not answer ok", () => {
  test("a sync write failure is reported, not swallowed", async () => {
    storageBacking.sync.schedules = [SCHEDULE];
    failKeys.add("sync:schedules");

    const reply = await dispatch({ type: "gmailCleanerDeleteSchedule", scheduleId: "sched_1" });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toMatchObject({ ok: false });
    expect(reply.mock.calls[0][0].error).toBeTruthy();
    // And the schedule really is still there, which is the thing the
    // "Schedule removed" toast was denying.
    expect(storageBacking.sync.schedules).toHaveLength(1);
  });

  test("a delete that works still answers ok and clears the alarm", async () => {
    storageBacking.sync.schedules = [SCHEDULE];

    const reply = await dispatch({ type: "gmailCleanerDeleteSchedule", scheduleId: "sched_1" });

    expect(reply.mock.calls[0][0]).toMatchObject({ ok: true });
    expect(storageBacking.sync.schedules).toEqual([]);
    expect(clearedAlarms.some((n) => String(n).includes("sched_1"))).toBe(true);
  });
});

describe("a recovery log that did not clear does not answer ok", () => {
  const ENTRIES = [{ runId: "r1", label: "Promotions", tagLabel: "GmailCleaner - Promotions" }];

  test("a local write failure is reported, not swallowed", async () => {
    storageBacking.local.undoLog = ENTRIES;
    failKeys.add("local:undoLog");

    const reply = await dispatch({ type: "gmailCleanerClearUndoLog" });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toMatchObject({ ok: false });
    // The entries the user was told had gone.
    expect(storageBacking.local.undoLog).toHaveLength(1);
  });

  test("a clear that works answers ok and empties the log", async () => {
    storageBacking.local.undoLog = ENTRIES;

    const reply = await dispatch({ type: "gmailCleanerClearUndoLog" });

    expect(reply.mock.calls[0][0]).toMatchObject({ ok: true });
    expect(storageBacking.local.undoLog).toEqual([]);
  });
});

// =====================================================================
// The completion notification only goes to people who asked for it
// =====================================================================
//
// 8.20: `if (!pref?.[STORAGE_KEYS.NOTIFY_ENABLED]) return;` had no test
// anywhere. Deleting it left the whole suite green, and so did inverting
// it, so the opt-in on a desktop notification could have been removed or
// reversed by accident without a single failure. The extension's listing
// says it does nothing the user did not ask for; this is one of the
// places that has to be true.
describe("the run-complete notification is opt-in", () => {
  const DONE = {
    type: "gmailCleanerDone",
    summary: {
      count: 42, freedMb: 3, action: "delete", dryRun: false,
      runId: "r1", outcome: "completed", stoppedShort: 0, declined: 0
    }
  };

  test("nobody who has not opted in is notified", async () => {
    // The default: notifyOnComplete has never been written.
    await dispatch(DONE);
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  test("an explicit false is not an opt-in either", async () => {
    storageBacking.local.notifyOnComplete = false;
    await dispatch(DONE);
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  test("someone who turned it on gets the notification, and it says what happened", async () => {
    storageBacking.local.notifyOnComplete = true;
    await dispatch(DONE);
    expect(chrome.notifications.create).toHaveBeenCalled();
    const opts = chrome.notifications.create.mock.calls[0][1];
    expect(JSON.stringify(opts)).toContain("42");
  });
});
