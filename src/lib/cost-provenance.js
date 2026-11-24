"use strict";

// Local, versioned metadata. Never infer a price or currency from a model name.
const COST_TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens"];
const ORIGINS = new Set(["grok_ticks", "grok_usd", "grok_allocated", "cursor_csv_cost", "cursor_total_cents"]);
function amount(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function tokenSubset(row) {
  return Object.fromEntries(COST_TOKEN_FIELDS.map((key) => [key, Number.isFinite(Number(row?.[key])) ? Math.max(0, Number(row?.[key])) : 0]));
}
function eventCostCoverage(row, usd, origin, allocated = false) {
  const valid = amount(usd);
  const reported = valid !== null && ORIGINS.has(origin);
  return { version: 1, reported_usd: reported ? valid : 0, reported_events: reported ? 1 : 0,
    missing_events: reported ? 0 : 1, allocated_events: reported && allocated ? 1 : 0,
    origins: reported ? [origin] : [], unreported_tokens: tokenSubset(reported ? {} : row) };
}
function normalizeCostCoverage(value) {
  if (value?.version !== 1 || !Array.isArray(value.origins)) return null;
  if (![value.reported_usd, value.reported_events, value.missing_events, value.allocated_events].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return null;
  const origins = [...new Set(value.origins.filter((v) => ORIGINS.has(v)))].sort();
  if (![value.reported_events, value.missing_events, value.allocated_events].every(Number.isInteger) || value.allocated_events > value.reported_events) return null;
  if ((value.reported_events > 0 && !origins.length) || (value.reported_events === 0 && value.reported_usd !== 0)) return null;
  return { version: 1, reported_usd: value.reported_usd, reported_events: value.reported_events,
    missing_events: value.missing_events, allocated_events: value.allocated_events,
    origins,
    unreported_tokens: tokenSubset(value.unreported_tokens) };
}
function mergeCostCoverage(target, delta, sign = 1) {
  const incoming = normalizeCostCoverage(delta?.cost_coverage);
  const existing = normalizeCostCoverage(target?.cost_coverage);
  if (!incoming && !existing) return;
  const left = existing || eventCostCoverage(target, null, null);
  // An empty aggregate is not a missing event.
  if (!existing && !COST_TOKEN_FIELDS.some((key) => target[key] > 0)) left.missing_events = 0;
  const right = incoming || eventCostCoverage(delta, null, null);
  for (const key of ["reported_usd", "reported_events", "missing_events", "allocated_events"]) {
    left[key] = Math.round(Math.max(0, left[key] + sign * right[key]) * 1e10) / 1e10;
  }
  left.origins = [...new Set([...left.origins, ...right.origins])].sort();
  for (const key of COST_TOKEN_FIELDS) left.unreported_tokens[key] = Math.max(0, left.unreported_tokens[key] + sign * right.unreported_tokens[key]);
  target.cost_coverage = left;
}
module.exports = { COST_TOKEN_FIELDS, amount, eventCostCoverage, normalizeCostCoverage, mergeCostCoverage };
