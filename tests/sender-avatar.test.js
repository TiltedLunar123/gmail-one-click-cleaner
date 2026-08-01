/**
 * @jest-environment node
 *
 * Sender avatars (8.4).
 *
 * The Unsubscribe list now draws a mark per sender so a row is
 * something you can spot instead of a line of text to read. The
 * obvious way to build that is a favicon per sender, and the reason
 * this is arithmetic instead is that a favicon is a network request:
 * one per sender, to a third party, handing over the list of who mails
 * you, in an extension whose whole verifiable claim is that it makes no
 * requests at all.
 *
 * So the properties worth pinning are the ones that keep it honest and
 * keep it useful:
 *
 *   - nothing in the avatar path can reach the network
 *   - the same sender always gets the same mark, across sessions and
 *     across machines, with no stored state
 *   - addresses at one company land on ONE colour, which is the entire
 *     point of stripping delivery subdomains
 *   - every palette entry actually clears 4.5:1 against the white
 *     letter drawn on it, computed here rather than eyeballed
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(ROOT, "shared.js"), "utf-8");
const iifeMatch = code.match(/const GCC = ([\s\S]*);[\s]*$/);
const GCC = new Function("document", "window", "chrome", `return ${iifeMatch[1]}`)(
  {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {}
  },
  {},
  undefined
);

const { avatar } = GCC;

// --- WCAG relative luminance, so the palette claim is measured -------
const channel = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = (hex) => {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrastWithWhite = (hex) => 1.05 / (luminance(hex) + 0.05);

describe("brand extraction", () => {
  test("delivery subdomains are stripped so one company is one brand", () => {
    for (const address of [
      "hi@substack.com",
      "news@news.substack.com",
      "x@email.substack.com",
      "y@mg.substack.com",
      "z@e.mail.substack.com"
    ]) {
      expect(avatar.brand(address)).toBe("substack");
    }
  });

  test("a delivery word is kept when it IS the brand", () => {
    // news.substack.com is Substack. news.com is News.
    expect(avatar.brand("a@news.com")).toBe("news");
    expect(avatar.brand("a@mail.com")).toBe("mail");
    expect(avatar.brand("a@link.net")).toBe("link");
  });

  test("a delivery word is kept when it is the brand under co.uk too", () => {
    // The bug that killed the first version of this. It stripped a
    // hardcoded list of delivery words from the left, so news.co.uk,
    // mail.co.uk and e.co.uk, all real registrable domains, collapsed
    // to the brand "co" and every one of them drew the same mark.
    expect(avatar.brand("a@news.co.uk")).toBe("news");
    expect(avatar.brand("a@mail.co.uk")).toBe("mail");
    expect(avatar.brand("a@updates.com.au")).toBe("updates");
    // And they read as different senders. Not by colour: twelve
    // colours over the whole internet collide constantly, and "news"
    // and "mail" genuinely land on the same one. By letter, which is
    // the half of the mark that is not a hash.
    expect(avatar.forSender("a@news.co.uk", "").initial).toBe("N");
    expect(avatar.forSender("a@mail.co.uk", "").initial).toBe("M");
  });

  test("multi-part public suffixes do not eat the brand", () => {
    expect(avatar.brand("a@bbc.co.uk")).toBe("bbc");
    expect(avatar.brand("a@email.bbc.co.uk")).toBe("bbc");
    expect(avatar.brand("a@shop.myer.com.au")).toBe("myer");
    expect(avatar.brand("a@x.go.jp")).toBe("x");
  });

  test("ordinary addresses resolve to the obvious label", () => {
    expect(avatar.brand("someone@gmail.com")).toBe("gmail");
    expect(avatar.brand("no-reply@accounts.google.com")).toBe("google");
    expect(avatar.brand("deals@e.walmart.com")).toBe("walmart");
    expect(avatar.brand("a@t.co")).toBe("t");
  });

  test("junk in, no throw out", () => {
    for (const bad of ["", null, undefined, "not-an-address", "@", "a@", 42, {}]) {
      expect(() => avatar.brand(bad)).not.toThrow();
      expect(typeof avatar.brand(bad)).toBe("string");
    }
  });
});

describe("the mark itself", () => {
  test("the same address always produces the same mark", () => {
    const a = avatar.forSender("news@substack.com", "Substack");
    const b = avatar.forSender("news@substack.com", "Substack");
    expect(a).toEqual(b);
    // No stored state anywhere: a fresh profile draws the same thing.
    expect(a.bg).toBe(avatar.forSender("news@substack.com", "Different Name").bg);
  });

  test("addresses at one company share a colour", () => {
    const one = avatar.forSender("news@news.substack.com", "Substack");
    const two = avatar.forSender("noreply@email.substack.com", "Substack Digest");
    expect(one.bg).toBe(two.bg);
    expect(one.initial).toBe(two.initial);
  });

  test("different companies mostly do not collide", () => {
    // Twelve colours over many senders will collide sometimes; that is
    // fine and expected. What would not be fine is a hash that barely
    // moves, so this checks the palette is genuinely being spread.
    const brands = [
      "a@substack.com", "a@github.com", "a@amazon.com", "a@netflix.com",
      "a@spotify.com", "a@linkedin.com", "a@reddit.com", "a@medium.com",
      "a@stripe.com", "a@figma.com", "a@notion.so", "a@dropbox.com",
      "a@slack.com", "a@twitch.tv", "a@paypal.com", "a@ebay.com"
    ];
    const used = new Set(brands.map((b) => avatar.forSender(b, "").bg));
    expect(used.size).toBeGreaterThanOrEqual(6);
  });

  test("the initial comes from the brand, uppercased", () => {
    expect(avatar.forSender("news@news.substack.com", "").initial).toBe("S");
    expect(avatar.forSender("x@bbc.co.uk", "").initial).toBe("B");
    expect(avatar.forSender("deals@e.walmart.com", "Walmart").initial).toBe("W");
  });

  test("a brandless address still gets a letter rather than a blank square", () => {
    expect(avatar.forSender("", "Jane Roe").initial).toBe("J");
    expect(avatar.forSender("weird", "").initial).toBe("W");
    expect(avatar.forSender("", "").initial).toBe("?");
    // Non-Latin display names are letters too; \p{L} not [a-z].
    expect(avatar.forSender("", "Ирина").initial).toBe("И");
  });

  test("host is carried through for the tooltip", () => {
    expect(avatar.forSender("news@email.substack.com", "").host).toBe("email.substack.com");
    expect(avatar.forSender("nonsense", "").host).toBe("");
  });
});

describe("the palette is legible, not just pretty", () => {
  test("white text clears 4.5:1 on every entry", () => {
    for (const hex of avatar.PALETTE) {
      const ratio = contrastWithWhite(hex);
      if (ratio < 4.5) {
        throw new Error(`${hex} gives only ${ratio.toFixed(2)}:1 against white`);
      }
    }
  });

  test("forSender only ever asks for white, so that check covers it", () => {
    expect(avatar.forSender("a@b.com", "").fg).toBe("#ffffff");
  });

  test("every colour handed out is one of the audited entries", () => {
    for (let i = 0; i < 200; i++) {
      const mark = avatar.forSender(`user${i}@brand${i}.com`, `Brand ${i}`);
      expect(avatar.PALETTE).toContain(mark.bg);
    }
  });
});

describe("no network, which is the whole reason this is hand-rolled", () => {
  const AVATAR_FILES = ["shared.js", "popup.js"];

  test("the avatar path never fetches anything", () => {
    for (const file of AVATAR_FILES) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf-8");
      for (const banned of ["fetch(", "XMLHttpRequest", "sendBeacon", "new WebSocket", "EventSource"]) {
        expect(src).not.toContain(banned);
      }
    }
  });

  test("no image element and no remote URL is built for a sender", () => {
    const popup = fs.readFileSync(path.join(ROOT, "popup.js"), "utf-8");
    const helper = popup.slice(
      popup.indexOf("const makeSenderAvatar"),
      popup.indexOf("const renderSubsList")
    );
    expect(helper.length).toBeGreaterThan(100);
    expect(helper).not.toContain("createElement(\"img\")");
    expect(helper).not.toMatch(/https?:\/\//);
    // The favicon services someone would reach for first.
    expect(popup).not.toContain("s2/favicons");
    expect(popup).not.toContain("favicon");
    expect(popup).not.toContain("gravatar");
  });

  test("the mark is built from the address, not from anything stored", () => {
    const shared = fs.readFileSync(path.join(ROOT, "shared.js"), "utf-8");
    const block = shared.slice(
      shared.indexOf("// Sender avatars (8.4)"),
      shared.indexOf("// Popup UI policy (7.3)")
    );
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toContain("storage");
    expect(block).not.toContain("Math.random");
    expect(block).not.toContain("Date.now");
  });
});

describe("it is wired into the list, not merely defined", () => {
  const popup = fs.readFileSync(path.join(ROOT, "popup.js"), "utf-8");
  const html = fs.readFileSync(path.join(ROOT, "popup.html"), "utf-8");

  test("the unsubscribe rows draw one", () => {
    const renderer = popup.slice(
      popup.indexOf("const renderSubsList"),
      popup.indexOf("const loadStoredSubscriptions")
    );
    expect(renderer).toContain("makeSenderAvatar(sender.email, sender.name)");
  });

  test("it sits inside the row label, ahead of the name", () => {
    const renderer = popup.slice(
      popup.indexOf("const renderSubsList"),
      popup.indexOf("const loadStoredSubscriptions")
    );
    const avatarAt = renderer.indexOf("makeSenderAvatar");
    const textAt = renderer.indexOf("label.appendChild(text)");
    expect(avatarAt).toBeGreaterThan(-1);
    expect(textAt).toBeGreaterThan(avatarAt);
  });

  test("it is decorative, because the name and address are right beside it", () => {
    const helper = popup.slice(
      popup.indexOf("const makeSenderAvatar"),
      popup.indexOf("const renderSubsList")
    );
    expect(helper).toContain('setAttribute("aria-hidden", "true")');
  });

  test("popup.html styles it at a fixed size so rows stay aligned", () => {
    expect(html).toContain(".subs-avatar {");
    const block = html.slice(html.indexOf(".subs-avatar {"), html.indexOf(".subs-row-text {"));
    expect(block).toMatch(/width:\s*24px/);
    expect(block).toMatch(/height:\s*24px/);
    expect(block).toMatch(/flex:\s*0 0 auto/);
  });
});
