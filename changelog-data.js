// GENERATED FILE - do not edit by hand.
// Source: CHANGELOG.md. Regenerate with: npm run changelog
//
// The What's new page inside the extension reads this. It is baked in
// at author time rather than fetched, because a fetch of any kind,
// even of a file inside the package, would end the extension's
// no-network-calls promise.
//
// Carries the newest 12 of 89 releases; the page says so
// and links the full log on GitHub.

// eslint-disable-next-line no-unused-vars
var GCC_CHANGELOG = {
  "total": 89,
  "entries": [
    {
      "version": "9.6.0",
      "title": "Erase means erase",
      "intro": [
        "The Options page has a button reading Erase Stored Sender Data, under a heading reading Stored Sender Data. It cleared six things. Eight more stores held the addresses of people who email you, and nothing in the extension removed any of them.",
        "They were not hidden. The Diagnostics page said, in as many words, that the mailbox report and the subscription, storage and suggestion scans \"keep their own sender lists, which this card does not count and the Erase button does not clear\", and the confirmation dialog said the same thing at greater length. That is a control whose own copy explains why it does not do what its label says. It is the same shape as the word \"Freed\" in 9.5, in a smaller room, and it has the same answer: make the control do the thing, then delete the paragraph that existed to excuse it.",
        "Two other numbers turned out to be measured through the wrong filter, which is this project's oldest habit, and the guidance panel 9.5 shipped inside Gmail was going to the wrong tab."
      ],
      "sections": [
        {
          "name": "Changed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Erase Stored Sender Data now erases all of it."
                ],
                [
                  "",
                  " The sender census, your unsubscribe receipts, the four ticked-sender lists, the mailbox report, the storage X-ray, the suggestion scan, the subscription scan, the record of which suggestions you approved or dismissed, and the three markers naming senders a run was part way through acting on. One write, as before. The price is stated up front rather than discovered: the four scans go back to asking for a scan, so the report the popup opens on comes back empty until you run one."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Your recovery log is not touched, and the dialog says so."
                ],
                [
                  "",
                  " It is what restores mail from Trash. An erase that quietly gave up the last 30 days of recoverable cleanups would be a worse surprise than anything it removed. It still has its own Clear button on the Stats page."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Diagnostics card counts the scans instead of explaining that it cannot."
                ],
                [
                  "",
                  " A new row, still counts only, still no address on the page and none in Copy Diagnostics. Its chip can now say \"these are empty\" and mean it."
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
                  "\"Waiting in Trash\" was not a floor."
                ],
                [
                  "",
                  " Every surface labels that figure \"at least\" and it was rounded once per pass before being added up, so a run of small passes could only grow. Forty passes clearing three leftovers apiece reported 8 MB against a real 6, and a run whose passes cleared one message each reported double. The same run's own moved-to-Trash total is worked out without rounding, so one run printed two figures that could not agree. Rounded once now, where it is displayed."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The note inside Gmail went to the wrong tab."
                ],
                [
                  "",
                  " Opening Trash from the popup, the progress page or Stats leaves a one-shot mark for the panel that explains Gmail's Empty Trash link. The mark named the mailbox, and a mailbox does not tell two tabs apart, so with a second Gmail open on the same account the panel could be claimed by the tab that had not gone anywhere, and the tab actually sitting in Trash was told there was nothing for it. 9.5 guarded two signed-in accounts and missed the commoner case."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Delete button the engine looks for could be one a sender wrote."
                ],
                [
                  "",
                  " The search is normally scoped to Gmail's toolbar and reaches no message body. With the toolbar missing, which is the layout change the engine already stops for, it fell back to the whole page, and a control reading Delete is markup anyone can put in an email. The three filters the Restore finders have run since 7.6 now run on the delete, archive, label and overflow finders too, out of one shared list rather than two that had drifted. Links are refused outright: Gmail's toolbar controls are not links, and following one mid-run is how a run gets abandoned."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Stats page said the 9.5 Trash sentence in English."
                ],
                [
                  "",
                  " All seven translations of it already existed; the page was building the sentence itself instead of asking for one. It also had a second wording of the same fact, which is how one figure starts reading as two."
                ]
              ]
            }
          ]
        },
        {
          "name": "Internal",
          "items": [
            {
              "text": "The erase list is one list. The keys and their cleared values were two literals that had to agree, which was a reading hazard at six entries and a bug waiting at fourteen."
            },
            {
              "text": "The per-pass size and the toolbar candidate walk are named functions the tests drive, rather than expressions a test can only read. An assertion on the source of an expression says nothing about what the run does with it, which 9.1 learned the hard way."
            },
            {
              "text": "Five suites, 66 assertions, every one of them proved to fail on 9.5.0 before the fix that answers it."
            }
          ]
        }
      ]
    },
    {
      "version": "9.5.0",
      "title": "Say where the space went",
      "intro": [
        "This extension is sold on freeing up Gmail storage, and every delete run moves mail to Trash rather than destroying it, which is deliberate: it is what the labelling, the 30-day window and the Restore button are all built on. Google counts Trash against your storage limit until it empties. So the bar this thing exists to move does not move for up to 30 days after a run, and four places said \"Freed\" about that moment: the popup result card, the progress done card, the Stats tile, and the notification, which is the only surface a scheduled sweep ever reaches.",
        "Five notes elsewhere did say storage frees up once Trash empties. None of them said how much was sitting in there, or how to get to it, and the uninstall page already lists \"something went to Trash\" among the reasons people leave.",
        "The rule this release settles: no surface may call storage freed while the mail is still inside Gmail's window unless the same surface shows the part that is still waiting and where it is. The waiting figure is measured through the recovery log's own eligibility rules, the ones the Restore button obeys, so what this says is in Trash is exactly what Restore will still bring back."
      ],
      "sections": [
        {
          "name": "Changed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "A finished delete run says what it did."
                ],
                [
                  "",
                  " \"At least ~310 MB moved to Trash\", on the result card, the progress card and the notification, in place of a figure called Freed. Archive runs are untouched: they have shown no storage figure since 8.9, because archived mail stays in the account. Dry runs are untouched too."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Stats tile is labelled Moved to Trash."
                ],
                [
                  "",
                  " The lifetime total was never wrong, and it is still cumulative. The word over it was making a claim about the last 30 days of it that had not happened yet."
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
                  "A \"waiting in Trash\" figure, on four surfaces."
                ],
                [
                  "",
                  " The result card after a delete run, the Storage tab, the progress done card and the Stats page. It states a floor, says the mail was moved by this extension in the last 30 days, says Gmail clears Trash on its own after about that long, and admits it cannot see a Trash you emptied by hand. Nothing waiting shows nothing at all."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "An Open Trash button beside it."
                ],
                [
                  "",
                  " It brings the mailbox the run acted on to the front and takes it to Trash. With two accounts signed in it lands in the one that was cleaned rather than in the first one open, which is the same mistake 8.11 fixed for runs."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A note inside Gmail, at the door."
                ],
                [
                  "",
                  " Arriving in Trash through that button, and only through it, the panel in the corner says that Gmail's own \"Empty Trash now\" link is at the top of the list, that it is permanent, that it takes mail you deleted yourself along with it, and that Gmail does the job on its own after about 30 days anyway. It appears once and closes when you navigate away. The extension does not click that link, does not point at it, and has no run that touches Trash. Turning the Gmail button off turns this off with it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The recovery log records how many megabytes a run moved."
                ],
                [
                  "",
                  " It was keeping counts and no sizes, and it is the only store that knows which runs are still inside the window. Runs recorded by earlier versions report their count and no size, so the figure starts as an undercount on an upgrade and corrects itself as those runs age out."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "9.4.0",
      "title": "Ask whose markup it is before clicking it",
      "intro": [
        "The unsubscribe run asks three times whether a control belongs to Gmail before it clicks the first one, because a link inside a message was written by whoever sent it and following one takes the tab somewhere they chose. The confirmation that comes next asked nothing at all. It looked for the dialog anywhere on the page, and a sender who puts a dialog in their own message wins that search, because their copy is higher up the page than the one Gmail adds. So a stranger could get their link clicked, in a signed-in mailbox, without the person who owns it touching anything. The same unscoped search sat in the confirmation for a bulk delete, which is the click that turns a page into a whole result set.",
        "The rest of the release is a sweep, and most of it is the extension being made to stop saying things it had not established."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "A message can no longer supply the dialog its own unsubscribe gets confirmed in."
                ],
                [
                  "",
                  " One rule now answers \"is this Gmail's or the sender's\" for the dialog, for the buttons inside it, and for the bulk-delete confirmation, which had the same gap and the larger consequence."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Skip to main action link works."
                ],
                [
                  "",
                  " It is the first thing a keyboard reaches in the popup and it pointed at the Run button, which lives on the Clean tab, and the popup opens on Report. So the one control added for people not using a mouse did nothing at all on the tab it opens on. It goes to whichever tab you are actually looking at now."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A rule in the mailbox report shows the whole line it was cutting off."
                ],
                [
                  "",
                  " The description is one line and six of the ten steps were too long for it, and the part that got cut was the end, which is where it says whether the step deletes or archives."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Custom rules can be reordered without a mouse, and deleting one removes the one you clicked."
                ],
                [
                  "",
                  " The order was drag-only, and the handle was marked as decoration, so the order rules run in could not be changed from a keyboard. The delete worked by counting from the top of the list, which is the wrong rule as soon as anything else has changed the list, and there is no undo for a rule you wrote."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Importing a backup runs the same checks as typing."
                ],
                [
                  "",
                  " It was the one way into this extension that skipped them, so a file could restore a rule the page refuses to accept, including ones aimed at Starred mail, Trash and Spam, and could set a schedule to run more often than any control here offers. The import summary counted those as restored."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The unsubscribe ledger stops losing the record it keeps."
                ],
                [
                  "",
                  " The snapshot of which safety switches a figure was measured through is what lets the extension stop showing that figure once they change, and every write that was not a verification deleted it. A recheck that could not measure kept the previous number and stamped the new date on it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The receipts list is not emptied by a failed read."
                ],
                [
                  "",
                  " A storage read that did not answer looked exactly like having never unsubscribed from anything, and hid the whole panel."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The Gmail button stops calling a mailbox clean when it did not measure one."
                ],
                [
                  "",
                  " A scan whose searches timed out, and a mailbox holding old mail that falls outside the steps the panel lists, both produced \"That is a clean mailbox\". They say what happened now, and the second shows the count it had all along."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A popup watching one mailbox ignores a run in another."
                ],
                [
                  "",
                  " With two accounts signed in, a scan in the other tab could end this one's progress and put its numbers on screen."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Safe Mode, the default skips and the paid feature list say what the code does."
                ],
                [
                  "",
                  " Safe Mode protects receipts and shipping by subject and skips Updates and Forums rules; three places described it three different ways and none had both halves. Four skip switches ship on and the welcome named two. The paid list has been eight features since 9.0 and the store page and the popup's own pitch still said six."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Smaller things."
                ],
                [
                  "",
                  " The Rule Intensity list recommended an option three lines above the one it selects. Settings told Firefox users that Chrome would show their notification. The read-me stated a fixed Auto-Pilot sweep size that Pro Settings lets you change. The Clear button blamed a setting that ships empty. The Gmail panel put the cursor on its close button instead of its main one, and lost it entirely when you pressed Hide."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "9.3.0",
      "title": "Reach the mailbox that is already open",
      "intro": [
        "Last release put a cleaner button in the corner of Gmail, because everything this extension does had been sitting behind a toolbar icon Chrome hides until you pin it. It worked on the next Gmail you opened. It did not work on the Gmail you already had open, which for most people is the tab they were looking at when they installed it. A browser only runs a page script when the page loads, and it does not go back and run it in tabs that loaded earlier, so the one thing built for that moment was missing from it. The button and its one-time greeting now arrive in the mailboxes that are open right now, on a fresh install and on an update.",
        "The rest is a sweep. The panel was printing \"0+ MB\" on any mailbox whose old mail is all small, the selection pill on the popup's tabs was landing a few pixels off the tab it selects, a custom rule written with brackets was skipping a warning it should have got, and four places in the engine could still read the conversation list Gmail leaves behind for a moment while it renders a search."
      ],
      "sections": [
        {
          "name": "Fixed",
          "items": [
            {
              "text": [
                [
                  "b",
                  "The Gmail button reaches tabs that were already open."
                ],
                [
                  "",
                  " On install and on update, rather than on the next Gmail page load. Nothing new is asked for: the extension already had permission for mail.google.com, and the button still decides nothing for itself."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "An update no longer leaves a dead button in Gmail."
                ],
                [
                  "",
                  " Updating an extension cuts off the copy of the page script that is already running, and that copy was still watching the page. When the fresh copy cleared the old button out of the way, the cut-off one put it straight back: a button that looks right and answers nothing, holding the spot the working copy needed. The tab had to be reloaded to get out of it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"0+ MB\" is gone from the panel."
                ],
                [
                  "",
                  " Storage figures come from large mail specifically, and plenty of cluttered mailboxes hold none of it. Zero is not a smaller answer there, it is not an answer, so the panel drops the line the way the popup already did and gives the room to the count beside it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The selection pill lands on the tab it selects."
                ],
                [
                  "",
                  " It was drawn from different measurements than the row of tabs it sits behind, so it was slightly too wide and stepped slightly too short, and the error added up from left to right: the first tab's pill overhung by 3px and the last one fell 3px short. Both are built from the same two numbers now."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A grouped custom rule gets the same warning a plain one does."
                ],
                [
                  "",
                  " Gmail treats "
                ],
                [
                  "c",
                  "(in:inbox)"
                ],
                [
                  "",
                  " and "
                ],
                [
                  "c",
                  "{in:inbox in:all}"
                ],
                [
                  "",
                  " exactly as it treats "
                ],
                [
                  "c",
                  "in:inbox"
                ],
                [
                  "",
                  ", and the check that says \"this rule has no age limit, so it will act on mail that arrived today\" was only reading the plain form. The refusal that blocks genuinely unsafe rules already handled both."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Four more places that could read the wrong conversation list."
                ],
                [
                  "",
                  " While Gmail renders a search it leaves the previous list on the page for a moment. Version 8.25 kept the row lookups away from it. Left behind were the link that selects every conversation matching a search, the Unsubscribe control in an opened message, the check for whether a whole result set is selected, and the check for whether a page came back empty. Two of those hand back something the extension then clicks, and unsubscribing cannot be undone. None of them can reach the leftover now, and the shortcut that let them is gone from the file rather than avoided by habit."
                ]
              ]
            }
          ]
        }
      ]
    },
    {
      "version": "9.2.0",
      "title": "Be where the mailbox is",
      "intro": [
        "Everything this extension does has lived behind the toolbar icon, and Chrome folds that icon into the puzzle-piece menu until you pin it. So the mailbox report, the storage x-ray and the whole recovery net sat one click behind a button plenty of people never found. An install could go months without ever scanning anything, which is a strange thing to be true of a cleaner.",
        "There is a small button in the corner of Gmail now. It draws inside a closed shadow root, so nothing it defines can reach Gmail's page, nothing on that page can reach into it, and the counts it shows are not readable by anything else running on mail.google.com. It reads no mail and walks none of Gmail's interface. The only thing it can start is the free read-only report, which is the same scan the popup runs and the one worth running first. Anything that moves mail stays in the popup, behind the confirmations that are already there.",
        "The first mailbox you open after installing gets a greeting, once. After that the button sits closed until you click it, and it opens on whatever the last scan found."
      ],
      "sections": [
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "A cleaner button in the corner of Gmail."
                ],
                [
                  "",
                  " Small, in the bottom right, and it opens a panel rather than doing anything on its own. Escape closes it. It never appears on a copy of the extension that was planted by other software rather than installed from a store, which is the same rule that keeps scheduled sweeps off those copies."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The free mailbox report, started from inside Gmail."
                ],
                [
                  "",
                  " One click, the same read-only scan the popup runs, measured through the same safety switches so the counts describe what the popup's buttons would do. The panel then shows how many emails are old enough to clear, how many megabytes are sitting in old and large mail, and the three biggest steps by count."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Cleaner button inside Gmail, on the Options page."
                ],
                [
                  "",
                  " A switch, on by default. The panel can also hide the button for 30 days, and turning the switch back on clears that too, because a switch that reads on while the button stays gone is a switch that lies."
                ]
              ]
            }
          ]
        },
        {
          "name": "Changed",
          "items": [
            {
              "text": "The panel refuses to start a scan when anything else is already running in that tab, and says so, instead of injecting a second engine on top of the first."
            },
            {
              "text": "The scan the button starts runs in the tab the click came from. Never \"whichever Gmail tab is active\": with two accounts signed in, that is how you measure one mailbox and report on the other."
            },
            {
              "text": "A finished report now records which signed-in mailbox produced it, as an account number and nothing else. The panel in Gmail shows a report only in the mailbox it was measured in, so a second account does not get shown the first one's counts under the words \"this mailbox\". Reports saved by earlier versions carry no such mark and are still shown, because that is what those versions did."
            },
            {
              "text": "Switching the button off, or hiding it, now reaches Gmail tabs that were already open instead of waiting for a reload. The Scan button in a panel that was open when the switch moved refuses rather than running."
            }
          ]
        }
      ]
    },
    {
      "version": "9.1.0",
      "title": "Say it before the click, not after",
      "intro": [
        "Three screens in this extension put a number next to a button. Each number is measured through your safety switches, and each button reads those switches fresh at the moment you press it. When you change one in between, the number stops describing the button.",
        "The Mailbox Report learned to say so two releases back. Smart Suggestions learned it one release later. The sender census, added last release, shipped the half that records what it measured through and none of the half that checks. The record sat in storage with a note on it explaining what it was for and nothing read it.",
        "That check is on all three now, and most of this release is that one idea applied everywhere it was missing.",
        "The rest of it is about time rather than switches. Two of the lists this extension builds are made from your mail: the sender census, which is who fills your mailbox, and the unsubscribe receipts, which is who you asked to stop. Both hold real addresses, both sat here with no end date, and there was no button anywhere that removed them. There is one now, and the two stores age out on their own besides. They age out differently, because a census is a photograph and goes out of date, while a receipt is a record of something you did whose whole value is being old enough to prove a sender ignored you."
      ],
      "sections": [
        {
          "name": "Added",
          "items": [
            {
              "text": [
                [
                  "b",
                  "Erase Stored Sender Data, on the Options page."
                ],
                [
                  "",
                  " One button, with a confirmation that says what it takes and what it leaves. It removes the sender census, the unsubscribe receipt ledger, and the four lists of senders you have ticked in the census, storage, suggestion and subscription panels. It also names the consequence you would otherwise meet weeks later, which is that scheduled cleanups stop clearing the census senders you had ticked."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A card on the Diagnostics page for what is stored."
                ],
                [
                  "",
                  " How many senders the census holds, how many receipts, how many senders you have ticked, and when each was last written. Counts and dates only: no address appears there, and none is copied by Copy Diagnostics."
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
                  "A census older than a month stops printing its counts."
                ],
                [
                  "",
                  " It keeps the list and your ticks. The numbers go, because the clear it feeds only takes mail older than six months, so every month that passes pushes more of that sender's mail across the line and the stored figure understates what a clear would take. Understating a delete is the one direction that costs mail, and this extension would rather say nothing than say it low."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A census older than three months is not used at all."
                ],
                [
                  "",
                  " It stops being read, the senders you had ticked in it are dropped, and scheduled cleanups stop clearing them. That path had no upper bound before: a sender ticked last year still built a delete rule on every unattended sweep, off a census that had been replaced a dozen times since."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "An unsubscribe verdict past its recheck window is shown without its number."
                ],
                [
                  "",
                  " \"Ignored your unsubscribe when last checked\" rather than a count. That count was measured against a search anchored to the day your grace window closed, so read months later the same figure has quietly stopped answering \"did they ignore me\" and started answering \"how much does this sender send\". No receipt is ever deleted for its age: the date stays, and it stays in the queue to be checked."
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
                  "The diagnostics Test Inject button no longer logs the Gmail tab's title and full address."
                ],
                [
                  "",
                  " A Gmail tab title contains your own email address and a search URL carries whatever you last searched for, and both went into the log that Copy Diagnostics puts on your clipboard. It logs the origin, the path, and whether the engine is attached."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The census no longer promises a count it cannot keep."
                ],
                [
                  "",
                  " Untick Skip Unread after running the census and every row went on saying \"Clear would take 12\" while the button beside it would have deleted the unread mail too. The rows now drop the promise, the button drops its number, and a line appears saying the switches moved and the census should be run again."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "Sender sizes under a megabyte no longer read as zero."
                ],
                [
                  "",
                  " The Storage X-ray works in tenths of a megabyte everywhere it measures and everywhere it stores, and then rounded to whole megabytes on the way to the screen. On a mailbox of ordinary small mail that is most senders: a list of real names beside \"at least 0 MB\"."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The unsubscribe check no longer reports a sender as stopped when it just proved otherwise."
                ],
                [
                  "",
                  " A run whose only finding was a sender still mailing from the Spam folder finished with \"All 1 stopped.\" The closing line counted one verdict and there are five."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A sender that stopped and started again stays marked that way."
                ],
                [
                  "",
                  " The relapse was worked out from the previous verdict, and once a receipt was marked as a relapse the next check thirty days later no longer recognised it, wrote plain \"still sending\" over the top, and the fact you had watched that list go quiet was gone."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"Clear their mail\" says how much mail, and refuses when the answer is nothing."
                ],
                [
                  "",
                  " The button is scoped to what arrived after each sender's grace window closed, but your Minimum Age setting was still added on top, and mail cannot be both newer than two weeks ago and older than three months. The run opened Gmail, searched, found nothing and finished. The measured figure was already on hand and now sits on the button, which says which setting is in the way instead of starting."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "\"Re-run for the rest\" now reaches the rest."
                ],
                [
                  "",
                  " Both the census clear and the unsubscribe clear act on twenty-five senders at a time and neither remembered what it had already taken, so pressing again rebuilt the same twenty-five and sender twenty-six waited forever."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A ticked sender that falls off the census list can be untangled."
                ],
                [
                  "",
                  " The ticks are remembered between sessions and feed the scheduled sweep, so a sender ticked once and then not measured again by a later census kept generating a delete rule with no checkbox anywhere to clear it."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The check button says what one press checks."
                ],
                [
                  "",
                  " With forty receipts past their grace window it said forty and checked twenty-five, which is the cap the two buttons beside it have announced since they were built."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "The receipt list no longer shows one verdict less than the run found."
                ],
                [
                  "",
                  " The panel re-read the ledger the instant the run announced it was done, which raced the write of the last sender's answer."
                ]
              ]
            },
            {
              "text": [
                [
                  "b",
                  "A suggestion carried over from an earlier scan is checked against the switches it was actually measured under"
                ],
                [
                  "",
                  ", rather than the ones the most recent scan happened to use."
                ]
              ]
            }
          ]
        }
      ]
    },
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
    }
  ]
};

if (typeof module !== "undefined" && module.exports) module.exports = GCC_CHANGELOG;
