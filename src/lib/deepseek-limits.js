"use strict";

// DeepSeek (platform.deepseek.com, pay-as-you-go) balance monitoring.
//
// DeepSeek has no quota windows at all: it is a prepaid API platform, and the
// only documented programmatic data source is the balance endpoint
// (GET https://api.deepseek.com/user/balance, Bearer API key). It returns
// `is_available` plus `balance_infos[]` entries whose numeric fields are all
// STRINGS ("110.02"), and more than one currency (CNY + USD) can be present
// at the same time. Concurrency rate limits (flash 2500 / v4-pro 500, 429)
// are not quota windows, so nothing here produces a window bar — the panel
// renders a balance card instead (issue #960).
//
// The API key comes from DEEPSEEK_API_KEY when set, otherwise from the key
// saved in the Limits panel (provider-api-key-store.js). The stored key exists
// so users never need a machine-wide `launchctl setenv`, which reaches every
// launchd app on macOS and not just TokenTracker (#837).
//
// Balance only decreases between top-ups and there is no reset instant to
// check, so the last-good disk-cache fallback (0600 JSON, written only on a
// live success) is gated by a pure TTL — the same "unknown reset" rule the
// ark providers use — and by a fingerprint of the API key that produced it,
// so a swapped key can never serve the previous account's balance.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readStoredApiKey } = require("./provider-api-key-store");

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEEPSEEK_LIMITS_CACHE_FILE = "deepseek-limits-cache.json";
const DEEPSEEK_ENV_NAME = "DEEPSEEK_API_KEY";
const DEEPSEEK_REQUEST_TIMEOUT_MS = 10_000;
const DEEPSEEK_BALANCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function readDeepseekApiKey({ home, trackerDir, env = process.env } = {}) {
  const envKey =
    env && typeof env === "object" && typeof env[DEEPSEEK_ENV_NAME] === "string"
      ? env[DEEPSEEK_ENV_NAME].trim()
      : "";
  if (envKey) return { apiKey: envKey, source: "env" };
  const stored = readStoredApiKey({ provider: "deepseek", trackerDir, home });
  return stored ? { apiKey: stored, source: "stored" } : null;
}

// Balance payloads are strings; a malformed or negative entry must drop out
// rather than coerce into a misleading 0 ("" and " " both coerce to 0).
function balanceNumber(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (typeof value !== "number") return null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Normalize the GET /user/balance payload into one row per currency, API
 * order preserved (the panel renders each currency side by side; picking a
 * single "primary" currency is an owner decision, not a parser concern).
 * Throws when the payload shape is unusable so the caller can fall back to
 * the disk cache.
 */
function normalizeDeepseekBalanceResponse(body) {
  if (!body || typeof body !== "object") {
    throw new Error("DeepSeek balance response is not an object.");
  }
  if (typeof body.is_available !== "boolean") {
    throw new Error("DeepSeek balance response is missing is_available.");
  }
  const entries = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const balances = [];
  for (const entry of entries) {
    const currency = typeof entry?.currency === "string" ? entry.currency.trim() : "";
    const total = balanceNumber(entry?.total_balance);
    if (!currency || total === null) continue;
    balances.push({
      currency,
      total,
      granted: balanceNumber(entry?.granted_balance) ?? 0,
      topped_up: balanceNumber(entry?.topped_up_balance) ?? 0,
    });
  }
  if (balances.length === 0) {
    throw new Error("DeepSeek balance response contains no usable balance entries.");
  }
  return balances;
}

function keyFingerprint(apiKey) {
  return crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 16);
}

function resolveDeepseekLimitsCachePath({ trackerDir, home } = {}) {
  const dir =
    typeof trackerDir === "string" && trackerDir.trim()
      ? trackerDir.trim()
      : path.join(home || os.homedir(), ".tokentracker", "tracker");
  return path.join(dir, DEEPSEEK_LIMITS_CACHE_FILE);
}

/**
 * Last-good balance snapshot. `keyFingerprint` (when given) must match the
 * key that produced the cache — a different key is a different account, and
 * its balance would be a wrong answer, not a stale one.
 */
function readDeepseekLimitsCache({ trackerDir, home, nowMs = Date.now(), keyFingerprint: expectedFingerprint } = {}) {
  const cachePath = resolveDeepseekLimitsCachePath({ trackerDir, home });
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"))?.deepseek;
  } catch (_error) {
    return null;
  }
  const cachedAtMs = Date.parse(parsed?.cached_at || "");
  if (!Number.isFinite(cachedAtMs)) return null;
  if (cachedAtMs > nowMs + 60_000) return null;
  // Pure TTL: balances have no reset instant, so freshness decays with age
  // alone (ark's unknown-reset rule).
  if (nowMs - cachedAtMs > DEEPSEEK_BALANCE_CACHE_TTL_MS) return null;
  if (expectedFingerprint && parsed?.key_fingerprint !== expectedFingerprint) return null;
  const balances = Array.isArray(parsed?.balances)
    ? parsed.balances.filter(
      (entry) =>
        entry &&
        typeof entry.currency === "string" &&
        entry.currency.trim() &&
        balanceNumber(entry.total) !== null,
    )
    : [];
  if (balances.length === 0) return null;
  return {
    configured: true,
    error: null,
    is_available: parsed.is_available === true,
    balances,
    source: "disk-cache",
    stale: true,
    cached_at: parsed.cached_at,
  };
}

function writeDeepseekLimitsCache(limits, { trackerDir, home, nowMs = Date.now(), keyFingerprint: fingerprint } = {}) {
  if (!limits?.configured || limits.error || !Array.isArray(limits.balances) || limits.balances.length === 0) return;
  const cachePath = resolveDeepseekLimitsCachePath({ trackerDir, home });
  const payload = {
    deepseek: {
      is_available: limits.is_available === true,
      balances: limits.balances,
      key_fingerprint: fingerprint || null,
      cached_at: new Date(nowMs).toISOString(),
    },
  };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch (_error) {}
}

/**
 * One live GET /user/balance read. Returns {ok, is_available, balances} on a
 * usable payload, {auth_error: true, error} when the key itself is rejected
 * (actionable — must not be masked by stale cache), {error} otherwise.
 */
async function fetchDeepseekBalance({ apiKey, fetchImpl, timeoutMs = DEEPSEEK_REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return { error: `DeepSeek balance request failed: ${err?.message || err}` };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      auth_error: true,
      error: `DeepSeek API key was rejected (${response.status}). Check the key in the DeepSeek platform console.`,
    };
  }
  if (!response.ok) {
    return { error: `DeepSeek balance API returned ${response.status}` };
  }
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch (err) {
    return { error: `Could not parse DeepSeek balance response: ${err?.message || err}` };
  }
  try {
    return { ok: true, is_available: body.is_available === true, balances: normalizeDeepseekBalanceResponse(body) };
  } catch (err) {
    return { error: err?.message || "DeepSeek balance response could not be parsed." };
  }
}

/**
 * Fetch the DeepSeek balance card. `persistCache: false` lets the caller
 * suppress the disk write while its aggregate cache generation is stale
 * (a provider-key save mid-fetch must not republish pre-save data, #837).
 */
async function fetchDeepseekLimits({
  home = os.homedir(),
  trackerDir,
  env = process.env,
  fetchImpl = fetch,
  nowMs = Date.now(),
  timeoutMs = DEEPSEEK_REQUEST_TIMEOUT_MS,
  persistCache = true,
} = {}) {
  const credential = readDeepseekApiKey({ home, trackerDir, env });
  if (!credential) return { configured: false };
  const fingerprint = keyFingerprint(credential.apiKey);

  const live = await fetchDeepseekBalance({ apiKey: credential.apiKey, fetchImpl, timeoutMs });
  if (live.ok) {
    const result = {
      configured: true,
      error: null,
      is_available: live.is_available,
      balances: live.balances,
      credential_source: credential.source,
      source: "provider-api",
      stale: false,
      cached_at: new Date(nowMs).toISOString(),
    };
    if (persistCache) {
      writeDeepseekLimitsCache(result, { trackerDir, home, nowMs, keyFingerprint: fingerprint });
    }
    return result;
  }
  if (live.auth_error) {
    return { configured: true, error: live.error, auth_error: true, credential_source: credential.source };
  }
  const cached = readDeepseekLimitsCache({ trackerDir, home, nowMs, keyFingerprint: fingerprint });
  if (cached) return { ...cached, credential_source: credential.source };
  return { configured: true, error: live.error, credential_source: credential.source };
}

module.exports = {
  DEEPSEEK_BALANCE_URL,
  DEEPSEEK_LIMITS_CACHE_FILE,
  DEEPSEEK_ENV_NAME,
  DEEPSEEK_BALANCE_CACHE_TTL_MS,
  balanceNumber,
  fetchDeepseekBalance,
  fetchDeepseekLimits,
  keyFingerprint,
  normalizeDeepseekBalanceResponse,
  readDeepseekApiKey,
  readDeepseekLimitsCache,
  resolveDeepseekLimitsCachePath,
  writeDeepseekLimitsCache,
};
