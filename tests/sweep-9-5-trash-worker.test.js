/**
 * @jest-environment node
 *
 * 9.5, worker side: the Open Trash mark and the size on a recovery entry.
 *
 * The launcher panel that explains Gmail's "Empty Trash now" link may
 * only appear when this extension's own door put the tab there. That is
 * a one-shot mark, armed by the door and spent by the first launcher
 * that asks from the matching mailbox, inside the lock that already
 * spends the greeting for the same reason.
 *
 * Two things it must get right, both of them 9.2's rules applied again:
 *
 *   - the account is read off the tab the worker looked up, never off
 *     the message. Extension pages send this, so the payload is not
 *     hostile; a rule that only holds against attackers is a rule with a
 *     hole in it the week somebody adds a caller.
 *   - with two accounts signed in, the other mailbox's launcher gets the
 *     same storage change and asks too. If that ask spent the mark, the
 *     panel would reliably appear in the wrong mailbox.
 *
 * And the recovery log now records how many megabytes a run moved, which
 * is the only place the "waiting in Trash" figure can be measured from:
 * it is the only store that knows which runs are still inside the
 * 30-day window.
 */

let onMessageCb;
let storageBacking;

function resetStorage() {
  storageBacking = { local: {}, sync: {}, session: {} };
}

function makeStorageArea(area) {
  return {
    get: jest.fn(async (keys) => {
      // Cloned on read. A stub handing back the live array lets a test
      // that splices pass by aliasing the very object it is checking.
      const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
      if (typeof keys === "string") return { [keys]: clone(storageBacking[area][keys]) };
      if (Array.isArray(keys)) {
        const result = {};
        for (const k of keys) result[k] = clone(storageBacking[area][k]);
        return result;
      }
      return clone({ ...storageBacking[area] });
    }),
    set: jest.fn(async (obj) => { Object.assign(storageBacking[area], obj); }),
    remove: jest.fn(async (key) => { delete storageBacking[area][key]; })
  };
}

const TABS = {
  77: { id: 77, url: "https://mail.google.com/mail/u/0/#trash" },
  78: { id: 78, url: "https://mail.google.com/mail/u/1/#trash" },
  90: { id: 90, url: "https://example.test/not-gmail" },
  91: { id: 91, url: "https://mail.google.com/chat/u/0/#chat/home" }
};

beforeAll(() => {
  resetStorage();
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn((cb) => { onMessageCb = cb; }) },
      sendMessage: jest.fn().mockRejectedValue(new Error("no listener")),
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
      create: jest.fn(),
      clear: jest.fn(async () => true),
      getAll: jest.fn(async () => []),
      onAlarm: { addListener: jest.fn() }
    },
    tabs: {
      query: jest.fn(async () => []),
      get: jest.fn(async (id) => {
        if (!TABS[id]) throw new Error("No tab with id " + id);
        return TABS[id];
      }),
      sendMessage: jest.fn(async () => ({ ok: true })),
      update: jest.fn(async () => ({})),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: { executeScript: jest.fn(async () => [{ result: false }]) },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) }
  };

  const fs = require("fs");
  const path = require("path");
  new Function(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8"))();
});

beforeEach(() => {
  resetStorage();
  // Rebuilt rather than cleared: clearAllMocks does not put a replaced
  // property back, and these areas are replaced wholesale.
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  jest.clearAllMocks();
});

const dispatch = async (msg, tab) => {
  const sendResponse = jest.fn();
  onMessageCb(msg, { id: "test-extension-id", tab }, sendResponse);
  await new Promise((r) => setTimeout(r, 60));
  return sendResponse.mock.calls[0]?.[0];
};

const arm = (tabId) => dispatch({ type: "gmailCleanerArmTrashHint", tabId }, TABS[77]);
const askFrom = (tab) => dispatch({ type: "gmailCleanerLauncherState" }, tab);
const record = () => storageBacking.local.gmailLauncher;

describe("the Open Trash mark", () => {
  test("is stamped with the account read off the tab", async () => {
    expect(await arm(78)).toEqual({ ok: true });
    expect(record().trashHintAcct).toBe("1");
    expect(record().trashHintAt).toBeGreaterThan(0);
  });

  test("ignores an account handed to it in the message", async () => {
    // The payload claims account 9; the tab says 1. The tab wins,
    // because it is the thing the worker actually looked up.
    await dispatch({ type: "gmailCleanerArmTrashHint", tabId: 78, account: "9" }, TABS[77]);
    expect(record().trashHintAcct).toBe("1");
  });

  test("is refused for a tab that is not a mailbox", async () => {
    expect(await arm(90)).toEqual({ ok: false, error: "not a mailbox" });
    expect(record()).toBeUndefined();
  });

  test("is refused for Google Chat, which is served from the same origin", async () => {
    expect(await arm(91)).toEqual({ ok: false, error: "not a mailbox" });
    expect(record()).toBeUndefined();
  });

  test("is refused for a tab that is gone", async () => {
    expect(await arm(4242)).toEqual({ ok: false, error: "no tab" });
    expect(await arm(0)).toEqual({ ok: false, error: "no tab" });
  });

  test("reaches the launcher in the mailbox it was armed for, once", async () => {
    await arm(78);
    const first = await askFrom(TABS[78]);
    expect(first.trashHint).toBe(true);
    // Spent. A second ask from the same tab is told no.
    const second = await askFrom(TABS[78]);
    expect(second.trashHint).toBe(false);
    expect(record().trashHintAt).toBe(0);
    expect(record().trashHintAcct).toBe("");
  });

  test("a second signed-in account does not consume the other's mark", async () => {
    await arm(78);
    // Account 0's launcher gets the same storage change and asks first.
    const other = await askFrom(TABS[77]);
    expect(other.trashHint).toBe(false);
    // The mark is untouched, so the mailbox it was meant for still gets it.
    expect(record().trashHintAcct).toBe("1");
    expect((await askFrom(TABS[78])).trashHint).toBe(true);
  });

  test("an expired mark is never shown, and is cleared by whoever finds it", async () => {
    await arm(78);
    storageBacking.local.gmailLauncher = {
      ...record(),
      trashHintAt: Date.now() - 6 * 60 * 1000
    };
    const resp = await askFrom(TABS[78]);
    expect(resp.trashHint).toBe(false);
    expect(record().trashHintAt).toBe(0);
  });

  test("a launcher that may not draw is told nothing about it", async () => {
    await arm(78);
    storageBacking.local.gmailLauncher = { ...record(), enabled: false };
    const resp = await askFrom(TABS[78]);
    expect(resp.show).toBe(false);
    expect(resp.trashHint).toBeUndefined();
  });

  test("arming does not disturb a pending greeting", async () => {
    storageBacking.local.gmailLauncher = { enabled: true, hideUntil: 0, greetPending: true };
    await arm(78);
    expect(record().greetPending).toBe(true);
  });

  test("a garbage account in the stored record cannot be matched", async () => {
    storageBacking.local.gmailLauncher = {
      enabled: true, hideUntil: 0, greetPending: false,
      trashHintAt: Date.now(), trashHintAcct: "../evil"
    };
    expect((await askFrom(TABS[78])).trashHint).toBe(false);
  });
});

describe("the recovery log records how much a run moved", () => {
  const recordUndo = (data) => dispatch({ type: "gmailCleanerRecordUndo", data }, TABS[77]);
  const log = () => storageBacking.local.undoLog || [];

  const PASS = {
    runId: "run-1",
    query: "category:promotions older_than:1y",
    label: "Promotions",
    count: 120,
    mbMoved: 30.5,
    action: "delete",
    tagLabel: "GmailCleaner - Promotions",
    taggingFailed: false
  };

  test("a delete pass stores its megabytes beside its count", async () => {
    await recordUndo(PASS);
    expect(log()[0]).toMatchObject({ count: 120, mbMoved: 30.5, action: "delete" });
  });

  test("passes of one rule in one run add their megabytes together", async () => {
    // 8.0 merges passes into a single entry, which is what a user thinks
    // in. The size has to merge the same way the count does, or a long
    // sweep reports its first pass and calls that the run.
    await recordUndo(PASS);
    await recordUndo({ ...PASS, count: 80, mbMoved: 19.5 });
    expect(log()).toHaveLength(1);
    expect(log()[0]).toMatchObject({ count: 200, mbMoved: 50, passes: 2 });
  });

  test("an archive run books no megabytes", async () => {
    // 8.9: archived mail stays in the account and against the quota, so
    // it is not waiting for anything and must not carry a size.
    await recordUndo({ ...PASS, action: "archive", mbMoved: 0 });
    expect(log()[0]).toMatchObject({ action: "archive", mbMoved: 0 });
  });

  test("a missing or unusable size records zero rather than NaN", async () => {
    const { mbMoved, ...noSize } = PASS;
    expect(mbMoved).toBe(30.5);
    await recordUndo(noSize);
    await recordUndo({ ...PASS, runId: "run-2", mbMoved: "lots" });
    await recordUndo({ ...PASS, runId: "run-3", mbMoved: -900 });
    for (const entry of log()) expect(entry.mbMoved).toBe(0);
  });
});
