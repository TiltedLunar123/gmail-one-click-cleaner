/**
 * @jest-environment jsdom
 *
 * Service worker and UI findings from the 8.9 sweep.
 *
 * Every assertion here was checked to FAIL against the 8.8.0 source
 * before the fix landed. The age helpers are pure functions and get
 * real behavioural tests, including the pin that keeps the shared copy
 * and the engine's copy from drifting; the claim and schedule races are
 * orderings inside one function and are pinned as such, scoped to the
 * function that changed.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const bgSrc = read("background.js");
const popupSrc = read("popup.js");
const popupHtml = read("popup.html");
const optionsSrc = read("options.js");
const progressSrc = read("progress.js");
const statsSrc = read("stats.js");
const engineSrc = read("contentScript.js");

const sharedCode = read("shared.js");
const iifeMatch = sharedCode.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
  {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      className: "", setAttribute: () => {}, appendChild: () => {},
      style: {}, classList: { add: () => {}, remove: () => {} }, remove: () => {}
    }),
    addEventListener: () => {}
  },
  {},
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

/** The body of a named function or const arrow, so a pin cannot pass on
 *  an unrelated match somewhere else in a 2,900 line file. */
function fnBody(src, header, endMarker = "\n  }") {
  const at = src.indexOf(header);
  if (at === -1) throw new Error(`not found: ${header}`);
  const end = src.indexOf(endMarker, at + header.length);
  return src.slice(at, end === -1 ? src.length : end);
}

describe("8.9: an unattended run verifies the claim it just wrote", () => {
  // Both unattended paths check hasActiveRun, then await a tab lookup, a
  // licence verification and an attach probe before writing the marker.
  // Two writers landing in that window left the loser believing it held
  // a claim it did not: its own release then no-ops on the id mismatch,
  // and a failed injection on the winner's side clears the marker while
  // the loser's engine is still cleaning the mailbox.
  test("there is one claim helper and it re-reads after writing", () => {
    const fn = fnBody(bgSrc, "async function claimRun(claim) {");
    expect(fn).toContain("if (await hasActiveRun()) return false;");
    expect(fn).toContain("const held = await hasActiveRun();");
    expect(fn).toContain("return held?.runId === claim.runId;");
  });

  test("both unattended callers go through it and bail when it fails", () => {
    expect(bgSrc.split("await claimRun(claim)").length - 1).toBe(2);
    const sched = fnBody(bgSrc, "async function runScheduledCleanup(scheduleId) {", "\n  async function");
    expect(sched).toContain("if (!(await claimRun(claim))) {");
    const apply = fnBody(bgSrc, "async function startAutoPilotApply(", "\n  async function");
    expect(apply).toContain("if (!(await claimRun(claim))) {");
  });

  test("claimedRunId is only set once the marker is confirmed ours", () => {
    const sched = fnBody(bgSrc, "async function runScheduledCleanup(scheduleId) {", "\n  async function");
    const claimAt = sched.indexOf("await claimRun(claim)");
    const assignAt = sched.indexOf("claimedRunId = runId;");
    expect(claimAt).toBeGreaterThan(-1);
    expect(assignAt).toBeGreaterThan(claimAt);
  });
});

describe("8.9: a finished schedule stamps only its own row", () => {
  // The old write put back the schedules array captured at the top of
  // the attempt. Injecting plus confirming takes seconds, so anything
  // the Options page did in that window was undone: a deleted schedule
  // came back, an intensity edit reverted, and another schedule's fresh
  // lastRun was rolled back, which re-armed its alarm about a minute out
  // and ran that cleanup a second time, unattended.
  test("the stamp re-reads storage and patches one entry", () => {
    const fn = fnBody(bgSrc, "async function markScheduleRan(scheduleId) {", "\n  async function");
    expect(fn).toContain("await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES)");
    expect(fn).toMatch(/schedules\[idx\]\s*=\s*\{\s*\.\.\.schedules\[idx\],\s*lastRun:\s*Date\.now\(\)\s*\}/);
  });

  test("a schedule deleted mid-run is not resurrected", () => {
    const fn = fnBody(bgSrc, "async function markScheduleRan(scheduleId) {", "\n  async function");
    expect(fn).toContain("if (idx < 0) return false;");
  });

  test("the whole-array write is gone", () => {
    expect(bgSrc).not.toContain("schedule.lastRun = Date.now();");
  });
});

describe("8.9: dropping a claim always compares first", () => {
  test("a closed Gmail tab releases through the compare-and-release helpers", () => {
    const fn = fnBody(bgSrc, "chrome.tabs.onRemoved.addListener(async (tabId) => {");
    expect(fn).toContain("await releaseRunClaim(run.runId)");
    expect(fn).toContain("await releaseRunClaimForTab(tabId)");
    expect(fn).not.toContain("[STORAGE_KEYS.ACTIVE_RUN]: null }");
  });

  test("an expired claim is released by id, not wiped wholesale", () => {
    const fn = fnBody(bgSrc, "async function hasActiveRun() {");
    expect(fn).toContain("if (run.runId) await releaseRunClaim(run.runId);");
    expect(fn).not.toContain("await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null });");
  });
});

describe("8.9: Auto-Pilot's apply stage checks identity like its scan stage", () => {
  // Cleanup progress deliberately omits runKind, so `!msg.runKind` means
  // "some cleanup". On the error branch that cleared this sweep's
  // pending state for a run which had nothing to do with it.
  test("a mismatched run id is ignored", () => {
    const fn = fnBody(bgSrc, "async function handleAutoPilotProgress(msg, senderTabId) {");
    const applyAt = fn.indexOf('if (pending.stage === "apply"');
    expect(applyAt).toBeGreaterThan(-1);
    const block = fn.slice(applyAt);
    expect(block).toContain(
      'if (pending.runId && msg.runId && String(msg.runId) !== String(pending.runId)) {'
    );
  });

  test("an engine too old to send one keeps the tab-only behaviour", () => {
    const fn = fnBody(bgSrc, "async function handleAutoPilotProgress(msg, senderTabId) {");
    // `msg.runId &&` is the compatibility half: without it, every
    // pre-8.9 engine's terminal message would be ignored and the stage
    // machine would never close out.
    expect(fn).toContain("pending.runId && msg.runId &&");
  });
});

describe("8.9: age tokens have one definition", () => {
  test("the tokens the two selects offer all resolve", () => {
    expect(GCC.ageTokenDays("3m")).toBe(90);
    expect(GCC.ageTokenDays("6m")).toBe(180);
    expect(GCC.ageTokenDays("1y")).toBe(365);
    expect(GCC.ageTokenDays("2y")).toBe(730);
  });

  test("anything that is not an age is null, never zero", () => {
    // Zero would read as "no floor at all" to the comparison below.
    for (const bad of ["", null, undefined, "soon", "0m", "-1y", "6", "m"]) {
      expect(GCC.ageTokenDays(bad)).toBeNull();
    }
  });

  test("the stricter of two tokens wins, in either order", () => {
    expect(GCC.strictestAgeToken("6m", "1y")).toBe("1y");
    expect(GCC.strictestAgeToken("1y", "6m")).toBe("1y");
    expect(GCC.strictestAgeToken("", "1y")).toBe("1y");
    expect(GCC.strictestAgeToken("6m", "")).toBe("6m");
    expect(GCC.strictestAgeToken("", "")).toBeNull();
  });

  test("it agrees with the engine's own copy over every token in the UI", () => {
    // The engine cannot reach GCC, so ageTokenToDays is duplicated
    // there. Duplicated matchers in this repo have drifted three times.
    const unitTable = engineSrc.match(/AGE_UNIT_DAYS\s*=\s*Object\.freeze\(\{([^}]*)\}\)/);
    expect(unitTable).not.toBeNull();
    for (const [unit, days] of [["d", 1], ["w", 7], ["m", 30], ["y", 365]]) {
      expect(unitTable[1]).toContain(`${unit}: ${days}`);
      expect(GCC.ageTokenDays(`1${unit}`)).toBe(days);
    }
  });
});

describe("8.9: the X-ray caveat names the filter the purge really applies", () => {
  // 7.15 stopped scoped runs forcing minAge to null, so the Clean tab's
  // Minimum Age rides along and applyGlobalGuards appends it whenever it
  // is stricter. With Minimum Age at 1 year and the X-ray select at 6
  // months, the note promised six months for a run that demanded a year.
  test("the note is built from the stricter of the two controls", () => {
    expect(popupSrc).toContain("const effectiveXrayAge = () =>");
    expect(popupSrc).toContain(
      'GCC.strictestAgeToken(elements.xrayAge?.value || "", elements.minAgeEl?.value || "")'
    );
    const fn = fnBody(popupSrc, "const renderXrayAgeNote = () => {", "\n  };");
    expect(fn).toContain("const age = effectiveXrayAge();");
  });

  test("changing Minimum Age re-renders it", () => {
    expect(popupSrc).toContain('elements.minAgeEl?.addEventListener("change", renderXrayAgeNote);');
  });
});

describe("8.9: no surface claims storage was freed by an archive", () => {
  test("the progress page and its receipt read the action first", () => {
    const fn = fnBody(progressSrc, "const freedMbOf = (stats) => {", "\n  };");
    expect(fn).toContain('if (stats?.action === "archive") return 0;');
  });

  test("the popup result and recap go through one gate", () => {
    const fn = fnBody(popupSrc, "const showResultSummary = (", "\n  };");
    expect(fn).toContain('const archived = action === "archive";');
    expect(fn).toContain("elements.resultFreedClause.hidden = archived");
  });

  test("the freed clause is its own element so it can be removed entirely", () => {
    // Not merely zeroed: "Freed ~0 MB" is still a claim about storage.
    expect(popupHtml).toContain('id="resultFreedClause"');
    expect(popupSrc).toContain('resultFreedClause: $("resultFreedClause"),');
  });

  test("the run history on Stats does the same for rows written earlier", () => {
    expect(statsSrc).toContain('recordedAction === "archive" ? GCC.formatMb(0) : GCC.formatMb(run.freedMb)');
  });
});

describe("8.9: a full run persists its config only once it will start", () => {
  // lastConfig is what the progress page replays on a re-inject, and
  // buildConfig describes the whole Clean tab. Written before the
  // attached-engine refuse, it overwrote the narrow scope of whichever
  // run was actually attached, so a purge of four senders came back as a
  // sweep of the entire mailbox.
  test("persistLastConfig comes after the attached guard in runCleanup", () => {
    const fn = fnBody(popupSrc, "const runCleanup = async (", "\n  const ");
    const guardAt = fn.indexOf("if (await isEngineAttached(gmailTab.id)) {");
    const persistAt = fn.indexOf("await persistLastConfig(config);");
    expect(guardAt).toBeGreaterThan(-1);
    expect(persistAt).toBeGreaterThan(guardAt);
  });
});

describe("8.9: a run that has not happened is not announced as done", () => {
  test("the live smart apply toast says started, like every sibling", () => {
    expect(popupSrc).toContain('t("smartApplyStarted", "suggestion started")');
    expect(popupSrc).not.toContain('t("smartApplied", "suggestion applied")');
  });
});

describe("8.9: Options refuses to save a rule the engine will refuse", () => {
  // It used to warn and write anyway, so the page ended on "Settings
  // saved successfully!" and the next run quietly skipped the intensity
  // the user had just edited.
  test("validateData separates blocking errors from absorbable ones", () => {
    const fn = fnBody(optionsSrc, "const validateData = (data) => {", "\n  /**");
    expect(fn).toContain("const blocking = [];");
    expect(fn).toContain("return { valid: errors.length === 0, errors, blocking };");
  });

  test("a blocking error stops the write", () => {
    const fn = fnBody(optionsSrc, "const saveData = async (", "\n  //");
    const blockAt = fn.indexOf("if (validation.blocking.length) {");
    const writeAt = fn.indexOf("await safeSyncSet({");
    expect(blockAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(blockAt);
    expect(fn.slice(blockAt, writeAt)).toContain("return;");
  });

  test("an unusable whitelist line still saves, because the normaliser drops it", () => {
    const fn = fnBody(optionsSrc, "const validateData = (data) => {", "\n  /**");
    const wlAt = fn.indexOf("Invalid whitelist entry at line");
    expect(wlAt).toBeGreaterThan(-1);
    // Pushed to errors only, never to blocking.
    expect(fn.slice(wlAt, wlAt + 200)).not.toContain("blocking.push");
  });
});

describe("8.9: a step Safe Mode refuses says so before it is clicked", () => {
  test("the row carries the note, not just the post-click toast", () => {
    expect(popupSrc).toContain('t("reportSafeModeSkips", "Safe Mode skips this step")');
    expect(popupSrc).toContain('blocked.className = "report-row-blocked";');
    expect(popupHtml).toContain(".report-row-blocked {");
  });

  test("an unmeasured band is not printed as a count of zero", () => {
    expect(popupSrc).toContain('t("reportBandUnmeasured", "not measured")');
    expect(popupSrc).toContain("const measured = band.measured !== false;");
  });

  test("a report stored before 8.9 counts as measured", () => {
    // Absent has to mean true, or every existing report would suddenly
    // render as though nothing in it had ever been looked at.
    expect(bgSrc).toContain("measured: raw?.measured !== false,");
  });
});
