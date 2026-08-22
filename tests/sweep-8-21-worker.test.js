/**
 * @jest-environment node
 *
 * 8.21, worker side. Three fixes, all of them about an unattended run:
 * the one kind of run with no page to look at and no user watching.
 *
 *   - which tab a schedule is allowed to pick (a Chat tab is not a mailbox)
 *   - what the completion notification says, which is the ONLY surface an
 *     unattended run ever reaches
 *   - the guard snapshot a Smart scan now records with its counts
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BG_SRC = fs.readFileSync(path.join(ROOT, "background.js"), "utf-8");
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, "contentScript.js"), "utf-8");

/** One function, bounded by the next. Both ends throw when missing. */
function fnBetween(src, startName, endName) {
  const start = src.indexOf(startName);
  if (start === -1) throw new Error(`not found: ${startName}`);
  const end = src.indexOf(endName, start + startName.length);
  if (end === -1) throw new Error(`end not found: ${endName}`);
  return src.slice(start, end);
}

/** Evaluate one declaration out of the worker, with no worker around it. */
function declOf(src, startName, endMarker = ";") {
  const start = src.indexOf(startName);
  if (start === -1) throw new Error(`not found: ${startName}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end not found for ${startName}`);
  return src.slice(start, end + endMarker.length);
}

// =====================================================================
// 1. A Chat tab is not a mailbox
// =====================================================================

describe("unattended runs only ever pick a mailbox tab", () => {
  // chrome.tabs.query("https://mail.google.com/*") matches Chat, and both
  // pickers prefer the ACTIVE tab -- which is the Chat tab if the user is
  // chatting. 8.11 worked this out and guarded getAutoPilotMeasuredTab
  // alone; the two functions that CHOOSE the tab kept the bare query.
  //
  // What followed was worse than picking wrong. The engine booted and
  // answered the ping, so the run was recorded as started and the
  // schedule stamped lastRun. Then openSearch navigated the tab to
  // /mail/u/0/, tearing away the conversation and killing the content
  // script mid-run. No terminal message was ever sent, so the run claim
  // was never released and every manual run was refused with "a cleanup
  // is already running" for the full two-hour TTL, while that week's
  // cleanup had touched nothing.
  const isMailboxTab = new Function(
    `${declOf(BG_SRC, "const isMailboxTab =")}\nreturn isMailboxTab;`
  )();

  test.each([
    ["https://mail.google.com/mail/u/0/#inbox", true],
    ["https://mail.google.com/mail/u/1/#search/x", true],
    ["https://mail.google.com/mail/h/", true],
    ["https://mail.google.com/chat/u/0/#chat/home", false],
    ["https://mail.google.com/chat/", false],
    ["https://mail.google.com/", false],
    ["", false],
    [null, false],
    [undefined, false]
  ])("%s -> %s", (url, expected) => {
    expect(isMailboxTab(url)).toBe(expected);
  });

  // Pinned as "every caller filters", not as "the regex is here". 8.21
  // moved the regex out of getAutoPilotMeasuredTab into the shared
  // helper, which broke the old literal pin without touching the guard.
  test.each([
    ["runScheduledCleanup", "async function runScheduledCleanup", "async function markScheduleRan"],
    ["findGmailTabForAutoPilot", "async function findGmailTabForAutoPilot", "// 8.11:"],
    ["listGmailTabs", "async function listGmailTabs", "function extractAccountFromUrl"]
  ])("%s filters its tab query through isMailboxTab", (_name, start, end) => {
    const fn = fnBetween(BG_SRC, start, end);
    expect(fn).toContain('chrome.tabs.query({ url: "https://mail.google.com/*" })');
    expect(fn).toContain("isMailboxTab(t.url)");
    // The filter has to come BEFORE the active-tab preference, or the
    // Chat tab is still the one chosen.
    const filter = fn.indexOf("isMailboxTab(t.url)");
    const pick = fn.indexOf("t.active");
    if (pick > -1) expect(filter).toBeLessThan(pick);
  });

  test("the measured-tab guard reads the same helper", () => {
    const fn = fnBetween(BG_SRC, "async function getAutoPilotMeasuredTab(pending)", "async function runAutoPilot");
    expect(fn).toContain("isMailboxTab(tab?.url)");
  });

  test("no mailbox tab is treated as no Gmail tab, so lastRun is not stamped", () => {
    // Stamping lastRun on a skipped schedule books the week's cleanup as
    // done when nothing ran.
    const fn = fnBetween(BG_SRC, "async function runScheduledCleanup", "async function markScheduleRan");
    const bail = fn.indexOf("No Gmail tab found for scheduled cleanup");
    const stamp = fn.indexOf("markScheduleRan");
    expect(bail).toBeGreaterThan(-1);
    if (stamp > -1) expect(bail).toBeLessThan(stamp);
    // And the bail is a return, not a fallthrough.
    expect(fn.slice(bail, bail + 200)).toContain("return;");
  });
});

// =====================================================================
// 2. The completion notification, which is the only surface a scheduled
//    run reaches
// =====================================================================

describe("the completion notification says what the run actually did", () => {
  // Driven, not pinned: maybeNotifyDone is pulled out of the worker and
  // run against a fake chrome, so the assertions are about the words a
  // user reads rather than about which branch exists in the source.
  const buildNotifier = () => {
    const created = [];
    const body = fnBetween(BG_SRC, "async function maybeNotifyDone", "async function recordStats");
    // bgT(key, fallback, subs) is the worker's i18n shim; the English
    // fallback is the shipped default and is what these assert on.
    const bgT = (_key, fallback, subs) => {
      let out = String(fallback);
      if (Array.isArray(subs)) subs.forEach((s, i) => { out = out.split(`$${i + 1}`).join(String(s)); });
      return out;
    };
    const chrome = {
      storage: { local: { get: async () => ({ notifyOnComplete: true }) } },
      // The real create takes a callback and the worker awaits it, so a
      // stub that forgets to call it hangs the test rather than failing.
      notifications: { create: (_id, opts, cb) => { created.push(opts); if (cb) cb(); } },
      runtime: { getURL: (p) => p, lastError: null }
    };
    const fn = new Function(
      "chrome", "bgT", "STORAGE_KEYS", "hasProLicense", "shouldPitchProInNotification", "console",
      `${body}\nreturn maybeNotifyDone;`
    )(
      chrome, bgT, { NOTIFY_ENABLED: "notifyOnComplete" },
      async () => true, // a Pro user, so the upsell line never appears
      async () => false,
      { warn() {}, error() {} }
    );
    return { fn, created };
  };

  const notify = async (summary) => {
    const { fn, created } = buildNotifier();
    await fn(summary);
    return created[0] || {};
  };

  test("a dry run is headlined as a preview, with the number it found", async () => {
    // `count` is totalDeleted, which a preview never increments, so every
    // dry run was titled "0 emails moved to Trash" over a body saying the
    // preview had finished. Auto-Pilot's first sweep is a preview by
    // design, so this was the first thing that feature ever said to a new
    // Pro user.
    const out = await notify({ count: 0, wouldCount: 1240, dryRun: true, action: "delete" });
    expect(out.title).toContain("preview found 1240 emails");
    // The old headline, in full. (Not `not.toContain("0 emails")`: the
    // figure 1240 ends in a zero, so that matches its own fix.)
    expect(out.title).not.toContain("Gmail Cleaner - 0 emails");
    expect(out.message).toContain("Dry run finished");
  });

  test("a preview that found one says one", async () => {
    const out = await notify({ count: 0, wouldCount: 1, dryRun: true, action: "delete" });
    expect(out.title).toContain("preview found 1 email");
  });

  test("a partly-refused run says so even though it cleaned plenty", async () => {
    // stoppedShort was appended whatever the run cleared; declined was
    // only ever mentioned when the run cleared NOTHING. So a weekly sweep
    // that refused two enormous rules and cleared 320 messages announced
    // "320 emails moved to Trash" and stopped there, with 60,000 messages
    // still sitting behind the two rules it skipped.
    const out = await notify({ count: 320, declined: 2, stoppedShort: 0, dryRun: false, action: "delete" });
    expect(out.title).toContain("320 emails");
    expect(out.message).toContain("2 rules were too large to run unattended");
  });

  test("one refused rule is singular", async () => {
    const out = await notify({ count: 320, declined: 1, dryRun: false, action: "delete" });
    expect(out.message).toContain("1 rule was too large to run unattended");
  });

  test("a run that was refused outright still gets the fuller sentence, once", async () => {
    // count === 0 keeps the 8.12 body, which says the same thing at more
    // length. Saying both would be saying it twice.
    const out = await notify({ count: 0, declined: 2, dryRun: false, action: "delete" });
    expect(out.title).toContain("nothing was cleaned");
    expect(out.message).toContain("too large to run without asking");
    expect(out.message).not.toContain("too large to run unattended");
  });

  test("a clean run says neither", async () => {
    const out = await notify({ count: 320, declined: 0, stoppedShort: 0, dryRun: false, action: "delete" });
    expect(out.message).not.toContain("too large");
    expect(out.message).not.toContain("stopped before");
  });

  test("the sibling fact it was modelled on still fires", async () => {
    const out = await notify({ count: 320, stoppedShort: 2, dryRun: false, action: "delete" });
    expect(out.message).toContain("2 rules stopped before they finished");
  });

  test("and both can be true at once", async () => {
    const out = await notify({ count: 320, declined: 1, stoppedShort: 1, dryRun: false, action: "delete" });
    expect(out.message).toContain("1 rule stopped before it finished");
    expect(out.message).toContain("1 rule was too large to run unattended");
  });
});

describe("the engine sends the preview figure it measured", () => {
  test("wouldCount rides on the done summary beside count", () => {
    const payload = fnBetween(ENGINE_SRC, 'type: "gmailCleanerDone"', "runId: CONFIG.runId");
    expect(payload).toContain("count: stats.totalDeleted || 0");
    expect(payload).toContain("wouldCount: stats.totalWouldDelete || 0");
  });
});
