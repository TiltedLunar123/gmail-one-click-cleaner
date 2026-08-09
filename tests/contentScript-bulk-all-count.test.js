/**
 * @jest-environment node
 *
 * Pins how a confirmed "select all N conversations" batch is measured.
 *
 * extractSelectedCount reports the selected rows in the viewport
 * (`tr.x7`), which is one page. Once Gmail confirms an all-matching
 * selection it acts on every match instead, so measuring the page made
 * the run-level soft cap and the huge-run confirmation compare a ~50
 * against thresholds of 10,000 and up: a bulk-all sweep of tens of
 * thousands of conversations passed both without a prompt. The same page
 * count was then recorded as the affected total, so liveRunProcessedSoFar
 * undercounted and later pages never caught up either.
 *
 * These are static source pins because the surrounding function drives
 * live Gmail DOM. They fail against the previous implementation, which
 * read `selectedCount` at all three sites.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

const ACT_RE = /async\s+function\s+actOnCurrentPageIfAny\s*\(tagLabel\)\s*\{[\s\S]*?\n\s\s\}/;
const actBlock = src.match(ACT_RE);
if (!actBlock) {
  throw new Error("contentScript.js actOnCurrentPageIfAny not found; test needs an update");
}
const act = actBlock[0];

describe("contentScript.js: bulk-all measurement", () => {
  test("captures the match total whenever a bulk selection was clicked", () => {
    // 7.15 widened this from bulkAllSelected to bulkSelected. Verifying
    // the selection is language-dependent; having CLICKED the
    // select-all-matching link is not, and the guardrails have to be
    // sized for what that click can touch.
    //
    // 8.12 gave it a second source. The toolbar counter reads "1-50 of
    // many" on the largest result sets, so estimateTotalResults returns
    // null there and the old single-source read left the guardrails on
    // the viewport count for exactly the runs that needed them most.
    // The select-all offer names the total in its own text.
    expect(act).toMatch(/const\s+counterTotal\s*=\s*bulkSelected\s*\?\s*estimateTotalResults\(\)\s*:\s*null;/);
    expect(act).toMatch(/const\s+offerTotal\s*=\s*bulkSelected\s*\?\s*\(selectAllResult\.offerTotal\s*\?\?\s*null\)\s*:\s*null;/);
    expect(act).toMatch(
      /const\s+matchTotal\s*=\s*counterTotal\s*===\s*null\s*&&\s*offerTotal\s*===\s*null[\s\S]{0,120}Math\.max\(\s*counterTotal\s*\?\?\s*0\s*,\s*offerTotal\s*\?\?\s*0\s*\)/
    );
  });

  test("an unreadable total is treated as over-cap, not as one page", () => {
    // Both sources silent while the offer WAS clicked means Gmail is
    // about to act on an unknown number of conversations. Sizing that at
    // the ~50 visible rows is the failure this replaced.
    expect(act).toMatch(/const\s+matchTotalUnknown\s*=\s*bulkSelected\s*&&\s*matchTotal\s*===\s*null;/);
    expect(act).toMatch(/projectedTotal\s*>\s*GUARDRAILS\.RUN_SOFT_CAP\s*\|\|\s*matchTotalUnknown/);
    expect(act).toMatch(/kind:\s*matchTotalUnknown\s*\?\s*"unknownBulk"\s*:\s*"softCap"/);
  });

  test("derives an effective count that prefers the match total", () => {
    expect(act).toMatch(
      /const\s+effectiveCount\s*=\s*bulkAllSelected[\s\S]{0,120}Math\.max\(\s*matchTotal\s*\?\?\s*0\s*,\s*selectedCount\s*\?\?\s*0\s*\)/
    );
  });

  test("the guardrail count reaches the match total on any bulk click", () => {
    expect(act).toMatch(
      /const\s+guardrailCount\s*=\s*bulkSelected[\s\S]{0,80}Math\.max\(\s*matchTotal\s*\?\?\s*0\s*,\s*effectiveCount\s*\?\?\s*0\s*\)/
    );
  });

  test("the run-level soft cap projects from the guardrail count, not the viewport", () => {
    expect(act).toMatch(/projectedTotal\s*=\s*liveRunProcessedSoFar\s*\+\s*\(guardrailCount\s*\?\?\s*0\)/);
    expect(act).not.toMatch(/projectedTotal\s*=\s*liveRunProcessedSoFar\s*\+\s*\(selectedCount\s*\?\?\s*0\)/);
  });

  test("the huge-run confirmation estimates from the guardrail count", () => {
    expect(act).toMatch(/const\s+estimatedTotal\s*=\s*guardrailCount\s*\?\?\s*estimateTotalResults\(\)/);
    expect(act).not.toMatch(/const\s+estimatedTotal\s*=\s*selectedCount\s*\?\?\s*estimateTotalResults\(\)/);
  });

  test("the large-batch warning is measured against the guardrail count", () => {
    // It compared the viewport selection with a threshold of 2,000 while
    // Gmail pages at most 100 rows, so it could never fire.
    expect(act).toMatch(
      /\(guardrailCount\s*\?\?\s*0\)\s*>\s*GUARDRAILS\.LARGE_BATCH_WARN_THRESHOLD/
    );
    expect(act).not.toMatch(
      /\(selectedCount\s*\?\?\s*0\)\s*>\s*GUARDRAILS\.LARGE_BATCH_WARN_THRESHOLD/
    );
  });

  test("the affected count for a bulk-all action uses the same figure the guardrails did", () => {
    expect(act).toMatch(
      /if\s*\(bulkAllSelected\)\s*\{[\s\S]{0,500}affectedCount\s*=\s*effectiveCount\s*\|\|\s*rowsBeforeAction\s*\|\|\s*0;/
    );
    // Never fall back to a bare match total: a misparsed "of N" smaller
    // than the visible selection would book fewer than the viewport count.
    expect(act).not.toMatch(/affectedCount\s*=\s*\(totalBeforeAction\s*&&/);
  });

  test("dry run previews the same figure the guardrails used", () => {
    expect(act).toMatch(/const\s+estimated\s*=\s*guardrailCount\s*\?\?\s*estimateTotalResults\(\)\s*\?\?\s*0;/);
    expect(act).not.toMatch(/const\s+estimated\s*=\s*selectedCount\s*\?\?/);
  });

  test("the match total is captured once, before tagging touches the page", () => {
    // It used to be read a second time just before the action, after
    // tagging and any confirmation had already run. The two remaining
    // estimateTotalResults() calls are nullish fallbacks that only fire
    // when there is no count at all.
    expect(act.match(/bulkSelected\s*\?\s*estimateTotalResults\(\)/g) || []).toHaveLength(1);
    expect(act).not.toMatch(/totalBeforeAction/);

    const captureAt = act.indexOf("const matchTotal");
    const tagAt = act.indexOf("applyTagLabel");
    expect(captureAt).toBeGreaterThan(-1);
    expect(tagAt).toBeGreaterThan(captureAt);
  });

  test("still measures a per-viewport selection with the viewport count", () => {
    // Non-bulk runs are unchanged: effectiveCount falls back to
    // selectedCount, and countBeforeAction remains the accurate signal.
    expect(act).toMatch(/:\s*selectedCount;/);
    expect(act).toMatch(/affectedCount\s*=\s*countBeforeAction;/);
  });
});

describe("contentScript.js: cancel before the destructive click", () => {
  // Cancel was honoured by the per-query loops, but the stretch between
  // selecting a page and clicking Delete covers tagging, an optional
  // confirm() and several settle sleeps. Cancelling in that window used
  // to delete the already-selected batch anyway.
  test("checks CANCELLED immediately before the action fires", () => {
    const idx = act.indexOf("const actionSuccess");
    const guard = act.lastIndexOf("if (CANCELLED)", idx);
    expect(guard).toBeGreaterThan(-1);
    expect(act.slice(guard, idx)).toMatch(/throw\s+new\s+CancellationError\(/);
  });

  // A plain return reads to processQuery as "nothing to act on". On a
  // single-rule run (every Storage X-ray purge and Smart apply is one
  // rule) the loop would fall through to the success summary and report
  // the cancelled run as finished.
  test("aborts the run instead of returning a no-op result", () => {
    const idx = act.indexOf("const actionSuccess");
    const guard = act.lastIndexOf("if (CANCELLED)", idx);
    expect(act.slice(guard, idx)).not.toMatch(/reason:\s*"user-cancelled"/);
  });
});

describe("contentScript.js: a late cancel is not reported as success", () => {
  const src2 = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

  test("the rule loop re-checks CANCELLED after its last iteration", () => {
    expect(src2).toMatch(
      /await\s+processQuery\(rules\[i\],\s*i,\s*totalQueries\);\s*\n\s*\}\s*\n[\s\S]{0,300}if\s*\(CANCELLED\)\s*\{\s*\n\s*throw\s+new\s+CancellationError\([\s\S]{0,80}\}\s*\n\s*\n\s*const\s+doneStats\s*=\s*buildFinalStats/
    );
  });

  test("CancellationError still reaches the cancelled phase", () => {
    // processQuery only swallows rate-limit and timeout errors, so a
    // CancellationError propagates to the run-level handler.
    expect(src2).toMatch(/if\s*\(e\s+instanceof\s+CancellationError\)\s*\{[\s\S]{0,200}phase:\s*"cancelled"/);
  });
});
