import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeaderboardMeChip } from "./LeaderboardSummaryCard.jsx";

vi.mock("./LeaderboardAvatar.jsx", () => ({
  LeaderboardAvatar: ({ displayName, proActive }) => <span data-testid="avatar" data-pro-active={proActive === true}>{displayName}</span>,
}));

function renderChip({ rank, totalEntries }) {
  return render(
    <LeaderboardMeChip
      me={{ rank, user_id: "user-1", display_name: "Me User" }}
      totalEntries={totalEntries}
      meLabel="You"
      canJump={false}
    />,
  );
}

describe("LeaderboardMeChip percentile badge", () => {
  it("shows the Top n% badge in the upper half of the board", () => {
    renderChip({ rank: 100, totalEntries: 1000 });
    expect(screen.getByText("Top 10%")).toBeInTheDocument();
  });

  it("shows the badge exactly at the 50% cutoff", () => {
    renderChip({ rank: 500, totalEntries: 1000 });
    expect(screen.getByText("Top 50%")).toBeInTheDocument();
  });

  it("hides the badge in the lower half instead of showing Top 90%", () => {
    renderChip({ rank: 900, totalEntries: 1000 });
    expect(screen.queryByText(/Top \d+%/)).not.toBeInTheDocument();
    expect(screen.getByText("#900")).toBeInTheDocument();
  });

  it("keeps the me chip's paid identity inside its existing profile action", () => {
    const onOpenProfile = vi.fn();
    const me = { rank: 2, user_id: "user-1", display_name: "Me User", pro_active: true };
    const { rerender } = render(<LeaderboardMeChip me={me} totalEntries={100} onOpenProfile={onOpenProfile} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "TokenTracker Cloud subscriber" })).toBeInTheDocument();
    expect(screen.getByTestId("avatar")).toHaveAttribute("data-pro-active", "true");
    rerender(<LeaderboardMeChip me={{ ...me, pro_active: "true" }} totalEntries={100} onOpenProfile={onOpenProfile} />);
    expect(screen.queryByRole("img", { name: "TokenTracker Cloud subscriber" })).not.toBeInTheDocument();
    expect(screen.getByTestId("avatar")).toHaveAttribute("data-pro-active", "false");
  });
});
