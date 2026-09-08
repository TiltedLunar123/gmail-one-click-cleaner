/**
 * 9.1, the retention rules. Every test here fails on 95eaed0.
 *
 * The two stores added in 8.26 hold real addresses and had no end date.
 * They get different rules, because they are different kinds of thing.
 *
 * A census is a photograph of a mailbox. It goes out of date, and it goes
 * out of date in a known direction: the clear it feeds is scoped
 * `older_than:6m`, so every month that passes pushes another month of a
 * sender's mail across that line and the stored count UNDERSTATES what a
 * clear would take. Understating a delete is the direction that costs
 * mail, so the numbers stop being printed at 30 days and the record stops
 * being served at 90.
 *
 * A receipt is a record of something the user did, and its whole value is
 * being old enough to prove a sender ignored them. receiptIsDue makes an
 * older receipt MORE actionable, not less. So no receipt is ever deleted
 * for its age, at any threshold, on any path. What expires is the
 * VERDICT, which is a measurement of one search on one day, and it
 * expires on the schedule that already means exactly that: RECHECK_DAYS.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const SHARED = read("shared.js");
const WORKER = read("background.js");
const POPUP = read("popup.js");

const loadShared = () => {
  // eslint-disable-next-line no-new-func
  return new Function(`${SHARED}; return GCC;`)();
};

// A source pattern hunting for a rule matches the comment explaining the
// rule. Strip comments before any assertion over source.
const stripComments = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const between = (src, startName, endName) => {
  const clean = stripComments(src);
  const start = clean.indexOf(startName);
  if (start === -1) throw new Error(`not found: ${startName}`);
  const end = clean.indexOf(endName, start + startName.length);
  if (end === -1) throw new Error(`end not found: ${endName}`);
  return clean.slice(start, end);
};

const DAY = 86400000;

describe("the census ages out on one clock, with two thresholds", () => {
  test("both thresholds are named, and named once", () => {
    const GCC = loadShared();
    expect(GCC.census.LIMITS.STALE_DAYS).toBe(30);
    expect(GCC.census.LIMITS.MAX_AGE_DAYS).toBe(90);
  });

  test("stale at 30 days, and not a day before", () => {
    const GCC = loadShared();
    const now = 1756000000000;
    expect(GCC.census.isStale({ updatedAt: now - 29 * DAY }, now)).toBe(false);
    expect(GCC.census.isStale({ updatedAt: now - 30 * DAY }, now)).toBe(true);
  });

  test("a census with no clock is NOT stale, because cannot tell must not blank a number", () => {
    // The rule popup.js already follows for a scan stored before the
    // snapshot existed: a number that is very likely still right must not
    // be taken away because the extension cannot prove it.
    const GCC = loadShared();
    const now = 1756000000000;
    expect(GCC.census.isStale({ updatedAt: 0 }, now)).toBe(false);
    expect(GCC.census.isStale({}, now)).toBe(false);
    expect(GCC.census.isStale({ updatedAt: now + 5 * DAY }, now)).toBe(false);
  });

  test("expired at 90 days, and not a day before", () => {
    const GCC = loadShared();
    const now = 1756000000000;
    expect(GCC.census.isExpired({ updatedAt: now - 89 * DAY, senders: [] }, now)).toBe(false);
    expect(GCC.census.isExpired({ updatedAt: now - 90 * DAY, senders: [] }, now)).toBe(true);
  });

  test("a census it cannot read IS expired, which is the opposite answer to isStale", () => {
    // The two predicates resolve "cannot tell" in opposite directions on
    // purpose, and the reason is what each one gates. isStale decides
    // whether to print a number. isExpired decides whether to keep acting
    // on a list of addresses that becomes delete rules on an unattended
    // sweep, so it fails closed.
    const GCC = loadShared();
    const now = 1756000000000;
    expect(GCC.census.isExpired(undefined, now)).toBe(true);
    expect(GCC.census.isExpired(null, now)).toBe(true);
    expect(GCC.census.isExpired("garbage", now)).toBe(true);
    expect(GCC.census.isExpired({ updatedAt: now }, now)).toBe(true);
    expect(GCC.census.isExpired({ updatedAt: 0, senders: [] }, now)).toBe(true);
    expect(GCC.census.isExpired({ updatedAt: now + 5 * DAY, senders: [] }, now)).toBe(true);
  });
});

describe("no receipt is ever deleted for being old", () => {
  test("a receipt from over a year ago survives ranking and is still counted", () => {
    // THE PIN. If anyone later adds an age filter to this store, this is
    // the test that goes red. receiptIsDue puts the oldest unsettled
    // receipt at the head of the verify queue, so the record nearest any
    // age cutoff is by construction the next one the user would act on.
    const GCC = loadShared();
    const ancient = { email: "a@x.com", at: Date.now() - 400 * DAY, verdict: "", since: 0 };
    expect(GCC.receipts.rank([ancient])).toHaveLength(1);
    expect(GCC.receipts.summary([ancient]).total).toBe(1);
    expect(GCC.receipts.sanitize(ancient)).not.toBeNull();
  });

  test("the worker owns no receipt clock, still", () => {
    // background.js:1725 carries the rule that the one place which reads
    // a clock should be the one place that owns it, and shared.js is that
    // place. An age threshold added to the worker would be a second
    // clock for the same fact.
    expect(stripComments(WORKER)).not.toMatch(/RECEIPT_(GRACE|RECHECK|MAX_AGE|STALE)_DAYS/);
    const write = between(WORKER, "async function writeReceiptList(", "async function recordReceiptsCleared(");
    expect(write).not.toContain("86400000");
  });
});

describe("the verdict expires, not the receipt", () => {
  test("an answer is stale exactly when the receipt is due for a new one", () => {
    const GCC = loadShared();
    const now = 1756000000000;
    const base = { email: "a@x.com", at: now - 60 * DAY };
    // Settled 31 days ago: RECHECK_DAYS has passed, so the answer is old.
    expect(GCC.receipts.verdictStale({ ...base, verdict: "stopped", checkedAt: now - 31 * DAY }, now)).toBe(true);
    // Settled 29 days ago: still current.
    expect(GCC.receipts.verdictStale({ ...base, verdict: "stopped", checkedAt: now - 29 * DAY }, now)).toBe(false);
  });

  test("a receipt with no answer yet is never stale, at any age", () => {
    const GCC = loadShared();
    const now = 1756000000000;
    expect(GCC.receipts.verdictStale({ email: "a@x.com", at: now - 400 * DAY, verdict: "", checkedAt: 0 }, now)).toBe(false);
  });

  test("an inconclusive check counts as stale for free", () => {
    // background.js writes checkedAt 0 on purpose for an `unknown`, so
    // isDue answers true and no separate branch is needed.
    const GCC = loadShared();
    const now = 1756000000000;
    expect(GCC.receipts.verdictStale({ email: "a@x.com", at: now - 20 * DAY, verdict: "unknown", checkedAt: 0 }, now)).toBe(true);
  });

  test("rank stamps the flag on every record rather than dropping any", () => {
    // An added field, never a filter. Nothing leaves the list, so summary,
    // purgeOrder, clearable and the count the erase button is about to
    // delete all keep describing the same set. A filter would also empty
    // the fixtures behind the 9.0 and 9.1 suites and turn them green by
    // vacuity instead of red.
    const GCC = loadShared();
    const now = Date.now();
    const ranked = GCC.receipts.rank([
      { email: "old@x.com", at: now - 90 * DAY, verdict: "still_sending", since: 4, sinceExact: true, checkedAt: now - 60 * DAY },
      { email: "new@x.com", at: now - 20 * DAY, verdict: "stopped", since: 0, sinceExact: true, checkedAt: now - 1 * DAY }
    ]);
    expect(ranked).toHaveLength(2);
    for (const r of ranked) expect(typeof r.verdictStale).toBe("boolean");
    expect(ranked.find((r) => r.email === "old@x.com").verdictStale).toBe(true);
    expect(ranked.find((r) => r.email === "new@x.com").verdictStale).toBe(false);
  });

  test("the stale flag needs no threshold of its own", () => {
    // Derived from RECHECK_DAYS rather than given a second number. A
    // separate constant would be a second answer to one question and the
    // two would drift, which is how this codebase has been bitten before.
    const fn = between(SHARED, "const receiptVerdictIsStale =", "const sanitizeReceipt =");
    expect(fn).toContain("receiptIsDue(receipt, now)");
    expect(fn).not.toMatch(/\d+\s*\*\s*RECEIPT_DAY_MS/);
  });
});

describe("the expired census cannot reach the unattended delete path", () => {
  test("the worker's own threshold is pinned equal to the shared one", () => {
    // background.js cannot load shared.js, so it keeps its own copy, the
    // way RECEIPT_CAP and CENSUS_SENDER_CAP already do. Pinned, because a
    // number that lives in two files and is checked in one is how the
    // same defect survives a release here.
    const GCC = loadShared();
    const m = WORKER.match(/const CENSUS_MAX_AGE_DAYS = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(GCC.census.LIMITS.MAX_AGE_DAYS);
  });

  test("readCensusChecked refuses before it looks at a single address", () => {
    // This is the whole safety argument. The ticks are the only one of
    // these keys that deletes mail with nobody watching, they carry no
    // clock of their own, and the answer is to derive one from the census
    // they are a statement about rather than to invent a second stamp.
    const fn = between(WORKER, "async function readCensusChecked(", "\n  async function ");
    expect(fn).toContain("censusRecordExpired");
    expect(fn).toContain("return [];");
    // It fails the way this function already fails: unreadable means NO
    // rules, never all of them.
    expect(fn.indexOf("censusRecordExpired")).toBeLessThan(fn.indexOf("RECEIPT_EMAIL_RE"));
  });

  test("the popup's manual path is gated on the same fact", () => {
    const fn = between(POPUP, "const loadCensusSelection =", "const reconcileCensusSelection =");
    expect(fn).toContain("GCC.census.isExpired");
  });

  test("the census read is served through the storage queue", () => {
    const fn = between(WORKER, 'case "gmailCleanerGetCensus"', "case \"gmailCleanerRecordVerifyResults\"");
    expect(fn).toContain("withStorageLock");
  });

  test("nothing that runs inside the lock takes the lock again", () => {
    // withStorageLock is a plain promise chain with no re-entrancy, so a
    // second lock taken inside one hangs the worker for good.
    for (const name of ["function censusRecordExpired(", "async function readCensusChecked(", "async function eraseSenderStores("]) {
      const end = name.includes("censusRecordExpired") ? "\n  async function " : "\n  async function ";
      const body = between(WORKER, name, end);
      expect(body).not.toContain("withStorageLock");
    }
  });

  test("expiry never writes on a read path", () => {
    // A prune inside the read handler would be a new unlocked writer of a
    // key the queue owns. Deletion happens on the housekeeping alarm, and
    // it skips the write entirely when nothing aged out, which is
    // pruneOldStats' own stated rule about not losing a concurrent write.
    const fn = between(WORKER, "async function pruneExpiredCensus(", "\n  async function ");
    expect(fn).toContain("return;");
    expect(fn.indexOf("return;")).toBeLessThan(fn.indexOf("chrome.storage.local.set"));
  });
});

describe("the erase takes every list that holds an address", () => {
  test("the key list is enumerated by name, and the count is derived from it", () => {
    // Never toHaveLength(14). A count says "fourteen keys are erased",
    // never "all the keys are erased", and it stays green on the day a
    // fifteenth store is added and forgotten. This repo has been burned
    // by a count pin three times.
    //
    // 9.6: the names moved into ERASE_VALUES and ERASE_KEYS is derived
    // from it, because two literals that had to agree was a hazard at
    // six entries and a bug waiting to happen at fourteen.
    const block = between(WORKER, "const ERASE_VALUES = Object.freeze({", "});");
    const WANT = [
      "STORAGE_KEYS.CENSUS", "STORAGE_KEYS.RECEIPTS", "STORAGE_KEYS.CENSUS_CHECKED",
      "STORAGE_KEYS.XRAY_CHECKED", "STORAGE_KEYS.SMART_CHECKED", "STORAGE_KEYS.SUBS_CHECKED",
      // 9.6: the four scans, the feedback map and the three pending
      // markers, all of which hold the user's correspondents by address
      // and none of which anything removed before this release.
      "STORAGE_KEYS.REPORT", "STORAGE_KEYS.STORAGE_XRAY", "STORAGE_KEYS.SMART_SCAN",
      "STORAGE_KEYS.SUBSCRIPTIONS", "STORAGE_KEYS.SMART_FEEDBACK",
      "STORAGE_KEYS.REPORT_PENDING", "STORAGE_KEYS.XRAY_PENDING", "STORAGE_KEYS.SMART_PENDING"
    ];
    for (const key of WANT) expect(block).toContain(key);
    expect((block.match(/STORAGE_KEYS\./g) || []).length).toBe(WANT.length);
    // Derived, so the two can no longer disagree.
    expect(WORKER).toContain("const ERASE_KEYS = Object.freeze(Object.keys(ERASE_VALUES));");
  });

  test("every tick key the worker names is spelled the way the popup writes it", () => {
    // The popup writes these; the worker had never heard of three of
    // them. A typo would erase nothing and nothing would say so.
    // The four tick lists are written by the popup and erased by the
    // worker, so both files have to spell them the same way.
    for (const k of ["censusCheckedEmails", "xrayCheckedEmails", "smartCheckedEmails", "subsCheckedEmails"]) {
      expect(WORKER).toContain(`"${k}"`);
      expect(POPUP).toContain(`"${k}"`);
    }
    // The two stores are the worker's alone: the popup reaches them
    // through messages and never names the key.
    for (const k of ["senderCensus", "unsubReceipts"]) expect(WORKER).toContain(`"${k}"`);
  });

  test("it is one write, so there is no window where the census is gone and its ticks are not", () => {
    const fn = between(WORKER, "async function eraseSenderStores(", "\n  async function ");
    expect(fn.match(/chrome\.storage\.local\.set/g) || []).toHaveLength(1);
    // Neutral values, never remove and never clear: clear() would take
    // notifyOnComplete, runHistory, the recovery log and the licence
    // cache with it.
    expect(stripComments(WORKER)).not.toContain("storage.local.clear(");
    expect(stripComments(WORKER)).not.toContain("storage.local.remove(");
  });

  test("it rethrows, so the options page cannot toast success over a write that did not land", () => {
    const fn = between(WORKER, "async function eraseSenderStores(", "\n  async function ");
    expect(fn).not.toContain("catch");
    const route = between(WORKER, 'case "gmailCleanerEraseStores"', "return true;");
    expect(route).toContain("withStorageLock");
    expect(route).toContain("ok: false");
  });

  test("an open popup drops its in-memory ticks instead of writing them back", () => {
    // A popup left open across an erase keeps its in-memory Sets and its
    // painted checkboxes, and the next tick would write the whole
    // pre-erase set straight back through an unlocked storageSet.
    // Locking the erase in the worker protects the two records and does
    // nothing at all for the ticks.
    const fn = between(POPUP, "const wireStoreErasureWatch =", "const openChangelog =");
    // It fires ONLY on the erase signature: both record keys arriving
    // null in one batch, which is what eraseSenderStores' single set
    // produces and which nothing else can, since the popup never writes
    // either key. The first version reacted to any tick key going empty,
    // and onChanged fires in the context that made the write, so
    // unticking your last census sender repainted the X-ray, suggestion
    // and subscription lists from their open-time snapshots. Those are
    // not the live ticks (the purge reads the checkboxes off the DOM),
    // so a user who had just ticked twelve senders would have watched
    // all twelve clear themselves.
    // Each record answers for its own panel, because a null census does
    // NOT only come from the erase: the daily prune nulls it alone when
    // it ages out, and requiring both would leave an open popup showing
    // and arming a census the worker had just deleted.
    expect(fn).toContain("if (!censusGone && !receiptsGone) return;");
    // The other three tick lists go only on the erase signature.
    expect(fn).toContain("if (!censusGone || !receiptsGone) return;");
    for (const st of ["state.census.checked", "state.xray.checked", "state.smart.checked", "state.subs.checked"]) {
      expect(fn).toContain(st + " = new Set()");
    }
    for (const r of ["renderCensus", "renderReceipts", "renderXrayList", "renderSmartList", "renderSubsList"]) {
      expect(fn).toContain(r);
    }
  });
});

describe("the keys the new code dereferences actually exist", () => {
  // THE LESSON FROM THIS CHANGE'S OWN REVIEW. Every other assertion in
  // this file is a source pattern, and a source pattern cannot see an
  // undefined property. `STORAGE_KEYS.CENSUS` was missing from popup.js
  // while `expect(fn).toContain("GCC.census.isExpired")` passed happily,
  // and the two failures it caused were both silent and both in the
  // safe-looking direction: `storageGet("local", [undefined])` resolves
  // to `{}`, `isExpired(undefined)` answers true, and so every census
  // tick was dropped on every popup open regardless of age. The browser
  // pass missed it too, because it only exercised the expired case,
  // where dropping the ticks is correct.
  //
  // So this evaluates the object rather than grepping the file.
  const literalOf = (src) => {
    const m = src.match(/const STORAGE_KEYS = Object\.freeze\(\{[\s\S]*?\n {2}\}\);/);
    if (!m) throw new Error("STORAGE_KEYS literal not found");
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[0].replace("const STORAGE_KEYS = ", "").replace(/;\s*$/, "")}`)();
  };

  // Over stripped source, always. background.js:2952 mentions
  // `STORAGE_KEYS.PRO_HINT` inside a comment about the POPUP's key,
  // which the worker does not have and does not need, and this test
  // reported it as a missing key on its first run. A source pattern
  // hunting for a bug matches the comment explaining the bug, and this
  // file has now demonstrated that on itself.
  const dereferenced = (src) => new Set(
    [...stripComments(src).matchAll(/STORAGE_KEYS\.([A-Z_0-9]+)/g)].map((m) => m[1])
  );

  test("every key popup.js dereferences resolves to a real string", () => {
    const keys = literalOf(POPUP);
    const used = dereferenced(POPUP);
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) {
      expect(typeof keys[name]).toBe("string");
      expect(keys[name].length).toBeGreaterThan(0);
    }
  });

  test("the same is true of background.js", () => {
    const keys = literalOf(WORKER);
    for (const name of dereferenced(WORKER)) expect(typeof keys[name]).toBe("string");
  });

  test("the popup and the worker spell every shared key identically", () => {
    // Two files, one fact. A typo in either direction fails silently:
    // the popup would read a key nobody writes and the worker would
    // erase a key nobody reads.
    const p = literalOf(POPUP);
    const w = literalOf(WORKER);
    const shared = Object.keys(p).filter((k) => k in w);
    expect(shared.length).toBeGreaterThan(5);
    for (const k of shared) expect([k, p[k]]).toEqual([k, w[k]]);
  });
});

describe("a mixed set of fresh and stale receipts", () => {
  // FOUND BY A SECOND-OPINION PASS after the change had already gone
  // green. Making a stale verdict drop its `clearable` was right, and it
  // created a gap one step to the side: the RUN takes every ignored
  // sender it can build a query for, and receiptPurgeQuery has never
  // looked at staleness, so the count and the action disagreed again in
  // exactly the shape this codebase keeps relearning.
  const GCC = loadShared();
  const now = 1756000000000;
  const at = now - 90 * DAY;
  const mixed = [
    // Measured yesterday. Current.
    { email: "fresh@x.com", at, checkedAt: now - 1 * DAY, verdict: "still_sending", since: 12, sinceExact: true, clearable: 12, clearableExact: true },
    // Measured 40 days ago. Past RECHECK_DAYS, so the answer is old.
    { email: "stale@x.com", at, checkedAt: now - 40 * DAY, verdict: "still_sending", since: 47, sinceExact: true, clearable: 47, clearableExact: true }
  ];

  test("the stale one is reported unmeasured, not summed", () => {
    const reach = GCC.receipts.clearable(mixed, now);
    expect(reach.known).toBe(1);
    expect(reach.unknown).toBe(1);
    expect(reach.count).toBe(12);
  });

  test("but the run still acts on it, which is why a partial total must not be printed", () => {
    // This is the fact that makes the UI rule necessary. purgeOrder
    // returns both, and purgeQuery builds a query for both.
    const { ordered } = GCC.receipts.purgeOrder(mixed, now);
    expect(ordered).toHaveLength(2);
    for (const r of ordered) expect(GCC.receipts.purgeQuery(r)).not.toBe("");
  });

  test("so the subtitle drops the number whenever anything is unmeasured", () => {
    const fn = between(POPUP, "const renderReceipts =", "const loadReceipts =");
    expect(fn).toContain("reach.unknown > 0");
    // The scope branch has to come BEFORE the one that prints a figure,
    // or a mixed set falls through to "Clears 12 emails" over a run that
    // clears two senders.
    expect(fn.indexOf("reach.unknown > 0")).toBeLessThan(fn.indexOf("receiptsPurgeTakes"));
  });

  test("and the refusal only fires when every sender is measured and every one is zero", () => {
    // known > 0 && count === 0 alone would turn away a run with real
    // work in it: one sender measured at zero plus one gone stale.
    const fn = between(POPUP, "const handleReceiptsPurge =", "const setXrayStatus =");
    expect(fn).toContain("reach.unknown === 0 && reach.known > 0 && reach.count === 0");
  });
});
