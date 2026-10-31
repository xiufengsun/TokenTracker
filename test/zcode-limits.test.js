const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  deriveZcodePlanLabel,
  normalizeZcodeBalanceResponse,
  loadZcodeCredential,
  loadLatestZcodeBalanceFromLogs,
  loadZcodeAuthCandidates,
  loadZcodeApiKey,
  fetchZcodeLimits,
  isZcodeInstalled,
  normalizeZcodeCodingPlanQuotaResponse,
  readZcodeLimitsCache,
  resolveZcodeAppVersion,
  resolveZcodeProviderBillingBaseUrl,
  resolveZcodeProviderQuotaUrl,
  loadZcodeSelectedPlanProviderKeys,
  writeZcodeLimitsCache,
  zcodeCacheIdentity,
  scanZcodeBalanceLogs,
  zcodePlanKindFromProviderId,
  zcodeRegionFromProviderId,
} = require("../src/lib/zcode-limits");

// Real billing/balance payload shape captured from ZCode's own logs.
function balanceBody() {
  return {
    code: 0,
    msg: "",
    data: {
      server_time: 1782188525,
      balances: [
        {
          plan_id: "zcode-v3-start-plan-0615",
          entitlement_id: "ent_start_public_glm_5p2",
          show_name: "GLM-5.2",
          total_units: 3_000_000,
          used_units: 600_000,
          remaining_units: 2_400_000,
          period_end: 1782230399,
          expires_at: 1782230399,
        },
        {
          plan_id: "zcode-v3-start-plan-0615",
          entitlement_id: "ent_start_public_glm_5turbo",
          show_name: "GLM-5-Turbo",
          total_units: 2_000_000,
          used_units: 0,
          remaining_units: 2_000_000,
          period_end: 1782230399,
          expires_at: 1782230399,
        },
      ],
    },
  };
}

function codingPlanQuotaBody() {
  return {
    code: 200,
    success: true,
    data: {
      level: "PRO",
      limits: [
        {
          type: "TIME_LIMIT",
          number: 10_000_000,
          usage: 2_500_000,
          remaining: 7_500_000,
          nextResetTime: 1_783_526_399_000,
          usageDetails: [{ modelCode: "glm-5.2", displayName: "GLM-5.2", usage: 2_500_000 }],
        },
        {
          type: "MONTHLY_TOKEN",
          number: 100_000_000,
          currentValue: 25_000_000,
          remaining: 75_000_000,
          nextResetTime: 1_784_131_199_000,
          usageDetails: [{ modelCode: "glm-5-turbo", displayName: "GLM-5-Turbo", usage: 25_000_000 }],
        },
      ],
    },
  };
}

// Real lite coding-plan payload from issue #279 (before/after model use).
// percentage is already-used %; unit/number identify the window, not a token total.
// tokenRowType covers ZCode 3.17.1 renaming the rows to CREDIT_LIMIT (issue #937).
function realLiteCodingPlanQuotaBody({ fiveHourPercent = 14, tokenRowType = "TOKENS_LIMIT" } = {}) {
  return {
    code: 200,
    msg: "Operation successful",
    success: true,
    data: {
      level: "lite",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: 0,
          remaining: 100,
          percentage: 0,
          nextResetTime: 1_786_091_571_974,
          usageDetails: [
            { modelCode: "search-prime", usage: 0 },
            { modelCode: "web-reader", usage: 0 },
            { modelCode: "zread", usage: 0 },
          ],
        },
        {
          type: tokenRowType,
          unit: 3,
          number: 5,
          percentage: fiveHourPercent,
          nextResetTime: 1_783_540_151_760,
        },
        {
          type: tokenRowType,
          unit: 6,
          number: 1,
          percentage: 43,
          nextResetTime: 1_784_017_971_993,
        },
      ],
    },
  };
}

function zcodeCredentialSecret(home) {
  return `zcode-credential-fallback:${process.platform}:${home}:${os.userInfo().username || ""}`;
}

function encryptZcodeCredentialValue(value, home) {
  const iv = Buffer.alloc(12, 7);
  const key = crypto.createHash("sha256").update(zcodeCredentialSecret(home)).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function writeZcodeCredentials(v2, home, values) {
  const encrypted = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, encryptZcodeCredentialValue(value, home)]),
  );
  fs.writeFileSync(path.join(v2, "credentials.json"), JSON.stringify(encrypted), "utf8");
}

function writeZcodeBalanceLog(v2, timestamp, { providerId = "builtin:zai-start-plan", body = balanceBody() } = {}) {
  const logsDir = path.join(v2, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const day = timestamp.slice(0, 10);
  const entry = {
    balanceCount: body.data.balances.length,
    balances: body.data.balances,
    code: 0,
    msg: "",
    payload: body,
    providerId,
    success: true,
    url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.2.5",
  };
  fs.writeFileSync(
    path.join(logsDir, `${day}.log`),
    `[${timestamp}] [info] [pid:1] [main] [host-log] [usage-stats] billing/balance 请求完成 ${JSON.stringify(entry)}\n`,
    "utf8",
  );
}

/** Run a quota scenario with synthetic provider keys in a temporary ZCode home. */
function withZcodePlanSettings(settings, run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-team-plan-"));
  const v2 = path.join(tmp, ".zcode", "v2");
  fs.mkdirSync(v2, { recursive: true });
  fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({
    provider: Object.fromEntries(["bigmodel", "zai"].map((family) => [
      `builtin:${family}-coding-plan`,
      { enabled: true, options: { apiKey: `${family}-key` } },
    ])),
  }));
  fs.writeFileSync(path.join(v2, "setting.json"), JSON.stringify(settings));
  return Promise.resolve().then(() => run(tmp, v2)).finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

/** Run a scenario in a ZCode 3.14 home (credentials.json only, no config.json). */
function withZcode314LoginHome(credentials, run, { setting } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-login-"));
  const v2 = path.join(tmp, ".zcode", "v2");
  fs.mkdirSync(v2, { recursive: true });
  writeZcodeCredentials(v2, tmp, credentials);
  fs.writeFileSync(path.join(v2, "setting.json"), JSON.stringify(setting || {
    providerFamilyDomain: "bigmodel",
    providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
  }));
  return Promise.resolve().then(() => run(tmp, v2)).finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

describe("ZCode team-plan quotas", () => {
  for (const [family, origin] of [["bigmodel", "https://bigmodel.cn"], ["zai", "https://api.z.ai"]]) {
    it(`queries the selected ${family} team instead of the personal coding plan`, async () => {
      await withZcodePlanSettings({
        providerFamilyDomain: family,
        modelProviderFamilySelectedKeys: {
          [family]: `team-plan:builtin:${family}-coding-plan:product-max:org-example:proj-example`,
        },
      }, async (home) => {
        const requests = [];
        const result = await fetchZcodeLimits({
          home,
          env: {},
          /** Emulate a server that exposes the fixture only with the full team scope. */
          fetchImpl: async (url, options) => {
            requests.push({ url, headers: options.headers });
            // The server accepts the same key, but needs the team scope to find its plan.
            const teamRequest = new URL(url).searchParams.get("type") === "2"
              && options.headers["bigmodel-organization"] === "org-example"
              && options.headers["bigmodel-project"] === "proj-example";
            return { ok: true, status: 200, async json() {
              return teamRequest
                ? realLiteCodingPlanQuotaBody()
                : { code: 500, success: false, msg: "当前用户不存在coding plan" };
            } };
          },
        });
        assert.equal(result.error, null);
        assert.equal(result.provider_key, `builtin:${family}-coding-plan`);
        assert.equal(result.primary_window.used_percent, 14);
        assert.deepEqual(requests, [{
          url: `${origin}/api/monitor/usage/quota/limit?type=2`,
          headers: {
            authorization: `${family}-key`,
            Accept: "application/json",
            "bigmodel-organization": "org-example",
            "bigmodel-project": "proj-example",
          },
        }]);
      });
    });
  }

  it("decodes team identifiers and preserves quota URL override parameters", async () => {
    await withZcodePlanSettings({
      providerFamilyDomain: "bigmodel",
      modelProviderFamilySelectedKeys: {
        bigmodel: "team-plan:builtin:bigmodel-coding-plan:product-max:org%3Aexample:proj%2Fexample",
      },
    }, async (home) => {
      const result = await fetchZcodeLimits({
        home,
        env: { TOKENTRACKER_ZCODE_MONITOR_QUOTA_URL: "https://quota.example.test/limit?locale=en&type=1" },
        /** Check decoded routing headers and preserved query parameters before responding. */
        fetchImpl: async (url, options) => {
          assert.equal(url, "https://quota.example.test/limit?locale=en&type=2");
          assert.equal(options.headers["bigmodel-organization"], "org:example");
          assert.equal(options.headers["bigmodel-project"], "proj/example");
          return { ok: true, status: 200, async json() { return realLiteCodingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.error, null);
    });
  });

  it("keeps another family's team scope off personal-plan requests", async () => {
    await withZcodePlanSettings({
      providerFamilyDomain: "bigmodel",
      modelProviderFamilySelectedKeys: {
        bigmodel: "coding-plan:builtin:bigmodel-coding-plan",
        zai: "team-plan:builtin:zai-coding-plan:product-max:org-overseas:proj-overseas",
      },
    }, async (home) => {
      const requests = [];
      const result = await fetchZcodeLimits({
        home,
        env: {},
        /** Capture the personal request so its complete URL and headers can be compared. */
        fetchImpl: async (url, options) => {
          requests.push({ url, headers: options.headers });
          return { ok: true, status: 200, async json() { return realLiteCodingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.deepEqual(requests, [{
        url: "https://bigmodel.cn/api/monitor/usage/quota/limit",
        headers: { authorization: "bigmodel-key", Accept: "application/json" },
      }]);
    });
  });

  it("does not retain team scope after switching back to a personal plan", async () => {
    await withZcodePlanSettings({
      providerFamilyDomain: "bigmodel",
      modelProviderFamilySelectedKeys: {
        bigmodel: "team-plan:builtin:bigmodel-coding-plan:product-max:org-example:proj-example",
      },
    }, async (home, v2) => {
      const requests = [];
      /** Capture both reads across the settings change while keeping the quota response stable. */
      const fetchImpl = async (url, options) => {
        requests.push({ url, headers: options.headers });
        return { ok: true, status: 200, async json() { return realLiteCodingPlanQuotaBody(); } };
      };
      await fetchZcodeLimits({ home, env: {}, fetchImpl });
      fs.writeFileSync(path.join(v2, "setting.json"), JSON.stringify({
        providerFamilyDomain: "bigmodel",
        modelProviderFamilySelectedKeys: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
      }));
      await fetchZcodeLimits({ home, env: {}, fetchImpl });
      assert.equal(new URL(requests[0].url).searchParams.get("type"), "2");
      assert.deepEqual(requests[1], {
        url: "https://bigmodel.cn/api/monitor/usage/quota/limit",
        headers: { authorization: "bigmodel-key", Accept: "application/json" },
      });
    });
  });

  it("does not guess team scope from incomplete or malformed selections", async () => {
    for (const selected of [
      "team-plan:builtin:bigmodel-coding-plan:product-max:proj-legacy",
      "team-plan:builtin:bigmodel-coding-plan:product-max::proj-example",
      "team-plan:builtin:bigmodel-coding-plan:product-max:org-example:",
      "team-plan:builtin:bigmodel-coding-plan:product-max:%20:proj-example",
      "team-plan:builtin:bigmodel-coding-plan:product-max:org%ZZ:proj-example",
    ]) {
      await withZcodePlanSettings({
        providerFamilyDomain: "bigmodel",
        modelProviderFamilySelectedKeys: { bigmodel: selected },
      }, async (home) => {
        const result = await fetchZcodeLimits({
          home,
          env: {},
          /** Reject invented team scope when a stored selection cannot identify both IDs. */
          fetchImpl: async (url, options) => {
            assert.equal(new URL(url).searchParams.has("type"), false);
            assert.equal(options.headers["bigmodel-organization"], undefined);
            assert.equal(options.headers["bigmodel-project"], undefined);
            return { ok: true, status: 200, async json() { return realLiteCodingPlanQuotaBody(); } };
          },
        });
        assert.equal(result.error, null);
      });
    }
  });
});

describe("deriveZcodePlanLabel", () => {
  it("extracts the human tier from the raw plan id", () => {
    assert.equal(deriveZcodePlanLabel("zcode-v3-start-plan-0615"), "Start");
    assert.equal(deriveZcodePlanLabel("zcode-v3-pro-plan-0701"), "Pro");
    assert.equal(deriveZcodePlanLabel("zcode-v3-max-plan-0701"), "Max");
  });
  it("returns null for unknown / missing plan ids", () => {
    assert.equal(deriveZcodePlanLabel("zcode-v3-unknown-0615"), null);
    assert.equal(deriveZcodePlanLabel(""), null);
    assert.equal(deriveZcodePlanLabel(null), null);
  });
});

describe("ZCode active-region preference", () => {
  it("orders candidates with the active region first within each plan kind", async () => {
    await withZcodePlanSettings({
      providerFamilyDomain: "bigmodel",
      modelProviderFamilySelectedKeys: { zai: "coding-plan:builtin:zai-coding-plan" },
    }, async (home, v2) => {
      fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({
        provider: Object.fromEntries(["bigmodel", "zai"].flatMap((family) => [
          [`builtin:${family}-coding-plan`, { enabled: true, options: { apiKey: `${family}-coding-key` } }],
          [`builtin:${family}-start-plan`, { enabled: true, options: { apiKey: `${family}-start-key` } }],
        ])),
      }));
      fs.writeFileSync(path.join(v2, "coding-plan-cache.json"), JSON.stringify({
        entryStatus: { items: Object.fromEntries(
          ["bigmodel", "zai"].flatMap((family) => [
            [`builtin:${family}-coding-plan`, { status: "available" }],
            [`builtin:${family}-start-plan`, { status: "available" }],
          ]),
        ) },
      }));
      writeZcodeCredentials(v2, home, { "oauth:active_provider": "bigmodel" });
      assert.deepEqual(loadZcodeAuthCandidates({ home, env: {} }).map((auth) => auth.providerKey), [
        "builtin:bigmodel-coding-plan",
        "builtin:zai-coding-plan",
        "builtin:bigmodel-start-plan",
        "builtin:zai-start-plan",
      ]);
    });
  });

  it("serves the active region's paid plan even when another region was selected before", async () => {
    await withZcodePlanSettings({
      providerFamilyDomain: "bigmodel",
      modelProviderFamilySelectedKeys: { zai: "coding-plan:builtin:zai-coding-plan" },
    }, async (home, v2) => {
      writeZcodeCredentials(v2, home, { "oauth:active_provider": "bigmodel" });
      const requests = [];
      const result = await fetchZcodeLimits({
        home,
        env: {},
        fetchImpl: async (url, options) => {
          requests.push({ url, authorization: options.headers.authorization });
          return { ok: true, status: 200, async json() { return codingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:bigmodel-coding-plan");
      assert.deepEqual(requests, [{
        url: "https://bigmodel.cn/api/monitor/usage/quota/limit",
        authorization: "bigmodel-key",
      }]);
    });
  });

  it("follows the model settings' domain even without any OAuth login", async () => {
    await withZcodePlanSettings({
      providerFamilyDomain: "bigmodel",
      modelProviderFamilySelectedKeys: { zai: "coding-plan:builtin:zai-coding-plan" },
    }, async (home) => {
      const requests = [];
      const result = await fetchZcodeLimits({
        home,
        env: {},
        // API-key-only install: no credentials.json login at all, so the
        // settings domain is the only signal for the active region.
        fetchImpl: async (url) => {
          requests.push(url);
          return { ok: true, status: 200, async json() { return codingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:bigmodel-coding-plan");
      assert.deepEqual(requests, ["https://bigmodel.cn/api/monitor/usage/quota/limit"]);
    });
  });
});

describe("ZCode reset-card inventory", () => {
  const resetBody = () => ({ code: 0, data: {
    available_five_hour_resets: [{ expire_at: Date.now() + 86400000 }],
    available_week_resets: [{ expire_at: Date.now() + 172800000 }],
  } });
  const emptyGrantsBody = () => ({ code: 0, data: { balances: [] } });

  for (const family of ["bigmodel", "zai"]) {
    it(`reads ${family} reset cards with that family's login token`, async () => {
      await withZcodePlanSettings({
        providerFamilyDomain: family,
        modelProviderFamilySelectedKeys: { [family]: `coding-plan:builtin:${family}-coding-plan` },
      }, async (home, v2) => {
        writeZcodeCredentials(v2, home, {
          "oauth:active_provider": family, zcodejwttoken: "zcode-jwt",
          "oauth:bigmodel:access_token": "bigmodel-login",
          "oauth:zai:access_token": "zai-login",
          // The extras gate now requires a provable login identity: user_info
          // carries the login's account id and the account credential
          // byte-equals the config.json key, so that key inherits the identity.
          [`oauth:${family}:user_info`]: JSON.stringify({ id: "reset-owner" }),
          [`account-provider:coding-plan:account:${family}-individual-coding-plan:account:reset-owner:api-key`]: `${family}-key`,
        });
        const requests = [];
        const result = await fetchZcodeLimits({
          home, env: {},
          fetchImpl: async (url, options) => {
            requests.push(url);
            if (url.endsWith("/reset/status")) {
              assert.equal(options.headers.Authorization, "Bearer zcode-jwt");
              assert.equal(options.headers["X-Bigmodel-Authorization"], `${family}-login`);
              assert.equal(options.headers["Bigmodel-Target-Type"], "PERSONAL");
              return { ok: true, async json() { return resetBody(); } };
            }
            if (url.includes("/billing/balance")) {
              // No bonus grants on this login: the Start Plan section stays hidden.
              return { ok: true, async json() { return emptyGrantsBody(); } };
            }
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          },
        });
        assert.equal(result.error, null);
        assert.equal(result.provider_key, `builtin:${family}-coding-plan`);
        assert.equal(result.reset_credits.five_hour.length, 1);
        assert.equal(result.reset_credits.weekly.length, 1);
        assert.equal(result.start_plan, undefined);
        assert.equal(requests.length, 3);
      });
    });
  }

  for (const [selected, active, credentials] of [
    ["zai", "bigmodel", { "oauth:zai:access_token": "zai-login" }],
    ["bigmodel", "bigmodel", { "oauth:zai:access_token": "wrong-family-login" }],
  ]) {
    it(`does not substitute another account family for ${selected} reset inventory`, async () => {
      await withZcodePlanSettings({
        modelProviderFamilySelectedKeys: { [selected]: `coding-plan:builtin:${selected}-coding-plan` },
      }, async (home, v2) => {
        writeZcodeCredentials(v2, home, {
          "oauth:active_provider": active, zcodejwttoken: "zcode-jwt", ...credentials,
        });
        const urls = [];
        const result = await fetchZcodeLimits({ home, env: {}, fetchImpl: async (url) => {
          urls.push(url);
          return { ok: true, async json() { return codingPlanQuotaBody(); } };
        } });
        assert.equal(result.error, null);
        assert.equal(result.reset_credits, undefined);
        // The reset status endpoint is never contacted with another family's token.
        assert.ok(!urls.some((url) => url.endsWith("/reset/status")));
      });
    });
  }

  for (const budgetExhausted of [false, true]) {
    it(`preserves quota windows when reset inventory ${budgetExhausted ? "has no remaining time budget" : "fails"}`, async () => {
      await withZcodePlanSettings({
        modelProviderFamilySelectedKeys: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
      }, async (home, v2) => {
        writeZcodeCredentials(v2, home, {
          "oauth:active_provider": "bigmodel", zcodejwttoken: "zcode-jwt",
          "oauth:bigmodel:access_token": "regional-jwt",
          // The extras gate now requires a provable login identity: the
          // account credential byte-equals the config.json key the plan
          // settings wrote, so the key inherits the login's account id.
          "oauth:bigmodel:user_info": JSON.stringify({ id: "reset-owner" }),
          "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:reset-owner:api-key": "bigmodel-key",
        });
        const result = await fetchZcodeLimits({
          home, env: {}, providerTimeoutMs: budgetExhausted ? 50 : 8000,
          fetchImpl: async (url) => {
            if (url.endsWith("/reset/status")) return { ok: false, status: 500 };
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          },
        });
        assert.equal(result.error, null);
        assert.equal(result.plan_label, "Pro");
        assert.equal(result.primary_window.used_percent, 25);
        assert.match(result.reset_credits.error, budgetExhausted ? /budget exhausted/ : /HTTP 500/);
      });
    });
  }
});

describe("ZCode login-scoped extras", () => {
  const LOGIN_ID = "fixture-current-account";
  const STALE_ID = "99999999999999999";
  const accountKeyName = (family, accountId) =>
    `account-provider:coding-plan:account:${family}-individual-coding-plan:account:${accountId}:api-key`;
  const loginCredentials = (extra = {}) => ({
    "oauth:active_provider": "bigmodel",
    zcodejwttoken: "zcode-jwt",
    "oauth:bigmodel:access_token": "bigmodel-login",
    "oauth:bigmodel:user_info": JSON.stringify({ id: LOGIN_ID, username: "current" }),
    ...extra,
  });
  const resetBody = () => ({ code: 0, data: {
    available_five_hour_resets: [{ expire_at: Date.now() + 86400000 }],
    available_week_resets: [],
  } });

  it("reads quota and login-scoped extras with the signed-in account's own key", async () => {
    await withZcode314LoginHome(loginCredentials({
      [accountKeyName("bigmodel", STALE_ID)]: "stale-account-key",
      [accountKeyName("bigmodel", LOGIN_ID)]: "current-account-key",
    }), async (home) => {
      const quotaKeys = [];
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url, options) => {
          if (url.includes("/quota/limit")) {
            quotaKeys.push(options.headers.authorization);
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          }
          if (url.endsWith("/reset/status")) {
            return { ok: true, async json() { return resetBody(); } };
          }
          return { ok: true, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.error, null);
      // A leftover key from a previously signed-in account must never outrank
      // the current login's key for the primary windows.
      assert.deepEqual(quotaKeys, ["current-account-key"]);
      assert.equal(result.reset_credits.five_hour.length, 1);
      assert.equal(result.start_plan?.configured, true);
      assert.equal(result.start_plan.plan_label, "Start");
    });
  });

  it("withholds login-scoped extras when only another account's quota key exists", async () => {
    await withZcode314LoginHome(loginCredentials({
      [accountKeyName("bigmodel", STALE_ID)]: "stale-account-key",
    }), async (home) => {
      const urls = [];
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          urls.push(url);
          return { ok: true, async json() { return codingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.reset_credits, undefined);
      assert.equal(result.start_plan, undefined);
      assert.deepEqual(urls, ["https://bigmodel.cn/api/monitor/usage/quota/limit"]);
    });
  });

  it("reads login-scoped extras for config.json keys the app wrote for the active login", async () => {
    await withZcode314LoginHome(loginCredentials({
      [accountKeyName("bigmodel", LOGIN_ID)]: "current-account-key",
    }), async (home, v2) => {
      // ZCode writes the current login's own key into config.json; the
      // byte-equal account credential proves the config key's ownership.
      fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({
        provider: { "builtin:bigmodel-coding-plan": { enabled: true, options: { apiKey: "current-account-key" } } },
      }));
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          if (url.includes("/quota/limit")) {
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          }
          if (url.endsWith("/reset/status")) {
            return { ok: true, async json() { return resetBody(); } };
          }
          return { ok: true, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:bigmodel-coding-plan");
      assert.equal(result.reset_credits.five_hour.length, 1);
      assert.equal(result.start_plan?.configured, true);
    });
  });

  it("does not merge login-scoped extras with a config key left over from another account", async () => {
    await withZcode314LoginHome(loginCredentials({
      [accountKeyName("bigmodel", STALE_ID)]: "stale-account-key",
    }), async (home, v2) => {
      // The stale account's key survived in config.json after the login switched.
      fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({
        provider: { "builtin:bigmodel-coding-plan": { enabled: true, options: { apiKey: "stale-account-key" } } },
      }));
      const urls = [];
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          urls.push(url);
          return { ok: true, async json() { return codingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.reset_credits, undefined);
      assert.equal(result.start_plan, undefined);
      assert.deepEqual(urls, ["https://bigmodel.cn/api/monitor/usage/quota/limit"]);
    });
  });

  it("rides login-scoped extras along with a legacy config key when no per-account credential exists", async () => {
    // Issue #937: a pre-3.14 config.json key is the only key the layout ever
    // had — with no per-account credential for the family it cannot belong to
    // another login, so the login's extras must not be withheld from it.
    await withZcode314LoginHome(loginCredentials(), async (home, v2) => {
      fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({
        provider: { "builtin:bigmodel-coding-plan": { enabled: true, options: { apiKey: "legacy-config-key" } } },
      }));
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          if (url.includes("/quota/limit")) {
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          }
          if (url.endsWith("/reset/status")) {
            return { ok: true, async json() { return resetBody(); } };
          }
          return { ok: true, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:bigmodel-coding-plan");
      assert.equal(result.reset_credits.five_hour.length, 1);
      assert.equal(result.start_plan?.configured, true);
      assert.equal(result.start_plan.plan_label, "Start");
    });
  });

  it("still withholds login-scoped extras from an unproven config key in a per-account layout", async () => {
    // A per-account credential exists for the family (a leftover from a
    // switched account): the unvouched config key must not inherit the
    // login's extras even when it is the only key that still serves quota.
    await withZcode314LoginHome(loginCredentials({
      [accountKeyName("bigmodel", STALE_ID)]: "stale-account-key",
    }), async (home, v2) => {
      fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({
        provider: { "builtin:bigmodel-coding-plan": { enabled: true, options: { apiKey: "orphan-config-key" } } },
      }));
      const quotaKeys = [];
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url, options) => {
          if (url.includes("/quota/limit")) {
            quotaKeys.push(options.headers.authorization);
            if (options.headers.authorization === "stale-account-key") {
              return { ok: false, status: 401 };
            }
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          }
          if (url.endsWith("/reset/status")) {
            return { ok: true, async json() { return resetBody(); } };
          }
          return { ok: true, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.error, null);
      // The config layout never tries the per-account key itself (it exists
      // only to prove ownership), so the orphan key alone serves quota.
      assert.deepEqual(quotaKeys, ["orphan-config-key"]);
      assert.equal(result.provider_key, "builtin:bigmodel-coding-plan");
      assert.equal(result.reset_credits, undefined);
      assert.equal(result.start_plan, undefined);
    });
  });

  it("withholds login-scoped extras when the login identity is missing", async () => {
    // The per-account key matches a real login id, but user_info is absent,
    // so the ownership cannot be proven and the extras must not merge.
    await withZcode314LoginHome({
      "oauth:active_provider": "bigmodel",
      zcodejwttoken: "zcode-jwt",
      "oauth:bigmodel:access_token": "bigmodel-login",
      [accountKeyName("bigmodel", LOGIN_ID)]: "current-account-key",
    }, async (home) => {
      const urls = [];
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          urls.push(url);
          return { ok: true, async json() { return codingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.reset_credits, undefined);
      assert.equal(result.start_plan, undefined);
      assert.deepEqual(urls, ["https://bigmodel.cn/api/monitor/usage/quota/limit"]);
    });
  });

  it("withholds login-scoped extras when user_info is unparseable", async () => {
    // Same shape as the missing-user_info case: the paid plan keeps serving
    // from its own account key, but nothing can prove ownership for extras.
    await withZcode314LoginHome(loginCredentials({
      "oauth:bigmodel:user_info": "{not-json",
      [accountKeyName("bigmodel", LOGIN_ID)]: "current-account-key",
    }), async (home) => {
      const urls = [];
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          urls.push(url);
          return { ok: true, async json() { return codingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.reset_credits, undefined);
      assert.equal(result.start_plan, undefined);
      assert.deepEqual(urls, ["https://bigmodel.cn/api/monitor/usage/quota/limit"]);
    });
  });

  it("matches a team account key to the login before reading reset cards", async () => {
    const teamKeyName = [
      "account-provider:team",
      encodeURIComponent("account:bigmodel-team-coding-plan"),
      "product-max",
      encodeURIComponent("org:example"),
      "proj-example",
      `account:${LOGIN_ID}:api-key`,
    ].join(":");
    await withZcode314LoginHome(loginCredentials({ [teamKeyName]: "team-key" }), async (home) => {
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url, options) => {
          if (url.includes("/quota/limit")) {
            assert.equal(options.headers.authorization, "team-key");
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          }
          if (url.endsWith("/reset/status")) {
            assert.equal(options.headers["Bigmodel-Target-Type"], "TEAM");
            return { ok: true, async json() { return resetBody(); } };
          }
          return { ok: true, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.reset_credits.five_hour.length, 1);
    });
  });
});

describe("ZCode start-plan grants pipeline", () => {
  const loginCredentials = (extra = {}) => ({
    "oauth:active_provider": "bigmodel",
    zcodejwttoken: "zcode-jwt",
    "oauth:bigmodel:access_token": "bigmodel-login",
    "oauth:bigmodel:user_info": JSON.stringify({ id: "fixture-current-account" }),
    "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:fixture-current-account:api-key": "current-account-key",
    ...extra,
  });
  // Bonus payload shape from billing/balance: daily Start Plan plus a one-time promotion.
  const grantsBalanceBody = () => ({
    code: 0,
    data: {
      server_time: 1790300000,
      plans: [
        {
          user_plan_id: "upl_weekend", plan_id: "zcode-v3-start-plan-0924-wk", name: "ZCode Weekend Build",
          status: "active", entitlements: [{ entitlement_id: "ent-wk-1", show_name: "GLM-5.3-Flash", period: "one_time" }],
        },
      ],
      balances: [
        {
          user_plan_id: "upl_weekend", plan_id: "zcode-v3-start-plan-0924-wk", entitlement_id: "ent-wk-1",
          show_name: "GLM-5.3-Flash", total_units: 300_000_000, used_units: 3_000_000,
          remaining_units: 297_000_000, period_end: 1790557200, expires_at: 1790557200,
        },
      ],
    },
  });

  it("attaches the login's bonus grants alongside the paid coding plan", async () => {
    await withZcode314LoginHome(loginCredentials(), async (home) => {
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          if (url.includes("/quota/limit")) {
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          }
          assert.equal(url.includes("/billing/balance"), true);
          return { ok: true, async json() { return grantsBalanceBody(); } };
        },
      });
      assert.equal(result.error, null);
      // Paid plan stays the primary display…
      assert.equal(result.plan_kind, "coding-plan");
      assert.equal(result.plan_label, "Pro");
      assert.equal(result.primary_window.used_percent, 25);
      // …with the login's bonus grants attached for the collapsed Start Plan section.
      assert.equal(result.start_plan.configured, true);
      assert.equal(result.start_plan.error, null);
      assert.equal(result.start_plan.plan_kind, "start-plan");
      assert.equal(result.start_plan.plan_label, "Start");
      assert.deepEqual(result.start_plan.buckets.map((bucket) => bucket.label), [
        "GLM-5.3-Flash · ZCode Weekend Build",
      ]);
      assert.deepEqual(result.start_plan.buckets[0].window, {
        used_percent: 1,
        reset_at: new Date(1790557200 * 1000).toISOString(),
      });
    });
  });

  it("keeps the paid plan intact and reports the failure when the grants request fails", async () => {
    await withZcode314LoginHome(loginCredentials(), async (home) => {
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          if (url.includes("/quota/limit")) {
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          }
          return { ok: false, status: 500, async json() { return {}; } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.plan_label, "Pro");
      assert.equal(result.primary_window.used_percent, 25);
      assert.match(result.start_plan.error, /billing API returned 500/);
    });
  });

  it("reports an HTTP 200 with a nonzero business code as a failed grants read", async () => {
    await withZcode314LoginHome(loginCredentials(), async (home) => {
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          if (url.includes("/quota/limit")) {
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          }
          // Server-side rejection served as HTTP 200 with an empty data object:
          // without the business-code check this would pose as "no grants".
          return { ok: true, status: 200, async json() { return { code: 1234, msg: "plan service unavailable", data: {} }; } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.plan_label, "Pro");
      assert.equal(result.primary_window.used_percent, 25);
      assert.match(result.start_plan.error, /code=1234/);
      assert.match(result.start_plan.error, /plan service unavailable/);
    });
  });

  it("omits the grants section when the login carries no balances", async () => {
    await withZcode314LoginHome(loginCredentials(), async (home) => {
      const result = await fetchZcodeLimits({
        home, env: {},
        fetchImpl: async (url) => {
          if (url.includes("/quota/limit")) {
            return { ok: true, async json() { return codingPlanQuotaBody(); } };
          }
          return { ok: true, async json() { return { code: 0, data: { balances: [] } }; } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.start_plan, undefined);
    });
  });
});

describe("normalizeZcodeBalanceResponse", () => {
  it("maps each model balance to a window with used_percent + reset, sorted by total", () => {
    const r = normalizeZcodeBalanceResponse(balanceBody());
    assert.equal(r.plan_id, "zcode-v3-start-plan-0615");
    assert.equal(r.plan_label, "Start");
    assert.equal(r.buckets.length, 2);
    // GLM-5.2 (3M) sorts before GLM-5-Turbo (2M)
    assert.equal(r.buckets[0].show_name, "GLM-5.2");
    assert.deepEqual(r.primary_window, {
      used_percent: 20, // 600k / 3M
      reset_at: "2026-06-23T15:59:59.000Z",
    });
    assert.deepEqual(r.secondary_window, {
      used_percent: 0,
      reset_at: "2026-06-23T15:59:59.000Z",
    });
  });
  it("throws on missing data", () => {
    assert.throws(() => normalizeZcodeBalanceResponse({}), /missing data/);
  });
  it("treats an empty balance list as connected with no windows", () => {
    const r = normalizeZcodeBalanceResponse({ data: { server_time: 1783431521, balances: [] } });
    assert.equal(r.server_time, 1783431521);
    assert.deepEqual(r.buckets, []);
    assert.equal(r.primary_window, null);
    assert.equal(r.secondary_window, null);
  });
});

describe("resolveZcodeAppVersion", () => {
  it("prefers the explicit app version env override", () => {
    assert.equal(
      resolveZcodeAppVersion({ env: { TOKENTRACKER_ZCODE_APP_VERSION: "9.8.7" } }),
      "9.8.7",
    );
  });
  it("reads the app version from a configured ZCode.app plist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-app-"));
    try {
      const app = path.join(tmp, "ZCode.app");
      const contents = path.join(app, "Contents");
      fs.mkdirSync(contents, { recursive: true });
      fs.writeFileSync(
        path.join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>3.2.5</string>
</dict>
</plist>`,
        "utf8",
      );
      assert.equal(
        resolveZcodeAppVersion({ env: { TOKENTRACKER_ZCODE_APP_PATH: app } }),
        "3.2.5",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadZcodeApiKey", () => {
  for (const [family, origin] of [["bigmodel", "https://bigmodel.cn"], ["zai", "https://api.z.ai"]]) {
    for (const selectedStart of [true, false]) {
      it(`prefers the ${family} subscription over daily Start Plan grants ${selectedStart ? "when Start is selected" : "without a saved selection"}`, async () => {
        const setting = selectedStart ? {
          providerFamilyDomain: family,
          modelProviderFamilySelectedKeys: { [family]: `coding-plan:builtin:${family}-start-plan` },
        } : {};
        await withZcodePlanSettings(setting, async (home, v2) => {
          fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({
            provider: {
              [`builtin:${family}-coding-plan`]: { enabled: true, options: { apiKey: "coding-key" } },
              [`builtin:${family}-start-plan`]: { enabled: true, options: { apiKey: "start-key" } },
            },
          }));
          fs.writeFileSync(path.join(v2, "coding-plan-cache.json"), JSON.stringify({
            entryStatus: { items: {
              [`builtin:${family}-coding-plan`]: { status: "available" },
              [`builtin:${family}-start-plan`]: { status: "available" },
            } },
          }));
          const requests = [];
          const result = await fetchZcodeLimits({
            home,
            env: {},
            fetchImpl: async (url) => {
              requests.push(url);
              return { ok: true, status: 200, async json() {
                return url.includes("/quota/limit") ? codingPlanQuotaBody() : balanceBody();
              } };
            },
          });
          assert.equal(result.error, null);
          assert.equal(result.provider_key, `builtin:${family}-coding-plan`);
          assert.equal(result.plan_label, "Pro");
          assert.deepEqual(requests, [`${origin}/api/monitor/usage/quota/limit`]);
        });
      });
    }
  }

  it("maps all built-in ZCode plan providers to the zcode-plan billing root", () => {
    for (const key of ["builtin:bigmodel-start-plan", "builtin:zai-start-plan"]) {
      assert.equal(
        resolveZcodeProviderBillingBaseUrl(key, { options: { baseURL: "https://api.z.ai/api/anthropic" } }, {}),
        "https://zcode.z.ai/api/v1/zcode-plan",
      );
    }
    assert.equal(
      resolveZcodeProviderBillingBaseUrl(
        "builtin:zai-coding-plan",
        { options: { baseURL: "https://api.z.ai/api/anthropic" } },
        {},
      ),
      null,
    );
  });

  it("maps coding-plan providers to the monitor quota API used by ZCode 3.3.x", () => {
    assert.equal(
      resolveZcodeProviderQuotaUrl(
        "builtin:zai-coding-plan",
        { options: { baseURL: "https://api.z.ai/api/anthropic" } },
        {},
      ),
      "https://api.z.ai/api/monitor/usage/quota/limit",
    );
    assert.equal(
      resolveZcodeProviderQuotaUrl(
        "builtin:bigmodel-coding-plan",
        { options: { baseURL: "https://open.bigmodel.cn/api/anthropic" } },
        {},
      ),
      "https://bigmodel.cn/api/monitor/usage/quota/limit",
    );
  });

  it("prefers the provider ZCode marked available in coding-plan-cache", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-available-key-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:bigmodel-start-plan": {
              enabled: true,
              options: { apiKey: "stale-bigmodel-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "live-zai-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(v2, "coding-plan-cache.json"),
        JSON.stringify({
          entryStatus: {
            items: {
              "builtin:bigmodel-start-plan": { status: "unavailable", reason: "coding_plan_not_authenticated" },
              "builtin:zai-start-plan": { status: "available" },
            },
          },
        }),
        "utf8",
      );
      const auth = loadZcodeApiKey({ home: tmp });
      assert.equal(auth.providerKey, "builtin:zai-start-plan");
      assert.equal(auth.apiKey, "live-zai-key");
      assert.equal(auth.billingBaseUrl, "https://zcode.z.ai/api/v1/zcode-plan");
      assert.deepEqual(loadZcodeAuthCandidates({ home: tmp }).map((a) => a.providerKey), ["builtin:zai-start-plan"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers ZCode's active-provider credential token before the config apiKey for start plan auth", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-credential-key-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "config-token", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      writeZcodeCredentials(v2, tmp, {
        "oauth:active_provider": "zai",
        zcodejwttoken: "credential-token",
      });

      assert.equal(loadZcodeCredential("oauth:active_provider", { home: tmp }), "zai");
      const auths = loadZcodeAuthCandidates({ home: tmp });
      assert.equal(auths[0].apiKey, "credential-token");
      assert.equal(auths[0].auth_source, "credential:zcodejwttoken");
      assert.equal(auths[1].apiKey, "config-token");
      assert.equal(auths[1].auth_source, "provider:config");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers ZCode's selected coding-plan provider when start and coding plans are both available", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-selected-coding-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "start-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
            "builtin:zai-coding-plan": {
              enabled: true,
              options: { apiKey: "coding-key", baseURL: "https://api.z.ai/api/anthropic" },
            },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(v2, "coding-plan-cache.json"),
        JSON.stringify({
          entryStatus: {
            items: {
              "builtin:zai-start-plan": { status: "available" },
              "builtin:zai-coding-plan": { status: "available" },
            },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(v2, "setting.json"),
        JSON.stringify({
          providerFamilyDomain: "zai",
          modelProviderFamilySelectedKeys: {
            zai: "coding-plan:builtin:zai-coding-plan",
          },
        }),
        "utf8",
      );
      assert.deepEqual(loadZcodeSelectedPlanProviderKeys({ home: tmp }), ["builtin:zai-coding-plan"]);
      const auths = loadZcodeAuthCandidates({ home: tmp });
      assert.equal(auths[0].providerKey, "builtin:zai-coding-plan");
      assert.equal(auths[0].planKind, "coding-plan");
      assert.equal(auths[0].apiKey, "coding-key");
      assert.equal(auths[1].providerKey, "builtin:zai-start-plan");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fetches the selected paid coding-plan before an also-available start plan", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-selected-coding-fetch-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "start-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
            "builtin:zai-coding-plan": {
              enabled: true,
              options: { apiKey: "coding-key", baseURL: "https://api.z.ai/api/anthropic" },
            },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(v2, "coding-plan-cache.json"),
        JSON.stringify({
          entryStatus: {
            items: {
              "builtin:zai-start-plan": { status: "available" },
              "builtin:zai-coding-plan": { status: "available" },
            },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(v2, "setting.json"),
        JSON.stringify({
          providerFamilyDomain: "zai",
          modelProviderFamilySelectedKeys: {
            zai: "coding-plan:builtin:zai-coding-plan",
          },
        }),
        "utf8",
      );
      const seen = [];
      const result = await fetchZcodeLimits({
        home: tmp,
        fetchImpl: async (url, options) => {
          seen.push({ url, authorization: options.headers.authorization || options.headers.Authorization });
          assert.equal(url, "https://api.z.ai/api/monitor/usage/quota/limit");
          return { ok: true, status: 200, async json() { return codingPlanQuotaBody(); } };
        },
      });
      assert.deepEqual(seen, [{ url: "https://api.z.ai/api/monitor/usage/quota/limit", authorization: "coding-key" }]);
      assert.equal(result.provider_key, "builtin:zai-coding-plan");
      assert.equal(result.plan_label, "Pro");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not use the shared ZCode JWT for the wrong regional start-plan provider", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-credential-region-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "config-token", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      writeZcodeCredentials(v2, tmp, {
        "oauth:active_provider": "bigmodel",
        zcodejwttoken: "wrong-region-token",
      });

      const auths = loadZcodeAuthCandidates({ home: tmp });
      assert.equal(auths.length, 1);
      assert.equal(auths[0].apiKey, "config-token");
      assert.equal(auths[0].auth_source, "provider:config");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("picks the first enabled provider with a non-empty apiKey, skipping disabled/empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-key-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            // disabled provider with a key — must be skipped
            "builtin:zai-coding-plan": { enabled: false, options: { apiKey: "leaked-key" } },
            // active start-plan with a refreshed key — must win
            "builtin:bigmodel-start-plan": {
              enabled: true,
              options: { apiKey: "live-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const auth = loadZcodeApiKey({ home: tmp });
      assert.equal(auth.providerKey, "builtin:bigmodel-start-plan");
      assert.equal(auth.apiKey, "live-key");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("returns null when no provider has a usable key", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-nokey-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({ provider: { "builtin:zai-start-plan": { enabled: true, options: { apiKey: "" } } } }),
        "utf8",
      );
      assert.equal(loadZcodeApiKey({ home: tmp }), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("fetchZcodeLimits", () => {
  function writeZcodeConfig(tmp) {
    const v2 = path.join(tmp, ".zcode", "v2");
    fs.mkdirSync(v2, { recursive: true });
    fs.writeFileSync(
      path.join(v2, "config.json"),
      JSON.stringify({
        provider: {
          "builtin:bigmodel-start-plan": {
            enabled: true,
            options: { apiKey: "live-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
          },
        },
      }),
      "utf8",
    );
    return v2;
  }

  it("returns configured:false when ZCode is not installed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-missing-"));
    try {
      assert.equal(isZcodeInstalled({ home: tmp }), false);
      assert.deepEqual(await fetchZcodeLimits({ home: tmp }), { configured: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fetches billing/balance with the stored key and normalizes the windows", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-fetch-"));
    try {
      writeZcodeConfig(tmp);
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        fetchImpl: async (url, options) => {
          // baseURL's trailing /anthropic is stripped → billing/balance root
          assert.equal(url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.2.5");
          assert.equal(options.headers.Authorization, "Bearer live-key");
          assert.equal(options.headers["User-Agent"], "ZCode/3.2.5");
          assert.equal(options.headers["X-ZCode-App-Version"], "3.2.5");
          return { ok: true, status: 200, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.plan_label, "Start");
      assert.equal(result.primary_window.used_percent, 20);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes ZCode coding-plan quota responses", () => {
    const result = normalizeZcodeCodingPlanQuotaResponse(codingPlanQuotaBody());
    assert.equal(result.plan_label, "Pro");
    assert.equal(result.plan_kind, "coding-plan");
    assert.equal(result.buckets.length, 2);
    // Legacy token-total shape (no unit/number window ids) sorts by total.
    assert.equal(result.buckets[0].show_name, "GLM-5-Turbo");
    assert.equal(result.primary_window.used_percent, 25);
    assert.equal(result.primary_window.reset_at, "2026-07-15T15:59:59.000Z");
  });

  it("uses percentage from the real Z.ai lite coding-plan payload (issue #279)", () => {
    const before = normalizeZcodeCodingPlanQuotaResponse(realLiteCodingPlanQuotaBody({ fiveHourPercent: 14 }));
    assert.equal(before.plan_kind, "coding-plan");
    assert.equal(before.plan_label, "Lite");
    assert.deepEqual(
      before.buckets.map((b) => b.show_name),
      ["5h", "Weekly", "Tools"],
    );
    // Unused TIME_LIMIT has usage=100/number=1 but percentage=0 — must not become 100%.
    assert.deepEqual(before.primary_window, {
      used_percent: 14,
      reset_at: "2026-07-08T19:49:11.760Z",
    });
    assert.deepEqual(before.secondary_window, {
      used_percent: 43,
      reset_at: "2026-07-14T08:32:51.993Z",
    });
    assert.deepEqual(before.tertiary_window, {
      used_percent: 0,
      reset_at: "2026-08-07T08:32:51.974Z",
    });

    const after = normalizeZcodeCodingPlanQuotaResponse(realLiteCodingPlanQuotaBody({ fiveHourPercent: 18 }));
    assert.equal(after.primary_window.used_percent, 18);
    assert.equal(after.secondary_window.used_percent, 43);
    assert.equal(after.tertiary_window.used_percent, 0);
  });

  it("anchors named windows when ZCode renames the token rows to CREDIT_LIMIT (issue #937)", () => {
    // ZCode 3.17.1 kept unit/number but renamed TOKENS_LIMIT rows; without the
    // alias the fixed 5h/Weekly/Tools labels would fall back to order luck.
    const result = normalizeZcodeCodingPlanQuotaResponse(
      realLiteCodingPlanQuotaBody({ fiveHourPercent: 14, tokenRowType: "CREDIT_LIMIT" }),
    );
    assert.deepEqual(
      result.buckets.map((bucket) => bucket.show_name),
      ["5h", "Weekly", "Tools"],
    );
    assert.deepEqual(result.primary_window, {
      used_percent: 14,
      reset_at: "2026-07-08T19:49:11.760Z",
    });
    assert.equal(result.secondary_window.used_percent, 43);
  });

  it("fetches and normalizes the issue #279 lite coding-plan shape end-to-end", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-lite-coding-e2e-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-coding-plan": {
              enabled: true,
              options: { apiKey: "coding-key", baseURL: "https://api.z.ai/api/anthropic" },
            },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(v2, "setting.json"),
        JSON.stringify({
          providerFamilyDomain: "zai",
          modelProviderFamilySelectedKeys: {
            zai: "coding-plan:builtin:zai-coding-plan",
          },
        }),
        "utf8",
      );
      const result = await fetchZcodeLimits({
        home: tmp,
        fetchImpl: async (url, options) => {
          assert.equal(url, "https://api.z.ai/api/monitor/usage/quota/limit");
          assert.equal(options.headers.authorization, "coding-key");
          return {
            ok: true,
            status: 200,
            async json() {
              return realLiteCodingPlanQuotaBody({ fiveHourPercent: 14 });
            },
          };
        },
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:zai-coding-plan");
      assert.equal(result.plan_kind, "coding-plan");
      assert.equal(result.plan_label, "Lite");
      assert.equal(result.primary_window.used_percent, 14);
      assert.equal(result.secondary_window.used_percent, 43);
      assert.equal(result.tertiary_window.used_percent, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fetches coding-plan usage from the monitor quota API instead of billing/balance", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-coding-quota-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-coding-plan": {
              enabled: true,
              options: { apiKey: "coding-key", baseURL: "https://api.z.ai/api/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        fetchImpl: async (url, options) => {
          assert.equal(url, "https://api.z.ai/api/monitor/usage/quota/limit");
          assert.equal(options.headers.authorization, "coding-key");
          assert.equal(options.headers.Authorization, undefined);
          return { ok: true, status: 200, async json() { return codingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:zai-coding-plan");
      assert.equal(result.plan_label, "Pro");
      assert.equal(result.primary_window.used_percent, 25);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("tries the next regional provider when the first one returns 405", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-region-fallback-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:bigmodel-start-plan": {
              enabled: true,
              options: { apiKey: "bigmodel-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "zai-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const seen = [];
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        fetchImpl: async (url, options) => {
          seen.push(options.headers.Authorization);
          if (options.headers.Authorization === "Bearer bigmodel-key") {
            return { ok: false, status: 405, async json() { return { code: 3012, msg: "method not allowed" }; } };
          }
          assert.equal(options.headers.Authorization, "Bearer zai-key");
          assert.equal(url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.2.5");
          return { ok: true, status: 200, async json() { return balanceBody(); } };
        },
      });
      assert.deepEqual(seen, ["Bearer bigmodel-key", "Bearer zai-key"]);
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:zai-start-plan");
      assert.equal(result.primary_window.used_percent, 20);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("continues after an empty balance response when another provider has windows", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-empty-then-live-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:bigmodel-start-plan": {
              enabled: true,
              options: { apiKey: "bigmodel-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "zai-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        fetchImpl: async (_url, options) => {
          if (options.headers.Authorization === "Bearer bigmodel-key") {
            return {
              ok: true,
              status: 200,
              async json() { return { code: 0, msg: "", data: { server_time: 1783431521, balances: [] } }; },
            };
          }
          return { ok: true, status: 200, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:zai-start-plan");
      assert.equal(result.buckets.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces an auth error on 401 without throwing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-401-"));
    try {
      writeZcodeConfig(tmp);
      const result = await fetchZcodeLimits({
        home: tmp,
        fetchImpl: async () => ({ ok: false, status: 401, async json() { return {}; } }),
      });
      assert.equal(result.configured, true);
      assert.match(result.error, /Not authenticated/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to ZCode's latest successful local billing log when the live API returns 405", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-log-fallback-"));
    try {
      const v2 = writeZcodeConfig(tmp);
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077");
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({ ok: false, status: 405, async json() { return { code: 3012, msg: "method not allowed" }; } }),
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.source, "zcode-log");
      assert.equal(result.provider_key, "builtin:zai-start-plan");
      assert.equal(result.log_timestamp, new Date(2026, 6, 8, 9, 8, 30, 77).toISOString());
      assert.equal(result.primary_window.used_percent, 20);
      assert.match(result.provider_errors[0], /405/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not use stale start-plan logs for a failing coding-plan provider", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-coding-no-start-log-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-coding-plan": {
              enabled: true,
              options: { apiKey: "coding-key", baseURL: "https://api.z.ai/api/anthropic" },
            },
          },
        }),
        "utf8",
      );
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077", { providerId: "builtin:zai-start-plan" });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { code: 500, success: false, msg: "Not authenticated", data: null };
          },
        }),
      });
      assert.equal(result.configured, true);
      assert.match(result.error, /ZCode coding plan API error/);
      assert.equal(result.source, undefined);
      assert.equal(result.provider_errors.length, 1);
      assert.match(result.provider_errors[0], /builtin:zai-coding-plan/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores stale ZCode billing logs instead of hiding the live API failure forever", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-stale-log-"));
    try {
      const v2 = writeZcodeConfig(tmp);
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077");
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        nowMs: new Date(2026, 6, 8, 16, 0, 0).getTime(),
        fetchImpl: async () => ({ ok: false, status: 405, async json() { return { code: 3012, msg: "method not allowed" }; } }),
      });
      assert.equal(result.configured, true);
      assert.match(result.error, /405/);
      assert.equal(result.source, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("can read the latest successful balance directly from ZCode logs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-read-log-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077");
      const record = loadLatestZcodeBalanceFromLogs({
        home: tmp,
        providerKeys: ["builtin:zai-start-plan"],
        nowMs: new Date(2026, 6, 8, 9, 9, 0).getTime(),
      });
      assert.equal(record.providerKey, "builtin:zai-start-plan");
      assert.equal(record.body.code, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses the monitor quota API for coding-plan providers with generic model base URLs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-coding-provider-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-coding-plan": {
              enabled: true,
              options: { apiKey: "gateway-key", baseURL: "https://api.z.ai/api/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const auth = loadZcodeApiKey({ home: tmp });
      assert.equal(auth.providerKey, "builtin:zai-coding-plan");
      assert.equal(auth.billingBaseUrl, null);
      assert.equal(auth.quotaUrl, "https://api.z.ai/api/monitor/usage/quota/limit");
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        fetchImpl: async (url, options) => {
          assert.equal(url, "https://api.z.ai/api/monitor/usage/quota/limit");
          assert.equal(options.headers.authorization, "gateway-key");
          return { ok: true, status: 200, async json() { return codingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.plan_label, "Pro");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("zcodeRegionFromProviderId", () => {
  it("maps built-in and per-account provider ids onto their region", () => {
    assert.equal(zcodeRegionFromProviderId("builtin:zai-start-plan"), "zai");
    assert.equal(zcodeRegionFromProviderId("builtin:bigmodel-coding-plan"), "bigmodel");
    assert.equal(zcodeRegionFromProviderId("account:zai-start-plan"), "zai");
    assert.equal(zcodeRegionFromProviderId("account:bigmodel-individual-coding-plan"), "bigmodel");
    assert.equal(zcodeRegionFromProviderId("account:bigmodel-team-coding-plan"), "bigmodel");
    assert.equal(zcodeRegionFromProviderId("some-other-provider"), null);
    assert.equal(zcodeRegionFromProviderId(null), null);
  });

  it("maps built-in and per-account provider ids onto their plan kind", () => {
    assert.equal(zcodePlanKindFromProviderId("builtin:zai-start-plan"), "start");
    assert.equal(zcodePlanKindFromProviderId("builtin:bigmodel-coding-plan"), "coding");
    assert.equal(zcodePlanKindFromProviderId("account:zai-start-plan"), "start");
    assert.equal(zcodePlanKindFromProviderId("account:bigmodel-individual-coding-plan"), "coding");
    assert.equal(zcodePlanKindFromProviderId("account:bigmodel-team-coding-plan"), "coding");
    assert.equal(zcodePlanKindFromProviderId("account:bigmodel-something-new"), null);
    assert.equal(zcodePlanKindFromProviderId("some-other-provider"), null);
    assert.equal(zcodePlanKindFromProviderId(null), null);
  });
});

describe("ZCode other-region log snapshot", () => {
  /** Coding-plan-only home for the given family (no credentials, no extras). */
  function writeZcodeCodingPlanConfig(tmp, family) {
    const v2 = path.join(tmp, ".zcode", "v2");
    fs.mkdirSync(v2, { recursive: true });
    fs.writeFileSync(
      path.join(v2, "config.json"),
      JSON.stringify({
        provider: {
          [`builtin:${family}-coding-plan`]: {
            enabled: true,
            options: { apiKey: "coding-key", baseURL: "https://api.z.ai/api/anthropic" },
          },
        },
      }),
      "utf8",
    );
    return v2;
  }

  // Same shape as balanceBody() but with distinct amounts, so assertions can
  // tell the two regions' snapshots apart.
  function bigmodelBalanceBody() {
    return {
      code: 0,
      msg: "",
      data: {
        server_time: 1782188525,
        balances: [
          {
            plan_id: "zcode-v3-start-plan-0615",
            entitlement_id: "ent_start_public_glm_5p2",
            show_name: "GLM-5.2",
            total_units: 1_000_000,
            used_units: 250_000,
            remaining_units: 750_000,
            period_end: 1782230399,
            expires_at: 1782230399,
          },
        ],
      },
    };
  }

  // The shared writeZcodeBalanceLog overwrites the daily file, so dual-region
  // scenarios build one file holding both records.
  function writeZcodeMultiBalanceLog(v2, day, records) {
    const logsDir = path.join(v2, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const content = records.map(({ timestamp, providerId = "builtin:zai-start-plan", body = balanceBody() }) => {
      const entry = {
        balanceCount: body.data.balances.length,
        balances: body.data.balances,
        code: 0,
        msg: "",
        payload: body,
        providerId,
        success: true,
        url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.2.5",
      };
      return `[${timestamp}] [info] [pid:1] [main] [host-log] [usage-stats] billing/balance 请求完成 ${JSON.stringify(entry)}\n`;
    }).join("");
    fs.writeFileSync(path.join(logsDir, `${day}.log`), content, "utf8");
  }

  it("attaches the other region's freshest log snapshot to a successful primary", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-other-region-"));
    try {
      const v2 = writeZcodeCodingPlanConfig(tmp, "bigmodel");
      writeZcodeMultiBalanceLog(v2, "2026-07-08", [
        { timestamp: "2026-07-08 09:08:00.077", providerId: "account:bigmodel-individual-coding-plan", body: bigmodelBalanceBody() },
        { timestamp: "2026-07-08 09:08:30.077", providerId: "account:zai-start-plan" },
      ]);
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({ ok: true, status: 200, async json() { return codingPlanQuotaBody(); } }),
      });
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:bigmodel-coding-plan");
      assert.equal(result.region, "bigmodel");
      assert.equal(result.other_region.region, "zai");
      assert.equal(result.other_region.source, "zcode-log");
      assert.equal(result.other_region.provider_key, "account:zai-start-plan");
      assert.equal(result.other_region.plan_kind, "start-plan");
      assert.equal(result.other_region.primary_window.used_percent, 20);
      assert.equal(result.other_region.log_timestamp, new Date(2026, 6, 8, 9, 8, 30, 77).toISOString());
      // Red line: region-crossing snapshots stay passive — no login-scoped extras.
      assert.equal("reset_credits" in result.other_region, false);
      assert.equal("start_plan" in result.other_region, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the snapshot off when the logs only cover the primary's own region", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-same-region-"));
    try {
      const v2 = writeZcodeCodingPlanConfig(tmp, "bigmodel");
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:00.077", {
        providerId: "account:bigmodel-individual-coding-plan",
        body: bigmodelBalanceBody(),
      });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({ ok: true, status: 200, async json() { return codingPlanQuotaBody(); } }),
      });
      assert.equal(result.error, null);
      assert.equal(result.region, "bigmodel");
      assert.equal(result.other_region, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores other-region snapshots outside the log age window", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-stale-other-"));
    try {
      const v2 = writeZcodeCodingPlanConfig(tmp, "bigmodel");
      writeZcodeBalanceLog(v2, "2026-07-08 02:00:00.077", { providerId: "account:zai-start-plan" });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({ ok: true, status: 200, async json() { return codingPlanQuotaBody(); } }),
      });
      assert.equal(result.error, null);
      assert.equal(result.other_region, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats a fresh per-account record as preferred log fallback for its region", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-account-fallback-"));
    try {
      const v2 = writeZcodeCodingPlanConfig(tmp, "bigmodel");
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077", {
        providerId: "account:bigmodel-individual-coding-plan",
        body: bigmodelBalanceBody(),
      });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { code: 500, success: false, msg: "Not authenticated", data: null };
          },
        }),
      });
      // 3.14+ account ids can never byte-equal a builtin: candidate key, so the
      // record matches by region instead of failing the gate like before #938.
      assert.equal(result.source, "zcode-log");
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "account:bigmodel-individual-coding-plan");
      assert.equal(result.region, "bigmodel");
      assert.equal(result.primary_window.used_percent, 25);
      assert.equal(result.provider_errors.length, 1);
      assert.match(result.provider_errors[0], /builtin:bigmodel-coding-plan/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not adopt another region's per-account logs when the configured region fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-region-guard-"));
    try {
      const v2 = writeZcodeCodingPlanConfig(tmp, "bigmodel");
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077", { providerId: "account:zai-start-plan" });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { code: 500, success: false, msg: "Not authenticated", data: null };
          },
        }),
      });
      assert.equal(result.configured, true);
      assert.match(result.error, /ZCode coding plan API error/);
      assert.equal(result.source, undefined);
      assert.equal(result.other_region, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not adopt per-account start-plan logs for a failing coding-plan provider", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-account-plan-kind-"));
    try {
      const v2 = writeZcodeCodingPlanConfig(tmp, "bigmodel");
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077", { providerId: "account:bigmodel-start-plan" });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { code: 500, success: false, msg: "Not authenticated", data: null };
          },
        }),
      });
      // The per-account mirror of the builtin exact-match rule: a coding-plan
      // candidate only adopts per-account records of the same plan kind.
      assert.equal(result.configured, true);
      assert.match(result.error, /ZCode coding plan API error/);
      assert.equal(result.source, undefined);
      assert.equal(result.other_region, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("adopts per-account team coding-plan records for a coding-plan candidate", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-team-kind-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      writeZcodeMultiBalanceLog(v2, "2026-07-08", [
        { timestamp: "2026-07-08 09:08:30.077", providerId: "account:zai-team-coding-plan", body: balanceBody() },
      ]);
      const scan = scanZcodeBalanceLogs({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        providerKeys: ["builtin:zai-coding-plan"],
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
      });
      assert.equal(scan.preferred.providerKey, "account:zai-team-coding-plan");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the freshest per-region record even when log lines are out of timestamp order", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-region-order-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      writeZcodeMultiBalanceLog(v2, "2026-07-08", [
        { timestamp: "2026-07-08 09:09:00.077", providerId: "account:bigmodel-individual-coding-plan", body: bigmodelBalanceBody() },
        { timestamp: "2026-07-08 09:08:00.077", providerId: "account:bigmodel-start-plan", body: balanceBody() },
      ]);
      const scan = scanZcodeBalanceLogs({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        providerKeys: ["builtin:bigmodel-coding-plan"],
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
      });
      // The backward scan hits the 09:08 line first; byRegion must still keep
      // the 09:09 record for the other-region snapshot.
      assert.equal(scan.byRegion.get("bigmodel").providerKey, "account:bigmodel-individual-coding-plan");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not adopt a per-account record matching no single candidate's region and plan kind", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-pair-kind-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      writeZcodeMultiBalanceLog(v2, "2026-07-08", [
        { timestamp: "2026-07-08 09:08:30.077", providerId: "account:zai-individual-coding-plan", body: balanceBody() },
      ]);
      // Candidates span both regions and both plan kinds, but no single one
      // carries (zai, coding) — the record must not ride the cross product.
      const scan = scanZcodeBalanceLogs({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        providerKeys: ["builtin:bigmodel-coding-plan", "builtin:zai-start-plan"],
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
      });
      assert.equal(scan.preferred, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("visits every eligible line before claiming the freshest regional snapshot", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-scan-order-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      // Newest zai record sits above lines that already fill both regions and
      // preferred; the scan must still reach it, so there is no early return.
      writeZcodeMultiBalanceLog(v2, "2026-07-08", [
        { timestamp: "2026-07-08 10:05:00.077", providerId: "account:zai-start-plan", body: balanceBody() },
        { timestamp: "2026-07-08 10:00:00.077", providerId: "account:bigmodel-individual-coding-plan", body: bigmodelBalanceBody() },
        { timestamp: "2026-07-08 10:01:00.077", providerId: "account:zai-start-plan", body: balanceBody() },
      ]);
      const scan = scanZcodeBalanceLogs({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        providerKeys: ["builtin:bigmodel-coding-plan", "builtin:zai-start-plan"],
        nowMs: new Date(2026, 6, 8, 10, 10, 0).getTime(),
      });
      assert.equal(
        scan.byRegion.get("zai").timestampMs,
        new Date(2026, 6, 8, 10, 5, 0, 77).getTime(),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces both regions from logs alone when no credentials remain", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-log-only-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({ provider: {} }));
      writeZcodeMultiBalanceLog(v2, "2026-07-08", [
        { timestamp: "2026-07-08 09:08:00.077", providerId: "account:bigmodel-individual-coding-plan", body: bigmodelBalanceBody() },
        { timestamp: "2026-07-08 09:08:30.077", providerId: "account:zai-start-plan" },
      ]);
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => {
          throw new Error("no requests expected");
        },
      });
      assert.equal(result.source, "zcode-log");
      assert.equal(result.provider_key, "account:zai-start-plan");
      assert.equal(result.region, "zai");
      assert.equal(result.other_region.region, "bigmodel");
      assert.equal(result.other_region.provider_key, "account:bigmodel-individual-coding-plan");
      assert.equal(result.other_region.primary_window.used_percent, 25);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("suppresses the other-region snapshot when the log fallback is disabled", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-disable-log-"));
    try {
      const v2 = writeZcodeCodingPlanConfig(tmp, "bigmodel");
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077", { providerId: "account:zai-start-plan" });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: {
          TOKENTRACKER_ZCODE_APP_VERSION: "3.3.2",
          TOKENTRACKER_ZCODE_DISABLE_LOG_FALLBACK: "1",
        },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({ ok: true, status: 200, async json() { return codingPlanQuotaBody(); } }),
      });
      assert.equal(result.error, null);
      assert.equal(result.other_region, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("ZCode 3.14 credential-only layout", () => {
  const DEVICE_MID = "11111111-2222-4333-8444-555555555555";

  /** Build a ZCode 3.14 home: no v2/config.json, plans live only in credentials.json. */
  function withZcode314Home(credentials, run, { setting } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-314-"));
    const v2 = path.join(tmp, ".zcode", "v2");
    fs.mkdirSync(v2, { recursive: true });
    writeZcodeCredentials(v2, tmp, credentials);
    fs.writeFileSync(path.join(v2, "telemetry-state.json"), JSON.stringify({ deviceMid: DEVICE_MID }));
    fs.writeFileSync(path.join(v2, "setting.json"), JSON.stringify(setting || {
      providerFamilyDomain: "zai",
      providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
    }));
    return Promise.resolve().then(() => run(tmp, v2)).finally(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  }

  it("detects ZCode and builds candidates without v2/config.json", async () => {
    await withZcode314Home({
      "oauth:active_provider": "zai",
      zcodejwttoken: "jwt-token",
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:acct-1:api-key": "coding-key",
    }, (home) => {
      assert.equal(isZcodeInstalled({ home }), true);
      const auths = loadZcodeAuthCandidates({ home, env: {} });
      assert.deepEqual(auths.map((auth) => [auth.providerKey, auth.auth_source, auth.apiKey]), [
        ["builtin:zai-coding-plan", "credential:account-provider", "coding-key"],
        ["builtin:zai-start-plan", "credential:zcodejwttoken", "jwt-token"],
      ]);
      assert.equal(auths[0].quotaUrl, "https://api.z.ai/api/monitor/usage/quota/limit");
      assert.equal(auths[1].billingBaseUrl, "https://zcode.z.ai/api/v1/zcode-plan");
    });
  });

  it("prefers an account subscription even when the selected connection is Start Plan", async () => {
    await withZcode314Home({
      "oauth:active_provider": "bigmodel",
      zcodejwttoken: "jwt-token",
      "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:acct-1:api-key": "coding-key",
    }, (home) => {
      const auths = loadZcodeAuthCandidates({ home, env: {} });
      assert.deepEqual(auths.map((auth) => auth.providerKey), [
        "builtin:bigmodel-coding-plan",
        "builtin:bigmodel-start-plan",
      ]);
    }, { setting: {
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: { bigmodel: { kind: "start-plan" } },
    } });
  });

  it("falls back to the start plan and sends the telemetry device id to billing/balance", async () => {
    await withZcode314Home({
      "oauth:active_provider": "zai",
      zcodejwttoken: "jwt-token",
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:acct-1:api-key": "coding-key",
    }, async (home) => {
      const requests = [];
      const result = await fetchZcodeLimits({
        home,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.14.3" },
        /** Mirror the live API: no coding plan on this account, billing needs X-Device-Mid. */
        fetchImpl: async (url, options) => {
          requests.push(url);
          if (url.includes("/api/monitor/usage/quota/limit")) {
            assert.equal(options.headers.authorization, "coding-key");
            return { ok: true, status: 200, async json() {
              return { code: 500, success: false, msg: "当前用户不存在coding plan" };
            } };
          }
          assert.equal(options.headers.Authorization, "Bearer jwt-token");
          if (options.headers["X-Device-Mid"] !== DEVICE_MID) {
            return { ok: false, status: 400, async json() { return { code: 3001, msg: "parameter error" }; } };
          }
          return { ok: true, status: 200, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:zai-start-plan");
      assert.equal(requests.length, 2);
    });
  });

  it("prefers the telemetry device id over a leftover feedback client id", async () => {
    await withZcode314Home({
      "oauth:active_provider": "zai",
      zcodejwttoken: "jwt-token",
      zcodefeedbackclientid: "stale-feedback-client-id",
    }, async (home) => {
      const deviceMids = [];
      const result = await fetchZcodeLimits({
        home,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.14.3" },
        /** The live billing host rejects the old feedback client id with 3001. */
        fetchImpl: async (_url, options) => {
          deviceMids.push(options.headers["X-Device-Mid"]);
          if (options.headers["X-Device-Mid"] !== DEVICE_MID) {
            return { ok: false, status: 400, async json() { return { code: 3001, msg: "parameter error" }; } };
          }
          return { ok: true, status: 200, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.deepEqual(deviceMids, [DEVICE_MID]);
    });
  });

  it("routes a team account key with its own organization and project scope", async () => {
    const name = [
      "account-provider:team",
      encodeURIComponent("account:bigmodel-team-coding-plan"),
      "product-max",
      encodeURIComponent("org:example"),
      "proj-example",
      "account:acct-2:api-key",
    ].join(":");
    await withZcode314Home({ [name]: "team-key" }, async (home) => {
      const result = await fetchZcodeLimits({
        home,
        env: {},
        /** Accept only the fully scoped team request. */
        fetchImpl: async (url, options) => {
          assert.equal(url, "https://bigmodel.cn/api/monitor/usage/quota/limit?type=2");
          assert.equal(options.headers.authorization, "team-key");
          assert.equal(options.headers["bigmodel-organization"], "org:example");
          assert.equal(options.headers["bigmodel-project"], "proj-example");
          return { ok: true, status: 200, async json() { return realLiteCodingPlanQuotaBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:bigmodel-coding-plan");
    }, { setting: { providerFamilyDomain: "bigmodel" } });
  });

  it("keeps a legacy config.json as the only key source (no shared JWT, no account keys)", async () => {
    await withZcode314Home({
      "oauth:active_provider": "zai",
      zcodejwttoken: "jwt-token",
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:acct-1:api-key": "account-key",
    }, (home, v2) => {
      fs.writeFileSync(path.join(v2, "config.json"), JSON.stringify({
        provider: { "builtin:zai-coding-plan": { enabled: true, options: { apiKey: "config-key" } } },
      }));
      const auths = loadZcodeAuthCandidates({ home, env: {} });
      assert.deepEqual(auths.map((auth) => [auth.providerKey, auth.auth_source]), [
        ["builtin:zai-coding-plan", "provider:config"],
      ]);
    });
  });
});

describe("ZCode start-plan promotional grants", () => {
  // Shape captured from billing/balance in ZCode 3.14.3: a daily Start Plan plus a
  // one-time weekend promotion that grants extra GLM-5.3-Flash units.
  function promoBalanceBody() {
    const daily = (id, name, total, used, priority) => ({
      user_plan_id: "upl_daily", plan_id: "zcode-v3-start-plan-0817", entitlement_id: id,
      show_name: name, priority, plan_priority: 90, total_units: total, used_units: used,
      remaining_units: total - used, period_end: 1790351999, expires_at: 1790351999,
    });
    return {
      code: 0,
      data: {
        server_time: 1790300000,
        plans: [
          {
            user_plan_id: "upl_weekend", plan_id: "zcode-v3-start-plan-0924-wk", name: "ZCode Weekend Build",
            status: "active", entitlements: [{ entitlement_id: "ent-wk-1", show_name: "GLM-5.3-Flash", period: "one_time" }],
          },
          {
            user_plan_id: "upl_daily", plan_id: "zcode-v3-start-plan-0817", name: "ZCode Start Plan",
            status: "active",
            entitlements: [
              { entitlement_id: "ent_glm_5p3", show_name: "GLM-5.3", period: "daily" },
              { entitlement_id: "ent_glm_5p3f", show_name: "GLM-5.3-Flash", period: "daily" },
            ],
          },
        ],
        balances: [
          {
            user_plan_id: "upl_weekend", plan_id: "zcode-v3-start-plan-0924-wk", entitlement_id: "ent-wk-1",
            show_name: "GLM-5.3-Flash", total_units: 300_000_000, used_units: 3_000_000,
            remaining_units: 297_000_000, period_end: 1790557200, expires_at: 1790557200,
          },
          daily("ent_glm_5p3", "GLM-5.3", 3_000_000, 3_000_000, 110),
          daily("ent_glm_5p3f", "GLM-5.3-Flash", 5_000_000, 1_000_000, 80),
        ],
      },
    };
  }

  it("keeps daily allowances as the primary windows and labels promotions by plan name", () => {
    const out = normalizeZcodeBalanceResponse(promoBalanceBody());
    assert.deepEqual(out.buckets.map((b) => [b.label, b.period, b.window.used_percent]), [
      ["GLM-5.3", "daily", 100],
      ["GLM-5.3-Flash", "daily", 20],
      ["GLM-5.3-Flash · ZCode Weekend Build", "one_time", 1],
    ]);
    assert.equal(out.primary_window.used_percent, 100);
    assert.equal(out.secondary_window.used_percent, 20);
    assert.equal(out.plan_id, "zcode-v3-start-plan-0817");
    assert.equal(out.plan_label, "Start");
  });

  it("keeps the legacy total-based order when the payload has no plans", () => {
    const out = normalizeZcodeBalanceResponse(balanceBody());
    assert.deepEqual(out.buckets.map((b) => [b.label, b.period]), [["GLM-5.2", null], ["GLM-5-Turbo", null]]);
  });

  it("ignores bucket priority without plan metadata so legacy windows keep their order", () => {
    const body = balanceBody();
    body.data.balances[0].priority = 10;
    body.data.balances[1].priority = 110;
    const out = normalizeZcodeBalanceResponse(body);
    assert.deepEqual(out.buckets.map((b) => b.label), ["GLM-5.2", "GLM-5-Turbo"]);
  });
});

describe("ZCode limits disk cache", () => {
  const T0 = new Date(2026, 6, 8, 9, 0, 0).getTime();
  const T0_ISO = new Date(T0).toISOString();
  const APP_ENV = { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" };

  function writeStartPlanConfig(tmp) {
    const v2 = path.join(tmp, ".zcode", "v2");
    fs.mkdirSync(v2, { recursive: true });
    fs.writeFileSync(
      path.join(v2, "config.json"),
      JSON.stringify({
        provider: {
          "builtin:bigmodel-start-plan": {
            enabled: true,
            options: { apiKey: "live-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
          },
        },
      }),
      "utf8",
    );
    return v2;
  }

  function writeDualStartPlanConfig(tmp) {
    const v2 = path.join(tmp, ".zcode", "v2");
    fs.mkdirSync(v2, { recursive: true });
    fs.writeFileSync(
      path.join(v2, "config.json"),
      JSON.stringify({
        provider: {
          "builtin:bigmodel-start-plan": {
            enabled: true,
            options: { apiKey: "bm-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
          },
          "builtin:zai-start-plan": {
            enabled: true,
            options: { apiKey: "zai-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
          },
        },
      }),
      "utf8",
    );
    return v2;
  }

  function writeCodingPlanConfig(tmp) {
    const v2 = path.join(tmp, ".zcode", "v2");
    fs.mkdirSync(v2, { recursive: true });
    fs.writeFileSync(
      path.join(v2, "config.json"),
      JSON.stringify({
        provider: {
          "builtin:zai-coding-plan": {
            enabled: true,
            options: { apiKey: "coding-key", baseURL: "https://api.z.ai/api/anthropic" },
          },
        },
      }),
      "utf8",
    );
    return v2;
  }

  // balanceBody() with reset stamps pushed past T0 so the windows are cache-eligible.
  function futureBalanceBody() {
    const body = balanceBody();
    const resetSec = Math.floor((T0 + 6 * 60 * 60 * 1000) / 1000);
    for (const b of body.data.balances) {
      b.period_end = resetSec;
      b.expires_at = resetSec;
    }
    return body;
  }

  function seededLimits({ percent = 20 } = {}) {
    const body = futureBalanceBody();
    body.data.balances[0].used_units = Math.round(body.data.balances[0].total_units * percent / 100);
    return { configured: true, error: null, ...normalizeZcodeBalanceResponse(body) };
  }

  const okResponse = (body) => async () => ({ ok: true, status: 200, async json() { return body; } });
  const statusResponse = (status, body = {}) => async () => ({ ok: false, status, async json() { return body; } });
  const cachePath = (tmp) => path.join(tmp, ".tokentracker", "tracker", "zcode-usage-limits-cache.json");
  // The identity fetchZcodeLimits computes when no login identity is readable
  // (these fixtures carry no user_info credential); login-scoped tests use the
  // real login id instead.
  const CACHE_IDENTITY = zcodeCacheIdentity(null);
  const identityMap = (...keys) => new Map(keys.map((key) => [key, new Set([CACHE_IDENTITY])]));

  it("writes last-good windows to the disk cache on live success", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-write-"));
    try {
      writeStartPlanConfig(tmp);
      const result = await fetchZcodeLimits({ home: tmp, env: APP_ENV, nowMs: T0, fetchImpl: okResponse(futureBalanceBody()) });
      assert.equal(result.error, null);
      const parsed = JSON.parse(fs.readFileSync(cachePath(tmp), "utf8"));
      assert.equal(parsed["builtin:bigmodel-start-plan"].plan_kind, "start-plan");
      assert.equal(parsed["builtin:bigmodel-start-plan"].plan_label, "Start");
      assert.equal(typeof parsed["builtin:bigmodel-start-plan"].identity, "string");
      assert.equal(parsed["builtin:bigmodel-start-plan"].primary_window.used_percent, 20);
      assert.equal(parsed["builtin:bigmodel-start-plan"].cached_at, T0_ISO);
      assert.equal(parsed["builtin:zai-start-plan"], undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves stale windows from the disk cache when the live chain fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-serve-"));
    try {
      writeStartPlanConfig(tmp);
      await fetchZcodeLimits({ home: tmp, env: APP_ENV, nowMs: T0, fetchImpl: okResponse(futureBalanceBody()) });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: APP_ENV,
        nowMs: T0 + 5 * 60_000,
        fetchImpl: statusResponse(500, { code: 500, msg: "boom" }),
      });
      assert.equal(result.source, "disk-cache");
      assert.equal(result.stale, true);
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:bigmodel-start-plan");
      assert.equal(result.primary_window.used_percent, 20);
      assert.equal(result.cached_at, T0_ISO);
      assert.deepEqual(result.buckets.map((b) => b.show_name), ["GLM-5.2", "GLM-5-Turbo"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("never serves another region's cached windows", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-isolate-"));
    try {
      writeStartPlanConfig(tmp);
      writeZcodeLimitsCache(seededLimits(), { home: tmp, nowMs: T0 - 60_000, providerKey: "builtin:zai-start-plan", identity: CACHE_IDENTITY });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: APP_ENV,
        nowMs: T0,
        fetchImpl: statusResponse(500, { code: 500, msg: "boom" }),
      });
      assert.match(result.error, /500/);
      assert.equal(result.source, undefined);
      assert.equal(result.stale, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("drops cached windows whose reset_at has already rolled", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-reset-"));
    try {
      const rolled = {
        configured: true,
        error: null,
        plan_kind: "start-plan",
        plan_id: null,
        plan_label: "Start",
        buckets: [
          { show_name: "Past", window: { used_percent: 90, reset_at: new Date(T0 - 3_600_000).toISOString() } },
          { show_name: "Future", window: { used_percent: 10, reset_at: new Date(T0 + 3_600_000).toISOString() } },
        ],
        primary_window: { used_percent: 90, reset_at: new Date(T0 - 3_600_000).toISOString() },
        secondary_window: { used_percent: 10, reset_at: new Date(T0 + 3_600_000).toISOString() },
        tertiary_window: null,
      };
      writeZcodeLimitsCache(rolled, { home: tmp, nowMs: T0 - 60_000, providerKey: "builtin:bigmodel-start-plan", identity: CACHE_IDENTITY });
      const cached = readZcodeLimitsCache({ home: tmp, nowMs: T0, providerKeys: ["builtin:bigmodel-start-plan"], identityByKey: identityMap("builtin:bigmodel-start-plan") });
      assert.equal(cached.stale, true);
      assert.equal(cached.primary_window, null);
      assert.equal(cached.secondary_window.used_percent, 10);
      assert.deepEqual(cached.buckets.map((b) => b.show_name), ["Future"]);

      const allRolled = { ...rolled, primary_window: rolled.primary_window, secondary_window: null, tertiary_window: null, buckets: [rolled.buckets[0]] };
      writeZcodeLimitsCache(allRolled, { home: tmp, nowMs: T0 - 60_000, providerKey: "builtin:bigmodel-start-plan", identity: CACHE_IDENTITY });
      assert.equal(readZcodeLimitsCache({ home: tmp, nowMs: T0, providerKeys: ["builtin:bigmodel-start-plan"], identityByKey: identityMap("builtin:bigmodel-start-plan") }), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds undated cached windows by the unknown-reset TTL", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-ttl-"));
    try {
      const undated = {
        configured: true,
        error: null,
        plan_kind: "start-plan",
        plan_id: null,
        plan_label: "Start",
        buckets: [],
        primary_window: { used_percent: 42, reset_at: null },
        secondary_window: null,
        tertiary_window: null,
      };
      writeZcodeLimitsCache(undated, { home: tmp, nowMs: T0 - 3_600_000, providerKey: "builtin:bigmodel-start-plan", identity: CACHE_IDENTITY });
      const fresh = readZcodeLimitsCache({ home: tmp, nowMs: T0, providerKeys: ["builtin:bigmodel-start-plan"], identityByKey: identityMap("builtin:bigmodel-start-plan") });
      assert.equal(fresh.primary_window.used_percent, 42);

      writeZcodeLimitsCache(undated, { home: tmp, nowMs: T0 - 13 * 3_600_000, providerKey: "builtin:bigmodel-start-plan", identity: CACHE_IDENTITY });
      assert.equal(readZcodeLimitsCache({ home: tmp, nowMs: T0, providerKeys: ["builtin:bigmodel-start-plan"], identityByKey: identityMap("builtin:bigmodel-start-plan") }), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips writing the cache for error results and windowless successes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-gate-"));
    try {
      writeZcodeLimitsCache({ configured: true, error: "boom" }, { home: tmp, nowMs: T0, providerKey: "builtin:bigmodel-start-plan", identity: CACHE_IDENTITY });
      writeZcodeLimitsCache({
        configured: true, error: null, plan_kind: "start-plan", buckets: [],
        primary_window: null, secondary_window: null, tertiary_window: null,
      }, { home: tmp, nowMs: T0, providerKey: "builtin:bigmodel-start-plan", identity: CACHE_IDENTITY });
      assert.equal(fs.existsSync(cachePath(tmp)), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces auth errors instead of stale bars even when a cache exists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-auth-"));
    try {
      writeStartPlanConfig(tmp);
      writeZcodeLimitsCache(seededLimits(), { home: tmp, nowMs: T0 - 60_000, providerKey: "builtin:bigmodel-start-plan", identity: CACHE_IDENTITY });
      const result = await fetchZcodeLimits({ home: tmp, env: APP_ENV, nowMs: T0, fetchImpl: statusResponse(401) });
      assert.match(result.error, /Not authenticated/);
      assert.equal(result.source, undefined);
      assert.equal(result.stale, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves the network-failed partition's cache when a sibling partition failed auth", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-mixed-"));
    try {
      writeDualStartPlanConfig(tmp);
      // Seed with the identity the candidates will present (no user_info
      // fixture here, so both partitions resolve to the unreadable login).
      writeZcodeLimitsCache(seededLimits({ percent: 11 }), { home: tmp, nowMs: T0 - 60_000, providerKey: "builtin:bigmodel-start-plan", identity: CACHE_IDENTITY });
      writeZcodeLimitsCache(seededLimits({ percent: 22 }), { home: tmp, nowMs: T0 - 60_000, providerKey: "builtin:zai-start-plan", identity: CACHE_IDENTITY });
      const seenKeys = [];
      const result = await fetchZcodeLimits({
        home: tmp,
        env: APP_ENV,
        nowMs: T0,
        fetchImpl: async (_url, options) => {
          seenKeys.push(options.headers.Authorization);
          return options.headers.Authorization === "Bearer bm-key"
            ? { ok: false, status: 401, async json() { return {}; } }
            : { ok: false, status: 500, async json() { return { code: 500, msg: "boom" }; } };
        },
      });
      assert.deepEqual(seenKeys, ["Bearer bm-key", "Bearer zai-key"]);
      assert.equal(result.source, "disk-cache");
      assert.equal(result.stale, true);
      assert.equal(result.provider_key, "builtin:zai-start-plan");
      assert.equal(result.primary_window.used_percent, 22);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("caches and serves coding-plan windows across a live failure", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-coding-"));
    try {
      writeCodingPlanConfig(tmp);
      const first = await fetchZcodeLimits({
        home: tmp,
        nowMs: T0,
        fetchImpl: async (url) => {
          assert.ok(url.includes("/api/monitor/usage/quota/limit"));
          return { ok: true, status: 200, async json() { return realLiteCodingPlanQuotaBody({ fiveHourPercent: 14 }); } };
        },
      });
      assert.equal(first.plan_kind, "coding-plan");
      const parsed = JSON.parse(fs.readFileSync(cachePath(tmp), "utf8"));
      assert.equal(parsed["builtin:zai-coding-plan"].plan_kind, "coding-plan");
      assert.equal(parsed["builtin:zai-coding-plan"].plan_label, "Lite");

      const second = await fetchZcodeLimits({
        home: tmp,
        nowMs: T0 + 60_000,
        fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND api.z.ai"); },
      });
      assert.equal(second.source, "disk-cache");
      assert.equal(second.stale, true);
      assert.equal(second.provider_key, "builtin:zai-coding-plan");
      assert.equal(second.plan_kind, "coding-plan");
      assert.equal(second.plan_label, "Lite");
      // The weekly window resets days after T0 in every timezone, unlike the 5h one.
      assert.equal(second.secondary_window.used_percent, 43);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("marks log fallback results with their data age", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-log-age-"));
    try {
      const v2 = writeStartPlanConfig(tmp);
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077");
      const result = await fetchZcodeLimits({
        home: tmp,
        env: APP_ENV,
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: statusResponse(405, { code: 3012, msg: "method not allowed" }),
      });
      assert.equal(result.source, "zcode-log");
      assert.equal(result.stale, true);
      assert.equal(result.cached_at, new Date(2026, 6, 8, 9, 8, 30, 77).toISOString());
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not serve a disk-cache hit that has no surviving window", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-windowless-"));
    try {
      // Every window has rolled, but a windowless bucket still survives the
      // snapshot TTL — that is not a usable fallback and must not mask the
      // live error.
      writeZcodeLimitsCache({
        configured: true, error: null, plan_kind: "start-plan",
        buckets: [{ show_name: "Legacy bucket" }],
        primary_window: { used_percent: 90, reset_at: new Date(T0 - 3_600_000).toISOString() },
        secondary_window: null, tertiary_window: null,
      }, { home: tmp, nowMs: T0 - 60_000, providerKey: "builtin:bigmodel-start-plan", identity: CACHE_IDENTITY });
      assert.equal(
        readZcodeLimitsCache({ home: tmp, nowMs: T0, providerKeys: ["builtin:bigmodel-start-plan"], identityByKey: identityMap("builtin:bigmodel-start-plan") }),
        null,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not serve the previous login's cached windows after an account switch", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-cache-switch-"));
    try {
      const v2 = writeStartPlanConfig(tmp);
      const credentialsPath = path.join(v2, "credentials.json");
      const writeLogin = (id) => fs.writeFileSync(
        credentialsPath,
        JSON.stringify({ "oauth:bigmodel:user_info": JSON.stringify({ id }) }),
        "utf8",
      );
      writeLogin("login-a");
      await fetchZcodeLimits({ home: tmp, env: APP_ENV, nowMs: T0, fetchImpl: okResponse(futureBalanceBody()) });
      const parsed = JSON.parse(fs.readFileSync(cachePath(tmp), "utf8"));
      assert.equal(parsed["builtin:bigmodel-start-plan"].identity, "login-a|");
      // Same region × plan kind, new login: the cached partition must not be
      // inherited by the switched account.
      writeLogin("login-b");
      const result = await fetchZcodeLimits({
        home: tmp,
        env: APP_ENV,
        nowMs: T0 + 5 * 60_000,
        fetchImpl: statusResponse(500, { code: 500, msg: "boom" }),
      });
      assert.match(result.error, /500/);
      assert.equal(result.source, undefined);
      assert.equal(result.stale, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not mask a re-login error with a log record from the failed partition", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-log-auth-"));
    try {
      const v2 = writeStartPlanConfig(tmp);
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077", { providerId: "builtin:bigmodel-start-plan" });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: APP_ENV,
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: statusResponse(401),
      });
      assert.equal(result.configured, true);
      assert.match(result.error, /Not authenticated/);
      assert.equal(result.source, undefined);
      assert.equal(result.stale, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still serves a log record for a provider with no live candidate", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-log-uncandidate-"));
    try {
      const v2 = writeStartPlanConfig(tmp);
      // The log record belongs to a provider the current config does not list,
      // so nothing was attempted for it and no error is being masked.
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077", { providerId: "builtin:zai-start-plan" });
      const result = await fetchZcodeLimits({
        home: tmp,
        env: APP_ENV,
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: statusResponse(500, { code: 500, msg: "boom" }),
      });
      assert.equal(result.source, "zcode-log");
      assert.equal(result.provider_key, "builtin:zai-start-plan");
      assert.equal(result.stale, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
