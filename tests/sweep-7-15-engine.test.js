/**
 * @jest-environment node
 *
 * Regression net for the 7.15 engine fixes. Every test here fails against
 * 7.14.2 source.
 *
 * The behavioural tests load the real functions out of contentScript.js
 * rather than pinning source text, so they describe what the engine does
 * instead of how it is written.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

/**
 * Slice the source from one anchor up to (not including) another, so a
 * group of adjacent declarations can be evaluated in isolation.
 */
function slice(startAnchor, endAnchor) {
  const from = src.indexOf(startAnchor);
  const to = src.indexOf(endAnchor, from);
  if (from < 0 || to < 0) return "";
  return src.slice(from, to);
}

/** Pull one top-level function body out of the content script. */
function fn(name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s\\s\\}`);
  const m = src.match(re);
  return m ? m[0] : "";
}

/**
 * Evaluate an extracted declaration and hand back the named function.
 * Returns a stub when the source does not define it, so a run against
 * older source reports failed assertions instead of a load error.
 */
function build(body, name) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`${body}; return ${name};`)();
  } catch {
    return () => undefined;
  }
}

/** Match a function body, or "" when the source has no such function. */
function grab(re) {
  const m = src.match(re);
  return m ? m[0] : "";
}

describe("7.15: Gmail's brace OR-group cannot smuggle a protected token past the refusal", () => {
  const body = slice("const DANGEROUS_QUERY_TOKENS = [", "// v3.4: Safe Mode");
  const queryHasDangerousToken = build(body, "queryHasDangerousToken");

  test.each([
    ["{is:starred is:unread} older_than:1y"],
    ["{in:sent in:drafts}"],
    ["{label:imap_starred category:promotions} older_than:6m"]
  ])("refuses %s", (query) => {
    expect(queryHasDangerousToken(query)).toBe(true);
  });

  test("still refuses the bare and parenthesised forms", () => {
    expect(queryHasDangerousToken("is:starred older_than:1y")).toBe(true);
    expect(queryHasDangerousToken("(is:starred) older_than:1y")).toBe(true);
  });

  test("still allows an explicitly negated token in a group", () => {
    expect(queryHasDangerousToken("{category:promotions} -is:starred")).toBe(false);
    expect(queryHasDangerousToken("category:promotions older_than:1y")).toBe(false);
  });
});

describe("7.15: the results counter is read without knowing the word for 'of'", () => {
  const body = slice("const COUNT_SEPARATORS", "function estimateTotalResults");
  const parseCountFromText = build(body, "parseCountFromText");

  test.each([
    ["1-50 of 3,200", 3200, "en"],
    ["1-50 of about 3,200", 3200, "en estimate"],
    ["1-50 von 3.200", 3200, "de"],
    ["1-50 sur 3 200", 3200, "fr"],
    ["1-50 de 3.200", 3200, "es"],
    ["1-50 di 3.200", 3200, "it"],
    ["1–50 из 3 200", 3200, "ru"],
    ["3,200개 중 1~50", 3200, "ko, total first"],
    ["第1-50个会话，共 3,200 个", 3200, "zh, total last"]
  ])("reads %s as %i (%s)", (text, expected) => {
    expect(parseCountFromText(text)).toBe(expected);
  });

  test("returns null when there is no total to read", () => {
    expect(parseCountFromText("1-50")).toBeNull();
    expect(parseCountFromText("")).toBeNull();
    expect(parseCountFromText(null)).toBeNull();
  });

  test("ignores a long concatenated blob rather than guessing", () => {
    // estimateTotalResults walks spans AND divs in document order, so an
    // outer container's whole text arrives before the counter's own node.
    const blob = "Inbox 1-50 Promotions 12 Social 4 Updates 900 " +
      "Forums 3 Spam 17 Trash 2 All Mail 40000 Drafts 1 Sent 6";
    expect(blob.length).toBeGreaterThan(60);
    expect(parseCountFromText(blob)).toBeNull();
  });
});

describe("7.15: a whitelisted domain wildcard actually excludes the domain", () => {
  const guards = grab(/function\s+applyGlobalGuards\(raw\)\s*\{[\s\S]*?\n\s\s\}/);

  test("rewrites *@domain into Gmail's own domain form", () => {
    // Gmail has no wildcard in from:, so `-from:*@bank.com` excluded
    // nothing at all while the Options page advertised the shape.
    expect(guards).toMatch(/\/\^\\\*@\(\.\+\)\$\//);
    expect(guards).toMatch(/wildcardDomain\s*\?\s*wildcardDomain\[1\]\s*:\s*trimmed/);
  });

  test("the wildcard shape really is one the validator accepts", () => {
    expect(src).toMatch(/WHITELIST_WILDCARD_EMAIL\s*=\s*\/\^\\\*@/);
  });
});

describe("7.15: stored intensity rules get the same refusal custom rules get", () => {
  const getRules = grab(/async\s+function\s+getRules\(intensity\)[\s\S]*?\n\s\s\}/);

  test("the stored rule set passes through refuseDangerousRules", () => {
    expect(getRules).toMatch(/refuseDangerousRules\(\s*\[\.\.\.\(allRules\[intensity\]/);
  });

  test("the helper skips rather than aborts, like the custom-rule path", () => {
    const helper = grab(/function\s+refuseDangerousRules\([\s\S]*?\n\s\s\}/);
    expect(helper).toMatch(/queryHasDangerousToken\(trimmed\)/);
    expect(helper).toMatch(/continue;/);
    expect(helper).toMatch(/targets protected mail/);
  });
});

describe("7.15: a custom rule's action is honoured or the rule is skipped", () => {
  const getRules = grab(/async\s+function\s+getRules\(intensity\)[\s\S]*?\n\s\s\}/);

  test("an archive-only rule does not run as a delete", () => {
    expect(getRules).toMatch(
      /ruleAction\s*===\s*"archive"\s*&&\s*CONFIG\.archiveInsteadOfDelete/
    );
  });

  test("a label-only rule is never executed by a cleanup run", () => {
    expect(getRules).toMatch(/const\s+canHonour\s*=\s*ruleAction\s*===\s*"delete"/);
    expect(getRules).toMatch(/Label only/);
  });

  test("the rule set is no longer merged on the query alone", () => {
    expect(getRules).toMatch(/const\s+ruleAction\s*=\s*typeof\s+cr\.action/);
  });
});

describe("7.15: bulk-all selection is detected structurally, not in English", () => {
  const click = grab(/async\s+function\s+clickSelectAllConversations\(\)[\s\S]*?\n\s\s\}/);

  test("a consumed select-all-matching link counts as bulk-all", () => {
    expect(click).toMatch(/const\s+linkConsumed\s*=\s*!findSelectAllConversationsLink\(\);/);
    expect(click).toMatch(/reason:\s*"link-consumed"/);
  });

  test("the structural check is evaluated before the English text banner", () => {
    const structuralAt = click.indexOf("linkConsumed");
    const textAt = click.indexOf("allSelectedIndicator");
    expect(structuralAt).toBeGreaterThan(-1);
    expect(textAt).toBeGreaterThan(-1);
    expect(structuralAt).toBeLessThan(textAt);
  });

  test("actOnCurrentPageIfAny treats it as bulk-all", () => {
    const act = grab(/async\s+function\s+actOnCurrentPageIfAny\s*\(tagLabel\)\s*\{[\s\S]*?\n\s\s\}/);
    expect(act).toMatch(/selectAllResult\.reason\s*===\s*"link-consumed"/);
  });
});

describe("7.15: the bulk confirmation dialog is found in every language", () => {
  const handler = grab(/async\s+function\s+handleBulkConfirmation\(\)[\s\S]*?\n\s\s\}/);

  test("a dialog carrying a localized confirm button is accepted", () => {
    expect(handler).toMatch(/if\s*\(findBulkConfirmButton\(d\)\)\s*return\s+d;/);
  });

  test("the button matcher is the localized token table", () => {
    const finder = grab(/function\s+findBulkConfirmButton\(dialog\)[\s\S]*?\n\s\s\}/);
    expect(finder).toMatch(/CONFIRM_TOKENS\.some/);
  });
});

describe("7.15: restore honours cancel and counts a bulk-all restore correctly", () => {
  const restore = grab(/async\s+function\s+restoreCurrentPage\(\)[\s\S]*?\n\s\s\}/);

  test("re-checks CANCELLED between selecting and moving", () => {
    const driveAt = restore.indexOf("await driveMoveBackControl()");
    const guardAt = restore.lastIndexOf("if (CANCELLED)", driveAt);
    expect(guardAt).toBeGreaterThan(-1);
    expect(restore.slice(guardAt, driveAt)).toMatch(/throw\s+new\s+CancellationError\(/);
  });

  test("prefers the match total over the viewport, like the cleanup path", () => {
    expect(restore).toMatch(
      /movedCount\s*=\s*Math\.max\(totalBefore\s*\?\?\s*0,\s*selectedCount\s*\?\?\s*0\)/
    );
    expect(restore).not.toMatch(
      /movedCount\s*=\s*\(selectedCount\s*&&\s*selectedCount\s*>\s*0\)\s*\?\s*selectedCount/
    );
  });
});

describe("7.15: an unsubscribe is not confirmed after the user cancels", () => {
  const fn = grab(/async\s+function\s+unsubscribeCurrentMessage\(\)[\s\S]*?\n\s\s\}/);

  test("checks CANCELLED before clicking the confirm button", () => {
    const clickAt = fn.indexOf("fireMouseSequence(confirmBtn)");
    const guardAt = fn.lastIndexOf("if (CANCELLED)", clickAt);
    expect(guardAt).toBeGreaterThan(-1);
    expect(fn.slice(guardAt, clickAt)).toMatch(/throw\s+new\s+CancellationError\(/);
    expect(fn.slice(guardAt, clickAt)).toMatch(/dismissDialog\(dlg\)/);
  });
});

describe("7.15: a rule stopped by the pass cap is reported", () => {
  const pq = grab(/async\s+function\s+processQuery\(query,\s*idx,\s*total\)[\s\S]*?\n\s\s\}/);

  test("records stats and warns when the loop runs out of passes", () => {
    expect(pq).toMatch(/stopped at the pass limit/);
    const warnAt = pq.indexOf("stopped at the pass limit");
    expect(pq.slice(warnAt)).toMatch(/recordQueryStats\(/);
  });
});

describe("7.15: synced run stats carry no mailbox addresses", () => {
  test("the engine strips the raw query before the sync write", () => {
    expect(src).toMatch(/chrome\.storage\.sync\.set\(\{\s*lastRunStats:\s*stripQueriesForSync\(doneStats\)/);

    const stripQueriesForSync = build(fn("stripQueriesForSync"), "stripQueriesForSync");
    const out = stripQueriesForSync({
      runCount: 12,
      perQuery: [{
        query: "from:(bills@utility.com OR alerts@bank.com) larger:5M older_than:6m",
        label: "Big attachments",
        count: 12,
        mode: "live",
        durationMs: 900
      }]
    });

    expect(out).toBeDefined();
    expect(out.perQuery[0]).not.toHaveProperty("query");
    expect(JSON.stringify(out)).not.toContain("bank.com");
    // The figures the Diagnostics card actually renders survive.
    expect(out.perQuery[0]).toEqual({
      label: "Big attachments",
      count: 12,
      mode: "live",
      durationMs: 900
    });
    expect(out.runCount).toBe(12);
  });

  test("the progress page strips it too", () => {
    const progress = fs.readFileSync(path.join(__dirname, "..", "progress.js"), "utf-8");
    const save = progress.match(/const\s+saveStatsToStorage\s*=\s*async[\s\S]*?\n\s\s\};/)[0];
    expect(save).toMatch(/const\s+perQuery\s*=\s*Array\.isArray\(stats\?\.perQuery\)/);
    expect(save).toMatch(/lastRunStats:\s*statsToSave/);
    expect(save).toMatch(/perQuery,\s*finishedAt/);
  });

  test("a leading dash can no longer reach a from:() group", () => {
    // Inside `from:(a OR b)` a leading "-" is Gmail's negation operator.
    const shared = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
    const background = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");
    for (const [name, text] of [["shared", shared], ["background", background], ["engine", src]]) {
      const m = text.match(/(?:STORAGE|SMART)_EMAIL_RE\s*=\s*(\/[^\n]+\/)/);
      expect(`${name}:${Boolean(m)}`).toBe(`${name}:true`);
      // eslint-disable-next-line no-eval
      const re = eval(m[1]);
      expect(`${name}:${re.test("-alerts@bank.com")}`).toBe(`${name}:false`);
      expect(`${name}:${re.test("alerts-x@bank.com")}`).toBe(`${name}:true`);
      expect(`${name}:${re.test("alerts@bank.com")}`).toBe(`${name}:true`);
    }
  });
});
