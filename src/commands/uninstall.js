const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const {
  restoreCodexNotify,
  restoreAcodeNotify,
  restoreEveryCodeNotify,
  buildCodexNotifyCmd,
  buildAcodeNotifyCmd,
  buildEveryCodeNotifyCmd,
} = require("../lib/codex-config");
const {
  removeClaudeHook,
  removeClaudeUsageHooks,
  buildClaudeHookCommand,
  buildHookCommand,
} = require("../lib/claude-config");
const {
  resolveGeminiConfigDir,
  resolveGeminiSettingsPath,
  buildGeminiHookCommand,
  removeGeminiHook,
} = require("../lib/gemini-config");
const { resolveOpencodeConfigDir, removeOpencodePlugin } = require("../lib/opencode-config");
const { removeOpenclawHookConfig } = require("../lib/openclaw-hook");
const { removeOpenclawSessionPluginConfig } = require("../lib/openclaw-session-plugin");
const { removeGrokHook } = require("../lib/grok-hook");
const { removeOmpHook } = require("../lib/omp-hook");
const { resolveTrackerPaths } = require("../lib/tracker-paths");

async function cmdUninstall(argv) {
  const opts = parseArgs(argv);
  const home = os.homedir();
  const { trackerDir, binDir } = await resolveTrackerPaths({ home });
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const acodeHome = process.env.TOKENTRACKER_ACODE_HOME || path.join(home, ".acode");
  const acodeConfigPath = path.join(acodeHome, "config.toml");
  const codeHome = process.env.CODE_HOME || path.join(home, ".code");
  const codeConfigPath = path.join(codeHome, "config.toml");
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  const codebuddyDir = process.env.CODEBUDDY_HOME || path.join(home, ".codebuddy");
  const codebuddySettingsPath = path.join(codebuddyDir, "settings.json");
  const workbuddyDir = process.env.WORKBUDDY_HOME || path.join(home, ".workbuddy");
  const workbuddySettingsPath = path.join(workbuddyDir, "settings.json");
  const geminiConfigDir = resolveGeminiConfigDir({ home, env: process.env });
  const geminiSettingsPath = resolveGeminiSettingsPath({ configDir: geminiConfigDir });
  const opencodeConfigDir = resolveOpencodeConfigDir({ home, env: process.env });
  const notifyPath = path.join(binDir, "notify.cjs");
  const notifyOriginalPath = path.join(trackerDir, "codex_notify_original.json");
  const acodeNotifyOriginalPath = path.join(trackerDir, "acode_notify_original.json");
  const codeNotifyOriginalPath = path.join(trackerDir, "code_notify_original.json");
  const codexNotifyCmd = buildCodexNotifyCmd(notifyPath);
  const acodeNotifyCmd = buildAcodeNotifyCmd(notifyPath);
  const codeNotifyCmd = buildEveryCodeNotifyCmd(notifyPath);
  const claudeHookCommand = buildClaudeHookCommand(notifyPath);
  const codebuddyHookCommand = buildHookCommand(notifyPath, "codebuddy");
  const workbuddyHookCommand = buildHookCommand(notifyPath, "workbuddy");
  const geminiHookCommand = buildGeminiHookCommand(notifyPath);

  const codexConfigExists = await isFile(codexConfigPath);
  const acodeConfigExists = await isFile(acodeConfigPath);
  const codeConfigExists = await isFile(codeConfigPath);
  const claudeConfigExists = await isFile(claudeSettingsPath);
  const codebuddyConfigExists = await isFile(codebuddySettingsPath);
  const workbuddyConfigExists = await isFile(workbuddySettingsPath);
  const geminiConfigExists = await isDir(geminiConfigDir);
  const opencodeConfigExists = await isDir(opencodeConfigDir);
  const codexRestore = codexConfigExists
    ? await restoreCodexNotify({
        codexConfigPath,
        notifyOriginalPath,
        notifyCmd: codexNotifyCmd,
      })
    : { restored: false, skippedReason: "config-missing" };
  const acodeRestore = acodeConfigExists
    ? await restoreAcodeNotify({
        acodeConfigPath,
        notifyOriginalPath: acodeNotifyOriginalPath,
        notifyCmd: acodeNotifyCmd,
      })
    : { restored: false, skippedReason: "config-missing" };
  const codeRestore = codeConfigExists
    ? await restoreEveryCodeNotify({
        codeConfigPath,
        notifyOriginalPath: codeNotifyOriginalPath,
        notifyCmd: codeNotifyCmd,
      })
    : { restored: false, skippedReason: "config-missing" };
  const claudeRemove = claudeConfigExists
    ? await removeClaudeUsageHooks({
        settingsPath: claudeSettingsPath,
        hookCommand: claudeHookCommand,
      })
    : { removed: false, skippedReason: "config-missing" };
  const codebuddyRemove = codebuddyConfigExists
    ? await removeClaudeHook({
        settingsPath: codebuddySettingsPath,
        hookCommand: codebuddyHookCommand,
      })
    : { removed: false, skippedReason: "config-missing" };
  const workbuddyRemove = workbuddyConfigExists
    ? await removeClaudeHook({
        settingsPath: workbuddySettingsPath,
        hookCommand: workbuddyHookCommand,
      })
    : { removed: false, skippedReason: "config-missing" };
  const geminiRemove = geminiConfigExists
    ? await removeGeminiHook({ settingsPath: geminiSettingsPath, hookCommand: geminiHookCommand })
    : { removed: false, skippedReason: "config-missing" };
  const opencodeRemove = opencodeConfigExists
    ? await removeOpencodePlugin({ configDir: opencodeConfigDir })
    : { removed: false, skippedReason: "config-missing" };
  const openclawSessionPluginRemove = await removeOpenclawSessionPluginConfig({
    home,
    trackerDir,
    env: process.env,
  });
  const openclawHookRemove = await removeOpenclawHookConfig({ home, trackerDir, env: process.env });
  const grokHookRemove = await removeGrokHook({ home, trackerDir, env: process.env });
  const ompHookRemove = await removeOmpHook({ home, trackerDir, env: process.env });

  // Remove installed notify handler.
  await fs.unlink(notifyPath).catch(() => {});

  // Remove local app runtime (installed by init for notify-driven sync).
  await fs.rm(path.join(trackerDir, "app"), { recursive: true, force: true }).catch(() => {});

  // Deliberately NOT removed by --purge: the machine-identity seed lets a
  // reinstall reuse the same cloud device row instead of double-counting the
  // replayed history under a new device (issue #176).
  const machineIdSeedPath = path.join(home, ".config", "tokentracker", "machine-id");
  let machineIdSeedKept = false;
  if (opts.purge) {
    await fs.rm(path.join(home, ".tokentracker"), { recursive: true, force: true }).catch(() => {});
    machineIdSeedKept = await fs.access(machineIdSeedPath).then(
      () => true,
      () => false,
    );
  }

  process.stdout.write(
    [
      "Uninstalled:",
      codexConfigExists
        ? codexRestore?.restored
          ? `- Codex notify restored: ${codexConfigPath}`
          : codexRestore?.skippedReason === "no-backup-not-installed"
            ? "- Codex notify: skipped (no backup; not installed)"
            : codexRestore?.skippedReason === "current-not-managed"
              ? "- Codex notify: skipped (current notify is not managed by TokenTracker)"
            : "- Codex notify: no change"
        : "- Codex notify: skipped (config.toml not found)",
      acodeConfigExists
        ? acodeRestore?.restored
          ? `- AStudio notify restored: ${acodeConfigPath}`
          : acodeRestore?.skippedReason === "no-backup-not-installed"
            ? "- AStudio notify: skipped (no backup; not installed)"
            : acodeRestore?.skippedReason === "current-not-managed"
              ? "- AStudio notify: skipped (current notify is not managed by TokenTracker)"
              : "- AStudio notify: no change"
        : "- AStudio notify: skipped (config.toml not found)",
      codeConfigExists
        ? codeRestore?.restored
          ? `- Every Code notify restored: ${codeConfigPath}`
          : codeRestore?.skippedReason === "no-backup-not-installed"
            ? "- Every Code notify: skipped (no backup; not installed)"
            : codeRestore?.skippedReason === "current-not-managed"
              ? "- Every Code notify: skipped (current notify is not managed by TokenTracker)"
            : "- Every Code notify: no change"
        : "- Every Code notify: skipped (config.toml not found)",
      claudeConfigExists
        ? claudeRemove?.removed
          ? `- Claude hooks removed: ${claudeSettingsPath}`
          : claudeRemove?.skippedReason === "hook-missing"
            ? "- Claude hooks: no change"
            : "- Claude hooks: skipped"
        : "- Claude hooks: skipped (settings.json not found)",
      codebuddyConfigExists
        ? codebuddyRemove?.removed
          ? `- CodeBuddy hooks removed: ${codebuddySettingsPath}`
          : codebuddyRemove?.skippedReason === "hook-missing"
            ? "- CodeBuddy hooks: no change"
            : "- CodeBuddy hooks: skipped"
        : "- CodeBuddy hooks: skipped (settings.json not found)",
      workbuddyConfigExists
        ? workbuddyRemove?.removed
          ? `- WorkBuddy hooks removed: ${workbuddySettingsPath}`
          : workbuddyRemove?.skippedReason === "hook-missing"
            ? "- WorkBuddy hooks: no change"
            : "- WorkBuddy hooks: skipped"
        : "- WorkBuddy hooks: skipped (settings.json not found)",
      geminiConfigExists
        ? geminiRemove?.removed
          ? `- Gemini hooks removed: ${geminiSettingsPath}`
          : geminiRemove?.skippedReason === "hook-missing"
            ? "- Gemini hooks: no change"
            : "- Gemini hooks: skipped"
        : `- Gemini hooks: skipped (${geminiConfigDir} not found)`,
      opencodeConfigExists
        ? opencodeRemove?.removed
          ? `- Opencode plugin removed: ${opencodeConfigDir}`
          : opencodeRemove?.skippedReason === "plugin-missing"
            ? "- Opencode plugin: no change"
            : opencodeRemove?.skippedReason === "unexpected-content"
              ? "- Opencode plugin: skipped (unexpected content)"
              : "- Opencode plugin: skipped"
        : `- Opencode plugin: skipped (${opencodeConfigDir} not found)`,
      openclawSessionPluginRemove?.removed
        ? `- OpenClaw session plugin removed: ${openclawSessionPluginRemove.openclawConfigPath}`
        : openclawSessionPluginRemove?.skippedReason === "openclaw-config-missing"
          ? "- OpenClaw session plugin: skipped (openclaw config not found)"
          : "- OpenClaw session plugin: no change",
      openclawHookRemove?.removed
        ? `- OpenClaw hook (legacy) removed: ${openclawHookRemove.openclawConfigPath}`
        : openclawHookRemove?.skippedReason === "openclaw-config-missing"
          ? "- OpenClaw hook (legacy): skipped (openclaw config not found)"
          : "- OpenClaw hook (legacy): no change",
      grokHookRemove?.removed
        ? `- Grok Build hook removed: ${grokHookRemove.hookPath}`
        : "- Grok Build hook: no change",
      formatOmpHookRemoveLine(ompHookRemove),
      opts.purge ? `- Purged: ${path.join(home, ".tokentracker")}` : "- Purge: skipped (use --purge)",
      ...(machineIdSeedKept
        ? [`- Kept: ${machineIdSeedPath} (cloud device identity — a reinstall reuses the same device; delete it to fully reset)`]
        : []),
      "",
    ].join("\n"),
  );
}

function formatOmpHookRemoveLine(ompHookRemove) {
  if (ompHookRemove?.removed) {
    return `- oh-my-pi notify extension removed: ${ompHookRemove.extensionPath}`;
  }
  const reason = ompHookRemove?.skippedReason;
  const residualPath = ompHookRemove?.stagedPath || ompHookRemove?.extensionPath;
  const residual = residualPath
    ? ` (left in place: ${residualPath})`
    : "";
  if (reason === "unmanaged") {
    return `- oh-my-pi notify extension: skipped (unmanaged file)${residual}`;
  }
  if (reason === "unlink-failed") {
    const detail = ompHookRemove?.error ? `: ${ompHookRemove.error}` : "";
    return `- oh-my-pi notify extension: failed to remove${detail}${residual}`;
  }
  if (reason === "extension-read-failed") {
    const detail = ompHookRemove?.error ? `: ${ompHookRemove.error}` : "";
    return `- oh-my-pi notify extension: failed to read${detail}${residual}`;
  }
  if (reason === "identity-changed") {
    return `- oh-my-pi notify extension: skipped (file changed during uninstall)${residual}`;
  }
  if (reason === "omp-agent-dir-unresolved") {
    return "- oh-my-pi notify extension: skipped (omp agent dir unresolved)";
  }
  if (reason === "missing") {
    return "- oh-my-pi notify extension: no change";
  }
  return "- oh-my-pi notify extension: no change";
}

function parseArgs(argv) {
  const out = { purge: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--purge") out.purge = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

module.exports = { cmdUninstall, formatOmpHookRemoveLine };

async function isFile(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch (_e) {
    return false;
  }
}

async function isDir(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch (_e) {
    return false;
  }
}
