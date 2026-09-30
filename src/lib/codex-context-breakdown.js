// Codex CLI "Context Breakdown" — tool-oriented view.
//
// Privacy commitment: tokens + timestamps only. We do not return prompt text,
// assistant text, tool outputs, file contents, or exec_command arguments.
//
// Data source: ~/.codex/sessions/**/rollout-*.jsonl
// We treat each token_count event as the authoritative delta and attribute
// that delta to "turn" activity since the last token_count. Tool attribution
// is heuristic: delta is split evenly across tools used in that turn.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveEnvRoot } = require("./scan-roots");

const {
  emptyTotals,
  addInto,
  roundTotals,
  buildExecStatsEntry,
  allocateByLargestRemainder,
  categorizeTool,
} = require("./categorizer-utils");

const {
  parseCodexRolloutFile,
  discoverCodexSessionFiles,
  rolloutSessionIdFromPath,
  finalizeToolRows,
  finalizeSkillRows,
  finalizeExecRows,
  buildSkillStatsEntry,
  isCodexResumeInvalidated,
} = require("./codex-rollout-parser");

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function mergeRollupTotals(target, add) {
  addInto(target, add);
}

function mergeRows(map, rows) {
  for (const row of rows || []) {
    const name = row?.name ? String(row.name) : "";
    const rawName = row?.raw_name ? String(row.raw_name) : name;
    const key = rawName || name;
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { name, raw_name: rawName, calls: 0, totals: emptyTotals() });
    }
    const cur = map.get(key);
    cur.name = name;
    cur.raw_name = rawName;
    cur.calls += Number(row.calls || 0);
    mergeRollupTotals(cur.totals, row.totals || {});
  }
}

function mergeSkillRows(map, rows) {
  for (const row of rows || []) {
    const name = row?.name ? String(row.name) : "";
    if (!name) continue;
    if (!map.has(name)) map.set(name, buildSkillStatsEntry(name));
    const cur = map.get(name);
    cur.calls += Number(row.calls || 0);
    mergeRollupTotals(cur.totals, row.totals || {});
  }
}

function mergeExecRows(map, rows) {
  for (const row of rows || []) {
    const name = row?.name ? String(row.name) : "";
    if (!name) continue;
    if (!map.has(name)) map.set(name, { name, ...buildExecStatsEntry() });
    const cur = map.get(name);
    cur.calls += Number(row.calls || 0);
    cur.failures += Number(row.failures || 0);
    cur.duration_ms += Number(row.duration_ms || 0);
    cur.max_duration_ms = Math.max(cur.max_duration_ms, Number(row.max_duration_ms || 0));
    cur.output_chars += Number(row.output_chars || 0);
    cur.output_lines += Number(row.output_lines || 0);
    mergeRollupTotals(cur.totals, row.totals || {});
  }
}

function mergeParsedSessionResults(previous, delta) {
  if (!previous) return delta;
  if (!delta) return previous;

  const totals = emptyTotals();
  mergeRollupTotals(totals, previous.totals || {});
  mergeRollupTotals(totals, delta.totals || {});

  const tools = new Map();
  mergeRows(tools, previous.toolBreakdown?.tool_rows);
  mergeRows(tools, delta.toolBreakdown?.tool_rows);
  const skills = new Map();
  mergeSkillRows(skills, previous.skillsBreakdown?.skill_rows);
  mergeSkillRows(skills, delta.skillsBreakdown?.skill_rows);

  const mergeExecGroup = (key) => {
    const rows = new Map();
    mergeExecRows(rows, previous.execCommandBreakdown?.[key]);
    mergeExecRows(rows, delta.execCommandBreakdown?.[key]);
    return finalizeExecRows(rows);
  };

  return {
    sessionId: delta.sessionId || previous.sessionId,
    cwd: delta.cwd || previous.cwd,
    model: delta.model || previous.model,
    provider: delta.provider || previous.provider,
    version: delta.version || previous.version,
    filePath: previous.filePath || delta.filePath,
    turnCount: Number(previous.turnCount || 0) + Number(delta.turnCount || 0),
    totals,
    toolBreakdown: { tool_rows: finalizeToolRows(tools) },
    skillsBreakdown: { skill_rows: finalizeSkillRows(skills) },
    execCommandBreakdown: {
      byType: mergeExecGroup("byType"),
      byExit: mergeExecGroup("byExit"),
      byExecutable: mergeExecGroup("byExecutable"),
      byCommand: mergeExecGroup("byCommand"),
      byDuration: mergeExecGroup("byDuration"),
      byOutput: mergeExecGroup("byOutput"),
    },
  };
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

function normalizePeriod(period) {
  const p = String(period || "").trim().toLowerCase();
  if (!p) return null;
  if (["day", "week", "month", "total"].includes(p)) return p;
  return null;
}

function buildDateRange({ period, date }) {
  const anchor = date ? new Date(`${date}T00:00:00Z`) : new Date();
  if (!Number.isFinite(anchor.getTime())) return null;
  const end = new Date(`${anchor.toISOString().slice(0, 10)}T23:59:59Z`);
  if (!Number.isFinite(end.getTime())) return null;

  let start;
  if (period === "day") start = new Date(`${anchor.toISOString().slice(0, 10)}T00:00:00Z`);
  else if (period === "week") start = new Date(end.getTime() - 6 * 86400_000);
  else if (period === "month") start = new Date(end.getTime() - 29 * 86400_000);
  else if (period === "total") start = null;
  else return null;

  return {
    from: start ? start.toISOString().slice(0, 10) : null,
    to: end.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE = new Map();
const PARSED_GROUP_CACHE = new Map();
const CACHE_TTL_MS = 60_000;
const CACHE_SCHEMA_VERSION = "codex-context-v6";
const MAX_PARSED_GROUP_CACHE_ENTRIES = 4096;
const PREFIX_HASH_READ_BYTES = 1024 * 1024;

function cacheTimeZoneKey(timeZoneContext) {
  if (!timeZoneContext) return "";
  return `${timeZoneContext.timeZone || ""}|${Number.isFinite(timeZoneContext.offsetMinutes) ? timeZoneContext.offsetMinutes : ""}`;
}

function statIdentity(filePath, stat) {
  return JSON.stringify([filePath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
}

function contentStatIdentity(filePath, stat) {
  return JSON.stringify([
    filePath,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
  ]);
}

function isUnlinkedResumeSnapshot(filePath, before, after) {
  return Boolean(
    before &&
    after &&
    Number(after.nlink) === 0 &&
    contentStatIdentity(filePath, before) === contentStatIdentity(filePath, after),
  );
}

function inventorySignature(entries) {
  const hash = crypto.createHash("sha256");
  for (const { filePath, stat, candidate } of entries) {
    hash.update(statIdentity(filePath, stat));
    hash.update(candidate ? "1" : "0");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parsedGroupCacheKey(entries, { from, to, timeZoneContext }) {
  const hash = crypto.createHash("sha256");
  hash.update(CACHE_SCHEMA_VERSION);
  hash.update(from || "");
  hash.update("\0");
  hash.update(to || "");
  hash.update("\0");
  hash.update(cacheTimeZoneKey(timeZoneContext));
  for (const { filePath } of entries) {
    hash.update(filePath);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parsedGroupSignature(entries) {
  const hash = crypto.createHash("sha256");
  for (const { filePath, stat } of entries) {
    hash.update(statIdentity(filePath, stat));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function selectAppendHashPaths(candidateGroups) {
  // Only the newest single-file group pays the cold hash cost. Any file that
  // later grows becomes newest, takes one conservative full parse, and keeps
  // its hash state for subsequent append-only refreshes.
  let newest = null;
  for (const entries of candidateGroups.values()) {
    if (
      entries.length !== 1 ||
      !rolloutSessionIdFromPath(entries[0].filePath)
    ) continue;
    const entry = entries[0];
    if (!newest) {
      newest = entry;
      continue;
    }
    const mtimeDelta = Number(entry.stat?.mtimeMs || 0) -
      Number(newest.stat?.mtimeMs || 0);
    const ctimeDelta = Number(entry.stat?.ctimeMs || 0) -
      Number(newest.stat?.ctimeMs || 0);
    if (
      mtimeDelta > 0 ||
      (mtimeDelta === 0 && ctimeDelta > 0) ||
      (mtimeDelta === 0 && ctimeDelta === 0 &&
        entry.filePath.localeCompare(newest.filePath) < 0)
    ) {
      newest = entry;
    }
  }
  return newest ? new Set([newest.filePath]) : new Set();
}

async function digestFilePrefix(
  sourceHandle,
  endOffset,
  diagnostics = null,
) {
  const end = Math.max(0, Number(endOffset) || 0);
  const hash = crypto.createHash("sha256");
  if (end === 0) return hash.digest("hex");
  let bytesRead = 0;
  const buffer = Buffer.allocUnsafe(PREFIX_HASH_READ_BYTES);
  while (bytesRead < end) {
    const length = Math.min(buffer.length, end - bytesRead);
    const result = await sourceHandle.read(buffer, 0, length, bytesRead);
    if (!result.bytesRead) break;
    hash.update(buffer.subarray(0, result.bytesRead));
    bytesRead += result.bytesRead;
  }
  if (diagnostics) {
    diagnostics.prefix_validation_bytes =
      Number(diagnostics.prefix_validation_bytes || 0) + bytesRead;
  }
  return bytesRead === end ? hash.digest("hex") : null;
}

async function openValidatedResumeFile(cached, entry, diagnostics = null) {
  if (
    !cached?.resumeState ||
    !cached?.stat ||
    !cached?.contentHashState ||
    typeof cached.contentHashState.copy !== "function" ||
    cached.appendable !== true ||
    cached.filePath !== entry.filePath
  ) return null;
  const previous = cached.stat;
  const current = entry.stat;
  if (
    Number(previous.dev) !== Number(current.dev) ||
    Number(previous.ino) !== Number(current.ino) ||
    Number(current.size) <= Number(previous.size) ||
    Number(cached.endOffset) < 0 ||
    Number(cached.endOffset) > Number(previous.size)
  ) {
    return null;
  }
  let handle = null;
  let keepOpen = false;
  try {
    // Validation and suffix parsing share this handle so a path replacement
    // cannot splice cached aggregates onto bytes from a different file.
    handle = await fs.promises.open(entry.filePath, "r");
    if (diagnostics) diagnostics.stat_calls += 1;
    const opened = await handle.stat();
    if (
      statIdentity(entry.filePath, opened) !==
      statIdentity(entry.filePath, current)
    ) return null;

    const expected = cached.contentHashState.copy().digest("hex");
    const actual = await digestFilePrefix(
      handle,
      cached.endOffset,
      diagnostics,
    );
    if (actual !== expected) return null;
    if (diagnostics) diagnostics.stat_calls += 1;
    const afterValidation = await handle.stat();
    if (
      statIdentity(entry.filePath, current) !==
        statIdentity(entry.filePath, afterValidation) &&
      !isUnlinkedResumeSnapshot(entry.filePath, current, afterValidation)
    ) return null;
    keepOpen = true;
    return handle;
  } catch {
    return null;
  } finally {
    if (handle && !keepOpen) {
      try {
        await handle.close();
      } catch {
        // A failed validation already forces the conservative full parse.
      }
    }
  }
}

function rememberParsedGroup(key, value) {
  PARSED_GROUP_CACHE.delete(key);
  PARSED_GROUP_CACHE.set(key, value);
  while (PARSED_GROUP_CACHE.size > MAX_PARSED_GROUP_CACHE_ENTRIES) {
    const oldest = PARSED_GROUP_CACHE.keys().next().value;
    if (!oldest) break;
    PARSED_GROUP_CACHE.delete(oldest);
  }
}

function splitCapturedParse(parsed) {
  const {
    resumeState = null,
    endOffset = 0,
    appendable = false,
    contentHashState = null,
    ...result
  } = parsed;
  return { parsed: result, resumeState, endOffset, appendable, contentHashState };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function computeCodexContextBreakdown({
  from = null,
  to = null,
  period = null,
  date = null,
  codexDir = null,
  top = 20,
  timeZoneContext = null,
  exhaustive = false,
  nowMs = Date.now(),
  includeDiagnostics = false,
} = {}) {
  let fromKey = from;
  let toKey = to;
  if ((!fromKey && !toKey) && normalizePeriod(period)) {
    const range = buildDateRange({ period: normalizePeriod(period), date });
    fromKey = range?.from || null;
    toKey = range?.to || null;
  }

  const codexHome = resolveEnvRoot("codex", { env: process.env, home: os.homedir() }) || path.join(os.homedir(), ".codex");
  const roots = codexDir
    ? [codexDir]
    : [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const baseDir = roots.join(path.delimiter);
  const diagnostics = {
    cache_hit: false,
    full_metadata_audit: false,
    discovered_files: 0,
    candidate_files: 0,
    stat_calls: 0,
    metadata_cache_hits: 0,
    opened_files: 0,
    parsed_files: 0,
    parse_cache_hits: 0,
    incremental_parse_hits: 0,
    incremental_parse_fallbacks: 0,
    bytes_read: 0,
    prefix_validation_bytes: 0,
    json_parse_calls: 0,
  };
  const discovered = discoverCodexSessionFiles(roots, {
    from: fromKey,
    to: toKey,
    timeZoneContext,
    exhaustive,
    nowMs,
    diagnostics,
  });
  const candidates = discovered.filter((entry) => entry.candidate);
  const fileSignature = inventorySignature(discovered);
  const cacheKey = [
    CACHE_SCHEMA_VERSION,
    baseDir,
    fromKey || "",
    toKey || "",
    cacheTimeZoneKey(timeZoneContext),
    Number.isFinite(top) ? top : 20,
    exhaustive ? "exhaustive" : "bounded",
    fileSignature,
  ].join("|");
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    diagnostics.cache_hit = true;
    return includeDiagnostics ? { ...cached.value, diagnostics } : cached.value;
  }

  const sessions = [];
  const seenTokenEvents = new Set();

  const candidateGroups = new Map();
  for (const entry of candidates) {
    const sessionKey = rolloutSessionIdFromPath(entry.filePath) || entry.filePath;
    if (!candidateGroups.has(sessionKey)) candidateGroups.set(sessionKey, []);
    candidateGroups.get(sessionKey).push(entry);
  }
  const appendHashPaths = selectAppendHashPaths(candidateGroups);

  for (const entries of candidateGroups.values()) {
    const filePaths = entries.map((entry) => entry.filePath);
    const cacheable = Boolean(rolloutSessionIdFromPath(filePaths[0]));
    const parsedCacheKey = cacheable
      ? parsedGroupCacheKey(entries, { from: fromKey, to: toKey, timeZoneContext })
      : null;
    const signature = parsedGroupSignature(entries);
    const cachedGroup = parsedCacheKey ? PARSED_GROUP_CACHE.get(parsedCacheKey) : null;
    let parsed = null;
    if (cachedGroup?.signature === signature) {
      // Cacheable groups are partitioned by rollout UUID, so their token event
      // keys cannot overlap and cache hits need not backfill seenTokenEvents.
      diagnostics.parse_cache_hits += 1;
      parsed = cachedGroup.parsed;
      PARSED_GROUP_CACHE.delete(parsedCacheKey);
      PARSED_GROUP_CACHE.set(parsedCacheKey, cachedGroup);
    } else {
      let captured = null;
      const singleEntry = entries.length === 1 ? entries[0] : null;
      const appendHashEligible = Boolean(
        singleEntry && appendHashPaths.has(singleEntry.filePath),
      );
      const resumeHandle = appendHashEligible
        ? await openValidatedResumeFile(cachedGroup, singleEntry, diagnostics)
        : null;
      if (resumeHandle) {
        try {
          const resumed = await parseCodexRolloutFile(singleEntry.filePath, {
            from: fromKey,
            to: toKey,
            timeZoneContext,
            diagnostics,
            seenTokenEvents: new Set(),
            startOffset: cachedGroup.endOffset,
            endOffset: singleEntry.stat.size,
            resumeState: cachedGroup.resumeState,
            captureResumeState: true,
            captureContentHash: true,
            contentHashState: cachedGroup.contentHashState,
            sourceHandle: resumeHandle,
          });
          if (diagnostics) diagnostics.stat_calls += 1;
          const afterParse = await resumeHandle.stat().catch(() => null);
          let stableAfterParse = Boolean(
            afterParse &&
            statIdentity(singleEntry.filePath, afterParse) ===
              statIdentity(singleEntry.filePath, singleEntry.stat),
          );
          if (
            !stableAfterParse &&
            isUnlinkedResumeSnapshot(
              singleEntry.filePath,
              singleEntry.stat,
              afterParse,
            )
          ) {
            try {
              const expectedSnapshot = resumed.contentHashState.copy().digest("hex");
              const actualSnapshot = await digestFilePrefix(
                resumeHandle,
                singleEntry.stat.size,
                diagnostics,
              );
              stableAfterParse = actualSnapshot === expectedSnapshot;
            } catch {
              stableAfterParse = false;
            }
          }
          if (stableAfterParse) {
            const delta = splitCapturedParse(resumed);
            captured = {
              parsed: mergeParsedSessionResults(cachedGroup.parsed, delta.parsed),
              resumeState: delta.resumeState,
              endOffset: delta.endOffset,
              appendable: delta.appendable,
              contentHashState: delta.contentHashState,
            };
            diagnostics.incremental_parse_hits += 1;
          } else {
            diagnostics.incremental_parse_fallbacks += 1;
          }
        } catch (error) {
          if (!isCodexResumeInvalidated(error)) throw error;
          diagnostics.incremental_parse_fallbacks += 1;
        } finally {
          await resumeHandle.close();
        }
      }

      if (!captured) {
        let freshHandle = null;
        let freshEndOffset = singleEntry?.stat?.size ?? null;
        try {
          if (resumeHandle && singleEntry) {
            freshHandle = await fs.promises.open(singleEntry.filePath, "r");
            if (diagnostics) diagnostics.stat_calls += 1;
            freshEndOffset = (await freshHandle.stat()).size;
          }
          const fresh = await parseCodexRolloutFile(
            filePaths.length === 1 ? filePaths[0] : filePaths,
            {
              from: fromKey,
              to: toKey,
              timeZoneContext,
              diagnostics,
              seenTokenEvents: filePaths.length === 1 ? new Set() : seenTokenEvents,
              endOffset: freshEndOffset,
              captureResumeState: Boolean(singleEntry),
              captureContentHash: appendHashEligible,
              sourceHandle: freshHandle,
            },
          );
          captured = splitCapturedParse(fresh);
        } finally {
          await freshHandle?.close();
        }
      }

      parsed = captured.parsed;
      if (parsedCacheKey) {
        rememberParsedGroup(parsedCacheKey, {
          signature,
          parsed,
          resumeState: captured.resumeState,
          endOffset: captured.endOffset,
          appendable: captured.appendable === true,
          contentHashState: captured.contentHashState,
          filePath: singleEntry?.filePath || null,
          stat: singleEntry?.stat || null,
        });
      }
    }
    if (!parsed || !parsed.totals || !parsed.totals.total_tokens) continue;
    sessions.push(parsed);
  }

  const grand = emptyTotals();
  const byTool = new Map();
  const bySkill = new Map();
  const byExecType = new Map();
  const byExecExit = new Map();
  const byExecExecutable = new Map();
  const byExecCommand = new Map();
  const byExecDuration = new Map();
  const byExecOutput = new Map();

  for (const s of sessions) {
    mergeRollupTotals(grand, s.totals);
    mergeRows(byTool, s.toolBreakdown?.tool_rows);
    mergeSkillRows(bySkill, s.skillsBreakdown?.skill_rows);
    mergeExecRows(byExecType, s.execCommandBreakdown?.byType);
    mergeExecRows(byExecExit, s.execCommandBreakdown?.byExit);
    mergeExecRows(byExecExecutable, s.execCommandBreakdown?.byExecutable);
    mergeExecRows(byExecCommand, s.execCommandBreakdown?.byCommand);
    mergeExecRows(byExecDuration, s.execCommandBreakdown?.byDuration);
    mergeExecRows(byExecOutput, s.execCommandBreakdown?.byOutput);
  }

  const toolRows = finalizeToolRows(new Map([...byTool.entries()].map(([k, v]) => [k, v])));
  const skillRows = finalizeSkillRows(new Map([...bySkill.entries()].map(([k, v]) => [k, v])));
  const execTypeRows = finalizeExecRows(new Map([...byExecType.entries()].map(([k, v]) => [k, v])));
  const execExitRows = finalizeExecRows(new Map([...byExecExit.entries()].map(([k, v]) => [k, v])));
  const execExecutableRows = finalizeExecRows(new Map([...byExecExecutable.entries()].map(([k, v]) => [k, v])));
  const execCommandRows = finalizeExecRows(new Map([...byExecCommand.entries()].map(([k, v]) => [k, v])));
  const execDurationRows = finalizeExecRows(new Map([...byExecDuration.entries()].map(([k, v]) => [k, v])));
  const execOutputRows = finalizeExecRows(new Map([...byExecOutput.entries()].map(([k, v]) => [k, v])));
  const limitedTop = Number.isFinite(top) ? top : 20;
  const toolRowsLimited = toolRows.slice(0, limitedTop).map((r) => ({
    name: r.name,
    calls: Math.round(r.calls || 0),
    totals: roundTotals(r.totals),
  }));
  const skillRowsLimited = skillRows.slice(0, limitedTop).map((r) => ({
    name: r.name,
    calls: Math.round(r.calls || 0),
    totals: roundTotals(r.totals),
  }));

  const byCategory = new Map(); // category -> {name,calls,totals,tools:Map}
  for (const row of toolRows) {
    const cat = categorizeTool(row.raw_name || row.name);
    if (!byCategory.has(cat)) {
      byCategory.set(cat, { name: cat, calls: 0, totals: emptyTotals(), tools: new Map() });
    }
    const target = byCategory.get(cat);
    target.calls += row.calls || 0;
    mergeRollupTotals(target.totals, row.totals || {});
    target.tools.set(row.raw_name || row.name, row);
  }
  const categoryRows = Array.from(byCategory.values())
    .map((c) => ({
      name: c.name,
      calls: Math.round(c.calls || 0),
      totals: roundTotals(c.totals),
      tools: finalizeToolRows(new Map([...c.tools.entries()].map(([k, v]) => [k, v])))
        .slice(0, limitedTop)
        .map((r) => ({
          name: r.name,
          calls: Math.round(r.calls || 0),
          totals: roundTotals(r.totals),
        })),
    }))
    .sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));

  const textResponse = toolRows.find((row) => (row.raw_name || row.name) === "text_response");
  const textResponseTotals = textResponse?.totals || emptyTotals();
  const textResponseHistoryWeight = Math.max(
    0,
    Number(textResponseTotals.cached_input_tokens || 0) + Number(textResponseTotals.cache_creation_input_tokens || 0),
  );
  const textResponseInputWeight = Math.max(0, Number(textResponseTotals.input_tokens || 0));
  const textResponseOutputWeight = Math.max(
    0,
    Number(textResponseTotals.output_tokens || 0) - Number(textResponseTotals.reasoning_output_tokens || 0),
  );
  const displayedMessageTotal =
    textResponseInputWeight + textResponseHistoryWeight + textResponseOutputWeight;
  const messageAlloc = allocateByLargestRemainder(
    displayedMessageTotal,
    {
      user_input: textResponseInputWeight,
      conversation_history: textResponseHistoryWeight,
      assistant_response: textResponseOutputWeight,
    },
    ["user_input", "conversation_history", "assistant_response"],
  );
  const historyAlloc = allocateByLargestRemainder(
    messageAlloc.conversation_history || 0,
    {
      cached_input_tokens: Math.max(0, Number(textResponseTotals.cached_input_tokens || 0)),
      cache_creation_input_tokens: Math.max(0, Number(textResponseTotals.cache_creation_input_tokens || 0)),
    },
    ["cached_input_tokens", "cache_creation_input_tokens"],
  );
  const textResponseInput = messageAlloc.user_input || 0;
  const textResponseHistory = messageAlloc.conversation_history || 0;
  const textResponseOutput = messageAlloc.assistant_response || 0;
  const messageBreakdown = [
    {
      key: "user_input",
      name: "User input",
      totals: roundTotals({
        input_tokens: textResponseInput,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: textResponseInput,
      }),
    },
    {
      key: "conversation_history",
      name: "Conversation history",
      totals: roundTotals({
        input_tokens: 0,
        cached_input_tokens: historyAlloc.cached_input_tokens || 0,
        cache_creation_input_tokens: historyAlloc.cache_creation_input_tokens || 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: textResponseHistory,
      }),
    },
    {
      key: "assistant_response",
      name: "Assistant response",
      totals: roundTotals({
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: textResponseOutput,
        reasoning_output_tokens: 0,
        total_tokens: textResponseOutput,
      }),
    },
  ].sort((a, b) => (b.totals?.total_tokens || 0) - (a.totals?.total_tokens || 0));

  const serializeExecRows = (rows) => rows.slice(0, limitedTop).map((r) => ({
    name: r.name,
    calls: r.calls,
    failures: r.failures,
    duration_ms: r.duration_ms,
    max_duration_ms: r.max_duration_ms,
    output_chars: r.output_chars,
    output_lines: r.output_lines,
    totals: roundTotals(r.totals),
  }));

  const result = {
    source: "codex",
    scope: "supported",
    breakdown_status: "ok",
    totals: grand,
    session_count: new Set(sessions.map((session) => session.sessionId || session.filePath)).size,
    message_count: sessions.reduce((a, s) => a + (s.turnCount || 0), 0),
    message_breakdown: {
      categories: messageBreakdown,
      privacy: {
        includes_content: false,
        note: "Aggregated message token categories only; prompt and assistant text are never returned.",
      },
    },
    tool_calls_breakdown: {
      total_calls: Math.round(toolRows.reduce((a, r) => a + Number(r.calls || 0), 0)),
      tools: toolRowsLimited,
      categories: categoryRows.slice(0, limitedTop),
      tools_total: toolRows.reduce((a, r) => a + Math.round(r.totals?.total_tokens || 0), 0),
      privacy: {
        includes_inputs: false,
        note: "Aggregated tool names only; no tool arguments or outputs are included.",
      },
    },
    skills_breakdown: {
      total_calls: Math.round(skillRows.reduce((a, r) => a + Number(r.calls || 0), 0)),
      skills: skillRowsLimited,
      privacy: {
        includes_inputs: false,
        note: "Codex skill use is inferred from exec_command reads of SKILL.md; command arguments are not returned.",
      },
    },
    exec_command_breakdown: {
      by_type: serializeExecRows(execTypeRows),
      by_executable: serializeExecRows(execExecutableRows),
      by_command: serializeExecRows(execCommandRows),
      by_duration: serializeExecRows(execDurationRows),
      by_output: serializeExecRows(execOutputRows),
      by_exit: serializeExecRows(execExitRows),
    },
  };

  const cacheValue = { ...result };
  CACHE.set(cacheKey, { at: Date.now(), value: cacheValue });
  while (CACHE.size > 32) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) CACHE.delete(oldest[0]);
  }
  return includeDiagnostics ? { ...result, diagnostics } : result;
}

module.exports = {
  computeCodexContextBreakdown,
};
