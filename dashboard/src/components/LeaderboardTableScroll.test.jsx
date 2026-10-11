import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderboardTableScroll } from "./LeaderboardTableScroll.jsx";
import { copy } from "../lib/copy";

describe("LeaderboardTableScroll", () => {
  let contentWidth;
  let viewportWidth;
  let resize;
  let observer;

  beforeEach(() => {
    contentWidth = 1800;
    viewportWidth = 800;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => contentWidth);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback) { resize = callback; observer = this; }
      observe = vi.fn();
      disconnect = vi.fn();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderTable() {
    return render(
      <LeaderboardTableScroll>
        <table><tbody><tr><td>{copy("leaderboard.column.total")}</td></tr></tbody></table>
      </LeaderboardTableScroll>,
    );
  }

  it("makes the top scrollbar keyboard accessible and synchronizes scrolling in both directions", () => {
    const { container } = renderTable();
    const top = screen.getByRole("region", { name: "Scroll leaderboard columns horizontally" });
    const viewport = container.querySelector("table").parentElement;
    expect(top).toHaveAttribute("tabindex", "0");
    expect(top.firstElementChild).toHaveStyle({ width: "1800px" });

    fireEvent.scroll(top, { target: { scrollLeft: 350 } });
    expect(viewport.scrollLeft).toBe(350);
    fireEvent.scroll(viewport, { target: { scrollLeft: 640 } });
    expect(top.scrollLeft).toBe(640);
  });

  it("updates overflow visibility and track width when the viewport or table resizes", () => {
    const { container } = renderTable();
    const table = container.querySelector("table");
    const top = screen.getByRole("region");
    expect(observer.observe).toHaveBeenCalledWith(table);
    expect(observer.observe).toHaveBeenCalledWith(table.parentElement);

    viewportWidth = 2000;
    act(() => resize());
    expect(top).toHaveAttribute("hidden");

    contentWidth = 2400;
    act(() => resize());
    expect(top).not.toHaveAttribute("hidden");
    expect(top.firstElementChild).toHaveStyle({ width: "2400px" });
  });

  it("keeps the track aligned after column widths change and disconnects on unmount", () => {
    const { container, unmount } = renderTable();
    const top = screen.getByRole("region");
    const viewport = container.querySelector("table").parentElement;
    viewport.scrollLeft = 420;
    contentWidth = 2200;
    act(() => resize());
    expect(top.scrollLeft).toBe(420);
    unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});
