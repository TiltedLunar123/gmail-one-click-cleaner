/**
 * @jest-environment node
 *
 * 9.4 polish sweep. Everything here is a claim the user reads or a
 * control the user reaches, pinned against the code that has to keep it
 * true. Static-source assertions on purpose: these are the surfaces that
 * drift silently because nothing executes them.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const POPUP_HTML = read("popup.html");
const POPUP_JS = read("popup.js");
const OPTIONS_HTML = read("options.html");
const README = read("README.md");
const CONTENT = read("contentScript.js");
const EN = JSON.parse(read("_locales/en/messages.json"));

const LOCALES = fs
  .readdirSync(path.join(ROOT, "_locales"))
  .filter((d) => fs.statSync(path.join(ROOT, "_locales", d)).isDirectory());

const flatten = (s) => s.replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ");

describe("the skip link reaches an action that is actually on screen", () => {
  // The skip link is the FIRST focusable element in the popup and exists
  // for the keyboard user who does not want to tab through the header.
  // It pointed at #runCleanup, which lives inside #tabPanelClean. The
  // popup lands on Report, so that panel carries the hidden attribute,
  // so the target had a 0x0 box and the jump moved focus nowhere at all:
  // measured in a real Chrome, document.activeElement was still BODY
  // after the click. The one control built for that user did nothing on
  // the tab the popup opens on.

  test("the skip link does not hardcode a target inside one panel", () => {
    const link = POPUP_HTML.match(/<a[^>]*class="skip-link"[^>]*>/);
    expect(link).not.toBeNull();
    const href = link[0].match(/href="([^"]*)"/);
    expect(href).not.toBeNull();
    // "#" is the only honest static href: which action is "main" depends
    // on the selected tab, which is a runtime fact.
    expect(href[1]).toBe("#");
  });

  test("every tab panel names its own primary action", () => {
    const panels = [...POPUP_HTML.matchAll(/<div class="tab-panel"[^>]*>/g)].map((m) => m[0]);
    expect(panels.length).toBe(4);
    for (const panel of panels) {
      const id = panel.match(/id="([^"]+)"/)[1];
      const action = panel.match(/data-main-action="([^"]+)"/);
      // Named in the message so a failure says which panel, not "null".
      expect(`${id}: ${action ? action[1] : "NO data-main-action"}`).toMatch(/: [a-zA-Z]/);
      expect(action).not.toBeNull();
      // The named control has to exist, or the skip link lands nowhere
      // again, just at a different address.
      expect(POPUP_HTML).toContain(`id="${action[1]}"`);
    }
  });

  test("the handler resolves the action from the panel that is visible", () => {
    // dataset.mainAction is the binding for the data-main-action above.
    expect(POPUP_JS).toMatch(/dataset\.mainAction|data-main-action/);
    // Visible means "not the hidden one". Resolving against the first
    // panel in document order would reproduce the original bug.
    expect(POPUP_JS).toMatch(/\.tab-panel:not\(\[hidden\]\)/);
  });
});

describe("a report row does not hide the word that says what it does", () => {
  // .report-row-meta is nowrap + ellipsis, and renderReport set
  // textContent with no title. Measured in Chrome at both 380 and 440:
  // six of ten rows clip, and the clipped tail is the action, so
  // "10 to 25 MB, older than 6 months - to Trash" reaches the user as
  // "10 to 25 MB, older than 6 months - to...". Whether a step deletes
  // or archives is the half that got cut.

  test("the meta line still clips, so the fix has to be a title", () => {
    const css = POPUP_HTML.slice(POPUP_HTML.indexOf(".report-row-meta"));
    const block = css.slice(0, css.indexOf("}"));
    expect(block).toContain("text-overflow: ellipsis");
  });

  test("renderReport carries the full text in a title attribute", () => {
    const at = POPUP_JS.indexOf('meta.className = "report-row-meta"');
    expect(at).toBeGreaterThan(-1);
    const near = POPUP_JS.slice(at, at + 1500);
    expect(near).toMatch(/meta\.title\s*=/);
  });
});

describe("Safe Mode is described as the two things it does", () => {
  // The engine does exactly two things: it appends a negative subject
  // clause built from SAFE_MODE_SUBJECT_TERMS (receipt, invoice, order,
  // shipping, tracking, delivery, confirmation, refund, return), and it
  // drops any rule containing category:updates or category:forums. Three
  // surfaces described that three different ways and none of them was
  // both halves.

  test("the engine still does both halves, so both belong in the copy", () => {
    expect(CONTENT).toContain("SAFE_MODE_SUBJECT_TERMS");
    expect(CONTENT).toContain('const riskyCategories = ["category:updates", "category:forums"];');
  });

  test("the popup hint names updates as well as forums", () => {
    // It said "receipts, shipping, and forums", which drops half of the
    // rule filter: a Safe Mode run also skips category:updates.
    const hint = EN.safeHint.message.toLowerCase();
    expect(hint).toContain("receipt");
    expect(hint).toContain("updates");
    expect(hint).toContain("forums");
  });

  test("the Rules page names the subject guard, not only the categories", () => {
    const at = OPTIONS_HTML.indexOf("Safe Mode does two things");
    expect(at).toBeGreaterThan(-1);
    const sentence = flatten(OPTIONS_HTML.slice(at, at + 600)).toLowerCase();
    expect(sentence).toContain("category:updates");
    expect(sentence).toContain("category:forums");
    // The half that was missing entirely: the subject guard is the
    // reason a receipt survives a Safe Mode run.
    expect(sentence).toContain("subject");
  });

  test("the README does not call the subject words categories", () => {
    const line = README.split("\n").find((l) => l.startsWith("- **Safe Mode**"));
    expect(line).toBeTruthy();
    const low = line.toLowerCase();
    expect(low).toContain("subject");
    expect(low).toContain("updates");
    expect(low).toContain("forums");
  });
});

describe("the paid feature list has one source and every surface follows it", () => {
  // shared.js PRO_FEATURES is the single answer and options.html renders
  // from it, pinned at eight since 9.0. README said "six things" and the
  // popup's own pitch named six. That sentence has now gone stale in
  // exactly this way four times, and the two surfaces that drifted are
  // the two the existing pin does not reach.

  const SHARED = read("shared.js");
  const count = (() => {
    const at = SHARED.indexOf("const PRO_FEATURES = Object.freeze([");
    const list = SHARED.slice(at, SHARED.indexOf("]);", at));
    return list.split("\n").filter((l) => /^\s*"/.test(l)).length;
  })();

  test("the list is still eight, so the copy below is measured against it", () => {
    expect(count).toBe(8);
  });

  test("the README does not state a count that can go stale", () => {
    const at = README.indexOf("Pro is a **one-time $9.99 purchase**");
    expect(at).toBeGreaterThan(-1);
    const para = README.slice(at, README.indexOf("\n", at));
    // A written-out number is the thing that rots. Naming the features
    // is not, because adding one adds a clause.
    expect(para).not.toMatch(/\bunlocks (one|two|three|four|five|six|seven|eight|nine|ten) things\b/);
  });

  test("the README and the popup pitch name the two 8.26 features", () => {
    const readmePara = README.slice(README.indexOf("Pro is a **one-time $9.99 purchase**"));
    const para = readmePara.slice(0, readmePara.indexOf("\n")).toLowerCase();
    const pitch = EN.proPromoBody.message.toLowerCase();
    for (const surface of [para, pitch]) {
      expect(surface).toContain("census");
      // The unsubscribe check. "unsubscribe" alone is the bulk feature.
      expect(surface).toMatch(/honoured|honored|check/);
    }
  });
});

describe("one recommendation per question", () => {
  // The Rule Intensity select recommended Monthly three lines above the
  // option it ships selected, while options.html and the README both put
  // Recommended on Normal. A list that recommends against its own
  // default is not a preference, it is a contradiction the user has to
  // resolve.

  test("the intensity select does not recommend an option it does not select", () => {
    const at = POPUP_HTML.indexOf('<select id="intensity"');
    expect(at).toBeGreaterThan(-1);
    // Comments stripped, per the rule this repo keeps relearning in the
    // other direction: a pin prose can satisfy is not a pin, and a pin
    // prose can BREAK is not one either. The comment explaining this fix
    // has to say the word the fix removes.
    const select = POPUP_HTML.slice(at, POPUP_HTML.indexOf("</select>", at))
      .replace(/<!--[\s\S]*?-->/g, " ");
    const selected = select.match(/<option value="([^"]+)"[^>]*\sselected/);
    expect(selected).not.toBeNull();
    for (const line of select.split("\n")) {
      if (!/recommended/i.test(line)) continue;
      expect(line).toMatch(/\sselected/);
    }
  });

  test("no locale keeps the recommendation on the option that is not selected", () => {
    for (const loc of LOCALES) {
      const cat = JSON.parse(read(`_locales/${loc}/messages.json`));
      if (!cat.intMonthly) continue;
      expect(cat.intMonthly.message.toLowerCase()).not.toMatch(
        /recommend|empfohl|recomend|recommand|推奨|рекоменд/
      );
    }
  });
});

describe("copy that names one browser on a page both browsers get", () => {
  // The Firefox build ships the same options.html.
  test("the notification hint does not say Chrome", () => {
    const at = OPTIONS_HTML.indexOf("notifyOnComplete");
    expect(at).toBeGreaterThan(-1);
    const near = flatten(OPTIONS_HTML.slice(at, at + 1200));
    expect(near).not.toMatch(/\bChrome will\b/);
  });
});

describe("numbers the user can change are not stated as fixed", () => {
  // Auto-Pilot's sweep size is a Pro Setting offering 10, 25 and 50. 25
  // is the default, and the README stated it as the cap, full stop.
  test("the README does not pin the Auto-Pilot sweep size", () => {
    const line = README.split("\n").find((l) => l.includes("Auto-Pilot never deletes"));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/capped at 25 senders/);
  });

  test("Pro Settings still offers all three sizes, which is why", () => {
    const at = OPTIONS_HTML.indexOf("proAutoPilotMaxSenders");
    expect(at).toBeGreaterThan(-1);
    const select = OPTIONS_HTML.slice(at, OPTIONS_HTML.indexOf("</select>", at));
    for (const n of ["10", "25", "50"]) expect(select).toContain(`value="${n}"`);
  });
});

describe("the default skips are counted the same everywhere", () => {
  // Four switches ship checked: Starred, Important, unread, labeled.
  // Onboarding named two, the line under Run named three, the README
  // named two. Under-promising on a safety claim is still a wrong claim,
  // and it is the claim that decides whether someone presses the button.

  const DEFAULT_ON = ["skipStarred", "skipImportant", "skipUnread", "skipLabeled"];

  test("all four still ship checked, which is what the copy has to match", () => {
    for (const id of DEFAULT_ON) {
      const tag = POPUP_HTML.match(new RegExp(`<input id="${id}"[^>]*>`));
      expect(tag).not.toBeNull();
      expect(`${id} ${tag[0]}`).toContain(" checked");
    }
  });

  test("onboarding names labelled mail as well", () => {
    const low = EN.onbLi3.message.toLowerCase();
    for (const word of ["starred", "important", "unread", "label"]) {
      expect(low).toContain(word);
    }
  });

  test("the README names all four", () => {
    const line = README.split("\n").find((l) => l.startsWith("- **Skip Starred"));
    expect(line).toBeTruthy();
    const low = line.toLowerCase();
    for (const word of ["starred", "important", "unread", "label"]) {
      expect(low).toContain(word);
    }
  });
});
