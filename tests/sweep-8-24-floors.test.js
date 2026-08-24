/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://mail.google.com/mail/u/0/"}
 *
 * A page of rows is not a total (8.24).
 *
 * Gmail ranks most searches by relevance now and prints "1-50 of many"
 * where it used to print a figure. parseCountFromText correctly refuses
 * that, so countCurrentResults falls back to the visible row count --
 * and every caller read that fallback as the match total.
 *
 * Where it surfaced:
 *   - the Mailbox Report, which is the landing tab and the screen the
 *     store listing tells every new user to run first, printed a flat 50
 *     against band after band on a mailbox holding tens of thousands.
 *     The same shape as the 8.3 bug it was built to fix, arriving this
 *     time through Gmail rather than through an edit.
 *   - the upsell line quoted one of those numbers at the moment money
 *     changes hands.
 *   - Smart Suggestions divides these counts by each other. Base and
 *     unread both come back as one page, so a sender with 5,000 messages
 *     and 200 unread read as 50 of 50: 100% unread, which is precisely
 *     the shape that recommends the one irreversible action in the
 *     product.
 *
 * Two unrelated fixes ride along, both in the engine and both the same
 * family as things earlier sweeps found: the leftover conversation list
 * 8.22 discovered still owned one lookup, and SELECT_ALL_TOKENS was the
 * last table in its family carrying Simplified Chinese without the
 * Traditional form beside it.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");
const SRC = read("contentScript.js");

function load() {
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = { runKind: "cleanup", dryRun: true };
  window.alert = () => {};
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

const rows = (n, prefix = "r") =>
  Array.from(
    { length: n },
    (_, i) =>
      `<tr role="row" id="${prefix}${i}"><td class="yX">` +
      `<span role="checkbox" aria-checked="false"></span></td></tr>`
  ).join("");

// jsdom performs no layout, so the engine's render gate is inert there
// by design (see layoutIsKnown). These tests drive it explicitly: an
// element is rendered when it sits under data-rendered="yes". Same stub
// the 8.22 suite uses, and the same thing checkVisibility reports on a
// real page.
function stubRendering() {
  Element.prototype.checkVisibility = function checkVisibility() {
    return !!this.closest('[data-rendered="yes"]');
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  delete Element.prototype.checkVisibility;
  chrome.runtime.sendMessage = jest.fn();
  // removeListener too: the engine drops a stale listener on attach, and
  // a stub without it fills the run with a console.error that hides real
  // ones.
  chrome.runtime.onMessage = { addListener: jest.fn(), removeListener: jest.fn() };
});

afterAll(() => {
  delete Element.prototype.checkVisibility;
});

describe("the engine knows the difference between a total and a floor", () => {
  test("a stated total is exact", () => {
    document.body.innerHTML = `
      <div gh="mtb"><span>1-50 of 12,438</span></div>
      <div role="main"><div gh="tl"><table role="grid">${rows(50)}</table></div></div>`;
    const I = load();
    expect(I.countCurrentResultsDetailed()).toEqual({ count: 12438, exact: true });
  });

  test("a relevance-ranked search on a full page is a FLOOR, not a total", () => {
    // The pager Gmail really writes. getTextContent reads textContent
    // first, so there is no newline between the two halves; a probe
    // written with innerText would produce a different string and the
    // test would be pinning something the engine never sees.
    document.body.innerHTML = `
      <div gh="mtb"></div>
      <div role="main">
        <div gh="tm"><span>Showing most relevant1-50 of many</span></div>
        <div gh="tl"><table role="grid">${rows(50)}</table></div>
      </div>`;
    const I = load();
    // The bug: this said 50 and the report printed 50.
    expect(I.estimateTotalResults()).toBeNull();
    expect(I.countCurrentResultsDetailed()).toEqual({ count: 50, exact: false });
  });

  test("a short page with no counter at all is still a floor", () => {
    // Not a rule about page size. The engine cannot know Gmail's page
    // length (25/50/100 is a user setting), so "no total stated" is the
    // whole condition, and any row count under it is what the scan could
    // see rather than what matched.
    document.body.innerHTML = `
      <div gh="mtb"></div>
      <div role="main"><div gh="tl"><table role="grid">${rows(7)}</table></div></div>`;
    const I = load();
    expect(I.countCurrentResultsDetailed()).toEqual({ count: 7, exact: false });
  });

  test("nothing matched is an exact answer, because it is a complete one", () => {
    document.body.innerHTML = `
      <div role="main"><div gh="tl"><span>No messages matched your search</span></div></div>`;
    const I = load();
    expect(I.countCurrentResultsDetailed()).toEqual({ count: 0, exact: true });
  });

  test("countCurrentResults still answers with a bare number", () => {
    // The old contract, unchanged: every caller that only wants the
    // figure keeps getting the figure, so this fix cannot have moved a
    // guardrail by accident.
    document.body.innerHTML = `
      <div gh="mtb"><span>1-50 of 900</span></div>
      <div role="main"><div gh="tl"><table role="grid">${rows(50)}</table></div></div>`;
    const I = load();
    expect(I.countCurrentResults()).toBe(900);
  });
});

describe("the master checkbox has to be one the user can see", () => {
  // 8.22 found that Gmail leaves the previous conversation list in the
  // page, unrendered, outside div[role="main"] and ahead of the results
  // in document order, with its own toolbar. Two lookups were fixed
  // there; findMasterCheckbox was not, because it is only reached when
  // per-row selection finds nothing to click -- the path that exists to
  // rescue a run when Gmail's row markup changes.
  const twoToolbars = `
    <div id="leftover" data-rendered="no">
      <div gh="mtb"><div role="checkbox" id="STALE" aria-checked="false" aria-label="Select"></div></div>
      <table role="grid">${rows(50, "stale")}</table>
    </div>
    <div role="main" data-rendered="yes">
      <div gh="mtb"><div role="checkbox" id="LIVE" aria-checked="false" aria-label="Select"></div></div>
      <div gh="tl"><table role="grid">${rows(47, "live")}</table></div>
    </div>`;

  test("the leftover list's checkbox loses to the one on screen", () => {
    stubRendering();
    document.body.innerHTML = twoToolbars;
    const I = load();
    // The bug: both scored 17 and the tie went to document order, where
    // the leftover comes first. Clicking it selected rows nobody could
    // see, extractSelectedCount reads main and answered 0, and the run
    // reported "Gmail's layout may have changed" about a page that was
    // rendering fine.
    expect(I.findMasterCheckbox().element.id).toBe("LIVE");
  });

  test("and it loses even when it wins every other term", () => {
    // The stale one dressed to score as high as this scorer allows: in a
    // toolbar, labelled, with a dropdown sibling. The live one is a bare
    // checkbox with none of that. Pinned by the CONDITION rather than by
    // the earlier fixture's tie, because a tie is decided by document
    // order and would keep passing if the render term were deleted.
    stubRendering();
    document.body.innerHTML = `
      <div id="leftover" data-rendered="no">
        <div gh="mtb" aria-label="Select">
          <div role="checkbox" id="STALE" aria-checked="false" aria-label="Select all"></div>
          <div aria-haspopup="true"></div>
        </div>
      </div>
      <div role="main" data-rendered="yes">
        <div gh="tl"><div role="checkbox" id="LIVE" aria-checked="false"></div>
        <table role="grid">${rows(47, "live")}</table></div>
      </div>`;
    const I = load();
    const scored = I.findMasterCheckbox().allCandidates;
    const stale = scored.find((c) => c.el.id === "STALE");
    const live = scored.find((c) => c.el.id === "LIVE");
    expect(stale.reasons).toContain("not-rendered");
    expect(live.reasons).not.toContain("not-rendered");
    expect(live.score).toBeGreaterThan(stale.score);
  });

  test("where there is no layout to read, the gate stays out of the way", () => {
    // No checkVisibility stub, so nothing in the document reports a box
    // -- which is every jsdom caller and every headless one. An
    // unconditional test would reject every candidate and take the whole
    // selection path down with it.
    document.body.innerHTML = twoToolbars;
    const I = load();
    const best = I.findMasterCheckbox();
    expect(best.element).not.toBeNull();
    for (const c of best.allCandidates) expect(c.reasons).not.toContain("not-rendered");
  });
});

describe("the select-all offer is readable in Traditional Chinese", () => {
  // 8.16 closed this exact gap in DELETE_LABEL_TOKENS for 删除 / 刪除.
  // SELECT_ALL_TOKENS was the last table in the family still carrying
  // only the Simplified form, and looksLikeSelectAllOffer needs BOTH a
  // localized token and the localized noun, so the whole bulk-all path
  // was dead on a zh-TW or zh-HK Gmail: the run never took Gmail's offer
  // to select every match and crawled the results one page at a time.
  test("a zh-TW banner is recognised as the offer", () => {
    const I = load();
    expect(I.looksLikeSelectAllOffer("全選符合這個搜尋的所有 12,000 個會話")).toBe(true);
  });

  test("the Simplified banner still is", () => {
    const I = load();
    expect(I.looksLikeSelectAllOffer("全选与此搜索匹配的 12,000 个会话")).toBe(true);
  });

  test("and the control that REPLACES the offer is still refused", () => {
    // 8.9: the banner swaps the offer for a clear-selection control
    // after a successful bulk select, and a finder that accepts either
    // can never tell the two states apart. Widening the token table is
    // only safe while that stays true, so both forms are pinned.
    const I = load();
    expect(I.looksLikeSelectAllOffer("取消全選")).toBe(false);
    expect(I.looksLikeSelectAllOffer("取消全选")).toBe(false);
  });

  test("every table in this family carries both Chinese forms", () => {
    // The rule, rather than the one instance of it. Comments are
    // stripped first: this file's own explanation names 全选 and 全選,
    // and a scanner that reads its own prose is the trap that has cost
    // this repo six releases.
    const body = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
    const table = (name) => {
      const at = body.indexOf(`const ${name} = Object.freeze([`);
      expect(at).toBeGreaterThan(-1);
      return body.slice(at, body.indexOf("]);", at));
    };
    const PAIRS = [
      ["SELECT_ALL_TOKENS", "全选", "全選"],
      ["DELETE_LABEL_TOKENS", "删除", "刪除"],
      ["ARCHIVE_LABEL_TOKENS", "归档", "封存"],
      ["LABEL_BUTTON_TOKENS", "标签", "標籤"],
      ["CONFIRM_TOKENS", "确认", "確認"]
    ];
    for (const [name, simplified, traditional] of PAIRS) {
      const text = table(name);
      expect(`${name}: ${text.includes(simplified)}`).toBe(`${name}: true`);
      expect(`${name}: ${text.includes(traditional)}`).toBe(`${name}: true`);
    }
  });
});
