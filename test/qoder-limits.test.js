"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  QODER_SITES,
  normalizeQoderUsageResponse,
  qoderRequestHeaders,
  fetchQoderUsage,
  normalizeQoderRpcUsage,
  normalizeQoderActivityResponse,
  fetchQoderActivity,
  fetchQoderLimits,
  readQoderActivityCache,
  writeQoderActivityCache,
  readQoderLimitsCache,
  writeQoderLimitsCache,
  parseQoderQuotaLog,
  parseQoderAccountUsageLog,
  readQoderLocalQuota,
  fetchQoderCnLimits,
} = require("../src/lib/qoder-limits");

function writeQoderDesktopMainLog(home, bundleId, session, {
  used = 0,
  total = 100,
  observedAt = new Date().toISOString(),
} = {}) {
  const file = path.join(
    home,
    "Library",
    "Application Support",
    bundleId,
    "logs",
    session,
    "main.log",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const percentage = total > 0 ? (used / total) * 100 : 0;
  const summary = {
    operation: "account.getQuotaUsage",
    displayMode: "qoder",
    hasQoderUsage: true,
    qoderUsage: {
      userType: "personal_standard",
      usageType: "credits",
      expiresAt: 253_402_214_400_000,
      totalUsagePercentage: percentage,
      isQuotaExceeded: false,
      userQuota: {
        total,
        used,
        remaining: Math.max(0, total - used),
        percentage,
        unit: "credits",
      },
    },
  };
  fs.writeFileSync(file, `[${observedAt}] [INFO] [main] [Auth] [AccountUsage] usage summary ${JSON.stringify(summary)}\n`);
  return file;
}

test("normalizeQoderUsageResponse merges camel-case base and shared quotas", () => {
  const result = normalizeQoderUsageResponse({
    totalQuota: {
      quotaSummary: {
        usedValue: 20,
        limitValue: 100,
        remainingValue: 80,
        usagePercentage: 20,
        unit: "credits",
      },
    },
    sharedQuota: {
      quotaSummary: {
        usedValue: 30,
        limitValue: 200,
        remainingValue: 170,
        unit: "credits",
      },
    },
    nextResetAt: "2026-08-01T00:00:00Z",
  });

  assert.equal(result.configured, true);
  assert.equal(result.primary_window.used_credits, 50);
  assert.equal(result.primary_window.limit_credits, 300);
  assert.equal(result.primary_window.remaining_credits, 250);
  assert.ok(Math.abs(result.primary_window.used_percent - (50 / 3)) < 1e-12);
  assert.equal(result.primary_window.reset_at, "2026-08-01T00:00:00.000Z");
});

test("normalizeQoderUsageResponse accepts snake case and exhausted zero quota", () => {
  const result = normalizeQoderUsageResponse({
    total_quota: {
      quota_summary: {
        used_value: 0,
        limit_value: 0,
        remaining_value: 0,
        unit: "credits",
      },
    },
    next_reset_at: 1_785_542_400_000,
  });
  assert.equal(result.primary_window.used_percent, 100);
  assert.equal(result.primary_window.reset_at, "2026-08-01T00:00:00.000Z");
});

test("normalizeQoderUsageResponse rejects invalid quota values", () => {
  assert.throws(
    () => normalizeQoderUsageResponse({
      totalQuota: {
        quotaSummary: {
          usedValue: -1,
          limitValue: 100,
          remainingValue: 101,
        },
      },
    }),
    /nonnegative/,
  );
  assert.throws(
    () => normalizeQoderUsageResponse({
      totalQuota: {
        quotaSummary: {
          usedValue: 1,
          limitValue: 0,
          remainingValue: 0,
        },
      },
    }),
    /zero total quota/,
  );
});

test("Qoder IPC add-on credits do not borrow the aggregate percentage or plan expiry", () => {
  const result = normalizeQoderRpcUsage({
    userType: "personal_pro", expiresAt: "2026-12-01T00:00:00Z", totalUsagePercentage: 10,
    userQuota: { total: 100, used: 25, remaining: 75, percentage: 25 },
    addOnQuota: { total: 500, used: 35, remaining: 465, percentage: 7 },
  });
  assert.equal(result.primary_window.used_percent, 25);
  assert.equal(result.primary_window.limit_credits, 100);
  assert.equal(result.primary_window.reset_at, "2026-12-01T00:00:00.000Z");
  assert.equal(result.secondary_window, undefined);
  assert.equal(result.tertiary_window.remaining_credits, 465);
  assert.equal(result.tertiary_window.reset_at, null);
});

test("Qoder caches add-on credits independently from plan and Ultimate expiry", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-addon-cache-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const nowMs = Date.parse("2026-10-15T00:00:00Z");
  const result = normalizeQoderRpcUsage({
    expiresAt: "2026-10-15T01:00:00Z",
    userQuota: { total: 100, used: 25, remaining: 75 },
    addOnQuota: { total: 500, used: 35, remaining: 465 },
  });
  result.secondary_window = { used_percent: 40, used_credits: 80, limit_credits: 200,
    remaining_credits: 120, reset_at: "2026-10-15T03:00:00Z", unit: "calls" };
  writeQoderLimitsCache(result, { home, nowMs, namespace: "cn" });
  const cached = readQoderLimitsCache({ home, nowMs: nowMs + 2 * 3600_000, namespace: "cn" });
  assert.equal(cached.primary_window, null);
  assert.deepEqual(cached.secondary_window, result.secondary_window);
  assert.deepEqual(cached.tertiary_window, result.tertiary_window);
  assert.equal(readQoderLimitsCache({ home, nowMs, namespace: undefined }), null);
  assert.equal(readQoderLimitsCache({ home, nowMs: nowMs + 13 * 3600_000, namespace: "cn" }), null);
  writeQoderLimitsCache({ ...result, primary_window: null, secondary_window: null }, { home, nowMs, namespace: "cn" });
  assert.deepEqual(readQoderLimitsCache({ home, nowMs, namespace: "cn" }).tertiary_window, result.tertiary_window);
});

test("fetchQoderUsage sends the CodeXbar-compatible browser request", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          totalQuota: {
            quotaSummary: {
              usedValue: 25,
              limitValue: 100,
              remainingValue: 75,
              usagePercentage: 25,
            },
          },
        };
      },
    };
  };

  const result = await fetchQoderUsage("session=secret", QODER_SITES.international, fetchImpl);
  assert.equal(result.primary_window.used_percent, 25);
  assert.equal(captured.url, "https://qoder.com/api/v2/me/usages/big_model_credits");
  assert.deepEqual(
    captured.options.headers,
    qoderRequestHeaders("session=secret", QODER_SITES.international),
  );
  assert.equal(captured.options.headers["Bx-V"], "2.5.35");
  assert.equal(captured.options.headers["X-Requested-With"], "XMLHttpRequest");
});

test("fetchQoderLimits keeps explicit QODER_COOKIE provider access", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-manual-cookie-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let observedCookie = null;

  const result = await fetchQoderLimits({
    home,
    platform: "darwin",
    env: { QODER_COOKIE: "session=manual-secret" },
    rpcRequest: async () => {
      throw new Error("Qoder local service is not running.");
    },
    fetchImpl: async (_url, options) => {
      observedCookie = options.headers.Cookie;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            totalQuota: {
              quotaSummary: {
                usedValue: 25,
                limitValue: 100,
                remainingValue: 75,
                usagePercentage: 25,
              },
            },
          };
        },
      };
    },
  });

  assert.equal(observedCookie, "session=manual-secret");
  assert.equal(result.primary_window.remaining_credits, 75);
  assert.equal(result.cookie_source, "QODER_COOKIE");
});

test("parseQoderQuotaLog reads the latest personal quota snapshot without filling a 0/0 bar", () => {
  const parsed = parseQoderQuotaLog(`
    userType=personal_standard,totalUsagePercentage=42,isQuotaExceeded=false,
    userQuota used=42,total=100,remaining=58,percentage=42,unit=credits,addOnQuota none
    userType=personal_standard,totalUsagePercentage=0,isQuotaExceeded=true,
    userQuota=used=0, total=0, remaining=0, percentage=0, unit=credits, addOnQuota=<none>
  `);
  assert.equal(parsed.plan_label, "personal_standard");
  assert.equal(parsed.quota_exceeded, true);
  assert.equal(parsed.primary_window.used_percent, 0);
  assert.equal(parsed.primary_window.limit_credits, 0);
  assert.equal(parsed.source, "local-log");
});

test("parseQoderQuotaLog preserves a non-exceeded zero quota snapshot", () => {
  const parsed = parseQoderQuotaLog(`
    userType=personal_standard,totalUsagePercentage=0,isQuotaExceeded=false,
    userQuota=used=0, total=0, remaining=0, percentage=0, unit=credits, addOnQuota=<none>
  `);
  assert.equal(parsed.quota_exceeded, false);
  assert.equal(parsed.primary_window.used_percent, 0);
});

test("parseQoderAccountUsageLog maps the 0.4.x desktop account usage summary", () => {
  const line = `[2026-10-27T23:50:41.656Z] [INFO] [main] [Auth] [AccountUsage] 用量响应摘要 ${JSON.stringify({
    operation: "account.getQuotaUsage",
    displayMode: "qoder",
    hasQoderUsage: true,
    qoderUsage: {
      userType: "personal_standard",
      usageType: "credits",
      expiresAt: 253_402_214_400_000,
      totalUsagePercentage: 0,
      isQuotaExceeded: false,
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
      addOnQuota: { total: 1000, used: 250, remaining: 750, percentage: 25, unit: "credits" },
    },
  })}`;

  const parsed = parseQoderAccountUsageLog(line);
  assert.equal(parsed.limits.plan_label, "personal_standard");
  assert.equal(parsed.limits.quota_exceeded, false);
  assert.equal(parsed.limits.primary_window.used_percent, 0);
  assert.equal(parsed.limits.primary_window.limit_credits, 0);
  assert.equal(parsed.limits.primary_window.reset_at, null);
  assert.equal(parsed.limits.tertiary_window.limit_credits, 1000);
  assert.equal(parsed.limits.tertiary_window.remaining_credits, 750);
  assert.equal(parsed.limits.tertiary_window.used_percent, 25);
  assert.equal(parsed.limits.source, "local-log");
  assert.equal(parsed.observedAtMs, Date.parse("2026-10-27T23:50:41.656Z"));
});

test("readQoderLocalQuota reads the modern desktop main.log per edition", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-modern-log-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeQoderDesktopMainLog(home, "com.qoder.app.stable", "intl-session", { used: 90, total: 100 });
  writeQoderDesktopMainLog(home, "com.qodercn.app.stable", "cn-session", { used: 25, total: 100 });
  const nowMs = Date.now();

  const intl = readQoderLocalQuota({
    home,
    platform: "darwin",
    env: {},
    appDir: "Qoder",
    envPrefix: "QODER",
    nowMs,
  });
  const cn = readQoderLocalQuota({
    home,
    platform: "darwin",
    env: {},
    appDir: "QoderCN",
    envPrefix: "QODER_CN",
    nowMs,
  });

  assert.equal(intl.primary_window.remaining_credits, 10);
  assert.equal(cn.primary_window.remaining_credits, 75);
});

test("readQoderLocalQuota finds a summary far from the end of main.log", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-long-log-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = writeQoderDesktopMainLog(home, "com.qoder.app.stable", "long-session", {
    used: 25,
    total: 100,
  });
  fs.appendFileSync(file, `${"x".repeat(1024)}\n`.repeat(1600));

  const result = readQoderLocalQuota({
    home,
    platform: "darwin",
    env: {},
    appDir: "Qoder",
    envPrefix: "QODER",
    nowMs: Date.now(),
  });

  assert.equal(result.primary_window.remaining_credits, 75);
});

test("readQoderLocalQuota prefers a fresh modern summary over a fresh legacy log", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-modern-newest-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeQoderDesktopMainLog(home, "com.qodercn.app.stable", "new-session", { used: 25, total: 100 });
  const legacy = path.join(
    home,
    "Library",
    "Application Support",
    "QoderCN",
    "logs",
    "old-session",
    "window1",
    "renderer.log",
  );
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(
    legacy,
    "Credit usage summary: userType=personal_standard, totalUsagePercentage=42, isQuotaExceeded=false, " +
      "userQuota=used=42, total=100, remaining=58, percentage=42, unit=credits\n",
  );
  const now = new Date();
  fs.utimesSync(legacy, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));

  const result = readQoderLocalQuota({
    home,
    platform: "darwin",
    env: {},
    appDir: "QoderCN",
    envPrefix: "QODER_CN",
    nowMs: now.getTime(),
  });

  assert.equal(result.primary_window.remaining_credits, 75);
});

test("readQoderLocalQuota rejects a stale desktop summary even when the file is touched", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-stale-summary-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const observedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const file = writeQoderDesktopMainLog(home, "com.qodercn.app.stable", "stale-session", {
    used: 25,
    total: 100,
    observedAt,
  });
  fs.utimesSync(file, new Date(), new Date());

  assert.equal(readQoderLocalQuota({
    home,
    platform: "darwin",
    env: {},
    appDir: "QoderCN",
    envPrefix: "QODER_CN",
    nowMs: Date.now(),
  }), null);
});

test("readQoderLocalQuota rejects a stale legacy renderer.log", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-stale-legacy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legacy = path.join(
    home,
    "Library",
    "Application Support",
    "QoderCN",
    "logs",
    "old-session",
    "window1",
    "renderer.log",
  );
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(
    legacy,
    "Credit usage summary: userType=personal_standard, totalUsagePercentage=0, isQuotaExceeded=false, " +
      "userQuota=used=0, total=0, remaining=0, percentage=0, unit=credits\n",
  );
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(legacy, old, old);

  assert.equal(readQoderLocalQuota({
    home,
    platform: "darwin",
    env: {},
    appDir: "QoderCN",
    envPrefix: "QODER_CN",
    nowMs: Date.now(),
  }), null);
});

test("fetchQoderLimits falls back to a modern desktop main.log", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-modern-fallback-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeQoderDesktopMainLog(home, "com.qoder.app.stable", "session", { used: 25, total: 100 });

  const result = await fetchQoderLimits({
    home,
    platform: "darwin",
    env: {},
    rpcRequest: async () => {
      throw new Error("Qoder local service is not running.");
    },
    fetchImpl: async () => {
      throw new Error("Network unavailable.");
    },
  });

  assert.equal(result.source, "local-log");
  assert.equal(result.primary_window.remaining_credits, 75);
  assert.equal(readQoderLimitsCache({ home }).primary_window.remaining_credits, 75);
});

test("normalizeQoderRpcUsage keeps Qoder's quota-exceeded 0/0 Credits bucket at 0%", () => {
  const result = normalizeQoderRpcUsage({
    userType: "personal_standard",
    totalUsagePercentage: 0,
    isQuotaExceeded: true,
    userQuota: { used: 0, total: 0, remaining: 0, percentage: 0, unit: "credits" },
    expiresAt: 253_402_214_400_000,
  });

  assert.equal(result.quota_exceeded, true);
  assert.equal(result.primary_window.used_percent, 0);
  assert.equal(result.primary_window.reset_at, null);
});

test("normalizeQoderActivityResponse exposes Ultimate Free Calls as a separate window", () => {
  const result = normalizeQoderActivityResponse({
    code: 0,
    msg: "ok",
    data: {
      activities: [{
        type: "MODEL_FREE_QUOTA",
        activityId: "ultimate_200_free_invoke",
        modelName: "Ultimate Free Calls",
        limit: 1200,
        used: 789,
        remaining: 411,
        resetAt: 0,
        resetStrategy: "NEVER_EXPIRE",
        eligible: true,
        activityEndAt: 1_785_427_140_000,
      }],
    },
  }, { nowMs: 1_780_000_000_000 });

  assert.deepEqual(result, {
    used_percent: 65.75,
    reset_at: "2026-07-30T15:59:00.000Z",
    used_credits: 789,
    limit_credits: 1200,
    remaining_credits: 411,
    unit: "calls",
    activity_id: "ultimate_200_free_invoke",
  });
});

test("fetchQoderActivity sends a COSY-signed GET without exposing the local token", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          msg: "ok",
          data: {
            activities: [{
              activityId: "ultimate_200_free_invoke",
              limit: 1200,
              used: 300,
              remaining: 900,
              eligible: true,
              activityEndAt: 1_785_427_140_000,
            }],
          },
        };
      },
    };
  };

  const window = await fetchQoderActivity({
    id: "user-1",
    name: "Test",
    userType: "personal_standard",
    token: "oauth-secret",
    refreshToken: "refresh-secret",
  }, fetchImpl, { nowMs: 1_780_000_000_000 });

  assert.equal(captured.url, "https://openapi.qoder.sh/algo/api/v2/activity");
  assert.equal(captured.options.method, "GET");
  assert.match(captured.options.headers.authorization, /^Bearer COSY\./);
  assert.equal(JSON.stringify(captured.options.headers).includes("oauth-secret"), false);
  assert.equal(window.remaining_credits, 900);
});

test("fetchQoderLimits merges local Plan Credits with the activity window", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-merge-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let activeRpcRequests = 0;
  const rpcRequest = async (method) => {
    activeRpcRequests += 1;
    assert.equal(activeRpcRequests, 1, "Qoder local RPC requests must be serialized");
    await new Promise((resolve) => setImmediate(resolve));
    activeRpcRequests -= 1;
    if (method === "credit/usage") {
      return {
        userType: "personal_standard",
        totalUsagePercentage: 0,
        isQuotaExceeded: false,
        userQuota: { used: 0, total: 0, remaining: 0, percentage: 0, unit: "credits" },
        expiresAt: 253_402_214_400_000,
      };
    }
    return {
      id: "user-1",
      name: "Test",
      userType: "personal_standard",
      token: "oauth-secret",
      refreshToken: "refresh-secret",
    };
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 0,
        data: {
          activities: [{
            activityId: "ultimate_200_free_invoke",
            limit: 1200,
            used: 789,
            remaining: 411,
            eligible: true,
            activityEndAt: 2_000_000_000_000,
          }],
        },
      };
    },
  });

  const result = await fetchQoderLimits({ home, rpcRequest, fetchImpl });
  assert.equal(result.primary_window.used_percent, 0);
  assert.equal(result.primary_window.reset_at, null);
  assert.equal(result.secondary_window.remaining_credits, 411);
  assert.equal(result.source, "local-ipc+provider-api");
});

test("fetchQoderLimits keeps an unexpired activity when the provider briefly returns none", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-empty-activity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const nowMs = Date.parse("2030-07-29T16:00:00.000Z");
  const activityWindow = {
    used_percent: 65.75,
    reset_at: "2030-07-30T15:59:00.000Z",
    used_credits: 789,
    limit_credits: 1200,
    remaining_credits: 411,
    unit: "calls",
    activity_id: "ultimate_200_free_invoke",
  };
  writeQoderActivityCache(activityWindow, {
    home,
    nowMs: nowMs - 60_000,
  });

  const rpcRequest = async (method) => {
    if (method === "credit/usage") {
      return {
        userType: "personal_standard",
        totalUsagePercentage: 0,
        isQuotaExceeded: false,
        userQuota: { used: 0, total: 0, remaining: 0, percentage: 0, unit: "credits" },
        expiresAt: 253_402_214_400_000,
      };
    }
    return {
      id: "user-1",
      name: "Test",
      userType: "personal_standard",
      token: "oauth-secret",
    };
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { code: 0, data: { activities: [] } };
    },
  });

  const result = await fetchQoderLimits({
    home,
    nowMs,
    rpcRequest,
    fetchImpl,
  });

  assert.equal(result.secondary_window.remaining_credits, 411);
  assert.equal(result.source, "local-ipc+cached-activity");
  assert.deepEqual(readQoderActivityCache({ home, nowMs }), activityWindow);
});

test("fetchQoderLimits preserves the last unexpired activity window while Qoder is closed", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-activity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const activityWindow = {
    used_percent: 65.75,
    reset_at: "2030-07-30T15:59:00.000Z",
    used_credits: 789,
    limit_credits: 1200,
    remaining_credits: 411,
    unit: "calls",
    activity_id: "ultimate_200_free_invoke",
  };
  writeQoderActivityCache(activityWindow, {
    home,
    nowMs: Date.parse("2030-07-29T15:59:00.000Z"),
  });
  assert.deepEqual(
    readQoderActivityCache({
      home,
      nowMs: Date.parse("2030-07-29T16:00:00.000Z"),
    }),
    activityWindow,
  );

  const result = await fetchQoderLimits({
    home,
    platform: "linux",
    nowMs: Date.parse("2030-07-29T16:00:00.000Z"),
    rpcRequest: async () => {
      throw new Error("Qoder local service is not running.");
    },
    fetchImpl: async () => {
      throw new Error("Provider unavailable.");
    },
  });

  assert.equal(result.primary_window, null);
  assert.equal(result.secondary_window.remaining_credits, 411);
  assert.equal(result.source, "cached-activity");
});

test("Qoder activity cache stays usable until the activity expires", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-activity-expiry-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const activityWindow = {
    used_percent: 50,
    reset_at: "2030-08-01T00:00:00.000Z",
    used_credits: 600,
    limit_credits: 1200,
    remaining_credits: 600,
    unit: "calls",
    activity_id: "ultimate_200_free_invoke",
  };
  writeQoderActivityCache(activityWindow, {
    home,
    nowMs: Date.parse("2030-07-20T00:00:00.000Z"),
  });

  assert.deepEqual(
    readQoderActivityCache({
      home,
      nowMs: Date.parse("2030-07-30T00:00:00.000Z"),
    }),
    activityWindow,
  );
  assert.equal(
    readQoderActivityCache({
      home,
      nowMs: Date.parse("2030-08-01T00:00:00.000Z"),
    }),
    null,
  );
});

test("fetchQoderLimits persists a provider-level last-good cache for app restarts", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-limits-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const liveNowMs = Date.parse("2030-07-29T00:00:00.000Z");
  const rpcRequest = async (method) => {
    if (method === "credit/usage") {
      return {
        userType: "personal_standard",
        totalUsagePercentage: 25,
        isQuotaExceeded: false,
        userQuota: { used: 25, total: 100, remaining: 75, percentage: 25, unit: "credits" },
        expiresAt: 253_402_214_400_000,
      };
    }
    return {
      id: "user-1",
      name: "Test",
      userType: "personal_standard",
      token: "oauth-secret",
    };
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 0,
        data: {
          activities: [{
            activityId: "ultimate_200_free_invoke",
            limit: 1200,
            used: 900,
            remaining: 300,
            eligible: true,
            activityEndAt: Date.parse("2030-08-01T00:00:00.000Z"),
          }],
        },
      };
    },
  });

  const live = await fetchQoderLimits({ home, rpcRequest, fetchImpl, nowMs: liveNowMs });
  assert.equal(live.primary_window.remaining_credits, 75);
  assert.equal(live.secondary_window.remaining_credits, 300);
  assert.equal(readQoderLimitsCache({ home, nowMs: liveNowMs }).primary_window.remaining_credits, 75);

  const cached = await fetchQoderLimits({
    home,
    platform: "linux",
    nowMs: liveNowMs + 60_000,
    rpcRequest: async () => {
      throw new Error("Qoder local service is not running.");
    },
    fetchImpl: async () => {
      throw new Error("Browser session unavailable.");
    },
  });

  assert.equal(cached.primary_window.remaining_credits, 75);
  assert.equal(cached.secondary_window.remaining_credits, 300);
  assert.equal(cached.cached, true);
  assert.equal(cached.stale, true);
  assert.equal(cached.source, "disk-cache");
});

test("fetchQoderLimits returns last-good before explicit provider fallback", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-cache-first-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const nowMs = Date.parse("2030-07-29T00:00:00.000Z");
  writeQoderLimitsCache({
    configured: true,
    error: null,
    plan_label: "personal_standard",
    primary_window: {
      used_percent: 25,
      reset_at: null,
      used_credits: 25,
      limit_credits: 100,
      remaining_credits: 75,
      unit: "credits",
    },
    secondary_window: {
      used_percent: 75,
      reset_at: "2030-08-01T00:00:00.000Z",
      used_credits: 900,
      limit_credits: 1200,
      remaining_credits: 300,
      unit: "calls",
    },
  }, { home, nowMs });

  let providerFetches = 0;

  const cached = await fetchQoderLimits({
    home,
    platform: "darwin",
    env: { QODER_COOKIE: "session=manual-secret" },
    nowMs: nowMs + 60_000,
    rpcRequest: async () => {
      throw new Error("Qoder local service is not running.");
    },
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error("Provider fallback must not run before the last-good cache.");
    },
  });

  assert.equal(cached.source, "disk-cache");
  assert.equal(cached.secondary_window.remaining_credits, 300);
  assert.equal(providerFetches, 0);
});

test("fetchQoderLimits does not probe the macOS browser Keychain by default", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-keychain-default-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cookiePath = path.join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Default",
    "Cookies",
  );
  fs.mkdirSync(path.dirname(cookiePath), { recursive: true });
  fs.writeFileSync(cookiePath, "");
  let keychainReads = 0;
  let cookieReads = 0;
  let networkReads = 0;

  const result = await fetchQoderLimits({
    home,
    platform: "darwin",
    env: {},
    rpcRequest: async () => {
      throw new Error("Qoder local service is not running.");
    },
    securityRunner: async () => {
      keychainReads += 1;
      return "safe-storage-password";
    },
    sqliteReader: async () => {
      cookieReads += 1;
      return [];
    },
    fetchImpl: async () => {
      networkReads += 1;
      throw new Error("Unexpected provider request.");
    },
  });

  assert.deepEqual(result, { configured: false });
  assert.equal(keychainReads, 0);
  assert.equal(cookieReads, 0);
  assert.equal(networkReads, 0);
});

test("Qoder limits source contains no browser credential-store access", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "qoder-limits.js"), "utf8");
  const normalizedSource = source.replace(/\s+/g, " ");
  const forbiddenPatterns = [
    [/["'](?:node:)?child_process["']/, "child process execution", 'require("child_process")'],
    [/["'][^"']*sqlite-reader(?:\.js)?["']/, "browser SQLite access", 'require("../lib/sqlite-reader.js")'],
    [/["'](?:\/usr\/bin\/)?security["']/, "macOS Keychain CLI access", 'execFile("security", args)'],
    [/find-generic-password|Safe Storage/i, "browser Safe Storage access", "Microsoft Edge Safe Storage"],
    [/decryptChromiumCookie/, "Chromium cookie decryption", "decryptChromiumCookie(payload)"],
    [/encrypted_value/, "encrypted browser cookie reads", "SELECT encrypted_value FROM cookies"],
  ];

  for (const [pattern, capability, example] of forbiddenPatterns) {
    assert.match(example, pattern, `guard must detect ${capability}`);
    assert.doesNotMatch(normalizedSource, pattern, `Qoder limits must not contain ${capability}`);
  }
});

test("fetchQoderCnLimits falls back to the qoder.cn site and its own cache namespace", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-cn-site-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let capturedUrl = null;

  const result = await fetchQoderCnLimits({
    home,
    platform: "darwin",
    env: { QODER_CN_COOKIE: "session=manual-secret" },
    rpcRequest: async () => {
      throw new Error("Qoder local service is not running.");
    },
    fetchImpl: async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            totalQuota: {
              quotaSummary: {
                usedValue: 25,
                limitValue: 100,
                remainingValue: 75,
                usagePercentage: 25,
              },
            },
          };
        },
      };
    },
  });

  assert.equal(capturedUrl, "https://qoder.cn/api/v2/me/usages/big_model_credits");
  assert.equal(result.primary_window.remaining_credits, 75);
  assert.equal(result.site, "china");

  // The CN cache lives under its own namespace — the international cache stays
  // untouched, so the two editions never clobber each other.
  const cnCache = readQoderLimitsCache({ home, nowMs: Date.now(), namespace: "cn" });
  assert.equal(cnCache?.primary_window?.remaining_credits, 75);
  assert.equal(readQoderLimitsCache({ home, nowMs: Date.now() }), null);
});

test("fetchQoderCnLimits targets the china activity host for Ultimate Free Calls", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-cn-activity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let capturedUrl = null;
  const rpcRequest = async (method) => {
    if (method === "credit/usage") {
      return {
        userType: "personal_standard",
        totalUsagePercentage: 25,
        isQuotaExceeded: false,
        userQuota: { used: 25, total: 100, remaining: 75, percentage: 25, unit: "credits" },
        expiresAt: 253_402_214_400_000,
      };
    }
    return { id: "user-1", name: "Test", userType: "personal_standard", token: "oauth-secret" };
  };
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data: { activities: [] } };
      },
    };
  };

  const result = await fetchQoderCnLimits({ home, platform: "darwin", env: {}, rpcRequest, fetchImpl });
  assert.equal(capturedUrl, "https://openapi.qoder.com.cn/algo/api/v2/activity");
  assert.equal(result.primary_window.remaining_credits, 75);
});

test("fetchQoderCnLimits reads credentials via QODER_CN_HOME, not the international QODER_HOME", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-cn-rpc-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cnRoot = path.join(home, "cn-root");
  fs.mkdirSync(path.join(cnRoot, "SharedClientCache"), { recursive: true });
  fs.writeFileSync(
    path.join(cnRoot, "SharedClientCache", ".info.json"),
    JSON.stringify({ ipcServerPath: "/tmp/qodercn-test.sock" }),
  );

  const rpc = require("../src/lib/qoder-limits").qoderRpcRequest;
  const message = await rpc(
    "credit/usage",
    {},
    { home, env: { QODER_HOME: "/int-should-lose", QODER_CN_HOME: cnRoot }, platform: "darwin", appDir: "QoderCN", envPrefix: "QODER_CN" },
  ).then(
    () => "resolved",
    (err) => err.message,
  );
  // If QODER_CN_HOME were ignored, the probe would fail before ever touching
  // the socket ("Qoder local service is not running"). Reaching the socket
  // means the QoderCN .info.json was found.
  assert.ok(message !== "Qoder local service is not running.", "QODER_CN_HOME must locate the QoderCN .info.json");
});

test("fetchQoderCnLimits stays on the china site even when QODER_SITE points elsewhere", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-cn-sitepin-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let capturedUrl = null;

  const result = await fetchQoderCnLimits({
    home,
    platform: "darwin",
    env: { QODER_CN_COOKIE: "session=manual-secret", QODER_SITE: "qoder.com" },
    rpcRequest: async () => {
      throw new Error("Qoder local service is not running.");
    },
    fetchImpl: async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            totalQuota: {
              quotaSummary: {
                usedValue: 25,
                limitValue: 100,
                remainingValue: 75,
                usagePercentage: 25,
              },
            },
          };
        },
      };
    },
  });

  // QODER_SITE is an international-flow knob — the CN flow must stay pinned to
  // qoder.cn even if a user set QODER_SITE=qoder.com for the international
  // install.
  assert.equal(capturedUrl, "https://qoder.cn/api/v2/me/usages/big_model_credits");
  assert.equal(result.site, "china");
  assert.equal(result.primary_window.remaining_credits, 75);
});
