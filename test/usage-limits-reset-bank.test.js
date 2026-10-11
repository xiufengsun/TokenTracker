const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { getUsageLimits, resetUsageLimitsCache } = require("./helpers/usage-limits");

const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

function jwt(planType = "plus") {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_plan_type: planType },
  })).toString("base64url");
  return `header.${payload}.sig`;
}

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

function ok(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function whamBody(resetCredits = { available_count: 2, total_earned_count: 5, credits: [] }) {
  return {
    rate_limit: {
      primary_window: { used_percent: 11, limit_window_seconds: 18000, reset_at: 700 },
      secondary_window: { used_percent: 22, limit_window_seconds: 604800, reset_at: 800 },
    },
    rate_limit_reset_credits: resetCredits,
  };
}

async function withCodexLimits({
  wham = whamBody(),
  whamResponder = () => ok(wham),
  resetResponder = () => ok(wham.rate_limit_reset_credits),
  providerTimeoutMs = 1000,
  tokens = { access_token: jwt(), id_token: jwt() },
}) {
  resetUsageLimitsCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-reset-bank-"));
  const realDateNow = Date.now;
  try {
    Date.now = () => Date.parse("2026-06-20T00:00:00Z");
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), JSON.stringify({ tokens }));
    return await getUsageLimits({
      home: tmp,
      platform: "linux",
      providerTimeoutMs,
      securityRunner: inactiveRunner,
      commandRunner: inactiveRunner,
      fetchImpl(url, opts) {
        if (url === WHAM_URL) return whamResponder(url, opts);
        if (url === RESET_URL) return resetResponder(url, opts);
        return new Promise(() => {});
      },
    });
  } finally {
    Date.now = realDateNow;
    resetUsageLimitsCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function assertWindowsAndFallback(result) {
  assert.equal(result.codex.error, null);
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
  assert.deepEqual(result.codex.reset_credits, {
    available_count: 2,
    total_earned_count: 5,
    credits: [],
  });
}

function assertNoPrivateResetFields(value) {
  assert.doesNotMatch(
    JSON.stringify(value),
    /RateLimitResetCredit|credit-private|user-private|profile-private|person@example\.com|account-private|Reset GPT-5|sk-private|refresh-private|opaque-private/,
  );
}

test("Codex reset bank normalizes list rows, strips private fields, and preserves windows", async () => {
  const result = await withCodexLimits({
    wham: whamBody({ available_count: 99, total_earned_count: 99, credits: [] }),
    resetResponder: () => ok({
      available_count: 3,
      total_earned_count: 8,
      credits: [
        {
          __typename: "RateLimitResetCredit",
          id: "credit-private",
          user_id: "user-private",
          profile: { id: "profile-private", email: "person@example.com" },
          account_id: "account-private",
          title: "Reset GPT-5",
          token: "opaque-private",
          auth_token: "opaque-private",
          access_token: "sk-private",
          refresh_token: "refresh-private",
          status: "available",
          reset_type: "codex_rate_limits",
          granted_at: "2026-06-20T00:00:00Z",
          expires_at: "2026-07-12T02:13:21.590541Z",
        },
        { status: "available", expires_at: "2026-07-03T00:00:00Z" },
        { status: "used", reset_type: "codex_rate_limits", expires_at: "2026-07-02T00:00:00Z" },
        { status: "available", reset_type: "chatgpt_message_limits", expires_at: "2026-07-02T00:00:00Z" },
        { status: "available", reset_type: "codex_rate_limits", expires_at: "bad" },
      ],
    }),
  });

  assert.deepEqual(result.codex.primary_window, whamBody().rate_limit.primary_window);
  assert.deepEqual(result.codex.reset_credits, {
    available_count: 3,
    total_earned_count: 8,
    credits: [
      { status: "available", expires_at: "2026-07-03T00:00:00Z" },
      {
        status: "available",
        reset_type: "codex_rate_limits",
        granted_at: "2026-06-20T00:00:00Z",
        expires_at: "2026-07-12T02:13:21.590541Z",
      },
    ],
  });
  assertNoPrivateResetFields(result.codex.reset_credits);
});

test("Codex reset bank preserves null API count and caps sorted credits at 50", async () => {
  const credits = Array.from({ length: 55 }, (_, index) => ({
    status: "available",
    reset_type: "codex_rate_limits",
    expires_at: `2026-07-${String(25 - (index % 25)).padStart(2, "0")}T00:00:00Z`,
  }));
  const result = await withCodexLimits({
    resetResponder: () => ok({ available_count: null, total_earned_count: 55.5, credits }),
  });

  assert.equal(result.codex.reset_credits.available_count, null);
  assert.equal(result.codex.reset_credits.total_earned_count, null);
  assert.equal(result.codex.reset_credits.credits.length, 50);
  assert.equal(result.codex.reset_credits.credits[0].expires_at, "2026-07-01T00:00:00Z");
});

test("Codex reset bank request uses GET bearer headers and no Cookie", async () => {
  const calls = [];
  await withCodexLimits({
    tokens: { access_token: jwt(), id_token: jwt(), account_id: "acc-reset-bank" },
    resetResponder: (_url, opts) => {
      calls.push({ method: opts?.method, headers: { ...opts?.headers } });
      return ok({ available_count: 0, total_earned_count: 0, credits: [] });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Authorization, `Bearer ${jwt()}`);
  assert.equal(calls[0].headers.Accept, "application/json");
  assert.equal(calls[0].headers["ChatGPT-Account-Id"], "acc-reset-bank");
  assert.equal(Object.keys(calls[0].headers).some((key) => key.toLowerCase() === "cookie"), false);
});

for (const [name, responder] of [
  ["status 401", () => Promise.resolve({ ok: false, status: 401, json: async () => ({}) })],
  ["status 403", () => Promise.resolve({ ok: false, status: 403, json: async () => ({}) })],
  ["status 404", () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) })],
  ["status 500", () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) })],
  ["rejected fetch", () => Promise.reject(new Error("network down"))],
  ["aborted fetch", () => Promise.reject(new DOMException("aborted", "AbortError"))],
  ["bad JSON", () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })],
  ["malformed body", () => ok("malformed")],
]) {
  test(`Reset Bank fallback keeps Codex windows when list returns ${name}`, async () => {
    assertWindowsAndFallback(await withCodexLimits({ resetResponder: responder }));
  });
}

test("Reset Bank fallback keeps Codex windows when list request never resolves", async () => {
  const result = await withCodexLimits({
    providerTimeoutMs: 60,
    resetResponder: () => new Promise(() => {}),
  });

  assertWindowsAndFallback(result);
});

test("Reset Bank fallback keeps Codex windows when usage consumes most provider timeout and list never resolves", async () => {
  const result = await withCodexLimits({
    wham: whamBody({ available_count: 1, total_earned_count: 5, credits: [] }),
    providerTimeoutMs: 180,
    whamResponder: async () => {
      await new Promise((resolve) => setTimeout(resolve, 160));
      return ok(whamBody({ available_count: 1, total_earned_count: 5, credits: [] }));
    },
    resetResponder: () => new Promise(() => {}),
  });

  assert.equal(result.codex.error, null);
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
  assert.deepEqual(result.codex.reset_credits, {
    available_count: 1,
    total_earned_count: 5,
    credits: [],
  });
});

test("Reset Bank list is skipped when usage already consumes the provider budget", async () => {
  const realPerformanceNow = performance.now;
  const observedUrls = [];
  let nowCalls = 0;
  try {
    performance.now = () => {
      nowCalls += 1;
      return nowCalls === 1 ? 0 : 125;
    };
    const startedAt = realPerformanceNow.call(performance);
    const result = await withCodexLimits({
      wham: whamBody({ available_count: 1, total_earned_count: 5, credits: [] }),
      providerTimeoutMs: 100,
      whamResponder: (url) => {
        observedUrls.push(url);
        return ok(whamBody({ available_count: 1, total_earned_count: 5, credits: [] }));
      },
      resetResponder: (url) => {
        observedUrls.push(url);
        return new Promise(() => {});
      },
    });
    const elapsedMs = realPerformanceNow.call(performance) - startedAt;

    assert.equal(result.codex.error, null);
    assert.deepEqual(result.codex.reset_credits, {
      available_count: 1,
      total_earned_count: 5,
      credits: [],
    });
    assert.deepEqual(observedUrls, [WHAM_URL]);
    assert.ok(elapsedMs < 500, `exhausted budget must not add the 3s reset-list timeout; elapsed=${elapsedMs}`);
  } finally {
    performance.now = realPerformanceNow;
  }
});

test("consume guardrail: Codex reset product path never references mutation endpoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "usage-limits.js"), "utf8");
  assert.doesNotMatch(source, /rate-limit-reset-credits\/consume/);
});
