/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * Mailbox Report engine (8.0). The report is the cheapest scan in the
 * product and has to stay that way, so this suite drives the real
 * reportScan() against a Gmail fixture rather than unit-testing pieces
 * of it: one openSearch plus one count read per band, a per-band catch
 * that keeps a failed query from losing the whole report, and a hard
 * ceiling on how many searches a report may ever spend.
 *
 * The fixture repaints div[role='main'] on every hash change, which is
 * what openSearch waits for, so no engine function is stubbed. The one
 * concession is timing: openSearch deliberately sleeps around each
 * navigation (400ms transition + 300ms settle) and fourteen of those is
 * twelve seconds of real waiting per test with no behavioural
 * difference, so the harness shrinks the sleep constants and nothing
 * else. If those constants are ever renamed the suite runs slowly
 * rather than wrongly.
 */
const fs = require("fs");
const path = require("path");

const RAW_SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");
const SRC = RAW_SRC
  .replace(/SEARCH_TRANSITION_DELAY: \d+/, "SEARCH_TRANSITION_DELAY: 5")
  .replace(/DOM_SETTLE_DELAY: \d+/, "DOM_SETTLE_DELAY: 5")
  .replace(/WAIT_DEFAULT_INTERVAL: \d+/, "WAIT_DEFAULT_INTERVAL: 5")
  .replace(/WAIT_SEARCH_TIMEOUT: \d+/, "WAIT_SEARCH_TIMEOUT: 400");

// Counts the fixture reports per band query. Chosen so the three size
// bands, two noise bands and one inbox band all carry mail, and the top
// two by count are noise bands (so sender attribution has somewhere to
// look).
const COUNTS = {
  "older_than:6m": 12000,
  "larger:25M older_than:6m": 4,
  "larger:10M smaller:25M older_than:6m": 30,
  "larger:5M smaller:10M older_than:6m": 100,
  "category:promotions older_than:6m": 8000,
  "category:social older_than:6m": 3000,
  "category:updates older_than:1y": 0,
  "category:forums older_than:1y": 0,
  '"unsubscribe" older_than:1y': 500,
  "in:inbox older_than:5y": 0,
  "in:inbox older_than:1y newer_than:5y": 900
};

// What the four default guards leave behind, keyed by rule. Only the
// rules that need to differ are listed. `category:updates` going to
// zero is the shape of the bug this models: notification mail is
// overwhelmingly unread, so `-is:unread` empties the whole band.
const GUARDED_COUNTS = {
  "older_than:6m": 4500,
  "category:promotions older_than:6m": 2000,
  "category:updates older_than:1y": 0
};

// sanitizeConfig defaults all four guards ON when the config omits
// them, and applyGlobalGuards appends them in this order.
const GUARD_SUFFIX = " -is:starred -is:important -is:unread -has:userlabels";
const stripGuards = (q) =>
  q.endsWith(GUARD_SUFFIX) ? q.slice(0, -GUARD_SUFFIX.length) : q;

// What a band's Clean button would actually act on, which since 8.5
// is also what the band reports. Guards are a filter, never a
// source, so they can only take the count down.
const guardedCount = (rule, raw) =>
  Object.prototype.hasOwnProperty.call(GUARDED_COUNTS, rule)
    ? Math.min(raw, Number(GUARDED_COUNTS[rule]) || 0)
    : raw;

const GUARDED = (rule) => guardedCount(rule, Number(COUNTS[rule]) || 0);

const SIZE_FLOORS = {
  "larger:25M older_than:6m": 25,
  "larger:10M smaller:25M older_than:6m": 10,
  "larger:5M smaller:10M older_than:6m": 5
};

let messages;
let searched;
let onMessageCb;
let painter;

/** Every progress beat the engine emitted, in order. */
const progress = () => messages.filter((m) => m.type === "gmailCleanerProgress");
// The attach beat and waitFor's "still waiting" beats belong to the
// content script itself, not to any run.
const beats = () => progress().filter((m) => m.phase !== "boot" && m.phase !== "debug");
const terminal = () => progress().find((m) => m.done === true) || null;
const resultMessage = () => messages.find((m) => m.type === "gmailCleanerReportScanResult") || null;

/**
 * Paint a Gmail result page for the query in the hash. A query in
 * `blackholes` paints no main root at all, which is what a search that
 * never resolves looks like to openSearch.
 */
function installGmail({ counts = COUNTS, blackholes = new Set(), onSearch = null } = {}) {
  // jsdom delivers hashchange as a queued task and the handler reads
  // the live location, so a stale queued event can arrive after the
  // next navigation. Painting once per distinct hash keeps one search
  // from being counted twice.
  let painted = null;
  const paint = () => {
    const hash = location.hash;
    if (hash === painted) return;
    painted = hash;
    if (!hash.startsWith("#search/")) return;
    const query = decodeURIComponent(hash.slice("#search/".length));
    searched.push(query);

    // 8.5: the report measures every band through applyGlobalGuards,
    // the same filter its Clean button runs through. COUNTS stays keyed
    // by the RULE so the table still reads as the band list; what
    // survives the guards is GUARDED_COUNTS, and a rule absent from it
    // survives whole.
    const rule = stripGuards(query);
    const isGuarded = rule !== query;

    if (blackholes.has(rule)) {
      document.body.innerHTML = "<div id='shell'>Loading</div>";
      if (onSearch) onSearch(query, searched.length);
      return;
    }

    // The guarded column only applies to rules the caller's own table
    // carries. A test that hands in an empty mailbox means empty, and
    // must not have the module-level guarded figures put back.
    // Guards can only ever remove mail, so the guarded figure is the
    // smaller of the two. Taking the minimum rather than switching
    // tables is what keeps a caller's explicit zeros at zero.
    const raw = Number(counts[rule]) || 0;
    const total = isGuarded ? guardedCount(rule, raw) : raw;
    if (total === 0) {
      // Gmail's settled empty state: the grid is present with no data
      // rows and the td.TC container is painted inside it. openSearch
      // keys on that container, so it has to be real markup a parser
      // will keep (a stray <td> outside a table is dropped).
      document.body.innerHTML =
        "<div role='main'><table role='grid'><tbody><tr>" +
        "<td class='TC'>No messages matched your search</td></tr></tbody></table></div>";
    } else {
      const slug = searched.length;
      const rows = [
        `<tr role="row" id="r${slug}-1"><td class="yX"><span email="top@sender-${slug}.com" name="Top">Top</span></td></tr>`,
        `<tr role="row" id="r${slug}-2"><td class="yX"><span email="top@sender-${slug}.com" name="Top">Top</span></td></tr>`,
        `<tr role="row" id="r${slug}-3"><td class="yX"><span email="other@sender-${slug}.com" name="Other">Other</span></td></tr>`
      ].join("");
      document.body.innerHTML =
        `<div role="main"><span>1-50 of ${total}</span>` +
        `<table role="grid">${rows}</table></div>`;
    }
    if (onSearch) onSearch(query, searched.length);
  };
  painter = paint;
  window.addEventListener("hashchange", paint);
}

/** Load the engine with a runKind, which is what starts the run. */
function loadEngine(config) {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = config;
  window.alert = () => {};
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

/** Resolve once the engine has emitted a terminal progress message. */
async function waitForTerminal(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (terminal()) return terminal();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`report never finished; phases seen: ${progress().map((m) => m.phase).join(",")}`);
}

async function runReport(options = {}) {
  installGmail(options);
  const I = loadEngine({ runKind: "reportScan" });
  const done = await waitForTerminal();
  return { I, done };
}

beforeEach(async () => {
  // The jsdom window is shared by every test in this file and it
  // delivers hashchange as a QUEUED task, so the previous test's last
  // navigation (including the hash the engine restores in its finally)
  // can still be in flight. Reset the hash and let the queue drain
  // BEFORE the next fixture starts listening: a stale event otherwise
  // repaints for the new test and its first query gets counted twice.
  // Every test here passes in isolation; only the shared window made
  // them interfere, and the symptom was an intermittent duplicate
  // search in the budget assertions.
  location.hash = "";
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  messages = [];
  searched = [];
  onMessageCb = null;
  document.body.innerHTML = "";
  chrome.runtime.sendMessage = jest.fn((msg) => { messages.push(msg); });
  chrome.runtime.onMessage = { addListener: jest.fn((cb) => { onMessageCb = cb; }) };
});

afterEach(async () => {
  // Let the engine's own hash restore land while this test's painter is
  // still the listener, rather than leaking into the next test.
  await new Promise((r) => setTimeout(r, 0));
  // The window survives every test in the file, so a fixture left
  // listening would repaint for the next one too.
  if (painter) window.removeEventListener("hashchange", painter);
  painter = null;
});

describe("mailbox report engine (8.0)", () => {
  test("exposes the report internals under GCC_TEST_MODE", async () => {
    const { I } = await runReport();
    expect(Array.isArray(I.REPORT_BANDS)).toBe(true);
    expect(typeof I.reportScan).toBe("function");
    expect(typeof I.REPORT).toBe("object");
  });

  test("sanitizeConfig accepts reportScan and still falls back for an unknown kind", async () => {
    const { I } = await runReport();
    expect(I.sanitizeConfig({ runKind: "reportScan" }).runKind).toBe("reportScan");
    expect(I.sanitizeConfig({ runKind: "mailboxReport" }).runKind).toBe("cleanup");
    expect(I.sanitizeConfig({ runKind: "reportscan" }).runKind).toBe("cleanup");
    expect(I.sanitizeConfig({}).runKind).toBe("cleanup");
  });

  test("a full report emits reportScan progress and terminates done at 100%", async () => {
    const { I, done } = await runReport();

    for (const msg of beats()) {
      expect(`${msg.phase}:${msg.runKind}`).toBe(`${msg.phase}:reportScan`);
    }
    expect(beats()[0].phase).toBe("starting");
    expect(beats().some((m) => m.phase === "running")).toBe(true);

    expect(done).toMatchObject({ phase: "done", percent: 100, done: true });
    expect(Array.isArray(done.bands)).toBe(true);
    expect(done.bands).toHaveLength(I.REPORT_BANDS.length);
    expect(done.bands.map((b) => b.id)).toEqual(I.REPORT_BANDS.map((b) => b.id));
    // 8.5: the headline is the GUARDED figure, because that is what a
    // run would reach. The raw figure is measured too, and the gap
    // between them is reported separately as guardedOutCount.
    expect(done.cleanableCount).toBe(GUARDED("older_than:6m"));
    expect(done.cleanableCount).toBeLessThan(COUNTS["older_than:6m"]);
  });

  test("each band reports the count its own query returned", async () => {
    const { I, done } = await runReport();
    const byId = Object.fromEntries(done.bands.map((b) => [b.id, b]));
    for (const band of I.REPORT_BANDS) {
      expect(`${band.id}:${byId[band.id].count}`).toBe(`${band.id}:${GUARDED(band.query)}`);
      expect(`${band.id}:${byId[band.id].kind}`).toBe(`${band.id}:${band.kind}`);
      expect(`${band.id}:${byId[band.id].action}`).toBe(`${band.id}:${band.action}`);
    }
  });

  test("largeMb is the size bands' count * mbFloor and nothing else", async () => {
    const { done } = await runReport();
    const expected = Object.entries(SIZE_FLOORS)
      .reduce((sum, [query, floor]) => sum + GUARDED(query) * floor, 0);

    expect(done.largeMb).toBe(expected);
    // The noise and inbox bands overlap everything else, so not one of
    // their 12,400 conversations may reach the headline figure.
    const bandedNonSize = done.bands
      .filter((b) => b.kind !== "size")
      .reduce((sum, b) => sum + b.estMb, 0);
    expect(bandedNonSize).toBe(0);
    expect(done.largeMb).toBe(
      done.bands.filter((b) => b.kind === "size").reduce((sum, b) => sum + b.estMb, 0)
    );
  });

  test("the finished report is posted to the service worker", async () => {
    const { done } = await runReport();
    const sent = resultMessage();
    expect(sent).not.toBeNull();
    expect(sent.bands).toEqual(done.bands);
    expect(sent.largeMb).toBe(done.largeMb);
    expect(sent.cleanableCount).toBe(done.cleanableCount);
  });

  test("sender attribution runs on the biggest bands only", async () => {
    const { I, done } = await runReport();
    expect(done.topSenders.length).toBeLessThanOrEqual(I.REPORT.SENDER_BANDS);
    // Ranked by the GUARDED count, so this is not the raw ordering.
    // Promotions has the most mail (8,000) but most of it is unread,
    // so only 2,000 of it is reachable and social (3,000) outranks
    // it. Attributing senders by raw size would send the user after
    // the band their run can do least about.
    expect(done.topSenders.map((g) => g.bandId)).toEqual(["social", "promotions"]);
    expect(GUARDED("category:social older_than:6m"))
      .toBeGreaterThan(GUARDED("category:promotions older_than:6m"));
    expect(COUNTS["category:social older_than:6m"])
      .toBeLessThan(COUNTS["category:promotions older_than:6m"]);
    for (const group of done.topSenders) {
      expect(group.senders.length).toBeLessThanOrEqual(I.REPORT.TOP_SENDERS);
      expect(group.senders[0].count).toBeGreaterThanOrEqual(group.senders[1]?.count ?? 0);
    }
  });
});

describe("query budget", () => {
  test("a full report never spends more searches than the budget allows", async () => {
    const { I } = await runReport();
    // The regression guard: a new band must not quietly turn a fast
    // read-only scan into a minutes-long one.
    expect(searched.length).toBeLessThanOrEqual(I.REPORT.MAX_QUERIES + I.REPORT.SENDER_BANDS);
    expect(I.REPORT_BANDS.length + 1).toBeLessThanOrEqual(I.REPORT.MAX_QUERIES);
  });

  test("it issues exactly the headline plus one search per band, plus attribution", async () => {
    const { I } = await runReport();
    // The headline is measured twice, raw then guarded, so the gap the
    // guards create can be reported. Every band is guarded.
    const planned = [
      I.REPORT.HEADLINE_QUERY,
      I.REPORT.HEADLINE_QUERY + GUARD_SUFFIX,
      ...I.REPORT_BANDS.map((b) => b.query + GUARD_SUFFIX)
    ];
    expect(searched.slice(0, planned.length)).toEqual(planned);
    // Anything beyond the plan is sender attribution re-running a band
    // query that was already part of the plan.
    for (const extra of searched.slice(planned.length)) {
      expect(planned).toContain(extra);
    }
    expect(searched.length - planned.length).toBeLessThanOrEqual(I.REPORT.SENDER_BANDS);
  });

  test("an empty mailbox spends no attribution searches at all", async () => {
    const zeros = Object.fromEntries(Object.keys(COUNTS).map((q) => [q, 0]));
    const { I, done } = await runReport({ counts: zeros });
    expect(searched).toHaveLength(I.REPORT_BANDS.length + 2);
    expect(done.topSenders).toEqual([]);
    expect(done.largeMb).toBe(0);
    expect(done.cleanableCount).toBe(0);
  });
});

describe("a band whose search fails", () => {
  test("is skipped and the rest of the report still completes", async () => {
    const broken = "category:promotions older_than:6m";
    const { done } = await runReport({ blackholes: new Set([broken]) });

    expect(done.phase).toBe("done");
    expect(searched).toContain(broken + GUARD_SUFFIX);

    const byId = Object.fromEntries(done.bands.map((b) => [b.id, b]));
    expect(byId.promotions.count).toBe(0);
    // Every other band still carries its real number.
    expect(byId.social.count).toBe(GUARDED("category:social older_than:6m"));
    expect(byId.sizeBig.count).toBe(GUARDED("larger:5M smaller:10M older_than:6m"));
    expect(done.cleanableCount).toBe(GUARDED("older_than:6m"));
  });

  test("a failed headline query costs the headline number, not the report", async () => {
    const { done } = await runReport({ blackholes: new Set(["older_than:6m"]) });
    expect(done.phase).toBe("done");
    expect(done.cleanableCount).toBe(0);
    expect(done.bands.find((b) => b.id === "social").count)
      .toBe(GUARDED("category:social older_than:6m"));
  });
});

describe("run lifecycle", () => {
  test("refuses to start a second report while one is in progress", async () => {
    installGmail();
    const I = loadEngine({ runKind: "reportScan" });
    // The boot run has already claimed RUNNING by the time the load
    // call returns, so this second request must be a no-op.
    await I.reportScan();
    expect(beats().filter((m) => m.phase === "starting")).toHaveLength(1);

    await waitForTerminal();
    expect(beats().filter((m) => m.phase === "starting")).toHaveLength(1);
    expect(beats().filter((m) => m.done === true)).toHaveLength(1);
  });

  test("clears GCC_ATTACHED in its finally so the next injection can attach", async () => {
    await runReport();
    expect(window.GCC_ATTACHED).toBe(false);
  });

  test("a cancelled report says so and puts the hash back where it found it", async () => {
    location.hash = "#inbox";
    installGmail({
      onSearch: (_query, nth) => {
        // Deterministic: cancel once the third search has painted.
        if (nth === 3 && onMessageCb) {
          onMessageCb({ type: "gmailCleanerCancel" }, {}, () => {});
        }
      }
    });
    loadEngine({ runKind: "reportScan" });
    const done = await waitForTerminal();

    expect(done).toMatchObject({ phase: "cancelled", done: true, percent: 100 });
    expect(done.bands).toBeUndefined();
    expect(resultMessage()).toBeNull();
    expect(location.hash).toBe("#inbox");
    expect(window.GCC_ATTACHED).toBe(false);
    expect(searched.length).toBeLessThan(Object.keys(COUNTS).length);
  });
});

describe("the large-run guardrails stop the run when declined", () => {
  // 8.0 replaced two confirm() calls with a dialog on the progress page
  // whose safe button says "Stop the run" and whose copy promises that
  // stopping leaves everything untouched. Before this, declining ended
  // the current rule and the run carried on to the next one, which the
  // old vague "Continue anyway?" survived and the new copy does not.
  const fs = require("fs");
  const path = require("path");
  const engine = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

  const declineBlock = (kind) => {
    const at = engine.indexOf(`kind: "${kind}"`);
    expect(at).toBeGreaterThan(-1);
    const end = engine.indexOf("window.GCC_CONFIRMED", at);
    return engine.slice(at, end > at ? end : at + 1200);
  };

  test.each(["softCap", "hugeRun"])("%s declines by cancelling, not by returning", (kind) => {
    const block = declineBlock(kind);
    expect(block).toMatch(/CANCELLED = true;/);
    expect(block).toMatch(/throw new CancellationError\(/);
    expect(block).not.toMatch(/return \{ deleted: false, count: 0, reason: "user-/);
  });

  test("a scheduled run still auto-declines without asking anyone", () => {
    // Unattended runs must never wait on a dialog nobody will answer,
    // and their decline stays a skip so a schedule is not cancelled by
    // one oversized rule.
    expect(engine).toMatch(/scheduled-soft-cap-declined/);
    expect(engine).toMatch(/scheduled-huge-run-declined/);
    const softCapAsk = engine.indexOf('kind: "softCap"');
    const scheduledGuard = engine.indexOf("scheduled-soft-cap-declined");
    expect(scheduledGuard).toBeLessThan(softCapAsk);
  });

  test("the guardrail answer is a separate signal from Review Mode", () => {
    // A leftover "resume" from Review Mode must never read as consent
    // to a 20,000-message run.
    expect(engine).toMatch(/let GUARD_SIGNAL = null;/);
    expect(engine).toMatch(/case "gmailCleanerGuardProceed":/);
    expect(engine).toMatch(/case "gmailCleanerGuardStop":/);
    expect(engine).toMatch(/GUARD_SIGNAL = null;[\s\S]{0,400}gmailCleanerRequestGuardrail/);
  });

  test("no answer within the window declines", () => {
    const ask = engine.slice(engine.indexOf("async function askGuardrail"), engine.indexOf("async function waitForReviewResponse"));
    expect(ask).toMatch(/GUARD_RESPONSE_TIMEOUT_MS/);
    expect(ask).toMatch(/return false;/);
    expect(ask).toMatch(/return GUARD_SIGNAL === "proceed";/);
  });
});
