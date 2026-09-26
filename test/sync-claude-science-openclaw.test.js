"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { test } = require("node:test");

const { cmdSync } = require("../src/commands/sync");
const { withHome } = require("./helpers/with-home");
const { runSql } = require("./helpers/sqlite-write");

async function readJsonl(filePath) {
  const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function latestPerBucket(rows) {
  const latest = new Map();
  for (const r of rows) latest.set(`${r.source}|${r.model}|${r.hour_start}`, r);
  return [...latest.values()];
}

// End-to-end through cmdSync in an isolated HOME: seed a Claude Science DB and
// an OpenClaw channel transcript, then sync twice and assert both sources land
// in the queue and stay stable across runs (the parser 发版守则 idempotency gate).
test("cmdSync counts Claude Science frames and OpenClaw channel usage, idempotently", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tokentracker-cs-openclaw-e2e-"));
  const restoreHome = withHome(tmp);
  const saved = {};
  for (const key of [
    "CODEX_HOME", "CODE_HOME", "GEMINI_HOME", "OPENCODE_HOME",
    "TOKENTRACKER_TRAE_HOME", "TOKENTRACKER_TRAE_DB",
  ]) {
    saved[key] = process.env[key];
  }
  try {
    // Isolate the busy dated-tree providers to empty dirs so this test only
    // observes the two providers it seeds.
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    process.env.OPENCODE_HOME = path.join(tmp, ".opencode");
    process.env.TOKENTRACKER_TRAE_HOME = path.join(tmp, ".trae");
    delete process.env.TOKENTRACKER_TRAE_DB;

    // ── Seed Claude Science ──
    const csDir = path.join(tmp, ".claude-science");
    fs.mkdirSync(csDir, { recursive: true });
    const csDb = path.join(csDir, "operon-cli.db");
    runSql(
      csDb,
      `CREATE TABLE frames (
        id text PRIMARY KEY NOT NULL,
        parent_frame_id text,
        model text,
        input_tokens integer,
        output_tokens integer,
        cache_read_tokens integer,
        cache_write_tokens integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        completed_at integer
      );`,
    );
    const ts = Date.parse("2026-07-07T13:05:00.000Z");
    runSql(
      csDb,
      `INSERT INTO frames (id, parent_frame_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at, updated_at, completed_at)
       VALUES ('f1', NULL, 'claude-opus-4', 100, 50, 0, 0, ${ts}, ${ts}, ${ts});`,
    );

    // ── Seed an OpenClaw channel transcript (WeChat-style agent) ──
    const sessions = path.join(tmp, ".openclaw", "agents", "wechat-bot", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "channel-1.jsonl"),
      JSON.stringify({
        type: "message",
        id: "oc-1",
        timestamp: "2026-07-07T14:31:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4.7",
          usage: { input: 200, cacheRead: 0, cacheWrite: 0, output: 30, totalTokens: 230 },
        },
      }) + "\n",
    );

    await cmdSync([]);
    const queuePath = path.join(tmp, ".tokentracker", "tracker", "queue.jsonl");
    let buckets = latestPerBucket(await readJsonl(queuePath));

    const cs = buckets.find((r) => r.source === "claude-science");
    assert.ok(cs, "expected a claude-science bucket");
    assert.equal(cs.total_tokens, 150);

    const oc = buckets.find((r) => r.source === "openclaw");
    assert.ok(oc, "expected an openclaw bucket from passive channel scan");
    assert.ok(oc.total_tokens > 0);

    const totalAfterFirst = buckets.reduce((s, r) => s + (r.total_tokens || 0), 0);

    // Second sync: nothing changed on disk, totals must not move.
    await cmdSync([]);
    buckets = latestPerBucket(await readJsonl(queuePath));
    const totalAfterSecond = buckets.reduce((s, r) => s + (r.total_tokens || 0), 0);
    assert.equal(totalAfterSecond, totalAfterFirst, "second sync must be idempotent");
  } finally {
    restoreHome();
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});
