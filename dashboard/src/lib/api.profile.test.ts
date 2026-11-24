import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCloudUsageDaily,
  getUsageDaily,
  getUsageHeatmap,
  getUsageHourly,
  getUsageMonthly,
  getUsageSummary,
  invalidateAccountResponseCache,
} from "./api";

vi.mock("./insforge-config", () => ({
  getInsforgeRemoteUrl: () => "https://edge.example.test",
  getInsforgeAnonKey: () => "anon-key",
}));
vi.mock("./auth-token", () => ({
  isValidJwtShape: () => true,
}));
vi.mock("./mock-data", () => ({
  isMockEnabled: () => false,
}));

function lastFetchUrl() {
  const calls = (globalThis.fetch as any).mock.calls;
  return new URL(calls[calls.length - 1][0], "http://localhost");
}

// Spec: the local usage endpoints take ?profile=<source> ("claude@work", or
// "claude" for the native ~/.claude). Nothing is sent when no profile is chosen.
describe("api profile filter", () => {
  beforeEach(() => {
    invalidateAccountResponseCache();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as any;
  });
  afterEach(() => vi.restoreAllMocks());

  const cases: Array<[string, () => Promise<any>, (profile?: string) => Promise<any>]> = [
    ["summary", () => getUsageSummary({ from: "2026-06-01", to: "2026-06-30", profile: "claude@work" }), (profile) => getUsageSummary({ from: "2026-06-01", to: "2026-06-30", profile })],
    ["daily", () => getUsageDaily({ from: "2026-06-01", to: "2026-06-30", profile: "claude@work" }), (profile) => getUsageDaily({ from: "2026-06-01", to: "2026-06-30", profile })],
    ["hourly", () => getUsageHourly({ day: "2026-06-01", profile: "claude@work" }), (profile) => getUsageHourly({ day: "2026-06-01", profile })],
    ["monthly", () => getUsageMonthly({ months: 3, to: "2026-06-30", profile: "claude@work" }), (profile) => getUsageMonthly({ months: 3, to: "2026-06-30", profile })],
    ["heatmap", () => getUsageHeatmap({ weeks: 4, to: "2026-06-30", profile: "claude@work" }), (profile) => getUsageHeatmap({ weeks: 4, to: "2026-06-30", profile })],
  ];

  it.each(cases)("%s sends profile as its own query parameter", async (_name, withProfile) => {
    await withProfile();
    const url = lastFetchUrl();
    expect(url.searchParams.get("profile")).toBe("claude@work");
    expect(url.searchParams.get("source")).toBeNull();
    expect(url.searchParams.get("device_id")).toBeNull();
  });

  it.each(cases)("%s sends no profile when none is chosen", async (_name, _with, without) => {
    await without(undefined);
    expect(lastFetchUrl().searchParams.has("profile")).toBe(false);
    await without("");
    expect(lastFetchUrl().searchParams.has("profile")).toBe(false);
    await without("   ");
    expect(lastFetchUrl().searchParams.has("profile")).toBe(false);
  });

  it("lowercases and trims the profile, as the server compares sources", async () => {
    await getUsageDaily({ from: "2026-06-01", to: "2026-06-30", profile: "  Claude@Work " });
    expect(lastFetchUrl().searchParams.get("profile")).toBe("claude@work");
  });

  it("keeps a profile next to a device filter", async () => {
    await getUsageDaily({ from: "2026-06-01", to: "2026-06-30", profile: "claude", device: "local:abc" });
    const url = lastFetchUrl();
    expect(url.searchParams.get("profile")).toBe("claude");
    expect(url.searchParams.get("device_id")).toBe("local:abc");
  });

  it("never sends a profile to the cloud account endpoints, which have no profiles", async () => {
    await fetchCloudUsageDaily({ from: "2026-06-01", to: "2026-06-30", accessToken: "header.payload.sig", profile: "claude@work" } as any);
    expect(lastFetchUrl().searchParams.has("profile")).toBe(false);
  });
});
