const crypto = require("node:crypto");
const fssync = require("node:fs");
const path = require("node:path");
const { readSqliteJsonRowsAsync } = require("./sqlite-reader");

// OpenCode Go usage limits.
//
// Three data sources are available, in priority order:
//
//   1. The official OpenCode Go usage API
//      (GET https://opencode.ai/zen/go/v1/usage) with
//      `Authorization: Bearer <OPENCODE_GO_API_KEY>`. It returns the server's
//      authoritative rolling (5h), weekly, and monthly usage windows.
//
//   2. Web scrape of the workspace dashboard
//      (https://opencode.ai/workspace/<id>/go) for existing users configured
//      with OPENCODE_GO_AUTH_COOKIE. This is retained as a compatibility path.
//
//   3. Local opencode.db cost aggregation, explicitly enabled with
//      TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE=1. The `opencode` CLI records
//      every Go turn's USD `cost` in SQLite, so cost ÷ Go's dollar caps is a
//      useful local estimate. It cannot prove that the account still has an
//      active Go subscription, because the database contains historical turns
//      but no current entitlement state.
//
// The returned shape is shared by all sources. `source` is `'api'` for the
// official endpoint, `'web'` for the compatibility scrape, or `'local-estimate'`
// for the opt-in estimate.

const SCRAPED_NUMBER_PATTERN = "([0-9]+(?:\\.[0-9]+)?)";

// Match each window's fields anchor-free, instead of pinning the exact SSR
// wrapper shape. opencode's hydration format around the data changes between
// releases (it dropped the `:$R[N]={…}` wrapper our old regexes required, which
// broke parsing in #225 even though auth worked and the page still carried the
// numbers). The field names (rollingUsage/weeklyUsage/monthlyUsage with
// usagePercent + resetInSec) are stable, so we anchor on those, the way
// steipete/codexbar's OpenCodeGoUsageFetcher does. `[^}]*?` keeps each match
// inside that window's own object, and `"?` tolerates both the unquoted SSR
// form (`usagePercent:2`) and a quoted JSON form (`"usagePercent":2`).
function windowFieldRegex(windowKey, field) {
  return new RegExp(`${windowKey}[^}]*?${field}"?\\s*[:=]+\\s*${SCRAPED_NUMBER_PATTERN}`);
}

const GO_USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage";
const DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/";
const DASHBOARD_URL_SUFFIX = "/go";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const LOCAL_ESTIMATE_ENV = "TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE";

function isTruthyEnvValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function localEstimateEnabled(env = process.env) {
  return Boolean(env && typeof env === "object" && isTruthyEnvValue(env[LOCAL_ESTIMATE_ENV]));
}

// OpenCode's inactive Go workspace renders a Subscribe button and no usage
// items. Keep this detection deliberately narrow: an unknown/changed page must
// remain an error, not be guessed as an inactive subscription.
function detectSubscriptionStatus(html) {
  if (typeof html !== "string") return "unknown";
  const normalized = html.replace(/\\(["'])/g, "$1");
  return /data-slot\s*=\s*["']subscribe-button["']/i.test(normalized)
    ? "inactive"
    : "unknown";
}

function readConfig(env = process.env) {
  if (!env || typeof env !== "object") return null;
  const workspaceId =
    typeof env.OPENCODE_GO_WORKSPACE_ID === "string"
      ? env.OPENCODE_GO_WORKSPACE_ID.trim()
      : "";
  const authCookie =
    typeof env.OPENCODE_GO_AUTH_COOKIE === "string"
      ? env.OPENCODE_GO_AUTH_COOKIE.trim()
      : "";
  if (!authCookie) return null;
  return { workspaceId, authCookie };
}

function readApiKey(env = process.env) {
  if (!env || typeof env !== "object") return "";
  return typeof env.OPENCODE_GO_API_KEY === "string"
    ? env.OPENCODE_GO_API_KEY.trim()
    : "";
}

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  let n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Some payloads encode the percentage as a 0–1 fraction (e.g. 0.02 for 2%).
  // Scale only when strictly below 1 so a genuine "1" stays 1%, not 100%.
  if (n > 0 && n < 1) n *= 100;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function buildWindow({ usagePercent, resetInSec, nowMs }) {
  const pct = clampPercent(usagePercent);
  if (pct === null) return null;
  const seconds = Number(resetInSec);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const resetAtIso = new Date(nowMs + Math.floor(seconds) * 1000).toISOString();
  return { used_percent: pct, reset_at: resetAtIso };
}

// Pull one window's usagePercent + resetInSec out of the page. The two fields
// are matched independently (order-independent), so it survives field
// reordering as well as wrapper changes.
function parseWindowUsage(html, windowKey) {
  const pctMatch = windowFieldRegex(windowKey, "usagePercent").exec(html);
  if (!pctMatch) return null;
  const usagePercent = Number(pctMatch[1]);
  if (!Number.isFinite(usagePercent)) return null;
  const resetMatch = windowFieldRegex(windowKey, "resetInSec").exec(html);
  const resetInSec = resetMatch ? Number(resetMatch[1]) : 0;
  return { usagePercent, resetInSec: Number.isFinite(resetInSec) ? resetInSec : 0 };
}

// Parse "1 hour 56 minutes" / "6 days 2 hours" / "26 days 17 hours" into
// seconds. The data-slot HTML fallback uses human-readable reset strings
// when the SSR hydration output is absent.
function parseHumanReadableTime(timeStr) {
  if (typeof timeStr !== "string") return null;
  const normalized = timeStr.toLowerCase().trim().replace(/\s+/g, " ");
  if (["reset-now", "reset now", "now", "resets now"].includes(normalized)) {
    return 0;
  }
  const dayMatch = normalized.match(/(\d+(?:\.\d+)?)\s*days?/);
  const hourMatch = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/);
  const minuteMatch = normalized.match(/(\d+(?:\.\d+)?)\s*minutes?/);
  const secondMatch = normalized.match(/(\d+(?:\.\d+)?)\s*seconds?/);
  if (!dayMatch && !hourMatch && !minuteMatch && !secondMatch) return null;
  let total = 0;
  if (dayMatch) total += Number(dayMatch[1]) * 86400;
  if (hourMatch) total += Number(hourMatch[1]) * 3600;
  if (minuteMatch) total += Number(minuteMatch[1]) * 60;
  if (secondMatch) total += Number(secondMatch[1]);
  return total;
}

function parseDataSlotFormat(html) {
  const out = {};
  const items = html.split(/data-slot="usage-item"/);
  for (let i = 1; i < items.length; i++) {
    const content = items[i];
    const labelMatch = content.match(/data-slot="usage-label">([^<]+)</);
    if (!labelMatch) continue;
    const label = labelMatch[1].trim().toLowerCase();
    const usageMatch = content.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/);
    if (!usageMatch) continue;
    const usagePercent = Number(usageMatch[1]);
    const resetMatch = content.match(
      /data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/,
    );
    if (!resetMatch) continue;
    const resetContent = resetMatch[2]
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/Resets?\s*in\s*/i, "")
      .trim();
    const resetInSec =
      resetMatch[1] === "reset-now" ? 0 : parseHumanReadableTime(resetContent);
    if (!Number.isFinite(usagePercent) || resetInSec === null) continue;
    let key = null;
    if (label.includes("rolling")) key = "rolling";
    else if (label.includes("weekly")) key = "weekly";
    else if (label.includes("monthly")) key = "monthly";
    if (key) out[key] = { usagePercent, resetInSec };
  }
  return out;
}

function extractWindows(html, nowMs) {
  let rolling = parseWindowUsage(html, "rollingUsage");
  let weekly = parseWindowUsage(html, "weeklyUsage");
  let monthly = parseWindowUsage(html, "monthlyUsage");
  // Fill any *individual* missing window from the data-slot HTML fallback.
  // Running the fallback only when all three fail loses the case where SSR
  // hydration exposes e.g. rollingUsage but drops weeklyUsage — we'd return
  // `null` for that window even though parseDataSlotFormat() could still
  // recover it from the rendered HTML.
  if (!rolling || !weekly || !monthly) {
    const fallback = parseDataSlotFormat(html);
    rolling = rolling || fallback.rolling || null;
    weekly = weekly || fallback.weekly || null;
    monthly = monthly || fallback.monthly || null;
  }
  return {
    rolling: rolling ? buildWindow({ ...rolling, nowMs }) : null,
    weekly: weekly ? buildWindow({ ...weekly, nowMs }) : null,
    monthly: monthly ? buildWindow({ ...monthly, nowMs }) : null,
  };
}

function sanitizeMessage(text, maxLength = 160) {
  const str = typeof text === "string" ? text : String(text ?? "");
  const squashed = str.replace(/\s+/g, " ").trim();
  return (squashed || "unknown").slice(0, maxLength);
}

function withTimeout(fetchImpl, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchImpl;
  return (input, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const next = { ...init, signal: init.signal || controller.signal };
    return fetchImpl(input, next).finally(() => clearTimeout(timer));
  };
}

// TanStack server-function ID for the "list workspaces" query. Generated at
// build time by OpenCode's SolidStart bundler. To update: open opencode.ai
// with DevTools → Network, filter "_server", trigger any workspace load,
// and copy the `id` query parameter from the request URL.
const WORKSPACES_SERVER_ID =
  "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";

async function resolveWorkspaceId(authCookie, fetchImpl, timeoutMs) {
  const serverId = WORKSPACES_SERVER_ID;
  const instanceId = `server-fn:${crypto.randomUUID()}`;

  const headers = {
    "Cookie": `auth=${authCookie}`,
    "X-Server-Id": serverId,
    "X-Server-Instance": instanceId,
    "User-Agent": USER_AGENT,
    "Origin": "https://opencode.ai",
    "Referer": "https://opencode.ai",
    "Accept": "text/javascript, application/json;q=0.9, */*;q=0.8"
  };

  const getUrl = `https://opencode.ai/_server?id=${serverId}`;
  let response;
  try {
    response = await withTimeout(fetchImpl, timeoutMs)(getUrl, {
      method: "GET",
      headers,
    });
  } catch (err) {
    throw new Error(`GET _server failed: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Unauthorized or forbidden (401/403)");
  }

  let text = await response.text();
  let ids = parseWorkspaceIds(text);

  if (ids.length === 0 && !looksSignedOut(text)) {
    const postUrl = "https://opencode.ai/_server";
    const postHeaders = {
      ...headers,
      "Content-Type": "application/json",
    };
    try {
      response = await withTimeout(fetchImpl, timeoutMs)(postUrl, {
        method: "POST",
        headers: postHeaders,
        body: "[]"
      });
      text = await response.text();
      ids = parseWorkspaceIds(text);
    } catch (postErr) {
      // GET returned content but no workspace IDs; POST also failed.
      // Wrap both signals so the caller can surface a useful diagnostic.
      throw new Error(`GET returned no workspace IDs and POST fallback failed: ${postErr.message}`);
    }
  }

  return ids.length > 0 ? ids[0] : null;
}

function parseWorkspaceIds(text) {
  const ids = new Set();
  const re = /id\s*[:=]+\s*\\?"(wrk_[^\\"]+)\\"?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.add(m[1]);
  }
  if (ids.size === 0) {
    try {
      const walk = (o) => {
        if (typeof o === "string" && o.startsWith("wrk_")) {
          ids.add(o);
        } else if (Array.isArray(o)) {
          o.forEach(walk);
        } else if (o && typeof o === "object") {
          Object.values(o).forEach(walk);
        }
      };
      walk(JSON.parse(text));
    } catch (_) {}
  }
  return Array.from(ids);
}

function looksSignedOut(text) {
  const l = String(text).toLowerCase();
  // Use specific phrases to avoid false positives on workspace names containing
  // common words like "login" (e.g. a workspace named "loginServiceApp").
  return l.includes("please log in") || l.includes("sign in to") || l.includes("auth/authorize")
    || l.includes("not associated with an account") || l.includes('actor of type "public"');
}

// --- Local opencode.db cost aggregation (auth-free source) ------------------

const SESSION_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// OpenCode Go's official dollar caps — https://opencode.ai/docs/go
// ($12 per 5h, $30 per week, $60 per month). The limits are not stored in the
// local DB, so they are hardcoded; env-overridable in case opencode changes
// them (TOKENTRACKER_OPENCODE_GO_LIMITS="12,30,60").
const DEFAULT_GO_LIMITS = { session: 12, weekly: 30, monthly: 60 };

function goDollarLimits(env = process.env) {
  const raw = String((env && env.TOKENTRACKER_OPENCODE_GO_LIMITS) || "").trim();
  if (!raw) return { ...DEFAULT_GO_LIMITS };
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n > 0)) {
    return { session: parts[0], weekly: parts[1], monthly: parts[2] };
  }
  return { ...DEFAULT_GO_LIMITS };
}

// Mirror sync.js's opencode home resolution (OPENCODE_HOME / XDG_DATA_HOME /
// <home>/.local/share/opencode) so we read the SAME DB the parser reads. The
// user home comes from the `home` arg getUsageLimits already threads to every
// other home-based provider (cf. resolveZcodeHome). NOTE: we deliberately do
// NOT fall back to os.homedir() — only an explicit `home`/env HOME — so a
// synthetic test env (no home, no HOME) discovers nothing and the web-scrape
// tests stay isolated from the developer's real opencode.db.
function resolveOpencodeDataDir({ home, env = process.env } = {}) {
  if (env.OPENCODE_HOME) return env.OPENCODE_HOME;
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, "opencode");
  const base = home || env.HOME || env.USERPROFILE;
  if (!base) return null;
  return path.join(base, ".local", "share", "opencode");
}

// Matches `opencode.db` or `opencode-<channel>.db`; excludes WAL/SHM side-files.
function isOpencodeDbFilename(name) {
  if (!name.endsWith(".db")) return false;
  const stem = name.slice(0, -3);
  if (stem === "opencode") return true;
  if (!stem.startsWith("opencode-")) return false;
  const channel = stem.slice("opencode-".length);
  return channel.length > 0 && /^[A-Za-z0-9._-]+$/.test(channel);
}

function discoverOpencodeDbPaths({ home, env = process.env } = {}) {
  const override = String((env && env.OPENCODE_DB) || "").trim();
  if (override) {
    try {
      if (fssync.statSync(override).isFile()) return [override];
    } catch (_e) {
      /* fall through to directory scan */
    }
  }
  const dir = resolveOpencodeDataDir({ home, env });
  if (!dir) return [];
  let entries;
  try {
    entries = fssync.readdirSync(dir);
  } catch (_e) {
    return [];
  }
  return entries.filter(isOpencodeDbFilename).sort().map((n) => path.join(dir, n));
}

function weekStartMs(nowMs) {
  const d = new Date(nowMs);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const sinceMonday = day === 0 ? 6 : day - 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
}

// Calendar-month bounds (UTC). OpenCode Go's true monthly reset is the
// subscription anniversary, which the local DB does not record; the calendar
// month is a stable, defensible approximation for the auth-free estimate.
function monthBoundsMs(nowMs) {
  const now = new Date(nowMs);
  return {
    startMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    endMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  };
}

// Percentage clamp for the local estimate. Unlike clampPercent() (which scales
// a 0–1 fraction from the web payload), this treats its input as an already-
// computed percentage and must NOT rescale values below 1 (e.g. 0.5%).
function clampLocalPercent(n) {
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function buildLocalWindow({ used, limit, resetMs }) {
  if (!(limit > 0)) return null;
  const pct = clampLocalPercent((Number(used) / limit) * 100);
  if (pct === null) return null;
  return { used_percent: pct, reset_at: new Date(resetMs).toISOString() };
}

// One full-table aggregate (the message table has no index on the JSON fields,
// so we sum in SQLite and return a single row rather than streaming every
// opencode-go turn into JS — keeps the limits poll cheap, cf. the spawnSync
// freeze lesson).
function buildGoAggregateSql({ sessionStart, weekStart, weekEnd, monthStart, monthEnd }) {
  return (
    "SELECT " +
    `COALESCE(SUM(CASE WHEN createdMs >= ${sessionStart} THEN cost ELSE 0 END), 0) AS sessionCost, ` +
    `MIN(CASE WHEN createdMs >= ${sessionStart} THEN createdMs END) AS sessionOldest, ` +
    `COALESCE(SUM(CASE WHEN createdMs >= ${weekStart} AND createdMs < ${weekEnd} THEN cost ELSE 0 END), 0) AS weeklyCost, ` +
    `COALESCE(SUM(CASE WHEN createdMs >= ${monthStart} AND createdMs < ${monthEnd} THEN cost ELSE 0 END), 0) AS monthlyCost, ` +
    "COUNT(*) AS rowCount " +
    "FROM (" +
    "SELECT CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs, " +
    "CAST(json_extract(data,'$.cost') AS REAL) AS cost " +
    "FROM message " +
    "WHERE json_valid(data) " +
    "AND json_extract(data,'$.providerID') = 'opencode-go' " +
    "AND json_extract(data,'$.role') = 'assistant' " +
    "AND json_type(data,'$.cost') IN ('integer','real')" +
    ")"
  );
}

// Returns { source:'local', primary/secondary/tertiary_window } or null when no
// opencode.db / no opencode-go rows are found. The caller labels this result as
// an estimate and only exposes it when explicitly opted in.
async function collectOpencodeGoLocal({ home, env = process.env, nowMs = Date.now(), sqliteOptions = {} } = {}) {
  const paths = discoverOpencodeDbPaths({ home, env });
  if (paths.length === 0) return null;

  const sessionStart = Math.floor(nowMs - SESSION_MS);
  const weekStart = weekStartMs(nowMs);
  const weekEnd = weekStart + WEEK_MS;
  const { startMs: monthStart, endMs: monthEnd } = monthBoundsMs(nowMs);
  const sql = buildGoAggregateSql({ sessionStart, weekStart, weekEnd, monthStart, monthEnd });

  let agg = null;
  for (const dbPath of paths) {
    let rows;
    try {
      rows = await readSqliteJsonRowsAsync(dbPath, sql, {
        label: "OpenCode Go",
        timeout: 5_000,
        ...sqliteOptions,
      });
    } catch (_e) {
      continue;
    }
    const row = rows && rows[0];
    if (!row) continue;
    const rowCount = Number(row.rowCount) || 0;
    if (rowCount <= 0) continue;
    if (!agg) agg = { sessionCost: 0, weeklyCost: 0, monthlyCost: 0, sessionOldest: null, rowCount: 0 };
    agg.sessionCost += Number(row.sessionCost) || 0;
    agg.weeklyCost += Number(row.weeklyCost) || 0;
    agg.monthlyCost += Number(row.monthlyCost) || 0;
    agg.rowCount += rowCount;
    const oldest = row.sessionOldest == null ? null : Number(row.sessionOldest);
    if (oldest != null && Number.isFinite(oldest)) {
      agg.sessionOldest = agg.sessionOldest == null ? oldest : Math.min(agg.sessionOldest, oldest);
    }
  }
  if (!agg || agg.rowCount <= 0) return null;

  const limits = goDollarLimits(env);
  const sessionReset = (agg.sessionOldest != null ? agg.sessionOldest : nowMs) + SESSION_MS;
  return {
    source: "local",
    primary_window: buildLocalWindow({ used: agg.sessionCost, limit: limits.session, resetMs: sessionReset }),
    secondary_window: buildLocalWindow({ used: agg.weeklyCost, limit: limits.weekly, resetMs: weekEnd }),
    tertiary_window: buildLocalWindow({ used: agg.monthlyCost, limit: limits.monthly, resetMs: monthEnd }),
  };
}

function localGoResult(local) {
  return {
    configured: true,
    error: null,
    source: "local-estimate",
    subscription_status: "unknown",
    // No `plan_label` — the brand name "OpenCode Go" is the row title.
    primary_window: local.primary_window || null,
    secondary_window: local.secondary_window || null,
    tertiary_window: local.tertiary_window || null,
  };
}

// --- Official usage API (exact server-side usage, API-key-gated) -------------

async function fetchOpencodeGoApiLimits({ apiKey, fetchImpl, nowMs, timeoutMs }) {
  let response;
  try {
    response = await withTimeout(fetchImpl, timeoutMs)(GO_USAGE_API_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
  } catch (err) {
    return { configured: true, error: sanitizeMessage(err?.message || err) };
  }

  if (response.status === 401) {
    return {
      configured: true,
      error: "OpenCode Go API key is missing, invalid, expired, or not entitled to an OpenCode Go subscription.",
      auth_error: true,
    };
  }
  if (response.status === 403) {
    return {
      configured: true,
      error: "OpenCode Go subscription required for this API key.",
      auth_error: true,
    };
  }
  if (!response.ok) {
    return { configured: true, error: `OpenCode Go usage API error ${response.status}` };
  }

  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch (err) {
    return {
      configured: true,
      error: `Could not parse OpenCode Go usage API response: ${sanitizeMessage(err?.message || err)}`,
    };
  }

  // Upstream has shipped two shapes:
  // - Early spec (anomalyco/opencode#16513): { rollingUsage: { usagePercent, resetInSec } ... }
  // - Live API (2026-08): { usage: { rolling: { percent, resetsAt }, weekly: {}, monthly: {} } }
  const resolveApiWindow = (legacy, modern) => {
    if (modern && typeof modern === "object") {
      const pct = modern.percent ?? modern.usagePercent ?? modern.usage_percent;
      const resetsAt = modern.resetsAt ?? modern.resets_at ?? modern.resetAt ?? modern.reset_at;
      if (pct != null || resetsAt != null) {
        const resetInSec = (() => {
          if (typeof modern.resetInSec === "number" || typeof modern.resetInSec === "string") return Number(modern.resetInSec);
          if (typeof modern.reset_in_sec === "number" || typeof modern.reset_in_sec === "string") return Number(modern.reset_in_sec);
          if (typeof resetsAt === "string" && resetsAt) {
            const ts = Date.parse(resetsAt);
            if (Number.isFinite(ts)) return Math.max(0, Math.floor((ts - nowMs) / 1000));
          }
          return undefined;
        })();
        const modernWindow = buildWindow({ usagePercent: pct, resetInSec, nowMs });
        // Only prefer the modern window when it actually parsed; an incomplete
        // modern object (e.g. percent without reset info) must fall through to
        // a valid legacy window instead of losing it.
        if (modernWindow) return modernWindow;
      }
    }
    if (legacy && typeof legacy === "object") {
      return buildWindow({ usagePercent: legacy.usagePercent ?? legacy.percent, resetInSec: legacy.resetInSec ?? legacy.reset_in_sec, nowMs });
    }
    return null;
  };

  const rolling = resolveApiWindow(payload?.rollingUsage, payload?.usage?.rolling ?? payload?.rolling);
  const weekly = resolveApiWindow(payload?.weeklyUsage, payload?.usage?.weekly ?? payload?.weekly);
  const monthly = resolveApiWindow(payload?.monthlyUsage, payload?.usage?.monthly ?? payload?.monthly);

  if (!rolling && !weekly && !monthly) {
    return {
      configured: true,
      error: "OpenCode Go usage API response did not include any known usage windows.",
    };
  }

  return {
    configured: true,
    error: null,
    subscription_status: "active",
    primary_window: rolling,
    secondary_window: weekly,
    tertiary_window: monthly,
  };
}

// --- Web scrape (exact server-side usage, cookie-gated) ---------------------

async function scrapeOpencodeGoWeb({ cfg, fetchImpl, nowMs, timeoutMs }) {
  let workspaceId = cfg.workspaceId;
  if (!workspaceId) {
    try {
      workspaceId = await resolveWorkspaceId(cfg.authCookie, fetchImpl, timeoutMs);
    } catch (err) {
      return { configured: true, error: `Failed to resolve Workspace ID: ${sanitizeMessage(err?.message || err)}` };
    }
    if (!workspaceId) {
      return { configured: true, error: "Could not auto-resolve OpenCode Workspace ID from cookie. Please set OPENCODE_GO_WORKSPACE_ID manually." };
    }
  }

  const url =
    DASHBOARD_URL_PREFIX + encodeURIComponent(workspaceId) + DASHBOARD_URL_SUFFIX;

  let response;
  try {
    response = await withTimeout(fetchImpl, timeoutMs)(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
        Cookie: `auth=${cfg.authCookie}`,
      },
    });
  } catch (err) {
    return { configured: true, error: sanitizeMessage(err?.message || err) };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      configured: true,
      error: "Not signed in to OpenCode Go. Refresh the auth cookie in OPENCODE_GO_AUTH_COOKIE.",
    };
  }
  if (!response.ok) {
    return {
      configured: true,
      error: `OpenCode Go dashboard error ${response.status}`,
    };
  }

  let html;
  try {
    html = await response.text();
  } catch (err) {
    return { configured: true, error: sanitizeMessage(err?.message || err) };
  }

  const { rolling, weekly, monthly } = extractWindows(html, nowMs);
  if (!rolling && !weekly && !monthly) {
    if (detectSubscriptionStatus(html) === "inactive") {
      return {
        configured: true,
        error: null,
        subscription_status: "inactive",
      };
    }
    return {
      configured: true,
      error:
        "Could not parse any known OpenCode Go dashboard usage windows (rollingUsage, weeklyUsage, monthlyUsage). The page layout may have changed.",
    };
  }

  return {
    configured: true,
    error: null,
    subscription_status: "active",
    // No `plan_label` — the brand name "OpenCode Go" is the row title, so
    // appending "Go" again would render "OpenCode Go Go" in the panel.
    primary_window: rolling,
    secondary_window: weekly,
    tertiary_window: monthly,
  };
}

async function fetchOpencodeGoLimits({
  home,
  env = process.env,
  fetchImpl = fetch,
  nowMs = Date.now(),
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sqliteOptions = {},
} = {}) {
  const apiKey = readApiKey(env);
  const cfg = readConfig(env);
  const allowLocalEstimate = localEstimateEnabled(env);

  // Prefer the documented API whenever an API key is explicitly configured.
  // An authentication failure is actionable and must not be hidden by silently
  // falling back to a possibly stale cookie. For a transient API failure, an
  // existing cookie remains a compatibility fallback.
  if (apiKey) {
    const api = await fetchOpencodeGoApiLimits({ apiKey, fetchImpl, nowMs, timeoutMs });
    if (!api?.error && (api.primary_window || api.secondary_window || api.tertiary_window)) {
      return { ...api, source: "api" };
    }
    if (api?.auth_error) {
      const { auth_error, ...result } = api;
      return result;
    }
    if (!cfg) return api || { configured: true, error: "OpenCode Go unavailable" };
  }

  // Keep the cookie-backed dashboard path for existing configurations and as a
  // fallback when the official API is temporarily unavailable.
  if (cfg) {
    const web = await scrapeOpencodeGoWeb({ cfg, fetchImpl, nowMs, timeoutMs });
    if (web?.subscription_status === "inactive") return web;
    if (web && !web.error && (web.primary_window || web.secondary_window || web.tertiary_window)) {
      return { ...web, source: "web" };
    }
    if (allowLocalEstimate) {
      const local = await collectOpencodeGoLocal({ home, env, nowMs, sqliteOptions });
      if (local) return localGoResult(local);
    }
    return web || { configured: true, error: "OpenCode Go unavailable" };
  }

  // Local history cannot establish that the account is currently subscribed.
  // Keep it available for users who explicitly accept that limitation.
  if (!allowLocalEstimate) return { configured: false };
  const local = await collectOpencodeGoLocal({ home, env, nowMs, sqliteOptions });
  if (local) return localGoResult(local);
  return { configured: false };
}

module.exports = {
  fetchOpencodeGoLimits,
  fetchOpencodeGoApiLimits,
  readConfig,
  readApiKey,
  localEstimateEnabled,
  detectSubscriptionStatus,
  extractWindows,
  parseWindowUsage,
  parseDataSlotFormat,
  parseHumanReadableTime,
  buildWindow,
  resolveWorkspaceId,
  parseWorkspaceIds,
  looksSignedOut,
  // Local opencode.db cost-based estimate (auth-free source).
  collectOpencodeGoLocal,
  discoverOpencodeDbPaths,
  resolveOpencodeDataDir,
  isOpencodeDbFilename,
  goDollarLimits,
  weekStartMs,
  monthBoundsMs,
  buildLocalWindow,
};
