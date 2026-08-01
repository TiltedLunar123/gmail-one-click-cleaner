#!/usr/bin/env node
// build.js: Build script for Gmail One-Click Cleaner
// Copies files into a per-browser dist directory, optionally minifies
// JS, and creates store-ready zips.
//
// Targets:
//   node build.js                     -> Chrome/Edge build in dist/
//   node build.js --target=firefox    -> Firefox build in dist-firefox/
//   node build.js --target=all        -> both
//
// Chrome and Edge share one artifact (Edge is Chromium and the Edge
// Add-ons store accepts the same zip). Firefox needs a different
// manifest: event-page background instead of a service worker, a gecko
// add-on ID, and options_ui instead of options_page.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SRC = __dirname;

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

const DIRS = ["icons", "_locales"];

// Firefox MV3 requires a stable add-on ID (AMO refuses unsigned/ID-less
// submissions) and uses event pages: background.scripts, not
// background.service_worker. Functionally the extension only needs
// Firefox 127 (storage.session, promises in the chrome.* namespace,
// install-time host permission grants), but the mandatory
// data_collection_permissions manifest key only exists from 140, so
// that is the floor.
const GECKO_ID = "gmail-one-click-cleaner@gmail-cleaner-pro.netlify.app";
const GECKO_STRICT_MIN_VERSION = "140.0";

function firefoxManifest(chromeManifest) {
  const m = JSON.parse(JSON.stringify(chromeManifest));

  delete m.minimum_chrome_version;

  // AMO caps the name at 45 characters (the Chrome listing name is 50).
  m.name = "Gmail One-Click Cleaner - Bulk Delete Emails";

  m.background = {
    scripts: ["browser-polyfill.js", "background.js"]
  };

  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_STRICT_MIN_VERSION,
      // Mandatory declaration for new AMO submissions. "none" is the
      // truth: everything runs locally, no telemetry, license keys are
      // verified offline against an embedded public key.
      data_collection_permissions: {
        required: ["none"]
      }
    },
    // Android needs 142+ for data_collection_permissions. The extension
    // targets Gmail's desktop web UI, so Android is a curiosity at
    // best; Android availability can be switched off in AMO settings.
    gecko_android: {
      strict_min_version: "142.0"
    }
  };

  // Firefox ignores options_page; options_ui is the supported key.
  delete m.options_page;
  m.options_ui = {
    page: "options.html",
    open_in_tab: true
  };

  return m;
}

// =========================
// Stable identity for the unpacked build (8.6)
// =========================
// Chrome derives an unpacked extension's ID from the FOLDER PATH when
// the manifest carries no `key`. chrome.storage of both kinds is scoped
// to that ID, so unzipping each new release beside the last one made
// every update a fresh install with empty storage, and the Pro key
// appeared to be forgotten on every upgrade. It was not forgotten; it
// belonged to a different extension.
//
// This public key pins the ID instead, so every unpacked build is the
// same extension and keeps its storage. Public by definition: it fixes
// an identity, it does not authorise anything.
//
// It is written into dist/ AFTER the zip is sealed, so the store
// package never carries it. The Web Store assigns its own identity and
// a `key` in an uploaded package is at best redundant.
const UNPACKED_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAklN3dX4FUcmq41xZpY6XJ39qvjI2WCeqsUENqlGEHbDoPyawVi1QICH7giCS3RPhNUQgP4vgKJyFzvYftPD9EBJGMRJzcN+SvzGKq8oMZbKu2RWTQhUhVK8HfEbdek1JVCmzczpfdi2/KQ5EABiAu++wsdBJwRajEyx8nQSZbbzTBrfmiFLHJ6LiOCnbohjiBu2cN2o5rPKbSZH3lR1b2FFQE2SuQ37t5tT+ARANGHmgRJU5O/iLtqljolbIK4Xj/Ayr9962LIDcgXVjE7uS0pn3RnkXzKNshEnp4M6uPoBaTn+edJGXlf/aeMkQ8FPQCdBZ6PBqI22NM9pDBnKqNwIDAQAB";

function pinUnpackedIdentity(distDir) {
  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  manifest.key = UNPACKED_KEY;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("Pinned unpacked extension ID (dist only, not in the zip)");
}

const TARGETS = {
  chrome: {
    dist: process.env.GCC_DIST
      ? path.resolve(process.env.GCC_DIST)
      : path.join(SRC, "dist"),
    zipName: "gmail-one-click-cleaner.zip",
    transformManifest: (m) => m
  },
  firefox: {
    dist: process.env.GCC_DIST_FIREFOX
      ? path.resolve(process.env.GCC_DIST_FIREFOX)
      : path.join(SRC, "dist-firefox"),
    zipName: "gmail-one-click-cleaner-firefox.zip",
    transformManifest: firefoxManifest
  }
};

function buildTarget(name, { shouldMinify, shouldZip }) {
  const target = TARGETS[name];
  if (!target) throw new Error(`Unknown build target: ${name}`);
  const DIST = target.dist;

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

    if (file === "manifest.json") {
      const manifest = JSON.parse(fs.readFileSync(src, "utf-8"));
      const transformed = target.transformManifest(manifest);
      fs.writeFileSync(dest, JSON.stringify(transformed, null, 2) + "\n");
      console.log("Wrote: manifest.json (" + name + ")");
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

    // SVG sources stay in the repo for future icon edits but have no
    // business in the shipped extension; the browsers only load PNGs.
    fs.cpSync(srcDir, destDir, {
      recursive: true,
      filter: (src) => !src.endsWith(".svg")
    });
    console.log("Copied: " + dir + "/");
  }

  console.log("\n" + name + " build complete in " + DIST);

  if (shouldZip) {
    createZip(DIST, path.join(SRC, target.zipName));
  }

  // After the zip, never before: the store package must not carry it.
  // Firefox already pins its identity through browser_specific_settings,
  // so this is a Chrome-only problem and a Chrome-only fix.
  if (name === "chrome") {
    pinUnpackedIdentity(DIST);
  }
}

function createZip(distDir, zipPath) {
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
        `'${distDir.replace(/\\/g, "\\\\")}','${zipPath.replace(/\\/g, "\\\\")}',` +
        `[System.IO.Compression.CompressionLevel]::Optimal,$false)`
      ], { stdio: "inherit" });
    } else {
      execFileSync("zip", ["-r", zipPath, "."], { cwd: distDir, stdio: "inherit" });
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

function main() {
  const args = process.argv.slice(2);
  const shouldMinify = args.includes("--minify");
  const shouldZip = args.includes("--zip");

  const targetArg = (args.find((a) => a.startsWith("--target=")) || "--target=chrome")
    .split("=")[1];
  const targets = targetArg === "all" ? ["chrome", "firefox"] : [targetArg];

  for (const t of targets) {
    buildTarget(t, { shouldMinify, shouldZip });
  }
}

if (require.main === module) {
  main();
}

module.exports = { firefoxManifest, FILES, TARGETS, GECKO_ID };
