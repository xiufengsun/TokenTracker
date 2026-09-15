import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { copy } from "../../../lib/copy";
import { QualityPerDollarCard } from "./QualityPerDollarCard.jsx";

vi.mock("../../../hooks/use-quality-per-dollar-pref.js", () => ({
  useQualityPerDollarPref: () => ({ enabled: true }),
}));

vi.mock("../../../hooks/use-quality-per-dollar", () => ({
  useQualityPerDollar: () => ({
    loading: false,
    data: {
      available: true,
      by_model: [{
        key: "gpt-6-astra",
        cost_usd: null,
        known_cost_usd: 0.005,
        cost_status: "partial",
        accepted: 1,
        outcomes: 1,
        acceptance_rate: 1,
        quality_per_dollar: null,
      }],
      totals: {
        cost_usd: null,
        known_cost_usd: 0.005,
        cost_status: "partial",
        accepted: 1,
        outcomes: 1,
        acceptance_rate: 1,
        effective_tokens: 1_000_100,
      },
    },
  }),
}));

vi.mock("../../../hooks/useTokenFormat.js", () => ({
  useTokenFormat: () => ({
    formatTokens: (value) => String(value),
    formatTokensTooltip: (value) => String(value),
  }),
}));

describe("QualityPerDollarCard partial costs", () => {
  it("labels partial spend and never renders it as zero", () => {
    render(<QualityPerDollarCard from="2026-09-01" to="2026-09-30" />);
    const partialLabel = copy("usage.cost.partial");
    expect(screen.getAllByText((content) => content.includes(partialLabel))).toHaveLength(3);
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  });
});
