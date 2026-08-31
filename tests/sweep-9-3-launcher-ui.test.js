/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * The in-Gmail launcher, page side (9.3 sweep).
 *
 * Two things the 9.2 suite could not see.
 *
 * The first is what an extension update leaves behind. 9.2 taught the
 * fresh copy to ask the orphan whether anything live still owns it, and
 * to take the corner over when the answer is no. What nobody asked was
 * what the ORPHAN does next: its MutationObserver is a DOM API, not a
 * chrome one, so it survives the world its listeners were built in and
 * goes on watching <body> for a host that is supposed to be gone.
 *
 * The second is a number. The panel prints the report's storage figure
 * with the report's own "at least" plus sign, and a mailbox can hold
 * plenty of old promotions and no large mail at all.
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

// Old promotions, nothing large. estMb is zero on every noise band by
// definition (they carry no mbFloor), so this is the ordinary shape of a
// cluttered mailbox rather than a corrupted record.
const REPORT_NO_LARGE = {
  updatedAt: 1700000000000,
  cleanableCount: 9400,
  cleanableAtLeast: false,
  largeMb: 0,
  bands: [
    { id: "promotions", count: 6000, estMb: 0, atLeast: false },
    { id: "inboxOld", count: 3400, estMb: 0, atLeast: false }
  ]
};

const REPORT_WITH_LARGE = {
  ...REPORT_NO_LARGE,
  largeMb: 340,
  bands: [...REPORT_NO_LARGE.bands, { id: "sizeHuge", count: 12, estMb: 300, atLeast: false }]
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const boot = async (state = {}) => {
  answers.gmailCleanerLauncherState = {
    ok: true, show: true, greet: false, busy: false, report: null, ...state
  };
  new Function(SRC)();
  await flush();
};

let shadowRoots;
const realAttachShadow = Element.prototype.attachShadow;

const host = () => document.getElementById(HOST_ID);
const root = () => (host() ? shadowRoots.get(host()) || null : null);
const q = (sel) => root()?.querySelector(sel) || null;
const text = () => root()?.textContent || "";

// The observer is asynchronous and jsdom delivers its records on a
// microtask checkpoint, so a macrotask is enough to see the whole of
// whatever it decided to do.
const settle = () => new Promise((r) => setTimeout(r, 0));

const RealMutationObserver = global.MutationObserver;
let observers;

beforeEach(() => {
  shadowRoots = new Map();
  Element.prototype.attachShadow = function attachShadow(init) {
    const created = realAttachShadow.call(this, init);
    shadowRoots.set(this, created);
    return created;
  };

  observers = [];
  global.MutationObserver = class extends RealMutationObserver {
    constructor(cb) {
      super(cb);
      observers.push(this);
    }
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
  jest.useRealTimers();
});

describe("an update does not leave a dead button behind", () => {
  test("the orphan's own observer stops putting the host back", async () => {
    await boot();
    expect(host()).not.toBeNull();

    // The world this copy was built in is gone: its listeners still run,
    // chrome.runtime.id does not answer any more. Then the replacement
    // copy removes the orphan host, which is the mutation the observer
    // below is about to see.
    global.chrome.runtime.id = undefined;
    host().remove();
    await settle();

    // Nothing live asked for a button here. Putting one back means a
    // pill in somebody's Gmail whose every click reaches nothing, and
    // it also takes the id the fresh copy needs, so the copy that COULD
    // have worked finds the corner occupied and stands down.
    expect(host()).toBeNull();
  });

  test("a live copy still repairs its own removal", async () => {
    await boot();
    host().remove();
    await settle();
    expect(host()).not.toBeNull();
    expect(q(".pill")).not.toBeNull();
  });
});

describe("the storage figure is a claim, so it is only made when there is one", () => {
  test("no large mail, no storage tile", async () => {
    await boot({ report: REPORT_NO_LARGE });
    q(".pill").click();
    await flush();

    expect(text()).toContain(CATALOG.launcherStatEmails.message);
    // "0+ MB in old, large mail" is not a smaller answer than 340, it is
    // not an answer. The popup drops the same line at zero.
    expect(text()).not.toContain(CATALOG.launcherStatStorage.message);
    expect(text()).not.toContain("0+");
  });

  test("large mail, and the tile is back", async () => {
    await boot({ report: REPORT_WITH_LARGE });
    q(".pill").click();
    await flush();

    expect(text()).toContain(CATALOG.launcherStatStorage.message);
    expect(text()).toContain("340+ MB");
  });

  test("the rows and the plan button survive either way", async () => {
    await boot({ report: REPORT_NO_LARGE });
    q(".pill").click();
    await flush();

    expect(root().querySelectorAll(".row").length).toBe(2);
    expect(text()).toContain(CATALOG.launcherOpenCta.message);
    expect(text()).toContain(CATALOG.reportBand_promotions.message);
  });
});
