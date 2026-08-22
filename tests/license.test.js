/**
 * @jest-environment jsdom
 *
 * Pro license verification (7.0). True integration across the wire
 * format: keys are minted with the REAL server code
 * (netlify/functions/get-key.js mintKey) using an ephemeral P-256
 * keypair, then verified with the REAL extension code (shared.js
 * GCC.license.verify) against that pair's public JWK. The production
 * public key stays embedded; only the test keypair differs.
 */
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("node:crypto");

// TextEncoder/TextDecoder and WebCrypto's subtle come from tests/setup.js.

const SHARED_SRC = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf-8");
const { mintKey } = require("../netlify/functions/get-key.js")._internal;

// shared.js declares a top-level `const GCC`; evaluate it in a function
// scope and hand the namespace back.
// eslint-disable-next-line no-new-func
const GCC = new Function(`${SHARED_SRC}; return GCC;`)();

// Ephemeral signing pair for this test run.
const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const TEST_PRIV_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const TEST_PUB_JWK = publicKey.export({ format: "jwk" });

const SESSION_ID = "cs_live_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV";

describe("GCC.license", () => {
  describe("parse", () => {
    test("rejects garbage and wrong prefixes with readable reasons", () => {
      for (const bad of ["", "not-a-key", "ABC1.x.y", "GCC1.onlytwo", "GCC1.a.b.c.d"]) {
        const out = GCC.license.parse(bad);
        expect(out.ok).toBe(false);
        expect(typeof out.reason).toBe("string");
        expect(out.reason.length).toBeGreaterThan(0);
      }
    });

    test("rejects a payload that is not a v1 pro plan", () => {
      const payload = Buffer.from(JSON.stringify({ v: 1, plan: "mega" })).toString("base64url");
      const out = GCC.license.parse(`GCC1.${payload}.c2ln`);
      expect(out.ok).toBe(false);
    });

    test("accepts a server-minted key's shape and decodes the payload", () => {
      const key = mintKey(TEST_PRIV_PEM, SESSION_ID, 1751500000);
      const out = GCC.license.parse(key);
      expect(out.ok).toBe(true);
      expect(out.payload).toMatchObject({ v: 1, plan: "pro", iat: 1751500000 });
      expect(out.payload.sid).toBe(SESSION_ID.slice(-10));
    });
  });

  describe("verify (server mint -> extension verify)", () => {
    test("accepts a key signed by the matching private key", async () => {
      const key = mintKey(TEST_PRIV_PEM, SESSION_ID, 1751500000);
      const out = await GCC.license.verify(key, TEST_PUB_JWK);
      expect(out.valid).toBe(true);
      expect(out.payload.plan).toBe("pro");
    });

    test("rejects a tampered payload", async () => {
      const key = mintKey(TEST_PRIV_PEM, SESSION_ID, 1751500000);
      const [prefix, , sig] = key.split(".");
      const forgedPayload = Buffer.from(
        JSON.stringify({ v: 1, plan: "pro", sid: "FORGED0000", iat: 1 })
      ).toString("base64url");
      const out = await GCC.license.verify(`${prefix}.${forgedPayload}.${sig}`, TEST_PUB_JWK);
      expect(out.valid).toBe(false);
    });

    test("rejects a key signed by the wrong private key (default embedded pubkey)", async () => {
      // Minted with the ephemeral pair but verified against the
      // production public key: must fail.
      const key = mintKey(TEST_PRIV_PEM, SESSION_ID, 1751500000);
      const out = await GCC.license.verify(key);
      expect(out.valid).toBe(false);
    });

    test("rejects malformed keys without throwing", async () => {
      const out = await GCC.license.verify("GCC1.%%%%.####");
      expect(out.valid).toBe(false);
    });
  });

  describe("getState", () => {
    // The callback-shaped adapter that used to live here covered
    // chrome.storage.sync alone, so it stopped working the moment
    // getState learned to fall back to local. tests/setup.js now mocks
    // every area the way the real API behaves, callback or promise.
    beforeEach(() => __resetChromeStorage());

    test("inactive when no key is stored", async () => {
      const out = await GCC.license.getState();
      expect(out.active).toBe(false);
    });

    test("inactive when the stored key does not verify", async () => {
      await chrome.storage.sync.set({ proLicense: mintKey(TEST_PRIV_PEM, SESSION_ID, 1) });
      const out = await GCC.license.getState();
      expect(out.active).toBe(false);
    });
  });

  describe("buyUrl (7.14 purchase attribution)", () => {
    // Every Pro gate tags its checkout link so Stripe records which
    // upsell converted (npm run analytics reads it back). This is the
    // only thing standing between "which feature sells" and guesswork,
    // and it must never be able to break checkout.
    test("tags the checkout link with the surface that sent them", () => {
      expect(GCC.license.buyUrl("autopilot"))
        .toBe(`${GCC.license.PRO.BUY_URL}?client_reference_id=gcc_autopilot`);
    });

    test("no source means the plain buy link, unchanged", () => {
      for (const empty of [undefined, null, "", "   ", "!!!"]) {
        expect(GCC.license.buyUrl(empty)).toBe(GCC.license.PRO.BUY_URL);
      }
    });

    test("the payment link itself is never rewritten", () => {
      // The URL is baked into shipped versions and sells the real
      // product; only a query parameter may ever be appended.
      expect(GCC.license.buyUrl("smart_bulk_locked").startsWith(GCC.license.PRO.BUY_URL + "?")).toBe(true);
    });

    test("only characters Stripe accepts survive, and never user data", () => {
      // Stripe allows alphanumerics, dashes and underscores up to 200
      // chars and silently drops anything else, so the sanitiser can
      // only ever emit a value checkout will accept.
      const out = GCC.license.buyUrl("a b@c.d/../?&=#e");
      expect(out).toBe(`${GCC.license.PRO.BUY_URL}?client_reference_id=gcc_abcde`);
      expect(out).not.toMatch(/[^A-Za-z0-9_\-:/.?=]/);

      const long = GCC.license.buyUrl("x".repeat(200));
      expect(long.split("client_reference_id=")[1]).toHaveLength("gcc_".length + 40);
    });
  });
});
