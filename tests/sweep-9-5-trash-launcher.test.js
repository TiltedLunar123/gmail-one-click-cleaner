/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * 9.5, the guidance panel inside Gmail.
 *
 * The one thing worth saying at Trash is what Gmail's own "Empty Trash
 * now" link does, because it is the step that turns a recoverable
 * cleanup into a permanent one, and it takes mail the user deleted
 * themselves along with it. Said once, only when this extension's own
 * door put the tab there, and never anywhere near Gmail's controls: no
 * selector into the page, no pointing, no highlighting, no clicking.
 *
 * Everything below is about the panel refusing to appear when it has not
 * earned the right to.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "gmailLauncher.js"), "utf-8");
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, "_locales", "en", "messages.json"), "utf8"));

const HOST_ID = "gcc-launcher-root";
const TRASH_TITLE = CATALOG.launcherTrashTitle.message;
const TRASH_WARN = CATALOG.launcherTrashWarn.message;

let sent;
let answers;
let storageListener;

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
  storage: { onChanged: { addListener: (cb) => { storageListener = cb; } } },
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

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

let shadowRoots;
const realAttachShadow = Element.prototype.attachShadow;

const host = () => document.getElementById(HOST_ID);
const root = () => (host() ? shadowRoots.get(host()) || null : null);
const q = (sel) => root()?.querySelector(sel) || null;
const text = () => root()?.textContent || "";

const boot = async (state = {}) => {
  answers.gmailCleanerLauncherState = {
    ok: true, show: true, greet: false, busy: false, report: null, trashHint: false, ...state
  };
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  await flush();
};

// Each boot leaves a live MutationObserver on <body>: clearing the body
// for the next test is a childList mutation, so a copy left running
// would remount its host into the fresh document and the next copy would
// stand down. Same reason the 9.3 and 9.4 suites disconnect here.
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
  storageListener = null;
  answers = { gmailCleanerLauncherHide: { ok: true } };
  global.chrome = chromeMock();
});

afterEach(() => {
  for (const observer of observers) observer.disconnect();
  global.MutationObserver = RealMutationObserver;
  Element.prototype.attachShadow = realAttachShadow;
});

const goTo = async (hash) => {
  const before = window.location.href;
  window.history.replaceState({}, "", hash);
  window.dispatchEvent(new window.HashChangeEvent("hashchange", {
    oldURL: before,
    newURL: window.location.href
  }));
  await flush();
};

describe("the Trash panel appears only when the door opened it", () => {
  test("an ordinary mailbox load shows the pill and no panel", async () => {
    await boot();
    expect(q(".pill")).not.toBeNull();
    expect(text()).not.toContain(TRASH_TITLE);
  });

  test("sitting in Trash without the mark says nothing", async () => {
    // Somebody who clicked Gmail's own Trash link is not somebody this
    // extension sent, and it has no standing to interrupt them.
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    await boot();
    expect(text()).not.toContain(TRASH_TITLE);
  });

  test("the mark plus Trash shows the panel, with the irreversible part in it", async () => {
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    await boot({ trashHint: true });
    expect(text()).toContain(TRASH_TITLE);
    expect(text()).toContain(TRASH_WARN);
    expect(text()).toContain(CATALOG.launcherTrashAuto.message);
  });

  test("the mark alone, on the inbox, shows nothing", async () => {
    await boot({ trashHint: true });
    expect(text()).not.toContain(TRASH_TITLE);
  });

  test("a mark that arrives a beat before the navigation still lands", async () => {
    // Navigating Gmail to Trash is a hash change, so the storage write
    // that carries the mark can beat the hash by a tick.
    await boot({ trashHint: true });
    expect(text()).not.toContain(TRASH_TITLE);
    await goTo("/mail/u/0/#trash");
    expect(text()).toContain(TRASH_TITLE);
  });

  test("a greeting wins when both are somehow pending", async () => {
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    await boot({ trashHint: true, greet: true });
    expect(text()).toContain(CATALOG.launcherGreetTitle.message);
    expect(text()).not.toContain(TRASH_TITLE);
  });

  test("navigating away dismisses it", async () => {
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    await boot({ trashHint: true });
    expect(text()).toContain(TRASH_TITLE);
    await goTo("/mail/u/0/#inbox");
    expect(text()).not.toContain(TRASH_TITLE);
    expect(q(".pill")).not.toBeNull();
  });

  test("staying inside Trash does not dismiss it", async () => {
    // #trash/p2 and an opened thread are still Trash.
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    await boot({ trashHint: true });
    await goTo("/mail/u/0/#trash/p2");
    expect(text()).toContain(TRASH_TITLE);
  });

  test("dismissing it does not leave it waiting to reopen", async () => {
    // The mark was spent in the worker, so reopening the pill must not
    // replay a panel about a door walked through some time ago.
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    await boot({ trashHint: true });
    q(".ghost").click();
    await flush();
    expect(text()).not.toContain(TRASH_TITLE);
    q(".pill").click();
    await flush();
    expect(text()).not.toContain(TRASH_TITLE);
    expect(text()).toContain(CATALOG.launcherIdleTitle.message);
  });

  test("a mark that never meets a navigation gives up rather than waiting", async () => {
    jest.useFakeTimers();
    try {
      await boot({ trashHint: true });
      jest.advanceTimersByTime(20000);
      await goTo("/mail/u/0/#trash");
      expect(text()).not.toContain(TRASH_TITLE);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a tab already open hears about the mark through the storage change", async () => {
    // The only channel there is: navigating to #trash never re-runs a
    // content script, so a mailbox that was already open would otherwise
    // never learn the door had been used.
    await boot();
    expect(typeof storageListener).toBe("function");
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    answers.gmailCleanerLauncherState = {
      ok: true, show: true, greet: false, busy: false, report: null, trashHint: true
    };
    await storageListener({ gmailLauncher: { newValue: {} } }, "local");
    await flush();
    expect(text()).toContain(TRASH_TITLE);
  });

  test("a storage change that is not the launcher record is ignored", async () => {
    await boot();
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    answers.gmailCleanerLauncherState = {
      ok: true, show: true, greet: false, busy: false, report: null, trashHint: true
    };
    await storageListener({ cleanupStats: { newValue: {} } }, "local");
    await flush();
    expect(text()).not.toContain(TRASH_TITLE);
  });

  test("the panel starts nothing and asks the worker for nothing", async () => {
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    await boot({ trashHint: true });
    // One message: the state ask that boot always makes. No scan, no
    // run, no second round trip.
    expect(sent.map((m) => m.type)).toEqual(["gmailCleanerLauncherState"]);
  });

  test("it puts no node and no listener on Gmail's own page", async () => {
    window.history.replaceState({}, "", "/mail/u/0/#trash");
    await boot({ trashHint: true });
    // Everything it draws is inside the closed root, which is one host
    // node under body and nothing else.
    expect(document.body.children).toHaveLength(1);
    expect(document.body.firstElementChild.id).toBe(HOST_ID);
    expect(document.body.firstElementChild.shadowRoot).toBeNull();
  });
});
