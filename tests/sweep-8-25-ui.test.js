/**
 * @jest-environment jsdom
 *
 * 8.25, above the engine.
 *
 * Two figures the product stated flatly when the measurement behind them
 * was a floor, and the ink that has to be legible on the ground it is
 * actually painted on.
 *
 *   - Dry Run printed the visible page as the match total. The LIVE path
 *     has treated that case as over-cap since 8.12; the preview on the
 *     same page said "would affect 50" for a rule holding twelve
 *     thousand.
 *   - The report's plus sign was explained in a `title`, which is a
 *     hover: not on a phone, not on a keyboard.
 *   - --text-dim cleared 4.5:1 on --bg-surface and not on the raised
 *     washes the controls wearing it paint under themselves.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await flush(); };

// ------------------------------------------------------------- the popup

describe("the popup states a preview's floor", () => {
  let onMessage;

  const bootPopup = async (report) => {
    const localStore = { onboardedAt: Date.now(), pinHintDismissed: true, runSuccessCount: 2 };
    const syncStore = {};
    const area = (store) => ({
      get: (keys, cb) => {
        const out = {};
        const list = keys === null || keys === undefined
          ? Object.keys(store)
          : (Array.isArray(keys) ? keys : [keys]);
        for (const k of list) if (k in store) out[k] = store[k];
        cb(out);
      },
      set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
      remove: (keys, cb) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
        if (cb) cb();
      }
    });
    global.chrome = {
      runtime: {
        id: "test", lastError: null,
        getURL: (p) => `chrome-extension://test/${p}`,
        getManifest: () => ({ version: "8.25.0", permissions: [], host_permissions: [] }),
        onMessage: { addListener: (cb) => { onMessage = cb; } },
        sendMessage: (msg, cb) => {
          const reply = msg?.type === "gmailCleanerGetReport" ? { ok: true, report } : { ok: true };
          if (typeof cb === "function") cb(reply);
        }
      },
      storage: { local: area(localStore), sync: area(syncStore) },
      tabs: {
        query: (q, cb) => {
          const pattern = String(q?.url || "");
          if (pattern && !pattern.startsWith("https://mail.google.com")) return cb([]);
          cb([{ id: 7, url: "https://mail.google.com/mail/u/0/#inbox", status: "complete", active: true }]);
        },
        get: (id, cb) => cb({ id, url: "https://mail.google.com/mail/u/0/#inbox", status: "complete" }),
        create: (o, cb) => { if (cb) cb({ id: 101 }); },
        update: (id, o, cb) => { if (cb) cb({ id }); },
        reload: (id, cb) => { if (cb) cb(); }
      },
      permissions: { contains: (p, cb) => cb(true), request: (p, cb) => cb(true) },
      action: { getUserSettings: (cb) => cb({ isOnToolbar: true }) },
      management: { getSelf: (cb) => cb({ installType: "normal" }) },
      scripting: { executeScript: (opts, cb) => { if (cb) cb([]); } },
      i18n: { getMessage: () => "" }
    };

    const shared = read("shared.js")
      .replace("const license = Object.freeze({", "const license = ({")
      .replace("const gmailAccess = Object.freeze({", "const gmailAccess = ({");
    expect(shared).toContain("const license = ({");
    const glue = `
      ;GCC.license.getState = async () => ({ active: false, key: "" });
      GCC.gmailAccess.check = async () => true;
      GCC.gmailAccess.request = async () => true;
    `;
    const html = read("popup.html");
    const inner = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
    document.documentElement.innerHTML = (inner ? inner[1] : html)
      .replace(/<script[^>]*><\/script>/g, "");
    window.close = () => {};
    // eslint-disable-next-line no-new-func
    new Function(shared + glue + read("popup.js"))();
    document.dispatchEvent(new window.Event("DOMContentLoaded"));
    await settle(30);
  };

  const finishRun = async (stats) => {
    onMessage({
      type: "gmailCleanerProgress",
      phase: "done",
      done: true,
      percent: 100,
      status: "Cleanup finished.",
      stats
    }, { id: "test" }, () => {});
    await settle(12);
  };

  const dryStats = (over = {}) => ({
    mode: "dry",
    action: "delete",
    runCount: 150,
    totalWouldDelete: 150,
    totalDeleted: 0,
    totalFreedMb: 0,
    totalQueries: 6,
    stoppedShort: 0,
    ...over
  });

  test("a floored preview says 'Matched at least'", async () => {
    await bootPopup(null);
    await finishRun(dryStats({ wouldDeleteFloors: 2 }));
    expect(document.getElementById("resultLead").textContent).toBe("Matched at least");
    expect(document.getElementById("resultCount").textContent).toBe("150");
  });

  test("a preview Gmail totalled everywhere keeps the plain word", async () => {
    await bootPopup(null);
    await finishRun(dryStats({ wouldDeleteFloors: 0 }));
    expect(document.getElementById("resultLead").textContent).toBe("Matched");
  });

  test("a run from a build with no such field is not qualified", async () => {
    // Absent means exact, the same default the band flag takes: an older
    // engine's preview showed a flat figure and that is what it measured.
    await bootPopup(null);
    await finishRun(dryStats());
    expect(document.getElementById("resultLead").textContent).toBe("Matched");
  });

  test("a LIVE run is never qualified, whatever the field says", async () => {
    // wouldDeleteFloors is about a preview. A live run's count is mail
    // that actually moved, and that is not an estimate of anything.
    await bootPopup(null);
    await finishRun(dryStats({ mode: "live", runCount: 150, totalDeleted: 150, wouldDeleteFloors: 3 }));
    expect(document.getElementById("resultLead").textContent).toBe("Cleaned");
  });

  test("the safety note explains where the higher number went", async () => {
    await bootPopup(null);
    await finishRun(dryStats({ wouldDeleteFloors: 1 }));
    const note = document.getElementById("resultSafetyNote").textContent;
    expect(note).toContain("did not report a total");
    expect(note).toContain("No mail was moved");
  });
});

describe("the report explains its plus sign in words", () => {
  let onMessage;

  const REPORT = (over = {}) => ({
    updatedAt: 1750000000000,
    cleanableCount: 50,
    cleanableAtLeast: false,
    largeMb: 100,
    topSenders: [],
    guardedOutCount: 0,
    bands: [
      { id: "sizeHuge", kind: "size", action: "delete", count: 4, estMb: 100, measured: true, atLeast: false, cleanedAt: 0 },
      { id: "social", kind: "noise", action: "delete", count: 3000, estMb: 0, measured: true, atLeast: false, cleanedAt: 0 }
    ],
    ...over
  });

  const bootPopup = async (report) => {
    const localStore = { onboardedAt: Date.now(), pinHintDismissed: true, runSuccessCount: 2 };
    const syncStore = {};
    const area = (store) => ({
      get: (keys, cb) => {
        const out = {};
        const list = keys === null || keys === undefined
          ? Object.keys(store)
          : (Array.isArray(keys) ? keys : [keys]);
        for (const k of list) if (k in store) out[k] = store[k];
        cb(out);
      },
      set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
      remove: (keys, cb) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
        if (cb) cb();
      }
    });
    global.chrome = {
      runtime: {
        id: "test", lastError: null,
        getURL: (p) => `chrome-extension://test/${p}`,
        getManifest: () => ({ version: "8.25.0", permissions: [], host_permissions: [] }),
        onMessage: { addListener: (cb) => { onMessage = cb; } },
        sendMessage: (msg, cb) => {
          const reply = msg?.type === "gmailCleanerGetReport" ? { ok: true, report } : { ok: true };
          if (typeof cb === "function") cb(reply);
        }
      },
      storage: { local: area(localStore), sync: area(syncStore) },
      tabs: {
        query: (q, cb) => cb([]),
        get: (id, cb) => cb({ id, url: "https://mail.google.com/mail/u/0/#inbox" }),
        create: (o, cb) => { if (cb) cb({ id: 101 }); },
        update: (id, o, cb) => { if (cb) cb({ id }); },
        reload: (id, cb) => { if (cb) cb(); }
      },
      permissions: { contains: (p, cb) => cb(true), request: (p, cb) => cb(true) },
      action: { getUserSettings: (cb) => cb({ isOnToolbar: true }) },
      management: { getSelf: (cb) => cb({ installType: "normal" }) },
      scripting: { executeScript: (opts, cb) => { if (cb) cb([]); } },
      i18n: { getMessage: () => "" }
    };
    const shared = read("shared.js")
      .replace("const license = Object.freeze({", "const license = ({")
      .replace("const gmailAccess = Object.freeze({", "const gmailAccess = ({");
    const glue = `
      ;GCC.license.getState = async () => ({ active: false, key: "" });
      GCC.gmailAccess.check = async () => true;
      GCC.gmailAccess.request = async () => true;
    `;
    const html = read("popup.html");
    const inner = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
    document.documentElement.innerHTML = (inner ? inner[1] : html)
      .replace(/<script[^>]*><\/script>/g, "");
    window.close = () => {};
    // eslint-disable-next-line no-new-func
    new Function(shared + glue + read("popup.js"))();
    document.dispatchEvent(new window.Event("DOMContentLoaded"));
    await settle(30);
    void onMessage;
  };

  const note = () => document.getElementById("reportNote").textContent;

  test("a floored band gets the sentence", async () => {
    await bootPopup(REPORT({
      bands: [
        { id: "promotions", kind: "noise", action: "delete", count: 50, estMb: 0, measured: true, atLeast: true, cleanedAt: 0 }
      ]
    }));
    // The mark is on the row and its explanation was in a `title`, which
    // is a hover: not on a phone, not on a keyboard, not for anyone who
    // never thinks to try.
    expect(note()).toContain("plus sign");
    expect(note()).toContain("did not report a total");
  });

  test("a floored HEADLINE gets it too, even with every band exact", async () => {
    await bootPopup(REPORT({ cleanableAtLeast: true, cleanableCount: 50 }));
    expect(note()).toContain("plus sign");
  });

  test("a report Gmail totalled keeps the shorter note", async () => {
    await bootPopup(REPORT());
    expect(note()).not.toContain("plus sign");
    expect(note()).toContain("Storage figures are floors");
  });

  test("a held-back figure stored beside a floored headline is refused", async () => {
    // The engine stopped producing this number, but a report written by
    // 8.24 is still on disk with the old subtraction in it, sitting next
    // to the very flag that proves the subtraction was unsound.
    await bootPopup(REPORT({ cleanableAtLeast: true, guardedOutCount: 940 }));
    const text = document.getElementById("reportGuardNoteText").textContent;
    expect(text).not.toContain("940");
    expect(text).not.toContain("protected by your guards");
  });

  test("and a held-back figure beside an exact headline still shows", async () => {
    await bootPopup(REPORT({ cleanableAtLeast: false, guardedOutCount: 940 }));
    expect(document.getElementById("reportGuardNoteText").textContent)
      .toContain("940 more old emails are protected by your guards");
  });
});

// ------------------------------------------------------------ contrast

// Arithmetic, not a browser. A token test that needs a headless Chrome
// is a token test that runs once and then never again. Module scope
// because two describes below measure with it.
const hex = (h) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16)
});
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("--text-dim on the ground it is actually painted on", () => {

  // Composited in a browser and written down here so the numbers in the
  // token's comment can be checked without one.
  const GROUNDS = {
    // --bg-surface over --bg-deep: the plain card 8.19 measured against.
    card: { r: 15, g: 23, b: 33 },
    // ...plus a .linkish chip's own rgba(255,255,255,.04).
    linkishChip: { r: 25, g: 32, b: 41 },
    // ...plus a toggle row's rgba(255,255,255,.02).
    toggleRow: { r: 20, g: 28, b: 37 }
  };

  const token = () => {
    const css = read("shared.css");
    const dark = css.slice(0, css.indexOf('[data-theme="light"]'));
    const m = dark.match(/--text-dim:\s*(#[0-9a-fA-F]{6})/);
    expect(m).not.toBeNull();
    return hex(m[1]);
  };

  test.each(Object.keys(GROUNDS))("clears 4.5:1 on the %s", (where) => {
    expect(ratio(token(), GROUNDS[where])).toBeGreaterThanOrEqual(4.5);
  });

  test("and the value it replaced did not, which is why this test exists", () => {
    // Pinned so the regression is described rather than implied: 8.19's
    // #6e8494 clears the card and misses both raised grounds, and a
    // future edit back toward it fails on the ground it was chosen for.
    expect(ratio(hex("#6e8494"), GROUNDS.card)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex("#6e8494"), GROUNDS.linkishChip)).toBeLessThan(4.5);
    expect(ratio(hex("#6e8494"), GROUNDS.toggleRow)).toBeLessThan(4.5);
  });

  test("the light twin still clears its own white card", () => {
    const css = read("shared.css");
    const light = css.slice(css.indexOf('[data-theme="light"]'));
    const m = light.match(/--text-dim:\s*(#[0-9a-fA-F]{6})/);
    expect(m).not.toBeNull();
    expect(ratio(hex(m[1]), { r: 255, g: 255, b: 255 })).toBeGreaterThanOrEqual(4.5);
  });
});

describe("ink inside a filled button comes from the button", () => {
  // 8.19's chip lesson, one control over: an element that paints its own
  // fill moves the ground its label has to clear, and a page-ground
  // style dropped inside a brand-filled button is that with the ground
  // changed out from under it.
  test("the Save button's hint wears --on-primary, not a page slate", () => {
    const css = read("options.html");
    const rule = css.slice(css.indexOf("#save .shortcut-hint {"), css.indexOf("#save kbd {"));
    expect(rule).toContain("var(--on-primary)");
    expect(rule).not.toContain("#64748b");
  });

  test("the caps inside it drop their own fill", () => {
    for (const [file, sel] of [["options.html", "#save kbd {"], ["popup.html", ".primary kbd,"]]) {
      const css = read(file);
      const at = css.indexOf(sel);
      expect(`${file}: ${at > -1}`).toBe(`${file}: true`);
      const rule = css.slice(at, css.indexOf("}", at));
      expect(`${file}: ${rule.includes("background: transparent")}`).toBe(`${file}: true`);
      expect(`${file}: ${rule.includes("color: inherit")}`).toBe(`${file}: true`);
    }
  });

  test("white text in light theme is never dropped on --primary-strong", () => {
    // --primary-strong is #0891b2 in light and white on it is 3.68:1.
    // The fill is one token per theme rather than a per-page override,
    // because an override specific enough to beat `button, .button-link`
    // also beats `.theme-switcher button` and fills the theme pills with
    // brand. Measured live before this was written: the pills went from
    // readable to 1.09:1.
    const css = read("shared.css");
    const light = css.slice(css.indexOf('[data-theme="light"]'));
    expect(light).toContain("--brand-fill: linear-gradient(135deg, var(--primary), var(--primary-hover))");
    const dark = css.slice(0, css.indexOf('[data-theme="light"]'));
    expect(dark).toContain("--brand-fill: linear-gradient(135deg, var(--primary-strong), var(--primary))");
  });

  test("and both pages that fill a button reach for that token", () => {
    // Pinned per file, not by counting matches across the repo.
    for (const file of ["options.html", "diagnostics.html"]) {
      const css = read(file);
      expect(`${file}: ${css.includes("background: var(--brand-fill);")}`).toBe(`${file}: true`);
      expect(`${file}: ${css.includes("linear-gradient(135deg, var(--primary-strong), var(--primary))")}`)
        .toBe(`${file}: false`);
    }
  });

  test("the Run button hint clears its own fill", () => {
    // The cap inside it inherits this colour now that it has dropped its
    // own chip, so this one value carries both. Measured against the
    // DARKER end of the button's gradient, which is the harder one.
    const css = read("popup.html");
    const alpha = (rule) => {
      const at = css.indexOf(rule);
      expect(`${rule}: ${at > -1}`).toBe(`${rule}: true`);
      const m = css.slice(at, css.indexOf("}", at)).match(/rgba\(4, 24, 29, ([0-9.]+)\)/);
      expect(m).not.toBeNull();
      return Number(m[1]);
    };
    const over = (a) => ({
      r: a * 4 + (1 - a) * 34,
      g: a * 24 + (1 - a) * 211,
      b: a * 29 + (1 - a) * 238
    });
    for (const rule of [".shortcut-hint {", 'html[data-theme="light"] .shortcut-hint {']) {
      const a = alpha(rule);
      expect(`${rule}: ${ratio(over(a), { r: 34, g: 211, b: 238 }) >= 4.5}`).toBe(`${rule}: true`);
    }
  });

  test("the saved state uses the ink green, not the fill green", () => {
    // --success in light is #059669 and white on it is 3.76:1;
    // --ink-good exists for exactly this and takes it to 5.48:1.
    const css = read("options.html");
    expect(css).toContain("[data-theme=\"light\"] #save.success");
    const at = css.indexOf("[data-theme=\"light\"] #save.success");
    expect(css.slice(at, css.indexOf("}", at))).toContain("var(--ink-good)");
  });

  test("the Pro line on the Options page writes in the ink green too", () => {
    expect(read("options.js")).toContain('statusEl.style.color = "var(--ink-good, #34d399)"');
  });

  test("the privacy link is the ink blue, which is the only link on that tab", () => {
    const css = read("popup.html");
    const at = css.indexOf(".run-assurance .assurance-link {");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toContain("var(--ink-info)");
  });
});

// ------------------------------------------------------------- progress

describe("the progress card carries the floor mark", () => {
  // Booted rather than pinned as source. A source pin survives the
  // mutation that matters here: setting the flag to a constant leaves
  // every string and every field name in the file exactly where it was,
  // and the pin reads them and reports green. This suite is the first
  // one to drive progress.js at all.
  let onMessage;

  const bootProgress = async () => {
    const store = { local: {}, session: {} };
    const area = (bag) => ({
      get: (keys, cb) => {
        const out = {};
        const list = keys === null || keys === undefined
          ? Object.keys(bag)
          : (Array.isArray(keys) ? keys : [keys]);
        for (const k of list) if (k in bag) out[k] = bag[k];
        cb(out);
      },
      set: (obj, cb) => { Object.assign(bag, obj); if (cb) cb(); },
      remove: (keys, cb) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete bag[k];
        if (cb) cb();
      }
    });
    global.chrome = {
      runtime: {
        id: "test", lastError: null,
        getURL: (p) => `chrome-extension://test/${p}`,
        getManifest: () => ({ version: "8.25.0" }),
        onMessage: { addListener: (cb) => { onMessage = cb; }, removeListener: () => {} },
        sendMessage: (msg, cb) => { if (typeof cb === "function") cb({ ok: true }); }
      },
      storage: { local: area(store.local), session: area(store.session) },
      tabs: {
        query: (q, cb) => cb([]),
        get: (id, cb) => cb({ id, url: "https://mail.google.com/mail/u/0/#inbox" }),
        sendMessage: (id, m, cb) => { if (cb) cb(undefined); },
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} }
      },
      scripting: { executeScript: (o, cb) => { if (cb) cb([]); } },
      i18n: { getMessage: () => "" }
    };
    const html = read("progress.html");
    const inner = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
    document.documentElement.innerHTML = (inner ? inner[1] : html)
      .replace(/<script[^>]*><\/script>/g, "");
    // The page reads the Gmail tab it is watching out of its own query
    // string and bails to an error screen without one, so the dashboard
    // never reaches the state a done message lands in.
    window.history.replaceState({}, "", "/progress.html?gmailTabId=7");
    // eslint-disable-next-line no-new-func
    new Function(read("shared.js") + read("progress.js"))();
    window.dispatchEvent(new window.Event("DOMContentLoaded"));
    await settle(20);
  };

  const finish = async (stats) => {
    onMessage({
      type: "gmailCleanerProgress",
      phase: "done", done: true, percent: 100,
      status: "Cleanup finished.", stats
      // 8.15 made this page the dashboard for ONE Gmail tab, so a
      // message from any other sender is another account's run and is
      // dropped. The sender has to be the tab in the query string.
    }, { id: "test", tab: { id: 7 } }, () => {});
    await settle(20);
  };

  const dry = (over = {}) => ({
    mode: "dry", action: "delete", runCount: 150,
    totalWouldDelete: 150, totalDeleted: 0, totalFreedMb: 0,
    totalQueries: 6, stoppedShort: 0, perQuery: [], tagLabels: [], ...over
  });

  test("a floored preview reads 'at least' on the done card", async () => {
    await bootProgress();
    await finish(dry({ wouldDeleteFloors: 2 }));
    expect(document.getElementById("doneNumber").textContent)
      .toContain("at least 150 emails matched");
  });

  test("a totalled preview reads exactly as it always did", async () => {
    await bootProgress();
    await finish(dry({ wouldDeleteFloors: 0 }));
    const text = document.getElementById("doneNumber").textContent;
    expect(text).toContain("150 emails matched");
    expect(text).not.toContain("at least");
  });

  test("a live run is never qualified by it", async () => {
    await bootProgress();
    await finish(dry({ mode: "live", totalDeleted: 150, wouldDeleteFloors: 4 }));
    expect(document.getElementById("doneNumber").textContent).toContain("150 emails cleaned");
  });

  test("the KPI chip carries the mark too", async () => {
    // A chip is the shortest surface in the product and the easiest
    // place for a qualified figure to lose its qualifier.
    await bootProgress();
    await finish(dry({ wouldDeleteFloors: 1 }));
    // jsdom implements textContent, not innerText.
    expect(document.body.textContent).toContain("150+");
  });

  test("and drops it when Gmail totalled every rule", async () => {
    await bootProgress();
    await finish(dry({ wouldDeleteFloors: 0 }));
    expect(document.body.textContent).not.toContain("150+");
  });
});
