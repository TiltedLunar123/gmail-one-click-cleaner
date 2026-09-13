/**
 * @jest-environment jsdom
 *
 * 9.7: the engine's refusal to run outside a mailbox was an alert and a
 * return, and nothing else.
 *
 * Every run kind opens with `if (!isGmailTab())`, which 8.21 added so a
 * Chat tab is refused rather than navigated. The refusal raised a native
 * alert in that tab and returned. No progress message. For the eight
 * auxiliary kinds that is a page waiting forever: the Stats page on
 * "Starting restore..." with its button reading Cancel, the popup's
 * scan buttons disabled behind a status line that never changes. The
 * cleanup run alone still sent gmailCleanerDone from its finally, which
 * released the claim and told the popup nothing.
 *
 * The pickers filter to mailbox tabs since 9.0 (popup), 9.7 (Stats,
 * Diagnostics), so this is the second lock on the door, and a lock that
 * hangs the caller is a lock that gets removed. The refusal is a terminal
 * message now, in the shape every caller already handles, and the alert
 * is gone: a dialog inside somebody's Chat about a run that never started
 * is not information.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

const at = (href) => {
  delete window.location;
  window.location = new URL(href);
};

const load = (config) => {
  window.GCC_ATTACHED = false;
  window.GCC_MSG_LISTENER = null;
  window.GMAIL_CLEANER_CONFIG = config;
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
};

const sent = () => chrome.runtime.sendMessage.mock.calls.map(([m]) => m).filter(Boolean);

const terminal = (runKind) => sent().find((m) =>
  m.type === "gmailCleanerProgress" && m.done === true &&
  (runKind ? m.runKind === runKind : !m.runKind));

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.innerHTML = "";
  window.alert = jest.fn();
  chrome.runtime.sendMessage = jest.fn();
  chrome.runtime.onMessage = { addListener: jest.fn(), removeListener: jest.fn() };
  at("https://mail.google.com/chat/u/0/#chat/home");
});

const AUX = [
  ["subscriptionScan", {}],
  ["unsubscribe", { unsubSenders: ["a@b.example"] }],
  ["storageScan", {}],
  ["smartScan", {}],
  ["senderCensus", {}],
  ["unsubscribeVerify", { verifyTargets: [{ email: "a@b.example", after: "2026/01/01" }] }],
  ["reportScan", {}],
  ["restoreRun", { restoreLabel: "GmailCleaner - Promotions", restoreAction: "delete" }]
];

describe("on a Chat tab, every run kind ends with a terminal message", () => {
  test.each(AUX)("%s", async (runKind, extra) => {
    load({ runKind, ...extra });
    await settle();
    const msg = terminal(runKind);
    expect(msg).toBeDefined();
    expect(msg.phase).toBe("error");
    expect(msg.code).toBe("not_a_mailbox");
    expect(typeof msg.status).toBe("string");
    expect(msg.status.length).toBeGreaterThan(0);
    // The one field the Stats page reads off a restore's terminal
    // message, so the row can say nothing was moved.
    if (runKind === "restoreRun") expect(msg.restoredCount).toBe(0);
  });

  test("a cleanup run sends the same shape, without a runKind, and still releases its claim", async () => {
    load({ runKind: "cleanup", runId: "run-1" });
    await settle();
    const msg = terminal(null);
    expect(msg).toBeDefined();
    expect(msg.phase).toBe("error");
    expect(msg.code).toBe("not_a_mailbox");
    const done = sent().find((m) => m.type === "gmailCleanerDone");
    expect(done).toBeDefined();
    expect(done.summary.runId).toBe("run-1");
    expect(done.summary.outcome).toBe("error");
  });

  test("no native alert is raised in the tab", async () => {
    load({ runKind: "storageScan" });
    await settle();
    expect(window.alert).not.toHaveBeenCalled();
  });

  test("the attach flag is released, so a real mailbox run can follow", async () => {
    load({ runKind: "reportScan" });
    await settle();
    expect(window.GCC_ATTACHED).toBe(false);
  });
});

describe("the refusal is about the tab, not the run", () => {
  test("on a mailbox URL the same config is not refused", async () => {
    // The engine would go on to drive Gmail here, which jsdom cannot
    // host, so only the absence of the refusal is asserted: it starts
    // and is still waiting on a search box when the check runs.
    at("https://mail.google.com/mail/u/0/#inbox");
    load({ runKind: "storageScan" });
    await settle();
    expect(sent().some((m) => m.code === "not_a_mailbox")).toBe(false);
  });
});
