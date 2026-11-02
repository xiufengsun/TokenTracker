"use strict";

// Issue #886: the Codex Fast/Ultrafast split is recorded on queue rows
// (priority_* / ultrafast_* subsets) and priced correctly by computeRowCost,
// but was never surfaced. Covers the two halves of the surfacing: the exact
// per-tier cost allocation (src/lib/pricing) and the model-breakdown endpoint
// aggregation (src/lib/local-api.js).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const pricing = require("../src/lib/pricing");
const { createLocalApiHandler } = require("../src/lib/local-api");

const { computeRowCost, computeRowTierCosts } = pricing;

function assertTierSum(row, epsilon = 1e-9) {
  const tiers = computeRowTierCosts(row);
  const total = computeRowCost(row);
  const sum = tiers.standard + tiers.priority + tiers.ultrafast;
  assert.ok(
    Math.abs(sum - total) < epsilon,
    `tier allocation must add up: ${sum} vs ${total} for ${JSON.stringify(row)}`,
  );
  assert.ok(tiers.priority >= 0 && tiers.ultrafast >= 0 && tiers.standard >= -epsilon);
  return tiers;
}

test("computeRowTierCosts allocates the issue's ultrafast row entirely to Ultrafast", () => {
  // Minimal repro from issue 886: 1M input + 1M output, all ultrafast.
  const row = {
    source: "codex",
    model: "gpt-6.1-sol",
    hour_start: "2026-10-26T00:00:00.000Z",
    input_tokens: 1000000,
    output_tokens: 1000000,
    total_tokens: 2000000,
    billable_total_tokens: 2000000,
    ultrafast_input_tokens: 1000000,
    ultrafast_output_tokens: 1000000,
    ultrafast_usage_events: 1,
  };
  const tiers = assertTierSum(row);
  assert.equal(computeRowCost(row), 72);
  assert.ok(Math.abs(tiers.ultrafast - 72) < 1e-9);
  assert.ok(Math.abs(tiers.priority) < 1e-9);
  assert.ok(Math.abs(tiers.standard) < 1e-9);
});

test("computeRowTierCosts splits Fast + long-context rows exactly", () => {
  // Fast subset with a long-context intersection: the tier books the
  // intersection at the LONG rate times the multiplier (see the tierPremium
  // comment in pricing/index.js), standard books the rest.
  const row = {
    source: "codex",
    model: "gpt-6.1-sol",
    input_tokens: 300000,
    output_tokens: 10000,
    priority_input_tokens: 280000,
    priority_output_tokens: 8000,
    priority_long_context_input_tokens: 100000,
    long_context_input_tokens: 100000,
    long_context_output_tokens: 2000,
  };
  const tiers = assertTierSum(row);
  // Priority subset at standard rates: 280K*2 + 8K*10 = 0.64; its long-context
  // intersection: 100K*2 = 0.2. Portion 0.84, premium (2-1)*0.84 = 0.84.
  assert.ok(Math.abs(tiers.priority - 1.68) < 1e-9, `priority ${tiers.priority}`);
  assert.equal(tiers.ultrafast, 0);
  assert.ok(Math.abs(tiers.standard - 0.07) < 1e-9, `standard ${tiers.standard}`);
});

test("computeRowTierCosts handles rows with both speed tiers at once", () => {
  const row = {
    source: "codex",
    model: "gpt-6.1-sol",
    input_tokens: 2000000,
    output_tokens: 200000,
    cached_input_tokens: 500000,
    priority_input_tokens: 700000,
    priority_cached_input_tokens: 200000,
    priority_output_tokens: 50000,
    ultrafast_input_tokens: 900000,
    ultrafast_output_tokens: 120000,
  };
  const tiers = assertTierSum(row);
  // gpt-6.1-sol rates: input $2, output $10, cache read $0.1 per million.
  // Fast portion: 700K*2 + 200K*0.1 + 50K*10 = 1.92, premium (2-1)*1.92.
  assert.ok(Math.abs(tiers.priority - 3.84) < 1e-9, `priority ${tiers.priority}`);
  // Ultrafast portion: 900K*2 + 120K*10 = 3, premium (6-1)*3 = 15.
  assert.ok(Math.abs(tiers.ultrafast - 18) < 1e-9, `ultrafast ${tiers.ultrafast}`);
  // Standard residual tokens: 400K*2 + 30K*10 + 300K*0.1 = 1.13.
  assert.ok(Math.abs(tiers.standard - 1.13) < 1e-9, `standard ${tiers.standard}`);
});

test("computeRowTierCosts books subsets of models without published tier rates as standard", () => {
  // The parser records priority_* for whatever model ran on the Fast tier;
  // models without a curated priority multiplier price those tokens at
  // standard (no invented premium), and the allocation must say so.
  const row = {
    source: "codex",
    model: "gpt-5.4",
    input_tokens: 100000,
    output_tokens: 10000,
    priority_input_tokens: 40000,
  };
  const tiers = assertTierSum(row);
  const rates = pricing.getRowPricing(row);
  assert.ok(Math.abs(tiers.priority - (40000 * (rates.input || 0)) / 1_000_000) < 1e-9);
  assert.equal(tiers.ultrafast, 0);
});

test("computeRowTierCosts keeps authoritative and zero-cost rows under standard", () => {
  const reported = { source: "grok", model: "grok-4", input_tokens: 10, output_tokens: 10, total_cost_usd: 0.5 };
  assert.deepEqual(assertTierSum(reported), { standard: 0.5, priority: 0, ultrafast: 0 });
  const local = { source: "lmstudio", model: "llama-3", input_tokens: 10, output_tokens: 10 };
  assert.deepEqual(assertTierSum(local), { standard: 0, priority: 0, ultrafast: 0 });
});

test("computeRowTierCosts returns all-standard for rows without tier subsets", () => {
  const row = {
    source: "claude",
    model: "claude-sonnet-4-5",
    input_tokens: 100000,
    output_tokens: 20000,
    reasoning_output_tokens: 5000,
  };
  const tiers = assertTierSum(row);
  assert.equal(tiers.priority, 0);
  assert.equal(tiers.ultrafast, 0);
  assert.ok(Math.abs(tiers.standard - computeRowCost(row)) < 1e-12);
  assert.deepEqual(computeRowTierCosts(null), { standard: 0, priority: 0, ultrafast: 0 });
});

test("usage-model-breakdown surfaces per-model tier subsets, tier costs and multipliers", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-tier-breakdown-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await fs.promises.writeFile(
      queuePath,
      `${
        JSON.stringify({
          source: "codex",
          model: "gpt-6.1-sol",
          hour_start: "2026-10-26T00:00:00.000Z",
          input_tokens: 1100000,
          output_tokens: 1000000,
          total_tokens: 2100000,
          billable_total_tokens: 2100000,
          conversation_count: 3,
          priority_input_tokens: 100000,
          ultrafast_input_tokens: 1000000,
          ultrafast_output_tokens: 1000000,
        })
      }\n`,
    );

    const handler = createLocalApiHandler({ queuePath });
    const url = new URL(
      "http://localhost/functions/tokentracker-usage-model-breakdown?from=2026-10-26&to=2026-10-26&tz=UTC",
    );
    const req = { method: "GET", url: url.pathname + url.search, headers: { host: "localhost" } };
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader() {},
      writeHead() {},
      write(chunk) { chunks.push(chunk); },
      end(body) { if (body) chunks.push(body); },
    };
    assert.ok(await handler(req, res, url));
    const body = JSON.parse(chunks.join(""));

    const model = body.sources.find((s) => s.source === "codex").models[0];
    assert.equal(model.model, "gpt-6.1-sol");
    assert.equal(model.totals.priority_input_tokens, 100000);
    assert.equal(model.totals.ultrafast_input_tokens, 1000000);
    assert.equal(model.totals.ultrafast_output_tokens, 1000000);
    assert.equal(model.totals.priority_output_tokens, 0);
    // Total 72.4 = standard 0 + fast 0.4 + ultrafast 72: every token on this
    // row belongs to one of the two tiers (see pricing tests above).
    assert.equal(model.totals.total_cost_usd, "72.400000");
    assert.equal(model.totals.priority_cost_usd, "0.400000");
    assert.equal(model.totals.ultrafast_cost_usd, "72.000000");
    assert.ok(Math.abs(
      Number(model.totals.total_cost_usd) -
      Number(model.totals.priority_cost_usd) -
      Number(model.totals.ultrafast_cost_usd),
    ) < 1e-9);
    // Multipliers ride the per-model pricing info so the UI can label tiers.
    assert.equal(model.pricing.priority_multiplier, 2);
    assert.equal(model.pricing.ultrafast_multiplier, 6);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
