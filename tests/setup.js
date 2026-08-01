// Globals this environment doesn't hand us. Node exposed WebCrypto on
// globalThis in 19, so on 18 there is no `crypto` at all; jsdom has one
// but it carries no `subtle`. Either way, fall back to node:crypto.
const nodeCrypto = require("node:crypto");
const { TextEncoder, TextDecoder } = require("node:util");

if (!global.TextEncoder) global.TextEncoder = TextEncoder;
if (!global.TextDecoder) global.TextDecoder = TextDecoder;
if (!global.crypto || !global.crypto.subtle) {
  Object.defineProperty(global, "crypto", { value: nodeCrypto.webcrypto, configurable: true });
}

// Global Chrome API mock for all tests
const storageBacking = { local: {}, sync: {}, session: {} };

// The real chrome.storage API answers BOTH ways: hand it a callback and
// it calls that and returns undefined, omit one and it returns a
// promise. shared.js goes through its own promisify() and so always
// passes a callback, while the tests await the returned promise. A
// promise-only mock therefore hangs every caller in the extension's own
// code until jest times out, which is a five-second silence rather than
// a failure and reads like a bug in the code under test. Mirror the
// real shape instead.
const dualMode = (impl) => jest.fn((...args) => {
  const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
  const result = impl(...args);
  if (!cb) return Promise.resolve(result);
  cb(result);
  return undefined;
});

const makeStorageArea = (area) => ({
  get: dualMode((keys) => {
    if (typeof keys === "string") {
      return { [keys]: storageBacking[area][keys] ?? undefined };
    }
    if (Array.isArray(keys)) {
      const result = {};
      for (const k of keys) result[k] = storageBacking[area][k] ?? undefined;
      return result;
    }
    return { ...storageBacking[area] };
  }),
  set: dualMode((obj) => {
    Object.assign(storageBacking[area], obj);
  }),
  remove: dualMode((keys) => {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) delete storageBacking[area][k];
  }),
  clear: dualMode(() => {
    storageBacking[area] = {};
  })
});

global.chrome = {
  runtime: {
    id: "test-extension-id",
    onInstalled: { addListener: jest.fn() },
    onStartup: { addListener: jest.fn() },
    onMessage: { addListener: jest.fn() },
    sendMessage: jest.fn(),
    lastError: null
  },
  storage: {
    local: makeStorageArea("local"),
    sync: makeStorageArea("sync"),
    session: makeStorageArea("session")
  },
  alarms: {
    create: jest.fn(),
    clear: jest.fn(async () => true),
    getAll: jest.fn(async () => []),
    onAlarm: { addListener: jest.fn() }
  },
  tabs: {
    query: jest.fn(async () => []),
    get: jest.fn(async (id) => ({ id })),
    onRemoved: { addListener: jest.fn() }
  },
  scripting: {
    executeScript: jest.fn(async () => [])
  }
};

// Helper to reset storage between tests
global.__resetChromeStorage = () => {
  storageBacking.local = {};
  storageBacking.sync = {};
  storageBacking.session = {};
};
