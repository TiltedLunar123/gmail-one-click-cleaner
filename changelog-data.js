// GENERATED FILE - do not edit by hand.
// Source: CHANGELOG.md. Regenerate with: npm run changelog
//
// The What's new page inside the extension reads this. It is baked in
// at author time rather than fetched, because a fetch of any kind,
// even of a file inside the package, would end the extension's
// no-network-calls promise.
//
// Carries the newest 12 of 67 releases; the page says so
// and links the full log on GitHub.

// eslint-disable-next-line no-unused-vars
var GCC_CHANGELOG = {
  "total": 67,
  "entries": [
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
                  " Paste 150 protected senders in, press Save, and the page said \"Settings saved successfully!\", the counter said 150, and 100 were stored. The rest were not protected. Over-long lists are refused now, with a message saying how many to remove, and nothing is written until they are. The same was true of the per-intensity rule boxes at 50 rules each."
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
                  " It cleared the paperwork, and the sweep carried on archiving in the background without recording anything it did."
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
    },
    {
      "version": "8.8.0",
      "title": "Unattended runs work again",
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Scheduled cleanups and Auto-Pilot stopped running on any tab that had already run once."
                ],
                [
                  "",
                  " After a run finished, the old run's messaging hook stayed live in the Gmail tab and answered on behalf of the next one. The extension checks that the run it just started is really the run that answered, got the previous run's name back, decided its own injection had been swallowed, and gave up. The first sweep in a fresh tab worked and every one after it silently did nothing."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Purge selected on the Storage tab could archive instead of delete."
                ],
                [
                  "",
                  " It borrowed the Delete or Archive setting from the Clean tab, so if that had ever been switched to Archive, the purge moved your biggest mail to All Mail. The button said Trash, the summary said megabytes freed, and the senders were marked Purged so a rescan stopped offering them, while the storage that feature exists to reclaim never moved. It now always deletes, whatever the Clean tab says."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A rule that needed more than one pass claimed it had given up."
                ],
                [
                  "",
                  " Any rule with more mail than one pass clears announced \"stopped at the pass limit\" while it was still working, and filed a duplicate entry each time. A rule that cleared 150 messages over three passes was recorded as 300, in the progress table, the run receipt and the category totals on the Stats page."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Applying many suggestions at once could search for fewer senders than you picked."
                ],
                [
                  "",
                  " Twenty-five addresses do not fit in one Gmail search, so the search was cut short while the status line and the run history still claimed all of them. Both the bulk button and Auto-Pilot now split the work into as many searches as it takes."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Rules aimed at Trash or Spam could destroy mail permanently."
                ],
                [
                  "",
                  " Those are the two places where Gmail's delete button means delete forever, so a custom rule pointed at either one skipped the Trash entirely and left nothing for Undo or Restore to find. They are now refused, the same way rules aimed at starred or sent mail already were."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Some whitelisted senders were never actually protected."
                ],
                [
                  "",
                  " An address with a standalone \"and\" or \"or\" in it, like sales.and.marketing@company.com, was dropped from the Global Whitelist without a word, and the next run treated that sender as fair game."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Picking Maximum still ran Normal for some people."
                ],
                [
                  "",
                  " 8.7 fixed this for anyone who had never saved Settings. Anyone who had saved before Maximum existed still got the Normal rules under a progress page announcing Maximum."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Apply checked button always said Trash."
                ],
                [
                  "",
                  " When the suggestions it was about to run were archive suggestions, it archived them, which is what the individual cards said all along. Now the button says so too."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.7.0",
      "title": "Bulk actions do what the card says",
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Apply checked suggestions ignored what each card promised."
                ],
                [
                  "",
                  " Every suggestion leads with one action and states the number that action will reach. The bulk button underneath ran one Delete old mail over all of them, so a card reading \"Archives 200 now\" sent that mail to Trash instead, and a card reading \"Deletes 40 large emails now\" lost its own size filter and took every old message from that sender. Bulk apply now runs the action the cards were measured for. If you check a mix, it runs one group and says to apply again for the rest."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Run the whole plan archived the steps it was selling in megabytes."
                ],
                [
                  "",
                  " A run has one setting for delete or archive, and a plan holding both kinds took the gentler one, so the large-attachment steps were archived. Archiving a 25 MB email frees no storage at all, under a button whose own subtitle said Trash. The plan now runs one kind at a time and the subtitle says which."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Picking Maximum ran Normal."
                ],
                [
                  "",
                  " Unless you had opened Settings and saved at least once, the engine had no Maximum rule list to load and quietly fell back to Normal, while the progress page announced Maximum. The most aggressive preset in the product was not the one running."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Dry Run could quote one page for a run that would clear thousands."
                ],
                [
                  "",
                  " A preview acts on a single page; a real run keeps going until the rule is empty. When Gmail's \"select all conversations that match\" link was not available, the preview reported the page it had selected rather than the size of the match, so a rule Gmail itself described as 3,000 results previewed as 50."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Restore counted a whole-mailbox move as one page"
                ],
                [
                  "",
                  " on any Gmail that is not in English. The mail all came back; the number you were shown did not describe it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The mailbox report treated a search that timed out as a zero."
                ],
                [
                  "",
                  " A step whose search failed was stored as empty, which looks exactly like a step with nothing in it, and a failed headline search printed \"Nothing older than 6 months turned up\" over a mailbox full of it. The report now says how much of it completed."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Scans stopped hiding their own warnings."
                ],
                [
                  "",
                  " The engine has always said when a scan was incomplete; every screen showed the count and dropped the sentence explaining it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The report goes stale when you change a safety switch, and now says so."
                ],
                [
                  "",
                  " Every number in it is measured through the switches as they were set when you scanned. Turning one off afterwards means the buttons would reach more mail than the counts beside them."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Safe Mode silently refused two of the report's own steps."
                ],
                [
                  "",
                  " It skips Updates and Forums, and the report counted them anyway and offered a button that could only end in \"no rules to run\"."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Storage sizes count large mail of any age; the purge defaults to six months."
                ],
                [
                  "",
                  " The rows and the button disagreed by design and nothing said so. It does now."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Protect could quietly protect nothing."
                ],
                [
                  "",
                  " When Gmail gives a display name and no address, that name was saved to your whitelist, where the cleaner cannot match it. The button reported success. It now explains what to do instead."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A sender could aim your unsubscribe at somebody else's mailing list"
                ],
                [
                  "",
                  " by starting its address with a dash, which Gmail reads as \"not this\". Two other places in the code already refused it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Auto-Pilot could be handed a scan you started."
                ],
                [
                  "",
                  " It waited for a scan in a particular tab, and any suggestion scan in that tab would do, including one you ran yourself, which started an unattended sweep you had not asked for. It now waits for its own."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A weekly sweep or scheduled run that never started could lock out every manual run for two hours"
                ],
                [
                  "",
                  " and, for schedules, mark the week as done. Starting the cleaner into a tab that already has one running is ignored by design, and nothing checked whether that had happened."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Auto-Pilot could quietly switch itself off for good."
                ],
                [
                  "",
                  " It read your Pro key from one place and gave up if what it found there did not verify, even when a valid key sat in the other. The rest of the extension has read both since 8.6."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The run history filed an archive run that moved nothing as a deletion"
                ],
                [
                  "",
                  ", in red, permanently."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A failed unsubscribe from a suggestion card jammed the panel."
                ],
                [
                  "",
                  " Scans and unsubscribes afterwards did nothing, silently, under a status line that still said it was working."
                ]
              ]
            }
          ]
        },
        {
          "name": "Changed",
          "items": [
            {
              "text": "The safety line under Run no longer says unread mail is \"never\" touched. It is skipped while the switch is on, and the switch is yours to turn off."
            }
          ]
        }
      ]
    },
    {
      "version": "8.6.0",
      "title": "Suggestions count what they clean",
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "A suggestion could be sold on exactly the mail its own button refused to touch."
                ],
                [
                  "",
                  " A card reading \"402 emails, 100% unread, mostly older than 6 months\" with a Delete old mail button underneath it cleaned nothing, every time, on every mailbox. The count came from a plain search for that sender; the button sent that search plus your safety switches, one of which is Skip Unread. The more unread mail a sender had, the higher it ranked, and the more certain it was that the run would find nothing. Suggestions are now measured through the same switches the button applies, so the number beside a button is the number that button will act on."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Senders your switches hold back entirely are no longer suggested, and no longer disappear without explanation."
                ],
                [
                  "",
                  " The list says how many were held back, which switches did it, and takes you to them."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The suggestion scan never sent your switch settings"
                ],
                [
                  "",
                  ", so it measured everyone against the defaults. If you had turned Skip Unread off, the scan still counted as though it were on."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Checking more than 25 suggestions quietly cleaned only 25."
                ],
                [
                  "",
                  " The status line said it was cleaning all of them and the run history recorded all of them. It now says which it is running, the way the bulk unsubscribe button already did."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Your Pro key survives an update."
                ],
                [
                  "",
                  " It was stored in one place, so one storage hiccup lost something you paid for; it now lives in two and repairs whichever copy goes missing. A stale copy in one can no longer hide a good key in the other. Removing a key clears both, and says so plainly if it could only clear one."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Unpacked builds keep one identity."
                ],
                [
                  "",
                  " Chrome derives an unpacked extension's ID from the folder it was loaded from, and all extension storage is scoped to that ID, so unzipping each release next to the last one made every update a brand new extension with nothing in it. The key was never forgotten; it belonged to a different extension. Builds now pin an ID. Firefox already did."
                ]
              ]
            }
          ]
        },
        {
          "name": "Note",
          "items": [
            {
              "text": "Pinning the ID changes it once, so an unpacked install has to be given its Pro key one more time. After that it stays."
            }
          ]
        }
      ]
    },
    {
      "version": "8.5.1",
      "title": "Unsubscribe actually unsubscribes",
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Bulk unsubscribe skipped senders whose unsubscribe link was plainly on screen"
                ],
                [
                  "",
                  ", and blamed them for it. The engine looked for Gmail's Unsubscribe control exactly once, 300 milliseconds after opening the message, with no retry, while every other control it drives is waited for with a multi-second budget. Gmail renders that link only after it has processed the message's List-Unsubscribe header, which is routinely later than that. So the engine lost a race it did not know it was running, and the row read \"No 1-click option\", which sounds like the sender's fault and is not. It now waits up to six seconds."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"No 1-click option\" and \"Manual step needed\" were describing the sender when they were describing us."
                ],
                [
                  "",
                  " They now read \"No unsubscribe link\" and \"Needs their website\"."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A confirmation Gmail never acknowledged was reported as success."
                ],
                [
                  "",
                  " The code waited for the dialog to close and then ignored the answer, always returning \"Unsubscribed\". A dialog still sitting there means the click did not take, and that is the one failure a user cannot detect for themselves: they cross the sender off and keep getting the mail. It now reports \"Unconfirmed\"."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Finding the control no longer rests on one Gmail class surviving forever."
                ],
                [
                  "",
                  " There is a third fallback for markup carrying neither the class nor the role. It still refuses anything the sender wrote: the message body, list rows, and any real link, because Gmail's control acts in place while a sender's link navigates your tab to them."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The report headline counted mail no run could ever touch."
                ],
                [
                  "",
                  " A bare "
                ],
                [
                  "c",
                  "older_than:6m"
                ],
                [
                  "",
                  " searches all mail, which includes Sent, Drafts and Chats, all three of which the cleaner refuses to act on by design. A mailbox full of sent mail produced a five-figure headline above a plan with no steps in it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"Nothing matched the plan. Your mailbox is already clean.\" printed directly under a headline of 5,120"
                ],
                [
                  "",
                  ", which is not a sentence anyone should have to read. Empty bands and an empty mailbox are different findings, and it now says which one it found."
                ]
              ]
            }
          ]
        },
        {
          "name": "Changed",
          "items": [
            {
              "text": "The popup is 440px wide, up from 380. Four tabs could not hold their own labels at the old width and every list row was fighting for space."
            }
          ]
        }
      ]
    },
    {
      "version": "8.5.0",
      "title": "The number matches the run",
      "sections": [
        {
          "name": "Fixed",
          "intro": [
            "Every count in the Mailbox Report is now measured through exactly the filter its Clean button applies, so the number on screen is the number that button acts on. Sender attribution is measured the same way, and band ranking changes as a result: a band with more mail but less reachable mail no longer outranks one you can actually clear.",
            "The Storage X-ray had the identical bug and got the identical fix."
          ],
          "items": [
            {
              "text": [
                [
                  "b",
                  "A report band said 5,000 and cleaning it removed nothing."
                ],
                [
                  "",
                  " The count and the button were asking Gmail two different questions. The band was counted with its own query, "
                ],
                [
                  "c",
                  "category:updates older_than:1y"
                ],
                [
                  "",
                  ", while the run that followed searched "
                ],
                [
                  "c",
                  "category:updates older_than:1y -is:starred -is:important -is:unread -has:userlabels"
                ],
                [
                  "",
                  ". Updates are notification mail nobody opens, so "
                ],
                [
                  "c",
                  "-is:unread"
                ],
                [
                  "",
                  " removed the entire band and the run cleared zero."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A report that reads honestly can still read as empty"
                ],
                [
                  "",
                  ", so it now says why. The headline is measured twice, once raw and once guarded, and the difference is shown: \"12,431 more old emails are protected by your guards (Skip Unread, Skip Labeled)\", with a button that takes you straight to those switches. That costs one extra search."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The tab bar overflowed the popup."
                ],
                [
                  "",
                  " Four tabs, two of them carrying a padlock, in 380px, and the labels were long: \"Unsubscribe\" barely fit, \"Cancelar inscrição\" and \"Se désabonner\" never did. The labels are short now, and a tab can shrink below its own text instead of pushing the bar wider, so a long translation ellipsises rather than breaking the layout."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.4.0",
      "title": "Sender marks, and a way out of a stuck run",
      "sections": [
        {
          "name": "Added",
          "intro": [
            "The obvious way to build this is a favicon per sender, and that is exactly why it is not built that way. A favicon means one network request per sender, to a third party, handing over the list of who mails you, in an extension whose whole claim is that it makes no requests at all. Every mark here is arithmetic on the address: same sender, same mark, on every machine, offline, forever. The test suite now fails the build if an image or a URL ever appears in that path.",
            "The refusal now arrives with a banner attached, and the banner says which case you are in. If the cleaner answers and says it is genuinely working, the banner says so, offers to show you its progress page, and will not clear anything without a second, explicit click; that click cancels the run and then waits for it to actually stop before clearing, because the flag it is clearing is the only thing keeping a second cleaner off the same mailbox. If nothing answers, one click clears it and you can start again.",
            "One case gets special handling. If the tab flag is set but nothing answers at all, a cleaner is probably still running in there with its connection to the extension severed, which is what reloading or updating the extension mid-run leaves behind. It cannot be told to stop, so Reset reloads the Gmail tab, which does stop it. That is the same tab reload that was the only cure for any of this before 8.4, except now the extension knows when it is needed and does it for you.",
            "Reset never reports success it did not achieve. If the run will not stop, or the Gmail tab is open but refuses to be reached, nothing is cleared at all and it says so, because a cheerful \"you can start again\" backed by nothing is how you end up with two cleaners on one mailbox."
          ],
          "items": [
            {
              "text": [
                [
                  "b",
                  "The Unsubscribe list draws a mark for every sender"
                ],
                [
                  "",
                  ", a coloured square with the sender's initial, so a row is something you can spot instead of a line of text to read. Addresses at one company share a mark: "
                ],
                [
                  "c",
                  "news@substack.com"
                ],
                [
                  "",
                  ", "
                ],
                [
                  "c",
                  "noreply@email.substack.com"
                ],
                [
                  "",
                  " and "
                ],
                [
                  "c",
                  "digest@mg.substack.com"
                ],
                [
                  "",
                  " all draw the same S, so they group visually. The Suggested cards on the Clean tab use the same marks."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"Reset stuck run\""
                ],
                [
                  "",
                  ", in the popup and on the progress page. Two separate flags could say \"a run is happening\", and neither had any way to clear: the stored run claim, which expired after two hours, and a flag inside the Gmail tab, which expired never. When a run died without reporting back, both were stranded and every later run was refused with \"a cleanup is already running\" while pointing at nothing. Reloading the Gmail tab was the only cure, and nothing said so."
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
                  "\"Unsaved changes\" appeared mid-sentence"
                ],
                [
                  "",
                  " in the Options subtitle, several screens above the Save button it was talking about. It now sits beside Save."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.3.0",
      "title": "Real result counts",
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "The Mailbox Report showed 50 against band after band"
                ],
                [
                  "",
                  ", and a run then cleared far less than the plan implied. Gmail renders its \"1-50 of 1,234\" counter in the toolbar, outside the results element, and the code only ever looked inside that element. So the total was never found on a normal result page and every caller fell back to counting the rows on screen: one page, fifty. The counter is now looked for in the results area, then the toolbar, then the page. The same total sizes the large-run guardrails, so those were reading a page instead of a match set too."
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
