# Security Policy - Gmail One-Click Cleaner

Gmail One-Click Cleaner is an MV3 browser extension (Chrome, Edge, Brave, Firefox) that automates **safe Gmail searches** and bulk cleanup actions. It does **not** exfiltrate email content, attachments, or credentials.

This document explains what the extension can access, what data (if any) leaves your browser, and how to report issues.

---

## Supported Versions

I aim to support the latest published store release (Chrome Web Store and Firefox Add-ons) and the current dev/unpacked build:

| Version | Status | Description |
| :--- | :--- | :--- |
| **Latest store release (7.x)** | ✅ Supported | Current Chrome Web Store / Firefox Add-ons release (recommended) |
| **Dev / Unpacked** | ⚠️ Best-effort | Current GitHub or local “Load unpacked” build |

If you find a security issue in an older version, please confirm it still exists in the latest Stable or Dev build before reporting.

---

## Permissions & Data Access

Gmail One-Click Cleaner requests only the permissions needed to automate cleanup and show progress.

### Chrome permissions

- `activeTab`
  - Lets the extension act on the tab you clicked it from (usually Gmail).

- `tabs`
  - Lets the popup find an appropriate Gmail tab, open the Progress dashboard, and open user-clicked support links.

- `scripting`
  - Injects the cleanup content script and small config snippets into your Gmail tab.

- `storage`
  - Saves your rules, last-used settings, run history, and small UI preferences.

- `alarms`
  - Powers scheduled cleanups and the weekly Auto-Pilot sweep (Pro). Timers only; no data involved.

- `notifications`
  - Shows the local “cleanup finished” notification. Nothing is sent anywhere.

### Host permissions

- `https://mail.google.com/*`
  - Required to read the Gmail UI (DOM) and trigger built-in Gmail actions (search, select, label, move to Trash/Archive).

---

## What the extension does inside Gmail

Inside Gmail, the extension:

- Reads and manipulates **page structure (DOM)** to:
  - Run Gmail search queries
  - Detect result state and selection counts
  - Click built-in Gmail UI controls (select all, label, move to Trash, archive)

- Uses **Gmail’s own search syntax** (example: `category:promotions older_than:6m`) to target low-value mail.

- **Subscription scan + bulk unsubscribe:** samples the sender
  addresses behind subscription-style mail so the popup can list who is
  filling your inbox (the scan is read-only and changes nothing). For
  the senders you choose, the extension opens one of their messages and
  clicks **Gmail’s own built-in Unsubscribe control** (the header
  "Unsubscribe" link and its confirmation dialog). It never follows
  unsubscribe links inside message bodies, which can point anywhere;
  only Gmail’s native, list-unsubscribe-backed control is used. Sender
  addresses are validated to a strict email shape before being placed
  in a `from:(...)` search, so a crafted address can never break out of
  the query.

- **Storage X-ray and Smart Suggestions scans:** both are read-only.
  They walk Gmail’s own size searches (`larger:25M` etc.) and a small
  set of signal queries (unread ratio, age, starred, Sent activity) to
  rank senders locally. Applying a suggestion or purge runs as an
  ordinary cleanup with every guard below intact.

- **Auto-Pilot (Pro):** the weekly scheduled version of the Smart
  Suggestions sweep. Its first run is always a dry run and it waits for
  an explicit confirm in the popup before any sweep touches mail. It
  only ever archives (never deletes), caps each sweep, tags everything
  first, and verifies the license on-device before each run. It uses no
  new permissions and no network.

- Applies **local safety logic** before taking action:
  - **Whitelist:** If you set a Global Whitelist, the extension appends exclusions (example: `-from:email@domain.com`) to every query locally.
  - **Protected Keywords:** If you list keywords, the extension appends a subject exclusion (example: `-subject:(tax OR "flight confirmation")`) to every query locally, so matching mail is never touched.
  - **Skip Starred / Important:** When enabled, the extension avoids acting on starred/important conversations.
  - **Safe Mode:** Skips riskier categories/rules (example: updates/receipts) depending on the rule set and toggles.
  - **Minimum Age:** Enforces a global cutoff (3m, 6m, etc.) so newer mail is not touched.
  - **Review Mode:** If enabled, the run pauses and the Progress page asks you to **Proceed** or **Skip** before acting on a batch.
  - **Monthly Light Clean preset:** A predefined local configuration (Safe Mode on, Trash action, 3-month age limit).

- Uses Gmail’s controls to:
  - Select conversations
  - Apply labels like `GmailCleaner - Promotions` (optional, before action)
  - Move selected conversations to **Trash** or **All Mail** (Archive)

It does **not**:

- Read or transmit raw email bodies or attachment contents
- Bypass Gmail authentication or permissions
- Store or transmit your Google credentials

All automation runs locally in your browser against the Gmail UI using standard Gmail actions.

---

## What data is stored locally

The extension stores small values using `chrome.storage` so your settings persist.

### Sync Storage (may sync across your Chrome instances)
- Rule sets / custom rules
- Global Whitelist (emails/domains to protect)
- Protected Keywords (subject words/phrases to protect)
- Preferences (example: Debug Mode)
- Lightweight counters (example: successful run count for showing the rating prompt)
- **Pro license key** (`proLicense`), if you bought Pro. It is a signed
  token, not a password, and it carries no personal data (only a
  version, the plan name `pro`, a short purchase-session tail, and a
  timestamp). Storing it in sync means Pro follows you to your other
  signed-in Chrome browsers.

### Local or Session Storage (device-only / ephemeral)
- `lastConfig` (last-used popup toggles like Dry-Run, Review Mode, Safe Mode, min age, action type)
- `activeRun` best-effort marker (Gmail tab ID + start time) so the popup can detect an ongoing run
- Small UI flags (example: `pinHintDismissed`, `ratingPromptDismissed`)
- Optional run history / last-run stats used for diagnostics and progress summaries (counts, durations, estimates)
- Scan results from the subscription scan, Storage X-ray, and Smart
  Suggestions: sender **addresses** with counts, size estimates, and
  per-sender status. These stay on your device and exist so the popup
  can show the lists without rescanning. They are the only place any
  part of your mailbox’s contents is persisted, and it is limited to
  sender addresses, never message content.

No email bodies, subjects, message IDs, attachment contents, or Gmail credentials are stored or sent.

---

## Network calls

The extension does not “phone home” and does not use analytics trackers.
It never contacts a server on its own, not on startup, not during a
cleanup, and **not even to check your Pro license**. License keys are
verified entirely offline: the extension carries the matching public
key and checks the signature with the browser’s built-in WebCrypto. A
valid key works with no network at all.

External network activity happens only when **you** initiate it:
- Opening the **Get Pro** checkout page (Stripe) from a button.
- The post-checkout activation page (hosted at
  `gmail-cleaner-pro.netlify.app`) fetching your key. This page is part
  of the purchase flow, not the extension; the extension does not call
  it. That page verifies your Stripe checkout session and returns a
  signed key. No Gmail data is involved.
- Store / share links you choose to open.

These are normal browser navigations or purchase-flow calls initiated by
you. Your Gmail content is never part of any of them.

---

## Install-source guard

The extension checks how its own copy was installed (via
`chrome.management.getSelf`, which needs no extra permission). A copy
that was planted by third-party software rather than installed from an
official store shows a permanent warning banner pointing to the real
listing, and **scheduled cleanups and Auto-Pilot refuse to run** on such
a copy, so a sideloaded copy can never act on a mailbox unattended.
Store installs, unpacked developer builds, and enterprise-policy
deployments are unaffected. The Diagnostics page shows the detected
install source next to the version.

---

## Progress, Messaging, and Safety Signals

During a run, the extension uses Chrome’s local extension messaging:
- Content script sends progress updates to the Progress page (`chrome.runtime.onMessage`)
- Progress page can send control signals back to the Gmail tab:
  - Cancel
  - Review decisions (Proceed / Skip)
  - Reconnect ping
  - Re-inject content script (best-effort recovery)

These messages stay within the browser and do not leave your device.

---

## Diagnostics & Debugging

A Diagnostics page is included to help debug tab selection and injection issues:

- Lists open Gmail tabs (tab ID/window ID, truncated URL)
- Shows which Gmail tab the popup will pick
- Shows environment info (browser/platform/extension version and permissions)
- Can run a **Test inject** that logs a timestamp/URL to the Gmail tab’s console

Diagnostics are meant for troubleshooting selector issues, tab selection, and script injection problems. They do not read or send email content.

---

## How to Report a Vulnerability

If you believe you’ve found a security or privacy issue (unexpected data access, arbitrary code execution, permission misuse, etc.):

1. Do **not** post full exploit details publicly (Chrome reviews, social media).
2. Collect:
   - Extension version (from `chrome://extensions` or the Web Store)
   - Browser + version
   - OS
   - Exact reproduction steps
   - Relevant console logs/screenshots (sanitize personal data)

3. Report via one of:
   - **GitHub Issues:** Create an issue titled **[Security] ...** with a high-level, non-sensitive summary.
   - **Chrome Web Store Support:** Use “Security issue” in the subject with a high-level summary.

If extra-sensitive details are needed, you can offer to share them privately after initial triage.

---

## Responsible Disclosure

Please allow reasonable time to investigate and fix issues before public disclosure.

In general:
- I’ll acknowledge security-relevant reports quickly.
- Serious issues are prioritized for a Web Store update.
- Release notes may reference “security hardening” without disclosing exploit details until most users have updated.

---

## Hardening Suggestions & Feedback

If you have ideas to make Gmail One-Click Cleaner safer (safer defaults, reduced permissions, threat scenarios, sandboxing ideas):

- Open a GitHub issue labeled **enhancement** or **security hardening**
- Or send a short proposal via the Chrome Web Store support channel

Thanks for helping keep users safe.
