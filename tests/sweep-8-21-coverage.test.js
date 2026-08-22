/**
 * @jest-environment jsdom
 *
 * 8.21: guards that nothing asserted.
 *
 * A coverage audit of all 83 suites found six safety guards that could be
 * deleted outright with the whole suite still green. Every one of them is
 * a refusal, and a refusal that nothing pins is the thing that quietly
 * stops refusing in the release where it matters. 8.20 found four of the
 * same shape and pinned them; these are the rest.
 *
 *   Review Mode's pause gate        no coverage of any kind
 *   the whitelist sanitisers        tested in a vacuum, never at a call site
 *   Safe Mode's rule-stripping half  only its subject shield was covered
 *   restoreCandidates' exclusions   the deny-list beside them was pinned
 *   the Options whitelist warn-guard pinned by its message text, not by firing
 *   Auto-Pilot's apply-stage gates   the scan-stage twins were pinned
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, "contentScript.js"), "utf-8");
const BG_SRC = fs.readFileSync(path.join(ROOT, "background.js"), "utf-8");
const OPTIONS_SRC = fs.readFileSync(path.join(ROOT, "options.js"), "utf-8");

let sent;

function installChrome() {
  const runtime = {
    id: "test-extension-id",
    lastError: null,
    getURL: (p) => `chrome-extension://test/${p}`,
    sendMessage: (msg) => {
      sent.push(msg);
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener: () => {} }
  };
  global.chrome = {
    runtime,
    storage: {
      sync: { get: (key, cb) => cb({}) },
      local: { get: (_k, cb) => cb({}), set: (_o, cb) => cb && cb() }
    }
  };
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

beforeEach(() => {
  sent = [];
  installChrome();
});

afterEach(() => {
  delete global.chrome;
});

// =====================================================================
// 1. Review Mode's pause gate
// =====================================================================

describe("Review Mode's pause gate", () => {
  // The popup ships a "Review Matches / Pause and confirm each query
  // first" switch. The engine gate that implements it, and the timeout
  // under it, could both be deleted with the whole suite green: the only
  // occurrences of reviewMode anywhere in tests/ were element lookups.
  // This is a paid safety switch whose entire job is to stop a delete.
  //
  // NOT driven end to end, and the reason is worth recording. The gate
  // lives inside processQuery, past openSearch, which waits
  // WAIT_SEARCH_TIMEOUT (20s) for a search box a fake page does not
  // have. TIMING and GUARDRAILS are both Object.freeze'd, so shrinking
  // them from a test is a SILENT no-op -- the same shape as jsdom
  // refusing to let `performance` be replaced. The first version of this
  // block assigned to I.GUARDRAILS.REVIEW_RESPONSE_TIMEOUT_MS, watched
  // nothing change, and timed out at 30s per case.
  //
  // So the switch's journey INTO the engine is behavioural, and the gate
  // itself is pinned on the properties that make it a gate. Either way
  // it can no longer be deleted with a green suite, which is the point.

  test("the switch survives sanitizeConfig, in both positions", () => {
    const I = loadEngine();
    expect(I.sanitizeConfig({ reviewMode: true }).reviewMode).toBe(true);
    expect(I.sanitizeConfig({ reviewMode: false }).reviewMode).toBe(false);
    // 8.2: a MISSING guard must not read as ON. Review Mode is the
    // opposite polarity -- missing means off -- because pausing a run
    // nobody asked to pause strands an unattended sweep.
    expect(I.sanitizeConfig({}).reviewMode).toBe(false);
  });

  test("the gate asks before it acts, and only when it should", () => {
    const fn = ENGINE_SRC.slice(
      ENGINE_SRC.indexOf("async function processQuery(query, idx, total)"),
      ENGINE_SRC.indexOf("function buildFinalStats")
    );
    expect(fn.length).toBeGreaterThan(500);

    // All three conditions, each pinned by itself rather than by counting
    // them: a count is what let 8.19's third short exit stay missing for
    // three releases.
    expect(fn).toContain("CONFIG.reviewMode");
    expect(fn).toContain("!hasReviewedThisQuery");
    expect(fn).toContain("!CONFIG.dryRun");

    // The ask reaches an extension page, and the run stops until it is
    // answered.
    const ask = fn.indexOf('type: "gmailCleanerRequestReview"');
    const wait = fn.indexOf("await waitForReviewResponse()");
    expect(ask).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(ask);

    // Skip returns without acting, and records the rule so the run's own
    // tally does not claim it.
    const skip = fn.indexOf('if (signal === "skip")');
    expect(skip).toBeGreaterThan(wait);
    expect(fn.slice(skip, skip + 400)).toContain("recordQuery({");
    expect(fn.slice(skip, skip + 400)).toContain("return;");

    // Cancel means cancel, not skip.
    expect(fn).toContain('if (signal === "cancel")');
    expect(fn).toContain("CANCELLED = true;");
  });

  test("an unanswered ask is treated as a skip, not as a proceed", () => {
    const fn = ENGINE_SRC.slice(
      ENGINE_SRC.indexOf("async function waitForReviewResponse()"),
      ENGINE_SRC.indexOf("async function processQuery(")
    );
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).toContain("GUARDRAILS.REVIEW_RESPONSE_TIMEOUT_MS");
    expect(fn).toContain('return "skip";');
    // Proceeding on a closed progress tab would delete a batch nobody
    // ever saw.
    expect(fn).not.toContain('return "resume";');
  });
});

// =====================================================================
// 2. The whitelist, at its call sites
// =====================================================================

describe("the whitelist is applied, not merely validated", () => {
  // isValidWhitelistEntry was reconstructed from source text and
  // exercised in a vacuum. Nothing asserted that sanitizeConfig applies
  // it, and nothing at all covered the second-layer refusal inside
  // applyGlobalGuards, so both sanitisers were deletable.

  test("a valid entry reaches the query as an exclusion", () => {
    const I = loadEngine({ whitelist: ["boss@example.com"] });
    expect(I.applyGlobalGuards("category:promotions")).toContain("-from:boss@example.com");
  });

  test("an entry carrying query syntax is refused, not passed through", () => {
    // A whitelist line is a sender, not a query. Letting one through
    // means user text is concatenated into a search that deletes mail.
    const I = loadEngine({
      whitelist: ["ok@example.com", "bank.com OR is:starred", 'x" OR label:trash']
    });
    const q = I.applyGlobalGuards("category:promotions");
    expect(q).toContain("-from:ok@example.com");
    // Assert on the ENTRIES, not on tokens: `-is:starred` is a guard
    // this query is supposed to carry, so "does it contain is:starred"
    // would pass for the wrong reason and fail for the wrong reason.
    expect(q).not.toContain("bank.com");
    expect(q).not.toContain("label:trash");
    expect(q).not.toContain(" OR ");
  });

  test("sanitizeConfig drops the bad ones on the way in", () => {
    const cfg = I_sanitize({ whitelist: ["ok@example.com", "bank.com OR is:starred"] });
    expect(cfg.whitelist).toContain("ok@example.com");
    expect(cfg.whitelist).not.toContain("bank.com OR is:starred");
  });

  test("the shapes a real address takes are all accepted", () => {
    const I = loadEngine();
    for (const good of ["a@b.com", "user+tag@domain.co.uk", "first.last@sub.domain.org", "example.com"]) {
      expect(I.isValidWhitelistEntry(good)).toBe(true);
    }
    for (const bad of ['x" OR y', "a OR b", "is:starred", "label:trash", "a{b}", ""]) {
      expect(I.isValidWhitelistEntry(bad)).toBe(false);
    }
  });
});

function I_sanitize(config) {
  const I = loadEngine();
  return I.sanitizeConfig(config);
}

// =====================================================================
// 3. Safe Mode's other half
// =====================================================================

describe("Safe Mode strips the risky rules, not only the risky subjects", () => {
  // stripRisky is the half of Safe Mode that removes category:updates and
  // category:forums -- the "and forums" in the switch's own hint. Making
  // it an identity function left the whole suite green, while the subject
  // shield beside it has been pinned since 8.12.

  test("the safe rule set contains no updates or forums rule", async () => {
    const I = loadEngine({ safeMode: true, intensity: "deep" });
    const rules = await I.getRules("deep");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => /category:(forums|updates)/i.test(r))).toBe(false);
  });

  test("and with Safe Mode off those rules are exactly what you get", async () => {
    // The control. Without it, a stripRisky that removed EVERYTHING
    // would satisfy the test above.
    const I = loadEngine({ safeMode: false, intensity: "deep" });
    const rules = await I.getRules("deep");
    expect(rules.some((r) => /category:(forums|updates)/i.test(r))).toBe(true);
  });

  test("Safe Mode does not simply empty the rule set", async () => {
    const safe = await loadEngine({ safeMode: true, intensity: "deep" }).getRules("deep");
    const open = await loadEngine({ safeMode: false, intensity: "deep" }).getRules("deep");
    expect(safe.length).toBeGreaterThan(0);
    expect(safe.length).toBeLessThan(open.length);
  });
});

// =====================================================================
// 4. The restore finder's exclusions
// =====================================================================

describe("the restore finder ignores controls inside mail", () => {
  // restoreCandidates filters out anything inside a list row or a message
  // body before scoring, because both carry sender-controlled text. The
  // deny-list on the same block was pinned; these two exclusions were
  // not, so a lookalike control planted by a sender was reachable.

  test("a Move to Inbox lookalike inside a list row is not a candidate", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <table role="grid">
          <tr role="row"><td>
            <div role="button" aria-label="Move to Inbox">Move to Inbox</div>
          </td></tr>
        </table>
      </div>`;

    const found = I.restoreCandidates(document);
    expect(found.some((el) => el.getAttribute("aria-label") === "Move to Inbox")).toBe(false);
  });

  test("nor one inside a message body", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div class="a3s">
          <div role="button" aria-label="Move to Inbox">Move to Inbox</div>
        </div>
      </div>`;

    const found = I.restoreCandidates(document);
    expect(found.some((el) => el.getAttribute("aria-label") === "Move to Inbox")).toBe(false);
  });

  test("but the real toolbar control still is", () => {
    // The control, so an exclusion that swallowed everything cannot pass
    // the two tests above.
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div gh="mtb">
          <div role="button" aria-label="Move to Inbox">Move to Inbox</div>
        </div>
      </div>`;

    const found = I.restoreCandidates(document);
    expect(found.some((el) => el.getAttribute("aria-label") === "Move to Inbox")).toBe(true);
  });
});

// =====================================================================
// 5. Two guards on the pages, pinned on firing rather than on wording
// =====================================================================

describe("the Options whitelist guard tells the user about a bad line", () => {
  // The only test touching this asserted that the STRING "Invalid
  // whitelist entry at line" appears in validateData, and that no
  // blocking.push follows it within 200 characters. Neither says the
  // guard fires.
  //
  // It WARNS rather than blocks, on purpose: the comment beside it says
  // refusing the whole save would strand the valid entries too. So the
  // property to pin is not "it blocks" -- pinning that would have been a
  // wrong fix -- but that an invalid line makes the result invalid and
  // is reported, and that the check reads the RAW lines. That last part
  // is the 8.11 fix: walking the already-normalized list meant this
  // branch could never run at all, so "Settings saved successfully!"
  // appeared over a protection list missing the entry the user pasted.
  const fn = OPTIONS_SRC.slice(
    OPTIONS_SRC.indexOf("const validateData = (data) => {"),
    OPTIONS_SRC.indexOf("return { valid: errors.length === 0, errors, blocking };")
  );

  test("the check exists and is bounded", () => {
    expect(fn.length).toBeGreaterThan(500);
  });

  test("an invalid line is reported and makes the result invalid", () => {
    const at = fn.indexOf("Invalid whitelist entry at line");
    expect(at).toBeGreaterThan(-1);
    // errors, not blocking. Both are real lists in this function, and
    // which one a message lands on is the whole difference between "we
    // saved what we could and here is what we dropped" and "we saved
    // nothing".
    expect(fn.slice(Math.max(0, at - 200), at + 200)).toContain("errors.push");
    expect(OPTIONS_SRC).toContain("return { valid: errors.length === 0, errors, blocking };");
  });

  test("it reads the raw textarea lines, not the normalized list", () => {
    // normalizeWhitelist drops exactly the entries this loop looks for,
    // so reading `data.whitelist` makes the branch unreachable.
    const at = fn.indexOf("Invalid whitelist entry at line");
    const block = fn.slice(Math.max(0, at - 300), at);
    expect(block).toContain('readLines("whitelist")');
    expect(block).not.toContain("data.whitelist");
  });

  test("and the entry test is the shared one, not a second copy", () => {
    expect(fn).toContain("isValidWhitelistEntry(entry)");
  });
});

describe("Auto-Pilot's apply stage refuses for the same reasons its scan does", () => {
  // In runAutoPilotSweep the licence, snooze and hasActiveRun refusals are
  // all covered. In startAutoPilotApply -- the stage that actually injects
  // the engine and archives mail -- the licence/enabled gate and the
  // busy-tab half were not, so both were deletable with a green suite.
  const fn = BG_SRC.slice(
    BG_SRC.indexOf("async function startAutoPilotApply()"),
    BG_SRC.indexOf("async function resolveAutoPilotDone")
  );

  test("the stage exists and is bounded", () => {
    expect(fn.length).toBeGreaterThan(500);
  });

  test("it re-checks the licence and the switch, and stands down if either moved", () => {
    // A sweep armed while Pro was valid must not archive mail after the
    // licence expired or the user turned Auto-Pilot off mid-sweep.
    expect(fn).toContain("hasProLicense()");
    const gate = fn.indexOf("hasProLicense()");
    const inject = fn.indexOf('files: ["contentScript.js"]');
    expect(inject).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(inject);
    expect(fn).toContain("setAutoPilotState({ pending: null })");
  });

  test("it refuses while another run holds the marker", () => {
    const claim = fn.indexOf("claimRun");
    const inject = fn.indexOf('files: ["contentScript.js"]');
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(inject);
  });

  test("and it will not attach a second engine to a busy tab", () => {
    const busy = fn.indexOf("isEngineAttached");
    const inject = fn.indexOf('files: ["contentScript.js"]');
    expect(busy).toBeGreaterThan(-1);
    expect(busy).toBeLessThan(inject);
  });

  test("it uses the tab it measured, never a freshly picked active one", () => {
    // Retargeting is the defect 8.11 fixed; pinned here too because this
    // is the stage that moves mail.
    expect(fn).toContain("await getAutoPilotMeasuredTab(pending)");
    expect(fn).not.toContain("await findGmailTabForAutoPilot();");
  });
});
