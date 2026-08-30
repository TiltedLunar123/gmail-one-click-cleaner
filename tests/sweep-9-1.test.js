/**
 * 9.1. Every test in this file fails on 746a89d.
 *
 * The theme is the one this codebase keeps relearning: a number is
 * measured under one set of conditions, stored, and then rendered or
 * acted on under another. 8.7 fixed it for the Mailbox Report, 8.21
 * fixed it for Smart Suggestions, 9.0 fixed the measurement half for the
 * census and the receipts. 9.0 shipped the storage half of the render
 * fix and none of the render half itself: the worker persists the guard
 * snapshot under a comment saying the popup can warn on it, and no
 * popup surface ever reads that field.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const SHARED = read("shared.js");
const ENGINE = read("contentScript.js");
const WORKER = read("background.js");
const POPUP = read("popup.js");
const POPUP_HTML = read("popup.html");

const loadShared = () => {
  // eslint-disable-next-line no-new-func
  return new Function(`${SHARED}; return GCC;`)();
};

// A source pattern hunting for a bug matches the comment that warns
// about the bug. Strip comments before any assertion over source.
const stripComments = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

/** One function or block, bounded at both ends. Throws when either goes. */
const between = (src, startName, endName) => {
  const clean = stripComments(src);
  const start = clean.indexOf(startName);
  if (start === -1) throw new Error(`not found: ${startName}`);
  const end = clean.indexOf(endName, start + startName.length);
  if (end === -1) throw new Error(`end not found: ${endName}`);
  return clean.slice(start, end);
};

describe("the X-ray list keeps the tenth of a megabyte the engine measured", () => {
  test("rankSenders no longer rounds a fraction of a MB away to zero", () => {
    const GCC = loadShared();
    // 0.3 MB is what the engine and the worker both store for a sender
    // with four rows in the `larger:100k smaller:1M` tier 8.26 added.
    const [row] = GCC.storageXray.rankSenders([
      { email: "a@x.com", name: "A", count: 4, estMb: 0.3 }
    ]);
    expect(row.estMb).toBe(0.3);
    expect(GCC.formatMb(row.estMb)).not.toBe("0 MB");
  });

  test("it truncates like the engine and the worker rather than rounding up", () => {
    const GCC = loadShared();
    // A floor estimate must never be rounded up: the row says "at least".
    const [row] = GCC.storageXray.rankSenders([
      { email: "a@x.com", count: 1, estMb: 0.78 }
    ]);
    expect(row.estMb).toBe(0.7);
  });

  test("the three places this number passes through agree", () => {
    // 9.0 fixed the engine and the worker and missed the display
    // normalizer, which is the fourth hand the same number passes
    // through. Pin all three so the next one cannot drift alone.
    expect(ENGINE).toContain("Math.floor(s.estMb * 10) / 10");
    expect(WORKER).toContain("Math.floor((Number(raw?.estMb) || 0) * 10) / 10");
    const fn = between(SHARED, "const rankStorageSenders =", "const storageXray =");
    expect(fn).toContain("Math.floor((Number(s.estMb) || 0) * 10) / 10");
    expect(fn).not.toContain("Math.round(Number(s.estMb) || 0)");
  });

  test("ranking still orders by the finer number", () => {
    const GCC = loadShared();
    const rows = GCC.storageXray.rankSenders([
      { email: "small@x.com", count: 1, estMb: 0.3 },
      { email: "big@x.com", count: 1, estMb: 0.9 }
    ]);
    expect(rows.map((r) => r.email)).toEqual(["big@x.com", "small@x.com"]);
  });
});

describe("the census warns when the safety switches moved under its numbers", () => {
  test("the engine sends its guard snapshot on the terminal message too", () => {
    // The worker's copy is only reachable after a popup reopen. A popup
    // that watched the scan live gets the senders straight off the done
    // message, so the snapshot has to travel with them or that popup
    // has nothing to compare against for the rest of its life.
    const fn = between(ENGINE, "async function senderCensus(", "async function ");
    const done = fn.slice(fn.indexOf('phase: "done"'));
    expect(done).toContain("guards: censusGuards");
  });

  test("state.census has somewhere to keep it", () => {
    const block = between(POPUP, "census: {", "receipts: {");
    expect(block).toContain("guards: null");
  });

  test("both readers keep it instead of dropping it", () => {
    const load = between(POPUP, "const loadCensus =", "const handleCensusScan =");
    expect(load).toContain("census.guards");
    const progress = between(POPUP, "const handleCensusProgress =", "const startScopedCleanupRun =");
    expect(progress).toContain("msg.guards");
  });

  test("the comparison reuses the report's, so the two cannot disagree", () => {
    const fn = between(POPUP, "const censusGuardsChanged =", "\n  const ");
    expect(fn).toContain("REPORT_GUARD_FIELDS");
    expect(fn).toContain("liveReportGuards()");
    // A census stored before 9.1 has no snapshot. That answers FALSE,
    // exactly as smartGuardsChanged does: "cannot tell" must not blank a
    // number that is very likely still right.
    expect(fn).toContain("if (!measured) return false;");
  });

  test("the row's promise and the button's number both stop when it is true", () => {
    const row = between(POPUP, "const renderCensusList =", "const updateCensusPurgeButton =");
    expect(row).toContain("censusGuardsChanged()");
    const btn = between(POPUP, "const updateCensusPurgeButton =", "const renderCensus =");
    expect(btn).toContain("censusGuardsChanged()");
  });

  test("there is a note saying why the number went away", () => {
    expect(POPUP_HTML).toContain('id="censusGuardNote"');
    expect(POPUP_HTML).toContain('id="censusGuardNoteText"');
    expect(POPUP_HTML).toContain('id="censusGuardNoteBtn"');
    // The button beside it opens the switches, the way its two siblings do.
    expect(POPUP).toContain("elements.censusGuardNoteBtn?.addEventListener(\"click\", revealGuardSwitches);");
  });

  test("every guarded count in the extension now has a stale-guards check", () => {
    // Derived from the list rather than pinned as a number: a count says
    // "three surfaces do this", never "all surfaces do this", and that
    // is exactly how the census shipped without one.
    const SURFACES = ["state.report.guards", "state.smart.guards", "state.census.guards"];
    for (const s of SURFACES) expect(stripComments(POPUP)).toContain(s);
  });
});

describe("a relapse stays a relapse", () => {
  test("the next recheck does not downgrade it to a plain ignore", () => {
    // The verdict is derived from the previous one, and 9.0 tested only
    // "stopped -> still_sending". Once a receipt is `relapsed`, the next
    // sweep 30 days later sees prev.verdict === "relapsed", the rule
    // does not fire, and the record is overwritten with plain
    // "still_sending": the one fact that distinguishes a list that came
    // back from one that never stopped is lost on the second look, and
    // the row silently drops out of the top of the ranking.
    const fn = between(WORKER, "async function recordVerifyResults(", "async function recordCensus(");
    expect(fn).toContain('prev.verdict === "stopped" || prev.verdict === "relapsed"');
  });

  test("the ranking still puts a relapse above a plain ignore", () => {
    const GCC = loadShared();
    const at = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const ranked = GCC.receipts.rank([
      { email: "plain@x.com", at, verdict: "still_sending", since: 40, sinceExact: true },
      { email: "back@x.com", at, verdict: "relapsed", since: 2, sinceExact: true }
    ]);
    expect(ranked[0].email).toBe("back@x.com");
  });
});

describe("the check's closing line counts every verdict it can reach", () => {
  test("a sender still mailing into Spam is not announced as stopped", () => {
    // 9.0 added hidden_in_spam and relapsed and left this summary
    // counting the single literal "still_sending". One due receipt whose
    // sender kept mailing but landed in Spam produced ignored === 0, so
    // the run finished with "All 1 stopped." over a verdict that says
    // the opposite, on the one screen the whole feature exists for.
    const fn = between(ENGINE, "async function unsubscribeVerifyRun(", "\n  async function ");
    const done = fn.slice(fn.indexOf("const ignored = results.filter"));
    expect(done).toContain("RECEIPT_IGNORED_VERDICTS.includes(r.verdict)");
    expect(done).toContain('r.verdict === "hidden_in_spam"');
    // "All N stopped" may only be said when every result really is one.
    expect(done).toContain("stopped === results.length");
  });

  test("the engine's ignored set is the same one shared.js publishes", () => {
    const GCC = loadShared();
    expect([...GCC.receipts.IGNORED_VERDICTS].sort()).toEqual(["relapsed", "still_sending"]);
    // The engine keeps its own copy because it cannot import shared.js;
    // pin the two so a verdict added to one is added to both.
    expect(ENGINE).toContain('const RECEIPT_IGNORED_VERDICTS = ["still_sending", "relapsed"];');
  });
});

describe("the receipts Clear button says what it will take", () => {
  test("clearable reports how many of its senders were actually measured", () => {
    const GCC = loadShared();
    const at = Date.now() - 40 * 24 * 60 * 60 * 1000;
    // 9.1 retention: both carry a fresh `checkedAt`. Without one they
    // read as never checked, receiptIsDue answers true, and their
    // verdicts count as stale, which now takes the `clearable` figure
    // with it. That is the intended rule and not what this test is
    // about: it is about a measured sender against an unmeasured one.
    const checkedAt = Date.now() - 24 * 60 * 60 * 1000;
    const reach = GCC.receipts.clearable([
      { email: "a@x.com", at, checkedAt, verdict: "still_sending", since: 9, clearable: 4, clearableExact: true },
      { email: "b@x.com", at, checkedAt, verdict: "still_sending", since: 3 }
    ]);
    expect(reach.known).toBe(1);
    expect(reach.unknown).toBe(1);
    expect(reach.count).toBe(4);
  });

  test("the subtitle prints the measured number instead of only the scope", () => {
    // 9.0 measured `clearable` through the button's own guards, stored
    // it, and then printed "Only mail that arrived after each grace
    // window closed - 2 senders". With a Minimum Age of 3 months set on
    // the Clean tab (one press of the Monthly preset does it), the run's
    // query becomes `from:(x) after:<date> older_than:3m`, which is a
    // contradiction and matches nothing. The measured figure says 0 and
    // was never shown.
    const fn = between(POPUP, "const renderReceipts =", "const loadReceipts =");
    expect(fn).toContain("receiptsPurgeTakes");
    expect(fn).toContain("receiptsPurgeNothing");
  });

  test("pressing it when nothing is reachable does not start a run", () => {
    const fn = between(POPUP, "const handleReceiptsPurge =", "const setXrayStatus =");
    expect(fn).toContain("receiptsNothingReachable");
  });

  test("the ledger carries the guards its clearable numbers were measured through", () => {
    const engine = between(ENGINE, "async function unsubscribeVerifyRun(", "\n  async function ");
    expect(engine).toContain("guards: verifyGuards");
    const worker = between(WORKER, "async function recordVerifyResults(", "async function recordCensus(");
    expect(worker).toContain("sanitizeScanGuards");
    const block = between(POPUP, "receipts: {", "xray: {");
    expect(block).toContain("guards: null");
    const render = between(POPUP, "const renderReceipts =", "const loadReceipts =");
    expect(render).toContain("receiptsGuardsChanged()");
  });
});

describe("a capped run says it is capped, on every button that caps", () => {
  test("the verify subtitle quotes what one press checks, not the whole ledger", () => {
    const fn = between(POPUP, "const renderReceipts =", "const loadReceipts =");
    expect(fn).toContain("Math.min(summary.due, GCC.receipts.LIMITS.MAX_VERIFY_PER_RUN)");
  });

  test("and it raises the same first-25 toast its two siblings raise", () => {
    const fn = between(POPUP, "const handleVerifyClick =", "const handleVerifyProgress =");
    expect(fn).toContain("firstTwentyFive");
  });
});

describe("a census tick cannot outlive the row it came from", () => {
  test("a clear drops the senders it just took", () => {
    const fn = between(POPUP, "const handleCensusPurge =", "const handleReceiptsPurge =");
    expect(fn).toContain("forgetCensusChecked(capped)");
    // A dry run takes nothing, so it keeps the whole selection.
    expect(fn).toContain("if (!config.dryRun)");
  });

  test("a tick with no measured row is dropped on render", () => {
    const fn = between(POPUP, "const reconcileCensusSelection =", "const censusCountLabel =");
    // An empty census means "not scanned yet". Dropping the ticks then
    // would throw away a selection the user is about to come back to.
    expect(fn).toContain("if (!measured.size) return;");
    expect(between(POPUP, "const renderCensus =", "const loadCensus =")).toContain("reconcileCensusSelection()");
  });

  test("the scheduled sweep reads that same reconciled set", () => {
    // 9.0 wired the persisted ticks into the unattended run config, so a
    // tick nobody could see was still generating a delete rule every
    // sweep. Same key, so reconciling the set reconciles the sweep.
    expect(POPUP).toContain("censusSenders: [...state.census.checked]");
  });
});

describe("the receipts clear reaches the senders the cap left behind", () => {
  test("a cleared sender goes to the back of the queue, not off it", () => {
    const GCC = loadShared();
    const at = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const checkedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const list = [
      { email: "big@x.com", at, checkedAt, clearedAt: Date.now(), verdict: "still_sending", since: 90, sinceExact: true },
      { email: "small@x.com", at, checkedAt, verdict: "still_sending", since: 2, sinceExact: true }
    ];
    // Ranked, big@ comes first on `since`. It has already been cleared
    // for this verdict, so the next press must start with small@.
    expect(GCC.receipts.rank(list).map((r) => r.email)).toEqual(["big@x.com", "small@x.com"]);
    const { ordered, pending, cleared } = GCC.receipts.purgeOrder(list);
    expect(ordered.map((r) => r.email)).toEqual(["small@x.com", "big@x.com"]);
    expect(pending).toBe(1);
    expect(cleared).toBe(1);
  });

  test("a sender that relapses after being cleared comes back into the queue", () => {
    const GCC = loadShared();
    const at = Date.now() - 60 * 24 * 60 * 60 * 1000;
    // Cleared, then a later check found new mail: checkedAt moves past
    // clearedAt and the sender is pending again with no extra bookkeeping.
    const list = [{
      email: "back@x.com", at,
      clearedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
      checkedAt: Date.now(),
      verdict: "relapsed", since: 5, sinceExact: true
    }];
    expect(GCC.receipts.wasCleared(GCC.receipts.sanitize(list[0]))).toBe(false);
    expect(GCC.receipts.purgeOrder(list).pending).toBe(1);
  });

  test("the marker survives the round trip through storage", () => {
    const GCC = loadShared();
    const clean = GCC.receipts.sanitize({
      email: "a@x.com", at: 1756000000000, clearedAt: 1756900000000, verdict: "still_sending", since: 3
    });
    expect(clean.clearedAt).toBe(1756900000000);
  });

  test("the worker stamps it when the run starts, and forgets the spent reach", () => {
    const fn = between(WORKER, "async function recordReceiptsCleared(", "async function recordVerifyResults(");
    expect(fn).toContain("clearedAt: Date.now()");
    // The mail is on its way to Trash, so the measured reach is spent.
    // Dropped rather than zeroed: absent means "not measured" everywhere
    // else in this record.
    expect(fn).toContain("delete next.clearable;");
    expect(fn).toContain("delete next.clearableExact;");
    expect(WORKER).toContain('case "gmailCleanerReceiptsCleared":');
    expect(WORKER).toContain("withStorageLock(() => recordReceiptsCleared(msg.senders))");
  });

  test("the popup marks them at run start, and a dry run marks nothing", () => {
    const fn = between(POPUP, "const handleReceiptsPurge =", "const setXrayStatus =");
    expect(fn).toContain("gmailCleanerReceiptsCleared");
    expect(fn).toContain("if (config.dryRun) return;");
  });
});

describe("a smart count is validated against the guards it was measured under", () => {
  test("the snapshot travels with the sender, not with the scan record", () => {
    const fn = between(WORKER, "async function recordSmartScan(", "\n  async function ");
    expect(fn).toContain("entry.guards = sanitizeScanGuards(guards);");
  });

  test("the card checks the sender's own snapshot first", () => {
    expect(POPUP).toContain("const smartGuardsChanged = (sender) => {");
    expect(POPUP).toContain("(sender && sender.guards) || state.smart.guards");
    expect(POPUP).toContain("smartGuardsChanged(sender) ? \"\" : GCC.smart.actionCountText(sender)");
  });

  test("the note fires for a stale sender too, so no number vanishes unexplained", () => {
    const fn = between(POPUP, "const renderSmartGuardNote =", "const renderSmartList =");
    expect(fn).toContain("state.smart.senders.some((s) => smartGuardsChanged(s))");
  });
});

describe("one sanitiser for the fact three surfaces compare", () => {
  test("the census record normalises its guards the way the others do", () => {
    // The hand-rolled copy took `typeof minAge === "string"`, so an
    // empty minAge was stored as "" while the report and the smart scan
    // store null. The popup compares `(measured[k] ?? null) !== live[k]`
    // and `live.minAge` is `el.value || null`, so "" against null reads
    // as a switch the user moved and every census number is blanked on a
    // mailbox where nothing changed at all.
    const fn = between(WORKER, "async function recordCensus(", "async function chargeFreeUnsubscribes(");
    expect(fn).toContain("sanitizeScanGuards(msg.guards)");
    // Still null when the engine sent nothing: sanitizeScanGuards
    // answers a missing input with every switch OFF, which is a real
    // snapshot that happens to be false.
    expect(fn).toContain(": null");
  });

  test("the sanitiser refuses an age token it does not recognise", () => {
    const fn = between(WORKER, "function sanitizeScanGuards(guards)", "async function recordSmartScan(");
    expect(fn).toContain(String.raw`/^\d+[dwmy]$/i.test(guards.minAge)`);
  });
});
