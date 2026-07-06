/**
 * @jest-environment node
 *
 * 7.1 cross-browser helpers: browser detection, per-store links, and
 * the Gmail host-access wrapper. Wrong answers here send Firefox users
 * to a store they cannot install from, or hide the grant banner on a
 * profile that revoked host access.
 */
const fs = require("fs");
const path = require("path");

const UA = {
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87",
  firefoxWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  braveLike:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
};

// Load shared.js the same way shared.test.js does: extract the IIFE and
// evaluate it against injected globals.
const loadGCC = (chromeMock) => {
  const code = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
  const iifeMatch = code.match(/const GCC = ([\s\S]*);[\s]*$/);
  return new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
    {
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({
        className: "", setAttribute: () => {}, appendChild: () => {},
        style: {}, classList: { add: () => {}, remove: () => {} },
        remove: () => {}
      }),
      addEventListener: () => {}
    },
    {},
    chromeMock
  );
};

const baseChrome = { runtime: { lastError: null }, storage: { local: { get: () => {} } } };

describe("GCC.detectBrowser", () => {
  const GCC = loadGCC(baseChrome);

  test("identifies Chrome", () => {
    expect(GCC.detectBrowser(UA.chromeWin)).toBe("chrome");
  });

  test("identifies Edge (which also carries Chrome/ in its UA)", () => {
    expect(GCC.detectBrowser(UA.edgeWin)).toBe("edge");
  });

  test("identifies Firefox", () => {
    expect(GCC.detectBrowser(UA.firefoxWin)).toBe("firefox");
  });

  test("other Chromiums fall back to chrome", () => {
    expect(GCC.detectBrowser(UA.braveLike)).toBe("chrome");
  });

  test("empty / missing UA falls back to chrome", () => {
    expect(GCC.detectBrowser("")).toBe("chrome");
  });
});

describe("GCC.storeLinks", () => {
  const GCC = loadGCC(baseChrome);

  test("Chrome gets the Chrome Web Store listing and reviews", () => {
    const links = GCC.storeLinks(UA.chromeWin);
    expect(links.browser).toBe("chrome");
    expect(links.listing).toContain("chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc");
    expect(links.reviews).toBe(links.listing + "/reviews");
  });

  test("Edge is pointed at the Chrome Web Store on purpose", () => {
    const links = GCC.storeLinks(UA.edgeWin);
    expect(links.browser).toBe("edge");
    expect(links.listing).toContain("chromewebstore.google.com");
  });

  test("Firefox gets the AMO listing addressed by add-on ID", () => {
    const links = GCC.storeLinks(UA.firefoxWin);
    expect(links.browser).toBe("firefox");
    expect(links.listing).toContain("addons.mozilla.org");
    expect(links.listing).toContain("gmail-one-click-cleaner@gmail-cleaner-pro.netlify.app");
    expect(links.reviews).toBe(links.listing + "reviews/");
  });
});

describe("GCC.gmailAccess", () => {
  const withPermissions = (impl) =>
    loadGCC({
      ...baseChrome,
      permissions: impl
    });

  test("check() is true when the origin is granted", async () => {
    const GCC = withPermissions({
      contains: (origins, cb) => cb(true),
      request: (origins, cb) => cb(true)
    });
    await expect(GCC.gmailAccess.check()).resolves.toBe(true);
  });

  test("check() is false when the origin is missing", async () => {
    const GCC = withPermissions({
      contains: (origins, cb) => cb(false)
    });
    await expect(GCC.gmailAccess.check()).resolves.toBe(false);
  });

  test("check() passes the Gmail origin pattern", async () => {
    let seen = null;
    const GCC = withPermissions({
      contains: (origins, cb) => { seen = origins; cb(true); }
    });
    await GCC.gmailAccess.check();
    expect(seen).toEqual({ origins: ["https://mail.google.com/*"] });
  });

  test("check() errs toward true when the permissions API is absent", async () => {
    const GCC = loadGCC(baseChrome);
    await expect(GCC.gmailAccess.check()).resolves.toBe(true);
  });

  test("check() errs toward true when contains throws", async () => {
    const GCC = withPermissions({
      contains: () => { throw new Error("boom"); }
    });
    await expect(GCC.gmailAccess.check()).resolves.toBe(true);
  });

  test("request() reflects the user's answer", async () => {
    const yes = withPermissions({ request: (origins, cb) => cb(true) });
    const no = withPermissions({ request: (origins, cb) => cb(false) });
    await expect(yes.gmailAccess.request()).resolves.toBe(true);
    await expect(no.gmailAccess.request()).resolves.toBe(false);
  });

  test("request() is false when the permissions API is absent", async () => {
    const GCC = loadGCC(baseChrome);
    await expect(GCC.gmailAccess.request()).resolves.toBe(false);
  });
});
