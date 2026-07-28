// recover-key: re-issues a Pro license key to the address that paid for
// it. The original recovery path is "revisit the activate link Stripe
// redirected you to", which only works while the buyer still has that
// URL. This one needs nothing but the email they checked out with.
//
// Proof of purchase is a live Stripe lookup: a paid Checkout Session on
// one of this app's payment links, for that exact email. No session id,
// no database, no stored customer data. With no STRIPE_SECRET_KEY
// configured the endpoint fails closed, exactly like get-key.
//
// The key is minted from the same session the checkout used, so its
// payload is identical to the original: same purchase, same license,
// no second entitlement. The signature bytes differ (ECDSA signing is
// randomised), so the STRING is not identical to the one issued at
// checkout. That costs nothing: the extension verifies signatures, it
// never compares key strings, so the buyer's original key and every
// re-issued one all keep working side by side.
//
// Deliberate trade-off: anyone who knows a buyer's email can pull that
// buyer's key. Buyer addresses are not public anywhere, the key is a
// copyable string the buyer could share regardless, and the alternative
// (no self-serve recovery) strands paying customers. Enumeration is
// throttled per IP below.

"use strict";

const crypto = require("node:crypto");

// Deliberately permissive: this only has to reject junk before we spend
// a Stripe call. Stripe itself is the real authority on what address
// paid, and an address that never paid returns nothing regardless.
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

// Best effort only: Netlify may run several instances, so this throttles
// a single attacker on a single instance rather than enforcing a global
// budget. It raises the cost of guessing addresses without adding state.
const RATE_LIMIT = Object.freeze({
  MAX_PER_WINDOW: 6,
  WINDOW_MS: 10 * 60 * 1000,
  MAX_TRACKED_IPS: 500
});

const rateState = new Map();

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json",
  "cache-control": "no-store"
});

function respond(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

// The same minting routine as get-key.js, on purpose: a recovered key
// has to carry the exact payload checkout would have issued, or the
// two paths drift into issuing different licenses. get-key.js is the
// money path and stays untouched, so this is a deliberate copy and
// tests/recover-key pins the two implementations against each other.
function mintKey(privateKeyPem, sessionId, purchasedAt) {
  const payload = JSON.stringify({
    v: 1,
    plan: "pro",
    sid: String(sessionId).slice(-10),
    iat: Number(purchasedAt) || 0
  });
  const payloadPart = b64url(payload);
  const signature = crypto.sign("sha256", Buffer.from(payloadPart, "utf8"), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363"
  });
  return `GCC1.${payloadPart}.${b64url(signature)}`;
}

function clientIp(headers) {
  const h = headers || {};
  const direct = h["x-nf-client-connection-ip"] || h["client-ip"] || "";
  if (direct) return String(direct);
  const forwarded = String(h["x-forwarded-for"] || "");
  return forwarded.split(",")[0].trim() || "unknown";
}

// Returns true when this caller has spent its budget for the window.
function isRateLimited(ip, now) {
  const entry = rateState.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT.WINDOW_MS) {
    if (rateState.size >= RATE_LIMIT.MAX_TRACKED_IPS) rateState.clear();
    rateState.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT.MAX_PER_WINDOW;
}

function readEmail(event) {
  let parsed;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "");
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const email = String(parsed?.email || "").trim();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return "";
  return email;
}

async function listSessions(paymentLinkId, email, apiKey, fetchImpl) {
  const params = new URLSearchParams({
    payment_link: paymentLinkId,
    "customer_details[email]": email,
    limit: "100"
  });
  const res = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions?${params}`, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  const data = await res.json();
  return { status: res.status, data };
}

// The oldest paid session wins, so a repeat buyer's recoveries always
// describe the same purchase instead of alternating between them.
function pickSession(sessions) {
  return sessions
    .filter((s) => s && s.payment_status === "paid" && typeof s.id === "string")
    .sort((a, b) => (Number(a.created) || 0) - (Number(b.created) || 0)
      || String(a.id).localeCompare(String(b.id)))[0] || null;
}

async function handler(event) {
  // POST only: an email in a query string would land in browser history,
  // proxy logs and referrers.
  if ((event.httpMethod || "POST") !== "POST") {
    return respond(405, { error: "method not allowed" });
  }

  const email = readEmail(event);
  if (!email) {
    return respond(400, { error: "enter the email address you paid with" });
  }

  const apiKey = process.env.STRIPE_SECRET_KEY || "";
  const privateKeyPem = process.env.LICENSE_PRIVATE_KEY || "";
  const paymentLinkIds = (process.env.STRIPE_PAYMENT_LINK_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!apiKey || !privateKeyPem || paymentLinkIds.length === 0) {
    return respond(503, { error: "key recovery is not configured yet; your purchase is safe, contact support with your receipt" });
  }

  if (isRateLimited(clientIp(event.headers), Date.now())) {
    return respond(429, { error: "too many recovery attempts; wait a few minutes and try again" });
  }

  // Stripe stores whatever the buyer typed at checkout, so try the
  // address as given and lowercased. Same address = one query.
  const candidates = [...new Set([email, email.toLowerCase()])];
  const found = [];
  for (const linkId of paymentLinkIds) {
    for (const candidate of candidates) {
      let result;
      try {
        result = await listSessions(linkId, candidate, apiKey, globalThis.fetch);
      } catch {
        return respond(502, { error: "could not reach Stripe, try again shortly" });
      }
      if (result.status !== 200 || !Array.isArray(result.data?.data)) {
        return respond(502, { error: "unexpected Stripe response, try again shortly" });
      }
      found.push(...result.data.data);
    }
  }

  const session = pickSession(found);
  if (!session) {
    return respond(404, { error: "no completed Pro purchase found for that email address" });
  }

  try {
    return respond(200, { key: mintKey(privateKeyPem, session.id, session.created) });
  } catch {
    return respond(500, { error: "key minting failed, contact support with your receipt" });
  }
}

exports.handler = handler;
// Exposed for unit tests only.
exports._internal = { mintKey, pickSession, readEmail, isRateLimited, rateState, EMAIL_PATTERN, RATE_LIMIT };
