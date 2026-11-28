"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { parseBearerToken } = require("./bearer-token");

const WINDOWS = [
  ["primary_window", "weekly", "weekly", "Weekly"],
  ["secondary_window", "5h", "session", "5-hour"],
  ["tertiary_window", "total", "other", "Total"],
];

function tokenDigest(value) {
  return createHash("sha256").update(value).digest();
}

function t3QuotaSourceConfig(env) {
  const token = env.TOKENTRACKER_T3_QUOTA_TOKEN?.trim();
  if (!token || token.length < 32 || /\s/.test(token)) return null;
  return {
    tokenHash: tokenDigest(token),
    providerInstanceId: env.TOKENTRACKER_T3_QUOTA_INSTANCE?.trim() || null,
  };
}

function isT3QuotaAuthorized(header, config) {
  const token = parseBearerToken(header);
  return Boolean(token && timingSafeEqual(tokenDigest(token), config.tokenHash));
}

function buildT3QuotaResponse(kimi, providerInstanceId, now = Date.now()) {
  const provenance = kimi?.provenance;
  const capturedAt = Date.parse(provenance?.captured_at);
  // T3's v1 schema has no field for stale data. Do not present last-good
  // values or a window from before a known reset as a current reading.
  if (kimi?.configured !== true || kimi.error || kimi.stale || provenance?.stale ||
      !Number.isFinite(capturedAt) || now - capturedAt > 3 * 60 * 1000) return null;

  const windows = [];
  for (const [field, id, kind, label] of WINDOWS) {
    const reading = kimi[field];
    const usedPercent = reading?.used_percent;
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    const reset = Date.parse(reading.reset_at);
    if (Number.isFinite(reset) && reset <= now) continue;
    windows.push({ id, kind, label, usedPercent, ...(Number.isFinite(reset) && { resetsAt: new Date(reset).toISOString() }) });
  }
  if (!windows.length) return null;
  return {
    version: 1,
    accounts: [{
      id: "kimi",
      label: "Kimi Coding (Token Tracker)",
      ...(providerInstanceId && { providerInstanceId }),
      windows,
    }],
  };
}

module.exports = { t3QuotaSourceConfig, isT3QuotaAuthorized, buildT3QuotaResponse };
