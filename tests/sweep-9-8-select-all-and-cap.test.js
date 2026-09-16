/**
 * @jest-environment node
 *
 * 9.8, the two quality-of-life halves of the same fact: a sender list
 * has a cap, and the cap should be visible before the button is pressed
 * rather than in a toast afterwards.
 *
 *  - The census was the only ranked sender list with no Select all. The
 *    Unsubscribe, Storage and Suggested lists have had one for releases,
 *    and the census is the longest of them at up to sixty rows.
 *  - The Storage X-ray purge has taken the first twenty-five since 8.0.
 *    8.11 added a toast saying so, which lands after the press. The
 *    count line beside its Select all now says it beforehand, the same
 *    line the census Clear subtitle grew in this release.
 */
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf-8");
const POPUP_JS = read("popup.js");
const POPUP_HTML = read("popup.html");
const SHARED = read("shared.js");
// eslint-disable-next-line no-new-func
const GCC = new Function(SHARED + "\nreturn GCC;")();

const between = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to));

describe("the census list has a Select all, like its three siblings", () => {
  test("the markup carries the toolbar, hidden until there is something to tick", () => {
    expect(POPUP_HTML).toContain('id="censusToolbar"');
    expect(POPUP_HTML).toContain('id="censusSelectAll"');
    expect(POPUP_HTML).toContain('id="censusCount"');
    const toolbar = between(POPUP_HTML, 'id="censusToolbar"', 'id="censusList"');
    expect(toolbar).toContain('data-i18n="selectAll"');
  });

  test("it is wired to the set the rows own, not to the checkboxes", () => {
    const handler = between(
      POPUP_JS,
      'elements.censusSelectAll?.addEventListener',
      'elements.censusBuyLink?.addEventListener'
    );
    expect(handler).toContain("state.census.checked.add(sender.email)");
    expect(handler).toContain("state.census.checked.delete(sender.email)");
    expect(handler).toContain("renderCensusList()");
    expect(handler).toContain("persistCensusSelection()");
  });

  test("a free licence can only select the rows it can see", () => {
    const handler = between(
      POPUP_JS,
      'elements.censusSelectAll?.addEventListener',
      'elements.censusBuyLink?.addEventListener'
    );
    expect(handler).toContain("GCC.census.LIMITS.FREE_LIST");
    // The box itself is disabled without a licence, so the toolbar
    // cannot be used to tick a list the rows below refuse to tick.
    const render = between(POPUP_JS, "const renderCensusList =", "const updateCensusPurgeButton =");
    expect(render).toContain("elements.censusToolbar.hidden = !pro");
    expect(render).toContain("elements.censusSelectAll.disabled = !pro");
  });

  test("the box reflects the selection, so it is already ticked on reopen", () => {
    const render = between(POPUP_JS, "const renderCensusList =", "const updateCensusPurgeButton =");
    expect(render).toContain("visible.every((s) => state.census.checked.has(s.email))");
  });

  test("the count line uses the catalogue keys the other lists use", () => {
    const fn = between(POPUP_JS, "const updateCensusCount =", "const renderCensusList =");
    expect(fn).toContain("nOfMSelected");
    expect(fn).toContain("nSendersRanked");
    expect(fn).toContain("oneSenderRanked");
  });
});

describe("the X-ray says its cap before the press", () => {
  const fn = between(POPUP_JS, "const updateXrayCount =", "const renderXrayTotals =");

  test("the count line names how many the run takes and how many are left", () => {
    expect(fn).toContain("GCC.storageXray.LIMITS.MAX_PURGE_PER_RUN");
    expect(fn).toContain("purgeStranded");
  });

  test("it only appears once the selection is past the cap", () => {
    expect(fn).toContain("if (checked > cap)");
  });

  test("the after-the-fact toast is still there, because the cap can also bite on invalid rows", () => {
    expect(POPUP_JS).toContain("xrayPurgeCapped");
  });
});

describe("one catalogue line serves both surfaces", () => {
  test("purgeStranded is not named after either of them", () => {
    expect(POPUP_JS).not.toContain("censusPurgeStranded");
    expect(POPUP_JS).not.toContain("xrayPurgeStranded");
  });

  test("the two caps it reports are the ones the two runs really apply", () => {
    expect(GCC.census.LIMITS.MAX_RULE_SENDERS).toBe(25);
    expect(GCC.storageXray.LIMITS.MAX_PURGE_PER_RUN).toBe(25);
  });
});
