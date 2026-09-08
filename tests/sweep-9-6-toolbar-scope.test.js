/**
 * @jest-environment jsdom
 *
 * 9.6: the finder that produces the control the engine CLICKS to delete
 * mail was the one walk in this file with no scope against sender
 * markup.
 *
 * restoreCandidates has refused three things since 7.6: a control inside
 * a list row, a control inside the message body, and anything marked
 * "Delete forever". 8.12 ported the third to findButtonByTokens, wrote a
 * comment naming the other two as things restoreCandidates does, and
 * left them behind. With Gmail's toolbar on the page that costs nothing,
 * because the search is scoped to `div[gh='mtb']` and no message body is
 * reachable from there. With the toolbar absent the default dropped to
 * `document`, and `<div role="button" aria-label="Delete">` is markup a
 * sender writes for free: 9.4 proved role and aria-label both survive
 * into `div.a3s`.
 *
 * These assert the PROPERTY (nothing a sender controls is ever returned)
 * rather than the arithmetic of the scoring, because the 8.18 ink bar
 * and t18-nine-one both turned correct fixes red by pinning numbers.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function loadEngine(config = {}) {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = config;
  window.alert = () => {};
  document.body.innerHTML = "";
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

// No div[gh='mtb'] and no div[role='toolbar']: the layout change the
// engine already ships GmailLayoutError for. The only thing on the page
// that reads as a control is the one the sender put in their own body.
const noToolbarPage = (label) => `
  <div role="main">
    <table role="grid">
      <tr role="row"><td role="gridcell">
        <div class="a3s">
          <div role="button" aria-label="${label}">${label}</div>
        </div>
      </td></tr>
    </table>
  </div>`;

describe("a sender's own markup is never the control the engine clicks", () => {
  const cases = [
    ["findDeleteButton", "Delete"],
    ["findArchiveButton", "Archive"],
    ["findLabelButton", "Labels"],
    ["findMoreOptionsButton", "More email options"]
  ];

  for (const [finder, label] of cases) {
    test(`${finder} refuses a control planted in the message body`, () => {
      const api = loadEngine();
      document.body.innerHTML = noToolbarPage(label);
      const found = api[finder]();
      // Null is the right answer and is one this file already handles:
      // every caller reads "no control" as a layout problem and stops.
      expect(found).toBeNull();
    });
  }

  test("a control planted in a conversation row is refused too", () => {
    const api = loadEngine();
    // Same node, outside div.a3s. A row carries per-row text the sender
    // also chose, which is why restoreCandidates refuses both.
    document.body.innerHTML = `
      <div role="main">
        <table role="grid">
          <tr role="row"><td role="gridcell">
            <div role="button" aria-label="Delete">Delete</div>
          </td></tr>
        </table>
      </div>`;
    expect(api.findDeleteButton()).toBeNull();
  });

  test("an anchor is refused, whatever its label says", () => {
    const api = loadEngine();
    // Gmail's toolbar controls are divs. Clicking an anchor navigates
    // the tab to wherever it points, which is the 9.4 failure: the
    // navigation tears the content script down mid-run.
    document.body.innerHTML = `
      <div gh="mtb">
        <a href="https://example.invalid/x" role="button" aria-label="Delete">Delete</a>
      </div>`;
    expect(api.findDeleteButton()).toBeNull();
  });

  test("a button wrapped in an anchor is refused as well", () => {
    const api = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <a href="https://example.invalid/x"><div role="button" aria-label="Delete">Delete</div></a>
      </div>`;
    expect(api.findDeleteButton()).toBeNull();
  });
});

describe("the real toolbar still wins", () => {
  test("Gmail's own Delete control is found with sender markup on the page", () => {
    const api = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div gh="mtb">
          <div role="button" aria-label="Delete" id="real"></div>
        </div>
        <table role="grid">
          <tr role="row"><td role="gridcell">
            <div class="a3s"><div role="button" aria-label="Delete trash bin">nope</div></div>
          </td></tr>
        </table>
      </div>`;
    const found = api.findDeleteButton();
    expect(found).not.toBeNull();
    expect(found.id).toBe("real");
  });

  test("a toolbar Gmail rendered somewhere unexpected is still reachable", () => {
    const api = loadEngine();
    // The document fallback is kept rather than deleted the way 9.3
    // deleted getMainRoot's, because that one handed back a STALE grid
    // and this one is only unscoped. With the filters applied it can no
    // longer return anything a sender controls, so refusing outright
    // would turn every unrecognised layout into a stopped run for no
    // safety gained.
    document.body.innerHTML = `
      <div id="somewhere-else">
        <div role="button" aria-label="Delete" id="real"></div>
      </div>`;
    const found = api.findDeleteButton();
    expect(found).not.toBeNull();
    expect(found.id).toBe("real");
  });

  test("Delete forever is still refused before scoring", () => {
    const api = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="Delete forever"></div>
      </div>`;
    expect(api.findDeleteButton()).toBeNull();
  });
});

describe("one walk, not two", () => {
  const source = SRC;

  test("the acting finders and the restore finders share it", () => {
    // The whole defect was two copies of the same walk with different
    // filters. Pin that there is one, by name, so a sixth finder cannot
    // be written with its own.
    const walk = source.slice(
      source.indexOf("function toolbarCandidates(root)"),
      source.indexOf("function findButtonByTokens")
    );
    for (const filter of [
      `tr[role='row']`,
      "SELECTORS.messageBody",
      "isNavigable",
      "hasDeleteForeverMarking"
    ]) {
      expect(walk).toContain(filter);
    }
    // restoreCandidates delegates rather than re-declaring the list.
    const restore = source.slice(
      source.indexOf("function restoreCandidates(root)"),
      source.indexOf("function restoreCandidates(root)") + 200
    );
    expect(restore).toContain("toolbarCandidates(root)");
    // And no finder builds its own button list any more: the walk
    // appears exactly once in the file, inside toolbarCandidates.
    const walks = source.match(/qsa\("div\[role='button'\], button, span\[role='button'\]"/g) || [];
    expect(walks).toHaveLength(1);
    expect(walk).toContain(`qsa("div[role='button'], button, span[role='button']"`);
  });
});
