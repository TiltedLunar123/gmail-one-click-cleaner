// Global Chrome API mock for all tests
const storageBacking = { local: {}, sync: {}, session: {} };

const makeStorageArea = (area) => ({
  get: jest.fn(async (keys) => {
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
  set: jest.fn(async (obj) => {
    Object.assign(storageBacking[area], obj);
  }),
  remove: jest.fn(async (keys) => {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) delete storageBacking[area][k];
  }),
  clear: jest.fn(async () => {
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
