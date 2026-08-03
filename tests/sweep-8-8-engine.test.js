/**
 * @jest-environment jsdom
 *
 * Engine findings from the 8.8 sweep.
 *
 * Every assertion here was checked to FAIL against the 8.7.0 source
 * before the fix landed. Where the defect is a behaviour the engine can
 * be driven through (the message listener, the guard builders, the
 * dangerous-token refusal) these are real behavioural tests rather than
 * source pins; the pass-loop nesting is a structural fact about one
 * block and is pinned as one, scoped to processQuery.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

/** Load the engine IIFE into the current jsdom window. */
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

/**
 * A message hub that behaves like chrome.runtime.onMessage: listeners
 * are offered the message in registration order and the FIRST one to
 * call sendResponse is the answer the sender receives. That ordering is
 * the whole bug, so the mock has to reproduce it faithfully.
 */
function installMessageHub() {
  const listeners = [];
  chrome.runtime.onMessage = {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn)
  };
  return {
    listeners,
    send(msg) {
      let answer;
      let answered = false;
      for (const fn of listeners) {
        fn(msg, {}, (response) => {
          if (answered) return;
          answered = true;
          answer = response;
        });
      }
      return answer;
    }
  };
}

describe("a finished run's message listener does not answer for the next one", () => {
  // 8.7 gave the ping a run id so the unattended callers could tell a
  // real injection from a swallowed one. But the engine added a listener
  // on every injection and removed none, and GCC_ATTACHED is cleared
  // when a run ends, so the next injection booted a second engine
  // alongside the first one's still-registered listener. Chrome keeps
  // the first sendResponse, so the ping came back with the PREVIOUS
  // run's id, confirmInjection saw a mismatch, and every scheduled
  // cleanup and Auto-Pilot sweep on a tab that had already run once was
  // abandoned as "swallowed".
  let hub;
  beforeEach(() => {
    hub = installMessageHub();
  });

  test("the second injection replaces the first injection's listener", () => {
    loadEngine({ runId: "run-1" });
    expect(hub.listeners).toHaveLength(1);

    // The run ends: the engine clears its own attach flag in the finally
    // of every run kind, which is what lets the next injection boot.
    window.GCC_ATTACHED = false;
    loadEngine({ runId: "run-2" });

    expect(hub.listeners).toHaveLength(1);
  });

  test("the ping reports the run that is actually attached now", () => {
    loadEngine({ runId: "run-1" });
    window.GCC_ATTACHED = false;
    loadEngine({ runId: "run-2" });

    const answer = hub.send({ type: "gmailCleanerPing" });
    expect(answer.ok).toBe(true);
    expect(answer.runId).toBe("run-2");
  });

  test("listeners do not accumulate over a long-lived Gmail tab", () => {
    for (let i = 0; i < 6; i++) {
      window.GCC_ATTACHED = false;
      loadEngine({ runId: `run-${i}` });
    }
    expect(hub.listeners).toHaveLength(1);
    expect(hub.send({ type: "gmailCleanerPing" }).runId).toBe("run-5");
  });

  test("a duplicate injection into a LIVE engine leaves its listener alone", () => {
    // The attach guard returns before the listener block while an engine
    // is running, so the live run keeps answering for itself. Removing
    // the listener of a run still in flight would be the worse bug.
    loadEngine({ runId: "run-1" });
    expect(hub.listeners).toHaveLength(1);

    window.GCC_TEST_MODE = true;
    window.GMAIL_CLEANER_CONFIG = { runId: "run-2" };
    // A run that is still in flight holds the attach flag. jsdom is not
    // mail.google.com so the engine above bailed and cleared it, which
    // is the finished-run state the other tests use; set it back to
    // stand in for an engine that is genuinely still working.
    window.GCC_ATTACHED = Date.now();
    // eslint-disable-next-line no-new-func
    new Function(SRC)();

    expect(hub.listeners).toHaveLength(1);
    expect(hub.send({ type: "gmailCleanerPing" }).runId).toBe("run-1");
  });
});

describe("Trash and Spam are refused like every other unrecoverable target", () => {
  // A rule scoped to in:trash or in:spam puts Gmail in the one view
  // where the toolbar's delete control means "Delete forever". The
  // engine clicks it and the mail is gone: no Trash to recover from, and
  // one-click Restore searches `in:trash label:"..."`, which is exactly
  // the mail such a rule destroys. in:sent was already refused, and
  // in:sent is recoverable.
  test("queryHasDangerousToken refuses in:trash and in:spam", () => {
    const I = loadEngine();
    expect(I.queryHasDangerousToken("in:trash older_than:1y")).toBe(true);
    expect(I.queryHasDangerousToken("in:spam older_than:1y")).toBe(true);
    expect(I.queryHasDangerousToken("(in:trash)")).toBe(true);
    expect(I.queryHasDangerousToken("IN:TRASH older_than:6m")).toBe(true);
  });

  test("ordinary cleanup queries are still allowed", () => {
    const I = loadEngine();
    expect(I.queryHasDangerousToken("category:promotions older_than:6m")).toBe(false);
    expect(I.queryHasDangerousToken("from:(a@b.com) larger:5M")).toBe(false);
  });
});

describe("a whitelist entry is not dropped for containing the letters and/or", () => {
  // The sanitizer refused any entry matching \bOR\b or \bAND\b. "." and
  // "-" are not word characters, so sales.and.marketing@company.com and
  // news-or-offers@shop.com matched and were skipped in silence: the
  // user protects a sender, the -from: guard is never appended, and the
  // next run deletes that sender's mail. Only a debugLog said so.
  const guardsFor = (whitelist) => {
    const I = loadEngine({
      whitelist,
      guardSkipStarred: false,
      guardSkipImportant: false,
      guardSkipUnread: false,
      guardSkipUserLabels: false
    });
    return I.applyGlobalGuards("category:promotions older_than:6m");
  };

  test.each([
    "sales.and.marketing@company.com",
    "news-or-offers@shop.com",
    "and@example.com",
    "or@example.com"
  ])("protects %s", (entry) => {
    expect(guardsFor([entry])).toContain(`-from:${entry}`);
  });

  test("an entry carrying a real operator is still refused", () => {
    // The threat the sanitizer exists for needs whitespace to separate
    // the operator, and whitespace is still rejected outright.
    const guards = guardsFor(["user@test.com OR attacker@evil.com"]);
    expect(guards).not.toContain("attacker@evil.com");
    expect(guardsFor(["a@b.com)"])).not.toContain("a@b.com)");
    expect(guardsFor(["{a@b.com}"])).not.toContain("{a@b.com}");
  });

  test("the documented wildcard shape still becomes Gmail's domain form", () => {
    expect(guardsFor(["*@bank.com"])).toContain("-from:bank.com");
  });
});

describe("the pass-limit warning belongs after the pass loop, not inside it", () => {
  // It sat one nesting level too deep, so it fired at the end of EVERY
  // completed pass: a rule that simply needed a second pass told the
  // user it had "stopped at the pass limit" while it was still working,
  // and recorded an extra perQuery entry per pass carrying the running
  // cumulative total. A three-pass rule that cleared 150 booked
  // 50 + 100 + 150 = 300 into the progress table, the run receipt and
  // the persisted categoryBreakdown behind the Stats page.
  const processQuery = (() => {
    const from = SRC.indexOf("  async function processQuery(");
    const to = SRC.indexOf("  async function saveRunHistory(", from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return SRC.slice(from, to).replace(/\r\n/g, "\n");
  })();

  /**
   * Braces inside comments and string or template literals are not
   * structure, and this function is full of both, so they come out
   * before anything is counted. Template bodies are balanced by
   * construction, so dropping them whole is safe.
   */
  const code = (() => {
    const s = processQuery;
    let out = "";
    let i = 0;
    while (i < s.length) {
      const two = s.slice(i, i + 2);
      if (two === "//") {
        const nl = s.indexOf("\n", i);
        i = nl === -1 ? s.length : nl;
        continue;
      }
      if (two === "/*") {
        const end = s.indexOf("*/", i + 2);
        i = end === -1 ? s.length : end + 2;
        continue;
      }
      const c = s[i];
      if (c === '"' || c === "'" || c === "`") {
        i++;
        while (i < s.length) {
          if (s[i] === "\\") { i += 2; continue; }
          if (s[i] === c) { i++; break; }
          i++;
        }
        out += '""';
        continue;
      }
      out += c;
      i++;
    }
    return out;
  })();

  test("the pass loop closes before the warning is sent", () => {
    // The literal the warning is built from is stripped above, so anchor
    // on the call that sends it: recordQueryStats runs beside it, and
    // the pass-limit pair is the last of them in the function.
    const loopAt = code.indexOf("while (pass < TIMING.PASS_CAP) {");
    const warnAt = code.lastIndexOf("safeSend({");
    expect(loopAt).toBeGreaterThan(-1);
    expect(warnAt).toBeGreaterThan(loopAt);

    // Depth relative to the pass loop's own opening brace: the warning
    // has to be reached at 0, meaning that loop has already closed.
    const open = code.indexOf("{", loopAt);
    let depth = 0;
    for (let i = open; i < warnAt; i++) {
      const c = code[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    expect(depth).toBe(0);
  });

  test("it is written at function-body indentation, not loop-body", () => {
    expect(processQuery).toContain("\n    safeSend({\n      phase: \"warning\",\n      status: `${label} stopped at the pass limit`");
  });

  test("exactly one pass-limit stats record exists in the function", () => {
    const hits = processQuery.split("stopped at the pass limit").length - 1;
    expect(hits).toBe(1);
  });
});

describe("Maximum runs Maximum on an install that saved Options before 8.1", () => {
  // 8.7 added `maximum` to the engine's DEFAULT_RULES, which covers the
  // install that never saved Options at all. An install that DID save
  // before 8.1 has a stored `rules` object with no maximum key, and the
  // fallback chain reached that object's `normal` list before the
  // engine's own table: the user armed the most destructive preset in
  // the product and watched the progress page announce "Level: maximum"
  // while the Normal rules ran.
  test("the requested intensity is looked up in DEFAULT_RULES before any fallback", () => {
    const at = SRC.indexOf("const set = refuseDangerousRules(");
    expect(at).toBeGreaterThan(-1);
    const line = SRC.slice(at, SRC.indexOf(");", at));
    expect(line).toContain("allRules[intensity] ?? DEFAULT_RULES[intensity]");
    // The old chain fell straight from the stored set to stored normal.
    expect(line).not.toMatch(/allRules\[intensity\]\s*\?\?\s*allRules\.normal/);
  });
});
