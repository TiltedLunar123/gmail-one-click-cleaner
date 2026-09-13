/**
 * @jest-environment node
 *
 * 9.7: Erase Stored Sender Data left the biggest list of all.
 *
 * 9.6 said the button "removes every store in this browser that holds an
 * address", and its own whole-storage test seeded fourteen stores and
 * proved none of their addresses survived. It seeded cleanupStats as
 * `{ totalDeleted, totalFreedMb }`, which is the one shape that store
 * never has on a browser that has run a cleanup. The real object carries
 * `topSenders`: up to two hundred addresses sampled off the rows of
 * every delete batch, rendered on the Stats page under "Top senders"
 * with a Protect button beside each one. It also carries `history`,
 * fifty runs deep, and each run's `perQuery[].query` is the literal
 * Gmail search, which for a purge, a smart apply, a census clear or a
 * receipts clear is a list of addresses. `runHistory` holds the same
 * queries for the last ten runs.
 *
 * The Options copy says "Everything this extension knows about who
 * emails you ... Erasing here removes all of it now". PRIVACY.md said,
 * one paragraph later, that the cleanup history keeps the queries. The
 * top senders list was named nowhere. That is the 9.5 and 9.6 shape a
 * third time: the copy admitting a gap was treated as the fix.
 *
 * Nothing renders a stored query string (progress.js reads perQuery off
 * the live done message; Stats and Diagnostics render counts), so the
 * history entries keep their counts, labels, modes and durations and lose
 * only the address-bearing search. The recovery log is left alone, as
 * 9.6 decided and documented: it is what Restore reads and it has its own
 * Clear button.
 */
const fs = require("fs");
const path = require("path");

const WORKER = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");
const OPTIONS_HTML = fs.readFileSync(path.join(__dirname, "..", "options.html"), "utf-8");
const OPTIONS_JS = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf-8");
const PRIVACY = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf-8");
const DIAG_JS = fs.readFileSync(path.join(__dirname, "..", "diagnostics.js"), "utf-8");
const DIAG_HTML = fs.readFileSync(path.join(__dirname, "..", "diagnostics.html"), "utf-8");

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
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  jest.clearAllMocks();
});

const erase = async () => {
  const sendResponse = jest.fn();
  onMessageCb({ type: "gmailCleanerEraseStores" }, { id: "test-extension-id" }, sendResponse);
  await new Promise((r) => setTimeout(r, 80));
  return sendResponse.mock.calls[0]?.[0];
};

// The addresses a browser that has run every kind of cleanup is holding
// in the two history stores. Every one is written by a real code path:
// recordSenderHits for the top senders, recordStats for the lifetime
// history, the engine's saveRunHistory for the last ten runs.
const TOP = ["promo@retail.example", "news@paper.example", "hr@employer.example"];
const PURGED = ["big@video.example", "huge@backup.example"];
const CENSUS = ["daily@codehost.example", "alerts@bank.example"];

const seedHistories = () => {
  storageBacking.local = {
    cleanupStats: {
      totalRuns: 12,
      totalDeleted: 4321,
      totalArchived: 12,
      totalFreedMb: 987.6,
      topSenders: TOP.map((sender, i) => ({ sender, count: 30 - i, lastSeen: Date.now() })),
      history: [
        {
          timestamp: Date.now(),
          action: "delete",
          deleted: 40,
          archived: 0,
          freedMb: 12.5,
          intensity: "normal",
          dryRun: false,
          duration: 9000,
          perQuery: [
            { query: `from:(${PURGED.join(" OR ")}) larger:100k older_than:6m -is:starred`, label: "Senders", count: 40, mode: "live", durationMs: 9000 }
          ]
        },
        {
          timestamp: Date.now() - 86400000,
          action: "delete",
          deleted: 200,
          archived: 0,
          freedMb: 3,
          intensity: "light",
          dryRun: false,
          duration: 20000,
          perQuery: [
            { query: "category:promotions older_than:1y -is:starred", label: "Promotions", count: 200, mode: "live", durationMs: 20000 }
          ]
        }
      ],
      categoryBreakdown: { Senders: { count: 40, runs: 1 }, Promotions: { count: 200, runs: 1 } },
      dailyStats: { "2026-09-12": { deleted: 240, archived: 0, freedMb: 15.5, runs: 2 } }
    },
    runHistory: [
      {
        mode: "live",
        action: "delete",
        totalDeleted: 60,
        totalQueries: 1,
        finishedAt: Date.now(),
        perQuery: [
          { query: `from:(${CENSUS.join(" OR ")}) older_than:6m -is:unread`, label: "Senders", count: 60, mode: "live", durationMs: 4000 }
        ]
      }
    ],
    // What 9.6 already takes, so the whole-store sweep below covers the
    // union rather than only the new ground.
    senderCensus: { updatedAt: Date.now(), senders: [{ email: CENSUS[0], count: 40 }] },
    undoLog: [{ id: "u1", runId: "r1", query: `from:(${PURGED[0]}) larger:100k`, tagLabel: "GmailCleaner - Senders", count: 40, action: "delete", timestamp: Date.now() }]
  };
};

describe("the erase reaches the two history stores", () => {
  test("no address held by the top senders list or a stored run query survives", async () => {
    seedHistories();
    expect(await erase()).toEqual(expect.objectContaining({ ok: true }));
    // Serialise everything except the recovery log, which 9.6 kept on
    // purpose and this release still keeps. See the last test.
    const { undoLog, ...rest } = storageBacking.local;
    void undoLog;
    const dump = JSON.stringify(rest);
    for (const address of [...TOP, ...PURGED, ...CENSUS]) {
      expect(dump).not.toContain(address);
    }
  });

  test("the top senders list is empty, not missing, so the Stats page renders its empty state", async () => {
    seedHistories();
    await erase();
    expect(storageBacking.local.cleanupStats.topSenders).toEqual([]);
  });

  test("the lifetime totals, the run rows and the daily buckets survive", async () => {
    seedHistories();
    await erase();
    const stats = storageBacking.local.cleanupStats;
    expect(stats.totalRuns).toBe(12);
    expect(stats.totalDeleted).toBe(4321);
    expect(stats.totalArchived).toBe(12);
    expect(stats.totalFreedMb).toBe(987.6);
    expect(stats.history).toHaveLength(2);
    expect(stats.history[0]).toEqual(expect.objectContaining({ deleted: 40, freedMb: 12.5, intensity: "normal" }));
    expect(stats.categoryBreakdown).toEqual({ Senders: { count: 40, runs: 1 }, Promotions: { count: 200, runs: 1 } });
    expect(stats.dailyStats).toEqual({ "2026-09-12": { deleted: 240, archived: 0, freedMb: 15.5, runs: 2 } });
  });

  test("each history row keeps its per-rule counts and loses only the search string", async () => {
    seedHistories();
    await erase();
    const rows = storageBacking.local.cleanupStats.history;
    expect(rows[0].perQuery).toEqual([{ label: "Senders", count: 40, mode: "live", durationMs: 9000 }]);
    // A row whose query held no address is trimmed the same way: the
    // rule is "history carries no search strings", not "history carries
    // no addresses", because the second rule would need a parser and a
    // parser is a second list of what counts.
    expect(rows[1].perQuery).toEqual([{ label: "Promotions", count: 200, mode: "live", durationMs: 20000 }]);
  });

  test("the engine's own last-ten-runs history is trimmed the same way", async () => {
    seedHistories();
    await erase();
    const runs = storageBacking.local.runHistory;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(expect.objectContaining({ mode: "live", totalDeleted: 60, totalQueries: 1 }));
    expect(runs[0].perQuery).toEqual([{ label: "Senders", count: 60, mode: "live", durationMs: 4000 }]);
  });

  test("the recovery log is still untouched, because Restore reads it", async () => {
    seedHistories();
    const before = JSON.stringify(storageBacking.local.undoLog);
    await erase();
    expect(JSON.stringify(storageBacking.local.undoLog)).toBe(before);
  });

  test("it is still ONE write", async () => {
    seedHistories();
    await erase();
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });

  test("a browser with no history at all is not given one", async () => {
    storageBacking.local = {};
    expect(await erase()).toEqual(expect.objectContaining({ ok: true }));
    expect(storageBacking.local).not.toHaveProperty("cleanupStats");
    expect(storageBacking.local).not.toHaveProperty("runHistory");
  });

  test("a stats object that predates topSenders is left with the same keys it had", async () => {
    storageBacking.local = { cleanupStats: { totalRuns: 1, totalDeleted: 5, history: [] } };
    await erase();
    expect(storageBacking.local.cleanupStats).toEqual({ totalRuns: 1, totalDeleted: 5, history: [], topSenders: [] });
  });
});

describe("what the surfaces say about it", () => {
  test("the Options card names the top senders list and the stored searches", () => {
    const section = OPTIONS_HTML.slice(
      OPTIONS_HTML.indexOf('aria-labelledby="storedDataTitle"'),
      OPTIONS_HTML.indexOf('aria-labelledby="customRulesTitle"')
    ).replace(/\s+/g, " ");
    expect(section.toLowerCase()).toContain("top senders");
    expect(section).toContain("recovery log");
  });

  test("the confirm dialog says the same", () => {
    const body = OPTIONS_JS.slice(
      OPTIONS_JS.indexOf("body: \"This removes everything the extension knows"),
      OPTIONS_JS.indexOf("confirmLabel: \"Erase\"")
    );
    expect(body.toLowerCase()).toContain("top senders");
    // The old exception clause for the history is gone.
    expect(body).not.toContain("or cleanup history");
    expect(body).toContain("recovery log");
  });

  test("the privacy policy no longer lists the cleanup history as surviving", () => {
    const section = PRIVACY.slice(
      PRIVACY.indexOf("**Erasing it yourself.**"),
      PRIVACY.indexOf("**What your browser syncs.**")
    ).replace(/\s+/g, " ");
    expect(section.toLowerCase()).toContain("top senders");
    expect(section).not.toContain("Your cleanup history and your recovery log keep the search queries");
    expect(section).toContain("recovery log");
  });

  test("the Diagnostics card counts the top senders, and still never an address", () => {
    const fn = DIAG_JS.slice(
      DIAG_JS.indexOf("const renderStores = async () =>"),
      DIAG_JS.indexOf("const renderLayoutChangeNotice")
    );
    expect(fn).toContain("cleanupStats");
    expect(fn).toContain("topSenders");
    // A per-entry address field, `.email` or `.sender`; the plural
    // `.senders` is a list whose length is what the card counts.
    expect(fn).not.toMatch(/\.email\b/);
    expect(fn).not.toMatch(/\.sender\b/);
    expect(DIAG_HTML.replace(/\s+/g, " ").toLowerCase()).toContain("top senders");
  });
});
