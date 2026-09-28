import { beforeEach, describe, expect, it } from "vitest";
import {
  TOKEN_FORMAT_MODES,
  TOKEN_UNIT_SYSTEMS,
  formatTokenCount,
  formatTokenTooltip,
  migrateLegacyChineseTokenFormat,
  normalizeTokenFormatMode,
  normalizeTokenUnitSystem,
  readTokenUnitSystem,
} from "./token-format";

function createStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
  };
}

describe("token number formatting", () => {
  it("uses compact K/M/B/T output by default", () => {
    expect(formatTokenCount(12_345)).toBe("12.3K");
    expect(formatTokenCount(12_345_678)).toBe("12.3M");
    expect(formatTokenCount(12_345_678_901)).toBe("12.3B");
    expect(formatTokenCount(84_663_300_000_000)).toBe("84.7T");
  });

  it("passes a localized trillion suffix through", () => {
    expect(formatTokenCount(84_663_300_000_000, { trillionSuffix: "Bio." })).toBe("84.7Bio.");
  });

  it("returns grouped exact digits in full mode or forced-full locations", () => {
    expect(formatTokenCount(12_345_678, { mode: TOKEN_FORMAT_MODES.FULL })).toBe("12,345,678");
    expect(formatTokenCount(12_345_678, { forceFull: true })).toBe("12,345,678");
  });

  it("supports Chinese Wan/Yi units through the unit system option", () => {
    expect(formatTokenCount(12_345, { unitSystem: TOKEN_UNIT_SYSTEMS.CHINESE })).toBe("1.2万");
    expect(formatTokenCount(12_345_678, { unitSystem: TOKEN_UNIT_SYSTEMS.CHINESE })).toBe("1234.6万");
    expect(formatTokenCount(123_456_789, { unitSystem: TOKEN_UNIT_SYSTEMS.CHINESE })).toBe("1.2亿");
    expect(formatTokenCount(1_234_567_890_123, { unitSystem: TOKEN_UNIT_SYSTEMS.CHINESE })).toBe(
      "1.2万亿",
    );
  });

  it("ignores the unit system in full mode", () => {
    expect(
      formatTokenCount(12_345, {
        mode: TOKEN_FORMAT_MODES.FULL,
        unitSystem: TOKEN_UNIT_SYSTEMS.CHINESE,
      }),
    ).toBe("12,345");
  });

  it("keeps compact and exact values together in hover text", () => {
    expect(formatTokenTooltip(12_345_678)).toBe("12.3M · 12,345,678");
    expect(formatTokenTooltip(999)).toBe("999");
  });

  it("shows compact Chinese units with the exact number in hover text", () => {
    expect(formatTokenTooltip(12_345, { unitSystem: TOKEN_UNIT_SYSTEMS.CHINESE })).toBe(
      "1.2万 · 12,345",
    );
  });

  it("normalizes unknown persisted values to compact", () => {
    expect(normalizeTokenFormatMode("other")).toBe(TOKEN_FORMAT_MODES.COMPACT);
  });

  it("maps the legacy chinese mode value onto compact", () => {
    expect(normalizeTokenFormatMode("chinese")).toBe(TOKEN_FORMAT_MODES.COMPACT);
    expect(formatTokenCount(12_345, { mode: "chinese" })).toBe("1.2万");
  });

  it("round-trips every known display mode and unit system", () => {
    for (const mode of Object.values(TOKEN_FORMAT_MODES)) {
      expect(normalizeTokenFormatMode(mode)).toBe(mode);
    }
    for (const unitSystem of Object.values(TOKEN_UNIT_SYSTEMS)) {
      expect(normalizeTokenUnitSystem(unitSystem)).toBe(unitSystem);
    }
    expect(normalizeTokenUnitSystem("other")).toBe(TOKEN_UNIT_SYSTEMS.ENGLISH);
  });
});

describe("token unit system persistence", () => {
  let storage;

  beforeEach(() => {
    storage = createStorage();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
  });

  it("falls back to english when nothing is stored", () => {
    expect(readTokenUnitSystem()).toBe(TOKEN_UNIT_SYSTEMS.ENGLISH);
  });

  it("reads the stored unit system", () => {
    storage.store["tt.tokenUnitSystem"] = "chinese";
    expect(readTokenUnitSystem()).toBe(TOKEN_UNIT_SYSTEMS.CHINESE);
  });

  it("treats unknown stored values as english", () => {
    storage.store["tt.tokenUnitSystem"] = "bogus";
    expect(readTokenUnitSystem()).toBe(TOKEN_UNIT_SYSTEMS.ENGLISH);
  });

  it("migrates the legacy chinese mode onto compact + chinese units", () => {
    storage.store["tt.tokenFormat"] = "chinese";
    expect(migrateLegacyChineseTokenFormat()).toBe(true);
    expect(storage.store["tt.tokenFormat"]).toBe("compact");
    expect(storage.store["tt.tokenUnitSystem"]).toBe("chinese");
    expect(readTokenUnitSystem()).toBe(TOKEN_UNIT_SYSTEMS.CHINESE);
  });

  it("leaves non-legacy storage untouched", () => {
    storage.store["tt.tokenFormat"] = "full";
    expect(migrateLegacyChineseTokenFormat()).toBe(false);
    expect(storage.store["tt.tokenFormat"]).toBe("full");
  });
});

it("preserves the legacy preference if writing the unit system fails", () => {
  const values = { "tt.tokenFormat": "chinese" };
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { if (key === "tt.tokenUnitSystem") throw new Error("quota"); values[key] = value; },
  } });
  expect(migrateLegacyChineseTokenFormat()).toBe(false);
  expect(readTokenUnitSystem()).toBe("chinese");
  expect(values["tt.tokenFormat"]).toBe("chinese");
});
