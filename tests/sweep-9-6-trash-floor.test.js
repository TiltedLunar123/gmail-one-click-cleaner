/**
 * @jest-environment jsdom
 *
 * 9.6: "waiting in Trash" is labelled "at least" on four surfaces and
 * was not a floor.
 *
 * The engine rounded each pass's megabytes to a tenth before sending
 * them, and recordUndoEntry summed the rounded values. Rounding is
 * symmetric, so every pass landing below a half-tenth was allowed to
 * round UP, and forty of them in a row carried the error into the total.
 * The same run's own freed figure (stats.totalFreedMb) is accumulated
 * unrounded a few lines away, so one run produced two figures that could
 * not agree and the popup printed both.
 *
 * The fix is the one 9.1 applied to the X-ray's estMb: round once, at
 * the surface that prints it.
 *
 * These drive the REAL worker and the REAL GCC.trash.waiting. A first
 * draft asserted the arithmetic against local copies of the two rules
 * and stayed green with the fix reverted, which is 9.1's own lesson
 * ("an assertion on the WRITER says nothing about the READER") arriving
 * one release later in a different disguise.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENGINE = fs.readFileSync(path.join(ROOT, "contentScript.js"), "utf-8");

let onMessageCb;
let storageBacking;
let ENGINE_API;
// The engine registers a runtime listener of its own at load. It must
// not be the one the worker's messages are posted to, so the capture is
// gated: whoever loads while this is true wins, and only the worker does.
let capturingWorkerListener = false;

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
    set: jest.fn(async (obj) => { Object.assign(storageBacking[area], obj); })
  };
}

beforeAll(() => {
  resetStorage();
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() },
      onMessage: {
        addListener: jest.fn((cb) => { if (capturingWorkerListener) onMessageCb = cb; }),
        removeListener: jest.fn()
      },
      // Resolves rather than rejects: the engine posts on load and
      // nothing there awaits it, so a rejecting stub surfaces as an
      // unhandled rejection attributed to whichever test ran first.
      sendMessage: jest.fn(async () => undefined),
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
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) }
  };
  capturingWorkerListener = true;
  new Function(fs.readFileSync(path.join(ROOT, "background.js"), "utf-8"))();
  capturingWorkerListener = false;

  // The engine, loaded beside the worker so mbMovedForPass is the real
  // one. Its own runtime listener is not captured above.
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = {};
  window.alert = () => {};
  new Function(ENGINE)();
  ENGINE_API = window.GCC_INTERNALS;
});

beforeEach(() => {
  resetStorage();
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  jest.clearAllMocks();
});

// The shared policy, loaded the way background-undo-aggregation loads it.
const sharedCode = fs.readFileSync(path.join(ROOT, "shared.js"), "utf-8");
const iifeMatch = sharedCode.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
  {
    getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
    createElement: () => ({
      className: "", setAttribute: () => {}, appendChild: () => {}, style: {},
      classList: { add: () => {}, remove: () => {} }, remove: () => {}
    }),
    addEventListener: () => {}
  },
  {},
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

const settle = () => new Promise((r) => setTimeout(r, 150));
const undoLog = () => storageBacking.local.undoLog || [];

// One pass, with the figure produced by the SHIPPED engine function
// rather than by a copy of it here. `legacyRounding` replays 9.5's
// expression at the exact place 9.5 applied it, so the old shape can be
// driven through the same worker for comparison.
const sendPass = (affected, mbPerEmail, legacyRounding = false) => {
  const mbMoved = legacyRounding
    ? Math.round(affected * mbPerEmail * 10) / 10
    : ENGINE_API.mbMovedForPass(affected, mbPerEmail, false);
  onMessageCb(
    {
      type: "gmailCleanerRecordUndo",
      data: {
        runId: "run-1",
        query: "category:promotions older_than:6m",
        label: "Promotions",
        tagLabel: "GmailCleaner - Promotions",
        action: "delete",
        intensity: "normal",
        count: affected,
        mbMoved,
        taggingFailed: false
      }
    },
    { id: "test-extension-id" },
    jest.fn()
  );
};

// What the popup, the progress page and the Stats page all print, read
// out of the log the worker actually wrote.
const waitingMb = () => GCC.trash.waiting(undoLog()).mb;

// Passes of one rule in one run merge into ONE log entry (8.0), so a
// test comparing two shapes has to start from an empty log for each or
// it is measuring their sum.
const run = async (passes, mbPerEmail, legacy = false) => {
  resetStorage();
  chrome.storage.local = makeStorageArea("local");
  for (const affected of passes) sendPass(affected, mbPerEmail, legacy);
  await settle();
  return waitingMb();
};

const truth = (passes, mbPerEmail) =>
  passes.reduce((sum, affected) => sum + affected * mbPerEmail, 0);

// estimateMbPerEmail's default: the per-email size every rule without a
// larger: or has:attachment clause is measured at.
const DEFAULT_MB = 0.05;

describe("what the surfaces print is a floor", () => {
  const shapes = [
    ["forty passes clearing three leftovers each", Array.from({ length: 40 }, () => 3)],
    ["thirty passes clearing one each", Array.from({ length: 30 }, () => 1)],
    ["a full first sweep, fifty a page", Array.from({ length: 20 }, () => 50)],
    ["a ragged tail", [50, 50, 50, 12, 7, 3, 3, 1, 1, 1]]
  ];

  for (const [name, passes] of shapes) {
    test(`${name}: never above what the run really moved`, async () => {
      const shown = await run(passes, DEFAULT_MB);
      expect(shown).toBeLessThanOrEqual(truth(passes, DEFAULT_MB) + 1e-9);
    });

    test(`${name}: still close enough to be worth printing`, async () => {
      const shown = await run(passes, DEFAULT_MB);
      // A floor reading zero against a real 6 MB would be honest and
      // useless. Three decimals keeps it inside a tenth of a megabyte,
      // which is finer than anything displays.
      expect(truth(passes, DEFAULT_MB) - shown).toBeLessThan(0.1);
    });
  }

  test("the shape 9.5 overstated by a third", async () => {
    const passes = Array.from({ length: 40 }, () => 3);
    const real = truth(passes, DEFAULT_MB);

    const legacy = await run(passes, DEFAULT_MB, true);
    expect(legacy).toBeGreaterThan(real);

    const fixed = await run(passes, DEFAULT_MB);
    expect(fixed).toBeLessThanOrEqual(real + 1e-9);
  });

  test("passes clearing one message each used to read double", async () => {
    const passes = Array.from({ length: 30 }, () => 1);
    const real = truth(passes, DEFAULT_MB);
    expect(await run(passes, DEFAULT_MB, true)).toBeCloseTo(real * 2, 6);
    expect(await run(passes, DEFAULT_MB)).toBeLessThanOrEqual(real + 1e-9);
  });

  test("a big-attachment rule is unmoved: no pass was near a boundary", async () => {
    const passes = [50, 50, 17];
    expect(await run(passes, 2.0)).toBeCloseTo(truth(passes, 2.0), 6);
  });

  test("the stored record does not read like a float accident", async () => {
    await run(Array.from({ length: 40 }, () => 3), DEFAULT_MB);
    const stored = undoLog()[0].mbMoved;
    // Diagnostics shows this record. 6.000000000000001 is not a size.
    expect(String(stored).replace(/^-?\d*\.?/, "").length).toBeLessThanOrEqual(3);
  });

  test("an archive run books nothing, so nothing waits", async () => {
    // 8.9: archived mail stays in the account and against the quota.
    onMessageCb(
      {
        type: "gmailCleanerRecordUndo",
        data: {
          runId: "run-arch", query: "in:inbox older_than:1y", label: "Old",
          tagLabel: "GmailCleaner - Old", action: "archive",
          count: 500, mbMoved: 0, taggingFailed: false
        }
      },
      { id: "test-extension-id" }, jest.fn()
    );
    await settle();
    const waiting = GCC.trash.waiting(undoLog());
    expect(waiting.mb).toBe(0);
    expect(waiting.count).toBe(0);
  });
});

describe("the rounding lives in one place", () => {
  test("the engine's own function returns the raw product", () => {
    // Driven, not pinned. 9.5's expression would answer 0.2 here.
    expect(ENGINE_API.mbMovedForPass(3, 0.05, false)).toBeCloseTo(0.15, 10);
    expect(ENGINE_API.mbMovedForPass(1, 0.05, false)).toBeCloseTo(0.05, 10);
  });

  test("an archive run is zeroed by the same function", () => {
    // 8.9: archived mail stays in the account and against the quota.
    expect(ENGINE_API.mbMovedForPass(500, 2.0, true)).toBe(0);
  });

  test("it floors its own inputs rather than trusting them", () => {
    for (const bad of [-5, NaN, undefined, null, "many"]) {
      expect(ENGINE_API.mbMovedForPass(bad, 0.05, false)).toBe(0);
      expect(ENGINE_API.mbMovedForPass(50, bad, false)).toBe(0);
    }
  });

  test("the send site calls it instead of doing the arithmetic itself", () => {
    const sendBlock = ENGINE.slice(
      ENGINE.indexOf("mbMoved: mbMovedForPass("),
      ENGINE.indexOf('tagLabel: tagLabel || "",')
    );
    expect(sendBlock).toContain("CONFIG.archiveInsteadOfDelete");
    expect(sendBlock).not.toContain("* 10) / 10");
  });

  test("GCC.trash.waiting sums and does not round", () => {
    const waiting = sharedCode.slice(
      sharedCode.indexOf("const trashWaiting = (log, now = Date.now())"),
      sharedCode.indexOf("// Which signed-in mailbox a Gmail URL is showing")
    );
    expect(waiting).toContain("mb += Math.max(0, Number(entry?.mbMoved) || 0)");
    expect(waiting).not.toContain("Math.round");
  });
});
