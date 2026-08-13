/**
 * @jest-environment node
 *
 * 8.16 sweep.
 *
 * The release has one headline and one recurring shape underneath it.
 *
 * The headline: a TERMINAL message is not a COMPLETION. The engine sends
 * gmailCleanerDone from a `finally`, so a run the user cancelled and a run
 * that died on an unexpected error posted the same shaped summary as one
 * that finished, carrying whatever they had moved up to that point. Four
 * things in the worker wrote a durable "you are finished with this" mark off
 * that summary, deciding on `dryRun` and `count > 0` alone: the Mailbox
 * Report's Cleared chip (which also takes that step's Run button away, and a
 * free user has exactly one), the Storage X-ray's Purged chip, Smart
 * Suggestions' applied feedback, and Auto-Pilot's preview count. The quieter
 * half of the same hole is a run that finished successfully having left mail
 * behind, because a rule ran out of passes or Gmail kept rate limiting it:
 * the engine said so only in a `warning` progress message, which reaches an
 * open extension page and nothing else.
 *
 * The shape underneath: a read that FAILED is not a read that found nothing.
 * 8.14 gave readLicenseState a third answer, 8.15 gave readSafetyList one.
 * This release found four more readers with two answers where they needed
 * three, and every one of them is on the write side, which is what makes
 * them data loss rather than a wrong screen: the Options page painting empty
 * safety lists that the next Save writes, the Pro Settings card painting
 * defaults that one edit persists (undo cap 300 -> 60, and the next run
 * trims the log to it), getAutoPilotConfig answering "off and unconfirmed"
 * and then having that written back over a paying user's settings, and
 * snooze answering "not snoozed" for unattended sweeps.
 *
 * Proof standard: these assertions were run against 8.15.0 in a throwaway
 * worktree. The count that failed there is recorded in the release notes.
 */

const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf-8");

const ENGINE_SRC = read("contentScript.js");
const SW_SRC = read("background.js");
const POPUP_SRC = read("popup.js");
const POPUP_HTML = read("popup.html");
const OPTIONS_SRC = read("options.js");
const OPTIONS_HTML = read("options.html");
const STATS_SRC = read("stats.js");
const SHARED_SRC = read("shared.js");

// Slices source between two anchors. Returns "" for a missing anchor rather
// than throwing: this file is run against the PREVIOUS release to prove it
// catches the defects, and a throwing slicer aborts collection and reports
// "0 total" instead of per-test failures (the 8.15 trap).
const between = (src, start, end) => {
  const a = src.indexOf(start);
  if (a === -1) return "";
  const b = src.indexOf(end, a + start.length);
  if (b <= a) return "";
  return src.slice(a, b);
};

// =====================================================================
// 1. A terminal message is not a completion
// =====================================================================

describe("the engine says whether the run actually finished", () => {
  test("main tracks which of its three terminal branches ran", () => {
    const main = between(ENGINE_SRC, "async function main() {", "Failed to send done message to background");
    expect(main).toContain('let runOutcome = "error";');
    expect(main).toContain('runOutcome = "completed";');
    expect(main).toContain('runOutcome = "cancelled";');
  });

  test("it starts at error, so anything unaccounted for cannot claim to have finished", () => {
    const main = between(ENGINE_SRC, "async function main() {", "try {");
    expect(main).toMatch(/let runOutcome = "error";/);
  });

  test("cancelled is set on the cancellation branch, not inferred from a count", () => {
    const branch = between(ENGINE_SRC, "if (isCancellation) {", 'phase: "cancelled"');
    expect(branch).toContain('runOutcome = "cancelled";');
  });

  test("the done summary carries the outcome and the count of rules that stopped short", () => {
    const summary = between(ENGINE_SRC, 'type: "gmailCleanerDone"', "});");
    expect(summary).toContain("outcome: runOutcome");
    expect(summary).toContain("stoppedShort: Number(stats.stoppedShort) || 0");
  });

  test("both short exits in processQuery are counted, not just described in a message", () => {
    const q = between(ENGINE_SRC, "async function processQuery(", "function buildFinalStats(");
    // The pass cap, and giving up on a rule that kept rate limiting.
    expect(q.match(/stats\.stoppedShort\+\+;/g) || []).toHaveLength(2);
    // Still says so out loud as well; the counter is the part that survives
    // a closed popup.
    expect(q).toContain("stopped at the pass limit");
  });

  test("resetStats clears it, so one run cannot inherit another's tally", () => {
    const reset = between(ENGINE_SRC, "function resetStats() {", "// 8.0: the two big-run guardrails");
    expect(reset).toContain("stats.stoppedShort = 0;");
  });

  test("buildFinalStats carries it, so the result screen can read it", () => {
    const f = between(ENGINE_SRC, "function buildFinalStats(totalQueries) {", "function buildHumanSummary(");
    expect(f).toContain("stoppedShort: Number(stats.stoppedShort) || 0");
  });

  test("the stats the history is built from carry it too", () => {
    const rec = between(ENGINE_SRC, 'type: "gmailCleanerRecordStats"', "});");
    expect(rec).toContain("stoppedShort: Number(stats.stoppedShort) || 0");
  });
});

describe("the worker refuses to mark work finished that was not", () => {
  const helper = between(SW_SRC, "function runFinishedClean(summary) {", "async function resolvePendingStoragePurge");

  test("runFinishedClean requires a completed outcome and nothing left behind", () => {
    expect(helper).toContain('if (summary.outcome !== "completed") return false;');
    expect(helper).toContain("return !(Number(summary.stoppedShort) > 0);");
  });

  test("a summary with no outcome at all cannot prove it finished", () => {
    // A Gmail tab still running a pre-8.16 content script after an update.
    // The cost of refusing is one rescan; the cost of trusting it is the
    // button the user needed to finish the job.
    expect(helper).toContain('if (!summary || typeof summary !== "object") return false;');
  });

  test.each([
    ["resolvePendingReportPurge", "async function resolvePendingReportPurge(summary) {", "// ========================="],
    ["resolvePendingStoragePurge", "async function resolvePendingStoragePurge(summary) {", "async function recordReportScan"],
    ["resolvePendingSmartApply", "async function resolvePendingSmartApply(summary) {", "// ========================="]
  ])("%s consults it before stamping", (_name, start, end) => {
    const fn = between(SW_SRC, start, end);
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).toContain("if (!runFinishedClean(summary)) return;");
    // Still consumes the marker either way: a refused stamp must not leave
    // the pending row to be resolved by somebody else's run.
    expect(fn).toContain("]: null });");
  });

  test("Auto-Pilot will not write a preview count off a sweep that stopped short", () => {
    const fn = between(SW_SRC, "async function resolveAutoPilotDone(summary) {", "async function getAutoPilotForPopup");
    expect(fn).toContain("const finishedClean = runFinishedClean(summary);");
    // The number the user presses "Turn on for real" against.
    expect(fn).toContain("if (finishedClean) patch.preview = { count, at: now };");
    // Left unwritten rather than nulled, so an earlier good preview stands.
    // Counted rather than matched around a line break. The first draft of
    // this assertion embedded a bare \n and so passed on a CRLF checkout and
    // failed on CI's LF one, which is the wrong reason for a test to be
    // green. Exactly one write of the preview, and it is the guarded one.
    expect(fn.match(/patch\.preview = \{ count, at: now \};/g) || []).toHaveLength(1);
    expect(fn).toContain("incomplete: !finishedClean");
  });

  test("the history row keeps the tally, clamped like every other number from the page", () => {
    const fn = between(SW_SRC, "async function recordStats(data) {", "async function getStats()");
    expect(fn).toContain("stoppedShort: Math.max(0, Math.min(999, Number(data.stoppedShort) || 0))");
  });
});

describe("every surface that reports a run says when it left mail behind", () => {
  test("the completion notification does, which is the only surface an unattended run has", () => {
    const fn = between(SW_SRC, "async function maybeNotifyDone(summary) {", "// =========================");
    expect(fn).toContain("const shortRules = Number(summary?.stoppedShort) || 0;");
    expect(fn).toContain("notifStoppedShortOne");
    expect(fn).toContain("notifStoppedShortMany");
    // Before the Pro pitch: the fact the user needs outranks the ad.
    expect(fn.indexOf("notifStoppedShortOne")).toBeLessThan(fn.indexOf("notifProPitch"));
  });

  test("the popup result screen has somewhere to say it", () => {
    expect(POPUP_HTML).toContain('id="resultPartialNote"');
    // A class, hidden by the global [hidden] rule this file carries.
    expect(POPUP_HTML).toContain("recap-note--partial");
    expect(POPUP_HTML).toContain("[hidden]");
  });

  test("its tone comes from the theme-aware warning trio, so both themes work", () => {
    const css = between(POPUP_HTML, ".recap-note--partial {", "}");
    expect(css).toContain("var(--warning-border)");
    expect(css).toContain("var(--warning-bg)");
    expect(css).toContain("var(--warning)");
  });

  // 8.16's own review caught this one: the amber tokens alone measured
  // 4.25:1 in light mode, under the 4.5 that 11px bold text needs, and close
  // enough that looking at it would have passed. Computed rather than
  // eyeballed, the way 7.8.1's contrast pass had to be, and read out of the
  // file so it measures what ships.
  test("the light theme override clears WCAG AA, and the dark theme still does", () => {
    const parse = (c) => {
      const n = parseInt(c.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    };
    const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
    const lum = (c) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a, b) => {
      const la = lum(a), lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    const m = POPUP_HTML.match(
      /html\[data-theme="light"\] \.recap-note--partial \{ color: (#[0-9a-f]{6}); \}/i
    );
    expect(m).not.toBeNull();

    // Light: page #d9e6ec, card rgba(255,255,255,0.86), tint rgba(180,83,9,0.1).
    const lightTint = over([180, 83, 9, 0.1], over([255, 255, 255, 0.86], parse("#d9e6ec")));
    expect(ratio(parse(m[1]), lightTint)).toBeGreaterThanOrEqual(4.5);

    // Dark: surface over the deep background, tint rgba(251,191,36,0.15).
    const darkTint = over([251, 191, 36, 0.15], [17, 26, 36, 1]);
    expect(ratio(parse("#fbbf24"), darkTint)).toBeGreaterThanOrEqual(4.5);
  });

  test("showResultSummary takes the count and hides the note at zero", () => {
    const fn = between(POPUP_SRC, "const showResultSummary = ({", "const hideResultSummary");
    expect(fn).toContain("stoppedShort = 0");
    expect(fn).toContain("resultPartialOne");
    expect(fn).toContain("resultPartialMany");
    expect(fn).toContain("elements.resultPartialNote.hidden = short === 0;");
  });

  test("both callers pass it, the recap included", () => {
    // A recap of a partial run is exactly when the user has forgotten.
    expect(POPUP_SRC).toContain("stoppedShort: Number(entry.stoppedShort) || 0");
    expect(POPUP_SRC).toContain("stoppedShort: Number(stats?.stoppedShort) || 0");
  });

  test("the Auto-Pilot line says it too", () => {
    const fn = between(POPUP_SRC, "const renderAutoPilot = () => {", "const handleAutoPilotToggle");
    expect(fn).toContain("if (ap.lastRun.incomplete) {");
    expect(fn).toContain("apLastSweepIncomplete");
  });
});

// =====================================================================
// 2. Reads that failed, on the write side
// =====================================================================

describe("Auto-Pilot's config has three answers, and only two of them may be written", () => {
  test("getAutoPilotConfig reports whether the read completed", () => {
    const fn = between(SW_SRC, "async function getAutoPilotConfig() {", "// The stored shape, and only the stored shape.");
    expect(fn).toContain("readable: true");
    expect(fn).toContain("return { enabled: false, confirmed: false, lastRunAt: 0, readable: false };");
  });

  test("the record builder cannot leak readable into the user's synced account", () => {
    const fn = between(SW_SRC, "function autoPilotRecord(cfg, patch) {", "async function getAutoPilotState");
    expect(fn).toContain("enabled: Boolean(cfg?.enabled)");
    expect(fn).toContain("confirmed: Boolean(cfg?.confirmed)");
    expect(fn).toContain("lastRunAt: Number(cfg?.lastRunAt) || 0");
    expect(fn).not.toContain("readable");
  });

  test("no sync write of the config spreads the config object any more", () => {
    // `{...cfg, oneField}` is what wrote the failure defaults back.
    expect(SW_SRC).not.toMatch(/\[STORAGE_KEYS\.AUTOPILOT\]:\s*\{\s*\.\.\.cfg/);
    expect(SW_SRC.match(/\[STORAGE_KEYS\.AUTOPILOT\]: autoPilotRecord\(cfg,/g) || []).toHaveLength(4);
  });

  test("the alarm is not cleared until the config is proven", () => {
    const fn = between(SW_SRC, "async function restoreAutoPilotAlarm() {", "async function runAutoPilot");
    const guardAt = fn.indexOf("if (!cfg.readable) {");
    const clearAt = fn.indexOf("await chrome.alarms.clear(AUTOPILOT_ALARM);");
    expect(guardAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(-1);
    // This ordering is the whole fix: clearing first deleted the weekly
    // sweep for the session and returned before recreating it.
    expect(guardAt).toBeLessThan(clearAt);
  });

  test("a finishing sweep will not re-anchor lastRunAt off an unreadable config", () => {
    const fn = between(SW_SRC, "async function resolveAutoPilotDone(summary) {", "async function getAutoPilotForPopup");
    expect(fn).toContain("if (cfg.readable) {");
    expect(fn).toContain("not re-anchoring lastRunAt");
  });

  test("the toggle and the confirm refuse rather than guess, and say which happened", () => {
    const toggle = between(SW_SRC, "async function setAutoPilotEnabled(enabled) {", "async function confirmAutoPilot");
    const confirm = between(SW_SRC, "async function confirmAutoPilot() {", "async function maybeNotifyDone");
    for (const fn of [toggle, confirm]) {
      expect(fn).toContain("let saved = true;");
      expect(fn).toContain('if (!saved) return { ok: false, error: "storage_unreadable" };');
    }
    // Switching OFF still stops a sweep in flight: an engine archiving mail
    // right now outranks the bookkeeping.
    expect(toggle).toContain("gmailCleanerCancel");
  });

  test("the popup tells the user which refusal it was", () => {
    expect(POPUP_SRC.match(/resp\?\.error === "storage_unreadable"/g) || []).toHaveLength(2);
    expect(POPUP_SRC).toContain("apStorageUnreadable");
  });
});

describe("the Options page will not overwrite settings it never read", () => {
  const load = between(OPTIONS_SRC, "const readSyncSettings = async () => {", "const validateData = (data) => {");

  test("the load reads sync directly, so a rejected read is visible", () => {
    expect(load).toContain("chrome.storage.sync.get.bind(chrome.storage.sync)");
    expect(load).toContain("return { ok: true, data: data || {} };");
    expect(load).toContain("return { ok: false, data: {} };");
    // The shared helper answers a rejected read with an empty object, which
    // is exactly what made empty safety lists look like configured ones.
    expect(load).not.toMatch(/GCC\.storageGet\s*\(/);
  });

  test("an unreadable load paints nothing, disables the form and says so", () => {
    expect(load).toContain("state.loadFailed = true;");
    expect(load).toContain("setSettingsFormEnabled(false);");
    expect(load).toContain("Could not read your settings");
    // renderSettings must NOT run on that path: painting empty lists is the
    // bug, not the symptom.
    const failBranch = between(load, "if (!read.ok) {", "state.loadFailed = false;");
    expect(failBranch).not.toContain("renderSettings(");
  });

  test("saveData refuses too, because Ctrl+S and import never touch the button", () => {
    const save = between(OPTIONS_SRC, "const saveData = async (evt = null, opts = {}) => {", "const setupChangeListeners");
    expect(save).toContain("if (state.loadFailed) {");
    expect(save).toContain("nothing can be saved over them");
    expect(save).toContain("return false;");
  });

  test("the disabled set covers every control whose value the save writes", () => {
    const ids = between(OPTIONS_SRC, "const SETTINGS_FORM_IDS = Object.freeze([", "]);");
    for (const id of ["...RULE_KEYS", "debugMode", "whitelist", "protectKeywords", "save"]) {
      expect(ids).toContain(id);
    }
  });

  // Found by this release's own review pass. Both of these reach storage
  // without going through saveData, so the DOM was their only guard, and
  // both re-enable their own button in a finally.
  test("export refuses too, rather than writing a backup of lists it never read", () => {
    const fn = between(OPTIONS_SRC, "const exportConfig = async () => {", "const handleImportFile = async (evt)");
    const guardAt = fn.indexOf("if (state.loadFailed) {");
    const loadingAt = fn.indexOf("setButtonLoading(btn, true)");
    expect(guardAt).toBeGreaterThan(-1);
    // Before the button-loading call, whose finally re-enables it.
    expect(guardAt).toBeLessThan(loadingAt);
    expect(fn).toContain("nothing safe to export");
  });

  test("import refuses too, because its rollback reads the storage that is failing", () => {
    const fn = between(OPTIONS_SRC, "const handleImportFile = async (evt) => {", "const setupKeyboardShortcuts");
    const guardAt = fn.indexOf("if (state.loadFailed) {");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(fn.indexOf("setButtonLoading(btn, true)"));
    // It writes through safeSyncSet, which saveData's refusal never sees.
    expect(fn).toContain("safeSyncSet(writeSet");
    expect(fn).toContain("cannot be undone");
  });
});

describe("the Pro Settings card shows what is in force or nothing at all", () => {
  test("shared gained a read that can say it could not read", () => {
    const fn = between(SHARED_SRC, "const readProSettingsOrNull = async (isPro) => {", "const proSettings = Object.freeze({");
    expect(fn).toContain("chrome.storage.sync.get.bind(chrome.storage.sync)");
    expect(fn).toContain("return null;");
    // No sync storage at all still answers with defaults, or the jsdom
    // suites and the http render harness see an unreadable card.
    expect(fn).toContain('if (!hasChromeStorage("sync")) return proSettingsEffective(null, isPro);');
    expect(SHARED_SRC).toContain("readOrNull: readProSettingsOrNull");
  });

  test("read() is untouched, because a RUN wants the defaults", () => {
    // Defaults are the free behaviour: a run reading them can only ever do
    // less. It is the page that writes them back that needed the third
    // answer.
    const fn = between(SHARED_SRC, "const readProSettings = async (isPro) => {", "// 8.16: the third answer");
    expect(fn).toContain('const stored = await storageGet("sync", PRO_SETTINGS_KEY);');
  });

  test("the card refuses to repaint or save on an unreadable read", () => {
    const fn = between(OPTIONS_SRC, "const renderState = async () => {", "const persist = async (settings, btn) => {");
    expect(fn).toContain("await GCC.proSettings.readOrNull(isPro)");
    expect(fn).toContain("if (settings === null) {");
    expect(fn).toContain("setProFieldsDisabled(true);");
    // And not the Pro-required panel: this user has paid.
    // And not through setLocked, which raises the "Pro required" panel: this
    // user has paid, the read just failed. Line-break-free so a CRLF
    // checkout and an LF one agree.
    const unreadable = between(fn, "if (settings === null) {", "applyToForm(settings);");
    expect(unreadable).toContain("setProFieldsDisabled(true);");
    expect(unreadable).not.toContain("setLocked(");
  });
});

describe("an import cannot empty the Global Whitelist by omitting it", () => {
  const fn = between(OPTIONS_SRC, "const buildImportWriteSet = (json) => {", "// 8.14: what the import will ACTUALLY write");

  test("the whitelist is guarded like its three neighbours", () => {
    expect(fn).toContain("if (Array.isArray(json.whitelist)) {");
    // The unconditional write is what emptied it: normalizeWhitelist
    // answers a missing key with [].
    expect(fn).not.toMatch(/\[STORAGE_KEYS\.WHITELIST\]: normalizeWhitelist\(json\.whitelist\)\s*\n?\s*\}/);
  });

  test("all four back-compat guards are present", () => {
    for (const key of ["json.whitelist", "json.protectKeywords", "json.customRules", "json.schedules"]) {
      expect(fn).toContain(`if (Array.isArray(${key})) {`);
    }
  });
});

describe("snooze fails closed for the only work it governs", () => {
  test("an unreadable snooze is answered null, not zero", () => {
    const fn = between(SW_SRC, "async function getSnoozeUntil() {", "// The question the three unattended callers");
    expect(fn).toContain("} catch { return null; }");
  });

  test("the unattended callers treat unreadable as snoozed", () => {
    const fn = between(SW_SRC, "async function snoozeBlocksUnattended() {", "async function hasActiveRun");
    expect(fn).toContain("if (until === null) return { blocked: true, until: null, readable: false };");
    // All three: the scheduled run, the Auto-Pilot sweep, and the
    // re-check between the sweep's scan and its apply.
    expect(SW_SRC.match(/snoozeBlocksUnattended\(\)/g) || []).toHaveLength(4);
  });

  test("nothing gates unattended work on the raw reading any more", () => {
    expect(SW_SRC).not.toMatch(/if\s*\(await getSnoozeUntil\(\)\)/);
  });

  test("the Options page stops reporting a snooze it did not manage to set", () => {
    const fn = between(OPTIONS_SRC, "const sendSnooze = async (days) => {", "clearBtn?.addEventListener");
    expect(fn).toContain("return Boolean(resp?.ok);");
    expect(fn).toContain("They are still active");
  });
});

describe("the recovery log cannot be un-cleared by a run finishing beside it", () => {
  test("clearUndoLog is queued like every other writer of that key", () => {
    expect(SW_SRC).toContain("withStorageLock(() => clearUndoLog())");
    expect(SW_SRC).not.toMatch(/^\s*clearUndoLog\(\)\.then/m);
  });

  test("it stays LOCKED(caller), because the queue is not re-entrant", () => {
    const fn = between(SW_SRC, "async function clearUndoLog() {", "// =========================");
    expect(fn).toContain("chrome.storage.local.set");
    expect(fn).not.toContain("withStorageLock");
  });
});

// =====================================================================
// 3. The engine reads its own numbers off the right element
// =====================================================================

describe("the results counter is read from the toolbar, not from the mail", () => {
  const fn = between(ENGINE_SRC, "function estimateTotalResults() {", "* Extract the \"X selected\"");

  test("the toolbar is searched before div[role=main]", () => {
    const toolbarAt = fn.indexOf("const toolbar = findToolbarRoot();");
    const mainAt = fn.indexOf("const main = qs(SELECTORS.main);");
    expect(toolbarAt).toBeGreaterThan(-1);
    expect(mainAt).toBeGreaterThan(-1);
    // main CONTAINS the conversation grid, so every subject on screen used
    // to be tested before the one element Gmail puts the counter in.
    expect(toolbarAt).toBeLessThan(mainAt);
  });

  test("main and the document remain as fallbacks, so 8.3's fix still stands", () => {
    expect(fn).toContain("scopes.push(main)");
    expect(fn).toContain("scopes.push(document)");
  });

  test("a bare 'of N' no longer counts as a counter", () => {
    const parse = between(ENGINE_SRC, "function parseCountFromText(text) {", "// 8.12: the largest number anywhere");
    // Anchored to the end of the text, and a position must precede it.
    expect(parse).toContain("/\\bof\\s+(?:about\\s+)?([\\d,.\\s]+)$/i");
    // The range is what real mail does not have. A bare position was not
    // enough to require: "Part 3 of 12" satisfies that and is a subject.
    expect(parse).toContain("COUNT_RANGE_RE.test(text.slice(0, ofMatch.index))");
  });
});

describe("parseCountFromText behaviour", () => {
  // Built the way the sibling suites build it, so the real function runs.
  const build = () => {
    const consts = between(ENGINE_SRC, "const COUNT_SEPARATORS", "// 8.12: the largest number anywhere");
    return new Function(`${consts}\nreturn parseCountFromText;`)();
  };

  test.each([
    ["1-50 of 142", 142],
    ["1-50 of 3,200", 3200],
    ["1-50 of about 3,200", 3200],
    ["Showing 1-50 of 12,438", 12438],
    ["about 900 results", 900]
  ])("still reads the real counter %s as %i", (text, expected) => {
    expect(build()(text)).toBe(expected);
  });

  test.each([
    ["Best of 2024"],
    ["Part 3 of 12"],
    ["50% off your order of 2 items"],
    ["The best of 500 deals, just for you"],
    ["1-50 of many"]
  ])("refuses %s, which is mail and not a counter", (text) => {
    expect(build()(text)).toBeNull();
  });
});

// =====================================================================
// 4. Locale gaps in the destructive and protective paths
// =====================================================================

describe("the engine can find the Delete button in Traditional Chinese", () => {
  const tokens = between(ENGINE_SRC, "const DELETE_LABEL_TOKENS = Object.freeze([", "]);");

  test("the Traditional form is there beside the Simplified one", () => {
    // Different code points, and findButtonByTokens scores on substring, so
    // the Simplified token could not match a zh-TW button and the English
    // /delete|trash|bin/i fallback cannot match CJK at all.
    expect(tokens).toContain("删除");
    expect(tokens).toContain("刪除");
  });

  test("its sibling tables already had theirs, which is why this was the odd one out", () => {
    expect(between(ENGINE_SRC, "const ARCHIVE_LABEL_TOKENS = Object.freeze([", "]);")).toContain("封存");
    expect(between(ENGINE_SRC, "const LABEL_BUTTON_TOKENS = Object.freeze([", "]);")).toContain("標籤");
  });
});

describe("Safe Mode's receipt shield covers every locale the engine drives", () => {
  const table = between(ENGINE_SRC, "const SAFE_MODE_SUBJECT_TERMS = Object.freeze({", "});");

  test.each(["en", "de", "es", "fr", "pt", "it", "nl", "ru", "ja", "ko", "zh", "sv", "da", "no", "pl", "tr", "ar"])(
    "%s has terms of its own",
    (locale) => {
      expect(table).toMatch(new RegExp(`\\b${locale}: \\[`));
    }
  );

  test("Traditional Chinese words are in the zh list, which zh-TW falls back to", () => {
    expect(table).toContain("收據");
    expect(table).toContain("發票");
    expect(table).toContain("訂單");
  });

  test("English is always included, so an uncovered locale is still shielded", () => {
    const fn = between(ENGINE_SRC, "function safeModeSubjectGuard() {", "// =========================");
    expect(fn).toContain("SAFE_MODE_SUBJECT_TERMS.en.concat(extra)");
  });

  // Behaviour, not a pin: the real function, driven across the language tags
  // Gmail actually stamps on <html lang>. A table with the right words in it
  // is worth nothing if the lookup cannot reach them.
  describe("resolved against the tags Gmail really stamps", () => {
    const build = (lang) => {
      const src = between(ENGINE_SRC, "const SAFE_MODE_SUBJECT_TERMS", "// Boot & basic utilities");
      // eslint-disable-next-line no-new-func
      return new Function("document", src + "\nreturn safeModeSubjectGuard();")({ documentElement: { lang } });
    };
    const englishOnly = build("en");

    test.each([
      ["sv"], ["sv-SE"], ["da"], ["da-DK"], ["pl"], ["pl-PL"], ["tr"], ["tr-TR"], ["ar"],
      // Every locale table in this file keys Norwegian as `no`, and BCP-47
      // prefers `nb`. Aliased, so all three forms reach the same words.
      ["no"], ["nb"], ["nb-NO"], ["nn"],
      // Traditional words live in the zh list, which every Chinese tag
      // reaches through the base code.
      ["zh"], ["zh-TW"], ["zh-HK"], ["zh-CN"]
    ])("%s gets terms of its own on top of English", (lang) => {
      expect(build(lang).length).toBeGreaterThan(englishOnly.length);
    });

    test("an uncovered language still gets the English shield, never nothing", () => {
      // Czech is deliberately uncovered, and the failure has to be
      // "protected by English words" rather than "not protected".
      expect(build("cs")).toBe(englishOnly);
      expect(englishOnly).toContain("-subject:(");
      expect(englishOnly).toContain("receipt");
    });
  });
});

// =====================================================================
// 5. The query that reaches Gmail is measured
// =====================================================================

describe("the guarded query is measured against the project's own ceiling", () => {
  test("the ceiling exists in the engine and matches shared's", () => {
    expect(ENGINE_SRC).toContain("const MAX_GUARDED_QUERY_CHARS = 512;");
    expect(SHARED_SRC).toContain("const MAX_QUERY_CHARS = 512;");
  });

  test("applyGlobalGuards measures its own output, once per run", () => {
    const fn = between(ENGINE_SRC, "function applyGlobalGuards(raw) {", "// MB / Size Helpers");
    expect(fn).toContain("const guarded = parts.join(\" \").trim();");
    expect(fn).toContain("guarded.length > MAX_GUARDED_QUERY_CHARS && !QUERY_LENGTH_WARNED");
    expect(fn).toContain("QUERY_LENGTH_WARNED = true;");
    expect(fn).toContain("return guarded;");
  });

  test("the warning names the two lists the user can trim", () => {
    const fn = between(ENGINE_SRC, "function applyGlobalGuards(raw) {", "// MB / Size Helpers");
    expect(fn).toContain("Global Whitelist");
    expect(fn).toContain("Protected Keywords");
  });

  test("the flag resets per run, like the selector-rot one beside it", () => {
    expect(ENGINE_SRC).toMatch(/SELECTOR_ROT_WARNED = false;\s*\n\s*QUERY_LENGTH_WARNED = false;/);
  });
});

// =====================================================================
// 6. Stats: a link that lands, and a list that survives a failed poll
// =====================================================================

describe("Find in Gmail lands on the label the run created", () => {
  const fn = between(STATS_SRC, "// 8.16: quoted, the way the engine", "const actions = GCC.createEl");

  test("the label is quoted, the way the engine's own restore query quotes it", () => {
    // Every recovery label has a space in it, and `label:` takes only the
    // token up to the first space, so the unquoted form searched for a
    // label the extension never creates.
    expect(fn).toContain(`encodeURIComponent('label:"' + entry.tagLabel + '"')`);
    expect(ENGINE_SRC).toContain('const labelTerm = `label:"${clean}"`');
  });

  test("an entry with no label gets no link instead of a guess", () => {
    expect(fn).toContain("const findLink = entry.tagLabel");
    expect(fn).not.toMatch(/\|\|\s*"GmailCleaner"/);
  });
});

// =====================================================================
// 7. Claims the code no longer backs
// =====================================================================

describe("the copy says what the product actually does", () => {
  test("five paid features came after the first version, not four", () => {
    // Pro shipped in 7.0 with bulk unsubscribe. The X-ray purge (7.2),
    // Smart Suggestions (7.8), Auto-Pilot (7.12), the Mailbox Report plan
    // (8.0) and Pro Settings (8.12) all came after it.
    const en = JSON.parse(read("_locales/en/messages.json"));
    expect(en.proFactFuture.message).toContain("all five that came after");
    expect(POPUP_HTML).toContain("all five that came after");
    expect(POPUP_HTML).not.toContain("all four that came after");
  });

  test("no locale still says four", () => {
    for (const locale of ["en", "es", "fr", "de", "pt_BR", "ru", "ja"]) {
      const msg = JSON.parse(read(`_locales/${locale}/messages.json`)).proFactFuture.message;
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(20);
    }
    const four = ["all four that came after", "las cuatro que vinieron luego", "les quatre qui ont suivi",
      "alle vier, die danach kamen", "os quatro que vieram em seguida", "все четыре, что вышли следом",
      "その後に増えた4つを"];
    for (const locale of ["en", "es", "fr", "de", "pt_BR", "ru", "ja"]) {
      const raw = read(`_locales/${locale}/messages.json`);
      for (const phrase of four) expect(raw).not.toContain(phrase);
    }
  });

  test("the Options blurb stops selling the Storage X-ray list, free since 8.13", () => {
    const section = OPTIONS_HTML.slice(OPTIONS_HTML.indexOf('id="pro"'), OPTIONS_HTML.indexOf('id="pro"') + 3000)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\s+/g, " ");
    expect(section).toContain("purging from the Storage X-ray");
    expect(section).toContain("Pro Settings");
    expect(section).not.toContain("the full Storage X-ray");
  });
});

describe("the auxiliary run path refuses in the user's own language", () => {
  const fn = between(POPUP_SRC, "const injectEngineRun = async (config, setStatusFn) => {", "const injectSubscriptionRun");

  test("all three refusals go through the catalogue", () => {
    expect(fn).toContain('t("allowAccessFirst"');
    expect(fn).toContain('t("accessNeededToast"');
    expect(fn).toContain('t("runInProgressToast"');
  });

  test("no raw English literal is left in a toast or a status on that path", () => {
    expect(fn).not.toContain('setStatusFn("Allow Gmail access');
    expect(fn).not.toContain('showToast("gmail access needed"');
    expect(fn).not.toContain('showToast("another run is already in progress"');
  });

  test("the new key is in all seven catalogues", () => {
    for (const locale of ["en", "es", "fr", "de", "pt_BR", "ru", "ja"]) {
      const cat = JSON.parse(read(`_locales/${locale}/messages.json`));
      for (const key of ["runInProgressToast", "apStorageUnreadable", "resultPartialOne",
        "resultPartialMany", "notifStoppedShortOne", "notifStoppedShortMany", "apLastSweepIncomplete"]) {
        expect(cat[key]).toBeDefined();
        expect(typeof cat[key].message).toBe("string");
        expect(cat[key].message.length).toBeGreaterThan(3);
      }
    }
  });
});

// =====================================================================
// 8. A refused run leaves nothing claimed on screen
// =====================================================================

describe("a run refused for a duplicate puts back what it had claimed", () => {
  test.each([
    ["runCleanup", "const runCleanup = async () => {", "const SUBS_STATUS_LABELS"],
    ["startReportRun", "const startReportRun = async (", "await bumpRunCount();"],
    ["handleXrayPurge", "const handleXrayPurge = async () => {", "await bumpRunCount();"],
    ["startSmartApplyRun", "const startSmartApplyRun = async (", "await bumpRunCount();"]
  ])("%s resets startedRunHere and the tab handle on refusal", (_name, start, end) => {
    const fn = between(POPUP_SRC, start, end);
    expect(fn.length).toBeGreaterThan(200);
    const refusal = between(fn, "if (await isEngineAttached(gmailTab.id)) {", "}");
    expect(refusal).toContain("state.startedRunHere = false;");
    expect(refusal).toContain("state.currentGmailTabId = null;");
  });

  test("runCleanup also drops the quick actions and the live status it had set", () => {
    const fn = between(POPUP_SRC, "const runCleanup = async () => {", "const SUBS_STATUS_LABELS");
    const refusal = between(fn, "if (await isEngineAttached(gmailTab.id)) {", "}");
    // Open progress reads startedRunHere and focuses a leftover dashboard
    // WITHOUT reloading it; Cancel aims a stop at somebody else's run.
    expect(refusal).toContain("hideQuickActions();");
    expect(refusal).toContain('setStatus("", STATUS_TYPES.INFO);');
  });
});

// =====================================================================
// 9. Housekeeping the tooling depends on
// =====================================================================

describe("every shipped script is plain text", () => {
  test("no source file carries a control byte", () => {
    // options.js held a literal NUL (a join separator written as the raw
    // byte). Legal JS, but grep reports the file as binary and prints NO
    // lines, which silently blinded every grep-based audit of a 2,000-line
    // page script for as long as it was there.
    const files = ["contentScript.js", "background.js", "popup.js", "shared.js", "options.js",
      "progress.js", "stats.js", "diagnostics.js", "changelog.js", "changelog-data.js",
      "browser-polyfill.js", "build.js"];
    for (const f of files) {
      const buf = fs.readFileSync(path.join(__dirname, "..", f));
      const bad = [];
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c === 0 || (c < 9) || (c > 13 && c < 32)) bad.push(`${f}@${i}:0x${c.toString(16)}`);
      }
      expect(bad).toEqual([]);
    }
  });

  test("the separator still exists, written as an escape", () => {
    expect(OPTIONS_SRC).toContain('.join("\\u0000")');
  });
});
