#!/usr/bin/env node
// tools/build-changelog.mjs
//
// Turns CHANGELOG.md into changelog-data.js, the data the in-extension
// What's new page renders.
//
// Why generate instead of reading the markdown at runtime: fetching a
// packaged file is still a fetch(), and "grep the shipped bundle for a
// network call and it comes back empty" is the one claim the store
// listings, SECURITY.md and the AMO reviewer notes all rest on. So the
// log is baked in as data at author time.
//
// Why data rather than HTML: nothing here reaches innerHTML. The page
// builds text nodes and <strong>/<code> elements from typed runs, so a
// stray angle bracket in a future entry cannot become markup.
//
//   npm run changelog          rewrite changelog-data.js
//   npm run changelog -- --check   exit 1 if it is out of date
//
// tools/ is not in build.js FILES, so this script never ships.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "CHANGELOG.md");
const OUTPUT = path.join(ROOT, "changelog-data.js");

// How many releases the in-extension page carries. The full log is 60+
// entries and ~100KB of prose; shipping all of it would roughly double
// the package for history nobody scrolls to. The page says how many are
// hidden and links the rest on GitHub, so the cap is visible, never a
// silent truncation.
const KEEP = 12;

// ---------------------------------------------------------------
// Inline markup -> typed runs
// ---------------------------------------------------------------
// Only the two things the log actually uses: **bold** and `code`. Kinds
// are "" | "b" | "c" | "bc"; everything else stays literal text, which
// is the safe default.
//
// A scanner rather than a regex because the two nest. The log really
// contains "**A whitelist entry like `*@bank.com` protects that
// domain.**", and a `\*\*([^*]+)\*\*` pattern refuses that (the code
// span has a `*` in it), which left the asterisks in the shipped text.
function toRuns(text) {
  const source = String(text);
  // Unbalanced markers are literal. Better a stray asterisk than the
  // rest of an entry silently rendering bold.
  const balanced = (source.split("**").length - 1) % 2 === 0 &&
    (source.split("`").length - 1) % 2 === 0;
  if (!balanced) return source;

  const runs = [];
  let bold = false;
  let code = false;
  let buf = "";

  const flush = () => {
    if (!buf) return;
    runs.push([(bold ? "b" : "") + (code ? "c" : ""), buf]);
    buf = "";
  };

  for (let i = 0; i < source.length; i++) {
    // Inside a code span the asterisks are part of the query.
    if (!code && source.startsWith("**", i)) {
      flush();
      bold = !bold;
      i += 1;
      continue;
    }
    if (source[i] === "`") {
      flush();
      code = !code;
      continue;
    }
    buf += source[i];
  }
  flush();

  // Collapse the common single-plain-run case to a bare string; it is
  // most of the file and the array wrapper buys nothing.
  if (runs.length === 1 && runs[0][0] === "") return runs[0][1];
  return runs.length ? runs : "";
}

// The log hard-wraps at ~72 columns, so a bullet or paragraph arrives as
// several lines that have to be rejoined before markup is parsed: a
// **bold run** can straddle the wrap.
const joinWrapped = (lines) => lines.join(" ").replace(/\s+/g, " ").trim();

function parseChangelog(markdown) {
  const lines = markdown.split(/\r?\n/);
  const entries = [];

  let entry = null;
  let section = null;
  // Buffer for whatever is currently accumulating: a paragraph, a
  // top-level bullet, or a nested one.
  let buf = [];
  let bufKind = null; // "para" | "item" | "sub"

  const target = () => (section ? section : entry);

  const flush = () => {
    if (!buf.length || !entry) { buf = []; bufKind = null; return; }
    const text = joinWrapped(buf);
    buf = [];
    if (text) {
      if (bufKind === "para") target().intro.push(toRuns(text));
      else if (bufKind === "item") target().items.push({ text: toRuns(text), sub: [] });
      else if (bufKind === "sub") {
        const items = target().items;
        // A nested bullet with no parent cannot happen in this file, but
        // promoting it beats dropping it silently if the log ever changes.
        if (items.length) items[items.length - 1].sub.push(toRuns(text));
        else items.push({ text: toRuns(text), sub: [] });
      }
    }
    bufKind = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    const version = line.match(/^##\s+(\S+)\s+-\s+(.+)$/);
    if (version) {
      flush();
      section = null;
      entry = { version: version[1], title: version[2].trim(), intro: [], items: [], sections: [] };
      entries.push(entry);
      continue;
    }

    // "## Unreleased" and friends: a version heading with no title.
    const bareVersion = line.match(/^##\s+(.+)$/);
    if (bareVersion) {
      flush();
      section = null;
      entry = { version: bareVersion[1].trim(), title: "", intro: [], items: [], sections: [] };
      entries.push(entry);
      continue;
    }

    if (!entry) continue; // the file's own title and preamble

    const heading = line.match(/^###\s+(.+)$/);
    if (heading) {
      flush();
      section = { name: heading[1].trim(), intro: [], items: [] };
      entry.sections.push(section);
      continue;
    }

    if (!line.trim()) { flush(); continue; }

    const sub = line.match(/^\s{2,}[-*]\s+(.+)$/);
    if (sub) { flush(); bufKind = "sub"; buf.push(sub[1]); continue; }

    const item = line.match(/^[-*]\s+(.+)$/);
    if (item) { flush(); bufKind = "item"; buf.push(item[1]); continue; }

    // A continuation of whatever is open, or a fresh paragraph.
    if (!bufKind) bufKind = "para";
    buf.push(line.trim());
  }
  flush();

  return entries;
}

// Drop the empty containers so the shipped file is not half punctuation.
function tidy(entry) {
  const out = { version: entry.version };
  if (entry.title) out.title = entry.title;
  if (entry.intro.length) out.intro = entry.intro;
  if (entry.items.length) out.items = entry.items.map(tidyItem);
  const sections = entry.sections
    .map((s) => {
      const sec = { name: s.name };
      if (s.intro.length) sec.intro = s.intro;
      if (s.items.length) sec.items = s.items.map(tidyItem);
      return sec;
    })
    .filter((s) => s.intro || s.items);
  if (sections.length) out.sections = sections;
  return out;
}

const tidyItem = (it) => (it.sub.length ? { text: it.text, sub: it.sub } : { text: it.text });

// The working tree is CRLF on Windows and LF on the Linux CI runner,
// because core.autocrlf stores LF and checks out per platform. So the
// writer follows the host and --check compares content with the line
// endings normalised away: whether the data matches CHANGELOG.md is the
// property worth testing, and which bytes end a line is git's business.
const EOL = process.platform === "win32" ? "\r\n" : "\n";
const sameContent = (a, b) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

function render(entries, total) {
  const payload = { total, entries };
  const body = JSON.stringify(payload, null, 2).replace(/\r?\n/g, EOL);
  return [
    "// GENERATED FILE - do not edit by hand.",
    "// Source: CHANGELOG.md. Regenerate with: npm run changelog",
    "//",
    "// The What's new page inside the extension reads this. It is baked in",
    "// at author time rather than fetched, because a fetch of any kind,",
    "// even of a file inside the package, would end the extension's",
    "// no-network-calls promise.",
    "//",
    `// Carries the newest ${entries.length} of ${total} releases; the page says so`,
    "// and links the full log on GitHub.",
    "",
    "// eslint-disable-next-line no-unused-vars",
    `var GCC_CHANGELOG = ${body};`,
    "",
    "if (typeof module !== \"undefined\" && module.exports) module.exports = GCC_CHANGELOG;",
    ""
    // 8.20: EOL, not a hardcoded "\r\n". The comment above this function
    // says the writer follows the host, and the JSON body already did,
    // but these wrapper lines were joined with CRLF whatever the host
    // was. Regenerate on Linux or macOS and the file came out with 15
    // CRLF lines wrapped around 1,606 LF ones, which is a mixed-ending
    // file in the shipped bundle and a diff nobody can read.
  ].join(EOL);
}

function main() {
  const markdown = fs.readFileSync(SOURCE, "utf-8");
  const all = parseChangelog(markdown);
  if (!all.length) {
    console.error("No version headings found in CHANGELOG.md");
    process.exit(1);
  }
  const kept = all.slice(0, KEEP).map(tidy);
  const output = render(kept, all.length);

  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf-8") : "";
    if (!sameContent(current, output)) {
      console.error("changelog-data.js is out of date. Run: npm run changelog");
      process.exit(1);
    }
    console.log(`changelog-data.js is current (${kept.length} of ${all.length} releases).`);
    return;
  }

  fs.writeFileSync(OUTPUT, output);
  console.log(`Wrote changelog-data.js: ${kept.length} of ${all.length} releases, ` +
    `${(Buffer.byteLength(output) / 1024).toFixed(1)} KB`);
}

main();
