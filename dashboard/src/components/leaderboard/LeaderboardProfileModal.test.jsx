import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { copy } from "../../lib/copy";
import { ProfileContent } from "./LeaderboardProfileModal.jsx";

vi.mock("../../contexts/InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => ({ user: null }),
}));

const base = { user: { display_name: "Test user" }, heatmap: [], by_provider: [] };

describe("leaderboard profile costs", () => {
  it("shows partial total and daily cost without converting null to zero", () => {
    render(<ProfileContent data={{ ...base, totals: {
      total_tokens: 1000100, estimated_cost_usd: null, avg_per_day_usd: null,
      known_cost_usd: 0.005, cost_status: "partial",
    } }} currency="USD" rate={1} />);
    expect(screen.getAllByText(copy("usage.cost.partial"))).toHaveLength(2);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("retains a complete zero-cost profile", () => {
    render(<ProfileContent data={{ ...base, totals: {
      total_tokens: 0, estimated_cost_usd: 0, avg_per_day_usd: 0,
    } }} currency="USD" rate={1} />);
    expect(screen.getAllByText("$0.00")).toHaveLength(2);
    expect(screen.queryByText(copy("usage.cost.partial"))).not.toBeInTheDocument();
  });
});
