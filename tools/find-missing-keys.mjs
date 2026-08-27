// Dev helper: list every t()/data-i18n key referenced by the shipped
// files that the English catalogue does not define, with the inline
// fallback each one carries. Run it after adding UI copy; the answer is
// what has to be written into all seven catalogues.
import fs from "node:fs";

const en = JSON.parse(fs.readFileSync("_locales/en/messages.json", "utf8"));
const html = fs.readFileSync("popup.html", "utf8");
const sources = ["popup.js", "shared.js", "background.js", "options.js", "progress.js", "stats.js"];
const js = sources.map((f) => fs.readFileSync(f, "utf8")).join("\n");

const missing = new Map();
let m;

const htmlRe = /data-i18n(?:-label)?="([A-Za-z0-9_]+)"/g;
while ((m = htmlRe.exec(html)) !== null) {
  if (!en[m[1]]) missing.set(m[1], "");
}

const jsRe = /\b(?:t|bgT)\(\s*"([A-Za-z0-9_]+)"\s*,\s*(`[^`]*`|"(?:[^"\\]|\\.)*")/g;
while ((m = jsRe.exec(js)) !== null) {
  if (!en[m[1]] && !missing.get(m[1])) missing.set(m[1], m[2]);
}

for (const [key, fallback] of missing) console.log(key + "\t" + fallback);
console.error(`missing: ${missing.size}`);
