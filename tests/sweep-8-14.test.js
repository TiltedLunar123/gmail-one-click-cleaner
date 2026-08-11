/**
 * @jest-environment node
 *
 * 8.14 sweep. Six fixes, and the class of defect each one belongs to:
 *
 *   1. Config import counted the FILE and wrote the normalized set, so
 *      an over-cap or partly-unreadable backup dropped entries silently
 *      and still reported success. The whitelist is a safety list, so
 *      those drops unprotect mail. (Shape: a number shown beside an
 *      action, measured through a different filter than the action.)
 *   2. pruneOldStats was the last unlocked get-merge-set in the worker,
 *      on the key recordStats writes through the queue.
 *   3. recordUndoEntry trimmed a Pro user's recovery log to the free cap
 *      whenever a licence or settings read failed for a moment.
 *   4. One-click activation reached storage but no open page, and never
 *      wrote the popup's paint hint.
 *   5. The completion notification's Pro line had no budget at all.
 *   6. Three copies of every string (inline HTML, catalogue, JS
 *      fallback) had drifted apart again; the last test here makes that
 *      class impossible to reintroduce quietly.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf-8");

const BG_SRC = read("background.js");
const OPTIONS_SRC = read("options.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// 1. Config import says what it will actually write
// =====================================================================

function loadOptionsApi() {
  const src = OPTIONS_SRC;
  const body = src.replace(/^\(\(\)\s*=>\s*\{/, "").replace(/\}\)\(\);\s*$/, "");
  const factory = new Function(
    "GCC",
    "chrome",
    "document",
    "window",
    // typeof-guarded so a source that has not learned these yet fails on
    // a readable assertion rather than on a ReferenceError while the
    // factory is still being built. That matters when this file is run
    // against the previous release to prove it catches the defect.
    `${body}\n; const pick = (n, v) => v;` +
    `\n; return {` +
    `  buildImportWriteSet: typeof buildImportWriteSet === "undefined" ? null : buildImportWriteSet,` +
    `  summarizeImport: typeof summarizeImport === "undefined" ? null : summarizeImport,` +
    `  importDroppedLine: typeof importDroppedLine === "undefined" ? null : importDroppedLine,` +
    `  normalizeWhitelist: typeof normalizeWhitelist === "undefined" ? null : normalizeWhitelist,` +
    `  CONFIG: typeof CONFIG === "undefined" ? null : CONFIG` +
    `};`
  );
  const GCC = {
    $: () => null,
    hasChromeStorage: () => false,
    storageGet: async () => ({}),
    storageSet: async () => {},
    clone: (x) => x,
    debounce: (fn) => fn,
    showToast: () => {},
    theme: { init: async () => {}, get: async () => "dark", set: async (v) => v },
    validateGmailQuery: () => ({ valid: true, warnings: [] }),
    license: { PRO: { STORAGE_KEY: "proLicense" }, FEATURES: [] },
    MAX_PROTECT_KEYWORDS: 25,
    sanitizeProtectKeywords: (input) => {
      const arr = Array.isArray(input) ? input : [];
      return arr.filter((s) => typeof s === "string" && s.trim()).slice(0, 25);
    }
  };
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add: () => {} }, appendChild: () => {} })
  };
  const win = { location: { hash: "" }, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) };
  return factory(GCC, { runtime: { lastError: null } }, doc, win);
}

const optionsApi = loadOptionsApi();

const manyWhitelist = (n) => Array.from({ length: n }, (_, i) => `user${i}@example.com`);

describe("config import counts what it will write, not what the file holds", () => {
  test("an over-cap whitelist is reported at the kept figure, and the drop is named", () => {
    // 150 valid addresses, a cap of 100. Before 8.14 the dialog said
    // 150, the write kept 100, and the toast said "imported
    // successfully" -- so 50 senders the user believed were protected
    // were not, and nothing on the page ever said so.
    const json = {
      rules: { normal: ["category:promotions older_than:1y"] },
      whitelist: manyWhitelist(150)
    };
    const writeSet = optionsApi.buildImportWriteSet(json);
    const summary = optionsApi.summarizeImport(json, writeSet);

    const wl = summary.sections.find((s) => s.label === "whitelist entries");
    expect(wl.raw).toBe(150);
    expect(wl.kept).toBe(100);
    expect(wl.dropped).toBe(50);

    expect(summary.dropped).toHaveLength(1);
    expect(optionsApi.importDroppedLine(summary.dropped)).toBe("50 of 150 whitelist entries");
  });

  test("entries the extension cannot read count as drops too", () => {
    // Not only the cap: normalizeWhitelist also filters anything that
    // is not a valid address or domain, which is the same silent loss
    // by another route.
    const json = {
      rules: { normal: ["category:promotions older_than:1y"] },
      whitelist: ["good@example.com", "not an address", "also bad", "fine.com"]
    };
    const summary = optionsApi.summarizeImport(json, optionsApi.buildImportWriteSet(json));
    const wl = summary.sections.find((s) => s.label === "whitelist entries");
    expect(wl.raw).toBe(4);
    expect(wl.kept).toBe(2);
    expect(wl.dropped).toBe(2);
  });

  test("malformed custom rules and schedules are counted as drops", () => {
    const json = {
      rules: { normal: ["category:promotions older_than:1y"] },
      customRules: [{ query: "from:x@y.com" }, { query: "" }, { nope: true }],
      schedules: [{ id: "sched_1" }, { id: "" }, {}]
    };
    const summary = optionsApi.summarizeImport(json, optionsApi.buildImportWriteSet(json));
    const byLabel = Object.fromEntries(summary.sections.map((s) => [s.label, s]));
    expect(byLabel["custom rules"]).toMatchObject({ raw: 3, kept: 1, dropped: 2 });
    expect(byLabel["scheduled cleanups"]).toMatchObject({ raw: 3, kept: 1, dropped: 2 });
  });

  test("a clean backup reports no drops at all", () => {
    const json = {
      rules: { normal: ["category:promotions older_than:1y"] },
      whitelist: ["good@example.com"],
      protectKeywords: ["tax"],
      customRules: [{ query: "from:x@y.com" }],
      schedules: [{ id: "sched_1" }]
    };
    const summary = optionsApi.summarizeImport(json, optionsApi.buildImportWriteSet(json));
    expect(summary.dropped).toEqual([]);
  });

  test("a section absent from the backup is never reported as dropped", () => {
    // A format 1 backup carries no protectKeywords/customRules/schedules
    // and buildImportWriteSet deliberately leaves those keys alone, so
    // "0 of 0" must not read as a loss.
    const json = { rules: { normal: ["category:promotions older_than:1y"] } };
    const summary = optionsApi.summarizeImport(json, optionsApi.buildImportWriteSet(json));
    expect(summary.dropped).toEqual([]);
  });

  test("several drops are listed together", () => {
    const json = {
      rules: { normal: ["category:promotions older_than:1y"] },
      whitelist: manyWhitelist(120),
      schedules: [{ id: "ok" }, {}]
    };
    const summary = optionsApi.summarizeImport(json, optionsApi.buildImportWriteSet(json));
    expect(optionsApi.importDroppedLine(summary.dropped))
      .toBe("20 of 120 whitelist entries, 1 of 2 scheduled cleanups");
  });

  test("the handler builds the write set BEFORE it asks, and quotes it", () => {
    // The whole fix is the ordering: measure the write, then ask about
    // that. The old raw-count locals must be gone, not merely unused.
    const fn = OPTIONS_SRC.slice(
      OPTIONS_SRC.indexOf("const handleImportFile"),
      OPTIONS_SRC.indexOf("// Keyboard Shortcuts")
    );
    expect(fn).toContain("const writeSet = buildImportWriteSet(json);");
    expect(fn).toContain("const summary = summarizeImport(json, writeSet);");
    expect(fn).toContain("summary.sections.map((s) => `• ${s.kept} ${s.label}`)");
    expect(fn).toContain("await safeSyncSet(writeSet, \"imported config\");");
    // The pre-8.14 shape: counting the parsed file.
    expect(fn).not.toMatch(/const whitelistCount = Array\.isArray\(json\.whitelist\)/);
    expect(fn).not.toMatch(/const scheduleCount = Array\.isArray\(json\.schedules\)/);
  });

  test("a drop is said out loud after the import, not only before it", () => {
    const fn = OPTIONS_SRC.slice(
      OPTIONS_SRC.indexOf("const handleImportFile"),
      OPTIONS_SRC.indexOf("// Keyboard Shortcuts")
    );
    // The page the user is looking at now shows the shorter list; a
    // plain success toast would leave that unexplained.
    expect(fn).toMatch(/if \(summary\.dropped\.length\) \{[\s\S]*showToast\([\s\S]*"warning"/);
    expect(fn).toMatch(/Imported, minus \$\{importDroppedLine\(summary\.dropped\)\}/);
  });
});

// =====================================================================
// 2-5. The service worker
// =====================================================================

let INTERNALS;
let storageBacking;
let notifications;
// Areas whose reads should throw, standing in for a storage layer that
// is briefly unavailable.
let failingReads;
// Key -> ms of delay before a get resolves, snapshotting the value at
// CALL time (which is what a real async read does).
let slowReads;

function resetStorage() {
  storageBacking = { local: {}, sync: {}, session: {} };
}

function makeStorageArea(area) {
  return {
    get: async (keys) => {
      if (failingReads.has(area)) throw new Error("storage unavailable");
      const pick = () => {
        if (typeof keys === "string") return { [keys]: storageBacking[area][keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = storageBacking[area][k];
          return out;
        }
        return { ...storageBacking[area] };
      };
      const delay = typeof keys === "string" ? slowReads[keys] : 0;
      if (delay) {
        // Snapshot first, THEN wait: a read that started before another
        // writer must not observe that writer's result.
        const snapshot = JSON.parse(JSON.stringify(pick()));
        await sleep(delay);
        return snapshot;
      }
      return pick();
    },
    set: async (obj) => {
      Object.assign(storageBacking[area], obj);
    }
  };
}

beforeAll(() => {
  resetStorage();
  failingReads = new Set();
  slowReads = {};
  notifications = [];
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      onMessageExternal: { addListener: () => {} },
      sendMessage: async () => { throw new Error("no listener"); },
      getURL: (p) => `chrome-extension://test/${p}`,
      setUninstallURL: () => {},
      lastError: null
    },
    storage: {
      local: makeStorageArea("local"),
      sync: makeStorageArea("sync"),
      session: makeStorageArea("session")
    },
    alarms: {
      create: () => {},
      clear: async () => true,
      getAll: async () => [],
      onAlarm: { addListener: () => {} }
    },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id, url: "https://mail.google.com/mail/u/0/" }),
      sendMessage: async () => ({ ok: true }),
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} }
    },
    scripting: { executeScript: async () => [{ result: null }] },
    notifications: {
      create: (id, opts, cb) => { notifications.push(opts); if (cb) cb(); }
    },
    i18n: { getMessage: () => "" },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} }
  };

  globalThis.GCC_SW_TEST_MODE = true;
  new Function(BG_SRC)();
  INTERNALS = globalThis.GCC_SW_INTERNALS;
});

afterAll(() => {
  delete globalThis.GCC_SW_TEST_MODE;
  delete globalThis.GCC_SW_INTERNALS;
});

beforeEach(() => {
  resetStorage();
  failingReads = new Set();
  slowReads = {};
  notifications = [];
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
});

// ---------------------------------------------------------------------
// 2. pruneOldStats cannot lose a run
// ---------------------------------------------------------------------

describe("the daily stats prune no longer eats a run that finished beside it", () => {
  const seedStats = () => {
    storageBacking.local.cleanupStats = {
      totalRuns: 0,
      totalDeleted: 0,
      totalArchived: 0,
      totalFreedMb: 0,
      history: [],
      categoryBreakdown: {},
      // One bucket old enough to prune, so the prune really does write.
      dailyStats: { "2020-01-01": { deleted: 5, archived: 0, runs: 1 } }
    };
  };

  test("a run recorded while the prune is mid-read survives it", async () => {
    seedStats();
    // The prune's read takes long enough for a whole cleanup to finish
    // and book itself. Unserialized, the prune then writes back the
    // snapshot it took before that happened and the run is gone:
    // counters roll back and the history entry the Stats page hangs
    // that run's Restore button on disappears with them.
    slowReads.cleanupStats = 25;

    const pruning = INTERNALS.pruneOldStats();
    await sleep(5);
    slowReads.cleanupStats = 0;

    // Through the queue, because that is how the worker calls it: the
    // gmailCleanerDone handler wraps recordStats in withStorageLock.
    await INTERNALS.withStorageLock(() => INTERNALS.recordStats({
      deleted: 4000, archived: 0, freedMb: 120, action: "delete", intensity: "normal"
    }));
    await pruning;

    const stats = storageBacking.local.cleanupStats;
    expect(stats.totalRuns).toBe(1);
    expect(stats.totalDeleted).toBe(4000);
    expect(stats.history).toHaveLength(1);
    // And the prune still did its job.
    expect(stats.dailyStats["2020-01-01"]).toBeUndefined();
  });

  test("a prune with nothing to age out performs no write at all", async () => {
    storageBacking.local.cleanupStats = {
      totalRuns: 3, history: [], dailyStats: { "2999-01-01": { deleted: 1 } }
    };
    let writes = 0;
    const realSet = chrome.storage.local.set;
    chrome.storage.local.set = async (obj) => { writes++; return realSet(obj); };
    await INTERNALS.pruneOldStats();
    chrome.storage.local.set = realSet;
    expect(writes).toBe(0);
    expect(storageBacking.local.cleanupStats.totalRuns).toBe(3);
  });

  test("it is inside the queue, like every other writer of this key", () => {
    const fn = BG_SRC.slice(
      BG_SRC.indexOf("async function pruneOldStats()"),
      BG_SRC.indexOf("// Undo / Backup System")
    );
    expect(fn).toContain("await withStorageLock(");
    expect(fn).toContain("if (!removed) return;");
  });
});

// ---------------------------------------------------------------------
// 3. The recovery log is not trimmed on a guess
// ---------------------------------------------------------------------

describe("the recovery log survives a storage layer that blinks", () => {
  const PRO_ENTRIES = 300;

  const seedLog = (n) => {
    storageBacking.local.undoLog = Array.from({ length: n }, (_, i) => ({
      runId: `run_${i}`, timestamp: 1000 + i, count: 1, action: "delete",
      tagLabel: `GmailCleaner/${i}`, query: "category:promotions", passes: 1
    }));
  };

  test("neither storage area readable means the cap is unknown", async () => {
    failingReads = new Set(["sync", "local"]);
    expect(await INTERNALS.readLicenseState()).toBe("unknown");
    expect(await INTERNALS.readUndoLogCap()).toBeNull();
  });

  test("an unknown cap leaves a Pro-sized log alone", async () => {
    // The 8.13 shape: readProSettings answers "free defaults" for any
    // failure, so one storage hiccup trimmed 300 entries to 60, and no
    // later success brought the other 240 back.
    seedLog(PRO_ENTRIES);
    let calls = 0;
    const realGet = chrome.storage.local.get;
    chrome.storage.local.get = async (keys) => {
      calls++;
      // Fail only the licence read, not the undo-log read the writer
      // needs to do its job.
      if (keys === "proLicense") throw new Error("storage unavailable");
      return realGet(keys);
    };
    failingReads = new Set(["sync"]);

    await INTERNALS.recordUndoEntry({
      runId: "run_new", count: 7, action: "delete", tagLabel: "GmailCleaner/new",
      query: "category:promotions", intensity: "normal"
    });

    chrome.storage.local.get = realGet;
    expect(calls).toBeGreaterThan(0);
    // One added, nothing thrown away.
    expect(storageBacking.local.undoLog).toHaveLength(PRO_ENTRIES + 1);
  });

  test("a Pro user whose settings will not load keeps their entries", async () => {
    seedLog(PRO_ENTRIES);
    // Licence resolves (local answers), Pro settings do not.
    const key = "GCC1.stub.stub";
    storageBacking.local.proLicense = key;
    const realVerify = INTERNALS.verifyProLicenseKey;
    expect(typeof realVerify).toBe("function");

    const realSyncGet = chrome.storage.sync.get;
    chrome.storage.sync.get = async (keys) => {
      if (keys === "proSettings") throw new Error("storage unavailable");
      return realSyncGet(keys);
    };
    // With no valid signature the state is "free", which is a KNOWN
    // answer and must still trim -- that is the design, and the point
    // of this test is that only an UNKNOWN answer skips the trim.
    const cap = await INTERNALS.readUndoLogCap();
    chrome.storage.sync.get = realSyncGet;
    expect(cap).toBe(INTERNALS.PRO_SETTINGS_DEFAULTS.undoLogEntries);
  });

  test("a known free user is still capped at 60", async () => {
    expect(await INTERNALS.readLicenseState()).toBe("free");
    expect(await INTERNALS.readUndoLogCap()).toBe(60);

    seedLog(90);
    await INTERNALS.recordUndoEntry({
      runId: "run_new", count: 7, action: "delete", tagLabel: "GmailCleaner/new",
      query: "category:promotions", intensity: "normal"
    });
    expect(storageBacking.local.undoLog).toHaveLength(60);
  });

  test("hasProLicense still fails closed when the state is unknown", async () => {
    failingReads = new Set(["sync", "local"]);
    expect(await INTERNALS.hasProLicense()).toBe(false);
  });

  test("the cap allow-list matches the one readProSettings applies", () => {
    const fn = BG_SRC.slice(
      BG_SRC.indexOf("async function readUndoLogCap()"),
      BG_SRC.indexOf("// The stricter (older) of two Gmail age tokens")
    );
    expect(fn).toContain("PRO_SETTINGS_UNDO_ENTRIES.includes(n)");
    expect(fn).toContain("PRO_SETTINGS_DEFAULTS.undoLogEntries");
    expect(INTERNALS.PRO_SETTINGS_UNDO_ENTRIES).toEqual([60, 150, 300]);
  });
});

// ---------------------------------------------------------------------
// 4. One-click activation reaches the surfaces a buyer is looking at
// ---------------------------------------------------------------------

describe("a buyer who activates from the purchase page sees it everywhere", () => {
  test("activation writes the popup's paint hint", async () => {
    // Not a gate, a paint hint: without it the very first popup a buyer
    // opens, seconds after paying, still flashes padlocks at them.
    const before = storageBacking.local.proActiveHint;
    expect(before).toBeUndefined();

    // An invalid key must NOT set the hint: the hint follows the write,
    // and there is no write.
    const bad = await INTERNALS.activateLicenseFromPage("not-a-key");
    expect(bad.ok).toBe(false);
    expect(storageBacking.local.proActiveHint).toBeUndefined();
  });

  test("the hint write sits after the licence write, never before it", () => {
    const fn = BG_SRC.slice(
      BG_SRC.indexOf("async function activateLicenseFromPage"),
      BG_SRC.indexOf("if (chrome.runtime?.onMessageExternal?.addListener)")
    );
    const verifyAt = fn.indexOf("verifyProLicenseKey(key)");
    const storeAt = fn.indexOf("chrome.storage.sync.set");
    const hintAt = fn.indexOf("PRO_HINT_KEY");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(storeAt);
    expect(storeAt).toBeLessThan(hintAt);
  });

  test("the hint key is spelled the same in the worker and the popup", () => {
    const popupSrc = read("popup.js");
    expect(BG_SRC).toContain('const PRO_HINT_KEY = "proActiveHint";');
    expect(popupSrc).toContain('PRO_HINT: "proActiveHint"');
  });

  test("the options page re-renders when the licence changes underneath it", () => {
    // 8.12 covered activation ON this page. 8.13 added activation from
    // another tab entirely, which this page had no way to notice.
    expect(OPTIONS_SRC).toContain("chrome.storage.onChanged.addListener");
    const fn = OPTIONS_SRC.slice(
      OPTIONS_SRC.indexOf("if (chrome?.storage?.onChanged?.addListener)"),
      OPTIONS_SRC.indexOf("// The popup deep-links here as options.html#pro.")
    );
    expect(fn).toContain("GCC.license.PRO.STORAGE_KEY");
    // Both halves of the card, exactly as the in-page activate handler
    // learned to do in 8.12.
    expect(fn).toContain("renderState()");
    expect(fn).toContain("refreshProSettingsCard()");
  });
});

// ---------------------------------------------------------------------
// 5. The completion notification's Pro line has a budget
// ---------------------------------------------------------------------

describe("the Pro line in the completion notification is bounded", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("it shows on a first qualifying run", () => {
    expect(INTERNALS.shouldPitchProInNotification(undefined, 1000)).toBe(true);
    expect(INTERNALS.shouldPitchProInNotification({}, 1000)).toBe(true);
  });

  test("it stays quiet for a week after each showing", () => {
    const shown = INTERNALS.noteProPitchShown({}, 1000);
    expect(shown.shown).toBe(1);
    expect(INTERNALS.shouldPitchProInNotification(shown, 1000 + DAY)).toBe(false);
    expect(INTERNALS.shouldPitchProInNotification(shown, 1000 + 6 * DAY)).toBe(false);
    expect(INTERNALS.shouldPitchProInNotification(shown, 1000 + 7 * DAY)).toBe(true);
  });

  test("it stops for good after three", () => {
    let seen = {};
    for (let i = 0; i < 3; i++) seen = INTERNALS.noteProPitchShown(seen, 1000 + i * 30 * DAY);
    expect(seen.shown).toBe(3);
    expect(INTERNALS.shouldPitchProInNotification(seen, 1000 + 365 * DAY)).toBe(false);
  });

  test("an unreadable timestamp is treated as never shown, not as forever ago", () => {
    expect(INTERNALS.shouldPitchProInNotification({ shown: 1, lastShownAt: "nonsense" }, 5000)).toBe(true);
  });

  test("the notification books the showing before it raises the toast", () => {
    const fn = BG_SRC.slice(
      BG_SRC.indexOf("async function maybeNotifyDone"),
      BG_SRC.indexOf("// Stats Persistence")
    );
    const setAt = fn.indexOf("[STORAGE_KEYS.PRO_PITCH]: noteProPitchShown(seen)");
    const createAt = fn.indexOf("chrome.notifications.create");
    expect(setAt).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(createAt);
    // The three run-level conditions 8.13 set are still all there.
    expect(fn).toContain("count > 0 && !summary?.dryRun && !(await hasProLicense())");
  });

  test("the allowance is local, never sync", () => {
    // An ad budget is not a preference and has no business replicating.
    const fn = BG_SRC.slice(
      BG_SRC.indexOf("async function maybeNotifyDone"),
      BG_SRC.indexOf("// Stats Persistence")
    );
    expect(fn).toContain("chrome.storage.local.get(STORAGE_KEYS.PRO_PITCH)");
    expect(fn).toContain("chrome.storage.local.set({");
    expect(fn).not.toContain("chrome.storage.sync.set({\n        [STORAGE_KEYS.PRO_PITCH]");
  });
});

// ---------------------------------------------------------------------
// 6. Every string has three copies, and they must agree
// ---------------------------------------------------------------------

describe("inline English, the catalogue and the JS fallback all say the same thing", () => {
  // This has now bitten three releases running (8.12 on the X-ray age
  // copy, 8.13 on xrayUpsellNone, 8.14 on proPromoBody and
  // proPanelLeadDefault). Fixing one copy and leaving the others lying
  // is not a mistake a reviewer reliably catches by reading, so it is
  // checked mechanically here instead.
  const en = JSON.parse(read(path.join("_locales", "en", "messages.json")));
  const PAGES = ["popup.html", "options.html", "progress.html", "stats.html",
    "diagnostics.html", "changelog.html"];
  const SCRIPTS = ["shared.js", "popup.js", "options.js", "progress.js",
    "stats.js", "diagnostics.js", "background.js", "changelog.js"];
  const DOLLAR = "@@DLR@@";
  const decode = (s) => s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·");
  const norm = (s) => decode(String(s)).replace(/\s+/g, " ").trim();

  // A catalogue message with `$$` for a literal dollar and `$1`..`$9`
  // for substitutions, reduced to the words it will actually show.
  const cook = (raw) => {
    const prot = String(raw).split("$$").join(DOLLAR);
    const hasSlots = /\$\d/.test(prot);
    return { text: norm(prot.replace(/\$\d/g, "")).split(DOLLAR).join("$"), hasSlots };
  };

  test("every data-i18n key exists in the catalogue", () => {
    const missing = [];
    for (const p of PAGES) {
      const html = read(p);
      for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
        if (!en[m[1]]) missing.push(`${p}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("no message carries a bare dollar sign", () => {
    // Chrome reads `$1`..`$9` as substitutions, so a literal dollar has
    // to be `$$`. "$9.99" written plainly renders as ".99".
    const bad = [];
    for (const [key, val] of Object.entries(en)) {
      const stripped = String(val.message || "").split("$$").join("").replace(/\$\d/g, "");
      if (stripped.includes("$")) bad.push(key);
    }
    expect(bad).toEqual([]);
  });

  test("inline English matches the catalogue message it stands in for", () => {
    const drift = [];
    for (const p of PAGES) {
      const html = read(p);
      for (const m of html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
        const key = m[1];
        let text = norm(m[2]);
        if (!en[key] || !text) continue;
        const { text: cat, hasSlots } = cook(en[key].message);
        if (hasSlots) text = text.replace(/\$\d/g, "").replace(/\s+/g, " ").trim();
        if (cat !== text) drift.push(`${p} ${key}\n    inline: ${text}\n    catalogue: ${cat}`);
      }
    }
    expect(drift).toEqual([]);
  });

  test("every t()/bgT() fallback matches the catalogue message", () => {
    const drift = [];
    for (const f of SCRIPTS) {
      const src = read(f);
      const re = /\b(?:GCC\.)?(?:bgT|t)\(\s*"([A-Za-z0-9_]+)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
      for (const m of src.matchAll(re)) {
        const key = m[1];
        if (!en[key]) { drift.push(`${f} ${key}: no catalogue entry`); continue; }
        let fallback;
        try { fallback = JSON.parse(`"${m[2]}"`); } catch { continue; }
        const { text: cat, hasSlots } = cook(en[key].message);
        let fb = norm(fallback);
        if (hasSlots) {
          fb = fb.replace(/\$\{[^}]*\}/g, "").replace(/\$\d/g, "").replace(/\s+/g, " ").trim();
        }
        if (cat !== fb) drift.push(`${f} ${key}\n    fallback: ${fb}\n    catalogue: ${cat}`);
      }
    }
    expect(drift).toEqual([]);
  });

  test("the promo strip names every paid feature the list claims", () => {
    // 8.13 added two pillars and left this sentence naming three of
    // them, so the one line a free user actually reads undersold the
    // product by half.
    const body = cook(en.proPromoBody.message).text.toLowerCase();
    for (const word of ["unsubscribe", "purge", "suggestion", "plan", "auto-pilot", "pro settings"]) {
      expect(body).toContain(word);
    }
  });

  test("the Pro feature list still names six things, and Pro Settings names its six knobs", () => {
    const sharedSrc = read("shared.js");
    const list = sharedSrc.slice(
      sharedSrc.indexOf("const PRO_FEATURES = Object.freeze(["),
      sharedSrc.indexOf("const LICENSE_PUBLIC_JWK")
    );
    expect((list.match(/^\s{4}"/gm) || [])).toHaveLength(6);
    for (const knob of ["recovery label", "interval", "age floor", "sweep size", "Smart scan", "recovery log"]) {
      expect(list).toContain(knob);
    }
  });

  test("the free ranked list is still not sold as a Pro feature", () => {
    // 8.13 made the whole Storage X-ray list free. Any copy that goes
    // back to promising it is describing a paywall that is not there.
    expect(cook(en.xrayUpsellNone.message).text).not.toMatch(/full ranked list/i);
    expect(read("popup.html")).not.toContain("unlocks the full ranked list");
  });
});
