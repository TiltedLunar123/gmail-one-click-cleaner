/**
 * @jest-environment node
 *
 * GCC.popupUi (7.3): pure decision logic behind the tabbed popup.
 * Banner arbitration, the rating-prompt threshold, and the number-led
 * upsell lines are all plain functions, so they get direct coverage
 * here.
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

  test("qualifies at 50 cleaned emails, not at 49", () => {
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 50, freedMb: 0 })).toBe(true);
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 49, freedMb: 0 })).toBe(false);
  });

  test("qualifies at 25 MB freed, not just under", () => {
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 0, freedMb: 25 })).toBe(true);
    expect(UI.ratingRunQualifies({ dryRun: false, cleaned: 0, freedMb: 24.9 })).toBe(false);
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
    expect(UI.RATING_MIN_CLEANED).toBe(50);
    expect(UI.RATING_MIN_FREED_MB).toBe(25);
  });
});

describe("GCC.popupUi.autoPilotUpsellLine", () => {
  test("static fallback before any suggestions exist", () => {
    const line = UI.autoPilotUpsellLine(0);
    expect(line).toBe("Pro is $9.99 once: Auto-Pilot keeps your inbox clean every week, automatically.");
    expect(UI.autoPilotUpsellLine(undefined)).toBe(line);
    expect(UI.autoPilotUpsellLine(-2)).toBe(line);
  });

  test("leads with the live suggestion count", () => {
    const line = UI.autoPilotUpsellLine(7);
    expect(line).toBe("7 suggestions are sitting here right now. Auto-Pilot sweeps them for you every week on Pro ($9.99 once).");
  });

  test("singular form for one suggestion", () => {
    expect(UI.autoPilotUpsellLine(1)).toContain("1 suggestion is sitting");
  });
});

describe("GCC.popupUi.subsUpsellLine", () => {
  test("static fallback before any scan", () => {
    const line = UI.subsUpsellLine(0);
    expect(line).toBe("One $9.99 payment unlocks bulk unsubscribe forever.");
    expect(UI.subsUpsellLine(undefined)).toBe(line);
    expect(UI.subsUpsellLine(-3)).toBe(line);
  });

  test("leads with the scan count once one exists", () => {
    const line = UI.subsUpsellLine(47);
    expect(line).toBe("Found 47 mailing lists emailing you. Pro unsubscribes from the ones you pick for $9.99.");
  });

  test("singular form for a single list", () => {
    expect(UI.subsUpsellLine(1)).toContain("1 mailing list emailing");
    expect(UI.subsUpsellLine(1)).not.toContain("lists");
  });
});

describe("GCC.popupUi.pickRecapEntry (7.4 post-run recap)", () => {
  const entry = (timestamp, extra = {}) =>
    ({ timestamp, deleted: 10, archived: 0, freedMb: 5, dryRun: false, ...extra });

  test("picks the newest real entry newer than the seen marker", () => {
    const history = [entry(3000), entry(5000), entry(4000)];
    expect(UI.pickRecapEntry(history, 2000).timestamp).toBe(5000);
  });

  test("entries at or before the marker are already seen", () => {
    const history = [entry(5000)];
    expect(UI.pickRecapEntry(history, 5000)).toBeNull();
    expect(UI.pickRecapEntry(history, 6000)).toBeNull();
    expect(UI.pickRecapEntry(history, 4999).timestamp).toBe(5000);
  });

  test("dry runs never produce a recap, even when newest", () => {
    const history = [entry(9000, { dryRun: true }), entry(5000)];
    expect(UI.pickRecapEntry(history, 0).timestamp).toBe(5000);
    expect(UI.pickRecapEntry([entry(9000, { dryRun: true })], 0)).toBeNull();
  });

  test("no marker yet means everything real is unseen", () => {
    expect(UI.pickRecapEntry([entry(1000)], undefined).timestamp).toBe(1000);
    expect(UI.pickRecapEntry([entry(1000)], null).timestamp).toBe(1000);
  });

  test("garbage input yields no recap", () => {
    expect(UI.pickRecapEntry(undefined, 0)).toBeNull();
    expect(UI.pickRecapEntry("nope", 0)).toBeNull();
    expect(UI.pickRecapEntry([null, "x", { dryRun: false }], 0)).toBeNull();
  });
});

describe("GCC.popupUi.recapSeenMarker (marker update rule)", () => {
  test("stamps ahead of now by the skew so the in-flight history write is covered", () => {
    expect(UI.RECAP_SEEN_SKEW_MS).toBe(5000);
    expect(UI.recapSeenMarker(100000)).toBe(100000 + UI.RECAP_SEEN_SKEW_MS);
  });

  test("garbage input degrades to the bare skew, never NaN", () => {
    expect(UI.recapSeenMarker(undefined)).toBe(UI.RECAP_SEEN_SKEW_MS);
    expect(UI.recapSeenMarker(NaN)).toBe(UI.RECAP_SEEN_SKEW_MS);
  });

  test("a marker stamped at done-time hides that run's own history entry", () => {
    // The SW writes the entry a beat after the popup's done handler.
    const doneAt = 50000;
    const marker = UI.recapSeenMarker(doneAt);
    const lateEntry = { timestamp: doneAt + 40, deleted: 300, archived: 0, freedMb: 120, dryRun: false };
    expect(UI.pickRecapEntry([lateEntry], marker)).toBeNull();
  });
});

describe("GCC.popupUi.recapAction / recapCleanedCount", () => {
  test("archive-only entries read as archive, everything else as trash", () => {
    expect(UI.recapAction({ deleted: 0, archived: 12 })).toBe("archive");
    expect(UI.recapAction({ deleted: 12, archived: 0 })).toBe("trash");
    expect(UI.recapAction({ deleted: 3, archived: 9 })).toBe("trash");
    expect(UI.recapAction({ deleted: 0, archived: 0 })).toBe("trash");
    expect(UI.recapAction(undefined)).toBe("trash");
  });

  test("cleaned count is deleted plus archived, garbage-safe", () => {
    expect(UI.recapCleanedCount({ deleted: 150, archived: 60 })).toBe(210);
    expect(UI.recapCleanedCount({})).toBe(0);
    expect(UI.recapCleanedCount(undefined)).toBe(0);
    expect(UI.recapCleanedCount({ deleted: "x", archived: 4 })).toBe(4);
  });

  test("a recap entry feeds the same rating gate as a live run", () => {
    const entry = { timestamp: 1, deleted: 150, archived: 60, freedMb: 10, dryRun: false };
    expect(UI.ratingRunQualifies({
      dryRun: entry.dryRun,
      cleaned: UI.recapCleanedCount(entry),
      freedMb: entry.freedMb
    })).toBe(true);
  });
});

describe("GCC.popupUi.xrayUpsellLine", () => {
  test("static fallback before any scan", () => {
    const line = UI.xrayUpsellLine(0, 0);
    expect(line).toBe("Pro is $9.99 once: it unlocks the full ranked list and one-click purge.");
    expect(UI.xrayUpsellLine(5, 0)).toBe(line);
    expect(UI.xrayUpsellLine(0, 100)).toBe(line);
  });

  test("leads with senders and a floor-estimate size", () => {
    const line = UI.xrayUpsellLine(9, 412);
    expect(line).toBe("9 senders are holding at least 412.0 MB. Pro purges the ones you pick for $9.99.");
  });

  test("singular form and GB scaling", () => {
    expect(UI.xrayUpsellLine(1, 80)).toContain("1 sender is holding at least 80.0 MB");
    expect(UI.xrayUpsellLine(12, 2048)).toContain("at least 2.0 GB");
  });
});
