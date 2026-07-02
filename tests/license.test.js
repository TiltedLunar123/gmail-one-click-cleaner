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
const { TextEncoder, TextDecoder } = require("node:util");

// jsdom lacks TextEncoder/TextDecoder and WebCrypto's subtle API.
if (!global.TextEncoder) global.TextEncoder = TextEncoder;
if (!global.TextDecoder) global.TextDecoder = TextDecoder;
if (!global.crypto || !global.crypto.subtle) {
  Object.defineProperty(global, "crypto", { value: nodeCrypto.webcrypto, configurable: true });
}

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
      const [prefix, payload, sig] = key.split(".");
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
    beforeAll(() => {
      // shared.js promisify drives chrome.storage callback-style; the
      // global mock from setup.js is promise-only, so adapt get here.
      const promiseGet = chrome.storage.sync.get;
      chrome.storage.sync.get = (keys, cb) => {
        const p = promiseGet(keys);
        if (typeof cb === "function") {
          p.then(cb);
          return undefined;
        }
        return p;
      };
    });

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
});
