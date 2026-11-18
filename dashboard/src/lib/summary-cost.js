import { copy } from "./copy";
import { formatUsdCurrency } from "./format";

// Main-card presentation only. Missing coverage remains disclosed in CostAnalysisModal.
export function formatSummaryCost(totalCostUsd, { modelBreakdown, currency, rate } = {}) {
  const hasUnpricedUsage = (modelBreakdown?.sources || []).some((source) =>
    (source.models || []).some((model) =>
      model.pricing?.status === "unpriced" && model.cost_source !== "provider_reported" &&
      Number(model.totals?.total_tokens) > 0,
    ),
  );
  if (hasUnpricedUsage && Number(totalCostUsd) === 0) {
    return copy("dashboard.cost_breakdown.unpriced_label");
  }
  return formatUsdCurrency(totalCostUsd, { currency, rate });
}
