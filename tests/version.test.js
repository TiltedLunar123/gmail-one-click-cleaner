/**
 * @jest-environment node
 *
 * Catches version drift between manifest.json, package.json, and the
 * hardcoded *_VERSION constants in each script. Fails loudly when one
 * gets bumped without the others.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");
const manifest = JSON.parse(read("manifest.json"));
const pkg = JSON.parse(read("package.json"));

const SCRIPT_VERSIONS = [
  ["background.js", "SW_VERSION"],
  ["contentScript.js", "GCC_CONTENT_VERSION"],
  ["popup.js", "POPUP_VERSION"],
  ["options.js", "OPTIONS_VERSION"],
  ["progress.js", "PROGRESS_VERSION"],
  ["diagnostics.js", "DIAGNOSTICS_VERSION"]
];

const HTML_BADGES = [
  ["progress.html", /id="versionPill"[^>]*>v([0-9.]+)</],
  ["diagnostics.html", /aria-label="Version ([0-9.]+)">/],
  // The popup badge is synced from the manifest at runtime, but the
  // static fallback drifted once (stuck at 6.0.0 through two releases)
  // so it gets pinned here too.
  ["popup.html", /id="versionBadge"[^>]*>v([0-9.]+)</]
];

describe("version consistency", () => {
  test("manifest.json and package.json agree", () => {
    expect(pkg.version).toBe(manifest.version);
  });

  test("manifest version_name starts with manifest version", () => {
    expect(manifest.version_name.startsWith(manifest.version)).toBe(true);
  });

  test.each(SCRIPT_VERSIONS)("%s declares %s matching manifest", (file, name) => {
    const source = read(file);
    const re = new RegExp(`const\\s+${name}\\s*=\\s*"([0-9.]+)"`);
    const match = source.match(re);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(manifest.version);
  });

  test.each(HTML_BADGES)("%s badge matches manifest", (file, re) => {
    const source = read(file);
    const match = source.match(re);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(manifest.version);
  });
});
