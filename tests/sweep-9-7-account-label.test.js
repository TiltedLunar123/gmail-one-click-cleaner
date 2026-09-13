/**
 * 9.7: the popup's account pills were the first 25 characters of the
 * tab title.
 *
 * A Gmail tab is titled "Inbox (3) - jude@example.com - Gmail", and the
 * pill showed "Inbox (3) - jude@example.c": the one part of the title
 * that says which account this is, cut off. The address is what the pill
 * exists to show, so it is taken out of the title when it is there and
 * the old slice is only the fallback for a title with no address in it.
 */
const fs = require("fs");
const path = require("path");

const SHARED = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const POPUP = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf-8");

// eslint-disable-next-line no-new-func
const GCC = new Function(SHARED + "\nreturn GCC;")();

describe("GCC.accountLabel", () => {
  test("takes the address out of a Gmail tab title", () => {
    expect(GCC.accountLabel("Inbox (3) - jude@example.com - Gmail", 0)).toBe("jude@example.com");
  });

  test("works on a search or a conversation title, where the address is still second to last", () => {
    expect(GCC.accountLabel("older_than:1y - Search results - work@company.example - Gmail", 1))
      .toBe("work@company.example");
    expect(GCC.accountLabel("Re: lunch - jude@example.com - Gmail", 0)).toBe("jude@example.com");
  });

  test("a title with no address falls back to the title, trimmed of the suffix and capped", () => {
    expect(GCC.accountLabel("Inbox (12) - Gmail", 0)).toBe("Inbox (12)");
    expect(GCC.accountLabel("A very long conversation subject that goes on and on - Gmail", 0))
      .toBe("A very long conversation ");
  });

  test("no title at all names the account index", () => {
    expect(GCC.accountLabel("", 2)).toBe("Account 2");
    expect(GCC.accountLabel(undefined, 0)).toBe("Account 0");
  });

  test("a very long address is still capped so the pill row cannot overflow", () => {
    const long = "a.really.quite.long.local.part@some.subdomain.example.com";
    expect(GCC.accountLabel(`Inbox - ${long} - Gmail`, 0).length).toBeLessThanOrEqual(32);
  });
});

describe("the popup uses it", () => {
  test("the pill label comes from GCC.accountLabel rather than a slice of the title", () => {
    const fn = POPUP.slice(
      POPUP.indexOf("const loadGmailAccounts = async"),
      POPUP.indexOf("const GMAIL_OPEN_TIMEOUT_MS")
    );
    expect(fn).toContain("GCC.accountLabel(");
    expect(fn).not.toContain('.replace(/ - Gmail.*$/, "").slice(0, 25)');
  });
});
