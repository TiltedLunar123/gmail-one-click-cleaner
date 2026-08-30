/**
 * 9.0 adds two verdicts to the unsubscribe receipts, and the safety
 * property of the first one is the whole reason it can ship.
 *
 * hidden_in_spam: Gmail's default search excludes Spam, so a sender who
 * kept mailing but got spam-filed answered the honour check with an
 * EXACT zero, which is the strongest answer verdictFromCount has, and
 * 8.26 printed "Stopped". The verdict was false in the one direction an
 * accusation must never fail in, and nothing on screen hinted at it.
 *
 * The fix is a second, READ-ONLY search. `in:spam` stays on
 * DANGEROUS_QUERY_TOKENS: that refusal is about rules, because a cleanup
 * scoped to Spam or Trash puts Gmail in the view where the toolbar's
 * delete control means Delete forever, with nothing for tag-before-delete
 * or Restore to find. So this verdict has no button behind it, and the
 * tests below pin that it cannot grow one by accident.
 *
 * relapsed: a sender that honoured the request and later restarted is a
 * different fact from one that never stopped, and the one the user is
 * least likely to notice, because they watched it go quiet.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf-8");
const SHARED = read("shared.js");
const ENGINE = read("contentScript.js");
const WORKER = read("background.js");
const POPUP = read("popup.js");

const loadShared = () => {
  // eslint-disable-next-line no-new-func
  return new Function(`${SHARED}; return GCC;`)();
};

const fnFrom = (src, start, end) => {
  const a = src.indexOf(start);
  if (a < 0) throw new Error("anchor not found: " + start);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error("end anchor not found: " + end);
  return src.slice(a, b);
};

describe("the Spam verdict is read-only, and provably so", () => {
  test("in:spam is still refused as a RULE", () => {
    // The whole design rests on this staying true. If `in:spam` ever
    // became an acceptable rule, the verdict below would be one edit
    // away from a Delete forever.
    expect(ENGINE).toContain('"in:spam"');
    expect(SHARED).toContain('"in:spam"');
  });

  test("the engine refuses a spam-scoped query through its own guard", () => {
    window.GCC_TEST_MODE = true;
    window.GMAIL_CLEANER_CONFIG = { runKind: "cleanup" };
    window.alert = () => {};
    // eslint-disable-next-line no-new-func
    new Function(ENGINE)();
    const I = window.GCC_INTERNALS;
    expect(I.queryHasDangerousToken("in:spam from:(a@x.com) after:2026/01/01")).toBe(true);
    expect(I.queryHasDangerousToken("from:(a@x.com) after:2026/01/01")).toBe(false);
  });

  test("no purge query is ever built for a spam verdict", () => {
    const GCC = loadShared();
    const at = Date.now() - 40 * 86400000;
    const spam = { email: "a@x.com", at, checkedAt: Date.now(), verdict: "hidden_in_spam", since: 12, sinceExact: true };
    expect(GCC.receipts.purgeQuery(spam)).toBe("");
    // And it is not in the set the Clear button acts on.
    expect(GCC.receipts.IGNORED_VERDICTS).not.toContain("hidden_in_spam");
    expect(GCC.receipts.clearable([spam]).senders).toBe(0);
  });

  test("the spam query never leaves the verify run", () => {
    // It is counted and never carried into a result, so it cannot reach
    // storage, a rule, or rulesOverride.
    const fn = fnFrom(ENGINE, "async function unsubscribeVerifyRun(", "async function ");
    expect(fn).toContain("await openSearch(target.spamQuery);");
    expect(fn).not.toContain("spamQuery," );
    expect(fn).not.toContain("query: target.spamQuery");
    // Nothing anywhere puts it in a purge.
    expect(SHARED).not.toContain("in:spam from:");
    expect(POPUP).not.toContain("spamQuery");
  });

  test("only a search that FOUND something overturns a stop", () => {
    const fn = fnFrom(ENGINE, "async function unsubscribeVerifyRun(", "async function ");
    // An inexact zero in Spam is the absence of evidence. Reading it as
    // guilt would be the mirror of the bug being fixed.
    expect(fn).toContain("if (hidden.count > 0) {");
    expect(fn).toContain('if (outcome.verdict === "stopped") {');
  });

  test("a spam verdict survives the sanitizer and ranks below real work", () => {
    const GCC = loadShared();
    const at = Date.now() - 40 * 86400000;
    const rows = [
      { email: "spam@x.com", at, checkedAt: at, verdict: "hidden_in_spam", since: 5, sinceExact: true },
      { email: "loud@x.com", at, checkedAt: at, verdict: "still_sending", since: 2, sinceExact: true },
      { email: "back@x.com", at, checkedAt: at, verdict: "relapsed", since: 1, sinceExact: true },
      { email: "good@x.com", at, checkedAt: at, verdict: "stopped", since: 0, sinceExact: true }
    ];
    const ranked = GCC.receipts.rank(rows);
    expect(ranked.map((r) => r.verdict))
      .toEqual(["relapsed", "still_sending", "hidden_in_spam", "stopped"]);
    // A verdict the sanitizer does not know is blanked, which would keep
    // the date and lose the answer.
    expect(GCC.receipts.sanitize(rows[0]).verdict).toBe("hidden_in_spam");
  });

  test("it is counted on its own, not folded into the ignored total", () => {
    const GCC = loadShared();
    const at = Date.now() - 40 * 86400000;
    const s = GCC.receipts.summary([
      { email: "a@x.com", at, checkedAt: Date.now(), verdict: "hidden_in_spam", since: 5, sinceExact: true },
      { email: "b@x.com", at, checkedAt: Date.now(), verdict: "still_sending", since: 2, sinceExact: true },
      { email: "c@x.com", at, checkedAt: Date.now(), verdict: "relapsed", since: 1, sinceExact: true }
    ]);
    expect(s.hiddenInSpam).toBe(1);
    // stillSending is what the button acts on, so a relapse belongs in
    // it and a spam row does not.
    expect(s.stillSending).toBe(2);
    expect(s.relapsed).toBe(1);
  });
});

describe("a relapse is not the same as never having stopped", () => {
  test("the worker promotes still_sending to relapsed off the stored verdict", () => {
    const fn = fnFrom(WORKER, "async function recordVerifyResults(", "async function ");
    // 9.1: widened to include a receipt that is ALREADY a relapse. The
    // exact match meant the first recheck after a relapse (30 days on,
    // by RECHECK_DAYS) saw prev.verdict === "relapsed", did not fire,
    // and wrote plain "still_sending" over the top. A sender that
    // relapsed and is still sending has not un-relapsed.
    expect(fn).toContain('if (verdict === "still_sending" && (prev.verdict === "stopped" || prev.verdict === "relapsed")) {');
    expect(fn).toContain('verdict = "relapsed";');
  });

  test("a relapse IS cleared, on the original window", () => {
    const GCC = loadShared();
    const at = Date.now() - 60 * 86400000;
    const r = { email: "a@x.com", at, checkedAt: Date.now(), verdict: "relapsed", since: 9, sinceExact: true };
    const q = GCC.receipts.purgeQuery(r);
    expect(q).toBe(GCC.receipts.verifyQuery(r));
    expect(q).toContain("from:(a@x.com) after:");
    // The stretch between the grace window and the relapse is exactly
    // the stretch that read as stopped, so it holds no mail: a wider
    // window over an empty span is the same mail.
    expect(GCC.receipts.IGNORED_VERDICTS).toContain("relapsed");
  });

  test("the two verdict lists are the same list", () => {
    const GCC = loadShared();
    const m = WORKER.match(/const RECEIPT_VERDICTS = Object\.freeze\(\[([\s\S]*?)\]\);/);
    expect(m).toBeTruthy();
    const workerList = m[1].match(/"[a-z_]+"/g).map((s) => s.replace(/"/g, ""));
    expect(workerList).toEqual([...GCC.receipts.VERDICTS]);
  });

  test("every verdict the model allows has a label", () => {
    const GCC = loadShared();
    const fn = fnFrom(POPUP, "const receiptVerdictLabel", "const renderReceipts");
    for (const v of GCC.receipts.VERDICTS) {
      // "unknown" and the empty state are handled by the tail of the
      // function; the rest each need their own sentence.
      if (v === "unknown") continue;
      expect([v, fn.includes(`r.verdict === "${v}"`)]).toEqual([v, true]);
    }
  });
});
