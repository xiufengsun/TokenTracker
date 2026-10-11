const DEFAULT_BASE_URL = "https://srctyff5.us-east.insforge.app";
// InsForge projects this product has retired. b46ug8xu was production until
// the 2026-04-19 migration to srctyff5 (0.5.67, commit 73f461b8); init
// preserves any persisted config.baseUrl, so installs initialized before the
// migration stayed pinned to it and kept uploading there until the old
// project's backend went dark on 2026-07-27 (HTTP 503 on every request).
// Persisted values naming these hosts must fall back to the current default.
const LEGACY_INSFORGE_HOSTS = new Set(["b46ug8xu.us-east.insforge.app"]);
const DEFAULT_DASHBOARD_URL = "https://www.tokentracker.cc";
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
// Public InsForge anon key (JWT, role=anon). Mirrors dashboard/src/lib/insforge-config.ts
// (PROD_INSFORGE_ANON_KEY) — public by design (ships in the browser bundle and
// appears in .github/workflows/*.yml). The local server needs it to call the
// cross-device `tokentracker-account-*` edge functions on the popover's behalf.
// (Previously this mistakenly used the full-access `ik_*` API key, which has
// admin access and must never be shipped to clients.)
const DEFAULT_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDU5NDd9.T0auta_IrVIh0uXW1bob5QSnzvsnJmN28r5XkSGEuQY";

function resolveRuntimeConfig({ cli = {}, config = {}, env = process.env, defaults = {} } = {}) {
  // Older Windows test runs could leak their fixture HOME and persist
  // https://example.invalid into the user's real config.json. The test
  // isolation bug is fixed, but existing installs must recover instead of
  // backing off cloud uploads forever against the reserved placeholder host.
  const persistedBaseUrl = normalizePersistedBaseUrl(config.baseUrl);
  const baseUrl = pickString(
    cli.baseUrl,
    persistedBaseUrl,
    env?.TOKENTRACKER_INSFORGE_BASE_URL,
    defaults.baseUrl,
    DEFAULT_BASE_URL,
  );
  const selectedBase = normalizeInstanceBaseUrl(baseUrl.value);
  const configBase = normalizeInstanceBaseUrl(persistedBaseUrl || DEFAULT_BASE_URL);
  const envBase = normalizeInstanceBaseUrl(env?.TOKENTRACKER_INSFORGE_BASE_URL || baseUrl.value);
  const defaultBase = normalizeInstanceBaseUrl(defaults.baseUrl || DEFAULT_BASE_URL);
  const custom = selectedBase !== DEFAULT_BASE_URL;
  const anonKey = pickString(
    cli.anonKey,
    configBase === selectedBase ? config.anonKey : undefined,
    envBase === selectedBase ? env?.TOKENTRACKER_INSFORGE_ANON_KEY : undefined,
    defaultBase === selectedBase ? defaults.anonKey : undefined,
    custom ? null : DEFAULT_ANON_KEY,
  );
  const dashboardUrl = pickString(
    cli.dashboardUrl,
    configBase === selectedBase ? config.dashboardUrl : undefined,
    envBase === selectedBase ? env?.TOKENTRACKER_DASHBOARD_URL : undefined,
    defaultBase === selectedBase ? defaults.dashboardUrl : undefined,
    custom ? baseUrl.value : DEFAULT_DASHBOARD_URL,
  );
  const deviceToken = pickString(
    cli.deviceToken,
    configBase === selectedBase && (!custom || normalizeInstanceBaseUrl(config.deviceTokenBaseUrl) === selectedBase)
      ? config.deviceToken : undefined,
    envBase === selectedBase && (!custom || normalizeInstanceBaseUrl(env?.TOKENTRACKER_INSFORGE_BASE_URL) === selectedBase)
      ? env?.TOKENTRACKER_DEVICE_TOKEN : undefined,
    defaultBase === selectedBase ? defaults.deviceToken : undefined,
    null,
  );
  const httpTimeoutMs = pickHttpTimeoutMs(
    cli.httpTimeoutMs,
    config.httpTimeoutMs,
    env?.TOKENTRACKER_HTTP_TIMEOUT_MS,
    defaults.httpTimeoutMs,
    DEFAULT_HTTP_TIMEOUT_MS,
  );
  const debug = pickBoolean(cli.debug, config.debug, env?.TOKENTRACKER_DEBUG, defaults.debug, false);
  const autoRetryNoSpawn = pickBoolean(
    cli.autoRetryNoSpawn,
    config.autoRetryNoSpawn,
    env?.TOKENTRACKER_AUTO_RETRY_NO_SPAWN,
    defaults.autoRetryNoSpawn,
    false,
  );

  const unsafeKey = anonKey.value && (!isPublicAnonKey(anonKey.value) || (custom && anonKey.value === DEFAULT_ANON_KEY));
  const configurationError = !selectedBase ? "invalid_insforge_base_url"
    : !normalizeInstanceBaseUrl(dashboardUrl.value) ? "invalid_dashboard_url"
    : unsafeKey ? "invalid_insforge_anon_key"
    : custom && !anonKey.value ? "custom_insforge_anon_key_required" : null;
  return {
    baseUrl: selectedBase || baseUrl.value,
    anonKey: unsafeKey ? null : anonKey.value,
    dashboardUrl: dashboardUrl.value,
    deviceToken: configurationError ? null : deviceToken.value,
    httpTimeoutMs: httpTimeoutMs.value,
    debug: debug.value,
    autoRetryNoSpawn: autoRetryNoSpawn.value,
    configurationError,
    sources: {
      baseUrl: baseUrl.source,
      anonKey: anonKey.source,
      dashboardUrl: dashboardUrl.source,
      deviceToken: deviceToken.source,
      httpTimeoutMs: httpTimeoutMs.source,
      debug: debug.source,
      autoRetryNoSpawn: autoRetryNoSpawn.source,
    },
  };
}

function normalizeInstanceBaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) return null;
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

function isPublicAnonKey(value) {
  try {
    if (typeof value !== "string") return false;
    const key = value.trim();
    if (key.startsWith("ik_")) return false;
    if (/^anon_(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(key)) return true;
    const parts = key.split(".");
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role === "anon";
  } catch { return false; }
}

function assertInsforgeRuntime(runtime) {
  if (!runtime?.configurationError) return runtime;
  const messages = {
    invalid_insforge_base_url: "InsForge URL must use HTTPS, or HTTP on localhost, without credentials, query or fragment.",
    invalid_insforge_anon_key: "Use this instance's public anon key. Admin and service keys cannot be used by the client.",
    invalid_dashboard_url: "Dashboard URL must use HTTPS, or HTTP on localhost, without credentials, query or fragment.",
    custom_insforge_anon_key_required: "A custom InsForge URL requires its own public anon key. Configure --anon-key-file or TOKENTRACKER_INSFORGE_ANON_KEY.",
  };
  throw Object.assign(new Error(messages[runtime.configurationError] || "Invalid InsForge configuration"), {
    code: runtime.configurationError, status: 503,
  });
}

function clearDeviceIdentity(config) {
  const next = { ...config };
  for (const key of ["deviceToken", "deviceTokenBaseUrl", "deviceId", "user_id", "device_login_at"]) delete next[key];
  return next;
}

function resetInstanceState(trackerDir) {
  const fs = require("node:fs");
  const path = require("node:path");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "queue.state.json"), JSON.stringify({ offset: 0, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  for (const file of ["relay-cookies.json", "cloud-device-token.json", "cloud-upload-owner.json", "upload.throttle.json", "link_code_state.json"]) {
    try { fs.unlinkSync(path.join(trackerDir, file)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function pickString(...candidates) {
  return pickValue(candidates, normalizeString);
}

function pickBoolean(...candidates) {
  return pickValue(candidates, normalizeBoolean);
}

function pickHttpTimeoutMs(...candidates) {
  return pickValue(candidates, normalizeHttpTimeoutMs);
}

function pickValue(candidates, normalize) {
  const labels = ["cli", "config", "env", "default", "default"];
  for (let i = 0; i < candidates.length; i += 1) {
    const value = normalize(candidates[i]);
    if (value !== undefined) {
      return { value, source: labels[i] || "default" };
    }
  }
  return { value: null, source: "default" };
}

function normalizeString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function normalizePersistedBaseUrl(value) {
  const normalized = normalizeString(value);
  if (normalized === undefined) return undefined;
  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    if (hostname === "example.invalid") return undefined;
    if (LEGACY_INSFORGE_HOSTS.has(hostname)) return undefined;
  } catch {
    // Preserve the existing resolver behavior for arbitrary custom values.
  }
  return normalized;
}

// True when the value points at a retired InsForge project (dead backend).
// Callers use this to trigger the one-time config repair in sync.
function isLegacyInsforgeBaseUrl(value) {
  const normalized = normalizeString(value);
  if (normalized === undefined) return false;
  try {
    return LEGACY_INSFORGE_HOSTS.has(new URL(normalized).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (trimmed === "1" || trimmed === "true") return true;
    if (trimmed === "0" || trimmed === "false") return false;
  }
  return undefined;
}

function normalizeHttpTimeoutMs(value) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return 0;
  return clampInt(n, 1000, 120_000);
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_ANON_KEY,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_HTTP_TIMEOUT_MS,
  resolveRuntimeConfig,
  isLegacyInsforgeBaseUrl,
  normalizeInstanceBaseUrl,
  isPublicAnonKey,
  assertInsforgeRuntime,
  clearDeviceIdentity,
  resetInstanceState,
};
