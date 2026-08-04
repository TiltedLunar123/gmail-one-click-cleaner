/**
 * @jest-environment node
 *
 * The uninstall page (8.9).
 *
 * The browser opens a fixed address after the extension is removed.
 * That is a real, if minimal, disclosure: the site learns an install of
 * something was removed, from some IP, at some time. Everything here
 * exists to keep it minimal, because the moment a parameter is appended
 * this stops being a goodbye page and becomes telemetry, and the
 * listings promise there is none.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const bgSrc = read("background.js");
const page = read("netlify/site/uninstall.html");

const URL_MATCH = bgSrc.match(/const UNINSTALL_URL = "([^"]+)"/);

describe("the address the browser is given", () => {
  test("the worker holds it, and it is the page that exists", () => {
    expect(URL_MATCH).not.toBeNull();
    expect(URL_MATCH[1]).toBe("https://gmail-cleaner-pro.netlify.app/uninstall.html");
    expect(fs.existsSync(path.join(ROOT, "netlify/site/uninstall.html"))).toBe(true);
  });

  test("it carries nothing about this user", () => {
    // No query string, no fragment, no template interpolation. An id, a
    // version or an install source appended here would be a report the
    // extension had promised never to send.
    const url = URL_MATCH[1];
    expect(url).not.toContain("?");
    expect(url).not.toContain("#");
    expect(url).not.toContain("$");
    expect(url.startsWith("https://")).toBe(true);
  });

  test("it is set from a helper, not built at the call site", () => {
    // Two call sites (install and startup). A URL assembled at each is
    // how one of them quietly grows a parameter.
    expect(bgSrc).toContain("function setUninstallPage() {");
    expect(bgSrc).toContain("chrome.runtime.setUninstallURL?.(UNINSTALL_URL");
    expect(bgSrc.split("setUninstallPage()").length - 1).toBeGreaterThanOrEqual(3);
  });

  test("a browser without the API does not break the worker", () => {
    const at = bgSrc.indexOf("function setUninstallPage() {");
    const fn = bgSrc.slice(at, bgSrc.indexOf("\n  }", at));
    expect(fn).toContain("try {");
    expect(fn).toContain("chrome.runtime.setUninstallURL?.(");
  });

  test("setting it did not give the extension a network call", () => {
    // setUninstallURL hands the browser an address to open later. It is
    // not a request, and nothing here may become one.
    const NETWORK = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource/;
    expect(NETWORK.test(bgSrc)).toBe(false);
  });
});

describe("what the page says", () => {
  test("it tells Pro buyers their key survived", () => {
    // The single most expensive misunderstanding available here: a
    // lifetime licence that looks like it died with the uninstall.
    expect(page).toContain("Your key is still yours.");
    expect(page).toContain("./recover.html");
  });

  test("it offers both stores, by their real listing addresses", () => {
    expect(page).toContain("https://chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc");
    expect(page).toContain("https://addons.mozilla.org/firefox/addon/gmail-one-click-cleaner@gmail-cleaner-pro.netlify.app/");
    const shared = read("shared.js");
    for (const url of [
      "https://chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc",
      "https://addons.mozilla.org/firefox/addon/gmail-one-click-cleaner@gmail-cleaner-pro.netlify.app/"
    ]) {
      expect(shared).toContain(url);
    }
  });

  test("it explains why it opened, and does not overclaim", () => {
    expect(page).toContain("Why you are seeing this page.");
    expect(page).toContain("carries no identifier");
  });

  test("it is not indexable", () => {
    // It exists for one moment in one person's browser, not for search.
    expect(page).toContain('<meta name="robots" content="noindex" />');
  });

  test("it does not promise the mail is unrecoverable or gone", () => {
    expect(page).toContain("Trash");
    expect(page).toContain("30 days");
  });
});
