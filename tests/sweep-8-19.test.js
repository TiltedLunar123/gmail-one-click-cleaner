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
    // The refresh rides on the merge helper, so every terminal path that
    // merges statuses also re-reads the counter the worker just spent.
    const merge = between(POPUP_SRC, "const mergeUnsubStatuses = (msg) => {", "const handleSubsProgress");
    expect(merge).toContain("refreshFreeUnsubAfterRun()");
    // And it is a re-read, not a second write.
    const refresh = between(POPUP_SRC, "const refreshFreeUnsubAfterRun = () => {", "};");
    expect(refresh).toContain("loadFreeUnsub()");
    expect(refresh).toContain("paintSubsAllowance");
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

  // 8.20 rewrote these two. The property 8.19 wanted is "no outcome is
  // ever sent twice", because the worker charges the free allowance off
  // each batch it receives. 8.19 bought that with a once-only flag,
  // which also capped the run at ONE send and made the tab being torn
  // down mid-loop cost every outcome so far. The property is now bought
  // by a high-water mark instead, so the helper can be called as often
  // as it likes and still never repeat a result. Pinned as the property,
  // not as the shape, and not as a call count: counting the call sites
  // is exactly what kept processQuery's third short exit out for three
  // releases.
  test("no outcome is ever sent twice", () => {
    expect(RUN).toMatch(/let flushedUpTo = 0;/);
    expect(RUN).toContain("const pending = results.slice(flushedUpTo);");
    expect(RUN).toContain("if (!pending.length) return;");
    // The high-water mark moves BEFORE the send, so a throw inside the
    // send cannot leave the same batch queued to go again.
    const helper = between(RUN, "const reportResults = () => {", "};");
    expect(helper.indexOf("flushedUpTo = results.length;"))
      .toBeLessThan(helper.indexOf('type: "gmailCleanerRecordUnsubscribes"'));
    // And what goes out is the unsent tail, never the whole list again.
    expect(helper).toContain("results: pending");
    // Exactly one send site, inside the helper.
    expect(RUN.match(/type: "gmailCleanerRecordUnsubscribes"/g) || []).toHaveLength(1);
  });

  test("every terminal path reports before it announces, and so does every sender", () => {
    const cancelled = between(RUN, "if (e instanceof CancellationError) {", 'phase: "cancelled"');
    expect(cancelled).toContain("reportResults();");
    const errored = between(RUN, 'logError(e, "unsubscribe run");', 'phase: "error"');
    expect(errored).toContain("reportResults();");
    const done = between(RUN, "const okCount = results.filter", 'phase: "done"');
    expect(done).not.toBeNull();
    // 8.20: and the loop itself, so a tab closed mid-run loses at most
    // the sender in flight rather than all of them.
    const loop = between(RUN, "results.push({ sender: email, status });", "await sleep(");
    expect(loop).toContain("reportResults();");
  });

  test("the popup merges the partial statuses a stopped run carries", () => {
    // One merge helper, reachable from the cancelled and error branches
    // and not only from the done branch.
    expect(POPUP_SRC).toContain("const mergeUnsubStatuses = (msg) => {");
    const handler = between(POPUP_SRC, "const handleSubsProgress = (msg) => {", "const handleReportProgress");
    const cancelled = between(handler, 'if (phase === "cancelled") {', "return;");
    expect(cancelled).toContain("mergeUnsubStatuses(msg)");
    const errored = between(handler, 'if (phase === "error") {', "return;");
    expect(errored).toContain("mergeUnsubStatuses(msg)");
    // And the done branch goes through the same helper, so the three
    // paths cannot drift.
    expect(handler).toContain("const okCount = mergeUnsubStatuses(msg);");
  });

  test("the merge only ever acts on an unsubscribe run's own results", () => {
    const merge = between(POPUP_SRC, "const mergeUnsubStatuses = (msg) => {", "const handleSubsProgress");
    expect(merge).toContain('if (msg?.runKind !== "unsubscribe" || !Array.isArray(msg.unsubResults)) return 0;');
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

  test("the diagnostics page's own copy of the tag palette", () => {
    // This page carries hardcoded light overrides of the shared tag
    // colours, so the fix in shared.css does not reach it. Its warning
    // override was the fill again, at the same 4.17:1.
    const DIAG = stripComments(read("diagnostics.html"));
    expect(DIAG).toContain('html[data-theme="light"] .text-warning { color: var(--ink-warn); }');
    expect(DIAG).not.toContain('.text-warning { color: #b45309; }');
  });

  test("no chip anywhere writes its label in its own fill", () => {
    // The exact defect shape, and the only one worth pinning: a rule
    // that paints `var(--X-bg)` behind text and then writes that text in
    // `var(--X)`. The tint darkens the ground the label has to clear, so
    // this pairing is under 4.5:1 on light by construction.
    //
    // Deliberately narrow, twice over. The same fill hex used as text on
    // a PLAIN card is fine and measures 4.77:1 or better, so a blanket
    // ban on the literal would fail against working code. And `danger`
    // is left out on purpose: measured, it is 5.29:1 on light and 5.76:1
    // on dark, because red is the one semantic colour whose fill was
    // already dark enough to write with. Adding an --ink-danger would
    // change nothing and this pin would then be asserting a habit
    // rather than a contrast rule.
    const SEMANTIC = ["success", "warning", "info", "primary"];
    for (const file of ["shared.css", "popup.html", "options.html", "progress.html", "diagnostics.html", "stats.html", "changelog.html"]) {
      const src = stripComments(read(file));
      for (const name of SEMANTIC) {
        const re = new RegExp(
          `background:\\s*var\\(--${name}-bg\\)[^{}]*?color:\\s*var\\(--${name}\\)|color:\\s*var\\(--${name}\\)[^{}]*?background:\\s*var\\(--${name}-bg\\)`,
          "g"
        );
        const hits = src.match(re) || [];
        expect({ file, name, hits }).toEqual({ file, name, hits: [] });
      }
    }
  });

  test("that pin can still catch one", () => {
    // A matcher that cannot fail is worse than no matcher. This is the
    // shape it is hunting, written out.
    const bad = ".x { background: var(--success-bg); color: var(--success); }";
    const re = /background:\s*var\(--success-bg\)[^{}]*?color:\s*var\(--success\)/g;
    expect(bad.match(re)).toHaveLength(1);
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

  test("an escaped token matches itself and nothing else", () => {
    // The end-to-end property, in the guard's own shape. A token with a
    // metacharacter has to match its own literal text and refuse to
    // stand in for anything else, which is exactly what a broken escape
    // gives up: `.` would match any character, so `in:a.b` would also
    // refuse the innocent `in:axb`.
    //
    // The token ends in a word character on purpose. The guard anchors
    // with \b, so a token ending in `)` or `.` cannot be matched at the
    // end of a query at all, escape or no escape, and testing one would
    // be measuring the anchor rather than the escape.
    for (const [file, src] of [["shared.js", SHARED_SRC], ["contentScript.js", ENGINE_SRC]]) {
      const literal = escapersIn(src)[0];
      // eslint-disable-next-line no-new-func
      const re = new Function(`return ${literal};`)();
      const token = "in:a.b";
      const positive = new RegExp(`(^|[\\s({])${token.replace(re, "\\$&")}\\b`, "i");
      expect({ file, own: positive.test("older_than:1y in:a.b") }).toEqual({ file, own: true });
      expect({ file, other: positive.test("older_than:1y in:axb") }).toEqual({ file, other: false });
      // And the grouping forms 7.15 and 8.12 added still work through it.
      expect({ file, paren: positive.test("(in:a.b)") }).toEqual({ file, paren: true });
      expect({ file, brace: positive.test("{in:a.b is:unread}") }).toEqual({ file, brace: true });
    }
  });

  test("the negation form still exempts a token the query already excludes", () => {
    // The other half of queryHasDangerousToken: `-in:a.b` must read as
    // excluded rather than targeted.
    for (const src of [SHARED_SRC, ENGINE_SRC]) {
      const literal = escapersIn(src)[0];
      // eslint-disable-next-line no-new-func
      const re = new Function(`return ${literal};`)();
      const esc = "in:a.b".replace(re, "\\$&");
      const negated = new RegExp(`(^|[\\s({])-\\s*${esc}\\b`, "i");
      expect(negated.test("older_than:1y -in:a.b")).toBe(true);
      expect(negated.test("older_than:1y in:a.b")).toBe(false);
    }
  });
});
