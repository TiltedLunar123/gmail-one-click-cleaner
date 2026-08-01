/**
 * @jest-environment node
 *
 * The privacy policy link (8.6).
 *
 * The listings, SECURITY.md and the AMO reviewer notes all rest on one
 * claim competitors cannot match: grep the shipped bundle for a network
 * call and it comes back empty. A privacy link is the cheapest thing
 * imaginable to get wrong in that direction, so it is an anchor the
 * browser follows on click, never anything the extension fetches. The
 * last test here is the one that matters; the rest keep the link
 * working.
 *
 * Hosted rather than bundled on purpose. A policy shipped inside the
 * package is frozen at whatever the last release said, and a stale
 * privacy policy is worse than no link at all.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const sharedSrc = read("shared.js");
const popupSrc = read("popup.js");
const optionsSrc = read("options.js");
const popupHtml = read("popup.html");
const optionsHtml = read("options.html");

const URL_MATCH = sharedSrc.match(/const PRIVACY_URL = "([^"]+)"/);

describe("the privacy policy is reachable from inside the extension", () => {
  test("shared.js holds the URL, and it is the published one", () => {
    expect(URL_MATCH).not.toBeNull();
    const url = URL_MATCH[1];
    expect(url.startsWith("https://")).toBe(true);
    // The same URL both store listings carry, so what the extension
    // shows and what the stores show cannot drift apart.
    expect(url).toBe("https://secplusmastery.com/extensions#gmail-one-click-cleaner-privacy");
    expect(read("README.md")).toContain(url);
  });

  test("it lives in exactly one place", () => {
    // Two copies is how one of them goes stale.
    const url = URL_MATCH[1];
    for (const [name, src] of [["popup.js", popupSrc], ["options.js", optionsSrc],
      ["popup.html", popupHtml], ["options.html", optionsHtml]]) {
      if (src.includes(url)) throw new Error(`${name} hardcodes the policy URL; read GCC.PRIVACY_URL`);
    }
    expect(sharedSrc.split(url).length - 1).toBe(1);
    expect(sharedSrc).toContain("PRIVACY_URL,");
  });

  test("both surfaces carry the link and both fill it from shared.js", () => {
    for (const html of [popupHtml, optionsHtml]) {
      expect(html).toContain('id="privacyPolicyLink"');
    }
    expect(popupSrc).toContain("elements.privacyPolicyLink.href = GCC.PRIVACY_URL;");
    expect(optionsSrc).toContain("privacyLink.href = GCC.PRIVACY_URL;");
  });

  test("it opens in a new tab without leaking where it came from", () => {
    for (const [name, html] of [["popup.html", popupHtml], ["options.html", optionsHtml]]) {
      const at = html.indexOf('id="privacyPolicyLink"');
      expect(at).toBeGreaterThan(-1);
      const tag = html.slice(at, html.indexOf(">", at));
      for (const attr of ['target="_blank"', 'rel="noopener noreferrer"', 'referrerpolicy="no-referrer"']) {
        if (!tag.includes(attr)) throw new Error(`${name} privacy link is missing ${attr}`);
      }
    }
  });

  test("adding it did not give the extension its first network call", () => {
    // A link is the browser navigating on a click. A request would be
    // the extension reaching out, which would break the one claim the
    // listings, SECURITY.md and the AMO reviewer notes all rest on.
    const SHIPPED = [
      "shared.js", "popup.js", "options.js", "background.js",
      "contentScript.js", "progress.js", "stats.js", "diagnostics.js",
      "browser-polyfill.js"
    ];
    const NETWORK = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource|\.ajax\s*\(/;
    for (const file of SHIPPED) {
      const hit = read(file).split(/\r?\n/).findIndex((line) => NETWORK.test(line));
      if (hit !== -1) {
        throw new Error(`${file}:${hit + 1} introduces a network call: ${read(file).split(/\r?\n/)[hit].trim()}`);
      }
    }
  });
});
