"use strict";

// Doubao (豆包) subscription quota, read from Doubao's own web endpoints with
// the session Doubao desktop keeps locally (see doubao-cookies.js). Verified
// against Doubao 2.33.5 / macOS 27.2 (issue #826):
//
//   POST /alice/commerce/sale/subscription/quota/summary/ {"product_line":""}
//     → current_subscription.display.product_name, window_limit_section
//   POST /alice/commerce/sale/entitlement/usage_detail/ {}
//     → total_used_percent, window_limit_groups  (TokenTracker-shaped)
//
// Doubao counts subscription usage in credits across three rolling windows
// (5-hour, 7-day, and per-plan-month — i18n keys
// doubao_member_manage_quota_usage_{5h,7d,1m}_abs). There are no token fields
// anywhere in the local stores or these responses, so this provider is
// limits-only. Free accounts return empty window arrays: the section renders
// nothing rather than a fake 0% bar (same treatment as Qoder's empty 0/0).
//
// The paid-account window schema has not been observed yet (free-account
// recon only), so parsing is deliberately lenient: unrecognized shapes
// degrade to null windows instead of invented percentages.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveDoubaoDataDir, readDoubaoCookieSession } = require("./doubao-cookies");

const DOUBAO_ORIGIN = "https://www.doubao.com";
const DOUBAO_QUOTA_SUMMARY_URL = DOUBAO_ORIGIN + "/alice/commerce/sale/subscription/quota/summary/";
const DOUBAO_USAGE_DETAIL_URL = DOUBAO_ORIGIN + "/alice/commerce/sale/entitlement/usage_detail/";
const DOUBAO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
// Doubao reports an expired session as HTTP 200 with code 710012001
// ("登录已过期"), not as a 401 — handle both.
const DOUBAO_AUTH_EXPIRED_CODE = 710012001;
const DOUBAO_LIMITS_CACHE_FILE = "doubao-usage-limits-cache.json";
const DOUBAO_LIMITS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DOUBAO_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS = 12 * 60 * 60 * 1000;

// Candidate field spellings, camelCase and snake_case: the paid-window schema
// is unverified, so accept the plausible variants rather than a single guess.
const DOUBAO_WINDOW_KIND_FIELDS = [
  "window_type", "windowType", "type", "window_key", "windowKey", "key",
  "name", "label", "title", "window", "period", "window_name", "windowName",
  "limit_type", "limitType", "window_limit_type", "windowLimitType",
];
const DOUBAO_USED_FIELDS = ["used_quota", "usedQuota", "used_value", "usedValue", "used", "used_amount", "used_credits"];
const DOUBAO_TOTAL_FIELDS = ["total_quota", "totalQuota", "limit_value", "limitValue", "total", "limit_quota", "limitQuota", "limit", "total_credits"];
const DOUBAO_REMAINING_FIELDS = ["remaining_quota", "remainingQuota", "remaining_value", "remainingValue", "remaining", "remaining_credits"];
const DOUBAO_PERCENT_FIELDS = ["used_percent", "usedPercent", "usage_percent", "usagePercent", "usage_percentage", "usagePercentage", "percent"];
const DOUBAO_RESET_FIELDS = [
  "reset_at", "resetAt", "reset_time", "resetTime", "next_reset_at", "nextResetAt",
  "reset_timestamp", "resetTimestamp", "window_end_time", "windowEndTime",
  "expire_time", "expireTime", "end_time", "endTime",
];
const DOUBAO_UNIT_FIELDS = ["unit", "unit_name", "unitName"];
// Window-group payloads may wrap their numbers one level down.
const DOUBAO_GROUP_NESTED_FIELDS = ["display", "quota", "usage", "limit", "info", "window_limit"];
const DOUBAO_WINDOW_KINDS = [
  { slot: "primary_window", patterns: /5\s*h|five[\s_-]?hour|5[\s_-]?hour/i },
  { slot: "secondary_window", patterns: /7\s*d|seven[\s_-]?day|7[\s_-]?day|weekly/i },
  { slot: "tertiary_window", patterns: /(^|[^a-z])1\s*mo|(^|[^a-z])1\s*m|month(ly)?/i },
];

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstDefinedIn(object, fields) {
  if (!object || typeof object !== "object") return undefined;
  for (const field of fields) {
    const value = object[field];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// Search the group itself, then its known wrapper objects.
function firstDefinedAcross(group, fields) {
  const direct = firstDefinedIn(group, fields);
  if (direct !== undefined) return direct;
  for (const field of DOUBAO_GROUP_NESTED_FIELDS) {
    const nested = group?.[field];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const value = firstDefinedIn(nested, fields);
      if (value !== undefined) return value;
    }
  }
  return undefined;
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

function clampPercent(value) {
  if (value === null) return null;
  return Math.max(0, Math.min(100, value));
}

function doubaoWindowSlot(group) {
  const haystack = DOUBAO_WINDOW_KIND_FIELDS
    .map((field) => group?.[field])
    .filter((value) => typeof value === "string")
    .join(" ");
  if (!haystack) return null;
  for (const kind of DOUBAO_WINDOW_KINDS) {
    if (kind.patterns.test(haystack)) return kind.slot;
  }
  return null;
}

// Lenient window parser: numbers when the group carries any, percentage from
// used/total when possible, server-provided percent otherwise. A sub-1
// percentage is treated as a fraction (×100) — the natural encoding for a
// value below 1 from these APIs; a literal "1% used" reads as full only in the
// unverified-schema case this branch exists for. Unrecognizable groups
// degrade to null instead of an invented bar.
function normalizeDoubaoWindowGroup(group) {
  if (!group || typeof group !== "object") return null;
  const used = finiteOrNull(firstDefinedAcross(group, DOUBAO_USED_FIELDS));
  const total = finiteOrNull(firstDefinedAcross(group, DOUBAO_TOTAL_FIELDS));
  const remaining = finiteOrNull(firstDefinedAcross(group, DOUBAO_REMAINING_FIELDS));
  let percent = finiteOrNull(firstDefinedAcross(group, DOUBAO_PERCENT_FIELDS));
  if (percent !== null && percent > 0 && percent < 1) percent *= 100;

  let usedPercent = null;
  if (used !== null && total !== null) {
    usedPercent = total > 0 ? (used / total) * 100 : 0;
  } else {
    usedPercent = percent;
  }
  usedPercent = clampPercent(usedPercent);
  if (usedPercent === null && used === null && total === null && remaining === null) return null;

  const unit = firstDefinedAcross(group, DOUBAO_UNIT_FIELDS);
  return {
    used_percent: usedPercent ?? 0,
    reset_at: normalizeResetAt(firstDefinedAcross(group, DOUBAO_RESET_FIELDS)),
    ...(used !== null ? { used_credits: used } : {}),
    ...(total !== null ? { limit_credits: total } : {}),
    ...(remaining !== null ? { remaining_credits: remaining } : {}),
    unit: typeof unit === "string" && unit.trim() ? unit.trim() : null,
  };
}

function normalizeDoubaoWindowGroups(groups) {
  const windows = { primary_window: null, secondary_window: null, tertiary_window: null };
  if (!Array.isArray(groups)) return windows;
  for (const group of groups) {
    const slot = doubaoWindowSlot(group);
    if (!slot || windows[slot]) continue;
    const window = normalizeDoubaoWindowGroup(group);
    if (window) windows[slot] = window;
  }
  return windows;
}

function doubaoPlanLabelFromSummary(summaryData) {
  const display = summaryData?.current_subscription?.display;
  const name = firstDefinedIn(display, ["product_name", "productName"]);
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function normalizeDoubaoLimits({ summaryData, usageData }) {
  const fromUsage = normalizeDoubaoWindowGroups(usageData?.window_limit_groups);
  const fromSummary = normalizeDoubaoWindowGroups(summaryData?.window_limit_section);
  const windows = {};
  for (const slot of ["primary_window", "secondary_window", "tertiary_window"]) {
    windows[slot] = fromUsage[slot] || fromSummary[slot] || null;
  }
  const hasWindows = Object.values(windows).some(Boolean);
  return {
    // A plan label without any observable window reads as a subscription claim
    // TokenTracker cannot back up — keep it null (free accounts report a
    // product_name of "个人订阅" with no quota windows at all).
    plan_label: hasWindows ? doubaoPlanLabelFromSummary(summaryData) : null,
    ...windows,
  };
}

function doubaoRequestHeaders(cookieHeader) {
  return {
    Cookie: cookieHeader,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    "User-Agent": DOUBAO_USER_AGENT,
    Origin: DOUBAO_ORIGIN,
    Referer: DOUBAO_ORIGIN + "/chat/",
  };
}

function doubaoAuthExpiredError() {
  const error = new Error("Doubao login expired. Sign in to Doubao again.");
  error.code = "AUTH_EXPIRED";
  return error;
}

async function postDoubaoEndpoint(url, cookieHeader, fetchImpl) {
  const body = url === DOUBAO_QUOTA_SUMMARY_URL ? { product_line: "" } : {};
  const response = await fetchImpl(url, {
    method: "POST",
    headers: doubaoRequestHeaders(cookieHeader),
    body: JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) {
    throw doubaoAuthExpiredError();
  }
  if (!response.ok) {
    throw new Error(`Doubao quota API returned HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("Doubao quota response is not an object.");
  }
  const code = Number(payload.code);
  if (Number.isFinite(code) && code !== 0) {
    if (code === DOUBAO_AUTH_EXPIRED_CODE) throw doubaoAuthExpiredError();
    throw new Error(`Doubao quota request failed (code ${code}).`);
  }
  return payload.data && typeof payload.data === "object" ? payload.data : {};
}

function doubaoLimitsCachePath({ home = os.homedir() } = {}) {
  return path.join(home, ".tokentracker", "tracker", DOUBAO_LIMITS_CACHE_FILE);
}

// The disk cache outlives API calls, so it must never serve one account's
// windows to another. A truncated SHA-256 of the active cookie header travels
// with every write and gates every read — the cookie itself never touches the
// disk, and the hash of a high-entropy session id is not reversible.
function doubaoCookieFingerprint(cookieHeader) {
  return crypto
    .createHash("sha256")
    .update(`doubao-limits-cache:v1:${cookieHeader}`)
    .digest("hex")
    .slice(0, 16);
}

function doubaoCachedWindow(window, { cachedAtMs, nowMs } = {}) {
  if (!window || typeof window !== "object") return null;
  const resetAtMs = Date.parse(window.reset_at || "");
  if (Number.isFinite(resetAtMs)) return resetAtMs > nowMs ? window : null;
  return nowMs - cachedAtMs <= DOUBAO_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS ? window : null;
}

function readDoubaoLimitsCache({ home = os.homedir(), nowMs = Date.now(), fingerprint = null } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(doubaoLimitsCachePath({ home }), "utf8"))?.doubao;
    const cachedAtMs = Date.parse(raw?.cached_at || "");
    if (!Number.isFinite(cachedAtMs) || cachedAtMs > nowMs + 60_000) return null;
    // Callers that know the active session bind the fallback to it: entries
    // written for another account (or predating the fingerprint) never serve.
    if (fingerprint && raw?.cookie_fingerprint !== fingerprint) return null;
    const primaryWindow = doubaoCachedWindow(raw.primary_window, { cachedAtMs, nowMs });
    const secondaryWindow = doubaoCachedWindow(raw.secondary_window, { cachedAtMs, nowMs });
    const tertiaryWindow = doubaoCachedWindow(raw.tertiary_window, { cachedAtMs, nowMs });
    if (!primaryWindow && !secondaryWindow && !tertiaryWindow) return null;
    const hasUnexpiredDatedWindow = [primaryWindow, secondaryWindow, tertiaryWindow]
      .some((window) => Number.isFinite(Date.parse(window?.reset_at || "")));
    if (nowMs - cachedAtMs > DOUBAO_LIMITS_CACHE_MAX_AGE_MS && !hasUnexpiredDatedWindow) {
      return null;
    }
    return {
      configured: true,
      error: null,
      plan_label: typeof raw.plan_label === "string" ? raw.plan_label : null,
      primary_window: primaryWindow,
      secondary_window: secondaryWindow,
      ...(tertiaryWindow ? { tertiary_window: tertiaryWindow } : {}),
      cached: true,
      stale: true,
      cached_at: raw.cached_at,
      source: "disk-cache",
    };
  } catch (_error) {
    return null;
  }
}

// Only successful reads with at least one observable window are cached —
// cookie values never touch the disk, and a free account's empty windows must
// not be resurrected as data.
function writeDoubaoLimitsCache(limits, { home = os.homedir(), nowMs = Date.now(), fingerprint = null } = {}) {
  if (!limits?.configured || limits.error || (!limits.primary_window && !limits.secondary_window && !limits.tertiary_window)) return;
  const cachePath = doubaoLimitsCachePath({ home });
  const payload = {
    doubao: {
      plan_label: limits.plan_label || null,
      primary_window: limits.primary_window || null,
      secondary_window: limits.secondary_window || null,
      ...(limits.tertiary_window ? { tertiary_window: limits.tertiary_window } : {}),
      ...(fingerprint ? { cookie_fingerprint: fingerprint } : {}),
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

async function fetchDoubaoLimits({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  fetchImpl = fetch,
  securityRunner,
  sqliteReader,
  keychainReader,
  nowMs = Date.now(),
} = {}) {
  // Gate on Doubao's data directory before anything else (and before any
  // keychain prompt): without it Doubao has never run on this machine and the
  // panel section must stay hidden. A manual DOUBAO_COOKIE skips the gate —
  // it works without any local Doubao installation (see docs/doubao-limits.md).
  const hasManualCookie = typeof env?.DOUBAO_COOKIE === "string" && env.DOUBAO_COOKIE.trim() !== "";
  if (!hasManualCookie && !fs.existsSync(resolveDoubaoDataDir({ home, env, platform }))) {
    return { configured: false };
  }

  const session = await readDoubaoCookieSession({ home, env, platform, securityRunner, sqliteReader, keychainReader });
  if (!session.ok) {
    if (session.reason === "no-data-dir") return { configured: false };
    if (session.reason === "keychain-unavailable") {
      return {
        configured: true,
        error: "Allow access to the \"Doubao Safe Storage\" keychain item when macOS asks, then refresh Doubao's quota.",
      };
    }
    if (session.reason === "no-session") {
      return { configured: true, error: "Open Doubao and sign in to read its subscription quota." };
    }
    return {
      configured: true,
      error: "Could not decrypt Doubao's local cookies; open Doubao and make sure you are signed in.",
    };
  }

  const fingerprint = doubaoCookieFingerprint(session.cookieHeader);
  try {
    const summaryData = await postDoubaoEndpoint(DOUBAO_QUOTA_SUMMARY_URL, session.cookieHeader, fetchImpl);
    const usageData = await postDoubaoEndpoint(DOUBAO_USAGE_DETAIL_URL, session.cookieHeader, fetchImpl);
    const result = {
      configured: true,
      error: null,
      ...normalizeDoubaoLimits({ summaryData, usageData }),
      source: "provider-api",
      cookie_source: session.source,
    };
    writeDoubaoLimitsCache(result, { home, nowMs, fingerprint });
    return result;
  } catch (error) {
    if (error?.code === "AUTH_EXPIRED") {
      return { configured: true, error: error.message, auth_action_required: "reauth" };
    }
    const cached = readDoubaoLimitsCache({ home, nowMs, fingerprint });
    if (cached) return cached;
    return { configured: true, error: error?.message || "Doubao quota fetch failed." };
  }
}

// Cache fallback for callers that lost the aggregate provider timeout race:
// the still-running fetchDoubaoLimits can no longer hand over its own cache
// fallback, so re-derive the session here and only serve the cache it belongs
// to. Null when anything along the way fails — the caller keeps its error.
async function readDoubaoLimitsFallback({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  securityRunner,
  sqliteReader,
  keychainReader,
  nowMs = Date.now(),
} = {}) {
  try {
    const session = await readDoubaoCookieSession({ home, env, platform, securityRunner, sqliteReader, keychainReader });
    if (!session.ok) return null;
    return readDoubaoLimitsCache({ home, nowMs, fingerprint: doubaoCookieFingerprint(session.cookieHeader) });
  } catch (_error) {
    return null;
  }
}

module.exports = {
  DOUBAO_AUTH_EXPIRED_CODE,
  DOUBAO_LIMITS_CACHE_FILE,
  DOUBAO_ORIGIN,
  DOUBAO_QUOTA_SUMMARY_URL,
  DOUBAO_USAGE_DETAIL_URL,
  doubaoLimitsCachePath,
  doubaoRequestHeaders,
  normalizeDoubaoLimits,
  normalizeDoubaoWindowGroup,
  normalizeDoubaoWindowGroups,
  postDoubaoEndpoint,
  readDoubaoLimitsCache,
  readDoubaoLimitsFallback,
  writeDoubaoLimitsCache,
  fetchDoubaoLimits,
};
