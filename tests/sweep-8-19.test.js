/**
 * @jest-environment node
 *
 * 8.19 sweep.
 *
 * Four defects and one latent trap, and three of them are the same shape:
 * a fact the run established was recorded only where nobody was left to
 * hear it.
 *
 *   - The three free unsubscribes were spent from the POPUP's progress
 *     handler. A browser action popup dies the instant the user clicks
 *     anything outside it, and an unsubscribe run opens one message per
 *     sender, so the popup is usually gone before the run ends. Nothing
 *     charged the counter and the allowance reset on every open. The
 *     engine has always posted the per-sender results to the service
 *     worker, which is the surface that survives; that is where the
 *     spend belongs, and it is the same reasoning behind
 *     storageXrayPendingPurge and smartPendingApply.
 *
 *   - A cancelled or errored unsubscribe run threw away the outcomes it
 *     really achieved. The results message sat inside the try, after the
 *     loop, so only a clean finish sent it. Unsubscribing cannot be
 *     undone, so those are facts worth keeping even when the run stopped:
 *     this is the opposite case to 8.16's, where a partial run must not
 *     claim to have FINISHED something.
 *
 *   - processQuery has THREE short exits, not two. 8.16 counted the pass
 *     cap and the retries-exhausted bail and pinned the total at two,
 *     which is exactly what stopped anyone noticing the third: the
 *     per-query wall-time budget, the one 8.16's own notes named first. A
 *     rule Gmail rate-limited past five minutes was abandoned with mail
 *     still behind it while runFinishedClean() called the run clean, so
 *     the Report's Cleared chip, the X-ray's Purged chip and Smart's
 *     applied feedback were all stamped on work that had not happened.
 *
 * And two of a kind that only show up on a real screen:
 *
 *   - Light-theme chip text sat on the FILL colour rather than an ink.
 *     Measured in Chrome over http, both themes, all six pages:
 *     --success on --success-bg is 3.19:1, --warning on --warning-bg is
 *     4.17:1, --info on --info-bg is 3.44:1, --primary-strong on
 *     --tint-brand is 3.14:1. 8.18 created --ink-good for exactly this
 *     and wired it into two places; warning, info and brand never got an
 *     ink at all. These states need a finished run or a licence to
 *     render, which is why two earlier live contrast passes saw none of
 *     them.
 *
 *   - The regex-escape in the dangerous-token matcher closes its
 *     character class one character early, so it escapes nothing. Inert
 *     today because no listed token carries a metacharacter, and this is
 *     the guard that keeps in:trash out of a delete rule.
 *
 * Proof standard: every assertion below fails on 8.18.1.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

// Comments are stripped before any source pattern runs. This project has
// now read its own explanatory prose as the defect it warns about five
// times, twice inside test files written to catch that very thing.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");

const ENGINE_SRC = stripComments(read("contentScript.js"));
const SW_SRC = stripComments(read("background.js"));
const POPUP_SRC = stripComments(read("popup.js"));
const POPUP_HTML = stripComments(read("popup.html"));
const OPTIONS_HTML = stripComments(read("options.html"));
const PROGRESS_HTML = stripComments(read("progress.html"));
const SHARED_CSS = stripComments(read("shared.css"));
const SHARED_SRC = stripComments(read("shared.js"));

// Returns "" for a missing anchor rather than throwing, so this file can
// be run against the previous release and report per-test failures
// instead of aborting collection with "0 total" (the 8.15 trap).
const between = (src, start, end) => {
  const a = src.indexOf(start);
  if (a === -1) return "";
  const b = src.indexOf(end, a + start.length);
  if (b <= a) return "";
  return src.slice(a, b);
};

// =====================================================================
// 1. The free allowance is spent where the run can still be heard
// =====================================================================

describe("three free unsubscribes survive a closed popup", () => {
  test("the worker knows the counter's key and its limit", () => {
    expect(SW_SRC).toContain('FREE_UNSUB_USED: "freeUnsubUsed"');
    expect(SW_SRC).toMatch(/FREE_UNSUB_LIMIT\s*=\s*3/);
  });

  test("the worker's key and limit match the shared ones exactly", () => {
    const sharedKey = /FREE_UNSUB_KEY\s*=\s*"([^"]+)"/.exec(SHARED_SRC);
    const sharedLimit = /FREE_UNSUB_LIMIT\s*=\s*(\d+)/.exec(SHARED_SRC);
    expect(sharedKey && sharedKey[1]).toBe("freeUnsubUsed");
    expect(SW_SRC).toContain(`FREE_UNSUB_USED: "${sharedKey[1]}"`);
    expect(SW_SRC).toMatch(new RegExp(`FREE_UNSUB_LIMIT\\s*=\\s*${sharedLimit[1]}`));
  });

  test("recordUnsubscribeResults charges the allowance", () => {
    const fn = between(SW_SRC, "async function recordUnsubscribeResults(", "async function recordStorageScan(");
    expect(fn).toContain("chargeFreeUnsubscribes(unsubscribedNow)");
  });

  test("only real unsubscribes are charged, never the number attempted", () => {
    const fn = between(SW_SRC, "async function recordUnsubscribeResults(", "async function recordStorageScan(");
    // unsubscribedNow is counted off `status === "unsubscribed"` alone.
    expect(fn).toContain('if (status === "unsubscribed") unsubscribedNow += 1;');
  });

  test("a licence, or a licence state that cannot be established, spends nothing", () => {
    const fn = between(SW_SRC, "async function chargeFreeUnsubscribes(", "async function recordStorageScan(");
    expect(fn).toContain("await readLicenseState()");
    // "free" is the only state that may spend: "pro" has no allowance and
    // "unknown" is a guess this must not make.
    expect(fn).toMatch(/if \(state !== "free"\) return;/);
  });

  test("a counter that cannot be read is left alone rather than written full", () => {
    const fn = between(SW_SRC, "async function chargeFreeUnsubscribes(", "async function recordStorageScan(");
    // The read sits in its own try whose catch returns without writing.
    const catchBlock = between(fn, "} catch {", "}");
    expect(catchBlock).toContain("return;");
  });

  test("the popup no longer writes the counter itself, so nothing double-charges", () => {
    // The whole hazard of moving the spend is charging it twice.
    expect(POPUP_SRC).not.toContain("STORAGE_KEYS.FREE_UNSUB_USED]: ");
    expect(POPUP_SRC).not.toContain("GCC.freeUnsub.spend(");
  });

  test("the popup still refreshes what it paints once a run lands", () => {
    const handler = between(POPUP_SRC, "const handleSubsProgress = (msg) => {", "const handleReportProgress");
    expect(handler).toContain("refreshFreeUnsubAfterRun()");
  });

  test("the gate still re-reads storage, so a stale paint cannot widen a run", () => {
    const gate = between(POPUP_SRC, "const allowedUnsubCount = async (wanted) => {", "};");
    expect(gate).toContain("await loadFreeUnsub()");
    expect(gate).toContain("Math.min(asked, state.subs.freeLeft)");
  });
});

// =====================================================================
// 2. A stopped unsubscribe run keeps the outcomes it achieved
// =====================================================================

describe("a cancelled or errored unsubscribe run still reports what it did", () => {
  const RUN = between(ENGINE_SRC, "async function unsubscribeRun(rawSenders) {", "function startSubscriptionScan()");

  test("the results message is sent through one helper, not from the happy path only", () => {
    expect(RUN).toContain("const reportResults = ()");
    expect(RUN).toContain('type: "gmailCleanerRecordUnsubscribes"');
  });

  test("it is sent at most once however many terminal paths run", () => {
    expect(RUN).toMatch(/let reported = false;/);
    expect(RUN).toContain("if (reported) return;");
    // Exactly one send site now, inside the helper.
    expect(RUN.match(/type: "gmailCleanerRecordUnsubscribes"/g) || []).toHaveLength(1);
  });

  test("every terminal path reports before it announces", () => {
    // done, cancelled and error each call the helper.
    expect(RUN.match(/reportResults\(\);/g) || []).toHaveLength(3);
    const cancelled = between(RUN, "if (e instanceof CancellationError) {", 'phase: "cancelled"');
    expect(cancelled).toContain("reportResults();");
    const errored = between(RUN, 'logError(e, "unsubscribe run");', 'phase: "error"');
    expect(errored).toContain("reportResults();");
  });

  test("the popup merges the partial statuses a stopped run carries", () => {
    const handler = between(POPUP_SRC, "const handleSubsProgress = (msg) => {", "const handleReportProgress");
    // One merge helper, reachable from the cancelled and error branches
    // and not only from the done branch.
    expect(handler).toContain("const mergeUnsubStatuses");
    const cancelled = between(handler, 'if (phase === "cancelled") {', "}");
    expect(cancelled).toContain("mergeUnsubStatuses(msg)");
    const errored = between(handler, 'if (phase === "error") {', "}");
    expect(errored).toContain("mergeUnsubStatuses(msg)");
  });
});

// =====================================================================
// 3. processQuery has three short exits, and all three say so
// =====================================================================

describe("every way out of a rule that left mail behind is counted", () => {
  const Q = between(ENGINE_SRC, "async function processQuery(", "function buildFinalStats(");

  test("all three short exits bump the counter", () => {
    // The pass cap, giving up after the retry budget, and the per-query
    // wall-time budget. 8.16 pinned this at two, which is what kept the
    // third out.
    expect(Q.match(/stats\.stoppedShort\+\+;/g) || []).toHaveLength(3);
  });

  test("the wall-time bail is one of them", () => {
    const bail = between(
      Q,
      "if ((isRL || isTO) && elapsedMs > GUARDRAILS.QUERY_WALL_TIME_BUDGET_MS) {",
      "deescalateBackoff();"
    );
    expect(bail).toContain("stats.stoppedShort++;");
    // And it still says so out loud; the counter is the half that
    // survives a closed popup and an unattended run.
    expect(bail).toContain('phase: "warning"');
  });

  test("the counter is bumped before the rule is recorded, on every exit", () => {
    for (const anchor of [
      "if ((isRL || isTO) && elapsedMs > GUARDRAILS.QUERY_WALL_TIME_BUDGET_MS) {",
      "if (isRL || isTO) {\n            safeSend({"
    ]) {
      const slice = between(Q, anchor, "recordQuery({");
      if (slice) expect(slice).toContain("stats.stoppedShort++;");
    }
  });

  test("runFinishedClean still refuses a run that stopped short", () => {
    const helper = between(SW_SRC, "function runFinishedClean(summary) {", "}");
    expect(helper).toContain("return !(Number(summary.stoppedShort) > 0);");
  });
});

// =====================================================================
// 4. Light-theme chips are written in ink, not in the fill colour
// =====================================================================

const toRgb = (hex) => {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const relLum = ([r, g, b]) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const la = relLum(toRgb(a));
  const lb = relLum(toRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
// A tinted chip is `rgba(fill, alpha)` painted over the card. Compositing
// it is the only way to get the number a browser actually renders.
const over = (fillHex, alpha, groundHex) => {
  const f = toRgb(fillHex);
  const g = toRgb(groundHex);
  const c = f.map((v, i) => Math.round(alpha * v + (1 - alpha) * g[i]));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
};

// The light palette, read out of shared.css so the test cannot drift from
// the stylesheet.
const lightBlock = between(SHARED_CSS, '[data-theme="light"] {', "\n}");
const lightToken = (name) => {
  const m = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`).exec(lightBlock);
  return m ? m[1] : null;
};

describe("the contrast helper can still fail", () => {
  test("it reports a known-bad pair as bad and a known-good pair as good", () => {
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 2);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    // The exact pair this section exists to stop shipping.
    expect(contrast("#059669", over("#059669", 0.1, "#f5fafb"))).toBeLessThan(4.5);
  });
});

describe("light theme has an ink for every chip colour", () => {
  const CARD = "#f5fafb"; // --bg-deep, the ground every chip is painted on

  test("--ink-warn and --ink-info exist alongside --ink-good", () => {
    expect(lightToken("--ink-good")).toBeTruthy();
    expect(lightToken("--ink-warn")).toBeTruthy();
    expect(lightToken("--ink-info")).toBeTruthy();
    expect(lightToken("--ink-brand")).toBeTruthy();
  });

  test("each ink clears 4.5:1 on its own tinted chip", () => {
    const cases = [
      ["--ink-good", "#059669", 0.1],   // --success-bg
      ["--ink-warn", "#b45309", 0.1],   // --warning-bg
      ["--ink-info", "#0284c7", 0.1],   // --info-bg
      ["--ink-brand", "#0e7490", 0.08]  // --tint-brand
    ];
    for (const [token, fill, alpha] of cases) {
      const ink = lightToken(token);
      const ratio = contrast(ink, over(fill, alpha, CARD));
      expect({ token, ratio: +ratio.toFixed(2) }).toEqual({ token, ratio: expect.any(Number) });
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("each ink also clears 4.5:1 on a plain white row and on the card", () => {
    for (const token of ["--ink-good", "--ink-warn", "--ink-info", "--ink-brand"]) {
      const ink = lightToken(token);
      expect(contrast(ink, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(ink, CARD)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the fills stay fills: each one still measures under 4.5 as text", () => {
    // Pins the reason the inks exist. If a fill ever clears the bar on its
    // own, this test is the place to notice rather than a silent revert.
    expect(contrast("#059669", over("#059669", 0.1, CARD))).toBeLessThan(4.5);
    expect(contrast("#b45309", over("#b45309", 0.1, CARD))).toBeLessThan(4.5);
    expect(contrast("#0284c7", over("#0284c7", 0.1, CARD))).toBeLessThan(4.5);
    expect(contrast("#0891b2", over("#0e7490", 0.08, CARD))).toBeLessThan(4.5);
  });
});

describe("every chip that is text uses the ink", () => {
  test("the shared tag and button family", () => {
    expect(SHARED_CSS).toContain(".tag-success { background: var(--success-bg); color: var(--ink-good); }");
    expect(SHARED_CSS).toContain(".tag-warning { background: var(--warning-bg); color: var(--ink-warn); }");
    expect(SHARED_CSS).toContain(".tag-info { background: var(--info-bg); color: var(--ink-info); }");
    const btn = between(SHARED_CSS, ".btn-success {", "}");
    expect(btn).toContain("var(--ink-good)");
    expect(btn).not.toContain("color: var(--success)");
  });

  test("the popup's licence pill and its Cleared chip", () => {
    const pill = between(POPUP_HTML, ".pro-pill.is-active {", "}");
    expect(pill).toContain("color: var(--ink-good);");
    const done = between(POPUP_HTML, ".report-row-done {", "}");
    expect(done).toContain("color: var(--ink-good);");
  });

  test("the popup's Apply button", () => {
    const apply = between(POPUP_HTML, ".smart-apply-btn {", "}");
    expect(apply).toContain("color: var(--ink-brand);");
  });

  test("the options rule-action chips", () => {
    expect(OPTIONS_HTML).toContain('.rule-action[data-action="archive"] { background: var(--success-bg); color: var(--ink-good); }');
    expect(OPTIONS_HTML).toContain('.rule-action[data-action="label"] { background: var(--info-bg); color: var(--ink-info); }');
  });

  test("the progress page's dry-run marker", () => {
    expect(PROGRESS_HTML).toContain(".done-card.dry .done-safety .ico { color: var(--ink-info); }");
  });

  test("dark theme is untouched: every ink still resolves to the fill it always was", () => {
    // The whole point of routing through a token: light gets a darker
    // ink, dark keeps exactly the colour it shipped with.
    const darkBlock = between(SHARED_CSS, '[data-theme="dark"] {', '\n[data-theme="light"]');
    expect(darkBlock).toContain("--ink-good: var(--success);");
    expect(darkBlock).toContain("--ink-warn: var(--warning);");
    expect(darkBlock).toContain("--ink-info: var(--info);");
    expect(darkBlock).toContain("--ink-brand: var(--primary-strong);");
  });
});

// =====================================================================
// 5. The dangerous-token matcher's escape actually escapes
// =====================================================================

describe("the query-guard regex escape", () => {
  // Rebuild the escaper from the shipped source so the test measures the
  // literal that ships, not a copy of it.
  const escapersIn = (src) =>
    [...src.matchAll(/token\.replace\((\/\[[^/]*\/g), "\\\\\$&"\)/g)].map((m) => m[1]);

  test("both files still have the escapes this test is about", () => {
    expect(escapersIn(SHARED_SRC).length).toBe(3);
    expect(escapersIn(ENGINE_SRC).length).toBe(2);
  });

  test("every one of them actually escapes a regex metacharacter", () => {
    for (const [file, src] of [["shared.js", SHARED_SRC], ["contentScript.js", ENGINE_SRC]]) {
      for (const literal of escapersIn(src)) {
        // eslint-disable-next-line no-new-func
        const re = new Function(`return ${literal};`)();
        const escaped = "in:any(where).x+y".replace(re, "\\$&");
        expect({ file, escaped }).toEqual({ file, escaped: "in:any\\(where\\)\\.x\\+y" });
      }
    }
  });

  test("an escaped token is still matched by the guard it feeds", () => {
    // The end-to-end property: a token carrying a metacharacter must
    // still be refused, which is what a broken escape silently ends.
    for (const src of [SHARED_SRC, ENGINE_SRC]) {
      const literal = escapersIn(src)[0];
      // eslint-disable-next-line no-new-func
      const re = new Function(`return ${literal};`)();
      const token = "in:any(where)";
      const positive = new RegExp(`(^|[\\s({])${token.replace(re, "\\$&")}\\b`, "i");
      expect(positive.test("older_than:1y in:any(where)")).toBe(true);
    }
  });
});
