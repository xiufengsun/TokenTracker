const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { eventCostCoverage, mergeCostCoverage, normalizeCostCoverage } = require("../src/lib/cost-provenance");
const { normalizeCursorUsage, parseCursorCsv } = require("../src/lib/cursor-config");
const { normalizeGrokUsage } = require("../src/lib/grok-usage");
const pricing = require("../src/lib/pricing");
const { lookupPricing } = require("../src/lib/pricing/matcher");
const { parseCursorApiIncremental } = require("../src/lib/rollout");
const { sessionHealth } = require("../src/lib/usage-health");
const emptyCurated = { exact: {}, alias: {}, fuzzy: [] };

test("Grok zero, missing, invalid and partial cost retain distinct evidence", () => {
  const fields = { inputTokens: 100, cachedReadTokens: 20, cacheCreationTokens: 10, outputTokens: 30, reasoningTokens: 10 };
  const zero = normalizeGrokUsage({ ...fields, costUsdTicks: 0 });
  assert.equal(zero.cost_coverage.reported_events, 1);
  assert.equal(zero.input_tokens, 70);
  assert.equal(pricing.computeRowCost({ ...zero, source: "grok", model: "grok-4.7" }), 0);
  for (const value of [undefined, null, "", "  ", [], {}, false, -1, Infinity, NaN]) {
    const result = normalizeGrokUsage({ ...fields, costUsdTicks: value });
    assert.equal(result.total_cost_usd, null, String(value));
    assert.equal(result.cost_coverage.missing_events, 1);
  }
  assert.equal(normalizeGrokUsage({ ...fields, costUsdTicks: 20, costIsPartial: true }).cost_coverage.reported_events, 0);
  assert.equal(normalizeGrokUsage({ ...fields, costUsdTicks: 0, costUsd: 12 }).total_cost_usd, 0);
});

test("mixed Grok buckets preserve dollars and estimate ONLY uncovered tokens", () => {
  const aggregate = { input_tokens: 0 };
  const first = { input_tokens: 1_000_000 };
  first.cost_coverage = eventCostCoverage(first, 1, "grok_ticks");
  mergeCostCoverage(aggregate, first);
  aggregate.input_tokens += first.input_tokens;
  const missing = { input_tokens: 1_000_000 };
  missing.cost_coverage = eventCostCoverage(missing, null, "grok_ticks");
  mergeCostCoverage(aggregate, missing);
  aggregate.input_tokens += missing.input_tokens;
  assert.equal(pricing.computeRowCost({ ...aggregate, model: "grok-4.7", source: "grok" }), 3);
  assert.equal(pricing.computeRowCost({ ...aggregate, model: "grok-bot-default", source: "cursor" }), 1);
  mergeCostCoverage(aggregate, first, -1);
  assert.equal(aggregate.cost_coverage.reported_usd, 0);
  assert.equal(aggregate.cost_coverage.missing_events, 1);
});

test("Cursor Bot export amount is not a guessed model rate, zero is not missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-evidence-"));
  try {
    const records = [0, null, 0.37].map((cost, index) => ({ date: "2026-11-24T00:00:00Z", model: "grok-bot-default", inputTokens: 100, cost }));
    const cursors = {};
    const queuePath = path.join(tmp, "queue.jsonl");
    await parseCursorApiIncremental({ records, cursors, queuePath });
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const row = rows.at(-1);
    assert.equal(row.cost_coverage.reported_events, 2);
    assert.equal(row.cost_coverage.missing_events, 1);
    assert.equal(row.cost_coverage.unreported_tokens.input_tokens, 100);
    assert.equal(pricing.computeRowCost(row), 0.37);
    assert.equal(pricing.getModelPricingInfo(row.model, { source: "cursor" }).source, "cursor_subscription");
    assert.equal(normalizeCursorUsage({ model: "grok-bot-cua", inputTokens: 1, tokenUsage: { totalCents: 0 } }).cost_coverage.reported_events, 1);
    // Neither credits nor Grok Build ticks are Cursor dollars.
    assert.equal(normalizeCursorUsage({ model: "grok-bot-cua", inputTokens: 1, costUsdTicks: 1e10, credits: 1 }).cost_coverage.reported_events, 0);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("CSV empty Cost stays missing; explicit $0 remains recorded", () => {
  const header = 'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost\n';
  const rows = parseCursorCsv(header + '2026-11-24,grok-bot-default,1,1,0,0,1,\n2026-11-24,grok-bot-default,1,1,0,0,1,$0\n');
  assert.equal(rows[0].cost, null);
  assert.equal(rows[1].cost, 0);
});

test("ambiguous providers fail closed, actual vendor resolves, exact/curated still win", () => {
  const litellm = { "openai/shared-novel": { input: 2, output: 3 }, "reseller/shared-novel": { input: 9, output: 12 } };
  assert.equal(lookupPricing("shared-novel", { curated: emptyCurated, litellm }).source, "ambiguous");
  assert.equal(lookupPricing("shared-novel", { curated: emptyCurated, litellm, source: "codex" }).value.input, 2);
  assert.equal(lookupPricing("shared-novel", { curated: emptyCurated, litellm, source: "claude" }).hit, false);
  assert.equal(lookupPricing("reseller/shared-novel", { curated: emptyCurated, litellm }).value.input, 9);
  assert.equal(lookupPricing("shared-novel", { curated: { ...emptyCurated, exact: { "shared-novel": { input: 4 } } }, litellm }).value.input, 4);
  assert.equal(lookupPricing("grok-bot-default", { curated: emptyCurated, litellm: { "grok-bot-default": { input: 100 } }, source: "cursor" }).hit, false);
});

test("unknown price triggers one async refresh, cooldown, revision invalidation and stale retention", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-refresh-"));
  pricing.resetPricingForTests();
  let calls = 0;
  let finish;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const initial = { "first-novel": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } };
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return initial;
    if (calls > 2) throw Error("offline");
    return new Promise((resolve) => { finish = resolve; startedResolve(); });
  };
  try {
    await pricing.ensurePricingLoaded({ cachePath: path.join(tmp, "prices.json"), fetchImpl });
    const before = pricing.getPricingRevision();
    assert.equal(pricing.getModelPricingInfo("second-novel").status, "unpriced");
    pricing.getModelPricing("third-novel");
    const flight = pricing.refreshPricing();
    await started;
    assert.equal(calls, 2);
    finish({ ...initial, "second-novel": { input_cost_per_token: 3e-6, output_cost_per_token: 4e-6 } });
    await flight;
    assert.ok(pricing.getPricingRevision() > before);
    assert.equal(pricing.getModelPricingInfo("second-novel").input, 3);
    assert.equal(await pricing.refreshPricing(), false);
    assert.equal(calls, 2);
    const revision = pricing.getPricingRevision();
    pricing.getModelPricingInfo("persistent-unknown");
    pricing.getModelPricing("persistent-numeric-unknown");
    const realNow = Date.now();
    t.mock.method(Date, "now", () => realNow + 120000);
    pricing.getModelPricingInfo("persistent-unknown");
    pricing.getModelPricing("persistent-numeric-unknown");
    const failed = await pricing.refreshPricing();
    assert.equal(calls, 3, "cached misses retry and share one flight after cooldown");
    assert.equal(failed, false);
    assert.equal(pricing.getPricingRevision(), revision);
    assert.equal(pricing.getModelPricing("second-novel").input, 3);
    assert.equal(pricing.getPricingHealth().status, "stale");
  } finally { pricing.resetPricingForTests(); await fs.rm(tmp, { recursive: true, force: true }); }
});

test("health is allowlisted, scopes differ, latest event is not completeness", () => {
  const sessions = [{ ended_at: "2026-11-24T01:00:00Z", project_ref: "/home/private/secret", prompt: "SECRET" }];
  sessions.skippedFiles = 2;
  sessions.scanHealth = { checked_at: "2026-11-24T02:00:00Z", files: { "/sensitive": {} }, sources: { grok: { status: "observed", failed_units: 2, discovered_units: 3, path: "/secret" } } };
  const health = sessionHealth(sessions, { from: "2026-11-24" });
  assert.equal(health.status, "partial");
  assert.equal(health.latest_event_at, "2026-11-24T01:00:00.000Z");
  assert.equal(health.complete_through, null);
  assert.equal(health.sources[0].status, "partial");
  assert.equal(health.comparison.reconciled, false);
  assert.equal(health.comparison.cloud_cutoff, null);
  assert.doesNotMatch(JSON.stringify(health), /SECRET|private|sensitive|secret/);
  assert.equal(sessionHealth([]).status, "unknown");
  assert.equal(normalizeCostCoverage({ version: 1, origins: ["/secret"] }), null);
  assert.equal(normalizeCostCoverage({ ...eventCostCoverage({}, 1, "grok_ticks"), origins: ["/secret"] }), null);
});

test("versioned cloud upload retains cost provenance without gateway metadata", async () => {
  const { readQueueBatch } = require("../src/commands/sync");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-cloud-compat-"));
  try {
    const file = path.join(dir, "queue.jsonl");
    const row = { source: "cursor", model: "grok-bot-default", hour_start: "2026-11-24T00:00:00Z", input_tokens: 1, total_tokens: 1, total_cost_usd: 0.1 };
    await fs.writeFile(file, JSON.stringify({ ...row, cost_coverage: eventCostCoverage(row, 0.1, "cursor_csv_cost") }) + "\n");
    const result = await readQueueBatch(file, 0, 10);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].cost_coverage.reported_usd, 0.1);
    assert.equal(result.buckets[0].total_cost_usd, 0.1);
    assert.equal(JSON.parse((await fs.readFile(file, "utf8")).trim()).cost_coverage.version, 1, "raw local derived queue retained");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("router segments do not override explicit nested vendors or exact rates", () => {
  const litellm = { "anthropic/novel-model": { input: 2, output: 3 }, "openrouter/xai/novel-model": { input: 9, output: 12 } };
  assert.equal(lookupPricing("openrouter/anthropic/novel-model", { curated: emptyCurated, litellm, source: "claude" }).value.input, 2);
  assert.equal(lookupPricing("openrouter/xai/novel-model", { curated: emptyCurated, litellm, source: "claude" }).value.input, 9);
  assert.equal(lookupPricing("novel-model", { curated: emptyCurated, litellm }).source, "ambiguous");
  assert.equal(lookupPricing("openrouter/anthropic/novel-model-future", { curated: emptyCurated, litellm: { "xai/novel-model": { input: 9 } }, source: "claude" }).hit, false);
});

test("parent allocation excludes free children without losing paid parent amount", () => {
  const { extractGrokTurnUsageEvents } = require("../src/lib/rollout");
  const events = extractGrokTurnUsageEvents({ params: { update: { sessionUpdate: "turn_completed", usage: { costUsd: 1, modelUsage: {
    "grok-4.5-build-free": { inputTokens: 100 }, "opaque-paid": { inputTokens: 100 },
  } } } } }, "2026-11-24T00:00:00Z", "unknown", 0);
  assert.equal(events.reduce((sum, event) => sum + pricing.computeRowCost({ ...event, source: "grok" }), 0), 1);
  assert.equal(events.find((row) => row.model === "opaque-paid").cost_coverage.reported_usd, 1);
  assert.equal(pricing.computeRowCost({ ...events.find((row) => row.model === "grok-build-free"), source: "grok" }), 0);
});

test("known discovery failures stay partial even when returning a prior snapshot", () => {
  const rows = [];
  rows.scanHealth = { checked_at: "2026-11-23T00:00:00Z", sources: { grok: { status: "observed", discovered_units: 1, failed_units: 0 } } };
  rows.incompleteDirs = [{ path: "/secret/home", error: "PRIVATE EACCES" }];
  const health = sessionHealth(rows);
  assert.equal(health.status, "partial");
  assert.equal(health.discovery_failed_units, 1);
  assert.doesNotMatch(JSON.stringify(health), /secret|PRIVATE|EACCES/);
});


test("unknown Batch/Flex delivery SKUs never inherit standard fuzzy rates", () => {
  const litellm = { "novel-model": { input: 2, output: 3 }, "novel-model-batch": { input: 1, output: 1.5 } };
  assert.equal(lookupPricing("novel-model-flex", { curated: emptyCurated, litellm }).hit, false);
  assert.equal(lookupPricing("novel-model-batch-future", { curated: emptyCurated, litellm }).hit, false);
  assert.equal(lookupPricing("novel-model-batch", { curated: emptyCurated, litellm }).value.input, 1);
});


test("provider-qualified canonical public IDs retain bare catalog pricing without crossing vendors", () => {
  const litellm = { "claude-novel": { input: 2 }, "azure_ai/claude-novel": { input: 9 } };
  assert.equal(lookupPricing("anthropic/claude-novel", { curated: emptyCurated, litellm, source: "unsloth" }).value.input, 2);
  assert.equal(lookupPricing("xai/claude-novel", { curated: emptyCurated, litellm }).hit, false);
});

test("Cursor family normalization preserves unknown Batch and Flex delivery identity", () => {
  for (const model of ["grok-4.7-batch", "grok-4.7-flex", "grok-4.7-fast-batch"]) {
    assert.equal(pricing.getModelPricingInfo(model, { source: "cursor" }).status, "unpriced");
    assert.equal(pricing.computeRowCost({ source: "cursor", model, input_tokens: 1_000_000 }), 0);
  }
  assert.ok(pricing.computeRowCost({ source: "cursor", model: "grok-4.7", input_tokens: 1_000_000 }) > 0);
});

test("source normalization cannot reprice unknown Batch/Flex as a standard family rate", () => {
  const tokens = { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0 };
  assert.equal(pricing.computeRowCost({ source: "antigravity", model: "gemini-3.1-pro", ...tokens }), 1.25);
  for (const [source, model] of [
    ["antigravity", "gemini-3.1-pro-flex"],
    ["antigravity", "Gemini 3.1 Pro (Flex)"],
    ["cursor", "grok-4.7 (Batch)"],
    ["zed", "GPT-5.4 (Batch)"],
    ["zed", "gpt-5.4-batch"],
  ]) {
    assert.equal(pricing.getModelPricingInfo(model, { source }).status, "unpriced", `${source} ${model}`);
    assert.equal(pricing.computeRowCost({ source, model, ...tokens }), 0, `${source} ${model}`);
  }
  const litellm = { "gemini-3.1-pro-flex": { input: 0.4, output: 1.2 } };
  assert.equal(lookupPricing("Gemini 3.1 Pro (Flex)", { curated: emptyCurated, litellm, source: "antigravity" }).value.input, 0.4);
  assert.equal(pricing.computeRowCost({ source: "grok", model: "grok-4.7-batch", total_cost_usd: 0.2, ...tokens }), 0.2);
});

test("invalid retained rates never replace the current memory or disk catalog", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-invalid-price-"));
  const cachePath = path.join(dir, "prices.json");
  pricing.resetPricingForTests();
  try {
    await pricing.ensurePricingLoaded({ cachePath, fetchImpl: async () => ({ novel: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }) });
    const before = await fs.readFile(cachePath, "utf8");
    const revision = pricing.getPricingRevision();
    const invalid = [{ output_cost_per_token: -3e-6 }, { cache_read_input_token_cost: -1 }, { cache_creation_input_token_cost: Infinity }, { input_cost_per_token: NaN }, { output_cost_per_token: "0.1" }];
    for (let i = 0; i < invalid.length; i++) {
      assert.equal(await pricing.refreshPricing({ now: Date.now() + (i + 1) * 120_000, fetchImpl: async () => ({ novel: { input_cost_per_token: 2e-6, ...invalid[i] } }) }), false);
      assert.equal(pricing.getPricingRevision(), revision);
      assert.equal(pricing.computeRowCost({ model: "novel", output_tokens: 1_000_000 }), 2);
      assert.equal(await fs.readFile(cachePath, "utf8"), before);
    }
  } finally { pricing.resetPricingForTests(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("Grok free selectors retain canonical, tier and suffix semantics without affecting Cursor", () => {
  for (const model of ["grok-build-free", "grok-4.5-build-free", "grok-4.7-free-tier", "grok-4.7-free"]) {
    const row = { source: "grok", model, input_tokens: 100, total_cost_usd: 1 };
    row.cost_coverage = eventCostCoverage(row, 1, "grok_usd");
    assert.equal(pricing.computeRowCost(row), 0, model);
  }
  const paid = { source: "grok", model: "grok-4.7", input_tokens: 100 };
  paid.cost_coverage = eventCostCoverage(paid, 1, "grok_usd");
  assert.equal(pricing.computeRowCost(paid), 1);
  const cursor = { ...paid, source: "cursor", model: "grok-bot-free" };
  cursor.cost_coverage = eventCostCoverage(cursor, 1, "cursor_csv_cost");
  assert.equal(pricing.computeRowCost(cursor), 1);
});
