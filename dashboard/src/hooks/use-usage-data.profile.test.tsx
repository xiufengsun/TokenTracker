import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCloudUsageDaily, getUsageDaily, getUsageSummary } from "../lib/api";
import { useUsageData } from "./use-usage-data";

vi.mock("../lib/api", () => ({
  fetchCloudUsageDaily: vi.fn(async () => ({ data: [] })),
  fetchCloudUsageSummary: vi.fn(async () => ({ totals: { total_tokens: 0 }, rolling: null })),
  getUsageDaily: vi.fn(async () => ({ data: [] })),
  getUsageSummary: vi.fn(async () => ({ totals: { total_tokens: 0 } })),
}));
vi.mock("../lib/auth-token", () => ({
  isAccessTokenReady: () => true,
  resolveAuthAccessToken: async (t: any) => t || "test-token",
}));
vi.mock("../lib/mock-data", () => ({ isMockEnabled: () => false }));

const base = {
  baseUrl: "http://localhost:7680",
  from: "2026-06-01",
  to: "2026-06-30",
  includeDaily: true,
  timeZone: "UTC",
};

// Spec: choosing a profile narrows the local summary and daily rows to it, and
// data fetched for one profile is never shown under another.
describe("useUsageData profile scope", () => {
  beforeEach(() => {
    vi.mocked(getUsageDaily).mockClear();
    vi.mocked(getUsageSummary).mockClear();
    vi.mocked(fetchCloudUsageDaily).mockClear();
    try { window.localStorage.clear(); } catch { /* ignore */ }
  });

  it("forwards the profile to the local daily and summary requests", async () => {
    renderHook(() => useUsageData({ ...base, cacheKey: "p1", profile: "claude@work" }));
    await waitFor(() => expect(getUsageDaily).toHaveBeenCalled());
    await waitFor(() => expect(getUsageSummary).toHaveBeenCalled());
    expect(vi.mocked(getUsageDaily).mock.calls[0][0]).toMatchObject({ profile: "claude@work" });
    expect(vi.mocked(getUsageSummary).mock.calls[0][0]).toMatchObject({ profile: "claude@work" });
  });

  it("sends no profile when none is chosen", async () => {
    renderHook(() => useUsageData({ ...base, cacheKey: "p2" }));
    await waitFor(() => expect(getUsageDaily).toHaveBeenCalled());
    expect(vi.mocked(getUsageDaily).mock.calls[0]?.[0]?.profile ?? null).toBeNull();
  });

  it("refetches when the profile changes", async () => {
    const { rerender } = renderHook(
      ({ profile }) => useUsageData({ ...base, cacheKey: "p3", profile }),
      { initialProps: { profile: "claude" } },
    );
    await waitFor(() => expect(getUsageDaily).toHaveBeenCalledTimes(1));
    rerender({ profile: "claude@work" });
    await waitFor(() => expect(getUsageDaily).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getUsageDaily).mock.calls[1][0]).toMatchObject({ profile: "claude@work" });
  });

  it("ignores the profile in the account (cloud) view, which has no profiles", async () => {
    renderHook(() => useUsageData({
      ...base,
      baseUrl: "https://app.tokentracker.cc",
      cacheKey: "p4",
      accountView: true,
      accountAccessToken: "jwt-token",
      profile: "claude@work",
    }));
    await waitFor(() => expect(fetchCloudUsageDaily).toHaveBeenCalled());
    expect(vi.mocked(fetchCloudUsageDaily).mock.calls[0]?.[0]?.profile ?? null).toBeNull();
    expect(getUsageDaily).not.toHaveBeenCalled();
  });

  it("keeps one profile's cached totals out of another profile's view", async () => {
    vi.mocked(getUsageSummary).mockResolvedValueOnce({ totals: { total_tokens: 300 } } as any);
    const first = renderHook(() => useUsageData({ ...base, cacheKey: "p5", profile: "claude@work" }));
    await waitFor(() => expect(first.result.current.summary?.total_tokens).toBe(300));
    first.unmount();

    vi.mocked(getUsageDaily).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(getUsageSummary).mockRejectedValueOnce(new Error("offline"));
    const other = renderHook(() => useUsageData({ ...base, cacheKey: "p5", profile: "claude@personal" }));
    await waitFor(() => expect(other.result.current.loading).toBe(false));
    expect(other.result.current.summary?.total_tokens ?? null).not.toBe(300);

    vi.mocked(getUsageDaily).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(getUsageSummary).mockRejectedValueOnce(new Error("offline"));
    const again = renderHook(() => useUsageData({ ...base, cacheKey: "p5", profile: "claude@work" }));
    await waitFor(() => expect(again.result.current.summary?.total_tokens).toBe(300));
  });
});
