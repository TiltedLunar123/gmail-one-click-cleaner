/**
 * @jest-environment jsdom
 *
 * Restore run (7.6): the engine that moves a logged run's mail back to
 * the Inbox. The safety rules under test, in order of importance:
 *
 *   1. INVERSE SAFETY. The Trash toolbar also holds "Delete forever".
 *      Every restore finder must refuse a deny-listed candidate no
 *      matter how well it scores on the move-back tokens, and the deny
 *      scan must read every label surface (aria-label, tooltip, title,
 *      text), not just the first non-empty one.
 *   2. Exact whole-text where a wrong click is possible: the "Move to"
 *      opener and the Inbox menu item never substring-match.
 *   3. An uncovered locale does nothing: no control found means no
 *      click anywhere, and the pass reports that honestly.
 *   4. Empty results are a finished restore, not an error.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

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

describe("sanitizeConfig restore fields (7.6)", () => {
  test("accepts the restoreRun kind", () => {
    const I = loadEngine();
    expect(I.sanitizeConfig({ runKind: "restoreRun" }).runKind).toBe("restoreRun");
  });

  test("strips double quotes from the label so it cannot escape the query term", () => {
    const I = loadEngine();
    const out = I.sanitizeConfig({
      restoreLabel: '  GmailCleaner - "Promos" OR in:inbox  ',
      restoreAction: "archive"
    });
    expect(out.restoreLabel).toBe("GmailCleaner - Promos OR in:inbox");
    expect(out.restoreAction).toBe("archive");
  });

  test("defaults: empty label, delete action, cleanup kind", () => {
    const I = loadEngine();
    const out = I.sanitizeConfig({});
    expect(out.restoreLabel).toBe("");
    expect(out.restoreAction).toBe("delete");
    expect(out.runKind).toBe("cleanup");
  });

  test("restoreAction only accepts the two logged modes", () => {
    const I = loadEngine();
    expect(I.sanitizeConfig({ restoreAction: "purge" }).restoreAction).toBe("delete");
  });
});

describe("buildRestoreQuery", () => {
  test("delete mode searches Trash for the quoted label", () => {
    const I = loadEngine();
    expect(I.buildRestoreQuery("GmailCleaner - Promotions", "delete"))
      .toBe('in:trash label:"GmailCleaner - Promotions"');
  });

  test("archive mode searches the label excluding the Inbox", () => {
    const I = loadEngine();
    expect(I.buildRestoreQuery("GmailCleaner - Social", "archive"))
      .toBe('label:"GmailCleaner - Social" -in:inbox');
  });

  test("embedded quotes are stripped, empty labels build nothing", () => {
    const I = loadEngine();
    expect(I.buildRestoreQuery('a"b" c', "delete")).toBe('in:trash label:"ab c"');
    expect(I.buildRestoreQuery("", "delete")).toBe("");
    expect(I.buildRestoreQuery('  "  ', "archive")).toBe("");
  });
});

describe("deny-list: isDeleteForeverLabel / hasDeleteForeverMarking", () => {
  test.each([
    ["en", "Delete forever"],
    ["es", "Eliminar definitivamente"],
    ["de", "Endgültig löschen"],
    ["pl", "Usuń na zawsze"],
    ["ru", "Удалить навсегда"],
    ["ja", "完全に削除"],
    ["zh-TW", "永久刪除"]
  ])("%s: the researched string is refused", (_lang, label) => {
    const I = loadEngine();
    expect(I.isDeleteForeverLabel(label)).toBe(true);
  });

  test("substring on the deny side: merged wording is still refused", () => {
    const I = loadEngine();
    expect(I.isDeleteForeverLabel("Delete forever (empty trash)")).toBe(true);
    expect(I.isDeleteForeverLabel("Ausgewählte Nachrichten endgültig löschen")).toBe(true);
  });

  test("ordinary controls are not refused", () => {
    const I = loadEngine();
    expect(I.isDeleteForeverLabel("Move to Inbox")).toBe(false);
    expect(I.isDeleteForeverLabel("Delete")).toBe(false);
    expect(I.isDeleteForeverLabel("")).toBe(false);
  });

  test("the marking scan reads tooltip and title, not just aria-label", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div id="a" role="button" aria-label="Bulk action" data-tooltip="Delete forever"></div>
        <div id="b" role="button" aria-label="Bulk action" title="Supprimer définitivement"></div>
        <div id="c" role="button">永久删除</div>
        <div id="d" role="button" aria-label="Archive"></div>
      </div>`;
    expect(I.hasDeleteForeverMarking(document.getElementById("a"))).toBe(true);
    expect(I.hasDeleteForeverMarking(document.getElementById("b"))).toBe(true);
    expect(I.hasDeleteForeverMarking(document.getElementById("c"))).toBe(true);
    expect(I.hasDeleteForeverMarking(document.getElementById("d"))).toBe(false);
  });
});

describe("findMoveToInboxButton (direct control)", () => {
  test("finds the English button among Trash toolbar siblings", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="Delete forever"></div>
        <div role="button" aria-label="Move to Inbox"></div>
        <div role="button" aria-label="Labels"></div>
      </div>`;
    const btn = I.findMoveToInboxButton();
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Move to Inbox");
  });

  test.each([
    ["de", "In Posteingang verschieben", "Endgültig löschen"],
    ["tr", "Gelen Kutusuna Taşı", "Kalıcı olarak sil"],
    ["ru", "Поместить во входящие", "Удалить навсегда"],
    ["ko", "받은편지함으로 이동", "영구 삭제"]
  ])("%s: the localized button wins over its localized Delete forever sibling", (_lang, move, deleteForever) => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="${deleteForever}"></div>
        <div role="button" aria-label="${move}"></div>
      </div>`;
    const btn = I.findMoveToInboxButton();
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe(move);
  });

  test("a label carrying the full phrase plus a shortcut hint still matches", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb"><div role="button" aria-label="Flytta till inkorgen (v)"></div></div>`;
    expect(I.findMoveToInboxButton()).not.toBeNull();
  });

  test("DENY-LIST HOLDS: a Delete forever button that would win on score is refused", () => {
    const I = loadEngine();
    // The poisoned control matches a move token EXACTLY (score 5), the
    // legitimate one only via the suffix form (score 2). Without the
    // veto the poisoned control wins the contest outright; the tooltip
    // is what gives it away, so the veto must read beyond aria-label.
    document.body.innerHTML = `
      <div gh="mtb">
        <div id="poisoned" role="button" aria-label="Move to Inbox" data-tooltip="Delete forever"></div>
        <div id="legit" role="button" aria-label="Move to Inbox (v)"></div>
      </div>`;
    const btn = I.findMoveToInboxButton();
    expect(btn).not.toBeNull();
    expect(btn.id).toBe("legit");
  });

  test("DENY-LIST HOLDS: when the deny-listed control is the only scoring candidate, nothing is picked", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="Move to Inbox and delete forever"></div>
        <div role="button" aria-label="Labels"></div>
      </div>`;
    expect(I.findMoveToInboxButton()).toBeNull();
  });

  test("single localized words never match: the tokens are full phrases", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb"><div role="button" aria-label="Inbox"></div></div>`;
    expect(I.findMoveToInboxButton()).toBeNull();
  });
});

describe("findMoveToMenuButton (menu opener, exact whole text only)", () => {
  test.each([
    ["en", "Move to"],
    ["fr", "Déplacer vers"],
    ["ja", "移動"],
    ["zh", "移至"]
  ])("%s: the exact opener label is found", (_lang, label) => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="Delete forever"></div>
        <div role="button" aria-label="${label}"></div>
      </div>`;
    const btn = I.findMoveToMenuButton();
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe(label);
  });

  test("substring never matches: short tokens cannot grab unrelated controls", () => {
    const I = loadEngine();
    // "タブへ移動" contains the ja opener token "移動" but is a different
    // control; exact matching must leave it alone.
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="タブへ移動"></div>
        <div role="button" aria-label="Déplacer vers la corbeille"></div>
      </div>`;
    expect(I.findMoveToMenuButton()).toBeNull();
  });

  test("a deny-listed opener is refused even with an exact-looking label", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="Move to" title="Delete forever"></div>
      </div>`;
    expect(I.findMoveToMenuButton()).toBeNull();
  });
});

describe("findInboxMenuItemIn (menu destination, exact whole text only)", () => {
  const menu = (items) => {
    document.body.innerHTML = `
      <div role="menu">${items.map((t) => `<div role="menuitem">${t}</div>`).join("")}</div>`;
    return document.querySelector("div[role='menu']");
  };

  test.each([
    ["es", "Recibidos"],
    ["fr", "Boîte de réception"],
    ["pl", "Odebrane"],
    ["ar", "البريد الوارد"],
    ["zh-CN", "收件箱"]
  ])("%s: the localized Inbox item is found among user labels", (_lang, inbox) => {
    const I = loadEngine();
    const m = menu(["GmailCleaner - Promotions", inbox, "Receipts"]);
    const item = I.findInboxMenuItemIn(m);
    expect(item).not.toBeNull();
    expect(item.textContent).toBe(inbox);
  });

  test("a user label merely containing the word never matches", () => {
    const I = loadEngine();
    expect(I.findInboxMenuItemIn(menu(["Inbox zero tips", "My Inbox backup"]))).toBeNull();
  });

  test("a deny-marked item is skipped no matter its text", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="menu">
        <div role="menuitem" title="Delete forever">Inbox</div>
      </div>`;
    expect(I.findInboxMenuItemIn(document.querySelector("div[role='menu']"))).toBeNull();
  });

  test("returns null for a missing or empty menu", () => {
    const I = loadEngine();
    expect(I.findInboxMenuItemIn(null)).toBeNull();
    expect(I.findInboxMenuItemIn(menu([]))).toBeNull();
  });
});

describe("restoreCurrentPage: honest no-ops and hard signals", () => {
  // Rows arrive pre-selected (aria-checked="true") so the selection
  // step succeeds in jsdom without simulating Gmail's checkbox logic;
  // what is under test here is what happens AFTER selection.
  const SELECTED_ROWS = `
    <table role="grid">
      <tr role="row" class="x7"><td role="gridcell">
        <span role="checkbox" aria-checked="true"></span> Old promo one
      </td></tr>
      <tr role="row" class="x7"><td role="gridcell">
        <span role="checkbox" aria-checked="true"></span> Old promo two
      </td></tr>
    </table>`;

  test("uncovered locale DOES NOTHING: no control found, no click fired, honest reason", async () => {
    const I = loadEngine();
    // Czech toolbar: no restore token covers it, and the delete-forever
    // deny string for Czech is deliberately unresearched. The finders
    // must come up empty and, critically, never click anything.
    document.body.innerHTML = `
      <div role="main">
        <div gh="mtb">
          <div id="czDelete" role="button" aria-label="Smazat navždy"></div>
          <div id="czMove" role="button" aria-label="Přesunout do složky"></div>
        </div>
        ${SELECTED_ROWS}
      </div>`;
    const clicks = [];
    for (const el of document.querySelectorAll("[role='button']")) {
      el.addEventListener("click", () => clicks.push(el.id));
    }
    const result = await I.restoreCurrentPage();
    expect(result).toEqual({ moved: false, count: 0, reason: "no-restore-control" });
    expect(clicks).toEqual([]);
  });

  test("deny fixture end to end: the poisoned exact-match control is never clicked", async () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div gh="mtb">
          <div id="poisoned" role="button" aria-label="Move to Inbox" data-tooltip="Delete forever"></div>
        </div>
        ${SELECTED_ROWS}
      </div>`;
    const clicks = [];
    document.getElementById("poisoned").addEventListener("click", () => clicks.push("poisoned"));
    const result = await I.restoreCurrentPage();
    expect(result).toEqual({ moved: false, count: 0, reason: "no-restore-control" });
    expect(clicks).toEqual([]);
  });

  test("empty results end the pass as finished, not as an error", async () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div gh="mtb"><div role="button" aria-label="Move to Inbox"></div></div>
        <table role="grid"></table>
      </div>`;
    const result = await I.restoreCurrentPage();
    expect(result).toEqual({ moved: false, count: 0, reason: "no-results" });
  });

  test("rows on screen with no selection control raise the layout-change signal", async () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div gh="mtb"><div role="button" aria-label="Move to Inbox"></div></div>
        <table role="grid">
          <tr role="row"><td role="gridcell">Old promo</td></tr>
        </table>
      </div>`;
    let thrown = null;
    try {
      await I.restoreCurrentPage();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.name).toBe("GmailLayoutError");
    expect(thrown.code).toBe("gmail_layout_changed");
  });
});

describe("driveMoveBackControl: menu strategy stays inside the menu", () => {
  test("prefers the direct button when both shapes exist", async () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div id="direct" role="button" aria-label="Move to Inbox"></div>
        <div id="opener" role="button" aria-label="Move to"></div>
      </div>`;
    const clicks = [];
    document.getElementById("direct").addEventListener("click", () => clicks.push("direct"));
    document.getElementById("opener").addEventListener("click", () => clicks.push("opener"));
    const out = await I.driveMoveBackControl();
    expect(out).toEqual({ clicked: true, how: "direct" });
    expect(clicks).toEqual(["direct"]);
  });

  test("reports no-restore-control when neither shape exists", async () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb"><div role="button" aria-label="Labels"></div></div>`;
    const out = await I.driveMoveBackControl();
    expect(out).toEqual({ clicked: false, reason: "no-restore-control" });
  });
});
