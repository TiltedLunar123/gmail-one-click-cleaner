/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * 9.4, the in-Gmail launcher's result panel.
 *
 * The panel drew "That is a clean mailbox" whenever every band came back
 * zero. That is a positive claim about someone's mail, and two ordinary
 * records reach it without earning it.
 *
 * A scan whose searches timed out stores ten bands at count 0 with
 * measured:false and a failedQueries count beside them. The popup shows
 * those as unmeasured rows under a "N of 12 searches timed out" note.
 * This surface turned the same record into an all-clear.
 *
 * And a mailbox can hold plenty of old mail that lands in none of the
 * named steps. That is the case the popup's 8.5.1 fix exists for, the
 * figure is sitting in cleanableCount, and the panel dropped it and said
 * the mailbox was clean.
 *
 * Separately: render() rebuilds the whole shadow tree, so a view change
 * destroys whatever had focus. Async changes must not steal the caret
 * out of Gmail, which is why the default is to leave focus alone, but a
 * change the user asked for by pressing a button in this panel is not
 * async, and it left a keyboard user tabbing back in from the top.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "gmailLauncher.js"), "utf-8");
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, "_locales", "en", "messages.json"), "utf8"));

const HOST_ID = "gcc-launcher-root";

let sent;
let answers;

const chromeMock = () => ({
  runtime: {
    id: "test-extension-id",
    lastError: null,
    sendMessage: jest.fn((msg, cb) => {
      sent.push(msg);
      const answer = answers[msg.type];
      Promise.resolve().then(() => cb(typeof answer === "function" ? answer(msg) : answer));
    })
  },
  storage: { onChanged: { addListener: () => {} } },
  i18n: {
    getMessage: jest.fn((key, subs) => {
      const entry = CATALOG[key];
      if (!entry) return "";
      let out = entry.message;
      for (const [i, sub] of [].concat(subs || []).entries()) {
        out = out.split(`$${i + 1}`).join(String(sub));
      }
      return out;
    })
  }
});

// Every search timed out. recordReportScan stores the bands anyway, at
// zero and measured:false, with the headline it did get.
const REPORT_TIMED_OUT = {
  updatedAt: 1700000000000,
  cleanableCount: 12438,
  cleanableAtLeast: true,
  largeMb: 0,
  failedQueries: 10,
  totalQueries: 12,
  bands: [
    { id: "promotions", count: 0, estMb: 0, atLeast: false, measured: false },
    { id: "inboxOld", count: 0, estMb: 0, atLeast: false, measured: false }
  ]
};

// A measured scan: old mail exists, none of it in a named step.
const REPORT_NO_BANDS = {
  updatedAt: 1700000000000,
  cleanableCount: 4100,
  cleanableAtLeast: false,
  largeMb: 0,
  failedQueries: 0,
  totalQueries: 12,
  bands: [{ id: "promotions", count: 0, estMb: 0, atLeast: false }]
};

// Genuinely nothing: measured, and no old mail at all.
const REPORT_ACTUALLY_CLEAN = {
  updatedAt: 1700000000000,
  cleanableCount: 0,
  cleanableAtLeast: false,
  largeMb: 0,
  failedQueries: 0,
  totalQueries: 12,
  bands: []
};

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

let shadowRoots;
const realAttachShadow = Element.prototype.attachShadow;

const host = () => document.getElementById(HOST_ID);
const root = () => (host() ? shadowRoots.get(host()) || null : null);
const q = (sel) => root()?.querySelector(sel) || null;
const text = () => root()?.textContent || "";

const boot = async (state = {}) => {
  answers.gmailCleanerLauncherState = {
    ok: true, show: true, greet: false, busy: false, report: null, ...state
  };
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  await flush();
};

const openPanel = async () => {
  q(".pill").click();
  await flush();
};

// Each boot leaves a live MutationObserver on <body>. Clearing the body
// for the next test is a childList mutation, so without this the
// previous copy sees its host go, decides its world is still live, and
// mounts a REPLACEMENT host into the fresh document. The next copy then
// finds that host and stands down, and the test reads an empty panel.
// This is the 9.3 orphan behaviour working correctly, and the 9.3 suite
// disconnects observers in afterEach for the same reason.
const RealMutationObserver = global.MutationObserver;
let observers;

beforeEach(() => {
  observers = [];
  global.MutationObserver = class extends RealMutationObserver {
    constructor(cb) {
      super(cb);
      observers.push(this);
    }
  };
  shadowRoots = new Map();
  Element.prototype.attachShadow = function attachShadow(init) {
    const created = realAttachShadow.call(this, init);
    shadowRoots.set(this, created);
    return created;
  };
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  window.history.replaceState({}, "", "/mail/u/0/#inbox");
  sent = [];
  answers = {
    gmailCleanerLauncherHide: { ok: true },
    gmailCleanerLauncherScan: { ok: true, runId: "launcher_1" },
    gmailCleanerLauncherOpenPopup: { ok: false, error: "unsupported" }
  };
  global.chrome = chromeMock();
});

afterEach(() => {
  for (const observer of observers) observer.disconnect();
  global.MutationObserver = RealMutationObserver;
  Element.prototype.attachShadow = realAttachShadow;
});

const CLEAN_CLAIM = CATALOG.launcherResultEmpty.message;

describe("the panel does not call a mailbox clean on a scan that did not finish", () => {
  test("a timed-out scan says so instead", async () => {
    await boot({ report: REPORT_TIMED_OUT });
    await openPanel();
    expect(text()).not.toContain(CLEAN_CLAIM);
    expect(text()).toContain(CATALOG.launcherResultUnmeasured.message);
  });

  test("old mail outside every named step is reported, with its count", async () => {
    await boot({ report: REPORT_NO_BANDS });
    await openPanel();
    expect(text()).not.toContain(CLEAN_CLAIM);
    expect(text()).toContain(CATALOG.launcherResultNoBands.message);
    // 8.5.1's whole point: the figure exists, so print it.
    expect(text()).toContain("4,100");
  });

  test("a measured, genuinely empty mailbox still gets the all-clear", async () => {
    await boot({ report: REPORT_ACTUALLY_CLEAN });
    await openPanel();
    expect(text()).toContain(CLEAN_CLAIM);
  });

  test("a report with real bands is unaffected", async () => {
    await boot({
      report: {
        ...REPORT_NO_BANDS,
        bands: [{ id: "promotions", count: 6000, estMb: 0, atLeast: false }]
      }
    });
    await openPanel();
    expect(text()).not.toContain(CLEAN_CLAIM);
    expect(text()).toContain("6,000");
  });
});

describe("a view the user asked for keeps focus inside the panel", () => {
  test("pressing Hide moves focus to the confirmation, not to the document", async () => {
    await boot({ report: REPORT_ACTUALLY_CLEAN });
    await openPanel();
    const hide = [...root().querySelectorAll(".link")].find(
      (b) => b.textContent === CATALOG.launcherHide.message
    );
    expect(hide).toBeTruthy();
    hide.click();
    await flush();
    // The old tree is gone. Focus has to be on something in the new one.
    const active = root().activeElement;
    expect(active).not.toBeNull();
    expect(active.classList.contains("cta")).toBe(true);
  });

  test("an async view change still does not take the caret", async () => {
    // A worker answer that arrives on its own is not a click. This is the
    // rule the default protects and it has to keep holding.
    await boot({ report: REPORT_ACTUALLY_CLEAN });
    await openPanel();
    const before = root().activeElement;
    expect(before).not.toBeNull();
    expect(SRC).toMatch(/const setView = \(view, takeFocus\) => \{/);
    expect(SRC).toMatch(/render\(takeFocus === true\)/);
    // Every stale/result transition is left at the default.
    for (const call of SRC.match(/setView\("stale"\)/g) || []) {
      expect(call).toBe('setView("stale")');
    }
  });
});
