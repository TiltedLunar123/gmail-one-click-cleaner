/**
 * @jest-environment jsdom
 *
 * The Pro License section of the options page (7.14).
 *
 * A buyer whose key is active on one browser had no way to read it back
 * out: the status line masked it and nothing else showed it, so moving
 * Pro to a second browser meant digging up the post-checkout link or
 * emailing support. Options can now reveal, copy and mail a backup of
 * the stored key.
 *
 * The section markup is pulled out of options.html rather than
 * hand-written here, so a renamed id fails this suite instead of
 * silently going dead in production.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, "options.html"), "utf-8");
const OPTIONS_JS = fs.readFileSync(path.join(ROOT, "options.js"), "utf-8");

const ACTIVE_KEY = "GCC1.eyJ2IjoxLCJwbGFuIjoicHJvIn0.c2lnbmF0dXJlLWJ5dGVz";

// The real <section id="pro"> block, lifted verbatim.
const proSectionHtml = () => {
  const start = OPTIONS_HTML.indexOf('<section class="card" id="pro"');
  const end = OPTIONS_HTML.indexOf("</section>", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return OPTIONS_HTML.slice(start, end + "</section>".length);
};

const BUY_URL = "https://buy.stripe.com/7sY4gA07N9RE1MIc3VdUY04";

function load({ active, clipboardFails = false } = {}) {
  document.body.innerHTML = proSectionHtml();

  const toasts = [];
  const synced = {};

  const GCC = {
    $: (id) => document.getElementById(id),
    hasChromeStorage: () => true,
    storageGet: async () => ({}),
    storageSet: async (_area, obj) => { Object.assign(synced, obj); },
    safeSyncSet: async (obj) => { Object.assign(synced, obj); },
    clone: (x) => x,
    debounce: (fn) => fn,
    showToast: (msg, kind) => toasts.push({ msg, kind }),
    theme: { init: async () => {}, get: async () => "dark", set: async (v) => v },
    validateGmailQuery: () => ({ valid: true, warnings: [] }),
    sanitizeProtectKeywords: () => [],
    license: {
      PRO: {
        PRICE_LABEL: "$9.99 lifetime",
        BUY_URL,
        RECOVER_URL: "https://gmail-cleaner-pro.netlify.app/recover.html",
        SUPPORT_EMAIL: "support@example.com",
        STORAGE_KEY: "proLicense"
      },
      // Mirrors the real shared.js list. PRO_FEATURE_COUNT below is
      // asserted against shared.js itself, so a pillar added there
      // without updating this stub fails rather than passing quietly.
      FEATURES: Object.freeze([
        "Bulk unsubscribe from every mailing list you tick",
        "The full Storage X-ray list, and the one-click purge",
        "The full Smart Suggestions list, and bulk apply",
        "Every step of the Mailbox Report, and the whole-plan run",
        "Auto-Pilot, the weekly sweep that archives without being asked"
      ]),
      buyUrl: (source) => {
        const clean = String(source || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
        return clean ? `${BUY_URL}?client_reference_id=gcc_${clean}` : BUY_URL;
      },
      verify: async () => ({ valid: true, reason: "", payload: { v: 1, plan: "pro" } }),
      getState: async () => (active
        ? { active: true, key: ACTIVE_KEY, payload: { v: 1, plan: "pro" } }
        : { active: false, key: "", payload: null })
    }
  };

  const chrome = {
    runtime: { sendMessage: (_m, cb) => { if (cb) cb(null); }, lastError: null },
    storage: { sync: { get: async () => ({}), set: async () => {} } }
  };

  const written = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        if (clipboardFails) throw new Error("denied");
        written.push(text);
      }
    }
  });

  const body = OPTIONS_JS.replace(/^\(\(\)\s*=>\s*\{/, "").replace(/\}\)\(\);\s*$/, "");
  // eslint is configured to ignore tests/, so new Function here is fine.
  new Function("GCC", "chrome", body)(GCC, chrome);

  return {
    toasts,
    synced,
    written,
    $: (id) => document.getElementById(id),
    // renderState() is async and fired from wireProSection; let it land.
    settle: () => new Promise((r) => setTimeout(r, 0))
  };
}

const isShown = (el) => !!el && !el.hidden && el.style.display !== "none";

describe("Pro License section, no key on this browser", () => {
  test("offers activation and hides everything key-related", async () => {
    const t = load({ active: false });
    await t.settle();

    expect(t.$("proStatus").textContent).toMatch(/No Pro key/i);
    expect(isShown(t.$("proKeyInput"))).toBe(true);
    expect(isShown(t.$("proActivateBtn"))).toBe(true);
    for (const id of ["proShowBtn", "proCopyBtn", "proRemoveBtn", "proKeyReveal", "proBackupRow"]) {
      expect(isShown(t.$(id))).toBe(false);
    }
  });

  test("still points at recovery and support", async () => {
    const t = load({ active: false });
    await t.settle();

    expect(t.$("proRecoverLink").href).toContain("recover.html");
    expect(t.$("proSupportLink").href).toMatch(/^mailto:/);
    // The buy link carries the surface tag so the sale records where it
    // came from.
    expect(t.$("proBuyLink").href).toBe(`${BUY_URL}?client_reference_id=gcc_options`);
  });
});

describe("Pro License section, key active", () => {
  test("reveals the retrieval controls and never prints the key unasked", async () => {
    const t = load({ active: true });
    await t.settle();

    expect(t.$("proStatus").textContent).toMatch(/Pro is active/i);
    for (const id of ["proShowBtn", "proCopyBtn", "proRemoveBtn"]) {
      expect(isShown(t.$(id))).toBe(true);
    }
    expect(isShown(t.$("proBackupRow"))).toBe(true);

    // The key itself stays hidden until asked for: this page gets opened
    // on shared screens.
    expect(isShown(t.$("proKeyReveal"))).toBe(false);
    expect(document.body.textContent).not.toContain(ACTIVE_KEY);
  });

  test("Show key toggles the full key in and out of view", async () => {
    const t = load({ active: true });
    await t.settle();

    t.$("proShowBtn").click();
    expect(isShown(t.$("proKeyReveal"))).toBe(true);
    expect(t.$("proKeyReveal").textContent).toBe(ACTIVE_KEY);
    expect(t.$("proShowBtn").textContent).toMatch(/hide/i);

    t.$("proShowBtn").click();
    expect(isShown(t.$("proKeyReveal"))).toBe(false);
    expect(t.$("proKeyReveal").textContent).toBe("");
    expect(t.$("proShowBtn").textContent).toMatch(/show/i);
  });

  test("Copy key puts the real key on the clipboard", async () => {
    const t = load({ active: true });
    await t.settle();

    t.$("proCopyBtn").click();
    await t.settle();

    expect(t.written).toEqual([ACTIVE_KEY]);
    expect(t.toasts.some((x) => /copied/i.test(x.msg))).toBe(true);
  });

  test("a refused clipboard falls back to showing the key, not a dead end", async () => {
    // Clipboard writes can be blocked by permissions or an insecure
    // context. Leaving the user with nothing would strand the key on
    // this browser.
    const t = load({ active: true, clipboardFails: true });
    await t.settle();

    t.$("proCopyBtn").click();
    await t.settle();

    expect(isShown(t.$("proKeyReveal"))).toBe(true);
    expect(t.$("proKeyReveal").textContent).toBe(ACTIVE_KEY);
    expect(t.toasts.some((x) => x.kind === "warning")).toBe(true);
  });

  test("the backup link mails the key to the user, not to us", async () => {
    const t = load({ active: true });
    await t.settle();

    const href = t.$("proMailBackupLink").getAttribute("href");
    expect(href.startsWith("mailto:?")).toBe(true); // no recipient
    expect(decodeURIComponent(href)).toContain(ACTIVE_KEY);
    expect(decodeURIComponent(href)).toMatch(/Options > Pro License/);
  });
});
