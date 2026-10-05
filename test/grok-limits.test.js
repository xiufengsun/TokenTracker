const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  normalizeGrokBillingResponse,
  normalizeGrokPeriodType,
  inferGrokPeriodTypeFromDates,
  sumProductUsagePercent,
  deriveGrokPlanLabel,
  fetchGrokBilling,
  fetchGrokLimits,
  readGrokAccessToken,
  isGrokInstalled,
  isGrokAccessTokenExpired,
  refreshGrokTokens,
  persistGrokRefreshedAuth,
  resolveGrokAccessToken,
  DEFAULT_TOKEN_ENDPOINT,
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
} = require("../src/lib/grok-limits");

describe("normalizeGrokPeriodType", () => {
  it("maps USAGE_PERIOD_TYPE_* enums for daily/weekly/monthly only", () => {
    assert.equal(normalizeGrokPeriodType("USAGE_PERIOD_TYPE_WEEKLY"), "weekly");
    assert.equal(normalizeGrokPeriodType("USAGE_PERIOD_TYPE_MONTHLY"), "monthly");
    assert.equal(normalizeGrokPeriodType("USAGE_PERIOD_TYPE_DAILY"), "daily");
    assert.equal(normalizeGrokPeriodType("weekly"), "weekly");
    // Hourly is not a recognized end-to-end period — do not emit it.
    assert.equal(normalizeGrokPeriodType("USAGE_PERIOD_TYPE_HOURLY"), null);
    assert.equal(normalizeGrokPeriodType("hourly"), null);
    assert.equal(normalizeGrokPeriodType(""), null);
    assert.equal(normalizeGrokPeriodType(null), null);
  });
});

describe("inferGrokPeriodTypeFromDates", () => {
  it("classifies daily / weekly / monthly windows and leaves gaps null", () => {
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-13T00:00:00Z", "2026-07-14T00:00:00Z"),
      "daily",
    );
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-13T00:00:00Z", "2026-07-20T00:00:00Z"),
      "weekly",
    );
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"),
      "monthly",
    );
    // Sub-day and odd mid lengths must not be mislabeled as weekly.
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-13T00:00:00Z", "2026-07-13T02:00:00Z"),
      null,
    );
    assert.equal(
      inferGrokPeriodTypeFromDates("2026-07-01T00:00:00Z", "2026-07-13T00:00:00Z"),
      null,
    );
  });
});

describe("sumProductUsagePercent", () => {
  it("sums shared-pool product attribution percentages", () => {
    assert.equal(
      sumProductUsagePercent([
        { product: "GrokBuild", usagePercent: 17 },
        { product: "GrokChat", usagePercent: 1 },
      ]),
      18,
    );
    assert.equal(sumProductUsagePercent([{ product: "GrokBuild", usagePercent: 42 }]), 42);
    assert.equal(sumProductUsagePercent([]), null);
    assert.equal(sumProductUsagePercent(null), null);
  });
});

describe("normalizeGrokBillingResponse", () => {
  it("maps unified format=credits weekly pool", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-13T09:23:37.846092+00:00",
          end: "2026-07-20T09:23:37.846092+00:00",
        },
        creditUsagePercent: 18.0,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        productUsage: [
          { product: "GrokBuild", usagePercent: 17.0 },
          { product: "GrokChat", usagePercent: 1.0 },
        ],
        isUnifiedBillingUser: true,
        billingPeriodStart: "2026-07-13T09:23:37.846092+00:00",
        billingPeriodEnd: "2026-07-20T09:23:37.846092+00:00",
      },
    });

    assert.equal(result.period_type, "weekly");
    assert.equal(result.credit_usage_percent, 18);
    // Overall pool percent (not GrokBuild-only attribution) is the quota bar.
    assert.deepEqual(result.primary_window, {
      used_percent: 18,
      reset_at: "2026-07-20T09:23:37.846Z",
    });
    assert.equal(result.secondary_window, null);
    assert.equal(result.billing_period_start, "2026-07-13T09:23:37.846Z");
  });

  it("maps legacy monthly credits and billing period reset", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        monthlyLimit: { val: 150_000 },
        used: { val: 4_625 },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        billingPeriodStart: "2026-06-01T00:00:00+00:00",
        billingPeriodEnd: "2026-07-01T00:00:00+00:00",
      },
    });

    assert.equal(result.period_type, "monthly");
    assert.equal(result.monthly_credits_limit, 150_000);
    assert.equal(result.monthly_credits_used, 4_625);
    assert.deepEqual(result.primary_window, {
      used_percent: (4_625 / 150_000) * 100,
      reset_at: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(result.secondary_window, null);
  });

  it("adds on-demand window when cap is positive", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        monthlyLimit: { val: 100 },
        used: { val: 10 },
        onDemandCap: { val: 50 },
        onDemandUsed: { val: 25 },
        billingPeriodEnd: "2026-07-01T00:00:00Z",
      },
    });

    assert.deepEqual(result.secondary_window, {
      used_percent: 50,
      reset_at: "2026-07-01T00:00:00.000Z",
    });
  });

  it("sums all productUsage entries when creditUsagePercent is missing", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-13T00:00:00Z",
          end: "2026-07-20T00:00:00Z",
        },
        productUsage: [
          { product: "GrokBuild", usagePercent: 17 },
          { product: "GrokChat", usagePercent: 1 },
        ],
        billingPeriodEnd: "2026-07-20T00:00:00Z",
      },
    });

    assert.equal(result.period_type, "weekly");
    // Shared pool: 17 + 1 = 18, not GrokBuild-only 17.
    assert.equal(result.primary_window.used_percent, 18);
    assert.equal(result.credit_usage_percent, 18);
  });

  it("falls back to a single productUsage entry when only one is present", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-13T00:00:00Z",
          end: "2026-07-20T00:00:00Z",
        },
        productUsage: [{ product: "GrokBuild", usagePercent: 42 }],
        billingPeriodEnd: "2026-07-20T00:00:00Z",
      },
    });

    assert.equal(result.period_type, "weekly");
    assert.equal(result.primary_window.used_percent, 42);
    assert.equal(result.credit_usage_percent, 42);
  });

  it("infers daily / weekly / monthly from period length when type is omitted", () => {
    assert.equal(
      normalizeGrokBillingResponse({
        config: {
          creditUsagePercent: 5,
          billingPeriodStart: "2026-07-13T00:00:00Z",
          billingPeriodEnd: "2026-07-14T00:00:00Z",
        },
      }).period_type,
      "daily",
    );
    assert.equal(
      normalizeGrokBillingResponse({
        config: {
          creditUsagePercent: 5,
          billingPeriodStart: "2026-07-13T00:00:00Z",
          billingPeriodEnd: "2026-07-20T00:00:00Z",
        },
      }).period_type,
      "weekly",
    );
    assert.equal(
      normalizeGrokBillingResponse({
        config: {
          creditUsagePercent: 5,
          billingPeriodStart: "2026-07-01T00:00:00Z",
          billingPeriodEnd: "2026-08-01T00:00:00Z",
        },
      }).period_type,
      "monthly",
    );
  });

  it("does not emit hourly as a recognized period_type", () => {
    const result = normalizeGrokBillingResponse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_HOURLY",
          start: "2026-07-13T00:00:00Z",
          end: "2026-07-13T01:00:00Z",
        },
        creditUsagePercent: 10,
      },
    });
    // Type ignored; sub-day length also does not infer weekly/daily.
    assert.equal(result.period_type, null);
    assert.equal(result.primary_window.used_percent, 10);
  });
});

describe("fetchGrokLimits", () => {
  it("returns configured false when auth is missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-missing-"));
    try {
      assert.equal(isGrokInstalled({ home: tmp }), false);
      assert.deepEqual(await fetchGrokLimits({ home: tmp }), { configured: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fetches format=credits billing via cli-chat-proxy with stored token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-fetch-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::test": { key: "test-token" },
        }),
        "utf8",
      );

      assert.equal(readGrokAccessToken({ home: tmp, env: { GROK_HOME: grokHome } }), "test-token");

      const urls = [];
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url, options) => {
          urls.push(url);
          assert.equal(options.headers.Authorization, "Bearer test-token");
          if (String(url).endsWith("/v1/settings")) {
            return { ok: true, status: 200, async json() {
              return { subscription_tier_display: "SuperGrok Heavy" };
            } };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                config: {
                  currentPeriod: {
                    type: "USAGE_PERIOD_TYPE_WEEKLY",
                    start: "2026-07-13T09:23:37.846092+00:00",
                    end: "2026-07-20T09:23:37.846092+00:00",
                  },
                  creditUsagePercent: 25,
                  onDemandCap: { val: 0 },
                  billingPeriodEnd: "2026-07-20T09:23:37.846092+00:00",
                },
              };
            },
          };
        },
      });

      assert.equal(urls[0], "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
      assert.equal(urls[1], "https://cli-chat-proxy.grok.com/v1/settings");
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.plan_label, "SuperGrok Heavy");
      assert.equal(result.period_type, "weekly");
      assert.equal(result.primary_window.used_percent, 25);
      assert.equal(result.primary_window.reset_at, "2026-07-20T09:23:37.846Z");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the quota when the settings lookup fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-settings-fail-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(path.join(grokHome, "auth.json"), JSON.stringify({
        "https://auth.x.ai::test": { key: "test-token" },
      }));
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url) => {
          if (String(url).endsWith("/v1/settings")) throw new Error("settings unavailable");
          return { ok: true, status: 200, async json() {
            return { config: {
              creditUsagePercent: 25,
              currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-30T00:00:00Z" },
            } };
          } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.plan_label, null);
      assert.equal(result.primary_window.used_percent, 25);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to legacy /v1/billing when format=credits fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-fallback-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::test": { key: "test-token" },
        }),
        "utf8",
      );

      const urls = [];
      let canceledBodies = 0;
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url) => {
          urls.push(url);
          if (String(url).includes("format=credits")) {
            return {
              ok: false,
              status: 500,
              body: {
                async cancel() {
                  canceledBodies += 1;
                },
              },
              async json() { return {}; },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                config: {
                  monthlyLimit: { val: 1000 },
                  used: { val: 250 },
                  onDemandCap: { val: 0 },
                  billingPeriodStart: "2026-07-01T00:00:00Z",
                  billingPeriodEnd: "2026-08-01T00:00:00Z",
                },
              };
            },
          };
        },
      });

      assert.deepEqual(urls, [
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        "https://cli-chat-proxy.grok.com/v1/billing",
        "https://cli-chat-proxy.grok.com/v1/settings",
      ]);
      assert.equal(result.configured, true);
      assert.equal(result.period_type, "monthly");
      assert.equal(result.primary_window.used_percent, 25);
      assert.equal(canceledBodies, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cancels an auth-error response body before surfacing reauthentication", async () => {
    let canceledBodies = 0;

    await assert.rejects(
      fetchGrokBilling("test-token", {
        timeoutMs: 100,
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          body: {
            async cancel() {
              canceledBodies += 1;
            },
          },
        }),
      }),
      /grok login/i,
    );
    assert.equal(canceledBodies, 1);
  });

  it("falls back to legacy /v1/billing after a format=credits network error", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-network-fallback-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::test": { key: "test-token" },
        }),
        "utf8",
      );

      const urls = [];
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url) => {
          urls.push(url);
          if (String(url).includes("format=credits")) {
            throw new TypeError("fetch failed");
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                config: {
                  monthlyLimit: { val: 1000 },
                  used: { val: 250 },
                  onDemandCap: { val: 0 },
                  billingPeriodStart: "2026-07-01T00:00:00Z",
                  billingPeriodEnd: "2026-08-01T00:00:00Z",
                },
              };
            },
          };
        },
      });

      assert.deepEqual(urls, [
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        "https://cli-chat-proxy.grok.com/v1/billing",
        "https://cli-chat-proxy.grok.com/v1/settings",
      ]);
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.period_type, "monthly");
      assert.equal(result.primary_window.used_percent, 25);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not start a late fallback after the shared request deadline", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-timeout-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::test": { key: "test-token" },
        }),
        "utf8",
      );

      const urls = [];
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        timeoutMs: 30,
        fetchImpl: async (url, options) => {
          urls.push(url);
          await new Promise((_, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), {
              once: true,
            });
          });
        },
      });

      assert.deepEqual(urls, [
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      ]);
      assert.equal(result.configured, true);
      assert.match(result.error, /timed out/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refreshes an expired access token before billing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-refresh-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      const authPath = path.join(grokHome, "auth.json");
      const scope = "https://auth.x.ai::client-abc";
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          [scope]: {
            key: "stale-access",
            refresh_token: "rt-abc",
            expires_at: "2020-01-01T00:00:00.000Z",
            oidc_client_id: "client-abc",
            oidc_issuer: "https://auth.x.ai",
          },
        }),
        "utf8",
      );

      const urls = [];
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        nowMs: Date.parse("2026-07-28T12:00:00.000Z"),
        fetchImpl: async (url, options) => {
          urls.push(String(url));
          if (String(url).includes("/oauth2/token")) {
            assert.equal(options.method, "POST");
            assert.match(options.headers["Content-Type"], /application\/x-www-form-urlencoded/);
            const body = new URLSearchParams(options.body);
            assert.equal(body.get("grant_type"), "refresh_token");
            assert.equal(body.get("refresh_token"), "rt-abc");
            assert.equal(body.get("client_id"), "client-abc");
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  access_token: "fresh-access",
                  refresh_token: "rt-new",
                  expires_in: 3600,
                };
              },
            };
          }
          assert.equal(options.headers.Authorization, "Bearer fresh-access");
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                config: {
                  currentPeriod: {
                    type: "USAGE_PERIOD_TYPE_WEEKLY",
                    start: "2026-07-22T00:00:00Z",
                    end: "2026-07-29T00:00:00Z",
                  },
                  creditUsagePercent: 41,
                },
              };
            },
          };
        },
      });

      assert.equal(urls[0], DEFAULT_TOKEN_ENDPOINT);
      assert.equal(urls[1], "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.primary_window.used_percent, 41);

      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8"));
      assert.equal(persisted[scope].key, "fresh-access");
      assert.equal(persisted[scope].refresh_token, "rt-new");
      assert.ok(persisted[scope].expires_at);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retries billing once after 401 by forcing OIDC refresh", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-401-refresh-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::client-abc": {
            key: "still-present-but-revoked",
            refresh_token: "rt-abc",
            // Far future so preflight does not refresh first.
            expires_at: "2099-01-01T00:00:00.000Z",
            oidc_client_id: "client-abc",
            oidc_issuer: "https://auth.x.ai",
          },
        }),
        "utf8",
      );

      let billingHits = 0;
      let refreshHits = 0;
      // Recorded rather than asserted inside fetchImpl: fetchGrokPlanLabel
      // swallows errors, so an in-callback assert could never fail the test.
      let settingsAuthorization = null;
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url, options) => {
          if (String(url).includes("/oauth2/token")) {
            refreshHits += 1;
            return {
              ok: true,
              status: 200,
              async json() {
                return { access_token: "after-refresh", expires_in: 3600 };
              },
            };
          }
          if (String(url).endsWith("/v1/settings")) {
            settingsAuthorization = options.headers.Authorization;
            return {
              ok: true,
              status: 200,
              async json() {
                return { subscription_tier_display: "SuperGrok" };
              },
            };
          }
          billingHits += 1;
          if (billingHits === 1) {
            assert.equal(options.headers.Authorization, "Bearer still-present-but-revoked");
            return {
              ok: false,
              status: 401,
              body: { async cancel() {} },
            };
          }
          assert.equal(options.headers.Authorization, "Bearer after-refresh");
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                config: {
                  creditUsagePercent: 12,
                  billingPeriodStart: "2026-07-22T00:00:00Z",
                  billingPeriodEnd: "2026-07-29T00:00:00Z",
                },
              };
            },
          };
        },
      });

      assert.equal(refreshHits, 1);
      assert.equal(billingHits, 2);
      assert.equal(settingsAuthorization, "Bearer after-refresh");
      assert.equal(result.plan_label, "SuperGrok");
      assert.equal(result.error, null);
      assert.equal(result.primary_window.used_percent, 12);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces reauth error when refresh_token is rejected", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-reauth-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::client-abc": {
            key: "stale-access",
            refresh_token: "rt-dead",
            expires_at: "2020-01-01T00:00:00.000Z",
            oidc_client_id: "client-abc",
          },
        }),
        "utf8",
      );

      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        nowMs: Date.parse("2026-07-28T12:00:00.000Z"),
        fetchImpl: async (url) => {
          assert.match(String(url), /oauth2\/token/);
          return {
            ok: false,
            status: 400,
            async json() {
              return { error: "invalid_grant" };
            },
          };
        },
      });

      assert.equal(result.configured, true);
      assert.match(result.error, /Grok session expired/i);
      assert.doesNotMatch(result.error, /Not logged in/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("isGrokAccessTokenExpired", () => {
  it("applies skew and ignores missing/invalid expiry", () => {
    const now = Date.parse("2026-07-28T12:00:00.000Z");
    assert.equal(isGrokAccessTokenExpired(null, now), false);
    assert.equal(isGrokAccessTokenExpired("not-a-date", now), false);
    assert.equal(isGrokAccessTokenExpired("2026-07-28T12:02:00.000Z", now), false);
    assert.equal(isGrokAccessTokenExpired("2026-07-28T12:00:30.000Z", now), true);
    assert.equal(isGrokAccessTokenExpired("2026-07-28T11:00:00.000Z", now), true);
    assert.equal(ACCESS_TOKEN_EXPIRY_SKEW_MS, 60_000);
  });
});

describe("refreshGrokTokens", () => {
  it("posts form-encoded refresh to the xAI token endpoint", async () => {
    let observedUrl = null;
    let observedBody = null;
    const result = await refreshGrokTokens({
      refreshToken: "rt-abc",
      clientId: "client-abc",
      fetchImpl: async (url, opts) => {
        observedUrl = url;
        observedBody = new URLSearchParams(opts.body);
        return {
          ok: true,
          status: 200,
          async json() {
            return { access_token: "new-access", refresh_token: "new-rt", expires_in: 120 };
          },
        };
      },
    });
    assert.equal(observedUrl, DEFAULT_TOKEN_ENDPOINT);
    assert.equal(observedBody.get("grant_type"), "refresh_token");
    assert.equal(observedBody.get("client_id"), "client-abc");
    assert.equal(result.access_token, "new-access");
    assert.equal(result.refresh_token, "new-rt");
    assert.ok(result.expires_at);
  });

  it("throws GROK_REAUTH_REQUIRED on invalid_grant", async () => {
    await assert.rejects(
      refreshGrokTokens({
        refreshToken: "rt-abc",
        clientId: "client-abc",
        fetchImpl: async () => ({
          ok: false,
          status: 400,
          async json() {
            return { error: "invalid_grant" };
          },
        }),
      }),
      (err) => err && err.code === "GROK_REAUTH_REQUIRED",
    );
  });
});

describe("persistGrokRefreshedAuth", () => {
  it("atomically updates the scoped auth entry", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-auth-persist-"));
    try {
      const authPath = path.join(tmp, "auth.json");
      const scope = "https://auth.x.ai::client-abc";
      const authFile = {
        [scope]: {
          key: "old",
          refresh_token: "rt-old",
          email: "user@example.com",
        },
      };
      fs.writeFileSync(authPath, JSON.stringify(authFile), "utf8");
      const persisted = await persistGrokRefreshedAuth(
        authPath,
        authFile,
        scope,
        authFile[scope],
        {
          access_token: "new",
          refresh_token: "rt-new",
          expires_at: "2026-07-28T18:00:00.000Z",
        },
      );
      assert.equal(persisted.entry.key, "new");
      const disk = JSON.parse(fs.readFileSync(authPath, "utf8"));
      assert.equal(disk[scope].key, "new");
      assert.equal(disk[scope].refresh_token, "rt-new");
      assert.equal(disk[scope].email, "user@example.com");
      assert.equal(disk[scope].expires_at, "2026-07-28T18:00:00.000Z");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveGrokAccessToken", () => {
  it("does not refresh a still-valid access token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-resolve-fresh-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::client-abc": {
            key: "fresh",
            refresh_token: "rt-abc",
            expires_at: "2099-01-01T00:00:00.000Z",
            oidc_client_id: "client-abc",
          },
        }),
        "utf8",
      );
      let fetchCalls = 0;
      const resolved = await resolveGrokAccessToken({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("should not fetch");
        },
      });
      assert.equal(resolved.accessToken, "fresh");
      assert.equal(resolved.refreshed, false);
      assert.equal(fetchCalls, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("grok refresh hardening", () => {
  it("treats a zero-usage unified period (creditUsagePercent omitted) as 0%", () => {
    // Real payload shape from a zero-usage week: unified billing drops
    // creditUsagePercent and productUsage entirely.
    const result = normalizeGrokBillingResponse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-22T00:00:00+00:00",
          end: "2026-07-29T00:00:00+00:00",
        },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        isUnifiedBillingUser: true,
        billingPeriodStart: "2026-07-22T00:00:00+00:00",
        billingPeriodEnd: "2026-07-29T00:00:00+00:00",
      },
    });

    assert.equal(result.period_type, "weekly");
    assert.equal(result.credit_usage_percent, 0);
    assert.deepEqual(result.primary_window, {
      used_percent: 0,
      reset_at: "2026-07-29T00:00:00.000Z",
    });
  });

  it("still rejects a present-but-malformed creditUsagePercent", () => {
    assert.throws(
      () =>
        normalizeGrokBillingResponse({
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-07-22T00:00:00+00:00",
              end: "2026-07-29T00:00:00+00:00",
            },
            creditUsagePercent: "40%",
          },
        }),
      /no quota windows/i,
    );
  });

  it("aborts a stalled token endpoint with GROK_REFRESH_TIMEOUT", async () => {
    await assert.rejects(
      refreshGrokTokens({
        refreshToken: "refresh-1",
        clientId: "client-1",
        timeoutMs: 30,
        fetchImpl: (url, options) =>
          new Promise((_, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), {
              once: true,
            });
          }),
      }),
      (err) => {
        assert.equal(err.code, "GROK_REFRESH_TIMEOUT");
        assert.match(err.message, /timed out/i);
        return true;
      },
    );
  });

  it("keeps the timeout armed through the response body read", async () => {
    await assert.rejects(
      refreshGrokTokens({
        refreshToken: "refresh-1",
        clientId: "client-1",
        timeoutMs: 30,
        fetchImpl: async (url, options) => ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_, reject) => {
              options.signal.addEventListener("abort", () => reject(options.signal.reason), {
                once: true,
              });
            }),
        }),
      }),
      (err) => err.code === "GROK_REFRESH_TIMEOUT",
    );
  });

  it("prefers a keyed auth entry over an earlier refresh-token-only entry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-entry-order-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::refresh-only": {
            refresh_token: "r1",
            oidc_client_id: "refresh-only-client",
          },
          "https://auth.x.ai::keyed": { key: "usable-token" },
        }),
        "utf8",
      );

      const env = { GROK_HOME: grokHome };
      const loaded = require("../src/lib/grok-limits").loadGrokAuthEntry({ home: tmp, env });
      assert.equal(loaded.entry.key, "usable-token");
      assert.equal(readGrokAccessToken({ home: tmp, env }), "usable-token");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores refresh-token-only entries with no resolvable client id", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-entry-noclient-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        // No oidc_client_id and no "::" suffix to recover it from.
        JSON.stringify({ "plain-scope": { refresh_token: "r1" } }),
        "utf8",
      );

      const loaded = require("../src/lib/grok-limits").loadGrokAuthEntry({
        home: tmp,
        env: { GROK_HOME: grokHome },
      });
      assert.equal(loaded, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("drops a stale expires_at when the refresh response has no lifetime", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-persist-stale-"));
    try {
      const authPath = path.join(tmp, "auth.json");
      const scopeKey = "https://auth.x.ai::client-1";
      const entry = {
        key: "old-token",
        refresh_token: "r1",
        expires_at: "2026-07-19T20:44:02.792386Z",
        oidc_client_id: "client-1",
      };
      const authFile = { [scopeKey]: entry };
      fs.writeFileSync(authPath, JSON.stringify(authFile), { mode: 0o600 });

      await persistGrokRefreshedAuth(authPath, authFile, scopeKey, entry, {
        access_token: "new-token",
        refresh_token: "r2",
        expires_at: null,
      });

      const onDisk = JSON.parse(fs.readFileSync(authPath, "utf8"));
      assert.equal(onDisk[scopeKey].key, "new-token");
      // Keeping the old timestamp would force a refresh on every poll.
      assert.equal("expires_at" in onDisk[scopeKey], false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cleans up the tmp file when the atomic rename fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-persist-cleanup-"));
    try {
      // rename() onto a non-empty directory fails on POSIX.
      const authPath = path.join(tmp, "auth.json");
      fs.mkdirSync(path.join(authPath, "block"), { recursive: true });

      const scopeKey = "https://auth.x.ai::client-1";
      const entry = { key: "old", refresh_token: "r1" };
      await assert.rejects(
        persistGrokRefreshedAuth(authPath, { [scopeKey]: entry }, scopeKey, entry, {
          access_token: "new-token",
        }),
      );

      // No auth.json.tmp.* file with fresh tokens may remain.
      const leftovers = fs.readdirSync(tmp).filter((name) => name.includes(".tmp."));
      assert.deepEqual(leftovers, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("deriveGrokPlanLabel", () => {
  // A live Free account's billing payload reads exactly {"subscriptionTier":"Free"},
  // so the field is a display string rather than an enum. Fold separators away
  // anyway: the paid literals are unverified and could arrive as SUPER_GROK_HEAVY.
  it("maps xAI tiers to their own product names regardless of casing", () => {
    assert.equal(deriveGrokPlanLabel("SuperGrok Heavy"), "SuperGrok Heavy");
    assert.equal(deriveGrokPlanLabel("SUPER_GROK_HEAVY"), "SuperGrok Heavy");
    assert.equal(deriveGrokPlanLabel("superGrokHeavy"), "SuperGrok Heavy");
    assert.equal(deriveGrokPlanLabel("SuperGrok Lite"), "SuperGrok Lite");
    assert.equal(deriveGrokPlanLabel("SuperGrok Plus"), "SuperGrok Plus");
    assert.equal(deriveGrokPlanLabel("SuperGrok"), "SuperGrok");
    assert.equal(deriveGrokPlanLabel("X Premium+"), "X Premium+");
    assert.equal(deriveGrokPlanLabel("PremiumPlus"), "X Premium+");
    assert.equal(deriveGrokPlanLabel("API Key"), "API Key");
    assert.equal(deriveGrokPlanLabel("Free"), "Free");
  });

  it("returns null for unknown, empty and missing tiers", () => {
    // Matching is exact: a prefix match would render an unseen
    // "SuperGrok Business" as plain "SuperGrok", which is a confidently wrong
    // plan on the card. Null lets the panel fall back to "Grok Build".
    assert.equal(deriveGrokPlanLabel("SuperGrok Business"), null);
    assert.equal(deriveGrokPlanLabel("TIER_UNSPECIFIED"), null);
    assert.equal(deriveGrokPlanLabel(""), null);
    assert.equal(deriveGrokPlanLabel(null), null);
    assert.equal(deriveGrokPlanLabel(undefined), null);
  });

  it("reads subscriptionTier from the response root, not from config", () => {
    const base = {
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-09-08T00:00:00+00:00",
          end: "2026-09-15T00:00:00+00:00",
        },
        creditUsagePercent: 12,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        isUnifiedBillingUser: true,
      },
    };

    assert.equal(
      normalizeGrokBillingResponse({ ...base, subscriptionTier: "SuperGrok Heavy" }).plan_label,
      "SuperGrok Heavy",
    );
    // Nested under config is the wrong place and must not be picked up.
    assert.equal(
      normalizeGrokBillingResponse({ config: { ...base.config, subscriptionTier: "SuperGrok Heavy" } }).plan_label,
      null,
    );
    assert.equal(normalizeGrokBillingResponse(base).plan_label, null);
  });
});
