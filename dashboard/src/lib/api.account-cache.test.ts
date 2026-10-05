import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCloudUsageSummary, fetchCloudUsageDaily, fetchCloudUsageHeatmap,
  getUsageHeatmap, getUsageLimits, getUserStatus, getUsageSummary, invalidateAccountResponseCache,
} from "./api";
import { expandHeatmapCompact } from "./heatmap-compact";

vi.mock("./insforge-config", () => ({
  getInsforgeRemoteUrl: () => "https://srctyff5.us-east.insforge.app",
  getInsforgeAnonKey: () => "anon-key",
}));
vi.mock("./mock-data", () => ({ isMockEnabled: () => false }));

function jwt(sub = "one", nonce = 1, exp = Date.now() / 1000 + 3600) {
  const encode = (value: any) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256" })}.${encode({ sub, exp, nonce })}.signature`;
}
const json = (value: any, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const compact = {
  format: "compact", from: "2026-09-28", to: "2026-10-04", week_starts_on: "mon",
  active_days: 2, streak_days: 0, max_value: 100,
  model_names: ["gpt-5.4", "claude-opus-5"],
  days: [["2026-09-28", 25, [0, 10, 1, 15]], ["2026-10-01", 100, [1, 100]], ["2026-10-02", 0, []]],
};

beforeEach(() => invalidateAccountResponseCache());
afterEach(() => {
  invalidateAccountResponseCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("account response cache", () => {
  it("uses 120s for summary and 300s for chart reads, while invalidation forces a fetch", async () => {
    vi.useFakeTimers();
    let count = 0;
    const fetch = vi.fn(async () => json({ value: ++count }));
    vi.stubGlobal("fetch", fetch);
    const args = { accessToken: jwt(), from: "2026-10-01", to: "2026-10-02" };
    expect(await fetchCloudUsageSummary(args)).toEqual({ value: 1 });
    expect(await fetchCloudUsageDaily(args)).toEqual({ value: 2 });
    vi.advanceTimersByTime(60_000);
    expect(await fetchCloudUsageSummary(args)).toEqual({ value: 1 });
    expect(await fetchCloudUsageDaily(args)).toEqual({ value: 2 });
    vi.advanceTimersByTime(60_000);
    expect(await fetchCloudUsageSummary(args)).toEqual({ value: 3 });
    expect(await fetchCloudUsageDaily(args)).toEqual({ value: 2 });
    invalidateAccountResponseCache();
    expect(await fetchCloudUsageDaily(args)).toEqual({ value: 4 });
    expect(fetch).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(300_000);
    expect(await fetchCloudUsageDaily(args)).toEqual({ value: 5 });
  });

  it("validates rotated tokens before sharing the account cache and never shares users", async () => {
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => json({ value: ++count })));
    const token = jwt();
    const rotated = jwt("one", 2);
    expect(await fetchCloudUsageSummary({ accessToken: token })).toEqual({ value: 1 });
    expect(await fetchCloudUsageSummary({ accessToken: rotated })).toEqual({ value: 2 });
    expect(await fetchCloudUsageSummary({ accessToken: token })).toEqual({ value: 2 });
    expect(await fetchCloudUsageSummary({ accessToken: jwt("two") })).toEqual({ value: 3 });
  });

  it("rejects an unverified JWT with the same sub and evicts old data after 401", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ value: 1 }))
      .mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({ value: 3 }));
    vi.stubGlobal("fetch", fetch);
    const valid = jwt();
    await fetchCloudUsageSummary({ accessToken: valid });
    await expect(fetchCloudUsageSummary({ accessToken: jwt("one", 666) })).rejects.toMatchObject({ status: 401 });
    expect(await fetchCloudUsageSummary({ accessToken: valid })).toEqual({ value: 3 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not fall back to stale data for an expired JWT", async () => {
    vi.useFakeTimers();
    const token = jwt("one", 1, Date.now() / 1000 + 1);
    const fetch = vi.fn(async () => json({ value: 1 }));
    vi.stubGlobal("fetch", fetch);
    await fetchCloudUsageSummary({ accessToken: token });
    vi.advanceTimersByTime(1000);
    await expect(fetchCloudUsageSummary({ accessToken: token })).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("an old in-flight request cannot repopulate an invalidated session", async () => {
    let release!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { release = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(json({ value: 2 }));
    vi.stubGlobal("fetch", fetch);
    const args = { accessToken: jwt() };
    const old = fetchCloudUsageSummary(args);
    invalidateAccountResponseCache();
    expect(await fetchCloudUsageSummary(args)).toEqual({ value: 2 });
    release(json({ value: 1 }));
    await old;
    expect(await fetchCloudUsageSummary(args)).toEqual({ value: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("compact heatmap browser routes", () => {
  it("both cloud routes request compact and return the complete rendering schema", async () => {
    const fetch = vi.fn(async (_url: string) => json(compact));
    vi.stubGlobal("fetch", fetch);
    const args = { accessToken: jwt(), weeks: 52, to: "2026-10-04", timeZone: "UTC", device: "dev-1" };
    expect(await fetchCloudUsageHeatmap(args)).toEqual(expandHeatmapCompact(compact));
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("format")).toBe("compact");
    invalidateAccountResponseCache();
    vi.stubGlobal("window", { location: { hostname: "www.tokentracker.cc", origin: "https://www.tokentracker.cc" } });
    expect(await getUsageHeatmap(args)).toEqual(expandHeatmapCompact(compact));
    const url = new URL(fetch.mock.calls.at(-1)![0]);
    expect(url.searchParams.get("format")).toBe("compact");
    expect(url.searchParams.get("device_id")).toBe("dev-1");
    const dense = expandHeatmapCompact(compact);
    expect(dense.weeks[0][0]).toEqual({ day: "2026-09-28", total_tokens: 25, billable_total_tokens: 25, level: 1, models: { "gpt-5.4": 10, "claude-opus-5": 15 } });
    expect(dense.weeks[0][1].models).toBeNull();
    expect(dense.weeks[0][4].models).toEqual({});
    expect(dense.weeks[0][3].level).toBe(4);
  });

  it("an older edge's dense heatmap remains compatible", async () => {
    const dense = expandHeatmapCompact(compact);
    vi.stubGlobal("fetch", vi.fn(async () => json(dense)));
    expect(await fetchCloudUsageHeatmap({ accessToken: jwt(), weeks: 52 })).toEqual(dense);
  });
});


describe("local API host boundary", () => {
  it.each(["www.tokentracker.cc", "preview.example.test"])("rejects local-only reads on %s before any network request", async (hostname) => {
    vi.stubGlobal("window", { location: { hostname, origin: `https://${hostname}` } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(getUsageLimits()).rejects.toMatchObject({ status: 404, code: "LOCAL_API_UNAVAILABLE" });
    await expect(getUserStatus()).rejects.toMatchObject({ status: 404, code: "LOCAL_API_UNAVAILABLE" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps authenticated public account reads on the verified direct cloud origin", async () => {
    vi.stubGlobal("window", { location: { hostname: "www.tokentracker.cc", origin: "https://www.tokentracker.cc" } });
    const fetch = vi.fn(async (_url: string) => json({ totals: { total_tokens: 42 } }));
    vi.stubGlobal("fetch", fetch);
    const token = jwt("cloud-owner");
    expect(await getUsageSummary({ accessToken: token, from: "2026-10-01", to: "2026-10-02" })).toEqual({ totals: { total_tokens: 42 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.origin).toBe("https://srctyff5.function2.insforge.app");
    expect(url.pathname).toBe("/tokentracker-account-summary");
    expect((fetch.mock.calls[0] as any)[1]?.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it.each(["localhost", "127.0.0.1"])("preserves local reads on %s", async (hostname) => {
    vi.stubGlobal("window", { location: { hostname, origin: `http://${hostname}:7680` } });
    const fetch = vi.fn(async (_url: string) => json({ data: [], totals: { total_tokens: 42 } }));
    vi.stubGlobal("fetch", fetch);
    await getUsageLimits();
    await getUserStatus();
    await getUsageSummary({ accessToken: jwt(), from: "2026-10-01", to: "2026-10-02" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([input]) => new URL(input).origin)).toEqual(Array(3).fill(`http://${hostname}:7680`));
    expect(fetch.mock.calls.map(([input]) => new URL(input).pathname)).toEqual([
      "/functions/tokentracker-usage-limits", "/functions/tokentracker-user-status", "/functions/tokentracker-usage-summary",
    ]);
  });
});
