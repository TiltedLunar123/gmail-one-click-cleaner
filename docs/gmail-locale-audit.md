# Gmail locale-independence audit (written for 7.4.0, revised for 7.5.0 and 7.6.0)

The engine drives Gmail's UI directly, so anything that matches on-screen
text silently breaks on non-English Gmail accounts. This audit walks every
selector and string match in `contentScript.js`, classifies each as
structure/attribute-based (safe in any language), language-dependent
(breaks outside the covered locales), or mixed, and states the blast
radius when it misses. Fixture tests locking in the language-independent
paths, and since 7.5 the localized ones, live in
`tests/contentScript-locale.test.js`.

Verdict up front: the destructive path (find rows, select, delete or
archive) is structure-first with multilingual token fallbacks, so core
cleanup works on non-English accounts. The genuinely English-only spots
the 7.4 audit found were all in secondary paths: the unsubscribe
control's text check, the unsubscribe dialog's button classification,
rate-limit detection, the thin archive/label token tables, and the
subscription scan's English search term. 7.5 closed all five (details in
the sections below); the new dialog and search tokens were verified per
locale against Google's own localized Gmail help pages rather than
guessed, and locales that could not be verified were left out because
this path clicks buttons on the user's behalf: an unmatched dialog is
dismissed, which fails safe, while a mismatched one would not.

## Classification key

- **STRUCTURE**: roles, ARIA state, Gmail class names, data attributes,
  URL hashes, Gmail search operators. Locale-proof (class names can still
  rot, but that is layout drift, which the 7.4 layout-change detection
  now reports, not a locale problem).
- **LANG**: matches human-readable text or label words.
- **MIXED**: structural scoping with a language token inside it.

## 1. Master select-all checkbox

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `SELECTORS.toolbarCheckbox`: `div[gh='mtb'] [role='checkbox']`, `div[role='toolbar'] [role='checkbox']` | `findMasterCheckbox` | STRUCTURE | Low. Primary discovery is role plus toolbar container. |
| `div[aria-label='Select'] div[role='checkbox']` (last two entries) | `SELECTORS.toolbarCheckbox`, `isInToolbarArea` | MIXED | None in practice: these are extra candidates and extra score only; the role-based selectors fire first in any locale. |
| `label.includes("select")` scoring bonus (+5) | `scoreCheckboxCandidate` | LANG | None. It is a tie-breaker bonus. The structural signals (in-toolbar +10, not-in-row, near-top) dominate, proven by fixture: a German "Auswählen" checkbox still wins. |
| Per-row fallback `tr[role='row']` > `[role='checkbox']`, `aria-checked` | `selectAllVisibleRowsIndividually` | STRUCTURE | Low. This is the path that actually populates Gmail's selection model, and it is fully locale-proof. |

## 2. Row selection state and counting

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `tr[role="row"].x7` selected-row class | `extractSelectedCount` | STRUCTURE | Low (class-rot risk only). Primary signal, locale-proof. |
| `[role="checkbox"][aria-checked="true"]` cross-check | `extractSelectedCount` | STRUCTURE | Low. |
| Legacy text scrape `/all\s+(N)\s+conversations?\s+.*selected/i` | `extractSelectedCount` | LANG | None on current Gmail: it only runs when the grid is absent (older layouts). On a non-English legacy layout the count reads null and the engine falls back to row-count deltas. |
| `getGridRowCount`: `div[role='main']` > `table[role='grid']` > `tr[role='row']` | pass loop, 7.4 detection | STRUCTURE | Low. |

## 3. Toolbar action buttons (Delete / Archive)

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| Candidate set `div[role='button'], button, span[role='button']` scoped to `div[gh='mtb']` / `div[role='toolbar']` | `findButtonByTokens` | STRUCTURE | Low. |
| `DELETE_LABEL_TOKENS` (27 tokens: en/es/fr/de/pt/it/nl/sv/da/no/pl/tr/ru/ar/ja/ko/zh) + `/delete|trash|bin/i` | `findDeleteButton` | LANG (broad) | Medium. Well covered for major locales, but an uncovered locale (e.g. Czech, Thai, Hindi) scores nothing and the delete click never happens; the run then ends with "No delete button" instead of deleting the wrong thing. Fails safe, but fails. |
| `ARCHIVE_LABEL_TOKENS` + `/archive/i` | `findArchiveButton` | LANG (broad since 7.5) | Medium, same failure shape as delete. 7.5 widened the table from six locales to delete's full set (added nl/sv/da/no/pl/tr/ru/ar/ja/ko/zh, button names verified against Google's localized help pages, zh covered in both scripts). |

Gmail's toolbar buttons do not expose a stable language-free
identifier for delete vs archive, so tokens are the honest tool here.
7.5 did the realistic improvement (widening the tables); a selector
swap stays off the table.

## 4. Overflow menu and tag-before-delete (the label dialog)

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `MORE_OPTIONS_TOKENS` (23 tokens) + multilingual regex | `findMoreOptionsButton` | LANG (broad) | Low-medium. |
| `aria-haspopup` bonus (+3, enough to win with zero token hits) | `findMoreOptionsButton` | STRUCTURE | This is the locale-proof back-stop: an overflow button in an uncovered locale is still found through `aria-haspopup` alone (fixture-locked). It can mis-pick when several toolbar buttons carry `aria-haspopup`, so it stays a fallback, not the primary. |
| `div[role='menu']` + visibility + most-`[role^='menuitem']` wins | `findVisibleMenu` | STRUCTURE | Low. |
| `LABEL_BUTTON_TOKENS` + `/label|libell|etiquet|etichett/i` | `findLabelMenuItemIn` | LANG (broad since 7.5) | Low-medium. 7.5 widened the table from 8 tokens to delete's locale set (added pt-BR "Marcadores", sv/da/no "Etiketter", pl/tr, ru "Ярлыки", ar, ja/ko/zh in both scripts; toolbar button names verified against Google's localized help pages). Remaining gap: a locale whose "Label as" menu item is worded differently from its toolbar Labels button can still miss and fall through to the structural input selectors, then the hotkey. |
| `SELECTORS.labelInputs`: `input[aria-label*='Label as']` etc. | `openLabelInput` | MIXED | Medium. Two of the six selectors are pure structure (`div[role='menu'] input[type='text']`, `div[role='dialog'] input[type='text']`), so the input is usually still found after the menu opens in any locale. |
| `l` keyboard shortcut fallback | `openLabelInput` | STRUCTURE | Locale-proof but only fires when the user enabled Gmail keyboard shortcuts. |
| Failure mode | `applyTagLabel` | n/a | If every path misses, tagging is skipped and the run continues untagged (recorded in the undo log as `taggingFailed`), unless the 7.4 hard signal (no Labels button AND no overflow button) fires first and stops the run. |

## 5. True bulk select ("Select all conversations that match")

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| Banner areas `div.aeH`, `div.ya`, `div[role='complementary']` | `findSelectAllConversationsLink` | STRUCTURE | Low. |
| `SELECT_ALL_TOKENS` (17 locales) + `SELECT_ALL_CONVERSATIONS_PATTERNS` (regex for en/es/fr/de/pt only) | same | LANG | Medium impact, low severity: in an uncovered locale bulk select is missed and the engine falls back to page-by-page passes. Slower, not wrong; counts stay accurate because they come from the per-page selection. |
| `CONFIRM_TOKENS` (17 locales) for the bulk confirm dialog | `handleBulkConfirmation` | LANG (broad) | Low-medium. Dialog itself is found structurally (`div[role='alertdialog']`, `div.Kj-JD`). |

## 6. Unsubscribe control and its confirm dialog (7.0 Pro path)

Closed in 7.5. This was the biggest locale win available: the paid
unsubscribe feature was effectively English-only.

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `div[role='main'] span.Ca`, trusted structurally (7.5 removed the English `/unsubscribe/i` veto), refusing hits inside `div.a3s` and `tr[role='row']` | `findHeaderUnsubscribeControl` | STRUCTURE | Low: Gmail renders its native header unsubscribe control with this class in every locale (class-rot risk only, same as every Gmail class name). The body/row exclusions now guard the primary path too, so sender-controlled markup that mimics the class is never driven. |
| Fallback: `[role="link"], [role="button"]` matched EXACT whole-text against `UNSUBSCRIBE_TOKENS` (17 locales, verified against Google's localized help pages), same exclusions | same | LANG (broad) | Low-medium. An uncovered locale misses the fallback but normally still hits the structural primary. |
| Dialog buttons: `UNSUBSCRIBE_TOKENS` confirm, `UNSUB_CANCEL_TOKENS` cancel, `UNSUB_WEBSITE_TOKENS` + `/(go to|visit).*(website|site)/i` manual, all exact whole-text | `resolveUnsubscribeDialog` | LANG (broad) | Low-medium. Exact matching is the safety load-bearing wall: "Unsubscribe and block" must not classify as a plain confirm, and prefix pairs like ar "إلغاء" (cancel) vs "إلغاء الاشتراك" (confirm) must stay apart. An unrecognized dialog stays "unknown", is dismissed via Escape, and the sender is reported unconfirmed. Fails safe in any locale. |

## 7. Subscription scan row sampling (7.0)

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `tr[role="row"]` > `span[email]` / `[email]`, `email` + `name` attributes | `sampleSubscriptionRows` | STRUCTURE | Low. Fully attribute-based; fixture-locked with non-Latin sender names. |
| Scan queries: localized body-text term + `category:` queries | `buildSubscriptionScanQueries` | STRUCTURE (operators) with one localized literal | Low since 7.5. The body-text discovery term now follows the Gmail UI language (`SUBSCRIPTION_SEARCH_TERMS` keyed off `document.documentElement.lang`, English fallback, one term per run). The two `category:` queries are byte-identical to 7.0, including the English term inside the `category:updates` query, so existing recall is a floor, not a trade. An uncovered UI language just keeps today's English-only recall. |

## 8. Storage X-ray scan (7.2)

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| Tier queries `larger:25M`, `larger:10M smaller:25M`, `larger:5M smaller:10M` | `STORAGE_XRAY.TIER_QUERIES` | STRUCTURE | None. Search operators, not words. |
| Row sampling: same `span[email]` attribute walk as subscriptions | `foldStorageSample` path | STRUCTURE | Low. |

## 9. Everything else that reads text

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `hasNoResults`: empty `table[role='grid']`, `td.TC` empty-state cell | `hasNoResults` | STRUCTURE | Low. The two structural checks fire first in any locale; fixture-locked. |
| `noResultsIndicators` two English sentences | `hasNoResults` fallback | LANG | None in practice: only consulted when the grid is missing AND `td.TC` is absent, which current Gmail does not do. Kept as a legacy belt. |
| `RATE_LIMIT_TOKENS` (9 English + localized phrases since 7.5) in alert/status/aria-live areas | `findRateLimitText` | LANG (broad) | Low-medium since 7.5: throttle/temporary-error phrases now cover the same major locales as the rest of the engine, so adaptive backoff engages off-English. Detection-side, so the tokens are deliberately broader than the confirm-side tables (a false positive only slows the run down), but every entry stays a phrase, never a lone common word. Uncovered locales keep the old degraded-but-safe timeout behavior. |
| `findUndoToast`: alert/status regions + "undo" + multilingual action words | `waitForActionProcessing` | MIXED | Low-medium. It is one of several completion signals (no-results, row-count delta, selection cleared); missing it in an uncovered locale slows verification but does not fail it. |
| `parseCountFromText` `/\bof\s+N/`, `/about N results/` | `estimateTotalResults` | LANG | Low. Only feeds estimates for dry runs and bulk-all counts; per-page selection counts stay accurate. Non-English accounts see null estimates, which every caller already tolerates. |
| Query builders (`older_than:`, `category:`, `from:`, `-subject:(...)`, `label:`) | `applyGlobalGuards`, presets | STRUCTURE | None. Gmail search operators are locale-independent by design. English guard words inside `SAFE_MODE_SUBJECT_GUARD` (receipt, invoice, ...) protect less mail on non-English accounts, which errs toward protecting less, never deleting protected mail; the user-editable protected-keywords list covers the gap. |
| `location.hash = "#search/..."`, `/mail/u/N/` account index | `openSearch`, `getGmailBaseUrl` | STRUCTURE | None. |
| List-settle signature via `data-legacy-thread-id` / row `id` | `openSearch` | STRUCTURE | Low. |
| Undo-log row sampling `span[email]`, `data-legacy-thread-id` | `sampleListRows` | STRUCTURE | Low; fixture-locked. |

## 10. Restore run move-back controls (7.6)

The restore engine reuses the audited selection machinery (sections 1,
2 and 5) and `openSearch`; the only new text-matching surface is the
move-back control itself plus its inverse-safety deny-list. Restore is
the one flow that shares a toolbar with "Delete forever", so its
matching rules are the strictest in the engine.

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `MOVE_TO_INBOX_TOKENS` (18 entries: the 17-locale set with zh in both scripts), exact whole text scores highest, full-phrase containment scores lower (tooltip shortcut suffixes) | `findMoveToInboxButton` | LANG (broad) | Low-medium. Every string verified against Google's localized archive help page (`/mail/answer/6576` per `hl=`). An uncovered locale scores nothing and the engine falls through to the menu path, then to an honest no-op. Single words never match: every token is the full localized phrase. |
| `MOVE_TO_TOKENS` (Trash toolbar's "Move to" menu opener), EXACT whole text only | `findMoveToMenuButton` | LANG (broad) | Low-medium. Verified against the localized delete help page (`/mail/answer/7401` per `hl=`). Exact-only because several locales use very short words (ja "移動", ko "이동", zh "移至") that would substring-match unrelated controls. Danish is deliberately absent: its help page words the recovery step as the full "Flyt til Indbakke", so the standalone opener could not be verified; da restores through the direct button or not at all. |
| `INBOX_TOKENS` (localized Inbox names inside the opened menu), EXACT whole text only | `findInboxMenuItemIn` | LANG (broad) | Low. Verified from the same pages (the delete article names the destination, e.g. es "Recibidos"). Exact matching means a user label that merely contains the word is never picked; a miss closes the menu via Escape and the run reports honestly. |
| `DELETE_FOREVER_TOKENS` deny-list, SUBSTRING match across aria-label, data-tooltip, title AND text | `hasDeleteForeverMarking`, applied in `restoreCandidates` and `findInboxMenuItemIn` before any scoring | LANG (deny side) | This is the inverse-safety wall, and it fails in the safe direction by construction: over-matching only skips a candidate. Strings verified from the delete help page per locale; ar additionally carries the bare stem of the researched phrase and ko both spacing forms, so grammar variants of the same researched wording stay covered. Fixture-locked: a control that matches a move token exactly but carries a deny string on any label surface is refused even when it would win the score outright. An uncovered locale's "Delete forever" is protected differently: no move token covers that locale either, so the finders return nothing and the engine never clicks at all. |
| Selection, bulk banner, bulk confirm, action verification | `restoreCurrentPage` reusing `clickMasterCheckbox`, `clickSelectAllConversations`, `handleBulkConfirmation`, `waitForActionProcessing` | see sections 1, 2, 5 | Same properties as cleanup, including the 7.4 layout-change signal when rows render without selection controls. |
| Restore query `in:trash label:"..."` / `label:"..." -in:inbox` | `buildRestoreQuery` | STRUCTURE | None beyond operators. The label rides in a quoted term with embedded quotes stripped twice (page and engine), so it cannot re-scope the query. A label Gmail does not resolve returns zero results, which ends the run as "nothing left to restore". |

## Summary

Safe (structure/attribute-based, fixture-locked where practical):
row discovery, per-row selection, selection counting, grid emptiness,
menu discovery, both scans' row sampling, all query building,
navigation, and since 7.5 the header unsubscribe control.

Covered by broad token tables (17 locales): delete button, archive
button, labels button, more-options button, select-all banner, bulk
confirm, unsubscribe dialog classification, rate-limit detection, the
subscription scan's discovery term, and since 7.6 the restore path's
move-back controls plus its "Delete forever" deny-list.

Shipped in 7.5 (the whole 7.4 backlog, in its original impact order):
1. Unsubscribe path: `span.Ca` is trusted structurally and the dialog
   buttons are classified through verified, exact-whole-text token
   tables. The Pro unsubscribe feature now works off-English.
2. `RATE_LIMIT_TOKENS`: localized throttle phrases; backoff engages
   off-English.
3. `ARCHIVE_LABEL_TOKENS` and `LABEL_BUTTON_TOKENS`: extended to the
   `DELETE_LABEL_TOKENS` locale set.
4. Subscription scan: localized body-text term picked from the Gmail
   UI language.

Still open, deliberately (all fail safe, none block a covered-locale
run):
- Locales outside the 17-locale set (e.g. Czech, Thai, Hindi, Greek)
  still miss every token table: cleanups end with "No delete button",
  unsubscribe dialogs stay "unknown" and are dismissed, throttling
  reads as timeouts, and restore runs find no move-back control, click
  nothing, and say so while the mail stays recoverable. Adding a
  locale means verifying its strings the same way (Google's localized
  help pages), not guessing.
- Danish restore has no "Move to" menu-opener token (see section 10);
  it relies on the direct "Flyt til Indbakke" button.
- The unsubscribe dialog tables cover Gmail's current wording; if
  Google rewords a locale, that locale degrades back to fail-safe
  "unknown" until the table is refreshed.
- `SELECT_ALL_CONVERSATIONS_PATTERNS` regexes cover en/es/fr/de/pt
  only; uncovered locales fall back to page-by-page passes (slower,
  counts stay correct).
- `findUndoToast`, `parseCountFromText`, and the legacy
  `noResultsIndicators` sentences remain partially or fully
  English-bound; each is one of several signals and its absence only
  degrades verification or estimates.
- `SAFE_MODE_SUBJECT_GUARD` keywords are English, so safe mode
  protects less mail on non-English accounts; the user-editable
  protected-keywords list covers the gap.
- The scan's `category:updates` query keeps its English term by
  design (see section 7); localized recall rides on the body-text
  query.
