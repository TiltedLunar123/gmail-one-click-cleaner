/**
 * @jest-environment node
 *
 * Storage X-ray persistence in the service worker (7.2): scan storage
 * with status merge across rescans, and the pending-purge marker that
 * gmailCleanerDone resolves (the popup closes before a purge run
 * finishes, so completion marking has to live here).
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

const SCAN = [
  { email: "big@files.com", name: "Big Files", count: 4, estMb: 100 },
  { email: "news@paper.com", name: "Paper", count: 2, estMb: 20 }
];

describe("message: gmailCleanerStorageScanResult", () => {
  test("persists a cleaned scan with totals", async () => {
    const resp = await dispatch({
      type: "gmailCleanerStorageScanResult",
      senders: SCAN,
      totalMb: 120,
      totalCount: 6
    });
    expect(resp).toHaveBeenCalledWith({ ok: true });

    const stored = storageBacking.local.storageXray;
    expect(stored.totalMb).toBe(120);
    expect(stored.totalCount).toBe(6);
    expect(stored.senders).toHaveLength(2);
    expect(stored.senders[0]).toMatchObject({ email: "big@files.com", estMb: 100, status: "" });
  });

  test("drops junk entries and clamps numbers", async () => {
    await dispatch({
      type: "gmailCleanerStorageScanResult",
      senders: [
        { email: "", count: 1, estMb: 5 },
        { email: "no-at.com", count: 1, estMb: 5 },
        { email: "ok@x.com", count: -3, estMb: "many" }
      ],
      totalMb: -5,
      totalCount: "junk"
    });
    const stored = storageBacking.local.storageXray;
    expect(stored.senders).toHaveLength(1);
    expect(stored.senders[0]).toMatchObject({ email: "ok@x.com", count: 1, estMb: 0 });
    expect(stored.totalMb).toBe(0);
    expect(stored.totalCount).toBe(0);
  });

  test("a rescan keeps earlier purge statuses (union merge)", async () => {
    storageBacking.local.storageXray = {
      updatedAt: 1,
      totalMb: 100,
      totalCount: 4,
      senders: [{ email: "big@files.com", name: "Big", count: 4, estMb: 100, status: "purged", statusAt: 111 }]
    };
    await dispatch({
      type: "gmailCleanerStorageScanResult",
      senders: SCAN,
      totalMb: 120,
      totalCount: 6
    });
    const stored = storageBacking.local.storageXray;
    const big = stored.senders.find((s) => s.email === "big@files.com");
    expect(big.status).toBe("purged");
    expect(big.statusAt).toBe(111);
    expect(stored.senders.find((s) => s.email === "news@paper.com").status).toBe("");
  });
});

describe("message: gmailCleanerGetStorageScan", () => {
  test("returns the stored scan or null", async () => {
    let resp = await dispatch({ type: "gmailCleanerGetStorageScan" });
    expect(resp).toHaveBeenCalledWith({ ok: true, scan: null });

    storageBacking.local.storageXray = { updatedAt: 1, totalMb: 5, totalCount: 1, senders: [] };
    resp = await dispatch({ type: "gmailCleanerGetStorageScan" });
    expect(resp.mock.calls[0][0].scan.totalMb).toBe(5);
  });
});

describe("pending purge lifecycle", () => {
  const seedScan = () => {
    storageBacking.local.storageXray = {
      updatedAt: 1,
      totalMb: 120,
      totalCount: 6,
      senders: SCAN.map((s) => ({ ...s, status: "", statusAt: 0 }))
    };
  };

  test("purgeStarted stores the marker", async () => {
    const resp = await dispatch({
      type: "gmailCleanerStorageXrayPurgeStarted",
      runId: "run-1",
      senders: ["big@files.com"]
    });
    expect(resp).toHaveBeenCalledWith({ ok: true });
    expect(storageBacking.local.storageXrayPendingPurge).toMatchObject({
      runId: "run-1",
      senders: ["big@files.com"]
    });
  });

  test("a matching live done marks the senders purged and consumes the marker", async () => {
    seedScan();
    await dispatch({ type: "gmailCleanerStorageXrayPurgeStarted", runId: "run-1", senders: ["big@files.com"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 12, freedMb: 300, action: "delete", dryRun: false, runId: "run-1" }
    });

    const scan = storageBacking.local.storageXray;
    expect(scan.senders.find((s) => s.email === "big@files.com").status).toBe("purged");
    expect(scan.senders.find((s) => s.email === "news@paper.com").status).toBe("");
    expect(storageBacking.local.storageXrayPendingPurge).toBeNull();
  });

  test("a dry run consumes the marker without marking anything", async () => {
    seedScan();
    await dispatch({ type: "gmailCleanerStorageXrayPurgeStarted", runId: "run-2", senders: ["big@files.com"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 12, dryRun: true, runId: "run-2" }
    });
    expect(storageBacking.local.storageXray.senders[0].status).toBe("");
    expect(storageBacking.local.storageXrayPendingPurge).toBeNull();
  });

  test("a zero-count run consumes the marker without marking", async () => {
    seedScan();
    await dispatch({ type: "gmailCleanerStorageXrayPurgeStarted", runId: "run-3", senders: ["big@files.com"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 0, dryRun: false, runId: "run-3" }
    });
    expect(storageBacking.local.storageXray.senders[0].status).toBe("");
    expect(storageBacking.local.storageXrayPendingPurge).toBeNull();
  });

  test("an unrelated run leaves a fresh marker alone", async () => {
    seedScan();
    await dispatch({ type: "gmailCleanerStorageXrayPurgeStarted", runId: "run-4", senders: ["big@files.com"] });
    await dispatch({
      type: "gmailCleanerDone",
      summary: { count: 5, dryRun: false, runId: "some-other-run" }
    });
    expect(storageBacking.local.storageXrayPendingPurge).toMatchObject({ runId: "run-4" });
    expect(storageBacking.local.storageXray.senders[0].status).toBe("");
  });

  test("ignores markers with no runId or empty sender list", async () => {
    await dispatch({ type: "gmailCleanerStorageXrayPurgeStarted", runId: "", senders: ["a@x.com"] });
    expect(storageBacking.local.storageXrayPendingPurge).toBeUndefined();
    await dispatch({ type: "gmailCleanerStorageXrayPurgeStarted", runId: "run-5", senders: [] });
    expect(storageBacking.local.storageXrayPendingPurge).toBeUndefined();
  });
});
