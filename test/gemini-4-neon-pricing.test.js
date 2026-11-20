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

// Official Standard paid-tier rates verified 2026-11-19:
// https://ai.google.dev/gemini-api/docs/pricing
// https://aistudio.google.com/docs/whats-new-gemini-4-neon
// https://cursor.com/docs/models-and-pricing
const neon = { input: 3, output: 15, cache_read: 0.15, cache_write: 0 };
const hydrogen = { input: 1.5, output: 7.5, cache_read: 0.075, cache_write: 0 };
const carbon = { input: 2, output: 10, cache_read: 0.1, cache_write: 0 };
const argon = { input: 2, output: 10, cache_read: 0.1, cache_write: 0 };

const rates = (model) => {
  const { input, output, cache_read, cache_write } = model;
  return { input, output, cache_read, cache_write };
};

const EDGE_SLUGS = [
  "tokentracker-leaderboard-refresh",
  "tokentracker-account-daily",
  "tokentracker-account-summary",
  "tokentracker-account-model-breakdown",
  "tokentracker-leaderboard-profile",
];

test("gemini-4-neon official Standard rates resolve offline for published thinking levels", () => {
  for (const name of [
    "gemini-4-neon",
    "gemini-4-neon-low",
    "gemini-4-neon-medium",
    "gemini-4-neon-high",
    "gemini-4-neon-xhigh",
    "gemini-4-neon-minimal",
    "gemini-4.neon",
    "gemini-4.neon-high",
  ]) {
    const hit = lookupPricing(name, { curated, litellm: {}, source: "cursor" });
    assert.equal(hit.hit, true, name);
    assert.deepEqual(rates(hit.value), neon, name);
    assert.deepEqual(rates(pricing.getModelPricing(name, { source: "cursor" })), neon, name);
    assert.equal(pricing.getModelPricingInfo(name, { source: "cursor" }).status, "priced", name);
  }
});

test("provider-qualified official Neon aliases price locally at Standard rates", () => {
  for (const source of ["cursor", "antigravity", "opencode"]) {
    for (const name of [
      "google/gemini-4-neon",
      "google/gemini-4-neon-high",
      "google/gemini-4-neon-xhigh",
      "google/gemini-4.neon",
      "google/gemini-4.neon-low",
      "openrouter/google/gemini-4-neon",
      "openrouter/google/gemini-4-neon-medium",
    ]) {
      const hit = lookupPricing(name, { curated, litellm: {}, source });
      assert.equal(hit.hit, true, `${source} ${name}`);
      assert.deepEqual(rates(hit.value), neon, `${source} ${name}`);
      assert.ok(Math.abs(pricing.computeRowCost({
        source,
        model: name,
        input_tokens: 1_000_000,
        cached_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }) - 18.15) < 1e-9, `${source} ${name}`);
    }
    // Sibling provider-qualified Hydrogen stays on the pre-existing local miss.
    assert.equal(lookupPricing("google/gemini-4-hydrogen", { curated, litellm: {}, source }).hit, false, `${source} hydrogen unchanged`);
  }
});

test("gemini-4-neon does not inherit Carbon, Argon, or Hydrogen rates", () => {
  const actual = rates(pricing.getModelPricing("gemini-4-neon", { source: "cursor" }));
  assert.notDeepEqual(actual, hydrogen);
  assert.notDeepEqual(actual, carbon);
  assert.notDeepEqual(actual, argon);
  assert.deepEqual(rates(pricing.getModelPricing("gemini-4-hydrogen", { source: "cursor" })), hydrogen);
  assert.deepEqual(rates(pricing.getModelPricing("gemini-4-carbon", { source: "cursor" })), carbon);
  assert.deepEqual(rates(pricing.getModelPricing("gemini-4-argon", { source: "cursor" })), argon);
});

test("Cline gateway namespaces keep official Neon ids at zero cost", () => {
  for (const name of [
    "cline-free/gemini-4-neon",
    "cline-pass/google/gemini-4-neon",
    "cline-free/gemini-4-neon-high",
    "cline-pass/gemini-4.neon",
  ]) {
    const hit = lookupPricing(name, { curated, litellm: {}, source: "cline" });
    assert.equal(hit.hit, true, name);
    assert.equal(hit.value.input, 0, name);
    assert.equal(pricing.computeRowCost({
      source: "cline",
      model: name,
      total_cost_usd: 0,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cached_input_tokens: 1_000_000,
    }), 0, name);
  }
  assert.ok(Math.abs(pricing.computeRowCost({
    source: "cursor",
    model: "google/gemini-4-neon",
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  }) - 18.15) < 1e-9);
});

test("unpublished Neon suffixes and Batch/Flex/Priority SKUs stay unpriced", () => {
  const names = [
    "gemini-4-neon-lite",
    "gemini-4-neon-cyber",
    "gemini-4-neon-for-cyber",
    "gemini-4-neon-batch",
    "gemini-4-neon-flex",
    "gemini-4-neon-priority",
    "google/gemini-4-neon-lite",
    "google/gemini-4-neon-cyber",
    "google/gemini-4-neon-for-cyber",
    "google/gemini-4-neon-batch",
    "google/gemini-4-neon-flex",
    "google/gemini-4-neon-priority",
    "google/gemini-4.neon-lite",
    "openrouter/google/gemini-4-neon-batch",
  ];
  for (const source of ["cursor", "antigravity"]) {
    for (const name of names) {
      const hit = lookupPricing(name, { curated, litellm: {}, source });
      assert.equal(hit.hit, false, `${source} ${name}`);
      const info = pricing.getModelPricingInfo(name, { source });
      assert.equal(info.status, "unpriced", `${source} ${name}`);
      assert.equal(pricing.computeRowCost({
        source,
        model: name,
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cached_input_tokens: 1_000_000,
      }), 0, `${source} ${name}`);
    }
  }
});

test("1MTok Neon row cost matches official Standard rates at 1e-9 precision", () => {
  const cost = pricing.computeRowCost({
    source: "cursor",
    model: "gemini-4-neon",
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - 18.15) < 1e-9, cost);
  const noCache = pricing.computeRowCost({
    source: "cursor",
    model: "gemini-4-neon-xhigh",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.ok(Math.abs(noCache - 18) < 1e-9, noCache);
});

for (const slug of EDGE_SLUGS) {
  test(`${slug}: official gemini-4-neon Standard rates are priced in the cloud`, () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../dashboard/edge-patches", `${slug}.ts`),
      "utf8",
    );
    const block = source.match(
      /const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/,
    );
    assert.ok(block, `${slug}: pricing block is present`);
    const context = vm.createContext({});
    vm.runInContext(transformSync(block[0], { loader: "ts", format: "cjs" }).code, context);

    for (const model of [
      "gemini-4-neon",
      "gemini-4-neon-low",
      "gemini-4-neon-medium",
      "gemini-4-neon-high",
      "gemini-4-neon-xhigh",
      "gemini-4-neon-minimal",
      "gemini-4.neon",
      "gemini-4.neon-high",
      "google/gemini-4-neon",
      "google/gemini-4-neon-xhigh",
    ]) {
      const actual = context.getModelPricing(model);
      assert.deepEqual(rates(actual), neon, `${slug} ${model}`);
    }

    for (const [model, expected] of [
      ["gemini-4-hydrogen", hydrogen],
      ["gemini-4-carbon-high", carbon],
      ["gemini-4-argon", argon],
    ]) {
      assert.deepEqual(rates(context.getModelPricing(model)), expected, `${slug} ${model} unchanged`);
    }

    for (const name of [
      "gemini-4-neon-lite",
      "gemini-4-neon-cyber",
      "gemini-4-neon-for-cyber",
      "gemini-4-neon-batch",
    ]) {
      assert.equal(context.getModelPricing(name).input, 0, `${slug} ${name}`);
    }
  });
}
