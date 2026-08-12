/**
 * @jest-environment node
 *
 * 8.15 sweep. The defects, grouped by the class each belongs to:
 *
 *   1. A read that FAILED was treated as a read that found nothing. The
 *      popup's whitelist and protected-keyword reads answered a rejected
 *      storage call with [], so a cleanup ran with no safety exclusions
 *      at all and reported an ordinary success. Same shape as 8.14's
 *      recovery-log trim, one layer up.
 *   2. A Pro setting that was a silent no-op above its default: choosing
 *      50 senders per Auto-Pilot sweep picked 50 and built rules for 25.
 *   3. Two run-scoping holes. The progress dashboard accepted engine
 *      messages from ANY Gmail tab, and the popup's account picker
 *      highlighted a mailbox that was not the one a run would touch.
 *   4. Marks that outlived what they described: a report step stayed
 *      "Cleared" forever after a partial run, and the post-run recap
 *      inferred an archive run's action from counts that are zero.
 *   5. A write that skipped the step its own save path performs: an
 *      imported schedule never armed an alarm.
 *   6. Two release-gate assertions that could not fail.
 *
 * Every behavioural assertion here fails on 8.14.0.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf-8");

const BG_SRC = read("background.js");
const POPUP_SRC = read("popup.js");
const PROGRESS_SRC = read("progress.js");
const OPTIONS_SRC = read("options.js");
const STATS_SRC = read("stats.js");
const ENGINE_SRC = read("contentScript.js");
const SHARED_SRC = read("shared.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A source slice between two anchors, so a pin is about the code in one
// function rather than about the whole file.
//
// It returns "" rather than asserting when an anchor is missing, and
// that is deliberate: these slices are taken at collection time, so an
// assertion here would abort the whole file with "0 total" when the
// suite is run against the previous release to prove it catches the
// defect. An empty slice fails each individual pin instead, which is
// the readable outcome.
const bodyOf = (src, startNeedle, endNeedle) => {
  const start = src.indexOf(startNeedle);
  if (start === -1) return "";
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  if (end <= start) return "";
  return src.slice(start, end);
};

// =====================================================================
// 1. The safety lists refuse to guess
// =====================================================================
//
// popup.js is an IIFE bound to DOMContentLoaded, so this section pins
// the source. The behavioural half lives in the jsdom section further
// down, which boots the real popup with a failing sync read and checks
// that no engine is injected.

describe("an unreadable safety list stops the run instead of emptying it", () => {
  const whitelistFn = bodyOf(POPUP_SRC, "const getWhitelist = async", "const getProtectKeywords");
  const keywordsFn = bodyOf(POPUP_SRC, "const getProtectKeywords = async", "// Thrown by buildConfig");

  test("both readers answer null when storage could not be read", () => {
    for (const fn of [whitelistFn, keywordsFn]) {
      expect(fn).toMatch(/if \(!read\.ok\) return null;/);
    }
  });

  test("neither reader goes through the swallowing wrapper any more", () => {
    // storageGet catches, logs and returns {}, which is the exact step
    // that turned "could not read" into "nothing is protected".
    for (const fn of [whitelistFn, keywordsFn]) {
      expect(fn).not.toContain("storageGet(");
    }
  });

  test("buildConfig refuses rather than injecting an empty whitelist", () => {
    const fn = bodyOf(POPUP_SRC, "const buildConfig = async", "// 8.5: the guard half");
    expect(fn).toMatch(/whitelist === null \|\| protectKeywords === null/);
    expect(fn).toContain("throw guardsUnreadableError()");
  });

  test("buildScanGuards refuses on the same terms", () => {
    // The scans predict the purge. A scan that quietly dropped the
    // exclusions would over-count in the direction that makes the purge
    // beside it look right, so the parity surface could not catch it.
    const fn = bodyOf(POPUP_SRC, "const buildScanGuards = async", "// =========================");
    expect(fn).toMatch(/whitelist === null \|\| protectKeywords === null/);
    expect(fn).toContain("throw guardsUnreadableError()");
  });

  test("the suggestion cards keep the last known lists rather than clearing them", () => {
    const fn = bodyOf(POPUP_SRC, "const loadStoredSmartScan = async", "const buildSmartKnownSenders");
    expect(fn).toMatch(/if \(wl !== null\) state\.smart\.whitelist = wl;/);
    expect(fn).toMatch(/if \(pk !== null\) state\.smart\.protectKeywords = pk;/);
  });

  test("the refusal is a catalogue message, in all seven locales", () => {
    for (const loc of ["en", "de", "es", "fr", "ja", "pt_BR", "ru"]) {
      const cat = JSON.parse(read(path.join("_locales", loc, "messages.json")));
      expect(typeof cat.guardsUnreadable?.message).toBe("string");
      expect(cat.guardsUnreadable.message.length).toBeGreaterThan(10);
    }
    // CRLF, so anchor on the call rather than on a literal newline.
    expect(POPUP_SRC).toMatch(/t\(\s*"guardsUnreadable"/);
  });
});

// =====================================================================
// 2 and 5. Worker: the Auto-Pilot cap, the imported schedule's alarm,
//          the report mark, and the stale enabled flag
// =====================================================================

let INTERNALS;
let storageBacking;
let alarmsCreated;
let dispatchMessage;

const makeStorageArea = (name) => ({
  get: async (keys) => {
    const store = storageBacking[name];
    const out = {};
    const list = keys === null || keys === undefined
      ? Object.keys(store)
      : (Array.isArray(keys) ? keys : [keys]);
    for (const k of list) if (k in store) out[k] = store[k];
    return out;
  },
  set: async (obj) => { Object.assign(storageBacking[name], obj); },
  remove: async (keys) => {
    for (const k of (Array.isArray(keys) ? keys : [keys])) delete storageBacking[name][k];
  }
});

const resetStorage = () => {
  storageBacking = { local: {}, sync: {}, session: {} };
  alarmsCreated = [];
};

beforeAll(() => {
  resetStorage();

  const listeners = [];
  globalThis.chrome = {
    runtime: {
      id: "test",
      lastError: null,
      getManifest: () => ({ version: "8.15.0" }),
      getURL: (p) => `chrome-extension://test/${p}`,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onMessageExternal: { addListener: () => {} },
      onSuspend: { addListener: () => {} },
      sendMessage: async () => ({ ok: true })
    },
    storage: {
      local: makeStorageArea("local"),
      sync: makeStorageArea("sync"),
      session: makeStorageArea("session"),
      onChanged: { addListener: () => {} }
    },
    alarms: {
      create: (name, info) => { alarmsCreated.push({ name, info }); },
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
    notifications: { create: (id, opts, cb) => { if (cb) cb(); } },
    i18n: { getMessage: () => "" },
    management: { getSelf: async () => ({ installType: "normal" }) },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} }
  };

  globalThis.GCC_SW_TEST_MODE = true;
  // eslint-disable-next-line no-new-func
  new Function(BG_SRC)();
  INTERNALS = globalThis.GCC_SW_INTERNALS;

  // The router validates the sender, so this has to look like an
  // extension page (Options is what sends the message under test).
  dispatchMessage = (msg) => new Promise((resolve) => {
    let answered = false;
    const respond = (r) => { answered = true; resolve(r); };
    for (const fn of listeners) fn(msg, { id: "test" }, respond);
    // A router case that never answers resolves undefined rather than
    // hanging the suite.
    setTimeout(() => { if (!answered) resolve(undefined); }, 200);
  });
});

afterAll(() => {
  delete globalThis.GCC_SW_TEST_MODE;
  delete globalThis.GCC_SW_INTERNALS;
});

beforeEach(() => {
  resetStorage();
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
});

const senders = (n) => Array.from({ length: n }, (_, i) => `sender${i}@example.com`);
const addressesIn = (rules) => rules
  .flatMap((r) => (r.match(/from:\(([^)]*)\)/)?.[1] || "").split(" OR "))
  .map((s) => s.trim())
  .filter(Boolean);

describe("the Auto-Pilot sender cap is the number the user picked", () => {
  test("50 senders per sweep really builds rules for 50", () => {
    // The picker learned the Pro setting in 8.13 and the rule builder
    // did not, so the 50 option cleared exactly what 25 cleared and the
    // other 25 senders were dropped with nothing reporting it.
    const rules = INTERNALS.autoPilotBuildRules(senders(50), 50);
    expect(addressesIn(rules)).toHaveLength(50);
  });

  test("10 still means 10", () => {
    expect(addressesIn(INTERNALS.autoPilotBuildRules(senders(50), 10))).toHaveLength(10);
  });

  test("no cap still means 25, which is what keeps parity with the popup's bulk apply", () => {
    expect(addressesIn(INTERNALS.autoPilotBuildRules(senders(50)))).toHaveLength(25);
  });

  test("a cap outside the allow-list falls back to 25 rather than being trusted", () => {
    // This number decides how much mail an unattended run touches and it
    // arrives from storage, so it is clamped, not believed.
    for (const bogus of [500, -1, "all", null]) {
      expect(addressesIn(INTERNALS.autoPilotBuildRules(senders(50), bogus))).toHaveLength(25);
    }
  });

  test("the applied-feedback marker covers the senders the sweep really swept", async () => {
    await INTERNALS.recordPendingSmartApply("run-cap", senders(40), 50);
    expect(storageBacking.local.smartPendingApply.senders).toHaveLength(40);
  });

  test("the marker still defaults to 25 for the popup's own bulk apply", async () => {
    await INTERNALS.recordPendingSmartApply("run-popup", senders(40));
    expect(storageBacking.local.smartPendingApply.senders).toHaveLength(25);
  });
});

describe("an imported schedule arms its alarm", () => {
  test("the worker answers a schedules-replaced message by re-arming", async () => {
    storageBacking.sync.schedules = [
      { id: "sched_import", enabled: true, intervalMinutes: 10080, intensity: "light", minAge: "3m" }
    ];
    const resp = await dispatchMessage({ type: "gmailCleanerSchedulesReplaced" });
    expect(resp).toEqual({ ok: true });
    expect(alarmsCreated.map((a) => a.name)).toContain("gcc_schedule_sched_import");
  });

  test("options sends it after the import write, and repaints the list", () => {
    const fn = bodyOf(OPTIONS_SRC, 'await safeSyncSet(writeSet, "imported config")', "await loadData();");
    expect(fn).toContain('type: "gmailCleanerSchedulesReplaced"');
    expect(fn).toContain("await renderSchedules();");
    // Only when the file actually carried schedules: a format 1 backup
    // has no schedules key and must not re-arm anything.
    expect(fn).toContain("STORAGE_KEYS.SCHEDULES");
  });
});

describe("Auto-Pilot re-reads the switch before it arms a sweep", () => {
  test("the enabled flag is read again after the awaited gauntlet", () => {
    const fn = bodyOf(BG_SRC, "async function runAutoPilot(", "async function startAutoPilotApply(");
    const reread = fn.indexOf("const freshConfig = await getAutoPilotConfig();");
    const arm = fn.indexOf('stage: "scan"');
    expect(reread).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(reread);
    expect(fn.slice(reread, arm)).toContain("if (!freshConfig.enabled)");
  });
});

// =====================================================================
// 3. Run scoping
// =====================================================================

describe("the progress dashboard only listens to its own Gmail tab", () => {
  test("the listener takes the sender and checks it before handling", () => {
    const listener = bodyOf(PROGRESS_SRC, "chrome.runtime.onMessage.addListener(", "wireEventListeners");
    expect(listener).toMatch(/addListener\(\(msg, sender\) =>/);
    expect(listener).toContain("if (!isMessageForThisRun(sender)) return;");
  });

  test("ownership is the sending tab, and a message with no tab is refused", () => {
    const fn = bodyOf(PROGRESS_SRC, "const isMessageForThisRun =", "const handleProgressMessage =");
    expect(fn).toContain("return from === gmailTabId;");
    expect(fn).toMatch(/if \(typeof from !== "number"\) return false;/);
  });
});

describe("auto-reconnect will not start a run this page never saw", () => {
  test("re-injection sits behind evidence that a run reported here", () => {
    const tick = bodyOf(PROGRESS_SRC, "const autoReconnectTick = async", "const startAutoReconnect");
    const guard = tick.indexOf("if (!state.sawRunEvidence)");
    const inject = tick.indexOf('files: ["contentScript.js"]');
    expect(guard).toBeGreaterThan(-1);
    expect(inject).toBeGreaterThan(guard);
  });

  test("an accepted engine message is what sets the evidence", () => {
    const fn = bodyOf(PROGRESS_SRC, "const handleProgressMessage =", "// Review request");
    expect(fn).toContain("state.sawRunEvidence = true;");
  });

  test("every successful reset stops the poller and marks the run over", () => {
    const fn = bodyOf(PROGRESS_SRC, "const handleResetStuckRun = async", "const handleReinject");
    // Reset clears the in-page attach flag, which is exactly the signal
    // auto-reconnect reads as "the engine is gone, put it back".
    const successes = fn.split("markRunOver();").length - 1;
    expect(successes).toBe(3);
    // The one branch that must NOT stop: cancel landed but the engine
    // has not stopped yet, so the run is still live.
    const stillRunning = fn.slice(fn.indexOf("if (forced.stillRunning)"));
    expect(stillRunning.slice(0, stillRunning.indexOf("return;"))).not.toContain("markRunOver");
  });

  test("markRunOver does both halves", () => {
    const fn = bodyOf(PROGRESS_SRC, "const markRunOver = () =>", "// Is the engine still in that tab?");
    expect(fn).toContain("state.done = true;");
    expect(fn).toContain("stopAutoReconnect();");
  });
});

describe("the account picker names the mailbox a run will touch", () => {
  test("the highlight is derived from the resolved tab, not from list position", () => {
    const fn = bodyOf(POPUP_SRC, "const loadGmailAccounts = async", "// 7.12: no Gmail tab is not");
    expect(fn).not.toContain('(idx === 0 ? " active" : "")');
    expect(fn).toContain("const defaultTab = tabs.find((t) => t.active) || tabs[0];");
    expect(fn).toContain('(tab.id === state.selectedGmailTabId ? " active" : "")');
  });

  test("the pick is its own field, so a terminal message cannot wipe it", () => {
    // state.currentGmailTabId is the live run's tab handle and the done,
    // error and cancelled handlers null it, including for a schedule or
    // an Auto-Pilot sweep this popup never started.
    expect(POPUP_SRC).toContain("selectedGmailTabId: null,");
    const finder = bodyOf(POPUP_SRC, "const findGmailTab = async", "// =========================");
    expect(finder).toContain("state.selectedGmailTabId ?? state.currentGmailTabId");
    const clears = POPUP_SRC.split("state.selectedGmailTabId = null").length - 1;
    expect(clears).toBe(0);
  });
});

// =====================================================================
// 4. Marks that outlive what they describe
// =====================================================================

describe("a report step that still has mail in it keeps its Run button", () => {
  test("the mark is only carried forward when the rescan finds the band empty", () => {
    const fn = bodyOf(BG_SRC, "const prevCleaned = Object.create(null);", "const topSenders = [];");
    expect(fn).toContain("if (band.measured !== false && band.count > 0) continue;");
  });
});

describe("the post-run recap reads the action the run recorded", () => {
  // Loaded the way the other shared suites do: shared.js is an IIFE that
  // assigns a lexical const, so it is evaluated and the namespace handed
  // back out.
  const loadShared = () => {
    // eslint-disable-next-line no-new-func
    return new Function(`${SHARED_SRC}; return GCC;`)();
  };
  const GCC = loadShared();

  test("an archive run that moved nothing is still an archive run", () => {
    // archived is a COUNT. Inferring the action from it filed every
    // archive run that moved zero messages under Trash, so the recap
    // said "all moved to Trash" and "nothing permanently deleted, Gmail
    // keeps Trash for 30 days" about mail that was never deleted, and
    // un-suppressed the freed-MB clause 8.9 hid for archive runs.
    expect(GCC.popupUi.recapAction({ action: "archive", archived: 0, deleted: 0 })).toBe("archive");
  });

  test("a delete run that moved nothing is still a delete run", () => {
    expect(GCC.popupUi.recapAction({ action: "delete", archived: 0, deleted: 0 })).toBe("trash");
  });

  test("the recorded action beats the counts when they disagree", () => {
    expect(GCC.popupUi.recapAction({ action: "archive", archived: 3, deleted: 7 })).toBe("archive");
  });

  test("entries written before 8.7 carry no action and keep the old inference", () => {
    expect(GCC.popupUi.recapAction({ archived: 12, deleted: 0 })).toBe("archive");
    expect(GCC.popupUi.recapAction({ archived: 0, deleted: 0 })).toBe("trash");
  });
});

// =====================================================================
// 6. Two release-gate assertions that could not fail
// =====================================================================

describe("the licence activation path is tested on a key that verifies", () => {
  const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

  const makeKeypair = async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
    );
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    return { pair, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  };

  const mintTestKey = async (pair) => {
    const payload = b64url(Buffer.from(JSON.stringify({ v: 1, plan: "pro", sid: "s", iat: 1 }), "utf8"));
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload)
    );
    return `GCC1.${payload}.${b64url(new Uint8Array(sig))}`;
  };

  test("a valid key lands in both storage areas and writes the paint hint", async () => {
    // The only existing call passed "not-a-key", which returns at the
    // verify gate, so every line after it was uncovered: the local
    // mirror and the hint could both regress with the suite green.
    const { pair, jwk } = await makeKeypair();
    INTERNALS.setTestLicenseJwk(jwk);
    const key = await mintTestKey(pair);

    const result = await INTERNALS.activateLicenseFromPage(key);
    expect(result.ok).toBe(true);

    expect(storageBacking.sync.proLicense).toBe(key);
    expect(storageBacking.local.proLicense).toBe(key);
    // The hint is what stops a buyer seeing padlocks on the first popup
    // they open after paying.
    expect(storageBacking.local.proActiveHint).toBe(true);
  });

  test("a key that does not verify is still refused", async () => {
    const { jwk } = await makeKeypair();
    INTERNALS.setTestLicenseJwk(jwk);
    const result = await INTERNALS.activateLicenseFromPage("not-a-key");
    expect(result).toEqual({ ok: false, error: "invalid_key" });
    expect(storageBacking.sync.proLicense).toBeUndefined();
    expect(storageBacking.local.proActiveHint).toBeUndefined();
  });
});

describe("the announced-version gate can fail", () => {
  test("every page expected to announce a version really carries one", () => {
    // The loop in version.test.js iterated an empty match list for three
    // of its six files, so those cases asserted nothing, and the one
    // page the loop was written for could be reworded without failing.
    const versionTest = read(path.join("tests", "version.test.js"));
    expect(versionTest).toContain("ANNOUNCE_VERSION");
    expect(versionTest).toMatch(/expect\(announced\.length\)\.toBeGreaterThan\(0\)/);
  });
});

// =====================================================================
// Quality of life
// =====================================================================

describe("rule labels name the two runs that used to be Other", () => {
  // The engine is one big IIFE, so the two blocks under test are lifted
  // out and evaluated on their own, the way the min-age suite does it.
  const MAP_RE = /const\s+QUERY_LABEL_MAP\s*=\s*Object\.freeze\(\[[\s\S]*?\]\);/;
  const FN_RE = /function\s+labelQuery\s*\(query\)\s*\{[\s\S]*?\n\s\s\}/;

  const mapBlock = ENGINE_SRC.match(MAP_RE);
  const fnBlock = ENGINE_SRC.match(FN_RE);

  // Same rule as bodyOf: never abort collection. A missing block fails
  // every pin below with a readable message.
  const labelQuery = mapBlock && fnBlock
    // eslint-disable-next-line no-new-func
    ? new Function(`${mapBlock[0]}\n${fnBlock[0]}\nreturn labelQuery;`)()
    : () => "(label blocks not found in contentScript.js)";

  test("the report's inbox steps are labelled Inbox", () => {
    expect(labelQuery("in:inbox older_than:1y")).toBe("Inbox");
  });

  test("a sender-scoped run is labelled Senders", () => {
    // Smart apply, an Auto-Pilot sweep and a Storage X-ray purge all
    // build this shape. The label is the Gmail label the mail is tagged
    // with, the heading in the recovery log and the Stats category.
    expect(labelQuery("from:(a@x.com OR b@y.com) older_than:6m")).toBe("Senders");
  });

  test("nothing that already had a label changed", () => {
    // The two entries were appended, not inserted, so every query that
    // matched one of the seven original patterns still matches it first.
    // This half is the load-bearing half.
    expect(labelQuery("has:attachment larger:10M older_than:6m")).toBe("Big attachments");
    expect(labelQuery("category:promotions older_than:6m")).toBe("Promotions");
    expect(labelQuery("category:social older_than:1y")).toBe("Social");
    expect(labelQuery("category:updates older_than:1y")).toBe("Updates");
    expect(labelQuery("category:forums older_than:1y")).toBe("Forums");
    expect(labelQuery('"unsubscribe" older_than:1y')).toBe("Newsletters");
    expect(labelQuery("from:(no-reply@x.com) older_than:1y")).toBe("No-reply");
    expect(labelQuery("older_than:2y")).toBe("Other");
  });

  test("the unsubscribe pitch deliberately ignores both new labels", () => {
    const list = bodyOf(PROGRESS_SRC, "const NOISE_RULE_LABELS = Object.freeze([", "]);");
    expect(list).not.toContain('"Inbox"');
    expect(list).not.toContain('"Senders"');
  });
});

describe("the result screen says when the storage actually comes back", () => {
  // Each locale's own word for Trash. Both strings named it once before
  // this release; the new sentence names it again, so counting the word
  // is a real assertion in every language rather than a length guess
  // that CJK would fail on its own compactness.
  const TRASH = {
    en: "Trash", de: "Papierkorb", es: "papelera", fr: "corbeille",
    ja: "ゴミ箱", pt_BR: "lixeira", ru: "корзин"
  };
  const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

  test("the delete-run copy names emptying Trash, in all seven locales", () => {
    for (const [loc, word] of Object.entries(TRASH)) {
      const cat = JSON.parse(read(path.join("_locales", loc, "messages.json")));
      expect(occurrences(cat.resultNote.message, word)).toBeGreaterThanOrEqual(2);
      expect(occurrences(cat.progDoneSafetyDelete.message, word)).toBeGreaterThanOrEqual(3);
    }
  });

  test("the archive copy is untouched, because archiving frees nothing", () => {
    const en = JSON.parse(read(path.join("_locales", "en", "messages.json")));
    expect(en.resultNoteArchive.message).not.toMatch(/Trash empties/i);
    expect(en.progDoneSafetyArchive.message).not.toMatch(/Trash empties/i);
  });

  test("all three copies of each string agree", () => {
    const en = JSON.parse(read(path.join("_locales", "en", "messages.json")));
    const html = read("popup.html").replace(/\s+/g, " ");
    expect(html).toContain(en.resultNote.message);
    expect(POPUP_SRC).toContain(en.resultNote.message);
    expect(PROGRESS_SRC).toContain(en.progDoneSafetyDelete.message);
  });
});

describe("the recovery log says how long is left to restore", () => {
  test("a deleted run counts down inside Gmail's Trash window", () => {
    const fn = bodyOf(STATS_SRC, "function restoreDaysLeft(", "async function loadUndoLog(");
    expect(fn).toContain("GCC.restore.TRASH_WINDOW_MS");
    // Archive has no deadline, and an entry that is not restorable at
    // all already explains itself.
    expect(fn).toContain('if (verdict.action !== "delete") return null;');
    expect(fn).toContain("if (!verdict?.eligible) return null;");
  });

  test("the countdown is rendered on the entry, hedged like every other mention of the window", () => {
    const fn = bodyOf(STATS_SRC, "const daysLeft = restoreDaysLeft(entry, verdict);", "const findUrl =");
    expect(fn).toContain('"about " + daysLeft + " days left to restore"');
    expect(fn).toContain('"last day to restore"');
  });
});

describe("the Protect button tells the truth about the whitelist", () => {
  test("coverage is decided by the shared helper, not a fourth copy", () => {
    expect(SHARED_SRC).toContain("whitelistCovers: whitelistCoversSender,");
    expect(STATS_SRC).toContain("GCC.smart.whitelistCovers(entry, addr)");
  });

  test("an entry the engine itself refuses cannot paint a Protected chip", () => {
    const fn = bodyOf(STATS_SRC, "const WHITELIST_UNUSABLE_RE", "function renderTopSenders(");
    expect(fn).toContain("WHITELIST_UNUSABLE_RE.test(entry)");
  });

  test("a duplicate add is reported as a duplicate, not as a fresh success", () => {
    // addToWhitelist answers { ok: true, added: false } for a sender the
    // list already covers, and the handler only ever looked at ok.
    const fn = bodyOf(STATS_SRC, "whitelistBtn.addEventListener", 'resp?.error === "not an address or domain"');
    expect(fn).toContain("resp?.ok && resp.added === false");
    expect(fn).toContain("Already in your whitelist");
  });

  test("the 30 second refresh cannot wipe the Protected state, because it is derived", () => {
    expect(STATS_SRC).toContain("await loadWhitelist();");
    const fn = bodyOf(STATS_SRC, "function loadWhitelist(", "const WHITELIST_UNUSABLE_RE");
    // A read that failed keeps the previous list: a row can then only
    // look more protected than it is, never less.
    expect(fn).toContain("catch {");
    expect(fn).not.toContain("whitelistEntries = [];");
  });
});

describe("bulk unsubscribe stops re-ticking senders it already settled", () => {
  const fn = bodyOf(POPUP_SRC, "for (const sender of senders) {", "const name = document.createElement");

  test("a stored tick is only restored for a sender with no recorded status", () => {
    expect(fn).toContain("!sender.status");
  });

  test("only the hand-off status disables the row", () => {
    // "Needs their website" is a positive match on Gmail sending the
    // user to the sender's own page, so no run can ever finish it.
    expect(fn).toContain('if (sender.status === "manual") checkbox.disabled = true;');
    // "No unsubscribe link" is returned when a six second wait missed
    // Gmail's control, and nothing anywhere resets a stored status, so
    // disabling it would lock a sender out over one slow page load.
    expect(fn).not.toContain('sender.status === "no_button"');
  });
});

describe("Pro Settings warns before it loses an edit", () => {
  const fn = bodyOf(OPTIONS_SRC, "const wireProSettingsSection = ()", "wireProSettingsSection();");

  test("the card tracks its own edits against a DOM baseline", () => {
    // A baseline taken from the settings object would read clean while
    // the form said something else: the save path rewrites the label
    // field itself when the prefix is blank.
    expect(fn).toContain("const proSnapshot = () =>");
    expect(fn).toContain("proSnapshot() !== proBaseline");
  });

  test("all six fields report their edits", () => {
    expect(fn).toContain("for (const el of [intervalSel, depthSel, maxSendersSel, minAgeSel, undoEntriesSel])");
    expect(fn).toMatch(/labelInput\.addEventListener\("input"[\s\S]{0,400}onProFieldEdit\(\)/);
  });

  test("the baseline moves after a save, a reset, and a licence change", () => {
    expect(fn.split("rebaselinePro();").length - 1).toBeGreaterThanOrEqual(3);
  });

  test("closing the tab with an unsaved Pro edit prompts", () => {
    const unload = bodyOf(OPTIONS_SRC, 'window.addEventListener("beforeunload"', "});");
    expect(unload).toContain("!state.proSettingsDirty");
  });
});

describe("the schedule row controls name themselves", () => {
  const fn = bodyOf(OPTIONS_SRC, "const scheduleName =", "row.appendChild(info);");

  test("delete names the schedule it removes", () => {
    // Its visible text is a multiplication sign, so every row announced
    // identically for a control that deletes an unattended cleanup with
    // no confirm step.
    expect(fn).toContain('deleteBtn.setAttribute("aria-label", "Remove the " + scheduleName)');
  });

  test("the enable toggle names the action and carries its state", () => {
    expect(fn).toContain('toggle.setAttribute("aria-pressed"');
    expect(fn).toMatch(/"aria-label",\s*\n?\s*\(schedule\.enabled \? "Disable" : "Enable"\) \+ " the " \+ scheduleName/);
  });
});

describe("housekeeping the gates were blind to", () => {
  test("the sitemap uses the sitemaps.org namespace", () => {
    // The published one used a w3.org URL that has never existed, so
    // every <url> child was an unrecognised name and the only sitemap
    // the site advertises was rejected outright.
    const xml = read(path.join("netlify", "site", "sitemap.xml"));
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml).not.toContain("w3.org/2000/sitemap");
  });

  test("the declared Node floor is one the toolchain can actually run", () => {
    // addons-linter, the AMO gate, needs Node 20: on 18 it dies at
    // startup on a bare `File` reference before it validates anything.
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.engines.node).toBe(">=20");
    const ci = read(path.join(".github", "workflows", "ci.yml"));
    expect(ci).not.toMatch(/node-version: \[18/);
    expect(read("CONTRIBUTING.md")).not.toContain("Node.js 18 or newer");
  });

  test("an import counts the rules it drops per level, not against the backfilled total", () => {
    // normalizeRules fills any level the file omits from the defaults,
    // so kept came out ABOVE raw and the drop floored to zero: a
    // hand-written backup with 60 normal rules stored 50 and said
    // nothing about the 10 that fell off.
    const section = bodyOf(OPTIONS_SRC, '{ label: "rules"', '{ label: "whitelist entries"');
    expect(section).toContain("dropped: (d, j) => RULE_KEYS.reduce");
    expect(section).toContain("if (!Array.isArray(j.rules?.[k])) return n;");
    const summarize = bodyOf(OPTIONS_SRC, "const summarizeImport =", "const importDroppedLine");
    expect(summarize).toContain('typeof s.dropped === "function"');
  });
});

// Keep a stray timer from a source under test out of the worker's exit.
afterAll(async () => { await sleep(0); });
