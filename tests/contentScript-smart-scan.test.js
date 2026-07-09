/**
 * @jest-environment jsdom
 *
 * Smart Suggestions engine internals (7.8): the read-only smartScan
 * path. The signal/veto samplers take an injected fetchCount so the
 * fixtures drive them without Gmail navigation; the safety-critical
 * pieces are the strict-email boundary, the zero-results
 * short-circuit, the veto queries and the score staying in sync with
 * GCC.smart.score.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

function loadEngine(config = {}) {
  window.GCC_ATTACHED = false;
  window.GCC_TEST_MODE = true;
  window.GMAIL_CLEANER_CONFIG = config;
  window.alert = () => {};
  document.body.innerHTML = "";
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
  return window.GCC_INTERNALS;
}

// GCC.smart is the canonical scorer; the engine carries a local copy
// because the content script cannot reference GCC inside Gmail.
const sharedCode = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const iifeMatch = sharedCode.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
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

describe("smart scan engine (7.8)", () => {
  test("exposes the new internals under GCC_TEST_MODE", () => {
    const I = loadEngine();
    expect(typeof I.SMART_SCAN).toBe("object");
    expect(typeof I.gatherSmartSignals).toBe("function");
    expect(typeof I.runSmartVetoes).toBe("function");
    expect(typeof I.scoreSmartSignals).toBe("function");
  });

  test("sanitizeConfig accepts the smartScan run kind and carries known senders", () => {
    const I = loadEngine();
    expect(I.sanitizeConfig({ runKind: "smartScan" }).runKind).toBe("smartScan");
    expect(I.sanitizeConfig({ runKind: "smartSuggest" }).runKind).toBe("cleanup");
    const cfg = I.sanitizeConfig({
      smartKnownSenders: Array.from({ length: 150 }, (_, i) => ({ email: `s${i}@x.com` }))
    });
    expect(cfg.smartKnownSenders).toHaveLength(100);
    expect(I.sanitizeConfig({}).smartKnownSenders).toEqual([]);
  });

  test("query budget constants hold the brief's caps", () => {
    const I = loadEngine();
    expect(I.SMART_SCAN.MAX_SIGNAL_SENDERS).toBeLessThanOrEqual(15);
    // Correspondence veto: about 15 queries per scan, hard cap.
    expect(I.SMART_SCAN.MAX_VETO_SENDERS).toBeLessThanOrEqual(15);
  });

  describe("strict email boundary", () => {
    const SMUGGLERS = [
      "x@y.com) OR (is:starred",
      "a b@c.com",
      "a@b.com OR in:sent",
      '"quoted"@host.com',
      "paren(thesis@x.com",
      "-from:me@x.com",
      "in:sent",
      "user@no-tld"
    ];

    test("sanitizeSmartKnownSenders drops operator smuggling, keeps valid mail", () => {
      const I = loadEngine();
      const out = I.sanitizeSmartKnownSenders([
        ...SMUGGLERS.map((email) => ({ email, count: 5 })),
        { email: "OK@Fine.com", name: "x".repeat(300), count: 99999999, estMb: -4 }
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].email).toBe("ok@fine.com");
      expect(out[0].name).toHaveLength(120);
      expect(out[0].count).toBe(99999);
      expect(out[0].estMb).toBe(0);
    });

    test("sanitizeSmartKnownSenders dedupes and caps at 100", () => {
      const I = loadEngine();
      const dupes = I.sanitizeSmartKnownSenders([
        { email: "a@b.co" }, { email: "A@B.CO" }
      ]);
      expect(dupes).toHaveLength(1);
      const many = I.sanitizeSmartKnownSenders(
        Array.from({ length: 150 }, (_, i) => ({ email: `s${i}@x.com` }))
      );
      expect(many).toHaveLength(100);
    });
  });

  describe("signal and veto query shapes", () => {
    test("signal queries: base, unread-recent-excluded, old share", () => {
      const I = loadEngine();
      expect(I.buildSmartSignalQueries("a@b.co")).toEqual({
        base: "from:(a@b.co)",
        unread: "from:(a@b.co) is:unread older_than:1m",
        old: "from:(a@b.co) older_than:6m"
      });
    });

    test("veto queries: starred and sent correspondence", () => {
      const I = loadEngine();
      expect(I.buildSmartVetoQueries("a@b.co")).toEqual({
        starred: "from:(a@b.co) is:starred",
        sent: "in:sent to:(a@b.co)"
      });
    });
  });

  describe("gatherSmartSignals", () => {
    test("zero results short-circuits after the base query", async () => {
      const I = loadEngine();
      const calls = [];
      const fetchCount = async (q) => { calls.push(q); return 0; };
      const out = await I.gatherSmartSignals({ email: "a@b.co" }, fetchCount);
      expect(out).toBeNull();
      expect(calls).toEqual(["from:(a@b.co)"]);
    });

    test("computes clamped ratios from the three counts", async () => {
      const I = loadEngine();
      const counts = { "from:(a@b.co)": 200, "from:(a@b.co) is:unread older_than:1m": 150, "from:(a@b.co) older_than:6m": 400 };
      const out = await I.gatherSmartSignals({ email: "a@b.co" }, async (q) => counts[q]);
      expect(out.count).toBe(200);
      expect(out.unreadRatio).toBe(0.75);
      expect(out.oldShare).toBe(1); // 400/200 clamps to 1
      expect(out.shape).toBe(false);
    });

    test("carries a known estMb through and flags machine senders", async () => {
      const I = loadEngine();
      const out = await I.gatherSmartSignals(
        { email: "no-reply@big.com", estMb: 300 },
        async () => 10
      );
      expect(out.shape).toBe(true);
      expect(out.estMb).toBe(300);
    });
  });

  describe("runSmartVetoes", () => {
    test("a starred hit vetoes and skips the correspondence query", async () => {
      const I = loadEngine();
      const calls = [];
      const out = await I.runSmartVetoes("a@b.co", async (q) => {
        calls.push(q);
        return q.includes("is:starred") ? 2 : 0;
      });
      expect(out).toEqual({ vetoed: true, reason: "starred" });
      expect(calls).toEqual(["from:(a@b.co) is:starred"]);
    });

    test("any row in Sent means a human relationship: vetoed", async () => {
      const I = loadEngine();
      const out = await I.runSmartVetoes("a@b.co", async (q) =>
        q.startsWith("in:sent") ? 1 : 0
      );
      expect(out).toEqual({ vetoed: true, reason: "correspondence" });
    });

    test("clean sender runs both queries and passes", async () => {
      const I = loadEngine();
      const calls = [];
      const out = await I.runSmartVetoes("a@b.co", async (q) => { calls.push(q); return 0; });
      expect(out.vetoed).toBe(false);
      expect(calls).toEqual(["from:(a@b.co) is:starred", "in:sent to:(a@b.co)"]);
    });
  });

  describe("pre-query vetoes (free)", () => {
    test("whitelist semantics: exact, wildcard, domain incl. subdomains", () => {
      const I = loadEngine();
      expect(I.smartSenderWhitelisted("a@b.co", ["a@b.co"])).toBe(true);
      expect(I.smartSenderWhitelisted("a@b.co", ["*@b.co"])).toBe(true);
      expect(I.smartSenderWhitelisted("a@b.co", ["b.co"])).toBe(true);
      expect(I.smartSenderWhitelisted("a@mail.b.co", ["b.co"])).toBe(true);
      expect(I.smartSenderWhitelisted("a@notb.co", ["b.co"])).toBe(false);
      expect(I.smartSenderWhitelisted("a@b.co", [])).toBe(false);
    });

    test("protected keywords disqualify by address or display name", () => {
      const I = loadEngine();
      expect(I.smartSenderProtected("invoices@x.com", "", ["invoice"])).toBe(true);
      expect(I.smartSenderProtected("a@x.com", "Tax Office", ["tax"])).toBe(true);
      expect(I.smartSenderProtected("a@x.com", "Newsletter", ["tax"])).toBe(false);
    });

    test("sender shape matches machine addresses only", () => {
      const I = loadEngine();
      expect(I.smartSenderShape("no-reply@shop.com")).toBe(true);
      expect(I.smartSenderShape("noreply@shop.com")).toBe(true);
      expect(I.smartSenderShape("donotreply@shop.com")).toBe(true);
      expect(I.smartSenderShape("notifications@app.com")).toBe(true);
      expect(I.smartSenderShape("newsletter@blog.com")).toBe(true);
      expect(I.smartSenderShape("marketing@corp.com")).toBe(true);
      expect(I.smartSenderShape("jane.doe@gmail.com")).toBe(false);
      expect(I.smartSenderShape("support@shop.com")).toBe(false);
    });
  });

  describe("countCurrentResults over DOM fixtures", () => {
    test("prefers the pagination total when Gmail shows one", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main">
          <span>1-50 of 142</span>
          <table role="grid">
            <tr role="row"><td><span email="a@x.com">A</span></td></tr>
          </table>
        </div>`;
      expect(I.countCurrentResults()).toBe(142);
    });

    test("falls back to visible rows without pagination text", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main"><table role="grid">
          <tr role="row"><td>a</td></tr>
          <tr role="row"><td>b</td></tr>
        </table></div>`;
      expect(I.countCurrentResults()).toBe(2);
    });

    test("a settled empty state counts zero", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main"><table role="grid"></table><td class="TC"></td></div>`;
      expect(I.countCurrentResults()).toBe(0);
    });
  });

  test("engine score copy stays in sync with GCC.smart.score", () => {
    const I = loadEngine();
    const FIXTURES = [
      { count: 0, unreadRatio: 1, oldShare: 1, shape: true },
      { count: 1, unreadRatio: 0, oldShare: 0, shape: false },
      { count: 142, unreadRatio: 0.96, oldShare: 0.7, shape: true },
      { count: 5000, unreadRatio: 1, oldShare: 1, shape: true },
      { count: 50, unreadRatio: 9, oldShare: -3, shape: false },
      { count: 99999, unreadRatio: 0.33, oldShare: 0.5, shape: false },
      {}
    ];
    for (const signals of FIXTURES) {
      expect(I.scoreSmartSignals(signals)).toBe(GCC.smart.score(signals));
    }
  });
});
