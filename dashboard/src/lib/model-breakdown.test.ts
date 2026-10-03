import { describe, expect, it } from "vitest";
import {
  buildAllModels,
  buildFleetData,
  buildTopModels,
  hasModelTokenSplits,
  modelTokenSplitsTotal,
} from "./model-breakdown";

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

describe("modelTokenSplitsTotal / hasModelTokenSplits", () => {
  it("sums splits and reports expandability", () => {
    expect(modelTokenSplitsTotal(undefined)).toBe(0);
    expect(modelTokenSplitsTotal({})).toBe(0);
    expect(
      modelTokenSplitsTotal({ input: 10, output: 5, cached: 0, cacheCreate: 0, reasoning: 0 }),
    ).toBe(15);
    expect(hasModelTokenSplits({ tokens: { input: 1 } })).toBe(true);
    expect(hasModelTokenSplits({})).toBe(false);
    expect(hasModelTokenSplits(null)).toBe(false);
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
      {
        id: "gpt-5.6",
        name: "GPT-5.6",
        usage: 100,
        cost: 1,
        tokens: { input: 0, output: 0, cached: 0, cacheCreate: 0, reasoning: 0 },
        share: 50,
      },
      {
        id: "claude-sonnet",
        name: "claude-sonnet",
        usage: 80,
        cost: null,
        tokens: { input: 0, output: 0, cached: 0, cacheCreate: 0, reasoning: 0 },
        share: 40,
      },
      {
        id: "gpt-5.5",
        name: "gpt-5.5",
        usage: 20,
        cost: 0.2,
        tokens: { input: 0, output: 0, cached: 0, cacheCreate: 0, reasoning: 0 },
        share: 10,
      },
    ]);
  });

  it("combines per-model token-type splits across tools", () => {
    const models = buildAllModels([
      {
        label: "CODEX",
        models: [
          {
            id: "gpt-5.6",
            name: "gpt-5.6",
            usage: 100,
            cost: 1,
            tokens: { input: 10, output: 5, cached: 80, cacheCreate: 4, reasoning: 1 },
          },
        ],
      },
      {
        label: "CURSOR",
        models: [
          {
            id: "gpt-5.6",
            name: "gpt-5.6",
            usage: 50,
            cost: 0.5,
            tokens: { input: 20, output: 10, cached: 15, cacheCreate: 5, reasoning: 0 },
          },
        ],
      },
    ]);

    expect(models).toEqual([
      {
        id: "gpt-5.6",
        name: "gpt-5.6",
        usage: 150,
        cost: 1.5,
        tokens: { input: 30, output: 15, cached: 95, cacheCreate: 9, reasoning: 1 },
        share: 100,
      },
    ]);
  });

  it("carries API token totals through buildFleetData provider models", () => {
    const fleet = buildFleetData({
      sources: [
        {
          source: "opencode",
          totals: { billable_total_tokens: 300 },
          models: [
            {
              model_id: "gpt-6.1-sol-fast",
              totals: {
                billable_total_tokens: 300,
                input_tokens: 100,
                output_tokens: 20,
                cached_input_tokens: 170,
                cache_creation_input_tokens: 5,
                reasoning_output_tokens: 5,
              },
            },
          ],
        },
      ],
    });

    expect(fleet[0].models).toEqual([
      {
        id: "gpt-6.1-sol-fast",
        name: "gpt-6.1-sol-fast",
        share: 100,
        usage: 300,
        cost: 0,
        tokens: { input: 100, output: 20, cached: 170, cacheCreate: 5, reasoning: 5 },
      },
    ]);
  });
});
