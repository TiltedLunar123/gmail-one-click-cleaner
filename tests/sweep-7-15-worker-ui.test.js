/**
 * @jest-environment node
 *
 * Regression net for the 7.15 service-worker, popup and options fixes.
 * Every test here fails against 7.14.2 source.
 */
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf-8");
const background = read("background.js");
const popup = read("popup.js");
const options = read("options.js");
const shared = read("shared.js");

/** Match a block, or "" when the source has no such function. */
const grab = (text, re) => {
  const m = text.match(re);
  return m ? m[0] : "";
};

/** Load the real shared library so the validator can be exercised. */
const buildShared = () => {
  // eslint-disable-next-line no-new-func
  return new Function(`${shared}; return GCC;`)();
};

const runScheduled = grab(
  background,
  /async\s+function\s+runScheduledCleanup\(scheduleId\)[\s\S]*?\n\s\s\}/
);

describe("7.15: scheduled cleanups honour the Global Whitelist", () => {
  // The injected config read `schedule.whitelist`, a field the Options
  // page hard-codes to [] and no control ever fills in, so Never Delete
  // applied to every run EXCEPT the unattended one.
  test("reads the whitelist from sync alongside the protected keywords", () => {
    expect(runScheduled).toMatch(/STORAGE_KEYS\.WHITELIST/);
    expect(runScheduled).toMatch(/const\s+globalWhitelist\s*=\s*Array\.isArray\(result\?\.\[STORAGE_KEYS\.WHITELIST\]\)/);
  });

  test("merges any per-schedule entries with the global list", () => {
    expect(runScheduled).toMatch(
      /const\s+whitelist\s*=\s*\[\.\.\.new\s+Set\(\[\.\.\.globalWhitelist,\s*\.\.\.scheduleWhitelist\]\)\]/
    );
  });

  test("the injected config no longer takes the schedule field alone", () => {
    expect(runScheduled).toMatch(/^\s*whitelist,$/m);
    expect(runScheduled).not.toMatch(/whitelist:\s*schedule\.whitelist\s*\|\|\s*\[\]/);
  });

  test("the Options page really does create schedules with an empty list", () => {
    // If this ever stops being true the fix is still correct, but the
    // reason it was needed has changed.
    expect(options).toMatch(/whitelist:\s*\[\],/);
  });
});

describe("7.15: overdue schedules do not all fire in one tick", () => {
  const restore = grab(background, /async\s+function\s+restoreScheduledAlarms\(\)[\s\S]*?\n\s\s\}/);

  test("catch-up fires are staggered", () => {
    expect(restore).toMatch(/CATCH_UP_STAGGER_MS/);
    expect(restore).toMatch(/overdueSlot\s*\*\s*CATCH_UP_STAGGER_MS/);
    expect(restore).toMatch(/if\s*\(nextDue\s*<=\s*now\)\s*overdueSlot\s*\+=\s*1;/);
  });

  test("a schedule that is not overdue keeps its own anchor", () => {
    expect(restore).toMatch(/when:\s*nextDue\s*>\s*now\s*\?\s*nextDue\s*:\s*catchUpAt/);
  });
});

describe("7.15: saving a schedule cannot rewind its lastRun anchor", () => {
  const save = grab(background, /async\s+function\s+saveSchedule\(schedule\)[\s\S]*?\n\s\s\}/);

  test("keeps the stored lastRun when the caller sends an older one", () => {
    expect(save).toMatch(/const\s+storedLastRun\s*=\s*Number\(schedules\[idx\]\?\.lastRun\)\s*\|\|\s*0;/);
    expect(save).toMatch(/incomingLastRun\s*>=\s*storedLastRun\s*\?\s*schedule\.lastRun\s*:\s*schedules\[idx\]\.lastRun/);
    expect(save).not.toMatch(/schedules\[idx\]\s*=\s*schedule;/);
  });
});

describe("7.15: a done message with no run id only clears its own tab", () => {
  const helper = grab(background, /async\s+function\s+releaseRunClaimForTab\(tabId\)[\s\S]*?\n\s\s\}/);

  test("compares the held claim's Gmail tab before clearing", () => {
    expect(helper).toMatch(/if\s*\(held\s*&&\s*held\.gmailTabId\s*!==\s*tabId\)\s*return;/);
  });

  test("ignores a message that carries no tab at all", () => {
    expect(helper).toMatch(/if\s*\(typeof\s+tabId\s*!==\s*"number"\)\s*return;/);
  });
});

describe("7.15: Auto-Pilot only advances on its own scan", () => {
  const handler = grab(
    background,
    /async\s+function\s+handleAutoPilotProgress\(msg,\s*senderTabId\)[\s\S]*?\n\s\s\}/
  );

  test("the pending scan records the tab it is waiting on", () => {
    expect(background).toMatch(/pending:\s*\{\s*stage:\s*"scan",\s*startedAt:\s*Date\.now\(\),\s*tabId:\s*gmailTab\.id/);
  });

  test("and, since 8.7, the run id it injected", () => {
    // A tab id survives navigation, so an Auto-Pilot scan whose engine
    // died when the tab moved left the stage armed for its whole TTL,
    // and the user's own next Smart scan in that tab satisfied it: a
    // live unattended archive sweep over up to 25 senders, unasked.
    // 8.11 put `acct` between the two, so this pins that one pending row
    // carries the tab AND the run id rather than pinning them adjacent.
    expect(background).toMatch(
      /pending:\s*\{[^}]*tabId:\s*gmailTab\.id[^}]*runId:\s*scanRunId[^}]*\}/
    );
    expect(background).toContain("runId: scanRunId");
    expect(background).toContain('if (pending.runId && String(msg.runId || "") !== String(pending.runId))');
  });

  test("a terminal message from another tab is ignored, not consumed", () => {
    expect(handler).toMatch(/pending\.tabId\s*!==\s*senderTabId/);
    const guardAt = handler.indexOf("pending.tabId !== senderTabId");
    const returnAt = handler.indexOf("return;", guardAt);
    // Ignoring must not clear pending: the real sweep still has to report.
    expect(handler.slice(guardAt, returnAt)).not.toMatch(/setAutoPilotState/);
  });

  test("pre-7.15 state with no tabId still works", () => {
    expect(handler).toMatch(/typeof\s+pending\.tabId\s*===\s*"number"/);
  });

  test("the router passes the sending tab through", () => {
    expect(background).toMatch(/handleAutoPilotProgress\(msg,\s*progressTabId\)/);
    expect(background).toMatch(/const\s+progressTabId\s*=\s*sender\.tab\?\.id;/);
  });
});

describe("7.15: the Auto-Pilot apply stage re-checks the guards", () => {
  const apply = grab(background, /async\s+function\s+startAutoPilotApply\(\)[\s\S]*?\n\s\s\}/);

  test("vacation mode switched on during the scan stops the sweep", () => {
    expect(apply).toMatch(/if\s*\(await\s+getSnoozeUntil\(\)\)/);
  });

  test("the install-source guard is re-checked too", () => {
    expect(apply).toMatch(/if\s*\(await\s+isUntrustedInstall\(\)\)/);
  });

  test("both run before any mail is touched", () => {
    const snoozeAt = apply.indexOf("await getSnoozeUntil()");
    const injectAt = apply.indexOf('files: ["contentScript.js"]');
    expect(snoozeAt).toBeGreaterThan(-1);
    expect(injectAt).toBeGreaterThan(snoozeAt);
  });
});

describe("7.15: the unsubscribe merge cannot grow without bound", () => {
  const record = grab(background, /async\s+function\s+recordUnsubscribeResults\(results\)[\s\S]*?\n\s\s\}/);

  test("caps the merged sender list like a fresh scan does", () => {
    expect(record).toMatch(/SUBSCRIPTION_SENDER_CAP/);
    expect(record).toMatch(/scan\.senders\.length\s*>\s*SUBSCRIPTION_SENDER_CAP/);
  });

  test("both writers share one bound", () => {
    expect(background).toMatch(/const\s+SUBSCRIPTION_SENDER_CAP\s*=\s*200;/);
    expect(background).toMatch(/senders\.slice\(0,\s*SUBSCRIPTION_SENDER_CAP\)/);
  });
});

describe("7.15: autosave cannot rewrite a live run's config", () => {
  const autosave = grab(popup, /const\s+scheduleAutosave\s*=\s*\(\)\s*=>[\s\S]*?\n\s\s\};/);

  test("skips the config write while a run holds the marker", () => {
    expect(autosave).toMatch(/if\s*\(await\s+getActiveRun\(\)\)\s*\{/);
    const guardAt = autosave.indexOf("if (await getActiveRun())");
    const persistAt = autosave.indexOf("await persistLastConfig(cfg)");
    expect(persistAt).toBeGreaterThan(guardAt);
  });

  test("still saves the UI snapshot so the form is remembered", () => {
    expect(autosave).toMatch(/STORAGE_KEYS\.LAST_UI\]:\s*captureUiSnapshot\(\)/);
  });

  test("progress.js is the consumer this protects", () => {
    expect(read("progress.js")).toMatch(/const\s+cfg\s*=\s*await\s+getLastConfig\(\);/);
  });
});

describe("7.15: scoped runs keep the user's Minimum Age", () => {
  test("the storage purge no longer nulls it", () => {
    const purge = popup.slice(popup.indexOf("config.rulesOverride = [purgeQuery];"));
    const head = purge.slice(0, purge.indexOf('files: ["contentScript.js"]'));
    expect(head).not.toMatch(/config\.minAge\s*=\s*null;/);
  });

  test("the smart apply no longer nulls it", () => {
    // Sliced from rulesOverride, not from the action override: the null
    // used to sit between the two.
    const smart = popup.slice(popup.indexOf("config.rulesOverride = queries;"));
    const head = smart.slice(0, smart.indexOf('files: ["contentScript.js"]'));
    expect(head).toMatch(/config\.archiveInsteadOfDelete\s*=\s*Boolean\(archive\);/);
    expect(head).not.toMatch(/config\.minAge\s*=\s*null;/);
  });

  test('"Archive all" is the rule that has no age of its own', () => {
    expect(shared).toMatch(/action\s*===\s*"archiveAll"[\s\S]{0,140}query:\s*`from:\(\$\{email\}\)`/);
  });

  test("the engine only appends a floor that is stricter", () => {
    const engine = read("contentScript.js");
    expect(engine).toMatch(/ruleDays\s*===\s*null\s*\|\|\s*\(floorDays\s*!==\s*null\s*&&\s*floorDays\s*>\s*ruleDays\)/);
  });
});

describe("7.15: Restore defaults leaves the safety lists alone", () => {
  const restore = grab(options, /const\s+restoreDefaults\s*=\s*async\s*\(\)\s*=>[\s\S]*?\n\s\s\};/);

  test("keeps the current whitelist and protected keywords", () => {
    expect(restore).toMatch(/const\s+current\s*=\s*collectAllData\(\);/);
    expect(restore).toMatch(/whitelist:\s*current\.whitelist/);
    expect(restore).toMatch(/protectKeywords:\s*current\.protectKeywords/);
    expect(restore).not.toMatch(/whitelist:\s*\[\],\s*protectKeywords:\s*\[\]/);
  });

  test("the dialog only ever promised to replace rules", () => {
    expect(read("options.html")).toMatch(/replace all your custom rules with the original defaults/);
  });
});

describe("7.15: the Options page validates the intensity rule boxes", () => {
  const validate = grab(options, /const\s+validateData\s*=\s*\(data\)\s*=>[\s\S]*?\n\s\s\};/);

  test("every rule list goes through the shared query validator", () => {
    expect(validate).toMatch(/RULE_KEYS\.forEach/);
    expect(validate).toMatch(/GCC\.validateGmailQuery\(query\)/);
  });
});

describe("7.15: the shared validator matches the engine's anchoring", () => {
  test("a grouped protected token is refused by both", () => {
    const GCC = buildShared();
    for (const q of ["(is:starred) older_than:1y", "{is:starred is:unread} older_than:1y", "{in:sent}"]) {
      expect(`${q}:${GCC.validateGmailQuery(q).valid}`).toBe(`${q}:false`);
    }
  });

  test("ordinary and explicitly negated rules still pass", () => {
    const GCC = buildShared();
    expect(GCC.validateGmailQuery("category:promotions older_than:1y").valid).toBe(true);
    expect(GCC.validateGmailQuery("category:promotions -is:starred older_than:1y").valid).toBe(true);
  });
});

describe("7.15: Open progress does not hand back a finished dashboard", () => {
  const handler = grab(popup, /const\s+handleOpenProgress\s*=\s*async\s*\(\)\s*=>[\s\S]*?\n\s\s\};/);

  test("reloads a leftover tab for a run this popup did not start", () => {
    expect(handler).toMatch(/!state\.startedRunHere\s*&&\s*!\(await\s+tabsReload\(existing\.id\)\)/);
  });

  test("the flag is set by every path that injects from the popup", () => {
    expect((popup.match(/state\.startedRunHere\s*=\s*true;/g) || []).length).toBe(4);
    expect(popup).toMatch(/startedRunHere:\s*false,/);
  });
});
