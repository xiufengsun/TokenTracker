const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  readSqliteFirstValue,
  readSqliteJsonRows,
  readSqliteJsonRowsAsync,
  resetSqliteReaderWarningsForTests,
  shouldUseNodeSqlite,
  isSqliteExperimentalWarning,
  getDatabaseSync,
} = require("../src/lib/sqlite-reader");

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-sqlite-reader-"));
  const dbPath = path.join(dir, "state.db");
  fs.writeFileSync(dbPath, "", "utf8");
  return dbPath;
}

test("readSqliteJsonRows uses node:sqlite by default without spawning CLI", () => {
  const dbPath = tempDbPath();
  let nodeUsed = false;
  let cliCalled = false;
  const rows = readSqliteJsonRows(dbPath, "SELECT 100 AS n", {
    execFileSync() {
      cliCalled = true;
      throw new Error("CLI should not be called when node:sqlite works");
    },
    requireFn(name) {
      assert.equal(name, "node:sqlite");
      nodeUsed = true;
      return {
        DatabaseSync: class FakeDatabaseSync {
          constructor(actualDbPath, options) {
            assert.equal(actualDbPath, dbPath);
            assert.deepEqual(options, { readOnly: true });
          }
          prepare(sql) {
            assert.equal(sql, "SELECT 100 AS n");
            return {
              all() {
                return [{ n: 100 }];
              },
            };
          }
          close() {}
        },
      };
    },
  });

  assert.deepEqual(rows, [{ n: 100 }]);
  assert.equal(nodeUsed, true);
  assert.equal(cliCalled, false);
});

test("readSqliteJsonRowsAsync uses node:sqlite by default without spawning CLI", async () => {
  const dbPath = tempDbPath();
  let nodeUsed = false;
  let cliCalled = false;
  const rows = await readSqliteJsonRowsAsync(dbPath, "SELECT 200 AS n", {
    async execFile() {
      cliCalled = true;
      throw new Error("CLI async should not be called when node:sqlite works");
    },
    requireFn(name) {
      assert.equal(name, "node:sqlite");
      nodeUsed = true;
      return {
        DatabaseSync: class FakeDatabaseSync {
          constructor(actualDbPath, options) {
            assert.equal(actualDbPath, dbPath);
            assert.deepEqual(options, { readOnly: true });
          }
          prepare(sql) {
            assert.equal(sql, "SELECT 200 AS n");
            return {
              all() {
                return [{ n: 200 }];
              },
            };
          }
          close() {}
        },
      };
    },
  });

  assert.deepEqual(rows, [{ n: 200 }]);
  assert.equal(nodeUsed, true);
  assert.equal(cliCalled, false);
});

test("readSqliteJsonRows forces sqlite3 CLI when TOKENTRACKER_USE_NODE_SQLITE=0", () => {
  const dbPath = tempDbPath();
  let cliCalled = false;
  const rows = readSqliteJsonRows(dbPath, "SELECT 300 AS n", {
    env: { TOKENTRACKER_USE_NODE_SQLITE: "0" },
    execFileSync(cmd, args) {
      cliCalled = true;
      assert.equal(cmd, "sqlite3");
      return JSON.stringify([{ n: 300 }]);
    },
    requireFn() {
      throw new Error("node:sqlite should not be called when disabled via env");
    },
  });

  assert.deepEqual(rows, [{ n: 300 }]);
  assert.equal(cliCalled, true);
});

test("shouldUseNodeSqlite respects environment variables", () => {
  assert.equal(shouldUseNodeSqlite({}), true);
  assert.equal(shouldUseNodeSqlite({ TOKENTRACKER_USE_NODE_SQLITE: "1" }), true);
  assert.equal(shouldUseNodeSqlite({ TOKENTRACKER_USE_NODE_SQLITE: "true" }), true);
  assert.equal(shouldUseNodeSqlite({ TOKENTRACKER_USE_NODE_SQLITE: "0" }), false);
  assert.equal(shouldUseNodeSqlite({ TOKENTRACKER_USE_NODE_SQLITE: "false" }), false);
  assert.equal(shouldUseNodeSqlite({ TOKENTRACKER_FORCE_SQLITE_CLI: "1" }), false);
  assert.equal(shouldUseNodeSqlite({ TOKENTRACKER_FORCE_SQLITE_CLI: "true" }), false);
  // Force flag takes precedence over enable flag
  assert.equal(shouldUseNodeSqlite({ TOKENTRACKER_USE_NODE_SQLITE: "1", TOKENTRACKER_FORCE_SQLITE_CLI: "1" }), false);
});

test("isSqliteExperimentalWarning is narrow: matches only SQLite ExperimentalWarning", () => {
  // Matches exact SQLite experimental string
  assert.equal(
    isSqliteExperimentalWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning"
    ),
    true
  );

  // Matches Error object
  assert.equal(
    isSqliteExperimentalWarning(
      Object.assign(new Error("SQLite is an experimental feature and might change at any time"), {
        name: "ExperimentalWarning",
      })
    ),
    true
  );

  // Does NOT match other experimental features
  assert.equal(
    isSqliteExperimentalWarning(
      "VM Modules is an experimental feature and might change at any time",
      "ExperimentalWarning"
    ),
    false
  );

  // Does NOT match non-experimental warning types even if message mentions SQLite
  assert.equal(
    isSqliteExperimentalWarning("SQLite is an experimental feature", "DeprecationWarning"),
    false
  );
  assert.equal(
    isSqliteExperimentalWarning("SQLite is an experimental feature", "UserWarning"),
    false
  );
});

test("getDatabaseSync warning suppression is non-destructive and idempotent", (t, done) => {
  const origEmitWarning = process.emitWarning;

  // Verify setup idempotency
  const sync1 = getDatabaseSync();
  const sync2 = getDatabaseSync();
  assert.equal(sync1, sync2);

  // Verify process.emitWarning is restored to original function reference
  assert.equal(process.emitWarning, origEmitWarning);

  // Verify non-sqlite warnings still fire through process.emitWarning
  let warningReceived = null;
  const onWarning = (w) => {
    warningReceived = w;
  };
  process.on("warning", onWarning);

  process.emitWarning("Test custom non-sqlite warning", "CustomTestWarning");

  process.nextTick(() => {
    process.removeListener("warning", onWarning);
    assert.ok(warningReceived, "Custom warning should have been emitted");
    assert.equal(warningReceived.message, "Test custom non-sqlite warning");
    assert.equal(warningReceived.name, "CustomTestWarning");
    done();
  });
});

test("readSqliteJsonRows uses sqlite3 CLI first", () => {
  const dbPath = tempDbPath();
  const rows = readSqliteJsonRows(dbPath, "SELECT 1 AS n", {
    execFileSync(cmd, args, options) {
      assert.equal(cmd, "sqlite3");
      assert.deepEqual(args, ["-json", dbPath, "SELECT 1 AS n"]);
      assert.equal(options.windowsHide, true);
      return JSON.stringify([{ n: 1 }]);
    },
    requireFn() {
      throw new Error("node:sqlite should not be used");
    },
  });

  assert.deepEqual(rows, [{ n: 1 }]);
});

test("readSqliteJsonRowsAsync hides the sqlite3 console window on Windows", async () => {
  const dbPath = tempDbPath();
  const rows = await readSqliteJsonRowsAsync(dbPath, "SELECT 3 AS n", {
    async execFile(cmd, args, options) {
      assert.equal(cmd, "sqlite3");
      assert.deepEqual(args, ["-json", dbPath, "SELECT 3 AS n"]);
      assert.equal(options.windowsHide, true);
      return { stdout: JSON.stringify([{ n: 3 }]) };
    },
    requireFn() {
      throw new Error("node:sqlite should not be used");
    },
  });

  assert.deepEqual(rows, [{ n: 3 }]);
});

test("readSqliteJsonRows falls back to node:sqlite when sqlite3 CLI fails", () => {
  const dbPath = tempDbPath();
  let closed = false;
  const rows = readSqliteJsonRows(dbPath, "SELECT 2 AS n", {
    execFileSync() {
      throw new Error("spawn sqlite3 ENOENT");
    },
    requireFn(name) {
      assert.equal(name, "node:sqlite");
      return {
        DatabaseSync: class FakeDatabaseSync {
          constructor(actualDbPath, options) {
            assert.equal(actualDbPath, dbPath);
            assert.deepEqual(options, { readOnly: true });
          }

          prepare(sql) {
            assert.equal(sql, "SELECT 2 AS n");
            return {
              all() {
                return [{ n: 2 }];
              },
            };
          }

          close() {
            closed = true;
          }
        },
      };
    },
  });

  assert.deepEqual(rows, [{ n: 2 }]);
  assert.equal(closed, true);
});

test("readSqliteJsonRows warns once when no sqlite reader works", () => {
  resetSqliteReaderWarningsForTests();
  const dbPath = tempDbPath();
  let stderr = "";
  const options = {
    label: "OpenCode",
    env: {},
    stderr: { write(chunk) { stderr += chunk; } },
    execFileSync() {
      throw new Error("spawn sqlite3 ENOENT");
    },
    requireFn() {
      throw new Error("No such built-in module: node:sqlite");
    },
  };

  assert.deepEqual(readSqliteJsonRows(dbPath, "SELECT 1", options), []);
  assert.deepEqual(readSqliteJsonRows(dbPath, "SELECT 1", options), []);

  const matches = stderr.match(/Cannot read OpenCode SQLite database/g) || [];
  assert.equal(matches.length, 1);
  assert.match(stderr, /Install sqlite3 CLI/);
  assert.match(stderr, /Node\.js 22\+/);
});

test("readSqliteJsonRows includes low-level errors in debug mode", () => {
  resetSqliteReaderWarningsForTests();
  const dbPath = tempDbPath();
  let stderr = "";

  readSqliteJsonRows(dbPath, "SELECT 1", {
    label: "Kiro CLI",
    env: { TOKENTRACKER_DEBUG: "1" },
    stderr: { write(chunk) { stderr += chunk; } },
    execFileSync() {
      throw new Error("spawn sqlite3 ENOENT");
    },
    requireFn() {
      throw new Error("No such built-in module: node:sqlite");
    },
  });

  assert.match(stderr, /sqlite3 CLI failed: spawn sqlite3 ENOENT/);
  assert.match(stderr, /node:sqlite failed: No such built-in module: node:sqlite/);
});

test("readSqliteJsonRows stays quiet for query/schema failures", () => {
  resetSqliteReaderWarningsForTests();
  const dbPath = tempDbPath();
  let stderr = "";

  const rows = readSqliteJsonRows(dbPath, "SELECT value FROM MissingTable", {
    label: "Cursor",
    env: { TOKENTRACKER_DEBUG: "1" },
    stderr: { write(chunk) { stderr += chunk; } },
    execFileSync() {
      throw new Error("Parse error: no such table: MissingTable");
    },
    requireFn() {
      throw new Error("no such table: MissingTable");
    },
  });

  assert.deepEqual(rows, []);
  assert.equal(stderr, "");
});

test("readSqliteFirstValue trims string values and closes node:sqlite DB", () => {
  const dbPath = tempDbPath();
  let closed = false;
  const value = readSqliteFirstValue(dbPath, "SELECT value FROM ItemTable", "value", {
    execFileSync() {
      throw new Error("spawn sqlite3 ENOENT");
    },
    requireFn() {
      return {
        DatabaseSync: class FakeDatabaseSync {
          prepare() {
            return {
              all() {
                return [{ value: " token\n" }];
              },
            };
          }

          close() {
            closed = true;
          }
        },
      };
    },
  });

  assert.equal(value, "token");
  assert.equal(closed, true);
});
