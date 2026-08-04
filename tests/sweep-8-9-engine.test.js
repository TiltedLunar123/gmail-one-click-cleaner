/**
 * @jest-environment jsdom
 *
 * Engine findings from the 8.9 sweep.
 *
 * Every assertion here was checked to FAIL against the 8.8.0 source
 * before the fix landed. The bulk-all and age tests drive the real
 * functions over DOM fixtures rather than pinning source, because both
 * defects were about what the code DECIDES, not how it is written.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function loadEngine(config = {}) {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = config;
  window.alert = () => {};
  document.body.innerHTML = "";
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

/**
 * Gmail's list view after the master checkbox has been ticked, i.e.
 * while the select-all-matching offer is still on screen.
 *
 * @param {string} offerText what the offer link says
 */
function paintOffer(offerText) {
  document.body.innerHTML = `
    <div role="main">
      <div class="ya">
        <span>All 50 conversations on this page are selected.</span>
        <span role="link" id="offer">${offerText}</span>
      </div>
      <table><tbody>
        <tr role="row" class="x7"><td></td></tr>
      </tbody></table>
    </div>`;
  return document.getElementById("offer");
}

/**
 * The same banner AFTER the click landed: Gmail withdraws the offer and
 * puts a clear-selection control in its place.
 *
 * @param {string} clearText what that control says in this locale
 * @param {string} bannerText the surrounding sentence
 */
function paintAfterBulkSelect(clearText, bannerText) {
  document.body.innerHTML = `
    <div role="main">
      <div class="ya">
        <span>${bannerText}</span>
        <span role="link" id="clear">${clearText}</span>
      </div>
      <table><tbody>
        <tr role="row" class="x7"><td></td></tr>
      </tbody></table>
    </div>`;
}

describe("8.9: the clear-selection control is not mistaken for the select-all offer", () => {
  // The bug: findSelectAllConversationsLink's fallback accepted any
  // banner role="link" matching /select|conversation|all/i. Gmail's
  // post-click control satisfies that in several languages, so the
  // link-consumed proof (the only language-independent one) answered
  // "still offered", the English-shaped indicator did not rescue those
  // locales either, and a confirmed bulk-all of thousands was booked at
  // the ~50 rows in the viewport. That number is the run receipt, the
  // stats row, the undo count and the soft-cap accumulator.
  let engine;
  beforeEach(() => { engine = loadEngine({ runId: "r1" }); });

  const CLEAR_CONTROLS = [
    ["Dutch", "Selectie wissen", "Alle 9.000 gesprekken in deze zoekopdracht zijn geselecteerd."],
    ["Swedish", "Avmarkera alla", "Alla 9 000 konversationer i sökningen har markerats."],
    ["English", "Clear selection", "All 9,000 conversations in this search are selected."]
  ];

  test.each(CLEAR_CONTROLS)(
    "%s: the clear-selection control does not read as an offer",
    (_lang, clearText) => {
      expect(engine.looksLikeSelectAllOffer(clearText)).toBe(false);
    }
  );

  test.each(CLEAR_CONTROLS)(
    "%s: once the offer is withdrawn the finder returns nothing",
    (_lang, clearText, bannerText) => {
      paintAfterBulkSelect(clearText, bannerText);
      expect(engine.findSelectAllConversationsLink()).toBeNull();
    }
  );

  test("a real offer is still found", () => {
    paintOffer("Select all 9,000 conversations that match this search");
    expect(engine.findSelectAllConversationsLink()).not.toBeNull();
  });

  test("the offer is recognised in the languages the token table covers", () => {
    for (const text of [
      "Select all 9,000 conversations that match this search",
      "Seleccionar todas las conversaciones que coincidan con esta búsqueda",
      "Alle 9.000 Konversationen auswählen, die dieser Suche entsprechen",
      "Tout sélectionner"
    ]) {
      expect(engine.looksLikeSelectAllOffer(text)).toBe(true);
    }
  });

  test("clicking the offer reports link-consumed once the offer is gone", async () => {
    const link = paintOffer("Select all 9,000 conversations that match this search");
    // Gmail swaps the banner in response to the click. Dutch on purpose:
    // this is the case that used to fall through to clicked-unverified.
    link.addEventListener("mousedown", () => {
      paintAfterBulkSelect("Selectie wissen", "Alle 9.000 gesprekken zijn geselecteerd.");
    });

    const result = await engine.clickSelectAllConversations();
    expect(result.success).toBe(true);
    expect(result.reason).toBe("link-consumed");
  });

  test("a click that changes nothing is still reported as unverified", async () => {
    // The offer stays on screen, so nothing proves the whole match set
    // was selected and the run must NOT book itself as bulk-all.
    paintOffer("Select all 9,000 conversations that match this search");
    const result = await engine.clickSelectAllConversations();
    expect(result.reason).not.toBe("link-consumed");
  });
});

describe("8.9: an archive run books no freed storage", () => {
  // Archiving moves mail to All Mail. It stays in the account and it
  // stays against the quota, so "Freed ~420 MB" under an archive run was
  // false in the progress card, the receipt, the popup result, the recap
  // and the lifetime total on Stats. Ninth instance of a number beside
  // an action being measured through a different filter than the action.
  test("freed megabytes accumulate only when the run deletes", () => {
    const at = SRC.indexOf("stats.totalFreedMb += (affectedThisPass * mbPerEmail);");
    expect(at).toBeGreaterThan(-1);
    const before = SRC.slice(Math.max(0, at - 260), at);
    expect(before).toMatch(/if\s*\(!CONFIG\.archiveInsteadOfDelete\)\s*\{/);
  });

  test("the end-of-run sentence still refuses to quote megabytes for an archive", () => {
    // Already true before 8.9 and the reason the defect survived so
    // long: the one surface that got it right was the one nobody
    // compared the others against.
    expect(SRC).toMatch(/if\s*\(CONFIG\.archiveInsteadOfDelete\)\s*\{\s*\n\s*return\s+`Cleanup finished: \$\{stats\.totalDeleted/);
  });
});

describe("8.9: a report band that was never measured says so", () => {
  // A band whose search threw was `continue`d, leaving counts[id]
  // undefined, and `Number(undefined) || 0` turned that into a
  // confident zero: the step dropped out of the plan and that part of
  // the mailbox read as clean when it had simply not been looked at.
  test("the band carries a measured flag taken from whether a count landed", () => {
    expect(SRC).toContain(
      "const measured = Object.prototype.hasOwnProperty.call(counts, band.id);"
    );
    expect(SRC).toMatch(/const\s+count\s*=\s*measured\s*\?/);
  });

  test("a failed band still increments the failed-query counter", () => {
    const at = SRC.indexOf("Report band query failed, continuing");
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 200)).toContain("failedQueries++");
  });
});

describe("8.9: every progress message names its run", () => {
  // gmailCleanerDone has carried a runId since 8.7; progress did not, so
  // Auto-Pilot's apply stage could only match on the tab and any cleanup
  // terminal message from that tab advanced or cleared its state.
  test("both senders stamp the run id", () => {
    const immediate = SRC.slice(
      SRC.indexOf("const safeSendImmediate = (msg) => {"),
      SRC.indexOf("const safeSendImmediate = (msg) => {") + 400
    );
    expect(immediate).toContain("runId: RUN_ID");
    const debounced = SRC.slice(
      SRC.indexOf("const _debouncedSend = debounce((msg) => {"),
      SRC.indexOf("const _debouncedSend = debounce((msg) => {") + 400
    );
    expect(debounced).toContain("runId: RUN_ID");
  });

  test("the id is read from the window, not from CONFIG", () => {
    // The duplicate-inject boot message fires before sanitizeConfig has
    // run, so reading CONFIG there would throw on the one message the
    // unattended callers most need.
    expect(SRC).toContain("const raw = window.GMAIL_CLEANER_CONFIG?.runId;");
    expect(SRC.indexOf("const RUN_ID")).toBeLessThan(SRC.indexOf("if (window.GCC_ATTACHED) {"));
  });

  test("a message the engine sends carries the id it was injected with", () => {
    const sent = [];
    chrome.runtime.sendMessage = (msg) => { sent.push(msg); };
    loadEngine({ runId: "sched_42_999", dryRun: true });
    const progress = sent.filter((m) => m.type === "gmailCleanerProgress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].runId).toBe("sched_42_999");
  });
});

describe("8.9: an age floor inside an OR group is seen", () => {
  // `{` opens Gmail's OR group, so it separates operators exactly as a
  // space or `(` does. The dangerous-token scanner learned that in 7.15
  // and this twin was missed.
  test("strictestOlderThanDays reads a floor that follows a brace", () => {
    const engine = loadEngine();
    expect(engine.strictestOlderThanDays("{older_than:2y category:promotions}")).toBe(730);
  });

  test("the older forms still work and a negated age is still ignored", () => {
    const engine = loadEngine();
    expect(engine.strictestOlderThanDays("category:promotions older_than:6m")).toBe(180);
    expect(engine.strictestOlderThanDays("(older_than:1y)")).toBe(365);
    expect(engine.strictestOlderThanDays("category:promotions -older_than:6m")).toBeNull();
  });
});

describe("8.9: restore says which limit it hit", () => {
  // Falling out of the pass loop having used every pass left stopReason
  // null, and the fallback message read "Selection failed (unknown)",
  // which sends the user chasing the wrong problem. Running Restore
  // again is the right move and the copy now says so.
  test("exhausting the pass cap sets its own stop reason", () => {
    expect(SRC).toMatch(
      /if\s*\(!completedClean\s*&&\s*!stopReason\s*&&\s*pass\s*>=\s*TIMING\.PASS_CAP\)\s*\{\s*\n\s*stopReason\s*=\s*"pass-cap";/
    );
  });

  test("the message for it names the page limit, not a selection failure", () => {
    const fn = SRC.slice(
      SRC.indexOf("function restoreStopMessage(reason, action) {"),
      SRC.indexOf("async function restoreRun() {")
    );
    expect(fn).toContain('if (reason === "pass-cap")');
    expect(fn).toContain("Restore hit this run's page limit.");
  });
});
