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
 * Pinned in America/New_York on the evening after DST ends, when the
 * hole falls on 2026-11-01.
 */
process.env.TZ = "America/New_York";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHARED = fs.readFileSync(path.join(ROOT, "shared.js"), "utf-8");
const STATS_JS = fs.readFileSync(path.join(ROOT, "stats.js"), "utf-8");
const STATS_HTML = fs.readFileSync(path.join(ROOT, "stats.html"), "utf-8");

// 2026-11-05 19:30 EST, which is 2026-11-06 00:30 UTC.
const FIXED = Date.parse("2026-11-06T00:30:00Z");
const RealDate = Date;

const bodyOf = (html) => {
  const start = html.indexOf("<body");
  const open = html.indexOf(">", start) + 1;
  const end = html.lastIndexOf("</body>");
  return html.slice(open, end);
};

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED);
      else super(...args);
    }
    static now() { return FIXED; }
  }
  global.Date = FixedDate;
});

afterAll(() => {
  global.Date = RealDate;
});

beforeEach(() => {
  __resetChromeStorage();
  chrome.runtime.onMessage = { addListener: jest.fn() };
  chrome.tabs.query = jest.fn(async () => []);
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

test("the machine really is in Eastern time for this file", () => {
  // If TZ did not take, every assertion below would pass for the wrong
  // reason on a UTC machine. Say so first.
  expect(new Date(FIXED).getTimezoneOffset()).toBe(300);
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
