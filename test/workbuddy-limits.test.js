const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectPackageRows,
  collectResourceGroups,
  fetchWorkbuddyAiLimits,
  fetchWorkbuddyLimits,
  originAllowed,
  readWorkbuddyLimitsCache,
  resourceWindow,
  selectWorkbuddyPlanQuota,
  selectWorkbuddyLimits,
  VARIANTS,
  workbuddyLimitsCachePath,
  writeWorkbuddyLimitsCache,
} = require("../src/lib/workbuddy-limits");
const { withWorkbuddyProviderTimeout } = require("../src/lib/usage-limits");

const TRIAL = "TCACA_code_008_cfWoLwvjU4";
const REWARD = "TCACA_code_007_nzdH5h4Nl0";
const BONUS = "TCACA_code_028_NtpWi0jzXs";
const PRO_YEAR = "TCACA_code_003_FAnt7lcmRT";

function trialRow(overrides = {}) {
  return {
    PackageCode: TRIAL,
    PackageName: "体验版",
    CycleTotalCapacity: 500,
    CycleRemainCapacity: 251.71,
    CycleUsedCapacity: 248.29,
    CycleEndTime: "2026-10-31 23:59:59",
    ...overrides,
  };
}

test("plan quota keeps the subscription package and drops reward grants", () => {
  const quota = selectWorkbuddyPlanQuota([
    ...collectPackageRows({
      code: 0,
      data: {
        Packages: [trialRow(), {
          PackageCode: REWARD,
          PackageName: "官方活动发放",
          CycleTotalCapacity: 500,
          CycleRemainCapacity: 500,
          CycleUsedCapacity: 0,
          CycleEndTime: "2026-11-21 22:31:43",
        }, {
          PackageCode: BONUS,
          PackageName: "成长计划奖励",
          CycleTotalCapacity: 1000,
          CycleRemainCapacity: 1000,
          CycleUsedCapacity: 0,
          CycleEndTime: "2026-11-21 22:57:49",
        }],
        SubscriptionPackageName: "体验版",
      },
    }),
  ], { name: "体验版" });

  assert.equal(quota.package_code, TRIAL);
  assert.equal(quota.plan_label, "Free");
  assert.ok(Math.abs(quota.primary_window.used_percent - (248.29 / 500) * 100) < 1e-9);
  assert.equal(quota.primary_window.reset_at, new Date("2026-10-31T23:59:59").toISOString());
  assert.equal(quota.primary_window.limit_credits, 500);
  assert.equal(quota.primary_window.used_credits, 248.29);
  assert.equal(quota.primary_window.remaining_credits, 251.71);
});

test("one WorkBuddy product chooses a usable edition without summing account balances", () => {
  const china = { configured: true, plan_label: "Free", primary_window: { used_percent: 50, limit_credits: 500 } };
  const ai = { configured: true, plan_label: "Pro", primary_window: { used_percent: 20, limit_credits: 1000 } };
  assert.equal(selectWorkbuddyLimits(china, ai), china);
  assert.equal(selectWorkbuddyLimits({ configured: false }, ai), ai);
  assert.equal(selectWorkbuddyLimits({ configured: true, error: "not running" }, ai), ai);
  assert.equal(selectWorkbuddyLimits({ configured: true, primary_window: null }, ai), ai);
  assert.deepEqual(selectWorkbuddyLimits({ configured: false }, { configured: false }), { configured: false });
});

test("a higher plan tier wins over a trial package", () => {
  const quota = selectWorkbuddyPlanQuota([
    { code: TRIAL, name: "体验版", total: 500, remain: 500, used: 0, cycleEnd: "2026-10-31 23:59:59" },
    { code: PRO_YEAR, name: "专业版", total: 2000, remain: 1500, used: 500, cycleEnd: "2027-01-01 00:00:00" },
    { code: REWARD, name: "奖励", total: 9000, remain: 9000, used: 0, cycleEnd: "2026-12-01 00:00:00" },
  ]);
  assert.equal(quota.package_code, PRO_YEAR);
  assert.equal(quota.plan_label, "STANDARD");
});

test("a reward code is never treated as the subscription package", () => {
  const quota = selectWorkbuddyPlanQuota(
    [{ code: REWARD, name: "奖励", total: 1500, remain: 1500, used: 0, cycleEnd: "2026-11-21 22:31:43" }],
    { code: REWARD, name: "奖励" },
  );
  assert.equal(quota, null);
});

test("English names come from the response or the official desktop edition labels", () => {
  const known = [
    [TRIAL, "Free", "Free"],
    [PRO_YEAR, "STANDARD", "Pro"],
    ["TCACA_code_039_KRcQj7wUat", "STANDARD TRIAL", "Pro-Trial"],
    ["TCACA_code_026_BaESVICNoi", "Advanced", "Advanced"],
    ["TCACA_code_027_0FCGVA6vSa", "Ultimate", "Ultimate"],
    ["TCACA_code_023_4xbGhMrE6q", "Youth", "Youth"],
    ["TCACA_code_035_ArVxJcGDsm", "Free", "Free"],
  ];
  for (const [code, cnLabel, aiLabel] of known) {
    const rows = collectPackageRows({ Packages: [trialRow({ PackageCode: code })] });
    assert.equal(selectWorkbuddyPlanQuota(rows).plan_label, cnLabel);
    assert.equal(selectWorkbuddyPlanQuota(rows, {}, "workbuddyAi").plan_label, aiLabel);
    assert.equal(selectWorkbuddyPlanQuota(rows, { name: "Provider English Name" }).plan_label, "Provider English Name");
  }
  const code = "future-package-code";
  const unknownRows = collectPackageRows({ Packages: [trialRow({ PackageCode: code, PackageName: "新套餐" })] });
  assert.equal(selectWorkbuddyPlanQuota(unknownRows, { code, name: "新套餐" }).plan_label, null);
  assert.equal(selectWorkbuddyPlanQuota(unknownRows, { code, name: "Future Plan" }).plan_label, "Future Plan");
});

test("china and international hosts stay on their own allowlists", () => {
  assert.equal(originAllowed("https://www.workbuddy.cn", VARIANTS.workbuddy), true);
  assert.equal(originAllowed("https://copilot.tencent.com", VARIANTS.workbuddy), true);
  assert.equal(originAllowed("https://www.workbuddy.ai", VARIANTS.workbuddy), false);
  assert.equal(originAllowed("https://www.workbuddy.ai", VARIANTS.workbuddyAi), true);
  assert.equal(originAllowed("https://www.workbuddy.cn", VARIANTS.workbuddyAi), false);
  assert.equal(originAllowed("https://www.codebuddy.cn", VARIANTS.workbuddy), false);
});

test("china fetch uses only the china host and ignores reward rows", async () => {
  const calls = [];
  const result = await fetchWorkbuddyLimits({
    env: { HOME: os.tmpdir(), WORKBUDDY_ACCESS_TOKEN: "cn-token" },
    origin: "https://www.workbuddy.cn",
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      if (url.endsWith("get-user-resource-summary")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              SubscriptionPackageName: "体验版",
              Packages: [trialRow(), {
                PackageCode: REWARD,
                PackageName: "官方活动发放",
                CycleTotalCapacity: 1500,
                CycleRemainCapacity: 1500,
                CycleUsedCapacity: 0,
              }],
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { Accounts: [] } }) };
    },
  });

  assert.equal(result.plan_label, "Free");
  assert.ok(Math.abs(result.primary_window.used_percent - 49.658) < 0.001);
  assert.ok(calls.every((call) => call.url.startsWith("https://www.workbuddy.cn/")));
  assert.ok(calls.every((call) => call.auth === "Bearer cn-token"));
  assert.equal(calls.some((call) => call.url.includes("workbuddy.ai")), false);
});

test("international fetch refuses a china host and a china session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ai-"));
  const authPath = path.join(dir, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, JSON.stringify({
    auth: { accessToken: "cn-session", domain: "www.workbuddy.cn" },
  }));
  const called = [];
  const result = await fetchWorkbuddyAiLimits({
    env: { HOME: dir, WORKBUDDY_AI_HOME: path.join(dir, "missing-ai") },
    authFiles: [authPath],
    fetchImpl: async (url) => {
      called.push(url);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: {} }) };
    },
  });
  assert.deepEqual(result, { configured: false });
  assert.deepEqual(called, []);
});

test("an encrypted session without a running proxy asks to start WorkBuddy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-enc-"));
  const authPath = path.join(dir, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, JSON.stringify({
    auth: {
      domain: "www.workbuddy.cn",
      accessToken: { $wbEncrypted: 1, envelope: "ciphertext" },
    },
  }));
  const called = [];
  const result = await fetchWorkbuddyLimits({
    env: { HOME: dir },
    authFiles: [authPath],
    fetchImpl: async (url) => {
      called.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(result.configured, true);
  assert.match(result.error, /Start WorkBuddy and sign in/);
  assert.deepEqual(called, []);
});

test("a plaintext china session is sent only to the china host", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-plain-"));
  const authPath = path.join(dir, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, JSON.stringify({
    auth: { accessToken: "plain-cn-token", domain: "www.workbuddy.cn" },
  }));
  const urls = [];
  const result = await fetchWorkbuddyLimits({
    env: { HOME: dir, WORKBUDDY_HOME: path.join(dir, "nope") },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(init.headers.Authorization, "Bearer plain-cn-token");
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { Packages: [trialRow()] } }),
      };
    },
  });
  assert.equal(result.configured, true);
  assert.equal(result.error, null);
  assert.ok(urls.every((url) => url.startsWith("https://www.workbuddy.cn/")));
});

// The live summary shape (China 5.9.3): plan_base exhausted, a partially used
// platform-reward group, and empty gift/add-on groups.
const CREDIT_GROUPS_SUMMARY = {
  code: 0,
  data: {
    SubscriptionPackageName: "体验版",
    TotalCredits: 3831.03,
    Packages: [trialRow({
      CycleTotalCapacity: 500,
      CycleRemainCapacity: 0,
      CycleUsedCapacity: 500,
    })],
    CreditGroups: [
      { Kind: "plan_base", Name: "套餐基础积分", CycleTotalCapacity: "500", CycleRemainCapacity: "0", CycleUsedCapacity: "500" },
      { Kind: "plan_bonus", Name: "套餐赠送积分", CycleTotalCapacity: "0", CycleRemainCapacity: "0", CycleUsedCapacity: "0" },
      { Kind: "addon", Name: "购买积分", CycleTotalCapacity: "0", CycleRemainCapacity: "0", CycleUsedCapacity: "0" },
      { Kind: "benefit", Name: "平台奖励积分", CycleTotalCapacity: "6038", CycleRemainCapacity: "3831.03000062", CycleUsedCapacity: "2206.96999938" },
    ],
  },
};

test("resource window pools every non-plan credit group without a reset", () => {
  const pool = collectResourceGroups(CREDIT_GROUPS_SUMMARY);
  const window = resourceWindow(pool);
  assert.ok(window);
  assert.equal(window.limit_credits, 6038);
  assert.ok(Math.abs(window.used_credits - 2206.96999938) < 1e-9);
  assert.ok(Math.abs(window.remaining_credits - 3831.03000062) < 1e-9);
  assert.ok(Math.abs(window.used_percent - (2206.96999938 / 6038) * 100) < 1e-9);
  assert.equal(window.reset_at, null);
});

test("an all-zero resource pool yields no window", () => {
  const summary = {
    code: 0,
    data: {
      Packages: [trialRow()],
      CreditGroups: [
        { Kind: "plan_base", CycleTotalCapacity: "500", CycleRemainCapacity: "251.71", CycleUsedCapacity: "248.29" },
        { Kind: "benefit", CycleTotalCapacity: "0", CycleRemainCapacity: "0", CycleUsedCapacity: "0" },
      ],
    },
  };
  const pool = collectResourceGroups(summary);
  assert.ok(pool);
  assert.equal(pool.total, 0);
  assert.equal(resourceWindow(pool), null);
  assert.equal(resourceWindow({ total: 0, used: 0, remain: 0, seen: true }), null);
});

test("groups that omit CycleRemainCapacity keep remaining_credits exact", () => {
  const summary = {
    code: 0,
    data: {
      CreditGroups: [
        { Kind: "benefit", CycleTotalCapacity: "100", CycleUsedCapacity: "30" },
        { Kind: "addon", CycleTotalCapacity: "50", CycleRemainCapacity: "50", CycleUsedCapacity: "0" },
      ],
    },
  };
  const window = resourceWindow(collectResourceGroups(summary));
  assert.ok(window);
  assert.equal(window.limit_credits, 150);
  assert.equal(window.used_credits, 30);
  assert.equal(window.remaining_credits, 120);
});

test("a group that omits CycleUsedCapacity still counts its usage in the pool", () => {
  const summary = {
    code: 0,
    data: {
      CreditGroups: [
        { Kind: "benefit", CycleTotalCapacity: "100", CycleRemainCapacity: "0" },
        { Kind: "addon", CycleTotalCapacity: "50", CycleRemainCapacity: "40", CycleUsedCapacity: "10" },
      ],
    },
  };
  const window = resourceWindow(collectResourceGroups(summary));
  assert.ok(window);
  assert.equal(window.limit_credits, 150);
  assert.equal(window.used_credits, 110);
  assert.equal(window.remaining_credits, 40);
  assert.ok(Math.abs(window.used_percent - (110 / 150) * 100) < 1e-9);
});

test("package rows that omit CycleUsedCapacity are derived in the pooled fallback", () => {
  const summary = {
    code: 0,
    data: {
      Packages: [{
        PackageCode: REWARD,
        PackageName: "官方活动发放",
        CycleTotalCapacity: 100,
        CycleRemainCapacity: 0,
      }, {
        PackageCode: REWARD,
        PackageName: "官方活动发放",
        CycleTotalCapacity: 50,
        CycleRemainCapacity: 40,
        CycleUsedCapacity: 10,
      }],
    },
  };
  const window = resourceWindow(collectResourceGroups(summary));
  assert.ok(window);
  assert.equal(window.limit_credits, 150);
  assert.equal(window.used_credits, 110);
  assert.equal(window.remaining_credits, 40);
});

test("a pool that reports total but no usage stays hidden", () => {
  const summary = {
    code: 0,
    data: {
      CreditGroups: [{ Kind: "benefit", CycleTotalCapacity: "100" }],
    },
  };
  const pool = collectResourceGroups(summary);
  assert.ok(pool);
  assert.equal(resourceWindow(pool), null);
});

test("plan_base kind matches case-insensitively so plan credits never double-count", () => {
  const summary = {
    code: 0,
    data: {
      CreditGroups: [
        { Kind: "PLAN_BASE", CycleTotalCapacity: "500", CycleRemainCapacity: "0", CycleUsedCapacity: "500" },
        { Kind: "benefit", CycleTotalCapacity: "100", CycleRemainCapacity: "70", CycleUsedCapacity: "30" },
      ],
    },
  };
  const window = resourceWindow(collectResourceGroups(summary));
  assert.ok(window);
  assert.equal(window.limit_credits, 100);
  assert.equal(window.used_credits, 30);
});

test("a pool made only of plan_base groups yields no window", () => {
  const summary = {
    code: 0,
    data: {
      CreditGroups: [
        { Kind: "plan_base", CycleTotalCapacity: "500", CycleRemainCapacity: "0", CycleUsedCapacity: "500" },
      ],
    },
  };
  assert.equal(resourceWindow(collectResourceGroups(summary)), null);
});

test("an exhausted resource pool with only remain reported stays visible at 100%", () => {
  const summary = {
    code: 0,
    data: {
      CreditGroups: [
        { Kind: "benefit", CycleTotalCapacity: "100", CycleRemainCapacity: "0" },
      ],
    },
  };
  const window = resourceWindow(collectResourceGroups(summary));
  assert.ok(window);
  assert.equal(window.used_percent, 100);
  assert.equal(window.used_credits, 100);
  assert.equal(window.remaining_credits, 0);
});

test("overflowing credit sums yield no window instead of Infinity", () => {
  const summary = {
    code: 0,
    data: {
      CreditGroups: [
        { Kind: "benefit", CycleTotalCapacity: "1e308", CycleRemainCapacity: "1e308", CycleUsedCapacity: "0" },
        { Kind: "addon", CycleTotalCapacity: "1e308", CycleRemainCapacity: "1e308", CycleUsedCapacity: "0" },
      ],
    },
  };
  assert.equal(resourceWindow(collectResourceGroups(summary)), null);
});

test("an overflowing remaining sum yields no window even when total stays finite", () => {
  const summary = {
    code: 0,
    data: {
      CreditGroups: [
        { Kind: "benefit", CycleTotalCapacity: "100", CycleUsedCapacity: "5", CycleRemainCapacity: "1e308" },
        { Kind: "addon", CycleRemainCapacity: "1e308" },
      ],
    },
  };
  assert.equal(resourceWindow(collectResourceGroups(summary)), null);
});

test("summaries without CreditGroups pool non-plan package rows instead", () => {
  const summary = {
    code: 0,
    data: {
      Packages: [trialRow(), {
        PackageCode: REWARD,
        PackageName: "官方活动发放",
        CycleTotalCapacity: 1500,
        CycleRemainCapacity: 1500,
        CycleUsedCapacity: 0,
      }],
    },
  };
  const window = resourceWindow(collectResourceGroups(summary));
  assert.ok(window);
  assert.equal(window.limit_credits, 1500);
  assert.equal(window.used_percent, 0);
  assert.equal(window.remaining_credits, 1500);
});

test("both editions publish the plan window and the resource window", async () => {
  const summaryFixture = () => ({
    ok: true,
    status: 200,
    json: async () => CREDIT_GROUPS_SUMMARY,
  });
  const cn = await fetchWorkbuddyLimits({
    env: { HOME: os.tmpdir(), WORKBUDDY_ACCESS_TOKEN: "cn-token" },
    origin: "https://www.workbuddy.cn",
    fetchImpl: async (url) => (
      url.endsWith("get-user-resource-summary") ? summaryFixture()
        : { ok: true, status: 200, json: async () => ({ code: 0, data: { Accounts: [] } }) }
    ),
  });
  assert.equal(cn.plan_label, "Free");
  assert.equal(cn.primary_window.limit_credits, 500);
  assert.equal(cn.primary_window.used_percent, 100);
  assert.equal(cn.secondary_window.limit_credits, 6038);
  assert.equal(cn.secondary_window.reset_at, null);

  const ai = await fetchWorkbuddyAiLimits({
    env: { HOME: os.tmpdir(), WORKBUDDY_AI_ACCESS_TOKEN: "ai-token" },
    origin: "https://www.workbuddy.ai",
    fetchImpl: async (url) => (
      url.endsWith("get-user-resource-summary")
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              code: 0,
              data: {
                SubscriptionPackageName: "Free",
                Packages: [trialRow({
                  PackageCode: "TCACA_code_035_ArVxJcGDsm",
                  CycleTotalCapacity: 100,
                  CycleRemainCapacity: 100,
                  CycleUsedCapacity: 0,
                })],
                CreditGroups: [
                  { Kind: "plan_base", CycleTotalCapacity: "100", CycleRemainCapacity: "100", CycleUsedCapacity: "0" },
                  { Kind: "benefit", CycleTotalCapacity: "0", CycleRemainCapacity: "0", CycleUsedCapacity: "0" },
                ],
              },
            }),
          }
        : { ok: true, status: 200, json: async () => ({ code: 0, data: { Accounts: [] } }) }
    ),
  });
  assert.equal(ai.plan_label, "Free");
  assert.equal(ai.primary_window.limit_credits, 100);
  assert.equal(ai.secondary_window, null);
});

// ---------------------------------------------------------------------------
// Last-good disk cache (issue #952): a live read persists the windows per
// edition; a later live failure — WorkBuddy's steady state is "app closed",
// where the encrypted session cannot be read — serves them with data-age
// markers instead of a bare "Start WorkBuddy and sign in".

const T0 = Date.parse("2026-07-08T00:00:00Z");

function planWindowFixture(resetAt) {
  return {
    used_percent: 49.658,
    reset_at: resetAt,
    used_credits: 248.29,
    limit_credits: 500,
    remaining_credits: 251.71,
  };
}

// An auth record as the desktop app writes it: the session token (encrypted
// unless stated) plus the signed-in account's uid, which stays readable while
// the app is closed.
function authFileInfo({ domain = "www.workbuddy.cn", token, uid } = {}) {
  return JSON.stringify({
    ...(uid ? { account: { uid } } : {}),
    auth: {
      domain,
      accessToken: token ?? { $wbEncrypted: 1, envelope: "ciphertext" },
    },
  });
}

function summaryFetch(summary) {
  return async (url) => (
    url.endsWith("get-user-resource-summary")
      ? { ok: true, status: 200, json: async () => summary }
      : { ok: true, status: 200, json: async () => ({ code: 0, data: { Accounts: [] } }) }
  );
}

test("a live read persists last-good windows per edition without crossing editions", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  const authPath = path.join(home, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, authFileInfo({ token: "cn-token", uid: "uid-cn" }));
  const cn = await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: summaryFetch(CREDIT_GROUPS_SUMMARY),
  });
  assert.equal(cn.error, null);
  const ai = await fetchWorkbuddyAiLimits({
    home,
    nowMs: T0,
    env: { HOME: home, WORKBUDDY_AI_ACCESS_TOKEN: "ai-token" },
    origin: "https://www.workbuddy.ai",
    fetchImpl: summaryFetch({
      code: 0,
      data: {
        SubscriptionPackageName: "Free",
        Packages: [trialRow({
          PackageCode: "TCACA_code_035_ArVxJcGDsm",
          CycleTotalCapacity: 100,
          CycleRemainCapacity: 100,
          CycleUsedCapacity: 0,
        })],
        CreditGroups: [
          { Kind: "plan_base", CycleTotalCapacity: "100", CycleRemainCapacity: "100", CycleUsedCapacity: "0" },
          { Kind: "benefit", CycleTotalCapacity: "0", CycleRemainCapacity: "0", CycleUsedCapacity: "0" },
        ],
      },
    }),
  });
  assert.equal(ai.error, null);

  const stored = JSON.parse(fs.readFileSync(workbuddyLimitsCachePath({ home }), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["workbuddy", "workbuddyAi"]);
  assert.equal(stored.workbuddy.identity, "uid-cn");
  assert.equal(stored.workbuddy.plan_label, "Free");
  assert.equal(stored.workbuddy.primary_window.limit_credits, 500);
  assert.equal(stored.workbuddy.secondary_window.limit_credits, 6038);
  assert.ok(Number.isFinite(Date.parse(stored.workbuddy.cached_at)));
  assert.equal(stored.workbuddyAi.identity, "unknown");
  assert.equal(stored.workbuddyAi.primary_window.limit_credits, 100);
  assert.equal(stored.workbuddyAi.secondary_window, null);
});

test("a closed app serves the last-good windows with stale markers", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  const authPath = path.join(home, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, authFileInfo({ token: "cn-token", uid: "uid-cn" }));
  const live = await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: summaryFetch(CREDIT_GROUPS_SUMMARY),
  });
  assert.equal(live.error, null);

  // App closed: the session token is encrypted and unreadable, but the same
  // auth record still names the account that produced the cached windows.
  fs.writeFileSync(authPath, authFileInfo({ uid: "uid-cn" }));
  const calls = [];
  const cached = await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: async (url) => {
      calls.push(url);
      throw new Error("no network in this test");
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(cached.configured, true);
  assert.equal(cached.error, null);
  assert.equal(cached.stale, true);
  assert.equal(cached.cached, true);
  assert.equal(cached.source, "disk-cache");
  assert.equal(cached.plan_label, "Free");
  assert.equal(cached.primary_window.limit_credits, 500);
  assert.equal(cached.secondary_window.limit_credits, 6038);
  const stored = JSON.parse(fs.readFileSync(workbuddyLimitsCachePath({ home }), "utf8"));
  assert.equal(cached.cached_at, stored.workbuddy.cached_at);
});

test("an account switch keeps the previous login's windows out of the fallback", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  const authPath = path.join(home, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, authFileInfo({ token: "cn-token", uid: "uid-cn" }));
  await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: summaryFetch(CREDIT_GROUPS_SUMMARY),
  });

  // The app rewrote the auth record for another account; the encrypted
  // session cannot be read and the cached windows name the previous login.
  fs.writeFileSync(authPath, authFileInfo({ uid: "uid-other" }));
  const switched = await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: async () => {
      throw new Error("no network in this test");
    },
  });
  assert.equal(switched.configured, true);
  assert.match(switched.error, /Start WorkBuddy and sign in/);

  // Back on the original login the same snapshot is usable again.
  fs.writeFileSync(authPath, authFileInfo({ uid: "uid-cn" }));
  const restored = await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: async () => {
      throw new Error("no network in this test");
    },
  });
  assert.equal(restored.error, null);
  assert.equal(restored.source, "disk-cache");
});

test("an edition never falls back to the other edition's cached windows", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  const authPath = path.join(home, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, authFileInfo({ token: "cn-token", uid: "uid-cn" }));
  await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: summaryFetch(CREDIT_GROUPS_SUMMARY),
  });

  const aiAuth = path.join(home, "workbuddy-ai.info");
  fs.writeFileSync(aiAuth, authFileInfo({ domain: "www.workbuddy.ai", uid: "uid-ai" }));
  const calls = [];
  const ai = await fetchWorkbuddyAiLimits({
    home,
    env: { HOME: home },
    authFiles: [aiAuth],
    fetchImpl: async (url) => {
      calls.push(url);
      throw new Error("no network in this test");
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(ai.configured, true);
  assert.match(ai.error, /Start WorkBuddy and sign in/);
});

test("auth expiry bypasses the cache so re-login stays visible", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  const authPath = path.join(home, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, authFileInfo({ token: "cn-token", uid: "uid-cn" }));
  await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: summaryFetch(CREDIT_GROUPS_SUMMARY),
  });
  await assert.rejects(
    fetchWorkbuddyLimits({
      home,
      nowMs: T0,
      env: { HOME: home },
      authFiles: [authPath],
      origin: "https://www.workbuddy.cn",
      fetchImpl: async () => ({ ok: false, status: 401 }),
    }),
    /sign-in expired/,
  );
});

test("a never-signed-in install stays unconfigured even with cache on disk", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  writeWorkbuddyLimitsCache(
    {
      configured: true, error: null, plan_label: "Free",
      primary_window: planWindowFixture("2027-01-01T00:00:00Z"), secondary_window: null,
    },
    { home, nowMs: T0, variantId: "workbuddy", identity: "unknown" },
  );
  const result = await fetchWorkbuddyLimits({ home, env: { HOME: home } });
  assert.deepEqual(result, { configured: false });
});

test("an unreadable account matches only its own cache entries", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  // No auth record anywhere, so the write is stamped with "unknown".
  await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home, WORKBUDDY_ACCESS_TOKEN: "cn-token" },
    origin: "https://www.workbuddy.cn",
    fetchImpl: summaryFetch(CREDIT_GROUPS_SUMMARY),
  });

  // The app has since closed and left an auth record naming the account:
  // an entry stamped "unknown" must not serve that login.
  const authPath = path.join(home, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, authFileInfo({ uid: "uid-cn" }));
  const named = await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: async () => {
      throw new Error("no network in this test");
    },
  });
  assert.match(named.error, /Start WorkBuddy and sign in/);

  // Without the record, "unknown" again describes everything we know and the
  // entry is the best available data.
  fs.unlinkSync(authPath);
  fs.mkdirSync(path.join(home, ".workbuddy"), { recursive: true });
  const unnamed = await fetchWorkbuddyLimits({
    home,
    nowMs: T0,
    env: { HOME: home },
    origin: "https://www.workbuddy.cn",
    fetchImpl: async () => {
      throw new Error("no network in this test");
    },
  });
  assert.equal(unnamed.error, null);
  assert.equal(unnamed.source, "disk-cache");
});

test("cache windows expire by rollover and by the undated snapshot TTL", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  const write = (windows) => writeWorkbuddyLimitsCache(
    {
      configured: true, error: null, plan_label: "Free",
      primary_window: windows.primary ?? null, secondary_window: windows.secondary ?? null,
    },
    { home, nowMs: T0, variantId: "workbuddy", identity: "uid" },
  );
  const read = (nowMs = T0) => readWorkbuddyLimitsCache({ home, nowMs, variantId: "workbuddy", identity: "uid" });

  write({
    primary: planWindowFixture("2026-07-01T00:00:00Z"),
    secondary: { used_percent: 10, reset_at: null, used_credits: 1, limit_credits: 10, remaining_credits: 9 },
  });
  let cached = read();
  assert.equal(cached.primary_window, null); // the plan cycle rolled over
  assert.equal(cached.secondary_window.limit_credits, 10);

  write({ primary: planWindowFixture("2027-01-01T00:00:00Z") });
  cached = read();
  assert.equal(cached.primary_window.limit_credits, 500);
  assert.equal(cached.secondary_window, null);

  write({ primary: planWindowFixture("2026-07-01T00:00:00Z") });
  assert.equal(read(), null); // nothing survives, so no hit

  // Undated windows (the pooled resource window) live on the snapshot TTL.
  write({
    primary: planWindowFixture(null),
    secondary: { used_percent: 10, reset_at: null, used_credits: 1, limit_credits: 10, remaining_credits: 9 },
  });
  assert.ok(read(T0 + 11 * 60 * 60 * 1000));
  assert.equal(read(T0 + 13 * 60 * 60 * 1000), null);
});

test("cache entries are scoped to the identity that wrote them", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  writeWorkbuddyLimitsCache(
    {
      configured: true, error: null, plan_label: "Free",
      primary_window: planWindowFixture("2027-01-01T00:00:00Z"), secondary_window: null,
    },
    { home, nowMs: T0, variantId: "workbuddy", identity: "uid-a" },
  );
  assert.equal(
    readWorkbuddyLimitsCache({ home, nowMs: T0, variantId: "workbuddy", identity: "uid-b" }),
    null,
  );
  assert.ok(readWorkbuddyLimitsCache({ home, nowMs: T0, variantId: "workbuddy", identity: "uid-a" }));
  assert.equal(
    readWorkbuddyLimitsCache({ home, nowMs: T0, variantId: "workbuddy", identity: "unknown" }),
    null,
  );
});

test("a cached_at in the future beyond the skew guard is not trusted", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  writeWorkbuddyLimitsCache(
    {
      configured: true, error: null, plan_label: "Free",
      primary_window: planWindowFixture("2027-01-01T00:00:00Z"), secondary_window: null,
    },
    { home, nowMs: T0 + 10 * 60 * 60 * 1000, variantId: "workbuddy", identity: "uid" },
  );
  assert.equal(
    readWorkbuddyLimitsCache({ home, nowMs: T0, variantId: "workbuddy", identity: "uid" }),
    null,
  );
  assert.ok(readWorkbuddyLimitsCache({
    home, nowMs: T0 + 10 * 60 * 60 * 1000 - 30_000, variantId: "workbuddy", identity: "uid",
  }));
});

// Production forwards no clock into the edition fetch, so the cache gate
// samples at read time even when the live attempt spends its whole budget.
test("a window that rolls while the live attempt runs is not served", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  const authPath = path.join(home, "workbuddy-desktop.info");
  fs.writeFileSync(authPath, authFileInfo({ token: "cn-token", uid: "uid-cn" }));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: T0 });
  // Live success writes a plan window whose cycle ends five seconds out.
  const live = await fetchWorkbuddyLimits({
    home,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: summaryFetch({
      code: 0,
      data: {
        SubscriptionPackageName: "体验版",
        Packages: [trialRow({ CycleEndTime: "2026-07-08T00:00:05.000Z" })],
      },
    }),
  });
  assert.equal(live.error, null);

  // The next poll starts while the window is still live; its live attempt
  // only fails after the budget-sized delay, by which time the cycle rolled.
  const pending = fetchWorkbuddyLimits({
    home,
    env: { HOME: home },
    authFiles: [authPath],
    origin: "https://www.workbuddy.cn",
    fetchImpl: () => new Promise((_, reject) => {
      setTimeout(() => reject(new Error("offline")), 30_000);
    }),
  });
  t.mock.timers.tick(60_000);
  // The rolled window is dropped and nothing survives it: the live error
  // stays visible instead of an expired snapshot.
  await assert.rejects(pending, /offline/);
});

// The WorkBuddy call site wraps the provider budget so the post-abort
// disk-cache fallback can land instead of the bare timeout error (the abort
// fails the IPC socket within milliseconds and the cache read is synchronous).
test("the workbuddy budget lets the post-abort cache fallback win", async () => {
  const result = await withWorkbuddyProviderTimeout((signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      setTimeout(() => resolve("cache-hit"), 10);
    });
  }), "WorkBuddy", 20);
  assert.equal(result, "cache-hit");
});

test("the workbuddy budget still enforces its hard bound", async () => {
  await assert.rejects(
    withWorkbuddyProviderTimeout(() => new Promise(() => {}), "WorkBuddy", 20, 20),
    /timed out/,
  );
});

test("a rejection the budget's abort caused reports the timeout, not the symptom", async () => {
  await assert.rejects(
    withWorkbuddyProviderTimeout((signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        setTimeout(() => reject(new Error("WorkBuddy quota request was cancelled.")), 10);
      });
    }), "WorkBuddy", 20),
    /timed out/,
  );
});

test("an attempt that settles inside the workbuddy budget is served as-is", async () => {
  const result = await withWorkbuddyProviderTimeout(async () => "live", "WorkBuddy", 30_000);
  assert.equal(result, "live");
});

test("an attempt that rejects inside the workbuddy budget keeps its own error", async () => {
  await assert.rejects(
    withWorkbuddyProviderTimeout(async () => {
      throw new Error("WorkBuddy quota request failed.");
    }, "WorkBuddy", 30_000),
    /quota request failed/,
  );
});
