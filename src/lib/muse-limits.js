"use strict";

// Muse Code (Meta AI coding CLI) subscription quota monitoring.
//
// Reads the user's rolling 5-hour and weekly subscription allowance windows
// from the official local `muse` binary (`muse usage --json`), which uses the
// signed-in OAuth session stored under `~/.config/muse/auth.json`. TokenTracker
// already counts Muse Code token consumption from `~/.local/share/muse`; this
// module adds no consumption source and never reads or transmits prompts.
//
// Feature-detected and spawn-free on machines without Muse Code installed:
// when neither config/data directories nor a `muse` binary in global bin paths
// exist, `fetchMuseLimits` returns `{ configured: false }` with zero spawns.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const {
  runCommand,
  resolveBinaryPath,
  statBinaryInDirs,
  commonGlobalBinDirectories,
  resolvedCliEnvironment,
} = require("./command-runner");
const { createLimitsCache, readCacheJson } = require("./limits-cache");

const MUSE_LIMITS_CACHE_FILE = "muse-limits-cache.json";
const MUSE_LIMITS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MUSE_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS = 12 * 60 * 60 * 1000;
const MUSE_USAGE_TIMEOUT_MS = 10_000;
const MUSE_PROVIDER_TIMEOUT_MS = 15_000;
const MUSE_PROVIDER_BUDGET_GUARD_MS = 1_500;
const MUSE_CLI_STDERR_TRIM = 400;

const MUSE_FIVE_HOUR_WINDOW_SECONDS = 5 * 3600;
const MUSE_WEEKLY_WINDOW_SECONDS = 7 * 86400;

const MUSE_SUBSCRIPTION_REQUIRED_MESSAGE =
  "Muse Code subscription required (API-key / pay-as-you-go accounts have no rolling quota windows).";
const MUSE_AUTH_EXPIRED_MESSAGE =
  "Not logged in to Muse Code. Run `muse login` to authenticate.";

const MUSE_TIER_LABELS = Object.freeze({
  power: "Power",
  pro: "Pro",
  max: "Max",
  plus: "Plus",
  team: "Team",
  enterprise: "Enterprise",
  starter: "Starter",
  free: "Free",
});

// Memory-hard KDF for partitioning the disk cache by signed-in account without
// writing raw email PII to disk or tripping fast-hash static analysis near
// auth files. Memoized per normalized account key so repeated polls pay zero
// KDF overhead.
const MUSE_IDENTITY_SALT = "tokentracker/muse-limits-cache/v1";
let identityMemo = null;

function fingerprintMuseAccount(rawAccount) {
  const normalized = typeof rawAccount === "string" ? rawAccount.trim().toLowerCase() : "";
  if (!normalized) return null;
  if (identityMemo?.key === normalized) return identityMemo.hex;
  const hex = crypto.scryptSync(normalized, MUSE_IDENTITY_SALT, 16).toString("hex");
  identityMemo = { key: normalized, hex };
  return hex;
}

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

function normalizeResetAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const milliseconds = raw > 10_000_000_000 ? raw : raw * 1000;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function deriveMusePlanLabel(tier) {
  if (typeof tier !== "string") return null;
  const cleaned = tier
    .trim()
    .replace(/^muse(?:\s+code)?[\s_-]*/i, "")
    .trim();
  if (!cleaned) return null;
  const mapped = MUSE_TIER_LABELS[cleaned.toLowerCase()];
  if (mapped) return mapped;
  return cleaned
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeMuseWindow(rawWindow, windowSeconds) {
  if (!rawWindow || typeof rawWindow !== "object") return null;
  const pct = clampPercent(
    rawWindow.usedPercent ?? rawWindow.used_percent ?? rawWindow.utilization,
  );
  if (pct === null) return null;
  return {
    used_percent: pct,
    reset_at: normalizeResetAt(
      rawWindow.resetsAtMs ?? rawWindow.resets_at_ms ?? rawWindow.resetAt ?? rawWindow.reset_at,
    ),
    limit_window_seconds: windowSeconds,
  };
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (_error) {
    return false;
  }
}

function expandHomeDir(rawPath, home) {
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

function resolveMuseConfigDir({ home = os.homedir(), env = process.env } = {}) {
  const xdgConfig =
    env && typeof env === "object" && typeof env.XDG_CONFIG_HOME === "string"
      ? expandHomeDir(env.XDG_CONFIG_HOME, home)
      : "";
  return xdgConfig ? path.join(xdgConfig, "muse") : path.join(home, ".config", "muse");
}

function resolveMuseAuthPath({ home = os.homedir(), env = process.env } = {}) {
  const explicitAuth =
    env && typeof env === "object" && typeof env.MUSE_AUTH_PATH === "string"
      ? expandHomeDir(env.MUSE_AUTH_PATH, home)
      : "";
  return explicitAuth || path.join(resolveMuseConfigDir({ home, env }), "auth.json");
}

function resolveMuseDataDir({ home = os.homedir(), env = process.env } = {}) {
  const explicitHome =
    env && typeof env === "object" && typeof env.TOKENTRACKER_MUSE_HOME === "string"
      ? expandHomeDir(env.TOKENTRACKER_MUSE_HOME, home)
      : "";
  if (explicitHome) return explicitHome;
  const xdgData =
    env && typeof env === "object" && typeof env.XDG_DATA_HOME === "string"
      ? expandHomeDir(env.XDG_DATA_HOME, home)
      : "";
  return xdgData ? path.join(xdgData, "muse") : path.join(home, ".local", "share", "muse");
}

function resolveMuseInstallDir({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const explicitInstallDir =
    env && typeof env === "object" && typeof env.MUSE_INSTALL_DIR === "string"
      ? expandHomeDir(env.MUSE_INSTALL_DIR, home)
      : "";
  if (explicitInstallDir) return explicitInstallDir;
  if (platform === "win32") {
    const localAppData =
      env && typeof env === "object" && typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()
        ? expandHomeDir(env.LOCALAPPDATA, home)
        : path.join(home, "AppData", "Local");
    return path.join(localAppData, "Programs", "muse");
  }
  return path.join(home, ".local", "bin");
}

function resolveWindowsMuseInstallDir({ home = os.homedir(), env = process.env } = {}) {
  return resolveMuseInstallDir({ home, platform: "win32", env });
}

function hasMuseInstallEvidence({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  if (isFile(resolveMuseAuthPath({ home, env }))) return true;
  const candidates = [
    resolveMuseConfigDir({ home, env }),
    resolveMuseDataDir({ home, env }),
  ];
  if (platform === "win32") {
    candidates.push(resolveWindowsMuseInstallDir({ home, env }));
  } else if (
    env &&
    typeof env === "object" &&
    typeof env.MUSE_INSTALL_DIR === "string" &&
    env.MUSE_INSTALL_DIR.trim()
  ) {
    candidates.push(resolveMuseInstallDir({ home, platform, env }));
  }
  return candidates.some(isDirectory);
}

/**
 * Read non-secret account metadata from `~/.config/muse/auth.json` (or `MUSE_AUTH_PATH`).
 * Never returns or logs tokens; only derives an opaque account-partition key
 * and checks whether `subs_active` explicitly marks a non-subscription login.
 */
function readMuseAuthMetadata({ home = os.homedir(), env = process.env } = {}) {
  const authPath = resolveMuseAuthPath({ home, env });
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch (_error) {
    return { present: false, identity: null, subsActive: null };
  }
  const meta = parsed?.providers?.meta;
  if (!meta || typeof meta !== "object") {
    return { present: true, identity: null, subsActive: null };
  }
  const rawIdentity =
    (typeof meta.user_email === "string" && meta.user_email.trim()) ||
    (typeof meta.user_id === "string" && meta.user_id.trim()) ||
    null;
  const subsActive = typeof meta.subs_active === "boolean" ? meta.subs_active : null;
  return {
    present: true,
    identity: fingerprintMuseAccount(rawIdentity),
    subsActive,
  };
}

function parseMuseBinaryVersion(filename, { platform = process.platform } = {}) {
  const pattern =
    platform === "win32"
      ? /^muse-bin-(\d+)\.(\d+)\.(\d+)(?:-R(\d+)(?:\.(\d+))?)?(?:[-+][A-Za-z0-9._+-]+)?\.exe$/i
      : /^muse-bin-(\d+)\.(\d+)\.(\d+)(?:-R(\d+)(?:\.(\d+))?)?(?:[-+][A-Za-z0-9._+-]+)?$/;
  if (platform !== "win32" && /\.exe$/i.test(filename)) return null;
  const match = pattern.exec(filename);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] !== undefined ? Number(match[4]) : 0,
    match[5] !== undefined ? Number(match[5]) : 0,
  ];
}

function resolveMuseInstallExecutable(installDir, { platform = process.platform } = {}) {
  if (!isDirectory(installDir)) return null;
  const ext = platform === "win32" ? ".exe" : "";
  try {
    const pinnedVersion = fs.readFileSync(path.join(installDir, ".muse-version"), "utf8").trim();
    if (pinnedVersion && /^[A-Za-z0-9._+-]+$/.test(pinnedVersion)) {
      const pinnedBin = path.join(installDir, `muse-bin-${pinnedVersion}${ext}`);
      if (isFile(pinnedBin)) {
        return { binaryPath: pinnedBin, useShell: false };
      }
    }
  } catch (_error) {}

  try {
    const entries = fs.readdirSync(installDir);
    const versioned = entries
      .map((name) => ({ name, parts: parseMuseBinaryVersion(name, { platform }) }))
      .filter((entry) => entry.parts !== null)
      .sort((a, b) => (
        b.parts[0] - a.parts[0] ||
        b.parts[1] - a.parts[1] ||
        b.parts[2] - a.parts[2] ||
        b.parts[3] - a.parts[3] ||
        b.parts[4] - a.parts[4] ||
        b.name.localeCompare(a.name)
      ));
    for (const candidate of versioned) {
      const fullPath = path.join(installDir, candidate.name);
      if (isFile(fullPath)) {
        return { binaryPath: fullPath, useShell: false };
      }
    }
  } catch (_error) {}

  if (platform === "win32") {
    const cmdShim = path.join(installDir, "muse.cmd");
    if (isFile(cmdShim)) {
      return { binaryPath: cmdShim, useShell: true };
    }
    const bareExe = path.join(installDir, "muse.exe");
    if (isFile(bareExe)) {
      return { binaryPath: bareExe, useShell: false };
    }
    return null;
  }

  const unixLauncher = path.join(installDir, "muse");
  if (isFile(unixLauncher)) {
    return { binaryPath: unixLauncher, useShell: false };
  }
  return null;
}

function resolveWindowsMuseExecutable(installDir) {
  return resolveMuseInstallExecutable(installDir, { platform: "win32" });
}

function upgradeUnixLauncherToNativeBinary(candidatePath, { platform = process.platform } = {}) {
  if (!candidatePath || platform === "win32") return null;
  let realCandidate = candidatePath;
  try {
    realCandidate = fs.realpathSync(candidatePath);
  } catch (_error) {}
  const dir = path.dirname(realCandidate);
  const direct = resolveMuseInstallExecutable(dir, { platform });
  if (direct && path.basename(direct.binaryPath).startsWith("muse-bin-")) {
    return direct;
  }
  return { binaryPath: candidatePath, useShell: false };
}

async function resolveMuseCommand({
  commandRunner,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  signal,
  globalBinDirs,
  allowPathLookup = false,
} = {}) {
  const searchDirs = Array.isArray(globalBinDirs)
    ? globalBinDirs
    : commonGlobalBinDirectories({ home, platform });

  if (platform === "win32") {
    const directWin = resolveMuseInstallExecutable(
      resolveMuseInstallDir({ home, platform: "win32", env }),
      { platform: "win32" },
    );
    if (directWin) return directWin;

    const stated = statBinaryInDirs("muse", searchDirs, platform);
    if (stated) {
      return { binaryPath: stated, useShell: /\.(?:cmd|bat)$/i.test(stated) };
    }
    if (!allowPathLookup) return null;
    try {
      const resolved = await resolveBinaryPath("muse", {
        commandRunner,
        home,
        platform,
        signal,
        globalBinDirs,
      });
      if (!resolved) return null;
      return { binaryPath: resolved, useShell: /\.(?:cmd|bat)$/i.test(resolved) };
    } catch (_error) {
      return null;
    }
  }

  const explicitInstallDir =
    env && typeof env === "object" && typeof env.MUSE_INSTALL_DIR === "string" && env.MUSE_INSTALL_DIR.trim();
  if (explicitInstallDir || !Array.isArray(globalBinDirs)) {
    const directUnix = resolveMuseInstallExecutable(
      resolveMuseInstallDir({ home, platform, env }),
      { platform },
    );
    if (directUnix) return directUnix;
  }

  const stated = statBinaryInDirs("muse", searchDirs, platform);
  if (stated) {
    return upgradeUnixLauncherToNativeBinary(stated, { platform });
  }
  if (!allowPathLookup) return null;
  try {
    const resolved = await resolveBinaryPath("muse", {
      commandRunner,
      home,
      platform,
      signal,
      globalBinDirs,
    });
    return resolved ? upgradeUnixLauncherToNativeBinary(resolved, { platform }) : null;
  } catch (_error) {
    return null;
  }
}

const museLimitsCache = createLimitsCache({
  file: MUSE_LIMITS_CACHE_FILE,
  key: null,
  maxAgeMs: MUSE_LIMITS_CACHE_MAX_AGE_MS,
  unknownResetTtlMs: MUSE_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS,
  fields: { plan_label: "string", profile_identity: "string" },
  windowKeys: ["primary_window", "secondary_window"],
  identityField: "profile_identity",
  identityRequired: false,
  writeGuard: (record) =>
    Boolean(record?.configured) &&
    !record.error &&
    Boolean(record.primary_window || record.secondary_window),
  cachedFlag: true,
  stale: true,
  source: { const: "disk-cache" },
});

function museLimitsCachePath({ home = os.homedir(), trackerDir } = {}) {
  return museLimitsCache.path({ home, trackerDir });
}

function readMuseLimitsCache({
  home = os.homedir(),
  trackerDir,
  nowMs = Date.now(),
  profileIdentity = null,
} = {}) {
  return museLimitsCache.read({ home, trackerDir, nowMs, identity: profileIdentity });
}

function writeMuseLimitsCache(limits, { home = os.homedir(), trackerDir, nowMs = Date.now() } = {}) {
  museLimitsCache.write(limits, { home, trackerDir, nowMs });
}

function clearMuseLimitsCache({ home = os.homedir(), trackerDir } = {}) {
  try {
    fs.unlinkSync(museLimitsCachePath({ home, trackerDir }));
  } catch (_error) {}
}

function readCachedMusePlanLabel({ home = os.homedir(), trackerDir, profileIdentity = null } = {}) {
  const raw = readCacheJson(museLimitsCachePath({ home, trackerDir }));
  if (!raw || typeof raw !== "object") return null;
  if (
    profileIdentity &&
    typeof raw.profile_identity === "string" &&
    raw.profile_identity &&
    raw.profile_identity !== profileIdentity
  ) {
    return null;
  }
  return typeof raw.plan_label === "string" && raw.plan_label.trim()
    ? raw.plan_label.trim()
    : null;
}

function isMuseAuthErrorText(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return /not logged in|run [`']?muse login[`']?|authentication required|unauthorized|credential_rejected|invalid[_\s-]?token|token expired|please log in/i.test(
    text,
  );
}

function isMuseSubscriptionRequiredText(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return /payment_subscription_required|no_allowance|subscription required/i.test(text);
}

function trimStderr(stderr) {
  const text = String(stderr || "").trim();
  if (!text) return null;
  return text.length > MUSE_CLI_STDERR_TRIM
    ? `${text.slice(0, MUSE_CLI_STDERR_TRIM)}…`
    : text;
}

/**
 * Normalize the JSON payload printed by `muse usage --json`.
 *
 * Returns:
 * - `{ kind: "ok", record }` when live quota windows are available (including
 *   an unstarted rolling window where `reason === "server_sent_no_usage"` on
 *   an active subscription),
 * - `{ kind: "reauth", record }` when credentials are missing or rejected,
 * - `{ kind: "no_subscription", record }` when the account has no Muse Code
 *   subscription allowance (API-key / pay-as-you-go),
 * or throws on malformed / transient payloads so the caller can fall back to
 * the bounded disk cache.
 */
function normalizeMuseUsageResponse(
  body,
  { profileIdentity = null, subsActive = null, fallbackPlanLabel = null, nowMs = Date.now() } = {},
) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Muse Code usage response is not an object.");
  }

  if (body.allowance && typeof body.allowance === "object") {
    const primaryWindow = normalizeMuseWindow(
      body.allowance.window,
      MUSE_FIVE_HOUR_WINDOW_SECONDS,
    );
    const secondaryWindow = normalizeMuseWindow(
      body.allowance.weekly,
      MUSE_WEEKLY_WINDOW_SECONDS,
    );
    if (!primaryWindow && !secondaryWindow) {
      throw new Error("Muse Code allowance payload contains no usable quota windows.");
    }
    return {
      kind: "ok",
      record: {
        configured: true,
        error: null,
        plan_label: deriveMusePlanLabel(body.allowance.tier) || fallbackPlanLabel || null,
        primary_window: primaryWindow,
        secondary_window: secondaryWindow,
        stale: false,
        cached_at: new Date(nowMs).toISOString(),
        source: "provider-api",
        profile_identity: profileIdentity || null,
      },
    };
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const message = typeof body.error === "string" ? body.error.trim() : "";

  if (reason === "credential_rejected" || isMuseAuthErrorText(reason) || isMuseAuthErrorText(message)) {
    return {
      kind: "reauth",
      record: {
        configured: true,
        error: MUSE_AUTH_EXPIRED_MESSAGE,
        auth_action_required: "reauth",
      },
    };
  }

  if (reason === "no_allowance" || isMuseSubscriptionRequiredText(reason) || isMuseSubscriptionRequiredText(message)) {
    return {
      kind: "no_subscription",
      record: {
        configured: true,
        error: MUSE_SUBSCRIPTION_REQUIRED_MESSAGE,
      },
    };
  }

  if (body.allowance === null && reason === "server_sent_no_usage") {
    if (subsActive === false) {
      return {
        kind: "no_subscription",
        record: {
          configured: true,
          error: MUSE_SUBSCRIPTION_REQUIRED_MESSAGE,
        },
      };
    }
    // Muse Code's server omits X-Muse-Usage headers until the first prompt in
    // a fresh rolling window. Surface idle 0% windows with undated resets so
    // the card renders cleanly instead of erroring before the first turn.
    return {
      kind: "ok",
      record: {
        configured: true,
        error: null,
        plan_label: fallbackPlanLabel || null,
        primary_window: {
          used_percent: 0,
          reset_at: null,
          limit_window_seconds: MUSE_FIVE_HOUR_WINDOW_SECONDS,
        },
        secondary_window: {
          used_percent: 0,
          reset_at: null,
          limit_window_seconds: MUSE_WEEKLY_WINDOW_SECONDS,
        },
        stale: false,
        cached_at: new Date(nowMs).toISOString(),
        source: "provider-api",
        profile_identity: profileIdentity || null,
      },
    };
  }

  throw new Error(
    message || (reason ? `Muse Code returned no usage (${reason}).` : "Muse Code usage response contained no allowance data."),
  );
}

async function fetchMuseLimits({
  commandRunner,
  home = os.homedir(),
  trackerDir,
  env = process.env,
  nowMs = Date.now(),
  injectedNowMs = null,
  platform = process.platform,
  signal,
  globalBinDirs,
  providerTimeoutMs = MUSE_PROVIDER_TIMEOUT_MS,
} = {}) {
  const startedAtMs = performance.now();
  const budgetedTimeoutMs = (fullTimeoutMs) => {
    if (!Number.isFinite(providerTimeoutMs) || providerTimeoutMs <= 0) return fullTimeoutMs;
    const remainingMs = providerTimeoutMs - (performance.now() - startedAtMs);
    if (remainingMs <= 0) return 0;
    const guardedMs = Math.floor(remainingMs - MUSE_PROVIDER_BUDGET_GUARD_MS);
    if (guardedMs <= 0) return 0;
    return Math.min(fullTimeoutMs, guardedMs);
  };

  const installEvidence = hasMuseInstallEvidence({ home, platform, env });
  const museCmd = await resolveMuseCommand({
    commandRunner,
    home,
    platform,
    env,
    signal,
    globalBinDirs,
    allowPathLookup: installEvidence,
  });
  if (!museCmd) {
    return { configured: false };
  }

  const usageTimeoutMs = budgetedTimeoutMs(MUSE_USAGE_TIMEOUT_MS);
  if (usageTimeoutMs <= 0) {
    return { configured: true, error: "Muse Code provider timed out before muse could run." };
  }

  const commandEnv = {
    ...resolvedCliEnvironment(museCmd.binaryPath, { env, platform }),
    MUSE_NO_AUTO_UPDATE: "1",
  };
  const result = await runCommand(
    commandRunner,
    museCmd.binaryPath,
    ["usage", "--json"],
    {
      env: commandEnv,
      signal,
      killProcessGroup: true,
      platform,
      useShell: museCmd.useShell,
      timeout: usageTimeoutMs,
    },
  );

  const failWithCache = (message) => {
    // Re-read current local auth identity at fallback time so an account switch
    // during a slow/failing CLI call cannot match the previous account's cache.
    const currentAuth = readMuseAuthMetadata({ home, env });
    const effectiveNowMs = injectedNowMs ?? Date.now();
    const cached = readMuseLimitsCache({
      home,
      trackerDir,
      nowMs: effectiveNowMs,
      profileIdentity: currentAuth.identity,
    });
    if (cached) return cached;
    return { configured: true, error: message };
  };

  const stdoutText = String(result?.stdout || "").trim();
  const stderrText = String(result?.stderr || "").trim();

  if (result?.error || result?.status !== 0) {
    const combinedOutput = [stderrText, stdoutText, result?.error?.message || ""]
      .filter(Boolean)
      .join(" ");
    if (isMuseAuthErrorText(combinedOutput)) {
      return {
        configured: true,
        error: MUSE_AUTH_EXPIRED_MESSAGE,
        auth_action_required: "reauth",
      };
    }
    if (isMuseSubscriptionRequiredText(combinedOutput)) {
      clearMuseLimitsCache({ home, trackerDir });
      return {
        configured: true,
        error: MUSE_SUBSCRIPTION_REQUIRED_MESSAGE,
      };
    }
    const baseDetail =
      result?.error?.message ||
      (result?.status !== 0 && result?.status !== null
        ? `muse exited with code ${result.status}`
        : "muse usage failed");
    const stderr = trimStderr(stderrText || stdoutText);
    const message = stderr && stderr !== baseDetail ? `${baseDetail}: ${stderr}` : baseDetail;
    return failWithCache(message);
  }

  let body;
  try {
    body = JSON.parse(stdoutText);
  } catch (_error) {
    if (isMuseAuthErrorText(stdoutText) || isMuseAuthErrorText(stderrText)) {
      return {
        configured: true,
        error: MUSE_AUTH_EXPIRED_MESSAGE,
        auth_action_required: "reauth",
      };
    }
    return failWithCache("muse usage --json returned invalid JSON.");
  }

  const currentAuth = readMuseAuthMetadata({ home, env });
  const fallbackPlanLabel = readCachedMusePlanLabel({
    home,
    trackerDir,
    profileIdentity: currentAuth.identity,
  });

  let outcome;
  try {
    outcome = normalizeMuseUsageResponse(body, {
      profileIdentity: currentAuth.identity,
      subsActive: currentAuth.subsActive,
      fallbackPlanLabel,
      nowMs,
    });
  } catch (error) {
    return failWithCache(error?.message || "Muse Code response could not be parsed.");
  }

  if (outcome.kind === "no_subscription") {
    clearMuseLimitsCache({ home, trackerDir });
    return outcome.record;
  }
  if (outcome.kind === "reauth") {
    return outcome.record;
  }

  writeMuseLimitsCache(outcome.record, { home, trackerDir, nowMs });
  const { profile_identity: _identity, ...publicRecord } = outcome.record;
  return publicRecord;
}

module.exports = {
  MUSE_FIVE_HOUR_WINDOW_SECONDS,
  MUSE_WEEKLY_WINDOW_SECONDS,
  MUSE_SUBSCRIPTION_REQUIRED_MESSAGE,
  MUSE_AUTH_EXPIRED_MESSAGE,
  deriveMusePlanLabel,
  fingerprintMuseAccount,
  hasMuseInstallEvidence,
  readMuseAuthMetadata,
  resolveMuseInstallExecutable,
  resolveWindowsMuseExecutable,
  resolveMuseCommand,
  normalizeMuseUsageResponse,
  readMuseLimitsCache,
  writeMuseLimitsCache,
  clearMuseLimitsCache,
  fetchMuseLimits,
};
