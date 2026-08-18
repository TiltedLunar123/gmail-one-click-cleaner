# Gmail One-Click Cleaner privacy policy

**Effective 2026-07-28.**

The extension has no analytics, no telemetry, no error reporting, no account system, and
no ability to send your mail anywhere: it makes no network requests of its own at all.
Below is the precise version, including the few places where information does move and
exactly why.

- **The extension sends nothing.** Cleanup, scanning, suggestion ranking and unsubscribing
  all run locally, in your own browser session, against the Gmail interface. No email
  content, subject, address or credential is ever transmitted to us. We operate no service
  that could receive your mail, and we cannot read your mailbox.

- **What stays on your device.** Your recovery log, cleanup history, run statistics and the
  results of subscription, storage and suggestion scans are held in the extension's local
  storage. Those scans build an on-device index of who emails you, how much storage each
  sender uses, how much of their mail you leave unread, and which senders you have already
  acted on; Smart Suggestions and Auto-Pilot rank suggestions from it, and it reads your
  Sent mail to notice senders you actually reply to. None of it is transmitted, and it is
  removed when you uninstall.

- **What your browser syncs.** Your settings, cleanup rules, custom rules, protected
  keywords, schedules, Auto-Pilot configuration, your sender whitelist and your Pro license
  key are kept in your browser's *sync* storage. That means Chrome or Firefox copies them to
  your browser account and on to your other signed-in browsers. Your whitelist contains real
  email addresses and domains. None of it comes to us: it goes to your browser vendor, under
  their privacy policy. Turning off extension sync in your browser keeps all of it on the one
  device.

- **Unsubscribing asks the sender to stop.** Bulk unsubscribe drives Gmail's own built-in
  Unsubscribe control, so Gmail contacts that sender or its list host on your behalf, exactly
  as it would if you clicked the button yourself. That request identifies you to a sender who
  already has your address. We are not part of it and never see it.

- **The purchase website is separate from the extension.** Buying, activating and recovering
  a key all happen on `gmail-cleaner-pro.netlify.app`, never inside the extension, and no
  Gmail data is involved at any point. Payments are processed by Stripe under the Stripe
  privacy policy; we never see your card details. There is no database anywhere in this flow.

- **Key recovery uses your email address for one lookup.** If you lose your key you can enter
  the address you paid with. That address is sent to our recovery endpoint, which asks Stripe
  whether it has a completed purchase of this product and returns a key if it does. The
  address is used for that lookup and nothing else: it is not stored, not logged to a
  database, and never added to any mailing list. Your IP address is held in that endpoint's
  memory for a few minutes purely to limit how many attempts one visitor can make, and is not
  written down anywhere.

- **Those pages keep a copy of your key in your browser.** The activation and recovery pages
  save the issued key in that website's own browser storage so a return visit can show it to
  you again. That copy belongs to the website rather than the extension, so uninstalling the
  extension does not remove it; clearing site data for that domain does.

- **Which feature sent you to checkout.** Each "Get Pro" link carries a fixed label naming the
  feature it was clicked from, and Stripe records it on the purchase. It holds no personal,
  device or mailbox information, it travels only if you choose to click through to checkout,
  and it is recorded only if you complete a purchase. Nothing at all is recorded for anyone
  who does not buy. We use it to decide which features are worth building on.

- **Nothing is sold, rented or shared.** The only third parties involved anywhere in this
  product are Stripe, for payments, and your own browser vendor, for sync, each under their
  own privacy policy. There is nobody else, and there is no advertising.

- **Exporting your settings is your file to look after.** The export feature writes a plain,
  unencrypted file to your computer containing your rules and your whitelist addresses. Once
  it leaves the extension it is outside our control and unaffected by uninstalling.

## Verifying the first claim yourself

The claim this whole policy rests on is that the extension makes no network requests. The
source is public and you do not have to take our word for it:

```bash
grep -rE 'fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource' *.js *.html
```

That returns nothing, and a test in the suite fails the build if it ever stops returning
nothing.

## Contact

Questions about this policy: open an issue at
<https://github.com/TiltedLunar123/gmail-one-click-cleaner/issues>.

The terms of use are in [TERMS.md](TERMS.md).
