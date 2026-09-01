/**
 * 9.4: the popup's progress listener threw the sender away.
 *
 * chrome.runtime.onMessage hands a listener (message, sender), and this
 * one took only the message. A progress message carries a runKind and no
 * account, so with two Gmail accounts signed in, a scan running in the
 * other tab ended this popup's spinner and rendered its counts into a
 * popup pointed at a different mailbox. The README states the opposite
 * as a feature: a report is only shown back in the mailbox it was
 * measured in.
 *
 * The rule is narrow on purpose. It refuses a message only when this
 * popup started something and the message came from somewhere else.
 * When the in-Gmail launcher started the scan the popup has no
 * expectation, and those messages have to keep arriving.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const POPUP = fs.readFileSync(path.join(ROOT, "popup.js"), "utf-8");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const bodyOf = (src, start, end) => {
  const clean = stripComments(src);
  const a = clean.indexOf(start);
  if (a === -1) return "";
  const b = clean.indexOf(end, a + start.length);
  return b > a ? clean.slice(a, b) : "";
};

describe("the listener knows which mailbox a message came from", () => {
  test("it takes the sender argument at all", () => {
    // The whole defect in one line: onMessage.addListener((msg) => {
    expect(POPUP).not.toMatch(/chrome\.runtime\.onMessage\.addListener\(\(msg\)\s*=>/);
    expect(POPUP).toMatch(/chrome\.runtime\.onMessage\.addListener\(\(msg, sender\)\s*=>/);
  });

  test("a runKind message from another tab is dropped before any handler", () => {
    const listener = bodyOf(
      POPUP,
      "chrome.runtime.onMessage.addListener((msg, sender) => {",
      "handleXrayProgress"
    );
    expect(listener).not.toBe("");
    expect(listener).toMatch(/sender\?\.tab\?\.id/);
    expect(listener).toMatch(/state\.auxRunTabId/);
    // The refusal has to come before the dispatch, not after it.
    const refuseAt = listener.indexOf("auxRunTabId !== null");
    const dispatchAt = listener.indexOf('msg.runKind === "storageScan"');
    expect(refuseAt).toBeGreaterThan(-1);
    if (dispatchAt > -1) expect(refuseAt).toBeLessThan(dispatchAt);
  });

  test("a launcher-started run, which this popup did not inject, is still watched", () => {
    const listener = bodyOf(
      POPUP,
      "chrome.runtime.onMessage.addListener((msg, sender) => {",
      "handleXrayProgress"
    );
    // Null means no expectation. Refusing on null would silently break
    // the in-Gmail launcher's whole reason for existing.
    expect(listener).toMatch(/state\.auxRunTabId !== null/);
  });

  test("the expectation is recorded where every auxiliary run starts", () => {
    const inject = bodyOf(POPUP, "const injectEngineRun = async (config, setStatusFn) => {", "const injectSubscriptionRun");
    expect(inject).toMatch(/state\.auxRunTabId = gmailTab\.id/);
  });

  test("and it is cleared when that run ends, so the next one is not refused", () => {
    const listener = bodyOf(
      POPUP,
      "chrome.runtime.onMessage.addListener((msg, sender) => {",
      "handleXrayProgress"
    );
    expect(listener).toMatch(/state\.auxRunTabId = null/);
  });

  test("the state field exists with a null default", () => {
    expect(POPUP).toMatch(/auxRunTabId:\s*null/);
  });
});

describe("the promise this enforces is still in the README", () => {
  test("a report is only shown back in the mailbox it was measured in", () => {
    const flat = README.replace(/\s+/g, " ");
    expect(flat).toContain("a report is only shown back in the mailbox it was measured in");
  });
});
