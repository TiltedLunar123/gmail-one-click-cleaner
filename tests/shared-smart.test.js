/**
 * @jest-environment node
 *
 * GCC.smart (7.8): the pure policy behind Smart Suggestions. The
 * heaviest coverage sits on the two safety properties: hard vetoes
 * beat any score, and every query builder rejects anything that is
 * not a strict email (the injection boundary).
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

const S = GCC.smart;
const DAY = 24 * 60 * 60 * 1000;

const mkSender = (over = {}) => ({
  email: "news@shop.com",
  name: "Shop News",
  estCount: 142,
  signals: { count: 142, unreadRatio: 0.96, oldShare: 0.7, shape: true },
  ...over
});

describe("GCC.smart.score", () => {
  test("zero mail scores zero", () => {
    expect(S.score({ count: 0, unreadRatio: 1, oldShare: 1, shape: true })).toBe(0);
    expect(S.score(null)).toBe(0);
    expect(S.score({})).toBe(0);
  });

  test("all-signal clutter scores near the top, and never above 100", () => {
    const s = S.score({ count: 5000, unreadRatio: 1, oldShare: 1, shape: true });
    expect(s).toBeGreaterThanOrEqual(90);
    expect(s).toBeLessThanOrEqual(100);
  });

  test("unread ratio is the strongest signal", () => {
    const base = { count: 100, oldShare: 0, shape: false };
    const unread = S.score({ ...base, unreadRatio: 1 }) - S.score({ ...base, unreadRatio: 0 });
    const old = S.score({ ...base, unreadRatio: 0, oldShare: 1 }) - S.score({ ...base, unreadRatio: 0 });
    const shape = S.score({ ...base, unreadRatio: 0, shape: true }) - S.score({ ...base, unreadRatio: 0 });
    expect(unread).toBeGreaterThan(old);
    expect(unread).toBeGreaterThan(shape);
  });

  test("volume is log-scaled so sheer count cannot dominate", () => {
    const quiet = S.score({ count: 10, unreadRatio: 0.9, oldShare: 0.5, shape: true });
    const loud = S.score({ count: 100000, unreadRatio: 0, oldShare: 0, shape: false });
    expect(quiet).toBeGreaterThan(loud);
  });

  test("junk ratios clamp instead of exploding", () => {
    const s = S.score({ count: 50, unreadRatio: 9, oldShare: -3, shape: false });
    expect(s).toBeLessThanOrEqual(100);
    expect(s).toBeGreaterThan(0);
  });
});

describe("GCC.smart.vetoReasons: hard vetoes beat any score", () => {
  test("clean sender has no veto reasons", () => {
    expect(S.vetoReasons(mkSender(), { whitelist: [], protectKeywords: [] })).toEqual([]);
  });

  test("engine flags (starred, corresponded) veto", () => {
    expect(S.vetoReasons(mkSender({ signals: { count: 5, starred: true } }), {}))
      .toContain("starred");
    expect(S.vetoReasons(mkSender({ signals: { count: 5, corresponded: true } }), {}))
      .toContain("correspondence");
  });

  test("whitelist match vetoes: exact, wildcard, domain, subdomain", () => {
    const s = mkSender();
    expect(S.vetoReasons(s, { whitelist: ["news@shop.com"] })).toContain("whitelisted");
    expect(S.vetoReasons(s, { whitelist: ["*@shop.com"] })).toContain("whitelisted");
    expect(S.vetoReasons(s, { whitelist: ["shop.com"] })).toContain("whitelisted");
    expect(S.vetoReasons(mkSender({ email: "a@mail.shop.com" }), { whitelist: ["shop.com"] }))
      .toContain("whitelisted");
    // A different domain does not: no suffix bleed.
    expect(S.vetoReasons(mkSender({ email: "a@notshop.com" }), { whitelist: ["shop.com"] }))
      .toEqual([]);
  });

  test("protected keyword in address or display name vetoes", () => {
    expect(S.vetoReasons(mkSender({ email: "invoices@shop.com" }), { protectKeywords: ["invoice"] }))
      .toContain("protected");
    expect(S.vetoReasons(mkSender({ name: "Tax Documents" }), { protectKeywords: ["tax"] }))
      .toContain("protected");
  });

  test("recommend drops a max-score vetoed sender but keeps a low scorer", () => {
    const vetoed = mkSender({
      email: "huge@clutter.com",
      signals: { count: 99999, unreadRatio: 1, oldShare: 1, shape: true }
    });
    const small = mkSender({
      email: "small@elsewhere.com",
      signals: { count: 3, unreadRatio: 0.1, oldShare: 0, shape: false },
      estCount: 3
    });
    const out = S.recommend([vetoed, small], null, { whitelist: ["clutter.com"] });
    expect(out.map((s) => s.email)).toEqual(["small@elsewhere.com"]);
  });
});

describe("GCC.smart feedback: decay, boost and the bound", () => {
  const NOW = 1750000000000;

  test("recordFeedback stores normalized entries and ignores junk", () => {
    let fb = S.recordFeedback(null, "News@Shop.com ", "dismissed", NOW);
    expect(fb.bySender["news@shop.com"]).toEqual({ action: "dismissed", at: NOW });
    fb = S.recordFeedback(fb, "not an email", "dismissed", NOW);
    fb = S.recordFeedback(fb, "a@b.co", "purged", NOW);
    expect(Object.keys(fb.bySender)).toEqual(["news@shop.com"]);
  });

  test("a dismissal silences the sender for 90 days, then decays", () => {
    const fb = S.recordFeedback(null, "news@shop.com", "dismissed", NOW);
    expect(S.isDismissed(fb, "news@shop.com", NOW + 89 * DAY)).toBe(true);
    expect(S.isDismissed(fb, "news@shop.com", NOW + 91 * DAY)).toBe(false);
    expect(S.rankSenders([mkSender()], fb, NOW + DAY)).toEqual([]);
    expect(S.rankSenders([mkSender()], fb, NOW + 91 * DAY)).toHaveLength(1);
  });

  test("an applied sender boosts same-domain senders in ranking", () => {
    const a = mkSender({ email: "deals@shop.com", signals: { count: 100, unreadRatio: 0.5 }, estCount: 100 });
    const b = mkSender({ email: "deals@other.com", signals: { count: 100, unreadRatio: 0.5 }, estCount: 100 });
    const tied = S.rankSenders([a, b], null, NOW).map((s) => s.score);
    expect(tied[0]).toBe(tied[1]);
    const fb = S.recordFeedback(null, "news@shop.com", "applied", NOW);
    const ranked = S.rankSenders([b, a], fb, NOW);
    expect(ranked[0].email).toBe("deals@shop.com");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test("the map is bounded: past the cap the oldest entries evict first", () => {
    let fb = { bySender: {} };
    for (let i = 0; i < S.LIMITS.MAX_FEEDBACK; i++) {
      fb = S.recordFeedback(fb, `sender${i}@bulk.com`, "dismissed", NOW + i);
    }
    expect(Object.keys(fb.bySender)).toHaveLength(S.LIMITS.MAX_FEEDBACK);
    fb = S.recordFeedback(fb, "newest@bulk.com", "dismissed", NOW + 999999);
    expect(Object.keys(fb.bySender)).toHaveLength(S.LIMITS.MAX_FEEDBACK);
    expect(fb.bySender["sender0@bulk.com"]).toBeUndefined();
    expect(fb.bySender["newest@bulk.com"]).toBeDefined();
    expect(fb.bySender["sender1@bulk.com"]).toBeDefined();
  });
});

describe("GCC.smart.buildActionRule", () => {
  const sender = mkSender();

  test("deleteOld: age-scoped from query, delete mode", () => {
    expect(S.buildActionRule(sender, "deleteOld")).toEqual({
      runKind: "cleanup",
      query: "from:(news@shop.com) older_than:6m",
      archive: false
    });
  });

  test("archiveAll: bare from query, archive mode", () => {
    expect(S.buildActionRule(sender, "archiveAll")).toEqual({
      runKind: "cleanup",
      query: "from:(news@shop.com)",
      archive: true
    });
  });

  test("purgeLarge reuses the X-ray purge query builder", () => {
    const rule = S.buildActionRule(sender, "purgeLarge");
    expect(rule.query).toBe(GCC.storageXray.buildPurgeQuery(["news@shop.com"], "6m"));
    expect(rule.query).toContain("larger:5M");
    expect(rule.archive).toBe(false);
  });

  test("unsubscribe maps onto the existing Pro unsubscribe path", () => {
    expect(S.buildActionRule(sender, "unsubscribe")).toEqual({
      runKind: "unsubscribe",
      senders: ["news@shop.com"]
    });
  });

  test("unknown actions and invalid senders return null", () => {
    expect(S.buildActionRule(sender, "deleteEverything")).toBeNull();
    expect(S.buildActionRule({ email: "" }, "deleteOld")).toBeNull();
    expect(S.buildActionRule(null, "deleteOld")).toBeNull();
  });
});

describe("GCC.smart injection boundary: strict email or nothing", () => {
  const SMUGGLERS = [
    "x@y.com) OR (is:starred",
    "a b@c.com",
    "a@b.com OR in:sent",
    '"quoted"@host.com',
    "paren(thesis@x.com",
    "new\nline@x.com",
    "in:sent",
    "-from:me@x.com",
    "user@no-tld"
  ];

  test.each(SMUGGLERS)("buildActionRule rejects %j for every action", (email) => {
    for (const action of S.ACTIONS) {
      expect(S.buildActionRule({ email }, action)).toBeNull();
    }
  });

  test("buildBulkRule drops smugglers and keeps the valid remainder", () => {
    const query = S.buildBulkRule([...SMUGGLERS, "ok@fine.com"]);
    expect(query).toBe("from:(ok@fine.com) older_than:6m");
  });

  test("buildBulkRule returns empty string when nothing valid survives", () => {
    expect(S.buildBulkRule(SMUGGLERS)).toBe("");
    expect(S.buildBulkRule([])).toBe("");
    expect(S.buildBulkRule(null)).toBe("");
  });

  test("buildBulkRule caps the sender group", () => {
    const emails = Array.from({ length: 40 }, (_, i) => `s${i}@bulk.com`);
    const query = S.buildBulkRule(emails);
    expect(query.match(/@bulk\.com/g)).toHaveLength(S.LIMITS.MAX_BULK_PER_RUN);
  });

  test("rankSenders drops senders whose email fails the regex", () => {
    const out = S.rankSenders(
      [mkSender({ email: "x@y.com) OR (is:starred" }), mkSender()],
      null
    );
    expect(out.map((s) => s.email)).toEqual(["news@shop.com"]);
  });
});

describe("GCC.smart presentation policy", () => {
  test("reasonText reads as plain English from real signals", () => {
    expect(S.reasonText(mkSender())).toBe(
      "142 emails, 96% unread, mostly older than 6 months, no-reply sender"
    );
  });

  test("reasonText mentions size only when it is meaningful", () => {
    const heavy = mkSender({
      signals: { count: 20, unreadRatio: 0, oldShare: 0, shape: false, estMb: 250 },
      estCount: 20
    });
    expect(S.reasonText(heavy)).toBe("20 emails, at least 250.0 MB");
  });

  test("primaryAction: purge for hogs, delete for unread, archive otherwise", () => {
    expect(S.primaryAction(mkSender({ signals: { count: 5, estMb: 300 } }))).toBe("purgeLarge");
    expect(S.primaryAction(mkSender())).toBe("deleteOld");
    expect(S.primaryAction(mkSender({ signals: { count: 40, unreadRatio: 0.1 } }))).toBe("archiveAll");
  });

  test("rankSenders caps the list for the popup", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      mkSender({ email: `s${i}@bulk.com`, estCount: i })
    );
    expect(S.rankSenders(many, null)).toHaveLength(S.LIMITS.MAX_LIST);
  });

  test("smartUpsellLine leads with the hidden count", () => {
    expect(GCC.popupUi.smartUpsellLine(7)).toContain("7 more suggestions");
    expect(GCC.popupUi.smartUpsellLine(7)).toContain("$5");
    expect(GCC.popupUi.smartUpsellLine(0)).toContain("$5");
  });
});
