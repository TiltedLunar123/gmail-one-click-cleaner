/**
 * @jest-environment jsdom
 *
 * Bulk unsubscribe reliability (8.5.1).
 *
 * Reported from real use: "I can literally see it able to do it, then it
 * just doesn't work", with a row reading "No 1-click option".
 *
 * That chip is status `no_button`, and `no_button` is not what it
 * sounded like. It does not mean the sender declined to offer one-click
 * unsubscribe. It means the engine looked for Gmail's control and did
 * not find one, and it looked exactly once, 300ms after the
 * conversation opened, with no retry. Every other control this engine
 * drives is found with a waitFor and a multi-second budget. Gmail
 * renders the header Unsubscribe link only after it has processed the
 * message's List-Unsubscribe header, which is routinely later than
 * 300ms, so the engine lost a race it never knew it was running and
 * then blamed the sender for it in the UI.
 *
 * Three properties are pinned here, in the order they matter:
 *
 *   1. the control is WAITED for, so a link that appears late is still
 *      found and clicked
 *   2. a confirm that Gmail never acknowledges is not reported as done,
 *      because that is the one failure the user cannot detect
 *   3. the search does not depend on a single Gmail class surviving
 *      forever, but still refuses to click anything the sender wrote
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function loadEngine(config = {}) {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = config;
  window.alert = () => {};
  document.body.innerHTML = "";
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

/** An open conversation with no unsubscribe control in it yet. */
const openConversation = (extra = "") => {
  document.body.innerHTML = `
    <div role="main">
      <h2 class="hP">Some subject</h2>
      <div class="ha"><span class="gD" email="news@brand.com">Brand</span></div>
      <div id="hdr"></div>
      <div class="a3s">
        Message body. <a href="https://brand.example/optout">Unsubscribe</a>
      </div>
      ${extra}
    </div>`;
};

/** Gmail's own header control, as it renders today. */
const CONTROL_HTML = '<span class="Ca" role="link">Unsubscribe</span>';

/** A dialog that closes when its confirm is clicked, the way Gmail's does. */
const confirmingDialog = () => {
  const dlg = showConfirmDialog();
  for (const btn of dlg.querySelectorAll("button")) {
    if (btn.textContent === "Unsubscribe") {
      btn.addEventListener("mouseup", () => setTimeout(() => dlg.remove(), 10));
    }
  }
  return dlg;
};

/** The confirm dialog Gmail raises for a one-click sender. */
const showConfirmDialog = () => {
  const dlg = document.createElement("div");
  dlg.setAttribute("role", "alertdialog");
  dlg.innerHTML = '<button>Cancel</button><button>Unsubscribe</button>';
  document.body.appendChild(dlg);
  return dlg;
};

// jsdom keeps ONE window for the whole file, so a document-level
// listener registered by one test is still live in the next one and
// fires for it too. Clearing document.body does not remove it. Every
// listener here is registered against a per-test signal and aborted in
// afterEach, which is what keeps the second test from seeing the first
// test's dialog.
let listeners;

beforeEach(() => {
  listeners = new AbortController();
});

/** Run fn when Gmail's header control is clicked, for THIS test only. */
const onControlClick = (fn) => {
  document.addEventListener("mouseup", (e) => {
    if (e.target.classList?.contains("Ca")) fn();
  }, { signal: listeners.signal });
};

afterEach(() => {
  listeners.abort();
  jest.useRealTimers();
  document.body.innerHTML = "";
});

describe("the control is waited for, not probed once", () => {
  test("a control that appears late is still found and clicked", async () => {
    const I = loadEngine();
    openConversation();

    // Gmail paints the header control after the conversation is already
    // open. 900ms is well past the old 300ms settle and well inside the
    // new budget.
    setTimeout(() => {
      document.getElementById("hdr").innerHTML = CONTROL_HTML;
    }, 900);
    // ...and raises its dialog once that control is clicked.
    onControlClick(() => setTimeout(confirmingDialog, 20));

    const result = await I.unsubscribeCurrentMessage();
    expect(result.status).toBe("unsubscribed");
  }, 20000);

  test("the budget is a real one, not a token retry", () => {
    // 300ms was the old effective budget and it is what lost the race.
    expect(I_SUBS().UNSUB_CONTROL_TIMEOUT).toBeGreaterThanOrEqual(3000);
  });

  test("a control that never appears still ends, and says so", async () => {
    const I = loadEngine();
    openConversation();
    const result = await I.unsubscribeCurrentMessage();
    // Nothing in the header, and the anchor in the body does not count.
    expect(result.status).toBe("no_button");
  }, 20000);
});

describe("a confirm Gmail never acknowledges is not success", () => {
  test("a dialog that stays open reports unconfirmed, not unsubscribed", async () => {
    const I = loadEngine();
    openConversation(CONTROL_HTML);
    // The dialog opens and then simply never closes, which is what a
    // click that did not take looks like from outside.
    onControlClick(showConfirmDialog);

    const result = await I.unsubscribeCurrentMessage();
    expect(result.status).toBe("not_confirmed");
    expect(result.status).not.toBe("unsubscribed");
  }, 20000);

  test("a dialog that closes reports unsubscribed", async () => {
    const I = loadEngine();
    openConversation(CONTROL_HTML);
    onControlClick(confirmingDialog);

    const result = await I.unsubscribeCurrentMessage();
    expect(result.status).toBe("unsubscribed");
  }, 20000);
});

describe("finding the control does not rest on one Gmail class", () => {
  test("class Ca with role=link is found", () => {
    const I = loadEngine();
    openConversation(CONTROL_HTML);
    expect(I.findHeaderUnsubscribeControl()).not.toBeNull();
  });

  test("role=link without the class is found", () => {
    const I = loadEngine();
    openConversation('<span role="link">Unsubscribe</span>');
    expect(I.findHeaderUnsubscribeControl()).not.toBeNull();
  });

  test("neither class nor role is still found", () => {
    // The rot case. Two of the three passes are betting on Gmail's
    // current markup; this is the one that is not.
    const I = loadEngine();
    openConversation('<span class="whatever">Unsubscribe</span>');
    const found = I.findHeaderUnsubscribeControl();
    expect(found).not.toBeNull();
    expect(found.textContent.trim()).toBe("Unsubscribe");
  });

  test("the innermost match wins, not a wrapper around it", () => {
    const I = loadEngine();
    openConversation('<div class="outer"><span class="inner">Unsubscribe</span></div>');
    const found = I.findHeaderUnsubscribeControl();
    expect(found.className).toBe("inner");
  });
});

describe("what it still refuses to click", () => {
  test("the sender's own link in the message body", () => {
    // openConversation always plants one. Every case above that expects
    // null is also asserting this.
    const I = loadEngine();
    openConversation();
    expect(I.findHeaderUnsubscribeControl()).toBeNull();
    expect(document.querySelector(".a3s a")).not.toBeNull();
  });

  test("an anchor anywhere, even outside the body", () => {
    // Gmail's control fires a List-Unsubscribe request in place. A real
    // <a href> is the sender's, and following one navigates the tab to
    // a third party in the middle of a run.
    const I = loadEngine();
    openConversation('<a href="https://brand.example/out">Unsubscribe</a>');
    expect(I.findHeaderUnsubscribeControl()).toBeNull();
  });

  test("markup nested inside an anchor", () => {
    const I = loadEngine();
    openConversation('<a href="https://brand.example/out"><span>Unsubscribe</span></a>');
    expect(I.findHeaderUnsubscribeControl()).toBeNull();
  });

  test("a control inside a list row, which is the inbox not a message", () => {
    const I = loadEngine();
    openConversation('<table><tr role="row"><td><span role="link">Unsubscribe</span></td></tr></table>');
    expect(I.findHeaderUnsubscribeControl()).toBeNull();
  });
});

describe("the labels describe what actually happened", () => {
  const popupSrc = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf-8");

  const LOCALES = ["en", "pt_BR", "es", "fr", "de", "ru", "ja"];
  const catalog = (l) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "_locales", l, "messages.json"), "utf8"));

  test("no_button no longer blames the sender for our miss", () => {
    // "No 1-click option" reads as "this sender does not offer one".
    // The code sets it when it could not find Gmail's control.
    expect(popupSrc).toContain('no_button: { text: t("subsStatusNoButton", "No unsubscribe link")');
    // The CATALOGUE is what actually renders: it overrides the inline
    // fallback, so changing only popup.js changed nothing a user would
    // ever see. That is exactly how this label survived being wrong.
    for (const l of LOCALES) {
      expect(catalog(l).subsStatusNoButton.message).not.toMatch(/1-click|1 clic|クリック/i);
    }
    expect(catalog("en").subsStatusNoButton.message).toBe("No unsubscribe link");
  });

  test("manual says what the user has to do", () => {
    expect(popupSrc).toContain('manual: { text: t("subsStatusManual", "Needs their website")');
    expect(catalog("en").subsStatusManual.message).toBe("Needs their website");
    for (const l of LOCALES) {
      expect(catalog(l).subsStatusManual.message.length).toBeGreaterThan(0);
    }
  });

  test("an unconfirmed confirm has a chip at all", () => {
    // Without this the status falls through SUBS_STATUS_LABELS and the
    // row silently renders its email count instead of a warning.
    expect(popupSrc).toContain("not_confirmed:");
  });
});

/** SUBSCRIPTIONS constants without booting a second engine. */
function I_SUBS() {
  const at = SRC.indexOf("UNSUB_CONTROL_TIMEOUT:");
  expect(at).toBeGreaterThan(-1);
  return { UNSUB_CONTROL_TIMEOUT: Number(SRC.slice(at).match(/UNSUB_CONTROL_TIMEOUT:\s*(\d+)/)[1]) };
}
