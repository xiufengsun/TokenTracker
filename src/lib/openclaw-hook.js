const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const { runOpenclawCli } = require("./openclaw-cli");

const OPENCLAW_HOOK_NAME = "tokentracker-openclaw-sync";
const OPENCLAW_HOOK_DIRNAME = "openclaw-hook";

function resolveOpenclawHookPaths({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  if (!trackerDir) throw new Error("trackerDir is required");

  const openclawConfigPath =
    normalizeString(env.OPENCLAW_CONFIG_PATH) || path.join(home, ".openclaw", "openclaw.json");

  const openclawHome =
    normalizeString(env.TOKENTRACKER_OPENCLAW_HOME) ||
    normalizeString(env.OPENCLAW_STATE_DIR) ||
    path.join(home, ".openclaw");

  const hookDir = path.join(trackerDir, OPENCLAW_HOOK_DIRNAME);
  const hookEntryDir = path.join(hookDir, OPENCLAW_HOOK_NAME);

  return {
    hookName: OPENCLAW_HOOK_NAME,
    hookDir,
    hookEntryDir,
    openclawConfigPath,
    openclawHome,
  };
}

async function installOpenclawHook({
  home = os.homedir(),
  trackerDir,
  packageName = "tokentracker-cli",
  env = process.env,
} = {}) {
  const paths = resolveOpenclawHookPaths({ home, trackerDir, env });

  await ensureOpenclawHookFiles({
    hookDir: paths.hookDir,
    trackerDir,
    packageName,
    openclawHome: paths.openclawHome,
  });

  const installResult = runOpenclawCli(["hooks", "install", "--link", paths.hookDir], env);
  if (installResult.skippedReason) {
    return { configured: false, ...paths, ...installResult };
  }

  const state = await probeOpenclawHookState({ home, trackerDir, env });
  return {
    configured: state.configured,
    changed: /Linked hook path:/i.test(installResult.stdout || ""),
    ...paths,
    stdout: installResult.stdout,
    stderr: installResult.stderr,
    code: installResult.code,
  };
}

async function ensureOpenclawHookFiles({
  hookDir,
  trackerDir,
  packageName = "tokentracker-cli",
  openclawHome,
} = {}) {
  if (!hookDir || !trackerDir) throw new Error("hookDir and trackerDir are required");

  const hookEntryDir = path.join(hookDir, OPENCLAW_HOOK_NAME);
  await fs.mkdir(hookEntryDir, { recursive: true });

  const hookMdPath = path.join(hookEntryDir, "HOOK.md");
  const handlerPath = path.join(hookEntryDir, "handler.js");

  await fs.writeFile(hookMdPath, buildHookMarkdown(), "utf8");
  await fs.writeFile(
    handlerPath,
    buildHookHandler({
      trackerDir,
      packageName,
      openclawHome: openclawHome || path.join(os.homedir(), ".openclaw"),
    }),
    "utf8",
  );
}

async function probeOpenclawHookState({ home = os.homedir(), trackerDir, env = process.env } = {}) {
  const paths = resolveOpenclawHookPaths({ home, trackerDir, env });
  const { openclawConfigPath, hookDir, hookEntryDir, hookName } = paths;

  const hookFilesReady =
    fssync.existsSync(path.join(hookEntryDir, "HOOK.md")) &&
    fssync.existsSync(path.join(hookEntryDir, "handler.js"));

  let cfg = null;
  try {
    const raw = await fs.readFile(openclawConfigPath, "utf8");
    cfg = JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return {
        configured: false,
        enabled: false,
        linked: false,
        hookFilesReady,
        skippedReason: "openclaw-config-missing",
        ...paths,
      };
    }
    return {
      configured: false,
      enabled: false,
      linked: false,
      hookFilesReady,
      skippedReason: "openclaw-config-unreadable",
      error: err?.message || String(err),
      ...paths,
    };
  }

  const enabled = Boolean(cfg?.hooks?.internal?.entries?.[hookName]?.enabled);
  const extraDirs = Array.isArray(cfg?.hooks?.internal?.load?.extraDirs)
    ? cfg.hooks.internal.load.extraDirs
    : [];
  const normalizedHookDir = path.resolve(hookDir);
  const linked = extraDirs.some((entry) => path.resolve(String(entry || "")) === normalizedHookDir);

  return {
    configured: enabled && linked,
    enabled,
    linked,
    hookFilesReady,
    ...paths,
  };
}

async function removeOpenclawHookConfig({
  home = os.homedir(),
  trackerDir,
  env = process.env,
} = {}) {
  const paths = resolveOpenclawHookPaths({ home, trackerDir, env });
  const { openclawConfigPath, hookDir, hookName } = paths;

  let cfg;
  try {
    cfg = JSON.parse(await fs.readFile(openclawConfigPath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return { removed: false, skippedReason: "openclaw-config-missing", ...paths };
    }
    return {
      removed: false,
      skippedReason: "openclaw-config-unreadable",
      error: err?.message || String(err),
      ...paths,
    };
  }

  let changed = false;
  const hooks = cfg?.hooks;
  const internal = hooks?.internal;

  if (internal?.entries && Object.prototype.hasOwnProperty.call(internal.entries, hookName)) {
    delete internal.entries[hookName];
    changed = true;
    if (Object.keys(internal.entries).length === 0) delete internal.entries;
  }

  if (internal?.load && Array.isArray(internal.load.extraDirs)) {
    const before = internal.load.extraDirs;
    const target = path.resolve(hookDir);
    const after = before.filter((entry) => path.resolve(String(entry || "")) !== target);
    if (after.length !== before.length) {
      internal.load.extraDirs = after;
      changed = true;
      if (after.length === 0) delete internal.load.extraDirs;
      if (Object.keys(internal.load).length === 0) delete internal.load;
    }
  }

  if (internal?.installs && typeof internal.installs === "object") {
    const installs = internal.installs;
    if (Object.prototype.hasOwnProperty.call(installs, hookName)) {
      delete installs[hookName];
      changed = true;
    }

    const target = path.resolve(hookDir);
    for (const [id, entry] of Object.entries(installs)) {
      const sourcePath = normalizeString(entry?.sourcePath);
      const installPath = normalizeString(entry?.installPath);
      if (
        (sourcePath && path.resolve(sourcePath) === target) ||
        (installPath && path.resolve(installPath) === target)
      ) {
        delete installs[id];
        changed = true;
      }
    }

    if (Object.keys(installs).length === 0) delete internal.installs;
  }

  if (internal && Object.keys(internal).length === 0) {
    delete hooks.internal;
    changed = true;
  }
  if (hooks && Object.keys(hooks).length === 0) {
    delete cfg.hooks;
    changed = true;
  }

  if (changed) {
    await fs.writeFile(openclawConfigPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  }

  await fs.rm(hookDir, { recursive: true, force: true }).catch(() => {});

  return { removed: changed, ...paths };
}

function buildHookMarkdown() {
  return `---
name: ${OPENCLAW_HOOK_NAME}
description: "Trigger tokentracker sync when OpenClaw sessions roll over"
metadata:
  { "openclaw": { "emoji": "📈", "events": ["command:new", "command:reset", "command:stop"], "requires": { "bins": ["node"] } } }
---

# TokenTracker OpenClaw Sync Hook

Triggers non-blocking 'tokentracker sync --auto --from-openclaw' runs when OpenClaw command events indicate session rollover/reset/stop.
`;
}

function buildHookHandler({ trackerDir, packageName = "tokentracker-cli", openclawHome }) {
  const trackerBinPath = path.join(trackerDir, "app", "bin", "tracker.js");
  const fallbackPkg = packageName || "tokentracker-cli";
  const safeOpenclawHome = openclawHome || path.join(os.homedir(), ".openclaw");

  return (
    `'use strict';\n` +
    `const fs = require('node:fs');\n` +
    `const path = require('node:path');\n` +
    `const cp = require('node:child_process');\n` +
    `const trackerDir = ${JSON.stringify(trackerDir)};\n` +
    `const trackerBinPath = ${JSON.stringify(trackerBinPath)};\n` +
    `const fallbackPkg = ${JSON.stringify(fallbackPkg)};\n` +
    `const openclawHome = ${JSON.stringify(safeOpenclawHome)};\n` +
    `const throttlePath = path.join(trackerDir, 'openclaw.sync.throttle');\n` +
    `const depsMarkerPath = path.join(trackerDir, 'app', 'bin', 'tracker.js');\n` +
    `const THROTTLE_MS = 15_000;\n` +
    `\n` +
    `module.exports = async function handler(event) {\n` +
    `  try {\n` +
    `    if (!event || event.type !== 'command') return;\n` +
    `    if (event.action !== 'new' && event.action !== 'reset' && event.action !== 'stop') return;\n` +
    `\n` +
    `    const sessionKey = normalize(event.sessionKey);\n` +
    `    const agentId = parseAgentId(sessionKey);\n` +
    `    if (!agentId) return;\n` +
    `\n` +
    `    const sessionEntry = resolveSessionEntry(event);\n` +
    `    const sessionId = normalize(sessionEntry && sessionEntry.sessionId) || resolveSessionId(event);\n` +
    `    if (!sessionId) return;\n` +
    `\n` +
    `    const now = Date.now();\n` +
    `    let last = 0;\n` +
    `    try { last = Number(fs.readFileSync(throttlePath, 'utf8')) || 0; } catch (_) {}\n` +
    `    if (now - last < THROTTLE_MS) return;\n` +
    `    try {\n` +
    `      fs.mkdirSync(trackerDir, { recursive: true });\n` +
    `      fs.writeFileSync(throttlePath, String(now), 'utf8');\n` +
    `    } catch (_) {}\n` +
    `\n` +
    `    const env = {\n` +
    `      ...process.env,\n` +
    `      TOKENTRACKER_OPENCLAW_AGENT_ID: agentId,\n` +
    `      TOKENTRACKER_OPENCLAW_SESSION_KEY: sessionKey,\n` +
    `      TOKENTRACKER_OPENCLAW_PREV_SESSION_ID: sessionId,\n` +
    `      TOKENTRACKER_OPENCLAW_HOME: openclawHome\n` +
    `    };\n` +
    `    const prevTotalTokens = toNonNegativeInt(sessionEntry && sessionEntry.totalTokens);\n` +
    `    const prevInputTokens = toNonNegativeInt(sessionEntry && sessionEntry.inputTokens);\n` +
    `    const prevOutputTokens = toNonNegativeInt(sessionEntry && sessionEntry.outputTokens);\n` +
    `    const prevModel = normalize(sessionEntry && sessionEntry.model);\n` +
    `    const prevUpdatedAt = toIso(sessionEntry && sessionEntry.updatedAt);\n` +
    `    if (prevTotalTokens != null) env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS = String(prevTotalTokens);\n` +
    `    if (prevInputTokens != null) env.TOKENTRACKER_OPENCLAW_PREV_INPUT_TOKENS = String(prevInputTokens);\n` +
    `    if (prevOutputTokens != null) env.TOKENTRACKER_OPENCLAW_PREV_OUTPUT_TOKENS = String(prevOutputTokens);\n` +
    `    if (prevModel) env.TOKENTRACKER_OPENCLAW_PREV_MODEL = prevModel;\n` +
    `    if (prevUpdatedAt) env.TOKENTRACKER_OPENCLAW_PREV_UPDATED_AT = prevUpdatedAt;\n` +
    `\n` +
    `    const hasLocalRuntime = fs.existsSync(trackerBinPath);\n` +
    `    const hasLocalDeps = fs.existsSync(depsMarkerPath);\n` +
    `    const cmd = hasLocalRuntime && hasLocalDeps\n` +
    `      ? [process.execPath, trackerBinPath, 'sync', '--auto', '--from-openclaw']\n` +
    `      : ['npx', '--yes', fallbackPkg, 'sync', '--auto', '--from-openclaw'];\n` +
    `\n` +
    `    const child = cp.spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', env });\n` +
    `    child.unref();\n` +
    `  } catch (_) {}\n` +
    `};\n` +
    `\n` +
    `function normalize(v) {\n` +
    `  if (typeof v !== 'string') return null;\n` +
    `  const s = v.trim();\n` +
    `  return s.length > 0 ? s : null;\n` +
    `}\n` +
    `\n` +
    `function resolveSessionEntry(event) {\n` +
    `  const ctx = (event && event.context && typeof event.context === 'object') ? event.context : {};\n` +
    `  if (!event || event.type !== 'command') return null;\n` +
    `  if (event.action === 'stop') return (ctx.sessionEntry && typeof ctx.sessionEntry === 'object') ? ctx.sessionEntry : null;\n` +
    `  if (ctx.previousSessionEntry && typeof ctx.previousSessionEntry === 'object') return ctx.previousSessionEntry;\n` +
    `  if (ctx.sessionEntry && typeof ctx.sessionEntry === 'object') return ctx.sessionEntry;\n` +
    `  return null;\n` +
    `}\n` +
    `\n` +
    `function toNonNegativeInt(v) {\n` +
    `  const n = Number(v);\n` +
    `  if (!Number.isFinite(n) || n < 0) return null;\n` +
    `  return Math.floor(n);\n` +
    `}\n` +
    `\n` +
    `function toIso(v) {\n` +
    `  if (typeof v === 'string') {\n` +
    `    const s = normalize(v);\n` +
    `    if (s && !Number.isNaN(Date.parse(s))) return s;\n` +
    `  }\n` +
    `  const n = Number(v);\n` +
    `  if (!Number.isFinite(n) || n <= 0) return null;\n` +
    `  const ms = n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);\n` +
    `  const d = new Date(ms);\n` +
    `  return Number.isNaN(d.getTime()) ? null : d.toISOString();\n` +
    `}\n` +
    `\n` +
    `function parseAgentId(sessionKey) {\n` +
    `  const s = normalize(sessionKey);\n` +
    `  if (!s || !s.startsWith('agent:')) return null;\n` +
    `  const parts = s.split(':');\n` +
    `  return parts.length >= 2 ? normalize(parts[1]) : null;\n` +
    `}\n` +
    `\n` +
    `function resolveSessionId(event) {\n` +
    `  const ctx = (event && event.context && typeof event.context === 'object') ? event.context : {};\n` +
    `  return (\n` +
    `    normalize(ctx.previousSessionEntry && ctx.previousSessionEntry.sessionId) ||\n` +
    `    normalize(ctx.previousSessionId) ||\n` +
    `    normalize(ctx.sessionEntry && ctx.sessionEntry.sessionId) ||\n` +
    `    normalize(ctx.sessionId)\n` +
    `  );\n` +
    `}\n`
  );
}

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

module.exports = {
  OPENCLAW_HOOK_NAME,
  OPENCLAW_HOOK_DIRNAME,
  resolveOpenclawHookPaths,
  ensureOpenclawHookFiles,
  installOpenclawHook,
  probeOpenclawHookState,
  removeOpenclawHookConfig,
};
