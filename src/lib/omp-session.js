"use strict";

// Metadata-only oh-my-pi (omp) session reader for the Sessions sidecar.
// Reuses the same on-disk layout and assistant-usage contract as the hourly
// OMP sync parser in rollout.js. Never persists prompts, assistant bodies,
// tool arguments, or command output.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { physicalJsonlRecords } = require("./jsonl-lines");
const { resolveOmpAgentDir, resolveOmpSubagentFiles } = require("./rollout");

// Same ceiling as the hourly OMP parser: tool results can be enormous and must
// not be buffered/decoded when they cannot carry usage.
const OMP_MAX_RECORD_BYTES = 64 * 1024 * 1024;

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
const AGENT_TOOLS = new Set(["task", "agent", "subagent", "spawn_agent", "spawn_subagent"]);

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

function ompUsage(usage) {
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

// Match hourly ompEntryTimestampMs: reject placeholder epoch values that
// used to land usage in 1970 and vanish from current date filters.
const MIN_OMP_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

function entryTimestampMs(entry, message) {
  const direct = Number(message?.timestamp);
  if (Number.isFinite(direct) && direct >= MIN_OMP_TIMESTAMP_MS) return direct;
  if (typeof entry?.timestamp === "string" && entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed) && parsed >= MIN_OMP_TIMESTAMP_MS) return parsed;
  }
  return null;
}

function sessionIdFromFilename(filePath) {
  const base = path.basename(filePath, ".jsonl");
  // Layout: <timestamp>_<sessionId>.jsonl — timestamp is ISO-like with dashes/colons
  // replaced, then underscore, then the id. Prefer the suffix after the last "_".
  const idx = base.lastIndexOf("_");
  if (idx > 0 && idx < base.length - 1) return base.slice(idx + 1);
  return base || null;
}

function mainSessionStem(filePath) {
  return path.basename(filePath, ".jsonl");
}

function ompInventoryIncomplete(pathName, error) {
  const err = new Error(`omp inventory incomplete: ${pathName}`);
  err.code = "OMP_INVENTORY_INCOMPLETE";
  err.path = pathName;
  err.cause = error;
  return err;
}

function listNestedJsonlSync(dir, { strict = false } = {}) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (strict) throw ompInventoryIncomplete(current, error);
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
          if (error?.code !== "ENOENT" && strict) throw ompInventoryIncomplete(full, error);
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

function ompSubagentFilesForMain(mainPath, { strict = false } = {}) {
  const nestedDir = mainPath.replace(/\.jsonl$/i, "");
  if (!nestedDir || nestedDir === mainPath) return [];
  try {
    const st = fs.statSync(nestedDir);
    if (!st.isDirectory()) return [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    if (strict) throw ompInventoryIncomplete(nestedDir, error);
    return [];
  }
  return listNestedJsonlSync(nestedDir, { strict });
}

function ompSessionDependencies(mainFiles) {
  const deps = new Set();
  for (const file of mainFiles || []) {
    deps.add(file);
    for (const nested of ompSubagentFilesForMain(file)) deps.add(nested);
  }
  return [...deps];
}

function discoverOmpSessionFiles(env = process.env, incomplete = []) {
  // Walk sessions/ ourselves so permission errors surface as incomplete
  // discovery (preserving the prior sidecar) instead of looking like "no OMP".
  const agentDir = resolveOmpAgentDir(env);
  if (!agentDir) return [];
  const sessionsDir = path.join(agentDir, "sessions");
  let cwdEntries;
  try {
    cwdEntries = fs.readdirSync(sessionsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    incomplete.push({ path: sessionsDir, error: error?.code || "unreadable" });
    return [];
  }

  const files = [];
  for (const cwdDir of cwdEntries) {
    const cwdPath = path.join(sessionsDir, cwdDir);
    let stat;
    try {
      stat = fs.statSync(cwdPath);
    } catch (error) {
      if (error?.code !== "ENOENT") incomplete.push({ path: cwdPath, error: error?.code || "unreadable" });
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(cwdPath);
    } catch (error) {
      if (error?.code !== "ENOENT") incomplete.push({ path: cwdPath, error: error?.code || "unreadable" });
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      files.push(path.join(cwdPath, entry));
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function discoverOmpSubagentFiles(env = process.env) {
  try {
    return resolveOmpSubagentFiles(env);
  } catch {
    return [];
  }
}

function fingerprintContent(content) {
  // In-memory only: never written to the sidecar.
  return crypto.createHash("sha256").update(JSON.stringify(content ?? null)).digest("hex");
}

function toolNameFromBlock(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type !== "toolCall" && block.type !== "tool_use") return "";
  const name = block.name || block.toolName || block.tool_name || "";
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

async function readOmpSessionFiles(mainFiles, { seenEntryIds = new Set() } = {}) {
  const rows = [];
  const mains = [...new Set((mainFiles || []).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  for (const mainPath of mains) {
    const nested = ompSubagentFilesForMain(mainPath, { strict: true });
    const files = [mainPath, ...nested];
    const tokens = emptyUsage();
    const modelUsage = new Map();
    const buckets = new Map();
    const times = new Set();
    let turns = 0;
    let edits = 0;
    let retries = 0;
    let subagentCalls = 0;
    const subagentTypes = new Map();
    let cwd = null;
    let title = null;
    let sessionId = null;
    let lastPrompt = null;
    let turnOpen = false;
    let hadEdit = false;
    let turnModel = "omp-unknown";
    const modelsForEdits = new Map();

    const closeTurn = () => {
      if (hadEdit) {
        edits += 1;
        modelsForEdits.set(turnModel, (modelsForEdits.get(turnModel) || 0) + 1);
      }
      hadEdit = false;
      turnOpen = false;
    };

    for (const filePath of files) {
      const isMain = filePath === mainPath;
      // Isolate turn state per transcript so a nested child cannot rewrite the
      // parent's open-turn edit attribution (or vice versa).
      closeTurn();
      turnModel = "omp-unknown";
      let input;
      try {
        input = fs.createReadStream(filePath);
      } catch (error) {
        throw ompInventoryIncomplete(filePath, error);
      }
      try {
      for await (const record of physicalJsonlRecords(input, {
        invalidUtf8: "record",
        maxRecordBytes: OMP_MAX_RECORD_BYTES,
      })) {
        // Match hourly scanOmpLikeTranscript: accept a complete final record
        // even without a trailing newline; skip oversized / invalid UTF-8.
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
          // Only the main transcript names the resumable session / project.
          // Nested subagent headers carry their own ids and must not replace it.
          if (isMain) {
            if (typeof entry.id === "string" && entry.id.trim()) sessionId = entry.id.trim();
            if (typeof entry.cwd === "string" && entry.cwd.trim()) cwd = entry.cwd.trim();
            if (typeof entry.title === "string" && entry.title.trim()) title = entry.title.trim();
          }
          const ts = entryTimestampMs(entry, null);
          if (ts != null) times.add(ts);
          continue;
        }

        if (isMain && entry.type === "title_change" && typeof entry.title === "string" && entry.title.trim()) {
          title = entry.title.trim();
          continue;
        }

        // model_usage contributes accounting outside the transcript; include it
        // so Sessions totals stay aligned with providers that emit those rows.
        if (entry.type === "model_usage") {
          const delta = ompUsage(entry.usage);
          const ts = entryTimestampMs(entry, entry);
          const model = modelAlias(entry.model) || turnModel || "omp-unknown";
          const usageId = typeof entry.id === "string" && entry.id ? `model_usage:${entry.id}` : null;
          if (delta && usageId && ts != null && !seenEntryIds.has(usageId)) {
            seenEntryIds.add(usageId);
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
            times.add(ts);
          }
          continue;
        }

        if (entry.type !== "message") continue;
        const message = entry.message && typeof entry.message === "object" ? entry.message : null;
        if (!message) continue;

        // Entry-id dedup applies to activity metrics as well as tokens: forks
        // and rewritten prefixes reuse the same ids across files.
        const entryId = typeof entry.id === "string" && entry.id ? entry.id : null;
        if (entryId && seenEntryIds.has(entryId)) continue;
        if (entryId) seenEntryIds.add(entryId);

        const ts = entryTimestampMs(entry, message);
        if (ts != null) times.add(ts);

        if (message.role === "user" && isMain) {
          closeTurn();
          turns += 1;
          turnOpen = true;
          const fingerprint = fingerprintContent(message.content ?? null);
          if (lastPrompt && fingerprint === lastPrompt) retries += 1;
          lastPrompt = fingerprint;
          continue;
        }

        if (message.role === "assistant") {
          const delta = ompUsage(message.usage);
          const model = modelAlias(message.model) || turnModel || "omp-unknown";
          // Hourly parser only counts assistants with an entry id.
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
            if (AGENT_TOOLS.has(name)) {
              subagentCalls += 1;
              subagentTypes.set(name, (subagentTypes.get(name) || 0) + 1);
            }
          }
          continue;
        }
      }
      } catch (error) {
        // Malformed records are skipped above; I/O / inventory errors must
        // surface so the builder keeps the previous complete OMP snapshot.
        if (error?.code === "OMP_INVENTORY_INCOMPLETE") throw error;
        throw ompInventoryIncomplete(filePath, error);
      } finally {
        input.destroy?.();
      }
      closeTurn();
    }

    // Nested subagent transcripts are separate files under the main stem; each
    // file counts as one observed child session even when toolCall names differ.
    if (nested.length > 0) {
      subagentCalls = Math.max(subagentCalls, nested.length);
      for (const nestedPath of nested) {
        const name = path.basename(nestedPath, ".jsonl").toLowerCase() || "subagent";
        subagentTypes.set(name, (subagentTypes.get(name) || 0) + 1);
      }
    }

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
      files,
      session_id: sessionId || null,
      title,
      project_ref: cwd,
      model: models.length === 1 ? models[0].model : models.length > 1 ? "mixed" : "omp-unknown",
      model_usage: models,
      usage_buckets: [...buckets.values()],
      tokens,
      turns,
      edit_turns: edits,
      retry_turns: retries,
      subagent_calls: subagentCalls,
      subagent_types: Object.fromEntries([...subagentTypes.entries()].sort()),
      usage_events: models.reduce((sum, row) => sum + count(row.usage_events), 0),
      started_at: orderedTimes.length ? new Date(orderedTimes[0]).toISOString() : null,
      ended_at: orderedTimes.length ? new Date(orderedTimes.at(-1)).toISOString() : null,
      active_ms: activeMs,
      provenance: {
        source: "local-session-log",
        confidence: "observed",
        retry_confidence: "inferred",
        content_retained: false,
        usage: "omp-jsonl-metadata",
      },
    });
  }

  return rows;
}

async function readOmpSessions(mainFiles, options = {}) {
  return readOmpSessionFiles(mainFiles, {
    seenEntryIds: options.seenEntryIds instanceof Set ? options.seenEntryIds : new Set(),
  });
}

module.exports = {
  discoverOmpSessionFiles,
  discoverOmpSubagentFiles,
  ompSessionDependencies,
  ompSubagentFilesForMain,
  readOmpSessions,
  sessionIdFromFilename,
};
