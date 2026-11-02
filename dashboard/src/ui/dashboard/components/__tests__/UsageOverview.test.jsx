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
  it("labels account-scope data on the usage card", () => {
    render(
      <UsageOverview
        period="day"
        periods={[]}
        summaryLabel="Total"
        summaryValue="0"
        fleetData={[]}
        from="2026-07-16"
        to="2026-07-16"
        accountView
      />,
    );

    expect(screen.getByText(copy("usage.overview.scope_account"))).toBeVisible();
    expect(screen.getByTitle(copy("usage.overview.scope_account_tip"))).toBeVisible();
  });

  it("keeps local-scope data unlabeled", () => {
    render(
      <UsageOverview
        period="day"
        periods={[]}
        summaryLabel="Total"
        summaryValue="0"
        fleetData={[]}
        from="2026-07-16"
        to="2026-07-16"
      />,
    );

    expect(screen.queryByText(copy("usage.overview.scope_account"))).toBeNull();
  });

  it("closes stale session details when the local import ledger changes", async () => {
    const props = { period: "month", periods: [], summaryValue: "100", from: "2026-10-01", to: "2026-10-31",
      fleetData: [{ source: "codex", label: "CODEX", usage: 100, totalPercent: "100", usd: 0,
        models: [{ id: "gpt-5.5", name: "gpt-5.5", share: 100, usage: 100, cost: 0 }] }] };
    const { rerender } = render(<UsageOverview {...props} dataRevision={0} />);
    await userEvent.click(screen.getByRole("button", { name: /CODEX/i }));
    expect(screen.getByTestId("context-breakdown")).toBeVisible();
    rerender(<UsageOverview {...props} dataRevision={1} />);
    expect(screen.queryByTestId("context-breakdown")).toBeNull();
  });
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

  it("expands a model row to reveal per-model token-type splits", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UsageOverview
        period="month"
        periods={["month"]}
        summaryLabel="Total"
        summaryValue="150"
        fleetData={[
          {
            source: "opencode",
            label: "OPENCODE",
            totalPercent: "100.00",
            usage: 150,
            usd: 1.5,
            models: [
              {
                id: "gpt-6.1-sol-fast",
                name: "gpt-6.1-sol-fast",
                share: 80,
                usage: 120,
                cost: 1.2,
                tokens: { input: 100, output: 20, cached: 0, cacheCreate: 0, reasoning: 0 },
              },
              {
                id: "plain-model",
                name: "plain-model",
                share: 20,
                usage: 30,
                cost: 0.3,
              },
            ],
          },
        ]}
        from="2026-09-01"
        to="2026-09-30"
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /All tools:/i }));
    });

    // Splits are hidden until the row itself is expanded.
    expect(screen.queryByText("Cached input")).toBeNull();

    const rowButton = screen.getByRole("button", { name: /gpt-6\.1-sol-fast/i });
    expect(rowButton).toHaveAttribute("aria-expanded", "false");
    // Expand/collapse is a chevron affordance; the word stays screen-reader-only.
    expect(rowButton.querySelector("svg.lucide-chevron-down")).not.toBeNull();
    expect(rowButton.querySelector("svg.lucide-chevron-down")).not.toHaveClass("rotate-180");
    expect(screen.getByText(copy("usage.overview.expand"))).toHaveClass("sr-only");
    expect(screen.queryByText(copy("usage.overview.collapse"))).toBeNull();

    // Rows without backend splits stay non-interactive.
    expect(screen.getByText("plain-model").parentElement.tagName).toBe("DIV");
    expect(
      screen.queryByRole("button", { name: /plain-model/i }),
    ).toBeNull();

    await act(async () => {
      await user.click(rowButton);
    });
    expect(rowButton).toHaveAttribute("aria-expanded", "true");
    expect(rowButton.querySelector("svg.lucide-chevron-down")).toHaveClass("rotate-180");
    expect(screen.getByText(copy("usage.overview.collapse"))).toHaveClass("sr-only");
    for (const label of ["Input", "Cached input", "Cache write", "Output", "Reasoning"]) {
      expect(screen.getByText(label)).toBeVisible();
    }

    await act(async () => {
      await user.click(rowButton);
    });
    expect(rowButton).toHaveAttribute("aria-expanded", "false");
    expect(rowButton.querySelector("svg.lucide-chevron-down")).not.toHaveClass("rotate-180");
    expect(container.querySelectorAll("[data-model-rank-row]")).toHaveLength(2);
    expect(screen.queryByText("Cached input")).toBeNull();
  });

  it("labels token-backed unpriced rows in the cost column instead of a blank cell", async () => {
    const user = userEvent.setup();
    const fleetData = [
      {
        source: "codex",
        label: "CODEX",
        totalPercent: "100.00",
        usage: 130,
        usd: 0.2,
        models: [
          {
            id: "gpt-6.1-terra",
            name: "gpt-6.1-terra",
            share: 60,
            usage: 80,
            cost: null,
            pricing: { status: "unpriced" },
            costSource: "curated",
          },
          {
            id: "free-model",
            name: "free-model",
            share: 15,
            usage: 20,
            cost: 0,
            pricing: { status: "free" },
            costSource: "curated",
          },
          {
            id: "legacy-model",
            name: "legacy-model",
            share: 10,
            usage: 20,
            cost: null,
          },
          {
            id: "req-only-model",
            name: "req-only-model",
            share: 0,
            usage: 0,
            requests: 5,
            cost: null,
            pricing: { status: "unpriced" },
            costSource: "curated",
          },
          {
            id: "reported-model",
            name: "reported-model",
            share: 15,
            usage: 10,
            cost: 0.2,
            pricing: { status: "unpriced" },
            costSource: "provider_reported",
          },
        ],
      },
    ];
    const { container } = render(
      <UsageOverview
        period="month"
        periods={["month"]}
        summaryLabel="Total"
        summaryValue="130"
        fleetData={fleetData}
        from="2026-11-01"
        to="2026-11-30"
      />,
    );

    const unpricedLabel = copy("dashboard.cost_breakdown.unpriced_label");

    // All-tools ranking: only the token-backed unpriced row is flagged —
    // free rows, rows without pricing metadata, request-only rows, and
    // provider-reported rows keep their cells as before.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /All tools:/i }));
    });
    expect(container.querySelectorAll("[data-model-rank-row]")).toHaveLength(5);
    const badges = screen.getAllByText(unpricedLabel);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toBeVisible();
    expect(badges[0]).toHaveAttribute("title", copy("dashboard.cost_breakdown.unpriced"));
    expect(badges[0].closest("[data-model-rank-row]")).toHaveTextContent("gpt-6.1-terra");

    // Per-provider rows read pricing straight from the fleet entry.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /CODEX:/i }));
    });
    const providerBadges = screen.getAllByText(unpricedLabel);
    expect(providerBadges).toHaveLength(1);
    expect(providerBadges[0].closest("[data-model-rank-row]")).toHaveTextContent("gpt-6.1-terra");
  });

  it("does not label a merged row whose only unpriced contributor is request-only", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UsageOverview
        period="month"
        periods={["month"]}
        summaryLabel="Total"
        summaryValue="100"
        fleetData={[
          {
            source: "codex",
            label: "CODEX",
            totalPercent: "50.00",
            usage: 100,
            usd: 0,
            models: [
              {
                id: "shared-model",
                name: "shared-model",
                share: 100,
                usage: 100,
                cost: null,
                pricing: { status: "priced" },
                costSource: "curated",
              },
            ],
          },
          {
            source: "qoder",
            label: "QODER",
            totalPercent: "0.00",
            usage: 0,
            usd: 0,
            models: [
              {
                id: "shared-model",
                name: "shared-model",
                share: 0,
                usage: 0,
                requests: 5,
                cost: null,
                pricing: { status: "unpriced" },
                costSource: "curated",
              },
            ],
          },
        ]}
        from="2026-11-01"
        to="2026-11-30"
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /All tools:/i }));
    });

    // The two contributors merge into one row: its tokens are priced and the
    // request-only side books no cost either way — no unpriced label.
    expect(container.querySelectorAll("[data-model-rank-row]")).toHaveLength(1);
    expect(container.querySelector("[data-model-rank-row]")).toHaveTextContent("shared-model");
    expect(screen.queryByText(copy("dashboard.cost_breakdown.unpriced_label"))).toBeNull();
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
        selectedDevice="local:machine-a"
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
      deviceId: "local:machine-a",
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
    expect(row).toHaveClass(
      "grid",
      "grid-cols-[minmax(0,1fr)_auto_auto_auto]",
      "sm:grid-cols-[minmax(0,1fr)_minmax(8rem,max-content)_minmax(5.5rem,max-content)_minmax(4.5rem,max-content)]",
    );
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

  it("reveals the Standard/Fast/Ultrafast speed-tier split under an expanded Codex model row", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UsageOverview
        period="month"
        periods={["month"]}
        summaryLabel="Total"
        summaryValue="300"
        fleetData={[
          {
            source: "codex",
            label: "CODEX",
            totalPercent: "100.00",
            usage: 300,
            usd: 2,
            models: [
              {
                id: "gpt-6.1-sol",
                name: "gpt-6.1-sol",
                share: 100,
                usage: 300,
                cost: 2,
                tokens: { input: 100, output: 20, cached: 170, cacheCreate: 5, reasoning: 5 },
                pricing: { priority_multiplier: 2, ultrafast_multiplier: 6 },
                tiers: {
                  priority: {
                    tokens: { input: 60, output: 10, cached: 0, cacheCreate: 0, reasoning: 0 },
                    cost: 0.7,
                  },
                  ultrafast: {
                    tokens: { input: 0, output: 4, cached: 0, cacheCreate: 0, reasoning: 0 },
                    cost: 1.2,
                  },
                },
              },
              {
                id: "plain-model",
                name: "plain-model",
                share: 0,
                usage: 0,
                cost: 0,
              },
            ],
          },
        ]}
        from="2026-10-01"
        to="2026-10-31"
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /All tools:/i }));
    });

    // Tier rows stay hidden until the model row itself is expanded.
    expect(screen.queryByText(copy("usage.overview.tier_ultrafast"))).toBeNull();
    expect(container.querySelectorAll("[data-model-speed-tiers]")).toHaveLength(0);

    const rowButton = screen.getByRole("button", { name: /gpt-6\.1-sol/i });
    await act(async () => {
      await user.click(rowButton);
    });

    // Multiplier suffix comes from the model's pricing info, never hardcoded.
    const fastLabel = copy("usage.overview.tier_rate_label", {
      label: copy("usage.overview.tier_fast"),
      rate: "2",
    });
    const ultrafastLabel = copy("usage.overview.tier_rate_label", {
      label: copy("usage.overview.tier_ultrafast"),
      rate: "6",
    });
    expect(screen.getByText(fastLabel)).toBeVisible();
    expect(screen.getByText(ultrafastLabel)).toBeVisible();
    expect(screen.getByText(copy("usage.overview.tier_standard"))).toBeVisible();
    expect(container.querySelectorAll("[data-model-speed-tiers]")).toHaveLength(1);

    await act(async () => {
      await user.click(rowButton);
    });
    expect(container.querySelectorAll("[data-model-speed-tiers]")).toHaveLength(0);
  });

  it("keeps model rows without speed-tier data free of tier rows", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UsageOverview
        period="month"
        periods={["month"]}
        summaryLabel="Total"
        summaryValue="150"
        fleetData={[
          {
            source: "opencode",
            label: "OPENCODE",
            totalPercent: "100.00",
            usage: 150,
            usd: 1.5,
            models: [
              {
                id: "gpt-6.1-sol-fast",
                name: "gpt-6.1-sol-fast",
                share: 100,
                usage: 150,
                cost: 1.5,
                tokens: { input: 100, output: 20, cached: 0, cacheCreate: 0, reasoning: 0 },
              },
            ],
          },
        ]}
        from="2026-10-01"
        to="2026-10-31"
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /All tools:/i }));
    });
    const rowButton = screen.getByRole("button", { name: /gpt-6\.1-sol-fast/i });
    await act(async () => {
      await user.click(rowButton);
    });
    // Token-type splits render, but no speed-tier block without backend tiers.
    expect(screen.getByText("Cached input")).toBeVisible();
    expect(container.querySelectorAll("[data-model-speed-tiers]")).toHaveLength(0);
    expect(screen.queryByText(copy("usage.overview.tier_standard"))).toBeNull();
  });

  it("renders Devin with its icon and shows the unpriced-models notice in provider and All views", async () => {
    const user = userEvent.setup();
    const fleetData = [
      {
        source: "devin",
        label: "DEVIN",
        totalPercent: "70.00",
        usage: 72_958,
        usd: 0,
        models: [
          { id: "swe-2-high", name: "swe-2-high", share: 80, usage: 58_366, cost: null },
          { id: "compactor", name: "compactor", share: 20, usage: 14_592, cost: null },
        ],
      },
      {
        source: "codex",
        label: "CODEX",
        totalPercent: "30.00",
        usage: 30_000,
        usd: 0.1,
        models: [{ id: "gpt-5.6", name: "gpt-5.6", share: 100, usage: 30_000, cost: 0.1 }],
      },
    ];
    const { container } = render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="102,958"
        fleetData={fleetData}
        from="2026-07-01"
        to="2026-07-31"
      />,
    );

    expect(screen.getByText("DEVIN")).toBeTruthy();
    const icon = container.querySelector('img[src="/brand-logos/devin.svg"]');
    expect(icon).toBeTruthy();
    expect(icon).toHaveClass("dark:invert");
    // Collapsed view: no notice yet.
    expect(screen.queryByText(copy("usage.overview.devin_notice_body"))).toBeNull();

    // Provider drill-down shows the notice.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /DEVIN:/i }));
    });
    expect(screen.getByText(copy("usage.overview.devin_notice_body"))).toBeTruthy();
    expect(screen.getByText("swe-2-high")).toBeTruthy();
    expect(screen.getByText("compactor")).toBeTruthy();

    // Codex view does not show Devin's notice.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /CODEX:/i }));
    });
    expect(screen.queryByText(copy("usage.overview.devin_notice_body"))).toBeNull();

    // The combined All view still warns because Devin contributes to it.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /All tools:/i }));
    });
    expect(screen.getByText(copy("usage.overview.devin_notice_body"))).toBeTruthy();
  });

  it("omits the cross-month hint when the selected week stays inside one month", () => {
    render(
      <UsageOverview
        period="week"
        periods={[]}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[]}
        from="2026-09-07"
        to="2026-09-13"
      />,
    );

    expect(screen.getByText("Sep 7 — Sep 13")).toBeTruthy();
    expect(screen.queryByText(copy("usage.overview.week_cross_month_hint"))).toBeNull();
  });

  it("omits the covered date range when the selected period is a single day", () => {
    render(
      <UsageOverview
        period="day"
        periods={[]}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[]}
        from="2026-10-13"
        to="2026-10-13"
      />,
    );

    expect(screen.queryByText("Oct 13 — Oct 13")).toBeNull();
  });

  it("still shows the covered date range for month", () => {
    render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="123"
        fleetData={[]}
        from="2026-10-01"
        to="2026-10-31"
      />,
    );

    expect(screen.getByText("Oct 1 — Oct 31")).toBeTruthy();
  });


  it("keeps the TRAE partial-cost notice visible beside combined totals in collapsed and expanded views", async () => {
    const user = userEvent.setup();
    render(
      <UsageOverview
        period="month"
        periods={[]}
        summaryLabel="Total"
        summaryValue="1,300"
        summaryCostValue="$0.03"
        fleetData={[
          {
            source: "trae",
            label: "TRAE",
            totalPercent: "80.00",
            usage: 1_000,
            usd: 0.02,
            models: [{ id: "gpt-5", name: "gpt-5", share: 100, usage: 1_000, cost: 0.02 }],
          },
          {
            source: "codex",
            label: "CODEX",
            totalPercent: "20.00",
            usage: 300,
            usd: 0.01,
            models: [{ id: "gpt-5.2", name: "gpt-5.2", share: 100, usage: 300, cost: 0.01 }],
          },
        ]}
      />,
    );
    const notice = copy("usage.overview.trae_notice_body");
    expect(screen.getByText(notice)).toBeVisible();
    for (const provider of [/TRAE:/i, /CODEX:/i, /All tools:/i]) {
      await act(async () => {
        await user.click(screen.getByRole("button", { name: provider }));
      });
      expect(screen.getByText(notice)).toBeVisible();
    }
  });

  it("does not apply the international TRAE partial-cost notice to TRAE-CN or unrelated sources", () => {
    const props = {
      period: "month",
      periods: [],
      summaryLabel: "Total",
      summaryValue: "100",
    };
    const fleet = (source) => [{
      source,
      label: source.toUpperCase(),
      totalPercent: "100.00",
      usage: 100,
      models: [{ id: "gpt-5", name: "gpt-5", share: 100, usage: 100, cost: 0.01 }],
    }];
    const { rerender } = render(<UsageOverview {...props} fleetData={fleet("trae-cn")} />);
    const showSource = (source) => {
      rerender(<UsageOverview {...props} fleetData={fleet(source)} />);
    };
    expect(screen.queryByText(copy("usage.overview.trae_notice_body"))).toBeNull();
    showSource("trae");
    expect(screen.getByText(copy("usage.overview.trae_notice_body"))).toBeVisible();
    showSource("codex");
    expect(screen.queryByText(copy("usage.overview.trae_notice_body"))).toBeNull();
  });

  it("keeps request-only providers out of the card grid and shows one notice row", () => {
    render(
      <UsageOverview
        period="day"
        periods={[]}
        summaryLabel="Total"
        summaryValue="0"
        hasSummary
        fleetData={[{
          source: "codex",
          label: "CODEX",
          totalPercent: "100.00",
          totalPercentValue: 100,
          usage: 100,
          requests: 0,
          usd: 0,
          models: [{ id: "gpt-5", name: "gpt-5", share: 100, usage: 100, requests: 0, cost: 0 }],
        }, {
          source: "qoder",
          label: "QODER",
          totalPercent: "0.00",
          totalPercentValue: 0,
          usage: 0,
          requests: 19,
          usd: 0,
          models: [{ id: "qfmodel", name: "qfmodel", share: 0, usage: 0, requests: 19, cost: null }],
        }]}
        from="2026-11-01"
        to="2026-11-01"
      />,
    );

    expect(screen.queryByRole("button", { name: /QODER/ })).toBeNull();
    const notice = screen.getByText(/Active without token data:/);
    expect(notice).toBeVisible();
    expect(notice.textContent).toContain("19 requests");
  });

  it("keeps the All card reachable when only request-only providers exist", () => {
    render(
      <UsageOverview
        period="day"
        periods={[]}
        summaryLabel="Total"
        summaryValue="0"
        hasSummary
        fleetData={[{
          source: "qoder",
          label: "QODER",
          totalPercent: "0.00",
          totalPercentValue: 0,
          usage: 0,
          requests: 19,
          usd: 0,
          models: [{ id: "qfmodel", name: "qfmodel", share: 0, usage: 0, requests: 19, cost: null }],
        }]}
        from="2026-11-01"
        to="2026-11-01"
      />,
    );

    expect(screen.getByRole("button", { name: /All tools/ })).toBeTruthy();
    expect(screen.getByText(/Active without token data:/)).toBeVisible();
  });
});
