import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCloudUsageHeatmap, getUsageHeatmap } from "../lib/api";
import { useActivityHeatmap } from "./use-activity-heatmap";

vi.mock("../lib/api", () => ({
  fetchCloudUsageDaily: vi.fn(),
  fetchCloudUsageHeatmap: vi.fn(async () => ({ weeks: [[{ day: "2026-08-20", level: 1, total_tokens: 5 }]] })),
  getUsageDaily: vi.fn(),
  getUsageHeatmap: vi.fn(async () => ({ weeks: [[{ day: "2026-08-20", level: 1, total_tokens: 5 }]] })),
}));
vi.mock("../lib/auth-token", () => ({
  isAccessTokenReady: () => true,
  resolveAuthAccessToken: async (token: any) => token || "test-token",
}));
vi.mock("../lib/mock-data", () => ({ isMockEnabled: () => false }));

const base = {
  baseUrl: "http://localhost:7680",
  weeks: 4,
  timeZone: "UTC",
  now: new Date("2026-08-20T12:00:00Z"),
};

describe("useActivityHeatmap profile scope", () => {
  beforeEach(() => {
    vi.mocked(getUsageHeatmap).mockClear();
    vi.mocked(fetchCloudUsageHeatmap).mockClear();
    window.localStorage.clear();
  });

  it("forwards the profile to the local heatmap request", async () => {
    renderHook(() => useActivityHeatmap({ ...base, cacheKey: "hp1", profile: "claude@work" }));
    await waitFor(() => expect(getUsageHeatmap).toHaveBeenCalled());
    expect(vi.mocked(getUsageHeatmap).mock.calls[0][0]).toMatchObject({ profile: "claude@work" });
  });

  it("refetches the grid when the profile changes", async () => {
    const { rerender } = renderHook(
      ({ profile }) => useActivityHeatmap({ ...base, cacheKey: "hp2", profile }),
      { initialProps: { profile: "claude" } },
    );
    await waitFor(() => expect(getUsageHeatmap).toHaveBeenCalledTimes(1));
    rerender({ profile: "claude@personal" });
    await waitFor(() => expect(getUsageHeatmap).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getUsageHeatmap).mock.calls[1][0]).toMatchObject({ profile: "claude@personal" });
  });

  it("ignores the profile in the account (cloud) view", async () => {
    renderHook(() => useActivityHeatmap({
      ...base,
      baseUrl: "https://app.tokentracker.cc",
      cacheKey: "hp3",
      accountView: true,
      accountAccessToken: "jwt-token",
      profile: "claude@work",
    }));
    await waitFor(() => expect(fetchCloudUsageHeatmap).toHaveBeenCalled());
    expect(vi.mocked(fetchCloudUsageHeatmap).mock.calls[0]?.[0]?.profile ?? null).toBeNull();
  });

  it("caches each profile's grid separately", async () => {
    const first = renderHook(() => useActivityHeatmap({ ...base, cacheKey: "hp4", profile: "claude@work" }));
    await waitFor(() => expect(first.result.current.heatmap).not.toBeNull());
    first.unmount();
    const keys = Object.keys(window.localStorage).filter((k) => k.startsWith("tokentracker.heatmap.hp4"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("claude@work");

    const second = renderHook(() => useActivityHeatmap({ ...base, cacheKey: "hp4", profile: "claude@personal" }));
    await waitFor(() => expect(second.result.current.heatmap).not.toBeNull());
    second.unmount();
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith("tokentracker.heatmap.hp4"))).toHaveLength(2);
  });
});
