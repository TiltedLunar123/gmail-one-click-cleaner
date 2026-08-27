/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * What the guards hold back is a SUBTRACTION (8.25).
 *
 * The Mailbox Report prints "N more old emails are protected by your
 * guards" one line under a hero that may itself be admitting it only
 * counted a page, and the sentence names the exact switches to go and
 * change. The figure is the raw headline minus the guarded one, and 8.24
 * tracked exactness for the guarded side only. Since Gmail moved search
 * to relevance ranking either side can come back "1-50 of many", and the
 * difference is then wrong in whichever direction the floor fell: a raw
 * 12,000 against a guarded floor of 50 invents 11,950 held back, and two
 * floors of 50 cancel to 0 on a mailbox where the guards are holding
 * back thousands.
 *
 * Its own file, for the reason sweep-8-24-report-floors is its own file:
 * this harness drives navigation through hashchange and repaints the
 * document on every one, and the popup suites set innerHTML directly.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const flush = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------- report engine

const ENGINE = read("contentScript.js")
  .replace(/SEARCH_TRANSITION_DELAY: \d+/, "SEARCH_TRANSITION_DELAY: 5")
  .replace(/DOM_SETTLE_DELAY: \d+/, "DOM_SETTLE_DELAY: 5")
  .replace(/WAIT_DEFAULT_INTERVAL: \d+/, "WAIT_DEFAULT_INTERVAL: 5")
  .replace(/WAIT_SEARCH_TIMEOUT: \d+/, "WAIT_SEARCH_TIMEOUT: 400");

const HEADLINE = "older_than:6m -in:sent -in:drafts -in:chats";
const GUARD_SUFFIX = " -is:starred -is:important -is:unread -has:userlabels";

let messages;
let painter;

const resultMessage = () =>
  messages.find((m) => m.type === "gmailCleanerReportScanResult") || null;
const terminal = () =>
  messages.find((m) => m.type === "gmailCleanerProgress" && m.done === true) || null;

/**
 * Paint Gmail for the query in the hash.
 *
 * Keyed on the FULL query rather than the stripped one, because the two
 * headline searches differ only by the guard suffix and this suite is
 * about the difference between them. `relevance` names the full queries
 * whose pager reports no total.
 */
function installGmail({ counts, relevance = new Set() }) {
  let painted = null;
  const paint = () => {
    const hash = location.hash;
    if (hash === painted) return;
    painted = hash;
    if (!hash.startsWith("#search/")) return;
    const query = decodeURIComponent(hash.slice("#search/".length));
    const total = Number(counts[query] ?? counts[query.replace(GUARD_SUFFIX, "")] ?? 0) || 0;

    if (total === 0) {
      document.body.innerHTML =
        "<div role='main'><table role='grid'><tbody><tr>" +
        "<td class='TC'>No messages matched your search</td></tr></tbody></table></div>";
      return;
    }
    const floor = relevance.has(query);
    const shown = floor ? Math.min(total, 50) : Math.min(total, 3);
    const rows = Array.from(
      { length: shown },
      (_, i) => `<tr role="row" id="row-${i}"><td class="yX">` +
        `<span email="top@sender.com" name="Top">Top</span></td></tr>`
    ).join("");
    const pager = floor ? `Showing most relevant1-${shown} of many` : `1-${shown} of ${total}`;
    document.body.innerHTML =
      `<div role="main"><div gh="tm"><span>${pager}</span></div>` +
      `<div gh="tl"><table role="grid">${rows}</table></div></div>`;
  };
  painter = paint;
  window.addEventListener("hashchange", paint);
}

async function runReport(options) {
  installGmail(options);
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = { runKind: "reportScan" };
  window.alert = () => {};
  // eslint-disable-next-line no-new-func
  new Function(ENGINE)();
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (terminal()) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!terminal()) throw new Error("report never finished");
  return resultMessage();
}

// Both headlines measured, guarded holding back 940.
const EXACT_COUNTS = {
  [HEADLINE]: 12000,
  [HEADLINE + GUARD_SUFFIX]: 11060,
  "category:promotions older_than:6m": 8
};

describe("what the guards hold back is a subtraction, so both sides must be totals", () => {
  beforeEach(async () => {
    location.hash = "";
    await flush();
    await flush();
    messages = [];
    document.body.innerHTML = "";
    chrome.runtime.sendMessage = jest.fn((msg) => { messages.push(msg); });
    chrome.runtime.onMessage = { addListener: jest.fn(), removeListener: jest.fn() };
  });

  afterEach(async () => {
    await flush();
    if (painter) window.removeEventListener("hashchange", painter);
    painter = null;
  });

  test("two stated totals still give the difference", async () => {
    const result = await runReport({ counts: EXACT_COUNTS });
    expect(result.cleanableCount).toBe(11060);
    expect(result.cleanableAtLeast).toBe(false);
    expect(result.guardedOutCount).toBe(940);
  }, 30000);

  test("a floored GUARDED headline invents nothing", async () => {
    // The dangerous direction. The raw search states 12,000 and the
    // guarded one is relevance-ranked, so the old subtraction reported
    // 11,950 old emails "protected by your guards" from a page of fifty.
    const result = await runReport({
      counts: EXACT_COUNTS,
      relevance: new Set([HEADLINE + GUARD_SUFFIX])
    });
    expect(result.cleanableCount).toBe(50);
    expect(result.cleanableAtLeast).toBe(true);
    expect(result.guardedOutCount).toBe(0);
  }, 30000);

  test("a floored RAW headline invents nothing either", async () => {
    // The quiet direction: the raw side floors at fifty, the guarded one
    // states 11,060, and max(0, ...) clamps the nonsense to zero. Same
    // answer, and it has to be reached on purpose rather than by luck,
    // because a raw floor ABOVE the guarded count would not clamp.
    const result = await runReport({
      counts: { ...EXACT_COUNTS, [HEADLINE]: 60 },
      relevance: new Set([HEADLINE])
    });
    expect(result.guardedOutCount).toBe(0);
  }, 30000);

  test("both sides floored is not a mailbox with nothing held back", async () => {
    const result = await runReport({
      counts: EXACT_COUNTS,
      relevance: new Set([HEADLINE, HEADLINE + GUARD_SUFFIX])
    });
    expect(result.guardedOutCount).toBe(0);
  }, 30000);

  test("the figure rides the terminal message, not only the worker's copy", async () => {
    // The popup renders this screen from whichever of the two arrives
    // first, and the done message was one field short, so the sentence
    // explaining why a report reads near zero was invisible on the scan
    // that produced it and turned up the next time the popup opened.
    await runReport({ counts: EXACT_COUNTS });
    const done = terminal();
    expect(done.guardedOutCount).toBe(940);
    expect(done.cleanableAtLeast).toBe(false);
  }, 30000);

  test("and it is the same figure the worker was sent", async () => {
    const result = await runReport({
      counts: EXACT_COUNTS,
      relevance: new Set([HEADLINE + GUARD_SUFFIX])
    });
    expect(terminal().guardedOutCount).toBe(result.guardedOutCount);
    expect(terminal().guardedOutCount).toBe(0);
  }, 30000);
});

