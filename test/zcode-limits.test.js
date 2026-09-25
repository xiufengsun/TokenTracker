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
  resolveZcodeAppVersion,
  resolveZcodeProviderBillingBaseUrl,
  resolveZcodeProviderQuotaUrl,
  loadZcodeSelectedPlanProviderKeys,
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
function realLiteCodingPlanQuotaBody({ fiveHourPercent = 14 } = {}) {
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
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: fiveHourPercent,
          nextResetTime: 1_783_540_151_760,
        },
        {
          type: "TOKENS_LIMIT",
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

  it("keeps ignoring the shared JWT for providers a legacy config.json does not list", async () => {
    await withZcode314Home({ "oauth:active_provider": "zai", zcodejwttoken: "jwt-token" }, (home, v2) => {
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
});
