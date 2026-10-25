"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_e) { }

const sqliteCliProbe = typeof DatabaseSync === "function"
  ? null
  : cp.spawnSync("sqlite3", ["-version"], { windowsHide: true, encoding: "utf8" });
const sqliteTest = typeof DatabaseSync === "function" || sqliteCliProbe?.status === 0
  ? test
  : test.skip;

const {
  resolveOpenSquillaDbPaths,
  parseOpenSquillaIncremental,
} = require("../src/lib/rollout");

function executeSql(dbPath, sql) {
  if (typeof DatabaseSync === "function") {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return;
  }
  cp.execFileSync("sqlite3", [dbPath, sql], { windowsHide: true });
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function createOpenSquillaDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opensquilla-test-"));
  const dbPath = path.join(dir, "sessions.db");
  executeSql(dbPath, [
    "CREATE TABLE usage_events (",
    "event_id TEXT PRIMARY KEY,",
    "started_at_ms INTEGER NOT NULL,",
    "completed_at_ms INTEGER,",
    "status TEXT NOT NULL,",
    "model TEXT",
    ");",
    "CREATE TABLE usage_event_items (",
    "event_id TEXT NOT NULL,",
    "ordinal INTEGER NOT NULL,",
    "model TEXT,",
    "input_tokens INTEGER NOT NULL,",
    "output_tokens INTEGER NOT NULL,",
    "reasoning_tokens INTEGER NOT NULL,",
    "cache_read_tokens INTEGER NOT NULL,",
    "cache_write_tokens INTEGER NOT NULL,",
    "total_tokens INTEGER NOT NULL,",
    "PRIMARY KEY (event_id, ordinal)",
    ");",
    "CREATE TABLE transcript_entries (content TEXT, turn_usage TEXT);",
    "INSERT INTO usage_events VALUES ('multi-model', 1790867100000, 1790867104000, 'finalized', 'parent-model');",
    "INSERT INTO usage_event_items VALUES ('multi-model', 0, 'deepseek-v4.1-flash-1017', 100, 40, 5, 30, 10, 140);",
    "INSERT INTO usage_event_items VALUES ('multi-model', 1, NULL, 20, 6, 2, 4, 1, 26);",
    "INSERT INTO usage_events VALUES ('unknown-usage', 1790867160000, NULL, 'unknown', 'ignored-model');",
    "INSERT INTO usage_event_items VALUES ('unknown-usage', 0, 'ignored-model', 500, 100, 0, 0, 0, 600);",
    "INSERT INTO transcript_entries VALUES (" + quote("PRIVATE PROMPT") + ", " + quote("PRIVATE RESPONSE") + ");",
  ].join("\n"));
  return { dir, dbPath };
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
}

test("OpenSquilla resolves Desktop, CLI, and configured database locations", () => {
  const home = path.join(os.tmpdir(), "opensquilla-home");
  const appData = path.join(home, "Roaming");
  assert.deepEqual(
    resolveOpenSquillaDbPaths({ HOME: home, APPDATA: appData }, { home, platform: "win32" }),
    [
      path.join(appData, "@opensquilla", "desktop-electron", "opensquilla", "state", "sessions.db"),
      path.join(home, ".opensquilla", "state", "sessions.db"),
    ],
  );
  assert.deepEqual(
    resolveOpenSquillaDbPaths(
      { OPENSQUILLA_GATEWAY_STATE_DIR: path.join(home, "custom-state") },
      { home, platform: "win32" },
    ),
    [path.join(home, "custom-state", "sessions.db")],
  );
  assert.deepEqual(
    resolveOpenSquillaDbPaths(
      { TOKENTRACKER_OPENSQUILLA_DB: path.join(home, "explicit.db") },
      { home, platform: "win32" },
    ),
    [path.join(home, "explicit.db")],
  );
});

sqliteTest("OpenSquilla imports finalized model rows, normalizes cache/reasoning, and deduplicates copies", async () => {
  const { dir, dbPath } = createOpenSquillaDb();
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const first = await parseOpenSquillaIncremental({ dbPaths: [dbPath], cursors, queuePath });
    assert.deepEqual(first, { recordsProcessed: 2, eventsAggregated: 2, bucketsQueued: 2 });

    const rows = readQueue(queuePath);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.source), ["opensquilla", "opensquilla"]);
    const deepseek = rows.find((row) => row.model === "deepseek-v4.1-flash-1017");
    assert.ok(deepseek);
    assert.equal(deepseek.input_tokens, 60);
    assert.equal(deepseek.cached_input_tokens, 30);
    assert.equal(deepseek.cache_creation_input_tokens, 10);
    assert.equal(deepseek.output_tokens, 35);
    assert.equal(deepseek.reasoning_output_tokens, 5);
    assert.equal(deepseek.total_tokens, 140);
    assert.doesNotMatch(JSON.stringify({ rows, cursors }), /PRIVATE (PROMPT|RESPONSE)/);

    const unchanged = await parseOpenSquillaIncremental({ dbPaths: [dbPath], cursors, queuePath });
    assert.deepEqual(unchanged, { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 });

    const copiedDbPath = path.join(dir, "sessions-copy.db");
    fs.copyFileSync(dbPath, copiedDbPath);
    const copied = await parseOpenSquillaIncremental({
      dbPaths: [dbPath, copiedDbPath],
      cursors,
      queuePath,
    });
    assert.equal(copied.eventsAggregated, 0);
    assert.equal(copied.bucketsQueued, 0);
    assert.equal(readQueue(queuePath).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
