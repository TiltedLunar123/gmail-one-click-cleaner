/**
 * @jest-environment node
 *
 * 9.3 sweep, the parts that are not about the launcher.
 *
 * validateGmailQuery runs two loops over the query a user typed into
 * Options. The first refuses tokens that target protected mail, and it
 * was taught in 7.14.2 and again in 7.15 that "(" and "{" separate an
 * operator exactly as a space does, because Gmail groups with both. The
 * second loop warns about a query that sweeps a whole view with no age
 * filter, and it was never taught either character, so the warning is
 * the one protection a grouped query still walks past.
 */
const fs = require("fs");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const iifeMatch = code.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome",
  `return ${iifeMatch[1]}`
)(
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
  { structuredClone: typeof structuredClone !== "undefined" ? structuredClone : undefined },
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

const warningsFor = (query) => GCC.validateGmailQuery(query).warnings.join(" | ");

describe("the age warning reads a grouped query the way Gmail does", () => {
  // The plain form has warned since the warning existed. It is here so a
  // fix that silences the whole loop shows up as two failures, not none.
  test("a bare in:inbox with no age filter still warns", () => {
    expect(warningsFor("in:inbox is:read")).toContain("in:inbox");
  });

  test.each([
    ["a paren group", "(in:inbox) is:read"],
    ["an OR group", "{in:inbox in:all} is:read"],
    ["a paren group with the age inside a subject term", "(in:inbox) -subject:(older_than)"],
    ["in:all in a paren group", "(in:all) is:read"]
  ])("%s warns too: %s", (_label, query) => {
    // Without this the Options page saves "(in:inbox) is:read" in
    // silence, and the rule archives mail that arrived this morning.
    expect(warningsFor(query)).toMatch(/older_than/);
  });

  test("a grouped query that already carries an age is left alone", () => {
    expect(GCC.validateGmailQuery("(in:inbox) older_than:1y").warnings).toEqual([]);
    expect(GCC.validateGmailQuery("{in:inbox in:all} newer_than:2y older_than:1y").warnings).toEqual([]);
  });

  test("the warning is a warning: the query is still valid", () => {
    const result = GCC.validateGmailQuery("(in:inbox) is:read");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a query that mentions neither view is not warned about", () => {
    expect(GCC.validateGmailQuery("category:promotions older_than:1y").warnings).toEqual([]);
    expect(GCC.validateGmailQuery("(category:promotions)").warnings).toEqual([]);
  });
});

describe("the two loops in validateGmailQuery anchor the same way", () => {
  // The recurring defect in this file is one matcher learning a Gmail
  // grouping character and its twin not learning it. Pinning the source
  // means the next character is added to both or to neither.
  test("neither loop anchors on whitespace alone", () => {
    const body = code.slice(
      code.indexOf("const validateGmailQuery"),
      code.indexOf("// Notifications")
    );
    const anchors = [...body.matchAll(/new RegExp\(`\(\^\|([^)]*)\)/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    for (const anchor of anchors) expect(anchor).toBe("[\\\\s({]");
  });
});
