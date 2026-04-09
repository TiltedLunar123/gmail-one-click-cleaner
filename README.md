# Gmail One-Click Cleaner

[![CI](https://github.com/TiltedLunar123/gmail-one-click-cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/TiltedLunar123/gmail-one-click-cleaner/actions/workflows/ci.yml)
[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-v4.2.0-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)]()

A Chrome extension that bulk-cleans Gmail in one click. Run configurable cleanup rules (promotions, social, newsletters, large attachments, etc.) with a live progress dashboard, dry-run mode, review mode, and safety guardrails.

> Works with Chrome, Edge, Brave, and Firefox.

## Features

### Cleanup Modes
- **Live Mode** — Automatically labels and moves matching emails to Trash or Archive
- **Review Mode** — Pause before each batch so you can approve or skip
- **Dry-Run** — Count matches without touching anything

### Safety Guardrails
- **Minimum Age** — Never touch emails newer than your chosen cutoff (3m, 6m, 1y, etc.)
- **Global Whitelist** — Protect specific senders/domains from all rules
- **Safe Mode** — Skips riskier categories (receipts, order confirmations, shipping updates)
- **Skip Starred & Important** — Automatically excluded when enabled

### Presets
- **Monthly Light Clean** — One-click safe maintenance: Safe Mode + Trash + 3-month age limit

### Progress Dashboard
- Live progress bar with phase tracking
- Per-rule results table (count, duration, estimated MB freed)
- Activity log with copy/clear controls
- Recovery tools: Reconnect, Re-inject, Cancel

### Rule Sets
- **Light** — Older mail and large attachments only
- **Normal** — Balanced cleanup (recommended)
- **Deep** — More aggressive (use Dry-Run first)

Example rules:
```
category:promotions older_than:6m
category:social older_than:1y
has:attachment larger:10M older_than:6m
"unsubscribe" older_than:1y
```

---

## Install

### From Chrome Web Store
Search **"Gmail One-Click Cleaner"** in the [Chrome Web Store](https://chromewebstore.google.com/).

### Developer Mode (Load Unpacked)
1. Clone this repo:
   ```bash
   git clone https://github.com/TiltedLunar123/gmail-one-click-cleaner.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the cloned folder
5. Pin the extension, open Gmail, and click the icon to start

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

- **100% local** — All operations run in your browser. No external servers.
- **No data collection** — No analytics, no tracking, no email content sent anywhere.
- **Minimal permissions** — `activeTab`, `scripting`, `tabs`, `storage` + Gmail host access.
- **30-day safety net** — Gmail keeps Trash for ~30 days. Restore anything deleted by mistake.

See [SECURITY.md](SECURITY.md) for the full security policy and permissions breakdown.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project architecture, and guidelines.

---

## License

[MIT](LICENSE)
