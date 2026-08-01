/**
 * @jest-environment node
 *
 * Mailbox Report persistence in the service worker (8.0). Same shape as
 * the Storage X-ray quartet: the engine posts a finished scan, the
 * popup reads it, the popup registers which bands a purge run targets,
 * and gmailCleanerDone resolves that marker because the popup closed
 * long before the run finished.
 *
 * Two things get the heavy coverage. The report is derived from the
 * user's mailbox, so it must never reach chrome.storage.sync (the
 * 7.15.0 stripQueriesForSync precedent). And band ids arrive in a
 * message, so they are checked against a fixed allow-list rather than
 * sanitized: an id is either a band this build knows how to run or it
 * is nothing.
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

const stored = () => storageBacking.local.mailboxReport;
const marker = () => storageBacking.local.reportPendingPurge;

const SCAN = {
  type: "gmailCleanerReportScanResult",
  bands: [
    { id: "sizeHuge", kind: "size", action: "delete", count: 4, estMb: 100 },
    { id: "promotions", kind: "noise", action: "delete", count: 8000, estMb: 0 },
    { id: "inboxOld", kind: "inbox", action: "archive", count: 900, estMb: 0 }
  ],
  cleanableCount: 12000,
  largeMb: 100,
  topSenders: [{ bandId: "promotions", senders: [{ email: "News@Shop.com", name: "Shop", count: 12 }] }]
};

describe("message: gmailCleanerReportScanResult", () => {
  test("persists the report under mailboxReport", async () => {
    const resp = await dispatch(SCAN);
    expect(resp).toHaveBeenCalledWith({ ok: true });

    expect(stored().bands).toHaveLength(3);
    expect(stored().bands[0]).toMatchObject({ id: "sizeHuge", count: 4, estMb: 100, cleanedAt: 0 });
    expect(stored().cleanableCount).toBe(12000);
    expect(stored().largeMb).toBe(100);
    expect(stored().updatedAt).toBeGreaterThan(0);
    expect(stored().topSenders[0].senders[0].email).toBe("news@shop.com");
  });

  test("never writes the report to sync: it is mailbox-derived", async () => {
    await dispatch(SCAN);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(storageBacking.sync).toEqual({});
  });

  test("gmailCleanerGetReport hands back the stored report, or null", async () => {
    let resp = await dispatch({ type: "gmailCleanerGetReport" });
    expect(resp).toHaveBeenCalledWith({ ok: true, report: null });

    await dispatch(SCAN);
    resp = await dispatch({ type: "gmailCleanerGetReport" });
    expect(resp.mock.calls[0][0].report.cleanableCount).toBe(12000);
  });

  test("a payload with no bands array writes nothing", async () => {
    await dispatch({ type: "gmailCleanerReportScanResult", cleanableCount: 5 });
    expect(stored()).toBeUndefined();
    await dispatch({ type: "gmailCleanerReportScanResult", bands: "promotions" });
    expect(stored()).toBeUndefined();
  });
});

describe("band ids are an allow-list, not a sanitizer", () => {
  const KNOWN_IDS = [
    "sizeHuge", "sizeLarge", "sizeBig",
    "promotions", "social", "updates", "forums", "newsletters",
    "inboxAncient", "inboxOld"
  ];

  const ADVERSARIAL = [
    { id: "notABand", count: 5 },
    { id: "promotions OR sizeHuge", count: 5 },
    { id: 'promotions" OR "sizeHuge', count: 5 },
    { id: "(promotions)", count: 5 },
    { id: "{promotions sizeHuge}", count: 5 },
    { id: "promotions ", count: 5 },
    { id: "PROMOTIONS", count: 5 },
    { id: "promotions'", count: 5 },
    { id: 42, count: 5 },
    { id: null, count: 5 },
    { count: 5 }
  ];

  test("a payload of entirely unknown ids writes nothing at all", async () => {
    await dispatch({ type: "gmailCleanerReportScanResult", bands: ADVERSARIAL, cleanableCount: 9 });
    expect(stored()).toBeUndefined();
  });

  test("adversarial ids are dropped and the known ones still land", async () => {
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [...ADVERSARIAL, { id: "social", kind: "noise", action: "delete", count: 7 }]
    });
    expect(stored().bands).toHaveLength(1);
    expect(stored().bands[0].id).toBe("social");
  });

  test("whatever survives is always one of the ten canonical id strings", async () => {
    // The worker string-coerces before the allow-list check, so an id
    // that is not a string but coerces to a band name (["promotions"])
    // is read as that band. The property that has to hold is this one:
    // nothing reaches storage under an id this build cannot run.
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [...ADVERSARIAL, { id: ["promotions"], count: 5 }, { id: "social", count: 7 }]
    });
    for (const band of stored().bands) {
      expect(typeof band.id).toBe("string");
      expect(KNOWN_IDS).toContain(band.id);
    }
  });

  test("a duplicated id is stored once, first occurrence wins", async () => {
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [
        { id: "promotions", kind: "noise", action: "delete", count: 100 },
        { id: "promotions", kind: "noise", action: "delete", count: 999 }
      ]
    });
    expect(stored().bands).toHaveLength(1);
    expect(stored().bands[0].count).toBe(100);
  });

  test("an unknown action is stored as delete, never invented", async () => {
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [
        { id: "promotions", action: "deleteForever", count: 1 },
        { id: "inboxOld", action: "archive", count: 1 }
      ]
    });
    const byId = Object.fromEntries(stored().bands.map((b) => [b.id, b]));
    expect(byId.promotions.action).toBe("delete");
    expect(byId.inboxOld.action).toBe("archive");
  });

  test("a topSenders group for an unknown band is dropped", async () => {
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [{ id: "promotions", count: 5 }],
      topSenders: [
        { bandId: "nope", senders: [{ email: "a@b.com" }] },
        { bandId: "promotions", senders: [{ email: "not-an-email" }, { email: "ok@b.com" }] }
      ]
    });
    expect(stored().topSenders).toHaveLength(1);
    expect(stored().topSenders[0].bandId).toBe("promotions");
    expect(stored().topSenders[0].senders.map((s) => s.email)).toEqual(["ok@b.com"]);
  });
});

describe("counts are clamped", () => {
  test("negative, non-finite, string and absurd counts all come out sane", async () => {
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [
        { id: "sizeHuge", count: -50, estMb: -900 },
        { id: "sizeLarge", count: NaN, estMb: NaN },
        { id: "sizeBig", count: Infinity, estMb: Infinity },
        { id: "promotions", count: "800", estMb: "40" },
        { id: "social", count: "many", estMb: {} },
        { id: "forums", count: 9e18, estMb: 9e18 },
        { id: "updates", count: 12.7, estMb: 12.7 }
      ],
      cleanableCount: -5,
      largeMb: Infinity
    });

    const byId = Object.fromEntries(stored().bands.map((b) => [b.id, b]));
    expect(byId.sizeHuge).toMatchObject({ count: 0, estMb: 0 });
    expect(byId.sizeLarge).toMatchObject({ count: 0, estMb: 0 });
    expect(byId.promotions).toMatchObject({ count: 800, estMb: 40 });
    expect(byId.social).toMatchObject({ count: 0, estMb: 0 });
    expect(byId.updates).toMatchObject({ count: 12, estMb: 12 });
    // An absurd but finite number lands on the ceiling rather than
    // overflowing the popup's number formatting. Infinity does NOT: it
    // goes to zero, because the report's whole copy promises its
    // figures are conservative and "at least 10,000,000 MB" from one
    // malformed message would be a lie the UI states in bold. The
    // shared clamp in GCC.report makes the same choice; a disagreement
    // between the two is the bug this pins.
    expect(byId.forums).toMatchObject({ count: 10000000, estMb: 10000000 });
    expect(byId.sizeBig).toMatchObject({ count: 0, estMb: 0 });

    expect(stored().cleanableCount).toBe(0);
    expect(stored().largeMb).toBe(0);

    // The invariant that actually matters: every stored number is a
    // finite non-negative integer inside the ceiling, whatever arrived.
    for (const band of stored().bands) {
      expect(Number.isInteger(band.count)).toBe(true);
      expect(band.count).toBeGreaterThanOrEqual(0);
      expect(band.count).toBeLessThanOrEqual(10000000);
      expect(Number.isInteger(band.estMb)).toBe(true);
      expect(band.estMb).toBeGreaterThanOrEqual(0);
      expect(band.estMb).toBeLessThanOrEqual(10000000);
    }
  });

  test("the top-level totals are clamped the same way", async () => {
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [{ id: "promotions", count: 1 }],
      cleanableCount: "4000",
      largeMb: -3
    });
    expect(stored().cleanableCount).toBe(4000);
    expect(stored().largeMb).toBe(0);

    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [{ id: "promotions", count: 1 }],
      cleanableCount: NaN,
      largeMb: "junk"
    });
    expect(stored().cleanableCount).toBe(0);
    expect(stored().largeMb).toBe(0);
  });
});

describe("a rescan", () => {
  const seedCleaned = () => {
    storageBacking.local.mailboxReport = {
      updatedAt: 1,
      cleanableCount: 20000,
      largeMb: 400,
      topSenders: [],
      bands: [
        { id: "sizeHuge", kind: "size", action: "delete", count: 90, estMb: 2250, cleanedAt: 111 },
        { id: "promotions", kind: "noise", action: "delete", count: 20000, estMb: 0, cleanedAt: 0 }
      ]
    };
  };

  test("replaces the counts but keeps the cleanedAt marks", async () => {
    seedCleaned();
    await dispatch(SCAN);

    const byId = Object.fromEntries(stored().bands.map((b) => [b.id, b]));
    expect(byId.sizeHuge.count).toBe(4);
    expect(byId.sizeHuge.cleanedAt).toBe(111);
    expect(byId.promotions.count).toBe(8000);
    expect(byId.promotions.cleanedAt).toBe(0);
    // A band the previous report never held starts unmarked.
    expect(byId.inboxOld.cleanedAt).toBe(0);
  });

  test("a band that drops out of the new scan simply goes", async () => {
    seedCleaned();
    await dispatch({
      type: "gmailCleanerReportScanResult",
      bands: [{ id: "promotions", kind: "noise", action: "delete", count: 3 }]
    });
    expect(stored().bands.map((b) => b.id)).toEqual(["promotions"]);
  });
});

describe("pending band purge lifecycle", () => {
  const seedReport = () => {
    storageBacking.local.mailboxReport = {
      updatedAt: 1,
      cleanableCount: 12000,
      largeMb: 100,
      topSenders: [],
      bands: [
        { id: "promotions", kind: "noise", action: "delete", count: 8000, estMb: 0, cleanedAt: 0 },
        { id: "social", kind: "noise", action: "delete", count: 3000, estMb: 0, cleanedAt: 0 }
      ]
    };
  };

  test("purgeStarted stores the marker", async () => {
    const resp = await dispatch({
      type: "gmailCleanerReportPurgeStarted",
      runId: "run-1",
      bandIds: ["promotions"]
    });
    expect(resp).toHaveBeenCalledWith({ ok: true });
    expect(marker()).toMatchObject({ runId: "run-1", bandIds: ["promotions"] });
    expect(marker().startedAt).toBeGreaterThan(0);
  });

  test("refuses an empty runId, an empty list, and an all-unknown list", async () => {
    await dispatch({ type: "gmailCleanerReportPurgeStarted", runId: "", bandIds: ["promotions"] });
    expect(marker()).toBeUndefined();

    await dispatch({ type: "gmailCleanerReportPurgeStarted", runId: "run-2", bandIds: [] });
    expect(marker()).toBeUndefined();

    await dispatch({
      type: "gmailCleanerReportPurgeStarted",
      runId: "run-3",
      bandIds: ["nope", "promotions OR social", 42, null]
    });
    expect(marker()).toBeUndefined();

    await dispatch({ type: "gmailCleanerReportPurgeStarted", runId: "run-4", bandIds: "promotions" });
    expect(marker()).toBeUndefined();
  });

  test("keeps only the known ids out of a mixed list", async () => {
    await dispatch({
      type: "gmailCleanerReportPurgeStarted",
      runId: "run-5",
      bandIds: ["nope", "social", 7, "sizeHuge"]
    });
    expect(marker().bandIds).toEqual(["social", "sizeHuge"]);
  });

  test("a multi-step plan marks NOTHING, because one count cannot prove each step ran", async () => {
    // The engine reports a single aggregate count for the whole run, so
    // a plan that dies after its first step would otherwise show every
    // step it INTENDED to run as cleared, and a rescan preserves those
    // marks. Only a single-step run can honestly claim completion; for
    // a plan the rescan's fresh counts are the truth.
    seedReport();
    await dispatch({
      type: "gmailCleanerReportPurgeStarted",
      runId: "plan-1",
      bandIds: ["promotions", "social"]
    });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { runId: "plan-1", dryRun: false, count: 200 }
    });

    // The marker is still consumed: it belonged to this run.
    expect(marker()).toBeNull();
    for (const band of stored().bands) {
      expect(band.cleanedAt).toBe(0);
    }
  });

  test("a matching live done marks those bands and consumes the marker", async () => {
    seedReport();
    await dispatch({ type: "gmailCleanerReportPurgeStarted", runId: "run-1", bandIds: ["promotions"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 4200, freedMb: 300, action: "delete", dryRun: false, runId: "run-1" }
    });

    const byId = Object.fromEntries(stored().bands.map((b) => [b.id, b]));
    expect(byId.promotions.cleanedAt).toBeGreaterThan(0);
    expect(byId.social.cleanedAt).toBe(0);
    expect(marker()).toBeNull();
  });

  test("a dry run consumes the marker without marking anything", async () => {
    seedReport();
    await dispatch({ type: "gmailCleanerReportPurgeStarted", runId: "run-2", bandIds: ["promotions"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 8000, dryRun: true, runId: "run-2" }
    });
    expect(stored().bands.every((b) => b.cleanedAt === 0)).toBe(true);
    expect(marker()).toBeNull();
  });

  test("a run that moved nothing consumes the marker without marking", async () => {
    seedReport();
    await dispatch({ type: "gmailCleanerReportPurgeStarted", runId: "run-3", bandIds: ["promotions"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 0, dryRun: false, runId: "run-3" }
    });
    expect(stored().bands.every((b) => b.cleanedAt === 0)).toBe(true);
    expect(marker()).toBeNull();
  });

  test("an unrelated run leaves a fresh marker alone", async () => {
    seedReport();
    await dispatch({ type: "gmailCleanerReportPurgeStarted", runId: "run-4", bandIds: ["promotions"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 500, dryRun: false, runId: "some-other-run" }
    });
    expect(marker()).toMatchObject({ runId: "run-4" });
    expect(stored().bands.every((b) => b.cleanedAt === 0)).toBe(true);
  });

  test("an unrelated run clears a marker past the 2h TTL", async () => {
    seedReport();
    storageBacking.local.reportPendingPurge = {
      runId: "run-old",
      bandIds: ["promotions"],
      startedAt: Date.now() - (2 * 60 * 60 * 1000 + 60 * 1000)
    };
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 500, dryRun: false, runId: "some-other-run" }
    });
    expect(marker()).toBeNull();
    // Clearing a stale marker is not the same as crediting the bands.
    expect(stored().bands.every((b) => b.cleanedAt === 0)).toBe(true);
  });

  test("a done with no marker at all changes nothing", async () => {
    seedReport();
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 500, dryRun: false, runId: "run-x" }
    });
    expect(marker()).toBeUndefined();
    expect(stored().bands.every((b) => b.cleanedAt === 0)).toBe(true);
  });

  test("a marked band survives the next rescan", async () => {
    seedReport();
    await dispatch({ type: "gmailCleanerReportPurgeStarted", runId: "run-6", bandIds: ["promotions"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 4200, dryRun: false, runId: "run-6" }
    });
    const cleanedAt = stored().bands.find((b) => b.id === "promotions").cleanedAt;
    expect(cleanedAt).toBeGreaterThan(0);

    await dispatch(SCAN);
    expect(stored().bands.find((b) => b.id === "promotions").cleanedAt).toBe(cleanedAt);
    expect(stored().bands.find((b) => b.id === "promotions").count).toBe(8000);
  });
});
