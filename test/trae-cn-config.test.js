/**
 * TRAE Work CN config tests. Synthetic data only — no real JWTs / fixtures.
 *
 * The encrypted-tc-v5 coverage relies on a frozen static fixture (FIXTURE_B64)
 * produced once with the documented KDF + a fixed 32-byte salt, plus an
 * independent encryptor in this file that writes its own KDF. Neither imports
 * production `deriveTraeCnKeyIv`, so a broken production KDF fails the
 * decrypt assertions instead of being hidden by test-only encryption.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  TRAE_CN_HOME_ENV,
  TRAE_CN_AUTH_KEY,
  TRAE_CN_USAGE_URL,
  TRAE_CN_USAGE_DELAY_MS,
  resolveTraeCnStoragePath,
  decryptTraeCnBase64,
  parseTraeCnAuthValue,
  readTraeCnAuthFromStorage,
  extractTraeCnToken,
  fetchTraeCnUsagePage,
  fetchTraeCnUsage,
  fetchTraeCnUsageWindowed,
  fetchTraeCnUsageWithAuth,
} = require("../src/lib/trae-cn-config");

// Frozen fixture: encrypted with the documented KDF, fixed 32-byte salt.
const FIXTURE_B64 =
  "dGMFEAAA3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu/43q0BL3Fo+gI3mEsCEdP2c66sO1HLQB7bKIlHUL7xJg0PVJHLSzn/gDVQmH7Ksh0wflKSFHtHgz7rwynP4aOOx3CPgDR5lQ8neR7CWouH94Dh99HlsWwqo29etbVBVbTU18KIS74UPyA5ASAWnYHqKPQSfv8uCn6GOMfOyJPNPMI6Yz666PBNVFTastLi70ThZ6Lb/Gs+bjyTDrQnSfjDnDJPinjJejWWlboznbnME/rNkmc2LLMftj8jGqorIq4=";
const FIXTURE_TOKEN = "fake.jwt.eyJzdWIiOiJ0ZXN0IiwiZXhwIjo5OTk5OTk5OTk5fQ.sig";
const FIXTURE_AUTH = {
  token: FIXTURE_TOKEN,
  refreshToken: "synthetic-refresh",
  userId: "user-123",
};

// Independent encryptor — own copy of the documented constants + KDF.
const TEST_MAGIC = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
const TEST_JG = Buffer.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130,
  155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61,
  238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73,
  109, 139, 209, 37,
]);
const TEST_KG = Buffer.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25,
  181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176,
  200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99,
  85, 33, 12, 125,
]);

function testKdfSecret() {
  const secret = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) secret[i] = TEST_JG[i] ^ TEST_KG[i];
  return secret;
}

function testDerive(salt) {
  const kdfBuf = Buffer.concat([crypto.createHash("sha512").update(salt).digest(), testKdfSecret()]);
  // Vendor tc-v5 compatibility KDF, not password storage.
  const out = crypto.createHash("sha512").update(kdfBuf).digest();
  return { key: out.subarray(0, 16), iv: out.subarray(16, 32) };
}

function testEncrypt(plainText, salt = Buffer.alloc(32, 0x11)) {
  const plain = Buffer.from(plainText, "utf8");
  const { key, iv } = testDerive(salt);
  const hash = crypto.createHash("sha512").update(plain).digest();
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.concat([hash, plain])), cipher.final()]);
  return Buffer.concat([TEST_MAGIC, salt, ct]);
}

function makeTraeCnHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trae-cn-test-"));
}

function writeStorage(traeHome, value, { authKey = TRAE_CN_AUTH_KEY } = {}) {
  const dir = path.join(traeHome, "User", "globalStorage");
  fs.mkdirSync(dir, { recursive: true });
  const storagePath = path.join(dir, "storage.json");
  const payload = {};
  if (value !== undefined) payload[authKey] = value;
  fs.writeFileSync(storagePath, JSON.stringify(payload));
  return storagePath;
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test("resolveTraeCnStoragePath honors TOKENTRACKER_TRAE_CN_HOME override", () => {
  const override = "/tmp/cn-install";
  assert.equal(
    resolveTraeCnStoragePath({ env: { [TRAE_CN_HOME_ENV]: override } }),
    path.join(path.resolve(override), "User", "globalStorage", "storage.json"),
  );
});

test("resolveTraeCnStoragePath discovers the classic Trae CN client without an override", () => {
  const winParent = makeTraeCnHome();
  writeStorage(path.join(winParent, "Trae CN"));
  assert.equal(
    resolveTraeCnStoragePath({ platform: "win32", home: "C:\\u", env: { APPDATA: winParent } }),
    path.join(winParent, "Trae CN", "User", "globalStorage", "storage.json"),
  );
  const home = makeTraeCnHome();
  writeStorage(path.join(home, "Library", "Application Support", "Trae CN"));
  assert.equal(
    resolveTraeCnStoragePath({ platform: "darwin", home, env: {} }),
    path.join(home, "Library", "Application Support", "Trae CN", "User", "globalStorage", "storage.json"),
  );
});

test("resolveTraeCnStoragePath prefers TRAE SOLO CN when both clients are installed", () => {
  const parent = makeTraeCnHome();
  writeStorage(path.join(parent, "Trae CN"));
  writeStorage(path.join(parent, "TRAE SOLO CN"));
  assert.equal(
    resolveTraeCnStoragePath({ platform: "win32", home: "C:\\u", env: { APPDATA: parent } }),
    path.join(parent, "TRAE SOLO CN", "User", "globalStorage", "storage.json"),
  );
});

test("resolveTraeCnStoragePath returns null when no CN client is installed", () => {
  const parent = makeTraeCnHome();
  assert.equal(resolveTraeCnStoragePath({ platform: "win32", home: "C:\\u", env: { APPDATA: parent } }), null);
  assert.equal(resolveTraeCnStoragePath({ platform: "darwin", home: parent, env: {} }), null);
  // A whitespace-only override falls back to discovery, which finds nothing.
  assert.equal(
    resolveTraeCnStoragePath({ env: { [TRAE_CN_HOME_ENV]: "   " }, platform: "darwin", home: parent }),
    null,
  );
  // No verified CN app-data layout on other platforms yet.
  assert.equal(resolveTraeCnStoragePath({ platform: "linux", home: parent, env: {} }), null);
});

test("resolveTraeCnStoragePath finds the classic client through a junction", { skip: process.platform !== "win32" }, () => {
  const parent = makeTraeCnHome();
  const realHome = makeTraeCnHome();
  writeStorage(realHome);
  // mklink /D relocation is the community-standard way to move Trae CN off
  // C:; statSync follows the junction, so discovery needs no special casing.
  fs.symlinkSync(realHome, path.join(parent, "Trae CN"), "junction");
  assert.equal(
    resolveTraeCnStoragePath({ platform: "win32", home: "C:\\u", env: { APPDATA: parent } }),
    path.join(parent, "Trae CN", "User", "globalStorage", "storage.json"),
  );
});

test("resolveTraeCnStoragePath hands a non-file storage.json to the reader (fail-closed)", () => {
  const parent = makeTraeCnHome();
  const soloHome = path.join(parent, "TRAE SOLO CN");
  const storagePath = path.join(soloHome, "User", "globalStorage", "storage.json");
  fs.mkdirSync(storagePath, { recursive: true }); // directory named storage.json
  assert.equal(
    resolveTraeCnStoragePath({ platform: "win32", home: "C:\\u", env: { APPDATA: parent } }),
    storagePath,
  );
  assert.throws(
    () => readTraeCnAuthFromStorage({ platform: "win32", home: "C:\\u", env: { APPDATA: parent } }),
    (error) => {
      assert.equal(error.code, "TRAE_CN_STORAGE_UNREADABLE");
      assert.match(error.message, /could not be read/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Storage auth reading: plaintext + encrypted tc v5
// ---------------------------------------------------------------------------

test("frozen tc v5 fixture decrypts to the expected auth (broken-KDF detector)", () => {
  assert.deepEqual(parseTraeCnAuthValue(FIXTURE_B64), FIXTURE_AUTH);
  assert.equal(JSON.parse(decryptTraeCnBase64(FIXTURE_B64)).token, FIXTURE_TOKEN);
});

test("independent-encryptor round trip decrypts through production", () => {
  const blob = testEncrypt(JSON.stringify({ token: "roundtrip.jwt.abc", refreshToken: "x" }));
  assert.deepEqual(parseTraeCnAuthValue(blob.toString("base64")), { token: "roundtrip.jwt.abc", refreshToken: "x" });
});

test("readTraeCnAuthFromStorage reads plaintext JSON object auth", () => {
  const home = makeTraeCnHome();
  writeStorage(home, { token: "plain.jwt.1", refreshToken: "r1" });
  assert.deepEqual(
    readTraeCnAuthFromStorage({ env: { [TRAE_CN_HOME_ENV]: home }, platform: "darwin" }),
    { token: "plain.jwt.1", refreshToken: "r1" },
  );
});

test("readTraeCnAuthFromStorage reads plaintext JSON string auth", () => {
  const home = makeTraeCnHome();
  writeStorage(home, JSON.stringify({ token: "plain.jwt.2", refreshToken: "r2" }));
  assert.deepEqual(
    readTraeCnAuthFromStorage({ env: { [TRAE_CN_HOME_ENV]: home }, platform: "darwin" }),
    { token: "plain.jwt.2", refreshToken: "r2" },
  );
});

test("readTraeCnAuthFromStorage reads the encrypted tc v5 blob", () => {
  const home = makeTraeCnHome();
  writeStorage(home, FIXTURE_B64);
  const auth = readTraeCnAuthFromStorage({ env: { [TRAE_CN_HOME_ENV]: home }, platform: "darwin" });
  assert.equal(auth.token, FIXTURE_TOKEN);
  assert.equal(extractTraeCnToken(auth), FIXTURE_TOKEN);
});

test("readTraeCnAuthFromStorage returns null when not configured", () => {
  const home = makeTraeCnHome();
  const storagePath = path.join(home, "User", "globalStorage", "storage.json");
  assert.equal(readTraeCnAuthFromStorage({ env: { [TRAE_CN_HOME_ENV]: home }, platform: "darwin" }), null);
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, JSON.stringify({}));
  assert.equal(readTraeCnAuthFromStorage({ env: { [TRAE_CN_HOME_ENV]: home }, platform: "darwin" }), null);
});

// ---------------------------------------------------------------------------
// Malformed / tampered rejection (credential-safe errors)
// ---------------------------------------------------------------------------

test("malformed storage.json fails closed with a credential-safe error", () => {
  const home = makeTraeCnHome();
  const storagePath = path.join(home, "User", "globalStorage", "storage.json");
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, "{not json");
  assert.throws(
    () => readTraeCnAuthFromStorage({ env: { [TRAE_CN_HOME_ENV]: home }, platform: "darwin" }),
    /not valid JSON/,
  );
});

test("malformed plaintext JSON fails closed", () => {
  const home = makeTraeCnHome();
  writeStorage(home, "{broken");
  assert.throws(
    () => readTraeCnAuthFromStorage({ env: { [TRAE_CN_HOME_ENV]: home }, platform: "darwin" }),
    /auth JSON is malformed/,
  );
});

test("tampered ciphertext is rejected and leaks nothing", () => {
  const blob = Buffer.from(FIXTURE_B64, "base64");
  blob[blob.length - 16] ^= 0x01; // flip a byte in the ciphertext
  const tampered = blob.toString("base64");
  assert.throws(() => parseTraeCnAuthValue(tampered));
  try {
    parseTraeCnAuthValue(tampered);
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(!error.message.includes(FIXTURE_TOKEN), "error must not contain the token");
    assert.ok(!error.message.includes(tampered), "error must not contain the blob");
  }
});

test("wrong magic / too-short / bad base64 are rejected", () => {
  const blob = Buffer.from(FIXTURE_B64, "base64");
  blob[0] = 0x78; // "x"
  assert.throws(() => parseTraeCnAuthValue(blob.toString("base64")), /unknown format/);
  assert.throws(() => parseTraeCnAuthValue(Buffer.alloc(16).toString("base64")), /too short|unknown format/);
  assert.throws(() => parseTraeCnAuthValue("not-base64@#$"), /Trae CN auth/);
  assert.throws(() => parseTraeCnAuthValue(""), /empty|malformed/);
  assert.throws(() => parseTraeCnAuthValue(42), /missing or malformed/);
});

test("extractTraeCnToken extracts a nonempty JWT and rejects empty/missing", () => {
  assert.equal(extractTraeCnToken({ token: "  abc.jwt.xyz  " }), "abc.jwt.xyz");
  assert.throws(() => extractTraeCnToken({ token: "" }), /has no token/);
  assert.throws(() => extractTraeCnToken({}), /has no token/);
  assert.throws(() => extractTraeCnToken(null), /has no token/);
});

// ---------------------------------------------------------------------------
// Usage API page fetch
// ---------------------------------------------------------------------------

const JWT = "test.jwt.usage-123";
const START = 1700000000;
const END = 1700086400;

test("fetchTraeCnUsagePage sends the exact request", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return jsonResponse(200, { user_usage_group_by_sessions: [{ id: 1 }], total: 1 });
  };
  await fetchTraeCnUsagePage({
    jwt: JWT,
    start_time: START,
    end_time: END,
    page_num: 1,
    url: "https://attacker.example/redirect",
    fetchImpl,
  });
  assert.equal(captured.url, TRAE_CN_USAGE_URL);
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(captured.options.headers.Authorization, `Cloud-IDE-JWT ${JWT}`);
  assert.deepEqual(JSON.parse(captured.options.body), {
    usage_type: [7],
    start_time: START,
    end_time: END,
    page_num: 1,
    page_size: 20,
  });
});

test("fetchTraeCnUsagePage parses both documented wrappers", async () => {
  const topLevel = await fetchTraeCnUsagePage({
    jwt: JWT, start_time: START, end_time: END, page_num: 1,
    fetchImpl: async () => jsonResponse(200, { user_usage_group_by_sessions: [{ id: 1 }, { id: 2 }], total: 2 }),
  });
  assert.equal(topLevel.sessions.length, 2);
  assert.equal(topLevel.total, 2);

  const nested = await fetchTraeCnUsagePage({
    jwt: JWT, start_time: START, end_time: END, page_num: 1,
    fetchImpl: async () => jsonResponse(200, { data: { user_usage_group_by_sessions: [{ id: 3 }], total: 1 } }),
  });
  assert.equal(nested.sessions.length, 1);
  assert.equal(nested.total, 1);

  const noTotal = await fetchTraeCnUsagePage({
    jwt: JWT, start_time: START, end_time: END, page_num: 1,
    fetchImpl: async () => jsonResponse(200, { user_usage_group_by_sessions: [{ id: 9 }] }),
  });
  assert.equal(noTotal.sessions.length, 1);
  assert.equal(noTotal.total, null);
});

test("fetchTraeCnUsagePage fails closed when the session wrapper is missing", async () => {
  const bodies = [
    {},
    { data: {} },
    { data: { other: 1 } },
    { user_usage_group_by_sessions: "not-an-array" },
    { data: { user_usage_group_by_sessions: null } },
  ];
  for (const body of bodies) {
    await assert.rejects(
      fetchTraeCnUsagePage({ jwt: JWT, start_time: START, end_time: END, page_num: 1, fetchImpl: async () => jsonResponse(200, body) }),
      (error) => {
        assert.match(error.message, /missing the session list/);
        assert.ok(!error.message.includes(JWT), "schema error must not leak the JWT");
        return true;
      },
    );
  }
});

test("fetchTraeCnUsagePage accepts an explicit empty session array", async () => {
  const result = await fetchTraeCnUsagePage({
    jwt: JWT, start_time: START, end_time: END, page_num: 1,
    fetchImpl: async () => jsonResponse(200, { user_usage_group_by_sessions: [], total: 0 }),
  });
  assert.deepEqual(result.sessions, []);
  assert.equal(result.total, 0);
});

test("fetchTraeCnUsagePage validates start_time / end_time / page_size locally", async () => {
  const ok = () => async () => jsonResponse(200, { user_usage_group_by_sessions: [] });
  const page = (overrides) =>
    fetchTraeCnUsagePage({ jwt: JWT, start_time: START, end_time: END, page_num: 1, fetchImpl: ok(), ...overrides });

  await assert.rejects(page({ start_time: 0 }), /start_time must be a positive integer/);
  await assert.rejects(page({ start_time: -1 }), /start_time must be a positive integer/);
  await assert.rejects(page({ start_time: 1.5 }), /start_time must be a positive integer/);
  await assert.rejects(page({ start_time: Infinity }), /start_time must be a positive integer/);
  await assert.rejects(page({ start_time: "1700000000" }), /start_time must be a positive integer/);

  await assert.rejects(page({ end_time: 0 }), /end_time must be a positive integer/);
  await assert.rejects(page({ end_time: 1.5 }), /end_time must be a positive integer/);

  await assert.rejects(page({ start_time: END, end_time: START }), /start_time must not be after end_time/);

  await assert.rejects(page({ page_size: 0 }), /page_size must be a positive integer no greater than 20/);
  await assert.rejects(page({ page_size: -5 }), /page_size must be a positive integer no greater than 20/);
  await assert.rejects(page({ page_size: 21 }), /page_size must be a positive integer no greater than 20/);
  await assert.rejects(page({ page_size: 2.5 }), /page_size must be a positive integer no greater than 20/);

  const valid = await page({ page_size: 20, start_time: START, end_time: END });
  assert.deepEqual(valid.sessions, []);
  const smallPage = await page({ page_size: 5 });
  assert.equal(smallPage.page_size, 5);
});

test("fetchTraeCnUsagePage errors are useful and credential-safe", async () => {
  await assert.rejects(
    fetchTraeCnUsagePage({ jwt: JWT, start_time: START, end_time: END, page_num: 1, fetchImpl: async () => jsonResponse(401, {}) }),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.equal(error.status, 401);
      assert.equal(error.code, "AUTH_EXPIRED");
      assert.ok(!error.message.includes(JWT));
      return true;
    },
  );

  await assert.rejects(
    fetchTraeCnUsagePage({ jwt: JWT, start_time: START, end_time: END, page_num: 1, fetchImpl: async () => jsonResponse(500, {}) }),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.ok(!error.message.includes(JWT));
      return true;
    },
  );

  await assert.rejects(
    fetchTraeCnUsagePage({ jwt: JWT, start_time: START, end_time: END, page_num: 1, fetchImpl: async () => jsonResponse(200, { code: 10001, data: {} }) }),
    (error) => {
      assert.match(error.message, /error code 10001/);
      assert.equal(error.apiCode, 10001);
      assert.ok(!error.message.includes(JWT));
      return true;
    },
  );

  await assert.rejects(
    fetchTraeCnUsagePage({ jwt: "", start_time: START, end_time: END, page_num: 1 }),
    /requires a token/,
  );
  await assert.rejects(
    fetchTraeCnUsagePage({ jwt: JWT, start_time: START, end_time: END, page_num: 0 }),
    /positive integer/,
  );
});

test("fetchTraeCnUsagePage sanitizes transport exceptions containing the JWT", async () => {
  const jwtCanary = "jwt-transport-canary";
  await assert.rejects(
    fetchTraeCnUsagePage({
      jwt: jwtCanary,
      start_time: START,
      end_time: END,
      page_num: 1,
      fetchImpl: async (_url, options) => {
        throw new Error(`request failed ${jwtCanary} ${options.headers.Authorization}`);
      },
    }),
    (error) => {
      assert.equal(error.message, "Trae CN usage API request failed.");
      assert.ok(!error.message.includes(jwtCanary));
      return true;
    },
  );
});

test("fetchTraeCnUsagePage keeps the abort timeout active through body consumption", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let timerHandle;
  let bodyStarted = false;
  let bodySawCancelledTimer = false;
  let bodyAborted = false;
  global.setTimeout = (callback) => {
    timerHandle = { callback, cancelled: false };
    return timerHandle;
  };
  global.clearTimeout = (handle) => {
    if (handle) handle.cancelled = true;
  };

  try {
    const pending = fetchTraeCnUsagePage({
      jwt: JWT,
      start_time: START,
      end_time: END,
      page_num: 1,
      fetchImpl: (_url, options) => ({
        status: 200,
        ok: true,
        json: () => {
          bodyStarted = true;
          bodySawCancelledTimer = timerHandle.cancelled;
          if (bodySawCancelledTimer) return Promise.resolve({ user_usage_group_by_sessions: [] });
          return new Promise((resolve) => {
            options.signal.addEventListener("abort", () => {
              bodyAborted = true;
              resolve({ user_usage_group_by_sessions: [] });
            }, { once: true });
          });
        },
      }),
    });
    await Promise.resolve();
    assert.equal(bodyStarted, true);
    timerHandle.callback();
    const result = await pending;
    assert.deepEqual(result.sessions, []);
    assert.equal(bodySawCancelledTimer, false);
    assert.equal(bodyAborted, true);
    assert.equal(timerHandle.cancelled, true, "timer clears after body consumption");
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function pagedFetch({ rowsPerPage, total } = {}) {
  const requestedPages = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requestedPages.push(body.page_num);
    const rows = Array.from({ length: rowsPerPage(body) }, (_v, i) => ({ id: body.page_num * 1000 + i }));
    const responseBody = { user_usage_group_by_sessions: rows };
    if (total !== undefined) responseBody.total = total;
    return jsonResponse(200, responseBody);
  };
  return { fetchImpl, requestedPages };
}

test("fetchTraeCnUsage paginates serially and stops at the stated total", async () => {
  const total = 45;
  const { fetchImpl, requestedPages } = pagedFetch({
    rowsPerPage: (body) => {
      const remaining = total - (body.page_num - 1) * body.page_size;
      return Math.max(0, Math.min(body.page_size, remaining));
    },
    total,
  });
  const result = await fetchTraeCnUsage({ jwt: JWT, start_time: START, end_time: END, fetchImpl, delayMs: 0 });
  assert.deepEqual(requestedPages, [1, 2, 3]);
  assert.equal(result.sessions.length, 45);
  assert.equal(result.total, 45);
  assert.equal(result.pages_fetched, 3);
});

test("fetchTraeCnUsage stops on an empty page when total is absent", async () => {
  const requestedPages = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requestedPages.push(body.page_num);
    const rows = body.page_num === 1 ? [{ id: 1 }] : [];
    return jsonResponse(200, { user_usage_group_by_sessions: rows });
  };
  const result = await fetchTraeCnUsage({ jwt: JWT, start_time: START, end_time: END, fetchImpl, delayMs: 0 });
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.total, null);
  assert.equal(result.pages_fetched, 2);
});

test("fetchTraeCnUsage fails closed when maxPages is reached and more is needed", async () => {
  const { fetchImpl, requestedPages } = pagedFetch({ rowsPerPage: () => 20 });
  await assert.rejects(
    fetchTraeCnUsage({ jwt: JWT, start_time: START, end_time: END, fetchImpl, delayMs: 0, maxPages: 3 }),
    (error) => {
      assert.match(error.message, /exceeded the maximum page count/);
      // Same capacity tag as the declared-total path so window splitting
      // engages even when the API omits total.
      assert.equal(error.code, "TRAE_CN_USAGE_CAPACITY_EXCEEDED");
      return true;
    },
  );
  // Never returns a partial snapshot: all 3 cap pages were fetched, then it
  // throws because page 4 would still be needed.
  assert.deepEqual(requestedPages, [1, 2, 3]);
});

test("fetchTraeCnUsage succeeds when maxPages exactly covers the total", async () => {
  const { fetchImpl, requestedPages } = pagedFetch({ rowsPerPage: () => 10, total: 30 });
  const result = await fetchTraeCnUsage({ jwt: JWT, start_time: START, end_time: END, fetchImpl, delayMs: 0, maxPages: 3 });
  assert.deepEqual(requestedPages, [1, 2, 3]);
  assert.equal(result.sessions.length, 30);
  assert.equal(result.pages_fetched, 3);
});

test("fetchTraeCnUsage rejects a declared snapshot over capacity before page two", async () => {
  const { fetchImpl, requestedPages } = pagedFetch({ rowsPerPage: () => 20, total: 2001 });
  await assert.rejects(
    fetchTraeCnUsage({ jwt: JWT, start_time: START, end_time: END, fetchImpl, delayMs: 0, maxPages: 100 }),
    (error) => {
      assert.equal(error.code, "TRAE_CN_USAGE_CAPACITY_EXCEEDED");
      assert.match(error.message, /supported capacity/);
      assert.ok(!error.message.includes(JWT));
      return true;
    },
  );
  assert.deepEqual(requestedPages, [1], "declared over-capacity total makes one request");
});

// ---------------------------------------------------------------------------
// Capacity-adaptive window splitting
// ---------------------------------------------------------------------------

function windowedFetch(handler, requests = []) {
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return jsonResponse(200, handler(body));
  };
  return { fetchImpl, requests };
}

test("fetchTraeCnUsageWindowed returns a within-capacity window without splitting", async () => {
  const { fetchImpl, requests } = windowedFetch(() => ({
    user_usage_group_by_sessions: [{ session_id: "only" }],
    total: 1,
  }));
  const result = await fetchTraeCnUsageWindowed({
    jwt: JWT,
    start_time: START,
    end_time: END,
    fetchImpl,
    delayMs: 0,
  });
  assert.equal(requests.length, 1, "no probe beyond the single window");
  assert.equal(requests[0].start_time, START);
  assert.equal(requests[0].end_time, END);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.total, 1);
});

test("fetchTraeCnUsageWindowed splits an over-capacity window into staggered halves", async () => {
  const mid = START + Math.floor((END - START) / 2);
  const leftRow = { session_id: "left" };
  const rightRow = { session_id: "right" };
  const { fetchImpl, requests } = windowedFetch((body) => {
    if (body.start_time === START && body.end_time === END) {
      return { user_usage_group_by_sessions: [leftRow], total: 2001 };
    }
    if (body.start_time === START && body.end_time === mid) {
      return { user_usage_group_by_sessions: [leftRow], total: 1 };
    }
    if (body.start_time === mid + 1 && body.end_time === END) {
      return { user_usage_group_by_sessions: [rightRow], total: 1 };
    }
    throw new Error(`unexpected window ${body.start_time}-${body.end_time}`);
  });
  const result = await fetchTraeCnUsageWindowed({
    jwt: JWT,
    start_time: START,
    end_time: END,
    fetchImpl,
    delayMs: 0,
  });
  // Full window fails on page one; the halves are staggered by one second so
  // their union equals the full window without overlap.
  assert.deepEqual(
    requests.map((b) => [b.start_time, b.end_time]),
    [[START, END], [START, mid], [mid + 1, END]],
  );
  assert.deepEqual(result.sessions, [leftRow, rightRow]);
  assert.equal(result.total, 2);
  assert.equal(result.pages_fetched, 2);
});

test("fetchTraeCnUsageWindowed splits recursively until a sub-window fits", async () => {
  const mid = START + Math.floor((END - START) / 2);
  const quarter = START + Math.floor((mid - START) / 2);
  const { fetchImpl, requests } = windowedFetch((body) => {
    if (body.start_time === START && (body.end_time === END || body.end_time === mid)) {
      return { user_usage_group_by_sessions: [], total: 2001 };
    }
    if (body.start_time === START && body.end_time === quarter) {
      return { user_usage_group_by_sessions: [{ session_id: "q1" }], total: 1 };
    }
    if (body.start_time === quarter + 1 && body.end_time === mid) {
      return { user_usage_group_by_sessions: [{ session_id: "q2" }], total: 1 };
    }
    if (body.start_time === mid + 1 && body.end_time === END) {
      return { user_usage_group_by_sessions: [{ session_id: "q3" }], total: 1 };
    }
    throw new Error(`unexpected window ${body.start_time}-${body.end_time}`);
  });
  const result = await fetchTraeCnUsageWindowed({
    jwt: JWT,
    start_time: START,
    end_time: END,
    fetchImpl,
    delayMs: 0,
  });
  assert.deepEqual(
    requests.map((b) => [b.start_time, b.end_time]),
    [[START, END], [START, mid], [START, quarter], [quarter + 1, mid], [mid + 1, END]],
  );
  assert.equal(result.sessions.length, 3);
  assert.equal(result.total, 3);
});

test("fetchTraeCnUsageWindowed fails closed at the split-depth ceiling", async () => {
  const { fetchImpl, requests } = windowedFetch(() => ({
    user_usage_group_by_sessions: [],
    total: 2001,
  }));
  await assert.rejects(
    fetchTraeCnUsageWindowed({
      jwt: JWT,
      start_time: START,
      end_time: END,
      fetchImpl,
      delayMs: 0,
    }),
    (error) => {
      assert.equal(error.code, "TRAE_CN_USAGE_CAPACITY_EXCEEDED");
      assert.match(error.message, /supported capacity/);
      return true;
    },
  );
  // Every sub-window stays over capacity, so the full depth-8 binary tree is
  // probed: at most 2^9 - 1 first-page requests before failing closed.
  assert.ok(requests.length <= 511, `probe count ${requests.length} exceeds the ceiling`);
  assert.ok(requests.length > 1, "splitting was attempted");
});

test("fetchTraeCnUsageWindowed splits when cap exhaustion signals capacity without a declared total", async () => {
  const mid = START + Math.floor((END - START) / 2);
  const fullPage = Array.from({ length: 20 }, (_, i) => ({ session_id: `row-${i}` }));
  const { fetchImpl, requests } = windowedFetch((body) => {
    if (body.start_time === START && body.end_time === END) {
      // Full pages with total omitted: the ONLY over-capacity signal is
      // maxPages exhaustion, which must carry the capacity code too.
      return { user_usage_group_by_sessions: fullPage };
    }
    return { user_usage_group_by_sessions: [{ session_id: "ok" }], total: 1 };
  });
  const result = await fetchTraeCnUsageWindowed({
    jwt: JWT,
    start_time: START,
    end_time: END,
    fetchImpl,
    delayMs: 0,
    maxPages: 2,
  });
  assert.deepEqual(
    requests.map((b) => [b.start_time, b.end_time]),
    [
      [START, END], // page 1
      [START, END], // page 2 -> cap exhausted, split
      [START, mid],
      [mid + 1, END],
    ],
  );
  assert.equal(result.sessions.length, 2);
  assert.equal(result.total, 2);
});

test("fetchTraeCnUsageWindowed rethrows non-capacity errors untouched", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return jsonResponse(500, {});
  };
  await assert.rejects(
    fetchTraeCnUsageWindowed({
      jwt: JWT,
      start_time: START,
      end_time: END,
      fetchImpl,
      delayMs: 0,
    }),
    /HTTP 500/,
  );
  assert.deepEqual(
    requests.map((b) => [b.start_time, b.end_time]),
    [[START, END]],
    "no split attempt on a non-capacity failure",
  );
});

test("production inter-page delay constant is 300ms (tests inject delayMs: 0)", () => {
  assert.equal(TRAE_CN_USAGE_DELAY_MS, 300);
});

// ---------------------------------------------------------------------------
// Storage-backed fetch with single 401/403 retry
// ---------------------------------------------------------------------------

test("fetchTraeCnUsageWithAuth retries exactly once on 401 by re-reading storage", async () => {
  const home = makeTraeCnHome();
  const storagePath = writeStorage(home, { token: "rotated.jwt.2", refreshToken: "r2" });
  const authCalls = [];
  const usageCalls = [];
  const readAuth = () => {
    authCalls.push(fs.readFileSync(storagePath, "utf8"));
    return readTraeCnAuthFromStorage({ env: { [TRAE_CN_HOME_ENV]: home }, platform: "darwin" });
  };
  const usageFetcher = async ({ jwt }) => {
    usageCalls.push(jwt);
    if (usageCalls.length === 1) {
      const error = new Error("Trae CN usage API returned HTTP 401.");
      error.status = 401;
      error.code = "AUTH_EXPIRED";
      throw error;
    }
    return { sessions: [{ id: 7 }], total: 1, pages_fetched: 1, truncated: false };
  };
  const result = await fetchTraeCnUsageWithAuth({
    start_time: START,
    end_time: END,
    fetchImpl: async () => jsonResponse(200, {}),
    delayMs: 0,
    readAuth,
    usageFetcher,
    env: { [TRAE_CN_HOME_ENV]: home },
    platform: "darwin",
  });
  assert.equal(usageCalls.length, 2);
  assert.equal(usageCalls[0], "rotated.jwt.2");
  assert.equal(usageCalls[1], "rotated.jwt.2");
  assert.equal(authCalls.length, 2, "storage re-read once");
  assert.equal(result.sessions[0].id, 7);
});

test("fetchTraeCnUsageWithAuth never retries more than once", async () => {
  const usageCalls = [];
  const usageFetcher = async () => {
    usageCalls.push(1);
    const error = new Error("Trae CN usage API returned HTTP 403.");
    error.status = 403;
    error.code = "AUTH_EXPIRED";
    throw error;
  };
  await assert.rejects(
    fetchTraeCnUsageWithAuth({
      start_time: START, end_time: END, fetchImpl: async () => jsonResponse(200, {}), delayMs: 0,
      readAuth: () => ({ token: "a.jwt.1", refreshToken: "r" }),
      usageFetcher,
    }),
    /HTTP 403/,
  );
  assert.equal(usageCalls.length, 2, "exactly two attempts");
});

test("fetchTraeCnUsageWithAuth splits over-capacity windows by default", async () => {
  const home = makeTraeCnHome();
  writeStorage(home, { token: "split.jwt.1", refreshToken: "r1" });
  const mid = START + Math.floor((END - START) / 2);
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push([body.start_time, body.end_time]);
    if (body.start_time === START && body.end_time === END) {
      return jsonResponse(200, { user_usage_group_by_sessions: [], total: 2001 });
    }
    const row = { session_id: `s-${body.start_time}`, model_name: "doubao-pro", usage_time: body.end_time, input_token: 1, output_token: 1, cache_read_token: 0, cache_write_token: 0 };
    return jsonResponse(200, { user_usage_group_by_sessions: [row], total: 1 });
  };
  const result = await fetchTraeCnUsageWithAuth({
    start_time: START,
    end_time: END,
    fetchImpl,
    delayMs: 0,
    env: { [TRAE_CN_HOME_ENV]: home },
    platform: "darwin",
  });
  assert.deepEqual(requests, [[START, END], [START, mid], [mid + 1, END]]);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.total, 2);
});

test("fetchTraeCnUsageWithAuth does not retry on non-auth errors", async () => {
  const usageCalls = [];
  const usageFetcher = async () => {
    usageCalls.push(1);
    const error = new Error("Trae CN usage API returned HTTP 500.");
    error.status = 500;
    throw error;
  };
  await assert.rejects(
    fetchTraeCnUsageWithAuth({
      start_time: START, end_time: END, fetchImpl: async () => jsonResponse(200, {}), delayMs: 0,
      readAuth: () => ({ token: "a.jwt.1", refreshToken: "r" }),
      usageFetcher,
    }),
    /HTTP 500/,
  );
  assert.equal(usageCalls.length, 1);
});

test("fetchTraeCnUsageWithAuth fails when credentials are missing", async () => {
  await assert.rejects(
    fetchTraeCnUsageWithAuth({ start_time: START, end_time: END, readAuth: () => null, usageFetcher: async () => ({}) }),
    /credentials are not configured/,
  );
});


// ---------------------------------------------------------------------------
// Usage API total validation (PR #474): the declared total gates pagination
// termination, so a malformed value must fail closed as a schema error -
// never be coerced into a legal-looking stop condition that silently
// truncates the snapshot after page 1.
// ---------------------------------------------------------------------------

test("fetchTraeCnUsagePage rejects a malformed declared total", async () => {
  const badTotals = [
    -1,           // negative: 20 >= -1 would stop pagination after page 1
    -0.5,         // negative fraction
    2.5,          // fractional row count
    "45",         // quoted digits: the API speaks JSON numbers (see the
                  // start_time convention above - string digits are a schema
                  // anomaly, not a numeric representation we accept)
    "",           // empty string
    true,         // wrong primitive
  ];
  for (const total of badTotals) {
    await assert.rejects(
      fetchTraeCnUsagePage({
        jwt: JWT, start_time: START, end_time: END, page_num: 1,
        fetchImpl: async () => jsonResponse(200, { user_usage_group_by_sessions: [{ id: 1 }], total }),
      }),
      (error) => {
        assert.match(error.message, /invalid total/);
        assert.ok(!error.message.includes(JWT), "schema error must not leak the JWT");
        return true;
      },
      `total ${JSON.stringify(total)} must be rejected`,
    );
  }
});

test("fetchTraeCnUsagePage still accepts valid totals (0, exact page multiple) and absent total", async () => {
  const zero = await fetchTraeCnUsagePage({
    jwt: JWT, start_time: START, end_time: END, page_num: 1,
    fetchImpl: async () => jsonResponse(200, { user_usage_group_by_sessions: [], total: 0 }),
  });
  assert.equal(zero.total, 0);

  const big = await fetchTraeCnUsagePage({
    jwt: JWT, start_time: START, end_time: END, page_num: 1,
    fetchImpl: async () => jsonResponse(200, { user_usage_group_by_sessions: [{ id: 1 }], total: 9007199254740991 }),
  });
  assert.equal(big.total, Number.MAX_SAFE_INTEGER);

  const absent = await fetchTraeCnUsagePage({
    jwt: JWT, start_time: START, end_time: END, page_num: 1,
    fetchImpl: async () => jsonResponse(200, { user_usage_group_by_sessions: [{ id: 1 }] }),
  });
  assert.equal(absent.total, null);
});

test("fetchTraeCnUsage fails closed on a malformed total instead of returning a partial snapshot", async () => {
  // Page 1 is full (20 rows) and declares total = -1: the pre-fix code
  // evaluated 20 >= -1 and silently stopped, returning a truncated snapshot.
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
  const fetchImpl = async () => jsonResponse(200, { user_usage_group_by_sessions: rows, total: -1 });
  await assert.rejects(
    fetchTraeCnUsage({ jwt: JWT, start_time: START, end_time: END, fetchImpl, delayMs: 0 }),
    /invalid total/,
  );
});

// ---------------------------------------------------------------------------
// Auth storage IO errors (PR #474): a missing file is "not signed in", but a
// real IO failure (EACCES / EISDIR / I/O error) must fail closed with a
// generic, credential-safe error - never be reported as "not signed in" and
// never leak the OS detail, the path, or the storage contents.
// ---------------------------------------------------------------------------

test("readTraeCnAuthFromStorage: ENOENT / ENOTDIR mean absent (null), other IO errors fail closed", () => {
  const home = "/Users/tester";
  const env = { [TRAE_CN_HOME_ENV]: home };

  const ioError = (code) => ({
    readFileSync: () => {
      const err = new Error(`os-level detail ${code} /Users/tester/secret-path`);
      err.code = code;
      throw err;
    },
  });

  // Absent file / absent path component -> not signed in.
  assert.equal(readTraeCnAuthFromStorage({ env, platform: "darwin", fsModule: ioError("ENOENT") }), null);
  assert.equal(readTraeCnAuthFromStorage({ env, platform: "darwin", fsModule: ioError("ENOTDIR") }), null);

  // Real IO failures -> distinct unreadable error, credential-safe message.
  for (const code of ["EACCES", "EISDIR", "EIO"]) {
    assert.throws(
      () => readTraeCnAuthFromStorage({ env, platform: "darwin", fsModule: ioError(code) }),
      (error) => {
        assert.equal(error.code, "TRAE_CN_STORAGE_UNREADABLE", code);
        assert.match(error.message, /could not be read/);
        // No OS detail, no filesystem path, no synthetic-JWT leak.
        assert.ok(!error.message.includes(code), "must not surface the OS error code");
        assert.ok(!error.message.includes("secret-path"), "must not surface the storage path");
        return true;
      },
      code,
    );
  }
});
