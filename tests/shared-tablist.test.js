/**
 * GCC.tablist (7.3): the accessible tabs controller behind the popup's
 * Clean / Unsubscribe / Storage bar. Runs in jsdom so the real DOM
 * semantics (roving tabindex, aria-selected, hidden panels, arrow-key
 * navigation) are exercised.
 */
const fs = require("fs");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const iifeMatch = code.match(/const GCC = ([\s\S]*);[\s]*$/);
// Evaluate against jsdom's real document/window so tablist can wire
// events; chrome only needs the minimal shape shared.js probes at load.
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
  document,
  window,
  { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
);

const buildDom = () => {
  document.body.innerHTML = `
    <div id="bar" role="tablist" aria-label="Sections">
      <button type="button" role="tab" id="tabA" aria-controls="panelA" aria-selected="true" tabindex="0">A</button>
      <button type="button" role="tab" id="tabB" aria-controls="panelB" aria-selected="false" tabindex="-1">B</button>
      <button type="button" role="tab" id="tabC" aria-controls="panelC" aria-selected="false" tabindex="-1">C</button>
    </div>
    <div role="tabpanel" id="panelA" aria-labelledby="tabA"></div>
    <div role="tabpanel" id="panelB" aria-labelledby="tabB" hidden></div>
    <div role="tabpanel" id="panelC" aria-labelledby="tabC" hidden></div>
  `;
  return GCC.tablist(document.getElementById("bar"));
};

const selectedOf = () =>
  Array.from(document.querySelectorAll("[role=tab]"))
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.id);

const visiblePanels = () =>
  Array.from(document.querySelectorAll("[role=tabpanel]"))
    .filter((p) => !p.hidden)
    .map((p) => p.id);

const key = (el, k) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("GCC.tablist", () => {
  test("returns null without a root or tabs", () => {
    expect(GCC.tablist(null)).toBeNull();
    document.body.innerHTML = `<div id="empty"></div>`;
    expect(GCC.tablist(document.getElementById("empty"))).toBeNull();
  });

  test("initializes from the markup: one selected tab, one visible panel", () => {
    const api = buildDom();
    expect(api.selectedId()).toBe("tabA");
    expect(selectedOf()).toEqual(["tabA"]);
    expect(visiblePanels()).toEqual(["panelA"]);
    expect(document.getElementById("tabA").getAttribute("tabindex")).toBe("0");
    expect(document.getElementById("tabB").getAttribute("tabindex")).toBe("-1");
  });

  test("clicking a tab selects it and swaps panels", () => {
    const api = buildDom();
    document.getElementById("tabB").click();
    expect(api.selectedId()).toBe("tabB");
    expect(selectedOf()).toEqual(["tabB"]);
    expect(visiblePanels()).toEqual(["panelB"]);
    expect(document.getElementById("tabA").getAttribute("tabindex")).toBe("-1");
    expect(document.getElementById("tabB").getAttribute("tabindex")).toBe("0");
  });

  test("ArrowRight moves and wraps; activation follows focus", () => {
    const api = buildDom();
    const a = document.getElementById("tabA");
    const c = document.getElementById("tabC");
    a.focus();
    key(a, "ArrowRight");
    expect(api.selectedId()).toBe("tabB");
    expect(document.activeElement.id).toBe("tabB");
    key(document.getElementById("tabB"), "ArrowRight");
    expect(api.selectedId()).toBe("tabC");
    key(c, "ArrowRight");
    expect(api.selectedId()).toBe("tabA");
    expect(visiblePanels()).toEqual(["panelA"]);
  });

  test("ArrowLeft wraps backwards", () => {
    const api = buildDom();
    const a = document.getElementById("tabA");
    a.focus();
    key(a, "ArrowLeft");
    expect(api.selectedId()).toBe("tabC");
    expect(visiblePanels()).toEqual(["panelC"]);
  });

  test("Home and End jump to the edges", () => {
    const api = buildDom();
    const a = document.getElementById("tabA");
    a.focus();
    key(a, "End");
    expect(api.selectedId()).toBe("tabC");
    key(document.getElementById("tabC"), "Home");
    expect(api.selectedId()).toBe("tabA");
  });

  test("keys pressed outside the tabs do nothing", () => {
    const api = buildDom();
    document.getElementById("panelA").innerHTML = `<button id="inner">x</button>`;
    const inner = document.getElementById("inner");
    inner.focus();
    key(inner, "ArrowRight");
    expect(api.selectedId()).toBe("tabA");
  });

  test("select(id) drives the tabs programmatically", () => {
    const api = buildDom();
    api.select("tabC");
    expect(api.selectedId()).toBe("tabC");
    expect(visiblePanels()).toEqual(["panelC"]);
    api.select("nonsense");
    expect(api.selectedId()).toBe("tabC");
  });

  test("onSelect fires with the tab id", () => {
    document.body.innerHTML = `
      <div id="bar" role="tablist">
        <button role="tab" id="t1" aria-controls="p1" aria-selected="true">1</button>
        <button role="tab" id="t2" aria-controls="p2" aria-selected="false">2</button>
      </div>
      <div role="tabpanel" id="p1"></div>
      <div role="tabpanel" id="p2" hidden></div>
    `;
    const seen = [];
    GCC.tablist(document.getElementById("bar"), { onSelect: (id) => seen.push(id) });
    document.getElementById("t2").click();
    expect(seen).toEqual(["t1", "t2"]);
  });
});
