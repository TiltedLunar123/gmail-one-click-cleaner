// Coverage for the Settings Export/Import data layer in options.js.
//
// options.js is a self-running browser IIFE with no exports, so (like
// shared.test.js / background.test.js) we load its source and evaluate it
// with injected dependencies. Here we strip the IIFE wrapper and append a
// return of the internal helpers we want to exercise. Runs in jsdom (the
// jest default) so the file's init wiring has a window/document to touch.

const fs = require("fs");
const path = require("path");

// A null-safe GCC stub. With $() returning null, every DOM-touching path
// in init() short-circuits, so loading the module has no side effects.
const makeGCC = () => ({
  $: () => null,
  hasChromeStorage: () => false,
  storageGet: async () => ({}),
  storageSet: async () => {},
  clone: (x) => x,
  debounce: (fn) => fn,
  showToast: () => {},
  theme: { init: async () => {}, get: async () => "dark", set: async (v) => v },
  validateGmailQuery: () => ({ valid: true, warnings: [] }),
  // Faithful mirror of shared.js GCC.sanitizeProtectKeywords so the
  // export/import round-trip behaves like production.
  sanitizeProtectKeywords: (input) => {
    const arr = Array.isArray(input)
      ? input
      : (typeof input === "string" ? input.split("\n") : []);
    const out = [];
    const seen = new Set();
    for (const raw of arr) {
      if (typeof raw !== "string") continue;
      const cleaned = raw
        .replace(/["(){}]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[-\s]+/, "")
        .trim()
        .slice(0, 50)
        .trim();
      if (!cleaned) continue;
      if (/^(or|and)$/i.test(cleaned)) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
      if (out.length >= 25) break;
    }
    return out;
  }
});

const makeChrome = () => ({
  runtime: { sendMessage: (_msg, cb) => { if (cb) cb(null); }, lastError: null },
  storage: { sync: { get: async () => ({}), set: async () => {} } }
});

function loadOptionsApi() {
  const src = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf-8");

  // Strip the leading `(() => {` and trailing `})();` so we can re-wrap the
  // body in our own factory and return the internals.
  const body = src
    .replace(/^\(\(\)\s*=>\s*\{/, "")
    .replace(/\}\)\(\);\s*$/, "");

  if (!body.includes("buildExportPayload")) {
    throw new Error("Failed to extract options.js body for testing");
  }

  // eslint is configured to ignore tests/, so new Function here is fine.
  const factory = new Function(
    "GCC",
    "chrome",
    `${body}\n; return { validateImport, buildExportPayload, buildImportWriteSet, normalizeCustomRules, normalizeSchedules, normalizeProtectKeywords, EXPORT_FORMAT_VERSION };`
  );

  return factory(makeGCC(), makeChrome());
}

const api = loadOptionsApi();

const sampleCustomRules = () => [
  { query: "from:spam@x.com older_than:1y", action: "delete", createdAt: 111 },
  { query: "category:promotions older_than:6m", action: "archive", createdAt: 222, templateName: "Old promotions" }
];

const sampleSchedules = () => [
  {
    id: "sched_1",
    enabled: true,
    intervalMinutes: 10080,
    intensity: "light",
    minAge: "3m",
    action: "delete",
    whitelist: [],
    createdAt: 333,
    lastRun: null
  }
];

const sampleCurrent = () => ({
  rules: { light: [], normal: ["category:promotions older_than:1y"], deep: [] },
  debugMode: true,
  whitelist: ["user@example.com"],
  protectKeywords: ["tax", "flight confirmation"]
});

describe("options.js config export/import data layer", () => {

  // ===========================
  // normalizeCustomRules
  // ===========================

  describe("normalizeCustomRules", () => {
    test("returns [] for non-array input", () => {
      expect(api.normalizeCustomRules(undefined)).toEqual([]);
      expect(api.normalizeCustomRules(null)).toEqual([]);
      expect(api.normalizeCustomRules("nope")).toEqual([]);
      expect(api.normalizeCustomRules({})).toEqual([]);
    });

    test("keeps valid rules and preserves their fields", () => {
      const out = api.normalizeCustomRules(sampleCustomRules());
      expect(out).toHaveLength(2);
      expect(out[1]).toEqual({
        query: "category:promotions older_than:6m",
        action: "archive",
        createdAt: 222,
        templateName: "Old promotions"
      });
    });

    test("drops entries without a non-empty string query", () => {
      const out = api.normalizeCustomRules([
        { query: "valid older_than:1y", action: "delete" },
        { query: "   ", action: "delete" },
        { action: "delete" },
        null,
        "string-not-object",
        42
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].query).toBe("valid older_than:1y");
    });
  });

  // ===========================
  // normalizeSchedules
  // ===========================

  describe("normalizeSchedules", () => {
    test("returns [] for non-array input", () => {
      expect(api.normalizeSchedules(undefined)).toEqual([]);
      expect(api.normalizeSchedules(null)).toEqual([]);
      expect(api.normalizeSchedules("nope")).toEqual([]);
    });

    test("keeps valid schedules with all fields intact", () => {
      const out = api.normalizeSchedules(sampleSchedules());
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual(sampleSchedules()[0]);
    });

    test("drops entries without a string id", () => {
      const out = api.normalizeSchedules([
        { id: "ok", enabled: true },
        { id: "", enabled: true },
        { enabled: true },
        null,
        7
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe("ok");
    });
  });

  // ===========================
  // buildExportPayload
  // ===========================

  describe("buildExportPayload", () => {
    test("includes customRules and schedules read from sync storage", () => {
      const payload = api.buildExportPayload(sampleCurrent(), {
        customRules: sampleCustomRules(),
        schedules: sampleSchedules()
      });
      expect(payload.customRules).toHaveLength(2);
      expect(payload.schedules).toHaveLength(1);
      expect(payload.schedules[0].id).toBe("sched_1");
    });

    test("stamps the bumped export format version", () => {
      const payload = api.buildExportPayload(sampleCurrent(), {});
      expect(api.EXPORT_FORMAT_VERSION).toBe(3);
      expect(payload.formatVersion).toBe(3);
    });

    test("includes sanitized protectKeywords (6.1 subject shield)", () => {
      const payload = api.buildExportPayload(sampleCurrent(), {});
      expect(payload.protectKeywords).toEqual(["tax", "flight confirmation"]);
    });

    test("defaults missing extras to empty arrays (no crash)", () => {
      const payload = api.buildExportPayload(sampleCurrent());
      expect(payload.customRules).toEqual([]);
      expect(payload.schedules).toEqual([]);
    });

    test("drops malformed extras before writing the backup", () => {
      const payload = api.buildExportPayload(sampleCurrent(), {
        customRules: [{ action: "delete" }, { query: "good older_than:1y", action: "delete" }],
        schedules: [{ id: "keep" }, { nope: true }]
      });
      expect(payload.customRules).toHaveLength(1);
      expect(payload.customRules[0].query).toBe("good older_than:1y");
      expect(payload.schedules).toHaveLength(1);
      expect(payload.schedules[0].id).toBe("keep");
    });

    test("still carries the existing fields (rules, whitelist, debug, version)", () => {
      const payload = api.buildExportPayload(sampleCurrent(), {});
      expect(payload.rules.normal).toContain("category:promotions older_than:1y");
      expect(payload.whitelist).toEqual(["user@example.com"]);
      expect(payload.debugMode).toBe(true);
      expect(payload.version).toBe("7.12.0");
      expect(payload.extensionName).toBe("Gmail One-Click Cleaner");
    });
  });

  // ===========================
  // validateImport
  // ===========================

  describe("validateImport", () => {
    test("accepts a complete v2 backup with customRules and schedules", () => {
      const result = api.validateImport({
        rules: { normal: ["category:promotions older_than:1y"] },
        whitelist: ["user@example.com"],
        customRules: sampleCustomRules(),
        schedules: sampleSchedules()
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test("accepts an older backup that omits customRules and schedules", () => {
      const result = api.validateImport({
        rules: { normal: ["category:promotions older_than:1y"] }
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test("rejects customRules that is not an array", () => {
      const result = api.validateImport({
        rules: { normal: ["x"] },
        customRules: { not: "an array" }
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("'customRules' must be an array");
    });

    test("rejects schedules that is not an array", () => {
      const result = api.validateImport({
        rules: { normal: ["x"] },
        schedules: "weekly"
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("'schedules' must be an array");
    });

    test("rejects protectKeywords that is not an array", () => {
      const result = api.validateImport({
        rules: { normal: ["x"] },
        protectKeywords: "tax"
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("'protectKeywords' must be an array");
    });

    test("accepts a backup that omits protectKeywords (format 1/2)", () => {
      const result = api.validateImport({
        rules: { normal: ["category:promotions older_than:1y"] }
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test("still requires a rules object", () => {
      const result = api.validateImport({ customRules: [], schedules: [] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing or invalid 'rules' property");
    });
  });

  // ===========================
  // buildImportWriteSet
  // ===========================

  describe("buildImportWriteSet", () => {
    test("writes customRules and schedules when the backup carries them", () => {
      const writeSet = api.buildImportWriteSet({
        rules: { normal: ["category:promotions older_than:1y"] },
        whitelist: ["user@example.com"],
        customRules: sampleCustomRules(),
        schedules: sampleSchedules()
      });
      expect(writeSet.customRules).toHaveLength(2);
      expect(writeSet.schedules).toHaveLength(1);
      expect(writeSet.rules.normal).toContain("category:promotions older_than:1y");
      expect(writeSet.whitelist).toEqual(["user@example.com"]);
    });

    test("omits customRules and schedules for an older backup (does not wipe existing)", () => {
      const writeSet = api.buildImportWriteSet({
        rules: { normal: ["category:promotions older_than:1y"] }
      });
      expect(writeSet).not.toHaveProperty("customRules");
      expect(writeSet).not.toHaveProperty("schedules");
    });

    test("writes sanitized protectKeywords when the backup carries them", () => {
      const writeSet = api.buildImportWriteSet({
        rules: { normal: ["category:promotions older_than:1y"] },
        protectKeywords: ["  tax  ", "tax", "invoice"]
      });
      // trimmed + case-insensitively deduped
      expect(writeSet.protectKeywords).toEqual(["tax", "invoice"]);
    });

    test("omits protectKeywords for an older backup (does not wipe existing)", () => {
      const writeSet = api.buildImportWriteSet({
        rules: { normal: ["category:promotions older_than:1y"] }
      });
      expect(writeSet).not.toHaveProperty("protectKeywords");
    });

    test("normalizes entries before writing", () => {
      const writeSet = api.buildImportWriteSet({
        rules: { normal: ["category:promotions older_than:1y"] },
        customRules: [{ query: "keep older_than:1y", action: "delete" }, { action: "delete" }],
        schedules: [{ id: "keep" }, { junk: true }]
      });
      expect(writeSet.customRules).toHaveLength(1);
      expect(writeSet.schedules).toHaveLength(1);
    });

    test("round-trips through export then import", () => {
      const payload = api.buildExportPayload(sampleCurrent(), {
        customRules: sampleCustomRules(),
        schedules: sampleSchedules()
      });
      const writeSet = api.buildImportWriteSet(payload);
      expect(writeSet.customRules).toEqual(payload.customRules);
      expect(writeSet.schedules).toEqual(payload.schedules);
      expect(writeSet.protectKeywords).toEqual(payload.protectKeywords);
    });
  });

  // ===========================
  // normalizeProtectKeywords (6.1)
  // ===========================

  describe("normalizeProtectKeywords", () => {
    test("trims, dedupes case-insensitively, and drops blanks", () => {
      expect(api.normalizeProtectKeywords(["  tax ", "TAX", "", "   ", "invoice"]))
        .toEqual(["tax", "invoice"]);
    });

    test("returns [] for non-array, non-string input", () => {
      expect(api.normalizeProtectKeywords(undefined)).toEqual([]);
      expect(api.normalizeProtectKeywords(null)).toEqual([]);
      expect(api.normalizeProtectKeywords(42)).toEqual([]);
    });
  });
});
