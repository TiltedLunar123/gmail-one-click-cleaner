# Contributing to Gmail One-Click Cleaner

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

You'll need Node.js 18 or newer.

1. **Clone the repo**
   ```bash
   git clone https://github.com/TiltedLunar123/gmail-one-click-cleaner.git
   cd gmail-one-click-cleaner
   ```

2. **Install dev dependencies**
   ```bash
   npm install
   ```

3. **Load the extension in Chrome**
   - Open `chrome://extensions`
   - Enable **Developer mode** (top-right)
   - Click **Load unpacked** and select the project folder

4. **Make changes and reload**
   - Edit files directly in the project root
   - Click the reload icon on `chrome://extensions` to pick up changes
   - Or run `npm run watch` for auto-rebuilds

### Firefox

Firefox uses its own build with an event-page background (no service worker):

```bash
npm run build:firefox
```

Then load `dist-firefox/` as a temporary add-on from `about:debugging`. Run `npm run lint:firefox` to validate the build with Mozilla's addons-linter before submitting changes that touch the manifest or background script.

## Project Structure

```
manifest.json        # Extension manifest (MV3)
shared.css           # Design tokens and shared component styles
shared.js            # Common JS utilities (GCC namespace)
background.js        # Service worker (alarms, messaging, stats, Auto-Pilot)
contentScript.js     # Gmail DOM automation (injected into Gmail)
popup.html/js        # Extension popup UI
progress.html/js     # Live progress dashboard
options.html/js      # Rules & settings page
diagnostics.html/js  # Troubleshooting tools
stats.html/js        # Statistics dashboard
browser-polyfill.js  # Cross-browser compatibility shim
build.js             # Build script (copy, minify, zip, per-browser targets)
_locales/            # Translations for the popup and store listings
tests/               # Jest suites (jsdom)
netlify/             # Pro checkout site + key-issuing function (never ships in the extension)
```

### Architecture

- **`shared.js`** exports a frozen `GCC` object with common utilities (Chrome API detection, storage helpers, toast notifications, formatting, DOM helpers, license verification, i18n). All extension pages load this before their page-specific JS.
- **`shared.css`** defines CSS custom properties (design tokens) used across all pages.
- **`background.js`** is the MV3 service worker handling alarms, message routing, scheduled runs, and data persistence.
- **`contentScript.js`** is injected into Gmail tabs and drives the actual cleanup via DOM automation.

## Scripts

| Command | Description |
|---------|-------------|
| `npm test` | Run the Jest suite |
| `npm run test:ci` | Jest with coverage (what CI runs) |
| `npm run lint` | Run ESLint |
| `npm run lint:firefox` | Build the Firefox target and validate with addons-linter |
| `npm run build` | Build the Chrome target into `dist/` |
| `npm run build:firefox` | Build the Firefox target into `dist-firefox/` |
| `npm run build:all` | Build both targets |
| `npm run build:prod` | Build with JS minification |
| `npm run zip` | Build and create the Chrome `.zip` for distribution |
| `npm run zip:all` | Build and zip both targets |
| `npm run watch` | Watch for changes and auto-rebuild |
| `npm run clean` | Remove `dist/`, `dist-firefox/`, and zip artifacts |

## Testing

The Jest suite (jsdom environment) is the main safety net, because the engine automates Gmail's obfuscated, frequently-changing DOM and can't be exercised in CI against real Gmail.

- **DOM-fixture tests** in `tests/` simulate Gmail's markup (row grids, toolbars, label menus, unsubscribe dialogs). If you fix a selector or engine behavior, extend the relevant fixture so the fix can't silently regress.
- **Structure pins**: `tests/popup-structure.test.js` asserts every element id `popup.js` uses exists in `popup.html`. Renaming or moving elements will fail tests until both sides agree.
- **Version pins**: version numbers in the HTML badges and config export must match `manifest.json`; tests fail on mismatch, so version bumps touch several files by design.
- Run `npm test` before opening a PR. CI runs lint, tests, and the build on Node 18 and 20 for every PR.

## Translations

The popup UI ships in 7 languages (`_locales/`): English, Portuguese (Brazil), Spanish, French, German, Russian, and Japanese.

- Markup and call sites keep **inline English as the fallback**; translations apply on top via `GCC.i18n` and `data-i18n` attributes. New user-facing popup strings need a key in **every** locale's `messages.json`.
- A literal `$` in `messages.json` must be written `$$` (a single `$` starts a substitution slot and breaks the string).
- `tests/i18n-catalog.test.js` enforces key parity, placeholder parity, and price escaping across locales.
- The cleaning engine's Gmail-side language handling (token tables in `contentScript.js`) is separate from the popup catalogs. Engine strings are researched from Google's own help pages per locale, never guessed; unknown locales are left out on purpose so the engine fails safe.

## Guidelines

- **Open an issue first** for major changes so we can discuss the approach.
- **Keep it simple** - this is a vanilla JS project with no bundler or framework. Keep it that way.
- **Test manually** - Load the extension, open Gmail, and verify your changes work. Test with Dry-Run mode enabled for safe iteration.
- **Follow existing patterns** - Use the `GCC` shared utilities rather than adding new standalone helpers.
- **Security matters** - Never use `innerHTML` with user data. Use `textContent` or the `GCC.createEl()` helper. Never add permissions or network calls; the extension's core promise is that it runs entirely locally. See [SECURITY.md](SECURITY.md).
- **Safety first** - Anything that touches mail must respect the existing guards (whitelist, protected keywords, minimum age, dry-run, tag-before-action). New actions should be recoverable through the Recovery Log.
- **Lint and test before committing** - Run `npm run lint` and `npm test` and fix any issues.

## Pull Request Process

1. Fork the repo and create a feature branch (`git checkout -b feature/my-feature`)
2. Make your changes
3. Run `npm run lint` and `npm test`
4. Test the extension manually in Chrome (and Firefox if your change touches the manifest, background, or permissions)
5. Commit with a clear message describing the change
6. Push and open a Pull Request; CI must pass on Node 18 and 20

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
