/**
 * @jest-environment node
 *
 * Pins the content script's defense-in-depth refusal of dangerous custom
 * rule queries (issue #8). Mirrors GCC.validateGmailQuery on the popup
 * side; both layers must reject the same set of tokens.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

const DANGEROUS_RE = /const\s+DANGEROUS_QUERY_TOKENS\s*=\s*\[[^\]]+\];/;
const FUNC_RE = /function\s+queryHasDangerousToken\s*\(rawQuery\)\s*\{[\s\S]*?\n\s\s\}/;

const dangerousBlock = src.match(DANGEROUS_RE);
const funcBlock = src.match(FUNC_RE);
if (!dangerousBlock || !funcBlock) {
  throw new Error("contentScript.js dangerous-query validator not found; test needs update");
}

const queryHasDangerousToken = new Function(
  `${dangerousBlock[0]}
   ${funcBlock[0]}
   return queryHasDangerousToken;`
)();

describe("contentScript.js — queryHasDangerousToken", () => {
  test.each([
    "is:starred",
    "is:important older_than:1y",
    "in:sent",
    "in:drafts older_than:6m",
    "label:imap_starred"
  ])("rejects %s", (q) => {
    expect(queryHasDangerousToken(q)).toBe(true);
  });

  test.each([
    "category:promotions older_than:1y",
    "category:promotions -is:starred",
    "has:attachment larger:10M older_than:6m -is:important",
    "from:noreply@example.com older_than:3m"
  ])("accepts %s", (q) => {
    expect(queryHasDangerousToken(q)).toBe(false);
  });

  test("treats negated tokens as safe", () => {
    expect(queryHasDangerousToken("category:promotions -is:starred -is:important")).toBe(false);
  });

  test("ignores empty input", () => {
    expect(queryHasDangerousToken("")).toBe(false);
    expect(queryHasDangerousToken(null)).toBe(false);
    expect(queryHasDangerousToken(undefined)).toBe(false);
  });
});
