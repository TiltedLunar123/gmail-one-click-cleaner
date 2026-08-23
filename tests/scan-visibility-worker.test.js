/**
 * @jest-environment node
 *
 * The worker can see a run that never claimed (8.23).
 *
 * Five run kinds attach to the Gmail tab without ever taking an
 * ACTIVE_RUN claim: reportScan, storageScan, smartScan, subscriptionScan
 * and unsubscribe. `hasActiveRun()` therefore cannot see them, and
 * `gmailCleanerRunState` was answering the popup from the claim alone:
 * it called `probeEngine(run?.gmailTabId ?? msg.tabId ?? null)`, and with
 * no claim and no tab id from the caller that is `probeEngine(null)`,
 * which returns `{reachable:false, running:false}` without asking anyone.
 *
 * So the popup was told nothing was running while the user's Gmail tab
 * was working through fifteen searches, and the run banner stayed hidden.
 * The engine has answered its ping with `phase` and `runKind` since 8.7;
 * nothing was reading it.
 *
 * The claim stays authoritative where it exists. Sweeping is only for the
 * case the claim cannot cover.
 */

let onMessageCb;
let storageBacking;
let pingAnswers;
let pinged;

function resetStorage() {
  storageBacking = { local: {}, sync: {}, session: {} };
}

function makeStorageArea(area) {
  return {
    get: jest.fn(async (keys) => {
      if (typeof keys === "string") return { [keys]: storageBacking[area][keys] ?? undefined };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = storageBacking[area][k] ?? undefined;
        return out;
      }
      return { ...storageBacking[area] };
    }),
    set: jest.fn(async (obj) => { Object.assign(storageBacking[area], obj); }),
    remove: jest.fn(async (keys) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete storageBacking[area][k];
    })
  };
}

// Tabs the query stub reports. Chat is deliberately in the list: it is
// served from mail.google.com but is not a mailbox, and listGmailTabs
// filters it, so it must never be probed.
let tabsInBrowser;

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
      create: jest.fn(), clear: jest.fn(async () => true),
      getAll: jest.fn(async () => []), onAlarm: { addListener: jest.fn() }
    },
    tabs: {
      query: jest.fn(async () => tabsInBrowser),
      get: jest.fn(async (id) => ({ id })),
      reload: jest.fn(async () => {}),
      onRemoved: { addListener: jest.fn() },
      sendMessage: jest.fn(async (tabId, msg) => {
        if (msg?.type !== "gmailCleanerPing") return { ok: true };
        pinged.push(tabId);
        const answer = pingAnswers[tabId];
        if (!answer) throw new Error("no receiving end");
        return { ok: true, version: "8.22.0", ...answer };
      })
    },
    scripting: { executeScript: jest.fn(async () => []) },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) }
  };

  const fs = require("fs");
  const path = require("path");
  new Function(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8"))();
});

beforeEach(() => {
  resetStorage();
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  pingAnswers = {};
  pinged = [];
  tabsInBrowser = [
    { id: 11, url: "https://mail.google.com/mail/u/0/#inbox", active: true, windowId: 1 },
    { id: 12, url: "https://mail.google.com/mail/u/1/#inbox", active: false, windowId: 1 },
    { id: 13, url: "https://mail.google.com/chat/u/0/#chat", active: false, windowId: 1 }
  ];
  jest.clearAllMocks();
});

const runState = async () => {
  const sendResponse = jest.fn();
  onMessageCb({ type: "gmailCleanerRunState" }, { id: "test-extension-id" }, sendResponse);
  await new Promise((r) => setTimeout(r, 60));
  expect(sendResponse).toHaveBeenCalled();
  return sendResponse.mock.calls[0][0];
};

const claim = (tabId, runId = "r-1") => {
  storageBacking.local.activeRun = { runId, gmailTabId: tabId, startedAt: Date.now() };
};

describe("a claimless scan is visible to the popup", () => {
  test("a reportScan running in a tab is reported, with its tab and its kind", async () => {
    pingAnswers[12] = { phase: "running", runKind: "reportScan", runId: "" };
    const resp = await runState();

    expect(resp.ok).toBe(true);
    expect(resp.run).toBeNull();
    // The bug: all three of these were false/absent, so the banner hid.
    expect(resp.engineRunning).toBe(true);
    expect(resp.engineReachable).toBe(true);
    expect(resp.engineTabId).toBe(12);
    expect(resp.engineRunKind).toBe("reportScan");
  });

  test.each([
    ["storageScan"], ["smartScan"], ["subscriptionScan"], ["unsubscribe"], ["restoreRun"]
  ])("%s is reported the same way", async (kind) => {
    pingAnswers[11] = { phase: "running", runKind: kind, runId: "" };
    const resp = await runState();
    expect(resp.engineRunning).toBe(true);
    expect(resp.engineTabId).toBe(11);
    expect(resp.engineRunKind).toBe(kind);
  });

  test("an idle engine is not a run", async () => {
    pingAnswers[11] = { phase: "idle", runKind: "", runId: "" };
    pingAnswers[12] = { phase: "idle", runKind: "", runId: "" };
    const resp = await runState();
    expect(resp.engineRunning).toBe(false);
    expect(resp.engineTabId).toBeNull();
  });

  test("no engine anywhere is not a run", async () => {
    const resp = await runState();
    expect(resp.engineRunning).toBe(false);
    expect(resp.engineTabId).toBeNull();
  });

  test("a Chat tab is never probed", async () => {
    pingAnswers[13] = { phase: "running", runKind: "reportScan", runId: "" };
    const resp = await runState();
    expect(pinged).not.toContain(13);
    expect(resp.engineRunning).toBe(false);
  });
});

describe("the claim stays authoritative", () => {
  test("a claimed run answers from its own tab, not from whichever tab is swept first", async () => {
    claim(12);
    pingAnswers[11] = { phase: "running", runKind: "reportScan", runId: "" };
    pingAnswers[12] = { phase: "running", runKind: "cleanup", runId: "r-1" };

    const resp = await runState();
    expect(resp.run?.gmailTabId).toBe(12);
    expect(resp.engineRunning).toBe(true);
    expect(resp.engineTabId).toBe(12);
    expect(resp.engineRunKind).toBe("cleanup");
    // Sweeping a claimed run could only find someone else's tab, so it
    // must not happen at all: tab 11 is running and must be ignored.
    expect(pinged).not.toContain(11);
  });

  test("a claim whose engine is gone still reads as stuck, not as a scan elsewhere", async () => {
    claim(12);
    pingAnswers[11] = { phase: "running", runKind: "smartScan", runId: "" };
    // tab 12 answers nothing: the claim is stranded.

    const resp = await runState();
    expect(resp.run?.gmailTabId).toBe(12);
    // This is what showRunBanner reads as "A run is stuck", and the
    // sweep must not paper over it with an unrelated tab's scan.
    expect(resp.engineRunning).toBe(false);
    expect(resp.engineReachable).toBe(false);
  });
});
