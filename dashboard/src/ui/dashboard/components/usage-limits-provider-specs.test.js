import { describe, expect, it } from "vitest";
import { PROVIDER_LIMIT_SPECS } from "./usage-limits-provider-specs.js";

describe("PROVIDER_LIMIT_SPECS.antigravity", () => {
  it("lists 5h above 7d per model group while keeping each label on its own slot", () => {
    const data = {
      primary_window: { used_percent: 89 }, // 3p-weekly
      secondary_window: { used_percent: 0 }, // 3p-5h
      tertiary_window: { used_percent: 26 }, // gemini-weekly
      quaternary_window: { used_percent: 100 }, // gemini-5h
    };
    const rows = PROVIDER_LIMIT_SPECS.antigravity
      .windows(data)
      .map(({ key, labelKey, window }) => [key, labelKey, window.used_percent]);
    expect(rows).toEqual([
      ["claude-5h", "limits.label.antigravity_claude_5h", 0],
      ["claude-weekly", "limits.label.antigravity_claude_weekly", 89],
      ["gemini-5h", "limits.label.antigravity_gemini_5h", 100],
      ["gemini-weekly", "limits.label.antigravity_gemini_weekly", 26],
    ]);
  });
});
