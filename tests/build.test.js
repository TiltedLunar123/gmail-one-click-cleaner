/**
 * @jest-environment node
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

beforeAll(() => {
  // Clean dist before running build
  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
  execFileSync("node", ["build.js"], { cwd: ROOT, stdio: "pipe" });
});

afterAll(() => {
  // Clean up dist after tests
  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
});

describe("build.js", () => {
  test("creates dist directory", () => {
    expect(fs.existsSync(DIST)).toBe(true);
  });

  const EXPECTED_FILES = [
    "manifest.json",
    "background.js",
    "contentScript.js",
    "popup.html",
    "popup.js",
    "progress.html",
    "progress.js",
    "options.html",
    "options.js",
    "diagnostics.html",
    "diagnostics.js",
    "stats.html",
    "stats.js",
    "shared.css",
    "shared.js",
    "browser-polyfill.js"
  ];

  test.each(EXPECTED_FILES)("copies %s to dist", (file) => {
    expect(fs.existsSync(path.join(DIST, file))).toBe(true);
  });

  test("copies icons directory", () => {
    expect(fs.existsSync(path.join(DIST, "icons"))).toBe(true);
    expect(fs.existsSync(path.join(DIST, "icons", "icon128.png"))).toBe(true);
  });

  test("dist manifest matches source manifest version", () => {
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8"));
    const dist = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf-8"));
    expect(dist.version).toBe(src.version);
  });

  test("dist files are not empty", () => {
    for (const file of EXPECTED_FILES) {
      const stat = fs.statSync(path.join(DIST, file));
      expect(stat.size).toBeGreaterThan(0);
    }
  });
});
