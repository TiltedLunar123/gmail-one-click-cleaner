/**
 * 9.4, two things the receipts panel said that were not true.
 *
 * loadReceipts read res.receipts without asking whether the read
 * worked. GCC.sendMessage resolves {error, code:"send_failed"} rather
 * than rejecting, and the worker answers {ok:false} when its storage
 * read throws, so both failures arrived as "no receipts" and the panel
 * hid itself. A Pro user who has unsubscribed from forty lists saw the
 * same screen as somebody who never has, and this ledger is the only
 * record that they did.
 *
 * The Clear button's zero case blamed Minimum Age unconditionally.
 * Minimum Age ships EMPTY, so on a default install it cannot be the
 * cause; Skip Unread, which ships on, usually is. Pointing somebody at a
 * setting that is already unset is worse than not explaining the number.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const POPUP = read("popup.js");
const POPUP_HTML = read("popup.html");
const EN = JSON.parse(read("_locales/en/messages.json"));

// A source slice between two anchors, comments stripped, so a pin is
// about the code rather than about the prose explaining it.
const bodyOf = (src, start, end) => {
  const clean = src.replace(/^\s*\/\/.*$/gm, " ");
  const a = clean.indexOf(start);
  if (a === -1) return "";
  const b = clean.indexOf(end, a + start.length);
  return b > a ? clean.slice(a, b) : "";
};

describe("a failed read is not an empty ledger", () => {
  const fn = bodyOf(POPUP, "const loadReceipts = async () => {", "};");

  test("loadReceipts checks the answer before believing it", () => {
    expect(fn).not.toBe("");
    // The bug in one line: reading the payload straight off an answer
    // that may be a refusal.
    expect(fn).not.toMatch(/state\.receipts\.list\s*=\s*Array\.isArray\(res\?\.receipts\)/);
    expect(fn).toMatch(/res\.ok === false|!res\?\.ok|res\.error/);
  });

  test("it returns rather than overwriting state when the read was refused", () => {
    // The refusal branch has to leave, not fall through to the assign.
    const guard = fn.slice(0, fn.indexOf("state.receipts.list"));
    expect(guard).toMatch(/return;/);
  });

  test("the success path still fills the list", () => {
    expect(fn).toMatch(/state\.receipts\.list\s*=\s*Array\.isArray\(res\.receipts\)/);
  });
});

describe("the Clear button explains the number with the setting that caused it", () => {
  test("Minimum Age is named only when Minimum Age is set", () => {
    const at = POPUP.indexOf('t("receiptsPurgeNothing"');
    expect(at).toBeGreaterThan(-1);
    const near = POPUP.slice(Math.max(0, at - 400), at + 400);
    expect(near).toMatch(/guards\?\.minAge/);
  });

  test("there is a sentence for the case where it is not", () => {
    expect(EN.receiptsPurgeNothingGuards).toBeTruthy();
    expect(EN.receiptsPurgeNothingGuards.message.toLowerCase()).not.toContain("minimum age");
    expect(POPUP).toContain('t("receiptsPurgeNothingGuards"');
  });

  test("Minimum Age really does ship empty, which is why", () => {
    // If this ever changes, the branch above is arguing about nothing.
    const at = POPUP_HTML.indexOf('data-i18n="ageDefault"');
    expect(at).toBeGreaterThan(-1);
    const tag = POPUP_HTML.slice(POPUP_HTML.lastIndexOf("<option", at), at);
    expect(tag).toContain('value=""');
    expect(tag).toContain("selected");
  });

  test("Skip Unread really does ship on, which is the usual cause", () => {
    const tag = POPUP_HTML.match(/<input id="skipUnread"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag[0]).toContain(" checked");
  });
});
