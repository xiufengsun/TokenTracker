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

// Standard API-equivalent USD/MTok, verified 2026-09-24 (issue #671):
// https://developers.openai.com/api/docs/models/gpt-6-sol
const rates = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 };
const models = [
  "gpt-6-sol", "gpt-6-sol-high", "gpt-6-solhigh", "openai/gpt-6-sol", "GPT-6-SOL",
];
const row = {
  source: "codex", model: "gpt-6-sol", input_tokens: 1_000_000,
  cached_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
  output_tokens: 1_000_000, reasoning_output_tokens: 500_000,
};
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test("Sol resolves offline, including provider and reasoning suffixes", () => {
  for (const model of models) {
    const actual = pricing.getModelPricing(model, { source: "codex" });
    for (const [key, value] of Object.entries(rates)) {
      assert.equal(actual[key], value, `${model}: ${key}`);
    }
  }
  const stale = lookupPricing("gpt-6-sol", {
    curated, litellm: { "gpt-6-sol": { input: 0, output: 0 } },
  });
  assert.equal(stale.source, "curated:exact");
  assert.equal(stale.value.input, 2);
  // Must not fall through to the older gpt-5.6-sol tier ($4 input).
  assert.equal(pricing.getModelPricing("gpt-6-sol", { source: "codex" }).input, 2);
});

test("Sol bills cache writes and counts Codex reasoning only once", () => {
  close(pricing.computeRowCost(row), 14.7, "codex");
  close(pricing.computeRowCost({ ...row, source: "gemini" }), 19.7, "reasoning billed separately");
});

test("Sol long-context and Fast premiums apply only to observed request subsets", () => {
  const mixed = {
    ...row, input_tokens: 200_000, cached_input_tokens: 400_000,
    cache_creation_input_tokens: 20_000, output_tokens: 40_000, reasoning_output_tokens: 10_000,
    long_context_input_tokens: 100_000, long_context_cached_input_tokens: 200_000,
    long_context_cache_creation_input_tokens: 10_000,
    long_context_output_tokens: 20_000, long_context_reasoning_output_tokens: 5_000,
  };
  // Standard 0.93 + long-request premium 0.365.
  close(pricing.computeRowCost(mixed), 1.295, "long subset");
  close(pricing.computeRowCost(row), 14.7, "large aggregate is not a long request");

  const short = { source: "codex", model: "gpt-6-sol", input_tokens: 100_000, cached_input_tokens: 50_000, output_tokens: 10_000 };
  close(pricing.computeRowCost(short), 0.31, "standard");
  close(pricing.computeRowCost({
    ...short,
    priority_input_tokens: 100_000, priority_cached_input_tokens: 50_000, priority_output_tokens: 10_000,
  }), 0.62, "fast is 2x");
});

for (const slug of [
  "tokentracker-leaderboard-refresh", "tokentracker-account-daily",
  "tokentracker-account-summary", "tokentracker-account-model-breakdown",
  "tokentracker-leaderboard-profile",
]) {
  test(`${slug}: Sol prices match local standard estimates`, () => {
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
      if (compute) close(context.computeRowCost({ ...row, model }), 14.7, `${slug} ${model}`);
    }
  });
}
