import React, { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThemeContext } from "../ui/foundation/ThemeProvider.jsx";
import { formatSummaryCost } from "./summary-cost";
import { copy } from "./copy";
import { UsageOverview } from "../ui/dashboard/components/UsageOverview.jsx";
import { CostAnalysisModal } from "../ui/dashboard/components/CostAnalysisModal.jsx";

const unknown = { pricing: { status: "unpriced" }, cost_source: "model_pricing", totals: { total_tokens: 100 } };
const breakdown = (model) => ({ sources: [{ models: [model] }] });
const format = (value, model = unknown) => formatSummaryCost(value, { modelBreakdown: breakdown(model), currency: "USD", rate: 1 });

describe("main-card cost presentation", () => {
  it("shows plain money for positive unpriced usage, without changing amount or replacing the glyph", () => {
    expect(format("276.060000")).toBe("$276.06");
  });
  it("keeps the unpriced-zero state rather than claiming a free total", () => {
    expect(format(0)).toBe(copy("dashboard.cost_breakdown.unpriced_label"));
  });
  it.each([
    ["free", { ...unknown, pricing: { status: "free" } }],
    ["provider reported", { ...unknown, cost_source: "provider_reported" }],
    ["zero-token", { ...unknown, totals: { total_tokens: 0 } }],
    ["legacy metadata", { totals: { total_tokens: 100 } }],
  ])("preserves %s cases", (_name, model) => {
    expect(format(0, model)).toBe("$0.00");
    expect(format(2, model)).toBe("$2.00");
  });
  it("preserves currency conversion and missing-value formatting", () => {
    expect(formatSummaryCost(2, { currency: "EUR", rate: 2 })).toBe("€4.00");
    expect(formatSummaryCost(undefined)).toBe("-");
  });
  it("keeps the real main-card info action and missing-coverage disclosure", async () => {
    const user = userEvent.setup();
    function Fixture() {
      const [open, setOpen] = useState(false);
      return <><UsageOverview periods={[]} summaryLabel="Total Tokens" summaryValue="538.7M"
        summaryCostValue={format("276.060000")} onCostInfo={() => setOpen(true)} />
        <CostAnalysisModal isOpen={open} onClose={() => setOpen(false)} fleetData={[{
          label: "CODEX", usd: 276.06, usage: 538700000,
          models: [{ name: "unknown-model", usage: 100, cost: 0,
            pricing: unknown.pricing, costSource: unknown.cost_source }],
        }]} /></>;
    }
    render(<ThemeContext.Provider value={{ resolvedTheme: "light" }}><Fixture /></ThemeContext.Provider>);
    const trigger = screen.getByRole("button", { name: copy("usage.overview.cost_breakdown_aria") });
    expect(trigger).toHaveTextContent("$276.06");
    expect(trigger).not.toHaveTextContent(/[≥≈]/);
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(copy("dashboard.cost_breakdown.known_subtotal"))).toBeVisible();
    expect(within(dialog).getByText(copy("dashboard.cost_breakdown.method"))).toBeVisible();
    expect(within(dialog).getByText("≥$276.06")).toBeVisible();
    expect(within(dialog).getByText(copy("dashboard.cost_breakdown.unpriced_label"))).toBeVisible();
  });
});
