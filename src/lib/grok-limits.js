const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_BILLING_BASE_URL = "https://cli-chat-proxy.grok.com";
const DEFAULT_BILLING_TIMEOUT_MS = 15_000;
const DEFAULT_OIDC_ISSUER = "https://auth.x.ai";
const DEFAULT_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
// Refresh slightly before wall-clock expiry so Limits doesn't race a just-expired JWT.
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

function grokAuthError() {
  const error = new Error("Not logged in to Grok Build. Run `grok login` in Terminal to authenticate.");
  error.code = "GROK_AUTH_REQUIRED";
  return error;
}

function grokReauthError() {
  const error = new Error(
    "Grok session expired. Run `grok login` in Terminal to re-authenticate.",
  );
  error.code = "GROK_REAUTH_REQUIRED";
  return error;
}

function grokBillingTimeoutError() {
  const error = new Error("Grok billing request timed out.");
  error.code = "GROK_BILLING_TIMEOUT";
  return error;
}

async function runBeforeBillingDeadline(operation, deadlineMs) {
  const remainingMs = Math.ceil(deadlineMs - Date.now());
  if (remainingMs <= 0) throw grokBillingTimeoutError();

  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = grokBillingTimeoutError();
      controller.abort(error);
      reject(error);
    }, remainingMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGrokBillingAttempt(fetchImpl, url, headers, deadlineMs) {
  return runBeforeBillingDeadline(async (signal) => {
    const response = await fetchImpl(url, { method: "GET", headers, signal });
    if (!response.ok) {
      try {
        await response.body?.cancel?.();
      } catch (_error) {
        // The status remains authoritative even if discarding the body fails.
      }
      if (response.status === 401 || response.status === 403) throw grokAuthError();
      return { ok: false, status: response.status };
    }
    return { ok: true, body: await response.json() };
  }, deadlineMs);
}

function resolveGrokHome({ home, env = process.env } = {}) {
  if (typeof env.TOKENTRACKER_GROK_HOME === "string" && env.TOKENTRACKER_GROK_HOME.trim()) {
    return path.resolve(env.TOKENTRACKER_GROK_HOME.trim());
  }
  if (typeof env.GROK_HOME === "string" && env.GROK_HOME.trim()) {
    return path.resolve(env.GROK_HOME.trim());
  }
  return path.join(home || os.homedir(), ".grok");
}

function resolveGrokBillingBaseUrl(env = process.env) {
  const explicit =
    typeof env.GROK_CLI_CHAT_PROXY_BASE_URL === "string"
      ? env.GROK_CLI_CHAT_PROXY_BASE_URL.trim()
      : typeof env.TOKENTRACKER_GROK_BILLING_BASE_URL === "string"
        ? env.TOKENTRACKER_GROK_BILLING_BASE_URL.trim()
        : "";
  if (explicit) return explicit.replace(/\/$/, "");
  return DEFAULT_BILLING_BASE_URL;
}

function grokValNumber(value) {
  if (value == null) return null;
  if (typeof value === "object" && "val" in value) {
    return grokValNumber(value.val);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function grokIsoReset(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ts = Date.parse(value.trim());
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
}

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function buildWindow({ usedPercent, resetAt }) {
  const pct = clampPercent(usedPercent);
  if (pct === null) return null;
  return {
    used_percent: pct,
    reset_at: typeof resetAt === "string" && resetAt ? resetAt : null,
  };
}

/**
 * Map Grok's USAGE_PERIOD_TYPE_* enum (or a bare "weekly"/"monthly" string)
 * into a short period key the UI can switch labels on.
 *
 * Only daily / weekly / monthly are recognized end-to-end (dashboard + macOS).
 * Hourly (and other unknown) types return null so UIs fall back to the generic
 * Month label rather than inventing an unsupported period key.
 */
function normalizeGrokPeriodType(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const upper = value.trim().toUpperCase();
  if (upper.includes("WEEK")) return "weekly";
  if (upper.includes("MONTH")) return "monthly";
  // Prefer explicit DAILY / DAY over accidental "HOUR_OF_DAY" style matches.
  if (upper.includes("DAILY") || /(^|_)DAY($|_)/.test(upper) || upper === "DAY") return "daily";
  return null;
}

/**
 * Infer daily / weekly / monthly from period length when the API omits
 * `currentPeriod.type` (legacy payloads only expose start/end dates).
 *
 * Windows used by Grok today: ~1d, ~7d, ~calendar month. Boundaries leave
 * gaps for odd lengths (e.g. 12d, 2h) so we do not mislabel them.
 */
function inferGrokPeriodTypeFromDates(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const days = (endMs - startMs) / 86_400_000;
  if (days > 0.5 && days <= 1.5) return "daily";
  if (days > 1.5 && days <= 8) return "weekly";
  if (days >= 25 && days <= 35) return "monthly";
  return null;
}

/**
 * Sum per-product attribution percentages into the shared pool total.
 * productUsage breaks down the same cap (GrokBuild + GrokChat + …), not
 * independent quotas — a single product entry undercounts the pool.
 */
function sumProductUsagePercent(productUsage) {
  if (!Array.isArray(productUsage)) return null;
  let sum = 0;
  let sawAny = false;
  for (const entry of productUsage) {
    if (!entry || typeof entry !== "object") continue;
    const pct = clampPercent(entry.usagePercent);
    if (pct === null) continue;
    sawAny = true;
    sum += pct;
  }
  return sawAny ? clampPercent(sum) : null;
}

function isGrokInstalled({ home, env } = {}) {
  const grokHome = resolveGrokHome({ home, env });
  const authPath = path.join(grokHome, "auth.json");
  if (fs.existsSync(authPath)) return true;
  return fs.existsSync(path.join(grokHome, "sessions"));
}

function loadGrokAuthEntry({ home, env } = {}) {
  const authPath = path.join(resolveGrokHome({ home, env }), "auth.json");
  if (!fs.existsSync(authPath)) return null;
  let fallback = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const [scopeKey, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const key = typeof value.key === "string" ? value.key.trim() : "";
      const refreshToken =
        typeof value.refresh_token === "string" ? value.refresh_token.trim() : "";
      // Entries with an access token win outright. A refresh-token-only entry
      // is only usable when a client id is resolvable, and must not shadow a
      // later keyed entry — keep it as a fallback instead.
      if (key) {
        return { entry: value, authPath, scopeKey, authFile: parsed };
      }
      if (refreshToken && !fallback && resolveGrokOidcClientId(value, scopeKey)) {
        fallback = { entry: value, authPath, scopeKey, authFile: parsed };
      }
    }
  } catch (_error) {
    return null;
  }
  return fallback;
}

function readGrokAccessToken({ home, env } = {}) {
  const loaded = loadGrokAuthEntry({ home, env });
  const key = typeof loaded?.entry?.key === "string" ? loaded.entry.key.trim() : "";
  return key || null;
}

function isGrokAccessTokenExpired(expiresAt, nowMs = Date.now(), skewMs = ACCESS_TOKEN_EXPIRY_SKEW_MS) {
  if (expiresAt == null || expiresAt === "") return false;
  const ts = typeof expiresAt === "number" ? expiresAt : Date.parse(String(expiresAt));
  if (!Number.isFinite(ts)) return false;
  const skew = Number.isFinite(skewMs) && skewMs >= 0 ? skewMs : ACCESS_TOKEN_EXPIRY_SKEW_MS;
  return ts <= nowMs + skew;
}

function resolveGrokOidcClientId(entry, scopeKey) {
  if (entry && typeof entry.oidc_client_id === "string" && entry.oidc_client_id.trim()) {
    return entry.oidc_client_id.trim();
  }
  if (typeof scopeKey === "string" && scopeKey.includes("::")) {
    const suffix = scopeKey.slice(scopeKey.lastIndexOf("::") + 2).trim();
    if (suffix) return suffix;
  }
  return null;
}

function resolveGrokOidcIssuer(entry) {
  if (entry && typeof entry.oidc_issuer === "string" && entry.oidc_issuer.trim()) {
    return entry.oidc_issuer.trim().replace(/\/$/, "");
  }
  return DEFAULT_OIDC_ISSUER;
}

function resolveGrokTokenEndpoint(entry, env = process.env) {
  if (typeof env.TOKENTRACKER_GROK_TOKEN_ENDPOINT === "string" && env.TOKENTRACKER_GROK_TOKEN_ENDPOINT.trim()) {
    return env.TOKENTRACKER_GROK_TOKEN_ENDPOINT.trim();
  }
  if (typeof env.GROK_OIDC_TOKEN_ENDPOINT === "string" && env.GROK_OIDC_TOKEN_ENDPOINT.trim()) {
    return env.GROK_OIDC_TOKEN_ENDPOINT.trim();
  }
  const issuer = resolveGrokOidcIssuer(entry);
  if (issuer === DEFAULT_OIDC_ISSUER) return DEFAULT_TOKEN_ENDPOINT;
  return `${issuer}/oauth2/token`;
}

function grokEntryRefreshToken(entry) {
  return entry && typeof entry.refresh_token === "string" ? entry.refresh_token.trim() : "";
}

function grokEntryAccessToken(entry) {
  return entry && typeof entry.key === "string" ? entry.key.trim() : "";
}

/**
 * Public xAI OIDC client refresh (auth method "none").
 * Matches Grok Build CLI's refresh against https://auth.x.ai/oauth2/token.
 */
async function refreshGrokTokens({
  refreshToken,
  clientId,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_BILLING_TIMEOUT_MS,
} = {}) {
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    const err = new Error("Grok refresh skipped: no refresh_token in auth.json");
    err.code = "NO_REFRESH_TOKEN";
    throw err;
  }
  if (typeof clientId !== "string" || !clientId.trim()) {
    const err = new Error("Grok refresh skipped: missing oidc_client_id");
    err.code = "NO_CLIENT_ID";
    throw err;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken.trim(),
    client_id: clientId.trim(),
  });

  // Same abort deadline discipline as fetchGrokBilling — a stalled token
  // endpoint must not block fetchGrokLimits (and its poller) indefinitely.
  // The timer stays armed through the body reads below, not just the headers.
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_BILLING_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutError = new Error("Grok token refresh timed out.");
  timeoutError.code = "GROK_REFRESH_TIMEOUT";
  const timer = setTimeout(() => controller.abort(timeoutError), normalizedTimeoutMs);

  try {
    const res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (res.status === 400 || res.status === 401) {
      let oauthError = null;
      try {
        const payload = await res.json();
        oauthError =
          (typeof payload?.error === "string" && payload.error) ||
          (payload?.error && typeof payload.error === "object" && payload.error.code) ||
          null;
      } catch (_error) {
        // Status remains authoritative.
      }
      const err = grokReauthError();
      err.oauthError = oauthError;
      err.status = res.status;
      throw err;
    }

    if (!res.ok) {
      const err = new Error(`Grok token refresh failed: HTTP ${res.status}`);
      err.code = "REFRESH_HTTP_ERROR";
      err.status = res.status;
      throw err;
    }

    const payload = await res.json();
    const accessToken =
      typeof payload?.access_token === "string" ? payload.access_token.trim() : "";
    if (!accessToken) {
      const err = new Error("Grok token refresh response missing access_token");
      err.code = "REFRESH_INVALID_RESPONSE";
      throw err;
    }

    const nextRefresh =
      typeof payload?.refresh_token === "string" && payload.refresh_token.trim()
        ? payload.refresh_token.trim()
        : refreshToken.trim();

    let expiresAt = null;
    const expiresIn = Number(payload?.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    } else if (typeof payload?.expires_at === "string" && payload.expires_at.trim()) {
      const parsed = Date.parse(payload.expires_at.trim());
      if (Number.isFinite(parsed)) expiresAt = new Date(parsed).toISOString();
    }

    return {
      access_token: accessToken,
      refresh_token: nextRefresh,
      expires_at: expiresAt,
      token_type: typeof payload?.token_type === "string" ? payload.token_type : null,
    };
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === timeoutError) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function persistGrokRefreshedAuth(authPath, authFile, scopeKey, entry, newTokens) {
  if (!authPath || !scopeKey || !entry || !newTokens?.access_token) {
    throw new Error("Grok auth persist requires auth path, scope, entry, and access_token");
  }
  const nextEntry = {
    ...entry,
    key: newTokens.access_token,
    refresh_token: newTokens.refresh_token || entry.refresh_token,
  };
  if (newTokens.expires_at) {
    nextEntry.expires_at = newTokens.expires_at;
  } else {
    // Unknown new lifetime: drop the stale timestamp, otherwise the next poll
    // sees an already-expired expires_at next to a fresh key and refreshes
    // again on every cycle (burning a rotation each time).
    delete nextEntry.expires_at;
  }
  const merged = {
    ...authFile,
    [scopeKey]: nextEntry,
  };
  const tmp = `${authPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.promises.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(tmp, authPath);
  } catch (error) {
    // Never leave a tmp file holding fresh tokens behind.
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await fs.promises.chmod(authPath, 0o600);
  } catch (_error) {
    // Best-effort; some filesystems reject chmod on rename targets.
  }
  return { entry: nextEntry, authFile: merged, authPath, scopeKey };
}

/**
 * Return a usable access token, refreshing via OIDC when expired or forced.
 * Does not throw for missing install; throws GROK_REAUTH_REQUIRED when refresh is rejected.
 */
async function resolveGrokAccessToken({
  home,
  env = process.env,
  fetchImpl = fetch,
  forceRefresh = false,
  nowMs = Date.now(),
} = {}) {
  const loaded = loadGrokAuthEntry({ home, env });
  if (!loaded) {
    return {
      accessToken: null,
      configured: false,
      canRefresh: false,
      refreshed: false,
    };
  }

  const accessToken = grokEntryAccessToken(loaded.entry);
  const refreshToken = grokEntryRefreshToken(loaded.entry);
  const expired = isGrokAccessTokenExpired(loaded.entry.expires_at, nowMs);
  const canRefresh = Boolean(refreshToken && resolveGrokOidcClientId(loaded.entry, loaded.scopeKey));
  const needsRefresh = forceRefresh || !accessToken || expired;

  if (!needsRefresh) {
    return {
      accessToken,
      configured: true,
      canRefresh,
      refreshed: false,
      loaded,
    };
  }

  if (!canRefresh) {
    if (accessToken) {
      // Stale key still present — let billing decide (may 401).
      return {
        accessToken,
        configured: true,
        canRefresh: false,
        refreshed: false,
        loaded,
      };
    }
    return {
      accessToken: null,
      configured: true,
      canRefresh: false,
      refreshed: false,
      loaded,
      error: grokAuthError(),
    };
  }

  const clientId = resolveGrokOidcClientId(loaded.entry, loaded.scopeKey);
  const tokens = await refreshGrokTokens({
    refreshToken,
    clientId,
    tokenEndpoint: resolveGrokTokenEndpoint(loaded.entry, env),
    fetchImpl,
  });
  const persisted = await persistGrokRefreshedAuth(
    loaded.authPath,
    loaded.authFile,
    loaded.scopeKey,
    loaded.entry,
    tokens,
  );

  return {
    accessToken: tokens.access_token,
    configured: true,
    canRefresh: true,
    refreshed: true,
    loaded: persisted,
  };
}

// xAI reports the subscription as a human-readable product name on the billing
// payload's top level (`subscriptionTier`, a sibling of `config`, not a member
// of it) -- a Free account reads exactly "Free".
const GROK_PLAN_TIERS = new Map([
  ["supergrokheavy", "SuperGrok Heavy"],
  ["supergrokplus", "SuperGrok Plus"],
  ["supergroklite", "SuperGrok Lite"],
  ["supergrok", "SuperGrok"],
  ["xpremiumplus", "X Premium+"],
  ["premiumplus", "X Premium+"],
  ["xpremium", "X Premium+"],
  ["apikey", "API Key"],
  ["free", "Free"],
]);

/**
 * Map xAI's subscription tier to the name its own UI shows.
 *
 * Separators are folded away before matching so the same table covers whichever
 * casing the API returns ("SuperGrok Heavy", "SUPER_GROK_HEAVY", "superGrokHeavy").
 * Unknown values return null rather than being passed through: the Limits panel
 * falls back to the bare brand name, which is better than rendering a raw enum
 * (issue #130 shipped "Kimi Type_event" that way).
 */
function deriveGrokPlanLabel(rawTier) {
  if (rawTier == null) return null;
  const key = String(rawTier).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!key) return null;
  // Exact match only. Prefix matching would read an unseen tier such as
  // "SuperGrok Business" as plain "SuperGrok", and a confidently wrong plan on
  // the card is worse than no plan at all.
  return GROK_PLAN_TIERS.get(key) ?? null;
}

/**
 * Parse either:
 *   - Unified billing (`?format=credits`): weekly/monthly period + creditUsagePercent
 *   - Legacy monthly credits: monthlyLimit / used + calendar-month billingPeriod*
 *
 * Prefer the unified shape; legacy remains as a fallback for older accounts.
 */
function normalizeGrokBillingResponse(body) {
  const config = body?.config;
  if (!config || typeof config !== "object") {
    throw new Error("Could not parse Grok billing: missing config");
  }

  const currentPeriod =
    config.currentPeriod && typeof config.currentPeriod === "object" ? config.currentPeriod : null;

  const periodStart =
    grokIsoReset(currentPeriod?.start) || grokIsoReset(config.billingPeriodStart);
  const resetAt = grokIsoReset(currentPeriod?.end) || grokIsoReset(config.billingPeriodEnd);

  let periodType = normalizeGrokPeriodType(currentPeriod?.type);
  if (!periodType) {
    periodType = inferGrokPeriodTypeFromDates(periodStart, resetAt);
  }

  // Unified billing: overall pool percent is what gates "You hit your weekly limit".
  // productUsage is attribution across products that share the same pool — sum it.
  let usedPercent = clampPercent(config.creditUsagePercent);
  if (usedPercent === null) {
    usedPercent = sumProductUsagePercent(config.productUsage);
  }

  // Legacy monthly credit counters (pre-unified / non-format=credits responses).
  const monthlyLimit = grokValNumber(config.monthlyLimit);
  const used = grokValNumber(config.used);
  if (usedPercent === null && Number.isFinite(monthlyLimit) && monthlyLimit > 0 && Number.isFinite(used)) {
    usedPercent = (used / monthlyLimit) * 100;
    if (!periodType) periodType = "monthly";
  }

  // Unified billing omits creditUsagePercent (and productUsage) entirely when
  // nothing was used this period. A valid currentPeriod window with the usage
  // fields absent means 0%, not an unparseable response. Present-but-malformed
  // fields still fall through to the parse error below.
  if (
    usedPercent === null &&
    currentPeriod &&
    (periodStart || resetAt) &&
    config.creditUsagePercent === undefined &&
    config.productUsage === undefined
  ) {
    usedPercent = 0;
  }

  const onDemandCap = grokValNumber(config.onDemandCap);
  const onDemandUsed = grokValNumber(config.onDemandUsed);

  const primaryWindow = buildWindow({ usedPercent, resetAt });

  let secondaryWindow = null;
  if (Number.isFinite(onDemandCap) && onDemandCap > 0 && Number.isFinite(onDemandUsed)) {
    secondaryWindow = buildWindow({
      usedPercent: (onDemandUsed / onDemandCap) * 100,
      resetAt,
    });
  }

  if (!primaryWindow && !secondaryWindow) {
    throw new Error("Could not parse Grok billing: no quota windows in response");
  }

  return {
    // Read from the response root, not from `config`.
    plan_label: deriveGrokPlanLabel(body?.subscriptionTier),
    period_type: periodType,
    monthly_credits_limit: monthlyLimit,
    monthly_credits_used: used,
    // Effective percent used for the primary bar (API creditUsagePercent, or
    // productUsage / legacy monthly counters when the raw field is absent).
    credit_usage_percent: usedPercent == null ? null : clampPercent(usedPercent),
    on_demand_cap: onDemandCap,
    on_demand_used: onDemandUsed,
    billing_period_start: periodStart,
    primary_window: primaryWindow,
    secondary_window: secondaryWindow,
  };
}

/**
 * Fetch Grok billing. Prefer `?format=credits` (unified weekly/monthly pool
 * used by the Grok Build TUI). Fall back to the bare `/v1/billing` payload for
 * older accounts that only expose monthlyLimit/used.
 */
async function fetchGrokBilling(
  accessToken,
  { fetchImpl = fetch, baseUrl, env, timeoutMs = DEFAULT_BILLING_TIMEOUT_MS } = {},
) {
  const root = (baseUrl || resolveGrokBillingBaseUrl(env)).replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_BILLING_TIMEOUT_MS;
  const deadlineMs = Date.now() + normalizedTimeoutMs;

  const creditsUrl = `${root}/v1/billing?format=credits`;
  let creditsFailure = "request failed";
  try {
    const creditsResult = await fetchGrokBillingAttempt(
      fetchImpl,
      creditsUrl,
      headers,
      deadlineMs,
    );
    if (creditsResult.ok) return creditsResult.body;
    creditsFailure = `HTTP ${creditsResult.status}`;
  } catch (error) {
    if (error?.code === "GROK_AUTH_REQUIRED") throw error;
    if (error?.code === "GROK_BILLING_TIMEOUT") throw error;
  }

  // Non-auth HTTP, network, or response-decoding failure → try the legacy
  // shape once, while sharing the original request deadline.
  let legacyResult;
  try {
    legacyResult = await fetchGrokBillingAttempt(
      fetchImpl,
      `${root}/v1/billing`,
      headers,
      deadlineMs,
    );
  } catch (error) {
    if (error?.code === "GROK_AUTH_REQUIRED" || error?.code === "GROK_BILLING_TIMEOUT") throw error;
    throw new Error(`Grok billing request failed (format=credits: ${creditsFailure})`, {
      cause: error,
    });
  }
  if (!legacyResult.ok) {
    throw new Error(
      `Grok billing API returned ${legacyResult.status} (format=credits: ${creditsFailure})`,
    );
  }
  return legacyResult.body;
}

async function fetchGrokLimits({ home, env, fetchImpl = fetch, timeoutMs, nowMs } = {}) {
  if (!isGrokInstalled({ home, env })) {
    return { configured: false };
  }

  let resolved;
  try {
    resolved = await resolveGrokAccessToken({ home, env, fetchImpl, nowMs });
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }

  if (!resolved.configured) {
    return { configured: false };
  }
  if (!resolved.accessToken) {
    return {
      configured: true,
      error: resolved.error?.message || grokAuthError().message,
    };
  }

  try {
    let body;
    try {
      body = await fetchGrokBilling(resolved.accessToken, { fetchImpl, env, timeoutMs });
    } catch (error) {
      // Access token rejected — refresh once when a refresh_token is available.
      if (
        error?.code === "GROK_AUTH_REQUIRED" &&
        resolved.canRefresh &&
        !resolved.refreshed
      ) {
        const retry = await resolveGrokAccessToken({
          home,
          env,
          fetchImpl,
          forceRefresh: true,
          nowMs,
        });
        if (!retry.accessToken) {
          throw retry.error || grokReauthError();
        }
        body = await fetchGrokBilling(retry.accessToken, { fetchImpl, env, timeoutMs });
      } else {
        throw error;
      }
    }
    return {
      configured: true,
      error: null,
      ...normalizeGrokBillingResponse(body),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

module.exports = {
  resolveGrokHome,
  resolveGrokBillingBaseUrl,
  DEFAULT_TOKEN_ENDPOINT,
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
  isGrokInstalled,
  loadGrokAuthEntry,
  readGrokAccessToken,
  isGrokAccessTokenExpired,
  resolveGrokOidcClientId,
  resolveGrokOidcIssuer,
  resolveGrokTokenEndpoint,
  refreshGrokTokens,
  persistGrokRefreshedAuth,
  resolveGrokAccessToken,
  normalizeGrokPeriodType,
  inferGrokPeriodTypeFromDates,
  sumProductUsagePercent,
  deriveGrokPlanLabel,
  normalizeGrokBillingResponse,
  fetchGrokBilling,
  fetchGrokLimits,
};
