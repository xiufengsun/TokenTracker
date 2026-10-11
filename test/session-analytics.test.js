"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildSessionAnalytics,
  scanClaudeSession,
  scanCodexSession,
  scanGrokSession,
  summarizeSessions,
  listSessionsForBrowser,
  resumeCommandFor,
  sessionsToCsv,
} = require("../src/lib/session-analytics");

function writeGrokSessionFixture(home, {
  sessionId = "019f740c-e792-7fb1-a218-59ea1b340714",
  cwd = "/work/tokentracker",
  title = "Wire up Grok sessions",
  updates = [],
  signals = null,
} = {}) {
  // Mirror Grok Build layout: ~/.grok/sessions/<url-encoded-cwd>/<uuid>/
  const encodedCwd = encodeURIComponent(cwd);
  const sessionDir = path.join(home, ".grok", "sessions", encodedCwd, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const updatesPath = path.join(sessionDir, "updates.jsonl");
  fs.writeFileSync(updatesPath, `${updates.map(JSON.stringify).join("\n")}\n`);
  fs.writeFileSync(path.join(sessionDir, "summary.json"), `${JSON.stringify({
    info: { id: sessionId, cwd },
    generated_title: title,
    session_summary: title,
    created_at: "2026-07-18T06:00:00.000Z",
    updated_at: "2026-07-18T06:10:00.000Z",
    last_active_at: "2026-07-18T06:10:00.000Z",
    current_model_id: "alphafox",
  })}\n`);
  fs.writeFileSync(path.join(sessionDir, "signals.json"), `${JSON.stringify(signals || {
    turnCount: 1,
    primaryModelId: "grok-4.5",
    modelsUsed: ["grok-4.5"],
    contextTokensUsed: 99999,
  })}\n`);
  return updatesPath;
}

function grokUpdate(sessionId, sessionUpdate, updateFields = {}, opts = {}) {
  const ts = opts.timestamp ?? 1_784_358_461;
  const agentTimestampMs = opts.agentTimestampMs ?? ts * 1000;
  return {
    timestamp: ts,
    method: sessionUpdate === "turn_completed" ? "_x.ai/session/update" : "session/update",
    params: {
      sessionId,
      update: { sessionUpdate, ...updateFields },
      _meta: { agentTimestampMs },
    },
  };
}

test("Claude session analytics retains metadata but never content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-"));
  const filePath = path.join(dir, "session.jsonl");
  const secret = "TOP-SECRET-PROMPT-CONTENT";
  const rows = [
    { type: "user", sessionId: "s1", cwd: dir, timestamp: "2026-07-18T01:00:00Z", message: { content: secret } },
    { type: "assistant", sessionId: "s1", cwd: dir, timestamp: "2026-07-18T01:01:00Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 10 }, content: [{ type: "tool_use", name: "Edit", input: { file_path: secret } }, { type: "tool_use", name: "Agent", input: { subagent_type: "research" } }] } },
    { type: "user", sessionId: "s1", cwd: dir, timestamp: "2026-07-18T01:01:30Z", message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: secret }] } },
    { type: "assistant", sessionId: "s1", cwd: dir, timestamp: "2026-07-18T01:02:00Z", message: { id: "m2", model: "claude-test", usage: { input_tokens: 50, output_tokens: 5 }, content: [] } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.turns, 1);
  assert.equal(session.edit_turns, 1);
  assert.equal(session.retry_turns, 0);
  assert.equal(session.one_shot, true);
  assert.equal(session.subagent_calls, 1);
  assert.equal(session.total_tokens, 185);
  assert.equal(JSON.stringify(session).includes(secret), false);

  const summary = summarizeSessions([session]);
  assert.equal(summary.summary.productive_rate, 1);
  assert.equal(summary.summary.one_shot_rate, 1);
  assert.equal(Object.hasOwn(summary.sessions[0], "project_ref"), false);
  assert.equal(sessionsToCsv(summary.sessions).includes(secret), false);
});

test("Claude session analytics counts repeated prompts as retries, not tool loops", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-retry-"));
  const filePath = path.join(dir, "session.jsonl");
  const prompt = "make the requested change";
  const rows = [
    { type: "user", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:00Z", message: { content: prompt } },
    { type: "assistant", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:01Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    { type: "user", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: "ok" }] } },
    { type: "assistant", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:03Z", message: { id: "m2", model: "claude-test", usage: { input_tokens: 8, output_tokens: 4 }, content: [] } },
    { type: "user", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:04Z", message: { content: prompt } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.turns, 2);
  assert.equal(session.edit_turns, 1);
  assert.equal(session.retry_turns, 1);
  assert.equal(session.one_shot, false);
});

test("Claude session analytics ignores synthetic model markers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-model-"));
  const filePath = path.join(dir, "session.jsonl");
  const rows = [
    { type: "user", sessionId: "s3", cwd: dir, timestamp: "2026-07-18T03:00:00Z", message: { content: "ship it" } },
    { type: "assistant", sessionId: "s3", cwd: dir, timestamp: "2026-07-18T03:00:01Z", message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    { type: "assistant", sessionId: "s3", cwd: dir, timestamp: "2026-07-18T03:00:02Z", message: { id: "m2", model: "<synthetic>", usage: { input_tokens: 2, output_tokens: 1 }, content: [] } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.model, "claude-opus-4-8");
  assert.equal(summarizeSessions([session]).by_model[0].model, "claude-opus-4-8");
});

test("Codex session analytics observes nested exec edit turns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-codex-"));
  const filePath = path.join(dir, "rollout-2026-07-18T06-00-00-00000000-0000-4000-8000-000000000001.jsonl");
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const rows = [
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: "codex-1", cwd: dir, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:00:02Z", type: "event_msg", payload: { type: "user_message", message: "implement it" } },
    { timestamp: "2026-07-18T06:00:03Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call-1", input: "await tools.apply_patch(patch); await tools.spawn_agent({ task_name: 'test' });" } },
    { timestamp: "2026-07-18T06:00:04Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(100, 20), total_token_usage: usage(100, 20) } } },
    { timestamp: "2026-07-18T06:01:00Z", type: "turn_context", payload: { turn_id: "turn-2", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:01:01Z", type: "event_msg", payload: { type: "user_message", message: "verify it" } },
    { timestamp: "2026-07-18T06:01:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(40, 5), total_token_usage: usage(140, 25) } } },
    { timestamp: "2026-07-18T06:01:03Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(5, 1), total_token_usage: usage(145, 26) } } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.model, "gpt-5.6-sol");
  assert.equal(session.turns, 2);
  assert.equal(session.edit_turns, 1);
  assert.equal(session.productive, true);
  assert.equal(session.one_shot, true);
  assert.equal(session.subagent_calls, 1);
  assert.deepEqual(session.subagent_types, { spawn_agent: 1 });
});

test("Codex session analytics does not report model providers as models", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-provider-"));
  const filePath = path.join(dir, "rollout-2026-07-18T07-00-00-00000000-0000-4000-8000-000000000002.jsonl");
  const rows = [
    { timestamp: "2026-07-18T07:00:00Z", type: "session_meta", payload: { id: "codex-provider", cwd: dir, model_provider: "openai" } },
    { timestamp: "2026-07-18T07:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: dir } },
    { timestamp: "2026-07-18T07:00:02Z", type: "event_msg", payload: { type: "user_message", message: "inspect it" } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.model, "unknown");
  assert.notEqual(summarizeSessions([session]).by_model[0].model, "openai");
});

test("Codex session analytics marks unpriced internal model usage as a partial cost", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-codex-unpriced-"));
  const filePath = path.join(dir, "rollout-2026-07-18T07-30-00-00000000-0000-4000-8000-000000000005.jsonl");
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 0,
    total_tokens: 120,
  };
  fs.writeFileSync(filePath, `${[
    { timestamp: "2026-07-18T07:30:00Z", type: "session_meta", payload: { id: "codex-unpriced", cwd: dir, model_provider: "openai" } },
    { timestamp: "2026-07-18T07:30:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: dir, model: "codex-auto-review" } },
    { timestamp: "2026-07-18T07:30:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } },
  ].map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.model, "codex-auto-review");
  assert.equal(session.total_tokens, 120);
  assert.equal(session.cost_usd, 0);
  assert.equal(session.cost_is_partial, true);
});

test("Codex session analytics attributes one session across selected and rerouted effective models", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-codex-models-"));
  const filePath = path.join(dir, "rollout-2026-07-18T08-00-00-00000000-0000-4000-8000-000000000003.jsonl");
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const rows = [
    { timestamp: "2026-07-18T08:00:00Z", type: "session_meta", payload: { id: "codex-models", cwd: dir, model_provider: "openai" } },
    { timestamp: "2026-07-18T08:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T08:00:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(100, 20), total_token_usage: usage(100, 20) } } },
    { timestamp: "2026-07-18T08:01:00Z", type: "turn_context", payload: { turn_id: "turn-2", cwd: dir, model: "gpt-5.6-luna" } },
    { timestamp: "2026-07-18T08:01:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(50, 10), total_token_usage: usage(150, 30) } } },
    { timestamp: "2026-07-18T08:02:00Z", type: "turn_context", payload: { turn_id: "turn-3", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T08:02:01Z", method: "model/rerouted", params: { threadId: "codex-models", turnId: "turn-3", fromModel: "gpt-5.6-sol", toModel: "gpt-5.6-terra", reason: "capacity" } },
    { timestamp: "2026-07-18T08:02:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(30, 6), total_token_usage: usage(180, 36) } } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.model, "mixed");
  assert.equal(session.total_tokens, 216);
  assert.deepEqual(session.model_usage.map((row) => [row.model, row.total_tokens]), [
    ["gpt-5.6-sol", 120],
    ["gpt-5.6-luna", 60],
    ["gpt-5.6-terra", 36],
  ]);
  const terra = session.model_usage.find((row) => row.model === "gpt-5.6-terra");
  assert.equal(terra.model_attribution, "effective");
  assert.equal(terra.rerouted_usage_events, 1);
  assert.deepEqual(terra.selected_models, ["gpt-5.6-sol"]);
  assert.deepEqual(terra.reroute_reasons, ["capacity"]);
  assert.ok(Math.abs(session.cost_usd - 0.000954) < 1e-12);

  const summary = summarizeSessions([session]);
  assert.equal(summary.summary.sessions, 1);
  assert.equal(summary.summary.total_tokens, 216);
  assert.equal(summary.by_model.length, 3);
  assert.equal(summary.by_model.reduce((sum, row) => sum + row.total_tokens, 0), 216);
  assert.match(sessionsToCsv(summary.sessions), /gpt-5\.6-terra/);
});

test("Codex session analytics preserves the exact GPT-5.6 Sol long-context request subset", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-codex-long-"));
  const filePath = path.join(dir, "rollout-2026-07-18T09-00-00-00000000-0000-4000-8000-000000000004.jsonl");
  const usage = {
    input_tokens: 300_000,
    cached_input_tokens: 250_000,
    cache_creation_input_tokens: 0,
    output_tokens: 10_000,
    reasoning_output_tokens: 2_000,
    total_tokens: 310_000,
  };
  fs.writeFileSync(filePath, `${[
    { timestamp: "2026-07-18T09:00:00Z", type: "session_meta", payload: { id: "codex-long", cwd: dir, model_provider: "openai" } },
    { timestamp: "2026-07-18T09:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T09:00:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } },
  ].map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  const modelUsage = session.model_usage[0];
  assert.equal(modelUsage.input_tokens, 50_000);
  assert.equal(modelUsage.cached_input_tokens, 250_000);
  assert.equal(modelUsage.long_context_input_tokens, 50_000);
  assert.equal(modelUsage.long_context_cached_input_tokens, 250_000);
  assert.equal(modelUsage.long_context_output_tokens, 10_000);
  assert.equal(modelUsage.long_context_usage_events, 1);
  assert.ok(Math.abs(session.cost_usd - 0.9) < 1e-12);
  const scoped = listSessionsForBrowser([session], { from: "2026-07-18", to: "2026-07-18" }).sessions[0];
  assert.equal(scoped.model_usage[0].long_context_input_tokens, 50_000);
  assert.equal(scoped.cost_usd, session.cost_usd);
});

test("efficiency denominators only use sessions that contain edits", () => {
  const summary = summarizeSessions([
    {
      model: "gpt-test",
      started_at: "2026-07-18T06:00:00Z",
      productive: true,
      first_pass: true,
      one_shot: true,
      edit_turns: 1,
      retry_turns: 0,
      total_tokens: 100,
      cost_usd: 2,
    },
    {
      model: "gpt-test",
      started_at: "2026-07-18T07:00:00Z",
      productive: false,
      first_pass: false,
      one_shot: false,
      edit_turns: 0,
      retry_turns: 0,
      total_tokens: 900,
      cost_usd: 18,
    },
  ]);

  assert.equal(summary.summary.edit_session_rate, 0.5);
  assert.equal(summary.summary.first_pass_rate, 1);
  assert.equal(summary.summary.tokens_per_edit, 100);
  assert.equal(summary.summary.cost_per_edit, 2);
  assert.equal(summary.by_model[0].edit_sessions, 1);
});

test("concurrent session analytics builds share one scan", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-build-"));
  const projectDir = path.join(home, ".claude", "projects", "fixture");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(filePath, `${JSON.stringify({
    type: "user",
    sessionId: "s4",
    cwd: projectDir,
    timestamp: "2026-07-18T04:00:00Z",
    message: { content: "build" },
  })}\n`);
  const observerDir = path.join(
    home,
    ".claude",
    "projects",
    "-Users-test--claude-mem-observer-sessions",
  );
  fs.mkdirSync(observerDir, { recursive: true });
  fs.writeFileSync(path.join(observerDir, "observer.jsonl"), `${JSON.stringify({
    type: "assistant",
    sessionId: "observer",
    cwd: "/Users/test/.claude-mem/observer-sessions",
    timestamp: "2026-07-18T04:00:01Z",
    message: { id: "observer-message", model: "<synthetic>", usage: {}, content: [] },
  })}\n`);

  const [first, second] = await Promise.all([
    buildSessionAnalytics({ home, force: true }),
    buildSessionAnalytics({ home, force: true }),
  ]);
  assert.strictEqual(first, second);
  // Claude Memory's observer files are background bookkeeping, not coding
  // sessions, and should not dilute efficiency or appear as a model.
  assert.equal(first.length, 1);
});

test("session analytics reuses unchanged file records during an incremental rebuild", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-incremental-"));
  const writeSession = (project, sessionId, model) => {
    const projectDir = path.join(home, ".claude", "projects", project);
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    const rows = [
      { type: "user", sessionId, cwd: projectDir, timestamp: "2026-07-18T05:00:00Z", message: { content: "build" } },
      { type: "assistant", sessionId, cwd: projectDir, timestamp: "2026-07-18T05:00:01Z", message: { id: `${sessionId}-message`, model, usage: { input_tokens: 10, output_tokens: 2 }, content: [] } },
    ];
    fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);
    return filePath;
  };
  writeSession("project-a", "session-a", "claude-a");
  const changedFile = writeSession("project-b", "session-b", "claude-b");

  await buildSessionAnalytics({ home, force: true });
  const sidecarPath = path.join(home, ".tokentracker", "tracker", "session.queue.jsonl");
  const cachedRows = fs.readFileSync(sidecarPath, "utf8").trim().split("\n").map(JSON.parse);
  cachedRows.find((row) => row.project_key === "project-a").title = "cached-proof";
  fs.writeFileSync(sidecarPath, `${cachedRows.map(JSON.stringify).join("\n")}\n`);
  fs.appendFileSync(changedFile, `${JSON.stringify({
    type: "user",
    sessionId: "session-b",
    cwd: path.dirname(changedFile),
    timestamp: "2026-07-18T05:00:02Z",
    message: { content: "changed" },
  })}\n`);

  const rebuilt = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
  assert.equal(rebuilt.find((row) => row.project_key === "project-a").title, "cached-proof");
  assert.equal(rebuilt.find((row) => row.project_key === "project-b").turns, 2);
});

test("Claude session title uses the ai-title record, never the prompt body", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-title-"));
  const filePath = path.join(dir, "session.jsonl");
  const secret = "SECRET-PROMPT-NEVER-A-TITLE";
  const rows = [
    { type: "user", sessionId: "t1", cwd: dir, timestamp: "2026-07-18T01:00:00Z", message: { content: secret } },
    { type: "assistant", sessionId: "t1", cwd: dir, timestamp: "2026-07-18T01:00:01Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    { type: "ai-title", sessionId: "t1", timestamp: "2026-07-18T01:00:02Z", aiTitle: "Refactor the auth module" },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.title, "Refactor the auth module");
  // The raw prompt body must never end up in the persisted record, including
  // as a title fallback.
  assert.equal(JSON.stringify(session).includes(secret), false);

  // Titles are local-only: stripped from the cloud/CSV summary payload.
  const summary = summarizeSessions([session]);
  assert.equal(Object.hasOwn(summary.sessions[0], "title"), false);

  // The local-only browser list keeps the title alongside a resume command.
  const browser = listSessionsForBrowser([session]);
  assert.equal(browser.sessions[0].title, "Refactor the auth module");
  assert.equal(browser.sessions[0].resume_command, resumeCommandFor("claude", session.session_id));
});

test("Claude session without an ai-title leaves the title null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-notitle-"));
  const filePath = path.join(dir, "session.jsonl");
  const rows = [
    { type: "user", sessionId: "t2", cwd: dir, timestamp: "2026-07-18T01:00:00Z", message: { content: "do the thing" } },
    { type: "assistant", sessionId: "t2", cwd: dir, timestamp: "2026-07-18T01:00:01Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 2 }, content: [] } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.title, null);
});

test("Codex session title comes from session_index.jsonl thread_name", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-title-"));
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "07", "18");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const rows = [
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: home, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: home, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:00:02Z", type: "event_msg", payload: { type: "user_message", message: "implement it" } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);
  fs.writeFileSync(
    path.join(home, ".codex", "session_index.jsonl"),
    `${JSON.stringify({ id: sessionId, thread_name: "Wire up billing webhook", updated_at: "2026-07-18T06:05:00Z" })}\n`,
  );

  const session = await scanCodexSession(filePath);
  assert.equal(session.title, "Wire up billing webhook");
});

test("incremental rebuild refreshes a Codex title when only session_index changes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-title-refresh-"));
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "07", "18");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${[
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: home, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: home, model: "gpt-5.6-sol" } },
  ].map(JSON.stringify).join("\n")}\n`);
  const indexPath = path.join(home, ".codex", "session_index.jsonl");
  fs.writeFileSync(indexPath, `${JSON.stringify({ id: sessionId, thread_name: "Original title" })}\n`);

  const first = await buildSessionAnalytics({ home, force: true });
  assert.equal(first[0].title, "Original title");

  // An index update is append-like in the real client; vary its size so the
  // fixture also reflects the filesystem signal used by incremental scanning.
  fs.writeFileSync(indexPath, `${JSON.stringify({ id: sessionId, thread_name: "Renamed title with more detail" })}\n`);
  const refreshed = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
  assert.equal(refreshed[0].title, "Renamed title with more detail");
});

test("Codex session without a session_index entry leaves the title null", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-notitle-"));
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "07", "18");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionId = "99999999-8888-7777-6666-555555555555";
  const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const rows = [
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: home, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: home, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:00:02Z", type: "event_msg", payload: { type: "user_message", message: "implement it" } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.title, null);
});

test("session browser merges same-session fragments into one resumable row", async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "tt-merge-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "tt-merge-b-"));
  // Two on-disk files carrying the SAME Claude session id (a resume + a
  // sub-agent sidechain) — they hash to the same session_hash.
  const write = async (dir, aiTitle) => {
    const filePath = path.join(dir, "session.jsonl");
    const rows = [
      { type: "user", sessionId: "shared-session", cwd: "/repo", timestamp: "2026-07-18T01:00:00Z", message: { content: "go" } },
      { type: "assistant", sessionId: "shared-session", cwd: "/repo", timestamp: "2026-07-18T01:05:00Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    ];
    if (aiTitle) rows.push({ type: "ai-title", sessionId: "shared-session", timestamp: "2026-07-18T01:06:00Z", aiTitle });
    fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);
    return scanClaudeSession(filePath);
  };
  const fragA = await write(dirA, null);
  const fragB = await write(dirB, "Ship the feature");
  assert.equal(fragA.session_hash, fragB.session_hash);

  const list = listSessionsForBrowser([fragA, fragB]);
  assert.equal(list.session_count, 1);
  assert.equal(list.sessions.length, 1);
  const merged = list.sessions[0];
  // Summed, non-overlapping token counts from both fragments.
  assert.equal(merged.total_tokens, fragA.total_tokens + fragB.total_tokens);
  assert.equal(merged.edit_turns, fragA.edit_turns + fragB.edit_turns);
  // Agent-authored title survives even when only one fragment carried it.
  assert.equal(merged.title, "Ship the feature");
  assert.equal(merged.resume_command, resumeCommandFor("claude", "shared-session"));
});

for (const largeFirst of [false, true]) {
  test(`Claude mixed-model fragments preserve cost regardless of order (${largeFirst ? "large" : "small"} first)`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-mixed-claude-fragments-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fragments = [];
    for (const [index, model, input] of [
      [0, "claude-haiku-4-5", 100_000],
      [1, "claude-sonnet-4-5", 1_000_000],
    ]) {
      const filePath = path.join(dir, `fragment-${index}.jsonl`);
      fs.writeFileSync(filePath, `${JSON.stringify({
        type: "assistant",
        sessionId: "shared-mixed-session",
        cwd: "/synthetic/repo",
        timestamp: `2026-09-01T00:0${index}:00Z`,
        message: {
          id: `unique-message-${index}`,
          model,
          usage: { input_tokens: input, output_tokens: 0 },
          content: [],
        },
      })}\n`);
      fragments.push(await scanClaudeSession(filePath));
    }
    if (largeFirst) fragments.reverse();
    const expectedCost = fragments.reduce((sum, row) => sum + row.cost_usd, 0);
    assert.equal(expectedCost, 3.1);
    assert.equal(summarizeSessions(fragments).summary.cost_usd, expectedCost);
    const merged = listSessionsForBrowser(fragments).sessions[0];
    assert.equal(merged.cost_usd, expectedCost);
    assert.equal(merged.model, "mixed");
    assert.equal(merged.total_tokens, 1_100_000);
    assert.equal(merged.model_usage.reduce((sum, row) => sum + row.cost_usd, 0), expectedCost);
  });
}

test("session browser source filter isolates codex from claude after merge", async () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-src-claude-"));
  const claudeFile = path.join(claudeDir, "session.jsonl");
  fs.writeFileSync(claudeFile, `${[
    { type: "user", sessionId: "c-1", cwd: "/repo", timestamp: "2026-07-18T01:00:00Z", message: { content: "hi" } },
    { type: "assistant", sessionId: "c-1", cwd: "/repo", timestamp: "2026-07-18T01:01:00Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 5, output_tokens: 1 }, content: [] } },
  ].map(JSON.stringify).join("\n")}\n`);
  const claude = await scanClaudeSession(claudeFile);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-src-codex-"));
  const codexDir = path.join(home, ".codex", "sessions", "2026", "07", "18");
  fs.mkdirSync(codexDir, { recursive: true });
  const codexId = "22222222-3333-4444-5555-666666666666";
  const codexFile = path.join(codexDir, `rollout-${codexId}.jsonl`);
  fs.writeFileSync(codexFile, `${[
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: codexId, cwd: home, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "t1", cwd: home, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:00:02Z", type: "event_msg", payload: { type: "user_message", message: "do" } },
    // Real usage matters: the browser lists only sessions that spent tokens.
    {
      timestamp: "2026-07-18T06:00:03Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 7, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 9 },
          total_token_usage: { input_tokens: 7, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 9 },
        },
      },
    },
  ].map(JSON.stringify).join("\n")}\n`);
  const codex = await scanCodexSession(codexFile);

  const all = [claude, codex];
  const codexOnly = listSessionsForBrowser(all).sessions.filter((row) => row.source === "codex");
  assert.equal(codexOnly.length, 1);
  assert.equal(codexOnly[0].source, "codex");
});

test("session browser hides sessions that never spent tokens", async () => {
  // Non-session logs under ~/.claude/projects (skill-injections.jsonl, …) and
  // sessions abandoned before the model replied both scan to token-less rows.
  // They used to render as "unknown · 0 tokens · $0.00" noise.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-empty-"));
  const file = path.join(dir, "journal.jsonl");
  fs.writeFileSync(file, `${[
    { type: "user", sessionId: "e-1", cwd: "/repo", timestamp: "2026-07-18T01:00:00Z", message: { content: "hi" } },
  ].map(JSON.stringify).join("\n")}\n`);
  const row = await scanClaudeSession(file);
  assert.equal(row.total_tokens, 0);
  assert.equal(listSessionsForBrowser([row]).sessions.length, 0);
});

test("local-only identity fields never reach the cloud or CSV surface", async () => {
  // title / session_id / project_ref exist so the browser can name and resume a
  // session, and project_ref is deliberately shown in the UI (the resume
  // command only works from that directory). They must stay on this machine:
  // summarizeSessions feeds both the cloud account view and the CSV export.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-privacy-"));
  const file = path.join(dir, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl");
  fs.writeFileSync(file, `${[
    { type: "ai-title", aiTitle: "TITLE-MUST-NOT-LEAVE-THIS-MACHINE", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    { type: "user", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: "/DIRNAME-MUST-NOT-LEAVE/myproject", timestamp: "2026-07-18T01:00:00Z", message: { content: "hi" } },
    { type: "assistant", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: "/DIRNAME-MUST-NOT-LEAVE/myproject", timestamp: "2026-07-18T01:01:00Z", message: { id: "p1", model: "claude-test", usage: { input_tokens: 5, output_tokens: 1 }, content: [] } },
  ].map(JSON.stringify).join("\n")}\n`);
  const row = await scanClaudeSession(file);

  // The local browser payload keeps all three.
  const local = listSessionsForBrowser([row]).sessions[0];
  assert.equal(local.title, "TITLE-MUST-NOT-LEAVE-THIS-MACHINE");
  assert.equal(local.project_ref, "/DIRNAME-MUST-NOT-LEAVE/myproject");
  assert.ok(local.session_id);
  // project_key (the directory's basename) is a different thing: project
  // attribution is a shipped cloud feature, so it is expected to travel.
  assert.equal(local.project_key, "myproject");

  // The cloud/CSV payload keeps none of them.
  const summary = summarizeSessions([row]);
  for (const cloudRow of summary.sessions) {
    for (const field of ["title", "session_id", "project_ref", "_cache_key"]) {
      assert.equal(field in cloudRow, false, `${field} must be stripped from the cloud payload`);
    }
  }
  const serialized = `${JSON.stringify(summary)}\n${sessionsToCsv(summary.sessions)}`;
  for (const secret of ["TITLE-MUST-NOT-LEAVE-THIS-MACHINE", "DIRNAME-MUST-NOT-LEAVE", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into a cloud/CSV payload`);
  }
});

test("a log with no sessionId record yields no resume command", async () => {
  // scanClaudeSession still falls back to the basename for stable grouping, but
  // session_id must stay null — otherwise a non-session log named journal.jsonl
  // produces `claude --resume journal`, which always fails.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-nosid-"));
  const file = path.join(dir, "journal.jsonl");
  fs.writeFileSync(file, `${[
    { type: "user", cwd: "/repo", timestamp: "2026-07-18T01:00:00Z", message: { content: "hi" } },
    { type: "assistant", cwd: "/repo", timestamp: "2026-07-18T01:01:00Z", message: { id: "n1", model: "claude-test", usage: { input_tokens: 5, output_tokens: 1 }, content: [] } },
  ].map(JSON.stringify).join("\n")}\n`);
  const row = await scanClaudeSession(file);
  assert.equal(row.session_id, null);
  assert.ok(row.total_tokens > 0, "fixture must spend tokens so the row is listed");
  assert.equal(listSessionsForBrowser([row]).sessions[0].resume_command, null);
});

test("session duration counts active time, not the resumed wall-clock span", async () => {
  // A resumed session's first and last timestamps can be months apart; the idle
  // gap between them is not working time (observed: 2142h on a 0-turn session).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dur-"));
  const file = path.join(dir, "d-1.jsonl");
  const line = (ts, extra = {}) => ({ type: "user", sessionId: "d-1", cwd: "/repo", timestamp: ts, message: { content: "hi" }, ...extra });
  fs.writeFileSync(file, `${[
    line("2026-05-01T00:00:00Z"),
    line("2026-05-01T00:05:00Z"),
    // Two months idle, then a resumed burst.
    line("2026-07-01T00:00:00Z"),
    line("2026-07-01T00:10:00Z"),
    { type: "assistant", sessionId: "d-1", cwd: "/repo", timestamp: "2026-07-01T00:10:30Z", message: { id: "d1", model: "claude-test", usage: { input_tokens: 5, output_tokens: 1 }, content: [] } },
  ].map(JSON.stringify).join("\n")}\n`);
  const row = await scanClaudeSession(file);
  // 5min + 10min + 30s of active work, not ~61 days.
  assert.equal(row.duration_ms, (5 * 60 + 10 * 60 + 30) * 1000);
  assert.ok(row.started_at < row.ended_at, "the true span is still recorded");
});

test("resume commands reject ids that could inject shell syntax", () => {
  assert.equal(resumeCommandFor("claude", "safe-session_01"), "claude --resume safe-session_01");
  assert.equal(
    resumeCommandFor("codex", "11111111-2222-3333-4444-555555555555"),
    "codex resume 11111111-2222-3333-4444-555555555555",
  );
  assert.equal(
    resumeCommandFor("grok", "019f740c-e792-7fb1-a218-59ea1b340714"),
    "grok --resume 019f740c-e792-7fb1-a218-59ea1b340714",
  );
  assert.equal(resumeCommandFor("claude", "--dangerous-flag"), null);
  assert.equal(resumeCommandFor("claude", "valid; touch /tmp/pwned"), null);
  assert.equal(resumeCommandFor("codex", "valid\nrm -rf workspace"), null);
  assert.equal(resumeCommandFor("grok", "valid; rm -rf /"), null);
});

test("Grok session analytics bills from turn_completed.usage and keeps titles local-only", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-session-"));
  const sessionId = "019f740c-e792-7fb1-a218-59ea1b340714";
  const secret = "TOP-SECRET-GROK-PROMPT-CONTENT";
  const updatesPath = writeGrokSessionFixture(home, {
    sessionId,
    cwd: "/work/myproject",
    title: "Refactor the auth module",
    signals: {
      turnCount: 1,
      primaryModelId: "grok-4.6",
      modelsUsed: ["grok-4.6"],
      contextTokensUsed: 31_445,
      contextWindowTokens: 500_000,
      contextWindowUsage: 6,
      toolCallCount: 2,
      toolFailureCount: 0,
      errorCount: 1,
      compactionCount: 0,
    },
    updates: [
      grokUpdate(sessionId, "user_message_chunk", {
        content: { type: "text", text: secret },
      }, { timestamp: 1_784_358_400, agentTimestampMs: 1_784_358_400_000 }),
      grokUpdate(sessionId, "tool_call", {
        toolCallId: "call-1",
        title: "search_replace",
        _meta: { "x.ai/tool": { name: "search_replace", kind: "edit" } },
      }, { timestamp: 1_784_358_410, agentTimestampMs: 1_784_358_410_000 }),
      grokUpdate(sessionId, "tool_call", {
        toolCallId: "call-2",
        title: "spawn_subagent",
        _meta: { "x.ai/tool": { name: "spawn_subagent", kind: "other" } },
      }, { timestamp: 1_784_358_415, agentTimestampMs: 1_784_358_415_000 }),
      grokUpdate(sessionId, "turn_completed", {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cachedReadTokens: 10,
          cacheCreationTokens: 10,
          reasoningTokens: 5,
          modelCalls: 7,
          apiDurationMs: 55_909,
          costUsdTicks: 1_304_860_000,
          modelUsage: {
            "grok-4.6": {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
              cachedReadTokens: 10,
              cacheCreationTokens: 10,
              reasoningTokens: 5,
              modelCalls: 7,
              apiDurationMs: 55_909,
              costUsdTicks: 1_304_860_000,
            },
          },
        },
      }, { timestamp: 1_784_358_430, agentTimestampMs: 1_784_358_430_000 }),
    ],
  });

  const session = await scanGrokSession(updatesPath);
  assert.equal(session.source, "grok");
  assert.equal(session.session_id, sessionId);
  assert.equal(session.title, "Refactor the auth module");
  assert.equal(session.project_key, "myproject");
  assert.equal(session.project_ref, "/work/myproject");
  assert.equal(session.turns, 1);
  assert.equal(session.edit_turns, 1);
  assert.equal(session.retry_turns, 0);
  assert.equal(session.one_shot, true);
  assert.equal(session.subagent_calls, 1);
  assert.equal(session.subagent_types.spawn_subagent, 1);
  // Grok inputTokens is cache-inclusive, and outputTokens includes reasoning.
  // All stored columns are mutually exclusive and still sum to totalTokens.
  assert.equal(session.total_tokens, 120);
  assert.equal(session.tokens.input_tokens, 80);
  assert.equal(session.tokens.cached_input_tokens, 10);
  assert.equal(session.tokens.cache_creation_input_tokens, 10);
  assert.equal(session.tokens.output_tokens, 15);
  assert.equal(session.tokens.reasoning_output_tokens, 5);
  assert.equal(session.model, "grok-4.6");
  assert.equal(session.cost_usd, 0.130486);
  assert.equal(session.cost_source, "provider_reported");
  assert.equal(session.usage_precision, "reported");
  assert.equal(session.model_calls, 7);
  assert.equal(session.api_duration_ms, 55_909);
  // Prompt body never lands in the metadata row.
  assert.equal(JSON.stringify(session).includes(secret), false);

  const summary = summarizeSessions([session]);
  assert.equal(Object.hasOwn(summary.sessions[0], "title"), false);
  assert.equal(Object.hasOwn(summary.sessions[0], "project_ref"), false);
  assert.equal(Object.hasOwn(summary.sessions[0], "session_id"), false);

  const browser = listSessionsForBrowser([session]);
  assert.equal(browser.sessions.length, 1);
  assert.equal(browser.sessions[0].title, "Refactor the auth module");
  assert.equal(browser.sessions[0].resume_command, `grok --resume ${sessionId}`);
  assert.equal(browser.sessions[0].cache_creation_input_tokens, 10);
  assert.equal(browser.sessions[0].reasoning_output_tokens, 5);
  assert.equal(browser.sessions[0].cost_source, "provider_reported");
  assert.equal(browser.sessions[0].context_tokens_used, 31_445);
  assert.equal(browser.sessions[0].context_window_tokens, 500_000);
  assert.equal(browser.sessions[0].error_count, 1);
});

test("Grok session analytics counts repeated prompts as retries across turns", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-retry-"));
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const prompt = "make the requested change";
  const usage = {
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    modelUsage: { "grok-4.5": { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
  };
  const updatesPath = writeGrokSessionFixture(home, {
    sessionId,
    title: "Retry fixture",
    updates: [
      grokUpdate(sessionId, "user_message_chunk", { content: { type: "text", text: prompt } }, { timestamp: 100, agentTimestampMs: 100_000 }),
      grokUpdate(sessionId, "tool_call", {
        title: "search_replace",
        _meta: { "x.ai/tool": { name: "search_replace" } },
      }, { timestamp: 101, agentTimestampMs: 101_000 }),
      grokUpdate(sessionId, "turn_completed", { usage }, { timestamp: 102, agentTimestampMs: 102_000 }),
      grokUpdate(sessionId, "user_message_chunk", { content: { type: "text", text: prompt } }, { timestamp: 103, agentTimestampMs: 103_000 }),
      grokUpdate(sessionId, "turn_completed", { usage }, { timestamp: 104, agentTimestampMs: 104_000 }),
    ],
  });

  const session = await scanGrokSession(updatesPath);
  assert.equal(session.turns, 2);
  assert.equal(session.edit_turns, 1);
  assert.equal(session.retry_turns, 1);
  assert.equal(session.one_shot, false);
  assert.equal(session.total_tokens, 24);
});

test("Grok discovery builds sessions from ~/.grok/sessions layout", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-discover-"));
  const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  writeGrokSessionFixture(home, {
    sessionId,
    cwd: "/repo/alpha",
    title: "Discovered Grok session",
    updates: [
      grokUpdate(sessionId, "user_message_chunk", { content: { type: "text", text: "hi" } }, { timestamp: 200, agentTimestampMs: 200_000 }),
      grokUpdate(sessionId, "turn_completed", {
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
          cachedReadTokens: 0,
          reasoningTokens: 0,
          modelUsage: { "grok-4.5": { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
        },
      }, { timestamp: 210, agentTimestampMs: 210_000 }),
    ],
  });

  // Pin Grok home to the fixture tree so a developer-exported GROK_HOME /
  // TOKENTRACKER_GROK_HOME cannot pull real sessions into this unit test.
  const prevGrokHome = process.env.GROK_HOME;
  const prevTtGrokHome = process.env.TOKENTRACKER_GROK_HOME;
  delete process.env.GROK_HOME;
  delete process.env.TOKENTRACKER_GROK_HOME;
  try {
    const rows = await buildSessionAnalytics({ home, force: true });
    const grokRows = rows.filter((row) => row.source === "grok");
    assert.equal(grokRows.length, 1);
    assert.equal(grokRows[0].session_id, sessionId);
    assert.equal(grokRows[0].title, "Discovered Grok session");
    assert.equal(grokRows[0].total_tokens, 10);

    const browser = listSessionsForBrowser(rows);
    const grokOnly = browser.sessions.filter((row) => row.source === "grok");
    assert.equal(grokOnly.length, 1);
    assert.equal(grokOnly[0].resume_command, `grok --resume ${sessionId}`);
  } finally {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    if (prevTtGrokHome === undefined) delete process.env.TOKENTRACKER_GROK_HOME;
    else process.env.TOKENTRACKER_GROK_HOME = prevTtGrokHome;
  }
});

test("Grok tool-only turn after turn_completed still increments turns", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-tool-only-"));
  const sessionId = "dddddddd-eeee-4fff-8000-111111111111";
  const usage = {
    inputTokens: 20,
    outputTokens: 5,
    totalTokens: 25,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    modelUsage: { "grok-4.5": { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
  };
  const updatesPath = writeGrokSessionFixture(home, {
    sessionId,
    title: "Tool-only follow-up",
    updates: [
      grokUpdate(sessionId, "user_message_chunk", { content: { type: "text", text: "first" } }, { timestamp: 100, agentTimestampMs: 100_000 }),
      grokUpdate(sessionId, "turn_completed", { usage }, { timestamp: 101, agentTimestampMs: 101_000 }),
      // No new user_message_chunk — only a tool after the previous turn closed.
      grokUpdate(sessionId, "tool_call", {
        title: "search_replace",
        _meta: { "x.ai/tool": { name: "search_replace" } },
      }, { timestamp: 102, agentTimestampMs: 102_000 }),
      grokUpdate(sessionId, "turn_completed", { usage }, { timestamp: 103, agentTimestampMs: 103_000 }),
    ],
  });

  const session = await scanGrokSession(updatesPath);
  assert.equal(session.turns, 2);
  assert.equal(session.edit_turns, 1);
  assert.ok(session.edit_turns <= session.turns);
  assert.equal(session.total_tokens, 50);
});

test("Grok does not invent billable tokens from context window occupancy", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-nocontxt-"));
  const sessionId = "cccccccc-dddd-4eee-8fff-000000000000";
  // Only a user chunk — no turn_completed.usage. signals.contextTokensUsed is
  // deliberately huge and must not become total_tokens.
  const updatesPath = writeGrokSessionFixture(home, {
    sessionId,
    title: "Empty billable",
    signals: { turnCount: 1, primaryModelId: "grok-4.5", contextTokensUsed: 500_000 },
    updates: [
      grokUpdate(sessionId, "user_message_chunk", { content: { type: "text", text: "hi" } }),
    ],
  });
  const session = await scanGrokSession(updatesPath);
  assert.equal(session.total_tokens, 0);
  assert.equal(listSessionsForBrowser([session]).sessions.length, 0);
});

test("by_model sums tokens and cost exactly while session headcount overlaps by design", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-bymodel-sum-"));
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const writeSession = (id, turns) => {
    const filePath = path.join(dir, `rollout-2026-07-19T08-00-00-00000000-0000-4000-8000-00000000000${id}.jsonl`);
    const rows = [
      { timestamp: "2026-07-19T08:00:00Z", type: "session_meta", payload: { id: `codex-sum-${id}`, cwd: dir, model_provider: "openai" } },
    ];
    let running = 0;
    turns.forEach(([model, input, output], index) => {
      running += input + output;
      rows.push({ timestamp: `2026-07-19T08:0${index}:01Z`, type: "turn_context", payload: { turn_id: `turn-${index}`, cwd: dir, model } });
      // Every turn edits, so edit_turns is non-zero and the edit_* columns below
      // are actually exercised rather than reconciling 0 against 0.
      rows.push({ timestamp: `2026-07-19T08:0${index}:01.5Z`, type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "{}" } });
      rows.push({ timestamp: `2026-07-19T08:0${index}:02Z`, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(input, output), total_token_usage: usage(running, 0) } } });
    });
    fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);
    return filePath;
  };

  // One session switches models mid-thread, one stays on a single model.
  const mixed = await scanCodexSession(writeSession(1, [["gpt-5.6-sol", 100, 20], ["gpt-5.6-terra", 50, 10]]));
  const single = await scanCodexSession(writeSession(2, [["gpt-5.6-sol", 40, 8]]));
  const summary = summarizeSessions([mixed, single]);

  // Token, cost and edit columns are fully observed per model, so they
  // reconcile with the session totals to the last unit.
  const sum = (key) => summary.by_model.reduce((acc, row) => acc + row[key], 0);
  assert.equal(sum("total_tokens"), summary.summary.total_tokens);
  assert.equal(sum("edit_turns"), summary.summary.edit_turns);
  assert.equal(sum("edit_tokens"), summary.summary.edit_tokens);
  assert.equal(sum("retries"), summary.summary.retries);
  assert.ok(Math.abs(sum("cost_usd") - summary.summary.cost_usd) < 1e-12);
  assert.ok(Math.abs(sum("edit_cost_usd") - summary.summary.edit_cost_usd) < 1e-12);
  assert.ok(summary.summary.edit_turns > 0);
  assert.ok(summary.summary.edit_tokens > 0);

  // The session headcount deliberately overlaps: the mixed session is counted
  // under both models, so summing this column overstates the real total.
  assert.equal(summary.summary.sessions, 2);
  assert.equal(sum("sessions"), 3);
  assert.equal(summary.session_count, 2);
});

test("per-model tokens_per_edit divides one model's tokens by that model's own edit turns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-tokens-per-edit-"));
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const filePath = path.join(dir, "rollout-2026-07-21T08-00-00-00000000-0000-4000-8000-00000000000a.jsonl");
  const rows = [
    { timestamp: "2026-07-21T08:00:00Z", type: "session_meta", payload: { id: "codex-tpe", cwd: dir, model_provider: "openai" } },
  ];
  let running = 0;
  // One edit turn per model, but the models spend very different amounts.
  [["gpt-5.6-sol", 1000, 200], ["gpt-5.6-terra", 500, 100]].forEach(([model, input, output], index) => {
    running += input + output;
    rows.push({ timestamp: `2026-07-21T08:0${index}:01Z`, type: "turn_context", payload: { turn_id: `turn-${index}`, cwd: dir, model } });
    rows.push({ timestamp: `2026-07-21T08:0${index}:01.5Z`, type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "{}" } });
    rows.push({ timestamp: `2026-07-21T08:0${index}:02Z`, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(input, output), total_token_usage: usage(running, 0) } } });
  });
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.edit_turns, 2);
  const summary = summarizeSessions([session]);
  const byModel = Object.fromEntries(summary.by_model.map((row) => [row.model, row]));

  // Each turn belongs to exactly one model, so each model owns one edit turn
  // and its own tokens. Before per-model edit turns the busiest model divided
  // its 1200 tokens by the whole session's 2 edit turns and reported 600.
  assert.equal(byModel["gpt-5.6-sol"].edit_turns, 1);
  assert.equal(byModel["gpt-5.6-terra"].edit_turns, 1);
  assert.equal(byModel["gpt-5.6-sol"].tokens_per_edit, 1200);
  assert.equal(byModel["gpt-5.6-terra"].tokens_per_edit, 600);
  assert.equal(summary.summary.tokens_per_edit, 900);
});

test("a sidecar without per-model edit turns still sums to the session's edit turns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-editturn-skew-"));
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const filePath = path.join(dir, "rollout-2026-07-22T08-00-00-00000000-0000-4000-8000-00000000000b.jsonl");
  const rows = [
    { timestamp: "2026-07-22T08:00:00Z", type: "session_meta", payload: { id: "codex-skew", cwd: dir, model_provider: "openai" } },
  ];
  let running = 0;
  [["gpt-5.6-sol", 1000, 200], ["gpt-5.6-terra", 500, 100]].forEach(([model, input, output], index) => {
    running += input + output;
    rows.push({ timestamp: `2026-07-22T08:0${index}:01Z`, type: "turn_context", payload: { turn_id: `turn-${index}`, cwd: dir, model } });
    rows.push({ timestamp: `2026-07-22T08:0${index}:01.5Z`, type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "{}" } });
    rows.push({ timestamp: `2026-07-22T08:0${index}:02Z`, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(input, output), total_token_usage: usage(running, 0) } } });
  });
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  // A sidecar written before model_usage carried edit_turns: the rows are
  // otherwise intact, they just have no per-model turn counts to read.
  const session = await scanCodexSession(filePath);
  const stale = {
    ...session,
    model_usage: session.model_usage.map(({ edit_turns: _editTurns, ...row }) => row),
  };
  const summary = summarizeSessions([stale]);
  const sum = (key) => summary.by_model.reduce((acc, row) => acc + row[key], 0);

  // The whole residual lands on the busiest model rather than being dropped,
  // so the column still reconciles and no edit turn goes missing.
  assert.equal(sum("edit_turns"), summary.summary.edit_turns);
  assert.equal(sum("edit_tokens"), summary.summary.edit_tokens);
  const byModel = Object.fromEntries(summary.by_model.map((row) => [row.model, row]));
  assert.equal(byModel["gpt-5.6-sol"].edit_turns, 2);
  assert.equal(byModel["gpt-5.6-terra"].edit_turns, 0);
});

test("model_usage reaches the browser dense whatever the sidecar stored", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-dense-usage-"));
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const codexPath = path.join(dir, "rollout-2026-07-23T08-00-00-00000000-0000-4000-8000-00000000000c.jsonl");
  fs.writeFileSync(codexPath, `${[
    { timestamp: "2026-07-23T08:00:00Z", type: "session_meta", payload: { id: "codex-dense", cwd: dir, model_provider: "openai" } },
    { timestamp: "2026-07-23T08:00:01Z", type: "turn_context", payload: { turn_id: "turn-0", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-23T08:00:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(100, 20), total_token_usage: usage(120, 0) } } },
  ].map(JSON.stringify).join("\n")}\n`);

  // Both providers now persist per-model usage; legacy rows still exercise
  // the fallback branch that used to emit a six-field row.
  const claudePath = path.join(dir, "claude.jsonl");
  fs.writeFileSync(claudePath, `${[
    { type: "user", sessionId: "dense-1", cwd: dir, timestamp: "2026-07-23T09:00:00Z", message: { content: "do the thing" } },
    { type: "assistant", sessionId: "dense-1", cwd: dir, timestamp: "2026-07-23T09:00:01Z", message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 20 }, content: [] } },
  ].map(JSON.stringify).join("\n")}\n`);

  const codex = await scanCodexSession(codexPath);
  const claude = await scanClaudeSession(claudePath);
  assert.equal(Array.isArray(claude.model_usage), true);

  const legacy = { ...claude, session_hash: "legacy", model_usage: undefined };
  const listed = listSessionsForBrowser([codex, claude, legacy]).sessions;
  assert.equal(listed.length, 3);
  const keySets = listed.map((row) => {
    assert.ok(Array.isArray(row.model_usage) && row.model_usage.length > 0);
    return Object.keys(row.model_usage[0]).sort();
  });

  // Both producer paths must emit the identical key set, or dashboard/src/lib/
  // sessions-api.ts is describing a row shape that only one of them sends.
  assert.deepEqual(keySets[0], keySets[1]);
  assert.deepEqual(keySets[0], keySets[2]);
  for (const field of [
    "model",
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "long_context_input_tokens",
    "long_context_cached_input_tokens",
    "long_context_cache_creation_input_tokens",
    "long_context_output_tokens",
    "long_context_reasoning_output_tokens",
    "usage_events",
    "rerouted_usage_events",
    "long_context_usage_events",
    "edit_turns",
    "selected_models",
    "reroute_reasons",
    "model_attribution",
    "cost_usd",
  ]) {
    assert.ok(keySets[0].includes(field), `model_usage row is missing ${field}`);
  }
});

test("sidecar omits reconstructible model_usage fields without losing information", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-sidecar-trim-"));
  const codexDir = path.join(home, ".codex", "sessions", "2026", "07", "20");
  fs.mkdirSync(codexDir, { recursive: true });
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const rows = [
    { timestamp: "2026-07-20T08:00:00Z", type: "session_meta", payload: { id: "codex-trim", cwd: home, model_provider: "openai" } },
    { timestamp: "2026-07-20T08:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: home, model: "gpt-5.6-sol" } },
    // Only the first turn edits, so edit_turns is 1 on one row and 0 on the
    // other - the non-zero value must survive the trim, the zero must not.
    { timestamp: "2026-07-20T08:00:01.5Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "{}" } },
    { timestamp: "2026-07-20T08:00:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(100, 20), total_token_usage: usage(100, 20) } } },
    { timestamp: "2026-07-20T08:01:01Z", type: "turn_context", payload: { turn_id: "turn-2", cwd: home, model: "gpt-5.6-terra" } },
    { timestamp: "2026-07-20T08:01:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(50, 10), total_token_usage: usage(150, 30) } } },
  ];
  fs.writeFileSync(
    path.join(codexDir, "rollout-2026-07-20T08-00-00-00000000-0000-4000-8000-000000000004.jsonl"),
    `${rows.map(JSON.stringify).join("\n")}\n`,
  );

  const cold = await buildSessionAnalytics({ home, force: true });
  const sidecar = fs.readFileSync(path.join(home, ".tokentracker", "tracker", "session.queue.jsonl"), "utf8");
  const persistedRows = JSON.parse(sidecar.split("\n").filter(Boolean)[0]).model_usage;
  const persisted = persistedRows[0];

  // Zero counters, a selected_models that only repeats the model, the default
  // attribution and the recomputed cost are all dropped on write.
  assert.equal(persisted.long_context_input_tokens, undefined);
  assert.equal(persisted.long_context_usage_events, undefined);
  assert.equal(persisted.rerouted_usage_events, undefined);
  assert.equal(persisted.selected_models, undefined);
  assert.equal(persisted.reroute_reasons, undefined);
  assert.equal(persisted.model_attribution, undefined);
  assert.equal(persisted.cost_usd, undefined);
  assert.ok(persisted.total_tokens > 0);

  // Re-reading the trimmed sidecar rebuilds every dropped field.
  const warm = await buildSessionAnalytics({ home });
  assert.deepEqual(
    warm.map((row) => row.model_usage),
    cold.map((row) => row.model_usage),
  );
  assert.deepEqual(warm.map((row) => row.cost_usd), cold.map((row) => row.cost_usd));
  const restored = warm[0].model_usage.find((row) => row.model === "gpt-5.6-sol");
  assert.deepEqual(restored.selected_models, ["gpt-5.6-sol"]);
  assert.equal(restored.model_attribution, "selected");
  assert.equal(restored.long_context_input_tokens, 0);

  // Per-model edit turns follow the same rule: written only when non-zero,
  // rebuilt as 0 otherwise, and unchanged across the trim.
  const persistedSol = persistedRows.find((row) => row.model === "gpt-5.6-sol");
  const persistedTerra = persistedRows.find((row) => row.model === "gpt-5.6-terra");
  assert.equal(persistedSol.edit_turns, 1);
  assert.equal(persistedTerra.edit_turns, undefined);
  assert.equal(restored.edit_turns, 1);
  assert.equal(warm[0].model_usage.find((row) => row.model === "gpt-5.6-terra").edit_turns, 0);
});

test("a mid-turn reroute moves the open turn's edits onto the model that is now billed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-reroute-edit-"));
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const filePath = path.join(dir, "rollout-2026-07-24T08-00-00-00000000-0000-4000-8000-00000000000d.jsonl");
  fs.writeFileSync(filePath, `${[
    { timestamp: "2026-07-24T08:00:00Z", type: "session_meta", payload: { id: "codex-reroute-edit", cwd: dir, model_provider: "openai" } },
    { timestamp: "2026-07-24T08:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-24T08:00:02Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "{}" } },
    { timestamp: "2026-07-24T08:00:03Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(1000, 200), total_token_usage: usage(1000, 200) } } },
    { timestamp: "2026-07-24T08:00:04Z", method: "model/rerouted", params: { threadId: "codex-reroute-edit", turnId: "turn-1", fromModel: "gpt-5.6-sol", toModel: "gpt-5.6-terra", reason: "capacity" } },
    { timestamp: "2026-07-24T08:00:05Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "{}" } },
    { timestamp: "2026-07-24T08:00:06Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(3000, 300), total_token_usage: usage(4000, 500) } } },
    { timestamp: "2026-07-24T08:01:00Z", type: "turn_context", payload: { turn_id: "turn-2", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-24T08:01:01Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "{}" } },
    { timestamp: "2026-07-24T08:01:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(500, 100), total_token_usage: usage(4500, 600) } } },
  ].map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.model, "mixed");
  assert.equal(session.edit_turns, 2);
  const byModel = Object.fromEntries(session.model_usage.map((row) => [row.model, row]));
  assert.equal(byModel["gpt-5.6-terra"].total_tokens, 3300);
  assert.equal(byModel["gpt-5.6-sol"].total_tokens, 1800);

  // turn-1 was rerouted to terra partway through, so terra pays for the rest of
  // that turn's tokens and owns its edit. The reroute does not leak past the
  // turn boundary: turn-2 starts a fresh turn_context back on sol.
  assert.equal(byModel["gpt-5.6-terra"].edit_turns, 1);
  assert.equal(byModel["gpt-5.6-sol"].edit_turns, 1);

  const summary = summarizeSessions([session]);
  assert.equal(
    summary.by_model.reduce((acc, row) => acc + row.edit_turns, 0),
    summary.summary.edit_turns,
  );
});

test("a Codex session whose only model signal is session_meta attributes rather than falling to unknown", async () => {
  // The field has never been observed in a real rollout (0 of 10310
  // session_meta rows across 5849 local files), so the fixture is synthetic by
  // necessity. It guards the fallback, not the format: without it a session
  // that named a model only in its metadata bills every token to "unknown"
  // and renders as an unpriced session.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-meta-model-"));
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 0,
    total_tokens: 120,
  };
  const filePath = path.join(dir, "rollout-2026-07-25T08-00-00-00000000-0000-4000-8000-00000000000e.jsonl");
  fs.writeFileSync(filePath, `${[
    { timestamp: "2026-07-25T08:00:00Z", type: "session_meta", payload: { id: "codex-meta-model", cwd: dir, model_provider: "openai", model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-25T08:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } },
  ].map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.model, "gpt-5.6-sol");
  assert.deepEqual(session.model_usage.map((row) => [row.model, row.total_tokens]), [["gpt-5.6-sol", 120]]);
  assert.equal(session.model_usage[0].model_attribution, "selected");
  assert.ok(session.cost_usd > 0, "an attributed model is priced; unknown is not");
});
