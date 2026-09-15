"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.join(__dirname, "..");
const readEdge = (name) => fs.readFileSync(path.join(root, "dashboard/edge-patches", `tokentracker-${name}.ts`), "utf8");

function loadEdge(name, client = {}, extra = "") {
  const source = readEdge(name).replace(/import \{ createClient \} from "npm:@insforge\/sdk";/, "const createClient = () => globalThis.client;") + extra;
  const context = { module: { exports: {} }, client, console, Request, Response, URL, TextEncoder,
    crypto: require("node:crypto").webcrypto, atob, btoa,
    Deno: { env: { get: (key) => key === "LEADERBOARD_BLOCKED_USER_IDS" ? "" : "test" } } };
  vm.runInNewContext(transformSync(source, { loader: "ts", format: "cjs" }).code, context);
  return context.module.exports;
}
const complete = { bucket: "2026-09-12", source: "vscode-copilot", model: "gpt-5.4", input_tokens: 100,
  output_tokens: 20, cached_input_tokens: 30, cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
  total_tokens: 150, conversations: 1 };
const partial = { ...complete, input_tokens: 0, unclassified_input_tokens: 100, total_tokens: 150 };

for (const name of ["account-summary", "account-daily", "leaderboard-refresh", "leaderboard-profile"]) {
  test(`${name}: unknown input is excluded from the known subtotal`, () => {
    const api = loadEdge(name, {}, "\nexport { computeRowCost, costFields };");
    const known = api.computeRowCost(partial);
    assert.ok(known > 0);
    assert.ok(known < api.computeRowCost(complete));
    assert.equal(api.costFields(known, 100).total_cost_usd, null);
    assert.equal(api.costFields(known, 100).known_cost_usd, known);
    assert.equal(api.costFields(known, 100).cost_status, "partial");
    assert.equal(api.costFields(known, 0).total_cost_usd, known);
    assert.equal(api.computeRowCost({ ...partial, source: "grok", total_cost_usd: 999 }),
      api.computeRowCost({ ...partial, source: "grok" }));
    assert.equal(api.computeRowCost({ ...complete, source: "grok", total_cost_usd: 999 }), 999);
  });
}

for (const name of ["account-summary", "account-daily", "account-model-breakdown", "account-hourly", "account-monthly"]) {
  test(`${name}: mixed RPC rows retain the disjoint column in the response`, async () => {
    const rows = [complete, partial].map(r => ({ ...r, bucket: name === "account-hourly" ? "2026-09-12T01:00:00" : name === "account-monthly" ? "2026-09" : r.bucket }));
    const client = { database: { rpc: async () => ({ data: rows, error: null }) } };
    const api = loadEdge(name, client, '\nverifiedUserIdFromJwt = async () => "user";');
    const query = name === "account-hourly"
      ? "day=2026-09-12&tz=UTC"
      : "from=2026-09-12&to=2026-09-12&tz=UTC";
    const response = await api.default(new Request(`https://test/?${query}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const totals = name === "account-model-breakdown" ? body.sources[0].totals : body.totals || body.data[0];
    assert.equal(totals.unclassified_input_tokens, 100);
    assert.equal(totals.input_tokens, 100);
    if (!["account-hourly", "account-monthly"].includes(name)) {
      assert.equal(totals.total_cost_usd, null);
      assert.equal(totals.cost_status, "partial");
      assert.ok(Number(totals.known_cost_usd) > 0);
    }
    if (body.sources) assert.equal(body.sources[0].models[0].totals.cost_status, "partial");
  });
}

test("ingestion accepts old rows, rejects malformed unknown counts, and keeps whole-row MAX dedup", async () => {
  let written;
  const client = { database: { from: (table) => {
    const query = { select: () => query, eq: () => query, is: () => query, limit: () => query,
      maybeSingle: async () => ({ data: table === "tokentracker_device_tokens" ? { user_id: "u", device_id: "d" } : null }),
      upsert: async rows => { written = rows; return {}; } };
    return query;
  } } };
  const api = loadEdge("ingest", client);
  const send = buckets => api.default(new Request("https://test", { method: "POST", headers: { Authorization: "Bearer test" }, body: JSON.stringify({ buckets }) }));
  assert.equal((await send([{ ...complete, hour_start: "2026-09-12T01:00:00Z" }])).status, 200);
  assert.equal(written[0].unclassified_input_tokens, 0);
  assert.equal((await send([{ ...partial, total_tokens: 200 }, complete])).status, 200);
  assert.equal(written.length, 1);
  assert.equal(written[0].unclassified_input_tokens, 100);
  assert.equal(written[0].total_cost_usd, null);
  for (const value of [-1, 0.5, "10", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await send([{ ...partial, unclassified_input_tokens: value }])).status, 400);
  }
});

test("ingestion advertises the accounting contract before accepting partial rows", async () => {
  const api = loadEdge("ingest");
  const response = await api.default(new Request("https://test/?capabilities=1"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    accounting_version: 3,
    unclassified_input_tokens: true,
  });
});

test("device identity refresh carries disjoint input through hourly-row convergence", () => {
  const sql = fs.readFileSync(
    path.join(root, "migrations/20260912120000_unclassified-input-tokens.sql"),
    "utf8",
  );
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.refresh_tokentracker_device_identity");
  const end = sql.indexOf("CREATE OR REPLACE FUNCTION public.tokentracker_upsert_account_session_states", start);
  assert.ok(start >= 0 && end > start);
  const refresh = sql.slice(start, end);
  assert.match(refresh, /input_tokens,\s*unclassified_input_tokens,\s*cached_input_tokens/s);
  assert.match(refresh, /ranked\.unclassified_input_tokens/);
  assert.match(refresh, /unclassified_input_tokens = EXCLUDED\.unclassified_input_tokens/);
});

// Optional local PostgreSQL runtime. No network or deployed DB is used by this test.
test("migration executes and preserves disjoint input through dedup, rollups, corrections and shards", {
  skip: !process.env.TOKENTRACKER_TEST_PGLITE,
}, async () => {
  const { PGlite } = require(process.env.TOKENTRACKER_TEST_PGLITE);
  const db = new PGlite();
  try {
    const tokens = "total_tokens bigint default 0, input_tokens bigint default 0, output_tokens bigint default 0, cached_input_tokens bigint default 0, cache_creation_input_tokens bigint default 0, reasoning_output_tokens bigint default 0";
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin;
      CREATE TABLE tokentracker_devices (id uuid primary key, user_id uuid, revoked_at timestamptz);
      CREATE TABLE tokentracker_device_machine (device_id uuid, machine_cluster_id text);
      CREATE TABLE tokentracker_hourly (user_id uuid, device_id uuid, hour_start timestamptz, source text, model text, ${tokens}, conversations bigint default 0, total_cost_usd numeric NOT NULL DEFAULT 0, updated_at timestamptz default now());
      CREATE TABLE tokentracker_account_session_states (user_id uuid, source text, session_id text, model text, bucket_start timestamptz, ${tokens}, snapshot_verified_at timestamptz, updated_at timestamptz default now(), PRIMARY KEY(user_id, source, session_id), CHECK(total_tokens = input_tokens + cached_input_tokens + cache_creation_input_tokens + output_tokens));
      CREATE TABLE tokentracker_leaderboard_rollup_daily_v2 (user_id uuid, source text, model text, day date, pricing_tier text, ${tokens}, PRIMARY KEY(user_id, source, model, day, pricing_tier));
      CREATE TABLE tokentracker_leaderboard_rollup_total_v2 (user_id uuid, source text, model text, pricing_tier text, ${tokens}, PRIMARY KEY(user_id, source, model, pricing_tier));
      CREATE TABLE tokentracker_leaderboard_rollup_meta_v2 (id integer, through timestamptz);
      CREATE TABLE tokentracker_leaderboard_snapshots (estimated_cost_usd numeric NOT NULL);
      CREATE TABLE tokentracker_account_usage_cache (cache_key text);
      CREATE FUNCTION leaderboard_pricing_tier(text,timestamptz) RETURNS text LANGUAGE sql AS $$ SELECT 'peak'::text $$;
    `);
    await db.exec(fs.readFileSync(path.join(root, "migrations/20260912120000_unclassified-input-tokens.sql"), "utf8"));
    await db.exec(`
      CREATE TRIGGER test_insert AFTER INSERT ON tokentracker_leaderboard_rollup_daily_v2 REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION leaderboard_rollup_total_v2_after_insert();
      CREATE TRIGGER test_delete AFTER DELETE ON tokentracker_leaderboard_rollup_daily_v2 REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION leaderboard_rollup_total_v2_after_delete();
      CREATE TRIGGER test_update AFTER UPDATE ON tokentracker_leaderboard_rollup_daily_v2 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION leaderboard_rollup_total_v2_after_update();
    `);
    const user = "00000000-0000-0000-0000-000000000001", device = "00000000-0000-0000-0000-000000000002", mirror = "00000000-0000-0000-0000-000000000003";
    await db.exec(`INSERT INTO tokentracker_devices VALUES ('${device}','${user}',null), ('${mirror}','${user}',null);
      INSERT INTO tokentracker_device_machine VALUES ('${device}','machine'), ('${mirror}','machine');
      INSERT INTO tokentracker_hourly(user_id,device_id,hour_start,source,model,total_tokens,input_tokens,output_tokens,unclassified_input_tokens)
      VALUES ('${user}','${device}','2026-09-11T01:00:00Z','vscode-copilot','gpt-5.4',120,0,20,100),
      ('${user}','${mirror}','2026-09-11T01:00:00Z','vscode-copilot','gpt-5.4',120,0,20,100);
      INSERT INTO tokentracker_leaderboard_rollup_meta_v2 VALUES (1,'2026-09-12T00:00:00Z');`);
    const account = await db.query(`SELECT account_usage_grouped($1, ARRAY[$2::uuid,$3::uuid], '2026-09-11T00:00:00Z', '2026-09-12T00:00:00Z', 'day', 'UTC', 0) AS rows`,[user,device,mirror]);
    assert.equal(account.rows[0].rows[0].unclassified_input_tokens, 100);
    assert.equal(account.rows[0].rows[0].total_tokens, 120);
    const state = { source: "trae-cn", session_id: "session", model: "gpt-5.4", bucket_start: "2026-09-11T01:00:00Z", snapshot_verified_at: "2026-09-12T01:00:00Z", input_tokens: 10, output_tokens: 20, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 30 };
    const upsertState = value => db.query("SELECT tokentracker_upsert_account_session_states($1,$2::jsonb)", [user, JSON.stringify([value])]);
    await upsertState(state); // Legacy session writers need no new field.
    await upsertState({ ...state, unclassified_input_tokens: 50, total_tokens: 80, snapshot_verified_at: "2026-09-12T02:00:00Z" });
    await upsertState(state); // Older observation cannot clear partial input.
    assert.equal(Number((await db.query("SELECT unclassified_input_tokens FROM tokentracker_account_session_states")).rows[0].unclassified_input_tokens), 50);
    const mixed = await db.query(`SELECT account_usage_grouped($1, ARRAY[$2::uuid,$3::uuid], '2026-09-11T00:00:00Z', '2026-09-12T00:00:00Z', 'day', 'UTC', 0) AS rows`,[user,device,mirror]);
    assert.equal(mixed.rows[0].rows.reduce((sum, row) => sum + row.unclassified_input_tokens, 0), 150);
    await db.exec("SELECT leaderboard_rollup_daily_replace_v2('2026-09-11T00:00:00Z','2026-09-12T00:00:00Z')");
    const shard = await db.query("SELECT leaderboard_usage_grouped_total_shard('2026-09-12T00:00:00Z',null,null) AS rows");
    assert.equal(shard.rows[0].rows.reduce((sum, row) => sum + row.unclassified_input_tokens, 0), 150);
    for (const fn of ["leaderboard_usage_grouped", "leaderboard_usage_grouped_v3"]) {
      const grouped = await db.query(`SELECT ${fn}('2026-09-11T00:00:00Z', '2026-09-12T00:00:00Z') AS rows`);
      assert.equal(grouped.rows[0].rows.reduce((sum, row) => sum + row.unclassified_input_tokens, 0), 150);
    }
    await db.exec("SELECT leaderboard_rollup_daily_replace_v3('2026-09-11T00:00:00Z','2026-09-12T00:00:00Z')");
    await db.exec("UPDATE tokentracker_leaderboard_rollup_daily_v2 SET unclassified_input_tokens = 60");
    assert.equal(Number((await db.query("SELECT unclassified_input_tokens FROM tokentracker_leaderboard_rollup_total_v2")).rows[0].unclassified_input_tokens),60);
    await db.exec("DELETE FROM tokentracker_leaderboard_rollup_daily_v2");
    assert.equal((await db.query("SELECT * FROM tokentracker_leaderboard_rollup_total_v2")).rows.length,0);
    assert.equal((await db.query("SELECT has_function_privilege('authenticated', 'leaderboard_hourly_dedup_v2_unclassified(timestamptz,timestamptz)', 'EXECUTE') AS allowed")).rows[0].allowed,false);
  } finally { await db.close(); }
});
