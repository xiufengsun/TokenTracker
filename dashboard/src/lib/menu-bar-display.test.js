import { describe, expect, it } from "vitest";
import { setCopyLocale } from "./copy";
import {
  DEFAULT_MENU_BAR_ITEMS,
  FALLBACK_MENU_BAR_ITEMS,
  MENU_BAR_NONE_ID,
  normalizeMenuBarItems,
} from "./menu-bar-display.js";

describe("normalizeMenuBarItems", () => {
  it("localizes the optional Antigravity Argon menu labels", () => {
    const item = FALLBACK_MENU_BAR_ITEMS.find((entry) => entry.id === "antigravityArgonWeekly");
    try {
      setCopyLocale("zh-CN");
      expect(item.label).toBe("Antigravity Argon 7 天限额");
      expect(item.shortLabel).toBe("Ag Argon 7天");
      setCopyLocale("en");
      expect(item.label).toBe("Antigravity Argon 7d Limit");
    } finally {
      setCopyLocale("en");
    }
  });
  it("keeps the default Token + Cost display when no valid selection exists", () => {
    expect(normalizeMenuBarItems(null)).toEqual(DEFAULT_MENU_BAR_ITEMS);
    expect(normalizeMenuBarItems(["unknown"])).toEqual(DEFAULT_MENU_BAR_ITEMS);
  });

  it("deduplicates, filters unknown ids, and preserves order", () => {
    expect(normalizeMenuBarItems(["claude7d", "todayCost", "claude7d", "missing"])).toEqual([
      "claude7d",
      "todayCost",
    ]);
  });

  it("keeps Codex Spark selections when the native bridge has not provided items", () => {
    expect(normalizeMenuBarItems(["codexSpark5h", "codexSpark7d"])).toEqual([
      "codexSpark5h",
      "codexSpark7d",
    ]);
  });

  it("caps selections to the native menu bar width limit", () => {
    const ids = FALLBACK_MENU_BAR_ITEMS.map((item) => item.id);
    expect(normalizeMenuBarItems(ids, FALLBACK_MENU_BAR_ITEMS, 3)).toEqual(ids.slice(0, 3));
  });

  it("keeps the 'none' sentinel in either slot and allows it in both (issue 379)", () => {
    expect(normalizeMenuBarItems(["claude5h", MENU_BAR_NONE_ID])).toEqual([
      "claude5h",
      MENU_BAR_NONE_ID,
    ]);
    expect(normalizeMenuBarItems([MENU_BAR_NONE_ID, MENU_BAR_NONE_ID])).toEqual([
      MENU_BAR_NONE_ID,
      MENU_BAR_NONE_ID,
    ]);
  });
});
