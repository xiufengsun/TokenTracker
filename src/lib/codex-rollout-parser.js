// Codex rollout JSONL parser — extracted from codex-context-breakdown.js.
//
// Handles file discovery and per-file parsing. Does NOT hold any aggregation
// state; callers (computeCodexContextBreakdown) own the merge step.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { listRolloutFiles } = require("./rollout");
const {
  consumeUsageDelta,
  createUsageDeltaState,
  snapshotUsageBaselines,
  totalsReset,
} = require("./codex-token-usage");
const {
  emptyTotals,
  addInto,
  inferExecCommandKind,
  sanitizeCommandSignature,
  getExecutableName,
  buildExecStatsEntry,
} = require("./categorizer-utils");
const {
  applyCodexModelEvent,
  createCodexModelAttributionState,
  currentCodexModel,
  snapshotCodexModelAttributionState,
} = require("./codex-model-attribution");
const { readCodexServiceTier, isPriorityServiceTier } = require("./codex-service-tier");
const {
  createUsageRecordState,
  extractTokenUsageRecord,
  noteLineAfterUsageRecord,
  noteTokenCount,
  noteUsageRecord,
  snapshotUsageRecordState,
  takeCompactionOnTokenCount,
} = require("./codex-usage-record");

const DISCOVERY_FULL_AUDIT_INTERVAL_MS = 60 * 1000;
const MAX_DISCOVERY_INVENTORIES = 32;
const DISCOVERY_INVENTORIES = new Map();
const ZONED_DAY_FORMATTERS = new Map();
const CODEX_RESUME_INVALIDATED = "TOKENTRACKER_CODEX_RESUME_INVALIDATED";
// Match src/lib/pricing/index.js. Classify individual requests using raw
// input (including cache), not the accumulated session or day totals.
const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272_000;

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

function dayKeyToIsoBounds(from, to) {
  if (!from && !to) return { fromIso: null, toIso: null };
  const fromDate = from ? new Date(`${from}T00:00:00Z`) : null;
  const toDate = to ? new Date(`${to}T23:59:59Z`) : null;
  if (fromDate && Number.isFinite(fromDate.getTime())) fromDate.setUTCHours(fromDate.getUTCHours() - 14);
  if (toDate && Number.isFinite(toDate.getTime())) toDate.setUTCHours(toDate.getUTCHours() + 14);
  return {
    fromIso: fromDate ? fromDate.toISOString() : null,
    toIso: toDate ? toDate.toISOString() : null,
  };
}

function formatPartsDayKey(parts) {
  if (!parts) return "";
  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  if (!values.year || !values.month || !values.day) return "";
  return `${values.year}-${values.month}-${values.day}`;
}

function getZonedParts(date, timeZoneContext = {}) {
  const { timeZone, offsetMinutes } = timeZoneContext || {};
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return null;

  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      let formatter = ZONED_DAY_FORMATTERS.get(timeZone);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hourCycle: "h23",
        });
        ZONED_DAY_FORMATTERS.set(timeZone, formatter);
      }
      return formatter.formatToParts(dt);
    } catch {
      // Fall through to offset handling.
    }
  }

  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(dt.getTime() - Number(offsetMinutes) * 60_000);
    return [
      { type: "year", value: String(shifted.getUTCFullYear()).padStart(4, "0") },
      { type: "month", value: String(shifted.getUTCMonth() + 1).padStart(2, "0") },
      { type: "day", value: String(shifted.getUTCDate()).padStart(2, "0") },
    ];
  }

  return null;
}

function timestampDayKey(timestamp, timeZoneContext) {
  const ts = typeof timestamp === "string" ? timestamp : "";
  if (!ts) return "";
  const parts = getZonedParts(ts, timeZoneContext);
  const zoned = formatPartsDayKey(parts);
  if (zoned) return zoned;
  return ts.slice(0, 10);
}

function isTimestampInRequestedDayRange(timestamp, { from, to, timeZoneContext } = {}) {
  if (!from && !to) return true;
  const day = timestampDayKey(timestamp, timeZoneContext);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function safeJsonParse(str, diagnostics = null) {
  try {
    if (diagnostics) diagnostics.json_parse_calls += 1;
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function listJsonlFiles(rootDir) {
  const out = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(filePath);
      }
    }
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function rolloutPathDay(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/");
  const fileMatch = path.basename(normalized).match(/(?:^|rollout-)(\d{4})-(\d{2})-(\d{2})/);
  if (fileMatch) return `${fileMatch[1]}-${fileMatch[2]}-${fileMatch[3]}`;
  const directoryMatch = normalized.match(/.*\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
  return directoryMatch
    ? `${directoryMatch[1]}-${directoryMatch[2]}-${directoryMatch[3]}`
    : null;
}

function nextDayKey(dayKey) {
  if (!dayKey) return null;
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function metadataRangeBounds(from, to, timeZoneContext) {
  const offsetMinutes = timeZoneContext?.offsetMinutes;
  if (Number.isFinite(offsetMinutes)) {
    const dstGuardMs = 2 * 60 * 60 * 1000;
    const fromUtc = from ? Date.parse(`${from}T00:00:00.000Z`) : null;
    const afterTo = to ? nextDayKey(to) : null;
    const toUtcExclusive = afterTo ? Date.parse(`${afterTo}T00:00:00.000Z`) : null;
    return {
      fromMs: Number.isFinite(fromUtc)
        ? fromUtc + offsetMinutes * 60_000 - dstGuardMs
        : null,
      toMs: Number.isFinite(toUtcExclusive)
        ? toUtcExclusive + offsetMinutes * 60_000 + dstGuardMs
        : null,
    };
  }
  const { fromIso, toIso } = dayKeyToIsoBounds(from, to);
  return {
    fromMs: fromIso ? Date.parse(fromIso) : null,
    toMs: toIso ? Date.parse(toIso) : null,
  };
}

function isConservativeRangeCandidate(filePath, stat, {
  from = null,
  to = null,
  timeZoneContext = null,
  metadataBounds = null,
} = {}) {
  if (!from && !to) return true;
  // With no lower bound, a later-path rewrite can still contain an event at or
  // before `to`. There is no metadata-only exclusion that can prove otherwise.
  if (!from) return true;
  const pathDay = rolloutPathDay(filePath);
  if (!pathDay) return true;

  const pathOverlaps = (!from || pathDay >= from) && (!to || pathDay <= to);
  if (pathOverlaps) return true;

  // Old sessions can be appended or rewritten. A post-range mtime or ctime is
  // therefore a reason to parse, never a reason to exclude. ctime also catches
  // cold-process inode replacement/truncation when a writer preserves mtime.
  // Future-dated decoys are kept conservatively; correctness wins over an open.
  const bounds = metadataBounds || metadataRangeBounds(from, to, timeZoneContext);
  const fromMs = bounds.fromMs;
  const toMs = bounds.toMs;
  const mtimeMs = Number(stat?.mtimeMs);
  const ctimeMs = Number(stat?.ctimeMs);
  const changedAfterStart = (value) => (
    Number.isFinite(value) && (!Number.isFinite(fromMs) || value >= fromMs)
  );
  const changedInsideRange = (value) => (
    changedAfterStart(value) && (!Number.isFinite(toMs) || value <= toMs)
  );
  if (pathDay < from) {
    return changedAfterStart(mtimeMs) || changedAfterStart(ctimeMs);
  }

  // A path one day ahead can still overlap the requested browser day because
  // rollout folders follow the writer's local date. Its current mtime may be
  // later if the same session kept growing, so metadata alone cannot exclude it.
  if (to && pathDay === nextDayKey(to)) return true;

  // A host-local path day can be later than the requested browser day when
  // their timezones differ. Keep it only when filesystem metadata maps back
  // into the requested day range; do not pull every genuinely future session
  // into a historical query.
  return changedInsideRange(mtimeMs) || changedInsideRange(ctimeMs);
}

function isRolloutPathInRequestedRange(filePath, { from = null, to = null } = {}) {
  const pathDay = rolloutPathDay(filePath);
  if (!pathDay) return true;
  if (from && pathDay < from) return false;
  if (to && pathDay > to) return false;
  return true;
}

function discoveryInventoryKey(roots) {
  return roots.map((root) => path.resolve(root)).sort().join("\0");
}

function getDiscoveryInventory(roots, nowMs) {
  const key = discoveryInventoryKey(roots);
  let inventory = DISCOVERY_INVENTORIES.get(key);
  if (!inventory) {
    inventory = { files: new Map(), lastFullAuditAtMs: 0, lastUsedAtMs: nowMs };
    DISCOVERY_INVENTORIES.set(key, inventory);
  }
  inventory.lastUsedAtMs = nowMs;
  while (DISCOVERY_INVENTORIES.size > MAX_DISCOVERY_INVENTORIES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [candidateKey, candidate] of DISCOVERY_INVENTORIES) {
      if (candidateKey === key) continue;
      if (candidate.lastUsedAtMs < oldestAt) {
        oldestAt = candidate.lastUsedAtMs;
        oldestKey = candidateKey;
      }
    }
    if (!oldestKey) break;
    DISCOVERY_INVENTORIES.delete(oldestKey);
  }
  return inventory;
}

function discoverCodexSessionFiles(rootDirs, options = {}) {
  const diagnostics = options.diagnostics || null;
  const roots = Array.isArray(rootDirs) ? rootDirs : [rootDirs];
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const inventory = getDiscoveryInventory(roots.filter(Boolean), nowMs);
  const candidateOptions = {
    ...options,
    metadataBounds: metadataRangeBounds(options.from, options.to, options.timeZoneContext),
  };
  const bounded = Boolean(options.from || options.to);
  const auditAgeMs = nowMs - Number(inventory.lastFullAuditAtMs || 0);
  const fullMetadataAudit = Boolean(
    options.exhaustive ||
    !bounded ||
    !Number.isFinite(auditAgeMs) ||
    auditAgeMs < 0 ||
    auditAgeMs >= DISCOVERY_FULL_AUDIT_INTERVAL_MS
  );
  if (diagnostics) diagnostics.full_metadata_audit = fullMetadataAudit;
  const entries = [];
  const visited = new Set();
  const stack = roots.filter(Boolean);

  while (stack.length > 0) {
    const dir = stack.pop();
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const filePath = path.join(dir, child.name);
      if (child.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!child.isFile() || !child.name.endsWith(".jsonl") || visited.has(filePath)) continue;
      visited.add(filePath);
      if (diagnostics) diagnostics.discovered_files += 1;
      const cached = inventory.files.get(filePath) || null;
      const cachedCandidate = cached
        ? isConservativeRangeCandidate(filePath, cached, candidateOptions)
        : false;
      const shouldStat = Boolean(
        fullMetadataAudit ||
        !cached ||
        cachedCandidate ||
        isRolloutPathInRequestedRange(filePath, options)
      );
      let stat = cached;
      if (shouldStat) {
        try {
          if (diagnostics) diagnostics.stat_calls += 1;
          stat = fs.statSync(filePath);
          inventory.files.set(filePath, stat);
        } catch {
          inventory.files.delete(filePath);
          continue;
        }
      } else if (diagnostics) {
        diagnostics.metadata_cache_hits += 1;
      }
      const candidate = Boolean(
        options.exhaustive ||
        isConservativeRangeCandidate(filePath, stat, candidateOptions),
      );
      entries.push({ filePath, stat, candidate });
      if (candidate && diagnostics) diagnostics.candidate_files += 1;
    }
  }

  for (const filePath of inventory.files.keys()) {
    if (!visited.has(filePath)) inventory.files.delete(filePath);
  }
  if (fullMetadataAudit) inventory.lastFullAuditAtMs = nowMs;

  return entries.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

async function listCodexSessionFiles(baseDir) {
  const rolloutFiles = await listRolloutFiles(baseDir).catch(() => []);
  const allJsonlFiles = listJsonlFiles(baseDir);
  if (allJsonlFiles.length === 0) return rolloutFiles;
  if (rolloutFiles.length === 0) return allJsonlFiles;

  const merged = new Set(rolloutFiles);
  for (const filePath of allJsonlFiles) merged.add(filePath);
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Token count extraction
// ---------------------------------------------------------------------------

function extractTokenCount(obj) {
  const payload = obj?.payload;
  if (!payload || obj?.type !== "event_msg") return null;
  if (payload.type === "token_count") {
    return { info: payload.info || null, timestamp: obj?.timestamp || null };
  }
  const msg = payload.msg;
  if (msg && msg.type === "token_count") {
    return { info: msg.info || null, timestamp: obj?.timestamp || null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool name helpers
// ---------------------------------------------------------------------------

function normalizeToolName(payload) {
  const name = payload?.name || "";
  const ns = payload?.namespace || null;
  if (ns && typeof ns === "string" && ns.startsWith("mcp__")) return `${ns}${name}`;
  return name || "unknown";
}

function extractSkillNameFromFunctionCall(payload, diagnostics = null) {
  if (!payload || payload.name !== "exec_command") return null;
  const args = safeJsonParse(payload.arguments || "{}", diagnostics) || {};
  const cmd = String(args.cmd || "");
  const match = cmd.match(/(?:^|\/)skills\/(?:\.system\/)?([^/\s]+)\/SKILL\.md\b/);
  return match ? match[1] : null;
}

function formatToolDisplayName(name) {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  if (parts.length < 3) return name;
  const server = String(parts[1] || "").replace(/^plugin_/, "").replace(/_/g, "-");
  const tool = parts.slice(2).join("__") || name;
  return server ? `${server}/${tool}` : tool;
}

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

function normalizeUsage(u) {
  const out = {};
  for (const k of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    const n = Number(u?.[k] || 0);
    out[k] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  // Codex reports input inclusive of cached_input_tokens; keep our schema
  // convention: non-cached input and cached input tracked separately.
  out.input_tokens = Math.max(0, out.input_tokens - out.cached_input_tokens);
  out.total_tokens =
    out.input_tokens +
    out.cached_input_tokens +
    out.cache_creation_input_tokens +
    out.output_tokens;
  return out;
}

function pickDelta(lastUsage, totalUsage, prevTotals) {
  const state = createUsageDeltaState({ lastTotal: prevTotals });
  const delta = consumeUsageDelta(state, lastUsage, totalUsage);
  return delta ? normalizeUsage(delta) : null;
}

// ---------------------------------------------------------------------------
// Exec stats helpers (local to parser, not shared)
// ---------------------------------------------------------------------------

function durationBucket(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n < 1000) return "<1s";
  if (n < 10_000) return "1-10s";
  if (n < 60_000) return "10-60s";
  if (n < 300_000) return "1-5m";
  return ">5m";
}

function outputSizeBucket(lines, chars) {
  const l = Number(lines || 0);
  const c = Number(chars || 0);
  if (!l && !c) return "quiet";
  if (l <= 20 && c <= 2_000) return "small";
  if (l <= 200 && c <= 20_000) return "medium";
  if (l <= 1000 && c <= 100_000) return "large";
  return "very_large";
}

function buildToolStatsEntry() {
  return { calls: 0, totals: emptyTotals() };
}

function buildSkillStatsEntry(name) {
  return { name, calls: 0, totals: emptyTotals() };
}

// ---------------------------------------------------------------------------
// Finalize helpers
// ---------------------------------------------------------------------------

function finalizeToolRows(map) {
  return Array.from(map.values())
    .map((row) => {
      const rawName = row.raw_name || row.name;
      return {
        name: formatToolDisplayName(rawName),
        raw_name: rawName,
        calls: row.calls,
        totals: row.totals,
      };
    })
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
}

function finalizeSkillRows(map) {
  return Array.from(map.values())
    .map((row) => ({
      name: row.name,
      calls: row.calls,
      totals: row.totals,
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
}

function finalizeExecRows(map) {
  return Array.from(map.values())
    .map((row) => ({
      name: row.name,
      calls: row.calls,
      failures: row.failures,
      duration_ms: row.duration_ms,
      max_duration_ms: row.max_duration_ms,
      output_chars: row.output_chars,
      output_lines: row.output_lines,
      totals: row.totals,
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));
}

function finalizeModelUsageRows(map) {
  return Array.from(map.values())
    .map((row) => ({
      ...row,
      selected_models: Array.from(row.selected_models).sort(),
      reroute_reasons: Array.from(row.reroute_reasons).sort(),
      model_attribution: row.rerouted_usage_events > 0 ? "effective" : "selected",
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model));
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

async function parseCodexRolloutFile(filePath, {
  from = null,
  to = null,
  timeZoneContext = null,
  diagnostics = null,
  seenTokenEvents = null,
  startOffset = 0,
  endOffset = null,
  resumeState = null,
  captureResumeState = false,
  captureContentHash = false,
  contentHashState = null,
  sourceHandle = null,
  collectBreakdowns = true,
  collectModelUsage = false,
  onObject = null,
} = {}) {
  const filePaths = (Array.isArray(filePath) ? filePath : [filePath]).filter(Boolean);
  const primaryFilePath = filePaths[0] || String(filePath || "");
  const isResuming = Boolean(resumeState && filePaths.length === 1);
  const initialOffset = Math.max(0, Number(startOffset) || 0);
  const readProgress = {
    endOffset: initialOffset,
    lastByte: initialOffset > 0 ? 0x0a : null,
  };
  let contentHasher = null;
  if (captureResumeState && captureContentHash && filePaths.length === 1) {
    if (contentHashState && typeof contentHashState.copy === "function") {
      try {
        contentHasher = contentHashState.copy();
      } catch {
        contentHasher = null;
      }
    }
    if (initialOffset > 0 && !contentHasher) {
      const error = new Error("Codex rollout append is missing its prefix hash state");
      error.code = CODEX_RESUME_INVALIDATED;
      throw error;
    }
    if (!contentHasher) contentHasher = crypto.createHash("sha256");
  }

  let sessionId = isResuming ? resumeState.sessionId || null : null;
  let cwd = isResuming ? resumeState.cwd || null : null;
  let model = isResuming ? resumeState.model || null : null;
  const modelAttributionState = createCodexModelAttributionState(
    isResuming ? resumeState.modelAttributionState || { model } : {},
  );
  // Codex writes thread_settings_applied immediately before the turn_context of
  // the turn it applies to, and token_count rows carry no turn id, so each one
  // belongs to the most recent preceding tier record. Sessions that never emit
  // the event (most CLI sessions) stay null and are billed at Standard.
  let serviceTier = isResuming ? resumeState.serviceTier || null : null;
  let provider = isResuming ? resumeState.provider || null : null;
  let cliVersion = isResuming ? resumeState.cliVersion || null : null;
  let forkedFromId = isResuming ? resumeState.forkedFromId || null : null;
  let parentThreadId = isResuming ? resumeState.parentThreadId || null : null;
  let threadSource = isResuming ? resumeState.threadSource || null : null;
  let agentNickname = isResuming ? resumeState.agentNickname || null : null;
  let agentRole = isResuming ? resumeState.agentRole || null : null;
  let sessionLineageCaptured = isResuming
    ? Boolean(resumeState.sessionLineageCaptured || resumeState.sessionId)
    : false;

  const usageDeltaState = createUsageDeltaState({
    lastTotal: isResuming ? resumeState.prevTotals || null : null,
    baselines: isResuming ? resumeState.tokenUsageBaselines || null : null,
  });
  let pendingToolNames = isResuming
    ? Array.from(resumeState.pendingToolNames || [])
    : [];
  let pendingSkills = isResuming ? Array.from(resumeState.pendingSkills || []) : [];
  let pendingExecDetails = isResuming
    ? Array.from(resumeState.pendingExecDetails || [])
    : [];
  let lastTokenTimestamp = isResuming
    ? String(resumeState.lastTokenTimestamp || "") || null
    : null;
  let lastTimestampEventSignatures = new Set(
    isResuming ? resumeState.lastTimestampEventSignatures || [] : [],
  );
  let lastTimestampLastUsage = null;
  let lastTimestampTotalUsage = null;
  let hasUnmaterializedLastTimestampUsage = false;

  const totals = emptyTotals();
  const byTool = new Map(); // tool_name -> {name,calls,totals}
  const bySkill = new Map(); // skill_name -> {name,calls,totals}
  const byExecKind = new Map(); // kind -> stats
  const byExecExit = new Map(); // status:exit -> stats
  const byExecExecutable = new Map(); // executable -> stats
  const byExecCommand = new Map(); // sanitized executable + subcommand -> stats
  const byExecDuration = new Map(); // duration bucket -> stats
  const byExecOutput = new Map(); // output size bucket -> stats
  const byModel = new Map(); // effective model -> observed token usage

  let turnCount = 0;

  // Compaction records (issue #652, rules in codex-usage-record.js). A resume
  // state from before #652 with prevTotals has seen a token_count.
  const usageRecordState = createUsageRecordState(
    isResuming
      ? resumeState.usageRecordState || (resumeState.prevTotals ? { sawTokenCount: true } : null)
      : null,
  );
  // Compactions counted in this session, by response_id: the files merged for
  // a session can repeat a record (an archived copy, a split fragment), and a
  // resumed parse must not count one from an earlier chunk again.
  const compactionResponseIds = new Set(
    isResuming && Array.isArray(resumeState.compactionResponseIds)
      ? resumeState.compactionResponseIds
      : [],
  );

  // Attribution as of now. A compaction record is counted later than it is
  // read, so it carries the attribution captured when it was read.
  function currentUsageAttribution() {
    return {
      model: currentCodexModel(modelAttributionState) || "unknown",
      selectedModel: modelAttributionState.selectedModel || null,
      rerouted: Boolean(modelAttributionState.rerouted),
      rerouteReason: modelAttributionState.rerouteReason || null,
      serviceTier,
    };
  }

  function recordModelUsage(delta, rawRequestUsage, attribution = currentUsageAttribution()) {
    if (!collectModelUsage || !delta || delta.total_tokens <= 0) return;
    const effectiveModel = attribution.model;
    let row = byModel.get(effectiveModel);
    if (!row) {
      row = {
        model: effectiveModel,
        ...emptyTotals(),
        long_context_input_tokens: 0,
        long_context_cached_input_tokens: 0,
        long_context_cache_creation_input_tokens: 0,
        long_context_output_tokens: 0,
        long_context_reasoning_output_tokens: 0,
        priority_input_tokens: 0,
        priority_cached_input_tokens: 0,
        priority_cache_creation_input_tokens: 0,
        priority_output_tokens: 0,
        priority_reasoning_output_tokens: 0,
        priority_long_context_input_tokens: 0,
        priority_long_context_cached_input_tokens: 0,
        priority_long_context_cache_creation_input_tokens: 0,
        priority_long_context_output_tokens: 0,
        priority_long_context_reasoning_output_tokens: 0,
        usage_events: 0,
        rerouted_usage_events: 0,
        long_context_usage_events: 0,
        priority_usage_events: 0,
        selected_models: new Set(),
        reroute_reasons: new Set(),
      };
      byModel.set(effectiveModel, row);
    }
    addInto(row, delta);
    row.usage_events += 1;
    if (attribution.selectedModel) {
      row.selected_models.add(attribution.selectedModel);
    }
    if (attribution.rerouted) {
      row.rerouted_usage_events += 1;
      if (attribution.rerouteReason) {
        row.reroute_reasons.add(attribution.rerouteReason);
      }
    }
    // OpenAI applies the long-context tier to the whole request when its raw
    // (cache-inclusive) input exceeds 272K tokens. Preserve the exact subset
    // so pricing can be recomputed later without rescanning private logs.
    const isLongContext =
      Number(rawRequestUsage?.input_tokens || 0) > OPENAI_LONG_CONTEXT_INPUT_THRESHOLD;
    if (isLongContext) {
      row.long_context_usage_events += 1;
      row.long_context_input_tokens += delta.input_tokens;
      row.long_context_cached_input_tokens += delta.cached_input_tokens;
      row.long_context_cache_creation_input_tokens += delta.cache_creation_input_tokens;
      row.long_context_output_tokens += delta.output_tokens;
      row.long_context_reasoning_output_tokens += delta.reasoning_output_tokens;
    }
    // Astra Fast bills at a flat multiple of whichever context tier the request
    // was on, so the priority premium multiplies the long-context premium
    // instead of replacing it. The two subsets alone cannot say how much usage
    // was on BOTH, so record the intersection explicitly — otherwise a long
    // Fast request prices at 3x Standard input where it should be 4x.
    if (isPriorityServiceTier(attribution.serviceTier)) {
      row.priority_usage_events += 1;
      row.priority_input_tokens += delta.input_tokens;
      row.priority_cached_input_tokens += delta.cached_input_tokens;
      row.priority_cache_creation_input_tokens += delta.cache_creation_input_tokens;
      row.priority_output_tokens += delta.output_tokens;
      row.priority_reasoning_output_tokens += delta.reasoning_output_tokens;
      if (isLongContext) {
        row.priority_long_context_input_tokens += delta.input_tokens;
        row.priority_long_context_cached_input_tokens += delta.cached_input_tokens;
        row.priority_long_context_cache_creation_input_tokens +=
          delta.cache_creation_input_tokens;
        row.priority_long_context_output_tokens += delta.output_tokens;
        row.priority_long_context_reasoning_output_tokens += delta.reasoning_output_tokens;
      }
    }
  }

  function ensureTool(name) {
    if (!byTool.has(name)) {
      byTool.set(name, { name, ...buildToolStatsEntry() });
    }
    return byTool.get(name);
  }

  function ensureExec(map, key) {
    if (!map.has(key)) map.set(key, { name: key, ...buildExecStatsEntry() });
    return map.get(key);
  }

  function ensureSkill(name) {
    if (!bySkill.has(name)) bySkill.set(name, buildSkillStatsEntry(name));
    return bySkill.get(name);
  }

  function getExecKeys(p) {
    if (!p || typeof p !== "object") return;
    const cmdArr = Array.isArray(p.command) ? p.command : null;
    const cmd = cmdArr && cmdArr.length > 0 ? String(cmdArr[cmdArr.length - 1] || "") : "";
    const kind = p.parsed_cmd?.[0]?.type && p.parsed_cmd[0].type !== "unknown"
      ? p.parsed_cmd[0].type
      : inferExecCommandKind(cmd);

    const status = String(p.status || "unknown");
    const exit = Number.isFinite(Number(p.exit_code)) ? Number(p.exit_code) : null;
    const exitKey = `${status}:${exit === null ? "unknown" : exit}`;

    const dur = p.duration ? Math.round((Number(p.duration.secs || 0) * 1000) + Number(p.duration.nanos || 0) / 1e6) : 0;
    const output = String(p.aggregated_output || p.stdout || "");
    const outputChars = output.length;
    const outputLines = output ? output.split("\n").length : 0;
    return {
      kind,
      exitKey,
      executable: getExecutableName(cmd),
      command: sanitizeCommandSignature(cmd),
      duration: durationBucket(dur),
      output: outputSizeBucket(outputLines, outputChars),
      dur,
      outputChars,
      outputLines,
      failed: status !== "completed" || exit !== 0,
    };
  }

  function absorbExecStats(map, key, details) {
    const row = ensureExec(map, key);
    row.calls += 1;
    row.duration_ms += details.dur;
    row.max_duration_ms = Math.max(row.max_duration_ms, details.dur);
    row.output_chars += details.outputChars;
    row.output_lines += details.outputLines;
    if (details.failed) row.failures += 1;
  }

  function absorbExecEnd(details) {
    absorbExecStats(byExecKind, details.kind, details);
    absorbExecStats(byExecExit, details.exitKey, details);
    absorbExecStats(byExecExecutable, details.executable, details);
    absorbExecStats(byExecCommand, details.command, details);
    absorbExecStats(byExecDuration, details.duration, details);
    absorbExecStats(byExecOutput, details.output, details);
  }

  function attributeTurn(delta) {
    if (!delta || delta.total_tokens <= 0) {
      for (const details of pendingExecDetails) absorbExecEnd(details);
      pendingToolNames = [];
      pendingSkills = [];
      pendingExecDetails = [];
      return;
    }
    turnCount += 1;

    if (!collectBreakdowns) {
      addInto(totals, delta);
      pendingToolNames = [];
      pendingSkills = [];
      pendingExecDetails = [];
      return;
    }

    const unique = [...new Set(pendingToolNames.filter(Boolean))];
    const tools = unique.length > 0 ? unique : ["text_response"];
    const share = 1 / tools.length;

    for (const name of tools) {
      const row = ensureTool(name);
      row.calls += share;
      addInto(row.totals, {
        input_tokens: delta.input_tokens * share,
        cached_input_tokens: delta.cached_input_tokens * share,
        cache_creation_input_tokens: delta.cache_creation_input_tokens * share,
        output_tokens: delta.output_tokens * share,
        reasoning_output_tokens: delta.reasoning_output_tokens * share,
        total_tokens: delta.total_tokens * share,
      });
    }

    const uniqueSkills = [...new Set(pendingSkills.filter(Boolean))];
    if (uniqueSkills.length > 0) {
      const skillShare = 1 / uniqueSkills.length;
      for (const name of uniqueSkills) {
        const row = ensureSkill(name);
        row.calls += skillShare;
        addInto(row.totals, {
          input_tokens: delta.input_tokens * skillShare,
          cached_input_tokens: delta.cached_input_tokens * skillShare,
          cache_creation_input_tokens: delta.cache_creation_input_tokens * skillShare,
          output_tokens: delta.output_tokens * skillShare,
          reasoning_output_tokens: delta.reasoning_output_tokens * skillShare,
          total_tokens: delta.total_tokens * skillShare,
        });
      }
    }

    // Attribute exec_command_end rows to exec stats; note these are not a
    // token source — we attach the same tool-shared delta to the command
    // classifier so users can find high-cost command families.
    const execToolShare = tools.includes("exec_command") ? (1 / tools.length) : 0;
    const execDelta = execToolShare > 0 ? {
      input_tokens: delta.input_tokens * execToolShare,
      cached_input_tokens: delta.cached_input_tokens * execToolShare,
      cache_creation_input_tokens: delta.cache_creation_input_tokens * execToolShare,
      output_tokens: delta.output_tokens * execToolShare,
      reasoning_output_tokens: delta.reasoning_output_tokens * execToolShare,
      total_tokens: delta.total_tokens * execToolShare,
    } : null;

    if (execDelta && pendingExecDetails.length > 0) {
      const perExecShare = 1 / pendingExecDetails.length;
      for (const details of pendingExecDetails) {
        const attributed = {
          input_tokens: execDelta.input_tokens * perExecShare,
          cached_input_tokens: execDelta.cached_input_tokens * perExecShare,
          cache_creation_input_tokens: execDelta.cache_creation_input_tokens * perExecShare,
          output_tokens: execDelta.output_tokens * perExecShare,
          reasoning_output_tokens: execDelta.reasoning_output_tokens * perExecShare,
          total_tokens: execDelta.total_tokens * perExecShare,
        };

        addInto(ensureExec(byExecKind, details.kind).totals, attributed);
        addInto(ensureExec(byExecExit, details.exitKey).totals, attributed);
        addInto(ensureExec(byExecExecutable, details.executable).totals, attributed);
        addInto(ensureExec(byExecCommand, details.command).totals, attributed);
        addInto(ensureExec(byExecDuration, details.duration).totals, attributed);
        addInto(ensureExec(byExecOutput, details.output).totals, attributed);

        absorbExecEnd(details);
      }
    } else {
      // Still ingest exec end stats without token attribution so the drill-down works.
      for (const details of pendingExecDetails) absorbExecEnd(details);
    }

    addInto(totals, delta);
    pendingToolNames = [];
    pendingSkills = [];
    pendingExecDetails = [];
  }

  function countCompactionRecord(record) {
    if (compactionResponseIds.has(record.responseId)) return;
    compactionResponseIds.add(record.responseId);
    if (!record.inRequestedRange) return;
    recordModelUsage(record.delta, record.rawUsage, record.attribution);
    attributeTurn(record.delta);
  }

  function usageEventSignature(lastUsage, totalUsage) {
    return JSON.stringify({ lastUsage, totalUsage });
  }

  function materializeLastTimestampSignatures() {
    if (hasUnmaterializedLastTimestampUsage) {
      lastTimestampEventSignatures.add(
        usageEventSignature(lastTimestampLastUsage, lastTimestampTotalUsage),
      );
      hasUnmaterializedLastTimestampUsage = false;
    }
    return lastTimestampEventSignatures;
  }

  function noteTokenEvent(timestamp, lastUsage, totalUsage) {
    if (!isResuming) {
      if (timestamp !== lastTokenTimestamp) {
        lastTokenTimestamp = timestamp;
        lastTimestampEventSignatures = new Set();
        hasUnmaterializedLastTimestampUsage = false;
      } else {
        materializeLastTimestampSignatures();
      }
      lastTimestampLastUsage = lastUsage;
      lastTimestampTotalUsage = totalUsage;
      hasUnmaterializedLastTimestampUsage = true;
      return true;
    }
    if (isResuming && lastTokenTimestamp && timestamp < lastTokenTimestamp) {
      const error = new Error("Codex rollout append is not timestamp-monotonic");
      error.code = CODEX_RESUME_INVALIDATED;
      throw error;
    }
    if (!lastTokenTimestamp || timestamp > lastTokenTimestamp) {
      lastTokenTimestamp = timestamp;
      lastTimestampEventSignatures = new Set();
      lastTimestampLastUsage = lastUsage;
      lastTimestampTotalUsage = totalUsage;
      hasUnmaterializedLastTimestampUsage = true;
      return true;
    }
    if (timestamp === lastTokenTimestamp) {
      const signature = usageEventSignature(lastUsage, totalUsage);
      const signatures = materializeLastTimestampSignatures();
      if (signatures.has(signature)) return false;
      signatures.add(signature);
    }
    return true;
  }

  for await (const obj of iterateCodexObjects(filePaths, diagnostics, {
    startOffset,
    endOffset,
    readProgress,
    contentHasher,
    sourceHandle,
  })) {
    const modelEvent = applyCodexModelEvent(modelAttributionState, obj);
    const attributedModel = currentCodexModel(modelAttributionState);
    model = attributedModel || model;
    // onObject runs AFTER the attribution state machine, and is handed the
    // model it just decided. A consumer sharing this pass (the delivery-signal
    // collector, which attributes edit turns) therefore sees exactly the model
    // recordModelUsage() bills the turn's tokens to. Letting it re-read
    // turn_context.payload.model itself would make codex-model-attribution.js
    // one of two authorities on the same question.
    if (typeof onObject === "function") onObject(obj, attributedModel);
    const usageRecord = extractTokenUsageRecord(obj);
    if (!usageRecord) noteLineAfterUsageRecord(usageRecordState, obj?.type === "compacted");
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
    if (!ts) continue;
    const inRequestedRange = isTimestampInRequestedDayRange(ts, { from, to, timeZoneContext });

    if (obj.type === "session_meta") {
      const p = obj.payload || {};
      // Forked rollouts replay historical session_meta rows after their own
      // child metadata. Only the first row describes this file's lineage.
      if (!sessionLineageCaptured) {
        sessionId = p.id || sessionId;
        cwd = p.cwd || cwd;
        cliVersion = p.cli_version || cliVersion;
        provider = p.model_provider || provider;
        forkedFromId = p.forked_from_id || null;
        parentThreadId = p.parent_thread_id || null;
        threadSource = p.thread_source || p.source || null;
        agentNickname = p.agent_nickname || null;
        agentRole = p.agent_role || null;
        sessionLineageCaptured = true;
      } else if (!sessionId) {
        sessionId = p.id || null;
      }
    }

    const appliedServiceTier = readCodexServiceTier(obj);
    if (appliedServiceTier) {
      serviceTier = appliedServiceTier;
      continue;
    }

    if (obj.type === "turn_context") {
      const p = obj.payload || {};
      if (typeof p.cwd === "string") cwd = p.cwd;
      continue;
    }

    if (modelEvent?.type === "model_rerouted") continue;

    if (collectBreakdowns && obj.type === "response_item" && obj.payload?.type === "function_call") {
      pendingToolNames.push(normalizeToolName(obj.payload));
      const skill = extractSkillNameFromFunctionCall(obj.payload, diagnostics);
      if (skill) pendingSkills.push(skill);
      continue;
    }

    if (collectBreakdowns && obj.type === "event_msg" && obj.payload?.type === "exec_command_end") {
      const details = getExecKeys(obj.payload);
      if (details) pendingExecDetails.push(details);
      continue;
    }

    if (usageRecord) {
      const delta = normalizeUsage(usageRecord.usage);
      noteUsageRecord(
        usageRecordState,
        // Without a response_id a compaction cannot be deduplicated.
        delta.total_tokens > 0 && usageRecord.responseId
          ? {
              responseId: usageRecord.responseId,
              timestamp: usageRecord.timestamp,
              inRequestedRange,
              rawUsage: usageRecord.usage,
              delta,
              attribution: currentUsageAttribution(),
            }
          : null,
      );
      continue;
    }

    const tokenCount = extractTokenCount(obj);
    if (tokenCount) {
      const info = tokenCount.info;
      const lastUsage = info?.last_token_usage;
      const totalUsage = info?.total_token_usage;
      let compaction = null;
      if (info && typeof info === "object") {
        noteTokenCount(usageRecordState);
        compaction = takeCompactionOnTokenCount(
          usageRecordState,
          usageDeltaState.lastTotal,
          totalUsage,
        );
      }
      const rawDelta = consumeUsageDelta(usageDeltaState, lastUsage, totalUsage);
      const delta = rawDelta ? normalizeUsage(rawDelta) : null;
      if (compaction) countCompactionRecord(compaction);
      const isNewResumeEvent = noteTokenEvent(ts, lastUsage, totalUsage);
      if (inRequestedRange) {
        const eventSessionId = sessionId || rolloutSessionIdFromPath(primaryFilePath) || primaryFilePath;
        const eventKey = `${eventSessionId}:${ts}:${usageEventSignature(lastUsage, totalUsage)}`;
        if (!isNewResumeEvent || (seenTokenEvents && seenTokenEvents.has(eventKey))) {
          attributeTurn(null);
        } else {
          if (seenTokenEvents && delta?.total_tokens > 0) seenTokenEvents.add(eventKey);
          recordModelUsage(delta, lastUsage || rawDelta);
          attributeTurn(delta);
        }
      } else {
        pendingToolNames = [];
        pendingSkills = [];
        pendingExecDetails = [];
      }
      continue;
    }
  }

  const result = {
    sessionId: sessionId || rolloutSessionIdFromPath(primaryFilePath) || primaryFilePath,
    cwd,
    model: currentCodexModel(modelAttributionState) || model || provider,
    provider,
    version: cliVersion,
    forkedFromId,
    parentThreadId,
    threadSource,
    agentNickname,
    agentRole,
    filePath: primaryFilePath,
    turnCount,
    totals,
    modelUsage: finalizeModelUsageRows(byModel),
    toolBreakdown: {
      tool_rows: finalizeToolRows(byTool),
    },
    skillsBreakdown: {
      skill_rows: finalizeSkillRows(bySkill),
    },
    execCommandBreakdown: {
      byType: finalizeExecRows(byExecKind),
      byExit: finalizeExecRows(byExecExit),
      byExecutable: finalizeExecRows(byExecExecutable),
      byCommand: finalizeExecRows(byExecCommand),
      byDuration: finalizeExecRows(byExecDuration),
      byOutput: finalizeExecRows(byExecOutput),
    },
  };
  if (captureResumeState && filePaths.length === 1) {
    result.resumeState = {
      sessionId,
      cwd,
      model,
      modelAttributionState: snapshotCodexModelAttributionState(modelAttributionState),
      serviceTier,
      provider,
      cliVersion,
      forkedFromId,
      parentThreadId,
      threadSource,
      agentNickname,
      agentRole,
      sessionLineageCaptured,
      prevTotals: usageDeltaState.lastTotal,
      tokenUsageBaselines: snapshotUsageBaselines(usageDeltaState),
      pendingToolNames,
      pendingSkills,
      pendingExecDetails,
      lastTokenTimestamp,
      lastTimestampEventSignatures: Array.from(materializeLastTimestampSignatures()),
      usageRecordState: snapshotUsageRecordState(usageRecordState),
      compactionResponseIds: Array.from(compactionResponseIds),
    };
    result.endOffset = readProgress.endOffset;
    result.appendable = Boolean(contentHasher) && (
      readProgress.endOffset === 0 || readProgress.lastByte === 0x0a
    );
    result.contentHashState = contentHasher;
  }
  return result;
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function parseCodexLine(lineBuffer, diagnostics) {
  let content = lineBuffer;
  if (content.length > 0 && content[content.length - 1] === 0x0d) {
    content = content.subarray(0, content.length - 1);
  }
  if (content.length === 0) return null;
  try {
    if (diagnostics) diagnostics.json_parse_calls += 1;
    return JSON.parse(fatalUtf8Decoder.decode(content));
  } catch {
    return null;
  }
}

async function* readCodexObjectsIncremental(filePath, diagnostics, fileIndex, {
  startOffset = 0,
  endOffset = null,
  readProgress = null,
  contentHasher = null,
  sourceHandle = null,
} = {}) {
  const start = Math.max(0, Number(startOffset) || 0);
  const requestedEnd = Number(endOffset);
  const hasBoundedEnd = endOffset !== null && endOffset !== undefined &&
    Number.isFinite(requestedEnd) && requestedEnd >= 0;
  if (hasBoundedEnd && requestedEnd <= start) {
    if (readProgress) readProgress.endOffset = start;
    return;
  }

  if (diagnostics) diagnostics.opened_files += 1;
  const stream = sourceHandle && typeof sourceHandle.read === "function"
    ? null
    : fs.createReadStream(filePath, {
        start,
        ...(hasBoundedEnd ? { end: requestedEnd - 1 } : {}),
      });
  const chunks = stream || (async function* readStableHandleChunks() {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const limit = hasBoundedEnd ? requestedEnd : Number.MAX_SAFE_INTEGER;
    let offset = start;
    while (offset < limit) {
      const length = Math.min(buffer.length, limit - offset);
      const result = await sourceHandle.read(buffer, 0, length, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
      yield buffer.subarray(0, result.bytesRead);
    }
  })();
  const fragments = [];
  let fragmentsBytes = 0;
  let nextChunkOffset = start;
  let lineStartOffset = start;
  let lineIndex = 0;

  try {
    for await (const value of chunks) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const chunkStart = nextChunkOffset;
      nextChunkOffset += chunk.length;
      if (contentHasher) contentHasher.update(chunk);
      if (readProgress && chunk.length > 0) {
        readProgress.lastByte = chunk[chunk.length - 1];
      }
      if (diagnostics) {
        diagnostics.bytes_read = Number(diagnostics.bytes_read || 0) + chunk.length;
      }

      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (newline < 0) {
          const tail = chunk.subarray(cursor);
          if (tail.length > 0) {
            // Stable-handle reads reuse their buffer, so retained fragments
            // must own their bytes before the next read overwrites it.
            fragments.push(Buffer.from(tail));
            fragmentsBytes += tail.length;
          }
          break;
        }

        const tail = chunk.subarray(cursor, newline);
        const lineBuffer = fragments.length > 0
          ? Buffer.concat([...fragments, tail], fragmentsBytes + tail.length)
          : tail;
        fragments.length = 0;
        fragmentsBytes = 0;

        const absoluteEnd = chunkStart + newline + 1;
        if (readProgress) readProgress.endOffset = absoluteEnd;
        lineStartOffset = absoluteEnd;
        const obj = parseCodexLine(lineBuffer, diagnostics);
        if (obj) {
          yield { obj, fileIndex, lineIndex };
          lineIndex += 1;
        }
        cursor = newline + 1;
      }
    }

    if (fragmentsBytes > 0) {
      const lineBuffer = fragments.length === 1
        ? fragments[0]
        : Buffer.concat(fragments, fragmentsBytes);
      const obj = parseCodexLine(lineBuffer, diagnostics);
      if (obj) {
        if (readProgress) readProgress.endOffset = lineStartOffset + fragmentsBytes;
        yield { obj, fileIndex, lineIndex };
      }
    }
  } finally {
    if (readProgress) readProgress.endOffset = nextChunkOffset;
    stream?.destroy();
    if (diagnostics) diagnostics.parsed_files += 1;
  }
}

async function* readCodexObjectsFull(filePath, diagnostics, fileIndex, {
  startOffset = 0,
  endOffset = null,
  readProgress = null,
  contentHasher = null,
} = {}) {
  yield* readCodexObjectsIncremental(filePath, diagnostics, fileIndex, {
    startOffset,
    endOffset,
    readProgress,
    contentHasher,
  });
}

async function* readCodexObjects(filePath, diagnostics, fileIndex, options = {}) {
  const start = Math.max(0, Number(options.startOffset) || 0);
  const reader = start > 0 || options.sourceHandle
    ? readCodexObjectsIncremental
    : readCodexObjectsFull;
  yield* reader(filePath, diagnostics, fileIndex, options);
}

function isRecoverableGroupedReadError(error) {
  return ["ENOENT", "EACCES", "EPERM", "EISDIR", "EIO", "ESTALE"].includes(error?.code);
}

async function* iterateCodexObjects(filePaths, diagnostics, options = {}) {
  if (filePaths.length <= 1) {
    for await (const record of readCodexObjects(filePaths[0], diagnostics, 0, options)) {
      yield record.obj;
    }
    return;
  }

  // A live rollout can overlap its archived copy or be split into prefix/suffix
  // fragments. Merge only duplicate-session groups, order by event time, and
  // suppress byte-semantically identical records from different files so the
  // cumulative baseline is established exactly once.
  const records = [];
  let scannedFiles = 0;
  for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex += 1) {
    const fileRecords = [];
    try {
      for await (const record of readCodexObjects(filePaths[fileIndex], diagnostics, fileIndex)) {
        fileRecords.push(record);
      }
      for (const record of fileRecords) records.push(record);
      scannedFiles += 1;
    } catch (error) {
      if (!isRecoverableGroupedReadError(error)) throw error;
    }
  }
  if (!scannedFiles) throw new Error("all grouped Codex rollout files failed during read");
  records.sort((a, b) => {
    const aTimestamp = typeof a.obj?.timestamp === "string" ? a.obj.timestamp : "";
    const bTimestamp = typeof b.obj?.timestamp === "string" ? b.obj.timestamp : "";
    return aTimestamp.localeCompare(bTimestamp) || a.fileIndex - b.fileIndex || a.lineIndex - b.lineIndex;
  });
  const firstFileByRecord = new Map();
  for (const record of records) {
    const semanticKey = JSON.stringify(record.obj);
    const firstFile = firstFileByRecord.get(semanticKey);
    if (firstFile !== undefined && firstFile !== record.fileIndex) continue;
    if (firstFile === undefined) firstFileByRecord.set(semanticKey, record.fileIndex);
    yield record.obj;
  }
}

function rolloutSessionIdFromPath(filePath) {
  const match = path.basename(String(filePath || "")).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match ? match[1] : null;
}

function isCodexResumeInvalidated(error) {
  return error?.code === CODEX_RESUME_INVALIDATED;
}

module.exports = {
  parseCodexRolloutFile,
  extractTokenCount,
  extractSkillNameFromFunctionCall,
  formatToolDisplayName,
  normalizeToolName,
  pickDelta,
  normalizeUsage,
  totalsReset,
  listJsonlFiles,
  listCodexSessionFiles,
  discoverCodexSessionFiles,
  rolloutPathDay,
  isConservativeRangeCandidate,
  safeJsonParse,
  dayKeyToIsoBounds,
  formatPartsDayKey,
  getZonedParts,
  timestampDayKey,
  isTimestampInRequestedDayRange,
  rolloutSessionIdFromPath,
  isCodexResumeInvalidated,
  finalizeToolRows,
  finalizeSkillRows,
  finalizeExecRows,
  buildSkillStatsEntry,
};
