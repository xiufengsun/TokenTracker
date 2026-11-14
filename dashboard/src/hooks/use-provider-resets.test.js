import { act, renderHook } from "@testing-library/react";
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
    const { result } = renderHook(() => useProviderResets({ enabled: true }));
    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(signal.aborted).toBe(false);
    expect(result.current.loading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(signal.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error.name).toBe("TimeoutError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("clears the fallback timer when fetch settles (ok=%s)", async (ok) => {
    let signal;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      signal = options.signal;
      return { ok, status: 503, json: async () => ({ providers: {} }) };
    }));
    const { result } = renderHook(() => useProviderResets({ enabled: true }));
    await act(async () => {});
    expect(result.current.loading).toBe(false);
    expect(Boolean(result.current.error)).toBe(!ok);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(signal.aborted).toBe(false);
  });
});
