"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const pricing = require("../src/lib/pricing");
const { lookupPricing } = require("../src/lib/pricing/matcher");
const curated = require("../src/lib/pricing/curated-overrides.json");

// xAI short-context rates, verified 2026-11-03 against
// https://docs.x.ai/developers/pricing :
// grok-4.7 is $2 / $0.50 / $6 per MTok (input / cached input / output) below
// 200k prompt tokens; Grok 4.7 Fast (Cursor and Grok Build only, recorded by
// ZCode as grok-4.7-build-fast) is 2x that, $4 / $1 / $12. Neither publishes a
// cache-write rate, so cache_write stays 0 like the other Grok entries.
const STANDARD = { input: 2, output: 6, cache_read: 0.5, cache_write: 0 };
const FAST = { input: 4, output: 12, cache_read: 1, cache_write: 0 };

test("grok-4.7 and grok-4.7-build-fast resolve to the xAI short-context rates", () => {
  for (const [model, rates] of [["grok-4.7", STANDARD], ["grok-4.7-build-fast", FAST]]) {
    const actual = pricing.getModelPricing(model, { source: "zcode" });
    for (const [key, value] of Object.entries(rates)) {
      assert.equal(actual[key], value, `${model}: ${key}`);
    }
  }

  // The curated entry wins even when a LiteLLM snapshot carries the model,
  // and the Fast SKU must not collapse onto the base grok-4.7 rate.
  const fast = lookupPricing("grok-4.7-build-fast", {
    curated,
    litellm: { "grok-4.7-build-fast": { input: 0, output: 0 } },
  });
  assert.equal(fast.source, "curated:exact");
  assert.equal(fast.value.input, FAST.input);
});

test("grok-4.7-build-fast bills input, output, and cache reads, but not cache writes", () => {
  const row = {
    source: "zcode",
    model: "grok-4.7-build-fast",
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  };
  // 4 + 12 + 1 per million tokens; cache writes have no published rate.
  const cost = pricing.computeRowCost(row);
  assert.ok(Math.abs(cost - 17) < 1e-9, `cost: ${cost} != 17`);
});

test("grok-4.7-build-fast stays on its own rate instead of a cheaper grok tier", () => {
  const fast = pricing.getModelPricing("grok-4.7-build-fast", { source: "zcode" }).input;
  const base = pricing.getModelPricing("grok-4.7", { source: "zcode" }).input;
  const grok45Build = pricing.getModelPricing("grok-4.5-build", { source: "grok" }).input;
  assert.equal(fast, 2 * base);
  assert.notEqual(fast, grok45Build);
});
