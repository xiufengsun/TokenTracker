"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DOUBAO_COOKIE_HOST_SUFFIX,
  DOUBAO_KEYCHAIN_ACCOUNT,
  DOUBAO_KEYCHAIN_SERVICE,
  resolveDoubaoDataDir,
  doubaoCookieDbPaths,
  deriveDoubaoKey,
  decryptDoubaoCookieValue,
  readDoubaoCookieSession,
} = require("../src/lib/doubao-cookies");

// Builds a Doubao-layout v10 blob: "v10" + 16-byte header + IV + AES-128-CBC,
// keyed by PBKDF2(secret, 'saltysalt', 1003, 16, sha1) — the non-standard
// layout reverse-engineered from Doubao 2.33.5.
function encryptDoubaoValue(plain, secret) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", deriveDoubaoKey(secret), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), crypto.randomBytes(16), iv, body]).toString("hex");
}

test("decryptDoubaoCookieValue round-trips the Doubao v10 layout", () => {
  const key = deriveDoubaoKey("keychain-secret");
  const hex = encryptDoubaoValue("session-value-123", "keychain-secret");
  assert.equal(decryptDoubaoCookieValue(hex, key), "session-value-123");
});

test("decryptDoubaoCookieValue rejects wrong keys, short blobs and non-v10 magic", () => {
  const key = deriveDoubaoKey("keychain-secret");
  const hex = encryptDoubaoValue("session-value-123", "keychain-secret");
  assert.equal(decryptDoubaoCookieValue(hex, deriveDoubaoKey("other-secret")), null);
  assert.equal(decryptDoubaoCookieValue("aabbcc", key), null);
  assert.equal(decryptDoubaoCookieValue("", key), null);
  assert.equal(decryptDoubaoCookieValue(null, key), null);
  const wrongMagic = Buffer.from(
    Buffer.from(hex, "hex").subarray().map((byte, index) => (index === 0 ? 0x78 : byte)),
  ).toString("hex");
  assert.equal(decryptDoubaoCookieValue(wrongMagic, key), null);
});

test("resolveDoubaoDataDir honors DOUBAO_HOME and platform defaults", () => {
  assert.equal(
    resolveDoubaoDataDir({ home: "/home", env: { DOUBAO_HOME: "/custom/doubao" }, platform: "darwin" }),
    path.resolve("/custom/doubao"),
  );
  assert.equal(
    resolveDoubaoDataDir({ home: "/home", env: {}, platform: "darwin" }),
    path.join("/home", "Library", "Application Support", "Doubao"),
  );
  assert.equal(
    resolveDoubaoDataDir({ home: "/home", env: {}, platform: "win32" }),
    path.join("/home", "AppData", "Roaming", "Doubao"),
  );
  assert.equal(
    resolveDoubaoDataDir({ home: "/home", env: {}, platform: "linux" }),
    path.join("/home", ".config", "Doubao"),
  );
});

test("doubaoCookieDbPaths lists Default and Profile N stores only", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-dirs-"));
  try {
    for (const dir of ["Default", "Profile 1", "Profile 10", "Guest Profile", "System Profile"]) {
      fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(dataDir, "Default", "Cookies"), "db");
    fs.writeFileSync(path.join(dataDir, "Profile 1", "Cookies"), "db");
    fs.writeFileSync(path.join(dataDir, "Profile 10", "Cookies"), "db");
    fs.mkdirSync(path.join(dataDir, "Profile 2"), { recursive: true }); // no Cookies file
    const dbs = doubaoCookieDbPaths(dataDir);
    assert.equal(dbs.length, 3);
    assert.ok(dbs.every((dbPath) => dbPath.endsWith("Cookies")));
    assert.ok(dbs.every((dbPath) => !dbPath.includes("Guest Profile")));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("readDoubaoCookieSession prefers DOUBAO_COOKIE and never touches local stores", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-env-"));
  try {
    const session = await readDoubaoCookieSession({
      home,
      env: { DOUBAO_COOKIE: "sessionid=manual" },
      keychainReader: async () => {
        throw new Error("keychain must not be read when DOUBAO_COOKIE is set");
      },
      sqliteReader: {
        readJsonRowsAsync: async () => {
          throw new Error("cookie store must not be read when DOUBAO_COOKIE is set");
        },
      },
    });
    assert.deepEqual(session, { ok: true, cookieHeader: "sessionid=manual", source: "DOUBAO_COOKIE" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("readDoubaoCookieSession reports no-data-dir without Doubao installed", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-absent-"));
  try {
    const session = await readDoubaoCookieSession({ home, env: {}, keychainReader: async () => "secret" });
    assert.equal(session.ok, false);
    assert.equal(session.reason, "no-data-dir");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function writeDoubaoHome({ home, profileCookies }) {
  const dataDir = path.join(home, "Library", "Application Support", "Doubao");
  const dbs = [];
  profileCookies.forEach((cookies, index) => {
    const profileDir = index === 0 ? "Default" : `Profile ${index}`;
    fs.mkdirSync(path.join(dataDir, profileDir), { recursive: true });
    const dbPath = path.join(dataDir, profileDir, "Cookies");
    // A placeholder file: the injected sqliteReader never opens it, but
    // doubaoCookieDbPaths only lists profiles whose Cookies file exists.
    fs.writeFileSync(dbPath, "placeholder");
    dbs.push(dbPath);
  });
  return dbs;
}

test("readDoubaoCookieSession picks the most recently used signed-in profile", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-profiles-"));
  try {
    const dbs = writeDoubaoHome({ home, profileCookies: [[], []] });
    const secret = "kw-secret";
    let capturedArgs = null;
    const sqliteReader = {
      readJsonRowsAsync: async (dbPath) => {
        // Snapshot dirs are numbered in doubaoCookieDbPaths order: db-0 is
        // Default, db-1 is Profile 1.
        if (dbPath.includes("db-0")) {
          return [
            { name: "sessionid", encrypted_value_hex: encryptDoubaoValue("stale-session", secret), last_access_utc: 100 },
          ];
        }
        return [
          { name: "sessionid_ss", encrypted_value_hex: encryptDoubaoValue("fresh-session", secret), last_access_utc: 900 },
          { name: "odin_tt", encrypted_value_hex: encryptDoubaoValue("odin", secret), last_access_utc: 900 },
        ];
      },
    };
    const session = await readDoubaoCookieSession({
      home,
      env: {},
      // The fixtures below build the macOS data-dir layout; pin the platform so
      // this unit test is deterministic on Linux/Windows runners too. Path
      // resolution itself is covered by the resolveDoubaoDataDir test above.
      platform: "darwin",
      keychainReader: async (args) => {
        capturedArgs = args;
        return secret;
      },
      sqliteReader,
    });
    assert.ok(session.ok, JSON.stringify(session));
    assert.equal(session.source, "local-keychain");
    assert.ok(session.cookieHeader.includes("sessionid_ss=fresh-session"), session.cookieHeader);
    assert.ok(!session.cookieHeader.includes("stale-session"), "must not mix cookies from the stale profile");
    assert.equal(capturedArgs?.service, DOUBAO_KEYCHAIN_SERVICE);
    assert.equal(capturedArgs?.account, DOUBAO_KEYCHAIN_ACCOUNT);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("readDoubaoCookieSession distinguishes no-session, keychain and decrypt failures", async () => {
  const secret = "kw-secret";
  const makeHome = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  const noSessionHome = makeHome("tokentracker-doubao-nosess-");
  const keychainHome = makeHome("tokentracker-doubao-kc-");
  const decryptHome = makeHome("tokentracker-doubao-dec-");
  try {
    writeDoubaoHome({ home: noSessionHome, profileCookies: [[], []] });
    writeDoubaoHome({ home: keychainHome, profileCookies: [[]] });
    writeDoubaoHome({ home: decryptHome, profileCookies: [[]] });

    const noSession = await readDoubaoCookieSession({
      home: noSessionHome,
      env: {},
      platform: "darwin",
      keychainReader: async () => "secret",
      sqliteReader: { readJsonRowsAsync: async () => [{ name: "ttwid", encrypted_value_hex: "aa", last_access_utc: 1 }] },
    });
    assert.deepEqual({ ok: noSession.ok, reason: noSession.reason }, { ok: false, reason: "no-session" });

    const emptyRows = { readJsonRowsAsync: async () => [] };
    const keychainDenied = await readDoubaoCookieSession({
      home: keychainHome,
      env: {},
      platform: "darwin",
      keychainReader: async () => null,
      sqliteReader: {
        ...emptyRows,
        readJsonRowsAsync: async () => [
          { name: "sessionid", encrypted_value_hex: encryptDoubaoValue("s", secret), last_access_utc: 5 },
        ],
      },
    });
    assert.deepEqual({ ok: keychainDenied.ok, reason: keychainDenied.reason }, { ok: false, reason: "keychain-unavailable" });

    const decryptFailed = await readDoubaoCookieSession({
      home: decryptHome,
      env: {},
      platform: "darwin",
      keychainReader: async () => "wrong-keychain-secret",
      sqliteReader: {
        readJsonRowsAsync: async () => [
          { name: "sessionid", encrypted_value_hex: encryptDoubaoValue("s", secret), last_access_utc: 5 },
        ],
      },
    });
    assert.deepEqual({ ok: decryptFailed.ok, reason: decryptFailed.reason }, { ok: false, reason: "decrypt-failed" });
  } finally {
    for (const dir of [noSessionHome, keychainHome, decryptHome]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("cookie SQL filters to doubao hosts and exposes hex values", () => {
  const { DOUBAO_COOKIE_SQL } = require("../src/lib/doubao-cookies");
  assert.ok(DOUBAO_COOKIE_SQL.includes(DOUBAO_COOKIE_HOST_SUFFIX));
  assert.ok(/hex\(encrypted_value\)/.test(DOUBAO_COOKIE_SQL));
});
