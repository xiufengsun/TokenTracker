import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OVERVIEW_PERIOD,
  OVERVIEW_PERIOD_STORAGE_KEY,
  normalizeOverviewPeriod,
  persistOverviewPeriod,
  readOverviewPeriod,
} from "./overview-period-pref.js";

describe("overview opening period", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to the calendar month", () => {
    expect(readOverviewPeriod()).toBe(DEFAULT_OVERVIEW_PERIOD);
    expect(normalizeOverviewPeriod(null)).toBe("month");
    expect(normalizeOverviewPeriod("custom")).toBe("month");
    expect(normalizeOverviewPeriod("year")).toBe("month");
  });

  it("persists day, week, month, and total", () => {
    for (const period of ["day", "week", "month", "total"]) {
      expect(persistOverviewPeriod(period)).toBe(period);
      expect(window.localStorage.getItem(OVERVIEW_PERIOD_STORAGE_KEY)).toBe(period);
      expect(readOverviewPeriod()).toBe(period);
    }
  });

  it("leaves the saved range in place when a custom range is rejected", () => {
    persistOverviewPeriod("week");
    expect(persistOverviewPeriod("custom")).toBe("week");
    expect(readOverviewPeriod()).toBe("week");
  });
});
