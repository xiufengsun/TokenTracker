const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const { runOpenclawCli } = require("./openclaw-cli");

const OPENCLAW_SESSION_PLUGIN_ID = "openclaw-session-sync";
const OPENCLAW_SESSION_PLUGIN_DIRNAME = "openclaw-plugin";

function resolveOpenclawSessionPluginPaths({
  home = os.homedir(),
  trackerDir,
  env = process.env,
} = {}) {
  if (!trackerDir) throw new Error("trackerDir is required");

  const openclawConfigPath =
    normalizeString(env.OPENCLAW_CONFIG_PATH) || path.join(home, ".openclaw", "openclaw.json");

  const openclawHome =
    normalizeString(env.TOKENTRACKER_OPENCLAW_HOME) ||
    normalizeString(env.OPENCLAW_STATE_DIR) ||
    path.join(home, ".openclaw");

  const pluginDir = path.join(trackerDir, OPENCLAW_SESSION_PLUGIN_DIRNAME);
  const pluginEntryDir = path.join(pluginDir, OPENCLAW_SESSION_PLUGIN_ID);

  return {
    pluginId: OPENCLAW_SESSION_PLUGIN_ID,
    pluginDir,
    pluginEntryDir,
    openclawConfigPath,
    openclawHome,
  };
}

async function installOpenclawSessionPlugin({
  home = os.homedir(),
  trackerDir,
  packageName = "tokentracker-cli",
  env = process.env,
} = {}) {
  const paths = resolveOpenclawSessionPluginPaths({ home, trackerDir, env });

  await ensureOpenclawSessionPluginFiles({
    pluginDir: paths.pluginDir,
    trackerDir,
    packageName,
    openclawHome: paths.openclawHome,
  });

  const installResult = runOpenclawCli(["plugins", "install", "--link", paths.pluginEntryDir], env);
  if (installResult.skippedReason) {
    return { configured: false, ...paths, ...installResult };
  }

  const enableResult = runOpenclawCli(["plugins", "enable", paths.pluginId], env);
  if (enableResult.skippedReason) {
    return {
      configured: false,
      ...paths,
      skippedReason: enableResult.skippedReason,
      error: enableResult.error,
      stdout: `${installResult.stdout || ""}\n${enableResult.stdout || ""}`.trim(),
      stderr: `${installResult.stderr || ""}\n${enableResult.stderr || ""}`.trim(),
      code: enableResult.code,
    };
  }

  const policyResult = await ensureOpenclawSessionPluginPolicy(paths);
  const state = await probeOpenclawSessionPluginState({ home, trackerDir, env });
  return {
    configured: state.configured,
    changed:
      /Linked plugin path:/i.test(installResult.stdout || "") ||
      /Enabled plugin/i.test(enableResult.stdout || "") ||
      /already enabled/i.test(enableResult.stdout || "") ||
      policyResult.changed,
    ...paths,
    stdout: `${installResult.stdout || ""}\n${enableResult.stdout || ""}`.trim(),
    stderr: `${installResult.stderr || ""}\n${enableResult.stderr || ""}`.trim(),
    code: enableResult.code,
  };
}

async function ensureOpenclawSessionPluginFiles({
  pluginDir,
  trackerDir,
  packageName = "tokentracker-cli",
  openclawHome,
} = {}) {
  if (!pluginDir || !trackerDir) throw new Error("pluginDir and trackerDir are required");

  const pluginEntryDir = path.join(pluginDir, OPENCLAW_SESSION_PLUGIN_ID);
  await fs.mkdir(pluginEntryDir, { recursive: true });

  const packageJsonPath = path.join(pluginEntryDir, "package.json");
  const pluginMetaPath = path.join(pluginEntryDir, "openclaw.plugin.json");
  const indexPath = path.join(pluginEntryDir, "index.js");

  await fs.writeFile(packageJsonPath, buildSessionPluginPackageJson(), "utf8");
  await fs.writeFile(pluginMetaPath, buildSessionPluginMeta(), "utf8");
  await fs.writeFile(
    indexPath,
    buildSessionPluginIndex({
      trackerDir,
      packageName,
      openclawHome: openclawHome || path.join(os.homedir(), ".openclaw"),
    }),
    "utf8",
  );
}

async function probeOpenclawSessionPluginState({
  home = os.homedir(),
  trackerDir,
  env = process.env,
} = {}) {
  const paths = resolveOpenclawSessionPluginPaths({ home, trackerDir, env });
  const { openclawConfigPath, pluginEntryDir, pluginId } = paths;

  const pluginFilesReady =
    fssync.existsSync(path.join(pluginEntryDir, "package.json")) &&
    fssync.existsSync(path.join(pluginEntryDir, "index.js"));

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
        installed: false,
        pluginFilesReady,
        skippedReason: "openclaw-config-missing",
        ...paths,
      };
    }
    return {
      configured: false,
      enabled: false,
      linked: false,
      installed: false,
      pluginFilesReady,
      skippedReason: "openclaw-config-unreadable",
      error: err?.message || String(err),
      ...paths,
    };
  }

  const pluginEntry = cfg?.plugins?.entries?.[pluginId];
  const enabled = pluginEntry ? pluginEntry.enabled !== false : false;
  const conversationAccess = pluginEntry?.hooks?.allowConversationAccess === true;

  const loadPaths = Array.isArray(cfg?.plugins?.load?.paths) ? cfg.plugins.load.paths : [];
  const normalizedPluginEntryDir = path.resolve(pluginEntryDir);
  const linked = loadPaths.some(
    (entry) => path.resolve(String(entry || "")) === normalizedPluginEntryDir,
  );

  const installs =
    cfg?.plugins?.installs && typeof cfg.plugins.installs === "object" ? cfg.plugins.installs : {};
  const installEntry = installs[pluginId];
  const installed = Boolean(installEntry);

  return {
    configured: enabled && linked && pluginFilesReady && conversationAccess,
    enabled,
    linked,
    installed,
    pluginFilesReady,
    conversationAccess,
    ...paths,
  };
}

async function ensureOpenclawSessionPluginPolicy({ openclawConfigPath, pluginId } = {}) {
  if (!openclawConfigPath || !pluginId) {
    throw new Error("openclawConfigPath and pluginId are required");
  }

  let cfg = JSON.parse(await fs.readFile(openclawConfigPath, "utf8"));
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    cfg = {};
  }
  if (!cfg.plugins || typeof cfg.plugins !== "object" || Array.isArray(cfg.plugins)) {
    cfg.plugins = {};
  }
  if (
    !cfg.plugins.entries ||
    typeof cfg.plugins.entries !== "object" ||
    Array.isArray(cfg.plugins.entries)
  ) {
    cfg.plugins.entries = {};
  }

  const existingEntry = cfg.plugins.entries[pluginId];
  const entry =
    existingEntry && typeof existingEntry === "object" && !Array.isArray(existingEntry)
      ? existingEntry
      : {};
  cfg.plugins.entries[pluginId] = entry;

  let changed = existingEntry !== entry;
  if (entry.enabled === false) {
    entry.enabled = true;
    changed = true;
  }
  if (!entry.hooks || typeof entry.hooks !== "object" || Array.isArray(entry.hooks)) {
    entry.hooks = {};
    changed = true;
  }

  if (entry.hooks.allowConversationAccess === true) {
    if (!changed) return { changed: false };
  } else {
    entry.hooks.allowConversationAccess = true;
    changed = true;
  }

  await fs.writeFile(openclawConfigPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return { changed: true };
}

async function removeOpenclawSessionPluginConfig({
  home = os.homedir(),
  trackerDir,
  env = process.env,
} = {}) {
  const paths = resolveOpenclawSessionPluginPaths({ home, trackerDir, env });
  const { openclawConfigPath, pluginEntryDir, pluginId } = paths;

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
  const plugins = cfg?.plugins;

  if (plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, pluginId)) {
    delete plugins.entries[pluginId];
    changed = true;
    if (Object.keys(plugins.entries).length === 0) delete plugins.entries;
  }

  if (plugins?.load && Array.isArray(plugins.load.paths)) {
    const target = path.resolve(pluginEntryDir);
    const after = plugins.load.paths.filter(
      (entry) => path.resolve(String(entry || "")) !== target,
    );
    if (after.length !== plugins.load.paths.length) {
      plugins.load.paths = after;
      changed = true;
      if (after.length === 0) delete plugins.load.paths;
      if (Object.keys(plugins.load).length === 0) delete plugins.load;
    }
  }

  if (plugins?.installs && typeof plugins.installs === "object") {
    const installs = plugins.installs;
    if (Object.prototype.hasOwnProperty.call(installs, pluginId)) {
      delete installs[pluginId];
      changed = true;
    }

    const target = path.resolve(pluginEntryDir);
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

    if (Object.keys(installs).length === 0) delete plugins.installs;
  }

  if (plugins && Object.keys(plugins).length === 0) {
    delete cfg.plugins;
    changed = true;
  }

  if (changed) {
    await fs.writeFile(openclawConfigPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  }

  const hadFiles = await fs
    .stat(pluginEntryDir)
    .then((st) => st.isDirectory())
    .catch(() => false);
  await fs.rm(pluginEntryDir, { recursive: true, force: true }).catch(() => {});

  return { removed: changed || hadFiles, ...paths };
}

function buildSessionPluginPackageJson() {
  return `${JSON.stringify(
    {
      name: "@tokentracker/openclaw-session-sync",
      version: "0.0.0",
      private: true,
      type: "module",
      openclaw: {
        extensions: ["./index.js"],
      },
    },
    null,
    2,
  )}\n`;
}

function buildSessionPluginMeta() {
  return `${JSON.stringify(
    {
      id: OPENCLAW_SESSION_PLUGIN_ID,
      name: "TokenTracker OpenClaw Session Sync",
      description: "Trigger tokentracker sync on OpenClaw agent/session lifecycle events.",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    null,
    2,
  )}\n`;
}

function buildSessionPluginIndex({ trackerDir, packageName = "tokentracker-cli", openclawHome }) {
  const trackerBinPath = path.join(trackerDir, "app", "bin", "tracker.js");
  const fallbackPkg = packageName || "tokentracker-cli";
  const safeOpenclawHome = openclawHome || path.join(os.homedir(), ".openclaw");

  return (
    `import fs from 'node:fs';\n` +
    `import path from 'node:path';\n` +
    `import cp from 'node:child_process';\n` +
    `\n` +
    `const trackerDir = ${JSON.stringify(trackerDir)};\n` +
    `const trackerBinPath = ${JSON.stringify(trackerBinPath)};\n` +
    `const fallbackPkg = ${JSON.stringify(fallbackPkg)};\n` +
    `const openclawHome = ${JSON.stringify(safeOpenclawHome)};\n` +
    `const depsMarkerPath = path.join(trackerDir, 'app', 'bin', 'tracker.js');\n` +
    `const triggerStatePath = path.join(trackerDir, 'openclaw.session-sync.trigger-state.json');\n` +
    `const SESSION_TRIGGER_THROTTLE_MS = 15_000;\n` +
    `\n` +
    `export default function register(api) {\n` +
    `  api.on('agent_end', async (_event, ctx) => {\n` +
    `    try {\n` +
    `      const sessionKey = normalize(ctx && ctx.sessionKey);\n` +
    `      if (!sessionKey) return;\n` +
    `\n` +
    `      const agentId = normalize(ctx && ctx.agentId) || parseAgentId(sessionKey);\n` +
    `      if (!agentId) return;\n` +
    `\n` +
    `      const sessionInfo = await resolveSessionInfo(agentId, sessionKey);\n` +
    `      const sessionId = normalize(sessionInfo && sessionInfo.sessionId);\n` +
    `      if (!sessionId) return;\n` +
    `\n` +
    `      if (!allowTrigger('agent_end', agentId, sessionId)) return;\n` +
    `\n` +
    `      spawnSync({\n` +
    `        args: ['sync', '--auto', '--from-openclaw'],\n` +
    `        env: buildSessionEnv({\n` +
    `          agentId,\n` +
    `          sessionId,\n` +
    `          sessionKey,\n` +
    `          sessionEntry: sessionInfo && sessionInfo.entry\n` +
    `        })\n` +
    `      });\n` +
    `    } catch (_) {}\n` +
    `  });\n` +
    `\n` +
    `  api.on('gateway_start', async () => {\n` +
    `    try {\n` +
    `      if (!allowTrigger('gateway_start', 'gateway', 'startup')) return;\n` +
    `      spawnSync({ args: ['sync', '--auto', '--from-openclaw'] });\n` +
    `    } catch (_) {}\n` +
    `  });\n` +
    `\n` +
    `  api.on('gateway_stop', async () => {\n` +
    `    try {\n` +
    `      if (!allowTrigger('gateway_stop', 'gateway', 'stop')) return;\n` +
    `      spawnSync({ args: ['sync', '--auto', '--from-openclaw'] });\n` +
    `    } catch (_) {}\n` +
    `  });\n` +
    `}\n` +
    `\n` +
    `function spawnSync({ args, env = {} }) {\n` +
    `  const hasLocalRuntime = fs.existsSync(trackerBinPath);\n` +
    `  const hasLocalDeps = fs.existsSync(depsMarkerPath);\n` +
    `  const argv = Array.isArray(args) && args.length > 0 ? args : ['sync', '--auto'];\n` +
    `  const cmd = hasLocalRuntime && hasLocalDeps\n` +
    `    ? [process.execPath, trackerBinPath, ...argv]\n` +
    `    : ['npx', '--yes', fallbackPkg, ...argv];\n` +
    `  const child = cp.spawn(cmd[0], cmd.slice(1), {\n` +
    `    detached: true,\n` +
    `    stdio: 'ignore',\n` +
    `    env: { ...process.env, ...env }\n` +
    `  });\n` +
    `  child.unref();\n` +
    `}\n` +
    `\n` +
    `function buildSessionEnv({ agentId, sessionId, sessionKey, sessionEntry }) {\n` +
    `  const out = {\n` +
    `    TOKENTRACKER_OPENCLAW_AGENT_ID: agentId,\n` +
    `    TOKENTRACKER_OPENCLAW_PREV_SESSION_ID: sessionId,\n` +
    `    TOKENTRACKER_OPENCLAW_HOME: openclawHome\n` +
    `  };\n` +
    `  const key = normalize(sessionKey);\n` +
    `  if (key) out.TOKENTRACKER_OPENCLAW_SESSION_KEY = key;\n` +
    `  const prevTotalTokens = toNonNegativeInt(sessionEntry && sessionEntry.totalTokens);\n` +
    `  const prevInputTokens = toNonNegativeInt(sessionEntry && sessionEntry.inputTokens);\n` +
    `  const prevOutputTokens = toNonNegativeInt(sessionEntry && sessionEntry.outputTokens);\n` +
    `  const prevModel = normalize(sessionEntry && sessionEntry.model);\n` +
    `  const prevUpdatedAt = toIso(sessionEntry && sessionEntry.updatedAt);\n` +
    `  if (prevTotalTokens != null) out.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS = String(prevTotalTokens);\n` +
    `  if (prevInputTokens != null) out.TOKENTRACKER_OPENCLAW_PREV_INPUT_TOKENS = String(prevInputTokens);\n` +
    `  if (prevOutputTokens != null) out.TOKENTRACKER_OPENCLAW_PREV_OUTPUT_TOKENS = String(prevOutputTokens);\n` +
    `  if (prevModel) out.TOKENTRACKER_OPENCLAW_PREV_MODEL = prevModel;\n` +
    `  if (prevUpdatedAt) out.TOKENTRACKER_OPENCLAW_PREV_UPDATED_AT = prevUpdatedAt;\n` +
    `  return out;\n` +
    `}\n` +
    `\n` +
    `async function resolveSessionInfo(agentId, sessionKey) {\n` +
    `  const key = normalize(sessionKey);\n` +
    `  if (!key) return null;\n` +
    `  const sessionsPath = path.join(openclawHome, 'agents', agentId, 'sessions', 'sessions.json');\n` +
    `  if (fs.existsSync(sessionsPath)) {\n` +
    `    try {\n` +
    `      const raw = fs.readFileSync(sessionsPath, 'utf8');\n` +
    `      const parsed = JSON.parse(raw);\n` +
    `      if (parsed && typeof parsed === 'object') {\n` +
    `        const entry = parsed[key];\n` +
    `        if (entry && typeof entry === 'object' && normalize(entry.sessionId)) {\n` +
    `          return { sessionKey: key, sessionId: normalize(entry.sessionId), entry };\n` +
    `        }\n` +
    `      }\n` +
    `    } catch (_) {}\n` +
    `  }\n` +
    `  // OpenClaw >= 2026.9.9 keeps session state in a per-agent SQLite\n` +
    `  // database (~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite);\n` +
    `  // sessions.json is no longer written. Without this fallback the\n` +
    `  // plugin would silently no-op on every agent_end for anyone on a\n` +
    `  // current OpenClaw install (issue: openclaw migration to sqlite).\n` +
    `  return resolveSessionInfoFromSqlite(agentId, key);\n` +
    `}\n` +
    `\n` +
    `async function resolveSessionInfoFromSqlite(agentId, sessionKey) {\n` +
    `  const sqliteModule = await importSqliteSync();\n` +
    `  if (!sqliteModule) return null;\n` +
    `  const { DatabaseSync } = sqliteModule;\n` +
    `  const currentSessionQuery = "SELECT w.session_id FROM session_nodes n JOIN session_windows w ON w.session_id = n.current_session_id WHERE n.session_key = ? AND COALESCE(w.reason, '') != 'compaction'";\n` +
    `  const sessionQuery = "SELECT session_id FROM session_windows WHERE session_key = ? AND COALESCE(reason, '') != 'compaction' ORDER BY updated_at DESC LIMIT 1";\n` +
    `  const dbCandidates = [path.join(openclawHome, 'agents', agentId, 'agent', 'openclaw-agent.sqlite'), path.join(openclawHome, 'agents', agentId, 'openclaw-agent.sqlite')];\n` +
    `  for (const dbPath of dbCandidates) {\n` +
    `    if (!fs.existsSync(dbPath)) continue;\n` +
    `    let db;\n` +
    `    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (_) { continue; }\n` +
    `    try {\n` +
    `      let row;\n` +
    `      try { row = db.prepare(currentSessionQuery).get(sessionKey); } catch (_) {}\n` +
    `      if (!row || !row.session_id) row = db.prepare(sessionQuery).get(sessionKey);\n` +
    `      if (!row || !row.session_id) continue;\n` +
    `      // The passive SQLite reader owns per-event accounting; never synthesize lifetime sums.\n` +
    `      return { sessionKey, sessionId: row.session_id, entry: {} };\n` +
    `    } catch (_) {}\n` +
    `    finally { try { db.close(); } catch (_) {} }\n` +
    `  }\n` +
    `  return null;\n` +
    `}\n` +
    `\n` +
    `async function importSqliteSync() {\n` +
    `  try { return await import('node:sqlite'); } catch (_) { return null; }\n` +
    `}\n` +
    `\n` +
    `function parseAgentId(sessionKey) {\n` +
    `  const s = normalize(sessionKey);\n` +
    `  if (!s || !s.startsWith('agent:')) return null;\n` +
    `  const parts = s.split(':');\n` +
    `  return parts.length >= 2 ? normalize(parts[1]) : null;\n` +
    `}\n` +
    `\n` +
    `function allowTrigger(kind, scope, target) {\n` +
    `  const key = [kind, scope || 'na', target || 'na'].join(':');\n` +
    `  const now = Date.now();\n` +
    `  let state = {};\n` +
    `  try {\n` +
    `    state = JSON.parse(fs.readFileSync(triggerStatePath, 'utf8'));\n` +
    `    if (!state || typeof state !== 'object') state = {};\n` +
    `  } catch (_) {}\n` +
    `  const last = Number(state[key] || 0);\n` +
    `  if (Number.isFinite(last) && now - last < SESSION_TRIGGER_THROTTLE_MS) return false;\n` +
    `  state[key] = now;\n` +
    `  try {\n` +
    `    fs.mkdirSync(path.dirname(triggerStatePath), { recursive: true });\n` +
    `    fs.writeFileSync(triggerStatePath, JSON.stringify(state), 'utf8');\n` +
    `  } catch (_) {}\n` +
    `  return true;\n` +
    `}\n` +
    `\n` +
    `function normalize(v) {\n` +
    `  if (typeof v !== 'string') return null;\n` +
    `  const s = v.trim();\n` +
    `  return s.length > 0 ? s : null;\n` +
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
    `}\n`
  );
}

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

module.exports = {
  OPENCLAW_SESSION_PLUGIN_ID,
  OPENCLAW_SESSION_PLUGIN_DIRNAME,
  resolveOpenclawSessionPluginPaths,
  ensureOpenclawSessionPluginFiles,
  installOpenclawSessionPlugin,
  probeOpenclawSessionPluginState,
  removeOpenclawSessionPluginConfig,
};
