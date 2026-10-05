#!/usr/bin/env node
"use strict";

// Removes dependency files the embedded desktop runtime never loads. Every
// bundle step (macOS, Windows, Linux) runs this after `npm ci --omit=dev`.
//   node scripts/trim-embedded-deps.cjs <path/to/node_modules>

const fs = require("node:fs");
const path = require("node:path");

// src/lib/trae-sqlite.js imports the synchronous build, the package entry
// (sqlite-api.js) and FacadeVFS.js; those two import VFS.js and
// sqlite-constants.js. Nothing else in the package is loaded at runtime.
const KEEP = {
  "@journeyapps/wa-sqlite": [
    "package.json",
    "LICENSE",
    "dist/wa-sqlite.mjs",
    "dist/wa-sqlite.wasm",
    "src/sqlite-api.js",
    "src/sqlite-constants.js",
    "src/VFS.js",
    "src/FacadeVFS.js",
  ],
};
const OPTIONAL = new Set(["LICENSE"]);

function listFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), relative) : [relative];
  });
}

function removeEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function trimEmbeddedDeps(nodeModules) {
  let removedBytes = 0;
  for (const [name, keep] of Object.entries(KEEP)) {
    const root = path.join(nodeModules, ...name.split("/"));
    // Installing packages is npm's job; only trim what it installed.
    if (!fs.existsSync(root)) continue;
    // Fail the build: a missing file would otherwise fail only at runtime.
    const missing = keep.filter((file) => !OPTIONAL.has(file) && !fs.existsSync(path.join(root, file)));
    if (missing.length) throw new Error(`${name} is missing ${missing.join(", ")}; update KEEP in ${__filename}`);
    const kept = new Set(keep);
    for (const file of listFiles(root)) {
      if (kept.has(file)) continue;
      const target = path.join(root, file);
      removedBytes += fs.statSync(target).size;
      fs.rmSync(target);
    }
    removeEmptyDirs(root);
  }
  return removedBytes;
}

if (require.main === module) {
  const nodeModules = process.argv[2];
  if (!nodeModules) {
    console.error("usage: node scripts/trim-embedded-deps.cjs <node_modules>");
    process.exit(2);
  }
  const removed = trimEmbeddedDeps(path.resolve(nodeModules));
  console.log(`Trimmed ${(removed / 1024 / 1024).toFixed(1)} MB of unused dependency files`);
}

module.exports = { KEEP, trimEmbeddedDeps };
