/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * The Mailbox Report against a relevance-ranked Gmail (8.24).
 *
 * sweep-8-24-floors covers countCurrentResultsDetailed on its own. This
 * one drives the real reportScan() over a fixture that answers some
 * searches the way Gmail answers most of them now -- "Showing most
 * relevant 1-50 of many", no total -- and asserts the distinction
 * survives all the way into the message the worker stores.
 *
 * Own file, not another describe in the engine suite: this harness
 * drives navigation through hashchange and repaints the document on
 * every one, and the engine suite's tests set innerHTML directly. A
 * queued repaint from one style landing inside the other is how the
 * report suite's duplicate-search flake started.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8")
  .replace(/SEARCH_TRANSITION_DELAY: \d+/, "SEARCH_TRANSITION_DELAY: 5")
  .replace(/DOM_SETTLE_DELAY: \d+/, "DOM_SETTLE_DELAY: 5")
  .replace(/WAIT_DEFAULT_INTERVAL: \d+/, "WAIT_DEFAULT_INTERVAL: 5")
  .replace(/WAIT_SEARCH_TIMEOUT: \d+/, "WAIT_SEARCH_TIMEOUT: 400");

const HEADLINE = "older_than:6m -in:sent -in:drafts -in:chats";
const GUARD_SUFFIX = " -is:starred -is:important -is:unread -has:userlabels";
const stripGuards = (q) => (q.endsWith(GUARD_SUFFIX) ? q.slice(0, -GUARD_SUFFIX.length) : q);

// How many conversations each rule matches. `mode` decides what the
// fixture's pager says about them.
const COUNTS = {
  [HEADLINE]: 12000,
  "larger:25M older_than:6m": 4,
  "larger:10M smaller:25M older_than:6m": 30,
  "larger:5M smaller:10M older_than:6m": 100,
  "category:promotions older_than:6m": 8000,
  "category:social older_than:6m": 3000,
  "category:updates older_than:1y": 0,
  "category:forums older_than:1y": 0,
  '"unsubscribe" older_than:1y': 500,
  "in:inbox older_than:5y": 0,
  "in:inbox older_than:1y newer_than:5y": 900
};

let messages;
let painter;

const resultMessage = () => messages.find((m) => m.type === "gmailCleanerReportScanResult") || null;
const terminal = () =>
  messages.find((m) => m.type === "gmailCleanerProgress" && m.done === true) || null;
const bandById = (bands, id) => bands.find((b) => b.id === id);

/**
 * Paint a Gmail result page for the query in the hash.
 *
 * `relevance` is the set of RULES whose pager reports no total, which is
 * what Gmail writes for a relevance-ranked search. Those pages paint a
 * full page of rows and the string Gmail really puts there; everything
 * else paints the classic "1-50 of N".
 */
function installGmail({ relevance = new Set(), pageSize = 50 } = {}) {
  let painted = null;
  const paint = () => {
    const hash = location.hash;
    if (hash === painted) return;
    painted = hash;
    if (!hash.startsWith("#search/")) return;
    const rule = stripGuards(decodeURIComponent(hash.slice("#search/".length)));
    const total = Number(COUNTS[rule]) || 0;

    if (total === 0) {
      document.body.innerHTML =
        "<div role='main'><table role='grid'><tbody><tr>" +
        "<td class='TC'>No messages matched your search</td></tr></tbody></table></div>";
      return;
    }

    const shown = relevance.has(rule) ? Math.min(total, pageSize) : Math.min(total, 3);
    const rows = Array.from(
      { length: shown },
      (_, i) => `<tr role="row" id="row-${i}"><td class="yX">` +
        `<span email="top@sender.com" name="Top">Top</span></td></tr>`
    ).join("");
    // getTextContent reads textContent first, so Gmail's real pager has
    // no separator between the two halves. Matching the shipped helper
    // is the difference between pinning the engine and pinning a probe.
    const pager = relevance.has(rule)
      ? `Showing most relevant1-${shown} of many`
      : `1-${shown} of ${total}`;
    document.body.innerHTML =
      `<div role="main"><div gh="tm"><span>${pager}</span></div>` +
      `<div gh="tl"><table role="grid">${rows}</table></div></div>`;
  };
  painter = paint;
  window.addEventListener("hashchange", paint);
}

async function runReport(options = {}) {
  installGmail(options);
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = { runKind: "reportScan" };
  window.alert = () => {};
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (terminal()) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!terminal()) throw new Error("report never finished");
  return { result: resultMessage(), done: terminal() };
}

beforeEach(async () => {
  location.hash = "";
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  messages = [];
  document.body.innerHTML = "";
  chrome.runtime.sendMessage = jest.fn((msg) => { messages.push(msg); });
  // removeListener too: the engine drops a stale listener on attach, and
  // a stub without it fills the run with a console.error that hides real
  // ones.
  chrome.runtime.onMessage = { addListener: jest.fn(), removeListener: jest.fn() };
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  if (painter) window.removeEventListener("hashchange", painter);
  painter = null;
});

describe("a band Gmail stated no total for is marked as a floor", () => {
  test("the relevance-ranked band reports the page it could see, and says so", async () => {
    const { result } = await runReport({
      relevance: new Set(["category:promotions older_than:6m"])
    });
    const promos = bandById(result.bands, "promotions");
    // The bug: 8,000 promotions reported as a flat 50, with nothing on
    // the band to say the number was a page rather than a total.
    expect(promos.count).toBe(50);
    expect(promos.measured).toBe(true);
    expect(promos.atLeast).toBe(true);
  });

  test("a band with a stated total is left alone", async () => {
    const { result } = await runReport({
      relevance: new Set(["category:promotions older_than:6m"])
    });
    const social = bandById(result.bands, "social");
    expect(social.count).toBe(3000);
    expect(social.atLeast).toBe(false);
  });

  test("an empty band is exact, because nothing matched is a whole answer", async () => {
    const { result } = await runReport({ relevance: new Set(["category:forums older_than:1y"]) });
    const forums = bandById(result.bands, "forums");
    expect(forums.count).toBe(0);
    expect(forums.atLeast).toBe(false);
  });

  test("every band is marked independently, one search at a time", async () => {
    // Pinned per band rather than by counting marked bands: a count
    // passes for the wrong reason the moment a second band changes mode,
    // which is the pin that kept the third short exit out of 8.16 for
    // three releases.
    const { result } = await runReport({
      relevance: new Set(["category:promotions older_than:6m", '"unsubscribe" older_than:1y'])
    });
    expect(bandById(result.bands, "promotions").atLeast).toBe(true);
    expect(bandById(result.bands, "newsletters").atLeast).toBe(true);
    expect(bandById(result.bands, "social").atLeast).toBe(false);
    expect(bandById(result.bands, "inboxOld").atLeast).toBe(false);
    expect(bandById(result.bands, "sizeHuge").atLeast).toBe(false);
  });
});

describe("the headline says at least when it means at least", () => {
  test("a relevance-ranked headline is flagged and the copy changes with it", async () => {
    const { result, done } = await runReport({ relevance: new Set([HEADLINE]) });
    expect(result.cleanableCount).toBe(50);
    expect(result.cleanableAtLeast).toBe(true);
    // The first sentence of the whole product.
    expect(done.status).toBe("At least 50 emails are older than 6 months.");
  });

  test("a headline with a total keeps the sentence it always had", async () => {
    const { result, done } = await runReport();
    expect(result.cleanableAtLeast).toBe(false);
    expect(done.status).toBe("12,000 emails are older than 6 months.");
  });

  test("the headline and the bands are flagged separately", async () => {
    // Two searches, and either can state a total while the other does
    // not. Inferring one from the other would report a floor headline
    // over exact bands, or the reverse.
    const { result } = await runReport({
      relevance: new Set(["category:promotions older_than:6m"])
    });
    expect(result.cleanableAtLeast).toBe(false);
    expect(bandById(result.bands, "promotions").atLeast).toBe(true);
  });

  test("an empty mailbox is never described as at least nothing", async () => {
    const { result } = await runReport({ relevance: new Set([HEADLINE]), pageSize: 0 });
    // pageSize 0 paints no rows, so the headline settles empty and the
    // count is exact at zero. "At least 0" is not a claim about
    // anything, and the flag has to refuse to make it.
    expect(result.cleanableCount).toBe(0);
    expect(result.cleanableAtLeast).toBe(false);
  });
});

describe("smart scan does not divide one page by another", () => {
  // gatherSmartSignals takes a fetchCount, and the live runner passes
  // countCurrentResultsDetailed. Driven directly here rather than
  // through a whole smart scan: the arithmetic is the subject.
  function internals() {
    window.GCC_ATTACHED = false;
    window.GCC_TEST_MODE = true;
    window.GMAIL_CLEANER_CONFIG = { runKind: "cleanup", dryRun: true };
    window.alert = () => {};
    // eslint-disable-next-line no-new-func
    new Function(SRC)();
    return window.GCC_INTERNALS;
  }

  test("a plain number still means exactly that many", async () => {
    // The fixture contract every existing smart-scan test relies on.
    const I = internals();
    const counts = { base: 200, unread: 40, old: 100 };
    const sig = await I.gatherSmartSignals(
      { email: "news@example.com" },
      (q) => (q.includes("is:unread") ? counts.unread : q.includes("older_than") ? counts.old : counts.base)
    );
    expect(sig.count).toBe(200);
    expect(sig.unreadRatio).toBeCloseTo(0.2, 5);
    expect(sig.approx).toBeUndefined();
  });

  test("counts Gmail gave no total for are marked approximate", async () => {
    const I = internals();
    const sig = await I.gatherSmartSignals(
      { email: "news@example.com" },
      () => ({ count: 50, exact: false })
    );
    // The measurement is still 50/50, because that is genuinely what the
    // scan saw. What changes is that the card no longer treats it as a
    // fact about the sender.
    expect(sig.count).toBe(50);
    expect(sig.unreadRatio).toBe(1);
    expect(sig.approx).toBe(true);
  });

  test("a floor anywhere in the three is enough", async () => {
    const I = internals();
    const sig = await I.gatherSmartSignals(
      { email: "news@example.com" },
      (q) => (q.includes("is:unread") ? { count: 50, exact: false } : { count: 300, exact: true })
    );
    // A floor in the denominator overstates both ratios; a floor in a
    // numerator understates its own. Neither is the value.
    expect(sig.approx).toBe(true);
  });

  test("an exact pair stays exact", async () => {
    const I = internals();
    const sig = await I.gatherSmartSignals(
      { email: "news@example.com" },
      (q) => ({ count: q.includes("is:unread") ? 30 : 300, exact: true })
    );
    expect(sig.approx).toBeUndefined();
    expect(sig.unreadRatio).toBeCloseTo(0.1, 5);
  });

  test("the one irreversible suggestion refuses an approximate ratio", () => {
    const I = internals();
    // Exactly the shape the unsubscribe branch looks for: plenty of
    // mail, nearly all unread, not mostly old. Real when measured, and
    // manufactured by two page counts when not.
    const real = { count: 400, unreadRatio: 0.95, oldShare: 0.2, shape: true };
    expect(I.smartPrimaryActionFor(real)).toBe("unsubscribe");
    expect(I.smartPrimaryActionFor({ ...real, approx: true })).not.toBe("unsubscribe");
  });

  test("and still suggests something the user can take back", () => {
    const I = internals();
    const approx = { count: 400, unreadRatio: 0.95, oldShare: 0.2, shape: true, approx: true };
    // Not "returns nothing": a card with no action is a card that wastes
    // the scan. deleteOld goes to Trash, which Gmail keeps for about 30
    // days, and the undo log records it either way.
    expect(I.smartPrimaryActionFor(approx)).toBe("deleteOld");
  });

  test("a storage hog is still a storage hog", () => {
    const I = internals();
    // purgeLarge is decided on measured megabytes, not on a ratio, so
    // the flag has no business touching it.
    const sig = { count: 400, unreadRatio: 0.95, oldShare: 0.2, estMb: 250, approx: true };
    expect(I.smartPrimaryActionFor(sig)).toBe("purgeLarge");
  });
});

describe("and the live scan actually asks for the pair", () => {
  // Everything above drives gatherSmartSignals with an injected
  // fetchCount, which proves the arithmetic and nothing about the
  // wiring. smartScan builds its own fetchCount, and if that one asks
  // for the bare number the flag is never produced on a real mailbox
  // while every test above still passes. That is the shape this repo
  // keeps rediscovering: the fix exists and never reaches production.
  // So this one runs the real scan over a Gmail that answers every
  // search the way Gmail answers most of them now.
  function installRelevanceGmail() {
    let painted = null;
    const paint = () => {
      const hash = location.hash;
      if (hash === painted) return;
      painted = hash;
      if (!hash.startsWith("#search/")) return;
      const query = decodeURIComponent(hash.slice("#search/".length));
      // The two veto searches answer empty, or the fixture's only sender
      // is vetoed and the scan finishes with nothing to report.
      //
      // Matched on their exact shapes rather than on a substring:
      // applyGlobalGuards appends " -is:starred" to the reach check, so
      // a loose `includes("is:starred")` also empties the query that
      // decides whether the sender is REACHABLE, and the sender is held
      // back instead of vetoed. Two different reasons for the same zero.
      const isVeto = / is:starred$/.test(query) || query.startsWith("in:sent to:(");
      if (isVeto) {
        document.body.innerHTML =
          "<div role='main'><table role='grid'><tbody><tr>" +
          "<td class='TC'>No messages matched your search</td></tr></tbody></table></div>";
        return;
      }
      const rows = Array.from(
        { length: 50 },
        (_, i) => `<tr role="row" id="s${i}"><td class="yX">` +
          `<span email="flood@example.com" name="Flood">Flood</span></td></tr>`
      ).join("");
      document.body.innerHTML =
        "<div role=\"main\"><div gh=\"tm\"><span>Showing most relevant1-50 of many</span></div>" +
        `<div gh="tl"><table role="grid">${rows}</table></div></div>`;
    };
    painter = paint;
    window.addEventListener("hashchange", paint);
  }

  test("a scan over a relevance-ranked mailbox marks its senders approximate", async () => {
    installRelevanceGmail();
    window.GCC_ATTACHED = false;
    window.GCC_TEST_MODE = true;
    // One sender keeps the run to a handful of navigations; the wiring
    // is the same whether it measures one or ten.
    window.GMAIL_CLEANER_CONFIG = { runKind: "smartScan", smartSignalSenders: 1 };
    window.alert = () => {};
    // eslint-disable-next-line no-new-func
    new Function(SRC)();

    const start = Date.now();
    while (Date.now() - start < 25000) {
      if (terminal()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const scan = messages.find((m) => m.type === "gmailCleanerSmartScanResult");
    expect(scan).toBeTruthy();
    expect(scan.senders.length).toBeGreaterThan(0);
    expect(scan.senders[0].signals.approx).toBe(true);
    // And the action that cannot be undone is not the one it landed on,
    // even though 50 of 50 unread is exactly the shape that branch
    // looks for.
    expect(scan.senders[0].signals.unreadRatio).toBe(1);
    expect(scan.senders[0].action).not.toBe("unsubscribe");
  }, 30000);
});
