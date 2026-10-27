"use strict";

// Metadata-only DeepSeek Harness (dsh) session reader for the Sessions sidecar.
// Reuses the same on-disk log format and assistant usage contract as the hourly
// dsh reader in rollout.js (`~/.dsh/sessions/<project>/<session>/session[.vN].jsonl[.zstd]`).
// Never persists prompts, assistant bodies, tool arguments, or command output.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  isDshSessionLogName,
  parseDshVersion,
  readDshSessionText,
  normalizeDshModelName,
  dshUsageToTotals,
} = require("./rollout");

const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

const EDIT_TOOLS = new Set([
  "apply_patch",
  "edit",
  "write",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "ops_edit",
  "ops_replace",
  "ops_write",
  "replace",
  "search_replace",
  "str_replace",
  "str_replace_editor",
  "strreplace",
  "write_file",
  "writefile",
]);
const AGENT_TOOLS = new Set([
  "agent",
  "spawn_agent",
  "spawn_subagent",
  "spawn_teammate",
  "subagent",
  "task",
]);

// Same ceiling as the hourly dsh reader: a session log is capped when decoded,
// and chunks/tool blobs are never materialized beyond their raw line.
const DSH_ACTIVE_GAP_MS = 30 * 60 * 1000;
// Reject placeholder epoch timestamps so usage cannot land in 1970 and vanish
// from every date filter (same guard as the other passive readers).
const MIN_DSH_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function emptyUsage() {
  const usage = {};
  for (const field of TOKEN_FIELDS) usage[field] = 0;
  return usage;
}

function addUsage(target, delta) {
  for (const field of TOKEN_FIELDS) target[field] = count(target[field]) + count(delta[field]);
}

// Harness usage -> our column vocabulary. The hourly reader owns the mapping;
// drop its queue-only conversation counter so a delta never leaks into a row.
function dshUsageDelta(usage) {
  const totals = dshUsageToTotals(usage);
  if (!totals) return null;
  const delta = emptyUsage();
  for (const field of TOKEN_FIELDS) delta[field] = count(totals[field]);
  return delta;
}

function modelName(value) {
  return normalizeDshModelName(value) || null;
}

function sessionIdOf(value) {
  if (typeof value !== "string") return null;
  // Parent sessions persist their id as "session-<uuid>" while subagent
  // headers use the bare uuid; normalize so parent/child links can pair.
  const id = value.trim().replace(/^session-/, "");
  return id || null;
}

function eventTimestampMs(entry) {
  const time = Number(entry?.time);
  return Number.isFinite(time) && time >= MIN_DSH_TIMESTAMP_MS ? time : null;
}

function directoryEntryIs(entry, fullPath, kind) {
  const check = kind === "dir" ? entry.isDirectory() : entry.isFile();
  if (check) return true;
  if (entry.isDirectory() || entry.isFile()) return false;
  try {
    const stat = fs.statSync(fullPath);
    return kind === "dir" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

// The harness can leave several artifacts for one session (a plain log plus
// versioned and backup copies). Mirror the hourly reader's canonical choice:
// the actively written transcript wins, then the higher format version, then
// the zstd encoding.
function selectDshTranscript(sessionDir, artifacts) {
  const candidates = artifacts.filter((name) => isDshSessionLogName(name));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return path.join(sessionDir, candidates[0]);
  const ranked = candidates.map((name) => {
    const full = path.join(sessionDir, name);
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) mtimeMs = Number(stat.mtimeMs) || 0;
    } catch { /* vanished mid-listing: lowest priority */ }
    return { full, name, mtimeMs };
  });
  ranked.sort((left, right) =>
    right.mtimeMs - left.mtimeMs ||
    parseDshVersion(right.name) - parseDshVersion(left.name) ||
    Number(right.name.endsWith(".zstd")) - Number(left.name.endsWith(".zstd")));
  return ranked[0]?.full || null;
}

function discoverDshSessionFiles(dshHomes, incomplete = []) {
  // Walk sessions/ ourselves (instead of trusting a listing helper) so a
  // permission error surfaces as incomplete discovery and the caller keeps the
  // previous complete snapshot rather than caching "no dsh sessions".
  const files = [];
  const seen = new Set();
  for (const dshHome of dshHomes || []) {
    if (!dshHome) continue;
    const sessionsRoot = path.join(dshHome, "sessions");
    let projects;
    try {
      projects = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") incomplete.push({ path: sessionsRoot, error: error?.code || "unreadable" });
      continue;
    }
    for (const project of projects) {
      const projectDir = path.join(sessionsRoot, project.name);
      if (!directoryEntryIs(project, projectDir, "dir")) continue;
      let sessions;
      try {
        sessions = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") incomplete.push({ path: projectDir, error: error?.code || "unreadable" });
        continue;
      }
      for (const session of sessions) {
        const sessionDir = path.join(projectDir, session.name);
        if (!directoryEntryIs(session, sessionDir, "dir")) continue;
        let artifacts;
        try {
          artifacts = fs.readdirSync(sessionDir, { withFileTypes: true });
        } catch (error) {
          if (error?.code !== "ENOENT") incomplete.push({ path: sessionDir, error: error?.code || "unreadable" });
          continue;
        }
        const selected = selectDshTranscript(
          sessionDir,
          artifacts
            .filter((artifact) => directoryEntryIs(artifact, path.join(sessionDir, artifact.name), "file"))
            .map((artifact) => artifact.name),
        );
        if (selected && !seen.has(selected)) {
          seen.add(selected);
          files.push(selected);
        }
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function fingerprintPrompt(data) {
  // In-memory only: the fingerprint never reaches the sidecar.
  const content = Array.isArray(data?.content) ? data.content : [];
  const text = content
    .filter((block) => block && typeof block === "object" && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\u0000");
  return crypto.createHash("sha256").update(text).digest("hex");
}

function eventKey(prefix, id, filePath, seq) {
  if (typeof id === "string" && id.trim()) return `${prefix}:${id.trim()}`;
  // No identity to dedupe on: scope it to the transcript that produced it.
  return `${prefix}:#${filePath}#${seq}`;
}

// Decoding a log costs far more than reading its metadata, and the sidecar
// invalidates its whole dsh batch whenever any session changes - so one active
// conversation would otherwise re-decode every transcript on every poll. Keep
// the parsed event metadata (never the text) keyed by file signature.
//
// The bound is the total number of cached event records, not the number of
// transcripts: a transcript's memory cost is proportional to its event count,
// and an entry cap silently stops helping once the inventory is larger than the
// cap (each pass evicts what the next pass wants). This budget holds a full
// inventory of a regular history while still capping an extreme one.
const TRANSCRIPT_CACHE_EVENT_LIMIT = 150000;
const transcriptCache = new Map();
let transcriptCacheEvents = 0;
let transcriptCacheEventLimit = TRANSCRIPT_CACHE_EVENT_LIMIT;

function transcriptSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function transcriptEventCost(transcript) {
  return Array.isArray(transcript?.events) ? transcript.events.length : 0;
}

function forgetTranscript(filePath) {
  const cached = transcriptCache.get(filePath);
  if (!cached) return;
  transcriptCache.delete(filePath);
  transcriptCacheEvents -= cached.events;
}

function rememberTranscript(filePath, signature, transcript) {
  if (!signature) return;
  forgetTranscript(filePath);
  const events = transcriptEventCost(transcript);
  transcriptCache.set(filePath, { signature, transcript, events });
  transcriptCacheEvents += events;
  // Keep at least one entry so a single oversized transcript still caches.
  while (transcriptCache.size > 1 && transcriptCacheEvents > transcriptCacheEventLimit) {
    forgetTranscript(transcriptCache.keys().next().value);
  }
}

async function parseDshTranscript(filePath) {
  const signature = transcriptSignature(filePath);
  const cached = signature ? transcriptCache.get(filePath) : null;
  if (cached && cached.signature === signature) {
    // Refresh insertion order so the LRU keeps the sessions actually in use.
    transcriptCache.delete(filePath);
    transcriptCache.set(filePath, cached);
    return cached.transcript;
  }
  forgetTranscript(filePath);
  const text = await readDshSessionText(filePath);
  if (text == null) {
    // readDshSessionText answers null for a missing or non-file path (and for
    // any read that fails). Throwing keeps that gap visible: readDshSessions
    // counts it as a skipped transcript so the caller marks the dsh inventory
    // incomplete instead of caching a silently short session list.
    throw new Error("DeepSeek Harness session log is missing or unreadable");
  }
  const transcript = {
    filePath,
    header: null,
    title: null,
    fallbackModel: null,
    events: [],
  };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const data = entry.data && typeof entry.data === "object" ? entry.data : null;
    const seq = Number.isFinite(entry.seq) ? entry.seq : index;
    switch (entry.type) {
      case "session": {
        transcript.header = entry;
        break;
      }
      case "session/title": {
        // Written twice per session (a fallback preview, then the model's
        // title); the last one is the one the harness shows.
        const title = typeof data?.title === "string" ? data.title.trim() : "";
        if (title) transcript.title = title;
        break;
      }
      case "request/header": {
        const model = modelName(data?.header?.config?.model);
        if (model) transcript.fallbackModel = model;
        break;
      }
      case "user/message": {
        if (data?.role && data.role !== "user") break;
        // The harness stores every injected context block (time, memory,
        // skill catalog, plugin guidance, approval prompts) as a user-role
        // message. Only an actual prompt opens a turn; counting the rest
        // inflates turns and drifts edit attribution by ~4x in real logs.
        const kind = typeof data?.source?.kind === "string" ? data.source.kind.trim() : "";
        if (kind && kind !== "user") break;
        transcript.events.push({
          kind: "turn",
          key: eventKey("u", data?.id, filePath, seq),
          ts: eventTimestampMs(entry),
          prompt: fingerprintPrompt(data),
        });
        break;
      }
      case "assistant/message": {
        const message = data?.message && typeof data.message === "object" ? data.message : null;
        const ts = eventTimestampMs(entry);
        const model = modelName(message?.source?.model) || transcript.fallbackModel || "unknown";
        const delta = dshUsageDelta(data?.usage);
        if (delta) {
          transcript.events.push({
            kind: "usage",
            key: eventKey("a", message?.id, filePath, seq),
            ts,
            model,
            delta,
          });
        }
        break;
      }
      case "tool/call": {
        const name = typeof data?.name === "string" ? data.name.trim().toLowerCase() : "";
        if (!name) break;
        transcript.events.push({
          kind: "tool",
          key: eventKey("t", data?.callId, filePath, seq),
          ts: eventTimestampMs(entry),
          name,
        });
        break;
      }
      default:
        // Streaming chunks, approvals, prompts-injection and the terminal
        // seed marker carry no accounting of their own. session/end-seed in
        // particular can be stamped weeks after the session ended.
        break;
    }
  }
  rememberTranscript(filePath, signature, transcript);
  return transcript;
}

function transcriptStartedAt(transcript) {
  const created = Number(transcript?.header?.createdAt);
  if (Number.isFinite(created) && created >= MIN_DSH_TIMESTAMP_MS) return created;
  return null;
}

// Harness sessions seeded from a parent log replay the parent's messages
// verbatim (same message ids, same usage). Attributes every replayed event to
// the transcript that created it — the earliest one — so a fork or a seeded
// subagent does not bill the same tokens twice.
function claimEventsByOrigin(transcripts) {
  const owners = new Map();
  const ordered = [...transcripts].sort((left, right) => {
    const leftAt = transcriptStartedAt(left) ?? Number.MAX_SAFE_INTEGER;
    const rightAt = transcriptStartedAt(right) ?? Number.MAX_SAFE_INTEGER;
    return leftAt - rightAt || left.filePath.localeCompare(right.filePath);
  });
  for (const transcript of ordered) {
    for (const event of transcript.events) {
      if (owners.has(event.key)) continue;
      owners.set(event.key, transcript.filePath);
    }
  }
  return owners;
}

function buildRow(transcript, owners) {
  const header = transcript.header || {};
  const sessionId = sessionIdOf(header.id)
    || sessionIdOf(path.basename(path.dirname(transcript.filePath)))
    || null;
  const parentId = sessionIdOf(header.parentSession);
  // A subagent session is a thread of its parent; a seeded root session is a
  // fork (the harness replays the parent log so the branch starts with its
  // context). Only the first one is a parent/child link.
  const originKind = typeof header.origin === "string" ? header.origin.trim().toLowerCase() : "";
  const isSubagent = originKind === "subagent" || count(header.delegationDepth) > 0;
  const tokens = emptyUsage();
  const modelUsage = new Map();
  const buckets = new Map();
  const times = new Set();
  const agentTypes = new Map();
  const modelsForEdits = new Map();
  let turns = 0;
  let edits = 0;
  let retries = 0;
  let agentCalls = 0;
  let lastPrompt = null;
  let turnOpen = false;
  let hadEdit = false;
  let turnModel = transcript.fallbackModel || "unknown";

  const closeTurn = () => {
    if (hadEdit) {
      edits += 1;
      modelsForEdits.set(turnModel, (modelsForEdits.get(turnModel) || 0) + 1);
    }
    hadEdit = false;
    turnOpen = false;
  };

  const startedAt = transcriptStartedAt(transcript);
  if (startedAt != null) times.add(startedAt);

  // A message id names one message; a re-emitted line in the same log is a
  // replay of it, not a second charge.
  const seenEvents = new Set();
  for (const event of transcript.events) {
    if (owners.get(event.key) !== transcript.filePath) continue;
    if (seenEvents.has(event.key)) continue;
    seenEvents.add(event.key);
    if (event.ts != null) times.add(event.ts);
    if (event.kind === "turn") {
      closeTurn();
      turnOpen = true;
      turns += 1;
      turnModel = transcript.fallbackModel || "unknown";
      if (lastPrompt && lastPrompt === event.prompt) retries += 1;
      lastPrompt = event.prompt;
      continue;
    }
    if (event.kind === "usage") {
      const delta = event.delta;
      const model = event.model || turnModel;
      const modelRow = modelUsage.get(model) || { model, ...emptyUsage(), usage_events: 0 };
      addUsage(tokens, delta);
      addUsage(modelRow, delta);
      modelRow.usage_events += 1;
      modelUsage.set(model, modelRow);
      if (event.ts != null) {
        const bucketTime = new Date(Math.floor(event.ts / 60000) * 60000).toISOString();
        const key = `${model}\u0000${bucketTime}`;
        const bucket = buckets.get(key) || { model, timestamp: bucketTime, ...emptyUsage(), usage_events: 0 };
        addUsage(bucket, delta);
        bucket.usage_events += 1;
        buckets.set(key, bucket);
      }
      turnModel = model;
      continue;
    }
    if (event.kind === "tool") {
      if (turnOpen && EDIT_TOOLS.has(event.name)) hadEdit = true;
      if (AGENT_TOOLS.has(event.name)) {
        agentCalls += 1;
        agentTypes.set(event.name, (agentTypes.get(event.name) || 0) + 1);
      }
    }
  }
  closeTurn();

  const orderedTimes = [...times].sort((a, b) => a - b);
  let activeMs = 0;
  for (let index = 1; index < orderedTimes.length; index += 1) {
    const gap = orderedTimes[index] - orderedTimes[index - 1];
    if (gap > 0 && gap <= DSH_ACTIVE_GAP_MS) activeMs += gap;
  }
  const models = [...modelUsage.values()].map((row) => ({
    ...row,
    edit_turns: modelsForEdits.get(row.model) || 0,
  }));
  // A session that only handshook (no user turn, no usage) has nothing to say.
  if (!tokens.total_tokens && !turns) return null;

  return {
    identity: sessionId,
    files: [transcript.filePath],
    session_id: sessionId,
    parent_session_id: isSubagent ? parentId : null,
    forked_from_id: isSubagent ? null : parentId,
    thread_source: originKind || null,
    title: transcript.title,
    project_ref: typeof header.cwd === "string" && header.cwd.trim() ? header.cwd.trim() : null,
    model: models.length === 1 ? models[0].model : "unknown",
    model_usage: models,
    usage_buckets: [...buckets.values()],
    tokens,
    turns,
    edit_turns: edits,
    retry_turns: retries,
    subagent_calls: agentCalls,
    subagent_types: Object.fromEntries([...agentTypes.entries()].sort()),
    usage_events: models.reduce((sum, row) => sum + count(row.usage_events), 0),
    started_at: orderedTimes.length ? new Date(orderedTimes[0]).toISOString() : null,
    ended_at: orderedTimes.length ? new Date(orderedTimes.at(-1)).toISOString() : null,
    active_ms: activeMs,
    provenance: {
      source: "local-session-log",
      confidence: "observed",
      retry_confidence: "inferred",
      content_retained: false,
      usage: "dsh-jsonl-metadata",
    },
  };
}

// Batch the whole inventory: seeded transcripts repeat their parent's message
// ids, so the dedupe has to see every file before it emits a row (the same
// contract as the hourly dsh reader's per-message identity).
async function readDshSessions(filePaths, { onSkip = null } = {}) {
  const files = [...new Set((filePaths || []).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const transcripts = [];
  let skippedFiles = 0;
  for (const filePath of files) {
    let transcript = null;
    try {
      transcript = await parseDshTranscript(filePath);
    } catch (error) {
      // One half-written or unreadable transcript must not hide the rest of
      // the inventory; count it so the caller can report the gap.
      skippedFiles += 1;
      if (typeof onSkip === "function") onSkip(filePath, error);
      continue;
    }
    if (transcript) transcripts.push(transcript);
  }
  if (transcripts.length === 0) return withSkippedFileCount([], skippedFiles);
  const owners = claimEventsByOrigin(transcripts);
  const rows = [];
  for (const transcript of transcripts) {
    const row = buildRow(transcript, owners);
    if (row) rows.push(row);
  }
  return withSkippedFileCount(rows, skippedFiles);
}

// Non-enumerable so the array still behaves like a plain row list for callers
// that map/filter/serialize it.
function withSkippedFileCount(rows, skippedFiles) {
  Object.defineProperty(rows, "skippedFiles", { value: skippedFiles, enumerable: false });
  return rows;
}

// Test hooks: the budget accounting is only observable through the module
// state, and the dsh inventory is far too large to build in a unit test.
function resetDshTranscriptCacheForTests() {
  transcriptCache.clear();
  transcriptCacheEvents = 0;
  transcriptCacheEventLimit = TRANSCRIPT_CACHE_EVENT_LIMIT;
}

function setDshTranscriptCacheEventLimitForTests(limit) {
  transcriptCacheEventLimit = Number.isFinite(limit) && limit > 0 ? limit : TRANSCRIPT_CACHE_EVENT_LIMIT;
}

function dshTranscriptCacheStatsForTests() {
  return { size: transcriptCache.size, events: transcriptCacheEvents, limit: transcriptCacheEventLimit };
}

module.exports = {
  discoverDshSessionFiles,
  readDshSessions,
  selectDshTranscript,
  resetDshTranscriptCacheForTests,
  setDshTranscriptCacheEventLimitForTests,
  dshTranscriptCacheStatsForTests,
};
