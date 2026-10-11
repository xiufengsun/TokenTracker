const assert = require("node:assert/strict");
const http = require("node:http");
const { it } = require("node:test");
const { fetchZcodeResetCredits, normalizeZcodeResetCredits } = require("../src/lib/zcode-reset-credits");

const nowMs = Date.parse("2026-10-07T12:00:00Z");
const early = Date.parse("2026-10-18T10:00:00Z");
const late = Date.parse("2026-10-19T10:00:00Z");
const body = () => ({ code: 0, data: {
  available_five_hour_resets: [
    { expire_at: late, private_id: "discard" }, { expire_at: early }, { expire_at: early },
    { expire_at: nowMs - 1 },
  ],
  available_week_resets: [{ expire_at: late }],
  latest_five_hour_reset_history: { used_at: nowMs - 1000, private_id: "discard" },
} });

it("keeps the two reset pools separate, preserves distinct cards, and strips private fields", () => {
  assert.deepEqual(normalizeZcodeResetCredits(body(), { nowMs }), {
    five_hour: [
      { expires_at: new Date(early).toISOString() },
      { expires_at: new Date(early).toISOString() },
      { expires_at: new Date(late).toISOString() },
    ],
    weekly: [{ expires_at: new Date(late).toISOString() }],
  });
});

it("rejects malformed inventories instead of reporting zero available cards", () => {
  for (const value of [
    { code: 1, data: {} },
    { code: 0, data: { available_week_resets: [] } },
    { code: 0, data: { available_five_hour_resets: [{ expire_at: "not-a-date" }], available_week_resets: [] } },
  ]) {
    assert.throws(() => normalizeZcodeResetCredits(value), /Could not parse ZCode reset credits/);
  }
  assert.deepEqual(normalizeZcodeResetCredits({ code: 0, data: {
    available_five_hour_resets: [], available_week_resets: [],
  } }), { five_hour: [], weekly: [] });
});

it("uses only the read-only status endpoint and scopes team inventory", async () => {
  const out = await fetchZcodeResetCredits({
    zcodeToken: "zcode-jwt", codingPlanToken: "regional-jwt",
    teamContext: { organizationId: "org", projectId: "project" }, nowMs,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://zcode.z.ai/api/v1/coding-plan/reset/status");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(options.headers, {
        Authorization: "Bearer zcode-jwt", "X-Bigmodel-Authorization": "regional-jwt",
        "Bigmodel-Target-Type": "TEAM", "Bigmodel-Organization": "org",
        "Bigmodel-Project": "project", Accept: "application/json",
      });
      return { ok: true, async json() { return body(); } };
    },
  });
  assert.equal(out.five_hour.length, 3);
  assert.equal(out.weekly.length, 1);
});

it("rejects redirects without sending credentials to their destination", async () => {
  let destinationRequests = 0;
  const destination = http.createServer((_req, res) => {
    destinationRequests += 1;
    res.end("{}");
  });
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const origin = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/status` });
    res.end();
  });
  try {
    await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
    await assert.rejects(fetchZcodeResetCredits({
      zcodeToken: "fixture-zcode-token", codingPlanToken: "fixture-regional-token",
      fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${origin.address().port}/status`, options),
    }));
    assert.equal(destinationRequests, 0);
  } finally {
    origin.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => origin.close(resolve)),
      new Promise((resolve) => destination.close(resolve)),
    ]);
  }
});

it("surfaces HTTP and API errors without exposing the upstream response", async () => {
  for (const response of [
    { ok: false, status: 401 },
    { ok: true, async json() { return { code: 123, msg: "private response" }; } },
  ]) {
    await assert.rejects(fetchZcodeResetCredits({
      zcodeToken: "Bearer zcode-jwt", codingPlanToken: "regional-jwt",
      fetchImpl: async () => response,
    }), (error) => /ZCode reset credits API/.test(error.message) && !error.message.includes("private"));
  }
});

it("bounds a stalled optional inventory request and aborts its connection", async () => {
  let signal;
  await assert.rejects(fetchZcodeResetCredits({
    zcodeToken: "zcode-jwt", codingPlanToken: "regional-jwt", timeoutMs: 10,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  }), /timed out/);
  assert.equal(signal.aborted, true);
});
