// GENERATED FILE - do not edit by hand.
// Source: CHANGELOG.md. Regenerate with: npm run changelog
//
// The What's new page inside the extension reads this. It is baked in
// at author time rather than fetched, because a fetch of any kind,
// even of a file inside the package, would end the extension's
// no-network-calls promise.
//
// Carries the newest 12 of 74 releases; the page says so
// and links the full log on GitHub.

// eslint-disable-next-line no-unused-vars
var GCC_CHANGELOG = {
  "total": 74,
  "entries": [
    {
      "version": "8.18.1",
      "title": "The privacy policy lives with the source now",
      "sections": [
        {
          "name": "Changed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "The Privacy policy link opens the policy in this repository"
                ],
                [
                  "",
                  " instead of a page on another site. Same policy, same effective date, now version-controlled alongside the code it describes, so a change to what the extension does and a change to the document saying so land in the same commit. The terms of use moved with it."
                ]
              ]
            },
            {
              "text": "The first claim in that policy is that the extension makes no network requests, and the policy now shows you the one-line command that checks it for yourself."
            }
          ]
        }
      ]
    },
    {
      "version": "8.18.0",
      "title": "A calmer popup, and motion that means something",
      "intro": [
        "The Clean tab showed thirteen things at once while every other tab showed three or four, and the six controls at the middle of it were one decision pretending to be six. They are drawn as one group now. Nothing was removed and nothing was hidden: the safety and privacy lines still sit right under the button they describe, where they have been since 8.7.",
        "The rest is motion, and the point of it is that the parts you drive now respond. Switching tabs, a scan filling a list, a count landing, a button being pressed: all of those used to happen between one frame and the next. The parts that already animated were mostly the parts nobody touches."
      ],
      "sections": [
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "The tab bar has one indicator that slides between tabs"
                ],
                [
                  "",
                  ", so the selection travels instead of blinking out on one tab and in on another."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Scan results arrive a row at a time."
                ],
                [
                  "",
                  " Thirty senders appearing in a single frame reads as a flash; the same thirty arriving over a third of a second reads as a result."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Mailbox Report's headline count rolls up to its total"
                ],
                [
                  "",
                  ", as do the four figures on the Stats page."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Buttons press."
                ],
                [
                  "",
                  " They compress quickly under the pointer and spring back, rather than changing colour and nothing else."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A run with no count yet shows a moving bar"
                ],
                [
                  "",
                  " instead of an empty one. An empty bar and a stalled run looked the same."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The daily-activity chart animates."
                ],
                [
                  "",
                  " It always carried the instruction to and never once obeyed it: the bars were sized before they were on the page, so there was nothing to animate from."
                ]
              ]
            }
          ]
        },
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "The skip link on the progress page was almost invisible."
                ],
                [
                  "",
                  " White text on the cyan background measured 1.81:1, and that link exists only for people navigating by keyboard or screen reader."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Half of the Cancel button was unreadable."
                ],
                [
                  "",
                  " Its background faded from a light red where the white label measured 2.77:1. Both ends clear 4.5:1 now. It is the button that stops a run, so it should be the easiest one to read."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The scan buttons were the wrong blue in the light theme."
                ],
                [
                  "",
                  " They hardcoded the dark theme's bright cyan, so on the light theme three of the four tabs had a neon edge on a white card."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Chart bars can be read without a mouse."
                ],
                [
                  "",
                  " They are focusable and announce their date and count, instead of showing it only on hover."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Settings had one panel with a border that never drew"
                ],
                [
                  "",
                  ", because it named a colour that does not exist."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Reduced motion now also switches off the row-by-row timing."
                ],
                [
                  "",
                  " Without that the new stagger would have survived as a flicker for exactly the people who asked for less movement."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.17.0",
      "title": "Three free unsubscribes so you can see it work",
      "intro": [
        "Bulk unsubscribe is the one paid feature you cannot try with a Clean-tab rule. You could scan, tick the senders you hate, and then hit a paywall for something you had never seen work. Every unpaid install now gets three real unsubscribes on its own mail, once. After that the usual paywall takes over, and it can name the number you just watched be real."
      ],
      "sections": [
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Three free unsubscribes, once, for the life of the install."
                ],
                [
                  "",
                  " The Lists tab says how many you have left before you click. Only senders that actually unsubscribe count against it. A cancelled run, a failed run, or a sender that needs their website costs you nothing. When the three are used up, Pro is what it was."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The three are spendable from a Smart Suggestions card too."
                ],
                [
                  "",
                  " There are two places to unsubscribe from one sender, and three free ones now mean three in both. Spending one from a card says so as it goes, and the count on the Lists tab moves with it. Bulk apply is still Pro: one card is not bulk."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.16.0",
      "title": "Runs that stopped are not runs that finished",
      "intro": [
        "A tidy-up release, and most of it comes from one thing being true in more places than anyone had noticed: pressing Cancel, or a rule running out of room, left the extension believing the job was done. The other half is a batch of settings pages that could paint an empty list when storage had a bad second, and then save it."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Cancelling a cleanup marked the work as finished."
                ],
                [
                  "",
                  " Stopping a run half way still ticked the Mailbox Report step off as Cleared, still stamped senders as Purged on the Storage X-ray, and still counted a suggestion as applied. The Cleared badge also takes that step's Run button away, and on the free plan that is the one step you have, so cancelling could cost you it. A run that errors out did the same. All four of those marks now wait for a run that really finished."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A run that ran out of room said nothing afterwards."
                ],
                [
                  "",
                  " A single rule can hold more mail than one run can get through, and Gmail sometimes slows a rule down until the extension gives up on it and moves on. It says so at the time, in the progress log, and that was the only place it ever said it: the result screen still read \"Cleanup Complete!\", the desktop notification still read like a finished sweep, and the Mailbox Report ticked the step off. The result screen, the recap, the notification and the Auto-Pilot line now all say a rule stopped early and that running it again carries on where it left off."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The number of emails a search had found could be read off your mail instead."
                ],
                [
                  "",
                  " The extension looks for Gmail's \"1-50 of 12,438\" counter to size a run. It searched the message list before the toolbar the counter actually sits in, and accepted any short text with \"of\" and a number in it, so a subject line like \"Part 3 of 12\" or \"Best of 2024\" could stand in for the total. That number is what the Mailbox Report shows against every step, what Smart Suggestions ranks senders by, what Dry Run quotes and what the too-big-to-run-unattended check is measured against. It reads the toolbar first now, and only accepts text shaped like a real counter."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Settings page could save an empty Never Delete list over your real one."
                ],
                [
                  "",
                  " If reading your synced settings failed for a moment, the page drew empty lists, said \"Settings loaded\", and treated that emptiness as your settings. Pressing Save then wrote it. The page now refuses to draw or save anything until it has actually read what is there, and says so. Exporting and importing refuse on the same page state: a backup built from lists that were never read would record an empty Never Delete list as your settings, and an import cannot be undone when the storage its rollback needs is the storage that is failing."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Pro: opening Settings during a storage hiccup could reset four of your Pro settings."
                ],
                [
                  "",
                  " The card drew the defaults, took them as your current values, and wrote all six back the moment you changed one. One of them decides how much of your recovery log is kept, so a 300 entry log was trimmed to 60 on the next run and runs you could still have undone stopped being restorable. The card now stays blank and locked rather than showing values that are not yours."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Pro: Auto-Pilot could switch itself off in the middle of a sweep."
                ],
                [
                  "",
                  " If reading its settings failed while a sweep was finishing, \"off, and not yet confirmed\" was written back over your real settings. The weekly timer kept firing and nothing happened, the switch read as off, and turning it back on dropped it to preview mode until you found the confirm button again. The same read failure at browser startup deleted the weekly timer for the whole session while the switch still showed as on."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Importing a settings file with no whitelist in it emptied yours."
                ],
                [
                  "",
                  " Custom rules, protected keywords and schedules were all left alone when a file did not carry them. The whitelist, which is the one that decides what never gets deleted, was overwritten with nothing."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Vacation mode could be ignored by the runs it is for."
                ],
                [
                  "",
                  " If the extension could not read whether you had snoozed, it treated that as \"not snoozed\" and let the scheduled and Auto-Pilot sweeps go ahead. Unattended work now waits when it cannot tell."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Snooze reported success whether or not it saved."
                ],
                [
                  "",
                  " The Settings page said \"Schedules snoozed 14 days\" without checking, so a write that failed left the sweeps running with nothing to suggest it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Clearing the recovery log could be undone by a run finishing beside it."
                ],
                [
                  "",
                  " The two writes were not queued against each other, so a cleanup that finished at that moment put every entry back."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Traditional Chinese: cleanup could not find the Delete button."
                ],
                [
                  "",
                  " The extension knew the Simplified Chinese word and not the Traditional one, which are different characters, so a run selected the mail and then stopped, having done nothing. Archive and labelling already knew both."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Safe Mode did not shield receipts in six languages."
                ],
                [
                  "",
                  " Swedish, Danish, Norwegian, Polish, Turkish and Arabic mailboxes were checked against the English words only, and Traditional Chinese against the Simplified ones, while Safe Mode reported itself as on. Norwegian is covered whichever of the two language codes Gmail uses."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"Find in Gmail\" in the recovery log searched for nothing."
                ],
                [
                  "",
                  " Every recovery label has a space in it, and the link did not quote it, so Gmail searched for a label that does not exist and showed an empty result next to a Restore button that would have worked."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A refused cleanup left the popup looking like a live one."
                ],
                [
                  "",
                  " Starting a cleanup while a scan was still running is correctly refused, but the popup kept the running status, the Cancel button and an Open progress button that handed back a finished dashboard for somebody else's run."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Five refusals on the scan buttons were in English only."
                ],
                [
                  "",
                  " The one that matters most tells you to allow Gmail access, which is the single thing that fixes it. Every other copy of the same sentence in the popup was already translated."
                ]
              ]
            }
          ]
        },
        {
          "name": "Changed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Very long searches say so."
                ],
                [
                  "",
                  " With a big whitelist and a long list of protected keywords, the search the extension builds can get long enough to be worth trimming, and the exclusions are the part on the end. A run now says so once, and names the two lists to trim."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Pro panel counts its own history correctly."
                ],
                [
                  "",
                  " It said buyers from the first version got the four features that came after. There have been five."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Settings page stops selling something that is already free."
                ],
                [
                  "",
                  " It described the full Storage X-ray as part of Pro. The list of what is filling your mailbox has been free since 8.13; the one-click purge under it is the paid part. Pro Settings was missing from the same sentence."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.15.0",
      "title": "Quality of life, and the safety lists that would not say no",
      "intro": [
        "A tidy-up release. Most of it is small things that were quietly in the way: steps you had already cleaned that would not offer to run again, lists that made you scroll to find out what you could still undo, and a Pro setting that did not do what it said. One fix underneath all of that matters more than the rest, and it is the first one below."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "A cleanup could run with your Never Delete list missing."
                ],
                [
                  "",
                  " Your whitelist and your protected keywords are read when a run starts and handed to the cleaner, which is the only way it knows to leave that mail alone. If either read failed for a moment, and storage does fail for a moment sometimes, the answer came back as an empty list rather than as an error, and the run went ahead with nothing protected. The popup, the progress page and the recovery log all reported an ordinary successful cleanup. A run and a scan now stop and say so instead."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A step you cleaned part of the way was marked Cleared for good."
                ],
                [
                  "",
                  " A big step can stop part-way, and the cleaner says so at the time: \"run the cleaner again to continue this rule.\" The Mailbox Report ticked it off anyway. The row kept showing thousands of emails with a Cleared badge and no Run button, \"Run the whole plan\" skipped it, and nothing ever put it back. The badge now means the step is empty, so a fresh scan that still finds mail there gives you the button back."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A second Gmail account could be told to stop by the wrong window."
                ],
                [
                  "",
                  " With two mailboxes open, a finished progress dashboard left open for the first one joined in on the second one's run: it filled its table with the other account's rows and raised the other account's confirmation. Answering on that window sent the answer to a run that was already over, so the live one waited, gave up and stopped after you had clicked Continue. Each dashboard now only listens to its own Gmail tab."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Clear stuck run could start a fresh cleanup a minute later."
                ],
                [
                  "",
                  " That button clears the flag that says a cleaner is attached to the tab, and the dashboard reads that same flag when it decides whether to reconnect a run that has gone quiet. So pressing it and walking away looked like a cleaner that had vanished mid-run, and one was started again, from whatever settings ran last. The dashboard now treats a cleared run as over, and it will never re-inject on a page that has not heard from a run at all."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "An imported schedule never actually ran."
                ],
                [
                  "",
                  " Importing a settings backup wrote the schedule and showed it as Enabled, but nothing told the extension to set the timer, so the unattended cleanup sat there doing nothing until the next time the browser restarted. Import now sets the timers, and the list on screen updates to match."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The account picker could name the wrong mailbox."
                ],
                [
                  "",
                  " With two Gmail tabs open it always highlighted the first one, while a run went to whichever mailbox you were looking at. The other half of the same split: choosing an account and then having any run finish, including a scheduled one you did not start, threw the choice away while the highlight stayed put."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A backup with more rules than the extension stores said nothing about the ones it dropped."
                ],
                [
                  "",
                  " Version 8.14 fixed this for the whitelist and the keywords. Rules were still counted in a way that hid it, because the missing categories get filled in from the defaults."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The summary after an archive run said your mail went to Trash."
                ],
                [
                  "",
                  " An archive run that found nothing to move was filed as a deletion, so the popup offered to reassure you about a 30 day Trash window for mail that was never deleted."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Auto-Pilot could start a sweep just after you turned it off."
                ],
                [
                  "",
                  " Between the weekly timer firing and the sweep starting there is a second or so of checks, and switching Auto-Pilot off inside that gap was missed. Your mail was never touched, that part was already guarded, but the scan still ran and your Gmail tab still churned through it."
                ]
              ]
            }
          ]
        },
        {
          "name": "Changed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Pro: 50 senders per Auto-Pilot sweep now clears 50."
                ],
                [
                  "",
                  " The setting chose the senders correctly and then built the sweep from the first 25 of them, so picking 50 cleared exactly what 25 cleared. 10 and 25 were never affected."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The recovery log says how long you have left."
                ],
                [
                  "",
                  " Every deleted run now shows the days remaining before Gmail empties that mail out of Trash, while there is still time to do something about it, rather than only explaining itself once the deadline had passed."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Cleanup results say when the space actually comes back."
                ],
                [
                  "",
                  " Deleting moves mail to Trash and Google keeps counting it until Trash empties, about 30 days later. The result screen and the progress dashboard now say so, so a storage bar that has not moved yet is not a surprise."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Cleaning by sender or by inbox gets a name."
                ],
                [
                  "",
                  " Those runs were all labelled \"Other\" in Gmail, in the recovery log and on the Stats page, which made a weekly Auto-Pilot sweep hard to tell from anything else. They are labelled Senders and Inbox now. Runs that already had a name keep it exactly as it was."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Protect on the Stats page knows who is already protected."
                ],
                [
                  "",
                  " It offered itself on every sender, including ones your whitelist already covers, and reported adding a duplicate as a fresh success. Senders already covered now show as protected instead."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Bulk unsubscribe stops re-doing senders it has finished."
                ],
                [
                  "",
                  " Ticks are remembered between sessions, which is right up until a run settles a sender: after that every later run started with them ticked again and spent part of its 25 sender budget repeating itself. Senders that still need their own website are marked and left out; senders where Gmail's control simply could not be found stay available to retry."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Pro Settings warns before you lose an edit."
                ],
                [
                  "",
                  " That card saves on its own button, and it was the one part of the Settings page that could be changed and closed without a word."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The scheduled cleanup rows announce themselves properly."
                ],
                [
                  "",
                  " Their enable and remove buttons read as a state word and a punctuation mark to a screen reader, identically on every row, for controls that change and delete an unattended cleanup with no confirmation step."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.14.0",
      "title": "Imports that say what they drop, and a recovery log that stays put",
      "intro": [
        "A tidy-up release. Nothing new to learn: importing a settings backup now tells you the truth about what it kept, your recovery log stops shrinking when it should not, and buying Pro updates the page you are already looking at."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Importing a settings backup no longer drops entries quietly."
                ],
                [
                  "",
                  " The confirmation counted what was in the file, but the extension stores at most 100 whitelist entries, 50 rules per level and 25 protected keywords, and it skips anything it cannot read, such as a mistyped address. So a backup with 150 whitelist entries asked about 150, kept 100, and finished with a plain \"imported successfully\" - and the 50 senders that fell off were 50 senders whose mail was no longer protected from a cleanup. The confirmation now counts what will actually be stored, spells out anything that will be dropped, and says so again once the import is done."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The recovery log stops trimming itself when it cannot check your key."
                ],
                [
                  "",
                  " With Pro you can raise the log from 60 entries to 300, and the cap is applied every time a run is recorded. If the licence check could not complete at that moment, for instance because storage was briefly unavailable, it was read as \"no licence\" and the log was cut back to 60 on the spot. Those entries are how one-click Restore finds an old run, and they were not coming back. The log is now left alone whenever the answer is not certain."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The daily stats cleanup can no longer erase a cleanup that finished beside it."
                ],
                [
                  "",
                  " Once a day the extension drops day counters older than 90 days. If a run finished while that was in progress, the tidy-up could write back what it had read a moment earlier, taking the run's totals and its entry in the Stats history with it - including the Restore button attached to that entry."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The version announced to screen readers on the popup was four releases out of date."
                ],
                [
                  "",
                  " The button showed the right number; the label read aloud did not."
                ]
              ]
            }
          ]
        },
        {
          "name": "Changed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Activating Pro updates a Settings page you already have open."
                ],
                [
                  "",
                  " Buying in one tab and having Settings open in another left the second one showing \"Get Pro\" and a locked Pro Settings card until you reloaded it. It now notices, in both directions: removing your key elsewhere locks the card again."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Pro line on the completion notification has a limit."
                ],
                [
                  "",
                  " It was appended to every qualifying run, so cleaning your mail daily meant a daily sales line in a desktop notification, with no way to stop it except turning completion notifications off entirely. It now waits a week between showings and stops after three."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Pro summary in the popup names all six paid features."
                ],
                [
                  "",
                  " It had been listing three of them since two more shipped."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.13.0",
      "title": "The whole storage list, and one-click activation",
      "intro": [
        "A smaller release. The Storage X-ray stops hiding most of what it found, buying Pro no longer means copying a long key by hand, and the Pro Settings card gained three more knobs."
      ],
      "sections": [
        {
          "name": "Changed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "The Storage X-ray shows every sender it ranked."
                ],
                [
                  "",
                  " The free scan listed the top three and counted the rest behind a line about Pro. That scan is read-only and the numbers in it are your own mailbox, so there was never a good reason to hold most of it back. The whole ranked list is free now. The one-click purge underneath it is still the paid part."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The rating prompt asks more than once."
                ],
                [
                  "",
                  " It used to appear after one good cleanup and then stay quiet for 90 days if you picked \"Maybe later\", which in practice meant most people were asked exactly once ever. It now appears after any cleanup big enough to be worth asking about, with three limits: never on your first run, nothing for three days after you decline, and nothing ever again after three declines or one press of the new \"Don't ask again\"."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The completion notification mentions Pro if you do not have it."
                ],
                [
                  "",
                  " One line, appended only to a run that really cleared mail, and never shown to anyone with a key. Desktop notifications are off unless you turned them on, and turning them off again stops this too."
                ]
              ]
            }
          ]
        },
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Activate Pro in one click."
                ],
                [
                  "",
                  " The page you land on after checkout, and the key recovery page, can now hand the key straight to the extension instead of asking you to paste it into Options. This works in Chrome and Edge; Firefox does not support the mechanism, so it still shows the key to copy, exactly as before. Two things make it safe to have at all: the extension accepts messages from gmail-cleaner-pro.netlify.app and from nowhere else, and any key that arrives is checked against the same public key built into the extension before it is stored, so a web page cannot grant itself Pro."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Three more Pro settings."
                ],
                [
                  "",
                  " How many senders one Auto-Pilot sweep clears (10, 25 or 50; it was fixed at 25). An age floor for unattended runs only, applied on top of everything else and only when it is stricter, so it can narrow a sweep and never widen one. And how many entries the recovery log keeps before the oldest fall off (60, 150 or 300; it was fixed at 60, and a bigger log means a run stays restorable for longer). All three default to exactly what 8.12 did."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A 30-day money-back guarantee on Pro."
                ],
                [
                  "",
                  " Worth saying plainly: a refunded key keeps working. Keys are verified on your device with no network call, so there is nothing to switch off remotely, and adding that would mean the extension phoning home."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A Pro card on the Stats page"
                ],
                [
                  "",
                  ", for people without a key. It quotes the totals already on that page and disappears once a key is activated."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.12.0",
      "title": "The views mail does not come back from, and settings for Pro",
      "intro": [
        "Two halves. The first closes the ways a cleanup could reach Trash and Spam, which are the only two places in Gmail where deleting is permanent and where nothing this extension does can get your mail back. The second is a new Pro Settings card: three things buyers have asked to control, none of which take anything away from the free version."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Trash and Spam could be reached by a spelling the refusal missed."
                ],
                [
                  "",
                  " A rule scoped to Trash or Spam has been refused since 8.8, because in those two views Gmail's delete button means Delete forever and the recovery label this extension writes cannot help you. That refusal only ever covered one way of writing it. Gmail also accepts "
                ],
                [
                  "c",
                  "label:trash"
                ],
                [
                  "",
                  " and "
                ],
                [
                  "c",
                  "label:spam"
                ],
                [
                  "",
                  ", which sailed through, and "
                ],
                [
                  "c",
                  "in:anywhere"
                ],
                [
                  "",
                  ", which covers both and needed nothing but a date to pass every check. All three are refused now. If you have a rule using one of them it will be refused with a message rather than run; plain "
                ],
                [
                  "c",
                  "older_than:"
                ],
                [
                  "",
                  " searches already leave Trash and Spam alone, so that is the rule to use instead."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The button the cleaner presses could have been Delete forever."
                ],
                [
                  "",
                  " Every part of this extension that restores mail has refused a control labelled Delete forever since 7.6, before it even scores the candidates. The part that deletes had no such check, and its own pattern matches the words \"Delete forever\" perfectly well. It now refuses it too, in all twenty-one languages the restore side already covered, so even a Gmail redesign nobody predicted cannot hand it that button."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The biggest cleanups were the ones measured at a single page."
                ],
                [
                  "",
                  " When a search matches more than fits on screen, Gmail offers to select every match, and this extension takes that offer. To size the confirmation you get, it then reads Gmail's \"1-50 of 3,200\" counter. On very large result sets Gmail does not print a number there at all, it prints \"of many\", so the count came back empty and everything fell back to the fifty rows on screen: no large-run confirmation, a Dry Run quoting fifty for a sweep of forty thousand, and a receipt to match. It now also reads the total out of Gmail's own \"Select all 9,000 conversations\" offer, which names it in every language. If neither can be read, the run is treated as too large to do quietly, and asks."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Safe Mode only protected receipts written in English."
                ],
                [
                  "",
                  " Safe Mode skips receipts, invoices, orders and shipping notices, and the popup offers it in seven languages. The list of words it looked for was English only, so on a German, Japanese or Spanish mailbox Safe Mode was on, said it was protecting your receipts, and matched none of them. It now looks for the equivalent words in eleven languages and keeps the English ones as well, since a lot of commercial mail is in English whatever your Gmail is set to."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "An unattended cleanup that skipped everything said nothing matched."
                ],
                [
                  "",
                  " Scheduled cleanups and Auto-Pilot decline anything large enough to need a confirmation, because there is nobody there to give one. That decline looked exactly like finding no mail, so the notification said your rules matched nothing, and a schedule could quietly stop doing anything for weeks. It now says how many rules were skipped and why."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Gmail's \"all 50 on this page are selected\" was read as \"all of them\"."
                ],
                [
                  "",
                  " The sentence Gmail shows to tell you only the visible page is selected contains the words \"all\" and \"selected\", which is exactly what the check was looking for. If the select-everything click did not take, the run then recorded the full match total against an action that touched fifty. The check now treats Gmail still offering to select everything as proof that it has not happened."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Auto-Pilot swept further back than it measured."
                ],
                [
                  "",
                  " If your minimum age was set to a year, the weekly scan counted your mail through that floor and the sweep that followed ignored it and went back six months. The two now use the same floor. This can only ever narrow a sweep."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Never Delete quietly held 100 addresses."
                ],
                [
                  "",
                  " Paste 150 protected senders in, press Save, and the page said \"Settings saved successfully!\", the counter said 150, and 100 were stored. The rest were not protected. Over-long lists are refused now, with a message saying how many to remove, and nothing is written until they are. The same was true of "
                ],
                [
                  "b",
                  "Protected Keywords"
                ],
                [
                  "",
                  " at 25 entries, and of the per-intensity rule boxes at 50 rules each."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Restore defaults said it worked even when the save failed."
                ],
                [
                  "",
                  " It never checked, so a refusal showed a red message and then a green one, and left the page displaying settings that had not been stored."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Schedules reported success when the extension had refused them."
                ],
                [
                  "",
                  " Adding, enabling, disabling and removing a scheduled cleanup all ignored the answer and always said it worked."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Enter ran a cleanup from any button in the popup."
                ],
                [
                  "",
                  " Focus anything that was not a dropdown or a tab, press Enter, and a real cleanup started instead of the button doing its job. Opening the Pro panel puts focus on Get Pro, so pressing Enter to buy started a cleanup. Enter now only starts a run when nothing else has a use for it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Buyers saw the Pro padlocks on every popup open."
                ],
                [
                  "",
                  " Checking a licence takes a fraction of a second, and until it finished the popup showed the padlocks and the gold Pro badge meant for people who have not bought it. It now remembers the answer and shows the right thing immediately."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The storage purge forgot which age you picked."
                ],
                [
                  "",
                  " It remembers which senders you ticked so you can run it again for the rest, but the age reset to six months every time the popup closed, which is wider than anything else the menu offers."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A storage purge that failed part way marked every sender done."
                ],
                [
                  "",
                  " A purge of ten senders that cleared one and then stopped ticked all ten as purged, so the ones still to do looked finished."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Turning Auto-Pilot off during a sweep did not stop the sweep."
                ],
                [
                  "",
                  " It cleared the paperwork, and the sweep carried on archiving in the background without recording anything it did. The stop checks that the sweep it is stopping is still the one running in that tab, so it can never interrupt a cleanup you started yourself."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "An unattended run that was refused now says so in the notification."
                ],
                [
                  "",
                  " The notification is the only thing an unattended run can show you, and it was reporting \"0 emails moved to Trash\", which reads as a clean mailbox."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Diagnostics reported a size band as megabytes freed"
                ],
                [
                  "",
                  ", still counted storage freed for archive runs, which move mail without freeing anything, and probed eight settings that have never existed. The Gmail-layout warning can also be dismissed now, instead of staying on the page forever after one bad run."
                ]
              ]
            }
          ]
        },
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Pro Settings."
                ],
                [
                  "",
                  " A new card on the Options page, for people with a licence. Everything on it defaults to what the extension already did, so nothing changes unless you change it, and nothing that used to be free has moved behind it."
                ]
              ],
              "sub": [
                [
                  [
                    "b",
                    "Recovery label."
                  ],
                  [
                    "",
                    " The label put on mail before it is cleaned, so you can find it again. It has always been \"GmailCleaner\"; now it can be whatever you like. Older cleanups keep the label they were tagged with, so this never breaks a Restore you could do yesterday."
                  ]
                ],
                [
                  [
                    "b",
                    "Auto-Pilot interval."
                  ],
                  [
                    "",
                    " Weekly, every two weeks, or every 30 days."
                  ]
                ],
                [
                  [
                    "b",
                    "Smart Suggestions scan depth."
                  ],
                  [
                    "",
                    " The standard scan measures your ten heaviest senders. Deep measures twenty, finds more, and takes about twice as long."
                  ]
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.11.0",
      "title": "The paid half, and previews that say they were previews",
      "intro": [
        "Most of this release is on the parts of the extension you only see after you have paid for it. Five of the fixes are on Pro controls, three of them are the same problem in three places: a button that quietly did less than you asked it to and never said so."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Apply selected threw away your Unsubscribe suggestions."
                ],
                [
                  "",
                  " Suggestion cards come in two kinds. Most of them build a cleanup rule, and one of them, Unsubscribe, drives Gmail's own unsubscribe control instead. Bulk apply can only run the first kind, and rather than say so it dropped the others on the floor. Tick three Unsubscribe cards and two Archive cards, press Apply selected, and two ran while nothing on screen mentioned the other three. Unsubscribe cards no longer offer a tick box they cannot honour, Select all skips them, and if any do reach the button it now names the one that will actually run them."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The storage purge stopped at 25 senders without a word."
                ],
                [
                  "",
                  " One purge takes at most 25 senders, and the list above it holds up to 100 with a Select all sitting on top. So the ordinary way to use the feature, tick everything and press Purge, cleaned the biggest 25 and abandoned the rest in silence. It now tells you how many of your selection it is taking and to run it again for the remainder, which is what the Unsubscribe tab has said about its own identical limit since Pro launched."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Auto-Pilot could sweep a different Google account than it measured."
                ],
                [
                  "",
                  " The weekly scan takes a few minutes and pins the mailbox it is looking at. The sweep that follows went and found a Gmail tab of its own instead, preferring whichever one you happened to be looking at. If you are signed in to two accounts and switched to the other one mid-scan, the sweep archived that mailbox using suggestions measured in the first, unattended. It now runs in the mailbox it measured, or waits for next week."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Auto-Pilot's scan measured your suggestions against settings you had turned off."
                ],
                [
                  "",
                  " Every suggestion card promises a number, and the promise is only honest if it was counted through the same filters the button applies. The three scans you start yourself send your safety switches along for exactly that reason. The weekly background scan never did, so it counted everything as though Skip Unread, Skip Starred, Skip Important and Skip Labeled were all on, and then wrote those numbers over the ones your own scan had measured. If you had turned Skip Unread off, a card reading \"Deletes 200 now\" sat above a button that would take every unread message too. The background scan now uses your switches. The sweep itself is unchanged and still runs with every guard on, so it can only ever take less than it counted."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Closing the Gmail tab stopped Auto-Pilot for two hours."
                ],
                [
                  "",
                  " If the tab went away mid-sweep, nothing was left to report that the sweep had ended, so the next weekly run skipped, and the one after that, until the record aged out. The popup meanwhile said a sweep was running right now. Closing the tab now ends the sweep properly, and the popup stops believing in one that died."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Dry runs were counted as cleanups."
                ],
                [
                  "",
                  " A dry run moves nothing, and it was still adding its projections to the lifetime totals on the Stats page. Preview five thousand old promotions to check a rule before you trust it, which is what the feature is for, and the chart claimed five thousand promotions cleaned, permanently. Previews are kept out of the totals now and still appear in the run history with their dry run tag, which is the one place they belong."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The finish screen described work that had not happened."
                ],
                [
                  "",
                  " A dry run that ended while the popup was open said \"Cleanup Complete!\", counted the mail as cleaned, said it had gone to Trash, and offered you the recovery log to undo it. It now says a dry run finished and that nothing was moved, which is what the progress page has said all along. Archive runs had a smaller version of the same problem: the note under the result promised Gmail's 30 day Trash window, and archived mail never goes to Trash. It now says where the mail actually is."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Safe Mode's receipt protection could switch itself off."
                ],
                [
                  "",
                  " Safe Mode keeps receipts, invoices, orders, shipping and refund mail out of a cleanup by excluding those words from the subject. If your own rule already excluded any subject at all, for any reason, the whole protection was skipped while Safe Mode carried on showing as on. Gmail is perfectly happy to apply both exclusions, and the protected keywords feature has relied on that for years. Both apply now."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A Never Delete entry could be rejected and reported as saved."
                ],
                [
                  "",
                  " If a line in the Never Delete list was not in a form the extension can use, a name and address pasted together, or an address with an apostrophe in it, it was dropped before it was stored, and Settings still said \"Settings saved successfully!\". You would leave believing a sender was protected. Settings now tells you which line it could not use."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Buying Pro did not stop the extension asking you to buy Pro."
                ],
                [
                  "",
                  " The strip offering somewhere to paste a key kept appearing for people whose key was already stored and verified, because it was drawn before the check finished. The Storage tab's upgrade pitch had the same problem from the other direction: it could be shown but never hidden again, so it stayed up for the rest of the session after a key was entered. Both are gone the moment a licence verifies."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Settings said Pro unlocked one feature."
                ],
                [
                  "",
                  " That was true when the only paid feature was bulk unsubscribe. Four more have been added since and the sentence never changed, so anyone opening Settings after paying was told they had bought a fifth of what they had bought. Settings now lists all five."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The What's new page flashed an empty jump bar"
                ],
                [
                  "",
                  " before its contents loaded."
                ]
              ]
            }
          ]
        },
        {
          "name": "Improved",
          "items": [
            {
              "text": [
                [
                  "b",
                  "The Storage and Suggestions lists remember what you ticked, minus what already ran."
                ],
                [
                  "",
                  " Both cap one run at 25 senders out of a list that can hold a hundred, and the popup closes when a run starts, so working through a long list means going back and forth. Every trip back used to start from an empty selection with no record of where you had got to. They now come back with your selection intact and the senders that just ran taken off it, so \"run it again for the rest\" reaches the rest instead of the same twenty-five. A dry run keeps the whole selection, because it did not take anything. Nothing about this leaves your browser."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Settings shows what a Pro key unlocks"
                ],
                [
                  "",
                  ", as a list, in one place, so it stays right the next time something is added to it."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.10.0",
      "title": "What the numbers promise, the runs deliver",
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Auto-Pilot swept senders it had never measured that way."
                ],
                [
                  "",
                  " Every suggestion card picks its own action and counts the mail that action would actually move: \"40 large emails\" is counted with the large-file filter applied, and an Unsubscribe card moves no mail at all. The weekly sweep read those counts and then archived six months of everything from the same sender, because the one rule it builds drops the filter the number was measured through. A card promising 40 could quietly archive thousands. The sweep now only takes suggestions its own rule genuinely fits, says on the Clean tab how many it left for you, and leaves the rest to be run by hand where you can see them."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Steps in the Mailbox Report that were never searched looked empty."
                ],
                [
                  "",
                  " When one of the report's searches times out, the report is meant to say \"not measured\" rather than print a confident zero. It has said so in the code since 8.9 and never once on screen: the step was dropped from the list before it could be drawn, so a report missing a whole section read as a mailbox with nothing in it. Unsearched steps now appear, and say what they are. They carry no Run button: there is no figure behind one yet, and this is an extension that does not act on numbers it has not measured. They ask you to scan again instead."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A custom rule could reach your Google Chat history."
                ],
                [
                  "",
                  " The rule checker refuses queries that point at Sent, Drafts, Trash, Spam and anything starred or important, because a bulk delete there is not something Restore can undo. It has been refusing "
                ],
                [
                  "c",
                  "in:chat"
                ],
                [
                  "",
                  " since the check was written, and Gmail's operator is "
                ],
                [
                  "c",
                  "in:chats"
                ],
                [
                  "",
                  ", so the one spelling anybody would type went straight through. Both are refused now. Excluding chat with a leading minus still works."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Archive sweeps announced storage they had not freed."
                ],
                [
                  "",
                  " Archiving moves mail to All Mail, where it still counts against your Google storage. 8.9 took the storage figure off every screen that showed one, and missed the desktop notification, which kept telling anyone who had turned notifications on that an archive run had freed about 0 MB. That is the only report an unattended sweep ever gives you. It now says where the mail went and makes no storage claim."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Changing a setting could make a finished cleanup run again."
                ],
                [
                  "",
                  " A scheduled cleanup writes down when it last ran, and the alarm for the next one is anchored to that. Editing any schedule at the same moment could write an older copy of that record back over it, leaving the cleanup that had just finished looking overdue, so it ran a second time about a minute later with nobody watching. The same race could lose an Auto-Pilot confirmation and put it silently back into preview. Every one of these writes now takes its turn instead of racing."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Protect could quietly stop protecting."
                ],
                [
                  "",
                  " The Protect button on the Stats page accepted twice as many senders as the Settings page keeps. Going past that limit and then opening Settings and pressing Save, without touching the whitelist at all, wrote the shorter list back and unprotected the extra senders. Both pages use one limit now, and a full list says so rather than dropping the oldest entry."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Dry Run counted the same mail more than once."
                ],
                [
                  "",
                  " The preview totals each rule separately, and the rule sets overlap on purpose: mail older than a year is also older than three months. A real run clears the first rule before the second one looks, so it never double counts, but the preview moves nothing and counted every overlap again. The summary said \"conversations\", which made a sum of overlapping rules look like a headcount. It now reports matches across rules and says plainly that mail matching two rules is counted twice."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The per-rule storage column always read zero."
                ],
                [
                  "",
                  " The progress page has a Freed MB column beside each rule, and the run never sent it a figure, so every row of every run showed zero while the total at the end was correct. Each rule now reports its own share, and archive runs and dry runs correctly report none."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.9.1",
      "title": "Store listing wording",
      "sections": [
        {
          "name": "Changed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "The store listing no longer names languages one by one."
                ],
                [
                  "",
                  " The description used to spell out which languages the cleaner can drive Gmail in, twice over, in all seven listing languages. The Chrome Web Store read that list as keyword spam and turned the update down, so the listing now makes the same point without the roll call. The extension itself is unchanged: this release exists to carry the corrected listing."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.9.0",
      "title": "Release notes, a proper goodbye, and honest storage numbers",
      "sections": [
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "A What's new page inside the extension."
                ],
                [
                  "",
                  " The version number in the popup footer is now a button: press it and you get the release notes for this version and the eleven before it, written for people who use the extension rather than people who read the code. There is also a link on the Settings page. A small dot sits on the version after an update until you have read them once. The notes ship inside the package, so opening them makes no network request, same as everything else here."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "An uninstall page."
                ],
                [
                  "",
                  " Removing the extension now opens a short page that covers the four things people actually leave over, and tells anyone who bought Pro that their lifetime key survived the uninstall and where to have it reissued. The address it opens carries no identifier, no version and nothing from your mailbox."
                ]
              ]
            }
          ]
        },
        {
          "name": "Changed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Pro is $9.99 again, down from $19.99."
                ],
                [
                  "",
                  " Existing keys are unaffected: a lifetime licence does not re-price, and nothing about it is checked against a server. Anyone who bought at $19.99 keeps exactly what they paid for. The older checkout links stay open for activation and key recovery, so no past purchase can be stranded by the change."
                ]
              ]
            }
          ]
        },
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Archive runs claimed to have freed storage."
                ],
                [
                  "",
                  " Archiving moves mail to All Mail, where it still belongs to your account and still counts against your Google storage. Every run that archived anything reported megabytes freed anyway, on the progress card, the run receipt, the popup summary, the recap and the lifetime total on the Stats page. Only the one line at the end of the run had it right. Archive runs no longer report a storage figure at all, and old archive runs already in your history stop showing one too."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "On some languages a bulk delete of thousands was recorded as about fifty."
                ],
                [
                  "",
                  " When a rule matches more mail than one page, the extension asks Gmail to select the whole match set, and it proves the click worked by checking that Gmail withdrew the offer. Gmail replaces that offer with a Clear selection control, and in Dutch, Swedish and several other languages that control was mistaken for the offer still being there. The run went ahead and deleted everything, but the receipt, the Stats row, the undo entry and the safety limit that stops runaway runs were all sized against one page. The check now looks at what the control says, not merely whether one is present."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A step the report could not measure looked like an empty one."
                ],
                [
                  "",
                  " If a search timed out while the mailbox report was running, that step was filed as zero, disappeared from the plan and read as \"nothing here\" for a part of your mailbox that was never actually looked at. Those steps now say \"not measured\"."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A cleanup started from the popup could overwrite the scope of a different run."
                ],
                [
                  "",
                  " If a narrow run was already working in that Gmail tab (a storage purge, a suggestion, a report step) and you pressed Run Cleaner, the second run was correctly refused, but it had already recorded itself as the run to resume. Reconnecting from the progress page then restarted the full cleanup instead of the narrow one."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A finished scheduled cleanup could undo edits made while it ran."
                ],
                [
                  "",
                  " Stamping the schedule as done wrote back every schedule as they had been when the run started, so a schedule deleted or edited in the meantime reverted, and another schedule that had just finished could be re-armed and run a second time."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Two unattended runs could both believe they had the mailbox."
                ],
                [
                  "",
                  " A scheduled cleanup and an Auto-Pilot sweep due in the same minute could each claim the run marker, and the one that lost the race carried on as though it had won. Both now check that the claim they wrote is still theirs."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Auto-Pilot could be knocked off course by an unrelated run."
                ],
                [
                  "",
                  " Its scan stage has checked since 8.7 that the run reporting in is the one it started; its apply stage only checked which tab the message came from, so any cleanup finishing in that tab could clear its state."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Applying a suggestion said it was applied before anything had moved."
                ],
                [
                  "",
                  " The confirmation appeared the instant the run was handed to Gmail, then the popup closed on it, so a run that was cancelled or matched nothing still ended on a success message. It now says the run started, which is what every other button here already said."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Settings saved rules the cleaner would refuse."
                ],
                [
                  "",
                  " Typing a rule aimed at starred, sent, trashed or spam mail into one of the intensity boxes showed a warning and then saved anyway under \"Settings saved successfully\", and the next run skipped that intensity without explaining why. Those rules now block the save and say which one is the problem."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Storage purge could apply a stricter age than its own note promised."
                ],
                [
                  "",
                  " The Minimum Age set on the Clean tab also applies to a purge, so with Minimum Age at 1 year and the purge set to 6 months, the note under the sizes named the wrong filter. It now names whichever one the run will really use."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Safe Mode's refusal only arrived after the click."
                ],
                [
                  "",
                  " Safe Mode skips Updates and Forums, and for a free user whose one unlocked report step was one of those, pressing Run did nothing but raise a toast. The row now says so up front."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Restore blamed the wrong thing when it ran out of passes."
                ],
                [
                  "",
                  " A very large restore that reached its page limit reported \"Selection failed\", which sends you looking for a problem that is not there. It now says it hit the limit and that running Restore again continues from where it stopped."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "An age limit written inside Gmail's curly-brace groups was not seen."
                ],
                [
                  "",
                  " A custom rule like "
                ],
                [
                  "c",
                  "{older_than:2y category:promotions}"
                ],
                [
                  "",
                  " did not register as carrying its own age floor, so a redundant one could be added on top."
                ]
              ]
            }
          ]
        }
      ]
    }
  ]
};

if (typeof module !== "undefined" && module.exports) module.exports = GCC_CHANGELOG;
