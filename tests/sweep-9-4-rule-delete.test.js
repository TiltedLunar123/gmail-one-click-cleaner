/**
 * @jest-environment jsdom
 *
 * 9.4: the custom-rule delete removed a rule by POSITION.
 *
 * The handler closed over the index the row was rendered at, then
 * re-read the whole list from storage and spliced that index out of the
 * fresh copy. The two only line up while nothing has changed in between,
 * and several ordinary things change it: renderCustomRules() was called
 * without await so a second click could land against the old rows, a
 * second Options tab writes to the same sync key, and an import replaces
 * the list wholesale. When they disagree, the rule that goes is a
 * different rule the user wrote, and there is no undo for that.
 *
 * Deleting by identity is the fix. Nothing else in the row needs an id:
 * a custom rule is its query and its action.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf-8");

const rule = (query, action = "delete") => ({ query, action, createdAt: 1 });

// The list as storage holds it. The test mutates this between render and
// click, which is exactly what a second writer does.
let stored;
let toasts;

// CLONE on read. Handing back the live array would let a splice mutate
// `stored` directly, and the test would then pass without the save path
// ever running: a test that passes for the wrong reason is the thing
// this file exists to catch elsewhere.
const CUSTOM_RULES_KEY = "customRules";

const makeGCC = (container) => ({
  $: (id) => (id === "customRulesList" ? container : null),
  hasChromeStorage: () => true,
  storageGet: async (area, key) => ({ [key]: JSON.parse(JSON.stringify(stored)) }),
  // The real write. Nothing else may change `stored`.
  storageSet: async (area, data) => {
    if (CUSTOM_RULES_KEY in data) stored = data[CUSTOM_RULES_KEY];
  },
  clone: (x) => JSON.parse(JSON.stringify(x)),
  debounce: (fn) => fn,
  showToast: (msg) => { toasts.push(msg); },
  theme: { init: async () => {}, get: async () => "dark", set: async (v) => v },
  validateGmailQuery: () => ({ valid: true, warnings: [] }),
  sanitizeProtectKeywords: () => [],
  escapeHtml: (s) => s,
  storageRemove: async () => {},
  hasChrome: () => true
});

const makeChrome = () => ({
  runtime: {
    id: "test",
    lastError: null,
    getManifest: () => ({ version: "9.4.0" }),
    getURL: (p) => p,
    sendMessage: (msg, cb) => { if (typeof cb === "function") cb({ ok: true }); },
    onMessage: { addListener: () => {} }
  },
  storage: {
    sync: {
      get: (k, cb) => cb({ [k]: JSON.parse(JSON.stringify(stored)) }),
      set: (obj, cb) => { if (cb) cb(); }
    },
    local: { get: (k, cb) => cb({}), set: (o, cb) => { if (cb) cb(); } },
    onChanged: { addListener: () => {} }
  },
  i18n: { getMessage: () => "" },
  tabs: { create: () => {}, query: (q, cb) => cb([]) }
});

function loadRender(container) {
  const body = SRC.replace(/^\(\(\)\s*=>\s*\{/, "").replace(/\}\)\(\);\s*$/, "");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "GCC",
    "chrome",
    `${body}\n; return { renderCustomRules, loadCustomRules, saveCustomRules, CUSTOM_RULES_KEY };`
  );
  return factory(makeGCC(container), makeChrome());
}

let container;
let api;

beforeEach(() => {
  document.body.innerHTML = '<div id="customRulesList"></div>';
  container = document.getElementById("customRulesList");
  toasts = [];
  stored = [rule("from:a@x.com older_than:1y"), rule("from:b@x.com older_than:1y"), rule("from:c@x.com older_than:1y")];
  api = loadRender(container);
});

// Guard the guard: if storageSet stops being the only writer, every
// assertion below silently becomes an assertion about aliasing.
test("the fixture only changes storage through the save path", async () => {
  await api.renderCustomRules();
  const before = JSON.stringify(stored);
  await api.loadCustomRules().then((list) => list.splice(0, 1));
  expect(JSON.stringify(stored)).toBe(before);
});

const rows = () => [...container.querySelectorAll(".custom-rule-row")];
const queries = () => stored.map((r) => r.query);

describe("deleting a rule removes the rule that was clicked", () => {
  test("with nothing else happening, the right rule goes", async () => {
    await api.renderCustomRules();
    expect(rows()).toHaveLength(3);
    rows()[1].querySelector(".rule-delete").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(queries()).toEqual(["from:a@x.com older_than:1y", "from:c@x.com older_than:1y"]);
  });

  test("a list that shifted under the row still loses the clicked rule", async () => {
    await api.renderCustomRules();
    // Somebody else removed the FIRST rule after this list was drawn:
    // a second Options tab, an import, or this page's own previous
    // delete whose re-render had not finished. Row index 1 now points at
    // "c", and the user is looking at a row that says "b".
    stored = [rule("from:b@x.com older_than:1y"), rule("from:c@x.com older_than:1y")];

    rows()[1].querySelector(".rule-delete").click();
    await new Promise((r) => setTimeout(r, 0));

    // The row the user pressed said "b". "b" is what has to go.
    expect(queries()).toEqual(["from:c@x.com older_than:1y"]);
  });

  test("a rule already gone is not turned into a delete of its neighbour", async () => {
    await api.renderCustomRules();
    stored = [rule("from:a@x.com older_than:1y"), rule("from:c@x.com older_than:1y")];

    // Row 1 is "b", which storage no longer has.
    rows()[1].querySelector(".rule-delete").click();
    await new Promise((r) => setTimeout(r, 0));

    expect(queries()).toEqual(["from:a@x.com older_than:1y", "from:c@x.com older_than:1y"]);
    expect(toasts).not.toContain("Rule removed");
  });

  test("two rules that differ only by action are told apart", async () => {
    stored = [
      rule("category:promotions older_than:6m", "archive"),
      rule("category:promotions older_than:6m", "delete")
    ];
    await api.renderCustomRules();
    rows()[1].querySelector(".rule-delete").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(stored).toHaveLength(1);
    expect(stored[0].action).toBe("archive");
  });
});

describe("a rule can be reordered without a mouse", () => {
  // Reordering was drag-and-drop only, and the one affordance for it was
  // a span carrying aria-hidden and no tabindex. The order of a user's
  // own rules is the order they run in, and it could not be changed at
  // all from the keyboard.
  const press = (el, key) => {
    const e = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };

  test("the handle is a focusable control, not a decoration", async () => {
    await api.renderCustomRules();
    const handle = rows()[0].querySelector(".drag-handle");
    expect(handle.tagName).toBe("BUTTON");
    expect(handle.getAttribute("aria-hidden")).toBeNull();
    expect(handle.getAttribute("aria-label")).toMatch(/arrow keys/i);
  });

  test("ArrowDown moves the rule down one place", async () => {
    await api.renderCustomRules();
    press(rows()[0].querySelector(".drag-handle"), "ArrowDown");
    await new Promise((r) => setTimeout(r, 0));
    expect(queries()).toEqual([
      "from:b@x.com older_than:1y",
      "from:a@x.com older_than:1y",
      "from:c@x.com older_than:1y"
    ]);
  });

  test("ArrowUp moves it back", async () => {
    await api.renderCustomRules();
    press(rows()[2].querySelector(".drag-handle"), "ArrowUp");
    await new Promise((r) => setTimeout(r, 0));
    expect(queries()).toEqual([
      "from:a@x.com older_than:1y",
      "from:c@x.com older_than:1y",
      "from:b@x.com older_than:1y"
    ]);
  });

  test("the ends do not wrap or lose a rule", async () => {
    await api.renderCustomRules();
    press(rows()[0].querySelector(".drag-handle"), "ArrowUp");
    await new Promise((r) => setTimeout(r, 0));
    expect(queries()).toHaveLength(3);
    expect(queries()[0]).toBe("from:a@x.com older_than:1y");

    press(rows()[2].querySelector(".drag-handle"), "ArrowDown");
    await new Promise((r) => setTimeout(r, 0));
    expect(queries()).toHaveLength(3);
    expect(queries()[2]).toBe("from:c@x.com older_than:1y");
  });

  test("focus follows the rule, so a held key keeps moving it", async () => {
    await api.renderCustomRules();
    press(rows()[0].querySelector(".drag-handle"), "ArrowDown");
    await new Promise((r) => setTimeout(r, 0));
    // Row 1 is now the rule that just moved.
    expect(document.activeElement).toBe(rows()[1].querySelector(".drag-handle"));
  });

  test("the arrow key is consumed so the page does not scroll under it", async () => {
    await api.renderCustomRules();
    const e = press(rows()[0].querySelector(".drag-handle"), "ArrowDown");
    expect(e.defaultPrevented).toBe(true);
  });

  test("a list that shifted underneath still moves the clicked rule", async () => {
    await api.renderCustomRules();
    stored = [rule("from:b@x.com older_than:1y"), rule("from:c@x.com older_than:1y")];
    // Row 0 shows "a", which storage no longer has.
    press(rows()[0].querySelector(".drag-handle"), "ArrowDown");
    await new Promise((r) => setTimeout(r, 0));
    expect(queries()).toEqual(["from:b@x.com older_than:1y", "from:c@x.com older_than:1y"]);
  });
});
