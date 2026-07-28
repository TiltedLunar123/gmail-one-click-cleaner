/**
 * @jest-environment node
 *
 * Run-claim and pending-marker ordering in popup.js (7.14).
 *
 * Two defects, both in the Pro run paths (storage purge, smart apply)
 * and both invisible to the other suites:
 *
 *  1. The pending marker (gmailCleanerStorageXrayPurgeStarted /
 *     gmailCleanerSmartApplyStarted) was sent BEFORE the
 *     already-attached guard, so a refused run left the worker holding
 *     a marker for a run that never started.
 *  2. Their catch blocks cleared ACTIVE_RUN unconditionally. An error
 *     raised before the claim (no Gmail tab, tab creation refused)
 *     therefore wiped the claim of whatever run was genuinely in
 *     flight, and the duplicate-run guard stopped protecting it.
 *
 * Both are ordering/argument properties of the source, so they are
 * pinned by reading popup.js, the same way popup-progress-tab.test.js
 * does. A live-Gmail test is not available in this project.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf-8");

const indicesOf = (haystack, needle) => {
  const out = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
};

const bodyOf = (startNeedle, endNeedle) => {
  const start = src.indexOf(startNeedle);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endNeedle, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
};

const PENDING_MARKERS = [
  "gmailCleanerStorageXrayPurgeStarted",
  "gmailCleanerSmartApplyStarted"
];

describe("pending markers wait for the attached guard", () => {
  test.each(PENDING_MARKERS)("%s is stamped after the guard, not before", (marker) => {
    const markerAt = src.indexOf(marker, src.indexOf("const handleXrayPurge"));
    expect(markerAt).toBeGreaterThan(-1);

    const guardsBefore = indicesOf(src, "if (await isEngineAttached(gmailTab.id)) {")
      .filter((g) => g < markerAt);
    expect(guardsBefore.length).toBeGreaterThan(0);

    // Nothing else may claim or open between the guard and the marker:
    // the marker has to be the first thing that happens once the run is
    // known to be going ahead.
    const between = src.slice(guardsBefore[guardsBefore.length - 1], markerAt);
    expect(between).not.toContain("tryClaimRun");
  });
});

describe("clearActiveRun only drops our own claim", () => {
  const helper = bodyOf("const clearActiveRun = async", "const getActiveRun =");

  test("it accepts an expected run id and compares before clearing", () => {
    expect(helper).toMatch(/clearActiveRun = async \(expectedRunId = null\)/);
    expect(helper).toMatch(/current\.runId !== expectedRunId/);
  });

  test("no expected id still clears, for the terminal handlers", () => {
    // done / error / cancelled arrive after the run they describe is
    // over, and they carry no claim of their own to compare against.
    expect(helper).toMatch(/if \(expectedRunId\) \{/);
  });
});

describe("run paths never clear a claim they did not take", () => {
  const paths = [
    ["handleXrayPurge", "const handleXrayPurge", "// Smart Suggestions (7.8)"],
    ["startSmartApplyRun", "const startSmartApplyRun =", "const handleSmartApply ="],
    ["runCleanup", "const runCleanup = async", "// Subscriptions: scan + bulk unsubscribe"]
  ];

  test.each(paths)("%s tracks its claim id", (_name, start, end) => {
    const body = bodyOf(start, end);
    expect(body).toMatch(/claimedRunId = claim(ed)?\.?(claim)?\.?runId|claimedRunId = claim\.claim\.runId/);
  });

  test.each(paths)("%s guards the catch-block release on that id", (_name, start, end) => {
    const body = bodyOf(start, end);
    const catchAt = body.lastIndexOf("} catch (err) {");
    expect(catchAt).toBeGreaterThan(-1);
    const tail = body.slice(catchAt);
    // The bare form is what wiped a foreign claim.
    expect(tail).not.toMatch(/await clearActiveRun\(\);/);
    expect(tail).toMatch(/if \(claimedRunId\) await clearActiveRun\(claimedRunId\);/);
  });
});
