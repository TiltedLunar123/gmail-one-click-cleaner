(() => {
  "use strict";

  // =========================
  // Constants & Configuration
  // =========================

  const DIAGNOSTICS_VERSION = "4.2.0";

  const CONFIG = Object.freeze({
    MAX_URL_LENGTH: 120,
    MAX_LOG_ENTRIES: 150,
    TOAST_DURATION_MS: 3000,
    LOADING_CLASS: "loading",
    BUTTON_LOADING_CLASS: "loading",
    SW_PING_TIMEOUT_MS: 1200
  });

  const SELECTORS = Object.freeze({
    envBrowser: "envBrowser",
    envPlatform: "envPlatform",
    envExtension: "envExtension",
    envPerms: "envPerms",
    envServiceWorker: "envServiceWorker",
    envTabStrategy: "envTabStrategy",
    envStatusTag: "envStatusTag",

    tabCount: "gmailTabCount",
    tabTableBody: "gmailTabTableBody",

    chosenTabText: "chosenTabText",
    chosenTabTextInline: "chosenTabTextInline",
    cleanerTabText: "cleanerTabText",
    cleanerTabTextInline: "cleanerTabTextInline",

    scanTabsBtn: "scanTabsBtn",
    testInjectBtn: "testInjectBtn",
    pingSwBtn: "pingSwBtn",

    log: "log",
    diagVersionBadge: "diagVersionBadge",

    lastRunSummary: "lastRunSummary",
    lastRunMeta: "lastRunMeta",
    lastRunBucketTag: "lastRunBucketTag",
    lastRunButtons: "lastRunButtons",

    runHistoryTableBody: "runHistoryTableBody",

    copyLogBtn: "copyLogBtn",
    clearLogBtn: "clearLogBtn",

    toastContainer: ".toast-container"
  });

  const TAG_CLASSES = Object.freeze({
    dry: "tag tag-info",
    archive: "tag tag-success",
    delete: "tag tag-danger",
    default: "tag tag-primary"
  });

  // =========================
  // DOM Element Cache
  // =========================

  const elements = {
    envBrowser: GCC.$(SELECTORS.envBrowser),
    envPlatform: GCC.$(SELECTORS.envPlatform),
    envExtension: GCC.$(SELECTORS.envExtension),
    envPerms: GCC.$(SELECTORS.envPerms),
    envServiceWorker: GCC.$(SELECTORS.envServiceWorker),
    envTabStrategy: GCC.$(SELECTORS.envTabStrategy),
    envStatusTag: GCC.$(SELECTORS.envStatusTag),

    tabCount: GCC.$(SELECTORS.tabCount),
    tabTableBody: GCC.$(SELECTORS.tabTableBody),

    chosenTabText: GCC.$(SELECTORS.chosenTabText),
    chosenTabTextInline: GCC.$(SELECTORS.chosenTabTextInline),
    cleanerTabText: GCC.$(SELECTORS.cleanerTabText),
    cleanerTabTextInline: GCC.$(SELECTORS.cleanerTabTextInline),

    scanTabsBtn: GCC.$(SELECTORS.scanTabsBtn),
    testInjectBtn: GCC.$(SELECTORS.testInjectBtn),
    pingSwBtn: GCC.$(SELECTORS.pingSwBtn),

    log: GCC.$(SELECTORS.log),
    diagVersionBadge: GCC.$(SELECTORS.diagVersionBadge),

    lastRunSummary: GCC.$(SELECTORS.lastRunSummary),
    lastRunMeta: GCC.$(SELECTORS.lastRunMeta),
    lastRunBucketTag: GCC.$(SELECTORS.lastRunBucketTag),
    lastRunButtons: GCC.$(SELECTORS.lastRunButtons),

    runHistoryTableBody: GCC.$(SELECTORS.runHistoryTableBody),

    copyLogBtn: GCC.$(SELECTORS.copyLogBtn),
    clearLogBtn: GCC.$(SELECTORS.clearLogBtn),

    toastContainer: GCC.qs(SELECTORS.toastContainer)
  };

  // =========================
  // Logging System
  // =========================

  const logHistory = [];

  const getTimestamp = () => {
    const now = new Date();
    return now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  };

  const addLog = (text, level = "info") => {
    if (!elements.log) return;

    const timestamp = getTimestamp();
    const entry = `[${timestamp}] ${text}`;

    logHistory.push(entry);
    if (logHistory.length > CONFIG.MAX_LOG_ENTRIES) logHistory.shift();

    const entryEl = document.createElement("div");
    entryEl.className = `log-entry log-${level}`;

    const timestampSpan = document.createElement("span");
    timestampSpan.className = "log-timestamp";
    timestampSpan.textContent = `[${timestamp}]`;

    entryEl.appendChild(timestampSpan);
    entryEl.appendChild(document.createTextNode(` ${text}`));

    elements.log.appendChild(entryEl);
    elements.log.scrollTop = elements.log.scrollHeight;
  };

  const setLog = (text, level = "info") => {
    if (!elements.log) return;
    elements.log.replaceChildren();
    logHistory.length = 0;
    if (text) addLog(text, level);
  };

  const clearLog = () => {
    if (!elements.log) return;
    elements.log.replaceChildren();
    logHistory.length = 0;
    GCC.showToast("Log cleared", "info");
  };

  const copyLog = async () => {
    if (logHistory.length === 0) {
      GCC.showToast("No logs to copy", "warning");
      return;
    }

    const content = logHistory.join("\n");

    try {
      await navigator.clipboard.writeText(content);
      GCC.showToast("Log copied to clipboard", "success");
      return;
    } catch {
      // fallback
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = content;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      GCC.showToast("Log copied to clipboard", "success");
    } catch {
      GCC.showToast("Failed to copy log", "error");
    }
  };

  // =========================
  // Button State Management
  // =========================

  const setButtonLoading = (btn, loading) => {
    if (!btn) return;
    btn.disabled = loading;

    if (loading) {
      btn.classList.add(CONFIG.BUTTON_LOADING_CLASS);
      btn.setAttribute("aria-busy", "true");
    } else {
      btn.classList.remove(CONFIG.BUTTON_LOADING_CLASS);
      btn.removeAttribute("aria-busy");
    }
  };

  const removeLoadingSkeleton = (el) => {
    if (!el) return;
    el.classList.remove(CONFIG.LOADING_CLASS);
  };

  const setEnvStatus = (text, kind = "primary") => {
    if (!elements.envStatusTag) return;
    elements.envStatusTag.textContent = text;
    elements.envStatusTag.className = `tag tag-${kind}`;
  };

  // =========================
  // Environment Rendering
  // =========================

  const getBrowserInfo = () => {
    const ua = navigator.userAgent || "";
    if (ua.includes("Edg/")) {
      const match = ua.match(/Edg\/([\d.]+)/);
      return match ? `Edge ${match[1]}` : "Edge";
    }
    if (ua.includes("Chrome/")) {
      const match = ua.match(/Chrome\/([\d.]+)/);
      return match ? `Chrome ${match[1]}` : "Chrome";
    }
    if (ua.includes("Firefox/")) {
      const match = ua.match(/Firefox\/([\d.]+)/);
      return match ? `Firefox ${match[1]}` : "Firefox";
    }
    if (ua.includes("Safari") && !ua.includes("Chrome")) {
      const match = ua.match(/Version\/([\d.]+)/);
      return match ? `Safari ${match[1]}` : "Safari";
    }
    return ua || "(unknown)";
  };

  const getPlatformInfo = () => {
    if (navigator.userAgentData?.platform) return navigator.userAgentData.platform;
    return navigator.platform || "(unknown)";
  };

  const getManifestInfo = () => {
    try {
      if (!GCC.hasChrome()) return null;
      const manifest = chrome.runtime.getManifest();
      return {
        name: manifest.name || "Gmail One-Click Cleaner",
        version: manifest.version_name || manifest.version || "?"
      };
    } catch {
      return null;
    }
  };

  const getPermissions = () => {
    try {
      if (!GCC.hasChrome()) return [];
      const manifest = chrome.runtime.getManifest();
      const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
      const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
      return [...permissions, ...hostPermissions];
    } catch {
      return [];
    }
  };

  const renderEnv = async () => {
    // Browser
    if (elements.envBrowser) {
      elements.envBrowser.textContent = getBrowserInfo();
      removeLoadingSkeleton(elements.envBrowser);
    }

    // Platform
    if (elements.envPlatform) {
      elements.envPlatform.textContent = getPlatformInfo();
      removeLoadingSkeleton(elements.envPlatform);
    }

    // Extension info
    const manifestInfo = getManifestInfo();
    if (elements.envExtension) {
      if (manifestInfo) {
        elements.envExtension.textContent = `${manifestInfo.name} – v${manifestInfo.version}`;
      } else {
        elements.envExtension.textContent = "Gmail One-Click Cleaner – (runtime unavailable)";
      }
      removeLoadingSkeleton(elements.envExtension);
    }

    // Version badge
    if (elements.diagVersionBadge) {
      if (manifestInfo) elements.diagVersionBadge.textContent = `v${manifestInfo.version} snapshot`;
      else elements.diagVersionBadge.textContent = `v${DIAGNOSTICS_VERSION} snapshot`;
    }

    // Permissions
    if (elements.envPerms) {
      const perms = getPermissions();
      elements.envPerms.textContent = perms.length > 0 ? perms.join(", ") : "(none or unavailable)";
      removeLoadingSkeleton(elements.envPerms);
    }

    // Tab strategy (best-effort; falls back to default)
    const strategy = await detectTabStrategy().catch(() => ({
      strategy: "active",
      enabled: false,
      source: "default"
    }));

    if (elements.envTabStrategy) {
      elements.envTabStrategy.textContent =
        strategy.strategy === "dedicated"
          ? `Dedicated cleaning tab preferred (${strategy.source})`
          : `Active Gmail tab preferred (${strategy.source})`;
      removeLoadingSkeleton(elements.envTabStrategy);
    }

    // Service worker health (best-effort)
    const sw = await pingServiceWorker(true).catch((e) => ({ ok: false, detail: e?.message || "error" }));
    if (elements.envServiceWorker) {
      elements.envServiceWorker.textContent = sw.ok ? "Responsive" : `No response (${sw.detail})`;
      removeLoadingSkeleton(elements.envServiceWorker);
    }

    // Overall env status
    const okRuntime = GCC.hasChrome();
    const okTabs = GCC.hasChromeTabs();
    const okScript = GCC.hasChromeScripting();

    if (!okRuntime) {
      setEnvStatus("runtime missing", "danger");
    } else if (!okTabs) {
      setEnvStatus("tabs api missing", "warning");
    } else if (!okScript) {
      setEnvStatus("scripting missing", "warning");
    } else {
      setEnvStatus("ready", "success");
    }
  };

  // =========================
  // Service Worker Ping
  // =========================

  const pingServiceWorker = async (quiet = false) => {
    if (!GCC.hasChrome()) return { ok: false, detail: "runtime unavailable" };

    const pingMsg = {
      type: "__gcc_diagnostics_ping__",
      ts: Date.now(),
      v: DIAGNOSTICS_VERSION
    };

    try {
      const resp = await Promise.race([
        GCC.sendMessage(pingMsg),
        (async () => {
          await GCC.sleep(CONFIG.SW_PING_TIMEOUT_MS);
          throw new Error("timeout");
        })()
      ]);

      const ok =
        resp &&
        (resp.ok === true ||
          resp.type === "__gcc_diagnostics_pong__" ||
          resp.pong === true);

      return { ok: !!ok, detail: ok ? "pong" : "unexpected response" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!quiet) addLog(`Service worker ping failed: ${msg}`, "error");
      return { ok: false, detail: msg };
    }
  };

  // =========================
  // Tab Strategy Detection (best-effort)
  // =========================

  const detectTabStrategy = async () => {
    // default behavior: active tab in current window
    if (!GCC.hasChromeStorage("sync")) {
      return { strategy: "active", enabled: false, source: "default" };
    }

    // we don't know your exact settings keys, so we probe common ones safely
    const keys = [
      "useDedicatedCleaningTab",
      "runInDedicatedTab",
      "dedicatedTabEnabled",
      "preferDedicatedTab",
      "useCleanerTab",
      "openDedicatedTab",
      "dedicatedGmailTabEnabled",
      "dedicatedGmailTab"
    ];

    const res = await GCC.storageGet("sync", keys).catch(() => ({}));

    let enabled = null;
    let source = "default";

    for (const k of keys) {
      if (typeof res?.[k] === "boolean") {
        enabled = res[k];
        source = k;
        break;
      }
      // allow string flags like "true"/"false" (bad data but happens)
      if (typeof res?.[k] === "string" && (res[k] === "true" || res[k] === "false")) {
        enabled = res[k] === "true";
        source = k;
        break;
      }
    }

    if (enabled === true) return { strategy: "dedicated", enabled: true, source };
    return { strategy: "active", enabled: false, source };
  };

  // =========================
  // Last Run Stats
  // =========================

  const getRunCount = (stats) => {
    if (!stats) return 0;
    if (typeof stats.runCount === "number") return stats.runCount;
    return stats.mode === "dry" ? (stats.totalWouldDelete || 0) : (stats.totalDeleted || 0);
  };

  const getActionWord = (stats) => {
    if (!stats) return "affected";
    if (stats.mode === "dry") return "would affect";
    return stats.archiveInsteadOfDelete ? "archived" : "deleted";
  };

  const getModeLabel = (stats) => {
    if (!stats) return "Unknown";
    if (stats.mode === "dry") return "Dry Run";
    return stats.archiveInsteadOfDelete ? "Archive" : "Delete";
  };

  const getTagClass = (stats) => {
    if (!stats) return TAG_CLASSES.default;
    if (stats.mode === "dry") return TAG_CLASSES.dry;
    return stats.archiveInsteadOfDelete ? TAG_CLASSES.archive : TAG_CLASSES.delete;
  };

  const applyLastRunToDom = (stats) => {
    if (!elements.lastRunSummary && !elements.lastRunMeta && !elements.lastRunBucketTag && !elements.lastRunButtons) {
      return;
    }

    if (!stats) {
      if (elements.lastRunSummary) elements.lastRunSummary.textContent = "No cleanup runs recorded yet in this browser.";
      if (elements.lastRunMeta) elements.lastRunMeta.textContent = "";
      if (elements.lastRunBucketTag) {
        elements.lastRunBucketTag.textContent = "no runs";
        elements.lastRunBucketTag.className = "tag";
      }
      if (elements.lastRunButtons) elements.lastRunButtons.replaceChildren();
      return;
    }

    const mode = stats.mode === "dry" ? "preview (dry run)" : "live cleanup";
    const runCount = getRunCount(stats);
    const sizeBucket = stats.sizeBucket || "tiny";
    const totalQueries = typeof stats.totalQueries === "number" ? stats.totalQueries : "?";
    const actionWord = getActionWord(stats);
    const finishedText = GCC.formatDate(stats.finishedAt ?? null);

    let freedMbText = "";
    if (typeof stats.totalFreedMb === "number" && stats.mode !== "dry") {
      if (stats.totalFreedMb < 0.1 && stats.totalFreedMb > 0) freedMbText = "< 0.1 MB";
      else freedMbText = `${stats.totalFreedMb.toFixed(1)} MB`;
    } else {
      freedMbText = sizeBucket;
    }

    if (elements.lastRunSummary) {
      elements.lastRunSummary.textContent = `Last run: ${mode}, ${GCC.formatNumber(runCount)} conversations ${actionWord}.`;
    }

    if (elements.lastRunMeta) {
      elements.lastRunMeta.textContent = `Queries: ${totalQueries} • Freed: ${freedMbText} • Finished: ${finishedText}`;
    }

    if (elements.lastRunBucketTag) {
      elements.lastRunBucketTag.textContent = sizeBucket;
      elements.lastRunBucketTag.className = sizeBucket !== "tiny" ? "tag tag-primary" : "tag";
    }

    if (elements.lastRunButtons) {
      elements.lastRunButtons.replaceChildren();
      const links = stats.links || {};

      if (links.trash) {
        const trashBtn = document.createElement("a");
        trashBtn.href = links.trash;
        trashBtn.target = "_blank";
        trashBtn.rel = "noopener noreferrer";
        trashBtn.textContent = "🗑️ Open Trash";
        trashBtn.className = "button-link";
        trashBtn.setAttribute("aria-label", "Open Gmail Trash (opens in new tab)");
        elements.lastRunButtons.appendChild(trashBtn);
      }

      if (links.allMail) {
        const allMailBtn = document.createElement("a");
        allMailBtn.href = links.allMail;
        allMailBtn.target = "_blank";
        allMailBtn.rel = "noopener noreferrer";
        allMailBtn.textContent = "📬 Open All Mail";
        allMailBtn.className = "button-link btn-ghost";
        allMailBtn.setAttribute("aria-label", "Open Gmail All Mail (opens in new tab)");
        elements.lastRunButtons.appendChild(allMailBtn);
      }
    }
  };

  const renderLastRunFromStorage = async () => {
    if (!GCC.hasChromeStorage("sync")) return;
    try {
      const result = await GCC.storageGet("sync", ["lastRunStats"]);
      applyLastRunToDom(result?.lastRunStats ?? null);
    } catch (err) {
      console.warn("[Diagnostics] Failed to load last run stats:", err);
    }
  };

  // =========================
  // Run History
  // =========================

  const createHistoryRow = (run) => {
    const row = document.createElement("tr");
    const count = getRunCount(run);

    const dateCell = document.createElement("td");
    dateCell.className = "mono small";
    dateCell.textContent = GCC.formatDate(run.finishedAt ?? null);

    const modeCell = document.createElement("td");
    const modeTag = document.createElement("span");
    modeTag.className = getTagClass(run);
    modeTag.textContent = getModeLabel(run);
    modeCell.appendChild(modeTag);

    const countCell = document.createElement("td");
    countCell.className = "mono";
    countCell.textContent = GCC.formatNumber(count);

    const queriesCell = document.createElement("td");
    queriesCell.className = "mono";
    queriesCell.textContent = `${run.totalQueries ?? "?"} queries`;

    const sizeCell = document.createElement("td");
    sizeCell.className = "small muted";

    let mbText = "-";
    if (typeof run.totalFreedMb === "number") {
      if (run.totalFreedMb < 0.1 && run.totalFreedMb > 0) mbText = "<0.1 MB";
      else mbText = `${run.totalFreedMb.toFixed(1)} MB`;
    } else if (run.sizeBucket) {
      mbText = run.sizeBucket;
    }
    sizeCell.textContent = mbText;

    row.appendChild(dateCell);
    row.appendChild(modeCell);
    row.appendChild(countCell);
    row.appendChild(queriesCell);
    row.appendChild(sizeCell);

    return row;
  };

  const createEmptyHistoryRow = (message) => {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "table-empty";

    const iconDiv = document.createElement("div");
    iconDiv.className = "table-empty-icon";
    iconDiv.setAttribute("aria-hidden", "true");
    iconDiv.textContent = "\uD83D\uDCCB";

    const msgDiv = document.createElement("div");
    msgDiv.textContent = message;

    cell.appendChild(iconDiv);
    cell.appendChild(msgDiv);
    row.appendChild(cell);
    return row;
  };

  const renderRunHistory = async () => {
    if (!elements.runHistoryTableBody) return;

    if (!GCC.hasChromeStorage("local")) {
      elements.runHistoryTableBody.replaceChildren();
      elements.runHistoryTableBody.appendChild(createEmptyHistoryRow("Storage unavailable"));
      return;
    }

    try {
      const result = await GCC.storageGet("local", ["runHistory"]);
      const history = Array.isArray(result?.runHistory) ? result.runHistory : [];

      elements.runHistoryTableBody.replaceChildren();

      if (history.length === 0) {
        elements.runHistoryTableBody.appendChild(
          createEmptyHistoryRow("No history recorded yet. Run a cleanup to see history here.")
        );
        return;
      }

      const sorted = [...history].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));

      const fragment = document.createDocumentFragment();
      for (const run of sorted.slice(0, 10)) fragment.appendChild(createHistoryRow(run));
      elements.runHistoryTableBody.appendChild(fragment);
    } catch (err) {
      console.error("[Diagnostics] Failed to render history:", err);
      elements.runHistoryTableBody.replaceChildren();
      elements.runHistoryTableBody.appendChild(createEmptyHistoryRow("Failed to load history"));
    }
  };

  // =========================
  // Gmail Tab Detection
  // =========================

  const isGmailUrl = (url) => typeof url === "string" && url.startsWith("https://mail.google.com/");

  const findGmailTab = async () => {
    if (!GCC.hasChromeTabs()) {
      addLog("chrome.tabs is not available in this context.", "error");
      return null;
    }

    try {
      const activeTabs = await GCC.promisify(chrome.tabs.query.bind(chrome.tabs), { active: true, currentWindow: true });
      const activeTab = activeTabs?.[0] || null;

      if (activeTab?.id && isGmailUrl(activeTab.url)) return activeTab;

      const tabsInWindow = await GCC.promisify(chrome.tabs.query.bind(chrome.tabs), { url: "https://mail.google.com/*", currentWindow: true });
      if (tabsInWindow?.length) {
        const active = tabsInWindow.find((t) => t.active);
        return active || tabsInWindow[0];
      }

      const allTabs = await GCC.promisify(chrome.tabs.query.bind(chrome.tabs), { url: "https://mail.google.com/*" });
      if (!allTabs?.length) return null;

      const activeAnywhere = allTabs.find((t) => t.active);
      return activeAnywhere || allTabs[0];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLog(`Error finding Gmail tab: ${message}`, "error");
      return null;
    }
  };

  const computeCleanerTabCandidate = (tabs, chosenTab, strategy) => {
    // If dedicated strategy is enabled, prefer a non-active Gmail tab in the same window.
    if (strategy?.strategy === "dedicated" && chosenTab?.windowId !== undefined && chosenTab?.windowId !== null) {
      const sameWindow = tabs.filter((t) => t.windowId === chosenTab.windowId);
      const nonActive = sameWindow.find((t) => !t.active && isGmailUrl(t.url));
      return nonActive || chosenTab || null;
    }
    // Otherwise: cleaner tab = chosen tab
    return chosenTab || null;
  };

  const createTabRow = (tab) => {
    const row = document.createElement("tr");

    const idCell = document.createElement("td");
    idCell.textContent = String(tab.id ?? "?");
    idCell.className = "mono";

    const winCell = document.createElement("td");
    winCell.textContent = String(tab.windowId ?? "?");
    winCell.className = "mono";

    const actCell = document.createElement("td");
    if (tab.active) {
      const activeBadge = document.createElement("span");
      activeBadge.className = "tag tag-success";
      activeBadge.textContent = "yes";
      actCell.appendChild(activeBadge);
    } else {
      actCell.textContent = "no";
      actCell.className = "muted";
    }

    const urlCell = document.createElement("td");
    urlCell.textContent = GCC.truncate(tab.url || "(unknown)", CONFIG.MAX_URL_LENGTH);
    urlCell.className = "mono";
    urlCell.title = tab.url || "";

    row.appendChild(idCell);
    row.appendChild(winCell);
    row.appendChild(actCell);
    row.appendChild(urlCell);

    return row;
  };

  const createEmptyTabRow = (message) => {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "table-empty";

    const iconDiv = document.createElement("div");
    iconDiv.className = "table-empty-icon";
    iconDiv.setAttribute("aria-hidden", "true");
    iconDiv.textContent = "\uD83D\uDCE7";

    const msgDiv = document.createElement("div");
    msgDiv.textContent = message;

    cell.appendChild(iconDiv);
    cell.appendChild(msgDiv);
    row.appendChild(cell);
    return row;
  };

  const setChosenAndCleanerText = (chosen, cleaner) => {
    const chosenText = chosen?.id
      ? `Tab ${chosen.id} in window ${chosen.windowId} – ${GCC.truncate(chosen.url || "", 100)}`
      : "None – not computed yet.";

    const cleanerText = cleaner?.id
      ? `Tab ${cleaner.id} in window ${cleaner.windowId} – ${GCC.truncate(cleaner.url || "", 100)}`
      : "None – not computed yet.";

    if (elements.chosenTabText) elements.chosenTabText.textContent = chosenText;
    if (elements.chosenTabTextInline) elements.chosenTabTextInline.textContent = chosen?.id ? `${chosen.id}` : "none";

    if (elements.cleanerTabText) elements.cleanerTabText.textContent = cleanerText;
    if (elements.cleanerTabTextInline) elements.cleanerTabTextInline.textContent = cleaner?.id ? `${cleaner.id}` : "none";
  };

  const scanTabs = async () => {
    if (!GCC.hasChromeTabs()) {
      setLog("chrome.tabs is not available in this context.", "error");
      GCC.showToast("Tab API unavailable", "error");
      return;
    }

    setButtonLoading(elements.scanTabsBtn, true);
    setButtonLoading(elements.testInjectBtn, true);

    addLog("Scanning for Gmail tabs...", "info");

    try {
      const tabs = await GCC.promisify(chrome.tabs.query.bind(chrome.tabs), { url: "https://mail.google.com/*" });

      if (elements.tabCount) elements.tabCount.textContent = String(tabs.length);

      if (elements.tabTableBody) {
        elements.tabTableBody.replaceChildren();
        if (tabs.length === 0) {
          elements.tabTableBody.appendChild(createEmptyTabRow("No Gmail tabs found. Open Gmail and try again."));
        } else {
          const fragment = document.createDocumentFragment();
          for (const tab of tabs) fragment.appendChild(createTabRow(tab));
          elements.tabTableBody.appendChild(fragment);
        }
      }

      if (tabs.length === 0) {
        if (elements.chosenTabText) {
          elements.chosenTabText.textContent = "None – no Gmail tabs detected.";
          elements.chosenTabText.className = "env-value mono text-warning";
        }
        if (elements.cleanerTabText) {
          elements.cleanerTabText.textContent = "None – no Gmail tabs detected.";
          elements.cleanerTabText.className = "env-value mono text-warning";
        }
        if (elements.chosenTabTextInline) elements.chosenTabTextInline.textContent = "none";
        if (elements.cleanerTabTextInline) elements.cleanerTabTextInline.textContent = "none";

        addLog("No Gmail tabs found.", "warning");
        GCC.showToast("No Gmail tabs found", "warning");
        return;
      }

      const chosen = await findGmailTab();
      const strategy = await detectTabStrategy().catch(() => ({ strategy: "active", enabled: false, source: "default" }));
      const cleaner = computeCleanerTabCandidate(tabs, chosen, strategy);

      if (!chosen) {
        if (elements.chosenTabText) {
          elements.chosenTabText.textContent = "None – detection failed even though Gmail tabs exist.";
          elements.chosenTabText.className = "env-value mono text-danger";
        }
        addLog("Gmail tabs exist, but tab detection returned null.", "error");
        GCC.showToast("Tab detection failed", "error");
        return;
      }

      // Update main chosen text style
      if (elements.chosenTabText) elements.chosenTabText.className = "env-value mono text-success";
      if (elements.cleanerTabText) elements.cleanerTabText.className = "env-value mono";

      setChosenAndCleanerText(chosen, cleaner);

      addLog(`Detection OK. Popup tab: ${chosen.id} (win ${chosen.windowId}).`, "success");
      addLog(
        strategy.strategy === "dedicated"
          ? `Cleaner strategy: dedicated tab preferred (${strategy.source}). Cleaner tab: ${cleaner?.id ?? "none"}.`
          : `Cleaner strategy: active tab preferred (${strategy.source}).`,
        "info"
      );

      GCC.showToast(`Found ${tabs.length} Gmail tab(s)`, "success");
      setButtonLoading(elements.testInjectBtn, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLog(`Failed to query tabs: ${message}`, "error");
      GCC.showToast("Tab scan failed", "error");
    } finally {
      setButtonLoading(elements.scanTabsBtn, false);
    }
  };

  const testInject = async () => {
    if (!GCC.hasChromeScripting() || !GCC.hasChromeTabs() || !GCC.hasChrome()) {
      setLog("chrome.scripting is not available in this context.", "error");
      GCC.showToast("Scripting API unavailable", "error");
      return;
    }

    setButtonLoading(elements.testInjectBtn, true);
    addLog("Attempting to inject diagnostic script...", "info");

    try {
      const tab = await findGmailTab();
      if (!tab?.id) {
        addLog("No Gmail tab available for injection.", "warning");
        GCC.showToast("No Gmail tab available", "warning");
        return;
      }

      const results = await GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: tab.id },
        func: () => {
          const now = new Date().toISOString();
          console.log("[GmailCleaner][Diagnostics] Inject ping at", now, "URL:", location.href);
          return {
            title: document.title,
            href: location.href,
            time: now,
            attached: !!window.__GCC_ATTACHED__
          };
        }
      });

      const payload = results?.[0]?.result ?? null;

      if (payload) {
        addLog(`Inject succeeded into tab ${tab.id}:`, "success");
        addLog(JSON.stringify(payload, null, 2), "info");
        GCC.showToast(payload.attached ? "Content script already attached" : "Inject successful", "success");
      } else {
        addLog(`Inject completed but returned no data for tab ${tab.id}`, "warning");
        GCC.showToast("Inject completed (no data)", "warning");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLog(`Inject failed: ${message}`, "error");
      GCC.showToast("Inject failed", "error");
    } finally {
      setButtonLoading(elements.testInjectBtn, false);
    }
  };

  // =========================
  // Event Listeners
  // =========================

  const setupEventListeners = () => {
    elements.scanTabsBtn?.addEventListener("click", () => scanTabs().catch(console.error));
    elements.testInjectBtn?.addEventListener("click", () => testInject().catch(console.error));

    elements.pingSwBtn?.addEventListener("click", async () => {
      setButtonLoading(elements.pingSwBtn, true);
      addLog("Pinging service worker...", "info");
      const res = await pingServiceWorker(false);
      if (res.ok) {
        addLog("Service worker responded (pong).", "success");
        GCC.showToast("Service worker responsive", "success");
      } else {
        addLog(`No service worker response: ${res.detail}`, "warning");
        GCC.showToast("No service worker response", "warning");
      }
      setButtonLoading(elements.pingSwBtn, false);
    });

    elements.copyLogBtn?.addEventListener("click", () => copyLog().catch(console.error));
    elements.clearLogBtn?.addEventListener("click", clearLog);

    if (GCC.hasChrome() && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type !== "gmailCleanerProgress") return;
        if (msg.phase === "done" && msg.stats) {
          applyLastRunToDom(msg.stats);
          renderRunHistory().catch(console.error);
          addLog("Received completion stats from cleaner run", "success");
        }
      });
    }

    // Ctrl/Cmd+K copies logs
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        copyLog().catch(console.error);
      }
    });
  };

  // =========================
  // Initialization
  // =========================

  const init = async () => {
    await renderEnv();
    setupEventListeners();

    await Promise.allSettled([renderLastRunFromStorage(), renderRunHistory()]);

    addLog(`Diagnostics page initialized (v${DIAGNOSTICS_VERSION})`, "success");
  };

  init().catch(console.error);
})();
