/**
 * @jest-environment node
 *
 * Pins the contentScript whitelist filter behavior. The content script
 * is the second line of defence behind options.js; storage values
 * written by hand must not slip through. Keep these expectations in
 * step with options.js isValidWhitelistEntry.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

// Pull the validator out of the file so the test exercises the real
// regex set instead of a copy. The pattern is intentionally a little
// loose so a future rename does not break us.
const FUNC_RE = /const\s+isValidWhitelistEntry\s*=\s*\(s\)\s*=>\s*\{[\s\S]*?\n\s\s\};/;
const REGEX_RE = /const\s+WHITELIST_EMAIL\s*=[\s\S]*?const\s+WHITELIST_DOMAIN\s*=\s*[^;]+;/;

const regexBlock = src.match(REGEX_RE);
const funcBlock = src.match(FUNC_RE);
if (!regexBlock || !funcBlock) {
  throw new Error("contentScript.js whitelist validator not found; test needs an update");
}

const isValidWhitelistEntry = new Function(
  `${regexBlock[0]}
  ${funcBlock[0]}
  return isValidWhitelistEntry;`
)();

describe("contentScript.js — isValidWhitelistEntry", () => {
  test.each([
    "person@example.com",
    "first.last@example.co.uk",
    "user+tag@example.com",
    "*@example.com",
    "example.com",
    "mail.example.co.uk"
  ])("accepts %s", (v) => {
    expect(isValidWhitelistEntry(v)).toBe(true);
  });

  test.each([
    "user+tag@domain",          // missing TLD -- the exact bug in #23
    "no-at-sign",
    "spaces in here@example.com",
    "OR",
    "{curly}",
    "(parens)",
    "user@@double.com",
    "",
    "   ",
    null,
    undefined,
    42,
    {}
  ])("rejects %p", (v) => {
    expect(isValidWhitelistEntry(v)).toBe(false);
  });
});
