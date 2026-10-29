const cp = require("node:child_process");
const fssync = require("node:fs");
const { promisify } = require("node:util");

const warnedSqliteReadFailures = new Set();

function isDebugEnabled(env = process.env) {
  const value = String((env && env.TOKENTRACKER_DEBUG) || "").toLowerCase();
  return value === "1" || value === "true";
}

function formatError(err) {
  if (!err) return "unknown error";
  return err && err.message ? err.message : String(err);
}

function warnSqliteUnavailable({ dbPath, label, cliError, nodeSqliteError, env, stderr }) {
  const key = `${label || "SQLite"}:${dbPath || ""}`;
  if (warnedSqliteReadFailures.has(key)) return;
  warnedSqliteReadFailures.add(key);

  const out = stderr && typeof stderr.write === "function" ? stderr : process.stderr;
  const displayLabel = label || "local";
  out.write(
    `[tokentracker] Cannot read ${displayLabel} SQLite database. Install sqlite3 CLI and add it to PATH, or use Node.js 22+ with node:sqlite support. Path: ${dbPath}\n`,
  );
  if (isDebugEnabled(env)) {
    out.write(`[tokentracker] sqlite3 CLI failed: ${formatError(cliError)}\n`);
    out.write(`[tokentracker] node:sqlite failed: ${formatError(nodeSqliteError)}\n`);
  }
}

function readSqliteRowsWithCli(dbPath, sql, { execFileSync, timeout, maxBuffer, readOnly }) {
  const args = readOnly ? ["-readonly", "-json", dbPath, sql] : ["-json", dbPath, sql];
  const raw = execFileSync("sqlite3", args, {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer,
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!raw || !raw.trim()) return [];
  const rows = JSON.parse(raw);
  return Array.isArray(rows) ? rows : [];
}

function isSqliteCliUnavailable(err) {
  const message = formatError(err).toLowerCase();
  return (
    err?.code === "ENOENT" ||
    message.includes("spawn sqlite3 enoent") ||
    message.includes("sqlite3 enoent") ||
    message.includes("not recognized as an internal or external command")
  );
}

function isNodeSqliteUnavailable(err) {
  const message = formatError(err).toLowerCase();
  return (
    message.includes("no such built-in module") ||
    message.includes("cannot find module 'node:sqlite'") ||
    message.includes('cannot find module "node:sqlite"') ||
    message.includes("node:sqlite databasesync is unavailable")
  );
}

function shouldUseNodeSqlite(env = process.env) {
  if (!env) return true;
  if (env.TOKENTRACKER_FORCE_SQLITE_CLI === "1" || env.TOKENTRACKER_FORCE_SQLITE_CLI === "true") {
    return false;
  }
  const val = String(env.TOKENTRACKER_USE_NODE_SQLITE || "").toLowerCase().trim();
  if (val === "0" || val === "false") {
    return false;
  }
  return true;
}

function normalizeRow(row) {
  const plain = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      plain[key] = Buffer.from(value).toString("latin1");
    } else if (typeof value === "bigint") {
      plain[key] = Number(value);
    } else {
      plain[key] = value;
    }
  }
  return plain;
}

let cachedDatabaseSync = null;

function isSqliteExperimentalWarning(warning, type) {
  const isTypeMatch =
    type === "ExperimentalWarning" ||
    (warning && typeof warning === "object" && warning.name === "ExperimentalWarning");
  const msg = typeof warning === "string" ? warning : (warning && warning.message);
  const isMessageMatch = typeof msg === "string" && msg.includes("SQLite is an experimental feature");
  return Boolean(isTypeMatch && isMessageMatch);
}

function getDatabaseSync(requireFn) {
  if (cachedDatabaseSync && !requireFn) {
    return cachedDatabaseSync;
  }
  const origEmitWarning = process.emitWarning;
  if (typeof origEmitWarning === "function") {
    process.emitWarning = function (warning, ...args) {
      const type = typeof args[0] === "string" ? args[0] : (args[0] && args[0].type);
      if (isSqliteExperimentalWarning(warning, type)) {
        return;
      }
      return origEmitWarning.apply(process, [warning, ...args]);
    };
  }
  try {
    const sqlite = (requireFn || require)("node:sqlite");
    const dbSync = sqlite ? sqlite.DatabaseSync : null;
    if (!requireFn) {
      cachedDatabaseSync = dbSync;
    }
    return dbSync;
  } finally {
    if (typeof origEmitWarning === "function") {
      process.emitWarning = origEmitWarning;
    }
  }
}

function readSqliteRowsWithNode(dbPath, sql, { requireFn }) {
  const DatabaseSync = getDatabaseSync(requireFn);
  if (typeof DatabaseSync !== "function") {
    throw new Error("node:sqlite DatabaseSync is unavailable");
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(sql);
    let rows;
    try {
      rows = stmt.all();
    } catch (err) {
      if (err && err.code === "ERR_OUT_OF_RANGE" && typeof stmt.setReadBigInts === "function") {
        stmt.setReadBigInts(true);
        rows = stmt.all();
      } else {
        throw err;
      }
    }
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const count = rows.length;
    const plain = new Array(count);
    for (let i = 0; i < count; i++) {
      plain[i] = normalizeRow(rows[i]);
    }
    return plain;
  } finally {
    db.close();
  }
}

function readSqliteJsonRows(dbPath, sql, options = {}) {
  if (!dbPath || !sql) return [];
  try {
    if (!fssync.existsSync(dbPath)) return [];
  } catch (_e) {
    return [];
  }
  const execFileSync = options.execFileSync || cp.execFileSync;
  const requireFn = options.requireFn || require;
  const env = options.env || process.env;
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 30_000;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : 50 * 1024 * 1024;
  const label = options.label || "local";

  const preferNode = shouldUseNodeSqlite(env);

  let nodeSqliteError = null;
  let cliError = null;

  if (preferNode) {
    try {
      return readSqliteRowsWithNode(dbPath, sql, { requireFn });
    } catch (err) {
      nodeSqliteError = err;
    }

    try {
      return readSqliteRowsWithCli(dbPath, sql, {
        execFileSync,
        timeout,
        maxBuffer,
        readOnly: Boolean(options.readOnly),
      });
    } catch (err) {
      cliError = err;
    }
  } else {
    try {
      return readSqliteRowsWithCli(dbPath, sql, {
        execFileSync,
        timeout,
        maxBuffer,
        readOnly: Boolean(options.readOnly),
      });
    } catch (err) {
      cliError = err;
    }

    try {
      return readSqliteRowsWithNode(dbPath, sql, { requireFn });
    } catch (err) {
      nodeSqliteError = err;
    }
  }

  if (isSqliteCliUnavailable(cliError) && isNodeSqliteUnavailable(nodeSqliteError)) {
    warnSqliteUnavailable({
      dbPath,
      label,
      cliError,
      nodeSqliteError,
      env,
      stderr: options.stderr,
    });
  }
  if (options.throwOnReadFailure) {
    const err = new Error(
      `Cannot read ${label} SQLite database at ${dbPath}: ${formatError(cliError)}; ${formatError(nodeSqliteError)}`,
    );
    err.cliError = cliError;
    err.nodeSqliteError = nodeSqliteError;
    throw err;
  }
  return [];
}

async function readSqliteRowsWithCliAsync(dbPath, sql, { execFile, timeout, maxBuffer, readOnly }) {
  const args = readOnly ? ["-readonly", "-json", dbPath, sql] : ["-json", dbPath, sql];
  const { stdout } = await execFile("sqlite3", args, {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer,
    timeout,
  });
  if (!stdout || !stdout.trim()) return [];
  const rows = JSON.parse(stdout);
  return Array.isArray(rows) ? rows : [];
}

async function readSqliteJsonRowsAsync(dbPath, sql, options = {}) {
  if (!dbPath || !sql) return [];
  try {
    if (!fssync.existsSync(dbPath)) return [];
  } catch (_e) {
    return [];
  }
  const execFile = options.execFile || promisify(cp.execFile);
  const requireFn = options.requireFn || require;
  const env = options.env || process.env;
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 30_000;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : 50 * 1024 * 1024;
  const label = options.label || "local";

  const preferNode = shouldUseNodeSqlite(env);

  let nodeSqliteError = null;
  let cliError = null;

  if (preferNode) {
    try {
      return readSqliteRowsWithNode(dbPath, sql, { requireFn });
    } catch (err) {
      nodeSqliteError = err;
    }

    try {
      return await readSqliteRowsWithCliAsync(dbPath, sql, {
        execFile,
        timeout,
        maxBuffer,
        readOnly: Boolean(options.readOnly),
      });
    } catch (err) {
      cliError = err;
    }
  } else {
    try {
      return await readSqliteRowsWithCliAsync(dbPath, sql, {
        execFile,
        timeout,
        maxBuffer,
        readOnly: Boolean(options.readOnly),
      });
    } catch (err) {
      cliError = err;
    }

    try {
      return readSqliteRowsWithNode(dbPath, sql, { requireFn });
    } catch (err) {
      nodeSqliteError = err;
    }
  }

  if (isSqliteCliUnavailable(cliError) && isNodeSqliteUnavailable(nodeSqliteError)) {
    warnSqliteUnavailable({
      dbPath,
      label,
      cliError,
      nodeSqliteError,
      env,
      stderr: options.stderr,
    });
  }
  if (options.throwOnReadFailure) {
    const err = new Error(
      `Cannot read ${label} SQLite database at ${dbPath}: ${formatError(cliError)}; ${formatError(nodeSqliteError)}`,
    );
    err.cliError = cliError;
    err.nodeSqliteError = nodeSqliteError;
    throw err;
  }
  return [];
}

function readSqliteFirstValue(dbPath, sql, column, options = {}) {
  const rows = readSqliteJsonRows(dbPath, sql, options);
  const row = rows[0];
  if (!row || typeof row !== "object") return null;
  const key = typeof column === "string" && column.length > 0 ? column : Object.keys(row)[0];
  const value = row[key];
  return typeof value === "string" ? value.trim() : value == null ? null : String(value).trim();
}

function resetSqliteReaderWarningsForTests() {
  warnedSqliteReadFailures.clear();
}

module.exports = {
  readSqliteJsonRows,
  readSqliteJsonRowsAsync,
  readSqliteFirstValue,
  resetSqliteReaderWarningsForTests,
  shouldUseNodeSqlite,
  isSqliteExperimentalWarning,
  getDatabaseSync,
};
