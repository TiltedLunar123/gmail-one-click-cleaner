/**
 * @jest-environment jsdom
 *
 * 9.5, the property on the surface people actually see.
 *
 * The result card is where a finished cleanup is reported, and it said
 * "Freed ~310 MB" about mail that had just been moved to Trash, over a
 * safety note two lines below promising that storage frees up once Trash
 * empties. Both sentences were true; only one of them was next to the
 * number, and it was the wrong one.
 *
 * These tests hold the property rather than the wording: a fresh delete
 * result never calls the storage freed, and never shows a megabyte
 * figure without the waiting figure and the door beside it.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await flush(); };

const DAY = 24 * 60 * 60 * 1000;

// A recovery log holding one fresh, tagged, unrestored delete run.
const waitingLog = (over = {}) => ([{
  id: "undo_1",
  runId: "run-1",
  timestamp: Date.now() - DAY,
  query: "category:promotions older_than:1y",
  label: "Promotions",
  count: 1240,
  mbMoved: 310,
  passes: 1,
  action: "delete",
  tagLabel: "GmailCleaner - Promotions",
  taggingFailed: false,
  ...over
}]);

describe("the popup result card", () => {
  let onMessage;
  let undoLog;
  let tabUpdates;
  let armed;
  let tabsById;
  let booted;

  const bootPopup = async () => {
    const localStore = { onboardedAt: Date.now(), pinHintDismissed: true, runSuccessCount: 2 };
    const syncStore = {};
    const area = (store) => ({
      get: (keys, cb) => {
        const out = {};
        const list = keys === null || keys === undefined
          ? Object.keys(store)
          : (Array.isArray(keys) ? keys : [keys]);
        for (const k of list) if (k in store) out[k] = store[k];
        cb(out);
      },
      set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
      remove: (keys, cb) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
        if (cb) cb();
      }
    });
    global.chrome = {
      runtime: {
        id: "test", lastError: null,
        getURL: (p) => `chrome-extension://test/${p}`,
        getManifest: () => ({ version: "9.5.0", permissions: [], host_permissions: [] }),
        onMessage: { addListener: (cb) => { onMessage = cb; } },
        sendMessage: (msg, cb) => {
          let reply = { ok: true };
          if (msg?.type === "gmailCleanerGetUndoLog") reply = { ok: true, log: undoLog };
          if (msg?.type === "gmailCleanerGetReport") reply = { ok: true, report: null };
          if (msg?.type === "gmailCleanerArmTrashHint") {
            armed.push(msg.tabId);
            reply = { ok: true };
          }
          if (typeof cb === "function") cb(reply);
        }
      },
      storage: { local: area(localStore), sync: area(syncStore) },
      tabs: {
        query: (qy, cb) => {
          const pattern = String(qy?.url || "");
          if (pattern && !pattern.startsWith("https://mail.google.com")) return cb([]);
          cb(Object.values(tabsById));
        },
        get: (id, cb) => cb(tabsById[id]),
        create: (o, cb) => { if (cb) cb({ id: 101 }); },
        update: (id, o, cb) => { tabUpdates.push([id, o]); if (cb) cb({ id }); },
        reload: (id, cb) => { if (cb) cb(); }
      },
      windows: { update: (id, o, cb) => { if (cb) cb({ id }); } },
      permissions: { contains: (p, cb) => cb(true), request: (p, cb) => cb(true) },
      action: { getUserSettings: (cb) => cb({ isOnToolbar: true }) },
      // Callback form: the licence read hangs otherwise and every Pro
      // surface renders free.
      management: { getSelf: (cb) => cb({ installType: "normal" }) },
      scripting: { executeScript: (opts, cb) => { if (cb) cb([]); } },
      i18n: { getMessage: () => "" }
    };

    const shared = read("shared.js")
      .replace("const license = Object.freeze({", "const license = ({")
      .replace("const gmailAccess = Object.freeze({", "const gmailAccess = ({");
    const glue = `
      ;GCC.license.getState = async () => ({ active: false, key: "" });
      GCC.gmailAccess.check = async () => true;
      GCC.gmailAccess.request = async () => true;
    `;
    const html = read("popup.html");
    const inner = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
    document.documentElement.innerHTML = (inner ? inner[1] : html)
      .replace(/<script[^>]*><\/script>/g, "");
    window.close = () => {};

    // Replacing documentElement.innerHTML detaches the markup but not
    // the DOCUMENT, and every popup this file has booted still has its
    // DOMContentLoaded listener on it. Without cutting those loose, the
    // dispatch below re-runs eight earlier copies' init against the
    // current DOM and their work lands in this test's assertions. Same
    // leak the 9.3 launcher suite disconnects a MutationObserver for.
    const added = [];
    const realAdd = document.addEventListener.bind(document);
    document.addEventListener = (type, fn, opts) => {
      added.push([type, fn, opts]);
      realAdd(type, fn, opts);
    };
    // eslint-disable-next-line no-new-func
    new Function(shared + glue + read("popup.js"))();
    document.addEventListener = realAdd;
    booted.push(added);

    document.dispatchEvent(new window.Event("DOMContentLoaded"));
    await settle(30);
  };

  const finishRun = async (stats) => {
    onMessage({
      type: "gmailCleanerProgress",
      phase: "done",
      done: true,
      percent: 100,
      status: "Cleanup finished.",
      stats
    }, { id: "test" }, () => {});
    await settle(20);
  };

  const liveStats = (over = {}) => ({
    mode: "live",
    action: "delete",
    runCount: 1240,
    totalDeleted: 1240,
    totalWouldDelete: 0,
    totalFreedMb: 310,
    totalQueries: 6,
    stoppedShort: 0,
    links: { trash: "https://mail.google.com/mail/u/1/#trash" },
    ...over
  });

  const $ = (id) => document.getElementById(id);
  const cardText = () => $("resultSummary")?.textContent || "";

  afterEach(() => {
    // Cut every copy this test booted loose from the shared document, so
    // the next test's DOMContentLoaded reaches only its own popup.
    for (const added of booted) {
      for (const [type, fn, opts] of added) document.removeEventListener(type, fn, opts);
    }
    booted = [];
  });

  beforeEach(() => {
    booted = [];
    undoLog = waitingLog();
    tabUpdates = [];
    armed = [];
    tabsById = {
      7: { id: 7, url: "https://mail.google.com/mail/u/0/#inbox", status: "complete", active: true, windowId: 1 },
      8: { id: 8, url: "https://mail.google.com/mail/u/1/#inbox", status: "complete", active: false, windowId: 1 }
    };
  });

  test("a fresh delete result does not call the storage freed", async () => {
    await bootPopup();
    await finishRun(liveStats());
    expect(/\bfreed\b/i.test(cardText())).toBe(false);
    expect(cardText().toLowerCase()).toContain("moved to trash");
  });

  test("the megabytes never appear without the waiting figure beside them", async () => {
    // The property, stated as one assertion: if the card is showing a
    // storage number for a delete run, the waiting block is visible too.
    await bootPopup();
    await finishRun(liveStats());
    const showsMb = $("resultFreedClause").hidden === false;
    expect([showsMb, $("resultTrashWaiting").hidden]).toEqual([true, false]);
    expect($("resultTrashFigure").textContent.toLowerCase()).toContain("at least");
    expect($("resultTrashFigure").textContent).toContain("1,240");
  });

  test("the waiting figure names the size when the log carries one", async () => {
    await bootPopup();
    await finishRun(liveStats());
    expect($("resultTrashFigure").textContent).toContain("310 MB");
  });

  test("an upgraded install shows the count and drops the size clause", async () => {
    // Entries written before 9.5 carry no mbMoved. "about 0 MB" is not a
    // smaller answer, so the clause goes and the count stays.
    const legacy = waitingLog();
    delete legacy[0].mbMoved;
    undoLog = legacy;
    await bootPopup();
    await finishRun(liveStats());
    expect($("resultTrashWaiting").hidden).toBe(false);
    expect($("resultTrashFigure").textContent).toContain("1,240");
    expect($("resultTrashFigure").textContent).not.toContain("0 MB");
  });

  test("nothing waiting shows nothing at all", async () => {
    // Zero is not a smaller answer, it is not an answer.
    undoLog = [];
    await bootPopup();
    await finishRun(liveStats());
    expect($("resultTrashWaiting").hidden).toBe(true);
  });

  test("a run whose mail has aged out of the window shows nothing", async () => {
    undoLog = waitingLog({ timestamp: Date.now() - 31 * DAY });
    await bootPopup();
    await finishRun(liveStats());
    expect($("resultTrashWaiting").hidden).toBe(true);
  });

  test("an archive run has nothing waiting and says nothing about Trash", async () => {
    await bootPopup();
    await finishRun(liveStats({ action: "archive", totalFreedMb: 0 }));
    expect([$("resultFreedClause").hidden, $("resultTrashWaiting").hidden]).toEqual([true, true]);
  });

  test("a dry run has nothing waiting", async () => {
    await bootPopup();
    await finishRun(liveStats({ mode: "dry", totalDeleted: 0, totalWouldDelete: 1240, totalFreedMb: 0 }));
    expect($("resultTrashWaiting").hidden).toBe(true);
  });
  test("Open Trash takes the run's own account to Trash, not account 0", async () => {
    // The run happened in /u/1/ and the ACTIVE mailbox tab is /u/0/.
    // Sending someone to account 0's Trash after cleaning account 1 is
    // the 8.11 retargeting bug wearing a new button.
    await bootPopup();
    await finishRun(liveStats());
    $("resultTrashBtn").click();
    await settle(20);
    expect(tabUpdates).toHaveLength(1);
    expect(tabUpdates[0][1].url).toBe("https://mail.google.com/mail/u/1/#trash");
    expect(tabUpdates[0][1].active).toBe(true);
    // The tab it navigated, so the worker can read the account off the
    // tab rather than off this message.
    expect(tabUpdates[0][0]).toBe(8);
    expect(armed).toEqual([8]);
  });

  test("with only one mailbox open, that tab is taken to the run's account", async () => {
    delete tabsById[8];
    await bootPopup();
    await finishRun(liveStats());
    $("resultTrashBtn").click();
    await settle(20);
    expect(tabUpdates[0][0]).toBe(7);
    expect(tabUpdates[0][1].url).toBe("https://mail.google.com/mail/u/1/#trash");
  });

  test("the Storage tab door has no run behind it and uses the mailbox tab", async () => {
    await bootPopup();
    expect($("xrayTrashWaiting").hidden).toBe(false);
    $("xrayTrashBtn").click();
    await settle(20);
    expect(tabUpdates[0][1].url).toBe("https://mail.google.com/mail/u/0/#trash");
    expect(armed).toEqual([7]);
  });
});
