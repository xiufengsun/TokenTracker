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
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const slugs = ["tokentracker-leaderboard-refresh", "tokentracker-account-daily", "tokentracker-account-summary", "tokentracker-account-model-breakdown", "tokentracker-leaderboard-profile"];
const variants = model => [model, model.replace("6.2", "6-2"), model.toUpperCase(), `openai/${model}`, `openrouter/openai/${model}-high`, `${model}high`, `${model}-max`, `${model}-xhigh-fast`];
const unknown = ["gpt-6.2", "gpt-6.2-terra", "gpt-6.2-luna", "gpt-6.2-codex", "gpt-6.2-astra-pro", "openai/gpt-6.2-sol-preview", "gpt-6.2-astra-2026-11-17", "gpt-6.2-astral", "gpt-6-2-astra-pro", "openai/gpt-6-2-astra-latest", "gpt-6-2-sol-2026-11-17"];
for (const [family, rates] of Object.entries({ astra: { input: 8, output: 40, cache_read: 0.4, cache_write: 10 }, sol: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } })) {
  const model = `gpt-6.2-${family}`;
  const row = { source: "codex", model, hour_start: "2026-11-18T00:00:00Z", input_tokens: 1e6, cached_input_tokens: 1e6, cache_creation_input_tokens: 1e6, output_tokens: 1e6, reasoning_output_tokens: 500000 };
  const total = Object.values(rates).reduce((a,b) => a+b, 0);
  test(`${model}: offline aliases and stale upstream cannot select older rates`, () => {
    for (const source of ["codex", "cursor", "claude", "zed"]) for (const name of variants(model)) {
      const actual = pricing.getModelPricing(name, { source });
      for (const [k,v] of Object.entries(rates)) assert.equal(actual[k],v,`${source}/${name}/${k}`);
    }
    const stale = lookupPricing(model,{curated,litellm:{[model]:{input:999,output:999}}});
    assert.equal(stale.value.input,rates.input);
    assert.equal(pricing.getModelPricingInfo(model).status,"priced");
    close(pricing.computeRowCost(row), total);
    close(pricing.computeRowCost({...row,source:"gemini"}),total+rates.output/2);
    for(const prefix of ["cline-free/","cline-pass/"]) close(pricing.computeRowCost({...row,model:prefix+model,source:"cline"}),0);
  });
  test(`${model}: observed context, Fast and dated Ultrafast stay disjoint`, () => {
    const short={source:"codex",model,input_tokens:100000,cached_input_tokens:50000,output_tokens:10000};
    const base=.1*rates.input+.05*rates.cache_read+.01*rates.output;
    close(pricing.computeRowCost(short),base);
    close(pricing.computeRowCost({...short,priority_input_tokens:100000,priority_cached_input_tokens:50000,priority_output_tokens:10000}),base*2);
    const ultra={...short,ultrafast_input_tokens:100000,ultrafast_cached_input_tokens:50000,ultrafast_output_tokens:10000};
    for(const [hour_start,mult] of [["2027-03-01T07:59:59.999Z",3],["2027-03-01T08:00:00Z",6],["2026-11-18T00:00:00Z",3]]) {
      const r={...ultra,hour_start};close(pricing.computeRowCost(r),base*mult);
      const split=pricing.computeRowTierCosts(r);close(split.ultrafast,base*mult);close(split.standard,0);close(split.priority,0);
      assert.equal(pricing.getModelPricingInfo(model,{at:hour_start}).ultrafast_multiplier,mult);
    }
    assert.equal(curated.exact[model].ultrafast_multiplier,3,"time lookup never mutates curated data");
    const long={...ultra,long_context_input_tokens:100000,long_context_cached_input_tokens:50000,long_context_output_tokens:10000,ultrafast_long_context_input_tokens:100000,ultrafast_long_context_cached_input_tokens:50000,ultrafast_long_context_output_tokens:10000,hour_start:"2026-11-18T00:00:00Z"};
    close(pricing.computeRowCost(long),(.2*rates.input+.1*rates.cache_read+.015*rates.output)*3);
    close(pricing.computeRowCost({...long, model: model.replace("6.2", "6-2")}),pricing.computeRowCost(long));
    close(pricing.computeRowCost(row),total,"large aggregate alone is not proof of long requests");
  });
  for (const slug of slugs) test(`${slug}: ${model} standard estimate matches offline including caches/reasoning`,()=>{
    const source=fs.readFileSync(path.join(__dirname,"../dashboard/edge-patches",`${slug}.ts`),"utf8");
    const block=source.match(/const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/)[0];
    const rowPricing=source.match(/\nfunction getRowPricing\([\s\S]*?\n\}/)[0];
    const compute=source.match(/\nfunction computeRowCost\([\s\S]*?\n\}/)?.[0]||"";
    const context=vm.createContext({SOURCES_WITH_AUTHORITATIVE_COST:new Set(["grok"])});
    vm.runInContext(transformSync(`${block}\n${rowPricing}\n${compute}`,{loader:"ts",format:"cjs"}).code,context);
    for(const name of variants(model)) for(const[k,v]of Object.entries(rates))assert.equal(context.getModelPricing(name)[k],v,`${name}/${k}`);
    for(const name of unknown)assert.equal(context.getModelPricing(name).input,0,name);
    if(compute)close(context.computeRowCost(row),total);
  });
}
test("Unpublished GPT6.2 SKUs/snapshots stay unpriced instead of inheriting a family",()=>{
 for(const model of unknown)assert.equal(pricing.getModelPricingInfo(model).status,"unpriced",model);
 assert.equal(pricing.getModelPricing("gpt-6-astra").input,10);
 assert.equal(pricing.getModelPricing("gpt-6.1-sol").cache_read,.1);
});

test("Session buckets and aggregates retain usage dates across the Ultrafast cutoff", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/session-analytics.js"), "utf8");
  const helper = source.slice(source.indexOf("function sessionModelCost("), source.indexOf("function repriceSessionRecord("));
  const context = vm.createContext({ computeRowCost: pricing.computeRowCost,
    MODEL_USAGE_SUM_FIELDS: ["input_tokens", "ultrafast_input_tokens"], finite: n => Number(n) || 0 });
  vm.runInContext(helper, context);
  const row = { model: "gpt-6.2-astra", input_tokens: 100000, ultrafast_input_tokens: 100000 };
  const before = { timestamp: "2027-03-01T07:30:00Z", ...row };
  const after = { timestamp: "2027-03-01T08:00:00Z", ...row };
  close(pricing.computeRowCost({ source: "codex", ...before }), 2.4);
  close(pricing.computeRowCost({ source: "codex", ...after }), 4.8);
  close(context.sessionModelCost({source:"codex",started_at:"2026-11-18T00:00:00Z"}, row),2.4);
  close(context.sessionModelCost({source:"codex",started_at:before.timestamp,usage_buckets:[before,after]},
    {...row,input_tokens:200000,ultrafast_input_tokens:200000}),7.2);
});

test("Public Codex session scanner preserves historical Ultrafast costs after promotion expiry", async () => {
  const os = require("node:os");
  const { scanCodexSession, summarizeSessions } = require("../src/lib/session-analytics");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-gpt62-date-"));
  const file = path.join(dir, "rollout.jsonl");
  const originalNow = Date.now;
  try {
    const usage = { input_tokens: 100000, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 100000 };
    const rows = [
      { timestamp: "2026-11-18T00:00:00Z", type: "session_meta", payload: { id: "synthetic-gpt62", cwd: dir, model: "gpt-6.2-astra", model_provider: "openai" } },
      { timestamp: "2026-11-18T00:00:01Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-6.2-astra", service_tier: "ultrafast" } } },
      { timestamp: "2026-11-18T00:00:02Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
    ];
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const before = await scanCodexSession(file);
    Date.now = () => Date.parse("2027-03-02T00:00:00Z");
    const after = await scanCodexSession(file);
    close(before.cost_usd, 2.4); close(after.cost_usd, 2.4); close(after.model_usage[0].cost_usd, 2.4);
    close(summarizeSessions([after]).by_model[0].cost_usd, 2.4);
  } finally { Date.now = originalNow; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Specialist GPT6.2 Astra Law uses confirmed Standard/context rates, never general speed promotions", () => {
  for (const model of ["gpt-6.2-astra-law", "openai/gpt-6.2-astra-law", "gpt-6-2-astra-law"]) {
    const actual = pricing.getModelPricing(model);
    assert.equal(actual.input,8); assert.equal(actual.cache_read,.4); assert.equal(actual.output,40); assert.equal(actual.cache_write,10);
    assert.equal(actual.priority_multiplier,undefined);assert.equal(actual.ultrafast_multiplier,undefined);
    close(pricing.computeRowCost({source:"codex",model,input_tokens:300000,long_context_input_tokens:300000}),4.8);
  }
  for(const slug of slugs){const source=fs.readFileSync(path.join(__dirname,"../dashboard/edge-patches",`${slug}.ts`),"utf8");const block=source.match(/const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/)[0];const c=vm.createContext({});vm.runInContext(transformSync(block,{loader:"ts",format:"cjs"}).code,c);for(const model of ["gpt-6.2-astra-law","openai/gpt-6.2-astra-law","gpt-6-2-astra-law"])assert.equal(c.getModelPricing(model).input,8);}
});
