"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  accountSlugFor,
  accessTokenFromRefreshPayload,
  refreshTokenFromRefreshPayload,
  decodeJwtExpMs,
  mintAccessToken,
  fetchAccountFunction,
  fetchAccountUsage,
  AccountAuthError,
  PAYLOAD_TTL_MS,
  SUMMARY_PAYLOAD_TTL_MS,
  invalidateCloudAccountPayloadCache,
  __resetCloudAccountCacheForTests,
} = require("../src/lib/cloud-account");

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt({ expSeconds }) {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "u1", exp: expSeconds })}.sig`;
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test("accountSlugFor maps usage slugs to account slugs, null for non-cloud", () => {
  assert.equal(accountSlugFor("tokentracker-usage-summary"), "tokentracker-account-summary");
  assert.equal(accountSlugFor("tokentracker-usage-model-breakdown"), "tokentracker-account-model-breakdown");
  assert.equal(accountSlugFor("tokentracker-project-usage-summary"), null);
  assert.equal(accountSlugFor("tokentracker-usage-limits"), null);
});

test("accessTokenFromRefreshPayload reads camel/snake, top-level and nested", () => {
  assert.equal(accessTokenFromRefreshPayload({ accessToken: "a" }), "a");
  assert.equal(accessTokenFromRefreshPayload({ access_token: "b" }), "b");
  assert.equal(accessTokenFromRefreshPayload({ session: { accessToken: "c" } }), "c");
  assert.equal(accessTokenFromRefreshPayload({ session: { access_token: "d" } }), "d");
  assert.equal(accessTokenFromRefreshPayload({}), null);
  assert.equal(accessTokenFromRefreshPayload(null), null);
});

test("refreshTokenFromRefreshPayload reads rotated refresh token", () => {
  assert.equal(refreshTokenFromRefreshPayload({ refreshToken: "r1" }), "r1");
  assert.equal(refreshTokenFromRefreshPayload({ session: { refresh_token: "r2" } }), "r2");
  assert.equal(refreshTokenFromRefreshPayload({}), null);
});

test("decodeJwtExpMs decodes exp in ms, 0 on garbage", () => {
  assert.equal(decodeJwtExpMs(makeJwt({ expSeconds: 1000 })), 1000 * 1000);
  assert.equal(decodeJwtExpMs("not-a-jwt"), 0);
  assert.equal(decodeJwtExpMs(""), 0);
});

test("mintAccessToken returns null without a refresh token", async () => {
  __resetCloudAccountCacheForTests();
  const out = await mintAccessToken({ refreshToken: "", fetchImpl: async () => jsonResponse({}) });
  assert.equal(out, null);
});

test("mintAccessToken posts refresh token and returns access token", async () => {
  __resetCloudAccountCacheForTests();
  const calls = [];
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const fetchImpl = async (urlStr, opts) => {
    calls.push({ urlStr, opts });
    return jsonResponse({ accessToken: access });
  };
  const out = await mintAccessToken({
    baseUrl: "https://cloud.example",
    anonKey: "ik_test",
    refreshToken: "refresh-1",
    fetchImpl,
  });
  assert.equal(out.accessToken, access);
  assert.equal(out.refreshToken, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].urlStr, /\/api\/auth\/refresh\?client_type=mobile$/);
  assert.equal(calls[0].opts.headers.apikey, "ik_test");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { refresh_token: "refresh-1" });
});

test("mintAccessToken caches by refresh token and skips re-fetch until near expiry", async () => {
  __resetCloudAccountCacheForTests();
  let fetchCount = 0;
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse({ accessToken: access });
  };
  const args = { baseUrl: "https://cloud.example", refreshToken: "refresh-cache", fetchImpl };
  const a = await mintAccessToken(args);
  const b = await mintAccessToken(args);
  assert.equal(a.accessToken, access);
  assert.equal(b.accessToken, access);
  assert.equal(fetchCount, 1, "second call should hit cache");

  // A different refresh token must bypass the cache.
  await mintAccessToken({ ...args, refreshToken: "refresh-other" });
  assert.equal(fetchCount, 2);
});

test("concurrent token refreshes share one in-flight request", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    calls += 1;
    await gate;
    return jsonResponse({ accessToken: access });
  };
  const first = mintAccessToken({ baseUrl: "https://cloud.example", refreshToken: "same", fetchImpl });
  const second = mintAccessToken({ baseUrl: "https://cloud.example", refreshToken: "same", fetchImpl });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.accessToken, access);
  assert.equal(b.accessToken, access);
});

test("mintAccessToken scopes cache by base URL", async () => {
  __resetCloudAccountCacheForTests();
  const calls = [];
  const accessA = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const accessB = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const fetchImpl = async (urlStr) => {
    calls.push(String(urlStr));
    return jsonResponse({ accessToken: calls.length === 1 ? accessA : accessB });
  };

  const first = await mintAccessToken({
    baseUrl: "https://cloud-a.example",
    refreshToken: "refresh-cache",
    fetchImpl,
  });
  const second = await mintAccessToken({
    baseUrl: "https://cloud-b.example",
    refreshToken: "refresh-cache",
    fetchImpl,
  });

  assert.equal(first.accessToken, accessA);
  assert.equal(second.accessToken, accessB);
  assert.deepEqual(calls, [
    "https://cloud-a.example/api/auth/refresh?client_type=mobile",
    "https://cloud-b.example/api/auth/refresh?client_type=mobile",
  ]);
});

test("mintAccessToken returns null on non-ok refresh and on network error", async () => {
  __resetCloudAccountCacheForTests();
  assert.equal(
    await mintAccessToken({ refreshToken: "x", fetchImpl: async () => jsonResponse({}, false, 401) }),
    null,
  );
  __resetCloudAccountCacheForTests();
  assert.equal(
    await mintAccessToken({ refreshToken: "x", fetchImpl: async () => { throw new Error("offline"); } }),
    null,
  );
});

test("mintAccessToken surfaces a rotated refresh token", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const out = await mintAccessToken({
    refreshToken: "old",
    fetchImpl: async () => jsonResponse({ accessToken: access, refreshToken: "new" }),
  });
  assert.equal(out.refreshToken, "new");
});

test("the rotated refresh token reuses its valid access token", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwt({ sub: "rotated-cache-user", exp: Math.floor(Date.now() / 1000) + 3600 });
  let refreshCalls = 0;
  const fetchImpl = async () => {
    refreshCalls += 1;
    return jsonResponse({ accessToken: access, refreshToken: `rotation-${refreshCalls}` });
  };
  const first = await mintAccessToken({ baseUrl: "https://cloud.example", refreshToken: "initial", fetchImpl });
  const next = await mintAccessToken({ baseUrl: "https://cloud.example", refreshToken: first.refreshToken, fetchImpl });
  assert.equal(refreshCalls, 1);
  assert.equal(next.accessToken, access);
  assert.equal(next.refreshToken, null);
  // An unrelated credential must still authenticate independently.
  await mintAccessToken({ baseUrl: "https://cloud.example", refreshToken: "other-session", fetchImpl });
  assert.equal(refreshCalls, 2);
});

test("mintAccessToken surfaces the csrf token paired with a rotation", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const out = await mintAccessToken({
    refreshToken: "old",
    fetchImpl: async () =>
      jsonResponse({ accessToken: access, refreshToken: "new", csrfToken: "csrf-new" }),
  });
  assert.equal(out.csrfToken, "csrf-new");
});

test("fetchAccountFunction forwards query params except account/scope, sets auth headers", async () => {
  const captured = {};
  const fetchImpl = async (urlStr, opts) => {
    captured.urlStr = urlStr;
    captured.opts = opts;
    return jsonResponse({ ok: 1 });
  };
  const searchParams = new URLSearchParams("from=2026-01-01&to=2026-01-02&tz=UTC&account=1&scope=all");
  const body = await fetchAccountFunction({
    baseUrl: "https://cloud.example/",
    anonKey: "ik_x",
    accessToken: "jwt-abc",
    slug: "tokentracker-account-summary",
    searchParams,
    fetchImpl,
  });
  assert.deepEqual(body, { ok: 1 });
  const u = new URL(captured.urlStr);
  assert.equal(u.pathname, "/functions/tokentracker-account-summary");
  assert.equal(u.searchParams.get("from"), "2026-01-01");
  assert.equal(u.searchParams.get("tz"), "UTC");
  assert.equal(u.searchParams.get("account"), null, "account must be stripped");
  assert.equal(u.searchParams.get("scope"), null, "scope must be stripped");
  assert.equal(captured.opts.headers.Authorization, "Bearer jwt-abc");
  assert.equal(captured.opts.headers.apikey, "ik_x");
});

test("fetchAccountFunction throws with status on non-ok", async () => {
  await assert.rejects(
    () => fetchAccountFunction({
      accessToken: "x",
      slug: "tokentracker-account-summary",
      searchParams: new URLSearchParams(),
      fetchImpl: async () => jsonResponse({}, false, 500),
    }),
    (err) => err.status === 500,
  );
});

test("fetchAccountUsage returns null for slugs without a cloud equivalent", async () => {
  __resetCloudAccountCacheForTests();
  const out = await fetchAccountUsage({
    usageSlug: "tokentracker-usage-limits",
    searchParams: new URLSearchParams(),
    refreshToken: "r",
    fetchImpl: async () => jsonResponse({}),
  });
  assert.equal(out, null);
});

test("fetchAccountUsage returns null when not signed in (no refresh token)", async () => {
  __resetCloudAccountCacheForTests();
  const out = await fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary",
    searchParams: new URLSearchParams(),
    refreshToken: "",
    fetchImpl: async () => jsonResponse({}),
  });
  assert.equal(out, null);
});

test("fetchAccountUsage mints a token then returns the account payload", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const payload = { from: "2026-01-01", to: "2026-01-01", totals: { total_tokens: 4242 } };
  const fetchImpl = async (urlStr) => {
    if (urlStr.includes("/api/auth/refresh")) return jsonResponse({ accessToken: access });
    if (urlStr.includes("/functions/tokentracker-account-summary")) return jsonResponse(payload);
    throw new Error(`unexpected url ${urlStr}`);
  };
  const out = await fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary",
    searchParams: new URLSearchParams("from=2026-01-01&to=2026-01-01"),
    baseUrl: "https://cloud.example",
    anonKey: "ik_x",
    refreshToken: "r",
    fetchImpl,
  });
  assert.deepEqual(out.data, payload);
  assert.equal(out.rotatedRefreshToken, null);
  assert.equal(out.rotatedCsrfToken, null);
});

test("fetchAccountUsage threads the rotated csrf token through to the caller", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  const fetchImpl = async (urlStr) => {
    if (urlStr.includes("/api/auth/refresh")) {
      return jsonResponse({ accessToken: access, refreshToken: "rotated", csrfToken: "csrf-rotated" });
    }
    return jsonResponse({ totals: {} });
  };
  const out = await fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary",
    searchParams: new URLSearchParams(),
    baseUrl: "https://cloud.example",
    refreshToken: "r",
    fetchImpl,
  });
  assert.equal(out.rotatedRefreshToken, "rotated");
  assert.equal(out.rotatedCsrfToken, "csrf-rotated");
});

// --- Single-flight refresh ---------------------------------------------------
//
// A full popover refresh fires six account reads at once. Before this, each one
// POSTed /api/auth/refresh with the same refresh token; when the backend rotates
// refresh tokens the losers of that race presented a consumed token and failed,
// which the popover then rendered as "you only have this machine".

test("concurrent mints with the same refresh token share one refresh request", async () => {
  __resetCloudAccountCacheForTests();
  const jwt = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return jsonResponse({ accessToken: jwt, refreshToken: "rotated" });
  };

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      mintAccessToken({ baseUrl: "https://api.test", refreshToken: "r1", fetchImpl }),
    ),
  );

  assert.equal(calls, 1);
  for (const r of results) assert.equal(r.accessToken, jwt);
});

test("a failed single-flight mint does not poison later attempts", async () => {
  __resetCloudAccountCacheForTests();
  const jwt = makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return jsonResponse({ accessToken: jwt });
  };

  const failed = await Promise.all([
    mintAccessToken({ baseUrl: "https://api.test", refreshToken: "r1", fetchImpl }),
    mintAccessToken({ baseUrl: "https://api.test", refreshToken: "r1", fetchImpl }),
  ]);
  assert.deepEqual(failed, [null, null]);
  assert.equal(calls, 1, "both callers share the failing flight");

  const retried = await mintAccessToken({ baseUrl: "https://api.test", refreshToken: "r1", fetchImpl });
  assert.equal(retried.accessToken, jwt);
  assert.equal(calls, 2, "the in-flight entry must be cleared once it settles");
});

test("throwOnFailure classifies why the refresh failed", async () => {
  const cases = [
    ["auth_network", async () => { throw new TypeError("fetch failed"); }],
    ["auth_timeout", async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }],
    ["auth_rejected", async () => jsonResponse({ error: "consumed" }, false, 401)],
    ["auth_invalid", async () => jsonResponse({ nothing: true })],
  ];
  for (const [code, fetchImpl] of cases) {
    __resetCloudAccountCacheForTests();
    await assert.rejects(
      mintAccessToken({
        baseUrl: "https://api.test",
        refreshToken: `r-${code}`,
        fetchImpl,
        throwOnFailure: true,
      }),
      (err) => {
        assert.ok(err instanceof AccountAuthError);
        assert.equal(err.code, code);
        return true;
      },
    );
  }
});

test("fetchAccountUsage throws (not returns null) when a signed-in refresh fails", async () => {
  __resetCloudAccountCacheForTests();
  await assert.rejects(
    fetchAccountUsage({
      usageSlug: "tokentracker-usage-heatmap",
      refreshToken: "r1",
      baseUrl: "https://api.test",
      fetchImpl: async () => jsonResponse({ error: "nope" }, false, 401),
    }),
    (err) => err.code === "auth_rejected",
    "Returning null here would look identical to 'not signed in'.",
  );
});

// --- Payload cache -----------------------------------------------------------
//
// Ordinary summaries refresh after two minutes; charts after five. Manual
// refresh and successful local uploads can invalidate the account snapshot.

function makeJwtFor(sub, expSeconds) {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub, exp: expSeconds })}.sig`;
}

function countingFetch(access, payload, counter) {
  return async (urlStr) => {
    if (urlStr.includes("/api/auth/refresh")) return jsonResponse({ accessToken: access });
    counter.n += 1;
    return jsonResponse(typeof payload === "function" ? payload(counter.n) : payload);
  };
}

test("a repeat account read inside the cache window skips the cloud round trip", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwtFor("u1", Math.floor(Date.now() / 1000) + 3600);
  const counter = { n: 0 };
  const fetchImpl = countingFetch(access, (n) => ({ totals: { total_tokens: n } }), counter);
  const call = (nowMs) =>
    fetchAccountUsage({
      usageSlug: "tokentracker-usage-heatmap",
      searchParams: new URLSearchParams("weeks=52&tz=UTC"),
      baseUrl: "https://cloud.example",
      refreshToken: "r",
      fetchImpl,
      now: () => nowMs,
    });

  const first = await call(1_000_000);
  const second = await call(1_000_000 + PAYLOAD_TTL_MS - 1);
  assert.equal(counter.n, 1, "second read must not reach the edge function");
  assert.deepEqual(second.data, first.data);
});

test("the cache window expires and the next read goes back to the cloud", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwtFor("u1", Math.floor(Date.now() / 1000) + 3600);
  const counter = { n: 0 };
  const fetchImpl = countingFetch(access, (n) => ({ totals: { total_tokens: n } }), counter);
  const call = (nowMs) =>
    fetchAccountUsage({
      usageSlug: "tokentracker-usage-heatmap",
      searchParams: new URLSearchParams("weeks=52"),
      baseUrl: "https://cloud.example",
      refreshToken: "r",
      fetchImpl,
      now: () => nowMs,
    });

  await call(2_000_000);
  const after = await call(2_000_000 + PAYLOAD_TTL_MS);
  assert.equal(counter.n, 2);
  assert.deepEqual(after.data, { totals: { total_tokens: 2 } });
});

test("different query params do not share a cache entry", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwtFor("u1", Math.floor(Date.now() / 1000) + 3600);
  const counter = { n: 0 };
  const fetchImpl = countingFetch(access, (n) => ({ totals: { total_tokens: n } }), counter);
  const call = (qs) =>
    fetchAccountUsage({
      usageSlug: "tokentracker-usage-heatmap",
      searchParams: new URLSearchParams(qs),
      baseUrl: "https://cloud.example",
      refreshToken: "r",
      fetchImpl,
      now: () => 3_000_000,
    });

  await call("weeks=52");
  await call("weeks=12");
  assert.equal(counter.n, 2);
  // Param order and the local-only routing knobs must not split an entry.
  await call("weeks=12&account=1");
  assert.equal(counter.n, 2);
});

test("a different account never reads another account's cached payload", async () => {
  __resetCloudAccountCacheForTests();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const counter = { n: 0 };
  const call = (sub, refreshToken) =>
    fetchAccountUsage({
      usageSlug: "tokentracker-usage-summary",
      searchParams: new URLSearchParams("from=2026-01-01"),
      baseUrl: "https://cloud.example",
      refreshToken,
      fetchImpl: countingFetch(makeJwtFor(sub, exp), () => ({ owner: sub }), counter),
      now: () => 4_000_000,
    });

  const a = await call("user-a", "ra");
  const b = await call("user-b", "rb");
  assert.deepEqual(a.data, { owner: "user-a" });
  assert.deepEqual(b.data, { owner: "user-b" });
  assert.equal(counter.n, 2, "each account must fetch its own payload");
});

test("a cache hit still reports a refresh token rotated by that mint", async () => {
  __resetCloudAccountCacheForTests();
  const testTime = Date.now();
  const access = makeJwtFor("u1", Math.floor(testTime / 1000) + 30);
  let mints = 0;
  const fetchImpl = async (urlStr) => {
    if (urlStr.includes("/api/auth/refresh")) {
      mints += 1;
      return jsonResponse({ accessToken: access, refreshToken: `rot-${mints}`, csrfToken: `csrf-${mints}` });
    }
    return jsonResponse({ totals: {} });
  };
  const call = (refreshToken) =>
    fetchAccountUsage({
      usageSlug: "tokentracker-usage-summary",
      searchParams: new URLSearchParams(),
      baseUrl: "https://cloud.example",
      refreshToken,
      fetchImpl,
      // Within the token cache's expiry skew, even with the current refresh token.
      now: () => testTime,
    });

  await call("r0");
  const second = await call("rot-1");
  assert.equal(second.rotatedRefreshToken, "rot-2", "a rotation must survive a cache hit");
  assert.equal(second.rotatedCsrfToken, "csrf-2");
});

test("mutating a returned payload cannot corrupt the cached copy", async () => {
  __resetCloudAccountCacheForTests();
  const access = makeJwtFor("u1", Math.floor(Date.now() / 1000) + 3600);
  const counter = { n: 0 };
  const fetchImpl = countingFetch(access, { totals: { total_tokens: 7 } }, counter);
  const call = () =>
    fetchAccountUsage({
      usageSlug: "tokentracker-usage-summary",
      searchParams: new URLSearchParams(),
      baseUrl: "https://cloud.example",
      refreshToken: "r",
      fetchImpl,
      now: () => 6_000_000,
    });

  const first = await call();
  first.data.totals.total_tokens = 999;
  const second = await call();
  assert.equal(counter.n, 1);
  assert.equal(second.data.totals.total_tokens, 7);
});

// --- heatmap compact wire format ------------------------------------------
// The heatmap is the one account read whose rendered grid is far larger than
// the data behind it, so the CLI asks for the sparse form and rebuilds the grid
// locally. See src/lib/heatmap-compact.js.

test("fetchAccountFunction asks the heatmap endpoint for the compact wire format", async () => {
  const captured = {};
  const fetchImpl = async (urlStr) => {
    captured.urlStr = urlStr;
    return jsonResponse({ weeks: [] });
  };
  await fetchAccountFunction({
    baseUrl: "https://cloud.example",
    accessToken: "jwt",
    slug: "tokentracker-account-heatmap",
    searchParams: new URLSearchParams("weeks=52"),
    fetchImpl,
  });
  assert.equal(new URL(captured.urlStr).searchParams.get("format"), "compact");
});

test("fetchAccountFunction leaves the other account endpoints on their current format", async () => {
  for (const slug of [
    "tokentracker-account-summary",
    "tokentracker-account-daily",
    "tokentracker-account-model-breakdown",
  ]) {
    let urlStr = "";
    await fetchAccountFunction({
      baseUrl: "https://cloud.example",
      accessToken: "jwt",
      slug,
      searchParams: new URLSearchParams(),
      fetchImpl: async (u) => { urlStr = u; return jsonResponse({}); },
    });
    assert.equal(new URL(urlStr).searchParams.get("format"), null, `${slug} must not opt in`);
  }
});

test("fetchAccountFunction expands a compact heatmap into the rendered schema", async () => {
  const body = await fetchAccountFunction({
    baseUrl: "https://cloud.example",
    accessToken: "jwt",
    slug: "tokentracker-account-heatmap",
    searchParams: new URLSearchParams(),
    fetchImpl: async () => jsonResponse({
      format: "compact",
      from: "2026-09-01",
      to: "2026-09-07",
      week_starts_on: "sun",
      active_days: 1,
      streak_days: 0,
      max_value: 100,
      model_names: ["gpt-5.4"],
      days: [["2026-09-03", 100, [0, 100]]],
    }),
  });
  assert.equal(body.weeks.length, 1);
  assert.equal(body.weeks[0].length, 7);
  assert.equal(body.active_days, 1);
  assert.ok(!("days" in body) && !("format" in body));
  assert.deepEqual(body.weeks[0][2], {
    day: "2026-09-03",
    total_tokens: 100,
    billable_total_tokens: 100,
    level: 4,
    models: { "gpt-5.4": 100 },
  });
});

test("a heatmap response from an edge without the compact branch passes straight through", async () => {
  // New CLI, old edge: the unknown `format` param is ignored server-side and the
  // dense payload comes back as before. Nothing may be rewritten.
  const legacy = {
    from: "2026-09-01",
    to: "2026-09-07",
    week_starts_on: "sun",
    active_days: 0,
    streak_days: 0,
    weeks: [[{ day: "2026-09-01", total_tokens: 0, billable_total_tokens: 0, level: 0, models: null }]],
  };
  const body = await fetchAccountFunction({
    baseUrl: "https://cloud.example",
    accessToken: "jwt",
    slug: "tokentracker-account-heatmap",
    searchParams: new URLSearchParams(),
    fetchImpl: async () => jsonResponse(legacy),
  });
  assert.deepEqual(body, legacy);
});

test("fetchAccountUsage caches the heatmap payload already expanded", async () => {
  __resetCloudAccountCacheForTests();
  let heatmapCalls = 0;
  const fetchImpl = async (urlStr) => {
    if (urlStr.includes("/api/auth/refresh")) {
      return jsonResponse({ access_token: makeJwt({ expSeconds: Math.floor(Date.now() / 1000) + 3600 }) });
    }
    heatmapCalls += 1;
    return jsonResponse({
      format: "compact",
      from: "2026-09-01",
      to: "2026-09-07",
      week_starts_on: "sun",
      active_days: 1,
      streak_days: 0,
      max_value: 100,
      model_names: [],
      days: [["2026-09-03", 100, []]],
    });
  };
  const call = () => fetchAccountUsage({
    usageSlug: "tokentracker-usage-heatmap",
    searchParams: new URLSearchParams("weeks=52"),
    refreshToken: "r",
    fetchImpl,
  });
  const first = await call();
  const second = await call();
  assert.equal(heatmapCalls, 1, "second read inside the TTL must not hit the cloud");
  assert.deepEqual(second.data, first.data);
  assert.equal(second.data.weeks[0].length, 7, "the cached copy is the rendered grid, not the compact rows");
});

test("real HTTP account reads obey summary/chart TTLs and explicit refresh", async (t) => {
  __resetCloudAccountCacheForTests();
  const http = require("node:http");
  const counts = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/auth/refresh") {
      res.end(JSON.stringify({ accessToken: makeJwtFor("http-user", Date.now() / 1000 + 3600) }));
      return;
    }
    assert.equal(url.searchParams.has("refresh"), false, "local refresh flag does not change the edge URL");
    const count = (counts.get(url.pathname) || 0) + 1;
    counts.set(url.pathname, count);
    res.end(JSON.stringify({ totals: { total_tokens: count, total_cost_usd: "1.234567" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  let clock = Date.now();
  const read = (slug, query = "") => fetchAccountUsage({
    usageSlug: `tokentracker-usage-${slug}`, baseUrl: root, refreshToken: "http-refresh",
    searchParams: new URLSearchParams(`from=2026-10-01&to=2026-10-02${query}`), now: () => clock,
  });
  await read("summary");
  await read("daily");
  clock += 60_000;
  await Promise.all([read("summary"), read("daily")]);
  assert.equal(counts.get("/functions/tokentracker-account-summary"), 1);
  clock += SUMMARY_PAYLOAD_TTL_MS - 60_000;
  assert.equal((await read("summary")).data.totals.total_tokens, 2);
  assert.equal((await read("daily")).data.totals.total_tokens, 1);
  await read("daily", "&refresh=1");
  assert.equal((await read("daily")).data.totals.total_tokens, 2);
  clock += PAYLOAD_TTL_MS;
  assert.equal((await read("daily")).data.totals.total_tokens, 3);
});

test("real HTTP account cache keys isolate escaped query values and normalize duplicate wire params", async (t) => {
  __resetCloudAccountCacheForTests();
  const http = require("node:http");
  const queries = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/auth/refresh") {
      res.end(JSON.stringify({ accessToken: makeJwtFor("query-user", Date.now() / 1000 + 3600) }));
      return;
    }
    queries.push(url.searchParams);
    res.end(JSON.stringify({ device: url.searchParams.get("device_id"), a: url.searchParams.get("a") }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const read = (params) => fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary", refreshToken: "query-refresh",
    baseUrl: `http://127.0.0.1:${server.address().port}`, searchParams: params,
  });
  const encoded = await read(new URLSearchParams("a=ignored&device_id=D"));
  const literal = await read(new URLSearchParams({ a: "ignored&device_id=D" }));
  assert.deepEqual(encoded.data, { device: "D", a: "ignored" });
  assert.deepEqual(literal.data, { device: null, a: "ignored&device_id=D" });
  assert.equal(queries.length, 2, "literal separators must not collide with a separate device filter");
  const duplicates = await read(new URLSearchParams("a=ignored&device_id=D&device_id=E&device_id="));
  assert.deepEqual(duplicates.data, { device: "E", a: "ignored" });
  assert.deepEqual(queries[2].getAll("device_id"), ["E"], "the wire keeps the last non-empty duplicate");
  assert.deepEqual((await read(new URLSearchParams("device_id=E&a=ignored"))).data, duplicates.data);
  assert.equal(queries.length, 3, "equivalent normalized params reuse the existing response");
});

test("payload single flight shares HTTP work but isolates returned objects", async () => {
  __resetCloudAccountCacheForTests();
  let release;
  let requests = 0;
  const response = new Promise((resolve) => { release = resolve; });
  const args = {
    usageSlug: "tokentracker-usage-summary", refreshToken: "r", baseUrl: "https://cloud.example",
    fetchImpl: async (url) => {
      if (url.includes("/api/auth/refresh")) return jsonResponse({ accessToken: makeJwtFor("flight-user", Date.now() / 1000 + 3600) });
      requests += 1;
      return response;
    },
  };
  const first = fetchAccountUsage(args);
  const second = fetchAccountUsage(args);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  release(jsonResponse({ totals: { total_tokens: 9 } }));
  const [a, b] = await Promise.all([first, second]);
  a.data.totals.total_tokens = 99;
  assert.equal(b.data.totals.total_tokens, 9);
});

test("invalidation and forced reads prevent an older response from refilling the cache", async () => {
  for (const invalidate of [true, false]) {
    __resetCloudAccountCacheForTests();
    let release;
    let requests = 0;
    const oldResponse = new Promise((resolve) => { release = resolve; });
    const args = {
      usageSlug: "tokentracker-usage-summary", refreshToken: "r", baseUrl: "https://cloud.example",
      fetchImpl: async (url) => {
        if (url.includes("/api/auth/refresh")) return jsonResponse({ accessToken: makeJwtFor("race-user", Date.now() / 1000 + 3600) });
        requests += 1;
        return requests === 1 ? oldResponse : jsonResponse({ value: requests });
      },
    };
    const old = fetchAccountUsage(args);
    await new Promise((resolve) => setImmediate(resolve));
    if (invalidate) invalidateCloudAccountPayloadCache();
    const newer = await fetchAccountUsage({ ...args, searchParams: new URLSearchParams(invalidate ? "" : "refresh=1") });
    assert.equal(newer.data.value, 2);
    release(jsonResponse({ value: 1 }));
    await old;
    assert.equal((await fetchAccountUsage(args)).data.value, 2);
    assert.equal(requests, 2);
  }
});

test("an authentication rejection evicts payloads instead of serving old data", async () => {
  __resetCloudAccountCacheForTests();
  let requests = 0;
  const args = {
    usageSlug: "tokentracker-usage-summary", refreshToken: "r", baseUrl: "https://cloud.example",
    fetchImpl: async (url) => {
      if (url.includes("/api/auth/refresh")) return jsonResponse({ accessToken: makeJwtFor("reject-user", Date.now() / 1000 + 3600) });
      requests += 1;
      return requests === 2 ? jsonResponse({}, false, 401) : jsonResponse({ value: requests });
    },
  };
  await fetchAccountUsage(args);
  await assert.rejects(fetchAccountUsage({ ...args, searchParams: new URLSearchParams("refresh=1") }), { status: 401 });
  assert.equal((await fetchAccountUsage(args)).data.value, 3);
});

test("a session invalidated during mint cannot repopulate its payload cache", async () => {
  __resetCloudAccountCacheForTests();
  let release;
  const mint = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  let persisted = 0;
  const pending = fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary", refreshToken: "r", baseUrl: "https://cloud.example",
    onSessionRefreshed: () => { persisted += 1; },
    fetchImpl: async (url) => {
      if (url.includes("/api/auth/refresh")) return mint;
      requests += 1;
      return jsonResponse({ value: 1 });
    },
  });
  invalidateCloudAccountPayloadCache({ sessionChanged: true });
  release(jsonResponse({ accessToken: makeJwtFor("old-user", Date.now() / 1000 + 3600), refreshToken: "rotated-old", csrfToken: "csrf-old" }));
  await assert.rejects(pending, { code: "auth_session_changed" });
  assert.equal(requests, 0);
  assert.equal(persisted, 0, "a stale mint must not persist credentials into the new session");
});

test("account reads await rotated-session persistence before starting the cloud GET", async () => {
  __resetCloudAccountCacheForTests();
  let release;
  const persistence = new Promise((resolve) => { release = resolve; });
  let started;
  const persistenceStarted = new Promise((resolve) => { started = resolve; });
  let session;
  let edgeCalls = 0;
  const pending = fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary", refreshToken: "before", baseUrl: "https://cloud.example",
    fetchImpl: async (url) => {
      if (url.includes("/api/auth/refresh")) {
        return jsonResponse({ accessToken: makeJwtFor("persist-user", Date.now() / 1000 + 3600), refreshToken: "after", csrfToken: "csrf-after" });
      }
      edgeCalls += 1;
      assert.deepEqual(session, { refreshToken: "after", csrfToken: "csrf-after" });
      return jsonResponse({ value: 123 });
    },
    onSessionRefreshed: async (rotation) => {
      started();
      await persistence;
      session = rotation;
    },
  });
  await persistenceStarted;
  assert.equal(edgeCalls, 0);
  release();
  assert.deepEqual((await pending).data, { value: 123 });
  assert.equal(edgeCalls, 1);
});

test("a late response from a signed-out account returns neither data nor rotated credentials", async () => {
  __resetCloudAccountCacheForTests();
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const old = fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary", baseUrl: "https://cloud.example", refreshToken: "a",
    fetchImpl: async (url) => url.includes("/api/auth/refresh")
      ? jsonResponse({ accessToken: makeJwtFor("user-a", Date.now() / 1000 + 3600), refreshToken: "rotated-a" })
      : response,
  });
  await new Promise((resolve) => setImmediate(resolve));
  invalidateCloudAccountPayloadCache({ sessionChanged: true });
  const newer = await fetchAccountUsage({
    usageSlug: "tokentracker-usage-summary", baseUrl: "https://cloud.example", refreshToken: "b",
    fetchImpl: countingFetch(makeJwtFor("user-b", Date.now() / 1000 + 3600), { owner: "b" }, { n: 0 }),
  });
  assert.deepEqual(newer.data, { owner: "b" });
  release(jsonResponse({ owner: "a" }));
  await assert.rejects(old, { code: "auth_session_changed" });
});
