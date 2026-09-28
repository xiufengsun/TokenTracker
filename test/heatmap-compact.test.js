"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { expandHeatmapCompact } = require("../src/lib/heatmap-compact");

// Shape returned by tokentracker-account-heatmap with `format=compact`.
// Model names live once in `model_names`; each day carries flat
// [index, tokens, index, tokens, ...] pairs into it.
function compactPayload(overrides = {}) {
  return {
    format: "compact",
    from: "2026-09-01",
    to: "2026-09-14",
    week_starts_on: "sun",
    active_days: 2,
    streak_days: 0,
    max_value: 400,
    model_names: ["claude-opus-4-6", "gpt-5.4"],
    days: [
      ["2026-09-02", 100, [0, 100]],
      ["2026-09-10", 400, [1, 300, 0, 100]],
    ],
    ...overrides,
  };
}

test("expands the sparse days into a dense grid of whole weeks", () => {
  const out = expandHeatmapCompact(compactPayload());
  assert.equal(out.weeks.length, 2);
  for (const week of out.weeks) assert.equal(week.length, 7);
  const days = out.weeks.flat().map((c) => c.day);
  assert.equal(days[0], "2026-09-01");
  assert.equal(days[days.length - 1], "2026-09-14");
  assert.equal(new Set(days).size, 14, "no duplicated or skipped day");
});

test("carries the scalars through untouched rather than recomputing them", () => {
  const out = expandHeatmapCompact(
    // Deliberately inconsistent with `days` so a recompute would be visible.
    compactPayload({ active_days: 99, streak_days: 7, week_starts_on: "mon" }),
  );
  assert.equal(out.active_days, 99);
  assert.equal(out.streak_days, 7);
  assert.equal(out.week_starts_on, "mon");
  assert.equal(out.from, "2026-09-01");
  assert.equal(out.to, "2026-09-14");
  assert.ok(!("format" in out), "the wire-format marker must not leak into the rendered payload");
  assert.ok(!("days" in out), "the compact array must not leak into the rendered payload");
  assert.ok(!("max_value" in out), "max_value is an input to level, not part of the schema");
  assert.ok(!("model_names" in out), "the dictionary must not leak into the rendered payload");
});

test("a day with no row reads as zero tokens and null models", () => {
  const cells = expandHeatmapCompact(compactPayload()).weeks.flat();
  const blank = cells.find((c) => c.day === "2026-09-03");
  assert.deepEqual(blank, {
    day: "2026-09-03",
    total_tokens: 0,
    billable_total_tokens: 0,
    level: 0,
    models: null,
  });
});

test("a day with no model pairs keeps an empty object, not null", () => {
  // Mirrors the edge: a row present in byDay always gets `mdl` ({} when the RPC
  // folded no model), and `{}` is truthy so `data?.models || null` keeps it.
  const out = expandHeatmapCompact(
    compactPayload({ days: [["2026-09-02", 100, []]], max_value: 100 }),
  );
  const cell = out.weeks.flat().find((c) => c.day === "2026-09-02");
  assert.deepEqual(cell.models, {});
  assert.equal(cell.total_tokens, 100);
});

test("level buckets match the edge thresholds at 0.25 / 0.5 / 0.75", () => {
  const out = expandHeatmapCompact(
    compactPayload({
      from: "2026-09-01",
      to: "2026-09-07",
      max_value: 400,
      days: [
        ["2026-09-01", 0, []], // 0 tokens -> level 0 even though the row exists
        ["2026-09-02", 100, []], // ratio 0.25 -> 1 (inclusive upper bound)
        ["2026-09-03", 101, []], // just over 0.25 -> 2
        ["2026-09-04", 200, []], // 0.5 -> 2
        ["2026-09-05", 201, []], // -> 3
        ["2026-09-06", 300, []], // 0.75 -> 3
        ["2026-09-07", 400, []], // 1.0 -> 4
      ],
    }),
  );
  assert.deepEqual(
    out.weeks.flat().map((c) => c.level),
    [0, 1, 2, 2, 3, 3, 4],
  );
});

test("every positive day is level 1 when max_value is missing or zero", () => {
  const out = expandHeatmapCompact(
    compactPayload({
      from: "2026-09-01",
      to: "2026-09-07",
      max_value: 0,
      days: [["2026-09-02", 100, []]],
    }),
  );
  const cell = out.weeks.flat().find((c) => c.day === "2026-09-02");
  assert.equal(cell.level, 1);
});

test("numeric strings from the RPC are coerced the way the edge coerced them", () => {
  const out = expandHeatmapCompact(
    compactPayload({
      days: [["2026-09-02", "250", [1, "250"]]],
      max_value: "500",
    }),
  );
  const cell = out.weeks.flat().find((c) => c.day === "2026-09-02");
  assert.equal(cell.total_tokens, 250);
  assert.equal(cell.billable_total_tokens, 250);
  assert.deepEqual(cell.models, { "gpt-5.4": 250 });
  assert.equal(cell.level, 2, "250/500 = 0.5 -> level 2");
});

test("the last row wins when the RPC repeats a day", () => {
  const out = expandHeatmapCompact(
    compactPayload({
      days: [
        ["2026-09-02", 100, [0, 100]],
        ["2026-09-02", 400, [1, 400]],
      ],
      max_value: 400,
    }),
  );
  const cell = out.weeks.flat().find((c) => c.day === "2026-09-02");
  assert.equal(cell.total_tokens, 400);
  assert.deepEqual(cell.models, { "gpt-5.4": 400 });
});

test("a day outside the from..to grid is dropped, as the edge grid dropped it", () => {
  const out = expandHeatmapCompact(
    compactPayload({ days: [["2026-08-20", 999, []], ["2026-09-02", 100, []]], max_value: 999 }),
  );
  const days = out.weeks.flat().map((c) => c.day);
  assert.ok(!days.includes("2026-08-20"));
  assert.equal(out.weeks.flat().length, 14);
});

test("a legacy (non-compact) payload is returned untouched", () => {
  const legacy = {
    from: "2026-09-01",
    to: "2026-09-14",
    week_starts_on: "sun",
    active_days: 2,
    streak_days: 0,
    weeks: [[{ day: "2026-09-01", total_tokens: 0, billable_total_tokens: 0, level: 0, models: null }]],
  };
  assert.equal(expandHeatmapCompact(legacy), legacy, "same object reference, no copy");
});

test("malformed compact payloads fall back to the payload as-is", () => {
  for (const bad of [
    null,
    undefined,
    42,
    "nope",
    { format: "compact" },
    { format: "compact", days: [], from: "x" },
    // A compact payload without its dictionary cannot be resolved; rendering it
    // would silently drop every model breakdown, so it is refused instead.
    { format: "compact", from: "2026-09-01", to: "2026-09-07", days: [] },
  ]) {
    assert.equal(expandHeatmapCompact(bad), bad);
  }
});

test("model names are resolved through the shared dictionary", () => {
  const out = expandHeatmapCompact(compactPayload());
  const cells = out.weeks.flat();
  assert.deepEqual(cells.find((c) => c.day === "2026-09-02").models, { "claude-opus-4-6": 100 });
  assert.deepEqual(cells.find((c) => c.day === "2026-09-10").models, {
    "gpt-5.4": 300,
    "claude-opus-4-6": 100,
  });
});

test("an index with no dictionary entry is dropped rather than rendered as undefined", () => {
  const out = expandHeatmapCompact(
    compactPayload({ days: [["2026-09-02", 100, [0, 60, 9, 40]]], max_value: 100 }),
  );
  assert.deepEqual(out.weeks.flat().find((c) => c.day === "2026-09-02").models, {
    "claude-opus-4-6": 60,
  });
});

test("a trailing index with no value is ignored", () => {
  const out = expandHeatmapCompact(
    compactPayload({ days: [["2026-09-02", 100, [0, 100, 1]]], max_value: 100 }),
  );
  assert.deepEqual(out.weeks.flat().find((c) => c.day === "2026-09-02").models, {
    "claude-opus-4-6": 100,
  });
});

test("repeating a model index within one day sums nothing — last pair wins", () => {
  // The edge folds per (day, model) in Postgres, so a repeat should not happen;
  // pinning the behaviour keeps a future regression from silently doubling.
  const out = expandHeatmapCompact(
    compactPayload({ days: [["2026-09-02", 100, [0, 60, 0, 100]]], max_value: 100 }),
  );
  assert.deepEqual(out.weeks.flat().find((c) => c.day === "2026-09-02").models, {
    "claude-opus-4-6": 100,
  });
});
