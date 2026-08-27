/**
 * @jest-environment jsdom
 *
 * 8.25, engine side.
 *
 * Deliberately NOT on a mail.google.com URL. Evaluating contentScript.js
 * boots a run, and on a mailbox URL that run keeps navigating for the
 * length of the file; every load() adds another one racing the last for
 * the document. Off a mailbox isGmailTab refuses at the first line and
 * the boot ends there, which leaves the functions below exactly as they
 * are: not one of them asks what the URL is.
 *
 * Two things, plus the tail of a locale family.
 *
 * 1. `getMainRoot()` answers `document` when div[role="main"] is missing,
 *    and 8.22's whole fix was to keep row lookups away from the list
 *    Gmail leaves behind a search. Five call sites read rows through that
 *    fallback, and what sits behind them is why it is worth closing:
 *    rows get TICKED and then deleted, rows get SAMPLED into the undo log
 *    and into the unsubscribe list, and a row gets OPENED so its
 *    Unsubscribe control can be driven. Unsubscribing cannot be undone.
 *
 * 2. Dry Run quoted the visible page as the match total whenever Gmail
 *    stated none. The LIVE path has treated that case as over-cap since
 *    8.12 (matchTotalUnknown), and the preview on the same page printed
 *    "would affect 50" for a rule holding twelve thousand.
 */
const fs = require("fs");
const path = require("path");

// Patience shortened at the SOURCE, which is the only place it can be:
// TIMING is Object.freeze'd, so assigning over it from a test is a
// silent no-op that looks like the code hanging. Nothing here changes a
// decision, only how long the bulk path waits for a banner this fixture
// deliberately never paints.
const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8")
  .replace(/WAIT_DEFAULT_TIMEOUT: \d+/, "WAIT_DEFAULT_TIMEOUT: 300")
  .replace(/WAIT_DEFAULT_INTERVAL: \d+/, "WAIT_DEFAULT_INTERVAL: 5")
  .replace(/WAIT_TOOLBAR_TIMEOUT: \d+/, "WAIT_TOOLBAR_TIMEOUT: 300")
  .replace(/SELECTION_VERIFY_TIMEOUT: \d+/, "SELECTION_VERIFY_TIMEOUT: 100")
  .replace(/BULK_CONFIRM_TIMEOUT: \d+/, "BULK_CONFIRM_TIMEOUT: 100")
  .replace(/SELECT_ALL_SETTLE_DELAY: \d+/, "SELECT_ALL_SETTLE_DELAY: 10")
  .replace(/LIST_REFRESH_TIMEOUT: \d+/, "LIST_REFRESH_TIMEOUT: 200")
  .replace(/DOM_SETTLE_DELAY: \d+/, "DOM_SETTLE_DELAY: 5")
  .replace(/CHECKBOX_SETTLE_DELAY: \d+/, "CHECKBOX_SETTLE_DELAY: 5");

function load(config) {
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = Object.assign({ runKind: "cleanup" }, config || {});
  window.alert = () => {};
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

const rows = (n, prefix) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<tr role="row" id="${prefix}${i}" class="zA yO"><td class="xY a4W">` +
      `<span role="checkbox" aria-checked="false"></span>` +
      `<span email="${prefix}${i}@example.com" name="${prefix} ${i}"></span></td></tr>`
  ).join("");

beforeEach(() => {
  document.body.innerHTML = "";
  chrome.runtime.sendMessage = jest.fn();
  chrome.runtime.onMessage = { addListener: jest.fn() };
});

describe("no div[role='main'], no rows", () => {
  // The page Gmail serves for a beat during a render: the previous
  // list is still there and main is not there yet. Every lookup below
  // used to fall through to `document` and find the leftover.
  const leftoverOnly = () => {
    document.body.innerHTML = `
      <div id="leftover">
        <div class="aeH"><span>1-50 of 426</span></div>
        <table role="grid">${rows(50, "stale")}</table>
      </div>
      <div gh="mtb"></div>`;
  };

  test("the per-row selection pass clicks nothing", async () => {
    leftoverOnly();
    const I = load();
    const clicked = [];
    for (const cb of document.querySelectorAll('[role="checkbox"]')) {
      cb.addEventListener("click", () => clicked.push(cb));
    }
    await expect(I.selectAllVisibleRowsIndividually()).resolves.toBe(0);
    expect(clicked).toHaveLength(0);
  });

  test("the selection count answers 'could not tell', not a number", () => {
    leftoverOnly();
    // Tick the leftover list the way the old pass would have, so the
    // only thing separating the two answers is the scope.
    for (const cb of document.querySelectorAll('[role="checkbox"]')) {
      cb.setAttribute("aria-checked", "true");
    }
    const I = load();
    // null is the shape every caller already reads as unknown; a number
    // here is a selection the run would act on.
    expect(I.extractSelectedCount()).toBeNull();
  });

  test("the undo log's sender sample is empty", () => {
    leftoverOnly();
    const I = load();
    expect(I.sampleListRows().senders).toEqual([]);
    expect(I.sampleListRows().threadIds).toEqual([]);
  });

  test("the unsubscribe list's sender sample is empty", () => {
    leftoverOnly();
    const I = load();
    expect(I.sampleSubscriptionRows()).toEqual([]);
  });

  test("no conversation is opened for an unsubscribe", async () => {
    leftoverOnly();
    const I = load();
    const opened = [];
    for (const cell of document.querySelectorAll("td.a4W")) {
      cell.addEventListener("mousedown", () => opened.push(cell));
      cell.addEventListener("click", () => opened.push(cell));
    }
    await expect(I.openMessageFromCurrentList()).resolves.toEqual({
      opened: false,
      reason: "no_results"
    });
    expect(opened).toHaveLength(0);
  });
});

describe("with main present nothing changed", () => {
  const bothLists = () => {
    document.body.innerHTML = `
      <div id="leftover"><table role="grid">${rows(50, "stale")}</table></div>
      <div gh="mtb"></div>
      <div role="main">
        <div gh="tl"><table role="grid">${rows(4, "live")}</table></div>
      </div>`;
  };

  test("the per-row pass ticks the live list and only the live list", async () => {
    bothLists();
    const I = load();
    const clicked = [];
    for (const cb of document.querySelectorAll('[role="checkbox"]')) {
      cb.addEventListener("click", () => {
        cb.setAttribute("aria-checked", "true");
        clicked.push(cb.closest("tr").id);
      });
    }
    await I.selectAllVisibleRowsIndividually();
    expect(clicked).toEqual(["live0", "live1", "live2", "live3"]);
  });

  test("the sender samples come from the live list", () => {
    bothLists();
    const I = load();
    expect(I.sampleSubscriptionRows().map((s) => s.email)).toEqual([
      "live0@example.com", "live1@example.com", "live2@example.com", "live3@example.com"
    ]);
    expect(I.sampleListRows().senders).toEqual([
      "live0@example.com", "live1@example.com", "live2@example.com", "live3@example.com"
    ]);
  });
});

describe("Dry Run states a floor as a floor", () => {
  // The page the bulk path lands on when Gmail ranks by relevance: the
  // select-all-matching offer is there and neither the toolbar counter
  // nor the offer text names a number.
  const bulkPageWithNoTotal = () => {
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="checkbox" aria-checked="false" aria-label="Select"></div>
        <span>Showing most relevant1-50 of many</span>
      </div>
      <div role="main">
        <div class="aeH"><span role="link">Select all conversations that match this search</span></div>
        <div gh="tl"><table role="grid">${rows(50, "live")}</table></div>
      </div>`;
  };

  test("the preview marks the count as a floor", async () => {
    bulkPageWithNoTotal();
    const I = load({ dryRun: true });
    // The offer is consumed by the click, which is the structural
    // "bulk-all is on" signal the engine uses on non-English Gmail.
    const offer = document.querySelector('span[role="link"]');
    offer.addEventListener("click", () => offer.remove());
    const result = await I.actOnCurrentPageIfAny(null);
    expect(result.reason).toBe("dry-run");
    expect(result.countIsFloor).toBe(true);
  });

  test("a stated total is not a floor", async () => {
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="checkbox" aria-checked="false" aria-label="Select"></div>
        <span>1-50 of 12,438</span>
      </div>
      <div role="main">
        <div class="aeH"><span role="link">Select all conversations that match this search</span></div>
        <div gh="tl"><table role="grid">${rows(50, "live")}</table></div>
      </div>`;
    const I = load({ dryRun: true });
    const offer = document.querySelector('span[role="link"]');
    offer.addEventListener("click", () => offer.remove());
    const result = await I.actOnCurrentPageIfAny(null);
    expect(result.countIsFloor).toBe(false);
    expect(result.count).toBe(12438);
  });

  test("the end-of-run sentence says so, and names how many rules", () => {
    const I = load({ dryRun: true });
    I.stats.totalWouldDelete = 150;
    I.stats.wouldDeleteFloors = 3;
    const done = I.buildFinalStats(6);
    expect(done.wouldDeleteFloors).toBe(3);
    const summary = I.buildHumanSummary(done, 6);
    expect(summary).toContain("at least 150");
    expect(summary).toContain("3 rules matched more than Gmail would total");
  });

  test("a preview Gmail totalled everywhere keeps the plain sentence", () => {
    const I = load({ dryRun: true });
    I.stats.totalWouldDelete = 150;
    I.stats.wouldDeleteFloors = 0;
    const done = I.buildFinalStats(6);
    const summary = I.buildHumanSummary(done, 6);
    expect(summary).toContain("about 150 matches");
    expect(summary).not.toContain("at least");
  });

  test("one floored rule is singular", () => {
    const I = load({ dryRun: true });
    I.stats.totalWouldDelete = 50;
    I.stats.wouldDeleteFloors = 1;
    const summary = I.buildHumanSummary(I.buildFinalStats(1), 1);
    expect(summary).toContain("One rule matched more than Gmail would total");
  });
});

describe("the throttle table finishes the Chinese family", () => {
  // 8.16 closed this in DELETE_LABEL_TOKENS, 8.24 in SELECT_ALL_TOKENS.
  // RATE_LIMIT_TOKENS carried three Simplified phrases and one
  // Traditional one, so two of the three throttle messages a zh-TW Gmail
  // shows went unrecognised and the run never backed off for them.
  //
  // Pinned per phrase rather than by counting them: 8.19 learned that a
  // count is a weak pin for "all of them" and it cost three releases.
  const table = () => {
    const body = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
    const at = body.indexOf("const RATE_LIMIT_TOKENS = Object.freeze([");
    expect(at).toBeGreaterThan(-1);
    return body.slice(at, body.indexOf("]);", at));
  };

  test.each([
    ["请稍后再试", "請稍後再試"],
    ["出了点问题", "出了點問題"],
    ["请求过多", "請求過多"]
  ])("%s has %s beside it", (simplified, traditional) => {
    const text = table();
    expect(`${simplified}: ${text.includes(simplified)}`).toBe(`${simplified}: true`);
    expect(`${traditional}: ${text.includes(traditional)}`).toBe(`${traditional}: true`);
  });

  test("a Traditional throttle message is detected on the page", () => {
    document.body.innerHTML = `<div role="main"><div role="alert">請求過多，請稍後再試</div></div>`;
    const I = load();
    expect(I.findRateLimitText()).toBeTruthy();
  });
});

describe("the counter's length guard is stated once", () => {
  // Two identical `text.length > MAX_COUNTER_TEXT_LENGTH` checks sat in
  // parseCountFromText, the second left behind when the first was
  // hoisted to cover every branch. A duplicated guard reads as two
  // different conditions to whoever edits one of them next.
  test("exactly one length check in the parser", () => {
    const body = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
    const at = body.indexOf("function parseCountFromText(");
    const fn = body.slice(at, body.indexOf("\n  function ", at + 10));
    const hits = fn.match(/text\.length > MAX_COUNTER_TEXT_LENGTH/g) || [];
    expect(hits).toHaveLength(1);
  });

  test("and it still refuses a long ancestor's concatenated text", () => {
    const I = load();
    const long = "Showing 1-50 of 12,438 " + "x".repeat(60);
    expect(I.parseCountFromText(long)).toBeNull();
    expect(I.parseCountFromText("Showing 1-50 of 12,438")).toBe(12438);
  });
});
