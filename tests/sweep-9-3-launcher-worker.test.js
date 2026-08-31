/**
 * @jest-environment node
 *
 * Reaching the mailbox that is already open (9.3 sweep).
 *
 * 9.2 shipped a content script because installs were not becoming runs:
 * the toolbar icon lives behind Chrome's puzzle piece and an install
 * could sit for months having scanned nothing. But a declared content
 * script is injected on navigation, and Chrome does not go back and run
 * it in pages that were already loaded. The tab somebody is looking at
 * when they decide to install a Gmail cleaner is, overwhelmingly likely,
 * their mailbox, and that is exactly the tab the new surface missed.
 *
 * Same on an update: the old copy's world is torn down and the manifest
 * does not re-run the new one, so every open Gmail tab keeps an orphan
 * until it is reloaded.
 *
 * So the worker injects the launcher into the mailbox tabs that are open
 * at install and at update. The file is built for it: it refuses a
 * non-mailbox path, refuses a subframe, and hands the corner over to a
 * live copy rather than stacking a second button.
 */

let onInstalledCb;
let storageBacking;
let queryResult;

function resetStorage() {
  storageBacking = { local: {}, sync: {}, session: {} };
}

function makeStorageArea(area) {
  return {
    get: jest.fn(async (keys) => {
      if (typeof keys === "string") return { [keys]: storageBacking[area][keys] ?? undefined };
      if (Array.isArray(keys)) {
        const result = {};
        for (const k of keys) result[k] = storageBacking[area][k] ?? undefined;
        return result;
      }
      return { ...storageBacking[area] };
    }),
    set: jest.fn(async (obj) => { Object.assign(storageBacking[area], obj); }),
    remove: jest.fn(async (key) => { delete storageBacking[area][key]; })
  };
}

beforeAll(() => {
  resetStorage();
  queryResult = [];
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn((cb) => { onInstalledCb = cb; }) },
      onStartup: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn() },
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
      query: jest.fn(async () => queryResult),
      get: jest.fn(async (id) => ({ id })),
      sendMessage: jest.fn(async () => ({ ok: true })),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: { executeScript: jest.fn(async () => []) },
    // Callback form, which is what getInstallType calls. A promise-only
    // stub here never resolves and the whole install handler hangs.
    management: { getSelf: jest.fn((cb) => cb({ installType: "normal" })) },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) }
  };

  const fs = require("fs");
  const path = require("path");
  const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");
  new Function(code)();
});

beforeEach(() => {
  resetStorage();
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  chrome.scripting.executeScript = jest.fn(async () => []);
  chrome.tabs.query = jest.fn(async () => queryResult);
  queryResult = [];
  jest.clearAllMocks();
});

const install = async (reason = "install") => {
  await onInstalledCb({ reason });
  // The injection is deliberately not awaited by onInstalled: a browser
  // that is mid-startup should not have its install handler held open by
  // a tab that will not answer. Give the fire-and-forget a turn.
  await new Promise((r) => setTimeout(r, 50));
};

const launcherInjections = () =>
  chrome.scripting.executeScript.mock.calls
    .map(([details]) => details)
    .filter((d) => Array.isArray(d?.files) && d.files.includes("gmailLauncher.js"));

const MAILBOX_A = { id: 11, url: "https://mail.google.com/mail/u/0/#inbox" };
const MAILBOX_B = { id: 12, url: "https://mail.google.com/mail/u/1/#search/x" };
const CHAT_TAB = { id: 13, url: "https://mail.google.com/chat/u/0/#chat/home" };
const OTHER_TAB = { id: 14, url: "https://example.com/" };

describe("the mailbox that was already open", () => {
  test("a fresh install reaches every open mailbox tab", async () => {
    queryResult = [MAILBOX_A, MAILBOX_B, CHAT_TAB, OTHER_TAB];
    await install("install");

    const targets = launcherInjections().map((d) => d.target.tabId).sort((a, b) => a - b);
    expect(targets).toEqual([11, 12]);
  });

  test("an update reaches them too, because the old copy is an orphan by then", async () => {
    queryResult = [MAILBOX_A];
    await install("update");
    expect(launcherInjections().map((d) => d.target.tabId)).toEqual([11]);
  });

  test("Gmail Chat is the same origin and is not a mailbox", async () => {
    queryResult = [CHAT_TAB];
    await install("install");
    expect(launcherInjections()).toEqual([]);
  });

  test("nothing outside Gmail is touched", async () => {
    queryResult = [OTHER_TAB];
    await install("install");
    expect(launcherInjections()).toEqual([]);
  });

  test("the top frame only, the way the manifest declares it", async () => {
    queryResult = [MAILBOX_A];
    await install("install");
    for (const details of launcherInjections()) {
      expect(details.target.allFrames).toBeFalsy();
      expect(details.files).toEqual(["gmailLauncher.js"]);
    }
  });

  test("a tab that refuses the injection does not stop the next one", async () => {
    queryResult = [MAILBOX_A, MAILBOX_B];
    chrome.scripting.executeScript = jest.fn(async (details) => {
      if (details.target.tabId === 11) throw new Error("Cannot access contents of the page");
      return [];
    });
    await install("install");
    expect(launcherInjections().map((d) => d.target.tabId)).toContain(12);
  });

  test("a tabs.query that throws is not an install failure", async () => {
    chrome.tabs.query = jest.fn(async () => { throw new Error("no tabs"); });
    await expect(install("install")).resolves.toBeUndefined();
  });

  test("the greeting is still armed exactly once, by the install", async () => {
    queryResult = [MAILBOX_A];
    await install("install");
    expect(storageBacking.local.gmailLauncher?.greetPending).toBe(true);

    storageBacking.local.gmailLauncher = { enabled: true, hideUntil: 0, greetPending: false };
    await install("update");
    expect(storageBacking.local.gmailLauncher?.greetPending).toBe(false);
  });
});
