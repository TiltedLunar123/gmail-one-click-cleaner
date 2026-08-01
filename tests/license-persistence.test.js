/**
 * @jest-environment jsdom
 *
 * Where a paid key lives, and what it survives (8.6).
 *
 * Reported as "even after updates it forgets your key". Two separate
 * causes, and only one of them is about storage.
 *
 * 1. The key was written to chrome.storage.sync and read from
 *    chrome.storage.sync, and nowhere else. sync is the right primary,
 *    because it roams to the buyer's other machines, but it is also the
 *    one that fails: an 8KB per-item ceiling, a write quota, and it is
 *    the area that disappears under enterprise policy or a signed-out
 *    profile. One area is one way to lose something the user paid for.
 *
 * 2. chrome.storage of BOTH kinds is scoped to the extension ID, and an
 *    unpacked build with no `key` in its manifest takes its ID from the
 *    folder path. Unzipping each release next to the last one therefore
 *    produced a brand new extension with empty storage every time. The
 *    key was never forgotten; it belonged to a different extension.
 *    That half is fixed in build.js, and is pinned at the bottom here.
 */
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const SHARED_SRC = fs.readFileSync(path.join(ROOT, "shared.js"), "utf-8");
const { mintKey } = require("../netlify/functions/get-key.js")._internal;

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const TEST_PRIV_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const TEST_PUB_JWK = publicKey.export({ format: "jwk" });

let areas;      // the two storage areas, as plain objects
let failing;    // which areas should throw on read/write

// shared.js reaches chrome.storage through its own promisify(), which
// passes a CALLBACK and reads failure off chrome.runtime.lastError. A
// promise-returning mock is therefore the wrong shape twice over: the
// callback is never invoked, so every read and write hangs forever, and
// a rejection is not how the real API reports a quota error. Mock what
// the code actually calls.
const failWith = (message, cb) => {
  global.chrome.runtime.lastError = { message };
  try {
    cb(undefined);
  } finally {
    global.chrome.runtime.lastError = null;
  }
};

const makeArea = (name) => ({
  get: jest.fn((keys, cb) => {
    if (failing.read.has(name)) return failWith(`${name} unavailable`, cb);
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (k in areas[name]) out[k] = areas[name][k];
    cb(out);
  }),
  set: jest.fn((obj, cb) => {
    if (failing.write.has(name)) return failWith(`${name} quota exceeded`, cb);
    Object.assign(areas[name], obj);
    cb();
  })
});

/** A fresh GCC with a stubbed chrome.storage and the test public key. */
function loadShared() {
  global.chrome = {
    runtime: { id: "test-id", lastError: null, getURL: (p) => p },
    storage: { sync: makeArea("sync"), local: makeArea("local"), session: makeArea("session") }
  };
  // eslint-disable-next-line no-new-func
  return new Function(`${SHARED_SRC}; return GCC;`)();
}

let GCC;
let KEY;

beforeAll(async () => {
  KEY = mintKey(TEST_PRIV_PEM, "cs_live_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV", 1751500000);
});

beforeEach(() => {
  areas = { sync: {}, local: {}, session: {} };
  failing = { read: new Set(), write: new Set() };
  GCC = loadShared();
});

const STORE = "proLicense";

describe("saving a key", () => {
  test("writes it to both areas, not just sync", async () => {
    await GCC.license.save(KEY);
    expect(areas.sync[STORE]).toBe(KEY);
    expect(areas.local[STORE]).toBe(KEY);
  });

  test("sync failing does not lose the key", async () => {
    // The quota case. Before 8.6 this threw and the user was told
    // activation failed, with nothing saved anywhere.
    failing.write.add("sync");
    const result = await GCC.license.save(KEY);
    expect(result.syncOk).toBe(false);
    expect(result.localOk).toBe(true);
    expect(areas.local[STORE]).toBe(KEY);
  });

  test("local failing does not lose the key either", async () => {
    failing.write.add("local");
    const result = await GCC.license.save(KEY);
    expect(result.syncOk).toBe(true);
    expect(areas.sync[STORE]).toBe(KEY);
  });

  test("both failing is a real error, not a silent drop", async () => {
    // The one case where the user genuinely has no key saved. Telling
    // them so is the whole point; swallowing it would leave them
    // believing they had activated.
    failing.write.add("sync");
    failing.write.add("local");
    await expect(GCC.license.save(KEY)).rejects.toBeTruthy();
  });
});

describe("reading a key back", () => {
  test("sync is preferred when both agree", async () => {
    areas.sync[STORE] = KEY;
    areas.local[STORE] = KEY;
    const out = await GCC.license.read();
    expect(out).toEqual({ key: KEY, from: "sync" });
  });

  test("local answers when sync is empty", async () => {
    areas.local[STORE] = KEY;
    expect(await GCC.license.read()).toEqual({ key: KEY, from: "local" });
  });

  test("local answers when sync THROWS", async () => {
    // Not merely empty. An area that errors used to take the whole read
    // down with it, because the try block wrapped both.
    areas.local[STORE] = KEY;
    failing.read.add("sync");
    expect(await GCC.license.read()).toEqual({ key: KEY, from: "local" });
  });

  test("nothing anywhere is reported as nothing, not as an error", async () => {
    expect(await GCC.license.read()).toEqual({ key: "", from: null });
  });

  test("an empty string is not a key", async () => {
    // This is what "remove" writes, and it must not read as present.
    areas.sync[STORE] = "";
    areas.local[STORE] = "";
    expect(await GCC.license.read()).toEqual({ key: "", from: null });
  });
});

describe("healing the copy that went missing", () => {
  test("a key found only in local is written back to sync", async () => {
    areas.local[STORE] = KEY;
    const state = await GCC.license.getState(TEST_PUB_JWK);
    expect(state.active).toBe(true);
    expect(areas.sync[STORE]).toBe(KEY);
  });

  test("a key found only in sync is written back to local", async () => {
    areas.sync[STORE] = KEY;
    const state = await GCC.license.getState(TEST_PUB_JWK);
    expect(state.active).toBe(true);
    expect(areas.local[STORE]).toBe(KEY);
  });

  test("an INVALID key is never copied around", async () => {
    // Healing spreads whatever it finds, so it only ever runs for a key
    // that verified. Otherwise a corrupted value would propagate into
    // the area that was still healthy.
    areas.local[STORE] = "GCC1.bogus.bogus";
    const state = await GCC.license.getState(TEST_PUB_JWK);
    expect(state.active).toBe(false);
    expect(areas.sync[STORE]).toBeUndefined();
  });

  test("a bad copy in sync does not shadow a good one in local", async () => {
    // The point of two areas is that either can answer. Stopping at the
    // first NON-EMPTY string instead of the first VALID one would let a
    // stale or corrupted sync value lock a paying user out while their
    // real key sat in local, which is the exact complaint this release
    // exists to end.
    areas.sync[STORE] = "GCC1.stale.stale";
    areas.local[STORE] = KEY;
    const state = await GCC.license.getState(TEST_PUB_JWK);
    expect(state.active).toBe(true);
    expect(state.key).toBe(KEY);
    // And the bad copy is replaced rather than left to be found again.
    expect(areas.sync[STORE]).toBe(KEY);
  });

  test("healing failing does not break the read", async () => {
    areas.local[STORE] = KEY;
    failing.write.add("sync");
    const state = await GCC.license.getState(TEST_PUB_JWK);
    // The surviving copy is still doing its job.
    expect(state.active).toBe(true);
  });
});

describe("removing a key removes it everywhere", () => {
  test("clearing one area alone would be undone by the heal", async () => {
    // The trap this design creates, pinned so it cannot come back:
    // clear sync only, and the next read finds local, verifies it, and
    // helpfully puts it straight back.
    areas.sync[STORE] = KEY;
    areas.local[STORE] = KEY;

    await GCC.license.save("");
    expect(areas.sync[STORE]).toBe("");
    expect(areas.local[STORE]).toBe("");

    const state = await GCC.license.getState(TEST_PUB_JWK);
    expect(state.active).toBe(false);
  });

  test("options.js removes through the helper, not one area by hand", () => {
    const optionsSrc = fs.readFileSync(path.join(ROOT, "options.js"), "utf-8");
    expect(optionsSrc).toContain('GCC.license.save("")');
    expect(optionsSrc).not.toMatch(/storageSet\(\s*"sync"\s*,\s*\{\s*\[GCC\.license\.PRO\.STORAGE_KEY\]/);
  });

  test("a HALF-cleared key is reported as such, not as removed", async () => {
    // save() counts one area out of two as success, which is correct
    // for activating and wrong for removing: the surviving copy gets
    // healed straight back on the next read, so a plain "Key removed"
    // would be a promise the next popup open breaks.
    areas.sync[STORE] = KEY;
    areas.local[STORE] = KEY;
    failing.write.add("sync");

    const cleared = await GCC.license.save("");
    expect(cleared.syncOk).toBe(false);
    expect(cleared.localOk).toBe(true);

    // And the resurrection it warns about is real: sync still holds the
    // key, so the next read finds it, verifies it and heals local.
    failing.write.delete("sync");
    const state = await GCC.license.getState(TEST_PUB_JWK);
    expect(state.active).toBe(true);
    expect(areas.local[STORE]).toBe(KEY);

    const optionsSrc = fs.readFileSync(path.join(ROOT, "options.js"), "utf-8");
    expect(optionsSrc).toContain("const cleared = await GCC.license.save(\"\");");
    expect(optionsSrc).toContain("if (cleared.syncOk && cleared.localOk) {");
  });

  test("options.js saves through the helper too", () => {
    const optionsSrc = fs.readFileSync(path.join(ROOT, "options.js"), "utf-8");
    expect(optionsSrc).toContain("GCC.license.save(raw)");
    expect(optionsSrc).not.toMatch(/safeSyncSet\(\{\s*\[GCC\.license\.PRO\.STORAGE_KEY\]/);
  });
});

describe("the worker gates Pro on the same two areas", () => {
  const bgSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf-8");
  const fn = bgSrc.slice(
    bgSrc.indexOf("async function hasProLicense()"),
    bgSrc.indexOf("// Auto-Pilot (7.12, Pro)")
  );

  test("it reads local when sync has nothing", () => {
    // Auto-Pilot is gated on this. Reading one area meant a sync hiccup
    // could switch off a paid feature on a schedule nobody was watching.
    expect(fn).toContain("chrome.storage.sync.get(LICENSE_STORAGE_KEY)");
    expect(fn).toContain("chrome.storage.local.get(LICENSE_STORAGE_KEY)");
  });

  test("a throwing area does not take the whole check down", () => {
    expect(fn.match(/catch\s*\{\s*\}/g) || []).toHaveLength(2);
  });
});

describe("the unpacked build keeps one identity", () => {
  const buildSrc = fs.readFileSync(path.join(ROOT, "build.js"), "utf-8");

  test("a key is pinned into the unpacked manifest", () => {
    // Without this, Chrome derives the ID from the folder path, so every
    // release unzipped to a new folder is a new extension with empty
    // storage. That is what "it forgets the key on every update" was.
    expect(buildSrc).toContain("const UNPACKED_KEY =");
    expect(buildSrc).toContain("function pinUnpackedIdentity(distDir)");
    expect(buildSrc).toMatch(/UNPACKED_KEY = "[A-Za-z0-9+/=]{300,}"/);
  });

  test("it is applied AFTER the zip, so the store package never carries it", () => {
    const body = buildSrc.slice(
      buildSrc.indexOf("if (shouldZip) {"),
      buildSrc.indexOf("function createZip(")
    );
    expect(body).toContain("createZip(DIST");
    expect(body).toContain("pinUnpackedIdentity(DIST)");
    expect(body.indexOf("createZip(DIST")).toBeLessThan(body.indexOf("pinUnpackedIdentity(DIST)"));
  });

  test("only Chrome needs it, because Firefox pins its own", () => {
    const body = buildSrc.slice(
      buildSrc.indexOf("if (shouldZip) {"),
      buildSrc.indexOf("function createZip(")
    );
    expect(body).toContain('name === "chrome"');
    expect(buildSrc).toContain("id: GECKO_ID");
  });

  test("the checked-in manifest stays clean", () => {
    // The source manifest is what gets uploaded from a fresh clone; the
    // identity belongs to the built dist folder only.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8"));
    expect(manifest.key).toBeUndefined();
  });
});
