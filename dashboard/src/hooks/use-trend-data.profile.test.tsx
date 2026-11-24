import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCloudUsageDaily, getUsageDaily, getUsageHourly, getUsageMonthly } from "../lib/api";
import { useTrendData } from "./use-trend-data";

vi.mock("../lib/api", () => ({
  fetchCloudUsageDaily: vi.fn(async () => ({ data: [] })),
  fetchCloudUsageHourly: vi.fn(async () => ({ data: [] })),
  fetchCloudUsageMonthly: vi.fn(async () => ({ data: [] })),
  getUsageDaily: vi.fn(async () => ({ data: [] })),
  getUsageHourly: vi.fn(async () => ({ data: [] })),
  getUsageMonthly: vi.fn(async () => ({ data: [] })),
}));
vi.mock("../lib/auth-token", () => ({
  isAccessTokenReady: () => true,
  resolveAuthAccessToken: async (t: any) => t || "test-token",
}));
vi.mock("../lib/mock-data", () => ({ isMockEnabled: () => false }));

const base = {
  baseUrl: "http://localhost:7680",
  timeZone: "UTC",
  now: new Date("2026-06-30T12:00:00Z"),
};

describe("useTrendData profile scope", () => {
  beforeEach(() => {
    vi.mocked(getUsageDaily).mockClear();
    vi.mocked(getUsageHourly).mockClear();
    vi.mocked(getUsageMonthly).mockClear();
    vi.mocked(fetchCloudUsageDaily).mockClear();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });

  it("forwards the profile to the daily trend (week / month)", async () => {
    renderHook(() => useTrendData({ ...base, period: "week", from: "2026-06-24", to: "2026-06-30", cacheKey: "tp1", profile: "claude@work" }));
    await waitFor(() => expect(getUsageDaily).toHaveBeenCalled());
    expect(vi.mocked(getUsageDaily).mock.calls[0][0]).toMatchObject({ profile: "claude@work" });
  });

  it("forwards the profile to the hourly trend (day)", async () => {
    renderHook(() => useTrendData({ ...base, period: "day", from: "2026-06-30", to: "2026-06-30", cacheKey: "tp2", profile: "claude@work" }));
    await waitFor(() => expect(getUsageHourly).toHaveBeenCalled());
    expect(vi.mocked(getUsageHourly).mock.calls[0][0]).toMatchObject({ profile: "claude@work" });
  });

  it("forwards the profile to the monthly trend (total)", async () => {
    renderHook(() => useTrendData({ ...base, period: "total", from: "2024-07-01", to: "2026-06-30", months: 24, cacheKey: "tp3", profile: "claude@work" }));
    await waitFor(() => expect(getUsageMonthly).toHaveBeenCalled());
    expect(vi.mocked(getUsageMonthly).mock.calls[0][0]).toMatchObject({ profile: "claude@work" });
  });

  it("sends no profile when none is chosen", async () => {
    renderHook(() => useTrendData({ ...base, period: "week", from: "2026-06-24", to: "2026-06-30", cacheKey: "tp4" }));
    await waitFor(() => expect(getUsageDaily).toHaveBeenCalled());
    expect(vi.mocked(getUsageDaily).mock.calls[0]?.[0]?.profile ?? null).toBeNull();
  });

  it("refetches when the profile changes", async () => {
    const { rerender } = renderHook(
      ({ profile }) => useTrendData({ ...base, period: "week", from: "2026-06-24", to: "2026-06-30", cacheKey: "tp5", profile }),
      { initialProps: { profile: "claude" } },
    );
    await waitFor(() => expect(getUsageDaily).toHaveBeenCalledTimes(1));
    rerender({ profile: "claude@personal" });
    await waitFor(() => expect(getUsageDaily).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getUsageDaily).mock.calls[1][0]).toMatchObject({ profile: "claude@personal" });
  });

  it("ignores the profile in the account (cloud) view", async () => {
    renderHook(() => useTrendData({
      ...base,
      baseUrl: "https://app.tokentracker.cc",
      period: "week",
      from: "2026-06-24",
      to: "2026-06-30",
      cacheKey: "tp6",
      accountView: true,
      accountAccessToken: "jwt-token",
      profile: "claude@work",
    }));
    await waitFor(() => expect(fetchCloudUsageDaily).toHaveBeenCalled());
    expect(vi.mocked(fetchCloudUsageDaily).mock.calls[0]?.[0]?.profile ?? null).toBeNull();
  });
});
