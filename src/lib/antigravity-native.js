"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { readSqliteJsonRowsAsync } = require("./sqlite-reader");
const wsl = require("./wsl-probe");
const { findAntigravityProtoFields: fields, extractAntigravityGenInfo } = require("./antigravity-usage");

function field(buffer, number) {
  if (!Buffer.isBuffer(buffer)) return null;
  return fields(buffer).find((entry) => entry.num === number)?.val ?? null;
}

function timestamp(buffer) {
  const seconds = field(buffer, 1);
  const nanos = field(buffer, 2) || 0;
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(nanos)) return null;
  const ms = seconds * 1000 + Math.floor(nanos / 1e6);
  return ms >= Date.UTC(2020, 0, 1) && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}

function blob(hex) {
  if (typeof hex !== "string" || !/^X'[0-9a-f]*'$/i.test(hex)) throw new Error("Invalid Antigravity metadata blob");
  return Buffer.from(hex.slice(2, -1), "hex");
}

// One SELECT gives all tables the same SQLite read snapshot, including WAL.
// Only metadata blobs are selected: never step_payload, request or response text.
async function readAntigravityNativeSession(dbPath) {
  const snapshot = wsl.isUncPath(dbPath) ? wsl.snapshotSqliteDb(dbPath) : null;
  try {
    return await readAntigravityNativeSnapshot(snapshot?.path || dbPath, dbPath);
  } finally {
    if (snapshot) snapshot.cleanup();
  }
}

async function readAntigravityNativeSnapshot(dbPath, originalPath) {
  if (!fs.existsSync(dbPath)) throw new Error("Antigravity conversation database disappeared");
  const options = { readOnly: true, throwOnReadFailure: true, timeout: 15_000, maxBuffer: 64 * 1024 * 1024, label: "Antigravity" };
  const tables = new Set((await readSqliteJsonRowsAsync(dbPath,
    "SELECT name FROM sqlite_master WHERE type='table'", options)).map((row) => row.name));
  if (!tables.has("gen_metadata")) throw new Error("Unsupported Antigravity conversation schema");
  const queries = ["SELECT 'generation' AS kind, idx, quote(data) AS hex FROM gen_metadata"];
  if (tables.has("steps")) queries.push("SELECT 'step' AS kind, idx, quote(metadata) AS hex FROM steps");
  if (tables.has("trajectory_metadata_blob")) queries.push("SELECT 'session' AS kind, 0 AS idx, quote(data) AS hex FROM trajectory_metadata_blob");
  const rows = await readSqliteJsonRowsAsync(dbPath, queries.join(" UNION ALL "), options);
  const steps = new Map();
  let createdAt = null, cwd = null;
  for (const row of rows) {
    if (row.kind === "generation" || row.hex === "NULL") continue;
    const buffer = blob(row.hex);
    if (row.kind === "step") {
      steps.set(row.idx, timestamp(field(buffer, 1)) || timestamp(field(buffer, 32)));
    } else {
      createdAt = timestamp(field(buffer, 2)) || createdAt;
      const workspace = field(field(buffer, 1), 1);
      if (Buffer.isBuffer(workspace)) {
        const uri = workspace.toString("utf8");
        if (uri.startsWith("file:")) {
          try {
            const url = new URL(uri);
            const pathname = decodeURIComponent(url.pathname);
            // The source path, not the local snapshot path, identifies the
            // distro. Windows fileURLToPath rejects normal POSIX file URLs.
            const posixWorkspace = wsl.wslUncRoot(originalPath) && !url.hostname
              && !/^\/[A-Za-z]:[\\/]/.test(pathname) && !/%2f/i.test(url.pathname);
            cwd = posixWorkspace ? wsl.mapWslCwdToUnc(pathname, originalPath) : fileURLToPath(url);
          } catch { /* unsupported URI */ }
        }
      }
    }
  }
  const seen = new Set();
  const events = [];
  let timestampEstimated = false;
  for (const row of rows.filter((value) => value.kind === "generation").sort((a, b) => a.idx - b.idx)) {
    const buffer = blob(row.hex);
    const info = extractAntigravityGenInfo(buffer);
    if (!info) throw new Error("Unreadable Antigravity generation metadata");
    if (!info.hasUsageMetadata) continue;
    const identity = info.responseId || `generation:${row.idx}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const stepIndex = info.lastStepIndex == null ? row.idx : info.lastStepIndex + 1;
    const chat = field(buffer, 1);
    let at = timestamp(field(field(chat, 9), 4)) || steps.get(stepIndex);
    if (!at) {
      at = createdAt || fs.statSync(originalPath).mtime.toISOString();
      timestampEstimated = true;
    }
    events.push({ type: "PLANNER_RESPONSE", step_index: stepIndex, created_at: at, native_usage: info });
  }
  return { events, cwd, createdAt, timestampEstimated };
}

// The transcript and its native db are two representations of one cascade.
// Prefer the transcript when present; the hourly reader joins its steps to db
// usage. Also discover db-only CLI sessions, which never produce brain logs.
async function listAntigravityNativeFiles(root, transcripts = [], knownFiles = []) {
  const dir = path.join(root, "conversations");
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const ids = new Set(transcripts.map((file) => path.basename(path.dirname(path.dirname(path.dirname(file))))));
    return {
      files: entries.filter((entry) => entry.isFile() && entry.name.endsWith(".db") && !ids.has(path.basename(entry.name, ".db")))
        .map((entry) => path.join(dir, entry.name)).sort(),
      complete: true,
    };
  } catch (error) {
    const known = Array.from(knownFiles).some((file) => path.dirname(file) === dir);
    return { files: [], complete: error.code === "ENOENT" && !known };
  }
}

module.exports = { readAntigravityNativeSession, listAntigravityNativeFiles };
