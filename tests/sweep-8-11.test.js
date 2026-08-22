/**
 * @jest-environment jsdom
 *
 * The 8.11 sweep.
 *
 * Every assertion here was run against the 8.10.0 source before the fix
 * landed. The ones that are deliberate invariant pins (they pass either
 * way, and exist so the invariant cannot be removed later) say so on the
 * assertion. Everything else FAILED on 8.10.0.
 *
 * The theme of the release is the paid half of the product: five of the
 * eight findings are on controls only a buyer can reach, and three of
 * those are the same defect this project keeps finding, which is a
 * control that acts on less than it was handed without saying so.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const POPUP_SRC = read("popup.js");
const POPUP_HTML = read("popup.html");
const SHARED_SRC = read("shared.js");
const BG_SRC = read("background.js");
const ENGINE_SRC = read("contentScript.js");
const OPTIONS_SRC = read("options.js");
const OPTIONS_HTML = read("options.html");
const CHANGELOG_HTML = read("changelog.html");

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

/** The engine IIFE in the current jsdom window. */
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

/** Source of one function, so a pin cannot match an identical line elsewhere. */
function fnBody(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// =========================================================================

describe("bulk apply says what it dropped (Pro)", () => {
  // Bulk apply is the paid half of Smart Suggestions. Every card got a
  // checkbox, including unsubscribe cards, and unsubscribe cards cannot
  // be part of a cleanup rule, so smartBulkPlan skipped them with a bare
  // `continue` that incremented nothing. Tick three unsubscribe cards
  // and two archive cards, press Apply selected, and the run took two
  // while the popup said nothing at all about the other three: the
  // deferred counter that drives the "check the rest" toast only counts
  // senders whose action differs from the LEAD, and the unsubscribe ones
  // were gone before the lead was chosen.
  const S = loadShared().smart;

  const sender = (email, action) => ({
    email,
    action,
    score: 50,
    estCount: 100,
    signals: { count: 100, unreadRatio: 0.9, oldShare: 0.2 }
  });

  test("unsubscribe senders are counted, not silently dropped", () => {
    const plan = S.bulkPlan([
      sender("a@news.com", "unsubscribe"),
      sender("b@news.com", "unsubscribe"),
      sender("c@shop.com", "archiveAll"),
      sender("d@shop.com", "archiveAll")
    ]);

    expect(plan.emails).toEqual(["c@shop.com", "d@shop.com"]);
    expect(plan.action).toBe("archiveAll");
    // The two that cannot ride a cleanup rule.
    expect(plan.deferredUnsub).toBe(2);
    // And they are NOT folded into `deferred`, whose toast tells the
    // user to press the same button again. Pressing it again would
    // never pick these up.
    expect(plan.deferred).toBe(0);
  });

  test("a selection of nothing but unsubscribe cards still reports them", () => {
    const plan = S.bulkPlan([
      sender("a@news.com", "unsubscribe"),
      sender("b@news.com", "unsubscribe")
    ]);
    expect(plan.rules).toEqual([]);
    expect(plan.deferredUnsub).toBe(2);
  });

  test("the two deferred reasons stay separate when both apply", () => {
    const many = [];
    for (let i = 0; i < 3; i++) many.push(sender(`u${i}@news.com`, "unsubscribe"));
    many.push(sender("lead@shop.com", "archiveAll"));
    many.push(sender("other@shop.com", "deleteOld"));

    const plan = S.bulkPlan(many);
    expect(plan.action).toBe("archiveAll");
    expect(plan.deferredUnsub).toBe(3);
    // The deleteOld card is the ordinary "wrong group" case.
    expect(plan.deferred).toBe(1);
  });

  test("an unsubscribe card is not offered a bulk checkbox at all", () => {
    // 8.10's rule for the report, applied here: showing a row is not the
    // same as offering to act on it. Select all already skips disabled
    // boxes, so this closes the path rather than only reporting it.
    const card = fnBody(POPUP_SRC, "const buildSmartCard = (sender, { withCheckbox }) => {", "const renderSmartList");
    expect(card).toContain('if (cardAction === "unsubscribe") {');
    expect(card).toContain("checkbox.disabled = true;");
  });

  test("the handler names the remedy, which is a different button", () => {
    const handler = fnBody(POPUP_SRC, "const handleSmartBulkApply = async () => {", "const handleSmartDismiss");
    expect(handler).toContain("plan.deferredUnsub > 0");
    expect(handler).toContain("bulkSkippedUnsub");
    // And the all-unsubscribe selection stops saying "no valid senders",
    // which described a selection that was entirely valid.
    expect(handler).toContain("bulkUnsubOnly");
  });
});

describe("the storage purge says when it took only the first 25 (Pro)", () => {
  // sanitizeEmails stops at MAX_PURGE_PER_RUN. The list above the button
  // holds up to MAX_LIST ranked senders and carries a Select all, so
  // "tick everything, press Purge" was the ordinary way to use the
  // feature and it abandoned everything past 25 in silence. The
  // Unsubscribe tab, one tab over, has warned about its identical cap
  // since 7.0.
  const X = loadShared().storageXray;

  test("the cap is real and the two limits still disagree by design", () => {
    // Invariant pin: passes either way. It is here because the toast
    // below is only worth having while MAX_LIST exceeds the per-run cap.
    expect(X.LIMITS.MAX_LIST).toBeGreaterThan(X.LIMITS.MAX_PURGE_PER_RUN);
  });

  test("more selected than the cap comes back shorter", () => {
    const picked = [];
    for (let i = 0; i < 40; i++) picked.push(`s${i}@shop.com`);
    expect(X.sanitizeEmails(picked)).toHaveLength(X.LIMITS.MAX_PURGE_PER_RUN);
  });

  test("the handler compares the two and says so", () => {
    const handler = fnBody(POPUP_SRC, "const handleXrayPurge = async () => {", "// =========================");
    expect(handler).toContain("targeted.length < emails.length");
    expect(handler).toContain("xrayPurgeCapped");
  });
});

describe("the two paid lists remember what was ticked", () => {
  // 8.0 gave the Unsubscribe list a remembered selection, reasoning that
  // the licence check runs before the checkboxes are read and then sends
  // the user to checkout. The same is true of the X-ray and Smart lists,
  // and neither got it. It is worse there than on the tab that has it,
  // because both cap one run at 25 out of a list of up to 100, so the
  // supported workflow is "run, come back, tick the rest" and coming
  // back showed nothing ticked.
  test("both lists have a storage key of their own", () => {
    expect(POPUP_SRC).toContain('XRAY_CHECKED: "xrayCheckedEmails"');
    expect(POPUP_SRC).toContain('SMART_CHECKED: "smartCheckedEmails"');
  });

  test("both persist on tick and on select all", () => {
    expect(POPUP_SRC).toContain("const persistXraySelection = () => {");
    expect(POPUP_SRC).toContain("const persistSmartSelection = () => {");
    const wiring = fnBody(POPUP_SRC, "elements.xraySelectAll?.addEventListener", "elements.subsEnterKey");
    expect(wiring).toContain("persistXraySelection();");
    const smartWiring = fnBody(POPUP_SRC, "elements.smartSelectAll?.addEventListener", "// 7.12 Auto-Pilot");
    expect(smartWiring).toContain("persistSmartSelection();");
  });

  test("both restore before their list renders", () => {
    expect(POPUP_SRC).toContain("state.xray.checked.has(sender.email)");
    expect(POPUP_SRC).toContain("state.smart.checked.has(sender.email)");
    // Awaited together with the subs loader: a set that lands after the
    // render paints an empty selection and never re-renders on its own.
    expect(POPUP_SRC).toContain(
      "await Promise.all([loadSubsSelection(), loadXraySelection(), loadSmartSelection()]);"
    );
  });

  test("a run takes what it acted on OFF the remembered selection", () => {
    // Found reviewing this release's own diff, and it is the release's
    // own defect class produced by two of its own fixes meeting. The cap
    // toast says "run again for the rest"; remembering the ticks
    // restores all forty in the same estMb order; the cap then takes the
    // same first twenty-five. "The rest" would never run. An applied
    // suggestion is not dismissed and a purged row is deliberately still
    // checkable (purge is repeatable), so neither list drops the row on
    // its own.
    expect(POPUP_SRC).toContain("const forgetXrayChecked = (emails) => {");
    expect(POPUP_SRC).toContain("const forgetSmartChecked = (emails) => {");
    const purge = fnBody(POPUP_SRC, "const handleXrayPurge = async () => {", "// =========================");
    expect(purge).toContain("if (!config.dryRun) forgetXrayChecked(targeted);");
    const apply = fnBody(POPUP_SRC, "const startSmartApplyRun = async (emails, queries, archive) => {", "const handleSmartDismiss");
    expect(apply).toContain("if (!config.dryRun) forgetSmartChecked(emails);");
  });

  test("and a dry run keeps the whole selection, having taken nothing", () => {
    // Every call site is guarded, not just the one the test above reads:
    // a preview moves no mail, so forgetting the ticks after one would
    // lose the user's triage for nothing.
    // The declarations are `const forgetXrayChecked = (emails) =>`, so
    // they do not match a call-shaped `name(` and need no subtracting.
    const calls = (POPUP_SRC.match(/forget(Xray|Smart)Checked\(/g) || []).length;
    const guarded = (POPUP_SRC.match(/if \(!config\.dryRun\) forget(Xray|Smart)Checked\(/g) || []).length;
    expect(guarded).toBe(2);
    expect(calls).toBe(guarded);
  });

  test("the remaining set is computed from the live ticks, not the loaded snapshot", () => {
    // state.xray.checked is only read at render time; the checkboxes are
    // the truth once the user has touched them.
    const fn = fnBody(POPUP_SRC, "const forgetXrayChecked = (emails) => {", "const loadXraySelection");
    expect(fn).toContain("getCheckedXrayEmails().filter");
    const smart = fnBody(POPUP_SRC, "const forgetSmartChecked = (emails) => {", "const loadSmartSelection");
    expect(smart).toContain("getCheckedSmartEmails().filter");
  });

  test("the remembered addresses stay out of sync storage", () => {
    // These are real sender addresses and storage.sync replicates to the
    // user's Google account. Same reasoning as the 7.15 lastRunStats fix.
    const persist = fnBody(POPUP_SRC, "const persistXraySelection = () => {", "const loadXraySelection");
    expect(persist).toContain('storageSet("local"');
    expect(persist).not.toContain("safeSyncSet");
    const persistSmart = fnBody(POPUP_SRC, "const persistSmartSelection = () => {", "const loadSmartSelection");
    expect(persistSmart).toContain('storageSet("local"');
    expect(persistSmart).not.toContain("safeSyncSet");
  });
});

describe("the result screen stops describing runs that did not happen", () => {
  // A dry run moves nothing. This view said "Cleanup Complete!",
  // "Cleaned N emails", "(all moved to Trash)" over a note promising
  // Gmail's 30-day Trash window, and a toast offering the recovery log
  // for a run that never touched anything. progress.js has said "emails
  // matched, nothing was moved" since 8.9; the popup is the screen the
  // preview exists to produce and it was the one that lied.
  // 8.16 moved this pin: showResultSummary grew a `stoppedShort` argument,
  // so the exact-signature match broke on an addition that changed nothing
  // about what it was guarding. Pinned structurally now, which is what this
  // repo learned to do the last three times a literal pin moved: the fact
  // being protected is that the dry flag is a named argument with a false
  // default, not the current column count of the parameter list.
  test("showResultSummary takes the dry flag", () => {
    expect(POPUP_SRC).toMatch(
      /const showResultSummary = \(\{[^}]*\bdryRun = false\b[^}]*\} = \{\}\) => \{/
    );
  });

  test("and rewrites the title, the lead and both notes", () => {
    const fn = fnBody(POPUP_SRC, "const showResultSummary = ({", "const hideResultSummary");
    expect(fn).toContain("resultTitleDry");
    expect(fn).toContain("resultLeadDry");
    expect(fn).toContain("resultDryNote");
    expect(fn).toContain("resultNoteDry");
    // A dry run has no storage figure either.
    expect(fn).toContain("archived || dryRun");
  });

  test("an archive run stops promising a Trash window it never used", () => {
    // 8.9 split the freed-MB clause out for archive runs and rewrote the
    // parenthetical, and left the safety note underneath describing
    // Trash. Archived mail never goes there, so there is no 30-day
    // deadline and restore is by label with none at all.
    const fn = fnBody(POPUP_SRC, "const showResultSummary = ({", "const hideResultSummary");
    expect(fn).toContain("resultNoteArchive");
  });

  test("the status line and the toast beside it learned about dry runs too", () => {
    // Fixing only the summary left the screen self-contradicting: "Dry
    // run finished, nothing was moved" over a status reading cleanup
    // complete and a toast offering the recovery log to undo it.
    expect(POPUP_SRC).toContain('const wasDry = stats?.mode === "dry";');
    expect(POPUP_SRC).toContain("dryRunCompleteStatus");
    expect(POPUP_SRC).toContain("dryRunCompleteToast");
  });

  test("the done handler passes the flag it already had in hand", () => {
    // stats.mode was already being read two lines below, for the rating
    // gate, which is what makes this a miss rather than missing data.
    //
    // 8.16 moved this pin for the same reason as the signature above: the
    // call gained a `stoppedShort` argument and became multi-line. Matched
    // on the argument rather than the whole call.
    expect(POPUP_SRC).toMatch(/dryRun:\s*stats\?\.mode === "dry"/);
  });

  test("the notes are reachable by id, not by inline-style guesswork", () => {
    expect(POPUP_HTML).toContain('id="resultActionNote"');
    expect(POPUP_HTML).toContain('id="resultSafetyNote"');
    const fn = fnBody(POPUP_SRC, "const showResultSummary = ({", "const hideResultSummary");
    expect(fn).not.toContain('querySelector("span[style]")');
  });

  test("and the four are actually in the elements map", () => {
    // Writing the rewrite without registering the elements is how this
    // fix nearly shipped dead: every branch is written `if (elements.x)`,
    // so an unregistered name is not an error, it is a silent no-op.
    for (const name of ["resultTitle", "resultLead", "resultActionNote", "resultSafetyNote"]) {
      expect(POPUP_SRC).toMatch(new RegExp(`${name}: \\$\\("`));
    }
  });
});

describe("every element the popup reaches for is one it registered", () => {
  // popup-structure.test.js pins a hand-written list of ids, which by
  // construction cannot catch a name that was never added to it. Both
  // checks below are derived from the source instead.
  //
  // The second one is the one that matters, and it is the check that
  // caught the four above: every branch in this file is written
  // `if (elements.x)`, so a name that is not in the map is not an error.
  // It is a feature that silently does nothing, which is how the 8.9
  // "not measured" state shipped dead for a whole release.
  const mapBody = fnBody(POPUP_SRC, "const elements = {", "\n  };");

  const mapKeys = new Set();
  {
    const re = /^\s{4}(\w+):/gm;
    let m;
    while ((m = re.exec(mapBody)) !== null) mapKeys.add(m[1]);
  }

  test("the map is the size we think it is", () => {
    expect(mapKeys.size).toBeGreaterThan(150);
  });

  test("no $() lookup resolves to an id the markup does not have", () => {
    const ids = new Set();
    const re = /\$\("([A-Za-z][\w-]*)"\)/g;
    let m;
    while ((m = re.exec(POPUP_SRC)) !== null) ids.add(m[1]);
    expect(ids.size).toBeGreaterThan(100);
    expect([...ids].filter((id) => !POPUP_HTML.includes(`id="${id}"`))).toEqual([]);
  });

  test("no elements.x reference names something the map never defined", () => {
    const used = new Set();
    const re = /\belements\.(\w+)/g;
    let m;
    while ((m = re.exec(POPUP_SRC)) !== null) used.add(m[1]);
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter((name) => !mapKeys.has(name)).sort()).toEqual([]);
  });
});

describe("Safe Mode's subject shield is no longer cancelled by any other exclusion", () => {
  // The skip condition was `!/-subject:\(/i`, so ANY subject exclusion
  // anywhere in the rule dropped the whole receipt/invoice/order/
  // shipping/tracking/refund list, while Safe Mode went on reading ON.
  // Gmail ANDs repeated -subject:() clauses, which is exactly what the
  // protected-keyword shield twenty lines below has always relied on.
  const RULE = "category:promotions -subject:(unsubscribe) older_than:3m";

  test("a rule with its own subject exclusion still gets the shield", () => {
    const I = loadEngine({
      safeMode: true,
      guardSkipStarred: false,
      guardSkipImportant: false,
      guardSkipUnread: false,
      guardSkipUserLabels: false
    });
    const out = I.applyGlobalGuards(RULE);
    expect(out).toContain("-subject:(unsubscribe)");
    expect(out).toContain("receipt");
    expect(out).toContain("invoice");
    expect(out).toContain("tracking");
  });

  test("and the shield is not stacked twice on a rule that already carries it", () => {
    const I = loadEngine({
      safeMode: true,
      guardSkipStarred: false,
      guardSkipImportant: false,
      guardSkipUnread: false,
      guardSkipUserLabels: false
    });
    const once = I.applyGlobalGuards("category:promotions older_than:3m");
    const twice = I.applyGlobalGuards(once);
    expect(twice).toBe(once);
  });

  test("Safe Mode off still appends nothing", () => {
    // Invariant pin: passes either way, and the change above is only
    // safe because it stays inside the CONFIG.safeMode branch.
    const I = loadEngine({
      safeMode: false,
      guardSkipStarred: false,
      guardSkipImportant: false,
      guardSkipUnread: false,
      guardSkipUserLabels: false
    });
    expect(I.applyGlobalGuards(RULE)).toBe(RULE);
  });
});

describe("Auto-Pilot sweeps the mailbox it measured (Pro)", () => {
  // The scan pins the tab it measured and takes minutes. The apply then
  // called findGmailTabForAutoPilot() again, which prefers whichever
  // Gmail tab is ACTIVE, so a user signed in to two accounts only had to
  // look at the other one for an unattended archive sweep to run on
  // mailbox B against suggestions measured in mailbox A.
  test("the scan records which account it measured", () => {
    expect(BG_SRC).toContain("acct: gmailAccountOf(gmailTab.url)");
    expect(BG_SRC).toContain("function gmailAccountOf(url)");
  });

  test("the apply resolves the pinned tab and never re-picks an active one", () => {
    const fn = fnBody(BG_SRC, "async function startAutoPilotApply() {", "async function resolveAutoPilotDone");
    expect(fn).toContain("await getAutoPilotMeasuredTab(pending)");
    expect(fn).not.toContain("await findGmailTabForAutoPilot();");
  });

  test("a tab that moved to another account is refused, not retargeted", () => {
    const fn = fnBody(BG_SRC, "async function getAutoPilotMeasuredTab(pending)", "async function runAutoPilot");
    expect(fn).toContain("gmailAccountOf(tab.url) !== pending.acct");
    // No fallback to some other Gmail tab: retargeting is the defect.
    // Anchored on the CALL, not the name, so prose in a comment cannot
    // satisfy or break it.
    expect(fn).not.toContain("await chrome.tabs.query(");
  });

  test("and the tab has to still be the mail UI, not Chat on the same host", () => {
    // mail.google.com also serves /chat/, which the tab query matches and
    // which gmailAccountOf reads no account out of, so a host-only test
    // would let a Chat tab pass as "the mailbox we measured".
    //
    // 8.21: this used to pin the regex LITERAL inside this one function,
    // and 8.21 found the same test was missing from the two functions that
    // CHOOSE the tab. Moving the check into a shared isMailboxTab broke
    // this pin without breaking the guard, which is the wrong way round.
    // Pinned as behaviour now, on the helper every caller shares.
    const fn = fnBody(BG_SRC, "async function getAutoPilotMeasuredTab(pending)", "async function runAutoPilot");
    expect(fn).toContain("isMailboxTab(tab?.url)");

    const decl = fnBody(BG_SRC, "const isMailboxTab =", ";") + ";";
    const isMailboxTab = new Function(`${decl}\nreturn isMailboxTab;`)();
    expect(isMailboxTab("https://mail.google.com/mail/u/0/#inbox")).toBe(true);
    expect(isMailboxTab("https://mail.google.com/mail/u/2/#search/x")).toBe(true);
    expect(isMailboxTab("https://mail.google.com/chat/u/0/#chat/home")).toBe(false);
    expect(isMailboxTab("https://mail.google.com/")).toBe(false);
    expect(isMailboxTab("")).toBe(false);
    expect(isMailboxTab(undefined)).toBe(false);
  });

  test("a pending row written before 8.11 is not stranded by the new check", () => {
    const fn = fnBody(BG_SRC, "async function getAutoPilotMeasuredTab(pending)", "async function runAutoPilot");
    expect(fn).toContain("pending?.acct !== undefined");
  });
});

describe("closing the Gmail tab no longer wedges Auto-Pilot (Pro)", () => {
  // tabs.onRemoved cleared ACTIVE_RUN, and the scan stage never takes an
  // ACTIVE_RUN claim. So closing the tab mid-sweep killed the engine
  // without any terminal message, `pending` stayed armed for its whole
  // two-hour TTL, and every weekly alarm in that window logged "previous
  // sweep still pending, skipping" while the popup reported a sweep
  // running right now.
  test("the listener clears a pending stage belonging to the closed tab", () => {
    const fn = fnBody(BG_SRC, "chrome.tabs.onRemoved.addListener", "// =========================");
    expect(fn).toContain("Number(apState.pending.tabId) === tabId");
    expect(fn).toContain("setAutoPilotState({ pending: null })");
  });

  test("and only that tab's", () => {
    const fn = fnBody(BG_SRC, "chrome.tabs.onRemoved.addListener", "// =========================");
    expect(fn).toContain("apState?.pending &&");
  });
});

describe("the Auto-Pilot state writers hold the lock they need", () => {
  // 8.10's lesson, on the half of the pair it did not reach: locking the
  // WRITE is not locking. setAutoPilotState is an unlocked
  // get-merge-set, and resolveAutoPilotDone holds the chain for its
  // whole get-merge-set of the same key, so a toggle or a confirm
  // landing beside a finishing sweep merged into a pre-resolve snapshot
  // and put the stale lastRun or preview back.
  test("the disable path clears pending inside the lock", () => {
    const fn = fnBody(BG_SRC, "async function setAutoPilotEnabled(enabled) {", "async function confirmAutoPilot");
    const lockAt = fn.indexOf("await withStorageLock(async () => {");
    const clearAt = fn.indexOf("setAutoPilotState({ pending: null })");
    const closeAt = fn.indexOf("});", clearAt);
    expect(lockAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(lockAt);
    expect(closeAt).toBeGreaterThan(clearAt);
  });

  test("the confirm path clears the preview inside the lock", () => {
    const fn = fnBody(BG_SRC, "async function confirmAutoPilot() {", "// Completion notification");
    const lockAt = fn.indexOf("await withStorageLock(async () => {");
    const clearAt = fn.indexOf("setAutoPilotState({ preview: null })");
    expect(lockAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(lockAt);
  });

  test("setAutoPilotState still does not take the lock itself", () => {
    // Invariant pin, and the reason the two above cannot deadlock:
    // withStorageLock is a plain queue and is NOT re-entrant, so calling
    // a locked function from inside a held lock hangs the worker.
    const fn = fnBody(BG_SRC, "async function setAutoPilotState(patch)", "async function restoreAutoPilotAlarm");
    expect(fn).not.toContain("withStorageLock");
  });
});

describe("the Options page tells a buyer what they actually bought", () => {
  // "Bulk unsubscribe is unlocked" was the whole truth in 7.0. 7.2, 7.8,
  // 7.12 and 8.0 each added a paid pillar without touching that
  // sentence, so someone who had just paid $9.99 was told they had
  // bought one fifth of it.
  const GCC = loadShared();

  // 8.12 added Pro Settings as the sixth entry. The count is pinned
  // rather than left open on purpose: the whole point of this list is
  // that a pillar cannot be added without the sentence a buyer reads
  // changing with it, and an open-ended length would let the next one
  // through silently.
  test("the shared list is the single answer, and covers every pillar", () => {
    expect(Array.isArray(GCC.license.FEATURES)).toBe(true);
    expect(GCC.license.FEATURES).toHaveLength(6);
    const joined = GCC.license.FEATURES.join(" ").toLowerCase();
    for (const pillar of [
      "unsubscribe",
      "x-ray",
      "smart suggestions",
      "report",
      "auto-pilot",
      "pro settings"
    ]) {
      expect(joined).toContain(pillar);
    }
  });

  test("the status line no longer names one feature", () => {
    expect(OPTIONS_SRC).not.toContain("Bulk unsubscribe is unlocked.");
    expect(OPTIONS_SRC).toContain("GCC.license.FEATURES.length} paid features are unlocked");
  });

  test("the activation toast no longer names one feature", () => {
    expect(OPTIONS_SRC).not.toContain("Enjoy bulk unsubscribe!");
  });

  test("the list renders from the shared source, not a second copy", () => {
    expect(OPTIONS_HTML).toContain('id="proUnlocked"');
    const fn = fnBody(OPTIONS_SRC, "const renderUnlockedList = (active) => {", "const renderState = async () => {");
    expect(fn).toContain("for (const feature of GCC.license.FEATURES)");
  });

  test("the section blurb lists the report step it had been missing", () => {
    const section = OPTIONS_HTML.slice(OPTIONS_HTML.indexOf('id="pro"'));
    // 8.16 widened the window and the claim. A 1,500-character slice is a
    // budget in disguise: this went red because the fix above it added a
    // comment, not because the copy regressed. And while it was only
    // checking one feature name, the same sentence was still selling the
    // Storage X-ray LIST, which has been free since 8.13, and omitting Pro
    // Settings, which has been paid since 8.12. Every paid pillar is pinned
    // now, so the blurb cannot drift again in either direction.
    // Whitespace flattened, per the rule this repo keeps relearning: a
    // phrase pin against raw HTML is really a pin on where the author
    // happened to wrap the line. Comments stripped for the other rule this
    // repo keeps relearning: a pin that prose can satisfy is not a pin, and
    // this one went red on the explanatory comment of its own fix.
    const blurb = section.slice(0, 3000)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\s+/g, " ");
    for (const feature of [
      "bulk unsubscribe", "Storage X-ray", "Smart Suggestions",
      "Mailbox Report", "Auto-Pilot", "Pro Settings"
    ]) {
      expect(blurb).toContain(feature);
    }
    // The list is free; the purge under it is what is bought.
    expect(blurb).toContain("purging from the Storage X-ray");
    expect(blurb).not.toContain("the full Storage X-ray");
  });
});

describe("a paying user stops being sold to", () => {
  // Two separate ways the popup went on pitching Pro at somebody who had
  // already paid, which is the complaint that started this release.
  test("the key-paste strip is hidden the moment the licence verifies", () => {
    // init does not await refreshLicenseUi, because it verifies an ECDSA
    // signature and is slower than everything around it, so
    // maybeShowActivateHint read licenseActive while it was still false
    // and showed a buyer "Bought Pro? Paste your key to unlock it here."
    // on the browser that already had the key. Hiding it from the
    // licence path makes the result the same whichever finishes last.
    const fn = fnBody(POPUP_SRC, "const refreshLicenseUi = async () => {", "// 7.12: locked Pro controls");
    expect(fn).toContain("if (active && elements.activateHint) elements.activateHint.hidden = true;");
  });

  test("the storage upsell can be hidden again, not only shown", () => {
    // It was written `if (... && !active) hidden = false` with no other
    // branch, so activating a key with the Storage tab open left the
    // pitch on screen under a list that had just unlocked.
    expect(POPUP_SRC).toContain(
      "if (elements.xrayUpsell) elements.xrayUpsell.hidden = !(hasSenders && !active);"
    );
  });
});

describe("the Auto-Pilot scan measures what the popup's buttons apply", () => {
  // The eleventh instance of this project's recurring defect, and the
  // one that reaches furthest: the scan's numbers are not private to
  // Auto-Pilot. recordSmartScan writes them into the smartScan store the
  // popup's cards read and OVERWRITES what the user's own scan measured.
  // 8.6 taught the popup's scan to send the user's switches and said so
  // in a comment that describes this bug exactly; the worker's twin was
  // never updated. Behavioural coverage is in background-autopilot.
  test("the worker has its own buildScanGuards and the scan spreads it", () => {
    expect(BG_SRC).toContain("async function readUserScanGuards()");
    const fn = fnBody(BG_SRC, "const scanConfig = {", "await chrome.scripting.executeScript(");
    expect(fn).toContain("...(await readUserScanGuards())");
  });

  test("a missing snapshot reads as guards ON, never OFF", () => {
    // sanitizeConfig reads a MISSING guard as ON. Boolean() over an
    // absent key would have silently turned all four off for anyone
    // whose stored snapshot predates the key, which is the opposite of
    // the bug and worse than it.
    const fn = fnBody(BG_SRC, "async function readUserScanGuards()", "// Which signed-in account");
    expect(fn).toContain("ui?.guardSkipUnread !== false");
    expect(fn).toContain("ui?.guardSkipStarred !== false");
    expect(fn).toContain("ui?.guardSkipImportant !== false");
    expect(fn).toContain("ui?.guardSkipUserLabels !== false");
  });

  test("every scan in the product now sends the user's guards", () => {
    // Invariant pin, and the point of the whole finding: 8.2 established
    // that a scan sending nothing is counted as though all four guards
    // are set, so a new scan that forgets them measures a mailbox the
    // user does not have.
    const popupScans = POPUP_SRC.match(/runKind: "(reportScan|storageScan|smartScan)"/g) || [];
    expect(popupScans.length).toBe(3);
    expect((POPUP_SRC.match(/\.\.\.\(await buildScanGuards\(\)\)/g) || []).length).toBe(3);
  });
});

describe("a preview stops being counted as a cleanup", () => {
  // recordStats had no dryRun conditional at all. deleted/archived/
  // freedMb survived only because the engine sends 0 for those on a
  // preview, but perQuery[].count carries the PROJECTION, so the
  // lifetime category chart on the Stats page counted mail a dry run
  // merely found. Previewing before a big sweep is the workflow the
  // feature exists for, and it permanently inflated the numbers.
  test("the aggregates are gated on the flag the engine already sends", () => {
    const fn = fnBody(BG_SRC, "async function recordStats(data) {", "async function getStats()");
    expect(fn).toContain("const isDryRun = Boolean(data.dryRun);");
    expect(fn).toContain("if (!isDryRun) {");
    const gated = fn.slice(fn.indexOf("if (!isDryRun) {"));
    for (const line of [
      "stats.totalRuns++;",
      "stats.categoryBreakdown[cat].count += q.count || 0;",
      "stats.dailyStats[today].runs++;"
    ]) {
      expect(gated).toContain(line);
    }
  });

  test("the engine still sends the flag this depends on", () => {
    // Invariant pin: the gate is only as good as the field.
    expect(ENGINE_SRC).toContain("dryRun: CONFIG.dryRun,");
  });

  test("the run history still records previews, because it labels them", () => {
    const fn = fnBody(BG_SRC, "async function recordStats(data) {", "async function getStats()");
    const historyAt = fn.indexOf("stats.history.unshift({");
    const gateEnd = fn.indexOf("// Run history");
    expect(historyAt).toBeGreaterThan(gateEnd);
    expect(fn).toContain("dryRun: data.dryRun || false,");
  });
});

describe("a whitelist entry the extension will not store is not reported as saved", () => {
  // validateData walked data.whitelist, which collectAllData has already
  // run through normalizeWhitelist, and normalizeWhitelist drops exactly
  // the entries the loop looks for. The branch could never fire. So a
  // pasted `Mom <mom@gmail.com>` produced "Settings saved successfully!"
  // over a list that did not contain it, and the next cleanup deleted
  // that sender's mail.
  test("the check reads the raw lines, not the normalized list", () => {
    const fn = fnBody(OPTIONS_SRC, "// Validate whitelist entries", "return { valid: errors.length === 0");
    expect(fn).toContain('readLines("whitelist").forEach');
    expect(fn).not.toContain("(data?.whitelist || []).forEach");
  });

  test("it warns rather than blocking, so the valid entries still save", () => {
    const fn = fnBody(OPTIONS_SRC, "// Validate whitelist entries", "return { valid: errors.length === 0");
    expect(fn).toContain("errors.push(");
    expect(fn).not.toContain("blocking.push(");
  });
});

describe("the popup stops claiming a sweep is running after it died", () => {
  test("the pending freshness test is shared, and the popup reader uses it", () => {
    expect(BG_SRC).toContain("const autoPilotPendingIsFresh = (pending) =>");
    const fn = fnBody(BG_SRC, "async function getAutoPilotForPopup() {", "// The READ has to be inside the lock");
    expect(fn).toContain("autoPilotPendingIsFresh(state.pending) ? state.pending.stage : null");
  });
});

describe("the release notes page hides what it marks hidden", () => {
  // .index is display:flex, which beats the UA [hidden] rule at equal
  // importance, so the jump bar rendered as an empty "Jump to" strip
  // before its script ran and again whenever the log was too short to
  // index. popup.html has carried this guard since 7.3 for exactly this.
  test("the guard is present", () => {
    expect(CHANGELOG_HTML).toContain("[hidden] { display: none !important; }");
  });

  test("and the element that needed it is still the flex one", () => {
    // Invariant pin: keeps the guard from being deleted as unused.
    expect(CHANGELOG_HTML).toMatch(/\.index\s*\{[^}]*display:\s*flex/);
    expect(CHANGELOG_HTML).toContain('id="releaseIndex"');
  });
});
