/**
 * @jest-environment node
 *
 * 9.7: the daily housekeeping alarm was armed once, on install.
 *
 * gcc_stats_cleanup is the alarm behind two promises: the 90-day prune
 * of the daily stats buckets, and since 9.1 the removal of a census
 * that has aged past 90 days, which PRIVACY.md states as "a census is
 * cleared for you once it is three months old". It was created in
 * onInstalled and nowhere else.
 *
 * Chrome persists alarms across a restart, so there it did not matter.
 * Firefox does not: MDN's alarms page says "alarms do not persist across
 * browser sessions", and the WebExtensions community group tracks the
 * difference as an open inconsistency. So on Firefox the first restart
 * after an update took the alarm with it, and neither prune ran again
 * until the next update re-fired onInstalled. The schedules and the
 * Auto-Pilot alarm have been re-armed from onStartup since they were
 * written; this one was the odd one out.
 *
 * alarms.create replaces an alarm of the same name, so arming it from
 * onStartup on Chrome costs nothing.
 */
const fs = require("fs");
const path = require("path");

const WORKER = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");

let onInstalledCb;
let onStartupCb;

beforeAll(() => {
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn((cb) => { onInstalledCb = cb; }) },
      onStartup: { addListener: jest.fn((cb) => { onStartupCb = cb; }) },
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn(async () => undefined),
      setUninstallURL: jest.fn(),
      getURL: jest.fn((p) => `chrome-extension://test/${p}`),
      lastError: null
    },
    storage: {
      local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) },
      sync: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) },
      session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) }
    },
    alarms: {
      create: jest.fn(), clear: jest.fn(async () => true),
      getAll: jest.fn(async () => []), onAlarm: { addListener: jest.fn() }
    },
    tabs: { query: jest.fn(async () => []), get: jest.fn(async (id) => ({ id })), onRemoved: { addListener: jest.fn() } },
    scripting: { executeScript: jest.fn(async () => []) },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) },
    management: { getSelf: jest.fn((cb) => cb({ installType: "normal" })) }
  };
  new Function(WORKER)();
});

beforeEach(() => {
  jest.clearAllMocks();
});

const housekeepingCalls = () =>
  chrome.alarms.create.mock.calls.filter(([name]) => name === "gcc_stats_cleanup");

describe("the housekeeping alarm", () => {
  test("is armed on install, daily", async () => {
    await onInstalledCb({ reason: "install" });
    const calls = housekeepingCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ periodInMinutes: 1440 });
  });

  test("is armed again on every browser startup, so a Firefox restart cannot lose it", async () => {
    await onStartupCb();
    const calls = housekeepingCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ periodInMinutes: 1440 });
  });

  test("startup arms it beside the schedules and Auto-Pilot, not instead of them", async () => {
    // The two re-arm paths that already existed read their config from
    // sync; an empty read means nothing to arm, which is exactly what the
    // stubs above hand back. The housekeeping alarm needs no config.
    await onStartupCb();
    expect(chrome.storage.sync.get).toHaveBeenCalled();
    expect(housekeepingCalls()).toHaveLength(1);
  });
});
