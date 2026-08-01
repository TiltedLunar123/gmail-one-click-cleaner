/**
 * @jest-environment jsdom
 *
 * Where "Unsaved changes" appears (8.4).
 *
 * The indicator was nested inside the subtitle paragraph at the very
 * top of the page, so it rendered mid-sentence, several screens above
 * the Save button it was asking about. Its `margin-left: auto` was
 * doing nothing there either, because the parent was a paragraph and
 * not a flex container, so it did not even push to the right.
 *
 * These pin the placement, not the styling: the indicator has to be a
 * sibling of the Save button rather than a descendant of the subtitle,
 * and the behaviour that shows and hides it has to survive the move.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf-8");

let doc;
beforeAll(() => {
  doc = new DOMParser().parseFromString(html, "text/html");
});

describe("placement", () => {
  test("the indicator exists exactly once", () => {
    expect(doc.querySelectorAll("#unsavedIndicator")).toHaveLength(1);
  });

  test("it is no longer buried inside the subtitle", () => {
    const subtitle = doc.querySelector("p.subtitle");
    expect(subtitle).not.toBeNull();
    expect(subtitle.querySelector("#unsavedIndicator")).toBeNull();
    // And the subtitle still says what it always said.
    expect(subtitle.textContent).toMatch(/One Gmail search query per line/);
  });

  test("it shares a parent with the Save button", () => {
    const indicator = doc.querySelector("#unsavedIndicator");
    const save = doc.querySelector("#save");
    expect(save).not.toBeNull();
    expect(indicator.parentElement).toBe(save.parentElement);
    expect(indicator.parentElement.className).toContain("save-group");
  });

  test("it comes before the button in reading order", () => {
    // Screen readers and a stacked mobile layout both follow DOM order,
    // and "Unsaved changes" is context for the button that follows it.
    const group = doc.querySelector(".save-group");
    const kids = Array.from(group.children);
    expect(kids.indexOf(doc.querySelector("#unsavedIndicator"))).toBeLessThan(
      kids.indexOf(doc.querySelector("#save"))
    );
  });

  test("the group sits in the footer, next to Save's own hint", () => {
    const group = doc.querySelector(".save-group");
    expect(group.closest("footer")).not.toBeNull();
  });

  test("it is still announced politely rather than as an alert", () => {
    // It fires on every keystroke in a textarea. aria-live=assertive
    // here would interrupt the user mid-word, every word.
    const indicator = doc.querySelector("#unsavedIndicator");
    expect(indicator.getAttribute("aria-live")).toBe("polite");
  });
});

describe("styling moved with it", () => {
  test("the dead margin-left:auto is gone", () => {
    // Meaningless inside a <p>; the flex parent handles spacing now.
    const block = html.slice(
      html.indexOf(".unsaved-indicator {"),
      html.indexOf(".unsaved-indicator.show")
    );
    expect(block.length).toBeGreaterThan(20);
    expect(block).not.toContain("margin-left: auto");
  });

  test("the save group is a flex row that can wrap", () => {
    const block = html.slice(html.indexOf(".save-group {"), html.indexOf(".unsaved-indicator {"));
    expect(block).toMatch(/display:\s*flex/);
    expect(block).toMatch(/align-items:\s*center/);
    expect(block).toMatch(/flex-wrap:\s*wrap/);
  });

  test("stacked layouts put it above the full-width button, not beside it", () => {
    // #save is width:100% under 600px, so without this the indicator
    // gets shoved onto a ragged second row.
    const mobile = html.slice(html.indexOf("@media (max-width: 600px)"));
    const block = mobile.slice(mobile.indexOf(".save-group {"), mobile.indexOf(".footer-links {"));
    expect(block).toMatch(/flex-direction:\s*column/);
  });

  test("show/hide is still a class toggle, so options.js keeps working", () => {
    expect(html).toContain(".unsaved-indicator.show { display: inline-flex; }");
    const optionsSrc = fs.readFileSync(path.join(ROOT, "options.js"), "utf-8");
    expect(optionsSrc).toContain('indicator.classList.toggle("show", !!state.hasUnsavedChanges)');
  });
});

describe("the behaviour behind it is untouched", () => {
  test("the dirty flag still drives both the pill and the title", () => {
    const optionsSrc = fs.readFileSync(path.join(ROOT, "options.js"), "utf-8");
    const fn = optionsSrc.slice(
      optionsSrc.indexOf("const updateUnsavedIndicator"),
      optionsSrc.indexOf("const markUnsaved")
    );
    expect(fn).toContain('GCC.$("unsavedIndicator")');
    expect(fn).toContain("document.title");
    // A missing element must not throw: the page renders without it in
    // the print stylesheet path and in any trimmed build.
    expect(fn).toContain("if (!indicator) return;");
  });
});
