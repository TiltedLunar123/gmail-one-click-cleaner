# Changelog - Gmail One-Click Cleaner

All notable changes to this project will be documented in this file.
This log tracks user-visible behavior, UI changes, and important internal fixes.

## 8.6.0 - Suggestions count what they clean

### Fixed
- **A suggestion could be sold on exactly the mail its own button
  refused to touch.** A card reading "402 emails, 100% unread, mostly
  older than 6 months" with a Delete old mail button underneath it
  cleaned nothing, every time, on every mailbox. The count came from a
  plain search for that sender; the button sent that search plus your
  safety switches, one of which is Skip Unread. The more unread mail a
  sender had, the higher it ranked, and the more certain it was that
  the run would find nothing. Suggestions are now measured through the
  same switches the button applies, so the number beside a button is
  the number that button will act on.

- **Senders your switches hold back entirely are no longer suggested,
  and no longer disappear without explanation.** The list says how many
  were held back, which switches did it, and takes you to them.

- **The suggestion scan never sent your switch settings**, so it
  measured everyone against the defaults. If you had turned Skip Unread
  off, the scan still counted as though it were on.

- **Checking more than 25 suggestions quietly cleaned only 25.** The
  status line said it was cleaning all of them and the run history
  recorded all of them. It now says which it is running, the way the
  bulk unsubscribe button already did.

- **Your Pro key survives an update.** It was stored in one place, so
  one storage hiccup lost something you paid for; it now lives in two
  and repairs whichever copy goes missing. A stale copy in one can no
  longer hide a good key in the other. Removing a key clears both, and
  says so plainly if it could only clear one.

- **Unpacked builds keep one identity.** Chrome derives an unpacked
  extension's ID from the folder it was loaded from, and all extension
  storage is scoped to that ID, so unzipping each release next to the
  last one made every update a brand new extension with nothing in it.
  The key was never forgotten; it belonged to a different extension.
  Builds now pin an ID. Firefox already did.

### Note
- Pinning the ID changes it once, so an unpacked install has to be
  given its Pro key one more time. After that it stays.

## 8.5.1 - Unsubscribe actually unsubscribes

### Fixed
- **Bulk unsubscribe skipped senders whose unsubscribe link was plainly
  on screen**, and blamed them for it. The engine looked for Gmail's
  Unsubscribe control exactly once, 300 milliseconds after opening the
  message, with no retry, while every other control it drives is waited
  for with a multi-second budget. Gmail renders that link only after it
  has processed the message's List-Unsubscribe header, which is
  routinely later than that. So the engine lost a race it did not know
  it was running, and the row read "No 1-click option", which sounds
  like the sender's fault and is not. It now waits up to six seconds.

- **"No 1-click option" and "Manual step needed" were describing the
  sender when they were describing us.** They now read "No unsubscribe
  link" and "Needs their website".

- **A confirmation Gmail never acknowledged was reported as success.**
  The code waited for the dialog to close and then ignored the answer,
  always returning "Unsubscribed". A dialog still sitting there means
  the click did not take, and that is the one failure a user cannot
  detect for themselves: they cross the sender off and keep getting the
  mail. It now reports "Unconfirmed".

- **Finding the control no longer rests on one Gmail class surviving
  forever.** There is a third fallback for markup carrying neither the
  class nor the role. It still refuses anything the sender wrote: the
  message body, list rows, and any real link, because Gmail's control
  acts in place while a sender's link navigates your tab to them.

- **The report headline counted mail no run could ever touch.** A bare
  `older_than:6m` searches all mail, which includes Sent, Drafts and
  Chats, all three of which the cleaner refuses to act on by design. A
  mailbox full of sent mail produced a five-figure headline above a plan
  with no steps in it.

- **"Nothing matched the plan. Your mailbox is already clean." printed
  directly under a headline of 5,120**, which is not a sentence anyone
  should have to read. Empty bands and an empty mailbox are different
  findings, and it now says which one it found.

### Changed
- The popup is 440px wide, up from 380. Four tabs could not hold their
  own labels at the old width and every list row was fighting for space.

## 8.5.0 - The number matches the run

### Fixed
- **A report band said 5,000 and cleaning it removed nothing.** The
  count and the button were asking Gmail two different questions. The
  band was counted with its own query, `category:updates older_than:1y`,
  while the run that followed searched
  `category:updates older_than:1y -is:starred -is:important -is:unread
  -has:userlabels`. Updates are notification mail nobody opens, so
  `-is:unread` removed the entire band and the run cleared zero.

  Every count in the Mailbox Report is now measured through exactly the
  filter its Clean button applies, so the number on screen is the number
  that button acts on. Sender attribution is measured the same way, and
  band ranking changes as a result: a band with more mail but less
  reachable mail no longer outranks one you can actually clear.

  The Storage X-ray had the identical bug and got the identical fix.

- **A report that reads honestly can still read as empty**, so it now
  says why. The headline is measured twice, once raw and once guarded,
  and the difference is shown: "12,431 more old emails are protected by
  your guards (Skip Unread, Skip Labeled)", with a button that takes you
  straight to those switches. That costs one extra search.

- **The tab bar overflowed the popup.** Four tabs, two of them carrying
  a padlock, in 380px, and the labels were long: "Unsubscribe" barely
  fit, "Cancelar inscrição" and "Se désabonner" never did. The labels
  are short now, and a tab can shrink below its own text instead of
  pushing the bar wider, so a long translation ellipsises rather than
  breaking the layout.

## 8.4.0 - Sender marks, and a way out of a stuck run

### Added
- **The Unsubscribe list draws a mark for every sender**, a coloured
  square with the sender's initial, so a row is something you can spot
  instead of a line of text to read. Addresses at one company share a
  mark: `news@substack.com`, `noreply@email.substack.com` and
  `digest@mg.substack.com` all draw the same S, so they group visually.
  The Suggested cards on the Clean tab use the same marks.

  The obvious way to build this is a favicon per sender, and that is
  exactly why it is not built that way. A favicon means one network
  request per sender, to a third party, handing over the list of who
  mails you, in an extension whose whole claim is that it makes no
  requests at all. Every mark here is arithmetic on the address: same
  sender, same mark, on every machine, offline, forever. The test suite
  now fails the build if an image or a URL ever appears in that path.

- **"Reset stuck run"**, in the popup and on the progress page. Two
  separate flags could say "a run is happening", and neither had any
  way to clear: the stored run claim, which expired after two hours,
  and a flag inside the Gmail tab, which expired never. When a run died
  without reporting back, both were stranded and every later run was
  refused with "a cleanup is already running" while pointing at
  nothing. Reloading the Gmail tab was the only cure, and nothing said
  so.

  The refusal now arrives with a banner attached, and the banner says
  which case you are in. If the cleaner answers and says it is genuinely
  working, the banner says so, offers to show you its progress page, and
  will not clear anything without a second, explicit click; that click
  cancels the run and then waits for it to actually stop before
  clearing, because the flag it is clearing is the only thing keeping a
  second cleaner off the same mailbox. If nothing answers, one click
  clears it and you can start again.

  One case gets special handling. If the tab flag is set but nothing
  answers at all, a cleaner is probably still running in there with its
  connection to the extension severed, which is what reloading or
  updating the extension mid-run leaves behind. It cannot be told to
  stop, so Reset reloads the Gmail tab, which does stop it. That is the
  same tab reload that was the only cure for any of this before 8.4,
  except now the extension knows when it is needed and does it for you.

  Reset never reports success it did not achieve. If the run will not
  stop, or the Gmail tab is open but refuses to be reached, nothing is
  cleared at all and it says so, because a cheerful "you can start
  again" backed by nothing is how you end up with two cleaners on one
  mailbox.

### Fixed
- **"Unsaved changes" appeared mid-sentence** in the Options subtitle,
  several screens above the Save button it was talking about. It now
  sits beside Save.

## 8.3.0 - Real result counts

### Fixed
- **The Mailbox Report showed 50 against band after band**, and a run
  then cleared far less than the plan implied. Gmail renders its
  "1-50 of 1,234" counter in the toolbar, outside the results element,
  and the code only ever looked inside that element. So the total was
  never found on a normal result page and every caller fell back to
  counting the rows on screen: one page, fifty. The counter is now
  looked for in the results area, then the toolbar, then the page.
  The same total sizes the large-run guardrails, so those were reading
  a page instead of a match set too.

## 8.2.0 - The guards you could not see

Reported from real use: "unsubscribe doesn't work, storage doesn't work,
it gets randomly stuck a lot". All of it traced back to guards and state
the product never showed you.

### Fixed
- **Two safety guards had been forced on since v3.x with no control
  anywhere.** Every run silently added `-is:unread` and
  `-has:userlabels` to your rules, so on a mailbox where the clutter is
  unread or labelled, most of it was excluded and the run reported
  "nothing matched your rules". Both are now real switches in the popup,
  still on by default, and both are actually sent to the engine (the
  popup never sent them, and a missing value reads as "on").
- **A scan that timed out reported success.** If Gmail did not answer a
  search, the scan skipped it and finished with a tidy "No large mail
  found" or an empty sender list. It now says how many searches timed
  out, and says so plainly when all of them did.
- **Bulk unsubscribe was opening unread mail and marking it read.** It
  picked rows by a CSS class the code documented as "already read"; in
  Gmail that class means unread. It now prefers genuinely read rows.
- **The Pro padlock stayed on the tabs after you bought Pro**, and the
  Auto-Pilot "Pro" badge never went away at all. The padlocks are SVG,
  and `hidden` is an HTML property that does nothing on an SVG element,
  so it was never actually applied; the Auto-Pilot badge was static
  markup no code ever touched. All the Pro markers now disappear once a
  licence verifies, since they exist to tell free users the tier is
  there.



### Added
- **Maximum, a fourth cleanup intensity above Deep**, for a mailbox that
  has never been cleaned. It shortens Deep's age floors, drops the
  attachment size thresholds, and adds two more ways of naming bulk mail
  that Gmail never filed into a category: the sender names marketing
  actually uses, and the "view in browser" line that only ever appears in
  a mass mailing.
  - It deliberately does **not** sweep your Inbox wholesale or a bare age
    range. Both of those reach ordinary correspondence, which the guards
    narrow but do not protect: a two-year-old reply from a person is not
    starred, not important, and not unread. Every rule it ships is either
    size-bounded or age-bounded.
  - Like Deep, it will not start on a single click, and it says which
    intensity it is asking you to confirm.
  - Editable on the Options page like the other three, and available to
    scheduled cleanups.

### Fixed
- Saving on the Options page rebuilt the rule map from a hardcoded list of
  the three intensities that existed at the time, so any intensity added
  later was silently dropped on the next save, and its editor was never
  watched for unsaved changes. Both now derive from the real key list.

## 8.0.0 - Mailbox Report, and a popup that finally explains itself

The biggest release since Pro shipped. It adds the thing the product was
missing, which is an answer to "what is actually in here", and it rebuilds
the two screens where that answer matters: the popup you open, and the
dashboard you watch a run finish on.

### Added
- **Mailbox Report.** One read-only pass counts what is in your mailbox
  and turns it into a ranked cleanup plan: old promotions, big
  attachments, forgotten newsletters, social and forum mail, and inbox
  mail you never archived. Eleven Gmail searches, no message opened,
  nothing moved. It is now the tab the popup opens on.
  - The **whole report is free**, and so is running its biggest step, so
    you watch the mechanism work on your own mail before deciding
    anything. Pro unlocks the remaining steps and **Run the whole plan**.
  - Every step is an ordinary cleanup run. Matches are labelled first,
    Dry Run is honoured, your whitelist, protected keywords and Minimum
    Age all apply, and the run lands in the Recovery Log with one-click
    Restore like any other.
  - Storage figures are **floors**, built from Gmail's own size tiers, so
    the report says "at least N MB". Nothing is compared against Google's
    15 GB bar, which is shared with Drive and Photos and which no
    extension can see.
- **A run-completion card on the progress dashboard.** Watching a run end
  used to leave you with a disabled button reading "Run finished". You
  now get the number, the labels that were actually applied, what Trash
  keeps and for how long, a link straight into the Recovery Log, and a
  copyable receipt.
- **A Pro screen inside the popup.** Clicking a locked control used to
  open a payment form in a new tab, with no explanation, from a developer
  you have never heard of. It now opens a panel that leads with your own
  scan numbers, says what the five paid features do, and states the three
  things people actually want to know: one payment and never a
  subscription, the key is checked on your device, and every feature
  added later is included. The buy button does exactly what the old click
  did.
- **Two lines under the Run button** that say, without a click, what the
  cleaner protects and what it never sends anywhere.
- **"Bought Pro? Paste your key"** appears once you have run a cleanup and
  have no licence, because the post-purchase page told buyers to
  right-click the toolbar icon and hunt for Options.

### Changed
- The popup got a real type scale and spacing grid, sentence-case
  buttons, and a gold accent reserved for Pro. Green used to mean both
  "your cleanup worked" and "pay us".
- Pro is visible before you scan: the tabs that lead to paid features
  carry a small padlock, and the Pro badge now says whether it is locked
  or active instead of appearing only after you buy.
- The popup remembers which tab you were on, and which senders you had
  ticked on the Unsubscribe tab, so a trip to checkout no longer throws
  away your triage.
- Scans show placeholder rows while they run, and each list explains what
  the scan will produce before you start it.
- "Maybe later" on the rating ask now lasts 90 days instead of forever.

### Fixed
- **The Recovery Log stopped eating itself.** An entry was written once
  per pass and the log kept only 20, so a first sweep on a large mailbox
  pushed out its own earliest entries before it finished and always
  destroyed the previous run's. Passes of the same rule in one run are
  now a single entry, and the log holds 60 of them.
- **The large-run confirmation appears on the screen you are looking at.**
  The 10,000 and 20,000 conversation checks were browser dialogs raised
  inside the Gmail tab, which every run path had just pushed into the
  background, and they froze Gmail's page while they waited. They are now
  asked on the progress dashboard, with stopping as the default, and a
  run that gets no answer stops rather than proceeding. Declining also
  stops the whole run now, which is what the button says: it used to end
  only the current rule and carry on to the next one. Scheduled sweeps
  are unchanged, they still decline unattended and skip that rule.
- **A storage purge no longer builds an over-length search.** Picking 25
  senders produced a query far past the length this project's own
  validator allows. Addresses are now packed into as many searches as
  the limit permits and run as an ordinary multi-rule cleanup.
- **Rate this extension** sent Firefox users to the Chrome Web Store,
  under a button that named it. It now resolves to whichever store the
  copy was installed from, and it only appears after a run big enough to
  have earned the ask.
- Removed a "protect this sender" suggestion strip that could never
  appear: it scored senders by opens and replies, and nothing in the
  extension has ever recorded either.
- `SECURITY.md` described the run counter as synced when it has always
  been device-local, and the README compared Pro against a monthly price
  when the competitors' annual plans are the honest comparison.

## 7.15.0 - Safety, locale and scheduling fixes

A second sweep, in the same spirit as 7.14.2 and reaching the places that
one did not: the paths that only run when nobody is watching, and the
ones that only misbehave when Gmail is not in English.

### Fixed
- **Scheduled cleanups now honour your Global Whitelist.** They never
  did. The list you fill in under "Never Delete" was applied to every
  manual run and to Auto-Pilot, but a scheduled cleanup read a separate,
  per-schedule list that nothing has ever been able to fill in, so it
  ran with no whitelist at all. The one kind of run you are not watching
  was the one that could delete mail from a sender you had protected.
- **Custom rules now respect their own Action.** A custom rule saved as
  "Archive" or "Label only" was stored, shown with its badge, and then
  executed with the run's action anyway, so a rule you set to label your
  invoices was deleting them. Archive rules are now used when you run the
  cleaner in Archive mode, and Label-only rules are never executed by a
  cleanup run.
- **The big-run guardrails work in every language.** 7.14.2 made them
  measure the real match total instead of the page on screen, but it
  found that total by reading Gmail's English "1-50 of 3,200" and its
  English "all conversations selected" banner. On a German, French,
  Japanese or Korean Gmail both reads failed, so the guardrails were
  back to sizing a 25,000-conversation sweep at about 50. The counter is
  now read without relying on any particular language, an all-matching
  selection is detected structurally, and the guardrails always measure
  what the click can actually touch.
- **Bulk deletes complete on a non-English Gmail.** The confirmation
  dialog Gmail shows for a very large batch was only ever found by
  English phrases, so on other languages the run waited, timed out and
  quietly did nothing. It is now found by its buttons, which were already
  translated.
- **A whitelist entry like `*@bank.com` protects that domain.** The
  Options page accepts and documents that shape, and Smart Suggestions
  already treated it as the whole domain, but the cleanup query passed it
  to Gmail verbatim. Gmail has no wildcard there, so the entry protected
  nothing.
- **Rules that target protected mail are refused wherever they come
  from.** Custom rules were checked; the Light / Normal / Deep boxes were
  not, and saving one that targeted starred or sent mail raised no
  objection at all. Both sides now refuse them, and a Gmail `{a b}` group
  can no longer hide the token from the check.
- **"Restore defaults" no longer wipes your safety lists.** It said it
  would replace your rules. It also silently emptied the Global Whitelist
  and your Protected Keywords. It now restores rules only.
- **Auto-Pilot only ever acts on its own scan.** A Smart Suggestions scan
  you started yourself could hand a pending sweep its "scan finished" and
  set an unattended archive run going. It also now re-checks vacation
  mode before it acts, so switching that on while the scan is running
  stops the sweep.
- **Two overdue schedules no longer fire in the same instant**, which
  could start one cleanup running the other schedule's settings, and
  changing a schedule after a run can no longer make that run repeat a
  minute later.
- Cancel is now honoured between selecting mail and moving it during a
  Restore, and between opening an unsubscribe dialog and confirming it.
- A restore that moves everything matching now reports how much it
  actually moved instead of the page count.
- A rule that stops because it hit the per-run pass limit now says so and
  appears in the run summary instead of vanishing from it.
- The large-batch warning can fire again; it was comparing a page of at
  most 100 rows against a threshold of 2,000.

### Changed
- **Scoped runs keep your Minimum Age.** A Storage X-ray purge or a Smart
  Suggestion used to drop it for that run. "Archive all" carries no age
  of its own, so with the floor dropped it could act on mail that arrived
  today. Your floor is now applied whenever it is stricter than the run's
  own age, exactly as it is for a normal cleanup.
- Editing settings in the popup while a run is in progress no longer
  rewrites what a reconnect would run, and a run that was refused because
  another was already going no longer leaves its settings behind.
- Opening the progress dashboard for a scheduled or Auto-Pilot run now
  refreshes a leftover tab instead of showing you the previous run's
  finished screen with Cancel greyed out.

### Privacy
- The last-run summary is synced so you see it on your other browsers,
  and it carried the literal Gmail searches that ran. For a Storage X-ray
  or Smart Suggestions run those searches contain sender addresses read
  from your mailbox. The searches are now removed before that summary is
  synced; the counts and labels it displays are unchanged. SECURITY.md
  has also been corrected: it said no message IDs were stored, when the
  recovery log keeps a sample of Gmail thread IDs on your device so you
  can find cleaned mail again.

## 7.14.2 - Safety and reliability fixes

### Fixed
- **Minimum Age now actually applies.** The setting promises to leave
  anything newer than your cutoff alone, but it was skipped whenever a
  rule already mentioned an age of its own, and every built-in rule
  does. In practice that meant choosing "older than 1 year" while
  running the normal preset still cleaned promotions from three months
  ago. The cutoff is now applied whenever it is stricter than the rule,
  and ignored when the rule is already stricter, so it can only ever
  narrow what a run touches.
- **The big-run confirmations no longer miss the biggest runs.** When
  Gmail confirms that every conversation matching a search is selected,
  it acts on all of them at once. The cleaner was still measuring only
  the page on screen, so a sweep of tens of thousands sailed past both
  the 10,000 warning and the large-run confirmation, and was then
  recorded as a few dozen. Both now use the real match total, and run
  totals stop under-reporting.
- **Cancel is honoured right up to the moment mail moves.** Cancelling
  during tagging, a confirmation prompt or one of the short waits before
  a batch was actioned used to let that batch go through anyway. A
  cancelled run now also ends as cancelled rather than reporting itself
  finished.
- **Dry Run previews the real number.** On a confirmed "all N
  conversations" selection it quoted the page on screen, so the preview
  for a 12,000 conversation sweep read as a few dozen.
- **Custom rules can no longer smuggle starred or sent mail past the
  guards.** A rule written as `(is:starred)` slipped through the refusal
  because of the bracket, and the same bracket stopped the automatic
  "skip starred" protection from being added.
- **Scheduled and unattended runs stop locking the cleaner out.** A few
  paths could leave a run marker behind after nothing had actually
  started, and every manual run was then refused for up to two hours.
  A finishing run could also clear a marker belonging to a newer run.
- **Archive runs are labelled as archive runs.** The Diagnostics page
  reported every archive run as a deletion, red tag included.
- **The progress tab recovers properly.** Reconnecting to a run that had
  already finished left it retrying in a loop for the life of the tab,
  and a reconnect during a Storage X-ray purge or a Smart suggestion
  could restart the previous full cleanup instead of the run you asked
  for.
- **Smaller UI fixes.** The Save button on Options no longer ends up
  permanently reading "Saving...", and the Diagnostics "Test inject"
  button no longer sticks disabled after a scan that finds no Gmail tab.

## 7.14.1 - Pro is now $19.99 lifetime

### Changed
- **Pro is $19.99, still a single payment and still lifetime.** Everyone
  who already bought keeps everything, at the price they paid, forever,
  including every feature added from here on. Nothing about an existing
  key changes. Competing inbox cleaners charge $9 to $10 every month;
  this stays one payment, and the free tier is untouched.

## 7.14.0 - Key recovery, safer unattended runs

### Added
- **Get your Pro key back with the email you paid with.** Until now the
  only self-serve route was revisiting the link Stripe sent you after
  checkout, which is no help once that link is gone. There is now a
  recovery page that re-issues a working key to the address on the
  purchase, free and as often as you need. Your existing key keeps
  working; this just gets you another one.
- **Your key is readable again from Options.** If Pro is active on one
  browser, Options now has **Show key** and **Copy key** buttons plus an
  "email yourself a backup" link, so moving Pro to a second browser or a
  new computer no longer needs the recovery flow at all. The key stays
  hidden until you ask for it.
- **A proper welcome page after checkout**, with the key, a one-click
  backup, what just unlocked, and the three steps to a first clean
  inbox.

### Fixed
- **A failed scheduled cleanup no longer blocks manual runs for two
  hours.** When a scheduled sweep could not inject into the Gmail tab,
  it left its "a run is in progress" marker behind and never cleared it.
  Every manual cleanup after that was refused with "a cleanup is already
  running" until the marker aged out two hours later. The marker is now
  released when the run never starts.
- **Scheduled sweeps and Auto-Pilot no longer walk into a run already in
  progress.** Scans, restores and the other read-only runs attach to the
  Gmail tab without setting that marker, so an unattended sweep could not
  see them: it would inject anyway, get silently ignored, record itself
  as having run, and strand its marker for two hours. Both now check the
  tab first and stand down cleanly, leaving the schedule to fire next
  time.
- **The progress page will no longer start a second cleaner on top of a
  live one.** A large run pauses to ask for confirmation in the Gmail
  tab, which freezes that page's scripting; the progress page read the
  silence as a dead engine and, after a minute, re-injected. Two engines
  then worked the same mailbox. Auto-reconnect now checks whether the
  cleaner is still attached and stops instead, pointing you at the
  waiting prompt, and the manual Re-inject button asks before overriding.
- **A cleanup that failed to start could clear a different run's
  progress marker**, undoing the protection against two runs at once.
  Each run now only ever releases its own.
- **Storage purges and smart applies no longer register work for a run
  that was refused**, which left the worker holding a marker for a run
  that never happened.
- **Estimated result totals are read correctly again.** Gmail writes
  large result counts as "of about 3,200"; the parser expected the digits
  immediately after "of", failed, and fell back to counting only the
  current page, so dry runs and bulk actions under-reported what they
  would affect.

### Changed
- Each **Get Pro** button now tags its checkout link with which feature
  it came from, so the sales record itself shows which one convinced
  people. Nothing is sent from the extension, nothing is recorded for
  anyone who does not buy, and the tag is a fixed label with no personal
  data in it. `npm run analytics` reads it back from Stripe.

## 7.13.1 - Steadier progress tab

### Fixed
- **A reused progress tab no longer stays stuck on the previous run.**
  If you left a finished progress tab open and started another cleanup,
  the extension brought that tab back to the front without refreshing
  it, so it kept showing the old run as over: the Cancel button stayed
  greyed out reading "Run finished" and the reconnect controls stayed
  disabled, even though a new cleanup really was running. There was no
  way to stop that run from the dashboard. The tab is now refreshed
  when it is reused, so it always tracks the run you just started.
- **Declining a duplicate run no longer leaves a dead dashboard
  behind.** When a cleanup was already running in the Gmail tab, the
  extension opened a progress page first and only then noticed and
  refused, stranding you on a fresh dashboard that sat on "Waiting for
  Gmail tab" forever. It now checks first and simply tells you a
  cleanup is already running, opening nothing.

### Changed
- The "is a run already attached" probe and the progress-tab opener are
  each written once and shared by all four run paths (cleanup, storage
  purge, smart apply, and the read-only scans) instead of being copied
  into each one. No behavior change beyond the two fixes above.

## 7.13.0 - Speaks your language

### Added
- **The popup now speaks 7 languages.** Every control, hint, upsell,
  status line, toast and the completion notification are localized into
  Portuguese (Brazil), Spanish, French, German, Russian and Japanese,
  following the browser's UI language automatically (English stays the
  default and the fallback). The cleaning engine has been
  locale-aware since 7.5.0; this release closes the gap for the
  interface itself. Terminology follows Gmail's own per-language
  vocabulary (Papierkorb, Papelera, Corbeille, Lixeira, Корзина,
  ゴミ箱...). The options, stats, progress and diagnostics pages remain
  English for now, as do rare error branches that quote raw browser
  errors.
- **Install-source guard.** The extension now checks how this copy was
  installed (`chrome.management.getSelf`, no new permissions). Copies
  planted by third-party software instead of an official store show a
  permanent warning banner with a link to the real listing, and
  scheduled cleanups plus Auto-Pilot refuse to run unattended on such
  copies, so a planted copy can never act on a mailbox by itself.
  Store installs, unpacked developer builds and enterprise-policy
  deployments are unaffected. The Diagnostics page now reports the
  install source next to the version.

### Changed
- The footer navigation wraps to a second line when a language needs
  more room than the 380px row offers (Russian does); previously long
  labels would have collided with the version text.

### Internal
- New `GCC.i18n` helper (catalog message with inline-English fallback,
  so tests and plain-page rendering keep working without `chrome.i18n`),
  full message catalogs for 7 locales, and a catalog integrity suite
  (key parity across locales, placeholder parity, escaped literal
  prices, markup/code key coverage). 720 tests across 30 suites.

## 7.12.1 - Auto-Pilot

### Added
- **Auto-Pilot (Pro).** A weekly scheduled Smart Suggestions sweep that
  keeps the inbox clean automatically. Each sweep runs the same
  read-only suggestion scan the popup offers, then archives the top
  recommendations in one ordinary cleanup run: archive only (Auto-Pilot
  never deletes), at most 25 senders per sweep, tag-before-action stays
  on so one-click Restore works, and the whitelist, protected keywords,
  starred and important guards all apply unchanged. The first scheduled
  sweep is always a dry run: the popup reports "would have archived N
  emails" and waits for an explicit confirm before any sweep goes live.
  The license is verified on-device before every sweep, sweeps honour
  vacation mode, and runs land in stats history and the Recovery Log
  like every other run. No new permissions, no new Gmail surface.

### Changed
- **The progress page's log toggle actually collapses now.** The old
  button only switched the log box between a capped height and full
  height, which usually looked like nothing happened. Hide logs now
  folds the whole section into a single line that keeps the entry
  count and the newest log entry in view, updates live, and clicks
  back open (reopening lands on the newest line). The log tools also
  work on the bad-URL error screen instead of being dead buttons.
- **Locked Pro controls now open checkout directly.** Toggling
  Auto-Pilot, clicking Unsubscribe selected, Purge selected or bulk
  apply without a license used to show a pitch line and stop; the
  click now goes straight to the $9.99 lifetime checkout page. The
  inline Get Pro links stay for anyone who wants to read first.
- **No Gmail tab? The extension opens one for you.** Run Cleaner, every
  scan, purge, bulk apply and Restore used to stop with "open Gmail
  first". They now open Gmail in a background tab, wait for it to
  load, and carry on by themselves. If Gmail asks you to sign in, the
  tab is brought forward and the popup says so instead of guessing.
- **The popup opens calm.** On a fresh install the Clean tab now fits
  the Run button on screen without scrolling: the "How it works"
  reassurance collapses to a single quiet line (its content stays one
  click away), the Monthly Light Clean preset joins the target chips as
  one quiet "pick what to clean" family, and the shouting all-caps
  section labels are now small sentence-case lines. Run Cleaner is the
  only saturated control on the tab. The version badge moved from the
  header to the footer, so the header is just the title and the theme
  switcher.
- **The light theme has real surfaces.** The page behind the card is a
  step darker, the card is solid white with a visible border, and
  sections, preset buttons, chips and rows carry their own borders
  instead of dissolving into the background. Both themes still meet
  WCAG AA (4.5:1) for text.
- **Pro is now $9.99, still one payment for life.** Existing keys are
  untouched and everything free stays free. Pro now has four pillars:
  bulk unsubscribe, Storage X-ray purge, the full Smart Suggestions
  list with bulk apply, and Auto-Pilot.

## 7.8.1 - Light theme contrast

### Fixed
- **Light theme text is readable everywhere.** Every page was audited
  for WCAG AA contrast (4.5:1) in both themes. In light mode, several
  Options labels rendered near-white on white, the explainer note was
  a gray-on-gray box, and rule pills, code chips, keyboard hints and
  the snooze button kept colors tuned for the dark theme. All of them
  now use dark, legible colors when the light theme is active.
- **Dim helper text got darker in both themes.** Secondary labels
  (section eyebrows, table headers, empty states, "Or target one
  thing", toggle hints) sat just below the readability threshold and
  now clear it in light and dark mode alike.
- **Progress page in light mode.** Run-phase tags, the version pill,
  summary chips and keyboard shortcut keys no longer use neon
  dark-theme colors on light backgrounds, and log timestamps in the
  terminal view are brighter.
- Version badges in the popup and diagnostics pages and the red
  "Clear Log" button on the stats page also meet contrast now.

## 7.8.0 - Smart Suggestions

### Added
- **The extension now recommends what to clean instead of making you
  configure it.** A new collapsible "Suggested" section at the top of
  the Clean tab runs one free, read-only scan that finds the senders
  worth cleaning and says why, in plain English ("142 emails, 96%
  unread, mostly older than 6 months"). Each card carries one primary
  action (delete old mail, archive all, or purge large mail) and a
  Dismiss control.
- **Hard vetoes before anything is suggested.** A sender is never
  recommended when they match your whitelist or protected keywords,
  when any of their mail is starred, or when your Sent folder shows
  you actually write to them. Vetoes beat every score, and the scan
  spends at most about 15 correspondence checks per pass.
- **Applying a suggestion is an ordinary cleanup run.** The suggestion
  only supplies the search query; tag-before-delete, dry run, the
  undo log, stats and the post-run recap all apply unchanged. Nothing
  new can touch mail.
- **A local feedback loop ranks future suggestions.** Dismissed
  senders stay silent for 90 days; an applied suggestion slightly
  boosts other senders from the same domain. The map lives in local
  storage, bounded, and never leaves the device.
- **Pro:** the full ranked suggestion list (the top 3 stay free) and
  bulk apply of checked suggestions in one run. Existing Pro keys
  unlock both automatically.

### Internal
- New read-only engine run kind `smartScan`, modeled on the
  subscription and storage scans; sender addresses pass the same
  strict email check before entering any query. Results persist under
  `smartScan` (union-merged across rescans), feedback under
  `smartFeedback`, and apply confirmation follows the same pending
  marker pattern the storage purge uses.

## 7.7.0 - Popup redesign

### Changed
- **The popup was rebuilt around one rule: fixed chrome stays small so
  the content gets the room.** The header is a single compact row (the
  theme switcher moved up into it), the footer is one row instead of a
  wrapping two, the always-on Pro pitch shrank to a slim strip, and the
  tab bar slimmed down. On a fresh install the whole Clean tab now fits
  the 600px popup without scrolling; before, the panel clipped mid-chip
  behind a native scrollbar.
- **One clear hierarchy per tab.** Run Cleaner is the only saturated
  button on the Clean tab. Monthly Light Clean and the one-category
  targets now read as a single "pick what to clean" preset group, with
  the targets on a steady 2x2 grid instead of a ragged pill row that
  wrapped and clipped.
- **Calmer visual language.** The always-running border glows and
  button pulses are gone (the amber pulse stays, but only while a run
  is live), along with the header grid overlay and the gradient title.
  Scrollable areas use slim themed scrollbars instead of the native
  arrows, and the popup honors the OS reduced-motion setting.
- Nothing functional changed: every control, id and keyboard shortcut
  from 7.6 is still in place, and both themes were retuned to match.

## 7.6.0 - Restore runs

### Added
- **Every logged run now has a one-click Restore.** Tag-before-delete
  has always labeled a run's mail before moving it, and Gmail keeps
  Trash for 30 days, so putting a run back was mechanically possible
  but tedious by hand. The Recovery Log on the Stats page now offers a
  Restore button on every eligible entry: it searches the run's label
  in a Gmail tab (Trash for delete runs, outside the Inbox for archive
  runs), selects everything the way cleanups do, including the "select
  all conversations that match" banner and its confirmation dialog,
  and clicks Gmail's own Move to Inbox control. Progress streams onto
  the page, the run can be cancelled mid-flight, and a finished run
  reports exactly what happened ("N conversations moved back to
  Inbox") and marks the entry Restored. Restore is part of the free
  safety net, not a Pro feature.
- **The restore engine is built to fail toward safety.** Its only
  mutating click is the verified move-back control: it never deletes,
  archives, or marks anything. The Trash toolbar also holds "Delete
  forever", so the restore finders carry a localized deny-list for it
  (the same seventeen-language coverage as the other token tables,
  every string verified against Google's localized help pages) and
  refuse a deny-listed control no matter how well it otherwise
  matches, on any of its labels, tooltips or text. A toolbar the
  engine cannot recognize does nothing: the mail stays in Trash,
  still recoverable by hand, and the run says so instead of
  pretending. An empty label search is reported as a finished restore
  ("nothing left"), because already-restored and already-emptied runs
  are normal outcomes, not errors.
- **Eligibility is honest about what can come back.** Restore only
  offers itself when the run verifiably applied its label; runs whose
  tagging failed never offer it, because without the label the only
  alternative is guessing by sender, which could drag unrelated
  trashed mail back to the Inbox. Delete-mode runs age out with
  Gmail's ~30-day Trash retention and say so in plain words; archive
  runs have no deadline. Entries older than the feature simply keep
  their "Find in Gmail" link.

## 7.5.0 - Locale support

### Fixed
- **Bulk unsubscribe now works on non-English Gmail.** The engine used
  to demand the literal English word "Unsubscribe" before it would
  touch Gmail's header unsubscribe control, so the paid feature
  silently failed on every other UI language. The control is now
  trusted by its structure (the class Gmail renders on it in every
  locale), and the confirmation dialog's buttons are recognized
  through per-language tables verified against Google's own localized
  help pages (Spanish "Darse de baja", German "Abbestellen", Japanese
  "登録解除", and fourteen more). Matching is exact whole text only:
  an "Unsubscribe and block" style button never passes as a plain
  confirm, an unrecognized dialog is closed without clicking anything,
  and unsubscribe links inside message bodies stay off-limits exactly
  as before.
- **Throttling is now recognized in the major locales.** Gmail's "try
  again later" style banners were only detected in English, so a
  throttled non-English run read as a timeout instead of engaging the
  adaptive backoff. The detector now carries the equivalent phrases
  for the same languages the rest of the engine speaks.

### Changed
- **Archive and label buttons are found in the same languages as
  delete.** Those two token tables covered six and eight languages
  against delete's seventeen; they now match delete's locale set, so
  archive-mode cleanups and tag-before-delete work wherever deletes
  already did.
- **The subscription scan searches in your Gmail language.** The scan's
  body-text discovery query used the English word "unsubscribe", which
  non-English newsletters rarely contain. It now picks the term that
  fits the mailbox's UI language (one term per run, English fallback)
  and keeps the two category searches unchanged.

### Added
- **Diagnostics now shows the last layout-change stop.** 7.4 taught the
  cleaner to stop and say so when Gmail changes its layout, and the
  popup pointed at Diagnostics, but Diagnostics had nothing to show.
  The extension now keeps a small local record of the most recent
  layout-change stop and Diagnostics renders it as a card: how long
  ago it happened, what the run reported, and the reminder that
  nothing beyond the already-reported work was touched.

## 7.4.0 - Ratings and trust

### Added
- **Your last cleanup greets you on the next open.** The popup closes
  itself when a run starts, so the 7.3 result screen almost never had
  an audience. Now, if a real (never dry-run) cleanup finished while
  the popup was closed, the next open replays it through the same
  result view, marked with a small "Recap" note and how long ago it
  finished. Each run shows once; the back button returns to the form
  as usual, and an in-flight run always takes priority over a recap.
  The earned rating ask (200+ emails or 100+ MB) applies to recaps
  exactly as it does to live results, so it finally has a chance to
  fire.
- **The cleaner now says so when Gmail changes its layout.** Gmail DOM
  churn is this extension's recurring failure mode. Two hard signals
  (search results on screen but no select-all checkbox anywhere, and
  tag-before-delete with no way into the label controls) now stop the
  run with a plain-words explanation: Gmail changed its layout, nothing
  was touched beyond what already completed, and an update usually
  follows within days. Before, the first read as a wrong-looking zero
  count and the second silently deleted without the promised tag
  safety net. Finding zero matches for a rule stays perfectly normal
  and never trips this. The popup points these errors at Diagnostics.
- **Gmail locale audit.** Every selector and text match the engine uses
  is now classified in `docs/gmail-locale-audit.md`: the destructive
  path (find, select, delete/archive) is structure-first and works off
  English, and the genuinely English-only spots (unsubscribe control
  text, rate-limit phrases, archive button tokens) are documented as
  7.5 work. New fixture tests pin the language-independent paths so
  they stay that way.

## 7.3.0 - Tabbed popup

### Changed
- **The popup is now three tabs: Clean, Unsubscribe, Storage.** The old
  single scroll column had grown past a dozen stacked sections; each
  feature now owns a panel under a fixed-height card (600px, the most
  Chrome allows a popup), so the header, tab bar and footer stay put
  and only the active panel scrolls. The tab bar is keyboard-first:
  arrow keys move between tabs, Home/End jump, and screen readers get
  real tab semantics.
- **Cleanup Strategy and Safety moved into one Advanced disclosure.**
  The three strategy dropdowns and the safety toggles now live in a
  collapsed "Advanced" section on the Clean tab, and it remembers
  whether you left it open. Defaults are unchanged; most runs never
  need to open it.
- **The result screen replaces the form.** When a run finishes with the
  popup open, the summary, the share/rate buttons and the rating ask
  take over the Clean tab instead of piling up underneath it, with a
  clear "Back to the cleaner" button.
- **One banner at a time.** If several notices are eligible, only the
  most important shows: Gmail access first, then the schedule snooze
  notice, then the pin hint.
- **"How it works" folds itself away.** The safety explainer starts
  open for new installs and collapses once your first cleanup is
  recorded; it stays a click away.
- **Upsells now lead with your own numbers.** After a scan, the
  Unsubscribe pitch opens with how many mailing lists were found and
  the Storage pitch with how many senders hold how many MB (always the
  scan's floor estimates). Before any scan, a short static line shows
  instead.
- **The rating ask is earned, not scheduled.** The star prompt now
  appears only right after a real (non dry-run) cleanup that removed
  at least 200 emails or freed an estimated 100 MB and up. "Maybe
  later" still dismisses it for good.

## 7.2.0 - Storage X-ray

### Added
- **Storage X-ray.** A new popup section that answers "what is eating
  my Gmail storage" by sender. The free scan is read-only: it walks
  Gmail's own size searches in tiers (25 MB, 10 MB, 5 MB), credits
  each large email its tier floor, and reports a total reclaimable
  estimate plus your top three space hogs. Every figure is a floor,
  never a guess upward.
- **Pro: full ranked list and one-click purge.** Pick the senders
  worth evicting and purge their large mail in one run. The purge is
  a standard cleanup under the hood (a `from:(...) larger:5M` rule),
  so tag-before-delete, Trash's 30-day window, the whitelist,
  protected keywords, dry run and the recovery log all apply
  unchanged. An age filter (default 6 months) protects recent mail.
  Purged senders keep a badge across rescans.
- The Pro pitch now writes itself: $5 once versus about $20 every
  year for more Google One storage.

### Changed
- Existing Pro keys unlock Storage X-ray automatically; one license
  covers both Pro features.

## 7.1.0 - Firefox and Edge support

### Added
- **Firefox support.** The extension now ships a dedicated Firefox
  build: event-page background instead of a service worker, a stable
  AMO add-on ID, options opening in a tab, and a declared
  no-data-collection policy (everything still runs locally).
  `npm run build:firefox` produces it; `npm run zip:all` produces both
  store zips. Verified clean by addons-linter, the same validator
  Firefox Add-ons runs on submission.
- **Edge support, documented.** Edge is Chromium, so the Chrome build
  installs there as-is; the README now says how.
- **Gmail access banner.** If the browser reports no permission for
  mail.google.com (Firefox lets users revoke it per extension), the
  popup shows an amber banner with a one-click Allow button instead of
  failing with a cryptic injection error.
- Rating and share links now open the store matching your browser:
  Firefox users land on Firefox Add-ons, everyone else on the Chrome
  Web Store.

### Changed
- **Toolbar icon is finally legible.** The 16px and 32px icons are
  re-cut from the source art with the envelope filling the frame
  (previously the 32px kept the whole tile, leaving the glyph tiny in
  the toolbar) and brightened for dark toolbars.
- Deep-intensity cleanup now confirms inline: the Run button arms and
  asks for a second click instead of popping a system dialog. Firefox
  silently swallows dialogs in popups, which would have made deep
  cleans unstartable there; the two-click flow behaves the same
  everywhere.
- Desktop notifications no longer pass the priority flag, which
  Firefox rejects outright.

## 7.0.2 - Neon icon artwork

### Changed
- **Final icon artwork.** The interim vector icon from 7.0.1 is replaced
  with the finished brand image: a neon cyan envelope with sweep lines
  glowing on a dark tile. The 16px toolbar size crops in on the envelope
  so it stays readable; corners are masked transparent at every size.
  Full-resolution source lives in `assets/icon-source.png`.
- The popup header mark now shows the icon tile edge-to-edge instead of
  floating a small copy inside a second tile.
- Highlight cyan (`--primary-strong` and its hardcoded echoes) nudged
  from #67e8f9 to #7bf1fd to match the icon's neon core, dark theme
  only; the light theme keeps its deeper teal for legibility.
- The buy and activation pages at gmail-cleaner-pro.netlify.app now
  carry the icon as their favicon (redeployed).

## 7.0.1 - New brand icon

### Changed
- **New icon set.** Replaced the old icon (a Gmail logo with a broom
  pasted on top) with an original mark: a cyan envelope sweeping clean
  on a dark tile, matching the extension's own design system. Original
  artwork also removes any trademark ambiguity with Google's Gmail
  branding. The SVG sources live in `icons/` next to the PNGs; each
  size (16, 32, 48) is tuned by hand so the toolbar icon stays legible.
- Icon PNGs now carry an alpha channel, so the rounded tile sits
  cleanly on both light and dark browser toolbars.

### Fixed
- The build no longer copies the SVG icon sources into `dist/` or the
  store zip; Chrome only loads the PNGs.
- Cleared 3 npm audit advisories in dev tooling (Babel, form-data,
  js-yaml). Nothing that ships in the extension was affected.

## 7.0.0 - Subscription scan + bulk unsubscribe (Pro)

Deleting hides old mail; unsubscribing stops new mail. This release adds
a way to see every mailing list that emails you and unsubscribe from the
ones you never read, in one pass, plus a one-time **$5 Pro** unlock to
run it. **Everything that was free stays free forever.** No existing
feature moved behind the paywall.

### Added
- **Subscription scan (free).** A new "Unsubscribe from mailing lists"
  section in the popup. The scan runs a few read-only discovery searches
  and samples the senders behind your subscription-style mail, then
  lists them ranked by how much they send. It changes nothing: no mail
  is moved, deleted, or altered. It is a plain inventory of who fills
  your inbox.
- **Bulk unsubscribe (Pro).** Select the senders you never read and
  unsubscribe from all of them in a single pass. For each sender the
  engine opens one of their messages and clicks **Gmail's own built-in
  Unsubscribe control** (the header "Unsubscribe" link and its
  confirmation dialog), which is backed by the sender's
  List-Unsubscribe header. It never touches unsubscribe links inside
  message bodies, which can point anywhere. Senders with no one-click
  option are flagged "manual step needed" rather than guessed at. Capped
  at 25 senders per run; re-run for more. Sender addresses are validated
  to a strict email shape before going into a `from:(...)` search, so a
  crafted address can never break out of the query.
- **Pro license.** A one-time **$5 lifetime** purchase unlocks bulk
  unsubscribe. Keys are verified **entirely on your device** with a
  public key built into the extension (ECDSA P-256 via WebCrypto); the
  extension never contacts a server to check a license, not even once.
  A valid key works fully offline. Activate it from the popup's **Pro**
  link or the Options page's new **Pro License** section. The key is a
  signed token with no personal data, stored in Chrome sync so Pro
  follows you to your other signed-in browsers.

### Changed
- **The popup and progress page now promote Pro instead of tips and
  affiliate links.** The Buy-Me-a-Coffee / Cash App tip links and the
  Amazon affiliate product section have been removed from the popup, the
  progress dashboard, and the Options page. In their place is a single,
  honest Pro upsell (hidden entirely once a license is active). One
  product to support the extension, not a wall of outbound links.
- Store listing title and description now mention **unsubscribe** so the
  feature is discoverable by people searching for it.

### Security / privacy
- No new permissions. Bulk unsubscribe reuses the existing
  `https://mail.google.com/*` host access and the same
  pointer/mouse-driven clicking the cleanup engine already uses.
- The "runs locally, nothing phones home" promise is preserved for the
  extension itself. The only network calls in the whole flow are ones
  **you** start: opening the Stripe checkout page, and the post-checkout
  activation page fetching your key. Both are part of the purchase flow,
  not the extension, and neither involves any Gmail data. See
  [SECURITY.md](SECURITY.md) for the full breakdown.
- The license-issuing service (a tiny Netlify function that verifies
  your Stripe checkout session and returns a signed key) lives in
  `netlify/` in this repo. It is **not** part of the shipped extension
  and is excluded from the build.

## 6.1.0 - Protected keywords (subject shield)

A content-based safety net to sit alongside the sender Whitelist. The
hardcoded Safe-Mode subject guard (receipts, invoices, shipping) is now
joined by a list **you** control.

### Added
- **Protected keywords.** A new "Protected Keywords (Never Delete)"
  section on the Options page. Any word or phrase you list there protects
  every message whose **subject** contains it from *every* rule, by
  appending a single `-subject:(kw1 OR "two words" OR …)` clause to each
  search. Where the Whitelist protects by sender, this protects by
  subject content (e.g. `tax`, `invoice`, `"flight confirmation"`,
  `lease`). It applies to manual *and* scheduled runs, in both live and
  dry-run mode, and it coexists with Safe Mode's built-in subject guard
  as a separate clause (both only ever *narrow* what a rule matches).
- Keywords ride along in config Export/Import (backup format bumped to
  v3; older v1/v2 backups import cleanly and never wipe existing
  keywords).

### Safety / internals
- Keywords are sanitized at three layers (options page, popup, and a
  defence-in-depth copy at the engine boundary): quoting, grouping, and
  boolean operators are stripped so a keyword can never break out of the
  `subject:( … )` group it is injected into; the list is trimmed,
  deduped case-insensitively, and capped (25 keywords, 50 chars each).
  The only failure mode is "protect more mail," which is the safe
  direction. No new permissions.

## 6.0.0 - Recovery overflow-menu fix, focused targets, accurate counts

The big one. Restores the recovery-by-label safety net, makes large
cleanups actually clean past the first screen, fixes affected counts,
and adds one-click category targeting.

### Fixed
- **Deletion actually deletes on current Gmail.** Two compounding bugs
  are fixed. (1) The toolbar Delete / Archive are Closure buttons that
  only react to a real pointer/mouse press, so the engine's plain
  `element.click()` was a silent no-op: rows looked selected but nothing
  reached Trash. A full `pointerdown` / `mousedown` / `mouseup` / `click`
  sequence (`fireMouseSequence`) now drives the action buttons, the
  bulk-confirm dialog, the "select all matching" link, and the overflow
  menu. Row and master checkboxes keep their plain `click()`; they
  respond to the click event and a `mousedown` there can double-toggle
  the selection. (2) `openSearch` accepted the page as loaded the instant
  the grid had any row, which during Gmail's in-place hash transition was
  the previous query's leftover rows, so the engine acted on a stale page
  and raced through every query in seconds selecting nothing. It now
  waits for the result list to turn over to the new query (or settle
  empty). Verified live: a deep run moved 179 conversations to Trash.
- **Tag-before-delete no longer stalls the run.** The recovery-label step
  used to wait up to five seconds on every delete pass for a label input
  that never appeared: Gmail's "Label as" is now a hover submenu inside
  the "More email options" overflow (not a dialog), and the old code
  grabbed the first (hidden) role=menu and looked for the input only
  under role=dialog. It now opens the overflow with the pointer/mouse
  sequence, resolves the menu that is actually on screen, hovers the
  "Label as" submenu, and searches menu-scoped selectors for the input,
  with the wait capped near a second so a miss skips fast. Deletion never
  blocks on tagging.
- **Tag-before-delete works on current Gmail again.** Gmail moved the
  "Label as" control into the toolbar's "More email options" overflow
  menu, so the old toolbar-only finder never found it and
  recovery-by-label silently never happened. The engine now opens the
  overflow menu (with a keyboard-shortcut fallback) to reach it, and the
  undo log's `taggingFailed` flag is honest instead of always `false`.
- **Accurate affected counts.** A confirmed "all N conversations
  selected" bulk delete uses the match total; a per-page delete uses the
  visible selection it actually acted on. Fixes the over-counting that
  inflated freed-MB and category stats on chunked runs.
- **Popup completion UI is wired to the real messages.** The popup was
  listening for done/cancelled/error message types the engine never
  sends; it now reads the actual progress contract, so the result
  summary, success actions, and recovery toast fire correctly.
- **No more lost stats / undo / sender data.** The service worker's
  read-modify-write storage handlers are serialized, so the rapid
  per-pass messages no longer clobber one another.
- **Scheduled cleanups stop drifting.** Alarms are anchored to the last
  run plus the interval instead of resetting on every browser restart.
- **Review mode can't hang forever.** If the progress tab is closed
  without a response, the run skips that rule after a timeout.
- **Diagnostics "content script attached" check** reads the correct flag,
  so it reflects reality during a live run.

### Added
- **Focused targets.** One-click chips in the popup (Promotions, Big
  attachments, Social & updates, No-reply) run a small, age-guarded rule
  set for just that category instead of the full intensity sweep. All
  global safety guards still apply.
- **Layout-change telemetry.** If Gmail reshuffles its selection classes,
  the engine warns instead of silently deleting nothing.

### Removed
- Dead Pro-tier lifetime-stats writer (the paid tier was dropped).

## 5.0.7 - Per-row selection fallback (real fix for the silent-no-delete bug)

Diagnosed by inspecting the live Gmail DOM against `mail.google.com`.
The "selecting it then just not deleting anything" report turned out to
be a far deeper Gmail behavior than the v5.0.6 verification fix
addressed:

- A programmatic `.click()` on the master checkbox toggles the master's
  own `aria-checked` to `"true"` and Gmail applies a CSS rule that
  fills in blue checkmarks on every visible row. BUT the row-level
  selection (`tr.x7` class, `[role="checkbox"][aria-checked="true"]`)
  never gets populated.
- Gmail's delete handler reads from the real selection model. With it
  empty, the click on Delete is a no-op. We then reported "0 affected"
  for runs where nothing got deleted because nothing was actually
  selected.
- Verified: clicking each row's checkbox individually DOES populate
  the real selection model (row gains `x7` class, checkbox
  `aria-checked` flips to `"true"`).

Also discovered the same way:
- Gmail no longer surfaces "N selected" text anywhere inside
  `div[role="main"]` in the current UI, that's why
  `extractSelectedCount()` always returned `null` on real runs.
- The Labels button has moved entirely into the "More email options"
  overflow menu (the toolbar never has a direct Labels button now).

Fixes:

- `extractSelectedCount()` now counts `tr[role="row"].x7` inside the
  result grid as the primary selection signal. Legacy text scrape
  retained as fallback for older Gmail layouts.
- `clickMasterCheckbox()` keeps clicking the master first (cheap;
  works when Gmail's master is in a layout that does cascade), but
  if the resulting selection count is 0, it falls through to
  `selectAllVisibleRowsIndividually()` which iterates every visible
  row's checkbox and clicks each. That populates Gmail's real
  selection model, so the subsequent Delete click actually deletes.

Tag-before-delete (the "Label button not found" warning) still goes
through the old finder; that path is queued for a follow-up patch
that opens the "More email options" menu first. Deletions now work
correctly without the tag step, the undo log still records the
metadata, just without the searchable label.

## 5.0.6 - Delete verification + accurate affected counts

Diagnosed from a user report: "it's selecting it then just not deleting
anything." Two compounding bugs:

1. `extractSelectedCount()` returns `null` when Gmail's "N selected"
   text drifts to a layout the function doesn't recognise.
2. `waitForActionProcessing()` treated `null` as success, so the engine
   reported `0 affected` and moved on, regardless of whether the delete
   actually fired. Silent false-positive.

Fixes:

- `waitForActionProcessing()` now requires **positive evidence** that
  the action happened: selection count dropped from a known-positive
  start, grid row count decreased, `hasNoResults()` settled, or
  Gmail's "Undo" toast appeared. Returns `{ ok, signal, startRowCount,
  endRowCount }` so callers know *which* signal fired and can derive
  the affected count from row delta.
- The affected count is now derived from the strongest available
  signal: declared selection > row-count delta > `rowsBefore` when
  page settled empty > 0. No more silent "0 affected" when rows
  actually disappeared.
- `tryDeleteAction` / `tryArchiveAction` log the button's
  aria-label / tooltip / title when clicked, so the progress log
  shows exactly which control was activated. If `findButtonByTokens`
  ever scores the wrong element, the next log will say so.
- New helpers: `getGridRowCount()` and `findUndoToast()`.

If Gmail genuinely refuses the click (UI state, focus, etc.), the
engine now throws `TimeoutError` and the retry loop re-attempts:
better to fail loudly than silently lie about success.

## 5.0.5 - Empty-search fast path + still-waiting beats

Diagnosed from another stuck-run log (query 1: `larger:20M` taking
~2 minutes before any retry, then retrying 6 times). `openSearch()`'s
wait condition only returned true when the result grid contained at
least one row, so any query that legitimately matched zero mail
(very common once global guards strip starred / important / unread /
user-labeled threads) sat for the full 20s wait, threw a
TimeoutError, and retried 6 times before either skipping (5.0.2) or
killing the run (≤5.0.1).

- `openSearch()` now also accepts Gmail's empty-state container
  (`td.TC`) as a valid "search settled" signal. Zero-match queries
  now resolve in well under a second; `hasNoResults()` downstream
  classifies them with `count=0` cleanly.
- `waitFor()` accepts an optional `onTick` callback; `openSearch`
  uses it to surface "Still waiting for search results (Ns)…" beats
  every ~5s so the user has evidence the engine isn't dead while
  Gmail is slow to render a heavy search.

## 5.0.4 - Spinner stays animated under reduced motion

The blanket `prefers-reduced-motion: reduce` rule in `shared.css`
killed every animation on the page via
`animation-iteration-count: 1 !important`, including the loading
spinner. The spinner is a state indicator ("system is busy"), not
decoration, so reduced motion shouldn't freeze it (WCAG carves out
essential animation explicitly).

Added a follow-up rule inside the same media query that re-enables
the spin animation for `.spinner` (0.6s) and the primary-button
busy spinner (`.primary.loading::after`, 0.8s). Higher specificity
beats the universal selector under equal `!important`, so the
override wins reliably.

## 5.0.3 - CSP `data:` fix for inline SVG chevrons

The meta CSP on every extension page declared `img-src 'self'`, which
blocks `data:` URLs. The select-dropdown chevron (an inline
`url("data:image/svg+xml,…")` background image in `popup.html` and
`options.html`) tripped this on every render, producing a console
error and dropping the down-arrow glyph on the rule-intensity / age
selects.

Added `data:` to `img-src` on all five extension pages. No new
external origins; the directive still rejects any non-`data:` /
non-self image source.

## 5.0.2 - Per-query failure isolation

Caught from another real-world log: in v5.0.0 / v5.0.1, when a single
query exhausted its 6 retries, `processQuery()` re-threw the
TimeoutError, which propagated up to `main()` and aborted the
**entire** run on the first stubborn rule. A user with one slow
search (`has:attachment larger:10M older_than:6m` matching too many
results for Gmail's UI to render in time) lost all 11 queries.

- After retries exhausted, the engine now classifies the failure as
  per-query (not run-wide) for known-transient errors (RateLimit /
  Timeout). The query is recorded as failed, a warning is emitted to
  the progress log, and the next rule starts. Cancellation and
  unexpected errors still abort the run.
- The 5.0.1 wall-time budget still fires for slow retries; the new
  exhausted-retries branch fires for fast retries that simply keep
  failing.

## 5.0.1 - Engine resilience

Diagnosed from a real-world stuck-run progress log: a single Gmail
search (`has:attachment larger:10M older_than:6m`) hit the action-
processing timeout, the engine entered exponential backoff, and the
log just said "Backoff 1758ms (timeout)" with no indication what was
actually waiting or how many retries were left.

- **Descriptive backoff messages.** The retry catch path now passes
  the underlying error message into `backoff()`, so the log reads
  "Backoff 3339ms (timeout: Action processing timed out (Gmail did
  not refresh selection/results))" instead of bare "timeout".
- **Per-query wall-time budget.** New `GUARDRAILS.QUERY_WALL_TIME_BUDGET_MS`
  (5 minutes). If a single query has been retrying for that long it
  gets abandoned with a clear warning and the run moves to the next
  rule, so one bad query can't pin the whole run for 10+ minutes.
- **Retry-counter progress.** Each retry now logs
  "<label>: retry N/6 after timeout" so the user can see structured
  progress through the retry budget instead of watching opaque
  backoffs.

## 5.0.0 - Extended Upgrade

A major release closing every open GitHub issue, adding ten substantial new
features, and shipping a deep deglitch + test pass across the codebase.

### New features

- **Light / dark / system theme.** Every extension page (popup, options, stats, progress, diagnostics) honours `prefers-color-scheme` automatically, with a manual switcher pill in each header. Choice persists across sessions.
- **First-run onboarding wizard.** A two-step popup explains the safe-by-default flow and points new users at Dry Run, custom rules, and the `?` keyboard shortcut. Skippable; shown once per install.
- **Custom rule template library.** Options page now has a chip row of curated safe queries (old promotions, large attachments, GitHub digests, Slack, LinkedIn, etc.) that add a custom rule with one click. Each template still passes through the same validator before persisting.
- **Drag-and-drop rule reordering.** Custom rules can be reordered with a drag handle in the options page; order is preserved in sync storage.
- **Snooze / vacation mode.** Pause all scheduled cleanups for N days from the options page. The popup surfaces a banner whenever snooze is active. Manual runs still work; only schedules are suppressed.
- **Top senders dashboard.** The stats page now ranks the senders that showed up most often in your cleanups, with Search-in-Gmail and one-click "Protect" (add-to-whitelist) buttons per row. Sender samples are collected by the content script before each delete batch and aggregated by the service worker.
- **Desktop completion notifications.** Optional opt-in toggle in the options page; when enabled, Chrome surfaces a system notification when a cleanup finishes so you don't have to keep the progress tab visible. New `notifications` permission, used only when the user enables it.
- **Keyboard shortcut overlay.** Press `?` in the popup for a modal listing every shortcut. Esc closes any open modal first, then the popup.
- **Auto-pause warning for large batches.** When a single delete batch exceeds 2,000 conversations, the engine emits a warning to the progress page before acting so the user can review.
- **Sender + thread-id sampling for the undo log.** Each undo entry now carries a sample of message thread IDs and a sender count taken from the Gmail list view before deletion. Tag-label search is still the primary recovery path, but it is no longer the only one.

### Issue fixes

- **#22** - Popup intensity restore now persists the user's raw UI selection (preserves "Monthly") instead of round-tripping through a dead `=== "monthly"` branch. A legacy-format migration handles existing storage entries.
- **#20** - `runCleanup` now uses an atomic-style "claim + verify" pattern (random `runId`, re-read after a micro-pause) before touching the Gmail tab, so two popups opened in parallel cannot both inject.
- **#19** - `tabsSendMessage` failures are now classified (`tab_closed` vs `permission` vs `other`) and the cancel handler surfaces a specific message instead of always saying "tab unreachable". Reuses the new `GCC.classifyChromeError` helper.
- **#17** - The stats page poller pauses on `visibilitychange` when the tab is hidden, resuming with an immediate refresh when the user returns. Generic `GCC.pollingInterval` helper is reusable for any future visibility-aware loop.
- **#16** - `web_accessible_resources` removed from the manifest. `shared.css`, `shared.js`, and `browser-polyfill.js` were only ever needed by extension pages (which have direct access), so exposing them to `mail.google.com` was a fingerprinting vector with no upside.
- **#10** - Schedule writes from the service worker now go through a quota-aware `safeSyncSet`. Oversized payloads throw a clear error and the save handler relays it back to the options page rather than silently truncating.
- **#9** - Undo log entries now carry sampled message thread IDs and a sender count from the Gmail list view, recorded before each delete batch.
- **#8** - Custom rule queries are now validated at two layers: the options-page editor refuses (and the engine quietly skips) any query that targets protected mail (`is:starred`, `is:important`, `in:sent`, `in:drafts`, etc.) without negation. Soft warning when `in:inbox` / `in:all` is used without an age qualifier.
- **#7** - `confirm()` and end-of-run `alert()` are now skipped when `CONFIG.scheduled` is true. Scheduled runs that hit the soft cap or huge-run threshold decline cleanly and report via the progress log instead of hanging on a modal dialog.
- **#6** - `runScheduledCleanup` checks the `ACTIVE_RUN` marker before injecting and claims its own marker for the duration. A manual cleanup in flight blocks the schedule rather than getting its `window.GMAIL_CLEANER_CONFIG` clobbered.

### Internal / DX

- New `GCC.theme`, `GCC.pollingInterval`, `GCC.safeSyncSet`, `GCC.validateGmailQuery`, `GCC.classifyChromeError`, `GCC.notify`, `GCC.downloadFile` utilities in `shared.js`.
- `sanitizeConfig` propagates `scheduled`, `runId`, and `scheduleId` so the engine can identify itself in undo log entries and confirmation guards.
- Background SW gained `gmailCleanerGetSnooze`, `gmailCleanerSetSnooze`, `gmailCleanerAddToWhitelist`, and `gmailCleanerRecordSenders` message handlers. Unknown message types now always respond instead of leaving the port open.
- Test coverage extended (issue #14, partial): new pure-function tests for `validateGmailQuery`, `classifyChromeError`, `safeSyncSet`, `pollingInterval`, and the content script's `queryHasDangerousToken` defense-in-depth filter.

### Folded-in 4.3.x cleanup (previously listed as Unreleased)

- Defer-loaded the three script tags on every extension page so module-scope DOM reads always fire post-parse.
- `GCC.sendMessage` resolves to `{ error, code }` on failure (codes: `no_chrome`, `send_failed`, `threw`).
- Whitelist sanitizer in `contentScript.js` aligned with `options.js`; hand-written values like `"user+tag@domain"` (no TLD) drop cleanly.

## 4.3.1

- Removed dead `broadcastToExtensionPages()` helper from the service worker.
  It was defined but never called; extension pages already receive progress
  messages directly via `chrome.runtime.sendMessage`. No behavior change.
- Fixed the stale `v4.0.0` version badge in the popup header. The badge now
  reads its label from `chrome.runtime.getManifest()` at init, so future
  version bumps cannot leave the visible chrome out of sync with the manifest.
- Added the missing `aria-controls` link between the Safety & Guardrails
  `<summary>` and its content panel in the popup. The other collapsible
  sections (Reassurance, Affiliate) already had it; this brings Safety inline
  for screen readers that surface the relationship.
- Added a `tests/version.test.js` suite that asserts `manifest.json`,
  `package.json`, every `*_VERSION` script constant, and the visible HTML
  version badges all agree. Catches drift in CI before it ships.
- Pinned the extension-page Content Security Policy explicitly in the manifest
  (`script-src 'self'; object-src 'none'`). MV3's default already enforces it,
  but writing it down keeps the policy reviewable.
- Removed the deprecated `document.execCommand("copy")` clipboard fallback in
  the diagnostics and progress views. Both pages now rely on the async
  Clipboard API and surface a "failed to copy" toast on error.
- Replaced the duplicated `formatNumber` in `progress.js` with the shared
  helper from `shared.js`. Local `formatDuration` and `formatMB` stay because
  they intentionally render compact values for the chip layout.
- Harmonized the "Find in Gmail" link in the stats undo log to
  `rel="noopener noreferrer"` so every external/new-tab anchor in the
  extension matches.

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

> Note: 2.10.1-2.10.4 were internal / pre-release iterations. Their changes are folded into the 2.10.5 notes above.

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

## 2.0.0 - MV3 Rewrite

- Migrated the extension to **Manifest V3**.
- Re-architected the extension around:
  - A service worker background script.
  - `chrome.scripting` for injecting the Gmail automation.
  - A dedicated Progress page to show run status.
- Added configurable options for future rule tuning.

---

## 1.x - Initial Releases

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
