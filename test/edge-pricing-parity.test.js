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
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const { test } = require("node:test");
const assert = require("node:assert");
const curatedPricing = require("../src/lib/pricing/curated-overrides.json");

const ROOT = path.join(__dirname, "..");
const EDGE_DIR = "dashboard/edge-patches";

const CANONICAL = "tokentracker-leaderboard-refresh.ts";
const MIRRORS = [
  "tokentracker-account-daily.ts",
  "tokentracker-account-summary.ts",
  "tokentracker-account-model-breakdown.ts",
  "tokentracker-leaderboard-profile.ts",
];

const MODEL_API_CALL_SITES = [
  // account-daily folds per-model totals in Postgres (account_daily_compact),
  // same as account-heatmap below: the call site to pin is the one copying
  // Postgres' model keys through untouched.
  [
    "tokentracker-account-daily.ts",
    /for \(const name of Object\.keys\(models\)\) mdl\[name\] = Number\(models\[name\]\) \|\| 0;/,
  ],
  ["tokentracker-account-model-breakdown.ts", /model: mdl, model_id: mdl/],
  ["tokentracker-leaderboard-profile.ts", /favoriteModel = \{ model_name: model, total_tokens: tokens \};/],
  ["tokentracker-account-hourly.ts", /const mdl = String\(row\.model \|\| "unknown"\);/],
  ["tokentracker-account-monthly.ts", /const mdl = String\(row\.model \|\| "unknown"\);/],
  // account-heatmap folds per-model totals in Postgres (account_heatmap_compact),
  // so there is no per-row String(row.model) here any more. The call site to pin
  // is the one that copies Postgres' model keys through untouched — that is what
  // would break if someone reintroduced display-name mapping on the edge.
  [
    "tokentracker-account-heatmap.ts",
    /for \(const name of Object\.keys\(models\)\) mdl\[name\] = Number\(models\[name\]\) \|\| 0;/,
  ],
];

const BLOCK_RE =
  /const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/;

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

test("Qwen3.8 Flash local and all cloud paths share full cache pricing (#715)", () => {
  const { getModelPricing: localPricing, computeRowCost } = require("../src/lib/pricing");
  const expected = { input: 0.15, output: 0.47, cache_read: 0.016, cache_write: 0.2 };
  const variants = ["qwen3.8-flash", "QWEN3.8-FLASH", "qwen3-8-flash", "dashscope/qwen3.8-flash",
    "qwen_ai_platform/qwen3.8-flash", "openrouter/qwen/qwen3.8-flash", "qwen3.8-flash-2026-09-01"];
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const edgePricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    for (const model of variants) {
      const local = localPricing(model);
      assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, local[key]])), expected, model);
      assert.deepEqual(JSON.parse(JSON.stringify(edgePricing(model))), expected, `${name}: ${model}`);
      const cost = computeRowCost({ model, input_tokens: 1e6, output_tokens: 1e6,
        cached_input_tokens: 1e6, cache_creation_input_tokens: 1e6 });
      assert.ok(Math.abs(cost - 0.836) < 1e-12, `${model}: cache cost must not be omitted`);
    }
    for (const model of ["qwen3.8-flash-next", "qwen3.8-max", "qwen3.7-flash"]) {
      assert.notDeepEqual(JSON.parse(JSON.stringify(edgePricing(model))), expected, `${name}: distinct SKU ${model}`);
    }
  }
});

test("Qwen3.8 Max local and all cloud paths share Singapore International rates (#744)", () => {
  const { getModelPricing: localPricing, computeRowCost } = require("../src/lib/pricing");
  const expected = { input: 2, output: 6, cache_read: 0.17, cache_write: 2.5 };
  const variants = ["qwen3.8-max", "QWEN3.8-MAX", "qwen3-8-max", "qwen3.8-max-0902",
    "qwen3.8-max-2026-09-02", "dashscope/qwen3.8-max", "openrouter/qwen/qwen3.8-max"];
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const edgePricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    for (const model of variants) {
      const local = localPricing(model);
      assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, local[key]])), expected, model);
      assert.deepEqual(JSON.parse(JSON.stringify(edgePricing(model))), expected, `${name}: ${model}`);
    }
    const cost = computeRowCost({ model: "qwen3.8-max", input_tokens: 1e6, output_tokens: 1e6,
      cached_input_tokens: 1e6, cache_creation_input_tokens: 1e6 });
    assert.ok(Math.abs(cost - 10.67) < 1e-12, "qwen3.8-max cache cost must not be omitted");
    // Distinct from Flash
    assert.notDeepEqual(JSON.parse(JSON.stringify(edgePricing("qwen3.8-max"))),
      JSON.parse(JSON.stringify(edgePricing("qwen3.8-flash"))));
  }
});

test("canonical pricing block retains regression-prone entries and matcher order", () => {
  const block = extractBlock(CANONICAL);

  // Entries whose absence has already shipped real mispricing.
  for (const key of [
    '"kimi-k2.6"',
    '"qwen3.8-max"',
    '"qwen3.8-max-0902"',
    '"qwen3.8-max-2026-09-02"',
    '"mimo-v2.5-pro"',
    '"mimo-v2.5"',
    '"mimo-v2-flash"',
    '"cursor-grok-4.5"',
    '"cursor-grok-4.5-fast"',
    '"cursor-grok-4.6"',
    '"cursor-grok-4.6-fast"',
    '"cursor-grok-4.7"',
    '"cursor-grok-4.7-fast"',
    '"composer-2.5"',
    '"composer-2.5-fast"',
    '"gemini-4-argon"',
    '"kimi-k3.1-pro"',
    '"kimi-k3.1-pro-highspeed"',
    '"glm-5.3"',
    '"glm-5.3-flash"',
    '"deepseek-v4.1-flash"',
    '"deepseek-flash"',
    '"claude-haiku-5-5"',
    // #929: LiteLLM-only models promoted into curated + edge so cloud account
    // views price them; these entries must never silently disappear again.
    '"claude-opus-4-5"',
    '"gpt-5.3-codex-spark"',
    '"gpt-6-luna"',
    '"muse-spark-1.2-contributor"',
    '"muse-spark-1.3-contributor"',
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
    'lower.includes("grok-4.7") && lower.includes("fast")',
    'lower.includes("grok-4.7"))',
  );
  order('lower.includes("grok-4.7"))', 'lower.includes("grok-4.6"))');
  order(
    'lower.includes("grok-4.6") && lower.includes("fast")',
    'lower.includes("grok-4.6"))',
  );
  order('lower.includes("grok-4.6"))', 'lower.includes("grok-4.5"))');
  order(
    'lower.includes("grok-4.5") && lower.includes("fast")',
    'lower.includes("grok-4.5"))',
  );
  order('lower.includes("grok-4.5"))', 'lower.includes("grok-4"))');
  order('lower.includes("gemini-4-argon")', 'lower.includes("gemini-3"))');
  order('lower.includes("kimi-k3.1-pro-highspeed")', 'lower.includes("kimi-k3.1-pro")');
  order('lower.includes("kimi-k3.1-pro")', 'lower.includes("kimi-k3")');
  order('lower.includes("kimi-k3")', 'lower.includes("kimi")');
  order('lower.includes("composer-2.5") && lower.includes("fast")', 'lower.includes("composer"))');
  order('/haiku-5[.-]5(?:$|[^0-9.])/', 'lower.includes("haiku"))');
  // GLM-5.3 Flash is a distinct cheap SKU ($0.15/$0.50 vs the flagship's
  // $1.4/$4.4); its matcher must precede the base glm-5.3 matcher (substring)
  // and glm-5.3 must precede glm-5, or flash rows bill at 6.7x.
  order('lower.includes("glm-5.3-flash")', 'lower.includes("glm-5.3")');
  order('lower.includes("glm-5.3")', 'lower.includes("glm-5")');
});

test("models promoted from LiteLLM-only coverage price identically locally and in all cloud paths (#929)", () => {
  const { getModelPricing: localPricing } = require("../src/lib/pricing");
  const cases = [
    ["gpt-6-luna", { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 }],
    ["gpt-5.5", { input: 5, output: 30, cache_read: 0.5, cache_write: 0 }],
    ["gpt-5.4", { input: 2.5, output: 15, cache_read: 0.25, cache_write: 0 }],
    ["gpt-5.4-mini", { input: 0.75, output: 4.5, cache_read: 0.075, cache_write: 0 }],
    ["gpt-5.2", { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 }],
    ["gpt-5.3-codex-spark", { input: 1.75, output: 14, cache_read: 0.175, cache_write: 0 }],
    ["claude-opus-4-5", { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 }],
    ["claude-opus-4-6", { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 }],
    ["claude-sonnet-4-6", { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }],
    ["gemini-3-flash-preview", { input: 0.5, output: 3, cache_read: 0.05, cache_write: 0 }],
    ["mimo-v2.5", { input: 0.4, output: 2, cache_read: 0.08, cache_write: 0 }],
    ["mimo-v2.5-pro", { input: 1, output: 3, cache_read: 0.2, cache_write: 0 }],
    ["muse-spark-1.2-contributor", { input: 0.1, output: 0.2, cache_read: 0.002, cache_write: 0 }],
    ["muse-spark-1.3-contributor", { input: 0.1, output: 0.2, cache_read: 0.002, cache_write: 0 }],
  ];
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const edgePricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    // Edge entries may omit cache_write; treat a missing field as 0 so the
    // comparison stays about the rates, not about key presence.
    const norm = (o) => ({
      input: o.input || 0,
      output: o.output || 0,
      cache_read: o.cache_read || 0,
      cache_write: o.cache_write || 0,
    });
    for (const [model, expected] of cases) {
      assert.deepEqual(
        norm(JSON.parse(JSON.stringify(edgePricing(model)))),
        expected,
        `${name}: ${model}`,
      );
      const local = localPricing(model);
      for (const field of ["input", "output", "cache_read", "cache_write"]) {
        assert.equal(local[field] || 0, expected[field], `local ${model}.${field}`);
      }
    }
    // The paid Muse contributor entries must not swallow their -free SKUs.
    for (const model of [
      "muse-spark-1.2-contributor-free",
      "muse-spark-1.3-contributor-free",
    ]) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(edgePricing(model))),
        { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        `${name}: ${model}`,
      );
      assert.equal(localPricing(model).input, 0, `local ${model}`);
    }
  }
});

test("GPT-5.4 Pro snapshots price at the Pro rate locally and in all cloud paths (#929)", () => {
  const { getModelPricing: localPricing } = require("../src/lib/pricing");
  const pro = { input: 30, output: 180, cache_read: 3, cache_write: 0 };
  const norm = (o) => ({
    input: o.input || 0,
    output: o.output || 0,
    cache_read: o.cache_read || 0,
    cache_write: o.cache_write || 0,
  });
  // The qualified dated snapshot is the regression shape: the curated gpt-5.4
  // contained match used to capture it at the base $2.50/$15 rate before the
  // LiteLLM reverse lookup reached the Pro SKU, while edge billed 30/180.
  const variants = ["gpt-5.4-pro", "gpt-5.4-pro-2026-03-05", "openai/gpt-5.4-pro-2026-03-05"];
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const edgePricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    for (const model of variants) {
      assert.deepEqual(
        norm(JSON.parse(JSON.stringify(edgePricing(model)))),
        pro,
        `${name}: ${model}`,
      );
      const local = localPricing(model);
      for (const field of ["input", "output", "cache_read", "cache_write"]) {
        assert.equal(local[field] || 0, pro[field], `local ${model}.${field}`);
      }
    }
    // The base SKU stays distinct from Pro.
    assert.notDeepEqual(
      JSON.parse(JSON.stringify(edgePricing("gpt-5.4"))),
      JSON.parse(JSON.stringify(edgePricing("gpt-5.4-pro"))),
      `${name}: base gpt-5.4 must not bill at the Pro rate`,
    );
    assert.equal(localPricing("gpt-5.4").input, 2.5, "local base gpt-5.4");
  }
});

test("provider-qualified Muse ids price identically locally and in all cloud paths (zero on both sides today)", () => {
  // Qualified forms (LiteLLM-style `meta/…`, `opencode_go/…`) are priced on
  // NEITHER side: the local contained match only runs on the dot-restored form
  // and the LiteLLM snapshot carries no Muse keys, while edge resolves bare
  // exact keys only. Production rows (2026-01-01 → 2026-10-31) all report the
  // bare ids, so both sides agree at zero. Pin the agreement — if a qualified
  // matcher ever lands, it must land on both sides in the same change.
  const { getModelPricingInfo } = require("../src/lib/pricing");
  const zero = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const qualified = [
    "meta/muse-spark-1.2-contributor",
    "meta/muse-spark-1.3-contributor",
    "opencode_go/muse-spark-1.2-contributor",
  ];
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const edgePricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    for (const model of qualified) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(edgePricing(model))),
        zero,
        `${name}: ${model}`,
      );
      assert.equal(getModelPricingInfo(model, { source: "muse" }).status, "unpriced", `local ${model}`);
    }
    // Qualified free ids end in -free and stay free on both sides.
    assert.deepEqual(
      JSON.parse(JSON.stringify(edgePricing("meta/muse-spark-1.2-contributor-free"))),
      zero,
      `${name}: qualified free`,
    );
    assert.equal(
      getModelPricingInfo("meta/muse-spark-1.2-contributor-free", { source: "muse" }).status,
      "free",
      "local qualified free",
    );
  }
});

test("canonical pricing block retains the complete iFlytek MaaS source table", () => {
  const block = extractBlock(CANONICAL);
  const pricingMatch = block.match(
    /const IFLYTEK_MAAS_MODEL_PRICING:[^=]+ = (\{[\s\S]*?\n\});/,
  );
  assert.ok(pricingMatch, "iFlytek MaaS 定价必须使用 Record<string, Pricing> 对象");
  const edgePricing = vm.runInNewContext(`(${pricingMatch[1]})`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(edgePricing)),
    curatedPricing.source_exact.acode,
    "Edge iFlytek MaaS 定价必须与 source_exact.acode 完全一致",
  );
  assert.equal(curatedPricing.source_alias?.acode, undefined, "定价配置不得维护 iFlytek MaaS displayName 映射");
  assert.ok(!block.includes("Array<readonly [string, string, number"), "iFlytek MaaS 定价不得使用位置型 tuple");
  assert.ok(!block.includes("MODEL_ALIASES"), "定价区块不得维护 displayName 到 service ID 的映射");
  assert.ok(!block.includes("IFLYTEK_MAAS_MODEL_NAMES"), "定价区块不得维护 displayName");
  assert.ok(!block.includes("getModelDisplayName"), "定价区块不得包含展示逻辑");
  assert.ok(block.includes('if (lower === "xsparkx2agent") return "xsparkx2";'));
  assert.ok(block.includes("return lower;"));
  assert.ok(block.includes('source.toLowerCase() === "acode"'));
  assert.ok(
    block.includes("if (iFlytekMaasPricing) return iFlytekMaasPricing;"),
    "iFlytek MaaS source misses must continue through public pricing",
  );
  assert.ok(
    !block.includes("return iFlytekMaasPricing || ZERO_PRICING;"),
    "iFlytek MaaS source misses must not return zero before public pricing",
  );
});

test("all edge pricing implementations leave unresolved AStudio routers unpriced", () => {
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const getModelPricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    for (const model of [
      "auto", "something-auto", "astronclaw-auto", "future-auto",
      "glm-5.3-auto", " AUTO ", " Something-AUTO ",
    ]) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(getModelPricing(model, "ACODE"))),
        { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        `${name}: ${model}`,
      );
    }
    for (const [model, expected] of [
      ["xsparkx2agent", curatedPricing.source_exact.acode.xsparkx2],
      ["xopglm53", curatedPricing.source_exact.acode.xopglm53],
    ]) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(getModelPricing(model, "acode"))),
        expected,
        `${name}: ${model}`,
      );
    }
    assert.deepEqual(getModelPricing("gpt-5.4", "acode"), getModelPricing("gpt-5.4"), name);
    assert.ok(getModelPricing("gpt-5.4", "acode").input > 0, name);
    assert.equal(getModelPricing("auto", "cursor").input, 1.25, name);
  }
});

test("edge APIs preserve raw model IDs without display-name conversion", () => {
  for (const name of fs.readdirSync(path.join(ROOT, EDGE_DIR)).filter((file) => file.endsWith(".ts"))) {
    const source = readEdge(name);
    assert.ok(!source.includes("IFLYTEK_MAAS_MODEL_NAMES"), `${name}: Edge 不得维护 displayName`);
    assert.ok(!source.includes("getModelDisplayName"), `${name}: Edge 不得转换 model ID`);
  }

  for (const [name, pattern] of MODEL_API_CALL_SITES) {
    assert.match(readEdge(name), pattern, `${name}: raw model ID call site missing`);
  }
});

test("all cloud cost paths avoid double-billing Acode reasoning tokens", () => {
  for (const name of [CANONICAL, ...MIRRORS]) {
    const source = readEdge(name);
    assert.match(
      source,
      /(?:row\.source|src) === "codex" \|\| (?:row\.source|src) === "acode" \|\| (?:row\.source|src) === "every-code"/,
      `${name}: Acode reasoning tokens must already be included in output`,
    );
    assert.ok(
      source.includes('if ((row.source || "").toLowerCase() === "acode") return pricing;'),
      `${name}: AStudio source prices must bypass generic DeepSeek time pricing`,
    );
  }
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
      /const SOURCES_WITH_AUTHORITATIVE_COST = new Set\(\["grok", "cline"\]\);/,
      `${name}: authoritative cost sources must be explicitly allowlisted`,
    );
    assert.match(
      source,
      /SOURCES_WITH_AUTHORITATIVE_COST\.has\((?:row\.source|src)\)[\s\S]*?Number\.isFinite\(reportedCost\)[\s\S]*?reportedCost > 0/,
      `${name}: positive reported cost must be gated by source`,
    );
  }
});

for (const name of [CANONICAL, ...MIRRORS]) {
  test(`Command Code model-table estimates agree locally and in ${name}`, () => {
    const source = readEdge(name);
    const allowlist = source.match(/const SOURCES_WITH_AUTHORITATIVE_COST = new Set\([^;]+\);/);
    assert.ok(allowlist, `${name}: cost source allowlist exists`);
    let costFunction = source.match(/\nfunction computeRowCost\([\s\S]*?\n\}/)?.[0];
    if (!costFunction) {
      assert.equal(name, "tokentracker-account-model-breakdown.ts");
      const costBlock = source.match(/    const unslothUnpriced = src === "unsloth"[\s\S]*?1_000_000;/);
      assert.ok(costBlock, "model breakdown per-row cost block exists");
      costFunction = `function computeRowCost(row) {
        const src = row.source || "unknown";
        const mdl = String(row.model || "unknown").trim() || "unknown";
        const ma = { totalCostUsd: 0 };
        ${costBlock[0]}
        return ma.totalCostUsd;
      }`;
    }
    const { code } = transformSync([
      allowlist[0], extractBlock(name), extractRowPricing(name), costFunction,
    ].join("\n"), { loader: "ts", target: "es2020" });
    const edgeCost = vm.runInNewContext(`${code}\ncomputeRowCost;`);
    const { computeRowCost: localCost } = require("../src/lib/pricing");
    for (const [model, expected] of [
      ["claude-sonnet-4-6", 0.0009675],
      ["claude-opus-5-5", 0.00117],
      ["claude-opus-5.5", 0.00117],
      ["claude-sonnet-5", 0.000645],
      ["claude-sonnet-5-5", 0.000585],
      ["k3-256k", 0.00078],
      ["glm-4.7-flash", 0],
      ["zzzz-fixture-unknown-123xyz", 0],
    ]) {
      for (const total_cost_usd of [999, 0, undefined]) {
        const row = {
          source: "command-code", model, input_tokens: 100, output_tokens: 20,
          cached_input_tokens: 600, cache_creation_input_tokens: 50, reasoning_output_tokens: 0,
          total_cost_usd,
        };
        assert.equal(edgeCost(row), expected, `${name}: ${model} ignores CLI display estimates`);
        assert.equal(localCost(row), expected, `local: ${model} matches edge pricing`);
        const omo = { ...row, source: "omo", reasoning_output_tokens: 10 };
        assert.equal(edgeCost(omo), localCost(omo), `${name}: OmO reasoning remains a subset`);
        const claude = { ...row, source: "claude", output_tokens: 10, reasoning_output_tokens: 10 };
        assert.equal(edgeCost(claude), localCost(claude), `${name}: Claude reasoning remains disjoint`);
      }
    }
  });
}

test("all cloud cost paths keep Cline :free models at zero", () => {
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const getModelPricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    for (const model of ["deepseek/deepseek-r1:free", "cline-free/deepseek-v4.1-flash", "cline-pass/glm-5.3"]) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(getModelPricing(model, "cline"))),
        { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        `${name}: ${model}`,
      );
    }
  }
});

test("all cloud cost paths keep OpenCode -free models at zero", () => {
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const getModelPricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    assert.deepEqual(
      JSON.parse(JSON.stringify(getModelPricing("deepseek-v4.1-flash-free", "opencode"))),
      { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      name,
    );
    assert.ok(getModelPricing("deepseek-v4.1-flash", "opencode").input > 0, name);
  }
});

test("Kimi K2.8 Preview aliases stay unpriced locally and in all cloud paths (#766)", () => {
  const { getModelPricing: localPricing } = require("../src/lib/pricing");
  const aliases = ["k2.8", "kimicoding", "kimi-k2.8", "kimicoding/k2.8"];
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const edgePricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    for (const model of aliases) {
      assert.equal(localPricing(model).input, 0, model);
      assert.deepEqual(
        JSON.parse(JSON.stringify(edgePricing(model))),
        { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        `${name}: ${model}`,
      );
    }
    // Sibling priced models still resolve.
    assert.ok(edgePricing("kimi-k2.5").input > 0, name);
    assert.ok(edgePricing("kimi-for-coding").input > 0, name);
  }
});

test("WorkBuddy AI auto routing stays unpriced across local and cloud paths", () => {
  const { getModelPricing: localPricing } = require("../src/lib/pricing");
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const edgePricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    for (const model of ["auto", " AUTO "]) {
      assert.equal(localPricing(model, { source: "workbuddy-ai" }).input, 0);
      assert.equal(edgePricing(model, "workbuddy-ai").input, 0, name);
    }
    assert.equal(edgePricing("gpt-6-astra", "workbuddy-ai").input, 10, name);
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

test("Kimi K3.1 Pro / Highspeed priced distinctly from kimi-k3 locally and in all cloud paths", () => {
  const { getModelPricing: localPricing } = require("../src/lib/pricing");
  const cases = [
    ["kimi-k3.1-pro", { input: 2, output: 10, cache_read: 0.2, cache_write: 2 }],
    ["k3.1pro", { input: 2, output: 10, cache_read: 0.2, cache_write: 2 }],
    ["kimi-k3.1-pro-highspeed", { input: 4, output: 20, cache_read: 0.2, cache_write: 4 }],
    ["moonshot/kimi-k3.1-pro-highspeed", { input: 4, output: 20, cache_read: 0.2, cache_write: 4 }],
  ];
  for (const name of [CANONICAL, ...MIRRORS]) {
    const { code } = transformSync(extractBlock(name), { loader: "ts", target: "es2020" });
    const edgePricing = vm.runInNewContext(`${code}\ngetModelPricing;`);
    for (const [model, rates] of cases) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(edgePricing(model))),
        rates,
        `${name}: ${model}`,
      );
      assert.equal(localPricing(model).input, rates.input, `local ${model}`);
      assert.equal(localPricing(model).output, rates.output, `local ${model}`);
    }
    assert.notDeepEqual(
      JSON.parse(JSON.stringify(edgePricing("kimi-k3.1-pro"))),
      JSON.parse(JSON.stringify(edgePricing("kimi-k3"))),
      `${name}: k3.1-pro must not inherit kimi-k3`,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(edgePricing("gemini-4-argon"))),
      { input: 2, output: 10, cache_read: 0.1, cache_write: 0 },
      `${name}: gemini-4-argon`,
    );
  }
});
