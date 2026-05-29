# Contributing to Gmail One-Click Cleaner

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

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

## Project Structure

```
manifest.json        # Extension manifest (MV3)
shared.css           # Design tokens and shared component styles
shared.js            # Common JS utilities (GCC namespace)
background.js        # Service worker (alarms, messaging, stats)
contentScript.js     # Gmail DOM automation (injected into Gmail)
popup.html/js        # Extension popup UI
progress.html/js     # Live progress dashboard
options.html/js      # Rules & settings page
diagnostics.html/js  # Troubleshooting tools
stats.html/js        # Statistics dashboard
browser-polyfill.js  # Cross-browser compatibility shim
build.js             # Build script (copy, minify, zip)
```

### Architecture

- **`shared.js`** exports a frozen `GCC` object with common utilities (Chrome API detection, storage helpers, toast notifications, formatting, DOM helpers). All extension pages load this before their page-specific JS.
- **`shared.css`** defines CSS custom properties (design tokens) used across all pages.
- **`background.js`** is the MV3 service worker handling alarms, message routing, and data persistence.
- **`contentScript.js`** is injected into Gmail tabs and drives the actual cleanup via DOM automation.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Copy files to `dist/` |
| `npm run build:prod` | Build with JS minification |
| `npm run lint` | Run ESLint |
| `npm run zip` | Build and create `.zip` for distribution |
| `npm run watch` | Watch for changes and auto-rebuild |
| `npm run clean` | Remove `dist/` and zip artifacts |

## Guidelines

- **Open an issue first** for major changes so we can discuss the approach.
- **Keep it simple** — this is a vanilla JS project with no bundler or framework. Keep it that way.
- **Test manually** — Load the extension, open Gmail, and verify your changes work. Test with Dry-Run mode enabled for safe iteration.
- **Follow existing patterns** — Use the `GCC` shared utilities rather than adding new standalone helpers.
- **Security matters** — Never use `innerHTML` with user data. Use `textContent` or the `GCC.createEl()` helper. See [SECURITY.md](SECURITY.md).
- **Lint before committing** — Run `npm run lint` and fix any issues.

## Pull Request Process

1. Fork the repo and create a feature branch (`git checkout -b feature/my-feature`)
2. Make your changes
3. Run `npm run lint` to check for issues
4. Test the extension manually in Chrome
5. Commit with a clear message describing the change
6. Push and open a Pull Request

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
