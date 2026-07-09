/**
 * popup.html structure (7.3): the tabbed redesign moved nodes into new
 * containers without renaming them. popup.js addresses everything by
 * id, so this suite pins down (a) that every id it uses still exists,
 * (b) that each one landed in the right container, and (c) the tab
 * bar's ARIA contract. A silent id loss would otherwise surface only
 * as a dead button in manual testing.
 */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf-8");
const doc = new DOMParser().parseFromString(html, "text/html");
const byId = (id) => doc.getElementById(id);

// Every id popup.js looks up via $() plus the structural wrappers.
const POPUP_JS_IDS = [
  // core form controls
  "runCleanup", "status", "intensity", "actionType", "minAge",
  "dryRun", "reviewMode", "safeMode", "skipStarred", "skipImportant",
  "monthlyCleanBtn", "targetChips",
  // 7.3 layout
  "popupTabs", "tabClean", "tabUnsubscribe", "tabStorage",
  "tabPanelClean", "tabPanelUnsubscribe", "tabPanelStorage",
  "cleanForm", "cleanResult", "resultBackBtn",
  "reassurance", "advancedSection", "advancedContent",
  // banners
  "pinHint", "pinHintClose", "snoozeBanner", "snoozeBannerText",
  "gmailAccessBanner", "gmailAccessBtn",
  // run feedback
  "progressBar", "progressBarInner", "quickActions", "cancelBtn",
  "openProgressBtn", "resultSummary", "resultCount", "resultSize",
  "successCtas", "ratingPrompt", "ratingDismiss", "ratingBtn", "rateBtn",
  "shareBtn", "srStatus",
  // 7.4 post-run recap
  "recapNote",
  // chrome
  "toastContainer", "accountSelector", "wlSuggestions", "versionBadge",
  "openOptions", "openDiagnostics", "openStats", "themeSwitcher",
  "kbdHelpBtn", "keyboardHelp", "kbdHelpClose",
  "onboardingBackdrop", "onbNextBtn", "onbSkipBtn",
  // subscriptions
  "subsProPill", "scanSubsBtn", "subsStatus", "subsToolbar",
  "subsSelectAll", "subsCount", "subsList", "unsubBtn", "unsubBtnSub",
  "subsUpsell", "subsUpsellText", "subsBuyLink", "subsEnterKey",
  "footerProBtn", "proPromo", "proPromoBuy", "proPromoKey",
  // storage X-ray
  "xrayProPill", "xrayScanBtn", "xrayStatus", "xrayTotal", "xrayTotalMb",
  "xrayTotalSub", "xrayToolbar", "xraySelectAll", "xrayCount", "xrayList",
  "xrayAgeRow", "xrayAge", "xrayPurgeBtn", "xrayPurgeBtnSub",
  "xrayUpsell", "xrayUpsellText", "xrayBuyLink", "xrayEnterKey",
  // 7.8 Smart Suggestions
  "smartSection", "smartContent", "smartScanBtn", "smartStatus",
  "smartToolbar", "smartSelectAll", "smartCount", "smartList",
  "smartBulkBtn", "smartBulkBtnSub", "smartUpsell", "smartUpsellText",
  "smartBuyLink", "smartEnterKey"
];

describe("popup.html: id inventory", () => {
  test.each(POPUP_JS_IDS)("#%s exists", (id) => {
    expect(byId(id)).not.toBeNull();
  });

  test("no duplicate ids anywhere", () => {
    const seen = {};
    doc.querySelectorAll("[id]").forEach((el) => {
      seen[el.id] = (seen[el.id] || 0) + 1;
    });
    const dupes = Object.entries(seen).filter(([, n]) => n > 1);
    expect(dupes).toEqual([]);
  });
});

describe("popup.html: tab bar ARIA contract", () => {
  test("a tablist with exactly three tabs and three panels", () => {
    const bar = byId("popupTabs");
    expect(bar.getAttribute("role")).toBe("tablist");
    expect(bar.getAttribute("aria-label")).toBeTruthy();
    expect(bar.querySelectorAll("[role=tab]").length).toBe(3);
    expect(doc.querySelectorAll("[role=tabpanel]").length).toBe(3);
  });

  test("each tab controls an existing panel that labels itself back", () => {
    doc.querySelectorAll("[role=tab]").forEach((tab) => {
      const panel = byId(tab.getAttribute("aria-controls"));
      expect(panel).not.toBeNull();
      expect(panel.getAttribute("role")).toBe("tabpanel");
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
      // Scrollable panels need to be focusable for keyboard users.
      expect(panel.getAttribute("tabindex")).toBe("0");
    });
  });

  test("Clean is the default: selected tab, visible panel, roving tabindex", () => {
    expect(byId("tabClean").getAttribute("aria-selected")).toBe("true");
    expect(byId("tabClean").getAttribute("tabindex")).toBe("0");
    expect(byId("tabUnsubscribe").getAttribute("aria-selected")).toBe("false");
    expect(byId("tabUnsubscribe").getAttribute("tabindex")).toBe("-1");
    expect(byId("tabStorage").getAttribute("aria-selected")).toBe("false");
    expect(byId("tabPanelClean").hasAttribute("hidden")).toBe(false);
    expect(byId("tabPanelUnsubscribe").hasAttribute("hidden")).toBe(true);
    expect(byId("tabPanelStorage").hasAttribute("hidden")).toBe(true);
  });
});

describe("popup.html: nodes landed in the right containers", () => {
  const within = (childId, parentId) => byId(parentId).contains(byId(childId));

  test("Clean panel owns the form, run button and result area", () => {
    ["cleanForm", "monthlyCleanBtn", "targetChips", "advancedSection",
      "runCleanup", "progressBar", "quickActions", "status", "cleanResult",
      "reassurance", "wlSuggestions"].forEach((id) => {
      expect(within(id, "tabPanelClean")).toBe(true);
    });
  });

  test("the Advanced disclosure holds strategy selects and safety toggles", () => {
    ["intensity", "actionType", "minAge", "dryRun", "reviewMode",
      "safeMode", "skipStarred", "skipImportant"].forEach((id) => {
      expect(within(id, "advancedSection")).toBe(true);
    });
    expect(byId("advancedSection").tagName).toBe("DETAILS");
    // Collapsed by default; popup.js restores the persisted state.
    expect(byId("advancedSection").hasAttribute("open")).toBe(false);
  });

  test("the reassurance block ships open and sits on the Clean tab", () => {
    expect(byId("reassurance").tagName).toBe("DETAILS");
    expect(byId("reassurance").hasAttribute("open")).toBe(true);
    expect(within("reassurance", "cleanForm")).toBe(true);
  });

  test("the Suggested section leads the Clean tab, collapsed by default", () => {
    const smart = byId("smartSection");
    expect(smart.tagName).toBe("DETAILS");
    // Collapsed on a fresh install so the Clean tab keeps the 600px
    // height budget; popup.js restores the persisted open state.
    expect(smart.hasAttribute("open")).toBe(false);
    expect(within("smartSection", "cleanForm")).toBe(true);
    // At the TOP: before the reassurance block, not a fourth tab.
    expect(smart.compareDocumentPosition(byId("reassurance")) &
      Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(byId("popupTabs").querySelectorAll("[role=tab]").length).toBe(3);
  });

  test("the Suggested section owns all its controls", () => {
    ["smartContent", "smartScanBtn", "smartStatus", "smartToolbar",
      "smartSelectAll", "smartCount", "smartList", "smartBulkBtn",
      "smartBulkBtnSub", "smartUpsell", "smartUpsellText", "smartBuyLink",
      "smartEnterKey"].forEach((id) => {
      expect(within(id, "smartSection")).toBe(true);
    });
    // Toolbar, bulk button and upsell ship hidden; the scan reveals them.
    expect(byId("smartToolbar").hasAttribute("hidden")).toBe(true);
    expect(byId("smartBulkBtn").hasAttribute("hidden")).toBe(true);
    expect(byId("smartUpsell").hasAttribute("hidden")).toBe(true);
  });

  test("the result view wraps summary, CTAs, rating and the way back", () => {
    ["resultSummary", "successCtas", "ratingPrompt", "resultBackBtn"].forEach((id) => {
      expect(within(id, "cleanResult")).toBe(true);
    });
    expect(byId("cleanResult").hasAttribute("hidden")).toBe(true);
    expect(byId("cleanForm").hasAttribute("hidden")).toBe(false);
  });

  test("the recap note sits inside the result region and ships hidden", () => {
    // Inside #resultSummary (the role=region screen readers announce),
    // which itself lives inside #cleanResult.
    expect(within("recapNote", "resultSummary")).toBe(true);
    expect(within("recapNote", "cleanResult")).toBe(true);
    expect(byId("recapNote").hasAttribute("hidden")).toBe(true);
    expect(byId("resultSummary").getAttribute("role")).toBe("region");
  });

  test("Unsubscribe panel owns the subscription controls, no details wrapper", () => {
    ["scanSubsBtn", "subsStatus", "subsToolbar", "subsList", "unsubBtn",
      "subsUpsell", "subsUpsellText", "subsProPill"].forEach((id) => {
      expect(within(id, "tabPanelUnsubscribe")).toBe(true);
    });
    expect(byId("subscriptionsSection")).toBeNull();
  });

  test("Storage panel owns the X-ray controls, no details wrapper", () => {
    ["xrayScanBtn", "xrayStatus", "xrayTotal", "xrayToolbar", "xrayList",
      "xrayAgeRow", "xrayPurgeBtn", "xrayUpsell", "xrayUpsellText",
      "xrayProPill"].forEach((id) => {
      expect(within(id, "tabPanelStorage")).toBe(true);
    });
    expect(byId("storageXraySection")).toBeNull();
  });

  test("banners, account selector, footer and Pro promo sit outside every panel", () => {
    const panels = ["tabPanelClean", "tabPanelUnsubscribe", "tabPanelStorage"];
    ["pinHint", "snoozeBanner", "gmailAccessBanner", "accountSelector", "proPromo"]
      .forEach((id) => {
        panels.forEach((panel) => {
          expect(byId(panel).contains(byId(id))).toBe(false);
        });
      });
    const footer = doc.querySelector("footer.footer");
    expect(footer).not.toBeNull();
    panels.forEach((panel) => expect(byId(panel).contains(footer)).toBe(false));
  });

  test("upsell paragraphs start with the swappable text span", () => {
    expect(byId("subsUpsell").firstElementChild.id).toBe("subsUpsellText");
    expect(byId("xrayUpsell").firstElementChild.id).toBe("xrayUpsellText");
    expect(byId("smartUpsell").firstElementChild.id).toBe("smartUpsellText");
    expect(byId("subsUpsellText").textContent).toContain("$5");
    expect(byId("xrayUpsellText").textContent).toContain("$5");
    expect(byId("smartUpsellText").textContent).toContain("$5");
  });
});

describe("popup.html: accessibility fixtures survived the restructure", () => {
  test("live regions and sr-only status are intact", () => {
    expect(byId("srStatus").getAttribute("aria-live")).toBe("polite");
    expect(byId("status").getAttribute("role")).toBe("status");
    expect(byId("progressBar").getAttribute("role")).toBe("progressbar");
    expect(byId("subsStatus").getAttribute("aria-live")).toBe("polite");
    expect(byId("xrayStatus").getAttribute("aria-live")).toBe("polite");
  });

  test("modals keep their dialog semantics", () => {
    expect(byId("onboardingBackdrop").getAttribute("role")).toBe("dialog");
    expect(byId("keyboardHelp").getAttribute("role")).toBe("dialog");
  });

  test("switch inputs keep their roles", () => {
    ["dryRun", "reviewMode", "safeMode", "skipStarred", "skipImportant"].forEach((id) => {
      expect(byId(id).getAttribute("role")).toBe("switch");
    });
  });
});
