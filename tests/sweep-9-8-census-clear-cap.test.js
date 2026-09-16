/**
 * @jest-environment node
 *
 * 9.8: the census Clear button quoted a number for every sender ticked,
 * and then cleared twenty-five of them.
 *
 * This is the bug 9.1 fixed on the button directly beneath it. The
 * receipts clear slices to MAX_VERIFY_PER_RUN, so receiptsClearable
 * measures only the senders that slice reaches and reports the rest as
 * `stranded`. The census clear slices to MAX_RULE_SENDERS in exactly the
 * same way, and censusClearable measured all of them: tick forty senders
 * and the subtitle promised what forty would give back over a button
 * that cleared twenty-five.
 *
 * The two halves also disagreed about WHICH twenty-five. The subtitle
 * walked the ranked list; the handler sliced `state.census.checked`,
 * which is a Set in the order the boxes were ticked. So the number
 * described the twenty-five biggest ticked senders and the run took the
 * twenty-five ticked first, and on any selection past the cap those are
 * different sets.
 *
 * censusPurgeOrder is the single answer to "which senders, in what
 * order", the way receiptsPurgeOrder is. Ranked, so a run that cannot
 * reach everything reaches the biggest first.
 */
const fs = require("fs");
const path = require("path");

const SHARED = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const POPUP = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf-8");
// eslint-disable-next-line no-new-func
const GCC = new Function(SHARED + "\nreturn GCC;")();

const CAP = GCC.census.LIMITS.MAX_RULE_SENDERS;

// estMb descends with the index, so sender 0 ranks first and sender 39
// last. reachable is a flat 10 so the arithmetic is easy to read.
const makeSenders = (n) =>
  Array.from({ length: n }, (_, i) => ({
    email: `s${String(i).padStart(2, "0")}@shop.example`,
    name: `Shop ${i}`,
    count: 100,
    exact: true,
    estMb: (n - i) * 10,
    estMbExact: true,
    reachable: 10,
    reachableExact: true,
    measured: true
  }));

describe("censusPurgeOrder", () => {
  const senders = makeSenders(40);
  const all = senders.map((s) => s.email);

  test("ranks the ticked senders and caps them at what one run sends", () => {
    const { ordered, acting, stranded } = GCC.census.purgeOrder(senders, all);
    expect(ordered).toHaveLength(40);
    expect(acting).toHaveLength(CAP);
    expect(stranded).toBe(40 - CAP);
  });

  test("the cap takes the biggest, whatever order the boxes were ticked in", () => {
    // Ticked back to front, which is what a Set preserves and what the
    // handler used to slice.
    const reversed = [...all].reverse();
    const { acting } = GCC.census.purgeOrder(senders, reversed);
    expect(acting[0].email).toBe("s00@shop.example");
    expect(acting.map((s) => s.email)).toEqual(senders.slice(0, CAP).map((s) => s.email));
  });

  test("a selection inside the cap strands nobody", () => {
    const { acting, stranded } = GCC.census.purgeOrder(senders, all.slice(0, 5));
    expect(acting).toHaveLength(5);
    expect(stranded).toBe(0);
  });

  test("an unticked sender is not in it, and neither is an unmeasured one", () => {
    const mixed = makeSenders(3).concat([{
      email: "unmeasured@shop.example", count: 0, measured: false
    }]);
    const { ordered } = GCC.census.purgeOrder(mixed, ["s00@shop.example", "unmeasured@shop.example"]);
    expect(ordered.map((s) => s.email)).toEqual(["s00@shop.example"]);
  });

  test("nothing ticked is an empty answer, not the whole list", () => {
    expect(GCC.census.purgeOrder(senders, [])).toEqual({ ordered: [], acting: [], stranded: 0 });
  });
});

describe("censusClearable counts the senders the run reaches", () => {
  const senders = makeSenders(40);
  const all = senders.map((s) => s.email);

  test("forty ticked is twenty-five cleared, and it says so", () => {
    const reach = GCC.census.clearable(senders, all);
    expect(reach.senders).toBe(CAP);
    expect(reach.stranded).toBe(40 - CAP);
    expect(reach.known).toBe(CAP);
    expect(reach.count).toBe(CAP * 10);
  });

  test("a selection inside the cap is unchanged from before", () => {
    const reach = GCC.census.clearable(senders, all.slice(0, 5));
    expect(reach).toMatchObject({ senders: 5, stranded: 0, count: 50, exact: true, known: 5, unknown: 0 });
  });

  test("an unmeasured sender is still unknown rather than zero", () => {
    const mixed = makeSenders(2).concat([{ email: "old@shop.example", count: 40, exact: true, measured: true }]);
    const reach = GCC.census.clearable(mixed, mixed.map((s) => s.email));
    expect(reach.known).toBe(2);
    expect(reach.unknown).toBe(1);
    expect(reach.count).toBe(20);
  });

  test("a floor anywhere in the acting set makes the whole figure a floor", () => {
    const some = makeSenders(3);
    some[1].reachableExact = false;
    expect(GCC.census.clearable(some, some.map((s) => s.email)).exact).toBe(false);
  });
});

describe("the popup takes the senders that answer was about", () => {
  const handler = POPUP.slice(
    POPUP.indexOf("const handleCensusPurge"),
    POPUP.indexOf("const handleReceiptsPurge")
  );

  test("the clear handler asks census.purgeOrder rather than slicing the tick order", () => {
    expect(handler).toContain("GCC.census.purgeOrder(");
    expect(handler).not.toContain("emails.slice(0, GCC.census.LIMITS.MAX_RULE_SENDERS)");
  });

  test("the subtitle says how many were left behind", () => {
    const sub = POPUP.slice(
      POPUP.indexOf("const updateCensusPurgeButton"),
      POPUP.indexOf("const renderCensus =")
    );
    expect(sub).toContain("reach.stranded");
    expect(sub).toContain("purgeStranded");
  });

  test("the scheduled run carries the same twenty-five the button would", () => {
    const picker = POPUP.slice(
      POPUP.indexOf("const censusRunSenders"),
      POPUP.indexOf("const buildConfig")
    );
    expect(picker).toContain("GCC.census.purgeOrder(");
    const build = POPUP.slice(POPUP.indexOf("censusSenders:") - 200, POPUP.indexOf("censusSenders:") + 120);
    expect(build).toContain("censusRunSenders()");
    expect(build).not.toContain("[...state.census.checked].slice(");
  });
});

describe("the catalogue carries the new line", () => {
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "_locales/en/messages.json"), "utf-8"));

  test("purgeStranded exists in every locale with one placeholder", () => {
    for (const loc of ["en", "de", "es", "fr", "ja", "pt_BR", "ru"]) {
      const cat = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "_locales", loc, "messages.json"), "utf-8"));
      expect(cat.purgeStranded).toBeDefined();
      expect(cat.purgeStranded.message).toContain("$1");
    }
    expect(en.purgeStranded.message).toContain("$2");
  });
});
