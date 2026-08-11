/**
 * @jest-environment jsdom
 *
 * The 8.13 release.
 *
 * Every assertion here was run against the 8.12.0 source first: 42 of
 * the 46 tests FAIL there. The 4 that pass either way are deliberate
 * invariant pins, they say so on the test, and they are the four this
 * release most needed to be sure it had not broken:
 *
 *   - the purge button and its controls are still gated
 *   - a dry run still earns no rating ask
 *   - a refused run and a dry run are still reported as themselves
 *   - no file that ships contains network code
 *
 * The theme is where the paywall sits. A read-only scan of the user's
 * own mailbox was being withheld to sell a button; the button is now the
 * only thing withheld. The rest follows from that: the pitch had to stop
 * offering to unlock a list that is no longer locked, the buyer had to
 * stop being stranded with a key they must retype, and the ask for a
 * rating had to stop being a one-shot that almost nobody ever saw.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const POPUP_SRC = read("popup.js");
const POPUP_HTML = read("popup.html");
const SHARED_SRC = read("shared.js");
const BG_SRC = read("background.js");
const BUILD_SRC = read("build.js");
const STATS_SRC = read("stats.js");
const STATS_HTML = read("stats.html");
const OPTIONS_HTML = read("options.html");
const MANIFEST = JSON.parse(read("manifest.json"));
const BUY_HTML = read("netlify/site/index.html");
const ACTIVATE_HTML = read("netlify/site/activate.html");
const RECOVER_HTML = read("netlify/site/recover.html");

/** The shared library, evaluated the way its own suites evaluate it. */
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

const GCC = loadShared();

/** The body of a named function or arrow const in a source file. */
function bodyOf(src, name, span = 6000) {
  const start = src.indexOf(name);
  if (start === -1) throw new Error(`not found: ${name}`);
  return src.slice(start, start + span);
}

/** Markup with its line wrapping flattened, so a pin is about the
 *  sentence rather than about where the editor broke the line. */
const flat = (html) => html.replace(/\s+/g, " ");

// =====================================================================
// 1. The X-ray list is free; only the purge is not
// =====================================================================

describe("Storage X-ray: the list is not the product", () => {
  const renderXray = bodyOf(POPUP_SRC, "const renderXrayList =");

  test("renderXrayList iterates every ranked sender, not a free slice", () => {
    expect(renderXray).toContain("for (const sender of senders)");
    expect(renderXray).not.toContain("senders.slice(freeCap)");
    expect(renderXray).not.toMatch(/const visible = active \? senders : senders\.slice/);
  });

  test("the teaser row that hid senders behind the paywall is gone", () => {
    expect(POPUP_SRC).not.toContain("xray-locked-mb");
    expect(POPUP_SRC).not.toContain("xrayLockedTail");
    // The smart-suggestions list keeps its own locked row; this is only
    // about the X-ray. Losing that distinction would silently unlock a
    // second feature nobody asked to give away.
    expect(POPUP_SRC).toContain("GCC.smart.LIMITS.FREE_VISIBLE");
  });

  // Invariant pin: this passed on 8.12 too, and it is the half of the
  // paywall that had to survive the other half being taken down.
  test("the purge button, its selection controls and its age filter stay gated", () => {
    expect(renderXray).toContain('elements.xrayToolbar.hidden = !hasSenders || !active');
    expect(renderXray).toMatch(/xrayAgeRow.*hasSenders && active/);
    // The button itself is shown to everyone and carries `locked`, which
    // is what routes a free click to checkout instead of to a run.
    expect(POPUP_SRC).toContain('elements.xrayPurgeBtn.classList.toggle("locked", !active)');
    expect(POPUP_SRC).toMatch(/handleXrayPurge[\s\S]{0,220}state\.subs\.licenseActive[\s\S]{0,200}openProPanel/);
  });

  test("nothing in the Pro copy still sells the list itself", () => {
    const xrayFeature = GCC.license.FEATURES.find((f) => /X-ray/i.test(f));
    expect(xrayFeature).toBeTruthy();
    expect(xrayFeature).not.toMatch(/full/i);
    expect(GCC.popupUi.xrayUpsellLine(0, 0)).not.toMatch(/full ranked list/i);
    expect(POPUP_HTML).not.toMatch(/full ranked list of space hogs/i);
  });
});

// =====================================================================
// 2. The rating ask
// =====================================================================

describe("Rating ask: every qualifying run, with a real backstop", () => {
  const UI = GCC.popupUi;
  const DAY = 1000 * 60 * 60 * 24;
  const NOW = 1_760_000_000_000;
  const enoughRuns = UI.RATING_MIN_RUNS;

  test("a clean slate is asked, once the user is past their first run", () => {
    expect(UI.shouldAskForRating({}, NOW, enoughRuns)).toBe(true);
    expect(UI.shouldAskForRating(undefined, NOW, enoughRuns)).toBe(true);
  });

  test("the very first run is never asked", () => {
    expect(UI.shouldAskForRating({}, NOW, 1)).toBe(false);
    expect(UI.shouldAskForRating({}, NOW, 0)).toBe(false);
    expect(UI.RATING_MIN_RUNS).toBe(2);
  });

  test("a refusal is quiet for the cooldown and then asks again", () => {
    const justRefused = { dismissals: 1, lastDismissedAt: NOW - DAY };
    expect(UI.shouldAskForRating(justRefused, NOW, enoughRuns)).toBe(false);

    const refusedLongAgo = { dismissals: 1, lastDismissedAt: NOW - 4 * DAY };
    expect(UI.shouldAskForRating(refusedLongAgo, NOW, enoughRuns)).toBe(true);
  });

  test("three refusals is an answer", () => {
    const done = { dismissals: UI.RATING_MAX_DISMISSALS, lastDismissedAt: NOW - 400 * DAY };
    expect(UI.shouldAskForRating(done, NOW, enoughRuns)).toBe(false);
  });

  test("`done` outranks everything, forever", () => {
    expect(UI.shouldAskForRating({ done: true }, NOW, 9999)).toBe(false);
    expect(UI.shouldAskForRating({ done: true, dismissals: 0 }, NOW + 5000 * DAY, 9999)).toBe(false);
  });

  test("a pre-8.13 dismissal counts as one refusal, not as a decision", () => {
    // The old key could not tell "maybe later" from "I rated it", so it
    // must not be read as either extreme: honouring it forever is the
    // bug being fixed, and ignoring it would re-prompt the same day.
    const fromTimestamp = UI.migrateRatingAsk(undefined, NOW - 400 * DAY);
    expect(fromTimestamp.dismissals).toBe(1);
    expect(UI.shouldAskForRating(fromTimestamp, NOW, enoughRuns)).toBe(true);

    const fromLegacyTrue = UI.migrateRatingAsk(undefined, true);
    expect(fromLegacyTrue.dismissals).toBe(1);
    expect(UI.shouldAskForRating(fromLegacyTrue, NOW, enoughRuns)).toBe(true);

    // Never invented for someone who was never asked.
    expect(UI.migrateRatingAsk(undefined, undefined)).toEqual({});
    // And a real record always wins over the legacy key.
    const real = { dismissals: 2, lastDismissedAt: NOW };
    expect(UI.migrateRatingAsk(real, NOW - DAY)).toBe(real);
  });

  test("the two writers do what their names say", () => {
    expect(UI.noteRatingDismissed({}, NOW)).toEqual({ dismissals: 1, lastDismissedAt: NOW });
    expect(UI.noteRatingDismissed({ dismissals: 2 }, NOW).dismissals).toBe(3);
    expect(UI.noteRatingDone({ dismissals: 1 })).toEqual({ dismissals: 1, done: true });
  });

  test("the popup reads the run counter and passes it to the gate", () => {
    const fn = bodyOf(POPUP_SRC, "const maybeShowRatingForRun =");
    expect(fn).toContain("STORAGE_KEYS.RUN_COUNT");
    expect(fn).toMatch(/shouldAskForRating\(ask, Date\.now\(\), runs\)/);
  });

  test("only going to the store, or the explicit out, is permanent", () => {
    // Both rate buttons end the ask; "Maybe later" must not.
    const rateHandlers = POPUP_SRC.match(/GCC\.storeLinks\(\)\.reviews[\s\S]{0,160}/g) || [];
    expect(rateHandlers.length).toBe(2);
    for (const h of rateHandlers) expect(h).toContain("stopRatingAsks()");
    expect(POPUP_SRC).toContain('elements.ratingDismiss?.addEventListener("click", dismissRatingPrompt)');
    expect(POPUP_SRC).toContain('elements.ratingNever?.addEventListener("click", stopRatingAsks)');
    // Nothing writes the retired key any more.
    expect(POPUP_SRC).not.toMatch(/\[STORAGE_KEYS\.RATING_DISMISSED\]:/);
  });

  test("the explicit out exists in the markup and is registered", () => {
    // An element referenced but never registered in the map is a silent
    // no-op here: every handler is written `elements.X?.addEventListener`.
    expect(POPUP_HTML).toContain('id="ratingNever"');
    expect(POPUP_SRC).toContain('ratingNever: $("ratingNever")');
  });

  test("a dry run still earns nothing, whatever the record says", () => {
    // Invariant pin: true on 8.12 too, and the reason the gate above is
    // allowed to be as generous as it is.
    expect(UI.ratingRunQualifies({ dryRun: true, cleaned: 100000 })).toBe(false);
  });
});

// =====================================================================
// 3. The completion notification
// =====================================================================

describe("Completion notification: one Pro line, on the right runs", () => {
  test("the pitch is gated on a real run that cleaned something, by a non-buyer", () => {
    const fn = bodyOf(BG_SRC, "async function maybeNotifyDone", 8000);
    expect(fn).toMatch(/bgT\(\s*"notifProPitch"/);
    expect(fn).toMatch(/if \(count > 0 && !summary\?\.dryRun && !\(await hasProLicense\(\)\)\)/);
  });

  test("the pitch is appended to message, not to an option Firefox rejects", () => {
    const fn = bodyOf(BG_SRC, "async function maybeNotifyDone", 8000);
    expect(fn).toContain("msg += ");

    // Pinned on the options object itself rather than on the whole
    // function, because a comment explaining why an option is absent
    // contains the very word a source-wide pin looks for. That has cost
    // this repo a false green before.
    const opts = fn.match(/chrome\.notifications\.create\("",\s*\{([\s\S]*?)\}/)[1];
    const keys = [...opts.matchAll(/^\s*([A-Za-z]+)\s*[,:]/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(["iconUrl", "message", "title", "type"]);
  });

  test("a refusal and a dry run are still reported as themselves", () => {
    // Invariant pins from 8.12 that the new branch sits after.
    const fn = bodyOf(BG_SRC, "async function maybeNotifyDone", 8000);
    expect(fn).toContain("notifDeclinedBody");
    expect(fn).toContain("notifDryBody");
  });
});

// =====================================================================
// 4. One-click activation
// =====================================================================

describe("One-click activation: nobody is stranded holding a key", () => {
  test("only the purchase origin can reach the extension at all", () => {
    expect(MANIFEST.externally_connectable).toEqual({
      matches: ["https://gmail-cleaner-pro.netlify.app/*"]
    });
  });

  test("the handler re-checks the origin itself and verifies the key", () => {
    const fn = bodyOf(BG_SRC, "async function activateLicenseFromPage");
    expect(fn).toContain("await verifyProLicenseKey(key)");
    expect(fn).toContain("chrome.storage.sync.set");
    expect(fn).toContain("chrome.storage.local.set");

    const listener = bodyOf(BG_SRC, "chrome.runtime.onMessageExternal.addListener");
    expect(listener).toContain("origin !== ACTIVATION_ORIGIN");
    expect(listener).toMatch(/if \(origin !== ACTIVATION_ORIGIN\) \{[\s\S]{0,140}return;/);
    expect(BG_SRC).toContain('const ACTIVATION_ORIGIN = "https://gmail-cleaner-pro.netlify.app"');
  });

  test("an unverifiable key cannot be stored, so the page cannot grant Pro", () => {
    const fn = bodyOf(BG_SRC, "async function activateLicenseFromPage");
    const verifyAt = fn.indexOf("verifyProLicenseKey");
    const storeAt = fn.indexOf("chrome.storage.sync.set");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(storeAt).toBeGreaterThan(verifyAt);
  });

  test("the listener is guarded, because Firefox has no onMessageExternal", () => {
    expect(BG_SRC).toContain("if (chrome.runtime?.onMessageExternal?.addListener)");
  });

  test("the Firefox build drops the manifest key entirely", () => {
    expect(BUILD_SRC).toContain("delete m.externally_connectable");
    const { firefoxManifest } = require("../build.js");
    expect(firefoxManifest(MANIFEST).externally_connectable).toBeUndefined();
  });

  test("both key pages offer the button and both keep the manual path", () => {
    for (const [name, html] of [["activate", ACTIVATE_HTML], ["recover", RECOVER_HTML]]) {
      expect(html).toContain('id="activateBtn"');
      expect(html).toContain("gmailCleanerActivateLicense");
      expect(html).toContain("gmailCleanerPing");
      // lastError has to be read or the browser logs on every miss.
      expect(html).toContain("chrome.runtime.lastError");
      // The paste-it-yourself steps survive for Firefox and second
      // browsers; the button only ever demotes them.
      expect(html).toContain('id="steps"');
      expect(html).toContain("Pro License");
      // Wiring twice would send two activations per click.
      expect(html).toContain("oneClickWired");
      if (!html.includes("bmcfpljakkpcbinhgiahncpcbhmihgpc")) {
        throw new Error(`${name}.html has no extension id to message`);
      }
    }
  });
});

// =====================================================================
// 5. The guarantee
// =====================================================================

describe("30-day money-back guarantee", () => {
  test("one source of truth for the window", () => {
    expect(GCC.license.PRO.GUARANTEE_DAYS).toBe(30);
    expect(GCC.license.PRO.GUARANTEE_LABEL).toBe("30-day money-back guarantee");
  });

  test("it is promised on every surface that asks for money", () => {
    expect(POPUP_HTML).toContain("30-day money-back guarantee");
    expect(OPTIONS_HTML).toContain("30-day money-back guarantee");
    expect(BUY_HTML).toContain("30-day money-back guarantee");
    expect(STATS_HTML).toContain("30-day money-back guarantee");
    expect(read("_locales/en/messages.json")).toContain("30-day money-back guarantee");
  });

  test("the pages that promise it also say what a refund cannot do", () => {
    // A refunded key keeps working, because verification is offline and
    // there is no revocation. Saying so is the honest version of the
    // promise, and it is the sort of sentence that gets "tidied" away.
    expect(flat(BUY_HTML)).toMatch(/keeps working after a refund/i);
    expect(flat(OPTIONS_HTML)).toMatch(/refunded key keeps working/i);
  });
});

// =====================================================================
// 6. The pitch leads with the claim competitors cannot match
// =====================================================================

describe("Pitch: no OAuth, zero network calls", () => {
  const NETWORK = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource/;
  const SHIPPED = [
    "background.js", "contentScript.js", "shared.js", "popup.js",
    "options.js", "progress.js", "stats.js", "diagnostics.js",
    "changelog.js", "changelog-data.js", "browser-polyfill.js"
  ];

  // Invariant pin: true on 8.12, and it has to stay true or the new
  // headline on the buy page becomes a lie.
  test("the claim is true of every file that ships", () => {
    // This is the assertion that keeps the claim honest. If a future
    // release adds a fetch anywhere in the extension, this fails before
    // the buy page can lie about it.
    for (const file of SHIPPED) {
      const src = read(file);
      if (NETWORK.test(src)) throw new Error(`${file} contains network code; the buy page claims none exists`);
    }
    expect(MANIFEST.permissions).not.toContain("identity");
    expect(MANIFEST.host_permissions).toEqual(["https://mail.google.com/*"]);
  });

  test("the buy page leads with it and shows the reader how to check", () => {
    const head = BUY_HTML.slice(BUY_HTML.indexOf("<h1"), BUY_HTML.indexOf("</p>", BUY_HTML.indexOf("lede")));
    expect(head).toMatch(/No OAuth/i);
    expect(head).toMatch(/network calls/i);
    expect(BUY_HTML).toContain("XMLHttpRequest");
    expect(BUY_HTML).toMatch(/grep/i);
  });

  test("the popup Pro panel leads with it too", () => {
    const lead = POPUP_HTML.match(/id="proPanelLead"[\s\S]{0,260}/)[0];
    expect(lead).toMatch(/No OAuth/i);
    // And it is the first fact in the list, not the third.
    const facts = POPUP_HTML.slice(POPUP_HTML.indexOf('class="pro-panel-facts"'));
    expect(facts.indexOf("proFactOffline")).toBeLessThan(facts.indexOf("proFactOnce"));
  });
});

// =====================================================================
// 7. Social proof stays inside what can be defended
// =====================================================================

describe("Buy page social proof", () => {
  test("the star rating matches the live listing", () => {
    expect(BUY_HTML).toContain("<strong>4.6 stars</strong>");
    expect(BUY_HTML).not.toContain("4.5 stars");
  });

  test("no user count sourced from the badge the sideloaders inflated", () => {
    // The 2026-07 spike went 2,030 -> 8,046 -> ~19,000 with zero sales
    // in the window, and Google removed the public count afterwards.
    // Lifetime installs never spiked, which is why the claim is an
    // install count and why it is kept well under the real figure.
    expect(BUY_HTML).toMatch(/<strong>3,000\+<\/strong> installs/);
    expect(BUY_HTML).not.toMatch(/10,743|19,000|8,046/);
    expect(BUY_HTML).not.toMatch(/\d[\d,]*\+?\s*users/i);
  });
});

// =====================================================================
// 8. Three more Pro settings
// =====================================================================

describe("Pro settings added in 8.13", () => {
  const S = GCC.proSettings;

  test("every new default is exactly what 8.12 did", () => {
    // The rule the whole card is built on: a free install, a copy whose
    // key was removed, and a Pro user who never opens this behave
    // identically. 25 was AUTOPILOT_MAX_PER_RUN, "" is no extra floor,
    // 60 was the hardcoded undo cap.
    expect(S.DEFAULTS.autoPilotMaxSenders).toBe(25);
    expect(S.DEFAULTS.autoPilotMinAge).toBe("");
    expect(S.DEFAULTS.undoLogEntries).toBe(60);
  });

  test("without a licence, none of them apply", () => {
    const stored = { autoPilotMaxSenders: 50, autoPilotMinAge: "1y", undoLogEntries: 300 };
    const out = S.effective(stored, false);
    expect(out.autoPilotMaxSenders).toBe(25);
    expect(out.autoPilotMinAge).toBe("");
    expect(out.undoLogEntries).toBe(60);
  });

  test("with a licence, they do", () => {
    const stored = { autoPilotMaxSenders: 50, autoPilotMinAge: "1y", undoLogEntries: 300 };
    expect(S.effective(stored, true)).toMatchObject(stored);
  });

  test("values outside the allow-list fall back per field", () => {
    const out = S.effective(
      { autoPilotMaxSenders: 5000, autoPilotMinAge: "9y", undoLogEntries: 999999, labelPrefix: "Keep" },
      true
    );
    expect(out.autoPilotMaxSenders).toBe(25);
    expect(out.autoPilotMinAge).toBe("");
    expect(out.undoLogEntries).toBe(60);
    expect(out.labelPrefix).toBe("Keep");
  });

  test('the empty age is a stored CHOICE, not a missing value', () => {
    // 8.12 shipped exactly this bug on the X-ray age select: a value
    // whose empty string is a real option, read with `x && ...`, is the
    // one setting that silently refuses to stick.
    expect(S.LIMITS.MIN_AGES).toContain("");
    const out = S.effective({ autoPilotMinAge: "" }, true);
    expect(out.autoPilotMinAge).toBe("");
  });

  test("the worker's copy agrees with the shared one, field for field", () => {
    // The worker is self-contained by design, so this is the only thing
    // stopping the two drifting.
    for (const [key, value] of Object.entries(S.DEFAULTS)) {
      const re = new RegExp(`${key}:\\s*${typeof value === "string" ? `"${value}"` : value}`);
      if (!re.test(BG_SRC)) throw new Error(`worker default missing or different: ${key}`);
    }
    expect(BG_SRC).toContain("PRO_SETTINGS_MAX_SENDERS = Object.freeze([10, 25, 50])");
    expect(BG_SRC).toContain('PRO_SETTINGS_MIN_AGES = Object.freeze(["", "1m", "3m", "6m", "1y"])');
    expect(BG_SRC).toContain("PRO_SETTINGS_UNDO_ENTRIES = Object.freeze([60, 150, 300])");
  });

  test("the sweep cap is clamped, not trusted", () => {
    // It arrives from storage and decides how much mail an unattended
    // run touches, so an out-of-range value has to land on the default
    // rather than on itself.
    const fn = bodyOf(BG_SRC, "function autoPilotPickSenders");
    expect(fn).toContain("PRO_SETTINGS_MAX_SENDERS.includes(Number(cap))");
    expect(fn).toContain("AUTOPILOT_MAX_PER_RUN");
    expect(BG_SRC).toMatch(
      /autoPilotPickSenders\([\s\S]{0,120}scanned, feedback, whitelist, protectKeywords, Date\.now\(\), proSettings\.autoPilotMaxSenders/
    );
  });

  test("the Pro age floor can only narrow an unattended sweep", () => {
    const fn = bodyOf(BG_SRC, "function swStrictestAgeToken");
    expect(fn).toContain("entry.days > max.days");
    // Same table both implementations must agree on.
    const cases = [["6m", "1y", "1y"], ["1y", "6m", "1y"], ["", "3m", "3m"], ["3m", "", "3m"], ["", "", null]];
    for (const [a, b, want] of cases) {
      expect(GCC.strictestAgeToken(a, b)).toBe(want);
    }
    expect(BG_SRC).toContain("minAge: swStrictestAgeToken(guards.minAge, proSettings.autoPilotMinAge)");
  });

  test("the recovery log cap is read rather than hardcoded", () => {
    const fn = bodyOf(BG_SRC, "async function recordUndoEntry");
    // 8.14: read through readUndoLogCap rather than readProSettings, so
    // a licence or settings read that FAILS leaves the log alone instead
    // of trimming a Pro user's 300 entries to the free 60. The pinned
    // intent is unchanged: the cap is read, never hardcoded.
    expect(fn).toContain("readUndoLogCap()");
    expect(fn).toContain("if (undoCap !== null && log.length > undoCap) log.length = undoCap;");
    expect(fn).not.toContain("if (log.length > 60)");
  });

  test("all six settings are on the options card and in the saved payload", () => {
    for (const id of [
      "proLabelPrefix", "proAutoPilotInterval", "proSmartScanDepth",
      "proAutoPilotMaxSenders", "proAutoPilotMinAge", "proUndoLogEntries"
    ]) {
      expect(OPTIONS_HTML).toContain(`id="${id}"`);
      expect(read("options.js")).toContain(`GCC.$("${id}")`);
    }
    const OPTIONS_SRC = read("options.js");
    // Disabled with the rest of the card when there is no licence.
    expect(OPTIONS_SRC).toMatch(/for \(const el of \[labelInput, intervalSel, depthSel, maxSendersSel, minAgeSel, undoEntriesSel, saveBtn, resetBtn\]\)/);
    // And the age is saved without a `||` that would eat the empty choice.
    expect(OPTIONS_SRC).toContain('autoPilotMinAge: typeof minAgeSel?.value === "string" ? minAgeSel.value : DEFAULTS.autoPilotMinAge');
  });
});

// =====================================================================
// 9. The stats page pitch
// =====================================================================

describe("Stats page pitch", () => {
  test("it ships hidden and is only revealed after a licence check says no", () => {
    expect(STATS_HTML).toMatch(/id="proPitch"[^>]*hidden/);
    const fn = bodyOf(STATS_SRC, "async function renderProPitch");
    expect(fn).toContain("GCC.license.getState()");
    expect(fn).toMatch(/if \(active\) \{[\s\S]{0,80}hidden = true;/);
    // A check that throws must hide, not reveal: a buyer seeing a pitch
    // for what they own is the worse failure.
    expect(fn).toMatch(/catch \{[\s\S]{0,400}hidden = true;[\s\S]{0,40}return;/);
  });

  test("the lead quotes the totals this page just rendered", () => {
    const fn = bodyOf(STATS_SRC, "async function renderProPitch");
    expect(fn).toContain("stats?.totalDeleted");
    expect(fn).toContain("stats?.totalArchived");
    expect(STATS_SRC).toContain("renderProPitch(stats)");
  });

  test("the checkout link carries its own attribution source", () => {
    expect(STATS_SRC).toContain('GCC.license.buyUrl("stats")');
  });

  test("the handler is wired exactly once across polls", () => {
    // loadStats re-runs every 30 seconds; wiring per render would stack
    // a listener each time.
    expect(STATS_SRC).toContain("proPitchWired");
  });
});
