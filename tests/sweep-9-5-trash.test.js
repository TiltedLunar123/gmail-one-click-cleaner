/**
 * @jest-environment node
 *
 * 9.5, saying where the space went.
 *
 * A delete run moves mail to Trash on purpose, so the tag-before-delete
 * promise and the 30-day Restore both have something to work with.
 * Google counts Trash against the storage limit until it empties, so the
 * quota bar this extension is bought to move does not move for up to 30
 * days after a run. Four surfaces said "Freed" about that moment: the
 * popup result card, the progress done card, the Stats tile and the run
 * notification, which is the only surface an unattended sweep reaches.
 *
 * The property these tests hold, rather than any one sentence:
 *
 *   No surface may call storage "freed" for mail still inside Gmail's
 *   30-day window unless the same surface shows the part still waiting
 *   and where it is.
 *
 * And the figure beside "waiting" is measured through the action's own
 * filter: GCC.trash.waiting runs GCC.restore.eligibility, which is the
 * function each Restore button answers to, so the two surfaces cannot
 * disagree about what is down there.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const code = read("shared.js");
const iifeMatch = code.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
  {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      className: "", setAttribute: () => {}, appendChild: () => {},
      style: {}, classList: { add: () => {}, remove: () => {} },
      remove: () => {}
    }),
    addEventListener: () => {}
  },
  {},
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const entry = (over = {}) => ({
  id: "undo_1",
  timestamp: NOW - DAY,
  query: "category:promotions",
  label: "Promotions",
  count: 100,
  mbMoved: 25,
  action: "delete",
  tagLabel: "GmailCleaner - Promotions",
  taggingFailed: false,
  ...over
});

// ------------------------------------------------------- the derivation

describe("GCC.trash.waiting counts what Restore would still bring back", () => {
  test("a fresh tagged delete run is counted, in both count and megabytes", () => {
    expect(GCC.trash.waiting([entry()], NOW)).toEqual({ count: 100, mb: 25, runs: 1 });
  });

  test("several runs inside the window add up", () => {
    const log = [entry(), entry({ id: "b", count: 40, mbMoved: 12.5 })];
    expect(GCC.trash.waiting(log, NOW)).toEqual({ count: 140, mb: 37.5, runs: 2 });
  });

  test("a run past the 30-day window is gone from both totals", () => {
    // Gmail has emptied it by then, so the space really did arrive and
    // the mail really is not recoverable. Both facts point the same way.
    expect(GCC.trash.waiting([entry({ timestamp: NOW - 31 * DAY })], NOW))
      .toEqual({ count: 0, mb: 0, runs: 0 });
  });

  test("the boundary matches the Restore button's, to the millisecond", () => {
    // Eligibility ages out on `now - ts > WINDOW`, so the instant the
    // window is exactly spent still counts. Whatever the rule is, the
    // point of this test is that one rule serves both surfaces: the
    // figure flips in the same millisecond the button does.
    const lastMs = entry({ timestamp: NOW - GCC.restore.TRASH_WINDOW_MS });
    const past = entry({ timestamp: NOW - GCC.restore.TRASH_WINDOW_MS - 1 });
    expect([
      GCC.restore.eligibility(lastMs, NOW).eligible,
      GCC.trash.waiting([lastMs], NOW).count,
      GCC.restore.eligibility(past, NOW).eligible,
      GCC.trash.waiting([past], NOW).count
    ]).toEqual([true, 100, false, 0]);
  });

  test("a run already restored is not waiting for anything", () => {
    expect(GCC.trash.waiting([entry({ restoredAt: NOW - 60_000 })], NOW).count).toBe(0);
  });

  test("an archive run is excluded: All Mail is not Trash", () => {
    // 8.9's rule, applied to the new figure. Archived mail never leaves
    // the account, so it is not on any clock and frees nothing later.
    expect(GCC.trash.waiting([entry({ action: "archive" })], NOW))
      .toEqual({ count: 0, mb: 0, runs: 0 });
  });

  test("a run whose tagging failed is excluded, which makes the total a floor", () => {
    // Real mail moved, and this counts none of it, because the filter is
    // Restore's and Restore refuses an entry with no safe search target.
    // Under-counting is the only direction this figure may be wrong in.
    expect(GCC.trash.waiting([entry({ taggingFailed: true })], NOW).count).toBe(0);
  });

  test("an entry with no label is excluded for the same reason", () => {
    expect(GCC.trash.waiting([entry({ tagLabel: "  " })], NOW).count).toBe(0);
  });

  test("entries written before 9.5 contribute their count and no megabytes", () => {
    // The upgrade case. mbMoved did not exist, so the size half of the
    // floor is missing until those runs age out; the count is still real
    // and every surface drops the size clause rather than printing zero.
    const legacy = entry();
    delete legacy.mbMoved;
    expect(GCC.trash.waiting([legacy], NOW)).toEqual({ count: 100, mb: 0, runs: 1 });
  });

  test("junk in the log cannot produce a figure", () => {
    expect(GCC.trash.waiting([null, "nope", {}, 7], NOW)).toEqual({ count: 0, mb: 0, runs: 0 });
    expect(GCC.trash.waiting(null, NOW)).toEqual({ count: 0, mb: 0, runs: 0 });
  });

  test("negative or unparseable numbers cannot drag the total down", () => {
    const bad = entry({ count: -500, mbMoved: "many" });
    expect(GCC.trash.waiting([bad, entry()], NOW)).toEqual({ count: 100, mb: 25, runs: 2 });
  });

  test("the derivation is the eligibility function, called by name", () => {
    // Not a second filter that happens to agree today. A source pin,
    // because two functions that must never disagree are best served by
    // there only being one of them.
    const at = code.indexOf("const trashWaiting = (log, now = Date.now()) =>");
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, code.indexOf("};", at));
    expect(body).toContain("restoreEligibility(entry, now)");
    expect(body).toContain('verdict.action !== "delete"');
  });
});

// -------------------------------------------------------------- the door

describe("the Open Trash door lands in the account the run used", () => {
  test("a second signed-in account keeps its own /u/N/", () => {
    expect(GCC.trash.accountOf("https://mail.google.com/mail/u/1/#inbox")).toBe("1");
    expect(GCC.trash.urlFor("1")).toBe("https://mail.google.com/mail/u/1/#trash");
  });

  test("a run's own recorded link carries the account through to the door", () => {
    // What the result card and the done card actually do: the engine
    // records links.trash from the base URL of the tab it ran in.
    const recorded = "https://mail.google.com/mail/u/1/#trash";
    expect(GCC.trash.urlFor(GCC.trash.accountOf(recorded)))
      .toBe("https://mail.google.com/mail/u/1/#trash");
  });

  test("the default mailbox is account 0, and so is anything unreadable", () => {
    expect(GCC.trash.accountOf("https://mail.google.com/mail/#inbox")).toBe("0");
    expect(GCC.trash.urlFor(undefined)).toBe("https://mail.google.com/mail/u/0/#trash");
    expect(GCC.trash.urlFor("")).toBe("https://mail.google.com/mail/u/0/#trash");
  });

  test("nothing but digits reaches the URL", () => {
    // The account is the only thing taken out of a recorded link, and it
    // is rebuilt here rather than reused, so no mailbox text can ride
    // into a URL this extension navigates to.
    for (const hostile of ["0/#trash?q=x", "../../evil", "0 OR 1", "<script>", "١٢"]) {
      expect(GCC.trash.urlFor(hostile)).toBe("https://mail.google.com/mail/u/0/#trash");
    }
  });

  test("the page-side account reader agrees with the worker's, case by case", () => {
    // 9.0 pinned GCC.isMailboxUrl against the worker's isMailboxTab for
    // exactly this reason. Same shape, same table.
    const bg = read("background.js");
    const at = bg.indexOf("function gmailAccountOf(url)");
    expect(at).toBeGreaterThan(-1);
    const workerAccountOf = new Function(
      `${bg.slice(at, bg.indexOf("\n  }", at) + 4)}; return gmailAccountOf;`
    )();
    const urls = [
      "https://mail.google.com/mail/u/0/#inbox",
      "https://mail.google.com/mail/u/1/#trash",
      "https://mail.google.com/mail/u/12/#all",
      "https://mail.google.com/mail/#inbox",
      "https://mail.google.com/",
      "https://mail.google.com/chat/u/2/#chat/home",
      "",
      null
    ];
    for (const url of urls) {
      expect([url, GCC.trash.accountOf(url)]).toEqual([url, workerAccountOf(url)]);
    }
  });
});

// ------------------------------------------------- the property, on each
// ------------------------------------------------- surface that shows MB

const CATALOG = JSON.parse(read(path.join("_locales", "en", "messages.json")));

// The claim, not the sentence. A surface may word this however it likes;
// what it may not do is call the storage freed at the moment it is still
// in Trash.
const CLAIMS_FREED = /\bfreed\b|\bfrees up\b|\bspace freed\b/i;

describe("no surface calls it freed at the moment it is still in Trash", () => {
  test("the popup result card states a floor moved to Trash", () => {
    const line = CATALOG.resultMid.message + CATALOG.resultTail.message;
    expect(CLAIMS_FREED.test(line)).toBe(false);
    expect(line.toLowerCase()).toContain("trash");
    expect(line.toLowerCase()).toContain("at least");
  });

  test("the progress done card states a floor moved to Trash", () => {
    expect(CLAIMS_FREED.test(CATALOG.progDoneFreed.message)).toBe(false);
    expect(CATALOG.progDoneFreed.message.toLowerCase()).toContain("moved to trash");
    expect(CATALOG.progDoneFreed.message.toLowerCase()).toContain("at least");
  });

  test("the run notification says what happened and when the space arrives", () => {
    // The only surface an unattended sweep reaches, so it carries both
    // halves on its own rather than pointing somewhere else for one.
    const body = CATALOG.notifLiveBody.message;
    expect(body.toLowerCase()).toContain("moved to trash");
    expect(body.toLowerCase()).toContain("at least");
    expect(body.toLowerCase()).toContain("when trash empties");
  });

  test("the Stats tile is no longer labelled with a claim it cannot make", () => {
    const html = read("stats.html");
    const tile = html.slice(html.indexOf('id="totalFreed"'));
    const label = tile.match(/<div class="stat-label">([^<]*)</)[1];
    expect(CLAIMS_FREED.test(label)).toBe(false);
    expect(label.toLowerCase()).toContain("trash");
  });

  test("the per-rule megabytes column says moved, not freed", () => {
    const headers = read("progress.html").match(/<th scope="col">([^<]*)</g).join(" ");
    expect(CLAIMS_FREED.test(headers)).toBe(false);
  });

  test("every surface that prints a delete run's megabytes ships the waiting block", () => {
    // The other half of the property. A page may say "moved to Trash"
    // only if the same page can also say how much is still down there
    // and open the door to it.
    for (const page of ["popup.html", "progress.html", "stats.html"]) {
      const html = read(page);
      expect([page, html.includes('class="trash-waiting"')]).toEqual([page, true]);
      expect([page, /Trash/.test(html)]).toEqual([page, true]);
    }
  });

  test("the popup carries it on the result card AND the Storage tab", () => {
    // 8.19: the popup is never the only place an end-of-run fact lives,
    // and inside the popup one tab is not the only place either.
    const html = read("popup.html");
    for (const id of ["resultTrashWaiting", "xrayTrashWaiting", "resultTrashBtn", "xrayTrashBtn"]) {
      expect([id, html.includes(`id="${id}"`)]).toEqual([id, true]);
    }
  });

  test("the waiting sentence is a floor, dated, and admits what it cannot see", () => {
    const note = CATALOG.trashWaitingNote.message.toLowerCase();
    expect(note).toContain("30 days");
    expect(note).toContain("this extension");
    expect(note).toContain("storage");
    // The hedge: no surface reads the mailbox, so none of them knows
    // about a Trash the user emptied by hand.
    expect(note).toContain("emptied yourself");
    for (const key of ["trashWaitingOne", "trashWaitingMany", "trashWaitingOneMb", "trashWaitingManyMb"]) {
      expect([key, CATALOG[key].message.toLowerCase().includes("at least")]).toEqual([key, true]);
    }
  });

  test("the door is offered in all seven catalogues", () => {
    for (const loc of ["en", "de", "es", "fr", "ja", "pt_BR", "ru"]) {
      const cat = JSON.parse(read(path.join("_locales", loc, "messages.json")));
      for (const key of ["trashOpenBtn", "trashWaitingNote", "trashWaitingManyMb", "launcherTrashWarn"]) {
        expect([loc, key, typeof cat[key]?.message]).toEqual([loc, key, "string"]);
      }
    }
  });
});

// ------------------------------------- the line the extension never crosses

describe("the extension explains Trash and never touches it", () => {
  // Comments in this codebase discuss Empty Trash at length, and a grep
  // over raw source would match the prose rather than the code. Strip
  // comments and string-free noise first, then look for a click path.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    .replace(/([^:])\/\/.*$/gm, "$1 ");

  const SHIPPED_JS = [
    "shared.js", "background.js", "popup.js", "contentScript.js",
    "gmailLauncher.js", "progress.js", "options.js", "diagnostics.js",
    "stats.js", "changelog.js"
  ];

  test("no shipped file has a click path aimed at an Empty Trash control", () => {
    // The three shapes that could reach one: a selector or lookup naming
    // the control, and any .click() on something found by that name.
    const AIMED = [
      /["'`][^"'`]*empty[\s_-]*trash[^"'`]*["'`]\s*\)?\s*\.?\s*click/i,
      /querySelector[^\n]{0,120}empty[\s_-]*trash/i,
      /(?:getElementById|closest|matches|xpath|evaluate)\([^)]{0,120}empty[\s_-]*trash/i,
      /delete[\s_-]*forever[^\n]{0,60}\.click\s*\(/i
    ];
    const hits = [];
    for (const f of SHIPPED_JS) {
      const src = stripComments(read(f));
      for (const re of AIMED) if (re.test(src)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  test("the launcher's Trash panel builds no selector into Gmail's page", () => {
    // It reads location.hash and nothing else. Anything that reaches
    // into Gmail's own tree from this view would be the start of
    // pointing at, highlighting, or pressing a control that is not ours.
    const src = stripComments(read("gmailLauncher.js"));
    const at = src.indexOf("const viewTrash");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("const viewIdle", at));
    for (const forbidden of ["document.querySelector", "document.evaluate", ".click(", "getElementById"]) {
      expect([forbidden, body.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  test("Trash, Spam and anywhere are still refused queries, in both files", () => {
    // The guard this release must not have loosened while adding a
    // feature whose whole subject is Trash.
    for (const f of ["contentScript.js", "shared.js"]) {
      const src = read(f);
      // The definition, not the first mention: both files discuss the
      // list in a comment above it.
      const at = src.indexOf("const DANGEROUS_QUERY_TOKENS = [");
      expect([f, at]).not.toEqual([f, -1]);
      const block = src.slice(at, src.indexOf("\n  ];", at));
      for (const token of ["in:trash", "label:trash", "in:spam", "label:spam", "in:anywhere"]) {
        expect([f, token, block.includes(token)]).toEqual([f, token, true]);
      }
    }
  });

  test("no run kind was added for Trash", () => {
    // The door navigates a tab. It starts nothing, injects nothing, and
    // takes no run claim.
    const src = stripComments(read("background.js"));
    const at = src.indexOf("async function armTrashHint");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("async function hideLauncher", at));
    for (const forbidden of ["executeScript", "contentScript.js", "ACTIVE_RUN", "runId"]) {
      expect([forbidden, body.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  test("nothing new reaches the network", () => {
    // release-check greps the zips for this and gates on zero. Checked
    // here too so a bad line fails in seconds rather than at packaging.
    for (const f of SHIPPED_JS) {
      const src = stripComments(read(f));
      for (const call of ["fetch(", "XMLHttpRequest", "sendBeacon", "navigator.connection"]) {
        expect([f, call, src.includes(call)]).toEqual([f, call, false]);
      }
    }
  });
});
