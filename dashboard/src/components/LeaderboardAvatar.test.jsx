import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LeaderboardAvatar } from "./LeaderboardAvatar.jsx";
import { LeaderboardProBadge } from "./LeaderboardProBadge.jsx";

describe("server-confirmed Cloud profile identity", () => {
  it("keeps the paid frame when a remote avatar falls back to initials", () => {
    const { container } = render(<LeaderboardAvatar avatarUrl="https://example.test/avatar.png" displayName="Dana Doe" proActive />);
    const image = container.querySelector("img");
    expect(image).toHaveClass("leaderboard-pro-avatar");
    fireEvent.error(image);
    expect(screen.getByText("DD")).toHaveClass("leaderboard-pro-avatar");
  });

  it.each([false, undefined, null, "true", 1])("does not decorate an unconfirmed paid flag %s", (proActive) => {
    const { container } = render(<><LeaderboardAvatar displayName="Free User" proActive={proActive} /><LeaderboardProBadge proActive={proActive} /></>);
    expect(container.querySelector(".leaderboard-pro-avatar")).toBeNull();
    expect(screen.queryByRole("img", { name: "TokenTracker Cloud subscriber" })).not.toBeInTheDocument();
  });

  it("explains the paid label on keyboard focus and dismisses its tooltip with Escape", async () => {
    const user = userEvent.setup();
    render(<LeaderboardProBadge proActive />);
    const marker = screen.getByRole("img", { name: "TokenTracker Cloud subscriber" });
    expect(marker).toHaveTextContent("Cloud");
    await act(async () => { await user.tab(); });
    expect(marker).toHaveFocus();
    const tooltip = await screen.findByText("Cloud member. Rankings stay based on usage.");
    expect(tooltip).toHaveTextContent("Rankings stay based on usage.");
    expect(marker).toHaveAttribute("aria-description", tooltip.textContent);
    await act(async () => { await user.keyboard("{Escape}"); });
    expect(screen.queryByText("Cloud member. Rankings stay based on usage.")).not.toBeInTheDocument();
  });
});
