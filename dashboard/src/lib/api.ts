import {
  getMockUsageDaily,
  getMockUsageHourly,
  getMockUsageHeatmap,
  getMockUsageMonthly,
  getMockUsageModelBreakdown,
  getMockUsageCategoryBreakdown,
  getMockUsageSummary,
  getMockProjectUsageSummary,
  getMockProjectUsageDetail,
  getMockLeaderboard,
  getMockAchievements,
  isMockEnabled,
} from "./mock-data";
import { getInsforgeRemoteUrl, getInsforgeAnonKey } from "./insforge-config";
import { isValidJwtShape } from "./auth-token";
import { getLocalApiAuthHeaders } from "./local-api-auth";
import { expandHeatmapCompact } from "./heatmap-compact";
import { functionUrlFor, fetchFunctionResponse } from "./function-url";

type AnyRecord = Record<string, any>;

// React auth/scope resolution can make multiple consumers ask for the exact
// same GET while the first request is still in flight. Coalesce only that
// overlap (no result TTL), so manual refreshes still fetch fresh data.
const inFlightJsonGets = new Map<string, Promise<any>>();
const accountResponseCache = new Map<string, { fetchedAt: number; value: any }>();
const ACCOUNT_SUMMARY_RESPONSE_TTL_MS = 120_000;
const ACCOUNT_RESPONSE_TTL_MS = 300_000;
const ACCOUNT_RESPONSE_STALE_IF_ERROR_MS = 5 * 60_000;
const sessionInsightsResponseCache = new Map<string, { fetchedAt: number; value: any }>();
const SESSION_INSIGHTS_RESPONSE_TTL_MS = 5 * 60_000;
const SESSION_INSIGHTS_RESPONSE_STALE_IF_ERROR_MS = 15 * 60_000;
const verifiedAccountTokens = new Set<string>();
let accountCacheGeneration = 0;

function accountIdentity(accessToken: string) {
  try {
    const payload = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) {
      const error: any = new Error("Account session expired");
      error.status = 401;
      throw error;
    }
    if (typeof payload.sub === "string" && payload.sub) return payload.sub;
  } catch (error) {
    if ((error as any)?.status === 401) {
      invalidateAccountResponseCache();
      throw error;
    }
  }
  // A legacy opaque token can still be sent to the server, but cannot share
  // another token's cache entry without an account identity.
  return accessToken;
}

function coalesceJsonGet(key: string, request: () => Promise<any>) {
  const existing = inFlightJsonGets.get(key);
  if (existing) return existing;

  const pending = request();
  inFlightJsonGets.set(key, pending);
  const cleanup = () => {
    if (inFlightJsonGets.get(key) === pending) inFlightJsonGets.delete(key);
  };
  pending.then(cleanup, cleanup);
  return pending;
}

function cachedAccountJsonGet(url: URL, accessToken: string, request: () => Promise<any>) {
  const params = new URLSearchParams(url.searchParams);
  params.sort();
  const key = `${url.origin}${url.pathname}?${params}\0${accountIdentity(accessToken)}`;
  const generation = accountCacheGeneration;
  const now = Date.now();
  const cached = accountResponseCache.get(key);
  const ttl = url.pathname.endsWith("tokentracker-account-summary")
    ? ACCOUNT_SUMMARY_RESPONSE_TTL_MS : ACCOUNT_RESPONSE_TTL_MS;
  const tokenKey = `${url.origin}\0${accessToken}`;
  const authenticated = verifiedAccountTokens.has(tokenKey);
  if (authenticated && cached && now - cached.fetchedAt < ttl) {
    return Promise.resolve(structuredClone(cached.value));
  }

  // An unseen JWT must reach the server before it can reuse data for its sub.
  return coalesceJsonGet(`${key}\0${generation}\0${authenticated ? "verified" : accessToken}`, async () => {
    try {
      const value = await request();
      if (generation !== accountCacheGeneration) return value;
      verifiedAccountTokens.add(tokenKey);
      if (verifiedAccountTokens.size > 128) verifiedAccountTokens.delete(verifiedAccountTokens.values().next().value!);
      accountResponseCache.set(key, { fetchedAt: Date.now(), value: structuredClone(value) });
      // A dashboard normally uses fewer than 20 keys. Keep a hard ceiling so
      // long-running desktop WebViews cannot retain old ranges indefinitely.
      if (accountResponseCache.size > 64) {
        const oldest = accountResponseCache.keys().next().value;
        if (oldest) accountResponseCache.delete(oldest);
      }
      return value;
    } catch (error) {
      const status = Number((error as any)?.status) || 0;
      if (status === 401 || status === 403) {
        invalidateAccountResponseCache();
        throw error;
      }
      const stale = accountResponseCache.get(key);
      if (
        authenticated && generation === accountCacheGeneration && stale &&
        Date.now() - stale.fetchedAt < ACCOUNT_RESPONSE_STALE_IF_ERROR_MS &&
        (status === 0 || status >= 500)
      ) {
        return structuredClone(stale.value);
      }
      throw error;
    }
  });
}

export function invalidateAccountResponseCache() {
  accountCacheGeneration += 1;
  accountResponseCache.clear();
  verifiedAccountTokens.clear();
}

export function invalidateSessionInsightsCache() {
  sessionInsightsResponseCache.clear();
}

const PATHS = {
  usageSummary: "tokentracker-usage-summary",
  usageDaily: "tokentracker-usage-daily",
  usageHourly: "tokentracker-usage-hourly",
  usageMonthly: "tokentracker-usage-monthly",
  usageHeatmap: "tokentracker-usage-heatmap",
  usageModelBreakdown: "tokentracker-usage-model-breakdown",
  usageCategoryBreakdown: "tokentracker-usage-category-breakdown",
  projectUsageSummary: "tokentracker-project-usage-summary",
  projectUsageDetail: "tokentracker-project-usage-detail",
  achievements: "tokentracker-achievements",
  userStatus: "tokentracker-user-status",
  localSync: "tokentracker-local-sync",
  usageLimits: "tokentracker-usage-limits",
  outcomes: "tokentracker-outcomes",
  sessionInsights: "tokentracker-session-insights",
  contextHealth: "tokentracker-context-health",
};

/**
 * usage-* (local CLI) → account-* (cloud) slug map. The cloud `account-*`
 * edge functions mirror the local `tokentracker-usage-*` response schema
 * exactly (see their source: "Mirrors local-api.js ... response schema"),
 * so the dashboard components render identically off either source.
 */
const USAGE_TO_ACCOUNT_SLUG: Record<string, string> = {
  "tokentracker-usage-summary": "tokentracker-account-summary",
  "tokentracker-usage-daily": "tokentracker-account-daily",
  "tokentracker-usage-hourly": "tokentracker-account-hourly",
  "tokentracker-usage-monthly": "tokentracker-account-monthly",
  "tokentracker-usage-heatmap": "tokentracker-account-heatmap",
  "tokentracker-usage-model-breakdown": "tokentracker-account-model-breakdown",
};

export function isLocalhostHost() {
  return (
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  );
}

async function fetchLocalJson(slug: string, params?: AnyRecord, options?: AnyRecord) {
  const accessToken = options?.accessToken as string | undefined;
  const accountSlug = USAGE_TO_ACCOUNT_SLUG[slug];

  // Deployed web (e.g. tokentracker.cc): there's no local CLI behind
  // window.location.origin, so usage-* calls would 404. When the visitor is
  // signed in and the slug has a cloud account-* mirror, route to the cloud
  // aggregator (cross-device usage by user_id) with the auth token. Local CLI
  // (localhost) keeps the original same-origin usage-* path.
  if (!isLocalhostHost() && accessToken && accountSlug) {
    const base = getInsforgeRemoteUrl().replace(/\/$/, "");
    const url = new URL(functionUrlFor(base, accountSlug));
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== "") url.searchParams.set(key, String(value));
      }
    }
    if (accountSlug === "tokentracker-account-heatmap") url.searchParams.set("format", "compact");
    const headers: Record<string, string> = { Accept: "application/json" };
    const anonKey = getInsforgeAnonKey();
    if (anonKey) headers.apikey = anonKey;
    if (isValidJwtShape(accessToken)) headers.Authorization = `Bearer ${accessToken}`;
    return cachedAccountJsonGet(url, accessToken, async () => {
      const response = await fetchFunctionResponse(url.toString(), { headers, cache: "no-store" });
      if (!response.ok) {
        const err: any = new Error(`Request failed with HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      const data = await response.json();
      return accountSlug === "tokentracker-account-heatmap" ? expandHeatmapCompact(data) : data;
    });
  }

  if (!isLocalhostHost()) {
    const error: any = new Error("Local API is unavailable on this host");
    error.status = 404;
    error.code = "LOCAL_API_UNAVAILABLE";
    throw error;
  }
  const url = new URL(`/functions/${slug}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const { accessToken: _omit, ...fetchOptions } = options || {};
  return coalesceJsonGet(url.toString(), async () => {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      ...fetchOptions,
    });
    if (!response.ok) {
      const err: any = new Error(`Request failed with HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  });
}

function buildTimeZoneParams({ timeZone, tzOffsetMinutes }: AnyRecord = {}) {
  const params: AnyRecord = {};
  const tz = typeof timeZone === "string" ? timeZone.trim() : "";
  if (tz) params.tz = tz;
  if (Number.isFinite(tzOffsetMinutes)) {
    params.tz_offset_minutes = String(Math.trunc(tzOffsetMinutes));
  }
  return params;
}

function buildFilterParams({ source, model, device }: AnyRecord = {}) {
  const params: AnyRecord = {};
  const normalizedSource = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (normalizedSource) params.source = normalizedSource;
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel) params.model = normalizedModel;
  const normalizedDevice = typeof device === "string" ? device.trim() : "";
  if (normalizedDevice) params.device_id = normalizedDevice;
  return params;
}

export async function getUsageSummary({
  from,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  rolling = false,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageSummary({ from, to, seed: accessToken, rolling });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  const rollingParams = rolling ? { rolling: "1" } : {};
  return fetchLocalJson(PATHS.usageSummary, { from, to, ...filterParams, ...tzParams, ...rollingParams }, { accessToken });
}

export async function getProjectUsageSummary({
  from,
  to,
  source,
  limit,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockProjectUsageSummary({ seed: accessToken, limit });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source });
  const params: AnyRecord = { ...filterParams, ...tzParams };
  if (from) params.from = from;
  if (to) params.to = to;
  if (limit != null) params.limit = String(limit);
  return fetchLocalJson(PATHS.projectUsageSummary, params);
}

export async function getProjectUsageDetail({
  projectKey,
  from,
  to,
  timeZone,
  tzOffsetMinutes,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockProjectUsageDetail({ projectKey, from, to });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const params: AnyRecord = { project_key: projectKey, ...tzParams };
  if (from) params.from = from;
  if (to) params.to = to;
  return fetchLocalJson(PATHS.projectUsageDetail, params);
}

/**
 * Local (privacy-scoped) achievements: project_hopper / project_devotion /
 * night_owl, computed by the local CLI from queue data that never leaves the
 * machine. Cloud badges use the badges-only leaderboard profile fast path.
 */
export async function getLocalAchievements({ timeZone, tzOffsetMinutes }: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockAchievements();
  }
  return fetchLocalJson(PATHS.achievements, buildTimeZoneParams({ timeZone, tzOffsetMinutes }));
}

async function fetchInsforgeFunction(slug: string, options: {
  method?: string;
  accessToken?: string;
  params?: AnyRecord;
  body?: unknown;
  cache?: RequestCache;
} = {}) {
  const baseUrl = getInsforgeRemoteUrl();
  if (!baseUrl) throw new Error("InsForge base URL not configured");
  const root = baseUrl.replace(/\/$/, "");
  const url = new URL(functionUrlFor(root, slug));
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const anonKey = getInsforgeAnonKey();
  if (anonKey) headers.apikey = anonKey;
  // Only attach Authorization if the token is a well-formed JWT. InsForge's
  // platform gateway validates the JWT before user code runs and returns
  // HTTP 500 (JWSError) for any malformed value — which would break
  // public endpoints like leaderboard for users whose stored token got
  // corrupted or truncated.
  if (options.accessToken && isValidJwtShape(options.accessToken)) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  const res = await fetchFunctionResponse(url.toString(), {
    method: options.method || "GET",
    headers,
    cache: options.cache,
    ...(options.body != null ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const err: any = new Error(`Request failed with HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function getLeaderboard({
  accessToken,
  userId,
  period,
  metric,
  limit,
  offset,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockLeaderboard({ seed: accessToken || userId, period, metric, limit, offset });
  }
  // Deliberately NOT passing accessToken. Leaderboard is a public read and
  // InsForge's gateway returns opaque 500 (JWSError) for any JWT issue
  // (bad signature, expired, rotated secret). Passing user_id as a query
  // param lets the server compute `is_me` without ever touching the
  // Authorization header.
  return fetchInsforgeFunction("tokentracker-leaderboard", {
    cache: "no-store",
    params: { period, limit, offset, user_id: userId },
  });
}

/**
 * Public, unauthenticated snapshot of privacy-safe community aggregates.
 * Includes models, providers, 30-day growth, token mix, usage bands, and
 * anonymous platform adoption without exposing user-level rows.
 */
export async function getCommunityModels() {
  if (isMockEnabled()) return { top_models: [] };
  return fetchInsforgeFunction("tokentracker-community-models", {});
}

export async function getPublicVisibility({ accessToken }: AnyRecord = {}) {
  return fetchInsforgeFunction("tokentracker-public-visibility", {
    accessToken,
    method: "GET",
  });
}

export async function setPublicVisibility({
  accessToken,
  enabled,
  anonymous,
  display_name,
  github_url,
  show_github_url,
}: AnyRecord = {}) {
  const body: AnyRecord = {};
  if (enabled !== undefined) body.enabled = Boolean(enabled);
  if (anonymous !== undefined) body.anonymous = Boolean(anonymous);
  if (display_name !== undefined) body.display_name = String(display_name);
  // null is a valid value (clears the URL), so check for presence via `in`-style
  if (github_url !== undefined) body.github_url = github_url === null ? null : String(github_url);
  if (show_github_url !== undefined) body.show_github_url = Boolean(show_github_url);
  return fetchInsforgeFunction("tokentracker-public-visibility", {
    accessToken,
    method: "POST",
    body,
  });
}

export async function refreshLeaderboard({ accessToken, period, source }: AnyRecord = {}) {
  const body: AnyRecord = {};
  if (period) body.period = period;
  if (typeof source === "string" && source.trim()) body.source = source.trim();
  return fetchInsforgeFunction("tokentracker-leaderboard-refresh", {
    accessToken,
    method: "POST",
    body,
  });
}

/**
 * Detailed per-user profile used by the leaderboard modal.
 * Returns hero totals, streak, best day, model highlight, per-provider
 * breakdown, 365-day heatmap and a period-scoped daily trend.
 * See dashboard/edge-patches/tokentracker-leaderboard-profile.ts for the
 * canonical response shape.
 */
export async function getLeaderboardProfile({
  accessToken,
  userId,
  period,
  timeZone,
  tzOffsetMinutes,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    // Minimal stub for dashboard:dev (no live edge). Frontend layout should
    // render without throwing; numbers don't need to be plausible.
    const mock = getMockLeaderboard({ seed: accessToken, period, metric: "all", limit: 250, offset: 0 });
    const entries = Array.isArray(mock?.entries) ? mock.entries : [];
    const match: any = entries.find((entry: any) => entry?.user_id === userId) || entries[0] || null;
    const tokens = Number(match?.total_tokens) || 0;
    const today = new Date();
    const heatmap = Array.from({ length: 365 }).map((_, i) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - (364 - i));
      return { date: d.toISOString().slice(0, 10), total_tokens: i % 7 === 0 ? Math.floor(tokens / 365) : 0 };
    });
    const dailyTrend = heatmap.slice(-7);
    return {
      user: {
        user_id: userId,
        display_name: match?.display_name || "Mock User",
        avatar_url: match?.avatar_url || null,
        github_url: match?.github_url || null,
        is_anonymous: false,
        rank: match?.rank ?? null,
      },
      period: {
        kind: period || "week",
        from: mock?.from ?? null,
        to: mock?.to ?? null,
        generated_at: mock?.generated_at ?? new Date().toISOString(),
      },
      totals: {
        total_tokens: tokens,
        estimated_cost_usd: Number(match?.estimated_cost_usd) || 0,
        active_days: 53,
        avg_per_day_usd: 0,
      },
      streak: { current_days: 3, longest_days: 12 },
      best_day: tokens
        ? { date: today.toISOString().slice(0, 10), total_tokens: Math.floor(tokens / 30), estimated_cost_usd: 0 }
        : null,
      models: { count: 5, favorite: { model_name: "claude-opus-4-7", total_tokens: Math.floor(tokens / 2) } },
      by_provider: [],
      heatmap,
      daily_trend: dailyTrend,
      badges: getMockAchievements().achievements.filter(
        (badge: any) => badge.tier >= 1 && !["project_hopper", "project_devotion", "night_owl"].includes(badge.id),
      ),
      badges_include_unearned: false,
    };
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  return fetchInsforgeFunction("tokentracker-leaderboard-profile", {
    accessToken,
    params: { user_id: userId, period, ...tzParams },
  });
}

/**
 * Cloud achievements for the signed-in user.
 *
 * The full leaderboard profile response scans and aggregates up to 365 days
 * of hourly usage for its heatmap and trend. The achievements page needs only
 * the precomputed badge rows, so keep it on the authenticated edge fast path.
 */
export async function getUserBadges({ accessToken, userId }: AnyRecord = {}) {
  if (isMockEnabled()) {
    return {
      badges: getMockAchievements().achievements.filter(
        (badge: any) => !["project_hopper", "project_devotion", "night_owl"].includes(badge.id),
      ),
      badges_include_unearned: true,
    };
  }
  return fetchInsforgeFunction("tokentracker-leaderboard-profile", {
    accessToken,
    method: "GET",
    params: { user_id: userId, view: "badges" },
  });
}

function mockLikeCount(userId: string | undefined | null) {
  if (!userId) return 0;
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 165) + 24;
}

export async function getProfileLikes({ userId, anonId, accessToken }: AnyRecord = {}) {
  if (isMockEnabled()) {
    return { count: mockLikeCount(userId), liked: false };
  }
  // `liked` is per-caller: pass anon_id (anonymous) and/or a JWT (signed-in).
  // fetchInsforgeFunction only attaches Authorization when isValidJwtShape passes,
  // so a missing/malformed token degrades to an anonymous read. (isValidJwtShape
  // checks shape, not expiry — a well-formed but expired token could still draw a
  // gateway error; that rare case is caught by the LikeButton fetch catch, which
  // falls back to count=0/liked=false rather than breaking the page.)
  return fetchInsforgeFunction("tokentracker-profile-likes", {
    accessToken,
    params: { target_user_id: userId, anon_id: anonId },
  });
}

export async function setProfileLike({ userId, action, anonId, accessToken }: AnyRecord = {}) {
  if (isMockEnabled()) {
    const liked = action === "like";
    return { count: Math.max(0, mockLikeCount(userId) + (liked ? 1 : 0)), liked };
  }
  return fetchInsforgeFunction("tokentracker-profile-likes", {
    accessToken,
    method: "POST",
    body: { target_user_id: userId, action, anon_id: anonId },
  });
}

export async function getUserStatus(_opts: AnyRecord = {}) {
  if (isMockEnabled()) {
    const now = new Date().toISOString();
    return {
      user_id: "local-user",
      created_at: now,
      pro: { active: false, sources: [], expires_at: null, partial: false, as_of: now },
      subscriptions: { partial: false, as_of: now, items: [] },
      install: {
        partial: false,
        as_of: now,
        has_active_device_token: false,
        has_active_device: false,
        active_device_tokens: 0,
        active_devices: 0,
        latest_token_activity_at: null,
        latest_device_seen_at: null,
      },
    };
  }
  return fetchLocalJson(PATHS.userStatus);
}

export async function triggerLocalSync({
  signal,
  auto = false,
  background = false,
  allLocalSources = false,
  drain = false,
}: AnyRecord = {}) {
  const authHeaders = await getLocalApiAuthHeaders();
  const body: AnyRecord = {};
  if (drain) {
    body.drain = true;
  } else if (auto) {
    body.auto = true;
    if (background) {
      body.background = true;
      if (allLocalSources) body.allLocalSources = true;
    }
  }
  const response = await fetch(`/functions/${PATHS.localSync}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: `Local sync request failed with HTTP ${response.status}`,
  }));
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error || payload?.message || `Local sync request failed with HTTP ${response.status}`;
    const error: any = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function getUsageModelBreakdown({
  from,
  to,
  source,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageModelBreakdown({ from, to, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, device });
  return fetchLocalJson(PATHS.usageModelBreakdown, { from, to, ...filterParams, ...tzParams }, { accessToken });
}

// Opt-in quality-per-dollar / Effective-Tokens lens. Reads the optional
// outcomes.jsonl sidecar via the local server and joins it to the token/$
// rows at read time. Returns { available:false, … } when the user hasn't
// opted in, so callers render nothing new. See GitHub issue 229.
export async function getOutcomes({
  from,
  to,
  source,
  device,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return { available: false, by_model: [], by_tool: [], totals: null };
  }
  const filterParams = buildFilterParams({ source, device });
  return fetchLocalJson(PATHS.outcomes, { from, to, ...filterParams }, { accessToken });
}

export async function getSessionInsights({ from, to, refresh = false }: AnyRecord = {}) {
  if (isMockEnabled()) return { available: false, sessions: [], by_model: [], subagents: [] };
  const cacheKey = `${from || ""}\0${to || ""}`;
  const cached = sessionInsightsResponseCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.fetchedAt < SESSION_INSIGHTS_RESPONSE_TTL_MS) {
    return cached.value;
  }

  return coalesceJsonGet(`session-insights:${cacheKey}:${refresh ? "refresh" : "normal"}`, async () => {
    try {
      const value = await fetchLocalJson(PATHS.sessionInsights, { from, to, refresh: refresh ? "1" : "" });
      sessionInsightsResponseCache.set(cacheKey, { fetchedAt: Date.now(), value });
      if (sessionInsightsResponseCache.size > 32) {
        const oldest = sessionInsightsResponseCache.keys().next().value;
        if (oldest) sessionInsightsResponseCache.delete(oldest);
      }
      return value;
    } catch (error) {
      const stale = sessionInsightsResponseCache.get(cacheKey);
      if (
        stale &&
        Date.now() - stale.fetchedAt < SESSION_INSIGHTS_RESPONSE_STALE_IF_ERROR_MS &&
        !refresh
      ) {
        return stale.value;
      }
      throw error;
    }
  });
}

export async function getContextHealth() {
  if (isMockEnabled()) return { estimated_fixed_tokens: 0, severity: "low", breakdown: {}, largest_items: [] };
  return fetchLocalJson(PATHS.contextHealth);
}

export async function getUsageCategoryBreakdown({
  from,
  to,
  source = "claude",
  timeZone,
  tzOffsetMinutes,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageCategoryBreakdown({ from, to, source });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  return fetchLocalJson(PATHS.usageCategoryBreakdown, { from, to, source, ...tzParams });
}

export async function getUsageDaily({
  from,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageDaily({ from, to, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchLocalJson(PATHS.usageDaily, { from, to, ...filterParams, ...tzParams }, { accessToken });
}

export async function getUsageHourly({
  day,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageHourly({ day, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  const params = day ? { day, ...filterParams, ...tzParams } : { ...filterParams, ...tzParams };
  return fetchLocalJson(PATHS.usageHourly, params, { accessToken });
}

export async function getUsageMonthly({
  months,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageMonthly({ months, to, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchLocalJson(PATHS.usageMonthly, {
    ...(months ? { months: String(months) } : {}),
    ...(to ? { to } : {}),
    ...filterParams,
    ...tzParams,
  }, { accessToken });
}

export async function getUsageLimits(opts: { refresh?: boolean; devinEnabled?: boolean } = {}) {
  const params: AnyRecord = opts?.refresh ? { refresh: "1" } : {};
  const options: AnyRecord = {};
  // Devin quota is opt-in: devin=1 is honored by the local API only together
  // with the loopback auth header, so the flag alone can never trigger a
  // credential read. Away from the local backend (e.g. the hosted site) there
  // is nothing to opt in to, so the flag is not sent at all.
  if (opts?.devinEnabled === true && isLocalhostHost()) {
    params.devin = "1";
    options.headers = {
      Accept: "application/json",
      ...(await getLocalApiAuthHeaders()),
    };
  }
  return fetchLocalJson(PATHS.usageLimits, params, options);
}

export async function getUsageHeatmap({
  weeks,
  to,
  weekStartsOn,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  if (isMockEnabled()) {
    return getMockUsageHeatmap({ weeks, to, weekStartsOn, seed: accessToken });
  }
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchLocalJson(PATHS.usageHeatmap, {
    weeks: String(weeks),
    to,
    week_starts_on: weekStartsOn,
    ...filterParams,
    ...tzParams,
  }, { accessToken });
}

// ---------------------------------------------------------------------------
// Cloud (account-wide) fetchers. Hit InsForge directly at
// `${INSFORGE_BASE_URL}/functions/tokentracker-account-*` with the user's
// JWT in the Authorization header. The edge functions verify HS256 against
// JWT_SECRET, then aggregate across the user's active devices (dedup by
// (hour, source, model), drop revoked-device historical rows).
//
// Use the same response schema as the corresponding local /functions/* so
// hooks can swap fetchers based on `accountView` with no other transform.
// ---------------------------------------------------------------------------

const ACCOUNT_PATHS = {
  summary: "tokentracker-account-summary",
  daily: "tokentracker-account-daily",
  hourly: "tokentracker-account-hourly",
  monthly: "tokentracker-account-monthly",
  heatmap: "tokentracker-account-heatmap",
  modelBreakdown: "tokentracker-account-model-breakdown",
  devices: "tokentracker-account-devices",
} as const;

async function fetchAccountFunction(
  slug: string,
  params: AnyRecord | undefined,
  accessToken: string,
) {
  if (!accessToken || !isValidJwtShape(accessToken)) {
    const err: any = new Error("Account view requires a signed-in user");
    err.status = 401;
    throw err;
  }
  const baseUrl = getInsforgeRemoteUrl();
  if (!baseUrl) {
    const err: any = new Error("InsForge base URL not configured");
    err.status = 0;
    throw err;
  }
  const root = baseUrl.replace(/\/$/, "");
  const url = new URL(functionUrlFor(root, slug));
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  if (slug === ACCOUNT_PATHS.heatmap) url.searchParams.set("format", "compact");
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  const anonKey = getInsforgeAnonKey();
  if (anonKey) headers.apikey = anonKey;
  return cachedAccountJsonGet(url, accessToken, async () => {
    const response = await fetchFunctionResponse(url.toString(), {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!response.ok) {
      const err: any = new Error(`Request failed with HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    return slug === ACCOUNT_PATHS.heatmap ? expandHeatmapCompact(data) : data;
  });
}

export async function fetchCloudUsageSummary({
  from,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  rolling = false,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  const rollingParams = rolling ? { rolling: "1" } : {};
  return fetchAccountFunction(
    ACCOUNT_PATHS.summary,
    { from, to, ...filterParams, ...tzParams, ...rollingParams },
    accessToken,
  );
}

export async function fetchCloudUsageDaily({
  from,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchAccountFunction(
    ACCOUNT_PATHS.daily,
    { from, to, ...filterParams, ...tzParams },
    accessToken,
  );
}

export async function fetchCloudUsageHourly({
  day,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  const params = day ? { day, ...filterParams, ...tzParams } : { ...filterParams, ...tzParams };
  return fetchAccountFunction(ACCOUNT_PATHS.hourly, params, accessToken);
}

export async function fetchCloudUsageMonthly({
  months,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchAccountFunction(
    ACCOUNT_PATHS.monthly,
    {
      ...(months ? { months: String(months) } : {}),
      ...(to ? { to } : {}),
      ...filterParams,
      ...tzParams,
    },
    accessToken,
  );
}

export async function fetchCloudUsageHeatmap({
  weeks,
  to,
  weekStartsOn,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchAccountFunction(
    ACCOUNT_PATHS.heatmap,
    {
      weeks: String(weeks),
      to,
      week_starts_on: weekStartsOn,
      ...filterParams,
      ...tzParams,
    },
    accessToken,
  );
}

export async function fetchCloudUsageModelBreakdown({
  from,
  to,
  source,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, device });
  return fetchAccountFunction(
    ACCOUNT_PATHS.modelBreakdown,
    { from, to, ...filterParams, ...tzParams },
    accessToken,
  );
}

export async function fetchAccountDevices({
  from,
  to,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  return fetchAccountFunction(ACCOUNT_PATHS.devices, { from, to, ...tzParams }, accessToken);
}

// Rename one of the signed-in account's own devices. The edge function verifies
// the JWT and scopes the UPDATE to (id, user_id), so a user can only rename a
// device they own; a name colliding with another active device → HTTP 409.
export async function renameAccountDevice({ deviceId, name, accessToken }: AnyRecord = {}) {
  // Guard up front so a signed-out caller gets a clear 401 rather than the
  // gateway's opaque error; the POST itself reuses the shared edge helper
  // (base URL, headers, anon key, JWT attach, HTTP error mapping).
  if (!accessToken || !isValidJwtShape(accessToken)) {
    const err: any = new Error("Account view requires a signed-in user");
    err.status = 401;
    throw err;
  }
  const result = await fetchInsforgeFunction("tokentracker-device-rename", {
    accessToken,
    method: "POST",
    body: { device_id: deviceId, device_name: name },
  });
  // Account GETs are cached briefly to collapse dashboard fan-out. A rename
  // changes the device list immediately, so the caller's follow-up refresh
  // must not be satisfied by the pre-mutation snapshot.
  invalidateAccountResponseCache();
  return result;
}
