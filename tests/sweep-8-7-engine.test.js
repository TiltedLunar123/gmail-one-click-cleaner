/**
 * @jest-environment node
 *
 * Engine findings from the 8.7 sweep.
 *
 * Source pins rather than DOM fixtures, for the same reason the earlier
 * sweep suites are: each of these is a one-line decision buried in a
 * 6,000-line file, and what matters is that the decision stays made.
 * Every assertion here was checked to FAIL against the 8.6.0 source.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const engineSrc = read("contentScript.js");
const optionsSrc = read("options.js");

/** Pull an intensity's rule list straight out of a source table. */
const rulesFrom = (src, key, tableMarker) => {
  const table = src.indexOf(tableMarker);
  expect(table).toBeGreaterThan(-1);
  const at = src.indexOf(`${key}: Object.freeze([`, table);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf("])", at);
  return src
    .slice(at + `${key}: Object.freeze([`.length, end)
    .split("\n")
    .map((l) => l.trim().replace(/,$/, ""))
    .filter((l) => l.startsWith('"'))
    .map((l) => JSON.parse(l));
};

describe("Maximum is a real rule set in the engine, not a fallback to Normal", () => {
  // 8.1 added Maximum to options.js and to every dropdown, and left the
  // engine's own DEFAULT_RULES at { light, normal, deep }. getRules
  // reads `rules` out of storage.sync, which is written only when the
  // user opens and SAVES the Options page, so on every other install
  // `allRules` IS the engine table: `allRules.maximum` came back
  // undefined and the lookup fell through to `allRules.normal`.
  //
  // The user picks the most destructive preset in the product, arms its
  // deliberate two-click guard, and watches the progress page announce
  // "Level: maximum" while the Normal rules run.
  const engineMax = () => rulesFrom(engineSrc, "maximum", "const DEFAULT_RULES = Object.freeze({");
  const optionsMax = () => rulesFrom(optionsSrc, "maximum", "const DEFAULT_RULES = Object.freeze({");

  test("the engine's fallback table has a maximum list", () => {
    expect(engineMax().length).toBeGreaterThan(0);
  });

  test("it is byte-identical to the one the Options page ships", () => {
    // Two tables that drift are two different products depending on
    // whether the user ever opened Options.
    expect(engineMax()).toEqual(optionsMax());
  });

  test("all four intensities now agree across the two tables", () => {
    for (const key of ["light", "normal", "deep", "maximum"]) {
      expect(rulesFrom(engineSrc, key, "const DEFAULT_RULES = Object.freeze({"))
        .toEqual(rulesFrom(optionsSrc, key, "const DEFAULT_RULES = Object.freeze({"));
    }
  });
});

describe("the unsubscribe sender list refuses a leading dash", () => {
  // Inside `from:(...)` a leading `-` is Gmail's NEGATION operator, so
  // `from:(-news@attacker.example)` matches every OTHER conversation.
  // The unsubscribe engine then opens the first hit and drives Gmail's
  // own Unsubscribe control on it: a spammer who puts a dash in front of
  // its From gets the user unsubscribed from somebody else's list.
  //
  // 7.15 closed this on the storage and smart copies of the matcher and
  // missed this one, which is fed by the least trustworthy source of the
  // three. The lesson it wrote down at the time: when you fix one copy
  // of a duplicated matcher, grep for the twins the same session.
  const sanitizer = () => {
    const at = engineSrc.indexOf("function sanitizeSenderList(");
    expect(at).toBeGreaterThan(-1);
    return engineSrc.slice(at, engineSrc.indexOf("\n  }", at));
  };

  test("its regex pins the first character, like the other two copies", () => {
    expect(sanitizer()).toContain(
      "/^[a-z0-9!#$%&'*+/=?^_`{|}~.][a-z0-9!#$%&'*+/=?^_`{|}~.-]*@[a-z0-9.-]+\\.[a-z]{2,}$/"
    );
  });

  test("all three copies of the sender matcher agree", () => {
    const shapes = engineSrc.match(/\[a-z0-9!#\$%&'\*\+\/=\?\^_`\{\|\}~\.[\]-]*\]/g) || [];
    // Every occurrence of the address character class in the engine is
    // the leading-character form or the tail form; none is the old
    // single-class shape that allowed a dash first.
    expect(engineSrc).not.toContain("/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@");
    expect(shapes.length).toBeGreaterThan(0);
  });
});

describe("Dry Run quotes the run it is previewing", () => {
  // A dry run acts on exactly one page and returns; a live run loops
  // passes until the rule is empty. `result.count || estimateTotalResults()`
  // took the page whenever it was non-zero, and it is non-zero in the
  // documented "the select-all-matching link was not found, so we delete
  // the visible page per pass" case. The preview then read "would affect
  // 50" for a rule Gmail's own toolbar reported as 1-50 of 3,000, and
  // the user approved a live run on the strength of it.
  const dry = () => {
    const at = engineSrc.indexOf("if (CONFIG.dryRun) {\r\n            const durationMs");
    const alt = engineSrc.indexOf("if (CONFIG.dryRun) {\n            const durationMs");
    const from = at > -1 ? at : alt;
    expect(from).toBeGreaterThan(-1);
    return engineSrc.slice(from, from + 1200);
  };

  test("it takes the larger of the page and the match total", () => {
    expect(dry()).toContain("const count = Math.max(pageCount, matchTotal);");
  });

  test("the truthy-page short circuit is gone", () => {
    expect(engineSrc).not.toContain("const count = result.count || estimateTotalResults() || 0;");
  });
});

describe("restore detects a whole-match-set selection the way cleanup does", () => {
  // `link-consumed` is the select-all-matching link disappearing after
  // the click, which is the same fact in every language. Restore checked
  // only the English "all conversations selected" banner, so a German
  // restore of a 4,200-thread run moved all 4,200 and booked the
  // viewport: the status line and the undo log both said 50.
  const restore = () => {
    const at = engineSrc.indexOf("const selectAllResult = await clickSelectAllConversations();\r\n    const bulkAllSelected");
    const alt = engineSrc.indexOf("const selectAllResult = await clickSelectAllConversations();\n    const bulkAllSelected");
    const from = at > -1 ? at : alt;
    expect(from).toBeGreaterThan(-1);
    return engineSrc.slice(from, from + 500);
  };

  test("it accepts link-consumed", () => {
    expect(restore()).toContain('selectAllResult.reason === "link-consumed"');
  });
});

describe("the report says when it could not measure something", () => {
  const scan = () => {
    const at = engineSrc.indexOf("async function reportScan(");
    return engineSrc.slice(at, engineSrc.indexOf("async function smartScan(", at));
  };

  test("a timed-out band is counted, not silently stored as zero", () => {
    // subscriptionScan and storageScan have counted their failed
    // searches since they shipped. The report, which is the landing tab
    // and the screen sold as a measurement of the mailbox, did not.
    expect(scan()).toContain("failedQueries++;");
    expect(scan()).toContain("failedQueries,");
    expect(scan()).toContain("totalQueries: steps.length");
  });

  test("a timed-out headline does not print an empty mailbox", () => {
    // "Nothing older than 6 months turned up" over a mailbox with
    // 40,000 old messages in it is the worst available reading of one
    // search timing out.
    expect(scan()).toContain("headlineMeasured");
    expect(scan()).toContain('"Could not read your mailbox."');
  });

  test("it reports the guard settings the counts were measured through", () => {
    expect(scan()).toContain("guardSkipUnread: Boolean(CONFIG.guardSkipUnread)");
    expect(scan()).toContain("safeMode: Boolean(CONFIG.safeMode)");
  });
});

describe("an engine says which run it is", () => {
  test("the ping answers with the run id and kind", () => {
    // The unattended callers check for an attached engine and then
    // inject; anything that attaches in between makes the duplicate
    // guard swallow the injection, and they had no way to see that.
    const at = engineSrc.indexOf('case "gmailCleanerPing":');
    const block = engineSrc.slice(at, at + 700);
    expect(block).toContain("runId: CONFIG.runId");
    expect(block).toContain("runKind: CONFIG.runKind");
  });

  test("a swallowed injection is flagged as such, not just described", () => {
    const at = engineSrc.indexOf("if (window.GCC_ATTACHED) {");
    const block = engineSrc.slice(at, at + 900);
    expect(block).toContain("duplicate: true");
  });

  test("a smart scan stamps its run id on every terminal message", () => {
    // Auto-Pilot's stage machine matches on it, so a scan the user
    // started cannot hand the sweep a "scan done" it never asked for.
    const at = engineSrc.indexOf("async function smartScan(");
    const body = engineSrc.slice(at, engineSrc.indexOf("function startSmartScan(", at));
    const stamps = body.split("runId: CONFIG.runId").length - 1;
    expect(stamps).toBe(3); // done, cancelled, error
  });
});

describe("the run history records its mode", () => {
  test("the engine sends action alongside the counts", () => {
    // stats.js inferred the mode from `archived` being non-zero, so an
    // archive run that moved nothing was filed under a red delete tag.
    // Scoped to the recordStats message: the done summary has carried
    // an `action` since 5.0 and is a different message entirely, so an
    // unscoped search here passes against the unfixed source.
    const at = engineSrc.indexOf('type: "gmailCleanerRecordStats",');
    expect(at).toBeGreaterThan(-1);
    const block = engineSrc.slice(at, at + 900);
    expect(block).toContain('action: CONFIG.archiveInsteadOfDelete ? "archive" : "delete",');
  });
});
