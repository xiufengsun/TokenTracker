import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ProfileContent } from "./LeaderboardProfileModal.jsx";

vi.mock("../../contexts/InsforgeAuthContext.jsx", () => ({ useInsforgeAuth: () => ({ signedIn: true, user: { id: "another-user" } }) }));
vi.mock("../../ui/dashboard/components/LikeButton.jsx", () => ({ LikeButton: () => null }));
vi.mock("../../ui/dashboard/components/TrendMonitorZoomModal", () => ({ TrendMonitorZoomModal: () => null }));

const profile = {
  user: { user_id: "profile-user", display_name: "Dana Doe", github_url: "https://github.com/dana", rank: 2 },
  totals: {}, streak: {}, models: {}, by_provider: [], heatmap: [], badges: [], period: {},
};

describe("Pro identity in shared public profile content", () => {
  it("shows expandable per-model token types supplied by the public profile endpoint", () => {
    const { container } = render(<MemoryRouter><ProfileContent data={{ ...profile, models: { breakdown: [{
      model_name: "claude-opus-5-5", total_tokens: 150, estimated_cost_usd: .01,
      input_tokens: 10, output_tokens: 20, cached_input_tokens: 100, cache_creation_input_tokens: 15, reasoning_output_tokens: 5,
    }] } }} currency="USD" rate={1} /></MemoryRouter>);
    expect(screen.getByText("claude-opus-5-5")).toBeInTheDocument();
    const detail = container.querySelector("details");
    expect(detail).not.toHaveAttribute("open");
    expect(detail.querySelectorAll("dt")).toHaveLength(5);
    expect([...detail.querySelectorAll("dd")].map((item) => item.getAttribute("title"))).toEqual(["10", "100", "15", "20", "5"]);
  });
  it.each(["modal", "page"])("uses only the target server flag in the %s profile", (variant) => {
    const { container, rerender } = render(<MemoryRouter><ProfileContent data={{ ...profile, user: { ...profile.user, pro_active: true } }} currency="USD" rate={1} variant={variant} /></MemoryRouter>);
    expect(screen.getByRole("img", { name: "TokenTracker Cloud subscriber" })).toBeInTheDocument();
    expect(container.querySelector(".leaderboard-pro-avatar")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Dana Doe" })).toBeInTheDocument();
    rerender(<MemoryRouter><ProfileContent data={profile} currency="USD" rate={1} variant={variant} /></MemoryRouter>);
    expect(screen.queryByRole("img", { name: "TokenTracker Cloud subscriber" })).not.toBeInTheDocument();
    expect(container.querySelector(".leaderboard-pro-avatar")).toBeNull();
  });
});
