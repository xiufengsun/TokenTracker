"use strict";

// The cloud edge functions each embed a hand-maintained copy of the model
// pricing table (MODEL_PRICING + getModelPricing fuzzy chain). These copies
// MUST be byte-identical across all five files — drift silently prices the
// same row differently per endpoint (real incident: leaderboard-profile
// missed kimi-k2.6 + the mimo-v2.5 family until 2026-06, so the profile
// modal showed $0 / -60% cost for those models while the leaderboard list
// priced them correctly). This test fails loudly on any divergence.
//
// To change pricing: edit tokentracker-leaderboard-refresh.ts (canonical),
// then copy the identical block into the other four files.

const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const EDGE_DIR = "dashboard/edge-patches";

const CANONICAL = "tokentracker-leaderboard-refresh.ts";
const MIRRORS = [
  "tokentracker-account-daily.ts",
  "tokentracker-account-summary.ts",
  "tokentracker-account-model-breakdown.ts",
  "tokentracker-leaderboard-profile.ts",
];

const BLOCK_RE =
  /const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string\) \{[\s\S]*?\n\}/;

function readEdge(name) {
  return fs.readFileSync(path.join(ROOT, EDGE_DIR, name), "utf8");
}

function extractBlock(name) {
  const m = readEdge(name).match(BLOCK_RE);
  assert.ok(m, `${name}: MODEL_PRICING/getModelPricing block not found`);
  return m[0];
}

const ROW_PRICING_RE = /\nfunction getRowPricing\([\s\S]*?\n\}/;

function extractRowPricing(name) {
  const m = readEdge(name).match(ROW_PRICING_RE);
  assert.ok(m, `${name}: getRowPricing not found`);
  return m[0];
}

test("MODEL_PRICING + getModelPricing are byte-identical across all 5 edge files", () => {
  const canonical = extractBlock(CANONICAL);
  for (const name of MIRRORS) {
    assert.strictEqual(
      extractBlock(name),
      canonical,
      `${name} pricing block drifted from ${CANONICAL} — copy the canonical block over verbatim`,
    );
  }
});

test("canonical pricing block retains regression-prone entries and matcher order", () => {
  const block = extractBlock(CANONICAL);

  // Entries whose absence has already shipped real mispricing.
  for (const key of [
    '"kimi-k2.6"',
    '"mimo-v2.5-pro"',
    '"mimo-v2.5"',
    '"mimo-v2-flash"',
    '"cursor-grok-4.5"',
    '"cursor-grok-4.5-fast"',
    '"glm-5.3"',
    '"glm-5.3-flash"',
    '"qwen3.8-flash"',
    '"qwen3.8-max"',
  ]) {
    assert.ok(block.includes(`${key}:`), `canonical table lost ${key}`);
  }

  // gpt-5.4-medium is NOT a SKU (reasoning-effort suffix); a stale exact
  // entry used to bill it at 60% of the real gpt-5.4 rate.
  assert.ok(
    !block.includes('"gpt-5.4-medium":'),
    "gpt-5.4-medium exact entry reintroduced — it must fall through to gpt-5.4",
  );

  // Specific matchers must precede their broader substring matchers.
  const order = (a, b) => {
    const ia = block.indexOf(a);
    const ib = block.indexOf(b);
    assert.ok(ia !== -1, `matcher missing: ${a}`);
    assert.ok(ib !== -1, `matcher missing: ${b}`);
    assert.ok(ia < ib, `matcher "${a}" must precede "${b}"`);
  };
  order('lower.includes("gpt-5.4-pro")', 'lower.includes("gpt-5.4")');
  order('lower.includes("gpt-5.1-codex-mini")', 'lower.includes("gpt-5.1")');
  order(
    'lower.includes("gemini-3") && lower.includes("pro")',
    'lower.includes("gemini-3"))',
  );
  order('lower.includes("kimi-k2.6")', 'lower.includes("kimi")');
  order('lower.includes("mimo-v2.5-pro")', 'lower.includes("mimo-v2.5")');
  order(
    'lower.includes("grok-4.5") && lower.includes("fast")',
    'lower.includes("grok-4.5"))',
  );
  order('lower.includes("grok-4.5"))', 'lower.includes("grok-4"))');
  // GLM-5.3 Flash is a distinct cheap SKU ($0.15/$0.50 vs the flagship's
  // $1.4/$4.4); its matcher must precede the base glm-5.3 matcher (substring)
  // and glm-5.3 must precede glm-5, or flash rows bill at 6.7x.
  order('lower.includes("glm-5.3-flash")', 'lower.includes("glm-5.3")');
  order('lower.includes("glm-5.3")', 'lower.includes("glm-5")');
});

test("all cloud cost paths keep Pi Copilot subscription rows at zero cost", () => {
  for (const name of [CANONICAL, ...MIRRORS]) {
    const source = readEdge(name);
    assert.ok(source.includes('"pi-github-copilot"'), `${name}: Pi Copilot source missing`);
    assert.ok(source.includes('"pi-copilot"'), `${name}: Pi Copilot alias missing`);
    if (name === "tokentracker-account-model-breakdown.ts") {
      assert.match(
        source,
        /ma\.totalCostUsd \+= subscriptionBacked\s*\? 0/,
        `${name}: subscription rows must bypass model pricing`,
      );
    } else {
      assert.match(
        source,
        /if \(row\.source === "pi-github-copilot" \|\| row\.source === "pi-copilot"\) return 0;/,
        `${name}: subscription rows must bypass model pricing`,
      );
    }
  }
});

test("all cloud cost paths distinguish local usage from metered Unsloth providers", () => {
  for (const name of [CANONICAL, ...MIRRORS]) {
    const source = readEdge(name);
    assert.ok(source.includes('"lmstudio"'), `${name}: LM Studio zero-cost guard missing`);
    assert.ok(
      source.includes('__tokentracker_unpriced_unsloth_model__'),
      `${name}: Unsloth local/unpriced model guard missing`,
    );
    assert.match(
      source,
      /\^\(local\|unpriced\)\\\//,
      `${name}: Unsloth guard must cover local and ambiguous provider routes`,
    );
    assert.match(
      source,
      /String\(row\.model \|\| (?:""|"unknown")\)\.trim\(\)/,
      `${name}: model must be trimmed before the Unsloth pricing guard`,
    );
  }
});

test("all cloud cost paths only prefer provider-reported costs for authoritative sources", () => {
  for (const name of [CANONICAL, ...MIRRORS]) {
    const source = readEdge(name);
    assert.ok(source.includes("total_cost_usd"), `${name}: reported cost field missing`);
    assert.ok(source.includes("reportedCost"), `${name}: reported cost branch missing`);
    assert.match(
      source,
      /const SOURCES_WITH_AUTHORITATIVE_COST = new Set\(\["grok"\]\);/,
      `${name}: authoritative cost sources must be explicitly allowlisted`,
    );
    assert.match(
      source,
      /SOURCES_WITH_AUTHORITATIVE_COST\.has\((?:row\.source|src)\)[\s\S]*?Number\.isFinite\(reportedCost\)[\s\S]*?reportedCost > 0/,
      `${name}: positive reported cost must be gated by source`,
    );
  }
});

test("all cloud cost paths retain DeepSeek V4 peak/off-peak pricing tiers", () => {
  for (const name of [CANONICAL, ...MIRRORS]) {
    const source = readEdge(name);
    assert.ok(source.includes('function getRowPricing('), `${name}: row pricing helper missing`);
    assert.ok(source.includes('pricing_tier === "off_peak"'), `${name}: off-peak tier missing`);
    assert.ok(source.includes('hour >= 1 && hour < 4'), `${name}: first peak window missing`);
    assert.ok(source.includes('hour >= 6 && hour < 10'), `${name}: second peak window missing`);
    assert.ok(
      source.includes("Date.UTC(2026, 7, 22, 16, 0, 0)"),
      `${name}: Beijing weekend off-peak rule missing`,
    );
    assert.ok(
      source.includes("timestamp + 8 * 60 * 60 * 1000).getUTCDay()"),
      `${name}: weekend must be read in Beijing time, not on the raw UTC instant`,
    );
  }
  // getRowPricing carries the tier logic and is copied by hand like the pricing
  // block above, so hold it to the same byte-identical rule. Substring checks
  // alone let one file's window drift while every assertion still passes.
  const canonicalRow = extractRowPricing(CANONICAL);
  for (const name of MIRRORS) {
    assert.strictEqual(
      extractRowPricing(name),
      canonicalRow,
      `${name} getRowPricing drifted from ${CANONICAL} — copy the canonical function over verbatim`,
    );
  }
  const breakdown = readEdge("tokentracker-account-model-breakdown.ts");
  assert.match(
    breakdown,
    /ma\.totalCostUsd \+= subscriptionBacked/,
    "model breakdown must price each pricing-tier row before collapsing models",
  );
});
