# Gmail One-Click Cleaner

[![CI](https://github.com/TiltedLunar123/gmail-one-click-cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/TiltedLunar123/gmail-one-click-cleaner/actions/workflows/ci.yml)
[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-v7.1.0-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)]()

A browser extension that bulk-cleans Gmail in one click. Run configurable cleanup rules (promotions, social, newsletters, large attachments, etc.) with a live progress dashboard, dry-run mode, review mode, and safety guardrails.

> Works with Chrome, Edge, Brave, and Firefox. One codebase, per-browser builds.

## Features

### Smart Suggestions
The extension recommends what to clean instead of making you configure it. One free, read-only scan finds the senders worth cleaning and says why in plain English ("142 emails, 96% unread, mostly older than 6 months").
- **Hard vetoes first** - a sender is never suggested when they match your whitelist or protected keywords, when any of their mail is starred, or when your Sent folder shows you write to them.
- **One-click apply** - each suggestion runs as an ordinary cleanup (tag first, dry-run honored, undo log, stats), so nothing new can touch mail. Dismissed suggestions stay silent for 90 days.
- **The right action per sender** - storage hogs lead with a purge, stopped floods with a delete, and a sender who still emails weekly while you never open them leads with Unsubscribe (Pro), because deleting would not stop the next batch.
- **Pro** - the full ranked list (top 3 stay free) and bulk apply of checked suggestions in one run.

### Cleanup Modes
- **Live Mode** - Automatically labels and moves matching emails to Trash or Archive
- **Review Mode** - Pause before each batch so you can approve or skip
- **Dry-Run** - Count matches without touching anything

### Safety Guardrails
- **Minimum Age** - Never touch emails newer than your chosen cutoff (3m, 6m, 1y, etc.)
- **Global Whitelist** - Protect specific senders/domains from all rules
- **Protected Keywords** - Protect any message whose *subject* contains your words/phrases (e.g. `tax`, `invoice`, `"flight confirmation"`) from every rule. Applies to manual and scheduled runs.
- **Safe Mode** - Skips riskier categories (receipts, order confirmations, shipping updates)
- **Skip Starred & Important** - Automatically excluded when enabled
- **One-click Restore** - Every tagged run in the Recovery Log has a Restore button that moves that run's mail back to your Inbox using the run's label and Gmail's own Move to Inbox control. Free, like the rest of the safety net.

### Presets
- **Monthly Light Clean** - One-click safe maintenance: Safe Mode + Trash + 3-month age limit

### Focused Targets
One-click chips to clean a single category instead of the full sweep. Each runs a small, age-guarded rule set; all global safety guards still apply.
- **Promotions** - old promotional mail and unsubscribe-bait
- **Big attachments** - large messages and heavy attachments
- **Social & updates** - social, updates, and forum categories
- **No-reply** - newsletters and no-reply senders

### Subscription Scan + Bulk Unsubscribe
Deleting hides old mail; unsubscribing stops new mail. The scan finds every mailing list that emails you and lists the senders by volume.
- **Scan (free)** - read-only. Samples the senders behind your subscription-style mail and shows who is filling your inbox. Changes nothing.
- **Bulk unsubscribe (Pro)** - pick the senders you never read and unsubscribe from all of them in one pass. Drives **Gmail's own built-in Unsubscribe control**, never sketchy links inside message bodies. Senders with no one-click option are flagged for manual follow-up.

### Storage X-ray
When Google says your storage is full, the question is *what exactly is eating it*. The X-ray answers by sender.
- **Scan (free)** - read-only. Walks Gmail's own size searches (`larger:25M`, then the 10 MB and 5 MB tiers) and attributes each large email its tier floor, so every number is a defensible "at least". Shows the total reclaimable estimate and your top three space hogs.
- **Full list + purge (Pro)** - the complete ranked list with one-click purge for the senders you pick. A purge is a normal cleanup run: matches are tagged first, land in Trash (30-day safety net), respect your whitelist, protected keywords and every global guard, and show up in the recovery log. An age filter (default: older than 6 months) keeps recent mail out of it.

## Pro

Pro is a **one-time $5 purchase** (no subscription) that unlocks bulk unsubscribe, the full Storage X-ray, and the full Smart Suggestions list with bulk apply. Everything that is free today stays free forever. Compare: Google One storage starts at about $20 per year, forever.

- Your license key is verified **entirely on your device** with a built-in public key. The extension never contacts a server, not even to check the license.
- The key is a signed token with no personal data. Stored in Chrome sync, so Pro follows you to your other signed-in browsers.
- Buy Pro from the popup or the extension's Options page. Your key is shown right after checkout; revisiting that page re-issues it if you lose it.

### Progress Dashboard
- Live progress bar with phase tracking
- Per-rule results table (count, duration, estimated MB freed)
- Activity log with copy/clear controls
- Recovery tools: Reconnect, Re-inject, Cancel

### Rule Sets
- **Light** - Older mail and large attachments only
- **Normal** - Balanced cleanup (recommended)
- **Deep** - More aggressive (use Dry-Run first)

Example rules:
```
category:promotions older_than:6m
category:social older_than:1y
has:attachment larger:10M older_than:6m
"unsubscribe" older_than:1y
```

---

## Install

### Chrome / Brave / other Chromium
Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc).

### Microsoft Edge
Install straight from the [Chrome Web Store](https://chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc); Edge will ask once to allow extensions from other stores.

### Firefox
Install from [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/gmail-one-click-cleaner@gmail-cleaner-pro.netlify.app/). Firefox gets its own build with an event-page background; features are identical. If cleanup ever reports a permission problem, click **Allow** on the Gmail access banner in the popup (Firefox lets you revoke site access per extension).

### Developer Mode (Load Unpacked)
1. Clone this repo:
   ```bash
   git clone https://github.com/TiltedLunar123/gmail-one-click-cleaner.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the cloned folder
5. Pin the extension, open Gmail, and click the icon to start

For Firefox, build the dedicated bundle first (`npm run build:firefox`), then load `dist-firefox/` as a temporary add-on from `about:debugging`.

---

## Project Structure

```
gmail-one-click-cleaner/
├── manifest.json         # Chrome extension manifest (MV3)
├── shared.css            # Design tokens & shared component styles
├── shared.js             # Common JS utilities (GCC namespace)
├── background.js         # Service worker (alarms, messaging, stats)
├── contentScript.js      # Gmail DOM automation (injected into Gmail tab)
├── popup.html/js         # Extension popup UI and logic
├── progress.html/js      # Live progress dashboard
├── options.html/js       # Rules & settings page
├── diagnostics.html/js   # Troubleshooting tools
├── stats.html/js         # Statistics dashboard
├── browser-polyfill.js   # Cross-browser compatibility shim
├── build.js              # Build script (copy, minify, zip)
├── jest.config.js        # Test configuration
├── tests/                # Unit & integration tests
├── .github/workflows/    # CI pipeline (lint, test, build)
├── icons/                # Extension icons (16, 32, 48, 128)
├── CHANGELOG.md          # Version history
├── CONTRIBUTING.md       # Contribution guidelines
├── SECURITY.md           # Security policy and permissions docs
└── LICENSE               # MIT License
```

---

## Privacy & Data

- **Runs locally** - All cleanup, scanning, and unsubscribing happen in your browser against the Gmail UI. No email content is ever sent anywhere.
- **No data collection** - No analytics, no tracking, no email content, subjects, or credentials leave your device.
- **License stays offline** - Pro keys are verified on-device with a built-in public key. The extension never phones home, not even to check the license. The only network calls are ones you start: opening the Stripe checkout page and its post-purchase activation page (part of the purchase flow, not the extension). No Gmail data is involved in either.
- **Minimal permissions** - `activeTab`, `scripting`, `tabs`, `storage`, `alarms`, `notifications` + Gmail host access. No new permissions were added for Pro.
- **30-day safety net** - Gmail keeps Trash for ~30 days, and every run is labeled before it moves. The Recovery Log's one-click Restore puts a run back in your Inbox; archived runs can come back any time, deleted runs within the 30-day window.

See [SECURITY.md](SECURITY.md) for the full security policy and permissions breakdown.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project architecture, and guidelines.

---

## License

[MIT](LICENSE)
