"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createHash, createHmac, webcrypto } = require("node:crypto");
const { buildSync } = require("esbuild");
const { fixture, row } = require("./helpers/cloud-cost-fixture");
const { migration, functionSql } = require("./helpers/cloud-usage-archive-fixture");
const { eventCostCoverage, mergeCostCoverage } = require("../src/lib/cost-provenance");
const { drainQueueToCloud } = require("../src/commands/sync");
const edgeDir = path.join(__dirname, "../dashboard/edge-patches");
function edge(name, client, exports = "") {
  const contents = syncFs.readFileSync(path.join(edgeDir, name + ".ts"), "utf8") + exports;
  const code = buildSync({ stdin: { contents, loader: "ts", resolveDir: edgeDir }, bundle: true,
    external: ["npm:@insforge/sdk"], platform: "node", format: "cjs", write: false }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Request, Response, Headers, URL,
    TextEncoder, TextDecoder, Uint8Array, atob, crypto: webcrypto, console,
    Deno: { env: { get: n => ({ TOKENTRACKER_BILLING_ENVIRONMENT: "sandbox", INSFORGE_BASE_URL: "https://fixture.invalid",
      INSFORGE_SERVICE_ROLE_KEY: "fixture-role", JWT_SECRET: "fixture-secret" })[n] } },
    require: name => { assert.equal(name, "npm:@insforge/sdk"); return { createClient: () => client }; } });
  return module.exports;
}
function bridge(f) {
  return { database: {
    rpc: async (name, args = {}) => {
      assert.match(name, /^[a-z0-9_]+$/);
      const entries = Object.entries(args);
      const values = entries.map(([, v]) => v != null && typeof v === "object" ? JSON.stringify(v) : v);
      const named = entries.map(([k], i) => { assert.match(k, /^p_[a-z0-9_]+$/); return `${k}=>$${i + 1}`; }).join(",");
      try {
        const results = (await f.db.query(`SELECT public.${name}(${named}) result`, values)).rows;
        return { data: results[0].result, error: null };
      } catch (e) { return { data: null, error: { message: e.message } }; }
    },
    from: table => {
      assert.ok(["tokentracker_device_tokens", "tokentracker_devices"].includes(table));
      const filters = []; let limit = "", single = false;
      const result = async () => {
        const values = [], conditions = filters.map(([k, v]) => {
          assert.ok(["token_hash", "user_id", "revoked_at"].includes(k));
          if (v == null) return `${k} IS NULL`; values.push(v); return `${k}=$${values.length}`;
        });
        const rows = (await f.db.query(`SELECT * FROM ${table} WHERE ${conditions.join(" AND ")} ${limit}`, values)).rows;
        return { data: single ? rows[0] || null : rows, error: null };
      };
      const chain = { select: () => chain, eq: (k, v) => { filters.push([k, v]); return chain; },
        is: (k, v) => { filters.push([k, v]); return chain; }, limit: n => { assert.equal(n, 1); limit = "LIMIT 1"; return chain; },
        maybeSingle: () => { single = true; return result(); }, then: (ok, bad) => result().then(ok, bad) };
      return chain;
    },
  } };
}
async function compactFunctions(f) {
  for (const name of ["20260918041500_fold-account-summary-and-heatmap-aggregation.sql", "20260918043000_fold-account-model-breakdown-aggregation.sql",
    "20260918050000_fold-account-daily-aggregation.sql", "20261002090000_compact-account-model-wire.sql", "20261003093000_compact-account-summary-model-wire.sql",
    "20261102090000_add-conversations-to-account-model-breakdown-wire.sql"]) {
    const sql = migration(name);
    for (const [, name] of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)) await f.db.exec(functionSql(sql, name));
  }
  await f.db.exec(functionSql(migration("20261008120000_self-hosted-access.sql"), "cloud_account_access"));
}
function authorization(user) {
  const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const text = enc({ alg: "HS256" }) + "." + enc({ sub: user, role: "authenticated", exp: Date.now() / 1000 + 60 });
  return "Bearer " + text + "." + createHmac("sha256", "fixture-secret").update(text).digest("base64url");
}
test("real queue -> ingest handler -> SQL -> account APIs/profile/leaderboard calculation preserves cost semantics", async () => {
  const f = await fixture(); const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cost-e2e-")); const originalFetch = global.fetch;
  try {
    await compactFunctions(f);
    const client = bridge(f), ingest = edge("tokentracker-ingest", client);
    const uploadToken = "synthetic-upload-token", hash = createHash("sha256").update(uploadToken).digest("hex");
    await f.db.query("UPDATE tokentracker_device_tokens SET token_hash=$1 WHERE token_hash=$2", [hash, f.token]);
    const zero = row(0, 1000000), missing = row(null, 1000000); missing.hour_start = "2026-01-02T02:30:00Z";
    // One model has both reported-zero and uncovered cache-inclusive tokens.
    const mixed = row(0.25, 2000000); mixed.cached_input_tokens = 400000; mixed.output_tokens = 100000;
    mixed.total_tokens = 2500000; mixed.billable_total_tokens = 2500000; mixed.model = "grok-4.7-build-fast";
    const a = { ...mixed, input_tokens: 1000000, cached_input_tokens: 200000, output_tokens: 50000 };
    const aggregate = { ...a, cost_coverage: eventCostCoverage(a, 0.25, "grok_usd") };
    mergeCostCoverage(aggregate, { ...a, cost_coverage: eventCostCoverage(a, null, "grok_usd") });
    mixed.cost_coverage = aggregate.cost_coverage;
    assert.equal(mixed.cost_coverage.missing_events, 1);
    const bot = row(0.37, 0); bot.source = "cursor"; bot.model = "grok-bot-default"; bot.cost_coverage = eventCostCoverage(bot, 0.37, "cursor_total_cents");
    const unknown = row(null, 100); unknown.source = "cursor"; unknown.model = "grok-bot-unreleased"; unknown.cost_coverage = eventCostCoverage(unknown, null, "cursor_total_cents");
    const free = row(99); free.model = "grok-build-free"; free.cost_coverage = eventCostCoverage(free, 99, "grok_usd");
    const allocated = row(0.13); allocated.model = "opaque-grok-build"; allocated.cost_coverage = eventCostCoverage(allocated, 0.13, "grok_allocated", true);
    const outside = row(null, 1000000); outside.hour_start = "2026-01-02T20:00:00Z";
    const rows = [zero, missing, mixed, bot, unknown, free, allocated, outside];
    const queuePath = path.join(dir, "queue.jsonl"), queueStatePath = path.join(dir, "queue-state.json");
    await fs.writeFile(queuePath, rows.map(JSON.stringify).join("\n") + "\n");
    const requests = [];
    global.fetch = async (url, options) => { requests.push(JSON.parse(options.body)); return ingest.default(new Request(url, options)); };
    const upload = await drainQueueToCloud({ baseUrl: "https://fixture.invalid", anonKey: "fixture-public", deviceToken: uploadToken, queuePath, queueStatePath });
    assert.equal(upload.inserted, rows.length);
    assert.equal(requests[0].kind, "cost_capabilities"); assert.equal(requests[1].cost_coverage_version, 1);
    assert.ok(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset > 0);
    const evidence = await f.call("usage_cost_provenance_v1", [f.user, null, "2026-01-01T16:00:00Z", "2026-01-02T16:00:00Z", "all", "Asia/Singapore", 480]);
    const summary = edge("tokentracker-account-summary", client), daily = edge("tokentracker-account-daily", client), models = edge("tokentracker-account-model-breakdown", client);
    const params = "?from=2026-01-02&to=2026-01-02&tz=Asia%2FSingapore&tz_offset_minutes=480";
    const payloads = [];
    for (const endpoint of [summary, daily, models]) {
      const response = await endpoint.default(new Request("https://fixture.invalid/" + params, { headers: { Authorization: authorization(f.user) } }));
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); payloads.push(body);
    }
    const profile = edge("tokentracker-leaderboard-profile", client, "\nexport { fetchDailyGroupedRows, computeRowCost };"), refresh = edge("tokentracker-leaderboard-refresh", client, "\nexport { computeRowCost, attachCloudCostProvenance };");
    const profileRows = await profile.fetchDailyGroupedRows(client, f.user, "2026-01-01T16:00:00Z", "2026-01-02T16:00:00Z", "Asia/Singapore", 480);
    const priced = await refresh.attachCloudCostProvenance(client, evidence.rows.map(r => ({ ...r, ...r.basis })), {
      p_user_id: null, p_device_id: null, p_from: "2026-01-01T16:00:00Z", p_to: "2026-01-02T16:00:00Z", p_tz: "Asia/Singapore", p_offset_min: 480,
    });
    const profileCost = profileRows.reduce((n, r) => n + profile.computeRowCost(r), 0), boardCost = priced.reduce((n, r) => n + refresh.computeRowCost(r), 0);
    const cost = Number(payloads[0].totals.total_cost_usd);
    assert.equal(cost, 7.55, "only uncovered normalized input/output/cache vectors estimated; reported zero/free and local-day cutoff preserved");
    assert.ok(Math.abs(profileCost - cost) < 1e-8, JSON.stringify({cost,profileCost,boardCost})); assert.ok(Math.abs(boardCost - cost) < 1e-8);
    const dailyCost = payloads[1].data.reduce((n, d) => n + Number(d.total_cost_usd), 0);
    assert.ok(Math.abs(dailyCost - cost) < 1e-8);
    const allModels = payloads[2].sources.flatMap(s => s.models);
    assert.ok(Math.abs(allModels.reduce((n, m) => n + Number(m.totals.total_cost_usd), 0) - cost) < 1e-8);
    assert.equal(allModels.find(m => m.model === "grok-bot-default").cost_source, "provider_reported");
    assert.equal(allModels.find(m => m.model === "grok-bot-default").pricing.source, "cursor_subscription");
    assert.equal(allModels.find(m => m.model === "grok-bot-unreleased").cost_source, "unpriced");
    assert.equal(allModels.find(m => m.model === "opaque-grok-build").has_allocated_cost, true);
    assert.equal(allModels.find(m => m.model === "grok-4.7").cost_source, "mixed");
  } finally { global.fetch = originalFetch; await f.db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test("cost side-wire fails closed on stale basis, ambiguity, missing/extra rows and invalid fields", async () => {
  const client = { database: { rpc: async () => ({ data: { version: 1, rows: [] }, error: null }) } };
  const module = edge("tokentracker-leaderboard-refresh", client, "\nexport { attachCloudCostProvenance };");
  const r = { source: "grok", model: "grok-4.7", input_tokens: 10, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const v = { ...r, user_id: "owner", bucket: "", pricing_tier: "peak", basis: { ...r }, covered_tokens: { ...r }, reported_usd: 0, has_reported: true, has_missing: false, has_allocated: false, ambiguous: false, origins: ["grok_usd"] };
  const attach = data => module.attachCloudCostProvenance({ database: { rpc: async () => ({ data: { version: 1, rows: data }, error: null }) } }, [r], { p_user_id: "owner" });
  assert.equal((await attach([v]))[0].cost_provenance.reported_usd, 0);
  for (const data of [[], [v, v], [{ ...v, ambiguous: true }], [{ ...v, user_id: "other" }], [{ ...v, basis: { ...v.basis, input_tokens: 11 } }], [{ ...v, reported_usd: -1 }], [{ ...v, origins: ["/home/private/prompt"] }]]) await assert.rejects(attach(data), /unavailable/);
  assert.equal((await module.attachCloudCostProvenance(client, [{ source: "codex", model: "gpt-6" }], {})).length, 1, "old non-Grok clients/rows do not need the new RPC");
});

test("all five cloud consumers preserve reported USD but never estimate unknown Batch/Flex at standard rates", () => {
  const names = ["tokentracker-account-summary", "tokentracker-account-daily", "tokentracker-account-model-breakdown", "tokentracker-leaderboard-profile", "tokentracker-leaderboard-refresh"];
  for (const name of names) {
    const module = edge(name, {}, "\nexport { computeRowCost, getModelPricing };"), tokens = { input_tokens: 1000000, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    assert.equal(module.getModelPricing("grok-4.7", "grok").input, 2);
    for (const model of ["grok-4.7-batch", "grok-4.7:batch", "grok-4.7_flex", "grok-4.7 (Batch)", "grok-4.7 flex", "xai/grok-4.7-build-fast-flex", "openai/gpt-6.1-sol-batch"]) {
      const row = { source: "grok", model, ...tokens };
      assert.equal(module.computeRowCost(row), 0, `${name}: ${model} unknown delivery is unpriced`);
      row.cost_provenance = { version: 1, reported_usd: 0.2, covered_tokens: { ...tokens, input_tokens: 0 }, has_reported: true, has_missing: true, has_allocated: false, origins: ["grok_usd"] };
      assert.equal(module.computeRowCost(row), 0.2, `${name}: real reported USD survives, uncovered tokens stay unpriced`);
    }
  }
});
