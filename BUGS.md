# Known Bugs

## [Severity: High] Async schedule handlers don't return true for sendResponse
- **File:** background.js:187-278
- **Issue:** `chrome.runtime.onMessage.addListener` callback chains `restoreScheduledAlarms()` after `sendResponse()` without returning `true`; MV3 may close the channel before the async chain completes.
- **Repro:** Save or delete a schedule from the options page — state sometimes isn't refreshed until the next background tick or SW restart.
- **Fix:** Return `true` from the listener branch and await the full chain before calling `sendResponse`, or restructure so `restoreScheduledAlarms()` runs before the response.

## [Severity: Medium] tabsSendMessage errors are swallowed generically
- **File:** popup.js:143-150 (callers at 880, 894-902)
- **Issue:** Any `tabsSendMessage` failure is treated as "tab closed"; genuine errors (permission denied, SW crash) are hidden from the user.
- **Repro:** Revoke the `mail.google.com` host permission at runtime, click Cancel — user sees the generic unreachable message.
- **Fix:** Inspect `err.message` and distinguish "Receiving end does not exist"/"No tab with id" from other failures before falling back.

## [Severity: Medium] ACTIVE_RUN race lets two popups inject concurrently
- **File:** popup.js:804-828
- **Issue:** `setActiveRun()` is called after the injection/attached check, so two popups opened in quick succession can both pass the check and inject.
- **Repro:** Click Run in one popup, open another popup immediately and click Run before the first finishes injection.
- **Fix:** Move `setActiveRun(gmailTab.id)` to run before the `alreadyAttached` check, guarding entry atomically.

## [Severity: Low] Default switch branch in content script never responds
- **File:** contentScript.js:511-513
- **Issue:** Unknown message types skip `sendResponse`, so the caller hangs until the port closes.
- **Repro:** Send an unrecognized message type to the content script.
- **Fix:** Add `sendResponse({ ok: false, error: "Unknown message type" })` in the `default` branch.

## [Severity: Low] Dead "monthly" fallback in popup intensity load
- **File:** popup.js:406-409
- **Issue:** Persisted intensity is mapped to "light" at load, so the later `=== "monthly"` fallback is unreachable.
- **Repro:** Save intensity "monthly", reopen popup — value shown as "light"; the fallback branch never runs.
- **Fix:** Remove the dead branch or keep "monthly" as a persisted option.

## [Severity: Low] Whitelist validation inconsistent between options and content script
- **File:** contentScript.js:296-298 vs options.js:288-292
- **Issue:** The content-script regex is looser than the options validator; storage edited by hand can pass options but still break queries.
- **Repro:** Manually write `"user+tag@domain"` to storage, run a cleanup — query may malfunction.
- **Fix:** Share a single validator/regex between options.js and contentScript.js.

## [Severity: Low] shared.sendMessage swallows errors as null
- **File:** shared.js:84-95
- **Issue:** `sendMessage()` returns `null` on failure; callers can't distinguish "no listener" from real errors.
- **Repro:** Stop the background SW mid-run — callers see `null` with no signal.
- **Fix:** Return `{ error }` (or reject) so callers can branch on cause.
