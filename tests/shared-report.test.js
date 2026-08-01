/**
 * @jest-environment jsdom
 *
 * GCC.report (8.0): the Mailbox Report's pure logic. Two things here
 * are load-bearing beyond ordinary shape checks.
 *
 * 1. Every band query has to survive GCC.validateGmailQuery. A band
 *    whose query trips the dangerous-token matcher would be dropped at
 *    run time with no visible failure: the report would list a step the
 *    purge silently refuses to run.
 * 2. contentScript.js carries its own REPORT_BANDS copy because the
 *    engine cannot reach GCC inside Gmail. The engine is loaded here
 *    and pinned against the shared table, exactly as
 *    contentScript-smart-scan.test.js pins scoreSmartSignals.
 *
 * The environment is jsdom rather than node only so the engine can be
 * loaded for that pin; jsdom's host is not mail.google.com, so loading
 * the content script is side-effect free.
 */
const fs = require("fs");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const iifeMatch = code.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
  {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      className: "", setAttribute: () => {}, appendChild: () => {},
      style: {}, classList: { add: () => {}, remove: () => {} },
      remove: () => {}
    }),
    addEventListener: () => {}
  },
  {},
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

const R = GCC.report;
const ALL_IDS = R.BANDS.map((b) => b.id);
const SIZE_BANDS = R.BANDS.filter((b) => b.kind === "size");

const ENGINE_SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function loadEngine() {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = {};
  window.alert = () => {};
  document.body.innerHTML = "";
  // eslint-disable-next-line no-new-func
  new Function(ENGINE_SRC)();
  return window.GCC_INTERNALS;
}

describe("GCC.report.BANDS", () => {
  test("the table and every band in it are frozen", () => {
    expect(Object.isFrozen(R.BANDS)).toBe(true);
    for (const band of R.BANDS) expect(Object.isFrozen(band)).toBe(true);
  });

  test("band ids are unique", () => {
    expect(new Set(ALL_IDS).size).toBe(R.BANDS.length);
  });

  test("every band query passes the project's own validator", () => {
    for (const band of R.BANDS) {
      const check = GCC.validateGmailQuery(band.query);
      // Named in the assertion so a failure says WHICH band broke.
      expect(`${band.id}:${check.valid}`).toBe(`${band.id}:true`);
      expect(`${band.id}:${check.errors.join("|")}`).toBe(`${band.id}:`);
    }
  });

  test("the headline query passes the validator too", () => {
    const check = GCC.validateGmailQuery(R.HEADLINE_QUERY);
    expect(check.valid).toBe(true);
    expect(check.errors).toEqual([]);
  });

  test("only size bands carry an MB floor, and they descend", () => {
    for (const band of R.BANDS) {
      expect(`${band.id}:${band.mbFloor > 0}`).toBe(`${band.id}:${band.kind === "size"}`);
    }
    expect(SIZE_BANDS.map((b) => b.mbFloor)).toEqual([25, 10, 5]);
  });

  test("the engine's REPORT_BANDS copy is identical to GCC.report.BANDS", () => {
    const I = loadEngine();
    const shape = (list) => list.map((b) => ({
      id: b.id, kind: b.kind, query: b.query, mbFloor: b.mbFloor, action: b.action
    }));
    expect(shape(I.REPORT_BANDS)).toEqual(shape(R.BANDS));
  });

  test("the engine's query budget matches the shared limit", () => {
    const I = loadEngine();
    expect(I.REPORT.MAX_QUERIES).toBe(R.LIMITS.MAX_QUERIES);
    expect(I.REPORT.HEADLINE_QUERY).toBe(R.HEADLINE_QUERY);
  });
});

describe("GCC.report.buildQueries", () => {
  test("headline first, then one entry per band", () => {
    const out = R.buildQueries();
    expect(out[0].query).toBe(R.HEADLINE_QUERY);
    expect(out.slice(1).map((q) => q.id)).toEqual(ALL_IDS);
    expect(out.slice(1).map((q) => q.query)).toEqual(R.BANDS.map((b) => b.query));
  });

  test("stays inside the query budget", () => {
    expect(R.buildQueries().length).toBeLessThanOrEqual(R.LIMITS.MAX_QUERIES);
  });
});

describe("GCC.report.foldBands", () => {
  test("a missing id becomes a zero-count band, never a gap", () => {
    const out = R.foldBands({});
    expect(out.map((b) => b.id)).toEqual(ALL_IDS);
    for (const band of out) {
      expect(band.count).toBe(0);
      expect(band.estMb).toBe(0);
    }
  });

  test("junk counts coerce to 0 rather than poisoning the report", () => {
    const out = R.foldBands({
      sizeHuge: -5,
      sizeLarge: NaN,
      sizeBig: Infinity,
      promotions: "not a number",
      social: null,
      updates: undefined,
      forums: {},
      newsletters: -Infinity
    });
    const byId = Object.fromEntries(out.map((b) => [b.id, b]));
    for (const id of ["sizeHuge", "sizeLarge", "sizeBig", "promotions", "social", "updates", "forums", "newsletters"]) {
      expect(`${id}:${byId[id].count}`).toBe(`${id}:0`);
      expect(`${id}:${byId[id].estMb}`).toBe(`${id}:0`);
    }
  });

  test("a numeric string is read as its number and clamped to the ceiling", () => {
    const byId = Object.fromEntries(R.foldBands({ sizeHuge: "12", sizeLarge: 1e12 }).map((b) => [b.id, b]));
    expect(byId.sizeHuge.count).toBe(12);
    expect(byId.sizeHuge.estMb).toBe(300);
    expect(byId.sizeLarge.count).toBe(R.LIMITS.MAX_COUNT);
  });

  test("unknown keys in the input are ignored", () => {
    const out = R.foldBands({ bogus: 500, "in:sent": 900, promotions: 3 });
    expect(out.map((b) => b.id)).toEqual(ALL_IDS);
    expect(out.find((b) => b.id === "promotions").count).toBe(3);
  });

  test("estMb is non-zero only for size bands", () => {
    const out = R.foldBands(Object.fromEntries(ALL_IDS.map((id) => [id, 4])));
    for (const band of out) {
      expect(`${band.id}:${band.estMb > 0}`).toBe(`${band.id}:${band.kind === "size"}`);
    }
  });

  test("junk input is treated as an empty count map", () => {
    for (const junk of [null, undefined, "nope", 42, []]) {
      expect(R.foldBands(junk).map((b) => b.count)).toEqual(ALL_IDS.map(() => 0));
    }
  });
});

describe("GCC.report.rankBands", () => {
  test("ranks by MB, then count, then band-definition order", () => {
    const out = R.rankBands(R.foldBands({
      sizeBig: 10,        // 50 MB
      sizeHuge: 4,        // 100 MB
      promotions: 900,
      social: 900,
      inboxOld: 1
    }));
    expect(out.slice(0, 2).map((b) => b.id)).toEqual(["sizeHuge", "sizeBig"]);
    // promotions and social tie on MB (0) and count (900): the band
    // table's own order breaks it, not object key order.
    expect(out.slice(2, 4).map((b) => b.id)).toEqual(["promotions", "social"]);
  });

  test("an exact tie falls back to definition order whatever the input order", () => {
    const tied = ALL_IDS.map((id) => ({ id, count: 7, estMb: 0 }));
    expect(R.rankBands(tied).map((b) => b.id)).toEqual(ALL_IDS);
    expect(R.rankBands([...tied].reverse()).map((b) => b.id)).toEqual(ALL_IDS);
  });

  test("key insertion order in the raw counts cannot change the ranking", () => {
    const forward = {};
    for (const id of ALL_IDS) forward[id] = 25;
    const backward = {};
    for (const id of [...ALL_IDS].reverse()) backward[id] = 25;

    expect(R.rankBands(R.foldBands(forward)).map((b) => b.id))
      .toEqual(R.rankBands(R.foldBands(backward)).map((b) => b.id));
  });

  test("drops unknown ids and survives junk input", () => {
    expect(R.rankBands([{ id: "nope", count: 9 }, null, "junk"])).toEqual([]);
    expect(R.rankBands(null)).toEqual([]);
    expect(R.rankBands(undefined)).toEqual([]);
    expect(R.rankBands("not-an-array")).toEqual([]);
  });

  test("kind, action and query always come from the band table, not the caller", () => {
    const [out] = R.rankBands([
      { id: "promotions", kind: "size", action: "archive", query: "is:starred", count: 2 }
    ]);
    expect(out.kind).toBe("noise");
    expect(out.action).toBe("delete");
    expect(out.query).toBe("category:promotions older_than:6m");
  });
});

describe("GCC.report.freeBandId", () => {
  test("returns the top-ranked band that actually has mail in it", () => {
    // sizeHuge ranks first but is empty, so the free band is the next
    // ranked band with a count.
    expect(R.freeBandId(R.foldBands({ sizeHuge: 0, sizeBig: 2, promotions: 40 })))
      .toBe("sizeBig");
    expect(R.freeBandId(R.foldBands({ promotions: 40 }))).toBe("promotions");
  });

  test("an all-zero report has no free band", () => {
    expect(R.freeBandId(R.foldBands({}))).toBeNull();
  });

  test("returns null for an empty list or junk input", () => {
    expect(R.freeBandId([])).toBeNull();
    expect(R.freeBandId(null)).toBeNull();
    expect(R.freeBandId(undefined)).toBeNull();
    expect(R.freeBandId("nope")).toBeNull();
    expect(R.freeBandId(42)).toBeNull();
  });

  test("is stable: the same scan always yields the same free band", () => {
    const counts = { sizeBig: 3, promotions: 120, social: 120 };
    const first = R.freeBandId(R.foldBands(counts));
    for (let i = 0; i < 5; i++) {
      expect(R.freeBandId(R.foldBands(counts))).toBe(first);
    }
  });
});

describe("GCC.report.totals", () => {
  test("largeMb sums the size bands only: the others overlap", () => {
    const bands = R.foldBands({
      sizeHuge: 2,        // 50 MB
      sizeLarge: 3,       // 30 MB
      sizeBig: 4,         // 20 MB
      promotions: 5000,
      inboxAncient: 900
    });
    expect(R.totals(bands).largeMb).toBe(100);
    expect(R.totals(bands).bandedCount).toBe(5909);
  });

  test("largeMb never exceeds count * mbFloor over the size bands", () => {
    const CASES = [
      {},
      { sizeHuge: 1 },
      { sizeHuge: 12, sizeLarge: 300, sizeBig: 4000 },
      { sizeHuge: 7, promotions: 90000, inboxOld: 4000, newsletters: 12000 }
    ];
    for (const counts of CASES) {
      const bands = R.foldBands(counts);
      const ceiling = bands
        .filter((b) => b.kind === "size")
        .reduce((sum, b) => sum + b.count * R.BANDS.find((d) => d.id === b.id).mbFloor, 0);
      expect(R.totals(bands).largeMb).toBeLessThanOrEqual(ceiling);
    }
  });

  test("an MB figure attached to a non-size band is never counted", () => {
    // The estimate is a lower bound and stays one: only the disjoint
    // larger:/smaller: bands may contribute megabytes.
    expect(R.totals([{ id: "promotions", count: 10, estMb: 99999 }]).largeMb).toBe(0);
    expect(R.totals([{ id: "inboxAncient", count: 10, estMb: 99999 }]).largeMb).toBe(0);
  });

  test("junk input totals to zero rather than NaN", () => {
    expect(R.totals(null)).toEqual({ largeMb: 0, bandedCount: 0 });
    expect(R.totals([])).toEqual({ largeMb: 0, bandedCount: 0 });
  });
});

describe("GCC.report.bandPurgeRules", () => {
  test("maps known ids to their band queries, in the order given", () => {
    expect(R.bandPurgeRules(["promotions", "sizeHuge"]))
      .toEqual(["category:promotions older_than:6m", "larger:25M older_than:6m"]);
  });

  test("drops unknown ids, non-strings and duplicates", () => {
    expect(R.bandPurgeRules([
      "sizeHuge", "sizeHuge", "nope", 42, null, { id: "promotions" }, "inboxOld"
    ])).toEqual(["larger:25M older_than:6m", "in:inbox older_than:1y newer_than:5y"]);
  });

  test("no emitted query trips the validator", () => {
    for (const query of R.bandPurgeRules(ALL_IDS)) {
      const check = GCC.validateGmailQuery(query);
      expect(`${query}:${check.valid}`).toBe(`${query}:true`);
      expect(query.length).toBeLessThanOrEqual(GCC.MAX_QUERY_CHARS);
    }
  });

  test("caps at MAX_PLAN_RULES", () => {
    const out = R.bandPurgeRules([...ALL_IDS, ...ALL_IDS]);
    expect(out.length).toBeLessThanOrEqual(R.LIMITS.MAX_PLAN_RULES);
    expect(new Set(out).size).toBe(out.length);
  });

  test("returns [] for non-array input", () => {
    expect(R.bandPurgeRules(null)).toEqual([]);
    expect(R.bandPurgeRules(undefined)).toEqual([]);
    expect(R.bandPurgeRules("sizeHuge")).toEqual([]);
    expect(R.bandPurgeRules({ 0: "sizeHuge" })).toEqual([]);
  });
});

describe("GCC.report.isBandUnlocked", () => {
  const bands = R.foldBands({ sizeBig: 4, promotions: 400, social: 20 });
  const free = R.freeBandId(bands);

  test("a licensed user has every known band, and nothing else", () => {
    for (const id of ALL_IDS) {
      expect(`${id}:${R.isBandUnlocked(id, bands, true)}`).toBe(`${id}:true`);
    }
    expect(R.isBandUnlocked("nope", bands, true)).toBe(false);
    expect(R.isBandUnlocked("", bands, true)).toBe(false);
    expect(R.isBandUnlocked(null, bands, true)).toBe(false);
  });

  test("a free user has exactly the free band", () => {
    expect(free).toBe("sizeBig");
    for (const id of ALL_IDS) {
      expect(`${id}:${R.isBandUnlocked(id, bands, false)}`).toBe(`${id}:${id === free}`);
    }
  });

  test("an all-zero report unlocks nothing for a free user", () => {
    const empty = R.foldBands({});
    for (const id of ALL_IDS) {
      expect(`${id}:${R.isBandUnlocked(id, empty, false)}`).toBe(`${id}:false`);
    }
  });
});

describe("GCC.report.upsellLine", () => {
  test("never returns an empty string", () => {
    const CASES = [
      R.foldBands({}),
      R.foldBands({ promotions: 1 }),
      R.foldBands({ sizeHuge: 3, promotions: 900 }),
      R.foldBands({ sizeHuge: 3, promotions: 900, social: 4, inboxOld: 12 }),
      [],
      null
    ];
    for (const bands of CASES) {
      const line = R.upsellLine(bands);
      expect(typeof line).toBe("string");
      expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  test("claims no number when nothing is locked", () => {
    // Nothing behind the free band means there is no count to promise.
    for (const bands of [R.foldBands({}), R.foldBands({ promotions: 40 }), []]) {
      expect(R.upsellLine(bands)).not.toMatch(/\d+\s+more step/);
      expect(R.upsellLine(bands)).not.toMatch(/holding/);
    }
  });

  test("counts only the locked bands that actually hold mail", () => {
    // sizeBig is free; promotions + social are locked, so two steps.
    const line = R.upsellLine(R.foldBands({ sizeBig: 2, promotions: 40, social: 20, forums: 0 }));
    expect(line).toContain("2 more steps");
  });

  // 8.6: this line used to read "2 more steps are holding 60 emails" for
  // the case above, and 60 was promotions + social added together. The
  // bands overlap by design (an old 6MB promo sitting in the Inbox is in
  // sizeBig, promotions, newsletters and inboxOld at once), so summing
  // them counts one message up to four times, and this particular
  // sentence is read at the moment money changes hands. The file's own
  // rule, a few hundred lines above, is that band counts are never
  // summed into a headline figure.
  test("locked band counts are never summed, because the bands overlap", () => {
    const line = R.upsellLine(R.foldBands({ sizeBig: 2, promotions: 40, social: 20 }));
    expect(line).not.toContain("60");
    // The largest locked band is a measured number about one real band.
    expect(line).toContain("40");
  });

  test("a single locked step may state its own exact count", () => {
    // One band cannot overlap itself, so this number is honest.
    const line = R.upsellLine(R.foldBands({ sizeBig: 2, promotions: 40 }));
    expect(line).toContain("1 more step");
    expect(line).toContain("40");
  });

  test("the biggest locked band wins even when it is not the first", () => {
    const line = R.upsellLine(R.foldBands({ sizeBig: 900, promotions: 5, social: 4000 }));
    expect(line).toContain("4,000");
    expect(line).not.toContain("4,005");
  });
});
