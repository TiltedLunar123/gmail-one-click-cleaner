/**
 * @jest-environment node
 *
 * Covers the `build.js --minify` path (the esbuild branch). The plain
 * build is exercised in build.test.js; this one pins the minified output
 * so a future esbuild bump can't silently break or no-op the prod build.
 *
 * Builds into an isolated temp dir via GCC_DIST so it never races the
 * plain build in build.test.js over the shared ./dist directory.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "gcc-minify-"));

// JS files build.js minifies. browser-polyfill.js is deliberately left
// alone by the minify branch, so it is checked separately.
const MINIFIED_JS = [
  "shared.js",
  "background.js",
  "popup.js",
  "contentScript.js",
  "progress.js",
  "options.js",
  "diagnostics.js",
  "stats.js"
];

beforeAll(() => {
  execFileSync("node", ["build.js", "--minify"], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, GCC_DIST: OUT }
  });
});

afterAll(() => {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
});

describe("build.js --minify", () => {
  test("writes the minified bundle to the requested output dir", () => {
    expect(fs.existsSync(OUT)).toBe(true);
    expect(fs.existsSync(path.join(OUT, "manifest.json"))).toBe(true);
  });

  test.each(MINIFIED_JS)("%s is minified smaller than source", (file) => {
    const srcSize = fs.statSync(path.join(ROOT, file)).size;
    const outSize = fs.statSync(path.join(OUT, file)).size;
    expect(outSize).toBeGreaterThan(0);
    expect(outSize).toBeLessThan(srcSize);
  });

  test.each(MINIFIED_JS)("%s stays syntactically valid after minify", (file) => {
    const code = fs.readFileSync(path.join(OUT, file), "utf-8");
    // Throws on a syntax error; parsing only, nothing runs.
    expect(() => new vm.Script(code, { filename: file })).not.toThrow();
  });

  test("browser-polyfill.js is copied verbatim, not minified", () => {
    const src = fs.readFileSync(path.join(ROOT, "browser-polyfill.js"));
    const out = fs.readFileSync(path.join(OUT, "browser-polyfill.js"));
    expect(out.equals(src)).toBe(true);
  });
});
