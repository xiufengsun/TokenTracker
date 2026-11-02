// Devin subscription usage limits.
//
// Source: the official seat-management RPC the Devin web app calls,
//   POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus
// authenticated by `x-auth-token` — the session token the Devin CLI stores in
// $XDG_DATA_HOME/devin/credentials.toml (~/.local/share/devin/ fallback).
//
// Two non-obvious contract points, both verified against the official
// generated descriptor (docs/devin-limits.md):
//   - the quota percent/reset fields are proto3 implicit scalars, so the
//     server omits them at 0: absent percent + live reset = exhausted
//     (100% used), both absent = no such window;
//   - a non-default api_server_url is an unsupported configuration, never a
//     different request destination — the token only ever goes to the fixed
//     host above.

const fs = require("node:fs");
const path = require("node:path");

const DEVIN_PLAN_STATUS_URL =
  "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus";
const DEVIN_API_ORIGIN = "https://server.codeium.com";

const DEVIN_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DEVIN_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Local sign-in problems are persistent configuration errors, not transient
// fetch failures: the aggregator's disk-cache fallback must never mask them,
// so they carry a distinctive code the assembly can gate on.
function credentialsError(message) {
  const error = new Error(message);
  error.code = "CREDENTIALS_INVALID";
  return error;
}

// Minimal root-level TOML reader for the CLI-written credentials file: bare
// `key = value` lines before the first `[section]`, nothing else.
function parseDevinCredentialsToml(raw) {
  const fields = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;
    const match = /^([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(
      trimmed,
    );
    if (!match) continue;
    const [, key, doubleQuoted, singleQuoted, bare] = match;
    fields[key] = doubleQuoted ?? singleQuoted ?? bare ?? "";
  }
  return fields;
}

// Returns { apiKey } or null when no sign-in exists (no home, or the file is
// absent — ENOENT only). Any other read failure or a mangled file throws an
// owned, actionable error with no path or filesystem details, so a broken
// sign-in can never masquerade as "not configured".
function readDevinCredentials({ home, env = process.env } = {}) {
  const xdg = env && typeof env === "object" ? env.XDG_DATA_HOME : null;
  const dir = isNonEmptyString(xdg)
    ? xdg.trim()
    : isNonEmptyString(home)
      ? home.trim()
      : isNonEmptyString(env?.HOME)
        ? env.HOME.trim()
        : null;
  if (!dir) return null;
  const base = isNonEmptyString(xdg)
    ? path.join(dir, "devin", "credentials.toml")
    : path.join(dir, ".local", "share", "devin", "credentials.toml");
  let raw;
  try {
    raw = fs.readFileSync(base, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw credentialsError(
      "Could not read the Devin CLI credentials file — check its permissions or run `devin auth login` to sign in again.",
    );
  }
  const fields = parseDevinCredentialsToml(raw);
  const apiKey = isNonEmptyString(fields.windsurf_api_key)
    ? fields.windsurf_api_key.trim()
    : null;
  if (!apiKey) {
    throw credentialsError(
      "Devin credentials file has no sign-in token — run `devin auth login`.",
    );
  }
  const apiServerUrl = isNonEmptyString(fields.api_server_url)
    ? fields.api_server_url.trim().replace(/\/+$/, "")
    : null;
  if (apiServerUrl && apiServerUrl !== DEVIN_API_ORIGIN) {
    throw credentialsError(
      "Devin credentials point at a custom api_server_url, which this quota provider does not support.",
    );
  }
  return { apiKey };
}

function malformed(field) {
  return new Error(`Devin quota response has a malformed ${field}.`);
}

// undefined → proto-default semantics handled by the caller; null/non-numeric
// → malformed. Percentages are clamped defensively to 0..100.
function normalizeRemainingPercent(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" && typeof value !== "string") {
    throw malformed("quota remaining percent");
  }
  if (typeof value === "string" && value.trim() === "") {
    throw malformed("quota remaining percent");
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw malformed("quota remaining percent");
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

// int64 unix seconds (JSON string or number). undefined or proto-default 0 →
// absent; null/non-numeric/non-positive → malformed. Returns epoch ms.
function normalizeResetMs(value) {
  if (value === undefined || value === 0 || value === "0") return null;
  if (typeof value !== "number" && typeof value !== "string") {
    throw malformed("quota reset timestamp");
  }
  if (typeof value === "string" && value.trim() === "") {
    throw malformed("quota reset timestamp");
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw malformed("quota reset timestamp");
  const ms = n * 1000;
  if (!Number.isFinite(new Date(ms).getTime())) {
    throw malformed("quota reset timestamp");
  }
  return ms;
}

function normalizeWindow({ remainingPercent, resetUnix, hidden, windowSeconds }) {
  if (hidden === true) return null;
  const resetMs = normalizeResetMs(resetUnix);
  const remaining = normalizeRemainingPercent(remainingPercent);
  if (remaining === undefined && resetMs === null) return null;
  return {
    used_percent: remaining === undefined ? 100 : 100 - remaining,
    reset_at: resetMs === null ? null : new Date(resetMs).toISOString(),
    limit_window_seconds: windowSeconds,
  };
}

function normalizePlanStatus(body) {
  const planStatus =
    body && typeof body === "object" ? body.planStatus : undefined;
  if (!planStatus || typeof planStatus !== "object") {
    throw new Error("Devin quota response is missing planStatus.");
  }
  const planInfo =
    planStatus.planInfo && typeof planStatus.planInfo === "object"
      ? planStatus.planInfo
      : {};
  const planLabel = isNonEmptyString(planInfo.planName)
    ? planInfo.planName.trim()
    : null;

  // Legacy Windsurf billing fills ACU credit fields instead of the daily /
  // weekly quota; those strategies have nothing renderable here.
  const billingStrategy = planInfo.billingStrategy;
  if (
    billingStrategy !== undefined &&
    billingStrategy !== "BILLING_STRATEGY_QUOTA"
  ) {
    return { plan_label: planLabel, primary_window: null, secondary_window: null };
  }

  return {
    plan_label: planLabel,
    primary_window: normalizeWindow({
      remainingPercent: planStatus.dailyQuotaRemainingPercent,
      resetUnix: planStatus.dailyQuotaResetAtUnix,
      hidden: planInfo.hideDailyQuota === true,
      windowSeconds: DEVIN_DAILY_WINDOW_SECONDS,
    }),
    secondary_window: normalizeWindow({
      remainingPercent: planStatus.weeklyQuotaRemainingPercent,
      resetUnix: planStatus.weeklyQuotaResetAtUnix,
      hidden: planInfo.hideWeeklyQuota === true,
      windowSeconds: DEVIN_WEEKLY_WINDOW_SECONDS,
    }),
  };
}

// `{ configured: false }` when the provider is not enabled or no Devin CLI
// sign-in exists, otherwise the normalized windows. `enabled` is the user's
// explicit provider selection forwarded from the local API — without it the
// credentials file is never opened and no request is made. Throws owned
// errors only — never raw upstream bodies, filesystem paths or token values.
// `code: "AUTH_EXPIRED"` flags genuine auth failure for the aggregator's
// auth_action_required path.
async function fetchDevinLimits({ home, env = process.env, enabled = false, fetchImpl = fetch } = {}) {
  if (enabled !== true) return { configured: false };
  const credentials = readDevinCredentials({ home, env });
  if (!credentials) return { configured: false };

  let response;
  try {
    response = await fetchImpl(DEVIN_PLAN_STATUS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-auth-token": credentials.apiKey,
      },
      body: "{}",
      // The session token must never reach another origin.
      redirect: "error",
    });
  } catch (error) {
    throw new Error(
      error && (error.name === "AbortError" || error.name === "TimeoutError")
        ? "Devin quota request timed out."
        : "Devin quota request failed.",
    );
  }
  if (response?.status === 401 || response?.status === 403) {
    const error = new Error(
      "Devin sign-in expired or was rejected — run `devin auth login` to sign in again.",
    );
    error.code = "AUTH_EXPIRED";
    throw error;
  }
  if (!response?.ok) {
    throw new Error(
      `Devin quota request was rejected (HTTP ${response?.status ?? "?"}).`,
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Devin quota response was not JSON.");
  }
  const windows = normalizePlanStatus(body);
  return {
    configured: true,
    error: null,
    plan_label: windows.plan_label,
    primary_window: windows.primary_window,
    secondary_window: windows.secondary_window,
  };
}

module.exports = { fetchDevinLimits };
