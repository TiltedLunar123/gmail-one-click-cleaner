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
  ["diagnostics.js", "DIAGNOSTICS_VERSION"],
  ["changelog.js", "CHANGELOG_VERSION"]
];

const HTML_BADGES = [
  ["progress.html", /id="versionPill"[^>]*>v([0-9.]+)</],
  ["diagnostics.html", /aria-label="Version ([0-9.]+)">/],
  // The popup badge is synced from the manifest at runtime, but the
  // static fallback drifted once (stuck at 6.0.0 through two releases)
  // so it gets pinned here too.
  ["popup.html", /id="versionBadge"[^>]*>v([0-9.]+)</],
  // 8.9: the What's new page. Its badge is filled from the manifest at
  // runtime like the popup's, so this pins the static fallback.
  ["changelog.html", /id="versionBadge"[^>]*>v([0-9.]+)</],
  // 8.21: diagnostics.html was pinned by its aria-label alone, so its
  // VISIBLE badge was free to drift, and it did: the 8.21 bump left it
  // reading v8.20.0 next to an aria-label that said 8.21.0 -- the exact
  // inverse of the 8.14 bug that put this file's announced-version block
  // here in the first place. Both halves of every badge now.
  ["diagnostics.html", /class="badge"[^>]*>v([0-9.]+)</]
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

  // 8.14: the badge pins above read `id="versionBadge"[^>]*>v(...)<`, and
  // `[^>]*` walks straight over the element's own attributes. The popup's
  // version button carried aria-label="Version 8.10.0" for four releases
  // while its visible text tracked the manifest, so a screen reader was
  // told the wrong version and nothing failed. Every announced version,
  // on every page, is pinned here instead.
  // 8.15: the loop above was still not a gate. Three of its six files
  // carry no announced version at all, so those cases matched nothing
  // and asserted nothing, and the one page it was written for could be
  // reworded out of the pattern without a single failure (proved by
  // mutation: `aria-label="Version v8.10.0"` kept the whole suite
  // green). The pages that are SUPPOSED to announce a version are named
  // here, and each one has to produce at least one match before the
  // values are compared.
  const ANNOUNCE_VERSION = ["popup.html", "diagnostics.html", "changelog.html"];
  const NO_ANNOUNCE = ["options.html", "progress.html", "stats.html"];

  const announcedIn = (file) =>
    [...read(file).matchAll(/aria-label="Version ([0-9]+\.[0-9]+\.[0-9]+)/g)].map((m) => m[1]);

  test.each(ANNOUNCE_VERSION)("%s announces the manifest version to screen readers", (file) => {
    const announced = announcedIn(file);
    expect(announced.length).toBeGreaterThan(0);
    for (const v of announced) expect(v).toBe(manifest.version);
  });

  // Named rather than skipped: if one of these grows a version label
  // later, this fails and the file moves into the list above rather than
  // slipping into an unpinned one.
  test.each(NO_ANNOUNCE)("%s does not announce a version, so nothing can drift there", (file) => {
    expect(announcedIn(file)).toHaveLength(0);
  });
});
