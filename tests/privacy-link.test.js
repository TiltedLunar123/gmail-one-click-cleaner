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
    // 8.18.1: the policy moved off secplusmastery.com and into this
    // repo. Still one URL, so what the extension shows and what the
    // stores show cannot drift apart, as long as both dashboards point
    // here too.
    expect(url).toBe("https://github.com/TiltedLunar123/gmail-one-click-cleaner/blob/main/PRIVACY.md");
    expect(read("README.md")).toContain(url);
  });

  test("the policy it points at is actually in the repo", () => {
    // The old URL was hosted elsewhere, so a broken link could only be
    // caught by opening it. Now that the target is a file in this
    // repository, a rename or a delete can be caught here instead. A
    // 404 on this URL is not cosmetic: both stores require a working
    // privacy policy link and can pull a listing over a dead one.
    const url = URL_MATCH[1];
    const file = url.split("/blob/main/")[1];
    expect(file).toBe("PRIVACY.md");
    const policy = read(file);
    // Not just present: actually the policy, not a stub.
    expect(policy).toMatch(/# Gmail One-Click Cleaner privacy policy/);
    expect(policy).toMatch(/\*\*Effective \d{4}-\d{2}-\d{2}\.\*\*/);
    expect(policy.length).toBeGreaterThan(2000);
    // The claim the whole document rests on.
    expect(policy).toMatch(/no network requests of its own/);
  });

  test("nothing still LINKS to the retired secplusmastery policy", () => {
    // The page is gone, so any surviving link is a dead one.
    //
    // Comments are stripped first. The comment explaining that the
    // policy MOVED OFF secplusmastery.com necessarily names it, so a
    // bare substring search finds the note about the fix and reports
    // it as the fix being undone. Third time this repo has hit that;
    // match links, not prose.
    const strip = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    for (const f of ["shared.js", "README.md", "PRIVACY.md", "TERMS.md",
      "netlify/site/uninstall.html"]) {
      expect(`${f}: ${strip(read(f))}`).not.toMatch(/https?:\/\/(www\.)?secplusmastery\.com/);
    }
    // Prove the matcher still catches a real link, or it passes against
    // anything.
    expect("https://secplusmastery.com/extensions#x").toMatch(/https?:\/\/(www\.)?secplusmastery\.com/);
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
