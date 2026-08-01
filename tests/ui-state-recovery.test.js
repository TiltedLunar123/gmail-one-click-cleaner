/**
 * @jest-environment node
 *
 * Pins four UI-side regressions found in the 7.14.2 sweep:
 *
 *  - diagnostics.js read `stats.archiveInsteadOfDelete`, a field the
 *    engine has never written. It records `action: "archive" | "delete"`,
 *    so every archive run was reported as a deletion, red tag and all.
 *  - options.js captured the button label for its "Saved!" flash while
 *    the button still read "Saving...", then wrote that back when the
 *    flash expired, leaving the label permanently wrong.
 *  - progress.js reset the auto-reconnect counter on a successful ping
 *    without advancing lastMessageTime, so the tick refired forever and
 *    could never reach its own max-attempts stop.
 *  - popup.js never persisted the scoped configs its Storage X-ray purge
 *    and Smart apply runs build, so a progress-tab reconnect re-injected
 *    the previous full cleanup instead.
 *
 * Source pins; these fail against the previous implementations.
 */
const fs = require("fs");
const path = require("path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf-8");

const grab = (src, re, label) => {
  const m = src.match(re);
  if (!m) throw new Error(`${label} not found; test needs an update`);
  return m[0];
};

describe("diagnostics.js: archive runs are not reported as deletions", () => {
  const src = read("diagnostics.js");

  test("reads the action the engine actually records", () => {
    expect(src).toMatch(/const\s+wasArchiveRun\s*=\s*\(stats\)\s*=>\s*stats\?\.action\s*===\s*"archive";/);
  });

  test("no longer reads a field the engine never writes", () => {
    expect(src).not.toMatch(/stats\.archiveInsteadOfDelete/);
  });

  test("all three renderers go through it", () => {
    for (const fn of ["getActionWord", "getModeLabel", "getTagClass"]) {
      const block = grab(src, new RegExp(`const\\s+${fn}\\s*=\\s*\\(stats\\)\\s*=>\\s*\\{[\\s\\S]*?\\n\\s\\s\\};`), fn);
      expect(block).toMatch(/wasArchiveRun\(stats\)/);
    }
  });

  test("agrees with stats.js, which was already right", () => {
    expect(read("stats.js")).toMatch(/entry\.action\s*===\s*"archive"/);
  });
});

describe("diagnostics.js: scan leaves no button stuck loading", () => {
  const src = read("diagnostics.js");
  const scan = grab(
    src,
    /const\s+scanTabs\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\n\s\s\};/,
    "scanTabs"
  );

  test("clears both buttons in finally", () => {
    const fin = scan.slice(scan.lastIndexOf("} finally {"));
    expect(fin).toMatch(/setButtonLoading\(elements\.scanTabsBtn,\s*false\)/);
    expect(fin).toMatch(/setButtonLoading\(elements\.testInjectBtn,\s*false\)/);
  });

  test("does not rely on the happy path to re-enable Test Inject", () => {
    const beforeCatch = scan.slice(0, scan.indexOf("} catch ("));
    expect(beforeCatch).not.toMatch(/setButtonLoading\(elements\.testInjectBtn,\s*false\)/);
  });
});

describe("options.js: the save button returns to its real label", () => {
  const src = read("options.js");
  const success = grab(
    src,
    /const\s+showButtonSuccess\s*=\s*\(btn\)\s*=>\s*\{[\s\S]*?\n\s\s\};/,
    "showButtonSuccess"
  );

  test("prefers the label stashed by setButtonLoading", () => {
    expect(success).toMatch(/btn\.dataset\.originalText\s*\n?\s*\|\|\s*\(labelNode\s*\?\s*labelNode\.textContent\s*:\s*btn\.textContent\)/);
  });

  test("does not capture the live label first", () => {
    expect(success).not.toMatch(
      /const\s+originalText\s*=\s*labelNode\s*\?\s*labelNode\.textContent\s*:\s*btn\.textContent;/
    );
  });

  test("setButtonLoading still stashes it, so the fallback has a source", () => {
    const loading = grab(
      src,
      /const\s+setButtonLoading\s*=\s*\(btn,\s*loading,\s*loadingText\)\s*=>\s*\{[\s\S]*?\n\s\s\};/,
      "setButtonLoading"
    );
    expect(loading).toMatch(/btn\.dataset\.originalText\s*=/);
  });
});

describe("progress.js: auto-reconnect cannot loop forever", () => {
  const tick = grab(
    read("progress.js"),
    /const\s+autoReconnectTick\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\n\s\s\};/,
    "autoReconnectTick"
  );
  const okBranch = tick.slice(tick.indexOf("if (response?.ok)"), tick.indexOf("} catch {"));

  test("counts a successful ping as activity", () => {
    expect(okBranch).toMatch(/state\.lastMessageTime\s*=\s*Date\.now\(\);/);
  });

  test("stops polling once the engine reports it is idle", () => {
    expect(okBranch).toMatch(/response\.phase\s*===\s*"idle"/);
    expect(okBranch).toMatch(/stopAutoReconnect\(\);/);
  });

  test("still resets the attempt counter for a genuinely running engine", () => {
    expect(okBranch).toMatch(/state\.autoReconnectAttempts\s*=\s*0;/);
    expect(okBranch).toMatch(/setStatusLoading\("Reconnected, waiting for progress…"\)/);
  });

  test("the engine really can answer idle, so the branch is reachable", () => {
    expect(read("contentScript.js")).toMatch(/phase:\s*RUNNING\s*\?\s*"running"\s*:\s*"idle"/);
  });
});

describe("popup.js: scoped runs persist their own config", () => {
  const src = read("popup.js");

  // 7.15 moved both persists BELOW the duplicate-run guard: a refused run
  // used to leave its sender-scoped config behind as the thing a later
  // progress reconnect would run.
  test("the storage purge stores the sender-scoped config", () => {
    const purge = src.slice(src.indexOf("config.rulesOverride = purgeQueries;"));
    const head = purge.slice(0, purge.indexOf('files: ["contentScript.js"]'));
    expect(head).toMatch(/await\s+persistLastConfig\(config\);/);
  });

  test("the smart apply stores its rule and action override", () => {
    const smart = src.slice(src.indexOf("config.archiveInsteadOfDelete = Boolean(archive);"));
    const head = smart.slice(0, smart.indexOf('files: ["contentScript.js"]'));
    expect(head).toMatch(/await\s+persistLastConfig\(config\);/);
  });

  test("neither persist runs before the already-attached guard", () => {
    for (const anchor of ["config.rulesOverride = purgeQueries;", "config.archiveInsteadOfDelete = Boolean(archive);"]) {
      const from = src.indexOf(anchor);
      const persistAt = src.indexOf("await persistLastConfig(config);", from);
      const guardAt = src.indexOf("if (await isEngineAttached(gmailTab.id))", from);
      expect(guardAt).toBeGreaterThan(from);
      expect(persistAt).toBeGreaterThan(guardAt);
    }
  });

  test("each persist happens before the engine is injected", () => {
    for (const anchor of ["config.rulesOverride = purgeQueries;", "config.archiveInsteadOfDelete = Boolean(archive);"]) {
      const from = src.indexOf(anchor);
      const persistAt = src.indexOf("await persistLastConfig(config);", from);
      const injectAt = src.indexOf('files: ["contentScript.js"]', from);
      expect(persistAt).toBeGreaterThan(from);
      expect(persistAt).toBeLessThan(injectAt);
    }
  });

  test("progress.js is the consumer that made this matter", () => {
    expect(read("progress.js")).toMatch(/const\s+cfg\s*=\s*await\s+getLastConfig\(\);/);
  });
});
