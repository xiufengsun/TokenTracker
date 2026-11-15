import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderResetsCache, useProviderResets } from "./use-provider-resets.js";

describe("provider reset timeout fallback", () => {
  const originalTimeout = AbortSignal.timeout;
  beforeEach(() => {
    resetProviderResetsCache();
    vi.useFakeTimers();
    delete AbortSignal.timeout;
  });
  afterEach(() => {
    cleanup();
    AbortSignal.timeout = originalTimeout;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("aborts a hanging request after 15 seconds without AbortSignal.timeout", async () => {
    let signal;
    vi.stubGlobal("fetch", vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }));
    const { result, unmount } = renderHook(() => useProviderResets({ enabled: true }));
    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(signal.aborted).toBe(false);
    expect(result.current.loading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(signal.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error.name).toBe("TimeoutError");
    expect(vi.getTimerCount()).toBe(1); // Bounded retry, not the abort timer.
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("clears the fallback timer when fetch settles (ok=%s)", async (ok) => {
    let signal;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      signal = options.signal;
      return { ok, status: 503, json: async () => ({ providers: {} }) };
    }));
    const { result, unmount } = renderHook(() => useProviderResets({ enabled: true }));
    await act(async () => {});
    expect(result.current.loading).toBe(false);
    expect(Boolean(result.current.error)).toBe(!ok);
    expect(vi.getTimerCount()).toBe(1); // Revalidation timer remains enabled.
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(signal.aborted).toBe(false);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe("provider reset cache freshness", () => {
  const ttl = 30 * 60 * 1000;
  const originalTimeout = AbortSignal.timeout;
  const response = (id) => ({ ok: true, json: async () => ({ providers: {
    claude: { events: [{ id, kind: "reset", date: "2026-11-01T00:00:00Z" }] },
  } }) }); // Synthetic API fixtures, never live announcements.
  beforeEach(() => {
    resetProviderResetsCache();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    delete AbortSignal.timeout;
  });
  afterEach(() => {
    cleanup();
    AbortSignal.timeout = originalTimeout;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("revalidates on expiry without disabling or remounting", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response("old")).mockResolvedValue(response("new"));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProviderResets({ enabled: true }));
    await act(async () => {});
    expect(result.current.data.claude[0].id).toBe("old");
    await act(async () => vi.advanceTimersByTimeAsync(ttl - 1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.data.claude[0].id).toBe("new");
    await act(async () => vi.advanceTimersByTimeAsync(ttl));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses the original cache expiry after a cached remount", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("fixture"));
    vi.stubGlobal("fetch", fetchMock);
    const first = renderHook(() => useProviderResets({ enabled: true }));
    await act(async () => {});
    first.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(ttl - 60_000));
    renderHook(() => useProviderResets({ enabled: true }));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not poll disabled or unmounted consumers and refreshes when re-enabled stale", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("fixture"));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender, unmount } = renderHook(({ enabled }) => useProviderResets({ enabled }), { initialProps: { enabled: false } });
    await act(async () => vi.advanceTimersByTimeAsync(ttl * 2));
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(ttl * 2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ enabled: true });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(ttl * 2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares requests between enabled consumers at expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response("old")).mockResolvedValue(response("new"));
    vi.stubGlobal("fetch", fetchMock);
    const first = renderHook(() => useProviderResets({ enabled: true }));
    const second = renderHook(() => useProviderResets({ enabled: true }));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(ttl));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.result.current.data.claude[0].id).toBe("new");
    expect(second.result.current.data.claude[0].id).toBe("new");
  });

  it("retains stale data with an error and retries at bounded cadence instead of spinning", async () => {
    const failure = new Error("fixture offline");
    const fetchMock = vi.fn().mockResolvedValueOnce(response("old")).mockRejectedValueOnce(failure).mockResolvedValue(response("new"));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProviderResets({ enabled: true }));
    await act(async () => {});
    const stale = result.current.data;
    await act(async () => vi.advanceTimersByTimeAsync(ttl));
    expect(result.current.data).toBe(stale);
    expect(result.current.error).toBe(failure);
    expect(result.current.loading).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(ttl - 1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    expect(result.current.data.claude[0].id).toBe("new");
  });

  it.each([true, false])("does not reschedule after unmount while request settles (ok=%s)", async (ok) => {
    let settle;
    const fetchMock = vi.fn(() => new Promise((resolve, reject) => { settle = () => ok ? resolve(response("fixture")) : reject(new Error("fixture failure")); }));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = renderHook(() => useProviderResets({ enabled: true }));
    unmount();
    await act(async () => settle());
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(ttl * 2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
