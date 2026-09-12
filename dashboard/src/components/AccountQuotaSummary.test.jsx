import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AccountQuotaSummary, accountQuotaWindows } from "./AccountQuotaSummary.jsx";

describe("account quota summary", () => {
  it("shows remaining quota and the reset time from that account's response", () => {
    const reset = new Date(Date.now() + 3600000).toISOString();
    render(<AccountQuotaSummary displayMode="remaining" provider="claude" limits={{ status: "ok", five_hour: { utilization: 23, resets_at: reset } }} />);
    expect(screen.getByText("77% left")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "77");
    expect(screen.getByText(/^Resets /)).toBeInTheDocument();
  });
  it.each(["claude", "codex"])("switches %s text, bar and accessibility values together without changing warning severity", (provider) => {
    const limits = provider === "claude" ? { status: "ok", five_hour: { utilization: 93 } } : { status: "ok", primary_window: { used_percent: 93, limit_window_seconds: 18000 } };
    const { rerender } = render(<AccountQuotaSummary provider={provider} limits={limits} displayMode="used" />);
    const bar = screen.getByRole("progressbar");
    expect(screen.getByText("93% used")).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-valuenow", "93");
    expect(bar).toHaveAttribute("aria-valuetext", "93% used");
    expect(bar.firstElementChild).toHaveStyle({ width: "93%" });
    expect(bar.firstElementChild).toHaveClass("bg-red-500");
    rerender(<AccountQuotaSummary provider={provider} limits={limits} displayMode="remaining" />);
    expect(screen.getByText("7% left")).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-valuenow", "7");
    expect(bar).toHaveAttribute("aria-valuetext", "7% left");
    expect(bar.firstElementChild).toHaveStyle({ width: "7%" });
    expect(bar.firstElementChild).toHaveClass("bg-red-500");
  });

  it("does not present a reset window or unknown quota as available capacity", () => {
    render(<AccountQuotaSummary provider="claude" limits={{ status: "ok", five_hour: { utilization: 80, resets_at: new Date(Date.now() - 1000).toISOString() } }} />);
    expect(screen.getByText("Awaiting refresh")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });
  it("does not display an unknown quota as capacity", () => {
    render(<AccountQuotaSummary provider="claude" limits={{ status: "unavailable", five_hour: { utilization: 0 } }} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  it("labels Codex primary weekly windows correctly and preserves model-specific Claude limits", () => {
    expect(accountQuotaWindows("codex", { status: "ok", primary_window: { used_percent: 42, limit_window_seconds: 604800 } })[0].label).toBe("Weekly quota");
    const windows = accountQuotaWindows("claude", { status: "ok", weekly_scoped: [{ label: "Fable", utilization: 91 }] });
    expect(windows[0]).toMatchObject({ label: "Fable", used: 91 });
  });
});
