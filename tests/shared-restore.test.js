/**
 * @jest-environment node
 *
 * GCC.restore (7.6): pure eligibility policy behind the recovery log's
 * Restore button. A run is restorable only when its label verifiably
 * landed (taggingFailed recorded false), and delete-mode runs age out
 * with Gmail's ~30-day Trash retention. Entries missing the needed
 * fields never offer restore; sender-based guessing is not a fallback.
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

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const entry = (overrides = {}) => ({
  id: "undo_1",
  timestamp: NOW - DAY,
  query: "in:anywhere category:promotions",
  label: "Promotions",
  count: 120,
  action: "delete",
  tagLabel: "GmailCleaner - Promotions",
  intensity: "normal",
  sampledMessageIds: [],
  sampledSenderCount: 0,
  taggingFailed: false,
  ...overrides
});

describe("GCC.restore.eligibility", () => {
  test("a fresh tagged delete run is eligible with its label and mode", () => {
    const v = GCC.restore.eligibility(entry(), NOW);
    expect(v.eligible).toBe(true);
    expect(v.restored).toBe(false);
    expect(v.label).toBe("GmailCleaner - Promotions");
    expect(v.action).toBe("delete");
  });

  test("delete mode ages out after 30 days with a plain-words reason", () => {
    const v = GCC.restore.eligibility(entry({ timestamp: NOW - 31 * DAY }), NOW);
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/30 days/);
  });

  test("delete mode at 29 days is still inside the window", () => {
    expect(GCC.restore.eligibility(entry({ timestamp: NOW - 29 * DAY }), NOW).eligible).toBe(true);
  });

  test("archive mode has no deadline", () => {
    const v = GCC.restore.eligibility(
      entry({ action: "archive", timestamp: NOW - 200 * DAY }),
      NOW
    );
    expect(v.eligible).toBe(true);
    expect(v.action).toBe("archive");
  });

  test("taggingFailed true never offers restore", () => {
    const v = GCC.restore.eligibility(entry({ taggingFailed: true }), NOW);
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/label/i);
  });

  test("an entry that never recorded taggingFailed does not offer restore", () => {
    const legacy = entry();
    delete legacy.taggingFailed;
    expect(GCC.restore.eligibility(legacy, NOW).eligible).toBe(false);
  });

  test("an empty or missing label never offers restore", () => {
    expect(GCC.restore.eligibility(entry({ tagLabel: "" }), NOW).eligible).toBe(false);
    expect(GCC.restore.eligibility(entry({ tagLabel: "   " }), NOW).eligible).toBe(false);
    const noLabel = entry();
    delete noLabel.tagLabel;
    expect(GCC.restore.eligibility(noLabel, NOW).eligible).toBe(false);
  });

  test("a restored entry reports restored instead of eligible", () => {
    const v = GCC.restore.eligibility(entry({ restoredAt: NOW - 60_000 }), NOW);
    expect(v.eligible).toBe(false);
    expect(v.restored).toBe(true);
  });

  test("garbage input is simply ineligible", () => {
    expect(GCC.restore.eligibility(null, NOW).eligible).toBe(false);
    expect(GCC.restore.eligibility("nope", NOW).eligible).toBe(false);
    expect(GCC.restore.eligibility({}, NOW).eligible).toBe(false);
  });

  test("a delete entry with no timestamp cannot prove it is inside the window", () => {
    expect(GCC.restore.eligibility(entry({ timestamp: 0 }), NOW).eligible).toBe(false);
  });

  test("the window constant matches the documented 30 days", () => {
    expect(GCC.restore.TRASH_WINDOW_MS).toBe(30 * DAY);
  });
});
