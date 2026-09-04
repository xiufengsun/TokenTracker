const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const cp = require("node:child_process");
const readline = require("node:readline");

const { resolveInstallPaths, resolveZcodeNativeDbPath, ensureFlatCursor } = require("../lib/install-resolver");
const { multiInstallParse, mergeBothFileSources } = require("../lib/multi-install-parser");
const wsl = require("../lib/wsl-probe");
const {
  ensureDir,
  readJson,
  writeJson,
  chmod600IfPossible,
  openLock,
  inspectLock,
  updateJsonLocked,
} = require("../lib/fs");
const { physicalJsonlRecords } = require("../lib/jsonl-lines");
const {
  listRolloutFiles,
  listRolloutFilesDeep,
  codexSessionIdFromPath,
  filterColdCodexRolloutFiles,
  listClaudeProjectFiles,
  listGeminiSessionFiles,
  listOpencodeMessageFiles,
  readOpencodeDbMessages,
  readOpencodeDbMessagesIncremental,
  readMimoDbMessages,
  readZcodeDbMessages,
  hasZcodeNativeUsageSchema,
  resolveQoderDbPaths,
  resolveQoderCnDbPaths,
  readQoderDbMessages,
  resolveQoderProjectsDir,
  resolveQoderCnProjectsDir,
  listQoderNewSessionFiles,
  parseQoderNewIncremental,
  resolveKiroDbPath,
  resolveKiroJsonlPath,
  resolveKiroBasePath,
  resolveHermesPath,
  resolveCopilotOtelPaths,
  normalizeCopilotDbPath,
  uniqueCopilotDbPaths,
  coalesceCopilotDbStatesByIdentity,
  resolveCopilotSessionStorePaths,
  getCopilotSqliteFingerprint,
  resolveCopilotAppDbPaths,
  parseRolloutIncremental,
  parseClaudeIncremental,
  parseGeminiIncremental,
  parseOpencodeIncremental,
  parseOpencodeDbIncremental,
  parseQoderDbIncremental,
  parseOpenclawIncremental,
  resolveOpenclawSessionFiles,
  resolveOpenclawHome,
  openclawCursorKey,
  resolveClaudeScienceDbPaths,
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
  resolveKimiWireFiles,
  parseKimiIncremental,
  resolveKimiCodeWireFiles,
  parseKimiCodeIncremental,
  resolveOmpSessionFiles,
  resolveOmpSubagentFiles,
  parseOmpIncremental,
  resolvePiSessionFiles,
  parsePiIncremental,
  piAgentDirCollidesWithOmp,
  resolvePrimeAgentSessionFiles,
  parsePrimeAgentIncremental,
  resolveCraftSessionFiles,
  parseCraftIncremental,
  resolveReasonixTelemetryFiles,
  parseReasonixIncremental,
  resolveGrokBuildSessions,
  parseGrokBuildIncremental,
  listAntigravityTranscripts,
  parseAntigravityIncremental,
  resolveCodebuddyProjectFiles,
  codebuddyJsonlHasUsage,
  parseCodebuddyIncremental,
  resolveWorkbuddyProjectFiles,
  parseWorkbuddyIncremental,
  resolveKiroCliSessionFiles,
  resolveKiroCliDbPath,
  parseKiroCliIncremental,
  resolveKilocodeTaskFiles,
  parseKilocodeIncremental,
  resolveRoocodeTaskFiles,
  parseRoocodeIncremental,
  resolveZedDbPath,
  parseZedIncremental,
  resolveLmstudioLogFiles,
  parseLmstudioIncremental,
  resolveUnslothDbPath,
  parseUnslothIncremental,
  resolveAnythingllmDbPath,
  parseAnythingllmIncremental,
  resolveGooseDbPath,
  parseGooseIncremental,
  listDroidSettingsFiles,
  parseDroidIncremental,
  droidSessionIdFromPath,
  resolveDroidModel,
  resolveDshSessionFiles,
  parseDshIncremental,
  parseTraeCnApiIncremental,
  bucketKey,
  toUtcHalfHourStart,
  totalsKey,
  claudeMessageDedupKey,
} = require("../lib/rollout");
const { computeClaudeGroundTruthBuckets } = require("../lib/claude-categorizer");
const { createProgress, renderBar, formatNumber, formatBytes } = require("../lib/progress");
const {
  normalizeState: normalizeUploadState,
  decideAutoUpload,
  recordUploadFailure,
  recordUploadSuccess,
  parseRetryAfterMs,
} = require("../lib/upload-throttle");
const { maybeSendHeartbeat } = require("../lib/telemetry");
const {
  isCursorInstalled,
  extractCursorSessionToken,
  fetchCursorUsageCsv,
  parseCursorCsv,
} = require("../lib/cursor-config");
const { purgeProjectUsage } = require("../lib/project-usage-purge");
const {
  fetchTraeCnUsageWithAuth,
  resolveTraeCnStoragePath,
  isTraeCnUsageEnabled,
} = require("../lib/trae-cn-config");
const {
  isCodexSessionCursorPath,
  isCursorStoreRetry,
  openCursorStore,
} = require("../lib/cursor-store");
const { resolveTrackerPaths } = require("../lib/tracker-paths");
const { resolveRuntimeConfig, isLegacyInsforgeBaseUrl } = require("../lib/runtime-config");
const { extractTokenCount } = require("../lib/codex-rollout-parser");
const {
  consumeUsageDelta,
  createUsageDeltaState,
} = require("../lib/codex-token-usage");

const CURSOR_UNKNOWN_MIGRATION_KEY = "cursorUnknownPurge_2026_04";
const ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY = "rolloutCumulativeDeltaReparse_2026_05";
const CLAUDE_MEM_OBSERVER_REINCLUDE_KEY = "claudeMemObserverReinclude_2026_05_v3";
const GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY = "grokAppendOnlyRepair_2026_05_v4";
const CODEBUDDY_LOG_JSONL_REPAIR_KEY = "codebuddyLogJsonlOverlapRepair_2026_08";
const WORKBUDDY_CONTEXT_USAGE_REPAIR_KEY = "workbuddyContextUsageRepair_2026_08";
const CLAUDE_MEM_OBSERVER_PATH_SEGMENT = "--claude-mem-observer-sessions";
// v1 had a cursor-format bug (wrote plain integer instead of {inode, offset,
// updatedAt}), which made parseClaudeIncremental reread every jsonl from
// byte 0 on the next sync and double everything. v2 fixed the format.
// v3 fixes two latent issues caught by adversarial review:
//   (a) v2 wrote `cursors.hourly.groupQueued[claude|<hour>]` for every
//       repaired bucket. enqueueTouchedBuckets uses presence of that key
//       as the legacy-group marker, so any later sync that touched a
//       claude hour (even just a user-message conv-count++) would re-emit
//       the entire hour as one aggregate row under model=DEFAULT_MODEL,
//       causing a different inflation path. v3 leaves groupQueued alone.
//   (b) v2 only repaired the main queue.jsonl. project.queue.jsonl still
//       carried historical claude-mem observer rows (project_key=
//       "claude-mem/observer-sessions") and the project totals on the
//       Project Usage panel stayed inflated. v3 drops every claude /
//       claude-mem row from project.queue.jsonl too, and resets the
//       matching cursors.projectHourly + project.queue.state offset.
// v4 fixes the dedup short-circuit (issue #64): v3's ground-truth scan
// itself used `if (msgId && reqId)` to build the dedup key, which silently
// disabled dedup for any provider whose jsonl entries lack `requestId`
// (DeepSeek/Kimi/Mimo/MiniMax anthropic-compatible endpoints, plus Claude
// Code's sub-agent / thinking transport paths). The repaired ground truth
// was therefore inflated by 1.6–3.7x on those providers — v3 left it that
// way.
// v6 was bumped in 0.26.3 to re-run the repair with the zero-usage dedup fix
// applied. SHIPPING 0.26.3 caused catastrophic data loss on every upgrader
// whose ~/.claude session jsonls had been pruned by Claude Code's own
// cleanup: the repair does atomic-drop + rescan, so any hour_start no longer
// represented in the on-disk logs is silently removed from queue.jsonl. On
// the reporter's machine this wiped 2.17B claude tokens (-1.27B opus-4-7,
// -474M opus-4-6, -376M sonnet-4-5, -48M haiku, -6M sonnet-4-6). The
// upload-offset reset also propagated the damage to the cloud.
// 0.26.4 HALTS back at v4 so the buggy atomic-rewrite path stops auto-firing
// on existing installs. The dedup fixes in parseClaudeFile /
// categorizeSessionFile / computeClaudeGroundTruthBuckets are KEPT — they are
// correct in isolation, and any future repair will produce the right answer
// for whatever data is actually on disk. A targeted, log-gap-safe mimo
// migration will ship later under its own key.
const CLAUDE_GROUND_TRUTH_REPAIR_KEY = "claudeGroundTruthRepair_2026_05_v4";
// One-time full re-upload: the cloud ingest dropped `conversation_count` to 0
// from 2026-04-18 until the 2026-06-10 field-mapping fix (it read
// `b.conversations`; queue rows carry `conversation_count`). Historical cloud
// rows can only be repaired from each user's local queue.jsonl — resetting the
// upload offset replays the full queue and the ingest's whole-row upsert
// overwrites every historical bucket with the correct conversation counts
// (token columns replay to the same final values: last emission per key wins,
// exactly how the cloud rows were built the first time).
const CLOUD_CONVERSATIONS_BACKFILL_KEY = "cloudConversationsBackfill_2026_06";
// One-time repair (#187): until the codexHashes event-dedup landed, a Codex
// session file rewritten with a new inode (Codex-Manager atomically rewrites
// sessions/ files to patch the provider on every account switch) was re-scanned
// from offset 0 and its tokens re-added to the persistent hourly buckets. This
// rebuilds the codex buckets from disk (event-deduped), atomically drops the
// inflated codex rows from queue.jsonl, and resets the upload offset so the
// corrected values overwrite the cloud. GUARDED: skips if any codex session
// file that previously contributed is no longer on disk (deleted, or moved to
// ~/.codex/archived_sessions/ which sync does not scan) — clearing its bucket
// would lose that history (ref the v6 ground-truth-repair data-loss incident).
const CODEX_RESCAN_DEDUP_REPAIR_KEY = "codexRescanDedupRepair_2026_06";
// One-time repair (#169 follow-up): forked Codex rollouts replay the parent
// session's token history into the child file, and until the same-day burst
// detector landed in rollout.js the parser counted those replayed rows as live
// usage (PR #169's date guard only caught cross-day forks). Cursors sit at EOF
// on every already-parsed file, so the forward fix alone never corrects the
// inflated history. This re-runs the exact #187 guarded rebuild under a new key
// — the rebuild re-parses every codex file with the CURRENT (fork-aware)
// parser, so replay rows are excluded — and inherits all its safety properties
// (unreproducible-session skip, atomic throwaway rebuild, queue strip, upload
// offset reset for the cloud overwrite). Pre-gated: installs with no forked
// rollout on disk carry no fork phantom and mark done without the rebuild.
const CODEX_FORK_REPLAY_REPAIR_KEY = "codexForkReplayRepair_2026_07";
// One-time repair for Codex rollouts that contain token counters from multiple
// interleaved SessionState instances. Older parsers subtracted each cumulative
// total from the most recently observed total, even when it belonged to another
// state, which could turn an ordinary turn into a multi-billion-token delta.
// v2 removes the unreliable multi_agent_version pre-gate and validates every
// contributing rollout before committing the rebuild. The new key is required
// so installs that finalized the original migration on a false negative retry.
const CODEX_USAGE_LINEAGE_REPAIR_KEY = "codexUsageLineageRepair_2026_07_v2";
const LEGACY_BASE_URL_MIGRATION_NOTE = "reset_after_legacy_baseurl_migration_2026_07";
// Keep the one escalated desktop refresh bounded; explicit full syncs can retry
// the same migration without this ceiling when the history needs a deeper scan.
const CODEX_BACKGROUND_LINEAGE_SCAN_MAX_BYTES = 1024 * 1024;
const DROID_DUP_SESSION_REPAIR_KEY = "droidDupSessionInflationRepair_2026_06";
const CODEX_COLD_SCAN_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOTIFY_LOCK_WAIT_MS = 130_000;
const NOTIFY_LOCK_POLL_MS = 5_000;
// Local API sync requests have a 120-second child-process budget. Reserve at
// least 30 seconds for parsing, persistence, and the response after contention.
const PRIORITY_LOCK_WAIT_MS = 90_000;
const PRIORITY_LOCK_POLL_MS = 250;
const CODEX_COLD_SCAN_AUDIT_MAX_SYNCS = 288;
// 0.57.0 mis-attributed mimocode's mirrored Claude/claude-mem history to
// source=mimo (read the whole DB instead of only providerID=mimo rows). This
// one-time repair purges all source=mimo data from the local queues + cursor
// state so the next sync (providerID-filtered reader) rebuilds it correctly.
const MIMO_PROVIDER_REPAIR_KEY = "mimoClaudeMislabelRepair_2026_06";
const DSH_LEGACY_SOURCE_MIGRATION_KEY = "deepseekHarnessSourceMigration_2026_08";
const ZCODE_NATIVE_USAGE_REPAIR_KEY = "zcodeNativeUsageRepair_2026_08";
const ZCODE_INCLUSIVE_TOKEN_REPAIR_KEY = "zcodeInclusiveTokenRepair_2026_09";
const AUTO_SYNC_SOURCE_ALIASES = new Map([
  ["code", "every-code"],
  ["deepseek", "dsh"],
  ["everycode", "every-code"],
  ["kilo", "kilo-cli"],
  ["kilo-code", "kilocode"],
  ["kimi_code", "kimi-code"],
  ["roo-code", "roocode"],
]);
const AUTO_SYNC_SOURCES = new Set([
  "acode",
  "antigravity",
  "anythingllm",
  "claude",
  "claude-science",
  "codebuddy",
  "codex",
  "copilot",
  "craft",
  "cursor",
  "droid",
  "dsh",
  "every-code",
  "gemini",
  "goose",
  "grok",
  "hermes",
  "kilo-cli",
  "kilocode",
  "kiro",
  "kimi",
  "kimi-code",
  "lmstudio",
  "mimo",
  "omp",
  "opencode",
  "openclaw",
  "pi",
  "qoder",
  "qoder-cn",
  "reasonix",
  "roocode",
  "trae-cn",
  "unsloth",
  "workbuddy",
  "zcode",
  "zed",
]);
const BACKGROUND_AUTO_SYNC_SOURCES = new Set([
  // Keep unscoped native 5-minute syncs bounded to dated local session trees.
  "acode",
  "codex",
  "every-code",
  "reasonix",
]);

function warnProviderParseFailure(label, err, opts) {
  if (opts?.auto) return;
  process.stderr.write(`${label} sync: ${err && err.message ? err.message : err}\n`);
}

function mergeParseResult(total, next) {
  return {
    recordsProcessed: total.recordsProcessed + next.recordsProcessed,
    eventsAggregated: total.eventsAggregated + next.eventsAggregated,
    bucketsQueued: total.bucketsQueued + next.bucketsQueued,
  };
}

function copilotAppBaselineTotal(baseline) {
  return (
    Math.max(0, Number(baseline?.input) || 0) +
    Math.max(0, Number(baseline?.output) || 0) +
    Math.max(0, Number(baseline?.cached) || 0) +
    Math.max(0, Number(baseline?.reasoning) || 0)
  );
}

function mergeCopilotAppDbStates(primary = {}, alias = {}) {
  const primaryUpdatedAt = Date.parse(primary?.updatedAt || "") || 0;
  const aliasUpdatedAt = Date.parse(alias?.updatedAt || "") || 0;
  const newer = aliasUpdatedAt > primaryUpdatedAt ? alias : primary;
  const sessionTotals = {};
  for (const state of [primary, alias]) {
    for (const [sessionId, baseline] of Object.entries(
      state?.sessionTotals || {},
    )) {
      const current = sessionTotals[sessionId];
      const baselineTotal = copilotAppBaselineTotal(baseline);
      const currentTotal = copilotAppBaselineTotal(current);
      const baselineUpdatedAt = Date.parse(baseline?.updatedAt || "") || 0;
      const currentUpdatedAt = Date.parse(current?.updatedAt || "") || 0;
      if (
        !current ||
        baselineTotal > currentTotal ||
        (baselineTotal === currentTotal &&
          baselineUpdatedAt > currentUpdatedAt)
      ) {
        sessionTotals[sessionId] = baseline;
      }
    }
  }
  return { ...primary, ...newer, sessionTotals };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSyncLock(
  lockPath,
  opts,
  {
    notifyWaitMs = NOTIFY_LOCK_WAIT_MS,
    notifyPollMs = NOTIFY_LOCK_POLL_MS,
    priorityWaitMs = PRIORITY_LOCK_WAIT_MS,
    priorityPollMs = PRIORITY_LOCK_POLL_MS,
  } = {},
) {
  const waitsForPriority = Boolean(opts.waitForLock || opts.drain || opts.publishAccount);
  let lock = await openLock(lockPath, {
    quietIfLocked: opts.auto || waitsForPriority,
  });
  if (lock) return lock;

  if (waitsForPriority) {
    const deadline = Date.now() + Math.max(0, priorityWaitMs);
    while (!lock && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await sleep(Math.min(Math.max(1, priorityPollMs), remaining));
      lock = await openLock(lockPath, { quietIfLocked: true });
    }
    if (!lock) {
      const error = new Error(
        "SYNC_BUSY: another sync is still running; no refresh was performed",
      );
      error.code = "SYNC_BUSY";
      throw error;
    }
    return lock;
  }

  if (!opts.fromNotify || notifyWaitMs <= 0) return null;

  // One low-frequency waiter coalesces every notify that lands behind an
  // active native/background sync. This avoids both losing the final Codex
  // turn and spawning a fleet of idle retry processes during a long scan.
  const waiter = await openLock(`${lockPath}.notify-wait`, {
    quietIfLocked: true,
  });
  if (!waiter) return null;

  try {
    const deadline = Date.now() + notifyWaitMs;
    while (!lock && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await sleep(Math.min(Math.max(1, notifyPollMs), remaining));
      lock = await openLock(lockPath, { quietIfLocked: true });
    }
    return lock;
  } finally {
    await waiter.release();
  }
}

const SYNC_SKIP_MARKER = "sync.skip.json";

// A skipped sync used to exit 0 with no output whatsoever, so lock debris left
// by a killed run stalled every parse for a day with no visible signal and
// nothing for `tokentracker status` to report (issue #431). Leave a queryable
// marker that separates ordinary contention (`lock_busy`) from a lease whose
// owner is gone (`lock_debris`, the state that needs attention).
async function recordSyncSkip(trackerDir, lockPath) {
  const holder = await inspectLock(lockPath);
  const reason = holder.exists && holder.pid && !holder.alive ? "lock_debris" : "lock_busy";
  const detail = !holder.exists
    ? "sync lock could not be acquired"
    : holder.pid
      ? `sync lock held by pid ${holder.pid} (${holder.alive ? "running" : "not running"})`
      : "sync lock has no owner record";
  await writeJson(path.join(trackerDir, SYNC_SKIP_MARKER), {
    reason,
    detail,
    at: new Date().toISOString(),
    lockPath,
  });
  return `Sync skipped: ${reason} — ${detail}\n`;
}

async function clearSyncSkip(trackerDir) {
  try {
    await fs.unlink(path.join(trackerDir, SYNC_SKIP_MARKER));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function cmdSync(argv, context = {}) {
  const opts = parseArgs(argv);
  const diagnostics = context && typeof context === "object" ? context.diagnostics : null;
  const cursorStoreOptions = context && typeof context === "object"
    ? context.cursorStoreOptions
    : null;
  const lockWaitOptions = context && typeof context === "object"
    ? context.lockWaitOptions
    : undefined;
  // Narrow test-only seam for TRAE Work CN: deterministic injected fetch + a
  // fixed "now" for the rolling range. Production keeps the global fetch and
  // current time; no public CLI flag/config is introduced.
  const traeCnFetchImpl = context && typeof context === "object"
    ? context.traeCnFetchImpl
    : undefined;
  const traeCnNowMs = context && typeof context === "object"
    ? context.traeCnNowMs
    : undefined;
  const cursorSyncDeps = context && typeof context.cursorSyncDeps === "object"
    ? context.cursorSyncDeps
    : {};
  const syncDiagnostics = diagnostics && typeof diagnostics === "object" ? diagnostics : null;
  const home = os.homedir();
  const { trackerDir } = await resolveTrackerPaths({ home });

  await ensureDir(trackerDir);
  if (opts.fromOpenclaw) {
    await writeOpenclawSignal(trackerDir);
  }

  const lockPath = path.join(trackerDir, "sync.lock");
  const lock = await acquireSyncLock(lockPath, opts, lockWaitOptions);
  if (!lock) {
    // Warn on stderr so the notice reaches interactive and background runs
    // alike without disturbing anything that parses sync's stdout.
    process.stderr.write(await recordSyncSkip(trackerDir, lockPath));
    return;
  }
  let progress = null;
  try {
    // Marker cleanup can fail for reasons other than ENOENT (permissions, or a
    // directory replacing the expected file). Keep it inside the lease's
    // try/finally so an auxiliary diagnostic never strands the sync lock.
    await clearSyncSkip(trackerDir);
    progress = !opts.auto ? createProgress({ stream: process.stdout }) : null;
    const configPath = path.join(trackerDir, "config.json");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const queuePath = path.join(trackerDir, "queue.jsonl");
    const queueStatePath = path.join(trackerDir, "queue.state.json");
    const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");
    const projectQueueStatePath = path.join(trackerDir, "project.queue.state.json");
    const uploadThrottlePath = path.join(trackerDir, "upload.throttle.json");
    const grokSignalPath = path.join(trackerDir, "grok-last-session.json");
    const legacyGrokSignalPath = path.join(trackerDir, "tracker", "grok-last-session.json");

    // Native publication owns backlog and failure-backoff retries on its next
    // five-minute tick. Remove any legacy detached retry marker immediately so
    // an already-sleeping retry process observes the missing marker and exits.
    if (opts.publishAccount) {
      await clearAutoRetry(trackerDir);
    }

    const config = await readJson(configPath);
    let legacyBaseUrlMigration = null;
    // One-time repair for installs initialized before the 2026-04-19 InsForge
    // project migration (0.5.67): init preserved any persisted config.baseUrl,
    // so those installs kept uploading to the retired b46ug8xu project until
    // its backend went dark on 2026-07-27 — every upload since 503s while the
    // dashboard shows no error (silent cloud outage). Reset the upload offset
    // so the whole local queue replays into the current project, clear the 503
    // backoff, then remove the retired URL as the final commit step. Keeping the
    // URL until every prerequisite succeeds makes an interrupted migration
    // retryable on the next sync. Device tokens are opaque random values looked
    // up by SHA-256 hash in tokentracker_device_tokens (not JWT_SECRET-signed);
    // the database was restored into the current project, so preserve the old
    // token unless the local API has already minted a replacement from the
    // user's current login session and passed it through the environment.
    // Ingest is a whole-row upsert per bucket key, making replay idempotent.
    if (config && isLegacyInsforgeBaseUrl(config.baseUrl)) {
      const priorQueueState = (await readJson(queueStatePath)) || {};
      // Prepare the replay exactly once. The note survives successful batches,
      // so retryable failures retain both their committed offset and backoff
      // instead of restarting history and hammering the backend on every hook.
      if (priorQueueState.note !== LEGACY_BASE_URL_MIGRATION_NOTE) {
        await writeJson(queueStatePath, {
          ...priorQueueState,
          offset: 0,
          updatedAt: new Date().toISOString(),
          note: LEGACY_BASE_URL_MIGRATION_NOTE,
        });
        try {
          await fs.unlink(uploadThrottlePath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      const replacementDeviceToken =
        typeof process.env.TOKENTRACKER_DEVICE_TOKEN === "string"
          ? process.env.TOKENTRACKER_DEVICE_TOKEN.trim()
          : "";
      const previousDeviceToken =
        typeof config.deviceToken === "string" ? config.deviceToken.trim() : "";
      // Do not commit either the replacement token or URL removal yet. The
      // current backend must accept a token first; otherwise a stale environment
      // token could destroy a valid restored credential and make recovery worse.
      legacyBaseUrlMigration = {
        previousDeviceToken,
        replacementDeviceToken,
        hadPersistedAnonKey: Object.prototype.hasOwnProperty.call(config, "anonKey"),
        persistedAnonKey: config.anonKey,
      };
    }
    const codexCursorRoots = [process.env.CODEX_HOME || path.join(home, ".codex")];
    const cursorStore = await openCursorStore({
      trackerDir,
      cursorsPath,
      codexRoots: codexCursorRoots,
      ...(cursorStoreOptions && typeof cursorStoreOptions === "object"
        ? cursorStoreOptions
        : {}),
    });
    const cursors = cursorStore.cursors;
    const uploadThrottle = normalizeUploadState(await readJson(uploadThrottlePath));
    let uploadThrottleState = uploadThrottle;
    let grokHookSignal = null;
    let grokHookSignalPath = null;
    for (const candidate of [grokSignalPath, legacyGrokSignalPath]) {
      const signal = await readJson(candidate);
      if (signal && typeof signal === "object") {
        grokHookSignal = signal;
        grokHookSignalPath = candidate;
        break;
      }
    }
    let grokHookSignalConsumed = false;

    // Claude Code home — dual-install aware (#307): a Windows host may carry
    // a native ~/.claude plus a WSL install reachable over \\wsl$. Unlike the
    // SQLite providers, Claude UNIONS every allowed install instead of taking
    // resolveAllWin32Paths' single pick: under the default wsl-first mode a
    // WSL ~/.claude would otherwise silently evict the native one from
    // collection — and from the "disk is truth" ground-truth repair below,
    // which would then erase the native history. The file-hash and
    // message-hash dedup layers make the union safe. Native is listed first
    // so the cross-environment file dedup keeps the native copy as primary.
    const claudeNativeHome = path.join(home, ".claude");
    const wslClaudeHome = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
      ? wsl.discoverWslHome(".claude")
      : null;
    const claudeInstallHomes = [];
    if (process.platform !== "win32" || wsl.shouldProbeNative(process.env)) {
      claudeInstallHomes.push(claudeNativeHome);
    }
    if (wslClaudeHome) claudeInstallHomes.push(wslClaudeHome);
    const claudeProjectsDirs = claudeInstallHomes.map((h) => path.join(h, "projects"));
    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
    const kiloHome = process.env.KILO_HOME || path.join(xdgDataHome, "kilo");
    const mimoHome = process.env.MIMO_HOME || path.join(xdgDataHome, "mimocode");

    // OpenClaw session plugin integration: lifecycle hooks request an
    // OpenClaw-only auto sync so unrelated providers do not get walked.
    const openclawSignal = opts.fromOpenclaw
      ? resolveOpenclawSignal({ env: process.env })
      : null;

    const autoSourceScope = resolveAutoSourceScope(opts);
    // --background controls local scan breadth; --drain only controls upload
    // depth and lock priority. Plain `sync --drain` remains a full source scan.
    const isBackgroundLightweightSync = opts.auto && opts.background;
    const isBackgroundAllLocalSync = isBackgroundLightweightSync && opts.allLocalSources;
    const isFullSourceScan = !autoSourceScope && !isBackgroundLightweightSync;
    const sourceAllowed = (...sources) => {
      if (isBackgroundLightweightSync) {
        if (autoSourceScope) {
          return (
            (isBackgroundAllLocalSync || BACKGROUND_AUTO_SYNC_SOURCES.has(autoSourceScope)) &&
            sources.includes(autoSourceScope)
          );
        }
        if (isBackgroundAllLocalSync) {
          return sources.some((source) => AUTO_SYNC_SOURCES.has(source));
        }
        return sources.some((source) => BACKGROUND_AUTO_SYNC_SOURCES.has(source));
      }
      if (autoSourceScope) return sources.includes(autoSourceScope);
      return true;
    };
    // Desktop refreshes are deliberately lightweight, but that also means a
    // migration wired only to full sync would never repair an existing native
    // install. Escalate exactly the first eligible background run: fresh
    // installs have no persisted Codex buckets to repair, while retryable
    // failures remain reserved for an explicit full sync instead of turning
    // every five-minute refresh into a deep historical scan.
    const backgroundCodexUsageMigrationEligible = Boolean(
      isBackgroundLightweightSync &&
      sourceAllowed("codex") &&
      !cursors.migrations?.[CODEX_USAGE_LINEAGE_REPAIR_KEY]
    );
    const hasPersistedCodexUsage = Object.keys(cursors.hourly?.buckets || {})
      .some((key) => key.startsWith("codex|"));
    const backgroundCodexUsageRepair =
      backgroundCodexUsageMigrationEligible && hasPersistedCodexUsage;
    if (backgroundCodexUsageMigrationEligible && !hasPersistedCodexUsage) {
      // A fresh install has no old-parser buckets to repair. Mark it complete
      // before the first bounded parse so the next refresh does not mistake
      // newly parsed, already-correct data for legacy history.
      (cursors.migrations ||= {})[CODEX_USAGE_LINEAGE_REPAIR_KEY] =
        new Date().toISOString();
    }

    const sources = [];
    if (sourceAllowed("codex")) {
      const codexNativeValue = process.env.CODEX_HOME || path.join(home, ".codex");
      // resolveInstallPaths stays the single authority for wsl-first /
      // native-first / wsl-only / native-only / both selection; requireAnyChild
      // makes it validate that a candidate actually holds sessions/ or
      // archived_sessions/ so an empty WSL ~/.codex shell cannot shadow the
      // native install (issue #codex-wsl-shadow).
      //
      // Pass `wslDir` rather than a pre-resolved home so requireAnyChild is
      // folded INTO the discovery probe: discoverWslHome returns the first
      // distro whose ~/.codex merely exists, so resolving it here first meant a
      // bare shell in an earlier distro won, got rejected as unpopulated, and
      // the populated later distro was never looked at — the same shadowing bug
      // one level down, and a silent disagreement with status.js.
      //
      // union: both installs are real usage on this machine, so a preference
      // mode must not delete one of them. Before this, a populated WSL
      // ~/.codex evicted the native install entirely under the default
      // wsl-first — the session browser (which walks every root, see
      // session-analytics.js providerRoots) showed those Codex sessions while
      // the dashboard counted none of their tokens. Safe because the parser
      // dedups Codex events by sessionUUID:eventTimestamp, so the same session
      // seen under two path spellings collapses instead of double-counting.
      const codexPaths = resolveInstallPaths({
        nativeValue: codexNativeValue,
        wslDir: ".codex",
        requireAnyChild: ["sessions", "archived_sessions"],
        union: true,
      });
      if (codexPaths.native) {
        sources.push({ source: "codex", sessionsDir: path.join(codexPaths.native, "sessions"), inventoryCacheKey: "codexDayInventoryCache" });
        if (!isBackgroundLightweightSync || backgroundCodexUsageRepair) {
          sources.push({ source: "codex", sessionsDir: path.join(codexPaths.native, "archived_sessions"), deep: true });
        }
      }
      if (codexPaths.wsl) {
        sources.push({ source: "codex", sessionsDir: path.join(codexPaths.wsl, "sessions"), inventoryCacheKey: "codexDayInventoryCache" });
        if (!isBackgroundLightweightSync || backgroundCodexUsageRepair) {
          sources.push({ source: "codex", sessionsDir: path.join(codexPaths.wsl, "archived_sessions"), deep: true });
        }
      }
    }
    if (sourceAllowed("acode")) {
      const acodeNativeValue =
        process.env.TOKENTRACKER_ACODE_HOME || path.join(home, ".acode");
      const acodePaths = resolveInstallPaths({
        nativeValue: acodeNativeValue,
        wslDir: ".acode",
        requireAnyChild: ["sessions", "archived_sessions"],
        union: true,
      });
      if (acodePaths.native) {
        sources.push({
          source: "acode",
          sessionsDir: path.join(acodePaths.native, "sessions"),
          inventoryCacheKey: "acodeDayInventoryCache",
        });
        if (!isBackgroundLightweightSync) {
          sources.push({
            source: "acode",
            sessionsDir: path.join(acodePaths.native, "archived_sessions"),
            deep: true,
          });
        }
      }
      if (acodePaths.wsl) {
        sources.push({
          source: "acode",
          sessionsDir: path.join(acodePaths.wsl, "sessions"),
          inventoryCacheKey: "acodeDayInventoryCache",
        });
        if (!isBackgroundLightweightSync) {
          sources.push({
            source: "acode",
            sessionsDir: path.join(acodePaths.wsl, "archived_sessions"),
            deep: true,
          });
        }
      }
    }
    if (sourceAllowed("every-code")) {
      const codeNativeValue = process.env.CODE_HOME || path.join(home, ".code");
      const wslCodeDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
        ? wsl.discoverWslHome(".code")
        : null;
      const codePaths = resolveInstallPaths({ nativeValue: codeNativeValue, wslValue: wslCodeDir });
      if (codePaths.native) {
        sources.push({ source: "every-code", sessionsDir: path.join(codePaths.native, "sessions") });
      }
      if (codePaths.wsl) {
        sources.push({ source: "every-code", sessionsDir: path.join(codePaths.wsl, "sessions") });
      }
    }

    const rolloutFiles = [];
    const seenSessions = new Set();
    const uniqueSources = sources.filter((entry) => {
      if (seenSessions.has(entry.sessionsDir)) return false;
      seenSessions.add(entry.sessionsDir);
      return true;
    });
    const inventoryCaches = new Map();
    const inventoryCacheKeys = new Set(
      uniqueSources.map((entry) => entry.inventoryCacheKey).filter(Boolean),
    );
    for (const cursorKey of inventoryCacheKeys) {
      const inventoryCache =
        cursors[cursorKey] && typeof cursors[cursorKey] === "object"
          ? cursors[cursorKey]
          : { version: 1, days: {} };
      cursors[cursorKey] = inventoryCache;
      inventoryCaches.set(cursorKey, inventoryCache);
    }
    const sourceFileGroups = await Promise.all(uniqueSources.map((entry) => (
      entry.deep
        ? listRolloutFilesDeep(entry.sessionsDir)
        : listRolloutFiles(entry.sessionsDir, entry.inventoryCacheKey
          ? { dayInventoryCache: inventoryCaches.get(entry.inventoryCacheKey) }
          : undefined)
    )));
    for (let sourceIndex = 0; sourceIndex < uniqueSources.length; sourceIndex++) {
      const entry = uniqueSources[sourceIndex];
      const files = sourceFileGroups[sourceIndex];
      for (const filePath of files) {
        rolloutFiles.push({ path: filePath, source: entry.source });
      }
    }

    if (isFullSourceScan) {
      await cursorStore.materializeAllCodexState(cursors);
      await migrateRolloutCumulativeDeltaBuckets({ cursors, queuePath, rolloutFiles });
      const codexRescanRepairRan = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles,
      });
      const codexForkRepairRan = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles,
        legacyRepairRan: codexRescanRepairRan,
      });
      await repairCodexInterleavedUsageInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles,
        legacyRepairRan: codexRescanRepairRan || codexForkRepairRan,
      });
      await repairDroidDuplicateSessionInflation({ cursors, queuePath, queueStatePath });
      await repairMimoClaudeMislabel({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
      });
    } else if (backgroundCodexUsageRepair) {
      await cursorStore.materializeAllCodexState(cursors);
      try {
        await repairCodexInterleavedUsageInflation({
          cursors,
          queuePath,
          queueStatePath,
          projectQueuePath,
          projectQueueStatePath,
          rolloutFiles,
          maxLineageScanBytes: CODEX_BACKGROUND_LINEAGE_SCAN_MAX_BYTES,
        });
      } catch (err) {
        warnProviderParseFailure("Codex usage lineage repair", err, opts);
      } finally {
        // Rebuild failures intentionally leave the migration key unset so a
        // future full sync can retry. Record a retryable sentinel here to keep
        // routine native background refreshes bounded after that first attempt.
        const migrations = (cursors.migrations ||= {});
        if (!migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY]) {
          migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY] = {
            skipped: true,
            reason: "background_repair_requires_full_sync",
            at: new Date().toISOString(),
          };
        }
      }
    }

    const codexColdSkipEnabled = opts.auto && sourceAllowed("codex");
    const deferredCodexAuditSyncs = codexColdSkipEnabled
      ? await cursorStore.readDeferredCodexAuditSyncs()
      : 0;
    const codexColdAuditDue = codexColdSkipEnabled
      ? isCodexColdScanAuditDue(cursors, Date.now(), deferredCodexAuditSyncs)
      : false;
    let codexColdFilter = codexColdSkipEnabled
      ? await filterColdCodexRolloutFiles({
          rolloutFiles,
          cursors,
          codexCursorStore: cursorStore,
          projectEnabled: true,
          auditDue: codexColdAuditDue,
          diagnostics: syncDiagnostics,
        })
      : { rolloutFiles, skipped: 0 };
    const rolloutFilesForParse = codexColdFilter.rolloutFiles;
    let codexCursorLoadRestarted = false;
    if (!codexColdSkipEnabled && sourceAllowed("codex")) {
      const loadResult = await cursorStore.loadCodexFilesForPaths(
        rolloutFilesForParse,
        cursors,
      );
      codexCursorLoadRestarted = Boolean(loadResult?.restarted);
    }

    // Plugin-triggered sync points at one specific session file; a normal full
    // sync also passively scans every on-disk OpenClaw transcript so usage is
    // captured even when the session plugin never fires (issue #264). The scan
    // is gated to full syncs so a scoped `--from-openclaw` hook still only
    // touches its own file and the 5-minute background tick stays cheap. The
    // event-identity dedup makes the plugin and passive paths idempotent, so
    // overlap on the same file is safe.
    //
    // Keyed by openclawCursorKey, not the raw path: that is the same identity
    // the parser assigns cursors by, so a plugin-supplied path and a scanned
    // path that differ only in Windows casing collapse to one entry instead of
    // being parsed twice.
    const openclawSessionFiles = new Map();
    if (openclawSignal?.sessionFile) {
      openclawSessionFiles.set(openclawCursorKey(openclawSignal.sessionFile), {
        path: openclawSignal.sessionFile,
        source: "openclaw",
      });
    }
    if (isFullSourceScan && sourceAllowed("openclaw")) {
      try {
        for (const f of await resolveOpenclawSessionFiles(process.env)) {
          const key = openclawCursorKey(f);
          if (!openclawSessionFiles.has(key)) {
            openclawSessionFiles.set(key, { path: f, source: "openclaw" });
          }
        }
      } catch (err) {
        warnProviderParseFailure("OpenClaw", err, opts);
      }
    }
    const openclawFiles = Array.from(openclawSessionFiles.values());

    if (progress?.enabled) {
      progress.start(
        `Parsing ${renderBar(0)} 0/${formatNumber(rolloutFilesForParse.length)} files | buckets 0`,
      );
    }

    let parseResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    let codexParseSucceeded = false;
    let codexFallbackRetryRan = Boolean(
      codexColdFilter.restarted || codexCursorLoadRestarted,
    );
    const runCodexParse = (files) => parseRolloutIncremental({
      rolloutFiles: files,
      cursors,
      codexEventStore: Array.isArray(cursors.codexHashes)
        ? null
        : cursorStore.codexEventStore,
      queuePath,
      projectQueuePath,
      diagnostics: syncDiagnostics,
      onProgress: (p) => {
        if (!progress?.enabled) return;
        const pct = p.total > 0 ? p.index / p.total : 1;
        progress.update(
          `Parsing ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(
            p.bucketsQueued,
          )}`,
        );
      },
    });
    try {
      parseResult = await runCodexParse(rolloutFilesForParse);
      codexParseSucceeded = true;
    } catch (err) {
      if (isCursorStoreRetry(err)) {
        await cursorStore.loadCodexFilesForPaths(rolloutFiles, cursors);
        codexColdFilter = { rolloutFiles, skipped: 0, restarted: true };
        codexFallbackRetryRan = true;
        if (syncDiagnostics) {
          syncDiagnostics.cold_skipped = 0;
          syncDiagnostics.parse_candidates = rolloutFiles.reduce(
            (count, entry) => count + (
              typeof entry === "string" || !entry?.source || entry.source === "codex"
                ? 1
                : 0
            ),
            0,
          );
        }
        parseResult = await runCodexParse(rolloutFiles);
        codexParseSucceeded = true;
      } else if (err?.code === "TOKENTRACKER_CURSOR_STORE_CORRUPT") {
        throw err;
      } else {
        warnProviderParseFailure("Codex", err, opts);
      }
    }
    const codexAuditRecorded = codexColdSkipEnabled && codexParseSucceeded;
    if (codexAuditRecorded) {
      recordCodexColdScanAudit(cursors, {
        fullAudit: codexColdAuditDue || codexFallbackRetryRan,
        skipped: codexColdFilter.skipped,
        deferredSyncs: deferredCodexAuditSyncs,
      });
    }

    let openclawResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("openclaw") && openclawFiles.length > 0) {
      // Parses plugin-triggered and/or passively discovered session files.
      try {
        openclawResult = await parseOpenclawIncremental({
          sessionFiles: openclawFiles,
          cursors,
          queuePath,
          projectQueuePath,
          source: "openclaw",
        });
      } catch (err) {
        warnProviderParseFailure("OpenClaw", err, opts);
      }
    }

    let openclawFallback = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("openclaw")) {
      try {
        openclawFallback = await applyOpenclawTotalsFallback({
          trackerDir,
          signal: openclawSignal,
          cursors,
          queuePath,
          projectQueuePath,
        });
      } catch (err) {
        warnProviderParseFailure("OpenClaw", err, opts);
      }
    }
    openclawResult.filesProcessed += openclawFallback.filesProcessed;
    openclawResult.eventsAggregated += openclawFallback.eventsAggregated;
    openclawResult.bucketsQueued += openclawFallback.bucketsQueued;

    let claudeFiles = [];
    if (sourceAllowed("claude")) {
      const seenClaudeFiles = new Set();
      for (const dir of claudeProjectsDirs) {
        for (const f of await listClaudeProjectFiles(dir)) {
          if (!seenClaudeFiles.has(f)) {
            seenClaudeFiles.add(f);
            claudeFiles.push(f);
          }
        }
      }
    }
    if (isFullSourceScan) {
      await reincludeClaudeMemObserverFiles({ cursors, claudeFiles, queuePath, queueStatePath });
      await repairClaudeQueueFromGroundTruth({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rootDirs: claudeProjectsDirs,
      });
    }
    let claudeResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (claudeFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Claude ${renderBar(0)} 0/${formatNumber(claudeFiles.length)} files | buckets 0`,
        );
      }
      try {
        claudeResult = await parseClaudeIncremental({
          projectFiles: claudeFiles,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Claude ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(
                p.bucketsQueued,
              )}`,
            );
          },
          source: "claude",
        });
      } catch (err) {
        warnProviderParseFailure("Claude", err, opts);
      }
    }

    let geminiPaths = null;
    if (sourceAllowed("gemini") || sourceAllowed("antigravity")) {
      const geminiNativeValue = process.env.GEMINI_HOME || path.join(home, ".gemini");
      const wslGeminiDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
        ? wsl.discoverWslHome(".gemini")
        : null;
      geminiPaths = resolveInstallPaths({ nativeValue: geminiNativeValue, wslValue: wslGeminiDir });
    }

    let geminiFiles = [];
    if (sourceAllowed("gemini") && geminiPaths) {
      const fileSets = [];
      if (geminiPaths.native) {
        fileSets.push(await listGeminiSessionFiles(path.join(geminiPaths.native, "tmp")));
      }
      if (geminiPaths.wsl) {
        fileSets.push(await listGeminiSessionFiles(path.join(geminiPaths.wsl, "tmp")));
      }
      const seen = new Set();
      for (const set of fileSets) {
        for (const f of set) {
          if (!seen.has(f)) {
            seen.add(f);
            geminiFiles.push(f);
          }
        }
      }
    }
    let geminiResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (geminiFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Gemini ${renderBar(0)} 0/${formatNumber(geminiFiles.length)} files | buckets 0`,
        );
      }
      try {
        geminiResult = await parseGeminiIncremental({
          sessionFiles: geminiFiles,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Gemini ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(
                p.bucketsQueued,
              )}`,
            );
          },
          source: "gemini",
        });
      } catch (err) {
        warnProviderParseFailure("Gemini", err, opts);
      }
    }

    let antigravityFiles = [];
    if (sourceAllowed("antigravity") && geminiPaths) {
      const fileSets = [];
      if (geminiPaths.native) {
        fileSets.push(await listAntigravityTranscripts(geminiPaths.native));
      }
      if (geminiPaths.wsl) {
        fileSets.push(await listAntigravityTranscripts(geminiPaths.wsl));
      }
      const seen = new Set();
      for (const set of fileSets) {
        for (const f of set) {
          if (!seen.has(f)) {
            seen.add(f);
            antigravityFiles.push(f);
          }
        }
      }
    }
    let antigravityResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (antigravityFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Antigravity ${renderBar(0)} 0/${formatNumber(antigravityFiles.length)} files | buckets 0`,
        );
      }
      try {
        antigravityResult = await parseAntigravityIncremental({
          sessionFiles: antigravityFiles,
          cursors,
          queuePath,
          projectQueuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Antigravity ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(
                p.bucketsQueued,
              )}`,
            );
          },
          source: "antigravity",
        });
      } catch (err) {
        warnProviderParseFailure("Antigravity", err, opts);
      }
    }

    let opencodeResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("opencode")) {
      const opencodeStorageNativeValue = process.env.OPENCODE_HOME || path.join(xdgDataHome, "opencode");
      const wslOpencodeStorageDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
        ? wsl.discoverWslHome(".local/share/opencode")
        : null;
      const storagePaths = resolveInstallPaths({
        nativeValue: opencodeStorageNativeValue,
        wslValue: wslOpencodeStorageDir,
      });

      const opencodeDbNativeValue = process.env.OPENCODE_HOME || path.join(xdgDataHome, "opencode");
      const wslOpencodeDbDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
        ? wsl.discoverWslHome(".local/share/opencode")
        : null;
      const dbPaths = resolveInstallPaths({
        nativeValue: opencodeDbNativeValue,
        wslValue: wslOpencodeDbDir,
      });

      const parseOpencodeForInstall = async (options) => {
        const { storageDir, dbDir, cursors } = options;
        let filesResult = { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
        if (storageDir) {
          const storagePath = path.join(storageDir, "storage");
          const messageFiles = await listOpencodeMessageFiles(storagePath);
          if (messageFiles.length > 0) {
            filesResult = await parseOpencodeIncremental({
              ...options,
              messageFiles,
            });
          }
        }

        let dbResult = { messagesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
        if (dbDir) {
          const dbPath = path.join(dbDir, "opencode.db");
          const dbRead = readOpencodeDbMessagesIncremental(
            dbPath,
            cursors?.opencode?.dbCursor,
          );
          if (dbRead.messages.length > 0 || dbRead.cursor) {
            dbResult = await parseOpencodeDbIncremental({
              ...options,
              dbMessages: dbRead.messages,
              dbCursor: dbRead.cursor,
              dbPath,
            });
          }
        }

        return {
          recordsProcessed: filesResult.filesProcessed + dbResult.messagesProcessed,
          eventsAggregated: filesResult.eventsAggregated + dbResult.eventsAggregated,
          bucketsQueued: filesResult.bucketsQueued + dbResult.bucketsQueued,
        };
      };

      const opencodePaths = {
        native: storagePaths.native || dbPaths.native,
        wsl: storagePaths.wsl || dbPaths.wsl,
      };

      const multiResult = await multiInstallParse({
        paths: opencodePaths,
        parserFn: parseOpencodeForInstall,
        providerName: "opencode",
        cursors,
        queuePath,
        projectQueuePath,
        getParams: (p, key) => ({ storageDir: storagePaths[key], dbDir: dbPaths[key] }),
        onProgress: (p) => {
          if (!progress?.enabled) return;
          const pct = p.total > 0 ? p.index / p.total : 1;
          progress.update(
            `Parsing Opencode (${p.install || "default"}) ${renderBar(pct)} ${formatNumber(
              p.index,
            )}/${formatNumber(p.total)} | buckets ${formatNumber(p.bucketsQueued)}`,
          );
        },
        source: "opencode",
      });

      opencodeResult = {
        filesProcessed: multiResult.recordsProcessed,
        eventsAggregated: multiResult.eventsAggregated,
        bucketsQueued: multiResult.bucketsQueued,
      };
    }

    let qoderResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("qoder")) {
      const qoderPaths = resolveQoderDbPaths({
        home,
        env: process.env,
        platform: process.platform,
      });
      if (qoderPaths.native || qoderPaths.wsl) {
        if (progress?.enabled) {
          progress.start(`Parsing Qoder ${renderBar(0)} | buckets 0`);
        }
        try {
          const result = await multiInstallParse({
            paths: qoderPaths,
            parserFn: async ({ dbPath, ...rest }) => {
              const dbMessages = await readQoderDbMessages(dbPath);
              const parsed = await parseQoderDbIncremental({ dbMessages, dbPath, ...rest });
              return {
                recordsProcessed: parsed.messagesProcessed || 0,
                eventsAggregated: parsed.eventsAggregated || 0,
                bucketsQueued: parsed.bucketsQueued || 0,
              };
            },
            providerName: "qoder",
            cursors,
            queuePath,
            projectQueuePath,
            getParams: (dbPath) => ({ dbPath }),
            onProgress: makeProviderProgress("Qoder"),
          });
          qoderResult = {
            recordsProcessed: result.recordsProcessed || 0,
            eventsAggregated: result.eventsAggregated || 0,
            bucketsQueued: result.bucketsQueued || 0,
          };
        } catch (err) {
          warnProviderParseFailure("Qoder", err, opts);
        }
      }
    }

    // Qoder new (JSONL) — com.qoder.app.stable / ~/.qoder/projects (2026-08+)
    // The new Electron app no longer writes SharedClientCache/local.db; all
    // recent sessions live in ~/.qoder/projects as flat JSONL with credit-based
    // usage. Parse them into the same "qoder" source so history is continuous.
    // The legacy DB block above remains as a fallback for pre-migration rows.
    if (sourceAllowed("qoder")) {
      try {
        const projectsDir = resolveQoderProjectsDir({ home, env: process.env });
        const sessionFiles = await listQoderNewSessionFiles(projectsDir);
        if (sessionFiles.length > 0) {
          if (progress?.enabled) {
            progress.start(`Parsing Qoder (new) ${renderBar(0)} | buckets 0`);
          }
          const parsed = await parseQoderNewIncremental({
            sessionFiles,
            cursors,
            queuePath,
            projectQueuePath,
            onProgress: makeProviderProgress("Qoder (new)"),
            sourceKey: "qoder",
            cursorKey: "qoderNew",
          });
          qoderResult = {
            recordsProcessed: qoderResult.recordsProcessed + (parsed.messagesProcessed || 0),
            eventsAggregated: qoderResult.eventsAggregated + (parsed.eventsAggregated || 0),
            bucketsQueued: qoderResult.bucketsQueued + (parsed.bucketsQueued || 0),
          };
        }
      } catch (err) {
        warnProviderParseFailure("Qoder (new)", err, opts);
      }
    }

    // ── Qoder CN (国内版) — same SharedClientCache/local.db schema, separate
    // Application Support/QoderCN data directory. Tracked as its own source
    // with its own cursor namespace: the two DBs each number rowids from 1, so
    // a shared cursor would mis-dedup across installs.
    let qoderCnResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("qoder-cn")) {
      const qoderCnPaths = resolveQoderCnDbPaths({
        home,
        env: process.env,
        platform: process.platform,
      });
      if (qoderCnPaths.native || qoderCnPaths.wsl) {
        if (progress?.enabled) {
          progress.start(`Parsing Qoder CN ${renderBar(0)} | buckets 0`);
        }
        try {
          const result = await multiInstallParse({
            paths: qoderCnPaths,
            parserFn: async ({ dbPath, ...rest }) => {
              const dbMessages = await readQoderDbMessages(dbPath, { label: "Qoder CN" });
              const parsed = await parseQoderDbIncremental({
                dbMessages,
                dbPath,
                sourceKey: "qoder-cn",
                cursorKey: "qoder-cn",
                ...rest,
              });
              return {
                recordsProcessed: parsed.messagesProcessed || 0,
                eventsAggregated: parsed.eventsAggregated || 0,
                bucketsQueued: parsed.bucketsQueued || 0,
              };
            },
            providerName: "qoder-cn",
            cursors,
            queuePath,
            projectQueuePath,
            getParams: (dbPath) => ({ dbPath }),
            onProgress: makeProviderProgress("Qoder CN"),
          });
          qoderCnResult = {
            recordsProcessed: result.recordsProcessed || 0,
            eventsAggregated: result.eventsAggregated || 0,
            bucketsQueued: result.bucketsQueued || 0,
          };
        } catch (err) {
          warnProviderParseFailure("Qoder CN", err, opts);
        }
      }
    }

    // Qoder CN new (JSONL) — currently shares ~/.qoder/projects with international;
    // keep distinct parsing only when CN projects dir diverges (future CN split)
    // to avoid double-counting the same JSONL under two sources.
    if (sourceAllowed("qoder-cn")) {
      try {
        const cnProjectsDir = resolveQoderCnProjectsDir({ home, env: process.env });
        const intlProjectsDir = resolveQoderProjectsDir({ home, env: process.env });
        const projectsDirKey = (p) => {
          const normalized = path.normalize(p);
          return process.platform === "win32" ? normalized.toLowerCase() : normalized;
        };
        if (projectsDirKey(cnProjectsDir) !== projectsDirKey(intlProjectsDir)) {
          const sessionFiles = await listQoderNewSessionFiles(cnProjectsDir);
          if (sessionFiles.length > 0) {
            if (progress?.enabled) {
              progress.start(`Parsing Qoder CN (new) ${renderBar(0)} | buckets 0`);
            }
            const parsed = await parseQoderNewIncremental({
              sessionFiles,
              cursors,
              queuePath,
              projectQueuePath,
              onProgress: makeProviderProgress("Qoder CN (new)"),
              sourceKey: "qoder-cn",
              cursorKey: "qoderCnNew",
            });
            qoderCnResult = {
              recordsProcessed: qoderCnResult.recordsProcessed + (parsed.messagesProcessed || 0),
              eventsAggregated: qoderCnResult.eventsAggregated + (parsed.eventsAggregated || 0),
              bucketsQueued: qoderCnResult.bucketsQueued + (parsed.bucketsQueued || 0),
            };
          }
        }
      } catch (err) {
        warnProviderParseFailure("Qoder CN (new)", err, opts);
      }
    }

    // ── Claude Science (Anthropic's local research workbench, issue #246) ──
    // Per-frame token usage lives on the `frames` table of operon-cli.db.
    // Passive, incremental, subtract-on-change. There can be more than one DB:
    // multi-org installs keep one per org, and on Windows the app runs inside
    // WSL so the DB is on the distro home.
    let claudeScienceResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("claude-science")) {
      // Resolution is inside the error isolation too: it touches the filesystem
      // and (on Windows) probes WSL, and a throw here would abort cmdSync before
      // any provider's buckets are written, not just this one's.
      let claudeScienceDbPaths = [];
      try {
        claudeScienceDbPaths = resolveClaudeScienceDbPaths({ home, env: process.env });
      } catch (err) {
        warnProviderParseFailure("Claude Science", err, opts);
      }
      if (claudeScienceDbPaths.length > 0 && progress?.enabled) {
        progress.start(`Parsing Claude Science ${renderBar(0)} | buckets 0`);
      }
      for (const claudeScienceDbPath of claudeScienceDbPaths) {
        try {
          const dbRows = await readClaudeScienceFrames(claudeScienceDbPath);
          const parsed = await parseClaudeScienceIncremental({
            dbRows,
            cursors,
            queuePath,
            onProgress: makeProviderProgress("Claude Science"),
          });
          claudeScienceResult = mergeParseResult(claudeScienceResult, {
            recordsProcessed: parsed.recordsProcessed || 0,
            eventsAggregated: parsed.eventsAggregated || 0,
            bucketsQueued: parsed.bucketsQueued || 0,
          });
        } catch (err) {
          warnProviderParseFailure("Claude Science", err, opts);
        }
      }
    }

    async function parseOpencodeDbForInstall({ dbPath, readFn, source, cursorKey, ...rest }) {
      if (!dbPath || !fssync.existsSync(dbPath)) {
        return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
      }
      const dbMessages = readFn(dbPath);
      if (dbMessages.length === 0) return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
      const result = await parseOpencodeDbIncremental({ dbMessages, dbPath, source, cursorKey, ...rest });
      return {
        recordsProcessed: result.messagesProcessed || 0,
        eventsAggregated: result.eventsAggregated || 0,
        bucketsQueued: result.bucketsQueued || 0,
      };
    }

    // ── Kilo CLI (kilo.ai @kilocode/plugin — OpenCode-fork SQLite) ──
    let kiloResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("kilo-cli")) {
      const kiloNativeValue = process.platform === "win32" && typeof process.env.APPDATA === "string"
        ? path.join(process.env.APPDATA.trim(), "kilo", "kilo.db")
        : path.join(kiloHome, "kilo.db");
      const wslKiloDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
        ? wsl.discoverWslHome(".local/share/kilo")
        : null;
      const kiloPaths = resolveInstallPaths({ nativeValue: kiloNativeValue, wslValue: wslKiloDir ? path.join(wslKiloDir, "kilo.db") : null });
      if (kiloPaths.native || kiloPaths.wsl) {
        if (progress?.enabled) progress.start(`Parsing Kilo CLI ${renderBar(0)} | buckets 0`);
        try {
          kiloResult = await multiInstallParse({
            paths: kiloPaths, parserFn: parseOpencodeDbForInstall, providerName: "kiloCli",
            cursors, getParams: (p) => ({ dbPath: p, readFn: readOpencodeDbMessages, source: "kilo-cli", cursorKey: "kiloCli" }),
            queuePath, projectQueuePath, onProgress: makeProviderProgress("Kilo CLI"),
          });
        } catch (err) { warnProviderParseFailure("Kilo CLI", err, opts); }
      }
    }

    // ── Mimo (mimocode — OpenCode-fork SQLite) ──
    // readMimoDbMessages filters out mirrored Claude Code rows to avoid
    // double-counting usage already counted as source=claude.
    let mimoResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("mimo")) {
      const mimoNativeValue = process.platform === "win32" && typeof process.env.APPDATA === "string"
        ? path.join(process.env.APPDATA.trim(), "mimocode", "mimocode.db")
        : path.join(mimoHome, "mimocode.db");
      const wslMimoDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
        ? wsl.discoverWslHome(".local/share/mimocode")
        : null;
      const mimoPaths = resolveInstallPaths({ nativeValue: mimoNativeValue, wslValue: wslMimoDir ? path.join(wslMimoDir, "mimocode.db") : null });
      if (mimoPaths.native || mimoPaths.wsl) {
        if (progress?.enabled) progress.start(`Parsing Mimo ${renderBar(0)} | buckets 0`);
        try {
          mimoResult = await multiInstallParse({
            paths: mimoPaths, parserFn: parseOpencodeDbForInstall, providerName: "mimo",
            cursors, getParams: (p) => ({ dbPath: p, readFn: readMimoDbMessages, source: "mimo", cursorKey: "mimo" }),
            queuePath, projectQueuePath, onProgress: makeProviderProgress("Mimo"),
          });
        } catch (err) { warnProviderParseFailure("Mimo", err, opts); }
      }
    }

    // ── ZCode (Z.ai's coding agent — OpenCode-fork SQLite) ──
    let zcodeResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("zcode")) {
      const zcodeNativeValue = resolveZcodeNativeDbPath({ home });
      const wslZcodeDir = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
        ? wsl.discoverWslHome(".zcode")
        : null;
      const zcodePaths = resolveInstallPaths({ nativeValue: zcodeNativeValue, wslValue: wslZcodeDir ? path.join(wslZcodeDir, "cli", "db", "db.sqlite") : null });
      if (zcodePaths.native || zcodePaths.wsl) {
        if (progress?.enabled) progress.start(`Parsing ZCode ${renderBar(0)} | buckets 0`);
        try {
          const nativeUsageAvailable = [zcodePaths.native, zcodePaths.wsl]
            .filter(Boolean)
            .some((dbPath) => hasZcodeNativeUsageSchema(dbPath));
          if (nativeUsageAvailable) {
            await repairZcodeNativeUsageMigration({
              cursors,
              queuePath,
              queueStatePath,
              projectQueuePath,
              projectQueueStatePath,
            });
          }
          await repairZcodeInclusiveTokenMigration({
            cursors,
            queuePath,
            queueStatePath,
            projectQueuePath,
            projectQueueStatePath,
          });
          zcodeResult = await multiInstallParse({
            paths: zcodePaths, parserFn: parseOpencodeDbForInstall, providerName: "zcode",
            cursors, getParams: (p) => ({ dbPath: p, readFn: readZcodeDbMessages, source: "zcode", cursorKey: "zcode" }),
            queuePath, projectQueuePath, onProgress: makeProviderProgress("ZCode"),
          });
        } catch (err) { warnProviderParseFailure("ZCode", err, opts); }
      }
    }

    function makeProviderProgress(label) {
      return (p) => {
        if (!progress?.enabled) return;
        const pct = p.total > 0 ? p.index / p.total : 1;
        progress.update(
          `Parsing ${label} ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} records | buckets ${formatNumber(p.bucketsQueued)}`,
        );
      };
    }

    // ── DeepSeek Harness — passive read of ~/.dsh/sessions session logs ──
    let dshResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("dsh")) {
      await migrateLegacyDeepseekHarnessSource({ cursors, queuePath, queueStatePath });
      const dshSessionFiles = await resolveDshSessionFiles(process.env);
      if (dshSessionFiles.length > 0) {
        if (progress?.enabled) {
          progress.start(
            `Parsing DeepSeek Harness ${renderBar(0)} 0/${formatNumber(
              dshSessionFiles.length,
            )} sessions | buckets 0`,
          );
        }
        try {
          dshResult = await parseDshIncremental({
            sessionFiles: dshSessionFiles,
            cursors,
            queuePath,
            onProgress: makeProviderProgress("DeepSeek Harness"),
          });
        } catch (err) {
          warnProviderParseFailure("DeepSeek Harness", err, opts);
        }
      }
    }

    // ── LM Studio and Unsloth Studio — passive inference usage ──
    let lmstudioResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("lmstudio")) {
      const lmstudioLogFiles = await resolveLmstudioLogFiles(process.env);
      if (lmstudioLogFiles.length > 0) {
        if (progress?.enabled) {
          progress.start(
            `Parsing LM Studio ${renderBar(0)} 0/${formatNumber(lmstudioLogFiles.length)} logs | buckets 0`,
          );
        }
        try {
          lmstudioResult = await parseLmstudioIncremental({
            logFiles: lmstudioLogFiles,
            cursors,
            queuePath,
            onProgress: makeProviderProgress("LM Studio"),
          });
        } catch (err) {
          warnProviderParseFailure("LM Studio", err, opts);
        }
      }
    }

    let unslothResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("unsloth")) {
      const unslothDbPath = resolveUnslothDbPath(process.env);
      if (unslothDbPath && fssync.existsSync(unslothDbPath)) {
        if (progress?.enabled) progress.start(`Parsing Unsloth ${renderBar(0)} | buckets 0`);
        try {
          unslothResult = await parseUnslothIncremental({
            dbPath: unslothDbPath,
            cursors,
            queuePath,
            onProgress: makeProviderProgress("Unsloth"),
          });
        } catch (err) {
          warnProviderParseFailure("Unsloth", err, opts);
        }
      }
    }

    // ── AnythingLLM Desktop (workspace_chats.response.metrics) ──
    let anythingllmResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("anythingllm")) {
      const anythingllmDbPath = resolveAnythingllmDbPath(process.env);
      if (anythingllmDbPath && fssync.existsSync(anythingllmDbPath)) {
        if (progress?.enabled) progress.start(`Parsing AnythingLLM ${renderBar(0)} | buckets 0`);
        try {
          anythingllmResult = await parseAnythingllmIncremental({
            dbPath: anythingllmDbPath,
            cursors,
            queuePath,
            onProgress: makeProviderProgress("AnythingLLM"),
          });
        } catch (err) {
          warnProviderParseFailure("AnythingLLM", err, opts);
        }
      }
    }

    // ── Kilo Code VS Code extension (Cline-style ui_messages.json) ──
    const kilocodeTaskFiles = sourceAllowed("kilocode")
      ? mergeBothFileSources({ resolveFiles: resolveKilocodeTaskFiles, env: process.env })
      : [];
    let kilocodeResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (kilocodeTaskFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Kilo Code ${renderBar(0)} 0/${formatNumber(kilocodeTaskFiles.length)} tasks | buckets 0`,
        );
      }
      try {
        kilocodeResult = await parseKilocodeIncremental({
          taskFiles: kilocodeTaskFiles,
          cursors,
          queuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Kilo Code ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} tasks | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Kilo Code", err, opts);
      }
    }

    // ── Goose (Block) — SQLite sessions with cumulative tokens per session ──
    const gooseDbPath = resolveGooseDbPath(process.env);
    let gooseResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("goose")) {
      const gooseMode = wsl.getWslMode(process.env);
      if (gooseMode === "both" && process.platform === "win32") {
        const home = os.homedir();
        const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        const nativeDb = path.join(appData, "goose", "sessions", "sessions.db");
        const wslDir = wsl.shouldProbeWsl(process.env) ? wsl.discoverWslHome(".local/share/goose/sessions") : null;
        const wslDb = wslDir ? path.join(wslDir, "sessions.db") : null;
        const goosePaths = resolveInstallPaths({ nativeValue: nativeDb, wslValue: wslDb });
        if (goosePaths.native || goosePaths.wsl) {
          if (progress?.enabled) progress.start(`Parsing Goose ${renderBar(0)} 0 sessions | buckets 0`);
          try {
            gooseResult = await multiInstallParse({
              paths: goosePaths, parserFn: parseGooseIncremental, providerName: "goose",
              cursors, getParams: (p) => ({ dbPath: p }), queuePath, onProgress: gooseOnProgress,
              detectInstall: gooseInstallOwnsCursor,
            });
          } catch (err) { warnProviderParseFailure("Goose", err, opts); }
        }
      } else if (gooseDbPath && fssync.existsSync(gooseDbPath)) {
        if (progress?.enabled) progress.start(`Parsing Goose ${renderBar(0)} 0 sessions | buckets 0`);
        ensureFlatCursor(cursors, "goose", process.env);
        try {
          gooseResult = await parseGooseIncremental({
            dbPath: gooseDbPath, cursors, queuePath, onProgress: gooseOnProgress,
          });
        } catch (err) { warnProviderParseFailure("Goose", err, opts); }
      }
    }

    // ── Droid (Factory CLI) — passive reader for ~/.factory/sessions/*.settings.json ──
    const droidSettingsFiles = sourceAllowed("droid")
      ? mergeBothFileSources({ resolveFiles: listDroidSettingsFiles, env: process.env })
      : [];
    let droidResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (droidSettingsFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Droid ${renderBar(0)} 0/${formatNumber(droidSettingsFiles.length)} sessions | buckets 0`,
        );
      }
      try {
        droidResult = await parseDroidIncremental({
          settingsFiles: droidSettingsFiles,
          cursors,
          queuePath,
          projectQueuePath,
          // Full-scan sync: drop cursor entries for any session whose
          // settings.json has disappeared off disk so cursors.droid stays
          // bounded by the actual on-disk session count.
          prune: true,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Droid ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Droid", err, opts);
      }
    }

    // ── Zed Agent (all providers; cumulative-delta over SQLite threads) ──
    const zedDbPath = resolveZedDbPath(process.env);
    let zedResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("zed")) {
      const zedMode = wsl.getWslMode(process.env);
      if (zedMode === "both" && process.platform === "win32") {
        const home = os.homedir();
        const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        const nativeDb = path.join(local, "Zed", "threads", "threads.db");
        const wslThreadsDir = wsl.shouldProbeWsl(process.env) ? wsl.discoverWslHome(".local/share/zed/threads") : null;
        const wslDb = wslThreadsDir ? path.join(wslThreadsDir, "threads.db") : null;
        const zedPaths = resolveInstallPaths({ nativeValue: nativeDb, wslValue: wslDb });
        if (zedPaths.native || zedPaths.wsl) {
          if (progress?.enabled) progress.start(`Parsing Zed Agent ${renderBar(0)} 0 threads | buckets 0`);
          try {
            zedResult = await multiInstallParse({
              paths: zedPaths, parserFn: parseZedIncremental, providerName: "zed",
              cursors, getParams: (p) => ({ dbPath: p }), queuePath, onProgress: zedOnProgress,
              detectInstall: zedInstallOwnsCursor,
            });
          } catch (err) { warnProviderParseFailure("Zed Agent", err, opts); }
        }
      } else if (zedDbPath && fssync.existsSync(zedDbPath)) {
        if (progress?.enabled) progress.start(`Parsing Zed Agent ${renderBar(0)} 0 threads | buckets 0`);
        ensureFlatCursor(cursors, "zed", process.env);
        try {
          zedResult = await parseZedIncremental({
            dbPath: zedDbPath, cursors, queuePath, onProgress: zedOnProgress,
          });
        } catch (err) { warnProviderParseFailure("Zed Agent", err, opts); }
      }
    }

    // ── Roo Code VS Code extension (Cline-derived; rooveterinaryinc.roo-cline) ──
    const roocodeTaskFiles = sourceAllowed("roocode") ? resolveRoocodeTaskFiles(process.env) : [];
    let roocodeResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (roocodeTaskFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(
          `Parsing Roo Code ${renderBar(0)} 0/${formatNumber(roocodeTaskFiles.length)} tasks | buckets 0`,
        );
      }
      try {
        roocodeResult = await parseRoocodeIncremental({
          taskFiles: roocodeTaskFiles,
          cursors,
          queuePath,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Roo Code ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                p.total,
              )} tasks | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Roo Code", err, opts);
      }
    }

    // ── Cursor (API-based) ──
    // One-time migration: earlier CLI versions mis-parsed the Cursor CSV after
    // Cursor inserted new "Cloud Agent ID"/"Automation ID" columns, writing
    // cursor records under model="unknown". Purge those local buckets, emit
    // zero retractions so the cloud upserts overwrite them to zero, and reset
    // the incremental cursor so the fixed parser re-fetches all affected rows.
    if (isFullSourceScan) {
      await migrateCursorUnknownBuckets({ cursors, queuePath });
    }

    let cursorResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const cursorInstalled = cursorSyncDeps.isInstalled || isCursorInstalled;
    const cursorAuthExtractor = cursorSyncDeps.extractAuth || extractCursorSessionToken;
    const cursorUsageFetcher = cursorSyncDeps.fetchUsageCsv || fetchCursorUsageCsv;
    if (sourceAllowed("cursor") && cursorInstalled({ home })) {
      const cursorAuth = cursorAuthExtractor({ home });
      if (cursorAuth) {
        try {
          if (progress?.enabled) {
            progress.start(`Fetching Cursor usage...`);
          }
          const csvText = await cursorUsageFetcher({ cookie: cursorAuth.cookie });
          const records = parseCursorCsv(csvText);
          if (records.length > 0) {
            if (progress?.enabled) {
              progress.start(
                `Parsing Cursor ${renderBar(0)} 0/${formatNumber(records.length)} records | buckets 0`,
              );
            }
            cursorResult = await parseCursorApiIncremental({
              records,
              cursors,
              queuePath,
              onProgress: (p) => {
                if (!progress?.enabled) return;
                const pct = p.total > 0 ? p.index / p.total : 1;
                progress.update(
                  `Parsing Cursor ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(
                    p.total,
                  )} records | buckets ${formatNumber(p.bucketsQueued)}`,
                );
              },
              source: "cursor",
            });
          }
        } catch (err) {
          if (!opts.auto) {
            process.stderr.write(`Cursor sync: ${err.message}\n`);
          }
        }
      }
    }

    // ── Trae Work CN (国内版) — account-level usage API ──
    // A simple explicit rolling 30-day window captured once per sync (no
    // cursor checkpoints / full-history import / page retries / background
    // requests). Runs only when the user has opted in via
    // TOKENTRACKER_TRAE_CN_USAGE=1 (the read transmits the locally stored
    // sign-in JWT to TRAE's official endpoint, so it is never default-on),
    // the sync is non-lightweight, the source is allowed, and the CN storage
    // file exists — which excludes both ordinary background and `--auto
    // --background --all-local-sources`. Fetching goes through the
    // storage-backed helper so its single 401/403 reread/retry is used; an
    // empty response is a successful no-op; each window is bounded to 100
    // pages/2,000 rows and an over-capacity window is split into staggered
    // sub-windows (still over capacity at the finest allowed granularity, or
    // any other fetch/page/schema/auth failure) skips the parser and leaves
    // prior data untouched while unrelated providers continue.
    let traeCnResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (
      !isBackgroundLightweightSync &&
      isTraeCnUsageEnabled(process.env) &&
      sourceAllowed("trae-cn")
    ) {
      const nowMs = Number.isFinite(traeCnNowMs) ? traeCnNowMs : Date.now();
      const fetchImpl = typeof traeCnFetchImpl === "function" ? traeCnFetchImpl : fetch;
      const endTime = Math.floor(nowMs / 1000);
      // Align the REAL fetch start down to a half-hour boundary so the API
      // range fully contains every bucket it can touch (a raw 08:37 start
      // would only partially cover the 08:30 bucket) - session bucket floors
      // never straddle the queried range.
      const HALF_HOUR_SEC = 30 * 60;
      const startTime = Math.max(
        1,
        Math.floor((endTime - 30 * 24 * 60 * 60) / HALF_HOUR_SEC) * HALF_HOUR_SEC,
      );
      try {
        // Absent storage means "not signed in" — a silent skip, not an error.
        const traeCnStoragePath = resolveTraeCnStoragePath({ env: process.env, home });
        if (traeCnStoragePath && fssync.existsSync(traeCnStoragePath)) {
          if (progress?.enabled) {
            progress.start(`Fetching TRAE Work CN usage...`);
          }
          const traeCnUsage = await fetchTraeCnUsageWithAuth({
            start_time: startTime,
            end_time: endTime,
            fetchImpl,
            env: process.env,
            home,
          });
          const traeCnSessions = Array.isArray(traeCnUsage?.sessions) ? traeCnUsage.sessions : [];
          // An empty payload parses as a pure no-op: the TRAE absence
          // contract is NOT PROVEN (no evidence that a missing session means
          // deleted/zero), so an empty response asserts nothing - no usage
          // mutation and no session states. Non-empty snapshots append one
          // canonical session-state observation per CHANGED session (the
          // cloud LWW upsert reconciles cross-device versions).
          {
            if (progress?.enabled && traeCnSessions.length > 0) {
              progress.start(
                `Parsing TRAE Work CN ${renderBar(0)} 0/${formatNumber(
                  traeCnSessions.length,
                )} records | buckets 0`,
              );
            }
            traeCnResult = await parseTraeCnApiIncremental({
              sessions: traeCnSessions,
              cursors,
              queuePath,
              onProgress: makeProviderProgress("TRAE Work CN"),
              windowStartMs: startTime * 1000,
              windowEndMs: endTime * 1000,
              // The LOGICAL fetch stamp carried into every session state's
              // snapshot_verified_at: the same clock that produced the query
              // range, not the later enqueue moment (append-only queue
              // replays it verbatim, so transport retries never fake
              // freshness).
              snapshotVerifiedAtMs: nowMs,
            });
            // A partially malformed snapshot throws inside the parser (fail
            // closed - it must not become the authoritative window state);
            // warnProviderParseFailure below reports it without sensitive
            // data while unrelated providers continue.
          }
        }
      } catch (err) {
        warnProviderParseFailure("TRAE Work CN", err, opts);
      }
    }

    // ── Kiro (SQLite-based, with JSONL fallback; dual-install aware) ──
    let kiroResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("kiro")) {
      const kiroNativeBase = resolveKiroBasePath(process.env);
      const wslKiroBase = process.platform === "win32" && wsl.shouldProbeWsl(process.env)
        ? wsl.discoverWslHome(".config/Kiro/User/globalStorage/kiro.kiroagent")
        : null;
      const kiroPaths = resolveInstallPaths({ nativeValue: kiroNativeBase, wslValue: wslKiroBase });
      // resolveInstallPaths only checks the base dir (and skips the check off
      // win32); keep the original per-install db/jsonl presence gate so empty
      // installs never spin up a parse or seed a cursor namespace.
      const kiroHasData = (base) => Boolean(base)
        && (fssync.existsSync(resolveKiroDbPath(base)) || fssync.existsSync(resolveKiroJsonlPath(base)));
      if (!kiroHasData(kiroPaths.native)) kiroPaths.native = null;
      if (!kiroHasData(kiroPaths.wsl)) kiroPaths.wsl = null;
      if (kiroPaths.native || kiroPaths.wsl) {
        if (progress?.enabled) {
          progress.start(`Parsing Kiro ${renderBar(0)} | buckets 0`);
        }
        try {
          kiroResult = await multiInstallParse({
            paths: kiroPaths,
            parserFn: parseKiroIncremental,
            providerName: "kiro",
            cursors,
            getParams: (base) => ({
              basePath: base,
              dbPath: resolveKiroDbPath(base),
              jsonlPath: resolveKiroJsonlPath(base),
            }),
            queuePath,
            onProgress: makeProviderProgress("Kiro"),
            detectInstall: (base, flatState) =>
              kiroInstallOwnsCursor(resolveKiroDbPath(base), flatState),
          });
        } catch (err) {
          warnProviderParseFailure("Kiro", err, opts);
        }
      }
    }

    // ── Hermes Agent (SQLite-based) ──
    let hermesResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("hermes")) {
      const override = process.env.TOKENTRACKER_HERMES_HOME;
      const overridePath = typeof override === "string" && override.trim().length > 0 ? override.trim() : null;
      if (overridePath) {
        if (fssync.existsSync(overridePath)) {
          if (progress?.enabled) {
            progress.start(`Parsing Hermes ${renderBar(0)} | buckets 0`);
          }
          ensureFlatCursor(cursors, "hermes", process.env);
          try {
            hermesResult = await parseHermesIncremental({
              hermesPath: overridePath,
              cursors,
              queuePath,
              onProgress: hermesOnProgress,
            });
          } catch (err) {
            warnProviderParseFailure("Hermes", err, opts);
          }
        }
      } else {
        const home = os.homedir();
        const defaultPath = path.join(home, ".hermes");
        const nativeValue = process.platform === "win32" && typeof process.env.LOCALAPPDATA === "string"
          ? path.join(process.env.LOCALAPPDATA.trim(), "hermes") : defaultPath;
        const hermesPaths = resolveInstallPaths({ nativeValue, wslDir: ".hermes" });
        if (hermesPaths.native || hermesPaths.wsl) {
          if (progress?.enabled) {
            progress.start(`Parsing Hermes ${renderBar(0)} | buckets 0`);
          }
          try {
            hermesResult = await multiInstallParse({
              paths: hermesPaths,
              parserFn: parseHermesIncremental,
              providerName: "hermes",
              cursors,
              getParams: (path) => ({ hermesPath: path }),
              queuePath,
              onProgress: hermesOnProgress,
              detectInstall: hermesInstallOwnsCursor,
            });
          } catch (err) {
            warnProviderParseFailure("Hermes", err, opts);
          }
        }
      }
    }

    function hermesOnProgress(p) {
      if (!progress?.enabled) return;
      const pct = p.total > 0 ? p.index / p.total : 1;
      progress.update(
        `Parsing Hermes ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
      );
    }

    function gooseOnProgress(p) {
      if (!progress?.enabled) return;
      const pct = p.total > 0 ? p.index / p.total : 1;
      progress.update(
        `Parsing Goose ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
      );
    }

    function zedOnProgress(p) {
      if (!progress?.enabled) return;
      const pct = p.total > 0 ? p.index / p.total : 1;
      progress.update(
        `Parsing Zed Agent ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} threads | buckets ${formatNumber(p.bucketsQueued)}`,
      );
    }

    // ── Kiro CLI (reads ~/Library/Application Support/kiro-cli/data.sqlite3,
    //    legacy ~/.kiro/sessions/cli/{uuid}.json, and Kiro CLI 2.13+
    //    ~/.kiro/sessions/{workspace}/sess_{uuid}/messages.jsonl) ──
    // Runs IN PARALLEL with the Kiro IDE branch above — NOT instead of it.
    // Both emit source='kiro' so totals merge transparently; cursor state
    // is isolated in cursors.kiroCli. Kiro CLI does not persist explicit
    // token counts (billing is credit-based on Bedrock); we approximate at
    // 4 chars/token from user prompt chars and assistant response chars.
    let kiroCliResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (sourceAllowed("kiro")) {
      const kiroCliDb = resolveKiroCliDbPath(process.env);
      const kiroCliSessionFiles = resolveKiroCliSessionFiles(process.env);
      const nativeCliPresent = fssync.existsSync(kiroCliDb) || kiroCliSessionFiles.length > 0;

      // Explicit overrides pin a single install — never mix them with WSL
      // auto-discovery (mirrors the Hermes TOKENTRACKER_HERMES_HOME branch).
      const kiroCliOverride = Boolean(process.env.KIRO_CLI_DB_PATH || process.env.KIRO_HOME);
      let wslKiroCliEnv = null;
      let wslKiroCliMarker = null;
      if (!kiroCliOverride && process.platform === "win32" && wsl.shouldProbeWsl(process.env)) {
        // A WSL install owns BOTH a data dir (~/.local/share/kiro-cli) and a
        // sessions home (~/.kiro). Derive both from whichever probe hits so
        // the per-install env never falls back to native paths.
        const wslKiroHomeDir = wsl.discoverWslHome(".kiro");
        const wslCliDataDir = wsl.discoverWslHome(".local/share/kiro-cli");
        const wslHomeRoot = wslKiroHomeDir
          ? path.dirname(wslKiroHomeDir)
          : (wslCliDataDir ? path.dirname(path.dirname(path.dirname(wslCliDataDir))) : null);
        if (wslHomeRoot) {
          const wslCliDb = path.join(wslHomeRoot, ".local", "share", "kiro-cli", "data.sqlite3");
          wslKiroCliEnv = {
            ...process.env,
            KIRO_CLI_DB_PATH: wslCliDb,
            KIRO_HOME: path.join(wslHomeRoot, ".kiro"),
          };
          const wslCliPresent = fssync.existsSync(wslCliDb)
            || resolveKiroCliSessionFiles(wslKiroCliEnv).length > 0;
          if (wslCliPresent) wslKiroCliMarker = wslCliDb;
        }
      }

      // Paths here are install markers only — the parser resolves its DB and
      // session files from the per-install env (KIRO_CLI_DB_PATH/KIRO_HOME).
      const kiroCliPaths = process.platform === "win32"
        ? wsl.resolveAllWin32Paths({
          nativeValue: nativeCliPresent ? kiroCliDb : null,
          wslValue: wslKiroCliMarker,
          env: process.env,
          platform: "win32",
        })
        : { native: nativeCliPresent ? kiroCliDb : null, wsl: null };
      const kiroCliEnvFor = (p) =>
        wslKiroCliEnv && p === wslKiroCliMarker ? wslKiroCliEnv : process.env;
      if (kiroCliPaths.native || kiroCliPaths.wsl) {
        if (progress?.enabled) {
          progress.start(`Parsing Kiro CLI ${renderBar(0)} | buckets 0`);
        }
        try {
          kiroCliResult = await multiInstallParse({
            paths: kiroCliPaths,
            parserFn: parseKiroCliIncremental,
            providerName: "kiroCli",
            cursors,
            // Per-install env MUST come from getParams: multiInstallParse
            // spreads shared params over it, so a top-level env would clobber
            // the per-install one.
            getParams: (p) => ({ env: kiroCliEnvFor(p) }),
            queuePath,
            onProgress: (p) => {
              if (!progress?.enabled) return;
              const pct = p.total > 0 ? p.index / p.total : 1;
              progress.update(
                `Parsing Kiro CLI ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
              );
            },
            detectInstall: (p, flatState) =>
              kiroCliInstallOwnsCursor(kiroCliEnvFor(p).KIRO_CLI_DB_PATH || kiroCliDb, flatState),
          });
        } catch (err) {
          if (!opts.auto) {
            process.stderr.write(`Kiro CLI sync: ${err.message}\n`);
          }
        }
      }
    }

    // ── Kimi (passive wire.jsonl reader) ──
    let kimiResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const kimiWireFiles = sourceAllowed("kimi")
      ? mergeBothFileSources({ resolveFiles: resolveKimiWireFiles, env: process.env })
      : [];
    if (kimiWireFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Kimi Code ${renderBar(0)} | buckets 0`);
      }
      try {
        kimiResult = await parseKimiIncremental({
          wireFiles: kimiWireFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Kimi Code ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Kimi Code", err, opts);
      }
    }

    // ── Kimi Code official (@moonshot-ai/kimi-code, ~/.kimi-code) ──
    let kimiCodeResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const kimiCodeWireFiles = sourceAllowed("kimi-code")
      ? mergeBothFileSources({ resolveFiles: resolveKimiCodeWireFiles, env: process.env })
      : [];
    if (kimiCodeWireFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Kimi Code (official) ${renderBar(0)} | buckets 0`);
      }
      try {
        kimiCodeResult = await parseKimiCodeIncremental({
          wireFiles: kimiCodeWireFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Kimi Code (official) ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Kimi Code (official)", err, opts);
      }
    }

    // ── CodeBuddy CLI (passive ~/.codebuddy/projects/**/*.jsonl reader) ──
    // Tencent's CodeBuddy CLI is a Claude Code clone; no hook system, so we
    // tail the per-session JSONL conversation logs incrementally on each sync.
    let codebuddyResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    if (isFullSourceScan && sourceAllowed("codebuddy")) {
      const repairCodebuddyFiles = mergeBothFileSources({
        resolveFiles: (env) => resolveCodebuddyProjectFiles({
          ...env,
          TOKENTRACKER_CODEBUDDY_LOG_FALLBACK: "1",
        }),
        env: process.env,
      });
      try {
        await repairCodebuddyLogJsonlOverlap({
          cursors,
          queuePath,
          queueStatePath,
          codebuddyFiles: repairCodebuddyFiles,
          env: process.env,
        });
      } catch (err) {
        warnProviderParseFailure("CodeBuddy log/JSONL repair", err, opts);
      }
    }
    const codebuddyFiles = sourceAllowed("codebuddy")
      ? mergeBothFileSources({ resolveFiles: resolveCodebuddyProjectFiles, env: process.env })
      : [];
    if (codebuddyFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing CodeBuddy ${renderBar(0)} | buckets 0`);
      }
      try {
        codebuddyResult = await parseCodebuddyIncremental({
          projectFiles: codebuddyFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing CodeBuddy ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("CodeBuddy", err, opts);
      }
    }

    // ── WorkBuddy (passive ~/.workbuddy/projects/**/*.jsonl reader) ──
    // Tencent's WorkBuddy is a Claude Code fork in the same family as CodeBuddy;
    // usage rides on function_call records too (not only assistant messages) and
    // sub-agent logs nest one level deeper, so the resolver recurses. See the
    // parser comment in rollout.js for the cache-aware token math.
    let workbuddyResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const workbuddyFiles = sourceAllowed("workbuddy")
      ? mergeBothFileSources({ resolveFiles: resolveWorkbuddyProjectFiles, env: process.env })
      : [];
    if (sourceAllowed("workbuddy")) {
      if (isFullSourceScan) {
        try {
          await repairWorkbuddyContextUsage({
            cursors,
            queuePath,
            queueStatePath,
            workbuddyFiles,
            env: process.env,
          });
        } catch (err) {
          warnProviderParseFailure("WorkBuddy context-usage repair", err, opts);
        }
      }
      if (progress?.enabled) {
        progress.start(`Parsing WorkBuddy ${renderBar(0)} | buckets 0`);
      }
      try {
        workbuddyResult = await parseWorkbuddyIncremental({
          projectFiles: workbuddyFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing WorkBuddy ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("WorkBuddy", err, opts);
      }
    }

    // ── oh-my-pi (passive ~/.omp/agent/sessions/**/*.jsonl reader) ──
    // Task-subagent transcripts (nested below the cwd level) are scanned too,
    // so their usage counts toward the omp totals.
    let ompResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const ompFiles = sourceAllowed("omp")
      ? mergeBothFileSources({ resolveFiles: resolveOmpSessionFiles, env: process.env })
      : [];
    const ompSubagentFiles = sourceAllowed("omp")
      ? mergeBothFileSources({ resolveFiles: resolveOmpSubagentFiles, env: process.env })
      : [];
    if (ompFiles.length > 0 || ompSubagentFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing oh-my-pi ${renderBar(0)} | buckets 0`);
      }
      try {
        ompResult = await parseOmpIncremental({
          sessionFiles: ompFiles,
          subagentFiles: ompSubagentFiles,
          cursors,
          queuePath,
          projectQueuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing oh-my-pi ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("oh-my-pi", err, opts);
      }
    }

    // ── pi (@mariozechner/pi-coding-agent) — passive ~/.pi/agent/sessions/**/*.jsonl reader ──
    // Skip pi parse if its agent dir resolves to the same path as omp's. This
    // prevents double-counting when explicit overrides (TOKENTRACKER_OMP_AGENT_DIR /
    // TOKENTRACKER_PI_AGENT_DIR) bypass the install-signal disambiguator.
    let piResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const piFiles = !sourceAllowed("pi") || piAgentDirCollidesWithOmp(process.env)
      ? []
      : mergeBothFileSources({ resolveFiles: resolvePiSessionFiles, env: process.env });
    if (piFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing pi ${renderBar(0)} | buckets 0`);
      }
      try {
        piResult = await parsePiIncremental({
          sessionFiles: piFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing pi ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("pi", err, opts);
      }
    }

    // ── Prime Agent — passive ~/.prime/agent/sessions/*.jsonl usage reader ──
    let primeAgentResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const primeAgentFiles = sourceAllowed("prime-agent")
      ? mergeBothFileSources({ resolveFiles: resolvePrimeAgentSessionFiles, env: process.env })
      : [];
    if (primeAgentFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Prime Agent ${renderBar(0)} | buckets 0`);
      }
      try {
        primeAgentResult = await parsePrimeAgentIncremental({
          sessionFiles: primeAgentFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Prime Agent ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Prime Agent", err, opts);
      }
    }

    // ── Craft Agents (passive ~/.craft-agent + workspaces session.jsonl reader) ──
    let craftResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const craftFiles = sourceAllowed("craft")
      ? mergeBothFileSources({ resolveFiles: resolveCraftSessionFiles, env: process.env })
      : [];
    if (craftFiles.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Craft ${renderBar(0)} | buckets 0`);
      }
      try {
        craftResult = await parseCraftIncremental({
          sessionFiles: craftFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Craft ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Craft", err, opts);
      }
    }

    // Reasonix — content-free cumulative telemetry sidecars only.
    let reasonixResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const reasonixFiles = sourceAllowed("reasonix")
      ? mergeBothFileSources({ resolveFiles: resolveReasonixTelemetryFiles, env: process.env })
      : [];
    if (reasonixFiles.length > 0) {
      try {
        reasonixResult = await parseReasonixIncremental({
          telemetryFiles: reasonixFiles,
          cursors,
          queuePath,
          env: process.env,
          onProgress: makeProviderProgress("Reasonix"),
        });
      } catch (err) {
        warnProviderParseFailure("Reasonix", err, opts);
      }
    }

    // ── Grok Build (xAI) ──
    let grokResult = {
      recordsProcessed: 0,
      eventsAggregated: 0,
      bucketsQueued: 0,
      projectBucketsQueued: 0,
    };
    // Full passive scan of all Grok sessions (historical + any not covered by hook)
    const grokSessions = sourceAllowed("grok") ? resolveGrokBuildSessions(process.env) : [];
    const grokSessionInputs = [...grokSessions];
    if (sourceAllowed("grok") && grokHookSignal && typeof grokHookSignal === "object") {
      const hookSessionId =
        typeof grokHookSignal.sessionId === "string" && grokHookSignal.sessionId.trim()
          ? grokHookSignal.sessionId.trim()
          : null;
      if (hookSessionId) {
        const hookContextTokens =
          grokHookSignal.contextTokensUsed != null
            ? grokHookSignal.contextTokensUsed
            : grokHookSignal.totalTokens;
        const hookTotalTokens =
          grokHookSignal.totalTokens != null
            ? grokHookSignal.totalTokens
            : hookContextTokens;
        grokSessionInputs.unshift({
          sessionId: hookSessionId,
          sessionDir:
            typeof grokHookSignal.sessionDir === "string" ? grokHookSignal.sessionDir : undefined,
          cwd: typeof grokHookSignal.cwd === "string" ? grokHookSignal.cwd : undefined,
          encodedCwd:
            typeof grokHookSignal.sessionDir === "string" && grokHookSignal.sessionDir
              ? path.basename(path.dirname(grokHookSignal.sessionDir))
              : undefined,
          updatesPath:
            typeof grokHookSignal.updatesPath === "string" ? grokHookSignal.updatesPath : undefined,
          signalsPath:
            typeof grokHookSignal.signalsPath === "string" ? grokHookSignal.signalsPath : undefined,
          summaryPath:
            typeof grokHookSignal.summaryPath === "string" ? grokHookSignal.summaryPath : undefined,
          signals: {
            contextTokensUsed: hookContextTokens,
            totalTokens: hookTotalTokens,
            totalTokensBeforeCompaction: grokHookSignal.totalTokensBeforeCompaction,
            assistantMessageCount: grokHookSignal.messageCount,
            primaryModelId: grokHookSignal.model,
            lastActiveAt: grokHookSignal.lastActive,
          },
          summary: { updated_at: grokHookSignal.lastActive },
        });
        grokHookSignalConsumed = true;
      }
    }
    if (grokSessionInputs.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Grok Build ${renderBar(0)} | buckets 0`);
      }
      let grokScanResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
      try {
        grokScanResult = await parseGrokBuildIncremental({
          sessions: grokSessionInputs,
          cursors,
          queuePath,
          projectQueuePath,
          env: process.env,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Grok Build ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
      } catch (err) {
        warnProviderParseFailure("Grok Build", err, opts);
      }
      grokResult = {
        recordsProcessed: grokResult.recordsProcessed + grokScanResult.recordsProcessed,
        eventsAggregated: grokResult.eventsAggregated + grokScanResult.eventsAggregated,
        bucketsQueued: grokResult.bucketsQueued + grokScanResult.bucketsQueued,
        projectBucketsQueued:
          (grokResult.projectBucketsQueued || 0) + (grokScanResult.projectBucketsQueued || 0),
      };
    }
    if (isFullSourceScan && opts.repairGrok) {
      await repairGrokQueueFromSessionSnapshots({ cursors, queuePath, queueStatePath });
    }

    // ── GitHub Copilot App / CLI unified local runtime ──
    //
    // First adoption deliberately runs legacy OTEL + App DB once before the
    // session-store parser records its max-id barrier. Subsequent scans use
    // session-store as canonical for CLI/App requests: OTEL keeps only Chat
    // extension LogRecords, while App DB remains an observe-only baseline.
    let copilotResult = { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
    const copilotSourceAllowed = sourceAllowed("copilot");
    const adoptedCopilotStorePaths = new Set(
      Object.entries(cursors?.copilotStore?.dbs || {})
        .filter(([, state]) => state?.adoptedAt)
        .map(([dbPath]) => dbPath),
    );
    const copilotStorePaths = copilotSourceAllowed
      ? Array.from(
          new Set([
            ...resolveCopilotSessionStorePaths(process.env),
            ...adoptedCopilotStorePaths,
          ]),
        ).filter((dbPath) => {
          if (adoptedCopilotStorePaths.has(dbPath)) return true;
          try { return fssync.existsSync(dbPath); } catch (_e) { return false; }
        })
      : [];
    const copilotStoreWasActive = cursors?.copilotStore?.active === true;
    const copilotStoreAdoptionFingerprints = {};
    if (!copilotStoreWasActive) {
      for (const dbPath of copilotStorePaths) {
        try {
          copilotStoreAdoptionFingerprints[dbPath] =
            getCopilotSqliteFingerprint(dbPath);
        } catch (_e) {}
      }
    }
    let copilotHadLegacyCliOtelHistory = false;
    if (!copilotStoreWasActive) {
      copilotHadLegacyCliOtelHistory =
        await copilotOtelCursorHasLegacyCliUsage(cursors);
      if (cursors?.copilot && typeof cursors.copilot === "object") {
        if (copilotHadLegacyCliOtelHistory) {
          cursors.copilot.legacyCliHistory = true;
        } else {
          cursors.copilot.usageClaimsComplete = true;
        }
      }
    }
    let copilotLegacyHealthy = true;
    let copilotOtelUsageClaims =
      cursors?.copilot?.recentUsageEvents || [];
    let copilotStoreResult = {
      active: copilotStoreWasActive,
      healthy: false,
      adoptedThisRun: false,
      canonicalDbPaths: [],
      recordsProcessed: 0,
      eventsAggregated: 0,
      bucketsQueued: 0,
      usageClaims: cursors?.copilotStore?.recentEvents || [],
    };
    if (copilotSourceAllowed && copilotStoreWasActive) {
      if (progress?.enabled) {
        progress.start(`Parsing Copilot App/CLI ${renderBar(0)} | buckets 0`);
      }
      try {
        copilotStoreResult = await parseCopilotSessionStoreIncremental({
          dbPaths: copilotStorePaths,
          cursors,
          queuePath,
          env: process.env,
          otelUsageEvents: cursors?.copilot?.recentUsageEvents,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Copilot App/CLI ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} events | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
        copilotResult = mergeParseResult(copilotResult, copilotStoreResult);
      } catch (err) {
        warnProviderParseFailure("Copilot App/CLI session store", err, opts);
      }
    }
    const copilotPathKey = (dbPath) => {
      const normalized = path.normalize(dbPath);
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    const canonicalCopilotStorePaths = new Set(
      (copilotStoreResult.canonicalDbPaths || []).map(copilotPathKey),
    );
    const adoptedCopilotStorePathKeys = new Set(
      Object.entries(cursors?.copilotStore?.dbs || {})
        .filter(([, state]) => state?.adoptedAt)
        .map(([dbPath]) => copilotPathKey(dbPath)),
    );
    const explicitCopilotStorePath =
      typeof process.env.TOKENTRACKER_COPILOT_SESSION_STORE_DB === "string" &&
      process.env.TOKENTRACKER_COPILOT_SESSION_STORE_DB.trim()
        ? copilotPathKey(
            normalizeCopilotDbPath(
              process.env.TOKENTRACKER_COPILOT_SESSION_STORE_DB,
              process.env,
            ),
          )
        : null;
    const explicitStoreIsCanonical =
      explicitCopilotStorePath !== null &&
      canonicalCopilotStorePaths.has(explicitCopilotStorePath);
    const explicitStoreIsAdopted =
      explicitCopilotStorePath !== null &&
      adoptedCopilotStorePathKeys.has(explicitCopilotStorePath);

    // ── GitHub Copilot CLI / Chat extension (OTEL JSONL files) ──
    const copilotPaths = copilotSourceAllowed ? resolveCopilotOtelPaths(process.env) : [];
    if (copilotPaths.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Copilot ${renderBar(0)} | buckets 0`);
      }
      try {
        const copilotOtelResult = await parseCopilotIncremental({
          otelPaths: copilotPaths,
          cursors,
          queuePath,
          env: process.env,
          storeUsageEvents:
            copilotStoreResult.usageClaims ||
            cursors?.copilotStore?.recentEvents ||
            [],
          skipCliSpans: copilotStoreWasActive,
          onProgress: (p) => {
            if (!progress?.enabled) return;
            const pct = p.total > 0 ? p.index / p.total : 1;
            progress.update(
              `Parsing Copilot ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} files | buckets ${formatNumber(p.bucketsQueued)}`,
            );
          },
        });
        copilotOtelUsageClaims =
          copilotOtelResult.usageClaims ||
          cursors?.copilot?.recentUsageEvents ||
          [];
        copilotResult = mergeParseResult(copilotResult, copilotOtelResult);
      } catch (err) {
        copilotLegacyHealthy = false;
        warnProviderParseFailure("Copilot", err, opts);
      }
    }

    // ── GitHub Copilot App (passive data.db session summaries) ──
    const copilotAppDbStates =
      cursors?.copilotApp?.dbs && typeof cursors.copilotApp.dbs === "object"
        ? cursors.copilotApp.dbs
        : null;
    const initialTrackedCopilotAppDbPaths = new Set(
      Object.keys(copilotAppDbStates || {}),
    );
    const copilotAppDbCandidates = uniqueCopilotDbPaths(
      [
        ...resolveCopilotAppDbPaths(process.env),
        ...initialTrackedCopilotAppDbPaths,
      ],
      process.env,
      Array.from(initialTrackedCopilotAppDbPaths),
    );
    coalesceCopilotDbStatesByIdentity(
      copilotAppDbStates,
      copilotAppDbCandidates,
      mergeCopilotAppDbStates,
    );
    const explicitStoreOwnsSingleApp =
      copilotAppDbCandidates.length === 1 &&
      explicitStoreIsAdopted;
    if (copilotAppDbStates && (copilotStoreWasActive || copilotStorePaths.length > 0)) {
      for (const dbPath of Object.keys(copilotAppDbStates)) {
        try {
          fssync.statSync(dbPath);
        } catch (err) {
          const matchingStorePath = copilotPathKey(
            path.join(path.dirname(dbPath), "session-store.db"),
          );
          if (err?.code === "ENOENT") {
            if (
              canonicalCopilotStorePaths.has(matchingStorePath) ||
              (explicitStoreOwnsSingleApp && explicitStoreIsCanonical)
            ) {
              delete copilotAppDbStates[dbPath];
            }
          } else {
            if (!copilotStoreWasActive) copilotLegacyHealthy = false;
          }
        }
      }
    }
    const trackedCopilotAppDbPaths = new Set(
      Object.keys(cursors?.copilotApp?.dbs || {}),
    );
    const rawCopilotAppDbPaths = copilotSourceAllowed
      ? Array.from(new Set([
          ...copilotAppDbCandidates,
          ...trackedCopilotAppDbPaths,
        ])).filter((dbPath) => {
          if (trackedCopilotAppDbPaths.has(dbPath)) return true;
          try { return fssync.existsSync(dbPath); } catch (_e) { return false; }
        })
      : [];
    const copilotAppDbPaths = uniqueCopilotDbPaths(
      rawCopilotAppDbPaths,
      process.env,
      Array.from(trackedCopilotAppDbPaths),
    );
    if (copilotAppDbPaths.length > 0) {
      if (progress?.enabled) {
        progress.start(`Parsing Copilot App ${renderBar(0)} | buckets 0`);
      }
      for (const appDbPath of copilotAppDbPaths) {
        const storePathKey = copilotPathKey(
          path.join(path.dirname(appDbPath), "session-store.db"),
        );
        const observeOnly =
          copilotStoreWasActive ||
          adoptedCopilotStorePathKeys.has(storePathKey) ||
          (copilotAppDbPaths.length === 1 && explicitStoreIsAdopted);
        const catchupRelevant =
          !observeOnly &&
          !copilotStoreWasActive &&
          copilotStorePaths.length > 0;
        try {
          const copilotAppResult = await parseCopilotAppDbIncremental({
            dbPaths: [appDbPath],
            cursors,
            queuePath,
            env: process.env,
            observeOnly,
            onProgress: (p) => {
              if (!progress?.enabled) return;
              const pct = p.total > 0 ? p.index / p.total : 1;
              progress.update(
                `Parsing Copilot App ${renderBar(pct)} ${formatNumber(p.index)}/${formatNumber(p.total)} sessions | buckets ${formatNumber(p.bucketsQueued)}`,
              );
            },
          });
          copilotResult = mergeParseResult(copilotResult, copilotAppResult);
          if (catchupRelevant && copilotAppResult.dbErrors > 0) {
            copilotLegacyHealthy = false;
          }
        } catch (err) {
          if (catchupRelevant) copilotLegacyHealthy = false;
          warnProviderParseFailure("Copilot App", err, opts);
        }
      }
    }

    if (
      copilotSourceAllowed &&
      !copilotStoreWasActive &&
      copilotStorePaths.length > 0 &&
      copilotLegacyHealthy
    ) {
      if (progress?.enabled) {
        progress.start(`Adopting Copilot App/CLI store ${renderBar(0)} | buckets 0`);
      }
      try {
        const copilotHasOtelCursorHistory =
          (Array.isArray(cursors?.copilot?.seenIds) &&
            cursors.copilot.seenIds.length > 0) ||
          (cursors?.copilot?.fileOffsets &&
            Object.keys(cursors.copilot.fileOffsets).length > 0);
        const copilotOtelClaimsIncomplete =
          copilotHadLegacyCliOtelHistory ||
          (copilotHasOtelCursorHistory &&
            cursors?.copilot?.usageClaimsComplete !== true);
        const appSessionIds = [];
        const appSessionTotals = {};
        for (const dbState of Object.values(cursors?.copilotApp?.dbs || {})) {
          for (const [sessionId, totals] of Object.entries(
            dbState?.sessionTotals || {},
          )) {
            const total =
              Number(totals?.input || 0) +
              Number(totals?.output || 0) +
              Number(totals?.cached || 0) +
              Number(totals?.reasoning || 0);
            if (total <= 0) continue;
            appSessionIds.push(sessionId);
            const prior = appSessionTotals[sessionId];
            const priorTotal =
              Number(prior?.input || 0) +
              Number(prior?.output || 0) +
              Number(prior?.cached || 0) +
              Number(prior?.reasoning || 0);
            if (total > priorTotal) appSessionTotals[sessionId] = totals;
          }
        }
        copilotStoreResult = await parseCopilotSessionStoreIncremental({
          dbPaths: copilotStorePaths,
          cursors,
          queuePath,
          env: process.env,
          backfillOnFirstRun: !copilotOtelClaimsIncomplete,
          excludeSessionIdsOnFirstRun: appSessionIds,
          excludeSessionTotalsOnFirstRun: appSessionTotals,
          expectedFingerprints: copilotStoreAdoptionFingerprints,
          otelUsageEvents: copilotOtelUsageClaims,
        });
        copilotResult = mergeParseResult(copilotResult, copilotStoreResult);
      } catch (err) {
        warnProviderParseFailure("Copilot App/CLI session store", err, opts);
      }
    }

    if (copilotSourceAllowed) {
      if (Array.isArray(cursors?.copilot?.recentUsageEvents)) {
        cursors.copilot.recentUsageEvents = pruneCopilotUsageClaims(
          cursors.copilot.recentUsageEvents,
        );
      }
      if (Array.isArray(cursors?.copilotStore?.recentEvents)) {
        cursors.copilotStore.recentEvents = pruneCopilotUsageClaims(
          cursors.copilotStore.recentEvents,
        );
      }
    }

    if (isFullSourceScan && cursors?.projectHourly?.projects && projectQueuePath && projectQueueStatePath) {
      for (const [projectKey, meta] of Object.entries(cursors.projectHourly.projects)) {
        if (!meta || typeof meta !== "object") continue;
        if (meta.status !== "blocked" || !meta.purge_pending) continue;
        await purgeProjectUsage({
          projectKey,
          projectQueuePath,
          projectQueueStatePath,
          projectState: cursors.projectHourly,
          cursors,
        });
        meta.purge_pending = false;
        meta.purged_at = new Date().toISOString();
      }
    }

    if (isFullSourceScan) {
      await applyCloudConversationsBackfill({ cursors, queueStatePath });
    }

    const totalParsed =
      parseResult.filesProcessed +
      openclawResult.filesProcessed +
      claudeResult.filesProcessed +
      geminiResult.filesProcessed +
      antigravityResult.filesProcessed +
      opencodeResult.filesProcessed +
      qoderResult.recordsProcessed +
      qoderCnResult.recordsProcessed +
      claudeScienceResult.recordsProcessed +
      cursorResult.recordsProcessed +
      traeCnResult.recordsProcessed +
      kiroResult.recordsProcessed +
      kiroCliResult.recordsProcessed +
      hermesResult.recordsProcessed +
      kimiResult.recordsProcessed +
      kimiCodeResult.recordsProcessed +
      codebuddyResult.recordsProcessed +
      workbuddyResult.recordsProcessed +
      ompResult.recordsProcessed +
      piResult.recordsProcessed +
      primeAgentResult.recordsProcessed +
      craftResult.recordsProcessed +
      reasonixResult.recordsProcessed +
      grokResult.recordsProcessed +
      copilotResult.recordsProcessed +
      lmstudioResult.recordsProcessed +
      unslothResult.recordsProcessed +
      anythingllmResult.recordsProcessed +
      kiloResult.recordsProcessed +
      mimoResult.recordsProcessed +
      zcodeResult.recordsProcessed +
      kilocodeResult.recordsProcessed +
      roocodeResult.recordsProcessed +
      zedResult.recordsProcessed +
      gooseResult.recordsProcessed +
      dshResult.recordsProcessed +
      droidResult.recordsProcessed;
    const totalBuckets =
      parseResult.bucketsQueued +
      openclawResult.bucketsQueued +
      claudeResult.bucketsQueued +
      geminiResult.bucketsQueued +
      antigravityResult.bucketsQueued +
      opencodeResult.bucketsQueued +
      qoderResult.bucketsQueued +
      qoderCnResult.bucketsQueued +
      claudeScienceResult.bucketsQueued +
      cursorResult.bucketsQueued +
      traeCnResult.bucketsQueued +
      kiroResult.bucketsQueued +
      kiroCliResult.bucketsQueued +
      hermesResult.bucketsQueued +
      kimiResult.bucketsQueued +
      kimiCodeResult.bucketsQueued +
      codebuddyResult.bucketsQueued +
      workbuddyResult.bucketsQueued +
      ompResult.bucketsQueued +
      piResult.bucketsQueued +
      primeAgentResult.bucketsQueued +
      craftResult.bucketsQueued +
      reasonixResult.bucketsQueued +
      grokResult.bucketsQueued +
      copilotResult.bucketsQueued +
      lmstudioResult.bucketsQueued +
      unslothResult.bucketsQueued +
      anythingllmResult.bucketsQueued +
      kiloResult.bucketsQueued +
      mimoResult.bucketsQueued +
      zcodeResult.bucketsQueued +
      kilocodeResult.bucketsQueued +
      roocodeResult.bucketsQueued +
      zedResult.bucketsQueued +
      gooseResult.bucketsQueued +
      dshResult.bucketsQueued +
      droidResult.bucketsQueued;
    const skipNoOpCursorCommit =
      opts.auto &&
      !isFullSourceScan &&
      cursorStore.mode === "v2" &&
      cursorStore.requiresCommit !== true &&
      totalParsed === 0 &&
      totalBuckets === 0 &&
      !(grokResult.projectBucketsQueued > 0) &&
      !codexColdAuditDue &&
      !codexFallbackRetryRan &&
      !grokHookSignalConsumed &&
      !opts.repairGrok;

    if (syncDiagnostics) {
      syncDiagnostics.cursor_commits = Number(syncDiagnostics.cursor_commits || 0);
      syncDiagnostics.cursor_bytes = Number(syncDiagnostics.cursor_bytes || 0);
      syncDiagnostics.cursor_path = cursorStore.currentCorePath;
    }
    if (!skipNoOpCursorCommit) {
      cursors.updatedAt = new Date().toISOString();
      await cursorStore.commit(cursors);
      if (codexAuditRecorded) {
        await cursorStore.clearDeferredCodexAuditSyncs();
      }
      if (syncDiagnostics) {
        const cursorStat = await fs.stat(cursorStore.currentCorePath);
        syncDiagnostics.cursor_commits += 1;
        syncDiagnostics.cursor_bytes += cursorStat.size;
        syncDiagnostics.cursor_path = cursorStore.currentCorePath;
      }
    } else if (codexAuditRecorded) {
      await cursorStore.writeDeferredCodexAuditSyncs(
        deferredCodexAuditSyncs + 1,
      );
    }
    if (grokHookSignalConsumed && grokHookSignalPath) {
      await fs.unlink(grokHookSignalPath).catch(() => {});
    }

    progress?.stop();

    const runtimeConfig = config ? { ...config } : {};
    if (legacyBaseUrlMigration) {
      delete runtimeConfig.anonKey;
    }
    if (legacyBaseUrlMigration?.replacementDeviceToken) {
      runtimeConfig.deviceToken = legacyBaseUrlMigration.replacementDeviceToken;
    }
    const runtime = resolveRuntimeConfig({ config: runtimeConfig, env: process.env });

    let uploadResult = { inserted: 0, skipped: 0 };
    let uploadAttempted = false;
    let autoUploadDecision = null;

    if (opts.publishAccount || (legacyBaseUrlMigration && opts.auto)) {
      const uploadStateBefore = (await readJson(queueStatePath)) || { offset: 0 };
      const queueSizeBefore = await safeStatSize(queuePath);
      const pendingBytesBefore = Math.max(
        0,
        queueSizeBefore - Number(uploadStateBefore.offset || 0),
      );
      // Native publication and every auto-triggered legacy migration share the
      // failure-backoff gate. Intentionally ignore the 30-minute success
      // throttle: native refresh owns its own cadence, while a pending migration
      // should complete as soon as a credential becomes usable.
      autoUploadDecision = decideAutoUpload({
        nowMs: Date.now(),
        pendingBytes: pendingBytesBefore,
        state: {
          ...uploadThrottleState,
          nextAllowedAtMs: Number(uploadThrottleState.backoffUntilMs || 0),
        },
        config: {
          batchSize: 200,
          maxBatchesSmall: 5,
          maxBatchesLarge: 5,
        },
      });
    }

    if (runtime.deviceToken && runtime.baseUrl &&
        (!isBackgroundLightweightSync || opts.publishAccount) &&
        (!autoUploadDecision || autoUploadDecision.allowed)) {
      uploadAttempted = true;
      // Mirror the machine identity into the purge-surviving seed file so a
      // future `uninstall --purge` + reinstall recovers the same cloud device
      // instead of double-counting history under a new one (issue #176). This
      // is the migration path for installs that predate the seed file.
      try {
        require("../lib/machine-id").getOrCreateMachineId(queuePath);
      } catch {
        // best effort — upload below must not be blocked by identity mirroring
      }
      try {
        let successfulDeviceToken = runtime.deviceToken;
        const drainWithToken = (deviceToken) =>
          drainQueueToCloud({
            baseUrl: runtime.baseUrl,
            anonKey: runtime.anonKey,
            deviceToken,
            queuePath,
            queueStatePath,
            maxBatches: opts.drain ? 100 : (autoUploadDecision?.maxBatches || 5),
            batchSize: autoUploadDecision?.batchSize || 200,
          });
        try {
          uploadResult = await drainWithToken(successfulDeviceToken);
        } catch (error) {
          const fallbackDeviceToken = legacyBaseUrlMigration?.previousDeviceToken;
          const replacementDeviceToken = legacyBaseUrlMigration?.replacementDeviceToken;
          const stateAfterFailure = (await readJson(queueStatePath)) || { offset: 0 };
          const canFallbackWithoutSplittingHistory =
            (error?.status === 401 || error?.status === 403) &&
            replacementDeviceToken &&
            fallbackDeviceToken &&
            fallbackDeviceToken !== replacementDeviceToken &&
            Number(stateAfterFailure.offset || 0) === 0;
          if (!canFallbackWithoutSplittingHistory) throw error;
          successfulDeviceToken = fallbackDeviceToken;
          uploadResult = await drainWithToken(successfulDeviceToken);
        }
        // A successful ingest response proves which credential belongs to the
        // current backend. Only now commit the token and remove the retry marker.
        // Empty queues make no request, so keep the marker until future data can
        // validate a credential instead of persisting an unverified token.
        if (legacyBaseUrlMigration && uploadResult.batches > 0) {
          // device-login does not share the sync lock and may have written a
          // fresh current-backend config while the scan/upload was running.
          // Re-read before committing and only remove the anonymous key this
          // migration observed. A concurrent login may replace the backend URL
          // while preserving the old key, or another writer may replace the key
          // while the legacy URL is still present.
          await updateJsonLocked(configPath, async (latestConfig) => {
            const hasLegacyBaseUrl = isLegacyInsforgeBaseUrl(latestConfig.baseUrl);
            const hasUnchangedLegacyAnonKey =
              legacyBaseUrlMigration.hadPersistedAnonKey &&
              latestConfig.anonKey === legacyBaseUrlMigration.persistedAnonKey;
            if (!hasLegacyBaseUrl && !hasUnchangedLegacyAnonKey) return null;
            if (hasLegacyBaseUrl) {
              latestConfig.deviceToken = successfulDeviceToken;
              delete latestConfig.baseUrl;
            }
            if (hasUnchangedLegacyAnonKey) {
              delete latestConfig.anonKey;
            }
            return latestConfig;
          });
        }
        // Record success so the exponential backoff step resets — otherwise
        // a single past failure keeps us pessimistically throttled forever.
        uploadThrottleState = recordUploadSuccess({
          nowMs: Date.now(),
          state: uploadThrottleState,
        });
        await writeJson(uploadThrottlePath, uploadThrottleState);
      } catch (e) {
        // Persist a backoff on 429 / 5xx so the next auto-sync waits instead
        // of retrying immediately and making the rate-limit worse. The
        // throttle module already parses Retry-After when we surface it on
        // the error object (drainQueueToCloud stamps err.status + err.retryAfterMs).
        uploadThrottleState = recordUploadFailure({
          nowMs: Date.now(),
          state: uploadThrottleState,
          error: e,
        });
        await writeJson(uploadThrottlePath, uploadThrottleState);
        if (!opts.auto) {
          process.stderr.write(`Upload error: ${e?.message || e}\n`);
        }
        // `sync --drain` is the readiness boundary for first-time cloud view:
        // callers must not treat a swallowed upload failure as a completed
        // historical backfill and switch away from the intact local data.
        if (opts.drain) throw e;
      }
    }

    const afterState = (await readJson(queueStatePath)) || { offset: 0 };
    const queueSize = await safeStatSize(queuePath);
    // Only the main queue is uploaded by drainQueueToCloud. project.queue.jsonl
    // is local project-usage state, so counting it here creates false backlog
    // and can keep auto retry alive even after cloud sync has drained.
    const pendingBytes = Math.max(0, queueSize - Number(afterState.offset || 0));

    if (pendingBytes <= 0) {
      await clearAutoRetry(trackerDir);
    } else if (opts.auto && uploadAttempted && !opts.publishAccount) {
      const retryAtMs = Number(uploadThrottleState?.nextAllowedAtMs || 0);
      if (retryAtMs > Date.now()) {
        await scheduleAutoRetry({
          trackerDir,
          retryAtMs,
          reason: "backlog",
          pendingBytes,
          source: autoSourceScope ? `${autoSourceScope}-backlog` : "auto-backlog",
          syncSource: autoSourceScope,
          autoRetryNoSpawn: runtime.autoRetryNoSpawn,
        });
      }
    }

    if (!opts.auto) {
      process.stdout.write(
        [
          "Sync finished:",
          `- Parsed files: ${totalParsed}`,
          `- New 30-min buckets queued: ${totalBuckets}`,
          runtime.deviceToken
            ? `- Uploaded: ${uploadResult.inserted} inserted, ${uploadResult.skipped} skipped`
            : "- Uploaded: skipped (no device token)",
          runtime.deviceToken && pendingBytes > 0 && !opts.drain
            ? `- Remaining: ${formatBytes(pendingBytes)} pending (run sync again, or use --drain)`
            : null,
          "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    // Anonymous daily heartbeat (shared 24h throttle with serve — see
    // src/lib/telemetry.js). Awaited because hook-spawned sync processes exit
    // right after this function returns, which would kill an in-flight
    // request; the throttle makes it a network no-op on all but the first
    // sync of the day, and maybeSendHeartbeat never throws.
    await maybeSendHeartbeat({ trackerDir });
  } finally {
    progress?.stop();
    await lock.release();
  }
}

function parseArgs(argv) {
  const out = {
    auto: false,
    fromNotify: false,
    fromRetry: false,
    fromOpenclaw: false,
    source: null,
    drain: false,
    waitForLock: false,
    background: false,
    publishAccount: false,
    allLocalSources: false,
    repairGrok: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") out.auto = true;
    else if (a === "--from-notify") out.fromNotify = true;
    else if (a === "--from-retry") out.fromRetry = true;
    else if (a === "--from-openclaw") out.fromOpenclaw = true;
    else if (a === "--source") {
      out.source = normalizeSyncSource(argv[i + 1]);
      i += 1;
    }
    else if (a.startsWith("--source=")) out.source = normalizeSyncSource(a.slice("--source=".length));
    else if (a === "--drain") out.drain = true;
    else if (a === "--wait-for-lock") out.waitForLock = true;
    else if (a === "--background" || a === "--lightweight") out.background = true;
    else if (a === "--publish-account") out.publishAccount = true;
    else if (a === "--all-local-sources") out.allLocalSources = true;
    else if (a === "--repair-grok") out.repairGrok = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

function resolveAutoSourceScope(opts) {
  if (!opts?.auto) return null;
  if (opts.fromOpenclaw) return "openclaw";
  if (opts.fromRetry) return normalizeSyncSource(opts.source);
  if (!opts.fromNotify) return null;
  return normalizeSyncSource(opts.source);
}

function normalizeSyncSource(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  const aliased = AUTO_SYNC_SOURCE_ALIASES.get(normalized) || normalized;
  return AUTO_SYNC_SOURCES.has(aliased) ? aliased : null;
}

function isCodexColdScanAuditDue(
  cursors,
  nowMs = Date.now(),
  deferredSyncs = 0,
) {
  const state = cursors?.codexColdScanAudit;
  if (!state || typeof state !== "object" || state.version !== 1) return true;
  const lastFullScanAtMs = Number(state.lastFullScanAtMs);
  if (!Number.isFinite(lastFullScanAtMs) || lastFullScanAtMs <= 0) return true;
  if (Number.isFinite(nowMs) && lastFullScanAtMs - nowMs > 5 * 60 * 1000) return true;
  if (Number.isFinite(nowMs) && nowMs - lastFullScanAtMs >= CODEX_COLD_SCAN_AUDIT_INTERVAL_MS) {
    return true;
  }
  const syncsSinceFullScan =
    Number(state.syncsSinceFullScan || 0) +
    Math.max(0, Number(deferredSyncs) || 0);
  return (
    Number.isFinite(syncsSinceFullScan) &&
    syncsSinceFullScan >= CODEX_COLD_SCAN_AUDIT_MAX_SYNCS
  );
}

function recordCodexColdScanAudit(
  cursors,
  { fullAudit = false, skipped = 0, deferredSyncs = 0 } = {},
  nowMs = Date.now(),
) {
  if (!cursors || typeof cursors !== "object") return;
  const prev =
    cursors.codexColdScanAudit && typeof cursors.codexColdScanAudit === "object"
      ? cursors.codexColdScanAudit
      : {};
  const previousSyncs = Number(prev.syncsSinceFullScan || 0);
  const lastFullScanAtMs = Number(prev.lastFullScanAtMs);
  const next = {
    version: 1,
    lastFullScanAtMs: Number.isFinite(lastFullScanAtMs) && lastFullScanAtMs > 0
      ? lastFullScanAtMs
      : nowMs,
    syncsSinceFullScan:
      (Number.isFinite(previousSyncs) && previousSyncs > 0 ? previousSyncs : 0) +
      Math.max(0, Number(deferredSyncs) || 0),
    lastSkippedFiles: Math.max(0, Number(skipped) || 0),
    updatedAt: new Date(nowMs).toISOString(),
  };
  if (fullAudit) {
    next.lastFullScanAtMs = nowMs;
    next.lastFullScanAt = new Date(nowMs).toISOString();
    next.syncsSinceFullScan = 0;
  } else {
    next.lastFullScanAt = Number.isFinite(next.lastFullScanAtMs)
      ? new Date(next.lastFullScanAtMs).toISOString()
      : null;
    next.syncsSinceFullScan += 1;
  }
  cursors.codexColdScanAudit = next;
}

module.exports = {
  cmdSync,
  acquireSyncLock,
  readQueueBatch,
  drainQueueToCloud,
  migrateCursorUnknownBuckets,
  migrateRolloutCumulativeDeltaBuckets,
  repairCodebuddyLogJsonlOverlap,
  repairWorkbuddyContextUsage,
  WORKBUDDY_CONTEXT_USAGE_REPAIR_KEY,
  migrateLegacyDeepseekHarnessSource,
  DSH_LEGACY_SOURCE_MIGRATION_KEY,
  repairCodexRescanInflation,
  repairCodexForkReplayInflation,
  repairCodexInterleavedUsageInflation,
  repairDroidDuplicateSessionInflation,
  repairMimoClaudeMislabel,
  repairZcodeNativeUsageMigration,
  repairZcodeInclusiveTokenMigration,
  reincludeClaudeMemObserverFiles,
  repairGrokQueueFromSessionSnapshots,
  applyCloudConversationsBackfill,
  scheduleAutoRetry,
  buildAutoRetryScript,
  isCodexColdScanAuditDue,
  recordCodexColdScanAudit,
  CURSOR_UNKNOWN_MIGRATION_KEY,
  ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY,
  CODEBUDDY_LOG_JSONL_REPAIR_KEY,
  CODEX_RESCAN_DEDUP_REPAIR_KEY,
  CODEX_FORK_REPLAY_REPAIR_KEY,
  CODEX_USAGE_LINEAGE_REPAIR_KEY,
  DROID_DUP_SESSION_REPAIR_KEY,
  CLAUDE_MEM_OBSERVER_REINCLUDE_KEY,
  GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY,
  CLOUD_CONVERSATIONS_BACKFILL_KEY,
};

// The pre-merge Harness prototype briefly emitted source="deepseek" before
// settling on the official CLI id, source="dsh". Relabel the local history,
// append explicit zero rows for every old cloud key, and replay from offset 0.
// That preserves the latest canonical totals while making remote whole-row
// upserts remove the stale alias instead of displaying both sources or summing
// the same session twice.
async function migrateLegacyDeepseekHarnessSource({ cursors, queuePath, queueStatePath } = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  if (migrations[DSH_LEGACY_SOURCE_MIGRATION_KEY]) return false;

  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const output = [];
  const legacyKeys = new Map();
  const latestMigratedRows = new Map();
  const latestExplicitCanonicalRows = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_error) {
      output.push(line);
      continue;
    }

    const isLegacy =
      row?.source === "deepseek" &&
      typeof row.model === "string" &&
      typeof row.hour_start === "string";
    if (isLegacy) {
      const key = `${row.model}|${row.hour_start}`;
      legacyKeys.set(key, { model: row.model, hour_start: row.hour_start });
      row = {
        ...row,
        source: "dsh",
        billable_total_tokens: row.billable_total_tokens ?? row.total_tokens,
      };
    }
    const serialized = JSON.stringify(row);
    output.push(serialized);
    if (row?.source === "dsh" && typeof row.model === "string" && typeof row.hour_start === "string") {
      const key = `${row.model}|${row.hour_start}`;
      if (isLegacy) latestMigratedRows.set(key, serialized);
      else latestExplicitCanonicalRows.set(key, serialized);
    }
  }

  if (legacyKeys.size === 0) {
    migrations[DSH_LEGACY_SOURCE_MIGRATION_KEY] = {
      status: "noop",
      appliedAt: new Date().toISOString(),
      reason: "no-legacy-deepseek-rows",
    };
    return false;
  }

  // Re-append the last canonical row for each affected key so local readers'
  // last-row-wins contract remains correct even when an old alias line was
  // physically later than an already-emitted dsh row.
  for (const key of legacyKeys.keys()) {
    const canonical = latestExplicitCanonicalRows.get(key) || latestMigratedRows.get(key);
    if (canonical) output.push(canonical);
  }
  for (const { model, hour_start } of legacyKeys.values()) {
    output.push(JSON.stringify({
      source: "deepseek",
      model,
      hour_start,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      billable_total_tokens: 0,
      conversation_count: 0,
    }));
  }

  await ensureDir(path.dirname(queuePath));
  const tmpPath = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, `${output.join("\n")}\n`, "utf8");
  await fs.rename(tmpPath, queuePath);

  if (typeof queueStatePath === "string" && queueStatePath) {
    let state = {};
    try {
      state = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
      if (!state || typeof state !== "object") state = {};
    } catch (_error) {
      state = {};
    }
    state.offset = 0;
    state.updatedAt = new Date().toISOString();
    state.note = "reset_after_deepseek_harness_source_migration_2026_08";
    await ensureDir(path.dirname(queueStatePath));
    await fs.writeFile(queueStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  migrations[DSH_LEGACY_SOURCE_MIGRATION_KEY] = {
    status: "applied",
    appliedAt: new Date().toISOString(),
    migratedBuckets: legacyKeys.size,
    retractedBuckets: legacyKeys.size,
  };
  return true;
}

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveOpenclawSignal({ env } = {}) {
  if (!env) return null;

  const agentId = normalizeString(env.TOKENTRACKER_OPENCLAW_AGENT_ID);
  const sessionId = normalizeString(env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID);
  if (!agentId || !sessionId) return null;

  // Resolve the OpenClaw home identically to the passive scanner so the
  // plugin-triggered file and passively discovered files share one path
  // spelling — otherwise the same transcript could get two cursors and be
  // counted twice (issue #264 review).
  const openclawHome = resolveOpenclawHome(env);
  const sessionFile = path.join(openclawHome, "agents", agentId, "sessions", `${sessionId}.jsonl`);

  const prevTotals = {
    totalTokens: normalizeNonNegativeInt(env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS),
    inputTokens: normalizeNonNegativeInt(env.TOKENTRACKER_OPENCLAW_PREV_INPUT_TOKENS),
    outputTokens: normalizeNonNegativeInt(env.TOKENTRACKER_OPENCLAW_PREV_OUTPUT_TOKENS),
    model: normalizeString(env.TOKENTRACKER_OPENCLAW_PREV_MODEL),
    updatedAt: normalizeIsoOrEpoch(env.TOKENTRACKER_OPENCLAW_PREV_UPDATED_AT),
  };

  return {
    agentId,
    sessionId,
    sessionKey: normalizeString(env.TOKENTRACKER_OPENCLAW_SESSION_KEY),
    openclawHome,
    sessionFile,
    prevTotals,
  };
}

async function applyOpenclawTotalsFallback({
  trackerDir,
  signal,
  cursors,
  queuePath,
  projectQueuePath,
}) {
  const totalTokens = Number(signal?.prevTotals?.totalTokens || 0);
  if (!trackerDir || !signal || totalTokens <= 0) {
    return { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  // The passive/plugin transcript parse is authoritative: if this session's
  // transcript has ever yielded real per-event usage, synthesizing sessions.json
  // totals on top would count the same tokens twice (issue #264 review). Defer
  // to the real events and advance the fallback baseline so no stale delta lingers.
  const transcriptCursor =
    signal.sessionFile && cursors?.files
      ? cursors.files[openclawCursorKey(signal.sessionFile)]
      : null;
  const transcriptHasRealUsage = Boolean(transcriptCursor?.hasRealUsage);

  const sessionKey = `${signal.agentId}:${signal.sessionId}`;
  const statePath = path.join(trackerDir, "openclaw.fallback.state.json");
  const fallbackFilePath = path.join(trackerDir, "openclaw.fallback.jsonl");
  const state = (await readJson(statePath)) || { version: 1, sessions: {} };
  const sessions = state.sessions && typeof state.sessions === "object" ? state.sessions : {};
  const prev =
    sessions[sessionKey] && typeof sessions[sessionKey] === "object" ? sessions[sessionKey] : null;

  if (transcriptHasRealUsage) {
    sessions[sessionKey] = {
      totalTokens: normalizeNonNegativeInt(signal?.prevTotals?.totalTokens) || 0,
      inputTokens: normalizeNonNegativeInt(signal?.prevTotals?.inputTokens) || 0,
      outputTokens: normalizeNonNegativeInt(signal?.prevTotals?.outputTokens) || 0,
      model: normalizeString(signal?.prevTotals?.model) || "unknown",
      updatedAt: normalizeIsoOrEpoch(signal?.prevTotals?.updatedAt) || new Date().toISOString(),
      seenAt: new Date().toISOString(),
      coveredByEvents: true,
    };
    state.version = 1;
    state.sessions = sessions;
    await writeJson(statePath, state);
    return { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  const current = {
    totalTokens: normalizeNonNegativeInt(signal?.prevTotals?.totalTokens) || 0,
    inputTokens: normalizeNonNegativeInt(signal?.prevTotals?.inputTokens) || 0,
    outputTokens: normalizeNonNegativeInt(signal?.prevTotals?.outputTokens) || 0,
    model: normalizeString(signal?.prevTotals?.model) || "unknown",
    updatedAt: normalizeIsoOrEpoch(signal?.prevTotals?.updatedAt) || new Date().toISOString(),
    seenAt: new Date().toISOString(),
  };

  let deltaTotal = current.totalTokens;
  let deltaInput = current.inputTokens;
  let deltaOutput = current.outputTokens;
  if (prev) {
    deltaTotal = Math.max(
      0,
      current.totalTokens - (normalizeNonNegativeInt(prev.totalTokens) || 0),
    );
    deltaInput = Math.max(
      0,
      current.inputTokens - (normalizeNonNegativeInt(prev.inputTokens) || 0),
    );
    deltaOutput = Math.max(
      0,
      current.outputTokens - (normalizeNonNegativeInt(prev.outputTokens) || 0),
    );
  }

  if (deltaTotal > 0 && deltaInput + deltaOutput === 0) {
    deltaInput = deltaTotal;
  }

  sessions[sessionKey] = current;
  state.version = 1;
  state.sessions = sessions;

  if (deltaTotal <= 0) {
    await writeJson(statePath, state);
    return { filesProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
  }

  await ensureDir(path.dirname(fallbackFilePath));
  const syntheticMessage = {
    type: "message",
    timestamp: current.updatedAt,
    message: {
      role: "assistant",
      model: current.model,
      usage: {
        input: deltaInput,
        output: deltaOutput,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: deltaTotal,
      },
    },
  };
  await fs.appendFile(fallbackFilePath, `${JSON.stringify(syntheticMessage)}\n`, "utf8");
  await writeJson(statePath, state);

  return parseOpenclawIncremental({
    sessionFiles: [{ path: fallbackFilePath, source: "openclaw" }],
    cursors,
    queuePath,
    projectQueuePath,
    source: "openclaw",
  });
}

function normalizeNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function normalizeIsoOrEpoch(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !Number.isNaN(Date.parse(trimmed))) return trimmed;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      const ms = numeric < 1e12 ? Math.floor(numeric * 1000) : Math.floor(numeric);
      const iso = new Date(ms).toISOString();
      if (!Number.isNaN(Date.parse(iso))) return iso;
    }
  }

  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

async function safeStatSize(p) {
  try {
    const st = await fs.stat(p);
    return st && st.isFile() ? st.size : 0;
  } catch (_e) {
    return 0;
  }
}

function deriveAutoSkipReason({ decision, state }) {
  if (!decision || decision.reason !== "throttled") return decision?.reason || "unknown";
  const backoffUntilMs = Number(state?.backoffUntilMs || 0);
  const nextAllowedAtMs = Number(state?.nextAllowedAtMs || 0);
  if (backoffUntilMs > 0 && backoffUntilMs >= nextAllowedAtMs) return "backoff";
  return "throttled";
}

async function scheduleAutoRetry({
  trackerDir,
  retryAtMs,
  reason,
  pendingBytes,
  source,
  syncSource,
  autoRetryNoSpawn,
}) {
  const retryMs = coerceRetryMs(retryAtMs);
  if (!retryMs) return { scheduled: false, retryAtMs: 0 };

  const retryPath = path.join(trackerDir, AUTO_RETRY_FILENAME);
  const nowMs = Date.now();
  const existing = await readJson(retryPath);
  const existingMs = coerceRetryMs(existing?.retryAtMs);
  const normalizedSyncSource = normalizeSyncSource(syncSource);
  if (existingMs && existingMs >= retryMs - 1000) {
    const existingSyncSource = normalizeSyncSource(existing?.syncSource);
    if (existingSyncSource !== normalizedSyncSource) {
      await writeJson(
        retryPath,
        buildAutoRetryPayload({
          retryMs: existingMs,
          nowMs,
          reason,
          pendingBytes,
          source,
          syncSource: normalizedSyncSource,
        }),
      );
    }
    return { scheduled: false, retryAtMs: existingMs };
  }

  const payload = buildAutoRetryPayload({
    retryMs,
    nowMs,
    reason,
    pendingBytes,
    source,
    syncSource: normalizedSyncSource,
  });

  await writeJson(retryPath, payload);

  const delayMs = Math.min(AUTO_RETRY_MAX_DELAY_MS, Math.max(0, retryMs - nowMs));
  if (delayMs <= 0) return { scheduled: false, retryAtMs: retryMs };
  if (autoRetryNoSpawn) {
    return { scheduled: false, retryAtMs: retryMs };
  }

  spawnAutoRetryProcess({
    retryPath,
    trackerBinPath: path.join(trackerDir, "app", "bin", "tracker.js"),
    fallbackPkg: "tokentracker-cli",
    delayMs,
  });
  return { scheduled: true, retryAtMs: retryMs };
}

function buildAutoRetryPayload({ retryMs, nowMs, reason, pendingBytes, source, syncSource }) {
  const payload = {
    version: 1,
    retryAtMs: retryMs,
    retryAt: new Date(retryMs).toISOString(),
    reason: typeof reason === "string" && reason.length > 0 ? reason : "throttled",
    pendingBytes: Math.max(0, Number(pendingBytes || 0)),
    scheduledAt: new Date(nowMs).toISOString(),
    source: typeof source === "string" ? source : "auto",
  };
  if (syncSource) payload.syncSource = syncSource;
  return payload;
}

async function clearAutoRetry(trackerDir) {
  const retryPath = path.join(trackerDir, AUTO_RETRY_FILENAME);
  await fs.unlink(retryPath).catch(() => {});
}

function spawnAutoRetryProcess({ retryPath, trackerBinPath, fallbackPkg, delayMs }) {
  const script = buildAutoRetryScript({ retryPath, trackerBinPath, fallbackPkg, delayMs });
  try {
    const child = cp.spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (_e) {}
}

function buildAutoRetryScript({ retryPath, trackerBinPath, fallbackPkg, delayMs }) {
  return (
    `'use strict';\n` +
    `const fs = require('node:fs');\n` +
    `const cp = require('node:child_process');\n` +
    `const retryPath = ${JSON.stringify(retryPath)};\n` +
    `const trackerBinPath = ${JSON.stringify(trackerBinPath)};\n` +
    `const fallbackPkg = ${JSON.stringify(fallbackPkg)};\n` +
    `const delayMs = ${Math.max(0, Math.floor(delayMs || 0))};\n` +
    `setTimeout(() => {\n` +
    `  let payload = null;\n` +
    `  let retryAtMs = 0;\n` +
    `  try {\n` +
    `    const raw = fs.readFileSync(retryPath, 'utf8');\n` +
    `    payload = JSON.parse(raw);\n` +
    `    retryAtMs = Number(payload.retryAtMs || 0);\n` +
    `  } catch (_) {}\n` +
    `  if (!retryAtMs || Date.now() + 1000 < retryAtMs) process.exit(0);\n` +
    `  const argv = ['sync', '--auto', '--from-retry'];\n` +
    `  if (payload && typeof payload.syncSource === 'string' && payload.syncSource.trim()) {\n` +
    `    argv.push('--source', payload.syncSource.trim());\n` +
    `  }\n` +
    `  const cmd = fs.existsSync(trackerBinPath)\n` +
    `    ? [process.execPath, trackerBinPath, ...argv]\n` +
    `    : ['npx', '--yes', fallbackPkg, ...argv];\n` +
    `  try {\n` +
    `    const child = cp.spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', env: process.env });\n` +
    `    child.unref();\n` +
    `  } catch (_) {}\n` +
    `}, delayMs);\n`
  );
}

function coerceRetryMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

async function writeOpenclawSignal(trackerDir) {
  const openclawSignalPath = path.join(trackerDir, "openclaw.signal");
  try {
    await fs.writeFile(openclawSignalPath, new Date().toISOString(), "utf8");
  } catch (_e) {
    // best-effort marker
  }
}

const AUTO_RETRY_FILENAME = "auto.retry.json";
const AUTO_RETRY_MAX_DELAY_MS = 2 * 60 * 60 * 1000;

const INGEST_SLUG = "tokentracker-ingest";
const MAX_INGEST_BUCKETS = 500;

async function drainQueueToCloud({ baseUrl, anonKey, deviceToken, queuePath, queueStatePath, maxBatches = 5, batchSize = 200 }) {
  const state = (await readJson(queueStatePath)) || { offset: 0 };
  let offset = Number(state.offset || 0);
  let inserted = 0;
  let skipped = 0;
  let batches = 0;

  const queueSize = await safeStatSize(queuePath);
  const limit = Math.min(Math.max(1, Math.floor(Number(batchSize || 200))), MAX_INGEST_BUCKETS);

  for (let batch = 0; batch < maxBatches; batch++) {
    if (offset >= queueSize) break;
    const result = await readQueueBatch(queuePath, offset, limit);
    // A states-only tail (e.g. a retry batch whose bucket rows already
    // uploaded) is still a meaningful upload: it advances the canonical
    // session corrections cloud-side.
    if (result.buckets.length === 0 && result.sessionStates.length === 0) break;

    const root = baseUrl.replace(/\/$/, "");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${deviceToken}`,
    };
    if (anonKey) headers.apikey = anonKey;
    const res = await fetch(`${root}/functions/${INGEST_SLUG}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        hourly: result.buckets,
        ...(result.sessionStates.length > 0
          ? { account_session_states: result.sessionStates }
          : {}),
      }),
    });

    const rawText = await res.text().catch(() => "");
    let data = {};
    try { data = JSON.parse(rawText); } catch { data = {}; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${rawText.substring(0, 500)}`);
      err.status = res.status;
      const retryAfter = res.headers?.get?.("Retry-After") ?? null;
      const retryAfterMs = parseRetryAfterMs(retryAfter);
      if (retryAfterMs !== null) err.retryAfterMs = retryAfterMs;
      throw err;
    }

    inserted += Number(data?.inserted || 0);
    skipped += Number(data?.skipped || 0);
    batches += 1;

    offset = result.nextOffset;
    state.offset = offset;
    state.updatedAt = new Date().toISOString();
    await writeJson(queueStatePath, state);
  }

  return { inserted, skipped, batches };
}

async function readQueueBatch(queuePath, startOffset, maxBuckets) {
  const st = await fs.stat(queuePath).catch(() => null);
  if (!st || !st.isFile()) return { buckets: [], nextOffset: startOffset };
  if (startOffset >= st.size) return { buckets: [], nextOffset: startOffset };

  const stream = fssync.createReadStream(queuePath, { encoding: "utf8", start: startOffset });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const bucketMap = new Map();
  // Account session states (kind: "account_session_state") are queue
  // control records, not usage rows: collect them separately so they ride
  // the same upload (after the bucket rows in file order) without entering
  // the bucket stream. Keyed by (source, session_id) LAST-WINS: the
  // append-only queue writes a session's newer observation after its older
  // one, and only the latest per session may reach the ingest batch (a
  // duplicate would make the cloud ON CONFLICT affect one row twice).
  // snapshot_verified_at rides along verbatim from the ORIGINAL fetch, so a
  // transport retry never fakes logical freshness.
  //
  // Batching: session-state records count toward the SAME per-batch record
  // cap (maxBuckets) as bucket rows. The ingest edge rejects a request with
  // more than 500 states (HTTP 400); before they counted, a states-heavy
  // queue (a fresh device's first 30-day TRAE sync appends one record per
  // observed session) was read in ONE uncapped batch - the 400 left the
  // queue offset untouched and every retry re-read the identical oversized
  // request, a permanent upload failure. With the default batchSize of 200
  // (and the MAX_INGEST_BUCKETS=500 clamp above), every request stays under
  // the edge cap while batching follows the existing design.
  const sessionStateMap = new Map();
  let offset = startOffset;
  let linesRead = 0;
  for await (const line of rl) {
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    offset += bytes;
    if (!line.trim()) continue;
    let bucket;
    try {
      bucket = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (bucket?.kind === "account_session_state") {
      if (typeof bucket.source === "string" && typeof bucket.session_id === "string" && bucket.session_id.trim()) {
        const ssSource = bucket.source.trim().toLowerCase();
        sessionStateMap.set(ssSource + "|" + bucket.session_id.trim(), {
          source: ssSource,
          session_id: bucket.session_id.trim(),
          model: typeof bucket.model === "string" ? bucket.model : "",
          bucket_start: typeof bucket.bucket_start === "string" ? bucket.bucket_start : "",
          input_tokens: Number(bucket.input_tokens) || 0,
          output_tokens: Number(bucket.output_tokens) || 0,
          cached_input_tokens: Number(bucket.cached_input_tokens) || 0,
          cache_creation_input_tokens: Number(bucket.cache_creation_input_tokens) || 0,
          reasoning_output_tokens: Number(bucket.reasoning_output_tokens) || 0,
          total_tokens: Number(bucket.total_tokens) || 0,
          ...(typeof bucket.snapshot_verified_at === "string" && bucket.snapshot_verified_at
            ? { snapshot_verified_at: bucket.snapshot_verified_at }
            : {}),
        });
        // Counted like a bucket row: the record rides THIS batch and its
        // bytes are covered by nextOffset, so the next batch resumes right
        // after it.
        linesRead += 1;
        if (linesRead >= maxBuckets) break;
      }
      continue;
    }
    // Pre-release watermark records from this feature branch's dev queues
    // are obsolete control records: drop them instead of letting them enter
    // the bucket stream (they carry no hour_start and would be skipped
    // downstream anyway, but be explicit).
    if (bucket?.kind === "account_sync_watermark") continue;
    const hourStart = typeof bucket?.hour_start === "string" ? bucket.hour_start : null;
    if (!hourStart) continue;
    const source = (typeof bucket?.source === "string" ? bucket.source.trim().toLowerCase() : "") || "codex";
    const model = (typeof bucket?.model === "string" ? bucket.model.trim() : "") || "unknown";
    bucket.source = source;
    bucket.model = model;
    // Apply the same legacy-row corrections every local reader applies
    // (local-api readQueueData / project queue / wrapped aggregator). Without
    // this the cloud permanently kept the RAW legacy values — e.g. old Codex
    // rows whose input_tokens still include cached tokens (6-7x inflated) —
    // while the local dashboard showed corrected numbers.
    bucket = require("../lib/local-api").normalizeQueueRow(bucket);
    bucketMap.set(`${source}|${model}|${hourStart}`, bucket);
    linesRead += 1;
    if (linesRead >= maxBuckets) break;
  }

  rl.close();
  stream.close?.();
  return {
    buckets: Array.from(bucketMap.values()),
    sessionStates: Array.from(sessionStateMap.values()),
    nextOffset: offset,
  };
}

function normalizeGrokRepairSource(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeGrokRepairModel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "grok-build";
}

function normalizeGrokRepairNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toGrokRepairHalfHourStart(value) {
  if (value == null) return null;
  const millis =
    typeof value === "number"
      ? value < 10_000_000_000
        ? value * 1000
        : value
      : Date.parse(String(value));
  if (!Number.isFinite(millis)) return null;
  const halfHourMs = 30 * 60 * 1000;
  return new Date(Math.floor(millis / halfHourMs) * halfHourMs).toISOString();
}

function estimateGrokRepairTotals(totalTokens, conversationCount) {
  const total = Math.trunc(normalizeGrokRepairNumber(totalTokens));
  const inputTokens = Math.round(total * 0.8);
  const outputTokens = Math.max(0, total - inputTokens);
  return {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: total,
    billable_total_tokens: total,
    conversation_count: Math.trunc(normalizeGrokRepairNumber(conversationCount)),
  };
}

function addGrokRepairTotals(target, delta) {
  target.input_tokens += delta.input_tokens;
  target.cached_input_tokens += delta.cached_input_tokens;
  target.cache_creation_input_tokens += delta.cache_creation_input_tokens;
  target.output_tokens += delta.output_tokens;
  target.reasoning_output_tokens += delta.reasoning_output_tokens;
  target.total_tokens += delta.total_tokens;
  target.billable_total_tokens += delta.billable_total_tokens;
  target.conversation_count += delta.conversation_count;
}

function buildGrokRepairRowsFromSnapshots(sessionSnapshots) {
  if (!sessionSnapshots || typeof sessionSnapshots !== "object") return [];

  const buckets = new Map();
  for (const snapshot of Object.values(sessionSnapshots)) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const totalTokens = Math.trunc(normalizeGrokRepairNumber(snapshot.totalTokens));
    if (totalTokens <= 0) continue;

    const hourStart = toGrokRepairHalfHourStart(
      snapshot.lastEventTimestamp || snapshot.updatedAt,
    );
    if (!hourStart) continue;

    const model = normalizeGrokRepairModel(snapshot.model);
    const key = bucketKey("grok", model, hourStart);
    let totals = buckets.get(key);
    if (!totals) {
      totals = {
        source: "grok",
        model,
        hour_start: hourStart,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        billable_total_tokens: 0,
        conversation_count: 0,
      };
      buckets.set(key, totals);
    }
    addGrokRepairTotals(
      totals,
      estimateGrokRepairTotals(totalTokens, snapshot.messageCount),
    );
  }

  return Array.from(buckets.values()).sort((a, b) => {
    const timeCompare = a.hour_start.localeCompare(b.hour_start);
    return timeCompare || a.model.localeCompare(b.model);
  });
}

function applyGrokRepairHourlyState(cursors, rows) {
  const hourly = cursors.hourly && typeof cursors.hourly === "object" ? cursors.hourly : {};
  const buckets = hourly.buckets && typeof hourly.buckets === "object" ? hourly.buckets : {};
  const groupQueued =
    hourly.groupQueued && typeof hourly.groupQueued === "object" ? hourly.groupQueued : {};

  for (const key of Object.keys(buckets)) {
    if (key.startsWith("grok|")) {
      delete buckets[key];
    }
  }
  for (const key of Object.keys(groupQueued)) {
    if (key.startsWith("grok|")) {
      delete groupQueued[key];
    }
  }

  for (const row of rows) {
    const totals = {
      input_tokens: row.input_tokens,
      cached_input_tokens: row.cached_input_tokens,
      cache_creation_input_tokens: row.cache_creation_input_tokens,
      output_tokens: row.output_tokens,
      reasoning_output_tokens: row.reasoning_output_tokens,
      total_tokens: row.total_tokens,
      billable_total_tokens: row.billable_total_tokens,
      conversation_count: row.conversation_count,
    };
    buckets[bucketKey("grok", row.model, row.hour_start)] = {
      totals,
      queuedKey: totalsKey(totals),
      source: "grok",
      hour_start: row.hour_start,
    };
  }

  cursors.hourly = {
    ...hourly,
    version: 3,
    buckets,
    groupQueued,
    updatedAt: typeof hourly.updatedAt === "string" ? hourly.updatedAt : null,
  };
}

async function resetGrokRepairUploadOffset(queueStatePath) {
  if (typeof queueStatePath !== "string" || !queueStatePath) return false;
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
  } catch (_e) {
    state = {};
  }
  state.offset = 0;
  state.updatedAt = new Date().toISOString();
  state.note = "reset_after_grok_append_only_repair_2026_05_v4";
  await ensureDir(path.dirname(queueStatePath));
  await fs.writeFile(queueStatePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return true;
}

function hasAppliedGrokRepairMigration(value) {
  if (!value) return false;
  if (value === true) return true;
  if (value && typeof value === "object") {
    if (value.status === "applied" || value.status === "noop") return true;
    if (value.status) return false;
    return value.rowsWritten != null || value.rowsRemoved != null;
  }
  return false;
}

function serializeGrokRepairRow(row) {
  return JSON.stringify({
    source: "grok",
    model: normalizeGrokRepairModel(row.model),
    hour_start: row.hour_start,
    input_tokens: row.input_tokens || 0,
    cached_input_tokens: row.cached_input_tokens || 0,
    cache_creation_input_tokens: row.cache_creation_input_tokens || 0,
    output_tokens: row.output_tokens || 0,
    reasoning_output_tokens: row.reasoning_output_tokens || 0,
    total_tokens: row.total_tokens || 0,
    billable_total_tokens: row.billable_total_tokens || 0,
    conversation_count: row.conversation_count || 0,
  });
}

async function backupExistingFile(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak.${stamp}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function resetUploadOffsetForMimoRepair(queueStatePath) {
  if (typeof queueStatePath !== "string" || !queueStatePath) return false;
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
  } catch (_e) {
    state = {};
  }
  state.offset = 0;
  state.updatedAt = new Date().toISOString();
  state.note = "reset_after_mimo_claude_mislabel_repair_2026_06";
  await ensureDir(path.dirname(queueStatePath));
  await fs.writeFile(queueStatePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return true;
}

// Remove every source=mimo row from a queue file (atomic rewrite, backed up
// first). Returns the number of rows removed. Non-JSON lines are preserved.
async function dropMimoQueueRows(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
  const kept = [];
  let removed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      kept.push(line);
      continue;
    }
    if (row && row.source === "mimo") {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) return 0;
  await backupExistingFile(filePath);
  const tmp = `${filePath}.mimorepair.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  await fs.rename(tmp, filePath);
  return removed;
}

// One-time repair for the 0.57.0 mimo mislabel bug. Purges all source=mimo data
// (the mislabeled Claude/claude-mem mirror) from the local queues and cursor
// state, so the next sync re-parses mimocode.db with the providerID-filtered
// reader and rebuilds source=mimo from scratch — correct mimo-auto only. Cloud
// orphans (mimo rows already uploaded) are cleaned server-side separately.
async function repairMimoClaudeMislabel({
  cursors,
  queuePath,
  queueStatePath,
  projectQueuePath,
  projectQueueStatePath,
} = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  if (migrations[MIMO_PROVIDER_REPAIR_KEY]) return false;

  const hourly = cursors.hourly && typeof cursors.hourly === "object" ? cursors.hourly : null;
  const hasMimoBucket =
    hourly && hourly.buckets
      ? Object.keys(hourly.buckets).some((k) => k.startsWith("mimo|"))
      : false;

  // Nothing mimo-related anywhere → mark done so we don't re-scan every sync.
  let mainRaw = null;
  try {
    mainRaw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const hasMimoRow =
    typeof mainRaw === "string" &&
    mainRaw.split("\n").some((l) => {
      if (!l.trim()) return false;
      try {
        return JSON.parse(l).source === "mimo";
      } catch (_e) {
        return false;
      }
    });

  if (!hasMimoBucket && !hasMimoRow && !cursors.mimo) {
    migrations[MIMO_PROVIDER_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  // 1. Drop source=mimo rows from the main + project queues.
  const removedMain = await dropMimoQueueRows(queuePath);
  const removedProject =
    typeof projectQueuePath === "string" && projectQueuePath
      ? await dropMimoQueueRows(projectQueuePath)
      : 0;

  // 2. Clear stale mimo buckets from the aggregation state (keys are
  //    `source|model|hour` for hourly, `projectKey|source|hour` for project).
  if (hourly && hourly.buckets) {
    for (const k of Object.keys(hourly.buckets)) {
      if (k.startsWith("mimo|")) delete hourly.buckets[k];
    }
  }
  if (hourly && hourly.groupQueued) {
    for (const k of Object.keys(hourly.groupQueued)) {
      if (k.startsWith("mimo|")) delete hourly.groupQueued[k];
    }
  }
  const projectHourly =
    cursors.projectHourly && typeof cursors.projectHourly === "object"
      ? cursors.projectHourly
      : null;
  if (projectHourly && projectHourly.buckets) {
    for (const k of Object.keys(projectHourly.buckets)) {
      if (k.includes("|mimo|")) delete projectHourly.buckets[k];
    }
  }

  // 3. Reset the mimo message index so the next sync re-parses the DB fresh.
  delete cursors.mimo;

  // 4. Reset upload offsets — the queue rewrite changed byte offsets, so a full
  //    replay is required (cloud keeps latest per key; orphan mimo rows already
  //    uploaded are removed server-side).
  if (removedMain > 0) await resetUploadOffsetForMimoRepair(queueStatePath);
  if (removedProject > 0) await resetUploadOffsetForMimoRepair(projectQueueStatePath);

  migrations[MIMO_PROVIDER_REPAIR_KEY] = {
    appliedAt: new Date().toISOString(),
    removedMain,
    removedProject,
  };
  return true;
}

async function resetUploadOffsetForZcodeRepair(queueStatePath, note) {
  if (typeof queueStatePath !== "string" || !queueStatePath) return false;
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
  } catch (_error) {
    state = {};
  }
  state.offset = 0;
  state.updatedAt = new Date().toISOString();
  state.note = note;
  await ensureDir(path.dirname(queueStatePath));
  await fs.writeFile(queueStatePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return true;
}

async function dropZcodeQueueRows(filePath, { retainRetractions = false } = {}) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: 0, retractions: 0 };
    throw error;
  }
  const kept = [];
  const retractions = new Map();
  let removed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_error) {
      kept.push(line);
      continue;
    }
    if (row?.source === "zcode") {
      removed += 1;
      const model = typeof row.model === "string" && row.model.trim()
        ? row.model.trim()
        : "unknown";
      const hourStart = typeof row.hour_start === "string" ? row.hour_start : "";
      if (retainRetractions && hourStart) {
        retractions.set(`${model}|${hourStart}`, {
          source: "zcode",
          model,
          hour_start: hourStart,
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: 0,
          conversation_count: 0,
        });
      }
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) return { removed: 0, retractions: 0 };
  await backupExistingFile(filePath);
  const tmp = `${filePath}.zcoderepair.${process.pid}.${Date.now()}`;
  const rewritten = [
    ...kept,
    ...[...retractions.values()].map((row) => JSON.stringify(row)),
  ];
  await fs.writeFile(tmp, rewritten.length ? rewritten.join("\n") + "\n" : "", "utf8");
  await fs.rename(tmp, filePath);
  return { removed, retractions: retractions.size };
}

async function repairZcodeUsageMigration({
  migrationKey,
  queueStateNote,
  cursors,
  queuePath,
  queueStatePath,
  projectQueuePath,
  projectQueueStatePath,
} = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  if (migrations[migrationKey]) return false;

  const mainRepair = await dropZcodeQueueRows(queuePath, { retainRetractions: true });
  const projectRepair = projectQueuePath
    ? await dropZcodeQueueRows(projectQueuePath)
    : { removed: 0, retractions: 0 };

  const hourly = cursors.hourly && typeof cursors.hourly === "object" ? cursors.hourly : null;
  if (hourly?.buckets) {
    for (const key of Object.keys(hourly.buckets)) {
      if (key.startsWith("zcode|")) delete hourly.buckets[key];
    }
  }
  if (hourly?.groupQueued) {
    for (const key of Object.keys(hourly.groupQueued)) {
      if (key.startsWith("zcode|")) delete hourly.groupQueued[key];
    }
  }
  const projectHourly = cursors.projectHourly && typeof cursors.projectHourly === "object"
    ? cursors.projectHourly
    : null;
  if (projectHourly?.buckets) {
    for (const key of Object.keys(projectHourly.buckets)) {
      if (key.includes("|zcode|")) delete projectHourly.buckets[key];
    }
  }
  delete cursors.zcode;

  if (mainRepair.removed > 0) {
    await resetUploadOffsetForZcodeRepair(queueStatePath, queueStateNote);
  }
  if (projectRepair.removed > 0) {
    await resetUploadOffsetForZcodeRepair(projectQueueStatePath, queueStateNote);
  }
  migrations[migrationKey] = {
    appliedAt: new Date().toISOString(),
    removedMain: mainRepair.removed,
    removedProject: projectRepair.removed,
    retractions: mainRepair.retractions,
  };
  return true;
}

async function repairZcodeNativeUsageMigration(options = {}) {
  return repairZcodeUsageMigration({
    ...options,
    migrationKey: ZCODE_NATIVE_USAGE_REPAIR_KEY,
    queueStateNote: "reset_after_zcode_native_usage_repair_2026_08",
  });
}

async function repairZcodeInclusiveTokenMigration(options = {}) {
  return repairZcodeUsageMigration({
    ...options,
    migrationKey: ZCODE_INCLUSIVE_TOKEN_REPAIR_KEY,
    queueStateNote: "reset_after_zcode_inclusive_token_repair_2026_09",
  });
}

async function repairGrokQueueFromSessionSnapshots({ cursors, queuePath, queueStatePath } = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const grokState = (cursors.grok ||= {});
  const migrations = (grokState.migrations ||= {});
  if (hasAppliedGrokRepairMigration(migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY])) {
    return false;
  }

  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }

  const latestGrokRows = new Map();
  let existingGrokRows = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }

    if (normalizeGrokRepairSource(row?.source) === "grok") {
      const model = normalizeGrokRepairModel(row.model);
      const hourStart = typeof row.hour_start === "string" ? row.hour_start : null;
      if (!hourStart) continue;
      existingGrokRows += 1;
      latestGrokRows.set(bucketKey("grok", model, hourStart), {
        ...row,
        source: "grok",
        model,
        hour_start: hourStart,
      });
    }
  }

  if (existingGrokRows === 0) {
    migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY] = {
      status: "noop",
      appliedAt: new Date().toISOString(),
      existingGrokRows: 0,
      rowsWritten: 0,
      snapshotsUsed: 0,
      uploadOffsetReset: false,
    };
    return false;
  }

  const repairRows = buildGrokRepairRowsFromSnapshots(grokState.sessionSnapshots);
  if (repairRows.length === 0) {
    migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY] = {
      status: "skipped",
      appliedAt: new Date().toISOString(),
      reason: "missing-session-snapshots",
      existingGrokRows,
      rowsWritten: 0,
      snapshotsUsed: 0,
      uploadOffsetReset: false,
    };
    return false;
  }

  applyGrokRepairHourlyState(cursors, repairRows);

  const repairLines = [];
  const repairKeys = new Set();
  for (const row of repairRows) {
    const key = bucketKey("grok", row.model, row.hour_start);
    repairKeys.add(key);
    const current = latestGrokRows.get(key);
    if (current && totalsKey(current) === totalsKey(row)) continue;
    repairLines.push(serializeGrokRepairRow(row));
  }

  const zeroTotals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    billable_total_tokens: 0,
    conversation_count: 0,
  };
  let staleRowsRetracted = 0;
  for (const [key, row] of latestGrokRows.entries()) {
    if (repairKeys.has(key)) continue;
    if (totalsKey(row) === totalsKey(zeroTotals)) continue;
    staleRowsRetracted += 1;
    repairLines.push(serializeGrokRepairRow({
      ...zeroTotals,
      model: row.model,
      hour_start: row.hour_start,
    }));
  }

  if (repairLines.length === 0) {
    migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY] = {
      status: "noop",
      appliedAt: new Date().toISOString(),
      existingGrokRows,
      rowsWritten: 0,
      staleRowsRetracted,
      snapshotsUsed: repairRows.length,
      uploadOffsetReset: false,
    };
    return false;
  }

  await ensureDir(path.dirname(queuePath));
  const queueBackupPath = await backupExistingFile(queuePath);
  const queueStateBackupPath = await backupExistingFile(queueStatePath);
  await fs.appendFile(queuePath, `${repairLines.join("\n")}\n`, "utf8");

  const uploadOffsetReset = await resetGrokRepairUploadOffset(queueStatePath);
  migrations[GROK_APPEND_ONLY_REPAIR_MIGRATION_KEY] = {
    status: "applied",
    appliedAt: new Date().toISOString(),
    existingGrokRows,
    rowsWritten: repairLines.length,
    staleRowsRetracted,
    snapshotsUsed: Object.values(grokState.sessionSnapshots || {}).filter((snapshot) => {
      if (!snapshot || typeof snapshot !== "object") return false;
      if (Math.trunc(normalizeGrokRepairNumber(snapshot.totalTokens)) <= 0) return false;
      return Boolean(toGrokRepairHalfHourStart(snapshot.lastEventTimestamp || snapshot.updatedAt));
    }).length,
    uploadOffsetReset,
    queueBackupPath,
    queueStateBackupPath,
  };
  return true;
}

async function applyCloudConversationsBackfill({ cursors, queueStatePath }) {
  if (!cursors || typeof cursors !== "object") return false;
  cursors.migrations = cursors.migrations || {};
  if (cursors.migrations[CLOUD_CONVERSATIONS_BACKFILL_KEY]) return false;

  // Reset ONLY the cloud upload offset. The queue file itself is untouched;
  // ingest upserts are idempotent per (user, device, hour, source, model),
  // so replaying the whole queue is safe — it costs upload batches, not
  // correctness. Project queue is never uploaded and is not touched.
  let prevOffset = 0;
  try {
    const st = (await readJson(queueStatePath)) || {};
    prevOffset = Number(st.offset || 0);
  } catch (_e) {
    /* missing state file — nothing to reset */
  }
  if (prevOffset > 0) {
    await writeJson(queueStatePath, { offset: 0, updatedAt: new Date().toISOString() });
  }
  cursors.migrations[CLOUD_CONVERSATIONS_BACKFILL_KEY] = {
    appliedAt: new Date().toISOString(),
    previousOffset: prevOffset,
  };
  return prevOffset > 0;
}

async function migrateCursorUnknownBuckets({ cursors, queuePath }) {
  if (!cursors || typeof cursors !== "object") return;
  cursors.migrations = cursors.migrations || {};
  if (cursors.migrations[CURSOR_UNKNOWN_MIGRATION_KEY]) return;

  const buckets = cursors.hourly?.buckets;
  if (!buckets || typeof buckets !== "object") {
    cursors.migrations[CURSOR_UNKNOWN_MIGRATION_KEY] = new Date().toISOString();
    return;
  }

  const retractions = [];
  for (const key of Object.keys(buckets)) {
    if (!key.startsWith("cursor|unknown|")) continue;
    const hourStart = key.split("|").slice(2).join("|");
    retractions.push(
      JSON.stringify({
        source: "cursor",
        model: "unknown",
        hour_start: hourStart,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        conversation_count: 0,
      }),
    );
    delete buckets[key];
  }

  if (retractions.length > 0) {
    await ensureDir(path.dirname(queuePath));
    await fs.appendFile(queuePath, retractions.join("\n") + "\n");
    if (cursors.cursorApi) {
      cursors.cursorApi.lastRecordTimestamp = null;
    }
  }

  cursors.migrations[CURSOR_UNKNOWN_MIGRATION_KEY] = new Date().toISOString();
}

async function migrateRolloutCumulativeDeltaBuckets({ cursors, queuePath, rolloutFiles }) {
  if (!cursors || typeof cursors !== "object") return;
  cursors.migrations = cursors.migrations || {};
  if (cursors.migrations[ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY]) return;

  const rolloutPathSources = new Map();
  for (const entry of Array.isArray(rolloutFiles) ? rolloutFiles : []) {
    const filePath = typeof entry === "string" ? entry : entry?.path;
    const source = typeof entry === "string" ? "codex" : String(entry?.source || "codex");
    if (!filePath) continue;
    if (source === "codex" || source === "every-code") {
      rolloutPathSources.set(filePath, source);
    }
  }

  if (cursors.files && typeof cursors.files === "object") {
    for (const filePath of rolloutPathSources.keys()) {
      delete cursors.files[filePath];
    }
  }
  // The migration clears Codex buckets and reparses the discovered corpus from
  // byte zero. Persisted event keys belong to the cleared buckets, so retaining
  // them can suppress the rebuild when a moved session still has an old path
  // cursor. Rebuild the hash inventory together with the buckets.
  cursors.codexHashes = [];

  const buckets = cursors.hourly?.buckets;
  const retractions = [];
  if (buckets && typeof buckets === "object") {
    for (const key of Object.keys(buckets)) {
      const [source, model, ...hourParts] = key.split("|");
      if (source !== "codex" && source !== "every-code") continue;
      const hourStart = hourParts.join("|");
      retractions.push(
        JSON.stringify({
          source,
          model: model || "unknown",
          hour_start: hourStart,
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: 0,
          billable_total_tokens: 0,
          conversation_count: 0,
        }),
      );
      delete buckets[key];
    }
  }

  const groupQueued = cursors.hourly?.groupQueued;
  if (groupQueued && typeof groupQueued === "object") {
    for (const key of Object.keys(groupQueued)) {
      if (key.startsWith("codex|") || key.startsWith("every-code|")) {
        delete groupQueued[key];
      }
    }
  }

  if (retractions.length > 0) {
    await ensureDir(path.dirname(queuePath));
    await fs.appendFile(queuePath, retractions.join("\n") + "\n");
  }

  cursors.migrations[ROLLOUT_CUMULATIVE_DELTA_MIGRATION_KEY] = new Date().toISOString();
}

function codebuddyUsageRowKey(row) {
  if (!row || row.source !== "codebuddy") return null;
  const model = typeof row.model === "string" && row.model ? row.model : "unknown";
  const hourStart = typeof row.hour_start === "string" && row.hour_start ? row.hour_start : null;
  return hourStart ? bucketKey("codebuddy", model, hourStart) : null;
}

function codebuddyZeroUsageRow(model, hourStart) {
  return {
    source: "codebuddy",
    model: model || "unknown",
    hour_start: hourStart,
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

// Issue #403 historical repair. Before the JSONL usage fix, CodeBuddy could
// ingest the same round-trip once from ~/.codebuddy/projects and once from the
// IDE extension log. The forward resolver now disables logs whenever any JSONL
// has usable rawUsage, but existing queues/hourly state need one guarded,
// atomic rebuild so the old double-count is not left visible forever.
async function repairCodebuddyLogJsonlOverlap({
  cursors,
  queuePath,
  queueStatePath,
  codebuddyFiles,
  env = process.env,
} = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  const prior = migrations[CODEBUDDY_LOG_JSONL_REPAIR_KEY];
  if (prior && !(typeof prior === "object" && prior.skipped)) return false;

  const files = Array.isArray(codebuddyFiles) ? codebuddyFiles : [];
  const jsonlFiles = files.filter((filePath) => typeof filePath === "string" && filePath.endsWith(".jsonl"));
  const logFiles = files.filter((filePath) => typeof filePath === "string" && filePath.endsWith(".log"));
  const hasDetailedJsonl = jsonlFiles.some((filePath) => codebuddyJsonlHasUsage(filePath));

  const hourly = cursors.hourly && typeof cursors.hourly === "object" ? cursors.hourly : {};
  const liveHourlyKeys = new Set(
    Object.keys(hourly.buckets || {}).filter((key) => key.startsWith("codebuddy|")),
  );
  let queueRaw = "";
  try {
    queueRaw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const queueCodebuddyKeys = new Set();
  const keptQueueLines = [];
  for (const line of queueRaw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      keptQueueLines.push(line);
      continue;
    }
    const key = codebuddyUsageRowKey(row);
    if (!key) {
      keptQueueLines.push(line);
      continue;
    }
    queueCodebuddyKeys.add(key);
  }
  const liveKeys = new Set([...liveHourlyKeys, ...queueCodebuddyKeys]);
  if (liveKeys.size === 0) {
    migrations[CODEBUDDY_LOG_JSONL_REPAIR_KEY] = {
      status: "noop",
      appliedAt: new Date().toISOString(),
      reason: "no-codebuddy-history",
    };
    return false;
  }

  // Keep this condition retryable when old CodeBuddy history exists but the
  // extension log is temporarily rotated/missing. A permanent no-op here
  // would close the repair window before a later full scan can rediscover it.
  if (jsonlFiles.length === 0 || logFiles.length === 0 || !hasDetailedJsonl) {
    migrations[CODEBUDDY_LOG_JSONL_REPAIR_KEY] = {
      skipped: true,
      reason: "no-mixed-detailed-sources",
      at: new Date().toISOString(),
    };
    return false;
  }

  // A rebuild from the currently discoverable JSONL is safe only if every
  // file previously tailed by CodeBuddy is still available in this scan. If a
  // rotated/deleted log is missing, retain the user's history and retry later
  // rather than silently erasing an unreproducible bucket.
  const discovered = new Set(files);
  const priorFiles = cursors.codebuddy?.fileOffsets && typeof cursors.codebuddy.fileOffsets === "object"
    ? Object.keys(cursors.codebuddy.fileOffsets)
    : [];
  const missingPriorFile = priorFiles.find((filePath) => !discovered.has(filePath));
  if (missingPriorFile) {
    migrations[CODEBUDDY_LOG_JSONL_REPAIR_KEY] = {
      skipped: true,
      reason: "codebuddy_file_unreproducible",
      filePath: missingPriorFile,
      at: new Date().toISOString(),
    };
    return false;
  }

  const tmpQueue = `${queuePath}.codebuddyrebuild.${process.pid}.${Date.now()}`;
  const tmpCursors = {
    version: 1,
    hourly: { buckets: {}, groupQueued: {} },
    codebuddy: {},
  };
  let rebuiltRows = [];
  try {
    await parseCodebuddyIncremental({
      // Rebuild from both sources. The parser now preserves legacy-only log
      // sessions while consuming mirrored log fingerprints against JSONL, so
      // rebuilding JSONL alone would silently discard valid pre-rawUsage data.
      projectFiles: files,
      cursors: tmpCursors,
      queuePath: tmpQueue,
      env,
    });
    let rebuiltRaw = "";
    try {
      rebuiltRaw = await fs.readFile(tmpQueue, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    rebuiltRows = rebuiltRaw.split("\n").filter((line) => line.trim());
  } catch (e) {
    console.error("[sync] CodeBuddy log/JSONL repair: rebuild failed, leaving history untouched:", e?.message || e);
    return false;
  } finally {
    await fs.rm(tmpQueue, { force: true }).catch(() => {});
  }

  const rebuiltKeys = new Set();
  const validRebuiltRows = [];
  for (const line of rebuiltRows) {
    let row;
    try { row = JSON.parse(line); } catch (_e) { continue; }
    const key = codebuddyUsageRowKey(row);
    if (!key) continue;
    rebuiltKeys.add(key);
    validRebuiltRows.push(line);
  }
  if (rebuiltKeys.size === 0) {
    migrations[CODEBUDDY_LOG_JSONL_REPAIR_KEY] = {
      skipped: true,
      reason: "jsonl_rebuild_empty",
      at: new Date().toISOString(),
    };
    return false;
  }

  const staleRetractions = [];
  for (const key of liveKeys) {
    if (rebuiltKeys.has(key)) continue;
    const [, model, ...hourParts] = key.split("|");
    staleRetractions.push(JSON.stringify(codebuddyZeroUsageRow(model, hourParts.join("|"))));
  }

  const nextQueueLines = keptQueueLines.concat(staleRetractions, validRebuiltRows);
  await ensureDir(path.dirname(queuePath));
  const queueTmp = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(queueTmp, nextQueueLines.length ? `${nextQueueLines.join("\n")}\n` : "", "utf8");
  await fs.rename(queueTmp, queuePath);

  const nextHourly = (cursors.hourly ||= { buckets: {}, groupQueued: {} });
  nextHourly.buckets ||= {};
  nextHourly.groupQueued ||= {};
  for (const key of Object.keys(nextHourly.buckets)) {
    if (key.startsWith("codebuddy|")) delete nextHourly.buckets[key];
  }
  for (const key of Object.keys(nextHourly.groupQueued)) {
    if (key.startsWith("codebuddy|")) delete nextHourly.groupQueued[key];
  }
  for (const [key, bucket] of Object.entries(tmpCursors.hourly.buckets || {})) {
    if (key.startsWith("codebuddy|")) nextHourly.buckets[key] = bucket;
  }
  for (const [key, value] of Object.entries(tmpCursors.hourly.groupQueued || {})) {
    if (key.startsWith("codebuddy|")) nextHourly.groupQueued[key] = value;
  }
  cursors.codebuddy = tmpCursors.codebuddy || {};

  let uploadState = {};
  try { uploadState = JSON.parse(await fs.readFile(queueStatePath, "utf8")); } catch (_e) {}
  uploadState.offset = 0;
  uploadState.updatedAt = new Date().toISOString();
  uploadState.note = "reset_after_codebuddy_log_jsonl_repair_2026_08";
  await ensureDir(path.dirname(queueStatePath));
  await fs.writeFile(queueStatePath, JSON.stringify(uploadState, null, 2) + "\n", "utf8");

  migrations[CODEBUDDY_LOG_JSONL_REPAIR_KEY] = {
    status: "applied",
    appliedAt: new Date().toISOString(),
    jsonlFiles: jsonlFiles.length,
    logFiles: logFiles.length,
    previousBuckets: liveKeys.size,
    rebuiltBuckets: rebuiltKeys.size,
    retractedBuckets: staleRetractions.length,
  };
  return true;
}

// WorkBuddy's 0.87.9 SQLite fallback treated the bounded session_usage.used
// context snapshot as cumulative input tokens. A current database proves that
// assumption false (`size` is a 192k context limit while trace input totals can
// exceed it), so rebuild historical WorkBuddy buckets from JSONL/trace sources
// once the new parser is available. The same missing-source guard used by the
// other data migrations keeps this recoverable: if a previously contributing
// file is gone, leave history untouched and stop adding new context snapshots.
async function repairWorkbuddyContextUsage({
  cursors,
  queuePath,
  queueStatePath,
  workbuddyFiles,
  env = process.env,
} = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  const prior = migrations[WORKBUDDY_CONTEXT_USAGE_REPAIR_KEY];
  if (prior && !(typeof prior === "object" && prior.skipped)) return false;

  const hourly = cursors.hourly && typeof cursors.hourly === "object" ? cursors.hourly : {};
  const liveHourlyKeys = new Set(
    Object.keys(hourly.buckets || {}).filter((key) => key.startsWith("workbuddy|")),
  );
  let queueRaw = "";
  try {
    queueRaw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const queueWorkbuddyKeys = new Set();
  const keptQueueLines = [];
  for (const line of queueRaw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch (_e) {
      keptQueueLines.push(line);
      continue;
    }
    if (row && row.source === "workbuddy" && typeof row.model === "string" && typeof row.hour_start === "string") {
      queueWorkbuddyKeys.add(bucketKey("workbuddy", row.model || "unknown", row.hour_start));
    } else {
      keptQueueLines.push(line);
    }
  }
  const liveKeys = new Set([...liveHourlyKeys, ...queueWorkbuddyKeys]);
  if (liveKeys.size === 0) {
    migrations[WORKBUDDY_CONTEXT_USAGE_REPAIR_KEY] = {
      status: "noop",
      appliedAt: new Date().toISOString(),
      reason: "no-workbuddy-history",
    };
    return false;
  }

  const files = Array.isArray(workbuddyFiles) ? workbuddyFiles : [];
  const discoveredPaths = new Set(
    files.map((entry) => typeof entry === "string" ? entry : entry?.path).filter(Boolean),
  );
  const priorFiles = cursors.workbuddy?.fileOffsets && typeof cursors.workbuddy.fileOffsets === "object"
    ? Object.keys(cursors.workbuddy.fileOffsets)
    : [];
  if (files.length === 0 || priorFiles.some((filePath) => !discoveredPaths.has(filePath))) {
    migrations[WORKBUDDY_CONTEXT_USAGE_REPAIR_KEY] = {
      skipped: true,
      reason: files.length === 0 ? "no-rebuild-sources" : "workbuddy_file_unreproducible",
      at: new Date().toISOString(),
    };
    return false;
  }

  const tmpQueue = `${queuePath}.workbuddyrebuild.${process.pid}.${Date.now()}`;
  const tmpCursors = {
    version: 1,
    hourly: { buckets: {}, groupQueued: {} },
    workbuddy: {},
  };
  let rebuiltRows = [];
  try {
    await parseWorkbuddyIncremental({
      projectFiles: files,
      cursors: tmpCursors,
      queuePath: tmpQueue,
      env,
    });
    let rebuiltRaw = "";
    try { rebuiltRaw = await fs.readFile(tmpQueue, "utf8"); } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    rebuiltRows = rebuiltRaw.split("\n").filter((line) => line.trim());
  } catch (e) {
    console.error("[sync] WorkBuddy context-usage repair: rebuild failed, leaving history untouched:", e?.message || e);
    return false;
  } finally {
    await fs.rm(tmpQueue, { force: true }).catch(() => {});
  }

  const rebuiltKeys = new Set();
  const validRebuiltRows = [];
  for (const line of rebuiltRows) {
    let row;
    try { row = JSON.parse(line); } catch (_e) { continue; }
    if (!row || row.source !== "workbuddy" || typeof row.model !== "string" || typeof row.hour_start !== "string") continue;
    rebuiltKeys.add(bucketKey("workbuddy", row.model || "unknown", row.hour_start));
    validRebuiltRows.push(line);
  }

  const staleRetractions = [];
  for (const key of liveKeys) {
    if (rebuiltKeys.has(key)) continue;
    const [, model, ...hourParts] = key.split("|");
    staleRetractions.push(JSON.stringify({
      source: "workbuddy",
      model: model || "unknown",
      hour_start: hourParts.join("|"),
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      billable_total_tokens: 0,
      conversation_count: 0,
    }));
  }

  const nextQueueLines = keptQueueLines.concat(staleRetractions, validRebuiltRows);
  await ensureDir(path.dirname(queuePath));
  const queueTmp = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(queueTmp, nextQueueLines.length ? `${nextQueueLines.join("\n")}\n` : "", "utf8");
  await fs.rename(queueTmp, queuePath);

  const nextHourly = (cursors.hourly ||= { buckets: {}, groupQueued: {} });
  nextHourly.buckets ||= {};
  nextHourly.groupQueued ||= {};
  for (const key of Object.keys(nextHourly.buckets)) {
    if (key.startsWith("workbuddy|")) delete nextHourly.buckets[key];
  }
  for (const key of Object.keys(nextHourly.groupQueued)) {
    if (key.startsWith("workbuddy|")) delete nextHourly.groupQueued[key];
  }
  for (const [key, bucket] of Object.entries(tmpCursors.hourly.buckets || {})) {
    if (key.startsWith("workbuddy|")) nextHourly.buckets[key] = bucket;
  }
  for (const [key, value] of Object.entries(tmpCursors.hourly.groupQueued || {})) {
    if (key.startsWith("workbuddy|")) nextHourly.groupQueued[key] = value;
  }
  cursors.workbuddy = tmpCursors.workbuddy || {};

  let uploadState = {};
  try { uploadState = JSON.parse(await fs.readFile(queueStatePath, "utf8")); } catch (_e) {}
  uploadState.offset = 0;
  uploadState.updatedAt = new Date().toISOString();
  uploadState.note = "reset_after_workbuddy_context_usage_repair_2026_08";
  await ensureDir(path.dirname(queueStatePath));
  await fs.writeFile(queueStatePath, JSON.stringify(uploadState, null, 2) + "\n", "utf8");

  migrations[WORKBUDDY_CONTEXT_USAGE_REPAIR_KEY] = {
    status: "applied",
    appliedAt: new Date().toISOString(),
    previousBuckets: liveKeys.size,
    rebuiltBuckets: rebuiltKeys.size,
    retractedBuckets: staleRetractions.length,
  };
  return true;
}

// One-time repair (#187): rebuild codex hourly buckets that the inode-keyed
// re-scan double-counted before the codexHashes event-dedup landed, and push
// the corrected values to the cloud. Runs BEFORE the codex parse in the same
// sync: it clears codex hourly state + codexHashes so the parse rebuilds clean,
// atomically strips the inflated codex rows from queue.jsonl, and resets the
// upload offset so the re-uploaded clean rows overwrite the cloud (with no
// stale-high codex rows left in the queue, the ingest's within-batch MAX keeps
// nothing larger, so its overwrite-upsert replaces the inflated cloud rows).
//
// GUARDED against the v6 ground-truth-repair data-loss incident: a clear+reparse
// rebuilds codex buckets ONLY from the codex files this sync re-parses (now both
// sessions/ AND archived_sessions/), so if any codex file that previously
// contributed is gone from disk (genuinely deleted — Codex-Manager log rotation
// or user cleanup) the migration is skipped entirely — the forward dedup fix
// still prevents new double-counting; only this historical correction is deferred.
async function repairCodexRescanInflation({
  cursors,
  queuePath,
  queueStatePath,
  projectQueuePath,
  projectQueueStatePath,
  rolloutFiles,
  expectedCodexFileSnapshots = null,
  // The fork-replay repair (#169 follow-up) re-runs this exact rebuild under
  // its own key: the rebuild always uses the CURRENT parser, so any parser fix
  // shipped since the last run is applied to the rebuilt history.
  migrationKey = CODEX_RESCAN_DEDUP_REPAIR_KEY,
  uploadNote = "reset_after_codex_rescan_dedup_2026_06",
}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  // A COMPLETED run writes an ISO-string timestamp (final — never re-run). A
  // prior SKIP writes an object {skipped:true} and MUST be retried: the skip
  // condition can clear in a later version (e.g. v0.53.4 started scanning
  // archived_sessions/, so a session that was "unscanned" under v0.53.3 is now
  // found). Treating the skip sentinel as "done" is what left users like #187
  // permanently stuck on the inflated value after upgrading (the key was truthy
  // so the guard never got a second chance).
  const priorRepair = migrations[migrationKey];
  if (priorRepair && !(typeof priorRepair === "object" && priorRepair.skipped)) return false;

  // Codex session files THIS sync discovered (source === "codex").
  const codexFiles = [];
  for (const entry of Array.isArray(rolloutFiles) ? rolloutFiles : []) {
    const fp = typeof entry === "string" ? entry : entry?.path;
    const src = typeof entry === "string" ? "codex" : String(entry?.source || "codex");
    if (fp && src === "codex") codexFiles.push(fp);
  }
  const codexFileSet = new Set(codexFiles);
  const projectRepairEnabled = typeof projectQueuePath === "string" && projectQueuePath.length > 0;

  // GUARD (data-loss prevention, ref the v6 ground-truth-repair incident): the
  // rebuild can only reproduce buckets from the files this sync re-parses
  // (codexFiles, now covering sessions/ AND archived_sessions/). If a session
  // that previously contributed can no longer be reproduced, skip entirely —
  // the forward dedup fix still stops NEW double-counting; only this historical
  // correction defers.
  //
  // Reproducibility is keyed on the session UUID, NOT the exact cursor path:
  // Codex-Manager MOVES a file sessions/ -> archived_sessions/ (path changes,
  // UUID does not). A path-based check false-positives on every moved file as
  // "missing" and skips forever (issue #187, easonlee05). Genuinely deleted
  // sessions (no file with that UUID anywhere in the scan) still defer.
  const scannedSessionIds = new Set();
  for (const fp of codexFiles) {
    const id = codexSessionIdFromPath(fp);
    if (id) scannedSessionIds.add(id);
  }
  if (cursors.files && typeof cursors.files === "object") {
    for (const fp of Object.keys(cursors.files)) {
      if (!isCodexSessionCursorPath(fp)) continue;
      if (codexFileSet.has(fp)) continue; // exact file re-scanned this run
      const id = codexSessionIdFromPath(fp);
      if (id && scannedSessionIds.has(id)) continue; // same session scanned elsewhere (moved)
      migrations[migrationKey] = {
        skipped: true,
        reason: "codex_session_unreproducible",
        at: new Date().toISOString(),
      };
      return false;
    }
  }

  // ATOMIC REBUILD into a THROWAWAY cursors + queue: never touch the live
  // buckets/queue until the rebuild has fully succeeded. If anything throws we
  // return WITHOUT mutating any persistent state and the migration retries next
  // sync (the key is not set). This is the crucial difference from a
  // "clear-then-rely-on-the-later-parse" design: the later parse's failure is
  // swallowed (warnProviderParseFailure) and cursors are saved regardless, which
  // would permanently zero a user's codex history.
  let rebuilt;
  const tmpQueue = `${queuePath}.codexrebuild.${process.pid}.${Date.now()}`;
  const tmpProjectQueue = projectRepairEnabled
    ? `${projectQueuePath}.codexrebuild.${process.pid}.${Date.now()}`
    : null;
  try {
    const tmpCursors = {
      version: 1,
      files: {},
      hourly: { buckets: {}, groupQueued: {} },
      codexHashes: [],
    };
    await parseRolloutIncremental({
      rolloutFiles: codexFiles.map((p) => ({ path: p, source: "codex" })),
      cursors: tmpCursors,
      queuePath: tmpQueue,
      projectQueuePath: tmpProjectQueue,
      invalidRecordPolicy: "throw",
    });
    let tmpRaw = "";
    try {
      tmpRaw = await fs.readFile(tmpQueue, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    let tmpProjectRaw = "";
    if (tmpProjectQueue) {
      try {
        tmpProjectRaw = await fs.readFile(tmpProjectQueue, "utf8");
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
    }
    rebuilt = {
      buckets: tmpCursors.hourly.buckets || {},
      groupQueued: tmpCursors.hourly.groupQueued || {},
      codexHashes: Array.isArray(tmpCursors.codexHashes) ? tmpCursors.codexHashes : [],
      files: tmpCursors.files || {},
      queueRows: tmpRaw.split("\n").filter((l) => l.trim()),
      projectHourly: tmpCursors.projectHourly || null,
      projectQueueRows: tmpProjectRaw.split("\n").filter((l) => l.trim()),
    };
  } catch (e) {
    console.error(
      "[sync] codex rescan repair: rebuild failed, leaving all data untouched:",
      e?.message || e,
    );
    return false;
  } finally {
    await fs.rm(tmpQueue, { force: true }).catch(() => {});
    if (tmpProjectQueue) await fs.rm(tmpProjectQueue, { force: true }).catch(() => {});
  }

  // SANITY: codex files exist on disk but the rebuild produced no codex buckets
  // → treat as a failed rebuild and skip (do NOT clear live data, do NOT set the
  // key — retry next sync).
  const rebuiltCodexKeys = Object.keys(rebuilt.buckets).filter((k) => k.startsWith("codex|"));
  if (codexFiles.length > 0 && rebuiltCodexKeys.length === 0) {
    console.error(
      `[sync] codex rescan repair: rebuild produced 0 codex buckets from ${codexFiles.length} files — skipping to avoid data loss`,
    );
    return false;
  }
  if (projectRepairEnabled) {
    const malformedProjectRows = await countMalformedCodexProjectQueueRows(projectQueuePath);
    if (malformedProjectRows > 0) {
      console.error(
        `[sync] codex rescan repair: found ${malformedProjectRows} malformed codex project queue row(s) — skipping to avoid data loss`,
      );
      return false;
    }

    const existingProjectKeys = new Set([
      ...(await projectUsageKeysFromQueuePath(projectQueuePath, "codex")),
      ...projectUsageKeysFromState(cursors.projectHourly, "codex"),
    ]);
    const rebuiltProjectKeys = new Set([
      ...projectUsageKeysFromQueueRows(rebuilt.projectQueueRows, "codex"),
      ...projectUsageKeysFromState(rebuilt.projectHourly, "codex"),
    ]);
    const missingProjectKeys = [...existingProjectKeys].filter((key) => !rebuiltProjectKeys.has(key));
    if (missingProjectKeys.length > 0) {
      console.error(
        `[sync] codex rescan repair: project rebuild missed ${missingProjectKeys.length} existing codex project bucket(s) — skipping to avoid data loss`,
      );
      return false;
    }

    const existingProjectTotals = mergeMaxTotals(
      await projectUsageTotalsFromQueuePath(projectQueuePath, "codex"),
      projectUsageTotalsFromState(cursors.projectHourly, "codex"),
    );
    const rebuiltProjectTotals = mergeMaxTotals(
      projectUsageTotalsFromQueueRows(rebuilt.projectQueueRows, "codex"),
      projectUsageTotalsFromState(rebuilt.projectHourly, "codex"),
    );
    const existingMainHourTotals = mergeMaxTotals(
      await mainUsageHourTotalsFromQueuePath(queuePath, "codex"),
      mainUsageHourTotalsFromState(cursors.hourly, "codex"),
    );
    const rebuiltMainHourTotals = mergeMaxTotals(
      mainUsageHourTotalsFromQueueRows(rebuilt.queueRows, "codex"),
      mainUsageHourTotalsFromState({ buckets: rebuilt.buckets }, "codex"),
    );
    const partialProjectKeys = [];
    for (const [key, existingTotal] of existingProjectTotals.entries()) {
      const rebuiltTotal = rebuiltProjectTotals.get(key);
      if (!Number.isFinite(rebuiltTotal) || rebuiltTotal >= existingTotal) continue;
      const [, source, hourStart] = key.split("|");
      const mainKey = `${source}|${hourStart}`;
      const existingMainTotal = existingMainHourTotals.get(mainKey) || 0;
      const rebuiltMainTotal = rebuiltMainHourTotals.get(mainKey) || 0;
      if (rebuiltMainTotal >= existingMainTotal) partialProjectKeys.push(key);
    }
    if (partialProjectKeys.length > 0) {
      console.error(
        `[sync] codex rescan repair: project rebuild lowered ${partialProjectKeys.length} existing codex project bucket(s) without a matching main-bucket repair — skipping to avoid data loss`,
      );
      return false;
    }
  }

  const rebuildValidation = expectedCodexFileSnapshots instanceof Map
    ? await validateCodexRebuildFileSnapshots(rebuilt.files, expectedCodexFileSnapshots)
    : { ok: true };
  if (!rebuildValidation.ok) {
    console.error(
      `[sync] codex rescan repair: ${rebuildValidation.reason} — skipping to avoid data loss`,
    );
    return false;
  }

  // COMMIT (only after a verified rebuild). A crash partway just leaves the
  // migration to re-run next sync — re-rebuild + re-strip + re-commit converges.
  //
  // 1. queue.jsonl: drop the inflated codex rows, append the clean rebuilt ones
  //    (atomic tmp+rename). With no old-high codex rows left, the cloud ingest's
  //    within-batch MAX keeps nothing larger and its overwrite-upsert replaces
  //    the inflated cloud rows on the next upload.
  if (typeof queuePath === "string" && queuePath) {
    let raw = "";
    try {
      raw = await fs.readFile(queuePath, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    const kept = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (_e) {
        kept.push(line);
        continue;
      }
      if (row?.source === "codex") continue;
      kept.push(line);
    }
    await ensureDir(path.dirname(queuePath));
    const tmp = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, kept.concat(rebuilt.queueRows).join("\n") + "\n", "utf8");
    await fs.rename(tmp, queuePath);
  }

  // 2. Swap the live codex hourly state for the rebuilt one, and install the
  //    rebuilt per-file cursors (offset at EOF) so the later parse in THIS sync
  //    does not re-read codex (which would re-inflate project buckets).
  const hourly = (cursors.hourly ||= { buckets: {}, groupQueued: {} });
  hourly.buckets ||= {};
  hourly.groupQueued ||= {};
  for (const k of Object.keys(hourly.buckets)) {
    if (k.startsWith("codex|")) delete hourly.buckets[k];
  }
  for (const k of Object.keys(hourly.groupQueued)) {
    if (k.startsWith("codex|")) delete hourly.groupQueued[k];
  }
  for (const [k, v] of Object.entries(rebuilt.buckets)) {
    if (k.startsWith("codex|")) hourly.buckets[k] = v;
  }
  for (const [k, v] of Object.entries(rebuilt.groupQueued)) {
    if (k.startsWith("codex|")) hourly.groupQueued[k] = v;
  }
  cursors.files ||= {};
  for (const fp of Object.keys(cursors.files)) {
    if (isCodexSessionCursorPath(fp)) delete cursors.files[fp];
  }
  for (const [fp, v] of Object.entries(rebuilt.files)) {
    cursors.files[fp] = v;
  }
  cursors.codexHashes = rebuilt.codexHashes;

  // 3. Project usage mirrors the main Codex repair: drop inflated Codex project
  //    rows, append the rebuilt rows, and swap only Codex project buckets. Project
  //    metadata is merged so visibility/purge state from non-Codex sources stays.
  if (projectRepairEnabled) {
    let projectRaw = "";
    try {
      projectRaw = await fs.readFile(projectQueuePath, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    const keptProjectRows = [];
    for (const line of projectRaw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (_e) {
        keptProjectRows.push(line);
        continue;
      }
      if (row?.source === "codex") continue;
      keptProjectRows.push(line);
    }
    await ensureDir(path.dirname(projectQueuePath));
    const tmp = `${projectQueuePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(
      tmp,
      keptProjectRows.concat(rebuilt.projectQueueRows).join("\n") + "\n",
      "utf8",
    );
    await fs.rename(tmp, projectQueuePath);

    const projectHourly = (cursors.projectHourly ||= { version: 2, buckets: {}, projects: {} });
    projectHourly.version = 2;
    projectHourly.buckets ||= {};
    projectHourly.projects ||= {};
    for (const [key, bucket] of Object.entries(projectHourly.buckets)) {
      const source = typeof bucket?.source === "string" ? bucket.source : key.split("|")[1];
      if (source === "codex") delete projectHourly.buckets[key];
    }
    const rebuiltProjectHourly = rebuilt.projectHourly || {};
    for (const [key, bucket] of Object.entries(rebuiltProjectHourly.buckets || {})) {
      const source = typeof bucket?.source === "string" ? bucket.source : key.split("|")[1];
      if (source === "codex") projectHourly.buckets[key] = bucket;
    }
    for (const [key, meta] of Object.entries(rebuiltProjectHourly.projects || {})) {
      if (meta && typeof meta === "object") projectHourly.projects[key] = meta;
    }
    projectHourly.updatedAt = new Date().toISOString();
  }

  // 4. Reset the cloud upload offset so the corrected queue re-uploads. Other
  //    sources re-upsert idempotently (last emission per key wins).
  if (typeof queueStatePath === "string" && queueStatePath) {
    let uploadState = {};
    try {
      uploadState = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
    } catch (_e) {
      uploadState = {};
    }
    uploadState.offset = 0;
    uploadState.updatedAt = new Date().toISOString();
    uploadState.note = uploadNote;
    await fs.writeFile(queueStatePath, JSON.stringify(uploadState));
  }
  if (projectRepairEnabled && typeof projectQueueStatePath === "string" && projectQueueStatePath) {
    let uploadState = {};
    try {
      uploadState = JSON.parse(await fs.readFile(projectQueueStatePath, "utf8"));
    } catch (_e) {
      uploadState = {};
    }
    uploadState.offset = 0;
    uploadState.updatedAt = new Date().toISOString();
    uploadState.note = uploadNote;
    await fs.writeFile(projectQueueStatePath, JSON.stringify(uploadState));
  }

  migrations[migrationKey] = new Date().toISOString();
  return true;
}

// #169 follow-up: repair the historical inflation left by same-day forked
// Codex rollout replays (see CODEX_FORK_REPLAY_REPAIR_KEY). Delegates to the
// #187 guarded rebuild with the fork-repair key.
async function repairCodexForkReplayInflation({
  cursors,
  queuePath,
  queueStatePath,
  projectQueuePath,
  projectQueueStatePath,
  rolloutFiles,
  // True when the #187 repair ran its rebuild earlier in THIS sync: that
  // rebuild already used the fork-aware parser, so the history is clean and a
  // second rebuild would be pure waste.
  legacyRepairRan = false,
}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  // Same completed-vs-skipped semantics as the #187 repair: an ISO string is
  // final, a {skipped:true} sentinel retries (the skip condition can clear).
  const prior = migrations[CODEX_FORK_REPLAY_REPAIR_KEY];
  if (prior && !(typeof prior === "object" && prior.skipped)) return false;

  if (legacyRepairRan) {
    migrations[CODEX_FORK_REPLAY_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  // Pre-gate: fork phantom can only exist on installs that have (or had) a
  // forked rollout. Scanning file heads is cheap; the rebuild re-parses every
  // codex file. Files forked AFTER the parser fix shipped never accrue
  // phantom, so a definitive "no forks" verdict may finalize — but ONLY when
  // this scan can actually stand for the install's whole codex history:
  //   1. every candidate head was readable (an unreadable candidate could be
  //      the one forked rollout), AND
  //   2. every codex session recorded in cursors is covered by THIS scan's
  //      file list (same UUID-keyed reproducibility rule as the #187 guard).
  //      A forked rollout can be real yet absent from one run's rolloutFiles —
  //      WSL/native split probing, a temporarily missing ~/.codex, a deleted
  //      file whose phantom is already in history — and finalizing off such a
  //      partial view would permanently foreclose the repair this migration
  //      exists to perform, while the guarded repair itself would only have
  //      deferred retryably.
  // Either failure defers with the retryable {skipped:true} sentinel.
  const forkScan = await scanForForkedCodexRollout(rolloutFiles);
  if (!forkScan.forked) {
    if (forkScan.indeterminate) {
      migrations[CODEX_FORK_REPLAY_REPAIR_KEY] = {
        skipped: true,
        reason: "fork_scan_indeterminate",
        at: new Date().toISOString(),
      };
      return false;
    }
    const scannedSessionIds = new Set();
    const scannedPaths = new Set();
    for (const entry of Array.isArray(rolloutFiles) ? rolloutFiles : []) {
      const fp = typeof entry === "string" ? entry : entry?.path;
      const src = typeof entry === "string" ? "codex" : String(entry?.source || "codex");
      if (!fp || src !== "codex") continue;
      scannedPaths.add(fp);
      const id = codexSessionIdFromPath(fp);
      if (id) scannedSessionIds.add(id);
    }
    if (cursors.files && typeof cursors.files === "object") {
      for (const fp of Object.keys(cursors.files)) {
        if (!isCodexSessionCursorPath(fp)) continue;
        if (scannedPaths.has(fp)) continue;
        const id = codexSessionIdFromPath(fp);
        if (id && scannedSessionIds.has(id)) continue;
        migrations[CODEX_FORK_REPLAY_REPAIR_KEY] = {
          skipped: true,
          reason: "codex_history_not_covered",
          at: new Date().toISOString(),
        };
        return false;
      }
    }
    migrations[CODEX_FORK_REPLAY_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  return repairCodexRescanInflation({
    cursors,
    queuePath,
    queueStatePath,
    projectQueuePath,
    projectQueueStatePath,
    rolloutFiles,
    migrationKey: CODEX_FORK_REPLAY_REPAIR_KEY,
    uploadNote: "reset_after_codex_fork_replay_2026_07",
  });
}

// Rebuild historical Codex usage only when a rollout proves that the old
// single-baseline parser crossed cumulative SessionState lineages. Detection is
// based on the token counter stream itself, not multi_agent_version metadata:
// affected legacy rollouts can predate that marker or carry it only in the
// middle of a large file. Every contributing rollout must also be valid and
// stable before the atomic rebuild can replace live history.
async function repairCodexInterleavedUsageInflation({
  cursors,
  queuePath,
  queueStatePath,
  projectQueuePath,
  projectQueueStatePath,
  rolloutFiles,
  // Either older guarded repair rebuilt every Codex file with the current
  // parser earlier in this sync, so a second full rebuild is unnecessary.
  legacyRepairRan = false,
  maxLineageScanBytes = Infinity,
}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  const prior = migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY];
  if (prior && !(typeof prior === "object" && prior.skipped)) return false;

  if (legacyRepairRan) {
    migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  const scan = await scanForInterleavedCodexUsage(rolloutFiles, {
    maxLineageScanBytes,
  });
  if (scan.indeterminate) {
    migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY] = {
      skipped: true,
      reason: "usage_lineage_scan_indeterminate",
      at: new Date().toISOString(),
    };
    return false;
  }

  if (!scan.affected) {
    if (!isCodexHistoryCovered(cursors, rolloutFiles)) {
      migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY] = {
        skipped: true,
        reason: "codex_history_not_covered",
        at: new Date().toISOString(),
      };
      return false;
    }
    migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  return repairCodexRescanInflation({
    cursors,
    queuePath,
    queueStatePath,
    projectQueuePath,
    projectQueueStatePath,
    rolloutFiles,
    expectedCodexFileSnapshots: scan.fileSnapshots,
    migrationKey: CODEX_USAGE_LINEAGE_REPAIR_KEY,
    uploadNote: "reset_after_codex_usage_lineage_2026_07_v2",
  });
}

async function scanForInterleavedCodexUsage(
  rolloutFiles,
  { maxLineageScanBytes = Infinity } = {},
) {
  let affected = false;
  let remainingBytes = Number.isFinite(maxLineageScanBytes)
    ? Math.max(0, maxLineageScanBytes)
    : Infinity;
  const fileSnapshots = new Map();
  const seenPaths = new Set();

  for (const entry of Array.isArray(rolloutFiles) ? rolloutFiles : []) {
    const fp = typeof entry === "string" ? entry : entry?.path;
    const src = typeof entry === "string" ? "codex" : String(entry?.source || "codex");
    if (!fp || src !== "codex" || seenPaths.has(fp)) continue;
    seenPaths.add(fp);

    const lineage = await scanCodexUsageLineages(fp, remainingBytes);
    if (lineage.indeterminate) {
      return { affected: false, indeterminate: true, fileSnapshots: new Map() };
    }
    affected ||= lineage.affected;
    fileSnapshots.set(fp, lineage.fileSnapshot);
    if (Number.isFinite(remainingBytes)) {
      remainingBytes = Math.max(0, remainingBytes - lineage.bytesRead);
    }
  }
  return { affected, indeterminate: false, fileSnapshots };
}

async function scanCodexUsageLineages(filePath, maxBytes = Infinity) {
  let stream = null;
  try {
    const before = await readCodexFileSnapshot(filePath);
    const state = createUsageDeltaState();
    const byteLimit = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : Infinity;
    let bytesRead = 0;
    let affected = false;
    stream = fssync.createReadStream(filePath, { highWaterMark: 32 * 1024 });
    for await (const record of physicalJsonlRecords(stream, {
      maxPhysicalBytes: byteLimit,
    })) {
      const { line } = record;
      bytesRead += record.physicalBytes;
      if (bytesRead > byteLimit) return { affected: false, indeterminate: true };
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_e) {
        return { affected: false, indeterminate: true };
      }
      const token = extractTokenCount(obj);
      const info = token?.info;
      if (!info || typeof info !== "object") continue;
      consumeUsageDelta(state, info.last_token_usage, info.total_token_usage);
      if (state.sawInterleaved || state.sawDivergentCumulative) {
        affected = true;
      }
    }
    const after = await readCodexFileSnapshot(filePath);
    if (!sameCodexFileSnapshot(before, after)) {
      return { affected: false, indeterminate: true };
    }
    return {
      affected,
      indeterminate: false,
      bytesRead,
      fileSnapshot: after,
    };
  } catch (_e) {
    return { affected: false, indeterminate: true };
  } finally {
    if (stream) stream.destroy();
  }
}

async function readCodexFileSnapshot(filePath) {
  const stat = await fs.stat(filePath);
  return {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    ino: Number(stat.ino),
    dev: Number(stat.dev),
  };
}

function sameCodexFileSnapshot(left, right) {
  return Boolean(
    left &&
      right &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs &&
      left.ino === right.ino &&
      left.dev === right.dev
  );
}

async function validateCodexRebuildFileSnapshots(rebuiltFiles, expectedSnapshots) {
  for (const [filePath, expected] of expectedSnapshots) {
    let actual;
    try {
      actual = await readCodexFileSnapshot(filePath);
    } catch (_e) {
      return { ok: false, reason: "a scanned rollout became unreadable during rebuild" };
    }
    if (!sameCodexFileSnapshot(expected, actual)) {
      return { ok: false, reason: "a scanned rollout changed during rebuild" };
    }
    const rebuiltCursor = rebuiltFiles?.[filePath];
    if (!rebuiltCursor) {
      return { ok: false, reason: "the rebuild omitted a scanned rollout cursor" };
    }
    if (Number(rebuiltCursor.offset) !== expected.size) {
      return { ok: false, reason: "the rebuild did not consume a scanned rollout through EOF" };
    }
  }
  return { ok: true };
}

function isCodexHistoryCovered(cursors, rolloutFiles) {
  const scannedPaths = new Set();
  const scannedSessionIds = new Set();
  for (const entry of Array.isArray(rolloutFiles) ? rolloutFiles : []) {
    const fp = typeof entry === "string" ? entry : entry?.path;
    const src = typeof entry === "string" ? "codex" : String(entry?.source || "codex");
    if (!fp || src !== "codex") continue;
    scannedPaths.add(fp);
    const id = codexSessionIdFromPath(fp);
    if (id) scannedSessionIds.add(id);
  }
  if (!cursors.files || typeof cursors.files !== "object") return true;
  for (const fp of Object.keys(cursors.files)) {
    if (!isCodexSessionCursorPath(fp)) continue;
    if (scannedPaths.has(fp)) continue;
    const id = codexSessionIdFromPath(fp);
    if (id && scannedSessionIds.has(id)) continue;
    return false;
  }
  return true;
}

// Scans codex rollout heads for the fork marker. The child session_meta (with
// forked_from_id) is the FIRST line of a forked rollout — observed at byte
// offset ≤169 across every local sample — so a bounded head read is
// sufficient. 64KB leaves ample margin for long base_instructions preceding
// it; a substring false positive (the marker quoted in unrelated head content)
// only costs one redundant guarded rebuild, never data. Tri-state result:
// {forked:true} on a hit, {forked:false, indeterminate:false} only when every
// candidate was inspected, {forked:false, indeterminate:true} when any head
// read failed — the caller must not finalize "no forks" off a failed read.
async function scanForForkedCodexRollout(rolloutFiles) {
  const HEAD_BYTES = 65536;
  let indeterminate = false;
  for (const entry of Array.isArray(rolloutFiles) ? rolloutFiles : []) {
    const fp = typeof entry === "string" ? entry : entry?.path;
    const src = typeof entry === "string" ? "codex" : String(entry?.source || "codex");
    if (!fp || src !== "codex") continue;
    let fh = null;
    try {
      fh = await fs.open(fp, "r");
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      if (buf.toString("utf8", 0, bytesRead).includes('"forked_from_id"')) {
        return { forked: true, indeterminate: false };
      }
    } catch (_e) {
      indeterminate = true;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }
  return { forked: false, indeterminate };
}

async function projectUsageKeysFromQueuePath(queuePath, source) {
  if (typeof queuePath !== "string" || !queuePath) return [];
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return [];
  }
  return projectUsageKeysFromQueueRows(raw.split("\n").filter((line) => line.trim()), source);
}

function projectUsageKeysFromQueueRows(rows, source) {
  const keys = [];
  for (const line of Array.isArray(rows) ? rows : []) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    const key = projectUsageKeyFromFields({
      projectKey: row?.project_key,
      source: row?.source,
      hourStart: row?.hour_start,
    });
    if (key && row?.source === source) keys.push(key);
  }
  return keys;
}

function projectUsageKeysFromState(projectState, source) {
  const buckets =
    projectState && typeof projectState === "object" && projectState.buckets
      ? projectState.buckets
      : {};
  const keys = [];
  for (const [key, bucket] of Object.entries(buckets)) {
    const bucketSource = typeof bucket?.source === "string" ? bucket.source : key.split("|")[1];
    if (bucketSource !== source) continue;
    const usageKey =
      projectUsageKeyFromFields({
        projectKey: bucket?.project_key,
        source: bucketSource,
        hourStart: bucket?.hour_start,
      }) || key;
    keys.push(usageKey);
  }
  return keys;
}

function projectUsageKeyFromFields({ projectKey, source, hourStart }) {
  if (
    typeof projectKey !== "string" ||
    typeof source !== "string" ||
    typeof hourStart !== "string" ||
    !projectKey ||
    !source ||
    !hourStart
  ) {
    return null;
  }
  return `${projectKey}|${source}|${hourStart}`;
}

async function countMalformedCodexProjectQueueRows(queuePath) {
  if (typeof queuePath !== "string" || !queuePath) return 0;
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (row?.source !== "codex") continue;
    const key = projectUsageKeyFromFields({
      projectKey: row?.project_key,
      source: row?.source,
      hourStart: row?.hour_start,
    });
    if (!key) count += 1;
  }
  return count;
}

async function projectUsageTotalsFromQueuePath(queuePath, source) {
  if (typeof queuePath !== "string" || !queuePath) return new Map();
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return new Map();
  }
  return projectUsageTotalsFromQueueRows(raw.split("\n").filter((line) => line.trim()), source);
}

function projectUsageTotalsFromQueueRows(rows, source) {
  const totals = new Map();
  for (const line of Array.isArray(rows) ? rows : []) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    const key = projectUsageKeyFromFields({
      projectKey: row?.project_key,
      source: row?.source,
      hourStart: row?.hour_start,
    });
    if (!key || row?.source !== source) continue;
    setMaxTotal(totals, key, Number(row.total_tokens || 0));
  }
  return totals;
}

function projectUsageTotalsFromState(projectState, source) {
  const buckets =
    projectState && typeof projectState === "object" && projectState.buckets
      ? projectState.buckets
      : {};
  const totals = new Map();
  for (const [key, bucket] of Object.entries(buckets)) {
    const bucketSource = typeof bucket?.source === "string" ? bucket.source : key.split("|")[1];
    if (bucketSource !== source) continue;
    const usageKey =
      projectUsageKeyFromFields({
        projectKey: bucket?.project_key,
        source: bucketSource,
        hourStart: bucket?.hour_start,
      }) || key;
    setMaxTotal(totals, usageKey, Number(bucket?.totals?.total_tokens || 0));
  }
  return totals;
}

async function mainUsageHourTotalsFromQueuePath(queuePath, source) {
  if (typeof queuePath !== "string" || !queuePath) return new Map();
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return new Map();
  }
  return mainUsageHourTotalsFromQueueRows(raw.split("\n").filter((line) => line.trim()), source);
}

function mainUsageHourTotalsFromQueueRows(rows, source) {
  const modelTotals = new Map();
  for (const line of Array.isArray(rows) ? rows : []) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (row?.source !== source || typeof row?.hour_start !== "string") continue;
    const model = typeof row?.model === "string" && row.model ? row.model : "unknown";
    setMaxTotal(modelTotals, `${row.source}|${model}|${row.hour_start}`, Number(row.total_tokens || 0));
  }
  return collapseModelTotalsByHour(modelTotals);
}

function mainUsageHourTotalsFromState(hourlyState, source) {
  const buckets =
    hourlyState && typeof hourlyState === "object" && hourlyState.buckets
      ? hourlyState.buckets
      : {};
  const modelTotals = new Map();
  for (const [key, bucket] of Object.entries(buckets)) {
    const parts = key.split("|");
    const bucketSource = typeof bucket?.source === "string" ? bucket.source : parts[0];
    if (bucketSource !== source) continue;
    const model = typeof bucket?.model === "string" && bucket.model ? bucket.model : parts[1] || "unknown";
    const hourStart =
      typeof bucket?.hour_start === "string" && bucket.hour_start ? bucket.hour_start : parts[2];
    if (typeof hourStart !== "string" || !hourStart) continue;
    setMaxTotal(modelTotals, `${bucketSource}|${model}|${hourStart}`, Number(bucket?.totals?.total_tokens || 0));
  }
  return collapseModelTotalsByHour(modelTotals);
}

function collapseModelTotalsByHour(modelTotals) {
  const totals = new Map();
  for (const [key, total] of modelTotals.entries()) {
    const [source, , hourStart] = key.split("|");
    const hourKey = `${source}|${hourStart}`;
    totals.set(hourKey, (totals.get(hourKey) || 0) + total);
  }
  return totals;
}

function mergeMaxTotals(...maps) {
  const merged = new Map();
  for (const map of maps) {
    if (!(map instanceof Map)) continue;
    for (const [key, total] of map.entries()) {
      setMaxTotal(merged, key, total);
    }
  }
  return merged;
}

function setMaxTotal(map, key, total) {
  if (!key || !Number.isFinite(total)) return;
  const prev = map.get(key);
  if (!Number.isFinite(prev) || total > prev) map.set(key, total);
}

// One-time repair (#204): when the SAME Droid session id existed in two folders
// under ~/.factory/sessions, parseDroidIncremental's cumulative-delta loop made the
// lower-count file look like a reset and re-emitted each duplicate's full total on
// EVERY sync, inflating one (droid, model, hour) bucket without bound (a real ~10M
// session showed as 40.06B). The forward fix is dedupeDroidSettingsFilesBySession
// inside the parser; this migration repairs already-polluted installs.
//
// SCOPE — strictly the duplicate sessions' buckets, and ONLY when duplicate files
// still exist on disk:
//   * A from-zero rebuild cannot reconstruct Droid's historical per-sync bucket
//     distribution — settings.json carries only the CURRENT mtime, not per-turn
//     timestamps like Codex's jsonl. So we rebuild over the DUPLICATE files only,
//     and overwrite only the bucket keys those files map to (pollutedKeys) plus
//     the duplicate sessions' cursor entries. Every other droid bucket and cursor
//     — clean sessions AND deleted-session history — is left byte-for-byte intact,
//     so healthy history is never collapsed into the current half-hour.
//   * No session id has >1 file on disk → this bug never fired here: set the
//     sentinel, touch nothing.
//   * Fire only when live > rebuilt over pollutedKeys (actual inflation), so a
//     fresh install (live empty) is left to the normal same-sync parse.
// Droid has no project dimension, so project.queue.jsonl is never involved.
async function repairDroidDuplicateSessionInflation({ cursors, queuePath, queueStatePath } = {}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  // Completed run → truthy non-skip sentinel (final). A {skipped:true} object would
  // retry (codex skip-retry semantics; this repair only ever writes done/none).
  const prior = migrations[DROID_DUP_SESSION_REPAIR_KEY];
  if (prior && !(typeof prior === "object" && prior.skipped)) return false;

  // Group current on-disk settings files by session id; collect duplicates.
  let onDisk;
  try {
    onDisk = listDroidSettingsFiles(process.env);
  } catch {
    onDisk = [];
  }
  const bySession = new Map();
  for (const fp of onDisk) {
    const sid = droidSessionIdFromPath(fp);
    if (!sid) continue;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(fp);
  }
  const dupFiles = [];
  const cleanFiles = [];
  for (const group of bySession.values()) {
    if (group.length > 1) dupFiles.push(...group);
    else cleanFiles.push(...group);
  }
  if (dupFiles.length === 0) {
    migrations[DROID_DUP_SESSION_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  // Map on-disk settings files to the (droid, model, half-hour) bucket keys they
  // emit under the parser's own keying (mirrors parseDroidIncremental).
  const bucketKeysForFiles = (files) => {
    const keys = new Set();
    for (const fp of files) {
      let mtimeMs = 0;
      try {
        mtimeMs = fssync.statSync(fp).mtimeMs;
      } catch {
        continue;
      }
      let settings;
      try {
        settings = JSON.parse(fssync.readFileSync(fp, "utf8"));
      } catch {
        continue;
      }
      if (!settings || typeof settings !== "object" || !settings.tokenUsage) continue;
      const bucketStart = toUtcHalfHourStart(
        new Date(mtimeMs || Date.now()).toISOString(),
      );
      if (!bucketStart) continue;
      keys.add(bucketKey("droid", resolveDroidModel(settings, fp), bucketStart));
    }
    return keys;
  };

  // A bucket key is (source, model, half-hour) — it carries NO session identity.
  // pollutedKeys are the buckets the duplicate files emit to; cleanKeys are buckets
  // a NON-duplicate on-disk session emits to. When a clean session resolves to the
  // same (model, half-hour) as a duplicate file, they collide on one key. We must
  // NOT delete-and-replace such a shared bucket: the rebuild runs over duplicate
  // files only, so replacing the bucket would erase the clean session's tokens
  // (silent data loss). So repair ONLY buckets owned exclusively by duplicate
  // sessions; leave shared buckets intact. Residual inflation in a rare shared
  // bucket is visible and recoverable; destroying real data is not (this is the
  // dedup-needs-identity-proof rule).
  const pollutedKeys = bucketKeysForFiles(dupFiles);
  const cleanKeys = bucketKeysForFiles(cleanFiles);
  const repairKeys = new Set();
  for (const k of pollutedKeys) if (!cleanKeys.has(k)) repairKeys.add(k);
  if (repairKeys.size === 0) {
    migrations[DROID_DUP_SESSION_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  // Ground-truth rebuild into throwaway state over the DUPLICATE files only
  // (parseDroidIncremental de-dupes its own input → canonical per session). On any
  // throw, leave all state untouched and do NOT set the sentinel (retry next sync).
  let rebuilt;
  const tmpQueue = `${queuePath}.droidrebuild.${process.pid}.${Date.now()}`;
  try {
    const tmpCursors = { hourly: { buckets: {}, groupQueued: {} }, droid: {} };
    await parseDroidIncremental({
      settingsFiles: dupFiles,
      cursors: tmpCursors,
      queuePath: tmpQueue,
      env: process.env,
      prune: true,
    });
    let tmpRaw = "";
    try {
      tmpRaw = await fs.readFile(tmpQueue, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    rebuilt = {
      buckets: tmpCursors.hourly.buckets || {},
      sessionTotals: (tmpCursors.droid && tmpCursors.droid.sessionTotals) || {},
      queueRows: tmpRaw.split("\n").filter((l) => l.trim()),
    };
  } catch (e) {
    console.error(
      "[sync] droid dup-session repair: rebuild failed, leaving all data untouched:",
      e?.message || e,
    );
    return false;
  } finally {
    await fs.rm(tmpQueue, { force: true }).catch(() => {});
  }

  // Inflation present? Compare live vs rebuilt totals over the repair-scoped keys
  // only. Fire only on live > rebuilt (real inflation) — never on a fresh install
  // (live 0).
  const liveBuckets = (cursors.hourly && cursors.hourly.buckets) || {};
  let liveScoped = 0;
  let rebuiltScoped = 0;
  for (const key of repairKeys) {
    liveScoped += Number(liveBuckets[key]?.totals?.total_tokens || 0);
    rebuiltScoped += Number(rebuilt.buckets[key]?.totals?.total_tokens || 0);
  }
  if (liveScoped <= rebuiltScoped) {
    migrations[DROID_DUP_SESSION_REPAIR_KEY] = new Date().toISOString();
    return false;
  }

  // ── COMMIT (atomic) ──
  await ensureDir(path.dirname(queuePath));
  await backupExistingFile(queuePath);

  // 1. queue.jsonl: keep every non-droid line verbatim (incl. unparseable) and
  //    every droid row whose bucket key is NOT in repairKeys (clean + shared +
  //    deleted-session history). Drop droid rows in repairKeys; append rebuilt rows.
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  // A queue line is in scope if it's a droid row whose bucket is in repairKeys.
  // Unparseable / non-droid / clean / shared droid rows are kept verbatim.
  const isRepairDroidRow = (line) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    return (
      row?.source === "droid" &&
      repairKeys.has(bucketKey("droid", row.model, row.hour_start))
    );
  };
  const kept = raw
    .split("\n")
    .filter((line) => line.trim() && !isRepairDroidRow(line));
  const rebuiltRepairRows = rebuilt.queueRows.filter(isRepairDroidRow);
  const tmp = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(
    tmp,
    kept.concat(rebuiltRepairRows).join("\n") + "\n",
    "utf8",
  );
  await fs.rename(tmp, queuePath);

  // 2. live hourly buckets: delete repair-scoped droid keys, install the rebuilt
  //    buckets for those keys. Other droid buckets untouched.
  const hourly = (cursors.hourly ||= { version: 3, buckets: {}, groupQueued: {} });
  hourly.buckets ||= {};
  hourly.groupQueued ||= {};
  for (const key of repairKeys) {
    delete hourly.buckets[key];
    if (rebuilt.buckets[key]) hourly.buckets[key] = rebuilt.buckets[key];
  }
  // Defensive: droid never uses the legacy aggregate path, but drop any stale droid
  // group markers so a repaired hour can't re-emit as model=unknown.
  for (const gk of Object.keys(hourly.groupQueued)) {
    if (gk.startsWith("droid|")) delete hourly.groupQueued[gk];
  }

  // 3. session cursor: overwrite ONLY the duplicate sessions with the ground-truth
  //    rebuild so the later same-sync droid parse short-circuits (mtime match) and
  //    emits nothing. Clean sessions' cursor entries are correct already — leave
  //    them, or the later parse would re-emit them from zero.
  const droidState = (cursors.droid ||= {});
  if (!droidState.sessionTotals || typeof droidState.sessionTotals !== "object") {
    droidState.sessionTotals = {};
  }
  for (const sid of Object.keys(rebuilt.sessionTotals)) {
    droidState.sessionTotals[sid] = rebuilt.sessionTotals[sid];
  }
  droidState.updatedAt = new Date().toISOString();

  // 4. reset the cloud upload offset so corrected rows re-upload (idempotent upsert).
  if (typeof queueStatePath === "string" && queueStatePath) {
    let uploadState = {};
    try {
      uploadState = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
    } catch {
      uploadState = {};
    }
    uploadState.offset = 0;
    uploadState.updatedAt = new Date().toISOString();
    uploadState.note = "reset_after_droid_dup_session_2026_06";
    await fs.writeFile(queueStatePath, JSON.stringify(uploadState));
  }

  migrations[DROID_DUP_SESSION_REPAIR_KEY] = {
    status: "done",
    at: new Date().toISOString(),
    keysRepaired: repairKeys.size,
    keysSkippedSharedWithCleanSession: pollutedKeys.size - repairKeys.size,
    liveBefore: liveScoped,
    rebuiltAfter: rebuiltScoped,
    deltaReclaimed: liveScoped - rebuiltScoped,
  };
  return true;
}

// One-time repair migration: rebuild source=claude rows in queue.jsonl from
// the actual jsonl files using ccusage's algorithm (msgId+reqId global
// dedup). Earlier `reincludeClaudeMemObserverFiles` versions (v1/v2/v3) each
// reset the hash set and re-read observer jsonls, which silently inflated
// queue.jsonl's claude totals by ~40%. We do an atomic rewrite — keep all
// non-claude rows verbatim, replace every claude/claude-mem row with the
// ground-truth set — then reset cursors so the next incremental sync stays
// in sync, and reset the cloud upload offset so the corrected rows actually
// reach the cloud (the ingest endpoint upserts by (source, model,
// hour_start), so re-uploading other sources is idempotent).
async function repairClaudeQueueFromGroundTruth({
  cursors,
  queuePath,
  queueStatePath = null,
  projectQueuePath = null,
  projectQueueStatePath = null,
  rootDirs = null,
}) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  if (migrations[CLAUDE_GROUND_TRUTH_REPAIR_KEY]) return false;

  let result;
  try {
    // rootDirs must cover every install the incremental parser scans (native
    // AND WSL): this repair's semantics are "disk is truth" — it clears all
    // claude buckets and replaces claudeHashes wholesale, so scanning fewer
    // roots than sync would silently drop the missing install's history.
    result = await computeClaudeGroundTruthBuckets(
      Array.isArray(rootDirs) && rootDirs.length > 0 ? { rootDirs } : {},
    );
  } catch (e) {
    console.error("[sync] claude ground-truth repair: scan failed:", e?.message || e);
    return false;
  }
  const { rows, seenHashes, fileList } = result;

  // 1. Atomic rewrite of queue.jsonl: keep non-claude rows, drop existing
  //    claude/claude-mem rows, append truth rows. Atomic via tmp + rename.
  let claudeRowsRemoved = 0;
  if (typeof queuePath === "string" && queuePath) {
    let raw = "";
    try {
      raw = await fs.readFile(queuePath, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    const keptLines = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (_e) {
        // Preserve unparseable lines verbatim — operator may want to
        // recover them later.
        keptLines.push(line);
        continue;
      }
      if (row?.source === "claude" || row?.source === "claude-mem") {
        claudeRowsRemoved += 1;
        continue;
      }
      keptLines.push(line);
    }

    const truthLines = rows.map((r) =>
      JSON.stringify({
        source: "claude",
        model: r.model,
        hour_start: r.hour_start,
        input_tokens: r.input_tokens,
        cached_input_tokens: r.cached_input_tokens,
        cache_creation_input_tokens: r.cache_creation_input_tokens,
        output_tokens: r.output_tokens,
        reasoning_output_tokens: r.reasoning_output_tokens,
        total_tokens: r.total_tokens,
        billable_total_tokens: r.billable_total_tokens,
        conversation_count: r.conversation_count,
      }),
    );

    await ensureDir(path.dirname(queuePath));
    const out = keptLines.concat(truthLines).join("\n") + "\n";
    const tmp = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, out, "utf8");
    await fs.rename(tmp, queuePath);
  }

  // 2. Reset cursors.hourly.buckets / groupQueued for source=claude (and the
  //    dead source=claude-mem buckets) so incremental sync's in-memory state
  //    matches the truth.
  const hourly = (cursors.hourly ||= { buckets: {}, groupQueued: {} });
  hourly.buckets ||= {};
  hourly.groupQueued ||= {};

  let bucketsCleared = 0;
  for (const k of Object.keys(hourly.buckets)) {
    if (k.startsWith("claude|") || k.startsWith("claude-mem|")) {
      delete hourly.buckets[k];
      bucketsCleared += 1;
    }
  }
  // Clear stale claude entries from groupQueued (left over by v2 repair).
  // After v3 we never repopulate it for claude, so nothing should be added
  // back during the per-model write loop below.
  for (const k of Object.keys(hourly.groupQueued)) {
    if (k.startsWith("claude|") || k.startsWith("claude-mem|")) {
      delete hourly.groupQueued[k];
    }
  }

  // Per-model claude buckets: set queuedKey but DO NOT touch
  // hourly.groupQueued. groupQueued is used by enqueueTouchedBuckets to
  // mark a (source, hour) as legacy-aggregate state; writing claude hours
  // there would force every later sync to re-emit the hour as a single
  // model=DEFAULT_MODEL aggregate row instead of touching only the bucket
  // that actually changed. The original v2 release did write groupQueued
  // here and was the cause of an unknown-bucket inflation regression.
  for (const r of rows) {
    const totals = {
      input_tokens: r.input_tokens,
      cached_input_tokens: r.cached_input_tokens,
      cache_creation_input_tokens: r.cache_creation_input_tokens,
      output_tokens: r.output_tokens,
      reasoning_output_tokens: r.reasoning_output_tokens,
      total_tokens: r.total_tokens,
      billable_total_tokens: r.billable_total_tokens,
      conversation_count: r.conversation_count,
    };
    const key = bucketKey("claude", r.model, r.hour_start);
    hourly.buckets[key] = {
      totals,
      queuedKey: totalsKey(totals),
      source: "claude",
      hour_start: r.hour_start,
    };
  }

  // 3. Reset per-file cursors so future incremental sync only reads genuinely
  //    new tail content. Format must match what rollout.js expects:
  //    { inode, offset, updatedAt }. Setting a plain integer here breaks
  //    the inode-equality check inside parseClaudeFile, which would treat
  //    the file as untracked and re-read it from byte 0 — silently doubling
  //    everything. (That was the actual cause of the regression after the
  //    first repair attempt.)
  cursors.files ||= {};
  let filesReset = 0;
  const nowIso = new Date().toISOString();
  for (const fp of fileList) {
    let st;
    try {
      st = fssync.statSync(fp);
    } catch (_e) {
      continue;
    }
    cursors.files[fp] = {
      inode: st.ino || 0,
      offset: st.size,
      updatedAt: nowIso,
    };
    filesReset += 1;
  }
  cursors.claudeHashes = seenHashes;

  // 4. Reset cloud-upload offset so the corrected rows are re-sent. Other
  //    sources are upserted idempotently by the ingest endpoint, so this is
  //    safe — just costs one extra round of bandwidth.
  if (typeof queueStatePath === "string" && queueStatePath) {
    let uploadState = {};
    try {
      uploadState = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
    } catch (_e) {
      uploadState = {};
    }
    uploadState.offset = 0;
    uploadState.updatedAt = new Date().toISOString();
    uploadState.note = "reset_after_claude_repair_2026_05_v4";
    await fs.writeFile(queueStatePath, JSON.stringify(uploadState));
  }

  // 5. Repair project queue. Historical claude rows in project.queue.jsonl
  //    were uniformly mis-attributed to project_key=
  //    "claude-mem/observer-sessions" (left over from the observer
  //    relabel migration). We can't reconstruct the true cwd-based
  //    project_key for each historical message reliably, so we drop every
  //    claude/claude-mem row from project.queue.jsonl and reset the
  //    matching cursors.projectHourly state. New claude usage will
  //    accumulate to the correct cwd-derived project_key going forward.
  let projectRowsRemoved = 0;
  let projectBucketsCleared = 0;
  if (typeof projectQueuePath === "string" && projectQueuePath) {
    let projRaw = "";
    try {
      projRaw = await fs.readFile(projectQueuePath, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    if (projRaw) {
      const projKept = [];
      for (const line of projRaw.split("\n")) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch (_e) {
          projKept.push(line);
          continue;
        }
        if (row?.source === "claude" || row?.source === "claude-mem") {
          projectRowsRemoved += 1;
          continue;
        }
        projKept.push(line);
      }
      await ensureDir(path.dirname(projectQueuePath));
      const tmp = `${projectQueuePath}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, projKept.join("\n") + "\n", "utf8");
      await fs.rename(tmp, projectQueuePath);
    }

    // Clear matching projectHourly state so the claude project buckets
    // start fresh.
    const projHourly = (cursors.projectHourly ||= { buckets: {} });
    projHourly.buckets ||= {};
    for (const k of Object.keys(projHourly.buckets)) {
      const v = projHourly.buckets[k];
      const src = v?.source || "";
      if (src === "claude" || src === "claude-mem") {
        delete projHourly.buckets[k];
        projectBucketsCleared += 1;
      }
    }

    // Reset project upload offset.
    if (typeof projectQueueStatePath === "string" && projectQueueStatePath) {
      let st = {};
      try {
        st = JSON.parse(await fs.readFile(projectQueueStatePath, "utf8"));
      } catch (_e) {
        st = {};
      }
      st.offset = 0;
      st.updatedAt = new Date().toISOString();
      st.note = "reset_after_claude_repair_2026_05_v6";
      await fs.writeFile(projectQueueStatePath, JSON.stringify(st));
    }
  }

  migrations[CLAUDE_GROUND_TRUTH_REPAIR_KEY] = {
    appliedAt: new Date().toISOString(),
    bucketsWritten: rows.length,
    bucketsCleared,
    rowsRemoved: claudeRowsRemoved,
    filesReset,
    hashesRetained: seenHashes.length,
    uploadOffsetReset: typeof queueStatePath === "string" && !!queueStatePath,
    projectRowsRemoved,
    projectBucketsCleared,
  };
  return true;
}

async function reincludeClaudeMemObserverFiles({ cursors, claudeFiles, queuePath, queueStatePath }) {
  if (!cursors || typeof cursors !== "object") return false;
  const migrations = (cursors.migrations ||= {});
  if (migrations[CLAUDE_MEM_OBSERVER_REINCLUDE_KEY]) return false;

  const observerPaths = (Array.isArray(claudeFiles) ? claudeFiles : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.path))
    .filter((p) => typeof p === "string" && p.includes(CLAUDE_MEM_OBSERVER_PATH_SEGMENT));

  if (!cursors.files || typeof cursors.files !== "object") {
    cursors.files = {};
  }

  let filesReset = 0;
  for (const filePath of observerPaths) {
    if (cursors.files[filePath]) {
      delete cursors.files[filePath];
      filesReset += 1;
    }
  }

  const hashesToRemove = observerPaths.length > 0
    ? await collectClaudeMessageHashes(observerPaths)
    : new Set();
  let hashesRemoved = 0;
  if (Array.isArray(cursors.claudeHashes) && hashesToRemove.size > 0) {
    const nextHashes = [];
    for (const hash of cursors.claudeHashes) {
      if (hashesToRemove.has(hash)) {
        hashesRemoved += 1;
        continue;
      }
      nextHashes.push(hash);
    }
    cursors.claudeHashes = nextHashes;
  }

  const queueRowsRelabeled = typeof queuePath === "string" && queuePath
    ? await relabelClaudeMemQueueRows(queuePath, queueStatePath)
    : 0;

  migrations[CLAUDE_MEM_OBSERVER_REINCLUDE_KEY] = {
    appliedAt: new Date().toISOString(),
    filesReset,
    hashesRemoved,
    queueRowsRelabeled,
  };
  return filesReset > 0 || hashesRemoved > 0 || queueRowsRelabeled > 0;
}

async function relabelClaudeMemQueueRows(queuePath, queueStatePath = null) {
  let raw;
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (_e) {
    return 0;
  }
  if (!raw || !raw.includes('"claude-mem"')) return 0;

  // The cloud-upload cursor (queue.state.json `offset`) is a byte position in
  // the pre-rewrite file. Relabeling shrinks rewritten lines ("claude-mem" →
  // "claude"), so the old offset would land mid-line in the new file and the
  // next drainQueueToCloud batch would skip part of a row (or a whole row).
  // Track the old→new byte mapping while rewriting and remap the offset to
  // the equivalent line boundary (same pattern as project-usage-purge.js).
  let previousOffset = 0;
  if (typeof queueStatePath === "string" && queueStatePath) {
    try {
      const st = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
      const off = Number(st?.offset || 0);
      if (Number.isFinite(off) && off > 0) previousOffset = off;
    } catch (_e) {
      previousOffset = 0;
    }
  }

  const lines = raw.split("\n");
  const out = [];
  let relabeled = 0;
  let inputOffset = 0;
  let outputOffset = 0;
  let nextOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    let outLine = line;
    if (line) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.source === "claude-mem") {
          obj.source = "claude";
          relabeled += 1;
          outLine = JSON.stringify(obj);
        }
      } catch (_e) {
        // keep malformed lines verbatim
      }
    }
    out.push(outLine);
    inputOffset += Buffer.byteLength(line, "utf8") + (isLast ? 0 : 1);
    outputOffset += Buffer.byteLength(outLine, "utf8") + (isLast ? 0 : 1);
    // Upload offsets always sit at line boundaries; a mid-line offset
    // (corruption) rounds down to the previous boundary so no row is skipped
    // — worst case a row is re-uploaded, and cloud ingest upserts by key.
    if (inputOffset <= previousOffset) nextOffset = outputOffset;
  }
  if (relabeled === 0) return 0;

  // Atomic rewrite: temp file in the same directory + rename, so a crash
  // mid-write can never leave queue.jsonl truncated.
  const tmpPath = `${queuePath}.tmp`;
  await fs.writeFile(tmpPath, out.join("\n"), "utf8");
  await fs.rename(tmpPath, queuePath);

  if (typeof queueStatePath === "string" && queueStatePath && previousOffset > 0) {
    let state = {};
    try {
      state = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
      if (!state || typeof state !== "object") state = {};
    } catch (_e) {
      state = {};
    }
    state.offset = nextOffset;
    state.updatedAt = new Date().toISOString();
    await fs.writeFile(queueStatePath, JSON.stringify(state), "utf8");
  }
  return relabeled;
}

async function collectClaudeMessageHashes(filePaths) {
  const hashes = new Set();
  for (const filePath of filePaths) {
    let stream;
    try {
      stream = fssync.createReadStream(filePath, { encoding: "utf8" });
    } catch (_e) {
      continue;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      const hash = claudeMessageDedupKey(obj);
      if (hash) hashes.add(hash);
    }
    rl.close();
    stream.close?.();
  }
  return hashes;
}
