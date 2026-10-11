const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { readJson } = require("./fs");
const { readSqliteFirstValue } = require("./sqlite-reader");

// ── Path resolution ──

function resolveCursorPaths({ home, platform = process.platform, env = process.env } = {}) {
  const h = home || os.homedir();
  const pathForPlatform = platform === "win32" ? path.win32 : path.posix;
  let appDir;
  if (platform === "darwin") {
    appDir = pathForPlatform.join(h, "Library", "Application Support", "Cursor");
  } else if (platform === "win32") {
    const appData =
      ((!home || h === os.homedir() || env !== process.env) &&
        typeof env.APPDATA === "string" && env.APPDATA.trim()) ||
      pathForPlatform.join(h, "AppData", "Roaming");
    appDir = pathForPlatform.join(appData, "Cursor");
  } else {
    const xdg =
      (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
      pathForPlatform.join(h, ".config");
    appDir = pathForPlatform.join(xdg, "Cursor");
  }
  return {
    appDir,
    stateDbPath: pathForPlatform.join(appDir, "User", "globalStorage", "state.vscdb"),
    cliConfigPath: pathForPlatform.join(h, ".cursor", "cli-config.json"),
  };
}

function isCursorInstalled({ home, platform, env } = {}) {
  const { appDir } = resolveCursorPaths({ home, platform, env });
  try {
    return fs.statSync(appDir).isDirectory();
  } catch {
    return false;
  }
}

// ── Auth token extraction ──

const CURSOR_ACCESS_TOKEN_SQL =
  "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';";

function cursorDebugLog(message, env = process.env) {
  const dbg = String((env && env.TOKENTRACKER_DEBUG) || "").toLowerCase();
  if (dbg === "1" || dbg === "true") {
    process.stderr.write(`[cursor] ${message}\n`);
  }
}

function readCursorAccessTokenFromStateDb(stateDbPath, deps = {}) {
  return readSqliteFirstValue(stateDbPath, CURSOR_ACCESS_TOKEN_SQL, "value", {
    execFileSync: deps.execFileSync,
    requireFn: deps.requireFn,
    env: deps.env,
    stderr: deps.stderr,
    label: "Cursor",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Extract Cursor session cookie from local SQLite + cli-config.json.
 * Returns { cookie, userId } or null on failure.
 *
 * Cookie format: WorkosCursorSessionToken=<userId>%3A%3A<jwt>
 * - JWT from state.vscdb → ItemTable → cursorAuth/accessToken
 * - userId from cli-config.json → authInfo.authId
 *   - native Cursor email/password: "auth0|user_XXXXX"        → "user_XXXXX"
 *   - Google sign-in via WorkOS:    "google-oauth2|<numeric>" → kept verbatim
 *   - other WorkOS subjects:        "github|…", "oidc|…"      → kept verbatim
 */
function extractCursorSessionToken({ home, platform, env, deps } = {}) {
  const auth = extractCursorAuth({ home, platform, env, deps });
  if (!auth) return null;
  return { cookie: auth.cookie, userId: auth.userId };
}

/**
 * Extract the Cursor web session and API bearer token from Cursor's own local
 * login state. The raw access token is needed for Cursor's first-party Connect
 * RPCs, while callers that only need the web cookie should continue using
 * extractCursorSessionToken so the token is not propagated unnecessarily.
 */
function extractCursorAuth({ home, platform, env, deps } = {}) {
  const { stateDbPath, cliConfigPath } = resolveCursorPaths({ home, platform, env });

  // 1. Extract JWT from SQLite
  if (!fs.existsSync(stateDbPath)) {
    cursorDebugLog(`Cursor state DB not found at ${stateDbPath}`, deps?.env);
    return null;
  }
  const jwt = readCursorAccessTokenFromStateDb(stateDbPath, deps);
  if (!jwt || jwt.length < 10) return null;

  // 2. Extract userId — try cli-config.json first, fall back to JWT decode
  let userId = extractUserIdFromCliConfig(cliConfigPath);
  if (!userId) {
    userId = extractUserIdFromJwt(jwt);
  }
  if (!userId) return null;

  // 3. Build cookie
  const cookie = `WorkosCursorSessionToken=${userId}%3A%3A${jwt}`;
  return { cookie, userId, accessToken: jwt };
}

// WorkOS OAuth subject prefixes Cursor accepts as-is in the session cookie.
// Verified against cursor.com/api/usage-summary (issue #88).
const WORKOS_OAUTH_SUBJECT_RE = /^(google-oauth2|github|oidc|auth0)\|[^|]+$/;

function normalizeCursorSubject(subject) {
  if (!subject) return null;
  // Native Cursor: "auth0|user_XXXXX" → strip provider prefix, return "user_XXXXX"
  const native = subject.match(/\|(user_[A-Za-z0-9_]+)$/);
  if (native) return native[1];
  // WorkOS-bridged OAuth: keep the full "<provider>|<id>" subject
  if (WORKOS_OAUTH_SUBJECT_RE.test(subject)) return subject;
  return null;
}

function extractUserIdFromCliConfig(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return normalizeCursorSubject(config?.authInfo?.authId || "");
  } catch {
    return null;
  }
}

function extractUserIdFromJwt(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return normalizeCursorSubject(payload.sub || "");
  } catch {
    return null;
  }
}

// ── API client ──

const CURSOR_CSV_URL = "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";
const CURSOR_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const CURSOR_RPC_ORIGIN = "https://api2.cursor.sh";
const CURSOR_SAND_ACCESS_URL = `${CURSOR_RPC_ORIGIN}/aiserver.v1.DashboardService/GetSandAccessStatus`;
const CURSOR_SAND_USAGE_URL = `${CURSOR_RPC_ORIGIN}/aiserver.v1.DashboardService/GetSandUsageStatus`;
const CURSOR_RPC_MAX_RESPONSE_BYTES = 64 * 1024;
const CURSOR_SOURCE_SCOPE = "account";

function isCursorFetchTimeout(err) {
  return Boolean(err && (err.name === "TimeoutError" || err.name === "AbortError"));
}

function remapCursorFetchTimeout(err) {
  if (isCursorFetchTimeout(err)) {
    throw new Error("Cursor API request timed out");
  }
  throw err;
}

const CURSOR_REDIRECT_HOSTS = new Set(["cursor.com", "www.cursor.com"]);

/**
 * Resolve a redirect `Location` before the session cookie is forwarded to it.
 *
 * The header is attacker-influenced in principle, and the next hop carries the
 * Cursor session cookie, so an off-origin redirect would disclose it. Resolving
 * against the request URL also handles a relative Location, which bare
 * `fetch(location)` would reject.
 */
function resolveCursorRedirect(location, baseUrl) {
  let url;
  try {
    url = new URL(location, baseUrl);
  } catch {
    throw new Error("Cursor API redirect to an untrusted origin");
  }
  if (url.protocol !== "https:" || !CURSOR_REDIRECT_HOSTS.has(url.hostname)) {
    throw new Error("Cursor API redirect to an untrusted origin");
  }
  return url.toString();
}

/**
 * Fetch full usage CSV from Cursor API.
 * Returns raw CSV string or throws on error.
 */
function fetchCursorUsageCsv({ cookie, timeoutMs = 30000, fetchImpl = fetch }) {
  return fetchImpl(CURSOR_CSV_URL, {
    method: "GET",
    headers: {
      Accept: "*/*",
      Cookie: cookie,
      Referer: "https://www.cursor.com/settings",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    if (res.status === 401 || res.status === 403) {
      throw new Error("Cursor session expired — re-login in Cursor to refresh");
    }
    if (res.status === 308 || res.status === 301 || res.status === 302) {
      // Follow redirect once. Keep this hop on redirect:"manual" so the
      // Location + Cookie are forwarded explicitly (cursor.com → www.cursor.com).
      const location = res.headers.get("location");
      if (!location) throw new Error("Cursor API redirect without Location header");
      const target = resolveCursorRedirect(location, CURSOR_CSV_URL);
      return fetchUrlRaw({ urlStr: target, cookie, timeoutMs, fetchImpl });
    }
    if (res.status !== 200) {
      throw new Error(`Cursor API returned ${res.status}`);
    }
    return res.text();
  }).catch(remapCursorFetchTimeout);
}

/**
 * Fetch Cursor usage summary JSON.
 * Returns parsed JSON body or throws on error.
 */
function fetchCursorUsageSummary({ cookie, timeoutMs = 30000, fetchImpl = fetch }) {
  return fetchImpl(CURSOR_SUMMARY_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Referer: "https://www.cursor.com/settings",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    if (res.status === 401 || res.status === 403) {
      throw new Error("Cursor session expired — re-login in Cursor to refresh");
    }
    if (!res.ok) {
      throw new Error(`Cursor API returned ${res.status}`);
    }
    return res.json();
  });
}

function readProtoVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < buffer.length && i < offset + 10; i += 1) {
    const byte = buffer[i];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: i + 1 };
    shift += 7n;
  }
  throw new Error("Cursor API returned malformed protobuf");
}

function readProtoFields(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readProtoVarint(buffer, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x07n);
    if (!Number.isInteger(fieldNumber) || fieldNumber <= 0) {
      throw new Error("Cursor API returned malformed protobuf");
    }
    if (wireType === 0) {
      const decoded = readProtoVarint(buffer, offset);
      fields.push({ fieldNumber, wireType, value: decoded.value });
      offset = decoded.offset;
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error("Cursor API returned malformed protobuf");
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 2) {
      const decodedLength = readProtoVarint(buffer, offset);
      offset = decodedLength.offset;
      const length = Number(decodedLength.value);
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) {
        throw new Error("Cursor API returned malformed protobuf");
      }
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error("Cursor API returned malformed protobuf");
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error("Cursor API returned unsupported protobuf wire type");
    }
  }
  return fields;
}

function protoTimestampToIso(input) {
  let seconds = null;
  let nanos = 0n;
  for (const field of readProtoFields(input)) {
    if (field.fieldNumber === 1 && field.wireType === 0) seconds = field.value;
    if (field.fieldNumber === 2 && field.wireType === 0) nanos = field.value;
  }
  if (seconds === null || nanos < 0n || nanos > 999_999_999n) return null;
  const milliseconds = Number(seconds) * 1000 + Number(nanos) / 1_000_000;
  if (!Number.isFinite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function decodeCursorSandAccessStatus(input) {
  let state = 0;
  let blockReason = 0;
  for (const field of readProtoFields(input)) {
    if (field.fieldNumber === 1 && field.wireType === 0) state = Number(field.value);
    if (field.fieldNumber === 3 && field.wireType === 0) blockReason = Number(field.value);
  }
  return { state, blockReason, granted: state === 1 };
}

function decodeCursorSandUsageStatus(input) {
  const result = {
    currentPeriodStart: null,
    nextResetAt: null,
    usagePercent: null,
    includedLimitZero: false,
    availableBankedResetCount: 0,
    usesPooledEnterpriseAllowance: false,
    hasAvailableUsage: false,
    hasNonZeroIncludedLimit: false,
  };
  for (const field of readProtoFields(input)) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      result.currentPeriodStart = protoTimestampToIso(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      result.nextResetAt = protoTimestampToIso(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 1) {
      result.usagePercent = field.value.readDoubleLE(0);
    } else if (field.fieldNumber === 4 && field.wireType === 0) {
      result.includedLimitZero = field.value !== 0n;
    } else if (field.fieldNumber === 5 && field.wireType === 0) {
      result.availableBankedResetCount = Number(field.value);
    } else if (field.fieldNumber === 6 && field.wireType === 0) {
      result.usesPooledEnterpriseAllowance = field.value !== 0n;
    } else if (field.fieldNumber === 7 && field.wireType === 0) {
      result.hasAvailableUsage = field.value !== 0n;
    } else if (field.fieldNumber === 8 && field.wireType === 0) {
      result.hasNonZeroIncludedLimit = field.value !== 0n;
    }
  }
  if (!Number.isFinite(result.usagePercent)) result.usagePercent = null;
  return result;
}

async function fetchCursorProtoRpc({ url, accessToken, timeoutMs = 15000, fetchImpl = fetch }) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
    },
    body: Buffer.alloc(0),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Cursor session expired — re-login in Cursor to refresh");
  }
  if (res.status !== 200) throw new Error(`Cursor API returned ${res.status}`);
  const contentType = String(res.headers?.get?.("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/proto")) {
    throw new Error("Cursor API returned an unexpected response type");
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > CURSOR_RPC_MAX_RESPONSE_BYTES) {
    throw new Error("Cursor API returned an oversized response");
  }
  return body;
}

async function fetchCursorSandAccessStatus({ accessToken, timeoutMs, fetchImpl = fetch }) {
  const body = await fetchCursorProtoRpc({
    url: CURSOR_SAND_ACCESS_URL,
    accessToken,
    timeoutMs,
    fetchImpl,
  });
  return decodeCursorSandAccessStatus(body);
}

async function fetchCursorSandUsageStatus({ accessToken, timeoutMs, fetchImpl = fetch }) {
  const body = await fetchCursorProtoRpc({
    url: CURSOR_SAND_USAGE_URL,
    accessToken,
    timeoutMs,
    fetchImpl,
  });
  return decodeCursorSandUsageStatus(body);
}

function fetchUrlRaw({ urlStr, cookie, timeoutMs = 30000, fetchImpl = fetch }) {
  return fetchImpl(urlStr, {
    method: "GET",
    headers: {
      Accept: "*/*",
      Cookie: cookie,
      Referer: "https://www.cursor.com/settings",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    // Keep manual: the previous hop did not follow a second redirect.
    // redirect:"follow" would turn a second 301/302/308 into a silent
    // success and may drop the explicit Cookie on a cross-host hop.
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    if (res.status !== 200) {
      throw new Error(`Cursor API returned ${res.status} from ${urlStr}`);
    }
    return res.text();
  }).catch(remapCursorFetchTimeout);
}

// ── CSV parsing ──

/**
 * Parse Cursor usage CSV into structured records.
 *
 * Column order has changed multiple times (e.g. new "Cloud Agent ID",
 * "Automation ID" columns inserted before "Kind"). Resolve columns by
 * header name instead of fixed index so the parser keeps working across
 * future Cursor updates.
 *
 * Known required columns: Date, Model, Input (w/ Cache Write),
 * Input (w/o Cache Write), Cache Read, Output Tokens, Total Tokens, Cost.
 * Optional: Kind, Max Mode.
 */
function parseCursorCsv(csvText) {
  const lines = csvText.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headerFields = parseCsvLine(lines[0]).map((f) => stripQuotes(f));
  const columnIndex = new Map();
  for (let i = 0; i < headerFields.length; i++) {
    columnIndex.set(headerFields[i], i);
  }

  const dateIdx = columnIndex.get("Date");
  const modelIdx = columnIndex.get("Model");
  const inputWithIdx = columnIndex.get("Input (w/ Cache Write)");
  const inputWithoutIdx = columnIndex.get("Input (w/o Cache Write)");
  const cacheReadIdx = columnIndex.get("Cache Read");
  const outputIdx = columnIndex.get("Output Tokens");
  const totalIdx = columnIndex.get("Total Tokens");
  const costIdx = columnIndex.get("Cost");
  const kindIdx = columnIndex.get("Kind");
  const maxModeIdx = columnIndex.get("Max Mode");

  const required = [dateIdx, modelIdx, inputWithIdx, inputWithoutIdx, cacheReadIdx, outputIdx, totalIdx, costIdx];
  if (required.some((idx) => idx === undefined)) return [];

  const minFields = Math.max(...required) + 1;

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (!fields || fields.length < minFields) continue;

    const inputWithCache = toNum(fields[inputWithIdx]);
    const inputWithoutCache = toNum(fields[inputWithoutIdx]);
    const record = {
      date: stripQuotes(fields[dateIdx]),
      kind: kindIdx !== undefined ? stripQuotes(fields[kindIdx]) : "unknown",
      model: stripQuotes(fields[modelIdx]),
      maxMode: maxModeIdx !== undefined ? stripQuotes(fields[maxModeIdx]) : "No",
      sourceScope: CURSOR_SOURCE_SCOPE,
      billableKind: isCursorBillableKind(kindIdx !== undefined ? fields[kindIdx] : "unknown")
        ? "billable"
        : "non_billable",
      inputTokens: inputWithoutCache,
      cacheWriteTokens: Math.max(0, inputWithCache - inputWithoutCache),
      cacheReadTokens: toNum(fields[cacheReadIdx]),
      outputTokens: toNum(fields[outputIdx]),
      totalTokens: toNum(fields[totalIdx]),
      cost: toFloat(fields[costIdx]),
    };

    if (record.totalTokens <= 0 && record.inputTokens <= 0 && record.outputTokens <= 0) continue;

    records.push(record);
  }

  return records;
}

/**
 * Normalize a Cursor CSV record to TokenTracker's standard token format.
 */
function normalizeCursorUsage(record) {
  const inputTokens = Math.max(0, Math.floor(record.inputTokens || 0));
  const cacheWrite = Math.max(0, Math.floor(record.cacheWriteTokens || 0));
  const cacheRead = Math.max(0, Math.floor(record.cacheReadTokens || 0));
  const outputTokens = Math.max(0, Math.floor(record.outputTokens || 0));
  const totalTokens = inputTokens + outputTokens + cacheWrite + cacheRead;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
    // Usage tracking and billing are orthogonal: a Cursor Enterprise /
    // Included-in-Pro request still consumes tokens even when the user
    // pays nothing for them. Cost is computed independently from
    // per-column tokens × MODEL_PRICING (see computeRowCost — it never
    // reads this field), while the dashboard headline reads
    // billable_total_tokens. Writing 0 here silently hides non-billable
    // Cursor usage from the headline once any other source pushes the
    // aggregate billable above 0 (see GitHub issue #106).
    // isCursorBillableKind is retained for a future paid-vs-included
    // breakdown via a separate is_billable field, not by overloading the
    // token count.
    billable_total_tokens: totalTokens,
  };
}

function isCursorBillableKind(kind) {
  const normalized = String(kind || "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("no charge")) return false;
  if (normalized === "free") return false;
  return true;
}

// ── CSV helpers ──

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function stripQuotes(s) {
  if (!s) return "";
  const trimmed = s.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function toNum(s) {
  const n = Number(stripQuotes(s));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function toFloat(s) {
  const cleaned = stripQuotes(s).replace(/[$,]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  resolveCursorPaths,
  isCursorInstalled,
  readCursorAccessTokenFromStateDb,
  extractCursorAuth,
  extractCursorSessionToken,
  fetchCursorUsageCsv,
  fetchCursorUsageSummary,
  decodeCursorSandAccessStatus,
  decodeCursorSandUsageStatus,
  fetchCursorSandAccessStatus,
  fetchCursorSandUsageStatus,
  parseCursorCsv,
  isCursorBillableKind,
  normalizeCursorUsage,
};
