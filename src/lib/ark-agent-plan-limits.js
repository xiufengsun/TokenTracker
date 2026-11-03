"use strict";

// Ark Agent Plan (火山方舟 Agent Plan) quota monitoring.
//
// Agent Plan (Small/Medium/Large/Max) and Coding Plan (Lite/Pro) are
// two parallel subscription products that each refresh on three windows —
// 5-hour (5h for Agent Plan, session for Coding Plan), weekly and monthly —
// and are shared by compatible coding tools (Claude Code, Codex CLI,
// OpenCode, TRAE, ...). Official docs present them as parallel, not
// successor/replacement. TokenTracker already counts those tools' token
// consumption from their local files, so this module deliberately adds
// NO consumption source. It only surfaces the subscription quota
// percentage, which is otherwise only visible in the Volcano console web
// page. Coding Plan is handled by a separate provider module
// `ark-coding-plan-limits.js` (dual Provider, issue #555).
//
// The quota is read through the user's own `arkcli` binary
// (`arkcli usage plan --format json`), which is already installed and logged
// in for users of the Ark CLI ecosystem. Feature-detected: when `arkcli` is
// missing, the provider simply reports `configured: false` and stays out of
// the way. Mirrors ark-coding-plan-limits.js; shares the command runner with
// usage-limits.js through ./command-runner (no circular dependency).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runCommand, resolveBinaryPath, statBinaryInDirs, commonGlobalBinDirectories, resolvedCliEnvironment } = require("./command-runner");
const { createLimitsCache } = require("./limits-cache");

const ARK_LIMITS_CACHE_FILE = "ark-agent-plan-limits-cache.json";
const ARK_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS = 12 * 60 * 60 * 1000;
const ARK_USAGE_PLAN_TIMEOUT_MS = 10_000;
const ARK_PROFILE_SHOW_TIMEOUT_MS = 2_500;
const ARK_CLI_STDERR_TRIM = 400;
const ARK_PROVIDER_TIMEOUT_MS = 15_000;
const ARK_PROVIDER_BUDGET_GUARD_MS = 1_500;

// arkcli period label -> canonical window slot.
// Agent Plan uses `5h` for the 5-hour rolling window; `daily` is a
// visual-only quota not shown in the 3-window panel.
const ARK_PERIOD_WINDOW = {
  "5h": "primary_window",
  session: "primary_window",
  weekly: "secondary_window",
  monthly: "tertiary_window",
};

// Agent Plan personal product. Team products (agent-plan-team) are
// seat-scoped and not surfaced in this personal-quota panel.
const ARK_PERSONAL_PRODUCTS = ["agent-plan"];
const ARK_PRODUCT_PRIORITY = ["agent-plan"];

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function normalizeResetAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return null;
    const milliseconds = raw > 10_000_000_000 ? raw : raw * 1000;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function planLabelForTier(tier) {
  const normalized = String(tier || "").trim().toLowerCase();
  const mapping = {
    pro: "Pro",
    lite: "Lite",
    small: "Small",
    medium: "Medium",
    large: "Large",
    max: "Max",
  };
  if (mapping[normalized]) return mapping[normalized];
  return tier && String(tier).trim() ? String(tier).trim() : null;
}

/**
 * Normalize the JSON payload returned by `arkcli plans get --format json`.
 * Returns null when there is no Agent Plan entry.
 */
function normalizeArkAgentPlansResponse(body) {
  if (!body || typeof body !== "object") return null;
  const plans = Array.isArray(body.plans) ? body.plans : [];
  for (const key of ARK_PRODUCT_PRIORITY) {
    const plan = plans.find((entry) => entry?.key === key);
    if (plan?.tier) return String(plan.tier);
  }
  return null;
}
// Backwards-compat alias used by older callers
const normalizeArkPlansResponse = normalizeArkAgentPlansResponse;

function arkProfileIdentity(body) {
  const profile = body?.profile && typeof body.profile === "object" ? body.profile : body;
  const name = typeof body?.profile === "string"
    ? body.profile
    : profile?.name || profile?.profile || profile?.profile_name;
  let userId = profile?.user_id || profile?.userId || body?.user_id || body?.userId;
  if (!userId) {
    const trnMatch = String(profile?.owner_trn || "").match(/::(\d+):/);
    if (trnMatch) userId = trnMatch[1];
    else {
      const keyMatch = String(profile?.identity_key || "").match(/-(\d+)$/);
      if (keyMatch) userId = keyMatch[1];
    }
  }
  const identity = [name, userId].filter(Boolean).join(":");
  return identity || null;
}

function resolveArkProductItem(items) {
  for (const product of ARK_PRODUCT_PRIORITY) {
    const item = items.find((entry) => entry?.product === product && entry?.subscribed === true);
    if (item) return item;
  }
  return null;
}

function percentFromPeriod(period) {
  // null / undefined / blank percent must fall through to the used/total
  // fallback: Number(null) and Number("") both coerce to 0, which would
  // otherwise report a fake fresh 0% window instead of deriving real usage
  // (the Agent Plan 5h period can omit percent entirely, #555).
  const rawPercent = period?.percent;
  if (rawPercent !== null && rawPercent !== undefined && String(rawPercent).trim() !== "") {
    const direct = Number(rawPercent);
    if (Number.isFinite(direct)) return direct;
  }
  const used = Number(period?.used);
  const total = Number(period?.total);
  if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
    return (used / total) * 100;
  }
  return NaN;
}

/**
 * Normalize the JSON payload returned by `arkcli usage plan --format json`.
 * Returns `null` when the account has no active Agent Plan subscription
 * (caller reports `configured: false`). Throws when the payload shape is
 * unusable so the caller can fall back to the disk cache.
 */
function normalizeArkAgentPlanResponse(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Ark Agent Plan response is not an object.");
  }
  const items = Array.isArray(body.items) ? body.items : [];
  const item = resolveArkProductItem(items);
  if (!item) return null;

  const windows = {};
  const periods = Array.isArray(item.periods) ? item.periods : [];
  for (const period of periods) {
    if (period?.label === "daily") continue;
    const slot = ARK_PERIOD_WINDOW[period?.label];
    if (!slot) continue;
    const percent = percentFromPeriod(period);
    if (!Number.isFinite(percent)) continue;
    windows[slot] = {
      used_percent: clampPercent(percent),
      reset_at: normalizeResetAt(period.reset_at),
      unit: "calls",
    };
  }
  if (!windows.primary_window && !windows.secondary_window && !windows.tertiary_window) {
    throw new Error("Ark Agent Plan response contains no usable quota periods.");
  }

  return {
    configured: true,
    error: null,
    plan_label: planLabelForTier(item.tier),
    product: item.product || null,
    primary_window: windows.primary_window || null,
    secondary_window: windows.secondary_window || null,
    tertiary_window: windows.tertiary_window || null,
    source: "provider-api",
    profile_identity: arkProfileIdentity(body.viewer),
  };
}
// Alias for shared shape
const normalizeArkCodingPlanResponse = normalizeArkAgentPlanResponse;

// Deliberately fail-open on identity: the guard only applies when `profile
// show` could establish the current identity — when it also failed, serving
// the stale cache beats erroring out (availability over strictness). There is
// no global max-age: dated windows are bounded by their own reset stamp and
// undated ones by the 12h unknown-reset TTL.
const arkLimitsCache = createLimitsCache({
  file: ARK_LIMITS_CACHE_FILE,
  key: null,
  maxAgeMs: null,
  unknownResetTtlMs: ARK_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS,
  fields: { plan_label: "string", product: "string", profile_identity: "string" },
  windowKeys: ["primary_window", "secondary_window", "tertiary_window"],
  identityField: "profile_identity",
  identityRequired: false,
  // The normalizer throws when no periods survive, so the write guard skips
  // the window check the other providers need.
  writeGuard: (record) => Boolean(record?.configured) && !record.error,
  cachedFlag: true,
  stale: true,
  source: { const: "disk-cache" },
});

function arkAgentPlanCachePath({ home = os.homedir() } = {}) {
  return arkLimitsCache.path({ home });
}

function readArkAgentPlanLimitsCache({ home = os.homedir(), nowMs = Date.now(), profileIdentity } = {}) {
  return arkLimitsCache.read({ home, nowMs, identity: profileIdentity });
}

function writeArkAgentPlanLimitsCache(limits, { home = os.homedir(), nowMs = Date.now() } = {}) {
  arkLimitsCache.write(limits, { home, nowMs });
}

function hasArkCliInstallEvidence({ home = os.homedir(), platform = process.platform } = {}) {
  const candidates = [
    path.join(home, ".arkcli"),
    path.join(home, ".config", "arkcli"),
  ];
  if (platform === "win32") {
    candidates.push(path.join(home, "AppData", "Roaming", "arkcli"));
  }
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return true;
    } catch (_error) {}
  }
  return false;
}

function trimStderr(stderr) {
  const text = String(stderr || "").trim();
  if (!text) return null;
  return text.length > ARK_CLI_STDERR_TRIM
    ? `${text.slice(0, ARK_CLI_STDERR_TRIM)}…`
    : text;
}

/**
 * Fetch Ark Agent Plan quota windows from the local `arkcli` binary.
 */
async function fetchArkAgentPlanLimits({
  commandRunner,
  home = os.homedir(),
  nowMs = Date.now(),
  platform = process.platform,
  signal,
  globalBinDirs,
  providerTimeoutMs = ARK_PROVIDER_TIMEOUT_MS,
} = {}) {
  const startedAtMs = performance.now();
  const budgetedTimeoutMs = (fullTimeoutMs) => {
    if (!Number.isFinite(providerTimeoutMs) || providerTimeoutMs <= 0) return fullTimeoutMs;
    const remainingMs = providerTimeoutMs - (performance.now() - startedAtMs);
    if (remainingMs <= 0) return 0;
    const guardedMs = Math.floor(remainingMs - ARK_PROVIDER_BUDGET_GUARD_MS);
    if (guardedMs <= 0) return 0;
    return Math.min(fullTimeoutMs, guardedMs);
  };

  const searchDirs = () => Array.isArray(globalBinDirs)
    ? globalBinDirs
    : commonGlobalBinDirectories({ home, platform });

  let arkcliPath;
  if (hasArkCliInstallEvidence({ home, platform })) {
    try {
      arkcliPath = await resolveBinaryPath("arkcli", { commandRunner, home, platform, signal, globalBinDirs });
    } catch (_error) {
      arkcliPath = null;
    }
  } else {
    arkcliPath = statBinaryInDirs("arkcli", searchDirs(), platform);
  }
  if (!arkcliPath) return { configured: false };

  const commandOptions = {
    env: resolvedCliEnvironment(arkcliPath, { platform }),
    signal,
    killProcessGroup: true,
    platform,
    useShell: platform === "win32",
  };

  const usageTimeoutMs = budgetedTimeoutMs(ARK_USAGE_PLAN_TIMEOUT_MS);
  if (usageTimeoutMs <= 0) {
    return { configured: true, error: "Ark Agent Plan provider timed out before arkcli could run." };
  }

  const result = await runCommand(
    commandRunner,
    arkcliPath,
    ["usage", "plan", "--format", "json"],
    { ...commandOptions, timeout: usageTimeoutMs },
  );

  const failWithCache = async (message) => {
    const profileTimeoutMs = budgetedTimeoutMs(ARK_PROFILE_SHOW_TIMEOUT_MS);
    const profileIdentity = profileTimeoutMs > 0
      ? await runCommand(
        commandRunner,
        arkcliPath,
        ["profile", "show", "--format", "json"],
        { ...commandOptions, timeout: profileTimeoutMs },
      ).then((profileResult) => {
        if (profileResult?.error || profileResult?.status !== 0) return null;
        try {
          return arkProfileIdentity(JSON.parse(String(profileResult.stdout || "")));
        } catch (_error) {
          return null;
        }
      }).catch(() => null)
      : null;
    const cached = readArkAgentPlanLimitsCache({ home, nowMs, profileIdentity });
    if (cached) return cached;
    return { configured: true, error: message };
  };

  if (result?.error || result?.status !== 0) {
    const isExit127 = result?.status === 127;
    const baseDetail = result?.error?.message
      || (result?.status !== 0 && result?.status !== null
        ? `arkcli exited with code ${result.status}`
        : "arkcli usage plan failed");
    const detail = isExit127
      ? "arkcli exited with code 127 — check its runtime/PATH or update arkcli: npm i -g @volcengine/ark-cli"
      : baseDetail;
    const stderr = trimStderr(result?.stderr);
    const message = stderr ? `${detail}: ${stderr}` : detail;
    return failWithCache(message);
  }

  let body;
  try {
    body = JSON.parse(String(result?.stdout || ""));
  } catch (_error) {
    return failWithCache("arkcli usage plan returned invalid JSON.");
  }

  let limits;
  try {
    limits = normalizeArkAgentPlanResponse(body);
  } catch (error) {
    return failWithCache(error?.message || "Ark Agent Plan response could not be parsed.");
  }
  if (!limits) {
    const entry = Array.isArray(body?.items)
      ? body.items.find(
        (candidate) =>
          ARK_PERSONAL_PRODUCTS.includes(candidate?.product) && candidate?.subscribed === false,
      )
      : null;
    if (entry) {
      try {
        fs.unlinkSync(arkAgentPlanCachePath({ home }));
      } catch (_error) {}
    }
    return { configured: false };
  }

  if (!limits.plan_label) {
    const plansTimeoutMs = budgetedTimeoutMs(ARK_USAGE_PLAN_TIMEOUT_MS);
    if (plansTimeoutMs > 0) {
      const plansResult = await runCommand(
        commandRunner,
        arkcliPath,
        ["plans", "get", "--format", "json"],
        { ...commandOptions, timeout: plansTimeoutMs },
      );
      if (!plansResult?.error && plansResult?.status === 0) {
        try {
          const tier = normalizeArkAgentPlansResponse(JSON.parse(String(plansResult.stdout || "")));
          if (tier) limits.plan_label = planLabelForTier(tier);
        } catch (_error) {}
      }
    }
  }

  writeArkAgentPlanLimitsCache(limits, { home, nowMs });
  return limits;
}

module.exports = {
  ARK_PERIOD_WINDOW,
  ARK_PERSONAL_PRODUCTS,
  ARK_PRODUCT_PRIORITY,
  normalizeArkAgentPlansResponse,
  normalizeArkPlansResponse,
  arkProfileIdentity,
  normalizeArkAgentPlanResponse,
  normalizeArkCodingPlanResponse,
  readArkAgentPlanLimitsCache,
  writeArkAgentPlanLimitsCache,
  hasArkCliInstallEvidence,
  fetchArkAgentPlanLimits,
  resolveArkProductItem,
  percentFromPeriod,
};
