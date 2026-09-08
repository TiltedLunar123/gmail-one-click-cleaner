/**
 * @jest-environment node
 *
 * 9.6: "Erase Stored Sender Data" left eight stores of sender addresses
 * behind.
 *
 * 9.1 built the control around two stores and four tick lists. The four
 * scans the popup runs each keep their own list of the user's
 * correspondents, by address: the mailbox report holds up to five named
 * senders per band, the storage X-ray and the suggestion scan are lists
 * keyed by address, the subscription scan is two hundred of them, the
 * suggestion feedback map is three hundred with no age-out at all, and
 * the three pending-purge markers name the senders a run is part way
 * through acting on.
 *
 * None of it was hidden. The Diagnostics card said outright that those
 * scans "keep their own sender lists, which this card does not count and
 * the Erase button does not clear", and the confirm dialog said the same
 * thing at more length. That is a control whose own copy explains why it
 * does not do what its label says, which is the shape 9.5 fixed on the
 * word "Freed".
 *
 * The property these pin: after the erase, nothing addressable is left
 * in local storage, and the things that are not mailbox data survive.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WORKER = fs.readFileSync(path.join(ROOT, "background.js"), "utf-8");
const OPTIONS_JS = fs.readFileSync(path.join(ROOT, "options.js"), "utf-8");
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, "options.html"), "utf-8");
const DIAG_HTML = fs.readFileSync(path.join(ROOT, "diagnostics.html"), "utf-8");
const DIAG_JS = fs.readFileSync(path.join(ROOT, "diagnostics.js"), "utf-8");
const POPUP = fs.readFileSync(path.join(ROOT, "popup.js"), "utf-8");

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

// A browser that has run everything the extension offers. Every value
// below is a real address in a real store, written by a real code path.
const ADDRESSES = [
  "newsletter@shop.example", "deals@retail.example", "noreply@bank.example",
  "hr@employer.example", "friend@personal.example", "alerts@social.example",
  "billing@utility.example"
];

const seedEverything = () => {
  storageBacking.local = {
    // 9.1's six.
    senderCensus: { updatedAt: Date.now(), senders: [{ email: ADDRESSES[0], count: 40 }] },
    unsubReceipts: { updatedAt: Date.now(), list: [{ email: ADDRESSES[1], at: Date.now() }] },
    censusCheckedEmails: [ADDRESSES[0]],
    xrayCheckedEmails: [ADDRESSES[2]],
    smartCheckedEmails: [ADDRESSES[3]],
    subsCheckedEmails: [ADDRESSES[4]],
    // The four scans.
    mailboxReport: {
      updatedAt: Date.now(),
      bands: [{ id: "old", count: 10 }],
      topSenders: [{ bandId: "old", senders: [{ email: ADDRESSES[5], name: "Social", count: 9 }] }]
    },
    storageXray: { updatedAt: Date.now(), senders: [{ email: ADDRESSES[2], estMb: 12 }] },
    smartScan: { updatedAt: Date.now(), senders: [{ email: ADDRESSES[3], score: 70 }] },
    subscriptionScan: { updatedAt: Date.now(), senders: [{ email: ADDRESSES[4], count: 3 }] },
    // The feedback map, which is the oldest data in the extension.
    smartFeedback: { bySender: { [ADDRESSES[6]]: { action: "dismissed", at: Date.now() } } },
    // The three markers naming senders a run is mid-way through.
    reportPendingPurge: { runId: "r1", bandIds: ["old"], startedAt: Date.now() },
    storageXrayPendingPurge: { runId: "r1", senders: [ADDRESSES[2]], startedAt: Date.now() },
    smartPendingApply: { runId: "r1", senders: [ADDRESSES[3]], startedAt: Date.now() },

    // Not mailbox data. None of this may be touched.
    whitelist: ["boss@employer.example"],
    protectKeywords: ["invoice"],
    schedules: [{ id: "s1", intervalMinutes: 10080 }],
    notifyOnComplete: true,
    cleanupStats: { totalDeleted: 1234, totalFreedMb: 56 },
    undoLog: [{ id: "u1", tagLabel: "GmailCleaner - Promotions", count: 50, action: "delete" }],
    gccLicenseKey: "GCC1.aaa.bbb"
  };
};

describe("after the erase, nothing addressable is left", () => {
  test("no address written by any scan survives anywhere in local storage", async () => {
    seedEverything();
    expect(await erase()).toEqual(expect.objectContaining({ ok: true }));

    // The whole store, serialised. This is the assertion that cannot be
    // satisfied by remembering to clear six keys: a store added next
    // year and forgotten fails it without anyone updating a list.
    const dump = JSON.stringify(storageBacking.local);
    for (const address of ADDRESSES) {
      expect(dump).not.toContain(address);
    }
  });

  test("each store reads exactly as it does on a browser that never scanned", async () => {
    seedEverything();
    await erase();
    for (const key of [
      "senderCensus", "unsubReceipts", "mailboxReport", "storageXray", "smartScan",
      "subscriptionScan", "smartFeedback", "reportPendingPurge",
      "storageXrayPendingPurge", "smartPendingApply"
    ]) {
      // null, the shape every reader of these already handles, and the
      // shape three of them are ALREADY written as when a purge resolves.
      expect(storageBacking.local[key]).toBeNull();
    }
    for (const key of [
      "censusCheckedEmails", "xrayCheckedEmails", "smartCheckedEmails", "subsCheckedEmails"
    ]) {
      expect(storageBacking.local[key]).toEqual([]);
    }
  });

  test("settings, history and the recovery log are untouched", async () => {
    seedEverything();
    const before = JSON.parse(JSON.stringify({
      whitelist: storageBacking.local.whitelist,
      protectKeywords: storageBacking.local.protectKeywords,
      schedules: storageBacking.local.schedules,
      notifyOnComplete: storageBacking.local.notifyOnComplete,
      cleanupStats: storageBacking.local.cleanupStats,
      undoLog: storageBacking.local.undoLog,
      gccLicenseKey: storageBacking.local.gccLicenseKey
    }));
    await erase();
    for (const [key, value] of Object.entries(before)) {
      expect(storageBacking.local[key]).toEqual(value);
    }
  });

  test("the recovery log surviving is the point, so Restore still works", async () => {
    // A user erasing sender data must not silently give up the mail
    // waiting in Trash. The confirm dialog says so; this is the code
    // saying it.
    seedEverything();
    await erase();
    expect(storageBacking.local.undoLog).toHaveLength(1);
    expect(storageBacking.local.undoLog[0].tagLabel).toBe("GmailCleaner - Promotions");
  });

  test("erasing twice is not an error and leaves the same shapes", async () => {
    seedEverything();
    await erase();
    const first = JSON.stringify(storageBacking.local);
    expect(await erase()).toEqual(expect.objectContaining({ ok: true }));
    expect(JSON.stringify(storageBacking.local)).toBe(first);
  });

  test("erasing an untouched browser writes the neutral shapes rather than throwing", async () => {
    storageBacking.local = {};
    expect(await erase()).toEqual(expect.objectContaining({ ok: true }));
    expect(storageBacking.local.mailboxReport).toBeNull();
    expect(storageBacking.local.smartFeedback).toBeNull();
  });

  test("it is still ONE write, so there is no window where half of it is gone", async () => {
    seedEverything();
    await erase();
    // One set for the erase itself. Counted on the area object that was
    // rebuilt for this test, so nothing earlier is included.
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });
});

describe("what the surfaces say about it", () => {
  test("the confirm dialog no longer lists stores that survive", () => {
    const body = OPTIONS_JS.slice(
      OPTIONS_JS.indexOf("body: \"This removes everything the extension knows"),
      OPTIONS_JS.indexOf("confirmLabel: \"Erase\"")
    );
    expect(body).toContain("mailbox report");
    expect(body).toContain("storage X-ray");
    expect(body).toContain("subscription scan");
    // The clause that used to except them is gone.
    expect(body).not.toContain("does not clear");
    // And the one thing it must still promise survives.
    expect(body).toContain("recovery log");
  });

  test("the Options copy names the scans it now takes", () => {
    const section = OPTIONS_HTML.slice(
      OPTIONS_HTML.indexOf('aria-labelledby="storedDataTitle"'),
      OPTIONS_HTML.indexOf('aria-labelledby="customRulesTitle"')
    );
    for (const phrase of ["mailbox report", "storage X-ray", "subscription scan", "recovery log"]) {
      expect(section).toContain(phrase);
    }
  });

  test("the Diagnostics card counts them instead of excusing itself", () => {
    // Whitespace-normalised: the copy is wrapped in the markup and a
    // sentence that spans two lines is still one sentence.
    const flat = DIAG_HTML.replace(/\s+/g, " ");
    expect(DIAG_HTML).toContain('id="storesScans"');
    expect(flat).toContain("Everything counted here is removed by the Erase button");
    // The sentence that existed because the button under-delivered.
    expect(flat).not.toContain("the Erase button does not clear");
  });

  test("the Diagnostics card still reads counts and never an address", () => {
    const fn = DIAG_JS.slice(
      DIAG_JS.indexOf("const renderStores = async () =>"),
      DIAG_JS.indexOf("const renderLayoutChangeNotice")
    );
    expect(fn).toContain("topSenders");
    // Lengths and sums only. `.email` anywhere in this function would be
    // an address on a page Copy Diagnostics reads.
    expect(fn).not.toContain(".email");
  });

  test("an open popup drops the scan lists as well as the ticks", () => {
    const fn = POPUP.slice(
      POPUP.indexOf("const wireStoreErasureWatch ="),
      POPUP.indexOf("const openChangelog =")
    );
    // Rows on screen built from senders that are no longer stored, with
    // working buttons on them, is the defect this project keeps finding.
    for (const cleared of [
      "state.xray.senders = []",
      "state.smart.senders = []",
      "state.subs.senders = []",
      "state.report.bands = []",
      "state.smart.feedback = { bySender: {} }"
    ]) {
      expect(fn).toContain(cleared);
    }
    expect(fn).toContain("renderReport()");
  });
});

describe("the list cannot drift", () => {
  test("the keys are derived from the values, so there is one enumeration", () => {
    expect(WORKER).toContain("const ERASE_KEYS = Object.freeze(Object.keys(ERASE_VALUES));");
  });

  test("clear() and remove() are still never used", () => {
    // clear() would take notifyOnComplete, runHistory, the recovery log
    // and the licence cache with it: 7.15's restoreDefaults bug at a
    // larger scale.
    const stripped = WORKER.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toContain("storage.local.clear(");
    const eraseFn = WORKER.slice(
      WORKER.indexOf("async function eraseSenderStores("),
      WORKER.indexOf("async function pruneExpiredCensus(")
    );
    expect(eraseFn).not.toContain("remove(");
  });
});
