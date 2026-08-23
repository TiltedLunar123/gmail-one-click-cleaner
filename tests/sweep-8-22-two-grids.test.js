/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * Gmail keeps the previous list in the DOM (8.22).
 *
 * Opening a search no longer replaces the conversation list. Gmail leaves
 * the list that was on screen before the query behind -- its own
 * table[role="grid"], its own pager -- laid out but not rendered, OUTSIDE
 * div[role="main"] and ahead of the results in document order.
 *
 * Two things in this engine asked the document for "the" grid, and both
 * got that stale one:
 *
 *   - estimateTotalResults excluded a single grid from its walk, so the
 *     grid it protected was the one nobody was counting and every row of
 *     the list actually on screen was back in scope. That is the hole 8.21
 *     closed, re-opened by a layout change rather than an edit.
 *   - the document scope then answered with the leftover list's pager.
 *     Measured on live Gmail: a search whose own pager read "1-50 of many"
 *     (no total, which is the case the unknown-total confirmation exists
 *     for) was sized against the INBOX's "1-50 of 426". Four of five
 *     Mailbox Report bands reported 426, two of them bands with no
 *     matching mail at all.
 *   - selectAllVisibleRowsIndividually clicked the leftover list's
 *     checkboxes. extractSelectedCount reads main, so it saw nothing
 *     selected and the pass answered 0, which is the GmailLayoutError its
 *     caller raises. The fallback that exists to rescue a run guaranteed
 *     it stopped instead, after ticking rows the query never matched.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function load() {
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = { runKind: "cleanup", dryRun: true };
  window.alert = () => {};
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

const rows = (n, prefix) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<tr role="row" id="${prefix}${i}"><td class="yX">` +
      `<span role="checkbox" aria-checked="false"></span></td></tr>`
  ).join("");

// The page Gmail really serves after a search: the previous list first,
// then the results inside main. Both carry a pager.
const twoGridPage = ({ stalePager, livePager, staleRows = 50, liveRows = 47 }) => `
  <div id="leftover" data-rendered="no">
    <div class="aeH"><span>${stalePager}</span></div>
    <table role="grid">${rows(staleRows, "stale")}</table>
  </div>
  <div gh="mtb"></div>
  <div role="main" data-rendered="yes">
    <div gh="tm"><span>${livePager}</span></div>
    <div gh="tl"><table role="grid">${rows(liveRows, "live")}</table></div>
  </div>`;

// jsdom performs no layout, so the engine's render gate is inert there by
// design. These tests drive it explicitly: an element is rendered when it
// sits under data-rendered="yes". That is the only thing checkVisibility
// reports on a real page, and it is what separated the leftover pager
// (0x0, offsetParent null) from the live one (667x20) on live Gmail.
function stubRendering() {
  Element.prototype.checkVisibility = function checkVisibility() {
    return !!this.closest('[data-rendered="yes"]');
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  delete Element.prototype.checkVisibility;
  chrome.runtime.sendMessage = jest.fn();
  chrome.runtime.onMessage = { addListener: jest.fn() };
});

afterAll(() => {
  delete Element.prototype.checkVisibility;
});

describe("a leftover list cannot supply the total", () => {
  test("the previous list's pager is refused when this search has no total of its own", () => {
    document.body.innerHTML = twoGridPage({
      stalePager: "1-50 of 426",
      livePager: "Showing most relevant1-50 of many"
    });
    stubRendering();
    const I = load();
    // Was 426: the inbox's count, for a query that never matched it.
    // "of many" is genuinely unknown, and unknown is what must come back,
    // because that is what raises the unknown-total confirmation.
    expect(I.estimateTotalResults()).toBeNull();
  });

  test("this search's own total still wins when Gmail states one", () => {
    document.body.innerHTML = twoGridPage({
      stalePager: "1-50 of 426",
      livePager: "Showing most relevant1-5 of 5",
      liveRows: 5
    });
    stubRendering();
    const I = load();
    expect(I.estimateTotalResults()).toBe(5);
  });

  test("no row of the list on screen can be read as the counter", () => {
    // The subject 8.21 was written against, now sitting in the SECOND
    // grid -- the one the old single-grid exclusion did not cover.
    document.body.innerHTML = `
      <div id="leftover" data-rendered="no"><table role="grid">${rows(3, "stale")}</table></div>
      <div gh="mtb"></div>
      <div role="main" data-rendered="yes">
        <div gh="tl"><table role="grid">
          <tr role="row"><td><span>Sale 10-20 off 5000 items</span></td></tr>
        </table></div>
      </div>`;
    stubRendering();
    const I = load();
    expect(I.estimateTotalResults()).toBeNull();
  });

  test("the gate stays on when only the document element reports a box", () => {
    // The render test is the only thing standing between the walk and the
    // leftover pager: that pager sits BESIDE the stale list, not inside
    // it, so no grid rule reaches it. A gate that switches itself off
    // because one probe happens to have no box hands the bug straight
    // back, so it asks main, then body, then documentElement.
    document.body.innerHTML = twoGridPage({
      stalePager: "1-50 of 426",
      livePager: "Showing most relevant1-50 of many"
    });
    // ONLY <html> reports a box. main and body both report nothing, which
    // is the exact shape that switched the old single-probe gate off, and
    // with the gate off the leftover pager is eligible again: it sits
    // beside the stale list rather than inside it, so no grid rule
    // touches it. Probing main alone here returns 426.
    Element.prototype.checkVisibility = function checkVisibility() {
      return this === document.documentElement;
    };
    const I = load();
    expect(I.estimateTotalResults()).toBeNull();
  });

  test("the render gate stays inert where there is no layout to read", () => {
    // No checkVisibility stub: this is plain jsdom, and every counter the
    // rest of the suite relies on must keep resolving exactly as before.
    document.body.innerHTML = `
      <div gh="mtb"><span>1-50 of 12,438</span></div>
      <div role="main"><table role="grid">${rows(50, "live")}</table></div>`;
    const I = load();
    expect(I.estimateTotalResults()).toBe(12438);
  });
});

describe("per-row selection stays inside the list on screen", () => {
  test("it never clicks a checkbox belonging to the leftover list", async () => {
    document.body.innerHTML = twoGridPage({
      stalePager: "1-50 of 426",
      livePager: "Showing most relevant1-50 of many",
      staleRows: 4,
      liveRows: 3
    });
    stubRendering();
    const I = load();

    const clicked = [];
    for (const cb of document.querySelectorAll('[role="checkbox"]')) {
      cb.addEventListener("click", () => clicked.push(cb.closest("tr").id));
    }

    await I.selectAllVisibleRowsIndividually();

    expect(clicked).toHaveLength(3);
    expect(clicked.every((id) => id.startsWith("live"))).toBe(true);
    // The property, stated on its own so it survives a change of counts:
    // nothing outside div[role="main"] was touched.
    expect(clicked.some((id) => id.startsWith("stale"))).toBe(false);
  });
});
