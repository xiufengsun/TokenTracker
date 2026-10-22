"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pricing = require("../src/lib/pricing");
const { parseCodexRolloutFile } = require("../src/lib/codex-rollout-parser");
const {
  isPriorityServiceTier,
  isUltrafastServiceTier,
} = require("../src/lib/codex-service-tier");

test("ultrafast is distinct from Fast/priority (#849)", () => {
  assert.equal(isPriorityServiceTier("ultrafast"), false);
  assert.equal(isUltrafastServiceTier("ultrafast"), true);
  assert.equal(isUltrafastServiceTier("priority"), false);
  assert.equal(isUltrafastServiceTier("fast"), false);
});

test("Ultrafast subsets price at 6x Standard for gpt-6.1-sol (#849)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ultrafast-"));
  const file = path.join(dir, "rollout-ultrafast.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: "2026-10-21T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "repro-ultrafast",
          cwd: "/tmp",
          originator: "codex_cli_rs",
          model: "gpt-6.1-sol",
          provider: "openai",
        },
      }),
      JSON.stringify({
        timestamp: "2026-10-21T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { model: "gpt-6.1-sol", service_tier: "ultrafast" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-10-21T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100000,
              cached_input_tokens: 50000,
              cache_write_input_tokens: 0,
              output_tokens: 10000,
              reasoning_output_tokens: 0,
              total_tokens: 110000,
            },
            last_token_usage: {
              input_tokens: 100000,
              cached_input_tokens: 50000,
              cache_write_input_tokens: 0,
              output_tokens: 10000,
              reasoning_output_tokens: 0,
              total_tokens: 110000,
            },
            model_context_window: 475000,
          },
        },
      }),
      "",
    ].join("\n"),
  );

  const res = await parseCodexRolloutFile(file, { collectModelUsage: true });
  const m = res.modelUsage[0];
  assert.equal(m.model, "gpt-6.1-sol");
  assert.equal(m.priority_input_tokens, 0);
  // Parser peels cached out of input (OpenAI inclusive → disjoint columns).
  assert.equal(m.input_tokens, 50000);
  assert.equal(m.cached_input_tokens, 50000);
  assert.equal(m.ultrafast_input_tokens, 50000);
  assert.equal(m.ultrafast_cached_input_tokens, 50000);
  assert.equal(m.ultrafast_output_tokens, 10000);
  assert.equal(m.ultrafast_usage_events, 1);

  const standard = pricing.computeRowCost({
    source: "codex",
    model: "gpt-6.1-sol",
    input_tokens: m.input_tokens,
    cached_input_tokens: m.cached_input_tokens,
    cache_creation_input_tokens: 0,
    output_tokens: m.output_tokens,
    reasoning_output_tokens: 0,
  });
  const recorded = pricing.computeRowCost({ source: "codex", ...m });
  assert.ok(Math.abs(recorded - standard * 6) < 1e-9, `got ${recorded} want ${standard * 6}`);

  // Fast (2x) must not be applied to ultrafast rows.
  const asIfFast = pricing.computeRowCost({
    source: "codex",
    model: "gpt-6.1-sol",
    input_tokens: m.input_tokens,
    cached_input_tokens: m.cached_input_tokens,
    cache_creation_input_tokens: 0,
    output_tokens: m.output_tokens,
    priority_input_tokens: m.input_tokens,
    priority_cached_input_tokens: m.cached_input_tokens,
    priority_output_tokens: m.output_tokens,
  });
  assert.ok(Math.abs(asIfFast - standard * 2) < 1e-9);
  assert.notEqual(recorded, asIfFast);

  fs.rmSync(dir, { recursive: true, force: true });
});
