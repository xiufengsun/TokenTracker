"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeTraeUsage, normalizeTraeModel } = require("../src/lib/trae-usage");
const { computeRowCost } = require("../src/lib/pricing");

function counts(input, output, cached = 0, written = 0, reasoning = 0, estimated = false) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: written,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output + cached + written + reasoning,
    ...(estimated ? { usage_precision: "estimated" } : {}),
  };
}

test("TRAE whole-turn counters are independent of the last request's total", () => {
  // Token-only shape from a multistep TRAE record: total_tokens is last-step.
  assert.deepEqual(normalizeTraeUsage({
    prompt_tokens: 30_137,
    prompt_tokens_total: 287_918,
    completion_tokens: 635,
    completion_tokens_total: 9_386,
    total_tokens: 30_772,
  }), counts(287_918, 9_386, 0, 0, 0, true));
});

test("TRAE credits known last-step cache and inclusive reasoning once in aggregate usage", () => {
  assert.deepEqual(normalizeTraeUsage({
    prompt_tokens: 100,
    prompt_tokens_total: 1_000,
    completion_tokens: 30,
    completion_tokens_total: 300,
    cache_read_input_tokens: 60,
    cache_creation_input_tokens: 10,
    reasoning_tokens: 20,
    total_tokens: 130,
  }), counts(930, 280, 60, 10, 20, true));
});

test("TRAE keeps known separate reasoning when aggregate completions exclude it", () => {
  assert.deepEqual(normalizeTraeUsage({
    prompt_tokens: 100,
    prompt_tokens_total: 1_000,
    completion_tokens: 30,
    completion_tokens_total: 300,
    cache_read_input_tokens: 60,
    reasoning_tokens: 20,
    total_tokens: 150,
  }), counts(940, 300, 60, 0, 20, true));
});

test("TRAE accepts explicit null optional fields and zero aggregate placeholders", () => {
  assert.deepEqual(normalizeTraeUsage({
    prompt_tokens: 100,
    prompt_tokens_total: 0,
    completion_tokens: 30,
    completion_tokens_total: 0,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    reasoning_tokens: null,
    total_tokens: 130,
  }), counts(100, 30));
});

test("TRAE equal aggregate and last-step counters remain reported", () => {
  assert.deepEqual(normalizeTraeUsage({
    prompt_tokens: 100,
    prompt_tokens_total: 100,
    completion_tokens: 30,
    completion_tokens_total: 30,
    cache_read_input_tokens: 60,
    total_tokens: 130,
  }), counts(40, 30, 60));
});

test("TRAE accepts aggregate-only usage and independent prompt/completion aggregation", () => {
  assert.deepEqual(normalizeTraeUsage({
    prompt_tokens_total: 100,
    completion_tokens_total: 30,
    total_tokens: 130,
  }), counts(100, 30));
  assert.deepEqual(normalizeTraeUsage({
    prompt_tokens: 100,
    prompt_tokens_total: 1_000,
    completion_tokens: 30,
    completion_tokens_total: 0,
    total_tokens: 130,
  }), counts(1_000, 30, 0, 0, 0, true));
});

test("TRAE Gemini omitted thoughts are an explicitly estimated residual", () => {
  const usage = {
    prompt_tokens: 35_727,
    prompt_tokens_total: 0,
    completion_tokens: 623,
    completion_tokens_total: 0,
    total_tokens: 37_058,
  };
  assert.deepEqual(normalizeTraeUsage(usage, { model: "Gemini-3-Pro-Preview" }),
    counts(35_727, 623, 0, 0, 708, true));
  assert.equal(normalizeTraeUsage(usage, { model: "gpt-5" }), null,
    "the compatibility repair must not explain arbitrary provider totals");
  assert.equal(normalizeTraeUsage(usage), null);
});

test("TRAE Gemini residual recovery supports multistep counters and persisted model names", () => {
  assert.deepEqual(normalizeTraeUsage({
    name: "Gemini-3-Pro-Preview",
    prompt_tokens: 137_193,
    prompt_tokens_total: 274_088,
    completion_tokens: 48,
    completion_tokens_total: 148,
    total_tokens: 137_311,
    reasoning_tokens: null,
  }), counts(274_088, 148, 0, 0, 70, true));
});

test("TRAE Gemini impossible duplicate cache-write counters do not double bill reads", () => {
  const usage = {
    prompt_tokens: 32_398,
    completion_tokens: 443,
    cache_read_input_tokens: 28_469,
    cache_creation_input_tokens: 28_469,
    reasoning_tokens: 156,
    total_tokens: 32_997,
  };
  assert.deepEqual(normalizeTraeUsage(usage, { model: "Gemini-3-Pro-Preview (200k)" }),
    counts(3_929, 443, 28_469, 0, 156, true));
  assert.equal(normalizeTraeUsage(usage, { model: "claude-sonnet-4" }), null);
  assert.equal(normalizeTraeUsage({ ...usage, cache_creation_input_tokens: 28_468 },
    { model: "Gemini-3-Pro-Preview" }), null, "unequal counters are not duplicate metadata");
});

test("TRAE preserves independently reconcilable cache writes", () => {
  assert.deepEqual(normalizeTraeUsage({
    prompt_tokens: 100,
    completion_tokens: 30,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 20,
    total_tokens: 130,
  }, { model: "claude-sonnet-4" }), counts(30, 30, 50, 20));
});

test("TRAE's Claude 4 Sonnet display alias resolves to the model with cache pricing", () => {
  const model = normalizeTraeModel("Claude-4-Sonnet__max");
  assert.equal(model, "claude-sonnet-4-20250514");
  assert.equal(computeRowCost({ source: "trae", model, cached_input_tokens: 1_000_000 }), 0.3);
  assert.equal(computeRowCost({ source: "trae", model, cache_creation_input_tokens: 1_000_000 }), 3.75);
  assert.equal(computeRowCost({ source: "trae", model, input_tokens: 1_000_000 }), 3);
  assert.equal(computeRowCost({ source: "trae", model, output_tokens: 1_000_000 }), 15);
  assert.equal(normalizeTraeModel("Claude-3-5-Sonnet"), "claude-3-5-sonnet",
    "legacy version-first model ids must stay intact");
  assert.equal(normalizeTraeModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("TRAE rejects decreasing aggregates, invalid integers and unproven counter scopes", () => {
  const base = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 };
  for (const usage of [
    { ...base, prompt_tokens_total: 99 },
    { ...base, completion_tokens_total: 29 },
    { ...base, prompt_tokens_total: -1 },
    { ...base, cache_read_input_tokens: "0" },
    { ...base, completion_tokens_total: 1.5 },
    { ...base, prompt_tokens_total: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, prompt_tokens_total: Number.MAX_SAFE_INTEGER },
    { ...base, prompt_tokens_total: 1_000, completion_tokens_total: 300, total_tokens: 1_300, cache_read_input_tokens: 60 },
    { ...base, total_tokens: 999 },
    { ...base, reasoning_tokens: 0, total_tokens: 999 },
  ]) {
    assert.equal(normalizeTraeUsage(usage), null, JSON.stringify(usage));
  }
  assert.equal(normalizeTraeUsage({ ...base, reasoning_tokens: 0, total_tokens: 999 },
    { model: "Gemini-3-Pro-Preview" }), null, "explicit reasoning is not replaced by a guessed residual");
});
