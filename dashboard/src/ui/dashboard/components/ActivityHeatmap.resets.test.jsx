import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderResetsCache } from "../../../hooks/use-provider-resets.js";
import { copy } from "../../../lib/copy";
import { ActivityHeatmap } from "./ActivityHeatmap.jsx";

vi.mock("../../../hooks/useTheme.js", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));

const PAYLOAD = {
  providers: {
    claude: {
      events: [{ id: "c1", date: "2026-10-20T15:00:00Z", kind: "reset", scope: "all", note: "Claude reset note" }],
    },
    codex: {
      events: [
        { id: "x1", date: "2026-11-01T12:00:00Z", kind: "reset", resetType: "banked", note: "Banked 1/2" },
        { id: "x2", date: "2026-10-28T12:00:00Z", kind: "reset", resetType: "regular", note: "And it's done." },
        { id: "x3", date: "2026-10-28T18:00:00Z", kind: "reset", resetType: "banked", note: "Banked bonus" },
      ],
    },
  },
};

const HEATMAP = {
  to: "2026-11-03",
  week_starts_on: "sun",
  weeks: [[{ day: "2026-11-02", total_tokens: 1000 }]],
};

function renderHeatmap() {
  return render(createElement(ActivityHeatmap, { heatmap: HEATMAP, timeZone: "UTC" }));
}

function cell(day) {
  return document.querySelector(`[data-day="${day}"]`);
}

describe("ActivityHeatmap reset tabs", () => {
  let fetchMock;
  beforeEach(() => {
    resetProviderResetsCache();
    window.localStorage.clear();
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => PAYLOAD }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not fetch reset history until a reset tab is opened", () => {
    renderHeatmap();
    expect(screen.getByRole("tab", { name: copy("heatmap.view.claude") })).toBeTruthy();
    expect(screen.getByRole("tab", { name: copy("heatmap.view.codex") })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("colours banked, automatic and mixed reset days differently on the Codex tab", async () => {
    renderHeatmap();
    fireEvent.click(screen.getByRole("tab", { name: copy("heatmap.view.codex") }));
    await waitFor(() => expect(cell("2026-11-01").className).toContain("bg-amber-500"));
    expect(cell("2026-10-28").className).toContain("bg-gradient-to-br");
    expect(cell("2026-10-20").className).not.toMatch(/bg-(amber|blue)-500|bg-gradient/);
    expect(screen.getByText(copy("heatmap.resets.type.banked"))).toBeTruthy();
    expect(screen.getByText(copy("heatmap.resets.source")).closest("a").getAttribute("href")).toBe(
      "https://claude-resets.com",
    );
    expect(window.localStorage.getItem("tt:heatmap-view")).toBe("codex");
  });

  it("shows Claude's automatic resets and the event in the tooltip", async () => {
    renderHeatmap();
    fireEvent.click(screen.getByRole("tab", { name: copy("heatmap.view.claude") }));
    await waitFor(() => expect(cell("2026-10-20").className).toContain("bg-blue-500"));
    expect(cell("2026-11-01").className).not.toContain("bg-amber-500");
    await act(async () => {
      fireEvent.mouseEnter(cell("2026-10-20"));
    });
    expect(screen.getByText("Claude reset note")).toBeTruthy();
  });

  it("lets keyboard users focus a reset day to read its details", async () => {
    renderHeatmap();
    fireEvent.click(screen.getByRole("tab", { name: copy("heatmap.view.codex") }));
    await waitFor(() => expect(cell("2026-11-01").getAttribute("tabindex")).toBe("0"));
    expect(cell("2026-11-02").hasAttribute("tabindex")).toBe(false);
    await act(async () => {
      fireEvent.focus(cell("2026-11-01"));
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("Banked 1/2");
    expect(cell("2026-11-01").getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(cell("2026-10-28").getAttribute("aria-label")).toBe(
      `2026-10-28: ${copy("heatmap.resets.type.banked")}, ${copy("heatmap.resets.type.regular")}`,
    );
  });

  it("keeps a focused reset day's tooltip through pointer moves and scrolling", async () => {
    renderHeatmap();
    fireEvent.click(screen.getByRole("tab", { name: copy("heatmap.view.codex") }));
    await waitFor(() => expect(cell("2026-11-01").getAttribute("tabindex")).toBe("0"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => cell("2026-11-01").focus());
      fireEvent.mouseLeave(cell("2026-11-01"));
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole("tooltip").textContent).toContain("Banked 1/2");
      fireEvent.mouseEnter(cell("2026-10-28"));
      expect(screen.getByRole("tooltip").textContent).toContain("Banked bonus");
      fireEvent.mouseLeave(cell("2026-10-28"));
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole("tooltip").textContent).toContain("Banked 1/2");
      fireEvent.scroll(cell("2026-11-01").closest(".overflow-x-auto"));
      expect(screen.getByRole("tooltip").textContent).toContain("Banked 1/2");
      expect(cell("2026-11-01").getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
      act(() => cell("2026-11-01").blur());
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops loading and shows the error when the request times out", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fetchMock.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    try {
      renderHeatmap();
      fireEvent.click(screen.getByRole("tab", { name: copy("heatmap.view.codex") }));
      await waitFor(() => expect(screen.getByText(copy("heatmap.resets.loading"))).toBeTruthy());
      await act(async () => controller.abort(new DOMException("timed out", "TimeoutError")));
      await waitFor(() => expect(screen.getByText(copy("heatmap.resets.error"))).toBeTruthy());
      expect(screen.queryByText(copy("heatmap.resets.loading"))).toBeNull();
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("still fetches where AbortSignal.timeout is unavailable", async () => {
    const original = AbortSignal.timeout;
    delete AbortSignal.timeout;
    try {
      renderHeatmap();
      fireEvent.click(screen.getByRole("tab", { name: copy("heatmap.view.codex") }));
      await waitFor(() => expect(cell("2026-11-01").className).toContain("bg-amber-500"));
      expect(fetchMock.mock.calls[0][1].signal).toBeUndefined();
    } finally {
      AbortSignal.timeout = original;
    }
  });

  it("keeps the grid and reports an error when the tracker is unreachable", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 502 }));
    renderHeatmap();
    fireEvent.click(screen.getByRole("tab", { name: copy("heatmap.view.codex") }));
    await waitFor(() => expect(screen.getByText(copy("heatmap.resets.error"))).toBeTruthy());
    expect(cell("2026-11-02")).not.toBeNull();
  });
});
