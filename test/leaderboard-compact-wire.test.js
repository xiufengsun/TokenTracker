"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const edge = fs.readFileSync(path.join(root, "dashboard/edge-patches/tokentracker-leaderboard-refresh.ts"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations/20261002082317_compact-leaderboard-usage-wire.sql"), "utf8");
const decoderSource = edge.slice(edge.indexOf("function decodeCompactLeaderboardUsage("), edge.indexOf("interface UserAgg"))
  .replace("payload: CompactLeaderboardUsage): HourlyRow[]", "payload)");
const decode = vm.runInNewContext(`${decoderSource}\ndecodeCompactLeaderboardUsage;`);
const plain = (value) => JSON.parse(JSON.stringify(value));

function payload() {
  return {
    format: "leaderboard-usage-v1",
    user_ids: ["user-a", "user-b"],
    sources: ["codex", "cursor", "opencode"],
    model_names: ["gpt-5.4", "deepseek-v4-pro"],
    pricing_tiers: [null, "off_peak", "peak"],
    rows: [
      [0, 0, 0, 0, 430, 100, 200, 80, 50, 150, null],
      [0, 2, 1, 1, 300, 100, 200, 0, 0, 0, 0.125],
      [0, 2, 1, 2, 300, 100, 200, 0, 0, 0, null],
      [1, 1, 0, 0, 9007199254740991, 0, 0, 9007199254740991, 0, 0, null],
    ],
  };
}

test("compact decoding keeps every token column, account and pricing tier separate", () => {
  assert.deepEqual(plain(decode(payload())), [
    { user_id: "user-a", source: "codex", model: "gpt-5.4", total_tokens: 430, input_tokens: 100, output_tokens: 200, cached_input_tokens: 80, cache_creation_input_tokens: 50, reasoning_output_tokens: 150 },
    { user_id: "user-a", source: "opencode", model: "deepseek-v4-pro", total_tokens: 300, input_tokens: 100, output_tokens: 200, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, pricing_tier: "off_peak", total_cost_usd: 0.125 },
    { user_id: "user-a", source: "opencode", model: "deepseek-v4-pro", total_tokens: 300, input_tokens: 100, output_tokens: 200, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, pricing_tier: "peak" },
    { user_id: "user-b", source: "cursor", model: "gpt-5.4", total_tokens: 9007199254740991, input_tokens: 0, output_tokens: 0, cached_input_tokens: 9007199254740991, cache_creation_input_tokens: 0, reasoning_output_tokens: 0 },
  ]);
});

test("each total shard expands its own dictionary before concatenation", () => {
  const first = payload();
  const second = payload();
  second.user_ids.reverse();
  second.model_names.reverse();
  second.rows = [[0, 0, 0, 0, 1, 1, 0, 0, 0, 0, null]];
  const rows = [...decode(first), ...decode(second)];
  assert.equal(rows.at(-1).user_id, "user-b");
  assert.equal(rows.at(-1).model, "deepseek-v4-pro");
  assert.match(edge, /totalRows\.push\(\.\.\.decodeCompactLeaderboardUsage\(result\.data as CompactLeaderboardUsage\)\)/);
});

test("a malformed dictionary response fails instead of replacing the snapshot with partial data", () => {
  for (const broken of [null, {}, { ...payload(), format: "other" }, { ...payload(), sources: null }]) {
    assert.throws(() => decode(broken), /Invalid compact leaderboard payload/);
  }
  for (const index of [-1, 999, 0.5, "0"]) {
    const broken = payload();
    broken.rows[0][0] = index;
    assert.throws(() => decode(broken), /Invalid compact leaderboard row/);
  }
  const broken = payload();
  broken.rows[0].pop();
  assert.throws(() => decode(broken), /Invalid compact leaderboard row/);
});

test("empty results remain empty and do not acquire a synthetic user", () => {
  assert.deepEqual(plain(decode({ format: "leaderboard-usage-v1", user_ids: [], sources: [], model_names: [], pricing_tiers: [], rows: [] })), []);
});

test("the compact RPCs delegate to the existing aggregation and keep admin-only execution", () => {
  assert.match(migration, /leaderboard_usage_pack\(public\.leaderboard_usage_grouped\(p_from, p_to\)\)/);
  assert.match(migration, /public\.leaderboard_usage_grouped_total_shard\(p_to, p_user_from, p_user_to\)/);
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.leaderboard_usage_grouped\(/.test(migration), "the legacy RPC must remain untouched");
  assert.ok(!/SECURITY DEFINER|price\s*\*|CASE.*off_peak/.test(migration), "packing must not add permissions or calculate prices");
  assert.match(migration, /WITH ORDINALITY AS entries\(e, ord\)/);
  assert.match(migration, /ORDER BY r\.ord\)/, "preserve the summation order so cost rounding cannot change");
  for (const signature of ["leaderboard_usage_pack(jsonb)", "leaderboard_usage_compact(timestamptz, timestamptz)", "leaderboard_usage_compact_total_shard(timestamptz, uuid, uuid)"]) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped}\\s+FROM PUBLIC, anon, authenticated;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO project_admin;`));
  }
});
