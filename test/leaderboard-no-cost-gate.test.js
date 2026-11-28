"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { buildSync } = require("esbuild");
const user = "12345678-1234-1234-1234-123456789abc";
const compact = {
  format: "leaderboard-usage-v1",
  user_ids: [user],
  sources: ["grok", "claude"],
  model_names: ["grok-4.7", "claude-sonnet"],
  pricing_tiers: ["peak", "peak"],
  rows: [
    [0, 0, 0, 0, 300, 300, 0, 0, 0, 0, 0.37],
    [0, 1, 1, 1, 50, 50, 0, 0, 0, 0, null],
  ],
};
function fixture() {
  const calls = [], writes = [], events = [];
  const snapshots = new Map();
  const client = { database: { rpc: async (name, args = {}) => {
    calls.push({ name, args });
    if (name === "usage_cost_provenance_v1") throw Error("Grok cost provenance must not gate refresh");
    if (name === "leaderboard_refresh_try_claim") return { data: true, error: null };
    if (name === "leaderboard_rollup_daily_advance_v2") return { data: null, error: null };
    if (name === "leaderboard_usage_compact" || name === "leaderboard_usage_compact_total_shard") {
      return { data: structuredClone(compact), error: null };
    }
    if (name === "leaderboard_user_metadata") {
      return { data: [{ user_id: user, leaderboard_public: true, leaderboard_anonymous: false,
        github_url: null, show_github_url: false, display_name: "Test", avatar_url: null }], error: null };
    }
    throw Error("Unexpected RPC " + name);
  }, from: table => {
    if (table === "tokentracker_leaderboard_anomaly_flags") return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
    assert.equal(table, "tokentracker_leaderboard_snapshots");
    const filters = {};
    const chain = {
      upsert: async rows => { for (const row of rows) { writes.push({ kind: "upsert", period: row.period, row }); snapshots.set(row.period, { ...row }); } return { error: null }; },
      delete: () => chain, eq: (key, value) => { filters[key] = value; return chain; },
      lt: () => chain, then: (ok, bad) => { writes.push({ kind: "delete-stale", period: filters.period }); return Promise.resolve({ error: null }).then(ok, bad); },
    };
    return chain;
  } } };
  const mod = { exports: {} };
  const code = buildSync({ entryPoints: [require.resolve("../dashboard/edge-patches/tokentracker-leaderboard-refresh.ts")],
    bundle: true, platform: "node", format: "cjs", external: ["npm:@insforge/sdk"], write: false }).outputFiles[0].text;
  const env = { INSFORGE_BASE_URL: "https://fixture.invalid", INSFORGE_SERVICE_ROLE_KEY: "fixture-service",
    LEADERBOARD_REFRESH_SECRET: "fixture-refresh", LEADERBOARD_BLOCKED_USER_IDS: "00000000-0000-0000-0000-000000000001" };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Request, Response, Headers, URL, TextEncoder, TextDecoder,
    crypto: require("node:crypto").webcrypto, atob, Deno: { env: { get: name => env[name] } },
    console: { log: line => { try { events.push(JSON.parse(line)); } catch {} }, warn() {}, error() {} },
    require: name => { assert.equal(name, "npm:@insforge/sdk"); return { createClient: () => client }; } });
  return { calls, writes, events, snapshots, invoke: async body => mod.exports.default(new Request("https://fixture.invalid/refresh", {
    method: "POST", headers: { "Content-Type": "application/json", "x-refresh-secret": "fixture-refresh" }, body: JSON.stringify(body),
  })) };
}
for (const period of ["week", "month", "total"]) test(`${period} refresh succeeds without calling usage_cost_provenance_v1`, async () => {
  const f = fixture(), response = await f.invoke({ period });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.results[period].upserted > 0, true);
  assert.equal(f.calls.some(c => c.name === "usage_cost_provenance_v1"), false);
  const snap = f.snapshots.get(period);
  assert.equal(snap.total_tokens, period === "total" ? 350 * 8 : 350);
  assert.equal(snap.estimated_cost_usd >= 0.37, true);
  assert.ok(typeof snap.generated_at === "string" && snap.generated_at.length > 0);
});
test("default cron refreshes week, month and total without Grok cost gate", async () => {
  const f = fixture(), response = await f.invoke({});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.week.upserted > 0, true);
  assert.equal(body.results.month.upserted > 0, true);
  assert.equal(body.results.total.upserted > 0, true);
  assert.equal(f.calls.some(c => c.name === "usage_cost_provenance_v1"), false);
  assert.deepEqual(f.calls.filter(c => c.name === "leaderboard_refresh_try_claim").map(c => c.args.p_period), ["week", "month", "total"]);
});
