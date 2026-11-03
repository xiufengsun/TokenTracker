const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  parseCursorCsv,
  isCursorBillableKind,
  normalizeCursorUsage,
  isCursorInstalled,
  readCursorAccessTokenFromStateDb,
  extractCursorAuth,
  extractCursorSessionToken,
  resolveCursorPaths,
  fetchCursorUsageCsv,
  decodeCursorSandAccessStatus,
  decodeCursorSandUsageStatus,
  fetchCursorSandAccessStatus,
  fetchCursorSandUsageStatus,
} = require("../src/lib/cursor-config");

function makeCursorJwt(userId = "user_TEST123") {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: `auth0|${userId}` })).toString("base64url");
  return `${header}.${payload}.sig`;
}

// ── parseCursorCsv — new format ──

describe("parseCursorCsv — new format", () => {
  const csvText = `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-03-20T06:56:12.521Z","Included","composer-2-fast","No","160000","159990","578207","2055","740252","0.49"
"2026-03-19T10:00:00.000Z","Included","claude-4.6-sonnet-medium-thinking","Yes","50000","40000","10000","3000","103000","0.32"`;

  it("returns 2 records", () => {
    const records = parseCursorCsv(csvText);
    assert.equal(records.length, 2);
  });

  it("extracts fields correctly for the first record", () => {
    const records = parseCursorCsv(csvText);
    const r = records[0];
    assert.equal(r.date, "2026-03-20T06:56:12.521Z");
    assert.equal(r.model, "composer-2-fast");
    assert.equal(r.kind, "Included");
    assert.equal(r.maxMode, "No");
    assert.equal(r.inputTokens, 159990);
    assert.equal(r.cacheWriteTokens, 10); // 160000 - 159990
    assert.equal(r.cacheReadTokens, 578207);
    assert.equal(r.outputTokens, 2055);
    assert.equal(r.totalTokens, 740252);
    assert.equal(r.cost, 0.49);
  });

  it("extracts fields correctly for the second record", () => {
    const records = parseCursorCsv(csvText);
    const r = records[1];
    assert.equal(r.date, "2026-03-19T10:00:00.000Z");
    assert.equal(r.model, "claude-4.6-sonnet-medium-thinking");
    assert.equal(r.maxMode, "Yes");
    assert.equal(r.inputTokens, 40000);
    assert.equal(r.cacheWriteTokens, 10000); // 50000 - 40000
    assert.equal(r.cacheReadTokens, 10000);
    assert.equal(r.outputTokens, 3000);
    assert.equal(r.totalTokens, 103000);
    assert.equal(r.cost, 0.32);
  });
});

// ── parseCursorCsv — newest format with Cloud Agent ID / Automation ID ──

describe("parseCursorCsv — with Cloud Agent ID columns", () => {
  const csvText = `Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-04-16T03:32:33.284Z","","","On-Demand","composer-2-fast","No","0","3189","194368","1815","199372","0.11"
"2026-04-15T03:39:53.013Z","","","On-Demand","auto","No","0","132586","93728","2303","228617","0.20"`;

  it("resolves model by header name, not fixed index", () => {
    const records = parseCursorCsv(csvText);
    assert.equal(records.length, 2);
    assert.equal(records[0].model, "composer-2-fast");
    assert.equal(records[0].kind, "On-Demand");
    assert.equal(records[0].inputTokens, 3189);
    assert.equal(records[0].cacheReadTokens, 194368);
    assert.equal(records[0].outputTokens, 1815);
    assert.equal(records[0].totalTokens, 199372);
    assert.equal(records[0].sourceScope, "account");
    assert.equal(records[0].billableKind, "billable");
    assert.equal(records[1].model, "auto");
  });
});

// ── parseCursorCsv — request-only rows (issue #998) ──

describe("parseCursorCsv — request-only rows", () => {
  const csvText = `Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-10-01T08:00:00.000Z","","","Included","grok-bot-automation","No","0","0","0","0","0","0.00"
"2026-10-01T09:00:00.000Z","","","Included","","No","0","0","0","0","0","0.00"
"2026-10-01T10:00:00.000Z","","","Included","auto","No","0","0","500","0","0","0.00"`;

  it("keeps a 0-token row that carries a model identity", () => {
    const records = parseCursorCsv(csvText);
    assert.equal(records.length, 2);
    const r = records[0];
    assert.equal(r.date, "2026-10-01T08:00:00.000Z");
    assert.equal(r.model, "grok-bot-automation");
    assert.equal(r.kind, "Included");
    assert.equal(r.inputTokens, 0);
    assert.equal(r.cacheReadTokens, 0);
    assert.equal(r.outputTokens, 0);
    assert.equal(r.totalTokens, 0);
  });

  it("still drops a 0-token row without any model", () => {
    const records = parseCursorCsv(csvText);
    assert.ok(!records.some((r) => r.model === ""));
  });

  it("keeps a cache-read-only row even when the Total column is 0", () => {
    // Component columns are the source of truth: isAllZeroUsage downstream
    // counts cacheReadTokens, so dropping on Total Tokens alone would lose
    // rows the incremental parser would otherwise import.
    const records = parseCursorCsv(csvText);
    const r = records.find((rec) => rec.model === "auto");
    assert.ok(r, "cache-read-only row kept");
    assert.equal(r.cacheReadTokens, 500);
    assert.equal(r.totalTokens, 0);
  });
});

describe("Cursor billing kind classification", () => {
  it("treats included and on-demand usage as billable-ish", () => {
    assert.equal(isCursorBillableKind("Included"), true);
    assert.equal(isCursorBillableKind("On-Demand"), true);
  });

  it("treats free and no-charge errored usage as non-billable", () => {
    assert.equal(isCursorBillableKind("Free"), false);
    assert.equal(isCursorBillableKind("Errored, No Charge"), false);
  });
});

// ── parseCursorCsv — old format ──

describe("parseCursorCsv — old format", () => {
  const csvText = `Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you
2025-02-01,gpt-4o,1000,500,200,300,2000,$0.10,$0.10`;

  it("parses old format correctly", () => {
    const records = parseCursorCsv(csvText);
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.date, "2025-02-01");
    assert.equal(r.model, "gpt-4o");
    assert.equal(r.kind, "unknown");
    assert.equal(r.maxMode, "No");
    assert.equal(r.inputTokens, 500);
    assert.equal(r.cacheWriteTokens, 500); // 1000 - 500
    assert.equal(r.cacheReadTokens, 200);
    assert.equal(r.outputTokens, 300);
    assert.equal(r.totalTokens, 2000);
    assert.equal(r.cost, 0.1);
  });
});

// ── parseCursorCsv — empty/invalid ──

describe("parseCursorCsv — empty/invalid", () => {
  it("returns [] for empty string", () => {
    assert.deepStrictEqual(parseCursorCsv(""), []);
  });

  it("returns [] for header only", () => {
    const csv = "Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";
    assert.deepStrictEqual(parseCursorCsv(csv), []);
  });
});

// ── normalizeCursorUsage ──

describe("normalizeCursorUsage", () => {
  it("produces standard format output", () => {
    const record = {
      inputTokens: 1000,
      cacheWriteTokens: 200,
      cacheReadTokens: 300,
      outputTokens: 500,
    };
    const norm = normalizeCursorUsage(record);
    assert.equal(norm.input_tokens, 1000);
    assert.equal(norm.cached_input_tokens, 300);
    assert.equal(norm.cache_creation_input_tokens, 200);
    assert.equal(norm.output_tokens, 500);
    assert.equal(norm.reasoning_output_tokens, 0);
    // total = input + output + cacheWrite + cacheRead = 1000 + 500 + 200 + 300
    assert.equal(norm.total_tokens, 2000);
  });
});

// ── normalizeCursorUsage — edge cases ──

describe("normalizeCursorUsage — edge cases", () => {
  it("all zeros produce all zeros", () => {
    const norm = normalizeCursorUsage({
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
    assert.equal(norm.input_tokens, 0);
    assert.equal(norm.cached_input_tokens, 0);
    assert.equal(norm.cache_creation_input_tokens, 0);
    assert.equal(norm.output_tokens, 0);
    assert.equal(norm.total_tokens, 0);
  });

  it("missing fields default to 0", () => {
    const norm = normalizeCursorUsage({});
    assert.equal(norm.input_tokens, 0);
    assert.equal(norm.cached_input_tokens, 0);
    assert.equal(norm.cache_creation_input_tokens, 0);
    assert.equal(norm.output_tokens, 0);
    assert.equal(norm.total_tokens, 0);
  });

  it("negative values are clamped to 0", () => {
    const norm = normalizeCursorUsage({
      inputTokens: -100,
      cacheWriteTokens: -50,
      cacheReadTokens: -30,
      outputTokens: -10,
    });
    assert.equal(norm.input_tokens, 0);
    assert.equal(norm.cached_input_tokens, 0);
    assert.equal(norm.cache_creation_input_tokens, 0);
    assert.equal(norm.output_tokens, 0);
    assert.equal(norm.total_tokens, 0);
  });
});

// ── resolveCursorPaths ──

describe("resolveCursorPaths", () => {
  it("uses ~/Library/Application Support/Cursor on macOS", () => {
    const { appDir, stateDbPath } = resolveCursorPaths({
      home: "/Users/alice",
      platform: "darwin",
      env: {},
    });
    assert.equal(appDir, "/Users/alice/Library/Application Support/Cursor");
    assert.equal(
      stateDbPath,
      "/Users/alice/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
  });

  it("uses %APPDATA%\\Cursor on Windows when APPDATA is set", () => {
    const { appDir } = resolveCursorPaths({
      home: "C:\\Users\\alice",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
    });
    // path.join uses the host separator; just check the suffix
    assert.ok(
      appDir.endsWith("Cursor"),
      `expected appDir to end with Cursor, got ${appDir}`,
    );
    assert.ok(
      appDir.includes("AppData") && appDir.includes("Roaming"),
      `expected AppData/Roaming in path, got ${appDir}`,
    );
  });

  it("falls back to <home>/AppData/Roaming/Cursor on Windows when APPDATA is missing", () => {
    const { appDir } = resolveCursorPaths({
      home: "C:\\Users\\alice",
      platform: "win32",
      env: {},
    });
    assert.ok(
      appDir.includes("AppData") && appDir.includes("Roaming") && appDir.endsWith("Cursor"),
      `expected fallback AppData/Roaming/Cursor, got ${appDir}`,
    );
  });

  it("uses XDG_CONFIG_HOME on Linux when set", () => {
    const { appDir } = resolveCursorPaths({
      home: "/home/alice",
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/home/alice/.cfg" },
    });
    assert.equal(appDir, "/home/alice/.cfg/Cursor");
  });

  it("falls back to ~/.config/Cursor on Linux", () => {
    const { appDir } = resolveCursorPaths({
      home: "/home/alice",
      platform: "linux",
      env: {},
    });
    assert.equal(appDir, "/home/alice/.config/Cursor");
  });

  it("keeps cliConfigPath at ~/.cursor/cli-config.json on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const { cliConfigPath } = resolveCursorPaths({
        home: "/h",
        platform,
        env: { APPDATA: "C:\\AppData" },
      });
      assert.ok(
        cliConfigPath.endsWith("cli-config.json") && cliConfigPath.includes(".cursor"),
        `[${platform}] expected ~/.cursor/cli-config.json, got ${cliConfigPath}`,
      );
    }
  });
});

// ── isCursorInstalled ──

describe("isCursorInstalled", () => {
  it("returns a boolean", () => {
    const result = isCursorInstalled();
    assert.equal(typeof result, "boolean");
  });

  it("returns false when the resolved appDir does not exist (Windows)", () => {
    const result = isCursorInstalled({
      home: "/tmp/nonexistent-cursor-windows-home",
      platform: "win32",
      env: { APPDATA: "/tmp/nonexistent-cursor-appdata" },
    });
    assert.equal(result, false);
  });

  it("returns false when the resolved appDir does not exist (Linux)", () => {
    const result = isCursorInstalled({
      home: "/tmp/nonexistent-cursor-linux-home",
      platform: "linux",
      env: {},
    });
    assert.equal(result, false);
  });
});

// ── extractCursorSessionToken ──

describe("extractCursorSessionToken", () => {
  it("returns null for non-existent home dir", () => {
    const result = extractCursorSessionToken({ home: "/tmp/nonexistent-cursor-test-home" });
    assert.equal(result, null);
  });

  it("reads the Cursor access token via sqlite3 CLI", () => {
    const jwt = makeCursorJwt();
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-db-")), "state.vscdb");
    fs.writeFileSync(dbPath, "", "utf8");
    const token = readCursorAccessTokenFromStateDb(dbPath, {
      execFileSync: (cmd, args, opts) => {
        assert.equal(cmd, "sqlite3");
        assert.deepEqual(args, [
          "-json",
          dbPath,
          "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';",
        ]);
        assert.equal(opts.encoding, "utf8");
        return JSON.stringify([{ value: jwt }]);
      },
      requireFn: () => {
        throw new Error("node:sqlite should not be used when sqlite3 works");
      },
      env: {},
    });

    assert.equal(token, jwt);
  });

  it("falls back to node:sqlite when sqlite3 CLI is unavailable", () => {
    const jwt = makeCursorJwt();
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-db-")), "state.vscdb");
    fs.writeFileSync(dbPath, "", "utf8");
    let closed = false;
    const token = readCursorAccessTokenFromStateDb(dbPath, {
      execFileSync: () => {
        throw new Error("spawn sqlite3 ENOENT");
      },
      requireFn: (name) => {
        assert.equal(name, "node:sqlite");
        return {
          DatabaseSync: class FakeDatabaseSync {
            constructor(actualDbPath, options) {
              assert.equal(actualDbPath, dbPath);
              assert.deepEqual(options, { readOnly: true });
            }

            prepare(sql) {
              assert.equal(sql, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';");
              return {
                all() {
                  return [{ value: ` ${jwt}\n` }];
                },
              };
            }

            close() {
              closed = true;
            }
          },
        };
      },
      env: {},
    });

    assert.equal(token, jwt);
    assert.equal(closed, true);
  });

  it("returns null when neither sqlite reader can read the token", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-db-")), "state.vscdb");
    fs.writeFileSync(dbPath, "", "utf8");
    const token = readCursorAccessTokenFromStateDb(dbPath, {
      execFileSync: () => {
        throw new Error("spawn sqlite3 ENOENT");
      },
      requireFn: () => {
        throw new Error("No such built-in module: node:sqlite");
      },
      env: {},
      stderr: { write() {} },
    });

    assert.equal(token, null);
  });

  it("builds the Cursor cookie when token reading falls back to node:sqlite", () => {
    const jwt = makeCursorJwt("user_FALLBACK");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-home-"));
    const { stateDbPath } = resolveCursorPaths({ home, env: {} });
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    fs.writeFileSync(stateDbPath, "", "utf8");
    const result = extractCursorSessionToken({
      home,
      env: {},
      deps: {
        execFileSync: () => {
          throw new Error("spawn sqlite3 ENOENT");
        },
        requireFn: () => ({
          DatabaseSync: class FakeDatabaseSync {
            prepare() {
              return {
                all() {
                  return [{ value: jwt }];
                },
              };
            }

            close() {}
          },
        }),
        env: {},
      },
    });

    assert.deepEqual(result, {
      cookie: `WorkosCursorSessionToken=user_FALLBACK%3A%3A${jwt}`,
      userId: "user_FALLBACK",
    });
  });

  it("exposes the bearer token only through the full Cursor auth helper", () => {
    const jwt = makeCursorJwt("user_RPC");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-rpc-auth-"));
    const { stateDbPath } = resolveCursorPaths({ home, env: {} });
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    fs.writeFileSync(stateDbPath, "", "utf8");
    const deps = {
      execFileSync: () => JSON.stringify([{ value: jwt }]),
      requireFn: () => { throw new Error("sqlite3 CLI used"); },
      env: {},
    };

    assert.deepEqual(extractCursorAuth({ home, env: {}, deps }), {
      cookie: `WorkosCursorSessionToken=user_RPC%3A%3A${jwt}`,
      userId: "user_RPC",
      accessToken: jwt,
    });
    assert.equal(Object.hasOwn(extractCursorSessionToken({ home, env: {}, deps }), "accessToken"), false);
  });

  it("accepts Google OAuth subject from cli-config.json (issue #88)", () => {
    const subject = "google-oauth2|105551234567890123456";
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: subject })).toString("base64url");
    const jwt = `${header}.${payload}.sig`;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-google-"));
    const { stateDbPath, cliConfigPath } = resolveCursorPaths({ home, env: {} });
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    fs.writeFileSync(stateDbPath, "", "utf8");
    fs.mkdirSync(path.dirname(cliConfigPath), { recursive: true });
    fs.writeFileSync(cliConfigPath, JSON.stringify({ authInfo: { authId: subject } }), "utf8");

    const result = extractCursorSessionToken({
      home,
      env: {},
      deps: {
        execFileSync: () => JSON.stringify([{ value: jwt }]),
        requireFn: () => {
          throw new Error("sqlite3 CLI used");
        },
        env: {},
      },
    });

    assert.deepEqual(result, {
      cookie: `WorkosCursorSessionToken=${subject}%3A%3A${jwt}`,
      userId: subject,
    });
  });

  it("falls back to Google OAuth subject from JWT when cli-config is missing", () => {
    const subject = "google-oauth2|987654321098765432109";
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: subject })).toString("base64url");
    const jwt = `${header}.${payload}.sig`;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-google-jwt-"));
    const { stateDbPath } = resolveCursorPaths({ home, env: {} });
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    fs.writeFileSync(stateDbPath, "", "utf8");

    const result = extractCursorSessionToken({
      home,
      env: {},
      deps: {
        execFileSync: () => JSON.stringify([{ value: jwt }]),
        requireFn: () => {
          throw new Error("sqlite3 CLI used");
        },
        env: {},
      },
    });

    assert.deepEqual(result, {
      cookie: `WorkosCursorSessionToken=${subject}%3A%3A${jwt}`,
      userId: subject,
    });
  });

  it("accepts github WorkOS subject", () => {
    const subject = "github|42";
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: subject })).toString("base64url");
    const jwt = `${header}.${payload}.sig`;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-gh-"));
    const { stateDbPath } = resolveCursorPaths({ home, env: {} });
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    fs.writeFileSync(stateDbPath, "", "utf8");

    const result = extractCursorSessionToken({
      home,
      env: {},
      deps: {
        execFileSync: () => JSON.stringify([{ value: jwt }]),
        requireFn: () => {
          throw new Error("sqlite3 CLI used");
        },
        env: {},
      },
    });

    assert.equal(result.userId, subject);
  });

  it("still returns null for unrecognized JWT subjects", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "saml|enterprise-xyz" })).toString("base64url");
    const jwt = `${header}.${payload}.sig`;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-cursor-unknown-"));
    const { stateDbPath } = resolveCursorPaths({ home, env: {} });
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    fs.writeFileSync(stateDbPath, "", "utf8");

    const result = extractCursorSessionToken({
      home,
      env: {},
      deps: {
        execFileSync: () => JSON.stringify([{ value: jwt }]),
        requireFn: () => {
          throw new Error("sqlite3 CLI used");
        },
        env: {},
      },
    });

    assert.equal(result, null);
  });
});

// ── fetchCursorUsageCsv / fetchUrlRaw (injectable fetch) ──

const CURSOR_CSV_URL = "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";
const CURSOR_CSV_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CURSOR_CSV_COOKIE = "WorkosCursorSessionToken=user_TEST%3A%3Ajwt";
const CURSOR_CSV_BODY = "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost\n2026-01-01,gpt-4o,1,1,0,1,2,$0.01";

function timeoutError(name = "TimeoutError") {
  const err = new Error("The operation was aborted due to timeout");
  err.name = name;
  return err;
}

function jsonLikeResponse({ status, body = "", headers = {} }) {
  return {
    status,
    headers: new Headers(headers),
    async text() {
      return body;
    },
  };
}

function protoVarint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function protoVarintField(fieldNumber, value) {
  return Buffer.concat([protoVarint(BigInt(fieldNumber) << 3n), protoVarint(value)]);
}

function protoBytesField(fieldNumber, value) {
  const body = Buffer.from(value);
  return Buffer.concat([
    protoVarint((BigInt(fieldNumber) << 3n) | 2n),
    protoVarint(body.length),
    body,
  ]);
}

function protoDoubleField(fieldNumber, value) {
  const body = Buffer.alloc(8);
  body.writeDoubleLE(value, 0);
  return Buffer.concat([protoVarint((BigInt(fieldNumber) << 3n) | 1n), body]);
}

function protoTimestamp(iso) {
  const milliseconds = Date.parse(iso);
  const seconds = Math.floor(milliseconds / 1000);
  const nanos = (milliseconds - seconds * 1000) * 1_000_000;
  return Buffer.concat([protoVarintField(1, seconds), protoVarintField(2, nanos)]);
}

function binaryResponse({ status = 200, body = Buffer.alloc(0), contentType = "application/proto" } = {}) {
  const bytes = Buffer.from(body);
  return {
    status,
    headers: new Headers({ "content-type": contentType }),
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

describe("Cursor Grok Bot protobuf RPC", () => {
  const accessToken = "cursor-access-token";
  const usageBody = Buffer.concat([
    protoBytesField(1, protoTimestamp("2026-08-26T17:22:03.913Z")),
    protoBytesField(2, protoTimestamp("2026-08-31T10:37:44.547Z")),
    protoDoubleField(3, 0),
    protoVarintField(5, 2),
    protoVarintField(7, 1),
    protoVarintField(8, 1),
    // Unknown length-delimited fields must remain forward-compatible.
    protoBytesField(12, Buffer.from("ignored")),
  ]);

  it("decodes access eligibility and ignores newer response fields", () => {
    const body = Buffer.concat([
      protoVarintField(1, 1),
      protoVarintField(3, 1),
      protoBytesField(4, Buffer.from("pro")),
      protoVarintField(11, 1),
    ]);
    assert.deepEqual(decodeCursorSandAccessStatus(body), {
      state: 1,
      blockReason: 1,
      granted: true,
    });
  });

  it("decodes zero-percent usage, exact timestamps, and reset metadata", () => {
    assert.deepEqual(decodeCursorSandUsageStatus(usageBody), {
      currentPeriodStart: "2026-08-26T17:22:03.913Z",
      nextResetAt: "2026-08-31T10:37:44.547Z",
      usagePercent: 0,
      includedLimitZero: false,
      availableBankedResetCount: 2,
      usesPooledEnterpriseAllowance: false,
      hasAvailableUsage: true,
      hasNonZeroIncludedLimit: true,
    });
  });

  it("calls only the pinned read-only RPCs with an empty protobuf body", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/GetSandAccessStatus")) {
        return binaryResponse({ body: protoVarintField(1, 1) });
      }
      return binaryResponse({ body: usageBody });
    };

    assert.equal((await fetchCursorSandAccessStatus({ accessToken, fetchImpl })).granted, true);
    assert.equal((await fetchCursorSandUsageStatus({ accessToken, fetchImpl })).usagePercent, 0);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call.url, /^https:\/\/api2\.cursor\.sh\/aiserver\.v1\.DashboardService\/GetSand(?:Access|Usage)Status$/);
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.redirect, "error");
      assert.equal(call.init.headers.Authorization, `Bearer ${accessToken}`);
      assert.equal(call.init.headers["Content-Type"], "application/proto");
      assert.equal(call.init.headers["Connect-Protocol-Version"], "1");
      assert.equal(Buffer.from(call.init.body).length, 0);
      assert.ok(call.init.signal);
    }
  });

  it("rejects expired auth and non-protobuf responses", async () => {
    await assert.rejects(
      () => fetchCursorSandUsageStatus({
        accessToken,
        fetchImpl: async () => binaryResponse({ status: 401 }),
      }),
      { message: "Cursor session expired — re-login in Cursor to refresh" },
    );
    await assert.rejects(
      () => fetchCursorSandUsageStatus({
        accessToken,
        fetchImpl: async () => binaryResponse({ contentType: "text/html" }),
      }),
      { message: "Cursor API returned an unexpected response type" },
    );
  });
});

function assertCsvRequestInit(init, { redirect = "manual" } = {}) {
  assert.ok(init);
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, redirect);
  assert.equal(init.headers.Accept, "*/*");
  assert.equal(init.headers.Cookie, CURSOR_CSV_COOKIE);
  assert.equal(init.headers.Referer, "https://www.cursor.com/settings");
  assert.equal(init.headers["User-Agent"], CURSOR_CSV_UA);
  assert.ok(init.signal, "expected AbortSignal.timeout to be passed through");
}

describe("fetchCursorUsageCsv — injectable fetch", () => {
  it("returns the raw CSV text on 200", async () => {
    const calls = [];
    const csv = await fetchCursorUsageCsv({
      cookie: CURSOR_CSV_COOKIE,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonLikeResponse({ status: 200, body: CURSOR_CSV_BODY });
      },
    });
    assert.equal(csv, CURSOR_CSV_BODY);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CURSOR_CSV_URL);
    assertCsvRequestInit(calls[0].init);
  });

  it("throws the session-expired message on 401", async () => {
    await assert.rejects(
      () =>
        fetchCursorUsageCsv({
          cookie: CURSOR_CSV_COOKIE,
          fetchImpl: async () => jsonLikeResponse({ status: 401 }),
        }),
      { message: "Cursor session expired — re-login in Cursor to refresh" },
    );
  });

  it("throws the session-expired message on 403", async () => {
    await assert.rejects(
      () =>
        fetchCursorUsageCsv({
          cookie: CURSOR_CSV_COOKIE,
          fetchImpl: async () => jsonLikeResponse({ status: 403 }),
        }),
      { message: "Cursor session expired — re-login in Cursor to refresh" },
    );
  });

  it("throws Cursor API returned <status> on other non-200", async () => {
    await assert.rejects(
      () =>
        fetchCursorUsageCsv({
          cookie: CURSOR_CSV_COOKIE,
          fetchImpl: async () => jsonLikeResponse({ status: 500 }),
        }),
      { message: "Cursor API returned 500" },
    );
  });

  it("follows a 308 Location once via fetchUrlRaw and returns that text", async () => {
    const location = "https://www.cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";
    const calls = [];
    const csv = await fetchCursorUsageCsv({
      cookie: CURSOR_CSV_COOKIE,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return jsonLikeResponse({ status: 308, headers: { Location: location } });
        }
        return jsonLikeResponse({ status: 200, body: CURSOR_CSV_BODY });
      },
    });
    assert.equal(csv, CURSOR_CSV_BODY);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, CURSOR_CSV_URL);
    assert.equal(calls[1].url, location);
    assertCsvRequestInit(calls[0].init);
    assertCsvRequestInit(calls[1].init);
  });

  it("follows 301 and 302 the same way as 308", async () => {
    for (const status of [301, 302]) {
      const location = `https://www.cursor.com/redirect-${status}`;
      const calls = [];
      const csv = await fetchCursorUsageCsv({
        cookie: CURSOR_CSV_COOKIE,
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          if (String(url) === CURSOR_CSV_URL) {
            return jsonLikeResponse({ status, headers: { Location: location } });
          }
          return jsonLikeResponse({ status: 200, body: `csv-${status}` });
        },
      });
      assert.equal(csv, `csv-${status}`);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, location);
    }
  });

  it("resolves a relative Location against the CSV URL", async () => {
    const calls = [];
    const csv = await fetchCursorUsageCsv({
      cookie: CURSOR_CSV_COOKIE,
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) {
          return jsonLikeResponse({ status: 308, headers: { Location: "/api/moved-csv" } });
        }
        return jsonLikeResponse({ status: 200, body: CURSOR_CSV_BODY });
      },
    });
    assert.equal(csv, CURSOR_CSV_BODY);
    assert.equal(calls[1], "https://cursor.com/api/moved-csv");
  });

  it("refuses to forward the session cookie to an off-origin redirect", async () => {
    for (const location of [
      "https://evil.example.com/steal",
      "https://cursor.com.evil.example.com/steal",
      "http://cursor.com/downgraded",
      "//evil.example.com/protocol-relative",
    ]) {
      const calls = [];
      await assert.rejects(
        () =>
          fetchCursorUsageCsv({
            cookie: CURSOR_CSV_COOKIE,
            fetchImpl: async (url) => {
              calls.push(String(url));
              if (calls.length === 1) {
                return jsonLikeResponse({ status: 308, headers: { Location: location } });
              }
              return jsonLikeResponse({ status: 200, body: CURSOR_CSV_BODY });
            },
          }),
        { message: "Cursor API redirect to an untrusted origin" },
        `expected ${location} to be rejected`,
      );
      assert.equal(calls.length, 1, `${location} must not trigger a second request`);
    }
  });

  it("throws when a 308 has no Location header", async () => {
    await assert.rejects(
      () =>
        fetchCursorUsageCsv({
          cookie: CURSOR_CSV_COOKIE,
          fetchImpl: async () => jsonLikeResponse({ status: 308 }),
        }),
      { message: "Cursor API redirect without Location header" },
    );
  });

  it("surfaces fetchUrlRaw non-200 as Cursor API returned <status> from <url>", async () => {
    const location = "https://www.cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";
    await assert.rejects(
      () =>
        fetchCursorUsageCsv({
          cookie: CURSOR_CSV_COOKIE,
          fetchImpl: async (url) => {
            if (String(url) === CURSOR_CSV_URL) {
              return jsonLikeResponse({ status: 308, headers: { Location: location } });
            }
            return jsonLikeResponse({ status: 502 });
          },
        }),
      { message: `Cursor API returned 502 from ${location}` },
    );
  });

  it("maps TimeoutError to Cursor API request timed out", async () => {
    await assert.rejects(
      () =>
        fetchCursorUsageCsv({
          cookie: CURSOR_CSV_COOKIE,
          fetchImpl: async () => {
            throw timeoutError("TimeoutError");
          },
        }),
      { message: "Cursor API request timed out" },
    );
  });

  it("maps AbortError to Cursor API request timed out", async () => {
    await assert.rejects(
      () =>
        fetchCursorUsageCsv({
          cookie: CURSOR_CSV_COOKIE,
          fetchImpl: async () => {
            throw timeoutError("AbortError");
          },
        }),
      { message: "Cursor API request timed out" },
    );
  });

  it("maps a timeout on the redirect hop the same way", async () => {
    const location = "https://www.cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";
    await assert.rejects(
      () =>
        fetchCursorUsageCsv({
          cookie: CURSOR_CSV_COOKIE,
          fetchImpl: async (url) => {
            if (String(url) === CURSOR_CSV_URL) {
              return jsonLikeResponse({ status: 308, headers: { Location: location } });
            }
            throw timeoutError("TimeoutError");
          },
        }),
      { message: "Cursor API request timed out" },
    );
  });

  it("uses injectable fetch (undici-dispatcher path), not https.request", async () => {
    let fetchImplCalled = false;
    await fetchCursorUsageCsv({
      cookie: CURSOR_CSV_COOKIE,
      fetchImpl: async (url, init) => {
        fetchImplCalled = true;
        assert.equal(String(url), CURSOR_CSV_URL);
        assertCsvRequestInit(init);
        return jsonLikeResponse({ status: 200, body: "ok" });
      },
    });
    assert.equal(fetchImplCalled, true);

    const src = fs.readFileSync(path.join(__dirname, "../src/lib/cursor-config.js"), "utf8");
    assert.equal(src.includes("https.request"), false);
    assert.equal(src.includes('require("node:https")'), false);
    assert.match(src, /fetchImpl\s*=\s*fetch/);
    assert.match(src, /function fetchUrlRaw\(/);
    assert.match(src, /return fetchImpl\(urlStr,/);
  });
});
