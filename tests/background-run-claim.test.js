/**
 * @jest-environment node
 *
 * ACTIVE_RUN claim lifecycle for the scheduled run path (7.14).
 *
 * The marker exists so an unattended sweep and a manual run cannot both
 * drive the same mailbox. Three ways that broke:
 *
 *   1. Scans, restores and the other auxiliary run kinds attach to the
 *      Gmail tab WITHOUT claiming the marker. hasActiveRun() therefore
 *      sees nothing, the schedule claims and injects, the content
 *      script's duplicate guard swallows the injection, and the claim
 *      sits there for its full 2h TTL refusing every manual run. The
 *      schedule also recorded a lastRun it never performed.
 *   2. When injection itself failed the claim was never released at
 *      all: same 2h lockout, no run.
 *   3. A failure AFTER injection sent the retry loop back around, so a
 *      live run got its config overwritten and a second engine on top.
 */

const fs = require("fs");
const path = require("path");

let storageBacking;
let INTERNALS;
let executed;

// Test hooks, reset per case. Plain variables rather than
// mockImplementationOnce, whose queue survives a failed expectation and
// silently reorders itself into the next test.
let attachedAnswer;   // what the attach probe reports
let probeThrows;      // probe cannot reach the tab at all
let injectionThrows;  // executeScript fails for real injections
let syncSetThrows;    // the lastRun write fails once, after injection
let lastInjectedRunId; // the run id the last real injection carried
let pingUnreachable;  // the tab never answers the confirmation ping
let swallowedBy;      // a foreign run id the engine reports instead

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
    set: jest.fn(async (obj) => {
      if (area === "sync" && syncSetThrows) {
        syncSetThrows = false;
        throw new Error("quota exceeded");
      }
      Object.assign(storageBacking[area], obj);
    })
  };
}

const SCHEDULE = Object.freeze({
  id: "sched1",
  enabled: true,
  intensity: "light",
  intervalMinutes: 10080,
  action: "trash",
  minAge: "3m"
});

beforeAll(() => {
  storageBacking = { local: {}, sync: {}, session: {} };
  executed = [];

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
      get: jest.fn(async (id) => ({ id })),
      // 8.7: the worker confirms an injection by asking the engine which
      // run it is, so the mock has to model a booting engine. A healthy
      // inject answers with the run id it was just handed; a swallowed
      // one answers with whatever was already attached, which is what
      // `swallowedBy` stands in for.
      sendMessage: jest.fn(async (_tabId, msg) => {
        if (msg?.type !== "gmailCleanerPing") return { ok: true };
        if (pingUnreachable) throw new Error("no listener");
        return {
          ok: true,
          phase: "running",
          version: "test",
          runId: swallowedBy !== null ? swallowedBy : lastInjectedRunId
        };
      }),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: {
      // A bare func with no args and no files is the attach probe: a
      // read, not an injection, so it answers and stays out of the log.
      executeScript: jest.fn(async (details) => {
        const isProbe = Boolean(details.func) && !details.args && !details.files;
        if (isProbe) {
          if (probeThrows) throw new Error("cannot reach tab");
          return [{ result: attachedAnswer }];
        }
        if (injectionThrows) throw new Error("tab gone");
        if (details.args?.[0]?.runId) lastInjectedRunId = details.args[0].runId;
        executed.push(details);
        return [{ result: null }];
      })
    },
    // Callback form: the worker's getInstallType() passes a callback and
    // waits for it, so a promise-returning mock hangs the whole path.
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
  storageBacking.sync = { schedules: [{ ...SCHEDULE }] };
  storageBacking.session = {};
  executed.length = 0;
  attachedAnswer = false;
  probeThrows = false;
  injectionThrows = false;
  lastInjectedRunId = "";
  pingUnreachable = false;
  swallowedBy = null;
  syncSetThrows = false;
});

const activeRun = () => storageBacking.local.activeRun ?? null;
const savedSchedule = () => (storageBacking.sync.schedules || [])[0];

describe("scheduled cleanup and the run claim", () => {
  test("a healthy schedule claims, injects, and records the run", async () => {
    await INTERNALS.runScheduledCleanup("sched1");

    expect(executed).toHaveLength(2); // config, then the content script
    expect(activeRun()).toMatchObject({ gmailTabId: 7, source: "schedule" });
    expect(savedSchedule().lastRun).toEqual(expect.any(Number));
  });

  test("an engine already attached to the tab stops the schedule dead", async () => {
    // A subscription/storage/smart scan is mid-flight. Those never claim
    // ACTIVE_RUN, so the marker check upstream cannot see them.
    attachedAnswer = true;

    await INTERNALS.runScheduledCleanup("sched1");

    expect(executed).toHaveLength(0);
    // No claim to strand, and the run genuinely did not happen, so
    // lastRun must not move.
    expect(activeRun()).toBeNull();
    expect(savedSchedule().lastRun).toBeUndefined();
  });

  test("a tab that cannot answer the probe is treated as attached", async () => {
    probeThrows = true;

    await INTERNALS.runScheduledCleanup("sched1");

    expect(executed).toHaveLength(0);
    expect(activeRun()).toBeNull();
    expect(savedSchedule().lastRun).toBeUndefined();
  });

  test("injection failure releases the claim instead of locking manual runs out for 2h", async () => {
    injectionThrows = true;

    await INTERNALS.runScheduledCleanup("sched1");

    expect(activeRun()).toBeNull();
    expect(savedSchedule().lastRun).toBeUndefined();
  }, 30000); // three attempts with a 5s backoff between them

  test("a failure after injection does not inject a second engine", async () => {
    // The engine is already running; only the lastRun bookkeeping blew
    // up. Retrying would overwrite a live run's config and attach again.
    syncSetThrows = true;

    await INTERNALS.runScheduledCleanup("sched1");

    expect(executed).toHaveLength(2); // config + content script, exactly once
    // The engine IS attached, so its own done message owns the release.
    expect(activeRun()).toMatchObject({ source: "schedule" });
  });

  test("the claim release only drops the marker when it is still ours", async () => {
    storageBacking.local.activeRun = { gmailTabId: 9, runId: "someone_else", startedAt: Date.now() };

    await INTERNALS.releaseRunClaim("not_the_current_run");
    expect(activeRun()).toMatchObject({ runId: "someone_else" });

    await INTERNALS.releaseRunClaim("someone_else");
    expect(activeRun()).toBeNull();
  });

  test("isEngineAttached fails safe when the tab gives no clear answer", async () => {
    attachedAnswer = false;
    await expect(INTERNALS.isEngineAttached(7)).resolves.toBe(false);

    attachedAnswer = true;
    await expect(INTERNALS.isEngineAttached(7)).resolves.toBe(true);

    // Unreachable tab: no answer is not a licence to inject.
    probeThrows = true;
    await expect(INTERNALS.isEngineAttached(7)).resolves.toBe(true);

    // Neither is an empty result array.
    probeThrows = false;
    attachedAnswer = undefined;
    await expect(INTERNALS.isEngineAttached(7)).resolves.toBe(true);
  });
});
