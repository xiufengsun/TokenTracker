import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { copy } from "../../../../lib/copy";
import { UsageOverview } from "../UsageOverview.jsx";

const breakdownProps = [];

vi.mock("../ContextBreakdownPanel.jsx", () => ({
  ContextBreakdownPanel: (props) => {
    breakdownProps.push(props);
    return <div data-testid="context-breakdown">{`${props.source}:${props.from}:${props.to}`}</div>;
  },
}));

vi.mock("../../../../hooks/useTheme.js", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

describe("UsageOverview", () => {
  it("shows stable hero and provider skeletons while a new range has no matching data", () => {
    render(
      <UsageOverview
        period="day"
        periods={[]}
        summaryLabel="Total"
        summaryValue="0"
        hasSummary={false}
        summaryLoading
        providersLoading
        fleetData={[]}
        from="2026-07-16"
        to="2026-07-16"
      />,
    );

    expect(screen.getByTestId("usage-summary-skeleton")).toBeTruthy();
    expect(screen.getByTestId("usage-provider-skeleton")).toBeTruthy();
    expect(screen.getByTestId("usage-summary-skeleton").closest('[aria-busy="true"]')).toBeTruthy();
  });

  it("announces user-initiated updates while keeping existing data visible", () => {
    render(
      <UsageOverview
        period="day"
        periods={["day", "week"]}
        summaryLabel="Total"
        summaryValue="6.7M"
        hasSummary
        loading
        announceLoading
        fleetData={[
          {
            source: "codex",
            label: "CODEX",
            totalPercent: "100.0",
            usage: 6_700_000,
            usd: 3.68,
            models: [{ id: "gpt-5.6", name: "gpt-5.6", share: 100, usage: 6_700_000, cost: 3.68 }],
          },
        ]}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(copy("qpd.card.updating"));
    expect(document.querySelector("[data-counter-root]")).toHaveTextContent("6.7M");
    expect(document.querySelector("[data-counter-root]").closest('[aria-busy="true"]')).toBeTruthy();
    expect(screen.getByText("CODEX")).toBeVisible();
  });

  it("keeps background updates busy without repeatedly announcing them", () => {
    render(
      <UsageOverview
        period="day"
        periods={["day", "week"]}
        summaryLabel="Total"
        summaryValue="6.7M"
        hasSummary
        loading
        fleetData={[]}
      />,
    );

    expect(screen.getByText("6.7M").closest('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("supports roving keyboard navigation across period tabs", async () => {
    const user = userEvent.setup();
    const onPeriodChange = vi.fn();
    render(
      <UsageOverview
        period="day"
        periods={["day", "week", "month"]}
        onPeriodChange={onPeriodChange}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[]}
      />,
    );

    const dayTab = screen.getByRole("tab", { name: "Day" });
    const weekTab = screen.getByRole("tab", { name: "Week" });
    expect(dayTab).toHaveAttribute("tabindex", "0");
    expect(weekTab).toHaveAttribute("tabindex", "-1");

    dayTab.focus();
    await user.keyboard("{ArrowRight}");

    expect(weekTab).toHaveFocus();
    expect(onPeriodChange).toHaveBeenCalledWith("week");
  });

  it("defaults to an all-tools model ranking and combines matching models", async () => {
    const user = userEvent.setup();
    const fleetData = [
      {
        source: "codex",
        label: "CODEX",
        totalPercent: "60.00",
        usage: 90,
        usd: 0.9,
        models: [
          { id: "gpt-5.6", name: "GPT-5.6", share: 77.8, usage: 70, cost: 0.7 },
          { id: "gpt-5.5", name: "gpt-5.5", share: 22.2, usage: 20, cost: 0.2 },
        ],
      },
      {
        source: "cursor",
        label: "CURSOR",
        totalPercent: "40.00",
        usage: 60,
        usd: 0.6,
        models: [
          { id: "gpt-5.6", name: "gpt-5.6", share: 50, usage: 30, cost: 0.3 },
          { id: "claude", name: "claude-sonnet", share: 50, usage: 30, cost: 0.3 },
        ],
      },
    ];

    const { container, rerender } = render(
      <UsageOverview
        period="month"
        periods={["month", "total"]}
        summaryLabel="Total"
        summaryValue="150"
        fleetData={fleetData}
        from="2026-07-01"
        to="2026-07-31"
      />,
    );

    const allButton = screen.getByRole("button", { name: /All tools:/i });
    const codexButton = screen.getByRole("button", { name: /CODEX:/i });

    // Collapsed by default — drill-down is an explicit user action.
    expect(allButton).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll("[data-model-rank-row]")).toHaveLength(0);

    // Click to expand the combined ranking; click again to collapse it back.
    await act(async () => {
      await user.click(allButton);
    });
    expect(allButton).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelectorAll("[data-model-rank-row]")).toHaveLength(3);
    expect(screen.getByText("66.7%")).toBeVisible();

    await act(async () => {
      await user.click(allButton);
    });
    expect(allButton).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll("[data-model-rank-row]")).toHaveLength(0);

    // Provider cards toggle the same way.
    await act(async () => {
      await user.click(codexButton);
    });
    expect(codexButton).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelectorAll("[data-model-rank-row]")).toHaveLength(2);

    rerender(
      <UsageOverview
        period="total"
        periods={["month", "total"]}
        summaryLabel="Total"
        summaryValue="150"
        fleetData={fleetData}
        from="2025-01-01"
        to="2026-07-31"
      />,
    );
    // A scope change collapses back to the card grid.
    expect(screen.getByRole("button", { name: /All tools:/i })).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll("[data-model-rank-row]")).toHaveLength(0);
  });

  it("renders AnythingLLM with its official name, icon, and stable accent", () => {
    const { container } = render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[
          {
            source: "anythingllm",
            label: "anythingllm",
            totalPercent: "100.0",
            usage: 123,
            usd: 0,
            models: [{ id: "deepseek-v4", name: "deepseek-v4", share: 100, usage: 123, cost: 0 }],
          },
        ]}
        from="2026-07-01"
        to="2026-07-31"
      />,
    );

    expect(screen.getByText("AnythingLLM")).toBeTruthy();
    expect(container.querySelector('img[src="/brand-logos/anythingllm.svg"]')).toHaveClass(
      "brightness-0",
      "dark:brightness-100",
    );
    expect(container.querySelector('[title^="AnythingLLM:"]')).toHaveStyle({
      backgroundColor: "var(--provider-anythingllm)",
    });
  });

  it("shows a less-than label instead of zero for a tiny positive provider share", () => {
    render(
      <UsageOverview
        period="all"
        periods={[]}
        summaryLabel="Total"
        summaryValue="27.8B"
        fleetData={[
          {
            source: "grok",
            label: "GROK",
            totalPercent: "0.00",
            totalPercentValue: 0.0004,
            usage: 111_200,
            usd: 0,
            models: [{ id: "grok-code", name: "grok-code", share: 100, usage: 111_200, cost: 0 }],
          },
        ]}
        from="2025-01-01"
        to="2026-07-16"
      />,
    );

    expect(screen.getByText(`${copy("usage.overview.percent_below_threshold")}%`)).toBeTruthy();
    expect(screen.queryByText("0.00%")).toBeNull();
  });

  it("passes the overview usage range to Codex context breakdown", async () => {
    breakdownProps.length = 0;
    const user = userEvent.setup();

    render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[
          {
            source: "codex",
            label: "CODEX",
            totalPercent: "100.0",
            usage: 123,
            usd: 0,
            models: [{ id: "gpt-5.5", name: "gpt-5.5", share: 100, usage: 123, cost: 0 }],
          },
        ]}
        from="2026-05-01"
        to="2026-05-31"
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /CODEX/i }));
    });

    expect(screen.getByTestId("context-breakdown")).toHaveTextContent(
      "codex:2026-05-01:2026-05-31",
    );
    expect(breakdownProps[0]).toMatchObject({
      source: "codex",
      from: "2026-05-01",
      to: "2026-05-31",
      referenceTotalTokens: 123,
    });
  });

  it("keeps large model tokens, cost, and share in independent responsive columns", async () => {
    const user = userEvent.setup();

    render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="4.5B"
        fleetData={[
          {
            source: "claude",
            label: "CLAUDE",
            totalPercent: "100.0",
            usage: 4_495_005_277,
            usd: 8_207.43,
            models: [
              {
                id: "claude-fable-5",
                name: "claude-fable-5",
                share: 34.1,
                usage: 1_544_980_998,
                cost: 8_207.43,
              },
            ],
          },
        ]}
        from="2026-07-01"
        to="2026-07-31"
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /CLAUDE/i }));
    });

    const row = screen.getByText("claude-fable-5").parentElement;
    expect(row).toHaveClass("grid", "grid-cols-[minmax(0,1fr)_minmax(8rem,max-content)_minmax(5.5rem,max-content)_4rem]");
    expect(row.children[1]).toHaveClass("whitespace-nowrap");
    expect(row.children[2]).toHaveClass("whitespace-nowrap");
  });

  it("toggles the summary number format when the hero total is clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();

    render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="1.23B"
        summaryFullValue="1,234,567,890"
        onToggleSummaryFormat={onToggle}
        fleetData={[]}
        from="2026-05-01"
        to="2026-05-31"
      />,
    );

    const toggle = screen.getByRole("button", { name: /toggle compact number format/i });
    expect(toggle).toHaveAttribute("title", "1,234,567,890");
    // The compact value renders intact (incl. its unit-letter suffix), not
    // truncated.
    expect(toggle).toHaveTextContent("1.23B");

    await act(async () => {
      await user.click(toggle);
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders the hero total as plain text when no toggle handler is provided", () => {
    render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="1.23B"
        summaryFullValue="1,234,567,890"
        fleetData={[]}
        from="2026-05-01"
        to="2026-05-31"
      />,
    );

    expect(
      screen.queryByRole("button", { name: /toggle compact number format/i }),
    ).toBeNull();
    expect(screen.getByTitle("1,234,567,890")).toHaveTextContent("1.23B");
  });

  it("shows the covered date range and flags a week that spans two calendar months", () => {
    render(
      <UsageOverview
        period="week"
        periods={[]}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[]}
        from="2026-08-31"
        to="2026-09-06"
      />,
    );

    expect(screen.getByText("Aug 31 — Sep 6")).toBeTruthy();
    expect(screen.getByText(copy("usage.overview.week_cross_month_hint"))).toBeTruthy();
  });

  it("omits the cross-month hint when the selected week stays inside one month", () => {
    render(
      <UsageOverview
        period="week"
        periods={[]}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[]}
        from="2026-09-01"
        to="2026-09-07"
      />,
    );

    expect(screen.getByText("Sep 1 — Sep 7")).toBeTruthy();
    expect(screen.queryByText(copy("usage.overview.week_cross_month_hint"))).toBeNull();
  });
});
