"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, describe, before, after } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const {
  readSqliteJsonRows,
  readSqliteJsonRowsAsync,
  readSqliteFirstValue,
} = require("../src/lib/sqlite-reader");

describe("SQLite Reader Parity Diff Suite (node:sqlite vs sqlite3 CLI)", () => {
  let tmpDir;
  let cursorDbPath;
  let workspaceDbPath;
  let traeDbPath;
  let mixedDbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-sqlite-parity-"));

    // 1. Cursor state.vscdb fixture
    cursorDbPath = path.join(tmpDir, "cursor-state.vscdb");
    const cursorDb = new DatabaseSync(cursorDbPath);
    cursorDb.exec(`
      CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.synthetic');
      INSERT INTO ItemTable VALUES ('telemetry.machineId', 'deadbeef0123456789abcdef');
      INSERT INTO ItemTable VALUES ('empty.val', '');
      INSERT INTO ItemTable VALUES ('null.val', NULL);
    `);
    cursorDb.close();

    // 2. WorkspaceStorage state.vscdb fixture
    workspaceDbPath = path.join(tmpDir, "workspace-state.vscdb");
    const wsDb = new DatabaseSync(workspaceDbPath);
    wsDb.exec(`
      CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO ItemTable VALUES ('workbench.panel.composer', '{"composerData":{"conversation":[{"role":"user","tokens":150}]}}');
      INSERT INTO ItemTable VALUES ('workbench.explorer.views', '["explorer","outline","timeline"]');
      INSERT INTO ItemTable VALUES ('workspace.lastModified', '1730200000000');
    `);
    wsDb.close();

    // 3. Trae usage fixture
    traeDbPath = path.join(tmpDir, "trae.db");
    const traeDb = new DatabaseSync(traeDbPath);
    traeDb.exec(`
      CREATE TABLE chat_turn (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        turn_id TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        context TEXT
      );
      CREATE TABLE history_v2 (
        token_usage INTEGER
      );
      INSERT INTO history_v2 VALUES (987654321);
      INSERT INTO chat_turn VALUES (
        1,
        'synthetic-session-1',
        'turn-001',
        1770000000000,
        1770000000100,
        '{"input_tokens":500,"output_tokens":120,"model":"claude-3-5-sonnet"}'
      );
      INSERT INTO chat_turn VALUES (
        2,
        'synthetic-session-1',
        NULL,
        1770000001000,
        1770000001200,
        '{"input_tokens":1200,"output_tokens":450,"model":"gpt-4o"}'
      );
      INSERT INTO chat_turn VALUES (
        3,
        'synthetic-session-2',
        'turn-002',
        1770000005000,
        1770000005500,
        'unicode: \\u4f60\\u597d \\u4e16\\u754c (hello world)'
      );
    `);
    traeDb.close();

    // 4. Mixed types, BLOBs, Reals, NULLs, and empty sets fixture
    mixedDbPath = path.join(tmpDir, "mixed-types.db");
    const mixedDb = new DatabaseSync(mixedDbPath);
    mixedDb.exec(`
      CREATE TABLE mixed (
        id INTEGER PRIMARY KEY,
        int_val INTEGER,
        real_val REAL,
        text_val TEXT,
        null_val TEXT,
        blob_val BLOB
      );
      INSERT INTO mixed VALUES (1, 42, 3.14159, 'hello "quotes"', NULL, X'616263');
      INSERT INTO mixed VALUES (2, -100, 0.0, '', NULL, NULL);
      INSERT INTO mixed VALUES (3, 0, -99.99, 'line1\\nline2\\ttab', 'non-null', X'FF00FE');
    `);
    mixedDb.close();
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function assertQueryParity(dbPath, sql, label) {
    // Run via node:sqlite (default or explicit TOKENTRACKER_USE_NODE_SQLITE=1)
    const nodeSyncRows = readSqliteJsonRows(dbPath, sql, {
      label,
      env: { TOKENTRACKER_USE_NODE_SQLITE: "1" },
    });
    const nodeAsyncRows = await readSqliteJsonRowsAsync(dbPath, sql, {
      label,
      env: { TOKENTRACKER_USE_NODE_SQLITE: "1" },
    });

    // Run via sqlite3 CLI (TOKENTRACKER_USE_NODE_SQLITE=0)
    const cliSyncRows = readSqliteJsonRows(dbPath, sql, {
      label,
      env: { TOKENTRACKER_USE_NODE_SQLITE: "0" },
    });
    const cliAsyncRows = await readSqliteJsonRowsAsync(dbPath, sql, {
      label,
      env: { TOKENTRACKER_USE_NODE_SQLITE: "0" },
    });

    // 1. node:sqlite sync vs sqlite3 CLI sync
    assert.deepEqual(
      nodeSyncRows,
      cliSyncRows,
      `Sync parity failure for [${label}] with SQL: ${sql}`
    );

    // 2. node:sqlite async vs sqlite3 CLI async
    assert.deepEqual(
      nodeAsyncRows,
      cliAsyncRows,
      `Async parity failure for [${label}] with SQL: ${sql}`
    );

    // 3. node:sqlite sync vs node:sqlite async
    assert.deepEqual(
      nodeSyncRows,
      nodeAsyncRows,
      `Internal sync vs async parity failure for [${label}] with SQL: ${sql}`
    );
  }

  test("Parity: Cursor state.vscdb queries match byte-for-byte", async () => {
    await assertQueryParity(
      cursorDbPath,
      "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';",
      "Cursor-Token"
    );
    await assertQueryParity(
      cursorDbPath,
      "SELECT key, value FROM ItemTable ORDER BY key ASC;",
      "Cursor-All"
    );
    await assertQueryParity(
      cursorDbPath,
      "SELECT value FROM ItemTable WHERE key = 'nonexistent.key';",
      "Cursor-Empty"
    );

    // Also test readSqliteFirstValue parity
    const nodeVal = readSqliteFirstValue(
      cursorDbPath,
      "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';",
      "value",
      { env: { TOKENTRACKER_USE_NODE_SQLITE: "1" } }
    );
    const cliVal = readSqliteFirstValue(
      cursorDbPath,
      "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';",
      "value",
      { env: { TOKENTRACKER_USE_NODE_SQLITE: "0" } }
    );
    assert.equal(nodeVal, cliVal);
    assert.equal(nodeVal, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.synthetic");
  });

  test("Parity: WorkspaceStorage state.vscdb queries match byte-for-byte", async () => {
    await assertQueryParity(
      workspaceDbPath,
      "SELECT key, value FROM ItemTable ORDER BY key DESC;",
      "WorkspaceStorage-All"
    );
    await assertQueryParity(
      workspaceDbPath,
      "SELECT value FROM ItemTable WHERE key LIKE 'workbench.%';",
      "WorkspaceStorage-Like"
    );
  });

  test("Parity: Trae SQLite usage & chat turns match byte-for-byte", async () => {
    await assertQueryParity(
      traeDbPath,
      "SELECT * FROM chat_turn ORDER BY id ASC;",
      "Trae-Turns"
    );
    await assertQueryParity(
      traeDbPath,
      "SELECT token_usage FROM history_v2;",
      "Trae-History"
    );
    await assertQueryParity(
      traeDbPath,
      "SELECT id, session_id, created_at FROM chat_turn WHERE id > 1 ORDER BY id DESC;",
      "Trae-Filter"
    );
  });

  test("Parity: Mixed types (INTEGER, REAL, NULL, BLOB, TEXT, empty set) match byte-for-byte", async () => {
    await assertQueryParity(
      mixedDbPath,
      "SELECT * FROM mixed ORDER BY id ASC;",
      "Mixed-All"
    );
    await assertQueryParity(
      mixedDbPath,
      "SELECT id, real_val, text_val FROM mixed WHERE int_val >= 0 ORDER BY id;",
      "Mixed-Filter"
    );
    await assertQueryParity(
      mixedDbPath,
      "SELECT * FROM mixed WHERE id = 99999;",
      "Mixed-Empty"
    );
    await assertQueryParity(
      mixedDbPath,
      "SELECT COUNT(*) AS count, SUM(int_val) AS total_int FROM mixed;",
      "Mixed-Aggregate"
    );
  });
});
