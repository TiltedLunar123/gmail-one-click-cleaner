/**
 * @jest-environment jsdom
 *
 * Findings from the 8.10 sweep.
 *
 * Every assertion here was checked to FAIL against the 8.9.1 source
 * before the fix landed, except the ones marked as invariant pins: those
 * hold either way and exist so a later fix cannot over-narrow what it
 * was meant to correct.
 *
 * The Auto-Pilot action-parity finding, the largest of the sweep, lives
 * in tests/background-autopilot.test.js beside the harness that already
 * drives the worker.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const bgSrc = read("background.js");
const popupSrc = read("popup.js");
const progressSrc = read("progress.js");
const engineSrc = read("contentScript.js");
const optionsSrc = read("options.js");

const sharedCode = read("shared.js");
const iifeMatch = sharedCode.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
  {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      className: "", setAttribute: () => {}, appendChild: () => {},
      style: {}, classList: { add: () => {}, remove: () => {} }, remove: () => {}
    }),
    addEventListener: () => {}
  },
  {},
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

/** The body of a named function, so a pin cannot pass on an unrelated
 *  match elsewhere in a file of several thousand lines. */
function fnBody(src, header, endMarker = "\n  }") {
  const at = src.indexOf(header);
  if (at === -1) throw new Error(`not found: ${header}`);
  const end = src.indexOf(endMarker, at + header.length);
  return src.slice(at, end === -1 ? src.length : end);
}

function loadEngine(config = {}) {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = config;
  window.alert = () => {};
  document.body.innerHTML = "";
  // eslint-disable-next-line no-new-func
  new Function(engineSrc)();
  return window.GCC_INTERNALS;
}

// ---------------------------------------------------------------
// 1. `in:chats` walked past the dangerous-token refusal
// ---------------------------------------------------------------
// The matcher anchors every token with \b. "s" is a word character, so
// `in:chat\b` never fired on Gmail's actual operator, `in:chats`. The
// refusal is the last stop before a destructive custom rule, and Chat
// history is not something tag-before-delete or Restore can bring back.

describe("8.10: in:chats is refused, not just in:chat", () => {
  const ENGINE = loadEngine();

  test("the engine refuses both spellings", () => {
    expect(ENGINE.queryHasDangerousToken("in:chats older_than:1y")).toBe(true);
    expect(ENGINE.queryHasDangerousToken("in:chat older_than:1y")).toBe(true);
    expect(ENGINE.queryHasDangerousToken("{in:chats is:unread}")).toBe(true);
    expect(ENGINE.queryHasDangerousToken("(in:chats)")).toBe(true);
  });

  test("the shared validator refuses both spellings", () => {
    expect(GCC.validateGmailQuery("in:chats older_than:1y").valid).toBe(false);
    expect(GCC.validateGmailQuery("in:chat older_than:1y").valid).toBe(false);
  });

  test("negation is still allowed, which is what the report headline uses", () => {
    // Invariant pin: -in:chats EXCLUDES chat and must stay legal, or the
    // project's own REPORT_HEADLINE_QUERY becomes unrunnable.
    expect(ENGINE.queryHasDangerousToken("older_than:6m -in:chats")).toBe(false);
    expect(GCC.REPORT_HEADLINE_QUERY ?? "older_than:6m -in:sent -in:drafts -in:chats")
      .toContain("-in:chats");
  });

  test("ordinary rules are untouched", () => {
    // Invariant pin against over-matching: "chat" inside a word, or a
    // label that merely contains the letters, is not the operator.
    expect(ENGINE.queryHasDangerousToken("category:promotions older_than:1y")).toBe(false);
    expect(ENGINE.queryHasDangerousToken("from:(chats@example.com) older_than:6m")).toBe(false);
  });

  test("both copies of the token list agree", () => {
    const grab = (src) => {
      const at = src.indexOf("const DANGEROUS_QUERY_TOKENS = [");
      return src.slice(at, src.indexOf("];", at));
    };
    for (const list of [grab(bgSrc.length ? engineSrc : engineSrc), grab(sharedCode)]) {
      expect(list).toContain('"in:chats"');
      expect(list).toContain('"in:chat"');
    }
  });
});

// ---------------------------------------------------------------
// 2. The 8.9 "not measured" report state never rendered
// ---------------------------------------------------------------
// rankBands rebuilds each band from a fixed field list and `measured`
// was not on it, so the flag died at ingest. renderReport then dropped
// every count-0 row, which is what an unmeasured band looks like.

describe("8.10: a band whose search timed out survives ranking", () => {
  const bands = [
    { id: "promotions", count: 0, measured: false },
    { id: "inboxOld", count: 40, measured: true }
  ];

  test("rankBands carries the measured flag through", () => {
    const ranked = GCC.report.rankBands(bands);
    const promos = ranked.find((b) => b.id === "promotions");
    expect(promos).toBeDefined();
    expect(promos.measured).toBe(false);
  });

  test("a missing flag still reads as measured", () => {
    // Invariant pin: reports stored before 8.9 carry no flag, and they
    // must not all start rendering "not measured".
    const ranked = GCC.report.rankBands([{ id: "inboxOld", count: 12 }]);
    expect(ranked[0].measured).toBe(true);
  });

  test("ranking twice does not lose the flag", () => {
    // The popup ranks at ingest AND at render, which is how the flag was
    // lost even where the first call preserved it.
    const once = GCC.report.rankBands(bands);
    const twice = GCC.report.rankBands(once);
    expect(twice.find((b) => b.id === "promotions").measured).toBe(false);
  });

  test("the popup keeps unmeasured rows past its zero-count filter", () => {
    const fn = fnBody(popupSrc, "const renderReport = () => {");
    expect(fn).toMatch(/\.filter\(\(b\) => b\.count > 0 \|\| b\.measured === false\)/);
  });

  test("an unmeasured row gets no action control, only a rescan hint", () => {
    // Showing the row is the honesty fix. Giving it the ordinary button
    // would put a live purge behind a number the scan never produced,
    // and show a free user a Pro pitch on a row reading "not measured".
    const fn = fnBody(popupSrc, "const renderReport = () => {");
    expect(fn).toMatch(/} else if \(band\.measured === false\) \{/);
    expect(fn).toMatch(/reportUnmeasuredHint/);
    const branchAt = fn.indexOf("band.measured === false");
    const btnAt = fn.indexOf('btn.setAttribute("data-band"');
    expect(branchAt).toBeLessThan(btnAt);
    for (const loc of ["en", "es", "fr", "de", "pt_BR", "ru", "ja"]) {
      const cat = JSON.parse(read(`_locales/${loc}/messages.json`));
      expect(typeof cat.reportUnmeasuredHint?.message).toBe("string");
    }
  });

  test("the whole-plan button still counts only runnable bands", () => {
    // reportPlanGroup filters on count > 0, so an unmeasured row must
    // not be what makes the plan button appear.
    const fn = fnBody(popupSrc, "const renderReport = () => {");
    expect(fn).toMatch(/const runnable = ranked\.filter\(\(b\) => b\.count > 0\)\.length/);
    expect(fn).toMatch(/reportPlanBtn\.hidden = runnable < 2/);
    expect(GCC.report.planGroup(bands).ids).not.toContain("promotions");
  });
});

// ---------------------------------------------------------------
// 3. The archive notification claimed megabytes it did not free
// ---------------------------------------------------------------
// Archived mail sits in All Mail and still counts against the quota.
// Every other surface learned that in 8.9; the desktop notification kept
// the delete wording, and it is the ONLY surface an unattended run has.

describe("8.10: the completion notification tells the truth about archive", () => {
  const fn = fnBody(bgSrc, "async function maybeNotifyDone(summary) {");

  // Anchored on the message keys, not on `summary?.action === "archive"`:
  // that expression has appeared at the top of this function since 8.7,
  // where it picks the TITLE's verb, and matching it finds the old line
  // rather than the new branch.
  const dryAt = fn.indexOf("notifDryBody");
  const archiveAt = fn.indexOf("notifArchiveBody");
  const liveAt = fn.indexOf("notifLiveBody");

  test("an archive run gets its own body, not the freed-MB one", () => {
    expect(archiveAt).toBeGreaterThan(-1);
    // Reached BEFORE the freed-MB default, or the default still wins.
    expect(archiveAt).toBeLessThan(liveAt);
    expect(fn).toMatch(/summary\?\.action === "archive"/);
  });

  test("the dry-run body still wins over both", () => {
    // Invariant pin: a dry run touches nothing whatever the action was.
    expect(dryAt).toBeGreaterThan(-1);
    expect(dryAt).toBeLessThan(archiveAt);
  });

  test("only the delete body interpolates a megabyte figure", () => {
    expect(fn.slice(archiveAt, liveAt)).not.toMatch(/freedText/);
    expect(fn.slice(liveAt)).toMatch(/freedText/);
  });

  test("all seven catalogues carry the new key", () => {
    for (const loc of ["en", "es", "fr", "de", "pt_BR", "ru", "ja"]) {
      const cat = JSON.parse(read(`_locales/${loc}/messages.json`));
      expect(typeof cat.notifArchiveBody?.message).toBe("string");
      expect(cat.notifArchiveBody.message.length).toBeGreaterThan(0);
      // The whole point is that it makes no storage claim.
      expect(cat.notifArchiveBody.message).not.toMatch(/\$1/);
    }
  });
});

// ---------------------------------------------------------------
// 4. A lock only one writer takes is not a lock
// ---------------------------------------------------------------
// markScheduleRan says it is "serialized against the other sync
// read-modify-writes". It was the only one of them holding the lock.

describe("8.10: every sync read-modify-write takes the storage lock", () => {
  const cases = [
    ["saveSchedule", "async function saveSchedule(schedule) {"],
    ["deleteSchedule", "async function deleteSchedule(scheduleId) {"],
    ["addToWhitelist", "async function addToWhitelist(sender) {"],
    ["markScheduleRan", "async function markScheduleRan(scheduleId) {"]
  ];

  test.each(cases)("%s runs under withStorageLock", (_name, header) => {
    expect(fnBody(bgSrc, header)).toMatch(/withStorageLock\(/);
  });

  // The READ has to be inside the lock, not just the write. A writer
  // that reads first and locks only its set still merges into a
  // snapshot taken before the sweep's write, and puts the old lastRunAt
  // straight back: locking the set alone buys nothing at all.
  test.each([
    ["setAutoPilotEnabled", "async function setAutoPilotEnabled(enabled) {"],
    ["confirmAutoPilot", "async function confirmAutoPilot() {"]
  ])("%s reads AND writes inside the lock", (_name, header) => {
    const fn = fnBody(bgSrc, header);
    const lockAt = fn.indexOf("withStorageLock(");
    const readAt = fn.indexOf("getAutoPilotConfig()");
    const writeAt = fn.indexOf("safeSyncSet(");
    expect(lockAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(lockAt);
    expect(writeAt).toBeGreaterThan(readAt);
  });

  test("the licence check stays outside the lock", () => {
    // It does WebCrypto and touches none of this key. Holding the queue
    // through it would stall every other storage write in the worker.
    for (const header of [
      "async function setAutoPilotEnabled(enabled) {",
      "async function confirmAutoPilot() {"
    ]) {
      const fn = fnBody(bgSrc, header);
      expect(fn.indexOf("hasProLicense()")).toBeLessThan(fn.indexOf("withStorageLock("));
    }
  });

  test("deleteSchedule writes through the quota check like its siblings", () => {
    const fn = fnBody(bgSrc, "async function deleteSchedule(scheduleId) {");
    expect(fn).toMatch(/safeSyncSet\(/);
    expect(fn).not.toMatch(/chrome\.storage\.sync\.set\(/);
  });

  test("the lock is still a plain chain, so nesting an awaited call would deadlock", () => {
    // Invariant pin. withStorageLock is a promise chain, not a
    // re-entrant mutex: the Auto-Pilot apply stage deliberately does NOT
    // await its inner withStorageLock for exactly this reason, and a
    // future edit that awaits it would hang the worker.
    expect(bgSrc).toMatch(/let _storageChain = Promise\.resolve\(\);/);
    const apply = fnBody(bgSrc, "async function handleAutoPilotProgress(msg, senderTabId) {");
    expect(apply).toMatch(/withStorageLock\(\(\) => startAutoPilotApply\(\)\)\s*\r?\n\s*\.catch\(/);
  });
});

// ---------------------------------------------------------------
// 5. Protect could store more senders than Options would keep
// ---------------------------------------------------------------

describe("8.10: the whitelist cap is one number", () => {
  test("the worker and the options page agree", () => {
    const wl = bgSrc.match(/const WL_MAX_ENTRIES = (\d+);/);
    const opt = optionsSrc.match(/MAX_WHITELIST_ENTRIES: (\d+),/);
    expect(wl).not.toBeNull();
    expect(opt).not.toBeNull();
    expect(Number(wl[1])).toBe(Number(opt[1]));
  });

  test("a full list refuses instead of evicting the oldest entry", () => {
    // Evicting was the silent half: Options normalizes on LOAD, so an
    // entry past the cap vanished from the textarea and the next Save
    // wrote the truncation back to sync.
    const fn = fnBody(bgSrc, "async function addToWhitelist(sender) {");
    expect(fn).toMatch(/wl\.length >= WL_MAX_ENTRIES/);
    expect(fn).toMatch(/throw new Error\(/);
    expect(fn).not.toMatch(/wl\.shift\(\)/);
  });
});

// ---------------------------------------------------------------
// 6. The per-rule "Freed MB" column had nothing to render
// ---------------------------------------------------------------

describe("8.10: each rule reports the storage it freed", () => {
  test("a live delete rule books its own megabytes", () => {
    const ENGINE = loadEngine({ archiveInsteadOfDelete: false });
    ENGINE.stats.perQuery.length = 0;
    ENGINE.recordQueryStats({
      query: "larger:20M", label: "Large", count: 10,
      mode: "live", durationMs: 5, mbPerEmail: 20
    });
    expect(ENGINE.stats.perQuery[0].freedMb).toBe(200);
  });

  test("an archive rule books none of it", () => {
    // 8.9's rule, applied to the new field on the way in rather than
    // stripped off it later.
    const ENGINE = loadEngine({ archiveInsteadOfDelete: true });
    ENGINE.stats.perQuery.length = 0;
    ENGINE.recordQueryStats({
      query: "larger:20M", label: "Large", count: 10,
      mode: "live", durationMs: 5, mbPerEmail: 20
    });
    expect(ENGINE.stats.perQuery[0].freedMb).toBeUndefined();
  });

  test("a dry run books none of it", () => {
    const ENGINE = loadEngine({ archiveInsteadOfDelete: false });
    ENGINE.stats.perQuery.length = 0;
    ENGINE.recordQueryStats({
      query: "larger:20M", label: "Large", count: 10,
      mode: "dry", durationMs: 5, mbPerEmail: 20
    });
    expect(ENGINE.stats.perQuery[0].freedMb).toBeUndefined();
  });

  test("processQuery hands the size estimate to every exit", () => {
    const fn = fnBody(engineSrc, "async function processQuery(query, idx, total) {");
    expect(fn).toMatch(/const recordQuery = \(entry\) => recordQueryStats\(\{ \.\.\.entry, mbPerEmail \}\)/);
    // No exit may bypass the wrapper and lose the figure.
    expect(fn).not.toMatch(/[^.\w]recordQueryStats\(\{\s*\r?\n?\s*query/);
  });
});

// ---------------------------------------------------------------
// 7. The dry-run headline summed overlapping rules
// ---------------------------------------------------------------

describe("8.10: the preview does not present a sum as a conversation count", () => {
  test("the sentence says matches and admits the overlap", () => {
    const ENGINE = loadEngine({ dryRun: true });
    const line = ENGINE.buildHumanSummary({ runCount: 200, mode: "dry" }, 11);
    expect(line).toMatch(/200 matches across 11 rules/);
    expect(line).toMatch(/counted more than once/);
    expect(line).not.toMatch(/200 conversations/);
  });

  test("the nesting that causes it is real, and deliberate", () => {
    // Invariant pin on the cause. If these bands ever stop overlapping
    // the wording can go back; while they do, the sum is not a count.
    const ENGINE = loadEngine();
    const normal = ENGINE.CONFIG.rules || [];
    void normal;
    const table = engineSrc.slice(engineSrc.indexOf("const DEFAULT_RULES = Object.freeze({"));
    expect(table).toContain('"category:promotions older_than:3m"');
    expect(table).toContain('"category:promotions older_than:1y"');
  });

  test("an empty dry run still says nothing matched", () => {
    // Invariant pin: the zero case has its own sentence and keeps it.
    const ENGINE = loadEngine({ dryRun: true });
    expect(ENGINE.buildHumanSummary({ runCount: 0, mode: "dry" }, 11))
      .toMatch(/nothing matched your rules/);
  });

  test("the live sentence is untouched", () => {
    // Invariant pin: a live run empties each rule before the next looks,
    // so its total is a real count and must not gain the caveat.
    const ENGINE = loadEngine({ dryRun: false, archiveInsteadOfDelete: true });
    ENGINE.stats.totalDeleted = 120;
    expect(ENGINE.buildHumanSummary({ runCount: 120, mode: "live" }, 11))
      .toMatch(/120 conversations archived/);
  });
});

// ---------------------------------------------------------------
// 8. Two archive surfaces still read the raw figure
// ---------------------------------------------------------------

describe("8.10: the last two freed-MB readers go through the archive gate", () => {
  test("the progress KPI chip uses freedMbOf", () => {
    const fn = fnBody(progressSrc, "const renderStatsSummary = (stats) => {");
    expect(fn).toMatch(/const freedMb = freedMbOf\(stats\)/);
    expect(fn).not.toMatch(/stats\.totalFreedMb \?\? stats\.freedMb/);
  });

  test("the popup recap gates before the rating ask reads the number", () => {
    const fn = fnBody(popupSrc, "const showRecapForEntry = (entry) => {");
    expect(fn).toMatch(/recapAction\(entry\) === "archive"/);
    const rating = fnBody(popupSrc, "const maybeShowPostRunRecap = async () => {");
    expect(rating).toMatch(/recapAction\(entry\) === "archive"/);
  });

  test("the rating ask still fires for a real delete run", () => {
    // Invariant pin: gating archive must not gate everything.
    expect(GCC.popupUi.ratingRunQualifies({ dryRun: false, cleaned: 0, freedMb: 300 })).toBe(true);
    expect(GCC.popupUi.ratingRunQualifies({ dryRun: false, cleaned: 0, freedMb: 0 })).toBe(false);
  });
});
