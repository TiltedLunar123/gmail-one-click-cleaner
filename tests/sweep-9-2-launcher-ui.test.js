/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * The in-Gmail launcher, page side (9.2).
 *
 * This is the only file in the extension that runs on every Gmail page
 * load, in the page's own document, whether or not anyone asked it to.
 * So the suite is mostly about restraint: what it draws, where it draws
 * it, and everything it declines to touch.
 *
 * The real English catalogue backs chrome.i18n here, so a panel that
 * renders an empty string because a key does not exist fails as a blank
 * assertion rather than passing quietly.
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
      // Answer on a microtask, the way the real port does, so the boot
      // sequence is genuinely asynchronous here too.
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

const REPORT = {
  updatedAt: 1700000000000,
  cleanableCount: 12000,
  cleanableAtLeast: true,
  largeMb: 340,
  bands: [
    { id: "promotions", count: 8000, estMb: 0, atLeast: false },
    { id: "sizeHuge", count: 4, estMb: 100, atLeast: false },
    { id: "inboxOld", count: 900, estMb: 0, atLeast: false },
    { id: "forums", count: 0, estMb: 0, atLeast: false }
  ]
};

// Microtasks only, never a timer: two of these tests run on fake timers
// and the script's own answers all arrive on the microtask queue.
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

// The root is closed, so the page cannot reach it and neither can a
// test through host.shadowRoot. Intercepting attachShadow is how the
// suite gets in, and it is deliberately something only code running
// BEFORE the launcher can do: a script that arrives afterwards, which
// is every script on mail.google.com, has no way back in.
let shadowRoots;
const realAttachShadow = Element.prototype.attachShadow;

const host = () => document.getElementById(HOST_ID);
const root = () => (host() ? shadowRoots.get(host()) || null : null);
const q = (sel) => root()?.querySelector(sel) || null;
const text = () => root()?.textContent || "";
const buttonSaying = (label) => [...(root()?.querySelectorAll("button") || [])]
  .find((b) => b.textContent.trim() === label) || null;

// Each test evaluates the file afresh, and each evaluation leaves a live
// MutationObserver watching <body>. Without this the observer from the
// previous test sees the next test empty the body, decides its button
// has been removed, and puts one back into a document that is supposed
// to be bare. Track them and cut them loose between tests.
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

describe("what it draws, and what it leaves alone", () => {
  test("one host node under body, and the whole UI inside its shadow root", async () => {
    await boot();
    expect(host()).not.toBeNull();
    expect(document.body.children).toHaveLength(1);
    expect(root()).not.toBeNull();
    expect(q(".pill")).not.toBeNull();
    // Nothing of this extension's styling may reach Gmail's document.
    expect(document.head.querySelector("style")).toBeNull();
    expect(root().querySelector("style")).not.toBeNull();
  });

  test("the page cannot read the panel, and the node carries no version", async () => {
    await boot({ report: REPORT });
    q(".pill").click();
    // What a script on mail.google.com sees: a div with an id, no way
    // into the root, and none of the user's counts.
    expect(host().shadowRoot).toBeNull();
    expect(host().outerHTML).toBe(`<div id="${HOST_ID}"></div>`);
    expect(host().textContent).toBe("");
  });

  test("the pill says something, from the catalogue rather than a blank", async () => {
    await boot();
    expect(q(".pill").textContent).toContain(CATALOG.launcherPill.message);
    expect(q(".pill").textContent.trim().length).toBeGreaterThan(0);
  });

  test("a launcher the worker says to hide draws nothing at all", async () => {
    await boot({ show: false });
    expect(host()).toBeNull();
    expect(document.body.children).toHaveLength(0);
  });

  test("no answer from the worker means no button", async () => {
    answers.gmailCleanerLauncherState = undefined;
    new Function(SRC)();
    await flush();
    expect(host()).toBeNull();
  });

  test("Gmail Chat is not a mailbox, so nothing is drawn and nothing is asked", async () => {
    window.history.replaceState({}, "", "/chat/u/0/#chat/home");
    new Function(SRC)();
    await flush();
    expect(host()).toBeNull();
    expect(sent).toHaveLength(0);
  });

  test("running twice does not stack a second button", async () => {
    await boot();
    const first = host();
    new Function(SRC)();
    await flush();
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
    // The live copy keeps the corner rather than being replaced.
    expect(host()).toBe(first);
  });

  test("an orphan left by an update is taken over, not stood down in front of", async () => {
    await boot();
    const orphan = host();
    // What an invalidated context looks like from the page: the node and
    // its listeners are still there, and chrome.runtime.id is gone. The
    // old copy answers the liveness question honestly, with a no.
    global.chrome.runtime.id = undefined;

    new Function(SRC)();
    await flush();

    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
    expect(host()).not.toBe(orphan);
    expect(q(".pill")).not.toBeNull();
  });

  test("it puts itself back if something removes it", async () => {
    await boot();
    host().remove();
    // The observer is asynchronous; jsdom delivers records on a
    // microtask checkpoint.
    await new Promise((r) => setTimeout(r, 0));
    expect(host()).not.toBeNull();
    expect(q(".pill")).not.toBeNull();
  });
});

describe("the one greeting", () => {
  test("opens by itself and is marked given before it is dismissed", async () => {
    await boot({ greet: true });
    expect(q(".panel")).not.toBeNull();
    expect(text()).toContain(CATALOG.launcherGreetTitle.message);
    // The page sends nothing to claim the greeting: answering the state
    // question is what spends it, in the worker, under its lock. See the
    // worker suite for the two-tabs-at-once half of that.
    expect(sent.map((m) => m.type)).toEqual(["gmailCleanerLauncherState"]);
  });

  test("Not now puts it back to the pill", async () => {
    await boot({ greet: true });
    buttonSaying(CATALOG.launcherNotNow.message).click();
    expect(q(".panel")).toBeNull();
    expect(q(".pill")).not.toBeNull();
  });

  test("without a greeting the panel stays closed", async () => {
    await boot();
    expect(q(".panel")).toBeNull();
  });
});

describe("the report, in the corner of Gmail", () => {
  test("the pill opens the last scan, in the catalogue's own band names", async () => {
    await boot({ report: REPORT });
    q(".pill").click();

    expect(text()).toContain(CATALOG.launcherResultTitle.message);
    // The plus is the report's "at least" notation, carried through.
    expect(text()).toContain("12,000+");
    expect(text()).toContain("340+ MB");
    // Three biggest by count, and a band with nothing in it is not a step.
    expect(text()).toContain(CATALOG.reportBand_promotions.message);
    expect(text()).toContain(CATALOG.reportBand_inboxOld.message);
    expect(text()).not.toContain(CATALOG.reportBand_forums.message);
  });

  test("an empty mailbox says so instead of showing zeroes", async () => {
    await boot({ report: { updatedAt: 1, bands: [], cleanableCount: 0, largeMb: 0 } });
    q(".pill").click();
    expect(text()).toContain(CATALOG.launcherResultEmpty.message);
    expect(q(".stats")).toBeNull();
  });

  test("with no report yet, the panel offers the scan", async () => {
    await boot();
    q(".pill").click();
    expect(text()).toContain(CATALOG.launcherIdleTitle.message);
    expect(buttonSaying(CATALOG.launcherScanCta.message)).not.toBeNull();
  });

  test("opening it catches up on a scan the popup ran since the page loaded", async () => {
    await boot();
    // The panel was built with no report. The popup then ran one.
    answers.gmailCleanerLauncherState = {
      ok: true, show: true, greet: false, busy: false, report: REPORT
    };
    q(".pill").click();
    expect(text()).toContain(CATALOG.launcherIdleTitle.message);
    await flush();
    expect(text()).toContain(CATALOG.launcherResultTitle.message);
    expect(text()).toContain("12,000+");
  });

  test("a catch-up answer does not overwrite whatever was clicked while it travelled", async () => {
    await boot();
    answers.gmailCleanerLauncherState = {
      ok: true, show: true, greet: false, busy: false, report: REPORT
    };
    q(".pill").click();
    // The Hide confirmation opens before the worker has answered.
    buttonSaying(CATALOG.launcherHide.message).click();
    await flush();
    expect(text()).toContain(CATALOG.launcherHideAsk.message);
    expect(text()).not.toContain(CATALOG.launcherResultTitle.message);
  });
});

describe("starting a scan", () => {
  test("asks the worker, and says what is happening while it waits", async () => {
    await boot();
    jest.useFakeTimers();
    q(".pill").click();
    buttonSaying(CATALOG.launcherScanCta.message).click();
    await flush();

    expect(sent.map((m) => m.type)).toContain("gmailCleanerLauncherScan");
    expect(text()).toContain(CATALOG.launcherScanningTitle.message);
    expect(q(".spinner")).not.toBeNull();
    jest.clearAllTimers();
  });

  test("a refusal is repeated in words, not swallowed", async () => {
    answers.gmailCleanerLauncherScan = { ok: false, error: "busy" };
    await boot();
    q(".pill").click();
    buttonSaying(CATALOG.launcherScanCta.message).click();
    await flush();
    expect(text()).toContain(CATALOG.launcherBusy.message);
  });

  test("a dead port says reload rather than failing in silence", async () => {
    answers.gmailCleanerLauncherScan = undefined;
    await boot();
    q(".pill").click();
    buttonSaying(CATALOG.launcherScanCta.message).click();
    await flush();
    expect(text()).toContain(CATALOG.launcherStale.message);
  });

  test("a finished scan replaces the spinner with the numbers", async () => {
    await boot();
    jest.useFakeTimers();
    q(".pill").click();
    buttonSaying(CATALOG.launcherScanCta.message).click();
    await flush();

    // The worker's stored report now carries a newer timestamp, which is
    // the only signal the panel waits on.
    answers.gmailCleanerLauncherState = {
      ok: true, show: true, greet: false, busy: false, report: REPORT
    };
    jest.advanceTimersByTime(2000);
    await flush();
    await Promise.resolve();

    expect(text()).toContain(CATALOG.launcherResultTitle.message);
    expect(text()).toContain("12,000+");
    jest.clearAllTimers();
  });

  test("a scan that finishes after the panel was closed does not reopen it", async () => {
    await boot();
    jest.useFakeTimers();
    q(".pill").click();
    buttonSaying(CATALOG.launcherScanCta.message).click();
    await flush();

    // Closed while it runs. That is a statement about what the corner of
    // their mailbox should look like, and finishing is not permission to
    // undo it.
    root().querySelector(`.icon-btn[title="${CATALOG.launcherClose.message}"]`).click();
    expect(q(".panel")).toBeNull();

    answers.gmailCleanerLauncherState = {
      ok: true, show: true, greet: false, busy: false, report: REPORT
    };
    jest.advanceTimersByTime(2000);
    await flush();

    expect(q(".panel")).toBeNull();
    expect(q(".pill")).not.toBeNull();
    // And the answer is waiting behind the pill.
    jest.useRealTimers();
    q(".pill").click();
    expect(text()).toContain(CATALOG.launcherResultTitle.message);
  });
});

describe("getting rid of it", () => {
  test("hide takes the button off the page and tells the worker which kind", async () => {
    await boot();
    q(".pill").click();
    buttonSaying(CATALOG.launcherHide.message).click();
    expect(text()).toContain(CATALOG.launcherHideAsk.message);

    buttonSaying(CATALOG.launcherHide30.message).click();
    await flush();
    expect(sent.find((m) => m.type === "gmailCleanerLauncherHide")).toEqual({
      type: "gmailCleanerLauncherHide",
      forever: false
    });
    expect(host()).toBeNull();
  });

  test("turning it off is a different message from hiding it", async () => {
    await boot();
    q(".pill").click();
    buttonSaying(CATALOG.launcherHide.message).click();
    buttonSaying(CATALOG.launcherHideOff.message).click();
    await flush();
    expect(sent.find((m) => m.type === "gmailCleanerLauncherHide").forever).toBe(true);
  });

  test("and it stays gone: the observer does not put a hidden button back", async () => {
    await boot();
    q(".pill").click();
    buttonSaying(CATALOG.launcherHide.message).click();
    buttonSaying(CATALOG.launcherHideOff.message).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(host()).toBeNull();
  });
});

describe("handing over to the popup", () => {
  test("when the browser will not open it, the panel says where the icon is", async () => {
    await boot({ report: REPORT });
    q(".pill").click();
    buttonSaying(CATALOG.launcherOpenCta.message).click();
    await flush();
    expect(text()).toContain(CATALOG.launcherPinHint.message);
  });

  test("when it does open, the panel gets out of the way", async () => {
    answers.gmailCleanerLauncherOpenPopup = { ok: true };
    await boot({ report: REPORT });
    q(".pill").click();
    buttonSaying(CATALOG.launcherOpenCta.message).click();
    await flush();
    expect(q(".panel")).toBeNull();
    expect(q(".pill")).not.toBeNull();
  });
});
