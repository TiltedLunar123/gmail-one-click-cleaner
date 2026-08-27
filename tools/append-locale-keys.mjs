// Append new catalogue entries to _locales/<loc>/messages.json as TEXT.
//
// Never round-trips the file through JSON.parse/stringify: these
// catalogues are one entry per line, grouped by blank lines, CRLF, and
// carry `description` fields that a re-stringify silently drops while
// rewriting all 2,000-odd lines. Reads like a catastrophe in review and
// is impossible to diff.
//
// Usage: node tools/append-locale-keys.mjs <dir-with-gcc-new-strings-*.json> <banner>
import fs from "node:fs";
import path from "node:path";

const srcDir = process.argv[2];
// argv[3] is accepted and ignored: JSON has no comments, so a banner
// cannot be written into the catalogue. Kept in the signature so the
// documented invocation does not change.
const LOCALES = ["en", "de", "es", "fr", "ja", "pt_BR", "ru"];

for (const loc of LOCALES) {
  const addPath = path.join(srcDir, `gcc-new-strings-${loc}.json`);
  const catPath = path.join("_locales", loc, "messages.json");
  const additions = JSON.parse(fs.readFileSync(addPath, "utf8"));
  const raw = fs.readFileSync(catPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";

  const closeAt = raw.lastIndexOf("}");
  if (closeAt < 0) throw new Error(`no closing brace in ${catPath}`);
  let head = raw.slice(0, closeAt).replace(/\s+$/, "");
  // The previous last entry has no trailing comma; it needs one now.
  if (!head.endsWith(",")) head += ",";

  const existing = new Set(Object.keys(JSON.parse(raw)));
  const lines = [];
  for (const [key, message] of Object.entries(additions)) {
    if (existing.has(key)) {
      console.error(`  skip (already present): ${loc} ${key}`);
      continue;
    }
    lines.push(`  ${JSON.stringify(key)}: { "message": ${JSON.stringify(message)} },`);
  }
  if (!lines.length) {
    console.error(`${loc}: nothing to add`);
    continue;
  }
  // Drop the trailing comma from the final new entry.
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "");

  // A blank line separates the new group from the last one, matching
  // how the rest of the file is grouped. No banner comment: JSON has no
  // comments and addons-linter parses these files strictly.
  fs.writeFileSync(catPath, head + eol + eol + lines.join(eol) + eol + "}" + eol);
  console.error(`${loc}: +${lines.length}`);
}
