(() => {
  "use strict";

  // =========================
  // Constants & Configuration
  // =========================

  const PROGRESS_VERSION = "8.19.0";

  const CONFIG = Object.freeze({
    MAX_LOG_ENTRIES: 300,
    TOAST_DURATION_MS: 3000,
    RECONNECT_TIMEOUT_MS: 5000,
    AUTO_RECONNECT_INTERVAL_MS: 30000,
    AUTO_RECONNECT_STALE_MS: 60000,
    MAX_AUTO_RECONNECT_ATTEMPTS: 3,

    // How many labels of the run's own tag list the completion card
    // spells out before it collapses the rest into "and N more".
    MAX_VISIBLE_TAG_LABELS: 3,

    // The Pro line on the completion card is only honest when this run
    // actually cleaned bulk mail, because its whole claim is that the
    // same senders refill next month. Below this the line stays hidden
    // rather than being padded out with a generic pitch.
    PRO_LINE_MIN_NOISE_COUNT: 50
  });

  const PHASES = Object.freeze({
    BOOT: "boot",
    STARTING: "starting",
    QUERY: "query",
    QUERY_DONE: "query-done",
    TAG: "tag",
    REVIEW: "review",
    GUARDRAIL: "guardrail",
    DONE: "done",
    CANCELLED: "cancelled",
    ERROR: "error"
  });

  const PHASE_LABELS = Object.freeze({
    [PHASES.BOOT]: "boot",
    [PHASES.STARTING]: "starting",
    [PHASES.QUERY]: "running queries",
    [PHASES.QUERY_DONE]: "query finished",
    [PHASES.TAG]: "tagging",
    [PHASES.REVIEW]: "reviewing",
    [PHASES.GUARDRAIL]: "waiting for confirmation",
    [PHASES.DONE]: "done",
    [PHASES.CANCELLED]: "cancelled",
    [PHASES.ERROR]: "error"
  });

  // Rule labels the engine's labelQuery() assigns to bulk mail. The Pro
  // line counts only these: a run that emptied Big attachments has not
  // earned a bulk-unsubscribe pitch, because unsubscribing would not
  // have stopped any of it.
  const NOISE_RULE_LABELS = Object.freeze([
    "Promotions",
    "Social",
    "Updates",
    "Forums",
    "Newsletters",
    "No-reply"
    // 8.15 deliberately leaves out the two labels added to the engine's
    // map this release. Archiving old inbox mail is not a bulk-mail
    // problem, and a sender-scoped run was already aimed at exactly the
    // senders a pitch would name.
  ]);

  const LOG_LEVELS = Object.freeze({
    INFO: "info",
    SUCCESS: "success",
    WARNING: "warning",
    ERROR: "error"
  });

  // =========================
  // Parse URL Parameters
  // =========================

  const parseGmailTabId = () => {
    try {
      const params = new URLSearchParams(location.search);
      const raw = params.get("gmailTabId");
      if (raw === null || raw === "") return null;

      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  };

  const gmailTabId = parseGmailTabId();

  // =========================
  // State Management
  // =========================

  const state = {
    lastPhase: PHASES.STARTING,
    done: false,
    mode: "live",
    logsVisible: true, // the whole log section shows/hides as one unit
    rows: [],
    // The guardrail question is answered exactly once: every dismissal
    // path funnels through resolveGuard, and this flag is what stops a
    // native close event from sending a second signal after a proceed.
    guardOpen: false,
    // The finished run's stats, kept so Copy receipt can rebuild the
    // summary without re-reading storage.
    doneStats: null,
    isReconnecting: false,
    logHistory: [],
    startTime: Date.now(),
    toastTimer: null,
    lastMessageTime: Date.now(),
    autoReconnectTimer: null,
    autoReconnectAttempts: 0,
    // 8.15: has an engine in this tab ever spoken to this page? Only
    // then may auto-reconnect re-inject. Re-injection restarts a
    // cleanup from the stored config, so doing it on a page that never
    // saw a run starts one nobody asked for.
    sawRunEvidence: false
  };

  // =========================
  // DOM Element Cache
  // =========================

  const ui = {
    // Progress elements
    barInner: document.getElementById("barInner"),
    percentText: document.getElementById("percentText"),
    progressBar: document.querySelector(".bar"),

    // Status elements
    status: document.getElementById("status"),
    statusSpinner: document.querySelector("#status .spinner"),
    statusText: document.getElementById("statusText"),
    tags: document.getElementById("tags"),

    // Version pill (optional)
    versionPill: document.getElementById("versionPill"),

    // Log elements
    details: document.getElementById("details"),
    copyLogsBtn: document.getElementById("copyLogsBtn"),
    clearLogsBtn: document.getElementById("clearLogsBtn"),
    logsContainer: document.querySelector(".logs-container"),
    logsCollapsedBar: document.getElementById("logsCollapsedBar"),
    logsCollapsedCount: document.getElementById("logsCollapsedCount"),
    logsCollapsedLast: document.getElementById("logsCollapsedLast"),

    // Control buttons
    controls: document.querySelector(".controls"),
    cancel: document.getElementById("cancelBtn"),
    reconnect: document.getElementById("reconnectBtn"),
    reinject: document.getElementById("reinjectBtn"),
    resetRun: document.getElementById("resetRunBtn"),
    toggleLogs: document.getElementById("toggleLogs"),

    // Summary elements
    summary: document.getElementById("summary"),
    table: document.getElementById("summaryTable"),

    // Run-completion card
    doneCard: document.getElementById("doneCard"),
    doneNumber: document.getElementById("doneNumber"),
    doneSafetyText: document.getElementById("doneSafetyText"),
    doneLabels: document.getElementById("doneLabels"),
    openRecoveryBtn: document.getElementById("openRecoveryBtn"),
    copyReceiptBtn: document.getElementById("copyReceiptBtn"),
    doneRating: document.getElementById("doneRating"),
    doneRateBtn: document.getElementById("doneRateBtn"),
    doneRateDismiss: document.getElementById("doneRateDismiss"),
    donePro: document.getElementById("donePro"),
    doneProText: document.getElementById("doneProText"),
    doneProBuy: document.getElementById("doneProBuy"),

    // Review modal
    reviewModal: document.getElementById("reviewModal"),
    modalCount: document.getElementById("modalCount"),
    modalQuery: document.getElementById("modalQuery"),
    modalSkipBtn: document.getElementById("modalSkipBtn"),
    modalProceedBtn: document.getElementById("modalProceedBtn"),

    // Guardrail modal
    guardModal: document.getElementById("guardModal"),
    guardCount: document.getElementById("guardCount"),
    guardCountRow: document.getElementById("guardCountRow"),
    guardLead: document.getElementById("guardLead"),
    guardAlternatives: document.getElementById("guardAlternatives"),
    guardTrashNote: document.getElementById("guardTrashNote"),
    guardProceedBtn: document.getElementById("guardProceedBtn"),
    guardStopBtn: document.getElementById("guardStopBtn"),

    // Log filter
    logFilter: document.getElementById("logFilter"),

    // Single toast element (matches your HTML)
    toast: document.getElementById("toast")
  };

  const tbody = ui.table?.querySelector("tbody") || null;

  // =========================
  // Utility Functions
  // =========================

  const getTimestamp = () => {
    const now = new Date();
    return now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  };

  // formatDuration and formatMB intentionally diverge from GCC.formatDuration /
  // GCC.formatMb in shared.js: this view shows compact "12s" / "1.5s" durations
  // and a bare numeric MB value (the " MB" unit is rendered separately in the
  // chip layout). Do not collapse them without updating the chip rendering.
  const formatDuration = (ms) => {
    if (ms === null || ms === undefined || ms < 0) return "-";
    const sec = ms / 1000;
    return sec.toFixed(sec >= 10 ? 0 : 1) + "s";
  };

  const formatNumber = GCC.formatNumber;

  // Catalog lookup with the English fallback inline at the call site,
  // matching popup.js. Static markup is translated by GCC.i18n.apply at
  // init; this covers the strings only the run's own numbers can build.
  const t = GCC.i18n.t;

  const formatMB = (mb) => {
    const n = Number(mb);
    if (!Number.isFinite(n) || n <= 0) return "0";
    return n >= 10 ? n.toFixed(0) : n.toFixed(1);
  };

  const log = (level, ...args) => {
    const prefix = "[Gmail Cleaner Progress]";
    const fn = console[level] || console.log;
    fn.call(console, prefix, ...args);
  };

  // =========================
  // Toast Notifications (single element)
  // =========================
  // NOTE: progress.js uses a single #toast element pattern,
  // NOT the .toast-container pattern from shared.js.
  // This local implementation is intentionally kept.

  const TOAST_ICONS = Object.freeze({
    success: "\u2705",
    error: "\u274C",
    warning: "\u26A0\uFE0F",
    info: "\u2139\uFE0F"
  });

  const showToast = (message, type = "info", duration = CONFIG.TOAST_DURATION_MS) => {
    if (!ui.toast) {
      log("info", `[Toast ${type}]`, message);
      return;
    }

    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }

    const icon = TOAST_ICONS[type] || TOAST_ICONS.info;
    ui.toast.textContent = `${icon} ${message}`;

    ui.toast.classList.remove("success", "error", "warning");
    if (type === "success") ui.toast.classList.add("success");
    else if (type === "error") ui.toast.classList.add("error");
    else if (type === "warning") ui.toast.classList.add("warning");

    ui.toast.classList.add("show");

    state.toastTimer = setTimeout(() => {
      ui.toast.classList.remove("show");
      state.toastTimer = null;
    }, duration);
  };

  // =========================
  // Status Management
  // =========================

  const setStatus = (message) => {
    if (ui.statusSpinner) ui.statusSpinner.hidden = true;
    if (ui.statusText) ui.statusText.textContent = message || "";
  };

  const setStatusLoading = (message) => {
    if (ui.statusSpinner) ui.statusSpinner.hidden = false;
    if (ui.statusText) ui.statusText.textContent = message || "";
  };

  // map your internal phases to the CSS phase colors in the HTML
  const phaseToCssPhase = (phase) => {
    if (phase === PHASES.ERROR) return "error";
    if (phase === PHASES.DONE || phase === PHASES.CANCELLED) return "complete";
    // The guardrail shares the amber "cleaning" bucket on purpose: the
    // run is paused mid-action and needs an answer, not a status read.
    if (phase === PHASES.TAG || phase === PHASES.GUARDRAIL) return "cleaning";
    if (phase === PHASES.QUERY || phase === PHASES.QUERY_DONE || phase === PHASES.REVIEW) return "searching";
    return "starting";
  };

  const setPhaseTag = (phase) => {
    if (!ui.tags) return;

    const label = PHASE_LABELS[phase] || phase || "starting";
    ui.tags.textContent = label;

    // Use the CSS-friendly phase bucket for styling
    ui.tags.setAttribute("data-phase", phaseToCssPhase(phase || "starting"));
  };

  // =========================
  // Progress Bar
  // =========================

  const setPercent = (p) => {
    const percent = Math.max(0, Math.min(100, Number.isFinite(p) ? p : 0));

    if (ui.barInner) {
      ui.barInner.style.width = `${percent}%`;
      if (percent >= 100) ui.barInner.setAttribute("data-complete", "true");
      else ui.barInner.removeAttribute("data-complete");
    }

    if (ui.percentText) ui.percentText.textContent = `${percent.toFixed(0)}%`;
    if (ui.progressBar) ui.progressBar.setAttribute("aria-valuenow", String(Math.round(percent)));
  };

  // =========================
  // Logging System
  // =========================

  const appendLog = (line, level = LOG_LEVELS.INFO) => {
    if (!ui.details) return;

    const emptyState = ui.details.querySelector(".empty-state");
    if (emptyState) emptyState.remove();

    const timestamp = getTimestamp();
    const entry = `[${timestamp}] ${line}`;

    state.logHistory.push(entry);
    if (state.logHistory.length > CONFIG.MAX_LOG_ENTRIES) state.logHistory.shift();

    const div = document.createElement("div");
    div.className = `log-entry log-${level}`;

    const ts = document.createElement("span");
    ts.className = "log-timestamp";
    ts.textContent = `[${timestamp}]`;

    div.appendChild(ts);
    div.appendChild(document.createTextNode(` ${line}`));
    ui.details.appendChild(div);

    while (ui.details.children.length > CONFIG.MAX_LOG_ENTRIES) {
      ui.details.removeChild(ui.details.firstChild);
    }

    ui.details.scrollTop = ui.details.scrollHeight;

    // A hidden log keeps its one-line summary live.
    if (!state.logsVisible) updateCollapsedLogsSummary();
  };

  const clearLogs = () => {
    if (!ui.details) return;

    ui.details.replaceChildren();
    state.logHistory = [];

    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "Log cleared";
    ui.details.appendChild(emptyState);

    if (!state.logsVisible) updateCollapsedLogsSummary();
    showToast("log cleared", "info");
  };

  const filterLogs = (query) => {
    if (!ui.details) return;
    const entries = ui.details.querySelectorAll(".log-entry");
    const q = (query || "").toLowerCase().trim();

    for (const entry of entries) {
      if (!q || entry.textContent.toLowerCase().includes(q)) {
        entry.style.display = "";
      } else {
        entry.style.display = "none";
      }
    }
  };

  const copyLogs = async () => {
    if (state.logHistory.length === 0) {
      showToast("no logs to copy", "warning");
      return;
    }

    const content = [
      "Gmail Cleaner Progress Log",
      `Generated: ${new Date().toISOString()}`,
      `Gmail Tab ID: ${gmailTabId || "unknown"}`,
      "---",
      ...state.logHistory
    ].join("\n");

    try {
      await navigator.clipboard.writeText(content);
      showToast("log copied", "success");
    } catch {
      showToast("failed to copy", "error");
    }
  };

  // =========================
  // Summary & Stats
  // =========================

  const renderStatsSummary = (stats) => {
    if (!ui.summary) return;
    ui.summary.replaceChildren();
    if (!stats) return;

    const mode = stats.mode === "dry" ? "dry" : "live";
    state.mode = mode;

    const chips = [];

    if (mode === "dry") {
      chips.push(["Mode", "Dry-run"]);
      const wouldCleanTotal = (stats.totalWouldDelete || 0) + (stats.totalWouldArchive || 0);
      if (wouldCleanTotal > 0) chips.push(["Would clean", formatNumber(wouldCleanTotal)]);
    } else {
      chips.push(["Mode", "Live"]);
      const cleanedTotal = (stats.totalDeleted || 0) + (stats.totalArchived || 0);
      if (cleanedTotal > 0) chips.push(["Cleaned", formatNumber(cleanedTotal)]);
    }

    if (typeof stats.totalQueries === "number") chips.push(["Queries", formatNumber(stats.totalQueries)]);

    // Freed storage if provided by content script. Through freedMbOf, so
    // the archive rule this file already states in one place holds in
    // both: the KPI chip used to read the raw total and would have shown
    // "Freed 300 MB" beside a done card that correctly showed none.
    const freedMb = freedMbOf(stats);
    if (freedMb > 0) chips.push(["Freed", `${formatMB(freedMb)} MB`]);

    const duration = Date.now() - state.startTime;
    if (duration > 1000) chips.push(["Duration", formatDuration(duration)]);

    for (const [label, value] of chips) {
      const pill = document.createElement("span");
      pill.className = "pill";

      const labelText = document.createTextNode(`${label}: `);
      const strong = document.createElement("strong");
      strong.textContent = value;

      pill.appendChild(labelText);
      pill.appendChild(strong);
      ui.summary.appendChild(pill);
    }
  };

  // =========================
  // Per-query table
  // HTML columns: Query | Mode | Count | Freed MB | Duration
  // =========================

  const renderRowsTable = () => {
    if (!ui.table || !tbody) return;

    if (state.rows.length === 0) {
      ui.table.style.display = "none";
      tbody.replaceChildren();
      return;
    }

    ui.table.style.display = "table";
    tbody.replaceChildren();

    const fragment = document.createDocumentFragment();

    for (const row of state.rows) {
      const tr = document.createElement("tr");

      // Query/Label
      const tdQuery = document.createElement("td");
      tdQuery.textContent = row.label || row.query || "(unknown)";
      tdQuery.title = row.query || "";
      tr.appendChild(tdQuery);

      // Mode
      const tdMode = document.createElement("td");
      const modeTag = document.createElement("span");
      modeTag.className = "tag";
      modeTag.textContent = row.mode === "dry" ? "dry-run" : "live";
      tdMode.appendChild(modeTag);
      tr.appendChild(tdMode);

      // Count
      const tdCount = document.createElement("td");
      tdCount.textContent = formatNumber(row.count || 0);
      tr.appendChild(tdCount);

      // Freed MB
      const tdFreed = document.createElement("td");
      const freed = Number(row.freedMb);
      tdFreed.textContent = Number.isFinite(freed) && freed > 0 ? formatMB(freed) : "0";
      tr.appendChild(tdFreed);

      // Duration
      const tdDuration = document.createElement("td");
      tdDuration.textContent = formatDuration(row.durationMs);
      tr.appendChild(tdDuration);

      fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);
  };

  // =========================
  // Run-completion card (8.0)
  // =========================
  // A finished run is the highest-intent moment this product has, and
  // until 8.0 it ended on a disabled button reading "Run finished". The
  // card answers the three questions people actually have at that point:
  // how much went, whether it is recoverable, and what to do next.

  // A dry run books its findings under totalWouldDelete, so reading the
  // live counters there would headline every preview as zero. Same split
  // renderStatsSummary already makes for the KPI chips.
  const cleanedTotalOf = (stats) => (stats?.mode === "dry"
    ? (Number(stats?.totalWouldDelete) || 0) + (Number(stats?.totalWouldArchive) || 0)
    : (Number(stats?.totalDeleted) || 0) + (Number(stats?.totalArchived) || 0));

  const freedMbOf = (stats) => {
    // 8.9: archived mail is still in the account and still against the
    // quota, so an archive run frees nothing. The engine stopped
    // recording it, but runs finished by an older version are already in
    // the history this page replays, so the check lives here too.
    if (stats?.action === "archive") return 0;
    const mb = Number(stats?.totalFreedMb ?? stats?.freedMb);
    return Number.isFinite(mb) && mb > 0 ? mb : 0;
  };

  // Only bulk-mail rules count toward the Pro line. Labels come from the
  // engine's own fixed English label map, not from user text.
  const noiseCleanedCount = (stats) => {
    if (!Array.isArray(stats?.perQuery)) return 0;
    let total = 0;
    for (const row of stats.perQuery) {
      if (NOISE_RULE_LABELS.includes(row?.label)) total += Number(row?.count) || 0;
    }
    return total;
  };

  const renderDoneNumber = (stats) => {
    if (!ui.doneNumber) return;
    ui.doneNumber.replaceChildren();

    const cleaned = cleanedTotalOf(stats);
    const countText = formatNumber(cleaned);

    const main = document.createElement("span");
    main.textContent = stats.mode === "dry"
      ? t("progDoneMatchedDry", `${countText} emails matched, nothing was moved`, [countText])
      : t("progDoneCleaned", `${countText} emails cleaned`, [countText]);
    ui.doneNumber.appendChild(main);

    // "at least" is not a hedge, it is the truth: the engine reads
    // Gmail's own rounded per-message sizes, so the total is a floor.
    const freedMb = freedMbOf(stats);
    if (freedMb > 0) {
      const mbText = `${formatMB(freedMb)} MB`;
      const freed = document.createElement("span");
      freed.className = "done-number-freed";
      freed.textContent = t("progDoneFreed", `at least ~${mbText}`, [mbText]);
      ui.doneNumber.appendChild(document.createTextNode(", "));
      ui.doneNumber.appendChild(freed);
    }
  };

  const renderDoneSafety = (stats) => {
    if (!ui.doneSafetyText) return;

    if (stats.mode === "dry") {
      ui.doneSafetyText.textContent = t(
        "progDoneSafetyDry",
        "This was a Dry Run, so nothing was labelled, moved or deleted."
      );
      return;
    }

    ui.doneSafetyText.textContent = stats.action === "archive"
      ? t(
        "progDoneSafetyArchive",
        "Every match was labelled first, then archived. Archived mail stays in All Mail with no deadline."
      )
      : t(
        "progDoneSafetyDelete",
        "Every match was labelled first, then moved to Trash. Gmail keeps Trash for about 30 days, so it is still there, and your storage frees up when Trash empties."
      );
  };

  // Showing the label names is the only proof the tagging promise was
  // kept, so an empty list drops the clause instead of asserting it.
  const renderDoneLabels = (stats) => {
    if (!ui.doneLabels) return;

    const labels = Array.isArray(stats?.tagLabels)
      ? stats.tagLabels.filter((label) => typeof label === "string" && label.trim())
      : [];

    if (labels.length === 0) {
      ui.doneLabels.hidden = true;
      return;
    }

    // Keep the lead-in span the markup ships; replace only the chips.
    for (const chip of ui.doneLabels.querySelectorAll(".done-label-chip, .done-labels-more")) {
      chip.remove();
    }

    const visible = labels.slice(0, CONFIG.MAX_VISIBLE_TAG_LABELS);
    for (const label of visible) {
      const chip = document.createElement("span");
      chip.className = "done-label-chip";
      chip.textContent = label;
      ui.doneLabels.appendChild(chip);
    }

    const hidden = labels.length - visible.length;
    if (hidden > 0) {
      const more = document.createElement("span");
      more.className = "done-labels-more";
      more.textContent = t("progDoneLabelsMore", `and ${formatNumber(hidden)} more`, [formatNumber(hidden)]);
      ui.doneLabels.appendChild(more);
    }

    ui.doneLabels.hidden = false;
  };

  const maybeShowRatingAsk = (stats) => {
    if (!ui.doneRating) return;
    const qualifies = GCC.popupUi.ratingRunQualifies({
      dryRun: stats.mode === "dry",
      cleaned: cleanedTotalOf(stats),
      freedMb: freedMbOf(stats)
    });
    ui.doneRating.hidden = !qualifies;
  };

  // One data-led line, built from this run's own bulk-mail count. It
  // stays hidden for dry runs (nothing was cleaned to point at), for
  // small runs (the claim would not be earned) and for anyone who
  // already paid. The license read is the last gate on purpose: a
  // failed lookup leaves the line hidden rather than pitching an owner.
  const maybeShowProLine = (stats) => {
    if (!ui.donePro || !ui.doneProText || !ui.doneProBuy) return;
    if (stats.mode === "dry") return;

    const noise = noiseCleanedCount(stats);
    if (noise < CONFIG.PRO_LINE_MIN_NOISE_COUNT) return;

    const noiseText = formatNumber(noise);
    GCC.license.getState().then((licenseState) => {
      if (licenseState.active) return;
      ui.doneProText.textContent = t(
        "progDoneProNoise",
        `${noiseText} of what this run cleaned was promotional or list mail, and the same senders refill it next month. Pro unsubscribes from them in bulk: $9.99 once, no subscription.`,
        [noiseText]
      );
      ui.doneProBuy.href = GCC.license.buyUrl("progress_done");
      ui.donePro.hidden = false;
    }).catch(() => {});
  };

  // Plain text, clipboard only: no download, no network. Raw Gmail
  // queries are deliberately absent, because a scoped run's query is a
  // list of sender addresses harvested from the user's own mailbox
  // (7.15.0 stripped them from everything persisted for the same reason).
  const buildReceipt = (stats) => {
    const lines = ["Gmail One-Click Cleaner run receipt"];
    lines.push(`Date: ${new Date().toLocaleString()}`);
    lines.push(`Mode: ${stats.mode === "dry" ? "Dry run" : "Live run"}`);
    lines.push(`Action: ${stats.action === "archive" ? "Archived" : "Moved to Trash"}`);

    const cleaned = formatNumber(cleanedTotalOf(stats));
    lines.push(stats.mode === "dry"
      ? `Matched: ${cleaned} conversations (nothing was moved)`
      : `Cleaned: ${cleaned} conversations`);

    const freedMb = freedMbOf(stats);
    if (freedMb > 0) lines.push(`Storage: at least ~${formatMB(freedMb)} MB`);

    const labels = Array.isArray(stats?.tagLabels)
      ? stats.tagLabels.filter((label) => typeof label === "string" && label.trim())
      : [];
    if (labels.length > 0) lines.push(`Labels applied: ${labels.join(", ")}`);

    if (Array.isArray(stats?.perQuery) && stats.perQuery.length > 0) {
      lines.push("Rules:");
      for (const row of stats.perQuery) {
        lines.push(`  ${row?.label || "(unlabelled rule)"}: ${formatNumber(Number(row?.count) || 0)}`);
      }
    }

    return lines.join("\n");
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The async clipboard is refused whenever the page is not the
      // focused document, which a just-opened tab or a stray click on
      // the Gmail window is enough to cause. The textarea path has no
      // such requirement.
      try {
        const scratch = document.createElement("textarea");
        scratch.value = text;
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.top = "-1000px";
        document.body.appendChild(scratch);
        scratch.select();
        const copied = document.execCommand("copy");
        scratch.remove();
        return copied;
      } catch {
        return false;
      }
    }
  };

  const handleCopyReceipt = async () => {
    if (!state.doneStats) {
      showToast("no finished run to copy", "warning");
      return;
    }
    const copied = await copyToClipboard(buildReceipt(state.doneStats));
    if (copied) showToast(t("progReceiptCopied", "receipt copied"), "success");
    else showToast(t("progReceiptFailed", "could not copy receipt"), "error");
  };

  const openInNewTab = async (url) => {
    if (!GCC.hasChromeTabs()) {
      appendLog("Cannot open a new tab: chrome.tabs unavailable", LOG_LEVELS.ERROR);
      showToast("cannot open tab", "error");
      return;
    }
    try {
      await GCC.promisify(chrome.tabs.create.bind(chrome.tabs), { url, active: true });
    } catch (err) {
      log("error", "Failed to open tab:", err);
      appendLog(`Failed to open a new tab: ${err?.message || err}`, LOG_LEVELS.ERROR);
      showToast("could not open tab", "error");
    }
  };

  // No inline "Restore this run" button here on purpose: a run applies
  // one label per rule, so a single control could only ever put some of
  // it back. The Recovery Log restores per entry, which is honest.
  const recoveryLogUrl = () => {
    if (GCC.hasChrome() && chrome.runtime?.getURL) {
      return chrome.runtime.getURL("stats.html#recovery");
    }
    return "stats.html#recovery";
  };

  const renderCompletionCard = (stats) => {
    if (!ui.doneCard || !stats) return false;

    state.doneStats = stats;
    ui.doneCard.classList.toggle("dry", stats.mode === "dry");

    renderDoneNumber(stats);
    renderDoneSafety(stats);
    renderDoneLabels(stats);
    maybeShowRatingAsk(stats);
    maybeShowProLine(stats);

    ui.doneCard.hidden = false;
    return true;
  };

  // =========================
  // Button State Management
  // =========================

  const setButtonLoading = (btn, loading, loadingText) => {
    if (!btn) return;

    btn.disabled = loading;

    if (loading) {
      btn.classList.add("loading");
      btn.setAttribute("aria-busy", "true");
      if (loadingText) {
        btn.dataset.originalText = btn.textContent || "";
        btn.textContent = loadingText;
      }
    } else {
      btn.classList.remove("loading");
      btn.removeAttribute("aria-busy");
      if (btn.dataset.originalText) {
        btn.textContent = btn.dataset.originalText;
        delete btn.dataset.originalText;
      }
    }
  };

  // A cancelled or errored run still needs Reconnect and Re-inject, so
  // the row stays. A clean finish does not: the completion card takes
  // its place, and a greyed-out "Run finished" button reads as broken.
  const updateButtonsForDone = (phase, cardShown) => {
    if (phase === PHASES.DONE && cardShown) {
      if (ui.controls) ui.controls.hidden = true;
      return;
    }

    if (ui.cancel) {
      ui.cancel.disabled = true;
      ui.cancel.classList.remove("loading");

      if (phase === PHASES.CANCELLED) ui.cancel.textContent = "Run cancelled";
      else if (phase === PHASES.ERROR) ui.cancel.textContent = "Run ended with error";
      else ui.cancel.textContent = "Run finished";
    }

    if (ui.reconnect) ui.reconnect.disabled = true;
    if (ui.reinject) ui.reinject.disabled = true;
  };

  // =========================
  // Review Modal
  // =========================

  const openReviewModal = (label, count, query) => {
    if (!ui.reviewModal) return;

    if (ui.modalCount) {
      ui.modalCount.textContent =
        typeof count === "number" ? formatNumber(count) : String(count || "many");
    }
    if (ui.modalQuery) ui.modalQuery.textContent = label || query || "";

    try {
      ui.reviewModal.showModal();
    } catch (err) {
      log("error", "Failed to show review modal:", err);
    }
  };

  const closeReviewModal = () => {
    if (!ui.reviewModal) return;
    try {
      ui.reviewModal.close();
    } catch {
      // ignore
    }
  };

  const sendReviewSignal = async (signal) => {
    if (!gmailTabId) {
      appendLog("Cannot send review signal: Gmail tab ID missing", LOG_LEVELS.ERROR);
      return;
    }
    if (!GCC.hasChromeTabs()) {
      appendLog("Cannot send review signal: chrome.tabs unavailable", LOG_LEVELS.ERROR);
      return;
    }

    try {
      const type = signal === "resume" ? "gmailCleanerResume" : "gmailCleanerSkip";
      await GCC.promisify(chrome.tabs.sendMessage.bind(chrome.tabs), gmailTabId, { type });

      appendLog(`Review decision: ${signal.toUpperCase()}`, LOG_LEVELS.SUCCESS);
      setPhaseTag(PHASES.QUERY);
      setStatusLoading("Continuing cleanup...");
    } catch (err) {
      log("error", "Failed to send review signal:", err);
      appendLog(`Error sending review signal: ${err?.message || err}`, LOG_LEVELS.ERROR);
      showToast("failed to send review signal", "error");
    }
  };

  // =========================
  // Guardrail Modal (8.0)
  // =========================
  // The engine's soft cap (10k) and huge-run gate (20k) now ask this
  // page instead of raising confirm() in the backgrounded Gmail tab.
  // Its contract: it polls for a proceed/stop signal and stops the run
  // if nothing answers within five minutes. Silence is a refusal, so
  // every path out of this dialog that is not an explicit "continue"
  // has to send stop rather than nothing.

  const openGuardModal = (kind, count, actionWord) => {
    if (!ui.guardModal) return;

    const countText = formatNumber(count);
    const isArchive = actionWord === "archive";
    const countKnown = kind !== "unknownBulk";

    if (ui.guardCount) ui.guardCount.textContent = countKnown ? countText : "";
    // Inline display, not [hidden]: .guard-count carries its own display
    // in the stylesheet and would beat the UA rule at equal importance,
    // which is the trap popup.html needed a global [hidden] guard for.
    if (ui.guardCountRow) ui.guardCountRow.style.display = countKnown ? "" : "none";

    if (ui.guardLead) {
      if (kind === "unknownBulk") {
        // 8.12: Gmail offered "select all N that match", the engine took
        // it, and neither the toolbar counter nor the offer text gave up
        // a number. Naming the viewport count here would be the lie this
        // dialog exists to prevent, so it says what is actually known.
        // Two keys rather than one interpolated verb, matching the
        // archive/delete pair below: chrome.i18n has no way to inflect.
        ui.guardLead.textContent = isArchive
          ? t(
            "progGuardLeadUnknownArchive",
            "Gmail did not say how many conversations match. Every match will be archived, and that could be far more than the page you can see."
          )
          : t(
            "progGuardLeadUnknownDelete",
            "Gmail did not say how many conversations match. Every match will be deleted, and that could be far more than the page you can see."
          );
      } else if (kind === "hugeRun") {
        ui.guardLead.textContent = t(
          "progGuardLeadHuge",
          `About ${countText} conversations will be deleted.`,
          [countText]
        );
      } else if (isArchive) {
        ui.guardLead.textContent = t(
          "progGuardLeadArchive",
          `This run would archive about ${countText} conversations.`,
          [countText]
        );
      } else {
        ui.guardLead.textContent = t(
          "progGuardLeadDelete",
          `This run would delete about ${countText} conversations.`,
          [countText]
        );
      }
    }

    // The alternatives only make sense for the soft cap, which fires
    // before the run commits to anything; the huge-run gate is the
    // final yes/no on a delete already in motion.
    // 8.12: the unknown-total dialog gets them too. "Try a Dry Run, Safe
    // Mode, or a smaller set of rules" is the most useful thing anyone
    // can be told when the size of the run cannot be established.
    if (ui.guardAlternatives) {
      ui.guardAlternatives.hidden = kind !== "softCap" && kind !== "unknownBulk";
    }

    // Archived mail never reaches Trash, so the 30-day promise would be
    // a claim about something that is not going to happen.
    if (ui.guardTrashNote) ui.guardTrashNote.hidden = isArchive;

    state.guardOpen = true;
    try {
      ui.guardModal.showModal();
    } catch (err) {
      log("error", "Failed to show guardrail modal:", err);
    }
  };

  const closeGuardModal = () => {
    if (!ui.guardModal?.open) return;
    try {
      ui.guardModal.close();
    } catch {
      // ignore
    }
  };

  const sendGuardSignal = async (signal) => {
    if (!gmailTabId) {
      appendLog("Cannot send guardrail decision: Gmail tab ID missing", LOG_LEVELS.ERROR);
      return;
    }
    if (!GCC.hasChromeTabs()) {
      appendLog("Cannot send guardrail decision: chrome.tabs unavailable", LOG_LEVELS.ERROR);
      return;
    }

    try {
      const type = signal === "proceed" ? "gmailCleanerGuardProceed" : "gmailCleanerGuardStop";
      await GCC.promisify(chrome.tabs.sendMessage.bind(chrome.tabs), gmailTabId, { type });

      if (signal === "proceed") {
        appendLog("Guardrail decision: PROCEED", LOG_LEVELS.WARNING);
        setPhaseTag(PHASES.TAG);
        setStatusLoading("Continuing the run...");
      } else {
        appendLog("Guardrail decision: STOP", LOG_LEVELS.SUCCESS);
        setStatus("Stopping the run. Nothing further will be touched.");
      }
    } catch (err) {
      log("error", "Failed to send guardrail decision:", err);
      appendLog(`Error sending guardrail decision: ${err?.message || err}`, LOG_LEVELS.ERROR);
      showToast("failed to send guardrail decision", "error");
    }
  };

  // Single funnel for every way this dialog can end. Flipping the flag
  // before closing means the close event's own stop is a no-op after a
  // proceed, and a second dismissal can never contradict the first.
  const resolveGuard = (signal) => {
    if (!state.guardOpen) return;
    state.guardOpen = false;
    closeGuardModal();
    sendGuardSignal(signal);
  };

  // =========================
  // Storage Operations
  // =========================

  const saveStatsToStorage = async (stats) => {
    if (!GCC.hasChromeStorage("sync")) return;
    try {
      const finishedAt = Date.now();
      // Sync replicates to the user's browser account, and perQuery[].query
      // is the literal Gmail search: for a purge or a Smart apply that is a
      // list of sender addresses read out of their mailbox. Nothing renders
      // it, so the synced copy carries counts and labels only. The engine
      // strips the same field before its own write.
      const perQuery = Array.isArray(stats?.perQuery)
        ? stats.perQuery.map((entry) => ({
          label: entry?.label,
          count: entry?.count,
          mode: entry?.mode,
          durationMs: entry?.durationMs
        }))
        : stats?.perQuery;
      const statsToSave = { ...stats, perQuery, finishedAt };
      await GCC.promisify(chrome.storage.sync.set.bind(chrome.storage.sync), { lastRunStats: statsToSave });
    } catch (err) {
      log("warn", "Failed to save stats to storage:", err);
    }
  };

  const getLastConfig = async () => {
    // session first
    if (GCC.hasChromeStorage("session")) {
      try {
        const result = await GCC.promisify(chrome.storage.session.get.bind(chrome.storage.session), "lastConfig");
        if (result?.lastConfig) return result.lastConfig;
      } catch {
        // fall through
      }
    }

    // local fallback
    if (GCC.hasChromeStorage("local")) {
      try {
        const result = await GCC.promisify(chrome.storage.local.get.bind(chrome.storage.local), "lastConfig");
        return result?.lastConfig || null;
      } catch {
        // ignore
      }
    }

    return null;
  };

  // =========================
  // Done Handler
  // =========================

  const handleDone = (msg) => {
    state.done = true;
    stopAutoReconnect();
    const phase = msg.phase || PHASES.DONE;

    // A run that ended while the guardrail was still on screen has
    // already answered the question by ending; leaving the dialog up
    // would invite an answer to a run that no longer exists.
    resolveGuard("stop");

    setPhaseTag(phase);
    setPercent(msg.percent ?? 100);

    let cardShown = false;

    if (msg.stats) {
      renderStatsSummary(msg.stats);
      if (phase === PHASES.DONE) {
        cardShown = renderCompletionCard(msg.stats);
        saveStatsToStorage(msg.stats);
      }
    }

    updateButtonsForDone(phase, cardShown);

    const summary = msg.detail || "All queries processed.";
    appendLog(`Run finished: ${summary}`, LOG_LEVELS.SUCCESS);

    if (phase === PHASES.DONE) showToast("cleanup completed", "success");
    else if (phase === PHASES.CANCELLED) showToast("cleanup cancelled", "warning");
    else if (phase === PHASES.ERROR) showToast("cleanup ended with error", "error");
  };

  // =========================
  // Message Handler
  // =========================

  // 8.15: ownership check for the broadcast engine messages. A message
  // with no sending tab is not from an engine at all, and one from a
  // different Gmail tab belongs to a different run.
  const isMessageForThisRun = (sender) => {
    if (!gmailTabId) return false;
    const from = sender?.tab?.id;
    // A sender without a tab predates nothing in this extension: every
    // message this page handles is sent by contentScript.js. Refusing it
    // is the safe direction, since acting on it is what caused the bug.
    if (typeof from !== "number") return false;
    return from === gmailTabId;
  };

  const handleProgressMessage = (message) => {
    if (!message) return;

    // Anything that got past the ownership check came from the engine
    // in this page's Gmail tab, so a run demonstrably existed here.
    state.sawRunEvidence = true;

    // Review request
    if (message.type === "gmailCleanerRequestReview") {
      appendLog(`Review requested for: ${message.label || message.query || "(unknown)"}`, LOG_LEVELS.INFO);
      setPhaseTag(PHASES.REVIEW);
      setStatus("Waiting for your review...");
      openReviewModal(message.label, message.count, message.query);
      return;
    }

    // Guardrail request. The engine is blocked on the answer and will
    // stop the run if none arrives, so this cannot be queued behind
    // anything or dropped for want of a progress phase.
    if (message.type === "gmailCleanerRequestGuardrail") {
      const count = Number(message.count) || 0;
      const actionWord = message.actionWord === "archive" ? "archive" : "delete";
      // 8.12: the modal hides the number when the match total could not
      // be read, because quoting the visible page there is the lie the
      // dialog exists to prevent. The log line behind the modal was
      // printing that very number, so the figure the dialog refused to
      // state was sitting in the activity log the whole time.
      appendLog(
        message.guardKind === "unknownBulk"
          ? `Confirmation needed: Gmail did not report how many conversations this ${actionWord} would reach.`
          : `Confirmation needed: this run would ${actionWord} about ${formatNumber(count)} conversations.`,
        LOG_LEVELS.WARNING
      );
      setPhaseTag(PHASES.GUARDRAIL);
      setStatus("Waiting for your confirmation...");
      openGuardModal(message.guardKind, count, actionWord);
      return;
    }

    if (message.type !== "gmailCleanerProgress") return;

    // 7.0: subscriptions engine messages (runKind set) belong to the
    // popup's subscriptions panel, not this cleanup dashboard.
    if (message.runKind) return;

    // Track last message time for auto-reconnect
    state.lastMessageTime = Date.now();
    state.autoReconnectAttempts = 0;

    const { phase, status, detail, percent, stats } = message;

    // Status: show spinner for all active (non-terminal) phases
    const isActivePhase = phase && ![PHASES.DONE, PHASES.CANCELLED, PHASES.ERROR].includes(phase);
    if (status) {
      if (isActivePhase) setStatusLoading(status);
      else setStatus(status);

      appendLog(status + (detail ? ` - ${detail}` : ""), LOG_LEVELS.INFO);
    } else if (detail) {
      if (isActivePhase && !status) setStatusLoading(detail);
      appendLog(detail, LOG_LEVELS.INFO);
    }

    // Progress
    if (typeof percent === "number") setPercent(percent);

    // Phase
    if (phase) {
      state.lastPhase = phase;
      setPhaseTag(phase);
    }

    // Query finished -> table row
    if (phase === PHASES.QUERY_DONE) {
      const freedMb =
        Number(message.freedMb ?? message.freedMB ?? message.freed_mb ?? message.freed) ||
        (Number.isFinite(Number(message.freedBytes)) ? Number(message.freedBytes) / (1024 * 1024) : 0);

      state.rows.push({
        query: message.query || "",
        label: message.label || "",
        count: message.count || 0,
        mode: message.mode || stats?.mode || state.mode || "live",
        durationMs: message.durationMs ?? null,
        freedMb
      });

      renderRowsTable();
    }

    // Summary
    if (stats) renderStatsSummary(stats);

    // Completion
    if (message.done || phase === PHASES.DONE || phase === PHASES.CANCELLED || phase === PHASES.ERROR) {
      handleDone(message);
    }

    // Error detail logging
    if (phase === PHASES.ERROR) {
      if (ui.cancel) ui.cancel.disabled = true;
      appendLog(`Error details: ${detail || "unknown error"}`, LOG_LEVELS.ERROR);
    }

    if (phase === PHASES.CANCELLED) {
      appendLog("Run cancelled by user.", LOG_LEVELS.WARNING);
    }
  };

  // =========================
  // Button Handlers
  // =========================

  const handleCancel = async () => {
    if (!gmailTabId) {
      appendLog("Cannot cancel: Gmail tab ID missing.", LOG_LEVELS.ERROR);
      showToast("cannot cancel: no tab id", "error");
      return;
    }
    if (!GCC.hasChromeTabs()) {
      appendLog("Cannot cancel: chrome.tabs unavailable.", LOG_LEVELS.ERROR);
      showToast("cannot cancel: tabs unavailable", "error");
      return;
    }

    setButtonLoading(ui.cancel, true, "Cancelling…");
    appendLog("Sending cancel signal...", LOG_LEVELS.INFO);

    try {
      await GCC.promisify(chrome.tabs.sendMessage.bind(chrome.tabs), gmailTabId, { type: "gmailCleanerCancel" });
      appendLog(`Cancel signal sent to Gmail tab ${gmailTabId}.`, LOG_LEVELS.SUCCESS);
      showToast("cancel sent", "info");
    } catch (err) {
      log("error", "Failed to send cancel message:", err);
      appendLog(`Failed to send cancel message: ${err?.message || err}`, LOG_LEVELS.ERROR);
      showToast("failed to cancel", "error");
      setButtonLoading(ui.cancel, false);
    }
  };

  const handleReconnect = async () => {
    if (!gmailTabId) {
      appendLog("Cannot reconnect: Gmail tab ID missing.", LOG_LEVELS.ERROR);
      showToast("cannot reconnect: no tab id", "error");
      return;
    }
    if (!GCC.hasChromeTabs()) {
      appendLog("Cannot reconnect: chrome.tabs unavailable.", LOG_LEVELS.ERROR);
      showToast("cannot reconnect: tabs unavailable", "error");
      return;
    }
    if (state.isReconnecting) return;

    state.isReconnecting = true;
    setButtonLoading(ui.reconnect, true, "Reconnecting…");
    appendLog("Pinging Gmail content script…", LOG_LEVELS.INFO);

    try {
      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Reconnect timeout")), CONFIG.RECONNECT_TIMEOUT_MS);

        chrome.tabs.sendMessage(gmailTabId, { type: "gmailCleanerPing" }, (resp) => {
          clearTimeout(timeout);
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) reject(new Error(lastErr.message));
          else resolve(resp);
        });
      });

      if (!response?.ok) {
        appendLog("Reconnect: script responded but not ok.", LOG_LEVELS.WARNING);
        setStatus("Reconnect: script responded but not ok.");
        showToast("reconnect partial", "warning");
      } else {
        appendLog(`Reconnect OK. Phase: ${response.phase || "unknown"}`, LOG_LEVELS.SUCCESS);
        setStatus("Reconnected to Gmail tab.");
        showToast("reconnected", "success");
      }
    } catch (err) {
      log("error", "Reconnect error:", err);
      appendLog(`Reconnect failed: ${err?.message || err}`, LOG_LEVELS.ERROR);
      setStatus("Reconnect failed. Try Re-inject.");
      showToast("reconnect failed", "error");
    } finally {
      setButtonLoading(ui.reconnect, false);
      state.isReconnecting = false;
    }
  };

  // 8.4: clear a run that is not really there.
  //
  // Re-inject already existed but it STARTS a run, which is the wrong
  // tool when the complaint is "it says something is in progress and
  // nothing is". This clears the stored claim and the in-page attach
  // flag and stops, leaving the user free to start whatever they
  // actually wanted. This page is a real tab, so confirm() works here
  // (it is a silent no-op inside a popup, which is why the popup's
  // version of this arms a second click instead).
  const handleResetStuckRun = async () => {
    if (!GCC.hasChrome() || !chrome.runtime?.sendMessage) {
      appendLog("Cannot reset: extension messaging unavailable.", LOG_LEVELS.ERROR);
      showToast("cannot reset: messaging unavailable", "error");
      return;
    }

    setButtonLoading(ui.resetRun, true, "Resetting…");
    appendLog("Checking whether a run is really attached…", LOG_LEVELS.INFO);

    try {
      const first = await GCC.promisify(chrome.runtime.sendMessage.bind(chrome.runtime), {
        type: "gmailCleanerForceReset",
        tabId: gmailTabId ?? null,
        force: false
      });

      if (first?.reason === "engine_running") {
        appendLog("The cleaner answered: it is still running. Cancel sent.", LOG_LEVELS.WARNING);
        const proceed = confirm(
          "The cleaner answered and says it is still running, so it is busy rather than stuck.\n\n" +
          "It has just been told to cancel. Give it a few seconds and watch the log.\n\n" +
          "Clear the run anyway? Only do this if the log has been silent for minutes."
        );
        if (!proceed) {
          appendLog("Reset cancelled: the cleaner is still running.", LOG_LEVELS.INFO);
          return;
        }
        const forced = await GCC.promisify(chrome.runtime.sendMessage.bind(chrome.runtime), {
          type: "gmailCleanerForceReset",
          tabId: gmailTabId ?? null,
          force: true
        });
        if (forced?.tabActionFailed) {
          appendLog(
            "The Gmail tab would not take the reset, so nothing was cleared. Reload that tab yourself.",
            LOG_LEVELS.ERROR
          );
          showToast("could not reach the gmail tab", "error");
          return;
        }
        if (!forced?.ok) {
          appendLog(`Reset failed: ${forced?.error || "unknown error"}`, LOG_LEVELS.ERROR);
          showToast("reset failed", "error");
          return;
        }
        if (forced.stillRunning) {
          // Cancel landed but the engine outlasted the wait, so the tab
          // is deliberately still guarded. Reporting success here would
          // invite a second engine onto the same mailbox.
          appendLog(
            "Cancel sent, but the cleaner has not stopped yet. The Gmail tab is still held so nothing can start beside it. Watch the log and try again in a moment.",
            LOG_LEVELS.WARNING
          );
          setStatus("Cancelled, waiting for the cleaner to stop.");
          showToast("cancelled, not stopped yet", "warning");
          return;
        }
        appendLog("Run cleared. The cancel was sent first.", LOG_LEVELS.SUCCESS);
        setStatus("Run cleared. You can start a new one.");
        showToast("run cleared", "success");
        markRunOver();
        return;
      }

      if (!first?.ok) {
        appendLog(`Reset failed: ${first?.error || "unknown error"}`, LOG_LEVELS.ERROR);
        showToast("reset failed", "error");
        return;
      }

      if (first.tabActionFailed) {
        appendLog(
          "The Gmail tab is still open but would not take the reset, so nothing was cleared. Reload that tab yourself: it clears everything this button was trying to clear.",
          LOG_LEVELS.ERROR
        );
        setStatus("Could not reach the Gmail tab.");
        showToast("could not reach the gmail tab", "error");
        return;
      }

      if (first.cleared?.reloadedTab) {
        // The orphan case. Worth spelling out, because the user is
        // about to notice their Gmail tab reloading and should know it
        // was us and why.
        appendLog(
          "A cleaner was still attached to the Gmail tab but no longer answering, which happens when the extension reloads mid-run. It cannot be told to stop, so the tab was reloaded to stop it. The run claim is cleared.",
          LOG_LEVELS.SUCCESS
        );
        setStatus("Gmail tab reloaded. You can start a new run.");
        showToast("gmail tab reloaded, run cleared", "success");
        markRunOver();
        return;
      }

      const bits = [];
      if (first.cleared?.claim) bits.push("the stored run claim");
      if (first.cleared?.attachFlag) bits.push("the in-page attach flag");
      appendLog(
        bits.length ? `Cleared ${bits.join(" and ")}.` : "Nothing was being held.",
        LOG_LEVELS.SUCCESS
      );
      setStatus("Run cleared. You can start a new one.");
      showToast(bits.length ? "run cleared" : "nothing was stuck", "success");
      markRunOver();
    } catch (err) {
      log("error", "Reset error:", err);
      appendLog(`Reset failed: ${err?.message || err}`, LOG_LEVELS.ERROR);
      showToast("reset failed", "error");
    } finally {
      setButtonLoading(ui.resetRun, false);
    }
  };

  const handleReinject = async () => {
    if (!gmailTabId) {
      appendLog("Cannot re-inject: Gmail tab ID missing.", LOG_LEVELS.ERROR);
      showToast("cannot re-inject: no tab id", "error");
      return;
    }
    if (!GCC.hasChromeScripting()) {
      appendLog("Cannot re-inject: chrome.scripting unavailable.", LOG_LEVELS.ERROR);
      showToast("cannot re-inject: scripting unavailable", "error");
      return;
    }

    // Manual re-inject keeps the escape hatch for a genuinely dead
    // engine, but a still-attached one means a second pass over the
    // mailbox, so that costs an explicit yes. This page is a real tab,
    // not a popup, so confirm() is honoured on every browser.
    if (await isEngineAttached()) {
      const proceed = confirm(
        "The cleaner still looks attached to that Gmail tab, so it is probably busy rather than stuck.\n\n" +
        "Check the Gmail tab first: a large run pauses for a confirmation.\n\n" +
        "Re-injecting now can start a SECOND pass over the same mailbox. Continue anyway?"
      );
      if (!proceed) {
        appendLog("Re-inject cancelled: cleaner is still attached.", LOG_LEVELS.INFO);
        return;
      }
    }

    setButtonLoading(ui.reinject, true, "Re-injecting…");
    appendLog("Re-injecting cleaner into Gmail tab…", LOG_LEVELS.INFO);
    setStatusLoading("Re-injecting cleaner into Gmail tab…");

    try {
      // Clear the duplicate-injection guard so the script can re-attach
      await GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: gmailTabId },
        func: () => { window.GCC_ATTACHED = false; }
      });

      const cfg = await getLastConfig();

      if (cfg) {
        await GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), {
          target: { tabId: gmailTabId },
          func: (config) => {
            window.GMAIL_CLEANER_CONFIG = config || window.GMAIL_CLEANER_CONFIG || {};
          },
          args: [cfg]
        });
      }

      await GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: gmailTabId },
        files: ["contentScript.js"]
      });

      appendLog("Re-injected content script into Gmail tab.", LOG_LEVELS.SUCCESS);
      setStatus("Cleaner re-injected. It should resume sending progress shortly.");
      showToast("re-injected", "success");
    } catch (err) {
      log("error", "Re-inject error:", err);
      appendLog(`Re-inject error: ${err?.message || err}`, LOG_LEVELS.ERROR);
      setStatus("Re-inject failed. Close this and start a new run from the popup.");
      showToast("re-inject failed", "error");
    } finally {
      setButtonLoading(ui.reinject, false);
    }
  };

  // The old toggle only flipped the box between a 240px scroll and
  // full height, which read as doing nothing. Hide logs now folds the
  // whole section into a one-line strip that keeps the entry count
  // and the latest line in view (and is itself a click target to
  // bring the log back).
  const updateCollapsedLogsSummary = () => {
    const n = state.logHistory.length;
    if (ui.logsCollapsedCount) {
      ui.logsCollapsedCount.textContent = `${n} ${n === 1 ? "entry" : "entries"}`;
    }
    if (ui.logsCollapsedLast) {
      ui.logsCollapsedLast.textContent =
        state.logHistory[n - 1] || "No activity yet";
    }
    if (ui.toggleLogs && !state.logsVisible) {
      ui.toggleLogs.textContent = `Show logs (${n})`;
    }
  };

  const renderLogsVisibility = () => {
    if (!ui.logsContainer || !ui.toggleLogs) return;
    ui.logsContainer.classList.toggle("collapsed", !state.logsVisible);
    ui.toggleLogs.setAttribute("aria-pressed", state.logsVisible ? "true" : "false");
    if (state.logsVisible) {
      ui.toggleLogs.textContent = "Hide logs";
    } else {
      updateCollapsedLogsSummary();
    }
  };

  const handleToggleLogs = () => {
    if (!ui.logsContainer || !ui.toggleLogs) return;
    state.logsVisible = !state.logsVisible;
    renderLogsVisibility();
    // Reopening lands pinned to the newest line, like a live tail.
    if (state.logsVisible && ui.details) {
      ui.details.scrollTop = ui.details.scrollHeight;
    }
  };

  // =========================
  // Keyboard Shortcuts
  // =========================

  const setupKeyboardShortcuts = () => {
    document.addEventListener("keydown", (e) => {
      // Escape
      if (e.key === "Escape") {
        // The dialog's own close event routes to stop, so this branch
        // only has to keep Escape from falling through to handleCancel.
        if (ui.guardModal?.open) return;

        if (ui.reviewModal?.open) {
          closeReviewModal();
          sendReviewSignal("skip");
          return;
        }
        if (!state.done && ui.cancel && !ui.cancel.disabled) {
          handleCancel();
          return;
        }
      }

      // Ctrl/Cmd + Shift + C copy logs (avoids hijacking normal copy)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        copyLogs();
      }

      // Enter in review modal -> proceed
      if (e.key === "Enter" && ui.reviewModal?.open) {
        e.preventDefault();
        closeReviewModal();
        sendReviewSignal("resume");
      }
    });
  };

  // =========================
  // Auto-Reconnect
  // =========================

  const stopAutoReconnect = () => {
    if (state.autoReconnectTimer) {
      clearInterval(state.autoReconnectTimer);
      state.autoReconnectTimer = null;
    }
  };

  // 8.15: "there is no run here any more", said once so every caller
  // gets both halves. Reset Stuck Run clears the attach flag in the
  // Gmail tab, which is the exact signal auto-reconnect reads as "the
  // engine is gone, put it back": pressing Reset and walking away armed
  // a full unattended cleanup a minute later, from the last stored
  // config. The terminal-message path has done this since 7.x; the
  // reset path never did.
  const markRunOver = () => {
    state.done = true;
    stopAutoReconnect();
  };

  // Is the engine still in that tab? Re-injecting while it is would run
  // a SECOND pass over the same mailbox: double deletes, doubled stats,
  // two engines fighting over Gmail's UI. A silent run is not proof it
  // died; the soft-cap confirm() blocks the Gmail tab's JS entirely, so
  // a busy engine stops answering pings while very much alive.
  // Anything other than a definite "false" counts as still attached,
  // because not re-injecting is always the recoverable direction.
  const isEngineAttached = async () => {
    if (!gmailTabId || !GCC.hasChromeScripting()) return true;
    try {
      const results = await GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: gmailTabId },
        func: () => !!window.GCC_ATTACHED
      });
      return results?.[0]?.result !== false;
    } catch {
      return true;
    }
  };

  const autoReconnectTick = async () => {
    if (state.done || state.isReconnecting || !gmailTabId) return;

    const elapsed = Date.now() - state.lastMessageTime;
    if (elapsed < CONFIG.AUTO_RECONNECT_STALE_MS) return;

    if (state.autoReconnectAttempts >= CONFIG.MAX_AUTO_RECONNECT_ATTEMPTS) {
      appendLog("Auto-reconnect: max attempts reached. Use manual buttons.", LOG_LEVELS.WARNING);
      stopAutoReconnect();
      return;
    }

    state.autoReconnectAttempts++;
    state.isReconnecting = true;
    log("info", `Auto-reconnect attempt ${state.autoReconnectAttempts}/${CONFIG.MAX_AUTO_RECONNECT_ATTEMPTS}`);
    appendLog(`Auto-reconnecting… (attempt ${state.autoReconnectAttempts})`, LOG_LEVELS.INFO);
    setStatusLoading("Auto-reconnecting…");

    // Step 1: Try pinging the existing content script
    try {
      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), CONFIG.RECONNECT_TIMEOUT_MS);
        chrome.tabs.sendMessage(gmailTabId, { type: "gmailCleanerPing" }, (resp) => {
          clearTimeout(timeout);
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) reject(new Error(lastErr.message));
          else resolve(resp);
        });
      });

      if (response?.ok) {
        // An answer is activity. Without this, elapsed stayed stale and
        // the tick fired again immediately, resetting the attempt counter
        // every time so the max was never reached either: an endless
        // "auto-reconnecting / still alive" loop for the life of the tab.
        state.lastMessageTime = Date.now();
        state.autoReconnectAttempts = 0;
        state.isReconnecting = false;

        // An idle engine is not a run waiting to resume, it is a run that
        // already finished. No progress is ever going to arrive, so stop
        // polling for it and leave the manual buttons in charge.
        if (response.phase === "idle") {
          appendLog(
            "Auto-reconnect: the cleaner is attached but idle, so this run is already over.",
            LOG_LEVELS.INFO
          );
          setStatus("Cleaner idle. Use Reconnect or Re-inject to start another pass.");
          stopAutoReconnect();
          return;
        }

        appendLog("Auto-reconnect: content script is alive.", LOG_LEVELS.SUCCESS);
        setStatusLoading("Reconnected, waiting for progress…");
        return;
      }
    } catch {
      // Ping failed, try re-injecting
    }

    // Step 2: Re-inject the content script
    if (!GCC.hasChromeScripting()) {
      appendLog("Auto-reconnect: scripting unavailable, cannot re-inject.", LOG_LEVELS.ERROR);
      state.isReconnecting = false;
      return;
    }

    // 8.15: re-injection is not a reconnect, it starts the cleaner
    // again from the stored config. That is the right thing to do for a
    // run that went quiet, and the wrong thing on a page that has never
    // heard from one: a dashboard opened for a run that failed to
    // inject, or one whose run was cleared by Reset, would sit there and
    // then start a full sweep on its own a minute later. Silence with
    // no run behind it stays silence.
    if (!state.sawRunEvidence) {
      appendLog(
        "Auto-reconnect: no run has reported to this page, so there is nothing to reconnect to. Use Re-inject if you meant to start one.",
        LOG_LEVELS.WARNING
      );
      setStatus("No run reported here. Use Reconnect or Re-inject.");
      stopAutoReconnect();
      state.isReconnecting = false;
      return;
    }

    // Silence is not death. An engine that is merely busy, or parked on
    // the soft-cap confirmation in the Gmail tab, still holds the tab;
    // re-injecting over it would start a second pass on the mailbox.
    if (await isEngineAttached()) {
      appendLog(
        "Auto-reconnect: the cleaner is still attached to the Gmail tab, so it is busy rather than gone. Check that tab for a confirmation dialog. Not re-injecting automatically.",
        LOG_LEVELS.WARNING
      );
      setStatus("Cleaner still attached. Check the Gmail tab for a prompt.");
      stopAutoReconnect();
      state.isReconnecting = false;
      return;
    }

    try {
      // Clear the duplicate-injection guard so the script can re-attach
      await GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: gmailTabId },
        func: () => { window.GCC_ATTACHED = false; }
      });

      const cfg = await getLastConfig();

      if (cfg) {
        await GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), {
          target: { tabId: gmailTabId },
          func: (config) => {
            window.GMAIL_CLEANER_CONFIG = config || window.GMAIL_CLEANER_CONFIG || {};
          },
          args: [cfg]
        });
      }

      await GCC.promisify(chrome.scripting.executeScript.bind(chrome.scripting), {
        target: { tabId: gmailTabId },
        files: ["contentScript.js"]
      });

      appendLog("Auto-reconnect: re-injected content script.", LOG_LEVELS.SUCCESS);
      setStatusLoading("Re-injected, waiting for progress…");
      showToast("auto-reconnected", "success");
    } catch (err) {
      appendLog(`Auto-reconnect failed: ${err?.message || err}`, LOG_LEVELS.ERROR);
      if (state.autoReconnectAttempts >= CONFIG.MAX_AUTO_RECONNECT_ATTEMPTS) {
        setStatus("Auto-reconnect failed. Try manual Reconnect / Re-inject.");
        showToast("auto-reconnect failed", "error");
      }
    } finally {
      state.isReconnecting = false;
    }
  };

  const startAutoReconnect = () => {
    stopAutoReconnect();
    state.autoReconnectAttempts = 0;
    state.lastMessageTime = Date.now();
    state.autoReconnectTimer = setInterval(autoReconnectTick, CONFIG.AUTO_RECONNECT_INTERVAL_MS);
  };

  // =========================
  // Event Listeners
  // =========================

  const wireEventListeners = () => {
    ui.cancel?.addEventListener("click", handleCancel);
    ui.reconnect?.addEventListener("click", handleReconnect);
    ui.reinject?.addEventListener("click", handleReinject);
    ui.resetRun?.addEventListener("click", handleResetStuckRun);
    ui.toggleLogs?.addEventListener("click", handleToggleLogs);
    ui.logsCollapsedBar?.addEventListener("click", handleToggleLogs);

    ui.copyLogsBtn?.addEventListener("click", copyLogs);
    ui.clearLogsBtn?.addEventListener("click", clearLogs);
    ui.logFilter?.addEventListener("input", (e) => filterLogs(e.target.value));

    ui.modalProceedBtn?.addEventListener("click", () => {
      closeReviewModal();
      sendReviewSignal("resume");
    });

    ui.modalSkipBtn?.addEventListener("click", () => {
      closeReviewModal();
      sendReviewSignal("skip");
    });

    ui.reviewModal?.addEventListener("click", (e) => {
      if (e.target === ui.reviewModal) {
        closeReviewModal();
        sendReviewSignal("skip");
      }
    });

    ui.guardProceedBtn?.addEventListener("click", () => resolveGuard("proceed"));
    ui.guardStopBtn?.addEventListener("click", () => resolveGuard("stop"));

    // Backdrop click and Escape both mean stop. The close listener is
    // the backstop: whatever dismisses this dialog, the engine hears a
    // decision rather than waiting out its five-minute timeout.
    ui.guardModal?.addEventListener("click", (e) => {
      if (e.target === ui.guardModal) resolveGuard("stop");
    });
    ui.guardModal?.addEventListener("close", () => resolveGuard("stop"));

    ui.openRecoveryBtn?.addEventListener("click", () => {
      openInNewTab(recoveryLogUrl());
    });

    ui.copyReceiptBtn?.addEventListener("click", handleCopyReceipt);

    ui.doneRateBtn?.addEventListener("click", () => {
      // Reviews land on the store this browser installed from, so the
      // Firefox build never sends anyone to the Chrome Web Store.
      openInNewTab(GCC.storeLinks().reviews);
      if (ui.doneRating) ui.doneRating.hidden = true;
    });

    // "Not now" is deliberately page-scoped: the popup owns the
    // persistent rating state, and this page should not be able to
    // silence an ask it did not schedule.
    ui.doneRateDismiss?.addEventListener("click", () => {
      if (ui.doneRating) ui.doneRating.hidden = true;
    });

    setupKeyboardShortcuts();

    if (GCC.hasChrome() && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender) => {
        try {
          // 8.15: this page is the dashboard for ONE Gmail tab, and the
          // engine broadcasts to every extension page. A finished
          // dashboard left open for account A therefore adopted account
          // B's run: B's per-query rows appended to A's table, B's
          // totals repainted A's summary, and both pages raised B's
          // guardrail dialog. Answering on the wrong one posted the
          // reply to tab A, whose engine was long gone, so run B waited
          // out its timeout and stopped after the user had clicked
          // Continue. Every one of these three message types comes from
          // a content script, so the sending tab settles ownership.
          if (!isMessageForThisRun(sender)) return;
          handleProgressMessage(msg);
        } catch (err) {
          log("error", "Error handling progress message:", err);
        }
      });
    }
  };

  // =========================
  // Initialization
  // =========================

  // 5.0: theme switcher wiring shared across all extension pages.
  const wireThemeSwitcher = async () => {
    const root = document.getElementById("themeSwitcher");
    if (!root) return;
    const current = await GCC.theme.get();
    for (const btn of root.querySelectorAll("button[data-theme-value]")) {
      btn.setAttribute("aria-pressed", btn.dataset.themeValue === current ? "true" : "false");
      btn.addEventListener("click", async () => {
        const applied = await GCC.theme.set(btn.dataset.themeValue);
        root.querySelectorAll("button[data-theme-value]").forEach((b) => {
          b.setAttribute("aria-pressed", b.dataset.themeValue === applied ? "true" : "false");
        });
      });
    }
  };

  const init = async () => {
    log("info", `Progress page v${PROGRESS_VERSION} initializing...`);

    // 8.0: swap the inline English for catalog messages before anything
    // reads or clones markup text. No-ops outside a real extension
    // context, so tests and the plain HTTP render harness stay English.
    GCC.i18n.apply(document);

    await GCC.theme.init();
    wireThemeSwitcher();

    if (ui.versionPill) ui.versionPill.textContent = `v${PROGRESS_VERSION}`;

    // Logs start visible; the button and the collapsed strip both
    // render from the same state.
    renderLogsVisibility();

    // Wire controls before the bad-URL bail-out below so the log
    // tools (hide, filter, copy) still work on the error screen; the
    // run buttons get disabled there anyway.
    wireEventListeners();

    if (!gmailTabId) {
      setStatus("Could not read Gmail tab ID from URL. Close this and try again.");
      appendLog("Missing or invalid gmailTabId in query string.", LOG_LEVELS.ERROR);

      if (ui.cancel) ui.cancel.disabled = true;
      if (ui.reconnect) ui.reconnect.disabled = true;
      if (ui.reinject) ui.reinject.disabled = true;

      showToast("missing gmail tab id", "error");
      return;
    }

    setPhaseTag(PHASES.STARTING);
    setPercent(0);

    setStatusLoading(`Waiting for Gmail tab ${gmailTabId} to send progress…`);
    appendLog(`Connected to Gmail tab ${gmailTabId}`, LOG_LEVELS.INFO);

    startAutoReconnect();

    log("info", "Progress page ready.");
  };

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
