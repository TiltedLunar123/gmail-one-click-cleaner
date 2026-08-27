// GENERATED FILE - do not edit by hand.
// Source: CHANGELOG.md. Regenerate with: npm run changelog
//
// The What's new page inside the extension reads this. It is baked in
// at author time rather than fetched, because a fetch of any kind,
// even of a file inside the package, would end the extension's
// no-network-calls promise.
//
// Carries the newest 12 of 83 releases; the page says so
// and links the full log on GitHub.

// eslint-disable-next-line no-unused-vars
var GCC_CHANGELOG = {
  "total": 83,
  "entries": [
    {
      "version": "9.0.0",
      "title": "Count what the button clears",
      "intro": [
        "The last release taught this extension to find the senders that actually fill a mailbox. It then printed the wrong number beside them. A sender would be listed with five emails, you would tick it, press Clear, and get nothing back.",
        "The count came from a plain search for that sender. The button ran a narrower one: mail older than six months, skipping anything starred, important, unread, or filed under a label of your own. On a newsletter sender, unread alone is most of it. Both numbers were true. They were answers to different questions, and only one of them was the question you were asking.",
        "Every count in this extension is now measured through the same filter as the button sitting next to it. That has been the rule here for a long time and the two features added last release were never held to it."
      ],
      "sections": [
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Every census row says what clearing it would take."
                ],
                [
                  "",
                  " The count still answers who fills your mailbox, because that is what the list is for. Underneath it now sits the other number: what the Clear button would actually remove from that sender today. When those two differ, the row says so, and when clearing would take nothing, the row says that too instead of letting you find out by pressing it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Senders who kept mailing you from the Spam folder."
                ],
                [
                  "",
                  " A Gmail search does not look in Spam, so a sender who ignored your unsubscribe but landed in the spam filter answered the check with a flat zero and the receipt read \"Stopped\". They had not stopped. There is a third answer now, and it is the one no other tool will give you, because it means saying the unsubscribe failed quietly. Nothing is deleted for this one: the extension will not point a delete at the Spam folder, where Gmail's own control means gone for good."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Senders who stopped and started again."
                ],
                [
                  "",
                  " A list that goes quiet for a month and then comes back is the one you will never think to check, because you watched it stop. It used to be recorded as though it had never stopped at all. It gets its own line now."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The census total, on screen."
                ],
                [
                  "",
                  " It was measured, it was saved, and nothing ever drew it."
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
                  "Clearing a census sender does what the row promised."
                ],
                [
                  "",
                  " The count and the button ask Gmail the same question now. This is the bug above, and it is the reason for the version number."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Your Never Delete list applies to the census."
                ],
                [
                  "",
                  " Neither of last release's two scans passed your whitelist or your protected keywords to the engine, so a sender you had explicitly protected was still ranked, still measured, and still offered with a tick box. Pro's deeper scan setting could not be reached from those screens either."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Storage X-ray stops rounding small senders down to nothing."
                ],
                [
                  "",
                  " The smaller size bands added last release credit about a tenth of a megabyte per message, and sizes were rounded to whole megabytes, so a real sender holding real mail was listed as \"at least 0 MB\". It keeps a tenth now, and rounds down rather than up, because the page says at least."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A Google Chat tab is no longer mistaken for your mailbox."
                ],
                [
                  "",
                  " Chat lives on the same address as Gmail. With it open in front, Run and every scan quietly resolved to it, did nothing, and left a progress screen waiting on a run that never began."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Buying Pro no longer leaves the census and the receipts locked."
                ],
                [
                  "",
                  " Whichever finished first decided what you saw, so a licence that verified a moment late left a paying user looking at the free version of both until they reopened the popup."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Scheduled sweeps use the senders you ticked."
                ],
                [
                  "",
                  " They were described as extra rules on your ordinary runs, and the weekly unattended run, which is the one that matters most, was the only one not carrying them."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A check that could not reach Gmail is retried, not shelved."
                ],
                [
                  "",
                  " If the very first check of a sender failed to get an answer, that sender was set aside for a month, while one that had already been answered was retried on the next sweep. Exactly backwards."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The clear button on the receipts counts what it clears."
                ],
                [
                  "",
                  " It said how many senders had ignored you and then acted on the first twenty-five, without mentioning the rest."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.26.0",
      "title": "Find the bulk, not the buckets",
      "intro": [
        "Every scan in this extension used to describe your mailbox with a Gmail search written before your mailbox existed: promotions, big attachments, mail with the word unsubscribe in it, anything over a year old. Those find mail that fits a bucket. Most mailboxes are not buckets. They are tens of thousands of ordinary small messages from a few dozen senders, and no search on that list names them, so every tool reported a small number and did a small thing.",
        "Tested against a real mailbox while this was built: promotions older than six months returned nothing. Mail older than two years returned nothing. Two broad searches found sixty senders."
      ],
      "sections": [
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "A census of who actually fills your mailbox."
                ],
                [
                  "",
                  " It samples widely first, sliced by age and by whether you ever opened the mail rather than by category, then counts each of the senders that keep coming up with its own Gmail search. So the number beside a name is Gmail's answer about that sender, not a guess from one page of results. The list is free. Clearing the senders you tick is Pro."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Unsubscribe receipts, and a check that they were honoured."
                ],
                [
                  "",
                  " Gmail now has its own unsubscribe button, and like every unsubscribe tool ever made it sends the request and greys out the row. Nobody goes back to find out whether the sender stopped. Plenty of them do not. Each unsubscribe you run here is now dated, and once a sender has had two weeks to act on it, Pro checks whether anything new arrived. The ones that ignored you get a button that deletes only what they sent after their window closed."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The senders you tick keep getting cleaned."
                ],
                [
                  "",
                  " A ticked census sender becomes an extra rule on your ordinary runs, so a weekly sweep keeps clearing the senders your mailbox is actually full of. Only senders you ticked, never the whole census."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Ask for a feature from the Options page."
                ],
                [
                  "",
                  " It opens a pre-filled email in your own mail app. Nothing is sent by the extension, which still makes no network requests of any kind."
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
                  "The Storage X-ray looks below 5 megabytes now."
                ],
                [
                  "",
                  " It only ever searched for mail over 5 MB, which finds a few video attachments and misses everything a mailbox is made of. On the account this was tested against: 8 messages over 5 MB, 36 over 1 MB, and more than Gmail would count over 100 KB. Two smaller size bands were added, and the purge button underneath moved with them, so the button still clears exactly the mail the list counted."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A size written in bytes is read as bytes."
                ],
                [
                  "",
                  " Gmail's own help writes sizes as plain numbers of bytes. A custom rule written that way had its storage estimate read as megabytes instead, so one rule could inflate the freed figure at the end of a run by millions."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "8.25.0",
      "title": "Say it when it is a floor",
      "intro": [
        "8.24 taught the Mailbox Report to admit when Gmail had given it a page instead of a total. Three other screens were still stating the same kind of number flatly, and one of them is Dry Run, which exists to be believed before you delete anything."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Dry Run says \"at least\" when it means at least."
                ],
                [
                  "",
                  " A preview reads Gmail's own count, and on a relevance-ranked search Gmail does not give one, so the preview was quoting the fifty rows on screen as the size of a rule holding thousands. The number has not moved. The preview now tells you when the number is a floor, on the popup, on the progress dashboard and in the sentence at the end of the run."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The report stopped inventing a figure for the mail your guards hold back."
                ],
                [
                  "",
                  " That line is one search minus another. Either search can come back without a total, and then the subtraction is wrong in whichever direction the missing number fell. It could claim eleven thousand protected emails from a page of fifty. It could also claim none at all on a mailbox holding thousands back. It now says nothing rather than guessing."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The plus sign is explained in words."
                ],
                [
                  "",
                  " A step reading 50+ said what it meant only if you hovered it, which is no help on a phone or from a keyboard. The note under the report spells it out whenever there is one on screen."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Storage X-ray counts what it saw."
                ],
                [
                  "",
                  " The megabytes have always been marked as a floor and the email count beside them was not, even though both come from the same sample."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Long runs slow down properly on Traditional Chinese Gmail."
                ],
                [
                  "",
                  " When Gmail asks for a pause it says so in words, and the cleaner knew two of the three Simplified phrasings and only one of the Traditional ones."
                ]
              ]
            }
          ]
        },
        {
          "name": "Safety",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Rows are only ever read from the list you can see."
                ],
                [
                  "",
                  " Gmail leaves the previous search results in the page after a new search. A handful of lookups could still reach that leftover list while Gmail was redrawing. They are the lookups that tick the checkboxes a delete acts on, name the senders in your recovery log, and pick the message an unsubscribe is driven from. Unsubscribing cannot be undone. None of them will read anything but the live list now."
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
                  "Small text is readable where it sits."
                ],
                [
                  "",
                  " The quiet grey used for hints and secondary links was measured against the plain card. Most of the controls wearing it paint a slightly lighter chip under themselves first, and against that it fell under the readability bar. Six places were writing in a colour picked for a different background: the keyboard hint on the Save button, the Save button itself in light mode, the diagnostics buttons, the Pro line on the Rules page and the privacy link on the Clean tab."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Storage figures drop the pointless decimal."
                ],
                [
                  "",
                  " The X-ray rounds every sender to a whole megabyte, so \"900.0 MB\" was one digit of precision the scan never had. A real tenth still shows."
                ]
              ]
            }
          ]
        }
      ]
    },
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
    }
  ]
};

if (typeof module !== "undefined" && module.exports) module.exports = GCC_CHANGELOG;
