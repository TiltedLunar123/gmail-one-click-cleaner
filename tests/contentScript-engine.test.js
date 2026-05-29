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

function loadEngine() {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = {};
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
