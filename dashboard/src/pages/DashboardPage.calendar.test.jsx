import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ empty: [], refresh: vi.fn(), view: null, requests: [] }));
vi.mock("../hooks/useLocale.js", () => ({ useLocale: () => ({ resolvedLocale: "en" }) }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal(),
  getUserStatus: vi.fn(async () => ({})),
}));
vi.mock("../hooks/use-usage-data.ts", () => ({ useUsageData: (options) => {
  state.requests.push(options);
  return { daily: state.empty, summary: null, rolling: null, refresh: state.refresh, loading: false };
} }));
vi.mock("../hooks/use-account-devices.ts", () => ({ useAccountDevices: () => ({
  devices: state.empty, accountSources: state.empty, refresh: state.refresh, loading: false,
}) }));
vi.mock("../hooks/use-project-usage-summary", () => ({ useProjectUsageSummary: () => ({ entries: state.empty, refresh: state.refresh }) }));
vi.mock("../hooks/use-usage-model-breakdown.ts", () => ({ useUsageModelBreakdown: () => ({ breakdown: state.empty, refresh: state.refresh }) }));
vi.mock("../hooks/use-trend-data.ts", () => ({ useTrendData: ({ from, to }) => ({ rows: state.empty, from, to, refresh: state.refresh }) }));
vi.mock("../hooks/use-activity-heatmap.ts", () => ({ useActivityHeatmap: () => ({ daily: state.empty, heatmap: null, refresh: state.refresh }) }));
vi.mock("../hooks/use-usage-limits.ts", () => ({ useUsageLimits: () => ({ data: null, refresh: state.refresh }) }));
vi.mock("../ui/dashboard/views/DashboardView.jsx", () => ({ DashboardView: (props) => {
  state.view = props;
  return <output data-testid="range">{props.period}:{props.usageFrom}:{props.usageTo}</output>;
} }));

import { DashboardPage } from "./DashboardPage";

describe("DashboardPage calendar rollover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 8, 23, 59, 59));
    window.history.replaceState({}, "", "/dashboard?mock=1");
    state.requests.length = 0;
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("moves the mounted default Day view and usage queries to the next local day", async () => {
    await act(async () => { render(<DashboardPage />); });
    expect(screen.getByTestId("range")).toHaveTextContent("day:2026-11-08:2026-11-08");
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId("range")).toHaveTextContent("day:2026-11-09:2026-11-09");
    const usageQuery = state.requests.filter((options) => options.includeSummary !== false).at(-1);
    expect(usageQuery).toMatchObject({ from: "2026-11-09", to: "2026-11-09" });
  });

  it("retains an explicitly selected custom range when the local day changes", async () => {
    await act(async () => { render(<DashboardPage />); });
    act(() => state.view.onCustomRangeApply("2026-10-01", "2026-10-15"));
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId("range")).toHaveTextContent("custom:2026-10-01:2026-10-15");
  });

  it("recomputes a selected calendar month when midnight starts the next month", async () => {
    vi.setSystemTime(new Date(2026, 10, 30, 23, 59, 59));
    await act(async () => { render(<DashboardPage />); });
    act(() => state.view.setSelectedPeriod("month"));
    expect(screen.getByTestId("range")).toHaveTextContent("month:2026-11-01:2026-11-30");
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId("range")).toHaveTextContent("month:2026-12-01:2026-12-31");
  });

  it("preserves a fixed mock date across midnight and focus events", async () => {
    window.history.replaceState({}, "", "/dashboard?mock=1&mock_today=2026-10-01");
    await act(async () => { render(<DashboardPage />); });
    await act(async () => {
      vi.advanceTimersByTime(1000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByTestId("range")).toHaveTextContent("day:2026-10-01:2026-10-01");
  });
});
