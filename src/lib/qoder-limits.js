"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { fetchQoderCnCliLimits } = require("./qoder-cn-cli-limits");

const QODER_SITES = {
  international: {
    id: "international",
    origin: "https://qoder.com",
    usageUrl: "https://qoder.com/api/v2/me/usages/big_model_credits",
    activityUrl: "https://openapi.qoder.sh/algo/api/v2/activity",
    domains: new Set(["qoder.com", "www.qoder.com"]),
  },
  china: {
    id: "china",
    origin: "https://qoder.cn",
    usageUrl: "https://qoder.cn/api/v2/me/usages/big_model_credits",
    activityUrl: "https://openapi.qoder.com.cn/algo/api/v2/activity",
    domains: new Set(["qoder.cn", "www.qoder.cn", "qoder.com.cn", "www.qoder.com.cn"]),
  },
};

const QODER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

// Qoder 1.18 serves promotional call buckets (including Ultimate Free Calls)
// from its OpenAPI activity endpoint. The request uses the same COSY envelope
// as Qoder CLI 1.0.22. Authentication comes from Qoder's already-running local
// service over JSON-RPC; TokenTracker never persists or logs those credentials.
const QODER_ACTIVITY_URL = "https://openapi.qoder.sh/algo/api/v2/activity";
const QODER_ULTIMATE_ACTIVITY_ID = "ultimate_200_free_invoke";
const QODER_COSY_VERSION = "1.0.22";
const QODER_ACTIVITY_CACHE_FILE = "qoder-activity-cache.json";
const QODER_ACTIVITY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const QODER_LIMITS_CACHE_FILE = "qoder-usage-limits-cache.json";
const QODER_LIMITS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QODER_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS = 12 * 60 * 60 * 1000;
// Qoder Desktop 0.4+ writes its account usage summary to main.log, which can
// accumulate a whole session before the quota is read. Scan a bounded window
// backwards instead of assuming the summary is near EOF.
const QODER_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QODER_LOG_SCAN_MAX_BYTES = 8 * 1024 * 1024;
const QODER_LOG_SCAN_CHUNK_BYTES = 512 * 1024;
const QODER_LOG_SCAN_OVERLAP_BYTES = 64 * 1024;
const QODER_LOG_MAX_FILES = 8;
const QODER_SERVER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Qoder usage response is missing ${field}.`);
  }
  return number;
}

function firstDefined(object, camel, snake) {
  return object?.[camel] ?? object?.[snake];
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

function quotaSummary(container) {
  return firstDefined(container, "quotaSummary", "quota_summary") || null;
}

function normalizeQuotaSummary(summary) {
  if (!summary || typeof summary !== "object") {
    throw new Error("Qoder usage response is missing totalQuota.quotaSummary.");
  }
  const used = finiteNumber(firstDefined(summary, "usedValue", "used_value"), "usedValue");
  const total = finiteNumber(firstDefined(summary, "limitValue", "limit_value"), "limitValue");
  const rawRemaining = firstDefined(summary, "remainingValue", "remaining_value");
  const remaining = rawRemaining === null || rawRemaining === undefined
    ? Math.max(0, total - used)
    : finiteNumber(rawRemaining, "remainingValue");
  const rawPercentage = firstDefined(summary, "usagePercentage", "usage_percentage");
  const providedPercentage = rawPercentage === null || rawPercentage === undefined
    ? null
    : finiteNumber(rawPercentage, "usagePercentage");

  if (used < 0 || total < 0 || remaining < 0) {
    throw new Error("Qoder quota values must be nonnegative.");
  }
  if (total === 0 && (used !== 0 || remaining !== 0)) {
    throw new Error("Qoder zero total quota must have zero usage and remaining.");
  }
  const usagePercentage = providedPercentage ?? (total > 0 ? (used / total) * 100 : 100);
  return {
    used,
    total,
    remaining,
    usagePercentage: Math.max(0, Math.min(100, usagePercentage)),
    unit: typeof summary.unit === "string" && summary.unit.trim() ? summary.unit.trim() : null,
  };
}

function normalizeQoderUsageResponse(response) {
  if (!response || typeof response !== "object") {
    throw new Error("Qoder usage response is not an object.");
  }
  const totalContainer = firstDefined(response, "totalQuota", "total_quota");
  const sharedContainer = firstDefined(response, "sharedQuota", "shared_quota");
  const base = normalizeQuotaSummary(quotaSummary(totalContainer));
  const sharedSummary = quotaSummary(sharedContainer);
  const shared = sharedSummary ? normalizeQuotaSummary(sharedSummary) : null;

  const used = base.used + (shared?.used || 0);
  const total = base.total + (shared?.total || 0);
  const remaining = base.remaining + (shared?.remaining || 0);
  const usedPercent = shared
    ? total > 0
      ? (used / total) * 100
      : 100
    : base.usagePercentage;

  return {
    configured: true,
    error: null,
    primary_window: {
      used_percent: Math.max(0, Math.min(100, usedPercent)),
      reset_at: normalizeResetAt(firstDefined(response, "nextResetAt", "next_reset_at")),
      used_credits: used,
      limit_credits: total,
      remaining_credits: remaining,
      unit: base.unit || shared?.unit || null,
    },
    source: "provider-api",
  };
}

function qoderDataRoot({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  appDir = "Qoder",
  envPrefix = "QODER",
} = {}) {
  const homeKey = `${envPrefix}_HOME`;
  if (typeof env[homeKey] === "string" && env[homeKey].trim()) {
    return path.resolve(env[homeKey].trim());
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", appDir);
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), appDir);
  }
  return path.join(home, ".config", appDir);
}

function qoderRpcRequest(method, params = {}, {
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  appDir = "Qoder",
  envPrefix = "QODER",
  timeoutMs = 1500,
  netModule = net,
} = {}) {
  return new Promise((resolve, reject) => {
    const infoPath = path.join(qoderDataRoot({ home, env, platform, appDir, envPrefix }), "SharedClientCache", ".info.json");
    let info;
    try {
      info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    } catch (_error) {
      reject(new Error("Qoder local service is not running."));
      return;
    }
    const socketPath = typeof info?.ipcServerPath === "string" ? info.ipcServerPath.trim() : "";
    if (!socketPath) {
      reject(new Error("Qoder local service endpoint is unavailable."));
      return;
    }

    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = netModule.createConnection(socketPath);
    const timer = setTimeout(() => finish(new Error("Qoder local service request timed out.")), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.on("connect", () => {
      const body = Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }));
      socket.write(`Content-Length: ${body.length}\r\n\r\n`);
      socket.write(body);
    });
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"));
      if (!match) {
        finish(new Error("Qoder local service returned an invalid response."));
        return;
      }
      const bodyLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (!Number.isFinite(bodyLength) || bodyLength < 0 || bodyLength > 4 * 1024 * 1024) {
        finish(new Error("Qoder local service response is too large."));
        return;
      }
      if (buffer.length < bodyStart + bodyLength) return;
      try {
        const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8"));
        if (message.error) {
          finish(new Error(message.error.message || "Qoder local service request failed."));
        } else {
          finish(null, message.result);
        }
      } catch (_error) {
        finish(new Error("Qoder local service returned invalid JSON."));
      }
    });
  });
}

function normalizeQoderAddOnQuota(quota) {
  if (quota == null) return null;
  const used = Number(quota.used);
  const total = Number(quota.total);
  const remaining = quota.remaining == null ? Math.max(0, total - used) : Number(quota.remaining);
  if (quota.used == null || quota.total == null
    || ![used, total, remaining].every(Number.isFinite) || Math.min(used, total, remaining) < 0
    || (total === 0 && (used !== 0 || remaining !== 0))) {
    throw new Error("Qoder add-on quota values are invalid.");
  }
  return {
    used_percent: total > 0 ? Math.min(100, (used / total) * 100) : 0,
    // The official addOnQuota has no renewal date. Plan expiry does not apply.
    reset_at: null,
    used_credits: used,
    limit_credits: total,
    remaining_credits: remaining,
    unit: typeof quota.unit === "string" && quota.unit.trim() ? quota.unit.trim() : "credits",
  };
}

function normalizeQoderRpcUsage(response) {
  if (!response || typeof response !== "object") return null;
  const quota = response.userQuota;
  // Qoder CN CLI 1.1.71 renders userQuota and addOnQuota as separate buckets.
  // Only its account-level total_remaining adds them together.
  const addOnWindow = normalizeQoderAddOnQuota(response.addOnQuota);
  if ((!quota || typeof quota !== "object") && !addOnWindow) return null;
  const used = quota ? finiteNumber(quota.used, "userQuota.used") : 0;
  const total = quota ? finiteNumber(quota.total, "userQuota.total") : 0;
  const remaining = quota ? finiteNumber(quota.remaining, "userQuota.remaining") : 0;
  // totalUsagePercentage aggregates the plan and add-on buckets and reaches
  // this function on mixed scales (the OpenAPI returns fractions, the desktop
  // IPC returns percents), so the primary window always derives its percent
  // from its own quota numbers.
  const usedPercent = total === 0
    ? 0
    : addOnWindow
      ? (used / total) * 100
      : response.isQuotaExceeded === true
        ? 100
        : (used / total) * 100;
  const normalizedExpiry = normalizeResetAt(response.expiresAt);
  const expiryMs = normalizedExpiry ? Date.parse(normalizedExpiry) : NaN;
  return {
    configured: true,
    error: null,
    plan_label: typeof response.userType === "string" ? response.userType : null,
    quota_exceeded: response.isQuotaExceeded === true,
    primary_window: quota ? {
      used_percent: Math.max(0, Math.min(100, usedPercent)),
      // Qoder uses 9999-12-31 as a no-expiry sentinel for Free accounts.
      reset_at: Number.isFinite(expiryMs) && expiryMs < Date.UTC(2100, 0, 1)
        ? normalizedExpiry
        : null,
      used_credits: used,
      limit_credits: total,
      remaining_credits: remaining,
      unit: typeof quota.unit === "string" && quota.unit.trim() ? quota.unit.trim() : "credits",
    } : null,
    ...(addOnWindow ? { tertiary_window: addOnWindow } : {}),
    source: "local-ipc",
  };
}

function normalizeQoderActivityResponse(response, { nowMs = Date.now() } = {}) {
  if (!response || typeof response !== "object") {
    throw new Error("Qoder activity response is not an object.");
  }
  if (response.code !== undefined && Number(response.code) !== 0) {
    throw new Error(`Qoder activity API returned ${response.msg || `code ${response.code}`}.`);
  }
  const activities = Array.isArray(response.data?.activities) ? response.data.activities : [];
  const activity = activities.find((entry) => {
    if (!entry || entry.activityId !== QODER_ULTIMATE_ACTIVITY_ID || entry.eligible === false) return false;
    if (String(entry.tagStyle || "").toUpperCase() === "EXPIRED") return false;
    const endAt = Number(entry.activityEndAt);
    return !Number.isFinite(endAt) || endAt <= 0 || endAt > nowMs;
  });
  if (!activity) return null;
  const used = finiteNumber(activity.used, "activity.used");
  const total = finiteNumber(activity.limit, "activity.limit");
  const rawRemaining = Number(activity.remaining);
  const remaining = Number.isFinite(rawRemaining) ? rawRemaining : Math.max(0, total - used);
  if (used < 0 || total <= 0 || remaining < 0) {
    throw new Error("Qoder activity quota values are invalid.");
  }
  return {
    used_percent: Math.max(0, Math.min(100, (used / total) * 100)),
    reset_at: normalizeResetAt(activity.activityEndAt),
    used_credits: used,
    limit_credits: total,
    remaining_credits: remaining,
    unit: "calls",
    activity_id: QODER_ULTIMATE_ACTIVITY_ID,
  };
}

function qoderActivityCachePath({ home = os.homedir(), namespace } = {}) {
  const file = namespace
    ? `qoder-${namespace}-activity-cache.json`
    : QODER_ACTIVITY_CACHE_FILE;
  return path.join(home, ".tokentracker", "tracker", file);
}

function readQoderActivityCache({
  home = os.homedir(),
  nowMs = Date.now(),
  namespace,
  maxAgeMs = QODER_ACTIVITY_CACHE_MAX_AGE_MS,
} = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(qoderActivityCachePath({ home, namespace }), "utf8"));
    const window = parsed?.activity_window;
    const cachedAtMs = Date.parse(parsed?.cached_at || "");
    if (!window || !Number.isFinite(cachedAtMs) || cachedAtMs > nowMs + 60_000) return null;
    const resetAtMs = Date.parse(window.reset_at || "");
    if (Number.isFinite(resetAtMs)) {
      if (resetAtMs <= nowMs) return null;
    } else if (nowMs - cachedAtMs > maxAgeMs) {
      return null;
    }
    const used = Number(window.used_credits);
    const total = Number(window.limit_credits);
    const remaining = Number(window.remaining_credits);
    if (!Number.isFinite(used) || !Number.isFinite(total) || !Number.isFinite(remaining)
      || used < 0 || total <= 0 || remaining < 0) return null;
    return window;
  } catch (_error) {
    return null;
  }
}

function writeQoderActivityCache(window, {
  home = os.homedir(),
  nowMs = Date.now(),
  namespace,
} = {}) {
  if (!window) return;
  const cachePath = qoderActivityCachePath({ home, namespace });
  const payload = {
    activity_window: window,
    cached_at: new Date(nowMs).toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch (_error) {}
}

function qoderLimitsCachePath({ home = os.homedir(), namespace } = {}) {
  const file = namespace
    ? `qoder-${namespace}-usage-limits-cache.json`
    : QODER_LIMITS_CACHE_FILE;
  return path.join(home, ".tokentracker", "tracker", file);
}

function qoderCachedWindow(window, { cachedAtMs, nowMs } = {}) {
  if (!window || typeof window !== "object") return null;
  const resetAtMs = Date.parse(window.reset_at || "");
  if (Number.isFinite(resetAtMs)) return resetAtMs > nowMs ? window : null;
  return nowMs - cachedAtMs <= QODER_LIMITS_CACHE_UNKNOWN_RESET_TTL_MS ? window : null;
}

function readQoderLimitsCache({
  home = os.homedir(),
  nowMs = Date.now(),
  namespace,
} = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(qoderLimitsCachePath({ home, namespace }), "utf8"))?.qoder;
    const cachedAtMs = Date.parse(raw?.cached_at || "");
    if (!Number.isFinite(cachedAtMs) || cachedAtMs > nowMs + 60_000) return null;
    const primaryWindow = qoderCachedWindow(raw.primary_window, { cachedAtMs, nowMs });
    const secondaryWindow = qoderCachedWindow(raw.secondary_window, { cachedAtMs, nowMs });
    const tertiaryWindow = qoderCachedWindow(raw.tertiary_window, { cachedAtMs, nowMs });
    if (!primaryWindow && !secondaryWindow && !tertiaryWindow) return null;
    const hasUnexpiredDatedWindow = [primaryWindow, secondaryWindow, tertiaryWindow]
      .some((window) => Number.isFinite(Date.parse(window?.reset_at || "")));
    if (nowMs - cachedAtMs > QODER_LIMITS_CACHE_MAX_AGE_MS && !hasUnexpiredDatedWindow) {
      return null;
    }
    return {
      configured: true,
      error: null,
      plan_label: typeof raw.plan_label === "string" ? raw.plan_label : null,
      quota_exceeded: raw.quota_exceeded === true,
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

function writeQoderLimitsCache(limits, {
  home = os.homedir(),
  nowMs = Date.now(),
  namespace,
} = {}) {
  if (!limits?.configured || limits.error || (!limits.primary_window && !limits.secondary_window && !limits.tertiary_window)) return;
  const cachePath = qoderLimitsCachePath({ home, namespace });
  const payload = {
    qoder: {
      plan_label: limits.plan_label || null,
      quota_exceeded: limits.quota_exceeded === true,
      primary_window: limits.primary_window || null,
      secondary_window: limits.secondary_window || null,
      ...(limits.tertiary_window ? { tertiary_window: limits.tertiary_window } : {}),
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

function buildQoderActivityHeaders(authStatus, {
  nowMs = Date.now(),
  randomUUID = crypto.randomUUID,
} = {}) {
  const userId = String(authStatus?.id || authStatus?.accountId || "").trim();
  const accessToken = String(authStatus?.token || "").trim();
  if (!userId || !accessToken) {
    throw new Error("Qoder local session is missing activity credentials.");
  }
  const temporaryKey = Buffer.from(randomUUID().replace(/-/g, "").slice(0, 16), "ascii");
  const cosyKey = crypto.publicEncrypt(
    { key: QODER_SERVER_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    temporaryKey,
  ).toString("base64");
  const identity = {
    name: authStatus.name || "",
    aid: userId,
    uid: userId,
    yx_uid: authStatus.yxUid || "",
    organization_id: authStatus.orgId || "",
    organization_name: authStatus.orgName || "",
    user_type: authStatus.userType || "personal_standard",
    security_oauth_token: accessToken,
    refresh_token: authStatus.refreshToken || "",
  };
  const cipher = crypto.createCipheriv("aes-128-cbc", temporaryKey, temporaryKey);
  const info = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(identity), "utf8")),
    cipher.final(),
  ]).toString("base64");
  const payload = Buffer.from(JSON.stringify({
    version: "v1",
    requestId: randomUUID(),
    info,
    cosyVersion: QODER_COSY_VERSION,
    ideVersion: "",
  }), "utf8").toString("base64");
  const cosyDate = String(Math.floor(nowMs / 1000));
  const signature = crypto
    .createHash("md5")
    .update(`${payload}\n${cosyKey}\n${cosyDate}\n\n/api/v2/activity`, "utf8")
    .digest("hex");
  const machineId = randomUUID();
  return {
    "cosy-data-policy": "agree",
    "cosy-machinetype": "5",
    "cosy-clienttype": "5",
    "cosy-date": cosyDate,
    "cosy-user": userId,
    "cosy-key": cosyKey,
    "cache-control": "no-cache",
    "cosy-business-product": "cli",
    "cosy-business-type": "agent",
    "cosy-scene": "assistant",
    accept: "application/json",
    authorization: `Bearer COSY.${payload}.${signature}`,
    "accept-encoding": "identity",
    "cosy-version": QODER_COSY_VERSION,
    "cosy-machineid": machineId,
    "cosy-machinetoken": machineId,
    "login-version": "v2",
    "user-agent": "Go-http-client/2.0",
  };
}

async function fetchQoderActivity(authStatus, fetchImpl = fetch, options = {}) {
  const activityUrl = options.activityUrl || QODER_ACTIVITY_URL;
  const response = await fetchImpl(activityUrl, {
    method: "GET",
    headers: buildQoderActivityHeaders(authStatus, options),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Qoder activity session expired.");
  }
  if (!response.ok) {
    throw new Error(`Qoder activity API returned HTTP ${response.status}.`);
  }
  return normalizeQoderActivityResponse(await response.json(), options);
}

function qoderRequestHeaders(cookieHeader, site) {
  return {
    Cookie: cookieHeader,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": QODER_USER_AGENT,
    Origin: site.origin,
    Referer: `${site.origin}/account/usage`,
    "X-Requested-With": "XMLHttpRequest",
    "Bx-V": "2.5.35",
  };
}

async function fetchQoderUsage(cookieHeader, site, fetchImpl) {
  const response = await fetchImpl(site.usageUrl, {
    method: "GET",
    headers: qoderRequestHeaders(cookieHeader, site),
  });
  if (response.status === 401 || response.status === 403) {
    const error = new Error("Qoder login expired. Sign in at qoder.com again.");
    error.code = "AUTH_EXPIRED";
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Qoder usage API returned HTTP ${response.status}.`);
  }
  return normalizeQoderUsageResponse(await response.json());
}

function qoderLogRoots({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  appDir = "Qoder",
  envPrefix = "QODER",
} = {}) {
  const explicitLogRoot = env[`${envPrefix}_LOG_ROOT`];
  if (typeof explicitLogRoot === "string" && explicitLogRoot.trim()) {
    return [path.resolve(explicitLogRoot.trim())];
  }
  const configuredHome = env[`${envPrefix}_HOME`];
  if (typeof configuredHome === "string" && configuredHome.trim()) {
    return [path.join(path.resolve(configuredHome.trim()), "logs")];
  }
  const base = platform === "darwin"
    ? path.join(home, "Library", "Application Support")
    : platform === "win32"
      ? (env.APPDATA || path.join(home, "AppData", "Roaming"))
      : path.join(home, ".config");
  // Qoder Desktop 0.4.x moved its Electron profile from Qoder[CN]/ to the
  // bundle id directory and writes the account usage summary to main.log.
  const bundleId = appDir === "QoderCN" || envPrefix === "QODER_CN"
    ? "com.qodercn.app.stable"
    : "com.qoder.app.stable";
  return [
    path.join(base, appDir, "logs"),
    path.join(base, bundleId, "logs"),
  ];
}

function listRecentQoderLogs(logRoot, maxFiles = QODER_LOG_MAX_FILES) {
  if (!fs.existsSync(logRoot)) return [];
  const files = [];
  const stack = [{ dir: logRoot, depth: 0 }];
  while (stack.length > 0 && files.length < 2000) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < 4) {
        stack.push({ dir: full, depth: current.depth + 1 });
      } else if (entry.isFile() && (entry.name === "main.log" || entry.name === "renderer.log")) {
        let mtimeMs = 0;
        let size = 0;
        try {
          const stat = fs.statSync(full);
          mtimeMs = stat.mtimeMs;
          size = stat.size;
        } catch (_error) {}
        files.push({ full, mtimeMs, size });
      }
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);
}

// Returns a parse hit, or null after a completed scan with no hit; undefined
// means the scan itself failed (open/read) so callers must not treat it as
// "no summary".
function scanQoderLogFromEnd(logPath, parse, {
  maxBytes = QODER_LOG_SCAN_MAX_BYTES,
  chunkBytes = QODER_LOG_SCAN_CHUNK_BYTES,
  overlapBytes = QODER_LOG_SCAN_OVERLAP_BYTES,
} = {}) {
  let fd;
  try {
    fd = fs.openSync(logPath, "r");
  } catch (_error) {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const floor = Math.max(0, size - maxBytes);
    let end = size;
    let carry = "";
    while (end > floor) {
      const start = Math.max(floor, end - chunkBytes);
      const length = end - start;
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, start);
      const text = buffer.subarray(0, read).toString("utf8") + carry;
      const parsed = parse(text);
      if (parsed) return parsed;
      // Keep this chunk's head so a line split across the boundary parses
      // when the previous chunk is prepended.
      carry = text.slice(0, overlapBytes);
      end = start;
    }
  } catch (_error) {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

function parseQoderAccountUsageLog(text, { fallbackObservedAtMs = null } = {}) {
  if (typeof text !== "string" || !text.includes('"qoderUsage"')) return null;
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"qoderUsage"')) continue;
    const jsonStart = line.indexOf('{"') >= 0 ? line.indexOf('{"') : line.indexOf("{");
    if (jsonStart < 0) continue;
    let payload;
    try {
      payload = JSON.parse(line.slice(jsonStart));
    } catch (_error) {
      try {
        payload = JSON.parse(line.slice(jsonStart, line.lastIndexOf("}") + 1));
      } catch (_error2) {
        continue;
      }
    }
    const usage = payload?.qoderUsage;
    if (!usage || typeof usage !== "object") continue;
    let limits;
    try {
      limits = normalizeQoderRpcUsage({
        userType: usage.userType,
        expiresAt: usage.expiresAt,
        isQuotaExceeded: usage.isQuotaExceeded,
        totalUsagePercentage: usage.totalUsagePercentage,
        userQuota: usage.userQuota,
        addOnQuota: usage.addOnQuota,
      });
    } catch (_error) {
      continue;
    }
    if (!limits) continue;
    limits.source = "local-log";
    const timestampMatch = /^\[([^\]]+)\]/.exec(line);
    const lineObservedAtMs = timestampMatch ? Date.parse(timestampMatch[1]) : NaN;
    return {
      limits,
      observedAtMs: Number.isFinite(lineObservedAtMs) ? lineObservedAtMs : fallbackObservedAtMs,
      // The summary's own timestamp, or null when the line carries no parseable
      // one and observedAtMs fell back to the file mtime. Callers that order
      // this snapshot against other sources must use it, not observedAtMs: an
      // mtime bump from an unrelated append would otherwise masquerade as a
      // fresh observation.
      lineObservedAtMs: Number.isFinite(lineObservedAtMs) ? lineObservedAtMs : null,
    };
  }
  return null;
}

function parseQoderQuotaLog(text) {
  if (typeof text !== "string" || !text) return null;
  const matches = Array.from(text.matchAll(
    /userType=([^,\s]+)[\s\S]*?isQuotaExceeded=(true|false)[\s\S]*?userQuota(?:=|\s+)used=([0-9.]+),\s*total=([0-9.]+),\s*remaining=([0-9.]+),\s*percentage=([0-9.]+),\s*unit=([^,\s]+)/g,
  ));
  const match = matches.at(-1);
  if (!match) return null;
  const quotaExceeded = match[2] === "true";
  const used = Number(match[3]);
  const total = Number(match[4]);
  const remaining = Number(match[5]);
  const percentage = Number(match[6]);
  if (![used, total, remaining, percentage].every(Number.isFinite)) return null;
  return {
    configured: true,
    error: null,
    plan_label: match[1],
    quota_exceeded: quotaExceeded,
    primary_window: {
      used_percent: total === 0
        ? 0
        : quotaExceeded
          ? 100
          : Math.max(0, Math.min(100, percentage)),
      reset_at: null,
      used_credits: used,
      limit_credits: total,
      remaining_credits: remaining,
      unit: match[7],
    },
    source: "local-log",
  };
}

// Maps a log path to its "size:mtimeMs" signature from the last completed
// scan that found no usable summary (failed I/O is never recorded). Qoder
// only appends to these logs, so an unchanged signature cannot have gained
// one; pruning to the current candidate set keeps the map bounded.
const qoderNoSummaryScans = new Map();

function readQoderLocalQuotaWithAge({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  appDir = "Qoder",
  envPrefix = "QODER",
  nowMs = Date.now(),
  maxAgeMs = QODER_LOG_MAX_AGE_MS,
  olderThanMs = -Infinity,
} = {}) {
  const candidates = [];
  for (const logRoot of qoderLogRoots({ home, platform, env, appDir, envPrefix })) {
    for (const entry of listRecentQoderLogs(logRoot)) {
      if (nowMs - entry.mtimeMs > maxAgeMs) continue;
      // A file last written at or before the cache snapshot cannot hold an
      // observation newer than it (a line's time never exceeds the file
      // mtime), so scanning it could never win the timestamp comparison.
      if (entry.mtimeMs <= olderThanMs) continue;
      candidates.push(entry);
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanned = candidates.slice(0, QODER_LOG_MAX_FILES);
  const seenPaths = new Set();
  for (const { full, mtimeMs, size } of scanned) {
    seenPaths.add(full);
    const signature = `${size}:${mtimeMs}`;
    if (qoderNoSummaryScans.get(full) === signature) continue;
    // A stale modern summary must not end the scan: fall through so a legacy
    // match in the same chunk — or deeper — can still be used; only a fresh
    // modern result returns early.
    const parsed = scanQoderLogFromEnd(full, (text) => {
      const accountUsage = parseQoderAccountUsageLog(text, { fallbackObservedAtMs: mtimeMs });
      if (accountUsage && nowMs - (accountUsage.observedAtMs ?? mtimeMs) <= maxAgeMs) {
        return accountUsage;
      }
      const legacy = parseQoderQuotaLog(text);
      return legacy ? { limits: legacy, observedAtMs: mtimeMs, lineObservedAtMs: null } : null;
    });
    if (parsed === undefined) continue; // Scan failed (I/O); retry on the next call.
    if (!parsed) {
      qoderNoSummaryScans.set(full, signature);
      continue;
    }
    const observedAtMs = parsed.observedAtMs ?? mtimeMs;
    if (nowMs - observedAtMs > maxAgeMs) continue;
    return { limits: parsed.limits, lineObservedAtMs: parsed.lineObservedAtMs ?? null };
  }
  for (const cachedPath of qoderNoSummaryScans.keys()) {
    if (!seenPaths.has(cachedPath)) qoderNoSummaryScans.delete(cachedPath);
  }
  return null;
}

function readQoderLocalQuota(options = {}) {
  return readQoderLocalQuotaWithAge(options)?.limits ?? null;
}

function siteFromEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "cn" || normalized === "china" || normalized.includes(".cn")
    ? QODER_SITES.china
    : QODER_SITES.international;
}

async function fetchQoderLimits({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  appDir = "Qoder",
  envPrefix = "QODER",
  site = QODER_SITES.international,
  sitePinned = false,
  cacheNamespace,
  fetchImpl = fetch,
  rpcRequest = qoderRpcRequest,
  nowMs = Date.now(),
  cliLimitsRequest,
} = {}) {
  let rpcUsage = null;
  let rpcAuth = null;
  let activityWindow = null;
  let activitySource = null;
  const rpcOptions = { home, env, platform, appDir, envPrefix };
  // Qoder's shared client accepts only one reliable request at a time. Parallel
  // connections intermittently time out even while the desktop app is running.
  try {
    rpcUsage = normalizeQoderRpcUsage(await rpcRequest("credit/usage", {}, rpcOptions));
  } catch (_error) {}
  try {
    const authResult = await rpcRequest("auth/status", {}, rpcOptions);
    if (authResult && typeof authResult === "object") rpcAuth = authResult;
  } catch (_error) {}
  if (rpcAuth) {
    try {
      activityWindow = await fetchQoderActivity(rpcAuth, fetchImpl, { nowMs, activityUrl: site.activityUrl });
      if (activityWindow) {
        activitySource = "provider-api";
        writeQoderActivityCache(activityWindow, { home, nowMs, namespace: cacheNamespace });
      }
    } catch (_error) {}
  }
  // Qoder's activity endpoint occasionally succeeds with an empty activities
  // array while the promotion is still active. Treat that as a transient
  // omission, not an authoritative deletion: an activity carries its own
  // expiry, so the last observed window remains valid until reset_at.
  if (!activityWindow) {
    activityWindow = readQoderActivityCache({ home, nowMs, namespace: cacheNamespace });
    if (activityWindow) activitySource = "disk-cache";
  }
  if (rpcUsage) {
    if (!rpcUsage.plan_label && typeof rpcAuth?.userType === "string") {
      rpcUsage.plan_label = rpcAuth.userType;
    }
    if (activityWindow) rpcUsage.secondary_window = activityWindow;
    rpcUsage.source = activityWindow
      ? `local-ipc+${activitySource === "disk-cache" ? "cached-activity" : "provider-api"}`
      : "local-ipc";
    writeQoderLimitsCache(rpcUsage, { home, nowMs, namespace: cacheNamespace });
    return rpcUsage;
  }

  let cliError = null;
  if (cliLimitsRequest) {
    try {
      const cliUsage = await cliLimitsRequest({ home, env, fetchImpl, normalizeRpcUsage: normalizeQoderRpcUsage });
      if (cliUsage) {
        if (activityWindow) cliUsage.secondary_window = activityWindow;
        writeQoderLimitsCache(cliUsage, { home, nowMs, namespace: cacheNamespace });
        return cliUsage;
      }
    } catch (error) {
      cliError = error;
    }
  }

  // A 0.4.x desktop app refreshes its main.log summary whenever the account
  // page reloads, so the newest line can be newer than the last-good cache.
  // Compare the summary's own timestamp against the cache instead of always
  // trusting the cache: only a parseable line timestamp may win, and files
  // last written before the cache are skipped without a scan. Once neither a
  // fresh line nor a valid cache exists, fall through to the manual-cookie
  // session (the only remaining remote source) before giving up.
  const cachedLimits = readQoderLimitsCache({ home, nowMs, namespace: cacheNamespace });
  const cachedAtMs = Date.parse(cachedLimits?.cached_at || "");
  const cacheFloorMs = Number.isFinite(cachedAtMs) ? cachedAtMs : -Infinity;
  const localScan = readQoderLocalQuotaWithAge({
    home,
    platform,
    env,
    appDir,
    envPrefix,
    nowMs,
    olderThanMs: cacheFloorMs,
  });
  if (localScan && (localScan.lineObservedAtMs ?? 0) > cacheFloorMs) {
    const local = localScan.limits;
    if (activityWindow) {
      local.secondary_window = activityWindow;
      local.source += activitySource === "disk-cache" ? "+cached-activity" : "+activity";
    }
    writeQoderLimitsCache(local, { home, nowMs, namespace: cacheNamespace });
    return local;
  }
  if (cachedLimits) {
    if (activityWindow) cachedLimits.secondary_window = activityWindow;
    return cachedLimits;
  }

  // Manual-cookie fallback reads an envPrefix-specific key: QODER_COOKIE for
  // the international flow, QODER_CN_COOKIE for the CN flow — the two installs
  // hold different sessions and must never share a cookie.
  const cookieKey = `${envPrefix}_COOKIE`;
  const manualCookie = typeof env[cookieKey] === "string" ? env[cookieKey].trim() : "";
  // QODER_SITE is an international-flow knob. A pinned site (the CN fetch)
  // must never be overridden by it — the CN flow always targets china.
  const manualSite = sitePinned ? site : env.QODER_SITE ? siteFromEnv(env.QODER_SITE) : site;
  const sessions = manualCookie
    ? [{
        cookieHeader: manualCookie,
        site: manualSite,
        sourceLabel: cookieKey,
      }]
    : [];

  let lastError = cliError;
  for (const session of sessions) {
    try {
      const result = await fetchQoderUsage(session.cookieHeader, session.site, fetchImpl);
      if (activityWindow) {
        result.secondary_window = activityWindow;
        result.source += activitySource === "disk-cache" ? "+cached-activity" : "+activity";
      }
      const liveResult = {
        ...result,
        cookie_source: session.sourceLabel,
        site: session.site.id,
      };
      writeQoderLimitsCache(liveResult, { home, nowMs, namespace: cacheNamespace });
      return liveResult;
    } catch (error) {
      lastError = error;
    }
  }

  if (activityWindow) {
    return {
      configured: true,
      error: null,
      plan_label: typeof rpcAuth?.userType === "string" ? rpcAuth.userType : null,
      primary_window: null,
      secondary_window: activityWindow,
      source: activitySource === "disk-cache" ? "cached-activity" : "local-ipc+provider-api",
    };
  }
  if (lastError) {
    return {
      configured: true,
      error: lastError.message || "Qoder usage fetch failed.",
      auth_action_required: lastError.code === "AUTH_EXPIRED" ? "reauth" : undefined,
    };
  }
  return { configured: false };
}

// CN has its own CLI credentials, legacy desktop root and cache namespace.
function fetchQoderCnLimits(opts = {}) {
  return fetchQoderLimits({
    ...opts,
    appDir: "QoderCN",
    envPrefix: "QODER_CN",
    site: QODER_SITES.china,
    sitePinned: true,
    cacheNamespace: "cn",
    cliLimitsRequest: fetchQoderCnCliLimits,
  });
}

module.exports = {
  QODER_SITES,
  normalizeQoderUsageResponse,
  normalizeQoderRpcUsage,
  normalizeQoderActivityResponse,
  qoderRequestHeaders,
  fetchQoderUsage,
  qoderRpcRequest,
  buildQoderActivityHeaders,
  fetchQoderActivity,
  readQoderActivityCache,
  writeQoderActivityCache,
  readQoderLimitsCache,
  writeQoderLimitsCache,
  parseQoderQuotaLog,
  parseQoderAccountUsageLog,
  readQoderLocalQuota,
  fetchQoderLimits,
  fetchQoderCnLimits,
};
