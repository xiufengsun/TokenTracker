"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { transformSync } = require("esbuild");
const pricing = require("../src/lib/pricing");
const { lookupPricing } = require("../src/lib/pricing/matcher");
const curated = require("../src/lib/pricing/curated-overrides.json");

// Standard API-equivalent USD/MTok, verified 2026-10-27:
// https://developers.openai.com/api/docs/models/gpt-6.1-terra
// https://developers.openai.com/api/docs/pricing
const rates = { input: 1, output: 5, cache_read: 0.05, cache_write: 1.25 };
const models = [
  "gpt-6.1-terra", "gpt-6.1-terra-high", "gpt-6.1-terrahigh",
  "openai/gpt-6.1-terra", "GPT-6.1-TERRA",
];
const row = {
  source: "codex", model: "gpt-6.1-terra", input_tokens: 1_000_000,
  cached_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
  output_tokens: 1_000_000, reasoning_output_tokens: 500_000,
};
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test("6.1 Terra resolves offline, including provider and reasoning suffixes", () => {
  for (const model of models) {
    const actual = pricing.getModelPricing(model, { source: "codex" });
    for (const [key, value] of Object.entries(rates)) {
      assert.equal(actual[key], value, `${model}: ${key}`);
    }
    assert.equal(actual.priority_multiplier, 2, `${model}: Fast is 2x`);
    assert.equal(actual.ultrafast_multiplier, undefined, `${model}: no Ultrafast`);
  }
  const stale = lookupPricing("gpt-6.1-terra", {
    curated, litellm: { "gpt-6.1-terra": { input: 0, output: 0 } },
  });
  assert.equal(stale.source, "curated:exact");
  assert.equal(stale.value.input, 1);
  // Must not fall through to gpt-5.6-terra ($2/$12) or stay unpriced ($0).
  assert.equal(pricing.getModelPricing("gpt-6.1-terra", { source: "codex" }).input, 1);
  assert.notEqual(pricing.getModelPricing("gpt-6.1-terra", { source: "codex" }).input, 2);
});

test("6.1 Terra bills cache writes and counts Codex reasoning only once", () => {
  // 1 + 5 + 0.05 + 1.25 = 7.3
  close(pricing.computeRowCost(row), 7.3, "codex");
  // + 0.5M reasoning * $5 = +2.5 → 9.8 when reasoning is billed separately
  close(pricing.computeRowCost({ ...row, source: "gemini" }), 9.8, "reasoning billed separately");
});

test("6.1 Terra long-context and Fast premiums apply only to observed request subsets", () => {
  const mixed = {
    ...row, input_tokens: 200_000, cached_input_tokens: 400_000,
    cache_creation_input_tokens: 20_000, output_tokens: 40_000, reasoning_output_tokens: 10_000,
    long_context_input_tokens: 100_000, long_context_cached_input_tokens: 200_000,
    long_context_cache_creation_input_tokens: 10_000,
    long_context_output_tokens: 20_000, long_context_reasoning_output_tokens: 5_000,
  };
  // Standard 0.445 + long-request premium 0.1725.
  close(pricing.computeRowCost(mixed), 0.6175, "long subset");
  close(pricing.computeRowCost(row), 7.3, "large aggregate is not a long request");

  const short = {
    source: "codex", model: "gpt-6.1-terra",
    input_tokens: 100_000, cached_input_tokens: 50_000, output_tokens: 10_000,
  };
  close(pricing.computeRowCost(short), 0.1525, "standard");
  close(pricing.computeRowCost({
    ...short,
    priority_input_tokens: 100_000, priority_cached_input_tokens: 50_000, priority_output_tokens: 10_000,
  }), 0.305, "fast is 2x");
});


test("6.1 Terra Fast stacks with long-context; Ultrafast annotations are ignored", () => {
  const base = {
    source: "codex", model: "gpt-6.1-terra",
    input_tokens: 200_000, cached_input_tokens: 100_000,
    cache_creation_input_tokens: 20_000, output_tokens: 40_000,
    long_context_input_tokens: 100_000, long_context_cached_input_tokens: 50_000,
    long_context_cache_creation_input_tokens: 10_000, long_context_output_tokens: 20_000,
  };
  // Standard base 0.43 + long premium 0.165 = 0.595
  close(pricing.computeRowCost(base), 0.595, "long only");
  // Entire row observed as Fast: 2x (base + long) = 1.19
  close(pricing.computeRowCost({
    ...base,
    priority_input_tokens: 200_000, priority_cached_input_tokens: 100_000,
    priority_cache_creation_input_tokens: 20_000, priority_output_tokens: 40_000,
    priority_long_context_input_tokens: 100_000, priority_long_context_cached_input_tokens: 50_000,
    priority_long_context_cache_creation_input_tokens: 10_000,
    priority_long_context_output_tokens: 20_000,
  }), 1.19, "fast x long");
  // Ultrafast is unpublished for Terra — ultrafast_* columns must not change cost.
  close(pricing.computeRowCost({
    ...base,
    ultrafast_input_tokens: 200_000, ultrafast_cached_input_tokens: 100_000,
    ultrafast_cache_creation_input_tokens: 20_000, ultrafast_output_tokens: 40_000,
  }), 0.595, "ultrafast ignored");
});

for (const slug of [
  "tokentracker-leaderboard-refresh", "tokentracker-account-daily",
  "tokentracker-account-summary", "tokentracker-account-model-breakdown",
  "tokentracker-leaderboard-profile",
]) {
  test(`${slug}: 6.1 Terra prices match local standard estimates`, () => {
    const source = fs.readFileSync(path.join(__dirname, "../dashboard/edge-patches", `${slug}.ts`), "utf8");
    const blockMatch = source.match(/const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/);
    assert.ok(blockMatch, `${slug}: pricing block is present`);
    const rowPricing = source.match(/\nfunction getRowPricing\([\s\S]*?\n\}/)[0];
    const compute = source.match(/\nfunction computeRowCost\([\s\S]*?\n\}/)?.[0] || "";
    const script = transformSync(`${blockMatch[0]}\n${rowPricing}\n${compute}`, { loader: "ts", format: "cjs" }).code;
    const context = vm.createContext({ SOURCES_WITH_AUTHORITATIVE_COST: new Set(["grok"]) });
    vm.runInContext(script, context);
    for (const model of models) {
      const actual = context.getModelPricing(model);
      for (const [key, value] of Object.entries(rates)) {
        assert.equal(actual[key], value, `${model}: ${key}`);
      }
      if (compute) close(context.computeRowCost({ ...row, model }), 7.3, `${slug} ${model}`);
    }
  });
}
