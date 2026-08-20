/**
 * @jest-environment node
 *
 * 8.20 sweep: the review dialog's own buttons.
 *
 * Review Mode exists for one reason. The engine stops before a batch,
 * says how big it is, and lets the user refuse it. "Skip This Rule" is
 * that refusal, and it is the only control in this product whose whole
 * job is to stop mail being touched.
 *
 * The progress page's Enter shortcut was registered on `document`, so a
 * keydown from a focused button inside the dialog bubbled up to it. It
 * called preventDefault(), which cancels the activation the browser was
 * about to perform for that button, and then sent "resume". Tab to
 * "Skip This Rule", press Enter, and the batch you had just asked to
 * skip was cleaned instead. The button was not broken and not disabled:
 * it was outvoted by a shortcut listening one level above it.
 *
 * The popup found this exact shape in 8.12, on its own Enter-runs-the-
 * cleaner shortcut, and its comment states the rule: anything with its
 * own Enter behaviour keeps it. That guard was never carried here.
 *
 * Driven for real, with a fresh window per test. A shared jsdom document
 * would keep every previous boot's document-level listener alive, and
 * three stale listeners all answering one keypress is a suite that
 * measures its own harness. jsdom has no <dialog>, which the page
 * already tolerates (openReviewModal catches the showModal throw), so
 * `open` is set directly; everything else is the shipped code.
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function makeChrome(sent) {
  const area = () => ({
    get: (keys, cb) => (cb ? cb({}) : Promise.resolve({})),
    set: (obj, cb) => (cb ? cb() : Promise.resolve())
  });
  return {
    runtime: {
      id: "test-extension-id",
      getManifest: () => ({ version: "test" }),
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: (_msg, cb) => (cb ? cb({ ok: true }) : Promise.resolve({ ok: true })),
      onMessage: { addListener: () => {} },
      lastError: null
    },
    storage: { local: area(), sync: area(), session: area() },
    tabs: {
      sendMessage: (_id, msg, cb) => {
        sent.push(msg);
        if (cb) cb({ ok: true });
        return Promise.resolve({ ok: true });
      },
      get: (id, cb) => (cb ? cb({ id }) : Promise.resolve({ id })),
      query: (_q, cb) => (cb ? cb([]) : Promise.resolve([])),
      update: () => {},
      create: () => {}
    },
    scripting: {
      executeScript: (_o, cb) => (cb ? cb([{ result: false }]) : Promise.resolve([{ result: false }]))
    },
    i18n: { getMessage: () => "" }
  };
}

async function bootProgressPage() {
  const sent = [];
  const dom = new JSDOM(read("progress.html"), {
    // gmailTabId is parsed from the query string at load, and
    // sendReviewSignal refuses to send without it.
    url: "https://gcc.test/progress.html?gmailTabId=7",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const win = dom.window;
  win.chrome = makeChrome(sent);
  win.eval(read("shared.js") + read("progress.js"));
  await settle();

  const $ = (id) => win.document.getElementById(id);
  return {
    win,
    $,
    signals: () => sent.map((m) => m.type),
    openReview: () => { $("reviewModal").open = true; },
    pressEnterOn: async (el) => {
      el.focus();
      const ev = new win.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true
      });
      el.dispatchEvent(ev);
      await settle();
      return ev;
    },
    pressEscapeOn: async (el) => {
      el.focus();
      el.dispatchEvent(new win.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true
      }));
      await settle();
    },
    close: () => win.close()
  };
}

describe("Enter inside the Review Mode dialog", () => {
  let page;

  afterEach(() => {
    page?.close();
    page = null;
  });

  test("on Skip This Rule it skips, and the shortcut stays out of the way", async () => {
    page = await bootProgressPage();
    page.openReview();

    const ev = await page.pressEnterOn(page.$("modalSkipBtn"));

    // Before 8.20 this sent gmailCleanerResume and the batch the user
    // had just asked to skip was cleaned.
    expect(page.signals()).not.toContain("gmailCleanerResume");
    // And the browser's own activation of the focused button survives,
    // which is the half that makes the click listener fire at all.
    expect(ev.defaultPrevented).toBe(false);
  });

  test("on Proceed it proceeds through the button, not around it", async () => {
    page = await bootProgressPage();
    page.openReview();

    const ev = await page.pressEnterOn(page.$("modalProceedBtn"));

    expect(ev.defaultPrevented).toBe(false);
    // The shortcut did not fire it a second time behind the button's back.
    expect(page.signals()).toHaveLength(0);
  });

  test("from neutral focus it still proceeds, which is the case it was written for", async () => {
    page = await bootProgressPage();
    page.openReview();

    // The dialog itself, not one of its controls: nobody has tabbed
    // anywhere and Enter is unclaimed. Proceed carries autofocus in a
    // real browser, so this is the shortcut's honest remaining job.
    const ev = await page.pressEnterOn(page.$("reviewModal"));

    expect(ev.defaultPrevented).toBe(true);
    expect(page.signals()).toEqual(["gmailCleanerResume"]);
  });

  test("Escape refuses the batch even from a focused button", async () => {
    page = await bootProgressPage();
    page.openReview();

    await page.pressEscapeOn(page.$("modalSkipBtn"));

    expect(page.signals()).toEqual(["gmailCleanerSkip"]);
  });

  test("with no dialog open, Enter on a page control sends nothing", async () => {
    page = await bootProgressPage();

    const ev = await page.pressEnterOn(page.$("cancelBtn"));

    expect(ev.defaultPrevented).toBe(false);
    expect(page.signals()).toHaveLength(0);
  });
});

// =====================================================================
// The surfaces a live contrast scan cannot see
// =====================================================================
//
// 8.19's contrast pass measured 98 combinations across six pages in both
// themes and found none below the bar, and it named its own blind spot
// in as many words: a live scan only sees what is on screen. A dialog
// that has not been opened and a tooltip that is not being hovered are
// not on screen, and all three of the surfaces below were hardcoded dark
// panels wearing theme-coloured text.
//
// In the light theme --text-main on #141d27 measures 1.07:1. The Options
// page's "Restore Default Rules?" dialog is the last thing a user reads
// before every custom rule they have written is replaced, and its Cancel
// button was the invisible one while "Restore Defaults" stayed readable.

const stripCss = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/<!--[\s\S]*?-->/g, " ");

const ruleFor = (src, selector) => {
  const at = stripCss(src).indexOf(selector);
  if (at < 0) return null;
  const open = stripCss(src).indexOf("{", at);
  const close = stripCss(src).indexOf("}", open);
  return open < 0 || close < 0 ? null : stripCss(src).slice(open + 1, close);
};

describe("state-gated surfaces take their colours from the theme", () => {
  const OPTIONS = read("options.html");
  const DIAGNOSTICS = read("diagnostics.html");

  test.each([
    ["options.html", "dialog#confirmDialog", () => ruleFor(OPTIONS, "dialog#confirmDialog")],
    ["options.html", ".dialog-actions", () => ruleFor(OPTIONS, ".dialog-actions")],
    ["diagnostics.html", "[data-tooltip]::after", () => ruleFor(DIAGNOSTICS, "[data-tooltip]::after")]
  ])("%s %s paints a token background, never a fixed colour", (_file, _sel, get) => {
    const body = get();
    expect(body).not.toBeNull();
    const bg = body.match(/(?:^|[\s;])background(?:-color)?:\s*([^;]+);/);
    expect(bg).not.toBeNull();
    expect(bg[1]).toContain("var(--");
    expect(bg[1]).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(bg[1]).not.toMatch(/rgba?\(/);
  });

  test.each([
    [".dialog-title", () => ruleFor(OPTIONS, ".dialog-title")],
    [".dialog-body", () => ruleFor(OPTIONS, ".dialog-body")],
    [".dialog-btn", () => ruleFor(OPTIONS, ".dialog-btn")],
    [".dialog-btn.danger", () => ruleFor(OPTIONS, ".dialog-btn.danger")]
  ])("options.html %s inks through a token", (_sel, get) => {
    const body = get();
    expect(body).not.toBeNull();
    const color = body.match(/(?:^|[\s;])color:\s*([^;]+);/);
    expect(color).not.toBeNull();
    expect(color[1]).toContain("var(--");
  });

  test("the dialog's hover state is not a white wash", () => {
    // 8.18: a rule that hardcodes a white wash cannot be right on a pale
    // surface. Over --bg-deep in light that is 246,250,251 against
    // 245,250,251, which is no hover state at all.
    const body = ruleFor(OPTIONS, ".dialog-btn:hover");
    expect(body).not.toBeNull();
    expect(body).toContain("var(--bg-surface-hover)");
    expect(body).not.toMatch(/rgba\(255,\s*255,\s*255/);
  });

  test("no shipped page still hardcodes the old panel colour", () => {
    for (const f of ["options.html", "diagnostics.html", "popup.html", "progress.html", "stats.html", "changelog.html"]) {
      expect(stripCss(read(f))).not.toContain("#141d27");
    }
  });
});
