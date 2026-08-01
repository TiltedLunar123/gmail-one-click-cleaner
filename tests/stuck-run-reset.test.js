/**
 * @jest-environment node
 *
 * Stuck-run escape hatch (8.4).
 *
 * Two independent flags can say "a run is happening" and until now
 * neither had any user-facing way to clear:
 *
 *   1. the stored ACTIVE_RUN claim, which expires after two hours
 *   2. window.GCC_ATTACHED in the Gmail tab, which expires NEVER; only
 *      a page reload or a clean engine exit ever cleared it
 *
 * An engine that dies without sending gmailCleanerDone strands both.
 * After that every run is refused with "a cleanup is already running",
 * pointing at nothing, and the only cure was reloading the Gmail tab,
 * which nothing in the UI ever said.
 *
 * The dangerous half of fixing that is clearing the flags out from
 * under a run that IS live, because the flags are the only thing
 * stopping a second engine from driving the same mailbox. So the
 * properties pinned here are, in order of how much they matter:
 *
 *   - a running engine is never cleared without an explicit second act
 *   - a running engine is always told to cancel BEFORE anything clears
 *   - a dead engine clears on the first try, both flags, no questions
 *   - failing to clear one flag never means silently keeping the other
 */

const fs = require("fs");
const path = require("path");

let storageBacking;
let INTERNALS;
let executed;
let sentMessages;
let reloads;

// Test hooks, reset per case. Plain variables rather than
// mockImplementationOnce, whose queue survives a failed expectation.
let pingAnswer;        // what gmailCleanerPing reports, or null for silence
let sendMessageThrows; // the tab has no receiving end at all
let executeScriptThrows;
let attachFlag;        // window.GCC_ATTACHED as it stands in the Gmail tab
let reloadThrows;
let tabGone;           // chrome.tabs.get rejects, i.e. the tab has closed

function makeStorageArea(area) {
  return {
    get: jest.fn(async (keys) => {
      if (typeof keys === "string") return { [keys]: storageBacking[area][keys] ?? undefined };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = storageBacking[area][k] ?? undefined;
        return out;
      }
      return { ...storageBacking[area] };
    }),
    set: jest.fn(async (obj) => { Object.assign(storageBacking[area], obj); })
  };
}

beforeAll(() => {
  storageBacking = { local: {}, sync: {}, session: {} };
  executed = [];
  sentMessages = [];
  reloads = [];

  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn().mockRejectedValue(new Error("no listener")),
      getURL: jest.fn((p) => `chrome-extension://test/${p}`),
      lastError: null
    },
    storage: {
      local: makeStorageArea("local"),
      sync: makeStorageArea("sync"),
      session: makeStorageArea("session")
    },
    alarms: {
      create: jest.fn(),
      clear: jest.fn(async () => true),
      getAll: jest.fn(async () => []),
      onAlarm: { addListener: jest.fn() }
    },
    tabs: {
      query: jest.fn(async () => [{ id: 7, active: true, url: "https://mail.google.com/mail/u/0/" }]),
      get: jest.fn(async (id) => {
        if (tabGone) throw new Error("No tab with id");
        return { id };
      }),
      onRemoved: { addListener: jest.fn() },
      reload: jest.fn(async () => {
        if (reloadThrows) throw new Error("tab gone");
        // A real reload takes the page away, which is exactly why it is
        // the answer for an engine that cannot be messaged.
        attachFlag = false;
        reloads.push(true);
      }),
      sendMessage: jest.fn(async (tabId, message) => {
        sentMessages.push({ tabId, type: message?.type });
        if (sendMessageThrows) throw new Error("Could not establish connection");
        if (message?.type === "gmailCleanerPing") {
          if (!pingAnswer) throw new Error("Could not establish connection");
          return pingAnswer;
        }
        return { ok: true };
      })
    },
    scripting: {
      // Models the real flag rather than answering null to everything:
      // the reset now READS it before deciding what to do, so a stub
      // that always says "not set" would exercise the wrong branch.
      executeScript: jest.fn(async (details) => {
        if (executeScriptThrows) throw new Error("tab gone");
        executed.push(details);
        const body = String(details.func);
        if (body.includes("GCC_ATTACHED = false")) {
          attachFlag = false;
          return [{ result: null }];
        }
        return [{ result: attachFlag }];
      })
    },
    management: { getSelf: jest.fn((cb) => cb({ installType: "normal" })) },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) }
  };

  globalThis.GCC_SW_TEST_MODE = true;
  const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");
  new Function(code)();
  INTERNALS = globalThis.GCC_SW_INTERNALS;
});

beforeEach(() => {
  storageBacking.local = {};
  storageBacking.sync = {};
  storageBacking.session = {};
  executed.length = 0;
  sentMessages.length = 0;
  pingAnswer = null;
  sendMessageThrows = false;
  executeScriptThrows = false;
  attachFlag = true;
  reloadThrows = false;
  tabGone = false;
  reloads.length = 0;
});

const claimRun = (over = {}) => {
  const run = { gmailTabId: 7, runId: "run_abc", startedAt: Date.now(), ...over };
  storageBacking.local.activeRun = run;
  storageBacking.session.activeRun = run;
  return run;
};

const claim = () => storageBacking.local.activeRun ?? null;
const sessionClaim = () => storageBacking.session.activeRun ?? null;
// Reads and writes of the flag are different acts and the reset now
// does both, so counting "mentions GCC_ATTACHED" would call a read a
// clear and pass tests that prove nothing.
const attachClears = () => executed.filter((d) => String(d.func).includes("GCC_ATTACHED = false"));
const typesSent = () => sentMessages.map((m) => m.type);

describe("probing the engine", () => {
  test("a tab with no receiving end reads as gone, not as busy", async () => {
    // The opposite of isEngineAttached, and deliberately so: that one
    // errs toward "busy" because refusing to START is the safe
    // direction. This one decides whether it is safe to CLEAR, where
    // an unanswerable tab is evidence there is nothing to protect.
    const probe = await INTERNALS.probeEngine(7);
    expect(probe).toEqual({ reachable: false, running: false });
  });

  test("an engine that answers idle is reachable but not running", async () => {
    pingAnswer = { ok: true, phase: "idle", version: "8.4.0" };
    const probe = await INTERNALS.probeEngine(7);
    expect(probe.reachable).toBe(true);
    expect(probe.running).toBe(false);
  });

  test("an engine that answers running says so", async () => {
    pingAnswer = { ok: true, phase: "running", version: "8.4.0" };
    const probe = await INTERNALS.probeEngine(7);
    expect(probe.running).toBe(true);
  });

  test("a malformed answer is not taken as proof of life", async () => {
    pingAnswer = { phase: "running" }; // no ok
    const probe = await INTERNALS.probeEngine(7);
    expect(probe).toEqual({ reachable: false, running: false });
  });

  test("no tab id means no probe at all", async () => {
    const probe = await INTERNALS.probeEngine(null);
    expect(probe).toEqual({ reachable: false, running: false });
    expect(sentMessages).toHaveLength(0);
  });
});

describe("resetting a run that is genuinely dead", () => {
  test("an idle-but-attached engine has its flag cleared, in place", async () => {
    // The ordinary case: the engine is still injected and still holding
    // GCC_ATTACHED, but its run is long over and it answers when asked.
    // Because it answers, it is not an orphan, so poking the flag is
    // enough and the user keeps their tab.
    pingAnswer = { ok: true, phase: "idle" };
    claimRun();

    const result = await INTERNALS.forceResetRun({});

    expect(result.ok).toBe(true);
    expect(result.wasReachable).toBe(true);
    expect(result.wasRunning).toBe(false);
    expect(result.cleared).toEqual({ claim: true, attachFlag: true, reloadedTab: false });
    expect(attachClears()).toHaveLength(1);
    expect(reloads).toHaveLength(0);
    expect(typesSent()).not.toContain("gmailCleanerCancel");
    expect(claim()).toBeNull();
    expect(sessionClaim()).toBeNull();
  });

  test("the session copy of the claim is cleared too", async () => {
    // The claim is written to session first and local second, and
    // hasActiveRun reads session first. Clearing only local would leave
    // it refusing every run on the strength of the session copy.
    pingAnswer = { ok: true, phase: "idle" };
    claimRun();
    await INTERNALS.forceResetRun({});
    expect(sessionClaim()).toBeNull();
  });

  test("a flag with nothing behind it means a tab reload, not a poke", async () => {
    // The orphan signature, and the reason this is not just a flag
    // clear. Reloading the extension mid-run leaves a content script
    // whose messaging is dead but whose loop is still clicking around
    // the mailbox. Clearing its flag would invite a second engine to
    // work beside it; taking its page away is what actually stops it.
    attachFlag = true;
    pingAnswer = null; // nothing answers
    claimRun();

    const result = await INTERNALS.forceResetRun({});

    expect(result.ok).toBe(true);
    expect(result.attachWasSet).toBe(true);
    expect(result.wasReachable).toBe(false);
    expect(reloads).toHaveLength(1);
    expect(result.cleared.reloadedTab).toBe(true);
    // No point poking a flag on a page that is being taken away.
    expect(attachClears()).toHaveLength(0);
    expect(claim()).toBeNull();
  });

  test("no flag and no answer is just a stale claim, so the tab is left alone", async () => {
    // The common case after a browser restart: the claim outlived the
    // page entirely. Reloading someone's Gmail tab to fix a storage key
    // would be a rude non-sequitur.
    attachFlag = false;
    pingAnswer = null;
    claimRun();

    const result = await INTERNALS.forceResetRun({});

    expect(result.ok).toBe(true);
    expect(result.attachWasSet).toBe(false);
    expect(reloads).toHaveLength(0);
    expect(attachClears()).toHaveLength(0);
    expect(result.cleared).toEqual({ claim: true, attachFlag: false, reloadedTab: false });
    expect(claim()).toBeNull();
  });

  test("no claim at all still deals with the in-page flag", async () => {
    // GCC_ATTACHED outlives the claim by design: the claim has a 2h TTL
    // and the flag has none. "No claim" is therefore not the same as
    // "nothing stuck", and the reset has to reach the tab regardless.
    attachFlag = true;
    pingAnswer = { ok: true, phase: "idle" };

    const result = await INTERNALS.forceResetRun({ tabId: 7 });

    expect(result.ok).toBe(true);
    expect(result.cleared.claim).toBe(false);
    expect(result.cleared.attachFlag).toBe(true);
  });

  test("a tab that is OPEN and refuses the reset keeps the claim", async () => {
    // The gap that made the first hardening pass insufficient. If the
    // tab is still there and would not take the clear, the attach flag
    // may still be up, and the popup's reader of that flag fails open.
    // Dropping the claim here would leave a green light backed by
    // nothing, so the claim stays and the caller is told why.
    executeScriptThrows = true;
    tabGone = false;
    claimRun();

    const result = await INTERNALS.forceResetRun({});

    expect(result.ok).toBe(true);
    expect(result.tabActionFailed).toBe(true);
    expect(result.cleared.claim).toBe(false);
    expect(claim()).not.toBeNull();
  });

  test("a reload that fails on an open tab keeps the claim too", async () => {
    attachFlag = true;
    pingAnswer = null;   // orphan signature, so the reload branch runs
    reloadThrows = true;
    tabGone = false;
    claimRun();

    const result = await INTERNALS.forceResetRun({});

    expect(result.cleared.reloadedTab).toBe(false);
    expect(result.tabActionFailed).toBe(true);
    expect(claim()).not.toBeNull();
  });

  test("the tab is dealt with BEFORE the claim is dropped", async () => {
    // Order matters. With the claim already gone, a popup opened in
    // that instant could claim, see no engine attached, inject, and
    // then have this very reset strip the guard off the engine it just
    // started. Doing the tab work first means nothing else can begin.
    pingAnswer = { ok: true, phase: "idle" };
    claimRun();

    let claimStillHeldWhenTabTouched = null;
    const realExec = global.chrome.scripting.executeScript;
    global.chrome.scripting.executeScript = jest.fn(async (details) => {
      if (String(details.func).includes("GCC_ATTACHED = false")) {
        claimStillHeldWhenTabTouched = claim() !== null;
      }
      return realExec(details);
    });

    try {
      await INTERNALS.forceResetRun({});
      expect(claimStillHeldWhenTabTouched).toBe(true);
    } finally {
      global.chrome.scripting.executeScript = realExec;
    }
  });

  test("a tab that has CLOSED still clears the stored claim", async () => {
    // The tab is gone, so it cannot be holding an attach flag and the
    // stranded claim is the only thing left. Clearing it is the whole
    // point of the button.
    executeScriptThrows = true;
    tabGone = true;
    claimRun();

    const result = await INTERNALS.forceResetRun({});

    expect(result.ok).toBe(true);
    expect(result.tabActionFailed).toBe(false);
    expect(result.cleared.claim).toBe(true);
    expect(result.cleared.attachFlag).toBe(false);
    expect(claim()).toBeNull();
  });
});

describe("refusing to reset a run that is alive", () => {
  test("a running engine is not cleared on the first attempt", async () => {
    pingAnswer = { ok: true, phase: "running" };
    claimRun();

    const result = await INTERNALS.forceResetRun({});

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("engine_running");
    // Nothing moved. Both flags still guard the mailbox.
    expect(claim()).not.toBeNull();
    expect(attachClears()).toHaveLength(0);
  });

  test("it asks the run to stop rather than only refusing", async () => {
    pingAnswer = { ok: true, phase: "running" };
    claimRun();

    const result = await INTERNALS.forceResetRun({});

    expect(result.cancelSent).toBe(true);
    expect(typesSent()).toContain("gmailCleanerCancel");
  });

  test("force cancels, waits for the engine to stop, THEN clears the flag", async () => {
    // Order is the whole point. GCC_ATTACHED is the only thing standing
    // between one engine and two on the same mailbox, so clearing it
    // while the engine is still looping would let the user start a
    // second pass over mail the first pass is in the middle of moving.
    pingAnswer = { ok: true, phase: "running" };
    claimRun();

    // Engine obeys the cancel and reports idle on the next poll.
    const realSend = global.chrome.tabs.sendMessage;
    global.chrome.tabs.sendMessage = jest.fn(async (tabId, message) => {
      sentMessages.push({ tabId, type: message?.type });
      if (message?.type === "gmailCleanerCancel") {
        pingAnswer = { ok: true, phase: "idle" };
        return { ok: true };
      }
      if (message?.type === "gmailCleanerPing") {
        if (!pingAnswer) throw new Error("Could not establish connection");
        return pingAnswer;
      }
      return { ok: true };
    });

    try {
      const result = await INTERNALS.forceResetRun({ force: true });

      expect(result.ok).toBe(true);
      expect(result.forced).toBe(true);
      expect(result.stillRunning).toBe(false);
      // Cancel went out before the flag came down.
      const cancelAt = typesSent().indexOf("gmailCleanerCancel");
      expect(cancelAt).toBeGreaterThan(-1);
      expect(attachClears()).toHaveLength(1);
      expect(claim()).toBeNull();
    } finally {
      global.chrome.tabs.sendMessage = realSend;
    }
  });

  test("an engine that ignores the cancel keeps its tab guarded", async () => {
    // The dangerous case. If the engine will not stop, the flag stays
    // up so nothing can attach beside it, and the caller is told so
    // rather than being handed a cheerful "cleared".
    pingAnswer = { ok: true, phase: "running" };
    claimRun();

    const result = await INTERNALS.forceResetRun({ force: true });

    expect(result.ok).toBe(true);
    expect(result.stillRunning).toBe(true);
    expect(result.cleared.attachFlag).toBe(false);
    expect(attachClears()).toHaveLength(0);
    // And the claim stays. Dropping it would leave the in-page flag as
    // the only gate, and the popup's reader of that flag fails open by
    // design so a slow tab stays usable. Nothing was resolved here, so
    // nothing is unlocked.
    expect(result.cleared.claim).toBe(false);
    expect(claim()).not.toBeNull();
  }, 20000);

  test("force on a dead engine does not invent a cancel", async () => {
    claimRun();
    const result = await INTERNALS.forceResetRun({ force: true });
    expect(result.ok).toBe(true);
    expect(result.forced).toBe(false);
    expect(typesSent()).not.toContain("gmailCleanerCancel");
  });

  test("an explicit tab id beats the claim's own", async () => {
    claimRun({ gmailTabId: 7 });
    const result = await INTERNALS.forceResetRun({ tabId: 99 });
    expect(result.tabId).toBe(99);
    expect(executed[0].target.tabId).toBe(99);
  });
});

describe("the popup surfaces it", () => {
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf-8");
  const html = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf-8");

  test("the banner exists with both a show and a reset control", () => {
    expect(html).toContain('id="runBanner"');
    expect(html).toContain('id="runBannerShowBtn"');
    expect(html).toContain('id="runBannerResetBtn"');
  });

  test("every already-running refusal raises it", () => {
    // Seven sites used to fire a bare toast that named a run, said
    // nothing about which one, and vanished after a few seconds. The
    // toast now lives in exactly one place, and that place also raises
    // the banner, so a refusal cannot arrive without the way out.
    const toastLine = 'showToast(t("alreadyRunningToast", "a cleanup is already running"), "warning");';
    expect(popup.split(toastLine).length - 1).toBe(1);

    const helper = popup.slice(
      popup.indexOf("const reportRunRefused"),
      popup.indexOf("const refreshRunBanner")
    );
    expect(helper).toContain(toastLine);
    expect(helper).toContain("refreshRunBanner()");
    expect(popup.split("reportRunRefused();").length - 1).toBeGreaterThanOrEqual(7);
  });

  test("the popup arms a second click instead of calling confirm()", () => {
    // window.confirm is a silent no-op inside a Firefox popup, so a
    // modal here would read as "nothing happened" and the two-stage
    // guard would quietly become one stage.
    const handler = popup.slice(
      popup.indexOf("const handleRunBannerReset"),
      popup.indexOf("const restoreActiveRunUI")
    );
    expect(handler.length).toBeGreaterThan(200);
    expect(handler).not.toContain("confirm(");
    expect(handler).toContain('resp.reason === "engine_running"');
    expect(handler).toContain("state.resetArmed = true");
    expect(handler).toContain("force: state.resetArmed");
  });

  test("the armed state expires, so it cannot be triggered by a stale click", () => {
    const handler = popup.slice(
      popup.indexOf("const handleRunBannerReset"),
      popup.indexOf("const restoreActiveRunUI")
    );
    expect(handler).toMatch(/setTimeout\(disarmReset, \d+\)/);
  });

  test("an engine that would not stop is reported as such, not as cleared", () => {
    const handler = popup.slice(
      popup.indexOf("const handleRunBannerReset"),
      popup.indexOf("const restoreActiveRunUI")
    );
    expect(handler).toContain("resp.stillRunning");
    // The success toast has to sit behind that check, or the user is
    // told they can start a run while an engine still holds the tab.
    expect(handler.indexOf("resp.stillRunning")).toBeLessThan(
      handler.indexOf("runToastCleared")
    );
  });

  test("a tab that refused the reset is reported too", () => {
    const handler = popup.slice(
      popup.indexOf("const handleRunBannerReset"),
      popup.indexOf("const restoreActiveRunUI")
    );
    expect(handler).toContain("resp.tabActionFailed");
    expect(handler.indexOf("resp.tabActionFailed")).toBeLessThan(
      handler.indexOf("runToastCleared")
    );
  });

  test("a failed probe hides the banner rather than leaving it up", () => {
    const refresher = popup.slice(
      popup.indexOf("const refreshRunBanner"),
      popup.indexOf("const handleRunBannerShow")
    );
    expect(refresher).toContain("hideRunBanner()");
  });
});

describe("the progress page surfaces it too", () => {
  const progress = fs.readFileSync(path.join(__dirname, "..", "progress.js"), "utf-8");
  const html = fs.readFileSync(path.join(__dirname, "..", "progress.html"), "utf-8");

  test("the button exists and is wired", () => {
    expect(html).toContain('id="resetRunBtn"');
    expect(progress).toContain('resetRun: document.getElementById("resetRunBtn")');
    expect(progress).toContain('ui.resetRun?.addEventListener("click", handleResetStuckRun)');
  });

  test("it is a separate control from Re-inject, which starts a run", () => {
    const handler = progress.slice(
      progress.indexOf("const handleResetStuckRun"),
      progress.indexOf("const handleReinject")
    );
    expect(handler.length).toBeGreaterThan(200);
    expect(handler).not.toContain('files: ["contentScript.js"]');
    expect(handler).toContain("gmailCleanerForceReset");
  });

  test("this page can use confirm(), and does, before forcing", () => {
    const handler = progress.slice(
      progress.indexOf("const handleResetStuckRun"),
      progress.indexOf("const handleReinject")
    );
    expect(handler).toContain("confirm(");
    expect(handler).toContain("force: true");
  });
});
