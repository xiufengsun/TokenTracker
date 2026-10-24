// Input whose aggregate is reported but whose fresh/cache split is unknown.
// This is a disjoint token column, not an estimate of uncached input.
function unclassifiedInput(row) {
  const explicit = Number(row?.unclassified_input_tokens);
  if (Number.isSafeInteger(explicit) && explicit >= 0) return explicit;
  // Heal rows emitted by the unreleased v2 VS Code parser on read.
  if (row?.usage_precision !== "input_split_unknown") return 0;
  return Math.max(0, Number(row.total_tokens || 0) - [
    "input_tokens", "cached_input_tokens", "cache_creation_input_tokens",
    "output_tokens", "reasoning_output_tokens",
  ].reduce((sum, key) => sum + Number(row[key] || 0), 0));
}

function costFields(row, knownCost) {
  return unclassifiedInput(row) > 0
    ? { total_cost_usd: null, known_cost_usd: knownCost, cost_status: "partial" }
    : { total_cost_usd: knownCost };
}

// Apply at the API boundary after aggregating the disjoint token columns.
// Keep existing complete payloads byte-for-byte compatible.
function annotateCostPayload(value) {
  if (Array.isArray(value)) return value.map(annotateCostPayload);
  if (!value || typeof value !== "object") return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, annotateCostPayload(child)]));
  if (unclassifiedInput(out) > 0 && Object.hasOwn(out, "total_cost_usd")) {
    Object.assign(out, costFields(out, out.known_cost_usd ?? out.total_cost_usd));
  }
  if (out.unclassified_input_tokens === 0) delete out.unclassified_input_tokens;
  return out;
}

module.exports = { unclassifiedInput, costFields, annotateCostPayload };
