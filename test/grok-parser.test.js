"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseGrokBuildIncremental,
  resolveGrokBuildSessions,
} = require("../src/lib/rollout");
const { computeRowCost, ensurePricingLoaded, getModelPricing } = require("../src/lib/pricing");
const { normalizeGrokUsage } = require("../src/lib/grok-usage");

function makeSession({
  sessionId = "019f0000-test-session",
  model = "grok-4.5",
  turns = [],
  contextMetas = [],
  signals = {},
  cwd = "/tmp/project",
  summaryInfo,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-parser-"));
  const encodedCwd = encodeURIComponent(cwd);
  const sessionDir = path.join(root, "sessions", encodedCwd, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const lines = [];
  let eventN = 1;
  for (const totalTokens of contextMetas) {
    lines.push(
      JSON.stringify({
        timestamp: 1784357000 + eventN,
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "..." },
          },
          _meta: {
            totalTokens,
            eventId: `${sessionId}-${eventN}`,
            agentTimestampMs: 1784357000000 + eventN * 1000,
            updateType: "AgentThoughtChunk",
          },
        },
      }),
    );
    eventN += 1;
  }
  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        timestamp: 1784357000 + eventN,
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: turn.promptId || `prompt-${eventN}`,
            stop_reason: "end_turn",
            usage: turn.usage,
          },
          _meta: {
            totalTokens: turn.contextWindowTokens ?? 12_000,
            eventId: `${sessionId}-${eventN}`,
            agentTimestampMs: turn.timestampMs || 1784357100000 + eventN * 1000,
          },
        },
      }),
    );
    eventN += 1;
  }

  fs.writeFileSync(path.join(sessionDir, "updates.jsonl"), `${lines.join("\n")}\n`);
  fs.writeFileSync(
    path.join(sessionDir, "signals.json"),
    JSON.stringify({
      primaryModelId: model,
      modelsUsed: [model],
      assistantMessageCount: turns.length || 1,
      contextTokensUsed: signals.contextTokensUsed ?? 50_000,
      totalTokensBeforeCompaction: signals.totalTokensBeforeCompaction ?? 0,
      lastActiveAt: "2026-07-18T10:00:00.000Z",
      ...signals,
    }),
  );
  const summary = { updated_at: "2026-07-18T10:00:00.000Z" };
  if (summaryInfo && typeof summaryInfo === "object") summary.info = summaryInfo;
  fs.writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify(summary));

  return {
    root,
    sessionDir,
    sessionId,
    cwd,
    encodedCwd,
    env: { TOKENTRACKER_GROK_HOME: root, GROK_HOME: root },
  };
}

function writeGitOrigin(repoDir, url) {
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
}

function appendGrokTurn(sessionDir, turn, { timestampMs, eventId } = {}) {
  const sessionId = path.basename(sessionDir);
  const line = JSON.stringify({
    timestamp: Math.floor((timestampMs || Date.now()) / 1000),
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: turn.promptId || "prompt-growth",
        stop_reason: "end_turn",
        usage: turn.usage,
      },
      _meta: {
        totalTokens: turn.contextWindowTokens ?? 12_000,
        eventId: eventId || `${sessionId}-growth`,
        agentTimestampMs: timestampMs || Date.now(),
      },
    },
  });
  fs.appendFileSync(path.join(sessionDir, "updates.jsonl"), `${line}\n`);
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function dedupeQueue(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (row.source !== "grok") continue;
    seen.set(`${row.model}|${row.hour_start}`, row);
  }
  return [...seen.values()];
}

test("normalizeGrokUsage handles ACP cache writes, reasoning, and cost completeness", () => {
  const reported = normalizeGrokUsage({
    inputTokens: 100,
    cachedReadTokens: 20,
    cacheCreationTokens: 10,
    outputTokens: 30,
    reasoningTokens: 10,
    totalTokens: 130,
    costUsdTicks: 123_000_000,
    modelCalls: 2,
    apiDurationMs: 456,
  });
  assert.deepEqual(reported, {
    input_tokens: 70,
    cached_input_tokens: 20,
    cache_creation_input_tokens: 10,
    output_tokens: 20,
    reasoning_output_tokens: 10,
    total_tokens: 130,
    billable_total_tokens: 130,
    total_cost_usd: 0.0123,
    cost_is_partial: false,
    usage_is_incomplete: false,
    model_calls: 2,
    api_duration_ms: 456,
    cost_coverage: { version: 1, reported_usd: 0.0123, reported_events: 1, missing_events: 0, allocated_events: 0, origins: ["grok_ticks"], unreported_tokens: { input_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
  });

  const partial = normalizeGrokUsage({
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    costUsdTicks: 50_000_000,
    costIsPartial: true,
  });
  assert.equal(partial.total_cost_usd, null);
  assert.equal(partial.cost_is_partial, true);

  const headless = normalizeGrokUsage({
    input_tokens: 70,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
    output_tokens: 30,
    reasoning_output_tokens: 10,
    total_tokens: 130,
  });
  assert.equal(headless.input_tokens, 70, "snake_case input is already non-cached");
  assert.equal(headless.output_tokens, 20);
});

test("parseGrokBuildIncremental prefers turn_completed.usage over context-window totalTokens", async () => {
  const fixture = makeSession({
    contextMetas: [10_000, 40_000, 90_000],
    turns: [
      {
        usage: {
          inputTokens: 100_000,
          outputTokens: 500,
          totalTokens: 100_500,
          cachedReadTokens: 20_000,
          cacheCreationTokens: 500,
          reasoningTokens: 100,
          costUsdTicks: 1_000_000_000,
          modelUsage: {
            "grok-4.5-build": {
              inputTokens: 100_000,
              outputTokens: 500,
              totalTokens: 100_500,
              cachedReadTokens: 20_000,
              cacheCreationTokens: 500,
              reasoningTokens: 100,
              costUsdTicks: 1_000_000_000,
            },
          },
        },
        timestampMs: Date.parse("2026-07-18T10:05:00.000Z"),
      },
      {
        usage: {
          inputTokens: 50_000,
          outputTokens: 200,
          totalTokens: 50_200,
          cachedReadTokens: 10_000,
          cacheCreationTokens: 200,
          reasoningTokens: 40,
          costUsdTicks: 500_000_000,
          modelUsage: {
            "grok-4.5-build": {
              inputTokens: 50_000,
              outputTokens: 200,
              totalTokens: 50_200,
              cachedReadTokens: 10_000,
              cacheCreationTokens: 200,
              reasoningTokens: 40,
              costUsdTicks: 500_000_000,
            },
          },
        },
        timestampMs: Date.parse("2026-07-18T10:20:00.000Z"),
      },
    ],
    signals: { contextTokensUsed: 90_000, totalTokensBeforeCompaction: 200_000 },
  });

  const queuePath = path.join(fixture.root, "queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 3 },
  };
  const result = await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });

  assert.equal(result.eventsAggregated, 2);
  assert.equal(cursors.grok.version, 6);

  const snap = cursors.grok.sessionSnapshots[fixture.sessionId];
  assert.ok(snap);
  assert.equal(snap.source, "turn_usage");
  assert.equal(snap.totalTokens, 150_700);

  const rows = dedupeQueue(readQueue(queuePath));
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.model, "grok-4.5-build");
  assert.equal(row.total_tokens, 150_700);
  assert.equal(row.input_tokens, 119_300);
  assert.equal(row.cached_input_tokens, 30_000);
  assert.equal(row.cache_creation_input_tokens, 700);
  assert.equal(row.output_tokens, 560);
  assert.equal(row.reasoning_output_tokens, 140);
  assert.equal(row.total_cost_usd, 0.15);
  assert.equal(computeRowCost(row), 0.15);
  assert.equal(row.usage_precision, "reported");
  assert.equal(row.conversation_count, 2);

  const secondResult = await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });
  assert.equal(secondResult.eventsAggregated, 0);
  assert.equal(secondResult.bucketsQueued, 0);
  assert.deepEqual(dedupeQueue(readQueue(queuePath)), [row]);
});

test("parseGrokBuildIncremental canonicalizes free Build SKU so pricing stays $0", async () => {
  await ensurePricingLoaded();
  assert.equal(getModelPricing("grok-build-free", { source: "grok" }).input, 0);
  assert.equal(getModelPricing("grok-4.5-build-free", { source: "grok" }).input, 0);
  assert.equal(getModelPricing("grok-4.5-build", { source: "grok" }).input, 2);

  const fixture = makeSession({
    turns: [
      {
        usage: {
          inputTokens: 21219,
          outputTokens: 102,
          totalTokens: 21321,
          cachedReadTokens: 1280,
          reasoningTokens: 54,
          modelUsage: {
            "grok-4.5-build-free": {
              inputTokens: 21219,
              outputTokens: 102,
              totalTokens: 21321,
              cachedReadTokens: 1280,
              reasoningTokens: 54,
            },
          },
        },
        timestampMs: Date.parse("2026-07-18T11:00:00.000Z"),
      },
    ],
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 4 },
  };
  await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });
  const rows = dedupeQueue(readQueue(queuePath));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "grok-build-free");
  assert.equal(computeRowCost(rows[0]), 0);
});

test("parseGrokBuildIncremental falls back to context watermark only without turn_completed", async () => {
  const fixture = makeSession({
    turns: [],
    contextMetas: [5_000, 12_000, 8_000, 20_000],
    signals: { contextTokensUsed: 18_000, totalTokensBeforeCompaction: 0 },
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 4 },
  };
  await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });
  const snap = cursors.grok.sessionSnapshots[fixture.sessionId];
  assert.ok(snap);
  assert.equal(snap.source, "updates");
  assert.equal(snap.totalTokens, 20_000);
  const rows = dedupeQueue(readQueue(queuePath));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_tokens, 20_000);
  assert.equal(rows[0].input_tokens + rows[0].output_tokens, 20_000);
  assert.equal(rows[0].usage_precision, "estimated");
});

test("v4 -> v6 migration rebuilds Grok rows with mutually exclusive token columns", async () => {
  const fixture = makeSession({
    turns: [
      {
        usage: {
          inputTokens: 80_000,
          outputTokens: 1_000,
          totalTokens: 81_000,
          cachedReadTokens: 0,
          modelUsage: {
            "grok-4.5": {
              inputTokens: 80_000,
              outputTokens: 1_000,
              totalTokens: 81_000,
              cachedReadTokens: 0,
            },
          },
        },
        timestampMs: Date.parse("2026-07-18T12:00:00.000Z"),
      },
    ],
    contextMetas: [9_000],
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const cursors = {
    hourly: {
      version: 3,
      buckets: {
        "grok|grok-4.5|2026-07-18T12:00:00.000Z": {
          totals: {
            input_tokens: 7200,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 1800,
            reasoning_output_tokens: 0,
            total_tokens: 9000,
            billable_total_tokens: 9000,
            conversation_count: 1,
          },
          queuedKey: "x",
        },
      },
      groupQueued: {},
    },
    grok: {
      version: 4,
      sessionSnapshots: {
        [fixture.sessionId]: {
          totalTokens: 9000,
          messageCount: 1,
          model: "grok-4.5",
          source: "updates",
          updatedAt: "2026-07-18T12:00:00.000Z",
        },
      },
    },
  };
  fs.writeFileSync(
    queuePath,
    `${JSON.stringify({
      source: "grok",
      model: "grok-4.5",
      hour_start: "2026-07-18T12:00:00.000Z",
      input_tokens: 7200,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 1800,
      reasoning_output_tokens: 0,
      total_tokens: 9000,
      billable_total_tokens: 9000,
      conversation_count: 1,
    })}\n`,
  );

  await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });

  assert.equal(cursors.grok.version, 6);
  assert.equal(cursors.grok.sessionSnapshots[fixture.sessionId].totalTokens, 81_000);
  const rows = dedupeQueue(readQueue(queuePath));
  const row = rows.find((r) => r.model === "grok-4.5");
  assert.ok(row);
  assert.equal(row.total_tokens, 81_000);
  assert.equal(row.input_tokens, 80_000);
  assert.equal(row.output_tokens, 1_000);
});

function grokTurnUsage(overrides = {}) {
  const { modelName = "grok-4.5-build", timestampMs, promptId, ...usageOverrides } = overrides;
  const usage = {
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1220,
    cachedReadTokens: 100,
    reasoningTokens: 20,
    ...usageOverrides,
  };
  return {
    usage: {
      ...usage,
      modelUsage: {
        [modelName]: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cachedReadTokens: usage.cachedReadTokens,
          reasoningTokens: usage.reasoningTokens,
        },
      },
    },
    timestampMs: timestampMs || Date.parse("2026-07-18T10:05:00.000Z"),
    promptId,
  };
}

test("parseGrokBuildIncremental backfills project usage from session cwd", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-git-"));
  writeGitOrigin(repoDir, "https://github.com/acme/grok-project.git");

  const fixture = makeSession({
    cwd: repoDir,
    summaryInfo: { cwd: repoDir },
    turns: [grokTurnUsage()],
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const projectQueuePath = path.join(fixture.root, "project.queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 4 },
  };

  await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });
  const globalRowsBefore = readQueue(queuePath).length;
  assert.ok(globalRowsBefore > 0);
  assert.equal(cursors.grok.version, 6);
  assert.equal(fs.existsSync(projectQueuePath), false);

  const result = await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    projectQueuePath,
    env: fixture.env,
  });
  assert.equal(readQueue(queuePath).length, globalRowsBefore, "project backfill must not re-emit global usage");
  assert.equal(result.projectBucketsQueued, 1);
  assert.equal(cursors.grok.version, 6);

  const projectRows = readQueue(projectQueuePath);
  assert.equal(projectRows.length, 1);
  assert.equal(projectRows[0].source, "grok");
  assert.equal(projectRows[0].project_key, "acme/grok-project");
  assert.equal(projectRows[0].project_ref, "https://github.com/acme/grok-project");
  assert.equal(projectRows[0].total_tokens, 1220);
  assert.equal(projectRows[0].input_tokens, 900);
  assert.equal(projectRows[0].cached_input_tokens, 100);
  assert.equal(projectRows[0].output_tokens, 180);
  assert.equal(projectRows[0].reasoning_output_tokens, 20);

  const unchanged = await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    projectQueuePath,
    env: fixture.env,
  });
  assert.equal(unchanged.bucketsQueued, 0);
  assert.equal(unchanged.projectBucketsQueued, 0);
  assert.equal(readQueue(queuePath).length, globalRowsBefore);
  assert.equal(readQueue(projectQueuePath).length, 1);

  appendGrokTurn(
    fixture.sessionDir,
    grokTurnUsage({
      inputTokens: 500,
      outputTokens: 80,
      totalTokens: 590,
      cachedReadTokens: 50,
      reasoningTokens: 10,
      timestampMs: Date.parse("2026-07-18T10:20:00.000Z"),
    }),
    {
      timestampMs: Date.parse("2026-07-18T10:20:00.000Z"),
      eventId: `${fixture.sessionId}-growth`,
    },
  );

  const growth = await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    projectQueuePath,
    env: fixture.env,
  });
  assert.equal(growth.bucketsQueued, 1);
  assert.equal(growth.projectBucketsQueued, 1);
  assert.equal(readQueue(queuePath).at(-1).total_tokens, 1810);
  assert.equal(readQueue(projectQueuePath).at(-1).total_tokens, 1810);
  assert.equal(readQueue(projectQueuePath).at(-1).conversation_count, 2);
});

test("parseGrokBuildIncremental attributes project usage from encodedCwd only", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-encoded-cwd-"));
  writeGitOrigin(repoDir, "https://github.com/acme/grok-project.git");

  const fixture = makeSession({
    cwd: repoDir,
    turns: [grokTurnUsage()],
  });
  const summaryPath = path.join(fixture.sessionDir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({ updated_at: "2026-07-18T10:00:00.000Z" }));

  const queuePath = path.join(fixture.root, "queue.jsonl");
  const projectQueuePath = path.join(fixture.root, "project.queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 4 },
  };

  const sessions = resolveGrokBuildSessions(fixture.env);
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].encodedCwd.includes("%"));
  delete sessions[0].cwd;

  const result = await parseGrokBuildIncremental({
    sessions,
    cursors,
    queuePath,
    projectQueuePath,
    env: fixture.env,
  });
  assert.equal(result.projectBucketsQueued, 1);
  const projectRows = readQueue(projectQueuePath);
  assert.equal(projectRows.length, 1);
  assert.equal(projectRows[0].project_key, "acme/grok-project");
  assert.equal(projectRows[0].source, "grok");
  assert.equal(projectRows[0].total_tokens, 1220);
});

test("parseGrokBuildIncremental prefers hook sess.cwd over a non-git encodedCwd", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-hook-cwd-"));
  writeGitOrigin(repoDir, "https://github.com/acme/grok-project.git");
  const fixture = makeSession({
    cwd: "/tmp/not-a-git-workspace",
    turns: [grokTurnUsage()],
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const projectQueuePath = path.join(fixture.root, "project.queue.jsonl");
  const sessions = resolveGrokBuildSessions(fixture.env);
  sessions[0].cwd = repoDir;

  const result = await parseGrokBuildIncremental({
    sessions,
    cursors: {
      hourly: { version: 3, buckets: {}, groupQueued: {} },
      grok: { version: 4 },
    },
    queuePath,
    projectQueuePath,
    env: fixture.env,
  });
  assert.equal(result.projectBucketsQueued, 1);
  assert.equal(readQueue(projectQueuePath)[0].project_key, "acme/grok-project");
});

test("parseGrokBuildIncremental skips project attribution when cwd has no git", async () => {
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-nogit-"));
  const fixture = makeSession({
    cwd: cwdDir,
    summaryInfo: { cwd: cwdDir },
    turns: [grokTurnUsage()],
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const projectQueuePath = path.join(fixture.root, "project.queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 4 },
  };

  const first = await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    projectQueuePath,
    env: fixture.env,
  });
  assert.ok(first.bucketsQueued > 0);
  assert.equal(first.projectBucketsQueued, 0);
  assert.equal(fs.existsSync(projectQueuePath), false);
  assert.equal(cursors.grok.version, 6);
  const updatesPath = path.join(fixture.sessionDir, "updates.jsonl");
  assert.equal(cursors.grok.projectUpdateOffsets?.[updatesPath], undefined);

  writeGitOrigin(cwdDir, "https://github.com/acme/grok-project.git");
  const retry = await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    projectQueuePath,
    env: fixture.env,
  });
  assert.equal(retry.bucketsQueued, 0);
  assert.equal(retry.projectBucketsQueued, 1);
  const projectRows = readQueue(projectQueuePath);
  assert.equal(projectRows.length, 1);
  assert.equal(projectRows[0].project_key, "acme/grok-project");
  assert.equal(projectRows[0].total_tokens, 1220);
});

test("parseGrokBuildIncremental project backfill uses independent watermark snapshots", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-wm-"));
  writeGitOrigin(repoDir, "https://github.com/acme/grok-project.git");
  const fixture = makeSession({
    cwd: repoDir,
    summaryInfo: { cwd: repoDir },
    turns: [],
    contextMetas: [5_000, 12_000, 8_000, 20_000],
    signals: { contextTokensUsed: 18_000, totalTokensBeforeCompaction: 0 },
  });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  const projectQueuePath = path.join(fixture.root, "project.queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 4 },
  };

  await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    env: fixture.env,
  });
  const globalRowsBefore = readQueue(queuePath).length;

  const result = await parseGrokBuildIncremental({
    sessions: resolveGrokBuildSessions(fixture.env),
    cursors,
    queuePath,
    projectQueuePath,
    env: fixture.env,
  });
  assert.equal(readQueue(queuePath).length, globalRowsBefore);
  assert.equal(result.projectBucketsQueued, 1);
  const projectRows = readQueue(projectQueuePath);
  assert.equal(projectRows.length, 1);
  assert.equal(projectRows[0].source, "grok");
  assert.equal(projectRows[0].project_key, "acme/grok-project");
  assert.equal(projectRows[0].total_tokens, 20_000);
  assert.equal(cursors.grok.sessionSnapshots[fixture.sessionId].totalTokens, 20_000);
  assert.equal(cursors.grok.projectSessionSnapshots[fixture.sessionId].totalTokens, 20_000);
  assert.notEqual(
    cursors.grok.projectUpdateOffsets,
    cursors.grok.updateOffsets,
  );
});

test("parseGrokBuildIncremental drops project offsets for deleted session files", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-prune-git-"));
  writeGitOrigin(repoDir, "https://github.com/acme/grok-project.git");

  const keep = makeSession({
    sessionId: "019f0000-keep-session",
    cwd: repoDir,
    summaryInfo: { cwd: repoDir },
    turns: [grokTurnUsage()],
  });
  const drop = makeSession({
    sessionId: "019f0000-drop-session",
    cwd: repoDir,
    summaryInfo: { cwd: repoDir },
    turns: [grokTurnUsage({ promptId: "prompt-drop" })],
  });
  const keepUpdates = path.join(keep.sessionDir, "updates.jsonl");
  const dropUpdates = path.join(drop.sessionDir, "updates.jsonl");
  const queuePath = path.join(keep.root, "queue.jsonl");
  const projectQueuePath = path.join(keep.root, "project.queue.jsonl");
  const cursors = {
    hourly: { version: 3, buckets: {}, groupQueued: {} },
    grok: { version: 4 },
  };

  await parseGrokBuildIncremental({
    sessions: [
      { sessionDir: keep.sessionDir, sessionId: keep.sessionId, encodedCwd: keep.encodedCwd },
      { sessionDir: drop.sessionDir, sessionId: drop.sessionId, encodedCwd: drop.encodedCwd },
    ],
    cursors,
    queuePath,
    projectQueuePath,
    env: keep.env,
  });
  assert.ok(cursors.grok.projectUpdateOffsets[keepUpdates]);
  assert.ok(cursors.grok.projectUpdateOffsets[dropUpdates]);

  fs.rmSync(drop.sessionDir, { recursive: true, force: true });
  const stalePath = path.join(keep.root, "missing-updates.jsonl");
  cursors.grok.projectUpdateOffsets[stalePath] = { size: 12, mtimeMs: 1, ino: 1 };

  await parseGrokBuildIncremental({
    sessions: [
      { sessionDir: keep.sessionDir, sessionId: keep.sessionId, encodedCwd: keep.encodedCwd },
    ],
    cursors,
    queuePath,
    projectQueuePath,
    env: keep.env,
  });
  assert.ok(cursors.grok.projectUpdateOffsets[keepUpdates]);
  assert.equal(cursors.grok.projectUpdateOffsets[dropUpdates], undefined);
  assert.equal(cursors.grok.projectUpdateOffsets[stalePath], undefined);
});

test("sync.js does not skip cursor commit when Grok only queues project buckets", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/commands/sync.js"), "utf8");
  assert.match(src, /grokScanResult\.projectBucketsQueued/);
  assert.match(src, /!\(grokResult\.projectBucketsQueued > 0\)/);
});

test("top-level Grok costs allocate only the unreported remainder with explicit provenance", async () => {
  const fixture = makeSession({ turns: [{ usage: {
    costUsdTicks: 10_000_000_000,
    modelUsage: {
      "grok-4.5-build": { inputTokens: 100, outputTokens: 0, costUsdTicks: 2_500_000_000 },
      "opaque-worker": { inputTokens: 300, outputTokens: 0 },
    },
  } }] });
  const queuePath = path.join(fixture.root, "queue.jsonl");
  try {
    await parseGrokBuildIncremental({ sessions: resolveGrokBuildSessions(fixture.env), cursors: {}, queuePath });
    const rows = dedupeQueue(readQueue(queuePath));
    const known = rows.find((row) => row.model === "grok-4.5-build");
    const allocated = rows.find((row) => row.model === "opaque-worker");
    assert.equal(known.cost_coverage.reported_usd, 0.25);
    assert.equal(allocated.cost_coverage.reported_usd, 0.75);
    assert.equal(allocated.cost_coverage.allocated_events, 1);
    assert.deepEqual(allocated.cost_coverage.origins, ["grok_allocated"]);
    assert.equal(computeRowCost(allocated), 0.75);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("Grok v6 coverage migration retains prior snapshots and version when a log cannot be read", async () => {
  const fixture = makeSession({ turns: [{ usage: { inputTokens: 100, costUsd: 1 } }] });
  try {
    const queuePath = path.join(fixture.root, "queue.jsonl");
    const cursors = {};
    const session = resolveGrokBuildSessions(fixture.env)[0];
    await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    cursors.grok.version = 5;
    const before = JSON.stringify(cursors);
    const queued = fs.readFileSync(queuePath, "utf8");
    const queueOnly = structuredClone(cursors);
    delete queueOnly.grok.sessionSnapshots;
    const queueOnlyBefore = JSON.stringify(queueOnly);
    await assert.rejects(parseGrokBuildIncremental({ sessions: [session], cursors: queueOnly, queuePath }), /prior session inventory is incomplete/);
    assert.equal(JSON.stringify(queueOnly), queueOnlyBefore);
    const unavailable = structuredClone(cursors);
    unavailable.grok.sessionSnapshots["missing-old-session"] = { source: "turn_usage", totalTokens: 100 };
    const unavailableBefore = JSON.stringify(unavailable);
    await assert.rejects(parseGrokBuildIncremental({ sessions: [session], cursors: unavailable, queuePath }), /previously counted sessions are unavailable/);
    assert.equal(JSON.stringify(unavailable), unavailableBefore);
    assert.equal(fs.readFileSync(queuePath, "utf8"), queued);
    await assert.rejects(parseGrokBuildIncremental({ sessions: [{ ...session, updatesPath: path.join(fixture.root, "missing.jsonl") }], cursors, queuePath }), /rebuild deferred/);
    assert.equal(JSON.stringify(cursors), before);
    assert.equal(fs.readFileSync(queuePath, "utf8"), queued);
    await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    const stable = fs.readFileSync(queuePath, "utf8");
    await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(fs.readFileSync(queuePath, "utf8"), stable, "retry then repeated scan remains idempotent");
    assert.equal(cursors.grok.version, 6);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});


test("Grok v6 coverage migration retains prior snapshots when a counted log is truncated", async () => {
  const fixture = makeSession({ turns: [
    { usage: { inputTokens: 100, costUsd: 1 } },
    { usage: { inputTokens: 100, costUsd: 1 } },
  ] });
  try {
    const queuePath = path.join(fixture.root, "queue.jsonl");
    const cursors = {};
    const session = resolveGrokBuildSessions(fixture.env)[0];
    await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(readQueue(queuePath).reduce((sum, row) => sum + row.total_tokens, 0), 200);
    cursors.grok.version = 5;
    const before = JSON.stringify(cursors);
    const queued = fs.readFileSync(queuePath, "utf8");
    const updatesPath = path.join(fixture.sessionDir, "updates.jsonl");
    const complete = fs.readFileSync(updatesPath, "utf8");
    fs.writeFileSync(updatesPath, complete.split("\n").filter(Boolean)[0] + "\n");
    await assert.rejects(parseGrokBuildIncremental({ sessions: [session], cursors, queuePath }), /previously counted session log is incomplete/);
    assert.equal(JSON.stringify(cursors), before);
    assert.equal(fs.readFileSync(queuePath, "utf8"), queued);
    fs.writeFileSync(updatesPath, complete);
    await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(cursors.grok.version, 6);
    assert.equal(cursors.grok.sessionSnapshots[fixture.sessionId].totalTokens, 200);
    assert.equal(readQueue(queuePath).at(-1).total_tokens, 200);
    const stable = fs.readFileSync(queuePath, "utf8");
    await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(fs.readFileSync(queuePath, "utf8"), stable);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("Grok v6 coverage migration does not double-count a hook session already in inventory", async () => {
  const fixture = makeSession({ turns: [{ usage: { inputTokens: 100, costUsd: 1 } }] });
  try {
    const queuePath = path.join(fixture.root, "queue.jsonl");
    const cursors = {};
    const session = resolveGrokBuildSessions(fixture.env)[0];
    await parseGrokBuildIncremental({ sessions: [session], cursors, queuePath });
    assert.equal(readQueue(queuePath).at(-1).total_tokens, 100);
    cursors.grok.version = 5;
    const hook = { ...session, sessionId: fixture.sessionId };
    await parseGrokBuildIncremental({ sessions: [hook, session], cursors, queuePath });
    assert.equal(cursors.grok.version, 6);
    assert.equal(cursors.grok.sessionSnapshots[fixture.sessionId].totalTokens, 100);
    assert.equal(readQueue(queuePath).at(-1).total_tokens, 100);
    const stable = fs.readFileSync(queuePath, "utf8");
    await parseGrokBuildIncremental({ sessions: [hook, session], cursors, queuePath });
    assert.equal(cursors.grok.sessionSnapshots[fixture.sessionId].totalTokens, 100);
    assert.equal(fs.readFileSync(queuePath, "utf8"), stable);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("Grok v6 coverage migration retains project history when checkout attribution is lost", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-lost-checkout-"));
  writeGitOrigin(repoDir, "https://github.com/acme/grok-project.git");
  const fixture = makeSession({ cwd: repoDir, summaryInfo: { cwd: repoDir }, turns: [{ usage: { inputTokens: 200, costUsd: 2 } }] });
  try {
    const queuePath = path.join(fixture.root, "queue.jsonl");
    const projectQueuePath = path.join(fixture.root, "project.queue.jsonl");
    const cursors = {};
    const options = { sessions: resolveGrokBuildSessions(fixture.env), cursors, queuePath, projectQueuePath, env: fixture.env };
    await parseGrokBuildIncremental(options);
    assert.equal(readQueue(projectQueuePath).at(-1).total_tokens, 200);
    cursors.grok.version = 5;
    const before = JSON.stringify(cursors);
    const queued = fs.readFileSync(queuePath, "utf8");
    const project = fs.readFileSync(projectQueuePath, "utf8");
    fs.rmSync(repoDir, { recursive: true, force: true });
    await assert.rejects(parseGrokBuildIncremental(options), /rebuilt project history is smaller than the prior snapshot/);
    assert.equal(JSON.stringify(cursors), before);
    assert.equal(fs.readFileSync(queuePath, "utf8"), queued);
    assert.equal(fs.readFileSync(projectQueuePath, "utf8"), project);
    writeGitOrigin(repoDir, "https://github.com/acme/grok-project.git");
    await parseGrokBuildIncremental(options);
    assert.equal(cursors.grok.version, 6);
    assert.equal(cursors.grok.projectSessionSnapshots[fixture.sessionId].totalTokens, 200);
    assert.equal(readQueue(projectQueuePath).at(-1).total_tokens, 200);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); fs.rmSync(repoDir, { recursive: true, force: true }); }
});

test("Grok v5-to-v6 migration rebuilds project evidence without mixing old bucket costs", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-covered-project-"));
  writeGitOrigin(repoDir, "https://github.com/acme/grok-project.git");
  const fixture = makeSession({ cwd: repoDir, summaryInfo: { cwd: repoDir }, turns: [{ usage: { inputTokens: 100, costUsd: 0.5 } }] });
  try {
    const queuePath = path.join(fixture.root, "queue.jsonl");
    const projectQueuePath = path.join(fixture.root, "project.queue.jsonl");
    const cursors = {};
    const options = { sessions: resolveGrokBuildSessions(fixture.env), cursors, queuePath, projectQueuePath, env: fixture.env };
    await parseGrokBuildIncremental(options);
    cursors.grok.version = 5;
    for (const bucket of Object.values(cursors.projectHourly.buckets)) delete bucket.totals.cost_coverage;
    fs.writeFileSync(projectQueuePath, readQueue(projectQueuePath).map(({ cost_coverage, ...row }) => JSON.stringify(row)).join("\n") + "\n");
    appendGrokTurn(fixture.sessionDir, { usage: { inputTokens: 100 } }, { timestampMs: 1784357103000, eventId: "uncovered" });
    await parseGrokBuildIncremental(options);
    const row = readQueue(projectQueuePath).at(-1);
    assert.equal(row.total_tokens, 200);
    assert.equal(row.cost_coverage.reported_usd, 0.5);
    assert.equal(row.cost_coverage.missing_events, 1);
    assert.equal(row.cost_coverage.unreported_tokens.input_tokens, 100);
    const stable = fs.readFileSync(projectQueuePath, "utf8");
    await parseGrokBuildIncremental(options);
    assert.equal(fs.readFileSync(projectQueuePath, "utf8"), stable);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); fs.rmSync(repoDir, { recursive: true, force: true }); }
});

test("Grok project migration read failure is atomic with global and project cursors", async () => {
  const { Readable } = require("node:stream");
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-project-read-"));
  writeGitOrigin(repoDir, "https://github.com/acme/grok-project.git");
  const fixture = makeSession({ cwd: repoDir, summaryInfo: { cwd: repoDir }, turns: [{ usage: { inputTokens: 100, costUsd: 1 } }] });
  const original = fs.createReadStream;
  try {
    const queuePath = path.join(fixture.root, "queue.jsonl");
    const projectQueuePath = path.join(fixture.root, "project.queue.jsonl");
    const cursors = {};
    const options = { sessions: resolveGrokBuildSessions(fixture.env), cursors, queuePath, projectQueuePath, env: fixture.env };
    await parseGrokBuildIncremental(options);
    cursors.grok.version = 5;
    const before = JSON.stringify(cursors);
    const queued = fs.readFileSync(queuePath, "utf8");
    const project = fs.readFileSync(projectQueuePath, "utf8");
    let reads = 0;
    fs.createReadStream = (file, opts) => file === path.join(fixture.sessionDir, "updates.jsonl") && ++reads === 2
      ? new Readable({ read() { this.destroy(Object.assign(new Error("private path EACCES"), { code: "EACCES" })); } }) : original(file, opts);
    await assert.rejects(parseGrokBuildIncremental(options), /project session could not be read/);
    assert.equal(JSON.stringify(cursors), before);
    assert.equal(fs.readFileSync(queuePath, "utf8"), queued);
    assert.equal(fs.readFileSync(projectQueuePath, "utf8"), project);
  } finally { fs.createReadStream = original; fs.rmSync(fixture.root, { recursive: true, force: true }); fs.rmSync(repoDir, { recursive: true, force: true }); }
});
