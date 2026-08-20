/**
 * @jest-environment node
 *
 * 8.20: the two caps that refuse a save were not tested by anything.
 *
 * 8.12 made Never Delete and Protected Keywords BLOCK when they are over
 * their limit, because the alternative it replaced was a silent .slice()
 * on the way to storage while the textarea, the line counter and the
 * success toast all still showed the full list. A user who pasted 150
 * addresses into Never Delete was told their settings were saved, saw
 * 150 lines, and had 100 protected.
 *
 * What 8.12 pinned was the message text and the use of the blocking
 * helper. Replacing either CONDITION with `if (false)` keeps every one
 * of those strings in the file, so both caps could be switched off with
 * a green suite, and the failure mode is the one the caps exist to
 * prevent: a protection list quietly shorter than the one on screen.
 *
 * These drive validateData for real, against the shipped source.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf-8");

// Same extraction options-config-io.test.js uses: unwrap the IIFE and
// hand back the internals under test.
function loadValidator(fields) {
  const body = SRC
    .replace(/^\(\(\)\s*=>\s*\{/, "")
    .replace(/\}\)\(\);\s*$/, "");
  if (!body.includes("const validateData = (data) => {")) {
    throw new Error("validateData moved; this suite would assert nothing");
  }

  // Enough of an element for readLines and for whatever wiring runs on
  // the way past. Only `.value` is ever read by the code under test.
  const stubEl = (value) => ({
    value,
    textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    dataset: {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {}
  });

  const els = {};
  for (const [id, value] of Object.entries(fields)) els[id] = stubEl(value);

  const GCC = {
    $: (id) => els[id] || null,
    MAX_PROTECT_KEYWORDS: 25,
    validateGmailQuery: () => ({ valid: true, errors: [], warnings: [] }),
    sanitizeProtectKeywords: (x) => (Array.isArray(x) ? x : []),
    hasChrome: () => false,
    hasChromeStorage: () => false,
    storageGet: async () => ({}),
    storageSet: async () => {},
    clone: (x) => x,
    debounce: (fn) => fn,
    showToast: () => {},
    theme: { init: async () => {}, get: async () => "dark", set: async (v) => v }
  };
  const chrome = {
    runtime: { id: "t", lastError: null, sendMessage: () => {}, getManifest: () => ({ version: "t" }) },
    storage: { sync: { get: () => {}, set: () => {} }, local: { get: () => {}, set: () => {} } }
  };

  // eslint is configured to ignore tests/, so new Function here is fine.
  const factory = new Function(
    "GCC", "chrome", "document", "window",
    `${body}\n; return { validateData, CONFIG };`
  );
  // readyState "loading" so the page's own init() waits for a
  // DOMContentLoaded that never comes. Booting it against a stub DOM
  // works but fills the run with noise from wiring that is not what this
  // suite is measuring.
  const doc = {
    readyState: "loading",
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  return factory(GCC, chrome, doc, { addEventListener() {} });
}

const lines = (n, make) => Array.from({ length: n }, (_, i) => make(i)).join("\n");
const addresses = (n) => lines(n, (i) => `person${i}@example.com`);
const keywords = (n) => lines(n, (i) => `keyword ${i}`);

const baseData = () => ({ rules: { light: [], normal: ["category:promotions older_than:1y"], deep: [] } });

describe("Never Delete refuses to save past its cap", () => {
  test("one over the limit blocks the whole save", () => {
    const api = loadValidator({ whitelist: addresses(101), protectKeywords: "" });
    const out = api.validateData(baseData());

    expect(api.CONFIG.MAX_WHITELIST_ENTRIES).toBe(100);
    expect(out.blocking.length).toBeGreaterThan(0);
    expect(out.blocking.join(" ")).toContain("Never Delete");
    // The count it quotes is the raw one, so the message can tell the
    // user how many to remove. Counting the normalized list could never
    // exceed the cap, which is the trap 8.11 hit.
    expect(out.blocking.join(" ")).toContain("101");
    expect(out.blocking.join(" ")).toContain("Nothing was changed");
  });

  test("exactly at the limit saves", () => {
    const api = loadValidator({ whitelist: addresses(100), protectKeywords: "" });
    expect(api.validateData(baseData()).blocking).toEqual([]);
  });
});

describe("Protected Keywords refuses to save past its cap", () => {
  test("one over the limit blocks the whole save", () => {
    const api = loadValidator({ whitelist: "", protectKeywords: keywords(26) });
    const out = api.validateData(baseData());

    expect(out.blocking.length).toBeGreaterThan(0);
    expect(out.blocking.join(" ")).toContain("Protected Keywords");
    expect(out.blocking.join(" ")).toContain("26");
  });

  test("exactly at the limit saves", () => {
    const api = loadValidator({ whitelist: "", protectKeywords: keywords(25) });
    expect(api.validateData(baseData()).blocking).toEqual([]);
  });
});

describe("the rule lists have the same cap, and it is the same helper", () => {
  test("a category over 50 rules blocks", () => {
    const api = loadValidator({ whitelist: "", protectKeywords: "" });
    const data = baseData();
    data.rules.normal = Array.from({ length: 51 }, (_, i) => `category:promotions older_than:${i + 1}d`);

    const out = api.validateData(data);

    expect(api.CONFIG.MAX_RULES_PER_CATEGORY).toBe(50);
    expect(out.blocking.join(" ")).toContain("51");
  });

  test("a clean page blocks nothing", () => {
    const api = loadValidator({ whitelist: addresses(3), protectKeywords: keywords(3) });
    const out = api.validateData(baseData());
    expect(out.blocking).toEqual([]);
    expect(out.valid).toBe(true);
  });
});
