/**
 * @jest-environment node
 *
 * The in-Gmail launcher, worker side (9.2).
 *
 * The launcher is a content script, so it can read neither the licence,
 * the install source, nor the mailbox report. Every decision it acts on
 * is made here, which puts the whole of this feature's policy in a file
 * the suite already covers. What gets pinned:
 *
 *   - a hidden launcher is told nothing, not even the report. "Do not
 *     draw" must not mean "draw invisibly while holding a copy of the
 *     user's counts";
 *   - the greeting is armed by a fresh install and by nothing else, and
 *     clears on first sight so a second Gmail tab cannot greet twice;
 *   - the scan runs in the tab the click came from. Never a tabs.query:
 *     picking "whichever Gmail tab is active" is the 8.11 Auto-Pilot bug,
 *     where two signed-in accounts mean measuring one mailbox and
 *     answering about the other;
 *   - and the config it injects is read-only. The button inside Gmail can
 *     start the report and nothing else.
 */

let onMessageCb;
let onInstalledCb;
let storageBacking;
let injectedConfig;
let injectedFiles;
let attached;
let pingRunId;

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
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn((cb) => { onInstalledCb = cb; }) },
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
      get: jest.fn(async (id) => ({ id })),
      sendMessage: jest.fn(async () => ({
        ok: true,
        phase: "running",
        version: "9.2.0",
        runId: pingRunId,
        runKind: "reportScan"
      })),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: {
      executeScript: jest.fn(async (details) => {
        if (details.files) {
          injectedFiles.push(...details.files);
          return [];
        }
        // Two func injections exist: the attach probe, which takes no
        // args, and the config setter, which takes one.
        if (details.args) {
          injectedConfig = details.args[0];
          pingRunId = injectedConfig?.runId || "";
          return [{ result: undefined }];
        }
        return [{ result: attached }];
      })
    },
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
  injectedConfig = null;
  injectedFiles = [];
  attached = false;
  pingRunId = "";
  // Rebuilt, not just cleared: one test below replaces this outright to
  // model an engine that belongs to somebody else, and clearAllMocks
  // does not put a replaced property back.
  chrome.tabs.sendMessage = jest.fn(async () => ({
    ok: true,
    phase: "running",
    version: "9.2.0",
    runId: pingRunId,
    runKind: "reportScan"
  }));
  jest.clearAllMocks();
});

const MAILBOX_TAB = { id: 77, url: "https://mail.google.com/mail/u/0/#inbox" };

const dispatch = async (msg, sender = { id: "test-extension-id", tab: MAILBOX_TAB }) => {
  const sendResponse = jest.fn();
  onMessageCb(msg, sender, sendResponse);
  await new Promise((r) => setTimeout(r, 60));
  return sendResponse.mock.calls[0]?.[0];
};

const state = () => dispatch({ type: "gmailCleanerLauncherState" });
const record = () => storageBacking.local.gmailLauncher;

const REPORT = {
  updatedAt: 1700000000000,
  bands: [{ id: "promotions", kind: "noise", action: "delete", count: 8000, estMb: 0, cleanedAt: 0 }],
  cleanableCount: 12000,
  largeMb: 340
};

describe("launcher state", () => {
  test("shows by default, with no record stored at all", async () => {
    const resp = await state();
    expect(resp).toMatchObject({ ok: true, show: true, greet: false, busy: false, report: null });
  });

  test("carries the stored report once there is one", async () => {
    storageBacking.local.mailboxReport = REPORT;
    const resp = await state();
    expect(resp.report.cleanableCount).toBe(12000);
  });

  test("a launcher switched off is told nothing, report included", async () => {
    storageBacking.local.mailboxReport = REPORT;
    storageBacking.local.gmailLauncher = { enabled: false };
    const resp = await state();
    expect(resp.show).toBe(false);
    // The point of the assertion: not drawing and not being handed the
    // user's counts are the same decision.
    expect(resp.report).toBeNull();
  });

  test("a hide is honoured until it expires, then stops mattering", async () => {
    storageBacking.local.gmailLauncher = { hideUntil: Date.now() + 60000 };
    expect((await state()).show).toBe(false);

    storageBacking.local.gmailLauncher = { hideUntil: Date.now() - 60000 };
    expect((await state()).show).toBe(true);
  });

  test("an untrusted copy never draws the button", async () => {
    chrome.management = { getSelf: (cb) => cb({ installType: "sideload" }) };
    try {
      expect((await state()).show).toBe(false);
    } finally {
      delete chrome.management;
    }
  });

  test("busy is true while a run holds the claim", async () => {
    storageBacking.local.activeRun = { gmailTabId: 77, runId: "r1", startedAt: Date.now() };
    expect((await state()).busy).toBe(true);
  });
});

describe("the one greeting", () => {
  test("a fresh install arms it, an update does not", async () => {
    await onInstalledCb({ reason: "install" });
    await new Promise((r) => setTimeout(r, 30));
    expect(record().greetPending).toBe(true);
    expect((await state()).greet).toBe(true);

    resetStorage();
    chrome.storage.local = makeStorageArea("local");
    await onInstalledCb({ reason: "update" });
    await new Promise((r) => setTimeout(r, 30));
    expect(record()?.greetPending).not.toBe(true);
    expect((await state()).greet).toBe(false);
  });

  test("answering the question is what spends it", async () => {
    storageBacking.local.gmailLauncher = { greetPending: true };
    expect((await state()).greet).toBe(true);
    expect(record().greetPending).toBe(false);
    // And the button stays, which is the point: the greeting is spent,
    // not the launcher.
    expect(await state()).toMatchObject({ show: true, greet: false });
  });

  test("two mailbox tabs asking at once, and only one of them is the first", async () => {
    storageBacking.local.gmailLauncher = { greetPending: true };
    // Both dispatched before either has answered. The read and the clear
    // are one operation under the storage lock, so the second one sees a
    // record that has already been spent.
    const a = jest.fn();
    const b = jest.fn();
    onMessageCb({ type: "gmailCleanerLauncherState" }, { tab: MAILBOX_TAB }, a);
    onMessageCb({ type: "gmailCleanerLauncherState" }, { tab: { id: 78, url: MAILBOX_TAB.url } }, b);
    await new Promise((r) => setTimeout(r, 120));

    const greets = [a, b].map((fn) => fn.mock.calls[0][0].greet);
    expect(greets.filter(Boolean)).toHaveLength(1);
  });
});

describe("one report, two signed-in mailboxes", () => {
  test("a report measured somewhere else is not handed to this tab", async () => {
    storageBacking.local.mailboxReport = { ...REPORT, account: "1" };
    const resp = await state();
    expect(resp.show).toBe(true);
    expect(resp.report).toBeNull();
  });

  test("the tab that measured it still gets it", async () => {
    storageBacking.local.mailboxReport = { ...REPORT, account: "0" };
    expect((await state()).report.cleanableCount).toBe(12000);
  });

  test("a report from before this release has no account, and is shown", async () => {
    storageBacking.local.mailboxReport = REPORT;
    expect((await state()).report.cleanableCount).toBe(12000);
  });

  test("a finished scan is stamped with the mailbox it was measured in", async () => {
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [{ id: "promotions", kind: "noise", action: "delete", count: 8000, estMb: 0 }],
      cleanableCount: 12000,
      largeMb: 100
    }, { tab: { id: 90, url: "https://mail.google.com/mail/u/2/#inbox" } });
    expect(storageBacking.local.mailboxReport.account).toBe("2");
  });

  test("a scan whose sender is not a mailbox is stamped with nothing, not with account zero", async () => {
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [{ id: "promotions", kind: "noise", action: "delete", count: 1, estMb: 0 }],
      cleanableCount: 1,
      largeMb: 0
    }, { id: "test-extension-id" });
    expect(storageBacking.local.mailboxReport.account).toBe("");
  });
});

describe("hiding", () => {
  test("the 30 day hide leaves the switch alone", async () => {
    const resp = await dispatch({ type: "gmailCleanerLauncherHide" });
    expect(resp.ok).toBe(true);
    expect(record().enabled).toBe(true);
    const days = (record().hideUntil - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect((await state()).show).toBe(false);
  });

  test("turning it off is the switch, not a longer snooze", async () => {
    await dispatch({ type: "gmailCleanerLauncherHide", forever: true });
    expect(record().enabled).toBe(false);
    expect(record().hideUntil).toBe(0);
  });
});

describe("starting the report from inside Gmail", () => {
  const scan = (sender) => dispatch({ type: "gmailCleanerLauncherScan" }, sender);

  test("injects a report scan into the tab the click came from", async () => {
    const resp = await scan();
    expect(resp.ok).toBe(true);
    expect(injectedFiles).toEqual(["contentScript.js"]);
    expect(injectedConfig.runKind).toBe("reportScan");
    for (const call of chrome.scripting.executeScript.mock.calls) {
      expect(call[0].target.tabId).toBe(77);
    }
    // Never a tabs.query. With two accounts signed in, "whichever Gmail
    // tab is active" measures one mailbox and answers about the other,
    // which is the retargeting 8.11 closed on the Auto-Pilot sweep.
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  test("measures through the switches the popup's own buttons apply", async () => {
    storageBacking.local.lastUiSnapshot = { safeMode: true, minAge: "1y", guardSkipUnread: false };
    // SYNC. The Never-Delete list and the protected keywords live there:
    // Options writes them there, the popup reads them there, and so do
    // the scheduled sweeps and Auto-Pilot. An earlier draft of this
    // feature read local, which is always empty for these two, so the
    // panel would have counted mail the Clean button refuses to touch
    // and this test would have passed anyway by writing to the same
    // wrong place. Writing sync here is the assertion.
    storageBacking.sync.whitelist = ["boss@work.com"];
    storageBacking.sync.protectKeywords = ["invoice"];

    await scan();
    expect(injectedConfig).toMatchObject({
      safeMode: true,
      minAge: "1y",
      guardSkipUnread: false,
      guardSkipStarred: true,
      guardSkipImportant: true,
      guardSkipUserLabels: true,
      whitelist: ["boss@work.com"],
      protectKeywords: ["invoice"]
    });
  });

  test("the config can only read: nothing in it can move mail", async () => {
    await scan();
    // An allow-list rather than a handful of not.toHaveProperty calls.
    // A future field that acts (rules, an intensity, archive instead of
    // delete) has to be added here on purpose, which is the whole point:
    // this is the one surface that draws itself without being asked for.
    expect(Object.keys(injectedConfig).sort()).toEqual([
      "debugMode",
      "guardSkipImportant",
      "guardSkipStarred",
      "guardSkipUnread",
      "guardSkipUserLabels",
      "minAge",
      "protectKeywords",
      "runId",
      "runKind",
      "safeMode",
      "version",
      "whitelist"
    ]);
  });

  test("refuses anywhere that is not a mailbox", async () => {
    const chat = { id: 88, url: "https://mail.google.com/chat/u/0/#chat/home" };
    expect(await scan({ id: "test-extension-id", tab: chat })).toEqual({ ok: false, error: "no_mailbox" });
    expect(await scan({ id: "test-extension-id" })).toEqual({ ok: false, error: "no_mailbox" });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test("refuses while an engine is already attached to that tab", async () => {
    attached = true;
    expect(await scan()).toEqual({ ok: false, error: "busy" });
    expect(injectedFiles).toEqual([]);
  });

  test("refuses while a run holds the claim", async () => {
    storageBacking.local.activeRun = { gmailTabId: 77, runId: "r1", startedAt: Date.now() };
    expect(await scan()).toEqual({ ok: false, error: "busy" });
    expect(injectedFiles).toEqual([]);
  });

  test("a swallowed injection is reported, not claimed as a start", async () => {
    // Something else attached between the check and the injection, so
    // the engine answering this tab is not the one just sent.
    chrome.tabs.sendMessage = jest.fn(async () => ({ ok: true, phase: "running", runId: "somebody_else" }));
    const resp = await scan();
    expect(resp).toEqual({ ok: false, error: "swallowed" });
  });

  test("refuses once the button has been switched off or hidden", async () => {
    // A Gmail tab opened before the switch moved still has a live panel
    // in it. The Scan button in that panel is not a way around the
    // switch.
    storageBacking.local.gmailLauncher = { enabled: false };
    expect(await scan()).toEqual({ ok: false, error: "hidden" });

    storageBacking.local.gmailLauncher = { hideUntil: Date.now() + 60000 };
    expect(await scan()).toEqual({ ok: false, error: "hidden" });
    expect(injectedFiles).toEqual([]);
  });

  test("a scan takes no run claim, and leaves none behind", async () => {
    // Read-only runs never claim ACTIVE_RUN: a marker for a scan is one
    // more thing that can strand, and a stranded one books the mailbox
    // for the whole two-hour TTL.
    expect((await scan()).ok).toBe(true);
    expect(storageBacking.local.activeRun).toBeUndefined();
  });

  test("an untrusted copy cannot start a scan either", async () => {
    chrome.management = { getSelf: (cb) => cb({ installType: "sideload" }) };
    try {
      expect(await scan()).toEqual({ ok: false, error: "untrusted" });
      expect(injectedFiles).toEqual([]);
    } finally {
      delete chrome.management;
    }
  });
});

describe("handing over to the popup", () => {
  test("says unsupported rather than pretending, when the browser has no openPopup", async () => {
    const resp = await dispatch({ type: "gmailCleanerLauncherOpenPopup" });
    expect(resp).toEqual({ ok: false, error: "unsupported" });
  });

  test("opens it where the browser allows", async () => {
    chrome.action = { openPopup: jest.fn(async () => undefined) };
    try {
      expect(await dispatch({ type: "gmailCleanerLauncherOpenPopup" })).toEqual({ ok: true });
      expect(chrome.action.openPopup).toHaveBeenCalled();
    } finally {
      delete chrome.action;
    }
  });

  test("a refusal comes back as a refusal", async () => {
    chrome.action = { openPopup: jest.fn(async () => { throw new Error("no active window"); }) };
    try {
      expect(await dispatch({ type: "gmailCleanerLauncherOpenPopup" })).toEqual({
        ok: false,
        error: "no active window"
      });
    } finally {
      delete chrome.action;
    }
  });
});
