/**
 * @jest-environment node
 *
 * Maximum intensity (8.1).
 *
 * A fourth rung above Deep, for a mailbox that has never been cleaned.
 * It shortens Deep's age floors, drops the attachment thresholds, and
 * adds two more ways of naming bulk mail Gmail never filed into a
 * category. That makes it the most destructive preset the product
 * ships, so the properties worth pinning are the ones that keep it from
 * becoming a footgun:
 *
 *   - every rule still carries an age qualifier, so nothing it does can
 *     touch mail that arrived today
 *   - no rule trips the dangerous-token matcher (starred, important and
 *     the rest stay out of reach)
 *   - it cannot start on a single click
 *   - adding it did not silently drop it somewhere in the options
 *     round-trip, which is exactly what the old hardcoded
 *     { light, normal, deep } literals would have done
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const optionsSrc = read("options.js");
const engineSrc = read("contentScript.js");
const popupSrc = read("popup.js");
const popupHtml = read("popup.html");
const optionsHtml = read("options.html");

/** Pull the maximum rule list straight out of the source table. */
const maximumRules = (() => {
  const at = optionsSrc.indexOf("maximum: Object.freeze([");
  expect(at).toBeGreaterThan(-1);
  const end = optionsSrc.indexOf("])", at);
  const body = optionsSrc.slice(at + "maximum: Object.freeze([".length, end);
  return body
    .split("\n")
    .map((l) => l.trim().replace(/,$/, ""))
    .filter((l) => l.startsWith('"'))
    .map((l) => JSON.parse(l));
})();

const deepRules = (() => {
  const at = optionsSrc.indexOf("deep: Object.freeze([");
  const end = optionsSrc.indexOf("])", at);
  const body = optionsSrc.slice(at + "deep: Object.freeze([".length, end);
  return body
    .split("\n")
    .map((l) => l.trim().replace(/,$/, ""))
    .filter((l) => l.startsWith('"'))
    .map((l) => JSON.parse(l));
})();

describe("the rule set itself", () => {
  test("exists and is not just a copy of Deep", () => {
    expect(maximumRules.length).toBeGreaterThan(0);
    expect(maximumRules).not.toEqual(deepRules);
  });

  test("every rule carries an age qualifier except the pure size sweep", () => {
    // A rule with no age floor would be free to take mail that arrived
    // this morning. The one exception is the bare `larger:` sweep, which
    // is bounded by size instead, and which the global Minimum Age guard
    // still narrows at run time.
    for (const rule of maximumRules) {
      const hasAge = /\b(older_than|newer_than):\d+[dwmy]\b/i.test(rule);
      const isPureSize = /^larger:\d+[MK]$/i.test(rule);
      expect(hasAge || isPureSize).toBe(true);
    }
  });

  test("no rule targets protected mail", () => {
    // Mirrors the engine's own refusal list. A preset that shipped one
    // of these would be refused at run time and silently do nothing,
    // which is worse than not shipping it.
    const dangerous = ["is:starred", "is:important", "in:sent", "in:draft", "is:unread"];
    for (const rule of maximumRules) {
      for (const token of dangerous) {
        expect(rule.toLowerCase()).not.toContain(token);
      }
    }
  });

  test("it is strictly more aggressive than Deep on the shared categories", () => {
    const age = (rules, prefix) => {
      const hit = rules.find((r) => r.startsWith(prefix));
      if (!hit) return null;
      const m = hit.match(/older_than:(\d+)([dwmy])/i);
      if (!m) return null;
      const mult = { d: 1, w: 7, m: 30, y: 365 }[m[2].toLowerCase()];
      return Number(m[1]) * mult;
    };
    for (const prefix of ["category:promotions", "category:social", "category:updates", "category:forums"]) {
      const d = age(deepRules, prefix);
      const x = age(maximumRules, prefix);
      expect(typeof d).toBe("number");
      expect(typeof x).toBe("number");
      expect(x).toBeLessThan(d);
    }
  });

  test("it names bulk mail in two ways Deep does not", () => {
    expect(maximumRules.some((r) => r.includes("newsletter@ OR marketing@"))).toBe(true);
    expect(maximumRules.some((r) => r.includes("view in browser"))).toBe(true);
  });

  test("it never sweeps the Inbox wholesale or a bare age range", () => {
    // The line no preset crosses, however aggressive its name. Both of
    // these reach ordinary correspondence, which guards narrow but do
    // not protect: a two-year-old reply from a person is not starred,
    // not important, and not unread.
    for (const rule of maximumRules) {
      expect(rule.startsWith("in:inbox")).toBe(false);
      expect(/^older_than:\d+[dwmy]$/.test(rule.trim())).toBe(false);
    }
  });

  test("every rule uses documented Gmail search syntax", () => {
    // A rule Gmail cannot parse is not a no-op: an unrecognised operator
    // degrades to a plain text search, and a text search paired with an
    // age floor sweeps far wider than the rule intended. Anything with a
    // colon has to be an operator this project already relies on.
    const known = /^(larger|smaller|older_than|newer_than|category|has|from|to|subject|filename|label|in|is|list|size)$/;
    for (const rule of maximumRules) {
      for (const m of rule.matchAll(/(^|[\s(])(-?)([a-z_]+):/gi)) {
        expect(known.test(m[3].toLowerCase())).toBe(true);
      }
      expect(rule).not.toContain("(*)");
      expect(rule).not.toContain(":*");
    }
  });
});

describe("it is plumbed everywhere an intensity has to be", () => {
  test("the engine accepts it", () => {
    expect(engineSrc).toMatch(/validIntensities = \[[^\]]*"maximum"[^\]]*\]/);
  });

  test("options knows it as a rule key", () => {
    expect(optionsSrc).toMatch(/RULE_KEYS = Object\.freeze\(\[[^\]]*"maximum"[^\]]*\]\)/);
  });

  test("both the popup dropdown and the schedule dropdown offer it", () => {
    expect(popupHtml).toContain('<option value="maximum"');
    expect(optionsHtml).toContain('<option value="maximum">');
  });

  test("the options page has a textarea and a counter for it", () => {
    expect(optionsHtml).toContain('id="maximum"');
    expect(optionsHtml).toContain('id="maximumCount"');
    expect(optionsSrc).toContain('updateCountFor("maximum", "maximumCount")');
  });

  test("nothing rebuilds the rule map from a hardcoded three-key literal", () => {
    // This is the defect the tier exposed: normalizeRules and the
    // change-listener list both had { light, normal, deep } written out,
    // so a stored maximum list was dropped on the next save and its
    // textarea was never watched for edits.
    expect(optionsSrc).not.toMatch(/\{\s*light:\s*\[\]\s*,\s*normal:\s*\[\]\s*,\s*deep:\s*\[\]\s*\}/);
    expect(optionsSrc).not.toMatch(/\["light",\s*"normal",\s*"deep",\s*"whitelist"/);
    expect(optionsSrc).toMatch(/for \(const key of RULE_KEYS\) out\[key\] = \[\];/);
    expect(optionsSrc).toMatch(/const textareas = \[\.\.\.RULE_KEYS,/);
  });
});

describe("it cannot start on one click", () => {
  test("Maximum arms the same two-click guard as Deep", () => {
    expect(popupSrc).toMatch(/const needsArming = intensity === "deep" \|\| intensity === "maximum";/);
    expect(popupSrc).toMatch(/if \(needsArming && !elements\.dryRunEl\?\.checked\)/);
  });

  test("it says which one it is arming, so the warning is not generic", () => {
    expect(popupSrc).toContain("maxConfirmLabel");
    expect(popupSrc).toContain("maxConfirmStatus");
  });

  test("a dry run still skips the arm, because a preview moves nothing", () => {
    const block = popupSrc.slice(
      popupSrc.indexOf("const needsArming"),
      popupSrc.indexOf("Host access gate")
    );
    expect(block).toMatch(/!elements\.dryRunEl\?\.checked/);
  });
});
