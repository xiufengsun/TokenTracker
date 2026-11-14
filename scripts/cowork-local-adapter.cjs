#!/usr/bin/env node
"use strict";

// Usage-only bridge for Claude Desktop's Cowork ledger. No app-bundle patch.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const ENTRYPOINT = "tokentracker-cowork-ledger-v1";
const COUNTERS = {
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_input_tokens",
  cacheWriteTokens: "cache_creation_input_tokens",
};
/** Hash stable record identities without storing the original session ID. */
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** List directory entries; an absent optional source directory is empty. */
async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** Discover daily NDJSON ledgers within the supported account/profile layout. */
async function ledgerFiles(roots) {
  const files = new Set();
  /** Walk only bounded non-hidden directories, collecting usage-ledger files. */
  async function walk(dir, depth) {
    if (depth > 4) return;
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "skills-plugin") continue;
      const next = path.join(dir, entry.name);
      if (entry.name === "usage-ledger") {
        for (const file of await entries(next)) {
          if (file.isFile() && /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(file.name))
            files.add(path.join(next, file.name));
        }
      } else await walk(next, depth + 1);
    }
  }
  for (const root of roots) await walk(root, 0);
  return [...files].sort();
}

/** Convert one supported turn into usage-only Claude records, one per model. */
function normalizeLedgerRecord(row) {
  if (row?.v !== 1 || row.surface !== "cowork" || row.origin !== "turn" ||
      typeof row.sessionId !== "string" || !row.sessionId ||
      !Number.isSafeInteger(row.ts) || row.ts < 0 || !Number.isFinite(new Date(row.ts).getTime()) ||
      !row.models || typeof row.models !== "object" || Array.isArray(row.models)) return [];
  const result = [];
  const sessionId = hash([ENTRYPOINT, row.sessionId]);
  for (const [model, value] of Object.entries(row.models)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) continue;
    const usage = {};
    let valid = true;
    for (const [from, to] of Object.entries(COUNTERS)) {
      if (!Number.isSafeInteger(value?.[from]) || value[from] < 0) { valid = false; break; }
      usage[to] = value[from];
    }
    const total = Object.values(usage).reduce((a, b) => a + b, 0);
    if (!valid || !Number.isSafeInteger(total) || total === 0) continue;
    // No profile/path in the key: migrated copies of one ledger count once.
    const id = `cowork-v1-${hash([row.sessionId, row.ts, row.origin, model])}`;
    result.push({
      type: "assistant", uuid: id, sessionId, entrypoint: ENTRYPOINT,
      timestamp: new Date(row.ts).toISOString(),
      message: { id, role: "assistant", model, content: [], usage },
    });
  }
  return result;
}

/** Recover dedup identities and unterminated tails from the append-only output. */
async function readJournal(outputDir) {
  const known = new Map();
  const separators = new Set();
  for (const file of await entries(outputDir)) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.jsonl$/.test(file.name)) continue;
    const filePath = path.join(outputDir, file.name);
    const raw = await fs.readFile(filePath, "utf8");
    if (raw && !raw.endsWith("\n")) separators.add(filePath);
    for (const line of raw.split("\n")) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.entrypoint !== ENTRYPOINT || !row.message?.id) continue;
      known.set(row.message.id, JSON.stringify(row));
    }
  }
  return { known, separators };
}

/**
 * Append previously unseen valid usage while preserving rebuildable history.
 * Callers must hold TokenTracker's sync lease before writing its scan roots.
 * The journal itself is the dedup index, avoiding a second cursor that can drift.
 */
async function importCoworkUsage({ roots, outputRoot }) {
  const outputDir = path.join(outputRoot, "projects", "cowork");
  const { known, separators } = await readJournal(outputDir);
  const pending = new Map();
  let skipped = 0;
  const files = await ledgerFiles(roots);
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    // A non-LF-terminated tail may still be being written by Claude.
    const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { skipped++; continue; }
      const records = normalizeLedgerRecord(row);
      if (!records.length) skipped++;
      for (const record of records) {
        const id = record.message.id;
        const serialized = JSON.stringify(record);
        const prior = known.get(id) || pending.get(id)?.serialized;
        if (prior && prior !== serialized) throw new Error(`Conflicting Cowork usage record: ${id}`);
        if (!prior) pending.set(id, { record, serialized });
      }
    }
  }
  // Validate the entire batch before publication, so a conflicting copy
  // never leaves a half-imported ledger behind.
  const byFile = new Map();
  for (const { record, serialized } of pending.values()) {
    const file = path.join(outputDir, `${record.sessionId}.jsonl`);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(serialized);
  }
  if (byFile.size) await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  for (const [file, lines] of byFile) {
    const handle = await fs.open(file, "a", 0o600);
    try {
      // A crash may leave a partial record. Isolate that fragment with LF;
      // never truncate bytes a native parser cursor may have already passed.
      await handle.writeFile((separators.has(file) ? "\n" : "") + lines.join("\n") + "\n");
      await handle.sync();
    } finally { await handle.close(); }
  }
  return { imported: pending.size, known: known.size + pending.size, ledgers: files.length, skipped };
}

/** Locate the adjacent checkout first, then known installed CLI runtimes. */
function installedPackage(home) {
  const candidates = [
    path.resolve(__dirname, ".."),
    "/Applications/TokenTracker.app/Contents/Resources/EmbeddedServer/tokentracker",
    path.join(home, ".tokentracker", "tracker", "app"),
  ];
  for (const root of candidates) {
    try { require.resolve(path.join(root, "src", "commands", "sync.js")); return root; }
    catch { /* Try the next checkout or installed runtime. */ }
  }
  throw new Error("TokenTracker runtime not found");
}

/** Serialize bridge invocations across publication and the subsequent refresh. */
async function runAdapter(options = {}) {
  const home = options.home || os.homedir();
  const trackerPackage = options.trackerPackage || installedPackage(home);
  const { openLock } = require(path.join(trackerPackage, "src", "lib", "fs.js"));
  const dir = path.join(home, ".tokentracker", "cowork-adapter");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Serialize bridge instances across publication AND the follow-up sync.
  const lock = await openLock(path.join(dir, "run.lock"), { quietIfLocked: true });
  if (!lock) return { busy: true, imported: 0 };
  try { return await runAdapterLocked({ ...options, home, trackerPackage }); }
  finally { await lock.release(); }
}

/**
 * Register the scan root, publish usage under the native lease, then sync locally.
 * The caller holds the bridge lease. Keep the pending marker until sync succeeds.
 */
async function runAdapterLocked({ home, trackerPackage, refresh = true }) {
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  const adapterDir = path.join(home, ".tokentracker", "cowork-adapter");
  const outputRoot = path.join(adapterDir, "claude");
  const pendingPath = path.join(adapterDir, "refresh-pending.json");
  const { openLock, writeFileAtomic, updateJsonLocked } = require(path.join(trackerPackage, "src", "lib", "fs.js"));
  await fs.mkdir(trackerDir, { recursive: true, mode: 0o700 });
  const lock = await openLock(path.join(trackerDir, "sync.lock"), { quietIfLocked: true });
  if (!lock) return { busy: true, imported: 0 };
  let result;
  let needsRefresh = false;
  try {
    const configPath = path.join(trackerDir, "config.json");
    let config;
    try { config = JSON.parse(await fs.readFile(configPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; config = {}; }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid TokenTracker config");
    const configured = config.scanRoots?.claude;
    if (configured != null && typeof configured !== "string" && !Array.isArray(configured))
      throw new Error("Invalid Claude scan roots");
    const roots = configured == null ? [] : typeof configured === "string" ? [configured] : [...configured];
    const registered = roots.includes(outputRoot);
    await fs.mkdir(path.join(outputRoot, "projects"), { recursive: true, mode: 0o700 });
    if (!registered) {
      await updateJsonLocked(configPath, async () => {
        // Fresh read inside the standard config lease preserves concurrent
        // settings changes; malformed JSON must never be replaced with {}.
        let current;
        try { current = JSON.parse(await fs.readFile(configPath, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; current = {}; }
        if (!current || typeof current !== "object" || Array.isArray(current))
          throw new Error("Invalid TokenTracker config");
        const value = current.scanRoots?.claude;
        if (value != null && typeof value !== "string" && !Array.isArray(value))
          throw new Error("Invalid Claude scan roots");
        const freshRoots = value == null ? [] : typeof value === "string" ? [value] : [...value];
        if (!freshRoots.includes(outputRoot)) freshRoots.push(outputRoot);
        return { ...current, scanRoots: { ...current.scanRoots, claude: freshRoots } };
      });
    }
    let wasPending = false;
    try { await fs.access(pendingPath); wasPending = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    // Set before publication, so a crash between append and sync retries it.
    await writeFileAtomic(pendingPath, "{}\n", { mode: 0o600 });
    result = await importCoworkUsage({
      roots: ["Claude", "Claude-3p"].map((name) =>
        path.join(home, "Library", "Application Support", name, "local-agent-mode-sessions")),
      outputRoot,
    });
    needsRefresh = wasPending || !registered || result.imported > 0;
    if (!needsRefresh) await fs.unlink(pendingPath);
  } finally { await lock.release(); }

  if (refresh && needsRefresh) {
    const { cmdSync } = require(path.join(trackerPackage, "src", "commands", "sync.js"));
    const key = "TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN";
    const before = process.env[key];
    process.env[key] = ""; // Explicit local-only denial; preserve cloud prefs.
    try {
      await cmdSync(["--auto", "--from-notify", "--source", "claude", "--wait-for-lock"], {
        home, trackerDataDir: trackerDir, scanSources: ["claude"],
        failOnClaudeParseFailure: true,
      });
      await fs.rm(pendingPath, { force: true });
    } finally {
      if (before === undefined) delete process.env[key]; else process.env[key] = before;
    }
  }
  return { ...result, refreshed: refresh && needsRefresh };
}

module.exports = { normalizeLedgerRecord, ledgerFiles, importCoworkUsage, runAdapter };
if (require.main === module) {
  runAdapter().then((result) => {
    if (result.imported || result.refreshed) console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
  }).catch((error) => {
    console.error(`Cowork adapter: ${error.message}`);
    process.exitCode = 1;
  });
}
