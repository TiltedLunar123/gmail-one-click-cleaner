/**
 * @jest-environment jsdom
 *
 * 8.21, engine side. Five fixes, and the thread running through four of
 * them is the same one: a number or a signal read out of MAIL rather than
 * out of Gmail's chrome.
 *
 * The counter that sizes every guardrail, the selection count that arms
 * the layout tripwire, the offer that unlocks bulk selection, and the
 * refusal list that keeps a run out of Trash. Each is driven here against
 * the real engine over a real (jsdom) Gmail page, because each was
 * previously held by a source-text pin that could not tell the difference
 * between a guard and a comment about a guard.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

let sent;

function installChrome() {
  const runtime = {
    id: "test-extension-id",
    lastError: null,
    getURL: (p) => `chrome-extension://test/${p}`,
    sendMessage: (msg) => {
      sent.push(msg);
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener: () => {} }
  };
  global.chrome = {
    runtime,
    storage: {
      sync: { get: (key, cb) => cb({}) },
      local: { get: (_k, cb) => cb({}), set: (_o, cb) => cb && cb() }
    }
  };
}

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

beforeEach(() => {
  sent = [];
  installChrome();
});

afterEach(() => {
  delete global.chrome;
});

// =====================================================================
// 1. The match total, which sizes every guardrail
// =====================================================================

describe("the results counter cannot be read out of a subject line", () => {
  // 8.16 gave the "of N" branch two structural conditions. The range
  // branch below it still took any range plus any larger number in the
  // same short string, and estimateTotalResults searched the conversation
  // list. So on the one case the guardrails exist for -- the toolbar
  // reading "1-50 of many", where parseCountFromText correctly returns
  // null -- an ordinary promotional subject supplied the number instead.
  //
  // That is worse than a misreported figure. matchTotalUnknown is what
  // raises "Gmail did not report how many conversations this delete would
  // reach"; a wrong answer here means the confirmation never appears.

  const REAL_COUNTERS = [
    ["1–50 of 12,438", 12438],
    ["Showing 1-50 of 12,438", 12438],
    ["1–50 of about 3,200", 3200],
    ["1-12 of 12", 12],
    ["1–50 von 5.000", 5000],
    // Several locales append the noun. End-anchoring the total would
    // have started returning null on these, and a null match total makes
    // an unattended run decline.
    ["1–50 von 5.000 Konversationen", 5000],
    ["1-50 di 3.200 conversazioni", 3200],
    ["1–50 sur 3 200", 3200],
    ["1–50 из 12 438", 12438],
    // Total-first forms.
    ["12,438 件中 1～50 件", 12438],
    ["共 12,438 个会话，1-50", 12438],
    ["About 500 results", 500]
  ];

  const PROSE = [
    // The exact shape that reached the guardrail.
    "Sale 10-20% off: 5000 items left",
    "Save 10-15%, over 2000 sold",
    "Win 1-2 prizes, 5000 winners!",
    // A clean " of " connector is not enough on its own.
    "Your order 1-2 of 3000 shipped today",
    // Pins 8.16 already held, kept so this branch cannot regress them.
    "Best of 2024",
    "Invoice 2 of 3",
    "Part 3 of 12",
    // The "about N results" branch used to match mid-sentence.
    "Read about 500 results from our study"
  ];

  test.each(REAL_COUNTERS)("reads %s as %i", (text, expected) => {
    const I = loadEngine();
    expect(I.parseCountFromText(text)).toBe(expected);
  });

  test.each(PROSE)("refuses %s", (text) => {
    const I = loadEngine();
    expect(I.parseCountFromText(text)).toBeNull();
  });

  test("estimateTotalResults never reads a conversation row, whatever it says", () => {
    const I = loadEngine();
    // Toolbar present but unreadable, which is the case the fallback
    // exists for and the case the bug needed.
    document.body.innerHTML = `
      <div gh="mtb"><span>1–50 of many</span></div>
      <div role="main">
        <table role="grid">
          <tr role="row"><td><span>Sale 10-20% off: 5000 items left</span></td></tr>
        </table>
      </div>`;

    expect(I.estimateTotalResults()).toBeNull();
  });

  test("and still reads the real counter when the toolbar has one", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div gh="mtb"><span>1–50 of 12,438</span></div>
      <div role="main">
        <table role="grid">
          <tr role="row"><td><span>Sale 10-20% off: 5000 items left</span></td></tr>
        </table>
      </div>`;

    expect(I.estimateTotalResults()).toBe(12438);
  });
});

// =====================================================================
// 2. The selection count, which arms the layout tripwire
// =====================================================================

describe("a selection count cannot be scraped out of a subject line", () => {
  // The legacy fallback walked every span in div[role="main"] and
  // returned the first digits in any text containing "selected". A
  // promotional subject answered with a live selection count, and the
  // damage is not the number: clickMasterCheckbox reads a non-zero answer
  // as "per-row selection worked", so the GmailLayoutError that should
  // stop the run and point at Diagnostics never throws. The run clicks
  // Delete on an empty selection and burns its whole retry budget on
  // every rule instead of saying one clear thing.

  test("a subject containing the word reports no selection", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <table role="grid">
          <tr role="row"><td><span>You have been selected for 3 free rewards</span></td></tr>
        </table>
      </div>`;

    expect(I.extractSelectedCount()).toBeNull();
  });

  test("the real selection banner is still read", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div class="aeH"><span>2 selected</span></div>
      </div>`;

    expect(I.extractSelectedCount()).toBe(2);
  });

  test("and so is the all-conversations form", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div class="aeH">
          <span>All 50 conversations on this page are selected.</span>
        </div>
      </div>`;

    expect(I.extractSelectedCount()).toBe(50);
  });

  test("a banner that says selected but names no number stays null", () => {
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main"><div class="aeH"><span>Selection cleared</span></div></div>`;

    expect(I.extractSelectedCount()).toBeNull();
  });

  test("a pass that clicked no checkboxes reports 0, not what the page says", async () => {
    const I = loadEngine();
    // The 7.4 layout-change case: result rows are on screen and carry no
    // checkbox at all, so the pass clicks nothing.
    //
    // The banner here is a REAL one left over from a previous selection,
    // deliberately, because the two guards in this file are independent
    // and a fixture that trips only one proves only one. Restricting the
    // scrape to the banner (above) does not help if the banner is
    // genuine; what makes this safe is that a pass which clicked zero
    // checkboxes reports zero rather than re-reading the page at all.
    // Mutation-checked: dropping `if (clicked === 0) return 0;` turns
    // this red.
    document.body.innerHTML = `
      <div role="main">
        <div class="aeH"><span>2 selected</span></div>
        <table role="grid">
          <tr role="row"><td><span>You have been selected for 3 free rewards</span></td></tr>
          <tr role="row"><td><span>Another message</span></td></tr>
        </table>
      </div>`;

    await expect(I.selectAllVisibleRowsIndividually()).resolves.toBe(0);
  });

  test("but a pass that really did click reports what it selected", async () => {
    // The control. A guard that always answered 0 would satisfy the test
    // above and break every bulk delete.
    const I = loadEngine();
    document.body.innerHTML = `
      <div role="main">
        <div class="aeH"><span>2 selected</span></div>
        <table role="grid">
          <tr role="row"><td><span role="checkbox" aria-checked="false"></span>One</td></tr>
          <tr role="row"><td><span role="checkbox" aria-checked="false"></span>Two</td></tr>
        </table>
      </div>`;

    await expect(I.selectAllVisibleRowsIndividually()).resolves.toBe(2);
  });
});

// =====================================================================
// 3. Bulk select, on the twelve locales it could never reach
// =====================================================================

describe("the select-all offer is recognised in every locale the token table claims", () => {
  // looksLikeSelectAllOffer ANDed the localized token with a hardcoded
  // Latin noun (`conversation|message|correo|nachricht|messag`), and all
  // eight fallback patterns are Latin literals too. So no Japanese,
  // Korean, Chinese, Russian or Arabic banner could ever satisfy it --
  // and neither could Swedish, Danish, Norwegian, Polish, Turkish, Dutch
  // or Italian, because "konversationer" and "gesprekken" do not contain
  // "conversation". Twelve of seventeen entries in SELECT_ALL_TOKENS were
  // dead code.
  //
  // The cost is not cosmetic: without the bulk offer a 12,000-message
  // rule deletes ~50 per pass, hits TIMING.PASS_CAP, bumps stoppedShort
  // and leaves thousands behind, on a mailbox that clears in one action
  // in English.

  const BANNERS = [
    ["en", "Select all 12,000 conversations that match this search"],
    ["es", "Seleccionar todas las 12.000 conversaciones que coinciden"],
    ["fr", "Tout sélectionner : 12 000 conversations correspondantes"],
    ["de", "Alle 12.000 Konversationen auswählen, die dieser Suche entsprechen"],
    ["pt", "Selecionar todas as 12.000 conversas que correspondem"],
    ["it", "Seleziona tutto: 12.000 conversazioni che corrispondono"],
    ["nl", "Alles selecteren: 12.000 gesprekken die overeenkomen"],
    ["sv", "Välj alla 12 000 konversationer som matchar"],
    ["da", "Vælg alle 12.000 samtaler, der matcher"],
    ["no", "Velg alle 12 000 samtaler som samsvarer"],
    ["pl", "Zaznacz wszystko: 12 000 wątków pasujących do wyszukiwania"],
    ["tr", "Bu aramayla eşleşen 12.000 görüşmenin tümünü seç"],
    ["ru", "Выбрать все цепочки писем, соответствующие запросу: 12 000"],
    ["ar", "تحديد الكل: 12,000 محادثة تطابق هذا البحث"],
    ["ja", "この検索条件に一致するスレッド 12,000 件をすべて選択"],
    ["ko", "검색과 일치하는 대화 12,000개 모두 선택"],
    ["zh", "全选与此搜索匹配的 12,000 个会话"]
  ];

  test.each(BANNERS)("%s", (_locale, text) => {
    const I = loadEngine();
    expect(I.looksLikeSelectAllOffer(text)).toBe(true);
  });

  // The whole reason the AND-gate exists: after a successful bulk click
  // Gmail swaps the offer for a clear-selection control in the same
  // banner, and a finder that accepts either can never tell the two
  // states apart. 8.9 recorded that; widening the noun list must not
  // undo it.
  const CLEAR_CONTROLS = [
    ["en", "Clear selection"],
    ["nl", "Selectie wissen"],
    ["sv", "Avmarkera alla"],
    ["ja", "選択を解除"],
    ["ru", "Снять выделение"],
    ["ko", "선택 해제"],
    ["zh", "取消全选"],
    ["de", "Auswahl aufheben"]
  ];

  test.each(CLEAR_CONTROLS)("the %s clear-selection control is still refused", (_locale, text) => {
    const I = loadEngine();
    expect(I.looksLikeSelectAllOffer(text)).toBe(false);
  });

  test("and ordinary mail is refused whatever nouns it contains", () => {
    const I = loadEngine();
    for (const text of [
      "Your conversation with support has been updated",
      "12,000 messages about your order",
      "スレッドが更新されました",
      "Новое сообщение от службы поддержки"
    ]) {
      expect(I.looksLikeSelectAllOffer(text)).toBe(false);
    }
  });
});

// =====================================================================
// 4. The refusal list, and the quoted form Gmail treats as identical
// =====================================================================

describe("the dangerous-query refusal sees through quoted operator values", () => {
  // Gmail accepts label:"trash" as a synonym for label:trash. The
  // matcher is a literal token with a word boundary, so the quoted form
  // walked straight past it and put a delete run in the Trash view --
  // where "delete" means delete forever. Same shape as the 7.15 `{`
  // escape and the 7.14.2 `(` one: a form Gmail treats as identical that
  // this list did not.

  const REFUSED = [
    "label:trash",
    'label:"trash"',
    "label:'trash'",
    'label:"spam"',
    'in:"anywhere"',
    'older_than:1y label:"trash"',
    '(label:"trash")',
    '{label:"trash" is:unread}',
    'label: "trash"'
  ];

  const ALLOWED = [
    "older_than:1y category:promotions",
    // The negated form is the documented way to be explicit, quoted or not.
    '-label:"trash" older_than:1y',
    "-label:trash older_than:1y",
    // A quoted SUBJECT that merely contains the word is ordinary mail.
    'subject:"trash pickup schedule"',
    'from:(x) subject:"your spam report"'
  ];

  test.each(REFUSED)("refuses %s", (q) => {
    const I = loadEngine();
    expect(I.queryHasDangerousToken(q)).toBe(true);
  });

  test.each(ALLOWED)("allows %s", (q) => {
    const I = loadEngine();
    expect(I.queryHasDangerousToken(q)).toBe(false);
  });
});

// =====================================================================
// 5. Two smaller ones on the same theme: where are we, and which language
// =====================================================================

describe("the engine refuses to run outside a mailbox", () => {
  // mail.google.com also serves Chat. The engine tested the host alone,
  // so on a Chat tab it booted, answered the injection ping, and only
  // discovered the problem inside openSearch -- which "fixes" it by
  // navigating the tab to /mail/u/0/, tearing away the conversation the
  // user was in and killing the content script mid-run, with no terminal
  // message left to release the run claim.
  const at = (href) => {
    delete window.location;
    // jsdom's Location is read-only; a plain object is enough for a
    // function that only reads host and pathname.
    window.location = new URL(href);
    return loadEngine();
  };

  test.each([
    ["https://mail.google.com/mail/u/0/#inbox", true],
    ["https://mail.google.com/mail/u/2/#search/older_than%3A1y", true],
    ["https://mail.google.com/", true],
    ["https://mail.google.com/chat/u/0/#chat/home", false],
    ["https://mail.google.com/chat/", false],
    ["https://calendar.google.com/mail/u/0/", false]
  ])("%s -> %s", (href, expected) => {
    const I = at(href);
    expect(I.isGmailTab()).toBe(expected);
  });
});

describe("Norwegian gets Norwegian from both readers of <html lang>", () => {
  // SAFE_MODE_LANG_ALIASES maps nb/nn to "no" for the Safe Mode shield,
  // and Gmail can stamp either. getSubscriptionSearchTerm did its own
  // bare split and fell through to English, so on the same page load one
  // guard spoke Norwegian and the discovery query did not.
  const withLang = (lang) => {
    document.documentElement.lang = lang;
    return loadEngine();
  };

  test.each(["no", "nb", "nn", "nb-NO", "nn-NO"])("lang=%s", (lang) => {
    const I = withLang(lang);
    expect(I.getSubscriptionSearchTerm()).toBe("meld deg av");
  });

  test("an unknown language still falls back to English", () => {
    const I = withLang("xx");
    expect(I.getSubscriptionSearchTerm()).toBe("unsubscribe");
  });

  test("and the Traditional Chinese carve-out is untouched", () => {
    expect(withLang("zh-TW").getSubscriptionSearchTerm()).toBe("取消訂閱");
    expect(withLang("zh-CN").getSubscriptionSearchTerm()).toBe("退订");
  });
});
