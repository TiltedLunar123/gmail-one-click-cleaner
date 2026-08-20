/**
 * @jest-environment jsdom
 *
 * 8.20: two guards that stand between a Gmail change and a bad delete,
 * and that the suite could not see.
 *
 * Both were found the same way: mutate the line, run the whole suite,
 * watch it stay green. A guard nothing asserts is a guard that can be
 * deleted by accident in the release where it matters most.
 *
 *   1. contentScript.js, the rethrow in applyTagLabel's catch. Tagging
 *      before deleting is the promise the recovery log rests on: every
 *      batch gets a `GmailCleaner - <rule>` label first, and Stats ->
 *      Restore searches for exactly that label. A GmailLayoutError from
 *      the label controls means Gmail moved them, and the run has to
 *      stop rather than delete an already-selected page with no label on
 *      it. Every existing call passed `tagLabel` as null, so the
 *      `tagLabel &&` clause short-circuited and the try/catch was never
 *      entered by any test.
 *
 *   2. contentScript.js, the huge-run threshold. Replacing the
 *      comparison with `false &&` left 1970 tests passing, so the gate
 *      that asks before twenty thousand conversations are deleted could
 *      be made completely dead without a single failure.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function loadEngine(config = {}) {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GCC_CONFIRMED_HUGE = false;
  window.GCC_CONFIRMED_SOFT_CAP = false;
  window.GMAIL_CLEANER_CONFIG = config;
  window.alert = () => {};
  document.body.innerHTML = "";
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

// A page Gmail would consider perfectly normal: a toolbar with a master
// checkbox and a Delete button, two selectable rows, and a match total.
// What it does NOT have is any way to apply a label.
const page = ({ total = "120", labels = false } = {}) => `
  <div role="main">
    <div gh="mtb">
      <div role="checkbox" aria-checked="false" aria-label="Select"></div>
      <div role="button" aria-label="Delete"></div>
      <div role="button" aria-label="Archive"></div>
      ${labels ? '<div role="button" aria-label="Labels"></div>' : ""}
      <span>1-50 of ${total}</span>
    </div>
    <table role="grid">
      <tr role="row"><td role="gridcell"><span role="checkbox" aria-checked="false"></span>Old promo one</td></tr>
      <tr role="row"><td role="gridcell"><span role="checkbox" aria-checked="false"></span>Old promo two</td></tr>
    </table>
  </div>`;

// The outcome either way, so a control case can say "not that" without
// caring which of the later Gmail waits a fake DOM happens to fail on.
const act = async (I, tagLabel = null) => {
  try {
    return { ok: await I.actOnCurrentPageIfAny(tagLabel) };
  } catch (e) {
    return { threw: e };
  }
};

describe("tagging cannot be skipped just because Gmail moved the control", () => {
  test("a layout change while tagging stops the run instead of deleting untagged", async () => {
    const I = loadEngine({ tagBeforeDelete: true, dryRun: false });
    document.body.innerHTML = page();
    const clicked = [];
    document.querySelectorAll("[role='button']").forEach((b) => {
      b.addEventListener("click", () => clicked.push(b.getAttribute("aria-label")));
    });

    const out = await act(I, "GmailCleaner - Promotions");

    expect(out.threw).toBeDefined();
    expect(out.threw.name).toBe("GmailLayoutError");
    expect(out.threw.code).toBe("gmail_layout_changed");
    // The half that matters: the selected page was not deleted on the
    // way past. Recovery by label is the extension's advertised undo,
    // and a batch in Trash with no label is not recoverable by it.
    expect(clicked).not.toContain("Delete");
  }, 30000);

  test("with tagging off, the same page is not stopped by the label controls", async () => {
    // The control: it is the tag step that raises this, not the page.
    const I = loadEngine({ tagBeforeDelete: false, dryRun: false });
    document.body.innerHTML = page();

    const out = await act(I, "GmailCleaner - Promotions");

    expect(out.threw?.name).not.toBe("GmailLayoutError");
  }, 30000);
});

describe("the huge-run gate is reached and is load bearing", () => {
  test("an unattended run over the threshold is refused, not run", async () => {
    const I = loadEngine({
      scheduled: true, dryRun: false, tagBeforeDelete: false, archiveInsteadOfDelete: false
    });
    document.body.innerHTML = page({ total: "30,000" });
    expect(I.estimateTotalResults()).toBe(30000);

    const out = await act(I);

    expect(out.ok).toEqual({
      deleted: false, count: 0, reason: "scheduled-huge-run-declined", declined: true
    });
  }, 30000);

  test("the same run under the threshold is not refused", async () => {
    const I = loadEngine({
      scheduled: true, dryRun: false, tagBeforeDelete: false, archiveInsteadOfDelete: false
    });
    document.body.innerHTML = page({ total: "120" });

    const out = await act(I);

    expect(out.ok?.reason).not.toBe("scheduled-huge-run-declined");
  }, 30000);

  test("archiving never trips it: an archive run frees nothing and deletes nothing", async () => {
    // The `!CONFIG.archiveInsteadOfDelete` half of the condition, which
    // is what keeps Auto-Pilot's weekly archive sweep out of this gate.
    const I = loadEngine({
      scheduled: true, dryRun: false, tagBeforeDelete: false, archiveInsteadOfDelete: true
    });
    document.body.innerHTML = page({ total: "30,000" });

    const out = await act(I);

    expect(out.ok?.reason).not.toBe("scheduled-huge-run-declined");
  }, 30000);
});
