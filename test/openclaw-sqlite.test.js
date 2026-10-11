"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveOpenclawSessionFiles, parseOpenclawIncremental } = require("../src/lib/rollout");
const { ensureOpenclawSessionPluginFiles } = require("../src/lib/openclaw-session-plugin");
let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}

test("OpenClaw SQLite imports preserve event buckets, caches and archive dedup across repeated sync", { skip: !DatabaseSync }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-openclaw-sqlite-"));
  let db;
  t.after(() => { db?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, "oc");
  const agent = path.join(home, "agents", "main");
  fs.mkdirSync(path.join(agent, "agent"), { recursive: true });
  fs.mkdirSync(path.join(agent, "session-sqlite-import-archive"));
  const dbPath = path.join(agent, "agent", "openclaw-agent.sqlite");
  db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session_windows(session_id TEXT PRIMARY KEY, session_key TEXT, updated_at INTEGER, reason TEXT); CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)");
  db.exec("INSERT INTO session_windows VALUES ('s1', 'agent:main:main', 1, 'initial'), ('checkpoint', 'agent:main:main', 0, 'compaction')");
  const event = (id, timestamp, model) => ({ type: "message", id, timestamp, message: {
    role: "assistant", model, content: "PRIVATE CONTENT MUST NOT BE COPIED", provider: "openai",
    usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 10, totalTokens: 130 },
  } });
  const first = event("e1", "2026-10-09T23:45:00Z", "gpt-5.4");
  const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, 1)");
  insert.run("s1", 0, JSON.stringify(first));
  insert.run("checkpoint", 0, JSON.stringify(event("checkpoint-copy", "2026-10-09T23:45:00Z", "gpt-5.4")));
  fs.writeFileSync(path.join(agent, "session-sqlite-import-archive", "s1.jsonl"), JSON.stringify(first) + "\n");
  const queuePath = path.join(root, "queue.jsonl");
  const cursors = { files: {} };
  const files = await resolveOpenclawSessionFiles({ TOKENTRACKER_OPENCLAW_HOME: home });
  assert.ok(files.includes(dbPath));
  const sync = () => parseOpenclawIncremental({ sessionFiles: files, cursors, queuePath });
  assert.equal((await sync()).eventsAggregated, 1);
  assert.equal((await sync()).eventsAggregated, 0);
  insert.run("s1", 1, JSON.stringify(event("e2", "2026-10-10T00:15:00Z", "gpt-5.5")));
  assert.equal((await sync()).eventsAggregated, 1);
  assert.equal((await sync()).eventsAggregated, 0);
  const rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.model), ["gpt-5.4", "gpt-5.5"]);
  assert.deepEqual(rows.map((r) => r.hour_start), ["2026-10-09T23:30:00.000Z", "2026-10-10T00:00:00.000Z"]);
  for (const row of rows) {
    assert.equal(row.input_tokens, 20);
    assert.equal(row.cached_input_tokens, 80);
    assert.equal(row.cache_creation_input_tokens, 10);
    assert.equal(row.total_tokens, 130);
  }
  assert.ok(!JSON.stringify(cursors).includes("PRIVATE CONTENT"));

  const trackerDir = path.join(root, "tracker");
  const pluginDir = path.join(root, "plugin");
  await ensureOpenclawSessionPluginFiles({ pluginDir, trackerDir, openclawHome: home });
  const pluginPath = path.join(pluginDir, "openclaw-session-sync", "index.js");
  // Exercise generated ESM rather than matching its source text.
  const module = await import(pathToFileURL(pluginPath).href);
  const handlers = {};
  module.default({ on: (name, fn) => { handlers[name] = fn; } });
  const cp = require("node:child_process");
  const originalSpawn = cp.spawn;
  const calls = [];
  cp.spawn = (...args) => { calls.push(args); return { unref() {} }; };
  try { await handlers.agent_end({}, { sessionKey: "agent:main:main", agentId: "main" }); }
  finally { cp.spawn = originalSpawn; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID, "s1");
  assert.equal(calls[0][2].env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS, undefined);
});
