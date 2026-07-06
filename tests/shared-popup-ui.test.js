/**
 * @jest-environment node
 *
 * GCC.popupUi (7.3): pure decision logic behind the tabbed popup.
 * Banner arbitration, the rating-prompt threshold, the reassurance
 * default, and the number-led upsell lines are all plain functions, so
 * they get direct coverage here.
 */
const fs = require("fs");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const iifeMatch = code.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
  {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      className: "", setAttribute: () => {}, appendChild: () => {},
      style: {}, classList: { add: () => {}, remove: () => {} },
      remove: () => {}
    }),
    addEventListener: () => {}
  },
  {},
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

const UI = GCC.popupUi;

describe("GCC.popupUi.pickBanner", () => {
  test("no banner when nothing is eligible", () => {
    expect(UI.pickBanner({})).toBeNull();
    expect(UI.pickBanner()).toBeNull();
  });

  test("gmail access outranks everything", () => {
    expect(UI.pickBanner({ accessNeeded: true, snoozed: true, pinEligible: true })).toBe("access");
    expect(UI.pickBanner({ accessNeeded: true, snoozed: false, pinEligible: false })).toBe("access");
  });

  test("snooze outranks the pin hint", () => {
    expect(UI.pickBanner({ accessNeeded: false, snoozed: true, pinEligible: true })).toBe("snooze");
  });

  test("pin hint shows only when it is the sole candidate", () => {
    expect(UI.pickBanner({ pinEligible: true })).toBe("pin");
    expect(UI.pickBanner({ snoozed: true, pinEligible: false })).toBe("snooze");
  });
});

describe("GCC.popupUi.ratingRunQualifies", () => {
  test("dry runs never qualify, no matter the size", () => {
    expect(UI.ratingRunQualifies({ dryRun: true, cleaned: 100000, freedMb: 5000 })).toBe(false);
  });

  test("qualifies at 200 cleaned emails, not at 199", () => {
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 200, freedMb: 0 })).toBe(true);
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 199, freedMb: 0 })).toBe(false);
  });

  test("qualifies at 100 MB freed, not just under", () => {
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 0, freedMb: 100 })).toBe(true);
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 0, freedMb: 99.9 })).toBe(false);
  });

  test("either threshold alone is enough", () => {
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 500, freedMb: 1 })).toBe(true);
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 5, freedMb: 300 })).toBe(true);
  });

  test("garbage input is treated as a small run", () => {
    expect(UI.ratingRunQualifies({})).toBe(false);
    expect(UI.ratingRunQualifies()).toBe(false);
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: "nope", freedMb: NaN })).toBe(false);
  });

  test("thresholds are exported for the UI copy", () => {
    expect(UI.RATING_MIN_CLEANED).toBe(200);
    expect(UI.RATING_MIN_FREED_MB).toBe(100);
  });
});

describe("GCC.popupUi.reassuranceOpen", () => {
  test("open before any recorded run", () => {
    expect(UI.reassuranceOpen(0)).toBe(true);
    expect(UI.reassuranceOpen(undefined)).toBe(true);
    expect(UI.reassuranceOpen("junk")).toBe(true);
  });

  test("collapsed once the first cleanup is recorded", () => {
    expect(UI.reassuranceOpen(1)).toBe(false);
    expect(UI.reassuranceOpen(42)).toBe(false);
  });
});

describe("GCC.popupUi.subsUpsellLine", () => {
  test("static fallback before any scan", () => {
    const line = UI.subsUpsellLine(0);
    expect(line).toBe("One $5 payment unlocks bulk unsubscribe forever.");
    expect(UI.subsUpsellLine(undefined)).toBe(line);
    expect(UI.subsUpsellLine(-3)).toBe(line);
  });

  test("leads with the scan count once one exists", () => {
    const line = UI.subsUpsellLine(47);
    expect(line).toBe("Found 47 mailing lists emailing you. Pro unsubscribes from the ones you pick for $5.");
  });

  test("singular form for a single list", () => {
    expect(UI.subsUpsellLine(1)).toContain("1 mailing list emailing");
    expect(UI.subsUpsellLine(1)).not.toContain("lists");
  });
});

describe("GCC.popupUi.xrayUpsellLine", () => {
  test("static fallback before any scan", () => {
    const line = UI.xrayUpsellLine(0, 0);
    expect(line).toBe("Pro is $5 once: it unlocks the full ranked list and one-click purge.");
    expect(UI.xrayUpsellLine(5, 0)).toBe(line);
    expect(UI.xrayUpsellLine(0, 100)).toBe(line);
  });

  test("leads with senders and a floor-estimate size", () => {
    const line = UI.xrayUpsellLine(9, 412);
    expect(line).toBe("9 senders are holding at least 412.0 MB. Pro purges the ones you pick for $5.");
  });

  test("singular form and GB scaling", () => {
    expect(UI.xrayUpsellLine(1, 80)).toContain("1 sender is holding at least 80.0 MB");
    expect(UI.xrayUpsellLine(12, 2048)).toContain("at least 2.0 GB");
  });
});
