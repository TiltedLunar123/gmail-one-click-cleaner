#!/usr/bin/env node
/**
 * Local sales analytics. Run it any time:
 *
 *   npm run analytics            text summary in the terminal
 *   npm run analytics -- --open  also write and open an HTML report
 *   npm run analytics -- --days=90
 *
 * Reads real Stripe data through the Stripe CLI you are already logged
 * into (`stripe login`), so there is no API key to store here and
 * nothing to configure. Everything it prints comes from completed
 * purchases.
 *
 * WHAT THIS CAN AND CANNOT TELL YOU
 *
 * The extension has no telemetry, on purpose: the listing, the privacy
 * policy and the buy page all promise it runs entirely locally and
 * never phones home. So this tool cannot tell you how often people run
 * a cleanup or which button they hover.
 *
 * What it CAN tell you is the part that matters for deciding what to
 * build next: which Pro gate people were standing in front of when
 * they decided to pay. Every "Get Pro" surface tags its checkout link
 * with a source label (GCC.license.buyUrl in shared.js), Stripe stores
 * that on the Checkout Session as client_reference_id, and this groups
 * the sales by it. Nothing is recorded for anyone who does not buy.
 *
 * Sales before 7.14 have no label and show up as "untagged (pre-7.14)".
 */

"use strict";

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Both links sell Pro: the original $5 one whose URL is baked into
// every shipped version up to 7.10, and the current $9.99 one. A
// Checkout Session on anything else belongs to another product on this
// shared Stripe account and is none of our business.
const PAYMENT_LINKS = new Set([
  "plink_1ToqxcJ5qxZnrDFfHNiGLYvj", // $5 legacy
  "plink_1Tts6BJ5qxZnrDFfi5VqliOD"  // $9.99 current
]);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const DAYS = Number(flag("days", "365")) || 365;
const WANT_HTML = args.includes("--open") || args.includes("--html");
const WANT_OPEN = args.includes("--open");

function stripeCli(resourceArgs) {
  // The CLI defaults to test mode; --live is what makes it real data.
  const out = execFileSync("stripe", [...resourceArgs, "--live", "--limit", "100"], {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024
  });
  return JSON.parse(out);
}

function fail(message, hint) {
  console.error(`\n  ${message}\n`);
  if (hint) console.error(`  ${hint}\n`);
  process.exit(1);
}

let sessions;
try {
  sessions = stripeCli(["checkout", "sessions", "list"]).data || [];
} catch (e) {
  const msg = String(e?.stderr || e?.message || e);
  if (/not logged in|Authentication|API key/i.test(msg)) {
    fail("The Stripe CLI is not authenticated.", "Run: stripe login   (then re-run this)");
  }
  if (/ENOENT|not recognized|not found/i.test(msg)) {
    fail("The Stripe CLI is not on PATH.", "Install: winget install Stripe.StripeCli");
  }
  fail("Could not read Stripe.", msg.split("\n")[0]);
}

const cutoff = Date.now() / 1000 - DAYS * 86400;
const sales = sessions
  .filter((s) => s.payment_status === "paid")
  .filter((s) => PAYMENT_LINKS.has(s.payment_link))
  .filter((s) => Number(s.created) >= cutoff)
  .sort((a, b) => Number(a.created) - Number(b.created));

const money = (cents, currency) =>
  `${(Number(cents || 0) / 100).toFixed(2)} ${String(currency || "usd").toUpperCase()}`;

const day = (unix) => new Date(Number(unix) * 1000).toISOString().slice(0, 10);

// Stripe settles in the buyer's currency; amount_total is what they
// were charged, not what landed. Presentment totals are grouped by
// currency rather than summed into a fake single number.
const byCurrency = new Map();
for (const s of sales) {
  const cur = String(s.currency || "usd").toUpperCase();
  byCurrency.set(cur, (byCurrency.get(cur) || 0) + Number(s.amount_total || 0));
}

const SOURCE_LABELS = {
  gcc_unsubscribe: "Unsubscribe tab, Get Pro link",
  gcc_unsubscribe_locked: "Unsubscribe tab, clicked the locked button",
  gcc_storage_xray: "Storage tab, Get Pro link",
  gcc_storage_xray_locked: "Storage tab, clicked the locked purge",
  gcc_smart_suggestions: "Smart Suggestions, Get Pro link",
  gcc_smart_bulk_locked: "Smart Suggestions, clicked locked bulk apply",
  gcc_smart_unsub_locked: "Smart Suggestions, clicked a locked unsubscribe card",
  gcc_autopilot: "Auto-Pilot, Get Pro link",
  gcc_autopilot_locked: "Auto-Pilot, clicked the locked control",
  gcc_autopilot_toggle_locked: "Auto-Pilot, flipped the locked toggle",
  gcc_popup_promo: "Popup promo strip",
  gcc_options: "Options page, Pro License section",
  gcc_progress: "Progress dashboard link (retired in 8.0)",
  // 8.0
  gcc_report_band_locked: "Mailbox Report, clicked a locked plan step",
  gcc_report_plan_locked: "Mailbox Report, clicked Run the whole plan",
  gcc_report_upsell: "Mailbox Report, Get Pro link",
  gcc_progress_done: "Progress dashboard, run-completion card",
  gcc_pro_panel: "Pro panel, opened without a recorded source"
};

const describeSource = (ref) => {
  if (!ref) return "untagged (bought before 7.14)";
  if (SOURCE_LABELS[ref]) return SOURCE_LABELS[ref];
  if (ref.startsWith("gcc_web_")) {
    const where = ref.slice("gcc_web_".length);
    return where === "buypage_direct"
      ? "Buy page, typed or bookmarked"
      : `Buy page, arrived from ${where}`;
  }
  return ref;
};

const tally = (items, keyFn) => {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};

const bySource = tally(sales, (s) => describeSource(s.client_reference_id));
const byPrice = tally(sales, (s) =>
  s.payment_link === "plink_1ToqxcJ5qxZnrDFfHNiGLYvj" ? "$5 legacy link" : "$9.99 current link");
const byCountry = tally(sales, (s) => s.customer_details?.address?.country || "unknown");
const byMonth = tally(sales, (s) => day(s.created).slice(0, 7));

const untagged = sales.filter((s) => !s.client_reference_id).length;
const tagged = sales.length - untagged;

// ---- terminal summary ----

const line = (s = "") => console.log(s);
const bar = (n, max, width = 24) =>
  "#".repeat(Math.max(1, Math.round((n / Math.max(1, max)) * width)));

line();
line("  Gmail One-Click Cleaner Pro - sales analytics");
line(`  Last ${DAYS} days, read live from Stripe. ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
line("  " + "-".repeat(62));
line();
line(`  Paid sales: ${sales.length}`);
for (const [cur, total] of byCurrency) line(`  Collected:  ${money(total, cur)}`);
if (sales.length) {
  line(`  First sale: ${day(sales[0].created)}`);
  line(`  Last sale:  ${day(sales[sales.length - 1].created)}`);
}
line();

if (!sales.length) {
  line("  No paid sales in this window.");
  line();
  process.exit(0);
}

const section = (title, rows, note) => {
  line(`  ${title}`);
  if (note) line(`    ${note}`);
  const max = Math.max(...rows.map((r) => r[1]));
  for (const [label, count] of rows) {
    line(`    ${String(count).padStart(3)}  ${bar(count, max).padEnd(24)}  ${label}`);
  }
  line();
};

section("What made them buy", bySource,
  tagged === 0
    ? "Nothing tagged yet. Every sale from 7.14 onward carries its source."
    : `${tagged} of ${sales.length} sales carry a source tag.`);
section("Which price they paid", byPrice);
section("Where they were", byCountry);
section("When", byMonth);

line("  What this cannot see");
line("    Feature usage inside the extension. There is no telemetry, by");
line("    design, and the listing promises it stays that way. Install and");
line("    impression counts live in the Chrome Web Store and AMO dashboards.");
line();

// ---- optional HTML report ----

if (WANT_HTML) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const table = (title, rows) => `
    <h2>${esc(title)}</h2>
    <table>
      ${rows.map(([label, count]) => `
        <tr>
          <td class="n">${count}</td>
          <td><div class="bar" style="width:${Math.round((count / Math.max(...rows.map((r) => r[1]))) * 100)}%"></div></td>
          <td>${esc(label)}</td>
        </tr>`).join("")}
    </table>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<title>Gmail Cleaner Pro - sales analytics</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #06090f;
         color: #e2e8f0; margin: 0; padding: 40px 24px; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em;
       color: #94a3b8; margin: 34px 0 10px; }
  .sub { color: #94a3b8; font-size: 13.5px; margin: 0 0 26px; }
  .cards { display: flex; gap: 14px; flex-wrap: wrap; }
  .card { flex: 1 1 150px; background: rgba(17,26,36,.75); border: 1px solid rgba(148,163,184,.2);
          border-radius: 12px; padding: 16px; }
  .card b { display: block; font-size: 26px; margin-bottom: 2px; }
  .card span { color: #94a3b8; font-size: 12.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  td { padding: 5px 8px 5px 0; vertical-align: middle; }
  td.n { width: 40px; text-align: right; color: #22d3ee; font-variant-numeric: tabular-nums; }
  td:nth-child(2) { width: 160px; }
  .bar { height: 8px; border-radius: 4px; background: linear-gradient(90deg,#22d3ee,#38bdf8); min-width: 4px; }
  .note { margin-top: 34px; padding: 14px 16px; border-radius: 10px; font-size: 12.5px;
          background: rgba(6,9,15,.55); border: 1px solid rgba(148,163,184,.2); color: #94a3b8; line-height: 1.6; }
</style></head>
<body><main>
  <h1>Pro sales analytics</h1>
  <p class="sub">Last ${DAYS} days, read live from Stripe on ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC.</p>
  <div class="cards">
    <div class="card"><b>${sales.length}</b><span>paid sales</span></div>
    ${[...byCurrency].map(([cur, total]) =>
      `<div class="card"><b>${esc(money(total, cur).replace(/ .*/, ""))}</b><span>collected (${esc(cur)})</span></div>`).join("")}
    <div class="card"><b>${tagged}</b><span>with a source tag</span></div>
  </div>
  ${table("What made them buy", bySource)}
  ${table("Which price they paid", byPrice)}
  ${table("Where they were", byCountry)}
  ${table("When", byMonth)}
  <p class="note"><strong>What this cannot see:</strong> feature usage inside the
  extension. There is no telemetry, by design, and the store listing promises it stays
  that way. Install, impression and uninstall counts live in the Chrome Web Store and
  AMO dashboards. Everything above comes from completed purchases only.</p>
</main></body></html>`;

  const out = join(ROOT, "analytics-report.html");
  writeFileSync(out, html, "utf-8");
  line(`  HTML report written to ${out}`);
  line();
  if (WANT_OPEN) {
    try {
      execFileSync("cmd", ["/c", "start", "", out], { stdio: "ignore" });
    } catch {
      // Opening is a convenience; the path above is the real output.
    }
  }
}
