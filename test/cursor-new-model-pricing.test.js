"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { transformSync } = require("esbuild");
const pricing = require("../src/lib/pricing");
const { lookupPricing, normalizeCursorModel } = require("../src/lib/pricing/matcher");
const curated = require("../src/lib/pricing/curated-overrides.json");

// Cursor Models & Pricing (verified 2026-10-14):
// https://cursor.com/docs/models-and-pricing
// Gemini 4 Argon also matches Google's introductory list rate through 2026-11-30:
// https://ai.google.dev/gemini-api/docs/pricing
const argon = { input: 2, output: 10, cache_read: 0.1, cache_write: 0 };
const carbon = { input: 2, output: 10, cache_read: 0.1, cache_write: 0 };
const hydrogen = { input: 1.5, output: 7.5, cache_read: 0.075, cache_write: 0 };
const wonder = { input: 4, output: 20, cache_read: 0.2, cache_write: 0 };
const grok47 = { input: 2, output: 6, cache_read: 0.5, cache_write: 0 };
const grok47Fast = { input: 4, output: 12, cache_read: 1, cache_write: 0 };
const grok46 = { input: 2, output: 6, cache_read: 0.5, cache_write: 0 };
const grok46Fast = { input: 4, output: 12, cache_read: 1, cache_write: 0 };
const composer25 = { input: 0.5, output: 2.5, cache_read: 0.2 };
const composer25Fast = { input: 3, output: 15, cache_read: 0.5 };

const rates = (model) => {
  const { input, output, cache_read, cache_write } = model;
  return { input, output, cache_read, cache_write };
};

test("Gemini 4 and Muse Wonder effort variants resolve offline at their published rates", () => {
  for (const [model, expected, efforts] of [
    ["gemini-4-argon", argon, ["", "-minimal", "-low", "-medium", "-high"]],
    ["gemini-4-carbon", carbon, ["", "-low", "-medium", "-high"]],
    ["gemini-4-hydrogen", hydrogen, ["", "-low", "-medium", "-high", "-xhigh"]],
    ["muse-wonder-1.0", wonder, ["", "-minimal", "-low", "-medium", "-high", "-xhigh", "-extra-high", "-max"]],
  ]) {
    for (const effort of efforts) {
      const name = model + effort;
      const hit = lookupPricing(name, { curated, litellm: {}, source: "cursor" });
      assert.equal(hit.hit, true, name);
      assert.deepEqual(rates(hit.value), expected, name);
      assert.deepEqual(rates(pricing.getModelPricing(name, { source: "cursor" })), expected, name);
      assert.equal(pricing.getModelPricingInfo(name, { source: "cursor" }).status, "priced", name);
    }
  }
  for (const name of ["gemini-4-carbon-cyber-permissive", "gemini-4-hydrogen-lite", "muse-wonder-full-1.0"]) {
    assert.equal(lookupPricing(name, { curated, litellm: {}, source: "cursor" }).hit, false, name);
  }
});

test("normalizeCursorModel maps Cursor screenshot ids to curated keys", () => {
  assert.equal(normalizeCursorModel("gemini-4-argon-high"), "gemini-4-argon");
  assert.equal(normalizeCursorModel("gemini-4-argon-minimal"), "gemini-4-argon");
  assert.equal(normalizeCursorModel("grok-4.7-high-fast"), "cursor-grok-4.7-fast");
  assert.equal(normalizeCursorModel("grok-4.7-high"), "cursor-grok-4.7");
  assert.equal(normalizeCursorModel("grok-4.6-medium-fast"), "cursor-grok-4.6-fast");
  assert.equal(normalizeCursorModel("composer-2.5-fast"), "composer-2.5-fast");
  // Internal Grok Bot product ids stay literal — no public per-token price.
  assert.equal(normalizeCursorModel("grok-bot-cua"), "grok-bot-cua");
  assert.equal(normalizeCursorModel("grok-bot-default"), "grok-bot-default");
  assert.equal(normalizeCursorModel("grok-bot-automation"), "grok-bot-automation");
});

test("Cursor screenshot models resolve offline at published rates", () => {
  assert.deepEqual(
    rates(pricing.getModelPricing("gemini-4-argon-high", { source: "cursor" })),
    argon,
  );
  assert.deepEqual(
    rates(pricing.getModelPricing("grok-4.7-high-fast", { source: "cursor" })),
    grok47Fast,
  );
  assert.deepEqual(
    rates(pricing.getModelPricing("grok-4.7-high", { source: "cursor" })),
    grok47,
  );
  assert.deepEqual(
    rates(pricing.getModelPricing("composer-2.5-fast", { source: "cursor" })),
    { ...composer25Fast, cache_write: undefined },
  );
  assert.deepEqual(
    rates(pricing.getModelPricing("composer-2.5", { source: "cursor" })),
    { ...composer25, cache_write: undefined },
  );
  assert.deepEqual(
    rates(pricing.getModelPricing("grok-4.6-fast", { source: "cursor" })),
    grok46Fast,
  );
  assert.deepEqual(
    rates(pricing.getModelPricing("grok-4.6", { source: "cursor" })),
    grok46,
  );

  // Must not fall through to older Composer / xAI Grok 4 rates.
  assert.notEqual(
    pricing.getModelPricing("composer-2.5-fast", { source: "cursor" }).input,
    1.25,
  );
  assert.notEqual(
    pricing.getModelPricing("grok-4.7-high-fast", { source: "cursor" }).input,
    3,
  );
});

test("Grok Bot internal ids stay unpriced without inventing rates", () => {
  for (const model of ["grok-bot-cua", "grok-bot-default", "grok-bot-automation"]) {
    const info = pricing.getModelPricingInfo(model, { source: "cursor" });
    assert.equal(info.status, "unpriced", model);
    assert.equal(info.source, "cursor_subscription", model);
    assert.equal(pricing.getModelPricingInfo(model, { source: "claude" }).source, null, model);
    assert.equal(pricing.computeRowCost({
      source: "cursor",
      model,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cached_input_tokens: 1_000_000,
    }), 0, model);
  }
});

test("cloud model metadata keeps Grok Bot costs unknown and identifies subscription usage", () => {
  const source = fs.readFileSync(path.join(__dirname, "../dashboard/edge-patches/tokentracker-account-model-breakdown.ts"), "utf8");
  const block = source.match(/const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/);
  const metadata = source.match(/function getUsageModelPricing\([\s\S]*?\n\}/);
  const context = vm.createContext({});
  vm.runInContext(transformSync(block[0] + "\n" + metadata[0], { loader: "ts", format: "cjs" }).code, context);
  for (const model of ["grok-bot-default", "grok-bot-automation", "grok-bot-cua"]) {
    assert.equal(context.getUsageModelPricing(model, "cursor").source, "cursor_subscription");
    assert.equal(context.getUsageModelPricing(model, "cursor").status, "unpriced");
    assert.equal(context.getUsageModelPricing(model, "claude").source, null);
  }
});

test("curated exact wins over LiteLLM / fuzzy for these Cursor SKUs", () => {
  const litellm = {
    "xai/grok-4.7": { input: 99, output: 99, cache_read: 99 },
    "composer-1": { input: 1.25, output: 10, cache_read: 0.125 },
  };
  for (const [model, expected] of [
    ["gemini-4-argon", argon],
    ["cursor-grok-4.7-fast", grok47Fast],
    ["composer-2.5-fast", composer25Fast],
  ]) {
    const hit = lookupPricing(model, { curated, litellm, source: "cursor" });
    assert.equal(hit.source, "curated:exact", model);
    assert.equal(hit.value.input, expected.input, model);
  }
});

test("1MTok row costs match published Cursor rates", () => {
  assert.ok(Math.abs(pricing.computeRowCost({
    source: "cursor",
    model: "gemini-4-argon-high",
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  }) - 12.1) < 1e-9);
  assert.ok(Math.abs(pricing.computeRowCost({
    source: "cursor",
    model: "grok-4.7-high-fast",
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  }) - 17) < 1e-9);
  assert.ok(Math.abs(pricing.computeRowCost({
    source: "cursor",
    model: "composer-2.5-fast",
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  }) - 18.5) < 1e-9);
});

for (const slug of [
  "tokentracker-leaderboard-refresh", "tokentracker-account-daily",
  "tokentracker-account-summary", "tokentracker-account-model-breakdown",
  "tokentracker-leaderboard-profile",
]) {
  test(`${slug}: Cursor new models are priced in the cloud`, () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../dashboard/edge-patches", `${slug}.ts`),
      "utf8",
    );
    const block = source.match(
      /const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/,
    );
    assert.ok(block, `${slug}: pricing block is present`);
    const script = transformSync(block[0], { loader: "ts", format: "cjs" }).code;
    const context = vm.createContext({});
    vm.runInContext(script, context);

    const cases = [
      ["gemini-4-argon-high", argon],
      ["google/gemini-4-argon", argon],
      ["gemini-4-carbon-high", carbon],
      ["google/gemini-4-carbon", carbon],
      ["gemini-4-hydrogen-xhigh", hydrogen],
      ["gemini-4-hydrogen-high", hydrogen],
      ["gemini-4.hydrogen-low", hydrogen],
      ["muse-wonder-1.0-max", wonder],
      ["muse-wonder-1.0-high", wonder],
      ["meta/muse-wonder-1.0", wonder],
      ["grok-4.7-high-fast", grok47Fast],
      ["grok-4.7", grok47],
      ["grok-4.6-fast", grok46Fast],
      ["composer-2.5-fast", composer25Fast],
      ["composer-2.5", composer25],
    ];
    for (const [model, expected] of cases) {
      const actual = context.getModelPricing(model);
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(actual[key], value, `${slug} ${model}: ${key}`);
      }
    }
    // Must not collapse Composer 2.5 Fast onto composer-1 ($1.25).
    assert.equal(context.getModelPricing("composer-2.5-fast").input, 3);
    // Must not collapse Grok 4.7 Fast onto xAI grok-4 ($3).
    assert.equal(context.getModelPricing("grok-4.7-high-fast").input, 4);
    for (const name of ["gemini-4-carbon-cyber-permissive", "gemini-4-hydrogen-lite", "muse-wonder-full-1.0"]) {
      assert.equal(context.getModelPricing(name).input, 0, name);
    }
  });
}
