/**
 * @jest-environment jsdom
 *
 * 8.21, the surfaces. Two themes and four pages.
 *
 * The contrast half of this file is deliberately STATIC. Two releases ran
 * live scans over the rendered popup and reported zero, while a closed
 * dialog, an unhovered tooltip, a second mailbox and a cleared report row
 * were all failing underneath, because none of them is on screen during a
 * scan. Every rule here is resolved from source and measured, so a
 * surface does not have to be reachable in a headless browser to be
 * checked.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const POPUP_HTML = read("popup.html");
const POPUP_SRC = read("popup.js");
const OPTIONS_HTML = read("options.html");
const OPTIONS_SRC = read("options.js");
const PROGRESS_SRC = read("progress.js");
const STATS_SRC = read("stats.js");
const SHARED_CSS = read("shared.css");

/**
 * THE COMMENT TRAP, for the seventh time in this repo's history and the
 * first time inside its own tooling by design rather than by accident.
 *
 * A source pattern looking for a bug matches the comment that WARNS
 * about the bug. It has cost this project a false green and a false red
 * more than once, and it caught this very file during authoring: the
 * comment explaining why .account-pill no longer paints rgba(17,26,36,x)
 * contains the string "rgba(17,26,36,x)".
 *
 * The recorded lesson is "strip comments before ANY source pattern, in
 * tooling as well as tests", so every extractor here goes through this.
 */
const stripComments = (src) =>
  src
    // HTML comments too. The first version of this helper handled only
    // the two JavaScript forms, and the very next assertion tripped on
    // an <!-- --> block in popup.html. A comment is a comment in every
    // syntax the shipped files use.
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

/** One function or block, bounded at both ends. Throws when either goes. */
function between(src, startName, endName) {
  const clean = stripComments(src);
  const start = clean.indexOf(startName);
  if (start === -1) throw new Error(`not found: ${startName}`);
  const end = clean.indexOf(endName, start + startName.length);
  if (end === -1) throw new Error(`end not found: ${endName}`);
  return clean.slice(start, end);
}

// ---------------------------------------------------------------------
// WCAG plumbing
// ---------------------------------------------------------------------

const hex = (h) => {
  let s = h.replace("#", "").trim();
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
const lum = (c) => {
  const s = c.map((v) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * A token's real value in one theme, following var() indirection.
 *
 * Half the semantic inks are aliases in dark and literals in light:
 * `--ink-good: var(--success)` in dark, `#047857` in light. A reader
 * that only understands hex silently falls through to whatever hex it
 * finds NEXT in the file, which is the other theme's value, and then
 * reports a contrast failure that does not exist. That is how this
 * helper failed while it was being written.
 */
const tokenOf = (name, theme, depth = 0) => {
  if (depth > 4) throw new Error(`token ${name} loops in ${theme}`);
  const block = theme === "light"
    ? between(SHARED_CSS, '[data-theme="light"] {', "\n}")
    : between(SHARED_CSS, ":root,", "\n}");
  const m = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token ${name} not found for ${theme}`);
  const value = m[1].trim();
  const alias = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (alias) return tokenOf(alias[1], theme, depth + 1);
  if (!/^#[0-9a-fA-F]{3,8}$/.test(value)) {
    throw new Error(`token ${name} in ${theme} is not a colour this test can read: ${value}`);
  }
  return hex(value);
};

// The worst-case ground each surface actually sits on.
//   light .card is a #ffffff -> #fbfdfe gradient, so white is worst case
//   dark  --bg-surface rgba(17,26,36,.72) over --bg-deep #0b1118
const CARD = {
  light: hex("#ffffff"),
  dark: over(hex("#111a24"), 0.72, hex("#0b1118"))
};
const ROW = {
  light: hex("#ffffff"),
  dark: over(hex("#111a24"), 0.54, CARD.dark)
};

// =====================================================================
// 1. The state-gated surfaces, measured
// =====================================================================

describe("every state-gated popup surface clears WCAG in both themes", () => {
  // Each entry names the ground it really sits on, because that is what
  // the two previous passes got wrong: 8.20's delete glyph was measured
  // against a bare card when it actually sits on a schedule row, and
  // read 2.52:1 there.
  const CASES = [
    {
      name: '.guard-note-btn label (Report tab, "Show guards")',
      ink: (t) => tokenOf("--warning", t),
      ground: (t) => over(hex("#fbbf24"), 0.09, CARD[t]),
      need: 4.5
    },
    {
      name: ".guard-note-btn border",
      ink: (t) => tokenOf("--warning", t),
      ground: (t) => over(hex("#fbbf24"), 0.09, CARD[t]),
      need: 3
    },
    {
      name: ".guard-note icon",
      ink: (t) => tokenOf("--warning", t),
      ground: (t) => over(hex("#fbbf24"), 0.09, CARD[t]),
      need: 3
    },
    {
      name: '.run-banner-btn.armed ("Force reset", second press)',
      ink: (t) => tokenOf("--danger", t),
      ground: (t) => over(hex("#f43f5e"), 0.16, CARD[t]),
      need: 4.5
    },
    {
      name: '.run-banner-btn.primary ("Show")',
      ink: (t) => tokenOf("--primary", t),
      ground: (t) => over(hex("#22d3ee"), 0.14, CARD[t]),
      need: 4.5
    },
    {
      name: ".account-pill label (a second mailbox)",
      ink: (t) => tokenOf("--text-muted", t),
      ground: (t) => over(
        t === "light" ? hex("#0d1e28") : hex("#ffffff"),
        t === "light" ? 0.05 : 0.06,
        CARD[t]
      ),
      need: 4.5
    },
    {
      name: ".report-row-btn.is-blocked label (Safe Mode)",
      ink: (t) => tokenOf("--warning", t),
      ground: (t) => ROW[t],
      need: 4.5
    },
    {
      name: ".report-row-btn.is-blocked border",
      ink: (t) => tokenOf("--warning", t),
      ground: (t) => ROW[t],
      need: 3
    },
    {
      name: '.report-row.is-done meta (a cleared step)',
      ink: (t) => tokenOf("--text-dim", t),
      ground: (t) => ROW[t],
      need: 4.5
    },
    {
      name: '.report-row.is-done "Cleared" chip',
      ink: (t) => tokenOf("--ink-good", t),
      ground: (t) => ROW[t],
      need: 4.5
    }
  ];

  for (const theme of ["light", "dark"]) {
    for (const c of CASES) {
      test(`${theme}: ${c.name}`, () => {
        const ratio = contrast(c.ink(theme), c.ground(theme));
        // The number is in the message so a future regression reports how
        // far it fell, not just that it did.
        expect(`${c.name} ${theme} ${ratio.toFixed(2)}:1`).toBe(
          ratio >= c.need ? `${c.name} ${theme} ${ratio.toFixed(2)}:1` : `${c.name} ${theme} >= ${c.need}:1`
        );
      });
    }
  }
});

describe("the literals those surfaces used to carry are gone", () => {
  // A dark-only hex under themed text cannot be right on a white card,
  // and no [data-theme] rule can reach an inline style attribute. Both
  // shapes are pinned by absence, on the specific rules that carried
  // them, so a bulk find-and-replace elsewhere cannot satisfy this.
  test(".guard-note-btn drives its ink from a token", () => {
    const rule = between(POPUP_HTML, ".guard-note-btn {", "}");
    expect(rule).toContain("var(--warning)");
    expect(rule).not.toContain("#fde68a");
    expect(rule).not.toMatch(/rgba\(251,\s*191,\s*36/);
  });

  test(".run-banner-btn.armed drives its ink from a token", () => {
    const rule = between(POPUP_HTML, ".run-banner-btn.armed {", "}");
    expect(rule).toContain("var(--danger)");
    expect(rule).not.toContain("#fda4af");
  });

  test(".account-pill no longer paints a dark slab", () => {
    const rule = between(POPUP_HTML, ".account-pill {", "}");
    expect(rule).not.toMatch(/rgba\(17,\s*26,\s*36/);
    expect(rule).toContain("var(--wash)");
  });

  test("neither report-row state expresses itself as whole-element opacity", () => {
    // Both controls stay enabled and both rows still carry figures the
    // user reads, so dimming them is dimming information.
    expect(POPUP_HTML).not.toContain(".report-row-btn.is-blocked { opacity: 0.6; }");
    expect(POPUP_HTML).not.toContain(".report-row.is-done { opacity: 0.6; }");
  });

  test("the schedule list is styled by class, not by a style attribute", () => {
    const render = between(OPTIONS_SRC, "schedules.forEach((schedule) => {", "container.appendChild(row);");
    expect(render).toContain('row.className = "schedule-row"');
    expect(render).toContain('toggle.className = "schedule-row-toggle"');
    expect(render).toContain('deleteBtn.className = "schedule-row-delete"');
    // The literals that could not be themed.
    expect(render).not.toContain("rgba(15,23,42,0.4)");
    expect(render).not.toContain("#10b981");
    expect(render).not.toContain("#64748b");
    // And the class has a light override, like its sibling list.
    expect(OPTIONS_HTML).toContain('[data-theme="light"] .schedule-row {');
  });

  test("the schedule toggle's colour follows its announced state", () => {
    // Styling on a class the JS sets separately is how a control ends up
    // looking enabled and announcing disabled.
    expect(OPTIONS_HTML).toContain('.schedule-row-toggle[aria-pressed="true"]');
  });
});

describe("the contrast reader itself", () => {
  // A measuring tool that reads the wrong value reports a bug that is
  // not there and misses one that is. Half the semantic inks are var()
  // aliases in dark and literals in light, and the first version of
  // tokenOf silently returned the LIGHT hex for a dark alias.
  test("resolves an alias token to the value the browser would use", () => {
    expect(tokenOf("--ink-good", "dark")).toEqual(hex("#34d399"));
    expect(tokenOf("--ink-good", "light")).toEqual(hex("#047857"));
    expect(tokenOf("--warning", "dark")).toEqual(hex("#fbbf24"));
    expect(tokenOf("--warning", "light")).toEqual(hex("#b45309"));
  });

  test("and refuses a token it cannot read rather than guessing", () => {
    expect(() => tokenOf("--not-a-real-token", "light")).toThrow(/not found/);
  });

  test("known reference ratios, so a drifting formula is caught here", () => {
    expect(contrast(hex("#000000"), hex("#ffffff"))).toBeCloseTo(21, 1);
    expect(contrast(hex("#ffffff"), hex("#ffffff"))).toBeCloseTo(1, 5);
  });

  test("stripComments removes the warning, not the rule", () => {
    const css = `/* never use #fde68a here */\n.x { color: var(--warning); }`;
    expect(stripComments(css)).not.toContain("#fde68a");
    expect(stripComments(css)).toContain("var(--warning)");
  });
});

// =====================================================================
// 2. Escape in a search box is not "abort the run"
// =====================================================================

describe("the progress page's keyboard shortcuts", () => {
  // 8.20 fixed this exact shape one branch down, for Enter. Escape in a
  // text field means "clear this field" to every user of every search
  // box, and this page has one labelled "Filter logs...". Typing a rule
  // name to watch it and pressing Escape aborted a live sweep, with no
  // confirmation and no way to resume.
  const handler = between(PROGRESS_SRC, "const setupKeyboardShortcuts", "if ((e.ctrlKey || e.metaKey)");

  test("Escape only reaches cancel from neutral focus", () => {
    const guard = handler.indexOf('e.target?.closest?.(');
    const cancel = handler.indexOf("handleCancel();");
    expect(guard).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(guard);
    expect(handler).toContain("!inField && !state.done");
  });

  test("the guard names the fields a user types into", () => {
    const sel = between(handler, "const inField = e.target?.closest?.(", ");");
    for (const s of ["input", "textarea", "select", 'contenteditable="true"']) {
      expect(sel).toContain(s);
    }
  });

  test("but Escape still dismisses either dialog from anywhere inside it", () => {
    // Those branches return before the guard, because inside a dialog
    // Escape really does mean dismiss.
    const guardModal = handler.indexOf("ui.guardModal?.open");
    const reviewModal = handler.indexOf("ui.reviewModal?.open");
    const guard = handler.indexOf("const inField");
    expect(guardModal).toBeGreaterThan(-1);
    expect(reviewModal).toBeGreaterThan(-1);
    expect(guardModal).toBeLessThan(guard);
    expect(reviewModal).toBeLessThan(guard);
  });
});

// =====================================================================
// 3. An intro plays once
// =====================================================================

describe("the stats page stops replaying its intro on every poll", () => {
  // loadStats is BOTH the first paint and the 30s poll callback, and
  // GCC.pollingInterval fires it again on every visibilitychange. So
  // every bar collapsed to 0% and grew back and every headline total
  // rolled up from zero, roughly twice a minute, displaying figures that
  // were never true for about 600ms each time.
  test("growBar writes the real size first and only animates on the intro", () => {
    const fn = between(STATS_SRC, "const growBar =", "const ui = {");
    const write = fn.indexOf("el.style[dimension] = finalValue;");
    const gate = fn.indexOf("if (!animateIntro()) return;");
    const zero = fn.indexOf('el.style[dimension] = "0%";');
    expect(write).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(write);
    expect(zero).toBeGreaterThan(gate);
  });

  test("the totals roll once and land thereafter", () => {
    const fn = between(STATS_SRC, "const setTotal =", "const growBar =");
    expect(fn).toContain("if (animateIntro()) GCC.countUp(el, value, text);");
    expect(fn).toContain("else el.textContent = text;");
    // And loadStats goes through it rather than calling countUp itself.
    const load = between(STATS_SRC, "async function loadStats()", "async function renderProPitch");
    expect(load).not.toContain("GCC.countUp(");
    expect(load).toContain("setTotal(ui.totalDeleted");
  });

  test("animateIntro is the flag, not a constant", () => {
    // Mutation-checked: `const animateIntro = () => true` restores the
    // bug and left every other assertion in this block green, because
    // they all pin the CALL SITE. The property is what the function
    // answers, so that is what is pinned.
    expect(STATS_SRC).toContain("let introPlayed = false;");
    expect(STATS_SRC).toContain("const animateIntro = () => !introPlayed;");
    // Set exactly once, so a second assignment cannot creep in earlier.
    expect(STATS_SRC.split("introPlayed = true;").length - 1).toBe(1);
  });

  test("the flag is set only after a render that had real stats", () => {
    // An early return on a failed or empty read is not the intro, and
    // the first real paint should still get one.
    const load = between(STATS_SRC, "async function loadStats()", "async function renderProPitch");
    const bail = load.indexOf("if (!stats || resp?.error)");
    const set = load.indexOf("introPlayed = true;");
    expect(bail).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(bail);
    expect(load.slice(bail, set)).toContain("return;");
  });
});

// =====================================================================
// 4. Numbers next to money
// =====================================================================

describe("the Storage X-ray caveat is shown to the people it is for", () => {
  // renderXrayAgeNote was gated on the licence, so the one sentence that
  // reconciles "at least 4.2 GB reclaimable" with a purge that only takes
  // mail older than six months appeared AFTER the user had paid. The
  // total, the per-sender rows, the number-led upsell and the Purge
  // button are all rendered to a free user.
  const fn = between(POPUP_SRC, "const renderXrayAgeNote = () => {", "const renderXrayList");

  test("the note does not require a licence", () => {
    expect(fn).toContain("const show = Boolean(age) && state.xray.senders.length > 0;");
    expect(fn).not.toContain("state.subs.licenseActive");
  });

  test("and it is not inside the Pro-only age row it explains", () => {
    // #xrayAgeRow is hidden for a free user; the note is its sibling, so
    // hiding the control does not hide the sentence about the control.
    const row = POPUP_HTML.indexOf('id="xrayAgeRow"');
    const note = POPUP_HTML.indexOf('id="xrayAgeNote"');
    expect(row).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(row);
    const rowClose = POPUP_HTML.indexOf("</div>", row);
    expect(note).toBeGreaterThan(rowClose);
  });
});

describe("the Auto-Pilot upsell counts what Auto-Pilot can take", () => {
  // The locked row led with every recommended sender. The sweep only ever
  // runs deleteOld and archiveAll, capped per run, so nine suggestions
  // could mean a first sweep of two. The post-purchase line has told the
  // truth since 8.10.
  test("all three call sites read the sweepable count", () => {
    expect(POPUP_SRC).not.toContain("autoPilotUpsellLine(state.smart.visibleCount)");
    expect(POPUP_SRC.split("autoPilotUpsellLine(state.smart.sweepableCount)").length - 1).toBe(3);
  });

  test("the count is filtered and capped where the list is built", () => {
    const fn = between(POPUP_SRC, "const renderSmartList = () => {", "state.smart.heldBackSenders");
    expect(fn).toContain("GCC.smart.sweepableCount(");
    expect(fn).toContain("GCC.proSettings.effective(null, false).autoPilotMaxSenders");
    // visibleCount stays, because "how many suggestions are there" is a
    // different and still-correct question.
    expect(fn).toContain("state.smart.visibleCount = eligible.length;");
  });
});

describe("the rating button opens one store, and the right one", () => {
  // The anchor kept a hardcoded Chrome Web Store href while popup.js
  // added a handler that opens the correct store, and nothing called
  // preventDefault -- so a Firefox user got AMO in one tab and the
  // Chrome Web Store in another. A synthetic .click() from the star row
  // performs the default navigation too.
  test("it is a button, so there is no default navigation to suppress", () => {
    // Read backwards from the id to the tag that opens it, so the pin is
    // about the ELEMENT rather than about how the editor wrapped its
    // attributes. Line-wrapping is not a property worth failing on.
    const clean = stripComments(POPUP_HTML);
    const at = clean.indexOf('id="ratingBtn"');
    expect(at).toBeGreaterThan(-1);
    const opensAt = clean.lastIndexOf("<", at);
    const tag = clean.slice(opensAt, clean.indexOf(">", at) + 1);
    expect(tag.startsWith("<button")).toBe(true);
    expect(tag).toContain('type="button"');
    expect(tag).not.toContain("href");
    expect(tag).not.toContain("target=");
  });

  test("no shipped page hardcodes a store URL any more", () => {
    for (const f of ["popup.html", "options.html", "progress.html", "stats.html", "diagnostics.html", "changelog.html"]) {
      const src = stripComments(read(f));
      expect(src).not.toContain("chromewebstore.google.com");
      expect(src).not.toContain("addons.mozilla.org");
    }
  });

  test("the store is resolved in exactly one place", () => {
    expect(POPUP_SRC).toContain("GCC.storeLinks().reviews");
  });
});

describe("the popup's CSP names no third-party host", () => {
  // The whole product rests on making no network requests, and font-src
  // allowlisted a Google CDN that nothing has ever loaded from: no
  // @font-face anywhere, both type stacks are system fonts, and the five
  // sibling pages carry no font-src at all. It sat in the one place a
  // store reviewer greps first.
  test("font-src is self only", () => {
    const csp = between(POPUP_HTML, 'http-equiv="Content-Security-Policy"', "/>");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain("gstatic");
  });

  test("and no shipped file references a remote font at all", () => {
    for (const f of ["popup.html", "options.html", "progress.html", "stats.html",
      "diagnostics.html", "changelog.html", "shared.css"]) {
      const src = stripComments(read(f));
      expect(src).not.toContain("fonts.gstatic.com");
      expect(src).not.toContain("fonts.googleapis.com");
      expect(src).not.toContain("@font-face");
    }
  });
});

describe("a preference that fails to save says so", () => {
  // GCC.storageSet does not swallow a rejection, so the bare await threw
  // straight out of the handler: no toast, nothing stored, and the
  // checkbox kept its new look. The user came away believing unattended
  // runs would notify them.
  const fn = between(OPTIONS_SRC, "async function wireNotificationsToggle()", "async function ");

  test("the write is guarded and the control is put back", () => {
    expect(fn).toContain("try {");
    expect(fn).toContain("el.checked = !wanted;");
    expect(fn).toContain("Could not save that preference");
  });

  test("and the success toast is only reached when the write landed", () => {
    const restore = fn.indexOf("el.checked = !wanted;");
    const success = fn.indexOf('GCC.showToast(wanted ? "Notifications on"');
    expect(restore).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(restore);
    expect(fn.slice(restore, success)).toContain("return;");
  });
});
