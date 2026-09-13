/**
 * @jest-environment jsdom
 *
 * 9.7: the Stats page acted on whichever mail.google.com tab was in
 * front, and did not know which mailbox a run had come from.
 *
 * 9.0 converted the popup's tab picker to GCC.isMailboxUrl because
 * `https://mail.google.com/*` matches Google Chat, and 9.2 through 9.6
 * taught every run surface to stay in the account it was measured in.
 * stats.js kept its 7.6 picker: any mail.google.com tab, active first.
 * Two things followed.
 *
 *   - Restore with Chat in front injected into the Chat tab. The engine
 *     refuses there, and until this release it refused silently, so the
 *     page sat on "Starting restore..." with the button reading Cancel.
 *   - Restore with two accounts signed in injected into whichever
 *     mailbox was active, searched account 0 for a label that lives in
 *     account 1, and said "Nothing left to restore" about mail that was
 *     sitting in the other Trash. The Find in Gmail link and Open Trash
 *     hardcoded /u/0/ for the same reason.
 *
 * Driven end to end: the real stats.html, the real stats.js, a click on
 * the real Restore button, and the tab the engine is injected into is
 * what is asserted.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHARED = fs.readFileSync(path.join(ROOT, "shared.js"), "utf-8");
const STATS_JS = fs.readFileSync(path.join(ROOT, "stats.js"), "utf-8");
const STATS_HTML = fs.readFileSync(path.join(ROOT, "stats.html"), "utf-8");

const bodyOf = (html) => {
  const start = html.indexOf("<body");
  const open = html.indexOf(">", start) + 1;
  const end = html.lastIndexOf("</body>");
  return html.slice(open, end);
};

const CHAT = { id: 5, url: "https://mail.google.com/chat/u/0/#chat/home", active: true, windowId: 1 };
const MAILBOX_0 = { id: 10, url: "https://mail.google.com/mail/u/0/#inbox", active: false, windowId: 1 };
const MAILBOX_1 = { id: 11, url: "https://mail.google.com/mail/u/1/#inbox", active: false, windowId: 1 };

const entry = (extra = {}) => ({
  id: "u1",
  runId: "run-1",
  timestamp: Date.now() - 60000,
  query: "category:promotions older_than:6m",
  label: "Promotions",
  count: 40,
  action: "delete",
  tagLabel: "GmailCleaner - Promotions",
  taggingFailed: false,
  ...extra
});

let tabs = [];
let undoLog = [];

const settle = async (ms = 60) => {
  await new Promise((r) => setTimeout(r, ms));
};

// stats.js reaches every tab API through GCC.promisify, which passes a
// callback and waits for it. A promise-only stub never calls that
// callback, so the page hangs on its first tab query and the suite
// reads as "no Restore button" rather than as a stub shape. Same
// lesson tests/setup.js records for storage: answer both ways.
const dual = (impl) => jest.fn((...args) => {
  const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
  const result = Promise.resolve().then(() => impl(...args));
  if (!cb) return result;
  result.then(cb, () => cb(undefined));
  return undefined;
});

const loadPage = async () => {
  document.body.innerHTML = bodyOf(STATS_HTML);
  // eslint-disable-next-line no-new-func
  global.GCC = new Function(SHARED + "\nreturn GCC;")();
  window.GCC = global.GCC;
  // eslint-disable-next-line no-new-func
  new Function(STATS_JS)();
  await settle(120);
};

beforeEach(() => {
  tabs = [];
  undoLog = [];
  __resetChromeStorage();
  chrome.runtime.sendMessage = jest.fn((msg, cb) => {
    const answer = msg?.type === "gmailCleanerGetUndoLog"
      ? { ok: true, log: undoLog }
      : msg?.type === "gmailCleanerGetStats"
        ? { ok: true, stats: { totalRuns: 1, totalDeleted: 40, totalArchived: 0, totalFreedMb: 1, history: [], categoryBreakdown: {}, dailyStats: {}, topSenders: [] } }
        : { ok: true };
    if (typeof cb === "function") cb(answer);
    return undefined;
  });
  chrome.runtime.onMessage = { addListener: jest.fn() };
  chrome.tabs.query = dual(() => tabs.map((t) => ({ ...t })));
  chrome.tabs.get = dual((id) => {
    const t = tabs.find((x) => x.id === id);
    return t ? { ...t, status: "complete" } : undefined;
  });
  chrome.tabs.update = dual((id, props) => ({ id, ...props }));
  // No mailbox may be opened by these tests: a picker that finds nothing
  // must say so, not fall through to Chat.
  chrome.tabs.create = dual(() => null);
  chrome.windows = { update: dual(() => ({})) };
  chrome.scripting.executeScript = dual((details) => {
    // The attach probe answers "not attached" so the injection proceeds.
    if (typeof details?.func === "function" && !details.args) return [{ result: false }];
    return [];
  });
});

const injectedTabIds = () =>
  chrome.scripting.executeScript.mock.calls
    .filter(([d]) => Array.isArray(d?.files))
    .map(([d]) => d.target.tabId);

const clickRestore = async () => {
  const btn = document.querySelector("#undoList .undo-restore-btn:not([disabled])");
  expect(btn).not.toBeNull();
  btn.click();
  await settle(150);
};

describe("Restore injects into the mailbox the run came from", () => {
  test("a Chat tab in front is not a mailbox, so the run goes to the mailbox tab", async () => {
    tabs = [CHAT, MAILBOX_0];
    undoLog = [entry({ account: "0" })];
    await loadPage();
    await clickRestore();
    expect(injectedTabIds()).toEqual([MAILBOX_0.id]);
  });

  test("with only a Chat tab open, nothing is injected into it", async () => {
    tabs = [CHAT];
    undoLog = [entry({ account: "0" })];
    await loadPage();
    await clickRestore();
    expect(injectedTabIds()).toEqual([]);
    // It reached for a mailbox rather than settling for Chat.
    expect(chrome.tabs.create).toHaveBeenCalled();
  });

  test("a run recorded in account 1 is restored in account 1, not in the active account 0", async () => {
    tabs = [{ ...MAILBOX_0, active: true }, MAILBOX_1];
    undoLog = [entry({ account: "1" })];
    await loadPage();
    await clickRestore();
    expect(injectedTabIds()).toEqual([MAILBOX_1.id]);
  });

  test("an entry with no recorded account keeps the old behaviour: the active mailbox", async () => {
    tabs = [MAILBOX_0, { ...MAILBOX_1, active: true }];
    undoLog = [entry()];
    await loadPage();
    await clickRestore();
    expect(injectedTabIds()).toEqual([MAILBOX_1.id]);
  });

  test("the account for the run is not open, so a new mailbox is opened there rather than a wrong one used", async () => {
    tabs = [{ ...MAILBOX_0, active: true }];
    undoLog = [entry({ account: "1" })];
    await loadPage();
    await clickRestore();
    expect(injectedTabIds()).toEqual([]);
    // The first argument: the call also carries promisify's callback.
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      url: expect.stringContaining("/mail/u/1/")
    }));
  });
});

describe("the links beside the entry point at the same mailbox", () => {
  test("Find in Gmail carries the entry's account", async () => {
    tabs = [MAILBOX_0];
    undoLog = [entry({ account: "1" })];
    await loadPage();
    const link = document.querySelector("#undoList a.btn");
    expect(link).not.toBeNull();
    expect(link.href).toContain("/mail/u/1/#search/");
    expect(link.href).toContain(encodeURIComponent('label:"GmailCleaner - Promotions"'));
  });

  test("an entry with no recorded account links to the default mailbox as before", async () => {
    tabs = [MAILBOX_0];
    undoLog = [entry()];
    await loadPage();
    const link = document.querySelector("#undoList a.btn");
    expect(link.href).toContain("/mail/u/0/#search/");
  });
});

describe("Open Trash from the Stats page", () => {
  test("navigates a mailbox tab, never the Chat tab in front", async () => {
    tabs = [CHAT, MAILBOX_0];
    undoLog = [entry({ account: "0" })];
    await loadPage();
    const btn = document.getElementById("statsTrashBtn");
    expect(btn).not.toBeNull();
    btn.click();
    await settle(120);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update.mock.calls[0][0]).toBe(MAILBOX_0.id);
    expect(chrome.tabs.update.mock.calls[0][1].url).toBe("https://mail.google.com/mail/u/0/#trash");
  });
});
