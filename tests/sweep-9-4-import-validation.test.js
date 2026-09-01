/**
 * 9.4: Import was the one write path that did not run the checks the
 * page runs on everything anybody types.
 *
 * normalizeCustomRules asked only whether `query` was a non-empty
 * string. Add-a-rule and apply-a-template both run
 * GCC.validateGmailQuery, which is what refuses `is:starred`, `in:trash`
 * and `in:spam`: the queries whose entire point is that a cleanup run
 * must not touch them. So a config file could restore a rule the page
 * refuses to let anyone write, and summarizeImport counts the write set,
 * so it was reported as kept and the run ended "imported successfully".
 *
 * normalizeSchedules validated `id` and nothing else, and
 * restoreScheduledAlarms hands intervalMinutes straight to
 * chrome.alarms.create. An absent frequency is fine, the worker reads
 * `schedule.intervalMinutes || 10080` and runs weekly. A frequency that
 * is present and is not one the Frequency select can produce was not.
 */
const fs = require("fs");
const path = require("path");

// The real validator, loaded from shared.js: a stub here would be a test
// of the stub. This is the same function options.js calls.
const SHARED_SRC = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
// eslint-disable-next-line no-new-func
const GCC_REAL = new Function(`${SHARED_SRC}; return GCC;`)();

const makeGCC = () => ({
  $: () => null,
  hasChromeStorage: () => false,
  storageGet: async () => ({}),
  storageSet: async () => {},
  clone: (x) => JSON.parse(JSON.stringify(x)),
  debounce: (fn) => fn,
  showToast: () => {},
  theme: { init: async () => {}, get: async () => "dark", set: async (v) => v },
  validateGmailQuery: GCC_REAL.validateGmailQuery,
  sanitizeProtectKeywords: () => [],
  escapeHtml: (s) => s,
  hasChrome: () => false
});

const makeChrome = () => ({
  runtime: { id: "test", lastError: null, getManifest: () => ({ version: "9.4.0" }), getURL: (p) => p,
    sendMessage: () => {}, onMessage: { addListener: () => {} } },
  storage: { sync: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() },
    local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() },
    onChanged: { addListener: () => {} } },
  i18n: { getMessage: () => "" },
  tabs: { create: () => {}, query: (q, cb) => cb([]) }
});

function loadApi() {
  const src = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf-8");
  const body = src.replace(/^\(\(\)\s*=>\s*\{/, "").replace(/\}\)\(\);\s*$/, "");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "GCC", "chrome",
    `${body}\n; return { normalizeCustomRules, normalizeSchedules, buildImportWriteSet, summarizeImport };`
  );
  return factory(makeGCC(), makeChrome());
}

const api = loadApi();

// Sanity: the validator really does refuse these, so the assertions
// below are about the import path rather than about a lenient stub.
describe("the gate the import was skipping", () => {
  test.each(["is:starred older_than:1y", "in:trash older_than:1y", "in:spam older_than:1y"])(
    "the page's own validator refuses %s",
    (q) => {
      expect(GCC_REAL.validateGmailQuery(q).valid).toBe(false);
    }
  );

  test("and it accepts an ordinary one", () => {
    expect(GCC_REAL.validateGmailQuery("category:promotions older_than:6m").valid).toBe(true);
  });
});

describe("an imported custom rule has to pass the same check as a typed one", () => {
  test("the three the guards exist to protect are dropped", () => {
    const out = api.normalizeCustomRules([
      { query: "is:starred older_than:1y", action: "delete" },
      { query: "in:trash older_than:1y", action: "delete" },
      { query: "in:spam older_than:1y", action: "delete" },
      { query: "category:promotions older_than:6m", action: "delete" }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].query).toBe("category:promotions older_than:6m");
  });

  test("an action the engine does not know is dropped", () => {
    const out = api.normalizeCustomRules([
      { query: "category:promotions older_than:6m", action: "deleteForever" },
      { query: "category:social older_than:6m", action: "archive" }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe("archive");
  });

  test("a rule with no action is still kept, as before", () => {
    expect(api.normalizeCustomRules([{ query: "category:promotions older_than:6m" }])).toHaveLength(1);
  });

  test("the drop is visible to the import summary, not silent", () => {
    const json = {
      rules: {},
      customRules: [
        { query: "in:trash older_than:1y", action: "delete" },
        { query: "category:promotions older_than:6m", action: "delete" }
      ]
    };
    const written = api.buildImportWriteSet(json);
    const kept = Object.values(written).find((v) => Array.isArray(v) && v[0]?.query);
    expect(kept).toHaveLength(1);
    // summarizeImport measures the write set, so a dropped rule shows up
    // as a difference the confirm dialog reports.
    const summary = api.summarizeImport(written, json);
    expect(JSON.stringify(summary)).toContain("1");
  });
});

describe("an imported schedule cannot arm an alarm the page cannot set", () => {
  test("a frequency outside the Frequency select is dropped", () => {
    const out = api.normalizeSchedules([
      { id: "a", intervalMinutes: 1 },
      { id: "b", intervalMinutes: 0 },
      { id: "c", intervalMinutes: -5 },
      { id: "d", intervalMinutes: 10080 }
    ]);
    expect(out.map((s) => s.id)).toEqual(["d"]);
  });

  test("all three real frequencies survive", () => {
    const out = api.normalizeSchedules([
      { id: "daily", intervalMinutes: 1440 },
      { id: "weekly", intervalMinutes: 10080 },
      { id: "monthly", intervalMinutes: 43200 }
    ]);
    expect(out).toHaveLength(3);
  });

  test("an absent frequency is still kept, because the worker defaults it to weekly", () => {
    expect(api.normalizeSchedules([{ id: "a", enabled: true }])).toHaveLength(1);
  });

  test("an intensity that is not a rule set is dropped", () => {
    const out = api.normalizeSchedules([
      { id: "a", intervalMinutes: 10080, intensity: "nuclear" },
      { id: "b", intervalMinutes: 10080, intensity: "maximum" }
    ]);
    expect(out.map((s) => s.id)).toEqual(["b"]);
  });

  test("an action the engine does not know is dropped", () => {
    const out = api.normalizeSchedules([
      { id: "a", intervalMinutes: 10080, action: "purge" },
      { id: "b", intervalMinutes: 10080, action: "archive" }
    ]);
    expect(out.map((s) => s.id)).toEqual(["b"]);
  });
});
