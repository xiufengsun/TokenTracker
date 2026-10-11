const fs = require("node:fs/promises");
const path = require("node:path");

const { ensureDir, readJson, writeJson } = require("./fs");
const { buildNotifyCommand, notifyIdentity } = require("./notify-command");

const DEFAULT_EVENT = "SessionEnd";
const CLAUDE_USAGE_EVENTS = ["Stop", DEFAULT_EVENT];

async function upsertClaudeHook({ settingsPath, hookCommand, event = DEFAULT_EVENT }) {
  return upsertClaudeHooks({ settingsPath, hookCommand, events: [event] });
}

async function upsertClaudeUsageHooks({ settingsPath, hookCommand }) {
  return upsertClaudeHooks({ settingsPath, hookCommand, events: CLAUDE_USAGE_EVENTS });
}

async function upsertClaudeHooks({ settingsPath, hookCommand, events }) {
  const existing = await readJson(settingsPath);
  const settings = normalizeSettings(existing);
  const hooks = normalizeHooks(settings.hooks);
  const nextHooks = { ...hooks };
  let changed = false;

  for (const event of normalizeEventList(events)) {
    const entries = normalizeEntries(hooks[event]);
    const normalized = normalizeEntriesForCommand(entries, hookCommand, event);
    let nextEntries = normalized.entries;
    if (!hasHook(nextEntries, hookCommand)) {
      nextEntries = nextEntries.concat([{ hooks: [{ type: "command", command: hookCommand, ...hookShell(hookCommand) }] }]);
      changed = true;
    }
    if (normalized.changed) changed = true;
    if (normalized.changed || nextEntries.length !== entries.length) {
      nextHooks[event] = nextEntries;
    }
  }

  if (!changed) return { changed: false, backupPath: null };

  const nextSettings = { ...settings, hooks: nextHooks };
  const backupPath = await writeClaudeSettings({ settingsPath, settings: nextSettings });
  return { changed: true, backupPath };
}

async function removeClaudeHook({ settingsPath, hookCommand, event = DEFAULT_EVENT }) {
  return removeClaudeHooks({ settingsPath, hookCommand, events: [event] });
}

async function removeClaudeUsageHooks({ settingsPath, hookCommand }) {
  return removeClaudeHooks({ settingsPath, hookCommand, events: CLAUDE_USAGE_EVENTS });
}

async function removeClaudeHooks({ settingsPath, hookCommand, events }) {
  const existing = await readJson(settingsPath);
  if (!existing) return { removed: false, skippedReason: "settings-missing" };

  const settings = normalizeSettings(existing);
  const hooks = normalizeHooks(settings.hooks);
  const nextHooks = { ...hooks };
  let removed = false;
  for (const event of normalizeEventList(events)) {
    const entries = normalizeEntries(hooks[event]);
    const nextEntries = [];
    for (const entry of entries) {
      const res = stripHookFromEntry(entry, hookCommand);
      if (res.removed) removed = true;
      if (res.entry) nextEntries.push(res.entry);
    }
    if (nextEntries.length > 0) nextHooks[event] = nextEntries;
    else delete nextHooks[event];
  }

  if (!removed) return { removed: false, skippedReason: "hook-missing" };

  const nextSettings = { ...settings };
  if (Object.keys(nextHooks).length > 0) nextSettings.hooks = nextHooks;
  else delete nextSettings.hooks;

  const backupPath = await writeClaudeSettings({ settingsPath, settings: nextSettings });
  return { removed: true, skippedReason: null, backupPath };
}

async function isClaudeHookConfigured({ settingsPath, hookCommand, event = DEFAULT_EVENT }) {
  return areClaudeHooksConfigured({ settingsPath, hookCommand, events: [event] });
}

async function areClaudeUsageHooksConfigured({ settingsPath, hookCommand }) {
  return areClaudeHooksConfigured({
    settingsPath,
    hookCommand,
    events: CLAUDE_USAGE_EVENTS,
  });
}

async function areClaudeHooksConfigured({ settingsPath, hookCommand, events }) {
  const settings = await readJson(settingsPath);
  if (!settings || typeof settings !== "object") return false;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  return normalizeEventList(events).every((event) => {
    const entries = normalizeEntries(hooks[event]);
    return hasHook(entries, hookCommand);
  });
}

// Generic Session-hook command builder. CodeBuddy CLI is a Claude-Code fork
// and uses the exact same settings.json hook schema, so this function works
// for any source that accepts the `node notify.cjs --source=<name>` contract.
function buildHookCommand(notifyPath, source, options) {
  const cmd = typeof notifyPath === "string" ? notifyPath : "";
  const src = typeof source === "string" && source ? source : "claude";
  return buildNotifyCommand(cmd, src, options);
}

function buildClaudeHookCommand(notifyPath, options) {
  return buildHookCommand(notifyPath, "claude", options);
}

function normalizeSettings(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normalizeHooks(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normalizeEntries(raw) {
  return Array.isArray(raw) ? raw.slice() : [];
}

function normalizeEventList(events) {
  const values = Array.isArray(events) ? events : [];
  return Array.from(new Set(values.filter((event) => typeof event === "string" && event)));
}

function normalizeCommand(cmd) {
  if (Array.isArray(cmd)) return cmd.map((v) => String(v)).join("\u0000");
  if (typeof cmd === "string") return cmd.trim();
  return null;
}

function hasHook(entries, hookCommand) {
  const shell = hookShell(hookCommand).shell;
  const configured = (hook) => normalizeCommand(hook?.command) === normalizeCommand(hookCommand) &&
    (!shell || (hook.shell === shell && !Object.hasOwn(hook, "args")));
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.command && configured(entry)) return true;
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (hook && configured(hook)) return true;
    }
  }
  return false;
}

function stripHookFromEntry(entry, hookCommand) {
  if (!entry || typeof entry !== "object") return { entry, removed: false };

  if (entry.command) {
    if (commandsEqual(entry.command, hookCommand)) return { entry: null, removed: true };
    return { entry, removed: false };
  }

  const hooks = Array.isArray(entry.hooks) ? entry.hooks : null;
  if (!hooks) return { entry, removed: false };

  const nextHooks = hooks.filter((hook) => !commandsEqual(hook?.command, hookCommand));
  if (nextHooks.length === hooks.length) return { entry, removed: false };
  if (nextHooks.length === 0) return { entry: null, removed: true };

  return { entry: { ...entry, hooks: nextHooks }, removed: true };
}

function hookShell(command) {
  return typeof command === "string" && command.trimStart().startsWith("& '")
    ? { shell: "powershell" } : {};
}

function normalizeEntriesForCommand(entries, hookCommand, event) {
  const shell = hookShell(hookCommand);
  const repair = (hook) => {
    const next = { ...hook, type: "command", command: hookCommand, ...shell };
    if (shell.shell) delete next.args;
    return next;
  };
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry.command && commandsEqual(entry.command, hookCommand)) {
      if (entry.type !== "command" || entry.command !== hookCommand || (shell.shell && (entry.shell !== shell.shell || Object.hasOwn(entry, "args")))) {
        changed = true;
        return repair(entry);
      }
      return entry;
    }
    if (!Array.isArray(entry.hooks)) return entry;
    let hooksChanged = false;
    const nextHooks = entry.hooks.map((hook) => {
      if (hook && commandsEqual(hook.command, hookCommand)) {
        if (hook.type !== "command" || hook.command !== hookCommand || (shell.shell && (hook.shell !== shell.shell || Object.hasOwn(hook, "args")))) {
          hooksChanged = true;
          return repair(hook);
        }
      }
      return hook;
    });
    if (!hooksChanged) return entry;
    changed = true;
    return { ...entry, hooks: nextHooks };
  });
  const seen = new Set();
  const deduplicated = nextEntries.map((entry) => {
    const matcher = entry?.matcher;
    const scope = JSON.stringify(event === "Stop" || matcher == null || ["", "*", ".*"].includes(matcher) ? null : matcher);
    const keep = (hook) => {
      if (!commandsEqual(hook?.command, hookCommand)) return true;
      if (seen.has(scope)) { changed = true; return false; }
      seen.add(scope);
      return true;
    };
    if (entry?.command) return keep(entry) ? entry : null;
    if (!Array.isArray(entry?.hooks)) return entry;
    const hooks = entry.hooks.filter(keep);
    if (!hooks.length) return null;
    return hooks.length === entry.hooks.length ? entry : { ...entry, hooks };
  }).filter(Boolean);
  return { entries: deduplicated, changed };
}

function commandsEqual(a, b) {
  const left = normalizeCommand(a);
  const right = normalizeCommand(b);
  return Boolean(left && right && (left === right ||
    (notifyIdentity(left) && notifyIdentity(left) === notifyIdentity(right))));
}

function quoteArg(value) {
  const v = typeof value === "string" ? value : "";
  if (!v) return '""';
  if (/^[A-Za-z0-9_\-./:@]+$/.test(v)) return v;
  // Escape backslashes before quotes: a trailing backslash (Windows paths)
  // would otherwise escape the closing quote and corrupt the hook command.
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function writeClaudeSettings({ settingsPath, settings }) {
  await ensureDir(path.dirname(settingsPath));
  let backupPath = null;
  try {
    const st = await fs.stat(settingsPath);
    if (st && st.isFile()) {
      backupPath = `${settingsPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await fs.copyFile(settingsPath, backupPath);
    }
  } catch (_e) {
    // Ignore missing file.
  }
  await writeJson(settingsPath, settings);
  return backupPath;
}

module.exports = {
  CLAUDE_USAGE_EVENTS,
  upsertClaudeHook,
  upsertClaudeUsageHooks,
  removeClaudeHook,
  removeClaudeUsageHooks,
  isClaudeHookConfigured,
  areClaudeUsageHooksConfigured,
  buildClaudeHookCommand,
  buildHookCommand,
  // Aliases for callers that want a name unbiased toward Claude (the schema
  // applies equally to CodeBuddy and any future Claude-Code fork).
  upsertSessionHook: upsertClaudeHook,
  removeSessionHook: removeClaudeHook,
  isSessionHookConfigured: isClaudeHookConfigured,
};
