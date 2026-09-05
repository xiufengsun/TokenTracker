const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  cacheExpiresAtMs,
  extractGeminiOauthClientCredentials,
  getUsageLimits,
  normalizePlanLabel,
  loadKimiCredentials,
  normalizeCursorUsageSummary,
  normalizeCursorSandUsageStatus,
  normalizeGeminiQuotaResponse,
  normalizeKimiUsageResponse,
  parseKiroUsageOutput,
  fetchKiroLimits,
  runCommand,
  resetUsageLimitsCache,
  normalizeAntigravityResponse,
  normalizeAntigravityQuotaSummary,
  loadAntigravityCredentials,
  parseListeningPorts,
  parseWindowsListeningPorts,
  parseLinuxProcListeningPorts,
  parseSsListeningPorts,
  listAntigravityPorts,
  detectAntigravityProcess,
  fetchAntigravityLimits,
  fetchCopilotLimits,
  describeCopilotOtelStatus,
} = require("../src/lib/usage-limits");
const { writeArkCodingPlanLimitsCache } = require("../src/lib/ark-coding-plan-limits");

// Match a fetch URL by host (exact or subdomain) rather than substring, so the
// filter can't be fooled by lookalike hosts — and so CodeQL's
// incomplete-url-substring-sanitization rule stays quiet.
function urlHostMatches(value, domain) {
  if (typeof value !== "string") return false;
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    return false;
  }
  return host === domain || host.endsWith(`.${domain}`);
}

describe("extractGeminiOauthClientCredentials", () => {
  it("finds OAuth constants from bundled Gemini CLI chunk files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-gemini-bundle-"));
    try {
      const root = path.join(tmp, "lib", "node_modules", "@google", "gemini-cli");
      const bundleDir = path.join(root, "bundle");
      fs.mkdirSync(bundleDir, { recursive: true });
      const geminiPath = path.join(bundleDir, "gemini.js");
      fs.writeFileSync(geminiPath, "#!/usr/bin/env node\n", "utf8");
      fs.writeFileSync(
        path.join(bundleDir, "chunk-test.js"),
        [
          'var OAUTH_CLIENT_ID = "client.apps.googleusercontent.com";',
          'var OAUTH_CLIENT_SECRET = "secret-value";',
        ].join("\n"),
        "utf8",
      );

      const result = await extractGeminiOauthClientCredentials({
        commandRunner(command, args) {
          assert.equal(command, "which");
          assert.deepEqual(args, ["gemini"]);
          return { status: 0, stdout: `${geminiPath}\n` };
        },
      });

      assert.deepEqual(result, {
        clientId: "client.apps.googleusercontent.com",
        clientSecret: "secret-value",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to nvm-installed Gemini when launchd PATH cannot find gemini", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-gemini-nvm-"));
    try {
      const home = path.join(tmp, "home");
      const root = path.join(home, ".nvm", "versions", "node", "v22.21.1");
      const binDir = path.join(root, "bin");
      const bundleDir = path.join(root, "lib", "node_modules", "@google", "gemini-cli", "bundle");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(bundleDir, { recursive: true });
      const geminiTarget = path.join(bundleDir, "gemini.js");
      const geminiLink = path.join(binDir, "gemini");
      fs.writeFileSync(geminiTarget, "#!/usr/bin/env node\n", "utf8");
      fs.symlinkSync("../lib/node_modules/@google/gemini-cli/bundle/gemini.js", geminiLink);
      fs.writeFileSync(
        path.join(bundleDir, "chunk-test.js"),
        [
          'var OAUTH_CLIENT_ID = "fallback-client.apps.googleusercontent.com";',
          'var OAUTH_CLIENT_SECRET = "fallback-secret";',
        ].join("\n"),
        "utf8",
      );

      const result = await extractGeminiOauthClientCredentials({
        home,
        commandRunner() {
          return { status: 1, stdout: "" };
        },
      });

      assert.deepEqual(result, {
        clientId: "fallback-client.apps.googleusercontent.com",
        clientSecret: "fallback-secret",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to the public Gemini CLI OAuth client when gemini-cli is not installed (issue #224)", async () => {
    // Reproduces the native-Antigravity ("agy") case: no `gemini` on PATH and
    // no gemini-cli bundle under home. Previously this returned null and the
    // token refresh threw "Could not find Gemini CLI OAuth configuration".
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-gemini-none-"));
    try {
      const home = path.join(tmp, "home");
      fs.mkdirSync(home, { recursive: true });

      const result = await extractGeminiOauthClientCredentials({
        home,
        commandRunner() {
          return { status: 1, stdout: "" };
        },
      });

      assert.ok(result, "expected a fallback credential, not null");
      assert.equal(
        result.clientId,
        "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
      );
      assert.ok(
        typeof result.clientSecret === "string" && result.clientSecret.length > 0,
        "expected a non-empty client secret",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("getUsageLimits gemini no-creds", () => {
  it("returns configured:false when no gemini credentials exist", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-gemini-none-"));
    try {
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() { return { status: 1, stdout: "" }; },
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl() { return new Promise(() => {}); },
      });

      assert.equal(result.gemini.configured, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stays configured when credentials exist but the gemini binary is not on PATH (issue #224)", async () => {
    // Regression: a `which gemini` guard must not hide the card for an
    // authenticated user on a minimal launchd PATH where `gemini` isn't found.
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-gemini-nobin-"));
    try {
      const geminiDir = path.join(tmp, ".gemini");
      fs.mkdirSync(geminiDir, { recursive: true });
      fs.writeFileSync(
        path.join(geminiDir, "oauth_creds.json"),
        JSON.stringify({ access_token: "tok", expiry_date: Date.now() + 3_600_000 }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() { return { status: 1, stdout: "" }; },
        commandRunner() { return { status: 1, stdout: "" }; }, // no `gemini` on PATH
        fetchImpl() { return Promise.resolve({ ok: false, status: 500, async json() { return {}; }, async text() { return ""; } }); },
      });

      assert.notEqual(result.gemini.configured, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function writeAntigravityOauthToken(tmp, token = {}) {
  const credPath = path.join(tmp, ".gemini", "jetski-standalone-oauth-token");
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(
    credPath,
    JSON.stringify({
      token: {
        access_token: "ya29.agy-live",
        refresh_token: "1//agy-refresh",
        expiry: "2099-01-01T00:00:00Z",
        token_type: "Bearer",
        ...token,
      },
      auth_method: "consumer",
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return credPath;
}

function antigravityQuotaSummaryPayload() {
  return {
    groups: [
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", remainingFraction: 0.58, resetTime: "2026-09-07T00:00:00Z" },
          { bucketId: "3p-5h", remainingFraction: 0.82, resetTime: "2026-08-31T10:00:00Z" },
        ],
      },
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-weekly", remainingFraction: 0.4, resetTime: "2026-09-07T00:00:00Z" },
          { bucketId: "gemini-5h", remainingFraction: 0.9, resetTime: "2026-08-31T10:00:00Z" },
        ],
      },
    ],
  };
}

function antigravityRemoteFetchImpl({
  quota = antigravityQuotaSummaryPayload(),
  refresh = { access_token: "ya29.agy-refreshed", expires_in: 3600 },
  load = { paidTier: { name: "Google AI Pro", id: "pro" } },
  quotaStatus = 200,
  calls = [],
} = {}) {
  return async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("oauth2.googleapis.com/token")) {
      return { ok: true, status: 200, async json() { return refresh; } };
    }
    if (href.includes("loadCodeAssist")) {
      return { ok: true, status: 200, async json() { return load; } };
    }
    if (href.includes("retrieveUserQuotaSummary")) {
      return {
        ok: quotaStatus === 200,
        status: quotaStatus,
        async json() { return quota; },
      };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };
}

describe("getUsageLimits antigravity cache", () => {
  it("reads remaining quota from Cloud Code when OAuth credentials exist", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-antigravity-remote-"));
    try {
      writeAntigravityOauthToken(tmp);
      const fetchCalls = [];
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() { return { status: 1, stdout: "" }; },
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl: antigravityRemoteFetchImpl({ calls: fetchCalls }),
      });

      assert.equal(result.antigravity.configured, true);
      assert.equal(result.antigravity.error, null);
      assert.equal(result.antigravity.cached, undefined);
      assert.equal(result.antigravity.primary_window.used_percent, 42);
      assert.equal(result.antigravity.secondary_window.used_percent, 18);
      assert.equal(result.antigravity.tertiary_window.used_percent, 60);
      assert.equal(result.antigravity.quaternary_window.used_percent, 10);
      assert.ok(fetchCalls.some((url) => urlHostMatches(url, "daily-cloudcode-pa.googleapis.com")));
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shows message when no language server, no credentials, and no cache", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-antigravity-noprocess-"));
    try {
      fs.mkdirSync(path.join(tmp, ".gemini", "antigravity-cli"), { recursive: true });

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() { return { status: 1, stdout: "" }; },
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl() { return new Promise(() => {}); },
      });

      assert.equal(result.antigravity.configured, true);
      assert.ok(result.antigravity.error.includes("not running"), `expected "not running" message, got: ${result.antigravity.error}`);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves cached data when no language server is running", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-antigravity-cache-"));
    try {
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(
        path.join(trackerDir, "usage-limits-cache.json"),
        JSON.stringify({
          antigravity: {
            primary_window: { used_percent: 42, reset_at: "2099-05-22T00:00:00.000Z" },
            cached_at: new Date(Date.now() - 60_000).toISOString(),
          },
        }),
        "utf8",
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() { return { status: 1, stdout: "" }; },
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl() { return new Promise(() => {}); },
      });

      assert.equal(result.antigravity.configured, true);
      assert.equal(result.antigravity.cached, true);
      assert.equal(result.antigravity.primary_window.used_percent, 42);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function makeFakeCodexJwt(planType) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_plan_type: planType },
    }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

function writeCodexAuth(tmp, planType = "plus", extraTokens = {}) {
  const codexHome = path.join(tmp, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: makeFakeCodexJwt(planType),
        id_token: makeFakeCodexJwt(planType),
        ...extraTokens,
      },
    }),
  );
}

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

function makeCopilotTestToken() {
  return ["gho", "1234567890abcdef1234567890abcdef1234"].join("_");
}

function copilotTokenHex(token = makeCopilotTestToken()) {
  return Buffer.from(token, "utf8").toString("hex");
}

describe("fetchCopilotLimits", () => {
  it("detects VS Code Copilot files under .copilot-otel", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-copilot-otel-status-"));
    try {
      const chatDir = path.join(tmp, ".copilot-otel");
      fs.mkdirSync(chatDir, { recursive: true });
      fs.writeFileSync(path.join(chatDir, "copilot.jsonl"), "", "utf8");

      const result = describeCopilotOtelStatus({ home: tmp, env: { HOME: tmp } });
      assert.equal(result.otel_has_files, true);
      assert.deepEqual(result.otel_default_dirs, [
        path.join(tmp, ".copilot", "otel"),
        chatDir,
      ]);
      assert.deepEqual(result.otel_detected_paths, [
        path.join(chatDir, "copilot.jsonl"),
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fetches Copilot limits with a schema-v0 auth.db token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-copilot-limits-v0-"));
    try {
      const token = makeCopilotTestToken();
      let observedAuthorization = "";
      const result = await fetchCopilotLimits({
        home: tmp,
        platform: "darwin",
        async sqliteReader() {
          await Promise.resolve();
          return [{
            auth_authority: "github.com",
            token_schema_version: 0,
            token_hex: copilotTokenHex(token),
          }];
        },
        securityRunner() {
          assert.fail("schema-v0 Copilot tokens must not require keychain access");
        },
        fetchImpl(url, options) {
          assert.equal(url, "https://api.github.com/copilot_internal/user");
          observedAuthorization = options?.headers?.Authorization || "";
          return Promise.resolve({
            ok: true,
            status: 200,
            async json() {
              return {
                copilot_plan: "individual",
                quota_reset_date: "2026-07-09",
                quota_snapshots: {
                  premium_interactions: {
                    entitlement: 100,
                    remaining: 75,
                    percent_remaining: 75,
                  },
                  chat: {
                    entitlement: 200,
                    remaining: 100,
                    percent_remaining: 50,
                  },
                },
              };
            },
          });
        },
      });

      assert.equal(observedAuthorization, `token ${token}`);
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.plan_name, "Individual");
      assert.equal(result.primary_window.used_percent, 25);
      assert.equal(result.primary_window.reset_at, "2026-07-09T00:00:00.000Z");
      assert.equal(result.secondary_window.used_percent, 50);
      assert.equal(result.secondary_window.reset_at, "2026-07-09T00:00:00.000Z");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not call the Copilot API for non-darwin encrypted auth.db rows", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-copilot-limits-linux-encrypted-"));
    try {
      let readerCalled = false;
      const result = await fetchCopilotLimits({
        home: tmp,
        platform: "linux",
        async sqliteReader() {
          readerCalled = true;
          return [{
            auth_authority: "github.com",
            token_schema_version: 1,
            token_hex: "00",
          }];
        },
        securityRunner() {
          assert.fail("non-darwin encrypted Copilot rows must not read keychain");
        },
        fetchImpl() {
          assert.fail("no token should mean no Copilot API request");
        },
      });

      assert.equal(readerCalled, true);
      assert.equal(result.configured, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

const CODEX_WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

function isCodexResetCreditsUrl(url) {
  return url === CODEX_RESET_CREDITS_URL;
}

function codexResetCreditsResponse(body = { available_count: null, total_earned_count: null, credits: [] }) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function pendingUnlessCodexReset(url) {
  if (isCodexResetCreditsUrl(url)) return codexResetCreditsResponse();
  return new Promise(() => {});
}

describe("getUsageLimits claude data-age fields (stale + cached_at)", () => {
  const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

  function writeClaudeCreds(home, token) {
    const dir = path.join(home, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    );
  }

  it("stamps a live Claude read with stale:false and a fresh cached_at", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-live-"));
    try {
      writeClaudeCreds(tmp, "sk-ant-oauth-live");
      const before = Date.now();
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() { return { status: 1, stdout: "" }; },
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl(url) {
          if (url === CLAUDE_USAGE_URL) {
            return Promise.resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: async () => ({
                five_hour: { utilization: 7, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
                seven_day: { utilization: 40, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
              }),
            });
          }
          return Promise.reject(new Error("unmocked"));
        },
      });

      assert.equal(result.claude.configured, true);
      assert.equal(result.claude.error, null);
      assert.equal(result.claude.stale, false, "a live read must be marked fresh");
      assert.ok(result.claude.cached_at, "live read must carry a cached_at stamp");
      const cachedMs = Date.parse(result.claude.cached_at);
      assert.ok(
        cachedMs >= before && cachedMs <= Date.now() + 1000,
        "cached_at must be stamped at fetch time",
      );
      assert.equal(
        result.claude.retry_at,
        undefined,
        "a successful live read clears the cooldown, so no retry_at is exposed",
      );
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves the disk cache with stale:true and its original cached_at when the live read 429s", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-stale-"));
    try {
      writeClaudeCreds(tmp, "sk-ant-oauth-stale");
      // Seed a last-successful snapshot ~1h old (older than the 10-min fresh TTL, so a
      // live call is still attempted) with a still-future reset (so the window stays usable).
      const cacheDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(cacheDir, { recursive: true });
      const seededCachedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      fs.writeFileSync(
        path.join(cacheDir, "claude-usage-limits-cache.json"),
        JSON.stringify({
          claude: {
            five_hour: { utilization: 55, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
            seven_day: null,
            seven_day_opus: null,
            weekly_scoped: null,
            extra_usage: null,
            cached_at: seededCachedAt,
          },
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() { return { status: 1, stdout: "" }; },
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl(url) {
          if (url === CLAUDE_USAGE_URL) {
            return Promise.resolve({
              ok: false,
              status: 429,
              headers: { get: (k) => (k === "retry-after" ? "3600" : null) },
              json: async () => ({}),
            });
          }
          return Promise.reject(new Error("unmocked"));
        },
      });

      assert.equal(result.claude.configured, true);
      assert.equal(result.claude.error, null, "stale cache must be served instead of a red error");
      assert.equal(result.claude.stale, true, "cache fallback must be marked stale");
      assert.equal(result.claude.cached_at, seededCachedAt, "stale read must preserve the original cached_at");
      assert.equal(result.claude.five_hour.utilization, 55);
      assert.ok(result.claude.retry_at, "an active cooldown must expose retry_at for the client");
      const retryMs = Date.parse(result.claude.retry_at);
      assert.ok(retryMs > Date.now(), "retry_at must be a future instant");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("getUsageLimits", () => {
  it("classifies a 5h session window into primary regardless of slot position", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-classify-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: makeFakeCodexJwt("plus"),
            id_token: makeFakeCodexJwt("plus"),
            account_id: "acc-classify",
          },
        }),
      );

      let observedHeader = null;
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url, opts) {
          if (url === CODEX_WHAM_USAGE_URL) {
            observedHeader = opts?.headers?.["ChatGPT-Account-Id"] || null;
            return Promise.resolve({
              ok: true,
              status: 200,
              // API delivers 7d in primary slot and 5h in secondary — sorter must swap them.
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 99999 },
                  secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 11111 },
                },
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(observedHeader, "acc-classify", "ChatGPT-Account-Id header must be sent");
      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.equal(result.codex.plan_type, "plus");
      assert.deepEqual(result.codex.primary_window, {
        used_percent: 12,
        limit_window_seconds: 18000,
        reset_at: 11111,
      });
      assert.deepEqual(result.codex.secondary_window, {
        used_percent: 30,
        limit_window_seconds: 604800,
        reset_at: 99999,
      });
      // A live read carries the data-age fields the UI uses for "Updated Xm ago".
      assert.equal(result.codex.stale, false, "a live Codex read must be marked fresh");
      assert.ok(result.codex.cached_at, "live Codex read must carry a cached_at stamp");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("renders free-tier weekly-only response into the secondary (7d) lane", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-free-weekly-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: makeFakeCodexJwt("free"),
            id_token: makeFakeCodexJwt("free"),
          },
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (url === CODEX_WHAM_USAGE_URL) {
            // Free plans get a single 7-day window in the primary slot.
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 8, limit_window_seconds: 604800, reset_at: 42 },
                  secondary_window: null,
                },
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.equal(result.codex.plan_type, "free");
      // No 5h session window for free — primary lane stays empty, weekly fills secondary.
      assert.equal(result.codex.primary_window, null);
      assert.deepEqual(result.codex.secondary_window, {
        used_percent: 8,
        limit_window_seconds: 604800,
        reset_at: 42,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parses Codex business spend controls into a credit window", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-business-credits-"));
    try {
      writeCodexAuth(tmp, "business", { account_id: "acc-business" });

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (url === CODEX_WHAM_USAGE_URL) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: null,
                spend_control: {
                  individual_limit: {
                    source: "group_based_spend_controls",
                    limit: "37500",
                    used: "51.03434884548187",
                    remaining: "37448.96565115452",
                    used_percent: 0,
                    remaining_percent: 100,
                    reset_after_seconds: 2670190,
                    reset_at: 1785542400,
                  },
                },
                additional_rate_limits: [
                  {
                    limit_name: "GPT-5.3-Codex-Spark-Preview",
                    metered_feature: "codex_bengalfox",
                    rate_limit: {
                      primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1782890210 },
                      secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1783477010 },
                    },
                  },
                ],
                rate_limit_reset_credits: { available_count: 0 },
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.equal(result.codex.plan_type, "business");
      assert.equal(result.codex.primary_window, null);
      assert.equal(result.codex.secondary_window, null);
      assert.equal(result.codex.credit_window.source, "group_based_spend_controls");
      assert.equal(result.codex.credit_window.reset_at, 1785542400);
      assert.equal(result.codex.credit_window.limit_credits, 37500);
      assert.equal(result.codex.credit_window.used_credits, 51.03434884548187);
      assert.equal(result.codex.credit_window.remaining_credits, 37448.96565115452);
      assert.ok(Math.abs(result.codex.credit_window.used_percent - 0.13609159692128498) < 1e-12);
      assert.ok(Math.abs(result.codex.credit_window.remaining_percent - 99.86390840307871) < 1e-12);
      assert.deepEqual(result.codex.spark_primary_window, {
        used_percent: 0,
        limit_window_seconds: 18000,
        reset_at: 1782890210,
      });
      assert.deepEqual(result.codex.spark_secondary_window, {
        used_percent: 0,
        limit_window_seconds: 604800,
        reset_at: 1783477010,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves the last successful Codex read from disk cache when a later fetch fails", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-stale-"));
    try {
      writeCodexAuth(tmp, "business", { account_id: "acc-business" });

      const ok = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (url === CODEX_WHAM_USAGE_URL) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1_900_000_000 },
                  secondary_window: { used_percent: 34, limit_window_seconds: 604800, reset_at: 1_900_600_000 },
                },
                spend_control: {
                  individual_limit: {
                    source: "group_based_spend_controls",
                    limit: "37500",
                    used: "220",
                    remaining: "37280",
                    reset_at: 1_900_000_000,
                  },
                },
                rate_limit_reset_credits: { available_count: 0 },
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });
      assert.equal(ok.codex.error, null);
      assert.equal(ok.codex.primary_window.used_percent, 12);
      assert.equal(ok.codex.credit_window.limit_credits, 37500);
      assert.notEqual(ok.codex.stale, true);

      // Drop the in-memory cache so the next call actually re-fetches and hits the failure branch.
      resetUsageLimitsCache();

      const failed = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (url === CODEX_WHAM_USAGE_URL) {
            return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
          }
          return pendingUnlessCodexReset(url);
        },
      });
      // Bars stay visible from disk cache instead of flipping to a red "timed out" error.
      assert.equal(failed.codex.configured, true);
      assert.equal(failed.codex.error, null);
      assert.equal(failed.codex.stale, true);
      assert.equal(failed.codex.primary_window.used_percent, 12);
      assert.equal(failed.codex.secondary_window.used_percent, 34);
      assert.equal(failed.codex.credit_window.limit_credits, 37500);
      assert.equal(failed.codex.plan_label, "Business");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("maps Codex Spark windows by duration when their slots are reversed", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-spark-reversed-"));
    try {
      writeCodexAuth(tmp, "plus", { account_id: "acc-spark-reversed" });

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 11111 },
                  secondary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 99999 },
                },
                additional_rate_limits: [
                  {
                    limit_name: "codex spark model",
                    rate_limit: {
                      primary_window: { used_percent: 18, limit_window_seconds: 604800, reset_at: 33333 },
                      secondary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 22222 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.deepEqual(result.codex.primary_window, {
        used_percent: 12,
        limit_window_seconds: 18000,
        reset_at: 11111,
      });
      assert.deepEqual(result.codex.secondary_window, {
        used_percent: 30,
        limit_window_seconds: 604800,
        reset_at: 99999,
      });
      assert.deepEqual(result.codex.spark_primary_window, {
        used_percent: 4,
        limit_window_seconds: 18000,
        reset_at: 22222,
      });
      assert.deepEqual(result.codex.spark_secondary_window, {
        used_percent: 18,
        limit_window_seconds: 604800,
        reset_at: 33333,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rounds fractional Codex and Spark usage percentages before exposing windows", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-fractional-"));
    try {
      writeCodexAuth(tmp, "plus");

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 12.4, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 30.6, limit_window_seconds: 604800, reset_at: 200 },
                },
                additional_rate_limits: [
                  {
                    limit_name: "codex spark model",
                    rate_limit: {
                      primary_window: { used_percent: 4.4, limit_window_seconds: 18000, reset_at: 300 },
                      secondary_window: { used_percent: 18.6, limit_window_seconds: 604800, reset_at: 400 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.codex.primary_window.used_percent, 12);
      assert.equal(result.codex.secondary_window.used_percent, 31);
      assert.equal(result.codex.spark_primary_window.used_percent, 4);
      assert.equal(result.codex.spark_secondary_window.used_percent, 19);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers classified Spark windows across all entries before slot fallback", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-spark-fallback-"));
    try {
      writeCodexAuth(tmp, "plus");

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 200 },
                },
                additional_rate_limits: [
                  {
                    metered_feature: "  Codex Spark Requests  ",
                    rate_limit: {
                      primary_window: { used_percent: 7, limit_window_seconds: 12345, reset_at: 300 },
                      secondary_window: { used_percent: 19, reset_at: 400 },
                    },
                  },
                  {
                    limit_name: "spark duplicate",
                    rate_limit: {
                      primary_window: { used_percent: 99, limit_window_seconds: 18000, reset_at: 500 },
                      secondary_window: { used_percent: 88, limit_window_seconds: 604800, reset_at: 600 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.deepEqual(result.codex.spark_primary_window, {
        used_percent: 99,
        limit_window_seconds: 18000,
        reset_at: 500,
      });
      assert.deepEqual(result.codex.spark_secondary_window, {
        used_percent: 88,
        limit_window_seconds: 604800,
        reset_at: 600,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not let an unknown Spark window override a classified 5h window", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-spark-mixed-"));
    try {
      writeCodexAuth(tmp, "plus");

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 200 },
                },
                additional_rate_limits: [
                  {
                    limit_name: "codex spark model",
                    rate_limit: {
                      primary_window: { used_percent: 90, limit_window_seconds: 12345, reset_at: 300 },
                      secondary_window: { used_percent: 15, limit_window_seconds: 18000, reset_at: 400 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.deepEqual(result.codex.spark_primary_window, {
        used_percent: 15,
        limit_window_seconds: 18000,
        reset_at: 400,
      });
      assert.equal(result.codex.spark_secondary_window, null);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fills a missing Spark weekly slot from position when the secondary window is classified 5h", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-spark-primary-fallback-"));
    try {
      writeCodexAuth(tmp, "plus");

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 200 },
                },
                additional_rate_limits: [
                  {
                    limit_name: "codex spark model",
                    rate_limit: {
                      primary_window: { used_percent: 44, reset_at: 300 },
                      secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 400 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.deepEqual(result.codex.spark_primary_window, {
        used_percent: 12,
        limit_window_seconds: 18000,
        reset_at: 400,
      });
      assert.deepEqual(result.codex.spark_secondary_window, {
        used_percent: 44,
        reset_at: 300,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fills an empty Spark slot from position when the other window is classified", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-spark-mixed-fallback-"));
    try {
      writeCodexAuth(tmp, "plus");

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 200 },
                },
                additional_rate_limits: [
                  {
                    limit_name: "codex spark model",
                    rate_limit: {
                      primary_window: { used_percent: 11, reset_at: 300 },
                      secondary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: 400 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.deepEqual(result.codex.spark_primary_window, {
        used_percent: 11,
        reset_at: 300,
      });
      assert.deepEqual(result.codex.spark_secondary_window, {
        used_percent: 25,
        limit_window_seconds: 604800,
        reset_at: 400,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps a lone unknown Spark secondary window in the weekly lane", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-spark-secondary-only-"));
    try {
      writeCodexAuth(tmp, "plus");

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 200 },
                },
                additional_rate_limits: [
                  {
                    limit_name: "codex spark model",
                    rate_limit: {
                      primary_window: null,
                      secondary_window: { used_percent: 37, reset_at: 300 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.codex.spark_primary_window, null);
      assert.deepEqual(result.codex.spark_secondary_window, {
        used_percent: 37,
        reset_at: 300,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps an unknown secondary Spark window as 5h when paired with a classified weekly window", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-spark-weekly-unknown-"));
    try {
      writeCodexAuth(tmp, "plus");

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 200 },
                },
                additional_rate_limits: [
                  {
                    limit_name: "codex spark model",
                    rate_limit: {
                      primary_window: { used_percent: 31, limit_window_seconds: 604800, reset_at: 300 },
                      secondary_window: { used_percent: 12, limit_window_seconds: 32400, reset_at: 400 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.deepEqual(result.codex.spark_primary_window, {
        used_percent: 12,
        limit_window_seconds: 32400,
        reset_at: 400,
      });
      assert.deepEqual(result.codex.spark_secondary_window, {
        used_percent: 31,
        limit_window_seconds: 604800,
        reset_at: 300,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores malformed Spark windows before exposing Codex usage limits", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-spark-malformed-"));
    try {
      writeCodexAuth(tmp, "plus");

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 200 },
                },
                additional_rate_limits: [
                  {
                    limit_name: "codex spark broken",
                    rate_limit: {
                      primary_window: { limit_window_seconds: 18000, reset_at: 300 },
                      secondary_window: {},
                    },
                  },
                  {
                    limit_name: "codex spark valid",
                    rate_limit: {
                      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 500 },
                      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 600 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.deepEqual(result.codex.spark_primary_window, {
        used_percent: 25,
        limit_window_seconds: 18000,
        reset_at: 500,
      });
      assert.deepEqual(result.codex.spark_secondary_window, {
        used_percent: 40,
        limit_window_seconds: 604800,
        reset_at: 600,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores non-Spark additional rate limits and keeps Spark windows null", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-non-spark-"));
    try {
      writeCodexAuth(tmp, "plus");

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 11, limit_window_seconds: 18000, reset_at: 700 },
                  secondary_window: { used_percent: 22, limit_window_seconds: 604800, reset_at: 800 },
                },
                additional_rate_limits: [
                  null,
                  "bad-entry",
                  {
                    limit_name: "codex regular model",
                    metered_feature: "codex_model",
                    rate_limit: {
                      primary_window: { used_percent: 77, limit_window_seconds: 18000, reset_at: 900 },
                      secondary_window: { used_percent: 66, limit_window_seconds: 604800, reset_at: 1000 },
                    },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.deepEqual(result.codex.primary_window, {
        used_percent: 11,
        limit_window_seconds: 18000,
        reset_at: 700,
      });
      assert.deepEqual(result.codex.secondary_window, {
        used_percent: 22,
        limit_window_seconds: 604800,
        reset_at: 800,
      });
      assert.equal(result.codex.spark_primary_window, null);
      assert.equal(result.codex.spark_secondary_window, null);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses fresh Codex token for usage and reset list after stale refresh", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-refresh-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      const authPath = path.join(codexHome, "auth.json");
      // Write an auth.json whose last_refresh is >8 days old → must be refreshed.
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: makeFakeCodexJwt("plus"),
            id_token: makeFakeCodexJwt("plus"),
            refresh_token: "rt-stale",
            account_id: "acc-stale",
          },
          last_refresh: "2026-01-01T00:00:00Z",
        }),
      );

      let refreshCalled = false;
      let whamAuthHeader = null;
      let listAuthHeader = null;
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url, opts) {
          if (typeof url === "string" && url.includes("auth.openai.com/oauth/token")) {
            refreshCalled = true;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                access_token: "fresh-access",
                refresh_token: "fresh-refresh",
                id_token: "fresh-id",
              }),
            });
          }
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/usage")) {
            whamAuthHeader = opts?.headers?.Authorization || null;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 },
                  secondary_window: { used_percent: 9, limit_window_seconds: 604800, reset_at: 200 },
                },
              }),
            });
          }
          if (typeof url === "string" && url.includes("chatgpt.com/backend-api/wham/rate-limit-reset-credits")) {
            listAuthHeader = opts?.headers?.Authorization || null;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                available_count: 1,
                total_earned_count: 1,
                credits: [
                  {
                    status: "available",
                    reset_type: "codex_rate_limits",
                    expires_at: "2099-02-01T00:00:00Z",
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(refreshCalled, true, "refresh endpoint must be called when token is stale");
      assert.equal(whamAuthHeader, "Bearer fresh-access", "wham must use the new token");
      assert.equal(listAuthHeader, "Bearer fresh-access", "reset list must use the new token");
      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.deepEqual(result.codex.primary_window, { used_percent: 1, limit_window_seconds: 18000, reset_at: 100 });

      // Persisted auth.json gets the new tokens + a fresh last_refresh.
      const updated = JSON.parse(fs.readFileSync(authPath, "utf8"));
      assert.equal(updated.tokens.access_token, "fresh-access");
      assert.equal(updated.tokens.refresh_token, "fresh-refresh");
      assert.notEqual(updated.last_refresh, "2026-01-01T00:00:00Z");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces a reauth-required error when the refresh token itself is expired", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-reauth-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: makeFakeCodexJwt("plus"),
            refresh_token: "rt-dead",
          },
          last_refresh: "2026-01-01T00:00:00Z",
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url.includes("auth.openai.com/oauth/token")) {
            return Promise.resolve({
              ok: false,
              status: 401,
              json: async () => ({ error: { code: "refresh_token_expired" } }),
            });
          }
          if (url === CODEX_WHAM_USAGE_URL) {
            return Promise.resolve({
              ok: false,
              status: 401,
              json: async () => ({}),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.auth_action_required, "reauth");
      assert.match(result.codex.error, /Run `codex login` to re-authenticate/);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses live Codex usage when refresh fails but the access token remains valid", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-codex-valid-access-"));
    try {
      const codexHome = path.join(tmp, ".codex");
      const accessToken = makeFakeCodexJwt("plus");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: accessToken,
            id_token: accessToken,
            refresh_token: "rt-dead-valid-access",
            account_id: "acc-valid-access",
          },
          last_refresh: "2026-01-01T00:00:00Z",
        }),
      );

      let whamAuthHeader = null;
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner: inactiveRunner,
        commandRunner: inactiveRunner,
        fetchImpl(url, options) {
          if (url === "https://auth.openai.com/oauth/token") {
            return Promise.resolve({
              ok: false,
              status: 401,
              json: async () => ({ error: { code: "refresh_token_expired" } }),
            });
          }
          if (url === CODEX_WHAM_USAGE_URL) {
            whamAuthHeader = options?.headers?.Authorization || null;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                rate_limit: {
                  primary_window: {
                    used_percent: 12,
                    limit_window_seconds: 604800,
                    reset_at: 1_900_000_000,
                  },
                  secondary_window: null,
                },
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(whamAuthHeader, `Bearer ${accessToken}`);
      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.equal(result.codex.auth_action_required, undefined);
      assert.equal(result.codex.primary_window, null);
      assert.deepEqual(result.codex.secondary_window, {
        used_percent: 12,
        limit_window_seconds: 604800,
        reset_at: 1_900_000_000,
      });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves cached Claude windows with a reauth flag when the OAuth token is expired", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-reauth-cache-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "expired-token" } }),
      );
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      const futureReset = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
      fs.writeFileSync(
        path.join(trackerDir, "claude-usage-limits-cache.json"),
        JSON.stringify({
          claude: {
            five_hour: { utilization: 41, resets_at: futureReset },
            seven_day: { utilization: 63, resets_at: futureReset },
            seven_day_opus: null,
            weekly_scoped: null,
            extra_usage: null,
            cached_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          },
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        forceRefresh: true,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            return Promise.resolve({ ok: false, status: 401 });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      // The cached bars stay visible, but the client is told why they stopped updating.
      assert.equal(result.claude.error, null);
      assert.equal(result.claude.stale, true);
      assert.deepEqual(result.claude.five_hour, { utilization: 41, resets_at: futureReset });
      assert.equal(result.claude.auth_action_required, "reauth");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces the token-expired error with a reauth flag when no Claude cache exists", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-reauth-nocache-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "expired-token" } }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            return Promise.resolve({ ok: false, status: 401 });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.claude.configured, true);
      assert.match(result.claude.error, /token expired/i);
      assert.equal(result.claude.auth_action_required, "reauth");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags reauth when the credential entry exists but its token fields are blank", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-blank-token-"));
    try {
      // What an expired Claude Code login actually leaves behind: the entry survives,
      // the secrets are emptied in place.
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "",
            refreshToken: "",
            expiresAt: 0,
            subscriptionType: "max",
          },
        }),
      );

      // Throwing alone proves nothing here: provider failures are collected with
      // allSettled and this branch never reads claudeResult, so a forbidden call
      // would be swallowed. Track it and assert it never happened.
      let usageApiCalled = false;
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            usageApiCalled = true;
            throw new Error("must not call the usage API without a token");
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.claude.configured, true);
      assert.match(result.claude.error, /token expired/i);
      assert.equal(result.claude.auth_action_required, "reauth");
      assert.equal(usageApiCalled, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stays unconfigured when no Claude credential entry exists at all", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-no-creds-"));
    try {
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl: pendingUnlessCodexReset,
      });

      assert.equal(result.claude.configured, false);
      assert.equal(result.claude.auth_action_required, undefined);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const status of [401, 403, 404]) {
    it(`Codex reset headers do not fetch reset list when wham ${status} returns no-data`, async () => {
      resetUsageLimitsCache();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `tokentracker-limits-codex-${status}-`));
      try {
        const codexHome = path.join(tmp, ".codex");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(
          path.join(codexHome, "auth.json"),
          JSON.stringify({ tokens: { access_token: "opaque-token" } }),
        );

        const calls = [];
        const result = await getUsageLimits({
          home: tmp,
          platform: "linux",
          providerTimeoutMs: 1000,
          securityRunner() {
            return { status: 1, stdout: "" };
          },
          commandRunner() {
            return { status: 1, stdout: "" };
          },
          fetchImpl(url) {
            if (url === CODEX_WHAM_USAGE_URL) {
              calls.push(url);
              return Promise.resolve({ ok: false, status, json: async () => ({}) });
            }
            if (url === CODEX_RESET_CREDITS_URL) {
              calls.push(url);
              throw new Error("reset list must not be called after wham no-data");
            }
            return pendingUnlessCodexReset(url);
          },
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0], CODEX_WHAM_USAGE_URL);
        assert.equal(result.codex.configured, true);
        assert.equal(result.codex.error, null);
        assert.equal(result.codex.primary_window, null);
        assert.equal(result.codex.secondary_window, null);
        assert.equal(result.codex.spark_primary_window, null);
        assert.equal(result.codex.spark_secondary_window, null);
      } finally {
        resetUsageLimitsCache();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it("reads the Claude OAuth access token from ~/.claude/.credentials.json on Linux", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-linux-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "linux-claude-token",
            subscriptionType: "max",
            rateLimitTier: "tier-1",
          },
        }),
      );

      let observedAuth = null;
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          // No keychain on Linux; if the macOS path is taken by mistake this would be the wrong token.
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url, opts) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            observedAuth = opts?.headers?.Authorization || null;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                five_hour: { utilization: 0.4 },
                seven_day: { utilization: 0.12 },
                seven_day_opus: null,
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(observedAuth, "Bearer linux-claude-token");
      assert.equal(result.claude.configured, true);
      assert.equal(result.claude.error, null);
      assert.deepEqual(result.claude.five_hour, { utilization: 0.4 });
      assert.deepEqual(result.claude.seven_day, { utilization: 0.12 });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("extracts Claude model-scoped weekly windows from the generic limits array", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-scoped-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "scoped-claude-token" } }),
      );
      const resetsAt = new Date(Date.now() + 3 * 86400 * 1000).toISOString();

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                five_hour: { utilization: 42, resets_at: resetsAt },
                seven_day: { utilization: 5, resets_at: resetsAt },
                seven_day_opus: null,
                limits: [
                  { kind: "session", group: "session", percent: 42, resets_at: resetsAt, scope: null },
                  { kind: "weekly_all", group: "weekly", percent: 5, resets_at: resetsAt, scope: null },
                  {
                    kind: "weekly_scoped",
                    group: "weekly",
                    percent: 8,
                    resets_at: resetsAt,
                    scope: { model: { id: null, display_name: "Fable" }, surface: null },
                  },
                  // No usable label → dropped.
                  { kind: "weekly_scoped", group: "weekly", percent: 3, resets_at: resetsAt, scope: { model: { id: null, display_name: null } } },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.claude.error, null);
      assert.deepEqual(result.claude.weekly_scoped, [
        { label: "Fable", utilization: 8, resets_at: resetsAt },
      ]);
      // The scoped window must survive the disk-cache round trip.
      const cachePath = path.join(tmp, ".tokentracker", "tracker", "claude-usage-limits-cache.json");
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      assert.deepEqual(cached.claude.weekly_scoped, [
        { label: "Fable", utilization: 8, resets_at: resetsAt },
      ]);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("drops a scoped weekly entry that duplicates a populated seven_day_opus window", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-scoped-opus-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "scoped-opus-token" } }),
      );
      const resetsAt = new Date(Date.now() + 3 * 86400 * 1000).toISOString();

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                five_hour: { utilization: 10, resets_at: resetsAt },
                seven_day: { utilization: 20, resets_at: resetsAt },
                seven_day_opus: { utilization: 30, resets_at: resetsAt },
                limits: [
                  {
                    kind: "weekly_scoped",
                    group: "weekly",
                    percent: 30,
                    resets_at: resetsAt,
                    scope: { model: { id: null, display_name: "Opus" }, surface: null },
                  },
                  {
                    kind: "weekly_scoped",
                    group: "weekly",
                    percent: 8,
                    resets_at: resetsAt,
                    scope: { model: { id: null, display_name: "Fable" }, surface: null },
                  },
                ],
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.claude.error, null);
      assert.deepEqual(result.claude.seven_day_opus, { utilization: 30, resets_at: resetsAt });
      assert.deepEqual(result.claude.weekly_scoped, [
        { label: "Fable", utilization: 8, resets_at: resetsAt },
      ]);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves cached scoped weekly windows but drops entries whose reset has passed", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-scoped-cache-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "scoped-cache-token" } }),
      );
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      const futureReset = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
      const pastReset = new Date(Date.now() - 3600 * 1000).toISOString();
      // Fresh cache (within the 10-minute TTL) short-circuits the upstream call.
      fs.writeFileSync(
        path.join(trackerDir, "claude-usage-limits-cache.json"),
        JSON.stringify({
          claude: {
            five_hour: { utilization: 12, resets_at: futureReset },
            seven_day: { utilization: 34, resets_at: futureReset },
            seven_day_opus: null,
            weekly_scoped: [
              { label: "Fable", utilization: 8, resets_at: futureReset },
              { label: "Stale Model", utilization: 90, resets_at: pastReset },
            ],
            extra_usage: null,
            cached_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          },
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            throw new Error("fresh cache must short-circuit the Claude usage call");
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.claude.error, null);
      assert.deepEqual(result.claude.weekly_scoped, [
        { label: "Fable", utilization: 8, resets_at: futureReset },
      ]);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bypasses the fresh cache and fetches live once a cached window crosses its reset boundary", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-reset-cross-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "reset-cross-token" } }),
      );
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      const futureReset = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
      // Snapshot written 5 minutes ago (well inside the 10-minute fresh TTL) whose
      // 5h window was due to reset 1 minute ago — the reset was still ahead at
      // write time, so it has since crossed the boundary.
      const crossedReset = new Date(Date.now() - 60 * 1000).toISOString();
      fs.writeFileSync(
        path.join(trackerDir, "claude-usage-limits-cache.json"),
        JSON.stringify({
          claude: {
            five_hour: { utilization: 97, resets_at: crossedReset },
            seven_day: { utilization: 34, resets_at: futureReset },
            seven_day_opus: null,
            weekly_scoped: null,
            extra_usage: null,
            cached_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          },
        }),
      );

      const freshFiveHourReset = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
      let upstreamCalled = false;
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            upstreamCalled = true;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                five_hour: { utilization: 2, resets_at: freshFiveHourReset },
                seven_day: { utilization: 34, resets_at: futureReset },
                seven_day_opus: null,
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(upstreamCalled, true, "crossed reset must force a live Claude call");
      assert.equal(result.claude.error, null);
      // The live post-rollover window is served, not the stale pre-reset snapshot.
      assert.deepEqual(result.claude.five_hour, { utilization: 2, resets_at: freshFiveHourReset });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps serving the fresh cache when a cached reset was already past at write time", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-stale-stamp-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "stale-stamp-token" } }),
      );
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      const futureReset = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
      // The reset was already in the past when the snapshot was written — a
      // provider stamping stale reset times must not defeat the fresh TTL and
      // force a live call on every poll.
      fs.writeFileSync(
        path.join(trackerDir, "claude-usage-limits-cache.json"),
        JSON.stringify({
          claude: {
            five_hour: { utilization: 12, resets_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
            seven_day: { utilization: 34, resets_at: futureReset },
            seven_day_opus: null,
            weekly_scoped: null,
            extra_usage: null,
            cached_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          },
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            throw new Error("already-past reset stamps must not bypass the fresh cache");
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.claude.error, null);
      assert.deepEqual(result.claude.seven_day, { utilization: 34, resets_at: futureReset });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads the Claude OAuth access token from %USERPROFILE%\\.claude\\.credentials.json on Windows", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-win32-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "win32-claude-token",
            subscriptionType: "max",
            rateLimitTier: "tier-1",
          },
        }),
      );

      let observedAuth = null;
      const result = await getUsageLimits({
        home: tmp,
        platform: "win32",
        providerTimeoutMs: 1000,
        securityRunner() {
          // No keychain on Windows; if the macOS path is taken by mistake this would be the wrong token.
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url, opts) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            observedAuth = opts?.headers?.Authorization || null;
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                five_hour: { utilization: 0.4 },
                seven_day: { utilization: 0.12 },
                seven_day_opus: null,
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(observedAuth, "Bearer win32-claude-token");
      assert.equal(result.claude.configured, true);
      assert.equal(result.claude.error, null);
      assert.deepEqual(result.claude.five_hour, { utilization: 0.4 });
      assert.deepEqual(result.claude.seven_day, { utilization: 0.12 });
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports Claude unconfigured on Linux when the credentials file is missing", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-linux-missing-"));
    try {
      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl() {
          return new Promise(() => {});
        },
      });

      assert.equal(result.claude.configured, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not block the whole response when Claude usage hangs", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-timeout-"));
    try {
      const started = Date.now();
      const result = await getUsageLimits({
        home: tmp,
        platform: "darwin",
        providerTimeoutMs: 10,
        securityRunner() {
          return {
            status: 0,
            stdout: JSON.stringify({ claudeAiOauth: { accessToken: "claude-token" } }),
          };
        },
        commandRunner(command) {
          if (command === "/bin/ps") return { status: 1, stdout: "" };
          return { status: 1, stdout: "" };
        },
        fetchImpl() {
          return new Promise(() => {});
        },
      });

      assert.ok(Date.now() - started < 500);
      assert.equal(result.claude.configured, true);
      assert.match(result.claude.error, /Claude usage request timed out/);
      assert.equal(result.codex.configured, false);
      assert.equal(result.gemini.configured, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not wait for Claude 429 retry delays on limits page refresh", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-429-"));
    try {
      const urls = [];
      const result = await getUsageLimits({
        home: tmp,
        platform: "darwin",
        providerTimeoutMs: 1000,
        securityRunner() {
          return {
            status: 0,
            stdout: JSON.stringify({ claudeAiOauth: { accessToken: "claude-token" } }),
          };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          urls.push(url);
          return Promise.resolve({
            status: 429,
            ok: false,
            headers: { get: () => "30" },
          });
        },
      });

      // Claude is the only provider this test cares about; the rest of the
      // fetchImpl calls come from other providers that get scheduled in
      // parallel (notably OpenCode Go when OPENCODE_GO_WORKSPACE_ID is set
      // in the test env, e.g. the dev's local .env.local).
      const claudeCalls = urls.filter((u) => urlHostMatches(u, "anthropic.com"));
      assert.equal(claudeCalls.length, 1);
      assert.equal(result.claude.configured, true);
      assert.match(result.claude.error, /rate limited/);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not block the whole response when Kimi usage hangs", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-kimi-timeout-"));
    try {
      const kimiHome = path.join(tmp, ".kimi");
      fs.mkdirSync(path.join(kimiHome, "credentials"), { recursive: true });
      fs.writeFileSync(path.join(kimiHome, "config.toml"), 'default_model = "kimi-code/kimi-for-coding"\n');
      fs.writeFileSync(
        path.join(kimiHome, "credentials", "kimi-code.json"),
        JSON.stringify({ access_token: "kimi-token" }),
      );

      const started = Date.now();
      const result = await getUsageLimits({
        home: tmp,
        platform: "darwin",
        providerTimeoutMs: 10,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl() {
          return new Promise(() => {});
        },
      });

      assert.ok(Date.now() - started < 500);
      assert.equal(result.kimi.configured, true);
      assert.match(result.kimi.error, /Kimi usage request timed out/);
      assert.equal(result.claude.configured, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refreshes expired Kimi credentials before fetching usage limits", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-kimi-refresh-"));
    try {
      const kimiHome = path.join(tmp, ".kimi");
      const credsPath = path.join(kimiHome, "credentials", "kimi-code.json");
      fs.mkdirSync(path.dirname(credsPath), { recursive: true });
      fs.writeFileSync(path.join(kimiHome, "config.toml"), 'default_model = "kimi-code/kimi-for-coding"\n');
      fs.writeFileSync(
        credsPath,
        JSON.stringify({
          access_token: "expired-kimi-token",
          refresh_token: "refresh-kimi-token",
          expires_at: 1,
          scope: "kimi-code",
          token_type: "Bearer",
          expires_in: 900,
        }),
      );

      const calls = [];
      const result = await getUsageLimits({
        home: tmp,
        platform: "darwin",
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url, options = {}) {
          calls.push({ url, authorization: options.headers?.Authorization || null, body: String(options.body || "") });
          if (url === "https://auth.kimi.com/api/oauth/token") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                access_token: "fresh-kimi-token",
                refresh_token: "fresh-refresh-token",
                expires_in: 900,
                scope: "kimi-code",
                token_type: "Bearer",
              }),
            });
          }
          if (url === "https://api.kimi.com/coding/v1/usages") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                usage: { used: 4, limit: 10, resetTime: "2026-05-04T06:02:56.054Z" },
              }),
            });
          }
          return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
        },
      });

      // Other providers (e.g. OpenCode Go when OPENCODE_GO_WORKSPACE_ID is
      // set in the test process env) may schedule their own fetchImpl calls
      // in parallel; pick the Kimi ones by URL so the assertions don't
      // depend on Promise.all slot order.
      const kimiCalls = calls.filter((c) => urlHostMatches(c.url, "kimi.com"));
      assert.equal(kimiCalls[0].url, "https://auth.kimi.com/api/oauth/token");
      assert.match(kimiCalls[0].body, /grant_type=refresh_token/);
      assert.match(kimiCalls[0].body, /refresh_token=refresh-kimi-token/);
      assert.equal(kimiCalls[1].authorization, "Bearer fresh-kimi-token");
      assert.equal(result.kimi.error, null);
      assert.equal(result.kimi.primary_window.used_percent, 40);

      const saved = JSON.parse(fs.readFileSync(credsPath, "utf8"));
      assert.equal(saved.access_token, "fresh-kimi-token");
      assert.equal(saved.refresh_token, "fresh-refresh-token");
      assert.ok(saved.expires_at > Date.now() / 1000);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadKimiCredentials", () => {
  it("returns null when Kimi credentials are absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kimi-missing-"));
    try {
      assert.equal(loadKimiCredentials({ home: tmp }), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("normalizeKimiUsageResponse", () => {
  it("maps weekly, 5h, total, and parallel quota windows", () => {
    const result = normalizeKimiUsageResponse({
      usage: {
        limit: "100",
        used: "64",
        remaining: "36",
        resetTime: "2026-05-04T06:02:56.054721Z",
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "100",
            used: "4",
            remaining: "96",
            resetTime: "2026-05-02T05:02:56.054721Z",
          },
        },
      ],
      parallel: { limit: "20" },
      totalQuota: { limit: "100", remaining: "99" },
      user: { membership: { level: "LEVEL_INTERMEDIATE" } },
      subType: "TYPE_PURCHASE",
    });

    assert.equal(result.membership_level, "LEVEL_INTERMEDIATE");
    assert.equal(result.subscription_type, "TYPE_PURCHASE");
    assert.equal(result.parallel_limit, 20);
    assert.deepEqual(result.primary_window, {
      used_percent: 64,
      reset_at: "2026-05-04T06:02:56.054Z",
    });
    assert.deepEqual(result.secondary_window, {
      used_percent: 4,
      reset_at: "2026-05-02T05:02:56.054Z",
    });
    assert.deepEqual(result.tertiary_window, {
      used_percent: 1,
      reset_at: null,
    });
  });

  it("returns null windows for invalid or zero limits", () => {
    const result = normalizeKimiUsageResponse({
      usage: { limit: "0", used: "12", remaining: "0" },
      limits: [{ detail: { limit: "bad", used: "1" } }],
      totalQuota: { limit: "0", remaining: "0" },
    });

    assert.equal(result.primary_window, null);
    assert.equal(result.secondary_window, null);
    assert.equal(result.tertiary_window, null);
    assert.equal(result.parallel_limit, null);
  });
});

describe("normalizeCursorUsageSummary", () => {
  it("preserves the exact billing-cycle duration for pace markers (#445)", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleStart: "2026-08-04T03:32:21.000Z",
      billingCycleEnd: "2026-09-04T03:32:21.000Z",
      membershipType: "pro",
      individualUsage: {
        plan: {
          totalPercentUsed: 42.4,
          autoPercentUsed: 31.2,
          apiPercentUsed: 78.9,
        },
      },
    });

    const expectedSeconds = 31 * 24 * 60 * 60;
    assert.equal(result.primary_window.limit_window_seconds, expectedSeconds);
    assert.equal(result.secondary_window.limit_window_seconds, expectedSeconds);
    assert.equal(result.tertiary_window.limit_window_seconds, expectedSeconds);
  });

  it("maps total, auto, and api windows from usage-summary", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-04-30T00:00:00.000Z",
      membershipType: "pro",
      individualUsage: {
        plan: {
          totalPercentUsed: 42.4,
          autoPercentUsed: 31.2,
          apiPercentUsed: 78.9,
        },
      },
    });

    assert.equal(result.membership_type, "pro");
    assert.deepEqual(result.primary_window, {
      used_percent: 42.4,
      reset_at: "2026-04-30T00:00:00.000Z",
    });
    assert.deepEqual(result.secondary_window, {
      used_percent: 31.2,
      reset_at: "2026-04-30T00:00:00.000Z",
    });
    assert.deepEqual(result.tertiary_window, {
      used_percent: 78.9,
      reset_at: "2026-04-30T00:00:00.000Z",
    });
  });

  it("falls back to used/limit when total percent is missing", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-04-30T00:00:00.000Z",
      individualUsage: {
        plan: {
          used: 250,
          limit: 1000,
        },
      },
    });

    assert.equal(result.primary_window.used_percent, 25);
    assert.equal(result.secondary_window, null);
    assert.equal(result.tertiary_window, null);
  });

  it("prefers auto/api percent lanes over raw plan cents when both exist", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-04-30T00:00:00.000Z",
      individualUsage: {
        plan: {
          used: 1,
          limit: 1_000_000,
          autoPercentUsed: 40,
          apiPercentUsed: 60,
        },
      },
    });

    assert.equal(result.primary_window.used_percent, 50);
    assert.equal(result.secondary_window.used_percent, 40);
    assert.equal(result.tertiary_window.used_percent, 60);
  });

  it("maps team onDemand when individual plan has no usable headline", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-04-30T00:00:00.000Z",
      membershipType: "team",
      individualUsage: {},
      teamUsage: {
        onDemand: { used: 5000, limit: 10000 },
      },
    });

    assert.equal(result.primary_window.used_percent, 50);
  });

  it("uses team onDemand when enterprise individual lanes are 0% but pool has usage", () => {
    const result = normalizeCursorUsageSummary({
      billingCycleEnd: "2026-05-04T03:32:21.000Z",
      membershipType: "enterprise",
      limitType: "team",
      individualUsage: {
        plan: {
          enabled: true,
          used: 0,
          limit: 2000,
          totalPercentUsed: 0,
          autoPercentUsed: 0,
          apiPercentUsed: 0,
        },
        onDemand: { enabled: true, used: 0, limit: null },
      },
      teamUsage: {
        onDemand: { enabled: true, used: 1655, limit: 630000 },
      },
    });

    assert.ok(result.primary_window.used_percent > 0);
    assert.ok(result.primary_window.used_percent < 1);
  });
});

describe("normalizeCursorSandUsageStatus", () => {
  it("maps the official Grok Bot period to an independent exact-duration window", () => {
    const result = normalizeCursorSandUsageStatus({
      currentPeriodStart: "2026-08-26T17:22:03.913Z",
      nextResetAt: "2026-08-31T10:37:44.547Z",
      usagePercent: 0,
      includedLimitZero: false,
      hasNonZeroIncludedLimit: true,
    });

    assert.deepEqual(result, {
      used_percent: 0,
      reset_at: "2026-08-31T10:37:44.547Z",
      limit_window_seconds: 407741,
    });
  });

  it("hides Grok Bot for ineligible accounts", () => {
    assert.equal(normalizeCursorSandUsageStatus({
      currentPeriodStart: "2026-08-25T00:00:00.000Z",
      nextResetAt: "2026-09-01T00:00:00.000Z",
      usagePercent: 10,
    }, { eligible: false }), null);
  });

  it("hides zero-limit and malformed responses without fabricating a quota", () => {
    assert.equal(normalizeCursorSandUsageStatus({
      nextResetAt: "2026-09-01T00:00:00.000Z",
      usagePercent: 10,
      includedLimitZero: true,
    }), null);
    assert.equal(normalizeCursorSandUsageStatus({ usagePercent: 10 }), null);
    assert.equal(normalizeCursorSandUsageStatus({
      nextResetAt: "2026-09-01T00:00:00.000Z",
      usagePercent: "unknown",
    }), null);
  });
});

describe("parseKiroUsageOutput", () => {
  const now = new Date("2026-04-03T00:00:00.000Z");

  it("parses legacy usage output with bonus credits", () => {
    const output = `
\u001b[32m┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\u001b[0m
┃                                                          | KIRO FREE      ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ Monthly credits:                                                          ┃
┃ ████████████████████████████████████████████████████████ 100% (resets on 01/01) ┃
┃                              (0.00 of 50 covered in plan)                 ┃
┃ Bonus credits:                                                            ┃
┃ 0.00/100 credits used, expires in 88 days                                 ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`;

    const result = parseKiroUsageOutput(output, { now });

    assert.equal(result.plan_name, "KIRO FREE");
    assert.equal(result.primary_window.used_percent, 100);
    assert.equal(result.primary_window.reset_at, "2027-01-01T00:00:00.000Z");
    assert.equal(result.secondary_window.used_percent, 0);
    assert.ok(result.secondary_window.reset_at.startsWith("2026-06-30T"));
  });

  it("parses managed plan output without usage metrics", () => {
    const output = `
Plan: Q Developer Pro
Usage is managed by organization admin.
`;

    const result = parseKiroUsageOutput(output, { now });

    assert.equal(result.plan_name, "Q Developer Pro");
    assert.equal(result.primary_window.used_percent, 0);
    assert.equal(result.primary_window.reset_at, null);
    assert.equal(result.secondary_window, null);
  });
});

describe("fetchKiroLimits", () => {
  const now = new Date("2026-07-25T00:00:00.000Z");
  const usageOutput = `
Estimated Usage | resets on 2026-08-01 | KIRO PRO
████████████ 25%
(25 of 100 covered in plan)
`;

  it("uses a PTY first for kiro-cli 2.13 so /usage is not sent as a model prompt", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kiro-credits-"));
    const calls = [];
    try {
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(
        path.join(trackerDir, "kiro-credits.json"),
        JSON.stringify({
          version: 1,
          total_credits: 1796.45,
          record_count: 193,
          session_count: 19,
          file_count: 19,
          latest_at: "2026-07-22T15:28:20.659Z",
          updated_at: "2026-07-25T00:00:00.000Z",
        }),
      );
      const commandRunner = (command, args) => {
        calls.push({ command, args });
        if (command === "which") {
          return { status: 0, stdout: "/opt/kiro-cli\n", stderr: "" };
        }
        if (command === "/opt/kiro-cli" && args[0] === "--version") {
          return {
            status: 0,
            stdout: "kiro-cli 2.13.0\n",
            stderr: "",
          };
        }
        if (command === "/usr/bin/script") {
          assert.deepEqual(args, [
            "-q",
            "/dev/null",
            "/opt/kiro-cli",
            "chat",
            "--no-interactive",
            "/usage",
          ]);
          return { status: 0, stdout: usageOutput, stderr: "" };
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      };

      const result = await fetchKiroLimits({
        commandRunner,
        now,
        platform: "darwin",
        home: tmp,
      });

      assert.equal(result.error, null);
      assert.equal(result.plan_name, "KIRO PRO");
      assert.equal(result.primary_window.used_percent, 25);
      assert.equal(
        result.primary_window.reset_at,
        "2026-08-01T00:00:00.000Z",
      );
      assert.equal(result.tracked_credits, 1796.45);
      assert.equal(result.tracked_credit_records, 193);
      assert.equal(result.tracked_credit_sessions, 19);
      assert.equal(result.tracked_credits_latest_at, "2026-07-22T15:28:20.659Z");
      assert.equal(
        calls.some(
          ({ command, args }) =>
            command === "/opt/kiro-cli" && args[0] === "chat",
        ),
        false,
        "2.13 must not run the unsafe pipe transport",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back from unparseable pipe output to the PTY on older Kiro versions", async () => {
    const calls = [];
    const commandRunner = (command, args) => {
      calls.push({ command, args });
      if (command === "which") {
        return { status: 0, stdout: "/opt/kiro-cli\n", stderr: "" };
      }
      if (command === "/opt/kiro-cli" && args[0] === "--version") {
        return {
          status: 0,
          stdout: "kiro-cli 2.12.3\n",
          stderr: "",
        };
      }
      if (command === "/opt/kiro-cli" && args[0] === "chat") {
        return {
          status: 0,
          stdout: "What would you like to work on?",
          stderr: "[INFO] MCP subsystem initialized",
        };
      }
      if (command === "/usr/bin/script") {
        return { status: 0, stdout: usageOutput, stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const result = await fetchKiroLimits({
      commandRunner,
      now,
      platform: "darwin",
    });

    assert.equal(result.error, null);
    assert.equal(result.plan_name, "KIRO PRO");
    assert.equal(
      calls.filter(
        ({ command, args }) =>
          command === "/opt/kiro-cli" && args[0] === "chat",
      ).length,
      1,
    );
    assert.equal(
      calls.filter(({ command }) => command === "/usr/bin/script").length,
      1,
    );
  });

  it("keeps local usage_summary credits visible when kiro-cli is unavailable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-kiro-local-credits-"));
    try {
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(
        path.join(trackerDir, "kiro-credits.json"),
        JSON.stringify({
          version: 1,
          total_credits: 12.75,
          record_count: 4,
          session_count: 2,
          latest_at: "2026-07-22T15:28:20.659Z",
          updated_at: "2026-07-25T00:00:00.000Z",
        }),
      );

      const result = await fetchKiroLimits({
        home: tmp,
        commandRunner(command, args) {
          assert.equal(command, "which");
          assert.deepEqual(args, ["kiro-cli"]);
          return { status: 1, stdout: "", stderr: "" };
        },
      });

      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.tracked_credits, 12.75);
      assert.equal(result.tracked_credit_records, 4);
      assert.equal(result.tracked_credit_sessions, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runCommand completion", () => {
  it("terminates a process group shortly after complete output arrives", async () => {
    const startedAt = Date.now();
    const result = await runCommand(
      null,
      process.execPath,
      [
        "-e",
        "process.stdout.write('usage complete\\n'); setInterval(() => {}, 1000);",
      ],
      {
        timeout: 5_000,
        completeWhen: (stdout) => stdout.includes("usage complete"),
        completionGraceMs: 25,
        killProcessGroup: true,
      },
    );

    assert.match(result.stdout, /usage complete/);
    assert.equal(result.error, undefined);
    assert.ok(
      Date.now() - startedAt < 2_000,
      "complete output should not wait for the hard timeout",
    );
  });
});

describe("normalizeGeminiQuotaResponse", () => {
  it("maps pro, flash, and flash-lite windows", () => {
    const result = normalizeGeminiQuotaResponse({
      email: "me@example.com",
      tier: "standard-tier",
      buckets: [
        { modelId: "gemini-2.5-pro", remainingFraction: 0.4, resetTime: "2026-04-04T10:00:00Z" },
        { modelId: "gemini-2.5-flash", remainingFraction: 0.8, resetTime: "2026-04-04T09:00:00Z" },
        { modelId: "gemini-2.5-flash-lite", remainingFraction: 0.9, resetTime: "2026-04-04T08:00:00Z" },
      ],
    });

    assert.equal(result.account_email, "me@example.com");
    assert.equal(result.account_plan, "Paid");
    assert.equal(result.primary_window.used_percent, 60);
    assert.equal(result.secondary_window.used_percent, 20);
    assert.equal(result.tertiary_window.used_percent, 10);
  });

  it("does not show epoch reset time when Gemini returns resetTime 0", () => {
    const result = normalizeGeminiQuotaResponse({
      buckets: [
        { modelId: "gemini-2.5-pro", remainingFraction: 0, resetTime: "0" },
        { modelId: "gemini-3-pro-preview", remainingFraction: 0, resetTime: "1970-01-01T00:00:00Z" },
      ],
    });

    assert.equal(result.primary_window.used_percent, 100);
    assert.equal(result.primary_window.reset_at, null);
  });
});

describe("normalizeAntigravityResponse", () => {
  it("groups chat models into Claude & GPT and Gemini families, picking weekly (most-used) and 5h (least-used) per group", () => {
    const result = normalizeAntigravityResponse({
      code: 0,
      userStatus: {
        email: "agent@example.com",
        planStatus: {
          planInfo: {
            planDisplayName: "Antigravity Pro",
          },
        },
        cascadeModelConfigData: {
          clientModelConfigs: [
            // Claude group: Opus (14% remaining = weekly), Sonnet (100% = 5h)
            {
              label: "Claude Opus",
              modelOrAlias: { model: "claude-opus-4" },
              quotaInfo: {
                remainingFraction: 0.14,
                resetTime: "2026-07-05T00:00:00.000Z",
              },
            },
            {
              label: "Claude Sonnet",
              modelOrAlias: { model: "claude-sonnet-4" },
              quotaInfo: {
                remainingFraction: 1.0,
                resetTime: "2026-06-28T10:00:00.000Z",
              },
            },
            // Gemini group: Pro (45% remaining = weekly), Flash (100% = 5h)
            {
              label: "Gemini Pro",
              modelOrAlias: { model: "gemini-pro" },
              quotaInfo: {
                remainingFraction: 0.45,
                resetTime: "2026-07-05T00:00:00.000Z",
              },
            },
            {
              label: "Gemini Flash",
              modelOrAlias: { model: "gemini-flash" },
              quotaInfo: {
                remainingFraction: 1.0,
                resetTime: "2026-06-28T10:00:00.000Z",
              },
            },
          ],
        },
      },
    });

    assert.equal(result.account_email, "agent@example.com");
    assert.equal(result.account_plan, "Antigravity Pro");
    // Claude weekly: Opus at 0.14 → 86% used
    assert.equal(result.primary_window.used_percent, 86);
    // Claude 5h: Sonnet at 1.0 → 0% used
    assert.equal(result.secondary_window.used_percent, 0);
    // Gemini weekly: Pro at 0.45 → 55% used
    assert.equal(result.tertiary_window.used_percent, 55);
    // Gemini 5h: Flash at 1.0 → 0% used
    assert.equal(result.quaternary_window.used_percent, 0);
  });

  it("supports GetCommandModelConfigs fallback payloads", () => {
    const result = normalizeAntigravityResponse({
      code: "ok",
      clientModelConfigs: [
        {
          label: "Claude Sonnet",
          modelOrAlias: { model: "claude-sonnet-4" },
          quotaInfo: {
            remainingFraction: 0.5,
            resetTime: "1712311200",
          },
        },
      ],
    }, { fallbackToConfigs: true });

    assert.equal(result.account_email, null);
    assert.equal(result.account_plan, null);
    assert.equal(result.primary_window.used_percent, 50);
    assert.equal(result.primary_window.reset_at, "2024-04-05T10:00:00.000Z");
  });
});

describe("normalizeAntigravityQuotaSummary", () => {
  it("accepts the Cloud Code HTTP payload with top-level groups", () => {
    const result = normalizeAntigravityQuotaSummary(antigravityQuotaSummaryPayload());
    assert.equal(result.primary_window.used_percent, 42);
    assert.equal(result.secondary_window.used_percent, 18);
    assert.equal(result.tertiary_window.used_percent, 60);
    assert.equal(result.quaternary_window.used_percent, 10);
    assert.equal(result.primary_window.reset_at, "2026-09-07T00:00:00.000Z");
  });

  it("still accepts the local Connect-RPC wrapper", () => {
    const result = normalizeAntigravityQuotaSummary({
      code: 0,
      response: antigravityQuotaSummaryPayload(),
    });
    assert.equal(result.primary_window.used_percent, 42);
    assert.equal(result.quaternary_window.used_percent, 10);
  });
});

describe("loadAntigravityCredentials", () => {
  it("reads jetski-standalone-oauth-token nested token objects", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-creds-jetski-"));
    try {
      writeAntigravityOauthToken(tmp);
      const creds = loadAntigravityCredentials({ home: tmp, platform: "linux" });
      assert.equal(creds.accessToken, "ya29.agy-live");
      assert.equal(creds.refreshToken, "1//agy-refresh");
      assert.equal(creds.source, "file");
      assert.match(creds.path, /jetski-standalone-oauth-token$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads antigravity-cli/antigravity-oauth-token", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-creds-cli-"));
    try {
      const credPath = path.join(tmp, ".gemini", "antigravity-cli", "antigravity-oauth-token");
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.writeFileSync(credPath, JSON.stringify({
        token: { access_token: "ya29.cli", refresh_token: "1//cli", expiry: "2099-01-01T00:00:00Z" },
      }), "utf8");
      const creds = loadAntigravityCredentials({ home: tmp, platform: "linux" });
      assert.equal(creds.accessToken, "ya29.cli");
      assert.equal(creds.source, "file");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not treat Gemini CLI oauth_creds.json as Antigravity credentials", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-creds-gemini-"));
    try {
      const geminiDir = path.join(tmp, ".gemini");
      fs.mkdirSync(geminiDir, { recursive: true });
      fs.writeFileSync(
        path.join(geminiDir, "oauth_creds.json"),
        JSON.stringify({ access_token: "ya29.gemini-cli", refresh_token: "1//gemini", expiry_date: Date.now() + 3_600_000 }),
        "utf8",
      );
      const creds = loadAntigravityCredentials({ home: tmp, platform: "linux" });
      assert.equal(creds, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads the macOS Keychain via securityRunner", () => {
    const payload = JSON.stringify({
      token: {
        access_token: "ya29.keychain",
        refresh_token: "1//keychain",
        expiry: "2099-01-01T00:00:00Z",
      },
    });
    const creds = loadAntigravityCredentials({
      home: path.join(os.tmpdir(), "tokentracker-agy-no-home"),
      platform: "darwin",
      securityRunner(bin, args) {
        assert.equal(bin, "/usr/bin/security");
        assert.ok(args.includes("gemini"));
        assert.ok(args.includes("antigravity"));
        return { status: 0, stdout: `${payload}\n` };
      },
    });
    assert.equal(creds.accessToken, "ya29.keychain");
    assert.equal(creds.source, "keychain");
  });
});

describe("Antigravity helpers", () => {
  it("parses listening ports", () => {
    const output = `
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
lang      123 me    22u  IPv4 0x123                0t0  TCP 127.0.0.1:51234 (LISTEN)
lang      123 me    23u  IPv4 0x124                0t0  TCP 127.0.0.1:51235 (LISTEN)
`;

    assert.deepEqual(parseListeningPorts(output), [51234, 51235]);
  });

  it("parses localized Windows netstat listeners for only the requested PID", () => {
    const output = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:51234        0.0.0.0:0              LISTENING       654
  TCP    [::1]:51235            [::]:0                 侦听            654
  TCP    127.0.0.1:59999        0.0.0.0:0              LISTENING       777
  TCP    127.0.0.1:51236        127.0.0.1:61000        ESTABLISHED     654
`;
    assert.deepEqual(parseWindowsListeningPorts(output, 654), [51234, 51235]);
  });

  it("discovers native Windows listening ports for the Antigravity PID", async () => {
    const calls = [];
    const commandRunner = (command, args) => {
      calls.push({ command, args });
      return {
        stdout: "TCP  127.0.0.1:51235  0.0.0.0:0  LISTENING  654\nTCP  [::1]:51234  [::]:0  LISTENING  654",
        status: 0,
      };
    };

    const ports = await listAntigravityPorts(654, { commandRunner, platform: "win32" });

    assert.equal(calls[0].command, "netstat.exe");
    assert.deepEqual(calls[0].args, ["-ano", "-p", "tcp"]);
    assert.deepEqual(ports, [51234, 51235]);
  });

  it("native Windows port discovery finds a live Node listener", { skip: process.platform !== "win32" }, async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const expectedPort = server.address().port;
      const ports = await listAntigravityPorts(process.pid, { platform: "win32" });
      assert.ok(ports.includes(expectedPort), `expected ${expectedPort} in ${ports.join(", ")}`);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("detects Antigravity from native Windows process enumeration", async () => {
    const calls = [];
    const commandRunner = (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify([
          { ProcessId: 321, CommandLine: "C:\\Program Files\\Windsurf\\language_server_windows_x64.exe --app_data_dir windsurf" },
          { ProcessId: 654, CommandLine: '"C:\\Program Files\\Antigravity\\language_server_windows_x64.exe" --app_data_dir antigravity --csrf_token win-token --extension_server_port 42427' },
        ]),
        status: 0,
      };
    };

    const result = await detectAntigravityProcess({ commandRunner, platform: "win32" });

    assert.equal(calls[0].command, "powershell.exe");
    assert.deepEqual(calls[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    // Regression guard: the -Command script contains a literal `|`; with
    // shell execution cmd.exe would split it there and break the query.
    // Direct spawn is the contract for every pre-existing call site.
    assert.equal(calls[0].options.useShell, false);
    assert.equal(result.configured, true);
    assert.equal(result.pid, 654);
    assert.equal(result.csrfToken, "win-token");
    assert.equal(result.extensionPort, 42427);
  });

  it("detects antigravity process info from ps output", async () => {
    const commandRunner = () => ({
      stdout: `
123 /Applications/Antigravity.app/Contents/MacOS/language_server_macos --app_data_dir antigravity --csrf_token abc123 --extension_server_port 42427
`,
      status: 0,
    });

    const result = await detectAntigravityProcess({ commandRunner });

    assert.equal(result.configured, true);
    assert.equal(result.pid, 123);
    assert.equal(result.csrfToken, "abc123");
    assert.equal(result.extensionPort, 42427);
  });

  it("detects agy CLI process from ps output (no csrf, no path)", async () => {
    const commandRunner = () => ({
      stdout: `
456 agy
`,
      status: 0,
    });

    const result = await detectAntigravityProcess({ commandRunner });

    assert.equal(result.configured, true);
    assert.equal(result.pid, 456);
    assert.equal(result.csrfToken, null);
    assert.equal(result.extensionPort, null);
  });

  it("detects arch-suffixed language_server (macos_arm)", async () => {
    const commandRunner = () => ({
      stdout: `
789 /Applications/Antigravity.app/Contents/MacOS/language_server_macos_arm --app_data_dir antigravity --csrf_token def456
`,
      status: 0,
    });

    const result = await detectAntigravityProcess({ commandRunner });

    assert.equal(result.configured, true);
    assert.equal(result.pid, 789);
    assert.equal(result.csrfToken, "def456");
  });

  it("detects arch-suffixed language_server (macos_x64)", async () => {
    const commandRunner = () => ({
      stdout: `
 101 /Applications/Antigravity.app/Contents/MacOS/language_server_macos_x64 --app_data_dir antigravity --csrf_token ghi789
`,
      status: 0,
    });

    const result = await detectAntigravityProcess({ commandRunner });

    assert.equal(result.configured, true);
    assert.equal(result.pid, 101);
    assert.equal(result.csrfToken, "ghi789");
  });

  it("does NOT detect Windsurf language_server as Antigravity", async () => {
    // Windsurf shares the Codeium language_server binary name but uses a
    // different app_data_dir. The Antigravity-specific markers must gate detection.
    const commandRunner = () => ({
      stdout: `
 321 /Applications/Windsurf.app/Contents/MacOS/language_server_macos_arm --app_data_dir windsurf --csrf_token windsurf-token
`,
      status: 0,
    });

    const result = await detectAntigravityProcess({ commandRunner });

    assert.equal(result.configured, false);
  });

  it("detects agy CLI from absolute path", async () => {
    const commandRunner = () => ({
      stdout: `
 555 /usr/local/bin/agy
`,
      status: 0,
    });

    const result = await detectAntigravityProcess({ commandRunner });

    assert.equal(result.configured, true);
    assert.equal(result.pid, 555);
  });

  it("does NOT detect agy when it only appears as a command argument", async () => {
    const commandRunner = () => ({
      stdout: `
 556 vim /tmp/agy
`,
      status: 0,
    });

    const result = await detectAntigravityProcess({ commandRunner });

    assert.equal(result.configured, false);
  });

  it("does NOT detect language_server when it only appears as a command argument", async () => {
    const commandRunner = () => ({
      stdout: `
 557 node /tmp/language_server --app_data_dir antigravity --csrf_token fake
`,
      status: 0,
    });

    const result = await detectAntigravityProcess({ commandRunner });

    assert.equal(result.configured, false);
  });

  it("falls back to ps when /bin/ps is missing or returns error", async () => {
    const calls = [];
    const commandRunner = (command, args) => {
      calls.push({ command, args });
      if (command === "/bin/ps") {
        return { status: null, stdout: "", stderr: "", error: new Error("spawn /bin/ps ENOENT") };
      }
      if (command === "ps") {
        return {
          status: 0,
          stdout: "\n 456 agy\n",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    const result = await detectAntigravityProcess({ commandRunner });
    assert.equal(calls[0].command, "/bin/ps");
    assert.equal(calls[1].command, "ps");
    assert.equal(result.configured, true);
    assert.equal(result.pid, 456);
  });

  it("discovers listening ports via Linux procfs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-procfs-test-"));
    try {
      const pidDir = path.join(tmp, "456", "fd");
      const netDir = path.join(tmp, "net");
      fs.mkdirSync(pidDir, { recursive: true });
      fs.mkdirSync(netDir, { recursive: true });
      fs.symlinkSync("socket:[123456]", path.join(pidDir, "12"));
      fs.writeFileSync(
        path.join(netDir, "tcp"),
        [
          "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
          "   0: 0100007F:8A11 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 00000000 100 0 0 10 0",
        ].join("\n"),
        "utf8",
      );

      const ports = parseLinuxProcListeningPorts(456, { procRoot: tmp });
      assert.deepEqual(ports, [35345]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not retry ps on timeout or abort errors", async () => {
    const calls = [];
    const timeoutError = new Error("spawn /bin/ps ETIMEDOUT");
    timeoutError.code = "ETIMEDOUT";

    const commandRunner = (command, args) => {
      calls.push({ command, args });
      return { status: null, stdout: "", stderr: "", error: timeoutError };
    };

    const result = await detectAntigravityProcess({ commandRunner });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/bin/ps");
    assert.equal(result.configured, false);
  });

  it("parses listening ports from ss command output", () => {
    const output = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'LISTEN 0      4096       127.0.0.1:35345      0.0.0.0:*     users:(("agy",pid=456,fd=14))',
      'LISTEN 0      4096       127.0.0.1:32919      0.0.0.0:*     users:(("agy",pid=456,fd=12))',
      'LISTEN 0      4096       127.0.0.1:9999       0.0.0.0:*     users:(("other",pid=789,fd=3))',
    ].join("\n");

    const ports = parseSsListeningPorts(output, 456);
    assert.deepEqual(ports, [32919, 35345]);
  });

  it("exercises listAntigravityPorts Linux fallback chain (procfs miss -> lsof miss -> ss hit)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-listports-fallback-"));
    try {
      const calls = [];
      const commandRunner = (command, args) => {
        calls.push({ command, args });
        if (command === "which") {
          if (args[0] === "lsof") return { status: 1, stdout: "", stderr: "" };
          if (args[0] === "ss") return { status: 0, stdout: "/usr/bin/ss\n", stderr: "" };
        }
        if (command === "/usr/bin/ss" || command === "ss") {
          return {
            status: 0,
            stdout: [
              "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
              'LISTEN 0      4096       127.0.0.1:35345      0.0.0.0:*     users:(("agy",pid=456,fd=14))',
              'LISTEN 0      4096       127.0.0.1:32919      0.0.0.0:*     users:(("agy",pid=456,fd=12))',
            ].join("\n"),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: "" };
      };

      const ports = await listAntigravityPorts(456, {
        commandRunner,
        platform: "linux",
        procRoot: tmp, // procfs miss
      });

      assert.deepEqual(ports, [32919, 35345]);
      assert.ok(calls.some((c) => (c.command === "which" && c.args?.[0] === "lsof") || String(c.command).endsWith("lsof")));
      assert.ok(calls.some((c) => c.command === "which" && c.args?.[0] === "ss"));
      assert.ok(calls.some((c) => c.command === "/usr/bin/ss" || c.command === "ss"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("persists live Antigravity quota for use after the process exits", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-cache-write-"));
    try {
      const nowMs = Date.parse("2026-05-21T00:00:00.000Z");
      const commandRunner = (command) => {
        if (command === "/bin/ps") {
          return {
            stdout: `
123 /Applications/Antigravity.app/Contents/MacOS/language_server_macos --app_data_dir antigravity --csrf_token abc123 --extension_server_port 42427
`,
            status: 0,
          };
        }
        if (command === "which") {
          return { stdout: "/usr/bin/lsof\n", status: 0 };
        }
        if (String(command).endsWith("lsof")) {
          return {
            stdout: `
lang 123 me 22u IPv4 0x123 0t0 TCP 127.0.0.1:51234 (LISTEN)
`,
            status: 0,
          };
        }
        return { stdout: "", stderr: "", status: 1 };
      };
      const requestFn = async ({ path: requestPath }) => {
        if (requestPath.includes("GetUnleashData")) return { code: 0 };
        assert.ok(requestPath.includes("GetUserStatus"));
        return {
          code: 0,
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: "Claude Sonnet",
                  modelOrAlias: { model: "claude-sonnet-4" },
                  quotaInfo: {
                    remainingFraction: 0.25,
                    resetTime: "2026-05-22T00:00:00.000Z",
                  },
                },
              ],
            },
          },
        };
      };

      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner,
        requestFn,
        nowMs,
      });
      assert.equal(result.configured, true);
      assert.equal(result.primary_window.used_percent, 75);

      const cachedPath = path.join(tmp, ".tokentracker", "tracker", "usage-limits-cache.json");
      const cached = JSON.parse(fs.readFileSync(cachedPath, "utf8"));
      assert.equal(cached.antigravity.primary_window.used_percent, 75);
      assert.equal(cached.antigravity.cached_at, "2026-05-21T00:00:00.000Z");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses cached Antigravity quota when no language server process is running", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-cache-read-"));
    try {
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(
        path.join(trackerDir, "usage-limits-cache.json"),
        JSON.stringify({
          antigravity: {
            primary_window: {
              used_percent: 42,
              reset_at: "2026-05-22T00:00:00.000Z",
            },
            cached_at: "2026-05-21T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      const commandRunner = () => ({ stdout: "", stderr: "", status: 1 });

      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner,
        nowMs: Date.parse("2026-05-21T01:00:00.000Z"),
      });

      assert.equal(result.configured, true);
      assert.equal(result.cached, true);
      assert.equal(result.primary_window.used_percent, 42);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses cached Antigravity quota when the live quota request times out", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-cache-timeout-"));
    try {
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(
        path.join(trackerDir, "usage-limits-cache.json"),
        JSON.stringify({
          antigravity: {
            primary_window: {
              used_percent: 42,
              reset_at: "2026-05-22T00:00:00.000Z",
            },
            secondary_window: {
              used_percent: 18,
              reset_at: "2026-05-22T00:00:00.000Z",
            },
            cached_at: "2026-05-21T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      const commandRunner = (command) => {
        if (command === "/bin/ps") {
          return {
            stdout: `
123 /Applications/Antigravity.app/Contents/MacOS/language_server_macos --app_data_dir antigravity --csrf_token abc123 --extension_server_port 42427
`,
            status: 0,
          };
        }
        if (command === "which") {
          return { stdout: "/usr/bin/lsof\n", status: 0 };
        }
        if (String(command).endsWith("lsof")) {
          return {
            stdout: `
lang 123 me 22u IPv4 0x123 0t0 TCP 127.0.0.1:51234 (LISTEN)
`,
            status: 0,
          };
        }
        return { stdout: "", stderr: "", status: 1 };
      };
      const requestFn = async () => {
        throw new Error("timeout");
      };

      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner,
        requestFn,
        nowMs: Date.parse("2026-05-21T01:00:00.000Z"),
      });

      assert.equal(result.configured, true);
      assert.equal(result.cached, true);
      assert.equal(result.error, null);
      assert.equal(result.primary_window.used_percent, 42);
      assert.equal(result.secondary_window.used_percent, 18);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not use cached Antigravity quota after all cached windows reset", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-cache-expired-"));
    try {
      // Create evidence dir so the "not running" message is surfaced
      // (without evidence hasAntigravityInstallEvidence returns configured:false)
      fs.mkdirSync(path.join(tmp, ".gemini", "antigravity"), { recursive: true });
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(
        path.join(trackerDir, "usage-limits-cache.json"),
        JSON.stringify({
          antigravity: {
            primary_window: {
              used_percent: 42,
              reset_at: "2026-05-21T00:00:00.000Z",
            },
            cached_at: "2026-05-20T23:00:00.000Z",
          },
        }),
        "utf8",
      );
      const commandRunner = () => ({ stdout: "", stderr: "", status: 1 });

      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner,
        nowMs: Date.parse("2026-05-21T01:00:00.000Z"),
      });

      assert.equal(result.configured, true);
      assert.ok(result.error.includes("not running"), `expected "not running" message, got: ${result.error}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns configured:false when no Antigravity install evidence exists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-no-evidence-"));
    try {
      const commandRunner = () => ({ stdout: "", stderr: "", status: 1 });

      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner,
        nowMs: Date.parse("2026-05-21T01:00:00.000Z"),
      });

      assert.equal(result.configured, false);
      assert.equal(result.error, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns 'not running' when install evidence exists but no process", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-evidence-noprocess-"));
    try {
      // Create evidence dir
      fs.mkdirSync(path.join(tmp, ".gemini", "antigravity-cli"), { recursive: true });
      const commandRunner = () => ({ stdout: "", stderr: "", status: 1 });

      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner,
        nowMs: Date.parse("2026-05-21T01:00:00.000Z"),
      });

      assert.equal(result.configured, true);
      assert.ok(result.error.includes("not running"), `expected "not running" message, got: ${result.error}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("fetchAntigravityLimits remote OAuth", () => {
  it("fetches remaining quota without a language server process", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-remote-live-"));
    try {
      writeAntigravityOauthToken(tmp);
      const calls = [];
      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl: antigravityRemoteFetchImpl({ calls }),
        nowMs: Date.parse("2026-08-31T00:00:00.000Z"),
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.primary_window.used_percent, 42);
      assert.equal(result.account_plan, "Google AI Pro");
      assert.equal(calls[0], "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
      assert.ok(!calls.some((url) => url.includes("oauth2.googleapis.com/token")));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refreshes an expired access token before calling Cloud Code", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-remote-refresh-"));
    try {
      const credPath = writeAntigravityOauthToken(tmp, { expiry: "2026-08-01T00:00:00Z" });
      const calls = [];
      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl: antigravityRemoteFetchImpl({
          calls,
          refresh: { access_token: "ya29.agy-refreshed", expires_in: 3600 },
        }),
        nowMs: Date.parse("2026-08-31T00:00:00.000Z"),
      });
      assert.equal(result.configured, true);
      assert.equal(result.primary_window.used_percent, 42);
      assert.equal(calls[0], "https://oauth2.googleapis.com/token");
      assert.ok(calls.includes("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"));
      const saved = JSON.parse(fs.readFileSync(credPath, "utf8"));
      assert.equal(saved.token.access_token, "ya29.agy-refreshed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retries after 401 by refreshing the access token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-remote-401-"));
    try {
      writeAntigravityOauthToken(tmp);
      let quotaCalls = 0;
      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner() { return { status: 1, stdout: "" }; },
        async fetchImpl(url) {
          const href = String(url);
          if (href.includes("oauth2.googleapis.com/token")) {
            return { ok: true, status: 200, async json() { return { access_token: "ya29.after-401", expires_in: 3600 }; } };
          }
          if (href.includes("retrieveUserQuotaSummary")) {
            quotaCalls += 1;
            if (quotaCalls === 1) {
              return { ok: false, status: 401, async json() { return {}; } };
            }
            return { ok: true, status: 200, async json() { return antigravityQuotaSummaryPayload(); } };
          }
          if (href.includes("loadCodeAssist")) {
            return { ok: true, status: 200, async json() { return {}; } };
          }
          return { ok: false, status: 404, async json() { return {}; } };
        },
        nowMs: Date.parse("2026-08-31T00:00:00.000Z"),
      });
      assert.equal(result.configured, true);
      assert.equal(result.primary_window.used_percent, 42);
      assert.equal(quotaCalls, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to the local language server when Cloud Code fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-remote-fallback-"));
    try {
      writeAntigravityOauthToken(tmp);
      const commandRunner = (command) => {
        if (command === "/bin/ps") {
          return {
            stdout: `
123 /Applications/Antigravity.app/Contents/MacOS/language_server_macos --app_data_dir antigravity --csrf_token abc123 --extension_server_port 42427
`,
            status: 0,
          };
        }
        if (command === "which") {
          return { stdout: "/usr/bin/lsof\n", status: 0 };
        }
        if (String(command).endsWith("lsof")) {
          return { stdout: "lang 123 me 22u IPv4 0x123 0t0 TCP 127.0.0.1:51234 (LISTEN)\n", status: 0 };
        }
        return { stdout: "", stderr: "", status: 1 };
      };
      const requestFn = async ({ path: requestPath }) => {
        if (requestPath.includes("GetUnleashData")) return { code: 0 };
        if (requestPath.includes("RetrieveUserQuotaSummary")) {
          return {
            code: 0,
            response: antigravityQuotaSummaryPayload(),
          };
        }
        throw new Error(`unexpected ${requestPath}`);
      };
      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner,
        requestFn,
        async fetchImpl() {
          return { ok: false, status: 503, async json() { return {}; } };
        },
        nowMs: Date.parse("2026-08-31T00:00:00.000Z"),
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.primary_window.used_percent, 42);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to last-good cache when Cloud Code fails and the IDE is closed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-remote-cache-"));
    try {
      writeAntigravityOauthToken(tmp);
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(
        path.join(trackerDir, "usage-limits-cache.json"),
        JSON.stringify({
          antigravity: {
            primary_window: { used_percent: 33, reset_at: "2099-01-01T00:00:00.000Z" },
            cached_at: "2026-08-31T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner() { return { status: 1, stdout: "" }; },
        async fetchImpl() {
          return { ok: false, status: 503, async json() { return {}; } };
        },
        nowMs: Date.parse("2026-08-31T01:00:00.000Z"),
      });
      assert.equal(result.configured, true);
      assert.equal(result.cached, true);
      assert.equal(result.primary_window.used_percent, 33);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers the daily Cloud Code host over the unprefixed host", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-remote-host-"));
    try {
      writeAntigravityOauthToken(tmp);
      const calls = [];
      await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl: antigravityRemoteFetchImpl({ calls }),
        nowMs: Date.parse("2026-08-31T00:00:00.000Z"),
      });
      const quotaCalls = calls.filter((url) => url.includes("retrieveUserQuotaSummary"));
      assert.equal(quotaCalls[0], "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
      assert.ok(!quotaCalls.includes("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The invariant these lock in: fetchAntigravityLimits spends ONE providerTimeoutMs
// across its whole serial chain (remote quota attempt → ps → lsof → per-port probes →
// local RPCs), not one per step. Before it was budgeted, a 15s provider budget bought
// 15s remote + 4s ps + 4s lsof + 15s per probed port + 15s per local RPC, and
// /functions/tokentracker-usage-limits has no outer timeout of its own to absorb that.
describe("fetchAntigravityLimits provider budget", () => {
  const PROVIDER_TIMEOUT_MS = 1000;
  // Wall-clock slack for timer/event-loop jitter on a loaded CI runner. Deliberately
  // far below a second full budget, so any regression that pays one per step still fails.
  const TOLERANCE_MS = 400;

  // Never settles — stands in for a Cloud Code host that accepts the connection and
  // then goes quiet, which is the case that used to spend the budget twice.
  const hangingFetch = () => new Promise(() => {});
  const failingFetch = () => Promise.reject(new Error("network unreachable"));
  // Mirrors requestLocalJson's real socket: rejects only when its own per-call timeout
  // elapses, so an unbudgeted caller pays the full timeout once per call.
  const hangingRequestFn = ({ timeoutMs }) => new Promise((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });

  function antigravityProcessCommandRunner(portCount) {
    const portLines = Array.from(
      { length: portCount },
      (_, i) => `lang 123 me ${20 + i}u IPv4 0x1 0t0 TCP 127.0.0.1:${41000 + i} (LISTEN)`,
    ).join("\n");
    return (command) => {
      if (command === "/bin/ps") {
        return {
          status: 0,
          stdout: "123 /Applications/Antigravity.app/Contents/MacOS/language_server_macos --app_data_dir antigravity --csrf_token abc123\n",
        };
      }
      if (command === "which") return { status: 0, stdout: "/usr/bin/lsof\n" };
      if (String(command).endsWith("lsof")) return { status: 0, stdout: `${portLines}\n` };
      return { status: 1, stdout: "", stderr: "" };
    };
  }

  function writeAntigravityCache(tmp, nowMs) {
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    fs.mkdirSync(trackerDir, { recursive: true });
    fs.writeFileSync(
      path.join(trackerDir, "usage-limits-cache.json"),
      JSON.stringify({
        antigravity: {
          primary_window: { used_percent: 71, reset_at: new Date(nowMs + 3600_000).toISOString() },
          cached_at: new Date(nowMs).toISOString(),
        },
      }),
      "utf8",
    );
  }

  async function measure(run) {
    const startedAtMs = Date.now();
    const result = await run();
    return { result, elapsedMs: Date.now() - startedAtMs };
  }

  function assertWithinBudget(elapsedMs, label) {
    assert.ok(
      elapsedMs <= PROVIDER_TIMEOUT_MS + TOLERANCE_MS,
      `${label}: took ${elapsedMs}ms, budget ${PROVIDER_TIMEOUT_MS}ms (+${TOLERANCE_MS}ms tolerance)`,
    );
  }

  // Port count is the multiplier that used to turn one budget into N: each probe
  // previously got the full providerTimeoutMs of its own.
  for (const portCount of [1, 3, 10]) {
    it(`stays inside the budget when every local probe hangs (${portCount} listening ports)`, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-budget-"));
      try {
        writeAntigravityOauthToken(tmp);
        const { result, elapsedMs } = await measure(() => fetchAntigravityLimits({
          home: tmp,
          platform: "linux",
          providerTimeoutMs: PROVIDER_TIMEOUT_MS,
          commandRunner: antigravityProcessCommandRunner(portCount),
          requestFn: hangingRequestFn,
          fetchImpl: failingFetch,
          securityRunner() { return { status: 1, stdout: "" }; },
        }));
        assertWithinBudget(elapsedMs, `${portCount} ports`);
        assert.equal(result.configured, true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it("stays inside the budget when the remote attempt hangs and the IDE is running", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-budget-remote-"));
    try {
      writeAntigravityOauthToken(tmp);
      const { result, elapsedMs } = await measure(() => fetchAntigravityLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: PROVIDER_TIMEOUT_MS,
        commandRunner: antigravityProcessCommandRunner(3),
        requestFn: hangingRequestFn,
        fetchImpl: hangingFetch,
        securityRunner() { return { status: 1, stdout: "" }; },
      }));
      assertWithinBudget(elapsedMs, "remote hang + local fallback");
      assert.equal(result.configured, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stays inside the budget when a probed port answers but the local RPCs hang", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-budget-rpc-"));
    try {
      writeAntigravityOauthToken(tmp);
      const requestFn = ({ path: requestPath, timeoutMs }) => {
        if (requestPath.includes("GetUnleashData")) return Promise.resolve({ code: 0 });
        return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs));
      };
      const { result, elapsedMs } = await measure(() => fetchAntigravityLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: PROVIDER_TIMEOUT_MS,
        commandRunner: antigravityProcessCommandRunner(1),
        requestFn,
        fetchImpl: failingFetch,
        securityRunner() { return { status: 1, stdout: "" }; },
      }));
      assertWithinBudget(elapsedMs, "probe ok + hanging RPCs");
      assert.equal(result.configured, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // This is what the reserved guard buys. Without it the chain spends the budget right
  // up to the deadline and the cache read never runs, so a user with perfectly good
  // stale bars sees a red error instead.
  it("still serves the disk cache when the remote attempt nearly exhausts the budget", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-budget-guard-"));
    try {
      writeAntigravityOauthToken(tmp);
      const nowMs = Date.now();
      writeAntigravityCache(tmp, nowMs);
      const { result, elapsedMs } = await measure(() => fetchAntigravityLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: PROVIDER_TIMEOUT_MS,
        nowMs,
        commandRunner: antigravityProcessCommandRunner(3),
        requestFn: hangingRequestFn,
        fetchImpl: hangingFetch,
        securityRunner() { return { status: 1, stdout: "" }; },
      }));
      assertWithinBudget(elapsedMs, "guard reserves cache time");
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.cached, true);
      assert.equal(result.primary_window.used_percent, 71);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips a step outright rather than issuing it with no budget left", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-budget-skip-"));
    try {
      writeAntigravityOauthToken(tmp);
      const localCalls = [];
      const requestFn = ({ path: requestPath, timeoutMs }) => {
        localCalls.push({ path: requestPath, timeoutMs });
        return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs));
      };
      await fetchAntigravityLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: PROVIDER_TIMEOUT_MS,
        commandRunner: antigravityProcessCommandRunner(10),
        requestFn,
        fetchImpl: failingFetch,
        securityRunner() { return { status: 1, stdout: "" }; },
      });
      // 10 ports were advertised; the budget only ever funds the first probes, and
      // every issued call carries a positive, shrinking timeout rather than the full one.
      assert.ok(localCalls.length < 10, `issued ${localCalls.length} local calls for 10 ports`);
      assert.ok(localCalls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= PROVIDER_TIMEOUT_MS));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("normalizePlanLabel", () => {
  it("Title-cases a bare paid tier", () => {
    assert.equal(normalizePlanLabel("max", "Claude"), "Max");
  });

  it("returns null for the free tier", () => {
    assert.equal(normalizePlanLabel("free", "Cursor"), null);
  });

  it("strips a leading brand word and Title-cases the rest", () => {
    assert.equal(normalizePlanLabel("KIRO PROFESSIONAL", "Kiro"), "Professional");
  });

  it("Title-cases a lowercase tier", () => {
    assert.equal(normalizePlanLabel("business", "Codex"), "Business");
  });

  it("normalizes machine-readable separators in provider plan ids", () => {
    assert.equal(normalizePlanLabel("personal_standard", "Qoder"), "Personal Standard");
  });

  it("returns null for a null tier", () => {
    assert.equal(normalizePlanLabel(null, "Codex"), null);
  });

  it("returns null when the tier is just the brand placeholder", () => {
    assert.equal(normalizePlanLabel("Kiro", "Kiro"), null);
  });
});

describe("getUsageLimits plan_label", () => {
  it("populates plan_label for a paid Claude account", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-plan-paid-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "paid-claude-token",
            subscriptionType: "max",
            rateLimitTier: "tier-1",
          },
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                five_hour: { utilization: 0.4 },
                seven_day: { utilization: 0.12 },
                seven_day_opus: null,
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.claude.configured, true);
      assert.equal(result.claude.error, null);
      assert.equal(result.claude.plan_label, "Max");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves plan_label null for a free Claude account", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-plan-free-"));
    try {
      const claudeDir = path.join(tmp, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "free-claude-token",
            subscriptionType: "free",
          },
        }),
      );

      const result = await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 1000,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner() {
          return { status: 1, stdout: "" };
        },
        fetchImpl(url) {
          if (typeof url === "string" && url === "https://api.anthropic.com/api/oauth/usage") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                five_hour: { utilization: 0.1 },
                seven_day: { utilization: 0.05 },
                seven_day_opus: null,
              }),
            });
          }
          return pendingUnlessCodexReset(url);
        },
      });

      assert.equal(result.claude.configured, true);
      assert.equal(result.claude.error, null);
      assert.equal(result.claude.plan_label, null);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("getUsageLimits Ark timeout fallback", () => {
  it("does not return an unverified Ark cache after timeout and forwards the requested platform", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-ark-timeout-"));
    try {
      // Install-evidence dir: without ~/.arkcli the provider bails out
      // before any probe, and the timeout path below never runs.
      fs.mkdirSync(path.join(tmp, ".arkcli"), { recursive: true });
      const nowMs = Date.now();
      writeArkCodingPlanLimitsCache({
        configured: true,
        error: null,
        plan_label: "Lite",
        primary_window: {
          used_percent: 42,
          reset_at: new Date(nowMs + 3_600_000).toISOString(),
          unit: "calls",
        },
      }, { home: tmp, nowMs });

      const calls = [];
      const result = await getUsageLimits({
        home: tmp,
        platform: "win32",
        providerTimeoutMs: 20,
        securityRunner() {
          return { status: 1, stdout: "" };
        },
        commandRunner(command, args) {
          calls.push({ command, args });
          if (command === "where") {
            return { status: 0, stdout: "C:\\Program Files\\arkcli.exe\n", stderr: "" };
          }
          // The provider spawns the resolved absolute path, never a bare
          // "arkcli" — hang it so the outer provider timeout fires.
          if (/arkcli(\.exe)?$/i.test(command)) return new Promise(() => {});
          return { status: 1, stdout: "", stderr: "" };
        },
        fetchImpl() {
          return new Promise(() => {});
        },
      });

      assert.deepEqual(calls.find(({ command }) => command === "where")?.args, ["arkcli"]);
      assert.equal(result.codingPlan.configured, true);
      assert.equal(result.codingPlan.stale, undefined);
      assert.match(result.codingPlan.error, /timed out/i);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("getUsageLimits Claude stale fallback", () => {
  const FUTURE_RESET = "2099-01-01T00:00:00.000Z";

  function makeClaudeHome(tmp) {
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-token" } }),
    );
  }

  function runLimits(tmp, claudeResponder, extraOptions = {}) {
    return getUsageLimits({
      home: tmp,
      platform: "linux",
      providerTimeoutMs: 1000,
      securityRunner() {
        return { status: 1, stdout: "" };
      },
      commandRunner() {
        return { status: 1, stdout: "" };
      },
      fetchImpl(url) {
        if (url === "https://api.anthropic.com/api/oauth/usage") return claudeResponder();
        return pendingUnlessCodexReset(url);
      },
      ...extraOptions,
    });
  }

  function ageClaudeCache(tmp, ageMs) {
    const cachePath = path.join(tmp, ".tokentracker", "tracker", "claude-usage-limits-cache.json");
    const payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    payload.claude.cached_at = new Date(Date.now() - ageMs).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2));
  }

  it("serves the last successful read when a later fetch is rate limited", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-stale-"));
    try {
      makeClaudeHome(tmp);

      const ok = await runLimits(tmp, () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            five_hour: { utilization: 11, resets_at: FUTURE_RESET },
            seven_day: { utilization: 81, resets_at: FUTURE_RESET },
            seven_day_opus: null,
          }),
        }),
      );
      assert.equal(ok.claude.error, null);
      assert.equal(ok.claude.five_hour.utilization, 11);
      assert.notEqual(ok.claude.stale, true);

      // Age the disk cache past the short fresh-cache TTL, then drop the in-memory cache
      // so the next call actually re-fetches and hits the 429 fallback branch.
      ageClaudeCache(tmp, 11 * 60 * 1000);
      resetUsageLimitsCache();

      const limited = await runLimits(tmp, () =>
        Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: () => null },
        }),
      );
      // Bars stay visible from disk cache instead of flipping to a red error.
      assert.equal(limited.claude.configured, true);
      assert.equal(limited.claude.error, null);
      assert.equal(limited.claude.stale, true);
      assert.equal(limited.claude.five_hour.utilization, 11);
      assert.equal(limited.claude.seven_day.utilization, 81);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses a recent disk cache instead of refetching Claude after process cache reset", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-fresh-cache-"));
    try {
      makeClaudeHome(tmp);

      let claudeCalls = 0;
      const ok = await runLimits(tmp, () => {
        claudeCalls += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            five_hour: { utilization: 22, resets_at: FUTURE_RESET },
            seven_day: { utilization: 44, resets_at: FUTURE_RESET },
            seven_day_opus: null,
          }),
        });
      });
      assert.equal(ok.claude.error, null);
      assert.equal(ok.claude.five_hour.utilization, 22);
      assert.equal(claudeCalls, 1);

      resetUsageLimitsCache();
      const cached = await runLimits(tmp, () => {
        claudeCalls += 1;
        throw new Error("Claude endpoint should not be called while disk cache is fresh");
      });

      assert.equal(claudeCalls, 1);
      assert.equal(cached.claude.configured, true);
      assert.equal(cached.claude.error, null);
      assert.equal(cached.claude.stale, false);
      assert.equal(cached.claude.five_hour.utilization, 22);
      assert.equal(cached.claude.seven_day.utilization, 44);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("forceRefresh punches through the fresh disk cache and hits upstream", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-force-refresh-"));
    try {
      makeClaudeHome(tmp);

      let claudeCalls = 0;
      const first = await runLimits(tmp, () => {
        claudeCalls += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            five_hour: { utilization: 22, resets_at: FUTURE_RESET },
            seven_day: { utilization: 44, resets_at: FUTURE_RESET },
            seven_day_opus: null,
          }),
        });
      });
      assert.equal(first.claude.five_hour.utilization, 22);
      assert.equal(claudeCalls, 1);

      // Simulates the refresh=1 path: in-memory cache cleared + forceRefresh.
      resetUsageLimitsCache();
      const refreshed = await runLimits(
        tmp,
        () => {
          claudeCalls += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              five_hour: { utilization: 33, resets_at: FUTURE_RESET },
              seven_day: { utilization: 55, resets_at: FUTURE_RESET },
              seven_day_opus: null,
            }),
          });
        },
        { forceRefresh: true },
      );

      assert.equal(claudeCalls, 2, "forceRefresh must bypass the fresh disk cache");
      assert.equal(refreshed.claude.error, null);
      assert.notEqual(refreshed.claude.stale, true);
      assert.equal(refreshed.claude.five_hour.utilization, 33);
      assert.equal(refreshed.claude.seven_day.utilization, 55);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("forceRefresh still honors an active 429 cooldown", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-force-cooldown-"));
    try {
      makeClaudeHome(tmp);
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(
        path.join(trackerDir, "claude-usage-rate-limit.json"),
        JSON.stringify({ retry_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }),
      );

      let claudeCalls = 0;
      const limited = await runLimits(
        tmp,
        () => {
          claudeCalls += 1;
          throw new Error("Claude endpoint must not be called during an active cooldown");
        },
        { forceRefresh: true },
      );

      assert.equal(claudeCalls, 0, "forceRefresh must never bypass the 429 cooldown");
      assert.equal(limited.claude.configured, true);
      assert.match(limited.claude.error, /rate limited \(429\)/);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces the error when a fetch fails and there is no cached fallback", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-nocache-"));
    try {
      makeClaudeHome(tmp);

      const limited = await runLimits(tmp, () =>
        Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: () => null },
        }),
      );
      assert.equal(limited.claude.configured, true);
      assert.match(limited.claude.error, /rate limited \(429\)/);
      assert.notEqual(limited.claude.stale, true);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("records a cooldown on 429 and stops calling the endpoint until it expires", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-cooldown-"));
    try {
      makeClaudeHome(tmp);

      let claudeCalls = 0;
      const responder = () => {
        claudeCalls += 1;
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: (h) => (h === "retry-after" ? "600" : null) },
        });
      };

      const first = await runLimits(tmp, responder);
      assert.equal(claudeCalls, 1);
      assert.match(first.claude.error, /retry in ~10m/);

      // Cooldown is active — the next call must not touch the endpoint again.
      resetUsageLimitsCache();
      const second = await runLimits(tmp, responder);
      assert.equal(claudeCalls, 1, "endpoint must not be called again during cooldown");
      assert.match(second.claude.error, /retry in ~\d+m/);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("clears the cooldown and resumes once a fetch succeeds", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-recover-"));
    try {
      makeClaudeHome(tmp);

      await runLimits(tmp, () =>
        Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: (h) => (h === "retry-after" ? "600" : null) },
        }),
      );
      const cooldownPath = path.join(tmp, ".tokentracker", "tracker", "claude-usage-rate-limit.json");
      assert.ok(fs.existsSync(cooldownPath), "cooldown file should be written on 429");

      // A test can't wait out a 10m cooldown, so clear it to simulate expiry, then succeed.
      fs.unlinkSync(cooldownPath);
      resetUsageLimitsCache();
      const ok = await runLimits(tmp, () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            five_hour: { utilization: 5, resets_at: FUTURE_RESET },
            seven_day: { utilization: 9, resets_at: FUTURE_RESET },
            seven_day_opus: null,
          }),
        }),
      );
      assert.equal(ok.claude.error, null);
      assert.equal(ok.claude.five_hour.utilization, 5);
      assert.equal(fs.existsSync(cooldownPath), false, "cooldown file should be cleared on success");
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("drops cached windows whose reset has already passed", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-expired-"));
    try {
      makeClaudeHome(tmp);

      const ok = await runLimits(tmp, () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            five_hour: { utilization: 50, resets_at: "2000-01-01T00:00:00.000Z" },
            seven_day: { utilization: 81, resets_at: FUTURE_RESET },
            seven_day_opus: null,
          }),
        }),
      );
      assert.equal(ok.claude.error, null);

      ageClaudeCache(tmp, 11 * 60 * 1000);
      resetUsageLimitsCache();

      const limited = await runLimits(tmp, () =>
        Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: () => null },
        }),
      );
      assert.equal(limited.claude.stale, true);
      // Expired 5h window is dropped; the still-valid 7d window survives.
      assert.equal(limited.claude.five_hour, null);
      assert.equal(limited.claude.seven_day.utilization, 81);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("cacheExpiresAtMs", () => {
  const fetchedAt = Date.parse("2026-07-06T12:00:00Z");
  const TTL_MS = 2 * 60 * 1000;
  const MIN_TTL_MS = 5 * 1000;

  it("expires at the earliest upcoming reset when it lands inside the TTL", () => {
    const resetMs = fetchedAt + 60 * 1000;
    const data = {
      claude: {
        five_hour: { utilization: 90, resets_at: new Date(resetMs).toISOString() },
        seven_day: { utilization: 10, resets_at: new Date(fetchedAt + 86400 * 1000).toISOString() },
      },
    };
    assert.equal(cacheExpiresAtMs(data, fetchedAt), resetMs);
  });

  it("converts Codex unix-second reset stamps", () => {
    const resetMs = fetchedAt + 90 * 1000;
    const data = { codex: { primary_window: { used_percent: 80, reset_at: resetMs / 1000 } } };
    assert.equal(cacheExpiresAtMs(data, fetchedAt), resetMs);
  });

  it("finds resets nested inside weekly_scoped arrays", () => {
    const resetMs = fetchedAt + 30 * 1000;
    const data = {
      claude: {
        weekly_scoped: [{ label: "Fable", utilization: 8, resets_at: new Date(resetMs).toISOString() }],
      },
    };
    assert.equal(cacheExpiresAtMs(data, fetchedAt), resetMs);
  });

  it("falls back to the full TTL when every reset is beyond it", () => {
    const data = {
      claude: { five_hour: { utilization: 5, resets_at: new Date(fetchedAt + 5 * 3600 * 1000).toISOString() } },
    };
    assert.equal(cacheExpiresAtMs(data, fetchedAt), fetchedAt + TTL_MS);
  });

  it("falls back to the full TTL when there are no reset stamps", () => {
    assert.equal(cacheExpiresAtMs({ claude: { configured: false } }, fetchedAt), fetchedAt + TTL_MS);
  });

  it("ignores resets already in the past", () => {
    const data = {
      claude: { five_hour: { utilization: 5, resets_at: new Date(fetchedAt - 1000).toISOString() } },
    };
    assert.equal(cacheExpiresAtMs(data, fetchedAt), fetchedAt + TTL_MS);
  });

  it("floors an imminent reset to the minimum TTL so polls cannot hammer upstream", () => {
    const data = {
      claude: { five_hour: { utilization: 99, resets_at: new Date(fetchedAt + 1000).toISOString() } },
    };
    assert.equal(cacheExpiresAtMs(data, fetchedAt), fetchedAt + MIN_TTL_MS);
  });
});
