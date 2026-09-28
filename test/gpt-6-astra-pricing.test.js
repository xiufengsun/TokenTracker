"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { test } = require("node:test");
const { transformSync } = require("esbuild");
const pricing = require("../src/lib/pricing");
const { lookupPricing } = require("../src/lib/pricing/matcher");
const curated = require("../src/lib/pricing/curated-overrides.json");
const { parseRolloutIncremental } = require("../src/lib/rollout");

// Standard API-equivalent USD/MTok, verified 2026-09-07:
// https://developers.openai.com/api/docs/models/gpt-6-astra
const rates = { input: 10, output: 50, cache_read: 1, cache_write: 12.5 };
const models = [
  "gpt-6-astra", "gpt-6-astra-high", "gpt-6-astra-xhigh",
  "gpt-6-astrahigh", "gpt-6-astra-ultra", "openai/gpt-6-astra",
  "GPT-6-ASTRA",
];
const row = {
  source: "codex", model: "gpt-6-astra", input_tokens: 1_000_000,
  cached_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
  output_tokens: 1_000_000, reasoning_output_tokens: 500_000,
};

test("Astra resolves offline including provider and reasoning suffixes", () => {
  for (const model of models) {
    const actual = pricing.getModelPricing(model, { source: "codex" });
    for (const [key, value] of Object.entries(rates)) {
      assert.equal(actual[key], value, `${model}: ${key}`);
    }
  }
  const stale = lookupPricing("gpt-6-astra", {
    curated, litellm: { "gpt-6-astra": { input: 0, output: 0 } },
  });
  assert.equal(stale.source, "curated:exact");
  assert.equal(stale.value.input, 10);
});

test("Astra bills cache writes and counts Codex reasoning only once", () => {
  assert.equal(pricing.computeRowCost(row), 73.5);
  assert.equal(pricing.computeRowCost({ ...row, source: "every-code" }), 73.5);
  assert.equal(pricing.computeRowCost({ ...row, source: "gemini" }), 98.5);
});

test("Astra long-context premium applies only to observed requests, never daily totals", () => {
  const mixed = {
    ...row, model: "openai/gpt-6-astra-ultra", input_tokens: 200_000,
    cached_input_tokens: 400_000, cache_creation_input_tokens: 20_000,
    output_tokens: 40_000, reasoning_output_tokens: 10_000,
    long_context_input_tokens: 100_000, long_context_cached_input_tokens: 200_000,
    long_context_cache_creation_input_tokens: 10_000,
    long_context_output_tokens: 20_000, long_context_reasoning_output_tokens: 5_000,
  };
  // Standard 4.65 + long-request premium 1.825. Reasoning is inside output.
  assert.ok(Math.abs(pricing.computeRowCost(mixed) - 6.475) < 1e-12);
  assert.equal(pricing.computeRowCost(row), 73.5, "large aggregate is not a long request");
});

for (const slug of [
  "tokentracker-leaderboard-refresh", "tokentracker-account-daily",
  "tokentracker-account-summary", "tokentracker-account-model-breakdown",
  "tokentracker-leaderboard-profile",
]) {
  test(`${slug}: Astra prices match local standard estimates`, () => {
    const source = fs.readFileSync(path.join(__dirname, "../dashboard/edge-patches", `${slug}.ts`), "utf8");
    const blockMatch = source.match(/const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/);
    assert.ok(blockMatch, `${slug}: pricing block is present`);
    const block = blockMatch[0];
    const rowPricing = source.match(/\nfunction getRowPricing\([\s\S]*?\n\}/)[0];
    const compute = source.match(/\nfunction computeRowCost\([\s\S]*?\n\}/)?.[0] || "";
    const script = transformSync(`${block}\n${rowPricing}\n${compute}`, { loader: "ts", format: "cjs" }).code;
    const context = vm.createContext({ SOURCES_WITH_AUTHORITATIVE_COST: new Set(["grok"]) });
    vm.runInContext(script, context);
    for (const model of models) {
      const actual = context.getModelPricing(model);
      for (const [key, value] of Object.entries(rates)) {
        assert.equal(actual[key], value, `${model}: ${key}`);
      }
      if (compute) assert.equal(context.computeRowCost({ ...row, model }), 73.5);
    }
  });
}

// ── Astra Fast / priority service tier (issue #621) ─────────────────────────

// The reproduction from the issue: 100K non-cached input, 50K cached input,
// 10K output on Standard is $1.55, and the same request on Fast is $3.10.
const issueRow = {
  source: "codex", model: "gpt-6-astra",
  input_tokens: 100_000, cached_input_tokens: 50_000, output_tokens: 10_000,
};
const prioritySubset = {
  priority_input_tokens: 100_000,
  priority_cached_input_tokens: 50_000,
  priority_output_tokens: 10_000,
};
const longSubset = {
  long_context_input_tokens: 100_000,
  long_context_cached_input_tokens: 50_000,
  long_context_output_tokens: 10_000,
};
const priorityLongSubset = {
  priority_long_context_input_tokens: 100_000,
  priority_long_context_cached_input_tokens: 50_000,
  priority_long_context_output_tokens: 10_000,
};
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test("Astra Fast bills 2x Standard, and an untiered row is unchanged", () => {
  assert.equal(pricing.computeRowCost(issueRow), 1.55);
  close(pricing.computeRowCost({ ...issueRow, ...prioritySubset }), 3.1, "all priority");
  // A service_tier scalar on the row is meaningless: one half-hour bucket can
  // hold both tiers, so only the observed subset columns move the price.
  assert.equal(pricing.computeRowCost({ ...issueRow, service_tier: "priority" }), 1.55);
  assert.equal(pricing.computeRowCost({ ...issueRow, model: "gpt-6-astra-fast" }), 1.55);
});

test("Astra priority premium is proportional inside a mixed-tier bucket", () => {
  const half = {
    ...issueRow,
    priority_input_tokens: 50_000,
    priority_cached_input_tokens: 25_000,
    priority_output_tokens: 5_000,
  };
  // Half the bucket at 2x: (1.55 + 3.10) / 2.
  close(pricing.computeRowCost(half), 2.325, "half priority");
  // A subset larger than the column it annotates is clamped, never extrapolated.
  const overstated = { ...issueRow, ...prioritySubset, priority_input_tokens: 10_000_000 };
  close(pricing.computeRowCost(overstated), 3.1, "clamped subset");
});

test("Astra priority multiplies the long-context rate rather than the short one", () => {
  const longStandard = { ...issueRow, ...longSubset };
  // Long/Standard: 100K x $20 + 50K x $2 + 10K x $75.
  close(pricing.computeRowCost(longStandard), 2.85, "long standard");
  const longPriority = { ...longStandard, ...prioritySubset, ...priorityLongSubset };
  // Long/Fast is exactly 2x Long/Standard (40/4/150 vs 20/2/75), NOT
  // "standard x2 plus the long premium once".
  close(pricing.computeRowCost(longPriority), 5.7, "long priority");
  assert.notEqual(pricing.computeRowCost(longPriority), 1.55 * 2 + (2.85 - 1.55));

  // Overlap absent (a queue row, which carries no context-length subset at
  // all): the premium falls back to the short-context multiple of what that
  // row actually bills, and never exceeds the fully-long price.
  const noOverlap = { ...longStandard, ...prioritySubset };
  close(pricing.computeRowCost(noOverlap), 2.85 + 1.55, "priority without overlap");
  // The overlap cannot exceed min(priority, long) even if a corrupt row says so.
  const overstatedOverlap = {
    ...longPriority,
    priority_long_context_input_tokens: 10_000_000,
    long_context_input_tokens: 1_000,
  };
  assert.ok(pricing.computeRowCost(overstatedOverlap) < 5.7);
});

test("priority columns never join any token sum and never price a model without Fast rates", () => {
  // The subset columns annotate the base columns; the CLAUDE.md invariant
  // total = input + output + cache_creation + cache_read + reasoning still holds.
  const row = {
    source: "codex", model: "gpt-6-astra",
    input_tokens: 100_000, cached_input_tokens: 50_000,
    cache_creation_input_tokens: 0, output_tokens: 10_000,
    reasoning_output_tokens: 0, total_tokens: 160_000,
    ...prioritySubset,
  };
  assert.equal(
    row.total_tokens,
    row.input_tokens + row.output_tokens +
      row.cache_creation_input_tokens + row.cached_input_tokens +
      row.reasoning_output_tokens,
  );
  close(pricing.computeRowCost(row), 3.1, "invariant row");

  // gpt-5.6-sol also uses the OpenAI long-context tier but has no published
  // Fast table. Making one up is worse than reporting Standard.
  assert.equal(curated.exact["gpt-5.6-sol"].priority_multiplier, undefined);
  const sol = { ...issueRow, model: "gpt-5.6-sol", ...prioritySubset };
  assert.equal(
    pricing.computeRowCost(sol),
    pricing.computeRowCost({ ...issueRow, model: "gpt-5.6-sol" }),
  );
  const sonnet = { ...issueRow, source: "claude", model: "claude-sonnet-4-6", ...prioritySubset };
  assert.equal(
    pricing.computeRowCost(sonnet),
    pricing.computeRowCost({ ...issueRow, source: "claude", model: "claude-sonnet-4-6" }),
  );
});

// ── Parser: tier attribution into the queue ────────────────────────────────

const tierLine = (ts, serviceTier) => JSON.stringify({
  type: "event_msg",
  timestamp: ts,
  payload: { type: "thread_settings_applied", thread_settings: { service_tier: serviceTier } },
});

const turnContextLine = (ts, model) => JSON.stringify({
  type: "turn_context",
  timestamp: ts,
  payload: { model, cwd: "/tmp" },
});

const tokenCountLine = (ts, last, total) => JSON.stringify({
  type: "event_msg",
  timestamp: ts,
  payload: {
    type: "token_count",
    info: { last_token_usage: last, total_token_usage: total },
  },
});

// Codex reports input_tokens inclusive of the cached slice and the parser
// subtracts it, so these fixtures carry the raw on-disk shape.
const rawUsage = (input, cached, output) => ({
  input_tokens: input, cached_input_tokens: cached,
  cache_creation_input_tokens: 0, output_tokens: output,
  reasoning_output_tokens: 0, total_tokens: input + output,
});

async function syncRollout(lines) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tokentracker-astra-tier-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-2026-09-12T00-00-00-aaa.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    await fsp.writeFile(rolloutPath, lines.join("\n") + "\n", "utf8");
    await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    const raw = await fsp.readFile(queuePath, "utf8");
    const rows = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return rows.filter((row) => row.model === "gpt-6-astra");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

test("Codex parser attributes each token_count to the last applied service tier", async () => {
  const rows = await syncRollout([
    turnContextLine("2026-09-12T00:00:00.000Z", "gpt-6-astra"),
    // First turn has no thread_settings_applied — tier unknown, stays Standard.
    tokenCountLine(
      "2026-09-12T00:00:01.000Z",
      rawUsage(150_000, 50_000, 10_000),
      rawUsage(150_000, 50_000, 10_000),
    ),
    tierLine("2026-09-12T00:00:02.000Z", "priority"),
    turnContextLine("2026-09-12T00:00:03.000Z", "gpt-6-astra"),
    tokenCountLine(
      "2026-09-12T00:00:04.000Z",
      rawUsage(150_000, 50_000, 10_000),
      rawUsage(300_000, 100_000, 20_000),
    ),
    tierLine("2026-09-12T00:00:05.000Z", "default"),
    turnContextLine("2026-09-12T00:00:06.000Z", "gpt-6-astra"),
    tokenCountLine(
      "2026-09-12T00:00:07.000Z",
      rawUsage(150_000, 50_000, 10_000),
      rawUsage(450_000, 150_000, 30_000),
    ),
  ]);
  const row = rows.at(-1);
  // Three identical turns in one half-hour bucket; exactly one was priority.
  assert.equal(row.input_tokens, 300_000);
  assert.equal(row.cached_input_tokens, 150_000);
  assert.equal(row.output_tokens, 30_000);
  assert.equal(row.priority_input_tokens, 100_000);
  assert.equal(row.priority_cached_input_tokens, 50_000);
  assert.equal(row.priority_output_tokens, 10_000);
  assert.equal(row.priority_cache_creation_input_tokens, undefined);
  // Subsets are annotations: the queue invariant is untouched.
  assert.equal(
    row.total_tokens,
    row.input_tokens + row.output_tokens + row.cached_input_tokens +
      (row.cache_creation_input_tokens || 0) + (row.reasoning_output_tokens || 0),
  );
  // Standard 2/3 + Fast 1/3 of three $1.55 turns.
  close(pricing.computeRowCost(row), 1.55 * 2 + 3.1, "mixed bucket cost");
});

test("Codex rows with no tier record stay Standard and carry no priority columns", async () => {
  const rows = await syncRollout([
    turnContextLine("2026-09-12T00:00:00.000Z", "gpt-6-astra"),
    tokenCountLine(
      "2026-09-12T00:00:01.000Z",
      rawUsage(150_000, 50_000, 10_000),
      rawUsage(150_000, 50_000, 10_000),
    ),
  ]);
  const row = rows.at(-1);
  assert.equal(row.priority_input_tokens, undefined);
  assert.equal(row.priority_output_tokens, undefined);
  assert.equal(pricing.computeRowCost(row), 1.55);
});

test("a queue row written before this feature prices exactly as it used to", () => {
  const legacy = {
    source: "codex", model: "gpt-6-astra", hour_start: "2026-09-12T00:00:00.000Z",
    input_tokens: 100_000, cached_input_tokens: 50_000,
    cache_creation_input_tokens: 0, output_tokens: 10_000,
    reasoning_output_tokens: 0, total_tokens: 160_000, conversation_count: 1,
  };
  assert.equal(pricing.computeRowCost(legacy), 1.55);
});

test("an incremental resume keeps the tier the earlier chunk applied", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tokentracker-astra-resume-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-2026-09-12T00-00-00-aaa.jsonl");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    await fsp.writeFile(rolloutPath, [
      turnContextLine("2026-09-12T00:00:00.000Z", "gpt-6-astra"),
      tierLine("2026-09-12T00:00:01.000Z", "priority"),
      turnContextLine("2026-09-12T00:00:02.000Z", "gpt-6-astra"),
      tokenCountLine(
        "2026-09-12T00:00:03.000Z",
        rawUsage(150_000, 50_000, 10_000),
        rawUsage(150_000, 50_000, 10_000),
      ),
    ].join("\n") + "\n", "utf8");
    await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });
    assert.equal(Object.values(cursors.files)[0].lastServiceTier, "priority");

    // Second turn, appended after the cursor: Codex emits thread_settings_applied
    // only when the setting changes, so the tier has to survive in the cursor.
    await fsp.appendFile(rolloutPath, tokenCountLine(
      "2026-09-12T00:00:05.000Z",
      rawUsage(150_000, 50_000, 10_000),
      rawUsage(300_000, 100_000, 20_000),
    ) + "\n", "utf8");
    await parseRolloutIncremental({ rolloutFiles: [rolloutPath], cursors, queuePath });

    const raw = await fsp.readFile(queuePath, "utf8");
    const row = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)).at(-1);
    assert.equal(row.priority_input_tokens, 200_000);
    close(pricing.computeRowCost(row), 6.2, "resumed priority cost");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("the session sidecar records the long-context x priority overlap", async () => {
  const { parseCodexRolloutFile } = require("../src/lib/codex-rollout-parser");
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tokentracker-astra-session-"));
  try {
    const rolloutPath = path.join(tmp, "rollout-2026-09-12T00-00-00-aaa.jsonl");
    await fsp.writeFile(rolloutPath, [
      turnContextLine("2026-09-12T00:00:00.000Z", "gpt-6-astra"),
      tierLine("2026-09-12T00:00:01.000Z", "priority"),
      turnContextLine("2026-09-12T00:00:02.000Z", "gpt-6-astra"),
      // Short request: raw input 150K is under the 272K long-context threshold.
      tokenCountLine(
        "2026-09-12T00:00:03.000Z",
        rawUsage(150_000, 50_000, 10_000),
        rawUsage(150_000, 50_000, 10_000),
      ),
      // Long request: raw (cache-inclusive) input 300K is over it.
      tokenCountLine(
        "2026-09-12T00:00:06.000Z",
        rawUsage(300_000, 100_000, 10_000),
        rawUsage(450_000, 150_000, 20_000),
      ),
    ].join("\n") + "\n", "utf8");

    const result = await parseCodexRolloutFile(rolloutPath, { collectModelUsage: true });
    const row = result.modelUsage.find((entry) => entry.model === "gpt-6-astra");
    assert.equal(row.priority_usage_events, 2);
    assert.equal(row.long_context_usage_events, 1);
    assert.equal(row.priority_input_tokens, 300_000);
    assert.equal(row.long_context_input_tokens, 200_000);
    assert.equal(row.priority_long_context_input_tokens, 200_000);
    // Short Fast (20/2/100) $3.10 + long Fast (40/4/150) $9.90.
    close(pricing.computeRowCost({ source: "codex", ...row }), 13, "session sidecar cost");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});
