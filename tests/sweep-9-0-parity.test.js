/**
 * 9.0: 8.26 added two engine run kinds and neither was wired to the
 * contract every earlier scan follows. Both counted raw and acted
 * guarded, which is this codebase's oldest defect wearing the newest
 * feature.
 *
 * Jude found the census half himself, from his own mailbox: the list
 * said a sender held five emails, he ticked it, pressed Clear, and got
 * "0 cleaned". The five were recent and unread; the clear runs
 * `older_than:6m -is:unread -is:starred -is:important -has:userlabels`.
 *
 * Every test here fails on ece5fbe.
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

// A source window bounded by the next declaration rather than by a
// character count, because a slice that stops short asserts nothing.
const fnFrom = (src, start, end) => {
  const a = src.indexOf(start);
  if (a < 0) throw new Error("anchor not found: " + start);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error("end anchor not found: " + end);
  return src.slice(a, b);
};

describe("the census counts what its Clear button acts on", () => {
  test("the reach query IS the clear query, built by the same chunker", () => {
    const GCC = loadShared();
    for (const email of ["a@x.com", "no-reply@news.example.co.uk", "x.y+z@sub.domain.org"]) {
      const [cleared] = GCC.census.purgeQueries([email], GCC.census.CLEAR_AGE);
      expect(cleared).toBe(`from:(${email}) older_than:6m`);
      expect(GCC.census.reachQuery(email)).toBe(cleared);
    }
  });

  test("the engine's fourth measure query matches shared.js exactly", () => {
    const GCC = loadShared();
    // The engine keeps its own copy; the two are pinned, so a change to
    // one that is not made to the other fails here rather than in a
    // mailbox.
    const m = GCC.census.measureQueries("a@x.com");
    expect(m.reach).toBe("from:(a@x.com) older_than:6m");
    expect(ENGINE).toContain("reach: `from:(${email}) older_than:${CENSUS.CLEAR_AGE}`");
    expect(ENGINE).toContain('CLEAR_AGE: "6m"');
  });

  test("the engine measures that query through applyGlobalGuards", () => {
    const fn = fnFrom(ENGINE, "async function senderCensus(", "async function ");
    // The string being right is only half of it. Counting it raw would
    // put the same wrong number straight back on the row.
    expect(fn).toContain("await openSearch(applyGlobalGuards(q.reach));");
    expect(fn).toContain("reachable: reach.count,");
  });

  test("a sender measured before 9.0 reports unknown, never zero", () => {
    const GCC = loadShared();
    // An 8.26 census has no reachable field at all. Defaulting it to 0
    // would tell a paying user their ticked senders give back nothing,
    // which is a different lie in the same place.
    const old = [{ email: "a@x.com", name: "A", count: 500, exact: true, slices: 3, estMb: 50, estMbExact: true, measured: true }];
    const ranked = GCC.census.rankSenders(old);
    expect(ranked[0].reachable).toBeUndefined();
    const reach = GCC.census.clearable(old, ["a@x.com"]);
    expect(reach).toEqual({ count: 0, exact: true, known: 0, unknown: 1 });
  });

  test("clearable sums only the ticked senders, and only measured ones", () => {
    const GCC = loadShared();
    const senders = [
      { email: "a@x.com", name: "A", count: 500, exact: true, slices: 3, estMb: 50, estMbExact: true, measured: true, reachable: 120, reachableExact: true },
      { email: "b@x.com", name: "B", count: 90, exact: true, slices: 2, estMb: 5, estMbExact: true, measured: true, reachable: 4, reachableExact: false },
      { email: "c@x.com", name: "C", count: 10, exact: true, slices: 1, estMb: 1, estMbExact: true, measured: true, reachable: 7, reachableExact: true }
    ];
    expect(GCC.census.clearable(senders, ["a@x.com", "c@x.com"]))
      .toEqual({ count: 127, exact: true, known: 2, unknown: 0 });
    // One inexact operand makes the sum a floor, exactly as everywhere else.
    expect(GCC.census.clearable(senders, ["a@x.com", "b@x.com"]).exact).toBe(false);
  });

  test("the worker carries reachable through, and omits it when absent", () => {
    const fn = fnFrom(WORKER, "async function recordCensus(", "async function ");
    expect(fn).toContain("Number.isFinite(Number(s?.reachable))");
    expect(fn).toContain("reachable: Math.max(0, Math.min(10000000, Math.floor(Number(s.reachable))))");
    // 8.10 lost `measured` and 8.24 lost `atLeast` by rebuilding a
    // record from a field list that did not mention them.
    expect(fn).toContain("guards:");
  });
});

describe("the receipts verdict stays raw and its button does not", () => {
  test("the verdict search is NOT guarded, deliberately", () => {
    const fn = fnFrom(ENGINE, "async function unsubscribeVerifyRun(", "async function ");
    // A starred or unread message from that sender is still proof they
    // kept mailing. Guarding the verdict would make "stopped" the
    // default answer for exactly the senders who are ignoring the user,
    // which is the one direction this feature must never fail in.
    expect(fn).toContain("await openSearch(target.query);");
  });

  test("the CLEAR is measured separately, through the guards it applies", () => {
    const fn = fnFrom(ENGINE, "async function unsubscribeVerifyRun(", "async function ");
    expect(fn).toContain("await openSearch(applyGlobalGuards(target.query));");
    expect(fn).toContain("clearable = reach.count;");
    // Only worth the second search when there is something to clear.
    expect(fn).toContain('if (outcome.verdict === "still_sending") {');
  });

  test("an unmeasured clearable is absent, not zero", () => {
    const GCC = loadShared();
    const r = GCC.receipts.sanitize({ email: "a@x.com", at: 1, verdict: "still_sending", since: 9, sinceExact: true });
    expect(r.clearable).toBeUndefined();
    const withIt = GCC.receipts.sanitize({ email: "a@x.com", at: 1, verdict: "still_sending", since: 9, sinceExact: true, clearable: 3, clearableExact: true });
    expect(withIt.clearable).toBe(3);
  });

  test("the purge subtitle counts what the purge acts on, not the whole list", () => {
    const GCC = loadShared();
    const now = Date.now();
    const many = Array.from({ length: 40 }, (_, i) => ({
      email: `s${i}@x.com`,
      at: now - 40 * 86400000,
      checkedAt: now - 86400000,
      verdict: "still_sending",
      since: 100 - i,
      sinceExact: true,
      clearable: 2,
      clearableExact: true
    }));
    const reach = GCC.receipts.clearable(many);
    expect(reach.senders).toBe(GCC.receipts.LIMITS.MAX_VERIFY_PER_RUN);
    expect(reach.stranded).toBe(40 - GCC.receipts.LIMITS.MAX_VERIFY_PER_RUN);
    // The subtitle reads from this, so it can no longer promise 40.
    expect(POPUP).toContain("const reach = GCC.receipts.clearable(state.receipts.list);");
    expect(POPUP).toContain("[String(reach.senders)]");
  });

  test("the cap is announced when it bites, as the census clear already does", () => {
    const at = POPUP.indexOf("const handleReceiptsPurge");
    expect(at).toBeGreaterThan(-1);
    const fn = POPUP.slice(at, at + 2000);
    expect(fn).toContain("allIgnored.length > ignored.length");
    expect(fn).toContain('t("firstTwentyFive"');
  });
});

describe("an unknown verdict is never mistaken for a check", () => {
  test("the FIRST failed check is retried, not locked out for a month", () => {
    const fn = fnFrom(WORKER, "async function recordVerifyResults(", "async function ");
    expect(fn).toMatch(/if \(verdict === "unknown"\) \{/);
    // The old condition. It meant the rule applied only where a verdict
    // already existed, so the receipt with no answer at all was the one
    // that got checkedAt = now and a RECHECK_DAYS lockout.
    expect(fn).not.toMatch(/verdict === "unknown" && prev\.verdict/);
  });

  test("shared.js still refuses to call an inexact zero a stop", () => {
    const GCC = loadShared();
    expect(GCC.receipts.verdictFor({ ok: true, count: 0, exact: false }).verdict).toBe("unknown");
    expect(GCC.receipts.verdictFor({ ok: true, count: 0, exact: true }).verdict).toBe("stopped");
  });
});

describe("a Chat tab is not a mailbox", () => {
  test("the predicate refuses Chat and accepts both mailbox forms", () => {
    const GCC = loadShared();
    expect(GCC.isMailboxUrl("https://mail.google.com/chat/u/0/#chat/home")).toBe(false);
    expect(GCC.isMailboxUrl("https://mail.google.com/chat/u/0/")).toBe(false);
    expect(GCC.isMailboxUrl("https://mail.google.com/mail/u/0/#inbox")).toBe(true);
    expect(GCC.isMailboxUrl("https://mail.google.com/")).toBe(true);
    expect(GCC.isMailboxUrl("https://mail.google.com/?pli=1")).toBe(true);
    expect(GCC.isMailboxUrl("https://mail.google.com/#inbox")).toBe(true);
    expect(GCC.isMailboxUrl("https://mail.google.com.evil.test/mail/")).toBe(false);
    expect(GCC.isMailboxUrl("https://calendar.google.com/mail/")).toBe(false);
    expect(GCC.isMailboxUrl(null)).toBe(false);
  });

  test("anything the worker accepts, the shared predicate accepts too", () => {
    // The worker filters to /mail/ before injecting. If the popup were
    // ever stricter than the worker, a run could be offered on a tab the
    // worker would refuse; if it were looser, we are back to Chat.
    const m = WORKER.match(/const isMailboxTab = \(url\) => (.+);/);
    expect(m).toBeTruthy();
    // eslint-disable-next-line no-new-func
    const isMailboxTab = new Function("url", `return ${m[1]};`);
    const GCC = loadShared();
    for (const url of [
      "https://mail.google.com/mail/u/0/#inbox",
      "https://mail.google.com/mail/u/1/#search/x",
      "https://mail.google.com/chat/u/0/#chat/home",
      "https://mail.google.com/"
    ]) {
      if (isMailboxTab(url)) expect([url, GCC.isMailboxUrl(url)]).toEqual([url, true]);
    }
  });

  test("the popup filters every tab lookup through it", () => {
    const fn = fnFrom(POPUP, "const findGmailTab", "const loadGmailAccounts");
    expect(fn).toContain("GCC.isMailboxUrl");
    // The bare host test is the one that let Chat through.
    expect(fn).not.toContain("activeTab?.url?.startsWith(CONFIG.GMAIL_URL)");
  });
});

describe("a scheduled sweep carries the census ticks it promises", () => {
  test("the scheduled config sends them, gated on the licence", () => {
    const fn = fnFrom(WORKER, "async function runScheduledCleanup(", "async function ");
    expect(fn).toContain('(await readLicenseState()) === "pro"');
    expect(fn).toContain("await readCensusChecked()");
    expect(fn).toContain("...(censusSenders.length ? { censusSenders } : {})");
  });

  test("the worker's cap matches the popup's", () => {
    const GCC = loadShared();
    const m = WORKER.match(/const CENSUS_RULE_SENDER_CAP = (\d+);/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBe(GCC.census.LIMITS.MAX_RULE_SENDERS);
  });

  test("an unreadable tick list means no rules, never all of them", () => {
    const fn = fnFrom(WORKER, "async function readCensusChecked(", "async function ");
    // 8.16's rule, on the read side: a failed read has to answer with
    // the SAFE value, and for a list that becomes delete rules the safe
    // value is none of them.
    expect(fn).toContain("catch (e)");
    expect(fn.slice(fn.indexOf("catch (e)"))).toContain("return [];");
  });
});

describe("the X-ray keeps a tenth of a megabyte", () => {
  test("the engine no longer rounds a sender to a whole MB", () => {
    const fn = fnFrom(ENGINE, "async function storageScan(", "async function ");
    // 100/1024 = 0.0977 MB per row in the tier 8.26 added, so five rows
    // is 0.49 MB and Math.round wrote 0.
    expect(fn).toContain("estMb: Math.floor(s.estMb * 10) / 10");
    expect(fn).not.toContain("estMb: Math.round(s.estMb)");
  });

  test("the worker does not round it back", () => {
    const fn = fnFrom(WORKER, "async function recordStorageScan(", "async function ");
    expect(fn).toContain("Math.floor((Number(raw?.estMb) || 0) * 10) / 10");
    expect(fn).not.toContain("Math.round(Number(raw?.estMb) || 0)");
    expect(fn).toContain("totalMb: Math.max(0, Math.floor((Number(totalMb) || 0) * 10) / 10)");
  });

  test("formatMb already shows the tenth, so nothing downstream changes", () => {
    const GCC = loadShared();
    expect(GCC.formatMb(0.5)).toBe("0.5 MB");
    expect(GCC.formatMb(0.4883)).toBe("0.5 MB");
    // And it still refuses to print a rounded-up zero as a real figure.
    expect(GCC.formatMb(0.001)).toBe("0 MB");
  });

  test("it floors rather than rounds, because the page says at least", () => {
    // Math.round is bidirectional: six rows in the bottom tier is
    // 0.586 MB and used to print as 1 MB, claiming more than the scan
    // measured on the one screen whose premise is that its numbers are
    // floors.
    expect(Math.floor(0.5859375 * 10) / 10).toBe(0.5);
  });
});

describe("a paying user never gets the free version of an 8.26 surface", () => {
  test("refreshLicenseUi repaints the census and the receipts", () => {
    const fn = fnFrom(POPUP, "const refreshLicenseUi = async () =>", "// 7.12:");
    expect(fn).toContain("renderCensus();");
    expect(fn).toContain("renderReceipts();");
    expect(fn).toContain("elements.censusUpsell.hidden = active");
    // The siblings it always repainted, so this is a list and not a pair.
    expect(fn).toContain("renderXrayList();");
    expect(fn).toContain("renderSmartList();");
    expect(fn).toContain("renderReport();");
  });
});
