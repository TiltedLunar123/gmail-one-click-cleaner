/**
 * @jest-environment node
 *
 * Key recovery by purchase email (7.14). The activate link only works
 * while the buyer still has the URL Stripe redirected them to; this
 * function is the path for everyone who lost it.
 *
 * Money-critical in both directions:
 *   - a real buyer must always get their key back, and it must be the
 *     SAME key, or they end up holding two strings for one purchase;
 *   - a non-buyer must never get one, and the recovery must never see
 *     the other products sold through this shared Stripe account.
 */
const nodeCrypto = require("node:crypto");

const { handler, _internal } = require("../netlify/functions/recover-key.js");
const getKey = require("../netlify/functions/get-key.js");

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const TEST_PRIV_PEM = privateKey.export({ type: "pkcs8", format: "pem" });

const LINK_ID = "plink_TESTLINK123";
const EMAIL = "buyer@example.com";
const SESSION = Object.freeze({
  id: "cs_live_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV",
  payment_status: "paid",
  payment_link: LINK_ID,
  created: 1751500000
});

const request = (body, headers = {}) => ({
  httpMethod: "POST",
  headers: { "x-nf-client-connection-ip": "203.0.113.5", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body)
});

// Stripe's list endpoint. Sessions are keyed by payment link purely for
// readability in the tests; the real query only ever filters on email,
// because Stripe rejects customer_details and payment_link together
// ("You may only specify one of these parameters"). The function is
// responsible for discarding links that are not ours.
const stripeListReturns = (sessionsByLink) => {
  global.fetch = jest.fn(async (url) => {
    const parsed = new URL(url);
    // A payment_link filter would make Stripe 400 the whole request.
    if (parsed.searchParams.get("payment_link")) {
      return {
        status: 400,
        json: async () => ({
          error: {
            type: "invalid_request_error",
            message: "You may only specify one of these parameters: customer_details, payment_link."
          }
        })
      };
    }
    const email = parsed.searchParams.get("customer_details[email]");
    const all = Object.values(sessionsByLink).flat();
    return {
      status: 200,
      json: async () => ({
        data: all.filter((s) => s.customer_details.email === email),
        has_more: false
      })
    };
  });
};

const withEmail = (session, email) => ({ ...session, customer_details: { email } });

const bodyOf = (res) => JSON.parse(res.body);
const payloadOf = (key) => JSON.parse(Buffer.from(String(key).split(".")[1], "base64url").toString());

describe("recover-key function", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "rk_test_fake";
    process.env.LICENSE_PRIVATE_KEY = TEST_PRIV_PEM;
    process.env.STRIPE_PAYMENT_LINK_ID = LINK_ID;
    _internal.rateState.clear();
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.LICENSE_PRIVATE_KEY;
    delete process.env.STRIPE_PAYMENT_LINK_ID;
    delete global.fetch;
  });

  test("returns a verifiable key for the address that paid", async () => {
    stripeListReturns({ [LINK_ID]: [withEmail(SESSION, EMAIL)] });

    const res = await handler(request({ email: EMAIL }));
    expect(res.statusCode).toBe(200);

    const [prefix, payloadPart, sigPart] = bodyOf(res).key.split(".");
    expect(prefix).toBe("GCC1");
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
    expect(payload).toMatchObject({ v: 1, plan: "pro", iat: SESSION.created });

    const valid = nodeCrypto.verify(
      "sha256",
      Buffer.from(payloadPart, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(sigPart, "base64url")
    );
    expect(valid).toBe(true);
  });

  test("recovery mints exactly what checkout would have minted", async () => {
    // ECDSA signing is randomised, so two mints of one purchase are
    // different STRINGS. That is fine (the extension verifies
    // signatures, it never compares keys) but it means the pin has to
    // be on the payload: same purchase, same license, no second
    // entitlement and no drift between the two functions.
    const fromCheckout = payloadOf(getKey._internal.mintKey(TEST_PRIV_PEM, SESSION.id, SESSION.created));
    const fromRecovery = payloadOf(_internal.mintKey(TEST_PRIV_PEM, SESSION.id, SESSION.created));
    expect(fromRecovery).toEqual(fromCheckout);

    stripeListReturns({ [LINK_ID]: [withEmail(SESSION, EMAIL)] });
    expect(payloadOf(bodyOf(await handler(request({ email: EMAIL }))).key)).toEqual(fromCheckout);
  });

  test("a key issued earlier keeps verifying after a re-issue", async () => {
    // The buyer may still be running the original on another machine.
    // Re-issuing must not invalidate it.
    const original = getKey._internal.mintKey(TEST_PRIV_PEM, SESSION.id, SESSION.created);
    stripeListReturns({ [LINK_ID]: [withEmail(SESSION, EMAIL)] });
    const reissued = bodyOf(await handler(request({ email: EMAIL }))).key;

    expect(reissued).not.toBe(original);
    for (const key of [original, reissued]) {
      const [, payloadPart, sigPart] = key.split(".");
      expect(nodeCrypto.verify(
        "sha256",
        Buffer.from(payloadPart, "utf8"),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(sigPart, "base64url")
      )).toBe(true);
    }
  });

  test("repeat buyers always resolve to the same purchase, whatever order Stripe lists", async () => {
    const older = { ...SESSION, id: "cs_live_" + "o".repeat(30), created: 1751000000 };
    const newer = { ...SESSION, id: "cs_live_" + "n".repeat(30), created: 1752000000 };

    stripeListReturns({ [LINK_ID]: [withEmail(newer, EMAIL), withEmail(older, EMAIL)] });
    const first = payloadOf(bodyOf(await handler(request({ email: EMAIL }))).key);

    _internal.rateState.clear();
    stripeListReturns({ [LINK_ID]: [withEmail(older, EMAIL), withEmail(newer, EMAIL)] });
    const second = payloadOf(bodyOf(await handler(request({ email: EMAIL }))).key);

    expect(first).toEqual(second);
    expect(first).toEqual(payloadOf(_internal.mintKey(TEST_PRIV_PEM, older.id, older.created)));
  });

  test("honours every configured payment link, including the legacy $5 one", async () => {
    process.env.STRIPE_PAYMENT_LINK_ID = "plink_OLD5DOLLAR, plink_NEW999";
    const legacy = { ...SESSION, payment_link: "plink_OLD5DOLLAR" };
    stripeListReturns({ plink_OLD5DOLLAR: [withEmail(legacy, EMAIL)], plink_NEW999: [] });

    expect((await handler(request({ email: EMAIL }))).statusCode).toBe(200);
  });

  test("an unpaid session is not a purchase", async () => {
    stripeListReturns({ [LINK_ID]: [withEmail({ ...SESSION, payment_status: "unpaid" }, EMAIL)] });
    expect((await handler(request({ email: EMAIL }))).statusCode).toBe(404);
  });

  test("an address with no purchase gets no key", async () => {
    stripeListReturns({ [LINK_ID]: [withEmail(SESSION, EMAIL)] });
    const res = await handler(request({ email: "stranger@example.com" }));
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).key).toBeUndefined();
  });

  test("a purchase of another product on this account unlocks nothing", async () => {
    // The Stripe account sells other things, and an email-only query
    // returns those sessions too. Discarding them is the security
    // boundary, so it gets a direct test.
    const otherProduct = { ...SESSION, payment_link: "plink_SOMETHING_ELSE" };
    stripeListReturns({ plink_SOMETHING_ELSE: [withEmail(otherProduct, EMAIL)] });

    const res = await handler(request({ email: EMAIL }));
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).key).toBeUndefined();
  });

  test("never sends a payment_link filter, which Stripe rejects outright", async () => {
    // Stripe: "You may only specify one of these parameters:
    // customer_details, payment_link." Sending both 400s the request,
    // which surfaced as a 502 to real buyers.
    stripeListReturns({ [LINK_ID]: [withEmail(SESSION, EMAIL)] });
    const res = await handler(request({ email: EMAIL }));

    expect(res.statusCode).toBe(200);
    expect(global.fetch.mock.calls.length).toBeGreaterThan(0);
    for (const call of global.fetch.mock.calls) {
      const params = new URL(call[0]).searchParams;
      expect(params.get("payment_link")).toBeNull();
      expect(params.get("customer_details[email]")).toBeTruthy();
    }
  });

  test("pages through a long session history to find the purchase", async () => {
    // An email with many sessions on this shared account could push the
    // real purchase past the first page.
    const filler = Array.from({ length: 100 }, (_, i) =>
      withEmail({ ...SESSION, id: `cs_live_${String(i).padStart(30, "f")}`, payment_link: "plink_OTHER" }, EMAIL));
    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      return call === 1
        ? { status: 200, json: async () => ({ data: filler, has_more: true }) }
        : { status: 200, json: async () => ({ data: [withEmail(SESSION, EMAIL)], has_more: false }) };
    });

    expect((await handler(request({ email: EMAIL }))).statusCode).toBe(200);
    expect(call).toBeGreaterThan(1);
  });

  test("matches the address whatever case the buyer typed", async () => {
    stripeListReturns({ [LINK_ID]: [withEmail(SESSION, EMAIL)] });
    expect((await handler(request({ email: "Buyer@Example.com" }))).statusCode).toBe(200);
  });

  test("rejects junk before spending a Stripe call", async () => {
    global.fetch = jest.fn();
    for (const bad of [undefined, "", "   ", "not-an-email", "a@b", "@example.com", "x".repeat(260) + "@e.com"]) {
      expect((await handler(request({ email: bad }))).statusCode).toBe(400);
    }
    expect((await handler({ httpMethod: "POST", headers: {}, body: "{not json" })).statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("GET is refused, so the address never rides in a URL", async () => {
    global.fetch = jest.fn();
    const res = await handler({ httpMethod: "GET", headers: {}, body: null });
    expect(res.statusCode).toBe(405);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("fails closed on missing configuration", async () => {
    global.fetch = jest.fn();
    for (const missing of ["STRIPE_SECRET_KEY", "LICENSE_PRIVATE_KEY", "STRIPE_PAYMENT_LINK_ID"]) {
      const saved = process.env[missing];
      delete process.env[missing];
      const res = await handler(request({ email: EMAIL }));
      expect(res.statusCode).toBe(503);
      expect(bodyOf(res).key).toBeUndefined();
      process.env[missing] = saved;
    }
    // A list that trims to nothing is also no configuration.
    process.env.STRIPE_PAYMENT_LINK_ID = " , ";
    expect((await handler(request({ email: EMAIL }))).statusCode).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("a Stripe outage is reported, never treated as 'no purchase'", async () => {
    global.fetch = jest.fn(async () => { throw new Error("boom"); });
    expect((await handler(request({ email: EMAIL }))).statusCode).toBe(502);

    global.fetch = jest.fn(async () => ({ status: 401, json: async () => ({ error: {} }) }));
    _internal.rateState.clear();
    expect((await handler(request({ email: EMAIL }))).statusCode).toBe(502);
  });

  test("throttles repeated guesses from one caller", async () => {
    stripeListReturns({ [LINK_ID]: [] });
    const budget = _internal.RATE_LIMIT.MAX_PER_WINDOW;

    for (let i = 0; i < budget; i++) {
      expect((await handler(request({ email: `guess${i}@example.com` }))).statusCode).toBe(404);
    }
    expect((await handler(request({ email: "one-too-many@example.com" }))).statusCode).toBe(429);

    // A different caller is unaffected.
    const other = request({ email: EMAIL }, { "x-nf-client-connection-ip": "198.51.100.9" });
    expect((await handler(other)).statusCode).toBe(404);
  });

  test("the window reopens once it has passed", async () => {
    const now = 1_000_000;
    const ip = "203.0.113.77";
    for (let i = 0; i < _internal.RATE_LIMIT.MAX_PER_WINDOW; i++) {
      expect(_internal.isRateLimited(ip, now)).toBe(false);
    }
    expect(_internal.isRateLimited(ip, now)).toBe(true);
    expect(_internal.isRateLimited(ip, now + _internal.RATE_LIMIT.WINDOW_MS + 1)).toBe(false);
  });
});
