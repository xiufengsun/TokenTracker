import { describe, expect, it } from "vitest";
import { aggregateSessionPerformance, overlapsSessionDates, parseSessionFilters, scopeSessionsToRange, sessionModels, sortSessions, summarizeSessions } from "./sessions-insights";

describe("session statistics", () => {
  it("scopes cross-day tokens, cost and descendant totals using local calendar boundaries", () => {
    const rows = [{ session_hash: "parent", own_total_tokens: 180, total_tokens: 180,
      usage_buckets: [{ timestamp: "2026-10-09T15:30:00Z", model: "gpt-5.4", total_tokens: 120, cost_usd: .12 },
        { timestamp: "2026-10-09T16:30:00Z", model: "gpt-5.4", total_tokens: 60, cost_usd: .06 }] },
      { session_hash: "child", parent_session_hash: "parent", own_total_tokens: 30,
        usage_buckets: [{ timestamp: "2026-10-09T16:30:00Z", model: "gpt-5.4", total_tokens: 30, cost_usd: .03 }] }];
    const scoped = scopeSessionsToRange(rows, Date.parse("2026-10-10T00:00:00+08:00"), Date.parse("2026-10-10T23:59:59+08:00"));
    expect(summarizeSessions(scoped)).toMatchObject({ tokens: 90, cost: .09 });
    expect(scoped[0]).toMatchObject({ own_total_tokens: 60, combined_total_tokens: 90, subagent_total_tokens: 30 });
    expect(rows[0].own_total_tokens).toBe(180);
    expect(scopeSessionsToRange(rows)).toBe(rows);
  });
  it("counts own consumption once when roots contain combined descendant totals", () => {
    const root = { session_hash: "root", total_tokens: 1500, own_total_tokens: 1000, combined_total_tokens: 1500, cost_usd: 1.5, own_cost_usd: 1 };
    const child = { session_hash: "child", own_total_tokens: 500, combined_total_tokens: 600, own_cost_usd: 0.5, cost_is_partial: true };
    expect(summarizeSessions([root, child, child])).toMatchObject({ count: 2, tokens: 1500, cost: 1.5, costIsPartial: true });
    expect(summarizeSessions([{ session_hash: "old", total_tokens: 100, cost_usd: 0.2 }])).toMatchObject({ count: 1, tokens: 100, cost: 0.2 });
  });

  it("weights speed by timed output and duration and ignores unrelated API duration", () => {
    const performance = aggregateSessionPerformance([
      { performance: { estimated_output_tokens: 100, estimated_duration_ms: 1000, estimated_request_count: 1, estimated_tokens_per_second: 100, first_response_total_ms: 1000, first_response_sample_count: 1 } },
      { performance: { estimated_output_tokens: 100, estimated_duration_ms: 9000, estimated_request_count: 2, estimated_tokens_per_second: 11.11, first_response_total_ms: 5000, first_response_sample_count: 2 } },
      { source: "grok", output_tokens: 10000, api_duration_ms: 1000 },
      { performance: { estimated_output_tokens: 100, estimated_duration_ms: 0, estimated_request_count: 1 } },
    ]);
    expect(performance).toMatchObject({ estimated_output_tokens: 200, estimated_duration_ms: 10000, estimated_request_count: 3, estimated_tokens_per_second: 20, first_response_ms: 2000, first_response_sample_count: 3 });
  });

  it("retains zero own values and supports old servers without model rows", () => {
    expect(sessionModels({ model: "old", own_total_tokens: 0, total_tokens: 1000, own_cost_usd: 0, cost_usd: 10 })).toEqual([{ model: "old", total_tokens: 0, cost_usd: 0, performance: undefined }]);
  });

  it("parses supported deep link filters and rejects invalid calendar dates", () => {
    expect(parseSessionFilters("?source=codex&model=gpt-5.6-sol&from=2026-07-01&to=2026-07-31")).toEqual({ source: "codex", model: "gpt-5.6-sol", from: "2026-07-01", to: "2026-07-31" });
    expect(parseSessionFilters("?source=other&from=2026-02-30&to=wrong")).toEqual({ source: "all", model: "all", from: "", to: "" });
  });

  it("selects overlapping sessions at both local date boundaries", () => {
    const localTime = (date) => new Date(date).toISOString();
    const spanning = { started_at: localTime("2026-07-20T12:00:00"), ended_at: localTime("2026-07-24T00:00:00") };
    expect(overlapsSessionDates(spanning, "2026-07-24", "2026-07-24")).toBe(true);
    expect(overlapsSessionDates({ started_at: localTime("2026-07-25T00:00:00"), ended_at: localTime("2026-07-25T01:00:00") }, "2026-07-24", "2026-07-24")).toBe(false);
    expect(overlapsSessionDates(spanning, "2026-07-25", "2026-07-24")).toBe(true);
  });

  it("sorts by own cost and tokens with recent activity as the tie break", () => {
    const rows = [
      { session_hash: "recent", cost_usd: 1, total_tokens: 50, ended_at: "2026-07-24T08:00:00Z" },
      { session_hash: "expensive", cost_usd: 10, total_tokens: 10, ended_at: "2026-07-23T08:00:00Z" },
      { session_hash: "large", cost_usd: 2, total_tokens: 100, ended_at: "2026-07-22T08:00:00Z" },
    ];
    expect(sortSessions(rows, "recent").map((row) => row.session_hash)).toEqual(["recent", "expensive", "large"]);
    expect(sortSessions(rows, "cost").map((row) => row.session_hash)).toEqual(["expensive", "large", "recent"]);
    expect(sortSessions(rows, "tokens").map((row) => row.session_hash)).toEqual(["large", "recent", "expensive"]);
    expect(rows[0].session_hash).toBe("recent");
  });
});
