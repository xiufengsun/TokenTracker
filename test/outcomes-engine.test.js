"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  sanitizeOutcome,
  readOutcomesData,
  computeQualityPerDollar,
  resolveOutcomesPath,
} = require("../src/lib/outcomes-engine");
const { computeRowCost } = require("../src/lib/pricing");

function tmpFile(contents) {
  const p = path.join(
    os.tmpdir(),
    `tt-outcomes-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  fs.writeFileSync(p, contents, "utf8");
  return p;
}

test("resolveOutcomesPath points at the sidecar, never queue.jsonl", () => {
  const p = resolveOutcomesPath();
  assert.ok(p.endsWith(path.join(".tokentracker", "tracker", "outcomes.jsonl")));
  assert.ok(!p.includes("queue.jsonl"));
});

test("readOutcomesData returns [] for a missing file (degrades to cost-only)", () => {
  const missing = path.join(os.tmpdir(), `tt-nope-${Math.random().toString(36).slice(2)}.jsonl`);
  assert.deepStrictEqual(readOutcomesData(missing), []);
});

test("sanitizeOutcome enforces the metadata-only privacy invariant", () => {
  const rec = sanitizeOutcome({
    timestamp: "2026-06-30T12:00:00Z",
    model: "claude-opus-4-8",
    tool: "claude",
    accepted: true,
    task_type: "feature",
    // Everything below MUST be dropped — never surfaced to the dashboard.
    pr_body: "secret PR description",
    diff: "- old\n+ new",
    message: "commit message text",
    prompt: "the user's private prompt",
  });
  assert.deepStrictEqual(Object.keys(rec).sort(), ["accepted", "model", "task_type", "timestamp", "tool"]);
  const blob = JSON.stringify(rec);
  for (const leak of ["secret", "old", "commit message", "private prompt"]) {
    assert.ok(!blob.includes(leak), `leaked: ${leak}`);
  }
});

test("sanitizeOutcome: accepted is strictly boolean true", () => {
  assert.strictEqual(sanitizeOutcome({ timestamp: "t", accepted: true }).accepted, true);
  for (const v of ["true", 1, "yes", {}, null, undefined]) {
    assert.strictEqual(sanitizeOutcome({ timestamp: "t", accepted: v }).accepted, false);
  }
});

test("sanitizeOutcome: drops records with no timestamp (can't join to $)", () => {
  assert.strictEqual(sanitizeOutcome({ model: "x", accepted: true }), null);
  assert.strictEqual(sanitizeOutcome(null), null);
  assert.strictEqual(sanitizeOutcome([]), null);
});

test("sanitizeOutcome: tool falls back to source, then 'unknown'", () => {
  assert.strictEqual(sanitizeOutcome({ timestamp: "t", source: "codex" }).tool, "codex");
  assert.strictEqual(sanitizeOutcome({ timestamp: "t" }).tool, "unknown");
  assert.strictEqual(sanitizeOutcome({ timestamp: "t" }).model, "unknown");
});

test("readOutcomesData parses jsonl, skips malformed, strips free-text", () => {
  const p = tmpFile(
    [
      JSON.stringify({ timestamp: "2026-06-30T10:00:00Z", model: "kimi-k2.6", tool: "opencode", accepted: true, diff: "SHOULD_NOT_APPEAR" }),
      "{ this is not json",
      JSON.stringify({ model: "no-timestamp", accepted: true }), // dropped
      "",
      JSON.stringify({ timestamp: "2026-06-30T11:00:00Z", model: "kimi-k2.6", tool: "opencode", accepted: false }),
    ].join("\n"),
  );
  try {
    const rows = readOutcomesData(p);
    assert.strictEqual(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes("SHOULD_NOT_APPEAR"));
    assert.strictEqual(rows[0].accepted, true);
    assert.strictEqual(rows[1].accepted, false);
  } finally {
    fs.unlinkSync(p);
  }
});

test("computeQualityPerDollar: join math (qpd, acceptance, effective tokens)", () => {
  // Two queue rows for one model/tool with a known curated price.
  // kimi-k2.6 = input $0.95 / MTok. 2,000,000 input tokens => $1.90.
  const queueRows = [
    { source: "opencode", model: "kimi-k2.6", hour_start: "2026-06-30T10:00:00Z", input_tokens: 1_000_000, total_tokens: 1_000_000 },
    { source: "opencode", model: "kimi-k2.6", hour_start: "2026-06-30T11:00:00Z", input_tokens: 1_000_000, total_tokens: 1_000_000 },
  ];
  const expectedCost = computeRowCost(queueRows[0]) + computeRowCost(queueRows[1]);
  assert.ok(Math.abs(expectedCost - 1.9) < 1e-9, `sanity: expected ~$1.90, got ${expectedCost}`);

  const outcomes = [
    { timestamp: "2026-06-30T10:30:00Z", model: "kimi-k2.6", tool: "opencode", accepted: true },
    { timestamp: "2026-06-30T10:40:00Z", model: "kimi-k2.6", tool: "opencode", accepted: true },
    { timestamp: "2026-06-30T11:30:00Z", model: "kimi-k2.6", tool: "opencode", accepted: false },
  ];

  const res = computeQualityPerDollar(queueRows, outcomes, {});
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.by_model.length, 1);
  const m = res.by_model[0];
  assert.strictEqual(m.key, "kimi-k2.6");
  assert.strictEqual(m.accepted, 2);
  assert.strictEqual(m.outcomes, 3);
  assert.ok(Math.abs(m.acceptance_rate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(m.cost_usd - 1.9) < 1e-9);
  assert.ok(Math.abs(m.quality_per_dollar - 2 / 1.9) < 1e-9); // accepted / $
  assert.ok(Math.abs(m.effective_tokens - 2_000_000 * (2 / 3)) < 1e-6);
  assert.ok(Math.abs(m.effective_cost_usd - 1.9 * (2 / 3)) < 1e-9);

  // tool aggregation mirrors model aggregation here (single tool).
  assert.strictEqual(res.by_tool[0].key, "opencode");
  assert.strictEqual(res.by_tool[0].accepted, 2);

  // totals
  assert.strictEqual(res.totals.accepted, 2);
  assert.strictEqual(res.totals.outcomes, 3);
  assert.ok(Math.abs(res.totals.quality_per_dollar - 2 / 1.9) < 1e-9);
});

test("computeQualityPerDollar: preserves partial cost instead of turning unknown spend into zero", () => {
  const queueRows = [{
    source: "copilot",
    model: "gpt-6-astra",
    hour_start: "2026-09-12T10:00:00Z",
    unclassified_input_tokens: 1_000_000,
    output_tokens: 100,
    total_tokens: 1_000_100,
  }];
  const outcomes = [{
    timestamp: "2026-09-12T10:30:00Z",
    model: "gpt-6-astra",
    tool: "copilot",
    accepted: true,
  }];

  const result = computeQualityPerDollar(queueRows, outcomes, {});
  for (const row of [result.by_model[0], result.by_tool[0], result.totals]) {
    assert.strictEqual(row.cost_usd, null);
    assert.strictEqual(row.cost_status, "partial");
    assert.ok(Math.abs(row.known_cost_usd - 0.005) < 1e-12);
    assert.strictEqual(row.quality_per_dollar, null);
    assert.strictEqual(row.effective_cost_usd, null);
  }
});

test("computeQualityPerDollar: mixed complete and partial rows keep the aggregate denominator unknown", () => {
  const queueRows = [
    {
      source: "opencode",
      model: "kimi-k2.6",
      hour_start: "2026-09-12T09:00:00Z",
      input_tokens: 1_000_000,
      total_tokens: 1_000_000,
    },
    {
      source: "copilot",
      model: "gpt-6-astra",
      hour_start: "2026-09-12T10:00:00Z",
      unclassified_input_tokens: 1_000_000,
      output_tokens: 100,
      total_tokens: 1_000_100,
    },
  ];
  const outcomes = [
    { timestamp: "2026-09-12T09:30:00Z", model: "kimi-k2.6", tool: "opencode", accepted: true },
    { timestamp: "2026-09-12T10:30:00Z", model: "gpt-6-astra", tool: "copilot", accepted: true },
  ];

  const result = computeQualityPerDollar(queueRows, outcomes, {});
  const completeModel = result.by_model.find((row) => row.key === "kimi-k2.6");
  assert.ok(Math.abs(completeModel.cost_usd - 0.95) < 1e-12);
  assert.strictEqual(completeModel.cost_status, undefined);
  assert.strictEqual(result.totals.cost_usd, null);
  assert.strictEqual(result.totals.cost_status, "partial");
  assert.ok(Math.abs(result.totals.known_cost_usd - 0.955) < 1e-12);
  assert.strictEqual(result.totals.quality_per_dollar, null);
  assert.strictEqual(result.totals.effective_cost_usd, null);
});

test("computeQualityPerDollar: degrades to cost-only when no outcomes", () => {
  const queueRows = [
    { source: "opencode", model: "kimi-k2.6", hour_start: "2026-06-30T10:00:00Z", input_tokens: 1_000_000, total_tokens: 1_000_000 },
  ];
  const res = computeQualityPerDollar(queueRows, [], {});
  assert.strictEqual(res.available, false);
  // Cost rows still present, but with no quality signal (null, not 0).
  const m = res.by_model[0];
  assert.strictEqual(m.outcomes, 0);
  assert.strictEqual(m.acceptance_rate, null);
  assert.strictEqual(m.quality_per_dollar, null);
  assert.strictEqual(m.effective_tokens, null);
});

test("computeQualityPerDollar: quality_per_dollar is null when cost is zero", () => {
  // No matching token/$ rows for the model the outcome references.
  const res = computeQualityPerDollar([], [
    { timestamp: "2026-06-30T10:00:00Z", model: "ghost-model", tool: "x", accepted: true },
  ], {});
  const m = res.by_model.find((r) => r.key === "ghost-model");
  assert.strictEqual(m.cost_usd, 0);
  assert.strictEqual(m.quality_per_dollar, null); // can't divide by zero spend
  assert.strictEqual(m.accepted, 1);
});

test("computeQualityPerDollar: tolerates null/garbage queue rows", () => {
  const queueRows = [
    null,
    42,
    { source: "opencode", model: "kimi-k2.6", hour_start: "2026-06-30T10:00:00Z", input_tokens: 1_000_000, total_tokens: 1_000_000 },
  ];
  const outcomes = [
    { timestamp: "2026-06-30T10:30:00Z", model: "kimi-k2.6", tool: "opencode", accepted: true },
  ];
  // Must not throw, and must price only the one valid row.
  const res = computeQualityPerDollar(queueRows, outcomes, {});
  assert.ok(Math.abs(res.totals.cost_usd - 0.95) < 1e-9);
  assert.strictEqual(res.totals.accepted, 1);
});

test("computeQualityPerDollar: respects the [from,to] day window", () => {
  const queueRows = [
    { source: "opencode", model: "kimi-k2.6", hour_start: "2026-06-28T10:00:00Z", input_tokens: 1_000_000, total_tokens: 1_000_000 },
    { source: "opencode", model: "kimi-k2.6", hour_start: "2026-06-30T10:00:00Z", input_tokens: 1_000_000, total_tokens: 1_000_000 },
  ];
  const outcomes = [
    { timestamp: "2026-06-28T10:30:00Z", model: "kimi-k2.6", tool: "opencode", accepted: false },
    { timestamp: "2026-06-30T10:30:00Z", model: "kimi-k2.6", tool: "opencode", accepted: true },
  ];
  const res = computeQualityPerDollar(queueRows, outcomes, { from: "2026-06-30", to: "2026-06-30" });
  assert.strictEqual(res.totals.outcomes, 1);
  assert.strictEqual(res.totals.accepted, 1);
  assert.ok(Math.abs(res.totals.cost_usd - 0.95) < 1e-9); // only the 6-30 row
});
