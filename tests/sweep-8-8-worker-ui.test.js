/**
 * @jest-environment node
 *
 * Worker and page findings from the 8.8 sweep.
 *
 * Every assertion here was checked to FAIL against the 8.7.0 source.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const popupSrc = read("popup.js");
const popupHtml = read("popup.html");
const sharedSrc = read("shared.js");

const LOCALES = ["en", "pt_BR", "es", "fr", "de", "ru", "ja"];
const catalog = (l) => JSON.parse(read(path.join("_locales", l, "messages.json")));

/** Load the GCC namespace out of shared.js the way the other suites do. */
const GCC = (() => {
  const iife = sharedSrc.match(/const GCC = ([\s\S]*);[\s]*$/);
  return new Function("document", "window", "chrome", `return ${iife[1]}`)(
    {
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({
        className: "", setAttribute: () => {}, appendChild: () => {},
        style: {}, classList: { add: () => {}, remove: () => {} },
        remove: () => {}
      }),
      addEventListener: () => {}
    },
    {},
    { runtime: { lastError: null }, storage: { local: { get: () => {} } } }
  );
})();

/** The body of a named function in popup.js, up to the next declaration. */
const fnBody = (src, startMarker, endMarker) => {
  const from = src.indexOf(startMarker);
  expect(from).toBeGreaterThan(-1);
  const to = src.indexOf(endMarker, from);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
};

describe("the Storage X-ray purge deletes, whatever the Clean tab is set to", () => {
  // buildConfig reads the Clean tab's Action dropdown, and that value is
  // persisted in LAST_UI and restored on every popup open. A user who
  // had ever switched Action to Archive got an X-ray "purge" that
  // archived: the button says "Tagged first, then Trash", the summary
  // claims MB freed, and the rows are stamped Purged so a rescan stops
  // offering them, while the mail sits in All Mail and the Google quota
  // the whole feature exists to reclaim does not move at all.
  //
  // The two sibling specialised runs already set their own action; this
  // was the one that still inherited the form's.
  const purge = () => fnBody(popupSrc, "const handleXrayPurge = async () => {", "const setSmartStatus =");

  test("the run forces delete rather than inheriting the form action", () => {
    expect(purge()).toContain("config.archiveInsteadOfDelete = false;");
  });

  test("it is set on the same config the rules override goes onto", () => {
    const body = purge();
    const rules = body.indexOf("config.rulesOverride = purgeQueries;");
    const action = body.indexOf("config.archiveInsteadOfDelete = false;");
    expect(rules).toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(rules);
    // ...and before the config is persisted for a progress-tab reconnect
    // or handed to the injection, either of which would otherwise carry
    // the inherited action forward.
    expect(body.indexOf("await persistLastConfig(config);")).toBeGreaterThan(action);
    expect(body.indexOf("await scriptingExecuteScript({")).toBeGreaterThan(action);
  });

  test("the two sibling specialised runs still set their own action", () => {
    // If either of these regresses to the form's value it is the same
    // bug in a different flow, which is how this one survived 8.7.
    expect(popupSrc).toContain("config.archiveInsteadOfDelete = anyArchive;");
    expect(popupSrc).toContain("config.archiveInsteadOfDelete = Boolean(archive);");
  });
});

describe("the bulk button names the action the run will take", () => {
  // #smartBulkBtnSub was written once in popup.html and never touched
  // again, so it promised "then Trash" for every plan. bulkPlan leads
  // with archiveAll whenever the top checked card is an archive card,
  // which is the ordinary case for a sender the user still reads, and
  // startSmartApplyRun honours that flag: the control said the mail was
  // going to Trash while the run archived it.
  test("the subtitle is updated from the plan, not left as authored", () => {
    expect(popupSrc).toContain("const updateSmartBulkSub = () => {");
    const fn = fnBody(popupSrc, "const updateSmartBulkSub = () => {", "const updateSmartCount");
    expect(fn).toContain("GCC.smart.bulkPlan(chosen).archive");
    expect(fn).toContain('t("planSubArchive"');
    expect(fn).toContain('t("smartBulkSub"');
  });

  test("it runs whenever the selection changes", () => {
    // updateSmartCount is the one thing every checkbox path already
    // calls, so hanging it there is what makes the label keep up.
    const fn = fnBody(popupSrc, "const updateSmartCount = () => {", "const buildSmartCard");
    expect(fn).toContain("updateSmartBulkSub();");
  });

  test("the element it writes to is the one the markup ships", () => {
    expect(popupHtml).toContain('id="smartBulkBtnSub"');
    expect(popupSrc).toContain('smartBulkBtnSub: $("smartBulkBtnSub")');
  });

  test("both strings exist in all seven catalogues", () => {
    // The inline t() fallback is dead text once _locales is present, so
    // a key missing here means the button silently keeps the old word.
    for (const l of LOCALES) {
      const c = catalog(l);
      expect(c.planSubArchive?.message).toBeTruthy();
      expect(c.smartBulkSub?.message).toBeTruthy();
    }
  });
});

describe("no bulk path emits a query past the 512-character ceiling", () => {
  // The storage x-ray learned this in 8.0: twenty-five realistic
  // addresses in one from:() group come to roughly 870 characters
  // against a ceiling validateGmailQuery enforces and the rulesOverride
  // path never calls. Smart bulk shipped the same shape in 8.7 and
  // Auto-Pilot carried its own copy, where nobody would ever see it.
  const REALISTIC = Array.from({ length: 25 }, (_, i) =>
    `no-reply.marketing.department-${String(i).padStart(2, "0")}@news.long-company-domain-example.com`);

  const sendersFor = (action) => REALISTIC.map((email) => ({
    email,
    // deleteOld wants an unread ratio at or above 0.5 without the
    // still-flooding shape that leads with unsubscribe (which needs a
    // measured oldShare at or below 0.6), and an estMb under the 100
    // that would make it a storage purge instead.
    signals: action === "purgeLarge"
      ? { estMb: 500, count: 40 }
      : { estMb: 1, count: 40, unreadRatio: 0.6, oldShare: 1 }
  }));

  test("one over-length group would really have been produced", () => {
    // The arithmetic the fix exists for, so the ceiling is not theory.
    const oneGroup = `from:(${REALISTIC.join(" OR ")}) older_than:6m`;
    expect(oneGroup.length).toBeGreaterThan(GCC.MAX_QUERY_CHARS);
  });

  test("bulkPlan splits into several rules, each inside the ceiling", () => {
    const plan = GCC.smart.bulkPlan(sendersFor("deleteOld"));
    expect(plan.rules.length).toBeGreaterThan(1);
    for (const rule of plan.rules) {
      expect(rule.length).toBeLessThanOrEqual(GCC.MAX_QUERY_CHARS);
      expect(GCC.validateGmailQuery(rule).valid).toBe(true);
    }
  });

  test("splitting loses nobody and keeps the action's own shape", () => {
    const plan = GCC.smart.bulkPlan(sendersFor("deleteOld"));
    const packed = plan.rules.join(" ");
    for (const email of REALISTIC) expect(packed).toContain(email);
    for (const rule of plan.rules) expect(rule).toContain("older_than:6m");
    expect(plan.emails).toHaveLength(25);
  });

  test("buildBulkRules chunks and buildBulkRule returns the first chunk", () => {
    const chunks = GCC.smart.buildBulkRules(REALISTIC);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(GCC.MAX_QUERY_CHARS);
    expect(GCC.smart.buildBulkRule(REALISTIC)).toBe(chunks[0]);
  });

  test("a short list is still one rule with the shape it always had", () => {
    const plan = GCC.smart.bulkPlan([
      { email: "a@x.com", signals: { estMb: 1, count: 40, unreadRatio: 0.6, oldShare: 1 } },
      { email: "b@y.com", signals: { estMb: 1, count: 40, unreadRatio: 0.6, oldShare: 1 } }
    ]);
    expect(plan.rules).toEqual(["from:(a@x.com OR b@y.com) older_than:6m"]);
  });
});
