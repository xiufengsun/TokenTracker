const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { openTraeSnapshot } = require("./trae-snapshot");
const { withTraeSqlite } = require("./trae-sqlite");

const TOKEN_FIELDS = [
  "prompt_tokens", "prompt_tokens_total", "input_tokens",
  "completion_tokens", "completion_tokens_total", "output_tokens",
  "total_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "reasoning_tokens", "reasoning_output_tokens",
];

function resolveTraeDbPaths(env = process.env, { platform = process.platform, home = os.homedir() } = {}) {
  const explicit = String(env.TOKENTRACKER_TRAE_DB || "").trim();
  if (explicit) return [path.resolve(explicit)];
  const customHome = String(env.TOKENTRACKER_TRAE_HOME || "").trim();
  const parent = platform === "win32"
    ? env.APPDATA || path.join(home, "AppData", "Roaming")
    : platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : env.XDG_CONFIG_HOME || path.join(home, ".config");
  const roots = customHome ? [customHome] : [path.join(parent, "Trae"), path.join(parent, "TRAE SOLO")];
  const result = [];
  for (const root of roots) {
    // A decrypted sibling may be an old export. Only an explicit DB override
    // opts into one; normal discovery always reads the current application DB.
    for (const module of ["ai-agent", "ai-chat"]) {
      const candidate = path.resolve(root, "ModularData", module, "database.db");
      let present;
      try { present = fs.statSync(candidate).isFile(); }
      catch (err) {
        // Permission failures must reach the reader's diagnostics, not masquerade
        // as an absent installation and silently drop an entire usage history.
        present = err.code !== "ENOENT" && err.code !== "ENOTDIR";
      }
      if (present) {
        result.push(candidate);
        break;
      }
    }
  }
  return [...new Set(result)];
}

function error(message) {
  return new Error(`Cannot read TRAE usage: ${message}`);
}

async function projectUsage(queryRows) {
  const tables = await queryRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turn'");
  // history_v2.token_usage can be a context-size snapshot rather than billed
  // usage. Do not synthesize input tokens from those scalar values.
  if (!tables.length) throw error("unsupported database schema: chat_turn table is missing.");
  const columns = new Set((await queryRows("PRAGMA table_info(chat_turn)")).map((row) => row.name));
  if (!columns.has("context") || (!columns.has("created_at") && !columns.has("updated_at"))) {
    throw error("unsupported chat_turn schema.");
  }
  const column = (name, fallback = "NULL") => columns.has(name) ? `"${name}"` : fallback;
  const date = columns.has("created_at") && columns.has("updated_at")
    ? 'COALESCE("created_at", "updated_at")' : column("created_at", column("updated_at"));
  const modelPaths = [
    "persist_user_message_context.model_info.display_model_name",
    "persist_user_message_context.model_info.model_name",
    "persist_user_message_context.model_info.config_name", "model_name", "model",
    "agent_model", "selected_model.name", "selectedModel.name",
  ];
  const model = modelPaths.map((field) => `CASE WHEN json_type(context, '$.${field}') = 'text'
    THEN NULLIF(NULLIF(TRIM(json_extract(context, '$.${field}')), ''), '-') END`);
  const fields = TOKEN_FIELDS.map((field) => `CASE
    WHEN json_type(context, '$.token_usage.${field}') IN ('integer', 'real')
    THEN json_extract(context, '$.token_usage.${field}') END AS "${field}"`);
  const invalidFields = TOKEN_FIELDS.map((field) =>
    `COALESCE(json_type(context, '$.token_usage.${field}') NOT IN ('integer', 'real', 'null'), 0)`);
  // Project inside SQLite: prompts, messages, session titles, fee/account data,
  // and the rest of the context never cross into JS results or cursor state.
  const query = `SELECT CAST(${column("id", "rowid")} AS TEXT) AS id,
    ${column("session_id")} AS session_id, ${column("turn_id")} AS turn_id,
    ${date} AS created_at, ${column("updated_at")} AS updated_at,
    COALESCE(${model.join(", ")}, 'trae-unknown') AS model,
    ${fields.join(", ")}, (${invalidFields.join(" OR ")}) AS invalid_usage
    FROM chat_turn WHERE CASE WHEN json_valid(context)
      THEN json_type(context, '$.token_usage') = 'object' ELSE 0 END`;
  return (await queryRows(query)).map((row) => {
    const usage = {};
    let invalid = Boolean(row.invalid_usage);
    for (const field of TOKEN_FIELDS) {
      const value = row[field];
      if (value == null) continue;
      if (!Number.isSafeInteger(value) || value < 0) invalid = true;
      else usage[field] = value;
    }
    return {
      id: row.id, session_id: row.session_id, turn_id: row.turn_id,
      created_at: row.created_at, updated_at: row.updated_at,
      model: row.model, usage: invalid ? null : usage,
    };
  });
}

async function readTraeUsageRows(dbPath, { env = process.env } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let snapshot;
    try { snapshot = openTraeSnapshot(dbPath, env); }
    catch (err) {
      // The same writer race can surface while opening; retry it, but report
      // the specific failure once the attempts run out.
      if (err?.transient && attempt < 2) continue;
      throw err;
    }
    try {
      let result;
      try { result = await withTraeSqlite(snapshot, projectUsage); }
      catch (err) {
        // A writer may have changed pages while SQLite was reading. Discard
        // every projected row and retry; never publish a mixed snapshot.
        if (snapshot.isStable()) throw err;
        continue;
      }
      if (snapshot.isStable()) return result;
    } finally { snapshot.close(); }
  }
  throw error("database changed during the read; retry after TRAE finishes its current turn.");
}

module.exports = { resolveTraeDbPaths, readTraeUsageRows };
