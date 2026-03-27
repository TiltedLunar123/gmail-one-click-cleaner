# Changelog – Gmail One-Click Cleaner

All notable changes to this project will be documented in this file.
This log tracks user-visible behavior, UI changes, and important internal fixes.

## 4.0.0

- **Background Service Worker**
  - Added persistent background service worker for messaging coordination, scheduling, and stats persistence.
  - Extension no longer relies solely on popup staying open for script injection.

- **Undo / Recovery System**
  - Tracks all cleanup operations with query, label, count, and action type.
  - Recovery log accessible from the new Statistics page with direct Gmail search links.
  - Tagged emails can be found via Gmail label search for easy recovery within 30-day Trash window.

- **Scheduled / Automatic Cleanups**
  - Create daily, weekly, or monthly cleanup schedules via the Options page.
  - Uses chrome.alarms API for reliable recurring execution.
  - Schedules can be enabled/disabled or deleted individually.
  - Requires Gmail to be open in at least one tab.

- **Custom Rules Editor**
  - Build your own Gmail search queries with per-rule action (delete, archive, label only).
  - Custom rules run alongside built-in intensity presets.
  - Manage up to 20 custom rules from the Options page.

- **Multi-Account Support**
  - Detects multiple Gmail tabs (different Google accounts).
  - Account selector pills appear in the popup when multiple accounts are open.
  - Choose which account to clean before starting.

- **Statistics Dashboard**
  - New dedicated stats page with overview cards (total runs, emails cleaned, space freed).
  - 30-day daily activity bar chart.
  - Category breakdown showing which rule categories cleaned the most.
  - Full run history table with intensity, duration, and action type.
  - Auto-refreshes every 30 seconds.

- **Shared CSS & Build Pipeline**
  - Extracted common design tokens and base styles into shared.css.
  - Added package.json with build scripts (esbuild minification, zip packaging).
  - Reduced CSS duplication across all extension pages.

- **Smart Whitelist Suggestions**
  - Tracks sender interactions (opens, replies) to suggest senders you engage with.
  - Suggestion chips appear in the popup for one-click whitelist additions.
  - Protects senders you actually read from being cleaned.

- **Firefox & Edge Support**
  - Added browser-polyfill.js shim for WebExtensions API compatibility.
  - Promisifies Chrome callback APIs and creates browser.* namespace.
  - Extension now works across Chrome, Edge, and Firefox with the same codebase.

- **Build & Development Tooling**
  - Added build.js script for dist packaging and optional JS minification.
  - Added zip creation for Chrome Web Store submissions.
  - Added package.json with lint and build scripts.

## 3.5.0

- **Bug Fixes & UX Improvements**
  - Fixed invalid escape sequences in content script selectors.
  - Improved error handling for edge cases during Gmail DOM automation.
  - Refined rate-limit backoff and recovery logic.
  - Minor UI polish across popup, progress, and options pages.

## 3.4.0

- **Safe Mode Subject Guard**
  - Added subject-line protection for receipts, invoices, order confirmations, shipping notices, and refund emails when Safe Mode is enabled.
- **Adaptive Throttling Improvements**
  - Tuned rate-limit backoff parameters for more reliable long runs.
  - Added de-escalation logic to recover faster after temporary Gmail errors.

## 3.3.0

- **Popup UX overhaul (clearer + safer starts)**
  - Added a real button state machine (starting, running, success) with better status copy.
  - Added toast notifications for key actions and failures.
  - Added best-effort popup progress bar (so users get feedback before the popup auto-closes).
  - Added “open gmail” helper when no Gmail tab is detected.
  - Persisted last-used config more reliably (session + local fallback) so runs feel consistent.

- **Active run detection + quick actions**
  - Popup detects an already-running cleanup via an `activeRun` marker (with a best-effort TTL).
  - Quick actions to **Cancel** or **Open Progress** when a run is active.

- **Progress dashboard v2 (major UI + usability upgrade)**
  - New glass-style Progress page with:
    - Live phase tag + percent bar
    - Activity log with timestamps + log levels
    - Copy logs / Clear logs controls
    - Per-query summary table with counts + duration
    - Cleaner “done / cancelled / error” end states
  - Added keyboard shortcuts:
    - `Esc` cancels run (or skips review when a review modal is open)
    - `Enter` proceeds in review modal
    - `Ctrl/Cmd + C` copies logs (when no text is selected)

- **Review Mode upgrades**
  - Added a proper modal-based review prompt (Proceed / Skip per rule) from the Progress page.
  - Progress page sends explicit signals back to the Gmail tab (`resume` / `skip`) for the current rule.

- **Recovery tools (when Gmail reloads mid-run)**
  - **Reconnect** button: pings the Gmail content script with a timeout and reports success/failure.
  - **Re-inject** button: re-injects last config (if available) + content script to resume progress messaging.

- **Share + support polish**
  - Added “Share” flow (copy Web Store link to clipboard, fallback to opening the link).
  - Tip intent tracking stored locally (user-initiated link clicks only).

- **Internal hardening**
  - More defensive Chrome API checks (tabs/storage/scripting availability).
  - Better URL param parsing for `gmailTabId`.
  - Log caps and DOM caps to prevent runaway memory usage in long runs.

## 3.2.0

- **New Preset: Monthly Light Clean**
  - Added a "Recommended" quick-action button in the popup.
  - Automatically configures the cleaner to **Safe Mode**, **Trash** action, and a **3-month** age limit.
  - Designed for safe, repeated maintenance of old promotions and junk.

- **Storage Freed Calculation**
  - The cleaner now estimates the storage space released (in MB) during the run based on attachment flags and message types.
  - The final result summary now displays: "Deleted X emails / freed Y MB".

- **Smart UI & Onboarding Improvements**
  - **Pin Hint:** Added a dismissible banner encouraging users to pin the extension for easy access.
  - **Mini FAQ:** Added reassurance text in the popup explaining that items go to Trash (30-day safety net) and are not permanently deleted immediately.
  - **Success Actions:** New completion screen with buttons to "Rate on Chrome Web Store" and "Share extension".
  - **Soft Rating Prompt:** A gentle request for a 5-star rating appears after 2-3 successful runs.

- **Affiliate & Support**
  - Added "Jude’s cheap storage & setup picks" section in the Popup and Progress window to recommend physical storage solutions for users running out of digital space.

## 3.0.0

- **Major Feature: Review Mode**
  - Added a "Review matches before action" toggle. When enabled, the cleaner pauses after finding results for a rule, allowing you to see exactly what will be deleted and choose to **Proceed** or **Skip** that specific query before any action is taken.

- **Major Feature: Global Whitelist**
  - Introduced a global exclusion list. You can now specify email addresses (e.g., family or work VIPs) that are automatically excluded from *all* rules, ensuring they are never archived or deleted.

- **Cleanup History**
  - The Diagnostics page now tracks your last 10 runs locally. You can review past performance, including the date, mode (Dry Run vs Live), Archive vs Delete setting, and total conversations affected.

- **Core Improvements**
  - Updated the automation engine to support interactive "Pause/Resume" signals for Review Mode.
  - Migrated run stats storage to `chrome.storage.local` to support history tracking without hitting sync limits.

## 2.10.5

- Stability + clarity patch focused on safer runs and more honest feedback:
  - Added a soft cap on how many conversations a single run will act on, with a confirmation step before continuing on very large inboxes.
  - Improved handling of empty or failed Gmail searches so runs end with clear “nothing matched” or “search failed” messages instead of looking like a silent success.

- More accurate progress and end-of-run reporting:
  - Progress bar now reflects the number of conversations matched at the start of the run, not just rough batches.
  - Tracked counts for “checked”, “labeled / archived”, and “skipped” threads and surfaced them in the end-of-run summary.
  - Dry Run now ends with a “would have affected” summary so you can see what a real run would do without touching your inbox.

- Better safety and recovery behavior:
  - Hardened the content script boot sequence to avoid duplicate injection and to fail visibly if Gmail isn’t ready.
  - Ensured runs cannot stay stuck in a “Running” state after errors, and that cancel / stop exits cleanly.

- Optional Debug mode for advanced users:
  - New toggle in settings that logs key events (start, batches, errors) with a consistent prefix in the browser console.
  - Designed for bug reports and troubleshooting without changing how the cleaner itself behaves.

> Note: 2.10.1–2.10.4 were internal / pre-release iterations. Their changes are folded into the 2.10.5 notes above.

## 2.10.0

- Added new safety guardrails and a non-destructive mode option:
  - You can now choose to **archive** matching conversations instead of deleting them for extra-safe first runs.
  - New global guardrail can skip **starred** and **Important** threads so they’re never touched by bulk cleanups.
  - Added a “minimum age” dropdown so rule sets only act on mail older than 3, 6, or 12 months, even if a rule is looser.

- Improved rule editing and testing on the Options page:
  - Each rule set now includes a quick “open in Gmail” test action so you can preview what a query will match before running a cleanup.
  - Clarified copy around what Light / Normal / Deep target and how Safe Mode further narrows the rules.

- Internal configuration cleanup:
  - Plumbed the new guardrail settings through popup → Gmail tab → content script so everything stays in sync.
  - Kept all behavior **local-only** with no external servers required for these new features.

## 2.9.8

- Fixed issues when running in Brave and multi-Gmail setups:
  - Improved detection of the “active” Gmail tab so cleanup runs against the right account.
  - Reduced dependence on the extension docs / options tab being in focus.
- Hardened content script messaging and reconnection behavior when Gmail reloads mid-run.
- Small polish to the Progress window layout and copy.
- Internal refactors to keep progress logic, rule sets, and UI wiring in sync.

## 2.9.7

- Added a richer Progress window:
  - Live percent complete and current phase text.
  - A summary table with per-query counts and durations.
  - “Tags” area for showing current rule labels / hints.
- Added **Reconnect** and **Re-inject** buttons to recover from:
  - Gmail reloads
  - Lost content script connections
- Improved Cancel behavior:
  - Cancels the current phase cleanly.
  - Closes the progress session without leaving partial state.

## 2.9.6

- Introduced the **Tip / Support panel** in the Progress window:
  - Optional section explaining how to support the project (e.g. small tips).
  - Does not affect privacy or Gmail behavior.
- Tuned the Progress UI styling:
  - Darker background, softer card edges, and more readable text.
  - Better spacing on small windows.

## 2.9.5

- Added optional “tag before trash” behavior in the cleanup flow:
  - Before deleting, messages can be tagged with a dedicated Gmail label.
  - This makes it easier to search the Trash by that label and verify results.
- Internal changes to how rule metadata is passed from options → progress page.
- Minor logging clean-up and more defensive checks for missing DOM elements.

## 2.9.4

- Expanded the **cleanup rule system**:
  - Introduced three intensities: **Light**, **Normal**, **Aggressive**.
  - Each intensity uses its own array of safe Gmail queries (large attachments, promos, social, newsletters, etc.).
- Synced default rules between the options page and the run logic using a shared `DEFAULT_RULES` object.
- Adjusted some default queries to be safer:
  - Slightly older date thresholds for aggressive modes.
  - Clearer focus on bulk, low-value categories.

## 2.9.3

- New Progress window UI (HTML/CSS refresh):
  - Card-based layout with a single clear progress bar.
  - Status line, details text, and compact controls.
- Better error reporting when:
  - No Gmail tab is found.
  - The content script fails to attach.
- Slight performance improvements in how the extension advances between queries.

## 2.9.2

- Improved options page:
  - Cleaner descriptions of each rule set.
  - Safer defaults for new users.
- More robust handling of local storage:
  - Defaults are applied if settings are missing or invalid.
- Reduced redundant messages between popup → background → content scripts.

## 2.9.1

- Added **Safe Mode** toggle:
  - Runs only the safest, least risky rule subset.
  - Skips any “heavier” queries that might get too close to long-term history.
- Improved **Dry Run** behavior:
  - Ensures no destructive actions are taken when Dry Run is on.
  - Still drives the UI and progress screen so users can see what would happen.

## 2.9.0

- Major internal refactor of the run logic:
  - Centralized state management for phases, counts, and errors.
  - Clear separation between “rules” and “execution engine”.
- Better handling of Gmail rate limits and slower accounts:
  - Slight randomized delays between operations.
  - Reduced chance of hitting hard limits during long runs.

---

## 2.8.x

- Added support for more Gmail categories (Updates, Forums) in some rule sets.
- Tuned large-attachment filters (e.g. `larger:20M`, `has:attachment larger:10M older_than:6m`).
- Fixed occasional issues where “Select all conversations” was not clicked properly on some layouts.
- First iteration of the dark theme for the progress window.

---

## 2.7.x

- Introduced **Dry Run** mode for the first time:
  - Simulates the run without deleting messages.
  - Helpful for sanity-checking rules on big, old inboxes.
- Added basic error banners when Gmail layout does not match expected selectors.
- Minor UI cleanup on popup text and buttons.

---

## 2.6.x

- Improved handling when multiple Gmail accounts are open in the same browser session.
- Early support for non-Chrome Chromium browsers (Brave, Edge, etc.).
- Small optimizations to reduce flicker when switching between search queries.

---

## 2.5.x

- More robust detection of key Gmail buttons (search results, select-all, delete).
- Reduced chances of running with Gmail still loading or partially rendered.
- Light performance tweaks and code organization.

---

## 2.0.0 – MV3 Rewrite

- Migrated the extension to **Manifest V3**.
- Re-architected the extension around:
  - A service worker background script.
  - `chrome.scripting` for injecting the Gmail automation.
  - A dedicated Progress page to show run status.
- Added configurable options for future rule tuning.

---

## 1.x – Initial Releases

- First public release of **Gmail One-Click Cleaner**.
- Core feature:
  - Run a sequence of Gmail searches targeting bulk clutter:
    - Promotions
    - Social
    - Newsletters / marketing
    - Large attachments
  - Select all results and delete in bulk.
- Basic popup UI with a single **Run cleanup** button.
- Simple, local-only behavior with no external servers.
