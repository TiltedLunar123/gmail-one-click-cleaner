#!/usr/bin/env node
// build.js — Simple build script for Gmail One-Click Cleaner
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

  try {
    if (process.platform === "win32") {
      execFileSync("powershell", [
        "-Command",
        "Compress-Archive",
        "-Path", DIST + "/*",
        "-DestinationPath", zipPath,
        "-Force"
      ], { stdio: "inherit" });
    } else {
      execFileSync("zip", ["-r", zipPath, "."], { cwd: DIST, stdio: "inherit" });
    }
    console.log("\nZip created: " + zipPath);
  } catch (e) {
    console.error("Failed to create zip:", e.message);
  }
}
