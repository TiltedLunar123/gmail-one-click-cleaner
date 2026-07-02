/**
 * @jest-environment jsdom
 *
 * Subscriptions engine internals (7.0): row sampling for the scan,
 * sender-list sanitizing for the unsubscribe run, header-control and
 * confirm-dialog resolution. DOM fixtures mirror the live 2026 Gmail
 * structures the selectors were verified against (span[email] rows,
 * span.Ca header control, role=alertdialog confirm).
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

const row = (email, name) => `
  <tr role="row" class="zA zE">
    <td role="gridcell" class="yX"><span email="${email}" name="${name}">${name}</span></td>
    <td role="gridcell" class="xY a4W">Subject line</td>
  </tr>`;

describe("subscriptions engine (7.0)", () => {
  test("exposes the new internals under GCC_TEST_MODE", () => {
    const I = loadEngine();
    expect(typeof I.sampleSubscriptionRows).toBe("function");
    expect(typeof I.sanitizeSenderList).toBe("function");
    expect(typeof I.findHeaderUnsubscribeControl).toBe("function");
    expect(typeof I.resolveUnsubscribeDialog).toBe("function");
    expect(I.SUBSCRIPTIONS.MAX_UNSUB_PER_RUN).toBe(25);
  });

  describe("sanitizeConfig runKind routing", () => {
    test("defaults to cleanup and refuses unknown kinds", () => {
      const I = loadEngine();
      expect(I.sanitizeConfig({}).runKind).toBe("cleanup");
      expect(I.sanitizeConfig({ runKind: "elevate" }).runKind).toBe("cleanup");
      expect(I.sanitizeConfig({ runKind: "subscriptionScan" }).runKind).toBe("subscriptionScan");
      expect(I.sanitizeConfig({ runKind: "unsubscribe" }).runKind).toBe("unsubscribe");
    });

    test("caps and type-filters unsubSenders", () => {
      const I = loadEngine();
      const senders = Array.from({ length: 40 }, (_, i) => `s${i}@x.com`);
      senders.push(42);
      const out = I.sanitizeConfig({ unsubSenders: senders });
      expect(out.unsubSenders).toHaveLength(25);
      expect(out.unsubSenders.every((s) => typeof s === "string")).toBe(true);
    });
  });

  describe("sampleSubscriptionRows", () => {
    test("returns one entry per row including duplicates (volume signal)", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main"><table role="grid">
          ${row("promo@shop.com", "Shop")}
          ${row("promo@shop.com", "Shop")}
          ${row("news@paper.com", "Paper")}
        </table></div>`;
      const out = I.sampleSubscriptionRows();
      expect(out).toHaveLength(3);
      expect(out.filter((e) => e.email === "promo@shop.com")).toHaveLength(2);
      expect(out[2]).toEqual({ email: "news@paper.com", name: "Paper" });
    });

    test("skips rows without a sender email and respects the cap", () => {
      const I = loadEngine();
      const rows = Array.from({ length: 10 }, (_, i) => row(`s${i}@x.com`, `S${i}`)).join("");
      document.body.innerHTML = `
        <div role="main"><table role="grid">
          <tr role="row"><td role="gridcell">no sender markup</td></tr>
          ${rows}
        </table></div>`;
      expect(I.sampleSubscriptionRows({ cap: 5 })).toHaveLength(4);
      expect(I.sampleSubscriptionRows()).toHaveLength(10);
    });
  });

  describe("sanitizeSenderList", () => {
    test("keeps valid emails, lowercased and deduped", () => {
      const I = loadEngine();
      expect(I.sanitizeSenderList(["Promo@Shop.com", "promo@shop.com", "a@b.co"]))
        .toEqual(["promo@shop.com", "a@b.co"]);
    });

    test("drops query-injection attempts and junk", () => {
      const I = loadEngine();
      const out = I.sanitizeSenderList([
        'x@y.com) OR (is:starred',   // breakout attempt
        'a b@c.com',                 // whitespace
        '"quoted"@x.com',            // quotes
        "-in:trash@x.com",           // gmail operator chars are fine in local part? leading dash is
        null,
        42,
        "legit@example.org"
      ]);
      expect(out).toContain("legit@example.org");
      expect(out.some((s) => s.includes(")") || s.includes('"') || s.includes(" "))).toBe(false);
    });

    test("caps at MAX_UNSUB_PER_RUN", () => {
      const I = loadEngine();
      const many = Array.from({ length: 60 }, (_, i) => `s${i}@x.com`);
      expect(I.sanitizeSenderList(many)).toHaveLength(25);
    });
  });

  describe("findHeaderUnsubscribeControl", () => {
    test("finds the span.Ca header control", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main">
          <div class="ha"><span class="Ca" role="link">Unsubscribe</span></div>
        </div>`;
      const el = I.findHeaderUnsubscribeControl();
      expect(el).toBeTruthy();
      expect(el.className).toBe("Ca");
    });

    test("falls back to an exact-text role=link outside the body", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main">
          <span role="link">Unsubscribe</span>
        </div>`;
      expect(I.findHeaderUnsubscribeControl()).toBeTruthy();
    });

    test("never picks unsubscribe links inside the message body or list rows", () => {
      const I = loadEngine();
      document.body.innerHTML = `
        <div role="main">
          <div class="a3s"><a role="link">Unsubscribe</a></div>
          <table><tr role="row"><td><span role="link">Unsubscribe</span></td></tr></table>
        </div>`;
      expect(I.findHeaderUnsubscribeControl()).toBeNull();
    });
  });

  describe("resolveUnsubscribeDialog", () => {
    const dialog = (buttons) => {
      document.body.innerHTML = `
        <div role="alertdialog">${buttons.map((b) => `<button>${b}</button>`).join("")}</div>`;
      return document.querySelector("div[role='alertdialog']");
    };

    test("classifies the direct confirm dialog", () => {
      const I = loadEngine();
      const out = I.resolveUnsubscribeDialog(dialog(["Cancel", "Unsubscribe"]));
      expect(out.kind).toBe("confirm");
      expect(out.confirmBtn.textContent).toBe("Unsubscribe");
      expect(out.cancelBtn.textContent).toBe("Cancel");
    });

    test("classifies the go-to-website hand-off as manual", () => {
      const I = loadEngine();
      const out = I.resolveUnsubscribeDialog(dialog(["Cancel", "Go to website"]));
      expect(out.kind).toBe("manual");
      expect(out.confirmBtn).toBeNull();
    });

    test("unknown dialogs stay unknown and never throw", () => {
      const I = loadEngine();
      expect(I.resolveUnsubscribeDialog(dialog(["OK"])).kind).toBe("unknown");
      expect(I.resolveUnsubscribeDialog(null).kind).toBe("unknown");
    });
  });
});
