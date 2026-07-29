/**
 * @jest-environment node
 *
 * Pins the global Minimum Age floor.
 *
 * The setting is documented as "only clean emails older than this age",
 * and the 3.x changelog promises it applies "even if a rule is looser".
 * It was implemented as "skip if the query mentions older_than at all",
 * and every built-in rule carries an older_than, so the floor silently
 * did nothing on the entire stock rule set. These tests fail against
 * that implementation.
 *
 * A looser floor must still never relax a stricter rule, so the tests
 * pin both directions.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

const AGE_UNITS_RE = /const\s+AGE_UNIT_DAYS\s*=\s*Object\.freeze\([^)]+\);/;
const AGE_TOKEN_RE = /function\s+ageTokenToDays\s*\(raw\)\s*\{[\s\S]*?\n\s\s\}/;
const STRICTEST_RE = /function\s+strictestOlderThanDays\s*\(query\)\s*\{[\s\S]*?\n\s\s\}/;
const GUARDS_RE = /function\s+applyGlobalGuards\s*\(raw\)\s*\{[\s\S]*?\n\s\s\}/;

const blocks = {
  units: src.match(AGE_UNITS_RE),
  ageToken: src.match(AGE_TOKEN_RE),
  strictest: src.match(STRICTEST_RE),
  guards: src.match(GUARDS_RE)
};

for (const [name, block] of Object.entries(blocks)) {
  if (!block) {
    throw new Error(`contentScript.js min-age block "${name}" not found; test needs an update`);
  }
}

// applyGlobalGuards leans on a few neighbours. Stub the ones that are not
// under test so the real age logic is what runs.
const build = () => new Function(
  `${blocks.units[0]}
   ${blocks.ageToken[0]}
   ${blocks.strictest[0]}
   const SAFE_MODE_SUBJECT_GUARD = "-subject:(receipt)";
   const debugLog = () => {};
   const buildSubjectExclusion = (kw) => (kw.length ? \`-subject:(\${kw.join(" OR ")})\` : "");
   const CONFIG = {
     safeMode: false,
     guardSkipStarred: false,
     guardSkipImportant: false,
     guardSkipUnread: false,
     guardSkipUserLabels: false,
     minAge: null,
     whitelist: [],
     protectKeywords: []
   };
   ${blocks.guards[0]}
   return { applyGlobalGuards, ageTokenToDays, strictestOlderThanDays, CONFIG };`
)();

describe("contentScript.js: ageTokenToDays", () => {
  test.each([
    ["3d", 3],
    ["2w", 14],
    ["3m", 90],
    ["6m", 180],
    ["1y", 365],
    ["2y", 730]
  ])("reads %s as %i days", (token, days) => {
    expect(build().ageTokenToDays(token)).toBe(days);
  });

  test.each(["", "  ", "0m", "-1y", "abc", "3x", "m", null, undefined, {}])(
    "rejects %p",
    (v) => {
      expect(build().ageTokenToDays(v)).toBeNull();
    }
  );
});

describe("contentScript.js: strictestOlderThanDays", () => {
  test("returns null when the query carries no age", () => {
    expect(build().strictestOlderThanDays("category:promotions")).toBeNull();
  });

  test("reads a single age", () => {
    expect(build().strictestOlderThanDays("category:promotions older_than:3m")).toBe(90);
  });

  test("takes the oldest when a query carries several", () => {
    expect(
      build().strictestOlderThanDays("older_than:3m has:attachment older_than:2y older_than:6m")
    ).toBe(730);
  });

  test("reads an age inside a group", () => {
    expect(build().strictestOlderThanDays("category:promotions (older_than:1y)")).toBe(365);
  });

  // "-older_than:6m" means newer than 6 months, so it is not a floor the
  // rule is asking for. Counting it as one would suppress a real floor.
  test("ignores a negated age", () => {
    expect(build().strictestOlderThanDays("category:promotions -older_than:6m")).toBeNull();
  });
});

describe("contentScript.js: minimum age floor", () => {
  const withMinAge = (minAge, rule) => {
    const api = build();
    api.CONFIG.minAge = minAge;
    return api.applyGlobalGuards(rule);
  };

  // The regression. Every built-in rule already carries an older_than, so
  // the old "does the query mention older_than" test made the floor a
  // no-op across the whole stock rule set.
  test.each([
    ["category:promotions older_than:3m", "1y"],
    ["category:social older_than:6m", "1y"],
    ["category:promotions older_than:2m", "6m"],
    ["has:attachment larger:10M older_than:3m", "6m"],
    ['"unsubscribe" older_than:6m', "1y"]
  ])("applies a stricter floor to %s (floor %s)", (rule, floor) => {
    expect(withMinAge(floor, rule)).toContain(`older_than:${floor}`);
  });

  test("still applies when the rule has no age of its own", () => {
    expect(withMinAge("6m", "category:promotions")).toContain("older_than:6m");
  });

  test("does not relax a rule that is already stricter than the floor", () => {
    const out = withMinAge("3m", "category:promotions older_than:2y");
    expect(out).toContain("older_than:2y");
    expect(out).not.toContain("older_than:3m");
  });

  test("leaves an equal age alone rather than duplicating it", () => {
    const out = withMinAge("6m", "category:social older_than:6m");
    expect(out.match(/older_than:6m/g)).toHaveLength(1);
  });

  test("adds nothing when no floor is set", () => {
    expect(withMinAge(null, "category:promotions older_than:3m")).toBe(
      "category:promotions older_than:3m"
    );
  });

  test("an unparseable floor never overrides a real rule age", () => {
    const out = withMinAge("soon", "category:promotions older_than:3m");
    expect(out).not.toContain("older_than:soon");
    expect(out).toContain("older_than:3m");
  });

  test("empty rules stay empty", () => {
    expect(withMinAge("1y", "")).toBe("");
  });

  test("a rule that excludes old mail still gets the floor", () => {
    // "-older_than:6m" is not the rule asking for a floor, so the global
    // one still applies and narrows the window to 3m..6m.
    const out = withMinAge("3m", "category:promotions -older_than:6m");
    expect(out).toContain("older_than:3m");
  });
});
