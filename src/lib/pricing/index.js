// Public pricing API. Replaces the hard-coded MODEL_PRICING table that used
// to live in src/lib/local-api.js. Keeps the same synchronous shape so all
// existing callers (computeRowCost, /functions/* handlers, tests) work
// unchanged after `await ensurePricingLoaded()` is awaited once at startup.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const curatedOverrides = require("./curated-overrides.json");
const {
  lookupPricing,
  buildLitellmPerMillionMap,
} = require("./matcher");
const { loadLitellmData } = require("./litellm-fetcher");

const ZERO_PRICING = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const PI_SUBSCRIPTION_SOURCES = new Set([
  "pi-github-copilot",
  "pi-copilot",
  "prime-agent-github-copilot",
  "prime-agent-copilot",
]);
// LM Studio's server logs describe inference served by the local developer
// server (including LM Link). Secure Cloud usage has a separate billing path
// and is not present in these logs.
const LOCAL_INFERENCE_SOURCES = new Set(["lmstudio"]);
// OpenAI long-context pricing depends on a single request's raw input,
// including cached tokens, never a session/day aggregate. Astra supports
// a larger context window; only observed request subsets receive the premium.
const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272_000;
const SOURCES_WITH_AUTHORITATIVE_COST = new Set(["grok", "cline"]);
const SEED_SNAPSHOT_PATH = path.resolve(__dirname, "seed-snapshot.json");
const DEEPSEEK_TIME_PRICED_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "deepseek-flash",
  "deepseek-v4-pro",
];
// Sync seed load. Done at require-time so callers that haven't awaited
// ensurePricingLoaded() (e.g. tests, vite mock startup, edge functions) still
// get LiteLLM-backed pricing instead of all-zero. ensurePricingLoaded() will
// later upgrade this to fresh disk cache or upstream data.
function loadSeedSync() {
  try {
    const raw = fs.readFileSync(SEED_SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    delete parsed._meta;
    return parsed;
  } catch (e) {
    return {};
  }
}

const seedRaw = loadSeedSync();

const state = {
  loaded: false,
  loadingPromise: null,
  revision: 0,
  litellmRawMap: seedRaw, // raw per-token; field shape from LiteLLM JSON
  litellmPerMillionMap: buildLitellmPerMillionMap(seedRaw), // USD/MTok
  source: Object.keys(seedRaw).length ? "seed-snapshot:sync" : null,
  // negativeCache prevents re-walking the LiteLLM map for models we've already
  // determined are unknown. Cleared on every reload.
  negativeCache: new Set(),
};

function defaultCachePath() {
  return path.join(os.homedir(), ".tokentracker", "cache", "pricing.json");
}

async function ensurePricingLoaded(opts = {}) {
  if (state.loaded) return state;
  if (state.loadingPromise) return state.loadingPromise;

  state.loadingPromise = (async () => {
    try {
      const cachePath = opts.cachePath || defaultCachePath();
      const { data, source } = await loadLitellmData({ ...opts, cachePath });
      state.litellmRawMap = data || {};
      state.litellmPerMillionMap = buildLitellmPerMillionMap(state.litellmRawMap);
      state.source = source;
      state.loaded = true;
      state.revision += 1;
      state.negativeCache.clear();
      return state;
    } finally {
      state.loadingPromise = null;
    }
  })();

  return state.loadingPromise;
}

// For tests: drop loaded state so a fresh call can re-load. Seeds with the
// bundled snapshot so getModelPricing() still works without ensurePricingLoaded.
function resetPricingForTests() {
  state.loaded = false;
  state.loadingPromise = null;
  state.litellmRawMap = seedRaw;
  state.litellmPerMillionMap = buildLitellmPerMillionMap(seedRaw);
  state.source = Object.keys(seedRaw).length ? "seed-snapshot:sync" : null;
  state.revision += 1;
  state.negativeCache.clear();
}

function getPricingRevision() {
  return state.revision;
}

function getModelPricing(model, opts = {}) {
  if (!model) return ZERO_PRICING;
  let lookupSource = null;
  if (typeof opts === "string") {
    lookupSource = opts.toLowerCase();
  } else if (typeof opts.source === "string") {
    lookupSource = opts.source.toLowerCase();
  }
  const cacheKey = lookupSource ? `${lookupSource}\0${model}` : model;
  if (state.negativeCache.has(cacheKey)) return ZERO_PRICING;

  const result = lookupPricing(model, {
    curated: curatedOverrides,
    litellm: state.litellmPerMillionMap,
    source: lookupSource,
  });
  if (result.hit) return result.value;

  state.negativeCache.add(cacheKey);
  return ZERO_PRICING;
}

function isDeepSeekTimePricedModel(model) {
  const lower = String(model || "").toLowerCase();
  return DEEPSEEK_TIME_PRICED_MODELS.some((name) => lower.includes(name));
}

// From 00:00 Beijing time on 2026-08-23 — this instant — DeepSeek bills whole
// Beijing weekends off-peak, peak hours included.
// https://api-docs.deepseek.com/quick_start/pricing/
const DEEPSEEK_WEEKEND_OFF_PEAK_FROM_MS = Date.UTC(2026, 7, 22, 16, 0, 0);

// The weekend is bounded in Beijing time, so it runs 16:00Z Friday to 16:00Z
// Sunday. Shifting the instant by +08:00 before reading the weekday is what puts
// both of those edges in the right place; getUTCDay() on the raw instant marks a
// different 48 hours. China has had no daylight saving since 1991, so the fixed
// offset is exact.
function isBeijingWeekendOffPeak(timestamp) {
  if (timestamp < DEEPSEEK_WEEKEND_OFF_PEAK_FROM_MS) return false;
  const beijingDay = new Date(timestamp + 8 * 60 * 60 * 1000).getUTCDay();
  return beijingDay === 0 || beijingDay === 6;
}

function isDeepSeekOffPeak(row) {
  if (row?.pricing_tier === "off_peak") return true;
  if (row?.pricing_tier === "peak") return false;
  const timestamp = Date.parse(String(row?.hour_start || ""));
  if (!Number.isFinite(timestamp)) return false;
  if (isBeijingWeekendOffPeak(timestamp)) return true;
  const hour = new Date(timestamp).getUTCHours();
  return !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

function getRowPricing(row) {
  const pricing = getModelPricing(row?.model, { source: row?.source });
  // AStudio uses iFlytek MaaS fixed prices and does not inherit DeepSeek public API
  // time-based discounts.
  if (String(row?.source || "").toLowerCase() === "acode") return pricing;
  if (!isDeepSeekTimePricedModel(row?.model) || !isDeepSeekOffPeak(row)) return pricing;
  return {
    ...pricing,
    input: (pricing.input || 0) * 0.5,
    output: (pricing.output || 0) * 0.5,
    cache_read: (pricing.cache_read || 0) * 0.5,
    cache_write: (pricing.cache_write || 0) * 0.5,
  };
}

// Same formula and Codex/every-code reasoning-folding rule as the previous
// computeRowCost in src/lib/local-api.js. Moved here so vite mock + local
// server share one source of truth.
function computeRowCost(row) {
  if (LOCAL_INFERENCE_SOURCES.has(String(row?.source || "").toLowerCase())) return 0;
  // Pi can route a turn through a subscription-backed Copilot provider. Pi's
  // usage record reports a zero marginal cost for those turns; do not
  // reinterpret the Claude model name as an Anthropic API bill.
  if (PI_SUBSCRIPTION_SOURCES.has(String(row?.source || "").toLowerCase())) return 0;
  // Some providers (currently Grok) persist an exact server-reported cost on
  // the usage bucket. Prefer it when positive; zero remains the legacy
  // "unreported" sentinel and falls through to model pricing.
  const reportedCost = Number(row?.total_cost_usd);
  if (
    SOURCES_WITH_AUTHORITATIVE_COST.has(row?.source) &&
    Number.isFinite(reportedCost) &&
    reportedCost > 0
  ) return reportedCost;
  const pricing = getRowPricing(row);
  // OmO, like Codex, reports reasoning as a subset of `output` (its own
  // usage.cost bills no separate reasoning component), so charging it again
  // here would double-bill every reasoning token. Cline is the same: its
  // `outputTokens` is the AI SDK total (text + reasoning), so
  // reasoning_output_tokens is a subset marker, never a second line item.
  const reasoningIncludedInOutput =
    row.source === "codex" ||
    row.source === "acode" ||
    row.source === "every-code" ||
    row.source === "omo" ||
    row.source === "cline";
  const reasoningCost = reasoningIncludedInOutput
    ? 0
    : (row.reasoning_output_tokens || 0) * (pricing.output || 0);
  const baseCost = (
    ((row.input_tokens || 0) * (pricing.input || 0) +
      (row.output_tokens || 0) * (pricing.output || 0) +
      (row.cached_input_tokens || 0) * (pricing.cache_read || 0) +
      (row.cache_creation_input_tokens || 0) * (pricing.cache_write || 0) +
      reasoningCost) /
    1_000_000
  );

  const model = String(row?.model || "").toLowerCase();
  const usesOpenAILongContextTier =
    model === "gpt-5.6" || model.includes("gpt-5.6-sol") || model.includes("gpt-6-astra") ||
    model.includes("gpt-6-sol");
  // Only models whose curated entry carries an explicit Fast/priority rate get
  // the tier premium. The other OpenAI tiers have no published priority price,
  // and inventing one is worse than reporting Standard.
  const priorityMultiplier = Number(pricing.priority_multiplier);
  const hasPriorityRates = Number.isFinite(priorityMultiplier) && priorityMultiplier > 1;
  if (!usesOpenAILongContextTier && !hasPriorityRates) return baseCost;

  const bounded = (value, total) => Math.min(
    Math.max(0, Number(value) || 0),
    Math.max(0, Number(total) || 0),
  );
  // Both premium families below read "observed subset" columns: how much of the
  // row's own token columns came from requests with a given property. They are
  // annotations, never addends — total_tokens stays the sum of the base columns
  // whether or not they are present, and a legacy row that omits them prices
  // exactly as it did before.
  //
  // The parser records only usage from requests whose cache-inclusive input
  // exceeded 272K. OpenAI prices the whole such request at 2x input and 1.5x
  // output, so add the premium over the standard-rate base exactly once.
  const longInput = bounded(row.long_context_input_tokens, row.input_tokens);
  const longCached = bounded(row.long_context_cached_input_tokens, row.cached_input_tokens);
  const longCacheWrite = bounded(
    row.long_context_cache_creation_input_tokens,
    row.cache_creation_input_tokens,
  );
  const longOutput = bounded(row.long_context_output_tokens, row.output_tokens);
  const longReasoning = reasoningIncludedInOutput
    ? 0
    : bounded(row.long_context_reasoning_output_tokens, row.reasoning_output_tokens);
  const longContextPremium = usesOpenAILongContextTier ? (
    longInput * (pricing.input || 0) +
    longCached * (pricing.cache_read || 0) +
    longCacheWrite * (pricing.cache_write || 0) +
    0.5 * longOutput * (pricing.output || 0) +
    0.5 * longReasoning * (pricing.output || 0)
  ) / 1_000_000 : 0;

  if (!hasPriorityRates) return baseCost + longContextPremium;

  // Astra Fast is a flat multiple of whichever context tier the request was on
  // (short 10/1/12.5/50 -> 20/2/25/100; long 20/2/25/75 -> 40/4/50/150), so the
  // tier multiplier and the long-context premium are orthogonal: a request that
  // is both bills at the LONG rate times the multiplier, not standard times the
  // multiplier. That needs the intersection, which is why the parser records
  // priority_long_context_* alongside priority_*; without it (queue rows, which
  // carry no context-length subset at all) the overlap is 0 and the premium
  // falls back to the short-context multiple, matching the row's own base.
  const priorityInput = bounded(row.priority_input_tokens, row.input_tokens);
  const priorityCached = bounded(row.priority_cached_input_tokens, row.cached_input_tokens);
  const priorityCacheWrite = bounded(
    row.priority_cache_creation_input_tokens,
    row.cache_creation_input_tokens,
  );
  const priorityOutput = bounded(row.priority_output_tokens, row.output_tokens);
  const priorityReasoning = reasoningIncludedInOutput
    ? 0
    : bounded(row.priority_reasoning_output_tokens, row.reasoning_output_tokens);
  const priorityBase = (
    priorityInput * (pricing.input || 0) +
    priorityCached * (pricing.cache_read || 0) +
    priorityCacheWrite * (pricing.cache_write || 0) +
    priorityOutput * (pricing.output || 0) +
    priorityReasoning * (pricing.output || 0)
  ) / 1_000_000;

  const priorityLong = usesOpenAILongContextTier ? (
    bounded(row.priority_long_context_input_tokens, Math.min(priorityInput, longInput)) *
      (pricing.input || 0) +
    bounded(row.priority_long_context_cached_input_tokens, Math.min(priorityCached, longCached)) *
      (pricing.cache_read || 0) +
    bounded(
      row.priority_long_context_cache_creation_input_tokens,
      Math.min(priorityCacheWrite, longCacheWrite),
    ) * (pricing.cache_write || 0) +
    0.5 * bounded(row.priority_long_context_output_tokens, Math.min(priorityOutput, longOutput)) *
      (pricing.output || 0) +
    0.5 * bounded(
      row.priority_long_context_reasoning_output_tokens,
      Math.min(priorityReasoning, longReasoning),
    ) * (pricing.output || 0)
  ) / 1_000_000 : 0;

  const priorityPremium = (priorityMultiplier - 1) * (priorityBase + priorityLong);
  return baseCost + longContextPremium + priorityPremium;
}

// Backwards-compatible MODEL_PRICING export. Test at
// test/model-breakdown.test.js:236 reads `localApi.MODEL_PRICING["kiro-agent"]`
// and expects { input, output, cache_read, cache_write } shape. We expose the
// CURATED.exact map (which contains the kiro entries by design); LiteLLM
// entries are NOT included here because they're keyed dynamically and the old
// table was authoritative for what is now CURATED.
const MODEL_PRICING = curatedOverrides.exact;

module.exports = {
  ensurePricingLoaded,
  getPricingRevision,
  getModelPricing,
  getRowPricing,
  computeRowCost,
  resetPricingForTests,
  MODEL_PRICING,
  ZERO_PRICING,
  OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
  // Internal hooks for tests.
  __getStateForTests: () => state,
};
