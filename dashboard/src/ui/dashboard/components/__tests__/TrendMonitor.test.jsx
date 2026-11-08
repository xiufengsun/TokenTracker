import React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The zoom modal pulls in use-trend-data (a .ts hook imported with a .js
// specifier) which vitest's resolver can't follow the way the Vite build does.
// The small-card tests never open the modal, so stub it out.
vi.mock("../TrendMonitorZoomModal", () => ({ TrendMonitorZoomModal: () => null }));

import {
  TrendMonitor,
  chooseTrendTooltipPlacement,
  computeInterpolatedSeries,
  getTrendMonitorScale,
  mergeModelSegments,
} from "../TrendMonitor.jsx";

describe("getTrendMonitorScale", () => {
  it("clips isolated outliers before deriving the chart max", () => {
    const scale = getTrendMonitorScale([80, 90, 95, 110, 120, 140, 10000]);

    expect(scale.rawMax).toBe(10000);
    expect(scale.effectiveMax).toBeLessThan(300);
    expect(scale.clippedValues.at(-1)).toBe(scale.effectiveMax);
    expect((scale.clippedValues[0] / scale.effectiveMax) * 100).toBeGreaterThan(30);
  });
});

describe("TrendMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps normal bars visible when a single day is an outlier", () => {
    const rows = [80, 90, 95, 110, 120, 140, 10000].map((value) => ({
      billable_total_tokens: value,
    }));

    const { container } = render(
      <TrendMonitor rows={rows} showTimeZoneLabel={false} />,
    );
    const bars = Array.from(container.querySelectorAll('[data-trend-bar="true"]'));

    expect(bars).toHaveLength(rows.length);
    expect(parseFloat(bars[0].parentElement?.style.height ?? "")).toBeGreaterThan(30);
    expect(parseFloat(bars.at(-1)?.parentElement?.style.height ?? "")).toBe(100);
    expect(bars[0].parentElement?.className).toContain("absolute");
    expect(bars[0].parentElement?.parentElement?.className).toContain("self-stretch");
  });

  it("preserves proportional monthly heights for the reported growing series", () => {
    const values = [0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 6.5, 8.9].map((v) => v * 1e9);
    const { container } = render(
      <TrendMonitor rows={values.map((value) => ({ total_tokens: value }))} period="total" />,
    );
    const bars = Array.from(container.querySelectorAll('[data-trend-bar="true"]'));
    expect(parseFloat(bars[7].parentElement.style.height)).toBeCloseTo(6.5 / 8.9 * 100);
    expect(parseFloat(bars[8].parentElement.style.height)).toBe(100);
  });

  it("renders real-zero observations as flat baseline bars, not interpolated", () => {
    // Two real values bracketing a real zero: the zero must NOT be filled in.
    const rows = [
      { billable_total_tokens: 100 },
      { billable_total_tokens: 0 },
      { billable_total_tokens: 100 },
    ];
    const { container } = render(
      <TrendMonitor rows={rows} showTimeZoneLabel={false} />,
    );
    const bars = Array.from(container.querySelectorAll('[data-trend-bar="true"]'));
    expect(bars).toHaveLength(3);
    // Real-zero gets the baseline pixel height, not a percentage interpolation.
    expect(bars[1].parentElement?.style.height).toBe("2px");
  });

  it("renders future bars as flat estimates with an always-visible legend", () => {
    const rows = [
      { billable_total_tokens: 100 },
      { billable_total_tokens: 100 },
      { future: true },
    ];
    const { container } = render(
      <TrendMonitor rows={rows} showTimeZoneLabel={false} />,
    );
    const bars = Array.from(container.querySelectorAll('[data-trend-bar="true"]'));
    const previewBar = bars.at(-1);
    expect(previewBar?.dataset.trendKind).toBe("predicted");
    expect(previewBar?.style.opacity).toBe("0.9");
    expect(previewBar?.style.backgroundImage).toBe("");
    expect(container.querySelector('[data-trend-prediction-legend="true"]')?.textContent).toContain(
      "~ Estimated",
    );
    // Predicted heights are clipped to the y-axis max and rendered as a percentage.
    expect(previewBar?.parentElement?.style.height).toMatch(/%$/);
  });

  it("does not show the estimate legend when the range has no future rows", () => {
    const { container } = render(
      <TrendMonitor rows={[{ billable_total_tokens: 100 }]} showTimeZoneLabel={false} />,
    );

    expect(container.querySelector('[data-trend-prediction-legend="true"]')).toBeNull();
  });

  it("renders X-axis tick labels only in zoom mode (small card unchanged)", () => {
    const rows = [
      { hour: "2026-05-29T14:00:00", billable_total_tokens: 100 },
      { hour: "2026-05-29T14:30:00", billable_total_tokens: 200 },
    ];

    const plain = render(<TrendMonitor rows={rows} period="day" showTimeZoneLabel={false} />);
    expect(plain.container.textContent).not.toContain("14:00");

    const zoomed = render(
      <TrendMonitor rows={rows} period="day" isZoom showTimeZoneLabel={false} />,
    );
    expect(zoomed.container.textContent).toContain("14:00");
    expect(zoomed.container.textContent).toContain("14:30");
  });

  it("shows the maximize button only when zoomConfig is provided", () => {
    const rows = [{ billable_total_tokens: 100 }];

    const without = render(<TrendMonitor rows={rows} showTimeZoneLabel={false} />);
    expect(without.queryByRole("button", { name: /zoom|expand/i })).toBeNull();

    const withCfg = render(
      <TrendMonitor rows={rows} zoomConfig={{ baseUrl: "http://localhost" }} showTimeZoneLabel={false} />,
    );
    expect(withCfg.queryByRole("button", { name: /zoom|expand/i })).not.toBeNull();
  });

  it("keeps hover non-interactive and anchors adjacent bars at the same height", () => {
    const { container } = render(<TrendMonitor rows={[{ total_tokens: 10 }, { total_tokens: 500 }]} />);
    const bars = container.querySelectorAll('[role="button"]');
    bars.forEach((bar, i) => { bar.getBoundingClientRect = () => ({ left: i * 30, bottom: 160, width: 30 }); });
    fireEvent.mouseEnter(bars[0]);
    let tooltip = container.querySelector('[data-trend-tooltip]');
    expect(tooltip.className).toContain("pointer-events-none");
    expect(tooltip.style.top).toBe("160px");
    fireEvent.mouseLeave(bars[0]);
    fireEvent.mouseEnter(bars[1]);
    tooltip = container.querySelector('[data-trend-tooltip]');
    expect(tooltip.style.top).toBe("160px");
    expect(tooltip.textContent).toContain("500");
    fireEvent.mouseLeave(bars[1]);
    expect(container.querySelector('[data-trend-tooltip]')).toBeNull();
  });

  it("pins scrollable details on click and dismisses with Escape or an outside pointer", () => {
    const models = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`model-${i}`, 100]));
    const { container } = render(<TrendMonitor rows={[{ total_tokens: 800, models }, { total_tokens: 20 }]} />);
    const bars = container.querySelectorAll('[role="button"]');
    fireEvent.click(bars[0]);
    const tooltip = container.querySelector('[data-trend-tooltip]');
    expect(tooltip.className).toContain("pointer-events-auto");
    expect(tooltip.querySelector('.overflow-y-auto')).not.toBeNull();
    fireEvent.mouseLeave(bars[0]);
    fireEvent.mouseEnter(bars[1]);
    expect(tooltip.textContent).toContain("800");
    fireEvent.pointerDown(tooltip);
    expect(container.querySelector('[data-trend-tooltip]')).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector('[data-trend-tooltip]')).toBeNull();
    fireEvent.keyDown(bars[0], { key: "Enter" });
    expect(container.querySelector('[data-trend-tooltip]')).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(container.querySelector('[data-trend-tooltip]')).toBeNull();
  });

  it("moves the tooltip above the chart when the scroll pane has no room below", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(180);
    try {
      const { container } = render(
        <div style={{ overflowY: "auto" }}>
          <TrendMonitor rows={[{ total_tokens: 10 }, { total_tokens: 500 }]} />
        </div>,
      );
      // Scrolled to the bottom: the chart's columns end 32px above the pane edge.
      container.firstChild.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
      const bars = container.querySelectorAll('[role="button"]');
      bars.forEach((bar, i) => {
        bar.getBoundingClientRect = () => ({ left: i * 30, top: 200, bottom: 360, width: 30 });
      });
      fireEvent.mouseEnter(bars[0]);
      const tooltip = container.querySelector("[data-trend-tooltip]");
      // Anchored to the column top (not the bar top) so it can't grow the pane.
      expect(tooltip.style.top).toBe("200px");
      expect(tooltip.firstChild.className).toContain("bottom-[10px]");
      expect(tooltip.firstChild.style.maxHeight).toBe("");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("caps the tooltip to the visible pane when neither side has room", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
    try {
      const { container } = render(
        <div style={{ overflowY: "auto" }}>
          <TrendMonitor rows={[{ total_tokens: 10 }]} />
        </div>,
      );
      container.firstChild.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
      const bar = container.querySelector('[role="button"]');
      bar.getBoundingClientRect = () => ({ left: 0, top: 100, bottom: 260, width: 30 });
      fireEvent.mouseEnter(bar);
      const box = container.querySelector("[data-trend-tooltip]").firstChild;
      expect(box.className).toContain("top-[10px]");
      expect(box.style.maxHeight).toBe("122px");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("dismisses pinned details when their viewport placement becomes stale", () => {
    const { container } = render(<TrendMonitor rows={[{ total_tokens: 800 }]} />);
    const bar = container.querySelector('[role="button"]');
    fireEvent.click(bar);
    expect(container.querySelector('[data-trend-tooltip]')).not.toBeNull();
    fireEvent.resize(window);
    expect(container.querySelector('[data-trend-tooltip]')).toBeNull();
    fireEvent.click(bar);
    fireEvent.scroll(window);
    expect(container.querySelector('[data-trend-tooltip]')).toBeNull();
    fireEvent.click(bar);
    fireEvent.scroll(container);
    expect(container.querySelector('[data-trend-tooltip]')).toBeNull();
  });

  it("keeps pinned details open while their own contents scroll", () => {
    const models = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`model-${i}`, 100]));
    const { container } = render(<TrendMonitor rows={[{ total_tokens: 800, models }]} />);
    fireEvent.click(container.querySelector('[role="button"]'));
    const tooltip = container.querySelector('[data-trend-tooltip]');
    fireEvent.scroll(tooltip.querySelector('.overflow-y-auto'));
    expect(container.querySelector('[data-trend-tooltip]')).toBe(tooltip);
  });

  it("merges model segments whose names differ only by case", () => {
    expect(mergeModelSegments({
      "GPT-5.5": 120,
      "gpt-5.5": 80,
      "Claude-Sonnet": 40,
      " claude-sonnet ": 10,
    })).toEqual([
      { type: "model", name: "GPT-5.5", value: 200 },
      { type: "model", name: "Claude-Sonnet", value: 50 },
    ]);
  });
});

describe("chooseTrendTooltipPlacement", () => {
  const band = { top: 0, bottom: 600 };

  it("prefers below the chart when it fits", () => {
    expect(chooseTrendTooltipPlacement({ columnTop: 200, columnBottom: 360, height: 200, band }))
      .toEqual({ side: "below", maxHeight: null });
  });

  it("moves above the chart instead of overflowing the visible area", () => {
    expect(chooseTrendTooltipPlacement({ columnTop: 400, columnBottom: 560, height: 200, band }))
      .toEqual({ side: "above", maxHeight: null });
  });

  it("keeps a sweep above so adjacent bars don't alternate sides", () => {
    expect(chooseTrendTooltipPlacement({ columnTop: 400, columnBottom: 500, height: 80, band, prefer: "above" }))
      .toEqual({ side: "above", maxHeight: null });
    expect(chooseTrendTooltipPlacement({ columnTop: 400, columnBottom: 500, height: 80, band, prefer: "below" }))
      .toEqual({ side: "below", maxHeight: null });
  });

  it("caps the height on the roomier side when neither side fits", () => {
    expect(chooseTrendTooltipPlacement({ columnTop: 100, columnBottom: 260, height: 400, band }))
      .toEqual({ side: "below", maxHeight: 330 });
    expect(chooseTrendTooltipPlacement({ columnTop: 300, columnBottom: 460, height: 400, band }))
      .toEqual({ side: "above", maxHeight: 290 });
  });
});

describe("computeInterpolatedSeries", () => {
  it("passes observed values through unchanged (including zero)", () => {
    expect(computeInterpolatedSeries([10, 0, 20])).toEqual([10, 0, 20]);
  });

  it("linearly interpolates between two bracketing observations", () => {
    const out = computeInterpolatedSeries([100, null, null, 400]);
    expect(out[1]).toBeCloseTo(200);
    expect(out[2]).toBeCloseTo(300);
  });

  it("extrapolates trailing gaps with decay toward zero", () => {
    const out = computeInterpolatedSeries([100, 100, 100, null, null]);
    // Each successive future step shrinks by the per-step decay factor.
    expect(out[3]).toBeGreaterThan(0);
    expect(out[4]).toBeGreaterThan(0);
    expect(out[4]).toBeLessThan(out[3]);
    // Extrapolation never exceeds the observed base.
    expect(out[3]).toBeLessThan(100);
  });

  it("returns all zeros when no observations exist", () => {
    expect(computeInterpolatedSeries([null, null, null])).toEqual([0, 0, 0]);
  });
});
