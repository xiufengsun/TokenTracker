import { describe, expect, it } from "vitest";
import { buildAllModels, buildFleetData, buildTopModels } from "./model-breakdown";

describe("buildFleetData", () => {
  it("keeps two decimal places for small provider percentages", () => {
    const fleet = buildFleetData({
      sources: [
        {
          source: "claude",
          totals: { billable_total_tokens: 999_600 },
          models: [{ model_id: "claude-sonnet", totals: { billable_total_tokens: 999_600 } }],
        },
        {
          source: "antigravity",
          totals: { billable_total_tokens: 400 },
          models: [{ model_id: "gemini-pro", totals: { billable_total_tokens: 400 } }],
        },
        {
          source: "grok",
          totals: { billable_total_tokens: 1 },
          models: [{ model_id: "grok-code", totals: { billable_total_tokens: 1 } }],
        },
      ],
    });

    expect(fleet.map(({ source, totalPercent }) => [source, totalPercent])).toEqual([
      ["claude", "99.96"],
      ["antigravity", "0.04"],
      ["grok", "0.00"],
    ]);
    expect(fleet[2].totalPercentValue).toBeGreaterThan(0);
    expect(fleet[2].totalPercentValue).toBeLessThan(0.01);
  });

  it("folds the deprecated deepseek source alias into dsh and merges models", () => {
    const fleet = buildFleetData({
      sources: [
        {
          source: "deepseek",
          totals: { billable_total_tokens: 100, total_cost_usd: "1.00" },
          models: [
            { model_id: "deepseek-v4-pro", totals: { billable_total_tokens: 70 } },
            { model_id: "deepseek-v4-flash", totals: { billable_total_tokens: 30 } },
          ],
        },
        {
          source: "dsh",
          totals: { billable_total_tokens: 400, total_cost_usd: "4.00" },
          models: [
            { model_id: "deepseek-v4-pro", totals: { billable_total_tokens: 300 } },
            { model_id: "deepseek-v4-flash", totals: { billable_total_tokens: 100 } },
          ],
        },
      ],
    });

    expect(fleet.map(({ source }) => source)).toEqual(["dsh"]);
    expect(fleet[0].usage).toBe(500);
    expect(fleet[0].usd).toBe(5);
    const byId = Object.fromEntries(fleet[0].models.map((m: any) => [m.id, m.usage]));
    expect(byId).toEqual({ "deepseek-v4-pro": 370, "deepseek-v4-flash": 130 });
  });

  it("ignores malformed non-array model collections while preserving source totals", () => {
    expect(() => buildFleetData({
      sources: [{
        source: "dsh",
        totals: { billable_total_tokens: 42 },
        models: { model_id: "not-an-array" },
      }],
    })).not.toThrow();
  });

  it("uses raw AStudio service IDs as model display names", () => {
    const response = {
      sources: [
        {
          source: "acode",
          totals: { billable_total_tokens: 150 },
          models: [
            {
              model: "xopdeepseekv4flash0731",
              model_id: "xopdeepseekv4flash0731",
              totals: { billable_total_tokens: 100 },
            },
            {
              model: "xopglm52",
              model_id: "xopglm52",
              totals: { billable_total_tokens: 40 },
            },
            {
              model: "custom-service-id",
              model_id: "custom-service-id",
              totals: { billable_total_tokens: 10 },
            },
          ],
        },
        {
          source: "codex",
          totals: { billable_total_tokens: 5 },
          models: [
            {
              model: "xopglm52",
              model_id: "xopglm52",
              totals: { billable_total_tokens: 5 },
            },
          ],
        },
      ],
    };

    const fleet = buildFleetData(response);
    expect(fleet[0].models.map(({ id, name }: any) => ({ id, name }))).toEqual([
      { id: "xopdeepseekv4flash0731", name: "xopdeepseekv4flash0731" },
      { id: "xopglm52", name: "xopglm52" },
      { id: "custom-service-id", name: "custom-service-id" },
    ]);
    expect(fleet[1].models[0]).toMatchObject({ id: "xopglm52", name: "xopglm52" });
    expect(buildTopModels(response, { limit: 4 }).map(({ name }: any) => name)).toEqual([
      "xopdeepseekv4flash0731",
      "xopglm52",
      "custom-service-id",
    ]);
  });
});

describe("buildAllModels", () => {
  it("combines the same model across tools and ranks every personal model", () => {
    const models = buildAllModels([
      {
        label: "CODEX",
        models: [
          { id: "gpt-5.6", name: "GPT-5.6", usage: 70, cost: 0.7 },
          { id: "gpt-5.5", name: "gpt-5.5", usage: 20, cost: 0.2 },
        ],
      },
      {
        label: "CURSOR",
        models: [
          { id: "gpt-5.6", name: "gpt-5.6", usage: 30, cost: 0.3 },
          { id: "claude", name: "claude-sonnet", usage: 80, cost: null },
        ],
      },
    ]);

    expect(models).toEqual([
      { id: "gpt-5.6", name: "GPT-5.6", usage: 100, cost: 1, share: 50 },
      { id: "claude-sonnet", name: "claude-sonnet", usage: 80, cost: null, share: 40 },
      { id: "gpt-5.5", name: "gpt-5.5", usage: 20, cost: 0.2, share: 10 },
    ]);
  });
});
