/**
 * @jest-environment node
 *
 * 9.1's retention surfaces: the erase control on the Options page and the
 * stored-data card on Diagnostics. Every test here fails on 95eaed0.
 *
 * Neither page calls GCC.i18n.apply, so neither carries data-i18n and
 * neither has catalogue keys. That is why every string below is asserted
 * as inline English: an attribute on these pages would be inert at
 * runtime while still forcing a key into all seven locales.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const OPTIONS_HTML = read("options.html");
const OPTIONS = read("options.js");
const DIAG_HTML = read("diagnostics.html");
const DIAG = read("diagnostics.js");

const stripComments = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const between = (src, startName, endName) => {
  const clean = stripComments(src);
  const start = clean.indexOf(startName);
  if (start === -1) throw new Error(`not found: ${startName}`);
  const end = clean.indexOf(endName, start + startName.length);
  if (end === -1) throw new Error(`end not found: ${endName}`);
  return clean.slice(start, end);
};

describe("the confirm dialog takes its words rather than owning them", () => {
  test("it requires all four strings, with no defaults for a caller to inherit", () => {
    // With defaults, a future third caller silently shows somebody else's
    // wording on a destructive button, which is the specific failure this
    // is designed against.
    expect(OPTIONS).toContain("const showConfirmDialog = ({ title, body, confirmLabel, fallback }) =>");
    const fn = between(OPTIONS, "const showConfirmDialog =", "const restoreDefaults =");
    expect(fn).toContain('titleEl.textContent = title');
    expect(fn).toContain('bodyEl.textContent = body');
    expect(fn).toContain('confirmBtn.textContent = confirmLabel');
    // The no-dialog branch takes the caller's words too. It used to carry
    // the restore-defaults sentence hardcoded, and it is not dead code:
    // it is the branch jsdom reaches.
    expect(fn).toContain("resolve(confirm(fallback));");
  });

  test("a leftover answer cannot resolve the next dialog", () => {
    // dialog.returnValue survives a close. A stale "confirm" from the
    // restore dialog resolving the erase dialog is an erase that runs
    // without consent.
    const fn = between(OPTIONS, "const showConfirmDialog =", "const restoreDefaults =");
    expect(fn).toContain('dialog.returnValue = ""');
    expect(fn.indexOf('dialog.returnValue = ""')).toBeLessThan(fn.indexOf("dialog.showModal()"));
  });

  test("both callers pass every string", () => {
    for (const caller of ["const restoreDefaults =", "const eraseStoredData ="] ) {
      const fn = between(OPTIONS, caller, "\n  const ");
      for (const key of ["title:", "body:", "confirmLabel:", "fallback:"]) {
        expect(fn).toContain(key);
      }
    }
  });
});

describe("the erase control", () => {
  test("the section is on the page, in plain English, with no version label", () => {
    expect(OPTIONS_HTML).toContain('id="eraseStoresBtn"');
    expect(OPTIONS_HTML).toContain('id="storedDataTitle"');
    expect(OPTIONS_HTML).toContain('id="erase-stores-hint"');
    // options.html has zero data-i18n and never calls GCC.i18n.apply.
    expect(OPTIONS_HTML).not.toContain("data-i18n");
    // version.test.js pins that this page announces no version.
    expect(OPTIONS_HTML).not.toMatch(/aria-label="Version \d/);
  });

  test("the confirmation names the consequence the user would meet later", () => {
    const fn = between(OPTIONS, "const eraseStoredData =", "\n  const ");
    expect(fn).toContain("Scheduled ");
    expect(fn.toLowerCase()).toContain("export does not back");
  });

  test("it goes through the worker and never writes storage itself", () => {
    // All three receipts writers are read-modify-write inside the
    // worker's queue, so an unlocked write from this page landing between
    // the read and the set is overwritten in full and the whole ledger
    // comes back.
    const fn = between(OPTIONS, "const eraseStoredData =", "\n  const ");
    expect(fn).toContain('GCC.sendMessage({ type: "gmailCleanerEraseStores" })');
    expect(fn).not.toContain("chrome.storage");
    expect(fn).not.toContain("GCC.storageSet");
  });

  test("it reads resp.ok rather than trusting a resolved await", () => {
    // GCC.sendMessage resolves an error rather than rejecting, so
    // awaiting it successfully says nothing about whether the write
    // landed. Toasting success over a write that did not land is 8.20.
    const fn = between(OPTIONS, "const eraseStoredData =", "\n  const ");
    expect(fn).toContain("resp?.ok");
    expect(fn).toContain("Nothing was erased");
    // The erase is immediate and is not part of collectAllData, so the
    // dirty flag would point the user at a Save button that knows nothing
    // about it.
    expect(fn).not.toContain("markUnsaved");
  });

  test("the button is wired", () => {
    expect(OPTIONS).toContain('GCC.$("eraseStoresBtn")');
    expect(OPTIONS).toContain('eraseBtn?.addEventListener("click", eraseStoredData)');
  });
});

describe("the diagnostics card shows counts and never an address", () => {
  test("every new id is registered in both maps, under the same key", () => {
    // The elements cache resolves once at parse time and a name that
    // disagrees with SELECTORS is silent.
    for (const key of ["storesTag", "storesCensusCount", "storesCensusAt",
      "storesReceiptCount", "storesReceiptAt", "storesTicked"]) {
      expect(DIAG_HTML).toContain(`id="${key}"`);
      expect(DIAG).toContain(`${key}: "${key}"`);
      expect(DIAG).toContain(`${key}: GCC.$(SELECTORS.${key})`);
    }
  });

  test("nothing it renders can reach the clipboard", () => {
    // THE MECHANISM, and it is narrower than it looks. copyLog joins the
    // in-memory logHistory array, and addLog is the only thing that
    // appends to it. Writing a number into a DOM node does not reach the
    // clipboard and calling addLog does, and the two look identical at
    // the call site. So the rule is that this function never calls
    // addLog, which is a stronger assertion than searching the file for
    // an "@" would be.
    const fn = between(DIAG, "const renderStores =", "const renderLayoutChangeNotice =");
    expect(fn).not.toContain("addLog(");
  });

  test("the sender count is the whole list, not the measured subset", () => {
    // GCC.census.totals filters to `.measured` first, so on a partial
    // scan it would report fewer senders than the erase button is about
    // to delete.
    const fn = between(DIAG, "const renderStores =", "const renderLayoutChangeNotice =");
    expect(fn).toContain("census.senders.length");
    expect(fn).not.toContain("GCC.census.totals");
  });

  test("the receipts stamp says written, not checked", () => {
    // writeReceiptList refreshes that stamp on a clear that adds no
    // receipt, so it is a write stamp and labelling it as a data-age
    // stamp would read a ledger at maximum value as maximum staleness.
    expect(DIAG_HTML).toContain("Receipts last written");
    expect(DIAG_HTML).not.toContain("Receipts last checked");
  });

  test("the card never hides itself", () => {
    // A user who has just erased and wants to confirm it worked must not
    // find the card gone. It says "nothing stored" instead.
    const fn = between(DIAG, "const renderStores =", "const renderLayoutChangeNotice =");
    expect(fn).not.toContain(".hidden = ");
    // "these are empty", not "nothing stored". The card covers the two
    // stores the Erase button clears plus the four tick lists; the
    // mailbox report and the subscription, storage and suggestion scans
    // hold sender addresses too and are outside both. A chip reading
    // "nothing stored" over a mailbox report full of top senders would
    // be exactly the overclaim this card exists to avoid.
    expect(fn).toContain("these are empty");
    expect(fn).not.toContain("nothing stored");
  });

  test("it repaints on init and when a run finishes", () => {
    // A card whose whole subject is staleness must not go stale in front
    // of the user.
    expect(DIAG).toContain("renderStores()");
    const init = between(DIAG, "await Promise.allSettled([", "]);");
    expect(init).toContain("renderStores()");
    expect(DIAG).toContain("renderStores().catch(console.error);");
  });
});

describe("the diagnostics dump carries no address at all", () => {
  test("test inject no longer returns the Gmail tab title or its full URL", () => {
    // A Gmail tab title reads "Inbox (12) - you@gmail.com - Gmail" and a
    // search URL carries the query in its fragment, and the payload went
    // straight into the log that Copy Diagnostics puts on the clipboard.
    // The card's claim that no address is copied is only true once this
    // is true.
    const fn = between(DIAG, "const testInject =", "\n  const ");
    expect(fn).not.toContain("document.title");
    expect(fn).not.toContain("location.href");
    expect(fn).toContain("location.origin");
    expect(fn).toContain("location.pathname");
  });
});
