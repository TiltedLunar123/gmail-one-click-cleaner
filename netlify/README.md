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

- **Re-issue a lost key:** find the buyer's Checkout Session id
  (`cs_live_...`) on the payment in the Stripe dashboard, then open
  `https://gmail-cleaner-pro.netlify.app/activate?session_id=<id>`.
- **Key rotation:** new keypair means new public JWK in `shared.js`
  (extension release) and new `LICENSE_PRIVATE_KEY` here. Old keys keep
  verifying only if the old public key is kept alongside the new one.
- **Refunds do not revoke keys.** Offline verification has no revocation
  channel; at this price point that is an accepted trade-off.
