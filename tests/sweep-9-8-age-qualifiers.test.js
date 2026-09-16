/**
 * @jest-environment node
 *
 * 9.8: the "no age filter" warning counted the two operators that point
 * the other way.
 *
 * validateGmailQuery warns when a rule reaches a whole view -- in:inbox,
 * in:all, in:anywhere -- with no age bound on it, because such a rule
 * archives or deletes mail that arrived this morning. The check for "is
 * there an age bound" was AGE_QUALIFIERS, and it accepted four
 * operators: older_than:, before:, newer_than: and after:.
 *
 * Only the first two bound a query to OLD mail. newer_than: and after:
 * bound it to RECENT mail, which is the very thing the sentence is
 * about, so `in:inbox newer_than:7d` -- a rule whose entire match set is
 * the last week of the inbox -- silenced the one line warning the user
 * that recent mail is not protected. The Options page saved it without
 * a word.
 *
 * The refusal above this check is unaffected: in:anywhere is a dangerous
 * token and is still refused outright. What changes is the warning on
 * in:inbox and in:all, which is the pair a user can actually save.
 */
const fs = require("fs");
const path = require("path");

const SHARED = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
// eslint-disable-next-line no-new-func
const GCC = new Function(SHARED + "\nreturn GCC;")();

const warns = (query) => GCC.validateGmailQuery(query).warnings;

describe("an age bound that protects recent mail silences the warning", () => {
  test("older_than:", () => {
    expect(warns("in:inbox older_than:1y")).toHaveLength(0);
    expect(warns("in:all older_than:6m")).toHaveLength(0);
  });

  test("before:", () => {
    expect(warns("in:inbox before:2024/01/01")).toHaveLength(0);
  });
});

describe("an age bound that targets recent mail does not", () => {
  test("newer_than: is the opposite of a protection and must still warn", () => {
    const w = warns("in:inbox newer_than:7d");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("in:inbox");
    expect(w[0]).toContain("older_than:");
  });

  test("after: is the same operator by another name", () => {
    expect(warns("in:all after:2026/01/01")).toHaveLength(1);
  });

  test("a grouped one is not a way round it either", () => {
    expect(warns("(in:inbox) newer_than:1d")).toHaveLength(1);
    expect(warns("{in:inbox in:all} after:2026/09/01")).toHaveLength(2);
  });

  test("a range still counts, because the before: half is the floor", () => {
    expect(warns("in:inbox after:2020/01/01 before:2021/01/01")).toHaveLength(0);
  });
});

describe("nothing else moved", () => {
  test("a query with no view token is not warned about at all", () => {
    expect(warns("category:promotions newer_than:7d")).toHaveLength(0);
  });

  test("the dangerous-token refusal is untouched", () => {
    const r = GCC.validateGmailQuery("in:anywhere newer_than:7d");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("in:anywhere");
  });

  test("AGE_QUALIFIERS names only the two that bound a query to old mail", () => {
    const line = /const AGE_QUALIFIERS = (\/.*\/[a-z]*);/.exec(SHARED);
    expect(line).not.toBeNull();
    expect(line[1]).not.toContain("newer_than");
    expect(line[1]).not.toContain("after:");
    expect(line[1]).toContain("older_than");
    expect(line[1]).toContain("before:");
  });
});
