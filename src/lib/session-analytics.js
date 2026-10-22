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
const { listClaudeProjectFiles, listRolloutFilesDeep, claudeMessageDedupKey, normalizeClaudeUsage, readZcodeDbMessages, coerceEpochMs, resolveZcodeInstallPaths, normalizeOpencodeModelFields, normalizeOpencodeTokens, deriveOpencodeMessageFingerprint } = require("./rollout");
const { parseCodexRolloutFile } = require("./codex-rollout-parser");
const { computeRowCost, getModelPricingInfo } = require("./pricing");
const { normalizePerformance, mergePerformance, createClaudePerformanceCollector, createCodexPerformanceCollector, createZcodePerformanceCollector } = require("./session-performance");
const { readSqliteJsonRows, readSqliteJsonRowsAsync } = require("./sqlite-reader");
const { resolveZcodeNativeDbPath, resolveInstallPaths } = require("./install-resolver");
const { readCursorStateSummary } = require("./cursor-store");
const { USD_TICKS_PER_USD, normalizeGrokUsage } = require("./grok-usage");
const wsl = require("./wsl-probe");
const { discoverKimiWireFiles, kimiSessionDependencies, readKimiSessions } = require("./kimi-session");
const {
  appendUniqueDirs,
  dedupeDirsByRealpath,
  expandHome,
  loadScanRootsConfig,
  normalizeScanRootsConfig,
  scanRootDirState,
} = require("./scan-roots");

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
// v14 adds request-level estimated performance and Claude model usage.
// v15/v16 tighten Codex delivery-signal parsing (uncommented bump).
// v17 adds ZCode sessions from ~/.zcode/cli/db/db.sqlite — one SQLite db
// scanning to many per-session rows — so every cached row is rebuilt.
// v18 corrects ZCode project keys and request timestamp units, and invalidates
// inventories that earlier builds may have cached after a failed database read.
// v19 scans both ZCode installs as one deduplicated inventory and separates
// provider retries from repeated user requests.
// v20 also invalidates unchanged-stat caches after an observed database lock.
// v21 retains the request count when several ZCode events share a minute.
// v22 adds metadata-only OpenCode database sessions.
// v23 excludes database updates and user records from request durations.
// v24 keeps OpenCode usage dates at event time and fork history on its ancestor.
// v25 adds Kimi wire sessions, including official/legacy migration dedup.
// v26 retains Codex Ultrafast (service_tier ultrafast) subset columns so
// date-filtered session views and cached sidecars keep the 6x premium.
const SIDECAR_VERSION = 26;
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
  for (const key of MODEL_USAGE_SUM_FIELDS) {
    if (!/^(?:long_context_|priority_|ultrafast_)|^(?:usage_events|rerouted_usage_events|long_context_usage_events|priority_usage_events|ultrafast_usage_events)$/.test(key)) continue;
    if (delta?.[key]) target[key] = finite(target[key]) + finite(delta[key]);
  }
}

function emptyTotals() {
  return tokenTotals({});
}

function mergeUsageMetadata(target, usage) {
  for (const field of ["selected_models", "reroute_reasons"]) {
    if (Array.isArray(usage[field])) target[field] = [...new Set([...(target[field] || []), ...usage[field]])];
  }
  if (usage.model_attribution === "effective") target.model_attribution = "effective";
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
  "ultrafast_input_tokens",
  "ultrafast_cached_input_tokens",
  "ultrafast_cache_creation_input_tokens",
  "ultrafast_output_tokens",
  "ultrafast_reasoning_output_tokens",
  "ultrafast_long_context_input_tokens",
  "ultrafast_long_context_cached_input_tokens",
  "ultrafast_long_context_cache_creation_input_tokens",
  "ultrafast_long_context_output_tokens",
  "ultrafast_long_context_reasoning_output_tokens",
  "usage_events",
  "rerouted_usage_events",
  "long_context_usage_events",
  "priority_usage_events",
  "ultrafast_usage_events",
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
        performance: normalizePerformance(),
      };
      byModel.set(model, row);
    }
    for (const field of MODEL_USAGE_SUM_FIELDS) row[field] += finite(value?.[field]);
    row.performance = mergePerformance(row.performance, value?.performance);
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
    .filter((row) => ["total_tokens", "input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens"]
      .some((field) => row[field] > 0))
    .map((row) => ({
      ...row,
      selected_models: [...row.selected_models].sort(),
      reroute_reasons: [...row.reroute_reasons].sort(),
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model));
}

// The sidecar is re-read on every dashboard request, so keep it small: omit
// the model_usage fields that normalizeModelUsageRows() reconstructs on read.
// These omissions are lossless - zero counters default to 0, an absent
// selected_models re-seeds from `model`, model_attribution is derived from
// rerouted_usage_events, and cost_usd/pricing are always recomputed by
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
  if (row.performance?.estimated_request_count || row.performance?.first_response_sample_count) out.performance = row.performance;
  return out;
}

function serializeSessionRecord(row) {
  if (!Array.isArray(row?.model_usage) || row.model_usage.length === 0) {
    return JSON.stringify(row);
  }
  return JSON.stringify({ ...row, model_usage: row.model_usage.map(serializeModelUsageRow) });
}

function repriceSessionRecord(record) {
  if (Array.isArray(record.usage_buckets)) {
    record.usage_buckets = record.usage_buckets.map((bucket) => ({
      ...bucket, cost_usd: computeRowCost({ source: record.source, ...bucket }),
    }));
  }
  const modelUsage = normalizeModelUsageRows(record?.model_usage);
  if (modelUsage.length > 0) {
    let hasUnpricedUsage = false;
    for (const row of modelUsage) {
      row.cost_usd = computeRowCost({ source: record.source, ...row });
      row.pricing = getModelPricingInfo(row.model, { source: record.source });
      if (row.total_tokens > 0 && row.pricing.status === "unpriced") hasUnpricedUsage = true;
    }
    record.model_usage = modelUsage;
    record.model = modelUsage.length > 1 ? "mixed" : modelUsage[0].model;
    if (record.cost_source === "provider_reported" && Number.isFinite(Number(record.provider_cost_usd)) && Number(record.provider_cost_usd) >= 0) {
      record.cost_usd = Number(record.provider_cost_usd);
      if (modelUsage.length === 1) modelUsage[0].cost_usd = record.cost_usd;
    } else {
      record.cost_usd = modelUsage.reduce((sum, row) => sum + finite(row.cost_usd), 0);
      record.cost_source = "model_pricing";
      record.cost_is_partial = hasUnpricedUsage;
    }
    // Internal labels such as `codex-auto-review` expose token usage but not
    // an underlying public model/rate. Keep their tokens, leave their cost at
    // zero, and explicitly mark the session estimate as a known lower bound.
  } else {
    const providerCost = Number(record.provider_cost_usd);
    record.cost_usd = record.cost_source === "provider_reported"
      && Number.isFinite(providerCost)
      && providerCost >= 0
      ? providerCost
      : computeRowCost({ source: record.source, model: record.model, ...record.tokens });
    if (record.cost_source !== "provider_reported" && finite(record.total_tokens || record.tokens?.total_tokens) > 0
      && getModelPricingInfo(record.model, { source: record.source }).status === "unpriced") record.cost_is_partial = true;
  }
  record.cost_per_edit = record.edit_turns > 0 ? record.cost_usd / record.edit_turns : null;
  return record;
}

// The model_usage wire contract is DENSE: every field dashboard/src/lib/
// sessions-api.ts declares is present on every row. Storage is free to be
// sparse - serializeModelUsageRow() drops zero counters, and a record with no
// model_usage at all (Grok sessions and sessions written
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
    performance: normalizePerformance(),
    ...overrides,
  };
}

function modelUsageForAggregation(record) {
  const editTurns = finite(record?.edit_turns);
  const rows = normalizeModelUsageRows(record?.model_usage);
  if (rows.length === 0) {
    return [denseModelUsageRow({
      model: normalizeSessionModel(record?.model) || "unknown",
      ...record?.tokens,
      total_tokens: finite(record?.total_tokens || record?.tokens?.total_tokens),
      cost_usd: finite(record?.cost_usd),
      edit_turns: editTurns,
      performance: normalizePerformance(record?.performance),
      pricing: getModelPricingInfo(record?.model, { source: record?.source }),
    })];
  }
  const priced = rows.map((row) => denseModelUsageRow({
    ...row,
    pricing: getModelPricingInfo(row.model, { source: record.source }),
    cost_usd: Number.isFinite(Number(row.cost_usd))
      ? Number(row.cost_usd)
      : computeRowCost({ source: record.source, ...row }),
  }));
  if (record.cost_source === "provider_reported" && priced.length === 1) priced[0].cost_usd = finite(record.cost_usd);
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
  record.performance = normalizePerformance(record.performance);
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

function sessionStorageUsage(filePaths) {
  let bytes = 0;
  const allocated = process.platform !== "win32";
  for (const file of new Set(filePaths)) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      bytes += allocated && Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
    } catch { /* deleted or unreadable while scanning */ }
  }
  return { session_store_bytes: bytes, session_store_metric: allocated ? "allocated" : "logical" };
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
  const performanceCollector = createClaudePerformanceCollector();
  const modelUsageByModel = new Map();
  const editTurnsByModel = new Map();
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
  let currentTurnModel = null;
  let subagentCalls = 0;
  const subagentTypes = new Map();

  function closeTurn() {
    if (currentHadEdit) {
      editTurns += 1;
      const key = currentTurnModel || "unknown";
      editTurnsByModel.set(key, (editTurnsByModel.get(key) || 0) + 1);
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
        const timingKey = claudeMessageDedupKey(obj);
        const countedUsage = obj.type === "assistant" && obj.message && (!timingKey || !seenMessages.has(timingKey))
          ? normalizeClaudeUsage(obj.message.usage) : null;
        performanceCollector.consume(obj, timingKey, countedUsage, normalizeSessionModel(obj.message?.model) || model);
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
        currentTurnModel = model;
        const usage = normalizeClaudeUsage(obj.message.usage);
        addTotals(tokens, usage);
        if (usage.total_tokens > 0) {
          const modelUsage = modelUsageByModel.get(model) || { model, ...emptyTotals(), usage_events: 0 };
          addTotals(modelUsage, usage);
          modelUsage.usage_events += 1;
          modelUsageByModel.set(model, modelUsage);
        }
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
  const performance = performanceCollector.finish();
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
    ...sessionStorageUsage(filePaths),
    project_key: projectKey(cwd, primaryFilePath),
    project_ref: cwd || null,
    model,
    model_usage: [...modelUsageByModel.values()].map((row) => ({
      ...row,
      edit_turns: finite(editTurnsByModel.get(row.model)),
      performance: performance.byModel.get(row.model) || normalizePerformance(),
    })),
    performance: performance.performance,
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
  const performanceCollector = createCodexPerformanceCollector();
  const usageBuckets = new Map();
  const parsed = await parseCodexRolloutFile(filePaths, {
    seenTokenEvents: new Set(),
    collectBreakdowns: false,
    collectModelUsage: true,
    onObject(obj, model) {
      signalCollector.consume(obj, model);
      performanceCollector.consume(obj, model);
    },
    onUsage(event) {
      if (event.origin !== "compaction") performanceCollector.consumeUsage(event);
      if (!event.delta || event.delta.total_tokens <= 0) return;
      const ms = Date.parse(event.timestamp);
      if (!Number.isFinite(ms)) return;
      // Minute buckets preserve every current IANA local-midnight boundary
      // and every integer tz_offset_minutes accepted by the local API.
      const timestamp = new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
      const key = `${timestamp}\u0000${event.model}`;
      const bucket = usageBuckets.get(key) || { timestamp, model: event.model || "unknown", ...emptyTotals() };
      addTotals(bucket, event.delta);
      mergeUsageMetadata(bucket, event.delta);
      usageBuckets.set(key, bucket);
    },
  });
  const signals = signalCollector.finish();
  const performance = performanceCollector.finish();
  // The collector keyed edit turns by the model the parser handed it, so the
  // keys are the same raw model ids parsed.modelUsage rows carry. A model whose
  // edit turns produced no billable delta has no row to land on;
  // modelUsageForAggregation() folds that residual into the busiest model so
  // the by_model column still sums to edit_turns.
  const editTurnsByModel = signals.editTurnsByModel || {};
  const modelUsage = (parsed.modelUsage || []).map((row) => ({
    ...row,
    edit_turns: finite(editTurnsByModel[row.model]),
    performance: performance.byModel.get(row.model) || normalizePerformance(),
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
    ...sessionStorageUsage(filePaths),
    project_key: projectKey(parsed.cwd, primaryFilePath),
    project_ref: parsed.cwd || null,
    model,
    model_usage: modelUsage,
    usage_buckets: [...usageBuckets.values()],
    performance: performance.performance,
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
    ...sessionStorageUsage([filePath, grokSummaryPathFor(filePath), grokSignalsPathFor(filePath)]),
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

// Project and title metadata stay local. SQL projects only numeric usage and
// identity fields; user/assistant bodies and tool arguments never enter JS.
async function readOpencodeSessionInputs(dbPath) {
  const options = { label: "OpenCode", timeout: 30_000, maxBuffer: 50 * 1024 * 1024, readOnly: true, throwOnReadFailure: true };
  const query = (sql) => readSqliteJsonRowsAsync(dbPath, sql, options);
  const tables = new Set((await query("SELECT name FROM sqlite_master WHERE name IN ('session','session_v2','message','session_message')")).map((row) => row.name));
  const sessionRows = [];
  for (const table of ["session_v2", "session"]) {
    if (!tables.has(table)) continue;
    const columns = new Set((await query(`SELECT name FROM pragma_table_info('${table}')`)).map((row) => row.name));
    if (!columns.has("id")) continue;
    const selected = ["id", "parent_id", "directory", "title", "time_created", "time_updated"].filter((column) => columns.has(column));
    sessionRows.push(...await query(`SELECT ${selected.join(", ")} FROM ${table} ORDER BY id ASC`));
  }
  const messages = [];
  for (const table of ["message", "session_message"]) {
    if (!tables.has(table)) continue;
    const role = table === "session_message" ? "type" : "json_extract(data, '$.role')";
    messages.push(...await query(`SELECT id, session_id, time_created, time_updated, ${role} AS role,
      CASE WHEN ${role} = 'assistant' THEN json_object(
        'tokens', json_extract(data, '$.tokens'),
        'modelID', json_extract(data, '$.modelID'),
        'providerID', json_extract(data, '$.providerID'),
        'model', json_extract(data, '$.model'),
        'time', json_extract(data, '$.time'),
        'path', json_object('cwd', json_extract(data, '$.path.cwd'))
      ) END AS metadata
      FROM ${table} WHERE ${role} IN ('user', 'assistant') ORDER BY time_created ASC, id ASC`));
  }
  return { sessionRows, messages };
}

async function scanOpencodeSessions(dbPaths) {
  const paths = [...new Set((Array.isArray(dbPaths) ? dbPaths : [dbPaths]).filter(Boolean))];
  const snapshots = [];
  const inputs = [];
  try {
    for (const dbPath of paths) {
      let effectivePath = dbPath;
      if (wsl.isUncPath(dbPath)) {
        try {
          const snapshot = wsl.snapshotSqliteDb(dbPath);
          snapshots.push(snapshot);
          effectivePath = snapshot.path;
        } catch { /* Direct read determines whether this mount supports SQLite. */ }
      }
      inputs.push(await readOpencodeSessionInputs(effectivePath));
    }
    const sessionRows = new Map();
    const messages = new Map();
    for (const input of inputs) {
      for (const row of input.sessionRows) if (!sessionRows.has(row.id)) sessionRows.set(row.id, row);
      for (const row of input.messages) {
        const key = `${row.session_id}\0${row.id}`;
        const previous = messages.get(key);
        if (!previous || Number(row.time_updated) >= Number(previous.time_updated)) messages.set(key, row);
      }
    }
    const groups = new Map();
    const ancestors = new Map();
    const ancestorsOf = (id) => {
      if (ancestors.has(id)) return ancestors.get(id);
      const known = [];
      const seen = new Set([id]);
      let current = sessionRows.get(id);
      while (current?.parent_id && sessionRows.has(current.parent_id)) {
        if (seen.has(current.parent_id)) {
          ancestors.set(id, []);
          return [];
        }
        seen.add(current.parent_id);
        known.push(current.parent_id);
        current = sessionRows.get(current.parent_id);
      }
      ancestors.set(id, known);
      return known;
    };
    const sortedMessages = [...messages.values()]
      .sort((a, b) => Number(a.time_created) - Number(b.time_created))
      .map((row) => {
        const data = row.metadata ? JSON.parse(row.metadata) : {};
        const delta = normalizeOpencodeTokens(data.tokens);
        const fingerprint = delta && deriveOpencodeMessageFingerprint({ msg: data, totals: delta, source: "opencode" });
        return { row, data, delta, fingerprint };
      });
    // A fork may sort before its original when message creation times tie.
    // Select a known ancestor before aggregating; unknown/cyclic lineage keeps
    // the existing first-observed owner and never invents a parent connection.
    const owners = new Map();
    for (const { row, fingerprint } of sortedMessages) {
      if (!fingerprint) continue;
      const owner = owners.get(fingerprint);
      if (!owner || ancestorsOf(owner).includes(row.session_id)) owners.set(fingerprint, row.session_id);
    }
    for (const { row, data, delta, fingerprint } of sortedMessages) {
      const sessionId = String(row.session_id || "").trim();
      if (!sessionId) continue;
      let group = groups.get(sessionId);
      if (!group) {
        group = { bounds: emptyBounds(), tokens: emptyTotals(), models: new Map(), buckets: new Map(), spans: [], turns: 0, calls: 0, cwd: null };
        groups.set(sessionId, group);
      }
      if (delta && delta.total_tokens > 0) {
        const owner = fingerprint && owners.get(fingerprint);
        if (owner && owner !== sessionId) continue;
        const model = normalizeSessionModel(normalizeOpencodeModelFields(data).modelId) || "unknown";
        addTotals(group.tokens, delta);
        const usage = group.models.get(model) || { model, ...emptyTotals(), usage_events: 0 };
        addTotals(usage, delta);
        usage.usage_events += 1;
        group.models.set(model, usage);
        group.calls += 1;
        const timestampMs = coerceEpochMs(data.time?.completed) || coerceEpochMs(data.time?.created) || coerceEpochMs(row.time_created);
        if (timestampMs) {
          const timestamp = new Date(Math.floor(timestampMs / 60_000) * 60_000).toISOString();
          const key = `${timestamp}\0${model}`;
          const bucket = group.buckets.get(key) || { timestamp, model, ...emptyTotals(), usage_events: 0 };
          addTotals(bucket, delta);
          bucket.usage_events += 1;
          group.buckets.set(key, bucket);
        }
        if (!group.cwd && typeof data.path?.cwd === "string") group.cwd = data.path.cwd.trim() || null;
      }
      if (row.role === "user") group.turns += 1;
      const start = coerceEpochMs(data.time?.created) || coerceEpochMs(row.time_created);
      // DB time_updated can reflect a migration months after the request.
      // User records are instants; only an explicit assistant completion proves
      // execution time. Incomplete requests contribute their start point alone.
      const completed = row.role === "assistant" ? coerceEpochMs(data.time?.completed) : 0;
      const end = completed >= start ? completed : start;
      if (start) updateBounds(group.bounds, new Date(start).toISOString());
      if (end) updateBounds(group.bounds, new Date(end).toISOString());
      if (start && end >= start) group.spans.push([start, end]);
    }
    const records = [];
    for (const [sessionId, group] of groups) {
      const row = sessionRows.get(sessionId) || {};
      const cwd = typeof row.directory === "string" && row.directory.trim() ? row.directory.trim() : group.cwd;
      const modelUsage = [...group.models.values()];
      let activeMs = 0;
      let interval = null;
      for (const span of group.spans.sort((a, b) => a[0] - b[0])) {
        if (!interval) interval = [...span];
        else if (span[0] <= interval[1] + IDLE_GAP_MS) interval[1] = Math.max(interval[1], span[1]);
        else { activeMs += interval[1] - interval[0]; interval = [...span]; }
      }
      if (interval) activeMs += interval[1] - interval[0];
      records.push(finalizeRecord({
        version: SIDECAR_VERSION,
        session_hash: sessionHash("opencode", sessionId), session_id: sessionId,
        parent_session_id: typeof row.parent_id === "string" && row.parent_id.trim() ? row.parent_id.trim() : null,
        title: cleanSessionTitle(row.title), source: "opencode",
        project_key: projectKey(cwd && cwd.replace(/\\/g, "/"), paths[0]), project_ref: cwd || null,
        model: modelUsage.length > 1 ? "mixed" : (modelUsage[0]?.model || "unknown"),
        model_usage: modelUsage, usage_buckets: [...group.buckets.values()],
        ...group.bounds, active_ms: activeMs, tokens: group.tokens,
        turns: group.turns, edit_turns: 0, retry_turns: 0,
        usage_events: group.calls, model_calls: group.calls,
        usage_precision: group.calls ? "reported" : "unavailable", cost_source: "model_pricing",
        provenance: { source: "local-session-log", confidence: "observed", retry_confidence: "unavailable", content_retained: false, usage: "opencode-db-metadata" },
      }));
    }
    return records;
  } finally {
    for (const snapshot of snapshots) snapshot.cleanup();
  }
}

// ZCode (Z.ai's CLI, an OpenCode fork) keeps everything in one SQLite DB at
// ~/.zcode/cli/db/db.sqlite: a `session` table (id/parent_id/directory/title),
// a `model_usage` table (per-request counters) and OpenCode's legacy `message`
// table (assistant messages with inclusive token snapshots). Billable tokens
// come from readZcodeDbMessages() — the exact same reader, inclusive→disjoint
// normalization and sub-agent provider blocklist the usage sync uses — so the
// session browser and the usage card can never drift apart. The per-request
// signal columns live only in model_usage, so they are read separately and
// feed performance/counter estimates only, never token totals.
function zcodeTableColumns(dbPath, table) {
  // throwOnReadFailure: a missing table answers pragma_table_info with an
  // empty row set (no error), so the only way to land in the reader's failure
  // path is a genuinely unreadable db — which must propagate, never read as
  // "no table" (see the throw in scanZcodeSessions below).
  const rows = readSqliteJsonRows(dbPath, `SELECT name FROM pragma_table_info('${table}')`, {
    label: "ZCode",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    throwOnReadFailure: true,
  });
  return new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.name || "")));
}

// Messages from readZcodeDbMessages already carry disjoint opencode-shaped
// tokens ({ input, output, reasoning, cache.read, cache.write }); map them
// onto the session pipeline's column names. tokenTotals() recomputes the sum.
function zcodeMessageTotals(data) {
  const tokens = data?.tokens || {};
  const totals = tokenTotals({
    input_tokens: tokens.input,
    cached_input_tokens: tokens.cache?.read,
    cache_creation_input_tokens: tokens.cache?.write,
    output_tokens: tokens.output,
    reasoning_output_tokens: tokens.reasoning,
  });
  // The usage queue's total is input + output + cache_creation + cache_read +
  // reasoning_output (rollout.js addTotals); tokenTotals' generic total omits
  // reasoning. ZCode splits reasoning out of output, so fold it back in here or
  // the session browser undercounts every thinking request against the card.
  totals.total_tokens += totals.reasoning_output_tokens;
  return totals;
}

const ZCODE_SIGNAL_REQUIRED_COLUMNS = [
  "session_id", "model_id", "provider_id", "status", "started_at", "id",
  "output_tokens", "duration_ms", "time_to_first_token_ms", "query_source",
];

// One db yields many session rows, so unlike the per-file scanners this scan
// returns an array (the entries loop in buildSessionAnalyticsInternal handles
// both shapes). Errors on the db as a whole propagate: the caller counts the
// file as skipped instead of caching an empty inventory as "no sessions".
//
// WSL dbs arrive as UNC paths (\\wsl$\…), and SQLite over the Plan 9 bridge
// cannot take the locks even a read needs ("database is locked"). The usage
// readers snapshot such paths query-by-query; the scan runs several queries
// plus readZcodeDbMessages against one db, so snapshot once here and run the
// whole scan (metadata, signals, turns, tools, messages) against the local
// copy — otherwise the metadata query succeeds while the message read fails
// on the same database.
async function scanZcodeSessions(dbPaths) {
  const paths = [...new Set((Array.isArray(dbPaths) ? dbPaths : [dbPaths]).filter(Boolean))];
  const snapshots = [];
  const inputs = [];
  try {
    for (const dbPath of paths) {
      let effectiveDbPath = dbPath;
      if (wsl.isUncPath(dbPath)) {
        try {
          const snapshot = wsl.snapshotSqliteDb(dbPath);
          snapshots.push(snapshot);
          effectiveDbPath = snapshot.path;
        } catch (_error) { /* Direct read decides whether this UNC server supports SQLite. */ }
      }
      inputs.push(readZcodeSessionInputs(effectiveDbPath));
    }
    return buildZcodeSessionRecords(inputs, paths[0]);
  } finally {
    for (const snapshot of snapshots) snapshot.cleanup();
  }
}

/** Read metadata and numeric events from one database; real read failures propagate. */
function readZcodeSessionInputs(dbPath) {
  const options = { label: "ZCode", timeout: 30_000, maxBuffer: 50 * 1024 * 1024, readOnly: true, throwOnReadFailure: true };
  const sessionColumns = zcodeTableColumns(dbPath, "session");
  if (!sessionColumns.has("id")) return { sessionRows: [], messages: [], requestRows: [], turnRows: [], toolRows: [] };
  const optionalColumns = ["parent_id", "directory", "title", "time_created", "time_updated"];
  const selectColumns = ["id", ...optionalColumns.filter((name) => sessionColumns.has(name))];
  const orderBy = sessionColumns.has("time_created") ? " ORDER BY time_created ASC, id ASC" : " ORDER BY id ASC";
  const sessionRows = readSqliteJsonRows(
    dbPath,
    `SELECT ${selectColumns.join(", ")} FROM session${orderBy}`,
    options,
  );
  const messages = readZcodeDbMessages(dbPath, { readOnly: true }, { propagateReadFailure: true });
  const modelUsageColumns = zcodeTableColumns(dbPath, "model_usage");
  const requestRows = ZCODE_SIGNAL_REQUIRED_COLUMNS.every((name) => modelUsageColumns.has(name))
    ? readSqliteJsonRows(dbPath, `SELECT id, session_id, model_id, status, started_at, output_tokens, duration_ms, time_to_first_token_ms, query_source
       FROM model_usage
       WHERE status IN ('completed', 'error')
         AND trim(provider_id) != ''
         AND provider_id NOT LIKE '%anthropic%'
         AND provider_id NOT LIKE '%openai%'
         AND provider_id NOT LIKE '%google%'
       ORDER BY started_at ASC, id ASC`, options)
    : [];
  const turnColumns = zcodeTableColumns(dbPath, "turn_usage");
  const turnRows = turnColumns.has("session_id")
    ? readSqliteJsonRows(dbPath, `SELECT session_id${turnColumns.has("turn_id") ? ", turn_id" : ""} FROM turn_usage`, options)
    : [];
  const toolColumns = zcodeTableColumns(dbPath, "tool_usage");
  const toolRows = ["session_id", "tool_name", "turn_id"].every((name) => toolColumns.has(name))
    ? readSqliteJsonRows(dbPath, "SELECT session_id, turn_id, tool_name FROM tool_usage", options)
    : [];
  return { sessionRows, messages, requestRows, turnRows, toolRows };
}

/** Merge only shared event identities, retaining both installs' distinct tails. */
function uniqueZcodeRows(rows, keyFor) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = keyFor(row);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildZcodeSessionRecords(inputs, displayPath) {
  const collect = (key) => inputs.flatMap((input) => input[key] || []);
  const eventKey = (row, sessionKey, idKey) => row?.[sessionKey] && row?.[idKey]
    ? `${row[sessionKey]}\u0000${row[idKey]}` : null;
  const sessionRows = uniqueZcodeRows(collect("sessionRows"), (row) => row?.id);
  const fingerprintOwners = new Map();
  const forkCopies = new Set();
  const messages = uniqueZcodeRows(collect("messages"), (row) => eventKey(row, "sessionID", "id"))
    .filter((message) => {
      // Use the ledger's existing narrow fork-copy contract, including both
      // timestamps, all token columns, model and provider. Never dedup two
      // separate turns within one session by counters alone.
      const fingerprint = deriveOpencodeMessageFingerprint({
        msg: message.data, totals: zcodeMessageTotals(message.data), source: "zcode",
      });
      const owner = fingerprint && fingerprintOwners.get(fingerprint);
      if (owner && owner !== message.sessionID) {
        forkCopies.add(eventKey(message, "sessionID", "id"));
        return false;
      }
      if (fingerprint) fingerprintOwners.set(fingerprint, message.sessionID);
      return true;
    });
  const requestRows = uniqueZcodeRows(collect("requestRows"), (row) => eventKey(row, "session_id", "id"))
    .filter((row) => !forkCopies.has(eventKey(row, "session_id", "id")));
  const turnRows = uniqueZcodeRows(collect("turnRows"), (row) => eventKey(row, "session_id", "turn_id"));
  const toolRows = collect("toolRows");

  const messagesBySession = new Map();
  // propagateReadFailure: a failed native-usage query must abort the scan (the
  // caller counts the db as skipped) rather than silently degrade to the
  // legacy tables and cache a zero-token inventory for those sessions.
  for (const message of messages) {
    const sessionId = String(message?.sessionID || "").trim();
    if (!sessionId) continue;
    let group = messagesBySession.get(sessionId);
    if (!group) {
      group = [];
      messagesBySession.set(sessionId, group);
    }
    group.push(message);
  }

  // Request-level signals (never token totals). Only completed requests feed
  // duration-based estimates; error rows count toward error_count alone. The
  // provider filter mirrors isZcodeNativeMessage's blocklist (see rollout.js):
  // rows ZCode orchestrated through claude/codex/gemini sub-agents already
  // appear as their own provider's sessions and must not skew signals either.
  const signalsBySession = new Map();
  for (const row of requestRows) {
    const sessionId = String(row?.session_id || "").trim();
    if (!sessionId) continue;
    let signals = signalsBySession.get(sessionId);
    if (!signals) {
      signals = {
        collector: createZcodePerformanceCollector(),
        apiDurationMs: 0,
        compactionCount: 0,
        errorCount: 0,
        // Request wall-clock extremes from model_usage. Messages only carry
        // startedAt (the reader maps it to timeUpdated), so without these the
        // last generation's duration never reaches ended_at and a session's
        // final request reports a zero-length span.
        firstRequestIso: null,
        lastRequestEndIso: null,
        // [startMs, endMs] per request for the active-time union below.
        activeSpans: [],
      };
      signalsBySession.set(sessionId, signals);
    }
    // Match readZcodeNativeUsageMessages: databases may store epoch seconds
    // or milliseconds, but request spans and message bounds must share units.
    const requestStartMs = coerceEpochMs(row?.started_at);
    if (requestStartMs > 0) {
      const startIso = new Date(requestStartMs).toISOString();
      if (!signals.firstRequestIso || startIso < signals.firstRequestIso) signals.firstRequestIso = startIso;
      // duration_ms only exists on completed rows; an error request still
      // occupied its start instant, so its end falls back to the start.
      const durationMs = row.status === "completed" ? finite(row.duration_ms) : 0;
      const endIso = new Date(requestStartMs + durationMs).toISOString();
      if (!signals.lastRequestEndIso || endIso > signals.lastRequestEndIso) signals.lastRequestEndIso = endIso;
      signals.activeSpans.push([requestStartMs, requestStartMs + durationMs]);
    }
    if (row.status === "error") {
      signals.errorCount += 1;
      continue;
    }
    if (row.query_source === "compact") signals.compactionCount += 1;
    signals.apiDurationMs += finite(row.duration_ms);
    signals.collector.consumeUsage({
      model: normalizeSessionModel(row.model_id) || "unknown",
      outputTokens: finite(row.output_tokens),
      durationMs: finite(row.duration_ms),
      timeToFirstTokenMs: typeof row.time_to_first_token_ms === "number" ? row.time_to_first_token_ms : undefined,
    });
  }
  const turnsBySession = new Map();
  for (const row of turnRows) {
    const sessionId = String(row?.session_id || "").trim();
    if (!sessionId) continue;
    turnsBySession.set(sessionId, (turnsBySession.get(sessionId) || 0) + 1);
  }

  // ZCode writes Capitalized tool names (Edit/Write); EDIT_TOOLS is lowercase.
  // An edit turn is a turn that used an edit tool, matching the Grok definition.
  const editTurnsBySession = new Map();
  const editTurnIds = new Map();
  for (const row of toolRows) {
    if (!EDIT_TOOLS.has(String(row?.tool_name || "").toLowerCase())) continue;
    const sessionId = String(row?.session_id || "").trim();
    const turnId = String(row?.turn_id || "").trim();
    if (!sessionId || !turnId) continue;
    let turns = editTurnIds.get(sessionId);
    if (!turns) {
      turns = new Set();
      editTurnIds.set(sessionId, turns);
    }
    turns.add(turnId);
  }
  for (const [sessionId, turns] of editTurnIds) editTurnsBySession.set(sessionId, turns.size);

  const records = [];
  for (const row of Array.isArray(sessionRows) ? sessionRows : []) {
    const sessionId = String(row?.id || "").trim();
    if (!sessionId) continue;
    const messages = messagesBySession.get(sessionId) || [];
    const tokens = emptyTotals();
    const modelUsageByModel = new Map();
    const bounds = emptyBounds();
    const usageBuckets = new Map();
    const messagePoints = [];
    let messageCwd = null;
    for (const message of messages) {
      const data = message?.data || {};
      // OpenCode v1 messages carry a flat modelID; v2 (session_message era)
      // nests it as model.id, and some forks wrote model as a plain string.
      // Resolve every shape through the shared normalizer so by-model
      // attribution and pricing match the usage sync on v2-layout databases.
      const model = normalizeSessionModel(normalizeOpencodeModelFields(data).modelId) || "unknown";
      const delta = zcodeMessageTotals(data);
      addTotals(tokens, delta);
      let usage = modelUsageByModel.get(model);
      if (!usage) {
        usage = { model, ...emptyTotals(), usage_events: 0 };
        modelUsageByModel.set(model, usage);
      }
      addTotals(usage, delta);
      usage.usage_events += 1;
      // Message timestamps are epoch-ms integers; updateBounds() only accepts
      // ISO strings and silently drops anything else.
      const timeUpdated = Number(message?.timeUpdated);
      if (Number.isFinite(timeUpdated) && timeUpdated > 0) {
        updateBounds(bounds, new Date(timeUpdated).toISOString());
        messagePoints.push(timeUpdated);
        // Minute buckets (same shape as the Codex scanner's) feed the from/to
        // day filter in scopeSessionUsage; without them a multi-day session
        // bills its whole lifetime to every day it touches.
        const timestamp = new Date(Math.floor(timeUpdated / 60_000) * 60_000).toISOString();
        const bucketKey = `${timestamp}\u0000${model}`;
        const bucket = usageBuckets.get(bucketKey) || { timestamp, model, ...emptyTotals(), usage_events: 0 };
        addTotals(bucket, delta);
        bucket.usage_events += 1;
        usageBuckets.set(bucketKey, bucket);
      }
      if (!messageCwd && typeof data.path?.cwd === "string" && data.path.cwd.trim()) {
        messageCwd = data.path.cwd.trim();
      }
    }
    // Sessions without any message (claude-import migrations the import did
    // not rebuild, sessions abandoned before the first reply) keep the row's
    // own wall-clock span; they end up with zero tokens and the browser's
    // existing total_tokens > 0 filter drops them from the listing.
    if (messages.length === 0) {
      const created = Number(row?.time_created);
      const updated = Number(row?.time_updated);
      if (Number.isFinite(created) && created > 0) updateBounds(bounds, new Date(created).toISOString());
      if (Number.isFinite(updated) && updated > 0) updateBounds(bounds, new Date(updated).toISOString());
    }

    const signals = signalsBySession.get(sessionId) || null;
    if (signals) {
      // Widen the wall-clock span with model_usage request extremes: message
      // timestamps are request starts, so the final request's duration would
      // otherwise vanish from ended_at (a 10s request reads as a 0-length
      // span). Direct comparison instead of updateBounds() keeps active_ms
      // (idle-gap working time) driven by the interval union below.
      if (signals.firstRequestIso && (!bounds.started_at || signals.firstRequestIso < bounds.started_at)) {
        bounds.started_at = signals.firstRequestIso;
      }
      if (signals.lastRequestEndIso && (!bounds.ended_at || signals.lastRequestEndIso > bounds.ended_at)) {
        bounds.ended_at = signals.lastRequestEndIso;
      }
    }
    // Active time = the union of request execution intervals plus message
    // instants, with spans ≤ IDLE_GAP_MS apart bridged. updateBounds' gap
    // accumulator only measures message-start-to-message-start, which loses
    // the execution time of every request but the last one (two 10s requests
    // around a 1h pause must read 20s, not 10s); the union also collapses
    // parallel requests instead of counting them twice. Legacy-only sessions
    // contribute points alone, which degenerates to the same idle-gap span
    // the generic scanners produce.
    const spans = [...(signals ? signals.activeSpans : []), ...messagePoints.map((ms) => [ms, ms])]
      .filter(([startMs, endMs]) => Number.isFinite(startMs) && Number.isFinite(endMs))
      .sort((a, b) => a[0] - b[0]);
    let unionActiveMs = 0;
    let unionStart = null;
    let unionEnd = null;
    for (const [startMs, endMs] of spans) {
      if (unionStart === null) {
        unionStart = startMs;
        unionEnd = endMs;
        continue;
      }
      if (startMs <= unionEnd + IDLE_GAP_MS) {
        if (endMs > unionEnd) unionEnd = endMs;
        continue;
      }
      unionActiveMs += unionEnd - unionStart;
      unionStart = startMs;
      unionEnd = endMs;
    }
    if (unionStart !== null) unionActiveMs += unionEnd - unionStart;
    bounds.active_ms = unionActiveMs;
    const finished = signals ? signals.collector.finish() : { performance: normalizePerformance(), byModel: new Map() };
    const modelUsage = [...modelUsageByModel.values()].map((usage) => ({
      ...usage,
      performance: finished.byModel.get(usage.model) || normalizePerformance(),
    }));
    const cwd = typeof row?.directory === "string" && row.directory.trim() ? row.directory.trim() : messageCwd;
    records.push(finalizeRecord({
      version: SIDECAR_VERSION,
      session_hash: sessionHash("zcode", sessionId),
      session_id: sessionId,
      // Local-only lineage: ZCode's own parent_id (subagent/workflow children).
      parent_session_id: typeof row?.parent_id === "string" && row.parent_id.trim() ? row.parent_id.trim() : null,
      // Local-only: stripped in summarizeSessions before any cloud/CSV export.
      title: cleanSessionTitle(row?.title),
      source: "zcode",
      // A database copied between Windows and POSIX retains its original cwd.
      project_key: projectKey(cwd && cwd.replace(/\\/g, "/"), displayPath),
      project_ref: cwd || null,
      model: modelUsage.length > 1 ? "mixed" : (modelUsage[0]?.model || "unknown"),
      model_usage: modelUsage,
      usage_buckets: [...usageBuckets.values()],
      ...bounds,
      turns: turnsBySession.get(sessionId) || 0,
      edit_turns: editTurnsBySession.get(sessionId) || 0,
      // Provider/API retries are not repeated user requests. This numeric
      // metadata has no user-prompt repetition evidence.
      retry_turns: 0,
      tokens,
      usage_events: messages.length,
      usage_precision: messages.length > 0 ? "reported" : "unavailable",
      cost_source: "model_pricing",
      provider_cost_usd: null,
      model_calls: messages.length,
      api_duration_ms: signals ? signals.apiDurationMs : 0,
      error_count: signals ? signals.errorCount : 0,
      compaction_count: signals ? signals.compactionCount : 0,
      performance: finished.performance,
      provenance: {
        source: "local-session-log",
        confidence: "observed",
        retry_confidence: "unavailable",
        content_retained: false,
        usage: messages.length > 0 ? "zcode-db-messages" : "unavailable",
      },
    }));
  }
  return records;
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
    // Same normalization as sync / the cursor store (scan-roots.expandHome):
    // a relative CODEX_HOME is anchored to home, never to process.cwd(), so
    // the browser walks the exact root the cursors were keyed under.
    const nativeRoot = useProcessCodexHome
      ? expandHome(env.CODEX_HOME, home)
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
  // Extra roots (#657), mirroring src/commands/sync.js: CLAUDE_CONFIG_DIR is
  // the spawning process's implicit Claude root (additive — ~/.claude stays
  // scanned), and config.scanRoots.<provider> arrives as deps.extraRoots from
  // discoverSessionFiles. Extras are realpath-deduped against the roots above
  // so one directory listed under two spellings is walked once.
  const extras = [];
  const useProcessClaudeConfigDir = providerDir === ".claude"
    && path.resolve(home) === path.resolve(homedir())
    && typeof env?.CLAUDE_CONFIG_DIR === "string"
    && env.CLAUDE_CONFIG_DIR.trim();
  if (useProcessClaudeConfigDir) extras.push(expandHome(env.CLAUDE_CONFIG_DIR, home));
  for (const extra of Array.isArray(deps.extraRoots) ? deps.extraRoots : []) {
    if (typeof extra === "string" && extra) extras.push(path.resolve(extra));
  }
  return appendUniqueDirs([...new Set(roots)], extras);
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
    const id = path.basename(filePath).match(/([0-9a-f-]{36})\.jsonl(?:\.zstd?)?$/i)?.[1] || filePath;
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

async function scanKimiSessions(filePaths) {
  const rows = await readKimiSessions(Array.isArray(filePaths) ? filePaths : [filePaths]);
  return rows.map(({ identity, files, ...row }) => finalizeRecord({
    ...row, version: SIDECAR_VERSION, source: "kimi", session_hash: sessionHash("kimi", identity),
    project_key: projectKey(row.project_ref, files[0]), ...sessionStorageUsage(files),
  }));
}

async function discoverSessionFiles(home, env = process.env, deps = {}) {
  const grokHome = resolveGrokHome(home);
  // config.scanRoots (#657): read from the tracker config unless the caller
  // injects it (tests). A missing or malformed config yields no extras.
  const scanRootsConfig = deps.scanRootsConfig !== undefined
    ? normalizeScanRootsConfig(deps.scanRootsConfig)
    : await loadScanRootsConfig({ home });
  // expandHome resolves `~` and relative entries against `home` (never cwd);
  // only readable directories are walked, absence and stat errors alike.
  const extraRootsFor = (provider) => scanRootsConfig[provider]
    .map((root) => expandHome(root, home))
    .filter((root) => root && scanRootDirState(root).exists);
  const claudeRoots = providerRoots(home, ".claude", env, { ...deps, extraRoots: extraRootsFor("claude") });
  const codexRoots = providerRoots(home, ".codex", env, { ...deps, extraRoots: extraRootsFor("codex") });
  // Two distinct roots may share one projects/ dir through a symlink; dedupe
  // the derived projects dirs by realpath (as sync does) so the browser never
  // lists the same transcript twice under two spellings.
  const claudeProjectsDirs = dedupeDirsByRealpath(claudeRoots.map((r) => path.join(r, "projects")));
  // listClaudeProjectFiles / listRolloutFilesDeep turn a listing error into an
  // empty result, so a root whose projects/ (or sessions/) exists but cannot be
  // read would look like "no sessions" and get cached as such. Report those
  // directories as incomplete discovery instead; the caller decides not to
  // persist a partial inventory (sync defers its repair on the same state).
  const incomplete = [];
  for (const dir of [
    ...claudeProjectsDirs,
    ...codexRoots.map((r) => path.join(r, "sessions")),
  ]) {
    const state = scanRootDirState(dir);
    if (state.error !== null) incomplete.push({ path: dir, error: state.error });
  }
  const [claudeGroups, codexGroups, archivedGroups, grok] = await Promise.all([
    Promise.all(claudeProjectsDirs.map((dir) => listClaudeProjectFiles(dir))),
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
  // ZCode has no sessions directory tree — one SQLite db per install. Resolve
  // it like the usage sync does (src/commands/sync.js): native candidate first
  // (ZCODE_HOME, home, win32 APPDATA fallback), then the WSL install when the
  // WSL mode probes it, picked with the same mode priority (default wsl-first)
  // so the browser reads the same install the usage card counts. "both"
  // preserves both paths; the scanner merges shared session/event identities.
  const zcodePlatform = deps.platform || process.platform;
  const zcodeNativeDbPath = (deps.resolveZcodeNativeDbPath || resolveZcodeNativeDbPath)({ home, env, platform: zcodePlatform });
  // Same WSL gate as providerRoots(): discoverWslHome resolves \\wsl$
  // independently of `home`, so a custom/injected home must not splice the
  // machine's live WSL db into an isolated scan. `probeWsl` is the deliberate
  // opt-in (defaults to true only for the machine's own home).
  const zcodeProbeWsl = deps.probeWsl !== undefined
    ? Boolean(deps.probeWsl)
    : path.resolve(home) === path.resolve((deps.homedir || os.homedir)());
  const zcodeWslHome = zcodePlatform === "win32" && zcodeProbeWsl && wsl.shouldProbeWsl(env)
    ? (deps.discoverWslHome || wsl.discoverWslHome)(".zcode", { env })
    : null;
  const zcodeExisting = (dbPath) => (dbPath && fs.existsSync(dbPath) ? dbPath : null);
  const zcodeWslDbPath = zcodeWslHome ? path.join(zcodeWslHome, "cli", "db", "db.sqlite") : null;
  const zcodeNativeExisting = zcodeExisting(zcodeNativeDbPath);
  const { cursors } = zcodePlatform === "win32"
    ? await readCursorStateSummary({ trackerDir: path.join(home, ".tokentracker", "tracker") })
    : {};
  const zcodePaths = resolveZcodeInstallPaths({
    nativeValue: zcodePlatform === "win32" ? zcodeNativeDbPath : zcodeNativeExisting,
    wslValue: zcodeWslDbPath,
  }, env, { platform: zcodePlatform, cursors });
  const zcode = [...new Set(Object.values(zcodePaths).filter(Boolean))];
  const opencodeNativeDir = env.OPENCODE_HOME || path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode");
  const opencodeWslDir = zcodePlatform === "win32" && zcodeProbeWsl && wsl.shouldProbeWsl(env)
    ? (deps.discoverWslHome || wsl.discoverWslHome)(".local/share/opencode", { env }) : null;
  const opencodePaths = resolveInstallPaths({ nativeValue: opencodeNativeDir, wslValue: opencodeWslDir }, env, { platform: zcodePlatform });
  const opencode = [...new Set(Object.values(opencodePaths).filter(Boolean)
    .map((dir) => path.join(dir, "opencode.db")).filter((dbPath) => fs.existsSync(dbPath)))];
  const kimiRoots = [".kimi", ".kimi-code"].flatMap((directory) => {
    const roots = providerRoots(home, directory, env, deps);
    const override = env[directory === ".kimi" ? "KIMI_HOME" : "KIMI_CODE_HOME"];
    if (override && path.resolve(home) === path.resolve((deps.homedir || os.homedir)())) {
      const native = path.join(home, directory);
      return roots.map((root) => root === native ? expandHome(override, home) : root);
    }
    return roots;
  });
  const kimi = discoverKimiWireFiles(dedupeDirsByRealpath(kimiRoots), incomplete);
  return { claude, codex: groupCodexFiles([...codex, ...archived]), grok, zcode, opencode, kimi, incomplete };
}

// Warn once per unreadable directory per process: the dashboard polls this
// path, and a line per poll would flood the serve log.
const warnedIncompleteDiscovery = new Set();
function warnIncompleteDiscovery(incomplete) {
  for (const entry of incomplete) {
    if (warnedIncompleteDiscovery.has(entry.path)) continue;
    warnedIncompleteDiscovery.add(entry.path);
    if (!process.env.NODE_TEST_CONTEXT) {
      console.warn(`[session-analytics] session directory unreadable (${entry.error}), inventory incomplete: ${entry.path}`);
    }
  }
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
  if (source === "kimi") {
    return `${sessionStat}|metadata:${filesSignature(kimiSessionDependencies(filePaths))}`;
  }
  if (source === "grok") {
    const primary = filePaths[0];
    return `${sessionStat}|summary:${sessionFileStatKey(grokSummaryPathFor(primary)) || "missing"}|signals:${sessionFileStatKey(grokSignalsPathFor(primary)) || "missing"}`;
  }
  if (source === "zcode" || source === "opencode") {
    // A WAL-mode db can absorb writes without touching the main file's mtime,
    // so the sidecar files are part of the db's identity for cache checks.
    return `${sessionStat}|sidecars:${filePaths.map((filePath) =>
      `wal:${sessionFileStatKey(`${filePath}-wal`) || "missing"}|shm:${sessionFileStatKey(`${filePath}-shm`) || "missing"}`).join("|")}`;
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
  // A lock/permission failure need not alter the database's stat signature.
  // Keep a separate durable invalidation marker while preserving the complete
  // sidecar and metadata. TTL, signature and per-file reuse must all retry it.
  const incompleteZcodePath = `${metaPath}.zcode-incomplete`;
  const retryZcodeScan = fs.existsSync(incompleteZcodePath);
  const incompleteOpencodePath = `${metaPath}.opencode-incomplete`;
  const retryOpencodeScan = fs.existsSync(incompleteOpencodePath);
  const incompleteKimiPath = `${metaPath}.kimi-incomplete`;
  const retryKimiScan = fs.existsSync(incompleteKimiPath);
  let previousMeta = null;
  if (!force) {
    try {
      previousMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const checkedAt = Date.parse(previousMeta.checked_at || previousMeta.generated_at || "");
      if (
        !retryZcodeScan && !retryOpencodeScan && !retryKimiScan && previousMeta.version === SIDECAR_VERSION &&
        Number.isFinite(checkedAt) &&
        Date.now() - checkedAt < Math.max(0, Number(cacheTtlMs) || 0)
      ) {
        return readSidecar(sidecarPath);
      }
    } catch { /* first run */ }
  }
  const discovered = await discoverSessionFiles(home);
  // Incomplete discovery (an unreadable projects/ or sessions/ dir): never let
  // a partial inventory replace a complete snapshot. Serve the last complete
  // sidecar when there is one; otherwise build from what is readable but do
  // not persist it, so the next refresh tries again.
  const incompleteDirs = Array.isArray(discovered.incomplete) ? discovered.incomplete : [];
  if (incompleteDirs.length > 0) {
    warnIncompleteDiscovery(incompleteDirs);
    if (!force && previousMeta?.version === SIDECAR_VERSION) {
      const cached = readSidecar(sidecarPath);
      Object.defineProperty(cached, "incompleteDirs", { value: incompleteDirs, enumerable: false });
      return cached;
    }
  }
  // Codex thread titles are stored separately from rollout files. Include the
  // index in the overall signature so an index-only rename reaches the
  // per-file dependency check below on the next refresh. Grok titles/metadata
  // live in sibling summary.json / signals.json next to updates.jsonl.
  const signature = filesSignature([
    ...discovered.claude.flat(),
    ...discovered.codex.flat(),
    ...discovered.codex.flat().map(codexTitleIndexPathFor).filter(Boolean),
    ...discovered.kimi,
    ...kimiSessionDependencies(discovered.kimi),
    ...discovered.grok,
    ...discovered.grok.map(grokSummaryPathFor),
    ...discovered.grok.map(grokSignalsPathFor),
    // db + its WAL sidecars: the trio is one logical file for change detection.
    ...[...(discovered.zcode || []), ...(discovered.opencode || [])].flatMap((dbPath) => [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]),
  ]);
  if (!force && !retryZcodeScan && !retryOpencodeScan && !retryKimiScan && previousMeta?.version === SIDECAR_VERSION && previousMeta.signature === signature) {
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
    ...(discovered.zcode.length ? [{ source: "zcode", filePath: discovered.zcode, scan: scanZcodeSessions }] : []),
    ...(discovered.opencode.length ? [{ source: "opencode", filePath: discovered.opencode, scan: scanOpencodeSessions }] : []),
    ...(discovered.kimi.length ? [{ source: "kimi", filePath: discovered.kimi, scan: scanKimiSessions }] : []),
  ];
  // Files we could not turn into a row (permission denied, half-written line,
  // vanished mid-scan). Swallowing these silently made sessions disappear with
  // no signal at all; count them so the API can say so.
  let skippedFiles = 0;
  let incompleteZcodeScan = false;
  let incompleteOpencodeScan = false;
  let incompleteKimiScan = false;
  for (const entry of entries) {
    const cacheKey = sessionFileCacheKey(entry.source, entry.filePath);
    const statKey = analyticsEntryStatKey(entry.source, entry.filePath);
    if (!statKey) {
      skippedFiles += 1;
      if (entry.source === "zcode") incompleteZcodeScan = true;
      if (entry.source === "opencode") incompleteOpencodeScan = true;
      if (entry.source === "kimi") incompleteKimiScan = true;
      continue;
    }
    let rows = null;
    if (!force && !(entry.source === "zcode" && retryZcodeScan) && !(entry.source === "opencode" && retryOpencodeScan) && !(entry.source === "kimi" && retryKimiScan) && previousFiles[cacheKey]?.stat_key === statKey) {
      if (entry.source === "zcode" || entry.source === "opencode" || entry.source === "kimi") {
        // One db scans to many cached rows; recover them all from the previous
        // pass. An empty recovery means the sidecar lost its rows — rescan.
        const cached = previousRows.filter((row) => row?.source === entry.source);
        rows = cached.length ? cached : null;
      } else {
        const row = previousRowsByFile.get(cacheKey) || null;
        rows = row ? [row] : null;
      }
    }
    if (!rows) {
      try {
        const scanned = await entry.scan(entry.filePath);
        rows = Array.isArray(scanned) ? scanned.filter(Boolean) : (scanned ? [scanned] : []);
      } catch (error) {
        // One active/partial session must not poison the sidecar, but do not
        // pretend it never existed either.
        skippedFiles += 1;
        if (entry.source === "zcode") incompleteZcodeScan = true;
        if (entry.source === "opencode") incompleteOpencodeScan = true;
        if (entry.source === "kimi") incompleteKimiScan = true;
        if (!process.env.NODE_TEST_CONTEXT) {
          console.warn(`[session-analytics] skipped ${entry.source} session file: ${error?.message || error}`);
        }
        rows = [];
      }
    }
    for (const row of rows) {
      repriceSessionRecord(row);
      // A one-way file hash enables incremental reuse without persisting or
      // exposing the user's local session path. ZCode's rows all share one db,
      // so key each by the db path plus its session id; a bare session id as a
      // separate path element would be path.resolve()d against the process cwd
      // and never match across runs.
      row._cache_key = (entry.source === "zcode" || entry.source === "opencode" || entry.source === "kimi") && (row.session_id || row.session_hash)
        ? `${cacheKey}#${sessionHash(entry.source, row.session_id || row.session_hash)}`
        : cacheKey;
      sessions.push(row);
    }
    if (rows.length > 0) nextFiles[cacheKey] = { stat_key: statKey };
  }
  if (incompleteZcodeScan) {
    await writeAtomic(incompleteZcodePath, "1\n");
    // ZCode databases form one deduplicated inventory. If any read fails, retain its last
    // complete rows even on a forced refresh; skippedFiles still reports that
    // these rows could not be refreshed. Older cache schemas must be rebuilt.
    sessions.push(...readSidecar(sidecarPath).filter((row) =>
      row.source === "zcode" && row.version === SIDECAR_VERSION));
  }
  if (incompleteOpencodeScan) {
    await writeAtomic(incompleteOpencodePath, "1\n");
    sessions.push(...readSidecar(sidecarPath).filter((row) =>
      row.source === "opencode" && row.version === SIDECAR_VERSION));
  }
  if (incompleteKimiScan) {
    await writeAtomic(incompleteKimiPath, "1\n");
    sessions.push(...readSidecar(sidecarPath).filter((row) => row.source === "kimi" && row.version === SIDECAR_VERSION));
  }
  sessions.sort((a, b) => String(b.ended_at || "").localeCompare(String(a.ended_at || "")));
  // A failed database scan is an incomplete inventory. Keep the last complete
  // snapshot and signature so an unchanged database is retried next build.
  if (incompleteDirs.length === 0 && !incompleteZcodeScan && !incompleteOpencodeScan && !incompleteKimiScan) {
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
    await fsp.rm(incompleteZcodePath, { force: true });
    await fsp.rm(incompleteOpencodePath, { force: true });
    await fsp.rm(incompleteKimiPath, { force: true });
  }
  // Non-enumerable so the array still behaves exactly like a plain row list
  // for every existing caller (map/filter/JSON of the rows is unaffected).
  Object.defineProperty(sessions, "skippedFiles", { value: skippedFiles, enumerable: false });
  Object.defineProperty(sessions, "incompleteDirs", { value: incompleteDirs, enumerable: false });
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
function sessionUsageDay(timestamp, { timeZone, offsetMinutes } = {}) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
      const part = (name) => parts.find((p) => p.type === name)?.value;
      return `${part("year")}-${part("month")}-${part("day")}`;
    } catch { /* fall back to the caller's offset or UTC */ }
  }
  return new Date(date.getTime() + (Number.isFinite(offsetMinutes) ? offsetMinutes * 60_000 : 0)).toISOString().slice(0, 10);
}

function withinDayRange(row, from, to, context) {
  const startDay = sessionUsageDay(row?.started_at || row?.ended_at || "", context);
  const endDay = sessionUsageDay(row?.ended_at || row?.started_at || "", context);
  if (from && (!endDay || endDay < from)) return false;
  if (to && (!startDay || startDay > to)) return false;
  return true;
}

function scopeSessionUsage(row, from, to, context) {
  if ((!from && !to) || !Array.isArray(row.usage_buckets)) return { ...row };
  const buckets = row.usage_buckets.filter((bucket) => {
    const day = sessionUsageDay(bucket.timestamp, context);
    return (!from || day >= from) && (!to || day <= to);
  });
  const tokens = emptyTotals();
  const byModel = new Map();
  for (const bucket of buckets) {
    addTotals(tokens, bucket);
    const model = byModel.get(bucket.model) || { model: bucket.model, ...emptyTotals(), usage_events: 0 };
    addTotals(model, bucket);
    mergeUsageMetadata(model, bucket);
    if (!bucket.usage_events) model.usage_events += 1;
    byModel.set(bucket.model, model);
  }
  return repriceSessionRecord({ ...row, tokens, total_tokens: tokens.total_tokens,
    model_usage: [...byModel.values()], usage_buckets: buckets, cost_usd: 0,
    lifetime_total_tokens: row.total_tokens, lifetime_cost_usd: row.cost_usd });
}

function summarizeSessions(sessions, { from = "", to = "", includeSessions = true, timeZone, offsetMinutes } = {}) {
  const context = { timeZone, offsetMinutes };
  const filtered = annotateThreadUsage((sessions || [])
    .filter((row) => withinDayRange(row, from, to, context))
    // Efficiency is a session-lifetime metric: both tokens and edit turns
    // must describe that same population. The browser scopes consumption
    // separately; do not divide in-range tokens by lifetime edit counts here.
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
    performance: normalizePerformance(),
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
    totals.performance = mergePerformance(totals.performance, row.performance);
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
        performance: normalizePerformance(),
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
      agg.performance = mergePerformance(agg.performance, usage.performance);
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
    if ((row.source === "codex" || row.source === "zcode" || row.source === "opencode") && row.parent_session_hash) {
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
    // Codex and ZCode children are first-class rows. A spawn call in the parent is
    // a control-plane event, not token usage, so do not mix in an estimate.
    if (row.source === "codex" || row.source === "zcode" || row.source === "opencode") continue;
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
  if (source === "opencode") return `opencode --session ${id}`;
  if (source === "kimi") return `kimi --session ${id}`;
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
    ...(Number.isFinite(row.session_store_bytes) ? {
      session_store_bytes: row.session_store_bytes,
      session_store_metric: row.session_store_metric,
      bytes_per_1k_tokens: (row.lifetime_total_tokens ?? row.total_tokens) > 0
        ? row.session_store_bytes * 1000 / (row.lifetime_total_tokens ?? row.total_tokens) : null,
    } : {}),
    project_key: row.project_key,
    // project_ref (the local cwd) only ever travels over the local API so the
    // browser can show where a session ran and compose a resume command.
    project_ref: row.project_ref || null,
    model: row.model,
    model_usage: modelUsageForAggregation(row),
    ...(Array.isArray(row.usage_buckets) ? { usage_buckets: row.usage_buckets } : {}),
    performance: normalizePerformance(row.performance),
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
        performance: normalizePerformance(row.performance),
        _repr_tokens: finite(row.total_tokens),
      });
      continue;
    }
    cur.turns = finite(cur.turns) + finite(row.turns);
    cur.edit_turns = finite(cur.edit_turns) + finite(row.edit_turns);
    cur.retry_turns = finite(cur.retry_turns) + finite(row.retry_turns);
    cur.performance = mergePerformance(cur.performance, row.performance);
    cur.subagent_calls = finite(cur.subagent_calls) + finite(row.subagent_calls);
    addTotals(cur.tokens, row.tokens);
    if (Array.isArray(row.usage_buckets)) {
      cur.usage_buckets = [...(cur.usage_buckets || []), ...row.usage_buckets];
    }
    cur.model_usage = normalizeModelUsageRows([
      ...(cur.model_usage || []),
      ...(row.model_usage || []),
    ]);
    cur.total_tokens = finite(cur.total_tokens) + finite(row.total_tokens);
    if (Number.isFinite(row.session_store_bytes)) cur.session_store_bytes = finite(cur.session_store_bytes) + row.session_store_bytes;
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

// Attach exact Codex/ZCode parent→child usage without changing the
// authoritative per-session total_tokens field. Combined fields are derived
// views only, so summing total_tokens across all rows still equals the global
// usage ledger. ZCode joins the same lineage pass: its subagent/workflow
// children carry parent_session_id from the session table, so the browser can
// nest them under their parent and count them as its subagents.
function annotateThreadUsage(rows) {
  const byId = new Map();
  const childrenById = new Map();
  const linkedParentById = new Map();
  const identity = (row, id = row.session_id) => `${row.source}\u0000${id}`;

  for (const row of rows || []) {
    if ((row?.source !== "codex" && row?.source !== "zcode" && row?.source !== "opencode") || typeof row.session_id !== "string" || !row.session_id) continue;
    const existing = byId.get(identity(row));
    if (existing && existing !== row) {
      existing.parent_link_conflict = true;
      row.parent_link_conflict = true;
      continue;
    }
    byId.set(identity(row), row);
  }

  function hasParentCycle(start) {
    const seen = new Set();
    let current = start;
    while (current?.parent_session_id && byId.has(identity(current, current.parent_session_id))) {
      if (seen.has(identity(current)) || current.parent_session_id === current.session_id) return true;
      seen.add(identity(current));
      current = byId.get(identity(current, current.parent_session_id));
    }
    return false;
  }

  for (const row of byId.values()) {
    const parentId = typeof row.parent_session_id === "string" ? row.parent_session_id.trim() : "";
    if (!parentId) continue;
    const parentKey = identity(row, parentId);
    if (row.parent_link_conflict || hasParentCycle(row)) {
      row.parent_link_conflict = true;
      continue;
    }
    if (!byId.has(parentKey)) {
      row.orphaned_subagent = true;
      continue;
    }
    const children = childrenById.get(parentKey) || [];
    children.push(row);
    childrenById.set(parentKey, children);
    linkedParentById.set(identity(row), parentKey);
  }

  const memo = new Map();
  function aggregate(row, visiting = new Set()) {
    if (memo.has(identity(row))) return memo.get(identity(row));
    if (visiting.has(identity(row))) {
      row.parent_link_conflict = true;
      return { count: 0, tokens: 0, cost: 0 };
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(identity(row));
    let count = 0;
    let tokens = 0;
    let cost = 0;
    for (const child of childrenById.get(identity(row)) || []) {
      const nested = aggregate(child, nextVisiting);
      count += 1 + nested.count;
      tokens += finite(child.total_tokens) + nested.tokens;
      cost += finite(child.cost_usd) + nested.cost;
    }
    const result = { count, tokens, cost };
    memo.set(identity(row), result);
    return result;
  }

  function rootFor(row) {
    const seen = new Set([identity(row)]);
    let current = row;
    while (current && linkedParentById.has(identity(current))) {
      const linkedParentId = linkedParentById.get(identity(current));
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
    const threadAware = (row.source === "codex" || row.source === "zcode" || row.source === "opencode")
      && typeof row.session_id === "string" && row.session_id;
    row.own_total_tokens = finite(row.total_tokens);
    row.own_cost_usd = finite(row.cost_usd);
    row.direct_subagent_count = threadAware
      ? (childrenById.get(identity(row)) || []).length
      : 0;
    const nested = threadAware
      ? aggregate(row)
      : { count: 0, tokens: 0, cost: 0 };
    row.descendant_subagent_count = nested.count;
    row.subagent_total_tokens = nested.tokens;
    row.subagent_cost_usd = nested.cost;
    row.combined_total_tokens = finite(row.total_tokens) + nested.tokens;
    row.combined_cost_usd = finite(row.cost_usd) + nested.cost;
    if (threadAware) {
      const parent = byId.get(linkedParentById.get(identity(row)));
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
function listSessionsForBrowser(sessions, { from = "", to = "", limit = 0, timeZone, offsetMinutes } = {}) {
  const context = { timeZone, offsetMinutes };
  const filtered = annotateThreadUsage(mergeSessionFragments(sessions)
    // Only sessions that actually spent tokens are worth listing. This drops
    // two kinds of noise: non-session logs under ~/.claude/projects
    // (skill-injections.jsonl, journal.jsonl, …), and sessions abandoned before
    // the model replied. Both render as "unknown · 0 tokens · $0.00" rows with
    // no model, no cost and nothing to analyze.
    .filter((row) => finite(row.total_tokens) > 0)
    .filter((row) => withinDayRange(row, from, to, context))
    .map((row) => scopeSessionUsage(row, from, to, context))
    .filter((row) => !Array.isArray(row.usage_buckets) || finite(row.total_tokens) > 0));
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
  scanZcodeSessions,
  scanOpencodeSessions,
  scanKimiSessions,
  buildSessionAnalytics,
  summarizeSessions,
  listSessionsForBrowser,
  resumeCommandFor,
  sessionsToCsv,
  providerRoots,
  discoverSessionFiles,
  dedupeClaudeFilesAcrossRoots,
  analyticsEntryStatKey,
};
