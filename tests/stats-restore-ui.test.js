/**
 * Restore UI wiring on the Stats page (7.6). The recovery log gained a
 * per-entry Restore button; this suite pins (a) the page structure the
 * script depends on, including that the pre-7.6 ids did not move, (b)
 * the accessibility contract of the new live status region, and (c)
 * that stats.js actually wires the documented pieces: eligibility from
 * GCC.restore, the runKind "restoreRun" injection, cancel, and the
 * progress listener.
 */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "stats.html"), "utf-8");
const statsJs = fs.readFileSync(path.join(__dirname, "..", "stats.js"), "utf-8");
const popupJs = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf-8");
const doc = new DOMParser().parseFromString(html, "text/html");
const byId = (id) => doc.getElementById(id);

describe("stats.html structure", () => {
  test.each(["undoList", "refreshUndoBtn", "clearUndoBtn"])(
    "pre-7.6 id #%s is still present",
    (id) => {
      expect(byId(id)).not.toBeNull();
    }
  );

  test("the new restore status region exists and is a polite live region", () => {
    const el = byId("restoreStatus");
    expect(el).not.toBeNull();
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });

  test("no duplicate ids anywhere on the page", () => {
    const seen = {};
    for (const el of doc.querySelectorAll("[id]")) {
      expect(seen[el.id]).toBeUndefined();
      seen[el.id] = true;
    }
  });

  test("restore styling stays on theme tokens (no hardcoded colors in the new rules)", () => {
    const style = html.slice(html.indexOf("/* 7.6 restore controls"), html.indexOf(".restore-status"));
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(style).not.toMatch(/rgba?\(/);
  });
});

describe("stats.js wiring", () => {
  test("eligibility comes from the shared policy, not a local copy", () => {
    expect(statsJs).toContain("GCC.restore.eligibility(entry)");
  });

  test("the restore run is injected through the engine's runKind route", () => {
    expect(statsJs).toContain('runKind: "restoreRun"');
    expect(statsJs).toContain('files: ["contentScript.js"]');
    expect(statsJs).toContain("restoreLabel: entry.tagLabel");
  });

  test("an attached run on the Gmail tab blocks a second injection", () => {
    expect(statsJs).toContain("window.GCC_ATTACHED");
  });

  test("cancel reaches the engine through the existing message", () => {
    expect(statsJs).toContain('{ type: "gmailCleanerCancel" }');
  });

  test("progress is filtered to the restore run kind", () => {
    expect(statsJs).toContain('msg.runKind !== "restoreRun"');
  });

  test("ineligible entries render a visible plain-words reason", () => {
    expect(statsJs).toContain("undo-restore-reason");
    expect(statsJs).toContain("textContent: verdict.reason");
  });

  test("the Gmail host grant is checked before injecting", () => {
    expect(statsJs).toContain("GCC.gmailAccess.check()");
  });
});

describe("popup.js stays out of restore runs", () => {
  test("restoreRun progress returns early instead of hitting the subscriptions UI", () => {
    expect(popupJs).toContain('if (msg.runKind === "restoreRun") return;');
  });
});
