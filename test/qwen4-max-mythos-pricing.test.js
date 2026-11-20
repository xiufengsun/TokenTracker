"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { transformSync } = require("esbuild");
const pricing = require("../src/lib/pricing");
const matcher = require("../src/lib/pricing/matcher");
const { lookupPricing } = require("../src/lib/pricing/matcher");
const curated = require("../src/lib/pricing/curated-overrides.json");

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const fields = ["input", "output", "cache_read", "cache_write"];
const slugs = [
  "tokentracker-leaderboard-refresh",
  "tokentracker-account-daily",
  "tokentracker-account-summary",
  "tokentracker-account-model-breakdown",
  "tokentracker-leaderboard-profile",
];

const QWEN4_MAX = { input: 1.5, output: 4.5, cache_read: 0.075, cache_write: 1.875 };
const MYTHOS_52 = { input: 8, output: 40, cache_read: 0.2, cache_write: 10 };
const MYTHOS_52_FAST = { input: 16, output: 80, cache_read: 0.4, cache_write: 20 };
const MYTHOS_51 = { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 };
const MYTHOS_5 = { input: 10, output: 50, cache_read: 1, cache_write: 12.5 };

function assertRates(got, expected, id) {
  for (const field of fields) {
    assert.equal(got[field], expected[field], `${id}.${field}`);
  }
}

function loadEdgePricing() {
  const src = fs.readFileSync(
    path.join(__dirname, "../dashboard/edge-patches/tokentracker-leaderboard-refresh.ts"),
    "utf8",
  );
  const block = src.match(/const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/)[0];
  const { code } = transformSync(
    `${block}\nexport { getModelPricing, MODEL_PRICING };`,
    { loader: "ts", format: "cjs" },
  );
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require });
  return module.exports;
}

test("normalizeClaudeModel hyphenates dotted Mythos minors like Fable", () => {
  assert.equal(matcher.normalizeClaudeModel("claude-mythos-5.2"), "claude-mythos-5-2");
  assert.equal(matcher.normalizeClaudeModel("claude-mythos-5.2-fast"), "claude-mythos-5-2-fast");
  assert.equal(matcher.normalizeClaudeModel("claude-mythos-5.1"), "claude-mythos-5-1");
  assert.equal(matcher.normalizeClaudeModel("anthropic/claude-mythos-5.2"), "claude-mythos-5-2");
  assert.equal(matcher.normalizeClaudeModel("claude-fable-5.2"), "claude-fable-5-2");
  assert.equal(matcher.normalizeClaudeModel("claude-fable-5.2-fast"), "claude-fable-5-2-fast");
});

test("curated qwen4-max rates keep official Singapore International precision", () => {
  assertRates(curated.exact["qwen4-max"], QWEN4_MAX, "curated qwen4-max");
  assert.equal(curated.exact["qwen4-max"].input, 1.5);
  assert.equal(curated.exact["qwen4-max"].output, 4.5);
  assert.equal(curated.exact["qwen4-max"].cache_read, 0.075);
  assert.equal(curated.exact["qwen4-max"].cache_write, 1.875);
  assert.equal(String(curated.exact["qwen4-max"].input), "1.5");
  assert.equal(String(curated.exact["qwen4-max"].cache_write), "1.875");
  assert.equal(String(curated.exact["qwen4-max"].cache_read), "0.075");
});

test("qwen4-max official API ids use Singapore International rates; preview and unknown qwen4 SKUs stay unpriced", () => {
  const priced = [
    "qwen4-max",
    "dashscope/qwen4-max",
    "openrouter/qwen/qwen4-max",
    "qwen/qwen4-max",
    "qwen4-max-2026-11-16",
  ];
  for (const id of priced) {
    assertRates(pricing.getModelPricing(id), QWEN4_MAX, id);
    assert.equal(pricing.getModelPricingInfo(id).status, "priced", id);
  }
  const unpriced = [
    "qwen4-max-preview",
    "qwen4-max-preview-2026-11-11",
    "dashscope/qwen4-max-preview",
    "openrouter/qwen/qwen4-max-preview",
    "qwen4-plus",
    "qwen4-flash",
    "qwen4-max-plus",
    "qwen4",
    "qwen4-max-thinking",
  ];
  for (const id of unpriced) {
    assert.equal(pricing.getModelPricingInfo(id).status, "unpriced", id);
  }
  // Existing Qwen 3.8 Max rates are unchanged.
  assert.equal(pricing.getModelPricing("qwen3.8-max").input, 2);
  assert.equal(pricing.getModelPricing("qwen3.8-max").output, 6);
  const stale = lookupPricing("qwen4-max", { curated, litellm: { "qwen4-max": { input: 999, output: 999 } } });
  assert.equal(stale.value.input, 1.5);
  close(
    pricing.computeRowCost({
      source: "openrouter",
      model: "qwen4-max",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cached_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    }),
    1.5 + 4.5 + 0.075 + 1.875,
  );
});

test("Claude Mythos 5.2 standard ids price at $8/$40 and never fall through to Mythos 5", () => {
  const ids = [
    "claude-mythos-5-2",
    "claude-mythos-5.2",
    "Claude Mythos 5.2",
    "Mythos 5.2",
    "anthropic/claude-mythos-5.2",
    "anthropic/claude-mythos-5-2",
    "anthropic.claude-mythos-5-2",
    "global.anthropic.claude-mythos-5-2",
    "us.anthropic.claude-mythos-5-2",
    "eu.anthropic.claude-mythos-5-2",
    "vertex_ai/claude-mythos-5-2",
    "azure_ai/claude-mythos-5-2",
    "openrouter/anthropic/claude-mythos-5.2",
  ];
  for (const id of ids) {
    assertRates(pricing.getModelPricing(id, { source: "claude" }), MYTHOS_52, id);
  }
  for (const id of ["anthropic/claude-mythos-5.2", "bedrock/us-gov-east-1/anthropic.claude-mythos-5-2", "Mythos 5.2", "Claude Mythos 5.2"]) {
    const got = pricing.getModelPricing(id);
    assert.equal(got.input, 8, id);
    assert.equal(got.output, 40, id);
  }
  assertRates(pricing.getModelPricing("claude-mythos-5"), MYTHOS_5, "claude-mythos-5");
  assertRates(pricing.getModelPricing("claude-fable-5-2"), MYTHOS_52, "fable 5.2 unchanged");
});

test("Claude Mythos version bounds, fast mode, and unpinned aliases", () => {
  for (const id of [
    "claude-mythos-5-2-fast",
    "claude-mythos-5.2-fast",
    "azure_ai/claude-mythos-5-2-fast",
    "anthropic/claude-mythos-5.2-fast",
  ]) {
    assertRates(pricing.getModelPricing(id, { source: "claude" }), MYTHOS_52_FAST, id);
  }
  // Provider-qualified hyphenated fast ids must not inherit the longer
  // anthropic/claude-mythos-5-2 contained exact key when no Claude
  // normalizer runs (source is missing or is a gateway such as opencode).
  for (const [source, id] of [
    [undefined, "anthropic/claude-mythos-5-2-fast"],
    ["opencode", "anthropic/claude-mythos-5-2-fast"],
    ["opencode", "openrouter/anthropic/claude-mythos-5-2-fast"],
    ["opencode", "anthropic/claude-mythos-5.2-fast"],
    [undefined, "anthropic/claude-fable-5-2-fast"],
    ["opencode", "anthropic/claude-fable-5-2-fast"],
  ]) {
    const got = pricing.getModelPricing(id, source ? { source } : {});
    assertRates(got, MYTHOS_52_FAST, `${source || "unsourced"} ${id}`);
    close(
      pricing.computeRowCost({
        source: source || "opencode",
        model: id,
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
      96,
    );
  }
  for (const id of [
    "claude-mythos-5-1",
    "claude-mythos-5.1",
    "anthropic/claude-mythos-5.1",
    "anthropic/claude-mythos-5-1",
    "anthropic.claude-mythos-5-1",
    "Mythos 5.1",
  ]) {
    assertRates(pricing.getModelPricing(id, { source: "claude" }), MYTHOS_51, id);
  }
  for (const id of ["claude-mythos-5", "anthropic.claude-mythos-5", "Mythos 5"]) {
    assertRates(pricing.getModelPricing(id, { source: "claude" }), MYTHOS_5, id);
  }
  const unpriced = [
    "claude-mythos-latest",
    "anthropic/claude-mythos-latest",
    "vertex_ai/claude-mythos-latest",
    "claude-mythos-preview",
    "anthropic/claude-mythos-preview",
    "claude-mythos-5-20250901",
    "claude-mythos-5-20261109",
    "mythos-5-20",
    "claude-mythos-5-20",
    "claude-mythos-5-21",
    "claude-mythos",
  ];
  for (const id of unpriced) {
    assert.equal(pricing.getModelPricingInfo(id, { source: "claude" }).status, "unpriced", id);
    assert.equal(pricing.getModelPricingInfo(id).status, "unpriced", `${id} unsourced`);
  }
  close(
    pricing.computeRowCost({
      source: "claude",
      model: "claude-mythos-5-2",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
    48,
  );
});

test("edge MODEL_PRICING and getModelPricing match official qwen4-max and Mythos tables", () => {
  const { getModelPricing, MODEL_PRICING } = loadEdgePricing();
  assertRates(MODEL_PRICING["qwen4-max"], QWEN4_MAX, "edge exact qwen4-max");
  assertRates(MODEL_PRICING["claude-mythos-5-2"], MYTHOS_52, "edge exact mythos 5.2");
  assertRates(MODEL_PRICING["claude-mythos-5.2"], MYTHOS_52, "edge exact dotted mythos 5.2");
  assertRates(MODEL_PRICING["claude-mythos-5-2-fast"], MYTHOS_52_FAST, "edge exact mythos 5.2 fast");
  assertRates(MODEL_PRICING["claude-mythos-5-1"], MYTHOS_51, "edge exact mythos 5.1");
  assertRates(MODEL_PRICING["claude-mythos-5"], MYTHOS_5, "edge exact mythos 5");

  const cases = [
    ["qwen4-max", QWEN4_MAX],
    ["dashscope/qwen4-max", QWEN4_MAX],
    ["openrouter/qwen/qwen4-max", QWEN4_MAX],
    ["claude-mythos-5-2", MYTHOS_52],
    ["claude-mythos-5.2", MYTHOS_52],
    ["anthropic/claude-mythos-5.2", MYTHOS_52],
    ["global.anthropic.claude-mythos-5-2", MYTHOS_52],
    ["Claude Mythos 5.2", MYTHOS_52],
    ["claude-mythos-5-2-fast", MYTHOS_52_FAST],
    ["claude-mythos-5.2-fast", MYTHOS_52_FAST],
    ["claude-mythos-5-1", MYTHOS_51],
    ["claude-mythos-5.1", MYTHOS_51],
    ["claude-mythos-5", MYTHOS_5],
    ["Mythos 5", MYTHOS_5],
    ["claude-fable-5-2", MYTHOS_52],
    ["qwen3.8-max", { input: 2, output: 6, cache_read: 0.17, cache_write: 2.5 }],
  ];
  for (const [id, expected] of cases) {
    assertRates(getModelPricing(id), expected, `edge ${id}`);
  }

  const unpriced = [
    "qwen4-max-preview",
    "qwen4-plus",
    "qwen4-flash",
    "claude-mythos-latest",
    "claude-mythos-preview",
    "claude-mythos-5-20250901",
    "claude-mythos-5-20",
    "mythos-5-20",
  ];
  const zero = { input: 0, output: 0, cache_read: 0 };
  for (const id of unpriced) {
    const got = getModelPricing(id);
    assert.equal(got.input, 0, `edge ${id} input`);
    assert.equal(got.output, 0, `edge ${id} output`);
    assert.equal(got.cache_read, zero.cache_read, `edge ${id} cache_read`);
  }

  // Pre-existing Fable lookups stay on their official rates.
  assertRates(getModelPricing("claude-fable-5"), { input: 10, output: 50, cache_read: 1, cache_write: 12.5 }, "edge fable 5");
  assertRates(getModelPricing("claude-fable-5-2-fast"), MYTHOS_52_FAST, "edge fable 5.2 fast");
});

test("five edge pricing blocks stay byte-identical after the qwen4-max and Mythos additions", () => {
  const blockRe = /const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/;
  const dir = path.join(__dirname, "../dashboard/edge-patches");
  const canonical = fs.readFileSync(path.join(dir, `${slugs[0]}.ts`), "utf8").match(blockRe)[0];
  for (const slug of slugs.slice(1)) {
    const block = fs.readFileSync(path.join(dir, `${slug}.ts`), "utf8").match(blockRe)[0];
    assert.equal(block, canonical, slug);
  }
});
