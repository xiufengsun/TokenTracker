const DEFAULTS = {
  intervalMs: 30 * 60_000,
  jitterMsMax: 60_000,
  backlogBytes: 1_000_000,
  batchSize: 300,
  maxBatchesSmall: 2,
  maxBatchesLarge: 4,
  backoffInitialMs: 60_000,
  backoffMaxMs: 30 * 60_000,
};

function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    lastSuccessMs: toSafeInt(s.lastSuccessMs),
    lastSuccessAttemptId: typeof s.lastSuccessAttemptId === "string" ? s.lastSuccessAttemptId : null,
    nextAllowedAtMs: toSafeInt(s.nextAllowedAtMs),
    serverNextAllowedAtMs: toSafeInt(s.serverNextAllowedAtMs),
    backoffUntilMs: toSafeInt(s.backoffUntilMs),
    backoffStep: toSafeInt(s.backoffStep),
    lastErrorAt: typeof s.lastErrorAt === "string" ? s.lastErrorAt : null,
    lastError: typeof s.lastError === "string" ? s.lastError : null,
    lastErrorStatus: toSafeInt(s.lastErrorStatus),
    lastErrorCode: typeof s.lastErrorCode === "string" ? s.lastErrorCode : null,
    lastErrorAttemptId: typeof s.lastErrorAttemptId === "string" ? s.lastErrorAttemptId : null,
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : null,
  };
}

function decideAutoUpload({ nowMs, pendingBytes, state, config }) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const s = normalizeState(state);
  const pending = Number(pendingBytes || 0);

  if (pending <= 0) {
    return {
      allowed: false,
      reason: "no-pending",
      maxBatches: 0,
      batchSize: cfg.batchSize,
      blockedUntilMs: 0,
    };
  }

  const blockedUntilMs = Math.max(s.nextAllowedAtMs || 0, s.backoffUntilMs || 0);
  if (blockedUntilMs > 0 && nowMs < blockedUntilMs) {
    return {
      allowed: false,
      reason: "throttled",
      maxBatches: 0,
      batchSize: cfg.batchSize,
      blockedUntilMs,
    };
  }

  const maxBatches = pending >= cfg.backlogBytes ? cfg.maxBatchesLarge : cfg.maxBatchesSmall;
  return {
    allowed: true,
    reason: "allowed",
    maxBatches,
    batchSize: cfg.batchSize,
    blockedUntilMs: 0,
  };
}

function recordUploadSuccess({ nowMs, state, config, randInt, cloudAccess, attemptId }) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const s = normalizeState(state);
  const jitter =
    typeof randInt === "function" ? randInt(0, cfg.jitterMsMax) : randomInt(0, cfg.jitterMsMax);
  const serverNextAllowedAtMs = toSafeInt(Date.parse(cloudAccess?.next_allowed_at));
  const rawInterval = cloudAccess?.sync_interval_seconds;
  const seconds = typeof rawInterval === "number" ? rawInterval
    : typeof rawInterval === "string" && /^\d+$/.test(rawInterval.trim()) ? Number(rawInterval) : NaN;
  const intervalMs = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) * 1000 : cfg.intervalMs;
  const nextAllowedAtMs = Math.max(serverNextAllowedAtMs, nowMs + intervalMs + jitter);

  return {
    ...s,
    lastSuccessMs: nowMs,
    lastSuccessAttemptId: typeof attemptId === "string" && attemptId ? attemptId : null,
    nextAllowedAtMs,
    serverNextAllowedAtMs,
    backoffUntilMs: 0,
    backoffStep: 0,
    lastErrorAt: null,
    lastError: null,
    lastErrorStatus: 0,
    lastErrorCode: null,
    lastErrorAttemptId: null,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function recordUploadFailure({ nowMs, state, error, config, attemptId }) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const s = normalizeState(state);

  const retryAfterMs = toSafeInt(error?.retryAfterMs);
  const status = toSafeInt(error?.status);

  let backoffMs = 0;
  if (retryAfterMs > 0) {
    // Retry-After is the server's deadline. The configured cap applies only
    // to exponential retries without an explicit server deadline.
    backoffMs = Math.max(cfg.backoffInitialMs, retryAfterMs);
  } else {
    const step = Math.min(10, Math.max(0, s.backoffStep || 0));
    backoffMs = Math.min(cfg.backoffMaxMs, cfg.backoffInitialMs * Math.pow(2, step));
  }

  const backoffUntilMs = nowMs + backoffMs;
  const hasServerDeadline = status === 429 && error?.code === "cloud_sync_throttled" && retryAfterMs > 0;
  const nextAllowedAtMs = hasServerDeadline
    ? backoffUntilMs : Math.max(s.nextAllowedAtMs || 0, backoffUntilMs);

  return {
    ...s,
    nextAllowedAtMs,
    serverNextAllowedAtMs: hasServerDeadline ? backoffUntilMs : s.serverNextAllowedAtMs,
    backoffUntilMs,
    backoffStep: Math.min(20, (s.backoffStep || 0) + 1),
    lastErrorAt: new Date(nowMs).toISOString(),
    lastError: truncate(String(error?.message || "upload failed"), 200),
    lastErrorStatus: status,
    lastErrorCode: typeof error?.code === "string" ? error.code : null,
    lastErrorAttemptId: typeof attemptId === "string" && attemptId ? attemptId : null,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (typeof headerValue !== "string" || headerValue.trim().length === 0) return null;
  const v = headerValue.trim();
  const seconds = Number(v);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const delta = d.getTime() - nowMs;
  return delta > 0 ? delta : 0;
}

function randomInt(min, maxInclusive) {
  const lo = Math.floor(min);
  const hi = Math.floor(maxInclusive);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function toSafeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  return Math.floor(n);
}

function truncate(s, maxLen) {
  if (typeof s !== "string") return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

module.exports = {
  DEFAULTS,
  normalizeState,
  decideAutoUpload,
  recordUploadSuccess,
  recordUploadFailure,
  parseRetryAfterMs,
};
