"use strict";

/**
 * TRAE Work CN (国内版) config + usage fetch. Phase A: macOS + Windows + test-injected
 * paths only. Resolves the CN app data directory (TRAE Work CN or the classic
 * Trae CN client), reads the `iCubeAuthInfo://icube.cloudide`
 * blob from User/globalStorage/storage.json (plaintext JSON or Base64 tc v5),
 * and talks to the TRAE CN usage API. JWTs / refresh tokens are never
 * persisted, never logged, and never put into error messages; a
 * present-but-unreadable blob fails closed with a generic error.
 *
 * tc v5 blob: [6-byte magic "tc\x05\x10\x00\x00"][32-byte salt][AES-128-CBC ct]
 *   kdf_buf  = SHA-512(salt) || (JG xor KG)   // 128 bytes
 *   kdf_out  = SHA-512(kdf_buf)               // 64 bytes
 *   key = kdf_out[0..16], iv = kdf_out[16..32]
 *   plaintext = [SHA-512(json)][json]   // integrity prefix stripped
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TRAE_CN_HOME_ENV = "TOKENTRACKER_TRAE_CN_HOME";
// The TRAE CN usage read transmits the locally stored sign-in JWT to TRAE's
// official endpoint, so it is strictly opt-in: nothing is sent unless the
// user explicitly sets this flag. Any value other than 1/true keeps it off.
const TRAE_CN_USAGE_ENV = "TOKENTRACKER_TRAE_CN_USAGE";

function isTraeCnUsageEnabled(env = process.env) {
  const value = env ? env[TRAE_CN_USAGE_ENV] : undefined;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "1" || normalized === "true";
}
const TRAE_CN_APP_DIRS = ["TRAE SOLO CN", "Trae CN"];
const TRAE_CN_AUTH_KEY = "iCubeAuthInfo://icube.cloudide";

const TRAE_CN_USAGE_URL = "https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session";
// usage_type [7] mirrors the constant the official TRAE client sends when its
// usage page queries this endpoint (observed in the client's outbound
// requests; the enum is undocumented server-side). Other values unverified.
const TRAE_CN_USAGE_TYPE = [7];
const TRAE_CN_USAGE_PAGE_SIZE = 20;
const TRAE_CN_USAGE_MAX_PAGES = 100;
const TRAE_CN_USAGE_DELAY_MS = 300;
const TRAE_CN_USAGE_TIMEOUT_MS = 30 * 1000;
// Capacity-adaptive window splitting: 30 days halves at most 8 times
// (finest sub-window ~2.8h, aggregate ceiling ~512k sessions/30d). A window
// still over capacity at that depth fails closed — never a partial import.
const TRAE_CN_USAGE_MAX_SPLIT_DEPTH = 8;

const TRAE_CN_MAGIC = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
const TRAE_CN_SALT_LEN = 32;
const TRAE_CN_HASH_LEN = 64;
const TRAE_CN_AES_KEY_LEN = 16;
const TRAE_CN_IV_LEN = 16;

// JG / KG — the two halves of the hardcoded (obfuscated) password in the TRAE
// client's byteCrypto.js (XOR the pair to recover the KDF secret). Failure
// signature when TRAE ships a new key: readTraeCnAuthFromStorage throws
// "Trae CN auth payload is malformed", sync skips the source, and
// `tokentracker status` reports auth "malformed" — re-extract the pair
// from the updated client to restore decryption.
const TRAE_CN_JG = Buffer.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130,
  155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61,
  238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73,
  109, 139, 209, 37,
]);
const TRAE_CN_KG = Buffer.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25,
  181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176,
  200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99,
  85, 33, 12, 125,
]);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function traeCnDataParent({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  if (platform === "win32") {
    // Windows keeps the CN app under the roaming profile, mirroring the
    // macOS Application Support layout (<parent>/<app dir>/User/...).
    return typeof env.APPDATA === "string" && env.APPDATA.trim()
      ? env.APPDATA.trim()
      : path.join(home, "AppData", "Roaming");
  }
  // No verified CN app-data layout on other platforms yet.
  return null;
}

function resolveTraeCnStoragePath(options = {}) {
  const env = options.env ?? process.env;
  const override = env[TRAE_CN_HOME_ENV];
  if (typeof override === "string" && override.trim()) {
    return path.join(path.resolve(override.trim()), "User", "globalStorage", "storage.json");
  }
  const parent = traeCnDataParent({ env, home: options.home ?? os.homedir(), platform: options.platform ?? process.platform });
  if (!parent) return null;
  for (const dir of TRAE_CN_APP_DIRS) {
    const candidate = path.join(parent, dir, "User", "globalStorage", "storage.json");
    try {
      // Any successful stat means this client dir is the discovery hit —
      // including a non-file path (e.g. a directory named storage.json).
      // Hand that to the reader so EISDIR surfaces as TRAE_CN_STORAGE_UNREADABLE
      // instead of silently skipping to the next client or reporting absent.
      fs.statSync(candidate);
      return candidate;
    } catch (err) {
      // Permission failures must reach the reader's diagnostics, not
      // masquerade as an absent installation and silently drop an entire
      // usage history (same discovery policy as trae-db.js).
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// tc v5 decryption
// ---------------------------------------------------------------------------

function traeCnHardcodedKdfSecret() {
  const secret = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) secret[i] = TRAE_CN_JG[i] ^ TRAE_CN_KG[i];
  return secret;
}

function deriveTraeCnKeyIv(salt) {
  if (!Buffer.isBuffer(salt) || salt.length !== TRAE_CN_SALT_LEN) {
    throw new Error("Trae CN auth salt is malformed.");
  }
  const kdfBuf = Buffer.concat([
    crypto.createHash("sha512").update(salt).digest(),
    traeCnHardcodedKdfSecret(),
  ]);
  // Vendor tc-v5 compatibility KDF, not password storage.
  const kdfOut = crypto.createHash("sha512").update(kdfBuf).digest();
  return {
    key: kdfOut.subarray(0, TRAE_CN_AES_KEY_LEN),
    iv: kdfOut.subarray(TRAE_CN_AES_KEY_LEN, TRAE_CN_AES_KEY_LEN + TRAE_CN_IV_LEN),
  };
}

/** Decrypt a raw tc v5 blob; returns the JSON bytes (integrity prefix stripped). */
function decryptTraeCnBlob(blob) {
  const minLen = TRAE_CN_MAGIC.length + TRAE_CN_SALT_LEN + 16;
  if (!Buffer.isBuffer(blob) || blob.length < minLen) {
    throw new Error("Trae CN auth blob is too short.");
  }
  if (!blob.subarray(0, TRAE_CN_MAGIC.length).equals(TRAE_CN_MAGIC)) {
    throw new Error("Trae CN auth blob has an unknown format.");
  }
  const salt = blob.subarray(TRAE_CN_MAGIC.length, TRAE_CN_MAGIC.length + TRAE_CN_SALT_LEN);
  const ciphertext = blob.subarray(TRAE_CN_MAGIC.length + TRAE_CN_SALT_LEN);
  if (ciphertext.length % 16 !== 0) {
    throw new Error("Trae CN auth blob is not block-aligned.");
  }
  const { key, iv } = deriveTraeCnKeyIv(salt);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv); // PKCS7 default
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_error) {
    throw new Error("Trae CN auth blob could not be decrypted.");
  }
  if (plaintext.length < TRAE_CN_HASH_LEN) {
    throw new Error("Trae CN auth blob is missing its integrity digest.");
  }
  const expected = plaintext.subarray(0, TRAE_CN_HASH_LEN);
  const data = plaintext.subarray(TRAE_CN_HASH_LEN);
  const actual = crypto.createHash("sha512").update(data).digest();
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("Trae CN auth blob failed its integrity check.");
  }
  return data;
}

/** Decrypt a Base64-encoded tc v5 blob and return the plaintext UTF-8 string. */
function decryptTraeCnBase64(value) {
  const blob = Buffer.from(String(value).trim(), "base64");
  return decryptTraeCnBlob(blob).toString("utf8");
}

// ---------------------------------------------------------------------------
// Credential reading
// ---------------------------------------------------------------------------

/**
 * Parse a stored auth value: a plaintext JSON object / JSON string, or a
 * Base64-encoded tc v5 blob. Fails closed with a credential-safe error.
 */
function parseTraeCnAuthValue(value) {
  if (value && typeof value === "object") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("Trae CN auth data is empty.");
    }
    if (trimmed.startsWith("{")) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (_error) {
        throw new Error("Trae CN auth JSON is malformed.");
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Trae CN auth JSON is malformed.");
      }
      return parsed;
    }
    let decrypted;
    try {
      decrypted = decryptTraeCnBase64(trimmed);
    } catch (error) {
      if (error && error.message.startsWith("Trae CN auth")) throw error;
      throw new Error("Trae CN auth payload is malformed.");
    }
    let parsed;
    try {
      parsed = JSON.parse(decrypted);
    } catch (_error) {
      throw new Error("Trae CN auth payload is malformed.");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Trae CN auth payload is malformed.");
    }
    return parsed;
  }
  throw new Error("Trae CN auth data is missing or malformed.");
}

/**
 * Read + decrypt the auth object from storage.json. Returns null when the
 * file or the auth key is absent (not signed in). Throws a credential-safe
 * error when present data is malformed, and a distinct unreadable error for
 * real IO failures (permission denied, I/O error) - an unreadable storage
 * file must not be reported as "not signed in".
 */
function readTraeCnAuthFromStorage({ env, home, platform, fsModule = fs } = {}) {
  const storagePath = resolveTraeCnStoragePath({ env, home, platform });
  if (!storagePath) return null;
  let raw;
  try {
    raw = fsModule.readFileSync(storagePath, "utf8");
  } catch (error) {
    // A missing file (or missing path component) simply means the app is not
    // installed / not signed in. Any other failure - EACCES, EISDIR, a real
    // I/O error - fails closed with a generic, credential-safe error. Only a
    // stable machine-readable code is attached, never the OS detail, so
    // storage contents cannot leak through logs or error messages.
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return null;
    }
    const unreadable = new Error("Trae CN storage.json could not be read.");
    unreadable.code = "TRAE_CN_STORAGE_UNREADABLE";
    throw unreadable;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    throw new Error("Trae CN storage.json is not valid JSON.");
  }
  const value = parsed && typeof parsed === "object" ? parsed[TRAE_CN_AUTH_KEY] : undefined;
  if (value === undefined || value === null) return null;
  return parseTraeCnAuthValue(value);
}

/** Extract a nonempty JWT from a parsed auth object. */
function extractTraeCnToken(auth) {
  const token = auth && typeof auth === "object" ? auth.token : undefined;
  if (typeof token === "string" && token.trim()) {
    return token.trim();
  }
  throw new Error("Trae CN auth data has no token.");
}

// ---------------------------------------------------------------------------
// Usage API
// ---------------------------------------------------------------------------

function usageError(message, { status, apiCode } = {}) {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  if (apiCode !== undefined) error.apiCode = apiCode;
  if (status === 401 || status === 403) error.code = "AUTH_EXPIRED";
  return error;
}

function assertUsageParams({ start_time, end_time, page_size }) {
  if (!Number.isInteger(start_time) || start_time <= 0) {
    throw new Error("Trae CN usage start_time must be a positive integer epoch second.");
  }
  if (!Number.isInteger(end_time) || end_time <= 0) {
    throw new Error("Trae CN usage end_time must be a positive integer epoch second.");
  }
  if (start_time > end_time) {
    throw new Error("Trae CN usage start_time must not be after end_time.");
  }
  if (!Number.isInteger(page_size) || page_size <= 0 || page_size > TRAE_CN_USAGE_PAGE_SIZE) {
    throw new Error(
      `Trae CN usage page_size must be a positive integer no greater than ${TRAE_CN_USAGE_PAGE_SIZE}.`,
    );
  }
}

/**
 * Fetch one page of TRAE CN usage. Returns { sessions, total, page_num, page_size }
 * where `total` is null when the API omits it. Errors never contain the JWT
 * or the raw request/response body.
 */
async function fetchTraeCnUsagePage({
  jwt,
  start_time,
  end_time,
  page_num,
  page_size = TRAE_CN_USAGE_PAGE_SIZE,
  fetchImpl = fetch,
  timeoutMs = TRAE_CN_USAGE_TIMEOUT_MS,
} = {}) {
  if (typeof jwt !== "string" || !jwt.trim()) {
    throw new Error("Trae CN usage request requires a token.");
  }
  if (!Number.isInteger(page_num) || page_num < 1) {
    throw new Error("Trae CN usage page_num must be a positive integer.");
  }
  assertUsageParams({ start_time, end_time, page_size });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      // Security note (CodeQL "File data -> outbound network request"):
      // the credential read from TRAE's local storage.json is sent ONLY to
      // TRAE_CN_USAGE_URL, a compile-time constant HTTPS endpoint of the
      // official API - callers cannot redirect the destination (the url
      // parameter is ignored; pinned by the "sends the exact request" test).
      // The whole flow is behind the explicit TOKENTRACKER_TRAE_CN_USAGE
      // opt-in, the JWT is never logged, never written to the queue/cursor
      // state, and never uploaded to the TokenTracker cloud (queue rows carry
      // token counters only; transport exceptions are sanitized).
      response = await fetchImpl(TRAE_CN_USAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Cloud-IDE-JWT ${jwt.trim()}`,
        },
        body: JSON.stringify({
          usage_type: TRAE_CN_USAGE_TYPE,
          start_time,
          end_time,
          page_num,
          page_size,
        }),
        signal: controller.signal,
      });
    } catch (_error) {
      throw new Error("Trae CN usage API request failed.");
    }
    if (response.status === 401 || response.status === 403) {
      throw usageError(`Trae CN usage API returned HTTP ${response.status}.`, { status: response.status });
    }
    if (!response.ok) {
      throw usageError(`Trae CN usage API returned HTTP ${response.status}.`, { status: response.status });
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch (_error) {
      throw new Error("Trae CN usage API returned a non-JSON response.");
    }
    const apiCode = parsed?.data?.code ?? parsed?.code;
    if (apiCode !== undefined && Number(apiCode) !== 0) {
      throw usageError(`Trae CN usage API returned error code ${apiCode}.`, {
        status: response.status,
        apiCode: Number(apiCode),
      });
    }
    // Documented wrapper: data.user_usage_group_by_sessions, or the top-level
    // equivalent. Only this module parses the wrapper; token rows/buckets are
    // normalized elsewhere. A body without the session-array wrapper fails
    // closed as a schema error instead of being misread as an empty result;
    // an explicit empty array remains valid.
    const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
    if (!Array.isArray(data?.user_usage_group_by_sessions)) {
      throw new Error("Trae CN usage API response is missing the session list.");
    }
    const sessions = data.user_usage_group_by_sessions;
    // The declared total gates pagination termination (sessions.length >=
    // total stops the walk), so a malformed value must fail closed as a
    // schema error - never be coerced into a legal-looking stop condition.
    // A negative, fractional, non-finite, or non-number total (the API
    // speaks JSON numbers; a quoted digit string is a schema anomaly) would
    // otherwise silently truncate the snapshot after page 1 and still look
    // authoritative.
    const rawTotal = data?.total;
    let total = null;
    if (rawTotal !== undefined && rawTotal !== null) {
      if (
        typeof rawTotal !== "number" ||
        !Number.isSafeInteger(rawTotal) ||
        rawTotal < 0
      ) {
        throw new Error("Trae CN usage API returned an invalid total.");
      }
      total = rawTotal;
    }
    return { sessions, total, page_num, page_size };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch usage across pages serially. Starts at the 1-based page_num, at most
 * maxPages pages, with a delay between pages (pass delayMs = 0 to disable in
 * tests). Stops at the stated total when present, otherwise on an empty page.
 * Throws if maxPages is reached while another page would still be needed.
 */
async function fetchTraeCnUsage({
  jwt,
  start_time,
  end_time,
  page_num = 1,
  page_size = TRAE_CN_USAGE_PAGE_SIZE,
  fetchImpl = fetch,
  maxPages = TRAE_CN_USAGE_MAX_PAGES,
  delayMs = TRAE_CN_USAGE_DELAY_MS,
  pageFetcher = fetchTraeCnUsagePage,
} = {}) {
  const sessions = [];
  let total = null;
  let pagesFetched = 0;
  let page = page_num;
  for (;;) {
    if (pagesFetched >= maxPages) {
      // A further page would be needed but the cap prevents it: fail closed
      // rather than return a partial snapshot that looks authoritative. Cap
      // exhaustion is the same over-capacity signal as the declared-total
      // check below (which the API may omit) — tag it identically so window
      // splitting engages either way.
      const error = new Error("Trae CN usage pagination exceeded the maximum page count.");
      error.code = "TRAE_CN_USAGE_CAPACITY_EXCEEDED";
      throw error;
    }
    const result = await pageFetcher({ jwt, start_time, end_time, page_num: page, page_size, fetchImpl });
    pagesFetched += 1;
    total = result.total ?? null;
    if (pagesFetched === 1 && Number.isFinite(total) && total > page_size * maxPages) {
      const error = new Error("Trae CN usage snapshot exceeds the supported capacity.");
      error.code = "TRAE_CN_USAGE_CAPACITY_EXCEEDED";
      throw error;
    }
    if (Array.isArray(result.sessions)) sessions.push(...result.sessions);
    if (result.sessions.length === 0) break;
    if (total !== null && sessions.length >= total) break;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    page += 1;
  }
  return { sessions, total, pages_fetched: pagesFetched };
}

/**
 * Capacity-adaptive window fetch. Probing the official API confirmed the
 * start_time/end_time range is closed on both ends ([a,b] and [b,c] both
 * return the row at b) and that a row returned by two overlapping windows is
 * byte-identical (idempotent duplicate, never cumulative). Splitting therefore
 * staggers adjacent sub-windows by one second ([start,mid] + [mid+1,end]) so
 * the union equals the full window exactly; any residual duplicate would be
 * absorbed by the session-level reconciliation. On TRAE_CN_USAGE_CAPACITY_
 * EXCEEDED the window halves recursively up to maxSplitDepth levels; a window
 * still over capacity at the finest allowed granularity re-throws so the
 * caller keeps its fail-closed guarantee.
 */
async function fetchTraeCnUsageWindowed(options = {}, depth = 0) {
  const { start_time, end_time } = options;
  try {
    return await fetchTraeCnUsage(options);
  } catch (error) {
    if (error?.code !== "TRAE_CN_USAGE_CAPACITY_EXCEEDED") throw error;
    if (end_time - start_time < 1 || depth >= TRAE_CN_USAGE_MAX_SPLIT_DEPTH) throw error;
    const mid = start_time + Math.floor((end_time - start_time) / 2);
    const left = await fetchTraeCnUsageWindowed({ ...options, end_time: mid }, depth + 1);
    const right = await fetchTraeCnUsageWindowed({ ...options, start_time: mid + 1 }, depth + 1);
    const total =
      Number.isFinite(left.total) && Number.isFinite(right.total) ? left.total + right.total : null;
    return {
      sessions: [...left.sessions, ...right.sessions],
      total,
      pages_fetched: left.pages_fetched + right.pages_fetched,
    };
  }
}

/**
 * High-level storage-backed fetch: read the JWT from storage.json, fetch
 * usage, and on a 401/403 re-read + re-decrypt storage.json and retry exactly
 * once. Never persists or logs the JWT / refresh token; no refreshToken flow.
 */
async function fetchTraeCnUsageWithAuth({
  start_time,
  end_time,
  page_num = 1,
  page_size = TRAE_CN_USAGE_PAGE_SIZE,
  fetchImpl = fetch,
  delayMs = TRAE_CN_USAGE_DELAY_MS,
  maxPages = TRAE_CN_USAGE_MAX_PAGES,
  readAuth = readTraeCnAuthFromStorage,
  usageFetcher = fetchTraeCnUsageWindowed,
  ...storageOptions
} = {}) {
  let auth = readAuth(storageOptions);
  let jwt = auth ? extractTraeCnToken(auth) : null;
  if (!jwt) {
    throw new Error("Trae CN credentials are not configured.");
  }
  const run = () =>
    usageFetcher({ jwt, start_time, end_time, page_num, page_size, fetchImpl, delayMs, maxPages });
  try {
    return await run();
  } catch (error) {
    const authFailure =
      error?.code === "AUTH_EXPIRED" || error?.status === 401 || error?.status === 403;
    if (!authFailure) throw error;
    // Session may have rotated since the first read; re-read storage once.
    auth = readAuth(storageOptions);
    jwt = auth ? extractTraeCnToken(auth) : null;
    if (!jwt) throw error;
    return await run();
  }
}

module.exports = {
  TRAE_CN_HOME_ENV,
  TRAE_CN_USAGE_ENV,
  isTraeCnUsageEnabled,
  TRAE_CN_APP_DIRS,
  TRAE_CN_AUTH_KEY,
  TRAE_CN_USAGE_URL,
  TRAE_CN_USAGE_TYPE,
  TRAE_CN_USAGE_PAGE_SIZE,
  TRAE_CN_USAGE_MAX_PAGES,
  TRAE_CN_USAGE_DELAY_MS,
  TRAE_CN_MAGIC,
  resolveTraeCnStoragePath,
  traeCnHardcodedKdfSecret,
  deriveTraeCnKeyIv,
  decryptTraeCnBlob,
  decryptTraeCnBase64,
  parseTraeCnAuthValue,
  readTraeCnAuthFromStorage,
  extractTraeCnToken,
  fetchTraeCnUsagePage,
  fetchTraeCnUsage,
  fetchTraeCnUsageWindowed,
  fetchTraeCnUsageWithAuth,
};
