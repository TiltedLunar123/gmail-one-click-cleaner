/**
 * @jest-environment node
 *
 * Re-injection safety on the progress page (7.14).
 *
 * Both recovery paths used to force `window.GCC_ATTACHED = false` and
 * inject the engine again without ever asking whether the first one was
 * still there. Silence is not death: the run-level soft cap calls
 * confirm() in the GMAIL tab, which blocks that page's JavaScript
 * entirely, so a perfectly healthy engine stops answering pings the
 * moment it asks the user a question. The progress tab has focus by
 * then, so nobody sees the dialog, auto-reconnect fires after 60s, and
 * a SECOND engine starts deleting from the same mailbox.
 *
 * Source-level pins, matching popup-progress-tab.test.js: driving two
 * live engines against Gmail is not testable in this project.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "progress.js"), "utf-8");

const bodyOf = (startNeedle, endNeedle) => {
  const start = src.indexOf(startNeedle);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endNeedle, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("isEngineAttached probe", () => {
  const helper = bodyOf("const isEngineAttached = async", "const autoReconnectTick");

  test("it reads the engine's own attach flag", () => {
    expect(helper).toContain("window.GCC_ATTACHED");
  });

  test("anything short of a definite false counts as attached", () => {
    // The dangerous direction is injecting over a live engine, so an
    // unreachable or silent tab must read as attached, not as free.
    expect(helper).toMatch(/results\?\.\[0\]\?\.result !== false/);
    expect(helper).toMatch(/catch\s*\{\s*return true;/);
    expect(helper).toMatch(/if \(!gmailTabId \|\| !GCC\.hasChromeScripting\(\)\) return true;/);
  });
});

describe("auto-reconnect never starts a second engine", () => {
  const tick = bodyOf("const autoReconnectTick = async", "const startAutoReconnect =");

  test("it checks attachment before clearing the duplicate guard", () => {
    const guardAt = tick.indexOf("await isEngineAttached()");
    const clearAt = tick.indexOf("window.GCC_ATTACHED = false");
    expect(guardAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(clearAt);
  });

  test("a still-attached engine stops the retry loop instead of re-injecting", () => {
    const guardBlock = tick.slice(
      tick.indexOf("if (await isEngineAttached())"),
      tick.indexOf("window.GCC_ATTACHED = false")
    );
    expect(guardBlock).toContain("stopAutoReconnect()");
    expect(guardBlock).toMatch(/return;/);
    // The user has to be told where the run actually is.
    expect(guardBlock).toContain("Gmail tab");
  });
});

describe("manual re-inject asks first", () => {
  const handler = bodyOf("const handleReinject = async", "// The old toggle only flipped");

  test("a still-attached engine costs an explicit confirmation", () => {
    const guardAt = handler.indexOf("await isEngineAttached()");
    const clearAt = handler.indexOf("window.GCC_ATTACHED = false");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(clearAt);
    expect(handler).toMatch(/confirm\(/);
  });

  test("declining leaves the engine alone", () => {
    expect(handler).toMatch(/if \(!proceed\) \{[\s\S]*?return;\s*\}/);
  });

  test("the escape hatch survives for a genuinely dead engine", () => {
    // Confirming still reaches the original force-clear + inject.
    expect(handler).toContain('files: ["contentScript.js"]');
  });
});
