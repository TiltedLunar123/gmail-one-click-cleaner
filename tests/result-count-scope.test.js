/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * Where the result counter actually lives (8.3).
 *
 * estimateTotalResults only ever searched div[role="main"]. Gmail renders
 * "1-50 of 1,234" in the TOOLBAR, which sits outside that element, so on
 * a real result page the total was never found and every caller fell back
 * to getGridRowCount(): one page, fifty rows.
 *
 * The visible damage: the Mailbox Report showed 50 against band after
 * band on a mailbox holding tens of thousands of messages, so the plan
 * understated the work by orders of magnitude, and the guardrails that
 * size a run were reading a page instead of a match set.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function load() {
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = { runKind: "cleanup", dryRun: true };
  window.alert = () => {};
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

const rows = (n) =>
  Array.from({ length: n }, (_, i) => `<tr role="row" id="r${i}"><td class="yX"></td></tr>`).join("");

beforeEach(() => {
  document.body.innerHTML = "";
  chrome.runtime.sendMessage = jest.fn();
  chrome.runtime.onMessage = { addListener: jest.fn() };
});

describe("the counter is found wherever Gmail puts it", () => {
  test("in the toolbar, outside div[role=main], which is where it really is", () => {
    document.body.innerHTML = `
      <div gh="mtb"><div><span>1-50 of 12,438</span></div></div>
      <div role="main"><table role="grid">${rows(50)}</table></div>`;
    const I = load();
    // The bug: this returned null, and callers used 50.
    expect(I.estimateTotalResults()).toBe(12438);
  });

  test("inside main, when Gmail puts it there", () => {
    document.body.innerHTML = `
      <div role="main"><span>1-50 of 987</span><table role="grid">${rows(50)}</table></div>`;
    const I = load();
    expect(I.estimateTotalResults()).toBe(987);
  });

  test("anywhere else in the document as a last resort", () => {
    document.body.innerHTML = `
      <div id="elsewhere"><span>1-50 of 640</span></div>
      <div role="main"><table role="grid">${rows(50)}</table></div>`;
    const I = load();
    expect(I.estimateTotalResults()).toBe(640);
  });

  test("a page with no counter at all still reports nothing rather than guessing", () => {
    document.body.innerHTML = `<div role="main"><table role="grid">${rows(50)}</table></div>`;
    const I = load();
    expect(I.estimateTotalResults()).toBeNull();
  });
});

describe("widening the search cannot invent a number", () => {
  test("a long ancestor whose text merely contains 'of' is refused", () => {
    // The scope widening is only safe because every branch is now length
    // guarded. Without that, a container this size would match the
    // "of <digits>" branch and return a total that means nothing.
    document.body.innerHTML = `
      <div gh="mtb"><div>Showing conversations from a selection of 3 different labels and 42 senders in this view right now</div></div>
      <div role="main"><table role="grid">${rows(50)}</table></div>`;
    const I = load();
    expect(I.estimateTotalResults()).toBeNull();
  });

  test("the counter still wins when it sits beside noisy text", () => {
    document.body.innerHTML = `
      <div gh="mtb">
        <div>Showing conversations from a selection of 3 different labels and 42 senders in this view</div>
        <div><span>1-50 of 7,001</span></div>
      </div>
      <div role="main"><table role="grid">${rows(50)}</table></div>`;
    const I = load();
    expect(I.estimateTotalResults()).toBe(7001);
  });
});
