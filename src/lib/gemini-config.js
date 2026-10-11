const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const { ensureDir, readJson, writeJson } = require("./fs");
const { buildNotifyCommand } = require("./notify-command");

const DEFAULT_EVENT = "SessionEnd";
const DEFAULT_HOOK_NAME = "tokentracker";
const DEFAULT_MATCHER = "exit|clear|logout|prompt_input_exit|other";

function resolveGeminiConfigDir({ home = os.homedir(), env = process.env } = {}) {
  const explicit = typeof env.GEMINI_HOME === "string" ? env.GEMINI_HOME.trim() : "";
  if (explicit) return path.resolve(explicit);
  return path.join(home, ".gemini");
}

function resolveGeminiSettingsPath({ configDir }) {
  return path.join(configDir, "settings.json");
}

async function upsertGeminiHook({
  settingsPath,
  hookCommand,
  hookName = DEFAULT_HOOK_NAME,
  matcher = DEFAULT_MATCHER,
  event = DEFAULT_EVENT,
}) {
  const existing = await readJson(settingsPath);
  const settings = normalizeSettings(existing);
  const enableResult = ensureHooksEnabled(settings);
  const baseSettings = enableResult.settings;
  const hooks = normalizeHooks(settings.hooks);
  const entries = normalizeEntries(hooks[event]);

  const normalized = normalizeEntriesForHook(entries, { hookCommand, hookName });
  let nextEntries = normalized.entries;
  let changed = normalized.changed || enableResult.changed;

  if (!hasHook(nextEntries, { hookCommand, hookName })) {
    nextEntries = nextEntries.concat([buildHookEntry({ hookCommand, hookName, matcher })]);
    changed = true;
  }

  if (!changed) return { changed: false, backupPath: null };

  const nextHooks = { ...hooks, [event]: nextEntries };
  const nextSettings = { ...baseSettings, hooks: nextHooks };
  const backupPath = await writeGeminiSettings({ settingsPath, settings: nextSettings });
  return { changed: true, backupPath };
}

async function removeGeminiHook({
  settingsPath,
  hookCommand,
  hookName = DEFAULT_HOOK_NAME,
  event = DEFAULT_EVENT,
}) {
  const existing = await readJson(settingsPath);
  if (!existing) return { removed: false, skippedReason: "settings-missing" };

  const settings = normalizeSettings(existing);
  const hooks = normalizeHooks(settings.hooks);
  const entries = normalizeEntries(hooks[event]);
  if (entries.length === 0) return { removed: false, skippedReason: "hook-missing" };

  let removed = false;
  const nextEntries = [];
  for (const entry of entries) {
    const res = stripHookFromEntry(entry, { hookCommand, hookName });
    if (res.removed) removed = true;
    if (res.entry) nextEntries.push(res.entry);
  }

  if (!removed) return { removed: false, skippedReason: "hook-missing" };

  const nextHooks = { ...hooks };
  if (nextEntries.length > 0) nextHooks[event] = nextEntries;
  else delete nextHooks[event];

  const nextSettings = { ...settings };
  if (Object.keys(nextHooks).length > 0) nextSettings.hooks = nextHooks;
  else delete nextSettings.hooks;

  const backupPath = await writeGeminiSettings({ settingsPath, settings: nextSettings });
  return { removed: true, skippedReason: null, backupPath };
}

async function isGeminiHookConfigured({
  settingsPath,
  hookCommand,
  hookName = DEFAULT_HOOK_NAME,
  event = DEFAULT_EVENT,
}) {
  const settings = await readJson(settingsPath);
  if (!settings || typeof settings !== "object") return false;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  const entries = normalizeEntries(hooks[event]);
  return hasHook(entries, { hookCommand, hookName });
}

function buildGeminiHookCommand(notifyPath, options) {
  const cmd = typeof notifyPath === "string" ? notifyPath : "";
  return buildNotifyCommand(cmd, "gemini", options);
}

function buildHookEntry({ hookCommand, hookName, matcher }) {
  const hook = {
    name: hookName,
    type: "command",
    command: hookCommand,
  };
  const entry = { hooks: [hook] };
  if (typeof matcher === "string" && matcher.length > 0) entry.matcher = matcher;
  return entry;
}

function normalizeSettings(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normalizeHooks(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normalizeTools(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normalizeEntries(raw) {
  return Array.isArray(raw) ? raw.slice() : [];
}

function normalizeCommand(cmd) {
  if (Array.isArray(cmd)) return cmd.map((v) => String(v)).join("\u0000");
  if (typeof cmd === "string") return cmd.trim();
  return null;
}

function normalizeName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function ensureHooksEnabled(settings) {
  const tools = normalizeTools(settings.tools);
  if (tools.enableHooks === true) return { settings, changed: false };
  const nextTools = { ...tools, enableHooks: true };
  return { settings: { ...settings, tools: nextTools }, changed: true };
}

function hookMatches(hook, { hookCommand, hookName, requireCommand = false }) {
  if (!hook || typeof hook !== "object") return false;
  const name = normalizeName(hook.name);
  const targetName = normalizeName(hookName);
  const cmd = normalizeCommand(hook.command);
  const targetCmd = normalizeCommand(hookCommand);
  const commandMatches = Boolean(cmd && targetCmd && cmd === targetCmd);
  if (requireCommand) return commandMatches;
  const nameMatches = Boolean(name && targetName && name === targetName);
  return Boolean(commandMatches || nameMatches);
}

function entryMatches(entry, { hookCommand, hookName, requireCommand = false }) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.command || entry.name)
    return hookMatches(entry, { hookCommand, hookName, requireCommand });
  if (!Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((hook) => hookMatches(hook, { hookCommand, hookName, requireCommand }));
}

function hasHook(entries, { hookCommand, hookName }) {
  return entries.some((entry) => entryMatches(entry, { hookCommand, hookName }));
}

function normalizeEntriesForHook(entries, { hookCommand, hookName }) {
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;

    if (entry.command || entry.name) {
      if (hookMatches(entry, { hookCommand, hookName })) {
        const next = normalizeHookObject(entry, { hookCommand, hookName });
        if (next !== entry) changed = true;
        return next;
      }
      return entry;
    }

    const hooks = Array.isArray(entry.hooks) ? entry.hooks : null;
    if (!hooks) return entry;

    let hooksChanged = false;
    const nextHooks = hooks.map((hook) => {
      if (hookMatches(hook, { hookCommand, hookName })) {
        const next = normalizeHookObject(hook, { hookCommand, hookName });
        if (next !== hook) hooksChanged = true;
        return next;
      }
      return hook;
    });

    if (!hooksChanged) return entry;
    changed = true;
    return { ...entry, hooks: nextHooks };
  });

  return { entries: nextEntries, changed };
}

function normalizeHookObject(hook, { hookCommand, hookName }) {
  const next = { ...hook };
  let changed = false;

  if (next.type !== "command") {
    next.type = "command";
    changed = true;
  }

  if (hookCommand && next.command !== hookCommand) {
    next.command = hookCommand;
    changed = true;
  }

  if (hookName && next.name !== hookName) {
    next.name = hookName;
    changed = true;
  }

  return changed ? next : hook;
}

function stripHookFromEntry(entry, { hookCommand, hookName }) {
  if (!entry || typeof entry !== "object") return { entry, removed: false };

  if (entry.command || entry.name) {
    if (hookMatches(entry, { hookCommand, hookName, requireCommand: true }))
      return { entry: null, removed: true };
    return { entry, removed: false };
  }

  const hooks = Array.isArray(entry.hooks) ? entry.hooks : null;
  if (!hooks) return { entry, removed: false };

  const nextHooks = hooks.filter(
    (hook) => !hookMatches(hook, { hookCommand, hookName, requireCommand: true }),
  );
  if (nextHooks.length === hooks.length) return { entry, removed: false };
  if (nextHooks.length === 0) return { entry: null, removed: true };

  return { entry: { ...entry, hooks: nextHooks }, removed: true };
}

function quoteArg(value) {
  const v = typeof value === "string" ? value : "";
  if (!v) return '""';
  if (/^[A-Za-z0-9_\-./:@]+$/.test(v)) return v;
  // Escape backslashes before quotes: a trailing backslash (Windows paths)
  // would otherwise escape the closing quote and corrupt the hook command.
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function writeGeminiSettings({ settingsPath, settings }) {
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
  DEFAULT_EVENT,
  DEFAULT_HOOK_NAME,
  DEFAULT_MATCHER,
  resolveGeminiConfigDir,
  resolveGeminiSettingsPath,
  buildGeminiHookCommand,
  upsertGeminiHook,
  removeGeminiHook,
  isGeminiHookConfigured,
};
