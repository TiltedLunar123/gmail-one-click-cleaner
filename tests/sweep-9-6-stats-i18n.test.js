/**
 * @jest-environment node
 *
 * 9.6: the Stats page said the 9.5 sentence in English.
 *
 * 9.5 put "waiting in Trash" on four surfaces. The popup builds it
 * through the catalogue; the Stats page built it with a template
 * literal. Same number, same measuring function, same release, and a
 * German or Japanese reader got one of them in their language and the
 * other in English.
 *
 * The four keys already existed in all seven catalogues, so this was a
 * call that was never made rather than a translation that was never
 * written. It also ended a second, quieter divergence: the two surfaces
 * had drifted into two wordings of one fact, which is how a figure ends
 * up reading as two figures.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STATS = fs.readFileSync(path.join(ROOT, "stats.js"), "utf-8");
const POPUP = fs.readFileSync(path.join(ROOT, "popup.js"), "utf-8");
const LOCALES = fs.readdirSync(path.join(ROOT, "_locales"));

const KEYS = ["trashWaitingOne", "trashWaitingMany", "trashWaitingOneMb", "trashWaitingManyMb"];

const statsRender = STATS.slice(
  STATS.indexOf("function renderTrashWaiting(log)"),
  STATS.indexOf("async function openTrashFromStats()")
);

const popupFigure = POPUP.slice(
  POPUP.indexOf("const trashFigureText ="),
  POPUP.indexOf("const renderTrashWaiting =")
);

describe("both surfaces say it through the catalogue", () => {
  test("the Stats page asks for all four keys", () => {
    for (const key of KEYS) expect(statsRender).toContain(`"${key}"`);
  });

  test("the Stats page no longer builds the sentence itself", () => {
    // The template literal that WAS the sentence. Its fallbacks survive
    // as the third argument to t(), which is the convention every other
    // localized string here follows.
    expect(statsRender).toContain("GCC.i18n.t(");
    expect(statsRender).not.toContain("waiting in Trash (about ${GCC.formatMb(mb)})");
    expect(statsRender).not.toContain('const noun = count === 1');
  });

  test("the popup and the Stats page ask for the same keys", () => {
    // One fact, one set of keys. Two surfaces reaching for different
    // strings is how the wordings drifted apart in the first place.
    for (const key of KEYS) {
      expect(popupFigure).toContain(`"${key}"`);
      expect(statsRender).toContain(`"${key}"`);
    }
  });

  test("the size clause is still dropped rather than printed as zero", () => {
    // Entries written before 9.5 carry a count and no size, so an
    // upgraded install has real mail waiting and nothing to say about
    // how big it is. "about 0 MB" is the 8.9 and 9.3 mistake.
    expect(statsRender).toContain("mb >= 0.01");
  });

  test("zero is still not an answer", () => {
    expect(statsRender).toContain("count <= 0");
    expect(statsRender).toContain("hidden = true");
  });
});

describe("the catalogues can actually serve it", () => {
  for (const locale of LOCALES) {
    test(`${locale} carries all four, with the placeholders they are called with`, () => {
      const cat = JSON.parse(
        fs.readFileSync(path.join(ROOT, "_locales", locale, "messages.json"), "utf8")
      );
      for (const key of KEYS) {
        expect(cat[key]).toBeDefined();
        expect(typeof cat[key].message).toBe("string");
        expect(cat[key].message.length).toBeGreaterThan(0);
      }
      // The count-only pair takes one substitution, the size pair takes
      // two. A catalogue that dropped $2 would print the count twice.
      expect(cat.trashWaitingOne.message).not.toContain("$1");
      expect(cat.trashWaitingMany.message).toContain("$1");
      expect(cat.trashWaitingOneMb.message).toContain("$1");
      expect(cat.trashWaitingOneMb.message).not.toContain("$2");
      expect(cat.trashWaitingManyMb.message).toContain("$1");
      expect(cat.trashWaitingManyMb.message).toContain("$2");
    });
  }
});
