import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUsageLimits } from "../lib/api";
import { publishUsageLimitsPreloadState } from "../lib/dashboard-preload.js";
import { useUsageLimits } from "./use-usage-limits";
import { LIMITS_PREFS_CHANGED_EVENT } from "./use-limits-display-prefs.js";

const VISIBILITY_KEY = "tt.limits.providerVisibility";

function saveDevinSelection(selected: boolean) {
  window.localStorage.setItem(VISIBILITY_KEY, JSON.stringify({ devin: selected }));
}

function dispatchPrefsChanged() {
  window.dispatchEvent(new Event(LIMITS_PREFS_CHANGED_EVENT));
}

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  getUsageLimits: vi.fn(),
}));

vi.mock("../lib/dashboard-preload.js", () => ({
  publishUsageLimitsPreloadState: vi.fn(),
}));

const existingLimits = {
  fetched_at: "2026-05-30T10:00:00.000Z",
  claude: { configured: false },
  codex: {
    configured: true,
    reset_credits: {
      available_count: 1,
      total_earned_count: 2,
      credits: [
        {
          status: "available",
          reset_type: "codex_rate_limits",
          granted_at: "2026-05-25T08:00:00.000Z",
          expires_at: "2026-07-12T02:13:21.590541Z",
        },
      ],
    },
  },
  cursor: { configured: false },
  gemini: { configured: false },
  kimi: {
    configured: true,
    primary_window: { used_percent: 42, reset_at: "2026-05-30T12:00:00.000Z" },
  },
  kiro: { configured: false },
  grok: { configured: false },
  antigravity: { configured: false },
  zcode: { configured: false },
  opencodeGo: { configured: false },
  qoder: { configured: false },
  codingPlan: { configured: false },
  agentPlan: { configured: false },
  devin: { configured: false },
};

const freshLimits = {
  ...existingLimits,
  fetched_at: "2026-05-30T10:05:00.000Z",
  codex: {
    configured: true,
    reset_credits: {
      available_count: 2,
      total_earned_count: 3,
      credits: [
        {
          status: "available",
          reset_type: "codex_rate_limits",
          granted_at: "2026-05-25T08:00:00.000Z",
          expires_at: "2026-07-12T02:13:21.590541Z",
        },
        {
          status: "available",
          reset_type: "codex_rate_limits",
          granted_at: "2026-05-30T08:00:00.000Z",
          expires_at: "2026-07-18T04:30:00.000000Z",
        },
      ],
    },
  },
  kimi: {
    configured: true,
    primary_window: { used_percent: 18, reset_at: "2026-05-30T12:30:00.000Z" },
  },
};

describe("useUsageLimits", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(getUsageLimits).mockReset();
    vi.mocked(publishUsageLimitsPreloadState).mockReset();
  });

  it("uses reusable initial data immediately and writes the background refresh back to cache", async () => {
    vi.mocked(getUsageLimits).mockResolvedValue(freshLimits);

    const { result } = renderHook(() =>
      useUsageLimits({
        initialRefresh: true,
        initialState: { data: existingLimits },
        publishToPreloadCache: true,
      }),
    );

    expect(result.current.data).toBe(existingLimits);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);

    await waitFor(() => expect(result.current.data).toEqual(freshLimits));

    // Mount fetch reads the server cache (no forced upstream refresh).
    expect(getUsageLimits).toHaveBeenCalledTimes(1);
    expect(getUsageLimits).toHaveBeenCalledWith({ devinEnabled: false });
    expect(result.current.data?.codex.reset_credits).toEqual(freshLimits.codex.reset_credits);
    expect(publishUsageLimitsPreloadState).toHaveBeenCalledWith(freshLimits, {
      source: "page-load",
    });
  });

  it("keeps the initialRefresh fallback when no reusable initial data exists", async () => {
    vi.mocked(getUsageLimits).mockResolvedValue(freshLimits);

    const { result } = renderHook(() => useUsageLimits({ initialRefresh: true }));

    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(getUsageLimits).toHaveBeenCalledTimes(1);
    expect(getUsageLimits).toHaveBeenCalledWith({ devinEnabled: false });
    expect(result.current.data).toEqual(freshLimits);
    expect(result.current.data?.codex.reset_credits).toEqual(freshLimits.codex.reset_credits);
    expect(result.current.error).toBeNull();
  });

  it("keeps initial cached data visible when the background refresh fails", async () => {
    vi.mocked(getUsageLimits).mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() =>
      useUsageLimits({
        initialRefresh: true,
        initialState: { data: existingLimits },
        publishToPreloadCache: true,
      }),
    );

    expect(result.current.data).toBe(existingLimits);
    expect(result.current.isLoading).toBe(false);

    await waitFor(() => expect(result.current.error).toBe("network down"));

    expect(result.current.data).toBe(existingLimits);
    expect(publishUsageLimitsPreloadState).not.toHaveBeenCalled();
  });

  it("forces refresh manually and writes cache with the manual-refresh source", async () => {
    vi.mocked(getUsageLimits).mockResolvedValue(freshLimits);

    const { result } = renderHook(() =>
      useUsageLimits({
        initialRefresh: false,
        initialState: { data: existingLimits },
        publishToPreloadCache: true,
      }),
    );

    await Promise.resolve();
    expect(getUsageLimits).not.toHaveBeenCalled();
    expect(result.current.data?.codex.reset_credits).toEqual(existingLimits.codex.reset_credits);

    await act(async () => {
      await result.current.refresh();
    });

    expect(getUsageLimits).toHaveBeenCalledTimes(1);
    expect(getUsageLimits).toHaveBeenCalledWith({ refresh: true, devinEnabled: false });
    expect(result.current.data).toEqual(freshLimits);
    expect(publishUsageLimitsPreloadState).toHaveBeenCalledWith(freshLimits, {
      source: "manual-refresh",
    });
  });

  it("does not let a slow mount read overwrite a newer manual refresh", async () => {
    let resolveMount: ((value: any) => void) | null = null;
    let resolveManual: ((value: any) => void) | null = null;
    vi.mocked(getUsageLimits).mockImplementation((options: any = {}) =>
      new Promise((resolve) => {
        if (options?.refresh) resolveManual = resolve;
        else resolveMount = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useUsageLimits({ initialRefresh: true }),
    );
    await waitFor(() => expect(getUsageLimits).toHaveBeenCalledTimes(1));

    let manualRefresh: Promise<void>;
    await act(async () => {
      manualRefresh = result.current.refresh();
    });
    await waitFor(() => expect(getUsageLimits).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveManual?.(freshLimits);
      await manualRefresh;
    });
    expect(result.current.data).toEqual(freshLimits);
    expect(result.current.isLoading).toBe(false);

    // The older page-load response arrives last and must be ignored.
    await act(async () => {
      resolveMount?.(existingLimits);
    });
    expect(result.current.data).toEqual(freshLimits);
    expect(result.current.isLoading).toBe(false);
  });
});

describe("useUsageLimits Devin opt-in selection", () => {
  const devinLimits = {
    ...freshLimits,
    devin: {
      configured: true,
      plan_label: "Pro",
      primary_window: { used_percent: 40, reset_at: "2026-05-31T08:00:00.000Z" },
      secondary_window: { used_percent: 90, reset_at: "2026-06-06T08:00:00.000Z" },
    },
  };

  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(getUsageLimits).mockReset();
    vi.mocked(publishUsageLimitsPreloadState).mockReset();
  });

  it("forwards the opt-in only when the provider switch is on", async () => {
    saveDevinSelection(true);
    vi.mocked(getUsageLimits).mockResolvedValue(devinLimits);

    const { result } = renderHook(() => useUsageLimits({ initialRefresh: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(getUsageLimits).toHaveBeenCalledWith({ devinEnabled: true });
    expect(result.current.data?.devin.configured).toBe(true);
    expect(result.current.data?.devin.primary_window?.used_percent).toBe(40);
  });

  it("turning the switch on re-reads limits with the opt-in", async () => {
    vi.mocked(getUsageLimits).mockResolvedValue(existingLimits);
    const { result } = renderHook(() => useUsageLimits({ initialRefresh: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    vi.mocked(getUsageLimits).mockResolvedValue(devinLimits);
    await act(async () => {
      saveDevinSelection(true);
      dispatchPrefsChanged();
    });

    await waitFor(() => expect(result.current.data?.devin.configured).toBe(true));
    expect(getUsageLimits).toHaveBeenLastCalledWith({ devinEnabled: true });
  });

  it("turning the switch off drops retained Devin rows before the refetch lands", async () => {
    saveDevinSelection(true);
    vi.mocked(getUsageLimits).mockResolvedValue(devinLimits);
    const { result } = renderHook(() => useUsageLimits({ initialRefresh: true }));
    await waitFor(() => expect(result.current.data?.devin.configured).toBe(true));

    vi.mocked(getUsageLimits).mockResolvedValue(existingLimits);
    await act(async () => {
      saveDevinSelection(false);
      dispatchPrefsChanged();
    });

    // Retained Devin rows are gone immediately, without waiting for the network.
    expect(result.current.data?.devin).toEqual({ configured: false });
    await waitFor(() => expect(result.current.data).toEqual(existingLimits));
    expect(getUsageLimits).toHaveBeenLastCalledWith({ devinEnabled: false });
  });

  it("a response in flight when the switch turns off cannot republish Devin", async () => {
    saveDevinSelection(true);
    let resolveMount: ((value: any) => void) | null = null;
    vi.mocked(getUsageLimits)
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveMount = resolve; }),
      )
      .mockResolvedValue(existingLimits);

    const { result } = renderHook(() => useUsageLimits({ initialRefresh: true }));
    await waitFor(() =>
      expect(getUsageLimits).toHaveBeenCalledWith({ devinEnabled: true }),
    );

    await act(async () => {
      saveDevinSelection(false);
      dispatchPrefsChanged();
    });
    // The off-selection re-read publishes clean data.
    await waitFor(() => expect(result.current.data).toEqual(existingLimits));

    // The superseded enabled response lands late — its Devin rows must not win.
    await act(async () => {
      resolveMount?.(devinLimits);
    });
    expect(result.current.data?.devin).toEqual({ configured: false });
  });

  it.each([true, false])("rewrites stale Devin payloads while off even with configured=%s", async (configured) => {
    // A cached/pre-disable payload can still carry Devin data; while the
    // selection is off it must publish as not-configured instead.
    const staleLimits = { ...devinLimits, devin: { ...devinLimits.devin, configured } };
    vi.mocked(getUsageLimits).mockResolvedValue(staleLimits);
    const { result } = renderHook(() =>
      useUsageLimits({
        initialRefresh: true,
        initialState: { data: staleLimits },
        publishToPreloadCache: true,
      }),
    );

    expect(result.current.data?.devin).toEqual({ configured: false });
    expect(result.current.data?.kimi).toEqual(devinLimits.kimi);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.devin).toEqual({ configured: false });
    const published = vi.mocked(publishUsageLimitsPreloadState).mock.calls[0]?.[0] as any;
    expect(published.devin).toEqual({ configured: false });
  });
});


describe("usage limits on a public host", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not read local limits at mount, focus, preference changes or manual refresh", async () => {
    const originalWindow = window;
    vi.stubGlobal("window", new Proxy(originalWindow, {
      get(target, key) {
        if (key === "location") return { hostname: "www.tokentracker.cc", origin: "https://www.tokentracker.cc" };
        if (["addEventListener", "removeEventListener", "dispatchEvent"].includes(String(key))) {
          return (target as any)[key].bind(target);
        }
        return Reflect.get(target, key, target);
      },
    }));
    vi.mocked(getUsageLimits).mockClear();
    const { result } = renderHook(() => useUsageLimits({ initialRefresh: true, initialState: { data: existingLimits } }));
    expect(result.current).toMatchObject({ data: null, error: null, isLoading: false });
    const future = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      saveDevinSelection(true);
      dispatchPrefsChanged();
    });
    await act(async () => { await result.current.refresh(); });
    expect(getUsageLimits).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ data: null, error: null, isLoading: false });
  });
});
