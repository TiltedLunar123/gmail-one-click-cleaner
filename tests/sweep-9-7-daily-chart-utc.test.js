/**
 * @jest-environment jsdom
 *
 * 9.7: the 30-day chart on the Stats page could skip a day, or show one
 * twice, for a month after the clocks changed.
 *
 * The worker keys dailyStats by the UTC date (toISOString) and the chart
 * reads those keys back, so the two agree in principle. The chart built
 * its 30 keys by stepping the LOCAL date back with setDate and only then
 * converting each step to UTC. Local days are not all the same length:
 * across a daylight-saving change, one evening's UTC date is the same
 * day and the next evening's is the day after, so for an hour each
 * evening the list either names one UTC date twice or misses one. A run
 * recorded under the missed key was simply not drawn.
 *
 * Pinned to an evening in America/New_York after DST ends, when the
 * hole falls on 2026-11-01. The zone is simulated on the Date object
 * rather than taken from the machine: `process.env.TZ` set inside a
 * jest test lands on the sandbox's copy of the environment and never
 * reaches V8, so on the UTC runners the file would either pass for the
 * wrong reason or, with a guard, fail for one. It did the second.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHARED = fs.readFileSync(path.join(ROOT, "shared.js"), "utf-8");
const STATS_JS = fs.readFileSync(path.join(ROOT, "stats.js"), "utf-8");
const STATS_HTML = fs.readFileSync(path.join(ROOT, "stats.html"), "utf-8");

const RealDate = Date;
const HOUR = 3600000;

// 2026-11-05 19:30 EST, which is 2026-11-06 00:30 UTC.
const FIXED = RealDate.UTC(2026, 10, 6, 0, 30, 0);

// America/New_York in the window the chart draws (2026-10-08 to
// 2026-11-06): EDT (UTC-4) until the clocks fall back at 2026-11-01
// 06:00 UTC (2 am EDT), EST (UTC-5) after. The one transition that
// matters here, modelled and nothing more.
const FALL_BACK = RealDate.UTC(2026, 10, 1, 6, 0, 0);
const offsetAt = (instant) => (instant < FALL_BACK ? -4 : -5) * HOUR;

// A Date whose LOCAL getters and setters speak Eastern time whatever
// the machine's zone is, and whose UTC methods are the real ones. Only
// the members the chart's two implementations touch are overridden:
// the old one stepped with getDate/setDate, the new one reads
// getUTCFullYear/getUTCMonth/getUTCDate and builds with Date.UTC.
class EasternDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED);
    else super(...args);
  }
  static now() { return FIXED; }

  wall() { return new RealDate(this.getTime() + offsetAt(this.getTime())); }

  getTimezoneOffset() { return -offsetAt(this.getTime()) / 60000; }
  getFullYear() { return this.wall().getUTCFullYear(); }
  getMonth() { return this.wall().getUTCMonth(); }
  getDate() { return this.wall().getUTCDate(); }

  // Keep the wall clock, move the calendar day, then find the instant
  // that wall clock names under the zone's rules: the same thing V8
  // does for a real zone.
  setDate(day) {
    const wall = this.wall();
    wall.setUTCDate(day);
    for (const offset of [-5 * HOUR, -4 * HOUR]) {
      const instant = wall.getTime() - offset;
      if (offsetAt(instant) === offset) {
        this.setTime(instant);
        return this.getTime();
      }
    }
    throw new Error("no instant for that wall clock, which cannot happen at 19:30");
  }
}

const bodyOf = (html) => {
  const start = html.indexOf("<body");
  const open = html.indexOf(">", start) + 1;
  const end = html.lastIndexOf("</body>");
  return html.slice(open, end);
};

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  global.Date = EasternDate;
});

afterAll(() => {
  global.Date = RealDate;
});

beforeEach(() => {
  __resetChromeStorage();
  chrome.runtime.onMessage = { addListener: jest.fn() };
  chrome.tabs.query = jest.fn((info, cb) => {
    if (typeof cb === "function") cb([]);
    return undefined;
  });
});

const loadWith = async (dailyStats) => {
  chrome.runtime.sendMessage = jest.fn((msg, cb) => {
    const answer = msg?.type === "gmailCleanerGetStats"
      ? { ok: true, stats: { totalRuns: 1, totalDeleted: 7, totalArchived: 0, totalFreedMb: 0, history: [], categoryBreakdown: {}, dailyStats, topSenders: [] } }
      : msg?.type === "gmailCleanerGetUndoLog"
        ? { ok: true, log: [] }
        : { ok: true };
    if (typeof cb === "function") cb(answer);
  });
  document.body.innerHTML = bodyOf(STATS_HTML);
  // eslint-disable-next-line no-new-func
  global.GCC = new Function(SHARED + "\nreturn GCC;")();
  window.GCC = global.GCC;
  // eslint-disable-next-line no-new-func
  new Function(STATS_JS)();
  await settle();
};

const barLabels = () =>
  [...document.querySelectorAll("#chartBars .chart-bar")].map((b) => b.getAttribute("aria-label"));

describe("the simulated zone", () => {
  test("is Eastern on both sides of the change, whatever the machine says", () => {
    expect(new Date(FIXED).getTimezoneOffset()).toBe(300);
    expect(new Date(RealDate.UTC(2026, 9, 31, 23, 30)).getTimezoneOffset()).toBe(240);
    expect(new Date().getDate()).toBe(5);
  });

  test("reproduces the hole: stepping local days across the change skips a UTC date", () => {
    // What the old chart did, and why 2026-11-01 was never drawn.
    const seen = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      seen.push(d.toISOString().slice(0, 10));
    }
    expect(seen).not.toContain("2026-11-01");
    expect(seen).toContain("2026-10-31");
    expect(seen).toContain("2026-11-02");
  });
});

test("a run recorded on the UTC day after the clocks changed is drawn", async () => {
  await loadWith({ "2026-11-01": { deleted: 7, archived: 0, freedMb: 0, runs: 1 } });
  const labels = barLabels();
  expect(labels).toHaveLength(30);
  expect(labels).toContain("2026-11-01: 7");
});

test("the thirty bars are thirty consecutive UTC dates ending today", async () => {
  await loadWith({ "2026-11-06": { deleted: 1, archived: 0, freedMb: 0, runs: 1 } });
  const days = barLabels().map((l) => l.split(":")[0]);
  expect(new Set(days).size).toBe(30);
  expect(days[29]).toBe("2026-11-06");
  expect(days[0]).toBe("2026-10-08");
  for (let i = 1; i < days.length; i++) {
    const prev = RealDate.parse(days[i - 1] + "T00:00:00Z");
    const cur = RealDate.parse(days[i] + "T00:00:00Z");
    expect(cur - prev).toBe(86400000);
  }
});
