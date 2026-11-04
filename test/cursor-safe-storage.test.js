const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { decodeCursorAccessToken } = require("../src/lib/cursor-safe-storage");
const {
  extractCursorAuth,
  extractCursorSessionToken,
  readCursorUserIdFromStateDb,
  resolveCursorPaths,
} = require("../src/lib/cursor-config");

const jwt = (sub = "auth0|user_TEST") => [
  Buffer.from('{"alg":"HS256"}').toString("base64url"),
  Buffer.from(JSON.stringify({ sub })).toString("base64url"),
  "synthetic_signature",
].join(".");
const wrap = (bytes) => `cursor-safe-storage:v1:${bytes.toString("base64")}`;
function cbcToken(token, password, iterations = 1003, version = "v10") {
  const key = crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return wrap(Buffer.concat([Buffer.from(version), cipher.update(token), cipher.final()]));
}
function windowsFixture(token) {
  const key = Buffer.alloc(32, 0x42);
  const nonce = Buffer.alloc(12, 0x31);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(token), cipher.final()]);
  return {
    key,
    bytes: Buffer.concat([Buffer.from("v10"), nonce, data, cipher.getAuthTag()]),
    localState: JSON.stringify({ os_crypt: {
      encrypted_key: Buffer.from("DPAPIsynthetic-wrapped-key").toString("base64"),
    } }),
  };
}

describe("Cursor safe-storage v1", () => {
  it("keeps legacy JWTs without invoking the OS store on any platform", () => {
    let calls = 0;
    for (const platform of ["darwin", "win32", "linux", "freebsd"]) {
      assert.equal(decodeCursorAccessToken(jwt(), { platform, deps: {
        execFileSync() { calls++; throw new Error("unexpected OS access"); },
      } }), jwt());
    }
    assert.equal(calls, 0);
  });

  it("decrypts macOS v10 using the Cursor Keychain password and Chromium parameters", () => {
    const calls = [];
    const result = decodeCursorAccessToken(cbcToken(jwt(), "synthetic-keychain-password"), {
      platform: "darwin",
      deps: { execFileSync: (...args) => { calls.push(args); return "synthetic-keychain-password\n"; } },
    });
    assert.equal(result, jwt());
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/usr/bin/security");
    assert.deepEqual(calls[0][1], ["find-generic-password", "-s", "Cursor Safe Storage", "-w"]);
    assert.deepEqual(calls[0][2].stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(calls[0][2].timeout, 5000);
  });

  it("uses DPAPI CurrentUser with a fixed PowerShell script and piped data", () => {
    const calls = [];
    const bytes = Buffer.from("synthetic-legacy-dpapi-blob");
    const result = decodeCursorAccessToken(wrap(bytes), { platform: "win32", deps: {
      execFileSync: (...args) => {
        calls.push(args);
        return Buffer.from(jwt()).toString("base64");
      },
    } });
    assert.equal(result, jwt());
    const [command, args, options] = calls[0];
    assert.equal(command, "powershell.exe");
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.match(args[3], /ProtectedData\]::Unprotect/);
    assert.match(args[3], /DataProtectionScope\]::CurrentUser/);
    assert.match(args[3], /\[Console\]::In.ReadToEnd\(\)/);
    assert.equal(args.join(" ").includes(bytes.toString("base64")), false);
    assert.equal(options.input, bytes.toString("base64"));
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  });

  it("decrypts Windows v10 with the DPAPI-protected Local State key", () => {
    const fixture = windowsFixture(jwt());
    const reads = [];
    const unprotected = [];
    assert.equal(decodeCursorAccessToken(wrap(fixture.bytes), {
      platform: "win32", appDir: "C:\\Users\\Test\\AppData\\Roaming\\Cursor", deps: {
        readFileSync: (...args) => { reads.push(args); return fixture.localState; },
        unprotectWindows: (data) => { unprotected.push(data.toString()); return fixture.key; },
      },
    }), jwt());
    assert.deepEqual(reads, [["C:\\Users\\Test\\AppData\\Roaming\\Cursor\\Local State", "utf8"]]);
    assert.deepEqual(unprotected, ["synthetic-wrapped-key"]);
  });

  it("rejects Windows authentication-tag failures, invalid keys, and unavailable DPAPI", () => {
    const fixture = windowsFixture(jwt());
    fixture.bytes[fixture.bytes.length - 1] ^= 1;
    for (const deps of [
      { readFileSync: () => fixture.localState, unprotectWindows: () => fixture.key },
      { readFileSync: () => fixture.localState, unprotectWindows: () => Buffer.alloc(16) },
      { readFileSync: () => "{}" },
      { readFileSync: () => { throw new Error("missing Local State"); } },
    ]) {
      assert.equal(decodeCursorAccessToken(wrap(fixture.bytes), {
        platform: "win32", appDir: "C:\\Cursor", deps,
      }), null);
    }
    assert.equal(decodeCursorAccessToken(wrap(Buffer.from("dpapi")), {
      platform: "win32", deps: { execFileSync() { throw new Error("DPAPI denied"); } },
    }), null);
  });

  it("supports Linux basic_text v10 without a keyring", () => {
    let called = false;
    assert.equal(decodeCursorAccessToken(cbcToken(jwt(), "peanuts", 1), {
      platform: "linux", deps: { execFileSync() { called = true; } },
    }), jwt());
    assert.equal(called, false);
  });

  it("supports Linux v11 through Secret Service and fails quietly when unavailable", () => {
    const encrypted = cbcToken(jwt(), "synthetic-libsecret-key", 1, "v11");
    const calls = [];
    assert.equal(decodeCursorAccessToken(encrypted, { platform: "linux", deps: {
      execFileSync: (...args) => { calls.push(args); return "synthetic-libsecret-key\n"; },
    } }), jwt());
    assert.equal(calls[0][0], "secret-tool");
    assert.deepEqual(calls[0][1], ["lookup", "application", "cursor"]);
    for (const execFileSync of [() => "", () => { throw new Error("keyring unavailable"); }]) {
      assert.equal(decodeCursorAccessToken(encrypted, { platform: "linux", deps: { execFileSync } }), null);
    }
  });

  it("rejects malformed/unsupported envelopes before accessing secrets", () => {
    let calls = 0;
    for (const value of [null, "", "opaque-token", "cursor-safe-storage:v2:YWJj",
      "cursor-safe-storage:v1:", "cursor-safe-storage:v1:!!!!", "cursor-safe-storage:v1:abc=extra",
      wrap(Buffer.from("v10truncated")), cbcToken(jwt(), "key", 1003, "v20")]) {
      assert.equal(decodeCursorAccessToken(value, { platform: "darwin", deps: {
        execFileSync() { calls++; return "key"; },
      } }), null);
    }
    assert.equal(calls, 0);
    assert.equal(decodeCursorAccessToken(cbcToken(jwt(), "key"), { platform: "freebsd" }), null);
  });

  it("does not return corrupt ciphertext or decrypted non-JWT data", () => {
    for (const value of [cbcToken(jwt(), "wrong-key"), cbcToken("not a JWT", "key")]) {
      assert.equal(decodeCursorAccessToken(value, {
        platform: "darwin", deps: { execFileSync: () => "key" },
      }), null);
    }
  });

  it("never logs secret-bearing errors, even with debug enabled", (t) => {
    const writes = [];
    t.mock.method(process.stderr, "write", (value) => { writes.push(String(value)); return true; });
    t.mock.method(process.stdout, "write", (value) => { writes.push(String(value)); return true; });
    assert.equal(decodeCursorAccessToken(cbcToken(jwt(), "key"), {
      platform: "darwin", deps: {
        env: { TOKENTRACKER_DEBUG: "1" },
        execFileSync() { throw new Error(`secret password, token ${jwt()}, encrypted blob`); },
      },
    }), null);
    assert.deepEqual(writes, []);
  });
});

function stateFixture(t, entries, { cliConfig = {}, platform = "darwin", password = "key" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-safe-storage-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { stateDbPath, cliConfigPath } = resolveCursorPaths({ home, platform, env: {} });
  fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
  fs.writeFileSync(stateDbPath, "");
  fs.mkdirSync(path.dirname(cliConfigPath), { recursive: true });
  fs.writeFileSync(cliConfigPath, JSON.stringify(cliConfig));
  const commands = [];
  const deps = {
    env: {},
    execFileSync(command, args) {
      commands.push(command);
      if (command === "/usr/bin/security") return password;
      if (command !== "sqlite3") throw new Error("unexpected command");
      const key = args.at(-1).match(/WHERE key = '([^']+)'/)[1];
      return JSON.stringify(entries[key] === undefined ? [] : [{ value: entries[key] }]);
    },
    requireFn() { throw new Error("node:sqlite not expected"); },
  };
  return { options: { home, platform, env: {}, deps }, stateDbPath, deps, commands };
}

describe("Cursor migrated auth state", () => {
  it("reads encrypted auth and migrated identity through the real node:sqlite fallback", (t) => {
    let DatabaseSync;
    try { ({ DatabaseSync } = require("node:sqlite")); } catch { t.skip("node:sqlite unavailable"); return; }
    const { options, stateDbPath } = stateFixture(t, {});
    const db = new DatabaseSync(stateDbPath);
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    insert.run("cursorAuth/accessToken", cbcToken(jwt("unknown"), "key"));
    insert.run("cursorAuth/cachedScopedProfile", JSON.stringify({ authId: "auth0|user_SQLITE" }));
    db.close();
    options.deps = {
      env: {},
      execFileSync(command) {
        if (command === "sqlite3") throw Object.assign(new Error("sqlite3 unavailable"), { code: "ENOENT" });
        if (command === "/usr/bin/security") return "key";
        throw new Error("unexpected command");
      },
    };
    assert.equal(extractCursorAuth(options).userId, "user_SQLITE");
  });

  it("restores encrypted auth with cachedScopedProfile and no cli-config authInfo (#998)", (t) => {
    const token = jwt("unrecognized-subject");
    const { options } = stateFixture(t, {
      "cursorAuth/accessToken": cbcToken(token, "key"),
      "cursorAuth/cachedScopedProfile": JSON.stringify({ authId: "google-oauth2|user_MIGRATED" }),
    }, { cliConfig: { theme: "dark" } });
    assert.deepEqual(extractCursorAuth(options), {
      accessToken: token, userId: "user_MIGRATED",
      cookie: `WorkosCursorSessionToken=user_MIGRATED%3A%3A${token}`,
    });
    assert.deepEqual(extractCursorSessionToken(options), {
      userId: "user_MIGRATED", cookie: `WorkosCursorSessionToken=user_MIGRATED%3A%3A${token}`,
    });
  });

  it("reads profile/membership identities without decrypting or consulting a keychain", (t) => {
    for (const profile of [undefined, "{broken", JSON.stringify({ authId: 123 }), "null"]) {
      const { stateDbPath, deps, commands } = stateFixture(t, {
        "cursorAuth/accessToken": "cursor-safe-storage:v1:unavailable",
        "cursorAuth/cachedScopedProfile": profile,
        "cursorAuth/stripeMembershipAuthId": "user_MEMBERSHIP",
      });
      assert.equal(readCursorUserIdFromStateDb(stateDbPath, deps), "user_MEMBERSHIP");
      assert.deepEqual(commands, ["sqlite3", "sqlite3"]);
    }
  });

  it("uses membership authId when the profile is absent and preserves OAuth subjects", (t) => {
    const { options } = stateFixture(t, {
      "cursorAuth/accessToken": cbcToken(jwt("unknown"), "key"),
      "cursorAuth/stripeMembershipAuthId": "google-oauth2|123456789",
    });
    assert.equal(extractCursorAuth(options).userId, "google-oauth2|123456789");
  });

  it("keeps cli-config precedence and the legacy JWT subject fallback", (t) => {
    const { options } = stateFixture(t, {
      "cursorAuth/accessToken": jwt(),
      "cursorAuth/cachedScopedProfile": JSON.stringify({ authId: "auth0|user_PROFILE" }),
    }, { cliConfig: { authInfo: { authId: "auth0|user_CLI" } } });
    assert.equal(extractCursorAuth(options).userId, "user_CLI");
    const fallback = stateFixture(t, { "cursorAuth/accessToken": cbcToken(jwt(), "key") });
    assert.equal(extractCursorAuth(fallback.options).userId, "user_TEST");
  });

  it("does not build a cookie from an undecryptable token even with a valid identity", (t) => {
    const { options } = stateFixture(t, {
      "cursorAuth/accessToken": cbcToken(jwt(), "different-key"),
      "cursorAuth/stripeMembershipAuthId": "user_TEST",
    });
    assert.equal(extractCursorAuth(options), null);
  });

  it("rejects invalid profile/identity values instead of throwing or injecting cookie fields", (t) => {
    for (const authId of [false, {}, [], "auth0|bad; other=cookie", "github|bad\r\nheader"]) {
      const { options } = stateFixture(t, {
        "cursorAuth/accessToken": jwt("unknown"),
        "cursorAuth/cachedScopedProfile": JSON.stringify({ authId }),
      });
      assert.equal(extractCursorAuth(options), null);
    }
  });
});
