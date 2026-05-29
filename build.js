#!/usr/bin/env node
// build.js: Simple build script for Gmail One-Click Cleaner
// Copies files to dist/, optionally minifies JS, and creates a .zip

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const shouldMinify = args.includes("--minify");
const shouldZip = args.includes("--zip");

const SRC = __dirname;
const DIST = path.join(SRC, "dist");

// Files to include in the build
const FILES = [
  "manifest.json",
  "browser-polyfill.js",
  "shared.css",
  "shared.js",
  "background.js",
  "popup.html",
  "popup.js",
  "contentScript.js",
  "progress.html",
  "progress.js",
  "options.html",
  "options.js",
  "diagnostics.html",
  "diagnostics.js",
  "stats.html",
  "stats.js"
];

const DIRS = ["icons"];

// Clean dist
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });

// Copy files
for (const file of FILES) {
  const src = path.join(SRC, file);
  const dest = path.join(DIST, file);

  if (!fs.existsSync(src)) {
    console.warn("Warning: " + file + " not found, skipping");
    continue;
  }

  if (shouldMinify && file.endsWith(".js") && file !== "browser-polyfill.js") {
    try {
      const esbuild = require("esbuild");
      const result = esbuild.buildSync({
        entryPoints: [src],
        bundle: false,
        minify: true,
        write: false,
        target: "chrome110"
      });
      fs.writeFileSync(dest, result.outputFiles[0].text);
      console.log("Minified: " + file);
    } catch {
      // Fallback: just copy
      fs.copyFileSync(src, dest);
      console.log("Copied (no minify): " + file);
    }
  } else {
    fs.copyFileSync(src, dest);
    console.log("Copied: " + file);
  }
}

// Copy directories
for (const dir of DIRS) {
  const srcDir = path.join(SRC, dir);
  const destDir = path.join(DIST, dir);

  if (!fs.existsSync(srcDir)) {
    console.warn("Warning: " + dir + "/ not found, skipping");
    continue;
  }

  fs.cpSync(srcDir, destDir, { recursive: true });
  console.log("Copied: " + dir + "/");
}

console.log("\nBuild complete in " + DIST);

// Create zip if requested
if (shouldZip) {
  const zipName = "gmail-one-click-cleaner.zip";
  const zipPath = path.join(SRC, zipName);

  // Delete any existing zip so the writer doesn't append.
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

  try {
    if (process.platform === "win32") {
      // PowerShell's Compress-Archive emits backslash path separators
      // inside the zip, which Chrome Web Store flat-out rejects. Use
      // .NET's ZipFile.CreateFromDirectory directly; it follows the
      // zip spec (forward slashes only).
      execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `[System.IO.Compression.ZipFile]::CreateFromDirectory(` +
        `'${DIST.replace(/\\/g, "\\\\")}','${zipPath.replace(/\\/g, "\\\\")}',` +
        `[System.IO.Compression.CompressionLevel]::Optimal,$false)`
      ], { stdio: "inherit" });
    } else {
      execFileSync("zip", ["-r", zipPath, "."], { cwd: DIST, stdio: "inherit" });
    }
    console.log("\nZip created: " + zipPath);
    normalizeZipPathSeparators(zipPath);
  } catch (e) {
    console.error("Failed to create zip:", e.message);
  }
}

// PowerShell / .NET on Windows store sub-directory entries with
// backslash separators; Chrome Web Store rejects those and `unzip`
// warns. The fix is in-place: we read the central directory + local
// file headers, locate every filename byte range, and replace 0x5C
// with 0x2F. Filename lengths never change so offsets stay valid.
function normalizeZipPathSeparators(zipPath) {
  let buf = fs.readFileSync(zipPath);
  let touched = 0;

  // End of central directory record (EOCD) signature: PK\x05\x06
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdOffset = buf.lastIndexOf(eocdSig);
  if (eocdOffset < 0) return;

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdCount = buf.readUInt16LE(eocdOffset + 10);

  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOff = buf.readUInt32LE(p + 42);

    // Rewrite name bytes in central directory entry.
    for (let j = 0; j < nameLen; j++) {
      if (buf[p + 46 + j] === 0x5C) { buf[p + 46 + j] = 0x2F; touched++; }
    }

    // Rewrite name bytes in matching local file header.
    // Local header layout: signature(4)+version(2)+flags(2)+method(2)+
    //   time(2)+date(2)+crc32(4)+csize(4)+usize(4)+nameLen(2)+extraLen(2)+name+extra
    if (buf.readUInt32LE(localHeaderOff) === 0x04034b50) {
      const lhNameLen = buf.readUInt16LE(localHeaderOff + 26);
      for (let j = 0; j < lhNameLen; j++) {
        if (buf[localHeaderOff + 30 + j] === 0x5C) {
          buf[localHeaderOff + 30 + j] = 0x2F;
          touched++;
        }
      }
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  if (touched > 0) {
    fs.writeFileSync(zipPath, buf);
    console.log(`Normalized ${touched} path separator(s) (\\ -> /) in zip`);
  }
}
