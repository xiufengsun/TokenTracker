"use strict";

// Metadata-only pi (@mariozechner/pi-coding-agent) session reader for the
// Sessions sidecar. pi shares the on-disk layout and assistant-usage contract
// with oh-my-pi (both parse through the same pi-like incremental family in
// rollout.js), minus the nested-subagent transcript directories. Never
// persists prompts, assistant bodies, tool arguments, or command output.

const fs = require("node:fs");
const path = require("node:path");
const { physicalJsonlRecords } = require("./jsonl-lines");
const { resolvePiAgentDir } = require("./rollout");

// Same ceiling as the hourly pi parser: tool results can be enormous and must
// not be buffered/decoded when they cannot carry usage.
const PI_MAX_RECORD_BYTES = 64 * 1024 * 1024;

const EDIT_TOOLS = new Set([
  "apply_patch",
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "search_replace",
  "str_replace",
  "create_file",
  "write_file",
  "strreplace",
  "writefile",
]);

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

// pi usage fields match the pi-like family: input / output / cacheRead /
// cacheWrite / reasoningTokens (+ optional totalTokens).
function piUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = count(usage.input);
  const output = count(usage.output);
  const cached = count(usage.cacheRead);
  const created = count(usage.cacheWrite);
  const reasoning = count(usage.reasoningTokens ?? usage.reasoning);
  if (input === 0 && output === 0 && cached === 0 && created === 0 && reasoning === 0) return null;
  const reported = count(usage.totalTokens);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: created,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: reported > 0 ? reported : input + output + cached + created + reasoning,
  };
}

function addUsage(target, delta) {
  for (const key of Object.keys(delta)) target[key] = count(target[key]) + count(delta[key]);
}

function modelAlias(value) {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model || null;
}

// Match the hourly pi parser: reject placeholder epoch values that used to
// land usage in 1970 and vanish from current date filters.
const MIN_PI_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

function entryTimestampMs(entry, message) {
  const direct = Number(message?.timestamp);
  if (Number.isFinite(direct) && direct >= MIN_PI_TIMESTAMP_MS) return direct;
  if (typeof entry?.timestamp === "string" && entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed) && parsed >= MIN_PI_TIMESTAMP_MS) return parsed;
  }
  return null;
}

function sessionIdFromFilename(filePath) {
  // Layout mirrors omp: <timestamp>_<sessionId>.jsonl — prefer the suffix
  // after the last "_", falling back to the whole stem.
  const base = path.basename(filePath, ".jsonl");
  const idx = base.lastIndexOf("_");
  if (idx > 0 && idx < base.length - 1) return base.slice(idx + 1);
  return base || null;
}

function mainSessionStem(filePath) {
  return path.basename(filePath, ".jsonl");
}

function piInventoryIncomplete(pathName, error) {
  const err = new Error(`pi inventory incomplete: ${pathName}`);
  err.code = "PI_INVENTORY_INCOMPLETE";
  err.path = pathName;
  err.cause = error;
  return err;
}

// pi nests transcripts under sessions/<dir>/… at arbitrary depth (the hourly
// resolver walks recursively), so discovery walks recursively too. Visited
// directories are tracked by canonical path so a symlink cycle cannot turn
// the walk into an unbounded traversal.
function listJsonlRecursive(dir, incomplete = []) {
  const found = [];
  const visited = new Set();
  const walk = (current) => {
    let canonical;
    try {
      canonical = fs.realpathSync(current);
    } catch {
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      incomplete.push({ path: current, error: error?.code || "unreadable" });
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (!isDir && !isFile) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch (error) {
          if (error?.code !== "ENOENT") incomplete.push({ path: full, error: error?.code || "unreadable" });
          continue;
        }
      }
      if (isDir) walk(full);
      else if (isFile && entry.name.endsWith(".jsonl")) found.push(full);
    }
  };
  walk(dir);
  found.sort((a, b) => a.localeCompare(b));
  return found;
}

function discoverPiSessionFiles(env = process.env, incomplete = []) {
  const agentDir = resolvePiAgentDir(env);
  if (!agentDir) return [];
  const sessionsDir = path.join(agentDir, "sessions");
  try {
    const stat = fs.statSync(sessionsDir);
    if (!stat.isDirectory()) return [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    incomplete.push({ path: sessionsDir, error: error?.code || "unreadable" });
    return [];
  }
  return listJsonlRecursive(sessionsDir, incomplete);
}

// pi has no nested-subagent transcript directories (that layout is the omp
// fork's addition), so dependency tracking is the file list itself.
function piSessionDependencies(mainFiles) {
  return [...new Set((mainFiles || []).filter(Boolean))];
}

function fingerprintContent(content) {
  // In-memory only: never written to the sidecar.
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update(JSON.stringify(content ?? null)).digest("hex");
}

function toolNameFromBlock(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type !== "toolCall" && block.type !== "tool_use") return "";
  const name = block.name || block.toolName || block.tool_name || "";
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

async function readPiSessionFiles(mainFiles, { seenEntryIds = new Set() } = {}) {
  const rows = [];
  const mains = [...new Set((mainFiles || []).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  for (const mainPath of mains) {
    const tokens = emptyUsage();
    const modelUsage = new Map();
    const buckets = new Map();
    const times = new Set();
    let turns = 0;
    let edits = 0;
    let retries = 0;
    let cwd = null;
    let title = null;
    let sessionId = null;
    let lastPrompt = null;
    let turnOpen = false;
    let hadEdit = false;
    let turnModel = "pi-unknown";
    const modelsForEdits = new Map();

    const closeTurn = () => {
      if (hadEdit) {
        edits += 1;
        modelsForEdits.set(turnModel, (modelsForEdits.get(turnModel) || 0) + 1);
      }
      hadEdit = false;
      turnOpen = false;
    };

    let input;
    try {
      input = fs.createReadStream(mainPath);
    } catch (error) {
      throw piInventoryIncomplete(mainPath, error);
    }
    try {
      for await (const record of physicalJsonlRecords(input, {
        invalidUtf8: "record",
        maxRecordBytes: PI_MAX_RECORD_BYTES,
      })) {
        // Accept a complete final record even without a trailing newline;
        // skip oversized / invalid UTF-8.
        if (record.oversized || record.utf8Valid === false || !record.line) {
          if (!record.terminated) break;
          continue;
        }
        let entry;
        try {
          entry = JSON.parse(record.line);
        } catch {
          if (!record.terminated) break;
          continue;
        }
        if (!entry || typeof entry !== "object") {
          if (!record.terminated) break;
          continue;
        }

        if (entry.type === "session") {
          if (typeof entry.id === "string" && entry.id.trim()) sessionId = entry.id.trim();
          if (typeof entry.cwd === "string" && entry.cwd.trim()) cwd = entry.cwd.trim();
          if (typeof entry.title === "string" && entry.title.trim()) title = entry.title.trim();
          const ts = entryTimestampMs(entry, null);
          if (ts != null) times.add(ts);
          continue;
        }

        if (entry.type === "title_change" && typeof entry.title === "string" && entry.title.trim()) {
          title = entry.title.trim();
          continue;
        }

        // pi's /name command persists the session name as session_info.name
        // (latest wins, including an empty name that clears it).
        if (entry.type === "session_info" && typeof entry.name === "string") {
          title = entry.name.trim() || null;
          continue;
        }

        if (entry.type !== "message") continue;
        const message = entry.message && typeof entry.message === "object" ? entry.message : null;
        if (!message) continue;

        const entryId = typeof entry.id === "string" && entry.id ? entry.id : null;
        if (entryId && seenEntryIds.has(entryId)) continue;
        if (entryId) seenEntryIds.add(entryId);

        const ts = entryTimestampMs(entry, message);
        if (ts != null) times.add(ts);

        if (message.role === "user") {
          closeTurn();
          turns += 1;
          turnOpen = true;
          const fingerprint = fingerprintContent(message.content ?? null);
          if (lastPrompt && fingerprint === lastPrompt) retries += 1;
          lastPrompt = fingerprint;
          continue;
        }

        if (message.role === "assistant") {
          const delta = piUsage(message.usage);
          const model = modelAlias(message.model) || turnModel || "pi-unknown";
          // Mirror the hourly parser: only assistants with an entry id count.
          if (delta && entryId && ts != null) {
            const modelRow = modelUsage.get(model) || { model, ...emptyUsage(), usage_events: 0 };
            const bucketTime = new Date(Math.floor(ts / 60000) * 60000).toISOString();
            const key = `${model}\0${bucketTime}`;
            const bucket = buckets.get(key) || { model, timestamp: bucketTime, ...emptyUsage(), usage_events: 0 };
            addUsage(tokens, delta);
            addUsage(modelRow, delta);
            addUsage(bucket, delta);
            modelRow.usage_events += 1;
            bucket.usage_events += 1;
            modelUsage.set(model, modelRow);
            buckets.set(key, bucket);
            turnModel = model;
          }

          const content = Array.isArray(message.content) ? message.content : [];
          for (const block of content) {
            const name = toolNameFromBlock(block);
            if (!name) continue;
            if (turnOpen && EDIT_TOOLS.has(name)) hadEdit = true;
          }
          continue;
        }
      }
    } catch (error) {
      // Malformed records are skipped above; I/O / inventory errors must
      // surface so the builder keeps the previous complete pi snapshot.
      if (error?.code === "PI_INVENTORY_INCOMPLETE") throw error;
      throw piInventoryIncomplete(mainPath, error);
    } finally {
      input.destroy?.();
    }
    closeTurn();

    if (!sessionId) sessionId = sessionIdFromFilename(mainPath);
    const orderedTimes = [...times].sort((a, b) => a - b);
    let activeMs = 0;
    for (let i = 1; i < orderedTimes.length; i++) {
      const gap = orderedTimes[i] - orderedTimes[i - 1];
      if (gap <= 30 * 60 * 1000) activeMs += gap;
    }
    const models = [...modelUsage.values()].map((row) => ({
      ...row,
      edit_turns: modelsForEdits.get(row.model) || 0,
    }));
    if (!tokens.total_tokens && !turns) continue;

    rows.push({
      identity: sessionId || mainSessionStem(mainPath),
      files: [mainPath],
      session_id: sessionId || null,
      title,
      project_ref: cwd,
      model: models.length === 1 ? models[0].model : models.length > 1 ? "mixed" : "pi-unknown",
      model_usage: models,
      usage_buckets: [...buckets.values()],
      tokens,
      turns,
      edit_turns: edits,
      retry_turns: retries,
      usage_events: models.reduce((sum, row) => sum + count(row.usage_events), 0),
      started_at: orderedTimes.length ? new Date(orderedTimes[0]).toISOString() : null,
      ended_at: orderedTimes.length ? new Date(orderedTimes.at(-1)).toISOString() : null,
      active_ms: activeMs,
      provenance: {
        source: "local-session-log",
        confidence: "observed",
        retry_confidence: "inferred",
        content_retained: false,
        usage: "pi-jsonl-metadata",
      },
    });
  }

  return rows;
}

async function readPiSessions(mainFiles, options = {}) {
  return readPiSessionFiles(mainFiles, {
    seenEntryIds: options.seenEntryIds instanceof Set ? options.seenEntryIds : new Set(),
  });
}

module.exports = {
  discoverPiSessionFiles,
  piSessionDependencies,
  readPiSessions,
  sessionIdFromFilename,
};
