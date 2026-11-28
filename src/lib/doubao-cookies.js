"use strict";

// Doubao desktop (com.bot.pc.doubao) keeps its web session in a Chromium-shaped
// SQLite cookie store, but encrypts cookie values with a layout that is NOT the
// standard Chromium v10 (verified against Doubao 2.33.5 / macOS 27.2; the
// well-known open-source Chromium decryptors produce garbage on it):
//
//   "v10" (3 bytes) | 16-byte header (purpose unknown) | 16-byte IV | AES-128-CBC
//
// with key = PBKDF2(keychainSecret, "saltysalt", 1003 iterations, 16 bytes,
// SHA1) and PKCS7 padding. The keychain secret lives in the "Doubao Safe
// Storage" generic-password item (account "Doubao"); the first read on a new
// machine pops one macOS authorization prompt.
//
// Privacy: decrypted cookie values stay in memory and are only used to call
// Doubao's quota endpoints. They are never written to disk or logs — the
// limits cache (doubao-limits.js) stores derived quota windows only.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readSqliteJsonRowsAsync } = require("./sqlite-reader");

const DOUBAO_COOKIE_HOST_SUFFIX = "doubao.com";
const DOUBAO_KEYCHAIN_SERVICE = "Doubao Safe Storage";
const DOUBAO_KEYCHAIN_ACCOUNT = "Doubao";
// "v10" magic + the extra 16-byte header that standard Chromium v10 lacks.
const DOUBAO_V10_IV_OFFSET = 3 + 16;
// IV (16) + at least one AES block of ciphertext.
const DOUBAO_V10_MIN_LENGTH = DOUBAO_V10_IV_OFFSET + 16 + 16;
const DOUBAO_PBKDF2_SALT = "saltysalt";
const DOUBAO_PBKDF2_ITERATIONS = 1003;
const DOUBAO_KEY_LENGTH_BYTES = 16;
// Session cookies identify a signed-in profile; without one there is no usable
// account for quota reads.
const DOUBAO_SESSION_COOKIE_NAMES = new Set(["sessionid", "sessionid_ss", "sid_guard", "sid_tt"]);
// hex(encrypted_value) travels as text: the sqlite3 CLI renders raw BLOBs in
// JSON output lossily, while node:sqlite returns them as typed arrays — hex is
// safe for both readers.
const DOUBAO_COOKIE_SQL =
  "SELECT name, hex(encrypted_value) AS encrypted_value_hex, last_access_utc " +
  "FROM cookies WHERE host_key LIKE '%" + DOUBAO_COOKIE_HOST_SUFFIX + "%' " +
  "AND encrypted_value IS NOT NULL AND length(encrypted_value) > 0";

function resolveDoubaoDataDir({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const override = typeof env.DOUBAO_HOME === "string" ? env.DOUBAO_HOME.trim() : "";
  if (override) return path.resolve(override);
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Doubao");
  }
  if (platform !== "darwin") {
    return path.join(home, ".config", "Doubao");
  }
  return path.join(home, "Library", "Application Support", "Doubao");
}

// Chromium profiles that can hold a user session: "Default" plus "Profile N".
// "System Profile"/"Guest Profile" never carry a Doubao login.
function doubaoCookieDbPaths(dataDir) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const dirs = ["Default"];
  for (const entry of entries) {
    if (entry.isDirectory() && /^Profile \d+$/.test(entry.name)) dirs.push(entry.name);
  }
  return dirs
    .map((name) => path.join(dataDir, name, "Cookies"))
    .filter((dbPath) => fs.existsSync(dbPath));
}

// Readers open the store read-only while Doubao may be running; a private copy
// sidesteps lock/WAL flakiness on the live database.
function snapshotDoubaoCookieDbs(dbPaths) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-cookies-"));
  const snapshots = [];
  try {
    dbPaths.forEach((dbPath, index) => {
      const dir = path.join(workDir, `db-${index}`);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, "Cookies");
      fs.copyFileSync(dbPath, target);
      for (const sidecar of ["-wal", "-journal"]) {
        try {
          fs.copyFileSync(dbPath + sidecar, target + sidecar);
        } catch (_error) {}
      }
      snapshots.push(target);
    });
  } catch (error) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
  return { workDir, snapshots };
}

function deriveDoubaoKey(keychainSecret) {
  return crypto.pbkdf2Sync(
    keychainSecret,
    DOUBAO_PBKDF2_SALT,
    DOUBAO_PBKDF2_ITERATIONS,
    DOUBAO_KEY_LENGTH_BYTES,
    "sha1",
  );
}

// Accepts the hex string produced by DOUBAO_COOKIE_SQL or a raw buffer
// (node:sqlite hands BLOBs back as typed arrays). Returns null for anything
// that is not Doubao v10 or does not decrypt under `key`.
function decryptDoubaoCookieValue(encryptedValue, key) {
  let blob = null;
  if (typeof encryptedValue === "string" && /^[0-9a-fA-F]+$/.test(encryptedValue)) {
    blob = Buffer.from(encryptedValue, "hex");
  } else if (Buffer.isBuffer(encryptedValue)) {
    blob = encryptedValue;
  } else if (encryptedValue instanceof Uint8Array) {
    blob = Buffer.from(encryptedValue.buffer, encryptedValue.byteOffset, encryptedValue.byteLength);
  }
  if (!blob || blob.length < DOUBAO_V10_MIN_LENGTH) return null;
  if (blob.subarray(0, 3).toString("latin1") !== "v10") return null;
  const iv = blob.subarray(DOUBAO_V10_IV_OFFSET, DOUBAO_V10_IV_OFFSET + 16);
  const ciphertext = blob.subarray(DOUBAO_V10_IV_OFFSET + 16);
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const value = plain.toString("utf8").trim();
    return value.length > 0 ? value : null;
  } catch (_error) {
    return null;
  }
}

// usage-limits.js pulls in doubao-limits.js at load time, and doubao-limits.js
// pulls in this module — a top-level require of usage-limits here would read a
// half-initialized export. Resolve the helper on first use instead.
function defaultKeychainReader() {
  // eslint-disable-next-line global-require
  const { readMacosKeychainGenericPasswordAsync } = require("./usage-limits");
  return readMacosKeychainGenericPasswordAsync;
}

async function readDoubaoProfileRows(dbPath, { sqliteReader } = {}) {
  const readRows = sqliteReader?.readJsonRowsAsync || readSqliteJsonRowsAsync;
  try {
    const rows = await readRows(dbPath, DOUBAO_COOKIE_SQL, {
      readOnly: true,
      label: "Doubao",
      timeout: 8000,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (_error) {
    return [];
  }
}

function decryptProfileCookies(rows, key) {
  const byName = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = typeof row?.name === "string" ? row.name : "";
    if (!name) continue;
    const value = decryptDoubaoCookieValue(row?.encrypted_value_hex, key);
    if (!value) continue;
    const lastAccess = Number(row?.last_access_utc) || 0;
    const existing = byName.get(name);
    if (!existing || lastAccess > existing.lastAccess) byName.set(name, { value, lastAccess });
  }
  return byName;
}

// Resolves the Doubao session cookie header.
//   1. DOUBAO_COOKIE env (manual paste) wins over local decryption — the same
//      precedence Qoder's QODER_COOKIE uses.
//   2. Otherwise the local Chromium cookie store is read: the profile with the
//      most recently used session cookie wins (Default and Profile 1 can both
//      hold .doubao.com cookies), and the keychain unlocks the values.
// Returns { ok:true, cookieHeader, source } or { ok:false, reason } with
// reason ∈ no-data-dir | no-session | keychain-unavailable | decrypt-failed.
async function readDoubaoCookieSession({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  securityRunner,
  sqliteReader,
  keychainReader,
} = {}) {
  const manualCookie = typeof env.DOUBAO_COOKIE === "string" ? env.DOUBAO_COOKIE.trim() : "";
  if (manualCookie) {
    return { ok: true, cookieHeader: manualCookie, source: "DOUBAO_COOKIE" };
  }

  const dataDir = resolveDoubaoDataDir({ home, env, platform });
  const dbPaths = doubaoCookieDbPaths(dataDir);
  if (dbPaths.length === 0) {
    return { ok: false, reason: "no-data-dir", dataDir };
  }

  const { workDir, snapshots } = snapshotDoubaoCookieDbs(dbPaths);
  try {
    const profileRows = [];
    for (const snapshotPath of snapshots) {
      profileRows.push(await readDoubaoProfileRows(snapshotPath, { sqliteReader }));
    }

    let best = null;
    for (const rows of profileRows) {
      let sessionLastAccess = -1;
      for (const row of rows) {
        if (typeof row?.name !== "string" || !DOUBAO_SESSION_COOKIE_NAMES.has(row.name)) continue;
        const lastAccess = Number(row?.last_access_utc) || 0;
        if (lastAccess > sessionLastAccess) sessionLastAccess = lastAccess;
      }
      if (sessionLastAccess >= 0 && (!best || sessionLastAccess > best.sessionLastAccess)) {
        best = { rows, sessionLastAccess };
      }
    }
    if (!best) {
      return { ok: false, reason: "no-session", dataDir };
    }

    const readSecret = keychainReader || defaultKeychainReader();
    let secret = null;
    try {
      secret = await readSecret({
        service: DOUBAO_KEYCHAIN_SERVICE,
        account: DOUBAO_KEYCHAIN_ACCOUNT,
        securityRunner,
      });
    } catch (_error) {
      secret = null;
    }
    if (!secret) {
      return { ok: false, reason: "keychain-unavailable", dataDir };
    }

    const cookies = decryptProfileCookies(best.rows, deriveDoubaoKey(secret));
    const hasSessionCookie = [...DOUBAO_SESSION_COOKIE_NAMES].some((name) => cookies.has(name));
    if (!hasSessionCookie) {
      return { ok: false, reason: "decrypt-failed", dataDir };
    }
    const cookieHeader = [...cookies.entries()].map(([name, entry]) => `${name}=${entry.value}`).join("; ");
    if (!cookieHeader) {
      return { ok: false, reason: "decrypt-failed", dataDir };
    }
    return { ok: true, cookieHeader, source: "local-keychain", dataDir };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  DOUBAO_COOKIE_HOST_SUFFIX,
  DOUBAO_COOKIE_SQL,
  DOUBAO_KEYCHAIN_SERVICE,
  DOUBAO_KEYCHAIN_ACCOUNT,
  DOUBAO_SESSION_COOKIE_NAMES,
  resolveDoubaoDataDir,
  doubaoCookieDbPaths,
  deriveDoubaoKey,
  decryptDoubaoCookieValue,
  readDoubaoCookieSession,
};
