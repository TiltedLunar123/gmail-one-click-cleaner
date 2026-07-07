# Gmail locale-independence audit (7.4.0)

The engine drives Gmail's UI directly, so anything that matches on-screen
text silently breaks on non-English Gmail accounts. This audit walks every
selector and string match in `contentScript.js`, classifies each as
structure/attribute-based (safe in any language), language-dependent
(breaks outside the covered locales), or mixed, and states the blast
radius when it misses. Fixture tests locking in the language-independent
paths live in `tests/contentScript-locale.test.js`.

Verdict up front: the destructive path (find rows, select, delete or
archive) is structure-first with multilingual token fallbacks, so core
cleanup works on non-English accounts. The genuinely English-only spots
are all in secondary paths: rate-limit detection, the no-results text
fallback, the unsubscribe control's text check, and the unsubscribe
dialog's button classification. Those are documented as 7.5 work below.
No code changes shipped from this audit: none of the string matches has
an attribute-based equivalent that the existing fixtures already prove
equivalent, and swapping unproven selectors on the deletion path is a
bigger risk than the one being audited.

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
| `ARCHIVE_LABEL_TOKENS` (en/fr/es/de/pt/it only) + `/archive/i` | `findArchiveButton` | LANG (narrower) | Medium. Same failure shape as delete with thinner coverage (no nl/sv/pl/tr/ru/ar/ja/ko/zh). Archive-mode users outside six locales get "No archive button". |

7.5 candidate: Gmail's toolbar buttons do not expose a stable
language-free identifier for delete vs archive, so tokens are the
honest tool here. The realistic improvement is widening the token
tables, not a selector swap.

## 4. Overflow menu and tag-before-delete (the label dialog)

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `MORE_OPTIONS_TOKENS` (23 tokens) + multilingual regex | `findMoreOptionsButton` | LANG (broad) | Low-medium. |
| `aria-haspopup` bonus (+3, enough to win with zero token hits) | `findMoreOptionsButton` | STRUCTURE | This is the locale-proof back-stop: an overflow button in an uncovered locale is still found through `aria-haspopup` alone (fixture-locked). It can mis-pick when several toolbar buttons carry `aria-haspopup`, so it stays a fallback, not the primary. |
| `div[role='menu']` + visibility + most-`[role^='menuitem']` wins | `findVisibleMenu` | STRUCTURE | Low. |
| `LABEL_BUTTON_TOKENS` (8 tokens) + `/label|libell|etiquet|etichett/i` | `findLabelMenuItemIn` | LANG | Medium. Romance/Germanic locales covered; ru/ar/ja/ko/zh are not, so the menu item is missed and tagging falls through to the hotkey. |
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

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `div[role='main'] span.Ca` | `findHeaderUnsubscribeControl` | STRUCTURE | Low: Gmail renders its native header unsubscribe control with this class in every locale. |
| `/unsubscribe/i` text check on the span.Ca hit | same | LANG | **High for non-English.** The structural hit is immediately vetoed when the control says "Cancelar suscripción" or "Se désabonner". Primary path dies on every non-English account. |
| Fallback: `[role="link"], [role="button"]` with exact `/^unsubscribe$/i`, excluding `div.a3s` body and `tr[role='row']` | same | MIXED | Same English-only veto. The body/row exclusions are structural and good. |
| Dialog buttons: `/^unsubscribe$/i` confirm, `/^(cancel|no thanks|close|dismiss|got it)$/i` cancel, `/(go to|visit).*(website|site)/i` manual | `resolveUnsubscribeDialog` | LANG | **High for non-English.** An unrecognized dialog is classified "unknown" and the sender is reported unconfirmed; `dismissDialog` still closes it via Escape, so nothing wrong is clicked. Fails safe. |

7.5 work (the biggest locale win available): trust `span.Ca` inside the
message header structurally instead of vetoing it by English text, and
add localized token tables for the dialog's confirm/cancel buttons
(mirroring `CONFIRM_TOKENS`). Not done in 7.4 because no existing
fixture proves the text check redundant, and a wrong click here
unsubscribes or navigates on the user's behalf.

## 7. Subscription scan row sampling (7.0)

| Dependency | Where | Class | Risk |
| --- | --- | --- | --- |
| `tr[role="row"]` > `span[email]` / `[email]`, `email` + `name` attributes | `sampleSubscriptionRows` | STRUCTURE | Low. Fully attribute-based; fixture-locked with non-Latin sender names. |
| Scan queries `"unsubscribe" newer_than:1y`, `category:promotions ...` | `SUBSCRIPTIONS.SCAN_QUERIES` | STRUCTURE (operators) with one LANG literal | Medium recall on non-English accounts: Gmail search operators are locale-independent, but the literal `"unsubscribe"` body-text term only matches mail that contains the English word. Non-English newsletters still surface through the two `category:` queries. 7.5: consider adding localized unsubscribe terms per UI language. |

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
| `RATE_LIMIT_TOKENS` (9 English phrases) in alert/status/aria-live areas | `findRateLimitText` | LANG | **English-only.** On non-English accounts throttling is never recognized, so the adaptive backoff never engages and a throttled pass surfaces as a timeout instead. Degraded, not destructive: the timeout path retries with the same backoff machinery. 7.5: add localized token rows for the major locales. |
| `findUndoToast`: alert/status regions + "undo" + multilingual action words | `waitForActionProcessing` | MIXED | Low-medium. It is one of several completion signals (no-results, row-count delta, selection cleared); missing it in an uncovered locale slows verification but does not fail it. |
| `parseCountFromText` `/\bof\s+N/`, `/about N results/` | `estimateTotalResults` | LANG | Low. Only feeds estimates for dry runs and bulk-all counts; per-page selection counts stay accurate. Non-English accounts see null estimates, which every caller already tolerates. |
| Query builders (`older_than:`, `category:`, `from:`, `-subject:(...)`, `label:`) | `applyGlobalGuards`, presets | STRUCTURE | None. Gmail search operators are locale-independent by design. English guard words inside `SAFE_MODE_SUBJECT_GUARD` (receipt, invoice, ...) protect less mail on non-English accounts, which errs toward protecting less, never deleting protected mail; the user-editable protected-keywords list covers the gap. |
| `location.hash = "#search/..."`, `/mail/u/N/` account index | `openSearch`, `getGmailBaseUrl` | STRUCTURE | None. |
| List-settle signature via `data-legacy-thread-id` / row `id` | `openSearch` | STRUCTURE | Low. |
| Undo-log row sampling `span[email]`, `data-legacy-thread-id` | `sampleListRows` | STRUCTURE | Low; fixture-locked. |

## Summary

Safe today (structure/attribute-based, fixture-locked where practical):
row discovery, per-row selection, selection counting, grid emptiness,
menu discovery, both scans' row sampling, all query building, navigation.

Covered by broad token tables (17+ locales): delete button, more-options
button, select-all banner, bulk confirm.

7.5 backlog, in impact order:
1. Unsubscribe path: trust `span.Ca` structurally, tokenize the dialog
   buttons. Today the Pro unsubscribe feature is English-only.
2. `RATE_LIMIT_TOKENS`: localized throttle phrases so backoff engages
   off-English.
3. `ARCHIVE_LABEL_TOKENS` and `LABEL_BUTTON_TOKENS`: extend to the same
   locale set as `DELETE_LABEL_TOKENS`.
4. Subscription scan: localized `"unsubscribe"` body-text terms.
