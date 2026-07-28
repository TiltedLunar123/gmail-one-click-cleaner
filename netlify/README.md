# Pro license service

Tiny Netlify site that issues Gmail One-Click Cleaner Pro keys after a
Stripe Payment Link purchase. One function, one static page, no
database:

- `site/activate.html` - Stripe's post-checkout redirect target
  (`/activate?session_id={CHECKOUT_SESSION_ID}`). Fetches the key and
  shows it to the buyer. Revisiting the same URL re-issues the same
  buyer's key, so it doubles as self-serve recovery.
- `functions/get-key.js` - verifies the checkout session against the
  Stripe API (paid + belongs to this app's payment link), then mints a
  signed key. Fails closed if any env var is missing.
- `site/recover.html` + `functions/recover-key.js` - recovery for buyers
  who no longer have the post-checkout link. Takes the email used at
  checkout, finds a paid session on one of the configured payment links,
  and mints a key from it. POST only, so the address never lands in a
  URL, and rate limited per IP.

The extension verifies keys offline (ECDSA P-256, public key embedded
in `shared.js`); nothing in the extension ever calls this service.

## Environment variables (Netlify site: gmail-cleaner-pro)

| Var | What |
| --- | --- |
| `STRIPE_SECRET_KEY` | Restricted key is enough: read access to Checkout Sessions. |
| `LICENSE_PRIVATE_KEY` | PKCS8 PEM, ECDSA P-256. Pair of the public JWK in `shared.js`. |
| `STRIPE_PAYMENT_LINK_ID` | The `plink_...` id this product sells through. |

## Deploy

```bash
netlify deploy --prod    # netlify.toml points at site/ + functions/
```

## Ops notes

- **Re-issue a lost key:** point the buyer at
  `https://gmail-cleaner-pro.netlify.app/recover.html` and have them
  enter the address they paid with. Manual route if that fails: find the
  buyer's Checkout Session id (`cs_live_...`) on the payment in the
  Stripe dashboard, then open
  `https://gmail-cleaner-pro.netlify.app/activate?session_id=<id>`.
- **Re-issued keys are new strings, not the original.** ECDSA signing is
  randomised, so every mint of the same purchase produces different
  signature bytes over an identical payload. Nothing compares key
  strings anywhere (the extension verifies signatures), so old and new
  keys all keep working. Do not "fix" this by making signing
  deterministic.
- **Both functions mint identically.** `recover-key.js` carries its own
  copy of `mintKey` so the money path in `get-key.js` never has to be
  edited; `tests/recover-key.test.js` pins the two payloads against each
  other. If you change one, the test fails until you change the other.
- **Recovery trades enumeration for reachability.** Anyone who knows a
  buyer's email can pull that buyer's key. Buyer addresses are not
  public, the key is a copyable string a buyer could share anyway, and
  the alternative strands paying customers who lost their link. Only
  sessions on the configured payment links count, so the other products
  on this Stripe account are never visible to it.
- **Key rotation:** new keypair means new public JWK in `shared.js`
  (extension release) and new `LICENSE_PRIVATE_KEY` here. Old keys keep
  verifying only if the old public key is kept alongside the new one.
- **Refunds do not revoke keys.** Offline verification has no revocation
  channel; at this price point that is an accepted trade-off.
