"use strict";

// Metadata-only pi (@mariozechner/pi-coding-agent) session reader for the
// Sessions sidecar. pi and oh-my-pi share an on-disk session format (and the
// `<timestamp>_<session-id>.jsonl` file naming), but they are separate installs
// with separate roots (`~/.pi` vs `~/.omp`) and separate cursor namespaces, so
// this module keeps its own inventory and never reuses the omp row identity.
//
// Same privacy boundary as every other session source: token counters, times,
// turn/edit/subagent counters and the session header's cwd only. Never prompts,
// assistant bodies, tool arguments, or command output.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { physicalJsonlRecords } = require("./jsonl-lines");
const { resolvePiAgentDir, piAgentDirCollidesWithOmp } = require("./rollout");
const { sessionIdFromFilename } = require("./omp-session");

// Same ceiling as the hourly pi parser: tool results can be enormous and carry
// no usage, so they must be skipped without being buffered or decoded.
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

// Mirrors the hourly pi parser's field contract (see parsePiLikeIncremental):
// `reasoningTokens` is the only field folded into the cost-bearing
// reasoning_output_tokens column. pi reports its reasoning breakdown as
// `usage.reasoning`, documented upstream as a *subset* of `output`, so reading
// it here would add those tokens to the cost a second time. The field stays in
// the reader for formats that do emit it, exactly like the Usage ledger.
function piUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = count(usage.input);
  const output = count(usage.output);
  const cached = count(usage.cacheRead);
  const created = count(usage.cacheWrite);
  const reasoning = count(usage.reasoningTokens);
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

// Match the hourly parser's reject window: placeholder epoch values would land
// the session in 1970 and make it vanish from every current date filter.
// Date's own ceiling is 8.64e15: past it every new Date(ms) is Invalid Date and
// the row's later toISOString() throws RangeError, which would fail the whole pi
// batch instead of just this record. Out-of-range numbers fall through to the
// entry's ISO timestamp (Date.parse already validates) and then to null.
const MAX_PI_TIMESTAMP_MS = 8.64e15;
const MIN_PI_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

function entryTimestampMs(entry, message) {
  const direct = Number(message?.timestamp);
  if (Number.isFinite(direct) && direct >= MIN_PI_TIMESTAMP_MS && direct <= MAX_PI_TIMESTAMP_MS) return direct;
  if (typeof entry?.timestamp === "string" && entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed) && parsed >= MIN_PI_TIMESTAMP_MS) return parsed;
  }
  return null;
}

function piInventoryIncomplete(pathName, error) {
  const err = new Error(`pi inventory incomplete: ${pathName}`);
  err.code = "PI_INVENTORY_INCOMPLETE";
  err.path = pathName;
  err.cause = error;
  return err;
}

// A nested transcript dir can contain a symlink to another directory (a scratch
// dir linked home, an agent workspace mount, or a link back to one of its own
// ancestors). Crossing it costs twice: a link to an ancestor is re-entered at
// every level, so enumeration grows exponentially and blocks the local API
// before a single transcript is read; a link sideways folds foreign transcripts
// into this session, inflating its subagent counters and letting it claim another
// session's entry ids. So the walk never crosses a link at all, and as defense in
// depth against mounts it also tracks the directory identities on its own
// ancestor chain and stops at a fixed depth. pi and pi-subagents write real
// files, so skipping links costs nothing in the supported layout.
const MAX_NESTED_WALK_DEPTH = 12;

function dirIdentity(dir) {
  try {
    const st = fs.statSync(dir);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

function listNestedJsonlSync(dir, { strict = false } = {}) {
  const found = [];
  const chain = new Set();
  const walk = (current, depth) => {
    if (depth > MAX_NESTED_WALK_DEPTH) return;
    const identity = dirIdentity(current);
    if (identity) {
      if (chain.has(identity)) return;
      chain.add(identity);
    }
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (strict) throw piInventoryIncomplete(current, error);
      return;
    }
    for (const entry of entries) {
      // readdirSync({ withFileTypes: true }) does not follow links, so this is an
      // lstat check: only a real directory or file is walked or counted.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (!isDir && !isFile) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch (error) {
          if (error?.code !== "ENOENT" && strict) throw piInventoryIncomplete(full, error);
          continue;
        }
      }
      // Recursive on purpose: pi-subagents forks transcripts one level deeper,
      // to <session stem>/<hash>/run-N/session.jsonl.
      if (isDir) walk(full, depth + 1);
      else if (isFile && entry.name.endsWith(".jsonl")) found.push(full);
    }
    if (identity) chain.delete(identity);
  };
  walk(dir, 0);
  found.sort((a, b) => a.localeCompare(b));
  return found;
}

function mainSessionStem(filePath) {
  return path.basename(filePath, ".jsonl");
}

// pi names every transcript `<session-start>_<session-id>.jsonl`, so the file
// name already carries the session's start time. A fork (`pi --fork`) is always
// created after the session it replays, so processing transcripts in start order
// — rather than path order — guarantees the *originating* session claims the
// replayed entry ids. Path order alone could let a cross-project fork, which may
// sort into a different `<cwd>` directory, consume its parent's messages and
// leave the parent looking empty.
// Returns a fixed-width digit key so a plain string compare is a time compare;
// a name with no trustworthy start time (a hand-written fixture, a flat
// `<id>.jsonl`) sorts last instead of first.
function sessionStartKey(filePath) {
  const base = path.basename(filePath);
  const split = base.indexOf("_");
  const prefix = split > 0 ? base.slice(0, split) : base;
  const digits = prefix.replace(/\D/g, "");
  // 17 digits = YYYYMMDDHHMMSSmmm.
  return digits.length === 17 ? digits : "9".repeat(17);
}

function bySessionStartThenPath(a, b) {
  const keyA = sessionStartKey(a);
  const keyB = sessionStartKey(b);
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  return a.localeCompare(b);
}

/**
 * Transcripts forked from one main session, found in the directory that shares
 * the main file's stem (pi and pi-subagents both use this layout).
 */
function piSubagentFilesForMain(mainPath, { strict = false } = {}) {
  const nestedDir = mainPath.replace(/\.jsonl$/i, "");
  if (!nestedDir || nestedDir === mainPath) return [];
  try {
    const st = fs.statSync(nestedDir);
    if (!st.isDirectory()) return [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    if (strict) throw piInventoryIncomplete(nestedDir, error);
    return [];
  }
  return listNestedJsonlSync(nestedDir, { strict });
}

function piSessionDependencies(mainFiles) {
  const deps = new Set();
  for (const file of mainFiles || []) {
    deps.add(file);
    for (const nested of piSubagentFilesForMain(file)) deps.add(nested);
  }
  return [...deps];
}

/**
 * Main-session inventory for one agent dir: `<agentDir>/sessions/<cwd>/*.jsonl`.
 * Only the files directly inside each cwd dir are sessions; a sibling directory
 * with the same stem holds that session's forked transcripts, which
 * piSubagentFilesForMain folds in instead of listing as a separate session.
 *
 * Walked by hand (rather than reusing resolvePiSessionFiles) so a permission
 * error surfaces as incomplete discovery — which preserves the previous
 * complete sidecar — instead of looking like "no pi sessions".
 */
function discoverPiSessionFiles(env = process.env, incomplete = []) {
  const agentDir = resolvePiAgentDir(env);
  if (!agentDir) return [];
  // Defense in depth for the omp/pi double-count invariant: two explicit
  // overrides can point both providers at the same directory, which would list
  // one transcript twice under two different session identities.
  if (piAgentDirCollidesWithOmp(env)) return [];
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

async function readPiSessionFiles(mainFiles, { seenEntryIds = new Set() } = {}) {
  const rows = [];
  const mains = [...new Set((mainFiles || []).filter(Boolean))].sort(bySessionStartThenPath);

  for (const mainPath of mains) {
    const nested = piSubagentFilesForMain(mainPath, { strict: true });
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

    for (const filePath of files) {
      const isMain = filePath === mainPath;
      // Isolate turn state per transcript so a nested child cannot rewrite the
      // parent's open-turn edit attribution (or vice versa).
      closeTurn();
      turnModel = "pi-unknown";
      let input;
      try {
        input = fs.createReadStream(filePath);
      } catch (error) {
        throw piInventoryIncomplete(filePath, error);
      }
      try {
        for await (const record of physicalJsonlRecords(input, {
          invalidUtf8: "record",
          maxRecordBytes: PI_MAX_RECORD_BYTES,
        })) {
          // Match the hourly scan: accept a complete final record even without
          // a trailing newline; skip oversized / invalid-UTF-8 records.
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
            // A nested header carries its own id and must not replace it.
            if (isMain) {
              if (typeof entry.id === "string" && entry.id.trim()) sessionId = entry.id.trim();
              if (typeof entry.cwd === "string" && entry.cwd.trim()) cwd = entry.cwd.trim();
            }
            const ts = entryTimestampMs(entry, null);
            if (ts != null) times.add(ts);
            continue;
          }

          // pi's `--name` / `/name` writes a session_info entry; the latest
          // non-empty one is the display name, an empty one clears it.
          if (isMain && entry.type === "session_info") {
            const name = typeof entry.name === "string" ? entry.name.trim() : "";
            title = name || null;
            continue;
          }

          // model_change names the backend for the turns that follow it, so a
          // usage row without its own model still lands on the right price.
          if (entry.type === "model_change") {
            const model = modelAlias(entry.modelId) || modelAlias(entry.model);
            if (model) turnModel = model;
            const ts = entryTimestampMs(entry, entry);
            if (ts != null) times.add(ts);
            continue;
          }

          if (entry.type !== "message") continue;
          const message = entry.message && typeof entry.message === "object" ? entry.message : null;
          if (!message) continue;

          // Entry-id dedup applies to activity metrics as well as tokens: pi
          // forks (`pi --fork`) copy the parent transcript with the same ids,
          // so a fork must not recount its parent's work. The set is keyed by
          // the bare entry id (not session + entry) on purpose: it mirrors the
          // hourly ledger's single seenIds set, which is what keeps Sessions and
          // Usage agreeing, and pi's own ids are time-ordered UUIDv7s, so two
          // unrelated sessions sharing one id is not a realistic shape.
          const entryId = typeof entry.id === "string" && entry.id ? entry.id : null;
          if (entryId && seenEntryIds.has(entryId)) continue;
          if (entryId) seenEntryIds.add(entryId);

          const ts = entryTimestampMs(entry, message);
          if (ts != null) times.add(ts);

          if (message.role === "user") {
            closeTurn();
            // Only the main transcript's prompts are user turns: a subagent's
            // prompt is one delegation from the parent's point of view. Its
            // transcript still opens a turn locally, so an edit made inside a
            // child is counted against that child's model instead of leaving
            // the whole session looking unproductive.
            if (isMain) {
              turns += 1;
              const fingerprint = fingerprintContent(message.content ?? null);
              if (lastPrompt && fingerprint === lastPrompt) retries += 1;
              lastPrompt = fingerprint;
            }
            turnOpen = true;
            continue;
          }

          if (message.role !== "assistant") continue;
          const delta = piUsage(message.usage);
          const model = modelAlias(message.model) || turnModel || "pi-unknown";
          // The hourly parser only counts assistants that carry an entry id.
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
        }
      } catch (error) {
        // Malformed records are skipped above; I/O / inventory errors must
        // surface so the builder keeps the previous complete pi snapshot.
        if (error?.code === "PI_INVENTORY_INCOMPLETE") throw error;
        throw piInventoryIncomplete(filePath, error);
      } finally {
        input.destroy?.();
      }
      closeTurn();
    }

    // Each nested transcript is one observed child session, even when the
    // parent never named a subagent tool.
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
      model: models.length === 1 ? models[0].model : models.length > 1 ? "mixed" : "pi-unknown",
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
  piSubagentFilesForMain,
  readPiSessions,
};
