/**
 * @jest-environment node
 *
 * 9.6: the Open Trash mark was matched on the account, and the account
 * does not tell two tabs apart.
 *
 * 9.5 thought about two SIGNED-IN ACCOUNTS and guarded them: the other
 * mailbox's launcher gets the same storage change, asks, and must not
 * consume a mark stamped for its neighbour. The commoner arrangement is
 * two tabs on ONE account, and there both tabs read "0", both matched,
 * and the first to ask spent it.
 *
 * The tab that lost then armed a panel and waited fifteen seconds for a
 * hash change to #trash that was never coming, because it had not gone
 * anywhere; the tab that had actually been navigated to Trash was told
 * there was nothing waiting for it. The one guidance surface in 9.5
 * disappeared for anyone with a second Gmail open, which is most people
 * who keep Gmail open at all.
 */
const fs = require("fs");
const path = require("path");

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
    set: jest.fn(async (obj) => { Object.assign(storageBacking[area], obj); }),
    remove: jest.fn(async (key) => { delete storageBacking[area][key]; })
  };
}

// Two tabs on ONE mailbox, plus one on a second account. 41 is the tab
// the user is looking at and the one the popup navigates; 40 is the
// Gmail they left pinned.
const TABS = {
  40: { id: 40, url: "https://mail.google.com/mail/u/0/#inbox" },
  41: { id: 41, url: "https://mail.google.com/mail/u/0/#trash" },
  50: { id: 50, url: "https://mail.google.com/mail/u/1/#inbox" }
};

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
    tabs: {
      query: jest.fn(async () => Object.values(TABS)),
      get: jest.fn(async (id) => {
        if (!TABS[id]) throw new Error("No tab with id");
        return TABS[id];
      }),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: { executeScript: jest.fn(async () => []) },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) },
    management: { getSelf: jest.fn((cb) => cb({ installType: "normal" })) }
  };
  new Function(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8"))();
});

beforeEach(() => {
  resetStorage();
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

// The popup navigates a tab and then arms; the message carries the tab
// id and nothing else.
const arm = (tabId) => dispatch({ type: "gmailCleanerArmTrashHint", tabId }, TABS[41]);
const askFrom = (tab) => dispatch({ type: "gmailCleanerLauncherState" }, tab);
const record = () => storageBacking.local.gmailLauncher;

describe("two Gmail tabs on one account", () => {
  test("the pinned tab asking first does not consume the mark", async () => {
    await arm(41);
    // Tab 40 gets the same storage change and asks first. Same account.
    expect((await askFrom(TABS[40])).trashHint).toBe(false);
    // Untouched, so the tab that was actually navigated still gets it.
    expect(record().trashHintAt).toBeGreaterThan(0);
    expect((await askFrom(TABS[41])).trashHint).toBe(true);
  });

  test("the navigated tab spends it, and only once", async () => {
    await arm(41);
    expect((await askFrom(TABS[41])).trashHint).toBe(true);
    expect((await askFrom(TABS[41])).trashHint).toBe(false);
    expect(record().trashHintTab).toBe(0);
    expect(record().trashHintAcct).toBe("");
    expect(record().trashHintAt).toBe(0);
  });

  test("once spent, the other tab is still told nothing", async () => {
    await arm(41);
    await askFrom(TABS[41]);
    expect((await askFrom(TABS[40])).trashHint).toBe(false);
  });

  test("the tab is recorded beside the account, not instead of it", async () => {
    // Dropping the account would lose the check 9.5 added for two
    // signed-in mailboxes, and a fact separated from its measurement is
    // 9.1's lesson.
    await arm(41);
    expect(record().trashHintTab).toBe(41);
    expect(record().trashHintAcct).toBe("0");
  });

  test("a second signed-in account still cannot consume it", async () => {
    await arm(41);
    expect((await askFrom(TABS[50])).trashHint).toBe(false);
    expect(record().trashHintTab).toBe(41);
    expect((await askFrom(TABS[41])).trashHint).toBe(true);
  });

  test("the tab id never reaches the launcher", async () => {
    // The content script is told one bit: whether it may speak.
    await arm(41);
    const resp = await askFrom(TABS[41]);
    expect(resp.trashHint).toBe(true);
    expect(JSON.stringify(resp)).not.toContain("41");
    expect(resp.trashHintTab).toBeUndefined();
  });
});

describe("the mark survives the shapes that can reach it", () => {
  test("a 9.5 record with no tab id falls back to the account", async () => {
    // Written by the release being upgraded from, inside its own five
    // minute window. Refusing it would swallow the one panel 9.5 shipped
    // on the very upgrade that fixes it.
    storageBacking.local.gmailLauncher = {
      enabled: true, hideUntil: 0, greetPending: false,
      trashHintAt: Date.now(), trashHintAcct: "0"
    };
    expect((await askFrom(TABS[41])).trashHint).toBe(true);
  });

  test("a 9.5 record still cannot cross accounts", async () => {
    storageBacking.local.gmailLauncher = {
      enabled: true, hideUntil: 0, greetPending: false,
      trashHintAt: Date.now(), trashHintAcct: "0"
    };
    expect((await askFrom(TABS[50])).trashHint).toBe(false);
  });

  test("a junk tab id in the record is read as absent, not as a match", async () => {
    for (const junk of ["41", 41.5, -1, 0, null, {}, [41]]) {
      storageBacking.local.gmailLauncher = {
        enabled: true, hideUntil: 0, greetPending: false,
        trashHintAt: Date.now(), trashHintAcct: "0", trashHintTab: junk
      };
      // Falls back to the account, which is 9.5's behaviour: never a
      // throw and never a match on something that is not a tab id.
      const resp = await askFrom(TABS[41]);
      expect(typeof resp.trashHint).toBe("boolean");
    }
  });

  test("an expired mark is cleared with its tab id", async () => {
    await arm(41);
    storageBacking.local.gmailLauncher = {
      ...record(),
      trashHintAt: Date.now() - 6 * 60 * 1000
    };
    expect((await askFrom(TABS[41])).trashHint).toBe(false);
    expect(record().trashHintAt).toBe(0);
    expect(record().trashHintTab).toBe(0);
  });

  test("arming a second time replaces the tab rather than adding one", async () => {
    await arm(41);
    await arm(40);
    expect(record().trashHintTab).toBe(40);
    expect((await askFrom(TABS[41])).trashHint).toBe(false);
    expect((await askFrom(TABS[40])).trashHint).toBe(true);
  });
});
