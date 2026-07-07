/**
 * @jest-environment jsdom
 *
 * Locale-independence locks (7.4) and the 7.5 locale release. The docs/
 * gmail-locale-audit.md audit classifies every engine selector as
 * structure/attribute-based or language-dependent; this suite pins the
 * structure-based ones by driving them against non-English fixtures, so
 * a future "helpful" refactor toward text matching fails loudly here.
 * 7.5 closed the audited gaps (the unsubscribe text veto, dialog button
 * classification, rate-limit phrases, archive/label tokens, the scan's
 * English search term); those paths are locked below too.
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

describe("locale locks: unsubscribe control is trusted structurally (7.5)", () => {
  test("span.Ca is the primary hit with English text", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><span class="Ca" role="link">Unsubscribe</span></div>`;
    const el = I.findHeaderUnsubscribeControl();
    expect(el).not.toBeNull();
    expect(el.className).toBe("Ca");
  });

  test("7.5 gap closed: a localized span.Ca is trusted without a text check", () => {
    // Deliberate flip of the 7.4 lock that pinned the English text veto.
    // The veto killed the Pro unsubscribe path on every non-English
    // account; the class itself is what Gmail renders in every locale.
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><span class="Ca" role="link">Cancelar suscripción</span></div>`;
    const el = I.findHeaderUnsubscribeControl();
    expect(el).not.toBeNull();
    expect(el.className).toBe("Ca");
  });

  test("a span.Ca inside the sender-controlled message body is never driven", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><div class="a3s"><span class="Ca" role="link">Unsubscribe</span></div></div>`;
    expect(I.findHeaderUnsubscribeControl()).toBeNull();
  });

  test("a span.Ca inside a list row is never driven", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><table><tr role="row"><td><span class="Ca" role="link">Unsubscribe</span></td></tr></table></div>`;
    expect(I.findHeaderUnsubscribeControl()).toBeNull();
  });

  test("the fallback link scan accepts an exact localized label", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><span role="link">Se désabonner</span></div>`;
    expect(I.findHeaderUnsubscribeControl()).not.toBeNull();
  });

  test("the fallback link scan stays exact: extra words do not match", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><span role="link">Se désabonner maintenant</span></div>`;
    expect(I.findHeaderUnsubscribeControl()).toBeNull();
  });
});

describe("7.5: unsubscribe dialog classification per locale", () => {
  const dialog = (buttons) => {
    document.body.innerHTML = `
      <div role="alertdialog">${buttons.map((b) => `<button>${b}</button>`).join("")}</div>`;
    return document.querySelector("div[role='alertdialog']");
  };

  test.each([
    ["es", "Cancelar", "Darse de baja"],
    ["fr", "Annuler", "Se désabonner"],
    ["de", "Abbrechen", "Abbestellen"],
    ["pt", "Cancelar", "Cancelar inscrição"],
    ["ru", "Отмена", "Отказаться от рассылки"],
    ["ja", "キャンセル", "登録解除"],
    ["ko", "취소", "수신 거부"]
  ])("%s: confirm dialog classifies confirm and cancel", (_lang, cancel, confirm) => {
    const I = loadEngine();
    const out = I.resolveUnsubscribeDialog(dialog([cancel, confirm]));
    expect(out.kind).toBe("confirm");
    expect(out.confirmBtn.textContent).toBe(confirm);
    expect(out.cancelBtn.textContent).toBe(cancel);
  });

  test("prefix pairs stay apart: Arabic cancel is a prefix of the confirm label", () => {
    const I = loadEngine();
    const out = I.resolveUnsubscribeDialog(dialog(["إلغاء", "إلغاء الاشتراك"]));
    expect(out.kind).toBe("confirm");
    expect(out.confirmBtn.textContent).toBe("إلغاء الاشتراك");
    expect(out.cancelBtn.textContent).toBe("إلغاء");
  });

  test("prefix pairs stay apart: zh-TW cancel is a prefix of the confirm label", () => {
    const I = loadEngine();
    const out = I.resolveUnsubscribeDialog(dialog(["取消", "取消訂閱"]));
    expect(out.kind).toBe("confirm");
    expect(out.confirmBtn.textContent).toBe("取消訂閱");
    expect(out.cancelBtn.textContent).toBe("取消");
  });

  test.each([
    ["es", "Cancelar", "Ir al sitio web"],
    ["de", "Abbrechen", "Website aufrufen"],
    ["ja", "キャンセル", "ウェブサイトに移動"]
  ])("%s: go-to-website hand-off classifies as manual", (_lang, cancel, website) => {
    const I = loadEngine();
    const out = I.resolveUnsubscribeDialog(dialog([cancel, website]));
    expect(out.kind).toBe("manual");
    expect(out.confirmBtn).toBeNull();
  });

  test("substring never classifies: 'Unsubscribe and block' is not a confirm", () => {
    const I = loadEngine();
    const out = I.resolveUnsubscribeDialog(dialog(["Unsubscribe and block"]));
    expect(out.kind).toBe("unknown");
    expect(out.confirmBtn).toBeNull();
  });

  test("substring never classifies: a superstring of a cancel token is not a cancel", () => {
    const I = loadEngine();
    const out = I.resolveUnsubscribeDialog(dialog(["Cancelar suscripción"]));
    expect(out.kind).toBe("unknown");
    expect(out.cancelBtn).toBeNull();
  });

  test("an uncovered locale stays unknown instead of guessing", () => {
    // Czech is deliberately not in the token tables; the run dismisses
    // the dialog via Escape and reports the sender unconfirmed.
    const I = loadEngine();
    const out = I.resolveUnsubscribeDialog(dialog(["Zrušit", "Odhlásit odběr"]));
    expect(out.kind).toBe("unknown");
    expect(out.confirmBtn).toBeNull();
  });

  test("whitespace is normalized before the exact match", () => {
    const I = loadEngine();
    const out = I.resolveUnsubscribeDialog(dialog(["  Darse   de\n baja  "]));
    expect(out.kind).toBe("confirm");
  });
});

describe("7.5: rate-limit detection reads localized throttle phrases", () => {
  test("a German throttle banner engages detection", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="alert">Zu viele Anfragen. Bitte versuche es später erneut.</div>`;
    expect(I.findRateLimitText()).toContain("Zu viele Anfragen");
  });

  test("a Russian aria-live error engages detection", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div aria-live="polite">Произошла ошибка. Повторите попытку позже.</div>`;
    expect(I.findRateLimitText()).toContain("Произошла ошибка");
  });

  test("ordinary localized status text is not mistaken for throttling", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="alert">42 Konversationen ausgewählt</div>`;
    expect(I.findRateLimitText()).toBeNull();
  });
});

describe("7.5: widened toolbar token tables", () => {
  test("a Turkish archive button is found among Turkish siblings", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="Sil"></div>
        <div role="button" aria-label="Arşivle"></div>
      </div>`;
    const btn = I.findArchiveButton();
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Arşivle");
  });

  test("a Korean archive button is found", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb"><div role="button" aria-label="보관처리"></div></div>`;
    expect(I.findArchiveButton()).not.toBeNull();
  });

  test("a Russian labels button is found", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb">
        <div role="button" aria-label="Удалить"></div>
        <div role="button" aria-label="Ярлыки"></div>
      </div>`;
    const btn = I.findLabelButton();
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Ярлыки");
  });

  test("a pt-BR Marcadores button is found", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb"><div role="button" aria-label="Marcadores"></div></div>`;
    expect(I.findLabelButton()).not.toBeNull();
  });
});

describe("7.5: subscription scan term follows the Gmail UI language", () => {
  afterEach(() => {
    document.documentElement.lang = "";
  });

  test.each([
    ["", "unsubscribe"],
    ["en-US", "unsubscribe"],
    ["de", "abbestellen"],
    ["pt-BR", "cancelar inscrição"],
    ["zh-CN", "退订"],
    ["zh-TW", "取消訂閱"],
    ["cs", "unsubscribe"]
  ])("lang '%s' picks '%s' (uncovered locales fall back to English)", (lang, term) => {
    const I = loadEngine();
    document.documentElement.lang = lang;
    expect(I.getSubscriptionSearchTerm()).toBe(term);
  });

  test("only the body-text query is localized; the category queries are unchanged", () => {
    const I = loadEngine();
    document.documentElement.lang = "de";
    const queries = I.buildSubscriptionScanQueries();
    expect(queries).toEqual([
      "\"abbestellen\" newer_than:1y",
      "category:promotions newer_than:1y",
      "category:updates \"unsubscribe\" newer_than:1y"
    ]);
  });
});
