// GENERATED FILE - do not edit by hand.
// Source: CHANGELOG.md. Regenerate with: npm run changelog
//
// The What's new page inside the extension reads this. It is baked in
// at author time rather than fetched, because a fetch of any kind,
// even of a file inside the package, would end the extension's
// no-network-calls promise.
//
// Carries the newest 12 of 80 releases; the page says so
// and links the full log on GitHub.

// eslint-disable-next-line no-unused-vars
var GCC_CHANGELOG = {
  "total": 80,
  "entries": [
    {
      "version": "8.24.0",
      "title": "Fifty is not a total",
      "intro": [
        "Gmail sorts most searches by relevance now, and when it does that it stops saying how many conversations matched. The pager reads \"1-50 of many\". The cleaner fell back to counting the rows it could see, which is fifty, and printed that as the answer.",
        "So the Mailbox Report, the screen the store listing tells you to run first, showed 50 beside a step holding thousands. Two mailboxes with wildly different amounts of old mail in them got the same report."
      ],
      "sections": [
        {
          "name": "Fixed",
          "intro": [
            "None of these numbers moved. The report counts what it always counted; it now tells you when what it counted was a page rather than a total."
          ],
          "items": [
            {
              "text": [
                [
                  "b",
                  "A count Gmail will not total is shown as a floor."
                ],
                [
                  "",
                  " A step reading 50+ holds at least fifty and probably far more. Nothing is guessed and no number went up: the plus sign is there because the cleaner can see one page and will not pretend otherwise. Hover it and it says so."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The headline says \"at least\" when it means at least"
                ],
                [
                  "",
                  ", instead of quoting one page of your mailbox as the size of it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Pro line stopped understating what Pro clears."
                ],
                [
                  "",
                  " It names one step's count, and that count was the same fifty."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Suggestions stopped calling every sender 100% unread."
                ],
                [
                  "",
                  " A suggestion works out how much of a sender's mail you never open by dividing one search by another, and both searches were coming back as one page, so any sender past fifty messages looked untouched. Unsubscribing cannot be undone, so it is no longer suggested off a figure the cleaner could not measure. Deleting old mail and archiving still are, and Gmail keeps both somewhere you can get them back from."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Bulk delete works on Traditional Chinese Gmail."
                ],
                [
                  "",
                  " Rather than clearing fifty at a time, the cleaner takes Gmail's offer to select every match, and it finds that offer by name. It knew the Simplified spelling of \"select all\" and not the Traditional one, so on a zh-TW or zh-HK mailbox it never found the offer and crawled the results a page at a time."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Selecting everything now finds the list on screen."
                ],
                [
                  "",
                  " Gmail leaves the previous search results sitting in the page where you cannot see them. When the cleaner's usual way of ticking rows does not work and it falls back to Gmail's own select-all checkbox, it was finding the leftover list's checkbox first, selecting nothing you could see, and then reporting that Gmail's layout had changed."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.23.0",
      "title": "It says what it is doing",
      "intro": [
        "The Mailbox Report, the Storage X-ray scan, the subscription scan, the suggestion scan and bulk unsubscribe all work inside your Gmail tab, and the popup closes the moment you click anything outside it. So the natural thing to do, click into Gmail to watch, took away the only thing telling you a scan was running. Reopening the popup showed a window with nothing happening in it while your mailbox was visibly being searched."
      ],
      "sections": [
        {
          "name": "Fixed",
          "intro": [
            "The progress dashboard is deliberately not offered for these runs. It is built for cleanups, and the recovery button on it re-injects the last cleanup settings, which is not a thing that should ever be one click away from a read-only scan."
          ],
          "items": [
            {
              "text": [
                [
                  "b",
                  "The popup now says a scan is still going."
                ],
                [
                  "",
                  " It asks your Gmail tabs directly rather than looking for a marker, because these runs deliberately never book your mailbox the way a cleanup does. The banner names what is running, so a scan that is only reading is not confused with an unsubscribe that is changing things, and it says the part that matters: you can close the popup, the run keeps going, and the result will be waiting when it finishes."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The banner clears itself when the run ends"
                ],
                [
                  "",
                  ", instead of sitting there claiming to be reading a mailbox it already finished reading."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Reset now aims at the run that is actually going"
                ],
                [
                  "",
                  ", in whichever Gmail tab it is in. With more than one account open the button had nothing to aim at, so there was no way to stop a scan short of reloading the tab."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.22.0",
      "title": "It counts the list it is looking at",
      "intro": [
        "Gmail changed how it draws search results, and it stopped clearing the previous list away. The list you were looking at before the search stays in the page, invisible, with its own counter still attached to it. The cleaner was reading that counter."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "The Mailbox Report was counting your Inbox instead of the mail it was reporting on."
                ],
                [
                  "",
                  " When Gmail declines to say how many conversations a search found, and on the current Gmail it usually declines, the cleaner looks further down the page for a number. What it found was the leftover counter belonging to the list that had been on screen a moment earlier. Checked against a real mailbox: five of the six report steps came back with the same figure, the size of the Inbox, and two of those five had no matching mail at all. A report like that is worse than no report, and it is the first thing most people run. Every count now comes from the search it belongs to, or it is reported as unknown."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The \"this will delete about N conversations\" warning works again."
                ],
                [
                  "",
                  " That warning is there for the case where Gmail will not state a total. A number borrowed from another list looked like a perfectly good total, so the warning had nothing left to fire on."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A subject line still cannot be mistaken for the results counter."
                ],
                [
                  "",
                  " 8.21 stopped the cleaner taking a number out of the message list. That protection was written around one list, and the page holds two now, so it was guarding the wrong one. It covers both lists and the container around them."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Selecting row by row no longer ticks the wrong list."
                ],
                [
                  "",
                  " When the select-all checkbox does not take, the cleaner falls back to ticking each row itself. It was ticking rows in the leftover invisible list, so nothing on screen ended up selected, which the cleaner reads as \"Gmail has changed underneath me\" and stops. The fallback that exists to rescue a run was making sure it failed."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.21.0",
      "title": "It reads the mailbox, not the mail",
      "intro": [
        "Fourteen fixes. The one that matters most: on a Japanese, Korean, Chinese, Russian, Arabic, Swedish, Danish, Norwegian, Polish, Turkish, Dutch, Italian, Spanish or Portuguese Gmail, the cleaner could not use Gmail's \"select all conversations that match\" offer at all, so big cleanups crawled fifty at a time and gave up with most of the mail still there. That is fixed for every language the cleaner speaks.",
        "The rest are mostly the same shape twice over: a number read out of your mail instead of out of Gmail's own toolbar, and a guard that had been added in one place and not in the identical place next to it."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Bulk cleanup works in every language now."
                ],
                [
                  "",
                  " When a rule matches thousands of conversations, Gmail offers to select all of them at once, and taking that offer is what turns an hour of paging into one action. The cleaner only recognised that offer in English, German and French. Everywhere else it never saw it, so it deleted a page at a time until it hit its own pass limit and stopped, leaving most of the mail behind. It now recognises the offer in all seventeen languages it drives Gmail in. Spanish and Portuguese were doubly affected: the wording it looked for did not allow for Gmail naming the number in the middle of the sentence, which it always does."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A subject line can no longer be mistaken for the results counter."
                ],
                [
                  "",
                  " When Gmail will not say how many conversations a search found, the cleaner reads what it can off the page. It was willing to take that number from an email in the list, so a promotional subject like \"Sale 10-20% off: 5000 items left\" could be read as the size of the job. That number is what the \"this will delete about N conversations\" warning is based on, so a wrong one meant no warning at all. It only reads Gmail's own counter now, and it will not read one out of a message."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Nor for a selection count."
                ],
                [
                  "",
                  " The same shape, one step over: a subject like \"You have been selected for 3 free rewards\" was read as \"3 conversations are selected\". That mattered because a count of zero is how the cleaner notices Gmail has changed its layout and stops with a clear explanation. With a number invented from a subject line it carried on instead, clicking Delete on an empty selection and retrying every rule until it ran out of attempts."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Escape in the log filter no longer cancels the cleanup."
                ],
                [
                  "",
                  " The progress page has a \"Filter logs\" box. Typing in it and pressing Escape to clear it, which is what Escape does in every search box, stopped the run instead. Escape still closes a dialog and still cancels from anywhere else on the page."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A scheduled cleanup will not pick up your Chat window."
                ],
                [
                  "",
                  " Gmail serves Chat from the same address as your mail. An unattended cleanup chose whichever of those tabs you were looking at, so if you were chatting when the timer fired, it took that tab, navigated it away from your conversation mid-sentence, and then could not finish. The run was recorded as done, that week's cleanup never happened, and for the next two hours every manual run was refused with \"a cleanup is already running\". Only real mailbox tabs are used now, and the account picker no longer offers a Chat window either."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A preview says what it found."
                ],
                [
                  "",
                  " The desktop notification after a dry run was headlined \"0 emails moved to Trash\", because a preview does not move anything. Auto-Pilot's first sweep is a preview by design, so this was the first thing it ever said to a new Pro user. It reports what the preview found."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A cleanup that skipped some rules says so, even when it cleared others."
                ],
                [
                  "",
                  " An unattended run skips a rule too large to run without asking, which is right. If it cleared nothing at all it said so, but if it cleared some it just reported the total, and rules holding tens of thousands of messages went unmentioned. The notification is the only thing an unattended run can tell you, so it now says both."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Storage caveat is shown before you pay, not after."
                ],
                [
                  "",
                  " The storage scan measures large mail of any age. The purge only takes mail older than six months, and the sentence explaining that difference was only shown to people who had already bought Pro. Everyone else saw the big reclaimable figure, the sender list, and the Purge button with nothing to say the two numbers are not the same number."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Auto-Pilot pitch counts what Auto-Pilot can actually do."
                ],
                [
                  "",
                  " It led with the number of suggestions on screen and offered to sweep \"them\" every week. It only ever sweeps the delete and archive suggestions, so nine on screen could mean two swept. It now counts the ones it will take."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A suggestion stops promising a count once you change your safety switches."
                ],
                [
                  "",
                  " \"Deletes 40 now\" was measured when you ran the scan. Turn off Skip Unread afterwards and the button would reach far more than 40. The suggestions now notice, say your switches have changed, and stop quoting a figure until you scan again, exactly as the Mailbox Report already did."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The \"held back by your guards\" note no longer exaggerates."
                ],
                [
                  "",
                  " It counted every message a sender had ever sent, when what the guards actually held back was the smaller set the suggested action would have touched."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"Rate 5 stars\" opens one store, and the right one."
                ],
                [
                  "",
                  " On Firefox it opened two tabs, one of them the Chrome Web Store."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Six more things are readable in the light theme."
                ],
                [
                  "",
                  " The \"Show guards\" button on the Report tab was invisible. So was the confirmation on \"Force reset\", the name of a second mailbox when you have two Gmail tabs open, a step blocked by Safe Mode, a step you have already cleared, and every scheduled cleanup row on the Options page, including whether it is switched on. All of these only appear in situations a quick look at the extension never reaches, which is why they lasted this long."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A notification setting that fails to save says so"
                ],
                [
                  "",
                  " instead of looking as though it saved."
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
                  "",
                  "Norwegian mailboxes get Norwegian search terms whether Gmail reports the language as "
                ],
                [
                  "c",
                  "nb"
                ],
                [
                  "",
                  ", "
                ],
                [
                  "c",
                  "nn"
                ],
                [
                  "",
                  " or "
                ],
                [
                  "c",
                  "no"
                ],
                [
                  "",
                  "."
                ]
              ]
            },
            {
              "text": "The privacy policy now describes the page your browser opens when you uninstall. Nothing about that page changed: it carries no information about you or your mail, and it has been described in the security notes since 8.9. It should have been in the policy too."
            },
            {
              "text": "The popup no longer allows a font server it never used in its content security policy."
            },
            {
              "text": "The Duration shown after a run is how long the run took. It used to be how long the progress page had been open, so opening it late, or reloading it, gave a smaller number."
            },
            {
              "text": "The Stats page stops replaying its opening animation every thirty seconds. The charts were collapsing and regrowing, and the totals were counting up from zero again, twice a minute."
            }
          ]
        }
      ]
    },
    {
      "version": "8.20.0",
      "title": "Skip means skip, and done means done",
      "intro": [
        "Eight fixes. Most are the same complaint wearing different clothes: a button, a message or a report told you something had happened when it had not."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "\"Skip This Rule\" skips, even from the keyboard."
                ],
                [
                  "",
                  " In Review Mode the cleaner stops before a batch and offers you Proceed or Skip. Tab to Skip, press Enter, and the batch got cleaned anyway. A keyboard shortcut on the page was answering Enter before the button could, and it always answered Proceed. The buttons speak for themselves now. Pressing Enter without moving focus still proceeds, which is what the shortcut was there for."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A run that refused a rule no longer calls itself finished."
                ],
                [
                  "",
                  " A scheduled cleanup will not stop and ask you about a very large batch, because there is nobody there to answer. It skips that rule and moves on, which is right. What was wrong is that the run then reported itself complete. Auto-Pilot printed a partial tally as the week's work with nothing to say it had skipped anything, and the senders it never got to were booked as dealt with, so they stopped being suggested. A refused rule leaves mail behind, and the run says so now."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "An Auto-Pilot sweep that stops or fails gets recorded."
                ],
                [
                  "",
                  " Until now it simply vanished. The panel went on quoting last week's number as though it were the latest one, and the weekly timer lost its place and could fire again a minute later. The sweep is recorded either way now, and one that stopped early says so."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Unsubscribes are saved as they happen."
                ],
                [
                  "",
                  " They used to be held until the run ended. Close the Gmail tab halfway through and you lost every one of them: no marks on your list, nothing in your totals, no way to tell which senders you had already done. The most a closed tab can cost you now is the one in progress."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A sender you have already cleaned stops pushing itself to the top."
                ],
                [
                  "",
                  " Cleaning a sender gives a small nudge to others at the same domain, which is the point. It was also nudging that sender, for ever, above senders nobody had touched. So the same handful sat at the top of your suggestions and at the front of every weekly sweep."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"Schedule removed\" and \"Log cleared\" only appear when they are true."
                ],
                [
                  "",
                  " Both were shown whatever happened. A schedule that failed to delete stayed where it was with its timer still running, and a recovery log that failed to clear kept every entry. Both say plainly now when the change did not go through."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The cleaner tells you when it cannot read your saved rules."
                ],
                [
                  "",
                  " If Chrome will not hand over your stored settings, the run falls back to the built-in rules for that level. That is the sensible thing to do, and it used to do it in silence. It says so now, for your rules and for your custom rules separately."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Two more places are readable in the light theme."
                ],
                [
                  "",
                  " The \"Restore Default Rules?\" confirmation had a fixed dark panel behind theme-coloured text, so Cancel was invisible and the only readable choice was the destructive one. The tooltips on the Diagnostics page had the same problem (they only appear on hover, which is how both went unnoticed for so long). Both follow the theme now. They shift a little in the dark theme too, because they use the shared surface colours instead of their own."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.19.0",
      "title": "Things that happened while nobody was watching",
      "intro": [
        "Four fixes, and three of them are the same problem: the extension worked out something true and then wrote it down somewhere that stops existing the moment you look away."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Your three free unsubscribes are counted properly now."
                ],
                [
                  "",
                  " They used to be counted by the popup, and a popup closes the instant you click anything else. An unsubscribe run opens one message per sender, so most runs finished with the popup already gone and the count never moved. If you clicked into Gmail to watch it work, you kept getting three. The count is kept by the background worker now, which is still there when the run ends. Nothing else changed: only senders that really came back unsubscribed cost anything, and a sender with no one-click link is still free."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Stopping an unsubscribe run no longer throws away what it already did."
                ],
                [
                  "",
                  " Cancel at the eighth of ten senders and the seven that were genuinely unsubscribed went unrecorded: no marks on the list, nothing in your totals. You cannot un-unsubscribe from a mailing list, so those are worth keeping, and they are kept now. They do count against the free three, because they happened."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A rule that Gmail throttled for too long is reported as unfinished."
                ],
                [
                  "",
                  " The cleaner gives up on a rule after five minutes of rate limiting and moves to the next one, which is the right call, but the run then reported itself as complete. That let the Mailbox Report mark the step Cleared and take away its Run button, the Storage X-ray mark a sender Purged, and a suggestion stop being suggested, all over mail that was still there. Two of the three ways a rule can stop early already said so. The third does now."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Small text on coloured chips is readable in the light theme."
                ],
                [
                  "",
                  " A chip tints its own background, so its label was landing on a ground its own colour had already darkened. Every tag, the PRO badge on an active licence, the Cleared mark on a report step and the Apply button on a suggestion were below the readable-contrast bar. They are all above it now, in both themes, and the dark theme looks exactly as it did."
                ]
              ]
            }
          ]
        },
        {
          "name": "Internal",
          "items": [
            {
              "text": "The check that keeps Trash, Spam and starred mail out of a bulk delete had a broken escape in it. Nothing was getting through, because none of the terms it guards needs escaping, but the first one that did would have slipped past in silence."
            }
          ]
        }
      ]
    },
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
    }
  ]
};

if (typeof module !== "undefined" && module.exports) module.exports = GCC_CHANGELOG;
