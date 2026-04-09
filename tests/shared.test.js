/**
 * @jest-environment node
 */
const fs = require("fs");
const path = require("path");

// Load shared.js by extracting and evaluating the IIFE
const code = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const iifeMatch = code.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome",
  `return ${iifeMatch[1]}`
)(
  // Minimal DOM stubs needed by shared.js
  {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => ({
      className: "", setAttribute: () => {}, appendChild: () => {},
      style: {}, classList: { add: () => {}, remove: () => {} },
      remove: () => {}
    }),
    addEventListener: () => {}
  },
  { structuredClone: typeof structuredClone !== "undefined" ? structuredClone : undefined },
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

describe("shared.js — GCC utilities", () => {

  // ===========================
  // formatNumber
  // ===========================

  describe("formatNumber", () => {
    test("formats integers with locale separators", () => {
      expect(GCC.formatNumber(0)).toBe("0");
      expect(GCC.formatNumber(42)).toBeTruthy();
      expect(GCC.formatNumber(1000000)).toBeTruthy();
    });

    test("returns '0' for non-finite numbers", () => {
      expect(GCC.formatNumber(NaN)).toBe("0");
      expect(GCC.formatNumber(Infinity)).toBe("0");
      expect(GCC.formatNumber(-Infinity)).toBe("0");
    });

    test("returns '0' for non-number input", () => {
      expect(GCC.formatNumber("abc")).toBe("0");
      expect(GCC.formatNumber(null)).toBe("0");
      expect(GCC.formatNumber(undefined)).toBe("0");
    });
  });

  // ===========================
  // formatMb
  // ===========================

  describe("formatMb", () => {
    test("returns '0 MB' for falsy/tiny values", () => {
      expect(GCC.formatMb(0)).toBe("0 MB");
      expect(GCC.formatMb(null)).toBe("0 MB");
      expect(GCC.formatMb(0.001)).toBe("0 MB");
    });

    test("formats megabytes", () => {
      expect(GCC.formatMb(5.5)).toBe("5.5 MB");
      expect(GCC.formatMb(100)).toBe("100.0 MB");
    });

    test("converts to GB above 1024 MB", () => {
      expect(GCC.formatMb(1024)).toBe("1.0 GB");
      expect(GCC.formatMb(2560)).toBe("2.5 GB");
    });
  });

  // ===========================
  // formatBytes
  // ===========================

  describe("formatBytes", () => {
    test("returns '0 MB' for zero/falsy", () => {
      expect(GCC.formatBytes(0)).toBe("0 MB");
      expect(GCC.formatBytes(null)).toBe("0 MB");
      expect(GCC.formatBytes(-5)).toBe("0 MB");
    });

    test("formats small byte values", () => {
      expect(GCC.formatBytes(500)).toBe("500 B");
    });

    test("formats kilobytes", () => {
      expect(GCC.formatBytes(1024)).toBe("1 KB");
      expect(GCC.formatBytes(1536)).toBe("1.5 KB");
    });

    test("formats megabytes", () => {
      expect(GCC.formatBytes(1048576)).toBe("1 MB");
    });

    test("formats gigabytes", () => {
      expect(GCC.formatBytes(1073741824)).toBe("1 GB");
    });
  });

  // ===========================
  // formatDuration
  // ===========================

  describe("formatDuration", () => {
    test("returns '-' for falsy", () => {
      expect(GCC.formatDuration(0)).toBe("-");
      expect(GCC.formatDuration(null)).toBe("-");
    });

    test("formats seconds", () => {
      expect(GCC.formatDuration(5000)).toBe("5s");
      expect(GCC.formatDuration(30000)).toBe("30s");
    });

    test("formats minutes and seconds", () => {
      expect(GCC.formatDuration(90000)).toBe("1m 30s");
      expect(GCC.formatDuration(300000)).toBe("5m 0s");
    });
  });

  // ===========================
  // formatDate
  // ===========================

  describe("formatDate", () => {
    test("returns '-' for non-finite/non-number", () => {
      expect(GCC.formatDate(NaN)).toBe("-");
      expect(GCC.formatDate(null)).toBe("-");
      expect(GCC.formatDate("abc")).toBe("-");
    });

    test("formats valid timestamp", () => {
      const ts = new Date("2024-06-15T12:00:00Z").getTime();
      const result = GCC.formatDate(ts);
      expect(result).not.toBe("-");
      expect(typeof result).toBe("string");
    });
  });

  // ===========================
  // relativeTime
  // ===========================

  describe("relativeTime", () => {
    test("returns '-' for falsy", () => {
      expect(GCC.relativeTime(0)).toBe("-");
      expect(GCC.relativeTime(null)).toBe("-");
    });

    test("returns 'just now' for recent timestamps", () => {
      expect(GCC.relativeTime(Date.now())).toBe("just now");
      expect(GCC.relativeTime(Date.now() - 30000)).toBe("just now");
    });

    test("returns minutes ago", () => {
      expect(GCC.relativeTime(Date.now() - 5 * 60000)).toBe("5m ago");
    });

    test("returns hours ago", () => {
      expect(GCC.relativeTime(Date.now() - 3 * 3600000)).toBe("3h ago");
    });

    test("returns days ago", () => {
      expect(GCC.relativeTime(Date.now() - 2 * 86400000)).toBe("2d ago");
    });
  });

  // ===========================
  // escapeHtml
  // ===========================

  describe("escapeHtml", () => {
    test("escapes HTML entities", () => {
      expect(GCC.escapeHtml('<script>alert("xss")</script>')).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    });

    test("escapes ampersand", () => {
      expect(GCC.escapeHtml("a & b")).toBe("a &amp; b");
    });

    test("escapes single quotes", () => {
      expect(GCC.escapeHtml("it's")).toBe("it&#39;s");
    });

    test("returns empty string for non-string", () => {
      expect(GCC.escapeHtml(null)).toBe("");
      expect(GCC.escapeHtml(123)).toBe("");
      expect(GCC.escapeHtml(undefined)).toBe("");
    });

    test("passes through safe strings unchanged", () => {
      expect(GCC.escapeHtml("hello world")).toBe("hello world");
    });
  });

  // ===========================
  // clamp
  // ===========================

  describe("clamp", () => {
    test("clamps below minimum", () => {
      expect(GCC.clamp(-5, 0, 100)).toBe(0);
    });

    test("clamps above maximum", () => {
      expect(GCC.clamp(150, 0, 100)).toBe(100);
    });

    test("returns value within range", () => {
      expect(GCC.clamp(50, 0, 100)).toBe(50);
    });

    test("handles edge values", () => {
      expect(GCC.clamp(0, 0, 100)).toBe(0);
      expect(GCC.clamp(100, 0, 100)).toBe(100);
    });
  });

  // ===========================
  // truncate
  // ===========================

  describe("truncate", () => {
    test("returns string unchanged if under limit", () => {
      expect(GCC.truncate("hello", 120)).toBe("hello");
    });

    test("truncates long strings with ellipsis", () => {
      const long = "a".repeat(200);
      const result = GCC.truncate(long, 120);
      expect(result.length).toBe(120);
      expect(result.endsWith("...")).toBe(true);
    });

    test("returns empty string for non-string", () => {
      expect(GCC.truncate(null)).toBe("");
      expect(GCC.truncate(123)).toBe("");
    });
  });

  // ===========================
  // debounce
  // ===========================

  describe("debounce", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("delays function execution", () => {
      const fn = jest.fn();
      const debounced = GCC.debounce(fn, 200);

      debounced();
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(200);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("resets timer on repeated calls", () => {
      const fn = jest.fn();
      const debounced = GCC.debounce(fn, 200);

      debounced();
      jest.advanceTimersByTime(100);
      debounced();
      jest.advanceTimersByTime(100);
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
