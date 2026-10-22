"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("../src/lib/pricing");
const curated = require("../src/lib/pricing/curated-overrides.json");

test("claude-haiku-5-5 uses short-context Anthropic rates, not Haiku 4.5 (#848)", () => {
  for (const model of ["claude-haiku-5-5", "claude-haiku-5.5"]) {
    const rates = pricing.getModelPricing(model);
    assert.equal(rates.input, 0.1, model);
    assert.equal(rates.output, 0.5, model);
    assert.equal(rates.cache_read, 0.01, model);
    assert.equal(rates.cache_write, 0.125, model);
    assert.equal(curated.exact[model].input, 0.1);
  }
  // Provider-prefixed / dated / dotted variants that previously fell through
  // to Haiku 4.5 ($1/$5) on the edge, or to $0 locally without a source.
  for (const model of [
    "anthropic/claude-haiku-5-5-20261007",
    "anthropic/claude-haiku-5.5-20261007",
    "claude-haiku-5.5-20261007",
  ]) {
    const fuzzy = pricing.getModelPricing(model);
    assert.equal(fuzzy.input, 0.1, model);
    assert.equal(fuzzy.output, 0.5, model);
  }

  const haiku45 = pricing.getModelPricing("claude-haiku-4-5");
  assert.equal(haiku45.input, 1);
  assert.equal(haiku45.output, 5);

  const cost = pricing.computeRowCost({
    source: "claude",
    model: "claude-haiku-5-5",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.ok(Math.abs(cost - 0.6) < 1e-12);
});
