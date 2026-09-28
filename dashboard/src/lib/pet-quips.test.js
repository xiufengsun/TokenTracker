import { describe, expect, it } from "vitest";
import { getCopyLocale, setCopyLocale } from "./copy";
import { ZH_CN_LOCALE } from "./locale";
import {
  buildPetLimitSummary,
  buildPetLimitSummaries,
  buildQuipPool,
  formatPetLimitSummary,
} from "./pet-quips.js";

describe("desktop pet limit dialogue", () => {
  it("lists every used provider window that is not full", () => {
    const limits = {
      claude: {
        configured: true,
        error: null,
        five_hour: { utilization: 61, resets_at: "2099-01-01T00:00:00Z" },
      },
      codex: {
        configured: true,
        error: null,
        primary_window: { used_percent: 87, reset_at: 4102444800 },
      },
      cursor: {
        configured: true,
        error: null,
        primary_window: { used_percent: 0, reset_at: 4102444800 },
        tertiary_window: { used_percent: 100, reset_at: 4102444800 },
      },
    };

    const readings = buildPetLimitSummaries(limits);
    expect(readings.map(({ provider, window }) => `${provider} ${window}`)).toEqual([
      "Codex 5h",
      "Claude 5h",
    ]);

    const reading = buildPetLimitSummary(limits);

    expect(reading).toMatchObject({ provider: "Codex", window: "5h", usedPercent: 87 });
    expect(formatPetLimitSummary("zh-CN", reading)).toContain("Codex 5h · 接近上限");
    expect(formatPetLimitSummary("en", reading)).toContain(" · in ");
    expect(formatPetLimitSummary("en", reading)).not.toContain("↻");
    const atLimit = formatPetLimitSummary("en", { ...reading, usedPercent: 100 });
    expect(atLimit).toContain("Codex 5h · at limit");
    expect(atLimit).not.toMatch(/\d+%/);
  });

  it("names ZCode windows by plan kind and start-plan bucket labels", () => {
    const zcodeStart = {
      configured: true,
      error: null,
      plan_kind: "start-plan",
      primary_window: { used_percent: 40, reset_at: "2099-01-01T00:00:00Z" },
      buckets: [
        { label: "GLM-5.3", window: { used_percent: 40, reset_at: "2099-01-01T00:00:00Z" } },
        { label: "GLM-5.3-Flash · ZCode Weekend Build", window: { used_percent: 20, reset_at: "2099-01-03T00:00:00Z" } },
      ],
    };
    expect(buildPetLimitSummaries({ zcode: zcodeStart }).map(({ window }) => window)).toEqual([
      "GLM-5.3",
      "GLM-5.3-Flash · ZCode Weekend Build",
    ]);

    const zcodeCoding = {
      configured: true,
      error: null,
      plan_kind: "coding-plan",
      primary_window: { used_percent: 30, reset_at: "2099-01-01T00:00:00Z" },
    };
    expect(buildPetLimitSummaries({ zcode: zcodeCoding }).map(({ window }) => window)).toEqual(["5h"]);
  });

  it("surfaces Command Code 5h/weekly windows when they are partially used", () => {
    const limits = {
      commandCode: {
        configured: true,
        error: null,
        primary_window: { used_percent: 42, reset_at: "2099-01-01T00:00:00Z" },
        secondary_window: { used_percent: 3, reset_at: "2099-01-02T00:00:00Z" },
      },
      // A configured-but-empty provider contributes no pet line.
      opencodeGo: { configured: true, error: null, primary_window: { used_percent: 0, reset_at: 0 } },
    };

    const readings = buildPetLimitSummaries(limits);
    expect(readings.map(({ provider, window }) => `${provider} ${window}`)).toEqual([
      "Command Code 5h",
      "Command Code Weekly",
    ]);
  });

  it("resolves Command Code labels through the copy registry per locale (review 594)", () => {
    const prevLocale = getCopyLocale();
    try {
      setCopyLocale(ZH_CN_LOCALE);
      const limits = {
        commandCode: {
          configured: true,
          error: null,
          primary_window: { used_percent: 42, reset_at: "2099-01-01T00:00:00Z" },
          secondary_window: { used_percent: 3, reset_at: "2099-01-02T00:00:00Z" },
        },
      };

      const readings = buildPetLimitSummaries(limits);
      // The provider name stays the brand; the weekly window must come from
      // the zh-CN registry (每周), not a hardcoded English literal.
      expect(readings.map(({ provider, window }) => `${provider} ${window}`)).toEqual([
        "Command Code 5h",
        "Command Code 每周",
      ]);
    } finally {
      setCopyLocale(prevLocale);
    }
  });

  it("surfaces Devin daily/weekly windows with localized labels", () => {
    const prevLocale = getCopyLocale();
    try {
      setCopyLocale(ZH_CN_LOCALE);
      const limits = {
        devin: {
          configured: true,
          error: null,
          primary_window: { used_percent: 60, reset_at: "2099-01-01T00:00:00Z" },
          secondary_window: { used_percent: 10, reset_at: "2099-01-02T00:00:00Z" },
        },
      };

      const readings = buildPetLimitSummaries(limits);
      expect(readings.map(({ provider, window }) => `${provider} ${window}`)).toEqual([
        "Devin 每日",
        "Devin 每周",
      ]);
    } finally {
      setCopyLocale(prevLocale);
    }
  });

  it("adds the limit line to the tap conversation without replacing token quips", () => {
    const pool = buildQuipPool("en", {
      tokens: 1200,
      tokensText: "1.2K",
      costText: "$0.12",
      costValue: 0.12,
      limitText: "Codex 5h · near limit · in 2h",
    });

    expect(pool).toContain("Codex 5h · near limit · in 2h");
    expect(pool.some((line) => line.includes("1.2K"))).toBe(true);
  });
});
