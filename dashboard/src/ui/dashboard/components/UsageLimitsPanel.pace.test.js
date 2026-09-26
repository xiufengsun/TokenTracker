import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../../lib/copy";
import { UsageLimitsPanel } from "./UsageLimitsPanel.jsx";

function panel({ fiveHourReset, weeklyReset, displayMode } = {}) {
  return createElement(UsageLimitsPanel, {
    claude: {
      configured: true,
      five_hour: { utilization: 42, resets_at: fiveHourReset },
      seven_day: weeklyReset ? { utilization: 55, resets_at: weeklyReset } : null,
    },
    order: ["claude"],
    displayMode,
  });
}

function marker(label) {
  return screen.getByText(label).closest(".group")?.querySelector("div.absolute.top-0.h-full") ?? null;
}

function markerPosition(label) {
  const node = marker(label);
  return node ? Number(node.style.left.match(/calc\(([\d.]+)%/)?.[1]) : null;
}

describe("UsageLimitsPanel pace clock", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text) => ({ width: String(text).length * 6 }),
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("advances 5h and weekly markers without fetching usage and snaps on reset changes", () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));
    const fetchUsage = vi.fn();
    vi.stubGlobal("fetch", fetchUsage);
    const { rerender } = render(panel({
      fiveHourReset: "2026-09-24T15:00:00.000Z",
      weeklyReset: "2026-09-28T00:00:00.000Z",
    }));

    const fiveHourLabel = copy("limits.label.claude_5h");
    const weeklyLabel = copy("limits.label.claude_7d");
    expect(markerPosition(fiveHourLabel)).toBeCloseTo(40);
    expect(markerPosition(weeklyLabel)).toBeCloseTo(50);
    act(() => vi.advanceTimersByTime(10_000));
    expect(markerPosition(fiveHourLabel)).toBeGreaterThan(40);
    expect(markerPosition(weeklyLabel)).toBeGreaterThan(50);
    expect(marker(fiveHourLabel)).toHaveClass("motion-safe:transition-[left]");
    expect(fetchUsage).not.toHaveBeenCalled();

    const oldMarker = marker(fiveHourLabel);
    rerender(panel({ fiveHourReset: "2026-09-24T17:00:00.000Z" }));
    expect(marker(fiveHourLabel)).not.toBe(oldMarker);
  });

  it("moves remaining-mode markers backward and hides an expired window", () => {
    vi.setSystemTime(new Date("2026-09-24T14:59:40.000Z"));
    render(panel({ fiveHourReset: "2026-09-24T15:00:00.000Z", displayMode: "remaining" }));
    const label = copy("limits.label.claude_5h");
    const initial = markerPosition(label);
    act(() => vi.advanceTimersByTime(10_000));
    expect(markerPosition(label)).toBeLessThan(initial);
    act(() => vi.advanceTimersByTime(10_000));
    expect(markerPosition(label)).toBeNull();
  });

  it("pauses while hidden and snaps to current time on return", () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    render(panel({ fiveHourReset: "2026-09-24T15:00:00.000Z" }));
    const label = copy("limits.label.claude_5h");

    visibility.mockReturnValue("hidden");
    act(() => fireEvent(document, new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(60_000));
    expect(markerPosition(label)).toBeCloseTo(40);

    visibility.mockReturnValue("visible");
    act(() => fireEvent(document, new Event("visibilitychange")));
    expect(markerPosition(label)).toBeGreaterThan(40);
    expect(marker(label)).not.toHaveClass("motion-safe:transition-[left]");
  });
});
