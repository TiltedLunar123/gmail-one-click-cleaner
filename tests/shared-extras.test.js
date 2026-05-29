/**
 * @jest-environment node
 *
 * Tests for utilities added in 5.0.0:
 *   - validateGmailQuery (issue #8 defense-in-depth)
 *   - classifyChromeError (issue #19 error classification)
 *   - estimateStorageBytes / safeSyncSet (issue #10 quota guard)
 *   - pollingInterval (issue #17 visibility-aware polling)
 */
const fs = require("fs");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const iifeMatch = code.match(/const GCC = ([\s\S]*);[\s]*$/);

const buildGcc = (overrides = {}) => {
  const doc = {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      className: "", setAttribute: () => {}, appendChild: () => {},
      style: {}, classList: { add: () => {}, remove: () => {} },
      remove: () => {}
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { setAttribute: () => {} },
    hidden: false,
    ...overrides.document
  };
  const win = {
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    ...overrides.window
  };
  const chromeStub = overrides.chrome || { runtime: { lastError: null } };
  const fn = new Function("document", "window", "chrome",
    `return ${iifeMatch[1]}`);
  return fn(doc, win, chromeStub);
};

describe("validateGmailQuery", () => {
  const GCC = buildGcc();

  test("rejects empty query", () => {
    const r = GCC.validateGmailQuery("");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/empty/i);
  });

  test("rejects query targeting starred mail without negation", () => {
    const r = GCC.validateGmailQuery("is:starred older_than:1y");
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/is:starred/);
  });

  test("accepts query that negates is:starred", () => {
    const r = GCC.validateGmailQuery("category:promotions -is:starred older_than:1y");
    expect(r.valid).toBe(true);
  });

  test("rejects is:important", () => {
    const r = GCC.validateGmailQuery("is:important");
    expect(r.valid).toBe(false);
  });

  test("rejects in:sent", () => {
    const r = GCC.validateGmailQuery("in:sent older_than:6m");
    expect(r.valid).toBe(false);
  });

  test("warns when in:inbox is used without age filter", () => {
    const r = GCC.validateGmailQuery("in:inbox");
    // Validity-wise no error, but a warning should surface.
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/older_than/);
  });

  test("does not warn when in:inbox has older_than", () => {
    const r = GCC.validateGmailQuery("in:inbox older_than:1y");
    expect(r.warnings).toEqual([]);
  });

  test("rejects too-long queries", () => {
    const r = GCC.validateGmailQuery("a".repeat(600));
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/too long/i);
  });

  test("accepts a normal cleanup query", () => {
    const r = GCC.validateGmailQuery("category:promotions older_than:1y");
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("classifyChromeError", () => {
  const GCC = buildGcc();

  test.each([
    ["Could not establish connection. Receiving end does not exist.", "tab_closed"],
    ["No tab with id: 42", "tab_closed"],
    ["The tab was closed", "tab_closed"],
    ["The message port closed before a response was received", "tab_closed"],
    ["Cannot access chrome:// URL", "permission"],
    ["Extensions can't access this page", "permission"],
    ["Something went terribly wrong", "other"],
    ["", "unknown"]
  ])("classifies %p as %p", (msg, kind) => {
    const out = GCC.classifyChromeError(msg ? new Error(msg) : null);
    expect(out.kind).toBe(kind);
  });
});

describe("estimateStorageBytes + safeSyncSet", () => {
  test("estimateStorageBytes returns a number for small objects", () => {
    const GCC = buildGcc();
    const bytes = GCC.estimateStorageBytes({ a: 1, b: "hello" });
    expect(typeof bytes).toBe("number");
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(100);
  });

  test("safeSyncSet rejects payloads exceeding the per-item quota", async () => {
    const setSpy = jest.fn();
    const GCC = buildGcc({
      chrome: {
        runtime: { id: "test", lastError: null },
        storage: {
          sync: {
            get: (k, cb) => cb && cb({}),
            set: (obj, cb) => { setSpy(obj); cb && cb(); }
          }
        }
      }
    });
    const big = { rules: "x".repeat(10000) }; // > 8KB
    await expect(GCC.safeSyncSet(big, "rules")).rejects.toThrow(/too large/);
    expect(setSpy).not.toHaveBeenCalled();
  });

  test("safeSyncSet passes small payloads through to chrome.storage.sync", async () => {
    const setSpy = jest.fn((obj, cb) => cb && cb());
    const GCC = buildGcc({
      chrome: {
        runtime: { id: "test", lastError: null },
        storage: {
          sync: {
            get: (k, cb) => cb && cb({}),
            set: setSpy
          }
        }
      }
    });
    await GCC.safeSyncSet({ rules: ["foo"] }, "rules");
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});

describe("pollingInterval (visibility-aware)", () => {
  test("starts running immediately when document is visible", () => {
    jest.useFakeTimers();
    const fn = jest.fn();
    const doc = {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ classList: { add: () => {}, remove: () => {} }, appendChild: () => {}, setAttribute: () => {}, style: {}, remove: () => {} }),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      hidden: false,
      documentElement: { setAttribute: () => {} }
    };
    const GCC = buildGcc({ document: doc });

    const stop = GCC.pollingInterval(fn, 500);
    expect(doc.addEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    jest.advanceTimersByTime(1500);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
    jest.useRealTimers();
  });

  test("does not start when document is hidden at construction", () => {
    jest.useFakeTimers();
    const fn = jest.fn();
    const doc = {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ classList: { add: () => {}, remove: () => {} }, appendChild: () => {}, setAttribute: () => {}, style: {}, remove: () => {} }),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      hidden: true,
      documentElement: { setAttribute: () => {} }
    };
    const GCC = buildGcc({ document: doc });
    const stop = GCC.pollingInterval(fn, 500);
    jest.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(0);
    stop();
    jest.useRealTimers();
  });
});

describe("DANGEROUS_QUERY_TOKENS export", () => {
  const GCC = buildGcc();
  test("includes all expected high-risk tokens", () => {
    expect(GCC.DANGEROUS_QUERY_TOKENS).toEqual(expect.arrayContaining([
      "is:starred",
      "is:important",
      "in:sent",
      "in:drafts"
    ]));
  });
});
