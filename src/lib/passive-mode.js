/**
 * Passive-mode detection.
 *
 * Token Tracker normally collects token usage by installing SessionEnd hooks
 * into supported CLIs (Claude Code, Codex CLI, Gemini CLI, …). The hook
 * fires `notify.cjs` after each turn → sync runs immediately → data is
 * fresh within seconds.
 *
 * On environments where hook installation fails — WSL with read-only mount,
 * UNC paths on Windows, locked `settings.json`, sandboxed processes —
 * SessionEnd hooks never fire, but the underlying CLIs *still* write
 * session logs (`~/.claude/projects/`, `~/.gemini/sessions/`, etc.). Our
 * parsers can read those logs directly without the hook; the only loss is
 * "data is fresh within seconds" → it's now "data is fresh after the next
 * scheduled `tracker sync`".
 *
 * This module surfaces that fact: for each hook-driven provider, decide
 * whether the local install is in **passive mode** (no hook + log dir
 * present). `tracker status` reports it, and the dashboard can show a
 * single banner asking the user whether to acknowledge & continue in
 * passive mode or attempt re-install (`tracker init`).
 *
 * Detection is purely best-effort — we never *fail* sync because hooks are
 * missing; we just label the source so users / AI agents know latency is
 * minutes, not seconds.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {Object} PassiveProvider
 * @property {string} name              - canonical provider name
 * @property {boolean} hook_expected    - whether this provider supports hooks
 * @property {boolean} hook_installed   - true when the hook is set
 * @property {boolean} logs_present     - true when the provider's log dir
 *                                        exists and contains at least one
 *                                        session file we can parse
 * @property {boolean} passive          - true iff hook_expected &&
 *                                        !hook_installed && logs_present
 * @property {string|null} hook_failure_reason - if hook_expected and not
 *                                        installed, why we think it failed
 *                                        (e.g. "settings.json not writable",
 *                                        "config dir not found")
 */

function dirHasFile(dir, predicate) {
  if (!dir || !fs.existsSync(dir)) return false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Let the predicate accept either a file OR a directory name (so
    // "sessions" or "tmp" as a bare subdirectory still counts).
    if (!predicate || predicate(full, entry.name, entry.isDirectory())) return true;
    if (entry.isDirectory()) {
      // Shallow recurse — at most 1 level (covers projects/<name>/*.jsonl)
      if (dirHasFile(full, predicate)) return true;
    }
  }
  return false;
}

function classifyWritableFailure(filePath) {
  if (!filePath) return "no path";
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return "writable (hook may have been removed externally)";
  } catch (e) {
    if (e && e.code === "ENOENT") return "settings file missing";
    if (e && e.code === "EACCES") return "permission denied";
    if (e && e.code === "EROFS") return "read-only filesystem";
    return e?.code || "unknown";
  }
}

/**
 * Detect passive mode for each hook-driven provider.
 *
 * @param {Object} opts
 * @param {string} opts.home  - user home directory
 * @param {Object} opts.hookStatus - per-provider hook-installed booleans
 *   (already collected by status.js); shape: { claude, gemini, codex,
 *   every_code, opencode, openclaw, codebuddy, workbuddy, grok }
 * @returns {PassiveProvider[]}
 */
function detectPassiveProviders({ home, hookStatus, env = process.env }) {
  const out = [];

  // Claude Code — logs at ~/.claude/projects/<name>/*.jsonl
  out.push(buildEntry({
    name: "claude",
    hookExpected: true,
    hookInstalled: Boolean(hookStatus?.claude),
    logsDir: path.join(home, ".claude", "projects"),
    logsPredicate: (full) => full.endsWith(".jsonl"),
    settingsPath: path.join(home, ".claude", "settings.json"),
  }));

  // Gemini CLI — logs at ~/.gemini/tmp/<session-id>/logs.json
  // (path varies by version; presence of ~/.gemini/sessions or
  // ~/.gemini/tmp is enough to call it "active")
  out.push(buildEntry({
    name: "gemini",
    hookExpected: true,
    hookInstalled: Boolean(hookStatus?.gemini),
    logsDir: path.join(home, ".gemini"),
    logsPredicate: (_full, name, isDir) =>
      (isDir && (name === "tmp" || name === "sessions")) || name === "logs.json",
    settingsPath: path.join(home, ".gemini", "settings.json"),
  }));

  // Codex CLI — logs at ~/.codex/sessions/
  // Match either a "sessions" subdir (even if empty — the CLI created it)
  // or any *.jsonl session file.
  out.push(buildEntry({
    name: "codex",
    hookExpected: true,
    hookInstalled: Boolean(hookStatus?.codex_notify ?? hookStatus?.codex),
    logsDir: path.join(home, ".codex"),
    logsPredicate: (_full, name, isDir) =>
      (isDir && name === "sessions") || (!isDir && name.endsWith(".jsonl")),
    settingsPath: path.join(home, ".codex", "config.toml"),
  }));

  const acodeHome = env.TOKENTRACKER_ACODE_HOME || path.join(home, ".acode");
  out.push(buildEntry({
    name: "acode",
    hookExpected: true,
    hookInstalled: Boolean(hookStatus?.acode_notify ?? hookStatus?.acode),
    logsDir: acodeHome,
    logsPredicate: (_full, name, isDir) =>
      (isDir && (name === "sessions" || name === "archived_sessions")) ||
      (!isDir && name.endsWith(".jsonl")),
    settingsPath: path.join(acodeHome, "config.toml"),
  }));

  // Every Code — same shape as Codex, different home
  out.push(buildEntry({
    name: "every_code",
    hookExpected: true,
    hookInstalled: Boolean(hookStatus?.every_code_notify ?? hookStatus?.every_code),
    logsDir: path.join(home, ".code"),
    logsPredicate: (_full, name, isDir) =>
      (isDir && name === "sessions") || (!isDir && name.endsWith(".jsonl")),
    settingsPath: path.join(home, ".code", "config.toml"),
  }));

  // CodeBuddy — Claude-fork; hook in ~/.codebuddy/settings.json
  out.push(buildEntry({
    name: "codebuddy",
    hookExpected: true,
    hookInstalled: Boolean(hookStatus?.codebuddy),
    logsDir: path.join(home, ".codebuddy"),
    logsPredicate: (_full, name) => name === "projects" || name.endsWith(".jsonl"),
    settingsPath: path.join(home, ".codebuddy", "settings.json"),
  }));

  // WorkBuddy — sibling Claude-fork; hook in ~/.workbuddy/settings.json
  out.push(buildEntry({
    name: "workbuddy",
    hookExpected: true,
    hookInstalled: Boolean(hookStatus?.workbuddy),
    logsDir: path.join(home, ".workbuddy"),
    logsPredicate: (_full, name) => name === "projects" || name.endsWith(".jsonl"),
    settingsPath: path.join(home, ".workbuddy", "settings.json"),
  }));

  return out;
}

function buildEntry({ name, hookExpected, hookInstalled, logsDir, logsPredicate, settingsPath }) {
  const logsPresent = dirHasFile(logsDir, logsPredicate);
  const passive = hookExpected && !hookInstalled && logsPresent;
  let reason = null;
  if (hookExpected && !hookInstalled) {
    reason = classifyWritableFailure(settingsPath);
  }
  return {
    name,
    hook_expected: hookExpected,
    hook_installed: hookInstalled,
    logs_present: logsPresent,
    passive,
    hook_failure_reason: reason,
  };
}

/**
 * Convenience boolean: is at least one provider in passive mode?
 */
function isPassiveModeActive(providers) {
  return providers.some((p) => p.passive);
}

module.exports = {
  detectPassiveProviders,
  isPassiveModeActive,
  // Exposed for unit testing
  dirHasFile,
  classifyWritableFailure,
};
