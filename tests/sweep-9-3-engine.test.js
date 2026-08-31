/**
 * @jest-environment jsdom
 *
 * 9.3, engine side: the rest of getMainRoot's `|| document`.
 *
 * Not on a mail.google.com URL, for the reason the 8.25 suite gives:
 * evaluating contentScript.js on a mailbox URL boots a run that keeps
 * navigating for the length of the file. Off a mailbox, isGmailTab
 * refuses at the first line and every function below is left exactly as
 * written.
 *
 * 8.22 found that Gmail leaves the previous conversation list in the
 * page while it renders a search: laid out, outside div[role="main"] and
 * ahead of the results in document order, with its own grid, its own
 * selection bar and its own reading view. 8.25 then found that
 * `getMainRoot()` answers `document` when main is missing, which hands
 * that leftover straight back, and it closed the five call sites that
 * read conversation ROWS.
 *
 * Four readers were left on the fallback, and two of them do not read a
 * row, they return a control that gets CLICKED: the select-all-matching
 * link, whose click is what turns a page delete into a whole-result-set
 * delete, and the header Unsubscribe control, which cannot be undone.
 * The other two answer questions the run then acts on: whether the whole
 * match set is selected, and whether the page is empty.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function load() {
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = { runKind: "cleanup" };
  window.alert = () => {};
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

// Everything Gmail leaves behind for a beat, and no div[role="main"].
const LEFTOVER = `
  <div id="leftover">
    <div class="aeH">
      <span role="link" id="staleOffer">Select all 426 conversations that match this search</span>
      <span id="staleAllSelected">All 426 conversations are selected</span>
    </div>
    <div id="staleReader">
      <span role="link" class="Ca" id="staleUnsub">Unsubscribe</span>
    </div>
    <table role="grid"><tr role="row" id="stale0"><td class="xY a4W"></td></tr></table>
  </div>
  <div gh="mtb"></div>`;

// The same page one beat later: main has rendered, and it holds the real
// controls. Nothing about these answers may change.
const RENDERED = `
  <div id="leftover">
    <div class="aeH"><span role="link" id="staleOffer">Select all 426 conversations that match this search</span></div>
  </div>
  <div role="main">
    <div class="aeH">
      <span role="link" id="liveOffer">Select all 12 conversations that match this search</span>
    </div>
    <span role="link" class="Ca" id="liveUnsub">Unsubscribe</span>
    <table role="grid"><tr role="row" id="live0"><td class="xY a4W"></td></tr></table>
  </div>`;

beforeEach(() => {
  document.body.innerHTML = "";
  chrome.runtime.sendMessage = jest.fn();
  chrome.runtime.onMessage = { addListener: jest.fn() };
});

describe("no div[role='main'], no answers off the leftover", () => {
  test("the select-all-matching link is not offered", () => {
    document.body.innerHTML = LEFTOVER;
    const I = load();
    // Returning the stale one is not a wrong label on a screen. The
    // caller clicks it, and a click that lands on the previous search's
    // offer selects conversations the current query never matched.
    expect(I.findSelectAllConversationsLink()).toBeNull();
  });

  test("the whole match set is not claimed as selected", () => {
    // The leftover of a search whose select-all DID land: the offer is
    // spent, the confirmation is what remains. That matters, because the
    // structural disproof this function runs first is "the offer is
    // still on screen", and a spent banner disproves nothing.
    document.body.innerHTML = `
      <div id="leftover">
        <div class="aeH"><span id="staleAllSelected">All 426 conversations are selected</span></div>
      </div>`;
    const I = load();
    expect(I.findAllConversationsSelectedIndicator()).toBe(false);
  });

  test("the header Unsubscribe control is not handed over", () => {
    document.body.innerHTML = LEFTOVER;
    const I = load();
    // Every other guard on this function is about WHOSE markup the
    // control is (never the message body, never a list row). None of
    // them asks whether it belongs to the message on screen now.
    expect(I.findHeaderUnsubscribeControl()).toBeNull();
  });

  test("an empty state left behind is not this page's answer", () => {
    document.body.innerHTML =
      `<div id="leftover"><table><tr><td class="TC">No messages matched your search.</td></tr></table></div>`;
    const I = load();
    // "Could not tell" is false here, not true: true ends the query, and
    // ending it on somebody else's empty state loses the run silently.
    // The row lookups have refused since 8.25, so carrying on finds
    // nothing rather than acting on the leftover.
    expect(I.hasNoResults()).toBe(false);
  });

  test("a leftover grid is not this page's results either", () => {
    document.body.innerHTML = LEFTOVER;
    const I = load();
    expect(I.hasNoResults()).toBe(false);
  });
});

describe("with main present nothing changed", () => {
  test("the live offer wins over the leftover one", () => {
    document.body.innerHTML = RENDERED;
    const I = load();
    expect(I.findSelectAllConversationsLink()?.id).toBe("liveOffer");
  });

  test("the live Unsubscribe control is still found", () => {
    document.body.innerHTML = RENDERED;
    const I = load();
    expect(I.findHeaderUnsubscribeControl()?.id).toBe("liveUnsub");
  });

  test("a main holding rows is not empty", () => {
    document.body.innerHTML = RENDERED;
    const I = load();
    expect(I.hasNoResults()).toBe(false);
  });

  test("a main holding an empty state is empty", () => {
    document.body.innerHTML =
      `<div role="main"><table><tr><td class="TC">No messages matched your search.</td></tr></table></div>`;
    const I = load();
    expect(I.hasNoResults()).toBe(true);
  });

  test("a main holding a grid with no rows is empty", () => {
    document.body.innerHTML = `<div role="main"><table role="grid"></table></div>`;
    const I = load();
    expect(I.hasNoResults()).toBe(true);
  });
});

describe("the fallback is gone rather than avoided", () => {
  // 8.25 closed five call sites and left the helper standing, which is
  // how four more survived on it. A helper that reads well at a call
  // site and is wrong at every one of them should not be available to
  // the next call site, so it is not declared any more.
  test("nothing widens a missing main to the document", () => {
    expect(SRC).not.toMatch(/qs\(SELECTORS\.main\)\s*\|\|\s*document/);
  });

  test("getMainRoot is not declared", () => {
    expect(SRC).not.toMatch(/(const|let|function)\s+getMainRoot\b/);
  });
});
