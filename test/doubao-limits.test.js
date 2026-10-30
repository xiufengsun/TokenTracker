"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DOUBAO_AUTH_EXPIRED_CODE,
  DOUBAO_LIMITS_CACHE_FILE,
  DOUBAO_ORIGIN,
  DOUBAO_QUOTA_SUMMARY_URL,
  DOUBAO_USAGE_DETAIL_URL,
  doubaoRequestHeaders,
  normalizeDoubaoWindowGroup,
  normalizeDoubaoWindowGroups,
  normalizeDoubaoLimits,
  postDoubaoEndpoint,
  readDoubaoLimitsCache,
  readDoubaoLimitsFallback,
  writeDoubaoLimitsCache,
  fetchDoubaoLimits,
} = require("../src/lib/doubao-limits");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

const KW_SECRET = "kw-secret";

function doubaoCookieHex(value = "session-value") {
  const crypto = require("node:crypto");
  const key = crypto.pbkdf2Sync(KW_SECRET, "saltysalt", 1003, 16, "sha1");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), crypto.randomBytes(16), iv, body]).toString("hex");
}

function makeDoubaoHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-limits-"));
  fs.mkdirSync(path.join(home, "Library", "Application Support", "Doubao", "Default"), { recursive: true });
  fs.writeFileSync(path.join(home, "Library", "Application Support", "Doubao", "Default", "Cookies"), "db");
  return home;
}

function sessionSqliteReader() {
  return {
    readJsonRowsAsync: async () => [
      { name: "sessionid", encrypted_value_hex: doubaoCookieHex(), last_access_utc: 10 },
    ],
  };
}

test("postDoubaoEndpoint sends Doubao's browser-shaped request", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return jsonResponse({ code: 0, msg: "ok", data: { ok: true } });
  };
  const data = await postDoubaoEndpoint(DOUBAO_QUOTA_SUMMARY_URL, "sessionid=abc", fetchImpl);
  assert.deepEqual(data, { ok: true });
  assert.equal(captured.url, DOUBAO_QUOTA_SUMMARY_URL);
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Cookie, "sessionid=abc");
  assert.equal(captured.options.headers.Origin, DOUBAO_ORIGIN);
  assert.ok(captured.options.headers.Referer.startsWith(DOUBAO_ORIGIN));
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.ok(captured.options.headers["User-Agent"].includes("Chrome"));
  assert.deepEqual(JSON.parse(captured.options.body), { product_line: "" });

  const detailBody = await postDoubaoEndpoint(DOUBAO_USAGE_DETAIL_URL, "sessionid=abc", async (url, options) => {
    captured = options;
    return jsonResponse({ code: 0, data: {} });
  });
  assert.deepEqual(detailBody, {});
  assert.deepEqual(JSON.parse(captured.body), {});
});

test("postDoubaoEndpoint treats code 710012001 and 401/403 as auth expiry", async () => {
  await assert.rejects(
    postDoubaoEndpoint(DOUBAO_USAGE_DETAIL_URL, "c", async () => jsonResponse({ code: DOUBAO_AUTH_EXPIRED_CODE, msg: "登录已过期" })),
    (error) => error.code === "AUTH_EXPIRED" && /login expired/i.test(error.message),
  );
  await assert.rejects(
    postDoubaoEndpoint(DOUBAO_USAGE_DETAIL_URL, "c", async () => jsonResponse({}, 401)),
    (error) => error.code === "AUTH_EXPIRED",
  );
  await assert.rejects(
    postDoubaoEndpoint(DOUBAO_USAGE_DETAIL_URL, "c", async () => jsonResponse({}, 500)),
    (error) => error.code === undefined && /HTTP 500/.test(error.message),
  );
  await assert.rejects(
    postDoubaoEndpoint(DOUBAO_USAGE_DETAIL_URL, "c", async () => jsonResponse({ code: 710010702, msg: "system error" })),
    (error) => /code 710010702/.test(error.message),
  );
});

test("normalizeDoubaoWindowGroup parses numbers, percent and reset timestamps leniently", () => {
  const window = normalizeDoubaoWindowGroup({
    window_type: "5h",
    used_quota: 25,
    total_quota: 100,
    remaining_quota: 75,
    reset_time: 1760000000,
  });
  assert.equal(window.used_percent, 25);
  assert.equal(window.used_credits, 25);
  assert.equal(window.limit_credits, 100);
  assert.equal(window.remaining_credits, 75);
  assert.equal(window.reset_at, new Date(1760000000 * 1000).toISOString());

  const fraction = normalizeDoubaoWindowGroup({ type: "7d", usage_percentage: 0.4 });
  assert.equal(fraction.used_percent, 40);

  const camel = normalizeDoubaoWindowGroup({
    windowType: "monthly",
    usedQuota: 10,
    totalQuota: 200,
    resetTime: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(camel.used_percent, 5);
  assert.equal(camel.reset_at, "2030-01-01T00:00:00.000Z");

  // Numbers without a resolvable percentage render 0% (Qoder's zero-total
  // precedent) rather than an invented bar.
  assert.equal(normalizeDoubaoWindowGroup({ used_quota: 5 }).used_percent, 0);
  assert.equal(normalizeDoubaoWindowGroup({ used_quota: 5 }).used_credits, 5);

  assert.equal(normalizeDoubaoWindowGroup({ window_type: "unknown" }), null);
  assert.equal(normalizeDoubaoWindowGroup(null), null);
});

test("normalizeDoubaoWindowGroups maps 5h/7d/1m onto primary/secondary/tertiary", () => {
  const windows = normalizeDoubaoWindowGroups([
    { window_type: "1m", used_quota: 1, total_quota: 10 },
    { window_type: "5h", used_quota: 2, total_quota: 10 },
    { window_type: "7d", used_quota: 3, total_quota: 10 },
    { window_type: "unknown-shape" },
  ]);
  assert.equal(windows.primary_window.used_credits, 2);
  assert.equal(windows.secondary_window.used_credits, 3);
  assert.equal(windows.tertiary_window.used_credits, 1);
  assert.deepEqual(
    normalizeDoubaoWindowGroups([{ window_type: "mystery" }, "garbage", null]),
    { primary_window: null, secondary_window: null, tertiary_window: null },
  );
});

test("normalizeDoubaoLimits prefers usage_detail groups and keeps free accounts label-less", () => {
  const paid = normalizeDoubaoLimits({
    summaryData: {
      current_subscription: { display: { product_name: "个人订阅" } },
      window_limit_section: [{ window_type: "5h", used_quota: 1, total_quota: 10 }],
    },
    usageData: {
      total_used_percent: 25,
      window_limit_groups: [
        { window_type: "5h", used_quota: 25, total_quota: 100 },
        { window_type: "7d", used_quota: 250, total_quota: 1000 },
        { window_type: "1m", used_quota: 1000, total_quota: 5000 },
      ],
    },
  });
  assert.equal(paid.plan_label, "个人订阅");
  assert.equal(paid.primary_window.used_percent, 25);
  assert.equal(paid.secondary_window.used_percent, 25);
  assert.equal(paid.tertiary_window.used_percent, 20);

  const fallback = normalizeDoubaoLimits({
    summaryData: { window_limit_section: [{ window_type: "7d", used_quota: 7, total_quota: 10 }] },
    usageData: { window_limit_groups: [] },
  });
  assert.equal(fallback.primary_window, null);
  assert.equal(fallback.secondary_window.used_credits, 7);
  assert.equal(fallback.plan_label, null);

  const free = normalizeDoubaoLimits({
    summaryData: { current_subscription: { display: { product_name: "个人订阅" } }, window_limit_section: [] },
    usageData: { window_limit_groups: [] },
  });
  assert.equal(free.plan_label, null);
  assert.equal(free.primary_window, null);
  assert.equal(free.secondary_window, null);
  assert.equal(free.tertiary_window, null);
});

test("doubaoRequestHeaders carries the session cookie only", () => {
  const headers = doubaoRequestHeaders("sessionid=abc");
  assert.equal(headers.Cookie, "sessionid=abc");
  assert.ok(!JSON.stringify(headers).includes("csrf"));
});

test("fetchDoubaoLimits stays unconfigured without Doubao's data directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-absent-"));
  try {
    assert.deepEqual(await fetchDoubaoLimits({ home, env: {}, platform: "darwin" }), { configured: false });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fetchDoubaoLimits reports sign-in, keychain and decrypt failures distinctly", async () => {
  const home = makeDoubaoHome();
  try {
    const noSession = await fetchDoubaoLimits({
      home,
      env: {},
      // makeDoubaoHome() builds the macOS data-dir layout; pin the platform so
      // these tests are deterministic on Linux/Windows runners too.
      platform: "darwin",
      sqliteReader: { readJsonRowsAsync: async () => [{ name: "ttwid", encrypted_value_hex: "aa", last_access_utc: 1 }] },
      keychainReader: async () => KW_SECRET,
    });
    assert.equal(noSession.configured, true);
    assert.match(noSession.error, /Open Doubao and sign in/);

    const noKeychain = await fetchDoubaoLimits({
      home,
      env: {},
      platform: "darwin",
      sqliteReader: sessionSqliteReader(),
      keychainReader: async () => null,
    });
    assert.match(noKeychain.error, /Doubao Safe Storage/);

    const decryptFailed = await fetchDoubaoLimits({
      home,
      env: {},
      platform: "darwin",
      sqliteReader: sessionSqliteReader(),
      keychainReader: async () => "unrelated-secret",
    });
    assert.match(decryptFailed.error, /Could not decrypt/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fetchDoubaoLimits returns quota windows from the live endpoints and caches them", async () => {
  const home = makeDoubaoHome();
  const nowMs = Date.parse("2030-07-29T00:00:00.000Z");
  try {
    const fetchImpl = async (url) => {
      if (url === DOUBAO_QUOTA_SUMMARY_URL) {
        return jsonResponse({
          code: 0,
          data: {
            current_subscription: { display: { product_name: "个人订阅" } },
            window_limit_section: [],
          },
        });
      }
      return jsonResponse({
        code: 0,
        data: {
          total_used_percent: 25,
          window_limit_groups: [
            { window_type: "5h", used_quota: 25, total_quota: 100, reset_time: Date.parse("2030-07-29T05:00:00.000Z") },
            { window_type: "7d", used_quota: 250, total_quota: 1000 },
          ],
        },
      });
    };
    const result = await fetchDoubaoLimits({
      home,
      env: {},
      platform: "darwin",
      fetchImpl,
      sqliteReader: sessionSqliteReader(),
      keychainReader: async () => KW_SECRET,
      nowMs,
    });
    assert.equal(result.configured, true);
    assert.equal(result.error, null);
    assert.equal(result.plan_label, "个人订阅");
    assert.equal(result.primary_window.used_percent, 25);
    assert.equal(result.primary_window.reset_at, "2030-07-29T05:00:00.000Z");
    assert.equal(result.secondary_window.used_credits, 250);
    assert.equal(result.tertiary_window ?? null, null);
    assert.equal(result.source, "provider-api");

    const cachePath = path.join(home, ".tokentracker", "tracker", DOUBAO_LIMITS_CACHE_FILE);
    assert.ok(fs.existsSync(cachePath), "limits cache must be written");
    const cached = readDoubaoLimitsCache({ home, nowMs });
    assert.equal(cached.primary_window.used_percent, 25);
    assert.equal(cached.source, "disk-cache");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fetchDoubaoLimits falls back to the disk cache when the API fails", async () => {
  const home = makeDoubaoHome();
  const nowMs = Date.parse("2030-07-29T00:00:00.000Z");
  try {
    const summaryFetch = async (url) => {
      if (url === DOUBAO_QUOTA_SUMMARY_URL) {
        return jsonResponse({ code: 0, data: { current_subscription: { display: { product_name: "个人订阅" } }, window_limit_section: [] } });
      }
      return jsonResponse({
        code: 0,
        data: {
          total_used_percent: 30,
          window_limit_groups: [
            { window_type: "5h", used_quota: 30, total_quota: 100, reset_time: Date.parse("2030-07-29T05:00:00.000Z") },
          ],
        },
      });
    };
    // A successful refresh writes the cache under the active session before
    // the failing call gets to use it as its fallback.
    const first = await fetchDoubaoLimits({
      home,
      env: {},
      platform: "darwin",
      fetchImpl: summaryFetch,
      sqliteReader: sessionSqliteReader(),
      keychainReader: async () => KW_SECRET,
      nowMs,
    });
    assert.equal(first.error, null);
    const result = await fetchDoubaoLimits({
      home,
      env: {},
      platform: "darwin",
      fetchImpl: async () => jsonResponse({ code: 0, data: {} }, 500),
      sqliteReader: sessionSqliteReader(),
      keychainReader: async () => KW_SECRET,
      nowMs,
    });
    assert.equal(result.stale, true);
    assert.equal(result.primary_window.used_percent, 30);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fetchDoubaoLimits binds the disk cache to the active account", async () => {
  const home = makeDoubaoHome();
  const nowMs = Date.parse("2030-07-29T00:00:00.000Z");
  try {
    const summaryFetch = async (url) => {
      if (url === DOUBAO_QUOTA_SUMMARY_URL) {
        return jsonResponse({ code: 0, data: { current_subscription: { display: { product_name: "个人订阅" } }, window_limit_section: [] } });
      }
      return jsonResponse({
        code: 0,
        data: {
          total_used_percent: 30,
          window_limit_groups: [
            { window_type: "5h", used_quota: 30, total_quota: 100, reset_time: Date.parse("2030-07-29T05:00:00.000Z") },
          ],
        },
      });
    };
    await fetchDoubaoLimits({
      home,
      env: {},
      platform: "darwin",
      fetchImpl: summaryFetch,
      sqliteReader: sessionSqliteReader(),
      keychainReader: async () => KW_SECRET,
      nowMs,
    });
    const rawCache = JSON.parse(fs.readFileSync(path.join(home, ".tokentracker", "tracker", DOUBAO_LIMITS_CACHE_FILE), "utf8")).doubao;
    assert.match(rawCache.cookie_fingerprint, /^[0-9a-f]{16}$/);
    // The stored fingerprint is not the credential itself.
    assert.ok(!JSON.stringify(rawCache).includes("session-value"));

    // A different account's session must never see the previous windows.
    const other = await fetchDoubaoLimits({
      home,
      env: { DOUBAO_COOKIE: "sessionid=other-account" },
      platform: "darwin",
      fetchImpl: async () => jsonResponse({ code: 0, data: {} }, 500),
      nowMs,
    });
    assert.equal(other.stale, undefined);
    assert.equal(other.primary_window, undefined);
    assert.match(other.error, /quota fetch failed|HTTP 500/);

    // The same account still gets its fallback, and an unbound read (legacy
    // shape) keeps working for callers without a session.
    const same = await fetchDoubaoLimits({
      home,
      env: { DOUBAO_COOKIE: "sessionid=other-account" },
      platform: "darwin",
      fetchImpl: summaryFetch,
      nowMs,
    });
    assert.equal(same.error, null);
    const legacyRead = readDoubaoLimitsCache({ home, nowMs });
    assert.equal(legacyRead.source, "disk-cache");
    const wrongFingerprint = readDoubaoLimitsCache({ home, nowMs, fingerprint: "0".repeat(16) });
    assert.equal(wrongFingerprint, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fetchDoubaoLimits honors DOUBAO_COOKIE without any local Doubao data directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-cookie-only-"));
  const nowMs = Date.parse("2030-07-29T00:00:00.000Z");
  try {
    let sawCookie = null;
    const result = await fetchDoubaoLimits({
      home,
      env: { DOUBAO_COOKIE: "sessionid=manual-cookieless" },
      platform: "darwin",
      fetchImpl: async (url, options) => {
        sawCookie = options.headers.Cookie;
        if (url === DOUBAO_QUOTA_SUMMARY_URL) {
          return jsonResponse({ code: 0, data: { current_subscription: { display: { product_name: "个人订阅" } }, window_limit_section: [] } });
        }
        return jsonResponse({
          code: 0,
          data: {
            total_used_percent: 40,
            window_limit_groups: [
              { window_type: "5h", used_quota: 40, total_quota: 100, reset_time: Date.parse("2030-07-29T05:00:00.000Z") },
            ],
          },
        });
      },
      sqliteReader: { readJsonRowsAsync: async () => { throw new Error("cookie store must not be read when DOUBAO_COOKIE is set"); } },
      keychainReader: async () => { throw new Error("keychain must not be read when DOUBAO_COOKIE is set"); },
      nowMs,
    });
    assert.equal(sawCookie, "sessionid=manual-cookieless");
    assert.equal(result.configured, true);
    assert.equal(result.error, null);
    assert.equal(result.cookie_source, "DOUBAO_COOKIE");
    assert.equal(result.primary_window.used_percent, 40);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("readDoubaoLimitsFallback serves only the active session's cache", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-fallback-"));
  const nowMs = Date.parse("2030-07-29T00:00:00.000Z");
  try {
    const manualFetch = (percent) => async (url) => {
      if (url === DOUBAO_QUOTA_SUMMARY_URL) {
        return jsonResponse({ code: 0, data: { current_subscription: { display: { product_name: "个人订阅" } }, window_limit_section: [] } });
      }
      return jsonResponse({
        code: 0,
        data: {
          total_used_percent: percent,
          window_limit_groups: [
            { window_type: "5h", used_quota: percent, total_quota: 100, reset_time: Date.parse("2030-07-29T05:00:00.000Z") },
          ],
        },
      });
    };
    await fetchDoubaoLimits({
      home,
      env: { DOUBAO_COOKIE: "sessionid=fallback-a" },
      platform: "darwin",
      fetchImpl: manualFetch(50),
      nowMs,
    });

    // Timeout-race callers re-derive the session; a matching one gets the
    // still-valid windows, another account gets nothing.
    const matched = await readDoubaoLimitsFallback({ home, env: { DOUBAO_COOKIE: "sessionid=fallback-a" }, platform: "darwin", nowMs });
    assert.equal(matched.stale, true);
    assert.equal(matched.primary_window.used_percent, 50);
    const other = await readDoubaoLimitsFallback({ home, env: { DOUBAO_COOKIE: "sessionid=fallback-b" }, platform: "darwin", nowMs });
    assert.equal(other, null);
    const cookieless = await readDoubaoLimitsFallback({ home, env: {}, platform: "darwin", nowMs });
    assert.equal(cookieless, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fetchDoubaoLimits surfaces auth expiry from the API without serving cache", async () => {
  const home = makeDoubaoHome();
  try {
    const result = await fetchDoubaoLimits({
      home,
      env: {},
      platform: "darwin",
      fetchImpl: async () => jsonResponse({ code: DOUBAO_AUTH_EXPIRED_CODE, msg: "登录已过期" }),
      sqliteReader: sessionSqliteReader(),
      keychainReader: async () => KW_SECRET,
    });
    assert.equal(result.auth_action_required, "reauth");
    assert.match(result.error, /login expired/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fetchDoubaoLimits prefers DOUBAO_COOKIE over local decryption", async () => {
  const home = makeDoubaoHome();
  try {
    let sawCookie = null;
    const result = await fetchDoubaoLimits({
      home,
      env: { DOUBAO_COOKIE: "sessionid=manual" },
      platform: "darwin",
      fetchImpl: async (url, options) => {
        sawCookie = options.headers.Cookie;
        return jsonResponse({ code: 0, data: { window_limit_groups: [] } });
      },
      keychainReader: async () => {
        throw new Error("keychain must not be read when DOUBAO_COOKIE is set");
      },
      sqliteReader: {
        readJsonRowsAsync: async () => {
          throw new Error("cookie store must not be read when DOUBAO_COOKIE is set");
        },
      },
    });
    assert.equal(sawCookie, "sessionid=manual");
    assert.equal(result.cookie_source, "DOUBAO_COOKIE");
    assert.equal(result.plan_label, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("readDoubaoLimitsCache honors reset-based and unknown-reset TTLs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-doubao-cache-"));
  const nowMs = Date.parse("2030-07-29T00:00:00.000Z");
  try {
    writeDoubaoLimitsCache(
      {
        configured: true,
        error: null,
        plan_label: null,
        primary_window: { used_percent: 10, reset_at: "2030-07-29T05:00:00.000Z", used_credits: 10, limit_credits: 100 },
        secondary_window: null,
        tertiary_window: null,
      },
      { home, nowMs },
    );
    assert.ok(readDoubaoLimitsCache({ home, nowMs }));

    // Dated window past its reset → dead even though the write is fresh.
    assert.equal(readDoubaoLimitsCache({ home, nowMs: Date.parse("2030-07-29T06:00:00.000Z") }), null);

    writeDoubaoLimitsCache(
      {
        configured: true,
        error: null,
        plan_label: null,
        primary_window: { used_percent: 10, reset_at: null, used_credits: 10, limit_credits: 100 },
        secondary_window: null,
        tertiary_window: null,
      },
      { home, nowMs },
    );
    assert.ok(readDoubaoLimitsCache({ home, nowMs: nowMs + 11 * 60 * 60 * 1000 }));
    assert.equal(readDoubaoLimitsCache({ home, nowMs: nowMs + 13 * 60 * 60 * 1000 }), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
