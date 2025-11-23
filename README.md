# gmail-one-click-cleaner

Gmail One-Click Cleaner is a Chrome extension that bulk deletes low-value Gmail clutter in one click. It runs safe preset searches for promos, social updates, newsletters, no-reply mail, and large attachments, with a simple progress screen, so you can free storage and keep important messages easy to find.

---

## Features

- **One click cleanups**  
  Run a full cleanup sequence from a single button instead of dozens of manual searches.

- **Targets common inbox junk**  
  Preset searches focus on:
  - Old Promotions (sales, ads)
  - Old Social notifications (follows, likes, comments)
  - Old Updates and Forums messages
  - Newsletters and marketing lists
  - No-reply or donotreply automated emails
  - Messages with very large attachments

- **Runs inside your Gmail tab**  
  The extension uses your currently open Gmail tab, runs the searches there, and deletes matching conversations while you watch progress.

- **Simple progress screen**  
  See which rule is running, how many conversations were found and deleted, and when the cleanup is finished.

- **Safe by default**  
  Rules are tuned to focus on older, low-value clutter so important recent conversations and personal mail are less likely to be touched.

- **No external accounts**  
  No sign-up, no extra password, and no external server. Everything runs in your browser against your own Gmail session.

---

## How it works

1. You open Gmail in your browser.
2. You click the Gmail One-Click Cleaner extension icon.
3. The extension opens a small progress window and steps through a fixed list of Gmail searches, for example:
   - `category:promotions older_than:1y`
   - `category:social older_than:1y`
   - `larger:10M older_than:1y`
4. For each rule it:
   - Runs the search in your existing Gmail tab.
   - Selects all conversations that match the search.
   - Uses "Select all conversations that match this search" when available.
   - Clicks Delete to move those emails to Trash.
   - Repeats a few passes until that rule has nothing left to clean.

The result is a much lighter inbox and more free Google account storage with far less effort than manual cleanup.

---

## Installation

### From the Chrome Web Store

1. Open the Chrome Web Store.
2. Search for **"Gmail One-Click Cleaner"**.
3. Click **Add to Chrome**.
4. Pin the extension in your toolbar if you want quick access.

> Replace this line with your real store link when you copy this into GitHub:
> `https://chromewebstore.google.com/detail/bmcfpljakkpcbinhgiahncpcbhmihgpc?utm_source=item-share-cb`

### From source (developer mode)

If you cloned or downloaded this repository:

1. Download or clone the repo:
   ```bash
   git clone https://github.com/YOUR_USERNAME/gmail-one-click-cleaner.git
