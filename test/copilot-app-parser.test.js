"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const { computeRowCost } = require("../src/lib/pricing");
const { mockPlatform, mockMethod } = require("./helpers/mock");
const {
  parseCopilotIncremental,
  parseCopilotAppDbIncremental,
  resolveCopilotAppDbPaths,
} = require("../src/lib/rollout");

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

const { runSql } = require("./helpers/sqlite-write");

function makeCopilotAppDb(rows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-app-test-"));
  const copilotHome = path.join(dir, ".copilot");
  fs.mkdirSync(copilotHome, { recursive: true });
  const dbPath = path.join(copilotHome, "data.db");
  runSql(dbPath, `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      session_type TEXT,
      mode TEXT,
      model TEXT,
      provider_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      forked_from_session_id TEXT,
      fork_original_history_event_count INTEGER,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      total_cached_tokens INTEGER,
      total_reasoning_tokens INTEGER,
      total_nano_aiu INTEGER,
      context_current_tokens INTEGER,
      context_conversation_tokens INTEGER
    );
  `);
  for (const row of rows) insertSession(dbPath, row);
  return { dir, dbPath, copilotHome };
}

function insertSession(dbPath, row) {
  const columns = [
    "id",
    "title",
    "session_type",
    "mode",
    "model",
    "provider_id",
    "created_at",
    "updated_at",
    "forked_from_session_id",
    "fork_original_history_event_count",
    "total_input_tokens",
    "total_output_tokens",
    "total_cached_tokens",
    "total_reasoning_tokens",
    "total_nano_aiu",
    "context_current_tokens",
    "context_conversation_tokens",
  ];
  const values = columns.map((column) => sqlValue(row[column]));
  runSql(dbPath, `INSERT INTO sessions (${columns.join(", ")}) VALUES (${values.join(", ")});`);
}

function updateSession(dbPath, id, values) {
  const setSql = Object.entries(values)
    .map(([column, value]) => `${column}=${sqlValue(value)}`)
    .join(", ");
  runSql(dbPath, `UPDATE sessions SET ${setSql} WHERE id=${sqlValue(id)};`);
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(dbPath, future, future);
}

function updateSessionPreserveDbMtimeWithWal(dbPath, id, values) {
  const before = fs.statSync(dbPath);
  const child = cp.spawn("sqlite3", [dbPath], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const setSql = Object.entries(values)
    .map(([column, value]) => `${column}=${sqlValue(value)}`)
    .join(", ");
  child.stdin.write("PRAGMA journal_mode=WAL;\n");
  child.stdin.write("PRAGMA wal_autocheckpoint=0;\n");
  child.stdin.write("BEGIN IMMEDIATE;\n");
  child.stdin.write(`UPDATE sessions SET ${setSql} WHERE id=${sqlValue(id)};\n`);
  child.stdin.write("COMMIT;\n");
  child.stdin.write("SELECT 'ready';\n");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for sqlite WAL update"));
    }, 5000);
    child.stdout.on("data", () => {
      if (!stdout.includes("ready")) return;
      clearTimeout(timer);
      try {
        fs.utimesSync(dbPath, before.atime, before.mtime);
        resolve({
          close() {
            return new Promise((resolveClose, rejectClose) => {
              child.once("close", (code) => code === 0
                ? resolveClose()
                : rejectClose(new Error(`sqlite writer exited with ${code}`)));
              child.stdin.end(".quit\n");
            });
          },
        });
      } catch (err) {
        child.kill();
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (code !== 0 && !stdout.includes("ready")) {
        clearTimeout(timer);
        reject(new Error(`sqlite exited with ${code}: ${stderr}`));
      }
    });
  });
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

function latestByBucket(rows) {
  const latest = new Map();
  for (const row of rows) {
    latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }
  return Array.from(latest.values());
}

function writeCopilotOtelFile(filePath, records) {
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

function makeCopilotOtelSpan({
  traceId = "trace-1",
  spanId = "span-1",
  endSeconds = 1778641000,
  inputTokens = 100,
  outputTokens = 20,
  cacheRead = 10,
  model = "gpt-4o",
} = {}) {
  return {
    type: "span",
    traceId,
    spanId,
    name: `chat ${model}`,
    startTime: [endSeconds - 1, 0],
    endTime: [endSeconds, 0],
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.response.model": model,
      "gen_ai.usage.input_tokens": inputTokens,
      "gen_ai.usage.output_tokens": outputTokens,
      "gen_ai.usage.cache_read.input_tokens": cacheRead,
    },
  };
}

test("parseCopilotAppDbIncremental reads sessions table summaries into copilot buckets", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "sess-1",
      session_type: "project",
      mode: "autopilot",
      model: "claude-sonnet-4-6",
      provider_id: "anthropic",
      created_at: "2026-07-07T10:01:00Z",
      updated_at: "2026-07-07T10:29:00Z",
      total_input_tokens: 1000,
      total_output_tokens: 200,
      total_cached_tokens: 300,
      total_reasoning_tokens: 40,
      total_nano_aiu: 999999,
      context_current_tokens: 888888,
      context_conversation_tokens: 777777,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const result = await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });
    assert.equal(result.recordsProcessed, 1);
    assert.equal(result.eventsAggregated, 1);

    const rows = readQueue(queuePath).filter((row) => row.source === "copilot");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "claude-sonnet-4-6");
    assert.equal(rows[0].input_tokens, 700);
    assert.equal(rows[0].output_tokens, 160);
    assert.equal(rows[0].cached_input_tokens, 300);
    assert.equal(rows[0].reasoning_output_tokens, 40);
    assert.equal(rows[0].cache_creation_input_tokens, 0);
    assert.equal(rows[0].total_tokens, 1200);
    assert.equal(rows[0].conversation_count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental counts zero for fork sessions with inherited history but zero totals", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "fork-child",
      session_type: "project",
      model: "gpt-5.5",
      created_at: "2026-07-07T11:00:00Z",
      updated_at: "2026-07-07T11:00:00Z",
      forked_from_session_id: "parent",
      fork_original_history_event_count: 42,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const result = await parseCopilotAppDbIncremental({ dbPath, cursors: {}, queuePath });
    assert.equal(result.recordsProcessed, 1);
    assert.equal(result.eventsAggregated, 0);
    assert.deepEqual(readQueue(queuePath), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental emits only positive deltas on subsequent sync", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "growing",
      session_type: "project",
      model: "gpt-5.5",
      created_at: "2026-07-07T12:00:00Z",
      updated_at: "2026-07-07T12:05:00Z",
      total_input_tokens: 100,
      total_output_tokens: 20,
      total_cached_tokens: 10,
      total_reasoning_tokens: 5,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });

    updateSession(dbPath, "growing", {
      updated_at: "2026-07-07T12:20:00Z",
      total_input_tokens: 175,
      total_output_tokens: 30,
      total_cached_tokens: 25,
      total_reasoning_tokens: 5,
    });
    const second = await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.eventsAggregated, 1);

    const latest = latestByBucket(readQueue(queuePath).filter((row) => row.source === "copilot"));
    assert.equal(latest.length, 1);
    assert.equal(latest[0].input_tokens, 150);
    assert.equal(latest[0].output_tokens, 25);
    assert.equal(latest[0].cached_input_tokens, 25);
    assert.equal(latest[0].reasoning_output_tokens, 5);
    assert.equal(latest[0].total_tokens, 205);
    assert.equal(latest[0].conversation_count, 1, "growth in an existing App session must not add another conversation");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental observe-only mode advances baselines without emitting", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "store-owned-session",
      session_type: "project",
      model: "gpt-5.6-luna",
      created_at: "2026-07-10T12:00:00Z",
      updated_at: "2026-07-10T12:05:00Z",
      total_input_tokens: 100,
      total_output_tokens: 10,
      total_cached_tokens: 20,
      total_reasoning_tokens: 2,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const first = await parseCopilotAppDbIncremental({
      dbPath,
      cursors,
      queuePath,
      observeOnly: true,
    });
    assert.equal(first.eventsAggregated, 0);
    assert.deepEqual(readQueue(queuePath), []);
    assert.equal(
      cursors.copilotApp.dbs[dbPath].sessionTotals["store-owned-session"].input,
      100,
    );

    updateSession(dbPath, "store-owned-session", {
      updated_at: "2026-07-10T12:20:00Z",
      total_input_tokens: 150,
      total_output_tokens: 15,
      total_cached_tokens: 30,
      total_reasoning_tokens: 3,
    });
    const second = await parseCopilotAppDbIncremental({
      dbPath,
      cursors,
      queuePath,
      observeOnly: true,
    });
    assert.equal(second.eventsAggregated, 0);
    assert.deepEqual(readQueue(queuePath), []);
    assert.equal(
      cursors.copilotApp.dbs[dbPath].sessionTotals["store-owned-session"].input,
      150,
    );

    const legacyAfterObservation = await parseCopilotAppDbIncremental({
      dbPath,
      cursors,
      queuePath,
    });
    assert.equal(legacyAfterObservation.eventsAggregated, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental does not emit negative deltas when counters shrink", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "reset",
      session_type: "project",
      model: "gpt-5.5",
      created_at: "2026-07-07T13:00:00Z",
      updated_at: "2026-07-07T13:05:00Z",
      total_input_tokens: 500,
      total_output_tokens: 100,
      total_cached_tokens: 50,
      total_reasoning_tokens: 25,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });
    const beforeRows = readQueue(queuePath).length;

    updateSession(dbPath, "reset", {
      updated_at: "2026-07-07T13:20:00Z",
      total_input_tokens: 100,
      total_output_tokens: 20,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    const second = await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.eventsAggregated, 0);
    assert.equal(readQueue(queuePath).length, beforeRows);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental falls back to github-copilot when model is missing", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "missing-model",
      session_type: "project",
      model: null,
      provider_id: "github",
      created_at: "2026-07-07T14:00:00Z",
      updated_at: "2026-07-07T14:01:00Z",
      total_input_tokens: 10,
      total_output_tokens: 2,
      total_cached_tokens: 3,
      total_reasoning_tokens: 4,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    await parseCopilotAppDbIncremental({ dbPath, cursors: {}, queuePath });
    const rows = readQueue(queuePath).filter((row) => row.source === "copilot");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "github-copilot");
    assert.equal(rows[0].input_tokens, 7);
    assert.equal(rows[0].cached_input_tokens, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental clamps cached input to raw input delta", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "cache-heavy",
      session_type: "project",
      model: "gpt-5.5",
      created_at: "2026-07-07T14:30:00Z",
      updated_at: "2026-07-07T14:31:00Z",
      total_input_tokens: 100,
      total_output_tokens: 7,
      total_cached_tokens: 150,
      total_reasoning_tokens: 3,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    await parseCopilotAppDbIncremental({ dbPath, cursors: {}, queuePath });
    const rows = readQueue(queuePath).filter((row) => row.source === "copilot");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_tokens, 0);
    assert.equal(rows[0].cached_input_tokens, 100);
    assert.equal(rows[0].output_tokens, 4);
    assert.equal(rows[0].reasoning_output_tokens, 3);
    assert.equal(rows[0].total_tokens, 107);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental clamps reasoning to inclusive output totals", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "reasoning-heavy",
      session_type: "project",
      model: "gpt-5.5",
      created_at: "2026-07-07T14:35:00Z",
      updated_at: "2026-07-07T14:36:00Z",
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cached_tokens: 0,
      total_reasoning_tokens: 80,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    await parseCopilotAppDbIncremental({ dbPath, cursors: {}, queuePath });
    const [row] = readQueue(queuePath).filter((entry) => entry.source === "copilot");
    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 0);
    assert.equal(row.reasoning_output_tokens, 50);
    assert.equal(row.total_tokens, 150);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental isolates one DB read failure without dropping healthy progress", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "healthy-db-session",
      session_type: "project",
      model: "gpt-5.5",
      created_at: "2026-07-07T14:45:00Z",
      updated_at: "2026-07-07T14:46:00Z",
      total_input_tokens: 100,
      total_output_tokens: 20,
      total_cached_tokens: 10,
      total_reasoning_tokens: 0,
    },
  ]);
  try {
    const badDbPath = path.join(dir, "bad-copilot-data.db");
    fs.writeFileSync(badDbPath, "not a sqlite database", "utf8");
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};

    const result = await parseCopilotAppDbIncremental({ dbPaths: [dbPath, badDbPath], cursors, queuePath });
    assert.equal(result.eventsAggregated, 1);
    assert.equal(result.dbErrors, 1);

    const rows = readQueue(queuePath).filter((row) => row.source === "copilot");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_tokens, 90);
    assert.equal(rows[0].cached_input_tokens, 10);
    assert.ok(cursors.copilotApp.dbs[dbPath].lastDbFingerprint, "healthy DB fingerprint should persist");
    assert.equal(
      cursors.copilotApp.dbs[badDbPath].lastDbFingerprint,
      undefined,
      "failed DB must not advance fingerprint so unchanged history is retried",
    );
    assert.match(cursors.copilotApp.dbs[badDbPath].lastError, /GitHub Copilot App SQLite database|file is not a database|database disk image is malformed/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental isolates one DB fingerprint failure without dropping healthy progress", async (t) => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "healthy-after-fingerprint-failure",
      session_type: "project",
      model: "gpt-5.5",
      created_at: "2026-07-07T14:47:00Z",
      updated_at: "2026-07-07T14:48:00Z",
      total_input_tokens: 100,
      total_output_tokens: 20,
      total_cached_tokens: 10,
      total_reasoning_tokens: 0,
    },
  ]);
  try {
    const badDbPath = path.join(dir, "stat-fails.db");
    const originalStatSync = fs.statSync;
    mockMethod(t, fs, "statSync", (target, ...args) => {
      if (target === badDbPath) {
        const err = new Error("simulated fingerprint stat failure");
        err.code = "EACCES";
        throw err;
      }
      return originalStatSync.call(fs, target, ...args);
    });

    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};

    const result = await parseCopilotAppDbIncremental({ dbPaths: [badDbPath, dbPath], cursors, queuePath });
    assert.equal(result.eventsAggregated, 1);
    assert.equal(result.dbErrors, 1);

    const rows = readQueue(queuePath).filter((row) => row.source === "copilot");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_tokens, 90);
    assert.equal(rows[0].cached_input_tokens, 10);
    assert.ok(cursors.copilotApp.dbs[dbPath].lastDbFingerprint, "healthy DB fingerprint should persist");
    assert.equal(cursors.copilotApp.dbs[badDbPath].lastDbFingerprint, undefined);
    assert.match(cursors.copilotApp.dbs[badDbPath].lastError, /simulated fingerprint stat failure/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental normalizes dotted Claude App model ids for pricing", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "dotted-claude",
      session_type: "project",
      model: "claude-opus-4.8",
      provider_id: "anthropic",
      created_at: "2026-07-07T14:50:00Z",
      updated_at: "2026-07-07T14:51:00Z",
      total_input_tokens: 1_000_000,
      total_output_tokens: 0,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    await parseCopilotAppDbIncremental({ dbPath, cursors: {}, queuePath });
    const rows = readQueue(queuePath).filter((row) => row.source === "copilot");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "claude-opus-4-8");
    assert.ok(computeRowCost(rows[0]) > 0, "normalized App model should hit Copilot pricing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental skips rows recognizable as OTEL-backed Copilot CLI usage", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "cli-mirror",
      session_type: "cli",
      model: "gpt-4o",
      provider_id: "copilot-cli",
      created_at: "2026-07-07T15:00:00Z",
      updated_at: "2026-07-07T15:01:00Z",
      total_input_tokens: 1000,
      total_output_tokens: 200,
      total_cached_tokens: 100,
      total_reasoning_tokens: 0,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const result = await parseCopilotAppDbIncremental({ dbPath, cursors: {}, queuePath });
    assert.equal(result.recordsProcessed, 1);
    assert.equal(result.eventsAggregated, 0);
    assert.deepEqual(readQueue(queuePath), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Copilot App DB and OTEL parsing coexist without sharing cursors or changing source names", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "app-session",
      session_type: "project",
      model: "claude-sonnet-4-6",
      provider_id: "anthropic",
      created_at: "2026-07-07T16:00:00Z",
      updated_at: "2026-07-07T16:03:00Z",
      total_input_tokens: 50,
      total_output_tokens: 10,
      total_cached_tokens: 5,
      total_reasoning_tokens: 2,
    },
  ]);
  try {
    const otelPath = path.join(dir, "copilot-otel.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    writeCopilotOtelFile(otelPath, [
      makeCopilotOtelSpan({
        traceId: "otel-trace",
        spanId: "otel-span",
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 10,
        model: "gpt-4o",
      }),
    ]);

    const otelFirst = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    const appFirst = await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });
    assert.equal(otelFirst.eventsAggregated, 1);
    assert.equal(appFirst.eventsAggregated, 1);
    assert.ok(cursors.copilot?.fileOffsets?.[otelPath], "OTEL cursor remains in cursors.copilot");
    assert.ok(cursors.copilotApp?.dbs?.[dbPath], "App DB cursor uses cursors.copilotApp");

    const rows = readQueue(queuePath).filter((row) => row.source === "copilot");
    assert.equal(rows.length, 2);
    const byModel = new Map(rows.map((row) => [row.model, row]));
    assert.equal(byModel.get("gpt-4o").input_tokens, 90);
    assert.equal(byModel.get("gpt-4o").cached_input_tokens, 10);
    assert.equal(byModel.get("gpt-4o").output_tokens, 20);
    assert.equal(byModel.get("claude-sonnet-4-6").input_tokens, 45);
    assert.equal(byModel.get("claude-sonnet-4-6").cached_input_tokens, 5);
    assert.equal(byModel.get("claude-sonnet-4-6").output_tokens, 8);

    const otelSecond = await parseCopilotIncremental({ otelPaths: [otelPath], cursors, queuePath });
    const appSecond = await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });
    assert.equal(otelSecond.eventsAggregated, 0);
    assert.equal(appSecond.eventsAggregated, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental reprocesses when only SQLite sidecars change", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "wal-session",
      session_type: "project",
      model: "gpt-5.5",
      created_at: "2026-07-07T17:00:00Z",
      updated_at: "2026-07-07T17:05:00Z",
      total_input_tokens: 100,
      total_output_tokens: 10,
      total_cached_tokens: 20,
      total_reasoning_tokens: 0,
    },
  ]);
  let walWriter = null;
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });

    walWriter = await updateSessionPreserveDbMtimeWithWal(dbPath, "wal-session", {
      updated_at: "2026-07-07T17:20:00Z",
      total_input_tokens: 150,
      total_output_tokens: 15,
      total_cached_tokens: 30,
      total_reasoning_tokens: 0,
    });
    assert.ok(fs.existsSync(`${dbPath}-wal`), "test must leave a WAL sidecar for the parser to fingerprint");
    // Simulate the problematic state exactly: a legacy mtime-only gate would
    // believe data.db itself is unchanged and skip this WAL-only commit.
    cursors.copilotApp.dbs[dbPath].lastDbMtimeMs = fs.statSync(dbPath).mtimeMs;

    const second = await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.eventsAggregated, 1);
    const latest = latestByBucket(readQueue(queuePath).filter((row) => row.source === "copilot"));
    assert.equal(latest[0].input_tokens, 120);
    assert.equal(latest[0].cached_input_tokens, 30);
    assert.equal(latest[0].output_tokens, 15);
    assert.equal(latest[0].total_tokens, 165);
  } finally {
    if (walWriter) await walWriter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCopilotAppDbIncremental does not re-count nonzero sessions after cursor pruning", async () => {
  const { dir, dbPath } = makeCopilotAppDb([
    {
      id: "would-be-evicted",
      session_type: "project",
      model: "gpt-5.5",
      created_at: "2026-07-07T18:00:00Z",
      updated_at: "2026-07-07T18:05:00Z",
      total_input_tokens: 1,
      total_output_tokens: 0,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    },
  ]);
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const dbState = { sessionTotals: {} };
    dbState.sessionTotals["would-be-evicted"] = {
      input: 1,
      output: 0,
      cached: 0,
      reasoning: 0,
      model: "gpt-5.5",
      updatedAt: "2026-07-07T18:05:00Z",
    };
    for (let i = 0; i < 10_000; i++) {
      dbState.sessionTotals[`larger-${i}`] = {
        input: 2,
        output: 0,
        cached: 0,
        reasoning: 0,
        model: "gpt-5.5",
        updatedAt: "2026-07-07T18:00:00Z",
      };
    }
    const cursors = { copilotApp: { dbs: { [dbPath]: dbState } } };

    const first = await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });
    assert.equal(first.eventsAggregated, 0);
    assert.ok(
      cursors.copilotApp.dbs[dbPath].sessionTotals["would-be-evicted"],
      "nonzero baselines must survive pruning",
    );

    updateSession(dbPath, "would-be-evicted", {
      updated_at: "2026-07-07T18:20:00Z",
      total_input_tokens: 2,
      total_output_tokens: 0,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    const second = await parseCopilotAppDbIncremental({ dbPath, cursors, queuePath });
    assert.equal(second.eventsAggregated, 1);
    const rows = readQueue(queuePath).filter((row) => row.source === "copilot");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_tokens, 1);
    assert.equal(rows[0].total_tokens, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCopilotAppDbPaths includes COPILOT_HOME/data.db and ~/.copilot/data.db", () => {
  const paths = resolveCopilotAppDbPaths({
    HOME: "/tmp/home",
    COPILOT_HOME: "/tmp/copilot-custom",
  });
  assert.ok(paths.includes(path.join("/tmp/copilot-custom", "data.db")));
  assert.ok(paths.includes(path.join("/tmp/home", ".copilot", "data.db")));
});

test("resolveCopilotAppDbPaths stays native when Windows WSL mode is wsl-only", (t) => {
  mockPlatform(t, "win32");
  const paths = resolveCopilotAppDbPaths({
    HOME: "/tmp/shell-home",
    USERPROFILE: "/tmp/native-user",
    TOKENTRACKER_WSL_MODE: "wsl-only",
  });
  assert.deepEqual(paths, [
    path.join("/tmp/native-user", ".copilot", "data.db"),
  ]);
});
