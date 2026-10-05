"use strict";

// Persistent extra scan roots for Codex and Claude Code (#657).
//
// Agent harnesses run Codex / Claude Code with a private home
// (CODEX_HOME=..., CLAUDE_CONFIG_DIR=...). Those sessions were invisible to
// TokenTracker unless the sync happened to be spawned by a process that
// inherited the same environment: a hook-fired sync saw them, the native app's
// background refresh did not. Worse, the two producers then disagreed about
// where a rollout's cursor lives (the cursor store classifies a rollout as a
// Codex path — per-day shard — only when it sits under one of ITS codexRoots,
// everything else goes to core), never saw each other's cursor, and re-parsed
// the same file from byte 0 on every alternation (#639: one 30-minute bucket
// re-emitted 138 times, 59B tokens for a 1.2B day).
//
// So roots come from ONE persistent list that every producer reads, and the
// cursor store's codexRoots are derived from that same list.
//
// Per provider, in order (first occurrence wins; later duplicates by realpath
// are dropped):
//   1. the roots the caller already scans (native home, WSL install)
//   2. the spawning process's implicit root — CODEX_HOME / CLAUDE_CONFIG_DIR
//   3. config.scanRoots.<provider>[] from ~/.tokentracker/tracker/config.json
//
// Config shape:
//   { "scanRoots": { "codex": ["~/.local/share/agent/codex"],
//                    "claude": ["~/.local/share/agent/claude", "~/.claude-native"] } }

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readJson } = require("./fs");
const { resolveTrackerPaths } = require("./tracker-paths");

const PROVIDERS = Object.freeze({
  codex: Object.freeze({ envVar: "CODEX_HOME" }),
  claude: Object.freeze({ envVar: "CLAUDE_CONFIG_DIR" }),
});
const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

// Turn a configured root into a stable absolute path. `~` expands against
// `home`, and a RELATIVE entry is resolved against `home` too — never against
// process.cwd(), which differs between a hook-fired sync, the CLI and the
// desktop app and would make producers scan different directories.
function expandHome(value, home) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return path.resolve(home);
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(home, trimmed.slice(2));
  }
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(home, trimmed);
}

// The spawning process's implicit root — CODEX_HOME / CLAUDE_CONFIG_DIR —
// normalized ONCE, the same way configured entries are: `~` and relative
// values are anchored to `home`, never to process.cwd(). Every producer
// (sync discovery, the cursor store's codexRoots, status, diagnostics, the
// session browser) must use this value, or a relative CODEX_HOME such as
// `profiles/codex` is scanned under one directory and cursor-classified
// under another, and the same rollout replays. Returns null when unset.
function resolveEnvRoot(provider, { env = process.env, home = os.homedir() } = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) return null;
  const raw = env && typeof env[spec.envVar] === "string" ? env[spec.envVar] : "";
  return expandHome(raw, home);
}

// Accepts { codex: string | string[], claude: string | string[] }. Anything
// else — wrong type, empty strings, unknown providers — is ignored rather than
// failing the sync: a malformed config must not stop collection.
function normalizeScanRootsConfig(raw) {
  const out = {};
  for (const provider of PROVIDER_NAMES) out[provider] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const provider of PROVIDER_NAMES) {
    const value = raw[provider];
    const list = Array.isArray(value) ? value : (typeof value === "string" ? [value] : []);
    for (const entry of list) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      out[provider].push(entry.trim());
    }
  }
  return out;
}

// { exists, error }: `exists` is true only for a directory that can be
// LISTED, not merely stat'ed — a stat-able directory whose listing fails
// (mode 000, ACL) would otherwise be admitted to the scan, yield no files,
// read as "present" in status/doctor, and slip past the deferred-repair
// guard in sync. ENOENT and ENOTDIR (or a regular file in a directory's
// place) mean the root is absent (error null); any other failure (EACCES,
// ELOOP, EIO, ...) is reported as `error` so callers can say "unreadable"
// instead of "missing".
function scanRootDirState(target, deps = {}) {
  const statSync = deps.statSync || fs.statSync;
  const opendirSync = deps.opendirSync || fs.opendirSync;
  try {
    if (!statSync(target).isDirectory()) return { exists: false, error: null };
    // Probe listability without reading entries; large roots stay cheap.
    opendirSync(target).closeSync();
    return { exists: true, error: null };
  } catch (e) {
    const code = e && typeof e.code === "string" ? e.code : "EUNKNOWN";
    if (code === "ENOENT" || code === "ENOTDIR") return { exists: false, error: null };
    return { exists: false, error: code };
  }
}

function isDirectorySync(target, deps) {
  return scanRootDirState(target, deps).exists;
}

function realpathOrSelf(target, deps) {
  const realpathSync = deps.realpathSync || fs.realpathSync;
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function identityKey(target, deps) {
  const resolved = path.resolve(target);
  const real = realpathOrSelf(resolved, deps);
  return real.replace(/\\/g, "/").replace(/\/+$/, "");
}

// Drop later entries that resolve (realpath) to a directory already listed.
// Used at the projects/ level too: two Claude profiles may symlink one
// projects/ dir, and reading it under both spellings would double-parse every
// file, leaving correctness to the bounded claudeHashes layer.
function dedupeDirsByRealpath(dirs, deps = {}) {
  const seen = new Set();
  const out = [];
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    if (typeof dir !== "string" || !dir) continue;
    const key = identityKey(dir, deps);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

// Resolve the full, ordered, deduplicated root list per provider.
//
//   base: { codex: string[], claude: string[] } — roots the caller scans
//         anyway (native home, WSL install); they keep their position and
//         are labelled origin "native".
//   env:  CODEX_HOME / CLAUDE_CONFIG_DIR become origin "env" unless already
//         covered by base.
//   config.scanRoots.<provider>[] become origin "config".
//
// Every entry: { path, realPath, exists, error, origin }. `exists` is a
// readable-directory check and `error` carries a stat error code other than
// absence (see scanRootDirState); non-existent or unreadable configured roots
// are kept in the list (so cursor-path classification stays stable while a
// volume is unmounted) and callers that walk directories skip them via
// `exists`.
function resolveScanRoots({
  home = os.homedir(),
  env = process.env,
  config = null,
  base = {},
  deps = {},
} = {}) {
  const configured = normalizeScanRootsConfig(config && typeof config === "object" ? config.scanRoots : null);
  const out = {};
  for (const provider of PROVIDER_NAMES) {
    const candidates = [];
    for (const root of Array.isArray(base[provider]) ? base[provider] : []) {
      if (typeof root === "string" && root.trim()) candidates.push({ raw: root, origin: "native" });
    }
    const envRoot = resolveEnvRoot(provider, { env, home });
    if (envRoot) candidates.push({ raw: envRoot, origin: "env" });
    for (const root of configured[provider]) candidates.push({ raw: root, origin: "config" });

    const seen = new Set();
    const entries = [];
    for (const candidate of candidates) {
      const expanded = expandHome(candidate.raw, home);
      if (!expanded) continue;
      const resolved = expanded;
      const key = identityKey(resolved, deps);
      if (seen.has(key)) continue;
      seen.add(key);
      const state = scanRootDirState(resolved, deps);
      entries.push({
        path: resolved,
        realPath: realpathOrSelf(resolved, deps),
        exists: state.exists,
        error: state.error,
        origin: candidate.origin,
      });
    }
    out[provider] = entries;
  }
  return out;
}

// Append `extraDirs` to `baseDirs`, dropping any extra that resolves (realpath)
// to a directory already present. Base entries are never collapsed against
// each other: the native + WSL pair is listed on purpose (see sync.js) and
// their dedup is handled downstream by file-identity hashes.
function appendUniqueDirs(baseDirs, extraDirs, deps = {}) {
  const out = [];
  const seen = new Set();
  for (const dir of Array.isArray(baseDirs) ? baseDirs : []) {
    if (typeof dir !== "string" || !dir) continue;
    seen.add(identityKey(dir, deps));
    out.push(dir);
  }
  for (const dir of Array.isArray(extraDirs) ? extraDirs : []) {
    if (typeof dir !== "string" || !dir) continue;
    const key = identityKey(dir, deps);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

// Roots beyond what the caller already scans: the "env" and "config" entries
// that exist on disk. Paths only, in list order.
function extraScanRootPaths(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.origin !== "native" && entry.exists)
    .map((entry) => entry.path);
}

function hasAnyScanChild(root, children, deps = {}) {
  for (const child of Array.isArray(children) ? children : [children]) {
    if (isDirectorySync(path.join(root, child), deps)) return true;
  }
  return false;
}

// Human label for status / doctor output.
function describeScanRootOrigin(entry, provider) {
  if (!entry || entry.origin === "native") return "native";
  if (entry.origin === "env") return PROVIDERS[provider]?.envVar || "env";
  return "scanRoots";
}

// "" for a readable root, " (missing)" for an absent one, " (unreadable: CODE)"
// for a stat failure other than absence.
function describeScanRootState(entry) {
  if (!entry || entry.exists) return "";
  return entry.error ? ` (unreadable: ${entry.error})` : " (missing)";
}

// config.scanRoots as persisted in ~/.tokentracker/tracker/config.json for
// callers that do not already hold the config (the session browser).
async function loadScanRootsConfig({ home = os.homedir() } = {}) {
  const { trackerDir } = await resolveTrackerPaths({ home });
  const config = await readJson(path.join(trackerDir, "config.json")).catch(() => null);
  return normalizeScanRootsConfig(config && typeof config === "object" ? config.scanRoots : null);
}

module.exports = {
  PROVIDER_NAMES,
  appendUniqueDirs,
  dedupeDirsByRealpath,
  describeScanRootOrigin,
  describeScanRootState,
  expandHome,
  extraScanRootPaths,
  hasAnyScanChild,
  loadScanRootsConfig,
  normalizeScanRootsConfig,
  resolveEnvRoot,
  resolveScanRoots,
  scanRootDirState,
};
