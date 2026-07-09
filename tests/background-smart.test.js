/**
 * @jest-environment node
 *
 * Smart Suggestions persistence in the service worker (7.8): the
 * union-merged scan store, the bounded feedback map, and the
 * pending-apply marker that gmailCleanerDone resolves (the popup
 * closes before an apply run finishes, so "applied" confirmation has
 * to live here). The bounding mirrors GCC.smart.recordFeedback, which
 * the shared-smart suite covers; this pins the worker's copy.
 */

let onMessageCb;
let storageBacking;

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
      onAlarm: { addListener: jest.fn() }
    },
    tabs: {
      query: jest.fn(async () => []),
      get: jest.fn(async (id) => ({ id })),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: { executeScript: jest.fn(async () => []) },
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
  jest.clearAllMocks();
});

const dispatch = async (msg) => {
  const sendResponse = jest.fn();
  onMessageCb(msg, { id: "test-extension-id" }, sendResponse);
  await new Promise((r) => setTimeout(r, 50));
  return sendResponse;
};

const mkScanSender = (email, score, over = {}) => ({
  email,
  name: "Sender",
  score,
  signals: { count: 100, unreadRatio: 0.8, oldShare: 0.5, shape: true },
  estCount: 100,
  ...over
});

describe("message: gmailCleanerSmartScanResult", () => {
  test("persists a cleaned scan", async () => {
    const resp = await dispatch({
      type: "gmailCleanerSmartScanResult",
      senders: [mkScanSender("news@shop.com", 80)]
    });
    expect(resp).toHaveBeenCalledWith({ ok: true });
    const stored = storageBacking.local.smartScan;
    expect(stored.updatedAt).toBeGreaterThan(0);
    expect(stored.senders).toHaveLength(1);
    expect(stored.senders[0]).toMatchObject({
      email: "news@shop.com",
      score: 80,
      estCount: 100,
      signals: { count: 100, unreadRatio: 0.8, oldShare: 0.5, shape: true }
    });
  });

  test("drops junk emails and clamps score and signals", async () => {
    await dispatch({
      type: "gmailCleanerSmartScanResult",
      senders: [
        { email: "x@y.com) OR (is:starred", score: 90 },
        { email: "no-at.com", score: 90 },
        mkScanSender("ok@x.com", 900, { signals: { count: -5, unreadRatio: 7, oldShare: -1, shape: 1 } })
      ]
    });
    const stored = storageBacking.local.smartScan;
    expect(stored.senders).toHaveLength(1);
    expect(stored.senders[0]).toMatchObject({
      email: "ok@x.com",
      score: 100,
      signals: { count: 0, unreadRatio: 1, oldShare: 0, shape: true }
    });
  });

  test("rescans union-merge: earlier senders stay, re-measured ones update", async () => {
    await dispatch({
      type: "gmailCleanerSmartScanResult",
      senders: [mkScanSender("old@x.com", 70), mkScanSender("both@x.com", 60)]
    });
    await dispatch({
      type: "gmailCleanerSmartScanResult",
      senders: [mkScanSender("both@x.com", 90, { estCount: 500 }), mkScanSender("new@x.com", 40)]
    });
    const stored = storageBacking.local.smartScan;
    const emails = stored.senders.map((s) => s.email);
    expect(emails).toContain("old@x.com");
    expect(emails).toContain("new@x.com");
    const both = stored.senders.find((s) => s.email === "both@x.com");
    expect(both.score).toBe(90);
    expect(both.estCount).toBe(500);
    // Ranked by score: the merged list stays sorted.
    expect(emails[0]).toBe("both@x.com");
  });

  test("the merged list is capped at 50, lowest scores fall off", async () => {
    await dispatch({
      type: "gmailCleanerSmartScanResult",
      senders: Array.from({ length: 45 }, (_, i) => mkScanSender(`a${i}@x.com`, 50 + (i % 40)))
    });
    await dispatch({
      type: "gmailCleanerSmartScanResult",
      senders: Array.from({ length: 45 }, (_, i) => mkScanSender(`b${i}@x.com`, 60))
    });
    const stored = storageBacking.local.smartScan;
    expect(stored.senders).toHaveLength(50);
    expect(stored.senders.every((s) => s.score >= 50)).toBe(true);
  });
});

describe("message: gmailCleanerGetSmartScan", () => {
  test("returns stored scan and feedback, or nulls", async () => {
    let resp = await dispatch({ type: "gmailCleanerGetSmartScan" });
    expect(resp).toHaveBeenCalledWith({ ok: true, scan: null, feedback: null });

    storageBacking.local.smartScan = { updatedAt: 1, senders: [] };
    storageBacking.local.smartFeedback = { bySender: { "a@b.co": { action: "dismissed", at: 1 } } };
    resp = await dispatch({ type: "gmailCleanerGetSmartScan" });
    const payload = resp.mock.calls[0][0];
    expect(payload.scan.updatedAt).toBe(1);
    expect(payload.feedback.bySender["a@b.co"].action).toBe("dismissed");
  });
});

describe("message: gmailCleanerSmartFeedback", () => {
  test("records a dismissal, rejects junk emails and unknown actions", async () => {
    await dispatch({ type: "gmailCleanerSmartFeedback", email: "News@Shop.com", action: "dismissed" });
    await dispatch({ type: "gmailCleanerSmartFeedback", email: "in:sent", action: "dismissed" });
    await dispatch({ type: "gmailCleanerSmartFeedback", email: "a@b.co", action: "purged" });
    const fb = storageBacking.local.smartFeedback;
    expect(Object.keys(fb.bySender)).toEqual(["news@shop.com"]);
    expect(fb.bySender["news@shop.com"].action).toBe("dismissed");
  });

  test("the feedback map is bounded at 300, oldest evict first", async () => {
    const bySender = {};
    for (let i = 0; i < 300; i++) {
      bySender[`s${i}@bulk.com`] = { action: "dismissed", at: i + 1 };
    }
    storageBacking.local.smartFeedback = { bySender };
    await dispatch({ type: "gmailCleanerSmartFeedback", email: "newest@bulk.com", action: "dismissed" });
    const fb = storageBacking.local.smartFeedback;
    expect(Object.keys(fb.bySender)).toHaveLength(300);
    expect(fb.bySender["s0@bulk.com"]).toBeUndefined();
    expect(fb.bySender["newest@bulk.com"]).toBeDefined();
  });
});

describe("pending apply lifecycle", () => {
  test("applyStarted stores the marker", async () => {
    const resp = await dispatch({
      type: "gmailCleanerSmartApplyStarted",
      runId: "run-1",
      senders: ["news@shop.com"]
    });
    expect(resp).toHaveBeenCalledWith({ ok: true });
    expect(storageBacking.local.smartPendingApply).toMatchObject({
      runId: "run-1",
      senders: ["news@shop.com"]
    });
  });

  test("a matching live done records applied feedback and consumes the marker", async () => {
    await dispatch({ type: "gmailCleanerSmartApplyStarted", runId: "run-1", senders: ["news@shop.com", "deals@shop.com"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 42, freedMb: 10, action: "delete", dryRun: false, runId: "run-1" }
    });
    expect(storageBacking.local.smartPendingApply).toBeNull();
    const fb = storageBacking.local.smartFeedback;
    expect(fb.bySender["news@shop.com"].action).toBe("applied");
    expect(fb.bySender["deals@shop.com"].action).toBe("applied");
  });

  test("a dry run consumes the marker without recording feedback", async () => {
    await dispatch({ type: "gmailCleanerSmartApplyStarted", runId: "run-2", senders: ["news@shop.com"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 42, freedMb: 0, action: "delete", dryRun: true, runId: "run-2" }
    });
    expect(storageBacking.local.smartPendingApply).toBeNull();
    expect(storageBacking.local.smartFeedback).toBeUndefined();
  });

  test("a zero-count done consumes the marker without recording feedback", async () => {
    await dispatch({ type: "gmailCleanerSmartApplyStarted", runId: "run-3", senders: ["news@shop.com"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 0, freedMb: 0, action: "delete", dryRun: false, runId: "run-3" }
    });
    expect(storageBacking.local.smartPendingApply).toBeNull();
    expect(storageBacking.local.smartFeedback).toBeUndefined();
  });

  test("a non-matching done leaves a fresh marker in place", async () => {
    await dispatch({ type: "gmailCleanerSmartApplyStarted", runId: "run-4", senders: ["news@shop.com"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 5, freedMb: 1, action: "delete", dryRun: false, runId: "other-run" }
    });
    expect(storageBacking.local.smartPendingApply).toMatchObject({ runId: "run-4" });
    expect(storageBacking.local.smartFeedback).toBeUndefined();
  });
});
