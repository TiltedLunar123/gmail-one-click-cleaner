/**
 * @jest-environment jsdom
 *
 * Storage X-ray engine internals (7.2): tier queries, per-row MB
 * attribution, and the fold that accumulates sampled rows per sender.
 * The scan reuses the subscription row sampler, so row-shape coverage
 * lives in contentScript-subscriptions.test.js.
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

describe("storage X-ray engine (7.2)", () => {
  test("exposes the new internals under GCC_TEST_MODE", () => {
    const I = loadEngine();
    expect(Array.isArray(I.STORAGE_XRAY.TIER_QUERIES)).toBe(true);
    expect(typeof I.foldStorageSample).toBe("function");
    expect(typeof I.estimateMbPerEmail).toBe("function");
  });

  test("sanitizeConfig accepts the storageScan run kind", () => {
    const I = loadEngine();
    expect(I.sanitizeConfig({ runKind: "storageScan" }).runKind).toBe("storageScan");
    expect(I.sanitizeConfig({ runKind: "storageXray" }).runKind).toBe("cleanup");
  });

  test("tier queries descend and every tier maps to its floor MB", () => {
    const I = loadEngine();
    const floors = I.STORAGE_XRAY.TIER_QUERIES.map((q) => I.estimateMbPerEmail(q));
    expect(floors).toEqual([25, 10, 5]);
    // Descending tiers matter: a message can only appear in one tier
    // because each lower tier excludes the one above via smaller:.
    expect(I.STORAGE_XRAY.TIER_QUERIES[1]).toContain("smaller:25M");
    expect(I.STORAGE_XRAY.TIER_QUERIES[2]).toContain("smaller:10M");
  });

  describe("foldStorageSample", () => {
    const entries = [
      { email: "big@files.com", name: "Big Files" },
      { email: "big@files.com", name: "Big Files" },
      { email: "news@paper.com", name: "Paper" }
    ];

    test("accumulates count and MB per sender", () => {
      const I = loadEngine();
      const map = new Map();
      I.foldStorageSample(map, entries, 25);
      expect(map.get("big@files.com")).toEqual({
        email: "big@files.com", name: "Big Files", count: 2, estMb: 50
      });
      expect(map.get("news@paper.com").estMb).toBe(25);
    });

    test("folds multiple tiers into the same sender", () => {
      const I = loadEngine();
      const map = new Map();
      I.foldStorageSample(map, [entries[0]], 25);
      I.foldStorageSample(map, [entries[0]], 5);
      expect(map.get("big@files.com").count).toBe(2);
      expect(map.get("big@files.com").estMb).toBe(30);
    });

    test("treats a junk MB value as zero instead of poisoning sums", () => {
      const I = loadEngine();
      const map = new Map();
      I.foldStorageSample(map, [entries[2]], NaN);
      expect(map.get("news@paper.com").estMb).toBe(0);
    });
  });

  test("row sampling feeds the fold: end-to-end over a DOM fixture", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><table role="grid">
        <tr role="row"><td class="yX"><span email="a@x.com" name="A">A</span></td></tr>
        <tr role="row"><td class="yX"><span email="a@x.com" name="A">A</span></td></tr>
        <tr role="row"><td class="yX"><span email="b@y.com" name="B">B</span></td></tr>
      </table></div>`;
    const map = new Map();
    I.foldStorageSample(map, I.sampleSubscriptionRows(), I.estimateMbPerEmail("larger:10M smaller:25M"));
    expect(map.get("a@x.com").estMb).toBe(20);
    expect(map.get("b@y.com").estMb).toBe(10);
  });
});
