const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const pkg = require("../../package.json");

const { readJson } = require("../lib/fs");
const { readCursorStateSummary } = require("../lib/cursor-store");
const {
  readCodexNotify,
  readAcodeNotify,
  readEveryCodeNotify,
  buildCodexNotifyCmd,
  buildAcodeNotifyCmd,
  isManagedNotifyCmd,
} = require("../lib/codex-config");
const {
  isClaudeHookConfigured,
  areClaudeUsageHooksConfigured,
  buildClaudeHookCommand,
  buildHookCommand,
} = require("../lib/claude-config");
const {
  resolveGeminiConfigDir,
  resolveGeminiSettingsPath,
  isGeminiHookConfigured,
  buildGeminiHookCommand,
} = require("../lib/gemini-config");
const {
  resolveOpencodeConfigDir,
  isOpencodePluginInstalled,
} = require("../lib/opencode-config");
const { collectLocalSubscriptions } = require("../lib/subscriptions");
const {
  describeCopilotOtelStatus,
  readCopilotOauthToken,
} = require("../lib/usage-limits");
const {
  normalizeState: normalizeUploadState,
} = require("../lib/upload-throttle");
const { collectTrackerDiagnostics } = require("../lib/diagnostics");
const { detectPassiveProviders, isPassiveModeActive } = require("../lib/passive-mode");
const { probeOpenclawHookState } = require("../lib/openclaw-hook");
const {
  probeOpenclawSessionPluginState,
} = require("../lib/openclaw-session-plugin");
const { resolveTrackerPaths } = require("../lib/tracker-paths");
const {
  resolveKimiWireFiles,
  resolveKimiCodeWireFiles,
  resolveKiroCliDbPath,
  resolveKiroCliSessionFiles,
  resolveKiroBasePath,
  resolveKiroDbPath,
  resolveKiroJsonlPath,
  resolveCodebuddyHome,
  resolveCodebuddyProjectFiles,
  resolveWorkbuddyHome,
  resolveWorkbuddyProjectFiles,
  resolveOmpSessionFiles,
  resolveOmpAgentDir,
  resolvePiSessionFiles,
  resolvePiAgentDir,
  piAgentDirCollidesWithOmp,
  resolvePrimeAgentSessionFiles,
  resolvePrimeAgentDir,
  resolveCraftSessionFiles,
  resolveCraftConfigDir,
  resolveReasonixHome,
  resolveReasonixTelemetryFiles,
  resolveKilocodeTaskFiles,
  resolveRoocodeTaskFiles,
  resolveZedDbPath,
  resolveLmstudioHome,
  resolveLmstudioLogFiles,
  resolveUnslothDbPath,
  resolveQoderDbPaths,
  resolveQoderCnDbPaths,
  resolveQoderProjectsDir,
  resolveQoderCnProjectsDir,
  listQoderNewSessionFiles,
  resolveClaudeScienceDbPaths,
  resolveAnythingllmDbPath,
  resolveGooseDbPath,
  listDroidSettingsFiles,
  resolveDroidSessionsDir,
  resolveDshHomes,
  resolveDshSessionFiles,
  resolveTraeStoragePath,
  readTraeEntitlementFromStorage,
  resolveGrokBuildSessions,
  resolveHermesPath,
  resolveHermesDbPath,
  resolveCopilotSessionStorePaths,
  describeCopilotSessionStoreDb,
  resolveCopilotAppDbPath,
  resolveCopilotAppDbPaths,
  probeWslDistros,
} = require("../lib/rollout");
const {
  TRAE_CN_USAGE_ENV,
  isTraeCnUsageEnabled,
  resolveTraeCnStoragePath,
  readTraeCnAuthFromStorage,
  extractTraeCnToken,
} = require("../lib/trae-cn-config");
const wsl = require("../lib/wsl-probe");
const { getWslMode, isInvalidWslMode, shouldProbeWsl, discoverWslHome } = wsl;
const { resolveInstallPaths, resolveZcodeNativeDbPath } = require("../lib/install-resolver");
const { probeGrokHookState, resolveGrokHome } = require("../lib/grok-hook");
const { probeOmpHookState } = require("../lib/omp-hook");

// `filename` may be a list, in which case the first child that exists wins. A
// resolver using requireAnyChild accepts a root that holds ANY of several
// children, so probing only the first one here would report "not detected" for
// an install sync happily counts (e.g. Codex with archived_sessions/ but no
// live sessions/).
function formatResolvedPaths(paths, filename) {
  const candidates = filename == null ? [] : (Array.isArray(filename) ? filename : [filename]);
  const resolveFile = (root) => {
    if (candidates.length === 0) return root;
    for (const candidate of candidates) {
      const file = path.join(root, candidate);
      try { if (fssync.existsSync(file)) return file; } catch (_e) {}
    }
    return null;
  };
  const active = [];
  for (const [label, root] of [["native", paths.native], ["WSL", paths.wsl]]) {
    if (!root) continue;
    const file = resolveFile(root);
    if (!file) continue;
    try { if (fssync.existsSync(file)) active.push(`${label}: ${file}`); } catch (_e) {}
  }
  return active;
}

// Combine a legacy DB path with its new-JSONL projects-dir path for the
// machine-readable summary. Either side may be "" (absent); both absent
// yields "" so callers can fall back to "not found".
function summarizeQoderDetail(dbPath, newPath) {
  return [dbPath, newPath].filter(Boolean).join(" + ") || "";
}

// The Trae SOLO entitlement snapshot is read directly from the Trae Local
// State storage.json via the shared parser (readTraeEntitlementFromStorage).
// The queue.jsonl contract is token-count-only (CLAUDE.md privacy rule), so
// plan/limits metadata is never persisted into queue rows — this is the read
// side of that contract so users can actually see the advertised plan data.
function formatTraeEntitlementLine(ent) {
  const parts = [];
  if (ent.identity) parts.push(`plan ${ent.identity}`);
  if (ent.pro_period) parts.push(`${ent.pro_period} period`);
  if (typeof ent.is_dollar_billing === "boolean") {
    parts.push(ent.is_dollar_billing ? "dollar billing" : "package billing");
  }
  if (typeof ent.enable_solo_builder === "boolean") {
    parts.push(`solo builder: ${ent.enable_solo_builder ? "yes" : "no"}`);
  }
  if (typeof ent.enable_solo_coder === "boolean") {
    parts.push(`solo coder: ${ent.enable_solo_coder ? "yes" : "no"}`);
  }
  if (typeof ent.fast_request_per === "number") {
    parts.push(`${ent.fast_request_per} fast requests/hr`);
  }
  if (ent.in_waitlist === true) parts.push("in waitlist");
  if (ent.captured_at) parts.push(`snapshot ${ent.captured_at}`);
  return parts.length ? parts.join(", ") : "unknown";
}

async function cmdStatus(argv = []) {
  const opts = parseArgs(argv);
  if (opts.diagnostics) {
    const diagnostics = await collectTrackerDiagnostics();
    process.stdout.write(JSON.stringify(diagnostics, null, 2) + "\n");
    return;
  }

  const home = os.homedir();
  const { trackerDir, binDir } = await resolveTrackerPaths({ home });
  const configPath = path.join(trackerDir, "config.json");
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const queueStatePath = path.join(trackerDir, "queue.state.json");
  const cursorsPath = path.join(trackerDir, "cursors.json");
  const notifySignalPath = path.join(trackerDir, "notify.signal");
  const openclawSignalPath = path.join(trackerDir, "openclaw.signal");
  const throttlePath = path.join(trackerDir, "sync.throttle");
  const uploadThrottlePath = path.join(trackerDir, "upload.throttle.json");
  const autoRetryPath = path.join(trackerDir, "auto.retry.json");
  const syncSkipPath = path.join(trackerDir, "sync.skip.json");
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const acodeHome = process.env.TOKENTRACKER_ACODE_HOME || path.join(home, ".acode");
  const acodeConfigPath = path.join(acodeHome, "config.toml");
  const codeHome = process.env.CODE_HOME || path.join(home, ".code");
  const codeConfigPath = path.join(codeHome, "config.toml");
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  const codebuddySettingsPath = path.join(
    resolveCodebuddyHome(process.env) || path.join(home, ".codebuddy"),
    "settings.json",
  );
  const workbuddySettingsPath = path.join(
    resolveWorkbuddyHome(process.env) || path.join(home, ".workbuddy"),
    "settings.json",
  );
  const geminiConfigDir = resolveGeminiConfigDir({ home, env: process.env });
  const geminiSettingsPath = resolveGeminiSettingsPath({
    configDir: geminiConfigDir,
  });
  const opencodeConfigDir = resolveOpencodeConfigDir({
    home,
    env: process.env,
  });
  const notifyPath = path.join(binDir, "notify.cjs");
  const codexNotifyCmd = buildCodexNotifyCmd(notifyPath);
  const acodeNotifyCmd = buildAcodeNotifyCmd(notifyPath);
  const claudeHookCommand = buildClaudeHookCommand(notifyPath);
  const codebuddyHookCommand = buildHookCommand(notifyPath, "codebuddy");
  const workbuddyHookCommand = buildHookCommand(notifyPath, "workbuddy");
  const geminiHookCommand = buildGeminiHookCommand(notifyPath);

  const config = await readJson(configPath);
  const { cursors } = await readCursorStateSummary({ trackerDir, cursorsPath });
  const queueState = (await readJson(queueStatePath)) || { offset: 0 };
  const uploadThrottle = normalizeUploadState(
    await readJson(uploadThrottlePath),
  );
  const autoRetry = await readJson(autoRetryPath);
  // Written by sync whenever it had to skip a run. Present here so a stalled
  // parse has a visible cause instead of only a frozen "Last parse".
  const syncSkip = await readJson(syncSkipPath);

  const queueSize = await safeStatSize(queuePath);
  const pendingBytes = Math.max(0, queueSize - (queueState.offset || 0));

  const lastNotify = (await safeReadText(notifySignalPath))?.trim() || null;
  const lastOpenclawSync =
    (await safeReadText(openclawSignalPath))?.trim() || null;
  const lastNotifySpawn = parseEpochMsToIso(
    (await safeReadText(throttlePath))?.trim() || null,
  );

  const codexNotify = await readCodexNotify(codexConfigPath);
  // Not arraysEqual: argv[0] and binDir differ between the desktop app and a
  // terminal `tokentracker` run, so a correctly-installed integration would
  // otherwise report as not configured. See isManagedNotifyCmd.
  const notifyConfigured = isManagedNotifyCmd(codexNotify, codexNotifyCmd);
  const acodeNotify = await readAcodeNotify(acodeConfigPath);
  const acodeConfigured = isManagedNotifyCmd(acodeNotify, acodeNotifyCmd);
  const everyCodeNotify = await readEveryCodeNotify(codeConfigPath);
  const everyCodeConfigured =
    Array.isArray(everyCodeNotify) && everyCodeNotify.length > 0;
  const claudeHookConfigured = await areClaudeUsageHooksConfigured({
    settingsPath: claudeSettingsPath,
    hookCommand: claudeHookCommand,
  });
  const codebuddyHookConfigured = await isClaudeHookConfigured({
    settingsPath: codebuddySettingsPath,
    hookCommand: codebuddyHookCommand,
  });
  const workbuddyHookConfigured = await isClaudeHookConfigured({
    settingsPath: workbuddySettingsPath,
    hookCommand: workbuddyHookCommand,
  });
  const geminiHookConfigured = await isGeminiHookConfigured({
    settingsPath: geminiSettingsPath,
    hookCommand: geminiHookCommand,
  });
  const opencodePluginConfigured = await isOpencodePluginInstalled({
    configDir: opencodeConfigDir,
  });
  const openclawSessionPluginState = await probeOpenclawSessionPluginState({
    home,
    trackerDir,
    env: process.env,
  });
  const openclawHookState = await probeOpenclawHookState({
    home,
    trackerDir,
    env: process.env,
  });

  const lastUpload = uploadThrottle.lastSuccessMs
    ? parseEpochMsToIso(uploadThrottle.lastSuccessMs)
    : typeof queueState.updatedAt === "string"
      ? queueState.updatedAt
      : null;
  const nextUpload = parseEpochMsToIso(uploadThrottle.nextAllowedAtMs || null);
  const backoffUntil = parseEpochMsToIso(uploadThrottle.backoffUntilMs || null);
  const lastUploadError = uploadThrottle.lastError
    ? `${uploadThrottle.lastErrorAt || "unknown"} ${uploadThrottle.lastError}`
    : null;
  const syncSkipLine = syncSkip?.at
    ? `- Last sync skipped: ${syncSkip.at} (${syncSkip.reason || "unknown"}${
        syncSkip.detail ? `, ${syncSkip.detail}` : ""
      })`
    : null;
  const autoRetryAt = parseEpochMsToIso(autoRetry?.retryAtMs || null);
  const autoRetryLine = autoRetryAt
    ? `- Auto retry after: ${autoRetryAt} (${autoRetry?.reason || "scheduled"}, pending ${Number(
        autoRetry?.pendingBytes || 0,
      )} bytes)`
    : null;

  const subscriptions = await collectLocalSubscriptions({
    home,
    env: process.env,
    probeKeychain: opts.probeKeychain,
    probeKeychainDetails: opts.probeKeychainDetails,
  });
  const subscriptionLines =
    subscriptions.length > 0 ? subscriptions.map(formatSubscriptionLine) : [];

  const kimiWireFiles = resolveKimiWireFiles(process.env);
  const kimiHome = process.env.KIMI_HOME || path.join(home, ".kimi");
  const kimiInstalled = fssync.existsSync(path.join(kimiHome, "sessions"));

  const kimiCodeWireFiles = resolveKimiCodeWireFiles(process.env);
  const kimiCodeHome = process.env.KIMI_CODE_HOME || path.join(home, ".kimi-code");
  const kimiCodeInstalled = fssync.existsSync(path.join(kimiCodeHome, "sessions"));

  // Kiro CLI — reads the legacy SQLite/session files and Kiro CLI 2.13+
  // event sessions. End-user dashboards show them merged under "Kiro"; this
  // status line surfaces which passive sources are actually present.
  const kiroCliDbPath = resolveKiroCliDbPath(process.env);
  const kiroCliSessionFiles = resolveKiroCliSessionFiles(process.env);
  const kiroCliNativePresent =
    fssync.existsSync(kiroCliDbPath) || kiroCliSessionFiles.length > 0;
  // WSL install discovery mirrors sync: overrides pin a single install.
  let kiroCliWsl = null; // { db, sessionFiles }
  if (
    process.platform === "win32" &&
    !process.env.KIRO_CLI_DB_PATH && !process.env.KIRO_HOME &&
    wsl.shouldProbeWsl(process.env)
  ) {
    const wslKiroHomeDir = wsl.discoverWslHome(".kiro");
    const wslCliDataDir = wsl.discoverWslHome(".local/share/kiro-cli");
    const wslHomeRoot = wslKiroHomeDir
      ? path.dirname(wslKiroHomeDir)
      : (wslCliDataDir ? path.dirname(path.dirname(path.dirname(wslCliDataDir))) : null);
    if (wslHomeRoot) {
      const wslDb = path.join(wslHomeRoot, ".local", "share", "kiro-cli", "data.sqlite3");
      const wslFiles = resolveKiroCliSessionFiles({
        ...process.env,
        KIRO_CLI_DB_PATH: wslDb,
        KIRO_HOME: path.join(wslHomeRoot, ".kiro"),
      });
      if (fssync.existsSync(wslDb) || wslFiles.length > 0) {
        kiroCliWsl = { db: wslDb, sessionFiles: wslFiles };
      }
    }
  }
  const kiroCliPaths = process.platform === "win32"
    ? wsl.resolveAllWin32Paths({
      nativeValue: kiroCliNativePresent ? kiroCliDbPath : null,
      wslValue: kiroCliWsl ? kiroCliWsl.db : null,
      env: process.env,
      platform: "win32",
    })
    : { native: kiroCliNativePresent ? kiroCliDbPath : null, wsl: null };
  // Non-both modes park the picked value in the native slot — label by
  // marker identity, not slot name. A session-files-only install has no DB
  // on disk; show the sessions dir instead of a nonexistent DB path.
  const kiroCliMarkers = [kiroCliPaths.native, kiroCliPaths.wsl].filter(Boolean);
  const kiroCliActive = kiroCliMarkers.map((m) => {
    if (kiroCliWsl && m === kiroCliWsl.db) {
      const shown = fssync.existsSync(m) || kiroCliWsl.sessionFiles.length === 0
        ? m
        : path.dirname(kiroCliWsl.sessionFiles[0]);
      return `WSL: ${shown}`;
    }
    const shown = fssync.existsSync(m) || kiroCliSessionFiles.length === 0
      ? m
      : path.dirname(kiroCliSessionFiles[0]);
    return `native: ${shown}`;
  });
  const kiroCliFileCount =
    (kiroCliMarkers.includes(kiroCliDbPath) ? kiroCliSessionFiles.length : 0) +
    (kiroCliWsl && kiroCliMarkers.includes(kiroCliWsl.db) ? kiroCliWsl.sessionFiles.length : 0);
  const kiroCliDbFound = kiroCliMarkers.some((m) => {
    try { return fssync.existsSync(m); } catch (_e) { return false; }
  });
  const kiroCliInstalled = kiroCliMarkers.length > 0;

  // Kiro IDE — passive scan of globalStorage dev_data (SQLite or JSONL).
  const kiroIdeNativeBase = resolveKiroBasePath(process.env);
  const wslKiroIdeBase = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
    ? wsl.discoverWslHome(".config/Kiro/User/globalStorage/kiro.kiroagent")
    : null;
  const kiroIdePaths = resolveInstallPaths({ nativeValue: kiroIdeNativeBase, wslValue: wslKiroIdeBase });
  const kiroIdeHasData = (base) => Boolean(base)
    && (fssync.existsSync(resolveKiroDbPath(base)) || fssync.existsSync(resolveKiroJsonlPath(base)));
  const kiroIdeActive = [kiroIdePaths.native, kiroIdePaths.wsl]
    .filter((base) => kiroIdeHasData(base))
    .map((base) => (wslKiroIdeBase && base === wslKiroIdeBase ? `WSL: ${base}` : `native: ${base}`));
  const kiroIdeInstalled = kiroIdeActive.length > 0;

  // Claude Code — dual-install aware projects scan (#307). Mirrors sync:
  // installs are UNIONED (not single-picked by mode) so a WSL ~/.claude
  // never hides the native one from view, and labels come from install
  // identity rather than resolveAllWin32Paths' slot names.
  const claudeCodeActive = [];
  {
    const claudeHomesStatus = [];
    if (process.platform !== "win32" || wsl.shouldProbeNative(process.env)) {
      claudeHomesStatus.push({ dir: path.join(home, ".claude"), label: "native" });
    }
    const wslClaudeHomeStatus = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
      ? wsl.discoverWslHome(".claude")
      : null;
    if (wslClaudeHomeStatus) claudeHomesStatus.push({ dir: wslClaudeHomeStatus, label: "WSL" });
    for (const { dir, label } of claudeHomesStatus) {
      const projects = path.join(dir, "projects");
      try {
        if (fssync.existsSync(projects)) claudeCodeActive.push(`${label}: ${projects}`);
      } catch (_e) {}
    }
  }
  const claudeCodeInstalled = claudeCodeActive.length > 0;

  // AnythingLLM Desktop — per-message token metrics in workspace_chats.
  const anythingllmDbPath = resolveAnythingllmDbPath(process.env);
  const anythingllmInstalled = Boolean(
    anythingllmDbPath && fssync.existsSync(anythingllmDbPath),
  );

  // CodeBuddy — passive scan only (no hooks). Surface the file count so
  // operators can confirm JSONL sessions and extension logs are discovered.
  const codebuddyHome = resolveCodebuddyHome(process.env);
  const codebuddyInstalled = Boolean(codebuddyHome && fssync.existsSync(codebuddyHome));
  const codebuddyFiles = codebuddyInstalled
    ? resolveCodebuddyProjectFiles(process.env)
    : [];

  // WorkBuddy — passive scan (sibling Claude-Code fork). Surface both the
  // recursive JSONL count and SQLite fallback so operators can confirm coverage.
  const workbuddyHome = resolveWorkbuddyHome(process.env);
  const workbuddyInstalled = Boolean(workbuddyHome && fssync.existsSync(workbuddyHome));
  const workbuddyFiles = workbuddyInstalled
    ? resolveWorkbuddyProjectFiles(process.env)
    : [];
  const workbuddyDbExists = workbuddyInstalled
    ? fssync.existsSync(path.join(workbuddyHome, "workbuddy.db"))
    : false;

  // oh-my-pi — passive scan + optional notify extension.
  const ompAgentDir = resolveOmpAgentDir(process.env);
  const ompInstalled = Boolean(ompAgentDir) && fssync.existsSync(path.join(ompAgentDir, "sessions"));
  const ompFiles = ompInstalled ? resolveOmpSessionFiles(process.env) : [];
  const ompHookState = await probeOmpHookState({ home, trackerDir, env: process.env });

  // pi (@mariozechner/pi-coding-agent) — passive scan only (no hooks).
  // Skip when its agent dir collides with omp's; sync would dedupe anyway.
  const piCollides = piAgentDirCollidesWithOmp(process.env);
  const piAgentDir = resolvePiAgentDir(process.env);
  const piInstalled = !piCollides && Boolean(piAgentDir) && fssync.existsSync(path.join(piAgentDir, "sessions"));
  const piFiles = piInstalled ? resolvePiSessionFiles(process.env) : [];

  // Prime Agent — passive scan only (no hooks).
  const primeAgentDir = resolvePrimeAgentDir(process.env);
  const primeAgentInstalled = Boolean(primeAgentDir) && fssync.existsSync(path.join(primeAgentDir, "sessions"));
  const primeAgentFiles = primeAgentInstalled ? resolvePrimeAgentSessionFiles(process.env) : [];

  // Craft Agents — passive scan only (no hooks).
  const craftConfigDir = resolveCraftConfigDir(process.env);
  const craftInstalled = Boolean(craftConfigDir && fssync.existsSync(craftConfigDir));
  const craftFiles = craftInstalled ? resolveCraftSessionFiles(process.env) : [];

  // Reasonix — passive scan of content-free cumulative telemetry sidecars.
  const reasonixHome = resolveReasonixHome(process.env);
  const reasonixInstalled = Boolean(reasonixHome && fssync.existsSync(reasonixHome));
  const reasonixFiles = reasonixInstalled ? resolveReasonixTelemetryFiles(process.env) : [];

  // Kilo CLI (kilo.ai @kilocode/plugin) — passive scan of kilo.db.
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const kiloHome = process.env.KILO_HOME || path.join(xdgDataHome, "kilo");
  const kiloNativeValue = process.platform === "win32" && typeof process.env.APPDATA === "string"
    ? path.join(process.env.APPDATA.trim(), "kilo", "kilo.db")
    : path.join(kiloHome, "kilo.db");
  const wslKiloDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
    ? wsl.discoverWslHome(".local/share/kilo")
    : null;
  const kiloPaths = resolveInstallPaths({ nativeValue: kiloNativeValue, wslValue: wslKiloDir ? path.join(wslKiloDir, "kilo.db") : null });
  const kiloActive = formatResolvedPaths(kiloPaths);
  const kiloInstalled = kiloActive.length > 0;
  const kiloDbPath = kiloActive.join(" | ");

  // Mimo (mimocode — OpenCode-fork SQLite) — passive scan of mimocode.db.
  const mimoHome = process.env.MIMO_HOME || path.join(xdgDataHome, "mimocode");
  const mimoNativeValue = process.platform === "win32" && typeof process.env.APPDATA === "string"
    ? path.join(process.env.APPDATA.trim(), "mimocode", "mimocode.db")
    : path.join(mimoHome, "mimocode.db");
  const wslMimoDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
    ? wsl.discoverWslHome(".local/share/mimocode")
    : null;
  const mimoPaths = resolveInstallPaths({ nativeValue: mimoNativeValue, wslValue: wslMimoDir ? path.join(wslMimoDir, "mimocode.db") : null });
  const mimoActive = formatResolvedPaths(mimoPaths);
  const mimoInstalled = mimoActive.length > 0;
  const mimoDbPath = mimoActive.join(" | ");

  // ZCode (Z.ai's coding agent — OpenCode-fork SQLite) — passive scan of db.sqlite.
  const zcodeNativeValue = resolveZcodeNativeDbPath({ home });
  const wslZcodeDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
    ? wsl.discoverWslHome(".zcode")
    : null;
  const zcodePaths = resolveInstallPaths({ nativeValue: zcodeNativeValue, wslValue: wslZcodeDir ? path.join(wslZcodeDir, "cli", "db", "db.sqlite") : null });
  const zcodeActive = formatResolvedPaths(zcodePaths);
  const zcodeInstalled = zcodeActive.length > 0;
  const zcodeDbPath = zcodeActive.join(" | ");

  // Qoder Desktop 1.18+ — token usage lives in SharedClientCache/local.db (legacy)
  // and since 2026-08 (app 0.1.2+) also in ~/.qoder/projects JSONL (credit-based).
  const qoderPaths = resolveQoderDbPaths({
    home,
    env: process.env,
    platform: process.platform,
  });
  const qoderActive = formatResolvedPaths(qoderPaths);
  // New JSONL location (com.qoder.app.stable + ~/.qoder/projects)
  const qoderProjectsDirResolved = resolveQoderProjectsDir({ home, env: process.env });
  let qoderNewFiles = [];
  try {
    qoderNewFiles = await listQoderNewSessionFiles(qoderProjectsDirResolved);
  } catch (_e) {
    qoderNewFiles = [];
  }
  const qoderNewInstalled = qoderNewFiles.length > 0;
  const qoderInstalled = qoderActive.length > 0 || qoderNewInstalled;
  const qoderDbPath = qoderActive.join(" | ");
  const qoderNewPath = qoderNewFiles.length > 0
    ? `${qoderProjectsDirResolved} (${qoderNewFiles.length} sessions)`
    : "";

  // Qoder CN (国内版) — same schema, separate Application Support/QoderCN dir.
  const qoderCnPaths = resolveQoderCnDbPaths({
    home,
    env: process.env,
    platform: process.platform,
  });
  const qoderCnActive = formatResolvedPaths(qoderCnPaths);
  // CN new-JSONL mirrors sync.js: CN and international currently share
  // ~/.qoder/projects, and sync only parses the CN dir when it diverges from
  // the international one (same files must not count under two sources). Only
  // report CN JSONL when the dirs diverge.
  const qoderCnProjectsDirResolved = resolveQoderCnProjectsDir({ home, env: process.env });
  const qoderCnSharesIntlDir = path.normalize(qoderCnProjectsDirResolved) === path.normalize(qoderProjectsDirResolved)
    || (process.platform === "win32"
      && path.normalize(qoderCnProjectsDirResolved).toLowerCase() === path.normalize(qoderProjectsDirResolved).toLowerCase());
  let qoderCnNewFiles = [];
  if (!qoderCnSharesIntlDir) {
    try {
      qoderCnNewFiles = await listQoderNewSessionFiles(qoderCnProjectsDirResolved);
    } catch (_e) {
      qoderCnNewFiles = [];
    }
  }
  const qoderCnNewInstalled = qoderCnNewFiles.length > 0;
  const qoderCnInstalled = qoderCnActive.length > 0 || qoderCnNewInstalled;
  const qoderCnDbPath = qoderCnActive.join(" | ");
  const qoderCnNewPath = qoderCnNewFiles.length > 0
    ? `${qoderCnProjectsDirResolved} (${qoderCnNewFiles.length} sessions)`
    : "";

  // Claude Science — token usage lives on the `frames` table of operon-cli.db.
  // Unlike the native/WSL pair other providers resolve to, this is an open-ended
  // list: multi-org installs keep one DB per org (and on Windows they all sit
  // inside WSL), so the resolver already returns only paths that exist.
  const claudeScienceActive = resolveClaudeScienceDbPaths({ home, env: process.env });
  const claudeScienceInstalled = claudeScienceActive.length > 0;
  const claudeScienceDbPath = claudeScienceActive.join(" | ");

  // OpenCode (JSON files + SQLite DB) — passive scan of storage/message/ and opencode.db.
  const opencodeStorageNativeValue = process.env.OPENCODE_HOME || path.join(xdgDataHome, "opencode");
  const wslOpencodeStorageDir = process.platform === "win32" && shouldProbeWsl(process.env)
    ? discoverWslHome(".local/share/opencode")
    : null;
  const opencodeStoragePaths = resolveInstallPaths({
    nativeValue: opencodeStorageNativeValue,
    wslValue: wslOpencodeStorageDir,
  });
  const opencodeStorageActive = formatResolvedPaths(opencodeStoragePaths);

  const opencodeDbNativeValue = process.env.OPENCODE_HOME || path.join(xdgDataHome, "opencode");
  const wslOpencodeDbDir = process.platform === "win32" && shouldProbeWsl(process.env)
    ? discoverWslHome(".local/share/opencode")
    : null;
  const opencodeDbPaths = resolveInstallPaths({
    nativeValue: opencodeDbNativeValue,
    wslValue: wslOpencodeDbDir,
  });
  const opencodeDbActive = formatResolvedPaths(opencodeDbPaths, "opencode.db");
  const opencodeInstalled = opencodeStorageActive.length > 0 || opencodeDbActive.length > 0;

  // Every Code (passive sessions scan)
  const codePaths = resolveInstallPaths({
    nativeValue: process.env.CODE_HOME || path.join(home, ".code"),
    wslDir: ".code",
  });
  const codeActive = formatResolvedPaths(codePaths, "sessions");
  const codeInstalled = codeActive.length > 0;

  // Gemini CLI & Antigravity (shared home)
  const geminiPaths = resolveInstallPaths({
    nativeValue: process.env.GEMINI_HOME || path.join(home, ".gemini"),
    wslDir: ".gemini",
  });
  const geminiActive = formatResolvedPaths(geminiPaths);
  const geminiInstalledStatus = geminiActive.length > 0;

  // Gemini CLI (passive sessions scan)
  const geminiCliActive = formatResolvedPaths(geminiPaths, "tmp");
  const geminiCliInstalled = geminiCliActive.length > 0;

  // Antigravity (passive brains scan)
  const antigravityActive = [];
  if (geminiPaths.native) {
    const dirs = [
      path.join(geminiPaths.native, "antigravity", "brain"),
      path.join(geminiPaths.native, "antigravity-ide", "brain"),
      path.join(geminiPaths.native, "antigravity-cli", "brain"),
    ];
    if (dirs.some(d => { try { return fssync.existsSync(d); } catch (_) { return false; } })) {
      antigravityActive.push(`native: ${geminiPaths.native}`);
    }
  }
  if (geminiPaths.wsl) {
    const dirs = [
      path.join(geminiPaths.wsl, "antigravity", "brain"),
      path.join(geminiPaths.wsl, "antigravity-ide", "brain"),
      path.join(geminiPaths.wsl, "antigravity-cli", "brain"),
    ];
    if (dirs.some(d => { try { return fssync.existsSync(d); } catch (_) { return false; } })) {
      antigravityActive.push(`WSL: ${geminiPaths.wsl}`);
    }
  }
  const antigravityInstalled = antigravityActive.length > 0;

  // Codex CLI (passive sessions scan). Mirrors the sync resolution exactly
  // (union + requireAnyChild, see src/commands/sync.js): status is the tool
  // users are asked to paste when Codex usage looks wrong, so it must list
  // every root sync actually walks — and no empty shell sync would skip.
  const codexPaths = resolveInstallPaths({
    nativeValue: process.env.CODEX_HOME || path.join(home, ".codex"),
    wslDir: ".codex",
    requireAnyChild: ["sessions", "archived_sessions"],
    union: true,
  });
  // Both children, matching requireAnyChild above: an install holding only
  // archived_sessions/ is counted by sync and must not read as "not detected".
  const codexActive = formatResolvedPaths(codexPaths, ["sessions", "archived_sessions"]);
  const codexInstalledStatus = codexActive.length > 0;

  const acodePaths = resolveInstallPaths({
    nativeValue: acodeHome,
    wslDir: ".acode",
    requireAnyChild: ["sessions", "archived_sessions"],
    union: true,
  });
  const acodeActive = formatResolvedPaths(acodePaths, ["sessions", "archived_sessions"]);
  const acodeInstalled = acodeActive.length > 0;

  // Kimi (passive sessions scan)
  const kimiPaths = resolveInstallPaths({
    nativeValue: path.join(home, ".kimi"),
    wslDir: ".kimi",
  });
  const kimiActive = formatResolvedPaths(kimiPaths, "sessions");

  // Kilo Code VS Code extension — passive scan of all VS Code-family
  // globalStorage/kilocode.kilo-code/tasks/ ui_messages.json files.
  const kilocodeTaskFiles = resolveKilocodeTaskFiles(process.env);
  const kilocodeInstalled = kilocodeTaskFiles.length > 0;

  // Roo Code VS Code extension — same Cline-derived ui_messages.json format,
  // different globalStorage subdir (rooveterinaryinc.roo-cline).
  const roocodeTaskFiles = resolveRoocodeTaskFiles(process.env);
  const roocodeInstalled = roocodeTaskFiles.length > 0;

  // Zed Agent — passive read of threads.db across all model providers
  // (hosted "zed.dev" and bring-your-own alike). threadTotals tracks one entry
  // per thread we've surfaced usage for, so its size distinguishes "DB present
  // with usage" from "DB present but nothing counted yet" (fresh/undecodable).
  const zedDbPath = resolveZedDbPath(process.env);
  const zedInstalled = Boolean(zedDbPath && fssync.existsSync(zedDbPath));
  const zedThreadsCounted =
    cursors?.zed?.threadTotals && typeof cursors.zed.threadTotals === "object"
      ? Object.keys(cursors.zed.threadTotals).length
      : 0;

  // Goose (Block) — passive cumulative-delta read of sessions.db.
  const gooseDbPath = resolveGooseDbPath(process.env);
  const gooseInstalled = Boolean(gooseDbPath && fssync.existsSync(gooseDbPath));

  // Droid (Factory CLI) — passive cumulative-delta read of *.settings.json.
  const droidSessionsDir = resolveDroidSessionsDir(process.env);
  const droidSettingsFiles = listDroidSettingsFiles(process.env);
  const droidInstalled = droidSettingsFiles.length > 0;
  const dshHomes = resolveDshHomes(process.env);
  const dshSessionsDir = dshHomes.map((homeDir) => path.join(homeDir, "sessions")).join(", ");
  const dshSessionFiles = await resolveDshSessionFiles(process.env);
  const dshInstalled = dshSessionFiles.length > 0;
  const lmstudioHome = resolveLmstudioHome(process.env);
  const lmstudioLogFiles = await resolveLmstudioLogFiles(process.env);
  const lmstudioInstalled = lmstudioLogFiles.length > 0;
  const unslothDbPath = resolveUnslothDbPath(process.env);
  const unslothInstalled = Boolean(unslothDbPath && fssync.existsSync(unslothDbPath));

  // Trae SOLO (ByteDance AI IDE) — passive entitlement snapshot reader.
  const traeStoragePath = resolveTraeStoragePath(process.env);
  const traeInstalled = Boolean(traeStoragePath);
  // Render path for the entitlement snapshot: read it straight from the
  // Trae Local State storage.json via the shared parser. The queue stays
  // token-count-only, so the status read path never depends on queue rows
  // carrying plan/limits metadata.
  const traeEntitlement = traeInstalled
    ? readTraeEntitlementFromStorage(traeStoragePath)
    : null;

  // Trae SOLO CN — opt-in usage-API reader. Unlike the passive entitlement
  // reader above, this source sends the locally stored sign-in JWT to TRAE's
  // official API, so status surfaces the opt-in flag, the resolved storage
  // path, and whether the auth blob decrypts — the three inputs a "why is my
  // TRAE CN data missing" diagnosis needs.
  // A resolvable default path does NOT mean the app is installed - the
  // macOS/Windows resolver always derives one. Match the sync path semantics
  // exactly: installed iff the storage file actually exists on disk.
  const traeCnStoragePath = resolveTraeCnStoragePath({ env: process.env, home });
  const traeCnInstalled = Boolean(
    traeCnStoragePath && fssync.existsSync(traeCnStoragePath),
  );
  let traeCnAuthState = "not-signed-in";
  if (traeCnInstalled) {
    try {
      const traeCnAuth = readTraeCnAuthFromStorage({ env: process.env, home, platform: process.platform });
      if (traeCnAuth) {
        extractTraeCnToken(traeCnAuth);
        traeCnAuthState = "readable";
      }
    } catch (error) {
      // Distinguish a real IO failure (unreadable) from present-but-bad
      // data (malformed); neither ever carries storage contents.
      traeCnAuthState = error?.code === "TRAE_CN_STORAGE_UNREADABLE" ? "unreadable" : "malformed";
    }
  }
  const traeCnUsageOptIn = isTraeCnUsageEnabled(process.env);

  // Grok Build (xAI TUI)
  const grokHookState = await probeGrokHookState({ home, trackerDir, env: process.env });
  const grokSessions = grokHookState.hasGrokInstall || grokHookState.sessionsDir
    ? resolveGrokBuildSessions(process.env)
    : [];
  const grokInstalled = grokHookState.hasGrokInstall || grokSessions.length > 0;

  // Hermes Agent — SQLite state.db, resolved via override / native Windows
  // install / WSL auto-discovery. Surface the resolved path (UNC included) and,
  // on Windows, the discovered distros so WSL users can debug "why no sync"
  // without guessing the right UNC alias (#87).
  const hermesPaths = resolveInstallPaths({
    nativeValue: process.env.TOKENTRACKER_HERMES_HOME || (process.platform === "win32" && typeof process.env.LOCALAPPDATA === "string"
      ? path.join(process.env.LOCALAPPDATA.trim(), "hermes")
      : path.join(home, ".hermes")),
    wslDir: ".hermes",
  });
  const hermesActive = formatResolvedPaths(hermesPaths, "state.db");
  const hermesInstalled = hermesActive.length > 0;
  const hermesPath = hermesActive.join(" | ");
  const wslDistros = process.platform === "win32" && shouldProbeWsl(process.env) ? probeWslDistros() : [];

  const copilotToken = readCopilotOauthToken({ home });
  const copilotOtel = describeCopilotOtelStatus({ home, env: process.env });
  const copilotAppDbPaths = resolveCopilotAppDbPaths(process.env);
  const copilotAppExistingPaths = copilotAppDbPaths.filter((p) => {
    try { return fssync.existsSync(p); } catch (_e) { return false; }
  });
  const copilotStorePaths = Array.from(
    new Set([
      ...resolveCopilotSessionStorePaths(process.env),
      ...Object.keys(cursors?.copilotStore?.dbs || {}),
    ]),
  );
  const copilotStoreExistingPaths = copilotStorePaths.filter((p) => {
    try { return fssync.existsSync(p); } catch (_e) { return false; }
  });
  const copilotStoreDetails = [];
  const copilotStoreInspectionErrors = [];
  for (const storePath of copilotStoreExistingPaths) {
    try {
      copilotStoreDetails.push(describeCopilotSessionStoreDb(storePath));
    } catch (err) {
      copilotStoreInspectionErrors.push(
        `${storePath}: ${err && err.message ? err.message : String(err)}`,
      );
    }
  }
  const copilotStoreCursor =
    cursors?.copilotStore && typeof cursors.copilotStore === "object"
      ? cursors.copilotStore
      : {};
  const copilotStoreDbStates =
    copilotStoreCursor.dbs && typeof copilotStoreCursor.dbs === "object"
      ? copilotStoreCursor.dbs
      : {};
  const copilotStatusPathKey = (dbPath) => {
    const normalized = path.normalize(dbPath);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const existingCopilotStoreKeys = new Set(
    copilotStoreExistingPaths.map(copilotStatusPathKey),
  );
  const adoptedCopilotStores = Object.entries(copilotStoreDbStates).filter(
    ([, state]) => state?.adoptedAt,
  );
  const missingAdoptedCopilotStores = adoptedCopilotStores
    .map(([dbPath]) => dbPath)
    .filter((dbPath) => !existingCopilotStoreKeys.has(copilotStatusPathKey(dbPath)));
  const copilotStoreDegradedReasons = [
    ...missingAdoptedCopilotStores.map(
      (dbPath) => `canonical store unavailable: ${dbPath}`,
    ),
    ...copilotStoreInspectionErrors.map(
      (message) => `store inspection failed: ${message}`,
    ),
    ...Object.entries(copilotStoreDbStates)
      .filter(([, state]) => state?.lastError)
      .map(([dbPath, state]) => `${dbPath}: ${state.lastError}`),
  ];
  const malformedCopilotEvents = Object.values(copilotStoreDbStates).reduce(
    (sum, state) => sum + Math.max(0, Number(state?.malformedEventCount) || 0),
    0,
  );
  if (malformedCopilotEvents > 0) {
    copilotStoreDegradedReasons.push(
      `${malformedCopilotEvents} event${malformedCopilotEvents === 1 ? "" : "s"} lack a valid timestamp`,
    );
  }
  const copilotResetGapEvents = Object.values(copilotStoreDbStates).reduce(
    (sum, state) => sum + Math.max(0, Number(state?.resetGapEventCount) || 0),
    0,
  );
  if (copilotResetGapEvents > 0) {
    copilotStoreDegradedReasons.push(
      `${copilotResetGapEvents} event${copilotResetGapEvents === 1 ? "" : "s"} were baselined during a legacy cursor/reset race`,
    );
  }
  const copilotStoreCanonical =
    copilotStoreCursor.active === true && adoptedCopilotStores.length > 0;
  const copilotStoreDegraded = copilotStoreDegradedReasons.length > 0;
  const copilotStoreStatus = {
    store_paths: copilotStoreExistingPaths,
    store_path: copilotStorePaths[0] || null,
    store_has_file: copilotStoreExistingPaths.length > 0,
    store_details: copilotStoreDetails.map((detail) => ({
      path: detail.path,
      schema_version: detail.schemaVersion,
      event_count: detail.eventCount,
      last_event_id: detail.lastEventId,
      last_event_at: detail.lastEventAt,
    })),
    canonical: copilotStoreCanonical,
    source_mode: copilotStoreCanonical
      ? copilotStoreDegraded
        ? "canonical-degraded"
        : "canonical"
      : copilotStoreExistingPaths.length > 0
        ? "awaiting-adoption"
        : "legacy",
    precision: copilotStoreCanonical
      ? "exact-post-adoption; aggregate-pre-adoption"
      : "aggregate",
    coverage: copilotStoreCanonical
      ? "per-request-post-adoption; legacy-aggregate-pre-adoption"
      : "legacy-aggregate",
    malformed_event_count: malformedCopilotEvents,
    reset_gap_event_count: copilotResetGapEvents,
    degraded: copilotStoreDegraded,
    degraded_reasons: copilotStoreDegradedReasons,
    recommended_action: copilotStoreDegraded
      ? "Restore or repair the Copilot session store, then run `tokentracker sync`."
      : null,
  };
  const copilotAppStatus = {
    app_db_path: resolveCopilotAppDbPath(process.env),
    app_db_paths: copilotAppExistingPaths,
    app_db_has_file: copilotAppExistingPaths.length > 0,
    app_db_mode: copilotStoreCanonical ? "observe-only" : "legacy-writer",
  };
  const copilotLines = formatCopilotLines({
    token: copilotToken,
    otel: copilotOtel,
    sessionStore: copilotStoreStatus,
    appDb: copilotAppStatus,
  });

  // Detect passive-mode providers exactly once — both the JSON/light path
  // and the human-readable path consume this, and each call hits 5 readdir
  // syscalls (~5–10ms cold). Memoize.
  const passiveProviders = detectPassiveProviders({
    home,
    env: process.env,
    hookStatus: {
      codex_notify: notifyConfigured,
      acode_notify: acodeConfigured,
      every_code_notify: everyCodeConfigured,
      claude: claudeHookConfigured,
      gemini: geminiHookConfigured,
      opencode_plugin: opencodePluginConfigured,
      openclaw_session_plugin: Boolean(openclawSessionPluginState?.configured),
      codebuddy: Boolean(codebuddyHookConfigured),
      workbuddy: Boolean(workbuddyHookConfigured),
      grok: Boolean(grokHookState?.configured),
    },
  });

  if (opts.json || opts.light) {
    const summary = {
      version: pkg.version,
      generated_at: new Date().toISOString(),
      base_url: config?.baseUrl || null,
      device_token_set: Boolean(config?.deviceToken),
      queue: {
        pending_bytes: pendingBytes,
        size_bytes: queueSize,
        offset: queueState.offset || 0,
      },
      last_parse: cursors?.updatedAt || null,
      last_notify: lastNotify || null,
      last_openclaw_sync: lastOpenclawSync || null,
      last_notify_spawn: lastNotifySpawn || null,
      last_upload: lastUpload || null,
      next_upload_after: nextUpload || null,
      backoff_until: backoffUntil || null,
      last_upload_error: lastUploadError || null,
      last_sync_skipped: syncSkip?.at ? syncSkip : null,
      auto_retry: autoRetry || null,
      hooks: {
        codex_notify: notifyConfigured,
        acode_notify: acodeConfigured,
        every_code_notify: everyCodeConfigured,
        claude: claudeHookConfigured,
        gemini: geminiHookConfigured,
        opencode_plugin: opencodePluginConfigured,
        openclaw_session_plugin: Boolean(openclawSessionPluginState?.configured),
        openclaw_session_plugin_conversation_access: Boolean(
          openclawSessionPluginState?.conversationAccess,
        ),
        openclaw_legacy: Boolean(openclawHookState?.configured),
        codebuddy: codebuddyInstalled ? Boolean(codebuddyHookConfigured) : null,
        workbuddy: workbuddyInstalled ? Boolean(workbuddyHookConfigured) : null,
        grok: grokInstalled ? Boolean(grokHookState?.configured) : null,
      },
      providers: {
        acode: acodeInstalled
          ? { installed: true, detail: acodeActive.join(" | ") }
          : { installed: false },
        kimi_code: kimiInstalled || kimiCodeInstalled
          ? { installed: true, files: kimiWireFiles.length + kimiCodeWireFiles.length }
          : { installed: false },
        kiro_cli: kiroCliInstalled
          ? {
              installed: true,
              detail: kiroCliActive.join(" | "),
              database: kiroCliMarkers.find((m) => {
                try { return fssync.existsSync(m); } catch (_e) { return false; }
              }) || null,
              files: kiroCliFileCount,
            }
          : { installed: false },
        kiro_ide: kiroIdeInstalled
          ? { installed: true, detail: kiroIdeActive.join(" | ") }
          : { installed: false },
        claude_code: claudeCodeInstalled
          ? { installed: true, detail: claudeCodeActive.join(" | ") }
          : { installed: false },
        codebuddy: codebuddyInstalled
          ? { installed: true, files: codebuddyFiles.length }
          : { installed: false },
        workbuddy: workbuddyInstalled
          ? { installed: true, files: workbuddyFiles.length }
          : { installed: false },
        omp: ompInstalled || ompHookState.ompPresent
          ? {
              installed: true,
              files: ompFiles.length,
              notify_extension: Boolean(ompHookState.configured),
              notify_extension_path: ompHookState.extensionPath || null,
            }
          : { installed: false },
        pi: piInstalled
          ? { installed: true, files: piFiles.length }
          : { installed: false },
        prime_agent: primeAgentInstalled
          ? { installed: true, files: primeAgentFiles.length }
          : { installed: false },
        craft: craftInstalled
          ? { installed: true, files: craftFiles.length }
          : { installed: false },
        reasonix: reasonixInstalled
          ? { installed: true, files: reasonixFiles.length }
          : { installed: false },
        anythingllm: anythingllmInstalled
          ? { installed: true, detail: anythingllmDbPath }
          : { installed: false },
        kilo_cli: kiloInstalled
          ? { installed: true, detail: kiloDbPath }
          : { installed: false },
        mimo: mimoInstalled
          ? { installed: true, detail: mimoDbPath }
          : { installed: false },
        zcode: zcodeInstalled
          ? { installed: true, detail: zcodeDbPath }
          : { installed: false },
        qoder: qoderInstalled
          ? { installed: true, detail: summarizeQoderDetail(qoderDbPath, qoderNewPath) }
          : { installed: false },
        "qoder-cn": qoderCnInstalled
          ? { installed: true, detail: summarizeQoderDetail(qoderCnDbPath, qoderCnNewPath) }
          : { installed: false },
        "claude-science": claudeScienceInstalled
          ? { installed: true, detail: claudeScienceDbPath }
          : { installed: false },
        kilocode: kilocodeInstalled
          ? { installed: true, files: kilocodeTaskFiles.length }
          : { installed: false },
        roocode: roocodeInstalled
          ? { installed: true, files: roocodeTaskFiles.length }
          : { installed: false },
        zed: zedInstalled ? { installed: true, detail: zedDbPath } : { installed: false },
        goose: gooseInstalled
          ? { installed: true, detail: gooseDbPath }
          : { installed: false },
        droid: droidInstalled
          ? { installed: true, files: droidSettingsFiles.length, detail: droidSessionsDir }
          : { installed: false },
        dsh: dshInstalled
          ? { installed: true, files: dshSessionFiles.length, detail: dshSessionsDir }
          : { installed: false },
        lmstudio: lmstudioInstalled
          ? {
              installed: true,
              files: lmstudioLogFiles.length,
              detail: path.join(lmstudioHome, "server-logs"),
            }
          : { installed: false },
        unsloth: unslothInstalled
          ? { installed: true, detail: unslothDbPath }
          : { installed: false },
        trae: traeInstalled
          ? {
              installed: true,
              detail: traeStoragePath,
              ...(traeEntitlement ? { entitlement: traeEntitlement } : {}),
            }
          : { installed: false },
        "trae-cn": traeCnInstalled
          ? {
              installed: true,
              detail: traeCnStoragePath,
              auth: traeCnAuthState,
              usage_opt_in: traeCnUsageOptIn,
            }
          : { installed: false },
        grok_build: grokInstalled
          ? {
              installed: true,
              files: grokSessions.length,
              detail: grokHookState.configured ? "hook installed" : "detected",
            }
          : { installed: false },
        hermes: {
          installed: hermesInstalled,
          detail: hermesPath,
        },
      },
      copilot: {
        token_set: Boolean(copilotToken),
        otel_has_files: Boolean(copilotOtel.otel_has_files),
        otel_path: copilotOtel.otel_path || null,
        otel_enabled: Boolean(copilotOtel.otel_enabled),
        ...copilotStoreStatus,
        ...copilotAppStatus,
      },
      passive_mode: {
        active: isPassiveModeActive(passiveProviders),
        providers: passiveProviders,
      },
      ...(process.platform === "win32"
        ? {
            wsl_mode: getWslMode(),
            wsl_mode_invalid: isInvalidWslMode(),
            wsl_distros: wslDistros.map((d) => ({ name: d.name, version: d.version })),
          }
        : {}),
      subscriptions,
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      return;
    }
    process.stdout.write(renderLightTable(summary) + "\n");
    return;
  }

  process.stdout.write(
    [
      `TokenTracker v${pkg.version}`,
      "Status:",
      `- Base URL: ${config?.baseUrl || "unset"}`,
      `- Device token: ${config?.deviceToken ? "set" : "unset"}`,
      `- Queue: ${pendingBytes} bytes pending`,
      `- Last parse: ${cursors?.updatedAt || "never"}`,
      `- Last notify: ${lastNotify || "never"}`,
      `- Last OpenClaw-triggered sync: ${lastOpenclawSync || "never"}`,
      `- Last notify-triggered sync: ${lastNotifySpawn || "never"}`,
      `- Last upload: ${lastUpload || "never"}`,
      `- Next upload after: ${nextUpload || "never"}`,
      `- Backoff until: ${backoffUntil || "never"}`,
      lastUploadError ? `- Last upload error: ${lastUploadError}` : null,
      syncSkipLine,
      autoRetryLine,
      `- Codex notify: ${notifyConfigured ? JSON.stringify(codexNotify) : "unset"}`,
      `- AStudio notify: ${acodeConfigured ? JSON.stringify(acodeNotify) : "unset"}`,
      `- Every Code notify: ${everyCodeConfigured ? JSON.stringify(everyCodeNotify) : "unset"}`,
      `- Claude hooks: ${claudeHookConfigured ? "set" : "unset"}`,
      claudeCodeInstalled
        ? `- Claude Code: projects found (${claudeCodeActive.join(" | ")})`
        : null,
      `- Gemini hooks: ${geminiHookConfigured ? "set" : "unset"}`,
      `- Opencode plugin: ${opencodePluginConfigured ? "set" : "unset"}`,
      `- OpenClaw session plugin: ${openclawSessionPluginState?.configured ? "set" : "unset"}`,
      `- OpenClaw session plugin conversation access: ${openclawSessionPluginState?.conversationAccess ? "set" : "unset"}`,
      `- OpenClaw hook (legacy): ${openclawHookState?.configured ? "set" : "unset"}`,
      kimiInstalled || kimiCodeInstalled
        ? `- Kimi Code: passive reader (${kimiWireFiles.length + kimiCodeWireFiles.length} wire.jsonl file${(kimiWireFiles.length + kimiCodeWireFiles.length) !== 1 ? "s" : ""} found, directories: ${kimiActive.join(" | ") || "none"})`
        : null,
      kiroCliInstalled
        ? `- Kiro CLI: passive reader (${kiroCliFileCount} session file${kiroCliFileCount !== 1 ? "s" : ""} found, SQLite ${kiroCliDbFound ? "found" : "not found"}, installs: ${kiroCliActive.join(" | ")}; tokens approximated from char lengths and merged under 'kiro')`
        : null,
      kiroIdeInstalled
        ? `- Kiro IDE: passive reader (${kiroIdeActive.join(" | ")})`
        : null,
      codebuddyInstalled
        ? `- CodeBuddy hooks: ${codebuddyHookConfigured ? "set" : "unset"} (${codebuddyFiles.length} usage file${codebuddyFiles.length !== 1 ? "s" : ""} found)`
        : null,
      workbuddyInstalled
        ? `- WorkBuddy hooks: ${workbuddyHookConfigured ? "set" : "unset"} (${workbuddyFiles.length} session jsonl file${workbuddyFiles.length !== 1 ? "s" : ""} found, SQLite DB ${workbuddyDbExists ? "found" : "not found"})`
        : null,
      ompInstalled || ompHookState.ompPresent
        ? `- oh-my-pi: passive reader (${ompFiles.length} session jsonl file${ompFiles.length !== 1 ? "s" : ""} found${ompHookState.configured ? ", notify extension: yes" : ", notify extension: no"})`
        : null,
      piInstalled
        ? `- pi: passive reader (${piFiles.length} session jsonl file${piFiles.length !== 1 ? "s" : ""} found)`
        : null,
      primeAgentInstalled
        ? `- Prime Agent: passive reader (${primeAgentFiles.length} session jsonl file${primeAgentFiles.length !== 1 ? "s" : ""} found)`
        : null,
      craftInstalled
        ? `- Craft Agents: passive reader (${craftFiles.length} session jsonl file${craftFiles.length !== 1 ? "s" : ""} found)`
        : null,
      reasonixInstalled
        ? `- Reasonix: passive reader (${reasonixFiles.length} telemetry file${reasonixFiles.length !== 1 ? "s" : ""} found)`
        : null,
      anythingllmInstalled
        ? `- AnythingLLM Desktop: passive reader (${anythingllmDbPath})`
        : null,
      kiloInstalled
        ? `- Kilo CLI: passive reader (${kiloDbPath})`
        : null,
      mimoInstalled
        ? `- Mimo: passive reader (${mimoDbPath})`
        : null,
      zcodeInstalled
        ? `- ZCode: passive reader (${zcodeDbPath})`
        : null,
      qoderInstalled
        ? `- Qoder: passive reader (${[qoderDbPath, qoderNewPath].filter(Boolean).join(" + ") || "not found"}${qoderNewInstalled && qoderActive.length > 0 ? " [legacy DB + new JSONL (both tracked)]" : ""}${qoderNewInstalled && qoderActive.length === 0 ? " [new JSONL only]" : ""})`
        : null,
      qoderCnInstalled
        ? `- Qoder CN: passive reader (${summarizeQoderDetail(qoderCnDbPath, qoderCnNewPath) || "not found"}${qoderCnNewInstalled && qoderCnActive.length > 0 ? " [legacy DB + new JSONL (both tracked)]" : ""}${qoderCnNewInstalled && qoderCnActive.length === 0 ? " [new JSONL only]" : ""})`
        : null,
      claudeScienceInstalled
        ? `- Claude Science: passive reader (${claudeScienceDbPath})`
        : null,
      opencodeInstalled
        ? `- OpenCode: passive reader (storage: ${opencodeStorageActive.join(" | ") || "not found"}, DB: ${opencodeDbActive.join(" | ") || "not found"})`
        : null,
      codeInstalled
        ? `- Every Code: sessions found (${codeActive.join(" | ")})`
        : null,
      geminiCliInstalled
        ? `- Gemini CLI: sessions found (${geminiCliActive.join(" | ")})`
        : null,
      antigravityInstalled
        ? `- Antigravity: brain found (${antigravityActive.join(" | ")})`
        : null,
      (!geminiCliInstalled && !antigravityInstalled && geminiInstalledStatus)
        ? `- Gemini CLI / Antigravity: home found (${geminiActive.join(" | ")})`
        : null,
      codexInstalledStatus
        ? `- Codex CLI: sessions found (${codexActive.join(" | ")})`
        : null,
      acodeInstalled
        ? `- AStudio: sessions found (${acodeActive.join(" | ")})`
        : null,
      kilocodeInstalled
        ? `- Kilo Code (VS Code extension): passive reader (${kilocodeTaskFiles.length} task${kilocodeTaskFiles.length !== 1 ? "s" : ""} across ${new Set(kilocodeTaskFiles.map((t) => t.ide)).size} IDE${new Set(kilocodeTaskFiles.map((t) => t.ide)).size !== 1 ? "s" : ""})`
        : null,
      roocodeInstalled
        ? `- Roo Code (VS Code extension): passive reader (${roocodeTaskFiles.length} task${roocodeTaskFiles.length !== 1 ? "s" : ""} across ${new Set(roocodeTaskFiles.map((t) => t.ide)).size} IDE${new Set(roocodeTaskFiles.map((t) => t.ide)).size !== 1 ? "s" : ""})`
        : null,
      zedInstalled
        ? `- Zed Agent: passive reader (threads.db, all providers${
            zedThreadsCounted > 0
              ? `, ${zedThreadsCounted} thread${zedThreadsCounted !== 1 ? "s" : ""} counted`
              : ", no usage counted yet"
          })`
        : null,
      gooseInstalled
        ? `- Goose (Block): passive reader (sessions.db, cumulative-delta)`
        : null,
      droidInstalled
        ? `- Droid (Factory): passive reader (${droidSettingsFiles.length} session${droidSettingsFiles.length !== 1 ? "s" : ""} in ${droidSessionsDir}, cumulative-delta)`
        : null,
      dshInstalled
        ? `- DeepSeek Harness: passive reader (${dshSessionFiles.length} session${dshSessionFiles.length !== 1 ? "s" : ""} in ${dshSessionsDir})`
        : null,
      lmstudioInstalled
        ? `- LM Studio: passive reader (${lmstudioLogFiles.length} log${lmstudioLogFiles.length !== 1 ? "s" : ""} in ${path.join(lmstudioHome, "server-logs")})`
        : null,
      unslothInstalled
        ? `- Unsloth Studio: passive reader (${unslothDbPath})`
        : null,
      traeInstalled
        // Deliberately NOT "passive reader": every other line with that wording
        // means tokens are being counted. Trae encrypts its session transcripts
        // (SQLCipher) and its plaintext summaries carry no token counts, so this
        // provider contributes plan info and nothing else — say so, or users go
        // looking for Trae usage in the dashboard that will never appear.
        ? `- Trae SOLO: plan info only, no token usage (${traeStoragePath})`
        : null,
      traeEntitlement
        ? `- Trae SOLO plan: ${formatTraeEntitlementLine(traeEntitlement)}`
        : null,
      traeCnInstalled
        // Installed, signed in, and one env var away from usage data is the
        // one actionable state on this line — mark it so it does not read
        // like the ~30 neutral install lines around it (#492). Every other
        // combination (opted in, or no readable auth to send) is neutral.
        ? `- ${traeCnAuthState === "readable" && !traeCnUsageOptIn ? "⚠ " : ""}Trae SOLO CN: usage sync ${traeCnUsageOptIn ? "opted in" : `off (set ${TRAE_CN_USAGE_ENV}=1 to enable)`}, auth ${traeCnAuthState} (${traeCnStoragePath})`
        : null,
      ...(() => {
        if (!hermesInstalled) return [];
        return [`- Hermes Agent: state.db found (${hermesPath})`];
      })(),
      ...(() => {
        const passive = passiveProviders.filter((p) => p.passive);
        if (passive.length === 0) return [];
        return [
          `- Passive mode: ${passive.length} provider${passive.length !== 1 ? "s" : ""} reading logs without hooks (${passive.map((p) => `${p.name}: ${p.hook_failure_reason || "hook unset"}`).join("; ")})`,
        ];
      })(),
      grokInstalled
        ? `- Grok Build (xAI): ${grokHookState.configured ? "hook installed" : "detected"} (${grokSessions.length} session${grokSessions.length !== 1 ? "s" : ""} found, hook: ${grokHookState.configured ? "yes" : "no"})`
        : null,
      ...copilotLines,
      ...(process.platform === "win32" ? (() => {
        const wslMode = getWslMode();
        const modeInvalid = isInvalidWslMode();
        const modeSuffix = modeInvalid ? ` (invalid TOKENTRACKER_WSL_MODE ignored)` : "";
        const lines = [
          `- WSL mode: ${wslMode}${modeSuffix}`,
        ];
        if (wslDistros.length > 0) {
          lines.push(`  distros: ${wslDistros.map((d) => `${d.name} (v${d.version ?? "?"})`).join(", ")}`);
        }
        return lines;
      })() : []),
      ...subscriptionLines,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function formatCopilotStoreDetail(detail) {
  return `${detail.path} (schema ${detail.schema_version ?? "?"}, ${detail.event_count ?? 0} events, last id ${detail.last_event_id ?? 0}${detail.last_event_at ? ` at ${detail.last_event_at}` : ""})`;
}

function formatCopilotLines({ token, otel, sessionStore, appDb }) {
  if (
    !token &&
    !otel.otel_has_files &&
    !sessionStore?.store_has_file &&
    !appDb?.app_db_has_file
  ) {
    return [];
  }
  const limitsState = token
    ? "set (via GitHub OAuth)"
    : "unset (no Copilot OAuth token found)";
  const storeDetail = (sessionStore?.store_details || [])
    .map(formatCopilotStoreDetail)
    .join(", ");
  const storeState = sessionStore?.store_has_file
    ? `${sessionStore.source_mode || "set"} (${storeDetail || (sessionStore.store_paths || []).join(", ")}; precision ${sessionStore.precision || "unknown"}; coverage ${sessionStore.coverage || "unknown"})`
    : `not found (${sessionStore?.store_path || "unknown"})`;
  const appDbState = appDb?.app_db_has_file
    ? `${appDb.app_db_mode || "set"} (${(appDb.app_db_paths || []).join(", ")})`
    : `not found (${appDb?.app_db_path || "unknown"})`;
  const otelLocation =
    otel.otel_path || otel.otel_detected_paths?.[0] || otel.otel_default_dir;
  const usageState = otel.otel_has_files
    ? `set (${otelLocation})`
    : otel.otel_enabled
      ? "enabled but no files yet"
      : "unset (OTEL export not enabled)";
  const lines = [
    `- GitHub Copilot limits: ${limitsState}`,
    `- GitHub Copilot usage (App/CLI store): ${storeState}`,
    `- GitHub Copilot usage (App DB legacy baseline): ${appDbState}`,
    `- GitHub Copilot usage (OTEL Chat/legacy CLI): ${usageState}`,
  ];
  for (const reason of sessionStore?.degraded_reasons || []) {
    lines.push(`    Degraded: ${reason}`);
  }
  if (sessionStore?.recommended_action) {
    lines.push(`    Action: ${sessionStore.recommended_action}`);
  }
  if (!sessionStore?.store_has_file && !otel.otel_has_files) {
    lines.push(
      "    To track older Copilot CLI / Chat extension token usage, add to your shell profile:",
      "      export COPILOT_OTEL_ENABLED=true",
      "      export COPILOT_OTEL_EXPORTER_TYPE=file",
      `      export COPILOT_OTEL_FILE_EXPORTER_PATH="${otel.otel_default_dir}/copilot-otel-$(date +%Y%m%d).jsonl"`,
    );
  }
  return lines;
}

function formatSubscriptionLine(entry = {}) {
  const tool = String(entry.tool || "");
  const provider = String(entry.provider || "");
  const product = String(entry.product || "");
  const planType = String(entry.planType || "");
  const rateLimitTier = String(entry.rateLimitTier || "");
  const toolLabel =
    tool === "codex"
      ? "Codex"
      : tool === "opencode"
        ? "OpenCode"
        : tool === "claude"
          ? "Claude Code"
          : tool;

  if (!planType) return null;

  if (
    tool === "claude" &&
    provider === "anthropic" &&
    product === "subscription"
  ) {
    const suffix = rateLimitTier ? ` (rate limit tier: ${rateLimitTier})` : "";
    return `- ${toolLabel} subscription: ${planType}${suffix}`;
  }

  if (provider === "openai" && product === "chatgpt") {
    return `- ${toolLabel} ChatGPT plan: ${planType}`;
  }

  const productLabel = product ? product.replace(/_/g, " ") : "subscription";
  return `- ${toolLabel} ${productLabel}: ${planType}`;
}

function parseArgs(argv) {
  const out = {
    diagnostics: false,
    json: false,
    light: false,
    noSpinner: false,
    probeKeychain: false,
    probeKeychainDetails: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--diagnostics") out.diagnostics = true;
    else if (a === "--json") out.json = true;
    else if (a === "--light") out.light = true;
    else if (a === "--no-spinner") out.noSpinner = true;
    else if (a === "--probe-keychain") out.probeKeychain = true;
    else if (a === "--probe-keychain-details") {
      out.probeKeychainDetails = true;
      out.probeKeychain = true;
    } else throw new Error(`Unknown option: ${a}`);
  }

  return out;
}

// Pure renderer: turn the structured summary into a fixed-width ASCII table.
// "light" output is for AI agents and CI: deterministic columns, no emoji or
// spinner side effects, easy to grep. Returns a string (caller adds trailing
// newline).
function renderLightTable(summary) {
  const rows = [];
  const push = (k, v) => rows.push([k, v == null || v === "" ? "—" : String(v)]);

  push("Version", summary.version);
  push("Base URL", summary.base_url);
  push("Device token", summary.device_token_set ? "set" : "unset");
  push("Queue pending (bytes)", summary.queue.pending_bytes);
  push("Queue size (bytes)", summary.queue.size_bytes);
  push("Last parse", summary.last_parse);
  push("Last notify", summary.last_notify);
  push("Last upload", summary.last_upload);
  push("Next upload after", summary.next_upload_after);
  push("Backoff until", summary.backoff_until);
  if (summary.last_upload_error) push("Last upload error", summary.last_upload_error);
  if (summary.last_sync_skipped) {
    push(
      "Last sync skipped",
      `${summary.last_sync_skipped.at} (${summary.last_sync_skipped.reason || "unknown"})`,
    );
  }

  for (const [name, state] of Object.entries(summary.hooks || {})) {
    push(`Hook · ${name}`, state ? "set" : "unset");
  }

  for (const [name, info] of Object.entries(summary.providers || {})) {
    const detail = [];
    if (typeof info.installed === "boolean") detail.push(info.installed ? "installed" : "not installed");
    if (typeof info.files === "number") detail.push(`${info.files} file${info.files !== 1 ? "s" : ""}`);
    if (info.detail) detail.push(info.detail);
    if (Array.isArray(info.wsl_distros) && info.wsl_distros.length) {
      detail.push(`WSL: ${info.wsl_distros.map((d) => `${d.name} (v${d.version ?? "?"})`).join(", ")}`);
    }
    push(`Provider · ${name}`, detail.length ? detail.join(", ") : "—");
  }

  // Mirror formatCopilotLines(): stay silent for machines with no Copilot
  // signal at all instead of printing "not found" rows for everyone.
  const copilotDetected =
    summary.copilot &&
    (summary.copilot.token_set ||
      summary.copilot.otel_enabled ||
      summary.copilot.otel_has_files ||
      summary.copilot.store_has_file ||
      summary.copilot.app_db_has_file);
  if (copilotDetected) {
    push(
      "Copilot App/CLI store",
      summary.copilot.store_has_file
        ? `${summary.copilot.source_mode || "set"}: ${
            (summary.copilot.store_details || [])
              .map(formatCopilotStoreDetail)
              .join(", ") ||
            (summary.copilot.store_paths || [summary.copilot.store_path])
              .filter(Boolean)
              .join(", ")
          }`
        : `not found (${summary.copilot.store_path || "unknown"})`,
    );
    push(
      "Copilot App DB legacy baseline",
      summary.copilot.app_db_has_file
        ? `${summary.copilot.app_db_mode || "set"}: ${(summary.copilot.app_db_paths || [summary.copilot.app_db_path]).filter(Boolean).join(", ")}`
        : `not found (${summary.copilot.app_db_path || "unknown"})`,
    );
    push(
      "Copilot OTEL Chat/legacy CLI",
      summary.copilot.otel_has_files
        ? summary.copilot.otel_path || "files found"
        : summary.copilot.otel_enabled
          ? "enabled, no files"
          : "not enabled",
    );
    push("Copilot precision", summary.copilot.precision);
    push("Copilot coverage", summary.copilot.coverage);
    for (const reason of summary.copilot.degraded_reasons || []) {
      push("Copilot degraded", reason);
    }
    if (summary.copilot.recommended_action) {
      push("Copilot action", summary.copilot.recommended_action);
    }
  }

  if (summary.passive_mode) {
    push("Passive mode active", summary.passive_mode.active ? "yes" : "no");
    for (const p of summary.passive_mode.providers || []) {
      if (p.passive) {
        push(`Passive · ${p.name}`, `hook ${p.hook_failure_reason || "missing"}, logs present`);
      }
    }
  }

  const keyWidth = Math.max(...rows.map(([k]) => k.length), 8);
  const valWidth = Math.max(...rows.map(([, v]) => v.length), 8);
  const sep = `+${"-".repeat(keyWidth + 2)}+${"-".repeat(valWidth + 2)}+`;
  const lines = [sep, `| ${"Key".padEnd(keyWidth)} | ${"Value".padEnd(valWidth)} |`, sep];
  for (const [k, v] of rows) {
    lines.push(`| ${k.padEnd(keyWidth)} | ${v.padEnd(valWidth)} |`);
  }
  lines.push(sep);
  return lines.join("\n");
}

async function safeStatSize(p) {
  try {
    const st = await fs.stat(p);
    return st.size || 0;
  } catch (_e) {
    return 0;
  }
}

async function safeReadText(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch (_e) {
    return null;
  }
}

function parseEpochMsToIso(v) {
  const ms = Number(v);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

module.exports = { cmdStatus, summarizeQoderDetail };
