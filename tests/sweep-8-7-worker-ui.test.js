/**
 * @jest-environment node
 *
 * Worker and page findings from the 8.7 sweep.
 *
 * Every assertion here was checked to FAIL against the 8.6.0 source.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const bgSrc = read("background.js");
const sharedSrc = read("shared.js");
const popupSrc = read("popup.js");
const popupHtml = read("popup.html");
const statsSrc = read("stats.js");

const LOCALES = ["en", "pt_BR", "es", "fr", "de", "ru", "ja"];
const catalog = (l) => JSON.parse(read(path.join("_locales", l, "messages.json")));

describe("the worker reads a licence the way the pages do", () => {
  // 8.6 taught the pages to stop at the first key that VERIFIES rather
  // than the first non-empty string, precisely because a stale value in
  // one storage area otherwise hides a good key in the other. The
  // worker's own copy, which is what gates Auto-Pilot, kept the old
  // shape: sync first, and local only if sync was EMPTY. A corrupt or
  // truncated key in sync therefore left the popup showing Pro active
  // while every weekly sweep quietly declined, on a schedule nobody was
  // watching.
  const fn = () => {
    const at = bgSrc.indexOf("async function hasProLicense() {");
    expect(at).toBeGreaterThan(-1);
    return bgSrc.slice(at, bgSrc.indexOf("\n  }", at));
  };

  test("it collects candidates from both areas", () => {
    expect(fn()).toContain("const candidates = [];");
    expect(fn()).toContain("candidates.push(v)");
  });

  test("it verifies each one and succeeds on the first that passes", () => {
    expect(fn()).toContain("for (const key of candidates) {");
    expect(fn()).toContain("if (await verifyProLicenseKey(key)) return true;");
  });

  test("the old short circuit is gone", () => {
    // `if (!key)` around the local read is the exact shape of the bug.
    expect(fn()).not.toMatch(/if \(!key\) \{[\s\S]*chrome\.storage\.local\.get/);
  });
});

describe("Protect refuses what it cannot protect", () => {
  // Top-sender rows are keyed `email || displayName` by the engine's row
  // sampler, so a sender Gmail rendered without an address arrives as
  // "acme newsletters". addToWhitelist stored any non-empty string, so
  // that went into storage.SYNC unchecked, replicated to the Google
  // account, and appeared in the Options whitelist -- while
  // sanitizeConfig dropped it at run time for containing a space. The
  // user clicked Protect, was told the sender was protected, and it was
  // not. A safety control that silently does nothing is worse than one
  // that says no.
  test("the worker validates the entry before storing it", () => {
    expect(bgSrc).toContain("function isValidWhitelistEntry(s) {");
    const fn = bgSrc.slice(
      bgSrc.indexOf("async function addToWhitelist(sender) {"),
      bgSrc.indexOf("\n  }", bgSrc.indexOf("async function addToWhitelist(sender) {"))
    );
    expect(fn).toContain("if (!isValidWhitelistEntry(s)) {");
    expect(fn).toContain('throw new Error("not an address or domain");');
  });

  test("it accepts the same three shapes the Options page does", () => {
    for (const re of ["WL_EMAIL", "WL_WILDCARD_EMAIL", "WL_DOMAIN"]) {
      expect(bgSrc).toContain(re);
    }
    expect(bgSrc).toContain('if (!trimmed || /\\s/.test(trimmed)) return false;');
  });

  test("the Stats page explains the refusal instead of showing a bare error", () => {
    expect(statsSrc).toContain('resp?.error === "not an address or domain"');
    expect(statsSrc).toContain("Open Options and add their address or domain");
  });
});

describe("an injection that produced no engine is noticed", () => {
  // Both unattended callers check isEngineAttached and then inject. A
  // scan started from the popup attaches without claiming ACTIVE_RUN, so
  // anything that lands in that window makes the content script's
  // duplicate guard swallow the injection. executeScript still resolves.
  // The caller then held a run claim for the full two-hour TTL against a
  // run that never started (refusing every manual run in the meantime),
  // advanced the schedule's lastRun as though the sweep had happened,
  // and left Auto-Pilot waiting on a scan nothing would report.
  test("there is one confirmation helper and it asks for the run id", () => {
    expect(bgSrc).toContain("async function confirmInjection(tabId, expectedRunId) {");
    expect(bgSrc).toContain("return probe.runId === expectedRunId;");
  });

  test("probeEngine carries the run id back", () => {
    const fn = bgSrc.slice(
      bgSrc.indexOf("async function probeEngine(tabId) {"),
      bgSrc.indexOf("\n  }", bgSrc.indexOf("async function probeEngine(tabId) {"))
    );
    expect(fn).toContain('runId: typeof resp.runId === "string" ? resp.runId : ""');
  });

  test("a swallowed scheduled run releases its claim and does not advance lastRun", () => {
    const at = bgSrc.indexOf("if (!(await confirmInjection(gmailTab.id, runId))) {");
    expect(at).toBeGreaterThan(-1);
    const block = bgSrc.slice(at, at + 500);
    expect(block).toContain("await releaseRunClaim(runId);");
    // lastRun is written after the guard, never before it.
    expect(bgSrc.indexOf("schedule.lastRun = Date.now();")).toBeGreaterThan(at);
  });

  test("all three injection sites confirm", () => {
    // scheduled cleanup, Auto-Pilot scan, Auto-Pilot apply.
    expect(bgSrc.split("await confirmInjection(").length - 1).toBe(3);
  });
});

describe("Auto-Pilot only advances on the scan it started", () => {
  // 7.15 gave the pending stage a tabId. A tab id survives navigation,
  // so an Auto-Pilot scan whose engine died when the tab moved left the
  // stage armed for its whole two-hour TTL, and the user's own next
  // Smart scan in that same tab satisfied it: a live unattended archive
  // sweep over up to 25 senders, unasked.
  test("the pending scan carries a run id, and the scan is injected with it", () => {
    expect(bgSrc).toContain("const scanRunId = `ap_scan_${Date.now()}`;");
    expect(bgSrc).toContain("runId: scanRunId");
  });

  test("a scan reporting a different run id is ignored, not consumed", () => {
    // Ignoring rather than clearing matters: the sweep Auto-Pilot really
    // did start must stay able to report in.
    expect(bgSrc).toContain('if (pending.runId && String(msg.runId || "") !== String(pending.runId))');
  });
});

describe("bulk apply honours each card's own action", () => {
  // The fifth instance of this project's recurring defect. Every card
  // leads with the action the scan measured and prints the count that
  // action will reach; the bulk button collapsed all of them into ONE
  // `from:(a OR b) older_than:6m` and ran it with archive:false. So an
  // "Archives 200 now" card had its mail sent to Trash (the destructive
  // direction), and a "Deletes 40 large emails now" card lost its own
  // larger:5M and took every old message from that sender instead.
  test("the planner groups by the resolved action", () => {
    expect(sharedSrc).toContain("const smartBulkPlan = (senders) => {");
    expect(sharedSrc).toContain("const action = smartResolvedAction(sender);");
    expect(sharedSrc).toContain('if (action === "unsubscribe") continue;');
  });

  test("each group gets the query shape its own cards promised", () => {
    const fn = sharedSrc.slice(
      sharedSrc.indexOf("const smartBulkPlan = (senders) => {"),
      sharedSrc.indexOf("// Bulk apply (Pro): one cleanup run")
    );
    expect(fn).toContain('if (lead === "purgeLarge") rule = `${group} larger:5M older_than:6m`;');
    expect(fn).toContain('else if (lead === "archiveAll") rule = group;');
    expect(fn).toContain("else rule = `${group} older_than:6m`;");
    expect(fn).toContain('archive: lead === "archiveAll"');
  });

  test("it still caps at MAX_BULK_PER_RUN and reports what it deferred", () => {
    const fn = sharedSrc.slice(
      sharedSrc.indexOf("const smartBulkPlan = (senders) => {"),
      sharedSrc.indexOf("// Bulk apply (Pro): one cleanup run")
    );
    expect(fn).toContain("if (chosen.length >= SMART_LIMITS.MAX_BULK_PER_RUN) { deferred++; continue; }");
    expect(fn).toContain("deferred");
    expect(popupSrc).toContain("if (plan.deferred > 0) {");
  });

  test("the run takes the plan's archive flag, not a hardcoded delete", () => {
    expect(popupSrc).toContain("startSmartApplyRun(targeted, plan.rules, plan.archive)");
  });
});

describe("the smart unsubscribe branch cannot latch the busy flag", () => {
  // Its two sibling handlers wrap the injection in try/catch and this
  // one did not. chrome.scripting.executeScript rejects on a tab that
  // closed or a permission that was revoked, and the flag it set then
  // stayed set for the life of the popup: every later scan, unsubscribe
  // and smart apply returned at the guard, in silence, under a status
  // line still reading "Unsubscribing...".
  test("it clears the flag on a throw", () => {
    const at = popupSrc.indexOf('state.subs.running = "unsubscribe";\r\n      setSmartStatus(');
    const alt = popupSrc.indexOf('state.subs.running = "unsubscribe";\n      setSmartStatus(');
    const from = at > -1 ? at : alt;
    expect(from).toBeGreaterThan(-1);
    const block = popupSrc.slice(from, from + 900);
    expect(block).toContain("try {");
    expect(block).toContain("} catch (err) {");
    expect(block).toContain("state.subs.running = null;");
  });
});

describe("a finished scan shows its own caveat", () => {
  // The engine has put its incompleteness warning in `detail` since the
  // scans shipped ("3 of 3 searches timed out, so this list is
  // incomplete"), and every done handler rendered `status` alone. The
  // running branch has always joined the two.
  test("there is one helper and all five done handlers use it", () => {
    expect(popupSrc).toContain("const doneLine = (status, detail) =>");
    expect(popupSrc.split("doneLine(status, detail)").length - 1).toBe(5);
  });

  test("the report persists how much of it completed", () => {
    expect(bgSrc).toContain("failedQueries: clampReportNumber(msg?.failedQueries)");
    expect(bgSrc).toContain("totalQueries: clampReportNumber(msg?.totalQueries)");
    expect(popupSrc).toContain("state.report.failedQueries = Number(stored.failedQueries) || 0;");
  });
});

describe("the storage x-ray admits its numbers are any-age", () => {
  // The tier searches carry no age term, so every row's MB and count
  // describe large mail of ANY age, while the control right underneath
  // defaults to six months. A sender whose big mail is all recent read
  // "at least 400 MB" over a button that cleared none of it.
  test("there is a note, and it follows the select", () => {
    expect(popupHtml).toContain('id="xrayAgeNote"');
    expect(popupSrc).toContain("const renderXrayAgeNote = () => {");
    expect(popupSrc).toContain('elements.xrayAge?.addEventListener("change", renderXrayAgeNote);');
  });

  test("it says nothing when the purge takes any age, because then they agree", () => {
    const fn = popupSrc.slice(
      popupSrc.indexOf("const renderXrayAgeNote = () => {"),
      popupSrc.indexOf("const renderXrayList = () => {")
    );
    expect(fn).toContain("const show = Boolean(age)");
  });
});

describe("the run history tag reads the mode, not a count", () => {
  test("the worker persists action", () => {
    expect(bgSrc).toContain('action: data.action === "archive" ? "archive" : "delete",');
  });

  test("stats reads it, and old entries keep the old inference", () => {
    expect(statsSrc).toContain("const recordedAction = run.action === \"archive\" || run.action === \"delete\"");
    expect(statsSrc).toContain('(run.archived ? "archive" : "delete")');
    expect(statsSrc).not.toContain("else if (run.archived) { tagClass");
  });
});

describe("the safety copy is true for the switches as they actually are", () => {
  // "unread mail is never touched" is an absolute claim about three
  // toggles the user can turn off two panels down.
  test("no locale still says never", () => {
    for (const l of LOCALES) {
      expect(catalog(l).runAssuranceSafety.message).toBeTruthy();
    }
    expect(catalog("en").runAssuranceSafety.message).toContain("While the safety switches are on");
    expect(catalog("en").runAssuranceSafety.message).not.toContain("never touched");
  });

  test("the inline fallback in the markup matches", () => {
    expect(popupHtml).toContain("While the safety switches are on, Starred, Important and unread mail are all skipped.");
    expect(popupHtml).not.toContain("unread mail is never touched");
  });

  test("every new key of this release exists in all seven catalogues", () => {
    const keys = [
      "bulkOneGroup", "planArchiveFirst", "planDeleteFirst", "planSubArchive",
      "reportPartialNote", "reportGuardsChangedNote", "reportSafeModeNote",
      "safeModeBlocksStep", "xrayAgeNoteText"
    ];
    for (const l of LOCALES) {
      const c = catalog(l);
      for (const k of keys) {
        expect(typeof c[k]?.message).toBe("string");
        expect(c[k].message.length).toBeGreaterThan(0);
      }
    }
  });
});
