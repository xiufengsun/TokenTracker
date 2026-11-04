"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanClaudeSession, scanCodexSession, listSessionsForBrowser, summarizeSessions, buildSessionAnalytics } = require("../src/lib/session-analytics");
const { getModelPricingInfo, getModelPricing, computeRowCost } = require("../src/lib/pricing");
const { mergePerformance, createCodexPerformanceCollector, createZcodePerformanceCollector } = require("../src/lib/session-performance");

const ts = (seconds) => new Date(Date.UTC(2026, 9, 8) + seconds * 1000).toISOString();
const usage = (output, input = 1000) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output });
const codex = (seconds, type, payload) => ({ timestamp: ts(seconds), type, payload });
const count = (seconds, last, total = last) => codex(seconds, "event_msg", { type: "token_count", info: { last_token_usage: last, total_token_usage: total } });
const context = (seconds, model = "gpt-6-sol", id = "turn-1") => codex(seconds, "turn_context", { model, turn_id: id });
const output = (seconds, type = "message") => codex(seconds, "response_item", { type, role: "assistant", content: [] });

function fixture(t, rows, source = "claude") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-performance-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, source === "claude" ? ".claude/projects/repo" : ".codex/sessions/2026/10/08");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, source === "claude" ? "session.jsonl" : "rollout-2026-10-08T00-00-00-00000000-0000-4000-8000-000000000001.jsonl");
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join("\n")}\n`);
  return { file, home };
}

function claudeUser(id, seconds, parent = null) {
  return { type: "user", uuid: id, parentUuid: parent, timestamp: ts(seconds), sessionId: "session", message: { content: "PRIVATE-CONTENT" } };
}
function claudeAssistant(id, parent, seconds, tokens = 400, extra = {}) {
  return { type: "assistant", uuid: id, parentUuid: parent, timestamp: ts(seconds), sessionId: "session", apiBlockIndex: 0,
    message: { id, model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: tokens }, stop_reason: "end_turn", content: [] }, ...extra };
}

test("Claude request speed follows parent boundaries and complete content blocks once", async (t) => {
  const first = claudeAssistant("m1", "attachment", 5);
  const duplicate = { ...first, uuid: "m1-final", parentUuid: "m1", timestamp: ts(10), apiBlockIndex: 1 };
  const { file } = fixture(t, [claudeUser("u1", 0), { type: "attachment", uuid: "attachment", parentUuid: "u1", timestamp: ts(4) }, first, duplicate,
    claudeUser("tool-result", 110, "m1-final"), claudeAssistant("m2", "tool-result", 115, 600)]);
  const row = await scanClaudeSession(file);
  assert.equal(row.performance.estimated_request_count, 2);
  assert.equal(row.performance.estimated_output_tokens, 1000);
  assert.equal(row.performance.estimated_duration_ms, 15000);
  assert.equal(row.performance.estimated_tokens_per_second, 1000 / 15);
  assert.equal(row.total_tokens, 1200, "duplicate content blocks must not add tokens");
  assert.deepEqual(row.model_usage[0].performance, row.performance);
  assert.equal(JSON.stringify(row).includes("PRIVATE-CONTENT"), false);
});

test("Claude missing start, incomplete, truncated block, errors and short windows do not estimate", async (t) => {
  const rows = [claudeUser("u", 0),
    claudeAssistant("tiny", "u", 2, 199),
    claudeAssistant("short", "u", 0.5),
    claudeAssistant("missing", "missing-parent", 4),
    claudeAssistant("partial", "u", 5, 400, { message: { id: "partial", model: "claude-sonnet-4-5", usage: { output_tokens: 400 }, stop_reason: null } }),
    claudeAssistant("truncated", "u", 6, 400, { apiBlockIndex: 2 }),
    claudeAssistant("error", "u", 7, 400, { isApiErrorMessage: true }),
    claudeAssistant("suspend", "u", 3601)];
  const { file } = fixture(t, rows);
  const row = await scanClaudeSession(file);
  assert.equal(row.performance.estimated_request_count, 0);
  assert.equal(row.performance.estimated_tokens_per_second, null);
  assert.ok(row.total_tokens > 0, "speed rejection must never discard billable usage");
});

test("Claude model usage uses the queue's mutually exclusive reasoning columns", async (t) => {
  const assistant = claudeAssistant("m1", "u1", 10);
  assistant.message.usage.output_tokens_details = { thinking_tokens: 150 };
  const { file } = fixture(t, [claudeUser("u1", 0), assistant]);
  const row = await scanClaudeSession(file);
  assert.equal(row.tokens.output_tokens, 250);
  assert.equal(row.tokens.reasoning_output_tokens, 150);
  assert.equal(row.total_tokens, 500);
  assert.equal(row.performance.estimated_output_tokens, 400);
  assert.equal(row.cost_usd, computeRowCost({ source: "claude", model: row.model, ...row.tokens }));
});

test("Codex request speed excludes tool execution using matched usage_record completion", async (t) => {
  const last = usage(400);
  const rows = [context(0), output(3, "reasoning"), output(5, "function_call"),
    codex(6, "token_usage_record", { response_id: "response-1", usage: last }),
    codex(100, "response_item", { type: "function_call_output" }), count(100.001, last),
    codex(101, "event_msg", { type: "task_complete", turn_id: "turn-1", time_to_first_token_ms: 1234 }),
    codex(101, "event_msg", { type: "task_complete", turn_id: "turn-1", time_to_first_token_ms: 1234 })];
  const { file } = fixture(t, rows, "codex");
  const row = await scanCodexSession(file);
  assert.equal(row.performance.estimated_duration_ms, 6000);
  assert.equal(row.performance.estimated_tokens_per_second, 400 / 6);
  assert.equal(row.performance.first_response_sample_count, 1);
  assert.equal(row.performance.first_response_ms, 1234);
  assert.deepEqual(row.model_usage[0].performance, row.performance);
});

test("old Codex logs end at model output even when token_count is delayed after tools", async (t) => {
  const rows = [context(0), output(5, "function_call"), codex(100, "response_item", { type: "function_call_output" }), count(110, usage(300))];
  const { file } = fixture(t, rows, "codex");
  const row = await scanCodexSession(file);
  assert.equal(row.performance.estimated_duration_ms, 5000);
  assert.equal(row.performance.estimated_tokens_per_second, 60);
});

test("Codex duplicate snapshots do not end an in-flight request or double its tokens", async (t) => {
  const first = usage(300);
  const rows = [context(0), output(5), count(5, first),
    codex(20, "response_item", { type: "function_call_output" }), output(25, "reasoning"), count(26, first),
    output(30), count(30, usage(600), usage(900, 2000)), count(30.001, usage(600), usage(900, 2000))];
  const { file } = fixture(t, rows, "codex");
  const row = await scanCodexSession(file);
  assert.equal(row.performance.estimated_output_tokens, 900);
  assert.equal(row.performance.estimated_request_count, 2);
  assert.equal(row.performance.estimated_duration_ms, 15000);
  assert.equal(row.performance.estimated_tokens_per_second, 60);
});

test("Codex aborted and failed requests, snapshots without output and compactions are excluded", () => {
  const collector = createCodexPerformanceCollector();
  const send = (obj) => collector.consume(obj, "gpt-6-sol");
  send(context(0)); send(output(2)); send(codex(3, "event_msg", { type: "turn_aborted" }));
  collector.consumeUsage({ timestamp: ts(4), delta: usage(400), rawUsage: usage(400), model: "gpt-6-sol" });
  send(context(10, "gpt-6-sol", "turn-2")); send(output(12)); send(codex(13, "event_msg", { type: "error" }));
  collector.consumeUsage({ timestamp: ts(14), delta: usage(400), rawUsage: usage(400), model: "gpt-6-sol" });
  send(context(20, "gpt-6-sol", "turn-3"));
  collector.consumeUsage({ timestamp: ts(24), delta: usage(400), rawUsage: usage(400), model: "gpt-6-sol" });
  send(output(30)); send(codex(31, "compacted", {}));
  collector.consumeUsage({ timestamp: ts(32), delta: usage(400), rawUsage: usage(400), model: "gpt-6-sol" });
  assert.equal(collector.finish().performance.estimated_request_count, 0);
});

test("Codex old flush order and user idle gaps never become a new request duration", async (t) => {
  const rows = [context(0), output(3), count(3, usage(300)), output(3.001),
    context(1000, "gpt-6-sol", "turn-2"), output(1005), count(1005, usage(400), usage(700, 2000))];
  const { file } = fixture(t, rows, "codex");
  const row = await scanCodexSession(file);
  assert.equal(row.performance.estimated_duration_ms, 8000);
});

test("first response belongs to the whole Codex turn and ambiguous reroutes have no model owner", () => {
  const collector = createCodexPerformanceCollector();
  collector.consume(context(0), "gpt-6-sol");
  collector.consume(output(3), "gpt-6-astra");
  collector.consume(codex(30, "event_msg", { type: "task_complete", time_to_first_token_ms: 1000, turn_id: "turn-1" }), "gpt-6-astra");
  const result = collector.finish();
  assert.equal(result.performance.first_response_ms, 1000);
  assert.equal(result.performance.estimated_tokens_per_second, null);
  assert.equal(result.byModel.size, 0);
});

test("speed aggregation weights output by duration and fragments and cached sidecars preserve it", async (t) => {
  const { file, home } = fixture(t, [claudeUser("u1", 0), claudeAssistant("m1", "u1", 10)]);
  const first = await scanClaudeSession(file);
  const secondPath = path.join(path.dirname(file), "fragment.jsonl");
  fs.writeFileSync(secondPath, `${[claudeUser("u2", 100), claudeAssistant("m2", "u2", 101, 600)].map(JSON.stringify).join("\n")}\n`);
  const second = await scanClaudeSession(secondPath);
  const merged = listSessionsForBrowser([first, second]).sessions[0];
  assert.equal(merged.performance.estimated_tokens_per_second, 1000 / 11);
  assert.deepEqual(merged.model_usage[0].performance, merged.performance);
  const summary = summarizeSessions([first, second]);
  assert.deepEqual(summary.summary.performance, merged.performance);
  assert.deepEqual(summary.by_model[0].performance, merged.performance);
  const cold = await buildSessionAnalytics({ home, force: true });
  const warm = await buildSessionAnalytics({ home });
  assert.deepEqual(warm.map((row) => row.performance), cold.map((row) => row.performance));
  assert.deepEqual(warm.map((row) => row.model_usage), cold.map((row) => row.model_usage));
  const serialized = fs.readFileSync(path.join(home, ".tokentracker/tracker/session.queue.jsonl"), "utf8");
  assert.equal(serialized.includes("PRIVATE-CONTENT"), false);
  assert.equal(serialized.includes('"pricing"'), false, "rates must be recomputed after pricing cache changes");
});

test("pricing provenance separates paid, free and missing rates without changing the rates", () => {
  assert.equal(getModelPricingInfo("not-a-real-model").status, "unpriced");
  assert.equal(getModelPricingInfo("not-a-real-model").source, null);
  assert.equal(getModelPricingInfo("gpt-6-sol").status, "priced");
  assert.ok(getModelPricingInfo("gpt-6-sol").source.startsWith("curated:"));
  const { status: _status, source: _source, ...rates } = getModelPricingInfo("gpt-6-sol");
  const original = getModelPricing("gpt-6-sol");
  for (const key of Object.keys(rates)) assert.equal(rates[key], original[key]);
  assert.equal(getModelPricingInfo("anything:free", { source: "cline" }).status, "free");
  assert.equal(getModelPricingInfo("gpt-6-sol", { source: "lmstudio" }).status, "free");
  assert.equal(mergePerformance().first_response_ms, null);
});

test("pricing provenance is memoized per pricing revision and hands out copies", () => {
  const { resetPricingForTests } = require("../src/lib/pricing");
  const first = getModelPricingInfo("gpt-6-sol", { source: "codex" });
  first.status = "mutated";
  first.input = -1;
  const second = getModelPricingInfo("gpt-6-sol", { source: "codex" });
  assert.equal(second.status, "priced");
  assert.ok(second.input > 0);
  assert.notEqual(first, second);
  // Same model under a no-charge source must not reuse the paid entry.
  assert.equal(getModelPricingInfo("gpt-6-sol", { source: "lmstudio" }).status, "free");
  resetPricingForTests();
  assert.equal(getModelPricingInfo("gpt-6-sol", { source: "codex" }).status, "priced");
});

test("unknown Claude models preserve tokens and label their cost estimate partial", async (t) => {
  const assistant = claudeAssistant("m1", "u1", 10);
  assistant.message.model = "private-model-with-no-public-rates";
  const { file } = fixture(t, [claudeUser("u1", 0), assistant]);
  const row = await scanClaudeSession(file);
  assert.equal(row.model_usage[0].pricing.status, "unpriced");
  assert.equal(row.cost_is_partial, true);
  assert.equal(row.total_tokens, 500);
});

test("reported provider cost remains authoritative when model metadata is present", async (t) => {
  const { file } = fixture(t, [claudeUser("u1", 0), claudeAssistant("m1", "u1", 10)]);
  const scanned = await scanClaudeSession(file);
  const reported = { ...scanned, source: "grok", provider_cost_usd: 7.25, cost_usd: 7.25, cost_source: "provider_reported" };
  const listed = listSessionsForBrowser([reported]).sessions[0];
  assert.equal(listed.cost_source, "provider_reported");
  assert.equal(listed.cost_usd, 7.25);
  assert.equal(listed.model_usage[0].cost_usd, 7.25);
  assert.equal(summarizeSessions([reported]).by_model[0].cost_usd, 7.25);
});

test("native and WSL mirror groups retain one performance sample per canonical request", async (t) => {
  for (const source of ["claude", "codex"]) {
    const rows = source === "claude" ? [claudeUser("u1", 0), claudeAssistant("m1", "u1", 10)]
      : [context(0), output(10), count(10, usage(400))];
    const { file } = fixture(t, rows, source);
    const copy = `${file}.mirror.jsonl`;
    fs.copyFileSync(file, copy);
    const scan = source === "claude" ? scanClaudeSession : scanCodexSession;
    const single = await scan(file);
    const mirrored = await scan([file, copy]);
    assert.deepEqual(mirrored.performance, single.performance);
    assert.equal(mirrored.total_tokens, single.total_tokens);
    assert.equal(mirrored.performance.estimated_request_count, 1);
  }
});

test("pricing cache refresh reprices old sidecars without changing request performance", async (t) => {
  const pricing = require("../src/lib/pricing");
  const state = pricing.__getStateForTests();
  const model = "performance-test-model-unknown-until-refresh";
  t.after(() => { delete state.litellmPerMillionMap[model]; state.negativeCache.clear(); state.revision += 1; });
  const assistant = claudeAssistant("m1", "u1", 10);
  assistant.message.model = model;
  const { file, home } = fixture(t, []);
  const { captureClaudeBackend } = require("../src/lib/claude-backend");
  const observe = (event) => captureClaudeBackend(path.join(home, ".tokentracker/tracker"), {
    hook_event_name: event, session_id: "session", transcript_path: file,
  }, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
  observe("SessionStart");
  fs.appendFileSync(file, [claudeUser("u1", 0), assistant].map(JSON.stringify).join("\n") + "\n");
  observe("Stop");
  const before = (await buildSessionAnalytics({ home, force: true }))[0];
  assert.equal(before.cost_is_partial, true);
  state.litellmPerMillionMap[model] = { input: 1, output: 2, cache_read: 0, cache_write: 0 };
  state.negativeCache.clear();
  state.revision += 1;
  const after = (await buildSessionAnalytics({ home }))[0];
  assert.equal(after.cost_usd, 0.0009);
  assert.equal(after.cost_is_partial, false);
  assert.equal(after.model_usage[0].pricing.source, "litellm:exact");
  assert.deepEqual(after.performance, before.performance);
});

test("zero-usage Claude assistants do not create phantom models, including existing sidecars", async (t) => {
  const synthetic = claudeAssistant("synthetic", "u1", 1, 0);
  synthetic.message.model = "<synthetic>";
  synthetic.message.usage.input_tokens = 0;
  const zeroModel = claudeAssistant("zero-model", "u1", 2, 0);
  zeroModel.message.model = "unused-model";
  zeroModel.message.usage.input_tokens = 0;
  const { file, home } = fixture(t, [claudeUser("u1", 0), synthetic, zeroModel, claudeAssistant("real", "u1", 10)]);
  const scanned = await scanClaudeSession(file);
  assert.equal(scanned.model, "claude-sonnet-4-5");
  assert.deepEqual(scanned.model_usage.map((row) => row.model), ["claude-sonnet-4-5"]);
  await buildSessionAnalytics({ home, force: true });
  const sidecar = path.join(home, ".tokentracker/tracker/session.queue.jsonl");
  const stale = JSON.parse(fs.readFileSync(sidecar, "utf8").trim());
  stale.model = "mixed";
  stale.model_usage.push({ model: "unknown", total_tokens: 0, usage_events: 5 });
  fs.writeFileSync(sidecar, `${JSON.stringify(stale)}\n`);
  const warm = (await buildSessionAnalytics({ home }))[0];
  assert.equal(warm.model, "claude-sonnet-4-5");
  assert.deepEqual(warm.model_usage.map((row) => row.model), ["claude-sonnet-4-5"]);
});

test("nonzero unknown Claude usage remains in model totals and partial cost", async (t) => {
  const unknown = claudeAssistant("unknown", "u1", 5, 300);
  delete unknown.message.model;
  const { file } = fixture(t, [claudeUser("u1", 0), unknown, claudeAssistant("real", "u1", 10)]);
  const row = await scanClaudeSession(file);
  const unknownUsage = row.model_usage.find((usage) => usage.model === "unknown");
  assert.equal(row.model, "mixed");
  assert.equal(unknownUsage.total_tokens, 400);
  assert.equal(row.total_tokens, 900);
  assert.equal(row.cost_is_partial, true);
});

test("ZCode collector converts per-request durations and first-token samples", () => {
  const collector = createZcodePerformanceCollector();
  collector.consumeUsage({ model: "GLM-5.3", outputTokens: 900, durationMs: 30000, timeToFirstTokenMs: 1200 });
  collector.consumeUsage({ model: "GLM-5.3", outputTokens: 300, durationMs: 10000, timeToFirstTokenMs: 800 });
  collector.consumeUsage({ model: "GLM-5.3", outputTokens: 50, durationMs: 5000 }); // below MIN_OUTPUT
  collector.consumeUsage({ model: "GLM-5.3", outputTokens: 500, durationMs: 500 }); // below MIN_DURATION_MS
  collector.consumeUsage({ model: "GLM-5.3", outputTokens: 500, durationMs: 2 * 60 * 60 * 1000 }); // above MAX_DURATION_MS
  collector.consumeUsage({ model: "GLM-5.3", outputTokens: 100, durationMs: 4000, timeToFirstTokenMs: -1 }); // negative first token ignored
  const { performance, byModel } = collector.finish();
  assert.equal(performance.estimated_output_tokens, 1200);
  assert.equal(performance.estimated_duration_ms, 40000);
  assert.equal(performance.estimated_request_count, 2);
  assert.ok(Math.abs(performance.estimated_tokens_per_second - 30) < 1e-9);
  assert.equal(performance.first_response_total_ms, 2000);
  assert.equal(performance.first_response_sample_count, 2);
  assert.equal(performance.first_response_ms, 1000);
  assert.equal(byModel.get("GLM-5.3").estimated_request_count, 2);
  assert.equal(byModel.get("GLM-5.3").estimated_tokens_per_second, 30);
});
