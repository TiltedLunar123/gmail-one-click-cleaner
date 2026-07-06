/**
 * @jest-environment node
 *
 * GCC.storageXray (7.2): the purge-query builder is the security
 * boundary between UI-chosen senders and the Gmail query the engine
 * executes, so injection resistance gets the heaviest coverage.
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

const X = GCC.storageXray;

describe("GCC.storageXray.sanitizeEmails", () => {
  test("keeps valid emails, lowercased and deduped", () => {
    expect(X.sanitizeEmails(["Big@Files.com", "big@files.com", "a@b.co"]))
      .toEqual(["big@files.com", "a@b.co"]);
  });

  test("drops query-injection attempts and junk", () => {
    const out = X.sanitizeEmails([
      'x@y.com) OR (is:starred',
      "a b@c.com",
      '"quoted"@x.com',
      "no-at-sign.com",
      null,
      42,
      "legit@example.org"
    ]);
    expect(out).toEqual(["legit@example.org"]);
  });

  test("caps at MAX_PURGE_PER_RUN", () => {
    const many = Array.from({ length: 60 }, (_, i) => `s${i}@x.com`);
    expect(X.sanitizeEmails(many)).toHaveLength(X.LIMITS.MAX_PURGE_PER_RUN);
  });
});

describe("GCC.storageXray.buildPurgeQuery", () => {
  test("builds a from:(...) group with the size floor", () => {
    expect(X.buildPurgeQuery(["a@x.com", "b@y.com"]))
      .toBe("from:(a@x.com OR b@y.com) larger:5M");
  });

  test("appends a validated age filter", () => {
    expect(X.buildPurgeQuery(["a@x.com"], "6m"))
      .toBe("from:(a@x.com) larger:5M older_than:6m");
    expect(X.buildPurgeQuery(["a@x.com"], "1y")).toContain("older_than:1y");
  });

  test("rejects invalid age tokens instead of interpolating them", () => {
    expect(X.buildPurgeQuery(["a@x.com"], "99z")).toBe("from:(a@x.com) larger:5M");
    expect(X.buildPurgeQuery(["a@x.com"], ") is:starred")).toBe("from:(a@x.com) larger:5M");
  });

  test("returns empty string when nothing valid survives", () => {
    expect(X.buildPurgeQuery([])).toBe("");
    expect(X.buildPurgeQuery(['x@y.com) OR (in:sent'])).toBe("");
    expect(X.buildPurgeQuery("not-an-array")).toBe("");
  });

  test("injection attempts can never break out of the from group", () => {
    const q = X.buildPurgeQuery([
      "fine@ok.com",
      'evil@x.com") OR (is:important',
      "evil2@x.com -in:trash"
    ]);
    expect(q).toBe("from:(fine@ok.com) larger:5M");
    expect(q).not.toContain("is:important");
    expect(q).not.toContain('"');
    // exactly the one close paren that ends the from group, none injected:
    expect(q.split(")").length - 1).toBe(1);
  });
});

describe("GCC.storageXray.rankSenders", () => {
  test("ranks by estimated MB, count breaks ties, caps the list", () => {
    const out = X.rankSenders([
      { email: "small@x.com", count: 9, estMb: 10 },
      { email: "big@x.com", count: 1, estMb: 500 },
      { email: "mid-a@x.com", count: 2, estMb: 50 },
      { email: "mid-b@x.com", count: 7, estMb: 50 }
    ]);
    expect(out.map((s) => s.email))
      .toEqual(["big@x.com", "mid-b@x.com", "mid-a@x.com", "small@x.com"]);
  });

  test("shape-checks entries and drops invalid emails", () => {
    const out = X.rankSenders([
      { email: "ok@x.com", name: 42, count: "many", estMb: -5, status: 7 },
      { email: "bad email", count: 1, estMb: 10 },
      null,
      "junk"
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      email: "ok@x.com", name: "", count: 1, estMb: 0, status: "", statusAt: 0
    });
  });

  test("caps at MAX_LIST and never throws on junk input", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      email: `s${i}@x.com`, count: 1, estMb: i
    }));
    expect(X.rankSenders(many)).toHaveLength(X.LIMITS.MAX_LIST);
    expect(X.rankSenders(null)).toEqual([]);
    expect(X.rankSenders(undefined)).toEqual([]);
  });

  test("preserves purge status fields for the chip UI", () => {
    const out = X.rankSenders([
      { email: "done@x.com", count: 3, estMb: 30, status: "purged", statusAt: 123 }
    ]);
    expect(out[0].status).toBe("purged");
    expect(out[0].statusAt).toBe(123);
  });
});
