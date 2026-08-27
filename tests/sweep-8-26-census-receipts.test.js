/**
 * @jest-environment jsdom
 *
 * 8.26: the sender census and unsubscribe receipts.
 *
 * The release exists because every scan in this extension described the
 * mailbox with a Gmail operator written in advance, and a mailbox that
 * is not shaped like the operator reads as empty. Measured against a
 * real account while this was built: `category:promotions older_than:6m`
 * returned nothing at all, `older_than:2y` returned nothing at all, and
 * two broad searches found sixty distinct senders. So the Mailbox Report
 * had almost nothing to offer on a mailbox that was plainly full.
 *
 * Four things are pinned here, and three of them are invariants that
 * existed only as prose before this file:
 *
 * 1. The X-ray's purge floor equals its smallest scan tier. Its own
 *    comment said so and nothing enforced it, which is how adding two
 *    tiers below 5 MB nearly shipped a list saying "at least 300 MB"
 *    above a button that searched larger:5M and deleted nothing.
 * 2. The census age list is a subset of the one the query chunker
 *    honours. The chunker DROPS an age it does not recognise instead of
 *    refusing it, so a wider list here turns "clear mail older than
 *    three months" into a bare from:() that clears everything.
 * 3. The engine's private copies of the census and verdict arithmetic
 *    match shared.js, the way the smart-scan copies are pinned.
 * 4. A verdict stays sound on a count Gmail refused to total, and an
 *    unresolved search is never read as "they stopped".
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf-8");
const SHARED = read("shared.js");
const ENGINE = read("contentScript.js");
const WORKER = read("background.js");

const loadShared = () => {
  // eslint-disable-next-line no-new-func
  return new Function(`${SHARED}; return GCC;`)();
};

const loadEngine = () => {
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = { runKind: "cleanup" };
  window.alert = () => {};
  // eslint-disable-next-line no-new-func
  new Function(ENGINE)();
  return window.GCC_INTERNALS;
};

beforeEach(() => {
  document.body.innerHTML = "";
  chrome.runtime.sendMessage = jest.fn();
  chrome.runtime.onMessage = { addListener: jest.fn() };
});

describe("the X-ray floor and its tiers move together", () => {
  test("the purge floor is the smallest tier the scan actually counts", () => {
    const GCC = loadShared();
    const I = loadEngine();
    const tiers = I.STORAGE_XRAY.TIER_QUERIES;
    const smallest = tiers[tiers.length - 1];
    const floor = GCC.storageXray.LIMITS.PURGE_SIZE_FLOOR;
    // Not "both say 100k": the tier table is the source, and the floor
    // is required to name whatever the last tier's larger: term is. A
    // future sixth tier moves both or fails here.
    expect(smallest.startsWith(floor + " ")).toBe(true);
  });

  test("the scan now reaches below 5 MB at all", () => {
    const I = loadEngine();
    const floors = I.STORAGE_XRAY.TIER_QUERIES.map((q) => I.estimateMbPerEmail(q));
    expect(Math.min(...floors)).toBeLessThan(1);
    // Strictly descending, so no message is credited twice.
    for (let i = 1; i < floors.length; i++) expect(floors[i]).toBeLessThan(floors[i - 1]);
  });

  test("a bare larger: number is read as bytes, which is what Gmail means", () => {
    const I = loadEngine();
    // Gmail documents larger:/smaller: as taking bytes, with K and M as
    // suffixes. This defaulted a suffixless number to MEGABYTES, so a
    // custom rule written the way Gmail's own help writes it,
    // larger:5000000, estimated five million MB per email.
    expect(I.estimateMbPerEmail("larger:5000000")).toBeCloseTo(5000000 / (1024 * 1024), 5);
    expect(I.estimateMbPerEmail("larger:5M")).toBe(5);
    expect(I.estimateMbPerEmail("larger:100k")).toBeCloseTo(100 / 1024, 5);
  });
});

describe("the census clear cannot widen into a whole-mailbox delete", () => {
  test("every census age is one the query chunker honours", () => {
    const GCC = loadShared();
    for (const age of GCC.census.LIMITS.VALID_AGES) {
      expect(GCC.storageXray.LIMITS.VALID_AGES).toContain(age);
    }
  });

  test("an unrecognised age falls back to six months, never to no age", () => {
    const GCC = loadShared();
    // "3m" is a perfectly reasonable thing for a caller to pass and the
    // chunker does not know it. Silently dropping it would emit
    // `from:(a OR b)` with no age at all.
    for (const age of ["3m", "1m", "", null, undefined, "junk", ") is:starred"]) {
      const [q] = GCC.census.purgeQueries(["a@x.com"], age);
      expect(q).toMatch(/ older_than:\d+[mya]/);
    }
  });

  test("no size floor, because the census never measured one", () => {
    const GCC = loadShared();
    const [q] = GCC.census.purgeQueries(["a@x.com", "b@y.com"], "6m");
    expect(q).toBe("from:(a@x.com OR b@y.com) older_than:6m");
    expect(q).not.toContain("larger:");
  });

  test("addresses cannot break out of the from group", () => {
    const GCC = loadShared();
    const out = GCC.census.purgeQueries(
      ["-evil@x.com", ") is:starred", "ok@x.com", "a b@x.com"],
      "6m"
    );
    expect(out.join(" ")).toBe("from:(ok@x.com) older_than:6m");
  });
});

describe("the smart card's idea of large is its own", () => {
  test("moving the X-ray floor does not move what a purgeLarge card deletes", () => {
    const GCC = loadShared();
    const rule = GCC.smart.buildActionRule({ email: "news@shop.com" }, "purgeLarge");
    expect(rule.query).toContain(GCC.smart.LIMITS.LARGE_FLOOR);
    expect(rule.query).not.toContain(GCC.storageXray.LIMITS.PURGE_SIZE_FLOOR);
  });

  test("the engine's own action query still matches it", () => {
    const GCC = loadShared();
    const I = loadEngine();
    expect(I.smartActionQuery("news@shop.com", "purgeLarge"))
      .toContain(GCC.smart.LIMITS.LARGE_FLOOR);
  });
});

describe("engine copies match shared.js", () => {
  test("discovery queries are the same list, and name no category", () => {
    const GCC = loadShared();
    const I = loadEngine();
    expect(I.buildCensusDiscoveryQueries()).toEqual([...GCC.census.discoveryQueries()]);
    // The entire point of the release: not one discovery query is
    // shaped like a Gmail category, because the mailbox this was built
    // against answered zero to the ones that are.
    for (const q of I.buildCensusDiscoveryQueries()) {
      expect(q).not.toContain("category:");
      // Nothing counts the user's own sent mail as a top sender.
      expect(q).toContain("-in:sent");
    }
  });

  test("measure queries are the same three, and the size pair is cumulative", () => {
    const GCC = loadShared();
    const I = loadEngine();
    const mine = I.buildCensusMeasureQueries("a@x.com");
    expect(mine).toEqual({ ...GCC.census.measureQueries("a@x.com") });
    // Cumulative, not disjoint: larger:100k contains larger:1M, which is
    // what makes the subtraction in senderFloorMb exact.
    expect(mine.atLeast100k).not.toContain("smaller:");
    expect(mine.atLeast1M).not.toContain("smaller:");
  });

  test("the floor arithmetic agrees across a matrix", () => {
    const GCC = loadShared();
    const I = loadEngine();
    const cases = [[0, 0], [0, 10], [10, 10], [3, 40], [40, 3], [1, 0], [999, 1000]];
    for (const [big, some] of cases) {
      expect(I.censusSenderFloorMb(big, some)).toBe(GCC.census.senderFloorMb(big, some));
    }
  });

  test("the floor credits nothing to mail under 100 KB", () => {
    const GCC = loadShared();
    // 12,000 messages, none of them over 100 KB, is still zero MB
    // claimed. That is what lets the copy say "at least" flatly.
    expect(GCC.census.senderFloorMb(0, 0)).toBe(0);
    // 10 over 1 MB and 40 over 100 KB: 10 MB plus 30 * 0.1.
    expect(GCC.census.senderFloorMb(10, 40)).toBeCloseTo(13, 5);
  });

  test("a smaller 100k count than 1M count keeps the larger claim", () => {
    const GCC = loadShared();
    // Gmail cannot really report fewer messages over 100 KB than over
    // 1 MB; if it does, one search was truncated.
    expect(GCC.census.senderFloorMb(40, 3)).toBe(GCC.census.senderFloorMb(40, 40));
  });

  test("the verdict function agrees with shared.js", () => {
    const GCC = loadShared();
    const I = loadEngine();
    const cases = [
      [{ count: 0, exact: true }, true],
      [{ count: 0, exact: false }, true],
      [{ count: 1, exact: true }, true],
      [{ count: 50, exact: false }, true]
    ];
    for (const [answer, ok] of cases) {
      const mine = I.verdictFromCount(answer, ok);
      const theirs = GCC.receipts.verdictFor({ ...answer, ok });
      expect(mine.verdict).toBe(theirs.verdict);
      expect(mine.since).toBe(theirs.since);
      expect(mine.sinceExact).toBe(theirs.sinceExact);
    }
  });
});

describe("a verdict is sound on a floor, and never invented from silence", () => {
  const GCC = loadShared();

  test("fifty rows Gmail would not total still proves they kept mailing", () => {
    const v = GCC.receipts.verdictFor({ count: 50, exact: false, ok: true });
    expect(v.verdict).toBe("still_sending");
    // The verdict survives the floor; the NUMBER beside it is marked.
    expect(v.sinceExact).toBe(false);
  });

  test("a settled empty result is the only thing that reads as stopped", () => {
    expect(GCC.receipts.verdictFor({ count: 0, exact: true, ok: true }).verdict).toBe("stopped");
  });

  test("a zero that is not exact is no verdict at all", () => {
    // A search that never resolved arrives here as zero too, and reading
    // that as "they stopped" is the oldest bug in this codebase pointed
    // at the one sentence the feature exists to say.
    expect(GCC.receipts.verdictFor({ count: 0, exact: false, ok: true }).verdict).toBe("unknown");
    expect(GCC.receipts.verdictFor({ ok: false }).verdict).toBe("unknown");
    expect(GCC.receipts.verdictFor(null).verdict).toBe("unknown");
  });
});

describe("the grace window is never shortened by rounding", () => {
  const GCC = loadShared();
  const DAY = 24 * 60 * 60 * 1000;

  test("a fresh receipt is not due", () => {
    const at = Date.now();
    expect(GCC.receipts.isDue({ email: "a@x.com", at }, at + DAY)).toBe(false);
  });

  test("it becomes due once the window has closed", () => {
    const at = Date.now();
    const after = at + (GCC.receipts.LIMITS.GRACE_DAYS + 1) * DAY;
    expect(GCC.receipts.isDue({ email: "a@x.com", at }, after)).toBe(true);
  });

  test("the query starts the day AFTER the window ends", () => {
    const at = Date.UTC(2026, 0, 1, 12, 0, 0);
    const end = GCC.receipts.graceEndsAt(at);
    const expected = new Date(end + DAY);
    const pad = (n) => String(n).padStart(2, "0");
    // Day granularity means a same-day boundary would let mail sent
    // hours BEFORE the deadline count as mail sent after it, and the
    // output of this function is an accusation.
    expect(GCC.receipts.verifyDate(at)).toBe(
      `${expected.getFullYear()}/${pad(expected.getMonth() + 1)}/${pad(expected.getDate())}`
    );
  });

  test("a settled receipt is not re-checked immediately", () => {
    const at = Date.now() - 60 * DAY;
    const checkedAt = Date.now();
    expect(GCC.receipts.isDue({ email: "a@x.com", at, checkedAt }, Date.now())).toBe(false);
    const later = Date.now() + (GCC.receipts.LIMITS.RECHECK_DAYS + 1) * DAY;
    expect(GCC.receipts.isDue({ email: "a@x.com", at, checkedAt }, later)).toBe(true);
  });
});

describe("verification targets are rebuilt, never accepted", () => {
  test("a leading dash is refused, because it is Gmail's negation operator", () => {
    const I = loadEngine();
    // from:(-news@attacker.example) returns every OTHER conversation,
    // which would report the whole mailbox as proof this one sender
    // ignored the user.
    const out = I.buildVerifyTargets([
      { email: "-evil@x.com", after: "2026/01/01" },
      { email: "ok@x.com", after: "2026/01/01" }
    ]);
    expect(out.map((t) => t.email)).toEqual(["ok@x.com"]);
  });

  test("a malformed date is skipped rather than guessed at", () => {
    const I = loadEngine();
    for (const after of ["2026-01-01", "01/01/2026", "", "2026/1/1", ") is:starred", null]) {
      expect(I.buildVerifyTargets([{ email: "ok@x.com", after }])).toEqual([]);
    }
  });

  test("the query is built here, not taken from the caller", () => {
    const I = loadEngine();
    const [t] = I.buildVerifyTargets([
      { email: "ok@x.com", after: "2026/01/01", query: "in:trash" }
    ]);
    expect(t.query).toBe("from:(ok@x.com) after:2026/01/01");
  });
});

describe("census rules only ever come from senders the user ticked", () => {
  test("no ticks, no rules", () => {
    window.GCC_TEST_MODE = true;
    window.GMAIL_CLEANER_CONFIG = { runKind: "cleanup" };
    window.alert = () => {};
    // eslint-disable-next-line no-new-func
    new Function(ENGINE)();
    expect(window.GCC_INTERNALS.censusRules()).toEqual([]);
  });

  test("ticked senders become an age-scoped from group", () => {
    window.GCC_TEST_MODE = true;
    window.GMAIL_CLEANER_CONFIG = {
      runKind: "cleanup",
      censusSenders: ["a@x.com", "b@y.com"]
    };
    window.alert = () => {};
    // eslint-disable-next-line no-new-func
    new Function(ENGINE)();
    const rules = window.GCC_INTERNALS.censusRules();
    expect(rules).toEqual(["from:(a@x.com OR b@y.com) older_than:6m"]);
  });

  test("a rule never reaches the engine without an age scope", () => {
    window.GCC_TEST_MODE = true;
    window.GMAIL_CLEANER_CONFIG = {
      runKind: "cleanup",
      censusSenders: Array.from({ length: 25 }, (_, i) => `sender${i}@averylongdomainname.example.com`)
    };
    window.alert = () => {};
    // eslint-disable-next-line no-new-func
    new Function(ENGINE)();
    const rules = window.GCC_INTERNALS.censusRules();
    expect(rules.length).toBeGreaterThan(1); // packed into several groups
    for (const r of rules) {
      expect(r).toMatch(/^from:\([^)]+\) older_than:6m$/);
      expect(r.length).toBeLessThanOrEqual(512);
    }
  });

  test("the popup only fills that config for a paid licence", () => {
    // Source pin: the gate is in buildConfig, and it is on the TICKS as
    // well as the licence. A scan finding that a bank mails you often is
    // not permission to delete the bank's mail.
    const POPUP = read("popup.js");
    expect(POPUP).toContain("state.subs.licenseActive && state.census.checked.size");
  });
});

describe("the worker's copies stay in step with shared.js", () => {
  test("the receipt cap matches", () => {
    const GCC = loadShared();
    const m = WORKER.match(/const RECEIPT_CAP = (\d+);/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBe(GCC.receipts.LIMITS.MAX);
  });

  test("the worker owns no clock for the grace window", () => {
    // Deliberate: the one place that reads a clock should be the one
    // place that owns the rule. The worker stores receipts and never
    // decides which are due.
    expect(WORKER).not.toMatch(/RECEIPT_GRACE_DAYS/);
  });

  test("an unknown verdict never overwrites one that answered", () => {
    const fn = WORKER.slice(
      WORKER.indexOf("async function recordVerifyResults"),
      WORKER.indexOf("async function recordVerifyResults") + 2200
    );
    expect(fn).toMatch(/verdict === "unknown" && prev\.verdict/);
  });

  test("a receipt is written only for a sender that really unsubscribed", () => {
    const fn = WORKER.slice(
      WORKER.indexOf("async function recordReceipts"),
      WORKER.indexOf("async function recordReceipts") + 1800
    );
    expect(fn).toMatch(/!== "unsubscribed"\) continue;/);
  });
});

describe("nothing here reaches the network", () => {
  test("the shipped files still contain no request API at all", () => {
    // The one claim competitors cannot match, and the census and the
    // verification are both search-and-read features that would have
    // been far easier to write with an API call.
    const NETWORK = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource/;
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
    for (const f of ["shared.js", "contentScript.js", "background.js", "popup.js", "options.js"]) {
      expect(strip(read(f))).not.toMatch(NETWORK);
    }
  });

  test("the feature request form is a mailto and nothing else", () => {
    const OPTIONS = read("options.js");
    const fn = OPTIONS.slice(OPTIONS.indexOf("const initFeatureRequest"));
    expect(fn).toContain('"mailto:" + GCC.license.PRO.SUPPORT_EMAIL');
    expect(fn).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon/);
  });
});
