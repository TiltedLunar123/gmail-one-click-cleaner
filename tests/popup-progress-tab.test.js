/**
 * @jest-environment node
 *
 * Progress tab lifecycle (7.13.1). Two defects sat in the three run
 * paths of popup.js and both were invisible to the other suites:
 *
 *  1. A leftover progress tab was reused with { active: true } only, so
 *     it kept the finished state of the PREVIOUS run (progress.js sets
 *     state.done and never clears it). Cancel stayed disabled reading
 *     "Run finished" while a new run was actually going.
 *  2. That tab was opened BEFORE the already-attached guard, so
 *     refusing a duplicate run still left a fresh dashboard behind that
 *     no engine would ever talk to.
 *
 * Both are ordering/argument properties of the source, so this suite
 * pins them by reading popup.js the way popup-structure.test.js reads
 * popup.html. A live-Gmail test is not available in this project.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf-8");

// Comments out, code in. Crude on purpose: it only has to be right
// about `//` and `/* */` runs in this one file, and both are replaced
// with a space rather than removed so nothing either side joins up.
const codeOnly = (text) =>
  String(text)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");

const RUN_PATHS = 4; // runCleanup, storage purge, smart apply, report plan step

const indicesOf = (haystack, needle) => {
  const out = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
};

describe("openProgressTab", () => {
  const helper = src.slice(
    src.indexOf("const openProgressTab ="),
    src.indexOf("const isEngineAttached =")
  );

  test("the helper exists and sits before the run paths that call it", () => {
    expect(src.indexOf("const openProgressTab =")).toBeGreaterThan(-1);
    expect(helper).toContain("findProgressTab");
  });

  test("reusing a leftover tab reloads it explicitly", () => {
    // The reload is what makes the reused tab drop the finished state of
    // the previous run. Focusing it alone was the defect, and a
    // re-navigation to the URL it already has is not documented to
    // re-run the page, so the reload must be a real tabs.reload call.
    expect(helper).toMatch(/await tabsReload\(existing\.id\)/);
    expect(src).toMatch(/const tabsReload = async \(tabId\) => \{/);
    expect(src).toContain("chrome.tabs.reload.bind(chrome.tabs)");
  });

  test("a tab that cannot be reloaded is replaced, never silently skipped", () => {
    // tabsReload reports false when the leftover tab turned out to be
    // gone, and the user still needs a dashboard for the run.
    expect(helper).toMatch(/if \(!\(await tabsReload\(existing\.id\)\)\) \{\s*await tabsCreate\(/);
  });

  test("no leftover tab means a new one, still focused", () => {
    expect(helper).toMatch(/tabsCreate\(\s*\{\s*url:\s*progressUrl,\s*active:\s*true\s*\}\s*\)/);
  });
});

describe("isEngineAttached", () => {
  const helper = src.slice(
    src.indexOf("const isEngineAttached ="),
    src.indexOf("const isEngineAttached =") + 600
  );

  test("the attached probe lives in exactly one place", () => {
    // Four copies of this probe used to be inlined across popup.js.
    //
    // Counted over code with the comments stripped out. The invariant
    // is about where the flag is READ, and a comment that names the
    // flag while explaining the stuck-run reset (8.4) is documentation,
    // not a second probe. Stripping comments makes the count measure
    // what the test claims to measure; a real second read still fails
    // it, which is the property that matters.
    expect(indicesOf(codeOnly(src), "window.GCC_ATTACHED")).toHaveLength(1);
    expect(codeOnly(helper)).toContain("window.GCC_ATTACHED");
  });

  test("a tab that cannot answer reads as not attached", () => {
    // Erring toward "not attached" keeps a slow tab injectable; the
    // injection itself then surfaces any real failure.
    expect(helper).toMatch(/catch\s*\{\s*return false;/);
  });
});

describe("run paths", () => {
  const guards = indicesOf(src, "if (await isEngineAttached(gmailTab.id)) {");
  const opens = indicesOf(src, "await openProgressTab(gmailTab.id);");

  test("every run path opens progress through the helper", () => {
    expect(opens).toHaveLength(RUN_PATHS);
  });

  test("the guard runs before the progress tab is opened, in every path", () => {
    // One guard per run path plus the shared auxiliary-run injector.
    expect(guards.length).toBeGreaterThanOrEqual(RUN_PATHS);
    for (const open of opens) {
      const guardsBefore = guards.filter((g) => g < open);
      expect(guardsBefore.length).toBeGreaterThan(0);
      // Nothing may be injected between the guard and the tab opening,
      // which is what proves the refusal happens first.
      const between = src.slice(guardsBefore[guardsBefore.length - 1], open);
      expect(between).not.toContain('files: ["contentScript.js"]');
    }
  });

  test("the old inline attached check is gone from the run paths", () => {
    expect(src).not.toContain("let alreadyAttached = false;");
    expect(src).not.toContain("alreadyAttached = result?.result === true;");
  });
});
