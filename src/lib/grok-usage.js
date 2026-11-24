"use strict";

// Grok's ACP turn_completed.usage uses camelCase fields. In that shape,
// inputTokens is the whole prompt (cache reads/writes included) and
// outputTokens includes reasoningTokens. TokenTracker stores mutually
// exclusive columns, so both reported totals need to be split before pricing.
//
// Grok's headless/CLI summaries may use snake_case fields whose input_tokens is
// already the non-cached portion. Keep the two shapes distinct instead of
// subtracting cache tokens twice.

const { amount, eventCostCoverage } = require("./cost-provenance");

const USD_TICKS_PER_USD = 10_000_000_000;

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return false;
}

function reportedCostUsd(usage, { costIsPartial, usageIsIncomplete }) {
  if (costIsPartial || usageIsIncomplete) return null;

  const ticks = amount(
    usage.costUsdTicks ??
      usage.totalCostUsdTicks ??
      usage.cost_usd_ticks ??
      usage.total_cost_usd_ticks,
  );
  if (ticks !== null) return ticks / USD_TICKS_PER_USD;

  const usd = amount(usage.costUsd ?? usage.totalCostUsd ?? usage.cost_usd ?? usage.total_cost_usd);
  return usd;
}

function normalizeGrokUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const camelCaseInput = usage.inputTokens != null;
  const reportedInput = nonNegative(usage.inputTokens ?? usage.input_tokens);
  const cachedInput = nonNegative(
    usage.cachedReadTokens ?? usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens,
  );
  const cacheCreationInput = nonNegative(
    usage.cacheCreationTokens ??
      usage.cachedWriteTokens ??
      usage.cacheWriteInputTokens ??
      usage.cache_creation_input_tokens,
  );
  const rawOutput = nonNegative(usage.outputTokens ?? usage.output_tokens);
  const reasoningOutput = nonNegative(usage.reasoningTokens ?? usage.reasoning_output_tokens);

  const inputTokens = camelCaseInput
    ? Math.max(0, reportedInput - cachedInput - cacheCreationInput)
    : reportedInput;
  const outputTokens = Math.max(0, rawOutput - reasoningOutput);

  let totalTokens = nonNegative(usage.totalTokens ?? usage.total_tokens);
  if (totalTokens <= 0) {
    totalTokens = inputTokens
      + cachedInput
      + cacheCreationInput
      + outputTokens
      + reasoningOutput;
  }
  if (totalTokens <= 0) return null;

  const costIsPartial = firstBoolean(usage.costIsPartial, usage.cost_is_partial);
  const usageIsIncomplete = firstBoolean(usage.usageIsIncomplete, usage.usage_is_incomplete);

  const result = {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInput,
    cache_creation_input_tokens: cacheCreationInput,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutput,
    total_tokens: totalTokens,
    billable_total_tokens: totalTokens,
    total_cost_usd: reportedCostUsd(usage, { costIsPartial, usageIsIncomplete }),
    cost_is_partial: costIsPartial,
    usage_is_incomplete: usageIsIncomplete,
    model_calls: nonNegative(usage.modelCalls ?? usage.model_calls),
    api_duration_ms: nonNegative(usage.apiDurationMs ?? usage.api_duration_ms),
  };
  const hasTicks = [usage.costUsdTicks, usage.totalCostUsdTicks, usage.cost_usd_ticks, usage.total_cost_usd_ticks].some((value) => amount(value) !== null);
  result.cost_coverage = eventCostCoverage(result, result.total_cost_usd, hasTicks ? "grok_ticks" : "grok_usd");
  return result;
}

module.exports = {
  USD_TICKS_PER_USD,
  normalizeGrokUsage,
  readGrokReportedCost: (usage) => reportedCostUsd(usage || {}, {
    costIsPartial: firstBoolean(usage?.costIsPartial, usage?.cost_is_partial),
    usageIsIncomplete: firstBoolean(usage?.usageIsIncomplete, usage?.usage_is_incomplete),
  }),
};
