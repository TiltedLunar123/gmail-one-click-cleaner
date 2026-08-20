/**
 * @jest-environment jsdom
 *
 * 8.20: a sync read that failed is not an install with nothing saved.
 *
 * `chrome.storage.sync.get(key, cb)` calls the callback with `undefined`
 * and sets `runtime.lastError` when the read fails. An install that has
 * never opened Options produces `{}`. Both used to land on the same
 * `result?.rules ?? DEFAULT_RULES`, so a failed read was
 * indistinguishable from an unconfigured one: the run used a rule set
 * this install had not chosen and said nothing at all about it.
 *
 * The run still goes ahead on the engine's own table. Refusing every
 * cleanup over a transient storage hiccup is the worse trade, and
 * getRules' outer catch has always taken that position. What 8.20
 * changes is the silence.
 *
 * Same three-answer shape as 8.15's readSafetyList and 8.14's
 * readLicenseState: null means the read failed, {} means it worked and
 * there is nothing there, which is a real answer.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "contentScript.js"), "utf-8");

let sent;

function installChrome({ failKeys = [], stored = {} } = {}) {
  const runtime = {
    id: "test-extension-id",
    lastError: null,
    getURL: (p) => `chrome-extension://test/${p}`,
    sendMessage: (msg) => {
      sent.push(msg);
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener: () => {} }
  };
  global.chrome = {
    runtime,
    storage: {
      sync: {
        get: (key, cb) => {
          if (failKeys.includes(key)) {
            runtime.lastError = { message: "storage unavailable" };
            cb(undefined);
            runtime.lastError = null;
            return;
          }
          cb(key in stored ? { [key]: stored[key] } : {});
        }
      },
      local: { get: (_k, cb) => cb({}), set: (_o, cb) => cb && cb() }
    }
  };
}

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

const warnings = () => sent.filter((m) => m?.payload?.phase === "warning" || m?.phase === "warning");

const warningText = () =>
  JSON.stringify(sent.filter((m) => JSON.stringify(m).includes('"warning"')));

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  delete global.chrome;
});

describe("getRules and an unreadable sync store", () => {
  test("a read that failed says so, in words the user can act on", async () => {
    installChrome({ failKeys: ["rules"] });
    const I = loadEngine({ intensity: "normal" });

    const rules = await I.getRules("normal");

    // The run still happens, on the engine's own table.
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
    // And it is no longer silent about running rules this install did
    // not save.
    expect(warningText()).toContain("saved rules");
  });

  test("a failed custom-rules read is called out separately", async () => {
    installChrome({ failKeys: ["customRules"], stored: {} });
    const I = loadEngine({ intensity: "normal" });

    await I.getRules("normal");

    expect(warningText()).toContain("custom rules");
    // The stored-rules read worked, so that one has nothing to say.
    expect(warningText()).not.toContain("saved rules");
  });

  test("an install with nothing saved is a real answer and stays quiet", async () => {
    // This is the common case: every fresh install reaches here, and
    // warning it would be crying wolf on the default path.
    installChrome({ stored: {} });
    const I = loadEngine({ intensity: "normal" });

    const rules = await I.getRules("normal");

    expect(rules.length).toBeGreaterThan(0);
    expect(warnings()).toHaveLength(0);
    expect(warningText()).toBe("[]");
  });

  test("a stored rule set is used and says nothing", async () => {
    installChrome({
      stored: { rules: { normal: ["category:promotions older_than:1y"] } }
    });
    const I = loadEngine({ intensity: "normal" });

    const rules = await I.getRules("normal");

    expect(rules).toEqual(["category:promotions older_than:1y"]);
    expect(warningText()).toBe("[]");
  });
});

describe("syncReadOrNull answers three ways", () => {
  test("null for a read that failed", async () => {
    installChrome({ failKeys: ["rules"] });
    const I = loadEngine();
    await expect(I.syncReadOrNull("rules")).resolves.toBeNull();
  });

  test("an empty object for a key that is simply not there", async () => {
    installChrome({ stored: {} });
    const I = loadEngine();
    await expect(I.syncReadOrNull("rules")).resolves.toEqual({});
  });

  test("the value when there is one", async () => {
    installChrome({ stored: { rules: { normal: ["a"] } } });
    const I = loadEngine();
    await expect(I.syncReadOrNull("rules")).resolves.toEqual({ rules: { normal: ["a"] } });
  });
});
