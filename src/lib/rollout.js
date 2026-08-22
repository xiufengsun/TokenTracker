const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const crypto = require("node:crypto");
const { ensureDir, writeJson, chmod600IfPossible } = require("./fs");
const { physicalJsonlRecords } = require("./jsonl-lines");
const { readSqliteJsonRows, readSqliteJsonRowsAsync } = require("./sqlite-reader");
const wsl = require("./wsl-probe");
const { resolveInstallPaths } = require("./install-resolver");
const {
  consumeUsageDelta,
  createUsageDeltaState,
  snapshotUsageBaselines,
} = require("./codex-token-usage");

const DEFAULT_SOURCE = "codex";
const DEFAULT_MODEL = "unknown";
const BUCKET_SEPARATOR = "|";
const CLAUDE_MEM_OBSERVER_PATH_SEGMENT = "--claude-mem-observer-sessions";
const CLAUDE_MEM_OBSERVER_PROJECT_REF =
  "https://local.tokentracker/claude-mem/observer-sessions";
const PROJECT_ABSENT_CONTEXT_RESCAN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CODEX_COLD_SKIP_RECENT_DAYS = 2;

async function listRolloutFiles(sessionsDir, options = {}) {
  const out = [];
  const dayInventoryCache =
    options?.dayInventoryCache && typeof options.dayInventoryCache === "object"
      ? options.dayInventoryCache
      : null;
  const stats = options?.stats && typeof options.stats === "object" ? options.stats : null;
  if (dayInventoryCache) {
    if (dayInventoryCache.version !== 1) {
      dayInventoryCache.days = {};
    }
    dayInventoryCache.version = 1;
    if (!dayInventoryCache.days || typeof dayInventoryCache.days !== "object") {
      dayInventoryCache.days = {};
    }
  }
  const years = await safeReadDir(sessionsDir);
  for (const y of years) {
    if (!/^[0-9]{4}$/.test(y.name) || !y.isDirectory()) continue;
    const yearDir = path.join(sessionsDir, y.name);
    const months = await safeReadDir(yearDir);
    for (const m of months) {
      if (!/^[0-9]{2}$/.test(m.name) || !m.isDirectory()) continue;
      const monthDir = path.join(yearDir, m.name);
      const days = await safeReadDir(monthDir);
      for (const d of days) {
        if (!/^[0-9]{2}$/.test(d.name) || !d.isDirectory()) continue;
        const dayDir = path.join(monthDir, d.name);
        const files = await listRolloutDayFiles(dayDir, { dayInventoryCache, stats });
        out.push(...files);
      }
    }
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function listRolloutDayFiles(dayDir, { dayInventoryCache, stats } = {}) {
  const cacheDays = dayInventoryCache?.days;
  const dayStat = dayInventoryCache ? await fs.stat(dayDir).catch(() => null) : null;
  const statKey = dayStat && dayStat.isDirectory() ? directoryInventoryStatKey(dayStat) : null;
  const cached = cacheDays && cacheDays[dayDir];
  if (
    statKey &&
    cached &&
    typeof cached === "object" &&
    cached.statKey === statKey &&
    Array.isArray(cached.files) &&
    cached.files.every(isRolloutFileName)
  ) {
    if (stats) stats.dayInventoryCacheHits = Number(stats.dayInventoryCacheHits || 0) + 1;
    return cached.files.map((name) => path.join(dayDir, name));
  }

  if (stats && cached) stats.dayInventoryCacheMisses = Number(stats.dayInventoryCacheMisses || 0) + 1;
  const entries = await safeReadDir(dayDir);
  const files = [];
  for (const f of entries) {
    if (!f.isFile()) continue;
    if (!isRolloutFileName(f.name)) continue;
    files.push(f.name);
  }
  files.sort((a, b) => a.localeCompare(b));
  if (cacheDays && statKey) {
    cacheDays[dayDir] = {
      statKey,
      files,
      updatedAt: new Date().toISOString(),
    };
  }
  return files.map((name) => path.join(dayDir, name));
}

function isRolloutFileName(name) {
  if (typeof name !== "string") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name !== path.basename(name)) return false;
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

function directoryInventoryStatKey(st) {
  return [
    Number(st.ino || 0),
    Number(st.size || 0),
    Number(st.mtimeMs || 0),
    Number(st.ctimeMs || 0),
  ].join(":");
}

// Collect rollout-*.jsonl at ANY depth under dir. listRolloutFiles requires the
// strict YYYY/MM/DD/ nesting Codex itself writes, but Codex-Manager archives
// sessions FLAT into ~/.codex/archived_sessions/ (issue #187), so the strict
// scanner misses them. This recursive variant handles both flat and nested
// layouts; safe because the codex event dedup keys on sessionUUID + timestamp,
// so an archived copy of an already-counted session re-reads as a no-op.
async function listRolloutFilesDeep(dir) {
  const out = [];
  async function walk(d) {
    const entries = await safeReadDir(d);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        out.push(p);
      }
    }
  }
  await walk(dir);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function listClaudeProjectFiles(projectsDir) {
  const out = [];
  await walkClaudeProjects(projectsDir, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function listGeminiSessionFiles(tmpDir) {
  const out = [];
  const roots = await safeReadDir(tmpDir);
  for (const root of roots) {
    if (!root.isDirectory()) continue;
    const chatsDir = path.join(tmpDir, root.name, "chats");
    const chats = await safeReadDir(chatsDir);
    for (const entry of chats) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("session-") || !entry.name.endsWith(".json")) continue;
      out.push(path.join(chatsDir, entry.name));
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function listOpencodeMessageFiles(storageDir) {
  const out = [];
  const messageDir = path.join(storageDir, "message");
  await walkOpencodeMessages(messageDir, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function parseRolloutIncremental({
  rolloutFiles,
  cursors,
  codexEventStore,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
  diagnostics,
  invalidRecordPolicy = "skip",
}) {
  if (invalidRecordPolicy !== "skip" && invalidRecordPolicy !== "throw") {
    throw new TypeError(`unsupported invalidRecordPolicy: ${invalidRecordPolicy}`);
  }
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const totalFiles = Array.isArray(rolloutFiles) ? rolloutFiles.length : 0;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const projectFreshnessCache = projectEnabled ? new Map() : null;
  const projectFreshnessNowMs = Date.now();
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  const syncDiagnostics = diagnostics && typeof diagnostics === "object" ? diagnostics : null;

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  // Persisted set of seen Codex event keys (sessionUUID:eventTimestamp). Mirrors
  // the claudeHashes pattern: it makes an inode-changing re-scan idempotent so an
  // external rewrite of a session file (Codex-Manager's atomic provider-patch on
  // account switch, issue #187) cannot re-count already-counted events.
  const externalCodexEventStore =
    codexEventStore &&
    typeof codexEventStore.has === "function" &&
    typeof codexEventStore.add === "function"
      ? codexEventStore
      : null;
  const prevCodexHashes = Array.isArray(cursors?.codexHashes) ? cursors.codexHashes : [];
  if (!externalCodexEventStore && !Array.isArray(cursors.codexHashes)) {
    cursors.codexHashes = prevCodexHashes;
  }
  let seenCodexEvents = null;
  let newCodexEventKeys = null;
  let newCodexEventKeySet = null;
  let appendOnlyCodexEvents = null;
  let historicalCodexEvents = null;
  let cursorSessionPaths = null;
  if (syncDiagnostics) {
    const codexParseCandidates = (Array.isArray(rolloutFiles) ? rolloutFiles : []).reduce((count, entry) => {
      const entrySource = typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
      return count + (entrySource === DEFAULT_SOURCE ? 1 : 0);
    }, 0);
    const discoveredRollouts = Number(syncDiagnostics.discovered_rollouts);
    const cursorKeys = Number(syncDiagnostics.cursor_keys);
    const coldSkipped = Number(syncDiagnostics.cold_skipped);
    const parseCandidates = Number(syncDiagnostics.parse_candidates);
    Object.assign(syncDiagnostics, {
      discovered_rollouts: Number.isFinite(discoveredRollouts) ? discoveredRollouts : codexParseCandidates,
      cursor_keys: Number.isFinite(cursorKeys) ? cursorKeys : Object.keys(cursors.files).length,
      parse_candidates: Number.isFinite(parseCandidates) ? parseCandidates : codexParseCandidates,
      stat_candidates: 0,
      cold_skipped: Number.isFinite(coldSkipped) ? coldSkipped : 0,
      content_files_read: 0,
      hash_set_constructions: 0,
      hash_array_materializations: 0,
      hash_array_materialized_items: 0,
      codex_hash_count: externalCodexEventStore
        ? Number(externalCodexEventStore.size || 0)
        : prevCodexHashes.length,
    });
  }
  const ensureNewCodexEventKeys = () => {
    if (!newCodexEventKeys) newCodexEventKeys = [];
    if (!newCodexEventKeySet) newCodexEventKeySet = new Set();
  };
  const recordNewCodexEvent = (key) => {
    ensureNewCodexEventKeys();
    if (newCodexEventKeySet.has(key)) return;
    newCodexEventKeySet.add(key);
    newCodexEventKeys.push(key);
    if (seenCodexEvents) seenCodexEvents.add(key);
    externalCodexEventStore?.add(key);
  };
  const getAppendOnlyCodexEvents = () => {
    if (!appendOnlyCodexEvents) {
      appendOnlyCodexEvents = {
        has(key) {
          return Boolean(
            newCodexEventKeySet?.has(key) ||
            seenCodexEvents?.has(key)
          );
        },
        add: recordNewCodexEvent,
      };
    }
    return appendOnlyCodexEvents;
  };
  const getHistoricalCodexEvents = () => {
    if (externalCodexEventStore) {
      if (!historicalCodexEvents) {
        historicalCodexEvents = {
          has(key) {
            return Boolean(
              newCodexEventKeySet?.has(key) ||
              externalCodexEventStore.has(key)
            );
          },
          add: recordNewCodexEvent,
        };
      }
      return historicalCodexEvents;
    }
    if (!seenCodexEvents) {
      seenCodexEvents = new Set(prevCodexHashes);
      for (const key of newCodexEventKeys || []) seenCodexEvents.add(key);
      if (syncDiagnostics) syncDiagnostics.hash_set_constructions += 1;
    }
    if (!historicalCodexEvents) {
      historicalCodexEvents = {
        has: (key) => seenCodexEvents.has(key),
        add: recordNewCodexEvent,
      };
    }
    return historicalCodexEvents;
  };
  const getCursorSessionPaths = () => {
    if (cursorSessionPaths) return cursorSessionPaths;
    cursorSessionPaths = new Map();
    for (const existingPath of Object.keys(cursors.files)) {
      const sessionId = codexSessionIdFromPath(existingPath);
      if (!sessionId) continue;
      if (!cursorSessionPaths.has(sessionId)) cursorSessionPaths.set(sessionId, new Set());
      cursorSessionPaths.get(sessionId).add(existingPath);
    }
    return cursorSessionPaths;
  };
  const needsHistoricalCodexDedup = ({
    filePath,
    prev,
    sameInode,
    truncated,
    startOffset,
    rebuildingBaseline,
  }) => {
    if (rebuildingBaseline) return true;
    if (prev && (!sameInode || truncated)) return true;

    // Same session under another cursor path — the two roots of a `union`
    // install (src/lib/install-resolver.js) reaching one file, or a
    // sessions/ -> archived_sessions/ move. This MUST be decided before the
    // steady-state short-circuit below: the append-only tracker only knows keys
    // written during the current run, so when the other path has nothing new to
    // read it contributes none, and a path whose cursor fell behind (a distro
    // that was briefly unreachable, a TOKENTRACKER_WSL_MODE round-trip) replays
    // its gap into the persisted buckets. Only the persisted set can catch that.
    const sessionId = codexSessionIdFromPath(filePath);
    if (!sessionId) return true;
    const knownPaths = getCursorSessionPaths().get(sessionId);
    if (knownPaths) {
      for (const knownPath of knownPaths) {
        if (knownPath !== filePath) return true;
      }
    }

    // Steady state: one path, already read past, not rotated. Everything after
    // our own offset is genuinely new, so skip the persisted-set construction.
    if (sameInode && !truncated && startOffset > 0) return false;
    if (prev?.lastTotal) return true;
    return false;
  };

  for (let idx = 0; idx < rolloutFiles.length; idx++) {
    const entry = rolloutFiles[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    if (syncDiagnostics && fileSource === DEFAULT_SOURCE) syncDiagnostics.stat_candidates += 1;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    const sameInode = prev && prev.inode === inode;
    const prevOffset = sameInode ? prev.offset || 0 : 0;
    const truncated = sameInode && prevOffset > st.size;
    const rebuildingCodexBaseline = Boolean(
      fileSource === DEFAULT_SOURCE &&
      sameInode &&
      !truncated &&
      prevOffset > 0 &&
      prevOffset < st.size &&
      (!prev.lastTotal || typeof prev.lastTotal !== "object")
    );
    const startOffset = sameInode && !truncated && !rebuildingCodexBaseline ? prevOffset : 0;
    const lastTotal = sameInode && !truncated && !rebuildingCodexBaseline
      ? prev.lastTotal || null
      : null;
    const tokenUsageBaselines = sameInode && !truncated && !rebuildingCodexBaseline
      ? prev.tokenUsageBaselines || null
      : null;
    const lastModel = sameInode && !truncated ? prev.lastModel || null : null;

    const codexProjectFastPath = projectEnabled && fileSource === DEFAULT_SOURCE;
    const projectOffset = sameInode && !truncated ? Number(prev.projectOffset || 0) : 0;
    const projectUpToDate =
      codexProjectFastPath &&
      typeof publicRepoResolver !== "function" &&
      projectOffset >= st.size &&
      (await isProjectFileContextFresh(prev?.projectFileContext, {
        freshnessCache: projectFreshnessCache,
        nowMs: projectFreshnessNowMs,
      }));
    const projectContextOnlyScan =
      codexProjectFastPath &&
      typeof publicRepoResolver !== "function" &&
      sameInode &&
      !truncated &&
      startOffset >= st.size &&
      !projectUpToDate;
    if (
      sameInode &&
      !truncated &&
      startOffset >= st.size &&
      (!projectEnabled || projectUpToDate)
    ) {
      if (cb) {
        cb({
          index: idx + 1,
          total: totalFiles,
          filePath,
          filesProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
      continue;
    }

    const projectContext = projectEnabled
      ? await resolveProjectContextForFile({
          filePath,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        })
      : null;
    const projectRef = projectContext?.projectRef || null;
    const projectKey = projectContext?.projectKey || null;

    if (syncDiagnostics && !projectContextOnlyScan && fileSource === DEFAULT_SOURCE) {
      syncDiagnostics.content_files_read += 1;
    }
    const codexEventTracker = fileSource === DEFAULT_SOURCE
      ? (needsHistoricalCodexDedup({
          filePath,
          prev,
          sameInode,
          truncated,
          startOffset,
          rebuildingBaseline: rebuildingCodexBaseline,
        })
          ? getHistoricalCodexEvents
          : getAppendOnlyCodexEvents)
      : null;
    const result = projectContextOnlyScan
      ? await scanRolloutProjectFileContexts({
          filePath,
          fileStat: st,
          lastTotal,
          tokenUsageBaselines,
          lastModel,
          projectState,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectContext,
          invalidRecordPolicy,
        })
      : await parseRolloutFile({
          filePath,
          fileStat: st,
          startOffset,
          lastTotal,
          tokenUsageBaselines,
          lastModel,
          hourlyState,
          touchedBuckets,
          source: fileSource,
          projectState,
          projectTouchedBuckets,
          projectRef,
          projectKey,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectContext,
          seenCodexEvents: codexEventTracker,
          sessionId: codexSessionIdFromPath(filePath),
          invalidRecordPolicy,
        });

    const nextCursor = {
      inode,
      offset: result.endOffset,
      lastTotal: result.lastTotal,
      tokenUsageBaselines: result.tokenUsageBaselines,
      lastModel: result.lastModel,
      updatedAt: new Date().toISOString(),
    };
    if (codexProjectFastPath) {
      nextCursor.projectOffset = result.endOffset;
      nextCursor.projectFileContext = buildProjectFileContext(
        result.projectFileContexts,
        projectFreshnessNowMs,
      );
    } else if (Number.isFinite(prev?.projectOffset)) {
      nextCursor.projectOffset = prev.projectOffset;
      if (prev?.projectFileContext) nextCursor.projectFileContext = prev.projectFileContext;
    }
    cursors.files[key] = nextCursor;

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  if (!externalCodexEventStore) {
    for (const key of newCodexEventKeys || []) prevCodexHashes.push(key);
  }
  if (syncDiagnostics) {
    syncDiagnostics.codex_hash_count = externalCodexEventStore
      ? Number(externalCodexEventStore.size || 0)
      : Array.isArray(cursors.codexHashes)
        ? cursors.codexHashes.length
        : prevCodexHashes.length;
  }
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function filterColdCodexRolloutFiles({
  rolloutFiles,
  cursors,
  codexCursorStore = null,
  projectEnabled = false,
  auditDue = false,
  nowMs = Date.now(),
  recentDays = DEFAULT_CODEX_COLD_SKIP_RECENT_DAYS,
  diagnostics = null,
} = {}) {
  const files = Array.isArray(rolloutFiles) ? rolloutFiles : [];
  const syncDiagnostics = diagnostics && typeof diagnostics === "object" ? diagnostics : null;
  const isCodexEntry = (entry) => (
    typeof entry === "string" || (normalizeSourceInput(entry?.source) || DEFAULT_SOURCE) === DEFAULT_SOURCE
  );
  if (syncDiagnostics) {
    const discoveredRollouts = files.reduce(
      (count, entry) => count + (isCodexEntry(entry) ? 1 : 0),
      0,
    );
    syncDiagnostics.discovered_rollouts = discoveredRollouts;
    syncDiagnostics.cursor_keys = Number.isFinite(codexCursorStore?.fileCount)
      ? codexCursorStore.fileCount
      : Object.keys(cursors?.files || {}).length;
    syncDiagnostics.cold_skipped = 0;
    syncDiagnostics.parse_candidates = discoveredRollouts;
  }
  if (
    !codexCursorStore &&
    (auditDue || !cursors?.files || typeof cursors.files !== "object")
  ) {
    return { rolloutFiles: files, skipped: 0 };
  }

  const activeDates = activeCodexRolloutDates(files, { nowMs, recentDays });
  const freshnessCache = new Map();
  const cursorLoadDirectories = new Set();
  const coldDaySkipDecisions = new Map();
  const out = [];
  let skipped = 0;
  let cursorStoreRestarted = false;

  const loadCodexCursorDirectory = async (filePath) => {
    if (!codexCursorStore) return;
    const directory = path.dirname(filePath);
    if (cursorLoadDirectories.has(directory)) return;
    cursorLoadDirectories.add(directory);
    const result = await codexCursorStore.loadCodexFilesForPaths([filePath], cursors);
    if (result?.restarted) cursorStoreRestarted = true;
  };

  const canSkipCodexDirectory = async (filePath) => {
    if (!codexCursorStore) return false;
    const directory = path.dirname(filePath);
    if (coldDaySkipDecisions.has(directory)) {
      return coldDaySkipDecisions.get(directory);
    }
    const decision = await codexCursorStore.canSkipCodexDay({
      filePath,
      dayInventoryCache: cursors?.codexDayInventoryCache,
      nowMs,
    });
    coldDaySkipDecisions.set(directory, decision);
    return decision;
  };

  for (const entry of files) {
    const filePath = typeof entry === "string" ? entry : entry?.path;
    const source =
      typeof entry === "string"
        ? DEFAULT_SOURCE
        : normalizeSourceInput(entry?.source) || DEFAULT_SOURCE;
    if (!filePath || source !== DEFAULT_SOURCE) {
      out.push(entry);
      continue;
    }

    const rolloutDate = rolloutDateFromPath(filePath);
    if (!rolloutDate || activeDates.has(rolloutDate)) {
      await loadCodexCursorDirectory(filePath);
      if (cursorStoreRestarted) break;
      out.push(entry);
      continue;
    }

    if (auditDue) {
      await loadCodexCursorDirectory(filePath);
      if (cursorStoreRestarted) break;
      out.push(entry);
      continue;
    }

    if (await canSkipCodexDirectory(filePath)) {
      skipped += 1;
      continue;
    }

    await loadCodexCursorDirectory(filePath);
    if (cursorStoreRestarted) break;

    const prev = cursors.files[filePath];
    const cachedSize = Number(prev?.offset);
    if (!Number.isFinite(cachedSize) || cachedSize <= 0) {
      out.push(entry);
      continue;
    }

    if (projectEnabled) {
      const projectOffset = Number(prev?.projectOffset);
      if (!Number.isFinite(projectOffset) || projectOffset < cachedSize) {
        out.push(entry);
        continue;
      }
      if (
        !(await isProjectFileContextFresh(prev?.projectFileContext, {
          freshnessCache,
          nowMs,
        }))
      ) {
        out.push(entry);
        continue;
      }
    }

    skipped += 1;
  }

  if (cursorStoreRestarted) {
    await codexCursorStore.loadCodexFilesForPaths(files, cursors);
    if (syncDiagnostics) {
      syncDiagnostics.cold_skipped = 0;
      syncDiagnostics.parse_candidates = files.reduce(
        (count, entry) => count + (isCodexEntry(entry) ? 1 : 0),
        0,
      );
    }
    return { rolloutFiles: files, skipped: 0, restarted: true };
  }

  if (syncDiagnostics) {
    syncDiagnostics.cold_skipped = skipped;
    syncDiagnostics.parse_candidates = out.reduce(
      (count, entry) => count + (isCodexEntry(entry) ? 1 : 0),
      0,
    );
  }
  return { rolloutFiles: out, skipped, restarted: false };
}

function activeCodexRolloutDates(
  rolloutFiles,
  { nowMs = Date.now(), recentDays = DEFAULT_CODEX_COLD_SKIP_RECENT_DAYS } = {},
) {
  const active = new Set();
  const days = Math.max(1, Math.floor(Number(recentDays) || 1));
  const now = new Date(nowMs);
  if (Number.isFinite(now.getTime())) {
    for (let i = 0; i < days; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      active.add(formatLocalDate(d));
    }
  }

  let latest = null;
  for (const entry of Array.isArray(rolloutFiles) ? rolloutFiles : []) {
    const filePath = typeof entry === "string" ? entry : entry?.path;
    const source =
      typeof entry === "string"
        ? DEFAULT_SOURCE
        : normalizeSourceInput(entry?.source) || DEFAULT_SOURCE;
    if (source !== DEFAULT_SOURCE) continue;
    const rolloutDate = rolloutDateFromPath(filePath);
    if (rolloutDate && (!latest || rolloutDate > latest)) latest = rolloutDate;
  }
  if (latest) active.add(latest);

  return active;
}

function formatLocalDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Identity hash for cross-environment duplicate session files (native and
// \\wsl$ views of a synced ~/.claude). sha256 of the first 64KB plus the
// file size: Claude session headers carry sessionId/cwd so the prefix is
// discriminating, and folding in the size keeps a grown file distinct from
// a stale copy. Deliberately excludes inode (unstable across the 9p bridge)
// and mtime (rewritten by sync tools).
const CLAUDE_FILE_ID_PREFIX_BYTES = 64 * 1024;
async function claudeFileIdentityHash(filePath, st) {
  const length = Math.min(CLAUDE_FILE_ID_PREFIX_BYTES, st.size);
  if (length <= 0) return null;
  let fh = null;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    const hash = crypto.createHash("sha256").update(buf.subarray(0, bytesRead)).digest("hex");
    return `${hash}:${st.size}`;
  } catch (_e) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => { });
  }
}

async function parseClaudeIncremental({
  projectFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const files = Array.isArray(projectFiles) ? projectFiles : [];
  const totalFiles = files.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  // Sessions cluster into few repos, so the per-file freshness checks below
  // keep stat-ing the same handful of .git/config paths. Share one stat per
  // config per run, as the Codex path does — it matters most for WSL installs,
  // where every stat crosses the \\wsl$ bridge (#374).
  const projectFreshnessCache = projectEnabled ? new Map() : null;
  const touchedBuckets = new Set();
  // Persist seenMessageHashes across syncs to prevent cross-file duplicates
  // (e.g. subagent file created after main session was already parsed).
  const prevHashes = Array.isArray(cursors.claudeHashes) ? cursors.claudeHashes : [];
  const seenMessageHashes = new Set(prevHashes);
  const defaultSource = normalizeSourceInput(source) || "claude";

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  // Cross-environment file dedup (#307): when the scan list mixes native and
  // \\wsl$ paths, a session file synced between the environments shows up
  // twice under different paths. Identify never-parsed files by content hash
  // and skip the duplicate wholesale — the message-hash layer alone is capped
  // at 100k entries, and eviction would let bulk history double count.
  let sawUncFile = false;
  let sawLocalFile = false;
  for (const entry of files) {
    const p = typeof entry === "string" ? entry : entry?.path;
    if (typeof p !== "string" || !p) continue;
    if (isUncPath(p)) sawUncFile = true;
    else sawLocalFile = true;
    if (sawUncFile && sawLocalFile) break;
  }
  const seenFileIds = sawUncFile && sawLocalFile ? new Map() : null;

  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    const sameInode = prev && prev.inode === inode;
    const prevOffset = sameInode ? prev.offset || 0 : 0;
    const truncated = sameInode && prevOffset > st.size;
    const startOffset = sameInode && !truncated ? prevOffset : 0;

    let fileId = null;
    if (seenFileIds) {
      const cachedFileId =
        sameInode && typeof prev?.fileId === "string" && prev?.fileIdSize === st.size
          ? prev.fileId
          : null;
      fileId = cachedFileId || (await claudeFileIdentityHash(filePath, st));
      if (fileId) {
        // Cache on the live cursor object so idle files don't re-hash on
        // every sync (the idle short-circuit below never rewrites cursors).
        if (prev && (prev.fileId !== fileId || prev.fileIdSize !== st.size)) {
          prev.fileId = fileId;
          prev.fileIdSize = st.size;
        }
        const primary = seenFileIds.get(fileId);
        if (primary === undefined) {
          seenFileIds.set(fileId, filePath);
        } else if (!prev && primary !== filePath) {
          // Never-parsed duplicate of a file already accounted this run (the
          // native copy sorts first). Mark it caught-up so future syncs only
          // look at genuinely new tail bytes — message hashes still guard the
          // tail if the copies diverge later.
          cursors.files[key] = {
            inode,
            offset: st.size,
            updatedAt: new Date().toISOString(),
            fileId,
            fileIdSize: st.size,
            duplicateOf: primary,
            ...(projectEnabled
              ? {
                  claudeCwd: null,
                  projectFileContext: buildProjectFileContext(null),
                  projectRef: null,
                  projectKey: null,
                }
              : {}),
          };
          if (cb) {
            cb({
              index: idx + 1,
              total: totalFiles,
              filePath,
              filesProcessed,
              eventsAggregated,
              bucketsQueued: touchedBuckets.size,
            });
          }
          continue;
        }
      }
    }

    // Claude's launch cwd is fixed for a session file's lifetime, so once
    // resolved (found, or confirmed absent) from content it never needs
    // re-extracting. Cache it — and the resolved project's git-config
    // freshness fingerprint — on the cursor so idle files with project
    // tracking enabled don't re-walk the filesystem on every sync.
    //
    // "No cwd found" / "cwd not inside a git checkout" only count as settled
    // for genuinely idle files (no new bytes) — there's nothing new to
    // attribute either way. A file that's still growing gets retried: an
    // early sync can catch a session file before its cwd-bearing line lands,
    // and treating that as permanent would silently drop the rest of the
    // session's usage from the project queue.
    const idle = sameInode && !truncated && startOffset >= st.size;
    const cachedCwd = sameInode && !truncated ? prev?.claudeCwd : undefined;
    const cachedProjectFileContext =
      sameInode && !truncated ? prev?.projectFileContext || null : null;
    const cachedContextAbsent = cachedProjectFileContext?.absent === true;
    const projectContextFresh =
      projectEnabled && cachedProjectFileContext && !cachedContextAbsent
        ? await isProjectFileContextFresh(cachedProjectFileContext, {
            freshnessCache: projectFreshnessCache,
          })
        : false;
    const projectKnownAbsent = cachedCwd === null || cachedContextAbsent;
    const projectSettled =
      !projectEnabled || (idle && projectKnownAbsent) || projectContextFresh;

    if (idle && projectSettled) {
      if (cb) {
        cb({
          index: idx + 1,
          total: totalFiles,
          filePath,
          filesProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
      continue;
    }

    let projectRef = sameInode && !truncated ? prev?.projectRef || null : null;
    let projectKey = sameInode && !truncated ? prev?.projectKey || null : null;
    let nextCwd = cachedCwd;
    let nextProjectFileContext = cachedProjectFileContext;

    if (projectEnabled && !projectSettled) {
      if (nextCwd === undefined || nextCwd === null) {
        nextCwd = await resolveClaudeFileCwd(filePath);
      }
      if (nextCwd) {
        const projectContext = await resolveProjectContextForPath({
          startDir: wsl.mapWslCwdToUnc(nextCwd, filePath),
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        });
        projectRef = projectContext?.projectRef || null;
        projectKey = projectContext?.projectKey || null;
        nextProjectFileContext = buildProjectFileContext(projectContext);
      } else {
        projectRef = null;
        projectKey = null;
        nextProjectFileContext = buildProjectFileContext(null);
      }
    }

    const result = await parseClaudeFile({
      filePath,
      fileStat: st,
      startOffset,
      hourlyState,
      touchedBuckets,
      source: fileSource,
      projectState,
      projectTouchedBuckets,
      projectRef,
      projectKey,
      seenMessageHashes,
    });

    cursors.files[key] = {
      inode,
      offset: result.endOffset,
      updatedAt: new Date().toISOString(),
      ...(fileId ? { fileId, fileIdSize: st.size } : {}),
      ...(projectEnabled
        ? {
            claudeCwd: nextCwd === undefined ? null : nextCwd,
            projectFileContext: nextProjectFileContext,
            projectRef,
            projectKey,
          }
        : {}),
    };

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }
  // Persist message hashes for cross-sync dedup; cap at 100k entries to bound size.
  const allHashes = Array.from(seenMessageHashes);
  cursors.claudeHashes =
    allHashes.length > 100_000 ? allHashes.slice(allHashes.length - 100_000) : allHashes;

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function parseGeminiIncremental({
  sessionFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const files = Array.isArray(sessionFiles) ? sessionFiles : [];
  const totalFiles = files.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || "gemini";

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    const size = Number.isFinite(st.size) ? st.size : 0;
    const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
    const sameFileMetadata =
      prev &&
      prev.inode === inode &&
      prev.size === size &&
      prev.mtimeMs === mtimeMs;
    if (!projectEnabled && sameFileMetadata) {
      if (cb) {
        cb({
          index: idx + 1,
          total: totalFiles,
          filePath,
          filesProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
      continue;
    }
    let startIndex = prev && prev.inode === inode ? Number(prev.lastIndex || -1) : -1;
    let lastTotals = prev && prev.inode === inode ? prev.lastTotals || null : null;
    let lastModel = prev && prev.inode === inode ? prev.lastModel || null : null;

    const projectContext = projectEnabled
      ? await resolveProjectContextForFile({
          filePath,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        })
      : null;
    const projectRef = projectContext?.projectRef || null;
    const projectKey = projectContext?.projectKey || null;
    const projectCursor =
      projectKey &&
      prev?.project &&
      prev.project.projectKey === projectKey &&
      prev.project.projectRef === projectRef
        ? prev.project
        : null;
    const projectUpToDate =
      projectKey &&
      sameFileMetadata &&
      projectCursor &&
      Number(projectCursor.lastIndex ?? -1) >= Number(prev?.lastIndex ?? -1);
    if (projectUpToDate) {
      if (cb) {
        cb({
          index: idx + 1,
          total: totalFiles,
          filePath,
          filesProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
      continue;
    }

    const result = await parseGeminiFile({
      filePath,
      startIndex,
      lastTotals,
      lastModel,
      projectCursor,
      hourlyState,
      touchedBuckets,
      source: fileSource,
      projectState,
      projectTouchedBuckets,
      projectRef,
      projectKey,
    });

    cursors.files[key] = {
      inode,
      size,
      mtimeMs,
      lastIndex: result.lastIndex,
      lastTotals: result.lastTotals,
      lastModel: result.lastModel,
      updatedAt: new Date().toISOString(),
    };
    if (projectKey) {
      cursors.files[key].project = {
        projectKey,
        projectRef,
        lastIndex: result.projectLastIndex,
        lastTotals: result.projectLastTotals,
        lastModel: result.projectLastModel,
        updatedAt: new Date().toISOString(),
      };
    } else if (prev?.project) {
      cursors.files[key].project = prev.project;
    }

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function parseOpencodeIncremental({
  messageFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const files = Array.isArray(messageFiles) ? messageFiles : [];
  const totalFiles = files.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const opencodeState = normalizeOpencodeState(cursors?.opencode);
  const messageIndex = opencodeState.messages;
  const fingerprintIndex = buildOpencodeFingerprintIndex(messageIndex);
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || "opencode";

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    const size = Number.isFinite(st.size) ? st.size : 0;
    const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
    const unchanged =
      prev &&
      prev.inode === inode &&
      prev.size === size &&
      prev.mtimeMs === mtimeMs &&
      prev.opencodeForkRepairVersion === 1;
    if (unchanged) {
      filesProcessed += 1;
      if (cb) {
        cb({
          index: idx + 1,
          total: totalFiles,
          filePath,
          filesProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
      continue;
    }

    const fallbackTotals = prev && typeof prev.lastTotals === "object" ? prev.lastTotals : null;
    const fallbackMessageKey =
      prev && typeof prev.messageKey === "string" && prev.messageKey.trim()
        ? prev.messageKey.trim()
        : null;
    const projectContext = projectEnabled
      ? await resolveProjectContextForFile({
          filePath,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        })
      : null;
    const projectRef = projectContext?.projectRef || null;
    const projectKey = projectContext?.projectKey || null;

    const result = await parseOpencodeMessageFile({
      filePath,
      messageIndex,
      fingerprintIndex,
      fallbackTotals,
      fallbackMessageKey,
      hourlyState,
      touchedBuckets,
      source: fileSource,
      projectState,
      projectTouchedBuckets,
      projectRef,
      projectKey,
    });

    cursors.files[key] = {
      inode,
      size,
      mtimeMs,
      lastTotals: result.lastTotals,
      messageKey: result.messageKey || null,
      opencodeForkRepairVersion: 1,
      updatedAt: new Date().toISOString(),
    };

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (result.messageKey && result.shouldUpdate) {
      recordOpencodeMessage({
        messageIndex,
        fingerprintIndex,
        messageKey: result.messageKey,
        totals: result.lastTotals,
        fingerprint: result.fingerprint || null,
        dedupedForkCopy: result.dedupedForkCopy === true,
      });
    }

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  opencodeState.updatedAt = new Date().toISOString();
  cursors.opencode = opencodeState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

// Passive discovery of OpenClaw session transcripts (issue #264). OpenClaw was
// previously counted ONLY when its session plugin fired an `agent_end` hook and
// pointed sync at one specific <sessionId>.jsonl. That hook silently fails for a
// whole class of real usage — messages arriving through a channel (e.g. the
// WeChat ClawBot) whose sessionKey the plugin can't map back to a sessions.json
// entry, gateways where the plugin never loaded, or newer installs that keep
// runtime rows in SQLite and only leave archived transcripts on disk. In all of
// those cases usage exists but shows as 0. Scanning the on-disk transcripts on
// every full sync (like every other passive provider) closes that gap; the
// event-identity dedup in parseOpenclawSessionFile makes a plugin trigger and a
// passive scan of the same file idempotent, so the two paths never double-count.
// Mirrors OpenClaw's own precedence (OPENCLAW_HOME > state dir override), but
// deliberately keeps os.homedir() — NOT env.HOME — as the base. OpenClaw itself
// prefers env.HOME, yet every OpenClaw cursor we have ever written was keyed off
// an os.homedir()-derived path; switching the base would make Git Bash / MSYS
// (HOME=/c/Users/x vs C:\Users\x) miss its own cursor and re-count the whole
// transcript history.
function resolveOpenclawHome(env = process.env) {
  const override =
    (typeof env.TOKENTRACKER_OPENCLAW_HOME === "string" && env.TOKENTRACKER_OPENCLAW_HOME.trim()) ||
    (typeof env.OPENCLAW_HOME === "string" && env.OPENCLAW_HOME.trim()) ||
    (typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim()) ||
    "";
  return override || path.join(os.homedir(), ".openclaw");
}

// On Windows the recommended OpenClaw install provisions an app-owned WSL
// distro and runs the gateway inside it, so %USERPROFILE%\.openclaw is empty
// while the real state dir sits on the distro's ext4 home (issue #264).
function resolveOpenclawHomes(env = process.env, deps = {}) {
  const roots = [resolveOpenclawHome(env)];
  const platform = deps.platform || process.platform;
  const overridden =
    env.TOKENTRACKER_OPENCLAW_HOME || env.OPENCLAW_HOME || env.OPENCLAW_STATE_DIR;
  if (platform === "win32" && !overridden) {
    const discoverWslHome = deps.discoverWslHome || wsl.discoverWslHome;
    const wslRoot = wsl.shouldProbeWsl(env) ? discoverWslHome(".openclaw", { ...deps, env }) : null;
    if (wslRoot) roots.push(wslRoot);
  }
  return roots;
}

// Transcript artifacts are not always a bare `<sessionId>.jsonl`: resets and
// deletes leave `<sessionId>.jsonl.reset.<iso>` / `.deleted.<ts>` siblings, and
// the SQLite migration moves still-hot transcripts into
// `session-sqlite-import-archive/`. Match the same `*.jsonl*` shape other
// OpenClaw readers use so those are not silently dropped.
const OPENCLAW_TRANSCRIPT_SUBDIRS = ["sessions", "session-sqlite-import-archive"];

function isOpenclawTranscriptName(name) {
  return typeof name === "string" && name.includes(".jsonl") && !name.endsWith(".json");
}

async function resolveOpenclawSessionFiles(env = process.env, deps = {}) {
  const out = [];
  const seen = new Set();
  for (const openclawHome of resolveOpenclawHomes(env, deps)) {
    const agentsDir = path.join(openclawHome, "agents");
    const agents = await safeReadDir(agentsDir);
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      for (const subdir of OPENCLAW_TRANSCRIPT_SUBDIRS) {
        const dir = path.join(agentsDir, agent.name, subdir);
        const entries = await safeReadDir(dir);
        for (const entry of entries) {
          if (!entry.isFile() || !isOpenclawTranscriptName(entry.name)) continue;
          const full = path.join(dir, entry.name);
          const key = openclawCursorKey(full);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(full);
        }
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function parseOpenclawIncremental({
  sessionFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const files = Array.isArray(sessionFiles) ? sessionFiles : [];
  const totalFiles = files.length;
  const hourlyState = normalizeHourlyState(
    cursors?.hourly ? structuredClone(cursors.hourly) : null,
  );
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled
    ? normalizeProjectState(
        cursors?.projectHourly ? structuredClone(cursors.projectHourly) : null,
      )
    : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || "openclaw";

  const stagedFiles =
    cursors.files && typeof cursors.files === "object"
      ? { ...cursors.files }
      : {};
  const cursorKeys = new Map();
  for (const existingKey of Object.keys(stagedFiles)) {
    cursorKeys.set(openclawCursorKey(existingKey), existingKey);
  }

  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const key = openclawCursorKey(filePath);
    const previousKey = cursorKeys.get(key);
    const prev = previousKey ? stagedFiles[previousKey] : null;
    const prevUsageEvents =
      prev?.usageEvents && typeof prev.usageEvents === "object" ? prev.usageEvents : {};
    const hasUsageEventCursor =
      prev &&
      Object.prototype.hasOwnProperty.call(prev, "usageEvents") &&
      prev.usageEvents &&
      typeof prev.usageEvents === "object";
    const legacyCursor = prev && !hasUsageEventCursor;
    const previousOffset = Number(prev?.offset || 0);
    let accepted = null;
    let openedRegularFile = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fileHandle = await fs.open(filePath, "r").catch(() => null);
      if (!fileHandle) break;
      try {
        const openedStat = await fileHandle.stat();
        if (!openedStat.isFile()) break;
        openedRegularFile = true;
        const fileEndOffset = openedStat.size;
        let prefixFingerprint = null;
        let prefixFingerprintState = null;
        const offsetBoundaryMatches =
          hasUsageEventCursor &&
          previousOffset <= fileEndOffset &&
          await openclawOffsetEndsAtLineBoundary(fileHandle, previousOffset);
        const parsedLegacyUpdatedAt = Date.parse(String(prev?.updatedAt || ""));
        const legacyAggregateAfterMs =
          legacyCursor
            ? Number.isFinite(parsedLegacyUpdatedAt)
              ? parsedLegacyUpdatedAt
              : Number.POSITIVE_INFINITY
            : null;
        if (
          hasUsageEventCursor &&
          offsetBoundaryMatches &&
          prev?.usageFingerprint
        ) {
          const prefix = await parseOpenclawSessionFile({
            filePath,
            fileHandle,
            startOffset: 0,
            endOffsetLimit: previousOffset,
            previousUsageEvents: {},
            appendOnly: false,
            collectOnly: true,
          });
          prefixFingerprint = prefix.usageFingerprint;
          prefixFingerprintState = prefix.usageFingerprintState;
        }
        const appendOnly =
          hasUsageEventCursor &&
          previousOffset <= fileEndOffset &&
          offsetBoundaryMatches &&
          sameOpenclawUsageFingerprint(
            prefixFingerprint,
            prev.usageFingerprint,
          );
        const startOffset = appendOnly ? previousOffset : 0;
        const attemptHourly = { version: 3, buckets: {}, groupQueued: {} };
        const attemptTouched = new Set();
        const result = await parseOpenclawSessionFile({
          filePath,
          fileHandle,
          startOffset,
          endOffsetLimit: fileEndOffset,
          previousUsageEvents: prevUsageEvents,
          appendOnly,
          aggregateAfterMs: legacyAggregateAfterMs,
          usageFingerprintState: appendOnly ? prefixFingerprintState : null,
          hourlyState: attemptHourly,
          touchedBuckets: attemptTouched,
          source: fileSource,
          projectState: null,
          projectTouchedBuckets: null,
        });
        const closedStat = await fileHandle.stat();
        const pathStat = await fs.stat(filePath).catch(() => null);
        if (
          !sameOpenclawFileGeneration(openedStat, closedStat) ||
          !sameOpenclawFileGeneration(closedStat, pathStat)
        ) {
          continue;
        }
        accepted = {
          inode: closedStat.ino || 0,
          result,
          hourly: attemptHourly,
          touched: attemptTouched,
          usageEvents: result.usageEvents,
          usageFingerprint: result.usageFingerprint,
        };
        break;
      } finally {
        await fileHandle.close().catch(() => {});
      }
    }
    if (!accepted) {
      if (!openedRegularFile) continue;
      throw new Error(`OpenClaw session changed repeatedly while parsing: ${filePath}`);
    }

    mergeOpenclawAttemptBuckets(
      hourlyState,
      touchedBuckets,
      accepted.hourly,
      accepted.touched,
    );
    if (previousKey && previousKey !== key) delete stagedFiles[previousKey];
    stagedFiles[key] = {
      provider: "openclaw",
      inode: accepted.inode,
      offset: accepted.result.endOffset,
      usageFingerprint: accepted.usageFingerprint,
      updatedAt: new Date().toISOString(),
      usageEvents: accepted.usageEvents,
      // Sticky: once a transcript has yielded real per-event usage, the
      // sessions.json totals fallback must defer to it to avoid double
      // counting the same tokens twice (see applyOpenclawTotalsFallback).
      //
      // The usageEvents check is what makes this work for EXISTING installs:
      // cursors written before this flag existed carry no `hasRealUsage`, and a
      // steady-state sync of an unchanged transcript aggregates 0 new events —
      // so keying off eventsAggregated alone would leave the flag false forever
      // and let the fallback keep double counting for exactly the users who
      // already have OpenClaw history.
      hasRealUsage:
        Boolean(prev?.hasRealUsage) ||
        accepted.result.eventsAggregated > 0 ||
        Object.keys(accepted.usageEvents || {}).length > 0,
    };
    cursorKeys.set(key, key);

    filesProcessed += 1;
    eventsAggregated += accepted.result.eventsAggregated;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  cursors.files = stagedFiles;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

function openclawCursorKey(filePath) {
  if (typeof filePath !== "string") return "";
  const normalized = filePath.replace(/\\/g, "/");
  const isWindowsPath =
    /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//");
  return isWindowsPath ? normalized.toLowerCase() : filePath;
}

function sameOpenclawFileGeneration(left, right) {
  if (!left || !right || !left.isFile?.() || !right.isFile?.()) return false;
  const leftInode = Number(left.ino || 0);
  const rightInode = Number(right.ino || 0);
  if (leftInode > 0 && rightInode > 0) {
    if (leftInode !== rightInode || Number(left.dev || 0) !== Number(right.dev || 0)) {
      return false;
    }
  }
  return (
    Number(left.size || 0) === Number(right.size || 0) &&
    Number(left.mtimeMs || 0) === Number(right.mtimeMs || 0) &&
    Number(left.ctimeMs || 0) === Number(right.ctimeMs || 0)
  );
}

async function openclawOffsetEndsAtLineBoundary(fileHandle, offset) {
  const byteOffset = Math.max(0, Number(offset) || 0);
  if (byteOffset === 0) return true;
  const buffer = Buffer.allocUnsafe(1);
  const { bytesRead } = await fileHandle.read(buffer, 0, 1, byteOffset - 1);
  return bytesRead === 1 && (buffer[0] === 0x0a || buffer[0] === 0x0d);
}

function sameOpenclawUsageFingerprint(left, right) {
  return (
    left?.version === 1 &&
    right?.version === 1 &&
    left.eventCount === right.eventCount &&
    left.digest === right.digest
  );
}

function mergeOpenclawAttemptBuckets(
  hourlyState,
  touchedBuckets,
  attemptHourly,
  attemptTouched,
) {
  for (const key of attemptTouched) {
    const parsed = parseBucketKey(key);
    const attemptBucket = attemptHourly.buckets[key];
    if (!parsed || !attemptBucket) continue;
    const bucket = getHourlyBucket(
      hourlyState,
      parsed.source,
      parsed.model,
      parsed.hourStart,
    );
    addTotals(bucket.totals, attemptBucket.totals);
    touchedBuckets.add(key);
  }
}

async function parseOpenclawSessionFile({
  filePath,
  fileHandle,
  startOffset,
  endOffsetLimit,
  previousUsageEvents,
  appendOnly,
  aggregateAfterMs,
  usageFingerprintState,
  collectOnly = false,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
}) {
  const st = fileHandle ? await fileHandle.stat() : await fs.stat(filePath);
  const endOffset =
    Number.isFinite(endOffsetLimit) && endOffsetLimit >= 0
      ? Math.min(st.size, endOffsetLimit)
      : st.size;
  const priorCounts =
    previousUsageEvents && typeof previousUsageEvents === "object"
      ? previousUsageEvents
      : {};
  let fingerprintEventCount =
    Number.isInteger(usageFingerprintState?.eventCount) &&
    usageFingerprintState.eventCount >= 0
      ? usageFingerprintState.eventCount
      : 0;
  const fingerprintHash =
    typeof usageFingerprintState?.hash?.copy === "function"
      ? usageFingerprintState.hash.copy()
      : crypto.createHash("sha256");
  if (startOffset >= endOffset) {
    return {
      endOffset,
      eventsAggregated: 0,
      usageEvents: { ...priorCounts },
      usageFingerprint: {
        version: 1,
        eventCount: fingerprintEventCount,
        digest: fingerprintHash.copy().digest("hex"),
      },
      usageFingerprintState: {
        eventCount: fingerprintEventCount,
        hash: fingerprintHash,
      },
    };
  }

  const stream = fssync.createReadStream(filePath, {
    fd: fileHandle?.fd,
    autoClose: !fileHandle,
    encoding: "utf8",
    start: startOffset,
    end: endOffset - 1,
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let eventsAggregated = 0;
  const scanCounts = appendOnly ? { ...priorCounts } : {};
  const usageEvents = { ...priorCounts };
  for await (const line of rl) {
    if (!line) continue;
    // Fast-path filter: OpenClaw assistant messages include message.usage.totalTokens.
    if (!line.includes('"usage"') || !line.includes("totalTokens")) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue;
    }

    if (obj?.type !== "message") continue;
    const msg = obj?.message;
    if (!msg || typeof msg !== "object") continue;

    const usage = normalizeOpenclawUsage(msg.usage);
    if (!usage) continue;

    const tokenTimestamp = typeof obj?.timestamp === "string" ? obj.timestamp : null;
    if (!tokenTimestamp) continue;

    const model = normalizeModelInput(msg.model) || DEFAULT_MODEL;
    const eventIdentity = openclawUsageEventIdentity(obj, msg, usage, model);
    fingerprintHash.update(
      `${JSON.stringify(
        openclawUsageFingerprintMetadata(
          obj,
          msg,
          usage,
          model,
          eventIdentity.key,
        ),
      )}\n`,
    );
    fingerprintEventCount += 1;

    // OpenClaw wraps Codex, so it follows the same OpenAI convention where
    // `input` INCLUDES cached reads. Normalize by subtracting cached from
    // input so `input_tokens` is pure non-cached (matches CLAUDE.md spec
    // and prevents downstream double-counting at the cache_read rate on top
    // of the full input rate — ~6–7x cost inflation on cache-heavy sessions).
    const openclawRawInput = Number(usage.input || 0);
    const openclawCached = Number(usage.cacheRead || 0);
    const openclawCacheWrite = Number(usage.cacheWrite || 0);
    const openclawOutput = Number(usage.output || 0);
    const openclawInput = Math.max(0, openclawRawInput - openclawCached);
    const delta = {
      input_tokens: openclawInput,
      cached_input_tokens: openclawCached,
      cache_creation_input_tokens: openclawCacheWrite,
      output_tokens: openclawOutput,
      reasoning_output_tokens: 0,
      total_tokens: openclawInput + openclawCached + openclawCacheWrite + openclawOutput,
      conversation_count: 1,
    };

    if (isAllZeroUsage(delta)) continue;

    const bucketStart = toUtcHalfHourStart(tokenTimestamp);
    if (!bucketStart) continue;

    const priorCount = Number(priorCounts[eventIdentity.key] || 0);
    const nextCount = Number(scanCounts[eventIdentity.key] || 0) + 1;
    scanCounts[eventIdentity.key] = nextCount;
    usageEvents[eventIdentity.key] = eventIdentity.unique
      ? 1
      : Math.max(Number(usageEvents[eventIdentity.key] || 0), nextCount);
    if (
      eventIdentity.unique
        ? priorCount > 0 || nextCount > 1
        : nextCount <= priorCount
    ) {
      continue;
    }

    if (
      aggregateAfterMs != null &&
      Date.parse(tokenTimestamp) <= aggregateAfterMs
    ) {
      continue;
    }

    if (!collectOnly) {
      const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey(source, model, bucketStart));
    }

    // Project-level OpenClaw attribution is not supported yet (no stable cwd info).
    // If OpenClaw later records cwd per event, we can mirror rollout's project logic.
    if (!collectOnly) eventsAggregated += 1;
  }

  rl.close();
  if (!fileHandle) stream.close?.();
  return {
    endOffset,
    eventsAggregated,
    usageEvents,
    usageFingerprint: {
      version: 1,
      eventCount: fingerprintEventCount,
      digest: fingerprintHash.copy().digest("hex"),
    },
    usageFingerprintState: {
      eventCount: fingerprintEventCount,
      hash: fingerprintHash,
    },
  };
}

function normalizeOpenclawUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const normalized = {};
  for (const field of [
    "input",
    "cacheRead",
    "cacheWrite",
    "output",
    "totalTokens",
  ]) {
    const rawValue = usage[field];
    if (rawValue === undefined) {
      normalized[field] = 0;
      continue;
    }
    if (
      typeof rawValue !== "number" ||
      !Number.isSafeInteger(rawValue) ||
      rawValue < 0
    ) {
      return null;
    }
    normalized[field] = rawValue;
  }
  return normalized;
}

function openclawUsageFingerprintMetadata(
  obj,
  msg,
  usage,
  model,
  identityKey,
) {
  return {
    identityKey,
    timestamp: typeof obj?.timestamp === "string" ? obj.timestamp : null,
    messageTimestamp:
      typeof msg?.timestamp === "number" || typeof msg?.timestamp === "string"
        ? msg.timestamp
        : null,
    responseId: typeof msg?.responseId === "string" ? msg.responseId : null,
    model,
    provider: typeof msg?.provider === "string" ? msg.provider : null,
    api: typeof msg?.api === "string" ? msg.api : null,
    input: Number(usage?.input || 0),
    cacheRead: Number(usage?.cacheRead || 0),
    cacheWrite: Number(usage?.cacheWrite || 0),
    output: Number(usage?.output || 0),
    totalTokens: Number(usage?.totalTokens || 0),
  };
}

function openclawUsageEventIdentity(obj, msg, usage, model) {
  const stableId =
    typeof obj?.id === "string" && obj.id.trim() ? obj.id.trim() : null;
  if (stableId) {
    return {
      key: `id:${crypto.createHash("sha256").update(stableId).digest("hex")}`,
      unique: true,
    };
  }

  const metadata = {
    timestamp: typeof obj?.timestamp === "string" ? obj.timestamp : null,
    messageTimestamp: typeof msg?.timestamp === "number" || typeof msg?.timestamp === "string"
      ? msg.timestamp
      : null,
    responseId: typeof msg?.responseId === "string" ? msg.responseId : null,
    model,
    provider: typeof msg?.provider === "string" ? msg.provider : null,
    api: typeof msg?.api === "string" ? msg.api : null,
    input: Number(usage?.input || 0),
    cacheRead: Number(usage?.cacheRead || 0),
    cacheWrite: Number(usage?.cacheWrite || 0),
    output: Number(usage?.output || 0),
    totalTokens: Number(usage?.totalTokens || 0),
  };
  return {
    key: `meta:${crypto.createHash("sha256").update(JSON.stringify(metadata)).digest("hex")}`,
    unique: false,
  };
}

/**
 * Extract the session UUID from a Codex rollout file path
 * (`rollout-<datetime>-<uuid>.jsonl`). Used as the stable per-session scope for
 * event dedup: it survives both an inode-changing rewrite (Codex-Manager
 * atomically rewrites session files to patch the provider on account switch,
 * issue #187) and a sessions/ -> archived_sessions/ move. Returns null when the
 * name has no UUID, in which case the caller falls back to the full path.
 */
function codexSessionIdFromPath(filePath) {
  if (typeof filePath !== "string") return null;
  const m = filePath.match(
    /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/,
  );
  return m ? m[1] : null;
}

async function parseRolloutFile({
  filePath,
  fileStat,
  startOffset,
  lastTotal,
  tokenUsageBaselines,
  lastModel,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
  projectMetaCache,
  publicRepoCache,
  publicRepoResolver,
  projectContext,
  seenCodexEvents,
  sessionId,
  invalidRecordPolicy,
}) {
  const st = fileStat || (await fs.stat(filePath));
  const endOffset = st.size;
  const projectFileContexts = [];
  addProjectFileContext(projectFileContexts, projectContext);
  if (startOffset >= endOffset) {
    return {
      endOffset,
      lastTotal,
      tokenUsageBaselines,
      lastModel,
      eventsAggregated: 0,
      projectFileContexts,
    };
  }

  const stream = fssync.createReadStream(filePath, {
    start: startOffset,
    end: endOffset - 1,
  });

  let model = typeof lastModel === "string" ? lastModel : null;
  const usageDeltaState = createUsageDeltaState({
    lastTotal,
    baselines: tokenUsageBaselines,
  });
  let latestTotal = lastTotal && typeof lastTotal === "object" ? lastTotal : null;
  let currentCwd = null;
  let currentDate = null;
  let isForkedRollout = false;
  // The replay prefix only ever exists at the head of a freshly-forked file. A
  // resumed scan (startOffset > 0) can never see it — and never re-reads the
  // session_meta line, so isForkedRollout stays false there anyway — but gate
  // on the offset explicitly so correctness does not hinge on that distant
  // invariant. Known accepted limitation: if a sync's read races the fork's
  // single-flush write and persists a cursor INSIDE the burst, the resumed
  // scan counts the remaining burst tail (bounded over-count, ms-wide window;
  // self-heals on any inode-changing rescan and never drops genuine usage).
  let replayPrefixActive = startOffset === 0;
  let prevForkedTokenMs = null;
  const rolloutDate = rolloutDateFromPath(filePath);
  let currentProjectRef = projectRef || null;
  let currentProjectKey = projectKey || null;
  let eventsAggregated = 0;
  let scannedEndOffset = startOffset;
  let committedEndOffset = startOffset;

  const invalidUtf8 = invalidRecordPolicy === "throw" ? "throw" : "record";
  for await (const record of physicalJsonlRecords(stream, { invalidUtf8 })) {
    scannedEndOffset += record.physicalBytes;
    if (record.terminated) committedEndOffset = scannedEndOffset;
    if (!record.utf8Valid) {
      if (!record.terminated) break;
      continue;
    }

    const { line } = record;
    if (!line) continue;
    const maybeTokenCount = line.includes('"token_count"');
    const maybeTurnContext =
      !maybeTokenCount &&
      (line.includes('"turn_context"') || line.includes('"session_meta"')) &&
      (line.includes('"model"') ||
        line.includes('"cwd"') ||
        line.includes('"current_date"') ||
        line.includes('"forked_from_id"'));
    if (!maybeTokenCount && !maybeTurnContext) {
      if (invalidRecordPolicy === "throw" || !record.terminated) {
        try {
          JSON.parse(line);
          committedEndOffset = scannedEndOffset;
        } catch (error) {
          if (invalidRecordPolicy === "throw") throw error;
          break;
        }
      }
      continue;
    }

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (error) {
      if (invalidRecordPolicy === "throw") throw error;
      if (!record.terminated) break;
      continue;
    }
    if (!record.terminated) committedEndOffset = scannedEndOffset;

    if (
      (obj?.type === "turn_context" || obj?.type === "session_meta") &&
      obj?.payload &&
      typeof obj.payload === "object"
    ) {
      if (obj.type === "session_meta" && typeof obj.payload.forked_from_id === "string") {
        isForkedRollout = obj.payload.forked_from_id.trim().length > 0;
      }
      if (obj.type === "turn_context" && typeof obj.payload.current_date === "string") {
        currentDate = normalizeIsoDate(obj.payload.current_date);
      }
      if (typeof obj.payload.model === "string") {
        model = obj.payload.model;
      }
      if (projectState && typeof obj.payload.cwd === "string") {
        const nextCwd = obj.payload.cwd.trim();
        if (nextCwd && nextCwd !== currentCwd) {
          const context = await resolveProjectContextForPath({
            startDir: wsl.mapWslCwdToUnc(nextCwd, filePath),
            projectMetaCache,
            publicRepoCache,
            publicRepoResolver,
            projectState,
          });
          currentCwd = nextCwd;
          currentProjectRef = context?.projectRef || null;
          currentProjectKey = context?.projectKey || null;
          addProjectFileContext(projectFileContexts, context);
        }
      }
      continue;
    }

    const token = extractTokenCount(obj);
    if (!token) continue;

    const info = token.info;
    if (!info || typeof info !== "object") continue;

    const tokenTimestamp = typeof token.timestamp === "string" ? token.timestamp : null;
    if (!tokenTimestamp) continue;

    const lastUsage = info.last_token_usage;
    const totalUsage = info.total_token_usage;
    if (totalUsage && typeof totalUsage === "object") latestTotal = totalUsage;

    const rawDelta = consumeUsageDelta(usageDeltaState, lastUsage, totalUsage);
    const delta = rawDelta ? normalizeUsage(rawDelta) : null;
    if (!delta || isAllZeroUsage(delta)) continue;
    delta.conversation_count = 1;

    // Forked Codex rollouts replay the parent session's entire token history
    // into the child file the moment the fork is created. The date guard below
    // (current_date < rolloutDate) catches cross-day forks, but same-day forks
    // share the parent's current_date and slip through it. The replay is written
    // in a single flush, so its rows carry near-identical timestamps (sub-ms to a
    // few ms apart across observed 0.129–0.137 samples), while the first genuine
    // live turn lands seconds later (≥11s in every sampled fork). We therefore
    // skip the *leading* run of densely-spaced token_count rows and latch off
    // permanently at the first multi-second gap: a lone fast turn (always
    // preceded by a large gap) is never dropped, and an arbitrarily large replay
    // is fully skipped regardless of length. The threshold sits far above the
    // flush spacing and well below genuine turn cadence (≥~4.6s observed). The
    // first replayed row cannot be identified without lookahead, so it is still
    // counted (a bounded, <1% residual over-count); dropping real usage is the
    // worse failure, so we bias against it. `usageDeltaState` is already advanced above,
    // keeping the cumulative lineage correct for the live turns we keep.
    // Scoped to forked codex rollouts. (issue #169 follow-up.)
    let forkedReplaySkip = false;
    if (isForkedRollout && source === DEFAULT_SOURCE && replayPrefixActive) {
      const tokenMs = Date.parse(tokenTimestamp);
      // Fail open on anything the burst heuristic was not measured against:
      // an unparseable timestamp or a backwards clock step permanently ends
      // the prefix, so no later row can be skipped off a stale baseline.
      // Replay flushes are monotonic in every sampled rollout (2,116 gaps,
      // min 0ms), so this never fires on genuine replays.
      if (!Number.isFinite(tokenMs) || (prevForkedTokenMs !== null && tokenMs < prevForkedTokenMs)) {
        replayPrefixActive = false;
      } else {
        if (prevForkedTokenMs !== null && tokenMs - prevForkedTokenMs >= CODEX_FORK_REPLAY_GAP_MS) {
          replayPrefixActive = false;
        }
        forkedReplaySkip =
          replayPrefixActive &&
          prevForkedTokenMs !== null &&
          tokenMs - prevForkedTokenMs < CODEX_FORK_REPLAY_GAP_MS;
        prevForkedTokenMs = tokenMs;
      }
    }

    // date matching is conservative; same-day fork replays are caught by the
    // burst detector above rather than this cross-day date guard.
    if (forkedReplaySkip || isForkedReplayToken({ isForkedRollout, rolloutDate, currentDate })) {
      continue;
    }

    const bucketStart = toUtcHalfHourStart(tokenTimestamp);
    if (!bucketStart) continue;

    // Idempotent re-scan dedup (issue #187). Codex usage is parsed incrementally
    // by (inode, offset): when the inode changes the file is re-scanned from
    // offset 0 and every event's delta is re-added to the PERSISTENT hourly
    // buckets. External tools rewrite session files without changing the token
    // data — Codex-Manager atomically rewrites them (new inode) to patch the
    // provider on every account/channel switch — so without dedup each switch
    // double-counts the rewritten sessions. `usageDeltaState` is already advanced above,
    // so skipping an already-seen event keeps the cumulative lineage intact
    // while preventing the re-add; genuinely new turns carry new timestamps and
    // are still counted. Key = sessionUUID:eventTimestamp (both stable across the
    // rewrite and across a sessions/ -> archived_sessions/ move).
    //
    // Scoped to the `codex` source: Codex-Manager (the tool that does the atomic
    // rewrite) manages Codex. Other rollout-format sources (e.g. every-code) have
    // their own model re-alignment that legitimately re-reads prior events, which
    // this dedup would otherwise suppress.
    const codexEvents = typeof seenCodexEvents === "function"
      ? seenCodexEvents()
      : seenCodexEvents;
    if (codexEvents && source === "codex") {
      const dedupKey = `${sessionId || filePath}:${tokenTimestamp}`;
      if (codexEvents.has(dedupKey)) continue;
      codexEvents.add(dedupKey);
    }

    const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(source, model, bucketStart));
    if (currentProjectKey && projectState && projectTouchedBuckets) {
      const projectBucket = getProjectBucket(
        projectState,
        currentProjectKey,
        source,
        bucketStart,
        currentProjectRef,
      );
      addTotals(projectBucket.totals, delta);
      projectTouchedBuckets.add(projectBucketKey(currentProjectKey, source, bucketStart));
    }
    eventsAggregated += 1;
  }

  return {
    endOffset: committedEndOffset,
    lastTotal: latestTotal,
    tokenUsageBaselines: snapshotUsageBaselines(usageDeltaState),
    lastModel: model,
    eventsAggregated,
    projectFileContexts,
  };
}

async function scanRolloutProjectFileContexts({
  filePath,
  fileStat,
  lastTotal,
  tokenUsageBaselines,
  lastModel,
  projectState,
  projectMetaCache,
  publicRepoCache,
  publicRepoResolver,
  projectContext,
  invalidRecordPolicy,
}) {
  const st = fileStat || (await fs.stat(filePath));
  const endOffset = st.size;
  const projectFileContexts = [];
  addProjectFileContext(projectFileContexts, projectContext);
  if (!projectState || endOffset <= 0) {
    return {
      endOffset,
      lastTotal,
      tokenUsageBaselines,
      lastModel,
      eventsAggregated: 0,
      projectFileContexts,
    };
  }

  const stream = fssync.createReadStream(filePath, { start: 0, end: endOffset - 1 });
  let currentCwd = null;
  let scannedEndOffset = 0;
  let committedEndOffset = 0;

  const invalidUtf8 = invalidRecordPolicy === "throw" ? "throw" : "record";
  for await (const record of physicalJsonlRecords(stream, { invalidUtf8 })) {
    scannedEndOffset += record.physicalBytes;
    if (record.terminated) committedEndOffset = scannedEndOffset;
    if (!record.utf8Valid) {
      if (!record.terminated) break;
      continue;
    }

    const { line } = record;
    if (
      !line ||
      !(
        line.includes('"turn_context"') ||
        line.includes('"session_meta"')
      ) ||
      !line.includes('"cwd"')
    ) {
      if (line && (invalidRecordPolicy === "throw" || !record.terminated)) {
        try {
          JSON.parse(line);
          committedEndOffset = scannedEndOffset;
        } catch (error) {
          if (invalidRecordPolicy === "throw") throw error;
          break;
        }
      }
      continue;
    }

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (error) {
      if (invalidRecordPolicy === "throw") throw error;
      if (!record.terminated) break;
      continue;
    }
    if (!record.terminated) committedEndOffset = scannedEndOffset;
    if (
      (obj?.type !== "turn_context" && obj?.type !== "session_meta") ||
      !obj?.payload ||
      typeof obj.payload !== "object" ||
      typeof obj.payload.cwd !== "string"
    ) {
      continue;
    }

    const nextCwd = obj.payload.cwd.trim();
    if (!nextCwd || nextCwd === currentCwd) continue;
    const context = await resolveProjectContextForPath({
      startDir: wsl.mapWslCwdToUnc(nextCwd, filePath),
      projectMetaCache,
      publicRepoCache,
      publicRepoResolver,
      projectState,
    });
    currentCwd = nextCwd;
    addProjectFileContext(projectFileContexts, context);
  }

  return {
    endOffset: committedEndOffset,
    lastTotal,
    tokenUsageBaselines,
    lastModel,
    eventsAggregated: 0,
    projectFileContexts,
  };
}

async function parseClaudeFile({
  filePath,
  fileStat,
  startOffset,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
  seenMessageHashes,
}) {
  const st = fileStat || (await fs.stat(filePath).catch(() => null));
  if (!st || !st.isFile()) return { endOffset: startOffset, eventsAggregated: 0 };

  const endOffset = st.size;
  if (startOffset >= endOffset) return { endOffset, eventsAggregated: 0 };

  const stream = fssync.createReadStream(filePath, { encoding: "utf8", start: startOffset });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let eventsAggregated = 0;
  // Separator-agnostic: WSL installs are scanned over \\wsl$ UNC paths where
  // path.join produces backslashes, and a forward-slash-only check would
  // misclassify subagent transcripts as main sessions (#307).
  const isMainSession = !/[\\/]subagents[\\/]/.test(filePath);
  for await (const line of rl) {
    if (!line) continue;

    // Count user-typed messages as conversations (main sessions only).
    // Exclude tool_result messages — those are auto-generated by tool calls,
    // not manually typed by the user. Only count messages with a "text" block.
    if (isMainSession && line.includes('"type":"user"')) {
      let userObj;
      try {
        userObj = JSON.parse(line);
      } catch (_e) {
        /* skip */
      }
      if (userObj?.type === "user") {
        const content = userObj?.message?.content;
        const hasText =
          typeof content === "string" ||
          (Array.isArray(content) && content.some((b) => b?.type === "text"));
        if (hasText) {
          // Dedup by the line's uuid so a synced copy of the session file
          // (WSL mirror of a divergent native file, inode-reset re-read)
          // cannot re-count the conversation. Usage rows get the same
          // guarantee from claudeMessageDedupKey; user lines have no
          // message.id, so the line uuid is the identity.
          const userKey =
            seenMessageHashes && typeof userObj?.uuid === "string" && userObj.uuid
              ? `u:${userObj.uuid}`
              : null;
          if (!userKey || !seenMessageHashes.has(userKey)) {
            if (userKey) seenMessageHashes.add(userKey);
            const userTs = typeof userObj?.timestamp === "string" ? userObj.timestamp : null;
            const userBucketStart = userTs ? toUtcHalfHourStart(userTs) : null;
            if (userBucketStart) {
              const userModel = DEFAULT_MODEL;
              const userBucket = getHourlyBucket(hourlyState, source, userModel, userBucketStart);
              userBucket.totals.conversation_count += 1;
              touchedBuckets.add(bucketKey(source, userModel, userBucketStart));
            }
          }
        }
      }
    }

    if (!line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue;
    }

    const usage = obj?.message?.usage || obj?.usage;
    if (!usage || typeof usage !== "object") continue;

    const dedupHash = seenMessageHashes ? claudeMessageDedupKey(obj) : null;
    if (dedupHash && seenMessageHashes.has(dedupHash)) continue;

    const model = normalizeModelInput(obj?.message?.model || obj?.model) || DEFAULT_MODEL;
    const tokenTimestamp = typeof obj?.timestamp === "string" ? obj.timestamp : null;
    if (!tokenTimestamp) continue;

    const delta = normalizeClaudeUsage(usage);
    if (!delta || isAllZeroUsage(delta)) continue;

    if (dedupHash) seenMessageHashes.add(dedupHash);
    delta.conversation_count = 0;

    const bucketStart = toUtcHalfHourStart(tokenTimestamp);
    if (!bucketStart) continue;

    const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(source, model, bucketStart));
    if (projectKey && projectState && projectTouchedBuckets) {
      const projectBucket = getProjectBucket(
        projectState,
        projectKey,
        source,
        bucketStart,
        projectRef,
      );
      addTotals(projectBucket.totals, delta);
      projectTouchedBuckets.add(projectBucketKey(projectKey, source, bucketStart));
    }
    eventsAggregated += 1;
  }

  rl.close();
  stream.close?.();
  return { endOffset, eventsAggregated };
}

async function parseGeminiFile({
  filePath,
  startIndex,
  lastTotals,
  lastModel,
  projectCursor,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
}) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) return { lastIndex: startIndex, lastTotals, lastModel, eventsAggregated: 0 };

  let session;
  try {
    session = JSON.parse(raw);
  } catch (_e) {
    return { lastIndex: startIndex, lastTotals, lastModel, eventsAggregated: 0 };
  }

  const messages = Array.isArray(session?.messages) ? session.messages : [];
  if (startIndex >= messages.length) {
    startIndex = -1;
    lastTotals = null;
    lastModel = null;
  }

  let eventsAggregated = 0;
  let model = typeof lastModel === "string" ? lastModel : null;
  let totals = lastTotals && typeof lastTotals === "object" ? lastTotals : null;
  const projectActive = Boolean(projectKey && projectState && projectTouchedBuckets);
  let projectStartIndex =
    projectActive && Number.isFinite(projectCursor?.lastIndex)
      ? Number(projectCursor.lastIndex)
      : -1;
  let projectModel =
    projectActive && typeof projectCursor?.lastModel === "string"
      ? projectCursor.lastModel
      : null;
  let projectTotals =
    projectActive && projectCursor?.lastTotals && typeof projectCursor.lastTotals === "object"
      ? projectCursor.lastTotals
      : null;
  if (projectActive && projectStartIndex >= messages.length) {
    projectStartIndex = -1;
    projectTotals = null;
    projectModel = null;
  }
  const hourlyBegin = Number.isFinite(startIndex) ? startIndex + 1 : 0;
  const projectBegin = projectActive ? projectStartIndex + 1 : Number.POSITIVE_INFINITY;
  const begin = Math.min(hourlyBegin, projectBegin);

  for (let idx = begin; idx < messages.length; idx++) {
    const msg = messages[idx];
    if (!msg || typeof msg !== "object") continue;

    const normalizedModel = normalizeModelInput(msg.model);
    if (normalizedModel && idx >= hourlyBegin) model = normalizedModel;
    if (normalizedModel && idx >= projectBegin) projectModel = normalizedModel;

    const timestamp = typeof msg.timestamp === "string" ? msg.timestamp : null;
    const currentTotals = normalizeGeminiTokens(msg.tokens);
    if (idx >= hourlyBegin && (!timestamp || !currentTotals)) {
      totals = currentTotals || totals;
    }
    if (idx >= projectBegin && (!timestamp || !currentTotals)) {
      projectTotals = currentTotals || projectTotals;
    }
    if (!timestamp || !currentTotals) {
      continue;
    }

    let bucketStart = null;
    if (idx >= hourlyBegin) {
      const delta = diffGeminiTotals(currentTotals, totals);
      if (!delta || isAllZeroUsage(delta)) {
        totals = currentTotals;
      } else {
        delta.conversation_count = 1;
        bucketStart = toUtcHalfHourStart(timestamp);
        if (bucketStart) {
          const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
          addTotals(bucket.totals, delta);
          touchedBuckets.add(bucketKey(source, model, bucketStart));
          eventsAggregated += 1;
        }
        totals = currentTotals;
      }
    }

    if (idx >= projectBegin) {
      const projectDelta = diffGeminiTotals(currentTotals, projectTotals);
      if (!projectDelta || isAllZeroUsage(projectDelta)) {
        projectTotals = currentTotals;
        continue;
      }
      projectDelta.conversation_count = 1;
      bucketStart = bucketStart || toUtcHalfHourStart(timestamp);
      if (bucketStart) {
        const projectBucket = getProjectBucket(
          projectState,
          projectKey,
          source,
          bucketStart,
          projectRef,
        );
        addTotals(projectBucket.totals, projectDelta);
        projectTouchedBuckets.add(projectBucketKey(projectKey, source, bucketStart));
      }
      projectTotals = currentTotals;
    }
  }

  return {
    lastIndex: messages.length - 1,
    lastTotals: totals,
    lastModel: model,
    projectLastIndex: projectActive ? messages.length - 1 : null,
    projectLastTotals: projectTotals,
    projectLastModel: projectModel,
    eventsAggregated,
  };
}

async function parseOpencodeMessageFile({
  filePath,
  messageIndex,
  fingerprintIndex,
  fallbackTotals,
  fallbackMessageKey,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
}) {
  const fallbackKey =
    typeof fallbackMessageKey === "string" && fallbackMessageKey.trim()
      ? fallbackMessageKey.trim()
      : null;
  const legacyTotals = fallbackTotals && typeof fallbackTotals === "object" ? fallbackTotals : null;
  const fallbackEntry = messageIndex && fallbackKey ? messageIndex[fallbackKey] : null;
  const fallbackLastTotals =
    fallbackEntry && typeof fallbackEntry.lastTotals === "object"
      ? fallbackEntry.lastTotals
      : legacyTotals;

  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return {
      messageKey: fallbackKey,
      lastTotals: fallbackLastTotals,
      eventsAggregated: 0,
      shouldUpdate: false,
    };
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_e) {
    return {
      messageKey: fallbackKey,
      lastTotals: fallbackLastTotals,
      eventsAggregated: 0,
      shouldUpdate: false,
    };
  }

  const messageKey = deriveOpencodeMessageKey(msg, filePath);
  const prev = messageIndex && messageKey ? messageIndex[messageKey] : null;
  const indexTotals = prev && typeof prev.lastTotals === "object" ? prev.lastTotals : null;
  const fallbackMatch = !fallbackKey || fallbackKey === messageKey;
  const lastTotals = indexTotals || (fallbackMatch ? fallbackLastTotals : null);

  const currentTotals = normalizeOpencodeTokens(msg?.tokens);
  if (!currentTotals) {
    return { messageKey, lastTotals, eventsAggregated: 0, shouldUpdate: false };
  }

  // `Session.fork` re-materialises the parent's prefix under new message ids in
  // a new session — count it once (issue #426, see deriveOpencodeMessageFingerprint).
  const fingerprint = deriveOpencodeMessageFingerprint({ msg, totals: currentTotals, source });
  if (isOpencodeForkCopy(fingerprintIndex, fingerprint, messageKey)) {
    if (lastTotals && prev?.dedupedForkCopy !== true) {
      repairCountedOpencodeForkCopy({
        msg,
        totals: lastTotals,
        source,
        hourlyState,
        touchedBuckets,
        projectState,
        projectTouchedBuckets,
        projectRef,
        projectKey,
      });
    }
    return {
      messageKey,
      lastTotals: currentTotals,
      fingerprint,
      dedupedForkCopy: true,
      eventsAggregated: 0,
      shouldUpdate: prev?.dedupedForkCopy !== true || !lastTotals,
    };
  }

  // A formerly deduped copy can become a genuinely distinct in-place update.
  // Its prior totals were removed from the buckets, so re-add the full current
  // snapshot instead of only the delta from the suppressed value.
  const effectiveLastTotals = prev?.dedupedForkCopy === true ? null : lastTotals;
  const delta = diffGeminiTotals(currentTotals, effectiveLastTotals);
  if (!delta || isAllZeroUsage(delta)) {
    return {
      messageKey,
      lastTotals: currentTotals,
      fingerprint,
      dedupedForkCopy: false,
      eventsAggregated: 0,
      shouldUpdate: true,
    };
  }
  delta.conversation_count = 1;

  const timestampMs = coerceEpochMs(msg?.time?.completed) || coerceEpochMs(msg?.time?.created);
  if (!timestampMs) {
    return {
      messageKey,
      lastTotals,
      eventsAggregated: 0,
      shouldUpdate: Boolean(lastTotals),
    };
  }

  const tsIso = new Date(timestampMs).toISOString();
  const bucketStart = toUtcHalfHourStart(tsIso);
  if (!bucketStart) {
    return {
      messageKey,
      lastTotals,
      eventsAggregated: 0,
      shouldUpdate: Boolean(lastTotals),
    };
  }

  const { modelId: fileModelId } = normalizeOpencodeModelFields(msg);
  const model = fileModelId || DEFAULT_MODEL;
  const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
  addTotals(bucket.totals, delta);
  touchedBuckets.add(bucketKey(source, model, bucketStart));
  if (projectKey && projectState && projectTouchedBuckets) {
    const projectBucket = getProjectBucket(
      projectState,
      projectKey,
      source,
      bucketStart,
      projectRef,
    );
    addTotals(projectBucket.totals, delta);
    projectTouchedBuckets.add(projectBucketKey(projectKey, source, bucketStart));
  }
  return {
    messageKey,
    lastTotals: currentTotals,
    fingerprint,
    dedupedForkCopy: false,
    eventsAggregated: 1,
    shouldUpdate: true,
  };
}

async function enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets }) {
  if (!touchedBuckets || touchedBuckets.size === 0) return 0;

  const touchedGroups = new Set();
  for (const bucketStart of touchedBuckets) {
    const parsed = parseBucketKey(bucketStart);
    const hourStart = parsed.hourStart;
    if (!hourStart) continue;
    touchedGroups.add(groupBucketKey(parsed.source, hourStart));
  }
  if (touchedGroups.size === 0) return 0;

  const groupQueued =
    hourlyState.groupQueued && typeof hourlyState.groupQueued === "object"
      ? hourlyState.groupQueued
      : {};
  let codexTouched = false;
  const legacyGroups = new Set();
  for (const groupKey of touchedGroups) {
    if (Object.prototype.hasOwnProperty.call(groupQueued, groupKey)) {
      legacyGroups.add(groupKey);
    }
    if (!codexTouched && groupKey.startsWith(`${DEFAULT_SOURCE}${BUCKET_SEPARATOR}`)) {
      codexTouched = true;
    }
  }

  const groupedBuckets = new Map();
  for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
    if (!bucket || !bucket.totals) continue;
    const parsed = parseBucketKey(key);
    const hourStart = parsed.hourStart;
    if (!hourStart) continue;
    const groupKey = groupBucketKey(parsed.source, hourStart);
    if (!touchedGroups.has(groupKey) || legacyGroups.has(groupKey)) continue;

    const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
    const model = normalizeModelInput(parsed.model) || DEFAULT_MODEL;
    let group = groupedBuckets.get(groupKey);
    if (!group) {
      group = { source, hourStart, buckets: new Map() };
      groupedBuckets.set(groupKey, group);
    }

    if (bucket.queuedKey != null && typeof bucket.queuedKey !== "string") {
      bucket.queuedKey = null;
    }
    group.buckets.set(model, bucket);
  }

  if (codexTouched) {
    const recomputeGroups = new Set();
    for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
      if (!bucket || !bucket.totals) continue;
      const parsed = parseBucketKey(key);
      const hourStart = parsed.hourStart;
      if (!hourStart) continue;
      const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
      if (source !== "every-code") continue;
      const groupKey = groupBucketKey(source, hourStart);
      if (legacyGroups.has(groupKey) || groupedBuckets.has(groupKey)) continue;
      const model = normalizeModelInput(parsed.model) || DEFAULT_MODEL;
      if (model !== DEFAULT_MODEL) continue;
      recomputeGroups.add(groupKey);
    }

    if (recomputeGroups.size > 0) {
      for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
        if (!bucket || !bucket.totals) continue;
        const parsed = parseBucketKey(key);
        const hourStart = parsed.hourStart;
        if (!hourStart) continue;
        const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
        const groupKey = groupBucketKey(source, hourStart);
        if (!recomputeGroups.has(groupKey)) continue;
        let group = groupedBuckets.get(groupKey);
        if (!group) {
          group = { source, hourStart, buckets: new Map() };
          groupedBuckets.set(groupKey, group);
        }
        if (bucket.queuedKey != null && typeof bucket.queuedKey !== "string") {
          bucket.queuedKey = null;
        }
        const model = normalizeModelInput(parsed.model) || DEFAULT_MODEL;
        group.buckets.set(model, bucket);
      }
    }
  }

  const codexDominants = collectCodexDominantModels(hourlyState);

  const toAppend = [];
  for (const group of groupedBuckets.values()) {
    const unknownBucket = group.buckets.get(DEFAULT_MODEL) || null;
    const dominantModel = pickDominantModel(group.buckets);
    let alignedModel = null;
    if (unknownBucket?.alignedModel) {
      const normalized = normalizeModelInput(unknownBucket.alignedModel);
      alignedModel = normalized && normalized !== DEFAULT_MODEL ? normalized : null;
    }
    const zeroTotals = initTotals();
    const zeroKey = totalsKey(zeroTotals);

    if (dominantModel) {
      if (alignedModel && !group.buckets.has(alignedModel)) {
        toAppend.push(
          JSON.stringify({
            source: group.source,
            model: alignedModel,
            hour_start: group.hourStart,
            input_tokens: zeroTotals.input_tokens,
            cached_input_tokens: zeroTotals.cached_input_tokens,
            cache_creation_input_tokens: zeroTotals.cache_creation_input_tokens,
            output_tokens: zeroTotals.output_tokens,
            reasoning_output_tokens: zeroTotals.reasoning_output_tokens,
            total_tokens: zeroTotals.total_tokens,
            billable_total_tokens: zeroTotals.billable_total_tokens,
            conversation_count: zeroTotals.conversation_count,
          }),
        );
      }
      if (
        unknownBucket &&
        !alignedModel &&
        unknownBucket.queuedKey &&
        unknownBucket.queuedKey !== zeroKey
      ) {
        if (unknownBucket.retractedUnknownKey !== zeroKey) {
          toAppend.push(
            JSON.stringify({
              source: group.source,
              model: DEFAULT_MODEL,
              hour_start: group.hourStart,
              input_tokens: zeroTotals.input_tokens,
              cached_input_tokens: zeroTotals.cached_input_tokens,
              output_tokens: zeroTotals.output_tokens,
              reasoning_output_tokens: zeroTotals.reasoning_output_tokens,
              total_tokens: zeroTotals.total_tokens,
              billable_total_tokens: zeroTotals.billable_total_tokens,
              conversation_count: zeroTotals.conversation_count,
            }),
          );
          unknownBucket.retractedUnknownKey = zeroKey;
        }
      }
      if (unknownBucket) unknownBucket.alignedModel = null;
      for (const [model, bucket] of group.buckets.entries()) {
        if (model === DEFAULT_MODEL) continue;
        let totals = bucket.totals;
        if (model === dominantModel && unknownBucket?.totals) {
          totals = cloneTotals(bucket.totals);
          addTotals(totals, unknownBucket.totals);
        }
        const key = totalsKey(totals);
        if (bucket.queuedKey === key) continue;
        toAppend.push(
          JSON.stringify({
            source: group.source,
            model,
            hour_start: group.hourStart,
            input_tokens: totals.input_tokens,
            cached_input_tokens: totals.cached_input_tokens,
            cache_creation_input_tokens: totals.cache_creation_input_tokens,
            output_tokens: totals.output_tokens,
            reasoning_output_tokens: totals.reasoning_output_tokens,
            total_tokens: totals.total_tokens,
            billable_total_tokens: totals.billable_total_tokens ?? totals.total_tokens,
            conversation_count: totals.conversation_count,
          }),
        );
        bucket.queuedKey = key;
      }
      continue;
    }

    if (!unknownBucket?.totals) continue;
    let outputModel = DEFAULT_MODEL;
    if (group.source === "every-code") {
      const aligned = findNearestCodexModel(group.hourStart, codexDominants);
      if (aligned) outputModel = aligned;
    }
    const nextAligned = outputModel !== DEFAULT_MODEL ? outputModel : null;
    if (alignedModel && alignedModel !== nextAligned) {
      toAppend.push(
        JSON.stringify({
          source: group.source,
          model: alignedModel,
          hour_start: group.hourStart,
          input_tokens: zeroTotals.input_tokens,
          cached_input_tokens: zeroTotals.cached_input_tokens,
          output_tokens: zeroTotals.output_tokens,
          reasoning_output_tokens: zeroTotals.reasoning_output_tokens,
          total_tokens: zeroTotals.total_tokens,
          billable_total_tokens: zeroTotals.billable_total_tokens,
          conversation_count: zeroTotals.conversation_count,
        }),
      );
    }
    if (
      !alignedModel &&
      nextAligned &&
      unknownBucket.queuedKey &&
      unknownBucket.queuedKey !== zeroKey
    ) {
      if (unknownBucket.retractedUnknownKey !== zeroKey) {
        toAppend.push(
          JSON.stringify({
            source: group.source,
            model: DEFAULT_MODEL,
            hour_start: group.hourStart,
            input_tokens: zeroTotals.input_tokens,
            cached_input_tokens: zeroTotals.cached_input_tokens,
            cache_creation_input_tokens: zeroTotals.cache_creation_input_tokens,
            output_tokens: zeroTotals.output_tokens,
            reasoning_output_tokens: zeroTotals.reasoning_output_tokens,
            total_tokens: zeroTotals.total_tokens,
            billable_total_tokens: zeroTotals.billable_total_tokens,
            conversation_count: zeroTotals.conversation_count,
          }),
        );
        unknownBucket.retractedUnknownKey = zeroKey;
      }
    }
    if (unknownBucket) unknownBucket.alignedModel = nextAligned;
    const key = totalsKey(unknownBucket.totals);
    const outputKey = outputModel === DEFAULT_MODEL ? key : `${key}|${outputModel}`;
    if (unknownBucket.queuedKey === outputKey) continue;
    toAppend.push(
      JSON.stringify({
        source: group.source,
        model: outputModel,
        hour_start: group.hourStart,
        input_tokens: unknownBucket.totals.input_tokens,
        cached_input_tokens: unknownBucket.totals.cached_input_tokens,
        cache_creation_input_tokens: unknownBucket.totals.cache_creation_input_tokens,
        output_tokens: unknownBucket.totals.output_tokens,
        reasoning_output_tokens: unknownBucket.totals.reasoning_output_tokens,
        total_tokens: unknownBucket.totals.total_tokens,
        billable_total_tokens: unknownBucket.totals.billable_total_tokens ?? unknownBucket.totals.total_tokens,
        conversation_count: unknownBucket.totals.conversation_count,
      }),
    );
    unknownBucket.queuedKey = outputKey;
  }

  if (legacyGroups.size > 0) {
    const grouped = new Map();
    for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
      if (!bucket || !bucket.totals) continue;
      const parsed = parseBucketKey(key);
      const hourStart = parsed.hourStart;
      if (!hourStart) continue;
      const groupKey = groupBucketKey(parsed.source, hourStart);
      if (!legacyGroups.has(groupKey)) continue;

      let group = grouped.get(groupKey);
      if (!group) {
        group = {
          source: normalizeSourceInput(parsed.source) || DEFAULT_SOURCE,
          hourStart,
          models: new Set(),
          totals: initTotals(),
        };
        grouped.set(groupKey, group);
      }
      group.models.add(parsed.model || DEFAULT_MODEL);
      addTotals(group.totals, bucket.totals);
    }

    for (const group of grouped.values()) {
      const model = group.models.size === 1 ? [...group.models][0] : DEFAULT_MODEL;
      const key = totalsKey(group.totals);
      const groupKey = groupBucketKey(group.source, group.hourStart);
      if (groupQueued[groupKey] === key) continue;
      toAppend.push(
        JSON.stringify({
          source: group.source,
          model,
          hour_start: group.hourStart,
          input_tokens: group.totals.input_tokens,
          cached_input_tokens: group.totals.cached_input_tokens,
          cache_creation_input_tokens: group.totals.cache_creation_input_tokens,
          output_tokens: group.totals.output_tokens,
          reasoning_output_tokens: group.totals.reasoning_output_tokens,
          total_tokens: group.totals.total_tokens,
          billable_total_tokens: group.totals.billable_total_tokens ?? group.totals.total_tokens,
          conversation_count: group.totals.conversation_count,
        }),
      );
      groupQueued[groupKey] = key;
    }
  }

  hourlyState.groupQueued = groupQueued;

  if (toAppend.length > 0) {
    await fs.appendFile(queuePath, toAppend.join("\n") + "\n", "utf8");
  }

  return toAppend.length;
}

async function enqueueTouchedProjectBuckets({
  projectQueuePath,
  projectState,
  projectTouchedBuckets,
}) {
  if (
    !projectQueuePath ||
    !projectState ||
    !projectTouchedBuckets ||
    projectTouchedBuckets.size === 0
  )
    return 0;

  await ensureDir(path.dirname(projectQueuePath));

  const toAppend = [];
  for (const key of projectTouchedBuckets) {
    const bucket = projectState.buckets[key];
    if (!bucket || !bucket.totals) continue;
    const totals = bucket.totals;
    const queuedKey = totalsKey(totals);
    if (bucket.queuedKey === queuedKey) continue;
    const projectRef = typeof bucket.project_ref === "string" ? bucket.project_ref : null;
    const projectKey = typeof bucket.project_key === "string" ? bucket.project_key : null;
    if (!projectRef || !projectKey) continue;

    toAppend.push(
      JSON.stringify({
        project_ref: projectRef,
        project_key: projectKey,
        source: bucket.source,
        hour_start: bucket.hour_start,
        input_tokens: totals.input_tokens,
        cached_input_tokens: totals.cached_input_tokens,
        cache_creation_input_tokens: totals.cache_creation_input_tokens,
        output_tokens: totals.output_tokens,
        reasoning_output_tokens: totals.reasoning_output_tokens,
        total_tokens: totals.total_tokens,
        billable_total_tokens: totals.billable_total_tokens ?? totals.total_tokens,
        conversation_count: totals.conversation_count,
      }),
    );
    bucket.queuedKey = queuedKey;
  }

  if (toAppend.length > 0) {
    await fs.appendFile(projectQueuePath, toAppend.join("\n") + "\n", "utf8");
  }

  return toAppend.length;
}

function pickDominantModel(buckets) {
  let dominantModel = null;
  let dominantTotal = -1;
  for (const [model, bucket] of buckets.entries()) {
    if (model === DEFAULT_MODEL) continue;
    const total = Number(bucket?.totals?.total_tokens || 0);
    if (
      dominantModel == null ||
      total > dominantTotal ||
      (total === dominantTotal && model < dominantModel)
    ) {
      dominantModel = model;
      dominantTotal = total;
    }
  }
  return dominantModel;
}

function cloneTotals(totals) {
  const cloned = initTotals();
  addTotals(cloned, totals || {});
  return cloned;
}

function collectCodexDominantModels(hourlyState) {
  const grouped = new Map();
  for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
    if (!bucket || !bucket.totals) continue;
    const parsed = parseBucketKey(key);
    const hourStart = parsed.hourStart;
    if (!hourStart) continue;
    const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
    if (source !== DEFAULT_SOURCE) continue;
    const model = normalizeModelInput(parsed.model) || DEFAULT_MODEL;
    if (model === DEFAULT_MODEL) continue;

    let models = grouped.get(hourStart);
    if (!models) {
      models = new Map();
      grouped.set(hourStart, models);
    }
    const total = Number(bucket.totals.total_tokens || 0);
    models.set(model, (models.get(model) || 0) + total);
  }

  const dominants = [];
  for (const [hourStart, models] of grouped.entries()) {
    let dominantModel = null;
    let dominantTotal = -1;
    for (const [model, total] of models.entries()) {
      if (
        dominantModel == null ||
        total > dominantTotal ||
        (total === dominantTotal && model < dominantModel)
      ) {
        dominantModel = model;
        dominantTotal = total;
      }
    }
    if (dominantModel) {
      dominants.push({ hourStart, model: dominantModel });
    }
  }

  return dominants;
}

function findNearestCodexModel(hourStart, dominants) {
  if (!hourStart || !dominants || dominants.length === 0) return null;
  const target = Date.parse(hourStart);
  if (!Number.isFinite(target)) return null;

  let best = null;
  for (const entry of dominants) {
    const candidate = Date.parse(entry.hourStart);
    if (!Number.isFinite(candidate)) continue;
    const diff = Math.abs(candidate - target);
    if (!best || diff < best.diff || (diff === best.diff && candidate < best.time)) {
      best = { diff, time: candidate, model: entry.model };
    }
  }

  return best ? best.model : null;
}

function normalizeHourlyState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const version = Number(state.version || 1);
  const rawBuckets = state.buckets && typeof state.buckets === "object" ? state.buckets : {};
  const buckets = {};
  const groupQueued = {};

  if (!Number.isFinite(version) || version < 2) {
    for (const [key, value] of Object.entries(rawBuckets)) {
      const parsed = parseBucketKey(key);
      const hourStart = parsed.hourStart;
      if (!hourStart) continue;
      const source = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
      const normalizedKey = bucketKey(source, DEFAULT_MODEL, hourStart);
      buckets[normalizedKey] = value;
      if (value?.queuedKey) {
        groupQueued[groupBucketKey(source, hourStart)] = value.queuedKey;
      }
    }
    return {
      version: 3,
      buckets,
      groupQueued,
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
    };
  }

  for (const [key, value] of Object.entries(rawBuckets)) {
    const parsed = parseBucketKey(key);
    const hourStart = parsed.hourStart;
    if (!hourStart) continue;
    const normalizedKey = bucketKey(parsed.source, parsed.model, hourStart);
    buckets[normalizedKey] = value;
  }

  const existingGroupQueued =
    state.groupQueued && typeof state.groupQueued === "object" ? state.groupQueued : {};

  return {
    version: 3,
    buckets,
    groupQueued: version >= 3 ? existingGroupQueued : {},
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
  };
}

function normalizeProjectState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const rawBuckets = state.buckets && typeof state.buckets === "object" ? state.buckets : {};
  const buckets = {};
  const rawProjects = state.projects && typeof state.projects === "object" ? state.projects : {};
  const projects = {};

  for (const [key, value] of Object.entries(rawBuckets)) {
    if (!key) continue;
    buckets[key] = value;
  }

  for (const [key, value] of Object.entries(rawProjects)) {
    if (!key || !value || typeof value !== "object") continue;
    projects[key] = { ...value };
  }

  return {
    version: 2,
    buckets,
    projects,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
  };
}

function normalizeOpencodeState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const messages = state.messages && typeof state.messages === "object" ? state.messages : {};
  return {
    messages,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
  };
}

function normalizeQoderState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const messages = state.messages && typeof state.messages === "object" ? state.messages : {};
  return {
    messages,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
  };
}

function normalizeMessageKeyPart(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function deriveOpencodeMessageKey(msg, fallback) {
  const sessionId = normalizeMessageKeyPart(msg?.sessionID || msg?.sessionId || msg?.session_id);
  const messageId = normalizeMessageKeyPart(msg?.id || msg?.messageID || msg?.messageId);
  if (sessionId && messageId) return `${sessionId}|${messageId}`;
  return fallback;
}

// ── OpenCode fork-copy dedup (issue #426) ──────────────────────────────────
//
// `Session.fork` copies every parent message up to the fork point into a BRAND
// NEW session. Verified against the shipped opencode binary: the copy is
// `{ ...parentMessage.info, sessionID: newSession.id, id: newMessageId }` — so
// `time.created`, `time.completed`, `modelID`, `providerID` and the entire
// `tokens` payload survive verbatim and only the two identity fields change.
// The forked session is created WITHOUT a parentID (confirmed empirically:
// POST /session/:id/fork returns parentID=null), so the copies cannot be linked
// to their origin by ancestry — content is the only available discriminator.
// Because our dedup key is `sessionID|messageID`, every copied prefix used to be
// counted a second time (a real fork of a 170-message session re-added 20.3M
// tokens; the reporter measured ~2.0B across ~20 forks).
//
// The fingerprint is deliberately narrow — issue #187 is the standing reminder
// that a loose dedup predicate deletes real usage. A collision requires the SAME
// millisecond for BOTH created and completed, byte-equal values in all five
// token columns, the same model, the same provider AND the same source. On top
// of that we only ever drop a match that lives in a DIFFERENT session, since
// forking always mints a new one — two turns inside one session are never
// treated as copies of each other.
function deriveOpencodeMessageFingerprint({ msg, totals, source }) {
  if (!totals || isAllZeroUsage(totals)) return null;
  const created = coerceEpochMs(msg?.time?.created) || 0;
  const completed = coerceEpochMs(msg?.time?.completed) || 0;
  if (!created && !completed) return null;
  // v1 keeps flat modelID/providerID strings; v2 nests them in
  // `model: { id, providerID }` — normalize both (see normalizeOpencodeModelFields).
  const { modelId, providerId } = normalizeOpencodeModelFields(msg);
  const model = modelId || DEFAULT_MODEL;
  const provider = providerId;
  const raw = [
    normalizeSourceInput(source) || "opencode",
    created,
    completed,
    totals.input_tokens,
    totals.output_tokens,
    totals.cached_input_tokens,
    totals.cache_creation_input_tokens,
    totals.reasoning_output_tokens,
    model,
    provider,
  ].join(" ");
  // Hashed rather than stored raw: the fingerprint is persisted per message in
  // cursors.json, and heavy OpenCode users carry tens of thousands of entries.
  return crypto.createHash("sha256").update(raw).digest("base64url").slice(0, 22);
}

// `fingerprint -> messageKey` for counted messages in this cursor namespace.
// Rebuilt per parse run. Pre-#426 entries are fingerprinted as they are read;
// the first claims ownership and later cross-session matches are retracted from
// persisted buckets once. Tombstoned copies never claim ownership themselves.
function buildOpencodeFingerprintIndex(messageIndex) {
  const byFingerprint = new Map();
  if (!messageIndex || typeof messageIndex !== "object") return byFingerprint;
  for (const [key, entry] of Object.entries(messageIndex)) {
    if (entry?.dedupedForkCopy === true) continue;
    const fingerprint = entry && typeof entry.fingerprint === "string" ? entry.fingerprint : null;
    if (fingerprint && !byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, key);
  }
  return byFingerprint;
}

function opencodeMessageKeySession(messageKey) {
  if (typeof messageKey !== "string") return null;
  const idx = messageKey.indexOf("|");
  return idx > 0 ? messageKey.slice(0, idx) : null;
}

// True only when an already-counted message in ANOTHER session carries the exact
// same fingerprint — i.e. this row is a fork copy. Keys without a resolvable
// session (the JSON reader's file-path fallback) never dedup: unproven identity
// must not delete usage.
function isOpencodeForkCopy(fingerprintIndex, fingerprint, messageKey) {
  if (!fingerprint || !fingerprintIndex) return false;
  const owner = fingerprintIndex.get(fingerprint);
  if (!owner || owner === messageKey) return false;
  const ownerSession = opencodeMessageKeySession(owner);
  const session = opencodeMessageKeySession(messageKey);
  if (!ownerSession || !session) return false;
  return ownerSession !== session;
}

// Persist a message's snapshot + fingerprint and claim the fingerprint for it.
// Writes only when something actually changed so a steady-state sync leaves the
// cursor untouched. A falsy `fingerprint` means "unknown" and preserves whatever
// the entry already carried; a new one releases the old claim so a stale
// mid-stream snapshot cannot shadow an unrelated message later.
function recordOpencodeMessage({
  messageIndex,
  fingerprintIndex,
  messageKey,
  totals,
  fingerprint,
  dedupedForkCopy = false,
}) {
  if (!messageIndex || !messageKey) return;
  const prev = messageIndex[messageKey];
  const prevTotals = prev && typeof prev.lastTotals === "object" ? prev.lastTotals : null;
  const prevFingerprint = prev && typeof prev.fingerprint === "string" ? prev.fingerprint : null;
  const nextFingerprint = fingerprint || prevFingerprint;
  const prevDeduped = prev?.dedupedForkCopy === true;
  if (
    sameGeminiTotals(totals, prevTotals) &&
    prevFingerprint === nextFingerprint &&
    prevDeduped === Boolean(dedupedForkCopy)
  ) return;

  if (fingerprintIndex && prevFingerprint && prevFingerprint !== nextFingerprint) {
    if (fingerprintIndex.get(prevFingerprint) === messageKey) {
      fingerprintIndex.delete(prevFingerprint);
    }
  }
  const entry = { lastTotals: totals, updatedAt: new Date().toISOString() };
  if (nextFingerprint) entry.fingerprint = nextFingerprint;
  if (dedupedForkCopy) entry.dedupedForkCopy = true;
  messageIndex[messageKey] = entry;
  if (
    fingerprintIndex &&
    nextFingerprint &&
    !dedupedForkCopy &&
    !fingerprintIndex.has(nextFingerprint)
  ) {
    fingerprintIndex.set(nextFingerprint, messageKey);
  }
}

function repairCountedOpencodeForkCopy({
  msg,
  totals,
  source,
  hourlyState,
  touchedBuckets,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
}) {
  const timestampMs = coerceEpochMs(msg?.time?.completed) || coerceEpochMs(msg?.time?.created);
  if (!timestampMs) return false;
  const bucketStart = toUtcHalfHourStart(new Date(timestampMs).toISOString());
  if (!bucketStart) return false;
  const { modelId: repairModelId } = normalizeOpencodeModelFields(msg);
  const model = repairModelId || DEFAULT_MODEL;
  const counted = { ...totals, conversation_count: 1 };
  const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
  subtractTotals(bucket.totals, counted);
  touchedBuckets.add(bucketKey(source, model, bucketStart));
  if (projectKey && projectState && projectTouchedBuckets) {
    const projectBucket = getProjectBucket(
      projectState,
      projectKey,
      source,
      bucketStart,
      projectRef,
    );
    subtractTotals(projectBucket.totals, counted);
    projectTouchedBuckets.add(projectBucketKey(projectKey, source, bucketStart));
  }
  return true;
}

function getHourlyBucket(state, source, model, hourStart) {
  const buckets = state.buckets;
  const normalizedSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  const normalizedModel = normalizeModelInput(model) || DEFAULT_MODEL;
  const key = bucketKey(normalizedSource, normalizedModel, hourStart);
  let bucket = buckets[key];
  if (!bucket || typeof bucket !== "object") {
    bucket = { totals: initTotals(), queuedKey: null };
    buckets[key] = bucket;
    return bucket;
  }

  if (!bucket.totals || typeof bucket.totals !== "object") {
    bucket.totals = initTotals();
  }

  if (bucket.queuedKey != null && typeof bucket.queuedKey !== "string") {
    bucket.queuedKey = null;
  }

  return bucket;
}

function getProjectBucket(state, projectKey, source, hourStart, projectRef) {
  const buckets = state.buckets;
  const normalizedSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  const key = projectBucketKey(projectKey, normalizedSource, hourStart);
  let bucket = buckets[key];
  if (!bucket || typeof bucket !== "object") {
    bucket = {
      totals: initTotals(),
      queuedKey: null,
      project_key: projectKey,
      project_ref: projectRef,
      source: normalizedSource,
      hour_start: hourStart,
    };
    buckets[key] = bucket;
    return bucket;
  }

  if (!bucket.totals || typeof bucket.totals !== "object") {
    bucket.totals = initTotals();
  }

  if (bucket.queuedKey != null && typeof bucket.queuedKey !== "string") {
    bucket.queuedKey = null;
  }

  if (projectRef) bucket.project_ref = projectRef;
  if (projectKey) bucket.project_key = projectKey;
  bucket.source = normalizedSource;
  bucket.hour_start = hourStart;

  return bucket;
}

function initTotals() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    billable_total_tokens: 0,
    conversation_count: 0,
  };
}

function addTotals(target, delta) {
  target.input_tokens += delta.input_tokens || 0;
  target.cached_input_tokens += delta.cached_input_tokens || 0;
  target.cache_creation_input_tokens += delta.cache_creation_input_tokens || 0;
  target.output_tokens += delta.output_tokens || 0;
  target.reasoning_output_tokens += delta.reasoning_output_tokens || 0;
  target.total_tokens += delta.total_tokens || 0;
  target.billable_total_tokens += delta.billable_total_tokens ?? delta.total_tokens ?? 0;
  target.conversation_count += delta.conversation_count || 0;
}

function subtractTotals(target, totals) {
  target.input_tokens = Math.max(0, target.input_tokens - (totals.input_tokens || 0));
  target.cached_input_tokens = Math.max(
    0,
    target.cached_input_tokens - (totals.cached_input_tokens || 0),
  );
  target.cache_creation_input_tokens = Math.max(
    0,
    target.cache_creation_input_tokens - (totals.cache_creation_input_tokens || 0),
  );
  target.output_tokens = Math.max(0, target.output_tokens - (totals.output_tokens || 0));
  target.reasoning_output_tokens = Math.max(
    0,
    target.reasoning_output_tokens - (totals.reasoning_output_tokens || 0),
  );
  target.total_tokens = Math.max(0, target.total_tokens - (totals.total_tokens || 0));
  target.billable_total_tokens = Math.max(
    0,
    target.billable_total_tokens -
      (totals.billable_total_tokens ?? totals.total_tokens ?? 0),
  );
  target.conversation_count = Math.max(
    0,
    target.conversation_count - (totals.conversation_count || 0),
  );
}

function totalsKey(totals) {
  return [
    totals.input_tokens || 0,
    totals.cached_input_tokens || 0,
    totals.cache_creation_input_tokens || 0,
    totals.output_tokens || 0,
    totals.reasoning_output_tokens || 0,
    totals.total_tokens || 0,
    totals.billable_total_tokens ?? totals.total_tokens ?? 0,
    totals.conversation_count || 0,
  ].join("|");
}

function toUtcHalfHourStart(ts) {
  const dt = new Date(ts);
  if (!Number.isFinite(dt.getTime())) return null;
  const minutes = dt.getUTCMinutes();
  const halfMinute = minutes >= 30 ? 30 : 0;
  const bucketStart = new Date(
    Date.UTC(
      dt.getUTCFullYear(),
      dt.getUTCMonth(),
      dt.getUTCDate(),
      dt.getUTCHours(),
      halfMinute,
      0,
      0,
    ),
  );
  return bucketStart.toISOString();
}

function rolloutDateFromPath(filePath) {
  const match = path.basename(String(filePath || "")).match(/^rollout-(\d{4}-\d{2}-\d{2})T/);
  return match ? match[1] : null;
}

function normalizeIsoDate(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

// Max inter-row gap (ms) still treated as part of a forked rollout's replay
// burst. Empirically the replay flush spaces rows sub-ms to a few ms apart while
// genuine live turns arrive ≥~4.6s apart and the replay→live break is ≥11s, so
// any value in the ~0.25–2s band separates them with a wide margin; 500ms biases
// toward the low end because merging a real fast turn (under-count) is worse than
// leaving a slow replay counted (bounded over-count). See the skip site in
// parseRolloutFile. (issue #169 follow-up.)
const CODEX_FORK_REPLAY_GAP_MS = 500;

function isForkedReplayToken({ isForkedRollout, rolloutDate, currentDate }) {
  return Boolean(isForkedRollout && rolloutDate && currentDate && currentDate < rolloutDate);
}

function normalizeNonNegativeNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function bucketKey(source, model, hourStart) {
  const safeSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  const safeModel = normalizeModelInput(model) || DEFAULT_MODEL;
  return `${safeSource}${BUCKET_SEPARATOR}${safeModel}${BUCKET_SEPARATOR}${hourStart}`;
}

function projectBucketKey(projectKey, source, hourStart) {
  const safeSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  return `${projectKey}${BUCKET_SEPARATOR}${safeSource}${BUCKET_SEPARATOR}${hourStart}`;
}

function groupBucketKey(source, hourStart) {
  const safeSource = normalizeSourceInput(source) || DEFAULT_SOURCE;
  return `${safeSource}${BUCKET_SEPARATOR}${hourStart}`;
}

function parseBucketKey(key) {
  if (typeof key !== "string")
    return { source: DEFAULT_SOURCE, model: DEFAULT_MODEL, hourStart: "" };
  const first = key.indexOf(BUCKET_SEPARATOR);
  if (first <= 0) return { source: DEFAULT_SOURCE, model: DEFAULT_MODEL, hourStart: key };
  const second = key.indexOf(BUCKET_SEPARATOR, first + 1);
  if (second <= 0) {
    return { source: key.slice(0, first), model: DEFAULT_MODEL, hourStart: key.slice(first + 1) };
  }
  return {
    source: key.slice(0, first),
    model: key.slice(first + 1, second),
    hourStart: key.slice(second + 1),
  };
}

function normalizeSourceInput(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModelInput(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// OpenCode v1 stores the model as flat strings on every assistant message
// (`modelID`, `providerID`), while OpenCode v2 (the `opencode2` beta, which
// moved messages into the `session_message` table) nests them inside a single
// object: `model: { id, providerID, variant }`. Some forks also wrote a plain
// string into `model`. Resolve both shapes to { modelId, providerId } so
// bucket keys and fork fingerprints stay identical across versions.
function normalizeOpencodeModelFields(msg) {
  const directModel =
    normalizeModelInput(msg?.modelID) ||
    normalizeModelInput(typeof msg?.model === "string" ? msg.model : null) ||
    normalizeModelInput(msg?.modelId);
  if (directModel) {
    return {
      modelId: directModel,
      providerId: normalizeMessageKeyPart(msg?.providerID || msg?.provider || msg?.providerId),
    };
  }
  const nested = msg?.model;
  if (nested && typeof nested === "object") {
    return {
      modelId: normalizeModelInput(nested.id),
      providerId: normalizeMessageKeyPart(nested.providerID),
    };
  }
  return { modelId: null, providerId: "" };
}

async function resolveProjectMetaForPath(startDir, cache) {
  if (!startDir || typeof startDir !== "string") return null;
  if (cache && cache.has(startDir)) return cache.get(startDir);

  if (startDir.includes(CLAUDE_MEM_OBSERVER_PATH_SEGMENT)) {
    const meta = { projectRef: CLAUDE_MEM_OBSERVER_PROJECT_REF, repoRoot: startDir };
    if (cache) cache.set(startDir, meta);
    return meta;
  }

  const visited = [];
  let current = startDir;
  const root = path.parse(startDir).root;
  while (current) {
    if (cache && cache.has(current)) {
      const cached = cache.get(current);
      for (const entry of visited) cache.set(entry, cached);
      return cached;
    }
    visited.push(current);

    const configPath = await resolveGitConfigPath(current);
    if (configPath) {
      const configStat = await fs.stat(configPath).catch(() => null);
      const remoteUrl = await readGitRemoteUrl(configPath);
      const projectRef = canonicalizeProjectRef(remoteUrl);
      const meta = {
        projectRef: projectRef || null,
        repoRoot: current,
        configPath,
        configMtimeMs:
          configStat && Number.isFinite(configStat.mtimeMs) ? configStat.mtimeMs : null,
        configSize: configStat && Number.isFinite(configStat.size) ? configStat.size : null,
      };
      if (cache) {
        for (const entry of visited) cache.set(entry, meta);
      }
      return meta;
    }

    if (current === root) break;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }

  if (cache) {
    for (const entry of visited) cache.set(entry, null);
  }
  return null;
}

function addProjectFileContext(contexts, projectContext) {
  if (!Array.isArray(contexts) || !projectContext || typeof projectContext !== "object") return;
  const configPath =
    typeof projectContext.configPath === "string" && projectContext.configPath
      ? projectContext.configPath
      : null;
  if (!configPath) return;
  contexts.push(projectContext);
}

function buildProjectFileContext(projectContexts, checkedAtMs = Date.now()) {
  const contexts = Array.isArray(projectContexts)
    ? projectContexts
    : projectContexts && typeof projectContexts === "object"
      ? [projectContexts]
      : [];
  const seen = new Set();
  const configs = [];
  for (const context of contexts) {
    const configPath =
      typeof context?.configPath === "string" && context.configPath ? context.configPath : null;
    if (!configPath || seen.has(configPath)) continue;
    seen.add(configPath);
    configs.push({
      configPath,
      configMtimeMs: Number.isFinite(context.configMtimeMs) ? context.configMtimeMs : null,
      configSize: Number.isFinite(context.configSize) ? context.configSize : null,
    });
  }
  if (configs.length === 0) return { absent: true, checkedAtMs };
  if (configs.length > 1) return { configs };
  const [config] = configs;
  return {
    ...config,
    configs,
  };
}

async function isProjectFileContextFresh(projectFileContext, options = {}) {
  if (!projectFileContext || typeof projectFileContext !== "object") return false;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const absentTtlMs = Number.isFinite(options.absentTtlMs)
    ? options.absentTtlMs
    : PROJECT_ABSENT_CONTEXT_RESCAN_MS;
  const freshnessCache =
    options.freshnessCache && typeof options.freshnessCache === "object"
      ? options.freshnessCache
      : null;
  if (projectFileContext.absent === true) {
    const checkedAtMs = Number(projectFileContext.checkedAtMs);
    return Number.isFinite(checkedAtMs) && checkedAtMs > 0 && nowMs - checkedAtMs < absentTtlMs;
  }
  if (Array.isArray(projectFileContext.configs)) {
    if (projectFileContext.configs.length === 0) return false;
    for (const config of projectFileContext.configs) {
      if (!(await isSingleProjectConfigFresh(config, freshnessCache))) return false;
    }
    return true;
  }
  return isSingleProjectConfigFresh(projectFileContext, freshnessCache);
}

async function isSingleProjectConfigFresh(projectFileContext, freshnessCache = null) {
  const configPath =
    typeof projectFileContext.configPath === "string" ? projectFileContext.configPath : null;
  if (!configPath) return false;
  let st;
  if (freshnessCache && freshnessCache.has(configPath)) {
    st = freshnessCache.get(configPath);
  } else {
    st = await fs.stat(configPath).catch(() => null);
    if (freshnessCache) freshnessCache.set(configPath, st);
  }
  if (!st || !st.isFile()) return false;
  return (
    st.mtimeMs === projectFileContext.configMtimeMs &&
    st.size === projectFileContext.configSize
  );
}

function hashRepoRoot(repoRoot) {
  return crypto.createHash("sha256").update(String(repoRoot)).digest("hex");
}

function deriveProjectKeyFromRef(projectRef) {
  if (typeof projectRef !== "string") return null;
  try {
    const parsed = new URL(projectRef);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    // GitHub paths are always owner/repo, but GitLab supports nested groups
    // (group/subgroup/.../repo). Preserve the full path so nested-group repos
    // don't collapse to the first two segments.
    return segments.join("/");
  } catch (_e) {
    return null;
  }
}

async function defaultPublicRepoResolver({ projectRef, repoRoot }) {
  const repoRootHash = repoRoot ? hashRepoRoot(repoRoot) : null;
  const projectKey = deriveProjectKeyFromRef(projectRef);
  if (!projectKey) {
    return {
      status: "blocked",
      projectKey: null,
      projectRef: projectRef || null,
      repoRootHash,
      reason: projectRef ? "unparseable_ref" : "missing_ref",
    };
  }
  return {
    status: "public_verified",
    projectKey,
    projectRef,
    repoRootHash,
  };
}

function recordProjectMeta(projectState, meta) {
  if (!projectState || !meta || typeof meta !== "object") return;
  const repoRootHash = typeof meta.repoRootHash === "string" ? meta.repoRootHash : null;
  let projectKey = typeof meta.projectKey === "string" ? meta.projectKey : null;
  if (
    !projectKey &&
    repoRootHash &&
    projectState.projects &&
    typeof projectState.projects === "object"
  ) {
    for (const [key, entry] of Object.entries(projectState.projects)) {
      if (entry && entry.repo_root_hash === repoRootHash) {
        projectKey = key;
        break;
      }
    }
  }
  if (!projectKey) return;
  if (!projectState.projects || typeof projectState.projects !== "object") {
    projectState.projects = {};
  }
  const prev = projectState.projects[projectKey] || {};
  const status = typeof meta.status === "string" ? meta.status : null;
  const projectRef = typeof meta.projectRef === "string" ? meta.projectRef : null;
  const next = {
    ...prev,
    project_ref: projectRef || prev.project_ref || null,
    status: status || prev.status || null,
    repo_root_hash: repoRootHash || prev.repo_root_hash || null,
    updated_at: new Date().toISOString(),
  };
  if (status === "blocked" && prev.status !== "blocked") {
    next.purge_pending = true;
  } else if (status && status !== "blocked") {
    next.purge_pending = false;
  }
  projectState.projects[projectKey] = next;
}

async function resolveProjectContextForFile({
  filePath,
  projectMetaCache,
  publicRepoCache,
  publicRepoResolver,
  projectState,
}) {
  if (!filePath) return null;
  return resolveProjectContextForPath({
    startDir: path.dirname(filePath),
    projectMetaCache,
    publicRepoCache,
    publicRepoResolver,
    projectState,
  });
}

async function resolveProjectContextForPath({
  startDir,
  projectMetaCache,
  publicRepoCache,
  publicRepoResolver,
  projectState,
}) {
  if (!startDir) return null;
  const projectMeta = await resolveProjectMetaForPath(startDir, projectMetaCache);
  if (!projectMeta) return null;
  const resolver =
    typeof publicRepoResolver === "function" ? publicRepoResolver : defaultPublicRepoResolver;
  const meta = await resolver({
    projectRef: projectMeta.projectRef,
    repoRoot: projectMeta.repoRoot,
    cache: publicRepoCache,
  });
  const repoRootHash = projectMeta.repoRoot ? hashRepoRoot(projectMeta.repoRoot) : null;
  const normalized = {
    ...(meta || {}),
    projectRef: meta?.projectRef || projectMeta.projectRef,
    projectKey: meta?.projectKey || null,
    status: meta?.status || "blocked",
    repoRootHash: meta?.repoRootHash || repoRootHash,
    configPath: projectMeta.configPath || null,
    configMtimeMs: projectMeta.configMtimeMs ?? null,
    configSize: projectMeta.configSize ?? null,
  };
  recordProjectMeta(projectState, normalized);
  const configFields = {
    configPath: projectMeta.configPath || null,
    configMtimeMs: projectMeta.configMtimeMs ?? null,
    configSize: projectMeta.configSize ?? null,
  };
  if (normalized.status !== "public_verified") {
    return {
      projectRef: normalized.projectRef,
      projectKey: null,
      status: normalized.status,
      ...configFields,
    };
  }
  return {
    projectRef: normalized.projectRef,
    projectKey: normalized.projectKey,
    status: normalized.status,
    ...configFields,
  };
}

// Claude Code session files log the launch cwd on message lines (top-level
// "cwd" field) — unlike the file's on-disk location under
// ~/.claude/projects/<dash-encoded-cwd>/, which is not itself inside the
// real project's git checkout and can never resolve a project via directory
// walk. The encoded name can't be decoded reliably either (dashes in the
// real path collide with the path-separator encoding), so read the real cwd
// from content instead. It's set once at session start and bounded scan is
// cheap since it's a top-level field on the first several lines.
const CLAUDE_CWD_SCAN_MAX_BYTES = 65536;

async function resolveClaudeFileCwd(filePath) {
  const stream = fssync.createReadStream(filePath, {
    encoding: "utf8",
    start: 0,
    end: CLAUDE_CWD_SCAN_MAX_BYTES,
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || !line.includes('"cwd"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      if (typeof obj?.cwd === "string" && obj.cwd.trim()) return obj.cwd.trim();
    }
  } finally {
    rl.close();
    stream.close?.();
  }
  return null;
}

async function resolveGitConfigPath(rootDir) {
  const gitPath = path.join(rootDir, ".git");
  const st = await fs.stat(gitPath).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) {
    const configPath = path.join(gitPath, "config");
    const cfg = await fs.stat(configPath).catch(() => null);
    return cfg && cfg.isFile() ? configPath : null;
  }
  if (st.isFile()) {
    const content = await fs.readFile(gitPath, "utf8").catch(() => "");
    const match = content.match(/gitdir:\s*(.+)/i);
    if (!match) return null;
    let gitDir = match[1].trim();
    if (!gitDir) return null;
    if (!path.isAbsolute(gitDir)) {
      gitDir = path.resolve(rootDir, gitDir);
    }
    const configPath = path.join(gitDir, "config");
    const cfg = await fs.stat(configPath).catch(() => null);
    if (cfg && cfg.isFile()) return configPath;

    const commonDirRaw = await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "");
    const commonDirRel = commonDirRaw.trim();
    if (!commonDirRel) return null;
    let commonDir = commonDirRel;
    if (!path.isAbsolute(commonDir)) {
      commonDir = path.resolve(gitDir, commonDir);
    }
    const commonConfigPath = path.join(commonDir, "config");
    const commonCfg = await fs.stat(commonConfigPath).catch(() => null);
    return commonCfg && commonCfg.isFile() ? commonConfigPath : null;
  }
  return null;
}

async function readGitRemoteUrl(configPath) {
  const raw = await fs.readFile(configPath, "utf8").catch(() => "");
  if (!raw.trim()) return null;

  const remotes = new Map();
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const sectionHeader = line.match(/^\s*\[[^\]]+\]\s*$/);
    if (sectionHeader) {
      const sectionMatch = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/i);
      current = sectionMatch ? sectionMatch[1] : null;
      continue;
    }
    if (!current) continue;
    const urlMatch = line.match(/^\s*url\s*=\s*(.+)\s*$/i);
    if (urlMatch) {
      remotes.set(current, urlMatch[1].trim());
    }
  }

  if (remotes.has("origin")) return remotes.get("origin");
  const first = remotes.values().next();
  return first.done ? null : first.value;
}

function canonicalizeProjectRef(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  let ref = remoteUrl.trim();
  if (!ref) return null;

  if (ref.startsWith("file://")) return null;
  if (path.isAbsolute(ref) || path.win32.isAbsolute(ref)) return null;

  const gitAtMatch = ref.match(/^git@([^:]+):(.+)$/i);
  if (gitAtMatch) {
    ref = `https://${gitAtMatch[1]}/${gitAtMatch[2]}`;
  } else if (ref.startsWith("ssh://")) {
    try {
      const parsed = new URL(ref);
      ref = `https://${parsed.hostname}${parsed.pathname}`;
    } catch (_e) {
      return null;
    }
  } else if (ref.startsWith("git://")) {
    ref = `https://${ref.slice("git://".length)}`;
  } else if (ref.startsWith("http://")) {
    ref = `https://${ref.slice("http://".length)}`;
  } else if (!ref.startsWith("https://")) {
    return null;
  }

  try {
    const parsed = new URL(ref);
    if (!parsed.hostname) return null;
    ref = `https://${parsed.hostname}${parsed.pathname}`;
  } catch (_e) {
    return null;
  }

  ref = ref.replace(/\.git$/i, "");
  ref = ref.replace(/\/+$/, "");
  return ref || null;
}

function normalizeGeminiTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const input = toNonNegativeInt(tokens.input);
  const cached = toNonNegativeInt(tokens.cached);
  const output = toNonNegativeInt(tokens.output);
  const tool = toNonNegativeInt(tokens.tool);
  const thoughts = toNonNegativeInt(tokens.thoughts);
  const reportedTotal = toNonNegativeInt(tokens.total);
  const computedTotal = input + cached + output + tool + thoughts;
  const total = Math.max(reportedTotal, computedTotal);

  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: output + tool,
    reasoning_output_tokens: thoughts,
    total_tokens: total,
  };
}

function normalizeOpencodeTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const input = toNonNegativeInt(tokens.input);
  const output = toNonNegativeInt(tokens.output);
  const reasoning = toNonNegativeInt(tokens.reasoning);
  const cached = toNonNegativeInt(tokens.cache?.read);
  const cacheWrite = toNonNegativeInt(tokens.cache?.write);
  const total = input + output + reasoning + cached + cacheWrite;

  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

function sameGeminiTotals(a, b) {
  if (!a || !b) return false;
  return (
    a.input_tokens === b.input_tokens &&
    a.cached_input_tokens === b.cached_input_tokens &&
    a.cache_creation_input_tokens === b.cache_creation_input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.reasoning_output_tokens === b.reasoning_output_tokens &&
    a.total_tokens === b.total_tokens
  );
}

function diffGeminiTotals(current, previous) {
  if (!current || typeof current !== "object") return null;
  if (!previous || typeof previous !== "object") return current;
  if (sameGeminiTotals(current, previous)) return null;

  const totalReset = (current.total_tokens || 0) < (previous.total_tokens || 0);
  if (totalReset) return current;

  // Must include cache_creation_input_tokens in both the equality check and
  // the delta — OpenCode routes through this diff and its cache.write number
  // would otherwise be permanently reported as zero. Gemini itself always
  // emits cache_creation=0 so the extra field is a no-op for Gemini.
  const delta = {
    input_tokens: Math.max(0, (current.input_tokens || 0) - (previous.input_tokens || 0)),
    cached_input_tokens: Math.max(
      0,
      (current.cached_input_tokens || 0) - (previous.cached_input_tokens || 0),
    ),
    cache_creation_input_tokens: Math.max(
      0,
      (current.cache_creation_input_tokens || 0) - (previous.cache_creation_input_tokens || 0),
    ),
    output_tokens: Math.max(0, (current.output_tokens || 0) - (previous.output_tokens || 0)),
    reasoning_output_tokens: Math.max(
      0,
      (current.reasoning_output_tokens || 0) - (previous.reasoning_output_tokens || 0),
    ),
    total_tokens: Math.max(0, (current.total_tokens || 0) - (previous.total_tokens || 0)),
  };

  return isAllZeroUsage(delta) ? null : delta;
}

function extractTokenCount(obj) {
  const payload = obj?.payload;
  if (!payload) return null;
  if (payload.type === "token_count") {
    return { info: payload.info, timestamp: obj?.timestamp || null };
  }
  const msg = payload.msg;
  if (msg && msg.type === "token_count") {
    return { info: msg.info, timestamp: obj?.timestamp || null };
  }
  return null;
}

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
    const n = Number(u[k] || 0);
    out[k] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  // Codex rollouts (and Every Code, which shares the format) report
  // `input_tokens` as the TOTAL prompt, with `cached_input_tokens` as the
  // cached subset — i.e. the cached slice is INSIDE the input count. Our
  // queue schema (CLAUDE.md → Token Normalization Convention) stores
  // `input_tokens` as pure non-cached input and `cached_input_tokens`
  // separately. Without this subtraction the cost formula bills the cached
  // bytes twice: once at the full input rate and again at the cache_read
  // rate, producing ~6–7x cost inflation on cache-heavy Codex sessions
  // (verified against ccusage's per-day numbers on the same rollouts).
  // We intentionally leave `total_tokens` unchanged: Codex reports
  // total = input(inclusive of cached) + output, which numerically equals
  // our schema's non_cached + cached + output + 0 (cache_creation=0 here).
  out.input_tokens = Math.max(0, out.input_tokens - out.cached_input_tokens);
  return out;
}

// Stable dedup key for one Claude jsonl entry. Anthropic's official protocol
// guarantees `message.id` is globally unique per response, so msgId alone is a
// valid dedup key. Older code required both msgId AND requestId, which short-
// circuited dedup entirely for jsonl entries where `requestId` is absent
// (DeepSeek/Kimi/Mimo/MiniMax anthropic-compatible endpoints don't return the
// `request-id` HTTP header, and Claude Code's sub-agent / thinking transport
// paths drop the field too). The short-circuit caused 1.6–3.7x overcounting on
// every affected provider — see issue #64. Falling back to msgId-only keeps
// backward compatibility for the (msgId, reqId) format already persisted in
// cursors.claudeHashes (msgId strings don't contain `:`, so the two formats
// share the same Set without collision).
function claudeMessageDedupKey(obj) {
  const msgId = typeof obj?.message?.id === "string" && obj.message.id ? obj.message.id : null;
  if (!msgId) return null;
  const reqId = typeof obj?.requestId === "string" && obj.requestId ? obj.requestId : null;
  return reqId ? `${msgId}:${reqId}` : msgId;
}

function normalizeClaudeUsage(u) {
  const inputTokens = toNonNegativeInt(u?.input_tokens);
  const outputTokens = toNonNegativeInt(u?.output_tokens);
  const cacheCreation = toNonNegativeInt(u?.cache_creation_input_tokens);
  const cacheRead = toNonNegativeInt(u?.cache_read_input_tokens);
  const totalTokens = inputTokens + outputTokens + cacheCreation + cacheRead;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
}

function isNonEmptyObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0);
}

function isAllZeroUsage(u) {
  if (!u || typeof u !== "object") return true;
  for (const k of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    if (Number(u[k] || 0) !== 0) return false;
  }
  return true;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function toNonNegativeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function firstPresentNonNegativeInt(values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return toNonNegativeInt(value);
    }
  }
  return 0;
}

function firstPositiveOrPresentNonNegativeInt(values) {
  let firstPresent = null;
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const n = toNonNegativeInt(value);
    if (firstPresent === null) firstPresent = n;
    if (n > 0) return n;
  }
  return firstPresent === null ? 0 : firstPresent;
}

function coerceEpochMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 1e12) return Math.floor(n * 1000);
  return Math.floor(n);
}

async function safeReadDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
}

async function walkClaudeProjects(dir, out) {
  const entries = await safeReadDir(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkClaudeProjects(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(fullPath);
  }
}

async function walkOpencodeMessages(dir, out) {
  const entries = await safeReadDir(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkOpencodeMessages(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("msg_") && entry.name.endsWith(".json"))
      out.push(fullPath);
  }
}

// ---------------------------------------------------------------------------
// OpenCode SQLite DB reader
//
// Two storage generations share the same file (~/.local/share/opencode/opencode.db):
//   v1 (`opencode` ≤1.x): messages in the `message` table, role inside the JSON
//     blob (`$.role`), flat `modelID`/`providerID` strings.
//   v2 (`opencode2` beta): messages moved to `session_message` (role is now the
//     `type` column), model nested as `model: { id, providerID }`, and the
//     project directory lives on `session_v2.directory`.
// Detect the generation via sqlite_master and fall back to trying both so
// exotic setups (or partial mocks in tests) still read something sensible.
// ---------------------------------------------------------------------------

const OPENCODE_DB_V1_MESSAGE_SQL =
  `SELECT id, session_id, time_updated, data FROM message ` +
  `WHERE json_extract(data, '$.role') = 'assistant' ORDER BY time_created ASC`;

// LEFT JOIN keeps orphaned rows readable; `directory` feeds project attribution
// (injected into msg.path.cwd below so downstream resolution stays unchanged).
const OPENCODE_DB_V2_MESSAGE_SQL =
  `SELECT sm.id AS id, sm.session_id AS session_id, sm.time_updated AS time_updated, ` +
  `s.directory AS directory, sm.data AS data ` +
  `FROM session_message sm LEFT JOIN session_v2 s ON s.id = sm.session_id ` +
  `WHERE sm.type = 'assistant' ORDER BY sm.time_created ASC`;

function detectOpencodeDbGeneration(dbPath, sqliteOptions = {}) {
  let rows;
  try {
    rows = readSqliteJsonRows(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('message','session_message')`,
      { label: "OpenCode", timeout: 10_000, maxBuffer: 1024 * 1024, ...sqliteOptions },
    );
  } catch (_e) {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const names = new Set(rows.map((r) => String(r?.name || "").trim()).filter(Boolean));
  if (names.size === 0) return null;
  return { hasV1MessageTable: names.has("message"), hasV2SessionMessageTable: names.has("session_message") };
}

function readOpencodeDbMessages(dbPath, sqliteOptions = {}) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];

  let snapshot = null;
  let effectiveDbPath = dbPath;
  if (isUncPath(dbPath)) {
    try {
      snapshot = snapshotSqliteDb(dbPath);
      effectiveDbPath = snapshot.path;
    } catch (_e) { }
  }

  // Parse raw SQL rows into the shared { id, sessionID, timeUpdated, data }
  // shape; optionally restore v2's session-level project directory as the
  // per-message `path.cwd` the rest of the pipeline expects.
  const collectRows = (rows, isV2) => {
    const out = [];
    for (const row of rows) {
      if (!row || typeof row.data !== "string") continue;
      let data;
      try {
        data = JSON.parse(row.data);
      } catch (_e) {
        continue;
      }
      const tokens = data?.tokens;
      if (!tokens || typeof tokens !== "object") continue;
      // Skip messages with no meaningful token data
      const hasTokens =
        toNonNegativeInt(tokens.input) > 0 ||
        toNonNegativeInt(tokens.output) > 0 ||
        toNonNegativeInt(tokens.reasoning) > 0;
      if (!hasTokens) continue;
      if (isV2 && typeof row.directory === "string" && row.directory.trim()) {
        data.path = { ...(typeof data.path === "object" && data.path ? data.path : {}), cwd: row.directory };
      }
      out.push({
        id: row.id || data.id,
        sessionID: row.session_id || data.sessionID,
        timeUpdated: row.time_updated || 0,
        data,
      });
    }
    return out;
  };

  const readGeneration = (sql, isV2) => {
    try {
      const rows = readSqliteJsonRows(effectiveDbPath, sql, {
        label: "OpenCode",
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30_000,
        throwOnReadFailure: true,
        ...sqliteOptions,
      });
      return Array.isArray(rows) ? rows : [];
    } catch (_e) {
      return null; // query-level failure (e.g. wrong generation's table)
    }
  };

  try {
    // Prefer the detected generation. When detection is inconclusive (legacy
    // forks with odd sqlite setups, mocked readers in tests), try v1 first and
    // fall through to v2 only if v1 errored or came up empty — a real database
    // carries exactly one generation, so the first non-empty read wins.
    const generation = detectOpencodeDbGeneration(effectiveDbPath, sqliteOptions);
    if (generation) {
      let out = [];
      if (generation.hasV1MessageTable) {
        out = out.concat(collectRows(readGeneration(OPENCODE_DB_V1_MESSAGE_SQL, false) || [], false));
      }
      if (generation.hasV2SessionMessageTable) {
        out = out.concat(collectRows(readGeneration(OPENCODE_DB_V2_MESSAGE_SQL, true) || [], true));
      }
      return out;
    }

    for (const [sql, isV2] of [
      [OPENCODE_DB_V1_MESSAGE_SQL, false],
      [OPENCODE_DB_V2_MESSAGE_SQL, true],
    ]) {
      const rows = readGeneration(sql, isV2);
      if (!rows) continue;
      const out = collectRows(rows, isV2);
      if (out.length > 0) return out;
    }
    return [];
  } finally {
    if (snapshot) snapshot.cleanup();
  }
}

// mimocode mirrors the user's Claude Code + claude-mem history into its own
// `message` table — via an explicit `claude_import` AND a live observer /
// session sync — so the overwhelming majority of rows are anthropic-endpoint
// turns (providerID="anthropic") the Claude parser ALREADY counts as
// source=claude. On the dev's box that's ~3.9B mirrored tokens vs ~22M genuine
// mimo tokens. Counting the mirror under "mimo" double-counts and mislabels
// Claude usage (user saw claude-* rows under the MIMO provider).
//
// The discriminator is providerID, NOT the model id. mimo's own runtime tags
// turns providerID="mimo" (its auto router) or "xiaomi". providerID="anthropic"
// means the turn went through a Claude-compatible endpoint — plain Claude Code,
// OR a mimo-named model the user picked IN Claude Code (e.g. model=mimo-v2.5-pro
// run inside Claude Code, logged in ~/.claude, counted as source=claude). Keying
// off the model id would wrongly re-count that mimo-v2.5-pro. claude_import is
// irrelevant — it never covers the observer/session mirror; the provider rule
// subsumes it.
function isMimoNativeMessage(data) {
  if (!data) return false;
  const provider = String(data.providerID || "").toLowerCase();
  return provider === "mimo" || provider === "xiaomi";
}

// Read only genuine mimo assistant messages (mimo's own models), dropping the
// mirrored Claude/claude-mem rows. See isMimoNativeMessage for why.
function readMimoDbMessages(dbPath, sqliteOptions = {}) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const all = readOpencodeDbMessages(dbPath, sqliteOptions);
  return all.filter((m) => isMimoNativeMessage(m.data));
}

// ZCode is Z.ai's (Zhipu) coding agent — another OpenCode-fork that stores
// assistant messages in the identical `message` table schema
// (~/.zcode/cli/db/db.sqlite). Its own agent runs GLM models through Z.ai /
// BigModel endpoints (providerID "builtin:zai-start-plan",
// "builtin:bigmodel-coding-plan", …), but ZCode also lets users add CUSTOM
// providers (a built-in feature beyond the Z.ai plan subscription) that point at
// ANY model — MiMo, Sakana Fugu, any OpenAI-compatible proxy. A user-defined
// provider is assigned a random UUID as its providerID (observed on a real box:
// model "mimo-v2.5-pro" under providerID "265956bf-…"), so an allowlist of known
// vendor keywords can NEVER match it and silently drops every custom-provider
// turn (issue #216). Those turns live ONLY in this DB, so we must keep them or
// they go uncounted entirely. The exception is the bundled
// claude-code / codex / gemini-cli sub-agents ZCode can orchestrate: those carry
// providerID "anthropic"/"openai"/"google" and write to ~/.claude / ~/.codex /
// ~/.gemini, so the standalone Claude/Codex/Gemini parsers already count them —
// DROP those here to avoid double-counting. Hence a blocklist (exclude the three
// direct vendors), not an allowlist that would silently miss every third-party
// model. Key off providerID, NEVER the model id — a GLM/Claude model the user
// ran *inside* Claude Code is source=claude, so matching the model name would
// re-count it. Mirrors the Mimo discipline.
function isZcodeNativeMessage(data) {
  if (!data) return false;
  const provider = String(data.providerID || "").toLowerCase();
  if (!provider) return false;
  return !(
    provider.includes("anthropic") ||
    provider.includes("openai") ||
    provider.includes("google")
  );
}

// Read only genuine ZCode assistant messages (its own GLM models via Z.ai /
// BigModel), dropping any bundled sub-agent turns. See isZcodeNativeMessage.
function readZcodeDbMessages(dbPath, sqliteOptions = {}) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const all = readOpencodeDbMessages(dbPath, sqliteOptions);
  return all.filter((m) => isZcodeNativeMessage(m.data));
}

async function parseOpencodeDbIncremental({
  dbMessages,
  dbPath,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  cursorKey,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let messagesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const messages = Array.isArray(dbMessages) ? dbMessages : [];
  const totalMessages = messages.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const cursorNamespace = typeof cursorKey === "string" && cursorKey.length > 0 ? cursorKey : "opencode";
  const opencodeState = normalizeOpencodeState(cursors?.[cursorNamespace]);
  const messageIndex = opencodeState.messages;
  const fingerprintIndex = buildOpencodeFingerprintIndex(messageIndex);
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || "opencode";

  for (let idx = 0; idx < messages.length; idx++) {
    const entry = messages[idx];
    const msg = entry.data;
    if (!msg) continue;

    // DB stores id/sessionID as separate columns; inject into msg for key derivation
    const msgForKey = { ...msg };
    if (entry.id && !msgForKey.id) msgForKey.id = entry.id;
    if (entry.sessionID && !msgForKey.sessionID) msgForKey.sessionID = entry.sessionID;
    const messageKey = deriveOpencodeMessageKey(msgForKey, null);
    if (!messageKey) {
      messagesProcessed += 1;
      continue;
    }

    // Skip messages already indexed (from prior JSON-file parsing or previous DB sync)
    const prev = messageIndex[messageKey];
    const lastTotals = prev && typeof prev.lastTotals === "object" ? prev.lastTotals : null;

    const currentTotals = normalizeOpencodeTokens(msg?.tokens);
    if (!currentTotals) {
      messagesProcessed += 1;
      continue;
    }

    // A fork copy of an already-counted turn contributes nothing. Existing
    // pre-#426 cursor entries were already added to hourly/project buckets;
    // retract those once, then persist a tombstone so a later sync is a no-op.
    const fingerprint = deriveOpencodeMessageFingerprint({
      msg,
      totals: currentTotals,
      source: defaultSource,
    });
    if (isOpencodeForkCopy(fingerprintIndex, fingerprint, messageKey)) {
      let projectContext = null;
      if (lastTotals && prev?.dedupedForkCopy !== true && projectEnabled) {
        projectContext = await resolveProjectContextForDb({
          msg,
          dbPath,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        });
      }
      if (lastTotals && prev?.dedupedForkCopy !== true) {
        repairCountedOpencodeForkCopy({
          msg,
          totals: lastTotals,
          source: defaultSource,
          hourlyState,
          touchedBuckets,
          projectState,
          projectTouchedBuckets,
          projectRef: projectContext?.projectRef || null,
          projectKey: projectContext?.projectKey || null,
        });
      }
      recordOpencodeMessage({
        messageIndex,
        fingerprintIndex,
        messageKey,
        totals: currentTotals,
        fingerprint,
        dedupedForkCopy: true,
      });
      messagesProcessed += 1;
      continue;
    }

    const effectiveLastTotals = prev?.dedupedForkCopy === true ? null : lastTotals;
    const delta = diffGeminiTotals(currentTotals, effectiveLastTotals);
    if (!delta || isAllZeroUsage(delta)) {
      // Refresh the index even without a delta: normalization may have changed,
      // and pre-#426 entries need their fingerprint backfilled so a fork taken
      // from an old session is still recognised.
      recordOpencodeMessage({
        messageIndex,
        fingerprintIndex,
        messageKey,
        totals: currentTotals,
        fingerprint,
        dedupedForkCopy: false,
      });
      messagesProcessed += 1;
      if (cb) {
        cb({
          index: idx + 1,
          total: totalMessages,
          messagesProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
      continue;
    }
    delta.conversation_count = 1;

    const timestampMs = coerceEpochMs(msg?.time?.completed) || coerceEpochMs(msg?.time?.created);
    if (!timestampMs) {
      messagesProcessed += 1;
      continue;
    }

    const tsIso = new Date(timestampMs).toISOString();
    const bucketStart = toUtcHalfHourStart(tsIso);
    if (!bucketStart) {
      messagesProcessed += 1;
      continue;
    }

    const { modelId: dbModelId } = normalizeOpencodeModelFields(msg);
    const model = dbModelId || DEFAULT_MODEL;
    const bucket = getHourlyBucket(hourlyState, defaultSource, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(defaultSource, model, bucketStart));

    if (projectEnabled) {
      const projectContext = await resolveProjectContextForDb({
        msg,
        dbPath,
        projectMetaCache,
        publicRepoCache,
        publicRepoResolver,
        projectState,
      });
      const projectRef = projectContext?.projectRef || null;
      const projectKey = projectContext?.projectKey || null;
      if (projectKey && projectState && projectTouchedBuckets) {
        const projectBucket = getProjectBucket(
          projectState,
          projectKey,
          defaultSource,
          bucketStart,
          projectRef,
        );
        addTotals(projectBucket.totals, delta);
        projectTouchedBuckets.add(projectBucketKey(projectKey, defaultSource, bucketStart));
      }
    }

    recordOpencodeMessage({
      messageIndex,
      fingerprintIndex,
      messageKey,
      totals: currentTotals,
      fingerprint,
      dedupedForkCopy: false,
    });
    messagesProcessed += 1;
    eventsAggregated += 1;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalMessages,
        messagesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  opencodeState.updatedAt = new Date().toISOString();
  cursors[cursorNamespace] = opencodeState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { messagesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

const QODER_USAGE_SQL = `
SELECT
  cm.rowid AS row_id,
  cm.id,
  cm.session_id,
  cm.request_id,
  cm.token_info,
  cm.model_info,
  cm.gmt_create,
  cr.extra AS record_extra,
  cs.preferred_model_info,
  cs.project_uri,
  cs.project_name
FROM chat_message AS cm
LEFT JOIN chat_record AS cr ON cr.request_id = cm.request_id
LEFT JOIN chat_session AS cs ON cs.session_id = cm.session_id
WHERE cm.role = 'assistant'
  AND cm.token_info IS NOT NULL
  AND trim(cm.token_info) NOT IN ('', '{}')
ORDER BY cm.gmt_create, cm.rowid
`;

function resolveQoderDbPath({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  appDir = "Qoder",
  envPrefix = "QODER",
} = {}) {
  const dbPathKey = `${envPrefix}_DB_PATH`;
  const homeKey = `${envPrefix}_HOME`;
  if (typeof env[dbPathKey] === "string" && env[dbPathKey].trim()) {
    return path.resolve(env[dbPathKey].trim());
  }
  let root;
  if (typeof env[homeKey] === "string" && env[homeKey].trim()) {
    root = path.resolve(env[homeKey].trim());
  } else if (platform === "darwin") {
    root = path.join(home, "Library", "Application Support", appDir);
  } else if (platform === "win32") {
    root = path.join(
      env.APPDATA || path.join(home, "AppData", "Roaming"),
      appDir,
    );
  } else {
    root = path.join(home, ".config", appDir);
  }
  return path.join(root, "SharedClientCache", "cache", "db", "local.db");
}

function resolveQoderDbPaths({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  appDir = "Qoder",
  envPrefix = "QODER",
  deps = {},
} = {}) {
  const dbPathKey = `${envPrefix}_DB_PATH`;
  const homeKey = `${envPrefix}_HOME`;
  const nativeValue = resolveQoderDbPath({ home, env, platform, appDir, envPrefix });
  if (platform !== "win32" || env[dbPathKey] || env[homeKey]) {
    return { native: nativeValue, wsl: null };
  }
  const existsSync = deps.existsSync || fssync.existsSync;
  const native = wsl.shouldProbeNative(env) && existsSync(nativeValue) ? nativeValue : null;
  const discoverWslHome = deps.discoverWslHome || wsl.discoverWslHome;
  const wslRoot = wsl.shouldProbeWsl(env)
    ? discoverWslHome(`.config/${appDir}`, { ...deps, env })
    : null;
  const wslValue = wslRoot
    ? path.join(wslRoot, "SharedClientCache", "cache", "db", "local.db")
    : null;
  const wslDb = wslValue && existsSync(wslValue) ? wslValue : null;
  return wsl.resolveAllWin32Paths({
    nativeValue: native,
    wslValue: wslDb,
    env,
    platform: "win32",
  });
}

// Qoder CN keeps its own data directory (Application Support/QoderCN on macOS,
// AppData/Roaming/QoderCN on Windows, .config/QoderCN on Linux), so it needs
// its own path resolution. The token schema is identical to the international
// edition — the same QODER_USAGE_SQL and parser are reused with a distinct
// source/cursor namespace to avoid rowid collisions between the two DBs. CN
// honors its own env overrides (QODER_CN_DB_PATH / QODER_CN_HOME) so that
// QODER_HOME/QODER_DB_PATH, which point at the international install, never
// redirect the CN resolver onto the same database (that would double-count).
function resolveQoderCnDbPaths({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  deps = {},
} = {}) {
  return resolveQoderDbPaths({ home, env, platform, appDir: "QoderCN", envPrefix: "QODER_CN", deps });
}

async function readQoderDbMessages(dbPath, sqliteOptions = {}) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  return readSqliteJsonRowsAsync(dbPath, QODER_USAGE_SQL, {
    label: "Qoder",
    ...sqliteOptions,
  });
}

function parseJsonObject(value) {
  if (!value) return null;
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizeQoderTokens(tokenInfo) {
  const tokens = parseJsonObject(tokenInfo);
  if (!tokens) return null;
  const prompt = Number(tokens.prompt_tokens);
  const cached = Number(tokens.cached_tokens || 0);
  const completion = Number(tokens.completion_tokens);
  if (
    !Number.isFinite(prompt) ||
    !Number.isFinite(cached) ||
    !Number.isFinite(completion) ||
    prompt < 0 ||
    cached < 0 ||
    completion < 0
  ) {
    return null;
  }
  // Qoder's prompt_tokens already includes cached_tokens. Keep cached input in
  // its own column and report only the remainder as ordinary input, otherwise
  // cached context is counted twice in dashboards and cost calculations.
  const input = Math.max(0, Math.trunc(prompt) - Math.trunc(cached));
  const cachedInput = Math.min(Math.trunc(prompt), Math.trunc(cached));
  const output = Math.trunc(completion);
  return {
    input_tokens: input,
    cached_input_tokens: cachedInput,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: Math.trunc(prompt) + output,
    billable_total_tokens: Math.trunc(prompt) + output,
  };
}

function qoderModelFromRow(row) {
  const direct = parseJsonObject(row?.model_info);
  const recordExtra = parseJsonObject(row?.record_extra);
  const preferred = parseJsonObject(row?.preferred_model_info);
  return (
    normalizeModelInput(direct?.model_key || direct?.modelKey) ||
    normalizeModelInput(recordExtra?.modelConfig?.key || recordExtra?.model_config?.key) ||
    normalizeModelInput(
      preferred?.model_key ||
      preferred?.modelKey ||
      preferred?.preferred_model ||
      preferred?.preferredModel,
    ) ||
    "qoder-agent"
  );
}

function qoderMessageKey(row) {
  const id = normalizeMessageKeyPart(row?.id);
  const sessionId = normalizeMessageKeyPart(row?.session_id);
  if (sessionId && id) return `${sessionId}|${id}`;
  if (id) return id;
  const rowId = row?.row_id;
  return rowId === null || rowId === undefined ? null : `row:${rowId}`;
}

function qoderProjectPath(row) {
  const raw = typeof row?.project_uri === "string" ? row.project_uri.trim() : "";
  if (!raw) return null;
  if (!raw.startsWith("file://")) return raw;
  try {
    return decodeURIComponent(new URL(raw).pathname);
  } catch (_error) {
    return null;
  }
}

async function parseQoderDbIncremental({
  dbMessages,
  dbPath,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  publicRepoResolver,
  sourceKey = "qoder",
  cursorKey = "qoder",
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const rows = Array.isArray(dbMessages) ? dbMessages : [];
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const qoderState = normalizeQoderState(cursors?.[cursorKey]);
  const touchedBuckets = new Set();
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const requestOwners = new Map();
  for (const row of rows) {
    const messageKey = qoderMessageKey(row);
    if (
      !messageKey ||
      !normalizeQoderTokens(row?.token_info) ||
      !coerceEpochMs(row?.gmt_create)
    ) {
      continue;
    }
    const requestKey =
      normalizeMessageKeyPart(row?.request_id) ||
      normalizeMessageKeyPart(row?.session_id) ||
      messageKey;
    if (!requestOwners.has(requestKey)) requestOwners.set(requestKey, messageKey);
  }
  const cb = typeof onProgress === "function" ? onProgress : null;
  let messagesProcessed = 0;
  let eventsAggregated = 0;

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const messageKey = qoderMessageKey(row);
    const currentBase = normalizeQoderTokens(row?.token_info);
    const timestampMs = coerceEpochMs(row?.gmt_create);
    const bucketStart = timestampMs
      ? toUtcHalfHourStart(new Date(timestampMs).toISOString())
      : null;
    if (!messageKey || !currentBase || !bucketStart) {
      messagesProcessed += 1;
      continue;
    }

    const requestKey =
      normalizeMessageKeyPart(row?.request_id) ||
      normalizeMessageKeyPart(row?.session_id) ||
      messageKey;
    const previous = qoderState.messages[messageKey];
    // Recompute request ownership from the complete ordered DB snapshot on
    // every pass. Qoder can attach token_info to an earlier assistant row only
    // after a later row was already counted; retaining the old per-message
    // owner in that case inflates one request to two conversations.
    const conversationCount = requestOwners.get(requestKey) === messageKey ? 1 : 0;

    const currentTotals = {
      ...currentBase,
      conversation_count: conversationCount,
    };
    const model = qoderModelFromRow(row);
    let projectKey = null;
    let projectRef = null;
    if (projectEnabled) {
      const projectPath = qoderProjectPath(row);
      if (projectPath) {
        const context = await resolveProjectContextForPath({
          startDir: wsl.mapWslCwdToUnc(projectPath, dbPath),
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        });
        projectKey = context?.projectKey || null;
        projectRef = context?.projectRef || null;
      }
    }

    const previousTotals =
      previous?.totals && typeof previous.totals === "object" ? previous.totals : null;
    const unchanged =
      previousTotals &&
      totalsKey(previousTotals) === totalsKey(currentTotals) &&
      previous.bucketStart === bucketStart &&
      previous.model === model &&
      (previous.projectKey || null) === projectKey;
    if (!unchanged) {
      if (previousTotals && previous.bucketStart && previous.model) {
        const oldBucket = getHourlyBucket(
          hourlyState,
          sourceKey,
          previous.model,
          previous.bucketStart,
        );
        subtractTotals(oldBucket.totals, previousTotals);
        touchedBuckets.add(bucketKey(sourceKey, previous.model, previous.bucketStart));
        if (projectEnabled && previous.projectKey) {
          const oldProjectBucket = getProjectBucket(
            projectState,
            previous.projectKey,
            sourceKey,
            previous.bucketStart,
            previous.projectRef || null,
          );
          subtractTotals(oldProjectBucket.totals, previousTotals);
          projectTouchedBuckets.add(
            projectBucketKey(previous.projectKey, sourceKey, previous.bucketStart),
          );
        }
      }

      const bucket = getHourlyBucket(hourlyState, sourceKey, model, bucketStart);
      addTotals(bucket.totals, currentTotals);
      touchedBuckets.add(bucketKey(sourceKey, model, bucketStart));
      if (projectEnabled && projectKey) {
        const projectBucket = getProjectBucket(
          projectState,
          projectKey,
          sourceKey,
          bucketStart,
          projectRef,
        );
        addTotals(projectBucket.totals, currentTotals);
        projectTouchedBuckets.add(projectBucketKey(projectKey, sourceKey, bucketStart));
      }
      qoderState.messages[messageKey] = {
        totals: currentTotals,
        conversationCount,
        requestKey,
        bucketStart,
        model,
        projectKey,
        projectRef,
        updatedAt: new Date().toISOString(),
      };
      eventsAggregated += 1;
    }

    messagesProcessed += 1;
    if (cb) {
      cb({
        index: index + 1,
        total: rows.length,
        messagesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({
    queuePath,
    hourlyState,
    touchedBuckets,
  });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({
        projectQueuePath,
        projectState,
        projectTouchedBuckets,
      })
    : 0;
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  qoderState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors[cursorKey] = qoderState;
  if (projectState) {
    projectState.updatedAt = updatedAt;
    cursors.projectHourly = projectState;
  }
  return { messagesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

// ── Claude Science (Anthropic's local research workbench, issue #246) ──
//
// Claude Science keeps all of its state in a SQLite database named
// `operon-cli.db`. There is no native Windows build — on Windows the app runs
// INSIDE WSL, so the DB lives on the distro's ext4 home, not under %USERPROFILE%
// (see resolveClaudeScienceDbPaths).
//
// Per-frame token usage lives on the `frames` table. A row is one agent
// session/sub-session and records its OWN counters; Claude Science's own
// per-conversation rollup (`sumTokensForRoot`) plainly sums every row under a
// root, so summing across frames never double-counts a parent's children.
//
// TWO load-bearing quirks, both verified against real frames by reproducing
// Claude Science's own cost function to 6 significant figures:
//
//  1. `input_tokens` is OpenAI-style — it ALREADY INCLUDES cache reads and
//     writes. Claude Science's accumulator adds `totalInputTokens`
//     (= cacheRead + cacheWrite + uncached), not the Anthropic API's
//     `input_tokens`. Treating the column as pure non-cached input prices cache
//     reads at the full input rate and inflates cost ~5.6x, while also counting
//     the cache columns twice in total_tokens (~1.97x). Subtract them back out.
//  2. `aux_*` are real, billable usage from background helper calls (rolling
//     compaction, compaction summaries, artifact provenance extraction,
//     biosecurity screening, memory extraction). They are DISJOINT from the
//     headline columns — the summarizer call is issued with
//     `skip_cost_accumulation: true` so it bypasses the main accumulator — and
//     Claude Science's own rollup adds them in. Dropping them under-counts by
//     ~11.5%. `aux_input_tokens` carries the same cache-inclusive convention.
//
//     Known approximation: aux tokens get priced at the frame's headline model
//     rate, but the helper calls actually run on a cheaper model, and Claude
//     Science does not persist which one (nor a per-aux cache split — the
//     aux_cache_* columns come back NULL even when aux_cost implies cache
//     reads). Measured on real frames, that overprices the aux slice ~2.4x,
//     i.e. ~20% high on the frame total. Counting the tokens and accepting a
//     bounded cost skew beats dropping 11.5% of usage outright, but if Claude
//     Science ever records the aux model, price that slice separately.
//
// `token_class_usage` is deliberately NOT read: it is an attribution *slice* of
// the same tokens (assistant_prose / tool_calls / thinking / …), so its classes
// sum back to the columns above and adding it would double count.
// The cache and aux columns arrived in later drizzle migrations, so build the
// SELECT from PRAGMA table_info rather than naming them blindly — an older
// operon-cli.db must degrade to the columns it has instead of erroring the
// whole provider out.
//
// The usage predicate doubles as the seed-frame filter: a fresh install ships
// four Anthropic demo frames whose token columns are all NULL. Their
// `context_data` JSON still carries the demo run's real numbers (~23.6M tokens
// / $28.5), which is exactly why this parser reads columns and never that blob.
const CLAUDE_SCIENCE_TOKEN_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "aux_input_tokens",
  "aux_output_tokens",
  "aux_cache_read_tokens",
  "aux_cache_write_tokens",
];

function buildClaudeScienceFramesQuery(columnNames) {
  const columns = new Set(columnNames);
  const optional = (col) => (columns.has(col) ? col : `NULL AS ${col}`);
  const present = CLAUDE_SCIENCE_TOKEN_COLUMNS.filter((col) => columns.has(col));
  const where = present.length
    ? `WHERE ${present.map((col) => `COALESCE(${col}, 0) <> 0`).join("\n   OR ")}`
    : "WHERE 0";
  return `
SELECT
  id,
  parent_frame_id,
  model,
  ${CLAUDE_SCIENCE_TOKEN_COLUMNS.map(optional).join(",\n  ")},
  created_at,
  ${optional("updated_at")},
  ${optional("completed_at")}
FROM frames
${where}
ORDER BY created_at, id
`;
}

// `operon.db` is the pre-rename filename; both are still probed.
const CLAUDE_SCIENCE_DB_FILENAMES = ["operon-cli.db", "operon.db"];

function resolveClaudeScienceRoot({ home = os.homedir(), env = process.env } = {}) {
  const override =
    typeof env.CLAUDE_SCIENCE_HOME === "string" && env.CLAUDE_SCIENCE_HOME.trim()
      ? path.resolve(env.CLAUDE_SCIENCE_HOME.trim())
      : null;
  return override || path.join(home, ".claude-science");
}

function claudeScienceDbsUnderRoot(root) {
  const out = [];
  if (!root) return out;
  for (const name of CLAUDE_SCIENCE_DB_FILENAMES) {
    const candidate = path.join(root, name);
    if (fssync.existsSync(candidate)) out.push(candidate);
  }
  // Multi-org installs keep one DB per org under orgs/<slug>/.
  const orgsDir = path.join(root, "orgs");
  let orgs = [];
  try {
    orgs = fssync.readdirSync(orgsDir, { withFileTypes: true });
  } catch (_e) {
    orgs = [];
  }
  for (const org of orgs) {
    if (!org.isDirectory()) continue;
    for (const name of CLAUDE_SCIENCE_DB_FILENAMES) {
      const candidate = path.join(orgsDir, org.name, name);
      if (fssync.existsSync(candidate)) out.push(candidate);
    }
  }
  return out;
}

// Every Claude Science DB on this machine. There is no native Windows build —
// Windows users run the app inside WSL, so on win32 the distro home is probed
// too (same pattern as the other WSL-aware providers). Returns [] when nothing
// is installed.
function resolveClaudeScienceDbPaths({ home = os.homedir(), env = process.env, deps = {} } = {}) {
  const explicit =
    typeof env.CLAUDE_SCIENCE_DB_PATH === "string" && env.CLAUDE_SCIENCE_DB_PATH.trim()
      ? path.resolve(env.CLAUDE_SCIENCE_DB_PATH.trim())
      : null;
  if (explicit) return fssync.existsSync(explicit) ? [explicit] : [];

  const roots = [resolveClaudeScienceRoot({ home, env })];
  const platform = deps.platform || process.platform;
  if (platform === "win32" && !env.CLAUDE_SCIENCE_HOME) {
    const discoverWslHome = deps.discoverWslHome || wsl.discoverWslHome;
    const wslRoot = wsl.shouldProbeWsl(env)
      ? discoverWslHome(".claude-science", { ...deps, env })
      : null;
    if (wslRoot) roots.push(wslRoot);
  }

  const seen = new Set();
  const out = [];
  for (const root of roots) {
    for (const dbPath of claudeScienceDbsUnderRoot(root)) {
      if (seen.has(dbPath)) continue;
      seen.add(dbPath);
      out.push(dbPath);
    }
  }
  return out;
}

// Kept for the default single-install path (and its existing callers/tests):
// the conventional location, whether or not it exists yet.
function resolveClaudeScienceDbPath({ home = os.homedir(), env = process.env } = {}) {
  const explicit =
    typeof env.CLAUDE_SCIENCE_DB_PATH === "string" && env.CLAUDE_SCIENCE_DB_PATH.trim()
      ? env.CLAUDE_SCIENCE_DB_PATH.trim()
      : null;
  if (explicit) return path.resolve(explicit);
  return path.join(resolveClaudeScienceRoot({ home, env }), "operon-cli.db");
}

async function readClaudeScienceFrames(dbPath, sqliteOptions = {}) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const options = { label: "Claude Science", readOnly: true, ...sqliteOptions };

  // On Windows the DB lives inside WSL and is read over a \\wsl.localhost\ UNC
  // path. operon-cli.db runs in WAL mode (its -wal/-shm sidecars must be read
  // consistently with the main file), and SQLite over the 9p/UNC bridge can
  // fail to open the WAL or read a torn state. Snapshot to a local temp copy
  // first — same guard every other WSL-aware provider uses — and run BOTH the
  // PRAGMA probe and the frames read against that one consistent copy.
  let snapshot = null;
  let effectiveDbPath = dbPath;
  if (isUncPath(dbPath)) {
    try {
      snapshot = snapshotSqliteDb(dbPath);
      effectiveDbPath = snapshot.path;
    } catch (_e) {
      // Snapshot failed (permissions, transient I/O) — fall through to a direct
      // read so the non-UNC case never regresses.
    }
  }

  try {
    const pragmaRows = await readSqliteJsonRowsAsync(
      effectiveDbPath,
      "PRAGMA table_info(frames)",
      options,
    );
    const columnNames = pragmaRows.map((row) => row?.name).filter(Boolean);
    // No `frames` table at all (wrong DB / pre-frames build) — not an error.
    if (columnNames.length === 0) return [];
    return await readSqliteJsonRowsAsync(
      effectiveDbPath,
      buildClaudeScienceFramesQuery(columnNames),
      options,
    );
  } finally {
    if (snapshot) snapshot.cleanup();
  }
}

// `input` here is cache-inclusive (see the header note), so peel the cache
// columns back off to recover pure non-cached input. Main and aux counters are
// clamped independently — mixing them before the subtraction would let one
// group's cache mask the other's shortfall.
function claudeScienceUncachedInput(input, cacheRead, cacheWrite) {
  return Math.max(0, toNonNegativeInt(input) - toNonNegativeInt(cacheRead) - toNonNegativeInt(cacheWrite));
}

function normalizeClaudeScienceTokens(row) {
  const uncachedInput =
    claudeScienceUncachedInput(row?.input_tokens, row?.cache_read_tokens, row?.cache_write_tokens) +
    claudeScienceUncachedInput(
      row?.aux_input_tokens,
      row?.aux_cache_read_tokens,
      row?.aux_cache_write_tokens,
    );
  const output = toNonNegativeInt(row?.output_tokens) + toNonNegativeInt(row?.aux_output_tokens);
  const cacheRead =
    toNonNegativeInt(row?.cache_read_tokens) + toNonNegativeInt(row?.aux_cache_read_tokens);
  const cacheWrite =
    toNonNegativeInt(row?.cache_write_tokens) + toNonNegativeInt(row?.aux_cache_write_tokens);
  const total = uncachedInput + output + cacheRead + cacheWrite;
  if (total <= 0) return null;
  return {
    input_tokens: uncachedInput,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: total,
    billable_total_tokens: total,
  };
}

function claudeScienceFrameTimestampMs(row) {
  return (
    coerceEpochMs(row?.completed_at) ||
    coerceEpochMs(row?.updated_at) ||
    coerceEpochMs(row?.created_at) ||
    // Tolerate ISO-8601 text timestamps in case a build stores them as strings.
    parseIsoTimestampMs(row?.completed_at) ||
    parseIsoTimestampMs(row?.updated_at) ||
    parseIsoTimestampMs(row?.created_at)
  );
}

function parseIsoTimestampMs(value) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// Idempotent, subtract-on-change aggregation keyed by frame id (mirrors the
// Qoder DB parser): frames are re-read in full on every sync, and a frame whose
// counters grew between syncs has its previous contribution removed from its old
// bucket before the new totals are added, so repeated syncs never inflate.
async function parseClaudeScienceIncremental({
  dbRows,
  cursors,
  queuePath,
  onProgress,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const rows = Array.isArray(dbRows) ? dbRows : [];
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const state = normalizeQoderState(cursors?.claudeScience);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const frameId = normalizeMessageKeyPart(row?.id == null ? "" : String(row.id));
    const base = normalizeClaudeScienceTokens(row);
    const timestampMs = claudeScienceFrameTimestampMs(row);
    const bucketStart = timestampMs
      ? toUtcHalfHourStart(new Date(timestampMs).toISOString())
      : null;
    if (!frameId || !base || !bucketStart) {
      recordsProcessed += 1;
      continue;
    }

    // A root frame (no parent) is one user-facing conversation; nested child
    // frames are sub-agent turns of the same conversation and must not inflate
    // the conversation count.
    const isRoot = !normalizeMessageKeyPart(
      row?.parent_frame_id == null ? "" : String(row.parent_frame_id),
    );
    const currentTotals = { ...base, conversation_count: isRoot ? 1 : 0 };
    const model = normalizeModelInput(row?.model) || "claude-science";

    const previous = state.messages[frameId];
    const previousTotals =
      previous?.totals && typeof previous.totals === "object" ? previous.totals : null;
    const unchanged =
      previousTotals &&
      totalsKey(previousTotals) === totalsKey(currentTotals) &&
      previous.bucketStart === bucketStart &&
      previous.model === model;

    if (!unchanged) {
      if (previousTotals && previous.bucketStart && previous.model) {
        const oldBucket = getHourlyBucket(
          hourlyState,
          "claude-science",
          previous.model,
          previous.bucketStart,
        );
        subtractTotals(oldBucket.totals, previousTotals);
        touchedBuckets.add(bucketKey("claude-science", previous.model, previous.bucketStart));
      }
      const bucket = getHourlyBucket(hourlyState, "claude-science", model, bucketStart);
      addTotals(bucket.totals, currentTotals);
      touchedBuckets.add(bucketKey("claude-science", model, bucketStart));
      state.messages[frameId] = {
        totals: currentTotals,
        bucketStart,
        model,
        updatedAt: new Date().toISOString(),
      };
      eventsAggregated += 1;
    }

    recordsProcessed += 1;
    if (cb) {
      cb({
        index: index + 1,
        total: rows.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  state.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.claudeScience = state;
  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// Resolve project context from DB message (no file path available)
async function resolveProjectContextForDb({
  msg,
  dbPath,
  projectMetaCache,
  publicRepoCache,
  publicRepoResolver,
  projectState,
}) {
  const cwd = msg?.path?.cwd;
  if (!cwd || typeof cwd !== "string") return null;
  return resolveProjectContextForPath({
    // The DB itself is read over the distro's UNC bridge on Windows, so its
    // path carries the prefix the recorded POSIX cwd needs (#374).
    startDir: wsl.mapWslCwdToUnc(cwd, dbPath),
    projectMetaCache,
    publicRepoCache,
    publicRepoResolver,
    projectState,
  });
}

// ── Cursor (API-based) ──

/**
 * Incremental parser for Cursor usage data fetched via API.
 *
 * Unlike other parsers that read local files, this one receives pre-parsed
 * CSV records from cursor-config.js and aggregates them into 30-min buckets.
 *
 * Incremental state is tracked in `cursors.cursorApi.lastRecordTimestamp`.
 */
async function parseCursorApiIncremental({
  records,
  cursors,
  queuePath,
  onProgress,
  source,
}) {
  await ensureDir(path.dirname(queuePath));
  const defaultSource = normalizeSourceInput(source) || "cursor";
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();

  // Cursor's CSV is an account-level API export, not an append-only local log.
  // Treat the fetched CSV as authoritative so historical backfills and row
  // corrections replace prior local bucket totals instead of being skipped.
  const lastTs = cursors?.cursorApi?.lastRecordTimestamp || null;
  let latestTs = lastTs;
  let eventsAggregated = 0;
  const cb = typeof onProgress === "function" ? onProgress : null;
  const total = records.length;

  if (records.length > 0) {
    // Guard (2026-06 audit): only wipe buckets the fetched export can
    // actually rebuild. The wipe-then-refill design assumes the CSV is a
    // FULL-history export; if Cursor ever windows or truncates the export,
    // unconditionally zeroing every bucket would erase (and upload zeros
    // over) all history older than the response. Wiping from the earliest
    // record onward is identical for full exports and fail-safe for
    // partial ones.
    let earliestBucketStart = null;
    for (const record of records) {
      if (!record?.date) continue;
      const b = toUtcHalfHourStart(record.date);
      if (b && (!earliestBucketStart || b < earliestBucketStart)) earliestBucketStart = b;
    }
    // No parseable record date at all means the export is malformed —
    // refilling would add nothing, so wiping would zero out (and upload
    // zeros over) the entire history. Skip the wipe entirely.
    if (earliestBucketStart) {
      for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
        const parsed = parseBucketKey(key);
        const sourceKey = normalizeSourceInput(parsed.source) || DEFAULT_SOURCE;
        if (sourceKey !== defaultSource) continue;
        if (!bucket?.totals) continue;
        if (parsed.hourStart && parsed.hourStart < earliestBucketStart) continue;
        bucket.totals = initTotals();
        touchedBuckets.add(key);
      }
    }
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const recordDate = record.date;
    if (!recordDate) continue;

    const { normalizeCursorUsage } = require("./cursor-config");
    const delta = normalizeCursorUsage(record);
    if (isAllZeroUsage(delta)) continue;

    delta.conversation_count = 1;

    const bucketStart = toUtcHalfHourStart(recordDate);
    if (!bucketStart) continue;

    const model = normalizeModelInput(record.model) || DEFAULT_MODEL;
    const bucket = getHourlyBucket(hourlyState, defaultSource, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(defaultSource, model, bucketStart));

    eventsAggregated += 1;

    // Track latest timestamp
    if (!latestTs || recordDate > latestTs) {
      latestTs = recordDate;
    }

    if (cb && (i % 200 === 0 || i === records.length - 1)) {
      cb({
        index: i + 1,
        total,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;

  // Update cursor state
  if (!cursors.cursorApi) cursors.cursorApi = {};
  if (latestTs && latestTs !== lastTs) {
    cursors.cursorApi.lastRecordTimestamp = latestTs;
  }
  cursors.cursorApi.updatedAt = new Date().toISOString();

  return { recordsProcessed: total, eventsAggregated, bucketsQueued };
}

// ---------------------------------------------------------------------------
// Kiro token tracking (reads from devdata.sqlite or tokens_generated.jsonl)
// ---------------------------------------------------------------------------

// Kiro IDE (VS Code fork) globalStorage lives under the editor config root,
// which differs per platform: %APPDATA% on Windows, ~/.config on Linux/WSL,
// ~/Library/Application Support on macOS.
function resolveKiroBasePath(env = process.env) {
  const home = require("node:os").homedir();
  const suffix = ["Kiro", "User", "globalStorage", "kiro.kiroagent"];
  if (process.platform === "win32") {
    const appData = typeof env.APPDATA === "string" && env.APPDATA.trim().length > 0
      ? env.APPDATA.trim()
      : path.join(home, "AppData", "Roaming");
    return path.join(appData, ...suffix);
  }
  if (process.platform === "linux") {
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim().length > 0
      ? env.XDG_CONFIG_HOME.trim()
      : path.join(home, ".config");
    return path.join(configHome, ...suffix);
  }
  return path.join(home, "Library", "Application Support", ...suffix);
}

function resolveKiroDbPath(basePath) {
  return path.join(basePath || resolveKiroBasePath(), "dev_data", "devdata.sqlite");
}

function resolveKiroJsonlPath(basePath) {
  return path.join(basePath || resolveKiroBasePath(), "dev_data", "tokens_generated.jsonl");
}

function readKiroDbTokens(dbPath, sinceId, sqliteOptions = {}) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const minId = Number.isFinite(sinceId) && sinceId > 0 ? sinceId : 0;
  const sql = `SELECT id, model, provider, tokens_prompt, tokens_generated, timestamp FROM tokens_generated WHERE id > ${minId} ORDER BY id ASC`;

  // WSL installs are read over the \\wsl$ UNC bridge; sqlite3 cannot safely
  // open WAL databases there, so copy db (+ sidecars) to tmp first.
  let snapshot = null;
  let effectiveDbPath = dbPath;
  if (isUncPath(dbPath)) {
    try {
      snapshot = snapshotSqliteDb(dbPath);
      effectiveDbPath = snapshot.path;
    } catch (_e) { }
  }
  try {
    return readSqliteJsonRows(effectiveDbPath, sql, {
      label: "Kiro",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
      ...sqliteOptions,
    });
  } finally {
    if (snapshot) snapshot.cleanup();
  }
}

// Read Kiro token data from JSONL fallback (tokens_generated.jsonl).
// Each line: {"model":"agent","provider":"kiro","promptTokens":N,"generatedTokens":N}
// The fallback file does not include per-row timestamps, so newly appended rows are
// bucketed using the file mtime observed during this sync. We track a separate JSONL
// cursor so it never shares state with the SQLite path.
function countKiroJsonlLines(jsonlPath) {
  if (!jsonlPath || !fssync.existsSync(jsonlPath)) return 0;
  try {
    const raw = fssync.readFileSync(jsonlPath, "utf8");
    return raw.split("\n").filter((l) => l.trim()).length;
  } catch (_e) {
    return 0;
  }
}

function readKiroJsonlTokens(jsonlPath, sinceLineIndex) {
  if (!jsonlPath || !fssync.existsSync(jsonlPath)) {
    return { rows: [], lineCount: 0, reset: false };
  }
  const startLine = Number.isFinite(sinceLineIndex) && sinceLineIndex > 0 ? sinceLineIndex : 0;
  let raw;
  try {
    raw = fssync.readFileSync(jsonlPath, "utf8");
  } catch (_e) {
    return { rows: [], lineCount: 0, reset: false };
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const lineCount = lines.length;
  if (startLine > lineCount) {
    return { rows: [], lineCount, reset: true };
  }
  let mtime;
  try {
    mtime = fssync.statSync(jsonlPath).mtime.toISOString();
  } catch (_e) {
    mtime = new Date().toISOString();
  }
  const timestamp = mtime.replace("T", " ").replace("Z", "").slice(0, 19);
  const rows = [];
  for (let i = startLine; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      rows.push({
        id: i + 1,
        model: obj.model || "agent",
        provider: obj.provider || "kiro",
        tokens_prompt: obj.promptTokens || 0,
        tokens_generated: obj.generatedTokens || 0,
        timestamp,
      });
    } catch (_e) {
      // skip malformed lines
    }
  }
  return { rows, lineCount, reset: false };
}

// Build a sorted timeline of model usage from Kiro .chat metadata files
function buildKiroModelTimeline(basePath) {
  const timeline = []; // [{ startMs, endMs, model }]
  if (!basePath || !fssync.existsSync(basePath)) return timeline;
  let dirs;
  try {
    dirs = fssync.readdirSync(basePath, { withFileTypes: true });
  } catch (_e) {
    return timeline;
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(basePath, entry.name);
    let files;
    try {
      files = fssync.readdirSync(dirPath).filter((f) => f.endsWith(".chat"));
    } catch (_e) {
      continue;
    }
    for (const file of files) {
      try {
        const raw = fssync.readFileSync(path.join(dirPath, file), "utf8");
        const data = JSON.parse(raw);
        const meta = data?.metadata;
        if (!meta?.modelId || !meta?.startTime) continue;
        timeline.push({
          startMs: meta.startTime,
          endMs: meta.endTime || meta.startTime,
          model: String(meta.modelId),
        });
      } catch (_e) {}
    }
  }
  timeline.sort((a, b) => a.startMs - b.startMs);
  return timeline;
}

// Find the model for a given UTC timestamp string using the .chat timeline
function resolveKiroModel(timeline, utcTimestamp) {
  if (!timeline.length || !utcTimestamp) return null;
  const ts = new Date(utcTimestamp).getTime();
  if (!Number.isFinite(ts)) return null;

  // Binary search for the closest .chat entry
  let lo = 0;
  let hi = timeline.length - 1;
  let best = null;
  let bestDist = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = timeline[mid];
    // Check if timestamp falls within the .chat execution window
    if (ts >= entry.startMs && ts <= entry.endMs) return entry.model;
    const dist = Math.min(Math.abs(ts - entry.startMs), Math.abs(ts - entry.endMs));
    if (dist < bestDist) {
      bestDist = dist;
      best = entry.model;
    }
    if (ts < entry.startMs) hi = mid - 1;
    else lo = mid + 1;
  }
  // Only match if within 10 minutes
  return bestDist < 10 * 60 * 1000 ? best : null;
}

// Normalize Kiro internal model IDs to readable names
// e.g. "CLAUDE_SONNET_4_20250514_V1_0" → "claude-sonnet-4"
function normalizeKiroModelName(raw) {
  if (!raw || typeof raw !== "string") return null;
  let name = raw.trim();
  if (!name) return null;
  // Already lowercase with dashes (e.g. "claude-opus-4.5") → keep as-is
  if (name === name.toLowerCase() && name.includes("-")) return name;
  // UPPER_SNAKE_CASE internal names: strip date/version suffixes, convert to lowercase-dash
  name = name
    .replace(/_\d{8}_V\d+_\d+$/i, "") // remove _20250514_V1_0
    .replace(/_V\d+$/i, "") // remove _V1
    .toLowerCase()
    .replace(/_/g, "-");
  return name || null;
}

async function parseKiroIncremental({ basePath, dbPath, jsonlPath, cursors, queuePath, onProgress, sqliteOptions } = {}) {
  await ensureDir(path.dirname(queuePath));
  const kiroState = cursors.kiro && typeof cursors.kiro === "object" ? cursors.kiro : {};
  const lastDbId = typeof kiroState.lastDbId === "number"
    ? kiroState.lastDbId
    : (typeof kiroState.lastId === "number" ? kiroState.lastId : 0);
  const jsonlState = kiroState.jsonl && typeof kiroState.jsonl === "object" ? kiroState.jsonl : {};
  const lastJsonlLine = typeof jsonlState.lastLine === "number" ? jsonlState.lastLine : 0;

  const resolvedDbPath = dbPath || resolveKiroDbPath(basePath);
  const resolvedJsonlPath = jsonlPath || resolveKiroJsonlPath(basePath);

  // Try SQLite first, fall back to JSONL.
  let rows = [];
  let nextDbId = lastDbId;
  let nextJsonlLine = lastJsonlLine;
  let usingDb = false;
  if (fssync.existsSync(resolvedDbPath)) {
    rows = readKiroDbTokens(resolvedDbPath, lastDbId, sqliteOptions);
    usingDb = true;
    // DB and JSONL are siblings for the same usage events. If the DB ever
    // disappears (corrupted / wiped) and we fall back to JSONL in a later
    // run, we must not re-read lines that the DB path already consumed.
    // Advance the JSONL line cursor to the current file tail.
    if (fssync.existsSync(resolvedJsonlPath)) {
      const tailLineCount = countKiroJsonlLines(resolvedJsonlPath);
      if (tailLineCount > nextJsonlLine) nextJsonlLine = tailLineCount;
    }
  } else if (fssync.existsSync(resolvedJsonlPath)) {
    const jsonlResult = readKiroJsonlTokens(resolvedJsonlPath, lastJsonlLine);
    rows = jsonlResult.rows;
    nextJsonlLine = jsonlResult.lineCount;
    if (jsonlResult.reset) {
      cursors.kiro = {
        ...kiroState,
        lastDbId,
        jsonl: { lastLine: jsonlResult.lineCount, updatedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      };
      return {
        recordsProcessed: 0,
        eventsAggregated: 0,
        bucketsQueued: 0,
      };
    }
  } else {
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }
  if (rows.length === 0) {
    cursors.kiro = {
      ...kiroState,
      lastDbId,
      jsonl: { lastLine: nextJsonlLine, updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  // Build model timeline from .chat files for model name resolution.
  // Must come from the SAME install as the rows being parsed (dual-install:
  // a WSL install's rows must not be resolved against native .chat files).
  const timelineBase = basePath
    || (dbPath ? path.dirname(path.dirname(dbPath)) : resolveKiroBasePath());
  const modelTimeline = buildKiroModelTimeline(timelineBase);

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let eventsAggregated = 0;
  let maxId = lastDbId;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const inputTokens = toNonNegativeInt(row.tokens_prompt);
    const outputTokens = toNonNegativeInt(row.tokens_generated);
    if (inputTokens === 0 && outputTokens === 0) continue;

    // timestamp format: "2026-01-09 15:25:30" (UTC from SQLite DEFAULT CURRENT_TIMESTAMP)
    const ts = row.timestamp ? row.timestamp.replace(" ", "T") + "Z" : null;
    const bucketStart = ts ? toUtcHalfHourStart(ts) : null;
    if (!bucketStart) continue;

    // Resolve actual model from .chat timeline, fallback to "kiro-agent"
    const resolvedModel = resolveKiroModel(modelTimeline, ts);
    const model = normalizeKiroModelName(resolvedModel) || "kiro-agent";

    const delta = {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_output_tokens: 0,
      total_tokens: inputTokens + outputTokens,
      conversation_count: 1,
    };

    const bucket = getHourlyBucket(hourlyState, "kiro", model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey("kiro", model, bucketStart));
    eventsAggregated++;

    if (usingDb && row.id && row.id > maxId) maxId = row.id;

    if (cb) {
      cb({
        index: i + 1,
        total: rows.length,
        recordsProcessed: i + 1,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kiro = {
    ...kiroState,
    lastId: maxId,
    lastDbId: maxId,
    jsonl: { lastLine: nextJsonlLine, updatedAt },
    updatedAt,
  };

  return { recordsProcessed: rows.length, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hermes Agent — SQLite-based (sessions table in ~/.hermes/state.db)
// ─────────────────────────────────────────────────────────────────────────────

function resolveHermesPath(env = process.env, deps = {}) {
  const override = env.TOKENTRACKER_HERMES_HOME;
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  const home = require("node:os").homedir();
  const defaultPath = path.join(home, ".hermes");
  if (process.platform === "win32") {
    const localAppData = typeof env.LOCALAPPDATA === "string" ? env.LOCALAPPDATA.trim() : "";
    const nativeValue = localAppData.length > 0 ? path.join(localAppData, "hermes") : null;
    const paths = resolveInstallPaths({ nativeValue, wslDir: ".hermes" }, env, deps);
    const picked = paths.native || paths.wsl;
    if (picked) return picked;
    const mode = wsl.getWslMode(env);
    if (mode === "wsl-only" || mode === "native-only") return null;
  }
  return defaultPath;
}

// ── WSL auto-discovery (Windows host, tools inside a distro) ──────────────────
// `wsl.exe -l -v` prints UTF-16LE; the per-distro `whoami` runs a Linux process
// so its stdout is UTF-8. We capture buffers and decode per-call.
function defaultRunWsl(args, { utf16 = false } = {}) {
  return wsl.defaultRunWsl(args, { utf16 });
}

// Parse `wsl.exe -l -v` output into [{ name, version, isDefault }]. The default
// distro is prefixed with `*`; the VERSION column (1 or 2) decides which UNC
// alias to try first (simonlpaige, #87).
function parseWslListVerbose(raw) {
  return wsl.parseWslListVerbose(raw);
}

// Default distro first, then listed order — matches what a user expects when
// they have one primary distro plus extras.
function probeWslDistros(deps = {}) {
  return wsl.probeWslDistros(deps);
}

// Probe each WSL distro for ~/.hermes via UNC. The Linux username rarely equals
// %USERNAME%, so we ask the distro directly with `whoami` rather than guessing
// (simonlpaige, #87).
function discoverWslHermesHome(deps = {}) {
  return wsl.discoverWslHome(".hermes", deps);
}

function pickWin32ProviderPath({ env = process.env, nativeValue, wslProviderDir, wslValue, deps = {} }) {
  const paths = resolveInstallPaths({ nativeValue, wslDir: wslProviderDir, wslValue }, env, deps);
  return paths.native || paths.wsl;
}

function resolveAllWin32ProviderPaths({ env = process.env, nativeValue, wslProviderDir, wslValue, deps = {} }) {
  return resolveInstallPaths({ nativeValue, wslDir: wslProviderDir, wslValue }, env, deps);
}

function resolveHermesDbPath(env = process.env) {
  const hermesPath = resolveHermesPath(env);
  return hermesPath ? path.join(hermesPath, "state.db") : null;
}

function resolveAllHermesDBPaths({ hermesPath, dbPath } = {}) {
  const hermesDir = hermesPath ?? (dbPath ? path.dirname(dbPath) : resolveHermesPath());
  if (!hermesDir) return { default: null, profiles: {} };
  const defaultDbPath = dbPath ?? path.join(hermesDir, "state.db");
  const profilePaths = {};
  try {
    const profilesDir = path.join(hermesDir, "profiles");
    const profiles = fssync.readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of profiles) {
      const dbPath = path.join(profilesDir, entry.name, "state.db");
      if (fssync.existsSync(dbPath)) {
        profilePaths[entry.name] = dbPath;
      }
    }
  } catch (_e) { }

  return {
    default: fssync.existsSync(defaultDbPath) ? defaultDbPath : null,
    profiles: profilePaths,
  }
}

function sqliteStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// UNC paths (\\wsl$\Ubuntu\..., \\wsl.localhost\..., \\server\share\...) make
// sqlite3.exe fail with "database is locked (5)" on Windows because the Plan 9
// / SMB bridge can't grant the locks SQLite asks for — even after `wsl
// --shutdown`. Detect those paths so we can snapshot the DB locally first.
function isUncPath(p) {
  return wsl.isUncPath(p);
}

function snapshotSqliteDb(dbPath) {
  return wsl.snapshotSqliteDb(dbPath);
}

function readHermesSessions(dbPath, lastCompletedEpoch, unfinishedSessionIds = [], sqliteOptions = {}) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const since = Number.isFinite(lastCompletedEpoch) && lastCompletedEpoch > 0 ? lastCompletedEpoch : 0;
  const forceIds = Array.isArray(unfinishedSessionIds)
    ? [...new Set(unfinishedSessionIds.filter((id) => typeof id === "string" && id.length > 0))]
    : [];
  const forceIncludeSql = forceIds.length > 0
    ? ` OR id IN (${forceIds.map(sqliteStringLiteral).join(",")})`
    : "";
  // Fetch sessions that started at/after the cursor, sessions that are still
  // in-progress (ended_at IS NULL), OR sessions that were previously observed
  // unfinished.  Hermes updates token counts in real-time, including a final
  // delta when an active session later gets ended_at set.
  const sql = `SELECT id, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, message_count FROM sessions WHERE (started_at >= ${since} OR ended_at IS NULL${forceIncludeSql}) AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_write_tokens > 0 OR reasoning_tokens > 0) ORDER BY started_at ASC`;

  let snapshot = null;
  let effectiveDbPath = dbPath;
  if (isUncPath(dbPath)) {
    try {
      snapshot = snapshotSqliteDb(dbPath);
      effectiveDbPath = snapshot.path;
    } catch (_e) {
      // Snapshot failed — fall through to a direct read so we don't regress
      // the non-locked case (e.g. permissions, transient I/O).
    }
  }

  try {
    return readSqliteJsonRows(effectiveDbPath, sql, {
      label: "Hermes",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
      ...sqliteOptions,
    });
  } finally {
    if (snapshot) snapshot.cleanup();
  }
}

// ── Dual-install cursor ownership probes ────────────────────────────────────
// When a flat (pre-namespaced) cursor migrates to per-install namespaces
// (multiInstallParse "both" mode), the migration must know which install the
// flat cursor was tracking: only then may the OTHER install's namespace start
// empty so its full history backfills. Guessing wrong wipes dedup state
// (snapshots / sessionTotals / threadTotals) for an already-counted install,
// and every re-read session lands in the hourly buckets a second time.
// These probes answer "does this install's DB contain the flat cursor's own
// ids?" — sampled from the cursor's per-session dedup maps. Any failure or
// missing evidence returns false so the caller falls back to seeding every
// namespace (bounded backfill loss, never a double count).

function sqliteDbContainsIds(dbPath, table, ids, sqliteOptions = {}) {
  if (!dbPath || !Array.isArray(ids) || ids.length === 0) return false;
  if (!fssync.existsSync(dbPath)) return false;
  const inList = ids.map(sqliteStringLiteral).join(",");
  const sql = `SELECT id FROM ${table} WHERE id IN (${inList}) LIMIT 1`;

  let snapshot = null;
  let effectiveDbPath = dbPath;
  if (isUncPath(dbPath)) {
    try {
      snapshot = snapshotSqliteDb(dbPath);
      effectiveDbPath = snapshot.path;
    } catch (_e) { }
  }
  try {
    const rows = readSqliteJsonRows(effectiveDbPath, sql, {
      label: "InstallProbe",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      ...sqliteOptions,
    });
    return Array.isArray(rows) && rows.length > 0;
  } catch (_e) {
    return false;
  } finally {
    if (snapshot) snapshot.cleanup();
  }
}

// Sample the most recently inserted keys — most likely to still exist in the
// DB (providers may delete old sessions, which would blind the probe).
function sampleRecentKeys(obj, limit = 16) {
  if (!obj || typeof obj !== "object") return [];
  const keys = Object.keys(obj).filter((k) => typeof k === "string" && k.length > 0);
  return keys.slice(-limit);
}

function gooseInstallOwnsCursor(dbPath, flatState, sqliteOptions) {
  return sqliteDbContainsIds(dbPath, "sessions", sampleRecentKeys(flatState?.sessionTotals), sqliteOptions);
}

function zedInstallOwnsCursor(dbPath, flatState, sqliteOptions) {
  return sqliteDbContainsIds(dbPath, "threads", sampleRecentKeys(flatState?.threadTotals), sqliteOptions);
}

function hermesInstallOwnsCursor(hermesPath, flatState, sqliteOptions) {
  const ids = new Set();
  const collect = (state) => {
    if (!state || typeof state !== "object") return;
    for (const key of sampleRecentKeys(state.snapshots)) ids.add(key);
    if (Array.isArray(state.unfinishedSessionIds)) {
      for (const id of state.unfinishedSessionIds) {
        if (typeof id === "string" && id.length > 0) ids.add(id);
      }
    }
  };
  collect(flatState);
  if (flatState?.profiles && typeof flatState.profiles === "object") {
    for (const profileState of Object.values(flatState.profiles)) collect(profileState);
  }
  const sample = [...ids].slice(-16);
  if (sample.length === 0) return false;

  const dbPaths = resolveAllHermesDBPaths({ hermesPath });
  const allDbs = [dbPaths.default, ...Object.values(dbPaths.profiles)].filter(Boolean);
  return allDbs.some((db) => sqliteDbContainsIds(db, "sessions", sample, sqliteOptions));
}

function kiroInstallOwnsCursor(dbPath, flatState, sqliteOptions) {
  // The flat cursor tracks the max AUTOINCREMENT id it consumed. An install
  // whose tokens_generated table never reached that id cannot be the flat
  // cursor's host. Both installs containing the id (short/equal histories)
  // yields two hits upstream → caller seeds every namespace (safe).
  const lastDbId = typeof flatState?.lastDbId === "number" && Number.isInteger(flatState.lastDbId) && flatState.lastDbId > 0
    ? flatState.lastDbId
    : (typeof flatState?.lastId === "number" && Number.isInteger(flatState.lastId) && flatState.lastId > 0
      ? flatState.lastId
      : 0);
  if (!lastDbId) return false;
  return sqliteDbContainsIds(dbPath, "tokens_generated", [String(lastDbId)], sqliteOptions);
}

// Kiro CLI request_ids live inside the conversations_v2 JSON payload, not in
// an id column — probe via json_each instead of sqliteDbContainsIds.
function kiroCliDbContainsRequestIds(dbPath, requestIds, sqliteOptions = {}) {
  if (!dbPath || !Array.isArray(requestIds) || requestIds.length === 0) return false;
  if (!fssync.existsSync(dbPath)) return false;
  const inList = requestIds.map(sqliteStringLiteral).join(",");
  // Alias both tables: conversations_v2.value and json_each's own `value`
  // column collide — a bare `value` is "ambiguous column name" and sqlite
  // errors out (which readSqliteJsonRows swallows into []).
  const sql =
    "SELECT 1 FROM conversations_v2 AS c, " +
    "json_each(json_extract(c.value, '$.user_turn_metadata.requests')) AS je " +
    `WHERE json_extract(je.value, '$.request_id') IN (${inList}) LIMIT 1`;

  let snapshot = null;
  let effectiveDbPath = dbPath;
  if (isUncPath(dbPath)) {
    try {
      snapshot = snapshotSqliteDb(dbPath);
      effectiveDbPath = snapshot.path;
    } catch (_e) { }
  }
  try {
    const rows = readSqliteJsonRows(effectiveDbPath, sql, {
      label: "InstallProbe",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      ...sqliteOptions,
    });
    return Array.isArray(rows) && rows.length > 0;
  } catch (_e) {
    return false;
  } finally {
    if (snapshot) snapshot.cleanup();
  }
}

function kiroCliInstallOwnsCursor(dbPath, flatState, sqliteOptions) {
  // Only SQLite-origin request_id UUIDs are probe evidence: session-file
  // entries synthesize `${sessionId}:${loopRand}` keys or carry a session_id
  // tag, and neither appears in conversations_v2. Filter BEFORE sampling so
  // recent session-file churn cannot blind the probe to older SQLite ids.
  const requests =
    flatState?.requests && typeof flatState.requests === "object" ? flatState.requests : {};
  const sqliteKeyed = {};
  for (const [k, v] of Object.entries(requests)) {
    if (k.includes(":")) continue;
    if (v && typeof v === "object" && typeof v.session_id === "string" && v.session_id) continue;
    sqliteKeyed[k] = v;
  }
  const sample = sampleRecentKeys(sqliteKeyed);
  return kiroCliDbContainsRequestIds(dbPath, sample, sqliteOptions);
}

function hasLegacyHermesDefaultState(hermesState) {
  return (
    typeof hermesState.lastStartedAt === "number" ||
    typeof hermesState.lastCompletedStartedAt === "number" ||
    (hermesState.snapshots && typeof hermesState.snapshots === "object")
  );
}

async function parseHermesIncremental({ hermesPath, dbPath, cursors, queuePath, onProgress, sqliteOptions } = {}) {
  await ensureDir(path.dirname(queuePath));
  const hermesState = cursors.hermes && typeof cursors.hermes === "object" ? cursors.hermes : {};

  const dbPaths = resolveAllHermesDBPaths({ hermesPath, dbPath });
  if (dbPaths.default === null && Object.keys(dbPaths.profiles).length === 0) {
    // No state in any profile
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const cb = typeof onProgress === "function" ? onProgress : null;
  const updatedAt = new Date().toISOString();
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  const touchedBuckets = new Set();

  function ingestProfile(dbPath, dbState) {
    const trackedUnfinishedSessionIds = Array.isArray(dbState.unfinishedSessionIds)
      ? dbState.unfinishedSessionIds
      : [];
    const rows = readHermesSessions(
      dbPath,
      dbState.lastCompletedStartedAt,
      trackedUnfinishedSessionIds,
      sqliteOptions,
    );
    recordsProcessed += rows.length;
    if (rows.length === 0) {
      dbState.updatedAt = updatedAt;
      return;
    }

    // Per-session snapshot from the previous sync: { [sessionId]: { in, out, cacheRead, cacheWrite, reasoning } }
    const prevSnapshots = (dbState.snapshots && typeof dbState.snapshots === "object")
      ? dbState.snapshots : {};

    // Only advance past sessions that have fully ended.  Active sessions
    // (ended_at IS NULL) must be re-read every sync because Hermes updates
    // their token counts in real-time after each turn.
    const lastCompletedStartedAt =
      typeof dbState.lastCompletedStartedAt === "number" ? dbState.lastCompletedStartedAt : 0;

    let maxCompletedStartedAt = lastCompletedStartedAt;
    let oldestUnfinishedStartedAt = Infinity;
    const nextUnfinishedSessionIds = new Set();
    const nextSnapshots = {};

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const inputTokens = toNonNegativeInt(row.input_tokens);
      const outputTokens = toNonNegativeInt(row.output_tokens);
      const cacheRead = toNonNegativeInt(row.cache_read_tokens);
      const cacheWrite = toNonNegativeInt(row.cache_write_tokens);
      const reasoning = toNonNegativeInt(row.reasoning_tokens);
      const messageCount = toNonNegativeInt(row.message_count);
      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheRead === 0 &&
        cacheWrite === 0 &&
        reasoning === 0
      ) continue;

      // Save current snapshot for next sync
      nextSnapshots[row.id] = { in: inputTokens, out: outputTokens, cacheRead, cacheWrite, reasoning, message_count: messageCount };

      const startedAt = Number(row.started_at);
      const endedAt = row.ended_at == null ? null : Number(row.ended_at);
      if (endedAt == null) {
        if (row.id && Number.isFinite(startedAt)) {
          nextUnfinishedSessionIds.add(row.id);
          oldestUnfinishedStartedAt = Math.min(oldestUnfinishedStartedAt, startedAt);
        }
      } else if (Number.isFinite(startedAt) && startedAt > maxCompletedStartedAt) {
        maxCompletedStartedAt = startedAt;
      }

      // Compute delta from previous snapshot (if any) so that we only count
      // new usage since the last sync.  First time we see a session the
      // previous snapshot is absent, so the full amount is the delta.
      const prev = prevSnapshots[row.id];
      let dInput = inputTokens;
      let dOutput = outputTokens;
      let dCacheRead = cacheRead;
      let dCacheWrite = cacheWrite;
      let dReasoning = reasoning;
      let dMessageCount = messageCount;
      if (prev) {
        dInput = Math.max(0, inputTokens - (prev.in || 0));
        dOutput = Math.max(0, outputTokens - (prev.out || 0));
        dCacheRead = Math.max(0, cacheRead - (prev.cacheRead || 0));
        dCacheWrite = Math.max(0, cacheWrite - (prev.cacheWrite || 0));
        dReasoning = Math.max(0, reasoning - (prev.reasoning || 0));
        dMessageCount = Math.max(0, messageCount - (prev.message_count || 0));
      }
      // Skip if delta is zero (session unchanged since last sync)
      if (dInput === 0 && dOutput === 0 && dCacheRead === 0 && dCacheWrite === 0 && dReasoning === 0) continue;

      // Prefer ended_at for bucket placement; fall back to started_at
      const epochSec = endedAt ?? startedAt;
      if (!epochSec || !Number.isFinite(epochSec)) continue;
      const tsIso = new Date(epochSec * 1000).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const model = normalizeModelInput(row.model) || "hermes-agent";

      const delta = {
        input_tokens: dInput,
        cached_input_tokens: dCacheRead,
        cache_creation_input_tokens: dCacheWrite,
        output_tokens: dOutput,
        reasoning_output_tokens: dReasoning,
        total_tokens: dInput + dOutput + dCacheRead + dCacheWrite + dReasoning,
        conversation_count: dMessageCount,
      };

      const bucket = getHourlyBucket(hourlyState, "hermes", model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("hermes", model, bucketStart));
      eventsAggregated++;

      if (cb) {
        cb({
          index: i + 1,
          total: rows.length,
          recordsProcessed: i + 1,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    const nextLastCompletedStartedAt = Number.isFinite(oldestUnfinishedStartedAt)
      ? Math.min(maxCompletedStartedAt, oldestUnfinishedStartedAt)
      : maxCompletedStartedAt;

    Object.assign(dbState, {
      lastStartedAt: nextLastCompletedStartedAt,
      lastCompletedStartedAt: nextLastCompletedStartedAt,
      unfinishedSessionIds: Array.from(nextUnfinishedSessionIds),
      snapshots: nextSnapshots,
      updatedAt,
    });
  }

  if (dbPaths.default) {
    ingestProfile(dbPaths.default, hermesState);
  }

  hermesState.profiles = hermesState.profiles && typeof hermesState.profiles === "object" ? hermesState.profiles : {};

  for (const [profileName, dbPath] of Object.entries(dbPaths.profiles)) {
    const profileState = hermesState.profiles[profileName] && typeof hermesState.profiles[profileName] === "object"
      ? hermesState.profiles[profileName]
      : {};
    hermesState.profiles[profileName] = profileState;
    ingestProfile(dbPath, profileState);
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.hermes = {
    ...hermesState,
    updatedAt, // Update the overall profile state timestamp even if the DB doesn't exist for the fast-path check
  };

  return {
    recordsProcessed,
    eventsAggregated,
    bucketsQueued,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kimi — passive JSONL reader (~/.kimi/sessions/**/wire.jsonl)
// No hook installation needed; Kimi writes wire.jsonl automatically.

function resolveKimiDefaultModel(env = process.env) {
  const fallback = "kimi-for-coding";
  try {
    const home = env.HOME || require("node:os").homedir();
    const cfgPath = path.join(env.KIMI_HOME || path.join(home, ".kimi"), "config.toml");
    const raw = fssync.readFileSync(cfgPath, "utf8");
    const defaultMatch = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
    if (!defaultMatch) return fallback;
    const sectionKey = defaultMatch[1];
    const escaped = sectionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sectionRe = new RegExp(
      `\\[models\\."${escaped}"\\]([\\s\\S]*?)(?:\\n\\[|$)`,
    );
    const section = raw.match(sectionRe);
    if (section) {
      const modelMatch = section[1].match(/^\s*model\s*=\s*"([^"]+)"/m);
      if (modelMatch && modelMatch[1]) return modelMatch[1];
    }
    if (sectionKey.includes("/")) return sectionKey.split("/").pop();
    return sectionKey || fallback;
  } catch {
    return fallback;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Kiro CLI — reads historical conversation state from
// ~/Library/Application Support/kiro-cli/data.sqlite3 (table conversations_v2).
// Kiro CLI does NOT store explicit token counts locally. Each request row
// carries: user_prompt_length (chars), response_size (chars), model_id,
// request_start_timestamp_ms, message_id. We approximate tokens at 4 chars /
// token. Source is merged with Kiro IDE (source='kiro') and canonicalized
// model names are used so CLI and IDE rows collapse when they refer to the
// same underlying Bedrock model. Cursor state is per-request-id so mutable
// requests can be reprocessed (subtract-old/add-new on fingerprint change).
// ─────────────────────────────────────────────────────────────────────────────

const KIRO_CLI_CHARS_PER_TOKEN = 4;
const KIRO_CLI_CREDITS_SIDECAR = "kiro-credits.json";

function resolveKiroCliDbPath(env = process.env) {
  if (env.KIRO_CLI_DB_PATH) return env.KIRO_CLI_DB_PATH;
  const home = env.HOME || require("node:os").homedir();
  if (process.platform === "win32") {
    // Speculative: Kiro CLI descends from Amazon Q CLI, which ships
    // macOS/Linux only — Windows users run it inside WSL (handled by the
    // dual-install path in sync). Kept as the conventional %LOCALAPPDATA%
    // location so a future native build is picked up; harmless when absent.
    const localAppData = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim().length > 0
      ? env.LOCALAPPDATA.trim()
      : path.join(home, "AppData", "Local");
    return path.join(localAppData, "kiro-cli", "data.sqlite3");
  }
  if (process.platform === "linux") {
    const dataHome = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim().length > 0
      ? env.XDG_DATA_HOME.trim()
      : path.join(home, ".local", "share");
    return path.join(dataHome, "kiro-cli", "data.sqlite3");
  }
  return path.join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3");
}

// Bug-4: canonical UUID shape — 8-4-4-4-12 hex groups. The looser
// /^[0-9a-f-]{36}\.json$/ form accepted `36 hyphens`.json or 36 hex with
// no hyphens. kiro-cli writes proper UUIDs; lock to the canonical shape.
const KIRO_CLI_SESSION_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
// The directory prefix and direct messages.jsonl child are the stable
// contract. Do not assume the suffix will always remain a UUID: Kiro has
// already changed this layout once, and an opaque non-empty session id is
// sufficient to keep discovery both bounded and forward-compatible.
const KIRO_CLI_V2_SESSION_DIR_RE = /^sess_.+$/;

// Lists both Kiro CLI session layouts:
//   legacy: ~/.kiro/sessions/cli/{uuid}.json
//   2.13+:  ~/.kiro/sessions/{workspaceHash}/sess_{uuid}/messages.jsonl
//
// Legacy .json files are rewritten atomically per turn. The 2.13+ JSONL is
// append-only and may be read while a session is active. Only the direct
// messages.jsonl child is accepted; sub-executions and arbitrary nested JSONL
// files are intentionally excluded.
//
// TASK-014: env.HOME is honored (symmetric with resolveKiroCliDbPath) so
// callers can redirect to a tmp home for hermetic tests/CI.
function resolveKiroCliSessionFiles(env = process.env) {
  const home = env.HOME || require("node:os").homedir();
  const kiroHome = env.KIRO_HOME || path.join(home, ".kiro");
  const sessionsRoot = path.join(kiroHome, "sessions");
  if (!fssync.existsSync(sessionsRoot)) return [];
  const files = [];

  const legacyDir = path.join(sessionsRoot, "cli");
  try {
    for (const entry of fssync.readdirSync(legacyDir)) {
      // TASK-003: only canonical {uuid}.json files; backups, scratch,
      // typos are skipped so they don't feed JSON.parse garbage.
      if (!KIRO_CLI_SESSION_FILE_RE.test(entry)) continue;
      files.push(path.join(legacyDir, entry));
    }
  } catch {
    // ignore read errors
  }

  try {
    const workspaceDirs = fssync.readdirSync(sessionsRoot, {
      withFileTypes: true,
    });
    for (const workspace of workspaceDirs) {
      if (!workspace.isDirectory() || workspace.name === "cli") continue;
      const workspacePath = path.join(sessionsRoot, workspace.name);
      let sessionDirs;
      try {
        sessionDirs = fssync.readdirSync(workspacePath, {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const session of sessionDirs) {
        if (
          !session.isDirectory() ||
          !KIRO_CLI_V2_SESSION_DIR_RE.test(session.name)
        ) {
          continue;
        }
        const messagesPath = path.join(
          workspacePath,
          session.name,
          "messages.jsonl",
        );
        if (fssync.existsSync(messagesPath)) files.push(messagesPath);
      }
    }
  } catch {
    // ignore read errors
  }

  return files.sort();
}

// Build char-count maps from a .jsonl sibling file. Lets us approximate
// per-turn tokens when the live session's input_token_count /
// output_token_count fields are 0 (kiro-cli does not persist real token
// counts; billing is credit-based).
//
// Returns:
//   byMessage:       message_id -> assistant+toolUse char count
//   messageKind:     message_id -> jsonl event kind
//   turnPromptChars: turn_index -> input chars attributed to that turn
//
// Input attribution: Kiro CLI's turn.message_ids only records
// AssistantMessage / ToolResults ids, NEVER the user Prompt id. So the
// Prompt event is invisible if you look it up by message_id. To recover
// the per-turn user input, we walk the jsonl in timestamp order and buffer
// Prompt chars until the next AssistantMessage that belongs to a turn
// (turnMessageIds provides that mapping). The first such AssistantMessage
// "claims" the buffered Prompt chars for its turn, and the buffer resets.
// Later cycles within the same turn (Assistant → ToolResults → Assistant)
// do not re-attribute.
async function readKiroCliMessageChars(jsonlPath, turnMessageIds) {
  const result = {
    byMessage: new Map(),
    messageKind: new Map(),
    turnPromptChars: new Map(),
  };
  if (!jsonlPath || !fssync.existsSync(jsonlPath)) return result;
  // TASK-005: stream via readline so multi-MB .jsonl files (heavy tool-use
  // sessions) don't block the sync event loop by buffering whole-file.
  let stream;
  try {
    stream = fssync.createReadStream(jsonlPath, { encoding: "utf8" });
  } catch {
    return result;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const midToTurn =
    turnMessageIds instanceof Map ? turnMessageIds : new Map();
  const attributedTurns = new Set();
  let pendingPromptChars = 0;
  // Bug-5: wrap the streamed iteration. Mid-read errors (file deleted or
  // truncated while kiro-cli is writing) would otherwise propagate up and
  // crash the whole sync pass. On error we return the partial result and
  // let the next sync re-read fresh.
  try {
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const data = evt && evt.data;
      if (!data || typeof data !== "object") continue;
      const mid = data.message_id;
      if (!mid) continue;
      const content = Array.isArray(data.content) ? data.content : [];
      let chars = 0;
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.kind === "text" && typeof c.data === "string") {
          chars += c.data.length;
        } else if (c.kind === "toolUse" && c.data && typeof c.data === "object") {
          try {
            chars += JSON.stringify(c.data.input || {}).length;
          } catch {
            // ignore
          }
        }
      }
      result.byMessage.set(mid, (result.byMessage.get(mid) || 0) + chars);
      if (!result.messageKind.has(mid)) result.messageKind.set(mid, evt.kind);

      if (evt.kind === "Prompt") {
        pendingPromptChars += chars;
      } else if (evt.kind === "AssistantMessage" && midToTurn.has(mid)) {
        const turnIdx = midToTurn.get(mid);
        if (!attributedTurns.has(turnIdx)) {
          result.turnPromptChars.set(turnIdx, pendingPromptChars);
          attributedTurns.add(turnIdx);
          pendingPromptChars = 0;
        }
      }
    }
  } catch {
    // partial data — return what we have.
  }
  return result;
}

// Extract flat per-turn records from a live session .json + its .jsonl
// sibling. Returns [{ request_id, model_id, request_start_timestamp_ms,
// input_tokens, output_tokens }]. We use the same request_id dedup slot as
// the SQLite path so mutations (turn rewritten on next flush) go through
// the subtract-old/add-new path in parseKiroCliIncremental.
async function readKiroCliSessionTurns(jsonPath) {
  if (!jsonPath || !fssync.existsSync(jsonPath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fssync.readFileSync(jsonPath, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const turns = Array.isArray(
    parsed?.session_state?.conversation_metadata?.user_turn_metadatas,
  )
    ? parsed.session_state.conversation_metadata.user_turn_metadatas
    : [];
  if (turns.length === 0) return [];

  const modelInfo = parsed?.session_state?.rts_model_state?.model_info || null;
  const sessionModelId =
    (modelInfo && (modelInfo.model_id || modelInfo.model_name)) || null;
  const sessionId =
    typeof parsed.session_id === "string" ? parsed.session_id : path.basename(jsonPath, ".json");

  // Build turn_index -> Set(message_id) so the jsonl walker can attribute
  // orphaned Prompt events (not referenced by turn.message_ids) to the
  // right turn. The turn.message_ids list only contains AssistantMessage
  // and ToolResults ids; Prompt ids appear in the jsonl stream only.
  const turnMessageIds = new Map();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t || !Array.isArray(t.message_ids)) continue;
    for (const mid of t.message_ids) {
      if (typeof mid === "string" && mid) turnMessageIds.set(mid, i);
    }
  }

  // Load sibling .jsonl for char-count fallback.
  const jsonlPath = jsonPath.replace(/\.json$/, ".jsonl");
  const charMap = await readKiroCliMessageChars(jsonlPath, turnMessageIds);

  const flat = [];
  for (let turnIdx = 0; turnIdx < turns.length; turnIdx++) {
    const turn = turns[turnIdx];
    if (!turn || typeof turn !== "object") continue;
    // TASK-001: preserve the integer 0. `|| null` would coerce a valid
    // loop_id.rand=0 into a message_id fallback, splitting the dedup
    // namespace across runs that see 0 vs runs that don't.
    const loopRand =
      turn.loop_id && typeof turn.loop_id === "object"
        ? turn.loop_id.rand ?? turn.loop_id.seed ?? null
        : null;
    const messageIds = Array.isArray(turn.message_ids) ? turn.message_ids : [];
    const requestId = loopRand != null ? `${sessionId}:${loopRand}` : (messageIds[0] || null);
    if (!requestId) continue;

    // Prefer real token counts if kiro-cli populated them.
    let inputTokens = toNonNegativeInt(turn.input_token_count);
    let outputTokens = toNonNegativeInt(turn.output_token_count);

    if (inputTokens === 0 && outputTokens === 0) {
      // Fall back to char-count approximation. Input chars come from the
      // sequential Prompt attribution (see readKiroCliMessageChars);
      // output chars come from AssistantMessage+toolUse bodies referenced
      // by turn.message_ids.
      const promptChars = charMap.turnPromptChars.get(turnIdx) || 0;
      let assistantChars = 0;
      for (const mid of messageIds) {
        const chars = charMap.byMessage.get(mid) || 0;
        const kind = charMap.messageKind.get(mid);
        if (kind === "AssistantMessage") assistantChars += chars;
      }
      inputTokens = Math.floor(promptChars / KIRO_CLI_CHARS_PER_TOKEN);
      outputTokens = Math.floor(assistantChars / KIRO_CLI_CHARS_PER_TOKEN);
    }

    // TASK-006: timestamp precedence matches SQLite's
    // request_start_timestamp_ms so a turn that migrates SQLite ↔
    // session-file buckets identically across tiers (previously a turn
    // straddling a half-hour boundary bucketed differently per source
    // because session files use end_timestamp while SQLite uses start).
    //   1. turn.request_start_timestamp_ms   (numeric ms, SQLite shape)
    //   2. turn.start_timestamp              (ISO string)
    //   3. turn.end_timestamp                (ISO string, legacy fallback)
    let tsMs = NaN;
    if (Number.isFinite(Number(turn.request_start_timestamp_ms))) {
      tsMs = Number(turn.request_start_timestamp_ms);
    } else if (turn.start_timestamp) {
      tsMs = Date.parse(turn.start_timestamp);
    } else if (turn.end_timestamp) {
      tsMs = Date.parse(turn.end_timestamp);
    }
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue;

    flat.push({
      request_id: requestId,
      session_model_id: sessionModelId,
      message_id: messageIds[0] || null,
      // Turn-granular migration match: surface the full list so the
      // cross-source retraction in parseKiroCliIncremental can drop this
      // specific turn iff any of its assistant/tool_result message_ids
      // appears in SQLite. Session-level matching over-retracts newer
      // turns in an active session whose older turns have already
      // flushed to SQLite.
      all_message_ids: messageIds.slice(),
      model_id: turn.model_id || sessionModelId,
      request_start_timestamp_ms: tsMs,
      // D-1 / Bug-2: tag with session_id so the retraction pass can match
      // session-origin entries even when the requestId format has no
      // colon (no-loop_id fallback uses a bare message_id UUID that would
      // otherwise be indistinguishable from SQLite's UUID keys).
      session_id: sessionId,
      // For the parser, we feed the ALREADY-approximated tokens directly via
      // a special sentinel field. The parser will divide chars by
      // KIRO_CLI_CHARS_PER_TOKEN; bypass that by pre-multiplying here.
      user_prompt_length: inputTokens * KIRO_CLI_CHARS_PER_TOKEN,
      response_size: outputTokens * KIRO_CLI_CHARS_PER_TOKEN,
    });
  }
  return flat;
}

function kiroCliV2ContentChars(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce(
      (sum, item) => sum + kiroCliV2ContentChars(item),
      0,
    );
  }
  if (!value || typeof value !== "object") return 0;
  for (const key of ["content", "text", "value", "parts", "entries"]) {
    if (value[key] !== undefined) {
      return kiroCliV2ContentChars(value[key]);
    }
  }
  return 0;
}

function kiroCliV2UsageCredits(payload) {
  const summaries = Array.isArray(payload?.promptTurnSummaries)
    ? payload.promptTurnSummaries
    : [];
  let totalCredits = 0;
  let hasCreditEntry = false;
  for (const summary of summaries) {
    if (!summary || typeof summary !== "object") continue;
    const unit = String(summary.unit || "").trim().toLowerCase();
    if (unit !== "credit" && unit !== "credits") continue;
    const usage = Number(summary.usage);
    if (!Number.isFinite(usage) || usage < 0) continue;
    totalCredits += usage;
    hasCreditEntry = true;
  }
  return {
    totalCredits,
    recordCount: hasCreditEntry ? 1 : 0,
  };
}

// Kiro CLI 2.13+ writes event-sourced sessions under
// ~/.kiro/sessions/<workspaceHash>/sess_<uuid>/messages.jsonl. The records do
// not carry token counts, but user/assistant text, tool_result payloads, turn
// boundaries, timestamps, and assistant reasoningModelId are sufficient for
// the same 4 chars/token approximation used by the legacy CLI reader.
// tool_result content counts as INPUT: tool output (file reads, command
// output, search results) is fed back to the model as context on the next
// request — skipping it undercounted tool-heavy sessions by ~67% (#366).
async function readKiroCliV2SessionTurns(messagesPath) {
  if (
    !messagesPath ||
    path.basename(messagesPath) !== "messages.jsonl" ||
    !fssync.existsSync(messagesPath)
  ) {
    return {
      turns: [],
      credits: { totalCredits: 0, recordCount: 0, latestAt: null },
    };
  }

  const sessionDir = path.dirname(messagesPath);
  let sessionMeta = {};
  try {
    sessionMeta = JSON.parse(
      fssync.readFileSync(path.join(sessionDir, "session.json"), "utf8"),
    );
  } catch {
    // messages.jsonl is self-contained enough to parse without session.json.
  }

  const sessionId =
    typeof sessionMeta?.id === "string" && sessionMeta.id
      ? sessionMeta.id
      : path.basename(sessionDir);
  const fallbackModel =
    typeof sessionMeta?.modelId === "string" ? sessionMeta.modelId : null;
  const fallbackTimestamp = Date.parse(
    sessionMeta?.createdAt || sessionMeta?.lastModifiedAt || "",
  );

  const flat = [];
  let stream;
  try {
    stream = fssync.createReadStream(messagesPath, { encoding: "utf8" });
  } catch {
    return {
      turns: flat,
      credits: { totalCredits: 0, recordCount: 0, latestAt: null },
    };
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let pendingUserChars = 0;
  let pendingUserTimestampMs = NaN;
  let turn = null;
  let fallbackTurnIndex = 0;
  const seenCreditEvents = new Set();
  let totalCredits = 0;
  let creditRecordCount = 0;
  let latestCreditAt = null;

  const flushTurn = () => {
    if (!turn) return;
    const hasUsage =
      turn.outputChars > 0 ||
      turn.reasoningChars > 0;
    const tsMs = Number.isFinite(turn.timestampMs)
      ? turn.timestampMs
      : Number.isFinite(pendingUserTimestampMs)
        ? pendingUserTimestampMs
        : fallbackTimestamp;
    if (hasUsage && Number.isFinite(tsMs) && tsMs > 0) {
      const requestId =
        turn.executionId ||
        `${sessionId}:v2:${fallbackTurnIndex}`;
      const messageIds = Array.from(turn.messageIds);
      flat.push({
        request_id: requestId,
        message_id: messageIds[0] || turn.executionId || null,
        all_message_ids: messageIds,
        session_id: sessionId,
        session_model_id: fallbackModel,
        model_id: turn.modelId || fallbackModel,
        request_start_timestamp_ms: tsMs,
        user_prompt_length: turn.inputChars,
        response_size: turn.outputChars,
        reasoning_size: turn.reasoningChars,
      });
    }
    fallbackTurnIndex++;
    turn = null;
  };

  const startTurn = (payload, timestampMs) => {
    flushTurn();
    turn = {
      executionId:
        typeof payload?.executionId === "string" ? payload.executionId : null,
      timestampMs:
        Number.isFinite(timestampMs)
          ? timestampMs
          : pendingUserTimestampMs,
      inputChars: pendingUserChars,
      outputChars: 0,
      reasoningChars: 0,
      modelId: null,
      messageIds: new Set(),
    };
    pendingUserChars = 0;
    pendingUserTimestampMs = NaN;
  };

  try {
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = event?.payload;
      if (!payload || typeof payload !== "object") continue;
      const type =
        typeof payload.type === "string"
          ? payload.type.toLowerCase()
          : "";
      const timestampMs = Date.parse(event.timestamp || "");

      if (type === "user") {
        if (turn) flushTurn();
        pendingUserChars = kiroCliV2ContentChars(payload.content);
        pendingUserTimestampMs = timestampMs;
        continue;
      }

      if (type === "turn_start") {
        startTurn(payload, timestampMs);
        continue;
      }

      if (type === "usage_summary") {
        const creditEventKey =
          typeof event.id === "string" && event.id
            ? event.id
            : `${payload.executionId || ""}:${event.timestamp || ""}:${creditRecordCount}`;
        if (!seenCreditEvents.has(creditEventKey)) {
          seenCreditEvents.add(creditEventKey);
          const usage = kiroCliV2UsageCredits(payload);
          if (usage.recordCount > 0) {
            totalCredits += usage.totalCredits;
            creditRecordCount += usage.recordCount;
            if (
              Number.isFinite(timestampMs) &&
              (
                !latestCreditAt ||
                timestampMs > Date.parse(latestCreditAt)
              )
            ) {
              latestCreditAt = new Date(timestampMs).toISOString();
            }
          }
        }
        // Billing summaries are independent metadata. They can arrive after
        // turn_end, so they must not create or mutate token turns.
        continue;
      }

      if (
        ["assistant", "tool_call", "tool_result"].includes(
          type,
        ) &&
        !turn
      ) {
        startTurn(payload, timestampMs);
      }
      if (!turn) continue;

      if (
        typeof payload.executionId === "string" &&
        payload.executionId &&
        !turn.executionId
      ) {
        turn.executionId = payload.executionId;
      }
      if (typeof event.id === "string" && event.id) {
        turn.messageIds.add(event.id);
      }

      if (type === "assistant") {
        const chars = kiroCliV2ContentChars(payload.content);
        if (
          typeof payload.operationType === "string" &&
          payload.operationType.toLowerCase() === "reasoning"
        ) {
          turn.reasoningChars += chars;
        } else {
          turn.outputChars += chars;
        }
        if (
          typeof payload.reasoningModelId === "string" &&
          payload.reasoningModelId
        ) {
          turn.modelId = payload.reasoningModelId;
        }
      } else if (type === "tool_result") {
        // #366: tool output re-enters the model as input context on the
        // next request within the turn. Same ÷4 heuristic as user text.
        turn.inputChars += kiroCliV2ContentChars(payload.content);
      } else if (type === "turn_end") {
        flushTurn();
      }
    }
  } catch {
    // Return complete turns parsed before a concurrent truncate/delete.
  }
  flushTurn();
  return {
    turns: flat,
    credits: {
      totalCredits,
      recordCount: creditRecordCount,
      latestAt: latestCreditAt,
    },
  };
}

async function writeKiroCliCreditsSidecar({
  queuePath,
  installKey,
  totalCredits,
  recordCount,
  sessionCount,
  fileCount,
  latestAt,
} = {}) {
  if (!queuePath || !(fileCount > 0)) return;
  const sidecarPath = path.join(
    path.dirname(queuePath),
    KIRO_CLI_CREDITS_SIDECAR,
  );
  try {
    // Dual-install (#306): keep one entry per install and aggregate at the
    // top level, so a second install's write never clobbers the first. The
    // top-level fields keep the v1 shape readKiroCreditsSummary consumes.
    let installs = {};
    try {
      const prev = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
      if (prev?.version === 1 && prev.installs && typeof prev.installs === "object") {
        installs = prev.installs;
      }
    } catch {
      // first write or pre-dual-install sidecar — start fresh
    }
    // Expire entries whose install stopped syncing (deleted WSL distro,
    // distro rename / UNC alias flip leaving a duplicate key, mode switched
    // to *-only). Without this the read-modify-write merge would inflate the
    // aggregate with phantom installs forever; a 30-day grace keeps entries
    // alive across transient wsl.exe probe failures.
    const staleMs = 30 * 24 * 60 * 60 * 1000;
    for (const [k, entry] of Object.entries(installs)) {
      const ts = Date.parse(entry?.updated_at || "");
      if (!Number.isFinite(ts) || Date.now() - ts > staleMs) delete installs[k];
    }
    const key = typeof installKey === "string" && installKey ? installKey : "default";
    installs[key] = {
      total_credits: Number(totalCredits.toFixed(12)),
      record_count: recordCount,
      session_count: sessionCount,
      file_count: fileCount,
      latest_at: latestAt,
      updated_at: new Date().toISOString(),
    };
    let aggCredits = 0;
    let aggRecords = 0;
    let aggSessions = 0;
    let aggFiles = 0;
    let aggLatestAt = null;
    for (const entry of Object.values(installs)) {
      aggCredits += Number(entry.total_credits) || 0;
      aggRecords += Number(entry.record_count) || 0;
      aggSessions += Number(entry.session_count) || 0;
      aggFiles += Number(entry.file_count) || 0;
      if (
        typeof entry.latest_at === "string" &&
        (!aggLatestAt || Date.parse(entry.latest_at) > Date.parse(aggLatestAt))
      ) {
        aggLatestAt = entry.latest_at;
      }
    }
    await writeJson(sidecarPath, {
      version: 1,
      source: "kiro-cli-usage-summary",
      total_credits: Number(aggCredits.toFixed(12)),
      record_count: aggRecords,
      session_count: aggSessions,
      file_count: aggFiles,
      latest_at: aggLatestAt,
      updated_at: new Date().toISOString(),
      installs,
    });
    await chmod600IfPossible(sidecarPath);
  } catch {
    // Credits are supplemental billing metadata. A sidecar write failure must
    // never block the canonical token queue.
  }
}

// Canonicalize a Kiro-CLI-emitted model id so IDE and CLI rows collapse when
// they refer to the same underlying Bedrock model. Examples:
//   anthropic.claude-sonnet-4-20250514-v1:0  -> claude-sonnet-4
//   claude-opus-4.6                           -> claude-opus-4.6
//   claude-sonnet-4.5                         -> claude-sonnet-4.5
//   auto                                      -> null (caller uses 'kiro-cli-agent')
//   <unknown/falsy>                           -> null (caller falls back to 'kiro-cli-agent')
//
// "auto" is treated as unknown because Kiro CLI's auto-routing does not
// expose the underlying Bedrock model id in the session file. Returning
// null lets pricing fall into the kiro-cli-agent bucket (sonnet-4 rates)
// rather than the literal "auto" string which matches Cursor's composer-1
// pricing by accident.
function canonicalizeKiroCliModelId(raw) {
  if (!raw || typeof raw !== "string") return null;
  let name = raw.trim();
  if (!name) return null;
  name = name.toLowerCase();
  if (name === "auto") return null;
  name = name.replace(/^(?:qdev|kiro)::/, "");
  // Strip provider prefix (anthropic., aws., openai., or a full Bedrock ARN).
  name = name.replace(
    /^(?:arn:aws:bedrock:[^:]*:[^:]*:(?:foundation-model\/)?|anthropic\.|openai\.|aws\.)/,
    "",
  );
  // Strip Bedrock revision suffix `:N`.
  name = name.replace(/:\d+$/, "");
  // Strip date + vN suffix (e.g. "-20250514-v1"), or lone "-vN", or lone date.
  name = name.replace(/-\d{8}-v\d+$/i, "");
  name = name.replace(/-v\d+$/i, "");
  name = name.replace(/-\d{8}$/, "");
  // Strip trailing ".v1" or similar Anthropic-on-Bedrock tails if present.
  name = name.replace(/\.v\d+$/i, "");
  return name || null;
}

// Read Kiro CLI requests using SQL-side json_extract so we don't pull the
// full (93 MB-ish) conversations_v2 blob back through sqlite3 -json.
//
// D-1: also surfaces `user_turn_metadata.continuation_id` so the cross-
// source retraction pass (parseKiroCliIncremental) can match whichever
// UUID kiro-cli used as the session link. The SQL column
// `conversation_id` and the inner JSON `continuation_id` are different
// UUIDs on observed data; covering both means retraction fires whichever
// side matches the live session's `session_id`.
function readKiroCliRequests(dbPath, env = process.env, sqliteOptions = {}) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const sql =
    "SELECT conversation_id, " +
    "json_extract(value, '$.model_info.model_id') AS session_model_id, " +
    "json_extract(value, '$.user_turn_metadata.continuation_id') AS continuation_id, " +
    "json_extract(value, '$.user_turn_metadata.requests') AS requests_json " +
    "FROM conversations_v2 " +
    "WHERE json_extract(value, '$.user_turn_metadata.requests') IS NOT NULL";

  // WSL installs are read over the \\wsl$ UNC bridge; snapshot to tmp so
  // sqlite3 never opens a WAL database across the 9p bridge.
  let snapshot = null;
  let effectiveDbPath = dbPath;
  if (isUncPath(dbPath)) {
    try {
      snapshot = snapshotSqliteDb(dbPath);
      effectiveDbPath = snapshot.path;
    } catch (_e) { }
  }
  let rows;
  try {
    rows = readSqliteJsonRows(effectiveDbPath, sql, {
      label: "Kiro CLI",
      env,
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120_000,
      ...sqliteOptions,
    });
  } finally {
    if (snapshot) snapshot.cleanup();
  }
  const flat = [];
  for (const row of rows) {
    let requests;
    try {
      requests = JSON.parse(row.requests_json || "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(requests)) continue;
    for (const r of requests) {
      if (!r || typeof r !== "object") continue;
      flat.push({
        conversation_id: row.conversation_id,
        continuation_id: row.continuation_id || null,
        session_model_id: row.session_model_id || null,
        request_id: r.request_id || null,
        message_id: r.message_id || null,
        user_prompt_length: r.user_prompt_length,
        response_size: r.response_size,
        model_id: r.model_id || null,
        request_start_timestamp_ms: r.request_start_timestamp_ms,
      });
    }
  }
  return flat;
}

async function parseKiroCliIncremental({ sessionFiles, cursors, queuePath, onProgress, env, sqliteOptions } = {}) {
  await ensureDir(path.dirname(queuePath));
  const kiroCliState =
    cursors.kiroCli && typeof cursors.kiroCli === "object" ? cursors.kiroCli : {};
  const seenIds = new Set(Array.isArray(kiroCliState.seenIds) ? kiroCliState.seenIds : []);

  // Back-compat branch: if caller explicitly passes sessionFiles (an array of
  // per-session .json paths, the old contract used in tests/fixtures), read
  // them as user_turn_metadatas. New default path below reads the SQLite DB.
  if (Array.isArray(sessionFiles)) {
    return parseKiroCliFromSessionFiles({
      sessionFiles,
      cursors,
      queuePath,
      onProgress,
      env,
      kiroCliState,
      seenIds,
    });
  }

  const resolvedEnv = env || process.env;
  const dbPath = resolveKiroCliDbPath(resolvedEnv);

  // Combine three sources under the same (source='kiro', cursors.kiroCli)
  // namespace: historical rows from the SQLite DB, legacy live session state
  // from ~/.kiro/sessions/cli/{uuid}.json, and Kiro CLI 2.13+ event logs at
  // ~/.kiro/sessions/<workspaceHash>/sess_<uuid>/messages.jsonl. Request ID
  // shapes differ:
  // SQLite carries a persisted request_id UUID; session files synthesize
  // `${sessionId}:${loop_id.rand}`. When kiro-cli migrates a live session
  // into SQLite the same turn lands under a new request_id — the cross-
  // source retraction pass below (D-1 + TASK-007) matches session_id ↔
  // SQLite conversation_id OR continuation_id to subtract the orphan
  // session-file cursor entry before the new SQLite row is processed.
  const flatDb = fssync.existsSync(dbPath)
    ? readKiroCliRequests(dbPath, resolvedEnv, sqliteOptions)
    : [];
  const sessionFilesList = resolveKiroCliSessionFiles(resolvedEnv);
  let flatSessions = [];
  let kiroCreditTotal = 0;
  let kiroCreditRecords = 0;
  let kiroCreditSessions = 0;
  let kiroCreditFiles = 0;
  let latestKiroCreditAt = null;
  for (const sessionPath of sessionFilesList) {
    let turns;
    if (path.basename(sessionPath) === "messages.jsonl") {
      kiroCreditFiles++;
      const parsed = await readKiroCliV2SessionTurns(sessionPath);
      turns = parsed.turns;
      const credits = parsed.credits;
      kiroCreditTotal += credits.totalCredits;
      kiroCreditRecords += credits.recordCount;
      if (credits.recordCount > 0) kiroCreditSessions++;
      if (
        credits.latestAt &&
        (
          !latestKiroCreditAt ||
          Date.parse(credits.latestAt) > Date.parse(latestKiroCreditAt)
        )
      ) {
        latestKiroCreditAt = credits.latestAt;
      }
    } else {
      turns = await readKiroCliSessionTurns(sessionPath);
    }
    for (const turn of turns) flatSessions.push(turn);
  }
  await writeKiroCliCreditsSidecar({
    queuePath,
    // Install identity mirrors resolveKiroCliSessionFiles' sessions home so
    // dual installs keep separate sidecar entries.
    installKey:
      resolvedEnv.KIRO_HOME ||
      path.join(resolvedEnv.HOME || require("node:os").homedir(), ".kiro"),
    totalCredits: kiroCreditTotal,
    recordCount: kiroCreditRecords,
    sessionCount: kiroCreditSessions,
    fileCount: kiroCreditFiles,
    latestAt: latestKiroCreditAt,
  });
  // Per-request state replaces the old seenIds set. Each entry captures
  // what we contributed for that request_id last time, so a later mutation
  // (same request_id, different fingerprint) can subtract-old/add-new
  // instead of being skipped forever.
  const requestState =
    kiroCliState.requests && typeof kiroCliState.requests === "object"
      ? { ...kiroCliState.requests }
      : {};

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const debugEnabled = ["1", "true"].includes(
    String(resolvedEnv.TOKENTRACKER_DEBUG || "").toLowerCase(),
  );

  // ── TASK-007 + D-1: cross-source retraction. When a conversation has
  //    migrated from the session-file tier into SQLite, the cursor's
  //    prior session-file entry (keyed `${sessionId}:${loopRand}` OR a
  //    bare message_id UUID when loop_id is absent) never matches the
  //    new SQLite request_id. Without retraction the old contribution
  //    stays in the bucket absolute and the new SQLite row is added on
  //    top — permanent double-count. D-6: typed non-empty check so a
  //    corrupt NULL/empty conv_id can't poison the match set.
  //
  // Two match sets are built:
  //   • migratedConvIds  — session_id → any row in SQLite. Used to scope
  //                        cursor retraction (coarse but safe because
  //                        un-migrated turns still present in the session
  //                        file are re-added later in this same run).
  //   • migratedMsgIds   — r.message_id → exact turn in SQLite. Used to
  //                        filter flatSessions at TURN granularity. An
  //                        active session with older migrated turns +
  //                        newer session-file-only turns must keep the
  //                        newer turns; session-level filtering dropped
  //                        them and caused Kiro CLI under-count.
  const migratedConvIds = new Set();
  const migratedMsgIds = new Set();
  for (const row of flatDb) {
    if (!row) continue;
    if (typeof row.conversation_id === "string" && row.conversation_id)
      migratedConvIds.add(row.conversation_id);
    if (typeof row.continuation_id === "string" && row.continuation_id)
      migratedConvIds.add(row.continuation_id);
    if (typeof row.message_id === "string" && row.message_id)
      migratedMsgIds.add(row.message_id);
  }
  if (migratedConvIds.size > 0) {
    // Pre-collect to retract so mutation during iteration is safe.
    // Retraction stays session-level: for every cursor entry whose
    // session_id has any row in SQLite, subtract its prior contribution.
    // This is provably correct because turns still live in the session
    // file get re-added in this same run via the (turn-granular) filter
    // below, producing a net delta of zero for un-migrated turns.
    const toRetract = [];
    for (const [reqId, prev] of Object.entries(requestState)) {
      if (!prev || typeof prev !== "object") continue;
      // Bug-2: prefer the stored session_id tag (new schema); fall back
      // to colon-split for legacy cursors pre-dating this change.
      let sid = null;
      if (typeof prev.session_id === "string" && prev.session_id) {
        sid = prev.session_id;
      } else {
        const colon = reqId.indexOf(":");
        if (colon > 0) sid = reqId.slice(0, colon);
      }
      if (!sid || !migratedConvIds.has(sid)) continue;
      toRetract.push([reqId, prev, sid]);
    }
    for (const [reqId, prev, sid] of toRetract) {
      if (
        prev.input_tokens ||
        prev.output_tokens ||
        prev.reasoning_output_tokens
      ) {
        const prevReasoning = toNonNegativeInt(
          prev.reasoning_output_tokens,
        );
        const prevBucket = getHourlyBucket(
          hourlyState,
          "kiro",
          prev.model,
          prev.bucketStart,
        );
        addTotals(prevBucket.totals, {
          input_tokens: -prev.input_tokens,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: -prev.output_tokens,
          reasoning_output_tokens: -prevReasoning,
          total_tokens: -(
            prev.input_tokens +
            prev.output_tokens +
            prevReasoning
          ),
          conversation_count: -1,
        });
        touchedBuckets.add(bucketKey("kiro", prev.model, prev.bucketStart));
      }
      delete requestState[reqId];
      if (debugEnabled) {
        process.stderr.write(
          `[kiro-cli] retracted migrated session entry (conv ${sid})\n`,
        );
      }
    }
    // Turn-granular filter: drop a session-file turn only when at least
    // one of its assistant/tool_result message_ids is present in SQLite
    // (i.e. this specific turn has been flushed). Newer turns in the
    // same session that haven't yet landed in SQLite survive.
    //
    // Edge: a turn with no message_ids at all cannot be matched. We keep
    // it — preferring a rare potential double-count (narrow, since such
    // a turn would also have no request_id under the no-loop_id path and
    // be discarded upstream) over the reported regression of dropping
    // legitimate newer turns wholesale. D-14: still O(N) single-pass.
    const before = flatSessions.length;
    flatSessions = flatSessions.filter((s) => {
      if (!s) return false;
      const mids = Array.isArray(s.all_message_ids)
        ? s.all_message_ids
        : s.message_id
        ? [s.message_id]
        : [];
      for (const mid of mids) {
        if (typeof mid === "string" && mid && migratedMsgIds.has(mid)) {
          return false;
        }
      }
      return true;
    });
    if (debugEnabled && flatSessions.length !== before) {
      process.stderr.write(
        `[kiro-cli] dropped ${before - flatSessions.length} migrated session-file turn(s)\n`,
      );
    }
  }

  const flat = flatDb.concat(flatSessions);

  if (flat.length === 0) {
    // Bug-1: retraction may have touched buckets even with empty flat.
    // Clamp + cap BEFORE flushing so the early-return path applies the
    // same guarantees as the main path (fixes a skip that flushed
    // negative conversation_counts and left the cap unapplied).
    const cappedEarly = clampAndCapKiroCliState({
      requestState,
      hourlyState,
      touchedBuckets,
    });
    const bucketsQueued = await enqueueTouchedBuckets({
      queuePath,
      hourlyState,
      touchedBuckets,
    });
    const updatedAt = new Date().toISOString();
    hourlyState.updatedAt = updatedAt;
    cursors.hourly = hourlyState;
    cursors.kiroCli = {
      ...kiroCliState,
      requests: cappedEarly.requests,
      watermarkMs: Math.max(Number(kiroCliState.watermarkMs) || 0, cappedEarly.watermarkMs),
      updatedAt,
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued };
  }
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  // 2026-06 audit fix: requests older than the persisted prune watermark were
  // already counted once and had their cursor entry pruned by
  // clampAndCapKiroCliState — re-processing them (prev === undefined) re-ADDED
  // their tokens to the same bucket on every sync, inflating old buckets
  // without bound. Skip them; the watermark only ever advances, and starts at
  // 0 so a first-ever parse still ingests the full DB history.
  const kiroCliWatermarkMs = Number(kiroCliState.watermarkMs) || 0;

  for (let i = 0; i < flat.length; i++) {
    const r = flat[i];
    recordsProcessed++;

    const requestId = r.request_id || r.message_id;
    if (!requestId) continue;

    const promptChars = toNonNegativeInt(r.user_prompt_length);
    const responseChars = toNonNegativeInt(r.response_size);
    const reasoningChars = toNonNegativeInt(r.reasoning_size);
    const approxInput = Math.floor(promptChars / KIRO_CLI_CHARS_PER_TOKEN);
    const approxOutput = Math.floor(responseChars / KIRO_CLI_CHARS_PER_TOKEN);
    const approxReasoning = Math.floor(
      reasoningChars / KIRO_CLI_CHARS_PER_TOKEN,
    );

    const tsMs = Number(r.request_start_timestamp_ms);
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue;
    if (tsMs < kiroCliWatermarkMs) continue;
    const bucketStart = toUtcHalfHourStart(new Date(tsMs).toISOString());
    if (!bucketStart) continue;

    const rawModel = r.model_id || r.session_model_id;
    const canonical = canonicalizeKiroCliModelId(rawModel);
    const model = canonical || "kiro-cli-agent";

    // Fingerprint captures every field whose change should cause a re-bucket.
    const fingerprint =
      `${promptChars}:${responseChars}:${reasoningChars}:${model}:${tsMs}`;
    const prev = requestState[requestId];
    if (prev && prev.fingerprint === fingerprint) continue; // unchanged

    // Subtract the prior contribution (if any) from its prior bucket so the
    // bucket's absolute totals reflect the CURRENT truth, not the historical
    // truth. enqueueTouchedBuckets will emit the net delta at flush time.
    if (
      prev &&
      (
        prev.input_tokens ||
        prev.output_tokens ||
        prev.reasoning_output_tokens
      )
    ) {
      const prevReasoning = toNonNegativeInt(
        prev.reasoning_output_tokens,
      );
      const prevBucket = getHourlyBucket(hourlyState, "kiro", prev.model, prev.bucketStart);
      addTotals(prevBucket.totals, {
        input_tokens: -prev.input_tokens,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: -prev.output_tokens,
        reasoning_output_tokens: -prevReasoning,
        total_tokens: -(
          prev.input_tokens +
          prev.output_tokens +
          prevReasoning
        ),
        conversation_count: -1,
      });
      touchedBuckets.add(bucketKey("kiro", prev.model, prev.bucketStart));
    }

    // Add the new contribution.
    if (approxInput > 0 || approxOutput > 0 || approxReasoning > 0) {
      const bucket = getHourlyBucket(hourlyState, "kiro", model, bucketStart);
      addTotals(bucket.totals, {
        input_tokens: approxInput,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: approxOutput,
        reasoning_output_tokens: approxReasoning,
        total_tokens: approxInput + approxOutput + approxReasoning,
        conversation_count: 1,
      });
      touchedBuckets.add(bucketKey("kiro", model, bucketStart));
      eventsAggregated++;
    }

    // Always record the cursor entry (even for zero-token requests) so we
    // don't re-count later if Kiro rewrites this request with real data.
    // Bug-2: tag session-origin entries with session_id so the retraction
    // pass can identify them regardless of request_id format (the
    // no-loop_id fallback produces a bare UUID with no colon, which would
    // otherwise be indistinguishable from SQLite's UUID keys).
    requestState[requestId] = {
      fingerprint,
      bucketStart,
      model,
      input_tokens: approxInput,
      output_tokens: approxOutput,
      reasoning_output_tokens: approxReasoning,
      ...(r.session_id ? { session_id: r.session_id } : {}),
    };

    if (cb && i % 50 === 0) {
      cb({
        index: i + 1,
        total: flat.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const cappedState = clampAndCapKiroCliState({
    requestState,
    hourlyState,
    touchedBuckets,
  });

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kiroCli = {
    ...kiroCliState,
    requests: cappedState.requests,
    watermarkMs: Math.max(kiroCliWatermarkMs, cappedState.watermarkMs),
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// TASK-004 + TASK-010 + Bug-1: shared end-of-run clamp + cap for
// parseKiroCliIncremental. Centralized so the main path AND the
// retraction-only early-return path both apply the same guarantees.
// Mutates hourlyState bucket totals in place (clamp) and returns a new
// capped requestState object (cap).
const KIRO_CLI_CURSOR_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const KIRO_CLI_CURSOR_MAX_ENTRIES = 20_000;

function clampAndCapKiroCliState({ requestState, hourlyState, touchedBuckets }) {
  // TASK-010: clamp conversation_count to >= 0 on Kiro-touched buckets
  // only. The shared enqueueTouchedBuckets is left untouched so
  // legitimate negatives from the 10 other parsers are not masked. Kiro
  // negatives come from the subtract-old pass on mutation or retraction.
  for (const key of touchedBuckets) {
    const bucket = hourlyState.buckets && hourlyState.buckets[key];
    if (bucket && bucket.totals && bucket.totals.conversation_count < 0) {
      bucket.totals.conversation_count = 0;
    }
  }
  // TASK-004: cap cursors.kiroCli.requests by age + count. Runs LAST so
  // nothing active or just-retracted is pruned mid-flight.
  //
  // 2026-06 audit fix: pruning an entry while readKiroCliRequests has no
  // time floor meant the same request came back next sync with
  // `prev === undefined` and was re-ADDED to its (old) bucket — every sync,
  // forever. The returned watermarkMs records how far this prune reached;
  // the parse loop skips any request older than the persisted watermark, so
  // a pruned request can never be re-counted. First-ever parse still counts
  // arbitrarily old history (watermark starts at 0).
  const ageCutoffMs = Date.now() - KIRO_CLI_CURSOR_MAX_AGE_MS;
  const cappedEntries = [];
  for (const [reqId, entry] of Object.entries(requestState)) {
    if (!entry || typeof entry !== "object") continue;
    const ts = entry.bucketStart ? Date.parse(entry.bucketStart) : NaN;
    if (!Number.isFinite(ts) || ts < ageCutoffMs) continue;
    cappedEntries.push([reqId, entry, ts]);
  }
  // +30min margin: entries are pruned by bucketStart (half-hour floor) while
  // the parse loop skips by raw request ts, which can sit up to 30 minutes
  // after its bucketStart. Without the margin a request whose bucket just
  // crossed the cutoff would be pruned yet still pass the skip, re-adding for
  // a few syncs until the watermark catches up.
  let watermarkMs = ageCutoffMs + 30 * 60 * 1000;
  if (cappedEntries.length > KIRO_CLI_CURSOR_MAX_ENTRIES) {
    cappedEntries.sort((a, b) => b[2] - a[2]); // newest first
    // Newest EVICTED entry sits at index MAX_ENTRIES after the sort; the
    // watermark must clear it so count-capped evictions can't re-add either.
    watermarkMs = Math.max(watermarkMs, cappedEntries[KIRO_CLI_CURSOR_MAX_ENTRIES][2] + 1);
    cappedEntries.length = KIRO_CLI_CURSOR_MAX_ENTRIES;
  }
  const capped = {};
  for (const [reqId, entry] of cappedEntries) capped[reqId] = entry;
  return { requests: capped, watermarkMs };
}

// Back-compat path: per-session .json files (the old fixture shape). Emits
// exact tokens if the fixture happens to carry them (which the test fixture
// does). Used only by the test/rollout-parser.test.js fixture tests.
async function parseKiroCliFromSessionFiles({
  sessionFiles,
  cursors,
  queuePath,
  onProgress,
  env,
  kiroCliState,
  seenIds,
}) {
  const fileOffsets =
    kiroCliState.fileOffsets && typeof kiroCliState.fileOffsets === "object"
      ? { ...kiroCliState.fileOffsets }
      : {};
  if (sessionFiles.length === 0) {
    cursors.kiroCli = {
      ...kiroCliState,
      seenIds: Array.from(seenIds),
      fileOffsets,
      updatedAt: new Date().toISOString(),
    };
    return {
      recordsProcessed: 0,
      eventsAggregated: 0,
      bucketsQueued: 0,
    };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < sessionFiles.length; fileIdx++) {
    const filePath = sessionFiles[fileIdx];
    let stat;
    try {
      stat = fssync.statSync(filePath);
    } catch {
      continue;
    }

    const prevEntry = fileOffsets[filePath] || {};
    const prevMtime = Number(prevEntry.mtimeMs) || 0;
    const prevLastIndex = Number.isFinite(Number(prevEntry.lastIndex))
      ? Number(prevEntry.lastIndex)
      : -1;
    if (prevMtime && stat.mtimeMs <= prevMtime) continue;

    let parsed;
    try {
      parsed = JSON.parse(fssync.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    const turns = Array.isArray(
      parsed?.session_state?.conversation_metadata?.user_turn_metadatas,
    )
      ? parsed.session_state.conversation_metadata.user_turn_metadatas
      : [];
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : filePath;
    const sessionModelId =
      (parsed?.session_state?.rts_model_state?.model_info &&
        (parsed.session_state.rts_model_state.model_info.model_id ||
          parsed.session_state.rts_model_state.model_info.modelId)) ||
      null;

    let maxIndex = prevLastIndex;
    for (let i = 0; i < turns.length; i++) {
      if (i <= prevLastIndex) continue;
      const turn = turns[i];
      if (!turn || typeof turn !== "object") continue;
      recordsProcessed++;

      const input = toNonNegativeInt(turn.input_tokens);
      const output = toNonNegativeInt(turn.output_tokens);
      const cacheRead = toNonNegativeInt(
        turn.cache_read_input_tokens ?? turn.cached_input_tokens,
      );
      const cacheCreation = toNonNegativeInt(
        turn.cache_creation_input_tokens ?? turn.cache_write_input_tokens,
      );
      const reasoning = toNonNegativeInt(turn.reasoning_output_tokens);
      if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) {
        maxIndex = i;
        continue;
      }

      const ts = turn.timestamp || turn.created_at || turn.updated_at;
      if (!ts) continue;
      const bucketStart = toUtcHalfHourStart(ts);
      if (!bucketStart) continue;

      const turnMessageId =
        typeof turn.message_id === "string" && turn.message_id ? turn.message_id : null;
      const dedupKey = turnMessageId ? `${sessionId}:${turnMessageId}` : null;
      if (dedupKey && seenIds.has(dedupKey)) {
        maxIndex = i;
        continue;
      }

      const rawModel =
        turn.model_id ||
        turn.modelId ||
        (turn.model_info && (turn.model_info.model_id || turn.model_info.modelId)) ||
        sessionModelId;
      const normalized = rawModel ? normalizeKiroModelName(rawModel) : null;
      const model = normalized || "kiro-cli-agent";

      const delta = {
        input_tokens: input,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output + cacheRead + cacheCreation + reasoning,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, "kiro", model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("kiro", model, bucketStart));
      if (dedupKey) seenIds.add(dedupKey);
      maxIndex = i;
      eventsAggregated++;

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: sessionFiles.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    fileOffsets[filePath] = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      lastIndex: maxIndex,
    };
  }

  const seenArr = Array.from(seenIds);
  const cappedSeen = seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kiroCli = { ...kiroCliState, seenIds: cappedSeen, fileOffsets, updatedAt };

  return {
    recordsProcessed,
    eventsAggregated,
    bucketsQueued,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function resolveKimiHome(env = process.env) {
  const home = require("node:os").homedir();
  const explicit = typeof env?.KIMI_HOME === "string" ? env.KIMI_HOME.trim() : "";
  if (explicit) return path.resolve(explicit);
  if (process.platform === "win32") {
    return pickWin32ProviderPath({
      env,
      nativeValue: path.join(home, ".kimi"),
      wslProviderDir: ".kimi",
    });
  }
  return path.join(home, ".kimi");
}

function resolveKimiWireFiles(env = process.env) {
  const kimiHome = resolveKimiHome(env);
  if (!kimiHome) return [];
  const sessionsDir = path.join(kimiHome, "sessions");
  if (!fssync.existsSync(sessionsDir)) return [];
  const files = [];
  try {
    for (const ws of fssync.readdirSync(sessionsDir)) {
      const wsDir = path.join(sessionsDir, ws);
      let wsStat;
      try { wsStat = fssync.statSync(wsDir); } catch { continue; }
      if (!wsStat.isDirectory()) continue;
      for (const sess of fssync.readdirSync(wsDir)) {
        const wireFile = path.join(wsDir, sess, "wire.jsonl");
        if (fssync.existsSync(wireFile)) files.push(wireFile);
      }
    }
  } catch { /* ignore */ }
  return files;
}

async function parseKimiIncremental({ wireFiles, cursors, queuePath, onProgress, env, model } = {}) {
  await ensureDir(path.dirname(queuePath));
  const kimiState = cursors.kimi && typeof cursors.kimi === "object" ? cursors.kimi : {};
  const seenIds = new Set(Array.isArray(kimiState.seenIds) ? kimiState.seenIds : []);
  const fileOffsets =
    kimiState.fileOffsets && typeof kimiState.fileOffsets === "object"
      ? { ...kimiState.fileOffsets }
      : {};

  const files = Array.isArray(wireFiles)
    ? wireFiles
    : resolveKimiWireFiles(env || process.env);
  const kimiModel = model || resolveKimiDefaultModel(env || process.env);
  if (files.length === 0) {
    cursors.kimi = { ...kimiState, seenIds: Array.from(seenIds), fileOffsets, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    if (stat.size <= startOffset) continue;

    let stream;
    try {
      stream = fssync.createReadStream(filePath, { encoding: "utf8", start: startOffset });
    } catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const msg = entry.message;
      if (!msg || msg.type !== "StatusUpdate") continue;

      const payload = msg.payload;
      if (!payload) continue;
      const { token_usage, message_id } = payload;
      if (!token_usage || !message_id) continue;
      if (seenIds.has(message_id)) continue;

      recordsProcessed++;

      const input = toNonNegativeInt(token_usage.input_other);
      const output = toNonNegativeInt(token_usage.output);
      const cacheRead = toNonNegativeInt(token_usage.input_cache_read);
      const cacheCreation = toNonNegativeInt(token_usage.input_cache_creation);
      if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) {
        seenIds.add(message_id);
        continue;
      }

      const epochSec = entry.timestamp ?? payload.timestamp;
      if (epochSec == null || !Number.isFinite(Number(epochSec))) continue;
      const tsIso = new Date(Number(epochSec) * 1000).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const delta = {
        input_tokens: input,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: input + output + cacheRead + cacheCreation,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, "kimi", kimiModel, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("kimi", kimiModel, bucketStart));
      seenIds.add(message_id);
      eventsAggregated++;

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: files.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    let postStat = stat;
    try { postStat = fssync.statSync(filePath); } catch {}
    fileOffsets[filePath] = { size: postStat.size, mtimeMs: postStat.mtimeMs, ino: postStat.ino };
  }

  // Cap seenIds to last 10k to bound cursor state size
  const seenArr = Array.from(seenIds);
  const cappedSeen = seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kimi = { ...kimiState, seenIds: cappedSeen, fileOffsets, updatedAt };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kimi Code (official @moonshot-ai/kimi-code) — passive JSONL reader.
//
// Distinct from the legacy community `kimi-cli` above (Python, ~/.kimi). The
// official single-binary product stores under ~/.kimi-code/ with a different
// session layout and wire protocol:
//
//   ~/.kimi-code/sessions/<wd_dir_hash>/<session_id>/agents/<name>/wire.jsonl
//
// proto 1.x events are namespaced and carry `type` at the top level. Per-step
// token usage rides on a `step.end` loop event (wrapped in
// `context.append_loop_event`) with an Anthropic-style usage object:
//
//   {"type":"context.append_loop_event",
//    "event":{"type":"step.end","uuid":"<stepUuid>","turnId":"..","step":N,
//      "usage":{"input_tokens":N,"output_tokens":N,
//               "cache_read_input_tokens":N,"cache_creation_input_tokens":N}},
//    "time":<epoch_ms>}
//
// Model comes from the per-session `config.update` event's `modelAlias`
// (e.g. "kimi-code/kimi-k2.6" -> "kimi-k2.6"). Emitted under source "kimi" so
// new + legacy sessions aggregate together. Independent cursor (cursors.kimiCode)
// keeps state from colliding with the legacy reader's cursors.kimi.
function resolveKimiCodeHome(env = process.env) {
  const home = require("node:os").homedir();
  const explicit = typeof env?.KIMI_CODE_HOME === "string" ? env.KIMI_CODE_HOME.trim() : "";
  if (explicit) return path.resolve(explicit);
  if (process.platform === "win32") {
    return pickWin32ProviderPath({
      env,
      nativeValue: path.join(home, ".kimi-code"),
      wslProviderDir: ".kimi-code",
    });
  }
  return path.join(home, ".kimi-code");
}

function resolveKimiCodeWireFiles(env = process.env) {
  const kimiHome = resolveKimiCodeHome(env);
  if (!kimiHome) return [];
  const sessionsDir = path.join(kimiHome, "sessions");
  if (!fssync.existsSync(sessionsDir)) return [];
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fssync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.name === "wire.jsonl") files.push(full);
    }
  };
  walk(sessionsDir, 0);
  return files;
}

function resolveKimiCodeDefaultModel(env = process.env) {
  const fallback = "kimi-for-coding";
  try {
    const kimiHome = resolveKimiCodeHome(env);
    if (!kimiHome) return fallback;
    const cfgPath = path.join(kimiHome, "config.toml");
    const raw = fssync.readFileSync(cfgPath, "utf8");
    const m = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
    if (!m) return fallback;
    return m[1].includes("/") ? m[1].split("/").pop() : m[1] || fallback;
  } catch {
    return fallback;
  }
}

function kimiCodeModelAlias(value) {
  if (typeof value !== "string" || !value) return null;
  return value.includes("/") ? value.split("/").pop() : value;
}

async function parseKimiCodeIncremental({ wireFiles, cursors, queuePath, onProgress, env, model } = {}) {
  await ensureDir(path.dirname(queuePath));
  const state = cursors.kimiCode && typeof cursors.kimiCode === "object" ? cursors.kimiCode : {};
  const seenIds = new Set(Array.isArray(state.seenIds) ? state.seenIds : []);
  const fileOffsets =
    state.fileOffsets && typeof state.fileOffsets === "object" ? { ...state.fileOffsets } : {};

  const files = Array.isArray(wireFiles) ? wireFiles : resolveKimiCodeWireFiles(env || process.env);
  const fallbackModel = model || resolveKimiCodeDefaultModel(env || process.env);
  if (files.length === 0) {
    cursors.kimiCode = { ...state, seenIds: Array.from(seenIds), fileOffsets, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    // Model is declared in a `config.update` near the file head; persist it on
    // the cursor so incremental resumes (which start past that line) keep it.
    let fileModel = (typeof prevEntry.model === "string" && prevEntry.model) || fallbackModel;
    if (stat.size <= startOffset) continue;

    let stream;
    try {
      stream = fssync.createReadStream(filePath, { encoding: "utf8", start: startOffset });
    } catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type === "config.update") {
        const alias = kimiCodeModelAlias(entry.modelAlias);
        if (alias) fileModel = alias;
        continue;
      }

      const evt =
        entry.type === "context.append_loop_event" && entry.event && typeof entry.event === "object"
          ? entry.event
          : entry;
      if (!evt || evt.type !== "step.end") continue;
      const usage = evt.usage;
      if (!usage || typeof usage !== "object") continue;
      const id = evt.uuid;
      if (!id || seenIds.has(id)) continue;

      recordsProcessed++;

      // kimi-code's wire usage comes in two shapes across versions:
      //  - camelCase (proto 0.6.0+, current): { inputOther, inputCacheRead,
      //    inputCacheCreation, output } where inputOther is already fresh
      //    (non-cached) input — this is `response.usage` straight from the LLM
      //    adapter (verified in @moonshot-ai/kimi-code 0.6.0/0.7.0/0.9.0).
      //  - Anthropic-style (older): { input_tokens, output_tokens,
      //    cache_read_input_tokens, cache_creation_input_tokens }. OpenAI-compat
      //    models fold cached reads into input_tokens and expose them via
      //    input_tokens_details.cached_tokens — subtract so we never double-count.
      // step.end and usage.record carry the SAME per-step usage object, so we
      // read only step.end here (reading both would double-count ~2x).
      let cacheCreation;
      let cacheRead;
      let input;
      let output;
      if (usage.inputOther != null) {
        input = toNonNegativeInt(usage.inputOther);
        cacheRead = toNonNegativeInt(usage.inputCacheRead);
        cacheCreation = toNonNegativeInt(usage.inputCacheCreation);
        output = toNonNegativeInt(usage.output);
      } else {
        cacheCreation = toNonNegativeInt(usage.cache_creation_input_tokens);
        if (usage.cache_read_input_tokens != null) {
          cacheRead = toNonNegativeInt(usage.cache_read_input_tokens);
          input = toNonNegativeInt(usage.input_tokens);
        } else {
          const details =
            usage.input_tokens_details && typeof usage.input_tokens_details === "object"
              ? usage.input_tokens_details
              : null;
          const cached = toNonNegativeInt(details ? details.cached_tokens : 0);
          cacheRead = cached;
          input = Math.max(0, toNonNegativeInt(usage.input_tokens) - cached);
        }
        output = toNonNegativeInt(usage.output_tokens);
      }
      if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) {
        seenIds.add(id);
        continue;
      }

      const ms = entry.time ?? evt.time;
      if (ms == null || !Number.isFinite(Number(ms))) continue;
      const tsIso = new Date(Number(ms)).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const delta = {
        input_tokens: input,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: input + output + cacheRead + cacheCreation,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, "kimi", fileModel, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("kimi", fileModel, bucketStart));
      seenIds.add(id);
      eventsAggregated++;

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: files.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    let postStat = stat;
    try { postStat = fssync.statSync(filePath); } catch {}
    fileOffsets[filePath] = { size: postStat.size, mtimeMs: postStat.mtimeMs, ino: postStat.ino, model: fileModel };
  }

  const seenArr = Array.from(seenIds);
  const cappedSeen = seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kimiCode = { ...state, seenIds: cappedSeen, fileOffsets, updatedAt };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// CodeBuddy CLI — passive JSONL reader (~/.codebuddy/projects/<cwd>/<sid>.jsonl)
//
// Tencent's CodeBuddy CLI is structurally cloned from Claude Code:
//   ~/.codebuddy/projects/<encoded-cwd>/<sessionId>.jsonl  — conversation log
//   ~/.codebuddy/sessions/<pid>.json                       — session metadata
//   ~/.codebuddy/settings.json                             — `{"model": "..."}`
//
// CodeBuddy ships NO hook system — we incrementally tail the JSONL files on
// each sync (passive scan only, same shape as Kimi's wire.jsonl reader).
//
// Per-line record types: message, reasoning, topic, file-history-snapshot.
// Only `type=="message" and role=="assistant"` carry token usage. The shape:
//
//   providerData.rawUsage = {
//     prompt_tokens: 22223,           // OpenAI-style — INCLUDES cached
//     completion_tokens: 250,
//     prompt_tokens_details: { cached_tokens: 512, reasoning_tokens?: number },
//     cache_read_input_tokens: 0,     // Anthropic-style mirror (often 0)
//     cache_creation_input_tokens: 0,
//   }
//
// Token math (matches the repo's queue convention; do NOT pass prompt_tokens
// through unchanged — that double-counts cached input):
//   input_tokens               = prompt_tokens - prompt_tokens_details.cached_tokens
//   cached_input_tokens        = prompt_tokens_details.cached_tokens
//   cache_creation_input_tokens = cache_creation_input_tokens (often 0)
//   output_tokens              = completion_tokens
//   reasoning_output_tokens    = prompt_tokens_details.reasoning_tokens || 0
//   total_tokens               = sum of the above
// ─────────────────────────────────────────────────────────────────────────────

function resolveCodebuddyHome(env = process.env) {
  const home = env.HOME || require("node:os").homedir();
  if (env.CODEBUDDY_HOME) return env.CODEBUDDY_HOME;
  if (process.platform === "win32") {
    return pickWin32ProviderPath({
      env,
      nativeValue: path.join(home, ".codebuddy"),
      wslProviderDir: ".codebuddy",
    });
  }
  return path.join(home, ".codebuddy");
}

function resolveCodebuddyDefaultModel(env = process.env) {
  const fallback = "codebuddy-unknown";
  try {
    const codebuddyHome = resolveCodebuddyHome(env);
    if (!codebuddyHome) return fallback;
    const settingsPath = path.join(codebuddyHome, "settings.json");
    const raw = fssync.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.model === "string" && parsed.model.trim()) {
      return parsed.model.trim();
    }
  } catch (_e) {
    // settings missing or malformed — fall through
  }
  return fallback;
}

// Modern CodeBuddy writes token usage into providerData.rawUsage on JSONL
// records. Older IDE installs may have no usable JSONL usage and rely on the
// extension log fallback below. Keep the sniff bounded: it is used by the
// guarded historical migration to decide whether a JSONL rebuild is safe.
function codebuddyJsonlHasUsage(filePath) {
  let fd;
  try {
    fd = fssync.openSync(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fssync.readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    const limit = Math.min(lines.length, 100);
    for (let i = 0; i < limit; i += 1) {
      const line = lines[i];
      if (!line || (!line.includes("rawUsage") && !line.includes("\"usage\""))) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== "object") continue;
      const provider = entry.providerData;
      if (provider && typeof provider === "object" && provider.rawUsage && typeof provider.rawUsage === "object") {
        return true;
      }
      if (entry.usage && typeof entry.usage === "object") return true;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fssync.closeSync(fd); } catch {}
    }
  }
  return false;
}

// Legacy IDE extension logs and modern JSONL records do not share an id. Keep
// a bounded, source-neutral fingerprint ledger so a log line can be matched to
// the JSONL round-trip it mirrors without collapsing legitimate same-second
// requests. The ledger is persisted in the CodeBuddy cursor because the two
// sources can arrive on different syncs.
function codebuddyUsageFingerprint({ model, timestampMs, inputTokens, cacheRead, cacheCreation, outputTokens, reasoningTokens }) {
  if (!Number.isFinite(Number(timestampMs)) || Number(timestampMs) <= 0) return null;
  const second = Math.floor(Number(timestampMs) / 1000);
  return [
    second,
    normalizeModelInput(model) || "unknown",
    toNonNegativeInt(inputTokens),
    toNonNegativeInt(cacheRead),
    toNonNegativeInt(cacheCreation),
    toNonNegativeInt(outputTokens),
    toNonNegativeInt(reasoningTokens),
  ].join(":");
}

function restoreCodebuddyUsageFingerprints(raw) {
  const state = new Map();
  if (!raw || typeof raw !== "object") return state;
  for (const [key, value] of Object.entries(raw)) {
    const jsonl = toNonNegativeInt(value?.jsonl);
    const log = toNonNegativeInt(value?.log);
    if (jsonl > 0 || log > 0) state.set(key, { jsonl, log });
  }
  return state;
}

function addCodebuddyJsonlFingerprint(state, fingerprint) {
  if (!fingerprint) return false;
  const current = state.get(fingerprint) || { jsonl: 0, log: 0 };
  const mirrored = current.log > current.jsonl;
  current.jsonl += 1;
  state.set(fingerprint, current);
  return mirrored;
}

function consumeCodebuddyLogFingerprint(state, fingerprint) {
  if (!fingerprint) return false;
  const current = state.get(fingerprint) || { jsonl: 0, log: 0 };
  const mirrored = current.jsonl > current.log;
  current.log += 1;
  state.set(fingerprint, current);
  return mirrored;
}

function capCodebuddyUsageFingerprints(state, maxEntries = 10_000) {
  const entries = Array.from(state.entries());
  if (entries.length <= maxEntries) return Object.fromEntries(entries);
  return Object.fromEntries(entries.slice(entries.length - maxEntries));
}

function resolveCodebuddyProjectFiles(env = process.env) {
  const codebuddyHome = resolveCodebuddyHome(env);
  const jsonlFiles = [];
  const logFiles = [];

  // 1. Recursive JSONL scan in codebuddyHome/projects
  if (codebuddyHome) {
    const projectsDir = path.join(codebuddyHome, "projects");
    if (fssync.existsSync(projectsDir)) {
      const walkJsonl = (dir) => {
        let entries;
        try { entries = fssync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          let isDir = entry.isDirectory();
          let isFile = entry.isFile();
          if (!isDir && !isFile) {
            try {
              const st = fssync.statSync(full);
              isDir = st.isDirectory();
              isFile = st.isFile();
            } catch { continue; }
          }
          if (isDir) walkJsonl(full);
          else if (isFile && entry.name.endsWith(".jsonl")) jsonlFiles.push(full);
        }
      };
      walkJsonl(projectsDir);
    }
  }

  // 2. Active IDE extension logs scan
  const logRoots = [];
  const home = env.HOME || require("node:os").homedir();

  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    logRoots.push({ dir: path.join(appSupport, "CodeBuddy CN", "logs"), pattern: "codebuddy-extension-log" });
    logRoots.push({ dir: path.join(appSupport, "Code", "logs"), pattern: "codebuddy-extension-log" });
    logRoots.push({ dir: path.join(appSupport, "CodeBuddyExtension", "Logs", "CodeBuddyIDE"), pattern: "*.log" });
    logRoots.push({ dir: path.join(appSupport, "CodeBuddyExtension", "Logs", "VSCode"), pattern: "*.log" });
  } else if (process.platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    logRoots.push({ dir: path.join(appData, "CodeBuddy CN", "logs"), pattern: "codebuddy-extension-log" });
    logRoots.push({ dir: path.join(appData, "Code", "logs"), pattern: "codebuddy-extension-log" });
    logRoots.push({ dir: path.join(localAppData, "CodeBuddyExtension", "Logs", "CodeBuddyIDE"), pattern: "*.log" });
    logRoots.push({ dir: path.join(localAppData, "CodeBuddyExtension", "Logs", "VSCode"), pattern: "*.log" });
  } else {
    const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");
    const xdgData = env.XDG_DATA_HOME || path.join(home, ".local", "share");
    logRoots.push({ dir: path.join(xdgConfig, "CodeBuddy CN", "logs"), pattern: "codebuddy-extension-log" });
    logRoots.push({ dir: path.join(xdgConfig, "Code", "logs"), pattern: "codebuddy-extension-log" });
    logRoots.push({ dir: path.join(xdgData, "CodeBuddyExtension", "Logs", "CodeBuddyIDE"), pattern: "*.log" });
    logRoots.push({ dir: path.join(xdgData, "CodeBuddyExtension", "Logs", "VSCode"), pattern: "*.log" });
  }

  for (const root of logRoots) {
    if (!fssync.existsSync(root.dir)) continue;
    const walkLogs = (dir) => {
      let entries;
      try { entries = fssync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (!isDir && !isFile) {
          try {
            const st = fssync.statSync(full);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch { continue; }
        }
        if (isDir) {
          walkLogs(full);
        } else if (isFile && entry.name.endsWith(".log")) {
          if (root.pattern === "*.log") {
            logFiles.push(full);
          } else if (root.pattern === "codebuddy-extension-log") {
            if (full.toLowerCase().includes("tencent-cloud.coding-copilot")) {
              logFiles.push(full);
            }
          }
        }
      }
    };
    walkLogs(root.dir);
  }

  const fallbackMode = String(env.TOKENTRACKER_CODEBUDDY_LOG_FALLBACK || "").trim();
  // Auto mode keeps both sources available. The parser performs bounded,
  // count-aware cross-source fingerprint matching, so mixed histories retain
  // legacy-only log sessions while mirrored rounds are counted once. Env=0 is
  // still a supported escape hatch for users who want to suppress extension
  // logs entirely; env=1 remains an explicit force-on value.
  const includeLogs = fallbackMode !== "0";
  const files = [...jsonlFiles, ...(includeLogs ? logFiles : [])];
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function getBracketValueAfter(line, marker) {
  const parts = line.split(marker);
  if (parts.length < 2) return null;
  const after = parts[1];
  const start = after.indexOf("[");
  if (start === -1) return null;
  const afterOpen = after.slice(start + 1);
  const end = afterOpen.indexOf("]");
  if (end === -1) return null;
  return afterOpen.slice(0, end).trim();
}

function parseLogTimestampMs(line, fallbackTs) {
  let raw = "";
  if (line.startsWith("[")) {
    const endIdx = line.indexOf("]");
    if (endIdx !== -1) {
      raw = line.slice(1, endIdx).trim();
    }
  } else {
    const idx = line.indexOf(" [");
    if (idx !== -1) {
      raw = line.slice(0, idx).trim();
    } else {
      raw = line.slice(0, 23).trim();
    }
  }
  let ts = Date.parse(raw);
  if (isNaN(ts)) {
    const normalized = raw.replace(/\//g, '-');
    ts = Date.parse(normalized);
  }
  return isNaN(ts) ? fallbackTs : ts;
}

async function parseCodebuddyIncremental({
  projectFiles,
  cursors,
  queuePath,
  onProgress,
  env,
  defaultModel,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const codebuddyState =
    cursors.codebuddy && typeof cursors.codebuddy === "object" ? cursors.codebuddy : {};
  const seenIds = new Set(
    Array.isArray(codebuddyState.seenIds) ? codebuddyState.seenIds : [],
  );
  const fileOffsets =
    codebuddyState.fileOffsets && typeof codebuddyState.fileOffsets === "object"
      ? { ...codebuddyState.fileOffsets }
      : {};
  const logModelsByAgent =
    codebuddyState.logModelsByAgent && typeof codebuddyState.logModelsByAgent === "object"
      ? { ...codebuddyState.logModelsByAgent }
      : {};
  const usageFingerprints = restoreCodebuddyUsageFingerprints(codebuddyState.usageFingerprints);

  const discoveredFiles = Array.isArray(projectFiles)
    ? projectFiles
    : resolveCodebuddyProjectFiles(env || process.env);
  // JSONL must be parsed before extension logs so the fingerprint ledger can
  // match mirrored rounds in the same sync. Keep the legacy bare-string API
  // accepted for callers and tests.
  const files = [...discoveredFiles].sort((a, b) => {
    const aPath = typeof a === "string" ? a : a?.path || "";
    const bPath = typeof b === "string" ? b : b?.path || "";
    const aLog = aPath.endsWith(".log") ? 1 : 0;
    const bLog = bPath.endsWith(".log") ? 1 : 0;
    return aLog - bLog || aPath.localeCompare(bPath);
  });
  const fallbackModel = defaultModel || resolveCodebuddyDefaultModel(env || process.env);

  if (files.length === 0) {
    cursors.codebuddy = {
      ...codebuddyState,
      seenIds: Array.from(seenIds),
      fileOffsets,
      usageFingerprints: capCodebuddyUsageFingerprints(usageFingerprints),
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    if (stat.size <= startOffset) continue;

    let stream;
    try {
      stream = fssync.createReadStream(filePath, {
        encoding: "utf8",
        start: startOffset,
      });
    } catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const isLogFile = filePath.endsWith(".log");
    const modelsByAgent = new Map();
    const agentModelKey = (agentId) => `${filePath}::${agentId}`;

    for await (const line of rl) {
      if (!line || !line.trim()) continue;

      if (isLogFile) {
        if (line.includes("[CraftInvokableAgent]") && line.includes("Model prepared:")) {
          const agentId = getBracketValueAfter(line, "[CraftInvokableAgent]");
          const marker = "Model prepared:";
          const idx = line.indexOf(marker);
          if (agentId && idx !== -1) {
            const afterMarker = line.slice(idx + marker.length).trim();
            let modelId = afterMarker;
            const openParen = afterMarker.lastIndexOf("(");
            if (openParen !== -1) {
              const tail = afterMarker.slice(openParen + 1);
              const closeParen = tail.indexOf(")");
              if (closeParen !== -1) {
                const inner = tail.slice(0, closeParen).trim();
                if (inner) modelId = inner;
              }
            }
            modelsByAgent.set(agentId, modelId);
            logModelsByAgent[agentModelKey(agentId)] = modelId;
          }
          continue;
        }

        if (!line.includes("[AgentReporter]") || !line.includes("Agent execution successful with usage:")) {
          continue;
        }

        const agentId = getBracketValueAfter(line, "[AgentReporter]");
        if (!agentId) continue;

        const marker = "Agent execution successful with usage:";
        const usageParts = line.split(marker);
        if (usageParts.length < 2) continue;

        const usageJsonRaw = usageParts[1].trim();
        const endBrace = usageJsonRaw.lastIndexOf("}");
        if (endBrace === -1) continue;

        let usage;
        try {
          usage = JSON.parse(usageJsonRaw.slice(0, endBrace + 1));
        } catch { continue; }

        if (!usage || typeof usage !== "object") continue;

        const inputRaw = firstPresentNonNegativeInt([
          usage.cachedMissTokens,
          usage.cacheMissTokens,
          usage.input_tokens,
          usage.inputTokens,
          usage.prompt_tokens,
        ]);
        const outputRaw = firstPresentNonNegativeInt([
          usage.output_tokens,
          usage.outputTokens,
          usage.completion_tokens,
        ]);
        const cacheReadRaw = firstPositiveOrPresentNonNegativeInt([
          usage.cache_read_input_tokens,
          usage.cacheReadInputTokens,
          usage.cacheTokens,
          usage.prompt_cache_hit_tokens,
          usage.cached_tokens,
        ]);
        const cacheCreationRaw = firstPositiveOrPresentNonNegativeInt([
          usage.cache_creation_input_tokens,
          usage.cacheCreationInputTokens,
          usage.cachedWriteTokens,
          usage.prompt_cache_write_tokens,
        ]);
        const reasoningRaw = firstPresentNonNegativeInt([
          usage.completion_thinking_tokens,
          usage.completionThinkingTokens,
          usage.reasoningTokens,
        ]);

        const tsMs = parseLogTimestampMs(line, stat.mtimeMs);
        const dedupSecond = Math.floor(tsMs / 1000);
        const messageId = `codebuddy:extension-log:${agentId}:${dedupSecond}:${inputRaw}:${outputRaw}:${cacheReadRaw}:${cacheCreationRaw}:${reasoningRaw}`;

        if (seenIds.has(messageId)) continue;
        recordsProcessed++;

        let inputTokens = toNonNegativeInt(inputRaw);
        const completionTokens = toNonNegativeInt(outputRaw);
        const cacheRead = toNonNegativeInt(cacheReadRaw);
        const cacheCreation = toNonNegativeInt(cacheCreationRaw);
        const reasoningTokens = toNonNegativeInt(reasoningRaw);

        const isFromTotalField =
          usage.cachedMissTokens === undefined &&
          usage.cacheMissTokens === undefined &&
          usage.prompt_cache_miss_tokens === undefined;
        if (isFromTotalField && cacheRead > 0) {
          inputTokens = Math.max(0, inputTokens - cacheRead);
        }

        if (inputTokens === 0 && completionTokens === 0 && cacheRead === 0 && cacheCreation === 0) {
          seenIds.add(messageId);
          continue;
        }

        const tsIso = new Date(tsMs).toISOString();
        const bucketStart = toUtcHalfHourStart(tsIso);
        if (!bucketStart) continue;

        const rawModel =
          modelsByAgent.get(agentId) ||
          logModelsByAgent[agentModelKey(agentId)] ||
          fallbackModel;
        const model = normalizeModelInput(rawModel);

        const fingerprint = codebuddyUsageFingerprint({
          model,
          timestampMs: tsMs,
          inputTokens,
          cacheRead,
          cacheCreation,
          outputTokens: completionTokens,
          reasoningTokens,
        });
        if (consumeCodebuddyLogFingerprint(usageFingerprints, fingerprint)) {
          seenIds.add(messageId);
          continue;
        }

        const delta = {
          input_tokens: inputTokens,
          cached_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
          output_tokens: completionTokens,
          reasoning_output_tokens: reasoningTokens,
          total_tokens: inputTokens + completionTokens + cacheRead + cacheCreation + reasoningTokens,
          conversation_count: 1,
        };

        const bucket = getHourlyBucket(hourlyState, "codebuddy", model, bucketStart);
        addTotals(bucket.totals, delta);
        touchedBuckets.add(bucketKey("codebuddy", model, bucketStart));
        seenIds.add(messageId);
        eventsAggregated++;

        if (cb) {
          cb({
            index: fileIdx + 1,
            total: files.length,
            recordsProcessed,
            eventsAggregated,
            bucketsQueued: touchedBuckets.size,
          });
        }
      } else {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== "object") continue;

        // Usage is carried on ANY record with providerData.rawUsage — assistant
        // messages AND function_call records. Each LLM round-trip (whether it
        // ends in a text reply or a tool call) carries its own usage; on real
        // installs function_call records are ~93% of round-trips and ~14x the
        // assistant-message token volume, so filtering by record type drops
        // the majority of usage. Aggregate them all; dedup per round-trip.
        // (Same convention as the WorkBuddy reader — same transcript format.)
        const provider = entry.providerData;
        const rawUsage = provider && typeof provider === "object" ? provider.rawUsage : null;
        if (!rawUsage || typeof rawUsage !== "object") continue;

        const sessionId =
          typeof entry.sessionId === "string" && entry.sessionId
            ? entry.sessionId
            : path.basename(filePath, ".jsonl");
        const tsMs =
          Number.isFinite(Number(entry.timestamp)) && Number(entry.timestamp) > 0
            ? Number(entry.timestamp)
            : null;
        // One usage record per LLM round-trip; providerData.messageId is the
        // response-level id shared by the function_call/message pair of the
        // same round-trip, so it is the most stable dedup key. entry.id is the
        // per-record append id (unique per line, NOT per round-trip) and must
        // NOT be preferred — preferring it would count a round-trip once per
        // record type instead of once total.
        const messageId =
          typeof provider?.messageId === "string" && provider?.messageId
            ? provider.messageId
            : typeof entry.uuid === "string" && entry.uuid
              ? entry.uuid
              : typeof entry.id === "string" && entry.id
                ? entry.id
                : tsMs != null
                  ? `${sessionId}:${tsMs}`
                  : null;
        if (!messageId) continue;
        if (seenIds.has(messageId)) continue;

        recordsProcessed++;

        const promptTokens = toNonNegativeInt(rawUsage.prompt_tokens);
        const completionTokensRaw = toNonNegativeInt(rawUsage.completion_tokens);
        const details =
          rawUsage.prompt_tokens_details && typeof rawUsage.prompt_tokens_details === "object"
            ? rawUsage.prompt_tokens_details
            : {};
        const completionDetails =
          rawUsage.completion_tokens_details && typeof rawUsage.completion_tokens_details === "object"
            ? rawUsage.completion_tokens_details
            : {};
        // Cache-read mirrors three ways depending on upstream: Anthropic-style
        // cache_read_input_tokens, OpenAI-style prompt_tokens_details.cached_tokens,
        // DeepSeek-style prompt_cache_hit_tokens. Take the max (they mirror the
        // same quantity; on real data exactly one is non-zero).
        const cachedTokens = Math.max(
          toNonNegativeInt(details.cached_tokens),
          toNonNegativeInt(rawUsage.prompt_cache_hit_tokens),
        );
        const cacheReadAlt = toNonNegativeInt(rawUsage.cache_read_input_tokens);
        const cacheCreation = Math.max(
          toNonNegativeInt(rawUsage.cache_creation_input_tokens),
          toNonNegativeInt(rawUsage.prompt_cache_write_tokens),
        );
        // reasoning_tokens lives in completion_tokens_details (verified on real
        // CodeBuddy data: prompt_tokens_details.reasoning_tokens is always 0).
        // completion_tokens INCLUDES reasoning, so subtract to avoid double-count.
        const reasoningTokens = Math.min(completionTokensRaw, toNonNegativeInt(completionDetails.reasoning_tokens));
        const completionTokens = Math.max(0, completionTokensRaw - reasoningTokens);

        const cacheRead = Math.max(cachedTokens, cacheReadAlt);
        const inputTokens = Math.max(0, promptTokens - cacheRead - cacheCreation);

        if (
          inputTokens === 0 &&
          completionTokens === 0 &&
          cacheRead === 0 &&
          cacheCreation === 0 &&
          reasoningTokens === 0
        ) {
          seenIds.add(messageId);
          continue;
        }

        if (tsMs == null) {
          seenIds.add(messageId);
          continue;
        }
        const tsIso = new Date(tsMs).toISOString();
        const bucketStart = toUtcHalfHourStart(tsIso);
        if (!bucketStart) continue;

        const model =
          normalizeModelInput(provider?.model) ||
          normalizeModelInput(entry.model) ||
          fallbackModel;

        const fingerprint = codebuddyUsageFingerprint({
          model,
          timestampMs: tsMs,
          inputTokens,
          cacheRead,
          cacheCreation,
          outputTokens: completionTokens,
          reasoningTokens,
        });
        if (addCodebuddyJsonlFingerprint(usageFingerprints, fingerprint)) {
          seenIds.add(messageId);
          continue;
        }

        const delta = {
          input_tokens: inputTokens,
          cached_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
          output_tokens: completionTokens,
          reasoning_output_tokens: reasoningTokens,
          total_tokens:
            inputTokens + completionTokens + cacheRead + cacheCreation + reasoningTokens,
          conversation_count: 1,
        };

        const bucket = getHourlyBucket(hourlyState, "codebuddy", model, bucketStart);
        addTotals(bucket.totals, delta);
        touchedBuckets.add(bucketKey("codebuddy", model, bucketStart));
        seenIds.add(messageId);
        // Preserve the pre-fingerprint cursor key as well. Older releases
        // keyed JSONL rows by entry.id; retaining it prevents the first
        // post-upgrade sync from replaying an already-counted row when
        // providerData.messageId is now preferred.
        if (typeof entry.id === "string" && entry.id && entry.id !== messageId) {
          seenIds.add(entry.id);
        }
        eventsAggregated++;

        if (cb) {
          cb({
            index: fileIdx + 1,
            total: files.length,
            recordsProcessed,
            eventsAggregated,
            bucketsQueued: touchedBuckets.size,
          });
        }
      }
    }

    let postStat = stat;
    try { postStat = fssync.statSync(filePath); } catch {}
    fileOffsets[filePath] = {
      size: postStat.size,
      mtimeMs: postStat.mtimeMs,
      ino: postStat.ino,
    };
  }

  // Cap dedup set to last 10k IDs to bound cursor state size — same convention
  // as Kimi/Copilot so cursors.json doesn't grow unbounded.
  const seenArr = Array.from(seenIds);
  const cappedSeen =
    seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;
  const logModelEntries = Object.entries(logModelsByAgent);
  const cappedLogModelsByAgent =
    logModelEntries.length > 10_000
      ? Object.fromEntries(logModelEntries.slice(logModelEntries.length - 10_000))
      : logModelsByAgent;

  const bucketsQueued = await enqueueTouchedBuckets({
    queuePath,
    hourlyState,
    touchedBuckets,
  });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.codebuddy = {
    ...codebuddyState,
    seenIds: cappedSeen,
    fileOffsets,
    logModelsByAgent: cappedLogModelsByAgent,
    usageFingerprints: capCodebuddyUsageFingerprints(usageFingerprints),
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkBuddy — passive JSONL reader (~/.workbuddy/projects/<cwd>/**/*.jsonl)
//
// Tencent's WorkBuddy is a Claude-Code fork in the same "buddy" family as
// CodeBuddy, but it differs from CodeBuddy's reader in three load-bearing ways
// (each verified against real ~/.workbuddy logs, NOT assumed from CodeBuddy):
//
//   1. Usage lives on `function_call` records too — not only on
//      `type=="message" and role=="assistant"`. Each LLM round-trip (whether it
//      ends in a tool call or a text reply) carries its own providerData.rawUsage.
//      We therefore aggregate EVERY record that has providerData.rawUsage and
//      dedup per response id, instead of filtering by record type.
//
//   2. Sub-agent traffic is nested two levels deeper:
//        ~/.workbuddy/projects/<cwd>/<sessionId>.jsonl                  (main)
//        ~/.workbuddy/projects/<cwd>/<sessionId>/subagents/agent-*.jsonl (sub)
//      CodeBuddy's resolver only globs the top level, so we recurse to pick up
//      sub-agent usage (tool-results/*.txt are naturally skipped — not .jsonl).
//
//   3. rawUsage is OpenAI/DeepSeek-shaped and prompt_tokens is the FULL prompt
//      (cache reads + cache writes + genuinely-new input). The cache split is
//      mirrored two ways depending on which upstream the auto-router picked:
//        • Anthropic-style: cache_read_input_tokens / cache_creation_input_tokens
//        • DeepSeek/OpenAI-style: prompt_tokens_details.cached_tokens /
//          prompt_cache_hit_tokens  (cache_creation_input_tokens then 0)
//      Reasoning is reported inside completion_tokens (verified:
//      rawUsage.total_tokens === prompt_tokens + completion_tokens).
//
//   Token math (matches the repo's queue convention; subtract BOTH cache reads
//   AND cache writes from prompt_tokens — CodeBuddy's "prompt_tokens - cacheRead"
//   only works because its cache_creation is always 0; WorkBuddy writes cache
//   heavily, so the naive formula double-counts cache writes ~2x):
//     cacheRead   = max(cache_read_input_tokens, prompt_tokens_details.cached_tokens,
//                       prompt_cache_hit_tokens)
//     cacheCreate = cache_creation_input_tokens
//     input_tokens               = prompt_tokens - cacheRead - cacheCreate
//     cached_input_tokens        = cacheRead
//     cache_creation_input_tokens = cacheCreate
//     reasoning_output_tokens    = completion_tokens_details.reasoning_tokens
//     output_tokens              = completion_tokens - reasoning_output_tokens
//     total_tokens               = sum of the above (== prompt_tokens + completion_tokens)
//
//   model is the auto-router placeholder ("auto") — WorkBuddy does not expose
//   the underlying model in the log, so we emit it verbatim.
//
//   4. Completed ~/.workbuddy/traces/**/trace_*.json summaries expose aggregate
//      modelInfo input/output/cache totals. They are a fallback only when the
//      session has no detailed JSONL usage. The current SQLite session_usage
//      table exposes bounded context-window state (`used`/`size`) plus credits,
//      not billable token columns, so SQLite-only rows are ignored rather than
//      mislabelled as input usage. A future schema with explicit token columns
//      is accepted by workbuddySqliteUsageSnapshot.
// ─────────────────────────────────────────────────────────────────────────────

function resolveWorkbuddyHome(env = process.env) {
  const home = env.HOME || require("node:os").homedir();
  if (env.WORKBUDDY_HOME) return env.WORKBUDDY_HOME;
  if (process.platform === "win32") {
    return pickWin32ProviderPath({
      env,
      nativeValue: path.join(home, ".workbuddy"),
      wslProviderDir: ".workbuddy",
    });
  }
  return path.join(home, ".workbuddy");
}

function resolveWorkbuddyDefaultModel(env = process.env) {
  const fallback = "auto";
  try {
    const workbuddyHome = resolveWorkbuddyHome(env);
    if (!workbuddyHome) return fallback;
    const settingsPath = path.join(workbuddyHome, "settings.json");
    const raw = fssync.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.model === "string" && parsed.model.trim()) {
      return parsed.model.trim();
    }
  } catch (_e) {
    // settings missing or malformed — fall through
  }
  return fallback;
}

// Recursively collect every *.jsonl under ~/.workbuddy/projects so that
// per-session conversation logs AND their nested subagents/agent-*.jsonl files
// are both discovered. WorkBuddy also writes completed trace summaries under
// ~/.workbuddy/traces/<pid>/trace_*.json. Those summaries are useful only when
// the detailed JSONL for a session is absent, so they are returned as typed
// entries and parsed after JSONL (JSONL remains authoritative when both exist).
function resolveWorkbuddyProjectFiles(env = process.env) {
  const workbuddyHome = resolveWorkbuddyHome(env);
  if (!workbuddyHome) return [];
  const projectsDir = path.join(workbuddyHome, "projects");
  const files = [];
  const walkJsonl = (dir) => {
    let entries;
    try { entries = fssync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      // Resolve symlinks defensively (Dirent flags are false for symlinks).
      if (!isDir && !isFile) {
        try {
          const st = fssync.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch { continue; }
      }
      if (isDir) walkJsonl(full);
      else if (isFile && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  if (fssync.existsSync(projectsDir)) walkJsonl(projectsDir);

  const tracesDir = path.join(workbuddyHome, "traces");
  const walkTraces = (dir) => {
    let entries;
    try { entries = fssync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (!isDir && !isFile) {
        try {
          const st = fssync.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch { continue; }
      }
      if (isDir) walkTraces(full);
      else if (isFile && /^trace_[^/]+\.json$/i.test(entry.name)) {
        files.push({ path: full, kind: "trace" });
      }
    }
  };
  if (fssync.existsSync(tracesDir)) walkTraces(tracesDir);
  files.sort((a, b) => {
    const aPath = typeof a === "string" ? a : a?.path || "";
    const bPath = typeof b === "string" ? b : b?.path || "";
    // JSONL first is intentional: trace summaries are a lossy fallback and
    // must not win over a detailed rawUsage record on the same session.
    const aKind = typeof a === "string" ? 0 : 1;
    const bKind = typeof b === "string" ? 0 : 1;
    return aKind - bKind || aPath.localeCompare(bPath);
  });
  return files;
}

// WorkBuddy's current session_usage table stores context-window state in
// `used`/`size` and model credit dollars in `credit_json`; neither is a token
// accounting breakdown. Only consume a SQLite row when a future schema (or a
// newer installation) exposes explicit cumulative token columns. This keeps
// the fallback forward-compatible without treating a context snapshot as
// billable usage.
function workbuddySqliteUsageSnapshot(row) {
  if (!row || typeof row !== "object") return null;
  const hasAny = (keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(row, key));
  const inputKeys = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"];
  const cacheReadKeys = [
    "cached_input_tokens",
    "cachedInputTokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
    "cacheReadTokens",
  ];
  const cacheCreationKeys = [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "prompt_cache_write_tokens",
    "promptCacheWriteTokens",
  ];
  const outputKeys = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"];
  const reasoningKeys = [
    "reasoning_output_tokens",
    "reasoningOutputTokens",
    "reasoning_tokens",
    "reasoningTokens",
  ];
  if (!hasAny([...inputKeys, ...cacheReadKeys, ...cacheCreationKeys, ...outputKeys, ...reasoningKeys])) {
    return null;
  }
  return {
    input: firstPresentNonNegativeInt(inputKeys.map((key) => row[key])),
    cacheRead: firstPresentNonNegativeInt(cacheReadKeys.map((key) => row[key])),
    cacheCreation: firstPresentNonNegativeInt(cacheCreationKeys.map((key) => row[key])),
    output: firstPresentNonNegativeInt(outputKeys.map((key) => row[key])),
    reasoning: firstPresentNonNegativeInt(reasoningKeys.map((key) => row[key])),
  };
}

async function parseWorkbuddyIncremental({
  projectFiles,
  cursors,
  queuePath,
  onProgress,
  env,
  defaultModel,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const workbuddyState =
    cursors.workbuddy && typeof cursors.workbuddy === "object" ? cursors.workbuddy : {};
  const seenIds = new Set(
    Array.isArray(workbuddyState.seenIds) ? workbuddyState.seenIds : [],
  );
  const fileOffsets =
    workbuddyState.fileOffsets && typeof workbuddyState.fileOffsets === "object"
      ? { ...workbuddyState.fileOffsets }
      : {};
  const sqliteSessions =
    workbuddyState.sqliteSessions && typeof workbuddyState.sqliteSessions === "object"
      ? { ...workbuddyState.sqliteSessions }
      : {};
  const detailedSessions =
    workbuddyState.detailedSessions && typeof workbuddyState.detailedSessions === "object"
      ? { ...workbuddyState.detailedSessions }
      : {};
  const seenTraceIds = new Set(
    Array.isArray(workbuddyState.seenTraceIds) ? workbuddyState.seenTraceIds : [],
  );
  const tracedSessionIds = new Set(
    Array.isArray(workbuddyState.tracedSessionIds) ? workbuddyState.tracedSessionIds : [],
  );
  const detailedSessionsWithUsage = new Set();

  const allFiles = Array.isArray(projectFiles)
    ? projectFiles
    : resolveWorkbuddyProjectFiles(env || process.env);
  const jsonlFiles = allFiles.filter((entry) => typeof entry === "string");
  const traceFiles = allFiles.filter(
    (entry) => entry && typeof entry === "object" && typeof entry.path === "string" && entry.kind === "trace",
  );
  const files = [...jsonlFiles, ...traceFiles];
  const fallbackModel = defaultModel || resolveWorkbuddyDefaultModel(env || process.env);

  const workbuddyHome = resolveWorkbuddyHome(env || process.env);
  const dbPath = workbuddyHome ? path.join(workbuddyHome, "workbuddy.db") : null;
  const dbExists = Boolean(dbPath && fssync.existsSync(dbPath));

  if (files.length === 0 && !dbExists) {
    cursors.workbuddy = {
      ...workbuddyState,
      seenIds: Array.from(seenIds),
      seenTraceIds: Array.from(seenTraceIds),
      tracedSessionIds: Array.from(tracedSessionIds),
      fileOffsets,
      sqliteSessions,
      detailedSessions,
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < jsonlFiles.length; fileIdx++) {
    const filePath = jsonlFiles[fileIdx];
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    // Re-read from start if file shrunk (truncate/rewrite) or inode changed
    // (file deleted + recreated). Otherwise pick up after the last read offset.
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    if (stat.size <= startOffset) continue;

    let stream;
    try {
      stream = fssync.createReadStream(filePath, {
        encoding: "utf8",
        start: startOffset,
      });
    } catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== "object") continue;

      // Usage is carried on ANY record with providerData.rawUsage — assistant
      // messages AND function_call records. Aggregate them all; dedup per id.
      const provider = entry.providerData;
      const rawUsage = provider && typeof provider === "object" ? provider.rawUsage : null;
      if (!rawUsage || typeof rawUsage !== "object") continue;

      const sessionId =
        typeof entry.sessionId === "string" && entry.sessionId
          ? entry.sessionId
          : path.basename(filePath, ".jsonl");
      const sqliteSession = sqliteSessions[sessionId];
      if (sqliteSession?.detailed || tracedSessionIds.has(sessionId)) {
        continue;
      }
      const tsMs =
        Number.isFinite(Number(entry.timestamp)) && Number(entry.timestamp) > 0
          ? Number(entry.timestamp)
          : null;
      // One usage record per LLM round-trip; providerData.messageId is the
      // response-level id shared by function_call/message records and must win
      // over the per-record append id. Fall back to entry.uuid/id only when the
      // response-level id is absent.
      const messageId =
        typeof provider?.messageId === "string" && provider.messageId
            ? provider.messageId
            : typeof entry.uuid === "string" && entry.uuid
              ? entry.uuid
              : typeof entry.id === "string" && entry.id
                ? entry.id
                : tsMs != null
                  ? `${sessionId}:${tsMs}`
                  : null;
      if (!messageId) continue;
      if (seenIds.has(messageId)) continue;

      recordsProcessed++;

      const promptTokens = toNonNegativeInt(rawUsage.prompt_tokens);
      const completionTokens = toNonNegativeInt(rawUsage.completion_tokens);
      const promptDetails =
        rawUsage.prompt_tokens_details && typeof rawUsage.prompt_tokens_details === "object"
          ? rawUsage.prompt_tokens_details
          : {};
      const completionDetails =
        rawUsage.completion_tokens_details && typeof rawUsage.completion_tokens_details === "object"
          ? rawUsage.completion_tokens_details
          : {};

      // Cache reads are mirrored across up to three fields depending on which
      // upstream the auto-router used; take the largest non-zero mirror.
      const cacheRead = Math.max(
        toNonNegativeInt(rawUsage.cache_read_input_tokens),
        toNonNegativeInt(promptDetails.cached_tokens),
        toNonNegativeInt(rawUsage.prompt_cache_hit_tokens),
      );
      const cacheCreation = toNonNegativeInt(rawUsage.cache_creation_input_tokens);
      // prompt_tokens is the FULL prompt: subtract BOTH reads and writes so
      // input_tokens is pure non-cached input (no double-counting cache writes).
      const inputTokens = Math.max(0, promptTokens - cacheRead - cacheCreation);
      // completion_tokens INCLUDES reasoning (verified: total == prompt+completion).
      const reasoningTokens = Math.min(completionTokens, toNonNegativeInt(completionDetails.reasoning_tokens));
      const outputTokens = Math.max(0, completionTokens - reasoningTokens);

      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheRead === 0 &&
        cacheCreation === 0 &&
        reasoningTokens === 0
      ) {
        seenIds.add(messageId);
        continue;
      }

      if (tsMs == null) {
        seenIds.add(messageId);
        continue;
      }
      const tsIso = new Date(tsMs).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const model =
        normalizeModelInput(provider.model) ||
        normalizeModelInput(provider.requestModelId) ||
        normalizeModelInput(entry.model) ||
        fallbackModel;

      const delta = {
        input_tokens: inputTokens,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: outputTokens,
        reasoning_output_tokens: reasoningTokens,
        total_tokens:
          inputTokens + outputTokens + cacheRead + cacheCreation + reasoningTokens,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, "workbuddy", model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("workbuddy", model, bucketStart));
      seenIds.add(messageId);
      // Keep legacy entry-id keys alongside the response id so upgrading a
      // cursor cannot replay a row that an older build already counted.
      if (typeof entry.id === "string" && entry.id && entry.id !== messageId) {
        seenIds.add(entry.id);
      }
      detailedSessions[sessionId] = true;
      detailedSessionsWithUsage.add(sessionId);
      eventsAggregated++;

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: files.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    let postStat = stat;
    try { postStat = fssync.statSync(filePath); } catch {}
    fileOffsets[filePath] = {
      size: postStat.size,
      mtimeMs: postStat.mtimeMs,
      ino: postStat.ino,
    };
  }

  // Trace summaries are a fallback for sessions whose JSONL has no detailed
  // providerData.rawUsage. A trace's modelInfo totals include the cache read
  // portion of input, so split input into uncached input + cached input. Do
  // not merge a trace with the same session's JSONL (or SQLite) data: the
  // JSONL path has per-round detail and the trace summary can be partial on
  // older WorkBuddy versions.
  for (let fileIdx = 0; fileIdx < traceFiles.length; fileIdx++) {
    const entry = traceFiles[fileIdx];
    const filePath = entry.path;
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }
    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    if (stat.size <= startOffset) continue;

    let traceDoc;
    try {
      traceDoc = JSON.parse(fssync.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    const trace = traceDoc && typeof traceDoc === "object" && traceDoc.trace && typeof traceDoc.trace === "object"
      ? traceDoc.trace
      : null;
    const traceId = typeof trace?.traceId === "string" && trace.traceId
      ? trace.traceId
      : path.basename(filePath, ".json");
    const metadata = trace?.metadata && typeof trace.metadata === "object" ? trace.metadata : {};
    const modelInfo = trace?.modelInfo && typeof trace.modelInfo === "object"
      ? trace.modelInfo
      : metadata.modelInfo && typeof metadata.modelInfo === "object"
        ? metadata.modelInfo
        : {};
    const sessionId =
      (typeof trace?.sessionId === "string" && trace.sessionId) ||
      (typeof metadata.sessionId === "string" && metadata.sessionId) ||
      traceId;
    const startedAtRaw = trace?.startedAt || metadata.startedAt;
    const tsMs = typeof startedAtRaw === "number" && Number.isFinite(startedAtRaw)
      ? (startedAtRaw > 10000000000 ? startedAtRaw : startedAtRaw * 1000)
      : Date.parse(String(startedAtRaw || ""));
    const totalInput = toNonNegativeInt(modelInfo.totalInputTokens);
    const totalOutput = toNonNegativeInt(modelInfo.totalOutputTokens);
    const totalCached = Math.min(totalInput, toNonNegativeInt(modelInfo.totalCachedTokens));
    if (seenTraceIds.has(traceId) || detailedSessions[sessionId] || detailedSessionsWithUsage.has(sessionId) || tracedSessionIds.has(sessionId)) {
      seenTraceIds.add(traceId);
      fileOffsets[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
      continue;
    }
    if (!Number.isFinite(tsMs) || tsMs <= 0 || (totalInput <= 0 && totalOutput <= 0)) {
      // Keep the file offset but do not permanently suppress a trace that may
      // still be finalized in place by WorkBuddy.
      fileOffsets[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
      continue;
    }

    const bucketStart = toUtcHalfHourStart(new Date(tsMs).toISOString());
    if (!bucketStart) continue;
    const model =
      normalizeModelInput(Array.isArray(modelInfo.models) ? modelInfo.models[0] : modelInfo.model) ||
      fallbackModel;
    const inputTokens = Math.max(0, totalInput - totalCached);
    const delta = {
      input_tokens: inputTokens,
      cached_input_tokens: totalCached,
      cache_creation_input_tokens: 0,
      output_tokens: totalOutput,
      reasoning_output_tokens: 0,
      total_tokens: inputTokens + totalCached + totalOutput,
      conversation_count: 1,
    };
    const bucket = getHourlyBucket(hourlyState, "workbuddy", model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey("workbuddy", model, bucketStart));
    seenTraceIds.add(traceId);
    tracedSessionIds.add(sessionId);
    recordsProcessed++;
    eventsAggregated++;
    fileOffsets[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    if (cb) {
      cb({
        index: jsonlFiles.length + fileIdx + 1,
        total: files.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  if (dbExists) {
    const query = `
      SELECT
        su.*,
        s.model AS session_model,
        s.cwd AS session_cwd
      FROM session_usage su
      LEFT JOIN sessions s ON s.id = su.session_id
      WHERE su.used IS NOT NULL
        AND su.used > 0
        AND su.updated_at IS NOT NULL
        AND su.updated_at > 0
    `.trim();
    let rows = [];
    const snap = snapshotSqliteDb(dbPath);
    try {
      rows = await readSqliteJsonRowsAsync(snap.path, query, {
        label: "WorkBuddy",
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } finally {
      snap.cleanup();
    }

    try {
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const sessionId = typeof row.session_id === "string" ? row.session_id.trim() : "";
        if (!sessionId) continue;
        if (
          detailedSessions[sessionId] ||
          detailedSessionsWithUsage.has(sessionId) ||
          tracedSessionIds.has(sessionId)
        ) continue;

        const updatedAtRaw = toNonNegativeInt(row.updated_at);
        const rawModel = typeof row.session_model === "string"
          ? row.session_model.trim()
          : typeof row.model === "string" ? row.model.trim() : "";

        if (updatedAtRaw <= 0) continue;

        const snapshot = workbuddySqliteUsageSnapshot(row);
        const usedNow = toNonNegativeInt(row.used);
        const prev = sqliteSessions[sessionId] || {};

        // Current WorkBuddy releases expose only context state (`used` versus
        // `size`) here. Do not turn that bounded snapshot into a fake usage
        // delta; detailed JSONL/trace sources remain the authoritative path.
        if (!snapshot) {
          sqliteSessions[sessionId] = {
            ...prev,
            used: usedNow,
            updatedAt: updatedAtRaw,
            model: rawModel || prev.model || fallbackModel,
            detailed: false,
          };
          continue;
        }

        const previousTokens = prev.tokens && typeof prev.tokens === "object"
          ? prev.tokens
          : { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, reasoning: 0 };
        const isReset = ["input", "cacheRead", "cacheCreation", "output", "reasoning"]
          .some((key) => snapshot[key] < toNonNegativeInt(previousTokens[key]));
        const deltaTokens = {
          input: isReset ? snapshot.input : Math.max(0, snapshot.input - toNonNegativeInt(previousTokens.input)),
          cacheRead: isReset ? snapshot.cacheRead : Math.max(0, snapshot.cacheRead - toNonNegativeInt(previousTokens.cacheRead)),
          cacheCreation: isReset ? snapshot.cacheCreation : Math.max(0, snapshot.cacheCreation - toNonNegativeInt(previousTokens.cacheCreation)),
          output: isReset ? snapshot.output : Math.max(0, snapshot.output - toNonNegativeInt(previousTokens.output)),
          reasoning: isReset ? snapshot.reasoning : Math.max(0, snapshot.reasoning - toNonNegativeInt(previousTokens.reasoning)),
        };
        if (
          deltaTokens.input === 0 &&
          deltaTokens.cacheRead === 0 &&
          deltaTokens.cacheCreation === 0 &&
          deltaTokens.output === 0 &&
          deltaTokens.reasoning === 0
        ) {
          sqliteSessions[sessionId] = {
            ...prev,
            used: usedNow,
            updatedAt: updatedAtRaw,
            model: rawModel || prev.model || fallbackModel,
            tokens: snapshot,
            detailed: true,
          };
          continue;
        }

        recordsProcessed++;

        const inputTokens = deltaTokens.input;
        const completionTokens = deltaTokens.output;
        const cacheRead = deltaTokens.cacheRead;
        const cacheCreation = deltaTokens.cacheCreation;
        const reasoningTokens = deltaTokens.reasoning;

        const tsMs = updatedAtRaw > 10000000000 ? updatedAtRaw : updatedAtRaw * 1000;
        const tsIso = new Date(tsMs).toISOString();
        const bucketStart = toUtcHalfHourStart(tsIso);
        if (!bucketStart) continue;

        const model = normalizeModelInput(rawModel) || fallbackModel;

        const delta = {
          input_tokens: inputTokens,
          cached_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
          output_tokens: completionTokens,
          reasoning_output_tokens: reasoningTokens,
        total_tokens: inputTokens + completionTokens + cacheRead + cacheCreation + reasoningTokens,
          conversation_count: Object.keys(previousTokens).every((key) => toNonNegativeInt(previousTokens[key]) === 0) || isReset ? 1 : 0,
        };

        const bucket = getHourlyBucket(hourlyState, "workbuddy", model, bucketStart);
        addTotals(bucket.totals, delta);
        touchedBuckets.add(bucketKey("workbuddy", model, bucketStart));
        sqliteSessions[sessionId] = {
          used: usedNow,
          updatedAt: updatedAtRaw,
          model,
          tokens: snapshot,
          detailed: true,
        };
        eventsAggregated++;
      }
    } catch (err) {
      // SQLite fallback is best effort; detailed JSONL remains authoritative.
    }
  }

  // Cap dedup set to last 10k IDs to bound cursor state size — same convention
  // as CodeBuddy/Kimi/Copilot so cursors.json doesn't grow unbounded.
  const seenArr = Array.from(seenIds);
  const cappedSeen =
    seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;
  const sqliteSessionEntries = Object.entries(sqliteSessions);
  const cappedSqliteSessions =
    sqliteSessionEntries.length > 10_000
      ? Object.fromEntries(
          sqliteSessionEntries
            .sort((a, b) => toNonNegativeInt(b[1]?.used) - toNonNegativeInt(a[1]?.used))
            .slice(0, 10_000),
        )
      : sqliteSessions;
  const detailedSessionEntries = Object.entries(detailedSessions);
  const cappedDetailedSessions =
    detailedSessionEntries.length > 10_000
      ? Object.fromEntries(detailedSessionEntries.slice(detailedSessionEntries.length - 10_000))
      : detailedSessions;
  const traceArr = Array.from(seenTraceIds);
  const cappedSeenTraceIds =
    traceArr.length > 10_000 ? traceArr.slice(traceArr.length - 10_000) : traceArr;
  const tracedSessionArr = Array.from(tracedSessionIds);
  const cappedTracedSessionIds =
    tracedSessionArr.length > 10_000
      ? tracedSessionArr.slice(tracedSessionArr.length - 10_000)
      : tracedSessionArr;

  const bucketsQueued = await enqueueTouchedBuckets({
    queuePath,
    hourlyState,
    touchedBuckets,
  });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.workbuddy = {
    ...workbuddyState,
    seenIds: cappedSeen,
    seenTraceIds: cappedSeenTraceIds,
    tracedSessionIds: cappedTracedSessionIds,
    fileOffsets,
    sqliteSessions: cappedSqliteSessions,
    detailedSessions: cappedDetailedSessions,
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// oh-my-pi (omp) — passive JSONL reader (~/.omp/agent/sessions/**/*.jsonl)
//
// oh-my-pi writes one append-only JSONL per session:
//   ~/.omp/agent/sessions/--<cwd-encoded>--/<timestamp>_<sessionId>.jsonl
// Task subagents spawned by that session get their own JSONL files nested in
// a sibling directory named after the session file (see
// resolveOmpSubagentFiles); their usage counts toward the same "omp" totals.
//
// Per-line record types: the first line is type:"session" (header).
// Only type:"message" lines with message.role=="assistant" carry token usage.
// The shape (verbatim from oh-my-pi docs/session.md):
//
//   {
//     "type": "message",
//     "id": "a1b2c3d4",          ← 8-char dedup key
//     "parentId": "...",
//     "timestamp": "2026-02-16T10:21:00.000Z",
//     "message": {
//       "role": "assistant",
//       "provider": "anthropic",
//       "model": "claude-sonnet-4-5",
//       "usage": {
//         "input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0,
//         "totalTokens": 120, "reasoningTokens": 0
//       },
//       "timestamp": 1760000000000   ← ms epoch, preferred for bucketing
//     }
//   }
//
// oh-my-pi is a router — dispatches to upstream providers (Anthropic, OpenAI,
// etc.) and records the upstream model name per message. There is no global
// default model setting; model is always per-message (fallback: "omp-unknown").
// ─────────────────────────────────────────────────────────────────────────────

function resolveOmpHome(env = process.env) {
  const home = env.HOME || require("node:os").homedir();
  // Honor TokenTracker override first, then oh-my-pi upstream env vars.
  if (env.OMP_HOME) return env.OMP_HOME;
  if (env.PI_CONFIG_DIR) return path.join(home, env.PI_CONFIG_DIR);
  if (process.platform === "win32") {
    return pickWin32ProviderPath({
      env,
      nativeValue: path.join(home, ".omp"),
      wslProviderDir: ".omp",
    });
  }
  return path.join(home, ".omp");
}

// PI_CODING_AGENT_DIR is documented by both pi-coding-agent and oh-my-pi as
// their agent directory override. When set, attribute it to whichever tool the
// user actually has installed: ~/.pi present → "pi", otherwise "omp" (the
// historical default in this codebase, preserved for back-compat).
//
// Users with both tools installed can disambiguate explicitly with
// TOKENTRACKER_PI_AGENT_DIR / TOKENTRACKER_OMP_AGENT_DIR, which take
// precedence in their respective resolvers.
function decidePiCodingAgentDirOwner(env = process.env) {
  const home = env.HOME || require("node:os").homedir();
  // Require an actual directory — a stray file (lockfile, junk) at ~/.pi
  // shouldn't reroute an existing oh-my-pi user's PI_CODING_AGENT_DIR override.
  try {
    if (fssync.statSync(path.join(home, ".pi")).isDirectory()) return "pi";
  } catch {
    // ENOENT or EACCES — treat as "no pi install signal".
  }
  return "omp";
}

function expandHomePath(dir, env = process.env) {
  if (typeof dir !== "string" || !dir) return dir;
  if (dir !== "~" && !dir.startsWith("~/")) return dir;
  const home = env.HOME || require("node:os").homedir();
  return dir === "~" ? home : path.join(home, dir.slice(2));
}

function resolveOmpAgentDir(env = process.env) {
  if (env.TOKENTRACKER_OMP_AGENT_DIR) {
    return expandHomePath(env.TOKENTRACKER_OMP_AGENT_DIR, env);
  }
  if (env.PI_CODING_AGENT_DIR && decidePiCodingAgentDirOwner(env) === "omp") {
    return expandHomePath(env.PI_CODING_AGENT_DIR, env);
  }
  const ompHome = resolveOmpHome(env);
  return ompHome ? path.join(ompHome, "agent") : null;
}

function resolveOmpSessionFiles(env = process.env) {
  const agentDir = resolveOmpAgentDir(env);
  if (!agentDir) return [];
  const sessionsDir = path.join(agentDir, "sessions");
  if (!fssync.existsSync(sessionsDir)) return [];
  const files = [];
  try {
    for (const cwdDir of fssync.readdirSync(sessionsDir)) {
      const cwdPath = path.join(sessionsDir, cwdDir);
      let stat;
      try { stat = fssync.statSync(cwdPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let entries;
      try { entries = fssync.readdirSync(cwdPath); } catch { continue; }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        files.push(path.join(cwdPath, entry));
      }
    }
  } catch {
    // ignore — return what we have
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

// Subagent transcripts live in a directory named after the session file:
//   ~/.omp/agent/sessions/<cwd>/<session>.jsonl            (main agent)
//   ~/.omp/agent/sessions/<cwd>/<session>/<Agent>.jsonl    (task subagent)
//   ~/.omp/agent/sessions/<cwd>/<session>/<sub>/<A>.jsonl  (nested advisor)
// oh-my-pi's own stats indexer classifies by depth (packages/stats/parser.ts:
// rel path <= 2 segments → main, deeper → subagent/advisor), so we mirror
// that: everything below the cwd level is subagent traffic. Session dirs also
// hold non-JSONL artefacts (*.bash-original.log, *.md) — skipped by extension.
function resolveOmpSubagentFiles(env = process.env) {
  const agentDir = resolveOmpAgentDir(env);
  if (!agentDir) return [];
  const sessionsDir = path.join(agentDir, "sessions");
  if (!fssync.existsSync(sessionsDir)) return [];
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fssync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      // Resolve symlinks defensively (Dirent flags are false for symlinks).
      if (!isDir && !isFile) {
        try {
          const st = fssync.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch { continue; }
      }
      if (isDir) walk(full);
      else if (isFile && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  try {
    for (const cwdDir of fssync.readdirSync(sessionsDir)) {
      const cwdPath = path.join(sessionsDir, cwdDir);
      let stat;
      try { stat = fssync.statSync(cwdPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let entries;
      try { entries = fssync.readdirSync(cwdPath, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(cwdPath, entry.name);
        let isDir = entry.isDirectory();
        if (!isDir && !entry.isFile()) {
          try { isDir = fssync.statSync(full).isDirectory(); } catch { continue; }
        }
        if (isDir) walk(full);
      }
    }
  } catch {
    // ignore — return what we have
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function resolveOmpDefaultModel() {
  // oh-my-pi has no global default model setting; model is per-message.
  return "omp-unknown";
}

const OMP_HEADER_SCAN_MAX_BYTES = 65536;

async function resolveOmpFileCwd(filePath) {
  let stream;
  try {
    stream = fssync.createReadStream(filePath, {
      encoding: "utf8",
      start: 0,
      end: OMP_HEADER_SCAN_MAX_BYTES,
    });
  } catch {
    return null;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || !line.includes('"session"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== "session") continue;
      return typeof entry.cwd === "string" && entry.cwd.trim() ? entry.cwd.trim() : null;
    }
  } finally {
    rl.close();
    stream.close?.();
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kilo Code VS Code extension — passive reader for VS Code-family
// globalStorage/kilocode.kilo-code/tasks/<uuid>/ui_messages.json files.
//
// Each task folder contains a ui_messages.json (JSON array, not JSONL). Token
// usage records are messages where `say == "api_req_started"`; the `text`
// field is a JSON-stringified payload:
//
//   {
//     "apiProtocol":    "openai" | "anthropic" | ...,
//     "tokensIn":       28673,    // request input (already excludes cache)
//     "tokensOut":      31,       // completion
//     "cacheWrites":    0,
//     "cacheReads":     5120,
//     "cost":           0,
//     "usageMissing":   false,
//     "inferenceProvider": "Moonshot AI" | "minimax" | ...,
//   }
//
// We scan every supported VS Code-family install (Cursor, Code, CodeBuddy,
// Windsurf, …) under both Library/Application Support (macOS) and Linux/Win
// equivalents. Files are small (median ~30KB) and rewritten on each turn — we
// can't byte-tail them, so we read the whole file on every sync and dedupe by
// (taskId, ts). Per-file mtime caching skips unchanged files.
// ─────────────────────────────────────────────────────────────────────────────

function resolveKilocodeRoots(env = process.env) {
  if (typeof env.TOKENTRACKER_KILOCODE_ROOTS === "string" && env.TOKENTRACKER_KILOCODE_ROOTS.trim()) {
    return env.TOKENTRACKER_KILOCODE_ROOTS.split(":")
      .map((r) => r.trim())
      .filter(Boolean);
  }
  const home = env.HOME || require("node:os").homedir();
  const candidates = [];
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    candidates.push(
      path.join(base, "Code"),
      path.join(base, "Code - Insiders"),
      path.join(base, "Cursor"),
      path.join(base, "CodeBuddy"),
      path.join(base, "Windsurf"),
      path.join(base, "VSCodium"),
      path.join(base, "Trae"),
      path.join(base, "Trae CN"),
    );
  } else if (process.platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    const nativeRoots = [
      path.join(appData, "Code"),
      path.join(appData, "Code - Insiders"),
      path.join(appData, "Cursor"),
      path.join(appData, "CodeBuddy"),
      path.join(appData, "Windsurf"),
      path.join(appData, "VSCodium"),
    ];
    const wslRoots = [];
    if (wsl.shouldProbeWsl(env)) {
      for (const ide of ["Code", "Code - Insiders", "Cursor", "CodeBuddy", "Windsurf", "VSCodium"]) {
        const wslDir = wsl.discoverWslHome(`.config/${ide}`, { env });
        if (wslDir) wslRoots.push(wslDir);
      }
    }
    const nativeCandidates = wsl.shouldProbeNative(env) ? nativeRoots : [];
    const mode = wsl.getWslMode(env);
    if (mode === "native-first" || mode === "native-only") {
      candidates.push(...nativeCandidates, ...wslRoots);
    } else {
      candidates.push(...wslRoots, ...nativeCandidates);
    }
  } else {
    const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
    candidates.push(
      path.join(xdg, "Code"),
      path.join(xdg, "Code - Insiders"),
      path.join(xdg, "Cursor"),
      path.join(xdg, "CodeBuddy"),
      path.join(xdg, "Windsurf"),
      path.join(xdg, "VSCodium"),
    );
  }
  return candidates;
}

function resolveKilocodeTaskFiles(env = process.env) {
  const roots = resolveKilocodeRoots(env);
  const out = [];
  for (const root of roots) {
    const tasksDir = path.join(root, "User", "globalStorage", "kilocode.kilo-code", "tasks");
    if (!fssync.existsSync(tasksDir)) continue;
    let entries;
    try { entries = fssync.readdirSync(tasksDir); } catch { continue; }
    for (const taskUuid of entries) {
      const filePath = path.join(tasksDir, taskUuid, "ui_messages.json");
      if (!fssync.existsSync(filePath)) continue;
      out.push({ filePath, taskUuid, ide: path.basename(root) });
    }
  }
  out.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return out;
}

// Kilo Code only persists the inference provider (e.g. "minimax",
// "Moonshot AI", "Stealth") in ui_messages.json — the actual model id is
// stored in workspace state but isn't attributed to individual turns and may
// change across sessions, so we cannot map a row back to a model id reliably.
// We surface the provider explicitly so the dashboard's Model column doesn't
// imply this is a model.
function normalizeKilocodeProviderToModel(providerName) {
  if (typeof providerName !== "string" || !providerName.trim()) return "provider:unknown";
  const slug = providerName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
  // A slug consisting only of separators (dashes/dots/underscores) carries no
  // information — treat it as unknown.
  if (!slug || !/[a-z0-9]/.test(slug)) return "provider:unknown";
  return `provider:${slug}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Roo Code (rooveterinaryinc.roo-cline)
//
// Same Cline-derived ui_messages.json format as Kilo Code, but two real
// differences worth noting:
//
//   1. The model name is NOT in the per-turn payload (Roo Code only writes
//      provider via `apiProtocol`). It lives in a sibling
//      `api_conversation_history.json` inside `<environment_details>` blocks:
//
//          <environment_details>
//          <model>claude-3-7-sonnet-20250219</model>
//          </environment_details>
//
//      We read the most recent occurrence — Roo can switch models mid-task,
//      so the last-seen value is the most accurate attribution; if the file
//      or tag is missing we fall back to `protocol:<apiProtocol>` (e.g.
//      `protocol:anthropic`) and finally to "unknown".
//
//   2. Same multi-IDE root scan as Kilo Code (Cursor, Code, CodeBuddy, …) —
//      we reuse resolveKilocodeRoots so both parsers stay in sync when a new
//      VS Code fork ships.
// ─────────────────────────────────────────────────────────────────────────────

function resolveRoocodeTaskFiles(env = process.env) {
  const roots = resolveKilocodeRoots(env);
  const out = [];
  for (const root of roots) {
    const tasksDir = path.join(root, "User", "globalStorage", "rooveterinaryinc.roo-cline", "tasks");
    if (!fssync.existsSync(tasksDir)) continue;
    let entries;
    try { entries = fssync.readdirSync(tasksDir); } catch { continue; }
    for (const taskUuid of entries) {
      const filePath = path.join(tasksDir, taskUuid, "ui_messages.json");
      if (!fssync.existsSync(filePath)) continue;
      out.push({ filePath, taskUuid, ide: path.basename(root) });
    }
  }
  out.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return out;
}

// Pull the most recent <model>…</model> from a Roo Code task's
// api_conversation_history.json (each Cline turn appends a fresh
// <environment_details> block). Returns null when the sibling file is
// missing, unreadable, or contains no tag. Bounded to first 1MB to avoid
// pathological history files starving sync.
function readRoocodeTaskModel(uiMessagesPath) {
  const historyPath = path.join(path.dirname(uiMessagesPath), "api_conversation_history.json");
  let raw;
  try { raw = fssync.readFileSync(historyPath, "utf8"); } catch { return null; }
  if (raw.length > 1_048_576) {
    // Naive `slice(raw.length - 1MB)` can split a `<environment_details>`
    // block mid-tag — e.g. the keep window starts at "...<mod" so the
    // regex finds nothing and we fall back to "unknown". Align the cut
    // to the first `<environment_details>` start in the keep window so
    // every retained tag is intact.
    const naive = raw.slice(raw.length - 1_048_576);
    const blockStart = naive.indexOf("<environment_details>");
    raw = blockStart >= 0 ? naive.slice(blockStart) : naive;
  }
  let lastModel = null;
  const re = /<model>\s*([^<\s][^<]*?)\s*<\/model>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const value = m[1].trim();
    if (value) lastModel = value;
  }
  return lastModel;
}

function normalizeRoocodeModel({ explicitModel, apiProtocol }) {
  const trimmed = typeof explicitModel === "string" ? explicitModel.trim() : "";
  if (trimmed) return trimmed;
  if (typeof apiProtocol === "string" && apiProtocol.trim()) {
    const slug = apiProtocol.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    if (slug) return `protocol:${slug}`;
  }
  return "unknown";
}

async function parseRoocodeIncremental({
  taskFiles,
  cursors,
  queuePath,
  onProgress,
  env,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const roocodeState =
    cursors.roocode && typeof cursors.roocode === "object" ? cursors.roocode : {};
  const seenIds = new Set(
    Array.isArray(roocodeState.seenIds) ? roocodeState.seenIds : [],
  );
  const fileOffsets =
    roocodeState.fileOffsets && typeof roocodeState.fileOffsets === "object"
      ? { ...roocodeState.fileOffsets }
      : {};

  const files = Array.isArray(taskFiles)
    ? taskFiles
    : resolveRoocodeTaskFiles(env || process.env);

  if (files.length === 0) {
    cursors.roocode = {
      ...roocodeState,
      seenIds: Array.from(seenIds),
      fileOffsets,
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const entry = files[fileIdx];
    const { filePath, taskUuid } = entry;
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    const prevEntry = fileOffsets[filePath];
    if (
      prevEntry &&
      Number(prevEntry.size) === stat.size &&
      Number(prevEntry.mtimeMs) === stat.mtimeMs
    ) {
      continue;
    }

    let raw;
    try { raw = fssync.readFileSync(filePath, "utf8"); } catch { continue; }
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(data)) continue;

    // Read sibling history once per task — model can change mid-task but is
    // stable enough at this granularity that re-reading on every entry would
    // just burn IO. Task attribution at the bucket layer is hourly anyway.
    const taskModel = readRoocodeTaskModel(filePath);

    for (const msg of data) {
      if (!msg || typeof msg !== "object") continue;
      // Like Kilo Code, accept both api_req_started (live) and api_req_deleted
      // (user-removed turn whose tokens were already consumed).
      if (msg.say !== "api_req_started" && msg.say !== "api_req_deleted") continue;
      if (typeof msg.text !== "string" || !msg.text.startsWith("{")) continue;

      let payload;
      try { payload = JSON.parse(msg.text); } catch { continue; }
      if (!payload || typeof payload !== "object") continue;

      const ts = Number(msg.ts);
      if (!Number.isFinite(ts) || ts <= 0) continue;

      const dedupKey = `${taskUuid}:${ts}`;
      recordsProcessed++;
      if (seenIds.has(dedupKey)) continue;

      const tokensIn = toNonNegativeInt(payload.tokensIn);
      const tokensOut = toNonNegativeInt(payload.tokensOut);
      const cacheReads = toNonNegativeInt(payload.cacheReads);
      const cacheWrites = toNonNegativeInt(payload.cacheWrites);
      if (tokensIn === 0 && tokensOut === 0 && cacheReads === 0 && cacheWrites === 0) {
        // Cline-family extensions write `api_req_started` at request START
        // (zero tokens) and back-fill the SAME message in place (same ts)
        // once the request completes. Marking the zero placeholder as seen
        // would skip the back-filled tokens forever — a sync racing an
        // in-flight request silently under-counted that turn. Leave it
        // unseen; the file-level mtime gate re-evaluates it when the task
        // file is rewritten.
        continue;
      }

      const tsIso = new Date(ts).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const delta = {
        input_tokens: tokensIn,
        cached_input_tokens: cacheReads,
        cache_creation_input_tokens: cacheWrites,
        output_tokens: tokensOut,
        reasoning_output_tokens: 0,
        total_tokens: tokensIn + tokensOut + cacheReads + cacheWrites,
        conversation_count: 1,
      };

      const model = normalizeRoocodeModel({
        explicitModel: taskModel,
        apiProtocol: payload.apiProtocol,
      });
      const bucket = getHourlyBucket(hourlyState, "roocode", model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("roocode", model, bucketStart));
      seenIds.add(dedupKey);
      eventsAggregated++;
    }

    fileOffsets[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };

    if (cb) {
      cb({
        index: fileIdx + 1,
        total: files.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const seenArr = Array.from(seenIds);
  const cappedSeen = seenArr.length > 50_000 ? seenArr.slice(seenArr.length - 50_000) : seenArr;

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.roocode = { ...roocodeState, seenIds: cappedSeen, fileOffsets, updatedAt };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// Zed Agent (all model providers — hosted "zed.dev" and bring-your-own alike)
//
// Data: SQLite at
//   macOS:    ~/Library/Application Support/Zed/threads/threads.db
//   Linux:    $XDG_DATA_HOME/zed/threads/threads.db (defaults to ~/.local/share)
//   Windows:  %LOCALAPPDATA%\Zed\threads\threads.db
//
// `threads` table stores one row per thread with a BLOB `data` column —
// either raw JSON or zstd-compressed JSON (governed by `data_type`). Each
// thread's JSON carries `cumulative_token_usage` and/or
// `request_token_usage` (a map or array of per-request usages with
// input_tokens / output_tokens / cache_read_input_tokens /
// cache_creation_input_tokens).
//
// Threads grow over multiple turns — the row is rewritten with a larger
// cumulative on every send, so naive dedup-by-id would freeze our count at
// whatever the thread looked like the first time we saw it. We mirror the
// antigravity cumulative-delta pattern: keep last-seen totals per thread in
// `cursors.zed.threadTotals`, emit (current - previous) on each sync.
//
// Providers already reported by a dedicated parser are skipped to avoid
// double-counting (see ZED_DOUBLE_COUNTED_PROVIDERS — empty today). Model names
// are normalized for pricing in the matcher (normalizeZedModel), not here, so
// the real Zed model name is preserved for display.
// ─────────────────────────────────────────────────────────────────────────────

// Providers whose usage is ALSO captured by a dedicated TokenTracker parser, so
// counting them via the Zed thread store would double-count. Zed's native model
// providers (zed.dev, copilot_chat, openai*, anthropic, google, ollama,
// lmstudio, …) do NOT overlap: e.g. Zed's copilot_chat talks to the Copilot API
// directly and never writes ~/.copilot/otel, which is what the Copilot parser
// reads. The set is therefore empty today; it's the extension point if Zed ever
// persists external-ACP-agent usage (Claude Code / Codex run inside Zed) into
// threads.db with a recognizable provider id.
const ZED_DOUBLE_COUNTED_PROVIDERS = new Set();
const MAX_ZED_THREAD_JSON_BYTES = 32 * 1024 * 1024;

function resolveZedDbPath(env = process.env) {
  if (typeof env.TOKENTRACKER_ZED_DB === "string" && env.TOKENTRACKER_ZED_DB.trim()) {
    return env.TOKENTRACKER_ZED_DB.trim();
  }
  const home = env.HOME || require("node:os").homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Zed", "threads", "threads.db");
  }
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const native = path.join(local, "Zed", "threads", "threads.db");
    const wslThreadsDir = wsl.shouldProbeWsl(env) ? wsl.discoverWslHome(".local/share/zed/threads", { env }) : null;
    const wslDbPath = wslThreadsDir && fssync.existsSync(path.join(wslThreadsDir, "threads.db"))
      ? path.join(wslThreadsDir, "threads.db") : null;
    const paths = resolveInstallPaths({ nativeValue: native, wslValue: wslDbPath }, env);
    const picked = paths.native || paths.wsl;
    if (picked) return picked;
    const mode = wsl.getWslMode(env);
    return mode === "wsl-only" || mode === "native-only" ? null : native;
  }
  const xdg = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "zed", "threads", "threads.db");
}

// Decode a row's BLOB payload into UTF-8 JSON text. Zed marks zstd-compressed
// blobs with data_type="zstd"; older / smaller threads use data_type="json"
// and store the bytes verbatim. Node 24+ has native zstd; Node 20 needs the
// @mongodb-js/zstd fallback. Cap decoded size to mirror tokscale's safety net.
async function decodeZedThreadBlob({ dataType, data }) {
  const type = (dataType || "").trim().toLowerCase();
  if (type === "json") {
    if (data.length > MAX_ZED_THREAD_JSON_BYTES) {
      throw new Error(`json blob exceeds ${MAX_ZED_THREAD_JSON_BYTES} bytes`);
    }
    return data.toString("utf8");
  }
  if (type === "zstd") {
    const zlib = require("node:zlib");
    const out =
      typeof zlib.zstdDecompressSync === "function"
        ? zlib.zstdDecompressSync(data)
        : Buffer.from(await require("@mongodb-js/zstd").decompress(data));
    if (out.length > MAX_ZED_THREAD_JSON_BYTES) {
      throw new Error(`decoded zstd blob exceeds ${MAX_ZED_THREAD_JSON_BYTES} bytes`);
    }
    return out.toString("utf8");
  }
  throw new Error(`unsupported data_type: ${dataType}`);
}

// Pull the 4-tuple (input/output/cache_read/cache_write) out of one Zed
// TokenUsage shape. Zed stores integers but some historical rows used
// strings — match tokscale's permissive coercion.
function readZedUsage(value) {
  if (!value || typeof value !== "object") return null;
  const coerce = (v) => {
    if (typeof v === "number") return Math.max(0, Math.floor(v));
    if (typeof v === "string") {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    return 0;
  };
  return {
    input: coerce(value.input_tokens),
    output: coerce(value.output_tokens),
    cache_read: coerce(value.cache_read_input_tokens),
    cache_write: coerce(value.cache_creation_input_tokens),
  };
}

function sumZedRequestUsage(value) {
  const total = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  if (!value) return total;
  const iter =
    Array.isArray(value)
      ? value
      : typeof value === "object"
      ? Object.values(value)
      : [];
  for (const entry of iter) {
    const u = readZedUsage(entry);
    if (!u) continue;
    total.input += u.input;
    total.output += u.output;
    total.cache_read += u.cache_read;
    total.cache_write += u.cache_write;
  }
  return total;
}

// Extract token totals from a parsed Zed thread object. Prefer summed
// request_token_usage (per-turn breakdown) and fall back to
// cumulative_token_usage when the per-turn map is empty.
function extractZedTotals(thread) {
  if (!thread || thread.imported === true) return null;
  const model = thread.model;
  if (!model || typeof model !== "object") return null;
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  // Count usage for ALL providers — Zed-hosted (zed.dev) and bring-your-own
  // (copilot_chat, openai-subscribed, anthropic, lmstudio, …) alike. Only skip
  // providers whose usage a dedicated parser already reports (see
  // ZED_DOUBLE_COUNTED_PROVIDERS).
  if (provider && ZED_DOUBLE_COUNTED_PROVIDERS.has(provider.toLowerCase())) return null;
  const modelId = typeof model.model === "string" ? model.model.trim() : "";
  if (!modelId) return null;

  const request = sumZedRequestUsage(thread.request_token_usage);
  if (request.input + request.output + request.cache_read + request.cache_write > 0) {
    return { totals: request, model: modelId };
  }
  const cumulative = readZedUsage(thread.cumulative_token_usage);
  if (
    cumulative &&
    cumulative.input + cumulative.output + cumulative.cache_read + cumulative.cache_write > 0
  ) {
    return { totals: cumulative, model: modelId };
  }
  return null;
}

// Build a SELECT that only references columns we know exist — Zed has shipped
// several `threads` schemas; older versions may omit created_at /
// folder_paths. We dynamically detect via PRAGMA so the query never fails on
// a missing column.
function buildZedThreadsQuery(dbPath, cursorUpdatedAt, sqliteOptions = {}) {
  const pragmaRows = readSqliteJsonRows(dbPath, "PRAGMA table_info(threads)", {
    label: "Zed",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
    ...sqliteOptions,
  });
  const columns = new Set(
    pragmaRows
      .map((row) => row?.name)
      .filter(Boolean),
  );
  const optional = (col) => (columns.has(col) ? col : `NULL AS ${col}`);
  // Incremental: only fetch threads updated after the last sync watermark.
  // Without this we'd zstd-decode every thread on every sync (~250MB for a
  // 5k-thread DB on every menu-bar tick). Empty cursor → full scan (first
  // sync). updated_at is stored as ISO 8601 text, so lexical comparison ==
  // chronological comparison.
  const escaped = typeof cursorUpdatedAt === "string" && cursorUpdatedAt
    ? cursorUpdatedAt.replace(/'/g, "''")
    : null;
  const where = escaped ? ` WHERE updated_at > '${escaped}'` : "";
  return `SELECT id, updated_at, ${optional("created_at")}, data_type, hex(data) AS data_hex FROM threads${where}`;
}

function readZedThreadRowsFromSqlite(dbPath, cursorUpdatedAt, sqliteOptions = {}) {
  const query = buildZedThreadsQuery(dbPath, cursorUpdatedAt, sqliteOptions);
  return readSqliteJsonRows(dbPath, query, {
    label: "Zed",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 60_000,
    ...sqliteOptions,
  });
}

async function parseZedIncremental({
  dbPath,
  cursors,
  queuePath,
  onProgress,
  env,
  sqliteOptions,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const resolvedDb = dbPath || resolveZedDbPath(env || process.env);
  if (!resolvedDb) {
    cursors.zed = { ...cursors.zed, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }
  const zedState =
    cursors.zed && typeof cursors.zed === "object" ? cursors.zed : {};
  const threadTotals =
    zedState.threadTotals && typeof zedState.threadTotals === "object"
      ? { ...zedState.threadTotals }
      : {};
  const cursorUpdatedAt = typeof zedState.lastUpdatedAt === "string" ? zedState.lastUpdatedAt : null;
  const cursorDbMtime = Number.isFinite(zedState.lastDbMtimeMs) ? zedState.lastDbMtimeMs : 0;

  // mtime short-circuit: if the SQLite file hasn't been touched since the
  // last sync there's nothing to read — skip the ~250MB copyFile + zstd
  // round-trip entirely. We still re-stat on the next call, so a Zed write
  // is picked up within one sync interval.
  let currentMtime = 0;
  try {
    currentMtime = fssync.statSync(resolvedDb).mtimeMs;
  } catch (e) {
    if (e && e.code === "ENOENT") {
      cursors.zed = { ...zedState, threadTotals, updatedAt: new Date().toISOString() };
      return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    }
    throw e;
  }
  if (currentMtime > 0 && currentMtime === cursorDbMtime) {
    cursors.zed = { ...zedState, threadTotals, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  // Snapshot via the shared helper so we get WAL/SHM/journal sidecar copies
  // too. Without sidecars, an active Zed write that's still in the WAL
  // would be missed (the .db has older pages until checkpoint).
  const snap = snapshotSqliteDb(resolvedDb);
  let rows = [];
  try {
    rows = readZedThreadRowsFromSqlite(snap.path, cursorUpdatedAt, sqliteOptions);
  } finally {
    snap.cleanup();
  }

  if (rows.length === 0) {
    cursors.zed = { ...zedState, threadTotals, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    recordsProcessed++;
    if (!row || typeof row.id !== "string" || !row.data_hex) continue;

    let blob;
    try { blob = Buffer.from(row.data_hex, "hex"); } catch { continue; }

    let jsonText;
    try { jsonText = await decodeZedThreadBlob({ dataType: row.data_type, data: blob }); }
    catch { continue; }

    let thread;
    try { thread = JSON.parse(jsonText); } catch { continue; }

    const extracted = extractZedTotals(thread);
    if (!extracted) continue;

    const prev = threadTotals[row.id] || { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const curr = extracted.totals;
    const prevSum = prev.input + prev.output + prev.cache_read + prev.cache_write;
    const currSum = curr.input + curr.output + curr.cache_read + curr.cache_write;
    // Detect cumulative reset: a thread can be re-created with the same id
    // but lower totals (rare — Zed may purge & rewrite on import/export).
    // Naive `Math.max(0, curr - prev)` would clamp the delta to 0 and quietly
    // update the cursor to the smaller `curr`, so the next sync sees growth
    // from the reset and re-counts everything since. Treat reset as a
    // fresh-start emit of `curr`.
    const isReset = currSum > 0 && currSum < prevSum;
    const delta = isReset
      ? { ...curr }
      : {
          input: Math.max(0, curr.input - prev.input),
          output: Math.max(0, curr.output - prev.output),
          cache_read: Math.max(0, curr.cache_read - prev.cache_read),
          cache_write: Math.max(0, curr.cache_write - prev.cache_write),
        };
    const totalDelta = delta.input + delta.output + delta.cache_read + delta.cache_write;
    if (totalDelta <= 0) {
      if (
        curr.input !== prev.input ||
        curr.output !== prev.output ||
        curr.cache_read !== prev.cache_read ||
        curr.cache_write !== prev.cache_write
      ) {
        threadTotals[row.id] = curr;
      }
      continue;
    }

    const tsIso =
      (typeof row.updated_at === "string" && row.updated_at) ||
      (typeof row.created_at === "string" && row.created_at) ||
      (typeof thread.updated_at === "string" && thread.updated_at) ||
      new Date().toISOString();
    const bucketStart = toUtcHalfHourStart(tsIso);
    if (!bucketStart) continue;

    const bucketDelta = {
      input_tokens: delta.input,
      cached_input_tokens: delta.cache_read,
      cache_creation_input_tokens: delta.cache_write,
      output_tokens: delta.output,
      reasoning_output_tokens: 0,
      total_tokens: totalDelta,
      conversation_count: 1,
    };

    const bucket = getHourlyBucket(hourlyState, "zed", extracted.model, bucketStart);
    addTotals(bucket.totals, bucketDelta);
    touchedBuckets.add(bucketKey("zed", extracted.model, bucketStart));
    threadTotals[row.id] = curr;
    eventsAggregated++;

    if (cb) {
      cb({
        index: i + 1,
        total: rows.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  // Compute nextCursor BEFORE the 10k cap. If we capped first, a low-volume
  // zed.dev thread evicted in the cap step would no longer be in
  // threadTotals, so its updated_at would not advance the cursor — and the
  // next sync's WHERE filter would re-read & re-decode the same blob forever.
  // We record everything we touched this run regardless of post-cap eviction.
  let nextCursor = cursorUpdatedAt;
  for (const r of rows) {
    if (
      typeof r.updated_at === "string" &&
      threadTotals[r.id] !== undefined &&
      (nextCursor == null || r.updated_at > nextCursor)
    ) {
      nextCursor = r.updated_at;
    }
  }

  const entries = Object.entries(threadTotals);
  if (entries.length > 10_000) {
    entries.sort((a, b) => {
      const ta = a[1].input + a[1].output + a[1].cache_read + a[1].cache_write;
      const tb = b[1].input + b[1].output + b[1].cache_read + b[1].cache_write;
      return tb - ta;
    });
    const capped = Object.fromEntries(entries.slice(0, 10_000));
    for (const k of Object.keys(threadTotals)) delete threadTotals[k];
    Object.assign(threadTotals, capped);
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.zed = {
    ...zedState,
    threadTotals,
    lastUpdatedAt: nextCursor,
    lastDbMtimeMs: currentMtime,
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// AnythingLLM Desktop (Mintplex Labs)
//
// Data: SQLite at
//   macOS:   ~/Library/Application Support/anythingllm-desktop/storage/anythingllm.db
//   Linux:   $XDG_CONFIG_HOME/anythingllm-desktop/storage/anythingllm.db
//   Windows: %APPDATA%\anythingllm-desktop\storage\anythingllm.db
//   Override: $TOKENTRACKER_ANYTHINGLLM_DB
//
// AnythingLLM >= 1.7.1 stores per-message prompt/completion/total counts in
// workspace_chats.response.metrics. The SQL projection below extracts only
// those numeric metrics and the model identifier — prompts, response
// text, sources, and attachments never leave SQLite.
// ─────────────────────────────────────────────────────────────────────────────

const ANYTHINGLLM_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function resolveAnythingllmDbPath(env = process.env, platform = process.platform) {
  const override = typeof env.TOKENTRACKER_ANYTHINGLLM_DB === "string"
    ? env.TOKENTRACKER_ANYTHINGLLM_DB.trim()
    : "";
  if (override) return override;

  const os = require("node:os");
  if (platform === "win32") {
    const home = env.USERPROFILE || os.homedir();
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "anythingllm-desktop", "storage", "anythingllm.db");
  }

  const home = env.HOME || os.homedir();
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "anythingllm-desktop",
      "storage",
      "anythingllm.db",
    );
  }

  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, "anythingllm-desktop", "storage", "anythingllm.db");
}

function parseAnythingllmTimestamp(value) {
  const epochIso = (epochValue) => {
    if (!Number.isFinite(epochValue)) return null;
    // Prisma stores SQLite DateTime values as epoch milliseconds. Accept
    // seconds as well for compatibility with databases created by other
    // SQLite clients.
    const epochMs = Math.abs(epochValue) < 100_000_000_000
      ? epochValue * 1000
      : epochValue;
    const parsed = new Date(epochMs);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  };
  if (typeof value === "number") return epochIso(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return epochIso(Number(trimmed));
  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (naive) {
    const millis = String(naive[7] || "0").padEnd(3, "0");
    return new Date(Date.UTC(
      +naive[1],
      +naive[2] - 1,
      +naive[3],
      +naive[4],
      +naive[5],
      +naive[6],
      +millis,
    )).toISOString();
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readAnythingllmUsageRowsWhere(dbPath, whereClause, sqliteOptions = {}) {
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const metric = (jsonPath, alias) =>
    `CASE WHEN json_valid(response) THEN json_extract(response, '${jsonPath}') ELSE NULL END AS ${alias}`;
  const sql = `
    SELECT
      id,
      include,
      createdAt,
      lastUpdatedAt,
      ${metric("$.metrics.prompt_tokens", "prompt_tokens")},
      ${metric("$.metrics.completion_tokens", "completion_tokens")},
      ${metric("$.metrics.total_tokens", "total_tokens")},
      ${metric("$.metrics.model", "model")}
    FROM workspace_chats
    WHERE ${whereClause}
    ORDER BY id ASC
  `.trim();

  let snapshot = null;
  let effectiveDbPath = dbPath;
  if (isUncPath(dbPath)) {
    try {
      snapshot = snapshotSqliteDb(dbPath);
      effectiveDbPath = snapshot.path;
    } catch (_e) { }
  }

  try {
    return readSqliteJsonRows(effectiveDbPath, sql, {
      label: "AnythingLLM",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
      readOnly: true,
      ...sqliteOptions,
    });
  } finally {
    if (snapshot) snapshot.cleanup();
  }
}

function readAnythingllmUsageRows(dbPath, sinceId = 0, sqliteOptions = {}) {
  const safeSinceId = Math.max(0, Math.trunc(Number(sinceId) || 0));
  return readAnythingllmUsageRowsWhere(dbPath, `id > ${safeSinceId}`, sqliteOptions);
}

function readAnythingllmUsageRowsByIds(dbPath, ids, sqliteOptions = {}) {
  const normalizedIds = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map(toNonNegativeInt)
        .filter((id) => id > 0),
    ),
  ];
  const rows = [];
  for (let start = 0; start < normalizedIds.length; start += 500) {
    const chunk = normalizedIds.slice(start, start + 500);
    rows.push(
      ...readAnythingllmUsageRowsWhere(
        dbPath,
        `id IN (${chunk.join(",")})`,
        sqliteOptions,
      ),
    );
  }
  return rows.sort((a, b) => toNonNegativeInt(a?.id) - toNonNegativeInt(b?.id));
}

async function parseAnythingllmIncremental({
  dbPath,
  cursors,
  queuePath,
  onProgress,
  env,
  sqliteOptions,
  nowMs = Date.now(),
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const resolvedDb = dbPath || resolveAnythingllmDbPath(env || process.env);
  const priorState = cursors.anythingllm && typeof cursors.anythingllm === "object"
    ? cursors.anythingllm
    : {};
  const lastChatId = Math.max(0, Math.trunc(Number(priorState.lastChatId) || 0));
  const pendingChatIds = new Set(
    (Array.isArray(priorState.pendingChatIds) ? priorState.pendingChatIds : [])
      .map(toNonNegativeInt)
      .filter((id) => id > 0),
  );
  const pendingCutoffMs = (Number.isFinite(nowMs) ? nowMs : Date.now())
    - ANYTHINGLLM_PENDING_MAX_AGE_MS;

  if (!resolvedDb || !fssync.existsSync(resolvedDb)) {
    cursors.anythingllm = {
      ...priorState,
      lastChatId,
      pendingChatIds: [...pendingChatIds].sort((a, b) => a - b),
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const incrementalRows = readAnythingllmUsageRows(resolvedDb, lastChatId, sqliteOptions);
  const pendingRetryRows = readAnythingllmUsageRowsByIds(
    resolvedDb,
    [...pendingChatIds],
    sqliteOptions,
  );
  const pendingRetryIds = new Set(
    pendingRetryRows.map((row) => toNonNegativeInt(row?.id)),
  );
  for (const pendingId of pendingChatIds) {
    if (!pendingRetryIds.has(pendingId)) pendingChatIds.delete(pendingId);
  }
  const rowsById = new Map();
  for (const row of [...pendingRetryRows, ...incrementalRows]) {
    rowsById.set(toNonNegativeInt(row?.id), row);
  }
  const rows = Array.from(rowsById.values()).sort(
    (a, b) => toNonNegativeInt(a?.id) - toNonNegativeInt(b?.id),
  );
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let maxSeenId = lastChatId;
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  const reportProgress = (index) => {
    if (!cb) return;
    cb({
      index,
      total: rows.length,
      recordsProcessed,
      eventsAggregated,
      bucketsQueued: touchedBuckets.size,
    });
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    recordsProcessed += 1;
    const rowId = Math.max(0, Math.trunc(Number(row?.id) || 0));
    if (rowId > maxSeenId) maxSeenId = rowId;

    const inputTokens = toNonNegativeInt(row?.prompt_tokens);
    const outputTokens = toNonNegativeInt(row?.completion_tokens);
    const reportedTotal = toNonNegativeInt(row?.total_tokens);
    if (inputTokens === 0 && outputTokens === 0) {
      const pendingTimestamp = parseAnythingllmTimestamp(row?.lastUpdatedAt)
        || parseAnythingllmTimestamp(row?.createdAt);
      const pendingTimestampMs = pendingTimestamp ? Date.parse(pendingTimestamp) : NaN;
      const shouldRetry =
        toNonNegativeInt(row?.include) === 0
        && Number.isFinite(pendingTimestampMs)
        && pendingTimestampMs >= pendingCutoffMs;
      if (rowId > 0 && shouldRetry) pendingChatIds.add(rowId);
      else if (rowId > 0) pendingChatIds.delete(rowId);
      reportProgress(i + 1);
      continue;
    }

    const timestamp = parseAnythingllmTimestamp(row?.createdAt)
      || parseAnythingllmTimestamp(row?.lastUpdatedAt);
    const bucketStart = timestamp ? toUtcHalfHourStart(timestamp) : null;
    if (!bucketStart) {
      if (rowId > 0) pendingChatIds.delete(rowId);
      reportProgress(i + 1);
      continue;
    }
    if (rowId > 0) pendingChatIds.delete(rowId);

    const model = normalizeModelInput(row?.model) || "anythingllm-unknown";
    const accounted = inputTokens + outputTokens;
    const reasoningTokens = Math.max(0, reportedTotal - accounted);
    const delta = {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_output_tokens: reasoningTokens,
      total_tokens: accounted + reasoningTokens,
      conversation_count: 1,
    };

    const bucket = getHourlyBucket(hourlyState, "anythingllm", model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey("anythingllm", model, bucketStart));
    eventsAggregated += 1;

    reportProgress(i + 1);
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.anythingllm = {
    ...priorState,
    lastChatId: maxSeenId,
    pendingChatIds: [...pendingChatIds].sort((a, b) => a - b),
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// Goose (Block AI agent — github.com/block/goose)
//
// Data: SQLite at
//   macOS:   ~/Library/Application Support/goose/sessions/sessions.db
//   Linux:   $XDG_DATA_HOME/goose/sessions/sessions.db (~/.local/share)
//   Legacy:  ~/.local/share/Block/goose/sessions/sessions.db
//   Windows: %APPDATA%\goose\sessions\sessions.db
//   Override: $GOOSE_PATH_ROOT/data/sessions/sessions.db
//
// `sessions` table: one row per session, columns:
//   id, model_config_json ({"model_name":"..."}),
//   provider_name, created_at,
//   total_tokens / input_tokens / output_tokens (latest turn),
//   accumulated_total_tokens / accumulated_input_tokens /
//   accumulated_output_tokens (whole-session cumulative).
//
// We prefer accumulated_* (gives lifetime usage), with single-turn fallback.
// Goose has no cache fields; if total > input+output, the excess is treated
// as reasoning_output_tokens (same heuristic as tokscale).
//
// Session rows grow over time → same cumulative-delta pattern as Zed
// (cursors.goose.sessionTotals tracks last-seen per session).
// ─────────────────────────────────────────────────────────────────────────────

function resolveGooseDbPath(env = process.env) {
  if (typeof env.TOKENTRACKER_GOOSE_DB === "string" && env.TOKENTRACKER_GOOSE_DB.trim()) {
    return env.TOKENTRACKER_GOOSE_DB.trim();
  }
  const root = typeof env.GOOSE_PATH_ROOT === "string" ? env.GOOSE_PATH_ROOT.trim() : "";
  if (root) return path.join(root, "data", "sessions", "sessions.db");
  const home = env.HOME || require("node:os").homedir();
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "goose", "sessions", "sessions.db"),
    );
  } else if (process.platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    const native = path.join(appData, "goose", "sessions", "sessions.db");
    const wslDir = wsl.shouldProbeWsl(env) ? wsl.discoverWslHome(".local/share/goose/sessions", { env }) : null;
    const wslValue = wslDir && fssync.existsSync(path.join(wslDir, "sessions.db"))
      ? path.join(wslDir, "sessions.db") : null;
    const paths = resolveInstallPaths({ nativeValue: native, wslValue }, env);
    const picked = paths.native || paths.wsl;
    if (picked) candidates.push(picked);
    for (const c of candidates) {
      if (fssync.existsSync(c)) return c;
    }
    const mode = wsl.getWslMode(env);
    return mode === "wsl-only" || mode === "native-only" ? null : native;
  }
  const xdg = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  candidates.push(
    path.join(xdg, "goose", "sessions", "sessions.db"),
    path.join(xdg, "Block", "goose", "sessions", "sessions.db"),
  );
  // Default to first existing; if none, return the platform-canonical path so
  // status can report it cleanly without throwing.
  for (const c of candidates) {
    if (fssync.existsSync(c)) return c;
  }
  return candidates[0] || null;
}

function parseGooseModelName(modelConfigJson) {
  if (typeof modelConfigJson !== "string" || !modelConfigJson.trim()) return null;
  try {
    const obj = JSON.parse(modelConfigJson);
    if (obj && typeof obj.model_name === "string") {
      const trimmed = obj.model_name.trim();
      return trimmed || null;
    }
  } catch (_e) { /* ignore */ }
  return null;
}

// Goose stores created_at in multiple formats across versions: RFC3339
// (preferred), "YYYY-MM-DD HH:MM:SS" (naive UTC), or bare "YYYY-MM-DD".
// Return ISO 8601 string, or null on failure.
function parseGooseCreatedAt(s) {
  if (typeof s !== "string" || !s.trim()) return null;
  const trimmed = s.trim();
  // Match naive UTC formats FIRST — otherwise `new Date("2026-05-21 14:30:00")`
  // is interpreted in the local zone, shifting the bucket by ±N hours.
  const dt = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (dt) {
    const d = new Date(Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6]));
    return d.toISOString();
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const d = new Date(Date.UTC(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]));
    return d.toISOString();
  }
  // Anything else — RFC3339, "Z"-suffixed, "+HH:MM" — let Date handle it.
  const iso = new Date(trimmed);
  if (!Number.isNaN(iso.getTime())) return iso.toISOString();
  return null;
}

function readGooseSessionsFromSqlite(dbPath, sqliteOptions = {}) {
  // Probe columns: the `accumulated_*` fields were added in a later Goose
  // version; we keep the query forgiving so older installs still work.
  const pragmaRows = readSqliteJsonRows(dbPath, "PRAGMA table_info(sessions)", {
    label: "Goose",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
    ...sqliteOptions,
  });
  const columns = new Set(
    pragmaRows
      .map((row) => row?.name)
      .filter(Boolean),
  );
  const optional = (col) => (columns.has(col) ? col : `NULL AS ${col}`);
  const sql = `
    SELECT
      id,
      model_config_json,
      ${optional("provider_name")},
      created_at,
      ${optional("total_tokens")},
      ${optional("input_tokens")},
      ${optional("output_tokens")},
      ${optional("accumulated_total_tokens")},
      ${optional("accumulated_input_tokens")},
      ${optional("accumulated_output_tokens")}
    FROM sessions
    WHERE model_config_json IS NOT NULL
      AND TRIM(model_config_json) != ''
  `.trim();
  return readSqliteJsonRows(dbPath, sql, {
    label: "Goose",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    ...sqliteOptions,
  });
}

async function parseGooseIncremental({
  dbPath,
  cursors,
  queuePath,
  onProgress,
  env,
  sqliteOptions,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const resolvedDb = dbPath || resolveGooseDbPath(env || process.env);
  const gooseState =
    cursors.goose && typeof cursors.goose === "object" ? cursors.goose : {};
  const sessionTotals =
    gooseState.sessionTotals && typeof gooseState.sessionTotals === "object"
      ? { ...gooseState.sessionTotals }
      : {};

  if (!resolvedDb) {
    cursors.goose = { ...gooseState, sessionTotals, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const cursorDbMtime = Number.isFinite(gooseState.lastDbMtimeMs) ? gooseState.lastDbMtimeMs : 0;
  let currentMtime = 0;
  try {
    currentMtime = fssync.statSync(resolvedDb).mtimeMs;
  } catch (e) {
    if (e && e.code === "ENOENT") {
      cursors.goose = { ...gooseState, sessionTotals, updatedAt: new Date().toISOString() };
      return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    }
    throw e;
  }
  // mtime short-circuit: skip the full sessions table scan when the DB
  // hasn't been touched since the last sync.
  if (currentMtime > 0 && currentMtime === cursorDbMtime) {
    cursors.goose = { ...gooseState, sessionTotals, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  // Snapshot via the shared helper to capture WAL/SHM sidecars — Goose
  // writes async, so without them an in-flight session would read stale.
  const snap = snapshotSqliteDb(resolvedDb);
  let rows = [];
  try {
    rows = readGooseSessionsFromSqlite(snap.path, sqliteOptions);
  } finally {
    snap.cleanup();
  }

  if (rows.length === 0) {
    cursors.goose = { ...gooseState, sessionTotals, updatedAt: new Date().toISOString() };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    recordsProcessed++;
    if (!row || typeof row.id !== "string") continue;

    const model = parseGooseModelName(row.model_config_json);
    if (!model) continue;

    // Prefer accumulated_*; fall back to single-turn columns.
    const totalNow = Math.max(
      0,
      Number(row.accumulated_total_tokens ?? row.total_tokens ?? 0) || 0,
    );
    const inputNow = Math.max(
      0,
      Number(row.accumulated_input_tokens ?? row.input_tokens ?? 0) || 0,
    );
    const outputNow = Math.max(
      0,
      Number(row.accumulated_output_tokens ?? row.output_tokens ?? 0) || 0,
    );
    if (totalNow === 0 && inputNow === 0 && outputNow === 0) continue;

    const prev = sessionTotals[row.id] || { input: 0, output: 0, total: 0 };
    // Goose can wipe a session and re-create with the same id during
    // database migration. Treat shrinking cumulative as a reset and emit
    // the full curr value, otherwise the next sync's growth would
    // double-count everything from the reset.
    const isReset = totalNow > 0 && totalNow < prev.total;
    const dInput = isReset ? inputNow : Math.max(0, inputNow - prev.input);
    const dOutput = isReset ? outputNow : Math.max(0, outputNow - prev.output);
    const dTotal = isReset ? totalNow : Math.max(0, totalNow - prev.total);
    if (dInput === 0 && dOutput === 0 && dTotal === 0) {
      if (
        prev.input !== inputNow ||
        prev.output !== outputNow ||
        prev.total !== totalNow
      ) {
        sessionTotals[row.id] = { input: inputNow, output: outputNow, total: totalNow };
      }
      continue;
    }

    // If total grew more than (input + output), treat the excess as reasoning
    // — matches Goose's accounting (it lumps reasoning into `total_tokens`).
    const accountedDelta = dInput + dOutput;
    const reasoningDelta = Math.max(0, dTotal - accountedDelta);

    const tsIso = parseGooseCreatedAt(row.created_at) || new Date().toISOString();
    const bucketStart = toUtcHalfHourStart(tsIso);
    if (!bucketStart) continue;

    // Token normalization: input_tokens = non-cached input; Goose has no
    // cache fields → all input lands in input_tokens. Total stays consistent
    // with: input + output + reasoning (no cache columns).
    const bucketDelta = {
      input_tokens: dInput,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: dOutput,
      reasoning_output_tokens: reasoningDelta,
      total_tokens: dInput + dOutput + reasoningDelta,
      conversation_count: 1,
    };

    const bucket = getHourlyBucket(hourlyState, "goose", model, bucketStart);
    addTotals(bucket.totals, bucketDelta);
    touchedBuckets.add(bucketKey("goose", model, bucketStart));
    sessionTotals[row.id] = { input: inputNow, output: outputNow, total: totalNow };
    eventsAggregated++;

    if (cb) {
      cb({
        index: i + 1,
        total: rows.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  // Cap cursor at 10k sessions (largest by lifetime usage).
  const entries = Object.entries(sessionTotals);
  if (entries.length > 10_000) {
    entries.sort((a, b) => b[1].total - a[1].total);
    const capped = Object.fromEntries(entries.slice(0, 10_000));
    for (const k of Object.keys(sessionTotals)) delete sessionTotals[k];
    Object.assign(sessionTotals, capped);
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.goose = {
    ...gooseState,
    sessionTotals,
    lastDbMtimeMs: currentMtime,
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// Droid (Factory CLI) — passive reader for ~/.factory/sessions/**/*.settings.json
//
// Each Droid session has two sibling files:
//   <session-id>.jsonl           — per-message transcript (no token counts)
//   <session-id>.settings.json   — JSON object whose tokenUsage holds the
//                                  CUMULATIVE session-level total:
//     {
//       "model": "custom:GLM-5.1-[Proxy]-0",
//       "providerLock": "anthropic",
//       "providerLockTimestamp": "2026-05-21T12:34:56.000Z",
//       "tokenUsage": {
//         "inputTokens": 12345,         // already excludes cached reads
//         "outputTokens": 678,
//         "cacheCreationTokens": 0,
//         "cacheReadTokens": 0,
//         "thinkingTokens": 0
//       }
//     }
//
// Droid records totals at session granularity (not per message). We treat each
// settings file as a cumulative counter and emit (current - previous) deltas,
// the same cumulative-delta pattern as Goose/Cursor. Bucket timestamp is the
// settings file's mtime — the file is rewritten each turn, so mtime is the
// most accurate "when did these new tokens land" signal we have.
// ─────────────────────────────────────────────────────────────────────────────

function resolveDroidSessionsDirs(env = process.env) {
  if (typeof env.DROID_SESSIONS_DIR === "string" && env.DROID_SESSIONS_DIR.trim()) {
    return env.DROID_SESSIONS_DIR.split(",")
      .map((d) => expandHomePath(d.trim(), env))
      .filter(Boolean);
  }
  if (typeof env.FACTORY_DIR === "string" && env.FACTORY_DIR.trim()) {
    return [path.join(expandHomePath(env.FACTORY_DIR.trim(), env), "sessions")];
  }
  const home = env.HOME || require("node:os").homedir();
  if (process.platform === "win32") {
    const picked = pickWin32ProviderPath({
      env,
      nativeValue: path.join(home, ".factory", "sessions"),
      wslProviderDir: ".factory/sessions",
    });
    return picked ? [picked] : [];
  }
  return [path.join(home, ".factory", "sessions")];
}

function resolveDroidSessionsDir(env = process.env) {
  return resolveDroidSessionsDirs(env)[0];
}

function listDroidSettingsFiles(env = process.env) {
  const dirs = resolveDroidSessionsDirs(env);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fssync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".settings.json")) {
        out.push(full);
      }
    }
  };
  for (const dir of dirs) {
    if (!fssync.existsSync(dir)) continue;
    walk(dir);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

// Strip Droid's wrapper to leave a comparable model id. Mirrors ccusage's
// `normalize_droid_model_name` (rust/crates/ccusage/src/adapter/droid/parser.rs)
// so the same input produces the same bucket key across both tools:
//   "custom:GLM-5.1-[Proxy]-0"        -> "glm-5-1-0"
//   "anthropic/claude-sonnet-4-5"     -> "anthropic/claude-sonnet-4-5"
//   "glm_5_1"                          -> "glm_5_1"   (underscore preserved)
// IMPORTANT: only whitespace, `.`, and existing dashes collapse to a single
// `-`. Underscores are kept verbatim — diverging here would split `glm_5_1`
// rows from ccusage's equivalent rows in cross-tool comparisons.
function normalizeDroidModelName(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.startsWith("custom:") ? raw.slice("custom:".length) : raw;
  s = s.replace(/\[[^\]]*\]/g, "");
  s = s.toLowerCase();
  s = s.replace(/[\s.]+/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  return s;
}

// Mirror ccusage's `normalize_droid_provider`: collapse aliases for the four
// known upstream families. Anything else falls through to the literal value
// (or "unknown" when the input is empty/garbage).
function normalizeDroidProvider(raw) {
  if (typeof raw !== "string") return "unknown";
  const v = raw.trim().toLowerCase().replace(/-/g, "_");
  if (!v) return "unknown";
  if (v === "claude" || v === "anthropic") return "anthropic";
  if (v === "openai") return "openai";
  if (
    v === "google" ||
    v === "google_ai" ||
    v === "gemini" ||
    v === "vertex" ||
    v === "vertex_ai"
  )
    return "google";
  if (v === "xai" || v === "x_ai" || v === "grok") return "xai";
  return v;
}

// When `providerLock` is missing, ccusage infers the family from the model
// name itself. We replicate the same heuristic so empty-providerLock sessions
// still bucket into `claude-unknown` / `gpt-unknown` / etc. rather than a
// generic "unknown".
function inferDroidProviderFromModel(model) {
  if (typeof model !== "string" || !model) return "unknown";
  const m = model.toLowerCase();
  if (
    m.includes("claude") ||
    m.includes("opus") ||
    m.includes("sonnet") ||
    m.includes("haiku")
  )
    return "anthropic";
  if (
    m.startsWith("gpt-") ||
    m.includes("-gpt-") ||
    m.includes("chatgpt") ||
    /^o\d/.test(m)
  )
    return "openai";
  if (m.includes("gemini")) return "google";
  if (m.includes("grok")) return "xai";
  return "unknown";
}

function defaultDroidModelForProvider(provider) {
  switch (provider) {
    case "anthropic":
      return "claude-unknown";
    case "openai":
      return "gpt-unknown";
    case "google":
      return "gemini-unknown";
    case "xai":
      return "grok-unknown";
    default:
      return "unknown";
  }
}

// When `settings.model` is missing, ccusage scans the sibling `<id>.jsonl`
// transcript for a line containing `Model:` and pulls the name from there.
// We mirror that exactly — same first-500-lines cap, same terminator chars
// (`"`, `\`, `[`) — so empty-model droid sessions don't all bucket under
// "unknown".
function extractDroidModelFromSidecarJsonl(settingsPath) {
  if (typeof settingsPath !== "string") return "";
  if (!settingsPath.endsWith(".settings.json")) return "";
  const sidecar = settingsPath.slice(0, -".settings.json".length) + ".jsonl";
  let raw;
  try {
    raw = fssync.readFileSync(sidecar, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  const limit = Math.min(lines.length, 500);
  for (let i = 0; i < limit; i++) {
    const idx = lines[i].indexOf("Model:");
    if (idx < 0) continue;
    const tail = lines[i].slice(idx + "Model:".length);
    // Stop at the first quote, backslash, or bracket — mirrors ccusage.
    let cut = tail.length;
    for (const ch of ['"', "\\", "["]) {
      const p = tail.indexOf(ch);
      if (p >= 0 && p < cut) cut = p;
    }
    const candidate = tail.slice(0, cut).trim();
    if (!candidate) continue;
    const normalized = normalizeDroidModelName(candidate);
    if (normalized) return normalized;
  }
  return "";
}

// ccusage's `apply_total_token_fallback`: if the five detail counters
// underflow the session's `totalTokens`, attribute the gap. Prefer assigning
// it to output (the field most likely to be missing on older settings.json
// schemas); if output is already populated, fold the extra into the thinking
// (reasoning_output_tokens) channel so total stays consistent. Mirrors
// rust/crates/ccusage/src/utils.rs verbatim.
function applyDroidTotalFallback(usage) {
  const known =
    usage.input + usage.output + usage.cacheCreation + usage.cacheRead + usage.thinking;
  const total = usage.totalTokens || 0;
  const missing = total > known ? total - known : 0;
  if (missing === 0) return usage;
  if (usage.output === 0) {
    return { ...usage, output: missing };
  }
  return { ...usage, thinking: usage.thinking + missing };
}

// Session id = basename minus `.settings.json`, mirroring ccusage's keying.
// Stable across FACTORY_DIR / HOME / mount-point moves because Droid uses
// UUID-style session ids (collision risk between projects is negligible).
function droidSessionIdFromPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return "";
  const base = path.basename(filePath);
  if (!base.endsWith(".settings.json")) return "";
  return base.slice(0, -".settings.json".length);
}

// Droid's workspace directory slug is lossy: path separators become `-`, which
// collides with literal dashes in directory names. The sibling transcript keeps
// the launch cwd losslessly in its session_start record, so project attribution
// must read that value instead of trying to decode the directory name.
const DROID_CWD_SCAN_MAX_BYTES = 65536;

async function resolveDroidFileCwd(settingsPath) {
  if (typeof settingsPath !== "string" || !settingsPath.endsWith(".settings.json")) {
    return null;
  }
  const sidecarPath = settingsPath.slice(0, -".settings.json".length) + ".jsonl";
  let stream;
  try {
    stream = fssync.createReadStream(sidecarPath, {
      encoding: "utf8",
      start: 0,
      end: DROID_CWD_SCAN_MAX_BYTES,
    });
  } catch {
    return null;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || !line.includes('"cwd"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        (entry?.type === "session_start" || entry?.type === "session") &&
        typeof entry.cwd === "string" &&
        entry.cwd.trim()
      ) {
        return entry.cwd.trim();
      }
    }
  } catch {
    return null;
  } finally {
    rl.close();
    stream.close?.();
  }
  return null;
}

// Resolve a Droid bucket model id. ccusage's chain: settings.model → sidecar
// <id>.jsonl scrape → `<provider>-unknown` derived from providerLock or inferred
// from the model fragment. Extracted so the dup-session repair migration can
// reproduce the exact same bucket key a settings file would have emitted under.
function resolveDroidModel(settings, filePath) {
  let model = normalizeDroidModelName(settings.model);
  if (!model) model = extractDroidModelFromSidecarJsonl(filePath);
  if (!model) {
    let provider = normalizeDroidProvider(settings.providerLock);
    if (provider === "unknown") {
      provider = inferDroidProviderFromModel(settings.model || "");
    }
    model = defaultDroidModelForProvider(provider);
  }
  return model;
}

// When the SAME Droid session id (the basename, which is the cursor key) appears
// in more than one folder under ~/.factory/sessions, every such file shares one
// sessionTotals[sessionId] entry. Processing them in a single parse loop makes the
// lower-count file look like a session reset and re-emit the full cumulative on
// every sync — unbounded inflation (issue #204). De-dupe to ONE canonical file per
// session id BEFORE the loop. Canonical = the most complete cumulative snapshot:
// largest max(five-field sum, totalTokens) (applyDroidTotalFallback already spills
// totalTokens into the five fields, so summing the filled fields IS that max);
// ties go to the newest mtime, then the lexicographically smaller path. A session
// id with a single file passes through untouched (no disk read).
function dedupeDroidSettingsFilesBySession(files) {
  const list = Array.isArray(files) ? files : [];
  const groups = new Map();
  for (const filePath of list) {
    if (typeof filePath !== "string") continue;
    const sessionId = droidSessionIdFromPath(filePath);
    if (!sessionId) continue;
    if (!groups.has(sessionId)) groups.set(sessionId, []);
    groups.get(sessionId).push(filePath);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    let best = null;
    let bestMetric = -1;
    let bestMtime = -1;
    for (const filePath of group) {
      let mtimeMs = 0;
      try {
        mtimeMs = fssync.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      let settings;
      try {
        settings = JSON.parse(fssync.readFileSync(filePath, "utf8"));
      } catch {
        continue;
      }
      const usage =
        settings && typeof settings === "object" && settings.tokenUsage
          ? settings.tokenUsage
          : {};
      const filled = applyDroidTotalFallback({
        input: Math.max(0, Number(usage.inputTokens || 0)),
        output: Math.max(0, Number(usage.outputTokens || 0)),
        cacheCreation: Math.max(0, Number(usage.cacheCreationTokens || 0)),
        cacheRead: Math.max(0, Number(usage.cacheReadTokens || 0)),
        thinking: Math.max(0, Number(usage.thinkingTokens || 0)),
        totalTokens: Math.max(0, Number(usage.totalTokens || 0)),
      });
      const metric =
        filled.input +
        filled.output +
        filled.cacheCreation +
        filled.cacheRead +
        filled.thinking;
      const better =
        metric > bestMetric ||
        (metric === bestMetric && mtimeMs > bestMtime) ||
        (metric === bestMetric &&
          mtimeMs === bestMtime &&
          (best === null || filePath.localeCompare(best) < 0));
      if (better) {
        best = filePath;
        bestMetric = metric;
        bestMtime = mtimeMs;
      }
    }
    out.push(best || group[0]);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function parseDroidIncremental({
  settingsFiles,
  cursors,
  queuePath,
  projectQueuePath,
  publicRepoResolver,
  onProgress,
  env,
  // `prune: true` (the production default) drops cursor entries whose session
  // id was not observed this run — handles `.settings.json` files removed
  // off disk so the cursor doesn't grow unbounded. Tests that pass an
  // intentionally partial `settingsFiles` list should set `prune: false` to
  // keep unobserved entries.
  prune = true,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const droidState =
    cursors.droid && typeof cursors.droid === "object" ? cursors.droid : {};
  const sessionTotals =
    droidState.sessionTotals && typeof droidState.sessionTotals === "object"
      ? { ...droidState.sessionTotals }
      : {};
  const projectSessionTotals =
    droidState.projectSessionTotals && typeof droidState.projectSessionTotals === "object"
      ? { ...droidState.projectSessionTotals }
      : {};

  const files = dedupeDroidSettingsFilesBySession(
    Array.isArray(settingsFiles)
      ? settingsFiles
      : listDroidSettingsFiles(env || process.env),
  );

  if (files.length === 0) {
    cursors.droid = {
      ...droidState,
      sessionTotals,
      ...(projectEnabled ? { projectSessionTotals } : {}),
      updatedAt: new Date().toISOString(),
    };
    return {
      recordsProcessed: 0,
      eventsAggregated: 0,
      bucketsQueued: 0,
      projectBucketsQueued: 0,
    };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const projectFreshnessCache = projectEnabled ? new Map() : null;
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  // Track which session ids we observed this run so we can prune cursor
  // entries for files that disappeared off disk — keeps the cursor bounded
  // by actual session count without the false-first-sight re-emit bug that
  // a fixed-N cap would introduce (evicted-but-still-on-disk entries would
  // resurrect as zero-prev on the next sync and re-count their cumulative).
  const seenSessionIds = new Set();

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    recordsProcessed++;

    let mtimeMs = 0;
    try {
      mtimeMs = fssync.statSync(filePath).mtimeMs;
    } catch (e) {
      if (e && e.code === "ENOENT") continue;
      throw e;
    }

    // Key by session id (the UUID-style filename without `.settings.json`)
    // so the cursor survives FACTORY_DIR / HOME / mount-point migrations.
    // Mirrors ccusage's session_id derivation (parser.rs::load_settings_file).
    const sessionId = droidSessionIdFromPath(filePath);
    if (!sessionId) continue;
    seenSessionIds.add(sessionId);

    const prev = sessionTotals[sessionId] || {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      thinking: 0,
      mtimeMs: 0,
    };
    const projectPrev = projectSessionTotals[sessionId] || {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      thinking: 0,
      mtimeMs: 0,
      filePath: null,
      attributed: false,
      projectFileContext: null,
    };
    const isFirstSeenSession = !sessionTotals[sessionId];
    const globalNeedsUpdate = !(mtimeMs && mtimeMs === prev.mtimeMs);
    let projectNeedsUpdate = false;
    if (projectEnabled) {
      const projectFileChanged =
        !mtimeMs || mtimeMs !== projectPrev.mtimeMs || projectPrev.filePath !== filePath;
      if (!projectSessionTotals[sessionId] || projectFileChanged) {
        projectNeedsUpdate = true;
      } else if (projectPrev.attributed !== true) {
        projectNeedsUpdate = !(await isProjectFileContextFresh(
          projectPrev.projectFileContext,
          { freshnessCache: projectFreshnessCache },
        ));
      }
    }
    if (!globalNeedsUpdate && !projectNeedsUpdate) continue;

    let raw;
    try {
      raw = fssync.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let settings;
    try {
      settings = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!settings || typeof settings !== "object") continue;
    const tokenUsage = settings.tokenUsage;
    if (!tokenUsage || typeof tokenUsage !== "object") continue;

    const filled = applyDroidTotalFallback({
      input: Math.max(0, Number(tokenUsage.inputTokens || 0)),
      output: Math.max(0, Number(tokenUsage.outputTokens || 0)),
      cacheCreation: Math.max(0, Number(tokenUsage.cacheCreationTokens || 0)),
      cacheRead: Math.max(0, Number(tokenUsage.cacheReadTokens || 0)),
      thinking: Math.max(0, Number(tokenUsage.thinkingTokens || 0)),
      totalTokens: Math.max(0, Number(tokenUsage.totalTokens || 0)),
    });
    const inputNow = filled.input;
    const outputNow = filled.output;
    const cacheCreationNow = filled.cacheCreation;
    const cacheReadNow = filled.cacheRead;
    const thinkingNow = filled.thinking;
    const sumNow =
      inputNow + outputNow + cacheCreationNow + cacheReadNow + thinkingNow;
    const sumPrev =
      prev.input + prev.output + prev.cacheCreation + prev.cacheRead + prev.thinking;
    const projectSumPrev =
      projectPrev.input +
      projectPrev.output +
      projectPrev.cacheCreation +
      projectPrev.cacheRead +
      projectPrev.thinking;

    // Transient empty: settings.json was observed with zero tokens (mid-write
    // or a brief wipe before the next turn restores totals). Do NOT clobber
    // the existing per-field baseline — only bump mtimeMs so we don't re-read
    // the same empty payload next sync. If we overwrote prev with zeros, a
    // later non-empty read would emit the full cumulative as a fresh delta.
    if (sumNow === 0) {
      if (globalNeedsUpdate) {
        if (sumPrev > 0) {
          sessionTotals[sessionId] = { ...prev, mtimeMs };
        } else {
          sessionTotals[sessionId] = {
            input: 0,
            output: 0,
            cacheCreation: 0,
            cacheRead: 0,
            thinking: 0,
            mtimeMs,
          };
        }
      }
      if (projectNeedsUpdate) {
        projectSessionTotals[sessionId] =
          projectSumPrev > 0
            ? { ...projectPrev, mtimeMs, filePath }
            : {
                input: 0,
                output: 0,
                cacheCreation: 0,
                cacheRead: 0,
                thinking: 0,
                mtimeMs,
                filePath,
                attributed: false,
                projectFileContext: buildProjectFileContext(null),
              };
      }
      continue;
    }

    const bucketStart = toUtcHalfHourStart(
      new Date(mtimeMs || Date.now()).toISOString(),
    );
    if (!bucketStart) continue;

    // Model resolution mirrors ccusage's chain: settings.model → sidecar
    // <id>.jsonl scrape → `<provider>-unknown` derived from providerLock or
    // inferred from the model fragment we did find. Same fallback string set
    // (claude-unknown / gpt-unknown / gemini-unknown / grok-unknown) so
    // empty-model sessions bucket identically across both tools.
    const model = resolveDroidModel(settings, filePath);

    if (globalNeedsUpdate) {
      // Reset only when the TOTAL shrinks — a real session reuse (Droid wiped
      // tokenUsage and started over). A single field dropping while the sum
      // grows is a schema change or cache eviction; clamping per-field deltas
      // to >=0 is the right behavior for those.
      const isReset = sumNow < sumPrev;
      const dInput = isReset ? inputNow : Math.max(0, inputNow - prev.input);
      const dOutput = isReset ? outputNow : Math.max(0, outputNow - prev.output);
      const dCacheCreation = isReset
        ? cacheCreationNow
        : Math.max(0, cacheCreationNow - prev.cacheCreation);
      const dCacheRead = isReset
        ? cacheReadNow
        : Math.max(0, cacheReadNow - prev.cacheRead);
      const dThinking = isReset
        ? thinkingNow
        : Math.max(0, thinkingNow - prev.thinking);

      if (dInput + dOutput + dCacheCreation + dCacheRead + dThinking > 0) {
        // Token normalization: inputTokens already excludes cache reads (matches
        // Anthropic API convention), so cache columns slot in directly. Thinking
        // is reasoning_output_tokens — folded into cost via existing pricing path.
        const bucketDelta = {
          input_tokens: dInput,
          cached_input_tokens: dCacheRead,
          cache_creation_input_tokens: dCacheCreation,
          output_tokens: dOutput,
          reasoning_output_tokens: dThinking,
          total_tokens: dInput + dOutput + dCacheCreation + dCacheRead + dThinking,
          conversation_count: isFirstSeenSession || isReset ? 1 : 0,
        };
        const bucket = getHourlyBucket(hourlyState, "droid", model, bucketStart);
        addTotals(bucket.totals, bucketDelta);
        touchedBuckets.add(bucketKey("droid", model, bucketStart));
        eventsAggregated++;
      }

      sessionTotals[sessionId] = {
        input: inputNow,
        output: outputNow,
        cacheCreation: cacheCreationNow,
        cacheRead: cacheReadNow,
        thinking: thinkingNow,
        mtimeMs,
      };
    }

    if (projectNeedsUpdate) {
      const cwd = await resolveDroidFileCwd(filePath);
      const projectContext = cwd
        ? await resolveProjectContextForPath({
            startDir: wsl.mapWslCwdToUnc(cwd, filePath),
            projectMetaCache,
            publicRepoCache,
            publicRepoResolver,
            projectState,
          })
        : null;
      const projectRef = projectContext?.projectRef || null;
      const projectKey = projectContext?.projectKey || null;
      const projectFileContext = buildProjectFileContext(projectContext);

      // Keep this baseline independent from the global cursor so project
      // attribution can be backfilled once without replaying global usage.
      // If the repo is not public/verified yet, leave it unadvanced so a later
      // sync can retry after project metadata or network availability changes.
      if (projectKey && projectRef) {
        const projectReset = sumNow < projectSumPrev;
        const projectDInput = projectReset
          ? inputNow
          : Math.max(0, inputNow - projectPrev.input);
        const projectDOutput = projectReset
          ? outputNow
          : Math.max(0, outputNow - projectPrev.output);
        const projectDCacheCreation = projectReset
          ? cacheCreationNow
          : Math.max(0, cacheCreationNow - projectPrev.cacheCreation);
        const projectDCacheRead = projectReset
          ? cacheReadNow
          : Math.max(0, cacheReadNow - projectPrev.cacheRead);
        const projectDThinking = projectReset
          ? thinkingNow
          : Math.max(0, thinkingNow - projectPrev.thinking);
        const projectTotal =
          projectDInput +
          projectDOutput +
          projectDCacheCreation +
          projectDCacheRead +
          projectDThinking;
        if (projectTotal > 0) {
          const projectDelta = {
            input_tokens: projectDInput,
            cached_input_tokens: projectDCacheRead,
            cache_creation_input_tokens: projectDCacheCreation,
            output_tokens: projectDOutput,
            reasoning_output_tokens: projectDThinking,
            total_tokens: projectTotal,
            conversation_count: !projectSessionTotals[sessionId] || projectReset ? 1 : 0,
          };
          const projectBucket = getProjectBucket(
            projectState,
            projectKey,
            "droid",
            bucketStart,
            projectRef,
          );
          addTotals(projectBucket.totals, projectDelta);
          projectTouchedBuckets.add(
            projectBucketKey(projectKey, "droid", bucketStart),
          );
        }
        projectSessionTotals[sessionId] = {
          input: inputNow,
          output: outputNow,
          cacheCreation: cacheCreationNow,
          cacheRead: cacheReadNow,
          thinking: thinkingNow,
          mtimeMs,
          filePath,
          projectKey,
          projectRef,
          attributed: true,
          projectFileContext,
        };
      } else {
        projectSessionTotals[sessionId] = {
          input: 0,
          output: 0,
          cacheCreation: 0,
          cacheRead: 0,
          thinking: 0,
          mtimeMs,
          filePath,
          projectKey: null,
          projectRef,
          attributed: false,
          projectFileContext,
        };
      }
    }

    if (cb) {
      cb({
        index: i + 1,
        total: files.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  // Prune cursor entries for sessions that no longer appear on disk. Driven
  // by an explicit `prune` flag (default true) — not by the shape of
  // `settingsFiles` — so production callers that pass an explicit file list
  // still get pruning, while tests passing an intentionally partial subset
  // can opt out with `prune: false`.
  if (prune) {
    for (const id of Object.keys(sessionTotals)) {
      if (!seenSessionIds.has(id)) delete sessionTotals[id];
    }
    for (const id of Object.keys(projectSessionTotals)) {
      if (!seenSessionIds.has(id)) delete projectSessionTotals[id];
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({
    queuePath,
    hourlyState,
    touchedBuckets,
  });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({
        projectQueuePath,
        projectState,
        projectTouchedBuckets,
      })
    : 0;
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = updatedAt;
    cursors.projectHourly = projectState;
  }
  cursors.droid = {
    ...droidState,
    sessionTotals,
    ...(projectEnabled ? { projectSessionTotals } : {}),
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function parseKilocodeIncremental({
  taskFiles,
  cursors,
  queuePath,
  onProgress,
  env,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const kilocodeState =
    cursors.kilocode && typeof cursors.kilocode === "object" ? cursors.kilocode : {};
  const seenIds = new Set(
    Array.isArray(kilocodeState.seenIds) ? kilocodeState.seenIds : [],
  );
  const fileOffsets =
    kilocodeState.fileOffsets && typeof kilocodeState.fileOffsets === "object"
      ? { ...kilocodeState.fileOffsets }
      : {};

  const files = Array.isArray(taskFiles)
    ? taskFiles
    : resolveKilocodeTaskFiles(env || process.env);

  if (files.length === 0) {
    cursors.kilocode = {
      ...kilocodeState,
      seenIds: Array.from(seenIds),
      fileOffsets,
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const entry = files[fileIdx];
    const { filePath, taskUuid } = entry;
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    const prevEntry = fileOffsets[filePath];
    if (
      prevEntry &&
      Number(prevEntry.size) === stat.size &&
      Number(prevEntry.mtimeMs) === stat.mtimeMs
    ) {
      continue;
    }

    let raw;
    try { raw = fssync.readFileSync(filePath, "utf8"); } catch { continue; }
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(data)) continue;

    for (const msg of data) {
      if (!msg || typeof msg !== "object") continue;
      // `api_req_started` is the live billing record; `api_req_deleted` keeps
      // the same payload when a user removes a turn from the task (Cline-style
      // edit-and-retry) — tokens were already consumed by the provider, so we
      // still count them.
      if (msg.say !== "api_req_started" && msg.say !== "api_req_deleted") continue;
      if (typeof msg.text !== "string" || !msg.text.startsWith("{")) continue;

      let payload;
      try { payload = JSON.parse(msg.text); } catch { continue; }
      if (!payload || typeof payload !== "object") continue;

      const ts = Number(msg.ts);
      if (!Number.isFinite(ts) || ts <= 0) continue;

      const dedupKey = `${taskUuid}:${ts}`;
      recordsProcessed++;
      if (seenIds.has(dedupKey)) continue;

      const tokensIn = toNonNegativeInt(payload.tokensIn);
      const tokensOut = toNonNegativeInt(payload.tokensOut);
      const cacheReads = toNonNegativeInt(payload.cacheReads);
      const cacheWrites = toNonNegativeInt(payload.cacheWrites);
      if (tokensIn === 0 && tokensOut === 0 && cacheReads === 0 && cacheWrites === 0) {
        // See the roocode parser: `api_req_started` is written at request
        // START with zero tokens and back-filled in place (same ts) on
        // completion. Marking the placeholder seen would drop the
        // back-filled tokens forever when a sync races an in-flight request.
        continue;
      }

      const tsIso = new Date(ts).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const delta = {
        input_tokens: tokensIn,
        cached_input_tokens: cacheReads,
        cache_creation_input_tokens: cacheWrites,
        output_tokens: tokensOut,
        reasoning_output_tokens: 0,
        total_tokens: tokensIn + tokensOut + cacheReads + cacheWrites,
        conversation_count: 1,
      };

      const model = normalizeKilocodeProviderToModel(payload.inferenceProvider);
      const bucket = getHourlyBucket(hourlyState, "kilo-code", model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("kilo-code", model, bucketStart));
      seenIds.add(dedupKey);
      eventsAggregated++;
    }

    fileOffsets[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };

    if (cb) {
      cb({
        index: fileIdx + 1,
        total: files.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  // Cap seenIds to last 50k to bound cursor state size
  const seenArr = Array.from(seenIds);
  const cappedSeen = seenArr.length > 50_000 ? seenArr.slice(seenArr.length - 50_000) : seenArr;

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.kilocode = { ...kilocodeState, seenIds: cappedSeen, fileOffsets, updatedAt };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

async function parseOmpIncremental({
  sessionFiles,
  subagentFiles,
  cursors,
  queuePath,
  projectQueuePath,
  publicRepoResolver,
  onProgress,
  env,
  defaultModel,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const ompState = cursors.omp && typeof cursors.omp === "object" ? cursors.omp : {};
  const seenIds = new Set(Array.isArray(ompState.seenIds) ? ompState.seenIds : []);
  const projectSeenIds = new Set(
    Array.isArray(ompState.projectSeenIds) ? ompState.projectSeenIds : [],
  );
  const fileOffsets =
    ompState.fileOffsets && typeof ompState.fileOffsets === "object"
      ? { ...ompState.fileOffsets }
      : {};
  const projectFileOffsets =
    ompState.projectFileOffsets && typeof ompState.projectFileOffsets === "object"
      ? { ...ompState.projectFileOffsets }
      : {};

  const mainFiles = Array.isArray(sessionFiles)
    ? sessionFiles
    : resolveOmpSessionFiles(env || process.env);
  // Subagent transcripts share the session format and count toward the same
  // "omp" totals; they're discovered separately because they nest below the
  // cwd level. When the caller supplies explicit sessionFiles (tests), don't
  // auto-resolve — keep the parse hermetic.
  const subFiles = Array.isArray(subagentFiles)
    ? subagentFiles
    : Array.isArray(sessionFiles)
      ? []
      : resolveOmpSubagentFiles(env || process.env);
  const files = [...mainFiles, ...subFiles];
  const fallbackModel = defaultModel || resolveOmpDefaultModel();

  if (files.length === 0) {
    cursors.omp = {
      ...ompState,
      seenIds: Array.from(seenIds),
      fileOffsets,
      ...(projectEnabled
        ? {
            projectSeenIds: Array.from(projectSeenIds),
            projectFileOffsets,
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    return {
      recordsProcessed: 0,
      eventsAggregated: 0,
      bucketsQueued: 0,
      projectBucketsQueued: 0,
    };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    // Re-read from start if file shrunk (truncate/rewrite) or inode changed.
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    if (stat.size <= startOffset) continue;

    let stream;
    try {
      stream = fssync.createReadStream(filePath, {
        encoding: "utf8",
        start: startOffset,
      });
    } catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      // First line of each file is type:"session" (header) — skip all
      // non-message records.
      if (!entry || entry.type !== "message") continue;

      // Only assistant messages carry token usage.
      const msg = entry.message;
      if (!msg || msg.role !== "assistant") continue;

      const usage = msg.usage;
      if (!usage || typeof usage !== "object") continue;

      // Dedup by top-level entry id (8-char string assigned by oh-my-pi).
      const entryId = typeof entry.id === "string" && entry.id ? entry.id : null;
      if (!entryId) continue;
      if (seenIds.has(entryId)) continue;

      recordsProcessed++;

      const input = toNonNegativeInt(usage.input);
      const output = toNonNegativeInt(usage.output);
      const cacheRead = toNonNegativeInt(usage.cacheRead);
      const cacheWrite = toNonNegativeInt(usage.cacheWrite);
      const reasoningTokens = toNonNegativeInt(usage.reasoningTokens);

      if (
        input === 0 &&
        output === 0 &&
        cacheRead === 0 &&
        cacheWrite === 0 &&
        reasoningTokens === 0
      ) {
        seenIds.add(entryId);
        continue;
      }

      // Prefer message-level timestamp (ms epoch); fall back to entry-level
      // ISO string. Entries with no resolvable timestamp are skipped — they
      // cannot be placed in a bucket.
      let tsMs = null;
      if (Number.isFinite(Number(msg.timestamp)) && Number(msg.timestamp) > 0) {
        tsMs = Number(msg.timestamp);
      } else if (typeof entry.timestamp === "string" && entry.timestamp) {
        const parsed = Date.parse(entry.timestamp);
        if (Number.isFinite(parsed) && parsed > 0) tsMs = parsed;
      }
      if (tsMs == null) {
        seenIds.add(entryId);
        continue;
      }

      const tsIso = new Date(tsMs).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      // Use provided totalTokens when available; otherwise sum all components.
      const totalTokens =
        Number.isFinite(Number(usage.totalTokens)) && Number(usage.totalTokens) > 0
          ? toNonNegativeInt(usage.totalTokens)
          : input + output + cacheRead + cacheWrite + reasoningTokens;

      const model = normalizeModelInput(msg.model) || fallbackModel;

      const delta = {
        input_tokens: input,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        output_tokens: output,
        reasoning_output_tokens: reasoningTokens,
        total_tokens: totalTokens,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, "omp", model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("omp", model, bucketStart));
      seenIds.add(entryId);
      eventsAggregated++;

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: files.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    let postStat = stat;
    try { postStat = fssync.statSync(filePath); } catch {}
    fileOffsets[filePath] = {
      size: postStat.size,
      mtimeMs: postStat.mtimeMs,
      ino: postStat.ino,
    };
  }

  // Project attribution has an independent cursor so upgrading an existing
  // installation can backfill already-consumed OMP sessions without adding
  // those messages to the total-usage buckets a second time. Current OMP
  // session headers persist the real cwd; unlike the encoded session folder,
  // it is lossless even when path components contain dashes.
  if (projectEnabled) {
    for (const filePath of files) {
      let stat;
      try { stat = fssync.statSync(filePath); } catch { continue; }

      const prevEntry = projectFileOffsets[filePath] || {};
      const prevSize = Number(prevEntry.size) || 0;
      const prevIno = prevEntry.ino;
      const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
      const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
      if (stat.size <= startOffset) continue;

      const cwd = await resolveOmpFileCwd(filePath);
      const projectContext = cwd
        ? await resolveProjectContextForPath({
            startDir: wsl.mapWslCwdToUnc(cwd, filePath),
            projectMetaCache,
            publicRepoCache,
            publicRepoResolver,
            projectState,
          })
        : null;
      const projectRef = projectContext?.projectRef || null;
      const projectKey = projectContext?.projectKey || null;

      if (projectKey && projectRef) {
        let stream;
        try {
          stream = fssync.createReadStream(filePath, {
            encoding: "utf8",
            start: startOffset,
          });
        } catch {
          continue;
        }
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line || !line.trim()) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          const msg = entry?.type === "message" ? entry.message : null;
          const usage = msg?.role === "assistant" ? msg.usage : null;
          if (!usage || typeof usage !== "object") continue;

          const entryId = typeof entry.id === "string" && entry.id ? entry.id : null;
          if (!entryId || projectSeenIds.has(entryId)) continue;

          const input = toNonNegativeInt(usage.input);
          const output = toNonNegativeInt(usage.output);
          const cacheRead = toNonNegativeInt(usage.cacheRead);
          const cacheWrite = toNonNegativeInt(usage.cacheWrite);
          const reasoningTokens = toNonNegativeInt(usage.reasoningTokens);
          if (
            input === 0 &&
            output === 0 &&
            cacheRead === 0 &&
            cacheWrite === 0 &&
            reasoningTokens === 0
          ) {
            projectSeenIds.add(entryId);
            continue;
          }

          let tsMs = null;
          if (Number.isFinite(Number(msg.timestamp)) && Number(msg.timestamp) > 0) {
            tsMs = Number(msg.timestamp);
          } else if (typeof entry.timestamp === "string" && entry.timestamp) {
            const parsed = Date.parse(entry.timestamp);
            if (Number.isFinite(parsed) && parsed > 0) tsMs = parsed;
          }
          const bucketStart = tsMs == null
            ? null
            : toUtcHalfHourStart(new Date(tsMs).toISOString());
          if (!bucketStart) {
            projectSeenIds.add(entryId);
            continue;
          }

          const totalTokens =
            Number.isFinite(Number(usage.totalTokens)) && Number(usage.totalTokens) > 0
              ? toNonNegativeInt(usage.totalTokens)
              : input + output + cacheRead + cacheWrite + reasoningTokens;
          const delta = {
            input_tokens: input,
            cached_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheWrite,
            output_tokens: output,
            reasoning_output_tokens: reasoningTokens,
            total_tokens: totalTokens,
            conversation_count: 1,
          };
          const projectBucket = getProjectBucket(
            projectState,
            projectKey,
            "omp",
            bucketStart,
            projectRef,
          );
          addTotals(projectBucket.totals, delta);
          projectTouchedBuckets.add(projectBucketKey(projectKey, "omp", bucketStart));
          projectSeenIds.add(entryId);
        }
      }

      let postStat = stat;
      try { postStat = fssync.statSync(filePath); } catch {}
      projectFileOffsets[filePath] = {
        size: postStat.size,
        mtimeMs: postStat.mtimeMs,
        ino: postStat.ino,
      };
    }
  }

  // Cap dedup set to last 10k IDs to bound cursor state size — same convention
  // as Kimi/CodeBuddy/Copilot so cursors.json doesn't grow unbounded.
  const seenArr = Array.from(seenIds);
  const cappedSeen =
    seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;
  const projectSeenArr = Array.from(projectSeenIds);
  const cappedProjectSeen =
    projectSeenArr.length > 10_000
      ? projectSeenArr.slice(projectSeenArr.length - 10_000)
      : projectSeenArr;

  const bucketsQueued = await enqueueTouchedBuckets({
    queuePath,
    hourlyState,
    touchedBuckets,
  });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({
        projectQueuePath,
        projectState,
        projectTouchedBuckets,
      })
    : 0;
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = updatedAt;
    cursors.projectHourly = projectState;
  }
  cursors.omp = {
    ...ompState,
    seenIds: cappedSeen,
    fileOffsets,
    ...(projectEnabled
      ? {
          projectSeenIds: cappedProjectSeen,
          projectFileOffsets,
        }
      : {}),
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// pi (@mariozechner/pi-coding-agent) — passive JSONL reader
// (~/.pi/agent/sessions/**/*.jsonl)
//
// Same on-disk session format as oh-my-pi (omp): one JSONL file per session,
// first line type:"session" header, then a tree of message/model_change/etc.
// records. Token usage lives on type:"message" entries with role:"assistant"
// under message.usage.
//
// PI_CODING_AGENT_DIR is shared with omp (both upstream tools document it).
// resolvePiAgentDir / resolveOmpAgentDir use decidePiCodingAgentDirOwner to
// route the override to exactly one provider so the same sessions dir is
// never scanned twice.
// ─────────────────────────────────────────────────────────────────────────────

function resolvePiHome(env = process.env) {
  const home = env.HOME || require("node:os").homedir();
  if (process.platform === "win32") {
    return pickWin32ProviderPath({
      env,
      nativeValue: path.join(home, ".pi"),
      wslProviderDir: ".pi",
    });
  }
  return path.join(home, ".pi");
}

function resolvePiAgentDir(env = process.env) {
  if (env.TOKENTRACKER_PI_AGENT_DIR) {
    return expandHomePath(env.TOKENTRACKER_PI_AGENT_DIR, env);
  }
  if (env.PI_CODING_AGENT_DIR && decidePiCodingAgentDirOwner(env) === "pi") {
    return expandHomePath(env.PI_CODING_AGENT_DIR, env);
  }
  const piHome = resolvePiHome(env);
  return piHome ? path.join(piHome, "agent") : null;
}

// Defense in depth for invariant 2 (no double-count). Two explicit overrides
// pointing at the same path (e.g. TOKENTRACKER_OMP_AGENT_DIR === TOKENTRACKER_PI_AGENT_DIR,
// or TOKENTRACKER_OMP_AGENT_DIR === PI_CODING_AGENT_DIR with ~/.pi present) bypass
// the install-signal disambiguator and would otherwise have both providers scan
// the same sessions directory under different `source` tags.
function piAgentDirCollidesWithOmp(env = process.env) {
  const piAgentDir = resolvePiAgentDir(env);
  const ompAgentDir = resolveOmpAgentDir(env);
  if (!piAgentDir || !ompAgentDir) return false;
  return path.resolve(piAgentDir) === path.resolve(ompAgentDir);
}

function resolvePiSessionFiles(env = process.env) {
  const agentDir = resolvePiAgentDir(env);
  if (!agentDir) return [];
  const sessionsDir = path.join(agentDir, "sessions");
  if (!fssync.existsSync(sessionsDir)) return [];
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fssync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  };
  try {
    for (const cwdDir of fssync.readdirSync(sessionsDir)) {
      const cwdPath = path.join(sessionsDir, cwdDir);
      let stat;
      try { stat = fssync.statSync(cwdPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      walk(cwdPath);
    }
  } catch {
    // ignore — return what we have
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function resolvePiDefaultModel() {
  // pi has no global default model; model is per-message.
  return "pi-unknown";
}

// Prime Agent (PrimeIntellect-ai/prime-agent) persists the same metadata-only
// assistant usage envelope as pi, but uses a flat sessions directory:
//   ~/.prime/agent/sessions/<session-id>.jsonl
// Keep its path and cursor namespace independent from pi so installations of
// both tools can never suppress or double-count each other.
function resolvePrimeAgentHome(env = process.env) {
  if (env.TOKENTRACKER_PRIME_AGENT_HOME) {
    return expandHomePath(env.TOKENTRACKER_PRIME_AGENT_HOME, env);
  }
  const home = env.HOME || require("node:os").homedir();
  if (process.platform === "win32") {
    return pickWin32ProviderPath({
      env,
      nativeValue: path.join(home, ".prime"),
      wslProviderDir: ".prime",
    });
  }
  return path.join(home, ".prime");
}

function resolvePrimeAgentDir(env = process.env) {
  if (env.TOKENTRACKER_PRIME_AGENT_DIR) {
    return expandHomePath(env.TOKENTRACKER_PRIME_AGENT_DIR, env);
  }
  const primeHome = resolvePrimeAgentHome(env);
  return primeHome ? path.join(primeHome, "agent") : null;
}

function resolvePrimeAgentSessionFiles(env = process.env) {
  const agentDir = resolvePrimeAgentDir(env);
  if (!agentDir) return [];
  const sessionsDir = path.join(agentDir, "sessions");
  if (!fssync.existsSync(sessionsDir)) return [];
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fssync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(sessionsDir);
  return files.sort((a, b) => a.localeCompare(b));
}

function resolvePrimeAgentDefaultModel() {
  return "prime-agent-unknown";
}

// Pi is a router: the same session can send turns to Anthropic, GitHub
// Copilot, or another backend. Keep provider names in the queue source so
// those turns cannot collapse into one bucket (or inherit the wrong pricing).
// Missing providers are deliberately kept on the historical `pi` source for
// compatibility with older session formats and already-synced data.
function piSourceForProvider(provider) {
  if (typeof provider !== "string" || !provider.trim()) return "pi";
  const slug = provider
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug ? `pi-${slug}` : "pi";
}

function primeAgentSourceForProvider(provider) {
  if (typeof provider !== "string" || !provider.trim()) return "prime-agent";
  const slug = provider
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug ? `prime-agent-${slug}` : "prime-agent";
}

async function parsePiLikeIncremental({
  sessionFiles,
  cursors,
  queuePath,
  onProgress,
  env,
  defaultModel,
  stateKey,
  resolveSessionFiles,
  resolveDefaultModel,
  sourceForProvider,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const providerState = cursors[stateKey] && typeof cursors[stateKey] === "object"
    ? cursors[stateKey]
    : {};
  const seenIds = new Set(Array.isArray(providerState.seenIds) ? providerState.seenIds : []);
  const fileOffsets =
    providerState.fileOffsets && typeof providerState.fileOffsets === "object"
      ? { ...providerState.fileOffsets }
      : {};

  const files = Array.isArray(sessionFiles)
    ? sessionFiles
    : resolveSessionFiles(env || process.env);
  const fallbackModel = defaultModel || resolveDefaultModel();

  if (files.length === 0) {
    cursors[stateKey] = {
      ...providerState,
      seenIds: Array.from(seenIds),
      fileOffsets,
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    if (stat.size <= startOffset) continue;

    let stream;
    let streamedBytes = 0;
    let lastCompleteOffset = startOffset;
    try {
      stream = fssync.createReadStream(filePath, {
        encoding: "utf8",
        start: startOffset,
      });
    } catch { continue; }
    // readline emits an unterminated final fragment as if it were a line. If
    // the producer is still writing that JSON object, parsing fails; advancing
    // to stat.size here would then lose the completed record forever. Track the
    // last physical newline and commit only through that byte boundary.
    stream.on("data", (chunk) => {
      let searchFrom = 0;
      let newlineIndex;
      while ((newlineIndex = chunk.indexOf("\n", searchFrom)) !== -1) {
        lastCompleteOffset = startOffset
          + streamedBytes
          + Buffer.byteLength(chunk.slice(0, newlineIndex + 1), "utf8");
        searchFrom = newlineIndex + 1;
      }
      streamedBytes += Buffer.byteLength(chunk, "utf8");
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (!entry || entry.type !== "message") continue;

      const msg = entry.message;
      if (!msg || msg.role !== "assistant") continue;

      const usage = msg.usage;
      if (!usage || typeof usage !== "object") continue;

      const entryId = typeof entry.id === "string" && entry.id ? entry.id : null;
      if (!entryId) continue;
      if (seenIds.has(entryId)) continue;

      recordsProcessed++;

      const input = toNonNegativeInt(usage.input);
      const output = toNonNegativeInt(usage.output);
      const cacheRead = toNonNegativeInt(usage.cacheRead);
      const cacheWrite = toNonNegativeInt(usage.cacheWrite);
      const reasoningTokens = toNonNegativeInt(usage.reasoningTokens);

      if (
        input === 0 &&
        output === 0 &&
        cacheRead === 0 &&
        cacheWrite === 0 &&
        reasoningTokens === 0
      ) {
        seenIds.add(entryId);
        continue;
      }

      let tsMs = null;
      if (Number.isFinite(Number(msg.timestamp)) && Number(msg.timestamp) > 0) {
        tsMs = Number(msg.timestamp);
      } else if (typeof entry.timestamp === "string" && entry.timestamp) {
        const parsed = Date.parse(entry.timestamp);
        if (Number.isFinite(parsed) && parsed > 0) tsMs = parsed;
      }
      if (tsMs == null) {
        seenIds.add(entryId);
        continue;
      }

      const tsIso = new Date(tsMs).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const totalTokens =
        Number.isFinite(Number(usage.totalTokens)) && Number(usage.totalTokens) > 0
          ? toNonNegativeInt(usage.totalTokens)
          : input + output + cacheRead + cacheWrite + reasoningTokens;

      const model = normalizeModelInput(msg.model) || fallbackModel;
      const source = sourceForProvider(msg.provider);

      const delta = {
        input_tokens: input,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        output_tokens: output,
        reasoning_output_tokens: reasoningTokens,
        total_tokens: totalTokens,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey(source, model, bucketStart));
      seenIds.add(entryId);
      eventsAggregated++;

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: files.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    let postStat = stat;
    try { postStat = fssync.statSync(filePath); } catch {}
    fileOffsets[filePath] = {
      size: Math.min(lastCompleteOffset, postStat.size),
      mtimeMs: postStat.mtimeMs,
      ino: postStat.ino,
    };
  }

  const seenArr = Array.from(seenIds);
  const cappedSeen =
    seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;

  const bucketsQueued = await enqueueTouchedBuckets({
    queuePath,
    hourlyState,
    touchedBuckets,
  });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors[stateKey] = {
    ...providerState,
    seenIds: cappedSeen,
    fileOffsets,
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

async function parsePiIncremental(options = {}) {
  return parsePiLikeIncremental({
    ...options,
    stateKey: "pi",
    resolveSessionFiles: resolvePiSessionFiles,
    resolveDefaultModel: resolvePiDefaultModel,
    sourceForProvider: piSourceForProvider,
  });
}

async function parsePrimeAgentIncremental(options = {}) {
  return parsePiLikeIncremental({
    ...options,
    stateKey: "primeAgent",
    resolveSessionFiles: resolvePrimeAgentSessionFiles,
    resolveDefaultModel: resolvePrimeAgentDefaultModel,
    sourceForProvider: primeAgentSourceForProvider,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Craft Agents (lukilabs/craft-agents-oss) — passive JSONL reader
//
// Craft is a desktop Electron agent that wraps the Claude Agent SDK plus
// multiple LLM backends (Anthropic, OpenAI, Google, GitHub Copilot, OpenRouter,
// Groq, Mistral, DeepSeek, xAI, Bedrock, Vertex). It writes per-session JSONL
// files with a pre-aggregated SessionTokenUsage block on the FIRST line:
//
//   line 1: SessionHeader
//     {
//       "id": "260430-swift-river",
//       "model": "claude-sonnet-4-6",
//       "llmConnection": "anthropic-default",
//       "lastMessageAt": 1745003600000,
//       "tokenUsage": {
//         "inputTokens": 1234,            ← pure non-cached input
//         "outputTokens": 567,
//         "totalTokens": 9876,
//         "cacheReadTokens": 5500,
//         "cacheCreationTokens": 1100
//       }
//     }
//   line 2..N: StoredMessage records (we do not need them for token totals)
//
// Disk layout:
//   ~/.craft-agent/                    ← config dir (override: CRAFT_CONFIG_DIR)
//     config.json                      ← workspaces[].rootPath list
//     workspaces/<id>/sessions/<sid>/session.jsonl  (default)
//   <user-chosen-rootPath>/sessions/<sid>/session.jsonl  (custom workspaces)
//
// Workspaces can be relocated outside ~/.craft-agent, so we MUST read
// config.json to enumerate every rootPath rather than just globbing the
// default directory.
//
// Token semantics map directly onto TokenTracker conventions — `inputTokens`
// is already pure non-cached input (no Codex-style trap, see
// feedback_rollout_input_semantics.md). Re-parses are idempotent: the header
// is rewritten as the session grows, and we dedup by sessionId combined with
// the most-recent header byte length so a growing total replaces the old
// snapshot instead of double-counting.
// ─────────────────────────────────────────────────────────────────────────────

function resolveCraftConfigDir(env = process.env) {
  if (env.CRAFT_CONFIG_DIR) return env.CRAFT_CONFIG_DIR;
  const home = env.HOME || require("node:os").homedir();
  if (process.platform === "win32") {
    return pickWin32ProviderPath({
      env,
      nativeValue: path.join(home, ".craft-agent"),
      wslProviderDir: ".craft-agent",
    });
  }
  return path.join(home, ".craft-agent");
}

function resolveCraftWorkspaceRoots(env = process.env) {
  const configDir = resolveCraftConfigDir(env);
  if (!configDir) return [];
  const roots = new Set();
  // Always include the default workspaces directory so a fresh install (no
  // config.json yet) still gets discovered.
  const defaultWorkspaces = path.join(configDir, "workspaces");
  if (fssync.existsSync(defaultWorkspaces)) {
    try {
      for (const entry of fssync.readdirSync(defaultWorkspaces)) {
        const wsPath = path.join(defaultWorkspaces, entry);
        let stat;
        try { stat = fssync.statSync(wsPath); } catch { continue; }
        if (stat.isDirectory()) roots.add(wsPath);
      }
    } catch {
      // ignore
    }
  }
  // Layer in user-relocated workspaces from config.json.
  const configPath = path.join(configDir, "config.json");
  if (fssync.existsSync(configPath)) {
    try {
      const raw = fssync.readFileSync(configPath, "utf8");
      const cfg = JSON.parse(raw);
      const list = Array.isArray(cfg?.workspaces) ? cfg.workspaces : [];
      for (const ws of list) {
        const root = ws && typeof ws.rootPath === "string" ? ws.rootPath : null;
        if (root && fssync.existsSync(root)) roots.add(root);
      }
    } catch {
      // malformed config.json — fall back to default discovery only
    }
  }
  return Array.from(roots).sort((a, b) => a.localeCompare(b));
}

function resolveCraftSessionFiles(env = process.env) {
  const roots = resolveCraftWorkspaceRoots(env);
  if (roots.length === 0) return [];
  const files = [];
  for (const root of roots) {
    const sessionsDir = path.join(root, "sessions");
    if (!fssync.existsSync(sessionsDir)) continue;
    let entries;
    try { entries = fssync.readdirSync(sessionsDir); } catch { continue; }
    for (const sessionId of entries) {
      const sessionDir = path.join(sessionsDir, sessionId);
      let stat;
      try { stat = fssync.statSync(sessionDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const filePath = path.join(sessionDir, "session.jsonl");
      if (fssync.existsSync(filePath)) files.push(filePath);
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function resolveCraftDefaultModel() {
  // Craft is a router. Per-session header carries the actual model.
  return "craft-unknown";
}

// Reasonix persists content-free cumulative usage beside each session JSONL.
// Reading only these telemetry sidecars keeps prompts and tool output private.
function resolveReasonixHome(env = process.env) {
  if (env.TOKENTRACKER_REASONIX_HOME) {
    return expandHomePath(env.TOKENTRACKER_REASONIX_HOME, env);
  }
  if (env.REASONIX_STATE_HOME) {
    return expandHomePath(env.REASONIX_STATE_HOME, env);
  }
  const home = env.HOME || require("node:os").homedir();
  return path.join(home, ".reasonix");
}

function collectReasonixTelemetryFiles(dir, files) {
  if (!fssync.existsSync(dir)) return;
  let entries;
  try { entries = fssync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectReasonixTelemetryFiles(full, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl.telemetry.json")) files.push(full);
  }
}

function resolveReasonixTelemetryFiles(env = process.env) {
  const reasonixHome = resolveReasonixHome(env);
  const files = [];
  collectReasonixTelemetryFiles(path.join(reasonixHome, "projects"), files);
  collectReasonixTelemetryFiles(path.join(reasonixHome, "sessions"), files);
  return files.sort((a, b) => a.localeCompare(b));
}

function readReasonixSnapshot(filePath) {
  const telemetry = JSON.parse(fssync.readFileSync(filePath, "utf8"));
  const usage = telemetry?.usage;
  if (!usage || typeof usage !== "object") return null;
  const metaPath = filePath.slice(0, -".telemetry.json".length) + ".meta";
  let meta = {};
  try { meta = JSON.parse(fssync.readFileSync(metaPath, "utf8")); } catch {}
  const stat = fssync.statSync(filePath);
  return { usage, meta, stat };
}

function normalizeReasonixTotals(usage) {
  const prompt = toNonNegativeInt(usage.promptTokens);
  const reasoning = toNonNegativeInt(usage.reasoningTokens);
  const completion = toNonNegativeInt(usage.completionTokens);
  const cacheMiss = Math.min(prompt, toNonNegativeInt(usage.cacheMissTokens));
  const cacheHit = Math.min(prompt, toNonNegativeInt(usage.cacheHitTokens));
  const hasCacheMiss = usage.cacheMissTokens != null;
  const uncachedPrompt = hasCacheMiss ? cacheMiss : Math.max(0, prompt - cacheHit);
  const cacheWrite = Math.min(uncachedPrompt, toNonNegativeInt(usage.cacheWriteTokens));
  return {
    input: uncachedPrompt - cacheWrite,
    cacheRead: hasCacheMiss ? prompt - cacheMiss : cacheHit,
    cacheWrite,
    output: Math.max(0, completion - reasoning),
    reasoning,
    requests: toNonNegativeInt(usage.requestCount),
  };
}

function diffReasonixTotals(current, previous = {}) {
  const delta = {};
  for (const key of ["input", "cacheRead", "cacheWrite", "output", "reasoning", "requests"]) {
    delta[key] = Math.max(0, current[key] - toNonNegativeInt(previous[key]));
  }
  return delta;
}

function reasonixTimestamp(snapshot) {
  for (const value of [snapshot.meta.updated_at, snapshot.meta.created_at]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return snapshot.stat.mtimeMs;
}

function normalizeReasonixModel(value) {
  const normalized = normalizeModelInput(value);
  if (!normalized) return "reasonix-unknown";
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) || "reasonix-unknown";
}

function addReasonixDelta(hourlyState, touchedBuckets, snapshot, delta) {
  const bucketStart = toUtcHalfHourStart(new Date(reasonixTimestamp(snapshot)).toISOString());
  if (!bucketStart) return false;
  const model = normalizeReasonixModel(snapshot.meta.model);
  const total = delta.input + delta.cacheRead + delta.cacheWrite + delta.output + delta.reasoning;
  const bucket = getHourlyBucket(hourlyState, "reasonix", model, bucketStart);
  addTotals(bucket.totals, {
    input_tokens: delta.input,
    cached_input_tokens: delta.cacheRead,
    cache_creation_input_tokens: delta.cacheWrite,
    output_tokens: delta.output,
    reasoning_output_tokens: delta.reasoning,
    total_tokens: total,
    conversation_count: delta.requests,
  });
  touchedBuckets.add(bucketKey("reasonix", model, bucketStart));
  return true;
}

async function parseReasonixIncremental({ telemetryFiles, cursors, queuePath, onProgress, env } = {}) {
  await ensureDir(path.dirname(queuePath));
  const state = cursors.reasonix && typeof cursors.reasonix === "object" ? cursors.reasonix : {};
  const sessionTotals = { ...(state.sessionTotals || {}) };
  const files = Array.isArray(telemetryFiles) ? telemetryFiles : resolveReasonixTelemetryFiles(env);
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  for (const [index, filePath] of files.entries()) {
    let snapshot;
    try { snapshot = readReasonixSnapshot(filePath); } catch { continue; }
    if (!snapshot) continue;
    recordsProcessed++;
    const current = normalizeReasonixTotals(snapshot.usage);
    const delta = diffReasonixTotals(current, sessionTotals[filePath]);
    const tokenDelta = delta.input + delta.cacheRead + delta.cacheWrite + delta.output + delta.reasoning;
    if ((tokenDelta > 0 || delta.requests > 0) &&
        addReasonixDelta(hourlyState, touchedBuckets, snapshot, delta)) eventsAggregated++;
    sessionTotals[filePath] = current;
    onProgress?.({ index: index + 1, total: files.length, recordsProcessed, eventsAggregated, bucketsQueued: touchedBuckets.size });
  }
  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.reasonix = { ...state, sessionTotals, updatedAt };
  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

async function parseCraftIncremental({
  sessionFiles,
  cursors,
  queuePath,
  onProgress,
  env,
  defaultModel,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const craftState = cursors.craft && typeof cursors.craft === "object" ? cursors.craft : {};
  // Per-session previous totals so each re-parse only contributes the delta
  // of the running token totals (the header rewrites in place as the session
  // grows). Shape: { [sessionId]: { input, output, cacheRead, cacheWrite, total } }
  const sessionTotals =
    craftState.sessionTotals && typeof craftState.sessionTotals === "object"
      ? { ...craftState.sessionTotals }
      : {};

  const files = Array.isArray(sessionFiles)
    ? sessionFiles
    : resolveCraftSessionFiles(env || process.env);
  const fallbackModel = defaultModel || resolveCraftDefaultModel();

  if (files.length === 0) {
    cursors.craft = {
      ...craftState,
      sessionTotals,
      updatedAt: new Date().toISOString(),
    };
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    let stat;
    try { stat = fssync.statSync(filePath); } catch { continue; }

    // Read only the FIRST line — the SessionHeader carries the running totals.
    // Streaming the whole file would be wasted work since we don't use
    // per-message records for token accounting. We cap at 1 MiB to bound
    // memory if the first line is unexpectedly huge; real headers observed
    // in v0.9.0 are ~1–2 KiB so this is generous.
    let header = null;
    let parseError = null;
    let stream;
    try {
      stream = fssync.createReadStream(filePath, {
        encoding: "utf8",
        end: 1024 * 1024 - 1,
      });
    } catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      try {
        header = JSON.parse(line);
      } catch (e) {
        parseError = e;
        header = null;
      }
      break;
    }
    rl.close();
    try { stream.destroy(); } catch {}

    if (!header || typeof header !== "object") {
      if (parseError && process.env.TOKENTRACKER_DEBUG) {
        process.stderr.write(
          `[craft] header parse failed for ${filePath}: ${parseError.message}\n`,
        );
      }
      continue;
    }
    const usage = header.tokenUsage;
    if (!usage || typeof usage !== "object") continue;

    const sessionId =
      typeof header.id === "string" && header.id
        ? header.id
        : (typeof header.sdkSessionId === "string" && header.sdkSessionId
            ? header.sdkSessionId
            : null);
    if (!sessionId) continue;

    recordsProcessed++;

    const totalInput = toNonNegativeInt(usage.inputTokens);
    const totalOutput = toNonNegativeInt(usage.outputTokens);
    const totalCacheRead = toNonNegativeInt(usage.cacheReadTokens);
    const totalCacheWrite = toNonNegativeInt(usage.cacheCreationTokens);
    const totalReported =
      Number.isFinite(Number(usage.totalTokens)) && Number(usage.totalTokens) > 0
        ? toNonNegativeInt(usage.totalTokens)
        : totalInput + totalOutput + totalCacheRead + totalCacheWrite;

    const prev = sessionTotals[sessionId] || {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    };

    // Compute the delta since the last sync. Negative deltas mean the session
    // was reset/truncated — clamp to 0 and replace the snapshot.
    const dInput = Math.max(0, totalInput - prev.input);
    const dOutput = Math.max(0, totalOutput - prev.output);
    const dCacheRead = Math.max(0, totalCacheRead - prev.cacheRead);
    const dCacheWrite = Math.max(0, totalCacheWrite - prev.cacheWrite);
    const dTotal = Math.max(0, totalReported - prev.total);

    const nowMs = Date.now();

    if (dInput === 0 && dOutput === 0 && dCacheRead === 0 && dCacheWrite === 0) {
      // No new usage since last parse — but still update the snapshot in case
      // an earlier truncate left it stale, and refresh lastSeenAt so the
      // eviction policy treats the session as live.
      sessionTotals[sessionId] = {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        total: totalReported,
        lastSeenAt: nowMs,
      };
      continue;
    }

    // Bucket on lastMessageAt (preferred) or createdAt — both ms epoch.
    let tsMs = null;
    const tsCandidates = [header.lastMessageAt, header.lastUsedAt, header.createdAt];
    for (const cand of tsCandidates) {
      if (Number.isFinite(Number(cand)) && Number(cand) > 0) {
        tsMs = Number(cand);
        break;
      }
    }
    if (tsMs == null) tsMs = stat.mtimeMs;
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue;

    const tsIso = new Date(tsMs).toISOString();
    const bucketStart = toUtcHalfHourStart(tsIso);
    if (!bucketStart) continue;

    const model = normalizeModelInput(header.model) || fallbackModel;

    // conversation_count: 1 the first time we see a session, 0 on subsequent
    // syncs of the same session. NOTE: this differs from omp/Claude which
    // count one-per-assistant-message. Cross-provider "conversations" totals
    // are therefore not directly comparable — Craft's are per-session.
    const delta = {
      input_tokens: dInput,
      cached_input_tokens: dCacheRead,
      cache_creation_input_tokens: dCacheWrite,
      output_tokens: dOutput,
      reasoning_output_tokens: 0,
      total_tokens: dTotal > 0 ? dTotal : dInput + dOutput + dCacheRead + dCacheWrite,
      conversation_count: prev.total === 0 ? 1 : 0,
    };

    const bucket = getHourlyBucket(hourlyState, "craft", model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey("craft", model, bucketStart));
    eventsAggregated++;

    sessionTotals[sessionId] = {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      total: totalReported,
      lastSeenAt: nowMs,
    };

    if (cb) {
      cb({
        index: fileIdx + 1,
        total: files.length,
        recordsProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  // Cap session-totals map at 5k entries to bound cursor state size. Evict by
  // lastSeenAt (least-recently-seen first) so that long-lived sessions stay
  // tracked even when many newer one-shot sessions cycle through. Insertion
  // order would silently re-zero a long-running session and double-count its
  // total on the next sync.
  const entries = Object.entries(sessionTotals);
  let capped = sessionTotals;
  if (entries.length > 5000) {
    entries.sort((a, b) => (a[1]?.lastSeenAt || 0) - (b[1]?.lastSeenAt || 0));
    capped = Object.fromEntries(entries.slice(entries.length - 5000));
  }

  const bucketsQueued = await enqueueTouchedBuckets({
    queuePath,
    hourlyState,
    touchedBuckets,
  });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.craft = {
    ...craftState,
    sessionTotals: capped,
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Copilot CLI — OpenTelemetry JSONL exporter
// User must opt in by setting:
//   COPILOT_OTEL_ENABLED=true
//   COPILOT_OTEL_EXPORTER_TYPE=file
//   COPILOT_OTEL_FILE_EXPORTER_PATH=$HOME/.copilot/otel/copilot-otel-...jsonl
// We scan the default directory plus the env-overridden path.
// ─────────────────────────────────────────────────────────────────────────────

function resolveCopilotOtelPaths(env = process.env) {
  const home = env.HOME || require("node:os").homedir();
  const paths = new Set();
  const scanDir = (dir) => {
    if (!fssync.existsSync(dir)) return;
    try {
      for (const entry of fssync.readdirSync(dir)) {
        if (entry.endsWith(".jsonl")) paths.add(path.join(dir, entry));
      }
    } catch (_e) {}
  };
  if (process.platform !== "win32" || wsl.shouldProbeNative(env)) {
    scanDir(path.join(home, ".copilot", "otel"));
  }
  if (process.platform === "win32") {
    if (wsl.shouldProbeWsl(env)) {
      const wslDir = wsl.discoverWslHome(".copilot/otel", { env });
      if (wslDir) scanDir(wslDir);
    }
  }
  const explicit = env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  if (typeof explicit === "string" && explicit.trim() && fssync.existsSync(explicit)) {
    paths.add(explicit);
  }
  return Array.from(paths).sort();
}

function isCopilotChatSpan(record) {
  if (!record || typeof record !== "object") return false;
  // Skip metric records (resource + scopeMetrics) which have no chat usage data
  if (record.scopeMetrics) return false;
  const opName = record?.attributes?.["gen_ai.operation.name"];
  // Both Copilot CLI (Span shape with type:"span") and Copilot Chat extension
  // (OTEL JS SDK LogRecord shape with event.name:"gen_ai.client.inference.operation.details")
  // mark chat completions with gen_ai.operation.name === "chat".
  if (opName === "chat") return true;
  if (record.type === "span" && typeof record.name === "string" && record.name.startsWith("chat ")) {
    return true;
  }
  return false;
}

function copilotOtelTimeToMs(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const seconds = Number(value[0]);
  const nanos = Number(value[1]);
  if (!Number.isFinite(seconds)) return null;
  const ns = Number.isFinite(nanos) ? nanos : 0;
  return Math.round(seconds * 1000 + ns / 1_000_000);
}

function pickCopilotModel(attrs) {
  const candidates = [attrs?.["gen_ai.response.model"], attrs?.["gen_ai.request.model"]];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

const COPILOT_PARSER_VERSION = 2;
const COPILOT_USAGE_CLAIM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const COPILOT_USAGE_CLAIM_MAX_ENTRIES = 10_000;

function pruneCopilotUsageClaims(
  events,
  nowMs = Date.now(),
  maxEntries = COPILOT_USAGE_CLAIM_MAX_ENTRIES,
) {
  const cutoffMs = nowMs - COPILOT_USAGE_CLAIM_RETENTION_MS;
  const retained = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object" || event.consumed === true) {
      continue;
    }
    const storedFirstSeenAtMs = Number(event.firstSeenAtMs);
    const firstSeenAtMs =
      Number.isFinite(storedFirstSeenAtMs) && storedFirstSeenAtMs > 0
        ? storedFirstSeenAtMs
        : nowMs;
    if (firstSeenAtMs < cutoffMs) continue;
    retained.push(
      firstSeenAtMs === storedFirstSeenAtMs
        ? event
        : { ...event, firstSeenAtMs },
    );
  }
  return retained.length > maxEntries
    ? retained.slice(retained.length - maxEntries)
    : retained;
}

function replaceCopilotUsageClaims(
  target,
  nowMs = Date.now(),
  maxEntries = COPILOT_USAGE_CLAIM_MAX_ENTRIES,
) {
  if (!Array.isArray(target)) return;
  const retained = pruneCopilotUsageClaims(target, nowMs, maxEntries);
  target.splice(0, target.length, ...retained);
}

function isCopilotV1ChatSpan(record) {
  if (!record || record.type !== "span") return false;
  const opName = record?.attributes?.["gen_ai.operation.name"];
  if (opName === "chat") return true;
  return typeof record.name === "string" && record.name.startsWith("chat ");
}

function copilotLineHash(line) {
  return crypto.createHash("sha256").update(line).digest("hex");
}

function incrementMapCount(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function getCopilotDedupKey(record, attrs = record?.attributes || {}) {
  const traceId = record?.traceId || record?.spanContext?.traceId || "";
  const spanId = record?.spanId || record?.spanContext?.spanId || "";
  const responseId =
    typeof attrs["gen_ai.response.id"] === "string" ? attrs["gen_ai.response.id"] : "";
  return traceId && spanId ? `${traceId}:${spanId}` : responseId ? `resp:${responseId}` : null;
}

function copilotUsageMatchKey({
  sessionId,
  model,
  input,
  output,
  cacheRead,
  cacheWrite,
  reasoning,
}) {
  return [
    sessionId || "",
    normalizeCopilotAppModel(model) || COPILOT_APP_DEFAULT_MODEL,
    toNonNegativeInt(input),
    toNonNegativeInt(output),
    toNonNegativeInt(cacheRead),
    toNonNegativeInt(cacheWrite),
    toNonNegativeInt(reasoning),
  ].join("|");
}

function createCopilotStoreUsageMatcher(events) {
  const candidates = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    if (event.consumed === true) continue;
    const tsMs = Number(event.tsMs);
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue;
    const key = copilotUsageMatchKey(event);
    const list = candidates.get(key) || [];
    list.push({ tsMs, event });
    candidates.set(key, list);
  }
  for (const list of candidates.values()) {
    list.sort((a, b) => a.tsMs - b.tsMs);
  }
  return {
    consume(event, toleranceMs = 2_000) {
      const tsMs = Number(event?.tsMs);
      if (!Number.isFinite(tsMs) || tsMs <= 0) return false;
      const key = copilotUsageMatchKey(event || {});
      const list = candidates.get(key);
      if (!list || list.length === 0) return false;
      let bestIndex = -1;
      let bestDistance = Infinity;
      for (let i = 0; i < list.length; i++) {
        const distance = Math.abs(list[i].tsMs - tsMs);
        if (distance <= toleranceMs && distance < bestDistance) {
          bestIndex = i;
          bestDistance = distance;
        }
      }
      if (bestIndex < 0) return false;
      const [matched] = list.splice(bestIndex, 1);
      matched.event.consumed = true;
      return true;
    },
  };
}

// Migration helper: stream the bytes v1 already saw (0 -> prevSize), classify
// whether the file contains old CLI spans v1 processed, and whether it also
// contains v2-only chat records v1 skipped. Mixed files must be replayed, but
// their old CLI lines are skipped by hash so history does not double-count.
async function scanCopilotV1MigrationFile(filePath, maxBytes) {
  const result = {
    v1Processed: false,
    v2OnlyChat: false,
    v1LineHashes: new Map(),
  };
  if (!maxBytes || maxBytes <= 0) return result;
  try {
    const stream = fssync.createReadStream(filePath, {
      encoding: "utf8",
      start: 0,
      end: maxBytes - 1,
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line || !line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (_e) {
          continue;
        }
        // Must mirror v1's isCopilotChatSpan exactly: BOTH the
        // gen_ai.operation.name path AND the legacy name-prefix fallback.
        // Missing the second path lets metric-free files of name-only CLI spans
        // look like "v1 skipped" -> offset reset -> re-read -> double-count.
        if (isCopilotV1ChatSpan(record)) {
          result.v1Processed = true;
          incrementMapCount(result.v1LineHashes, copilotLineHash(line));
        } else if (isCopilotChatSpan(record)) {
          result.v2OnlyChat = true;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch (_e) {}
  return result;
}

async function copilotOtelCursorHasLegacyCliUsage(cursors) {
  const state =
    cursors?.copilot && typeof cursors.copilot === "object"
      ? cursors.copilot
      : {};
  if (state.legacyCliHistory === true) return true;
  if (state.usageClaimsComplete === true) return false;
  const offsets =
    state.fileOffsets && typeof state.fileOffsets === "object"
      ? state.fileOffsets
      : {};
  const entries = Object.entries(offsets).filter(
    ([, entry]) => Number(entry?.size) > 0,
  );
  const hasSeenIds =
    Array.isArray(state.seenIds) && state.seenIds.length > 0;
  if (entries.length === 0) return hasSeenIds;
  for (const [filePath, entry] of entries) {
    let stat;
    try {
      stat = fssync.statSync(filePath);
    } catch (_e) {
      return true;
    }
    if (
      stat.size < Number(entry?.size) ||
      (typeof entry?.ino === "number" && stat.ino !== entry.ino)
    ) {
      return true;
    }
    const scan = await scanCopilotV1MigrationFile(
      filePath,
      Number(entry?.size) || 0,
    );
    if (scan.v1Processed) return true;
  }
  return false;
}

async function parseCopilotIncremental({
  otelPaths,
  cursors,
  queuePath,
  onProgress,
  env,
  skipCliSpans = false,
  storeUsageEvents,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const copilotState = cursors.copilot && typeof cursors.copilot === "object" ? cursors.copilot : {};
  const seenIds = new Set(Array.isArray(copilotState.seenIds) ? copilotState.seenIds : []);
  const priorVersion = Number(copilotState.version) || 1;
  const fileOffsetsRaw =
    copilotState.fileOffsets && typeof copilotState.fileOffsets === "object"
      ? copilotState.fileOffsets
      : {};
  const fileOffsets = { ...fileOffsetsRaw };
  const claimNowMs = Date.now();
  const recentOtelUsageEvents = pruneCopilotUsageClaims(
    copilotState.recentUsageEvents,
    claimNowMs,
  );
  replaceCopilotUsageClaims(storeUsageEvents, claimNowMs, Infinity);
  const hadPriorUsageHistory =
    seenIds.size > 0 || Object.keys(fileOffsetsRaw).length > 0;
  let usageClaimsComplete =
    copilotState.usageClaimsComplete === true || !hadPriorUsageHistory;
  const migrationSkipLineHashes = new Map();
  // One-shot v1->v2 migration:
  // - pure v2-only files: clear offset and re-read all skipped Chat records
  // - pure v1 CLI files: preserve offset to avoid replaying history beyond seenIds
  // - mixed files: clear offset, but skip old v1 CLI lines by hash during replay
  if (priorVersion < COPILOT_PARSER_VERSION) {
    for (const filePath of Object.keys(fileOffsets)) {
      const prevSize = Number(fileOffsets[filePath]?.size) || 0;
      const scan = await scanCopilotV1MigrationFile(filePath, prevSize);
      if (!scan.v1Processed) {
        delete fileOffsets[filePath];
      } else if (scan.v2OnlyChat) {
        delete fileOffsets[filePath];
        migrationSkipLineHashes.set(filePath, scan.v1LineHashes);
      }
    }
  }

  const files = Array.isArray(otelPaths) && otelPaths.length > 0
    ? otelPaths
    : resolveCopilotOtelPaths(env || process.env);
  if (files.length === 0) {
    cursors.copilot = {
      ...copilotState,
      version: COPILOT_PARSER_VERSION,
      seenIds: Array.from(seenIds),
      fileOffsets,
      recentUsageEvents: recentOtelUsageEvents,
      usageClaimsComplete,
      updatedAt: new Date().toISOString(),
    };
    return {
      recordsProcessed: 0,
      eventsAggregated: 0,
      bucketsQueued: 0,
      usageClaims: recentOtelUsageEvents,
    };
  }

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  const storeUsageMatcher = createCopilotStoreUsageMatcher(storeUsageEvents);

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    let stat;
    try {
      stat = fssync.statSync(filePath);
    } catch (_e) {
      continue;
    }
    const prevEntry = fileOffsets[filePath] || {};
    const prevSize = Number(prevEntry.size) || 0;
    const prevIno = prevEntry.ino;
    // Re-read from start if (a) file shrunk (truncate/rewrite in place) or
    // (b) inode changed (rotator deleted + recreated at same path). Without
    // the inode check, a rotator producing a same-or-larger file would leave
    // the old offset stuck and skip the new file's prefix forever.
    const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
    const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
    if (stat.size <= startOffset) continue;

    let stream;
    try {
      stream = fssync.createReadStream(filePath, { encoding: "utf8", start: startOffset });
    } catch (_e) {
      continue;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      const skipLineHashes = migrationSkipLineHashes.get(filePath);
      if (skipLineHashes && skipLineHashes.size > 0) {
        const lineHash = copilotLineHash(line);
        const skipCount = skipLineHashes.get(lineHash) || 0;
        if (skipCount > 0) {
          if (skipCount === 1) skipLineHashes.delete(lineHash);
          else skipLineHashes.set(lineHash, skipCount - 1);
          continue;
        }
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      recordsProcessed++;
      if (!isCopilotChatSpan(record)) continue;

      const attrs = record.attributes || {};
      // Dedup: CLI puts traceId/spanId at the top level; the Chat extension
      // file exporter writes LogRecord-shaped entries without either, but
      // gen_ai.response.id is per-LLM-call unique.
      const dedupKey = getCopilotDedupKey(record, attrs);
      if (dedupKey && seenIds.has(dedupKey)) continue;
      if (skipCliSpans && isCopilotV1ChatSpan(record)) {
        if (dedupKey) seenIds.add(dedupKey);
        continue;
      }

      const inputRaw = toNonNegativeInt(attrs["gen_ai.usage.input_tokens"]);
      const output = toNonNegativeInt(attrs["gen_ai.usage.output_tokens"]);
      const cacheRead = toNonNegativeInt(
        attrs["gen_ai.usage.cache_read.input_tokens"] ??
          attrs["gen_ai.usage.cache_read_input_tokens"] ??
          attrs["gen_ai.usage.cached_input_tokens"],
      );
      // Copilot CLI: cache_write.input_tokens; Copilot Chat extension: cache_creation.input_tokens
      const cacheWrite = toNonNegativeInt(
        attrs["gen_ai.usage.cache_write.input_tokens"] ??
          attrs["gen_ai.usage.cache_creation.input_tokens"] ??
          attrs["gen_ai.usage.cache_write_input_tokens"] ??
          attrs["gen_ai.usage.cache_creation_input_tokens"],
      );
      // Copilot CLI: reasoning.output_tokens; Copilot Chat extension: reasoning_tokens
      const reasoning = toNonNegativeInt(
        attrs["gen_ai.usage.reasoning.output_tokens"] ??
          attrs["gen_ai.usage.reasoning_tokens"] ??
          attrs["gen_ai.usage.reasoning_output_tokens"],
      );
      const reasoningClamped = Math.min(reasoning, output);
      const outputWithoutReasoning = Math.max(0, output - reasoningClamped);
      const cliSpan = isCopilotV1ChatSpan(record);
      // CLI input includes both cache reads and writes. Chat-extension
      // LogRecords expose cache creation separately, so preserve their existing
      // input-minus-read semantics.
      const cacheReadClamped = Math.min(cacheRead, inputRaw);
      const cacheWriteClamped = Math.min(
        cacheWrite,
        Math.max(0, inputRaw - cacheReadClamped),
      );
      const cacheWriteForAccounting = cliSpan ? cacheWriteClamped : cacheWrite;
      const input = Math.max(
        0,
        inputRaw - cacheReadClamped - (cliSpan ? cacheWriteClamped : 0),
      );
      const totalInteresting =
        input +
        outputWithoutReasoning +
        cacheReadClamped +
        cacheWriteForAccounting +
        reasoningClamped;
      if (totalInteresting === 0) continue;

      // CLI Span uses endTime/startTime; Chat extension LogRecord uses hrTime/hrTimeObserved.
      const tsMs =
        copilotOtelTimeToMs(record.endTime) ||
        copilotOtelTimeToMs(record.startTime) ||
        copilotOtelTimeToMs(record.hrTime) ||
        copilotOtelTimeToMs(record.hrTimeObserved);
      if (!tsMs) continue;
      const tsIso = new Date(tsMs).toISOString();
      const bucketStart = toUtcHalfHourStart(tsIso);
      if (!bucketStart) continue;

      const model =
        normalizeCopilotAppModel(pickCopilotModel(attrs)) ||
        COPILOT_APP_DEFAULT_MODEL;
      const cliSessionId =
        typeof attrs["gen_ai.conversation.id"] === "string"
          ? attrs["gen_ai.conversation.id"].trim()
          : "";
      if (cliSpan && !cliSessionId) usageClaimsComplete = false;
      const matchBase = {
        sessionId: cliSessionId,
        model,
        output: outputWithoutReasoning,
        cacheRead: cacheReadClamped,
        cacheWrite: cacheWriteClamped,
        reasoning: reasoningClamped,
        tsMs,
      };
      const matchedStoreUsage =
        isCopilotV1ChatSpan(record) &&
        storeUsageMatcher.consume({
          ...matchBase,
          input,
        });
      if (matchedStoreUsage) {
        if (dedupKey) seenIds.add(dedupKey);
        continue;
      }

      const delta = {
        input_tokens: input,
        cached_input_tokens: cacheReadClamped,
        cache_creation_input_tokens: cacheWriteForAccounting,
        output_tokens: outputWithoutReasoning,
        reasoning_output_tokens: reasoningClamped,
        total_tokens:
          input +
          outputWithoutReasoning +
          cacheReadClamped +
          cacheWriteForAccounting +
          reasoningClamped,
        conversation_count: 1,
      };

      const bucket = getHourlyBucket(hourlyState, "copilot", model, bucketStart);
      addTotals(bucket.totals, delta);
      touchedBuckets.add(bucketKey("copilot", model, bucketStart));
      eventsAggregated++;
      if (cliSpan && cliSessionId) {
        recentOtelUsageEvents.push({
          ...matchBase,
          input,
          firstSeenAtMs: claimNowMs,
        });
      }
      if (dedupKey) seenIds.add(dedupKey);

      if (cb) {
        cb({
          index: fileIdx + 1,
          total: files.length,
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    // Re-stat after readline drains: file may have been appended during the
    // parse loop. Without this, those new lines would be replayed next run
    // (dedup catches records with traceId+spanId, but spans missing either
    // would be double-counted).
    let postStat = stat;
    try {
      postStat = fssync.statSync(filePath);
    } catch (_e) {}
    fileOffsets[filePath] = { size: postStat.size, mtimeMs: postStat.mtimeMs, ino: postStat.ino };
  }

  // Cap dedup set to last 10k IDs to bound state size
  const seenArr = Array.from(seenIds);
  const cappedSeen = seenArr.length > 10_000 ? seenArr.slice(seenArr.length - 10_000) : seenArr;
  const retainedRecentOtelUsageEvents = pruneCopilotUsageClaims(
    recentOtelUsageEvents,
  );
  replaceCopilotUsageClaims(storeUsageEvents, Date.now(), Infinity);

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.copilot = {
    ...copilotState,
    version: COPILOT_PARSER_VERSION,
    seenIds: cappedSeen,
    fileOffsets,
    recentUsageEvents: retainedRecentOtelUsageEvents,
    usageClaimsComplete,
    updatedAt,
  };

  return {
    recordsProcessed,
    eventsAggregated,
    bucketsQueued,
    usageClaims: recentOtelUsageEvents,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Copilot local runtime — session-store.db assistant_usage_events
//
// Copilot CLI 1.0.70+ persists one row per LLM request here. The Copilot App
// uses the same runtime, so this is the only local source that remains complete
// when one session moves App -> CLI -> App (or the reverse). data.db only keeps
// the App-owned portion of those sessions.
// ─────────────────────────────────────────────────────────────────────────────

const COPILOT_STORE_CURSOR_VERSION = 2;
const COPILOT_STORE_LEGACY_MODEL = "github-copilot-legacy";

function resolveCopilotDbPaths({ fileName, overrideEnvKey }, env = process.env) {
  const home =
    process.platform === "win32"
      ? env.USERPROFILE || env.HOME || require("node:os").homedir()
      : env.HOME || require("node:os").homedir();
  const paths = new Set();
  const addDbPath = (dbPath) => {
    const normalized = normalizeCopilotDbPath(dbPath, env);
    if (normalized) paths.add(normalized);
  };
  const addHome = (homePath) => {
    const normalizedHome = normalizeCopilotDbPath(homePath, env);
    if (normalizedHome) addDbPath(path.join(normalizedHome, fileName));
  };

  if (typeof env[overrideEnvKey] === "string" && env[overrideEnvKey].trim()) {
    addDbPath(env[overrideEnvKey]);
  }
  if (typeof env.COPILOT_HOME === "string" && env.COPILOT_HOME.trim()) {
    addHome(env.COPILOT_HOME);
  }

  addDbPath(path.join(home, ".copilot", fileName));

  return Array.from(paths).sort();
}

function resolveCopilotSessionStorePaths(env = process.env) {
  return resolveCopilotDbPaths(
    {
      fileName: "session-store.db",
      overrideEnvKey: "TOKENTRACKER_COPILOT_SESSION_STORE_DB",
    },
    env,
  );
}

function copilotStoreRowKey(row) {
  if (!row) return null;
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        row.max_id ?? row.id,
        row.session_id,
        row.model,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_write_tokens,
        row.reasoning_tokens,
        row.created_at,
      ]),
    )
    .digest("hex");
}

function copilotStoreEventFingerprint(row) {
  const sessionId =
    typeof row?.session_id === "string" ? row.session_id.trim() : "";
  if (!sessionId) return null;
  const normalized = normalizeCopilotSessionStoreUsage(row);
  const timestamp =
    parseCopilotAppTimestamp(row?.created_at) ||
    `invalid:${String(row?.created_at ?? "")}`;
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        sessionId,
        normalizeCopilotAppModel(row?.model) || COPILOT_APP_DEFAULT_MODEL,
        normalized.input_tokens,
        normalized.output_tokens,
        normalized.cached_input_tokens,
        normalized.cache_creation_input_tokens,
        normalized.reasoning_output_tokens,
        timestamp,
      ]),
    )
    .digest("hex");
}

function normalizeCopilotFingerprintCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [fingerprint, count] of Object.entries(value)) {
    const normalized = toNonNegativeInt(count);
    if (/^[a-f0-9]{64}$/.test(fingerprint) && normalized > 0) {
      result[fingerprint] = normalized;
    }
  }
  return result;
}

function normalizeCopilotPendingMalformedEvents(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [id, fingerprint] of Object.entries(value)) {
    const normalizedId = toNonNegativeInt(id);
    if (normalizedId > 0) {
      result[normalizedId] =
        typeof fingerprint === "string" ? fingerprint : "";
    }
  }
  return result;
}

function incrementCopilotFingerprintCount(counts, fingerprint) {
  if (!fingerprint) return;
  counts[fingerprint] = toNonNegativeInt(counts[fingerprint]) + 1;
}

function latestCopilotTimestamp(first, second) {
  const values = [first, second]
    .map((value) => parseCopilotAppTimestamp(value))
    .filter(Boolean);
  if (values.length === 0) return null;
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

function omitCopilotLegacyCatchupState(state) {
  const clean = { ...(state || {}) };
  delete clean.pendingCatchupMaxId;
  delete clean.pendingCatchupFingerprint;
  delete clean.pendingLegacyCatchup;
  return clean;
}

function readCopilotSessionStoreMetadata(
  dbPath,
  sqliteOptions = {},
  cursorId = 0,
) {
  const tables = readSqliteJsonRows(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('assistant_usage_events', 'schema_version')",
    {
      label: "GitHub Copilot session store",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      readOnly: true,
      throwOnReadFailure: true,
      ...sqliteOptions,
    },
  );
  const names = new Set(tables.map((row) => row?.name).filter(Boolean));
  if (!names.has("assistant_usage_events")) {
    return { active: false, schemaVersion: null, maxId: 0 };
  }
  const maxRows = readSqliteJsonRows(
    dbPath,
    `
      SELECT
        id AS max_id,
        session_id,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
        created_at
      FROM assistant_usage_events
      ORDER BY id DESC
      LIMIT 1
    `.trim(),
    {
      label: "GitHub Copilot session store",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      readOnly: true,
      throwOnReadFailure: true,
      ...sqliteOptions,
    },
  );
  let schemaVersion = null;
  if (names.has("schema_version")) {
    const versionRows = readSqliteJsonRows(
      dbPath,
      "SELECT version FROM schema_version LIMIT 1",
      {
        label: "GitHub Copilot session store",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
        readOnly: true,
        throwOnReadFailure: true,
        ...sqliteOptions,
      },
    );
    schemaVersion = toNonNegativeInt(versionRows[0]?.version);
  }
  let cursorRowKey = null;
  const normalizedCursorId = toNonNegativeInt(cursorId);
  if (normalizedCursorId > 0) {
    if (normalizedCursorId === toNonNegativeInt(maxRows[0]?.max_id)) {
      cursorRowKey = copilotStoreRowKey(maxRows[0]);
    } else {
      const cursorRows = readSqliteJsonRows(
        dbPath,
        `
          SELECT
            id,
            session_id,
            model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            reasoning_tokens,
            created_at
          FROM assistant_usage_events
          WHERE id = ${normalizedCursorId}
          LIMIT 1
        `.trim(),
        {
          label: "GitHub Copilot session store",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 10_000,
          readOnly: true,
          throwOnReadFailure: true,
          ...sqliteOptions,
        },
      );
      cursorRowKey = copilotStoreRowKey(cursorRows[0]);
    }
  }
  return {
    active: true,
    schemaVersion,
    maxId: toNonNegativeInt(maxRows[0]?.max_id),
    lastRowKey: copilotStoreRowKey(maxRows[0]),
    lastEventAt: parseCopilotAppTimestamp(maxRows[0]?.created_at),
    cursorRowKey,
  };
}

function describeCopilotSessionStoreDb(dbPath, sqliteOptions = {}) {
  let snap = null;
  try {
    snap = snapshotSqliteDb(dbPath);
    const metadata = readCopilotSessionStoreMetadata(snap.path, sqliteOptions);
    if (!metadata.active) {
      return {
        path: dbPath,
        active: false,
        schemaVersion: metadata.schemaVersion,
        eventCount: 0,
        lastEventId: 0,
        lastEventAt: null,
      };
    }
    const countRows = readSqliteJsonRows(
      snap.path,
      "SELECT COUNT(*) AS event_count FROM assistant_usage_events",
      {
        label: "GitHub Copilot session store",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
        readOnly: true,
        throwOnReadFailure: true,
        ...sqliteOptions,
      },
    );
    return {
      path: dbPath,
      active: true,
      schemaVersion: metadata.schemaVersion,
      eventCount: toNonNegativeInt(countRows[0]?.event_count),
      lastEventId: metadata.maxId,
      lastEventAt: metadata.lastEventAt,
    };
  } finally {
    if (snap) snap.cleanup();
  }
}

function readCopilotSessionStoreUsageRowsWhere(
  dbPath,
  whereClause,
  sqliteOptions = {},
) {
  return readSqliteJsonRows(
    dbPath,
    `
      SELECT
        id,
        session_id,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
        token_details_json,
        created_at
      FROM assistant_usage_events
      WHERE ${whereClause}
      ORDER BY id ASC
    `.trim(),
    {
      label: "GitHub Copilot session store",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      readOnly: true,
      throwOnReadFailure: true,
      ...sqliteOptions,
    },
  );
}

function readCopilotSessionStoreUsageRows(dbPath, lastId, sqliteOptions = {}) {
  return readCopilotSessionStoreUsageRowsWhere(
    dbPath,
    `id > ${toNonNegativeInt(lastId)}`,
    sqliteOptions,
  );
}

function readCopilotSessionStoreUsageRowsByIds(
  dbPath,
  ids,
  sqliteOptions = {},
) {
  const normalizedIds = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map(toNonNegativeInt)
        .filter((id) => id > 0),
    ),
  ];
  const rows = [];
  for (let start = 0; start < normalizedIds.length; start += 500) {
    const chunk = normalizedIds.slice(start, start + 500);
    rows.push(
      ...readCopilotSessionStoreUsageRowsWhere(
        dbPath,
        `id IN (${chunk.join(",")})`,
        sqliteOptions,
      ),
    );
  }
  return rows.sort((a, b) => toNonNegativeInt(a?.id) - toNonNegativeInt(b?.id));
}

function parseCopilotStoreTokenDetails(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (_e) {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let recognized = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const count = toNonNegativeInt(entry.tokenCount);
    switch (entry.tokenType) {
      case "input":
        totals.input += count;
        recognized++;
        break;
      case "cache_read":
        totals.cacheRead += count;
        recognized++;
        break;
      case "cache_write":
        totals.cacheWrite += count;
        recognized++;
        break;
      case "output":
        totals.output += count;
        recognized++;
        break;
      default:
        break;
    }
  }
  return recognized > 0 ? totals : null;
}

function copilotStoreRecentEvent(row, firstSeenAtMs = Date.now()) {
  const tsIso = parseCopilotAppTimestamp(row?.created_at);
  const tsMs = tsIso ? Date.parse(tsIso) : NaN;
  const sessionId =
    typeof row?.session_id === "string" ? row.session_id.trim() : "";
  if (!sessionId || !Number.isFinite(tsMs) || tsMs <= 0) return null;
  const normalized = normalizeCopilotSessionStoreUsage(row);
  return {
    id: toNonNegativeInt(row?.id),
    sessionId,
    model: normalizeCopilotAppModel(row?.model) || COPILOT_APP_DEFAULT_MODEL,
    input: normalized.input_tokens,
    output: normalized.output_tokens,
    cacheRead: normalized.cached_input_tokens,
    cacheWrite: normalized.cache_creation_input_tokens,
    reasoning: normalized.reasoning_output_tokens,
    tsMs,
    firstSeenAtMs,
  };
}

function normalizeCopilotSessionStoreUsage(row) {
  const inputRaw = toNonNegativeInt(row?.input_tokens);
  const outputRaw = toNonNegativeInt(row?.output_tokens);
  const reasoning = toNonNegativeInt(row?.reasoning_tokens);
  const details = parseCopilotStoreTokenDetails(row?.token_details_json);
  let input;
  let cacheRead;
  let cacheWrite;
  let output;
  let precision = "fallback";

  if (
    details &&
    details.input + details.cacheRead + details.cacheWrite === inputRaw &&
    details.output === outputRaw
  ) {
    input = details.input;
    cacheRead = details.cacheRead;
    cacheWrite = details.cacheWrite;
    output = details.output;
    precision = "exact";
  } else {
    cacheRead = Math.min(toNonNegativeInt(row?.cache_read_tokens), inputRaw);
    cacheWrite = Math.min(
      toNonNegativeInt(row?.cache_write_tokens),
      Math.max(0, inputRaw - cacheRead),
    );
    input = Math.max(0, inputRaw - cacheRead - cacheWrite);
    output = outputRaw;
  }

  const reasoningClamped = Math.min(reasoning, output);
  const outputWithoutReasoning = Math.max(0, output - reasoningClamped);
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: outputWithoutReasoning,
    reasoning_output_tokens: reasoningClamped,
    total_tokens:
      input + cacheRead + cacheWrite + outputWithoutReasoning + reasoningClamped,
    precision,
  };
}

async function parseCopilotSessionStoreIncremental({
  dbPath,
  dbPaths,
  cursors,
  queuePath,
  onProgress,
  env,
  sqliteOptions,
  backfillOnFirstRun = false,
  excludeSessionIdsOnFirstRun,
  excludeSessionTotalsOnFirstRun,
  expectedFingerprints,
  otelUsageEvents,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const paths = Array.isArray(dbPaths)
    ? dbPaths
    : dbPath
      ? [dbPath]
      : resolveCopilotSessionStorePaths(env || process.env);
  const storeState =
    cursors.copilotStore && typeof cursors.copilotStore === "object"
      ? cursors.copilotStore
      : {};
  const dbStates =
    storeState.dbs && typeof storeState.dbs === "object" ? { ...storeState.dbs } : {};
  let uniquePaths = uniqueCopilotDbPaths(
    paths,
    env || process.env,
    Object.keys(dbStates),
  );
  const migratedAliasPaths = coalesceCopilotDbStatesByIdentity(
    dbStates,
    uniquePaths,
    mergeCopilotStoreAliasStates,
  );
  uniquePaths = uniquePaths.filter(
    (dbPath) => !migratedAliasPaths.has(dbPath),
  );
  const seenSessions = new Set(
    Array.isArray(storeState.seenSessions) ? storeState.seenSessions : [],
  );
  const excludedFirstRunSessions = new Set(
    Array.isArray(excludeSessionIdsOnFirstRun)
      ? excludeSessionIdsOnFirstRun.filter((value) => typeof value === "string" && value)
      : [],
  );
  const excludedFirstRunTotals =
    excludeSessionTotalsOnFirstRun &&
    typeof excludeSessionTotalsOnFirstRun === "object" &&
    !Array.isArray(excludeSessionTotalsOnFirstRun)
      ? excludeSessionTotalsOnFirstRun
      : {};
  const legacyResiduals = new Map();
  const claimNowMs = Date.now();
  const recentEvents = pruneCopilotUsageClaims(
    storeState.recentEvents,
    claimNowMs,
  );
  replaceCopilotUsageClaims(otelUsageEvents, claimNowMs, Infinity);
  const otelUsageMatcher = createCopilotStoreUsageMatcher(otelUsageEvents);
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  const updatedAt = new Date(claimNowMs).toISOString();
  let activeDbCount = 0;
  let adoptedThisRun = false;
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  let dbErrors = 0;
  const canonicalDbPaths = [];
  const globalAdoptionPending = storeState.active !== true;

  for (const resolvedDb of uniquePaths) {
    const dbState =
      dbStates[resolvedDb] && typeof dbStates[resolvedDb] === "object"
        ? dbStates[resolvedDb]
        : {};
    const seenEventCounts = normalizeCopilotFingerprintCounts(
      dbState.seenEventCounts,
    );
    let pendingMalformedEvents = normalizeCopilotPendingMalformedEvents(
      dbState.pendingMalformedEvents,
    );
    let fingerprint = null;
    let snap = null;
    try {
      fingerprint = sqliteSidecarFingerprint(resolvedDb);
      const expectedFingerprint = expectedFingerprints?.[resolvedDb];
      if (
        expectedFingerprint &&
        !sameSqliteFingerprint(fingerprint, expectedFingerprint)
      ) {
        dbStates[resolvedDb] = {
          ...omitCopilotLegacyCatchupState(dbState),
          adoptionDeferredAt: updatedAt,
          updatedAt,
        };
        continue;
      }
      const currentIno = fingerprint?.db?.ino;
      const priorLastId = toNonNegativeInt(dbState.lastId);
      snap = snapshotSqliteDb(resolvedDb);
      const metadata = readCopilotSessionStoreMetadata(
        snap.path,
        sqliteOptions,
        priorLastId,
      );
      if (!metadata.active) {
        dbStates[resolvedDb] = {
          ...omitCopilotLegacyCatchupState(dbState),
          schemaVersion: metadata.schemaVersion,
          lastError: null,
          lastErrorAt: null,
          updatedAt,
        };
        continue;
      }

      const inodeChanged =
        typeof dbState.dbIno === "number" &&
        typeof currentIno === "number" &&
        dbState.dbIno !== currentIno;
      const cursorRowChanged =
        priorLastId > 0 &&
        typeof dbState.lastRowKey === "string" &&
        dbState.lastRowKey !== metadata.cursorRowKey;
      const idRegressed = metadata.maxId < priorLastId;
      const resetDetected =
        Boolean(dbState.adoptedAt) && (idRegressed || cursorRowChanged);
      const needsFingerprintSeed =
        Boolean(dbState.adoptedAt) &&
        priorLastId > 0 &&
        Object.keys(seenEventCounts).length === 0;
      const resetWithoutFingerprintHistory =
        resetDetected && needsFingerprintSeed;
      const reconcileAllRows =
        (resetDetected || inodeChanged) && !resetWithoutFingerprintHistory;
      const needsAdoption =
        globalAdoptionPending ||
        !dbState.adoptedAt ||
        resetDetected;
      const baselineOnly =
        resetWithoutFingerprintHistory ||
        (needsAdoption && !resetDetected && !backfillOnFirstRun);
      const incrementalRows = readCopilotSessionStoreUsageRows(
        snap.path,
        reconcileAllRows || baselineOnly || needsFingerprintSeed ? 0 : priorLastId,
        sqliteOptions,
      );
      const pendingRetryRows = resetDetected || reconcileAllRows
        ? []
        : readCopilotSessionStoreUsageRowsByIds(
            snap.path,
            Object.keys(pendingMalformedEvents),
            sqliteOptions,
          );
      const pendingRetryIds = new Set(
        pendingRetryRows.map((row) => toNonNegativeInt(row?.id)),
      );
      if (resetDetected || reconcileAllRows) {
        pendingMalformedEvents = {};
      } else {
        for (const pendingId of Object.keys(pendingMalformedEvents)) {
          if (!pendingRetryIds.has(toNonNegativeInt(pendingId))) {
            delete pendingMalformedEvents[pendingId];
          }
        }
      }
      const rowsById = new Map();
      for (const row of [...pendingRetryRows, ...incrementalRows]) {
        rowsById.set(toNonNegativeInt(row?.id), row);
      }
      const rows = Array.from(rowsById.values()).sort(
        (a, b) => toNonNegativeInt(a?.id) - toNonNegativeInt(b?.id),
      );
      // Reindex/reset can rewrite every SQLite id. Subtract the exact metadata
      // multiset already observed so only genuinely new requests are emitted.
      const historicalFingerprintCounts = reconcileAllRows
        ? new Map(
            Object.entries(seenEventCounts).map(([eventFingerprint, count]) => [
              eventFingerprint,
              toNonNegativeInt(count),
            ]),
          )
        : null;
      if (needsAdoption) adoptedThisRun = true;
      if (expectedFingerprint) {
        const finalFingerprint = sqliteSidecarFingerprint(resolvedDb);
        if (!sameSqliteFingerprint(finalFingerprint, expectedFingerprint)) {
          dbStates[resolvedDb] = {
            ...omitCopilotLegacyCatchupState(dbState),
            adoptionDeferredAt: updatedAt,
            updatedAt,
          };
          continue;
        }
        fingerprint = finalFingerprint;
      }
      let lastId =
        reconcileAllRows || baselineOnly ? metadata.maxId : priorLastId;
      for (const row of rows) {
        recordsProcessed++;
        const rowId = toNonNegativeInt(row?.id);
        lastId = Math.max(lastId, rowId);
        const sessionId =
          typeof row?.session_id === "string" ? row.session_id.trim() : "";
        if (!sessionId) {
          if (rowId > 0) pendingMalformedEvents[rowId] = "";
          continue;
        }
        const eventFingerprint = copilotStoreEventFingerprint(row);
        if (historicalFingerprintCounts && eventFingerprint) {
          const historicalCount = toNonNegativeInt(
            historicalFingerprintCounts.get(eventFingerprint),
          );
          if (historicalCount > 0) {
            historicalFingerprintCounts.set(
              eventFingerprint,
              historicalCount - 1,
            );
            if (!parseCopilotAppTimestamp(row?.created_at) && rowId > 0) {
              pendingMalformedEvents[rowId] = eventFingerprint;
            }
            seenSessions.add(sessionId);
            continue;
          }
        }
        const seedOnly =
          needsFingerprintSeed && rowId <= priorLastId;
        const recentEvent = copilotStoreRecentEvent(row, claimNowMs);
        if (pendingRetryIds.has(rowId) && !recentEvent) {
          if (seedOnly) {
            incrementCopilotFingerprintCount(
              seenEventCounts,
              eventFingerprint,
            );
          }
          pendingMalformedEvents[rowId] = eventFingerprint || "";
          seenSessions.add(sessionId);
          continue;
        }
        if (rowId > 0) delete pendingMalformedEvents[rowId];
        const matchedOtelUsage =
          recentEvent && otelUsageMatcher.consume(recentEvent);
        if (matchedOtelUsage) recentEvent.consumed = true;
        if (baselineOnly || seedOnly) {
          incrementCopilotFingerprintCount(seenEventCounts, eventFingerprint);
          if (!recentEvent && rowId > 0) {
            pendingMalformedEvents[rowId] = eventFingerprint || "";
          }
          seenSessions.add(sessionId);
          continue;
        }
        incrementCopilotFingerprintCount(seenEventCounts, eventFingerprint);
        if (needsAdoption && backfillOnFirstRun && excludedFirstRunSessions.has(sessionId)) {
          if (
            !matchedOtelUsage &&
            Object.prototype.hasOwnProperty.call(
              excludedFirstRunTotals,
              sessionId,
            )
          ) {
            const normalized = normalizeCopilotSessionStoreUsage(row);
            const priorResidual = legacyResiduals.get(sessionId) || {
              storeTokens: 0,
              lastEventAt: null,
            };
            priorResidual.storeTokens += normalized.total_tokens;
            priorResidual.lastEventAt = latestCopilotTimestamp(
              priorResidual.lastEventAt,
              row?.created_at,
            );
            legacyResiduals.set(sessionId, priorResidual);
          }
          if (recentEvent && !matchedOtelUsage) recentEvents.push(recentEvent);
          seenSessions.add(sessionId);
          continue;
        }
        if (matchedOtelUsage) {
          seenSessions.add(sessionId);
          continue;
        }
        if (recentEvent) recentEvents.push(recentEvent);
        const normalized = normalizeCopilotSessionStoreUsage(row);
        if (normalized.total_tokens <= 0) {
          seenSessions.add(sessionId);
          continue;
        }
        const tsIso = parseCopilotAppTimestamp(row.created_at);
        const bucketStart = tsIso ? toUtcHalfHourStart(tsIso) : null;
        if (!bucketStart) {
          if (rowId > 0) {
            pendingMalformedEvents[rowId] = eventFingerprint || "";
          }
          seenSessions.add(sessionId);
          continue;
        }
        const model =
          normalizeCopilotAppModel(row.model) || COPILOT_APP_DEFAULT_MODEL;
        const delta = {
          input_tokens: normalized.input_tokens,
          cached_input_tokens: normalized.cached_input_tokens,
          cache_creation_input_tokens: normalized.cache_creation_input_tokens,
          output_tokens: normalized.output_tokens,
          reasoning_output_tokens: normalized.reasoning_output_tokens,
          total_tokens: normalized.total_tokens,
          conversation_count: seenSessions.has(sessionId) ? 0 : 1,
        };
        const bucket = getHourlyBucket(hourlyState, "copilot", model, bucketStart);
        addTotals(bucket.totals, delta);
        touchedBuckets.add(bucketKey("copilot", model, bucketStart));
        seenSessions.add(sessionId);
        eventsAggregated++;
        if (cb) {
          cb({
            index: recordsProcessed,
            total: rows.length,
            recordsProcessed,
            eventsAggregated,
            bucketsQueued: touchedBuckets.size,
          });
        }
      }

      dbStates[resolvedDb] = {
        ...omitCopilotLegacyCatchupState(dbState),
        adoptedAt: dbState.adoptedAt || updatedAt,
        resetAt: resetDetected ? updatedAt : dbState.resetAt || null,
        schemaVersion: metadata.schemaVersion,
        lastRowKey: metadata.lastRowKey,
        lastId: Math.max(lastId, metadata.maxId),
        lastEventAt: latestCopilotTimestamp(
          dbState.lastEventAt,
          metadata.lastEventAt,
        ),
        seenEventCounts,
        pendingMalformedEvents,
        malformedEventCount: Object.keys(pendingMalformedEvents).length,
        resetGapEventCount:
          toNonNegativeInt(dbState.resetGapEventCount) +
          (resetWithoutFingerprintHistory ? rows.length : 0),
        dbIno: typeof currentIno === "number" ? currentIno : null,
        lastDbFingerprint: fingerprint,
        lastError: null,
        lastErrorAt: null,
        updatedAt,
      };
      canonicalDbPaths.push(resolvedDb);
      activeDbCount++;
    } catch (err) {
      if (err?.code !== "ENOENT") dbErrors++;
      dbStates[resolvedDb] = {
        ...omitCopilotLegacyCatchupState(dbState),
        lastError: err && err.message ? err.message : String(err),
        lastErrorAt: updatedAt,
        updatedAt,
      };
    } finally {
      if (snap) snap.cleanup();
    }
  }

  for (const [sessionId, residual] of legacyResiduals) {
    const baseline = excludedFirstRunTotals[sessionId] || {};
    const appTotals = normalizeCopilotAppTokenDelta(baseline, {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
    });
    const residualTokens = Math.max(
      0,
      toNonNegativeInt(residual.storeTokens) - appTotals.total_tokens,
    );
    if (residualTokens <= 0) continue;
    const timestamp = latestCopilotTimestamp(
      residual.lastEventAt,
      baseline.updatedAt,
    );
    const bucketStart = timestamp ? toUtcHalfHourStart(timestamp) : null;
    if (!bucketStart) continue;
    const bucket = getHourlyBucket(
      hourlyState,
      "copilot",
      COPILOT_STORE_LEGACY_MODEL,
      bucketStart,
    );
    addTotals(bucket.totals, {
      input_tokens: residualTokens,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: residualTokens,
      conversation_count: 0,
    });
    touchedBuckets.add(
      bucketKey("copilot", COPILOT_STORE_LEGACY_MODEL, bucketStart),
    );
    eventsAggregated++;
  }

  const bucketsQueued = await enqueueTouchedBuckets({
    queuePath,
    hourlyState,
    touchedBuckets,
  });
  const allCurrentPathsHealthy =
    uniquePaths.length > 0 &&
    activeDbCount === uniquePaths.length &&
    dbErrors === 0;
  const canonicalActive = storeState.active === true || allCurrentPathsHealthy;
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.copilotStore = {
    ...omitCopilotLegacyCatchupState(storeState),
    version: COPILOT_STORE_CURSOR_VERSION,
    active: canonicalActive,
    dbs: dbStates,
    seenSessions: Array.from(seenSessions),
    recentEvents: pruneCopilotUsageClaims(recentEvents),
    updatedAt,
  };
  return {
    active: canonicalActive,
    healthy: allCurrentPathsHealthy,
    adoptedThisRun,
    canonicalDbPaths,
    recordsProcessed,
    eventsAggregated,
    bucketsQueued,
    dbErrors,
    usageClaims: recentEvents,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Copilot App — passive reader for ~/.copilot/data.db
//
// The Copilot App persists one row per local App session in `sessions`, with
// cumulative `total_*` token summary columns. We intentionally do NOT read
// session-state/<id>/events.jsonl: forked App sessions inherit parent events
// there before the child has produced any tokens, so parsing event history would
// double-count parent usage. The only accounting source here is positive deltas
// from the `sessions.total_*` counters. Those deltas feed the same aggregate
// `source="copilot"` pipeline during legacy adoption. Once session-store is
// canonical, this parser runs observe-only so a temporary store outage cannot
// create duplicate fallback writes when the store returns.
// Project attribution and per-conversation detail are intentionally absent:
// data.db's summary columns do not expose privacy-safe project/message metadata.
// ─────────────────────────────────────────────────────────────────────────────

const COPILOT_APP_CURSOR_VERSION = 1;
const COPILOT_APP_DEFAULT_MODEL = "github-copilot";

function normalizeCopilotDbPath(dbPath, env = process.env) {
  if (typeof dbPath !== "string" || !dbPath.trim()) return null;
  const raw = dbPath.trim();
  const home =
    process.platform === "win32"
      ? env.USERPROFILE || env.HOME || require("node:os").homedir()
      : env.HOME || require("node:os").homedir();
  const expanded =
    raw === "~"
      ? home
      : raw.startsWith("~/") || raw.startsWith("~\\")
        ? path.join(home, raw.slice(2))
        : raw;
  const normalized =
    path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
  return normalized;
}

function mergeCopilotStoreAliasStates(primary = {}, alias = {}) {
  const primaryLastId = toNonNegativeInt(primary?.lastId);
  const aliasLastId = toNonNegativeInt(alias?.lastId);
  const primaryUpdatedAt = Date.parse(primary?.updatedAt || "") || 0;
  const aliasUpdatedAt = Date.parse(alias?.updatedAt || "") || 0;
  const newer =
    aliasLastId > primaryLastId ||
    (aliasLastId === primaryLastId && aliasUpdatedAt > primaryUpdatedAt)
      ? alias
      : primary;
  const seenEventCounts = normalizeCopilotFingerprintCounts(
    primary?.seenEventCounts,
  );
  for (const [fingerprint, count] of Object.entries(
    normalizeCopilotFingerprintCounts(alias?.seenEventCounts),
  )) {
    seenEventCounts[fingerprint] = Math.max(
      toNonNegativeInt(seenEventCounts[fingerprint]),
      count,
    );
  }
  const pendingMalformedEvents = {
    ...normalizeCopilotPendingMalformedEvents(
      primary?.pendingMalformedEvents,
    ),
    ...normalizeCopilotPendingMalformedEvents(
      alias?.pendingMalformedEvents,
    ),
  };
  return {
    ...primary,
    ...newer,
    seenEventCounts,
    pendingMalformedEvents,
    malformedEventCount: Object.keys(pendingMalformedEvents).length,
    resetGapEventCount: Math.max(
      toNonNegativeInt(primary?.resetGapEventCount),
      toNonNegativeInt(alias?.resetGapEventCount),
    ),
  };
}

function coalesceCopilotDbStatesByIdentity(
  dbStates,
  selectedPaths,
  mergeStates,
) {
  if (!dbStates || typeof dbStates !== "object") return new Set();
  const selectedByIdentity = new Map();
  const selectedByInode = new Map();
  for (const selectedPath of selectedPaths) {
    try {
      const stat = fssync.statSync(selectedPath);
      selectedByIdentity.set(`${stat.dev}:${stat.ino}`, selectedPath);
      if (selectedByInode.has(stat.ino)) selectedByInode.set(stat.ino, null);
      else selectedByInode.set(stat.ino, selectedPath);
    } catch (_e) {}
  }
  const migratedPaths = new Set();
  for (const [statePath, state] of Object.entries({ ...dbStates })) {
    let dev = null;
    let ino = null;
    try {
      const stat = fssync.statSync(statePath);
      dev = stat.dev;
      ino = stat.ino;
    } catch (_e) {
      dev = state?.lastDbFingerprint?.db?.dev;
      ino = state?.lastDbFingerprint?.db?.ino;
    }
    const selectedPath =
      Number.isFinite(dev) && Number.isFinite(ino)
        ? selectedByIdentity.get(`${dev}:${ino}`)
        : Number.isFinite(ino)
          ? selectedByInode.get(ino)
          : null;
    if (!selectedPath || selectedPath === statePath) continue;
    dbStates[selectedPath] = mergeStates(
      dbStates[selectedPath],
      state,
    );
    delete dbStates[statePath];
    migratedPaths.add(statePath);
  }
  return migratedPaths;
}

function uniqueCopilotDbPaths(
  paths,
  env = process.env,
  preferredPaths = [],
) {
  const pathKey = (dbPath) =>
    process.platform === "win32" ? dbPath.toLowerCase() : dbPath;
  const preferredKeys = new Set(
    (Array.isArray(preferredPaths) ? preferredPaths : [])
      .map((candidate) => normalizeCopilotDbPath(candidate, env))
      .filter(Boolean)
      .map(pathKey),
  );
  const candidates = (Array.isArray(paths) ? paths : [])
    .map((candidate, index) => ({
      index,
      path: normalizeCopilotDbPath(candidate, env),
    }))
    .filter((candidate) => candidate.path)
    .sort((a, b) => {
      const preferredDiff =
        Number(preferredKeys.has(pathKey(b.path))) -
        Number(preferredKeys.has(pathKey(a.path)));
      return preferredDiff || a.index - b.index;
    });
  const result = [];
  const identities = new Set();
  for (const candidate of candidates) {
    const normalized = candidate.path;
    let identity =
      process.platform === "win32"
        ? `path:${normalized.toLowerCase()}`
        : `path:${normalized}`;
    try {
      const stat = fssync.statSync(normalized);
      if (
        Number.isFinite(stat.dev) &&
        Number.isFinite(stat.ino) &&
        stat.ino > 0
      ) {
        identity = `inode:${stat.dev}:${stat.ino}`;
      }
    } catch (_e) {}
    if (identities.has(identity)) continue;
    identities.add(identity);
    result.push(normalized);
  }
  return result;
}

function resolveCopilotAppDbPaths(env = process.env) {
  return resolveCopilotDbPaths(
    {
      fileName: "data.db",
      overrideEnvKey: "TOKENTRACKER_COPILOT_APP_DB",
    },
    env,
  );
}

function resolveCopilotAppDbPath(env = process.env) {
  const paths = resolveCopilotAppDbPaths(env);
  for (const candidate of paths) {
    try {
      if (fssync.existsSync(candidate)) return candidate;
    } catch (_e) {}
  }
  return paths[0] || null;
}

function shouldCountCopilotAppSession(row) {
  const sessionType = typeof row?.session_type === "string" ? row.session_type.trim().toLowerCase() : "";
  const providerId = typeof row?.provider_id === "string" ? row.provider_id.trim().toLowerCase() : "";
  // OTEL remains the owner for recognizable Copilot CLI / VS Code extension
  // sessions. The App DB path is separately cursored, but skipping known
  // OTEL-backed surfaces avoids duplicate source="copilot" buckets if GitHub
  // mirrors those sessions into data.db in a future release.
  const markers = [sessionType, providerId];
  return !markers.some((value) =>
    value === "cli" ||
    value === "copilot-cli" ||
    value.includes("vscode") ||
    value.includes("extension") ||
    value.includes("otel")
  );
}

function parseCopilotAppTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return parseCopilotAppTimestamp(Number(trimmed));
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeCopilotAppModel(model) {
  if (typeof model !== "string") return "";
  const normalized = normalizeModelInput(model);
  if (!normalized) return "";
  if (/^claude-(sonnet|opus|haiku)-\d+\.\d+/.test(normalized)) {
    return normalized.replace(/^(claude-(?:sonnet|opus|haiku)-\d+)\.(\d+)/, "$1-$2");
  }
  return normalized;
}

function readCopilotAppSessionsFromSqlite(dbPath, sqliteOptions = {}) {
  const pragmaRows = readSqliteJsonRows(dbPath, "PRAGMA table_info(sessions)", {
    label: "GitHub Copilot App",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
    readOnly: true,
    throwOnReadFailure: true,
    ...sqliteOptions,
  });
  const columns = new Set(pragmaRows.map((row) => row?.name).filter(Boolean));
  if (!columns.has("id")) return [];
  const optional = (col) => (columns.has(col) ? col : `NULL AS ${col}`);
  const orderTerms = ["updated_at", "created_at"].filter((col) => columns.has(col));
  const orderBy = orderTerms.length > 0
    ? `ORDER BY COALESCE(${orderTerms.join(", ")}, ''), id`
    : "ORDER BY id";
  // Select only the columns the parser consumes. Content-ish columns like
  // `title` must stay out of the query: token counts only, never user content.
  const sql = `
    SELECT
      id,
      ${optional("session_type")},
      ${optional("model")},
      ${optional("provider_id")},
      ${optional("created_at")},
      ${optional("updated_at")},
      ${optional("total_input_tokens")},
      ${optional("total_output_tokens")},
      ${optional("total_cached_tokens")},
      ${optional("total_reasoning_tokens")}
    FROM sessions
    ${orderBy}
  `.trim();
  return readSqliteJsonRows(dbPath, sql, {
    label: "GitHub Copilot App",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    readOnly: true,
    throwOnReadFailure: true,
    ...sqliteOptions,
  });
}

function sqliteSidecarFingerprint(dbPath) {
  const out = {};
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const filePath = `${dbPath}${suffix}`;
    try {
      const stat = fssync.statSync(filePath);
      out[suffix || "db"] = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
      };
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
    }
  }
  return out;
}

function sameSqliteFingerprint(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

function getCopilotSqliteFingerprint(dbPath) {
  return sqliteSidecarFingerprint(dbPath);
}

function copilotAppBaselineTotal(value) {
  if (!value || typeof value !== "object") return 0;
  return (
    Number(value.input || 0) +
    Number(value.output || 0) +
    Number(value.cached || 0) +
    Number(value.reasoning || 0)
  );
}

function capCopilotAppSessionTotals(sessionTotals, maxEntries = 10_000) {
  const entries = Object.entries(sessionTotals);
  if (entries.length <= maxEntries) return sessionTotals;

  const nonzero = [];
  const zero = [];
  for (const entry of entries) {
    if (copilotAppBaselineTotal(entry[1]) > 0) nonzero.push(entry);
    else zero.push(entry);
  }

  zero.sort((a, b) => {
    const ta = Date.parse(a[1]?.updatedAt || "") || 0;
    const tb = Date.parse(b[1]?.updatedAt || "") || 0;
    return tb - ta;
  });
  const zeroBudget = Math.max(0, maxEntries - nonzero.length);
  const capped = Object.fromEntries([...nonzero, ...zero.slice(0, zeroBudget)]);
  for (const key of Object.keys(sessionTotals)) delete sessionTotals[key];
  Object.assign(sessionTotals, capped);
  return sessionTotals;
}

function normalizeCopilotAppTokenDelta(curr, prev) {
  const inputDelta = Math.max(0, Number(curr?.input || 0) - Number(prev?.input || 0));
  const cachedDelta = Math.max(0, Number(curr?.cached || 0) - Number(prev?.cached || 0));
  const cachedInputTokens = Math.min(cachedDelta, inputDelta);
  const inputTokens = Math.max(0, inputDelta - cachedInputTokens);
  const outputDelta = Math.max(0, Number(curr?.output || 0) - Number(prev?.output || 0));
  const reasoningDelta = Math.max(
    0,
    Number(curr?.reasoning || 0) - Number(prev?.reasoning || 0),
  );
  const reasoningTokens = Math.min(reasoningDelta, outputDelta);
  const outputTokens = Math.max(0, outputDelta - reasoningTokens);
  const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_creation_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningTokens,
    total_tokens: totalTokens,
    conversation_count: copilotAppBaselineTotal(prev) === 0 && totalTokens > 0 ? 1 : 0,
  };
}

async function parseCopilotAppDbIncremental({
  dbPath,
  dbPaths,
  cursors,
  queuePath,
  onProgress,
  env,
  sqliteOptions,
  observeOnly = false,
} = {}) {
  await ensureDir(path.dirname(queuePath));
  const paths = Array.isArray(dbPaths) && dbPaths.length > 0
    ? dbPaths
    : dbPath
      ? [dbPath]
      : resolveCopilotAppDbPaths(env || process.env);
  const appState =
    cursors.copilotApp && typeof cursors.copilotApp === "object" ? cursors.copilotApp : {};
  const dbStates =
    appState.dbs && typeof appState.dbs === "object" ? { ...appState.dbs } : {};
  const uniquePaths = uniqueCopilotDbPaths(
    paths,
    env || process.env,
    Object.keys(dbStates),
  );
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  let totalRows = 0;
  let dbErrors = 0;
  const updatedAt = new Date().toISOString();

  for (const resolvedDb of uniquePaths) {
    const dbState = dbStates[resolvedDb] && typeof dbStates[resolvedDb] === "object"
      ? dbStates[resolvedDb]
      : {};
    const sessionTotals =
      dbState.sessionTotals && typeof dbState.sessionTotals === "object"
        ? { ...dbState.sessionTotals }
        : {};
    let currentFingerprint = null;
    try {
      fssync.statSync(resolvedDb);
      currentFingerprint = sqliteSidecarFingerprint(resolvedDb);
    } catch (e) {
      if (e && e.code === "ENOENT") continue;
      dbErrors++;
      dbStates[resolvedDb] = {
        ...dbState,
        sessionTotals,
        lastError: e && e.message ? e.message : String(e),
        lastErrorAt: updatedAt,
      };
      continue;
    }

    if (dbState.lastDbFingerprint && sameSqliteFingerprint(currentFingerprint, dbState.lastDbFingerprint)) {
      dbStates[resolvedDb] = { ...dbState, sessionTotals, updatedAt };
      continue;
    }

    let snap = null;
    let rows = [];
    try {
      snap = snapshotSqliteDb(resolvedDb);
      rows = readCopilotAppSessionsFromSqlite(snap.path, sqliteOptions);
    } catch (err) {
      dbErrors++;
      dbStates[resolvedDb] = {
        ...dbState,
        sessionTotals,
        lastError: err && err.message ? err.message : String(err),
        lastErrorAt: updatedAt,
      };
      continue;
    } finally {
      if (snap) snap.cleanup();
    }
    totalRows += rows.length;

    for (const row of rows) {
      recordsProcessed++;
      if (!row || typeof row.id !== "string" || !row.id.trim()) continue;
      if (!shouldCountCopilotAppSession(row)) continue;

      const sessionId = row.id.trim();
      const curr = {
        input: toNonNegativeInt(row.total_input_tokens),
        output: toNonNegativeInt(row.total_output_tokens),
        cached: toNonNegativeInt(row.total_cached_tokens),
        reasoning: toNonNegativeInt(row.total_reasoning_tokens),
      };
      const prev = sessionTotals[sessionId] || { input: 0, output: 0, cached: 0, reasoning: 0 };
      const bucketDelta = normalizeCopilotAppTokenDelta(curr, prev);
      const totalDelta = bucketDelta.total_tokens;
      const rowUpdatedAt =
        parseCopilotAppTimestamp(row.updated_at) ||
        parseCopilotAppTimestamp(row.created_at) ||
        updatedAt;
      const model = normalizeCopilotAppModel(row.model) || COPILOT_APP_DEFAULT_MODEL;

      if (totalDelta <= 0) {
        sessionTotals[sessionId] = { ...curr, model, updatedAt: rowUpdatedAt };
        continue;
      }
      if (observeOnly) {
        sessionTotals[sessionId] = { ...curr, model, updatedAt: rowUpdatedAt };
        continue;
      }

      const bucketStart = toUtcHalfHourStart(rowUpdatedAt);
      if (!bucketStart) {
        sessionTotals[sessionId] = { ...curr, model, updatedAt: rowUpdatedAt };
        continue;
      }

      const bucket = getHourlyBucket(hourlyState, "copilot", model, bucketStart);
      addTotals(bucket.totals, bucketDelta);
      touchedBuckets.add(bucketKey("copilot", model, bucketStart));
      sessionTotals[sessionId] = { ...curr, model, updatedAt: rowUpdatedAt };
      eventsAggregated++;

      if (cb) {
        cb({
          index: recordsProcessed,
          total: Math.max(totalRows, recordsProcessed),
          recordsProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
    }

    capCopilotAppSessionTotals(sessionTotals);

    dbStates[resolvedDb] = {
      ...dbState,
      sessionTotals,
      lastDbFingerprint: currentFingerprint,
      lastError: null,
      lastErrorAt: null,
      updatedAt,
    };
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  hourlyState.updatedAt = updatedAt;
  cursors.hourly = hourlyState;
  cursors.copilotApp = {
    ...appState,
    version: COPILOT_APP_CURSOR_VERSION,
    dbs: dbStates,
    updatedAt,
  };

  return { recordsProcessed, eventsAggregated, bucketsQueued, dbErrors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grok Build (xAI) — passive reader for ~/.grok/sessions/**/updates.jsonl + signals.json
// Triggered either by full scan in sync or by the SessionEnd hook writing a signal.
// updates.jsonl exposes cumulative totalTokens metadata. Grok still does not
// expose a stable prompt/output/cache split locally, so these rows keep the
// estimated input/output split while using better local telemetry for totals.
// ─────────────────────────────────────────────────────────────────────────────

const GROK_ESTIMATED_INPUT_RATIO = 0.8;
// v4: bill from turn_completed.usage (true cumulative API usage), not context-window totalTokens.
const GROK_CURSOR_VERSION = 4;

function resolveGrokBuildHome(env = process.env) {
  if (env.TOKENTRACKER_GROK_HOME) return env.TOKENTRACKER_GROK_HOME;
  if (env.GROK_HOME) return env.GROK_HOME;
  if (process.platform === "win32") {
    return pickWin32ProviderPath({
      env,
      nativeValue: path.join(require("node:os").homedir(), ".grok"),
      wslProviderDir: ".grok",
    });
  }
  return path.join(require("node:os").homedir(), ".grok");
}

function resolveGrokBuildSessions(env = process.env) {
  const home = resolveGrokBuildHome(env);
  if (!home) return [];
  const sessionsRoot = path.join(home, "sessions");
  if (!fssync.existsSync(sessionsRoot)) return [];

  const results = [];
  let cwdDirs = [];
  try {
    cwdDirs = fssync.readdirSync(sessionsRoot);
  } catch {
    return [];
  }

  for (const cwdDir of cwdDirs) {
    const cwdPath = path.join(sessionsRoot, cwdDir);
    let stat;
    try { stat = fssync.statSync(cwdPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let sessionIds = [];
    try { sessionIds = fssync.readdirSync(cwdPath); } catch { continue; }

    for (const sid of sessionIds) {
      const sessionDir = path.join(cwdPath, sid);
      const signalsPath = path.join(sessionDir, "signals.json");
      const updatesPath = path.join(sessionDir, "updates.jsonl");
      if (fssync.existsSync(signalsPath) || fssync.existsSync(updatesPath)) {
        results.push({
          sessionDir,
          updatesPath,
          signalsPath,
          summaryPath: path.join(sessionDir, "summary.json"),
          sessionId: sid,
          encodedCwd: cwdDir
        });
      }
    }
  }
  return results;
}

function normalizeGrokSessionSnapshots(grokState) {
  const snapshots = {};
  if (grokState?.sessionSnapshots && typeof grokState.sessionSnapshots === "object") {
    for (const [sessionId, snapshot] of Object.entries(grokState.sessionSnapshots)) {
      const safeSessionId = normalizeModelInput(sessionId);
      if (!safeSessionId || !snapshot || typeof snapshot !== "object") continue;
      const totalTokens = normalizeNonNegativeNumber(snapshot.totalTokens);
      snapshots[safeSessionId] = {
        totalTokens,
        messageCount: normalizeNonNegativeNumber(snapshot.messageCount),
        model: normalizeModelInput(snapshot.model) || null,
        source: normalizeModelInput(snapshot.source) || null,
        lastEventId: normalizeModelInput(snapshot.lastEventId) || null,
        lastEventTimestamp: normalizeModelInput(snapshot.lastEventTimestamp) || null,
        updatedAt: normalizeModelInput(snapshot.updatedAt) || null,
        legacySeen: snapshot.legacySeen === true,
      };
    }
  }

  if (Array.isArray(grokState?.seenSessions)) {
    for (const sessionId of grokState.seenSessions) {
      const safeSessionId = normalizeModelInput(sessionId);
      if (!safeSessionId || snapshots[safeSessionId]) continue;
      snapshots[safeSessionId] = {
        totalTokens: 0,
        messageCount: 0,
        model: null,
        updatedAt: normalizeModelInput(grokState.updatedAt) || null,
        legacySeen: true,
      };
    }
  }

  return snapshots;
}

function capGrokSessionSnapshots(sessionSnapshots) {
  const entries = Object.entries(sessionSnapshots);
  if (entries.length <= 10_000) return sessionSnapshots;
  return Object.fromEntries(entries.slice(entries.length - 10_000));
}

function readGrokJsonFile(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fssync.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function grokUpdatesPathForSession(sess) {
  if (typeof sess?.updatesPath === "string" && sess.updatesPath.trim()) return sess.updatesPath;
  if (typeof sess?.sessionDir === "string" && sess.sessionDir.trim()) {
    return path.join(sess.sessionDir, "updates.jsonl");
  }
  return null;
}

function grokSessionIdFor(sess) {
  return (
    normalizeModelInput(sess?.sessionId) ||
    (normalizeModelInput(sess?.sessionDir) ? path.basename(sess.sessionDir) : null)
  );
}

function grokModelFromSignals(signals) {
  return (
    normalizeModelInput(signals?.primaryModelId) ||
    normalizeModelInput(Array.isArray(signals?.modelsUsed) ? signals.modelsUsed[0] : null) ||
    normalizeModelInput(signals?.model) ||
    "grok-build"
  );
}

function grokLastActiveFromSignals(signals, summary) {
  return (
    normalizeModelInput(signals?.lastActiveAt) ||
    normalizeModelInput(signals?.updatedAt) ||
    normalizeModelInput(signals?.lastActive) ||
    normalizeModelInput(summary?.updated_at) ||
    normalizeModelInput(summary?.updatedAt) ||
    new Date().toISOString()
  );
}

function grokMessageCountFromSignals(signals) {
  return normalizeNonNegativeNumber(
    signals?.assistantMessageCount ??
      signals?.turnCount ??
      signals?.num_chat_messages ??
      signals?.messageCount,
  );
}

// Context-window telemetry only. Prefer turn_completed.usage when available —
// signals.totalTokens / contextTokensUsed track the live window, not billable
// cumulative spend across a session (especially after compaction).
function grokEffectiveTotalFromSignals(signals) {
  if (!signals || typeof signals !== "object") return 0;
  const beforeCompaction = normalizeNonNegativeNumber(signals.totalTokensBeforeCompaction);
  const totalTokens = normalizeNonNegativeNumber(signals.totalTokens);
  if (signals.contextTokensUsed == null) {
    return beforeCompaction + totalTokens;
  }
  return Math.max(
    totalTokens,
    beforeCompaction + normalizeNonNegativeNumber(signals.contextTokensUsed),
  );
}

function grokTimestampToIso(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const dt = new Date(millis);
    return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) {
      return grokTimestampToIso(Number(trimmed));
    }
    const dt = new Date(trimmed);
    return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
  }
  return null;
}

function grokTimestampFromUpdate(meta, record, fallback) {
  return (
    grokTimestampToIso(meta?.agentTimestampMs) ||
    grokTimestampToIso(meta?.timestampMs) ||
    grokTimestampToIso(record?.timestamp_ms) ||
    grokTimestampToIso(record?.timestamp) ||
    grokTimestampToIso(record?.time) ||
    fallback ||
    null
  );
}

function grokEventId(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function grokFileEndsWithNewline(filePath, size) {
  if (!(size > 0)) return false;
  let fd;
  try {
    fd = fssync.openSync(filePath, "r");
    const buf = Buffer.alloc(1);
    const read = fssync.readSync(fd, buf, 0, 1, size - 1);
    return read === 1 && buf[0] === 0x0a; // trailing "\n"
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fssync.closeSync(fd);
      } catch {
        /* ignore close failure */
      }
    }
  }
}


function canonicalizeGrokUsageModel(model) {
  const raw = normalizeModelInput(model) || "grok-build";
  const lower = raw.toLowerCase();
  // Free Build SKU must not fuzzy-match paid grok-4.5 rates in native clients.
  if (lower.includes("build-free") || lower.endsWith("-free") || lower.includes("free-tier")) {
    return "grok-build-free";
  }
  if (lower === "grok-4.5-build" || lower === "grok-4-5-build") {
    return "grok-4.5-build";
  }
  return raw;
}

function normalizeGrokTurnUsage(usage, model, timestamp, eventId) {
  if (!usage || typeof usage !== "object") return null;
  const inputRaw = normalizeNonNegativeNumber(
    usage.inputTokens ?? usage.input_tokens,
  );
  const output = normalizeNonNegativeNumber(
    usage.outputTokens ?? usage.output_tokens,
  );
  const cached = normalizeNonNegativeNumber(
    usage.cachedReadTokens ??
      usage.cache_read_input_tokens ??
      usage.cached_input_tokens,
  );
  const reasoning = normalizeNonNegativeNumber(
    usage.reasoningTokens ?? usage.reasoning_output_tokens,
  );
  // Grok reports inputTokens as the full prompt (including cache hits). Split
  // so pricing can apply cache_read rates correctly.
  const nonCachedInput = Math.max(0, inputRaw - cached);
  let total = normalizeNonNegativeNumber(usage.totalTokens ?? usage.total_tokens);
  if (total <= 0) {
    total = inputRaw + output + reasoning;
  }
  if (total <= 0 && nonCachedInput <= 0 && cached <= 0 && output <= 0) return null;
  return {
    input_tokens: nonCachedInput,
    cached_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total > 0 ? total : nonCachedInput + cached + output + reasoning,
    billable_total_tokens: total > 0 ? total : nonCachedInput + cached + output + reasoning,
    conversation_count: 1,
    model: canonicalizeGrokUsageModel(model),
    timestamp,
    eventId,
  };
}

function extractGrokTurnUsageEvents(record, fallbackTimestamp, fallbackModel, lineIndex) {
  const update = record?.params?.update;
  if (!update || typeof update !== "object") return [];
  if (update.sessionUpdate !== "turn_completed") return [];
  const usage = update.usage;
  if (!usage || typeof usage !== "object") return [];

  const meta = record?.params?._meta || record?._meta || {};
  const timestamp = grokTimestampFromUpdate(meta, record, fallbackTimestamp);
  const baseEventId = grokEventId(
    meta.eventId ?? record?.eventId ?? record?.id ?? update.prompt_id,
    String(lineIndex),
  );

  const modelUsage =
    usage.modelUsage && typeof usage.modelUsage === "object" ? usage.modelUsage : null;
  const events = [];
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    for (const [modelName, modelUsageEntry] of Object.entries(modelUsage)) {
      if (!modelUsageEntry || typeof modelUsageEntry !== "object") continue;
      const event = normalizeGrokTurnUsage(
        modelUsageEntry,
        modelName,
        timestamp,
        `${baseEventId}|${modelName}`,
      );
      if (event) events.push(event);
    }
  }
  if (events.length === 0) {
    const event = normalizeGrokTurnUsage(usage, fallbackModel, timestamp, baseEventId);
    if (event) events.push(event);
  }
  return events;
}

// Context-window watermark events (legacy / fallback only).
function extractGrokContextTokenEvent(record, fallbackTimestamp, lineIndex) {
  const meta = record?.params?._meta || record?._meta;
  if (!meta || typeof meta !== "object") return null;
  const totalTokens = normalizeNonNegativeNumber(meta.totalTokens);
  if (totalTokens <= 0) return null;
  return {
    totalTokens,
    timestamp: grokTimestampFromUpdate(meta, record, fallbackTimestamp),
    eventId: grokEventId(meta.eventId ?? record?.eventId ?? record?.id, String(lineIndex)),
  };
}

async function readGrokUpdateTokenEvents(updatesPath, fallbackTimestamp, prevOffsetEntry, options = {}) {
  const fallbackModel = options.fallbackModel || "grok-build";
  if (!updatesPath) {
    return { turnEvents: [], contextEvents: [], offsetEntry: null };
  }
  let stat;
  try {
    stat = fssync.statSync(updatesPath);
    if (!stat.isFile()) return { turnEvents: [], contextEvents: [], offsetEntry: null };
  } catch {
    return { turnEvents: [], contextEvents: [], offsetEntry: null };
  }

  // updates.jsonl is append-only. Turn usage is additive per turn_completed, so
  // resuming from the last consumed byte is safe. Re-read from 0 on truncation
  // or inode change.
  const prevSize = Number(prevOffsetEntry?.size) || 0;
  const prevIno = prevOffsetEntry?.ino;
  const inodeChanged = typeof prevIno === "number" && prevIno !== stat.ino;
  const startOffset = stat.size < prevSize || inodeChanged ? 0 : prevSize;
  const baseOffset = { mtimeMs: stat.mtimeMs, ino: stat.ino };
  if (stat.size <= startOffset) {
    return {
      turnEvents: [],
      contextEvents: [],
      offsetEntry: { size: startOffset, ...baseOffset },
    };
  }

  // Only advance the stored offset to the end of the last newline-terminated
  // line. If Grok is mid-write, the final JSONL line has no trailing "\n" yet;
  // its bytes are left unconsumed so the next scan re-reads the line once it is
  // complete instead of skipping it forever (which would undercount tokens).
  const endsWithNewline = grokFileEndsWithNewline(updatesPath, stat.size);

  const turnEvents = [];
  const contextEvents = [];
  let lineIndex = 0;
  let lastLine = "";
  const input = fssync.createReadStream(updatesPath, {
    encoding: "utf8",
    start: startOffset,
    end: stat.size - 1, // inclusive; bound the read to the stat'd size
  });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lineIndex++;
      lastLine = line;
      if (!line || !line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const turns = extractGrokTurnUsageEvents(
        record,
        fallbackTimestamp,
        fallbackModel,
        lineIndex,
      );
      if (turns.length > 0) {
        turnEvents.push(...turns);
        continue;
      }
      const contextEvent = extractGrokContextTokenEvent(record, fallbackTimestamp, lineIndex);
      if (contextEvent) contextEvents.push(contextEvent);
    }
  } catch {
    // Stream error mid-read: discard partial events and do not advance the
    // offset, so the next sync re-extracts from the same range exactly once
    // instead of double-counting already-parsed turn events.
    return { turnEvents: [], contextEvents: [], offsetEntry: prevOffsetEntry || null };
  }

  // When the file does not end on a newline, the final emitted line is a
  // partial tail still being written. Exclude its bytes so the committed offset
  // stays on a complete-line boundary and the line is re-read once finished.
  const trailingPartialBytes = endsWithNewline ? 0 : Buffer.byteLength(lastLine, "utf8");
  const committedSize = Math.max(startOffset, stat.size - trailingPartialBytes);
  return {
    turnEvents,
    contextEvents,
    offsetEntry: { size: committedSize, ...baseOffset },
  };
}

function estimateGrokTokenDelta(totalTokens, conversationCount, options = {}) {
  const total = Math.trunc(normalizeNonNegativeNumber(totalTokens));
  const inputTokens = Math.round(total * GROK_ESTIMATED_INPUT_RATIO);
  const outputTokens = Math.max(0, total - inputTokens);
  const rawConversations = Math.trunc(normalizeNonNegativeNumber(conversationCount));
  const conversations = options.allowZeroConversationCount ? rawConversations : Math.max(1, rawConversations);

  return {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: total,
    billable_total_tokens: total,
    conversation_count: conversations,
  };
}

function clearGrokHourlyBuckets(hourlyState) {
  if (!hourlyState || typeof hourlyState !== "object") return;
  const buckets = hourlyState.buckets && typeof hourlyState.buckets === "object" ? hourlyState.buckets : null;
  if (buckets) {
    for (const key of Object.keys(buckets)) {
      if (key.startsWith("grok|")) delete buckets[key];
    }
  }
  const groupQueued =
    hourlyState.groupQueued && typeof hourlyState.groupQueued === "object"
      ? hourlyState.groupQueued
      : null;
  if (groupQueued) {
    for (const key of Object.keys(groupQueued)) {
      if (key.startsWith("grok|")) delete groupQueued[key];
    }
  }
}

async function retractStaleGrokQueueRows(queuePath, keepKeys) {
  if (!queuePath) return 0;
  let raw = "";
  try {
    raw = fssync.readFileSync(queuePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  const latestGrok = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if ((row?.source || "") !== "grok") continue;
    const model = normalizeModelInput(row.model) || DEFAULT_MODEL;
    const hourStart = typeof row.hour_start === "string" ? row.hour_start : null;
    if (!hourStart) continue;
    latestGrok.set(bucketKey("grok", model, hourStart), { model, hour_start: hourStart, row });
  }

  const zero = initTotals();
  const lines = [];
  for (const [key, entry] of latestGrok.entries()) {
    if (keepKeys.has(key)) continue;
    if (totalsKey(entry.row) === totalsKey(zero)) continue;
    lines.push(
      JSON.stringify({
        source: "grok",
        model: entry.model,
        hour_start: entry.hour_start,
        ...zero,
      }),
    );
  }
  if (lines.length === 0) return 0;
  await fs.appendFile(queuePath, `${lines.join("\n")}\n`, "utf8");
  return lines.length;
}

function pruneMissingGrokProjectUpdateOffsets(projectUpdateOffsets) {
  if (!projectUpdateOffsets || typeof projectUpdateOffsets !== "object") return;
  for (const updatesPath of Object.keys(projectUpdateOffsets)) {
    if (typeof updatesPath !== "string" || !updatesPath) {
      delete projectUpdateOffsets[updatesPath];
      continue;
    }
    try {
      if (!fssync.existsSync(updatesPath)) delete projectUpdateOffsets[updatesPath];
    } catch {
      delete projectUpdateOffsets[updatesPath];
    }
  }
}

function grokTryDecodeUriComponent(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const decoded = decodeURIComponent(trimmed).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function grokEncodedCwdLooksEncoded(value) {
  return typeof value === "string" && /%[0-9A-Fa-f]{2}/.test(value);
}

// First non-empty wins: summary.info.cwd, hook sess.cwd, decode(encodedCwd),
// then decode(basename(dirname(sessionDir))). Do not guess from updates.jsonl.
function resolveGrokSessionCwd(sess, summary) {
  const summaryCwd = summary?.info?.cwd;
  if (typeof summaryCwd === "string" && summaryCwd.trim()) return summaryCwd.trim();
  if (typeof sess?.cwd === "string" && sess.cwd.trim()) return sess.cwd.trim();
  if (grokEncodedCwdLooksEncoded(sess?.encodedCwd)) {
    const decoded = grokTryDecodeUriComponent(sess.encodedCwd);
    if (decoded) return decoded;
  }
  const sessionDir = typeof sess?.sessionDir === "string" ? sess.sessionDir.trim() : "";
  if (sessionDir) {
    const decoded = grokTryDecodeUriComponent(path.basename(path.dirname(sessionDir)));
    if (decoded) return decoded;
  }
  return null;
}

async function parseGrokBuildIncremental({
  sessions,
  cursors = {},
  queuePath,
  projectQueuePath,
  publicRepoResolver,
  onProgress,
  env = process.env
} = {}) {
  if (queuePath) await ensureDir(path.dirname(queuePath));
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const grokState = cursors.grok && typeof cursors.grok === "object" ? { ...cursors.grok } : {};
  const prevVersion = Number(grokState.version) || 0;
  const needsTurnUsageMigration = prevVersion < GROK_CURSOR_VERSION;

  // v3 and earlier treated context-window totalTokens as cumulative spend, which
  // undercounts heavily (often 10-50x) and mis-splits input/output. Rebuild from
  // turn_completed.usage when migrating to v4.
  //
  // Drop prior watermark totals / updateOffsets so files are re-read from byte 0,
  // but keep legacySeen markers from seenSessions so the one-shot baseline
  // (sessions already counted under the old scanner) still applies.
  let sessionSnapshots;
  if (needsTurnUsageMigration) {
    const normalized = normalizeGrokSessionSnapshots(grokState);
    sessionSnapshots = {};
    for (const [sessionId, snapshot] of Object.entries(normalized)) {
      if (!snapshot?.legacySeen) continue;
      sessionSnapshots[sessionId] = {
        totalTokens: 0,
        messageCount: 0,
        model: null,
        source: null,
        lastEventId: null,
        lastEventTimestamp: null,
        updatedAt: snapshot.updatedAt || null,
        legacySeen: true,
      };
    }
    clearGrokHourlyBuckets(hourlyState);
  } else {
    sessionSnapshots = normalizeGrokSessionSnapshots(grokState);
  }
  const prevUpdateOffsets =
    !needsTurnUsageMigration &&
    grokState.updateOffsets &&
    typeof grokState.updateOffsets === "object"
      ? grokState.updateOffsets
      : {};

  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  // Independent of global updateOffsets so an upgrade can backfill historical
  // turn_completed events into project.queue.jsonl without re-appending totals.
  const projectUpdateOffsets =
    projectEnabled &&
    grokState.projectUpdateOffsets &&
    typeof grokState.projectUpdateOffsets === "object"
      ? { ...grokState.projectUpdateOffsets }
      : {};
  const projectSessionSnapshots = projectEnabled
    ? normalizeGrokSessionSnapshots({
        sessionSnapshots: grokState.projectSessionSnapshots,
      })
    : {};

  // Rebuilt from the sessions seen this scan, so entries for deleted session
  // dirs are pruned and the cursor stays bounded by the on-disk session count.
  const updateOffsets = {};
  const touchedBuckets = new Set();

  const sessionList = Array.isArray(sessions) && sessions.length > 0
    ? sessions
    : resolveGrokBuildSessions(env);

  let eventsAggregated = 0;

  for (let index = 0; index < sessionList.length; index++) {
    const sess = sessionList[index];
    const sessionId = grokSessionIdFor(sess);
    if (!sessionId) {
      if (onProgress) onProgress({ index: index + 1, total: sessionList.length, bucketsQueued: touchedBuckets.size });
      continue;
    }

    const signals = sess?.signals && typeof sess.signals === "object"
      ? sess.signals
      : readGrokJsonFile(sess?.signalsPath);
    const safeSignals = signals && typeof signals === "object" ? signals : {};

    const summary = sess?.summary && typeof sess.summary === "object"
      ? sess.summary
      : readGrokJsonFile(sess?.summaryPath) || {};
    const previous = sessionSnapshots[sessionId] || {};
    const previousTotal = normalizeNonNegativeNumber(previous.totalTokens);
    const previousMessageCount = normalizeNonNegativeNumber(previous.messageCount);
    const messageCount = grokMessageCountFromSignals(safeSignals);
    const model = grokModelFromSignals(safeSignals);
    const lastActive = grokLastActiveFromSignals(safeSignals, summary);

    let cumulativeTotal = previousTotal;
    let tokenDeltaForSession = 0;
    let finalTouchedHourStart = null;
    let source = previous.source || null;
    let lastEventId = previous.lastEventId || null;
    let lastEventTimestamp = previous.lastEventTimestamp || null;
    let lastModel = previous.model || model;
    let sawTurnUsage = source === "turn_usage" || previous.source === "turn_usage";
    // Defer bucket writes until after we know whether this is a legacy baseline
    // pass (first sighting of a session already counted under an older scanner).
    const pendingBucketDeltas = [];

    const updatesPath = grokUpdatesPathForSession(sess);
    const updates = await readGrokUpdateTokenEvents(
      updatesPath,
      lastActive,
      updatesPath ? prevUpdateOffsets[updatesPath] : null,
      { fallbackModel: model },
    );
    if (updatesPath && updates.offsetEntry) {
      updateOffsets[updatesPath] = updates.offsetEntry;
    }

    // Preferred path: each turn_completed carries true cumulative API usage for
    // that turn (input/output/cache/reasoning). Sum them.
    for (const event of updates.turnEvents) {
      sawTurnUsage = true;
      const hourStartStr = toUtcHalfHourStart(event.timestamp) || toUtcHalfHourStart(lastActive) || toUtcHalfHourStart(Date.now());
      if (!hourStartStr) continue;
      const eventModel = event.model || model;
      const delta = {
        input_tokens: event.input_tokens,
        cached_input_tokens: event.cached_input_tokens,
        cache_creation_input_tokens: event.cache_creation_input_tokens,
        output_tokens: event.output_tokens,
        reasoning_output_tokens: event.reasoning_output_tokens,
        total_tokens: event.total_tokens,
        billable_total_tokens: event.billable_total_tokens,
        conversation_count: event.conversation_count || 1,
      };
      pendingBucketDeltas.push({ model: eventModel, hourStartStr, delta });
      cumulativeTotal += event.total_tokens;
      tokenDeltaForSession += event.total_tokens;
      finalTouchedHourStart = hourStartStr;
      source = "turn_usage";
      lastEventId = event.eventId || lastEventId;
      lastEventTimestamp = event.timestamp || lastEventTimestamp;
      lastModel = eventModel;
    }

    // Fallback only when this session never emitted turn_completed usage
    // (older logs / partial sessions). Context watermark is a lower-bound
    // estimate and must not run on top of turn usage.
    if (!sawTurnUsage) {
      let highWatermark = previousTotal;
      for (const event of updates.contextEvents) {
        lastEventId = event.eventId || lastEventId;
        lastEventTimestamp = event.timestamp || lastEventTimestamp;
        if (event.totalTokens <= highWatermark) continue;
        const deltaTokens = event.totalTokens - highWatermark;
        highWatermark = event.totalTokens;
        const hourStartStr =
          toUtcHalfHourStart(event.timestamp) ||
          toUtcHalfHourStart(lastActive) ||
          toUtcHalfHourStart(Date.now());
        if (!hourStartStr) continue;
        const delta = estimateGrokTokenDelta(deltaTokens, 0, { allowZeroConversationCount: true });
        pendingBucketDeltas.push({ model, hourStartStr, delta });
        tokenDeltaForSession += deltaTokens;
        finalTouchedHourStart = hourStartStr;
        source = "updates";
      }

      const effectiveSignalTotal = grokEffectiveTotalFromSignals(safeSignals);
      if (effectiveSignalTotal > highWatermark) {
        const deltaTokens = effectiveSignalTotal - highWatermark;
        highWatermark = effectiveSignalTotal;
        const hourStartStr = toUtcHalfHourStart(lastActive) || toUtcHalfHourStart(Date.now());
        if (hourStartStr) {
          const delta = estimateGrokTokenDelta(deltaTokens, 0, { allowZeroConversationCount: true });
          pendingBucketDeltas.push({ model, hourStartStr, delta });
          tokenDeltaForSession += deltaTokens;
          finalTouchedHourStart = hourStartStr;
          source = "signals";
        }
      }
      cumulativeTotal = Math.max(previousTotal, highWatermark);
    }

    const finalTotal = Math.max(previousTotal, cumulativeTotal);
    // Sessions already observed under an older scanner must establish a watermark
    // without backfilling historical tokens as brand-new usage.
    const legacyBaselineOnly = previous.legacySeen && previousTotal === 0 && finalTotal > 0;

    if (!legacyBaselineOnly) {
      for (const pending of pendingBucketDeltas) {
        const bucket = getHourlyBucket(hourlyState, "grok", pending.model, pending.hourStartStr);
        addTotals(bucket.totals, pending.delta);
        touchedBuckets.add(bucketKey("grok", pending.model, pending.hourStartStr));
        eventsAggregated++;
      }

      // Message/conversation count for fallback-only sessions (turn path already
      // counts each turn_completed as one conversation).
      if (!sawTurnUsage && tokenDeltaForSession > 0 && finalTouchedHourStart) {
        const deltaMessageCount =
          messageCount > previousMessageCount ? messageCount - previousMessageCount : 1;
        const bucket = getHourlyBucket(hourlyState, "grok", lastModel || model, finalTouchedHourStart);
        addTotals(bucket.totals, { conversation_count: deltaMessageCount });
        touchedBuckets.add(bucketKey("grok", lastModel || model, finalTouchedHourStart));
      }
    }

    if (finalTotal > 0 && (tokenDeltaForSession > 0 || previousTotal > 0 || legacyBaselineOnly)) {
      sessionSnapshots[sessionId] = {
        totalTokens: finalTotal,
        messageCount: Math.max(previousMessageCount, messageCount),
        model: lastModel || model,
        source: source || previous.source || null,
        lastEventId,
        lastEventTimestamp,
        updatedAt: new Date().toISOString(),
      };
    } else if (previous.legacySeen && finalTotal === 0) {
      // Keep the baseline marker across empty syncs so later growth is still
      // baselined once instead of backfilled as brand-new usage.
      sessionSnapshots[sessionId] = {
        totalTokens: 0,
        messageCount: Math.max(previousMessageCount, messageCount),
        model: lastModel || model,
        source: previous.source || null,
        lastEventId: lastEventId || previous.lastEventId || null,
        lastEventTimestamp: lastEventTimestamp || previous.lastEventTimestamp || null,
        updatedAt: new Date().toISOString(),
        legacySeen: true,
      };
    }

    if (projectEnabled) {
      const cwd = resolveGrokSessionCwd(sess, summary);
      if (cwd) {
        const projectContext = await resolveProjectContextForPath({
          startDir: wsl.mapWslCwdToUnc(cwd, updatesPath || sess?.sessionDir || cwd),
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        });
        const projectRef = projectContext?.projectRef || null;
        const projectKey = projectContext?.projectKey || null;
        // Only advance the project cursor on successful public_verified attribution.
        // Blocked / missing git / unverified stay unadvanced so a later sync can retry.
        if (projectKey && projectRef) {
          const projectPrevious = projectSessionSnapshots[sessionId] || {};
          const projectPreviousTotal = normalizeNonNegativeNumber(projectPrevious.totalTokens);
          const projectPreviousMessageCount = normalizeNonNegativeNumber(
            projectPrevious.messageCount,
          );
          let projectSawTurnUsage = projectPrevious.source === "turn_usage";
          let projectCumulativeTotal = projectPreviousTotal;
          let projectTokenDelta = 0;
          let projectFinalTouchedHourStart = null;
          let projectSource = projectPrevious.source || null;
          let projectLastModel = projectPrevious.model || model;
          const projectPendingDeltas = [];

          const projectUpdates = await readGrokUpdateTokenEvents(
            updatesPath,
            lastActive,
            updatesPath ? projectUpdateOffsets[updatesPath] : null,
            { fallbackModel: model },
          );

          for (const event of projectUpdates.turnEvents) {
            projectSawTurnUsage = true;
            const hourStartStr =
              toUtcHalfHourStart(event.timestamp) ||
              toUtcHalfHourStart(lastActive) ||
              toUtcHalfHourStart(Date.now());
            if (!hourStartStr) continue;
            const eventModel = event.model || model;
            const delta = {
              input_tokens: event.input_tokens,
              cached_input_tokens: event.cached_input_tokens,
              cache_creation_input_tokens: event.cache_creation_input_tokens,
              output_tokens: event.output_tokens,
              reasoning_output_tokens: event.reasoning_output_tokens,
              total_tokens: event.total_tokens,
              billable_total_tokens: event.billable_total_tokens,
              conversation_count: event.conversation_count || 1,
            };
            projectPendingDeltas.push({ model: eventModel, hourStartStr, delta });
            projectCumulativeTotal += event.total_tokens;
            projectTokenDelta += event.total_tokens;
            projectFinalTouchedHourStart = hourStartStr;
            projectSource = "turn_usage";
            projectLastModel = eventModel;
          }

          // Watermark fallback uses the independent project snapshot, never
          // global sessionSnapshots.totalTokens, and never stacks on turn usage.
          if (!projectSawTurnUsage) {
            let highWatermark = projectPreviousTotal;
            for (const event of projectUpdates.contextEvents) {
              if (event.totalTokens <= highWatermark) continue;
              const deltaTokens = event.totalTokens - highWatermark;
              highWatermark = event.totalTokens;
              const hourStartStr =
                toUtcHalfHourStart(event.timestamp) ||
                toUtcHalfHourStart(lastActive) ||
                toUtcHalfHourStart(Date.now());
              if (!hourStartStr) continue;
              const delta = estimateGrokTokenDelta(deltaTokens, 0, {
                allowZeroConversationCount: true,
              });
              projectPendingDeltas.push({ model, hourStartStr, delta });
              projectTokenDelta += deltaTokens;
              projectFinalTouchedHourStart = hourStartStr;
              projectSource = "updates";
            }

            const effectiveSignalTotal = grokEffectiveTotalFromSignals(safeSignals);
            if (effectiveSignalTotal > highWatermark) {
              const deltaTokens = effectiveSignalTotal - highWatermark;
              highWatermark = effectiveSignalTotal;
              const hourStartStr =
                toUtcHalfHourStart(lastActive) || toUtcHalfHourStart(Date.now());
              if (hourStartStr) {
                const delta = estimateGrokTokenDelta(deltaTokens, 0, {
                  allowZeroConversationCount: true,
                });
                projectPendingDeltas.push({ model, hourStartStr, delta });
                projectTokenDelta += deltaTokens;
                projectFinalTouchedHourStart = hourStartStr;
                projectSource = "signals";
              }
            }
            projectCumulativeTotal = Math.max(projectPreviousTotal, highWatermark);
          }

          const projectFinalTotal = Math.max(projectPreviousTotal, projectCumulativeTotal);

          // legacyBaselineOnly applies only to global buckets.
          for (const pending of projectPendingDeltas) {
            const projectBucket = getProjectBucket(
              projectState,
              projectKey,
              "grok",
              pending.hourStartStr,
              projectRef,
            );
            addTotals(projectBucket.totals, pending.delta);
            projectTouchedBuckets.add(
              projectBucketKey(projectKey, "grok", pending.hourStartStr),
            );
          }

          if (!projectSawTurnUsage && projectTokenDelta > 0 && projectFinalTouchedHourStart) {
            const deltaMessageCount =
              messageCount > projectPreviousMessageCount
                ? messageCount - projectPreviousMessageCount
                : 1;
            const projectBucket = getProjectBucket(
              projectState,
              projectKey,
              "grok",
              projectFinalTouchedHourStart,
              projectRef,
            );
            addTotals(projectBucket.totals, { conversation_count: deltaMessageCount });
            projectTouchedBuckets.add(
              projectBucketKey(projectKey, "grok", projectFinalTouchedHourStart),
            );
          }

          if (updatesPath && projectUpdates.offsetEntry) {
            projectUpdateOffsets[updatesPath] = projectUpdates.offsetEntry;
          }

          if (projectFinalTotal > 0 && (projectTokenDelta > 0 || projectPreviousTotal > 0)) {
            projectSessionSnapshots[sessionId] = {
              totalTokens: projectFinalTotal,
              messageCount: Math.max(projectPreviousMessageCount, messageCount),
              model: projectLastModel || model,
              source: projectSource || projectPrevious.source || null,
              updatedAt: new Date().toISOString(),
            };
          }
        }
      }
    }

    if (onProgress) {
      onProgress({ index: index + 1, total: sessionList.length, bucketsQueued: touchedBuckets.size });
    }
  }

  if (projectEnabled) pruneMissingGrokProjectUpdateOffsets(projectUpdateOffsets);

  let bucketsQueued = queuePath
    ? await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets })
    : 0;

  // After a semantics migration, retract stale grok queue keys that the full
  // rescan no longer produces so dashboard "latest per key" no longer keeps
  // the old undercounted rows.
  if (needsTurnUsageMigration && queuePath) {
    const keepKeys = new Set();
    for (const [key, bucket] of Object.entries(hourlyState.buckets || {})) {
      if (!key.startsWith("grok|") || !bucket?.totals) continue;
      keepKeys.add(key);
    }
    const retracted = await retractStaleGrokQueueRows(queuePath, keepKeys);
    bucketsQueued += retracted;
  }

  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({
        projectQueuePath,
        projectState,
        projectTouchedBuckets,
      })
    : 0;

  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = hourlyState.updatedAt;
    cursors.projectHourly = projectState;
  }
  sessionSnapshots = capGrokSessionSnapshots(sessionSnapshots);

  const migrations = grokState.migrations && typeof grokState.migrations === "object"
    ? { ...grokState.migrations }
    : {};
  if (needsTurnUsageMigration) {
    migrations.turnUsageV4 = {
      appliedAt: new Date().toISOString(),
      fromVersion: prevVersion,
      toVersion: GROK_CURSOR_VERSION,
    };
  }

  cursors.grok = {
    ...grokState,
    version: GROK_CURSOR_VERSION,
    sessionSnapshots,
    seenSessions: Object.keys(sessionSnapshots),
    updateOffsets,
    ...(projectEnabled
      ? {
          projectUpdateOffsets,
          projectSessionSnapshots: capGrokSessionSnapshots(projectSessionSnapshots),
        }
      : {}),
    migrations,
    updatedAt: new Date().toISOString()
  };

  return {
    recordsProcessed: eventsAggregated,
    eventsAggregated,
    bucketsQueued,
    projectBucketsQueued,
  };
}

function resolveAntigravityBrainDirs(geminiHome) {
  if (!geminiHome || typeof geminiHome !== "string") return [];
  return [
    path.join(geminiHome, "antigravity", "brain"),
    path.join(geminiHome, "antigravity-ide", "brain"),
    path.join(geminiHome, "antigravity-cli", "brain"),
  ];
}

async function listAntigravitySessionFiles(brainDir) {
  const out = [];
  if (!brainDir || typeof brainDir !== "string") return out;
  const entries = await safeReadDir(brainDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const logsDir = path.join(brainDir, entry.name, ".system_generated", "logs");
    const transcriptPath = path.join(logsDir, "transcript.jsonl");
    const st = await fs.stat(transcriptPath).catch(() => null);
    if (st && st.isFile()) {
      out.push(transcriptPath);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function listAntigravityTranscripts(geminiHome) {
  const dirs = resolveAntigravityBrainDirs(geminiHome);
  const lists = await Promise.all(dirs.map((dir) => listAntigravitySessionFiles(dir)));
  return lists.flat();
}

async function parseAntigravityIncremental({
  sessionFiles,
  cursors,
  queuePath,
  projectQueuePath,
  onProgress,
  source,
  publicRepoResolver,
}) {
  await ensureDir(path.dirname(queuePath));
  let filesProcessed = 0;
  let eventsAggregated = 0;

  const cb = typeof onProgress === "function" ? onProgress : null;
  const files = Array.isArray(sessionFiles) ? sessionFiles : [];
  const totalFiles = files.length;
  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const projectEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;
  const projectState = projectEnabled ? normalizeProjectState(cursors?.projectHourly) : null;
  const projectTouchedBuckets = projectEnabled ? new Set() : null;
  const projectMetaCache = projectEnabled ? new Map() : null;
  const publicRepoCache = projectEnabled ? new Map() : null;
  const touchedBuckets = new Set();
  const defaultSource = normalizeSourceInput(source) || "antigravity";

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath) continue;
    const fileSource =
      typeof entry === "string"
        ? defaultSource
        : normalizeSourceInput(entry?.source) || defaultSource;
    const st = await fs.stat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;

    const key = filePath;
    const prev = cursors.files[key] || null;
    const inode = st.ino || 0;
    const size = Number.isFinite(st.size) ? st.size : 0;
    const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;

    const unchanged =
      prev && prev.inode === inode && prev.size === size && prev.mtimeMs === mtimeMs;
    if (unchanged) {
      filesProcessed += 1;
      if (cb) {
        cb({
          index: idx + 1,
          total: totalFiles,
          filePath,
          filesProcessed,
          eventsAggregated,
          bucketsQueued: touchedBuckets.size,
        });
      }
      continue;
    }

    const sameFile = prev && prev.inode === inode;
    const lastLine = sameFile ? Number(prev.lastLine || 0) : 0;
    const initialContextTokens = sameFile ? Number(prev.contextTokens || 0) : 0;
    const initialPrevContext = sameFile ? Number(prev.previousContextTokens || 0) : 0;
    const initialModel = sameFile && typeof prev.currentModel === "string" ? prev.currentModel : null;

    const projectContext = projectEnabled
      ? await resolveProjectContextForFile({
          filePath,
          projectMetaCache,
          publicRepoCache,
          publicRepoResolver,
          projectState,
        })
      : null;
    const projectRef = projectContext?.projectRef || null;
    const projectKey = projectContext?.projectKey || null;

    const result = await parseAntigravityFile({
      filePath,
      lastLine,
      initialContextTokens,
      initialPrevContext,
      initialModel,
      hourlyState,
      touchedBuckets,
      source: fileSource,
      projectState,
      projectTouchedBuckets,
      projectRef,
      projectKey,
    });

    cursors.files[key] = {
      inode,
      size,
      mtimeMs,
      lastLine: result.lastLine,
      contextTokens: result.contextTokens,
      previousContextTokens: result.previousContextTokens,
      currentModel: result.currentModel,
      updatedAt: new Date().toISOString(),
    };

    filesProcessed += 1;
    eventsAggregated += result.eventsAggregated;

    if (cb) {
      cb({
        index: idx + 1,
        total: totalFiles,
        filePath,
        filesProcessed,
        eventsAggregated,
        bucketsQueued: touchedBuckets.size,
      });
    }
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  const projectBucketsQueued = projectEnabled
    ? await enqueueTouchedProjectBuckets({ projectQueuePath, projectState, projectTouchedBuckets })
    : 0;
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  if (projectState) {
    projectState.updatedAt = new Date().toISOString();
    cursors.projectHourly = projectState;
  }

  return { filesProcessed, eventsAggregated, bucketsQueued, projectBucketsQueued };
}

async function parseAntigravityFile({
  filePath,
  lastLine,
  initialContextTokens,
  initialPrevContext,
  initialModel,
  hourlyState,
  touchedBuckets,
  source,
  projectState,
  projectTouchedBuckets,
  projectRef,
  projectKey,
}) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return {
      lastLine: 0,
      eventsAggregated: 0,
      contextTokens: 0,
      previousContextTokens: 0,
      currentModel: null,
    };
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let eventsAggregated = 0;
  // Resume cached context-token total + model so historical lines (i < lastLine)
  // don't need to be re-tokenized on every sync. Falls back to a full re-walk
  // when the cached state is missing (legacy cursor) or the file rotated.
  const canResume =
    Number.isFinite(lastLine) && lastLine > 0 && lastLine <= lines.length;
  const cachedTokens = Number.isFinite(initialContextTokens) ? initialContextTokens : 0;
  const cachedPrev = Number.isFinite(initialPrevContext) ? initialPrevContext : 0;
  const cachedModel = typeof initialModel === "string" ? initialModel : null;
  const resumed = canResume && (cachedTokens > 0 || cachedModel !== null);
  const scanStart = resumed ? lastLine : 0;
  let currentModel = resumed ? cachedModel : null;
  if (!currentModel) {
    currentModel = await readAntigravityDefaultModel(filePath);
  }
  let contextTokens = resumed ? cachedTokens : 0;
  // Snapshot of contextTokens at the last PLANNER_RESPONSE we billed for. Only
  // tokens accumulated AFTER that point count as new input on the next planner
  // call — prevents O(N²) double-counting of the full history every turn.
  let previousContextTokens = resumed ? cachedPrev : 0;
  let lastCompletedLine = Math.min(Number.isFinite(lastLine) ? lastLine : 0, lines.length);

  for (let i = scanStart; i < lines.length; i++) {
    const line = lines[i];

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_e) {
      if (i >= lastLine) break;
      continue;
    }

    const isNewEvent = i >= lastLine;

    if (parsed.type === "USER_INPUT" || parsed.type === "USER_SETTINGS_CHANGE") {
      const content = typeof parsed.content === "string" ? parsed.content : "";
      const model = parseAntigravityModelSelection(content);
      if (model) currentModel = model;
    }

    const eventContextTokens = antigravityContextTokens(parsed);

    if (!isNewEvent) {
      contextTokens += eventContextTokens;
      lastCompletedLine = i + 1;
      continue;
    }

    const timestamp = parsed.created_at;
    if (!timestamp) {
      contextTokens += eventContextTokens;
      lastCompletedLine = i + 1;
      continue;
    }

    const bucketStart = toUtcHalfHourStart(timestamp);
    if (!bucketStart) {
      contextTokens += eventContextTokens;
      lastCompletedLine = i + 1;
      continue;
    }

    let model = currentModel || "antigravity-unknown";
    let delta = initTotals();
    let billedPlanner = false;

    if (parsed.type === "PLANNER_RESPONSE") {
      const content = typeof parsed.content === "string" ? parsed.content : "";
      const thinking = typeof parsed.thinking === "string" ? parsed.thinking : "";

      const inputDelta = Math.max(0, contextTokens - previousContextTokens);
      const outputTokens =
        antigravityValueTokens(content) + antigravityValueTokens(parsed.tool_calls);
      const reasoningTokens = antigravityValueTokens(thinking);

      delta.input_tokens = inputDelta;
      delta.output_tokens = outputTokens;
      delta.reasoning_output_tokens = reasoningTokens;
      // Match the mainstream convention (Codebuddy / Kilocode / OMP / Hermes):
      // total_tokens = sum of every token column. No cache columns here.
      delta.total_tokens = inputDelta + outputTokens + reasoningTokens;
      delta.conversation_count = 1;
      billedPlanner = delta.total_tokens > 0;
    }

    if (!billedPlanner) {
      contextTokens += eventContextTokens;
      lastCompletedLine = i + 1;
      continue;
    }

    const bucket = getHourlyBucket(hourlyState, source, model, bucketStart);
    addTotals(bucket.totals, delta);
    touchedBuckets.add(bucketKey(source, model, bucketStart));

    if (projectKey && projectState && projectTouchedBuckets) {
      const projectBucket = getProjectBucket(
        projectState,
        projectKey,
        source,
        bucketStart,
        projectRef,
      );
      addTotals(projectBucket.totals, delta);
      projectTouchedBuckets.add(projectBucketKey(projectKey, source, bucketStart));
    }
    eventsAggregated += 1;
    // Snapshot the pre-planner context first. The planner's own content+tool_calls
    // (eventContextTokens, added below) become part of the next turn's history,
    // so they MUST be billed as input on the next planner — don't fold them into
    // previousContextTokens or that history vanishes from the totals.
    previousContextTokens = contextTokens;
    contextTokens += eventContextTokens;
    lastCompletedLine = i + 1;
  }

  return {
    lastLine: lastCompletedLine,
    eventsAggregated,
    contextTokens,
    previousContextTokens,
    currentModel,
  };
}

async function readAntigravityDefaultModel(filePath) {
  try {
    // filePath: …/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl
    // Go up 5 levels to reach the variant root (e.g. …/antigravity-cli/)
    let dir = filePath;
    for (let i = 0; i < 5; i++) dir = path.dirname(dir);
    const raw = await fs.readFile(path.join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    if (settings.model && typeof settings.model === "string") {
      return normalizeAntigravityTranscriptModel(settings.model);
    }
  } catch (_) {
  }
  return null;
}

function parseAntigravityModelSelection(content) {
  if (typeof content !== "string" || !content) return null;
  const match = content.match(
    /changed setting `Model Selection` from .*? to ([^`\n]+?)(?:\s*\([^)]*\))?\.(?:\s+|$)/i,
  );
  if (!match) return null;
  return normalizeAntigravityTranscriptModel(match[1]);
}

function normalizeAntigravityTranscriptModel(modelName) {
  if (!modelName || typeof modelName !== "string") return null;
  let slug = modelName
    .trim()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(thinking|xhigh|high|medium|low|fast)\b/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug) return null;

  for (const marker of ["gemini", "claude", "gpt"]) {
    const idx = slug.indexOf(marker);
    if (idx >= 0) {
      slug = slug.slice(idx);
      break;
    }
  }
  if (/^(gemini|claude|gpt)-/.test(slug)) return slug;
  return `antigravity-${slug}`;
}

function antigravityContextTokens(event) {
  if (!event || typeof event !== "object") return 0;
  let tokens = antigravityValueTokens(event.content);
  if (event.type === "PLANNER_RESPONSE" && event.tool_calls) {
    tokens += antigravityValueTokens(event.tool_calls);
  }
  return tokens;
}

function antigravityValueTokens(value) {
  if (typeof value === "string") return estimateAntigravityTokens(value);
  if (value == null) return 0;
  try {
    return estimateAntigravityTokens(JSON.stringify(value));
  } catch (_e) {
    return 0;
  }
}

function estimateAntigravityTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0))) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

function isCjkCodePoint(code) {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x30ff)
  );
}

// ── Trae SOLO (ByteDance AI IDE) ─────────────────────────────────────────────
// https://www.trae.ai
//
// Trae SOLO is scoped to detection (init) + entitlement display (status):
//   - init: resolveTraeStoragePath() proves an install exists.
//   - status: readTraeEntitlementFromStorage() serves the plan/limits snapshot.
// Trae SOLO does NOT expose per-request token usage in a readable local format
// (session transcripts are SQLCipher-encrypted; memory summaries carry no
// token counts), so the token-count-only queue is intentionally never written
// for this provider — the cloud hourly table stays clean.
function resolveTraePath(env = process.env) {
  const override = env.TOKENTRACKER_TRAE_HOME;
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  const home = require("node:os").homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "TRAE SOLO");
  }
  if (process.platform === "win32") {
    // A Windows box with no APPDATA still keeps Trae under the standard
    // roaming profile — falling through to the dot-dir below would point at
    // a location Trae never writes.
    const appData = typeof env.APPDATA === "string" ? env.APPDATA.trim() : "";
    return appData
      ? path.join(appData, "TRAE SOLO")
      : path.join(home, "AppData", "Roaming", "TRAE SOLO");
  }
  // Linux and friends: TRAE SOLO ships official builds for macOS/Windows
  // only, so there is no verified app-data layout to default to. Fall back to
  // a deterministic home-dir path (best-effort detection);
  // TOKENTRACKER_TRAE_HOME always wins for unusual installs.
  return path.join(home, ".trae-solo");
}

function resolveTraeStoragePath(env = process.env) {
  const traHome = resolveTraePath(env);
  if (!traHome) return null;
  const p = path.join(traHome, "User", "globalStorage", "storage.json");
  return fssync.existsSync(p) ? p : null;
}

/**
 * Extract the Trae SOLO entitlement snapshot from parsed storage.json
 * serverData (the value under iCubeServerData://icube.cloudide).
 * Returns a normalized entitlement object, or null when the serverData
 * carries no valid entitlementInfo. Shared by the status read path
 * (readTraeEntitlementFromStorage).
 */
function normalizeTraeEntitlement(serverData) {
  let ent;
  try {
    ent = typeof serverData === "string" ? JSON.parse(serverData) : serverData;
  } catch {
    return null;
  }
  // The parsed serverData may legitimately be JSON `null` (e.g. the string
  // "null") or another non-object — treat it as no valid snapshot.
  if (!ent || typeof ent !== "object" || Array.isArray(ent)) return null;
  const entitlementInfo = ent.entitlementInfo;
  if (!entitlementInfo || typeof entitlementInfo !== "object") return null;
  const detail = entitlementInfo.detail || {};
  return {
    identity: entitlementInfo.identityStr,
    identity_code: entitlementInfo.identity,
    has_package: entitlementInfo.hasPackage,
    is_dollar_billing: entitlementInfo.isDollarUsageBilling,
    pro_period: entitlementInfo.proPeriod,
    enable_solo_builder: entitlementInfo.enableSoloBuilder,
    enable_solo_coder: entitlementInfo.enableSoloCoder,
    fast_request_per: detail.fastRequestPer,
    in_waitlist: detail.inWaitlist,
  };
}

/**
 * Read the current Trae SOLO entitlement snapshot straight from the Trae
 * Local State storage.json, without touching the token-count-only queue
 * (CLAUDE.md privacy contract). Returns a normalized entitlement object
 * with a captured_at timestamp, or null when storage.json is missing,
 * unparseable, or carries no valid entitlement snapshot.
 */
function readTraeEntitlementFromStorage(storagePath) {
  if (!storagePath) return null;
  let fd;
  try {
    fd = fssync.openSync(storagePath, "r");
  } catch {
    return null;
  }
  let stat = null;
  let raw;
  try {
    stat = fssync.fstatSync(fd);
    raw = fssync.readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    try {
      fssync.closeSync(fd);
    } catch {
      // fd already closed; nothing to do.
    }
  }
  let storage;
  try {
    storage = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
    return null;
  }
  const serverKey = "iCubeServerData://icube.cloudide";
  const serverData = storage[serverKey];
  if (!serverData) return null;
  const entitlement = normalizeTraeEntitlement(serverData);
  if (!entitlement) return null;
  return {
    ...entitlement,
    captured_at: stat ? new Date(stat.mtimeMs).toISOString() : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trae Work CN (国内版) — usage API incremental parser.
//
// TRAE Work CN's usage API reports per-session rows that are NOT append-only:
// a session can be re-reported with corrected token totals, a different model,
// or a shifted time bucket. This parser keeps the last normalized contribution
// per session_id under `cursors.traeCn` and reconciles by subtracting the
// previous contribution from its old bucket before adding the new one, so
// corrections retract the stale tuple instead of stacking. Only the normalized
// contribution is persisted — no raw API rows, cost/credits, auth, refresh
// tokens, or prompt previews. Source is always `trae-cn`.
const TRAE_CN_SOURCE = "trae-cn";
const TRAE_CN_STATE_VERSION = 1;
const TRAE_CN_UNKNOWN_MODEL = "trae-cn-unknown";

function normalizeTraeCnState(raw) {
  if (raw === undefined || raw === null) {
    return {
      version: TRAE_CN_STATE_VERSION,
      sessions: {},
      prunedBeforeMs: 0,
      updatedAt: null,
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Trae CN cursor state is malformed.");
  }
  if (raw.version !== TRAE_CN_STATE_VERSION) {
    throw new Error(`Trae CN cursor state version ${raw.version} is not supported.`);
  }
  if (!raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions)) {
    throw new Error("Trae CN cursor sessions are malformed.");
  }
  return {
    version: TRAE_CN_STATE_VERSION,
    sessions: { ...raw.sessions },
    prunedBeforeMs:
      Number.isFinite(raw.prunedBeforeMs) && raw.prunedBeforeMs > 0 ? raw.prunedBeforeMs : 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

function isValidTraeCnTotals(totals) {
  if (!totals || typeof totals !== "object") return false;
  for (const key of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "billable_total_tokens",
    "conversation_count",
  ]) {
    if (!Number.isSafeInteger(totals[key]) || totals[key] < 0) return false;
  }
  return true;
}

// Canonical UTC half-hour bucketStart produced by toUtcHalfHourStart:
// "YYYY-MM-DDTHH:00:00.000Z" or "YYYY-MM-DDTHH:30:00.000Z".
function isValidTraeCnBucketStart(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:(00|30):00\.000Z$/.test(value)) return false;
  const dt = new Date(value);
  return Number.isFinite(dt.getTime()) && dt.toISOString() === value;
}

// Validate a stored prior contribution before it is ever subtracted, so a
// tampered or corrupt cursor fails closed instead of silently rewinding buckets.
// Enforces this provider's fixed canonical invariant (all totals safe
// nonnegative integers, reasoning=0, conversation_count=1,
// total=input+cached+cacheCreation+output, billable=total) plus a canonical
// half-hour UTC bucketStart.
function validateTraeCnStoredContribution(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("Trae CN stored session contribution is malformed.");
  }
  if (
    typeof entry.model !== "string" ||
    !entry.model.trim() ||
    entry.model.includes("|")
  ) {
    throw new Error("Trae CN stored session model is malformed.");
  }
  if (!isValidTraeCnBucketStart(entry.bucketStart)) {
    throw new Error("Trae CN stored session bucket is malformed.");
  }
  if (!isValidTraeCnTotals(entry.totals)) {
    throw new Error("Trae CN stored session totals are malformed.");
  }
  const { totals } = entry;
  if (totals.reasoning_output_tokens !== 0 || totals.conversation_count !== 1) {
    throw new Error("Trae CN stored session totals are malformed.");
  }
  const sum =
    totals.input_tokens +
    totals.cached_input_tokens +
    totals.cache_creation_input_tokens +
    totals.output_tokens;
  if (totals.total_tokens !== sum || totals.billable_total_tokens !== totals.total_tokens) {
    throw new Error("Trae CN stored session totals are malformed.");
  }
}

// Token fields may live in `row.extra_info` (object or JSON string) or at the
// top level of the row. Missing values are NOT coerced to zero.
function traeCnExtraInfo(row) {
  const extra = row?.extra_info;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) return extra;
  if (typeof extra === "string") {
    try {
      const parsed = JSON.parse(extra);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_e) {}
  }
  return null;
}

function traeCnTokenField(row, extra, key) {
  if (extra && extra[key] !== undefined && extra[key] !== null) return extra[key];
  if (row && row[key] !== undefined && row[key] !== null) return row[key];
  return undefined;
}

// Normalize one raw session row into the canonical contribution, or throw
// before any cursor/bucket mutation happens. Returns
// { sessionId, model, bucketStart, totals }.
function normalizeTraeCnSession(row) {
  const sessionId = typeof row?.session_id === "string" ? row.session_id.trim() : "";
  if (!sessionId) {
    throw new Error("Trae CN session row is missing session_id.");
  }
  let model;
  if (row?.model_name === undefined || row?.model_name === null) {
    model = TRAE_CN_UNKNOWN_MODEL;
  } else if (typeof row.model_name === "string") {
    model = row.model_name.trim() || TRAE_CN_UNKNOWN_MODEL;
  } else {
    throw new Error("Trae CN session row has an invalid model_name.");
  }
  if (model.includes("|")) {
    throw new Error("Trae CN session row has an unsupported model name.");
  }
  if (!Number.isSafeInteger(row?.usage_time) || row.usage_time <= 0) {
    throw new Error("Trae CN session row has an invalid usage_time.");
  }
  const bucketStart = toUtcHalfHourStart(row.usage_time * 1000);
  if (!bucketStart) {
    throw new Error("Trae CN session row has an invalid usage_time.");
  }
  const extra = traeCnExtraInfo(row);
  // Cache fields may be absent for models without a prompt-cache concept
  // (Doubao / DeepSeek on TRAE CN) — an absent cache field means "no cache
  // activity", i.e. 0, NOT a malformed row. input/output stay mandatory.
  //
  // `input_token` is cache-INCLUSIVE: verifying real rows against TRAE CN's
  // own credit billing, credits = fresh_input*p + cache_read*(p/4) + output*q
  // fits every row with zero residual only under this reading (same
  // convention as Codex / Qoder). Peel the cache subsets off into their own
  // columns and report only the remainder as ordinary input, otherwise cached
  // context is double-counted in dashboards and cost calculations. cache_write
  // was 0 across all observed rows; it is treated as a further subset of the
  // cache-inclusive input (clamped so the buckets always sum back to it).
  const cacheRead = traeCnTokenField(row, extra, "cache_read_token");
  const cacheWrite = traeCnTokenField(row, extra, "cache_write_token");
  const fields = [
    ["input_token", traeCnTokenField(row, extra, "input_token")],
    ["output_token", traeCnTokenField(row, extra, "output_token")],
    ["cache_read_token", cacheRead === undefined || cacheRead === null ? 0 : cacheRead],
    ["cache_write_token", cacheWrite === undefined || cacheWrite === null ? 0 : cacheWrite],
  ];
  for (const [label, value] of fields) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Trae CN session row has an invalid ${label}.`);
    }
  }
  const rawInput = fields[0][1];
  const outputTokens = fields[1][1];
  const cachedInput = Math.min(rawInput, fields[2][1]);
  const cacheCreation = Math.min(rawInput - cachedInput, fields[3][1]);
  const total = rawInput + outputTokens;
  if (!Number.isSafeInteger(total)) {
    throw new Error("Trae CN session row token totals overflow.");
  }
  return {
    sessionId,
    model,
    bucketStart,
    totals: {
      input_tokens: rawInput - cachedInput - cacheCreation,
      output_tokens: outputTokens,
      cached_input_tokens: cachedInput,
      cache_creation_input_tokens: cacheCreation,
      reasoning_output_tokens: 0,
      total_tokens: total,
      billable_total_tokens: total,
      conversation_count: 1,
    },
  };
}

// Fail closed instead of letting subtractTotals clamp a stored prior
// contribution that exceeds its source bucket (a corruption signal).
function assertTraeCnBucketCovers(bucketTotals, previousTotals) {
  for (const key of [
    "input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "billable_total_tokens",
    "conversation_count",
  ]) {
    if ((bucketTotals[key] || 0) < (previousTotals[key] || 0)) {
      throw new Error("Trae CN state corruption: stored contribution exceeds its bucket totals.");
    }
  }
}

// Account session state: a queue record (kind: "account_session_state")
// carrying the CANONICAL observation of ONE provider-side TRAE CN session.
// Cloud truth for trae-cn lives at the session level
// (tokentracker_account_session_states; ingest edge upserts via
// tokentracker_upsert_account_session_states): identity is
// (user_id, source, session_id) - device_id is NOT identity (the usage API
// request carries no device discriminator). Evidence split (2026-08-17, one
// account, three real fetches 137 -> 141 -> 164): repeated-fetch id
// stability VERIFIED (137/137 persisted, corrections KEPT ids), cross-window
// stability VERIFIED (exact subsets), no duplicate ids OBSERVED. Cross-device
// same-account id stability is NOT DIRECTLY VERIFIED - no device
// discriminator in the request body is necessary but not sufficient (a
// device/login context could ride inside the JWT / server auth context), and
// no second independent device/auth experiment was run.
//
// The three correction classes collapse into ONE whole-row replace:
//   downward  S tokens 100 -> 60
//   model     S model A -> B
//   bucket    S bucket 10:00 -> 10:30
// A fresh device with no cursor history uploads every session it observes;
// the cloud LWW guard reconciles versions. ABSENCE is NOT PROVEN to mean
// deletion, so nothing is ever emitted for sessions missing from a
// non-empty snapshot, and an empty payload emits nothing at all.
//
// snapshot_verified_at is the CLIENT logical fetch stamp (the API exposes no
// provider-side ordering signal - headers carry only CDN trace ids, rows
// carry no revision). It is stamped once per real fetch and replayed
// verbatim by this append-only queue; the cloud upsert applies strictly
// newer (>) stamps only, so replays are idempotent and a transport retry of
// an older observation cannot displace a newer one. Cross-device ordering
// under clock skew is a documented residual risk, NOT strict correctness.
//
// Appended AFTER the bucket rows of the same sync (queue order guarantees a
// device's rows land before the states describing them). Bucket-row readers
// skip this record via its kind field (it carries no hour_start and is not
// a usage row).
async function appendTraeCnSessionStates({ queuePath, observations, verifiedAtMs }) {
  if (!Array.isArray(observations) || observations.length === 0) return 0;
  if (!Number.isFinite(verifiedAtMs)) {
    throw new Error("Trae CN session states require a finite verification stamp.");
  }
  const verifiedAt = new Date(verifiedAtMs).toISOString();
  const lines = [];
  for (const obs of observations) {
    const t = obs.totals;
    lines.push(
      JSON.stringify({
        kind: "account_session_state",
        source: TRAE_CN_SOURCE,
        session_id: obs.sessionId,
        model: obs.model,
        bucket_start: obs.bucketStart,
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        cached_input_tokens: t.cached_input_tokens,
        cache_creation_input_tokens: t.cache_creation_input_tokens,
        reasoning_output_tokens: t.reasoning_output_tokens,
        total_tokens: t.total_tokens,
        snapshot_verified_at: verifiedAt,
      }),
    );
  }
  await fs.appendFile(queuePath, lines.join("\n") + "\n", "utf8");
  return lines.length;
}

async function parseTraeCnApiIncremental({
  sessions,
  cursors,
  queuePath,
  onProgress,
  windowStartMs,
  windowEndMs,
  snapshotVerifiedAtMs,
} = {}) {
  if (!Array.isArray(sessions)) {
    throw new Error("Trae CN sessions must be an array.");
  }
  if (!cursors || typeof cursors !== "object" || Array.isArray(cursors)) {
    throw new Error("Trae CN cursors must be a writable object.");
  }
  await ensureDir(path.dirname(queuePath));

  // Validate persisted state up front (fresh absent state initializes version
  // 1; malformed state / unexpected version fails closed instead of resetting).
  // Deep-clone the normalized working states so reconciliation and enqueue
  // mutations never touch `cursors` before the final assignment succeeds.
  const hourlyState = structuredClone(normalizeHourlyState(cursors?.hourly));
  const traeCnState = structuredClone(normalizeTraeCnState(cursors?.traeCn));

  if (sessions.length === 0) {
    // Empty payload is a successful no-op: no usage mutation, no session
    // state records.
    //
    // Evidence check (2026-08-16, two real fetches 17min apart over the same
    // account: 137 -> 141 sessions, 0 disappeared, 0 rows changed) shows the
    // session set is stable, but NOTHING proves 'absent from the response'
    // means 'authoritatively deleted / zero' — so the absence contract is
    // NOT PROVEN and must stay symmetric everywhere: a session missing from
    // a non-empty snapshot never emits a retraction, and an empty response
    // asserts nothing at all. Canonical corrections ride on explicit
    // observations only.
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  // Full prevalidation + in-payload dedupe BEFORE any cursor/bucket mutation.
  //
  // ANY malformed row fails the whole snapshot closed. Canonical session
  // states assert this device actually understood the snapshot, so a
  // partially understood snapshot (99 valid + 1 uninterpretable row) must
  // never be enqueued: it would become the canonical cloud state. The
  // provider-level try/catch in cmdSync keeps the failure
  // isolated (other providers sync on) and the error message carries only
  // the count + reason - no session ids, tokens, or credentials. Confirmed
  // LEGAL variations must not land here: absent cache fields are already
  // coerced to 0 inside normalizeTraeCnSession (models without a prompt
  // cache concept); only truly uninterpretable rows (bad session_id /
  // usage_time / token numbers / model, impossible schema) throw.
  const bySession = new Map();
  let skippedRows = 0;
  let firstSkipReason = "";
  for (const row of sessions) {
    let normalized;
    try {
      normalized = normalizeTraeCnSession(row);
    } catch (error) {
      skippedRows += 1;
      if (!firstSkipReason) firstSkipReason = error?.message || "unknown";
      continue;
    }
    const existing = bySession.get(normalized.sessionId);
    if (existing) {
      const identical =
        existing.model === normalized.model &&
        existing.bucketStart === normalized.bucketStart &&
        totalsKey(existing.totals) === totalsKey(normalized.totals);
      if (!identical) {
        throw new Error("Trae CN session rows contain conflicting contributions.");
      }
      continue; // exact duplicate within one payload is accepted once
    }
    bySession.set(normalized.sessionId, normalized);
  }
  if (skippedRows > 0) {
    // Partial snapshots are not authoritative: one uninterpretable row means
    // the window was NOT fully verified, so fail closed - no bucket rows, no
    // session states, no cursor commit. The next sync replays from the same
    // cursor state (idempotent).
    throw new Error(
      `Trae CN snapshot is not authoritative: ${skippedRows} malformed row${skippedRows !== 1 ? "s" : ""} (first: ${firstSkipReason}).`,
    );
  }
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;
  const total = sessions.length;
  let index = 0;
  let eventsAggregated = 0;

  // Validate EVERY existing stored contribution up front — not just sessions
  // present in the incoming payload — so an unrelated malformed entry fails
  // closed before any reconciliation mutation.
  for (const sessionId of Object.keys(traeCnState.sessions)) {
    validateTraeCnStoredContribution(traeCnState.sessions[sessionId]);
  }

  // Monotonic prune (same watermark pattern as the kiroCli cap above): the
  // sync caller fetches a fixed trailing window, so a session whose entire
  // half-hour bucket sits before windowStartMs can never reappear in a later
  // payload — its stored contribution is dead reconciliation weight. Prune
  // only when the window start moved FORWARD past the persisted watermark:
  // an entry evicted under window W1 and re-fetched under an earlier window
  // would find previousEntry undefined and count twice. The +30min margin
  // matches bucketStart's half-hour floor, which can trail the row's
  // usage_time by up to 30 minutes.
  if (Number.isFinite(windowStartMs) && windowStartMs > traeCnState.prunedBeforeMs) {
    const pruneCutoffMs = windowStartMs - 30 * 60 * 1000;
    for (const sessionId of Object.keys(traeCnState.sessions)) {
      const bucketMs = Date.parse(traeCnState.sessions[sessionId].bucketStart);
      if (Number.isFinite(bucketMs) && bucketMs <= pruneCutoffMs) {
        delete traeCnState.sessions[sessionId];
      }
    }
    traeCnState.prunedBeforeMs = windowStartMs;
  }

  // Deterministic: process unique session ids in sorted order. Sessions
  // whose canonical observation changed (or that were never seen) are also
  // collected for the account_session_state queue records.
  const sessionIds = [...bySession.keys()].sort();
  const changedObservations = [];
  for (const sessionId of sessionIds) {
    const current = bySession.get(sessionId);
    const previousEntry = traeCnState.sessions[sessionId];

    const unchanged =
      previousEntry &&
      totalsKey(previousEntry.totals) === totalsKey(current.totals) &&
      previousEntry.bucketStart === current.bucketStart &&
      previousEntry.model === current.model;
    if (unchanged) {
      index += 1;
      if (cb) cb({ index, total, eventsAggregated, bucketsQueued: touchedBuckets.size });
      continue;
    }

    if (previousEntry) {
      const oldBucket = getHourlyBucket(
        hourlyState,
        TRAE_CN_SOURCE,
        previousEntry.model,
        previousEntry.bucketStart,
      );
      assertTraeCnBucketCovers(oldBucket.totals, previousEntry.totals);
      subtractTotals(oldBucket.totals, previousEntry.totals);
      touchedBuckets.add(bucketKey(TRAE_CN_SOURCE, previousEntry.model, previousEntry.bucketStart));
    }

    const bucket = getHourlyBucket(hourlyState, TRAE_CN_SOURCE, current.model, current.bucketStart);
    addTotals(bucket.totals, current.totals);
    touchedBuckets.add(bucketKey(TRAE_CN_SOURCE, current.model, current.bucketStart));

    traeCnState.sessions[sessionId] = {
      model: current.model,
      bucketStart: current.bucketStart,
      totals: { ...current.totals },
      updatedAt: new Date().toISOString(),
    };
    changedObservations.push({
      sessionId,
      model: current.model,
      bucketStart: current.bucketStart,
      totals: current.totals,
    });
    eventsAggregated += 1;
    index += 1;
    if (cb) cb({ index, total, eventsAggregated, bucketsQueued: touchedBuckets.size });
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  // Emit canonical session observations only after the reconciled bucket
  // rows are durably queued; a failure here aborts before cursor commit, so
  // the next sync replays the (idempotent) reconciliation and re-appends
  // both. snapshot_verified_at is stamped once per real fetch; the
  // append-only queue replays it verbatim, so transport retries never fake
  // freshness. Unchanged sessions emit nothing - a fixed-now no-change sync
  // stays byte-identical.
  const verifiedAtMs = Number.isFinite(snapshotVerifiedAtMs) ? snapshotVerifiedAtMs : Date.now();
  await appendTraeCnSessionStates({
    queuePath,
    observations: changedObservations,
    verifiedAtMs,
  });
  const updatedAt = new Date().toISOString();
  hourlyState.updatedAt = updatedAt;
  traeCnState.updatedAt = updatedAt;
  // Assign cursor state only after enqueue succeeds.
  cursors.hourly = hourlyState;
  cursors.traeCn = traeCnState;

  return { recordsProcessed: total, eventsAggregated, bucketsQueued, skippedRows };
}

// ─────────────────────────────────────────────────────────────────────────────
// DeepSeek Harness (dsh) — passive reader of the harness's session logs.
//
// The DeepSeek Harness SDK persists each agent session as an append-only JSONL
// log under `<harness-home>/sessions/<project-key>/<session-id>/session.jsonl[.zstd]`
// (default `~/.dsh/sessions`; `$DSH_HOME` / TOKENTRACKER_DSH_HOME override). The first line is a `type: "session"` header;
// every following line is a `SessionEvent` carrying `type`, `seq`, `time`
// (epoch ms), and `data`. Token accounting rides on `assistant/message` events
// (`data.usage`), and the model on the same event's `data.message.source.model`
// (falling back to the most recent `request/header` config). Usage counts are
// DISJOINT — `inputTokens` is uncached input only, cache reads/writes and
// reasoning travel separately — so the mapping to our queue columns is direct
// (no cache subtraction, unlike Codex).
//
// Zstd artifacts are a concatenated-frame container: a single decompress call
// decodes only the first frame (silently dropping every event line), so we
// identify the frame boundaries and decode each frame independently —
// built-in zlib zstd first, `@mongodb-js/zstd` as the Node 20 fallback —
// enforcing a cumulative plaintext bound as we go.
// Dedup is a per-file `lastSeq` watermark — seq
// is monotonic within a session log, so an append-only grow re-reads the file
// and skips everything at or below the watermark; a torn-tail repair or full
// rewrite re-reads the same seqs and is therefore idempotent.
const DSH_SESSION_LOG_MAX_BYTES = 64 * 1024 * 1024;
const DSH_SESSION_TEXT_MAX_BYTES = 128 * 1024 * 1024;
const DSH_SOURCE = "dsh";

// Precedence mirrors the harness's own resolveDshHome: an explicit
// TokenTracker override, then the harness's $DSH_HOME, then `~/.dsh`. Tests
// isolate $DSH_HOME via the `withHome` helper, so honoring it here cannot leak
// the real home past test isolation.
function resolveDshHome(env = process.env) {
  const explicit =
    (typeof env?.TOKENTRACKER_DSH_HOME === "string" && env.TOKENTRACKER_DSH_HOME.trim()) ||
    (typeof env?.DSH_HOME === "string" && env.DSH_HOME.trim()) ||
    "";
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".dsh");
}

// Windows users commonly run Harness inside WSL while TokenTracker itself runs
// natively. Respect the repository-wide WSL mode contract and keep explicit
// DSH home overrides authoritative: an override is a complete user choice, not
// one half of an automatic native/WSL discovery pair.
function resolveDshHomes(env = process.env, deps = {}) {
  const overridden = Boolean(
    (typeof env?.TOKENTRACKER_DSH_HOME === "string" && env.TOKENTRACKER_DSH_HOME.trim()) ||
    (typeof env?.DSH_HOME === "string" && env.DSH_HOME.trim()),
  );
  const nativeHome = deps.nativeHome || resolveDshHome(env);
  const platform = deps.platform || process.platform;
  if (overridden || platform !== "win32") return [nativeHome];

  const existsSync = deps.existsSync || fssync.existsSync;
  let nativeValue = null;
  try {
    if (existsSync(nativeHome)) nativeValue = nativeHome;
  } catch (_error) {}

  const discoverWslHome = deps.discoverWslHome || wsl.discoverWslHome;
  const wslValue = wsl.shouldProbeWsl(env)
    ? discoverWslHome(".dsh", { ...deps, env })
    : null;
  const resolved = wsl.resolveAllWin32Paths({
    nativeValue,
    wslValue,
    env,
    platform,
  });
  return [...new Set([resolved.native, resolved.wsl].filter(Boolean))];
}

function isDshSessionLogName(name) {
  return name === "session.jsonl" || name === "session.jsonl.zstd";
}

// Walk the harness sessions root for per-session log artifacts. The tree is
// `<sessions-root>/<project-key>/<session-id>/session.jsonl[.zstd]`; only the
// exact leaf names are collected so unrelated harness files are ignored.
async function resolveDshSessionFiles(env = process.env, deps = {}) {
  const out = [];
  const seen = new Set();
  for (const dshHome of resolveDshHomes(env, deps)) {
    const sessionsRoot = path.join(dshHome, "sessions");
    const projects = await safeReadDir(sessionsRoot);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(sessionsRoot, project.name);
      const sessions = await safeReadDir(projectDir);
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const sessionDir = path.join(projectDir, session.name);
        const artifacts = await safeReadDir(sessionDir);
        const transcripts = artifacts.filter(
          (artifact) => artifact.isFile() && isDshSessionLogName(artifact.name),
        );
        let selected = null;
        if (transcripts.length === 1) {
          selected = path.join(sessionDir, transcripts[0].name);
        } else if (transcripts.length > 1) {
          // Harness itself rejects mixed encodings in one root. For a passive
          // reader, choose the actively-written artifact instead of counting the
          // same session twice; a tie prefers the default zstd encoding.
          const ranked = await Promise.all(transcripts.map(async (artifact) => {
            const full = path.join(sessionDir, artifact.name);
            const handle = await fs.open(full, "r").catch(() => null);
            if (!handle) return { full, name: artifact.name, mtimeMs: 0 };
            try {
              const stat = await handle.stat().catch(() => null);
              return {
                full,
                name: artifact.name,
                mtimeMs: stat?.isFile() ? Number(stat.mtimeMs || 0) : 0,
              };
            } finally {
              await handle.close().catch(() => {});
            }
          }));
          ranked.sort((left, right) =>
            right.mtimeMs - left.mtimeMs ||
            Number(right.name.endsWith(".zstd")) - Number(left.name.endsWith(".zstd")),
          );
          selected = ranked[0]?.full || null;
        }
        if (selected && !seen.has(selected)) {
          seen.add(selected);
          out.push(selected);
        }
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

// Inspect concatenated Zstandard frames without decompressing them. Harness
// writes a content size into every independent append frame; summing those
// declarations lets us reject a decompression bomb before the native decoder
// allocates its plaintext buffer.
function inspectDshZstdFrames(data, maxOutputBytes = DSH_SESSION_TEXT_MAX_BYTES) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const limit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 0
    ? maxOutputBytes
    : DSH_SESSION_TEXT_MAX_BYTES;
  let offset = 0;
  let totalContentBytes = 0;
  let allContentSizesDeclared = true;
  let frames = 0;
  const frameRanges = [];

  const need = (count, label) => {
    if (offset + count > input.length) throw new Error(`Invalid DeepSeek Harness zstd ${label}`);
  };
  const readUnsignedLE = (count) => {
    need(count, "frame header");
    let value = 0n;
    for (let i = 0; i < count; i++) value |= BigInt(input[offset + i]) << BigInt(i * 8);
    offset += count;
    return value;
  };

  while (offset < input.length) {
    const frameStart = offset;
    need(4, "magic");
    const magic = input.readUInt32LE(offset);
    offset += 4;

    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      need(4, "skippable frame size");
      const skipBytes = input.readUInt32LE(offset);
      offset += 4;
      need(skipBytes, "skippable frame payload");
      offset += skipBytes;
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error("Invalid DeepSeek Harness zstd frame magic");

    need(1, "descriptor");
    const descriptor = input[offset++];
    if ((descriptor & 0x08) !== 0) throw new Error("Invalid DeepSeek Harness zstd reserved frame bit");
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryIdBytes = [0, 1, 2, 4][descriptor & 0x03];
    let windowSize = null;
    if (!singleSegment) {
      need(1, "window descriptor");
      const windowDescriptor = input[offset++];
      const windowBase = 2 ** (10 + (windowDescriptor >>> 3));
      windowSize = windowBase + (windowBase / 8) * (windowDescriptor & 0x07);
    }
    need(dictionaryIdBytes, "dictionary id");
    offset += dictionaryIdBytes;

    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : [0, 2, 4, 8][contentSizeFlag];
    let declaredContentBytes = null;
    if (contentSizeBytes > 0) {
      declaredContentBytes = readUnsignedLE(contentSizeBytes);
      if (contentSizeBytes === 2) declaredContentBytes += 256n;
      if (declaredContentBytes > BigInt(limit)) {
        throw new Error(`DeepSeek Harness decompressed session log exceeds ${limit} bytes`);
      }
      if (singleSegment) windowSize = Number(declaredContentBytes);
    } else {
      allContentSizesDeclared = false;
    }

    let lastBlock = false;
    let frameUpperBound = 0;
    while (!lastBlock) {
      need(3, "block header");
      const blockHeader = input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16);
      offset += 3;
      lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("Invalid DeepSeek Harness zstd reserved block type");
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      need(payloadBytes, "block payload");
      offset += payloadBytes;
      // A raw block emits blockSize bytes; an RLE block expands to blockSize
      // repeated bytes; a compressed block cannot emit more than the frame's
      // window or Zstandard's 128 KiB maximum block size. This gives frames
      // without FCS a safe allocation bound before native decompression.
      frameUpperBound += blockType === 2
        ? Math.min(Number(windowSize) || 128 * 1024, 128 * 1024)
        : blockSize;
      if (declaredContentBytes == null && frameUpperBound > limit) {
        throw new Error(`DeepSeek Harness decompressed session log exceeds ${limit} bytes`);
      }
    }
    if (hasChecksum) {
      need(4, "checksum");
      offset += 4;
    }
    const boundedFrameBytes = declaredContentBytes == null
      ? frameUpperBound
      : Number(declaredContentBytes);
    totalContentBytes += boundedFrameBytes;
    if (allContentSizesDeclared && totalContentBytes > limit) {
      throw new Error(`DeepSeek Harness decompressed session log exceeds ${limit} bytes`);
    }
    frameRanges.push({ start: frameStart, end: offset, maxContentBytes: boundedFrameBytes });
    frames += 1;
  }

  if (frames === 0) throw new Error("DeepSeek Harness zstd log contains no data frames");
  return {
    frames,
    totalContentBytes: allContentSizesDeclared ? totalContentBytes : null,
    maxTotalContentBytes: totalContentBytes,
    frameRanges,
  };
}

// Decode one already-isolated frame. Prefer Node's built-in zstd (22.15+):
// the desktop bundles install dependencies with --ignore-scripts, so
// @mongodb-js/zstd ships without its native binding there and the require()
// would throw — silently skipping every compressed session (issue #465). The
// MongoDB binding stays as the fallback for Node 20 CLI installs, where npm
// runs install scripts normally.
async function decodeDshZstdFrame(frameBytes) {
  const zlib = require("node:zlib");
  if (typeof zlib.zstdDecompressSync === "function") {
    return zlib.zstdDecompressSync(frameBytes);
  }
  return Buffer.from(await require("@mongodb-js/zstd").decompress(frameBytes));
}

// Decode one independent Harness append frame at a time; per-frame decoding
// lets us enforce the aggregate plaintext limit when the frame omits its
// content size.
async function decodeDshZstd(
  data,
  { maxOutputBytes = DSH_SESSION_TEXT_MAX_BYTES, inspected = null } = {},
) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const frameInfo = inspected || inspectDshZstdFrames(input, maxOutputBytes);
  const parts = [];
  let total = 0;
  for (const frame of frameInfo.frameRanges) {
    const decoded = await decodeDshZstdFrame(input.subarray(frame.start, frame.end));
    total += decoded.length;
    if (total > maxOutputBytes) {
      throw new Error(`DeepSeek Harness decompressed session log exceeds ${maxOutputBytes} bytes`);
    }
    parts.push(decoded);
  }
  return Buffer.concat(parts, total);
}

function dshSessionMetadata(stat) {
  return {
    inode: stat?.ino || 0,
    size: Number.isFinite(stat?.size) ? stat.size : 0,
    mtimeMs: Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : 0,
  };
}

function sameDshSessionMetadata(previous, current) {
  return Boolean(
    previous &&
    previous.inode === current.inode &&
    previous.size === current.size &&
    previous.mtimeMs === current.mtimeMs
  );
}

// Open, inspect and read through one handle so a path replacement cannot make
// the metadata describe a different file from the bytes we parse.
async function readDshSessionSnapshot(
  filePath,
  { maxOutputBytes = DSH_SESSION_TEXT_MAX_BYTES, previous = null } = {},
) {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return null;
  try {
    const initialStat = await handle.stat().catch(() => null);
    if (!initialStat || !initialStat.isFile()) return null;
    const initialMetadata = dshSessionMetadata(initialStat);
    if (initialMetadata.size > DSH_SESSION_LOG_MAX_BYTES) {
      throw new Error(`DeepSeek Harness session log exceeds ${DSH_SESSION_LOG_MAX_BYTES} bytes`);
    }
    if (sameDshSessionMetadata(previous, initialMetadata)) {
      return { ...initialMetadata, unchanged: true, text: null };
    }
    const outputLimit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 0
      ? maxOutputBytes
      : DSH_SESSION_TEXT_MAX_BYTES;
    const data = await handle.readFile();
    if (data.length > DSH_SESSION_LOG_MAX_BYTES) {
      throw new Error(`DeepSeek Harness session log exceeds ${DSH_SESSION_LOG_MAX_BYTES} bytes`);
    }
    let text;
    if (filePath.endsWith(".zstd")) {
      if (data.length === 0) text = "";
      else {
        const inspected = inspectDshZstdFrames(data, outputLimit);
        const decoded = await decodeDshZstd(data, { maxOutputBytes: outputLimit, inspected });
        if (
          decoded.length > outputLimit ||
          (inspected.totalContentBytes != null && decoded.length !== inspected.totalContentBytes)
        ) {
          throw new Error(`DeepSeek Harness decompressed session log exceeds ${outputLimit} bytes`);
        }
        text = decoded.toString("utf8");
      }
    } else {
      if (data.length > outputLimit) {
        throw new Error(`DeepSeek Harness decompressed session log exceeds ${outputLimit} bytes`);
      }
      text = data.toString("utf8");
    }

    const finalStat = await handle.stat().catch(() => initialStat);
    const metadata = dshSessionMetadata(finalStat);
    // If Harness appended while this handle was being read, force a retry on
    // the next sync unless the bytes consumed reached the final compressed/raw
    // file size. This avoids acknowledging a tail that was never parsed.
    if (metadata.size !== data.length) metadata.mtimeMs = -1;
    return { ...metadata, unchanged: false, text };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Read one session log to plaintext, decompressing zstd artifacts. Returns
// null for a missing/non-file path so callers treat it as a no-op.
async function readDshSessionText(filePath, options = {}) {
  const snapshot = await readDshSessionSnapshot(filePath, options);
  return snapshot?.text ?? null;
}

// Drop a provider-qualified model id prefix ("deepseek/deepseek-v4-pro" →
// "deepseek-v4-pro"). The harness emits a bare id today, but the source
// vocabulary is provider-qualified elsewhere; keep the mapping cheap.
function normalizeDshModelName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf("/");
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return name ? name : null;
}

// Convert a harness `TokenUsage` object into our queue `totals` delta. Counts
// are disjoint, so every column maps 1:1; returns null for an all-zero usage.
function dshUsageToTotals(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = toNonNegativeInt(usage.inputTokens);
  const output = toNonNegativeInt(usage.outputTokens);
  const cacheRead = toNonNegativeInt(usage.cacheReadTokens);
  const cacheWrite = toNonNegativeInt(usage.cacheWriteTokens);
  const reasoning = toNonNegativeInt(usage.reasoningTokens);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0) {
    return null;
  }
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output + cacheRead + cacheWrite + reasoning,
    conversation_count: 1,
  };
}

// Return one top-level JSON object property's raw value slice without parsing
// sibling values. In particular this lets the Harness reader skip message
// content byte-for-byte and materialize only routing metadata plus token
// counters. It is intentionally small and JSON-syntax aware (strings, escapes,
// nested arrays/objects), not a regex over potentially nested content.
function findDshJsonProperty(raw, wantedKey) {
  const text = String(raw || "");
  const skipWhitespace = (index) => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    return index;
  };
  const stringEnd = (start) => {
    if (text[start] !== '"') return -1;
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === "\\") {
        index += 1;
      } else if (text[index] === '"') {
        return index + 1;
      }
    }
    return -1;
  };
  const valueEnd = (start) => {
    const first = text[start];
    if (first === '"') return stringEnd(start);
    if (first === "{" || first === "[") {
      const stack = [first === "{" ? "}" : "]"];
      let inString = false;
      for (let index = start + 1; index < text.length; index++) {
        const char = text[index];
        if (inString) {
          if (char === "\\") index += 1;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
        } else if (char === "{") {
          stack.push("}");
        } else if (char === "[") {
          stack.push("]");
        } else if (char === stack.at(-1)) {
          stack.pop();
          if (stack.length === 0) return index + 1;
        }
      }
      return -1;
    }
    let index = start;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    return index > start ? index : -1;
  };

  let index = skipWhitespace(0);
  if (text[index] !== "{") return null;
  index += 1;
  while (index < text.length) {
    index = skipWhitespace(index);
    if (text[index] === "}") return null;
    const keyStart = index;
    const keyEnd = stringEnd(keyStart);
    if (keyEnd < 0) return null;
    let key;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      return null;
    }
    index = skipWhitespace(keyEnd);
    if (text[index] !== ":") return null;
    index = skipWhitespace(index + 1);
    const start = index;
    const end = valueEnd(start);
    if (end < 0) return null;
    if (key === wantedKey) return text.slice(start, end);
    index = skipWhitespace(end);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] === "}") return null;
    return null;
  }
  return null;
}

function parseDshJsonString(raw) {
  if (typeof raw !== "string" || raw[0] !== '"') return null;
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function parseDshJsonNumber(raw) {
  if (typeof raw !== "string") return NaN;
  const value = Number(raw);
  return Number.isFinite(value) ? value : NaN;
}

function parseDshUsageSlice(raw) {
  if (typeof raw !== "string") return null;
  return {
    inputTokens: parseDshJsonNumber(findDshJsonProperty(raw, "inputTokens")),
    outputTokens: parseDshJsonNumber(findDshJsonProperty(raw, "outputTokens")),
    cacheReadTokens: parseDshJsonNumber(findDshJsonProperty(raw, "cacheReadTokens")),
    cacheWriteTokens: parseDshJsonNumber(findDshJsonProperty(raw, "cacheWriteTokens")),
    reasoningTokens: parseDshJsonNumber(findDshJsonProperty(raw, "reasoningTokens")),
  };
}

// Parse one session log's plaintext into usage deltas, skipping events whose
// seq is at or below the watermark. Returns the deltas (each carrying the
// model and epoch-ms timestamp), the highest seq seen, and the session id.
function extractDshSessionUsage(text, lastSeq = -1) {
  const deltas = [];
  const watermark = Number.isFinite(lastSeq) ? lastSeq : -1;
  let maxSeq = watermark;
  let sessionId = null;
  let headerModel = null;

  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const eventType = parseDshJsonString(findDshJsonProperty(line, "type"));
    if (!eventType) continue;

    if (eventType === "session") {
      const id = parseDshJsonString(findDshJsonProperty(line, "id"));
      if (id) sessionId = id;
      continue;
    }

    const seq = parseDshJsonNumber(findDshJsonProperty(line, "seq"));
    const seqKnown = Number.isFinite(seq) && seq >= 0;
    if (seqKnown && seq > maxSeq) maxSeq = seq;

    const data = findDshJsonProperty(line, "data");
    if (!data) continue;

    if (eventType === "request/header") {
      const header = findDshJsonProperty(data, "header");
      const config = findDshJsonProperty(header, "config");
      const model = parseDshJsonString(findDshJsonProperty(config, "model"));
      const normalized = normalizeDshModelName(model);
      if (normalized) headerModel = normalized;
      continue;
    }

    if (eventType !== "assistant/message") continue;
    if (seqKnown && seq <= watermark) continue;

    const message = findDshJsonProperty(data, "message");
    const source = findDshJsonProperty(message, "source");
    const model = normalizeDshModelName(
      parseDshJsonString(findDshJsonProperty(source, "model")),
    ) || headerModel;
    const totals = dshUsageToTotals(
      parseDshUsageSlice(findDshJsonProperty(data, "usage")),
    );
    if (!model || !totals) continue;

    const timeMs = parseDshJsonNumber(findDshJsonProperty(line, "time"));
    if (!Number.isFinite(timeMs) || timeMs <= 0) continue;

    deltas.push({ model, timeMs, totals });
  }

  return { deltas, maxSeq, sessionId };
}

// Incremental parser entrypoint. Mirrors the other passive JSONL readers:
// identity-check each file (inode/size/mtime), re-read + re-parse only when it
// changed, dedup via the per-file seq watermark, accumulate into hourly
// buckets, then flush touched buckets to the queue.
async function parseDshIncremental({ sessionFiles, cursors, queuePath, onProgress }) {
  await ensureDir(path.dirname(queuePath));
  if (!cursors || typeof cursors !== "object") cursors = {};
  if (!cursors.dsh || typeof cursors.dsh !== "object") cursors.dsh = {};
  const dshState = cursors.dsh;
  const fileState =
    dshState.files && typeof dshState.files === "object" ? dshState.files : {};

  const hourlyState = normalizeHourlyState(cursors?.hourly);
  const touchedBuckets = new Set();
  const cb = typeof onProgress === "function" ? onProgress : null;

  const files = Array.isArray(sessionFiles) ? sessionFiles : [];
  const presentFiles = new Set(files.filter((filePath) => typeof filePath === "string"));
  const total = files.length;
  let recordsProcessed = 0;
  let eventsAggregated = 0;

  for (let idx = 0; idx < files.length; idx++) {
    const filePath = files[idx];
    const prev = fileState[filePath] || null;
    let snapshot;
    let parsed;
    try {
      snapshot = await readDshSessionSnapshot(filePath, { previous: prev });
      if (!snapshot || snapshot.unchanged) {
        if (cb) {
          cb({ index: idx + 1, total, recordsProcessed, eventsAggregated, bucketsQueued: touchedBuckets.size });
        }
        continue;
      }

      const lastSeq = Number.isFinite(prev?.lastSeq) ? prev.lastSeq : -1;
      parsed = extractDshSessionUsage(snapshot.text, lastSeq);
      if (prev && parsed.sessionId && parsed.sessionId !== prev.sessionId) {
        parsed = extractDshSessionUsage(snapshot.text, -1);
      }
    } catch (error) {
      if (process.env.TOKENTRACKER_DEBUG) {
        process.stderr.write(`[dsh] skipped ${filePath}: ${error?.message || error}\n`);
      }
      if (cb) {
        cb({ index: idx + 1, total, recordsProcessed, eventsAggregated, bucketsQueued: touchedBuckets.size });
      }
      continue;
    }

    for (const delta of parsed.deltas) {
      const bucketStart = toUtcHalfHourStart(delta.timeMs);
      if (!bucketStart) continue;
      const bucket = getHourlyBucket(hourlyState, DSH_SOURCE, delta.model, bucketStart);
      addTotals(bucket.totals, delta.totals);
      touchedBuckets.add(bucketKey(DSH_SOURCE, delta.model, bucketStart));
      eventsAggregated += 1;
    }

    fileState[filePath] = {
      inode: snapshot.inode,
      size: snapshot.size,
      mtimeMs: snapshot.mtimeMs,
      sessionId: parsed.sessionId || null,
      lastSeq: parsed.maxSeq,
      updatedAt: new Date().toISOString(),
    };
    recordsProcessed += 1;

    if (cb) {
      cb({ index: idx + 1, total, recordsProcessed, eventsAggregated, bucketsQueued: touchedBuckets.size });
    }
  }

  for (const filePath of Object.keys(fileState)) {
    if (!presentFiles.has(filePath)) delete fileState[filePath];
  }

  const bucketsQueued = await enqueueTouchedBuckets({ queuePath, hourlyState, touchedBuckets });
  hourlyState.updatedAt = new Date().toISOString();
  cursors.hourly = hourlyState;
  dshState.files = fileState;
  dshState.updatedAt = new Date().toISOString();

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}


module.exports = {
  listRolloutFiles,
  listRolloutFilesDeep,
  codexSessionIdFromPath,
  filterColdCodexRolloutFiles,
  listClaudeProjectFiles,
  listGeminiSessionFiles,
  listOpencodeMessageFiles,
  readOpencodeDbMessages,
  readMimoDbMessages,
  readZcodeDbMessages,
  resolveQoderDbPath,
  resolveQoderDbPaths,
  resolveQoderCnDbPaths,
  readQoderDbMessages,
  resolveKiroBasePath,
  resolveKiroDbPath,
  resolveKiroJsonlPath,
  resolveHermesPath,
  resolveHermesDbPath,
  parseWslListVerbose,
  probeWslDistros,
  discoverWslHermesHome,
  resolveCopilotOtelPaths,
  normalizeCopilotDbPath,
  uniqueCopilotDbPaths,
  coalesceCopilotDbStatesByIdentity,
  resolveCopilotSessionStorePaths,
  getCopilotSqliteFingerprint,
  describeCopilotSessionStoreDb,
  resolveCopilotAppDbPath,
  resolveCopilotAppDbPaths,
  readCopilotSessionStoreUsageRows,
  normalizeCopilotSessionStoreUsage,
  readCopilotAppSessionsFromSqlite,
  parseRolloutIncremental,
  parseClaudeIncremental,
  parseGeminiIncremental,
  parseOpencodeIncremental,
  parseOpencodeDbIncremental,
  parseQoderDbIncremental,
  openclawCursorKey,
  parseOpenclawIncremental,
  resolveOpenclawHome,
  resolveOpenclawHomes,
  resolveOpenclawSessionFiles,
  resolveClaudeScienceDbPath,
  resolveClaudeScienceDbPaths,
  buildClaudeScienceFramesQuery,
  readClaudeScienceFrames,
  parseClaudeScienceIncremental,
  parseCursorApiIncremental,
  parseKiroIncremental,
  parseHermesIncremental,
  gooseInstallOwnsCursor,
  zedInstallOwnsCursor,
  hermesInstallOwnsCursor,
  kiroInstallOwnsCursor,
  kiroCliInstallOwnsCursor,
  copilotOtelCursorHasLegacyCliUsage,
  pruneCopilotUsageClaims,
  parseCopilotIncremental,
  parseCopilotSessionStoreIncremental,
  parseCopilotAppDbIncremental,
  resolveKimiHome,
  resolveKimiWireFiles,
  resolveKimiDefaultModel,
  parseKimiIncremental,
  resolveKimiCodeHome,
  resolveKimiCodeWireFiles,
  resolveKimiCodeDefaultModel,
  parseKimiCodeIncremental,
  resolveCodebuddyHome,
  codebuddyJsonlHasUsage,
  resolveCodebuddyProjectFiles,
  resolveCodebuddyDefaultModel,
  parseCodebuddyIncremental,
  resolveWorkbuddyHome,
  resolveWorkbuddyProjectFiles,
  resolveWorkbuddyDefaultModel,
  parseWorkbuddyIncremental,
  resolveKiroCliSessionFiles,
  resolveKiroCliDbPath,
  parseKiroCliIncremental,
  resolveOmpHome,
  resolveOmpAgentDir,
  resolveOmpSessionFiles,
  resolveOmpSubagentFiles,
  resolveOmpDefaultModel,
  parseOmpIncremental,
  resolveKilocodeRoots,
  resolveKilocodeTaskFiles,
  normalizeKilocodeProviderToModel,
  parseKilocodeIncremental,
  resolveRoocodeTaskFiles,
  readRoocodeTaskModel,
  normalizeRoocodeModel,
  parseRoocodeIncremental,
  resolveZedDbPath,
  decodeZedThreadBlob,
  extractZedTotals,
  sumZedRequestUsage,
  readZedUsage,
  parseZedIncremental,
  resolveAnythingllmDbPath,
  parseAnythingllmTimestamp,
  readAnythingllmUsageRows,
  parseAnythingllmIncremental,
  resolveGooseDbPath,
  parseGooseModelName,
  parseGooseCreatedAt,
  parseGooseIncremental,
  resolveDroidSessionsDir,
  resolveDroidSessionsDirs,
  listDroidSettingsFiles,
  normalizeDroidModelName,
  normalizeDroidProvider,
  inferDroidProviderFromModel,
  defaultDroidModelForProvider,
  droidSessionIdFromPath,
  extractDroidModelFromSidecarJsonl,
  applyDroidTotalFallback,
  resolveDroidModel,
  dedupeDroidSettingsFilesBySession,
  parseDroidIncremental,
  resolvePiHome,
  resolvePiAgentDir,
  resolvePiSessionFiles,
  resolvePiDefaultModel,
  parsePiIncremental,
  piAgentDirCollidesWithOmp,
  resolvePrimeAgentHome,
  resolvePrimeAgentDir,
  resolvePrimeAgentSessionFiles,
  resolvePrimeAgentDefaultModel,
  parsePrimeAgentIncremental,
  resolveCraftConfigDir,
  resolveCraftWorkspaceRoots,
  resolveCraftSessionFiles,
  resolveCraftDefaultModel,
  parseCraftIncremental,
  resolveReasonixHome,
  resolveReasonixTelemetryFiles,
  normalizeReasonixModel,
  parseReasonixIncremental,
  // Exposed for regression tests covering cache-token accounting.
  normalizeGeminiTokens,
  normalizeOpencodeTokens,
  normalizeQoderTokens,
  sameGeminiTotals,
  diffGeminiTotals,
  // Exposed so the queue-repair migration can mutate cursors state in the
  // same key format sync uses elsewhere.
  bucketKey,
  toUtcHalfHourStart,
  totalsKey,
  claudeMessageDedupKey,
  groupBucketKey,
  // Exposed for regression tests covering nested-group remote URLs.
  canonicalizeProjectRef,
  deriveProjectKeyFromRef,
  CLAUDE_MEM_OBSERVER_PROJECT_REF,

  // Grok Build (xAI) — SessionEnd hook + passive updates.jsonl/signals.json reader
  resolveGrokBuildHome,
  resolveGrokBuildSessions,
  parseGrokBuildIncremental,

  // Antigravity (Google Gemini) - Session logs parser
  resolveAntigravityBrainDirs,
  listAntigravitySessionFiles,
  listAntigravityTranscripts,
  parseAntigravityIncremental,
  estimateAntigravityTokens,
  isCjkCodePoint,

  // Trae SOLO (ByteDance AI IDE)
  resolveTraePath,
  resolveTraeStoragePath,
  readTraeEntitlementFromStorage,
  parseTraeCnApiIncremental,
  // DeepSeek Harness (dsh) — passive session-log reader
  resolveDshHome,
  resolveDshHomes,
  resolveDshSessionFiles,
  readDshSessionText,
  decodeDshZstd,
  inspectDshZstdFrames,
  normalizeDshModelName,
  dshUsageToTotals,
  extractDshSessionUsage,
  parseDshIncremental,
};
