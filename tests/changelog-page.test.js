/**
 * @jest-environment jsdom
 *
 * The in-extension What's new page (8.9).
 *
 * Two things here are load-bearing beyond ordinary shape checks.
 *
 * 1. changelog-data.js is GENERATED from CHANGELOG.md, and a generated
 *    file that is committed goes stale the moment someone edits the
 *    source and forgets to regenerate. The first block re-runs the
 *    generator in memory and compares.
 * 2. The page must not have given the extension its first network call.
 *    That claim is what the store listings, SECURITY.md and the AMO
 *    reviewer notes all rest on, and "just fetch the markdown" is the
 *    obvious way to have built this.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const data = require("../changelog-data.js");
const pageHtml = read("changelog.html");
const pageJs = read("changelog.js");
const manifest = JSON.parse(read("manifest.json"));

describe("the release notes are baked in, not fetched", () => {
  test("nothing on this page reaches the network", () => {
    const NETWORK = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource/;
    for (const [name, src] of [["changelog.js", pageJs], ["changelog-data.js", read("changelog-data.js")]]) {
      expect(NETWORK.test(src)).toBe(false);
      expect(name).toBeTruthy();
    }
  });

  test("the page loads the data as a script, and both ship", () => {
    expect(pageHtml).toContain('<script src="changelog-data.js" defer></script>');
    const { FILES } = require("../build.js");
    for (const f of ["changelog.html", "changelog.js", "changelog-data.js"]) {
      expect(FILES).toContain(f);
    }
  });

  test("its content security policy allows no remote script", () => {
    expect(pageHtml).toContain("script-src 'self'");
    expect(pageHtml).toContain("default-src 'self'");
  });
});

describe("the generated data is in step with CHANGELOG.md", () => {
  test("regenerating produces exactly the committed file", () => {
    // Runs the real generator in --check mode: it exits non-zero when
    // the committed file differs from what CHANGELOG.md would produce.
    execFileSync(process.execPath, ["tools/build-changelog.mjs", "--check"], {
      cwd: ROOT,
      stdio: "pipe"
    });
  });

  test("the newest entry is the version being shipped", () => {
    expect(data.entries[0].version).toBe(manifest.version);
  });

  test("it carries a subset and says how big the whole log is", () => {
    expect(data.entries.length).toBeGreaterThan(5);
    expect(data.total).toBeGreaterThanOrEqual(data.entries.length);
    const headings = read("CHANGELOG.md").split(/\r?\n/).filter((l) => l.startsWith("## "));
    expect(data.total).toBe(headings.length);
  });

  test("every entry has a version and something to say", () => {
    for (const entry of data.entries) {
      expect(typeof entry.version).toBe("string");
      expect(entry.version).toMatch(/^[0-9]/);
      const hasBody = Boolean(entry.intro?.length || entry.items?.length || entry.sections?.length);
      expect(hasBody).toBe(true);
    }
  });

  test("bold and code runs survive the markdown hard wrap", () => {
    // The log wraps at ~72 columns, so a **bold run** routinely straddles
    // a line break. A naive line-by-line parser drops those.
    const flat = JSON.stringify(data);
    expect(flat).toContain('["b",');
    const bolds = [...flat.matchAll(/\["b","([^"]{20,})"/g)].map((m) => m[1]);
    expect(bolds.some((b) => b.includes(" "))).toBe(true);
    // No entry may still carry raw markdown markers.
    expect(flat).not.toContain("**");
  });
});

describe("the page renders it without building any markup from text", () => {
  test("runs become text nodes and elements, never innerHTML", () => {
    expect(pageJs).not.toContain("innerHTML");
    expect(pageJs).toContain("document.createTextNode(runs)");
    expect(pageJs).toContain('document.createElement("strong")');
  });

  test("an entry whose text contains angle brackets stays text", () => {
    document.body.innerHTML = "<div id='host'></div>";
    const host = document.getElementById("host");
    // Mirrors appendRuns: this is the property being protected.
    const strong = document.createElement("strong");
    strong.textContent = "<img src=x onerror=1>";
    host.appendChild(strong);
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img");
  });
});

describe("the way in, and the dot on it", () => {
  test("the popup's version badge is the button that opens it", () => {
    const popupHtml = read("popup.html");
    expect(popupHtml).toMatch(/<button[^>]*id="versionBadge"/);
    expect(popupHtml).toContain('data-i18n-title="whatsNewTitle"');
    expect(read("popup.js")).toContain('elements.versionBadge?.addEventListener("click", openChangelog);');
  });

  test("its accessible name says what pressing it does", () => {
    // A button whose whole label is "v8.9.0" announces nothing useful.
    expect(read("popup.js")).toContain('t("versionBadgeAria"');
    expect(JSON.parse(read("_locales/en/messages.json")).versionBadgeAria.message)
      .toContain("what's new");
  });

  test("Options links to the same page", () => {
    expect(read("options.html")).toContain('id="changelogLink"');
    expect(read("options.html")).toContain('href="changelog.html"');
  });

  test("opening the page clears the marker the dot reads", () => {
    expect(pageJs).toContain('const SEEN_KEY = "changelogSeenVersion";');
    // Written before rendering: a data problem must not leave a dot
    // nobody can ever clear.
    const initAt = pageJs.indexOf("async function init() {");
    const markAt = pageJs.indexOf("await markSeen(version);", initAt);
    const renderAt = pageJs.indexOf("renderIndex(entries, version);", initAt);
    expect(markAt).toBeGreaterThan(-1);
    expect(renderAt).toBeGreaterThan(markAt);
  });

  test("a fresh install starts with no dot, an update starts with one", () => {
    const bg = read("background.js");
    expect(bg).toContain('if (details.reason === "install") await markChangelogSeen();');
    // The marker is local: reading the notes on one machine should not
    // silence the dot on another.
    expect(bg).toContain('CHANGELOG_SEEN: "changelogSeenVersion"');
    expect(read("background.js")).toContain("chrome.storage.local.set({ [STORAGE_KEYS.CHANGELOG_SEEN]: version })");
  });
});

describe("the page's own version pin", () => {
  test("the static badge matches the manifest", () => {
    const m = pageHtml.match(/id="versionBadge"[^>]*>v([0-9.]+)</);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(manifest.version);
  });

  test("the script declares the same version", () => {
    const m = pageJs.match(/const\s+CHANGELOG_VERSION\s*=\s*"([0-9.]+)"/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(manifest.version);
  });
});
