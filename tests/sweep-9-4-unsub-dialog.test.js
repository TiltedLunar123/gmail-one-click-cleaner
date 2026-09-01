/**
 * @jest-environment jsdom
 *
 * 9.4: the confirmation half of the unsubscribe flow trusted markup the
 * control half spends three passes refusing.
 *
 * findHeaderUnsubscribeControl scopes itself to the list root, skips
 * anything inside div.a3s, skips anything inside a list row, and refuses
 * anchors outright, because "a real <a href> in a message is the
 * SENDER's link, and following one navigates the tab to a third party
 * mid-run". Those guards protect the FIRST click. The dialog lookup that
 * follows was a bare document-wide query for div[role='alertdialog'],
 * and resolveUnsubscribeDialog matched any button-ish descendant by
 * label alone, so a sender who puts
 *
 *     <div role="alertdialog"><a role="button" href="...">Unsubscribe</a></div>
 *
 * in their own message body got that anchor clicked, in the user's
 * authenticated Gmail tab, with no click from the user. SECURITY.md
 * promises the opposite in as many words.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");
const SECURITY = fs.readFileSync(path.join(__dirname, "..", "SECURITY.md"), "utf-8");

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

// Gmail's own confirmation: a dialog appended to <body>, its confirm
// control a real button, outside every message body.
const REAL_DIALOG = `
  <div role="alertdialog">
    <button type="button">Unsubscribe</button>
    <button type="button">Cancel</button>
  </div>`;

// The same shape, planted by the sender inside the message body Gmail
// renders. div.a3s is SELECTORS.messageBody.
const HOSTILE_BODY = `
  <div role="main">
    <div class="a3s">
      <div role="alertdialog">
        <a role="button" href="https://attacker.example/track?u=victim">Unsubscribe</a>
      </div>
    </div>
  </div>`;

describe("the dialog lookup refuses the sender's own markup", () => {
  test("the guards it has to match are still the ones on the control half", () => {
    // If these move, the fix below has to move with them.
    expect(SRC).toContain('messageBody: "div.a3s"');
    expect(SRC).toContain("\"div[role='alertdialog']\"");
  });

  test("a dialog planted in a message body is not found", () => {
    const I = loadEngine();
    expect(typeof I.findConfirmDialog).toBe("function");
    document.body.innerHTML = HOSTILE_BODY;
    expect(I.findConfirmDialog()).toBeNull();
  });

  test("a dialog inside a list row is not found either", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><table role="grid"><tr role="row">
        <td role="gridcell">
          <div role="alertdialog"><button type="button">Unsubscribe</button></div>
        </td>
      </tr></table></div>`;
    expect(I.findConfirmDialog()).toBeNull();
  });

  test("Gmail's real dialog is still found, including when a hostile one is also present", () => {
    const I = loadEngine();
    document.body.innerHTML = HOSTILE_BODY + REAL_DIALOG;
    const dlg = I.findConfirmDialog();
    expect(dlg).not.toBeNull();
    // The sender's copy comes first in document order, so "the first
    // match" is exactly the wrong answer and the reason this is a bug.
    expect(dlg.closest(".a3s")).toBeNull();
    expect(dlg.querySelector("a")).toBeNull();
  });
});

describe("resolveUnsubscribeDialog refuses a link even inside a real dialog", () => {
  test("an anchor is never returned as the confirm button", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="alertdialog" id="d">
        <a role="button" href="https://attacker.example/">Unsubscribe</a>
      </div>`;
    const out = I.resolveUnsubscribeDialog(document.getElementById("d"));
    expect(out.confirmBtn).toBeNull();
    expect(out.kind).not.toBe("confirm");
  });

  test("a control wrapped in an anchor is refused too", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="alertdialog" id="d">
        <a href="https://attacker.example/"><span role="button">Unsubscribe</span></a>
      </div>`;
    const out = I.resolveUnsubscribeDialog(document.getElementById("d"));
    expect(out.confirmBtn).toBeNull();
  });

  test("a control inside a message body is refused", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="alertdialog" id="d">
        <div class="a3s"><button type="button">Unsubscribe</button></div>
      </div>`;
    const out = I.resolveUnsubscribeDialog(document.getElementById("d"));
    expect(out.confirmBtn).toBeNull();
  });

  test("Gmail's real button still resolves", () => {
    const I = loadEngine();
    document.body.innerHTML = `<div role="alertdialog" id="d">${REAL_DIALOG}</div>`;
    const out = I.resolveUnsubscribeDialog(document.getElementById("d"));
    expect(out.confirmBtn).not.toBeNull();
    expect(out.confirmBtn.tagName).toBe("BUTTON");
    expect(out.kind).toBe("confirm");
    expect(out.cancelBtn).not.toBeNull();
  });
});

describe("the bulk-delete confirmation has the same lookup and the same guard", () => {
  // handleBulkConfirmation ran the identical unscoped document-wide
  // query. It is a different click with a worse blast radius: the
  // control it looks for confirms a whole-result-set delete.
  test("the bulk confirm dialog search excludes sender markup", () => {
    const at = SRC.indexOf("async function handleBulkConfirmation()");
    expect(at).toBeGreaterThan(-1);
    const fn = SRC.slice(at, at + 2500).replace(/\/\/[^\n]*/g, " ").replace(/\s+/g, " ");
    // Pin the relationship, not the literal: the selector stays, what
    // matters is that its result is filtered before anything is clicked.
    expect(fn).toMatch(
      /qsa\("div\[role='alertdialog'\], div\[role='dialog'\]"\)\s*\.filter\(.{0,40}?isSenderMarkup/
    );
  });

  test("findBulkConfirmButton refuses an anchor", () => {
    const I = loadEngine();
    expect(typeof I.findBulkConfirmButton).toBe("function");
    document.body.innerHTML = `
      <div role="alertdialog" id="d">
        <a role="button" href="https://attacker.example/">OK</a>
      </div>`;
    expect(I.findBulkConfirmButton(document.getElementById("d"))).toBeNull();
  });
});

describe("SECURITY.md still makes the promise this enforces", () => {
  test("the never-follow-body-links sentence is there", () => {
    // Flattened: the sentence is wrapped in the file, and a pin on where
    // the author happened to break the line is not a pin on the claim.
    const flat = SECURITY.toLowerCase().replace(/\s+/g, " ");
    expect(flat).toContain("never follows unsubscribe links inside message bodies");
  });
});
