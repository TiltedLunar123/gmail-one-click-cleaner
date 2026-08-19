// background.js: Service Worker (Manifest V3)
// Handles: scheduled cleanups, messaging coordination, undo/backup, stats persistence

(() => {
  "use strict";

  const SW_VERSION = "8.18.1";

  // =========================
  // Storage Keys
  // =========================

  const STORAGE_KEYS = Object.freeze({
    SCHEDULES: "schedules",
    STATS: "cleanupStats",
    UNDO_LOG: "undoLog",
    ACTIVE_RUN: "activeRun",
    WHITELIST: "whitelist",
    PROTECT_KEYWORDS: "protectKeywords",
    SNOOZE_UNTIL: "snoozeUntil",
    NOTIFY_ENABLED: "notifyOnComplete",
    SUBSCRIPTIONS: "subscriptionScan",
    STORAGE_XRAY: "storageXray",
    XRAY_PENDING: "storageXrayPendingPurge",
    LAYOUT_CHANGE: "layoutChangeNotice",
    SMART_SCAN: "smartScan",
    SMART_FEEDBACK: "smartFeedback",
    SMART_PENDING: "smartPendingApply",
    AUTOPILOT: "autoPilot",
    AUTOPILOT_STATE: "autoPilotState",
    INSTALL_SOURCE: "installSource",
    // 8.0 mailbox report. Local only, never sync: it is derived from the
    // mailbox (counts and sender addresses), and sync replicates to the
    // Google or Mozilla account. Same reasoning as 7.15's query strip.
    REPORT: "mailboxReport",
    REPORT_PENDING: "reportPendingPurge",

    // 8.9: the version whose release notes were last opened in THIS
    // browser. Local, not sync: reading the notes on one machine should
    // not silence the update dot on another.
    CHANGELOG_SEEN: "changelogSeenVersion",

    // 8.11: the popup's own switch positions, written by
    // persistLastConfig. Read here so the Auto-Pilot scan can measure
    // suggestions through the guards the popup's buttons will apply.
    LAST_UI: "lastUiSnapshot",

    // 8.12: the Pro-only knobs (recovery label, Auto-Pilot interval,
    // Smart scan depth). Sync, because they are preferences and belong
    // with the licence that unlocks them. Read only through
    // readProSettings below, which applies the same defaults-when-not-Pro
    // rule as GCC.proSettings.effective in shared.js.
    PRO_SETTINGS: "proSettings",

    // 8.14: how many times the completion notification has carried the
    // Pro line, and when it last did. Local: an ad allowance is not a
    // preference and has no business replicating to other machines.
    PRO_PITCH: "proPitchNotice",

    // 8.17's three free unsubscribes. Local, no clock, no server. 8.19
    // moved the SPEND here from the popup: see chargeFreeUnsubscribes.
    // The spelling is pinned equal to GCC.freeUnsub.KEY by a test.
    FREE_UNSUB_USED: "freeUnsubUsed"
  });

  // =========================
  // Localization helper (7.13)
  // =========================
  // The worker is self-contained (no shared.js), so it carries its own
  // tiny chrome.i18n wrapper with inline-English fallback, mirroring
  // GCC.i18n.t the way the license verifier mirrors GCC.license.

  function bgT(key, fallback, subs) {
    try {
      const msg = chrome.i18n?.getMessage?.(key, subs);
      if (msg) return msg;
    } catch {
      // fall through to the fallback
    }
    return fallback;
  }

  // =========================
  // Install source guard (7.13)
  // =========================
  // chrome.management.getSelf needs no permission. "sideload"/"other"
  // means this copy was planted by third-party software rather than
  // installed from a store, unpacked by a developer, or deployed by
  // enterprise policy -- the exact channel behind bot-farm user
  // inflation and repack distribution. Untrusted copies never run
  // unattended work (schedules, Auto-Pilot); manual, user-present runs
  // stay available. Unknown errs toward trusted.

  const UNTRUSTED_INSTALL_TYPES = Object.freeze(["sideload", "other"]);

  function isUntrustedInstallType(type) {
    return UNTRUSTED_INSTALL_TYPES.includes(String(type || ""));
  }

  async function getInstallType() {
    try {
      if (!chrome.management?.getSelf) return "unknown";
      const info = await new Promise((resolve) => {
        try {
          chrome.management.getSelf((i) => {
            const err = chrome.runtime?.lastError;
            resolve(err ? null : i);
          });
        } catch {
          resolve(null);
        }
      });
      return info?.installType || "unknown";
    } catch {
      return "unknown";
    }
  }

  // Cache for the popup and diagnostics pages (they read the same key
  // via GCC.installSource when the live API is unavailable).
  // =========================
  // Uninstall page (8.9)
  // =========================
  // The browser opens this after the extension is removed. Two things
  // it is for, in order of how often they matter: telling Pro buyers
  // their lifetime key survives the uninstall and where to get it
  // reissued, and answering the four things people actually leave over
  // (Gmail changed its layout, the guards spared more than expected,
  // something went to Trash, the popup felt busy).
  //
  // The URL carries NO parameters. No id, no version, no install
  // source, nothing derived from the mailbox. The browser navigating to
  // a fixed address is the entire mechanism, and adding a query string
  // is how that would quietly turn into telemetry.
  const UNINSTALL_URL = "https://gmail-cleaner-pro.netlify.app/uninstall.html";

  function setUninstallPage() {
    try {
      chrome.runtime.setUninstallURL?.(UNINSTALL_URL, () => {
        // Reading lastError keeps Chrome from logging an unchecked one.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      console.warn("[GCC SW] uninstall page not set:", e?.message || e);
    }
  }

  // 8.9: see STORAGE_KEYS.CHANGELOG_SEEN.
  async function markChangelogSeen() {
    try {
      const version = chrome.runtime.getManifest?.()?.version || SW_VERSION;
      await chrome.storage.local.set({ [STORAGE_KEYS.CHANGELOG_SEEN]: version });
    } catch (e) {
      console.warn("[GCC SW] changelog marker write failed:", e?.message || e);
    }
  }

  async function refreshInstallSource() {
    const installType = await getInstallType();
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.INSTALL_SOURCE]: { installType, at: Date.now() }
      });
    } catch (e) {
      console.warn("[GCC SW] install source cache write failed:", e?.message || e);
    }
    return installType;
  }

  async function isUntrustedInstall() {
    return isUntrustedInstallType(await getInstallType());
  }

  // chrome.storage.sync caps: 8KB per item, 102KB total. The options
  // page enforces this for rules; this helper duplicates the check for
  // anything the SW writes (schedules, whitelist edits). Issue #10.
  const SYNC_LIMIT_ITEM = 8192;

  function estimateBytes(obj) {
    try { return new Blob([JSON.stringify(obj ?? null)]).size; }
    catch { return (JSON.stringify(obj ?? null) || "").length * 2; }
  }

  async function safeSyncSet(data, label = "data") {
    for (const [key, value] of Object.entries(data || {})) {
      const size = estimateBytes({ [key]: value });
      if (size > SYNC_LIMIT_ITEM) {
        throw new Error(`${label} too large for sync (${Math.round(size / 1024)}KB, max 8KB)`);
      }
    }
    await chrome.storage.sync.set(data);
  }

  // Serialize read-modify-write operations against chrome.storage.local.
  // recordStats / recordUndoEntry / recordSenderHits each do
  // get -> mutate -> set, and the content
  // script fires several of them per pass. Run concurrently, their gets
  // read stale data and their sets clobber one another (lost updates).
  // Chaining each through this queue guarantees one completes before the
  // next reads.
  let _storageChain = Promise.resolve();
  function withStorageLock(fn) {
    const next = _storageChain.then(fn, fn);
    // Keep the chain alive even if fn rejects.
    _storageChain = next.then(() => {}, () => {});
    return next;
  }

  // =========================
  // Alarm Names
  // =========================

  const ALARM_PREFIX = "gcc_schedule_";
  const STATS_CLEANUP_ALARM = "gcc_stats_cleanup";
  const AUTOPILOT_ALARM = "gcc_autopilot";

  // =========================
  // Lifecycle
  // =========================

  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(`[GCC SW] Installed/Updated (${details.reason}), v${SW_VERSION}`);

    // Set up periodic stats cleanup alarm (once per day)
    chrome.alarms.create(STATS_CLEANUP_ALARM, { periodInMinutes: 1440 });

    await refreshInstallSource();
    setUninstallPage();

    // A brand new install has nothing to catch up on, so the release
    // notes count as read. On an UPDATE the marker is deliberately left
    // alone: an absent or older one is what puts the dot on the popup's
    // version button.
    if (details.reason === "install") await markChangelogSeen();

    // Restore saved schedules
    await restoreScheduledAlarms();
    await restoreAutoPilotAlarm();
  });

  chrome.runtime.onStartup.addListener(async () => {
    console.log("[GCC SW] Browser startup");
    await refreshInstallSource();
    setUninstallPage();
    await restoreScheduledAlarms();
    await restoreAutoPilotAlarm();
  });

  // Clean up ACTIVE_RUN if the Gmail tab is closed mid-run
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    try {
      // session.get resolves to {} when the key is absent, which is truthy,
      // so a `||` here never reached local at all. Claims land in local
      // whenever the session write fails, and those were the ones this
      // cleanup existed to catch. Read both, same as hasActiveRun().
      const sess = await chrome.storage.session?.get?.(STORAGE_KEYS.ACTIVE_RUN);
      const local = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_RUN);
      const run = sess?.[STORAGE_KEYS.ACTIVE_RUN] || local?.[STORAGE_KEYS.ACTIVE_RUN];
      if (run && run.gmailTabId === tabId) {
        console.log("[GCC SW] Gmail tab closed, clearing ACTIVE_RUN");
        // 8.9: compare-and-release rather than a blind clear. Between
        // the read above and the write, another run can take the claim,
        // and wiping that one lets a second unattended run start while
        // the first engine is still working. Both helpers re-read.
        if (run.runId) await releaseRunClaim(run.runId);
        else await releaseRunClaimForTab(tabId);
      }

      // 8.11: ACTIVE_RUN was the only thing this cleared, and the
      // Auto-Pilot scan stage never takes an ACTIVE_RUN claim at all.
      // Close the Gmail tab mid-sweep and the engine dies without ever
      // sending a terminal message, so `pending` sat armed for its full
      // two-hour TTL and every weekly alarm in that window logged
      // "previous sweep still pending, skipping". The Pro feature was
      // wedged by closing a tab, and the popup meanwhile reported a
      // sweep that was running right now.
      // 8.12: and the read has to be inside the lock, not just the
      // write. setAutoPilotState is an unlocked get-merge-set, so this
      // pair was the last remaining writer of the key doing its
      // get-merge-set outside the queue: closing the Gmail tab as a
      // sweep finished could merge into a snapshot taken before
      // resolveAutoPilotDone wrote, putting the previous lastRun back
      // and wiping the preview tally the popup asks the user to confirm.
      // The exact half-fix 8.10 caught on setAutoPilotEnabled and 8.11
      // caught on its local twin. releaseRunClaim above does not hold
      // the chain, so this cannot deadlock.
      await withStorageLock(async () => {
        const apState = await getAutoPilotState();
        if (apState?.pending && Number(apState.pending.tabId) === tabId) {
          console.log("[GCC SW] Gmail tab closed mid Auto-Pilot sweep, clearing pending stage");
          await setAutoPilotState({ pending: null });
        }
      });
    } catch (e) {
      console.error("[GCC SW] tabs.onRemoved cleanup failed:", e);
    }
  });

  // =========================
  // Alarm Handler (Scheduled Cleanups)
  // =========================

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === STATS_CLEANUP_ALARM) {
      await pruneOldStats();
      return;
    }

    if (alarm.name === AUTOPILOT_ALARM) {
      await runAutoPilot();
      return;
    }

    if (alarm.name.startsWith(ALARM_PREFIX)) {
      const scheduleId = alarm.name.replace(ALARM_PREFIX, "");
      await runScheduledCleanup(scheduleId);
    }
  });

  async function restoreScheduledAlarms() {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
      const schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];

      // Clear old alarms and recreate
      const existingAlarms = await chrome.alarms.getAll();
      for (const alarm of existingAlarms) {
        if (alarm.name.startsWith(ALARM_PREFIX)) {
          await chrome.alarms.clear(alarm.name);
        }
      }

      const now = Date.now();
      // Two schedules that are both overdue used to be armed for the
      // identical millisecond, so Chrome delivered both alarms in one
      // tick. Each run then read the claim before the other wrote it,
      // both injected into the same Gmail tab, and the second config
      // overwrote the first: one schedule's alarm quietly ran the other
      // schedule's action and intensity, and both recorded a lastRun.
      // Spacing the catch-up fires apart lets the claim do its job.
      const CATCH_UP_STAGGER_MS = 90 * 1000;
      let overdueSlot = 0;
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        const alarmName = ALARM_PREFIX + schedule.id;
        const periodMinutes = schedule.intervalMinutes || 10080; // default weekly
        // chrome.alarms.create resets the period timer on every call, so
        // recreating alarms on each startup/install would perpetually
        // defer a long interval on machines that restart often. Anchor
        // the next fire to lastRun + interval instead. Overdue schedules
        // fire shortly; brand-new ones fire ~1 min out.
        const lastRun = Number(schedule.lastRun) || 0;
        const nextDue = lastRun ? lastRun + periodMinutes * 60 * 1000 : now + 60 * 1000;
        const catchUpAt = now + 60 * 1000 + overdueSlot * CATCH_UP_STAGGER_MS;
        if (nextDue <= now) overdueSlot += 1;
        chrome.alarms.create(alarmName, {
          when: nextDue > now ? nextDue : catchUpAt,
          periodInMinutes: periodMinutes
        });
      }

      console.log(`[GCC SW] Restored ${schedules.filter(s => s.enabled).length} scheduled alarms`);
    } catch (e) {
      console.error("[GCC SW] Failed to restore alarms", e);
    }
  }

  // 8.16: null means "could not read", which is not the same as 0 ("not
  // snoozed"). Snooze is the switch a user flips before going away, and the
  // only thing it governs is work that happens while nobody is watching, so
  // a read that failed must not be answered with permission to sweep. The
  // two unattended callers below treat null as snoozed and skip; the popup's
  // status query passes it through, because telling someone they are
  // snoozed when the read failed would be its own lie.
  async function getSnoozeUntil() {
    try {
      const r = await chrome.storage.local.get(STORAGE_KEYS.SNOOZE_UNTIL);
      const v = Number(r?.[STORAGE_KEYS.SNOOZE_UNTIL] || 0);
      return Number.isFinite(v) && v > Date.now() ? v : 0;
    } catch { return null; }
  }

  // The question the three unattended callers are actually asking. An
  // unreadable snooze counts as snoozed: skipping a sweep costs one
  // interval, and sweeping through somebody's holiday is the thing snooze
  // exists to prevent.
  async function snoozeBlocksUnattended() {
    const until = await getSnoozeUntil();
    if (until === null) return { blocked: true, until: null, readable: false };
    return { blocked: until > 0, until, readable: true };
  }

  async function hasActiveRun() {
    try {
      const sess = await chrome.storage.session?.get?.(STORAGE_KEYS.ACTIVE_RUN);
      const local = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_RUN);
      const run = sess?.[STORAGE_KEYS.ACTIVE_RUN] || local?.[STORAGE_KEYS.ACTIVE_RUN] || null;
      if (!run || typeof run !== "object" || !run.gmailTabId || !run.startedAt) return null;
      // TTL guard: 2h, same as popup. Stale entries are cleared.
      //
      // 8.9: through releaseRunClaim, so the claim that gets dropped is
      // the one that was actually observed as expired. Reading, then
      // clearing unconditionally, wiped whatever claim happened to be
      // there by the time the write landed, and a fresh claim written in
      // that window is precisely the thing this must not touch.
      if (Date.now() - run.startedAt > 1000 * 60 * 60 * 2) {
        if (run.runId) await releaseRunClaim(run.runId);
        else await releaseRunClaimForTab(run.gmailTabId);
        return null;
      }
      return run;
    } catch { return null; }
  }

  // True when the engine is already running in that tab. Auxiliary runs
  // (subscription / storage / smart scans, restores) attach without ever
  // claiming ACTIVE_RUN, so hasActiveRun() alone cannot see them: an
  // unattended run would claim the marker, inject into an attached tab,
  // get ignored by the content script's duplicate guard, and then strand
  // that claim for the whole 2h TTL because no gmailCleanerDone follows.
  // A tab that cannot answer reads as attached, because refusing to
  // start is always the safe direction for an unattended run.
  async function isEngineAttached(tabId) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!window.GCC_ATTACHED
      });
      return result?.result !== false;
    } catch {
      return true;
    }
  }

  // Take the run marker, then check it is still ours.
  //
  // 8.9: the worker used to write the claim and carry on. The popup has
  // verified since 8.4, and the worker needs it more, not less: both
  // unattended paths check hasActiveRun early, then await tab lookup,
  // license verification and an attach probe before writing, and two
  // writers landing in that window leaves the loser convinced it holds
  // a claim it does not. Its own release then no-ops (the ids differ)
  // and a failed injection on the winner's side clears the marker while
  // the loser's engine is still cleaning, which is how two unattended
  // sweeps end up on one mailbox.
  async function claimRun(claim) {
    if (!claim?.runId) return false;
    if (await hasActiveRun()) return false;
    try {
      await chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: claim });
    } catch {
      // session is best effort; local below is the one that must land.
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: claim });
    // Same settle window the popup uses. Long enough for a competing
    // write to land, short enough to cost an unattended run nothing.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const held = await hasActiveRun();
    return held?.runId === claim.runId;
  }

  // Drop the run marker, but only when it is still the one we wrote.
  // Clearing unconditionally would wipe a claim that some other run
  // took in the meantime.
  async function releaseRunClaim(runId) {
    if (!runId) return;
    try {
      // The claim is written to session first, then local, and the session
      // write is allowed to fail silently. Checking local alone therefore
      // missed session-only claims and left them to rot for the full TTL,
      // even though hasActiveRun() reads session first and would keep
      // refusing every run on the strength of them.
      const sess = await chrome.storage.session?.get?.(STORAGE_KEYS.ACTIVE_RUN);
      const local = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_RUN);
      const held = sess?.[STORAGE_KEYS.ACTIVE_RUN] || local?.[STORAGE_KEYS.ACTIVE_RUN];
      if (held?.runId !== runId) return;
      await chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: null });
      await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null });
    } catch {}
  }

  // Release for an engine that finished without a run id. Only clears a
  // claim that belongs to the same Gmail tab, so a scan finishing in one
  // account cannot unlock a cleanup running in another.
  async function releaseRunClaimForTab(tabId) {
    if (typeof tabId !== "number") return;
    try {
      const sess = await chrome.storage.session?.get?.(STORAGE_KEYS.ACTIVE_RUN);
      const local = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_RUN);
      const held = sess?.[STORAGE_KEYS.ACTIVE_RUN] || local?.[STORAGE_KEYS.ACTIVE_RUN];
      if (held && held.gmailTabId !== tabId) return;
      await chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: null });
      await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null });
    } catch {}
  }

  // Ask the engine in a tab whether it is actually working. Distinct
  // from isEngineAttached, which reads the attach flag and treats an
  // unanswerable tab as busy: this wants the engine's own account of
  // itself, and "no answer" here means the engine is gone.
  async function probeEngine(tabId) {
    if (typeof tabId !== "number") return { reachable: false, running: false };
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "gmailCleanerPing" });
      if (!resp?.ok) return { reachable: false, running: false };
      return {
        reachable: true,
        running: resp.phase === "running",
        version: resp.version,
        runId: typeof resp.runId === "string" ? resp.runId : "",
        runKind: typeof resp.runKind === "string" ? resp.runKind : ""
      };
    } catch {
      // No receiving end: the tab reloaded, the extension was updated,
      // or the engine never attached. Either way nothing is running.
      return { reachable: false, running: false };
    }
  }

  // 8.7: did the injection we just made actually produce OUR engine?
  //
  // Both unattended callers check `isEngineAttached` and then inject.
  // Anything that attaches in that window -- a scan the user starts from
  // the popup, which never claims ACTIVE_RUN -- makes the content
  // script's duplicate guard swallow the injection. The caller had no
  // way to see that, so it went on to hold a run claim for the full two
  // hours against a run that never started, advance the schedule's
  // lastRun as though the sweep had happened, and (for Auto-Pilot) leave
  // a pending stage that the user's OWN next Smart scan in that tab
  // would then satisfy, launching a live unattended archive sweep.
  //
  // The engine now answers its ping with the run id it was given, so the
  // question has an exact answer. An unreachable tab is also a failure:
  // the engine either never booted or is already gone.
  async function confirmInjection(tabId, expectedRunId) {
    // The engine registers its message listener as it boots, so a tab
    // that cannot answer yet gets a couple more chances. Answering at
    // all settles it either way: the id is the whole answer.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
      const probe = await probeEngine(tabId);
      if (!probe.reachable) continue;
      return probe.runId === expectedRunId;
    }
    return false;
  }

  // How long a forced reset waits for a cancelled engine to actually
  // stop. The engine checks CANCELLED once per waitFor tick and clears
  // its own attach flag in the finally of every run kind, so this is
  // normally over in well under a second; the ceiling covers an engine
  // sitting inside one long Gmail wait.
  const RESET_STOP_WAIT_MS = 5000;
  const RESET_STOP_POLL_MS = 400;

  // The attach flag as it stands right now: true, false, or null when
  // the tab cannot be read at all. Null is deliberately distinct from
  // false, because "no engine here" and "cannot tell" call for
  // different handling.
  async function readAttachFlag(tabId) {
    if (typeof tabId !== "number" || !chrome.scripting?.executeScript) return null;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!window.GCC_ATTACHED
      });
      return result?.result === true;
    } catch {
      return null;
    }
  }

  // A tab that has closed cannot be holding an attach flag, so failing
  // to reach one is not the same as failing to clear one.
  async function tabStillOpen(tabId) {
    if (typeof tabId !== "number") return false;
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  }

  async function engineStillRunningAfter(tabId, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const probe = await probeEngine(tabId);
      if (!probe.running) return false;
      if (Date.now() >= deadline) return true;
      await new Promise((r) => setTimeout(r, RESET_STOP_POLL_MS));
    }
  }

  // 8.4: the way out of a run that is not really there.
  //
  // Two independent flags say "busy", and until now neither had a
  // user-facing way to clear: the stored ACTIVE_RUN claim, which
  // expires after two hours, and window.GCC_ATTACHED in the Gmail tab,
  // which expires never. An engine that dies without sending
  // gmailCleanerDone (extension reloaded mid-run, an exception outside
  // the run's own try/finally) strands both, and every later run is
  // refused with "a cleanup is already running" pointing at nothing.
  //
  // Refusing to disturb a live run is the whole safety story here, so
  // the probe comes first and `force` is only ever set by a second,
  // explicit act after the user has been told what is attached.
  //
  // Four outcomes, in the order they are decided:
  //   engine says running, no force  -> cancel it, change nothing
  //   engine says running, forced    -> cancel, WAIT for it to stop,
  //                                     then clear; if it will not
  //                                     stop, leave the tab guarded
  //   flag set, nothing answers      -> orphan; reload the tab
  //   flag clear or unreadable       -> just drop the stale claim
  async function forceResetRun({ tabId = null, force = false } = {}) {
    const claim = await hasActiveRun();
    const targetTab = typeof tabId === "number" ? tabId : (claim?.gmailTabId ?? null);
    const probe = await probeEngine(targetTab);

    if (probe.running && !force) {
      // Ask it to stop rather than yanking the flag out from under it.
      // A second, explicit act is what unlocks the rest.
      try {
        await chrome.tabs.sendMessage(targetTab, { type: "gmailCleanerCancel" });
      } catch {}
      return { ok: false, reason: "engine_running", tabId: targetTab, cancelSent: true };
    }

    // The forced path against a live engine: cancel, then WAIT for it to
    // confirm it stopped before touching the attach flag.
    //
    // The flag is the only thing standing between one engine and two on
    // the same mailbox, so clearing it while the engine is still looping
    // would let the user start a second pass over mail the first pass is
    // in the middle of moving. Cancelling makes the engine exit and
    // clear the flag itself, which is why waiting is worth the seconds.
    let stillRunning = false;
    if (probe.running) {
      try {
        await chrome.tabs.sendMessage(targetTab, { type: "gmailCleanerCancel" });
      } catch {}
      stillRunning = await engineStillRunningAfter(targetTab, RESET_STOP_WAIT_MS);
    }

    const cleared = { claim: false, attachFlag: false, reloadedTab: false };
    let attachWasSet = null;
    // Set when the Gmail tab is still there but could not be acted on.
    // Distinct from "the tab is gone", which holds nothing and is
    // therefore nothing to worry about.
    let tabActionFailed = false;

    // Attach flag FIRST, stored claim second.
    //
    // The other order leaves a window: with the claim already gone, a
    // popup opened in that instant can claim, see no engine attached,
    // and inject, and the clear that follows would then strip the guard
    // off the engine it just started. Doing the tab work while the
    // claim still stands means nothing else can begin.
    if (!stillRunning && typeof targetTab === "number") {
      attachWasSet = await readAttachFlag(targetTab);

      if (attachWasSet === true && !probe.reachable) {
        // Orphan signature: the flag is up, and nothing answers a ping.
        // Reloading the extension mid-run leaves exactly this behind, a
        // content script whose messaging is dead but whose loop is
        // still clicking around the mailbox. It cannot be cancelled,
        // because there is nothing left to send the cancel to, so
        // clearing its flag would only invite a second engine to work
        // beside it. Taking its page away is the one thing that
        // reliably stops it, and it is the same tab reload that was the
        // only cure for any of this before 8.4.
        try {
          await chrome.tabs.reload(targetTab);
          cleared.reloadedTab = true;
          cleared.attachFlag = true;
        } catch (e) {
          console.warn("[GCC SW] stuck-tab reload failed:", e?.message || e);
          tabActionFailed = await tabStillOpen(targetTab);
        }
      } else if (attachWasSet !== false && chrome.scripting?.executeScript) {
        // Set and reachable, or unreadable. Either way the flag is the
        // thing refusing new runs, and the engine behind it has already
        // answered for itself above.
        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTab },
            func: () => { window.GCC_ATTACHED = false; }
          });
          cleared.attachFlag = true;
        } catch (e) {
          console.warn("[GCC SW] attach-flag clear failed:", e?.message || e);
          // A tab that has closed holds no flag, so that is a success
          // by another name. A tab that is still open and refused us is
          // a real failure and must not be reported as a clean reset.
          tabActionFailed = await tabStillOpen(targetTab);
        }
      }
    }

    // The claim goes last, and only when nothing is left holding the
    // tab.
    //
    // It is tempting to drop it regardless, on the grounds that it
    // merely refuses runs rather than preventing an injection. That
    // reasoning is what makes keeping it necessary: once it is gone the
    // in-page flag is the ONLY gate, and the popup's reader of that
    // flag deliberately fails open so a slow tab stays usable. Clearing
    // the claim while an engine is still working, or while the tab
    // could not be reached to check, would hand the user a green light
    // backed by nothing.
    const holdClaim = stillRunning || tabActionFailed;
    if (claim && !holdClaim) {
      try {
        await chrome.storage.session?.set?.({ [STORAGE_KEYS.ACTIVE_RUN]: null });
      } catch {}
      try {
        await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RUN]: null });
      } catch {}
      cleared.claim = true;
    }

    return {
      ok: true,
      tabId: targetTab,
      cleared,
      attachWasSet,
      wasReachable: probe.reachable,
      wasRunning: probe.running,
      forced: Boolean(force && probe.running),
      // True when the engine refused to stop inside the wait. Nothing
      // was cleared, and saying so is the difference between "you can
      // start again" and a second cleaner on the same mailbox.
      stillRunning,
      // True when the Gmail tab is still open but would not take the
      // reload or the flag clear.
      tabActionFailed
    };
  }

  async function runScheduledCleanup(scheduleId) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 5000;
    // Set once the engine is in the tab. Everything after injection is
    // bookkeeping, and retrying past that point would inject a second
    // time (the first engine is already running).
    let injected = false;
    let claimedRunId = null;

    // 7.13 install-source guard: a copy planted by third-party
    // software must never act on the mailbox unattended.
    if (await isUntrustedInstall()) {
      console.warn(`[GCC SW] Untrusted install source, refusing scheduled run ${scheduleId}`);
      return;
    }

    // Honour snooze / vacation mode before doing any work.
    const snooze = await snoozeBlocksUnattended();
    if (snooze.blocked) {
      console.log(snooze.readable
        ? `[GCC SW] Snooze active until ${new Date(snooze.until).toISOString()}, skipping schedule ${scheduleId}`
        : `[GCC SW] Snooze unreadable, skipping schedule ${scheduleId}`);
      return;
    }

    // Issue #6: don't stomp on a manual run that's currently in flight.
    // The content script's GCC_ATTACHED guard catches duplicate
    // injection, but we'd still overwrite window.GMAIL_CLEANER_CONFIG
    // before the inner check sees the dup, mutating the active run.
    const active = await hasActiveRun();
    if (active) {
      console.log(`[GCC SW] Manual run in progress on tab ${active.gmailTabId}, skipping schedule ${scheduleId}`);
      return;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // A previous attempt may have claimed the marker and then failed
      // before the engine reached the tab. That claim is stale either way:
      // this attempt takes a fresh one, or it bails through one of the
      // early returns below, which used to strand it for the whole 2h TTL
      // and refuse every manual run in the meantime.
      if (claimedRunId) {
        await releaseRunClaim(claimedRunId);
        claimedRunId = null;
      }

      try {
        const result = await chrome.storage.sync.get([
          STORAGE_KEYS.SCHEDULES,
          STORAGE_KEYS.PROTECT_KEYWORDS,
          STORAGE_KEYS.WHITELIST
        ]);
        const schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];
        const schedule = schedules.find(s => s.id === scheduleId);

        if (!schedule || !schedule.enabled) return;

        // 6.1: scheduled runs honour the global protected-keyword shield.
        // Passed raw; the engine's sanitizeConfig cleans + caps it.
        const protectKeywords = Array.isArray(result?.[STORAGE_KEYS.PROTECT_KEYWORDS])
          ? result[STORAGE_KEYS.PROTECT_KEYWORDS]
          : [];

        // 7.15: and the Global Whitelist, which they did not.
        //
        // The injected config read `schedule.whitelist`, a field the
        // Options page hard-codes to [] when it creates a schedule and
        // that no control anywhere ever fills in. So "Never Delete" was
        // honoured by every manual run and by Auto-Pilot, and by no
        // scheduled cleanup at all: the unattended path, the one nobody
        // is watching, was the only one that would delete mail from a
        // sender the user had explicitly protected. Per-schedule entries
        // still apply if some older object carries them.
        const globalWhitelist = Array.isArray(result?.[STORAGE_KEYS.WHITELIST])
          ? result[STORAGE_KEYS.WHITELIST]
          : [];
        const scheduleWhitelist = Array.isArray(schedule.whitelist) ? schedule.whitelist : [];
        const whitelist = [...new Set([...globalWhitelist, ...scheduleWhitelist])];

        // Find a Gmail tab
        const gmailTabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
        if (!gmailTabs.length) {
          console.log("[GCC SW] No Gmail tab found for scheduled cleanup, skipping");
          return;
        }

        // Prefer active Gmail tab, fall back to first
        const gmailTab = gmailTabs.find(t => t.active) || gmailTabs[0];

        // Verify tab is still valid before using it
        try {
          await chrome.tabs.get(gmailTab.id);
        } catch {
          console.log("[GCC SW] Selected Gmail tab no longer valid, skipping");
          return;
        }

        // A scan or restore already working in that tab holds no
        // ACTIVE_RUN marker, so the check above cannot see it. Injecting
        // now would be swallowed by the content script's duplicate
        // guard while this schedule still recorded a successful run.
        if (await isEngineAttached(gmailTab.id)) {
          console.log(`[GCC SW] Engine already attached to tab ${gmailTab.id}, skipping schedule ${scheduleId}`);
          return;
        }

        // Claim ACTIVE_RUN so any concurrently-opened popup sees the
        // schedule in flight and refuses to start. Issue #6.
        const runId = `sched_${scheduleId}_${Date.now()}`;
        const claim = { gmailTabId: gmailTab.id, runId, startedAt: Date.now(), source: "schedule" };
        // 8.9: verified. claimedRunId is only set once the marker is
        // confirmed ours, so a lost race cannot later release someone
        // else's claim on the way out of this function.
        if (!(await claimRun(claim))) {
          console.log(`[GCC SW] Another run claimed the marker first, skipping schedule ${scheduleId}`);
          return;
        }
        claimedRunId = runId;

        const config = {
          intensity: schedule.intensity || "light",
          dryRun: false,
          safeMode: true,
          tagBeforeDelete: true,
          // 8.12: the recovery label a Pro user chose. Scheduled runs are
          // the ones most likely to need Restore later, so they are the
          // last place the label should disagree with the rest.
          tagLabelPrefix: (await readProSettings()).labelPrefix,
          guardSkipStarred: true,
          guardSkipImportant: true,
          guardSkipUnread: true,
          guardSkipUserLabels: true,
          minAge: schedule.minAge || "3m",
          archiveInsteadOfDelete: schedule.action === "archive",
          debugMode: false,
          reviewMode: false,
          whitelist,
          protectKeywords,
          version: SW_VERSION,
          scheduled: true,
          scheduleId,
          runId
        };

        // Inject config and content script
        await chrome.scripting.executeScript({
          target: { tabId: gmailTab.id },
          func: (cfg) => { window.GMAIL_CLEANER_CONFIG = cfg; },
          args: [config]
        });

        await chrome.scripting.executeScript({
          target: { tabId: gmailTab.id },
          files: ["contentScript.js"]
        });

        // 8.7: executeScript resolving only means the file ran, not that
        // an engine started. If something attached between the check
        // above and here, the duplicate guard swallowed this injection
        // and there is no run: do not advance lastRun (the sweep did not
        // happen, and this schedule should fire again), and let the
        // claim release below so the next manual run is not refused for
        // two hours.
        if (!(await confirmInjection(gmailTab.id, runId))) {
          console.warn(`[GCC SW] Schedule ${scheduleId}: injection was swallowed, no engine started`);
          await releaseRunClaim(runId);
          claimedRunId = null;
          return;
        }
        injected = true;

        // Update last run timestamp (quota-safe write).
        //
        // 8.9: re-read first and patch only this row. `schedules` is the
        // array captured at the top of this attempt, and injecting plus
        // confirming takes seconds, so writing it back whole undid
        // anything the Options page did in that window: a schedule
        // deleted mid-run came back, an intensity edit reverted, and
        // another schedule's fresh lastRun was rolled back, which
        // re-armed its alarm about a minute out and ran that cleanup a
        // second time unattended. saveSchedule learned this in 7.15;
        // this is its twin and it was missed.
        await markScheduleRan(scheduleId);

        console.log(`[GCC SW] Scheduled cleanup started: ${scheduleId}`);
        return; // Success, exit retry loop
      } catch (e) {
        console.error(`[GCC SW] Scheduled cleanup attempt ${attempt + 1} failed:`, e);
        // The engine is already in the tab; only the bookkeeping after
        // it failed. Retrying would overwrite the live run's config and
        // inject a second time, so stop here and let the run finish.
        if (injected) return;
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    // Every attempt failed before the engine ever reached the tab, so no
    // gmailCleanerDone will arrive to release the claim. Left alone it
    // would refuse every manual run for the full 2h TTL.
    await releaseRunClaim(claimedRunId);
  }

  // =========================
  // Message Router
  // =========================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg?.type) return;

    // Validate sender: only accept messages from this extension or Gmail tabs
    const isExtensionPage = sender.id === chrome.runtime.id && !sender.tab;
    const isGmailTab = sender.tab?.url?.startsWith("https://mail.google.com/");
    const isContentScript = sender.id === chrome.runtime.id && sender.tab;

    if (!isExtensionPage && !isGmailTab && !isContentScript) {
      console.warn("[GCC SW] Rejected message from unexpected sender:", sender);
      return;
    }

    switch (msg.type) {
      // Progress messages from content script already reach all extension
      // pages via chrome.runtime.sendMessage, no re-broadcast needed.
      // 7.5: layout-change errors additionally leave a small record
      // (timestamp + detail) so the Diagnostics page the popup points
      // at has something to show. Latest record wins; fire-and-forget
      // because the progress path must never block on storage.
      case "gmailCleanerProgress":
        if (msg.phase === "error" && msg.code === "gmail_layout_changed") {
          try {
            const write = chrome.storage.local.set({
              [STORAGE_KEYS.LAYOUT_CHANGE]: {
                at: Date.now(),
                detail: typeof msg.detail === "string" ? msg.detail.slice(0, 300) : ""
              }
            });
            write?.catch?.(() => {});
          } catch (e) {
            console.warn("[GCC SW] Failed to record layout change:", e);
          }
        }
        // Auto-Pilot (7.12): terminal progress messages drive the
        // sweep's stage machine. Fire-and-forget like the layout
        // record, and only terminal messages touch storage so the
        // per-pass progress beats stay free.
        if (msg.done || msg.phase === "done" || msg.phase === "cancelled" || msg.phase === "error") {
          const progressTabId = sender.tab?.id;
          withStorageLock(() => handleAutoPilotProgress(msg, progressTabId))
            .catch((e) => console.warn("[GCC SW] autopilot progress failed:", e?.message || e));
        }
        break;

      // Stats recording
      case "gmailCleanerRecordStats":
        withStorageLock(() => recordStats(msg.data)).then(() => sendResponse({ ok: true }));
        return true;

      // Undo log
      case "gmailCleanerRecordUndo":
        withStorageLock(() => recordUndoEntry(msg.data)).then(() => sendResponse({ ok: true }));
        return true;

      // 7.6: a finished restore run marks the log entries it emptied.
      case "gmailCleanerRecordRestore":
        withStorageLock(() => recordRestoreOutcome(msg.data)).then(() => sendResponse({ ok: true }));
        return true;

      case "gmailCleanerGetUndoLog":
        getUndoLog().then(log => sendResponse({ ok: true, log }));
        return true;

      case "gmailCleanerClearUndoLog":
        // 8.16: locked, like recordUndoEntry above it. See clearUndoLog.
        withStorageLock(() => clearUndoLog()).then(() => sendResponse({ ok: true }));
        return true;

      // Stats retrieval
      case "gmailCleanerGetStats":
        getStats().then(stats => sendResponse({ ok: true, stats }));
        return true;

      // Schedule management
      case "gmailCleanerGetSchedules":
        getSchedules().then(schedules => sendResponse({ ok: true, schedules }));
        return true;

      case "gmailCleanerSaveSchedule":
        saveSchedule(msg.schedule)
          .then(() => restoreScheduledAlarms())
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "save failed" }));
        return true;

      case "gmailCleanerDeleteSchedule":
        deleteSchedule(msg.scheduleId)
          .then(() => restoreScheduledAlarms())
          .then(() => sendResponse({ ok: true }));
        return true;

      // 8.15: an import writes the schedules key straight to sync
      // storage rather than going through saveSchedule, so nothing armed
      // the alarms and an imported schedule sat there reading "Enabled"
      // with no unattended run behind it until the next browser restart.
      // Options calls this after the write.
      case "gmailCleanerSchedulesReplaced":
        restoreScheduledAlarms()
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "rearm failed" }));
        return true;

      // Ping
      case "gmailCleanerSwPing":
        sendResponse({ ok: true, version: SW_VERSION });
        break;

      // 8.4: is anything actually running, and can it be cleared?
      case "gmailCleanerRunState":
        hasActiveRun()
          .then(async (run) => {
            const probe = await probeEngine(run?.gmailTabId ?? msg.tabId ?? null);
            sendResponse({
              ok: true,
              run: run || null,
              engineReachable: probe.reachable,
              engineRunning: probe.running
            });
          })
          .catch(() => sendResponse({ ok: false }));
        return true;

      case "gmailCleanerForceReset":
        forceResetRun({ tabId: msg.tabId ?? null, force: Boolean(msg.force) })
          .then((result) => sendResponse(result))
          .catch((e) => sendResponse({ ok: false, reason: "error", error: e?.message || "unknown" }));
        return true;

      // Multi-account: list Gmail tabs
      case "gmailCleanerListGmailTabs":
        listGmailTabs().then(tabs => sendResponse({ ok: true, tabs }));
        return true;

      // Snooze / vacation mode (5.0)
      case "gmailCleanerGetSnooze":
        getSnoozeUntil().then(until => sendResponse({ ok: true, until }));
        return true;

      case "gmailCleanerSetSnooze":
        setSnooze(msg.days).then((until) => sendResponse({ ok: true, until }));
        return true;

      // Add a sender to the global whitelist (called from stats top-senders UI)
      case "gmailCleanerAddToWhitelist":
        addToWhitelist(msg.sender)
          .then((added) => sendResponse({ ok: true, added }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      // Capture sender hits during cleanup to feed the top-senders dashboard
      case "gmailCleanerRecordSenders":
        withStorageLock(() => recordSenderHits(msg.senders)).then(() => sendResponse({ ok: true }));
        return true;

      // Subscriptions (7.0): persist the latest scan so the popup can
      // render it any time, merging in statuses from earlier runs.
      case "gmailCleanerSubscriptionScanResult":
        withStorageLock(() => recordSubscriptionScan(msg.senders)).then(() => sendResponse({ ok: true }));
        return true;

      // Subscriptions (7.0): per-sender unsubscribe outcomes.
      case "gmailCleanerRecordUnsubscribes":
        withStorageLock(() => recordUnsubscribeResults(msg.results)).then(() => sendResponse({ ok: true }));
        return true;

      case "gmailCleanerGetSubscriptions":
        chrome.storage.local.get(STORAGE_KEYS.SUBSCRIPTIONS)
          .then((r) => sendResponse({ ok: true, scan: r?.[STORAGE_KEYS.SUBSCRIPTIONS] || null }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      // Storage X-ray (7.2): persist the latest tiered size scan.
      case "gmailCleanerStorageScanResult":
        withStorageLock(() => recordStorageScan(msg.senders, msg.totalMb, msg.totalCount))
          .then(() => sendResponse({ ok: true }));
        return true;

      case "gmailCleanerGetStorageScan":
        chrome.storage.local.get(STORAGE_KEYS.STORAGE_XRAY)
          .then((r) => sendResponse({ ok: true, scan: r?.[STORAGE_KEYS.STORAGE_XRAY] || null }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      // Storage X-ray (7.2): the popup registers which senders a purge
      // run targets; gmailCleanerDone consumes it (the popup usually
      // closes long before the run finishes).
      case "gmailCleanerStorageXrayPurgeStarted":
        withStorageLock(() => recordPendingStoragePurge(msg.runId, msg.senders))
          .then(() => sendResponse({ ok: true }));
        return true;

      // Mailbox Report (8.0): persist the latest read-only band scan.
      case "gmailCleanerReportScanResult":
        withStorageLock(() => recordReportScan(msg))
          .then(() => sendResponse({ ok: true }));
        return true;

      case "gmailCleanerGetReport":
        chrome.storage.local.get(STORAGE_KEYS.REPORT)
          .then((r) => sendResponse({ ok: true, report: r?.[STORAGE_KEYS.REPORT] || null }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      case "gmailCleanerReportPurgeStarted":
        withStorageLock(() => recordPendingReportPurge(msg.runId, msg.bandIds))
          .then(() => sendResponse({ ok: true }));
        return true;

      // Smart Suggestions (7.8): persist the latest recommendation
      // scan, union-merged so senders measured on earlier scans keep
      // their place while new ones join.
      case "gmailCleanerSmartScanResult":
        withStorageLock(() => recordSmartScan(msg.senders, msg.heldBackSenders, msg.heldBackCount))
          .then(() => sendResponse({ ok: true }));
        return true;

      case "gmailCleanerGetSmartScan":
        chrome.storage.local.get([STORAGE_KEYS.SMART_SCAN, STORAGE_KEYS.SMART_FEEDBACK])
          .then((r) => sendResponse({
            ok: true,
            scan: r?.[STORAGE_KEYS.SMART_SCAN] || null,
            feedback: r?.[STORAGE_KEYS.SMART_FEEDBACK] || null
          }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      // Smart Suggestions (7.8): dismissals arrive directly from the
      // popup; "applied" is only ever written by the pending-apply
      // marker below, once a real run confirms.
      case "gmailCleanerSmartFeedback":
        withStorageLock(() => recordSmartFeedback([{ email: msg.email, action: msg.action }]))
          .then(() => sendResponse({ ok: true }));
        return true;

      // Smart Suggestions (7.8): the popup registers which senders an
      // apply run targets; gmailCleanerDone consumes it, same marker
      // pattern as the X-ray purge.
      case "gmailCleanerSmartApplyStarted":
        withStorageLock(() => recordPendingSmartApply(msg.runId, msg.senders))
          .then(() => sendResponse({ ok: true }));
        return true;

      // Auto-Pilot (7.12): popup settings surface.
      case "gmailCleanerGetAutoPilot":
        getAutoPilotForPopup()
          .then((autoPilot) => sendResponse({ ok: true, autoPilot }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      case "gmailCleanerSetAutoPilot":
        setAutoPilotEnabled(Boolean(msg.enabled))
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      case "gmailCleanerConfirmAutoPilot":
        confirmAutoPilot()
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      // 8.12: Options saved the Pro settings. The only one the worker
      // holds state for is the Auto-Pilot interval, which is baked into
      // a live alarm, so re-arm it now. Without this the new interval
      // only took effect after the next fire, i.e. up to a week of the
      // settings page and the alarm disagreeing.
      // No withStorageLock here on purpose: restoreAutoPilotAlarm reads
      // config and writes an ALARM, never a storage read-modify-write, so
      // it has nothing to serialise against and taking the queue would
      // only add a way to deadlock it.
      case "gmailCleanerProSettingsChanged":
        restoreAutoPilotAlarm()
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "Failed" }));
        return true;

      case "gmailCleanerDone":
        // Release the run marker, but only when it is still the one this
        // run took. Clearing it outright let a finishing run erase a claim
        // that a newer run had already made in the gap, after which a
        // schedule could see an idle marker and start a second live
        // cleanup beside the first. Runs that carry no id (scans, and any
        // engine older than the claim itself) keep the blanket clear.
        if (msg.summary?.runId) {
          releaseRunClaim(msg.summary.runId)
            .catch(e => console.warn("[GCC SW] claim release on done failed:", e));
        } else {
          // 7.15: the blanket clear is now scoped to the tab the message
          // came from. Scans and restores finish without a run id, and on
          // a second Gmail account in a second tab one of them could
          // erase the claim held by a live cleanup in the FIRST tab,
          // which is the same "second cleaner on one mailbox" outcome the
          // id-aware release exists to prevent. A run with no id can
          // still clear the marker for its own tab.
          releaseRunClaimForTab(sender.tab?.id)
            .catch(e => console.warn("[GCC SW] tab-scoped clear on done failed:", e));
        }
        // Storage X-ray (7.2): if this run was a registered purge, mark
        // its senders in the stored scan.
        if (msg.summary) {
          withStorageLock(() => resolvePendingStoragePurge(msg.summary))
            .catch((e) => console.warn("[GCC SW] purge resolve failed:", e?.message || e));
        }
        // Smart Suggestions (7.8): if this run was a registered apply,
        // record "applied" feedback for its senders.
        if (msg.summary) {
          withStorageLock(() => resolvePendingSmartApply(msg.summary))
            .catch((e) => console.warn("[GCC SW] smart apply resolve failed:", e?.message || e));
        }
        // Mailbox Report (8.0): if this run was a registered band purge,
        // mark those steps of the plan as done.
        if (msg.summary) {
          withStorageLock(() => resolvePendingReportPurge(msg.summary))
            .catch((e) => console.warn("[GCC SW] report purge resolve failed:", e?.message || e));
        }
        // Auto-Pilot (7.12): if this run was the sweep's apply stage,
        // close it out (preview tally or live last-run summary).
        if (msg.summary) {
          withStorageLock(() => resolveAutoPilotDone(msg.summary))
            .catch((e) => console.warn("[GCC SW] autopilot resolve failed:", e?.message || e));
        }
        // Surface a desktop notification if the user opted in.
        if (msg.summary) {
          maybeNotifyDone(msg.summary).catch((e) =>
            console.warn("[GCC SW] notify on done failed:", e?.message || e)
          );
        }
        break;

      default:
        // Unknown types still get a response so callers don't hang.
        sendResponse({ ok: false, error: "unknown message type" });
        break;
    }
  });

  // =========================
  // Snooze / vacation
  // =========================

  async function setSnooze(days) {
    const ms = Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000;
    if (!ms) {
      await chrome.storage.local.set({ [STORAGE_KEYS.SNOOZE_UNTIL]: null });
      return 0;
    }
    const until = Date.now() + ms;
    await chrome.storage.local.set({ [STORAGE_KEYS.SNOOZE_UNTIL]: until });
    return until;
  }

  // =========================
  // Whitelist mutation (used by stats top-senders Protect button)
  // =========================

  // Same shape the Options page enforces and the engine re-checks. Kept
  // here as its own copy because the worker is self-contained; the
  // whitelist suite pins the three against each other.
  const WL_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
  const WL_WILDCARD_EMAIL = /^\*@([a-z0-9.-]+\.[a-z]{2,})$/i;
  const WL_DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;
  function isValidWhitelistEntry(s) {
    if (typeof s !== "string") return false;
    const trimmed = s.trim();
    if (!trimmed || /\s/.test(trimmed)) return false;
    return WL_EMAIL.test(trimmed) || WL_WILDCARD_EMAIL.test(trimmed) || WL_DOMAIN.test(trimmed);
  }

  // 8.7: validate before storing. The top-sender rows this is called
  // from are keyed `email || displayName` (contentScript sampleListRows),
  // so a sender Gmail rendered without an address arrives here as
  // "acme newsletters". That went into sync unchecked, replicated to the
  // Google account, and showed up in the Options whitelist -- while
  // sanitizeConfig dropped it at run time for having a space in it. The
  // user clicked Protect, was told the sender was protected, and it was
  // not. Refusing loudly is the only honest outcome: a safety control
  // that silently does nothing is worse than one that says no.
  // 8.10: 100, matching options.js MAX_WHITELIST_ENTRIES. This copy
  // allowed 200 and dropped the OLDEST entry to make room, while the
  // Options page normalizes to 100 on LOAD -- so protecting a 101st
  // sender here, then opening Options and pressing Save without touching
  // the whitelist, wrote back only the first 100 and quietly unprotected
  // the rest. The same lesson as 8.7's validate-before-storing fix: a
  // safety control that silently does nothing is worse than one that
  // says no, so a full list refuses instead of evicting.
  const WL_MAX_ENTRIES = 100;

  async function addToWhitelist(sender) {
    const s = String(sender || "").trim();
    if (!s) throw new Error("empty sender");
    if (!isValidWhitelistEntry(s)) {
      throw new Error("not an address or domain");
    }
    return withStorageLock(async () => {
      const r = await chrome.storage.sync.get(STORAGE_KEYS.WHITELIST);
      const wl = Array.isArray(r?.[STORAGE_KEYS.WHITELIST]) ? r[STORAGE_KEYS.WHITELIST] : [];
      if (wl.includes(s)) return false;
      if (wl.length >= WL_MAX_ENTRIES) {
        throw new Error(`whitelist is full (${WL_MAX_ENTRIES} max), remove one in Options first`);
      }
      wl.push(s);
      await safeSyncSet({ [STORAGE_KEYS.WHITELIST]: wl }, "whitelist");
      return true;
    });
  }

  // =========================
  // Top senders accumulation
  // =========================
  // The content script samples sender addresses from the Gmail list view
  // before each delete batch and forwards them here. We aggregate counts
  // into stats.topSenders, capped to 200 entries to keep storage small.

  async function recordSenderHits(senders) {
    if (!Array.isArray(senders) || senders.length === 0) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STATS);
      const stats = result?.[STORAGE_KEYS.STATS] || {};
      // Write back a complete stats shape so a topSenders-only object
      // never reaches recordStats, which would throw on categoryBreakdown.
      stats.totalRuns = stats.totalRuns || 0;
      stats.totalDeleted = stats.totalDeleted || 0;
      stats.totalArchived = stats.totalArchived || 0;
      stats.totalFreedMb = stats.totalFreedMb || 0;
      stats.history = Array.isArray(stats.history) ? stats.history : [];
      stats.categoryBreakdown = stats.categoryBreakdown || {};
      stats.dailyStats = stats.dailyStats || {};
      const map = Object.create(null);
      for (const entry of stats.topSenders || []) {
        if (entry?.sender) map[entry.sender] = { count: entry.count || 0, lastSeen: entry.lastSeen || 0 };
      }
      for (const raw of senders) {
        const s = String(raw || "").trim().toLowerCase();
        if (!s || s.length > 200) continue;
        if (!map[s]) map[s] = { count: 0, lastSeen: 0 };
        map[s].count += 1;
        map[s].lastSeen = Date.now();
      }
      const merged = Object.entries(map)
        .map(([sender, v]) => ({ sender, count: v.count, lastSeen: v.lastSeen }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 200);
      stats.topSenders = merged;
      await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
    } catch (e) {
      console.error("[GCC SW] recordSenderHits failed:", e);
    }
  }

  // =========================
  // Subscriptions store (7.0)
  // =========================
  // One local-storage object: { updatedAt, senders: [{ email, name,
  // count, status, statusAt }] }. A fresh scan replaces the sender list
  // but keeps the unsubscribe status of senders it sees again, so "done"
  // badges survive a re-scan. Statuses come from the content script:
  // unsubscribed | manual | no_button | no_dialog | not_found | error.

  // Both writers to the stored scan share this bound.
  const SUBSCRIPTION_SENDER_CAP = 200;

  async function recordSubscriptionScan(senders) {
    if (!Array.isArray(senders)) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SUBSCRIPTIONS);
      const prev = result?.[STORAGE_KEYS.SUBSCRIPTIONS] || {};
      const prevStatus = Object.create(null);
      for (const entry of prev.senders || []) {
        if (entry?.email && entry.status) {
          prevStatus[entry.email] = { status: entry.status, statusAt: entry.statusAt || 0 };
        }
      }
      const clean = [];
      for (const raw of senders.slice(0, SUBSCRIPTION_SENDER_CAP)) {
        const email = String(raw?.email || "").trim().toLowerCase();
        if (!email || email.length > 320 || !email.includes("@")) continue;
        clean.push({
          email,
          name: String(raw?.name || "").slice(0, 120),
          count: Math.max(1, Math.min(9999, Number(raw?.count) || 1)),
          status: prevStatus[email]?.status || "",
          statusAt: prevStatus[email]?.statusAt || 0
        });
      }
      await chrome.storage.local.set({
        [STORAGE_KEYS.SUBSCRIPTIONS]: { updatedAt: Date.now(), senders: clean }
      });
    } catch (e) {
      console.error("[GCC SW] recordSubscriptionScan failed:", e);
    }
  }

  async function recordUnsubscribeResults(results) {
    if (!Array.isArray(results) || results.length === 0) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SUBSCRIPTIONS);
      const scan = result?.[STORAGE_KEYS.SUBSCRIPTIONS] || { updatedAt: 0, senders: [] };
      const byEmail = Object.create(null);
      for (const entry of scan.senders || []) {
        if (entry?.email) byEmail[entry.email] = entry;
      }
      let unsubscribedNow = 0;
      for (const r of results) {
        const email = String(r?.sender || "").trim().toLowerCase();
        const status = String(r?.status || "").slice(0, 30);
        if (!email || !status) continue;
        if (status === "unsubscribed") unsubscribedNow += 1;
        if (byEmail[email]) {
          byEmail[email].status = status;
          byEmail[email].statusAt = Date.now();
        } else {
          scan.senders = Array.isArray(scan.senders) ? scan.senders : [];
          scan.senders.push({ email, name: "", count: 1, status, statusAt: Date.now() });
        }
      }
      // A fresh scan caps the list at 200; this merge path had no cap at
      // all, so every unsubscribe result for a sender the scan had not
      // seen grew the stored object forever. Same failure mode the
      // whitelist suggestions map had: local writes start failing under
      // quota pressure and stats, undo and run claims quietly stop
      // persisting. Newest statuses win the tail.
      if (Array.isArray(scan.senders) && scan.senders.length > SUBSCRIPTION_SENDER_CAP) {
        scan.senders = scan.senders
          .slice()
          .sort((a, b) => (Number(b?.statusAt) || 0) - (Number(a?.statusAt) || 0))
          .slice(0, SUBSCRIPTION_SENDER_CAP);
      }
      await chrome.storage.local.set({ [STORAGE_KEYS.SUBSCRIPTIONS]: scan });

      // Lifetime counter rides on the stats object the dashboard reads.
      if (unsubscribedNow > 0) {
        const statsResult = await chrome.storage.local.get(STORAGE_KEYS.STATS);
        const stats = statsResult?.[STORAGE_KEYS.STATS] || {};
        stats.totalUnsubscribed = (Number(stats.totalUnsubscribed) || 0) + unsubscribedNow;
        await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
      }

      // 8.19: and the free allowance, from the same count, in the same
      // locked step. See chargeFreeUnsubscribes.
      await chargeFreeUnsubscribes(unsubscribedNow);
    } catch (e) {
      console.error("[GCC SW] recordUnsubscribeResults failed:", e);
    }
  }

  // 8.19: three free unsubscribes are spent HERE, not in the popup.
  //
  // 8.17 charged them from the popup's own progress handler. A browser
  // action popup is destroyed the moment the user clicks anything outside
  // it, and an unsubscribe run opens one message per sender for up to
  // twenty-five senders, so the popup is usually gone long before the run
  // ends. Nothing charged the counter and the three came back on every
  // open, from either entry point. This is the same fact
  // storageXrayPendingPurge and smartPendingApply were built around, said
  // in their own comments: the popup closes long before the run finishes,
  // so anything that has to be recorded belongs on the worker, which the
  // engine reaches whether or not anybody is watching.
  //
  // Charged off `unsubscribedNow`, which counts only senders that came
  // back `unsubscribed`. A sender with no one-click link, one left for
  // manual follow-up, or one the run never reached costs nothing.
  //
  // The worker keeps its own copy of the arithmetic because it cannot
  // load shared.js; a test pins both against GCC.freeUnsub.
  const FREE_UNSUB_LIMIT = 3;

  function freeUnsubUsedOf(stored) {
    if (stored === null) return FREE_UNSUB_LIMIT;
    if (stored === undefined) return 0;
    const n = Number(stored);
    if (!Number.isFinite(n) || n < 0) return FREE_UNSUB_LIMIT;
    return Math.min(FREE_UNSUB_LIMIT, Math.floor(n));
  }

  function freeUnsubSpend(stored, okCount) {
    const n = Number(okCount);
    const add = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    return Math.min(FREE_UNSUB_LIMIT, freeUnsubUsedOf(stored) + add);
  }

  async function chargeFreeUnsubscribes(okCount) {
    if (!(Number(okCount) > 0)) return;
    // "pro" has no allowance to spend and "unknown" is a guess this must
    // not make: readLicenseState only says unknown when BOTH storage
    // areas are unreachable, and spending somebody's allowance off a
    // failed read is the exact write-side mistake 8.16 found four times.
    const state = await readLicenseState();
    if (state !== "free") return;

    let stored;
    try {
      const r = await chrome.storage.local.get(STORAGE_KEYS.FREE_UNSUB_USED);
      stored = r?.[STORAGE_KEYS.FREE_UNSUB_USED];
    } catch {
      // Same rule the popup's writer follows: a read that failed is not a
      // licence to write "all three used". Leave the counter alone and
      // let the next good read settle it. The run already happened.
      return;
    }

    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.FREE_UNSUB_USED]: freeUnsubSpend(stored, okCount)
      });
    } catch (e) {
      console.warn("[GCC SW] free unsubscribe spend failed:", e?.message || e);
    }
  }

  // =========================
  // Storage X-ray store (7.2)
  // =========================
  // One local-storage object: { updatedAt, totalMb, totalCount,
  // senders: [{ email, name, count, estMb, status, statusAt }] }. A
  // fresh scan replaces the list but keeps each sender's purge status,
  // mirroring the subscriptions store. Purge marking is indirect: the
  // popup registers { runId, senders } when it starts a purge run, and
  // the engine's gmailCleanerDone (which carries runId, dryRun and the
  // affected count) resolves it, because the popup closes long before
  // the run finishes.

  async function recordStorageScan(senders, totalMb, totalCount) {
    if (!Array.isArray(senders)) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STORAGE_XRAY);
      const prev = result?.[STORAGE_KEYS.STORAGE_XRAY] || {};
      const prevStatus = Object.create(null);
      for (const entry of prev.senders || []) {
        if (entry?.email && entry.status) {
          prevStatus[entry.email] = { status: entry.status, statusAt: entry.statusAt || 0 };
        }
      }
      const clean = [];
      for (const raw of senders.slice(0, 100)) {
        const email = String(raw?.email || "").trim().toLowerCase();
        if (!email || email.length > 320 || !email.includes("@")) continue;
        clean.push({
          email,
          name: String(raw?.name || "").slice(0, 120),
          count: Math.max(1, Math.min(99999, Number(raw?.count) || 1)),
          estMb: Math.max(0, Math.min(1024 * 1024, Math.round(Number(raw?.estMb) || 0))),
          status: prevStatus[email]?.status || "",
          statusAt: prevStatus[email]?.statusAt || 0
        });
      }
      await chrome.storage.local.set({
        [STORAGE_KEYS.STORAGE_XRAY]: {
          updatedAt: Date.now(),
          totalMb: Math.max(0, Math.round(Number(totalMb) || 0)),
          totalCount: Math.max(0, Math.round(Number(totalCount) || 0)),
          senders: clean
        }
      });
    } catch (e) {
      console.error("[GCC SW] recordStorageScan failed:", e);
    }
  }

  async function recordPendingStoragePurge(runId, senders) {
    const id = String(runId || "");
    const list = Array.isArray(senders)
      ? senders.filter((s) => typeof s === "string").slice(0, 25)
      : [];
    if (!id || list.length === 0) return;
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.XRAY_PENDING]: { runId: id, senders: list, startedAt: Date.now() }
      });
    } catch (e) {
      console.error("[GCC SW] recordPendingStoragePurge failed:", e);
    }
  }

  // 8.16: a terminal message is not a completion.
  //
  // The engine sends `gmailCleanerDone` from a `finally`, so a run the user
  // cancelled and a run that died on an unexpected error arrive here in the
  // same shape as one that finished, carrying whatever they had moved up to
  // that point. Three resolvers below, plus Auto-Pilot's preview, used to
  // decide off `dryRun` and `count > 0` alone, and each of them writes a
  // mark that tells the user they are FINISHED with something: the Mailbox
  // Report's Cleared chip (which also removes that step's Run button, and
  // a free user has exactly one), the X-ray's Purged chip (which is how
  // they track which senders are left), and Smart Suggestions' applied
  // feedback. Pressing Cancel halfway therefore marked the thing done.
  //
  // `stoppedShort` covers the quieter half: a rule that ran out of passes
  // or kept rate-limiting is a rule with mail still behind it, and the
  // engine only ever said so in a progress message, which reaches an open
  // extension page and nothing else.
  //
  // A summary with no `outcome` at all is a Gmail tab still running a
  // pre-8.16 content script after an update. That cannot prove it
  // finished, so it does not get the mark. The cost of being wrong that
  // way is one rescan; the cost the other way is the button the user
  // needed to finish the job.
  function runFinishedClean(summary) {
    if (!summary || typeof summary !== "object") return false;
    if (summary.outcome !== "completed") return false;
    return !(Number(summary.stoppedShort) > 0);
  }

  async function resolvePendingStoragePurge(summary) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.XRAY_PENDING);
      const pending = result?.[STORAGE_KEYS.XRAY_PENDING];
      if (!pending?.runId) return;

      // Stale guard: a pending marker beyond the popup's 2h run TTL is
      // dead weight from an interrupted run.
      const stale = Date.now() - (Number(pending.startedAt) || 0) > 1000 * 60 * 60 * 2;
      if (String(summary?.runId || "") !== pending.runId) {
        if (stale) await chrome.storage.local.set({ [STORAGE_KEYS.XRAY_PENDING]: null });
        return;
      }

      // This run was the purge: consume the marker either way, but only
      // mark senders when mail was actually affected for real.
      await chrome.storage.local.set({ [STORAGE_KEYS.XRAY_PENDING]: null });
      if (summary?.dryRun || !(Number(summary?.count) > 0)) return;
      // 8.16: and only when the run finished. The Purged chip is how the
      // user tracks which of their heaviest senders they have already
      // dealt with, so a cancelled purge that had cleared some of one
      // sender's mail marked that sender done and left the rest.
      if (!runFinishedClean(summary)) return;

      // 8.12: the guard resolvePendingReportPurge has carried since 8.0,
      // finally copied to its twin. The engine reports ONE aggregate
      // count for the whole run, and a purge of N senders is a
      // MULTI-RULE run (popup.js chunks the addresses into several
      // rulesOverride entries). So a run that cleared sender 1 and then
      // died stamped all N "Purged" off that single count, and the
      // Purged chip is what tells the user which senders still need
      // dealing with. With more than one sender in the marker there is
      // no way to attribute the count, so nothing is stamped: an
      // unmarked sender the user re-purges is a wasted run, a wrongly
      // marked one is mail they believe is gone and is not.
      if (!Array.isArray(pending.senders) || pending.senders.length !== 1) return;

      const scanResult = await chrome.storage.local.get(STORAGE_KEYS.STORAGE_XRAY);
      const scan = scanResult?.[STORAGE_KEYS.STORAGE_XRAY];
      if (!scan?.senders) return;
      const targeted = new Set(pending.senders);
      let touched = 0;
      for (const entry of scan.senders) {
        if (entry?.email && targeted.has(entry.email)) {
          entry.status = "purged";
          entry.statusAt = Date.now();
          touched++;
        }
      }
      if (touched > 0) {
        await chrome.storage.local.set({ [STORAGE_KEYS.STORAGE_XRAY]: scan });
      }
    } catch (e) {
      console.error("[GCC SW] resolvePendingStoragePurge failed:", e);
    }
  }

  // =========================
  // Mailbox Report store (8.0)
  // =========================
  // Same shape as the Storage X-ray quartet above: the engine posts a
  // finished scan, the popup reads it, the popup registers which bands a
  // purge run targets, and gmailCleanerDone resolves that marker (the
  // popup closes long before the run finishes).
  //
  // Band ids are validated against a fixed allow-list rather than
  // sanitized, because anything not on the list is not a band this
  // build knows how to run.

  const REPORT_BAND_IDS = Object.freeze([
    "sizeHuge", "sizeLarge", "sizeBig",
    "promotions", "social", "updates", "forums", "newsletters",
    "inboxAncient", "inboxOld"
  ]);

  const REPORT_MAX_COUNT = 10000000;

  // Non-finite goes to ZERO, not to the ceiling. Clamping Infinity up
  // would render "10,000,000 emails" and "at least 10,000,000 MB" from a
  // single malformed message, and this build's whole report copy rests
  // on those figures being conservative. GCC.report.clampReportCount in
  // shared.js makes the same choice; the two must agree.
  const clampReportNumber = (value) => {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, REPORT_MAX_COUNT);
  };

  async function recordReportScan(msg) {
    const bands = Array.isArray(msg?.bands) ? msg.bands : null;
    if (!bands) return;
    try {
      const known = new Set(REPORT_BAND_IDS);
      const clean = [];
      const seen = new Set();
      for (const raw of bands) {
        // Strict: an array whose single element is a band id stringifies
        // to that id, so String() coercion would let ["promotions"]
        // through an allow-list that is supposed to be exact.
        const id = typeof raw?.id === "string" ? raw.id : "";
        if (!known.has(id) || seen.has(id)) continue;
        seen.add(id);
        clean.push({
          id,
          kind: typeof raw?.kind === "string" ? raw.kind.slice(0, 12) : "",
          action: raw?.action === "archive" ? "archive" : "delete",
          count: clampReportNumber(raw?.count),
          estMb: clampReportNumber(raw?.estMb),
          // 8.9: false only when the engine says so. Reports stored by
          // an older version carry no flag at all, and every band in
          // those WAS measured, so absent has to mean true.
          measured: raw?.measured !== false,
          cleanedAt: 0
        });
      }
      if (clean.length === 0) return;

      // A rescan replaces counts but keeps the "you already cleared
      // this" marks, so the plan does not forget what the user did.
      //
      // 8.15: unless the fresh scan says there is mail there. A run can
      // finish having cleared only part of a step (the pass cap, or the
      // per-query wall-time bail) and the engine's own message says so:
      // "Cleared 7,500 so far; run the cleaner again to continue this
      // rule." But cleanedAt was stamped on any run that moved anything,
      // and then carried forward forever. The row kept showing a
      // five-figure count with a "Cleared" chip and no Run button, the
      // whole-plan button excluded it, and for a free user that was
      // their one unlocked step gone for good. The mark now means "this
      // step is empty because you cleared it", which is what the chip
      // claims, so a rescan that finds mail again drops it.
      const prevResult = await chrome.storage.local.get(STORAGE_KEYS.REPORT);
      const prevCleaned = Object.create(null);
      for (const entry of prevResult?.[STORAGE_KEYS.REPORT]?.bands || []) {
        if (entry?.id && Number(entry.cleanedAt) > 0) prevCleaned[entry.id] = Number(entry.cleanedAt);
      }
      for (const band of clean) {
        // A band the scan could not measure keeps its mark: absent
        // evidence is not evidence the step refilled.
        if (!prevCleaned[band.id]) continue;
        if (band.measured !== false && band.count > 0) continue;
        band.cleanedAt = prevCleaned[band.id];
      }

      const topSenders = [];
      for (const group of Array.isArray(msg?.topSenders) ? msg.topSenders.slice(0, 4) : []) {
        const bandId = String(group?.bandId || "");
        if (!known.has(bandId)) continue;
        const senders = [];
        for (const s of Array.isArray(group?.senders) ? group.senders.slice(0, 5) : []) {
          const email = String(s?.email || "").trim().toLowerCase();
          if (!email || email.length > 320 || !email.includes("@")) continue;
          senders.push({
            email,
            name: String(s?.name || "").slice(0, 120),
            count: Math.max(1, Math.min(99999, Number(s?.count) || 1))
          });
        }
        if (senders.length) topSenders.push({ bandId, senders });
      }

      await chrome.storage.local.set({
        [STORAGE_KEYS.REPORT]: {
          updatedAt: Date.now(),
          bands: clean,
          cleanableCount: clampReportNumber(msg?.cleanableCount),
          largeMb: clampReportNumber(msg?.largeMb),
          // 8.5: old mail the guards held back, so a report that reads
          // near zero can say why instead of looking like a dead
          // feature. Clamped like every other number here.
          guardedOutCount: clampReportNumber(msg?.guardedOutCount),
          // 8.7: how much of the scan actually completed. Without this
          // the incompleteness warning lived only in the transient done
          // message, so reopening the popup showed the same zeroes with
          // nothing to say they were never measured.
          failedQueries: clampReportNumber(msg?.failedQueries),
          totalQueries: clampReportNumber(msg?.totalQueries),
          // 8.7: the guard settings the counts were measured through, so
          // the popup can tell whether they still describe what a Run
          // would do. Booleans only; nothing here is a query or an
          // address, and the whole object is local like the rest.
          guards: {
            safeMode: Boolean(msg?.guards?.safeMode),
            minAge: typeof msg?.guards?.minAge === "string" && /^\d+[dwmy]$/i.test(msg.guards.minAge)
              ? msg.guards.minAge
              : null,
            guardSkipStarred: Boolean(msg?.guards?.guardSkipStarred),
            guardSkipImportant: Boolean(msg?.guards?.guardSkipImportant),
            guardSkipUnread: Boolean(msg?.guards?.guardSkipUnread),
            guardSkipUserLabels: Boolean(msg?.guards?.guardSkipUserLabels)
          },
          topSenders
        }
      });
    } catch (e) {
      console.error("[GCC SW] recordReportScan failed:", e);
    }
  }

  async function recordPendingReportPurge(runId, bandIds) {
    const id = String(runId || "");
    const known = new Set(REPORT_BAND_IDS);
    const list = Array.isArray(bandIds)
      ? bandIds.filter((b) => typeof b === "string" && known.has(b)).slice(0, 10)
      : [];
    if (!id || list.length === 0) return;
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.REPORT_PENDING]: { runId: id, bandIds: list, startedAt: Date.now() }
      });
    } catch (e) {
      console.error("[GCC SW] recordPendingReportPurge failed:", e);
    }
  }

  async function resolvePendingReportPurge(summary) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.REPORT_PENDING);
      const pending = result?.[STORAGE_KEYS.REPORT_PENDING];
      if (!pending?.runId) return;

      const stale = Date.now() - (Number(pending.startedAt) || 0) > 1000 * 60 * 60 * 2;
      if (String(summary?.runId || "") !== pending.runId) {
        if (stale) await chrome.storage.local.set({ [STORAGE_KEYS.REPORT_PENDING]: null });
        return;
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.REPORT_PENDING]: null });
      if (summary?.dryRun || !(Number(summary?.count) > 0)) return;

      // 8.16: and only when the run finished the step. This is the mark
      // 8.15 stopped carrying forward across rescans, but it was still
      // STAMPED on a run that stopped short, and the two symptoms of that
      // are a "Cleared" chip and a missing Run button, which are the two
      // reasons a user would never think to rescan. A free user has one
      // unlocked step, so being wrong here spends it.
      if (!runFinishedClean(summary)) return;

      // The engine reports ONE aggregate count for the run, so a
      // multi-step plan that dies after its first step would mark every
      // step it was going to run as cleared. Only a single-step run can
      // honestly claim "that step is done"; for a plan, the rescan's
      // fresh counts are the truth and nothing is stamped.
      if (pending.bandIds.length !== 1) return;

      const reportResult = await chrome.storage.local.get(STORAGE_KEYS.REPORT);
      const report = reportResult?.[STORAGE_KEYS.REPORT];
      if (!report?.bands) return;
      const targeted = new Set(pending.bandIds);
      let touched = 0;
      for (const band of report.bands) {
        if (band?.id && targeted.has(band.id)) {
          band.cleanedAt = Date.now();
          touched++;
        }
      }
      if (touched > 0) await chrome.storage.local.set({ [STORAGE_KEYS.REPORT]: report });
    } catch (e) {
      console.error("[GCC SW] resolvePendingReportPurge failed:", e);
    }
  }

  // =========================
  // Smart Suggestions store (7.8)
  // =========================
  // Two local-storage objects. smartScan { updatedAt, senders: [{
  // email, name, score, signals, estCount }] } is UNION-merged across
  // rescans: each scan only measures a handful of senders, so senders
  // from earlier scans keep their place and a re-measured sender takes
  // its fresh values. smartFeedback { bySender: { email: { action,
  // at } } } drives the popup's ranking (dismissed = silenced 90 days,
  // applied = same-domain boost); the map is bounded and the oldest
  // entries fall off first. Bounding mirrors GCC.smart.recordFeedback,
  // duplicated here because the worker is self-contained.

  const SMART_EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.][a-z0-9!#$%&'*+/=?^_`{|}~.-]*@[a-z0-9.-]+\.[a-z]{2,}$/;
  const SMART_MAX_LIST = 50;
  const SMART_MAX_FEEDBACK = 300;

  function sanitizeSmartSignals(raw) {
    const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
    const signals = {
      count: Math.max(0, Math.min(999999, Number(raw?.count) || 0)),
      unreadRatio: clamp01(raw?.unreadRatio),
      oldShare: clamp01(raw?.oldShare),
      shape: Boolean(raw?.shape)
    };
    const estMb = Math.max(0, Math.min(1024 * 1024, Math.round(Number(raw?.estMb) || 0)));
    if (estMb > 0) signals.estMb = estMb;
    return signals;
  }

  // 8.6: `action` and `reachable` are the parity pair. The scan picks
  // the action and measures THAT action's guarded query, so the popup
  // must render the action it was measured against rather than deciding
  // again. An entry with no `reachable` is a pre-8.6 leftover: unknown,
  // not zero, and treated as unknown everywhere downstream.
  const SMART_ACTION_NAMES = ["deleteOld", "archiveAll", "purgeLarge", "unsubscribe"];

  async function recordSmartScan(senders, heldBackSenders, heldBackCount) {
    if (!Array.isArray(senders)) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SMART_SCAN);
      const prev = result?.[STORAGE_KEYS.SMART_SCAN] || {};
      const byEmail = Object.create(null);
      for (const entry of prev.senders || []) {
        if (entry?.email) byEmail[entry.email] = entry;
      }
      for (const raw of senders.slice(0, SMART_MAX_LIST)) {
        const email = String(raw?.email || "").trim().toLowerCase();
        if (!email || email.length > 320 || !SMART_EMAIL_RE.test(email)) continue;
        const entry = {
          email,
          name: String(raw?.name || "").slice(0, 120),
          score: Math.max(0, Math.min(100, Math.round(Number(raw?.score) || 0))),
          signals: sanitizeSmartSignals(raw?.signals),
          estCount: Math.max(0, Math.min(999999, Number(raw?.estCount) || 0))
        };
        if (SMART_ACTION_NAMES.includes(raw?.action)) entry.action = raw.action;
        if (typeof raw?.reachable === "number" && Number.isFinite(raw.reachable)) {
          entry.reachable = Math.max(0, Math.min(999999, Math.round(raw.reachable)));
        }
        byEmail[email] = entry;
      }
      const merged = Object.values(byEmail)
        .sort((a, b) => b.score - a.score || b.estCount - a.estCount)
        .slice(0, SMART_MAX_LIST);
      await chrome.storage.local.set({
        [STORAGE_KEYS.SMART_SCAN]: {
          updatedAt: Date.now(),
          senders: merged,
          heldBackSenders: Math.max(0, Math.min(999999, Math.round(Number(heldBackSenders) || 0))),
          heldBackCount: Math.max(0, Math.min(9999999, Math.round(Number(heldBackCount) || 0)))
        }
      });
    } catch (e) {
      console.error("[GCC SW] recordSmartScan failed:", e);
    }
  }

  async function recordSmartFeedback(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SMART_FEEDBACK);
      const bySender = { ...(result?.[STORAGE_KEYS.SMART_FEEDBACK]?.bySender || {}) };
      for (const raw of entries) {
        const email = String(raw?.email || "").trim().toLowerCase();
        const action = raw?.action === "applied" ? "applied"
          : raw?.action === "dismissed" ? "dismissed" : "";
        if (!action || !email || email.length > 320 || !SMART_EMAIL_RE.test(email)) continue;
        bySender[email] = { action, at: Date.now() };
      }
      let list = Object.entries(bySender);
      if (list.length > SMART_MAX_FEEDBACK) {
        list.sort((a, b) => (Number(a[1]?.at) || 0) - (Number(b[1]?.at) || 0));
        list = list.slice(list.length - SMART_MAX_FEEDBACK);
      }
      await chrome.storage.local.set({
        [STORAGE_KEYS.SMART_FEEDBACK]: { bySender: Object.fromEntries(list) }
      });
    } catch (e) {
      console.error("[GCC SW] recordSmartFeedback failed:", e);
    }
  }

  // 8.15: `cap` exists because the marker has to describe the run that
  // actually happened. The popup's bulk apply is fixed at 25, but an
  // Auto-Pilot sweep can now clear up to the Pro setting, and a marker
  // that named only the first 25 would book applied-feedback for a
  // fraction of the senders the sweep really touched.
  async function recordPendingSmartApply(runId, senders, cap = 25) {
    const id = String(runId || "");
    const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Number(cap) : 25;
    const list = Array.isArray(senders)
      ? senders.filter((s) => typeof s === "string").slice(0, limit)
      : [];
    if (!id || list.length === 0) return;
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.SMART_PENDING]: { runId: id, senders: list, startedAt: Date.now() }
      });
    } catch (e) {
      console.error("[GCC SW] recordPendingSmartApply failed:", e);
    }
  }

  async function resolvePendingSmartApply(summary) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SMART_PENDING);
      const pending = result?.[STORAGE_KEYS.SMART_PENDING];
      if (!pending?.runId) return;

      // Stale guard, same TTL as the purge marker.
      const stale = Date.now() - (Number(pending.startedAt) || 0) > 1000 * 60 * 60 * 2;
      if (String(summary?.runId || "") !== pending.runId) {
        if (stale) await chrome.storage.local.set({ [STORAGE_KEYS.SMART_PENDING]: null });
        return;
      }

      // This run was the apply: consume the marker either way, but only
      // record feedback when mail was actually affected for real.
      await chrome.storage.local.set({ [STORAGE_KEYS.SMART_PENDING]: null });
      if (summary?.dryRun || !(Number(summary?.count) > 0)) return;
      // 8.16: "applied" is what stops a sender being suggested again. A
      // run the user cancelled, or one that ran out of passes with that
      // sender's mail still there, is exactly the case where the
      // suggestion should come back.
      if (!runFinishedClean(summary)) return;

      await recordSmartFeedback(pending.senders.map((email) => ({ email, action: "applied" })));
    } catch (e) {
      console.error("[GCC SW] resolvePendingSmartApply failed:", e);
    }
  }

  // =========================
  // Pro license check (7.12)
  // =========================
  // Auto-Pilot runs unattended, so the worker verifies the stored key
  // itself before every run instead of trusting a flag the popup set.
  // The parse + ECDSA P-256 verify duplicate GCC.license (the worker is
  // self-contained and cannot load shared.js); the autopilot test suite
  // pins the public JWK and the verify behavior against the shared
  // implementation. The keypair and key format are frozen: this block
  // only READS keys, exactly like the popup gates do.

  const LICENSE_PUBLIC_JWK = Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: "H__q7WFppVTV82Txv9zzk-D_uiTwt5qDda_wYvUlq_8",
    y: "3o5uhLw4utuNyDMaGJrIY3Dgbw14PVPWlsMg68lpFhY"
  });

  const LICENSE_STORAGE_KEY = "proLicense";

  // Test seam only: the autopilot suite verifies against an ephemeral
  // keypair. Never set outside tests; production always verifies
  // against LICENSE_PUBLIC_JWK.
  let _testLicenseJwk = null;

  function b64urlToBytes(input) {
    const b64 = String(input).replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function verifyProLicenseKey(rawKey) {
    const key = String(rawKey || "").trim();
    const parts = key.split(".");
    if (parts.length !== 3 || parts[0] !== "GCC1") return false;
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    } catch {
      return false;
    }
    if (!payload || payload.v !== 1 || payload.plan !== "pro") return false;
    try {
      const pubKey = await crypto.subtle.importKey(
        "jwk",
        _testLicenseJwk || LICENSE_PUBLIC_JWK,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pubKey,
        b64urlToBytes(parts[2]),
        new TextEncoder().encode(parts[1])
      );
    } catch {
      return false;
    }
  }

  // 8.6: sync first, local second, same as the pages. The worker gates
  // Auto-Pilot on this, so reading one area meant a sync hiccup could
  // quietly switch off a paid feature on a schedule nobody was watching.
  // 8.7: stop at the first key that VERIFIES, not the first that is a
  // non-empty string. The pages have worked this way since 8.6 and this
  // copy did not, so a stale or truncated value in sync shadowed a good
  // key in local: the popup showed Pro active while Auto-Pilot, whose
  // gate this is, quietly declined every weekly sweep on a schedule
  // nobody was watching. Reading BOTH areas is the whole point of
  // storing in both.
  // 8.14: three answers, not two.
  //
  // Both storage reads below have always swallowed their own errors, so
  // a profile where neither area answers produced an empty candidate
  // list and the function said "free" -- a guess, dressed as a fact.
  // For a gate that is the right guess (see hasProLicense, which still
  // fails closed). For anything that DISCARDS user data on the strength
  // of it, it is not: see recordUndoEntry, where a guess trimmed a
  // Pro user's recovery log from 300 entries to 60, permanently, over a
  // storage hiccup that fixed itself a second later.
  //
  // "unknown" only when BOTH areas are unreachable. One area answering
  // is enough to know, because the licence is written to both.
  async function readLicenseState() {
    let reachable = false;
    const candidates = [];
    try {
      const s = await chrome.storage.sync.get(LICENSE_STORAGE_KEY);
      reachable = true;
      const v = s?.[LICENSE_STORAGE_KEY];
      if (typeof v === "string" && v) candidates.push(v);
    } catch {}
    try {
      const l = await chrome.storage.local.get(LICENSE_STORAGE_KEY);
      reachable = true;
      const v = l?.[LICENSE_STORAGE_KEY];
      if (typeof v === "string" && v && !candidates.includes(v)) candidates.push(v);
    } catch {}
    if (!reachable) return "unknown";
    try {
      for (const key of candidates) {
        if (await verifyProLicenseKey(key)) return "pro";
      }
    } catch {
      // A verify that throws is not a licence. Same reading as before.
      return "free";
    }
    return "free";
  }

  async function hasProLicense() {
    try {
      return (await readLicenseState()) === "pro";
    } catch {
      return false;
    }
  }

  // =========================
  // One-click activation (8.13)
  // =========================
  // The purchase page can hand the freshly minted key straight to the
  // extension, so a buyer is not left copying a 200-character string
  // into a settings page they have never opened. That gap was the one
  // place someone could pay and end up with nothing.
  //
  // Two independent gates, because this is the only door into the
  // extension that a web page can knock on at all:
  //
  //   1. externally_connectable in the manifest. The browser will not
  //      deliver a message from any origin outside that list, so this
  //      listener never even runs for a hostile page.
  //   2. the key is verified here, against the same embedded public
  //      key everything else uses, before it is written. So even a
  //      compromised purchase page cannot grant Pro; it would need the
  //      private signing key, which is what makes Pro Pro.
  //
  // The origin check below is a third, redundant gate. It is cheap, and
  // it means a mistake in the manifest cannot quietly widen this.
  //
  // Firefox does not implement externally_connectable or
  // onMessageExternal, hence the guard: there the purchase page falls
  // back to copy and paste, which is what every version before this
  // one did everywhere.
  const ACTIVATION_ORIGIN = "https://gmail-cleaner-pro.netlify.app";
  // The popup's own paint hint (popup.js STORAGE_KEYS.PRO_HINT). Named
  // here rather than imported because the worker is self-contained;
  // tests/sweep-8-14 pins the two spellings equal.
  const PRO_HINT_KEY = "proActiveHint";

  async function activateLicenseFromPage(rawKey) {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) return { ok: false, error: "no_key" };
    if (key.length > 4096) return { ok: false, error: "too_long" };
    if (!(await verifyProLicenseKey(key))) return { ok: false, error: "invalid_key" };

    // Mirrors GCC.license.save: both areas, and either one landing is a
    // success. Sync is what follows the user to their other browsers;
    // local is what survives a profile with sync switched off.
    const results = await Promise.allSettled([
      chrome.storage.sync.set({ [LICENSE_STORAGE_KEY]: key }),
      chrome.storage.local.set({ [LICENSE_STORAGE_KEY]: key })
    ]);
    if (!results.some((r) => r.status === "fulfilled")) {
      return { ok: false, error: "storage_failed" };
    }

    // 8.14: and the popup's paint hint, which only the popup itself has
    // ever written. It exists so a buyer is not shown padlocks for the
    // 100-300ms the signature check takes -- and the very first popup a
    // buyer opens, seconds after paying, was the one open it was still
    // set false for. Paint only, never a gate, exactly as 8.12 built it.
    try {
      await chrome.storage.local.set({ [PRO_HINT_KEY]: true });
    } catch {
      // A hint that will not cache costs one flash of the free chrome.
    }
    return { ok: true, synced: results[0].status === "fulfilled" };
  }

  if (chrome.runtime?.onMessageExternal?.addListener) {
    chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
      let origin = "";
      try {
        origin = sender?.origin || (sender?.url ? new URL(sender.url).origin : "");
      } catch {
        origin = "";
      }
      if (origin !== ACTIVATION_ORIGIN) {
        console.warn("[GCC SW] Rejected external message from:", origin || "unknown");
        return;
      }

      if (msg?.type === "gmailCleanerPing") {
        sendResponse({ ok: true, version: SW_VERSION });
        return;
      }

      if (msg?.type === "gmailCleanerActivateLicense") {
        activateLicenseFromPage(msg.key)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: e?.message || "failed" }));
        return true;
      }
    });
  }

  // =========================
  // Auto-Pilot (7.12, Pro)
  // =========================
  // A weekly scheduled Smart Suggestions sweep: read-only smartScan,
  // then one archive-only cleanup over the top recommendations. It
  // composes machinery that already exists (the alarm anchoring above,
  // the smartScan run kind, the rulesOverride cleanup path and the
  // smartPendingApply marker); nothing here touches new Gmail DOM.
  //
  // Storage:
  //   sync  autoPilot        { enabled, confirmed, lastRunAt }
  //   local autoPilotState   { pending, preview, lastRun }
  //     pending: { stage: "scan"|"apply", runId, dryRun, observedCount,
  //                startedAt } while a sweep is in flight
  //     preview: { count, at } the first sweep's dry-run tally, kept
  //              until the user confirms live mode
  //     lastRun: { at, count, dryRun } the compact popup summary
  //
  // Preview-first: until autoPilot.confirmed is true every sweep runs
  // as a dry run. The popup shows "would have archived N" with a
  // one-time confirm; only after that do sweeps go live. Guardrails on
  // live sweeps: archive only (never delete), at most
  // AUTOPILOT_MAX_PER_RUN senders, tag-before-action stays on, and the
  // engine's whitelist / protected-keyword / starred / important
  // guards all apply unchanged.

  // 8.12: the interval moved to PRO_SETTINGS_DEFAULTS.autoPilotIntervalDays
  // (7) so the settings page and the alarm read one number.
  const AUTOPILOT_MAX_PER_RUN = 25; // mirrors GCC.smart.LIMITS.MAX_BULK_PER_RUN
  const AUTOPILOT_DISMISS_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  const AUTOPILOT_DOMAIN_BOOST = 6;
  const AUTOPILOT_PENDING_TTL_MS = 1000 * 60 * 60 * 2; // same as run TTL

  // One reading of "is this pending row still worth believing", so a new
  // reader cannot be added without the TTL again. getAutoPilotForPopup
  // was exactly that reader.
  const autoPilotPendingIsFresh = (pending) =>
    Boolean(pending) && (Date.now() - (Number(pending.startedAt) || 0)) < AUTOPILOT_PENDING_TTL_MS;

  // 8.16: three answers, not two, for the same reason readLicenseState got
  // a third in 8.14 and readSafetyList got one in 8.15.
  //
  // All-false is the right answer for the one question this config is asked
  // most often ("may an unattended sweep run?"), because a sweep that
  // cannot prove it was authorised must not run. It is the wrong answer for
  // every WRITE, and there are four of them, each doing `{...cfg, oneField}`
  // and putting the whole object back. A sync read that rejected for a
  // second therefore had a live sweep finish by writing enabled:false and
  // confirmed:false over a paying user's settings: Auto-Pilot turned itself
  // off mid-job, and because `confirmed` went with it, switching it back on
  // dropped it to preview mode, so it archived nothing until they found the
  // confirm button a second time. Nothing anywhere said why.
  //
  // `readable` is an answer about the READ. It must never be written: see
  // autoPilotRecord, which is why every write goes through it.
  async function getAutoPilotConfig() {
    try {
      const r = await chrome.storage.sync.get(STORAGE_KEYS.AUTOPILOT);
      const cfg = r?.[STORAGE_KEYS.AUTOPILOT];
      return {
        enabled: Boolean(cfg?.enabled),
        confirmed: Boolean(cfg?.confirmed),
        lastRunAt: Number(cfg?.lastRunAt) || 0,
        readable: true
      };
    } catch {
      return { enabled: false, confirmed: false, lastRunAt: 0, readable: false };
    }
  }

  // The stored shape, and only the stored shape. Spreading the config
  // straight into a set would file `readable` in the user's synced Google
  // account, where the next reader would coerce it to a setting.
  function autoPilotRecord(cfg, patch) {
    return {
      enabled: Boolean(cfg?.enabled),
      confirmed: Boolean(cfg?.confirmed),
      lastRunAt: Number(cfg?.lastRunAt) || 0,
      ...patch
    };
  }

  async function getAutoPilotState() {
    try {
      const r = await chrome.storage.local.get(STORAGE_KEYS.AUTOPILOT_STATE);
      const s = r?.[STORAGE_KEYS.AUTOPILOT_STATE];
      return s && typeof s === "object" ? s : {};
    } catch {
      return {};
    }
  }

  async function setAutoPilotState(patch) {
    const state = await getAutoPilotState();
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTOPILOT_STATE]: { ...state, ...patch }
    });
  }

  async function restoreAutoPilotAlarm() {
    try {
      const cfg = await getAutoPilotConfig();
      // 8.16: read first, and only clear once the config is proven. The
      // clear used to run before the enabled check, so a sync read that
      // rejected deleted the weekly alarm and then returned before
      // recreating it. Nothing re-arms until the next onStartup or
      // onInstalled, so on a machine that stays up for a fortnight the
      // paid sweep simply never fires again, while the popup keeps
      // reporting it as on (the toggle reads sync, not the alarm).
      //
      // Its twin restoreScheduledAlarms already gets this right by
      // accident: its sync read is NOT swallowed, so a rejection reaches
      // the outer catch before the clear loop. An alarm that fires once
      // too often on an unreadable config is recoverable. A deleted one
      // is not.
      if (!cfg.readable) {
        console.warn("[GCC SW] Auto-Pilot config unreadable, leaving the existing alarm alone");
        return;
      }
      await chrome.alarms.clear(AUTOPILOT_ALARM);
      if (!cfg.enabled) return;
      // 8.12: the interval is a Pro setting now. Reading it through
      // readProSettings means a copy whose key was removed falls back to
      // weekly rather than keeping a 30-day sweep the user can no longer
      // see or change.
      const pro = await readProSettings();
      const intervalMinutes = pro.autoPilotIntervalDays * 24 * 60;
      // Same anchoring as the schedules above: next fire is last run
      // plus the interval, so browser restarts never defer the sweep;
      // a brand-new enable fires the preview about a minute out.
      const now = Date.now();
      const nextDue = cfg.lastRunAt
        ? cfg.lastRunAt + intervalMinutes * 60 * 1000
        : now + 60 * 1000;
      chrome.alarms.create(AUTOPILOT_ALARM, {
        when: nextDue > now ? nextDue : now + 60 * 1000,
        periodInMinutes: intervalMinutes
      });
    } catch (e) {
      console.error("[GCC SW] restoreAutoPilotAlarm failed:", e);
    }
  }

  // ---- recommendation selection ----
  // Engine-local copies of the GCC.smart policy pieces the sweep needs
  // (whitelist coverage, protected keywords, dismissal TTL, domain
  // boost, ranking, the bulk rule). Duplicated because the worker is
  // self-contained; the autopilot test suite pins each one against the
  // shared implementation so they cannot drift.

  function autoPilotWhitelistCovers(entry, email) {
    const e = String(entry || "").trim().toLowerCase();
    if (!e) return false;
    if (e.startsWith("*@")) return email.endsWith(e.slice(1));
    if (e.includes("@")) return email === e;
    return email.endsWith("@" + e) || email.endsWith("." + e);
  }

  function autoPilotSenderVetoed(sender, whitelist, protectKeywords) {
    const email = String(sender?.email || "").trim().toLowerCase();
    if (!SMART_EMAIL_RE.test(email)) return true;
    const sig = sender?.signals || {};
    if (sig.starred || sig.corresponded) return true;
    if ((whitelist || []).some((w) => autoPilotWhitelistCovers(w, email))) return true;
    const hay = (email + " " + String(sender?.name || "")).toLowerCase();
    return (protectKeywords || []).some((k) => {
      const key = String(k || "").trim().toLowerCase();
      return key && hay.includes(key);
    });
  }

  function autoPilotIsDismissed(feedback, email, now) {
    const fb = feedback?.bySender?.[String(email || "").trim().toLowerCase()];
    if (!fb || fb.action !== "dismissed") return false;
    return (now - (Number(fb.at) || 0)) < AUTOPILOT_DISMISS_TTL_MS;
  }

  function autoPilotDomainBoost(feedback, email) {
    const domain = String(email || "").toLowerCase().split("@")[1] || "";
    if (!domain) return 0;
    for (const [addr, fb] of Object.entries(feedback?.bySender || {})) {
      if (fb?.action === "applied" && (addr.split("@")[1] || "") === domain) {
        return AUTOPILOT_DOMAIN_BOOST;
      }
    }
    return 0;
  }

  // 8.10: Auto-Pilot applies ONE rule shape to every sender it sweeps,
  // `from:(...) older_than:6m` with archive forced on. The scan, since
  // 8.6, picks a per-sender action and measures THAT action's guarded
  // query -- recordSmartScan above says so in as many words, and stores
  // the action next to the count it belongs to. This filter is the half
  // that was missing: the sweep may only take senders whose stored
  // action the sweep's own rule actually honours.
  //
  //   deleteOld   measured on `from:(x) older_than:6m`  -> identical scope
  //   archiveAll  measured on `from:(x)`                -> strict superset
  //   purgeLarge  measured on `from:(x) larger:5M ...`  -> DEFER
  //   unsubscribe moves no mail at all                  -> DEFER
  //
  // Without it, a card reading "40 large emails" handed Auto-Pilot a
  // sweep of every message that sender had ever sent in six months,
  // because the rule drops the `larger:5M` the 40 was counted through.
  // That is the 8.7 bulk-apply bug on the one path nobody watches run.
  // An entry with NO action predates 8.6 and keeps the old behaviour;
  // the sweep rescans before every apply, so those are stale rows only.
  const AUTOPILOT_SWEEPABLE_ACTIONS = ["deleteOld", "archiveAll"];

  function autoPilotActionSweepable(sender) {
    const action = sender?.action;
    if (typeof action !== "string" || !action) return true;
    return AUTOPILOT_SWEEPABLE_ACTIONS.includes(action);
  }

  // Everything that survives the vetoes, ranked, before the action split.
  // Kept separate so the caller can report what it deferred instead of
  // dropping those senders silently.
  function autoPilotEligible(senders, feedback, whitelist, protectKeywords, now = Date.now()) {
    if (!Array.isArray(senders)) return [];
    return senders
      .filter((s) => s && typeof s.email === "string")
      .filter((s) => !autoPilotSenderVetoed(s, whitelist, protectKeywords))
      .filter((s) => !autoPilotIsDismissed(feedback, s.email, now))
      // 8.6: a sender the scan measured as entirely held back by the
      // guards cannot be cleaned, so sweeping it unattended just
      // reports zero on a schedule. A MISSING reachable means "not
      // measured yet", which is not the same as zero.
      .filter((s) => typeof s.reachable !== "number" || s.reachable > 0)
      .map((s) => ({
        email: s.email.trim().toLowerCase(),
        action: typeof s.action === "string" ? s.action : "",
        score: Math.min(100, Math.max(0, Number(s.score) || 0) + autoPilotDomainBoost(feedback, s.email)),
        estCount: Math.max(0, Math.min(999999, Number(s.estCount) || 0))
      }))
      .sort((a, b) => b.score - a.score || b.estCount - a.estCount);
  }

  // 8.13: `cap` is the Pro setting, defaulting to the hardcoded 25 that
  // every caller before this release relied on. It is clamped to the
  // allow-list rather than trusted, because this number decides how much
  // mail an unattended run touches and the value arrives from storage.
  function autoPilotPickSenders(senders, feedback, whitelist, protectKeywords, now = Date.now(), cap = AUTOPILOT_MAX_PER_RUN) {
    const limit = PRO_SETTINGS_MAX_SENDERS.includes(Number(cap))
      ? Number(cap)
      : AUTOPILOT_MAX_PER_RUN;
    return autoPilotEligible(senders, feedback, whitelist, protectKeywords, now)
      .filter(autoPilotActionSweepable)
      .slice(0, limit)
      .map((s) => s.email);
  }

  // How many eligible senders this sweep had to leave alone because the
  // sweep's rule is not the one their number was measured through.
  function autoPilotDeferredCount(senders, feedback, whitelist, protectKeywords, now = Date.now()) {
    return autoPilotEligible(senders, feedback, whitelist, protectKeywords, now)
      .filter((s) => !autoPilotActionSweepable(s))
      .length;
  }

  // 8.8: the worker's own copy of the 512-character ceiling shared.js
  // enforces in validateGmailQuery. The worker is self-contained by
  // design, so this is duplicated rather than imported, and
  // tests/background-autopilot.test.js pins it equal to the shared one.
  const AUTOPILOT_MAX_QUERY_CHARS = 512;
  const AUTOPILOT_RULE_SUFFIX = ") older_than:6m";

  // Returns a LIST of queries. This packed all twenty-five addresses
  // into one from:() group until 8.8, which came to roughly 870
  // characters of realistic newsletter addresses against a 512-character
  // ceiling that nothing on the rulesOverride path ever checked. The
  // storage x-ray hit exactly this in 8.0 and chunks; Auto-Pilot runs
  // unattended and weekly, so it was the one place nobody would see it
  // happen. The cleanup path already accepts several rules.
  //
  // 8.15: `cap` mirrors autoPilotPickSenders. 8.13 taught the picker the
  // Pro setting and left this one on the constant, so choosing 50
  // senders per sweep picked 50 and then built rules for 25: the option
  // was a silent no-op above the default and nothing reported the 25 it
  // dropped. Clamped to the same allow-list for the same reason, and
  // defaulted so the parity with GCC.smart.buildBulkRules (which caps at
  // MAX_BULK_PER_RUN) still holds for every caller that passes nothing.
  function autoPilotBuildRules(emails, cap = AUTOPILOT_MAX_PER_RUN) {
    if (!Array.isArray(emails)) return [];
    const limit = PRO_SETTINGS_MAX_SENDERS.includes(Number(cap))
      ? Number(cap)
      : AUTOPILOT_MAX_PER_RUN;
    const clean = [];
    const seen = new Set();
    for (const raw of emails) {
      if (typeof raw !== "string") continue;
      const email = raw.trim().toLowerCase();
      if (!email || email.length > 320 || !SMART_EMAIL_RE.test(email) || seen.has(email)) continue;
      seen.add(email);
      clean.push(email);
      if (clean.length >= limit) break;
    }
    if (!clean.length) return [];

    const budget = AUTOPILOT_MAX_QUERY_CHARS - "from:(".length - AUTOPILOT_RULE_SUFFIX.length;
    const out = [];
    let group = [];
    let groupLen = 0;
    for (const email of clean) {
      const cost = email.length + (group.length ? 4 : 0);
      if (group.length && groupLen + cost > budget) {
        out.push(`from:(${group.join(" OR ")}${AUTOPILOT_RULE_SUFFIX}`);
        group = [];
        groupLen = 0;
      }
      if (email.length > budget) continue;
      group.push(email);
      groupLen += group.length === 1 ? email.length : cost;
    }
    if (group.length) out.push(`from:(${group.join(" OR ")}${AUTOPILOT_RULE_SUFFIX}`);
    return out;
  }

  // ---- run stages ----
  // MV3 restarts the worker between the alarm, the scan finishing and
  // the apply finishing, so every stage transition lives in storage
  // (autoPilotState.pending) and is driven by the messages the engine
  // already sends: smartScan progress "done" starts the apply, the
  // cleanup's gmailCleanerDone (which carries runId) closes it out.

  async function findGmailTabForAutoPilot() {
    const gmailTabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
    if (!gmailTabs.length) return null;
    const gmailTab = gmailTabs.find((t) => t.active) || gmailTabs[0];
    try {
      await chrome.tabs.get(gmailTab.id);
    } catch {
      return null;
    }
    return gmailTab;
  }

  // 8.11: the worker's copy of the popup's buildScanGuards.
  //
  // 8.6 taught the popup's smart scan to measure every suggestion
  // through the guards its own button applies, and said why in a comment
  // that describes this bug exactly: "sending only whitelist and
  // keywords left sanitizeConfig to default the four guards to ON, which
  // would have measured a user who turned them off against guards they
  // do not have." The Auto-Pilot scan is the fourth scan in the product
  // and the only one that never got it, and its results are not private
  // to Auto-Pilot: recordSmartScan writes them into the same smartScan
  // store the popup's cards read, overwriting whatever the user's own
  // scan measured. So a Pro user who turned Skip Unread off saw
  // "Deletes 200 now" on a card measured with `-is:unread` still
  // attached, and the button under it, which sends their real switches,
  // reached every unread message too.
  //
  // The switches live in the snapshot the popup persists on every run.
  // A missing snapshot reads as all guards ON, which is both the engine's
  // default and the conservative answer.
  // 8.12: the worker's copy of GCC.proSettings.effective.
  //
  // Same reason as bgT and the licence verifier: the worker cannot load
  // shared.js. The rules it mirrors are exact, and tests/pro-settings
  // pins the two against each other so they cannot drift the way
  // hasProLicense did before 8.7.
  //
  // The licence check is not a formality. These values reach unattended
  // runs, so a copy whose key was removed has to fall back to the 8.11
  // behaviour rather than keep sweeping on a 30-day interval nobody can
  // see. Callers that already know the licence state pass it in; the
  // rest let this resolve it.
  const PRO_SETTINGS_DEFAULTS = Object.freeze({
    labelPrefix: "GmailCleaner",
    autoPilotIntervalDays: 7,
    smartScanDepth: "standard",
    autoPilotMaxSenders: 25,
    autoPilotMinAge: "",
    undoLogEntries: 60
  });
  const PRO_SETTINGS_INTERVAL_DAYS = Object.freeze([7, 14, 30]);
  const PRO_SETTINGS_DEPTHS = Object.freeze(["standard", "deep"]);
  const PRO_SETTINGS_MAX_SENDERS = Object.freeze([10, 25, 50]);
  // "" is the "no extra floor" choice, so it belongs in the allow-list
  // and must never be read for truthiness.
  const PRO_SETTINGS_MIN_AGES = Object.freeze(["", "1m", "3m", "6m", "1y"]);
  const PRO_SETTINGS_UNDO_ENTRIES = Object.freeze([60, 150, 300]);
  const PRO_SETTINGS_SIGNAL_SENDERS = Object.freeze({ standard: 10, deep: 20 });
  const PRO_SETTINGS_VETO_SENDERS = Object.freeze({ standard: 15, deep: 30 });
  const PRO_LABEL_BANNED_RE = /["\\/]|[\u0000-\u001f]/;

  async function readProSettings(knownPro) {
    const out = { ...PRO_SETTINGS_DEFAULTS };
    try {
      const isPro = typeof knownPro === "boolean" ? knownPro : await hasProLicense();
      if (!isPro) return out;

      const r = await chrome.storage.sync.get(STORAGE_KEYS.PRO_SETTINGS);
      const stored = r?.[STORAGE_KEYS.PRO_SETTINGS];
      if (!stored || typeof stored !== "object") return out;

      const label = String(stored.labelPrefix ?? "").replace(/\s+/g, " ").trim();
      if (label && label.length <= 32 && !PRO_LABEL_BANNED_RE.test(label)) {
        out.labelPrefix = label;
      }

      const days = Number(stored.autoPilotIntervalDays);
      if (PRO_SETTINGS_INTERVAL_DAYS.includes(days)) out.autoPilotIntervalDays = days;

      const depth = String(stored.smartScanDepth || "");
      if (PRO_SETTINGS_DEPTHS.includes(depth)) out.smartScanDepth = depth;

      const maxSenders = Number(stored.autoPilotMaxSenders);
      if (PRO_SETTINGS_MAX_SENDERS.includes(maxSenders)) out.autoPilotMaxSenders = maxSenders;

      if (typeof stored.autoPilotMinAge === "string"
        && PRO_SETTINGS_MIN_AGES.includes(stored.autoPilotMinAge)) {
        out.autoPilotMinAge = stored.autoPilotMinAge;
      }

      const undoEntries = Number(stored.undoLogEntries);
      if (PRO_SETTINGS_UNDO_ENTRIES.includes(undoEntries)) out.undoLogEntries = undoEntries;

      return out;
    } catch {
      return { ...PRO_SETTINGS_DEFAULTS };
    }
  }

  // 8.14: the recovery-log cap, or null when it cannot be established.
  //
  // Every other Pro setting decides what a run DOES, so readProSettings
  // answering "free defaults" for anything it cannot read is the safe
  // reading. This one decides what gets THROWN AWAY, where the same
  // answer is destructive and irreversible: a Pro user sitting on 300
  // recovery entries loses 240 of them the first time a storage read
  // hiccups, and no later success brings them back.
  //
  // So it is read separately, and every path that cannot prove the
  // user's cap returns null, which recordUndoEntry treats as "leave the
  // log alone". The cost of being wrong that way is one extra entry
  // until the next successful write.
  async function readUndoLogCap() {
    const state = await readLicenseState();
    if (state === "unknown") return null;
    if (state !== "pro") return PRO_SETTINGS_DEFAULTS.undoLogEntries;
    try {
      const r = await chrome.storage.sync.get(STORAGE_KEYS.PRO_SETTINGS);
      const n = Number(r?.[STORAGE_KEYS.PRO_SETTINGS]?.undoLogEntries);
      // Same allow-list readProSettings applies; tests/sweep-8-14 pins
      // the two against each other over every resolvable case.
      return PRO_SETTINGS_UNDO_ENTRIES.includes(n) ? n : PRO_SETTINGS_DEFAULTS.undoLogEntries;
    } catch {
      // A Pro user whose settings will not load is still a Pro user.
      // Trimming to the free cap here would take entries their licence
      // had been keeping.
      return null;
    }
  }

  // The stricter (older) of two Gmail age tokens, or null when neither
  // is usable. A duplicate of GCC.strictestAgeToken, because the worker
  // is self-contained by design; tests/sweep-8-13 pins the two against
  // each other over a shared table of cases.
  const SW_AGE_TOKEN_DAYS = Object.freeze({ d: 1, w: 7, m: 30, y: 365 });

  function swAgeTokenDays(token) {
    const parsed = /^(\d+)\s*([dwmy])$/i.exec(String(token || "").trim());
    if (!parsed) return null;
    const n = parseInt(parsed[1], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n * SW_AGE_TOKEN_DAYS[parsed[2].toLowerCase()];
  }

  function swStrictestAgeToken(a, b) {
    const entries = [a, b]
      .map((token) => ({ token, days: swAgeTokenDays(token) }))
      .filter((entry) => entry.days !== null);
    if (!entries.length) return null;
    return entries.reduce((max, entry) => (entry.days > max.days ? entry : max)).token;
  }

  // Signal and veto budgets always travel together: measuring twenty
  // senders and vetting fifteen would drop five finalists silently.
  function smartScanBudget(depth) {
    const key = PRO_SETTINGS_DEPTHS.includes(depth) ? depth : "standard";
    return {
      smartSignalSenders: PRO_SETTINGS_SIGNAL_SENDERS[key],
      smartVetoSenders: PRO_SETTINGS_VETO_SENDERS[key]
    };
  }

  async function readUserScanGuards() {
    let ui = null;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.LAST_UI);
      ui = stored?.[STORAGE_KEYS.LAST_UI] || null;
    } catch {
      ui = null;
    }
    // `!== false` mirrors restoreLastConfig, which reads a missing switch
    // as on. Boolean() here would silently turn every guard off for
    // anyone whose snapshot predates the key.
    return {
      safeMode: Boolean(ui?.safeMode),
      minAge: typeof ui?.minAge === "string" && ui.minAge ? ui.minAge : null,
      guardSkipStarred: ui?.guardSkipStarred !== false,
      guardSkipImportant: ui?.guardSkipImportant !== false,
      guardSkipUnread: ui?.guardSkipUnread !== false,
      guardSkipUserLabels: ui?.guardSkipUserLabels !== false
    };
  }

  // Which signed-in account a Gmail URL is showing. Gmail carries it in
  // the path as /mail/u/<n>/, and the default (no segment) is "u/0" in
  // practice, so an absent segment reads as "0" rather than as unknown.
  // Only the index is kept: it is what distinguishes two open mailboxes
  // and it is not an address.
  function gmailAccountOf(url) {
    const match = /^https:\/\/mail\.google\.com\/mail\/u\/(\d+)/.exec(String(url || ""));
    return match ? match[1] : "0";
  }

  // 8.11: the tab the scan actually measured, or null. Deliberately not
  // a fallback to "some other Gmail tab": retargeting is the defect this
  // exists to stop, and a sweep that does not run is a sweep that runs
  // correctly next week.
  async function getAutoPilotMeasuredTab(pending) {
    const tabId = Number(pending?.tabId) || 0;
    if (!tabId) return null;
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
    // `/mail/`, not just the host. mail.google.com also serves Chat at
    // /chat/, which chrome.tabs.query's "https://mail.google.com/*"
    // matches and which gmailAccountOf cannot read an account out of, so
    // without this a scan pinned to account 0 would accept a Chat tab as
    // the mailbox it measured.
    if (!tab || !/^https:\/\/mail\.google\.com\/mail\//.test(String(tab.url || ""))) return null;
    // A tab id survives the user switching accounts inside that same
    // tab, which would put the sweep on a mailbox nothing measured.
    // Pre-8.11 pendings carry no `acct`; treat those as matching so an
    // upgrade mid-sweep does not strand one.
    if (pending?.acct !== undefined && gmailAccountOf(tab.url) !== pending.acct) return null;
    return tab;
  }

  async function runAutoPilot() {
    try {
      const cfg = await getAutoPilotConfig();
      if (!cfg.enabled) return;

      // 7.13 install-source guard: same rule as schedules, planted
      // copies never sweep unattended.
      if (await isUntrustedInstall()) {
        console.warn("[GCC SW] Auto-Pilot: untrusted install source, refusing sweep");
        return;
      }

      if (!(await hasProLicense())) {
        console.log("[GCC SW] Auto-Pilot: no valid Pro license, skipping sweep");
        return;
      }

      // The licence just verified, so pass it in rather than making
      // readProSettings verify a second time (WebCrypto, and this is the
      // unattended path).
      const proSettings = await readProSettings(true);

      // Scheduled work honours snooze / vacation mode.
      if ((await snoozeBlocksUnattended()).blocked) {
        console.log("[GCC SW] Auto-Pilot: snoozed (or unreadable), skipping sweep");
        return;
      }

      // Never stomp a run in flight (manual or scheduled).
      if (await hasActiveRun()) {
        console.log("[GCC SW] Auto-Pilot: another run is active, skipping sweep");
        return;
      }

      const state = await getAutoPilotState();
      if (autoPilotPendingIsFresh(state.pending)) {
        console.log("[GCC SW] Auto-Pilot: previous sweep still pending, skipping");
        return;
      }

      const gmailTab = await findGmailTabForAutoPilot();
      if (!gmailTab) {
        console.log("[GCC SW] Auto-Pilot: no Gmail tab open, skipping sweep");
        return;
      }

      // Stage 1: the read-only smart scan. Known senders from earlier
      // scans ride along so discovery costs nothing extra for them.
      const [syncData, localData] = await Promise.all([
        chrome.storage.sync.get([STORAGE_KEYS.WHITELIST, STORAGE_KEYS.PROTECT_KEYWORDS]),
        chrome.storage.local.get([
          STORAGE_KEYS.SMART_SCAN,
          STORAGE_KEYS.SUBSCRIPTIONS,
          STORAGE_KEYS.STORAGE_XRAY
        ])
      ]);
      const whitelist = Array.isArray(syncData?.[STORAGE_KEYS.WHITELIST])
        ? syncData[STORAGE_KEYS.WHITELIST]
        : [];
      const protectKeywords = Array.isArray(syncData?.[STORAGE_KEYS.PROTECT_KEYWORDS])
        ? syncData[STORAGE_KEYS.PROTECT_KEYWORDS]
        : [];
      const known = new Map();
      for (const src of [
        localData?.[STORAGE_KEYS.SMART_SCAN]?.senders,
        localData?.[STORAGE_KEYS.SUBSCRIPTIONS]?.senders,
        localData?.[STORAGE_KEYS.STORAGE_XRAY]?.senders
      ]) {
        for (const s of src || []) {
          if (!s?.email || known.has(s.email)) continue;
          known.set(s.email, {
            email: s.email,
            name: s.name || "",
            count: Number(s.estCount ?? s.count) || 1,
            estMb: Number(s.signals?.estMb ?? s.estMb) || 0
          });
          if (known.size >= 100) break;
        }
      }

      // Same reasoning as the scheduled path: a scan already attached to
      // this tab would swallow the injection, leaving the sweep pending
      // until its TTL with nothing to show for it.
      if (await isEngineAttached(gmailTab.id)) {
        console.log("[GCC SW] Auto-Pilot: engine already attached, skipping this sweep");
        return;
      }

      // 7.15: the pending scan records WHICH tab it is waiting on. The
      // stage machine used to advance on any smartScan that finished, so
      // a Smart Suggestions scan the user started themselves could hand
      // Auto-Pilot its "scan done" and launch a live, unattended archive
      // sweep over up to 25 senders that the user never asked for.
      //
      // 8.7: the tab was not enough. A tab id is stable across
      // navigation, so an Auto-Pilot scan whose engine died when the tab
      // moved (or was swallowed at injection) left the stage armed for
      // its full two-hour TTL, and the user's OWN next Smart scan in
      // that same tab satisfied it. The scan now carries a run id and
      // the stage only advances on a scan that reports that id back.
      //
      // 8.11: the tab id and the run id together still did not say WHICH
      // MAILBOX was measured. Gmail puts the account in the path, so a
      // second signed-in account is `/mail/u/1/`, and the apply stage
      // picked its tab afresh by "whichever Gmail tab is active". See
      // startAutoPilotApply: the account is now pinned here and checked
      // there.
      // 8.15: `enabled` was read once at the top of this function, and
      // everything between there and here is awaited work: a management
      // round trip, a licence verify with a P-256 signature check, four
      // storage reads, a tabs query, and a scripting probe into the
      // Gmail tab. Turning Auto-Pilot off inside that window landed
      // before this write, so setAutoPilotEnabled saw no pending stage
      // to stop, its `pending: null` was overwritten a moment later, and
      // the sweep went on to churn the user's Gmail tab through thirty
      // searches for a feature they had just switched off. The apply
      // stage already re-reads the licence and the switch for the same
      // reason; the scan stage now does too.
      const freshConfig = await getAutoPilotConfig();
      if (!freshConfig.enabled) {
        console.log("[GCC SW] Auto-Pilot: turned off while the sweep was starting, standing down");
        return;
      }

      const scanRunId = `ap_scan_${Date.now()}`;
      await setAutoPilotState({
        pending: {
          stage: "scan",
          startedAt: Date.now(),
          tabId: gmailTab.id,
          acct: gmailAccountOf(gmailTab.url),
          runId: scanRunId
        }
      });

      const scanConfig = {
        runKind: "smartScan",
        runId: scanRunId,
        // 8.11: see readUserScanGuards. These are the popup's switches,
        // not this sweep's, because the numbers this scan produces are
        // read by the popup's suggestion cards, and a card's promise has
        // to match the button beneath it. The sweep's own apply below
        // keeps its hardcoded all-guards-on config, which is stricter
        // than anything measured here, so it can still only take less
        // than the scan counted -- 8.12 closed the one axis where that
        // was not true, the minimum age, by sending it to the apply too.
        ...(await readUserScanGuards()),
        // 8.12: this scan overwrites the same smartScan store the popup's
        // own scan writes, so it has to measure the same number of
        // senders. A standard-depth sweep landing on a deep-depth user
        // would quietly shorten their suggestion list every week.
        ...smartScanBudget(proSettings.smartScanDepth),
        whitelist,
        protectKeywords,
        smartKnownSenders: [...known.values()],
        debugMode: false,
        version: SW_VERSION
      };

      await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        func: (cfg2) => { window.GMAIL_CLEANER_CONFIG = cfg2; },
        args: [scanConfig]
      });
      await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        files: ["contentScript.js"]
      });

      // Same swallow check the scheduled path makes. A pending stage
      // armed against an engine that never started is the state the run
      // id above exists to make harmless, but clearing it now means the
      // next sweep can try again instead of waiting out the TTL.
      if (!(await confirmInjection(gmailTab.id, scanRunId))) {
        console.warn("[GCC SW] Auto-Pilot: injection was swallowed, no scan started");
        await setAutoPilotState({ pending: null });
        return;
      }

      console.log("[GCC SW] Auto-Pilot: scan stage started");
    } catch (e) {
      console.error("[GCC SW] runAutoPilot failed:", e);
      await setAutoPilotState({ pending: null }).catch(() => {});
    }
  }

  // Stage 2: the scan finished; pick the top recommendations and run
  // one archive-only cleanup over them.
  async function startAutoPilotApply() {
    let claimedRunId = "";
    try {
      // The scan stage's pending row: it carries the tab and the account
      // the suggestions were measured against, and the apply has to land
      // on that same mailbox or not at all.
      const pending = (await getAutoPilotState())?.pending || null;
      const cfg = await getAutoPilotConfig();
      if (!cfg.enabled || !(await hasProLicense())) {
        await setAutoPilotState({ pending: null });
        return;
      }

      // 8.12: the same two reads the scan stage made, re-made here.
      // Only `minAge` is taken from the guards: the four skip switches
      // stay hardcoded ON below, which is deliberately stricter than
      // whatever the user runs manually. Re-reading rather than carrying
      // the values on `pending` is the point -- minutes pass between the
      // stages and the popup stays usable throughout, so the floor in
      // force at APPLY time is the one that should apply.
      const proSettings = await readProSettings(true);
      const guards = await readUserScanGuards();

      // 7.15: the scan stage takes a minute or two, and the popup stays
      // usable throughout because a scan holds no run claim. Only
      // `enabled` and the licence were re-read here, so switching on
      // vacation mode during that window did not stop the live archive
      // sweep it was switched on to prevent. The install-source guard is
      // re-read for the same reason: this is the unattended half.
      if (await isUntrustedInstall()) {
        await setAutoPilotState({ pending: null });
        return;
      }
      if ((await snoozeBlocksUnattended()).blocked) {
        console.log("[GCC SW] Auto-Pilot: snoozed (or unreadable) during the scan, dropping this sweep");
        await setAutoPilotState({ pending: null });
        return;
      }

      const [syncData, localData] = await Promise.all([
        chrome.storage.sync.get([STORAGE_KEYS.WHITELIST, STORAGE_KEYS.PROTECT_KEYWORDS]),
        chrome.storage.local.get([STORAGE_KEYS.SMART_SCAN, STORAGE_KEYS.SMART_FEEDBACK])
      ]);
      const whitelist = Array.isArray(syncData?.[STORAGE_KEYS.WHITELIST])
        ? syncData[STORAGE_KEYS.WHITELIST]
        : [];
      const protectKeywords = Array.isArray(syncData?.[STORAGE_KEYS.PROTECT_KEYWORDS])
        ? syncData[STORAGE_KEYS.PROTECT_KEYWORDS]
        : [];
      const scanned = localData?.[STORAGE_KEYS.SMART_SCAN]?.senders;
      const feedback = localData?.[STORAGE_KEYS.SMART_FEEDBACK];
      const senders = autoPilotPickSenders(
        scanned, feedback, whitelist, protectKeywords, Date.now(), proSettings.autoPilotMaxSenders
      );
      // 8.7's rule for a mixed plan, applied here: run one action group
      // and SAY what was left out. Silently dropping them would read as
      // "Auto-Pilot handled everything" on a sweep that skipped the
      // large-attachment and unsubscribe suggestions on purpose.
      const deferred = autoPilotDeferredCount(scanned, feedback, whitelist, protectKeywords);
      const rules = autoPilotBuildRules(senders, proSettings.autoPilotMaxSenders);

      if (!rules.length) {
        // Nothing safe to sweep: record the visit so the popup can say
        // so, and anchor the next weekly fire.
        const now = Date.now();
        await setAutoPilotState({
          pending: null,
          lastRun: { at: now, count: 0, dryRun: !cfg.confirmed, deferred }
        });
        // 8.16: safe already (the `!cfg.enabled` return above means an
        // unreadable config never reaches here), but written through the
        // record builder like its three siblings so the next person to
        // add a write finds one pattern rather than two.
        if (cfg.readable) {
          await safeSyncSet(
            { [STORAGE_KEYS.AUTOPILOT]: autoPilotRecord(cfg, { lastRunAt: now }) },
            "autoPilot"
          );
        }
        console.log("[GCC SW] Auto-Pilot: no eligible suggestions, nothing to sweep");
        return;
      }

      // 8.11: this called findGmailTabForAutoPilot() again, which prefers
      // whichever Gmail tab is ACTIVE right now. The scan stage runs for
      // minutes with the browser fully usable, so a user signed in to two
      // accounts only had to look at the other one for the sweep to
      // archive mailbox B against suggestions measured in mailbox A -
      // unattended, up to 25 senders, `from:(sender) older_than:6m`.
      // The pinned tab from the scan is the only correct target.
      const gmailTab = await getAutoPilotMeasuredTab(pending);
      if (!gmailTab || (await hasActiveRun()) || (await isEngineAttached(gmailTab.id))) {
        await setAutoPilotState({ pending: null });
        return;
      }

      const dryRun = !cfg.confirmed;
      const runId = `autopilot_${Date.now()}`;

      // Claim the run marker so a popup opened mid-sweep refuses to
      // start a second run, exactly like scheduled cleanups do. 8.9:
      // verified, see claimRun. A schedule and this sweep can both be
      // due in the same minute.
      const claim = { gmailTabId: gmailTab.id, runId, startedAt: Date.now(), source: "autopilot" };
      if (!(await claimRun(claim))) {
        console.log("[GCC SW] Another run claimed the marker first, skipping Auto-Pilot apply");
        await setAutoPilotState({ pending: null });
        return;
      }
      claimedRunId = runId;

      // Live sweeps register the pending-apply marker so confirmed
      // applies feed the same feedback loop popup applies do.
      if (!dryRun) {
        await recordPendingSmartApply(runId, senders, proSettings.autoPilotMaxSenders);
      }

      await setAutoPilotState({
        pending: {
          stage: "apply",
          runId,
          dryRun,
          senderCount: senders.length,
          // Rides along so resolveAutoPilotDone can put it on lastRun
          // without re-reading a scan store the finished run may have
          // rewritten underneath it.
          deferred,
          startedAt: Date.now(),
          tabId: gmailTab.id
        }
      });

      const config = {
        // Archive only in v1: never delete, whatever the per-sender
        // recommendation would have led with.
        archiveInsteadOfDelete: true,
        rulesOverride: rules,
        // 8.12: this used to be a hardcoded null, on the reasoning that
        // the rule carries its own older_than:6m so a global floor would
        // only stack a second filter on top. That is true of 3m and 6m
        // and FALSE of 1y, and 8.11 had just taught the scan above to
        // measure through this very floor -- so a user with "Older than
        // 1 year" set saw a sweep counted at one year and run at six
        // months. applyGlobalGuards only appends a floor that is
        // STRICTLY stricter than the rule's own, so passing it through
        // can never widen a sweep, only narrow one. Same call 7.15 made
        // for the X-ray purge and Smart apply; this was the twin.
        //
        // 8.13: and the Pro floor joins it here, by the same rule.
        // swStrictestAgeToken returns whichever of the two is OLDER, so
        // adding this can only ever narrow the sweep. A Pro user who
        // wants unattended runs to keep their hands off anything from
        // this year sets it once; everyone else has "" and this
        // resolves to exactly what the line above did on its own.
        minAge: swStrictestAgeToken(guards.minAge, proSettings.autoPilotMinAge),
        intensity: "light",
        dryRun,
        safeMode: true,
        tagBeforeDelete: true,
        tagLabelPrefix: proSettings.labelPrefix,
        guardSkipStarred: true,
        guardSkipImportant: true,
        guardSkipUnread: true,
        guardSkipUserLabels: true,
        reviewMode: false,
        debugMode: false,
        whitelist,
        protectKeywords,
        version: SW_VERSION,
        scheduled: true,
        runId
      };

      await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        func: (cfg2) => { window.GMAIL_CLEANER_CONFIG = cfg2; },
        args: [config]
      });
      await chrome.scripting.executeScript({
        target: { tabId: gmailTab.id },
        files: ["contentScript.js"]
      });

      // Same swallow check the other two injection sites make. An apply
      // that never started must not hold the claim or leave the stage
      // machine waiting on a done message nothing will send.
      if (!(await confirmInjection(gmailTab.id, runId))) {
        console.warn("[GCC SW] Auto-Pilot: apply injection was swallowed, no engine started");
        await setAutoPilotState({ pending: null });
        await releaseRunClaim(runId);
        claimedRunId = null;
        return;
      }

      console.log(`[GCC SW] Auto-Pilot: ${dryRun ? "preview (dry run)" : "live"} apply started over ${senders.length} sender(s)`);
    } catch (e) {
      console.error("[GCC SW] startAutoPilotApply failed:", e);
      await setAutoPilotState({ pending: null }).catch(() => {});
      // Injection never happened, so no gmailCleanerDone will arrive
      // to release the claim; a stale claim would block manual runs
      // for the whole 2h TTL. Release it only if it is still ours.
      await releaseRunClaim(claimedRunId);
    }
  }

  // Progress messages drive the stage machine. The scan's "done"
  // launches the apply; the apply's "done" stats carry the would-have
  // count a dry run reports (the gmailCleanerDone summary books dry
  // runs as zero, so the count is captured here).
  async function handleAutoPilotProgress(msg, senderTabId) {
    try {
      const state = await getAutoPilotState();
      const pending = state.pending;
      if (!pending) return;

      if (Date.now() - (Number(pending.startedAt) || 0) > AUTOPILOT_PENDING_TTL_MS) {
        await setAutoPilotState({ pending: null });
        return;
      }

      // A run in a different tab is not this sweep. Ignoring it rather
      // than clearing `pending` matters: the sweep Auto-Pilot really did
      // start is still out there and must stay able to report in.
      // Pre-7.15 state carries no tabId, so it keeps the old behaviour.
      if (typeof pending.tabId === "number" &&
          typeof senderTabId === "number" &&
          pending.tabId !== senderTabId) {
        return;
      }

      const terminal = msg.done || msg.phase === "done" || msg.phase === "cancelled" || msg.phase === "error";
      if (!terminal) return;

      if (pending.stage === "scan" && msg.runKind === "smartScan") {
        // 8.7: identity, not just locality. A pending scan armed since
        // 8.7 carries the run id it injected, and only that scan may
        // advance the stage; anything else in the tab is somebody
        // else's and is ignored rather than clearing pending, so the
        // real scan can still report in. Pending state written before
        // 8.7 has no runId and keeps the tab-only behaviour.
        if (pending.runId && String(msg.runId || "") !== String(pending.runId)) {
          return;
        }
        if (msg.phase === "done") {
          // Serialize behind the store writes the scan just queued so
          // the apply reads the union-merged sender list.
          withStorageLock(() => startAutoPilotApply())
            .catch((e) => console.warn("[GCC SW] autopilot apply stage failed:", e?.message || e));
        } else {
          await setAutoPilotState({ pending: null });
        }
        return;
      }

      if (pending.stage === "apply" && !msg.runKind) {
        // 8.9: the same identity rule as the scan stage above, which the
        // apply stage never got. Cleanup progress deliberately omits
        // runKind, so `!msg.runKind` means "some cleanup", and on the
        // error branch that cleared this sweep's pending state for a run
        // that had nothing to do with it. The engine stamps runId on
        // every progress message from 8.9; older engines send none and
        // keep the tab-only behaviour.
        if (pending.runId && msg.runId && String(msg.runId) !== String(pending.runId)) {
          return;
        }
        if (msg.phase === "done" && msg.stats) {
          const modeMatches = (msg.stats.mode === "dry") === Boolean(pending.dryRun);
          if (modeMatches) {
            await setAutoPilotState({
              pending: { ...pending, observedCount: Math.max(0, Number(msg.stats.runCount) || 0) }
            });
          }
        } else if (msg.phase === "error" || msg.phase === "cancelled") {
          await setAutoPilotState({ pending: null });
        }
      }
    } catch (e) {
      console.warn("[GCC SW] handleAutoPilotProgress failed:", e?.message || e);
    }
  }

  // gmailCleanerDone carries the runId, so it is the authoritative
  // close-out for the apply stage.
  async function resolveAutoPilotDone(summary) {
    try {
      const state = await getAutoPilotState();
      const pending = state.pending;
      if (!pending || pending.stage !== "apply") return;
      if (String(summary?.runId || "") !== String(pending.runId || "")) return;

      const cfg = await getAutoPilotConfig();
      const now = Date.now();
      const count = Number.isFinite(Number(pending.observedCount))
        ? Number(pending.observedCount)
        : Math.max(0, Number(summary?.count) || 0);
      // 8.16: whether the sweep finished, carried so the popup's
      // Auto-Pilot line can say "stopped early" rather than report a
      // partial tally as the week's work.
      const finishedClean = runFinishedClean(summary);
      const patch = {
        pending: null,
        lastRun: {
          at: now,
          count,
          dryRun: Boolean(pending.dryRun),
          deferred: Math.max(0, Number(pending.deferred) || 0),
          incomplete: !finishedClean
        }
      };
      if (pending.dryRun) {
        // The anti-1-star mechanism: the first sweep's would-have tally
        // waits in the popup for an explicit "turn on for real".
        //
        // 8.16: and only a tally that was finished counts. This number is
        // the one the user presses "Turn on for real" against, so it is
        // consent given on a measurement, which makes a partial one the
        // worst kind to print: a preview cancelled after three senders
        // says "would have archived 40" about a sweep that will reach 25
        // senders. Left unwritten rather than nulled, so an earlier good
        // preview still stands and setAutoPilotState's merge keeps it; the
        // popup then simply keeps offering a preview, which is the
        // outcome a user who stopped one would expect.
        if (finishedClean) patch.preview = { count, at: now };
      } else {
        patch.preview = null;
      }
      await setAutoPilotState(patch);
      // 8.16: this is the write that cost the user their settings. It has
      // no `!cfg.enabled` early return in front of it, so a sync read that
      // rejected while a sweep was finishing put enabled:false and
      // confirmed:false back over a live, paid, confirmed Auto-Pilot. The
      // local patch above still lands either way; skipping only the sync
      // half costs at most one early re-fire of the weekly alarm, because
      // lastRunAt keeps its old value.
      if (cfg.readable) {
        await safeSyncSet(
          { [STORAGE_KEYS.AUTOPILOT]: autoPilotRecord(cfg, { lastRunAt: now }) },
          "autoPilot"
        );
      } else {
        console.warn("[GCC SW] Auto-Pilot config unreadable, not re-anchoring lastRunAt");
      }
      console.log(`[GCC SW] Auto-Pilot: sweep finished (${pending.dryRun ? "preview" : "live"}, ${count} affected)`);
    } catch (e) {
      console.error("[GCC SW] resolveAutoPilotDone failed:", e);
    }
  }

  // ---- popup-facing settings ----

  async function getAutoPilotForPopup() {
    const [cfg, state] = await Promise.all([getAutoPilotConfig(), getAutoPilotState()]);
    return {
      enabled: cfg.enabled,
      confirmed: cfg.confirmed,
      lastRun: state.lastRun || null,
      preview: state.preview || null,
      // 8.11: every other reader of `pending` applies the TTL before
      // trusting it; this one did not, so a sweep whose engine died
      // without a terminal message left the popup saying "A sweep is
      // running right now." indefinitely, while runAutoPilot itself had
      // long since aged the same row out and moved on. The popup was the
      // one surface still believing it.
      pendingStage: autoPilotPendingIsFresh(state.pending) ? state.pending.stage : null
    };
  }

  // The READ has to be inside the lock too, which is the whole point:
  // resolveAutoPilotDone holds the chain for its entire get-merge-set,
  // so a writer that reads first and only locks its write still merges
  // into a snapshot taken before the sweep's write and puts the old
  // lastRunAt back. Locking the set alone changes nothing. The licence
  // check stays outside: it does WebCrypto, touches none of this, and
  // has no business holding the queue while it runs.
  async function setAutoPilotEnabled(enabled) {
    if (enabled && !(await hasProLicense())) {
      return { ok: false, error: "pro_required" };
    }
    // 8.16: refuse rather than guess. This write merges into the whole
    // stored object, so saving the toggle off an unreadable read takes
    // `confirmed` and `lastRunAt` with it: the user's explicit "turn on
    // for real" is gone and the next sweep is a preview they have to
    // confirm a second time. `saved` is reported back so the popup can say
    // the switch did not stick rather than draw it in its new position
    // over a stored value that never changed.
    //
    // The stop-the-sweep half below still runs when switching off, because
    // an engine archiving mail right now matters more than the bookkeeping,
    // and it is safe to do twice.
    let saved = true;
    await withStorageLock(async () => {
      const cfg = await getAutoPilotConfig();
      if (cfg.readable) {
        await safeSyncSet(
          { [STORAGE_KEYS.AUTOPILOT]: autoPilotRecord(cfg, { enabled: Boolean(enabled) }) },
          "autoPilot"
        );
      } else {
        saved = false;
      }
      // 8.11: this sat OUTSIDE the lock, and setAutoPilotState is itself
      // an unlocked get-merge-set. resolveAutoPilotDone holds the lock
      // for its whole get-merge-set of the same key, so a toggle landing
      // beside a finishing sweep merged into a pre-resolve snapshot and
      // put the stale lastRun and preview back. Exactly the half-fix
      // 8.10 found on the sync half of this pair; the local half kept it.
      // setAutoPilotState does not take the lock itself, so calling it
      // from in here cannot deadlock the queue.
      if (!enabled) {
        // 8.12: clearing `pending` was ALL this did about a sweep in
        // flight, and pending is only the bookkeeping. The engine in the
        // Gmail tab kept archiving, and because resolveAutoPilotDone
        // bails when pending is gone, the run that carried on was also
        // never recorded: no lastRun, no count, nothing in the popup.
        // Someone switching Auto-Pilot off while watching it work got a
        // sweep that continued invisibly. Stop the engine and give the
        // claim back, then drop the stage.
        const pending = (await getAutoPilotState())?.pending || null;
        const tabId = Number(pending?.tabId);
        // The stop has to be aimed, not fired at a remembered tab id.
        // `pending` is cleared on every terminal path but survives an
        // engine that died silently (a reload, a crash), and it carries
        // no expiry of its own -- which is exactly why 8.11 introduced
        // autoPilotPendingIsFresh, whose comment asks that no new reader
        // be added without it. Without the identity check as well, a
        // stale row pointing at a tab the user has since started a
        // manual cleanup in would cancel THAT run and release ITS claim.
        // probeEngine answers with the live runId, so ask before firing.
        if (pending && Number.isFinite(tabId) && autoPilotPendingIsFresh(pending)) {
          const probe = await probeEngine(tabId);
          if (probe.reachable && probe.runId && probe.runId === pending.runId) {
            try {
              await chrome.tabs.sendMessage(tabId, { type: "gmailCleanerCancel" });
            } catch {
              // It answered a moment ago; nothing more to do if it stops
              // answering now.
            }
            if (pending.runId) await releaseRunClaim(pending.runId);
          }
        }
        await setAutoPilotState({ pending: null });
      }
    });
    await restoreAutoPilotAlarm();
    if (!saved) return { ok: false, error: "storage_unreadable" };
    return { ok: true, autoPilot: await getAutoPilotForPopup() };
  }

  // Same shape, and losing this write is the worst of the three: the
  // user's explicit "turn on for real" silently reverts to preview mode
  // and Auto-Pilot never archives anything again.
  async function confirmAutoPilot() {
    if (!(await hasProLicense())) {
      return { ok: false, error: "pro_required" };
    }
    // 8.16: and the refusal matters most here, exactly as the comment
    // above says. Writing `confirmed: true` merged onto an unreadable read
    // also writes enabled:false, so the one press that was meant to turn
    // Auto-Pilot loose would switch it off instead. The preview is left in
    // place too, so the confirm button is still there to press again.
    let saved = true;
    await withStorageLock(async () => {
      const cfg = await getAutoPilotConfig();
      if (!cfg.readable) {
        saved = false;
        return;
      }
      await safeSyncSet(
        { [STORAGE_KEYS.AUTOPILOT]: autoPilotRecord(cfg, { confirmed: true }) },
        "autoPilot"
      );
      // Inside the lock for the reason given in setAutoPilotEnabled. The
      // race here loses the preview a finishing dry sweep just wrote, so
      // the confirm button comes back asking about a tally that is gone.
      await setAutoPilotState({ preview: null });
    });
    if (!saved) return { ok: false, error: "storage_unreadable" };
    return { ok: true, autoPilot: await getAutoPilotForPopup() };
  }

  // =========================
  // Completion notification
  // =========================

  // 8.14: the Pro line in the completion notification needed a budget.
  //
  // 8.13 added it with three conditions on the RUN (real, live, unpaid)
  // and none at all on the person. Someone who cleans their mail every
  // morning got the same sales line in a system notification every
  // morning, forever, with no way to stop it short of turning off
  // completion notifications altogether -- which is a genuinely useful
  // feature they would be giving up to silence an ad.
  //
  // Bounded the same way 8.13 bounded the rating ask, and for the same
  // reason Jude gave then ("dont make it too annoying"): a weekly
  // cooldown, and a hard stop after three. Someone who has seen the
  // offer three times and not bought has answered.
  const PRO_PITCH_MAX_SHOWS = 3;
  const PRO_PITCH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

  function shouldPitchProInNotification(stored, now = Date.now()) {
    const seen = stored && typeof stored === "object" ? stored : {};
    if ((Number(seen.shown) || 0) >= PRO_PITCH_MAX_SHOWS) return false;
    const last = Number(seen.lastShownAt) || 0;
    // Never shown, or shown at a time that will not parse: show it.
    if (!last) return true;
    return (Number(now) || 0) - last >= PRO_PITCH_COOLDOWN_MS;
  }

  function noteProPitchShown(stored, now = Date.now()) {
    const seen = stored && typeof stored === "object" ? stored : {};
    return {
      ...seen,
      shown: (Number(seen.shown) || 0) + 1,
      lastShownAt: Number(now) || 0
    };
  }

  async function maybeNotifyDone(summary) {
    try {
      const pref = await chrome.storage.local.get(STORAGE_KEYS.NOTIFY_ENABLED);
      if (!pref?.[STORAGE_KEYS.NOTIFY_ENABLED]) return;
      if (!chrome.notifications?.create) return;
      const count = Number(summary?.count || 0);
      const action = summary?.action === "archive"
        ? bgT("notifActionArchived", "archived")
        : bgT("notifActionTrashed", "moved to Trash");
      const declinedCount = Number(summary?.declined || 0);
      // "0 emails moved to Trash" over a run that was refused reads as a
      // clean mailbox, which is the opposite of what happened.
      const title = (declinedCount > 0 && count === 0 && !summary?.dryRun)
        ? bgT("notifTitleDeclined", "Gmail Cleaner - nothing was cleaned")
        : count === 1
          ? bgT("notifTitleOne", `Gmail Cleaner - 1 email ${action}`, [action])
          : bgT("notifTitleMany", `Gmail Cleaner - ${count} emails ${action}`, [String(count), action]);
      const freedText = String(summary?.freedMb || 0);
      // 8.10: archiving moves mail to All Mail, where it still counts
      // against the quota, so there is no storage figure to report. The
      // engine stopped recording one in 8.9 and every other surface
      // learned to drop the clause rather than print zero (progress.js
      // freedMbOf, the popup's #resultFreedClause, the Stats history
      // column). This notification kept the delete wording for both, so
      // an unattended archive sweep announced "Estimated ~0 MB freed" --
      // and the notification is the ONLY surface an unattended run has.
      let msg;
      // 8.12: a run that was REFUSED is not a run that found nothing.
      // The guardrails auto-decline unattended rather than hang on a
      // confirm nobody will answer, and this notification announced
      // "0 emails moved to Trash / Estimated ~0 MB freed", which reads
      // as a clean mailbox. Checked before the freed-MB wording because
      // it is the more important fact, and only when the run really did
      // nothing, so a run that cleared its smaller rules still reports
      // what it cleared.
      if (declinedCount > 0 && count === 0 && !summary?.dryRun) {
        msg = bgT(
          "notifDeclinedBody",
          "Some rules were too large to run without asking. Open the extension and run it yourself to confirm."
        );
      } else if (summary?.dryRun) {
        msg = bgT("notifDryBody", "Dry run finished. No mail was touched.");
      } else if (summary?.action === "archive") {
        msg = bgT(
          "notifArchiveBody",
          "Moved to All Mail, so your storage is unchanged. Open Stats for details."
        );
      } else {
        msg = bgT("notifLiveBody", `Estimated ~${freedText} MB freed. Open Stats for details.`, [freedText]);
      }

      // 8.16: a run that ran out of passes, or gave up on a rule Gmail
      // kept rate-limiting, left mail behind. The engine says so in a
      // `warning` progress message, and an unattended run has no open page
      // to receive one, so this notification announced a partial sweep as
      // a finished one. Said for dry runs too: a preview that stopped
      // short is a preview of less than the rule holds.
      const shortRules = Number(summary?.stoppedShort) || 0;
      if (shortRules > 0) {
        msg += " " + (shortRules === 1
          ? bgT("notifStoppedShortOne", "1 rule stopped before it finished, so some mail is still there. Run it again to continue.")
          : bgT("notifStoppedShortMany", `${shortRules} rules stopped before they finished, so some mail is still there. Run it again to continue.`, [String(shortRules)]));
      }

      // 8.13: one Pro line, here, because this notification is the only
      // surface an unattended run ever reaches and a run that just
      // cleared real mail is the moment the product proved itself.
      //
      // Three conditions, all deliberate. Only a run that really moved
      // something (a refusal or a dry run has nothing to be pleased
      // about, and pitching over either reads as a bait). Only for
      // someone who has not paid. And it rides in `message`, not in
      // a context line or a button, because Firefox rejects the whole
      // notification for any option it does not implement.
      //
      // 8.14: and a fourth condition, on the person rather than the run.
      // See shouldPitchProInNotification.
      if (count > 0 && !summary?.dryRun && !(await hasProLicense())) {
        // Decide and book in one locked step. maybeNotifyDone is called
        // fire-and-forget outside the queue, so two runs finishing
        // together would otherwise both read shown=0, both write 1, and
        // spend two of the three showings on one moment. Nothing else
        // writes this key, so nesting is not a risk here.
        const pitch = await withStorageLock(async () => {
          const seen = (await chrome.storage.local.get(STORAGE_KEYS.PRO_PITCH))?.[STORAGE_KEYS.PRO_PITCH];
          if (!shouldPitchProInNotification(seen)) return false;
          // Booked before the notification is raised, not after. A write
          // that lands and a notification that fails costs one showing;
          // the other order costs the cap its meaning if the write is
          // the thing that fails.
          await chrome.storage.local.set({
            [STORAGE_KEYS.PRO_PITCH]: noteProPitchShown(seen)
          });
          return true;
        });
        if (pitch) {
          msg += " " + bgT(
            "notifProPitch",
            "Pro sweeps this for you every week: $9.99 once, 30-day money-back guarantee."
          );
        }
      }
      // Keep to the four properties every browser accepts: Firefox
      // rejects notification options it does not implement (priority,
      // buttons, requireInteraction) with a type error.
      await new Promise((resolve) => {
        chrome.notifications.create("", {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title,
          message: msg
        }, () => resolve());
      });
    } catch (e) {
      console.warn("[GCC SW] maybeNotifyDone error:", e?.message || e);
    }
  }

  // =========================
  // Stats Persistence
  // =========================

  async function recordStats(data) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STATS);
      // recordSenderHits can persist a stats object holding only
      // topSenders before the first full run finishes, so a loaded
      // object may be missing the fields below. Backfill each one rather
      // than trusting the stored shape, or categoryBreakdown[cat] throws
      // on a partial object.
      const stats = result?.[STORAGE_KEYS.STATS] || {};
      stats.totalRuns = stats.totalRuns || 0;
      stats.totalDeleted = stats.totalDeleted || 0;
      stats.totalArchived = stats.totalArchived || 0;
      stats.totalFreedMb = stats.totalFreedMb || 0;
      stats.history = Array.isArray(stats.history) ? stats.history : [];
      stats.categoryBreakdown = stats.categoryBreakdown || {};
      stats.dailyStats = stats.dailyStats || {};

      // 8.11: a dry run moves nothing, and every aggregate below was
      // counting it anyway. The engine sends `dryRun` on this very
      // message and nothing here had ever read it.
      //
      // deleted/archived/freedMb happened to survive because the engine
      // sends 0 for those on a preview, but perQuery[].count carries the
      // PROJECTION, so `categoryBreakdown[cat].count += q.count` filed
      // "what a run would have taken" into the lifetime chart the Stats
      // page draws as mail that was cleaned. Preview 5,000 old
      // promotions to check the rule is safe, which is exactly the
      // workflow Dry Run exists for, and the chart claimed 5,000
      // promotions cleaned, permanently. totalRuns and the daily run
      // counter had the same problem in miniature.
      //
      // The history entry below is deliberately still written: it
      // carries `dryRun` and stats.js already renders it with a "dry
      // run" tag, so it is the one surface that tells the truth about a
      // preview rather than hiding it.
      const isDryRun = Boolean(data.dryRun);

      if (!isDryRun) {
        stats.totalRuns++;
        stats.totalDeleted += data.deleted || 0;
        stats.totalArchived += data.archived || 0;
        stats.totalFreedMb += data.freedMb || 0;

        // Category breakdown
        if (data.perQuery) {
          for (const q of data.perQuery) {
            const cat = q.label || "Other";
            if (!stats.categoryBreakdown[cat]) {
              stats.categoryBreakdown[cat] = { count: 0, runs: 0 };
            }
            stats.categoryBreakdown[cat].count += q.count || 0;
            stats.categoryBreakdown[cat].runs++;
          }
        }

        // Daily stats
        const today = new Date().toISOString().slice(0, 10);
        if (!stats.dailyStats[today]) {
          stats.dailyStats[today] = { deleted: 0, archived: 0, freedMb: 0, runs: 0 };
        }
        stats.dailyStats[today].deleted += data.deleted || 0;
        stats.dailyStats[today].archived += data.archived || 0;
        stats.dailyStats[today].freedMb += data.freedMb || 0;
        stats.dailyStats[today].runs++;
      }

      // Run history (keep last 50)
      stats.history.unshift({
        timestamp: Date.now(),
        action: data.action === "archive" ? "archive" : "delete",
        deleted: data.deleted || 0,
        archived: data.archived || 0,
        freedMb: data.freedMb || 0,
        intensity: data.intensity || "normal",
        dryRun: data.dryRun || false,
        duration: data.duration || 0,
        perQuery: data.perQuery || [],
        // 8.16: see the engine's recordStats payload. Clamped like every
        // other number that arrives from the page.
        stoppedShort: Math.max(0, Math.min(999, Number(data.stoppedShort) || 0))
      });
      if (stats.history.length > 50) stats.history.length = 50;

      await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
    } catch (e) {
      console.error("[GCC SW] recordStats failed:", e);
    }
  }

  async function getStats() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.STATS);
      return result?.[STORAGE_KEYS.STATS] || {
        totalRuns: 0,
        totalDeleted: 0,
        totalArchived: 0,
        totalFreedMb: 0,
        history: [],
        categoryBreakdown: {},
        dailyStats: {}
      };
    } catch (e) {
      console.error("[GCC SW] getStats failed:", e);
      return null;
    }
  }

  // 8.14: the last unlocked get-merge-set in the worker, and it shares a
  // key with recordStats, which has been inside the queue for releases.
  //
  // The daily alarm fires whenever it likes. Read the stats, let a run
  // finish and record itself through the lock, then write this stale
  // snapshot back and the run is gone: totalRuns and totalDeleted roll
  // back, the day's dailyStats bucket disappears, and so does the
  // history entry the Stats page hangs that run's Restore button on. A
  // user who cleaned 4,000 emails and then wanted them back would find
  // no record that it happened.
  //
  // Exactly the half-fix 8.10 caught on setAutoPilotEnabled, 8.11 on its
  // local twin and 8.12 on tabs.onRemoved. Nothing calls this from
  // inside the queue (its only caller is the alarm handler), so wrapping
  // it cannot hit the non-reentrancy deadlock.
  async function pruneOldStats() {
    try {
      await withStorageLock(async () => {
        const result = await chrome.storage.local.get(STORAGE_KEYS.STATS);
        const stats = result?.[STORAGE_KEYS.STATS];
        if (!stats?.dailyStats) return;

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        let removed = 0;
        for (const date of Object.keys(stats.dailyStats)) {
          if (date < cutoffStr) { delete stats.dailyStats[date]; removed++; }
        }
        // Nothing aged out, so there is nothing to write. Skipping the
        // write is not an optimisation here: it removes the only way
        // this function can lose a concurrent write at all.
        if (!removed) return;

        await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
      });
    } catch (e) {
      console.error("[GCC SW] pruneOldStats failed:", e);
    }
  }

  // =========================
  // Undo / Backup System
  // =========================

  async function recordUndoEntry(data) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.UNDO_LOG);
      const log = result?.[STORAGE_KEYS.UNDO_LOG] || [];

      // Issue #9: also record the sample of message IDs sniffed from the
      // Gmail list before deletion. We cap to 50 per entry so the log
      // can still hold the last 20 runs without ballooning local
      // storage. Real recovery uses the label, but the IDs let advanced
      // users locate specific threads in Trash.
      const sampledIds = Array.isArray(data.sampledMessageIds)
        ? data.sampledMessageIds.slice(0, 50)
        : [];

      // 8.0: this used to append one entry per PASS and then truncate to
      // 20. The engine records a pass at a time inside
      // `while (pass < PASS_CAP = 150)` for each of up to 11 rules, so a
      // first sweep on a big mailbox pushed its own earliest entries out
      // of the log before it finished, and always evicted every entry
      // from the previous run. The log that exists so a frightened user
      // can undo was destroyed by exactly the run they would want to
      // undo. Passes of the same rule in the same run now merge into one
      // entry, so the log holds runs (what a user thinks in) instead of
      // passes (what the engine thinks in).
      const runId = String(data.runId || "");
      const label = data.label || "";
      const tagLabel = data.tagLabel || "";
      const action = data.action || "delete";
      const count = Number(data.count) || 0;

      const existing = runId
        ? log.find((e) =>
          e &&
          e.runId === runId &&
          e.label === label &&
          e.tagLabel === tagLabel &&
          e.action === action &&
          !e.restoredAt)
        : null;

      if (existing) {
        existing.count = (Number(existing.count) || 0) + count;
        existing.passes = (Number(existing.passes) || 1) + 1;
        existing.timestamp = Date.now();
        // A later pass reporting a tagging failure has to win: recovery
        // eligibility must reflect the worst outcome in the group.
        existing.taggingFailed = existing.taggingFailed || Boolean(data.taggingFailed);
        existing.sampledSenderCount = Math.max(
          Number(existing.sampledSenderCount) || 0,
          Number(data.sampledSenderCount || 0)
        );
        if (sampledIds.length && Array.isArray(existing.sampledMessageIds)) {
          const merged = new Set(existing.sampledMessageIds);
          for (const id of sampledIds) {
            if (merged.size >= 50) break;
            merged.add(id);
          }
          existing.sampledMessageIds = [...merged];
        }
      } else {
        log.unshift({
          id: `undo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          runId,
          timestamp: Date.now(),
          query: data.query || "",
          label,
          count,
          passes: 1,
          action,
          tagLabel,
          intensity: data.intensity || "normal",
          // 5.0 additions for issue #9 partial fix:
          sampledMessageIds: sampledIds,
          sampledSenderCount: Number(data.sampledSenderCount || 0),
          taggingFailed: Boolean(data.taggingFailed)
        });
      }

      // One entry per rule per run, so 60 holds several full sweeps
      // where 20 could not hold one.
      //
      // 8.13: and Pro can raise it. This is the only cap in the product
      // whose limit costs a user something real when it bites, because
      // an entry falling off the end is a run that can no longer be
      // restored from this page. Free keeps 60, which is what every
      // release since 8.0 kept; nothing was taken away to sell.
      //
      // 8.14: and a cap is only applied when the licence state is known.
      // readProSettings hands back the free defaults for any failure it
      // meets, which is right for every other setting (they decide what
      // a run DOES, and the safe reading of "I cannot tell" is "do what
      // free does"). Here the same reading throws away 240 of a Pro
      // user's 300 recovery entries over a storage read that failed for
      // a moment, and there is no getting them back. So: unknown means
      // leave the log alone. The log grows by one entry until a check
      // succeeds, and the next successful write trims it properly.
      const undoCap = await readUndoLogCap();
      if (undoCap !== null && log.length > undoCap) log.length = undoCap;

      await chrome.storage.local.set({ [STORAGE_KEYS.UNDO_LOG]: log });
    } catch (e) {
      console.error("[GCC SW] recordUndoEntry failed:", e);
    }
  }

  // 7.6: a restore run that finished clean (its label search came back
  // empty) stamps restoredAt on every entry it covered. Restoring by
  // label moves back ALL trash/archive mail carrying that label, so
  // every same-label same-mode entry recorded before the restore
  // started is covered by it; entries recorded afterwards belong to a
  // newer run and stay restorable. Additive field only: nothing else
  // about the entry shape changes.
  async function recordRestoreOutcome(data) {
    const tagLabel = String(data?.tagLabel || "").trim();
    const action = data?.action === "archive" ? "archive" : "delete";
    const count = Math.max(0, Math.round(Number(data?.count) || 0));
    const startedAt = Number(data?.startedAt) || Date.now();
    if (!tagLabel || count <= 0) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.UNDO_LOG);
      const log = result?.[STORAGE_KEYS.UNDO_LOG] || [];
      let touched = 0;
      for (const entry of log) {
        if (!entry || entry.restoredAt) continue;
        if (entry.tagLabel !== tagLabel) continue;
        if ((entry.action || "delete") !== action) continue;
        if ((Number(entry.timestamp) || 0) > startedAt) continue;
        entry.restoredAt = Date.now();
        touched++;
      }
      if (touched > 0) {
        await chrome.storage.local.set({ [STORAGE_KEYS.UNDO_LOG]: log });
      }
    } catch (e) {
      console.error("[GCC SW] recordRestoreOutcome failed:", e);
    }
  }

  async function getUndoLog() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.UNDO_LOG);
      return result?.[STORAGE_KEYS.UNDO_LOG] || [];
    } catch (e) {
      console.error("[GCC SW] getUndoLog failed:", e);
      return [];
    }
  }

  // 8.16: the last unlocked writer of a key the queue owns, which is what
  // 8.14 said pruneOldStats was. recordUndoEntry runs LOCKED and is a
  // get-merge-set, so a run finishing while the user confirmed "Clear all
  // recovery log entries?" read the log, this emptied it, and then the merge
  // wrote every entry back. The user's confirmation appeared to do nothing,
  // and the entries they meant to destroy stayed in local storage with their
  // sender labels and thread ids.
  //
  // LOCKED(caller): taken at the router, like recordUndoEntry beside it,
  // because withStorageLock is a plain queue and nesting a locked call
  // inside another deadlocks the worker.
  async function clearUndoLog() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.UNDO_LOG]: [] });
    } catch (e) {
      console.error("[GCC SW] clearUndoLog failed:", e);
    }
  }

  // =========================
  // Schedule Management
  // =========================

  async function getSchedules() {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
      return result?.[STORAGE_KEYS.SCHEDULES] || [];
    } catch (e) {
      console.error("[GCC SW] getSchedules failed:", e);
      return [];
    }
  }

  // Stamp one schedule's lastRun without touching any other row. Serialized
  // against the other sync read-modify-writes for the same reason
  // recordStats is: two of these interleaved lose one of the updates.
  async function markScheduleRan(scheduleId) {
    return withStorageLock(async () => {
      try {
        const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
        const schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];
        const idx = schedules.findIndex((s) => s?.id === scheduleId);
        // Deleted while the run was in flight. Nothing to stamp, and
        // re-adding it would resurrect a schedule the user removed.
        if (idx < 0) return false;
        schedules[idx] = { ...schedules[idx], lastRun: Date.now() };
        await safeSyncSet({ [STORAGE_KEYS.SCHEDULES]: schedules }, "schedules");
        return true;
      } catch (e) {
        console.warn("[GCC SW] Could not stamp schedule lastRun:", e?.message || e);
        return false;
      }
    });
  }

  // 8.10: takes the same lock markScheduleRan does. That function's own
  // comment says it is "serialized against the other sync
  // read-modify-writes" -- but it was the only one of them holding the
  // lock, and a queue one participant joins is not a queue. The race it
  // loses is the 7.15 bug verbatim: a cleanup finishes and stamps
  // lastRun, an Options toggle that read the array a moment earlier
  // writes the whole thing back, the fresh lastRun disappears,
  // restoreScheduledAlarms re-anchors about a minute out, and the run
  // that just finished runs again unattended.
  async function saveSchedule(schedule) {
    return withStorageLock(async () => {
      const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
      const schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];

      const idx = schedules.findIndex(s => s.id === schedule.id);
      if (idx >= 0) {
        // 7.15: keep the stored lastRun unless the caller sent a real
        // one. The Options page binds its row handlers to the list it
        // rendered, so toggling a schedule after a run had fired wrote
        // back that stale object with lastRun: null. restoreScheduledAlarms
        // reads lastRun to anchor the next fire, so a null re-armed the
        // alarm for ~60s out and the cleanup that had just finished ran
        // again a minute later, unattended.
        const storedLastRun = Number(schedules[idx]?.lastRun) || 0;
        const incomingLastRun = Number(schedule?.lastRun) || 0;
        schedules[idx] = {
          ...schedule,
          lastRun: incomingLastRun >= storedLastRun ? schedule.lastRun : schedules[idx].lastRun
        };
      } else {
        schedules.push(schedule);
      }

      // Issue #10: validate quota before writing so users get a clear
      // error rather than silent truncation. The caller needs the throw:
      // the Options page turns it into a visible error.
      try {
        await safeSyncSet({ [STORAGE_KEYS.SCHEDULES]: schedules }, "schedules");
      } catch (e) {
        console.error("[GCC SW] saveSchedule failed:", e);
        throw e;
      }
    });
  }

  // Same lock, same reason: this rewrites the WHOLE array, so a delete
  // racing a lastRun stamp rolls back every other schedule's anchor.
  async function deleteSchedule(scheduleId) {
    return withStorageLock(async () => {
      try {
        const result = await chrome.storage.sync.get(STORAGE_KEYS.SCHEDULES);
        let schedules = result?.[STORAGE_KEYS.SCHEDULES] || [];
        schedules = schedules.filter(s => s.id !== scheduleId);
        // safeSyncSet, not a bare set: this path wrote past the 8KB
        // per-item cap without noticing, which is the silent truncation
        // Issue #10 added the helper to stop.
        await safeSyncSet({ [STORAGE_KEYS.SCHEDULES]: schedules }, "schedules");

        // Clear alarm
        await chrome.alarms.clear(ALARM_PREFIX + scheduleId);
      } catch (e) {
        console.error("[GCC SW] deleteSchedule failed:", e);
      }
    });
  }

  // =========================
  // Whitelist Suggestions
  // =========================

  // =========================
  // Multi-Account Support
  // =========================

  async function listGmailTabs() {
    try {
      const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
      return tabs.map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        account: extractAccountFromUrl(t.url)
      }));
    } catch (e) {
      console.error("[GCC SW] listGmailTabs failed:", e);
      return [];
    }
  }

  function extractAccountFromUrl(url) {
    try {
      const match = url.match(/\/mail\/u\/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch (e) {
      console.error("[GCC SW] extractAccountFromUrl failed:", e);
      return 0;
    }
  }

  // Test seam, mirroring the content script's GCC_TEST_MODE pattern:
  // the autopilot suite pins the worker's duplicated policy pieces
  // against GCC.smart / GCC.license. Production never sets the flag.
  if (typeof globalThis !== "undefined" && globalThis.GCC_SW_TEST_MODE) {
    globalThis.GCC_SW_INTERNALS = {
      LICENSE_PUBLIC_JWK,
      verifyProLicenseKey,
      hasProLicense,
      readLicenseState,
      readUndoLogCap,
      readProSettings,
      pruneOldStats,
      recordStats,
      recordUndoEntry,
      withStorageLock,
      activateLicenseFromPage,
      shouldPitchProInNotification,
      noteProPitchShown,
      PRO_SETTINGS_DEFAULTS,
      PRO_SETTINGS_UNDO_ENTRIES,
      autoPilotWhitelistCovers,
      autoPilotSenderVetoed,
      autoPilotIsDismissed,
      autoPilotDomainBoost,
      autoPilotPickSenders,
      autoPilotEligible,
      autoPilotActionSweepable,
      autoPilotDeferredCount,
      autoPilotBuildRules,
      // 8.15: the sweep's cap has to reach the applied-feedback marker
      // too, so the marker is now testable on its own.
      recordPendingSmartApply,
      restoreScheduledAlarms,
      runAutoPilot,
      runScheduledCleanup,
      isEngineAttached,
      releaseRunClaim,
      restoreAutoPilotAlarm,
      hasActiveRun,
      probeEngine,
      forceResetRun,
      setTestLicenseJwk: (jwk) => { _testLicenseJwk = jwk; }
    };
  }
})();
