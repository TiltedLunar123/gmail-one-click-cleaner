/**
 * @jest-environment jsdom
 *
 * Engine-level tests for contentScript.js. The content script is a
 * self-running IIFE; under window.GCC_TEST_MODE it exposes its internals
 * on window.GCC_INTERNALS. It bails out of an actual cleanup run because
 * jsdom's host isn't mail.google.com, so loading it is side-effect free.
 *
 * Covers the 6.0 additions (focused rule overrides, the overflow-menu
 * label finders) plus previously untested selection detection.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function loadEngine(config = {}) {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  // The engine freezes CONFIG from window.GMAIL_CLEANER_CONFIG at load
  // time, so inject the run config here when a test needs applyGlobalGuards
  // to see specific guards.
  window.GMAIL_CLEANER_CONFIG = config;
  window.alert = () => {};
  document.body.innerHTML = "";
  // Run the IIFE in a fresh function scope; it reads global window/chrome.
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

describe("contentScript engine internals", () => {
  test("exposes internals under GCC_TEST_MODE", () => {
    const I = loadEngine();
    expect(I).toBeTruthy();
    expect(typeof I.sanitizeConfig).toBe("function");
  });

  describe("sanitizeConfig rulesOverride (6.0 focused presets)", () => {
    test("keeps safe entries, drops blanks and dangerous tokens", () => {
      const I = loadEngine();
      const out = I.sanitizeConfig({
        rulesOverride: [
          "category:promotions older_than:3m",
          "  ",
          "is:starred",            // dangerous -> dropped
          "label:important",       // dangerous -> dropped
          "has:attachment larger:10M"
        ]
      });
      expect(out.rulesOverride).toEqual([
        "category:promotions older_than:3m",
        "has:attachment larger:10M"
      ]);
    });

    test("defaults to an empty array when absent or wrong type", () => {
      const I = loadEngine();
      expect(I.sanitizeConfig({}).rulesOverride).toEqual([]);
      expect(I.sanitizeConfig({ rulesOverride: "nope" }).rulesOverride).toEqual([]);
    });

    test("caps override at 25 entries", () => {
      const I = loadEngine();
      const many = Array.from({ length: 40 }, (_, i) => `category:promotions older_than:${i + 1}d`);
      expect(I.sanitizeConfig({ rulesOverride: many }).rulesOverride).toHaveLength(25);
    });
  });

  describe("extractSelectedCount", () => {
    test("counts selected (x7) rows in the grid", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main"><table role="grid">
          <tr role="row" class="x7"><td role="gridcell"></td></tr>
          <tr role="row" class="x7"><td role="gridcell"></td></tr>
          <tr role="row"><td role="gridcell"></td></tr>
        </table></div>`;
      expect(I.extractSelectedCount()).toBe(2);
    });

    test("falls back to checked row checkboxes when no x7 class", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main"><table role="grid">
          <tr role="row"><td><span role="checkbox" aria-checked="true"></span></td></tr>
          <tr role="row"><td><span role="checkbox" aria-checked="false"></span></td></tr>
        </table></div>`;
      expect(I.extractSelectedCount()).toBe(1);
    });
  });

  describe("findLabelMenuItemIn (overflow menu)", () => {
    test("finds the 'Label as' item inside a role=menu", () => {
      const I = loadEngine();
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.innerHTML = `
        <div role="menuitem" aria-label="Snooze">Snooze</div>
        <div role="menuitem" aria-label="Label as">Label as</div>
        <div role="menuitem" aria-label="Mark as read">Mark as read</div>`;
      const item = I.findLabelMenuItemIn(menu);
      expect(item).not.toBeNull();
      expect(item.getAttribute("aria-label")).toBe("Label as");
    });

    test("returns null when no label item is present", () => {
      const I = loadEngine();
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.innerHTML = `<div role="menuitem" aria-label="Snooze">Snooze</div>`;
      expect(I.findLabelMenuItemIn(menu)).toBeNull();
    });
  });

  describe("findMoreOptionsButton (overflow trigger)", () => {
    test("prefers the popup-bearing 'More' button in the toolbar", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div gh="mtb">
          <div role="button" aria-label="Archive"></div>
          <div role="button" aria-label="More email options" aria-haspopup="true"></div>
        </div>`;
      const btn = I.findMoreOptionsButton();
      expect(btn).not.toBeNull();
      expect(btn.getAttribute("aria-label")).toBe("More email options");
    });
  });

  describe("findAllConversationsSelectedIndicator", () => {
    test("detects the 'all N conversations are selected' banner", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main"><span>All 1,234 conversations are selected</span></div>`;
      expect(I.findAllConversationsSelectedIndicator()).toBe(true);
    });

    test("is false on an ordinary results page", () => {
      const I = loadEngine();
      document.body.innerHTML = `<div role="main"><span>Promotions</span></div>`;
      expect(I.findAllConversationsSelectedIndicator()).toBe(false);
    });
  });

  describe("sanitizeConfig protectKeywords (6.1 subject shield)", () => {
    test("sanitizes + dedupes keywords, dropping blanks and operators", () => {
      const I = loadEngine();
      const out = I.sanitizeConfig({
        protectKeywords: ["  tax ", "TAX", "", "OR", '"flight confirmation"']
      });
      expect(out.protectKeywords).toEqual(["tax", "flight confirmation"]);
    });

    test("defaults to an empty array when absent or wrong type", () => {
      const I = loadEngine();
      expect(I.sanitizeConfig({}).protectKeywords).toEqual([]);
      expect(I.sanitizeConfig({ protectKeywords: 42 }).protectKeywords).toEqual([]);
    });

    test("caps at 25 entries", () => {
      const I = loadEngine();
      const many = Array.from({ length: 40 }, (_, i) => `kw${i}`);
      expect(I.sanitizeConfig({ protectKeywords: many }).protectKeywords).toHaveLength(25);
    });
  });

  describe("buildSubjectExclusion (engine copy)", () => {
    test("quotes phrases only and returns '' when empty", () => {
      const I = loadEngine();
      expect(I.buildSubjectExclusion(["tax", "flight confirmation"]))
        .toBe('-subject:(tax OR "flight confirmation")');
      expect(I.buildSubjectExclusion([])).toBe("");
    });
  });

  describe("applyGlobalGuards protected keywords", () => {
    test("appends a -subject:(...) shield when keywords are configured", () => {
      const I = loadEngine({
        protectKeywords: ["tax", "flight confirmation"],
        // turn the other guards off so the assertion is focused
        guardSkipStarred: false,
        guardSkipImportant: false,
        guardSkipUnread: false,
        guardSkipUserLabels: false
      });
      const guarded = I.applyGlobalGuards("category:promotions older_than:3m");
      expect(guarded).toContain("category:promotions older_than:3m");
      expect(guarded).toContain('-subject:(tax OR "flight confirmation")');
    });

    test("adds no shield clause when no keywords are configured", () => {
      const I = loadEngine({
        guardSkipStarred: false,
        guardSkipImportant: false,
        guardSkipUnread: false,
        guardSkipUserLabels: false
      });
      const guarded = I.applyGlobalGuards("category:promotions older_than:3m");
      expect(guarded).not.toContain("-subject:(");
    });

    test("coexists with the Safe-Mode subject guard as a separate clause", () => {
      const I = loadEngine({
        safeMode: true,
        protectKeywords: ["lease"],
        guardSkipStarred: false,
        guardSkipImportant: false,
        guardSkipUnread: false,
        guardSkipUserLabels: false
      });
      const guarded = I.applyGlobalGuards("category:promotions older_than:3m");
      // both the hardcoded receipt guard and the user keyword guard present
      expect(guarded).toContain("-subject:(receipt");
      expect(guarded).toContain("-subject:(lease)");
    });
  });

  describe("gmail layout-change detection (7.4)", () => {
    // The two hard signals abort with a GmailLayoutError that rides the
    // existing phase:"error" message (plus the additive code field).
    // Empty result sets are NORMAL and must never trip either one.

    const RESULTS_NO_CHECKBOXES = `
      <div role="main">
        <div gh="mtb"><div role="button" aria-label="Delete"></div></div>
        <table role="grid">
          <tr role="row"><td role="gridcell">Old promo one</td></tr>
          <tr role="row"><td role="gridcell">Old promo two</td></tr>
        </table>
      </div>`;

    test("(a) results on screen but no selection control anywhere aborts with the layout code", async () => {
      const I = loadEngine();
      document.body.innerHTML = RESULTS_NO_CHECKBOXES;
      let thrown = null;
      try {
        await I.actOnCurrentPageIfAny(null);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      expect(thrown.name).toBe("GmailLayoutError");
      expect(thrown.code).toBe("gmail_layout_changed");
      expect(thrown.message).toContain("Gmail changed its layout");
      expect(thrown.message).toContain("Nothing was touched beyond what already completed");
      expect(thrown.message).toContain("An update usually follows within days");
    });

    test("(a) building block: rows without checkboxes report the checkbox as not-found", async () => {
      const I = loadEngine();
      document.body.innerHTML = RESULTS_NO_CHECKBOXES;
      const result = await I.clickMasterCheckbox();
      expect(result).toEqual({ success: false, reason: "not-found" });
      expect(I.getGridRowCount()).toBe(2);
    });

    test("zero matches is normal: an empty grid returns 'No results', no error", async () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main">
          <div gh="mtb"><div role="button" aria-label="Delete"></div></div>
          <table role="grid"></table>
        </div>`;
      const result = await I.actOnCurrentPageIfAny(null);
      expect(result).toEqual({ deleted: false, count: 0, reason: "No results" });
      expect(I.hasNoResults()).toBe(true);
      expect(I.getGridRowCount()).toBe(0);
    });

    test("zero matches via Gmail's empty-state cell is normal too", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main"><table><tr><td class="TC">Nothing here</td></tr></table></div>`;
      expect(I.hasNoResults()).toBe(true);
    });

    test("(b) no Labels button, no More menu, dead hotkey aborts with the layout code", async () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main">
          <div gh="mtb">
            <div role="button" aria-label="Delete"></div>
            <div role="button" aria-label="Archive"></div>
          </div>
        </div>`;
      let thrown = null;
      try {
        await I.openLabelInput();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      expect(thrown.name).toBe("GmailLayoutError");
      expect(thrown.code).toBe("gmail_layout_changed");
      expect(thrown.message).toContain("More email options");
    });

    test("(b) a present More button that fails to open stays a soft null, not an error", async () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main">
          <div gh="mtb">
            <div role="button" aria-label="More email options" aria-haspopup="true"></div>
          </div>
        </div>`;
      await expect(I.openLabelInput()).resolves.toBeNull();
    });

    test("(b) the hotkey fallback finding an input suppresses the error", async () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main"><div gh="mtb"></div></div>
        <div role="dialog"><input type="text" aria-label="Label as" /></div>`;
      const input = await I.openLabelInput();
      expect(input).not.toBeNull();
      expect(input.getAttribute("aria-label")).toBe("Label as");
    });
  });

  describe("buildFinalStats popup/notification contract", () => {
    test("includes the fields the popup and SW read on completion", () => {
      const I = loadEngine();
      const s = I.buildFinalStats(3);
      // popup done-handler reads: action, runCount, totalFreedMb, totalDeleted
      expect(s).toHaveProperty("action");
      expect(["delete", "archive"]).toContain(s.action);
      expect(s).toHaveProperty("runCount");
      expect(s).toHaveProperty("totalFreedMb");
      expect(s).toHaveProperty("totalDeleted");
      expect(s).toHaveProperty("mode");
    });
  });
});
