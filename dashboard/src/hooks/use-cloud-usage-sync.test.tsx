import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCloudUsageSync } from "./use-cloud-usage-sync";
const state = vi.hoisted(() => ({ path: "/dashboard", lastSync: 0, enabled: true, signedIn: true, loading: false, local: true, getAccessToken: vi.fn(async () => "jwt"), sync: vi.fn(async () => {}) }));
vi.mock("react-router-dom", () => ({ useLocation: () => ({ pathname: state.path }) }));
vi.mock("../contexts/InsforgeAuthContext", () => ({ useInsforgeAuth: () => ({ enabled: true, signedIn: state.signedIn, loading: state.loading, getAccessToken: state.getAccessToken }) }));
vi.mock("../lib/cloud-sync-prefs", () => ({ getCloudSyncEnabled: () => state.enabled, getLastCloudSyncTs: () => state.lastSync, isLocalDashboardHost: () => state.local }));
vi.mock("../lib/cloud-sync", () => ({ runCloudUsageSyncIfDue: state.sync }));
beforeEach(() => {
  vi.useFakeTimers(); state.path = "/dashboard"; state.enabled = true; state.signedIn = true; state.loading = false; state.local = true;
  state.lastSync = 0; state.sync.mockReset().mockImplementation(async () => { state.lastSync = Date.now(); }); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("Cloud automatic sync timer", () => {
  it("runs once on entry and every fifteen minutes, then clears its timers on unmount", async () => {
    const { unmount } = renderHook(useCloudUsageSync);
    await act(() => vi.advanceTimersByTimeAsync(2500)); expect(state.sync).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(15 * 60_000 + 1000)); expect(state.sync).toHaveBeenCalledTimes(2);
    unmount(); await act(() => vi.advanceTimersByTimeAsync(30 * 60_000)); expect(state.sync).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("pauses for hidden pages and checks the server deadline when the page becomes visible", async () => {
    renderHook(useCloudUsageSync);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(() => vi.advanceTimersByTimeAsync(16 * 60_000)); expect(state.sync).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); expect(state.sync).toHaveBeenCalledTimes(1);
  });
  it("clears timers when disabled, restarts when enabled, and stops on sign-out", async () => {
    const { rerender } = renderHook(useCloudUsageSync);
    await act(() => vi.advanceTimersByTimeAsync(2500));
    state.enabled = false; act(() => { window.dispatchEvent(new Event("tt.cloudSyncChanged")); });
    expect(vi.getTimerCount()).toBe(0); await act(() => vi.advanceTimersByTimeAsync(30 * 60_000)); expect(state.sync).toHaveBeenCalledTimes(1);
    state.enabled = true; act(() => { window.dispatchEvent(new Event("tt.cloudSyncChanged")); });
    await act(() => vi.advanceTimersByTimeAsync(2500)); expect(state.sync).toHaveBeenCalledTimes(2);
    state.signedIn = false; rerender(); expect(vi.getTimerCount()).toBe(0);
  });
  for (const route of ["/login", "/cloud", "/billing/checkout", "/share/123"]) {
    it(`does not create a sync timer on ${route}`, async () => {
      state.path = route; renderHook(useCloudUsageSync); await act(() => vi.advanceTimersByTimeAsync(30 * 60_000));
      expect(state.sync).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });
  }
  it("remote web pages do not attempt to launch a local sync", async () => {
    state.local = false; renderHook(useCloudUsageSync); await act(() => vi.advanceTimersByTimeAsync(30 * 60_000)); expect(state.sync).not.toHaveBeenCalled();
  });
  it("schedules the returned jitter deadline without waiting for another fifteen-minute tick", async () => {
    state.sync.mockImplementation(async () => { state.lastSync = Date.now() + 30_000; });
    renderHook(useCloudUsageSync);
    await act(() => vi.advanceTimersByTimeAsync(2500)); expect(state.sync).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(15 * 60_000)); expect(state.sync).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(31_000)); expect(state.sync).toHaveBeenCalledTimes(2);
  });
  it("a failed probe without a future deadline retries after fifteen minutes", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.sync.mockRejectedValue(new Error("temporarily unavailable"));
    renderHook(useCloudUsageSync);
    await act(() => vi.advanceTimersByTimeAsync(2500)); expect(state.sync).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(60_000)); expect(state.sync).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(14 * 60_000)); expect(state.sync).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

});
