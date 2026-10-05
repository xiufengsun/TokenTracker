import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCloudUsageMonthly, getUsageDaily, getUsageHourly, getUsageMonthly } from "../lib/api";
import { useTrendData } from "./use-trend-data";

vi.mock("../lib/api", () => ({
  fetchCloudUsageDaily: vi.fn(),
  fetchCloudUsageHourly: vi.fn(),
  fetchCloudUsageMonthly: vi.fn(),
  getUsageDaily: vi.fn(),
  getUsageHourly: vi.fn(),
  getUsageMonthly: vi.fn(),
}));

vi.mock("../lib/auth-token", () => ({
  isAccessTokenReady: vi.fn(() => true),
  resolveAuthAccessToken: vi.fn(async (token) => token || "test-token"),
}));

vi.mock("../lib/mock-data", () => ({
  isMockEnabled: vi.fn(() => false),
}));

describe("useTrendData", () => {
  beforeEach(() => {
    vi.mocked(fetchCloudUsageMonthly).mockReset();
    vi.mocked(getUsageDaily).mockReset();
    vi.mocked(getUsageHourly).mockReset();
    vi.mocked(getUsageMonthly).mockReset();
    window.localStorage.clear();
  });

  function findHour(rows: any[], hour: string) {
    return rows.find((row) => row.hour === hour);
  }

  function hourlyStorageKey({
    cacheKey = "test-cache",
    scopeKey = "local",
    day = "2026-05-29",
    timeZone = "UTC",
    deviceScope = "all",
  } = {}) {
    return `tokentracker.trend.${cacheKey}.${scopeKey}.localhost:7680.hourly.${day}.tz:${timeZone}.${deviceScope}`;
  }

  it.each(["local", "cloud"])("fills monthly gaps across years for %s responses", async (scope) => {
    const fetcher = scope === "cloud" ? fetchCloudUsageMonthly : getUsageMonthly;
    vi.mocked(fetcher).mockResolvedValue({
      from: "2025-11", to: "2026-03",
      data: [{ month: "2025-12", total_tokens: 100, models: { test: 100 } },
        { month: "2026-02", total_tokens: 200 }],
    });
    const now = new Date("2026-03-01T00:00:00Z");
    const { result } = renderHook(() => useTrendData({
      period: "total", from: "2025-11-01", to: "2026-03-01",
      accessToken: "test-token", timeZone: "UTC", now,
      accountView: scope === "cloud", accountAccessToken: scope === "cloud" ? "cloud-token" : null,
    }));
    await waitFor(() => expect(result.current.rows).toHaveLength(5));
    expect(result.current.rows.map((row) => row.month)).toEqual([
      "2025-11", "2025-12", "2026-01", "2026-02", "2026-03",
    ]);
    for (const index of [0, 2, 4]) {
      expect(result.current.rows[index]).toMatchObject({
        total_tokens: 0, billable_total_tokens: 0, conversation_count: 0,
        missing: false, future: false,
      });
    }
    expect(result.current.rows[1].models).toEqual({ test: 100 });
    expect(result.current.rows[3].total_tokens).toBe(200);
  });

  it("fills an empty monthly response with zero months and preserves future estimates", async () => {
    vi.mocked(getUsageMonthly).mockResolvedValue({ from: "2025-12-01", to: "2026-02-28", data: [] });
    const now = new Date("2026-01-01T00:00:00Z");
    const { result } = renderHook(() => useTrendData({
      period: "total", accessToken: "test-token", timeZone: "UTC", now,
    }));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.rows.map((row) => row.total_tokens)).toEqual([0, 0, null]);
    expect(result.current.rows.map((row) => row.future)).toEqual([false, false, true]);
  });

  it.each(["2025-12", ""])("fills sparse monthly cache with start %s on mount and after an offline refresh", async (cachedFrom) => {
    const cacheKey = "cached-monthly";
    window.localStorage.setItem(
      `tokentracker.trend.${cacheKey}.local.localhost:7680.monthly.3.2026-02-28.tz:UTC.all`,
      JSON.stringify({ from: cachedFrom, to: "2026-02", rows: [
        { month: "2026-01", total_tokens: 100 },
        { month: "2026-02", total_tokens: null, future: true },
      ] }),
    );
    let rejectRequest: (error: Error) => void = () => {};
    vi.mocked(getUsageMonthly).mockImplementation(() => new Promise((_resolve, reject) => {
      rejectRequest = reject;
    }));
    const now = new Date("2026-02-15T00:00:00Z");
    const { result } = renderHook(() => useTrendData({
      period: "total", baseUrl: "http://localhost:7680", accessToken: "test-token",
      to: "2026-02-28", months: 3, cacheKey, timeZone: "UTC", now,
    }));
    await waitFor(() => expect(getUsageMonthly).toHaveBeenCalledTimes(1));
    expect(result.current.rows.map((row) => row.month)).toEqual(["2025-12", "2026-01", "2026-02"]);
    expect(result.current.rows.map((row) => row.total_tokens)).toEqual([0, 100, 0]);
    await act(async () => rejectRequest(new Error("offline")));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("cache");
    expect(result.current.from).toBe(cachedFrom || "2025-12-01");
    expect(result.current.rows.map((row) => row.total_tokens)).toEqual([0, 100, 0]);
  });

  it("derives the local monthly zoom start from to and months", async () => {
    vi.mocked(getUsageMonthly).mockResolvedValue({ from: "", to: "2026-02-28",
      data: [{ month: "2026-01", total_tokens: 100 }] });
    const now = new Date("2026-02-15T00:00:00Z");
    const { result } = renderHook(() => useTrendData({
      period: "total", accessToken: "test-token", to: "2026-02-28", months: 3, timeZone: "UTC", now,
    }));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.from).toBe("2025-12-01");
    expect(result.current.rows.map((row) => row.month)).toEqual(["2025-12", "2026-01", "2026-02"]);
  });

  it("treats elapsed hourly slots with no usage rows as real zero observations", async () => {
    vi.mocked(getUsageHourly).mockResolvedValue({
      day: "2026-05-29",
      data: [
        {
          hour: "2026-05-29T09:00:00",
          total_tokens: 100,
          billable_total_tokens: 100,
        },
        {
          hour: "2026-05-29T10:00:00",
          total_tokens: 200,
          billable_total_tokens: 200,
        },
      ],
    });
    const now = new Date("2026-05-29T12:15:00Z");

    const { result } = renderHook(() =>
      useTrendData({
        baseUrl: "http://localhost:7680",
        accessToken: "test-token",
        period: "day",
        from: "2026-05-29",
        to: "2026-05-29",
        timeZone: "UTC",
        now,
      }),
    );

    await waitFor(() => expect(result.current.rows).toHaveLength(24));

    const idlePastHour = findHour(result.current.rows, "2026-05-29T08:00:00");
    expect(idlePastHour).toMatchObject({
      total_tokens: 0,
      billable_total_tokens: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      conversation_count: 0,
      missing: false,
      future: false,
    });

    const futureHour = findHour(result.current.rows, "2026-05-29T13:00:00");
    expect(futureHour).toMatchObject({
      total_tokens: null,
      billable_total_tokens: null,
      input_tokens: null,
      cached_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      conversation_count: null,
      missing: false,
      future: true,
    });
  });

  it("keeps future daily buckets as estimates for week and month trends", async () => {
    vi.mocked(getUsageDaily).mockResolvedValue({
      from: "2026-05-01",
      to: "2026-05-31",
      data: [
        {
          day: "2026-05-10",
          total_tokens: 100,
          billable_total_tokens: 100,
        },
      ],
    });
    const now = new Date("2026-05-15T12:15:00Z");

    const { result } = renderHook(() =>
      useTrendData({
        baseUrl: "http://localhost:7680",
        accessToken: "test-token",
        period: "month",
        from: "2026-05-01",
        to: "2026-05-31",
        timeZone: "UTC",
        now,
      }),
    );

    await waitFor(() => expect(result.current.rows).toHaveLength(31));

    expect(result.current.rows.find((row) => row.day === "2026-05-15")).toMatchObject({
      missing: true,
      future: false,
    });
    expect(result.current.rows.find((row) => row.day === "2026-05-16")).toMatchObject({
      total_tokens: null,
      missing: false,
      future: true,
    });
  });

  it("fills elapsed half-hour slots with zero observations without touching future slots", async () => {
    vi.mocked(getUsageHourly).mockResolvedValue({
      day: "2026-05-29",
      data: [
        {
          hour: "2026-05-29T09:30:00",
          total_tokens: 100,
          billable_total_tokens: 100,
        },
      ],
    });
    const now = new Date("2026-05-29T12:15:00Z");

    const { result } = renderHook(() =>
      useTrendData({
        baseUrl: "http://localhost:7680",
        accessToken: "test-token",
        period: "day",
        from: "2026-05-29",
        to: "2026-05-29",
        timeZone: "UTC",
        now,
      }),
    );

    await waitFor(() => expect(result.current.rows).toHaveLength(48));

    expect(findHour(result.current.rows, "2026-05-29T08:30:00")).toMatchObject({
      total_tokens: 0,
      billable_total_tokens: 0,
      missing: false,
      future: false,
    });
    expect(findHour(result.current.rows, "2026-05-29T13:00:00")).toMatchObject({
      total_tokens: null,
      billable_total_tokens: null,
      missing: false,
      future: true,
    });
  });

  it("normalizes cached null gaps to zero once their hour has elapsed", async () => {
    const cacheKey = "cached-hourly";
    window.localStorage.setItem(
      hourlyStorageKey({ cacheKey }),
      JSON.stringify({
        mode: "hourly",
        from: "2026-05-29",
        to: "2026-05-29",
        fetchedAt: "2026-05-29T10:15:00.000Z",
        rows: [
          {
            hour: "2026-05-29T08:00:00",
            total_tokens: null,
            billable_total_tokens: null,
            input_tokens: null,
            cached_input_tokens: null,
            output_tokens: null,
            reasoning_output_tokens: null,
            missing: true,
            future: false,
          },
          {
            hour: "2026-05-29T13:00:00",
            total_tokens: null,
            billable_total_tokens: null,
            input_tokens: null,
            cached_input_tokens: null,
            cache_creation_input_tokens: null,
            output_tokens: null,
            reasoning_output_tokens: null,
            conversation_count: null,
            missing: false,
            future: true,
          },
        ],
      }),
    );
    vi.mocked(getUsageHourly).mockRejectedValue(new Error("offline"));
    const now = new Date("2026-05-29T14:15:00Z");

    const { result } = renderHook(() =>
      useTrendData({
        baseUrl: "http://localhost:7680",
        accessToken: "test-token",
        period: "day",
        from: "2026-05-29",
        to: "2026-05-29",
        cacheKey,
        timeZone: "UTC",
        now,
      }),
    );

    await waitFor(() => expect(result.current.source).toBe("cache"));

    expect(findHour(result.current.rows, "2026-05-29T08:00:00")).toMatchObject({
      total_tokens: 0,
      billable_total_tokens: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      conversation_count: 0,
      missing: false,
      future: false,
    });
    expect(findHour(result.current.rows, "2026-05-29T13:00:00")).toMatchObject({
      total_tokens: 0,
      billable_total_tokens: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      conversation_count: 0,
      missing: false,
      future: false,
    });
  });

  it("does not synthesize a zero observation for nonexistent DST hours", async () => {
    vi.mocked(getUsageHourly).mockResolvedValue({
      day: "2026-03-08",
      data: [
        {
          hour: "2026-03-08T01:00:00",
          total_tokens: 100,
          billable_total_tokens: 100,
        },
        {
          hour: "2026-03-08T03:00:00",
          total_tokens: 200,
          billable_total_tokens: 200,
        },
      ],
    });
    const now = new Date("2026-03-08T08:15:00Z");

    const { result } = renderHook(() =>
      useTrendData({
        baseUrl: "http://localhost:7680",
        accessToken: "test-token",
        period: "day",
        from: "2026-03-08",
        to: "2026-03-08",
        timeZone: "America/New_York",
        now,
      }),
    );

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));

    expect(findHour(result.current.rows, "2026-03-08T02:00:00")).toBeUndefined();
  });

  it("does not let a slower previous period overwrite the current trend", async () => {
    let resolveMonth: (value: any) => void = () => {};
    let resolveDay: (value: any) => void = () => {};
    vi.mocked(getUsageMonthly).mockImplementation(() =>
      new Promise((resolve) => { resolveMonth = resolve; }),
    );
    vi.mocked(getUsageHourly).mockImplementation(() =>
      new Promise((resolve) => { resolveDay = resolve; }),
    );

    const now = new Date("2026-06-30T12:15:00Z");
    const { result, rerender } = renderHook(
      ({ period, from, to }) =>
        useTrendData({
          baseUrl: "http://localhost:7680",
          accessToken: "test-token",
          period,
          from,
          to,
          timeZone: "UTC",
          now,
        }),
      { initialProps: { period: "total", from: "2024-07-01", to: "2026-06-30" } },
    );

    await waitFor(() => expect(getUsageMonthly).toHaveBeenCalledTimes(1));
    rerender({ period: "day", from: "2026-06-30", to: "2026-06-30" });
    expect(result.current.rows).toEqual([]);
    await waitFor(() => expect(getUsageHourly).toHaveBeenCalledTimes(1));

    await act(async () => resolveDay({
      day: "2026-06-30",
      data: [{ hour: "2026-06-30T12:00:00", total_tokens: 100 }],
    }));
    await waitFor(() =>
      expect(findHour(result.current.rows, "2026-06-30T12:00:00")?.total_tokens).toBe(100),
    );

    await act(async () => resolveMonth({
      from: "2024-07",
      to: "2026-06",
      data: [{ month: "2026-06", total_tokens: 9_999 }],
    }));
    expect(findHour(result.current.rows, "2026-06-30T12:00:00")?.total_tokens).toBe(100);
    expect(result.current.rows.some((row) => row.month === "2026-06")).toBe(false);
  });
});
