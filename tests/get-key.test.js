/**
 * License-issuing Netlify function (7.0). Exercises the full handler
 * with a mocked Stripe API: paid sessions on the right payment link
 * mint a verifiable key, everything else is refused, and missing
 * configuration fails closed (503, never a key).
 */
const nodeCrypto = require("node:crypto");

const { handler, _internal } = require("../netlify/functions/get-key.js");

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const TEST_PRIV_PEM = privateKey.export({ type: "pkcs8", format: "pem" });

const SESSION_ID = "cs_live_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV";
const LINK_ID = "plink_TESTLINK123";

const request = (sessionId) => ({
  httpMethod: "GET",
  queryStringParameters: sessionId === undefined ? {} : { session_id: sessionId }
});

const stripeRespondsWith = (status, data) => {
  global.fetch = jest.fn(async () => ({ status, json: async () => data }));
};

describe("get-key function", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "rk_test_fake";
    process.env.LICENSE_PRIVATE_KEY = TEST_PRIV_PEM;
    process.env.STRIPE_PAYMENT_LINK_ID = LINK_ID;
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.LICENSE_PRIVATE_KEY;
    delete process.env.STRIPE_PAYMENT_LINK_ID;
    delete global.fetch;
  });

  test("mints a verifiable key for a paid session on this payment link", async () => {
    stripeRespondsWith(200, { payment_status: "paid", payment_link: LINK_ID, created: 1751500000 });
    const res = await handler(request(SESSION_ID));
    expect(res.statusCode).toBe(200);

    const { key } = JSON.parse(res.body);
    const [prefix, payloadPart, sigPart] = key.split(".");
    expect(prefix).toBe("GCC1");

    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
    expect(payload).toMatchObject({ v: 1, plan: "pro", iat: 1751500000 });

    const valid = nodeCrypto.verify(
      "sha256",
      Buffer.from(payloadPart, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(sigPart, "base64url")
    );
    expect(valid).toBe(true);
  });

  test("refuses unpaid sessions and other products' sessions", async () => {
    stripeRespondsWith(200, { payment_status: "unpaid", payment_link: LINK_ID, created: 1 });
    expect((await handler(request(SESSION_ID))).statusCode).toBe(402);

    stripeRespondsWith(200, { payment_status: "paid", payment_link: "plink_OTHERPRODUCT", created: 1 });
    expect((await handler(request(SESSION_ID))).statusCode).toBe(402);
  });

  test("accepts sessions from any configured payment link (comma list)", async () => {
    // Since the $9.99 move two links sell Pro: the unrepriceable $5
    // link shipped in old versions and the current $9.99 link. Buyers
    // from both must be able to (re)issue their key.
    process.env.STRIPE_PAYMENT_LINK_ID = "plink_OLD5DOLLAR, plink_NEW999";

    stripeRespondsWith(200, { payment_status: "paid", payment_link: "plink_OLD5DOLLAR", created: 1 });
    expect((await handler(request(SESSION_ID))).statusCode).toBe(200);

    stripeRespondsWith(200, { payment_status: "paid", payment_link: "plink_NEW999", created: 1 });
    expect((await handler(request(SESSION_ID))).statusCode).toBe(200);

    stripeRespondsWith(200, { payment_status: "paid", payment_link: "plink_NEITHER", created: 1 });
    expect((await handler(request(SESSION_ID))).statusCode).toBe(402);

    // A list that trims to nothing still fails closed.
    process.env.STRIPE_PAYMENT_LINK_ID = " , ";
    global.fetch = jest.fn();
    expect((await handler(request(SESSION_ID))).statusCode).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("rejects malformed session ids before touching Stripe", async () => {
    global.fetch = jest.fn();
    for (const bad of [undefined, "", "hacktheplanet", "cs_live_short", "pi_live_" + "a".repeat(20)]) {
      const res = await handler(request(bad));
      expect(res.statusCode).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("fails closed on missing configuration", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    global.fetch = jest.fn();
    const res = await handler(request(SESSION_ID));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).key).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("maps Stripe outages and unknown sessions to non-key responses", async () => {
    stripeRespondsWith(404, { error: { type: "invalid_request_error" } });
    expect((await handler(request(SESSION_ID))).statusCode).toBe(404);

    global.fetch = jest.fn(async () => { throw new Error("boom"); });
    expect((await handler(request(SESSION_ID))).statusCode).toBe(502);
  });

  test("session id pattern accepts live and test ids only", () => {
    const { SESSION_ID_PATTERN } = _internal;
    expect(SESSION_ID_PATTERN.test(SESSION_ID)).toBe(true);
    expect(SESSION_ID_PATTERN.test("cs_test_" + "a".repeat(30))).toBe(true);
    expect(SESSION_ID_PATTERN.test("cs_live_" + "a".repeat(500))).toBe(false);
    expect(SESSION_ID_PATTERN.test("cs_live_abc$def")).toBe(false);
  });
});
