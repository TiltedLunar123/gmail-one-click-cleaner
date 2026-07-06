/**
 * @jest-environment node
 *
 * Firefox target build: the manifest transform is where a broken store
 * submission would come from (AMO rejects service_worker backgrounds
 * and ID-less MV3 add-ons), so both the pure transform and the built
 * artifact are pinned here.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const { firefoxManifest, FILES, GECKO_ID } = require("../build.js");

const ROOT = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "gcc-ff-build-"));

const rootManifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8")
);

beforeAll(() => {
  execFileSync("node", ["build.js", "--target=firefox"], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, GCC_DIST_FIREFOX: OUT }
  });
});

afterAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
});

describe("firefoxManifest transform", () => {
  const ff = firefoxManifest(rootManifest);

  test("uses an event page, not a service worker", () => {
    expect(ff.background).toEqual({
      scripts: ["browser-polyfill.js", "background.js"]
    });
    expect(ff.background.service_worker).toBeUndefined();
  });

  test("carries the gecko add-on ID and min version", () => {
    expect(ff.browser_specific_settings.gecko.id).toBe(GECKO_ID);
    expect(ff.browser_specific_settings.gecko.strict_min_version).toBe("140.0");
  });

  test("fits AMO's 45-character name cap", () => {
    expect(ff.name.length).toBeLessThanOrEqual(45);
    expect(ff.name).toContain("Gmail One-Click Cleaner");
  });

  test("declares no data collection (required for new AMO submissions)", () => {
    expect(ff.browser_specific_settings.gecko.data_collection_permissions)
      .toEqual({ required: ["none"] });
  });

  test("swaps options_page for options_ui in a tab", () => {
    expect(ff.options_page).toBeUndefined();
    expect(ff.options_ui).toEqual({ page: "options.html", open_in_tab: true });
  });

  test("drops the Chrome-only minimum_chrome_version key", () => {
    expect(ff.minimum_chrome_version).toBeUndefined();
  });

  test("keeps version, permissions and host permissions identical", () => {
    expect(ff.version).toBe(rootManifest.version);
    expect(ff.permissions).toEqual(rootManifest.permissions);
    expect(ff.host_permissions).toEqual(rootManifest.host_permissions);
  });

  test("does not mutate the source manifest", () => {
    const before = JSON.stringify(rootManifest);
    firefoxManifest(rootManifest);
    expect(JSON.stringify(rootManifest)).toBe(before);
  });
});

describe("firefox dist build", () => {
  test.each(FILES)("ships %s", (file) => {
    expect(fs.existsSync(path.join(OUT, file))).toBe(true);
  });

  test("ships the icons", () => {
    expect(fs.existsSync(path.join(OUT, "icons", "icon128.png"))).toBe(true);
    expect(fs.existsSync(path.join(OUT, "icons", "icon16.png"))).toBe(true);
  });

  test("built manifest matches the transform of the root manifest", () => {
    const built = JSON.parse(
      fs.readFileSync(path.join(OUT, "manifest.json"), "utf-8")
    );
    expect(built).toEqual(firefoxManifest(rootManifest));
  });
});
