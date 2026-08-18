/**
 * @jest-environment jsdom
 *
 * 8.18: the UI/UX/motion overhaul.
 *
 * Three kinds of thing are pinned here.
 *
 * FIRST, the contrast failures. Two controls were unreadable and both of
 * them were controls you reach for when something has gone wrong: the skip
 * link, which exists only for keyboard and screen-reader users and rendered
 * white on #22d3ee at 1.81:1, and the Cancel button on the progress page,
 * whose gradient started at --danger (#f87171) so the left half of the one
 * button that STOPS a destructive run measured 2.77:1 against its own label.
 * Both are pinned by the ratio, computed here, not by the hex, so a later
 * palette change has to stay readable rather than merely stay the same.
 *
 * SECOND, the token shape. Durations and easings must stay SEPARATE custom
 * properties. The popup used to ship "--t-fast: 140ms var(--ease)", which is
 * fine until a rule composes its own easing: "var(--t-fast) var(--ease)"
 * expands to two timing functions, which is invalid, and the browser drops
 * the entire transition silently. shared.css writes exactly that shape, so
 * any shared component rendered inside the popup lost its motion and nothing
 * anywhere reported it.
 *
 * THIRD, and this is the one worth being careful about: an animated number
 * must never be able to strand a wrong value. This project's recurring bug
 * is a number shown beside an action disagreeing with what the action does
 * (tests/scan-purge-parity.test.js is the pin for the general shape), and a
 * count that rolls is that bug with a timer attached if the final write can
 * be missed. countUp therefore writes the final text BEFORE it starts, and
 * every early return sits after that write. The tests below prove it for the
 * paths that actually occur: reduced motion, no requestAnimationFrame, a
 * second call landing mid-roll, and the ordinary animated case.
 */

const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf-8");

// THE COMMENT TRAP, and this file walked into it twice while being written.
// The comments that EXPLAIN the bundled-token trap necessarily quote the bad
// declaration, so a regex hunting for that declaration finds the warning
// about it and reports the fix as the bug. Strip comments before matching
// anything that looks like source. (Same lesson as 8.16 and 8.17: assume any
// pattern matching an identifier will be broken by the next comment that
// explains it.)
const stripComments = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
const code = (f) => stripComments(read(f));

// ---------------------------------------------------------------------
// Contrast maths (WCAG 2.x relative luminance)
// ---------------------------------------------------------------------

const toRgb = (hex) => {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = (rgb) =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
const contrast = (a, b) => {
  const la = luminance(toRgb(a));
  const lb = luminance(toRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// Pull a custom property's value out of a :root-ish block by name. Takes the
// FIRST definition, which is the dark default in every file here.
const tokenValue = (css, name) => {
  const m = new RegExp("--" + name + ":\\s*([^;]+);").exec(css);
  return m ? m[1].trim() : null;
};

describe("8.18 contrast: the controls you reach for when something is wrong", () => {
  test("the contrast helper agrees with known WCAG pairs", () => {
    // Guard the guard: if this maths is wrong every assertion below is
    // decorative. Black on white is exactly 21, and white on white is 1.
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // The value this whole file exists because of.
    expect(contrast("#ffffff", "#22d3ee")).toBeLessThan(2);
  });

  test("progress.html skip link does not put literal white on --primary", () => {
    const css = code("progress.html");
    const block = /\.skip-link\s*\{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    // The regression, precisely: a `color: white` sitting in the same rule
    // as `background: var(--primary)`.
    expect(block[1]).toMatch(/background:\s*var\(--primary\)/);
    expect(block[1]).not.toMatch(/color:\s*white\b/);
    expect(block[1]).toMatch(/color:\s*var\(--on-primary\)/);
  });

  test("--on-primary clears 4.5:1 on --primary in BOTH themes", () => {
    const shared = code("shared.css");
    // First definition = dark default; the light block restates both.
    const darkPrimary = tokenValue(shared, "primary");
    const darkOn = tokenValue(shared, "on-primary");
    expect(contrast(darkOn, darkPrimary)).toBeGreaterThanOrEqual(4.5);

    const lightBlock = shared.slice(shared.indexOf('[data-theme="light"]'));
    const lightPrimary = tokenValue(lightBlock, "primary");
    const lightOn = tokenValue(lightBlock, "on-primary");
    expect(contrast(lightOn, lightPrimary)).toBeGreaterThanOrEqual(4.5);
  });

  test("the progress Cancel button is readable across its whole gradient", () => {
    const css = code("progress.html");
    const block = /#cancelBtn\s*\{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    const gradient = /background:\s*linear-gradient\(([^;]*)\)/.exec(block[1]);
    expect(gradient).not.toBeNull();

    // Resolve every colour stop the gradient names, then require the label
    // to clear 4.5:1 against ALL of them. Testing only one end is how the
    // original bug survived: the dark end passed at 4.83.
    const local = css;
    const stops = [];
    for (const m of gradient[1].matchAll(/var\(--([a-z-]+)\)|#[0-9a-fA-F]{3,6}/g)) {
      stops.push(m[1] ? tokenValue(local, m[1]) || tokenValue(code("shared.css"), m[1]) : m[0]);
    }
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const stop of stops) {
      expect(stop).toBeTruthy();
      expect(contrast("#ffffff", stop)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("--ink-good is readable as TEXT on a white card, which --success is not", () => {
    const shared = code("shared.css");
    const light = shared.slice(shared.indexOf('[data-theme="light"]'));
    const inkGood = tokenValue(light, "ink-good");
    expect(contrast(inkGood, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // The reason the token exists at all: --success is a FILL colour and
    // does not clear 4.5:1 as text on white. If a later edit makes them
    // equal, this fails and says why.
    const success = tokenValue(light, "success");
    expect(contrast(success, "#ffffff")).toBeLessThan(4.5);
  });
});

describe("8.18 motion tokens: a bundled duration is not a token", () => {
  test("shared.css duration tokens carry NO easing", () => {
    const css = code("shared.css");
    for (const name of ["t-1", "t-2", "t-3", "t-4", "t-5"]) {
      const v = tokenValue(css, name);
      expect(v).toMatch(/^\d+ms$/);
    }
    // The named aliases resolve to the scale, still without an easing.
    for (const name of ["t-fast", "t-normal", "t-slow"]) {
      const v = tokenValue(css, name);
      expect(v).toMatch(/^var\(--t-\d\)$/);
    }
  });

  test("no page redefines a duration token to include its easing", () => {
    // Structural, not a string match on one spelling: any duration token
    // whose value contains a timing function is the trap, however written.
    const files = ["popup.html", "options.html", "progress.html", "stats.html", "shared.css"];
    for (const f of files) {
      const css = code(f);
      for (const m of css.matchAll(/--(t|t-fast|t-normal|t-slow|t-[1-5]):\s*([^;]+);/g)) {
        expect(`${f} --${m[1]}: ${m[2]}`).not.toMatch(/cubic-bezier|\bease(-in|-out)?\b|\blinear\b|steps\(/);
      }
    }
  });

  test("the popup's transitions name an easing at the use site", () => {
    const css = code("popup.html");
    const decls = [...css.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1]);
    expect(decls.length).toBeGreaterThan(20);
    for (const d of decls) {
      // Every duration in a transition should be followed by an easing.
      // Bare `transition-duration:` overrides are handled elsewhere.
      if (/var\(--t[-0-9]*\)/.test(d)) {
        expect(d).toMatch(/var\(--ease[a-z-]*\)/);
      }
    }
  });

  test("no transition declaration names two timing functions", () => {
    // The exact failure the split prevents: two easings in one shorthand
    // makes the whole declaration invalid and it is dropped in silence.
    for (const f of ["popup.html", "options.html", "progress.html", "stats.html", "shared.css"]) {
      const css = code(f);
      for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
        for (const part of m[1].split(",")) {
          const easings = part.match(/cubic-bezier\([^)]*\)|\bease-in-out\b|\bease-in\b|\bease-out\b|\bease\b|\blinear\b/g) || [];
          expect(`${f}: ${part.trim()}`).toEqual(expect.anything());
          expect(easings.length).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("8.18 reduced motion", () => {
  test("the shared block zeroes animation-delay, so a stagger cannot flicker", () => {
    const css = code("shared.css");
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    expect(block).not.toBeNull();
    // Without this the per-row delays survive and the list appears one row
    // at a time in 0.01ms steps, which is a flicker rather than a reveal.
    expect(block[1]).toMatch(/animation-delay:\s*0ms\s*!important/);
  });

  test("spinners and the indeterminate band keep running", () => {
    const css = code("shared.css");
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    // Essential activity indicators are exempt: a spinner that stops
    // spinning reads as frozen, which is worse than the motion.
    expect(block[1]).toMatch(/\.spinner/);
    expect(block[1]).toMatch(/indeterminate/);
    expect(block[1]).toMatch(/animation-iteration-count:\s*infinite\s*!important/);
  });

  test("the popup's stagger is bounded, so a long list does not crawl", () => {
    const css = code("popup.html");
    // 12 steps at --stagger. If someone raises the cap the list stops
    // reading as "arriving" and starts reading as "slow".
    expect(css).toMatch(/nth-child\(n\+12\)/);
    const stagger = tokenValue(read("shared.css"), "stagger");
    const ms = parseInt(stagger, 10);
    expect(ms).toBeGreaterThan(0);
    expect(ms * 12).toBeLessThanOrEqual(400);
  });
});

describe("8.18 tab ink bar", () => {
  test("is guarded by @supports so an unsupporting engine keeps a visible selection", () => {
    const css = code("popup.html");
    const at = css.indexOf("@supports selector(:has(*))");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("\n    }", css.indexOf(".tab-bar:has(#tabStorage")));
    // The rule that removes the selected tab's own background MUST live
    // inside the guard. Outside it, an engine without :has() would paint
    // no selection at all.
    expect(block).toMatch(/\[role="tab"\]\[aria-selected="true"\][\s\S]*?background:\s*transparent/);
  });

  test("every tab has an ink position", () => {
    const css = code("popup.html");
    const ids = ["tabReport", "tabClean", "tabUnsubscribe", "tabStorage"];
    for (const id of ids) {
      expect(css).toMatch(new RegExp(`\\.tab-bar:has\\(#${id}\\[aria-selected="true"\\]\\)::after`));
    }
    // Four tabs, four quarter-width positions.
    expect(css).toMatch(/width:\s*calc\(\(100% - 8px\) \/ 4\)/);
  });
});

describe("8.18 no undefined custom properties", () => {
  test("every var() resolves to a token defined in shared.css or the page", () => {
    const shared = code("shared.css");
    const defs = (css) => new Set([...css.matchAll(/(?:^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
    const sharedDefs = defs(shared);
    const missing = [];
    for (const f of ["popup.html", "options.html", "progress.html", "stats.html", "changelog.html", "diagnostics.html"]) {
      const css = code(f);
      const local = defs(css);
      for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
        // A var() with a fallback degrades on purpose; only the bare ones
        // silently invalidate their whole declaration.
        if (m[2] === ",") continue;
        if (!sharedDefs.has(m[1]) && !local.has(m[1])) {
          missing.push(`${f}: ${m[1]}`);
        }
      }
    }
    // options.html shipped `border: 1px solid var(--border)` where --border
    // is defined nowhere, so that element computed to no border at all.
    expect(missing).toEqual([]);
  });
});

describe("8.18 countUp never strands a wrong value", () => {
  let GCC;
  // Same shape tests/shared.test.js uses: evaluate the IIFE directly with
  // stubs, rather than loading the file for its side effects.
  const loadShared = () => {
    const src = read("shared.js");
    const iife = src.match(/const GCC = ([\s\S]*);[\s]*$/);
    // eslint-disable-next-line no-new-func
    return new Function("document", "window", "chrome", `return ${iife[1]}`)(
      document,
      window,
      { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
    );
  };

  beforeEach(() => {
    GCC = loadShared();
  });

  const el = () => document.createElement("span");

  test("writes the final text synchronously, before any frame runs", () => {
    // The load-bearing assertion of the whole feature. No frame has been
    // allowed to run at the point this is read.
    const node = el();
    GCC.countUp(node, 18432, (18432).toLocaleString());
    expect(node.textContent).toBe((18432).toLocaleString());
  });

  test("still lands the final text when reduced motion is on", () => {
    global.matchMedia = () => ({ matches: true });
    const node = el();
    GCC.countUp(node, 500, "500");
    expect(node.textContent).toBe("500");
    delete global.matchMedia;
  });

  test("still lands the final text with no requestAnimationFrame at all", () => {
    global.matchMedia = () => ({ matches: false });
    const saved = global.requestAnimationFrame;
    delete global.requestAnimationFrame;
    const node = el();
    GCC.countUp(node, 900, "900");
    expect(node.textContent).toBe("900");
    global.requestAnimationFrame = saved;
    delete global.matchMedia;
  });

  test("prefersReducedMotion answers TRUE when matchMedia is missing", () => {
    const saved = global.matchMedia;
    delete global.matchMedia;
    // The safe default for "should I animate" is no.
    expect(GCC.prefersReducedMotion()).toBe(true);
    if (saved) global.matchMedia = saved;
  });

  test("an animated roll ends on the caller's exact string, not a re-format", () => {
    global.matchMedia = () => ({ matches: false });
    const frames = [];
    let performance_now = 0;
    // Pass the timestamp, the way a real rAF does.
    global.requestAnimationFrame = (fn) => { frames.push(() => fn(performance_now)); return frames.length; };

    const node = el();
    // A string the formatter would NOT produce, to prove it is used verbatim.
    GCC.countUp(node, 1234, "1,234 emails");
    expect(node.textContent).toBe("1,234 emails");

    // Drive it to a mid-point: an intermediate value appears...
    performance_now = 300;
    frames.shift()();
    expect(node.textContent).not.toBe("1,234 emails");

    // ...and past the duration it lands on the caller's string exactly.
    performance_now = 10000;
    frames.shift()();
    expect(node.textContent).toBe("1,234 emails");

    delete global.matchMedia;
  });

  test("a frame callback given no timestamp still lands the final value", async () => {
    // Not hypothetical enough to skip: without the guard in step(), an
    // absent timestamp makes t NaN, the t >= 1 exit never fires, and the
    // element is stranded reading "0" while the true value was 4,096.
    //
    // jsdom will not let performance be replaced (assigning to it is a
    // silent no-op), so the clock here is the REAL one and the duration
    // is shrunk to 1ms and genuinely waited out instead.
    global.matchMedia = () => ({ matches: false });
    const frames = [];
    global.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };

    const node = el();
    GCC.countUp(node, 4096, "4,096", { duration: 1 });
    await new Promise((r) => setTimeout(r, 12));
    // Called with no argument at all, exactly like the failing case.
    frames.shift()();
    expect(node.textContent).toBe("4,096");
    delete global.matchMedia;
  });

  test("a second call wins, so a stale roll cannot overwrite a newer value", () => {
    global.matchMedia = () => ({ matches: false });
    const frames = [];
    global.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };

    const node = el();
    GCC.countUp(node, 100, "100");
    const staleFrame = frames.shift();

    // A rescan lands while the first roll is still going.
    GCC.countUp(node, 7, "7");
    expect(node.textContent).toBe("7");

    // The abandoned roll must not resurrect the old number.
    staleFrame();
    expect(node.textContent).toBe("7");

    delete global.matchMedia;
  });

  test("a zero or non-finite target is written and left alone", () => {
    global.matchMedia = () => ({ matches: false });
    const node = el();
    GCC.countUp(node, 0, "0");
    expect(node.textContent).toBe("0");
    GCC.countUp(node, Number.NaN, "not a number");
    expect(node.textContent).toBe("not a number");
    delete global.matchMedia;
  });

  test("a missing element is a no-op rather than a throw", () => {
    expect(() => GCC.countUp(null, 5, "5")).not.toThrow();
  });
});

describe("8.18 the stats chart animation actually runs", () => {
  // This pin MOVED (it used to read the inline rAF dance inside
  // renderDailyChart) because the three copies of that dance became one
  // growBar helper. The intent is unchanged and is now checked once for
  // all three bars rather than once for the chart and not at all for the
  // two category lists.
  test("growBar writes the REAL size before it writes the animation's start", () => {
    const js = code("stats.js");
    const fn = js.slice(js.indexOf("const growBar ="), js.indexOf("// DOM Refs"));
    expect(fn.length).toBeGreaterThan(120);

    // The original bug: the size was set before the element was in the
    // document, so there was no previous value and the transition never
    // ran. The fix must not trade that for an empty chart when rAF is
    // missing, so the true size is written FIRST and unconditionally.
    const realWrite = fn.indexOf("el.style[dimension] = finalValue");
    const zeroWrite = fn.indexOf('el.style[dimension] = "0%"');
    expect(realWrite).toBeGreaterThan(-1);
    expect(zeroWrite).toBeGreaterThan(realWrite);

    // Both bail-outs sit AFTER the real write, never before it.
    expect(fn.indexOf('typeof requestAnimationFrame !== "function"')).toBeGreaterThan(realWrite);
    expect(fn.indexOf("prefersReducedMotion()")).toBeGreaterThan(realWrite);
  });

  test("all three animated bars go through the helper", () => {
    const js = code("stats.js");
    // The chart bars plus both category-bar-fill lists. If a fourth bar
    // appears and sets its own size inline, it silently gets the dead
    // transition back.
    // Three CALL sites; the definition reads "const growBar =" and does
    // not match this pattern.
    expect((js.match(/growBar\(/g) || []).length).toBe(3);
    expect(js).not.toMatch(/fill\.style\.width = pct/);
    expect(js).not.toMatch(/bar\.style\.height = pct/);
  });

  test("the freed-storage figure lands rather than rolling", () => {
    const js = code("stats.js");
    // Counting through "0.1 MB ... 0.9 MB" on the way to a GB total would
    // be showing figures that were never true.
    expect(js).toMatch(/ui\.totalFreed\.textContent = GCC\.formatMb/);
    expect(js).not.toMatch(/countUp\(ui\.totalFreed/);
  });
});

describe("8.18 popup IA", () => {
  test("the preset stack is drawn as one group", () => {
    const css = code("popup.html");
    const block = /\.preset-stack\s*\{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    // It always MEANT "pick what to clean" and drew nothing, so six of the
    // thirteen controls visible on a fresh Clean tab read as unrelated.
    expect(block[1]).toMatch(/border:/);
    expect(block[1]).toMatch(/border-radius:/);
  });

  test("both assurance lines are still visible and still linked", () => {
    const html = code("popup.html");
    // 8.7 moved these out from behind a chevron deliberately. The 8.18
    // grouping is visual only: neither line may acquire [hidden] and the
    // privacy link must survive.
    const safety = /<p class="run-assurance">([\s\S]*?)<\/p>/.exec(html);
    const privacy = /<p class="run-assurance run-assurance--privacy">([\s\S]*?)<\/p>/.exec(html);
    expect(safety).not.toBeNull();
    expect(privacy).not.toBeNull();
    // Structural, not \bhidden\b: every icon in here carries
    // aria-hidden="true", and a word-boundary match reads that as the
    // paragraph being hidden. Match the ATTRIBUTE, which must be preceded
    // by whitespace and followed by a delimiter.
    const hasHiddenAttr = (s) => /\shidden(\s|>|=)/.test(s);
    expect(hasHiddenAttr(safety[0])).toBe(false);
    expect(hasHiddenAttr(privacy[0])).toBe(false);
    // Prove the matcher can actually catch a hidden paragraph, or the two
    // assertions above pass against anything.
    expect(hasHiddenAttr('<p class="run-assurance" hidden>')).toBe(true);
    expect(hasHiddenAttr('<svg aria-hidden="true">')).toBe(false);
    expect(privacy[1]).toMatch(/id="privacyPolicyLink"/);
    expect(safety[1]).toMatch(/data-i18n="runAssuranceSafety"/);
    expect(privacy[1]).toMatch(/data-i18n="runAssurancePrivacy"/);
  });
});
