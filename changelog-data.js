// GENERATED FILE - do not edit by hand.
// Source: CHANGELOG.md. Regenerate with: npm run changelog
//
// The What's new page inside the extension reads this. It is baked in
// at author time rather than fetched, because a fetch of any kind,
// even of a file inside the package, would end the extension's
// no-network-calls promise.
//
// Carries the newest 12 of 63 releases; the page says so
// and links the full log on GitHub.

// eslint-disable-next-line no-unused-vars
var GCC_CHANGELOG = {
  "total": 63,
  "entries": [
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
    },
    {
      "version": "8.2.0",
      "title": "The guards you could not see",
      "intro": [
        "Reported from real use: \"unsubscribe doesn't work, storage doesn't work, it gets randomly stuck a lot\". All of it traced back to guards and state the product never showed you."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Two safety guards had been forced on since v3.x with no control anywhere."
                ],
                [
                  "",
                  " Every run silently added "
                ],
                [
                  "c",
                  "-is:unread"
                ],
                [
                  "",
                  " and "
                ],
                [
                  "c",
                  "-has:userlabels"
                ],
                [
                  "",
                  " to your rules, so on a mailbox where the clutter is unread or labelled, most of it was excluded and the run reported \"nothing matched your rules\". Both are now real switches in the popup, still on by default, and both are actually sent to the engine (the popup never sent them, and a missing value reads as \"on\")."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A scan that timed out reported success."
                ],
                [
                  "",
                  " If Gmail did not answer a search, the scan skipped it and finished with a tidy \"No large mail found\" or an empty sender list. It now says how many searches timed out, and says so plainly when all of them did."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Bulk unsubscribe was opening unread mail and marking it read."
                ],
                [
                  "",
                  " It picked rows by a CSS class the code documented as \"already read\"; in Gmail that class means unread. It now prefers genuinely read rows."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Pro padlock stayed on the tabs after you bought Pro"
                ],
                [
                  "",
                  ", and the Auto-Pilot \"Pro\" badge never went away at all. The padlocks are SVG, and "
                ],
                [
                  "c",
                  "hidden"
                ],
                [
                  "",
                  " is an HTML property that does nothing on an SVG element, so it was never actually applied; the Auto-Pilot badge was static markup no code ever touched. All the Pro markers now disappear once a licence verifies, since they exist to tell free users the tier is there."
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
                  "Maximum, a fourth cleanup intensity above Deep"
                ],
                [
                  "",
                  ", for a mailbox that has never been cleaned. It shortens Deep's age floors, drops the attachment size thresholds, and adds two more ways of naming bulk mail that Gmail never filed into a category: the sender names marketing actually uses, and the \"view in browser\" line that only ever appears in a mass mailing."
                ]
              ],
              "sub": [
                [
                  [
                    "",
                    "It deliberately does "
                  ],
                  [
                    "b",
                    "not"
                  ],
                  [
                    "",
                    " sweep your Inbox wholesale or a bare age range. Both of those reach ordinary correspondence, which the guards narrow but do not protect: a two-year-old reply from a person is not starred, not important, and not unread. Every rule it ships is either size-bounded or age-bounded."
                  ]
                ],
                "Like Deep, it will not start on a single click, and it says which intensity it is asking you to confirm.",
                "Editable on the Options page like the other three, and available to scheduled cleanups."
              ]
            }
          ]
        },
        {
          "name": "Fixed",
          "items": [
            {
              "text": "Saving on the Options page rebuilt the rule map from a hardcoded list of the three intensities that existed at the time, so any intensity added later was silently dropped on the next save, and its editor was never watched for unsaved changes. Both now derive from the real key list."
            }
          ]
        }
      ]
    },
    {
      "version": "8.0.0",
      "title": "Mailbox Report, and a popup that finally explains itself",
      "intro": [
        "The biggest release since Pro shipped. It adds the thing the product was missing, which is an answer to \"what is actually in here\", and it rebuilds the two screens where that answer matters: the popup you open, and the dashboard you watch a run finish on."
      ],
      "sections": [
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Mailbox Report."
                ],
                [
                  "",
                  " One read-only pass counts what is in your mailbox and turns it into a ranked cleanup plan: old promotions, big attachments, forgotten newsletters, social and forum mail, and inbox mail you never archived. Eleven Gmail searches, no message opened, nothing moved. It is now the tab the popup opens on."
                ]
              ],
              "sub": [
                [
                  [
                    "",
                    "The "
                  ],
                  [
                    "b",
                    "whole report is free"
                  ],
                  [
                    "",
                    ", and so is running its biggest step, so you watch the mechanism work on your own mail before deciding anything. Pro unlocks the remaining steps and "
                  ],
                  [
                    "b",
                    "Run the whole plan"
                  ],
                  [
                    "",
                    "."
                  ]
                ],
                "Every step is an ordinary cleanup run. Matches are labelled first, Dry Run is honoured, your whitelist, protected keywords and Minimum Age all apply, and the run lands in the Recovery Log with one-click Restore like any other.",
                [
                  [
                    "",
                    "Storage figures are "
                  ],
                  [
                    "b",
                    "floors"
                  ],
                  [
                    "",
                    ", built from Gmail's own size tiers, so the report says \"at least N MB\". Nothing is compared against Google's 15 GB bar, which is shared with Drive and Photos and which no extension can see."
                  ]
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A run-completion card on the progress dashboard."
                ],
                [
                  "",
                  " Watching a run end used to leave you with a disabled button reading \"Run finished\". You now get the number, the labels that were actually applied, what Trash keeps and for how long, a link straight into the Recovery Log, and a copyable receipt."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A Pro screen inside the popup."
                ],
                [
                  "",
                  " Clicking a locked control used to open a payment form in a new tab, with no explanation, from a developer you have never heard of. It now opens a panel that leads with your own scan numbers, says what the five paid features do, and states the three things people actually want to know: one payment and never a subscription, the key is checked on your device, and every feature added later is included. The buy button does exactly what the old click did."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Two lines under the Run button"
                ],
                [
                  "",
                  " that say, without a click, what the cleaner protects and what it never sends anywhere."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"Bought Pro? Paste your key\""
                ],
                [
                  "",
                  " appears once you have run a cleanup and have no licence, because the post-purchase page told buyers to right-click the toolbar icon and hunt for Options."
                ]
              ]
            }
          ]
        },
        {
          "name": "Changed",
          "items": [
            {
              "text": "The popup got a real type scale and spacing grid, sentence-case buttons, and a gold accent reserved for Pro. Green used to mean both \"your cleanup worked\" and \"pay us\"."
            },
            {
              "text": "Pro is visible before you scan: the tabs that lead to paid features carry a small padlock, and the Pro badge now says whether it is locked or active instead of appearing only after you buy."
            },
            {
              "text": "The popup remembers which tab you were on, and which senders you had ticked on the Unsubscribe tab, so a trip to checkout no longer throws away your triage."
            },
            {
              "text": "Scans show placeholder rows while they run, and each list explains what the scan will produce before you start it."
            },
            {
              "text": "\"Maybe later\" on the rating ask now lasts 90 days instead of forever."
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
                  "The Recovery Log stopped eating itself."
                ],
                [
                  "",
                  " An entry was written once per pass and the log kept only 20, so a first sweep on a large mailbox pushed out its own earliest entries before it finished and always destroyed the previous run's. Passes of the same rule in one run are now a single entry, and the log holds 60 of them."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The large-run confirmation appears on the screen you are looking at."
                ],
                [
                  "",
                  " The 10,000 and 20,000 conversation checks were browser dialogs raised inside the Gmail tab, which every run path had just pushed into the background, and they froze Gmail's page while they waited. They are now asked on the progress dashboard, with stopping as the default, and a run that gets no answer stops rather than proceeding. Declining also stops the whole run now, which is what the button says: it used to end only the current rule and carry on to the next one. Scheduled sweeps are unchanged, they still decline unattended and skip that rule."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A storage purge no longer builds an over-length search."
                ],
                [
                  "",
                  " Picking 25 senders produced a query far past the length this project's own validator allows. Addresses are now packed into as many searches as the limit permits and run as an ordinary multi-rule cleanup."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Rate this extension"
                ],
                [
                  "",
                  " sent Firefox users to the Chrome Web Store, under a button that named it. It now resolves to whichever store the copy was installed from, and it only appears after a run big enough to have earned the ask."
                ]
              ]
            },
            {
              "text": "Removed a \"protect this sender\" suggestion strip that could never appear: it scored senders by opens and replies, and nothing in the extension has ever recorded either."
            },
            {
              "text": [
                [
                  "c",
                  "SECURITY.md"
                ],
                [
                  "",
                  " described the run counter as synced when it has always been device-local, and the README compared Pro against a monthly price when the competitors' annual plans are the honest comparison."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "7.15.0",
      "title": "Safety, locale and scheduling fixes",
      "intro": [
        "A second sweep, in the same spirit as 7.14.2 and reaching the places that one did not: the paths that only run when nobody is watching, and the ones that only misbehave when Gmail is not in English."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Scheduled cleanups now honour your Global Whitelist."
                ],
                [
                  "",
                  " They never did. The list you fill in under \"Never Delete\" was applied to every manual run and to Auto-Pilot, but a scheduled cleanup read a separate, per-schedule list that nothing has ever been able to fill in, so it ran with no whitelist at all. The one kind of run you are not watching was the one that could delete mail from a sender you had protected."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Custom rules now respect their own Action."
                ],
                [
                  "",
                  " A custom rule saved as \"Archive\" or \"Label only\" was stored, shown with its badge, and then executed with the run's action anyway, so a rule you set to label your invoices was deleting them. Archive rules are now used when you run the cleaner in Archive mode, and Label-only rules are never executed by a cleanup run."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The big-run guardrails work in every language."
                ],
                [
                  "",
                  " 7.14.2 made them measure the real match total instead of the page on screen, but it found that total by reading Gmail's English \"1-50 of 3,200\" and its English \"all conversations selected\" banner. On a German, French, Japanese or Korean Gmail both reads failed, so the guardrails were back to sizing a 25,000-conversation sweep at about 50. The counter is now read without relying on any particular language, an all-matching selection is detected structurally, and the guardrails always measure what the click can actually touch."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Bulk deletes complete on a non-English Gmail."
                ],
                [
                  "",
                  " The confirmation dialog Gmail shows for a very large batch was only ever found by English phrases, so on other languages the run waited, timed out and quietly did nothing. It is now found by its buttons, which were already translated."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A whitelist entry like "
                ],
                [
                  "bc",
                  "*@bank.com"
                ],
                [
                  "b",
                  " protects that domain."
                ],
                [
                  "",
                  " The Options page accepts and documents that shape, and Smart Suggestions already treated it as the whole domain, but the cleanup query passed it to Gmail verbatim. Gmail has no wildcard there, so the entry protected nothing."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Rules that target protected mail are refused wherever they come from."
                ],
                [
                  "",
                  " Custom rules were checked; the Light / Normal / Deep boxes were not, and saving one that targeted starred or sent mail raised no objection at all. Both sides now refuse them, and a Gmail "
                ],
                [
                  "c",
                  "{a b}"
                ],
                [
                  "",
                  " group can no longer hide the token from the check."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"Restore defaults\" no longer wipes your safety lists."
                ],
                [
                  "",
                  " It said it would replace your rules. It also silently emptied the Global Whitelist and your Protected Keywords. It now restores rules only."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Auto-Pilot only ever acts on its own scan."
                ],
                [
                  "",
                  " A Smart Suggestions scan you started yourself could hand a pending sweep its \"scan finished\" and set an unattended archive run going. It also now re-checks vacation mode before it acts, so switching that on while the scan is running stops the sweep."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Two overdue schedules no longer fire in the same instant"
                ],
                [
                  "",
                  ", which could start one cleanup running the other schedule's settings, and changing a schedule after a run can no longer make that run repeat a minute later."
                ]
              ]
            },
            {
              "text": "Cancel is now honoured between selecting mail and moving it during a Restore, and between opening an unsubscribe dialog and confirming it."
            },
            {
              "text": "A restore that moves everything matching now reports how much it actually moved instead of the page count."
            },
            {
              "text": "A rule that stops because it hit the per-run pass limit now says so and appears in the run summary instead of vanishing from it."
            },
            {
              "text": "The large-batch warning can fire again; it was comparing a page of at most 100 rows against a threshold of 2,000."
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
                  "Scoped runs keep your Minimum Age."
                ],
                [
                  "",
                  " A Storage X-ray purge or a Smart Suggestion used to drop it for that run. \"Archive all\" carries no age of its own, so with the floor dropped it could act on mail that arrived today. Your floor is now applied whenever it is stricter than the run's own age, exactly as it is for a normal cleanup."
                ]
              ]
            },
            {
              "text": "Editing settings in the popup while a run is in progress no longer rewrites what a reconnect would run, and a run that was refused because another was already going no longer leaves its settings behind."
            },
            {
              "text": "Opening the progress dashboard for a scheduled or Auto-Pilot run now refreshes a leftover tab instead of showing you the previous run's finished screen with Cancel greyed out."
            }
          ]
        },
        {
          "name": "Privacy",
          "items": [
            {
              "text": "The last-run summary is synced so you see it on your other browsers, and it carried the literal Gmail searches that ran. For a Storage X-ray or Smart Suggestions run those searches contain sender addresses read from your mailbox. The searches are now removed before that summary is synced; the counts and labels it displays are unchanged. SECURITY.md has also been corrected: it said no message IDs were stored, when the recovery log keeps a sample of Gmail thread IDs on your device so you can find cleaned mail again."
            }
          ]
        }
      ]
    },
    {
      "version": "7.14.2",
      "title": "Safety and reliability fixes",
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Minimum Age now actually applies."
                ],
                [
                  "",
                  " The setting promises to leave anything newer than your cutoff alone, but it was skipped whenever a rule already mentioned an age of its own, and every built-in rule does. In practice that meant choosing \"older than 1 year\" while running the normal preset still cleaned promotions from three months ago. The cutoff is now applied whenever it is stricter than the rule, and ignored when the rule is already stricter, so it can only ever narrow what a run touches."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The big-run confirmations no longer miss the biggest runs."
                ],
                [
                  "",
                  " When Gmail confirms that every conversation matching a search is selected, it acts on all of them at once. The cleaner was still measuring only the page on screen, so a sweep of tens of thousands sailed past both the 10,000 warning and the large-run confirmation, and was then recorded as a few dozen. Both now use the real match total, and run totals stop under-reporting."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Cancel is honoured right up to the moment mail moves."
                ],
                [
                  "",
                  " Cancelling during tagging, a confirmation prompt or one of the short waits before a batch was actioned used to let that batch go through anyway. A cancelled run now also ends as cancelled rather than reporting itself finished."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Dry Run previews the real number."
                ],
                [
                  "",
                  " On a confirmed \"all N conversations\" selection it quoted the page on screen, so the preview for a 12,000 conversation sweep read as a few dozen."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Custom rules can no longer smuggle starred or sent mail past the guards."
                ],
                [
                  "",
                  " A rule written as "
                ],
                [
                  "c",
                  "(is:starred)"
                ],
                [
                  "",
                  " slipped through the refusal because of the bracket, and the same bracket stopped the automatic \"skip starred\" protection from being added."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Scheduled and unattended runs stop locking the cleaner out."
                ],
                [
                  "",
                  " A few paths could leave a run marker behind after nothing had actually started, and every manual run was then refused for up to two hours. A finishing run could also clear a marker belonging to a newer run."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Archive runs are labelled as archive runs."
                ],
                [
                  "",
                  " The Diagnostics page reported every archive run as a deletion, red tag included."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The progress tab recovers properly."
                ],
                [
                  "",
                  " Reconnecting to a run that had already finished left it retrying in a loop for the life of the tab, and a reconnect during a Storage X-ray purge or a Smart suggestion could restart the previous full cleanup instead of the run you asked for."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Smaller UI fixes."
                ],
                [
                  "",
                  " The Save button on Options no longer ends up permanently reading \"Saving...\", and the Diagnostics \"Test inject\" button no longer sticks disabled after a scan that finds no Gmail tab."
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
