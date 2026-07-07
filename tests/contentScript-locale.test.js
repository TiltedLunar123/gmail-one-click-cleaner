/**
 * @jest-environment jsdom
 *
 * Locale-independence locks (7.4). docs/gmail-locale-audit.md classifies
 * every engine selector as structure/attribute-based or language-
 * dependent; this suite pins the structure-based ones by driving them
 * against non-English fixtures, so a future "helpful" refactor toward
 * text matching fails loudly here. The language-dependent gaps (the
 * unsubscribe text veto, rate-limit phrases, archive tokens) are 7.5
 * work and deliberately have no locks.
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

describe("locale locks: master checkbox is found by structure, not words", () => {
  test("a German-labelled toolbar checkbox beats a row checkbox on scoring alone", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div gh="mtb">
          <div role="checkbox" aria-checked="false" aria-label="Auswählen"></div>
        </div>
        <table role="grid">
          <tr role="row"><td role="gridcell">
            <span role="checkbox" aria-checked="false" aria-label="Konversation auswählen"></span>
          </td></tr>
        </table>
      </div>`;
    const { element } = I.findMasterCheckbox();
    expect(element).not.toBeNull();
    expect(element.getAttribute("aria-label")).toBe("Auswählen");
  });

  test("scoring rewards toolbar position without any English label at all", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb"><div id="cb" role="checkbox" aria-label="すべて選択"></div></div>`;
    const { score } = I.scoreCheckboxCandidate(document.getElementById("cb"));
    expect(score).toBeGreaterThan(0);
  });
});

describe("locale locks: selection counting reads classes and ARIA, not banners", () => {
  test("x7 rows count with only French text on the page", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <span>2 conversations sélectionnées</span>
        <table role="grid">
          <tr role="row" class="x7"><td role="gridcell"></td></tr>
          <tr role="row" class="x7"><td role="gridcell"></td></tr>
          <tr role="row"><td role="gridcell"></td></tr>
        </table>
      </div>`;
    expect(I.extractSelectedCount()).toBe(2);
  });

  test("aria-checked cross-check works with Russian row labels", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><table role="grid">
        <tr role="row"><td><span role="checkbox" aria-checked="true" aria-label="Выбрать"></span></td></tr>
        <tr role="row"><td><span role="checkbox" aria-checked="false" aria-label="Выбрать"></span></td></tr>
      </table></div>`;
    expect(I.extractSelectedCount()).toBe(1);
  });
});

describe("locale locks: empty results are detected structurally", () => {
  test("an empty grid is 'no results' with zero English on the page", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <span>Aucun message ne correspond à votre recherche</span>
        <table role="grid"></table>
      </div>`;
    expect(I.hasNoResults()).toBe(true);
  });

  test("Gmail's td.TC empty-state cell is recognized in any language", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><table><tr><td class="TC">検索条件に一致するメールはありません</td></tr></table></div>`;
    expect(I.hasNoResults()).toBe(true);
  });

  test("a populated grid is never mistaken for empty by foreign page text", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <span>Keine Ergebnisse? Doch!</span>
        <table role="grid"><tr role="row"><td role="gridcell">Angebot</td></tr></table>
      </div>`;
    expect(I.hasNoResults()).toBe(false);
    expect(I.getGridRowCount()).toBe(1);
  });
});

describe("locale locks: overflow menu discovery has a structural back-stop", () => {
  test("an uncovered-locale More button is still found through aria-haspopup", () => {
    const I = loadEngine();
    // Czech is not in MORE_OPTIONS_TOKENS or the inline regex.
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="Smazat"></div>
        <div role="button" aria-label="Další možnosti e-mailu" aria-haspopup="true"></div>
      </div>`;
    const btn = I.findMoreOptionsButton();
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Další možnosti e-mailu");
  });
});

describe("locale locks: row sampling is attribute-only", () => {
  test("subscription scan rows extract email/name attributes under non-Latin names", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><table role="grid">
        <tr role="row"><td><span email="news@example.co.jp" name="株式会社ニュース">株式会社ニュース</span></td></tr>
        <tr role="row"><td><span email="promo@пример.рф" name="Промо">Промо</span></td></tr>
        <tr role="row"><td><span>no email attribute, skipped</span></td></tr>
      </table></div>`;
    const rows = I.sampleSubscriptionRows();
    expect(rows).toEqual([
      { email: "news@example.co.jp", name: "株式会社ニュース" },
      { email: "promo@пример.рф", name: "Промо" }
    ]);
  });

  test("undo-log sampling reads email and data-legacy-thread-id attributes", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><table role="grid">
        <tr role="row" data-legacy-thread-id="17c2a9"><td>
          <span email="alte-werbung@example.de" name="Alte Werbung">Alte Werbung</span>
        </td></tr>
        <tr role="row" data-legacy-thread-id="17c2aa"><td>
          <span email="offres@example.fr" name="Offres">Offres</span>
        </td></tr>
      </table></div>`;
    const out = I.sampleListRows({ maxSamples: 10 });
    expect(out.senders).toEqual(["alte-werbung@example.de", "offres@example.fr"]);
    expect(out.threadIds).toEqual(["17c2a9", "17c2aa"]);
  });

  test("storage scan folding is arithmetic over sampled attributes, no text", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><table role="grid">
        <tr role="row"><td><span email="video@example.kr" name="영상 서비스">영상 서비스</span></td></tr>
        <tr role="row"><td><span email="video@example.kr" name="영상 서비스">영상 서비스</span></td></tr>
      </table></div>`;
    const bySender = I.foldStorageSample(new Map(), I.sampleSubscriptionRows(), 25);
    expect(bySender.get("video@example.kr")).toEqual({
      email: "video@example.kr",
      name: "영상 서비스",
      count: 2,
      estMb: 50
    });
  });
});

describe("locale locks: unsubscribe control's structural half", () => {
  test("span.Ca is the primary hit when its text matches (English today)", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><span class="Ca" role="link">Unsubscribe</span></div>`;
    const el = I.findHeaderUnsubscribeControl();
    expect(el).not.toBeNull();
    expect(el.className).toBe("Ca");
  });

  test("documented 7.5 gap: the English text veto rejects a localized span.Ca", () => {
    // This pins the CURRENT behavior so the 7.5 fix (trusting span.Ca
    // structurally) shows up as a deliberate test change, not a silent one.
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><span class="Ca" role="link">Cancelar suscripción</span></div>`;
    expect(I.findHeaderUnsubscribeControl()).toBeNull();
  });
});
