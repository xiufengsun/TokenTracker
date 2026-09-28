"use strict";

// Metadata-only session analytics sidecar.
//
// Never persisted, anywhere: prompts, assistant message bodies, tool arguments,
// command output, diffs. Prompts are read only to fingerprint a repeated
// request (a one-way hash, never stored).
//
// Persisted to the LOCAL sidecar only (~/.tokentracker/tracker, 0600 file in a
// 0700 dir), because the session browser needs them to identify and resume a
// session:
//   - `title`  — the one line the agent wrote to name the session (Claude's
//     "ai-title" record, Codex's thread_name). Agent-authored, not the user's
//     prompt, but it does summarize what the session was about, so treat it as
//     session content: local-only, never uploaded.
//   - `session_id` — the vendor session UUID, needed for `--resume`.
//   - `project_ref` — the session's working directory. The resume command only
//     works from that directory, so the UI shows it and lets the user copy it.
//
// All three are stripped in summarizeSessions() before anything reaches the
// cloud or a CSV export, and the browser endpoint that keeps them is served
// only over loopback. `test/session-analytics.test.js` guards that boundary —
// if you add a field here, decide which side of it the field belongs on.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { listClaudeProjectFiles, listRolloutFilesDeep, claudeMessageDedupKey } = require("./rollout");
const { parseCodexRolloutFile } = require("./codex-rollout-parser");
const { computeRowCost, getModelPricing } = require("./pricing");
const { USD_TICKS_PER_USD, normalizeGrokUsage } = require("./grok-usage");
const wsl = require("./wsl-probe");

// Bump the sidecar when derived metrics change so cached rows are rebuilt
// instead of leaving the dashboard on the previous (over-counted) heuristic.
// v7 adds the raw session_id (local-only, needed to build resume commands for
// the session browser); it never leaves the Node process through the cloud.
// v8 adds an agent-authored one-line title: Claude's "ai-title" session-log
// record and Codex's thread_name from session_index.jsonl. Both are metadata
// the agent wrote itself, never the raw prompt body, and stay local-only
// alongside session_id (no self-parsed prompt fallback, so the strict
// metadata-only guarantee holds).
// v9 changes derived metrics, so every cached row must be rebuilt:
//   - duration_ms is now *active* time (see IDLE_GAP_MS), not the wall-clock
//     span between the first and last log line, which read as 89 days on
//     resumed/forked sessions.
//   - session_id is only set when the log actually contained a sessionId
//     record. It used to fall back to the file's basename, which produced
//     resume commands for non-session files (`claude --resume journal`).
// v10 adds Grok Build sessions (~/.grok/sessions/**/updates.jsonl), scanned
// from turn_completed.usage + tool_call metadata. Bump so Claude/Codex rows
// stay valid while Grok entries appear on the next full rebuild.
// v11 groups native/WSL copies of one logical Claude/Codex session and scans
// their union, deduping shared records while retaining divergent tails.
// v12 fixes Grok's mutually exclusive token columns, retains exact reported
// cost, and adds metadata-only usage diagnostics to the local session browser.
// v13 stores per-model Codex usage (including observed reroutes and the exact
// long-context subset) and folds delivery signals into the token parser's
// single pass instead of parsing every Codex file twice.
const SIDECAR_VERSION = 13;
const EDIT_TOOLS = new Set([
  "apply_patch",
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  // Grok Build write tools (ACP tool titles / x.ai/tool.name).
  "search_replace",
  "str_replace",
  "create_file",
  "write_file",
]);
const PLACEHOLDER_MODELS = new Set(["<synthetic>", "synthetic", "<unknown>", "unknown"]);
const CLAUDE_MEM_OBSERVER_PROJECT_SUFFIX = "--claude-mem-observer-sessions";
const CODEX_SUBAGENT_TOOLS = new Set(["spawn_agent", "multi_agent_v1__spawn_agent"]);
const CODEX_SIGNAL_TOOLS = new Set([...EDIT_TOOLS, ...CODEX_SUBAGENT_TOOLS]);
const GROK_SUBAGENT_TOOLS = new Set(["spawn_subagent", "spawn_agent"]);

function normalizeSessionModel(value) {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (!model || PLACEHOLDER_MODELS.has(model.toLowerCase())) return null;
  return model;
}

function resolveSessionSidecarPath(home = os.homedir()) {
  return path.join(home, ".tokentracker", "tracker", "session.queue.jsonl");
}

function sessionHash(source, id) {
  return crypto.createHash("sha256").update(`${source}\0${id || "unknown"}`).digest("hex").slice(0, 24);
}

function finite(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function tokenTotals(usage) {
  const input_tokens = finite(usage?.input_tokens);
  const cached_input_tokens = finite(usage?.cache_read_input_tokens ?? usage?.cached_input_tokens);
  const cache_creation_input_tokens = finite(usage?.cache_creation_input_tokens);
  const output_tokens = finite(usage?.output_tokens);
  const reasoning_output_tokens = finite(usage?.reasoning_output_tokens);
  const total_tokens = input_tokens + cached_input_tokens + cache_creation_input_tokens + output_tokens;
  return { input_tokens, cached_input_tokens, cache_creation_input_tokens, output_tokens, reasoning_output_tokens, total_tokens };
}

function addTotals(target, delta) {
  for (const key of ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) {
    target[key] = finite(target[key]) + finite(delta?.[key]);
  }
}

function emptyTotals() {
  return tokenTotals({});
}

const MODEL_USAGE_SUM_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
  "long_context_input_tokens",
  "long_context_cached_input_tokens",
  "long_context_cache_creation_input_tokens",
  "long_context_output_tokens",
  "long_context_reasoning_output_tokens",
  "priority_input_tokens",
  "priority_cached_input_tokens",
  "priority_cache_creation_input_tokens",
  "priority_output_tokens",
  "priority_reasoning_output_tokens",
  "priority_long_context_input_tokens",
  "priority_long_context_cached_input_tokens",
  "priority_long_context_cache_creation_input_tokens",
  "priority_long_context_output_tokens",
  "priority_long_context_reasoning_output_tokens",
  "usage_events",
  "rerouted_usage_events",
  "long_context_usage_events",
  "priority_usage_events",
  // Not a token counter: an edit turn is a turn, and turn_context both marks
  // where a turn begins and names its model, so an edit turn has exactly one
  // owner. Splitting it here keeps by_model.tokens_per_edit a ratio over one
  // population instead of this model's tokens over the whole session's turns.
  "edit_turns",
];

function normalizeModelUsageRows(rows) {
  const byModel = new Map();
  for (const value of Array.isArray(rows) ? rows : []) {
    const model = normalizeSessionModel(value?.model) || "unknown";
    let row = byModel.get(model);
    if (!row) {
      row = {
        model,
        ...Object.fromEntries(MODEL_USAGE_SUM_FIELDS.map((field) => [field, 0])),
        selected_models: new Set(),
        reroute_reasons: new Set(),
        model_attribution: "selected",
      };
      byModel.set(model, row);
    }
    for (const field of MODEL_USAGE_SUM_FIELDS) row[field] += finite(value?.[field]);
    if (Array.isArray(value?.selected_models)) {
      for (const selected of value.selected_models) {
        const normalized = normalizeSessionModel(selected);
        if (normalized) row.selected_models.add(normalized);
      }
    } else if (model !== "unknown") {
      // serializeModelUsageRow() omits selected_models when it is just the
      // effective model repeated. An absent field therefore means "selected
      // == effective", which is the case for every non-rerouted row.
      row.selected_models.add(model);
    }
    for (const reason of Array.isArray(value?.reroute_reasons) ? value.reroute_reasons : []) {
      if (typeof reason === "string" && reason.trim()) row.reroute_reasons.add(reason.trim());
    }
    if (value?.model_attribution === "effective" || finite(value?.rerouted_usage_events) > 0) {
      row.model_attribution = "effective";
    }
  }
  return [...byModel.values()]
    .map((row) => ({
      ...row,
      selected_models: [...row.selected_models].sort(),
      reroute_reasons: [...row.reroute_reasons].sort(),
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model));
}

// The sidecar is re-read on every dashboard request, so keep it small: omit
// the model_usage fields that normalizeModelUsageRows() reconstructs on read.
// All four omissions are lossless - zero counters default to 0, an absent
// selected_models re-seeds from `model`, model_attribution is derived from
// rerouted_usage_events, and cost_usd is always recomputed by
// repriceSessionRecord(). Worth ~19% of the file on a 6.8k-session history,
// most of it the long_context_* counters for sessions with no requests over
// OPENAI_LONG_CONTEXT_INPUT_THRESHOLD in src/lib/pricing/index.js.
function serializeModelUsageRow(row) {
  const out = { model: row.model };
  for (const field of MODEL_USAGE_SUM_FIELDS) {
    const value = finite(row[field]);
    if (value !== 0) out[field] = value;
  }
  const selected = Array.isArray(row.selected_models) ? row.selected_models : [];
  if (!(selected.length === 1 && selected[0] === row.model)) out.selected_models = selected;
  if (Array.isArray(row.reroute_reasons) && row.reroute_reasons.length > 0) {
    out.reroute_reasons = row.reroute_reasons;
  }
  if (row.model_attribution === "effective") out.model_attribution = "effective";
  return out;
}

function serializeSessionRecord(row) {
  if (!Array.isArray(row?.model_usage) || row.model_usage.length === 0) {
    return JSON.stringify(row);
  }
  return JSON.stringify({ ...row, model_usage: row.model_usage.map(serializeModelUsageRow) });
}

function repriceSessionRecord(record) {
  const modelUsage = normalizeModelUsageRows(record?.model_usage);
  if (modelUsage.length > 0) {
    let hasUnpricedUsage = false;
    for (const row of modelUsage) {
      row.cost_usd = computeRowCost({ source: record.source, ...row });
      if (record.source === "codex" && row.total_tokens > 0) {
        const pricing = getModelPricing(row.model, { source: record.source });
        if (![pricing.input, pricing.output, pricing.cache_read, pricing.cache_write]
          .some((value) => finite(value) > 0)) {
          hasUnpricedUsage = true;
        }
      }
    }
    record.model_usage = modelUsage;
    record.model = modelUsage.length > 1 ? "mixed" : modelUsage[0].model;
    record.cost_usd = modelUsage.reduce((sum, row) => sum + finite(row.cost_usd), 0);
    record.cost_source = "model_pricing";
    // Internal labels such as `codex-auto-review` expose token usage but not
    // an underlying public model/rate. Keep their tokens, leave their cost at
    // zero, and explicitly mark the session estimate as a known lower bound.
    record.cost_is_partial = hasUnpricedUsage;
  } else {
    const providerCost = Number(record.provider_cost_usd);
    record.cost_usd = record.cost_source === "provider_reported"
      && Number.isFinite(providerCost)
      && providerCost >= 0
      ? providerCost
      : computeRowCost({ source: record.source, model: record.model, ...record.tokens });
  }
  record.cost_per_edit = record.edit_turns > 0 ? record.cost_usd / record.edit_turns : null;
  return record;
}

// The model_usage wire contract is DENSE: every field dashboard/src/lib/
// sessions-api.ts declares is present on every row. Storage is free to be
// sparse - serializeModelUsageRow() drops zero counters, and a record with no
// model_usage at all (every claude/grok session, plus codex sessions written
// by an older sidecar) has nothing to trim in the first place - but neither
// shape may leak into an API response, or the declared type describes a row
// that does not exist. Densify here, the one point both the by_model
// aggregation and toSessionBrowserRow() pass through.
function denseModelUsageRow(overrides = {}) {
  return {
    model: "unknown",
    ...Object.fromEntries(MODEL_USAGE_SUM_FIELDS.map((field) => [field, 0])),
    selected_models: [],
    reroute_reasons: [],
    model_attribution: "selected",
    cost_usd: 0,
    ...overrides,
  };
}

function modelUsageForAggregation(record) {
  const editTurns = finite(record?.edit_turns);
  const rows = normalizeModelUsageRows(record?.model_usage);
  if (rows.length === 0) {
    return [denseModelUsageRow({
      model: normalizeSessionModel(record?.model) || "unknown",
      total_tokens: finite(record?.total_tokens || record?.tokens?.total_tokens),
      cost_usd: finite(record?.cost_usd),
      edit_turns: editTurns,
    })];
  }
  const priced = rows.map((row) => denseModelUsageRow({
    ...row,
    cost_usd: Number.isFinite(Number(row.cost_usd))
      ? Number(row.cost_usd)
      : computeRowCost({ source: record.source, ...row }),
  }));
  // Sum(rows.edit_turns) has to equal record.edit_turns or the by_model column
  // stops summing to summary.edit_turns. It can fall short two ways: a sidecar
  // written before model_usage carried edit_turns, and an edit turn whose model
  // produced no billable delta, leaving no usage row to attach to. Fold the
  // residual into the busiest model - normalizeModelUsageRows() sorts by
  // total_tokens - which is the same approximation `retries` uses.
  const assigned = priced.reduce((sum, row) => sum + finite(row.edit_turns), 0);
  const residual = editTurns - assigned;
  if (residual > 0) priced[0].edit_turns = finite(priced[0].edit_turns) + residual;
  return priced;
}

function safeTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

// A session that was resumed days later, or whose file replays inherited
// history from a fork, spans a wall-clock range that says nothing about how
// long the user actually worked (observed: 2142h / 89 days on a session with
// zero turns). Accumulate *active* time instead: the sum of gaps between
// consecutive log timestamps, excluding any gap longer than IDLE_GAP_MS. The
// long jump from replayed history to real work is one such gap, so it drops
// out on its own. started_at / ended_at still carry the true span.
const IDLE_GAP_MS = 30 * 60 * 1000;

function emptyBounds() {
  return { started_at: null, ended_at: null, active_ms: 0, _last_ts_ms: null };
}

function updateBounds(bounds, value) {
  const timestamp = safeTimestamp(value);
  if (!timestamp) return;
  if (!bounds.started_at || timestamp < bounds.started_at) bounds.started_at = timestamp;
  if (!bounds.ended_at || timestamp > bounds.ended_at) bounds.ended_at = timestamp;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return;
  if (Number.isFinite(bounds._last_ts_ms)) {
    const delta = ms - bounds._last_ts_ms;
    // Ignore out-of-order lines and idle gaps; only real working time counts.
    if (delta > 0 && delta <= IDLE_GAP_MS) bounds.active_ms += delta;
  }
  bounds._last_ts_ms = ms;
}

// Throwaway per-agent checkouts (`.claude/worktrees/<id>`, `.codex/worktrees/…`)
// are not the project the user is working on, and the directory is usually gone
// by the time the session is browsed.
function isWorktreeRef(ref) {
  return /[\\/](worktrees|subagents)[\\/]/.test(String(ref || ""));
}

function projectKey(cwd, filePath) {
  const value = cwd || path.dirname(filePath || "");
  return path.basename(String(value).replace(/[\\/]+$/, "")) || "unknown";
}

function extractClaudePrompt(obj) {
  if (!obj || obj.type !== "user" || obj.isMeta) return null;
  const content = obj.message?.content;
  if (Array.isArray(content)) {
    if (content.length > 0 && content.every((block) => block?.type === "tool_result")) return null;
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) return null;
    if (text === "[Request interrupted by user]" || text.startsWith("<task-notification>")) return null;
    return text;
  }
  if (typeof content !== "string") return null;
  const text = content.trim();
  if (!text || text === "[Request interrupted by user]" || text.startsWith("<task-notification>")) return null;
  return text;
}

function promptFingerprint(prompt) {
  return crypto.createHash("sha256").update(prompt.replace(/\s+/g, " ")).digest("hex");
}

// Normalize a session title into a single short line. Titles come ONLY from
// the agent's own metadata (Claude's ai-title, Codex's thread_name) — never
// the raw prompt body — so the metadata-only privacy guarantee holds. They
// stay local-only alongside session_id.
function cleanSessionTitle(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}…` : text;
}

function extractCodexPrompt(obj) {
  if (obj?.type !== "event_msg" || obj.payload?.type !== "user_message") return null;
  if (typeof obj.payload.message === "string") {
    const message = obj.payload.message.trim();
    return message || null;
  }
  const elements = Array.isArray(obj.payload.text_elements) ? obj.payload.text_elements : [];
  const text = elements
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.value === "string") return item.value;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || null;
}

function canonicalToolName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name) return "";
  return name.replace(/^functions[.:/]/, "").replace(/^tools[.:/]/, "");
}

function extractCodexSignalTools(payload) {
  if (!payload || !["function_call", "custom_tool_call"].includes(payload.type)) return [];
  const directName = canonicalToolName(payload.name);
  if (directName && directName !== "exec") return [directName];
  if (directName !== "exec" || typeof payload.input !== "string") return [];

  const names = [];
  for (const name of CODEX_SIGNAL_TOOLS) {
    const pattern = new RegExp(`\\btools\\.${name}\\s*\\(`, "gi");
    for (const _match of payload.input.matchAll(pattern)) names.push(name);
  }
  return names;
}

function finalizeRecord(record) {
  delete record._last_ts_ms;
  record.active_ms = Math.max(0, finite(record.active_ms));
  record.duration_ms = record.active_ms;
  record.total_tokens = finite(record.total_tokens || record.tokens?.total_tokens);
  repriceSessionRecord(record);
  record.productive = record.edit_turns > 0;
  // A first-pass delivery has exactly one user turn containing an observed
  // edit and no repeated user request. The legacy one_shot field stays as an
  // API/CSV alias, but now follows this cross-provider definition.
  record.first_pass = record.edit_turns === 1 && record.retry_turns === 0;
  record.one_shot = record.first_pass;
  record.tokens_per_edit = record.edit_turns > 0 ? record.total_tokens / record.edit_turns : null;
  record.cost_per_edit = record.edit_turns > 0 ? record.cost_usd / record.edit_turns : null;
  return record;
}

function readableSessionPaths(filePath) {
  const candidates = (Array.isArray(filePath) ? filePath : [filePath]).filter(Boolean);
  const readable = candidates.filter((value) => sessionFileStatKey(value));
  if (!readable.length) {
    throw new Error("session files vanished before they could be scanned");
  }
  return readable;
}

function isRecoverableSessionReadError(error) {
  return ["ENOENT", "EACCES", "EPERM", "EISDIR", "EIO", "ESTALE"].includes(error?.code);
}

async function scanClaudeSession(filePath) {
  // Native and WSL mounts can disappear independently after discovery. Keep
  // the surviving mirror instead of dropping the whole logical session.
  const filePaths = readableSessionPaths(filePath);
  const primaryFilePath = filePaths[0] || String(filePath || "");
  const tokens = emptyTotals();
  // One logical cross-root group is cached and scanned as a unit, so widening
  // this set across that group stays deterministic. Unrelated files (including
  // same-UUID siblings inside one root) are never grouped here.
  const seenMessages = new Set();
  const bounds = emptyBounds();
  // The basename keeps grouping stable for files that never write a sessionId
  // record, but only an *observed* sessionId may become a resumable
  // session_id — otherwise non-session logs under ~/.claude/projects (e.g.
  // skill-injections.jsonl, journal.jsonl) yield `claude --resume journal`,
  // a command that always fails.
  let rawSessionId = path.basename(primaryFilePath, ".jsonl");
  let observedSessionId = null;
  let cwd = null;
  let model = "unknown";
  let aiTitle = null;
  let turns = 0;
  let editTurns = 0;
  let retryTurns = 0;
  let currentHadEdit = false;
  let subagentCalls = 0;
  const subagentTypes = new Map();

  function closeTurn() {
    if (currentHadEdit) {
      editTurns += 1;
    }
    currentHadEdit = false;
  }
  let lastPromptFingerprint = null;

  // A native path and a WSL path can expose the same logical session with a
  // shared prefix and different tails. Scan every tail, but suppress records
  // already present in an earlier root. Hashes stay in-memory only, preserving
  // the metadata-only persistence contract.
  const priorRecordHashes = new Set();
  let scannedFiles = 0;
  for (const currentFilePath of filePaths) {
    const currentRecordHashes = new Set();
    try {
      const input = fs.createReadStream(currentFilePath, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (filePaths.length > 1) {
          const recordHash = crypto.createHash("sha256").update(line).digest("base64url");
          if (priorRecordHashes.has(recordHash)) continue;
          currentRecordHashes.add(recordHash);
        }
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        updateBounds(bounds, obj.timestamp || obj.message?.timestamp);
        if (typeof obj.sessionId === "string" && obj.sessionId) {
          rawSessionId = obj.sessionId;
          observedSessionId = obj.sessionId;
        }
        if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
        // Claude writes its own generated one-line summary as an "ai-title" record.
        // It is agent-authored metadata (not the raw prompt body); keep the latest.
        if (obj.type === "ai-title" && typeof obj.aiTitle === "string") {
          const cleaned = cleanSessionTitle(obj.aiTitle);
          if (cleaned) aiTitle = cleaned;
          continue;
        }
        if (obj.type === "user") {
          const prompt = extractClaudePrompt(obj);
          if (!prompt) continue;
          const fingerprint = promptFingerprint(prompt);
          if (lastPromptFingerprint && fingerprint === lastPromptFingerprint) retryTurns += 1;
          lastPromptFingerprint = fingerprint;
          closeTurn();
          turns += 1;
          continue;
        }
        if (obj.type !== "assistant" || !obj.message) continue;
        const dedupKey = claudeMessageDedupKey(obj);
        if (dedupKey && seenMessages.has(dedupKey)) continue;
        if (dedupKey) seenMessages.add(dedupKey);
        // Claude writes internal summary/observer messages with model
        // "<synthetic>". They are not a billable model and can appear after the
        // real assistant messages in the same session. Keep the latest real
        // model instead of letting that marker overwrite it.
        const candidateModel = normalizeSessionModel(obj.message.model);
        if (candidateModel) model = candidateModel;
        addTotals(tokens, tokenTotals(obj.message.usage));
        const content = Array.isArray(obj.message.content) ? obj.message.content : [];
        for (const block of content) {
          if (!block || block.type !== "tool_use") continue;
          const name = String(block.name || "").toLowerCase();
          if (EDIT_TOOLS.has(name)) currentHadEdit = true;
          if (name === "agent" || name === "task") {
            subagentCalls += 1;
            const subtype = typeof block.input?.subagent_type === "string"
              ? block.input.subagent_type.trim().slice(0, 64)
              : "unspecified";
            subagentTypes.set(subtype || "unspecified", (subagentTypes.get(subtype || "unspecified") || 0) + 1);
          }
        }
      }
      scannedFiles += 1;
    } catch (error) {
      if (!isRecoverableSessionReadError(error)) throw error;
    } finally {
      for (const recordHash of currentRecordHashes) priorRecordHashes.add(recordHash);
    }
  }
  if (!scannedFiles) throw new Error("all grouped Claude session files failed during read");
  closeTurn();
  return finalizeRecord({
    version: SIDECAR_VERSION,
    session_hash: sessionHash("claude", rawSessionId),
    session_id: observedSessionId || null,
    // Claude's own generated one-line title (the "ai-title" record). Agent-
    // authored metadata, never the raw prompt body. Local-only: stripped in
    // summarizeSessions before any cloud/CSV export. Null when Claude never
    // wrote one — the UI then falls back to the project name.
    title: aiTitle,
    source: "claude",
    project_key: projectKey(cwd, primaryFilePath),
    project_ref: cwd || null,
    model,
    ...bounds,
    turns,
    edit_turns: editTurns,
    retry_turns: retryTurns,
    subagent_calls: subagentCalls,
    subagent_types: Object.fromEntries([...subagentTypes.entries()].sort()),
    tokens,
    provenance: { source: "local-session-log", confidence: "observed", retry_confidence: "inferred", content_retained: false },
  });
}

function createCodexDeliverySignalCollector() {
  const bounds = emptyBounds();
  let turns = 0;
  let editTurns = 0;
  let retryTurns = 0;
  let currentTurnOpen = false;
  let currentTurnKey = null;
  let currentHadEdit = false;
  let hasTurnContext = false;
  let lastPromptFingerprint = null;
  let subagentCalls = 0;
  const subagentTypes = new Map();
  // The model the open turn belongs to, as decided by codex-model-attribution.
  // The parser hands it in rather than this collector re-reading
  // turn_context.payload.model, so there stays exactly one authority on which
  // model owns a turn - the same one that bills the turn's tokens.
  let currentTurnModel = null;
  const editTurnsByModel = new Map();

  function closeTurn() {
    if (currentTurnOpen && currentHadEdit) {
      editTurns += 1;
      const key = currentTurnModel || "unknown";
      editTurnsByModel.set(key, (editTurnsByModel.get(key) || 0) + 1);
    }
    currentHadEdit = false;
  }

  function beginTurn(key, model) {
    if (currentTurnOpen && key && currentTurnKey === key) return;
    if (currentTurnOpen) closeTurn();
    currentTurnOpen = true;
    currentTurnKey = key || null;
    currentTurnModel = model || null;
    turns += 1;
  }

  function consume(obj, model = null) {
    updateBounds(bounds, obj?.timestamp);
    if (obj?.type === "turn_context") {
      hasTurnContext = true;
      beginTurn(String(obj.payload?.turn_id || obj.timestamp || turns + 1), model);
      return;
    }
    // Between two turn_context rows the attributed model only moves when a
    // model/rerouted event fires mid-turn. recordModelUsage() bills the rest of
    // the turn's tokens to the new model, so the turn's edits have to move with
    // them - otherwise one turn's tokens and its edit count land on two
    // different rows and by_model.tokens_per_edit divides across models.
    if (currentTurnOpen && model && model !== currentTurnModel) currentTurnModel = model;
    const prompt = extractCodexPrompt(obj);
    if (prompt) {
      const fingerprint = promptFingerprint(prompt);
      if (lastPromptFingerprint && fingerprint === lastPromptFingerprint) retryTurns += 1;
      lastPromptFingerprint = fingerprint;
      if (!hasTurnContext) beginTurn(String(obj.timestamp || turns + 1), model);
      return;
    }
    if (obj?.type !== "response_item") return;
    const toolNames = extractCodexSignalTools(obj.payload);
    if (!toolNames.length) return;
    if (!currentTurnOpen) beginTurn(String(obj.timestamp || turns + 1), model);
    if (toolNames.some((name) => EDIT_TOOLS.has(name))) currentHadEdit = true;
    for (const name of toolNames) {
      if (!CODEX_SUBAGENT_TOOLS.has(name)) continue;
      subagentCalls += 1;
      const displayName = name === "multi_agent_v1__spawn_agent" ? "spawn_agent" : name;
      subagentTypes.set(displayName, (subagentTypes.get(displayName) || 0) + 1);
    }
  }

  function finish() {
    closeTurn();
    return {
      bounds,
      turns,
      editTurns,
      editTurnsByModel: Object.fromEntries(editTurnsByModel),
      retryTurns,
      subagentCalls,
      subagentTypes: Object.fromEntries([...subagentTypes.entries()].sort()),
    };
  }

  return { consume, finish };
}

async function scanCodexSession(filePath) {
  const filePaths = readableSessionPaths(filePath);
  const primaryFilePath = filePaths[0] || String(filePath || "");
  const signalCollector = createCodexDeliverySignalCollector();
  const parsed = await parseCodexRolloutFile(filePaths, {
    seenTokenEvents: new Set(),
    collectBreakdowns: false,
    collectModelUsage: true,
    onObject: signalCollector.consume,
  });
  const signals = signalCollector.finish();
  // The collector keyed edit turns by the model the parser handed it, so the
  // keys are the same raw model ids parsed.modelUsage rows carry. A model whose
  // edit turns produced no billable delta has no row to land on;
  // modelUsageForAggregation() folds that residual into the busiest model so
  // the by_model column still sums to edit_turns.
  const editTurnsByModel = signals.editTurnsByModel || {};
  const modelUsage = (parsed.modelUsage || []).map((row) => ({
    ...row,
    edit_turns: finite(editTurnsByModel[row.model]),
  }));
  const parsedModel = normalizeSessionModel(parsed.model);
  const provider = normalizeSessionModel(parsed.provider);
  // Older Codex rollouts can omit turn_context.model. The shared parser then
  // falls back to model_provider (for example "openai"), which is provenance
  // rather than a model and must not become a model-table row.
  const observedModels = (parsed.modelUsage || [])
    .map((row) => normalizeSessionModel(row.model))
    .filter(Boolean);
  const model = observedModels.length > 1
    ? "mixed"
    : observedModels[0] || (
      parsedModel && parsedModel.toLowerCase() !== provider?.toLowerCase()
        ? parsedModel
        : "unknown"
    );
  // Codex's own thread title from session_index.jsonl (Codex-authored
  // metadata, keyed by session id). Null when Codex never named the thread —
  // the UI then falls back to the project name.
  const title = parsed.sessionId
    ? filePaths.map(loadCodexTitleIndex).map((index) => index.get(parsed.sessionId)).find(Boolean) || null
    : null;
  return finalizeRecord({
    version: SIDECAR_VERSION,
    session_hash: sessionHash("codex", parsed.sessionId || primaryFilePath),
    session_id: parsed.sessionId || null,
    // Local-only lineage. Codex v2 normally writes forked_from_id; keep
    // parent_thread_id as a compatibility fallback, but reject disagreement.
    parent_session_id: parsed.forkedFromId || parsed.parentThreadId || null,
    parent_link_conflict: Boolean(
      parsed.forkedFromId
      && parsed.parentThreadId
      && parsed.forkedFromId !== parsed.parentThreadId
    ),
    forked_from_id: parsed.forkedFromId || null,
    thread_source: typeof parsed.threadSource === "string" ? parsed.threadSource : null,
    agent_nickname: typeof parsed.agentNickname === "string" ? parsed.agentNickname : null,
    agent_role: typeof parsed.agentRole === "string" ? parsed.agentRole : null,
    // Local-only: stripped in summarizeSessions before any cloud/CSV export.
    title,
    source: "codex",
    project_key: projectKey(parsed.cwd, primaryFilePath),
    project_ref: parsed.cwd || null,
    model,
    model_usage: modelUsage,
    ...signals.bounds,
    turns: signals.turns || finite(parsed.turnCount),
    edit_turns: signals.editTurns,
    retry_turns: signals.retryTurns,
    subagent_calls: signals.subagentCalls,
    subagent_types: signals.subagentTypes,
    tokens: parsed.totals || emptyTotals(),
    provenance: { source: "local-session-log", confidence: "observed", retry_confidence: "inferred", content_retained: false },
  });
}

// Grok Build sessions live at:
//   ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/updates.jsonl
// with sibling summary.json (id/cwd/title) and signals.json (aggregate
// counters). Billable tokens come only from turn_completed.usage — the same
// authority as the Grok usage parser — not from context-window totalTokens.
function resolveGrokHome(home = os.homedir(), env = process.env) {
  if (typeof env.TOKENTRACKER_GROK_HOME === "string" && env.TOKENTRACKER_GROK_HOME.trim()) {
    return path.resolve(env.TOKENTRACKER_GROK_HOME.trim());
  }
  if (typeof env.GROK_HOME === "string" && env.GROK_HOME.trim()) {
    return path.resolve(env.GROK_HOME.trim());
  }
  return path.join(home, ".grok");
}

function grokSummaryPathFor(updatesPath) {
  return path.join(path.dirname(updatesPath), "summary.json");
}

function grokSignalsPathFor(updatesPath) {
  return path.join(path.dirname(updatesPath), "signals.json");
}

function readJsonFileSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function grokTimestampIso(obj) {
  const metaMs = Number(obj?.params?._meta?.agentTimestampMs);
  if (Number.isFinite(metaMs) && metaMs > 0) return new Date(metaMs).toISOString();
  const top = Number(obj?.timestamp);
  if (!Number.isFinite(top) || top <= 0) return null;
  // Grok writes unix seconds on the envelope; ms values are already > 1e12.
  const ms = top > 1e12 ? top : top * 1000;
  return new Date(ms).toISOString();
}

function pickGrokModel(usage, fallback) {
  const modelUsage = usage?.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    let bestName = null;
    let bestTokens = -1;
    for (const [name, entry] of Object.entries(modelUsage)) {
      const normalized = normalizeSessionModel(name);
      if (!normalized) continue;
      const tokens = finite(entry?.totalTokens ?? entry?.total_tokens)
        + finite(entry?.inputTokens ?? entry?.input_tokens)
        + finite(entry?.outputTokens ?? entry?.output_tokens);
      if (tokens >= bestTokens) {
        bestTokens = tokens;
        bestName = normalized;
      }
    }
    if (bestName) return bestName;
  }
  return normalizeSessionModel(fallback) || "unknown";
}

function extractGrokUserPrompt(update) {
  if (!update || update.sessionUpdate !== "user_message_chunk") return null;
  const content = update.content;
  if (typeof content === "string") {
    const text = content.trim();
    return text || null;
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      const text = content.text.trim();
      return text || null;
    }
  }
  return null;
}

function extractGrokToolName(update) {
  if (!update || update.sessionUpdate !== "tool_call") return "";
  const metaName = update._meta?.["x.ai/tool"]?.name;
  return canonicalToolName(metaName || update.title || "");
}

async function listGrokSessionFiles(sessionsRoot) {
  if (!fs.existsSync(sessionsRoot)) return [];
  const found = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const updatesPath = path.join(full, "updates.jsonl");
      try {
        const stat = await fsp.stat(updatesPath);
        if (stat.isFile() && stat.size > 0) {
          found.push(updatesPath);
          continue;
        }
      } catch { /* not a session leaf */ }
      await walk(full, depth + 1);
    }
  }
  await walk(sessionsRoot, 0);
  // Deterministic order so filesSignature is stable across readdir() shuffles.
  found.sort((a, b) => a.localeCompare(b));
  return found;
}

async function scanGrokSession(filePath) {
  const summary = readJsonFileSync(grokSummaryPathFor(filePath)) || {};
  const signals = readJsonFileSync(grokSignalsPathFor(filePath)) || {};
  const tokens = emptyTotals();
  const bounds = emptyBounds();
  const dirName = path.basename(path.dirname(filePath));
  let observedSessionId = typeof summary?.info?.id === "string" && summary.info.id
    ? summary.info.id
    : (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(dirName) ? dirName : null);
  let cwd = typeof summary?.info?.cwd === "string" && summary.info.cwd
    ? summary.info.cwd
    : null;
  // Prefer agent-authored generated_title over free-form session_summary when
  // both exist; both are Grok metadata, never the raw user prompt body.
  const title = cleanSessionTitle(summary.generated_title)
    || cleanSessionTitle(summary.session_summary)
    || null;
  let model = pickGrokModel(null, signals.primaryModelId || summary.current_model_id);
  let turns = 0;
  let editTurns = 0;
  let retryTurns = 0;
  let currentHadEdit = false;
  let subagentCalls = 0;
  const subagentTypes = new Map();
  let usageEvents = 0;
  let providerCostEvents = 0;
  let providerCostUsd = 0;
  let modelCalls = 0;
  let apiDurationMs = 0;
  let usageIsIncomplete = false;
  let costIsPartial = false;
  let lastPromptFingerprint = null;
  // Grok streams user_message_chunk pieces for one prompt. Accumulate until
  // turn_completed, then fingerprint the full prompt for retry detection.
  let openUserTurn = false;
  let userChunkBuffer = "";

  function closeTurn() {
    if (currentHadEdit) editTurns += 1;
    currentHadEdit = false;
    if (userChunkBuffer) {
      const fingerprint = promptFingerprint(userChunkBuffer);
      if (lastPromptFingerprint && fingerprint === lastPromptFingerprint) retryTurns += 1;
      lastPromptFingerprint = fingerprint;
    }
    openUserTurn = false;
    userChunkBuffer = "";
  }

  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    updateBounds(bounds, grokTimestampIso(obj));
    const params = obj.params && typeof obj.params === "object" ? obj.params : {};
    if (typeof params.sessionId === "string" && params.sessionId) {
      observedSessionId = params.sessionId;
    }
    const update = params.update && typeof params.update === "object" ? params.update : null;
    if (!update) continue;
    const sessionUpdate = update.sessionUpdate;

    if (sessionUpdate === "user_message_chunk") {
      const piece = extractGrokUserPrompt(update);
      if (!piece) continue;
      // First non-empty chunk after a closed turn opens a new user turn;
      // later chunks only extend the fingerprint buffer.
      if (!openUserTurn) {
        turns += 1;
        openUserTurn = true;
        userChunkBuffer = piece;
      } else {
        userChunkBuffer += piece;
      }
      continue;
    }

    if (sessionUpdate === "tool_call") {
      // Tools belong to the current user turn. After turn_completed closes a
      // turn, a tool-only follow-up must open a new anonymous turn — otherwise
      // edit_turns can exceed turns.
      if (!openUserTurn) {
        turns += 1;
        openUserTurn = true;
      }
      const name = extractGrokToolName(update);
      if (EDIT_TOOLS.has(name)) currentHadEdit = true;
      if (GROK_SUBAGENT_TOOLS.has(name)) {
        subagentCalls += 1;
        const display = name === "spawn_agent" ? "spawn_subagent" : name;
        subagentTypes.set(display, (subagentTypes.get(display) || 0) + 1);
      }
      continue;
    }

    if (sessionUpdate === "turn_completed") {
      closeTurn();
      const usage = update.usage;
      const normalizedUsage = normalizeGrokUsage(usage);
      if (normalizedUsage) {
        usageEvents += 1;
        addTotals(tokens, normalizedUsage);
        modelCalls += finite(normalizedUsage.model_calls);
        apiDurationMs += finite(normalizedUsage.api_duration_ms);
        usageIsIncomplete ||= normalizedUsage.usage_is_incomplete;
        costIsPartial ||= normalizedUsage.cost_is_partial;
        if (normalizedUsage.total_cost_usd != null) {
          providerCostEvents += 1;
          providerCostUsd = Math.round(
            (providerCostUsd + normalizedUsage.total_cost_usd) * USD_TICKS_PER_USD,
          ) / USD_TICKS_PER_USD;
        }
      }
      const candidate = pickGrokModel(usage, model);
      if (candidate && candidate !== "unknown") model = candidate;
      continue;
    }
  }
  closeTurn();

  // Prefer observed turn_completed totals. Never invent billable totals from
  // signals.contextTokensUsed (context-window occupancy is not API usage);
  // leave zeros so listSessionsForBrowser filters empty sessions out.
  if (turns === 0 && finite(signals.turnCount) > 0) {
    turns = finite(signals.turnCount);
  }
  if (!Number.isFinite(Date.parse(bounds.started_at || "")) && summary.created_at) {
    updateBounds(bounds, summary.created_at);
  }
  if (!Number.isFinite(Date.parse(bounds.ended_at || "")) && (summary.last_active_at || summary.updated_at)) {
    updateBounds(bounds, summary.last_active_at || summary.updated_at);
  }
  if ((!model || model === "unknown") && signals.primaryModelId) {
    model = normalizeSessionModel(signals.primaryModelId) || model;
  }

  const hasCompleteProviderCost = usageEvents > 0
    && providerCostEvents === usageEvents
    && !usageIsIncomplete
    && !costIsPartial;

  return finalizeRecord({
    version: SIDECAR_VERSION,
    session_hash: sessionHash("grok", observedSessionId || filePath),
    session_id: observedSessionId || null,
    // Local-only: stripped in summarizeSessions before any cloud/CSV export.
    title,
    source: "grok",
    project_key: projectKey(cwd, filePath),
    project_ref: cwd || null,
    model: model || "unknown",
    ...bounds,
    turns,
    edit_turns: editTurns,
    retry_turns: retryTurns,
    subagent_calls: subagentCalls,
    subagent_types: Object.fromEntries([...subagentTypes.entries()].sort()),
    tokens,
    usage_events: usageEvents,
    usage_precision: usageIsIncomplete ? "reported_incomplete" : (usageEvents > 0 ? "reported" : "unavailable"),
    usage_is_incomplete: usageIsIncomplete,
    cost_is_partial: costIsPartial,
    cost_source: hasCompleteProviderCost ? "provider_reported" : "model_pricing",
    provider_cost_usd: hasCompleteProviderCost ? providerCostUsd : null,
    model_calls: modelCalls,
    api_duration_ms: apiDurationMs,
    context_tokens_used: finite(signals.contextTokensUsed),
    context_window_tokens: finite(signals.contextWindowTokens),
    context_usage_percent: finite(signals.contextWindowUsage),
    tool_calls: finite(signals.toolCallCount),
    tool_failures: finite(signals.toolFailureCount),
    error_count: finite(signals.errorCount),
    compaction_count: finite(signals.compactionCount),
    provenance: {
      source: "local-session-log",
      confidence: usageIsIncomplete ? "partial" : "observed",
      retry_confidence: "inferred",
      content_retained: false,
      usage: usageEvents > 0 ? "turn_completed.usage" : "unavailable",
      cost: hasCompleteProviderCost ? "provider_reported" : "model_pricing",
    },
  });
}

// Multi-root discovery: on Windows a native install and a WSL one both count.
// `sync` already walks both Claude homes (src/commands/sync.js), so without this
// the WSL work lands in the token totals but is invisible in the session browser
// and its project list. TOKENTRACKER_WSL_MODE gates which sides are probed;
// duplicated files synced between environments collapse via the Codex session-id
// pass below and claudeMessageDedupKey downstream.
function providerRoots(home, providerDir, env, deps = {}) {
  const platform = deps.platform || process.platform;
  const homedir = deps.homedir || os.homedir;
  const discoverWslHome = deps.discoverWslHome || wsl.discoverWslHome;
  const roots = [];
  if (platform !== "win32" || wsl.shouldProbeNative(env)) {
    const useProcessCodexHome = providerDir === ".codex"
      && path.resolve(home) === path.resolve(homedir())
      && typeof env?.CODEX_HOME === "string"
      && env.CODEX_HOME.trim();
    const nativeRoot = useProcessCodexHome
      ? path.resolve(env.CODEX_HOME.trim())
      : path.join(home, providerDir);
    roots.push(nativeRoot);
  }
  // Only the machine's own home has a WSL sibling worth probing.
  // discoverWslHome resolves \\wsl$ independently of `home`, so probing for an
  // injected home (tests, a custom HOME) would splice the machine's live WSL
  // sessions into what the caller expects to be an isolated tree.
  //
  // This defaults rather than hard-codes: the whole reason to thread a
  // non-default home is to scan a tree that is not os.homedir(), and such a
  // caller would otherwise lose WSL discovery silently, with nothing failing.
  // `probeWsl` is the deliberate opt-in for that case.
  const probeWsl = deps.probeWsl !== undefined
    ? Boolean(deps.probeWsl)
    : path.resolve(home) === path.resolve(homedir());
  if (platform === "win32" && probeWsl && wsl.shouldProbeWsl(env)) {
    const wslRoot = discoverWslHome(providerDir, { env });
    if (wslRoot) roots.push(wslRoot);
  }
  return [...new Set(roots)];
}

// Group one logical session discovered under more than one root. A group is
// scanned as a unit so identical prefixes count once while divergent tails are
// both retained. Same-UUID siblings inside one Claude root stay separate: the
// path alone cannot prove which one a file in another root mirrors.
//
// Codex gets this from its session-id pass below; Claude only ever had per-file
// message dedup (`claudeMessageDedupKey` inside `scanClaudeSession`), which
// cannot see a second copy of the same file under a different path spelling.
// Every discovered path becomes its own row keyed by the resolved file path, so
// a WSL `$HOME` pointing at the Windows profile — the same files reachable as
// both `C:\Users\dev\.claude\...` and `\\wsl$\Ubuntu\home\dev\.claude\...` —
// duplicated sessions in the browser, the project list and the CSV export.
//
// Cross-root only, on purpose: a single root is passed through verbatim, so
// single-install machines are unaffected, and two same-named files inside one
// tree stay distinct (unproven identity must not delete a session). A basename
// without a session UUID never participates either.
function groupClaudeFilesAcrossRoots(groups) {
  const rootGroups = (groups || []).filter((group) => Array.isArray(group) && group.length > 0);
  if (rootGroups.length <= 1) return [...new Set(rootGroups[0] || [])].map((filePath) => [filePath]);
  const sessionIdOf = (filePath) =>
    path.basename(filePath).match(/^([0-9a-f-]{36})\.jsonl$/i)?.[1] || null;

  // A UUID appearing twice inside ONE root has no resolvable identity: nothing
  // in the paths says which sibling a copy in another root mirrors. Collapsing
  // by mtime there would evict a genuinely distinct transcript — and, when the
  // other root mirrors the sibling rather than the first file, keep that content
  // twice. Such UUIDs opt out of dedup entirely; an ambiguous duplicate is
  // cheap, a deleted session is not.
  const ambiguous = new Set();
  for (const group of rootGroups) {
    const seenHere = new Set();
    for (const filePath of group) {
      const id = sessionIdOf(filePath);
      if (!id) continue;
      if (seenHere.has(id)) ambiguous.add(id);
      seenHere.add(id);
    }
  }

  const groupedBySession = new Map();
  for (const group of rootGroups) {
    for (const filePath of group) {
      const id = sessionIdOf(filePath);
      if (!id || ambiguous.has(id)) continue;
      if (!groupedBySession.has(id)) groupedBySession.set(id, []);
      const paths = groupedBySession.get(id);
      if (!paths.includes(filePath)) paths.push(filePath);
    }
  }

  // Preserve root order and the first path as the representative cache key.
  const ordered = [];
  const emitted = new Set();
  for (const group of rootGroups) {
    for (const filePath of group) {
      const id = sessionIdOf(filePath);
      if (!id || ambiguous.has(id)) {
        if (!emitted.has(filePath)) {
          ordered.push([filePath]);
          emitted.add(filePath);
        }
        continue;
      }
      if (emitted.has(id)) continue;
      ordered.push(groupedBySession.get(id) || [filePath]);
      emitted.add(id);
    }
  }
  return ordered;
}

function sameFileContent(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length <= 1) return true;
  try {
    const first = fs.readFileSync(filePaths[0]);
    return filePaths.slice(1).every((filePath) => {
      const candidate = fs.readFileSync(filePath);
      return candidate.length === first.length && candidate.equals(first);
    });
  } catch {
    return false;
  }
}

// Compatibility helper used by focused discovery tests and callers that only
// need a flat list. Only byte-identical mirrors collapse; divergent copies are
// all returned so no transcript tail is discarded.
function dedupeClaudeFilesAcrossRoots(groups) {
  const mtimeOf = (filePath) => {
    try { return fs.statSync(filePath).mtimeMs; } catch { return -Infinity; }
  };
  const out = [];
  for (const filePaths of groupClaudeFilesAcrossRoots(groups)) {
    if (filePaths.length <= 1 || !sameFileContent(filePaths)) {
      out.push(...filePaths);
      continue;
    }
    out.push(filePaths.reduce((winner, candidate) => (
      mtimeOf(candidate) > mtimeOf(winner) ? candidate : winner
    )));
  }
  return [...new Set(out)];
}

function groupCodexFiles(filePaths) {
  const ordered = [];
  const bySession = new Map();
  for (const filePath of [...new Set(filePaths || [])]) {
    const id = path.basename(filePath).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1] || filePath;
    let group = bySession.get(id);
    if (!group) {
      group = [];
      bySession.set(id, group);
      ordered.push(group);
    }
    group.push(filePath);
  }
  return ordered;
}

async function discoverSessionFiles(home, env = process.env, deps = {}) {
  const grokHome = resolveGrokHome(home);
  const claudeRoots = providerRoots(home, ".claude", env, deps);
  const codexRoots = providerRoots(home, ".codex", env, deps);
  const [claudeGroups, codexGroups, archivedGroups, grok] = await Promise.all([
    Promise.all(claudeRoots.map((r) => listClaudeProjectFiles(path.join(r, "projects")))),
    Promise.all(codexRoots.map((r) => listRolloutFilesDeep(path.join(r, "sessions")))),
    Promise.all(codexRoots.map((r) => listRolloutFilesDeep(path.join(r, "archived_sessions")))),
    listGrokSessionFiles(path.join(grokHome, "sessions")),
  ]);
  const allClaude = groupClaudeFilesAcrossRoots(claudeGroups);
  const codex = [...new Set(codexGroups.flat())];
  const archived = [...new Set(archivedGroups.flat())];
  // Claude Memory stores thousands of background observer transcripts beside
  // real Claude Code sessions. They contain <synthetic>/haiku bookkeeping and
  // no user coding outcome, so scanning them both slows the card dramatically
  // and dilutes its efficiency metrics.
  const claude = allClaude.filter((filePaths) => !filePaths.some((filePath) => filePath
    .split(path.sep)
    .some((segment) => segment.endsWith(CLAUDE_MEM_OBSERVER_PROJECT_SUFFIX))));
  return { claude, codex: groupCodexFiles([...codex, ...archived]), grok };
}

function filesSignature(files) {
  const hash = crypto.createHash("sha256");
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      hash.update(`${filePath}\0${stat.size}\0${stat.mtimeMs}\n`);
    } catch { /* vanished during discovery */ }
  }
  return hash.digest("hex");
}

function sessionFileCacheKey(source, filePath) {
  const filePaths = (Array.isArray(filePath) ? filePath : [filePath]).filter(Boolean);
  return crypto
    .createHash("sha256")
    .update(`${source}\0${filePaths.map((value) => path.resolve(value)).join("\0")}`)
    .digest("hex")
    .slice(0, 24);
}

function sessionFileStatKey(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

// Codex records its own per-thread title (thread_name) in
// ~/.codex/session_index.jsonl (`{ id, thread_name, updated_at }`). We read it
// once per build and memoize by the index's stat so repeated scans are cheap.
const codexTitleIndexCache = new Map();

function codexTitleIndexPathFor(filePath) {
  let current = path.dirname(path.resolve(filePath));
  while (true) {
    if (["sessions", "archived_sessions"].includes(path.basename(current))) {
      return path.join(path.dirname(current), "session_index.jsonl");
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadCodexTitleIndex(filePath) {
  const indexPath = codexTitleIndexPathFor(filePath);
  if (!indexPath) return new Map();
  const statKey = sessionFileStatKey(indexPath);
  const cached = codexTitleIndexCache.get(indexPath);
  if (cached && cached.statKey === statKey) return cached.titles;
  const titles = new Map();
  if (statKey) {
    try {
      for (const line of fs.readFileSync(indexPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const id = typeof obj?.id === "string" ? obj.id : null;
        const name = cleanSessionTitle(obj?.thread_name);
        if (id && name) titles.set(id, name);
      }
    } catch { /* no index yet */ }
  }
  codexTitleIndexCache.set(indexPath, { statKey, titles });
  return titles;
}

// A Codex row also depends on session_index.jsonl, not just its rollout file.
// Include that dependency in the incremental cache key so renaming a thread is
// visible after the next refresh instead of leaving a stale title indefinitely.
// Grok titles live in sibling summary.json (and signals can change without
// touching updates.jsonl on some partial flushes).
function analyticsEntryStatKey(source, filePath) {
  const filePaths = (Array.isArray(filePath) ? filePath : [filePath]).filter(Boolean);
  const sessionStats = filePaths.map((value) => sessionFileStatKey(value) || "missing");
  if (sessionStats.every((value) => value === "missing")) return null;
  const sessionStat = sessionStats.join("|");
  if (source === "codex") {
    const titleStats = filePaths.map((value) => (
      sessionFileStatKey(codexTitleIndexPathFor(value)) || "missing"
    ));
    return `${sessionStat}|title-index:${titleStats.join("|")}`;
  }
  if (source === "grok") {
    const primary = filePaths[0];
    return `${sessionStat}|summary:${sessionFileStatKey(grokSummaryPathFor(primary)) || "missing"}|signals:${sessionFileStatKey(grokSignalsPathFor(primary)) || "missing"}`;
  }
  return sessionStat;
}

function readSidecar(sidecarPath) {
  try {
    return fs.readFileSync(sidecarPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => repriceSessionRecord(JSON.parse(line)));
  } catch { return []; }
}

async function writeAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temp, filePath);
}

async function buildSessionAnalyticsInternal({ home = os.homedir(), force = false, cacheTtlMs = 5 * 60_000 } = {}) {
  const sidecarPath = resolveSessionSidecarPath(home);
  const metaPath = `${sidecarPath}.meta.json`;
  let previousMeta = null;
  if (!force) {
    try {
      previousMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const checkedAt = Date.parse(previousMeta.checked_at || previousMeta.generated_at || "");
      if (
        previousMeta.version === SIDECAR_VERSION &&
        Number.isFinite(checkedAt) &&
        Date.now() - checkedAt < Math.max(0, Number(cacheTtlMs) || 0)
      ) {
        return readSidecar(sidecarPath);
      }
    } catch { /* first run */ }
  }
  const discovered = await discoverSessionFiles(home);
  // Codex thread titles are stored separately from rollout files. Include the
  // index in the overall signature so an index-only rename reaches the
  // per-file dependency check below on the next refresh. Grok titles/metadata
  // live in sibling summary.json / signals.json next to updates.jsonl.
  const signature = filesSignature([
    ...discovered.claude.flat(),
    ...discovered.codex.flat(),
    ...discovered.codex.flat().map(codexTitleIndexPathFor).filter(Boolean),
    ...discovered.grok,
    ...discovered.grok.map(grokSummaryPathFor),
    ...discovered.grok.map(grokSignalsPathFor),
  ]);
  if (!force && previousMeta?.version === SIDECAR_VERSION && previousMeta.signature === signature) {
    await writeAtomic(metaPath, `${JSON.stringify({ ...previousMeta, checked_at: new Date().toISOString() })}\n`);
    return readSidecar(sidecarPath);
  }

  const previousRows = !force && previousMeta?.version === SIDECAR_VERSION
    ? readSidecar(sidecarPath)
    : [];
  const previousRowsByFile = new Map(previousRows
    .filter((row) => typeof row?._cache_key === "string")
    .map((row) => [row._cache_key, row]));
  const previousFiles = previousMeta?.version === SIDECAR_VERSION && previousMeta.files
    ? previousMeta.files
    : {};
  const nextFiles = {};
  const sessions = [];
  const entries = [
    ...discovered.claude.map((filePaths) => ({ source: "claude", filePath: filePaths, scan: scanClaudeSession })),
    ...discovered.codex.map((filePaths) => ({ source: "codex", filePath: filePaths, scan: scanCodexSession })),
    ...discovered.grok.map((filePath) => ({ source: "grok", filePath, scan: scanGrokSession })),
  ];
  // Files we could not turn into a row (permission denied, half-written line,
  // vanished mid-scan). Swallowing these silently made sessions disappear with
  // no signal at all; count them so the API can say so.
  let skippedFiles = 0;
  for (const entry of entries) {
    const cacheKey = sessionFileCacheKey(entry.source, entry.filePath);
    const statKey = analyticsEntryStatKey(entry.source, entry.filePath);
    if (!statKey) {
      skippedFiles += 1;
      continue;
    }
    let row = null;
    if (!force && previousFiles[cacheKey]?.stat_key === statKey) {
      row = previousRowsByFile.get(cacheKey) || null;
    }
    if (!row) {
      try {
        row = await entry.scan(entry.filePath);
      } catch (error) {
        // One active/partial session must not poison the sidecar, but do not
        // pretend it never existed either.
        skippedFiles += 1;
        if (!process.env.NODE_TEST_CONTEXT) {
          console.warn(`[session-analytics] skipped ${entry.source} session file: ${error?.message || error}`);
        }
      }
    }
    if (!row) continue;
    repriceSessionRecord(row);
    // A one-way file hash enables incremental reuse without persisting or
    // exposing the user's local session path.
    row._cache_key = cacheKey;
    sessions.push(row);
    nextFiles[cacheKey] = { stat_key: statKey };
  }
  sessions.sort((a, b) => String(b.ended_at || "").localeCompare(String(a.ended_at || "")));
  const content = sessions.map(serializeSessionRecord).join("\n") + (sessions.length ? "\n" : "");
  await writeAtomic(sidecarPath, content);
  const generatedAt = new Date().toISOString();
  await writeAtomic(metaPath, `${JSON.stringify({
    version: SIDECAR_VERSION,
    signature,
    generated_at: generatedAt,
    checked_at: generatedAt,
    files: nextFiles,
  })}\n`);
  // Non-enumerable so the array still behaves exactly like a plain row list
  // for every existing caller (map/filter/JSON of the rows is unaffected).
  Object.defineProperty(sessions, "skippedFiles", { value: skippedFiles, enumerable: false });
  return sessions;
}

// A cold scan walks every local Claude/Codex/Grok session file. Period switches
// can issue overlapping requests while that scan is still running; share the
// promise per home so those requests wait for one scan instead of multiplying
// the disk work and racing the atomic sidecar write.
const sessionAnalyticsBuilds = new Map();

function buildSessionAnalytics(options = {}) {
  const normalizedOptions = options && typeof options === "object" ? options : {};
  const home = path.resolve(String(normalizedOptions.home || os.homedir()));
  const force = Boolean(normalizedOptions.force);
  const existing = sessionAnalyticsBuilds.get(home);
  // Joining an in-flight build is only correct when that build is at least as
  // thorough as what this caller asked for. A refresh that landed while a plain
  // build was running used to be handed the un-refreshed result: the spinner
  // stopped and nothing had actually been re-scanned. Chain instead of joining
  // — never run two scans at once, they race the atomic sidecar write.
  if (existing && (!force || existing.force)) return existing.promise;

  const run = () => buildSessionAnalyticsInternal({ ...normalizedOptions, home, force });
  const promise = existing ? existing.promise.then(run, run) : run();
  const entry = { promise, force: force || Boolean(existing?.force) };
  sessionAnalyticsBuilds.set(home, entry);
  const clear = () => {
    if (sessionAnalyticsBuilds.get(home) === entry) sessionAnalyticsBuilds.delete(home);
  };
  promise.then(clear, clear);
  return promise;
}

// Does a session overlap the [from, to] day window? Testing started_at alone
// dropped every session that began before the window and ended inside it —
// exactly the long/resumed ones, which also sort to the top because the sort
// key is ended_at. On real data a 7-day window lost 6 sessions, the largest
// 224M tokens. Treat the window as an interval intersection instead.
function withinDayRange(row, from, to) {
  const startDay = String(row?.started_at || row?.ended_at || "").slice(0, 10);
  const endDay = String(row?.ended_at || row?.started_at || "").slice(0, 10);
  if (from && (!endDay || endDay < from)) return false;
  if (to && (!startDay || startDay > to)) return false;
  return true;
}

function summarizeSessions(sessions, { from = "", to = "", includeSessions = true } = {}) {
  const filtered = annotateCodexThreadUsage((sessions || [])
    .filter((row) => withinDayRange(row, from, to))
    .map((row) => ({ ...row })));
  const byModel = new Map();
  const subagents = new Map();
  const totals = {
    sessions: 0,
    productive_sessions: 0,
    one_shot_sessions: 0,
    edit_turns: 0,
    retries: 0,
    total_tokens: 0,
    cost_usd: 0,
    edit_tokens: 0,
    edit_cost_usd: 0,
  };
  for (const row of filtered) {
    totals.sessions += 1;
    if (row.productive) totals.productive_sessions += 1;
    if (row.first_pass ?? row.one_shot) totals.one_shot_sessions += 1;
    totals.edit_turns += finite(row.edit_turns);
    totals.retries += finite(row.retry_turns);
    totals.total_tokens += finite(row.total_tokens);
    totals.cost_usd += finite(row.cost_usd);
    if (row.productive) {
      totals.edit_tokens += finite(row.total_tokens);
      totals.edit_cost_usd += finite(row.cost_usd);
    }

    // One session contributes a row to EVERY model it used, so per-model
    // `sessions` counts "sessions that touched this model" and the column does
    // NOT sum to summary.sessions (a session that switched models mid-thread
    // is counted once per model). Token, cost, edit_turn and edit_token columns
    // DO sum exactly - only the session headcount overlaps. Read the session
    // total from summary.sessions / session_count, never by summing this column;
    // test/session-analytics.test.js locks both halves of that contract.
    const usageRows = modelUsageForAggregation(row);
    const primaryModel = usageRows[0]?.model || "unknown";
    for (const usage of usageRows) {
      const key = usage.model || "unknown";
      const agg = byModel.get(key) || {
        model: key,
        sessions: 0,
        productive_sessions: 0,
        one_shot_sessions: 0,
        edit_turns: 0,
        retries: 0,
        total_tokens: 0,
        cost_usd: 0,
        edit_tokens: 0,
        edit_cost_usd: 0,
        usage_events: 0,
        rerouted_usage_events: 0,
        long_context_usage_events: 0,
        model_attribution: "selected",
      };
      agg.sessions += 1;
      if (row.productive) agg.productive_sessions += 1;
      if (row.first_pass ?? row.one_shot) agg.one_shot_sessions += 1;
      agg.total_tokens += finite(usage.total_tokens);
      agg.cost_usd += finite(usage.cost_usd);
      agg.usage_events += finite(usage.usage_events);
      agg.rerouted_usage_events += finite(usage.rerouted_usage_events);
      agg.long_context_usage_events += finite(usage.long_context_usage_events);
      if (usage.model_attribution === "effective") agg.model_attribution = "effective";
      // Numerator and denominator of tokens_per_edit / cost_per_edit must come
      // from the same population, so both are per model: an edit turn is a
      // turn, and turn_context names the model that owns it. Giving one model
      // the whole session's edit_turns but only its own slice of the tokens
      // understated the ratio and broke sum(edit_tokens) == summary.edit_tokens.
      agg.edit_turns += finite(usage.edit_turns);
      if (row.productive) {
        agg.edit_tokens += finite(usage.total_tokens);
        agg.edit_cost_usd += finite(usage.cost_usd);
      }
      // Retries are deliberately NOT split. A retry is detected from the user
      // prompt, and user_message / turn_context ordering is not stable in Codex
      // rollouts (1332 one way vs 1139 the other across 400 local files), so a
      // per-model retry would name the wrong turn about as often as the right
      // one. Attributing them to the busiest model keeps the column summing to
      // summary.retries without claiming a precision the log cannot support.
      if (key === primaryModel) agg.retries += finite(row.retry_turns);
      byModel.set(key, agg);
    }
    if (row.source === "codex" && row.parent_session_hash) {
      const name = row.agent_role || row.agent_nickname || "subagent";
      const sub = subagents.get(name) || {
        name,
        calls: 0,
        sessions: 0,
        total_tokens: 0,
        cost_usd: 0,
        attribution: "observed-child-session",
      };
      sub.calls += 1;
      sub.sessions += 1;
      sub.total_tokens += finite(row.total_tokens);
      sub.cost_usd += finite(row.cost_usd);
      subagents.set(name, sub);
      continue;
    }
    // Codex child rollouts are first-class rows. A spawn call in the parent is
    // a control-plane event, not token usage, so do not mix in an estimate.
    if (row.source === "codex") continue;
    for (const [name, calls] of Object.entries(row.subagent_types || {})) {
      const sub = subagents.get(name) || { name, calls: 0, sessions: 0, total_tokens: 0, cost_usd: 0 };
      sub.calls += finite(calls);
      sub.sessions += 1;
      // Token allocation is an explicit estimate because vendor logs do not
      // consistently expose child usage separately.
      const share = Math.min(1, finite(calls) / Math.max(1, finite(row.turns)));
      sub.total_tokens += finite(row.total_tokens) * share;
      sub.cost_usd += finite(row.cost_usd) * share;
      subagents.set(name, sub);
    }
  }
  const by_model = [...byModel.values()].map((row) => ({
    ...row,
    productive_rate: row.sessions ? row.productive_sessions / row.sessions : null,
    one_shot_rate: row.productive_sessions ? row.one_shot_sessions / row.productive_sessions : null,
    edit_sessions: row.productive_sessions,
    first_pass_sessions: row.one_shot_sessions,
    edit_session_rate: row.sessions ? row.productive_sessions / row.sessions : null,
    first_pass_rate: row.productive_sessions ? row.one_shot_sessions / row.productive_sessions : null,
    tokens_per_edit: row.edit_turns ? row.edit_tokens / row.edit_turns : null,
    cost_per_edit: row.edit_turns ? row.edit_cost_usd / row.edit_turns : null,
  })).sort((a, b) => b.edit_turns - a.edit_turns || b.productive_sessions - a.productive_sessions || b.sessions - a.sessions);
  return {
    available: filtered.length > 0,
    // Local filesystem paths and raw session ids are required internally for
    // Git attribution and the local-only session browser, but never leave the
    // Node process through API/CSV payloads.
    sessions: includeSessions
      ? filtered.map(({
        project_ref: _projectRef,
        session_id: _sessionId,
        parent_session_id: _parentSessionId,
        forked_from_id: _forkedFromId,
        parent_session_hash: _parentSessionHash,
        root_session_hash: _rootSessionHash,
        agent_nickname: _agentNickname,
        agent_role: _agentRole,
        thread_source: _threadSource,
        parent_link_conflict: _parentLinkConflict,
        orphaned_subagent: _orphanedSubagent,
        title: _title,
        _cache_key: _cacheKey,
        ...row
      }) => row)
      : [],
    session_count: filtered.length,
    summary: {
      ...totals,
      productive_rate: totals.sessions ? totals.productive_sessions / totals.sessions : null,
      one_shot_rate: totals.productive_sessions ? totals.one_shot_sessions / totals.productive_sessions : null,
      edit_sessions: totals.productive_sessions,
      first_pass_sessions: totals.one_shot_sessions,
      edit_session_rate: totals.sessions ? totals.productive_sessions / totals.sessions : null,
      first_pass_rate: totals.productive_sessions ? totals.one_shot_sessions / totals.productive_sessions : null,
      tokens_per_edit: totals.edit_turns ? totals.edit_tokens / totals.edit_turns : null,
      cost_per_edit: totals.edit_turns ? totals.edit_cost_usd / totals.edit_turns : null,
    },
    by_model,
    subagents: [...subagents.values()].sort((a, b) => b.calls - a.calls),
    provenance: {
      source: "local-session-log",
      confidence: "observed",
      privacy: "metadata-only",
      methodology: "edit-turn-v2",
      edit_turn: "user turn containing an observed edit tool",
      first_pass: "exactly one edit turn and no repeated user request",
    },
  };
}

// Build the resume command a user can run to continue a past session. The
// session id is a vendor-generated UUID and never contains user prose.
function resumeCommandFor(source, sessionId) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  // Session ids come from local log files, which can be edited by other local
  // processes. Only emit an unquoted shell token so copying the suggested
  // command can never smuggle whitespace, flags, or shell metacharacters into
  // the user's terminal. Claude also has a small set of legacy non-UUID ids,
  // so keep the accepted alphabet broader than UUID while still shell-safe.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) return null;
  if (source === "claude") return `claude --resume ${id}`;
  if (source === "codex") return `codex resume ${id}`;
  // Grok Build: `grok --resume <session-id>` (also accepts a title). The
  // command must still be run from the session's project_ref cwd.
  if (source === "grok") return `grok --resume ${id}`;
  return null;
}

function toSessionBrowserRow(row) {
  const tokens = row.tokens && typeof row.tokens === "object" ? row.tokens : {};
  return {
    session_hash: row.session_hash,
    session_id: row.session_id || null,
    parent_session_id: row.parent_session_id || null,
    parent_session_hash: row.parent_session_hash || null,
    root_session_hash: row.root_session_hash || row.session_hash,
    thread_kind: row.parent_session_id ? "subagent" : "root",
    agent_nickname: row.agent_nickname || null,
    agent_role: row.agent_role || null,
    orphaned_subagent: Boolean(row.orphaned_subagent),
    parent_link_conflict: Boolean(row.parent_link_conflict),
    title: row.title || null,
    source: row.source,
    project_key: row.project_key,
    // project_ref (the local cwd) only ever travels over the local API so the
    // browser can show where a session ran and compose a resume command.
    project_ref: row.project_ref || null,
    model: row.model,
    model_usage: modelUsageForAggregation(row),
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    duration_ms: finite(row.duration_ms),
    turns: finite(row.turns),
    edit_turns: finite(row.edit_turns),
    retry_turns: finite(row.retry_turns),
    subagent_calls: finite(row.subagent_calls),
    input_tokens: finite(tokens.input_tokens),
    cached_input_tokens: finite(tokens.cached_input_tokens),
    cache_creation_input_tokens: finite(tokens.cache_creation_input_tokens),
    output_tokens: finite(tokens.output_tokens),
    reasoning_output_tokens: finite(tokens.reasoning_output_tokens),
    direct_subagent_count: finite(row.direct_subagent_count),
    descendant_subagent_count: finite(row.descendant_subagent_count),
    own_total_tokens: finite(row.total_tokens),
    subagent_total_tokens: finite(row.subagent_total_tokens),
    combined_total_tokens: finite(row.combined_total_tokens || row.total_tokens),
    total_tokens: finite(row.total_tokens),
    own_cost_usd: finite(row.cost_usd),
    subagent_cost_usd: finite(row.subagent_cost_usd),
    combined_cost_usd: finite(row.combined_cost_usd || row.cost_usd),
    cost_usd: finite(row.cost_usd),
    cost_source: row.cost_source || null,
    usage_precision: row.usage_precision || null,
    usage_is_incomplete: Boolean(row.usage_is_incomplete),
    cost_is_partial: Boolean(row.cost_is_partial),
    usage_events: finite(row.usage_events),
    model_calls: finite(row.model_calls),
    api_duration_ms: finite(row.api_duration_ms),
    context_tokens_used: finite(row.context_tokens_used),
    context_window_tokens: finite(row.context_window_tokens),
    context_usage_percent: finite(row.context_usage_percent),
    tool_calls: finite(row.tool_calls),
    tool_failures: finite(row.tool_failures),
    error_count: finite(row.error_count),
    compaction_count: finite(row.compaction_count),
    productive: Boolean(row.productive),
    first_pass: Boolean(row.first_pass ?? row.one_shot),
    resume_command: resumeCommandFor(row.source, row.session_id),
  };
}

// Claude writes several on-disk files for one logical session (resumes and
// sub-agent sidechains) that all carry the same session id, so scanning yields
// multiple rows sharing an identical session_hash. Merge those fragments into
// one resumable session for the browser: sum the (non-overlapping) per-file
// token/turn counts, span the timestamps, and keep the agent-authored title.
// This also gives the UI a stable, unique key per row.
function mergeSessionFragments(rows) {
  const byHash = new Map();
  for (const row of rows || []) {
    const key = row.session_hash;
    const cur = byHash.get(key);
    if (!cur) {
      byHash.set(key, {
        ...row,
        tokens: row.tokens && typeof row.tokens === "object" ? { ...row.tokens } : emptyTotals(),
        model_usage: normalizeModelUsageRows(row.model_usage),
        _repr_tokens: finite(row.total_tokens),
      });
      continue;
    }
    cur.turns = finite(cur.turns) + finite(row.turns);
    cur.edit_turns = finite(cur.edit_turns) + finite(row.edit_turns);
    cur.retry_turns = finite(cur.retry_turns) + finite(row.retry_turns);
    cur.subagent_calls = finite(cur.subagent_calls) + finite(row.subagent_calls);
    addTotals(cur.tokens, row.tokens);
    cur.model_usage = normalizeModelUsageRows([
      ...(cur.model_usage || []),
      ...(row.model_usage || []),
    ]);
    cur.total_tokens = finite(cur.total_tokens) + finite(row.total_tokens);
    cur.cost_usd = finite(cur.cost_usd) + finite(row.cost_usd);
    cur.provider_cost_usd = finite(cur.provider_cost_usd) + finite(row.provider_cost_usd);
    cur.usage_events = finite(cur.usage_events) + finite(row.usage_events);
    cur.model_calls = finite(cur.model_calls) + finite(row.model_calls);
    cur.api_duration_ms = finite(cur.api_duration_ms) + finite(row.api_duration_ms);
    cur.tool_calls = finite(cur.tool_calls) + finite(row.tool_calls);
    cur.tool_failures = finite(cur.tool_failures) + finite(row.tool_failures);
    cur.error_count = finite(cur.error_count) + finite(row.error_count);
    cur.compaction_count = finite(cur.compaction_count) + finite(row.compaction_count);
    cur.context_tokens_used = Math.max(finite(cur.context_tokens_used), finite(row.context_tokens_used));
    cur.context_window_tokens = Math.max(finite(cur.context_window_tokens), finite(row.context_window_tokens));
    cur.context_usage_percent = Math.max(finite(cur.context_usage_percent), finite(row.context_usage_percent));
    cur.usage_is_incomplete = Boolean(cur.usage_is_incomplete) || Boolean(row.usage_is_incomplete);
    cur.cost_is_partial = Boolean(cur.cost_is_partial) || Boolean(row.cost_is_partial);
    if (cur.usage_precision !== row.usage_precision) cur.usage_precision = "mixed";
    if (cur.cost_source !== row.cost_source) cur.cost_source = "mixed";
    cur.productive = Boolean(cur.productive) || Boolean(row.productive);
    cur.active_ms = finite(cur.active_ms) + finite(row.active_ms);
    if (!cur.title && row.title) cur.title = row.title;
    if (!cur.parent_session_id && row.parent_session_id) cur.parent_session_id = row.parent_session_id;
    if (cur.parent_session_id && row.parent_session_id && cur.parent_session_id !== row.parent_session_id) {
      cur.parent_session_id = null;
      cur.parent_link_conflict = true;
    }
    if (!cur.forked_from_id && row.forked_from_id) cur.forked_from_id = row.forked_from_id;
    if (!cur.agent_nickname && row.agent_nickname) cur.agent_nickname = row.agent_nickname;
    if (!cur.agent_role && row.agent_role) cur.agent_role = row.agent_role;
    // Legacy records (including Claude) have no per-model usage, so retain
    // their busiest-fragment model as a display label. Codex model_usage is
    // merged independently and overrides this representative during repricing.
    if (finite(row.total_tokens) > finite(cur._repr_tokens)) {
      cur._repr_tokens = finite(row.total_tokens);
      if (row.model && row.model !== "unknown") cur.model = row.model;
      // Project needs its own guard: a subagent running in a git worktree has
      // that throwaway directory as its cwd, so the busiest fragment can label
      // the whole session with a temp name like "agent-a3cb8089a11d3471a" and
      // point project_ref at a directory that no longer exists. Only let a
      // worktree fragment name the session when nothing better is available.
      if (!isWorktreeRef(row.project_ref) || isWorktreeRef(cur.project_ref)) {
        cur.project_key = row.project_key;
        cur.project_ref = row.project_ref;
      }
    }
    if (row.started_at && (!cur.started_at || row.started_at < cur.started_at)) cur.started_at = row.started_at;
    if (row.ended_at && (!cur.ended_at || row.ended_at > cur.ended_at)) cur.ended_at = row.ended_at;
  }
  const merged = [];
  for (const row of byHash.values()) {
    delete row._repr_tokens;
    // Active time is additive across fragments (see IDLE_GAP_MS); the
    // wall-clock span between first and last line is not.
    row.duration_ms = finite(row.active_ms);
    row.first_pass = finite(row.edit_turns) === 1 && finite(row.retry_turns) === 0;
    row.one_shot = row.first_pass;
    // Only a complete per-model breakdown can reprice merged usage safely.
    // Claude fragments may use different models: their summed cost is exact,
    // while charging all tokens at the representative model changes that sum.
    if (row.model_usage.length > 0) repriceSessionRecord(row);
    else row.cost_per_edit = row.edit_turns > 0 ? finite(row.cost_usd) / row.edit_turns : null;
    merged.push(row);
  }
  return merged;
}

// Attach exact Codex parent/child usage without changing the authoritative
// per-session total_tokens field. Combined fields are derived views only, so
// summing total_tokens across all rows still equals the global usage ledger.
function annotateCodexThreadUsage(rows) {
  const byId = new Map();
  const childrenById = new Map();
  const linkedParentById = new Map();

  for (const row of rows || []) {
    if (row?.source !== "codex" || typeof row.session_id !== "string" || !row.session_id) continue;
    const existing = byId.get(row.session_id);
    if (existing && existing !== row) {
      existing.parent_link_conflict = true;
      row.parent_link_conflict = true;
      continue;
    }
    byId.set(row.session_id, row);
  }

  function hasParentCycle(start) {
    const seen = new Set();
    let current = start;
    while (current?.parent_session_id && byId.has(current.parent_session_id)) {
      if (seen.has(current.session_id) || current.parent_session_id === current.session_id) return true;
      seen.add(current.session_id);
      current = byId.get(current.parent_session_id);
    }
    return false;
  }

  for (const row of byId.values()) {
    const parentId = typeof row.parent_session_id === "string" ? row.parent_session_id.trim() : "";
    if (!parentId) continue;
    if (row.parent_link_conflict || hasParentCycle(row)) {
      row.parent_link_conflict = true;
      continue;
    }
    if (!byId.has(parentId)) {
      row.orphaned_subagent = true;
      continue;
    }
    const children = childrenById.get(parentId) || [];
    children.push(row);
    childrenById.set(parentId, children);
    linkedParentById.set(row.session_id, parentId);
  }

  const memo = new Map();
  function aggregate(row, visiting = new Set()) {
    if (memo.has(row.session_id)) return memo.get(row.session_id);
    if (visiting.has(row.session_id)) {
      row.parent_link_conflict = true;
      return { count: 0, tokens: 0, cost: 0 };
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(row.session_id);
    let count = 0;
    let tokens = 0;
    let cost = 0;
    for (const child of childrenById.get(row.session_id) || []) {
      const nested = aggregate(child, nextVisiting);
      count += 1 + nested.count;
      tokens += finite(child.total_tokens) + nested.tokens;
      cost += finite(child.cost_usd) + nested.cost;
    }
    const result = { count, tokens, cost };
    memo.set(row.session_id, result);
    return result;
  }

  function rootFor(row) {
    const seen = new Set([row.session_id]);
    let current = row;
    while (current && linkedParentById.has(current.session_id)) {
      const linkedParentId = linkedParentById.get(current.session_id);
      if (seen.has(linkedParentId)) {
        row.parent_link_conflict = true;
        break;
      }
      seen.add(linkedParentId);
      current = byId.get(linkedParentId);
    }
    return current || row;
  }

  for (const row of rows || []) {
    row.own_total_tokens = finite(row.total_tokens);
    row.own_cost_usd = finite(row.cost_usd);
    row.direct_subagent_count = row.source === "codex" && row.session_id
      ? (childrenById.get(row.session_id) || []).length
      : 0;
    const nested = row.source === "codex" && row.session_id
      ? aggregate(row)
      : { count: 0, tokens: 0, cost: 0 };
    row.descendant_subagent_count = nested.count;
    row.subagent_total_tokens = nested.tokens;
    row.subagent_cost_usd = nested.cost;
    row.combined_total_tokens = finite(row.total_tokens) + nested.tokens;
    row.combined_cost_usd = finite(row.cost_usd) + nested.cost;
    if (row.source === "codex" && row.session_id) {
      const parent = byId.get(linkedParentById.get(row.session_id));
      row.parent_session_hash = parent?.session_hash || null;
      row.root_session_hash = rootFor(row).session_hash || row.session_hash;
    }
  }
  return rows;
}

// Local-only session list for the dashboard session browser. Unlike
// summarizeSessions (cloud/CSV safe), this retains session_id + project_ref so
// the UI can offer one-click resume. Callers must only expose it over the
// local API.
function listSessionsForBrowser(sessions, { from = "", to = "", limit = 0 } = {}) {
  const filtered = annotateCodexThreadUsage(mergeSessionFragments(sessions)
    // Only sessions that actually spent tokens are worth listing. This drops
    // two kinds of noise: non-session logs under ~/.claude/projects
    // (skill-injections.jsonl, journal.jsonl, …), and sessions abandoned before
    // the model replied. Both render as "unknown · 0 tokens · $0.00" rows with
    // no model, no cost and nothing to analyze.
    .filter((row) => finite(row.total_tokens) > 0)
    .filter((row) => withinDayRange(row, from, to)));
  filtered.sort((a, b) => String(b.ended_at || "").localeCompare(String(a.ended_at || "")));
  const cap = Number(limit) > 0 ? Number(limit) : 0;
  const limited = cap > 0 ? filtered.slice(0, cap) : filtered;
  return {
    available: filtered.length > 0,
    session_count: filtered.length,
    returned_count: limited.length,
    skipped_files: finite(sessions?.skippedFiles),
    sessions: limited.map(toSessionBrowserRow),
    provenance: {
      source: "local-session-log",
      confidence: "observed",
      privacy: "metadata-only",
      scope: "local-only",
    },
  };
}

function sessionsToCsv(rows) {
  const columns = ["session_hash", "source", "project_key", "model", "model_usage_json", "started_at", "ended_at", "duration_ms", "turns", "edit_turns", "retry_turns", "subagent_calls", "total_tokens", "cost_usd", "productive", "first_pass", "one_shot"];
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const valueFor = (row, key) => key === "model_usage_json"
    ? JSON.stringify(row.model_usage || [])
    : row[key];
  return [columns.join(","), ...(rows || []).map((row) => columns.map((key) => escape(valueFor(row, key))).join(","))].join("\n") + "\n";
}

module.exports = {
  resolveSessionSidecarPath,
  sessionHash,
  scanClaudeSession,
  scanCodexSession,
  scanGrokSession,
  buildSessionAnalytics,
  summarizeSessions,
  listSessionsForBrowser,
  resumeCommandFor,
  sessionsToCsv,
  providerRoots,
  dedupeClaudeFilesAcrossRoots,
  analyticsEntryStatKey,
};
