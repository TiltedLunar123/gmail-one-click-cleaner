/**
 * @jest-environment jsdom
 *
 * The floor mark from the engine to the screen (8.24).
 *
 * The engine side is pinned in sweep-8-24-report-floors. This is the
 * other half of the same journey: the worker has to persist the flag,
 * shared.js has to carry it through TWO rebuilds, and the popup has to
 * render it.
 *
 * The middle step is where this has gone wrong before. rankReportBands
 * rebuilds every band from a fixed field list, at ingest AND at render,
 * and 8.9's `measured` flag was left off that list -- so the honesty fix
 * it existed for never once appeared on screen until 8.10 found it. A
 * new flag added the same way would die the same way, silently, and
 * every engine-side test would still pass.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await flush(); };

// ---------------------------------------------------------------- shared

function loadShared() {
  // eslint-disable-next-line no-new-func
  return new Function(`${read("shared.js")}; return GCC;`)();
}

const band = (over = {}) => ({
  id: "promotions", kind: "noise", action: "delete",
  count: 50, estMb: 0, measured: true, cleanedAt: 0, ...over
});

describe("the flag survives shared.js, which is where the last one died", () => {
  test("rankBands carries atLeast through the rebuild", () => {
    const GCC = loadShared();
    const [out] = GCC.report.rankBands([band({ atLeast: true })]);
    expect(out.atLeast).toBe(true);
  });

  test("a band with no flag is exact, the way every stored report is", () => {
    const GCC = loadShared();
    const [out] = GCC.report.rankBands([band()]);
    expect(out.atLeast).toBe(false);
  });

  test("ranking twice does not lose it", () => {
    // The popup ranks at ingest and again at render, so the second pass
    // reads the first pass's output. A field that survives one rebuild
    // and not two is the same bug with an extra step.
    const GCC = loadShared();
    const once = GCC.report.rankBands([band({ atLeast: true })]);
    const twice = GCC.report.rankBands(once);
    expect(twice[0].atLeast).toBe(true);
  });

  test("at least nothing is not a claim, so a zero band is never marked", () => {
    const GCC = loadShared();
    const [out] = GCC.report.rankBands([band({ count: 0, atLeast: true })]);
    expect(out.count).toBe(0);
    expect(out.atLeast).toBe(false);
  });

  test("foldBands answers false, because a bare id-to-number map has no provenance", () => {
    const GCC = loadShared();
    const folded = GCC.report.foldBands({ promotions: 40 });
    const promos = folded.find((b) => b.id === "promotions");
    expect(promos.count).toBe(40);
    expect(promos.atLeast).toBe(false);
  });
});

describe("the upsell line is the one read when money changes hands", () => {
  const bands = (over) => [
    band({ id: "sizeHuge", kind: "size", action: "delete", count: 20, estMb: 500 }),
    band({ id: "promotions", count: 50, ...over })
  ];

  test("a single locked floor step says at least", () => {
    const GCC = loadShared();
    const line = GCC.report.upsellLine(bands({ atLeast: true }));
    expect(line).toContain("at least 50");
  });

  test("an exact one still states the figure flat", () => {
    const GCC = loadShared();
    const line = GCC.report.upsellLine(bands({ atLeast: false }));
    expect(line).toContain("50 emails");
    expect(line).not.toContain("at least 50");
  });

  test("the band that SUPPLIES the number decides the wording", () => {
    // Not "any locked band was a floor". The sentence names one band's
    // count, so the qualifier has to come from that band. A smaller
    // floor band beside a larger exact one must not turn the larger
    // one's exact figure into an at-least.
    const GCC = loadShared();
    const line = GCC.report.upsellLine([
      band({ id: "sizeHuge", kind: "size", action: "delete", count: 20, estMb: 500 }),
      band({ id: "promotions", count: 9000, atLeast: false }),
      band({ id: "social", count: 50, atLeast: true })
    ]);
    expect(line).toContain("9,000");
    expect(line).not.toContain("at least");
  });

  test("and the reverse: a floor largest band is qualified", () => {
    const GCC = loadShared();
    const line = GCC.report.upsellLine([
      band({ id: "sizeHuge", kind: "size", action: "delete", count: 20, estMb: 500 }),
      band({ id: "promotions", count: 9000, atLeast: true }),
      band({ id: "social", count: 50, atLeast: false })
    ]);
    expect(line).toContain("at least 9,000");
  });
});

describe("a suggestion card does not state a percentage of one page", () => {
  const sender = (signals) => ({ email: "news@example.com", signals });

  test("an approximate sender loses the unread percentage entirely", () => {
    const GCC = loadShared();
    // The clause read "100% unread" for any sender past one page: the
    // most confident and least true thing on the card.
    const line = GCC.smart.reasonText(sender({ count: 50, unreadRatio: 1, oldShare: 1, approx: true }));
    expect(line).not.toContain("%");
    expect(line).not.toContain("mostly older than 6 months");
    expect(line).toContain("at least 50 emails");
  });

  test("a measured sender keeps every part of it", () => {
    const GCC = loadShared();
    const line = GCC.smart.reasonText(sender({ count: 400, unreadRatio: 0.96, oldShare: 0.8 }));
    expect(line).toContain("400 emails");
    expect(line).toContain("96% unread");
    expect(line).toContain("mostly older than 6 months");
  });

  test("the shared action policy refuses unsubscribe on an approximate ratio", () => {
    // Pinned against the engine's own copy in sweep-8-24-report-floors.
    // The two implementations are deliberate duplicates and the suite
    // that keeps them together is the only thing stopping them drifting.
    const GCC = loadShared();
    const real = { count: 400, unreadRatio: 0.95, oldShare: 0.2, shape: true };
    expect(GCC.smart.primaryAction(sender(real))).toBe("unsubscribe");
    expect(GCC.smart.primaryAction(sender({ ...real, approx: true }))).not.toBe("unsubscribe");
  });
});

// ---------------------------------------------------------------- worker

describe("the worker stores the flag rather than dropping it", () => {
  // Driven the way background-report drives it: through the real message
  // listener, because that is the only entry the engine ever uses and a
  // direct call would not prove the message shape reaches the writer.
  let backing;
  let onMessageCb;

  const area = (name) => ({
    get: async (keys) => {
      if (typeof keys === "string") return { [keys]: backing[name][keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = backing[name][k];
        return out;
      }
      return { ...backing[name] };
    },
    set: async (obj) => { Object.assign(backing[name], obj); },
    remove: async (keys) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete backing[name][k];
    }
  });

  beforeAll(() => {
    backing = { local: {}, sync: {}, session: {} };
    global.chrome = {
      runtime: {
        id: "test-extension-id",
        onInstalled: { addListener: jest.fn() },
        onStartup: { addListener: jest.fn() },
        onMessage: { addListener: jest.fn((cb) => { onMessageCb = cb; }) },
        sendMessage: jest.fn().mockRejectedValue(new Error("no listener")),
        getURL: jest.fn((p) => `chrome-extension://test/${p}`),
        lastError: null
      },
      storage: { local: area("local"), sync: area("sync"), session: area("session") },
      alarms: {
        create: jest.fn(), clear: jest.fn(async () => true),
        getAll: jest.fn(async () => []), onAlarm: { addListener: jest.fn() }
      },
      tabs: {
        query: jest.fn(async () => []), get: jest.fn(async (id) => ({ id })),
        onRemoved: { addListener: jest.fn() }
      },
      scripting: { executeScript: jest.fn(async () => []) },
      notifications: { create: jest.fn((id, opts, cb) => cb && cb()) }
    };
    // eslint-disable-next-line no-new-func
    new Function(read("background.js"))();
  });

  beforeEach(() => { backing = { local: {}, sync: {}, session: {} }; });

  const dispatch = async (msg) => {
    onMessageCb(msg, { id: "test-extension-id" }, jest.fn());
    await new Promise((r) => setTimeout(r, 50));
  };
  const report = () => backing.local.mailboxReport;

  const scan = (over = {}) => ({
    type: "gmailCleanerReportScanResult",
    bands: [{
      id: "promotions", kind: "noise", action: "delete",
      count: 50, estMb: 0, measured: true, ...(over.band || {})
    }],
    cleanableCount: 50,
    ...over.top
  });

  test("a floor band and a floor headline are stored as floors", async () => {
    await dispatch(scan({ band: { atLeast: true }, top: { cleanableAtLeast: true } }));
    expect(report().bands[0].atLeast).toBe(true);
    expect(report().cleanableAtLeast).toBe(true);
  });

  test("a scan from a build that had no flag reads as exact", async () => {
    // The opposite default to `measured`, and deliberately so: absent
    // has to mean the reading the older build actually showed, and that
    // build printed its counts flat.
    await dispatch(scan());
    expect(report().bands[0].atLeast).toBe(false);
    expect(report().cleanableAtLeast).toBe(false);
  });

  test("the flag cannot be smuggled in as a truthy string", async () => {
    // Band ids arrive over a message and are allow-listed rather than
    // coerced; the same standard applies to anything read beside them.
    await dispatch(scan({ band: { atLeast: "yes" }, top: { cleanableAtLeast: 1 } }));
    expect(report().bands[0].atLeast).toBe(false);
    expect(report().cleanableAtLeast).toBe(false);
  });

  test("smart signals keep the approximate mark, and older ones stay unmarked", async () => {
    await dispatch({
      type: "gmailCleanerSmartScanResult",
      senders: [
        { email: "a@example.com", name: "A", score: 70, action: "deleteOld", reachable: 50,
          signals: { count: 50, unreadRatio: 1, oldShare: 1, approx: true } },
        { email: "b@example.com", name: "B", score: 70, action: "deleteOld", reachable: 40,
          signals: { count: 400, unreadRatio: 0.9, oldShare: 0.2 } }
      ]
    });
    const senders = backing.local.smartScan.senders;
    const byEmail = (e) => senders.find((s) => s.email === e);
    expect(byEmail("a@example.com").signals.approx).toBe(true);
    expect(byEmail("b@example.com").signals.approx).toBeUndefined();
  });
});

// ----------------------------------------------------------------- popup

describe("the popup prints a floor as a floor", () => {
  const REPORT = {
    updatedAt: 1750000000000,
    cleanableCount: 50,
    cleanableAtLeast: true,
    largeMb: 100,
    topSenders: [],
    bands: [
      { id: "sizeHuge", kind: "size", action: "delete", count: 4, estMb: 100, measured: true, atLeast: false, cleanedAt: 0 },
      { id: "promotions", kind: "noise", action: "delete", count: 50, estMb: 0, measured: true, atLeast: true, cleanedAt: 0 },
      { id: "social", kind: "noise", action: "delete", count: 3000, estMb: 0, measured: true, atLeast: false, cleanedAt: 0 }
    ]
  };

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
        getManifest: () => ({ version: "8.24.0", permissions: [], host_permissions: [] }),
        onMessage: { addListener: (cb) => { onMessage = cb; } },
        sendMessage: (msg, cb) => {
          const reply = msg?.type === "gmailCleanerGetReport"
            ? { ok: true, report }
            : { ok: true };
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

    // Same two seams popup-report-flow unfreezes, and for the same
    // reason: the licence answer is not the subject here and the real
    // one needs WebCrypto.
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

  const rowFor = (id) =>
    [...document.querySelectorAll(".report-row")]
      .find((r) => r.querySelector(`[data-band="${id}"]`) || r.classList.contains("is-free"));

  test("a floor band renders the plus and an exact one does not", async () => {
    await bootPopup(REPORT);
    const counts = [...document.querySelectorAll(".report-row")].map((r) => ({
      text: r.querySelector(".report-row-count").textContent,
      floor: r.querySelector(".report-row-count").classList.contains("report-row-count--floor")
    }));
    expect(counts).toEqual(
      expect.arrayContaining([
        { text: "50+", floor: true },
        { text: "3,000", floor: false },
        { text: "4", floor: false }
      ])
    );
  });

  test("the claim is real text for a screen reader, not a glyph", async () => {
    await bootPopup(REPORT);
    const row = [...document.querySelectorAll(".report-row")]
      .find((r) => r.querySelector(".report-row-count").textContent === "50+");
    // "50+" is announced as "fifty" by most readers, so the digits step
    // out of the accessibility tree and the phrase goes in beside them.
    expect(row.querySelector(".report-row-count").getAttribute("aria-hidden")).toBe("true");
    expect(row.querySelector(".report-row-figures .sr-only").textContent).toBe("at least 50");
  });

  test("an exact row is not hidden from a screen reader", async () => {
    await bootPopup(REPORT);
    const row = [...document.querySelectorAll(".report-row")]
      .find((r) => r.querySelector(".report-row-count").textContent === "3,000");
    // Structural, not a text match: aria-hidden="true" and the substring
    // "hidden" are different facts, and asserting the second is how 8.18
    // wrote a test that passed on `aria-hidden`.
    expect(row.querySelector(".report-row-count").getAttribute("aria-hidden")).not.toBe("true");
    expect(row.querySelector(".report-row-figures .sr-only")).toBeNull();
  });

  test("the hero number carries it too, before any animation runs", async () => {
    await bootPopup(REPORT);
    // countUp writes the final text first and animates second, so this
    // is the string that lands on frame one and survives reduced motion.
    expect(document.getElementById("reportHeroCount").textContent).toBe("50+");
    expect(document.getElementById("reportHeroCount").getAttribute("aria-hidden")).toBe("true");
    expect(document.getElementById("reportHeroCountSr").textContent).toBe("at least 50");
  });

  test("an exact headline renders exactly as it always did", async () => {
    await bootPopup({ ...REPORT, cleanableCount: 12000, cleanableAtLeast: false });
    expect(document.getElementById("reportHeroCount").textContent).toBe("12,000");
    expect(document.getElementById("reportHeroCount").getAttribute("aria-hidden")).not.toBe("true");
    expect(document.getElementById("reportHeroCountSr").textContent).toBe("");
  });

  test("a scan finishing while the popup is OPEN carries the flag too", async () => {
    // Two ways a report reaches this screen and they are separate code:
    // the stored one on open, and the live done message when a scan
    // finishes with the popup still up. Reading the flag in one and not
    // the other means the number is honest until you watch it arrive.
    await bootPopup({ ...REPORT, cleanableCount: 0, cleanableAtLeast: false, bands: [], updatedAt: 0 });
    expect(typeof onMessage).toBe("function");
    onMessage({
      type: "gmailCleanerProgress",
      runKind: "reportScan",
      phase: "done",
      done: true,
      status: "At least 50 emails are older than 6 months.",
      bands: REPORT.bands,
      cleanableCount: 50,
      cleanableAtLeast: true,
      largeMb: 100,
      topSenders: [],
      failedQueries: 0,
      totalQueries: 12
    }, { id: "test" }, () => {});
    await settle(10);
    expect(document.getElementById("reportHeroCount").textContent).toBe("50+");
    expect(document.getElementById("reportHeroCountSr").textContent).toBe("at least 50");
  });

  test("the floor row still gets its Run control", async () => {
    // 8.10's lesson from the unmeasured state: a row that cannot be run
    // is a different thing from a row whose count is a floor, and only
    // the first one loses its button. A floor band has real mail behind
    // it and a purge that will reach all of it.
    await bootPopup(REPORT);
    const row = [...document.querySelectorAll(".report-row")]
      .find((r) => r.querySelector(".report-row-count").textContent === "50+");
    expect(row.querySelector(".report-row-btn")).not.toBeNull();
    expect(rowFor("promotions") || row).not.toBeNull();
  });
});
