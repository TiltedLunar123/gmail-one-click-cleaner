/**
 * @jest-environment node
 *
 * Regression: the Storage X-ray purge query overflowed the project's
 * own length ceiling.
 *
 * 7.15.0 shipped GCC.storageXray.buildPurgeQuery returning ONE string.
 * A full purge is capped at MAX_PURGE_PER_RUN = 25 senders, and 25
 * realistic addresses packed into a single from:(a OR b OR ...) group
 * came out around 1,270 characters against the 512-character ceiling
 * GCC.validateGmailQuery enforces. Nothing on the rulesOverride path
 * ever called that validator, so the over-length query went straight to
 * Gmail: the user asked for 25 senders and got whatever Gmail made of a
 * truncated search.
 *
 * 8.0 packs the addresses into as many length-bounded queries as it
 * takes and runs them as an ordinary multi-rule cleanup. These tests
 * hold both halves: the old single-string entry point can no longer
 * emit an over-length query, and the chunked builder loses nobody.
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

// Twenty-five addresses of the length real newsletter and notification
// senders actually use. Deterministic, and every one passes the
// builder's own strict email shape.
const REALISTIC = Array.from({ length: X.LIMITS.MAX_PURGE_PER_RUN }, (_, i) =>
  `no-reply.marketing.department-${String(i).padStart(2, "0")}@news.long-company-domain-example.com`);

describe("the 512-character ceiling", () => {
  test("MAX_QUERY_CHARS is the exported 512 the validator enforces", () => {
    expect(GCC.MAX_QUERY_CHARS).toBe(512);
  });

  test("validateGmailQuery rejects one character over the ceiling", () => {
    const ok = "a".repeat(GCC.MAX_QUERY_CHARS);
    const over = "a".repeat(GCC.MAX_QUERY_CHARS + 1);
    expect(GCC.validateGmailQuery(ok).valid).toBe(true);
    const check = GCC.validateGmailQuery(over);
    expect(check.valid).toBe(false);
    expect(check.errors.join(" ")).toMatch(/too long/i);
  });
});

describe("GCC.storageXray.buildPurgeQuery with a full sender list", () => {
  test("the fixture really is 25 valid addresses", () => {
    expect(REALISTIC).toHaveLength(25);
    expect(X.sanitizeEmails(REALISTIC)).toHaveLength(25);
  });

  test("25 realistic addresses no longer emit an over-length query", () => {
    const q = X.buildPurgeQuery(REALISTIC);
    expect(q.length).toBeLessThanOrEqual(GCC.MAX_QUERY_CHARS);
    expect(GCC.validateGmailQuery(q).valid).toBe(true);
  });

  test("the same holds with an age filter appended", () => {
    for (const age of X.LIMITS.VALID_AGES) {
      const q = X.buildPurgeQuery(REALISTIC, age);
      expect(`${age || "none"}:${q.length <= GCC.MAX_QUERY_CHARS}`).toBe(`${age || "none"}:true`);
      expect(`${age || "none"}:${GCC.validateGmailQuery(q).valid}`).toBe(`${age || "none"}:true`);
    }
  });

  test("it returns the first chunk, so the shape existing callers expect is unchanged", () => {
    expect(X.buildPurgeQuery(REALISTIC)).toBe(X.buildPurgeQueries(REALISTIC)[0]);
    expect(X.buildPurgeQuery(["a@x.com", "b@y.com"]))
      .toBe("from:(a@x.com OR b@y.com) larger:5M");
  });
});

describe("GCC.storageXray.buildPurgeQueries", () => {
  test("every chunk passes the validator", () => {
    const chunks = X.buildPurgeQueries(REALISTIC);
    expect(chunks.length).toBeGreaterThan(1);
    for (const q of chunks) {
      expect(`${q.length}:${q.length <= GCC.MAX_QUERY_CHARS}`).toBe(`${q.length}:true`);
      const check = GCC.validateGmailQuery(q);
      expect(`${q.slice(0, 40)}:${check.valid}`).toBe(`${q.slice(0, 40)}:true`);
    }
  });

  test("every sanitized address appears in exactly one chunk", () => {
    const chunks = X.buildPurgeQueries(REALISTIC);
    const joined = chunks.join("\n");
    for (const email of X.sanitizeEmails(REALISTIC)) {
      const hits = chunks.filter((q) => q.includes(email)).length;
      expect(`${email}:${hits}`).toBe(`${email}:1`);
    }
    // No address is lost on the way: the chunks between them name every
    // sanitized sender and nothing else.
    const named = joined.match(/[a-z0-9.\-_]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
    expect(named.sort()).toEqual(X.sanitizeEmails(REALISTIC).sort());
  });

  test("each chunk keeps the from:() group intact and the size floor", () => {
    for (const q of X.buildPurgeQueries(REALISTIC, "6m")) {
      expect(q.startsWith("from:(")).toBe(true);
      expect(q).toContain(") larger:5M older_than:6m");
      // Exactly the one close paren that ends the group.
      expect(q.split(")").length - 1).toBe(1);
    }
  });

  test("one address alone is a single valid query", () => {
    const chunks = X.buildPurgeQueries(["solo@example.com"]);
    expect(chunks).toEqual(["from:(solo@example.com) larger:5M"]);
    expect(GCC.validateGmailQuery(chunks[0]).valid).toBe(true);
  });

  test("an empty list and an all-invalid list produce no queries at all", () => {
    expect(X.buildPurgeQueries([])).toEqual([]);
    expect(X.buildPurgeQueries(['x@y.com) OR (is:starred', "no-at-sign", 42, null])).toEqual([]);
    expect(X.buildPurgeQueries(null)).toEqual([]);
    expect(X.buildPurgeQueries("not-an-array")).toEqual([]);
    // And the single-string entry point degrades the same way.
    expect(X.buildPurgeQuery([])).toBe("");
    expect(X.buildPurgeQuery(['x@y.com) OR (is:starred'])).toBe("");
  });

  test("no chunk is ever an over-length string, however long the addresses", () => {
    // Sanitize caps an address at 320 chars; several of those in one
    // run must still come out as separate, legal queries.
    const long = Array.from({ length: 25 }, (_, i) =>
      `${"seg-".repeat(40)}${i}@${"sub.".repeat(20)}example.com`);
    for (const q of X.buildPurgeQueries(long)) {
      expect(q.length).toBeLessThanOrEqual(GCC.MAX_QUERY_CHARS);
    }
    expect(X.buildPurgeQuery(long).length).toBeLessThanOrEqual(GCC.MAX_QUERY_CHARS);
  });
});

describe("the live purge path uses the chunked builder", () => {
  // The whole point of chunking is lost if the only consumer still
  // calls the singular API, which returns the FIRST chunk only and
  // silently drops every sender past it.
  const fs = require("fs");
  const path = require("path");
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf-8");

  test("handleXrayPurge builds every chunk", () => {
    expect(popup).toMatch(/GCC\.storageXray\.buildPurgeQueries\(emails, age\)/);
    expect(popup).toMatch(/config\.rulesOverride = purgeQueries;/);
  });

  test("nothing on a run path calls the single-string builder", () => {
    expect(popup).not.toMatch(/GCC\.storageXray\.buildPurgeQuery\(/);
  });
});
