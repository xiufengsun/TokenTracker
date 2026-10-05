import { createElement } from "react";
import { act, render, screen } from "@testing-library/react";
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

  it("advances 5h and weekly markers once a minute without fetching usage or animating left", () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));
    const fetchUsage = vi.fn();
    vi.stubGlobal("fetch", fetchUsage);
    render(panel({
      fiveHourReset: "2026-09-24T15:00:00.000Z",
      weeklyReset: "2026-09-28T00:00:00.000Z",
    }));

    const fiveHourLabel = copy("limits.label.claude_5h");
    const weeklyLabel = copy("limits.label.claude_7d");
    expect(markerPosition(fiveHourLabel)).toBeCloseTo(40);
    expect(markerPosition(weeklyLabel)).toBeCloseTo(50);
    act(() => vi.advanceTimersByTime(10_000));
    expect(markerPosition(fiveHourLabel)).toBeCloseTo(40);
    expect(markerPosition(weeklyLabel)).toBeCloseTo(50);
    act(() => vi.advanceTimersByTime(50_000));
    expect(markerPosition(fiveHourLabel)).toBeGreaterThan(40);
    expect(markerPosition(weeklyLabel)).toBeGreaterThan(50);
    expect(marker(fiveHourLabel)).not.toHaveClass("motion-safe:transition-[left]");
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("moves remaining-mode markers backward and hides an expired window", () => {
    vi.setSystemTime(new Date("2026-09-24T14:58:00.000Z"));
    render(panel({ fiveHourReset: "2026-09-24T15:00:00.000Z", displayMode: "remaining" }));
    const label = copy("limits.label.claude_5h");
    const initial = markerPosition(label);
    act(() => vi.advanceTimersByTime(60_000));
    expect(markerPosition(label)).toBeLessThan(initial);
    act(() => vi.advanceTimersByTime(60_000));
    expect(markerPosition(label)).toBeNull();
  });

  it("shares the minute clock across provider refreshes without remounting rows", () => {
    vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));
    const { rerender } = render(panel({ fiveHourReset: "2026-09-24T15:00:00.000001Z" }));
    const label = copy("limits.label.claude_5h");
    const oldMarker = marker(label);
    const oldTooltip = oldMarker.closest(".group").querySelector('[role="tooltip"]');

    vi.setSystemTime(new Date("2026-09-24T12:00:30.000Z"));
    rerender(panel({ fiveHourReset: "2026-09-24T15:00:00.000002Z" }));
    expect(marker(label)).toBe(oldMarker);
    expect(marker(label).closest(".group").querySelector('[role="tooltip"]')).toBe(oldTooltip);
    expect(markerPosition(label)).toBeCloseTo(40);
  });
});
