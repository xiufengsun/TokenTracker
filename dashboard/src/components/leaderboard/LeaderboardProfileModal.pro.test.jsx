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
