/**
 * @jest-environment node
 *
 * Pins the ACTIVE_RUN claim lifecycle in the service worker.
 *
 * The claim is written to storage.session first and storage.local second,
 * and the session write is allowed to fail silently. Three places got the
 * two-store read wrong:
 *
 *  - tabs.onRemoved used `session.get(...) || local.get(...)`, but
 *    session.get resolves to `{}` when the key is absent, and `{}` is
 *    truthy, so local was never consulted and a local-only claim survived
 *    the tab that owned it.
 *  - releaseRunClaim only compared against local, so a session-only claim
 *    was never released even though hasActiveRun() reads session first.
 *  - gmailCleanerDone cleared the marker outright instead of comparing
 *    runIds, so a finishing run could erase a claim a newer run had
 *    already taken.
 *
 * Plus: a scheduled retry that claimed and then failed before injection
 * left that claim behind on every early return in the next attempt.
 *
 * Source pins; these fail against the previous implementation.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");

const grab = (re, label) => {
  const m = src.match(re);
  if (!m) throw new Error(`background.js ${label} not found; test needs an update`);
  return m[0];
};

const onRemoved = grab(
  /chrome\.tabs\.onRemoved\.addListener\(async \(tabId\) => \{[\s\S]*?\n\s\s\}\);/,
  "tabs.onRemoved listener"
);
const release = grab(
  /async\s+function\s+releaseRunClaim\s*\(runId\)\s*\{[\s\S]*?\n\s\s\}/,
  "releaseRunClaim"
);
const scheduled = grab(
  /async\s+function\s+runScheduledCleanup\s*\(scheduleId\)\s*\{[\s\S]*?\n\s\s\}/,
  "runScheduledCleanup"
);
const doneCase = grab(
  /case "gmailCleanerDone":[\s\S]*?\n\s{8}break;/,
  "gmailCleanerDone case"
);

describe("background.js: tab-close claim cleanup", () => {
  test("reads session and local independently instead of short-circuiting", () => {
    expect(onRemoved).toMatch(/const\s+sess\s*=\s*await\s+chrome\.storage\.session\?\.get\?\.\(/);
    expect(onRemoved).toMatch(/const\s+local\s*=\s*await\s+chrome\.storage\.local\.get\(/);
    expect(onRemoved).toMatch(
      /sess\?\.\[STORAGE_KEYS\.ACTIVE_RUN\]\s*\|\|\s*local\?\.\[STORAGE_KEYS\.ACTIVE_RUN\]/
    );
  });

  test("no longer ORs the two get() calls together", () => {
    expect(onRemoved).not.toMatch(
      /chrome\.storage\.session\?\.get\?\.\(STORAGE_KEYS\.ACTIVE_RUN\)\s*\n?\s*\|\|\s*await\s+chrome\.storage\.local\.get/
    );
  });

  test("still only clears a claim belonging to the closed tab", () => {
    expect(onRemoved).toMatch(/run\.gmailTabId\s*===\s*tabId/);
  });
});

describe("background.js: releaseRunClaim", () => {
  test("looks in both stores before deciding the claim is not ours", () => {
    expect(release).toMatch(/chrome\.storage\.session\?\.get\?\.\(STORAGE_KEYS\.ACTIVE_RUN\)/);
    expect(release).toMatch(/chrome\.storage\.local\.get\(STORAGE_KEYS\.ACTIVE_RUN\)/);
    expect(release).toMatch(/held\?\.runId\s*!==\s*runId/);
  });

  test("does not decide on local alone", () => {
    expect(release).not.toMatch(
      /const\s+r\s*=\s*await\s+chrome\.storage\.local\.get\(STORAGE_KEYS\.ACTIVE_RUN\);\s*\n\s*if\s*\(r\?\./
    );
  });

  test("keeps the no-id short circuit", () => {
    expect(release).toMatch(/if\s*\(!runId\)\s*return;/);
  });
});

describe("background.js: gmailCleanerDone", () => {
  test("compare-and-releases when the run carries an id", () => {
    expect(doneCase).toMatch(/if\s*\(msg\.summary\?\.runId\)/);
    expect(doneCase).toMatch(/releaseRunClaim\(msg\.summary\.runId\)/);
  });

  test("keeps the blanket clear only for runs with no id", () => {
    const elseBranch = doneCase.slice(doneCase.indexOf("} else {"));
    expect(elseBranch).toMatch(/chrome\.storage\.local\.set\(\{\s*\[STORAGE_KEYS\.ACTIVE_RUN\]:\s*null\s*\}\)/);
  });

  test("does not clear the marker unconditionally before the id check", () => {
    const head = doneCase.slice(0, doneCase.indexOf("if (msg.summary?.runId)"));
    expect(head).not.toMatch(/ACTIVE_RUN\]:\s*null/);
  });
});

describe("background.js: scheduled retry does not strand a claim", () => {
  test("hands back any claim from a previous attempt at the top of the loop", () => {
    expect(scheduled).toMatch(
      /for\s*\(let\s+attempt[\s\S]{0,600}if\s*\(claimedRunId\)\s*\{\s*\n\s*await\s+releaseRunClaim\(claimedRunId\);\s*\n\s*claimedRunId\s*=\s*null;/
    );
  });

  test("the release happens before the attempt can return early", () => {
    const loopStart = scheduled.indexOf("for (let attempt");
    const releaseAt = scheduled.indexOf("await releaseRunClaim(claimedRunId);", loopStart);
    const firstReturn = scheduled.indexOf("return;", loopStart);
    expect(releaseAt).toBeGreaterThan(loopStart);
    expect(releaseAt).toBeLessThan(firstReturn);
  });

  test("still releases after every attempt has failed", () => {
    expect(scheduled.trimEnd()).toMatch(/await\s+releaseRunClaim\(claimedRunId\);\s*\n\s\s\}$/);
  });
});

describe("background.js: whitelist suggestions stay bounded", () => {
  const record = grab(
    /async\s+function\s+recordSenderInteraction\s*\(data\)\s*\{[\s\S]*?\n\s\s\}/,
    "recordSenderInteraction"
  );

  test("has a cap constant", () => {
    expect(src).toMatch(/const\s+WHITELIST_SUGGESTIONS_MAX\s*=\s*\d+;/);
  });

  test("trims to the most recently seen senders once over the cap", () => {
    expect(record).toMatch(/keys\.length\s*>\s*WHITELIST_SUGGESTIONS_MAX/);
    expect(record).toMatch(/lastSeen\s*\|\|\s*0\)\s*-\s*\(interactions\[a\]\?\.lastSeen/);
    expect(record).toMatch(/\.slice\(0,\s*WHITELIST_SUGGESTIONS_MAX\)/);
  });
});
