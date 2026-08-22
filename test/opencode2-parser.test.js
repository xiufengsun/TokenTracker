"use strict";

// OpenCode v2 (the `opencode2` beta) keeps the same data directory but rewrote
// the storage layer: assistant messages moved from the `message` table to
// `session_message` (role is now a `type` column), the model became a nested
// `model: { id, providerID }` object, and the project directory lives on
// `session_v2.directory` instead of the message's own `path.cwd`. These tests
// pin the reader/parser contract for BOTH generations sharing one parser, all
// aggregating under source="opencode".
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runSql } = require("./helpers/sqlite-write");
const {
  readOpencodeDbMessages,
  parseOpencodeDbIncremental,
} = require("../src/lib/rollout");

let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch (_e) {
  sqlite = null;
}

function buildV2FixtureDb(dbPath, { messages = [], sessions = [] } = {}) {
  runSql(
    dbPath,
    [
      // Minimal stand-ins for the real opencode2 tables — only the columns the
      // reader touches are present.
      "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL)",
      `CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      )`,
    ].join(";\n") + ";",
  );
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    for (const s of sessions) {
      db.prepare("INSERT INTO session_v2 (id, directory) VALUES (?, ?)").run(s.id, s.directory);
    }
    for (const m of messages) {
      const createdMs = m.time?.created ?? 0;
      const updatedMs = m.time?.completed ?? createdMs;
      db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(m.id, m.sessionID, m.type || "assistant", m.seq ?? 0, createdMs, updatedMs, JSON.stringify(m));
    }
  } finally {
    db.close();
  }
}

function buildV1FixtureDb(dbPath, messages) {
  runSql(
    dbPath,
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    for (const m of messages) {
      const createdMs = m.time?.created ?? 0;
      const updatedMs = m.time?.completed ?? createdMs;
      db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ).run(m.id, m.sessionID, createdMs, updatedMs, JSON.stringify(m));
    }
  } finally {
    db.close();
  }
}

// An opencode2-shaped assistant message: nested model object, no top-level
// modelID/providerID, tokens/cache identical to v1.
function v2AssistantMessage({ id, sessionID, modelId = "x-preview-f-free", providerID = "opencode", input = 100, output = 20, cached = 0, cacheWrite = 0, reasoning = 0 }) {
  return {
    id,
    sessionID,
    type: "assistant",
    agent: "build",
    model: { id: modelId, providerID },
    time: { created: Date.parse("2026-08-01T10:00:00.000Z"), completed: Date.parse("2026-08-01T10:00:05.000Z") },
    tokens: { input, output, reasoning, cache: { read: cached, write: cacheWrite } },
  };
}

// A v1-shaped assistant message: flat modelID/providerID strings + role key.
function v1AssistantMessage({ id, sessionID, modelID = "claude-sonnet-4", providerID = "anthropic", input = 100, output = 20, cached = 0, cacheWrite = 0 }) {
  return {
    id,
    sessionID,
    role: "assistant",
    modelID,
    providerID,
    time: { created: Date.parse("2026-08-01T10:00:00.000Z"), completed: Date.parse("2026-08-01T10:00:05.000Z") },
    tokens: { input, output, reasoning: 0, cache: { read: cached, write: cacheWrite } },
  };
}

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-opencode2-"));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function readQueue(queuePath) {
  const text = await fs.readFile(queuePath, "utf8").catch(() => "");
  if (!text.trim()) return [];
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function queueTotals(queuePath) {
  const rows = await readQueue(queuePath);
  const latest = new Map();
  for (const row of rows) latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  for (const row of latest.values()) {
    for (const key of Object.keys(totals)) totals[key] += row[key] || 0;
  }
  return { rows, totals };
}

test("readOpencodeDbMessages reads the opencode2 session_message schema", async () => {
  await withTmp(async (tmp) => {
    const dbPath = path.join(tmp, "opencode.db");
    buildV2FixtureDb(dbPath, {
      sessions: [{ id: "ses_v2_1", directory: "/Users/alice/dev/widgets" }],
      messages: [
        v2AssistantMessage({ id: "msg_a", sessionID: "ses_v2_1" }),
        // Some OpenCode forks wrote a plain string into `model` — the reader
        // must not care; model resolution happens downstream either way.
        { ...v2AssistantMessage({ id: "msg_s", sessionID: "ses_v2_1" }), model: "string-form-model" },
        // user turns and token-less assistants never carry usage
        { ...v2AssistantMessage({ id: "msg_u", sessionID: "ses_v2_1" }), type: "user" },
        { ...v2AssistantMessage({ id: "msg_e", sessionID: "ses_v2_1" }), tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      ],
    });

    const rows = readOpencodeDbMessages(dbPath);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "msg_a");
    assert.equal(rows[0].sessionID, "ses_v2_1");
    // Nested model object survives untouched…
    assert.deepEqual(rows[0].data.model, { id: "x-preview-f-free", providerID: "opencode" });
    // …and the session's directory is restored as the per-message path.cwd so
    // project attribution works without any downstream change.
    assert.equal(rows[0].data.path.cwd, "/Users/alice/dev/widgets");
  });
});

test("readOpencodeDbMessages still reads the v1 message table unchanged", async () => {
  await withTmp(async (tmp) => {
    const dbPath = path.join(tmp, "opencode.db");
    buildV1FixtureDb(dbPath, [v1AssistantMessage({ id: "msg_v1", sessionID: "ses_v1" })]);

    const rows = readOpencodeDbMessages(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "msg_v1");
    assert.equal(rows[0].data.modelID, "claude-sonnet-4");
    assert.equal(rows[0].data.providerID, "anthropic");
  });
});

test("readOpencodeDbMessages falls back to session_message when sqlite_master probing is inconclusive", async () => {
  await withTmp(async (tmp) => {
    // Simulate a reader stack that answers only real table queries (the probe
    // comes back empty), so the code must try v1 → fail ("no such table") → v2.
    const calls = [];
    const dbPath = path.join(tmp, "opencode.db");
    await fs.writeFile(dbPath, "", "utf8");
    const sqliteOptions = {
      execFileSync() {
        throw new Error("spawn sqlite3 ENOENT");
      },
      requireFn(name) {
        assert.equal(name, "node:sqlite");
        return {
          DatabaseSync: class FakeDatabaseSync {
            prepare(sql) {
              calls.push(sql);
              if (sql.includes("sqlite_master")) return { all: () => [] };
              if (/FROM message /.test(sql)) {
                throw new Error("no such table: message");
              }
              if (sql.includes("FROM session_message")) {
                return {
                  all: () => [
                    {
                      id: "msg_fb",
                      session_id: "ses_fb",
                      time_updated: Date.parse("2026-08-01T10:00:05.000Z"),
                      directory: "/Users/alice/dev/widgets",
                      data: JSON.stringify(v2AssistantMessage({ id: "msg_fb", sessionID: "ses_fb" })),
                    },
                  ],
                };
              }
              throw new Error(`unexpected sql: ${sql}`);
            }
            close() {}
          },
        };
      },
      stderr: { write() {} },
    };

    const rows = readOpencodeDbMessages(dbPath, sqliteOptions);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "msg_fb");
    assert.equal(rows[0].sessionID, "ses_fb");
    assert.ok(calls.some((sql) => sql.includes("FROM session_message")));
  });
});

test("parseOpencodeDbIncremental buckets opencode2 messages under source=opencode with the nested model id", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const res = await parseOpencodeDbIncremental({
      dbMessages: [
        {
          id: "msg_a",
          sessionID: "ses_v2_1",
          data: v2AssistantMessage({ id: "msg_a", sessionID: "ses_v2_1", input: 5644, output: 61, reasoning: 8, cached: 3136 }),
        },
        // String-form `model` (fork variant) must resolve through the same helper.
        {
          id: "msg_s",
          sessionID: "ses_v2_2",
          data: { ...v2AssistantMessage({ id: "msg_s", sessionID: "ses_v2_2", input: 10, output: 5 }), model: "string-form-model" },
        },
      ],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });

    assert.equal(res.eventsAggregated, 2);
    const { rows, totals } = await queueTotals(queuePath);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.source === "opencode"));
    assert.ok(rows.some((r) => r.model === "x-preview-f-free"));
    assert.ok(rows.some((r) => r.model === "string-form-model"));
    assert.equal(totals.input_tokens, 5654);
    assert.equal(totals.output_tokens, 66);
    assert.equal(totals.cached_input_tokens, 3136);
    assert.equal(totals.reasoning_output_tokens, 8);

    // Idempotent: replaying the same snapshot aggregates nothing new.
    const again = await parseOpencodeDbIncremental({
      dbMessages: [
        {
          id: "msg_a",
          sessionID: "ses_v2_1",
          data: v2AssistantMessage({ id: "msg_a", sessionID: "ses_v2_1", input: 5644, output: 61, reasoning: 8, cached: 3136 }),
        },
      ],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal(again.eventsAggregated, 0);
  });
});

test("opencode2 fork copies are deduped via the fingerprint built from the nested model", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    // Session.fork re-materialises the parent turn under a new id/session with
    // an identical payload — exactly the #426 shape, now in v2 clothing.
    const wrap = (m) => ({ id: m.id, sessionID: m.sessionID, data: m });
    const parent = v2AssistantMessage({ id: "msg_p", sessionID: "ses_parent", input: 5000, output: 100 });
    const forkCopy = v2AssistantMessage({ id: "msg_f", sessionID: "ses_fork", input: 5000, output: 100 });
    const genuineContinuation = v2AssistantMessage({ id: "msg_g", sessionID: "ses_fork", input: 42, output: 7 });

    const res = await parseOpencodeDbIncremental({
      dbMessages: [wrap(parent), wrap(forkCopy), wrap(genuineContinuation)],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal(res.eventsAggregated, 2); // parent + continuation; copy suppressed

    const { totals } = await queueTotals(queuePath);
    assert.equal(totals.input_tokens, 5042);
    assert.equal(totals.output_tokens, 107);
  });
});

test("end to end: opencode2 fixture DB flows through reader + parser with project attribution", async () => {
  await withTmp(async (tmp) => {
    // Minimal git repo the project resolver can walk into from the session's
    // recorded directory.
    const repoRoot = path.join(tmp, "widgets");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
      "utf8",
    );

    const dbPath = path.join(tmp, "opencode.db");
    buildV2FixtureDb(dbPath, {
      sessions: [{ id: "ses_repo", directory: repoRoot }],
      messages: [v2AssistantMessage({ id: "msg_repo", sessionID: "ses_repo", input: 44322, output: 9905 })],
    });

    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const dbMessages = readOpencodeDbMessages(dbPath);
    const res = await parseOpencodeDbIncremental({
      dbMessages,
      dbPath,
      cursors,
      queuePath,
      projectQueuePath,
      source: "opencode",
      cursorKey: "opencode",
    });

    assert.equal(res.eventsAggregated, 1);
    const { rows } = await queueTotals(queuePath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "x-preview-f-free");

    const projectRows = await readQueue(projectQueuePath);
    assert.equal(projectRows.length, 1);
    assert.equal(projectRows[0].project_key, "acme/widgets");
  });
});
