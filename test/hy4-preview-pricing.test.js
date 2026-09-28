"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { transformSync } = require("esbuild");
const pricing = require("../src/lib/pricing");

// Tencent TokenHub: 6 / 0.3 (cache hit) / 18 RMB per MTok, at ~7.2 RMB/USD (#633).
const rates = { input: 0.833, output: 2.5, cache_read: 0.042, cache_write: 0.833 };
const models = ["hy4-preview", "hy4-preview-agent", "HY4-PREVIEW", "tencent/hy4-preview"];
const row = {
  source: "workbuddy", model: "hy4-preview", input_tokens: 1_000_000,
  cached_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
  output_tokens: 1_000_000,
};

test("hy4-preview resolves locally, including the -agent and provider forms", () => {
  for (const model of models) {
    const actual = pricing.getModelPricing(model, { source: "workbuddy" });
    for (const [key, value] of Object.entries(rates)) {
      assert.equal(actual[key], value, `${model}: ${key}`);
    }
  }
  // Must not collapse onto the hy3 family's rates.
  assert.equal(pricing.getModelPricing("hy3-preview", { source: "workbuddy" }).input, 0.167);
  assert.ok(Math.abs(pricing.computeRowCost(row) - 4.208) < 1e-9);
});

for (const slug of [
  "tokentracker-leaderboard-refresh", "tokentracker-account-daily",
  "tokentracker-account-summary", "tokentracker-account-model-breakdown",
  "tokentracker-leaderboard-profile",
]) {
  test(`${slug}: hy4-preview is priced in the cloud`, () => {
    const source = fs.readFileSync(path.join(__dirname, "../dashboard/edge-patches", `${slug}.ts`), "utf8");
    const block = source.match(/const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/);
    assert.ok(block, `${slug}: pricing block is present`);
    const script = transformSync(block[0], { loader: "ts", format: "cjs" }).code;
    const context = vm.createContext({});
    vm.runInContext(script, context);
    for (const model of models) {
      const actual = context.getModelPricing(model);
      for (const [key, value] of Object.entries(rates)) {
        assert.equal(actual[key], value, `${slug} ${model}: ${key}`);
      }
    }
  });
}
