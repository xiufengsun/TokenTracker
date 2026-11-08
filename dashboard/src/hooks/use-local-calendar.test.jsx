import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as timezone from "../lib/timezone";
import { useLocalCalendar } from "./use-local-calendar";

describe("useLocalCalendar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 8, 23, 59, 59));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("advances at local midnight and schedules the following day", () => {
    const { result } = renderHook(() => useLocalCalendar());
    expect(result.current.todayKey).toBe("2026-11-08");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.todayKey).toBe("2026-11-09");
    act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000));
    expect(result.current.todayKey).toBe("2026-11-10");
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["focus", "visibilitychange"])("catches up after sleep on %s", (event) => {
    const { result } = renderHook(() => useLocalCalendar());
    // Changing the clock without running timers models a suspended WebView.
    vi.setSystemTime(new Date(2026, 10, 11, 9));
    act(() => {
      if (event === "focus") window.dispatchEvent(new Event(event));
      else document.dispatchEvent(new Event(event));
    });
    expect(result.current.todayKey).toBe("2026-11-11");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps calendar identity stable for focus events within the same day", () => {
    const { result } = renderHook(() => useLocalCalendar());
    const initial = result.current;
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current).toBe(initial);
  });

  it("rechecks the local time zone and UTC offset on focus", () => {
    const { result } = renderHook(() => useLocalCalendar());
    vi.spyOn(timezone, "getBrowserTimeZone").mockReturnValue("Pacific/Honolulu");
    vi.spyOn(timezone, "getBrowserTimeZoneOffsetMinutes").mockReturnValue(-600);
    const expectedDay = timezone.getLocalDayKey({ timeZone: "Pacific/Honolulu", date: new Date() });
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current).toEqual({ timeZone: "Pacific/Honolulu", tzOffsetMinutes: -600, todayKey: expectedDay });
  });

  it("keeps an explicit mock date fixed and starts the clock when it is removed", () => {
    const mockNow = new Date(2026, 0, 2, 12);
    const { result, rerender } = renderHook(({ now }) => useLocalCalendar(now), { initialProps: { now: mockNow } });
    expect(result.current.todayKey).toBe("2026-01-02");
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(2000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current.todayKey).toBe("2026-01-02");
    rerender({ now: null });
    expect(result.current.todayKey).toBe("2026-11-09");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("cleans up the midnight timer and event listeners on unmount", () => {
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useLocalCalendar());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});
