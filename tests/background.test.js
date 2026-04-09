/**
 * @jest-environment node
 */

// background.js wraps everything in an IIFE and registers chrome listeners.
// We test the logic by capturing those listener callbacks and invoking them.

let onInstalledCb, onStartupCb, onMessageCb, onAlarmCb, onTabRemovedCb;
let storageBacking;

function resetStorage() {
  storageBacking = { local: {}, sync: {}, session: {} };
}

function makeStorageArea(area) {
  return {
    get: jest.fn(async (keys) => {
      if (typeof keys === "string") {
        return { [keys]: storageBacking[area][keys] ?? undefined };
      }
      return { ...storageBacking[area] };
    }),
    set: jest.fn(async (obj) => {
      Object.assign(storageBacking[area], obj);
    })
  };
}

beforeAll(() => {
  resetStorage();

  // Set up chrome mock that captures listener registrations
  global.chrome = {
    runtime: {
      id: "test-extension-id",
      onInstalled: { addListener: jest.fn((cb) => { onInstalledCb = cb; }) },
      onStartup: { addListener: jest.fn((cb) => { onStartupCb = cb; }) },
      onMessage: { addListener: jest.fn((cb) => { onMessageCb = cb; }) },
      sendMessage: jest.fn().mockRejectedValue(new Error("no listener")),
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
      onAlarm: { addListener: jest.fn((cb) => { onAlarmCb = cb; }) }
    },
    tabs: {
      query: jest.fn(async () => []),
      get: jest.fn(async (id) => ({ id })),
      onRemoved: { addListener: jest.fn((cb) => { onTabRemovedCb = cb; }) }
    },
    scripting: {
      executeScript: jest.fn(async () => [])
    }
  };

  // Load background.js — it's a self-executing IIFE that registers listeners
  const fs = require("fs");
  const path = require("path");
  const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");
  // Just eval it; it only registers listeners via the chrome mock
  new Function(code)();
});

beforeEach(() => {
  resetStorage();
  // Re-wire storage mocks to use fresh backing
  chrome.storage.local = makeStorageArea("local");
  chrome.storage.sync = makeStorageArea("sync");
  chrome.storage.session = makeStorageArea("session");
  jest.clearAllMocks();
});

describe("background.js — Service Worker", () => {

  test("registers all expected listeners on load", () => {
    expect(onInstalledCb).toBeDefined();
    expect(onStartupCb).toBeDefined();
    expect(onMessageCb).toBeDefined();
    expect(onAlarmCb).toBeDefined();
    expect(onTabRemovedCb).toBeDefined();
  });

  // ===========================
  // Stats recording via messages
  // ===========================

  describe("message: gmailCleanerRecordStats", () => {
    test("records stats and increments totals", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      const result = onMessageCb(
        {
          type: "gmailCleanerRecordStats",
          data: {
            deleted: 10,
            archived: 5,
            freedMb: 2.5,
            intensity: "normal",
            dryRun: false,
            duration: 5000,
            perQuery: [{ label: "Promotions", count: 8 }, { label: "Social", count: 7 }]
          }
        },
        sender,
        sendResponse
      );

      // Should return true (async response)
      expect(result).toBe(true);

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({ ok: true });

      // Verify stats were written to storage
      const stored = storageBacking.local.cleanupStats;
      expect(stored).toBeDefined();
      expect(stored.totalRuns).toBe(1);
      expect(stored.totalDeleted).toBe(10);
      expect(stored.totalArchived).toBe(5);
      expect(stored.totalFreedMb).toBe(2.5);
      expect(stored.history).toHaveLength(1);
      expect(stored.categoryBreakdown.Promotions.count).toBe(8);
      expect(stored.categoryBreakdown.Social.count).toBe(7);
    });
  });

  // ===========================
  // Stats retrieval
  // ===========================

  describe("message: gmailCleanerGetStats", () => {
    test("returns empty stats when nothing recorded", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      onMessageCb({ type: "gmailCleanerGetStats" }, sender, sendResponse);
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          stats: expect.objectContaining({ totalRuns: 0, totalDeleted: 0 })
        })
      );
    });
  });

  // ===========================
  // Undo log
  // ===========================

  describe("message: gmailCleanerRecordUndo", () => {
    test("records undo entry", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      onMessageCb(
        {
          type: "gmailCleanerRecordUndo",
          data: { query: "category:promotions", label: "Promotions", count: 15, action: "delete" }
        },
        sender,
        sendResponse
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({ ok: true });

      const log = storageBacking.local.undoLog;
      expect(log).toHaveLength(1);
      expect(log[0].query).toBe("category:promotions");
      expect(log[0].count).toBe(15);
    });
  });

  describe("message: gmailCleanerGetUndoLog", () => {
    test("returns empty log initially", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      onMessageCb({ type: "gmailCleanerGetUndoLog" }, sender, sendResponse);
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({ ok: true, log: [] });
    });
  });

  describe("message: gmailCleanerClearUndoLog", () => {
    test("clears the undo log", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      // First add an entry
      storageBacking.local.undoLog = [{ id: "x", timestamp: Date.now() }];

      onMessageCb({ type: "gmailCleanerClearUndoLog" }, sender, sendResponse);
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      expect(storageBacking.local.undoLog).toEqual([]);
    });
  });

  // ===========================
  // Schedule management
  // ===========================

  describe("message: gmailCleanerGetSchedules", () => {
    test("returns empty array initially", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      onMessageCb({ type: "gmailCleanerGetSchedules" }, sender, sendResponse);
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({ ok: true, schedules: [] });
    });
  });

  describe("message: gmailCleanerSaveSchedule", () => {
    test("saves a new schedule", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      const schedule = { id: "sched1", enabled: true, intensity: "light", intervalMinutes: 10080 };

      onMessageCb({ type: "gmailCleanerSaveSchedule", schedule }, sender, sendResponse);
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      expect(storageBacking.sync.schedules).toContainEqual(schedule);
    });
  });

  describe("message: gmailCleanerDeleteSchedule", () => {
    test("removes a schedule by id", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      storageBacking.sync.schedules = [
        { id: "sched1", enabled: true },
        { id: "sched2", enabled: true }
      ];

      onMessageCb({ type: "gmailCleanerDeleteSchedule", scheduleId: "sched1" }, sender, sendResponse);
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      expect(storageBacking.sync.schedules).toHaveLength(1);
      expect(storageBacking.sync.schedules[0].id).toBe("sched2");
    });
  });

  // ===========================
  // SW Ping
  // ===========================

  describe("message: gmailCleanerSwPing", () => {
    test("responds with ok and version", () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      onMessageCb({ type: "gmailCleanerSwPing" }, sender, sendResponse);
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, version: "4.2.0" });
    });
  });

  // ===========================
  // Gmail tab listing
  // ===========================

  describe("message: gmailCleanerListGmailTabs", () => {
    test("lists open Gmail tabs with account info", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox", active: true, windowId: 1 },
        { id: 2, url: "https://mail.google.com/mail/u/1/#inbox", title: "Inbox", active: false, windowId: 1 }
      ]);

      onMessageCb({ type: "gmailCleanerListGmailTabs" }, sender, sendResponse);
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        tabs: [
          expect.objectContaining({ id: 1, account: 0 }),
          expect.objectContaining({ id: 2, account: 1 })
        ]
      });
    });
  });

  // ===========================
  // Sender interaction & whitelist suggestions
  // ===========================

  describe("message: gmailCleanerRecordSenderInteraction", () => {
    test("records sender open interaction", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      onMessageCb(
        { type: "gmailCleanerRecordSenderInteraction", data: { sender: "news@example.com", type: "open" } },
        sender,
        sendResponse
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      const suggestions = storageBacking.local.whitelistSuggestions;
      expect(suggestions["news@example.com"].opens).toBe(1);
    });
  });

  describe("message: gmailCleanerGetWhitelistSuggestions", () => {
    test("returns scored suggestions above threshold", async () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      // Pre-populate with interaction data
      storageBacking.local.whitelistSuggestions = {
        "boss@work.com": { opens: 5, replies: 3, lastSeen: Date.now() }, // score: 5+9=14
        "spam@junk.com": { opens: 1, replies: 0, lastSeen: Date.now() }  // score: 1 (below threshold)
      };

      onMessageCb({ type: "gmailCleanerGetWhitelistSuggestions" }, sender, sendResponse);
      await new Promise((r) => setTimeout(r, 50));

      const result = sendResponse.mock.calls[0][0];
      expect(result.ok).toBe(true);
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].sender).toBe("boss@work.com");
    });
  });

  // ===========================
  // Rejects unknown senders
  // ===========================

  describe("message sender validation", () => {
    test("ignores messages with no type", () => {
      const sendResponse = jest.fn();
      const sender = { id: "test-extension-id" };

      const result = onMessageCb({}, sender, sendResponse);
      expect(result).toBeUndefined();
      expect(sendResponse).not.toHaveBeenCalled();
    });
  });
});
