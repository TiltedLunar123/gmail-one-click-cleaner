/**
 * @jest-environment jsdom
 *
 * 9.7: the Diagnostics page called a Chat tab a Gmail tab.
 *
 * Its tab scan listed every mail.google.com tab, chose the active one as
 * "the tab the popup would use", and Test Inject probed that tab. With
 * Chat in front the page reported detection OK on a tab the cleaner
 * refuses to run in, which is the opposite of what a diagnostics page is
 * for. The popup has drawn the mailbox line with GCC.isMailboxUrl since
 * 9.0; this page kept a host-only check of its own.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHARED = fs.readFileSync(path.join(ROOT, "shared.js"), "utf-8");
const DIAG_JS = fs.readFileSync(path.join(ROOT, "diagnostics.js"), "utf-8");
const DIAG_HTML = fs.readFileSync(path.join(ROOT, "diagnostics.html"), "utf-8");

const bodyOf = (html) => {
  const start = html.indexOf("<body");
  const open = html.indexOf(">", start) + 1;
  const end = html.lastIndexOf("</body>");
  return html.slice(open, end);
};

const CHAT = { id: 5, url: "https://mail.google.com/chat/u/0/#chat/home", active: true, windowId: 1 };
const MAILBOX = { id: 10, url: "https://mail.google.com/mail/u/0/#inbox", active: false, windowId: 1 };

let tabs = [];

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// diagnostics.js reaches the tab and scripting APIs through
// GCC.promisify, which passes a callback and waits for it. A
// promise-only stub never calls that callback and the scan hangs on
// its first query. See tests/setup.js on the same point for storage.
const dual = (impl) => jest.fn((...args) => {
  const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
  const result = Promise.resolve().then(() => impl(...args));
  if (!cb) return result;
  result.then(cb, () => cb(undefined));
  return undefined;
});

const loadPage = async () => {
  document.body.innerHTML = bodyOf(DIAG_HTML);
  // eslint-disable-next-line no-new-func
  global.GCC = new Function(SHARED + "\nreturn GCC;")();
  window.GCC = global.GCC;
  // eslint-disable-next-line no-new-func
  new Function(DIAG_JS)();
  await settle(150);
};

beforeEach(() => {
  __resetChromeStorage();
  chrome.runtime.sendMessage = jest.fn((msg, cb) => {
    if (typeof cb === "function") cb({ ok: true, version: "test" });
  });
  chrome.runtime.onMessage = { addListener: jest.fn() };
  chrome.runtime.getManifest = jest.fn(() => ({ name: "Gmail One-Click Cleaner", version: "test", permissions: [], host_permissions: [] }));
  chrome.tabs.query = dual((info) => {
    let out = tabs.map((t) => ({ ...t }));
    if (info?.active) out = out.filter((t) => t.active);
    return out;
  });
  chrome.scripting.executeScript = dual(() => [{ result: { origin: "x", path: "/", time: "t", attached: false } }]);
});

describe("Scan tabs", () => {
  test("names the mailbox tab as the one the popup would use, not the Chat tab in front", async () => {
    tabs = [CHAT, MAILBOX];
    await loadPage();
    document.getElementById("scanTabsBtn").click();
    await settle(150);
    expect(document.getElementById("chosenTabTextInline").textContent).toBe(String(MAILBOX.id));
    expect(document.getElementById("chosenTabText").textContent).toContain(`Tab ${MAILBOX.id}`);
  });

  test("with only a Chat tab open, says there is no Gmail tab rather than choosing Chat", async () => {
    tabs = [CHAT];
    await loadPage();
    document.getElementById("scanTabsBtn").click();
    await settle(150);
    expect(document.getElementById("chosenTabTextInline").textContent).toBe("none");
    expect(document.getElementById("gmailTabCount").textContent).toBe("0");
  });
});

describe("Test Inject", () => {
  test("probes the mailbox tab, never the Chat tab", async () => {
    tabs = [CHAT, MAILBOX];
    await loadPage();
    document.getElementById("testInjectBtn").click();
    await settle(150);
    const targets = chrome.scripting.executeScript.mock.calls.map(([d]) => d.target.tabId);
    expect(targets).toEqual([MAILBOX.id]);
  });
});
