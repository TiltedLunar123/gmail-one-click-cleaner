/**
 * @jest-environment jsdom
 *
 * The 8.12 sweep, plus the Pro Settings card.
 *
 * Every assertion here was run against the 8.11.0 source before the fix
 * landed. The ones that are deliberate invariant pins (they pass either
 * way, and exist so the invariant cannot be removed later) say so on the
 * assertion itself. Everything else FAILED on 8.11.0.
 *
 * Two themes. The first is the one this project keeps finding: a
 * protection that is one spelling deep, a number measured through a
 * different filter than the action applies, a control that silently does
 * less than it says. The second is new: settings that only a licence
 * unlocks, which had to be built so that losing the licence can never
 * leave one of them still in force.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const POPUP_SRC = read("popup.js");
const SHARED_SRC = read("shared.js");
const BG_SRC = read("background.js");
const ENGINE_SRC = read("contentScript.js");
const OPTIONS_SRC = read("options.js");
const OPTIONS_HTML = read("options.html");
const DIAG_SRC = read("diagnostics.js");
const DIAG_HTML = read("diagnostics.html");
const PROGRESS_SRC = read("progress.js");
const PROGRESS_HTML = read("progress.html");

function loadShared() {
  const iife = SHARED_SRC.match(/const GCC = ([\s\S]*);[\s]*$/);
  // eslint-disable-next-line no-new-func
  return new Function("document", "window", "chrome", `return ${iife[1]}`)(
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
}

function loadEngine(config = {}) {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = config;
  window.alert = () => {};
  document.body.innerHTML = "";
  // eslint-disable-next-line no-new-func
  new Function(ENGINE_SRC)();
  return window.GCC_INTERNALS;
}

/** Source between two markers, so a pin cannot match a lookalike elsewhere. */
const between = (src, start, end) => {
  const a = src.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(end, a + start.length);
  return src.slice(a, b > a ? b : a + 4000);
};

// =====================================================================
// Trash and Spam were reachable by three spellings the refusal missed
// =====================================================================

describe("the permanent-delete views are refused by every spelling", () => {
  // 8.8 added in:trash / in:spam because those are the two views where
  // Gmail's delete control means Delete forever, and Restore looks for
  // exactly the `in:trash label:"..."` mail such a rule destroys. It
  // added one spelling. Gmail accepts label:trash and label:spam as
  // synonyms, and in:anywhere as a superset of both.
  const engine = loadEngine();

  test.each([
    "label:trash older_than:1y",
    "label:spam older_than:1y",
    "in:anywhere older_than:1y"
  ])("the engine refuses %s", (query) => {
    expect(engine.queryHasDangerousToken(query)).toBe(true);
  });

  test("the shared validator refuses them too", () => {
    const GCC = loadShared();
    for (const q of ["label:trash older_than:1y", "label:spam older_than:1y", "in:anywhere older_than:1y"]) {
      expect(GCC.validateGmailQuery(q).valid).toBe(false);
    }
  });

  // Invariant pin: negation has always been legal and must stay legal,
  // or the report's own headline query stops validating.
  test("negating them is still allowed", () => {
    expect(engine.queryHasDangerousToken("older_than:1y -in:anywhere")).toBe(false);
    expect(engine.queryHasDangerousToken("older_than:1y -label:trash")).toBe(false);
  });

  // The twins have drifted apart twice before (7.15, 8.10), each time
  // because one copy was fixed and the other was not.
  test("the engine's list and shared.js's list are identical", () => {
    // Comment lines are stripped first: both lists carry long prose
    // explaining why each entry is there, and quoted operators inside
    // that prose would otherwise read as entries.
    const grab = (src) => {
      const body = between(src, "DANGEROUS_QUERY_TOKENS = [", "\n  ];");
      return body
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n")
        .match(/"[^"]+"/g)
        .map((s) => s.slice(1, -1))
        .sort();
    };
    const engineList = grab(ENGINE_SRC);
    expect(engineList).toContain("in:trash");
    expect(engineList).toContain("label:trash");
    expect(grab(SHARED_SRC)).toEqual(engineList);
  });
});

describe("the control that deletes refuses a Delete forever button", () => {
  // Every RESTORE finder has vetoed these since 7.6, before scoring,
  // precisely so a well-scoring label can never win. The finder that
  // actually deletes had no such check, and its own primary pattern
  // (/delete|trash|bin/) matches "Delete forever" on its merits.
  test("findDeleteButton skips a Delete forever control", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" id="forever" aria-label="Delete forever"></div>
      </div>`;
    expect(I.findDeleteButton()).toBeNull();
  });

  test("it still finds an ordinary Delete", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" id="ok" aria-label="Delete"></div>
      </div>`;
    expect(I.findDeleteButton()?.id).toBe("ok");
  });

  test("a Delete forever alongside a Delete never wins", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" id="forever" aria-label="Delete forever" data-tooltip="Delete forever"></div>
        <div role="button" id="ok" aria-label="Delete"></div>
      </div>`;
    expect(I.findDeleteButton()?.id).toBe("ok");
  });
});

// =====================================================================
// Guardrails were sized at one page whenever the total was unreadable
// =====================================================================

describe("a bulk-all selection is sized by what the click can touch", () => {
  const ACT = between(
    ENGINE_SRC,
    "async function actOnCurrentPageIfAny(tagLabel) {",
    "async function processQuery("
  );

  test("the offer's own text is a second source for the match total", () => {
    // Gmail writes "1-50 of many" on the largest result sets, which
    // parseCountFromText correctly refuses, and Math.max(null ?? 0, 50)
    // is 50 -- so the biggest sweeps were the ones measured at one page.
    expect(ENGINE_SRC).toContain("function largestNumberIn(text)");
    expect(ENGINE_SRC).toContain("const offerTotal = largestNumberIn(linkText);");
    expect(ACT).toContain("selectAllResult.offerTotal");
  });

  test("largestNumberIn reads the offer in any language", () => {
    const I = loadEngine();
    expect(I.largestNumberIn("Select all 9,000 conversations that match this search")).toBe(9000);
    expect(I.largestNumberIn("Alle 12.400 Konversationen auswählen")).toBe(12400);
    expect(I.largestNumberIn("Sélectionner les 3 200 conversations")).toBe(3200);
    expect(I.largestNumberIn("no digits here")).toBeNull();
  });

  test("both sources silent means over-cap, not one page", () => {
    expect(ACT).toContain("const matchTotalUnknown = bulkSelected && matchTotal === null;");
    expect(ACT).toMatch(/projectedTotal\s*>\s*GUARDRAILS\.RUN_SOFT_CAP\s*\|\|\s*matchTotalUnknown/);
  });

  test("the dialog for an unknown total does not quote a number", () => {
    expect(ACT).toContain('kind: matchTotalUnknown ? "unknownBulk" : "softCap"');
    expect(PROGRESS_HTML).toContain('id="guardCountRow"');
    expect(PROGRESS_SRC).toContain("guardCountRow: document.getElementById(\"guardCountRow\")");
    const modal = between(PROGRESS_SRC, "const openGuardModal = (kind, count, actionWord) => {", "const closeGuardModal");
    expect(modal).toContain('const countKnown = kind !== "unknownBulk";');
    expect(modal).toContain("ui.guardCountRow.style.display = countKnown");
  });
});

describe("Gmail's page-only banner is not proof the whole set is selected", () => {
  // "All 50 conversations on this page are selected." contains "all" and
  // "selected", so the sentence that exists to say THIS IS ONE PAGE was
  // read as proof of the opposite. When the select-all click failed to
  // take, the caller then booked the full match total against a 50-row
  // action, into the receipt, Stats, the undo log and the soft cap.
  test("the offer still being on screen disproves it", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <span>All 50 conversations on this page are selected.</span>
        <span role="link">Select all 9,000 conversations that match this search</span>
      </div>`;
    expect(I.findAllConversationsSelectedIndicator()).toBe(false);
  });

  test("with the offer gone, a real all-selected banner still counts", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <span>All 9,000 conversations in this search are selected.</span>
      </div>`;
    expect(I.findAllConversationsSelectedIndicator()).toBe(true);
  });
});

describe("an unattended decline is reported as a decline", () => {
  // Both auto-declines returned the same shape as "this rule matched
  // nothing", so a schedule that skipped every rule for being too large
  // signed off with "nothing matched your rules" and the user had no way
  // to learn their cleanup had stopped doing anything.
  test("the decline is flagged on the way out", () => {
    expect(ENGINE_SRC).toContain('reason: "scheduled-soft-cap-declined", declined: true');
    expect(ENGINE_SRC).toContain('reason: "scheduled-huge-run-declined", declined: true');
  });

  test("processQuery counts it and says so", () => {
    expect(ENGINE_SRC).toContain("stats.declinedRules = (stats.declinedRules || 0) + 1;");
  });

  test("the summary, which is all an unattended run has, tells the truth", () => {
    const fn = between(ENGINE_SRC, "function buildHumanSummary(", "// Subscriptions: scan + bulk unsubscribe");
    expect(fn).toContain("declinedRules");
    expect(fn).toContain("too large to run unattended");
    // and it must be decided BEFORE the "nothing matched" sentence
    expect(fn.indexOf("too large to run unattended"))
      .toBeLessThan(fn.indexOf("nothing matched your rules"));
  });
});

describe("Safe Mode protects receipts in the language the mailbox is in", () => {
  // The popup promises Safe Mode in seven languages and the engine has
  // driven Gmail's UI in seventeen since 7.5, but the subject shield was
  // one frozen English string, so on a German mailbox Safe Mode was on,
  // said it was protecting receipts, and protected nothing.
  const build = (lang) => {
    const I = loadEngine();
    document.documentElement.lang = lang;
    return I.safeModeSubjectGuard();
  };

  test("English always ships, because commercial mail often is", () => {
    const de = build("de");
    expect(de).toContain("receipt");
    expect(de).toContain("invoice");
  });

  test("the detected language is added", () => {
    expect(build("de")).toContain("Rechnung");
    expect(build("fr")).toContain("facture");
    expect(build("ja")).toContain("領収書");
    expect(build("pt-BR")).toContain("recibo");
  });

  test("an untabled language degrades to English rather than breaking", () => {
    const th = build("th");
    expect(th).toContain("receipt");
    expect(th.startsWith("-subject:(")).toBe(true);
  });

  // This string is prepended to EVERY rule, and rules have a 512-char
  // ceiling, so the table cannot grow without bound.
  test("no language pushes the guard past a third of the query budget", () => {
    const GCC = loadShared();
    for (const lang of ["en", "de", "es", "fr", "pt", "it", "nl", "ru", "ja", "ko", "zh"]) {
      expect(build(lang).length).toBeLessThan(Math.floor(GCC.MAX_QUERY_CHARS / 2));
    }
  });

  test("the dedupe check compares against the string actually appended", () => {
    // A dynamic guard tested against the old frozen constant would be
    // re-appended on every pass for every non-English mailbox.
    const fn = between(ENGINE_SRC, "if (CONFIG.safeMode) {", "if (CONFIG.guardSkipStarred");
    expect(fn).toContain("const safeGuard = safeModeSubjectGuard();");
    expect(fn).toContain("if (!parts[0].includes(safeGuard)) parts.push(safeGuard);");
  });
});

// =====================================================================
// Settings pages that reported success over a refusal
// =====================================================================

describe("a protection list that is too long is refused, not truncated", () => {
  // The caps were enforced by a silent .slice() on the way to storage
  // while the textarea, the line counter and the success toast all still
  // showed the full list. 8.10 fixed exactly this in the worker's
  // addToWhitelist and said why: a safety control that silently does
  // nothing is worse than one that says no.
  test("the whitelist cap blocks the save", () => {
    const fn = between(OPTIONS_SRC, "const validateData = (data) => {", "\n  /**");
    expect(fn).toContain("CONFIG.MAX_WHITELIST_ENTRIES");
    expect(fn).toContain("Nothing was changed.");
    expect(fn).toContain("const overCap = (message) => {");
  });

  test("it counts the raw lines, because the normaliser ends in the slice", () => {
    const fn = between(OPTIONS_SRC, "const validateData = (data) => {", "\n  /**");
    expect(fn).toContain('uniqTrimmed(readLines("whitelist"))');
    expect(fn).not.toContain("normalizeWhitelist(readLines");
  });

  test("the per-intensity rule cap blocks too", () => {
    const fn = between(OPTIONS_SRC, "const validateData = (data) => {", "\n  /**");
    expect(fn).toContain("CONFIG.MAX_RULES_PER_CATEGORY");
  });
});

describe("saveData reports whether it saved", () => {
  test("every exit returns a boolean", () => {
    const fn = between(OPTIONS_SRC, "const saveData = async (evt = null, opts = {}) => {", "\n  //");
    expect(fn).toContain("if (state.saving) return false;");
    expect(fn).toContain("return false;");
    expect(fn).toContain("return true;");
  });

  test("Restore defaults stops claiming success over a refusal", () => {
    const fn = between(OPTIONS_SRC, "const restoreDefaults = async () => {", "// Import / Export");
    expect(fn).toContain("const saved = await saveData(null, { silent: true });");
    expect(fn).toContain("if (!saved) {");
    // and the success toast must come after the check
    expect(fn.indexOf("if (!saved) {"))
      .toBeLessThan(fn.indexOf('GCC.showToast("Settings restored to defaults"'));
  });
});

describe("a schedule the worker refused is not reported as saved", () => {
  // saveSchedule rethrows on purpose, and the router answers
  // { ok: false, error }. All three call sites threw it away.
  test("there is one shared reading of the failure", () => {
    expect(OPTIONS_SRC).toContain("const scheduleError = (resp, fallback) => {");
  });

  test("all three call sites check it", () => {
    const hits = OPTIONS_SRC.match(/scheduleError\(resp,/g) || [];
    expect(hits.length).toBe(3);
  });

  test("a refused toggle is put back", () => {
    const fn = between(OPTIONS_SRC, 'schedule.enabled = !schedule.enabled;', "const deleteBtn");
    expect(fn).toContain("schedule.enabled = !schedule.enabled;");
    expect(fn).toContain("renderSchedules();");
  });
});

// =====================================================================
// The popup
// =====================================================================

describe("Enter runs the cleaner only from neutral focus", () => {
  // The old guard excluded SELECT / INPUT / TEXTAREA and role=tab and
  // nothing else, so every other focusable thing in the popup had its
  // Enter key replaced with a live cleanup -- and preventDefault meant
  // the button the user was actually pressing never fired. Focus the Pro
  // panel's Get Pro (openProPanel focuses it for you), press Enter to
  // buy, and a real run started instead.
  const fn = between(POPUP_SRC, 'if (e.key === "Enter" && !e.repeat) {', "// Ctrl/Cmd + D toggles dry run");

  test("anything with its own Enter behaviour keeps it", () => {
    expect(fn).toContain("const ownsEnter = active?.closest?.(");
    for (const sel of ['a[href]', 'button', '[role="button"]', '[role="link"]', 'summary']) {
      expect(fn).toContain(sel);
    }
  });

  test("an open modal blocks it", () => {
    expect(fn).toContain("const modalOpen = Boolean(");
    expect(fn).toContain("elements.proPanel");
    expect(fn).toContain("elements.kbdHelp");
    expect(fn).toContain("elements.onboardingBackdrop");
  });

  test("the run only fires when neither applies", () => {
    expect(fn).toContain("if (!ownsEnter && !modalOpen && !state.isRunning) {");
  });
});

describe("a buyer never sees the upsell chrome", () => {
  // Verifying a licence is an ECDSA check over two storage reads and
  // init does not await it, so for the first 100-300ms of EVERY open a
  // paying customer saw padlocks on two tabs and a gold Pro badge.
  test("a cached hint paints the paid state before the real check", () => {
    expect(POPUP_SRC).toContain('PRO_HINT: "proActiveHint"');
    expect(POPUP_SRC).toContain("const applyProChrome = (active) => {");
    expect(POPUP_SRC).toContain("const applyLicenseHint = async () => {");
    expect(POPUP_SRC).toContain("await applyLicenseHint();");
  });

  test("the hint is written once the real answer is known", () => {
    const fn = between(POPUP_SRC, "const refreshLicenseUi = async () => {", "// 7.12: locked Pro controls");
    expect(fn).toContain("GCC.storageSet(\"local\", { [STORAGE_KEYS.PRO_HINT]: active })");
    expect(fn).toContain("applyProChrome(active);");
  });

  // The hint must never be load-bearing: it decides paint, not access.
  test("the hint is not used as a gate", () => {
    const gateish = POPUP_SRC.match(/PRO_HINT[^\n]*\n/g) || [];
    for (const line of gateish) {
      expect(line).not.toMatch(/licenseActive\s*=/);
    }
  });
});

describe("the X-ray purge remembers the age its ticks were chosen under", () => {
  test("the age is persisted and restored", () => {
    expect(POPUP_SRC).toContain('XRAY_AGE: "xrayPurgeAge"');
    const loader = between(POPUP_SRC, "const loadXraySelection = async () => {", "const updateXrayCount");
    expect(loader).toContain("STORAGE_KEYS.XRAY_AGE");
    expect(loader).toContain("setSelectIfHasValue(elements.xrayAge, savedAge)");
  });
});

// =====================================================================
// The worker
// =====================================================================

describe("Auto-Pilot acts on the age range it measured", () => {
  // 8.11 taught the scan to measure through the popup's own switches,
  // including the minimum age, while the apply kept a hardcoded
  // minAge: null. The comment beside it claimed the apply is "stricter
  // than anything measured here", which was true of every guard except
  // this one: with the floor set to a year, the sweep was counted at a
  // year and run at six months.
  // 8.13 moved this pin: the Pro age floor now joins the user's floor
  // through swStrictestAgeToken, so the literal `minAge: guards.minAge,`
  // is gone while the fact it was pinning is not. The fact is that the
  // apply derives its floor from what the user set, and never sends
  // null.
  test("the apply passes the user's floor through", () => {
    const fn = between(BG_SRC, "async function startAutoPilotApply() {", "async function resolveAutoPilotDone");
    expect(fn).toContain("const guards = await readUserScanGuards();");
    expect(fn).toMatch(/minAge: [^,\n]*guards\.minAge/);
    expect(fn).not.toContain("minAge: null,");
  });

  // Invariant pin: the four skip switches stay hardcoded ON, which is
  // deliberately stricter than a manual run.
  test("the four guards stay forced on", () => {
    const fn = between(BG_SRC, "async function startAutoPilotApply() {", "async function resolveAutoPilotDone");
    for (const g of ["guardSkipStarred", "guardSkipImportant", "guardSkipUnread", "guardSkipUserLabels"]) {
      expect(fn).toContain(`${g}: true`);
    }
  });
});

describe("a partial X-ray purge does not mark every sender done", () => {
  // The engine reports ONE aggregate count for a run, and a purge of N
  // senders is a multi-rule run, so a purge that cleared sender 1 and
  // then died stamped all N "Purged". Its 8.0 twin has had this guard
  // all along.
  test("more than one sender in the marker means nothing is stamped", () => {
    const fn = between(BG_SRC, "async function resolvePendingStoragePurge(summary) {", "// Mailbox Report store");
    expect(fn).toContain("pending.senders.length !== 1");
  });
});

describe("turning Auto-Pilot off stops the sweep in flight", () => {
  test("the engine is cancelled and the claim released", () => {
    const fn = between(BG_SRC, "async function setAutoPilotEnabled(enabled) {", "async function confirmAutoPilot");
    expect(fn).toContain('{ type: "gmailCleanerCancel" }');
    expect(fn).toContain("releaseRunClaim(pending.runId)");
  });
});

describe("the last unlocked writer of autoPilotState takes the lock", () => {
  // setAutoPilotState is an unlocked get-merge-set, so closing the Gmail
  // tab as a sweep finished could merge into a pre-resolve snapshot and
  // put the stale lastRun back.
  test("tabs.onRemoved reads and writes inside the queue", () => {
    const fn = between(BG_SRC, "chrome.tabs.onRemoved.addListener(async (tabId) => {", "// Alarm Handler");
    const lockAt = fn.indexOf("await withStorageLock(async () => {");
    const readAt = fn.indexOf("const apState = await getAutoPilotState();");
    const writeAt = fn.indexOf("await setAutoPilotState({ pending: null });");
    expect(lockAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(lockAt);
    expect(writeAt).toBeGreaterThan(readAt);
  });
});

// =====================================================================
// Diagnostics
// =====================================================================

describe("diagnostics stops calling a count band a storage figure", () => {
  // sizeBucket is derived purely from the conversation count, so
  // printing it in a field labelled "Freed" reported a count band as
  // megabytes after every dry run. And archiving frees nothing, which
  // stats.js and progress.js both learned in 8.9/8.10.
  test("the last-run card never prints sizeBucket as Freed", () => {
    const fn = between(DIAG_SRC, "let freedMbText", "if (elements.lastRunSummary)");
    expect(fn).not.toContain("freedMbText = sizeBucket");
    expect(fn).toContain('stats.mode === "dry"');
    expect(fn).toContain("archived");
  });

  test("the history table zeroes archive runs like its two siblings", () => {
    const fn = between(DIAG_SRC, "let mbText =", "sizeCell.textContent = mbText;");
    expect(fn).toContain('run.action === "archive"');
    expect(fn).not.toContain("run.sizeBucket");
  });
});

describe("the Gmail layout warning can be dismissed", () => {
  // Written once on a layout error, read in one place, and cleared
  // nowhere: one bad run left a permanent red card on the page a worried
  // user opens to check whether the extension is healthy.
  test("there is a control and it clears the key", () => {
    expect(DIAG_HTML).toContain('id="layoutChangeDismiss"');
    expect(DIAG_SRC).toContain("layoutChangeDismiss: GCC.$(SELECTORS.layoutChangeDismiss)");
    expect(DIAG_SRC).toContain("const wireLayoutChangeDismiss = () => {");
    expect(DIAG_SRC).toContain("wireLayoutChangeDismiss();");
    const fn = between(DIAG_SRC, "const wireLayoutChangeDismiss = () => {", "// Run History");
    expect(fn).toContain('GCC.storageSet("local", { layoutChangeNotice: null })');
  });
});

describe("the dead tab-strategy probe is gone", () => {
  // Eight guessed storage keys, no writer for any of them anywhere in
  // the shipped tree, so the card always reported the same thing after
  // eight pointless sync reads.
  test.each([
    "useDedicatedCleaningTab",
    "runInDedicatedTab",
    "dedicatedTabEnabled",
    "preferDedicatedTab"
  ])("%s is no longer probed", (key) => {
    expect(DIAG_SRC).not.toContain(key);
  });
});

// =====================================================================
// Pro Settings (new in 8.12)
// =====================================================================

describe("Pro settings default to exactly what 8.11 did", () => {
  const GCC = loadShared();

  // 8.13 relaxed this from toEqual to toMatchObject so later releases
  // can add knobs. What it pins is unchanged and is the point of the
  // whole feature: these three still default to the 8.11 behaviour. Any
  // knob added later has to satisfy the same rule, which the release
  // that adds it is expected to pin for itself.
  test("the defaults are the old hardcoded values", () => {
    expect(GCC.proSettings.DEFAULTS).toMatchObject({
      labelPrefix: "GmailCleaner",
      autoPilotIntervalDays: 7,
      smartScanDepth: "standard"
    });
  });

  // The whole safety property of this feature: a value chosen while Pro
  // was active must stop applying the moment the licence is gone, or a
  // removed key leaves a 30-day unattended sweep nobody can see.
  test("without a licence, stored values are ignored entirely", () => {
    const stored = { labelPrefix: "Mine", autoPilotIntervalDays: 30, smartScanDepth: "deep" };
    expect(GCC.proSettings.effective(stored, false)).toEqual(GCC.proSettings.DEFAULTS);
  });

  test("with a licence, stored values apply", () => {
    const stored = { labelPrefix: "Mine", autoPilotIntervalDays: 30, smartScanDepth: "deep" };
    expect(GCC.proSettings.effective(stored, true)).toMatchObject(stored);
  });

  test("junk falls back per field rather than wholesale", () => {
    const out = GCC.proSettings.effective(
      { labelPrefix: "Keep", autoPilotIntervalDays: 999, smartScanDepth: "nonsense" },
      true
    );
    expect(out.labelPrefix).toBe("Keep");
    expect(out.autoPilotIntervalDays).toBe(7);
    expect(out.smartScanDepth).toBe("standard");
  });
});

describe("the recovery label cannot break Restore", () => {
  const GCC = loadShared();

  // Restore is built on `label:"<name>"`, so a quote in the prefix would
  // produce runs that cannot be undone; a slash makes Gmail nest the
  // label instead of creating it.
  test.each(['My"Label', "My\\Label", "My/Label"])("%s is refused", (bad) => {
    expect(GCC.proSettings.validateLabelPrefix(bad).ok).toBe(false);
  });

  test("spaces are fine, because the label is quoted in the query", () => {
    const r = GCC.proSettings.validateLabelPrefix("  My   Cleanup  ");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("My Cleanup");
  });

  test("blank means the default, not an empty label", () => {
    const r = GCC.proSettings.validateLabelPrefix("   ");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("GmailCleaner");
    expect(r.reset).toBe(true);
  });

  test("over-long is refused", () => {
    expect(GCC.proSettings.validateLabelPrefix("x".repeat(33)).ok).toBe(false);
  });
});

describe("the Smart scan budgets move together", () => {
  const GCC = loadShared();

  // Measuring twenty senders and then vetting fifteen would drop five
  // finalists for no reason the user could see.
  test("deep raises both", () => {
    const std = GCC.proSettings.smartScanBudget("standard");
    const deep = GCC.proSettings.smartScanBudget("deep");
    expect(std).toEqual({ smartSignalSenders: 10, smartVetoSenders: 15 });
    expect(deep.smartSignalSenders).toBeGreaterThan(std.smartSignalSenders);
    expect(deep.smartVetoSenders).toBeGreaterThanOrEqual(deep.smartSignalSenders);
  });

  test("an unknown depth is the standard budget", () => {
    expect(GCC.proSettings.smartScanBudget("nonsense"))
      .toEqual(GCC.proSettings.smartScanBudget("standard"));
  });

  test("the engine clamps whatever it is sent", () => {
    const I = loadEngine({ smartSignalSenders: 9999, smartVetoSenders: -3 });
    const cfg = I.sanitizeConfig({ smartSignalSenders: 9999, smartVetoSenders: -3 });
    expect(cfg.smartSignalSenders).toBeLessThanOrEqual(20);
    expect(cfg.smartVetoSenders).toBeGreaterThanOrEqual(1);
  });

  test("a config with no budget keeps the historical default", () => {
    const I = loadEngine();
    const cfg = I.sanitizeConfig({});
    expect(cfg.smartSignalSenders).toBe(10);
    expect(cfg.smartVetoSenders).toBe(15);
  });

  // Both scans write the ONE smartScan store the popup's cards read, so
  // a standard-depth sweep landing on a deep-depth user would quietly
  // shorten their suggestion list every week.
  test("both scan callers send the pair", () => {
    expect(POPUP_SRC).toContain("GCC.proSettings.smartScanBudget((await getProSettings()).smartScanDepth)");
    expect(BG_SRC).toContain("...smartScanBudget(proSettings.smartScanDepth),");
  });
});

describe("the worker's copy of the Pro settings matches shared.js", () => {
  // hasProLicense drifted from its shared original once already (8.7).
  const GCC = loadShared();

  test("the defaults agree", () => {
    const fn = between(BG_SRC, "const PRO_SETTINGS_DEFAULTS = Object.freeze({", "});");
    expect(fn).toContain(`labelPrefix: "${GCC.proSettings.DEFAULTS.labelPrefix}"`);
    expect(fn).toContain(`autoPilotIntervalDays: ${GCC.proSettings.DEFAULTS.autoPilotIntervalDays}`);
    expect(fn).toContain(`smartScanDepth: "${GCC.proSettings.DEFAULTS.smartScanDepth}"`);
  });

  test("the allowed intervals agree", () => {
    const fn = between(BG_SRC, "const PRO_SETTINGS_INTERVAL_DAYS = Object.freeze([", "]);");
    for (const d of GCC.proSettings.LIMITS.INTERVAL_DAYS) expect(fn).toContain(String(d));
  });

  test("the worker verifies the licence before applying any of them", () => {
    const fn = between(BG_SRC, "async function readProSettings(knownPro) {", "function smartScanBudget(depth)");
    expect(fn).toContain("await hasProLicense()");
    expect(fn).toContain("if (!isPro) return out;");
  });
});

describe("the Pro settings reach every run that tags mail", () => {
  test("the popup sends the label on every path", () => {
    const fn = between(POPUP_SRC, "const buildConfig = async () => {", "// 8.5: the guard half of buildConfig");
    expect(fn).toContain("tagLabelPrefix: proSettings.labelPrefix,");
  });

  test("scheduled cleanups and Auto-Pilot use it too", () => {
    expect(BG_SRC).toContain("tagLabelPrefix: (await readProSettings()).labelPrefix,");
    expect(BG_SRC).toContain("tagLabelPrefix: proSettings.labelPrefix,");
    expect(BG_SRC).not.toContain('tagLabelPrefix: "GmailCleaner"');
  });

  test("the Auto-Pilot alarm is armed from the setting, and re-armed on save", () => {
    const fn = between(BG_SRC, "async function restoreAutoPilotAlarm() {", "async function runAutoPilot()");
    expect(fn).toContain("const pro = await readProSettings();");
    expect(fn).toContain("pro.autoPilotIntervalDays * 24 * 60");
    expect(BG_SRC).toContain('case "gmailCleanerProSettingsChanged":');
    expect(OPTIONS_SRC).toContain('{ type: "gmailCleanerProSettingsChanged" }');
  });
});

describe("the Pro settings card tells the truth about being locked", () => {
  test("the card exists with all three controls", () => {
    for (const id of ["proSettingsCard", "proLabelPrefix", "proAutoPilotInterval", "proSmartScanDepth"]) {
      expect(OPTIONS_HTML).toContain(`id="${id}"`);
    }
  });

  // 8.16 moved both of these pins. Intent unchanged in both cases; the
  // addresses moved because the card grew a third state ("could not read
  // your settings") between locked and editable.
  test("a free user cannot edit them", () => {
    const fn = between(OPTIONS_SRC, "const wireProSettingsSection = () => {", "wireProSettingsSection();");
    expect(fn).toContain("const setLocked = (locked) => {");
    // The per-element disable moved into setProFieldsDisabled, which
    // setLocked now delegates to, so that the unreadable case can disable
    // the same controls without raising the "Pro required" panel at
    // somebody who has paid. Pinned as the pair.
    expect(fn).toContain("const setProFieldsDisabled = (disabled) => {");
    expect(fn).toContain("if (el) el.disabled = disabled;");
    expect(fn).toContain("setProFieldsDisabled(locked);");
    expect(fn).toContain("if (!isPro) return;");
  });

  test("the form shows what is in force, not what was stored", () => {
    const fn = between(OPTIONS_SRC, "const wireProSettingsSection = () => {", "wireProSettingsSection();");
    // 8.16: read -> readOrNull. Same question ("what is actually in
    // force?"), one more answer: a sync read that FAILED must not be
    // painted as the six defaults, because the next edit writes all six
    // back. Asserted with the refusal beside it so the rename cannot be
    // undone by dropping the null check.
    expect(fn).toContain("await GCC.proSettings.readOrNull(isPro)");
    expect(fn).toContain("if (settings === null) {");
    expect(fn).toContain("applyToForm(settings);");
    expect(fn).not.toContain("applyToForm(await GCC.proSettings.read(isPro));");
  });

  test("Pro Settings is on the list a buyer is shown", () => {
    const GCC = loadShared();
    expect(GCC.license.FEATURES.join(" ").toLowerCase()).toContain("pro settings");
  });
});

// =====================================================================
// Found by the completeness pass, after the fixes above were written.
// Five of these are defects in this release's own new code.
// =====================================================================

describe("the Auto-Pilot stop is aimed before it is fired", () => {
  // The new "turning Auto-Pilot off stops the sweep" code sent a cancel
  // at a remembered tab id with no freshness and no identity check.
  // `pending` has no expiry of its own and survives an engine that died
  // silently, so a stale row pointing at a tab the user had since
  // started a manual cleanup in would cancel THAT run and release its
  // claim. 8.11 added autoPilotPendingIsFresh with a comment asking that
  // no new reader be added without it; this was the new reader.
  const fn = between(BG_SRC, "async function setAutoPilotEnabled(enabled) {", "async function confirmAutoPilot");

  test("it checks the pending row is still worth believing", () => {
    expect(fn).toContain("autoPilotPendingIsFresh(pending)");
  });

  test("it checks the engine in that tab is the one it started", () => {
    expect(fn).toContain("const probe = await probeEngine(tabId);");
    expect(fn).toContain("probe.runId === pending.runId");
  });

  test("the cancel and the release are both inside that check", () => {
    const guardAt = fn.indexOf("probe.runId === pending.runId");
    expect(guardAt).toBeGreaterThan(-1);
    expect(fn.indexOf('{ type: "gmailCleanerCancel" }')).toBeGreaterThan(guardAt);
    expect(fn.indexOf("releaseRunClaim(pending.runId)")).toBeGreaterThan(guardAt);
  });
});

describe("all three protection lists refuse an over-long save", () => {
  // Protected Keywords is the third list on the page, saved by the same
  // function, capped by the same kind of silent slice, and the first
  // pass of the over-cap work covered only the other two.
  test("protected keywords is capped loudly too", () => {
    const fn = between(OPTIONS_SRC, "const validateData = (data) => {", "\n  /**");
    expect(fn).toContain('readLines("protectKeywords").length');
    expect(fn).toContain("GCC.MAX_PROTECT_KEYWORDS");
  });

  test("all three use the blocking helper, not a warning", () => {
    const fn = between(OPTIONS_SRC, "const validateData = (data) => {", "\n  /**");
    // One call per list: Never Delete, the intensity rules, Protected
    // Keywords. The helper's own definition reads `overCap = (`, so it
    // is not one of these.
    expect((fn.match(/overCap\(/g) || []).length).toBe(3);
    expect(fn).toContain("const overCap = (message) => {");
  });
});

describe("the Pro Settings card follows the licence on the same page", () => {
  // isPro was a closure boolean captured at page load, and the licence
  // section's own re-render did not touch this card. So a buyer who
  // pasted their key, saw "All 6 paid features are unlocked", and
  // scrolled to the sixth one found it greyed out behind a Get Pro link.
  test("there is a hook the licence section can call", () => {
    expect(OPTIONS_SRC).toContain("let refreshProSettingsCard = async () => {};");
    expect(OPTIONS_SRC).toContain("refreshProSettingsCard = renderState;");
  });

  test("both activating and removing a key refresh it", () => {
    expect((OPTIONS_SRC.match(/await refreshProSettingsCard\(\);/g) || []).length).toBe(2);
  });

  test("Reset to defaults repaints only after the write is confirmed", () => {
    const fn = between(OPTIONS_SRC, 'resetBtn?.addEventListener("click"', "refreshProSettingsCard = renderState;");
    expect(fn).toContain("if (await persist({ ...DEFAULTS }, resetBtn)) {");
    expect(fn.indexOf("if (await persist(")).toBeLessThan(fn.indexOf("applyToForm(DEFAULTS);"));
  });
});

describe("the declined-rules truth reaches the one surface an unattended run has", () => {
  // buildHumanSummary's text travels as the `detail` of a progress
  // message, which only reaches an OPEN extension page. An unattended
  // run has none. The desktop notification is built from the
  // gmailCleanerDone payload and from nothing else.
  test("the count rides on the done payload", () => {
    expect(ENGINE_SRC).toContain("declined: Number(stats.declinedRules) || 0,");
  });

  test("the notification branches on it before the freed-MB wording", () => {
    const fn = between(BG_SRC, "async function maybeNotifyDone(summary) {", "chrome.notifications.create");
    expect(fn).toContain("notifTitleDeclined");
    expect(fn).toContain("notifDeclinedBody");
    expect(fn.indexOf("notifDeclinedBody")).toBeLessThan(fn.indexOf("notifLiveBody"));
  });

  test("it only fires when the run really did nothing", () => {
    const fn = between(BG_SRC, "async function maybeNotifyDone(summary) {", "chrome.notifications.create");
    expect(fn).toContain("declinedCount > 0 && count === 0 && !summary?.dryRun");
  });

  test("both keys exist in all seven catalogues", () => {
    for (const locale of ["en", "pt_BR", "es", "fr", "de", "ru", "ja"]) {
      const cat = JSON.parse(read(`_locales/${locale}/messages.json`));
      expect(cat.notifTitleDeclined?.message).toBeTruthy();
      expect(cat.notifDeclinedBody?.message).toBeTruthy();
    }
  });
});

describe("no surface quotes the viewport count for an unreadable total", () => {
  // The modal was fixed first, and the two sibling surfaces fed by the
  // same engine call were still printing the number it had just refused
  // to state: the activity log line behind the modal, and the engine's
  // own guardrail progress detail.
  test("the engine's progress detail says unknown, and sends no count", () => {
    const fn = between(ENGINE_SRC, "async function askGuardrail(", "async function waitForReviewResponse");
    expect(fn).toContain('const unknownTotal = kind === "unknownBulk";');
    expect(fn).toContain("guardCount: unknownTotal ? null : count");
  });

  test("the progress log line honours the kind", () => {
    const fn = between(PROGRESS_SRC, 'if (message.type === "gmailCleanerRequestGuardrail") {', "setPhaseTag(PHASES.GUARDRAIL)");
    expect(fn).toContain('message.guardKind === "unknownBulk"');
  });
});

describe("the X-ray purge restores every age, including any age", () => {
  // "" is the stored value for the "any age" option, so a truthiness
  // test made that one choice the only one that silently reverted.
  test("absent and empty are distinguished", () => {
    const loader = between(POPUP_SRC, "const loadXraySelection = async () => {", "const updateXrayCount");
    expect(loader).toContain('typeof savedAge === "string"');
    expect(loader).not.toContain('typeof savedAge === "string" && savedAge');
  });
});
