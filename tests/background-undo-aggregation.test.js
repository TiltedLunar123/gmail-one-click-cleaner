/**
 * @jest-environment node
 *
 * Regression: the Recovery Log evicted itself during the run it exists
 * to undo.
 *
 * 7.15.0 recorded one undo entry per PASS. The engine loops
 * `while (pass < PASS_CAP = 150)` for each of up to 11 Normal rules, and
 * recordUndoEntry truncated the log to 20 entries. A first sweep on a
 * real mailbox therefore pushed its own earliest entries out before it
 * finished, and always destroyed every entry belonging to the previous
 * run. The one artefact a frightened user reaches for was the artefact
 * the scary run deleted.
 *
 * 8.0 merges passes of the same rule in the same run into a single
 * entry keyed on (runId, label, tagLabel, action) and raises the cap to
 * 60, so the log holds runs (what a user thinks in) rather than passes
 * (what the engine thinks in).
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

// Every write goes through withStorageLock, so the handler serializes
// them for us; the tests queue their passes and settle once.
const recordPass = (data) => {
  onMessageCb({ type: "gmailCleanerRecordUndo", data }, { id: "test-extension-id" }, jest.fn());
};

const settle = () => new Promise((r) => setTimeout(r, 120));

const log = () => storageBacking.local.undoLog || [];

const pass = (over = {}) => ({
  runId: "run-1",
  query: "category:promotions older_than:6m",
  label: "Promotions",
  tagLabel: "GmailCleaner - Promotions",
  action: "delete",
  intensity: "normal",
  count: 50,
  taggingFailed: false,
  ...over
});

// The shared restore policy is why taggingFailed has to be sticky: an
// entry that reports a failed tag offers no safe search target and the
// Restore button turns itself off.
const sharedCode = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const iifeMatch = sharedCode.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
  {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      className: "", setAttribute: () => {}, appendChild: () => {},
      style: {}, classList: { add: () => {}, remove: () => {} },
      remove: () => {}
    }),
    addEventListener: () => {}
  },
  {},
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

describe("recordUndoEntry merges passes of one rule in one run", () => {
  test("30 passes across 3 rules collapse to 3 entries with summed counts", async () => {
    const RULES = [
      { label: "Promotions", tagLabel: "GmailCleaner - Promotions" },
      { label: "Social", tagLabel: "GmailCleaner - Social" },
      { label: "Old mail", tagLabel: "GmailCleaner - Old mail" }
    ];
    for (let i = 0; i < 10; i++) {
      for (const rule of RULES) recordPass(pass({ ...rule, count: 50 }));
    }
    await settle();

    expect(log()).toHaveLength(3);
    for (const rule of RULES) {
      const entry = log().find((e) => e.label === rule.label);
      expect(`${rule.label}:${entry.count}`).toBe(`${rule.label}:500`);
      expect(`${rule.label}:${entry.passes}`).toBe(`${rule.label}:10`);
      expect(`${rule.label}:${entry.runId}`).toBe(`${rule.label}:run-1`);
    }
  });

  test("a single pass is still one entry, and says so", async () => {
    recordPass(pass({ count: 15 }));
    await settle();
    expect(log()).toHaveLength(1);
    expect(log()[0]).toMatchObject({ count: 15, passes: 1, runId: "run-1" });
  });

  test("two runs of the same rule never merge into each other", async () => {
    for (let i = 0; i < 5; i++) recordPass(pass({ runId: "run-a", count: 10 }));
    for (let i = 0; i < 5; i++) recordPass(pass({ runId: "run-b", count: 10 }));
    await settle();

    expect(log()).toHaveLength(2);
    const byRun = Object.fromEntries(log().map((e) => [e.runId, e]));
    expect(byRun["run-a"].count).toBe(50);
    expect(byRun["run-b"].count).toBe(50);
  });

  test("the same run in two modes stays two entries", async () => {
    recordPass(pass({ action: "delete", count: 7 }));
    recordPass(pass({ action: "archive", count: 9 }));
    await settle();

    expect(log()).toHaveLength(2);
    expect(log().find((e) => e.action === "delete").count).toBe(7);
    expect(log().find((e) => e.action === "archive").count).toBe(9);
  });

  test("an already-restored entry is never merged into", async () => {
    storageBacking.local.undoLog = [{
      id: "u_restored",
      runId: "run-1",
      timestamp: Date.now() - 1000,
      query: "category:promotions older_than:6m",
      label: "Promotions",
      tagLabel: "GmailCleaner - Promotions",
      action: "delete",
      count: 400,
      passes: 8,
      taggingFailed: false,
      restoredAt: 12345
    }];
    recordPass(pass({ count: 25 }));
    await settle();

    expect(log()).toHaveLength(2);
    const restored = log().find((e) => e.id === "u_restored");
    expect(restored.count).toBe(400);
    expect(restored.restoredAt).toBe(12345);
    const fresh = log().find((e) => e.id !== "u_restored");
    expect(fresh.count).toBe(25);
    expect(fresh.restoredAt).toBeUndefined();
  });
});

describe("taggingFailed is sticky across the merged group", () => {
  test("one failing pass makes the whole entry report the failure", async () => {
    recordPass(pass({ taggingFailed: false, count: 10 }));
    recordPass(pass({ taggingFailed: true, count: 10 }));
    recordPass(pass({ taggingFailed: false, count: 10 }));
    await settle();

    expect(log()).toHaveLength(1);
    expect(log()[0].taggingFailed).toBe(true);
    expect(log()[0].count).toBe(30);

    // And that is what turns the Restore button off: recovery searches
    // for the run's label, so a pass whose label never landed means the
    // merged entry cannot promise a safe search target.
    const check = GCC.restore.eligibility(log()[0]);
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/no label/i);
  });

  test("a clean group stays restorable", async () => {
    for (let i = 0; i < 4; i++) recordPass(pass({ taggingFailed: false, count: 10 }));
    await settle();

    expect(log()[0].taggingFailed).toBe(false);
    expect(GCC.restore.eligibility(log()[0])).toMatchObject({
      eligible: true,
      label: "GmailCleaner - Promotions",
      action: "delete"
    });
  });

  test("the merged entry keeps the largest sampled sender count seen", async () => {
    recordPass(pass({ sampledSenderCount: 3 }));
    recordPass(pass({ sampledSenderCount: 11 }));
    recordPass(pass({ sampledSenderCount: 5 }));
    await settle();
    expect(log()[0].sampledSenderCount).toBe(11);
  });
});

describe("sampledMessageIds union", () => {
  const ids = (from, to) => Array.from({ length: to - from }, (_, i) => `msg_${from + i}`);

  test("passes union their ids, capped at 50, with no duplicates", async () => {
    recordPass(pass({ sampledMessageIds: ids(0, 30) }));
    recordPass(pass({ sampledMessageIds: ids(20, 50) }));   // 10 overlap
    recordPass(pass({ sampledMessageIds: ids(50, 80) }));   // arrives full
    await settle();

    const entry = log()[0];
    expect(entry.sampledMessageIds).toHaveLength(50);
    expect(new Set(entry.sampledMessageIds).size).toBe(50);
    expect(entry.sampledMessageIds).toContain("msg_0");
    expect(entry.sampledMessageIds).toContain("msg_49");
  });

  test("a pass that sampled nothing does not wipe the ids already held", async () => {
    recordPass(pass({ sampledMessageIds: ids(0, 5) }));
    recordPass(pass({ sampledMessageIds: [] }));
    recordPass(pass({}));
    await settle();

    expect(log()[0].sampledMessageIds).toEqual(ids(0, 5));
  });
});

describe("log capacity", () => {
  test("holds 60 entries and evicts the oldest first", async () => {
    const now = Date.now();
    storageBacking.local.undoLog = Array.from({ length: 60 }, (_, i) => ({
      id: `seed_${i}`,
      runId: `seed-run-${i}`,
      timestamp: now - i * 1000,
      label: `Seed ${i}`,
      tagLabel: `GmailCleaner - Seed ${i}`,
      action: "delete",
      count: 1,
      passes: 1,
      taggingFailed: false
    }));

    recordPass(pass({ runId: "run-new", label: "New", tagLabel: "GmailCleaner - New" }));
    await settle();

    expect(log()).toHaveLength(60);
    expect(log()[0].label).toBe("New");
    // seed_59 was the oldest, so it is the one that went.
    expect(log().some((e) => e.id === "seed_59")).toBe(false);
    expect(log().some((e) => e.id === "seed_0")).toBe(true);
  });

  test("60 merging passes of one run occupy exactly one slot", async () => {
    for (let i = 0; i < 60; i++) recordPass(pass({ count: 1 }));
    await settle();
    expect(log()).toHaveLength(1);
    expect(log()[0].passes).toBe(60);
    expect(log()[0].count).toBe(60);
  });
});

describe("an engine older than this change", () => {
  test("a write with no runId appends instead of merging, and does not throw", async () => {
    recordPass(pass({ runId: undefined, count: 10 }));
    recordPass(pass({ runId: undefined, count: 10 }));
    recordPass(pass({ runId: "", count: 10 }));
    await settle();

    expect(log()).toHaveLength(3);
    for (const entry of log()) {
      expect(entry.count).toBe(10);
      expect(entry.runId).toBe("");
    }
  });

  test("a runId-less write never merges into a run's entry either", async () => {
    recordPass(pass({ count: 10 }));
    recordPass(pass({ runId: undefined, count: 10 }));
    await settle();

    expect(log()).toHaveLength(2);
  });
});
