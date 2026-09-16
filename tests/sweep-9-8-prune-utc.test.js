/**
 * @jest-environment node
 *
 * 9.8: the 90-day prune measured its cutoff on the local calendar and
 * then compared it against UTC keys.
 *
 * recordStats stamps a day bucket with `new Date().toISOString().slice(0, 10)`,
 * which is a UTC date. pruneOldStats built its cutoff with
 * `cutoff.setDate(cutoff.getDate() - 90)`, which walks the LOCAL
 * calendar, and only then converted it with toISOString().
 *
 * Walking the local calendar preserves the local time of day, so it
 * lands on the same UTC instant as ninety days of milliseconds -- right
 * up until the UTC offset differs between the two ends. Across a DST
 * change it is an hour out, and an hour is enough to move the DATE when
 * the local time of day sits within an hour of midnight UTC. Then the
 * cutoff is a day late and the prune deletes a day that was still inside
 * the window it promises.
 *
 * This is the bug 9.7 fixed in the Stats page's daily chart, which
 * walked thirty LOCAL days and read each one out as a UTC string. The
 * writer, the reader and now the pruner all keep to one calendar.
 */
const fs = require("fs");
const path = require("path");

// Set before the worker or any fixture builds a Date. New York because
// its DST rules are documented and stable, and because the case below
// needs an offset that changes inside the ninety days. Restored after,
// so a file sharing this worker is not handed a timezone it did not ask
// for.
const REAL_TZ = process.env.TZ;
process.env.TZ = "America/New_York";

const WORKER = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");

const STATS_KEY = "cleanupStats";
const DAY_MS = 24 * 60 * 60 * 1000;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

let onAlarmCb;
let stored;

// One bucket per day for the last 100 days, so the boundary is
// surrounded on both sides.
const buildDays = (now) => {
  const dailyStats = {};
  for (let i = 0; i <= 100; i++) {
    dailyStats[utcDay(now - i * DAY_MS)] = { deleted: 1, archived: 0, freedMb: 0, runs: 1 };
  }
  return dailyStats;
};

beforeAll(() => {
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn() },
      onMessageExternal: { addListener: jest.fn() },
      sendMessage: jest.fn(async () => undefined),
      setUninstallURL: jest.fn(),
      getURL: jest.fn((p) => `chrome-extension://test/${p}`),
      lastError: null
    },
    storage: {
      local: {
        get: jest.fn(async () => ({ [STATS_KEY]: stored })),
        set: jest.fn(async (obj) => { stored = obj[STATS_KEY] ?? stored; })
      },
      sync: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) },
      session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) },
      onChanged: { addListener: jest.fn() }
    },
    alarms: {
      create: jest.fn(),
      clear: jest.fn(async () => true),
      getAll: jest.fn(async () => []),
      onAlarm: { addListener: jest.fn((cb) => { onAlarmCb = cb; }) }
    },
    tabs: {
      query: jest.fn(async () => []),
      get: jest.fn(async (id) => ({ id })),
      onRemoved: { addListener: jest.fn() }
    },
    scripting: { executeScript: jest.fn(async () => []) },
    notifications: { create: jest.fn((id, opts, cb) => cb && cb()) },
    management: { getSelf: jest.fn((cb) => cb({ installType: "normal" })) }
  };
  // eslint-disable-next-line no-new-func
  new Function(WORKER)();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  if (REAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = REAL_TZ;
});

const runPrune = async (nowMs) => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  jest.setSystemTime(nowMs);
  stored = { dailyStats: buildDays(nowMs) };
  await onAlarmCb({ name: "gcc_stats_cleanup" });
  await Promise.resolve();
  return stored.dailyStats;
};

describe("the 90-day prune keeps to the UTC calendar the keys are written on", () => {
  const cases = [
    // 19:00 EDT is 23:00 UTC; ninety days back is EST, where the same
    // wall clock is 00:00 UTC the NEXT day. That hour is the whole bug:
    // the local walk put the cutoff on 2026-03-07 and the bucket for
    // 2026-03-06, exactly ninety days old, was deleted with it.
    ["an evening ninety days after a DST change", Date.parse("2026-06-04T23:00:00Z")],
    // The mirror, walking back the other way across the autumn change.
    ["a morning ninety days after the autumn change", Date.parse("2026-01-28T04:30:00Z")],
    ["a plain midday with no change in between", Date.parse("2026-06-15T12:00:00Z")],
    ["the hour either side of midnight UTC", Date.parse("2026-06-05T00:30:00Z")]
  ];

  test.each(cases)("%s: the cutoff is exactly 90 UTC days back", async (_label, now) => {
    const days = await runPrune(now);
    const kept = Object.keys(days).sort();
    expect(kept).toContain(utcDay(now));
    expect(kept).toContain(utcDay(now - 90 * DAY_MS));
    expect(days[utcDay(now - 91 * DAY_MS)]).toBeUndefined();
    expect(kept).toHaveLength(91);
  });
});

describe("the source says so", () => {
  const fn = WORKER.slice(
    WORKER.indexOf("async function pruneOldStats"),
    WORKER.indexOf("async function pruneOldStats") + 1800
  );

  test("pruneOldStats does not walk the local calendar", () => {
    expect(fn).not.toContain("cutoff.setDate(");
    expect(fn).toContain("Date.UTC(");
  });
});
