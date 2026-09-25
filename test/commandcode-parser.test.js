/**
 * Command Code (`cmd`, commandcode.ai) parser test.
 *
 * Command Code persists one JSONL transcript per conversation under
 * `~/.commandcode/projects/<cwd-slug>/<session-id>.jsonl`. The session header
 * carries the launch cwd; each completed assistant turn appends a record whose
 * top-level `model`/`usage` are the CLI's own accounting. `message` sits in the
 * middle of the record, so the reader must slice fields instead of parsing the
 * line — this suite asserts that prompts never reach JSON.parse.
 *
 * This suite covers:
 *   - `resolveCommandCodeHome(s)` precedence and the Windows native/WSL matrix
 *   - `resolveCommandCodeSessionFiles` transcript discovery (checkpoints skipped)
 *   - usage normalization (AI SDK cache-inclusive input; billed costUsd)
 *   - rebuild-and-diff reconciliation: rerun no-op, rewritten transcript,
 *     deleted session, pre-fix cursor migration, and queue-append failures
 *   - per-model accounting across cache reads, writes, and uncached usage
 *   - the committed fixture's sanitization contract
 *
 * The sample fixture is a real, sanitized transcript (token counts and the
 * provider's billed `costUsd` only — message bodies stripped).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { computeRowCost } = require("../src/lib/pricing");

const {
  resolveCommandCodeHome,
  resolveCommandCodeHomes,
  resolveCommandCodeSessionFiles,
  isCommandCodeSessionLogName,
  normalizeCommandCodeModelName,
  commandCodeUsageToTotals,
  extractCommandCodeSessionUsage,
  parseCommandCodeIncremental,
} = require("../src/lib/rollout");

const FIXTURE = path.join(__dirname, "fixtures", "commandcode", "sample-session.jsonl");
const T0 = "2026-05-01T12:00:00.000Z";

function headerLine(id = "sess-1", cwd = "/home/user/project", timestamp = T0) {
  return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd });
}

function messageLine({
  id,
  timestamp = T0,
  inputTokens = 1000,
  outputTokens = 100,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  costUsd = 0.001,
  model = "deepseek/deepseek-v4.1-flash",
  message = null,
} = {}) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: "parent",
    timestamp,
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd },
    model,
    effort: "max",
    message,
  });
}

function makeTree({ slug = "c-users-mechrevo", sessionId = "sess-1", lines = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-test-"));
  const home = path.join(dir, ".commandcode");
  const projectDir = path.join(home, "projects", slug);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return { dir, home, projectDir, filePath };
}

function makeLegacyCommandCodeTree() {
  const sessionId = "sess-migrate";
  const { dir, filePath } = makeTree({ sessionId });
  const repoDir = path.join(dir, "repo");
  const queuePath = path.join(dir, "queue.jsonl");
  const projectQueuePath = path.join(dir, "queue.project.jsonl");
  const projectKey = "acme/commandcode-fixture";
  const projectRef = `https://github.com/${projectKey}`;
  const model = "claude-sonnet-4-5";

  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".git", "config"), `[remote "origin"]\n\turl = ${projectRef}.git\n`, "utf8");
  fs.writeFileSync(filePath, [
    headerLine(sessionId, repoDir),
    messageLine({
      id: "m1",
      model: `anthropic/${model}`,
      inputTokens: 750,
      cacheReadTokens: 600,
      cacheWriteTokens: 50,
      outputTokens: 20,
      costUsd: 0.001,
    }),
  ].join("\n") + "\n", "utf8");
  const { size, mtimeMs } = fs.statSync(filePath);
  const oldTotals = {
    input_tokens: 150,
    cached_input_tokens: 600,
    cache_creation_input_tokens: 50,
    output_tokens: 20,
    reasoning_output_tokens: 0,
    total_tokens: 820,
    billable_total_tokens: 820,
    total_cost_usd: 0.001,
    conversation_count: 1,
  };
  const oldQueuedKey = "150|600|50|20|0|820|820|0.001|1";
  const hourlyKey = `command-code|${model}|${T0}`;
  const projectBucketKey = `${projectKey}|command-code|${T0}`;
  const messageKey = `command-code:${sessionId}|m1`;
  const oldRow = { source: "command-code", model, hour_start: T0, ...oldTotals };
  const oldProjectRow = {
    project_key: projectKey,
    project_ref: projectRef,
    source: "command-code",
    hour_start: T0,
    ...oldTotals,
  };
  fs.writeFileSync(queuePath, JSON.stringify(oldRow) + "\n", "utf8");
  fs.writeFileSync(projectQueuePath, JSON.stringify(oldProjectRow) + "\n", "utf8");
  // Seed the exact pre-fix persisted shape, not values from the parser under
  // test: retaining this ledger is necessary to subtract the inflated bill.
  const cursors = {
    hourly: {
      version: 3,
      buckets: { [hourlyKey]: { totals: { ...oldTotals }, queuedKey: oldQueuedKey } },
      groupQueued: {},
    },
    projectHourly: {
      version: 2,
      buckets: {
        [projectBucketKey]: {
          project_key: projectKey,
          project_ref: projectRef,
          source: "command-code",
          hour_start: T0,
          totals: { ...oldTotals },
          queuedKey: oldQueuedKey,
        },
      },
      projects: {},
    },
    commandCode: {
      messages: {
        [messageKey]: {
          totals: { ...oldTotals },
          conversationCount: 1,
          bucketStart: T0,
          model,
          projectKey,
          projectRef,
          filePath,
          updatedAt: T0,
        },
      },
      files: { [filePath]: { size, mtimeMs } },
      updatedAt: T0,
    },
  };
  const publicRepoResolver = async ({ projectRef: resolvedRef }) => {
    assert.equal(resolvedRef, projectRef);
    return { status: "public_verified", projectKey, projectRef };
  };
  return {
    dir, filePath, size, mtimeMs, oldTotals, oldRow, oldProjectRow,
    hourlyKey, projectBucketKey, messageKey,
    options: { sessionFiles: [filePath], cursors, queuePath, projectQueuePath, publicRepoResolver },
  };
}

function readRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

function commandCodeRows(queuePath) {
  return readRows(queuePath).filter((row) => row.source === "command-code");
}

// Bucket rows are latest-wins snapshots: a reconciliation that removes usage
// appends a lower (or zero) snapshot for the same (model, hour_start) key
// rather than retracting the earlier row, so consumers read the last row per key.
function latestCommandCodeRows(queuePath) {
  const latest = new Map();
  for (const row of commandCodeRows(queuePath)) {
    latest.set(`${row.model}|${row.hour_start}`, row);
  }
  return latest;
}

function latestCommandCodeTokens(queuePath) {
  return [...latestCommandCodeRows(queuePath).values()]
    .reduce((sum, row) => sum + row.total_tokens, 0);
}

test("resolveCommandCodeHome honors TOKENTRACKER_COMMANDCODE_HOME, then defaults to ~/.commandcode", () => {
  assert.equal(
    resolveCommandCodeHome({ TOKENTRACKER_COMMANDCODE_HOME: "/tmp/cc" }),
    path.resolve("/tmp/cc"),
  );
  assert.equal(resolveCommandCodeHome({ TOKENTRACKER_COMMANDCODE_HOME: "  " }), path.join(os.homedir(), ".commandcode"));
  assert.equal(resolveCommandCodeHome({}), path.join(os.homedir(), ".commandcode"));
});

test("resolveCommandCodeHomes follows the Windows native/WSL mode matrix", () => {
  const nativeHome = "/native/.commandcode";
  const wslHome = "\\\\wsl$\\Ubuntu\\home\\dev\\.commandcode";
  const deps = {
    platform: "win32",
    nativeHome,
    existsSync(candidate) {
      return candidate === nativeHome;
    },
    discoverWslHome(providerDir) {
      assert.equal(providerDir, ".commandcode");
      return wslHome;
    },
  };

  assert.deepEqual(resolveCommandCodeHomes({}, deps), [wslHome], "default is wsl-first");
  assert.deepEqual(resolveCommandCodeHomes({ TOKENTRACKER_WSL_MODE: "native-first" }, deps), [nativeHome]);
  assert.deepEqual(resolveCommandCodeHomes({ TOKENTRACKER_WSL_MODE: "wsl-only" }, deps), [wslHome]);
  assert.deepEqual(resolveCommandCodeHomes({ TOKENTRACKER_WSL_MODE: "native-only" }, deps), [nativeHome]);
  assert.deepEqual(resolveCommandCodeHomes({ TOKENTRACKER_WSL_MODE: "both" }, deps), [nativeHome, wslHome]);
});

test("resolveCommandCodeHomes keeps explicit overrides authoritative and never probes WSL off Windows", () => {
  let probes = 0;
  const overridden = resolveCommandCodeHomes(
    { TOKENTRACKER_COMMANDCODE_HOME: "/custom/.commandcode", TOKENTRACKER_WSL_MODE: "both" },
    {
      platform: "win32",
      discoverWslHome() {
        probes += 1;
        return "\\\\wsl$\\Ubuntu\\home\\dev\\.commandcode";
      },
    },
  );
  assert.deepEqual(overridden, [path.resolve("/custom/.commandcode")]);
  assert.equal(probes, 0, "an explicit home must suppress automatic WSL discovery");

  assert.deepEqual(
    resolveCommandCodeHomes({}, { platform: "darwin", nativeHome: "/Users/dev/.commandcode" }),
    ["/Users/dev/.commandcode"],
  );
});

test("isCommandCodeSessionLogName accepts transcripts and rejects checkpoint snapshots", () => {
  assert.equal(isCommandCodeSessionLogName("277f4e1b-b393-4e85-abd2-3b8f01f81b97.jsonl"), true);
  assert.equal(isCommandCodeSessionLogName("277f4e1b-b393-4e85-abd2-3b8f01f81b97.checkpoints.jsonl"), false);
  assert.equal(isCommandCodeSessionLogName("277f4e1b-b393-4e85-abd2-3b8f01f81b97.meta.json"), false);
  assert.equal(isCommandCodeSessionLogName("notes.txt"), false);
  assert.equal(isCommandCodeSessionLogName(""), false);
  assert.equal(isCommandCodeSessionLogName(null), false);
});

test("resolveCommandCodeSessionFiles discovers project transcripts and skips non-transcript siblings", async () => {
  const { dir, home, projectDir, filePath } = makeTree({
    lines: [headerLine(), messageLine({ id: "m1" })],
  });
  const otherDir = path.join(home, "projects", "c-users-other");
  fs.mkdirSync(otherDir, { recursive: true });
  const otherPath = path.join(otherDir, "other-session.jsonl");
  fs.writeFileSync(otherPath, `${headerLine("sess-2")}\n${messageLine({ id: "m2" })}\n`, "utf8");
  // Siblings that must never be parsed as transcripts.
  fs.writeFileSync(
    path.join(projectDir, "sess-1.checkpoints.jsonl"),
    `${messageLine({ id: "checkpoint" })}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(projectDir, "sess-1.meta.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(home, "projects", "stray.jsonl"), `${messageLine({ id: "stray" })}\n`, "utf8");

  try {
    const files = await resolveCommandCodeSessionFiles({ TOKENTRACKER_COMMANDCODE_HOME: home });
    assert.deepEqual(files, [filePath, otherPath].sort((a, b) => a.localeCompare(b)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("commandCodeUsageToTotals subtracts cache reads from the cache-inclusive input", () => {
  // Values from a real DeepSeek V4.1 Flash turn: the cache read is already part
  // of inputTokens, so storing the column verbatim would double count it.
  assert.deepEqual(commandCodeUsageToTotals({
    inputTokens: 22918,
    outputTokens: 14736,
    cacheReadTokens: 7296,
    cacheWriteTokens: 0,
    costUsd: 0.011206788,
  }), {
    input_tokens: 15622,
    cached_input_tokens: 7296,
    cache_creation_input_tokens: 0,
    output_tokens: 14736,
    reasoning_output_tokens: 0,
    total_tokens: 37654,
    billable_total_tokens: 37654,
    total_cost_usd: 0.011206788,
    conversation_count: 1,
  });

  assert.equal(
    commandCodeUsageToTotals({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    null,
    "all-zero usage is not a billable event",
  );
  assert.equal(commandCodeUsageToTotals(null), null);

  const malformed = commandCodeUsageToTotals({
    inputTokens: -5,
    outputTokens: Number.NaN,
    cacheReadTokens: Infinity,
    cacheWriteTokens: 0,
    costUsd: -1,
  });
  assert.equal(malformed, null, "malformed numbers clamp to zero and drop the record");

  const clamped = commandCodeUsageToTotals({
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    costUsd: 0,
  });
  assert.equal(clamped.input_tokens, 0, "a cache read exceeding the input cannot go negative");
  assert.equal(clamped.total_tokens, 510);
  assert.equal(clamped.total_cost_usd, 0, "an unreported cost keeps the zero sentinel");
});

// Command Code's AI SDK-normalized inputTokens includes cache writes as well
// as cache reads. Both cache columns must be disjoint from uncached input.
for (const fixture of [
  { inputTokens: 750, cacheReadTokens: 600, cacheWriteTokens: 50, outputTokens: 20, input: 100, total: 770 },
  { inputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 20, input: 100, total: 170 },
]) {
  test(`commandCodeUsageToTotals subtracts cache writes with ${fixture.cacheReadTokens} cache-read tokens`, () => {
    const row = commandCodeUsageToTotals(fixture);
    assert.equal(row.input_tokens, fixture.input);
    assert.equal(row.cached_input_tokens, fixture.cacheReadTokens);
    assert.equal(row.cache_creation_input_tokens, fixture.cacheWriteTokens);
    assert.equal(row.output_tokens, fixture.outputTokens);
    assert.equal(row.reasoning_output_tokens, 0);
    assert.equal(row.total_tokens, fixture.total);
    assert.equal(row.billable_total_tokens, fixture.total);
  });
}

test("normalizeCommandCodeModelName strips the provider prefix", () => {
  assert.equal(normalizeCommandCodeModelName("deepseek/deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  assert.equal(normalizeCommandCodeModelName("gpt-6-sol"), "gpt-6-sol");
  assert.equal(normalizeCommandCodeModelName("  "), null);
  assert.equal(normalizeCommandCodeModelName(null), null);
});

test("extractCommandCodeSessionUsage reads header, model and buckets without materializing message bodies", () => {
  const secret = "SECRET_PROMPT_MUST_NOT_BE_PARSED";
  const lines = [
    headerLine("sess-9", "/home/user/project"),
    messageLine({
      id: "m1",
      timestamp: "2026-05-01T12:10:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: secret }] },
    }),
    // All-zero usage carries no billable event.
    messageLine({ id: "m2", timestamp: "2026-05-01T12:20:00.000Z", inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    // A different half-hour and an unqualified model id.
    messageLine({
      id: "m3",
      timestamp: "2026-05-01T12:40:00.000Z",
      model: "gpt-6-sol",
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 100,
      costUsd: 0.002,
    }),
    // Torn tail: a record that never completed must contribute nothing.
    '{"type":"message","id":"m4","timestamp":"2026-05-01T13:0',
  ];

  const originalParse = JSON.parse;
  let leaked = false;
  JSON.parse = function privacyGuard(value, ...rest) {
    if (String(value).includes(secret)) leaked = true;
    return originalParse.call(this, value, ...rest);
  };
  let parsed;
  try {
    parsed = extractCommandCodeSessionUsage(lines.join("\n"));
  } finally {
    JSON.parse = originalParse;
  }
  assert.equal(leaked, false, "message content reached JSON.parse");

  assert.equal(parsed.sessionId, "sess-9");
  assert.equal(parsed.cwd, "/home/user/project");
  assert.equal(parsed.records.length, 2, "zero-usage and torn records are dropped");
  assert.equal(parsed.records[0].bucketStart, "2026-05-01T12:00:00.000Z");
  assert.equal(parsed.records[0].model, "deepseek-v4.1-flash");
  assert.equal(parsed.records[1].bucketStart, "2026-05-01T12:30:00.000Z");
  assert.equal(parsed.records[1].model, "gpt-6-sol");
  assert.equal(parsed.records[1].totals.total_tokens, 550);
});

test("parseCommandCodeIncremental queues the committed fixture, skips unchanged files, and dedups on rerun", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-fixture-"));
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  const first = await parseCommandCodeIncremental({
    sessionFiles: [FIXTURE],
    cursors,
    queuePath,
  });
  assert.equal(first.recordsProcessed, 6, "the fixture carries six usage records");
  assert.equal(first.eventsAggregated, 6);

  const rows = commandCodeRows(queuePath);
  assert.equal(rows.length, 1, "all six turns land in one half-hour bucket");
  assert.equal(rows[0].model, "deepseek-v4.1-flash");
  assert.equal(rows[0].hour_start, "2026-09-23T09:30:00.000Z");
  assert.equal(rows[0].conversation_count, 6);
  assert.equal(rows[0].input_tokens, 22918 - 7296 + 37768 - 7424 + 38950 - 37888 + 55659 - 39168 + 56742 - 56576 + 57818 - 57216);
  assert.equal(rows[0].cached_input_tokens, 7296 + 7424 + 37888 + 39168 + 56576 + 57216);
  assert.equal(rows[0].output_tokens, 14736 + 122 + 232 + 1073 + 587 + 165);
  // The provider-reported bill is authoritative for this source.
  const expectedCost = 0.011206788 + 0.0046470719999999995 + 0.00041216399999999997 + 0.0032349539999999995 + 0.000546828 + 0.000360948;
  assert.ok(Math.abs(rows[0].total_cost_usd - expectedCost) < 1e-12);

  // Second run: (size, mtime) unchanged, so the transcript is not re-read and
  // nothing is re-queued.
  const second = await parseCommandCodeIncremental({
    sessionFiles: [FIXTURE],
    cursors,
    queuePath,
  });
  assert.equal(second.recordsProcessed, 0, "an unchanged file is not re-read");
  assert.equal(second.eventsAggregated, 0);
  assert.equal(second.bucketsQueued, 0);
  assert.equal(commandCodeRows(queuePath).length, 1, "no duplicate bucket rows");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseCommandCodeIncremental corrects an unversioned ledger even when file metadata is unchanged", async () => {
  const {
    dir, filePath, size, mtimeMs, oldTotals, oldRow, oldProjectRow,
    hourlyKey, projectBucketKey, messageKey, options,
  } = makeLegacyCommandCodeTree();
  const { cursors, queuePath, projectQueuePath } = options;

  try {
    const first = await parseCommandCodeIncremental(options);
    assert.equal(first.recordsProcessed, 1, "an unversioned file fingerprint must be invalidated");
    assert.equal(first.eventsAggregated, 1);
    assert.equal(first.bucketsQueued, 1);
    assert.equal(first.projectBucketsQueued, 1);
    const corrected = { ...oldTotals, input_tokens: 100, total_tokens: 770, billable_total_tokens: 770 };
    assert.deepEqual(commandCodeRows(queuePath), [oldRow, { ...oldRow, ...corrected }]);
    assert.deepEqual(commandCodeRows(projectQueuePath), [oldProjectRow, { ...oldProjectRow, ...corrected }]);
    assert.equal(cursors.commandCode.version, 1);
    assert.deepEqual(cursors.commandCode.messages[messageKey].totals, corrected);
    assert.deepEqual(cursors.hourly.buckets[hourlyKey].totals, corrected);
    assert.deepEqual(cursors.projectHourly.buckets[projectBucketKey].totals, corrected);
    assert.deepEqual(cursors.commandCode.files[filePath], { size, mtimeMs });
    const currentStat = fs.statSync(filePath);
    assert.equal(currentStat.size, size);
    assert.equal(currentStat.mtimeMs, mtimeMs, "migration must not depend on a transcript rewrite");

    const second = await parseCommandCodeIncremental({
      ...options,
      cursors: JSON.parse(JSON.stringify(cursors)),
    });
    assert.equal(second.recordsProcessed, 0, "the versioned fingerprint is reusable after migration");
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.equal(second.projectBucketsQueued, 0);
    assert.deepEqual(commandCodeRows(queuePath), [oldRow, { ...oldRow, ...corrected }]);
    assert.deepEqual(commandCodeRows(projectQueuePath), [oldProjectRow, { ...oldProjectRow, ...corrected }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const failedQueue of ["hourly", "project"]) {
  test(`parseCommandCodeIncremental preserves old cursors and retries corrections after ${failedQueue} append failure`, async () => {
    const { dir, oldTotals, oldRow, oldProjectRow, options } = makeLegacyCommandCodeTree();
    const { cursors, queuePath, projectQueuePath } = options;
    const failedPath = failedQueue === "hourly" ? queuePath : projectQueuePath;
    const savedPath = `${failedPath}.saved`;
    const before = JSON.parse(JSON.stringify(cursors));

    try {
      fs.renameSync(failedPath, savedPath);
      fs.mkdirSync(failedPath);
      await assert.rejects(parseCommandCodeIncremental(options), /EISDIR|directory/i);
      assert.deepEqual(cursors.hourly, before.hourly, "failed append must not publish totals or queuedKey");
      assert.deepEqual(cursors.projectHourly, before.projectHourly, "project state must stay isolated too");
      assert.deepEqual(cursors.commandCode, before.commandCode, "old messages and file fingerprints remain retryable");

      fs.rmdirSync(failedPath);
      fs.renameSync(savedPath, failedPath);
      const retry = await parseCommandCodeIncremental(options);
      assert.equal(retry.recordsProcessed, 1);
      assert.equal(retry.eventsAggregated, 1);
      assert.equal(retry.bucketsQueued, 1, "the hourly correction must really be appended on retry");
      assert.equal(retry.projectBucketsQueued, 1, "the project correction must really be appended on retry");
      const corrected = { ...oldTotals, input_tokens: 100, total_tokens: 770, billable_total_tokens: 770 };
      const hourlyRows = commandCodeRows(queuePath);
      const projectRows = commandCodeRows(projectQueuePath);
      // A project-append failure can leave an hourly snapshot on disk. Retrying
      // that same snapshot is safe: queue consumers use the latest row per key.
      assert.equal(hourlyRows.length, failedQueue === "hourly" ? 2 : 3);
      assert.equal(projectRows.length, 2);
      assert.deepEqual(hourlyRows.at(-1), { ...oldRow, ...corrected });
      assert.deepEqual(projectRows.at(-1), { ...oldProjectRow, ...corrected });
      assert.equal(cursors.commandCode.version, 1);

      const repeat = await parseCommandCodeIncremental({
        ...options, cursors: JSON.parse(JSON.stringify(cursors)),
      });
      assert.equal(repeat.recordsProcessed, 0);
      assert.equal(repeat.eventsAggregated, 0);
      assert.equal(repeat.bucketsQueued, 0);
      assert.equal(repeat.projectBucketsQueued, 0);
      assert.deepEqual(commandCodeRows(queuePath), hourlyRows);
      assert.deepEqual(commandCodeRows(projectQueuePath), projectRows);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("parseCommandCodeIncremental keeps mixed-model cache accounting disjoint and reported costs authoritative", async () => {
  const fixtures = [
    {
      id: "cache-read-only", model: "deepseek/deepseek-v4.1-flash",
      inputTokens: 700, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 20,
      input: 100, total: 720, costUsd: 0.001,
    },
    {
      id: "cache-write-only", model: "anthropic/claude-sonnet-4-5",
      inputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 20,
      input: 100, total: 170, costUsd: 0.002,
    },
    {
      id: "combined-caches", model: "anthropic/claude-opus-4-6",
      inputTokens: 750, cacheReadTokens: 600, cacheWriteTokens: 50, outputTokens: 20,
      input: 100, total: 770, costUsd: 0.003,
    },
    {
      id: "uncached", model: "openai/gpt-5.4",
      inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20,
      input: 100, total: 120, costUsd: 0.004,
    },
  ];
  const { dir, filePath } = makeTree({
    sessionId: "sess-mixed",
    lines: [headerLine("sess-mixed"), ...fixtures.map((fixture) => messageLine(fixture))],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  try {
    const first = await parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(first.recordsProcessed, fixtures.length);
    assert.equal(first.eventsAggregated, fixtures.length);
    assert.equal(first.bucketsQueued, fixtures.length, "models sharing one half-hour keep separate buckets");
    const rows = latestCommandCodeRows(queuePath);
    assert.equal(rows.size, fixtures.length);
    for (const fixture of fixtures) {
      const model = fixture.model.split("/")[1];
      const row = rows.get(`${model}|${T0}`);
      assert.deepEqual(row, {
        source: "command-code",
        model,
        hour_start: T0,
        input_tokens: fixture.input,
        cached_input_tokens: fixture.cacheReadTokens,
        cache_creation_input_tokens: fixture.cacheWriteTokens,
        output_tokens: fixture.outputTokens,
        reasoning_output_tokens: 0,
        total_tokens: fixture.total,
        billable_total_tokens: fixture.total,
        total_cost_usd: fixture.costUsd,
        conversation_count: 1,
      }, fixture.id);
      assert.equal(computeRowCost(row), fixture.costUsd, `${fixture.id} keeps the provider-reported bill`);
    }

    const second = await parseCommandCodeIncremental({
      sessionFiles: [filePath], cursors: JSON.parse(JSON.stringify(cursors)), queuePath,
    });
    assert.equal(second.recordsProcessed, 0);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.equal(commandCodeRows(queuePath).length, fixtures.length);
    assert.deepEqual(latestCommandCodeRows(queuePath), rows);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCommandCodeIncremental reconciles a rewritten transcript (resume/compaction) without double counting", async () => {
  const { dir, filePath } = makeTree({
    lines: [
      headerLine("sess-rewrite"),
      messageLine({ id: "m1", inputTokens: 1000, outputTokens: 100, costUsd: 0.001 }),
      messageLine({ id: "m2", timestamp: "2026-05-01T12:40:00.000Z", inputTokens: 2000, outputTokens: 200, costUsd: 0.002 }),
    ],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  try {
    await parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(latestCommandCodeTokens(queuePath), 1100 + 2200);

    // A resume drops m1's record and adds m3, rewriting the file in place.
    fs.writeFileSync(
      filePath,
      [
        headerLine("sess-rewrite"),
        messageLine({ id: "m2", timestamp: "2026-05-01T12:40:00.000Z", inputTokens: 2000, outputTokens: 200, costUsd: 0.002 }),
        messageLine({ id: "m3", timestamp: "2026-05-01T13:10:00.000Z", inputTokens: 3000, outputTokens: 300, costUsd: 0.003 }),
      ].join("\n") + "\n",
      "utf8",
    );
    await parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath });

    const buckets = latestCommandCodeRows(queuePath);
    // The dropped record's bucket reconciles back to zero instead of being
    // double counted or left behind.
    assertBucket(buckets.get("deepseek-v4.1-flash|2026-05-01T12:00:00.000Z"), 0, 0, 0);
    assertBucket(buckets.get("deepseek-v4.1-flash|2026-05-01T12:30:00.000Z"), 2000, 2200, 0.002);
    assertBucket(buckets.get("deepseek-v4.1-flash|2026-05-01T13:00:00.000Z"), 3000, 3300, 0.003);

    assert.equal(
      latestCommandCodeTokens(queuePath),
      2200 + 3300,
      "every surviving record is counted exactly once",
    );

    const repeat = await parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(repeat.eventsAggregated, 0, "a serialized rerun adds nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function assertBucket(row, inputTokens, totalTokens, cost) {
  assert.ok(row, "bucket exists");
  assert.equal(row.input_tokens, inputTokens);
  assert.equal(row.total_tokens, totalTokens);
  assert.ok(Math.abs(row.total_cost_usd - cost) < 1e-12, `cost ~${cost}, got ${row.total_cost_usd}`);
}

test("parseCommandCodeIncremental drops a deleted session's contribution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-delete-"));
  const home = path.join(dir, ".commandcode");
  const projectDir = path.join(home, "projects", "slug");
  fs.mkdirSync(projectDir, { recursive: true });
  const firstPath = path.join(projectDir, "sess-a.jsonl");
  const secondPath = path.join(projectDir, "sess-b.jsonl");
  fs.writeFileSync(firstPath, `${headerLine("sess-a")}\n${messageLine({ id: "a1", inputTokens: 1000, outputTokens: 100 })}\n`, "utf8");
  fs.writeFileSync(
    secondPath,
    `${headerLine("sess-b")}\n${messageLine({ id: "b1", timestamp: "2026-05-01T12:40:00.000Z", inputTokens: 700, outputTokens: 70 })}\n`,
    "utf8",
  );
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  try {
    await parseCommandCodeIncremental({ sessionFiles: [firstPath, secondPath], cursors, queuePath });
    assert.equal(latestCommandCodeTokens(queuePath), 1100 + 770);

    fs.rmSync(firstPath, { force: true });
    await parseCommandCodeIncremental({ sessionFiles: [secondPath], cursors, queuePath });
    assert.equal(
      latestCommandCodeTokens(queuePath),
      770,
      "a session whose transcript is gone stops contributing",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCommandCodeIncremental does not commit cursor state when queue append fails", async () => {
  const { dir, filePath } = makeTree({
    lines: [headerLine("sess-queue-failure"), messageLine({ id: "m1" })],
  });
  const queuePath = path.join(dir, "queue-as-directory");
  const cursors = {};
  fs.mkdirSync(queuePath);

  try {
    await assert.rejects(
      parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath }),
      /EISDIR|directory/i,
    );
    assert.equal(cursors.hourly, undefined);
    assert.equal(cursors.commandCode, undefined);

    fs.rmSync(queuePath, { recursive: true, force: true });
    const recovered = await parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(recovered.eventsAggregated, 1);
    const rows = commandCodeRows(queuePath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_tokens, 1100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCommandCodeIncremental attributes project usage from the session header cwd", async () => {
  const { dir, filePath } = makeTree({
    lines: [headerLine("sess-project", "/home/user/project"), messageLine({ id: "m1" })],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const projectQueuePath = path.join(dir, "queue.project.jsonl");
  const cursors = {};

  try {
    const result = await parseCommandCodeIncremental({
      sessionFiles: [filePath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(result.eventsAggregated, 1);
    assert.equal(commandCodeRows(queuePath).length, 1);
    // Project attribution requires a resolvable repository; a plain temp dir
    // yields no attributed rows but must never break the provider's buckets.
    assert.ok(result.projectBucketsQueued >= 0);

    // A header without cwd must not crash the parser either.
    const cwdless = path.join(path.dirname(filePath), "sess-nocwd.jsonl");
    fs.writeFileSync(
      cwdless,
      `${JSON.stringify({ type: "session", version: 3, id: "sess-nocwd" })}\n${messageLine({ id: "n1" })}\n`,
      "utf8",
    );
    const second = await parseCommandCodeIncremental({
      sessionFiles: [filePath, cwdless],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.eventsAggregated, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed fixture carries token counts and billed cost only", () => {
  const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, "fixture has a header and at least one record");
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.type === "session") {
      assert.equal(record.cwd, "/home/user/project", "fixture cwd is anonymized");
      continue;
    }
    assert.equal(record.message, null, "fixture never carries a message body");
    assert.ok(!Object.prototype.hasOwnProperty.call(record, "content"), "fixture has no content field");
    assert.ok(record.usage && typeof record.usage === "object", "fixture record carries usage counters");
  }
});

test("parseCommandCodeIncremental is a no-op with no files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-empty-"));
  const result = await parseCommandCodeIncremental({
    sessionFiles: [],
    cursors: {},
    queuePath: path.join(dir, "queue.jsonl"),
  });
  assert.equal(result.recordsProcessed, 0);
  assert.equal(result.eventsAggregated, 0);
  assert.equal(result.bucketsQueued, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

const LIFECYCLE_TOTALS = {
  input_tokens: 1000,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 100,
  reasoning_output_tokens: 0,
  total_tokens: 1100,
  billable_total_tokens: 1100,
  total_cost_usd: 0.42,
  conversation_count: 1,
};
const LIFECYCLE_ROW = {
  source: "command-code",
  model: "deepseek-v4.1-flash",
  hour_start: T0,
  ...LIFECYCLE_TOTALS,
};
const LIFECYCLE_KEY = `command-code:sess-lifecycle|m1`;

function makeLifecycleTree({ remote = true, prefix = "", message = null } = {}) {
  const tree = makeTree({ sessionId: "sess-lifecycle" });
  const repoDir = path.join(tree.dir, "synthetic-project-项目");
  fs.mkdirSync(repoDir);
  if (remote) writeLifecycleRemote(repoDir, "acme/lifecycle-fixture");
  const header = `${prefix}${headerLine("sess-lifecycle", repoDir)}\r\n`;
  fs.writeFileSync(tree.filePath, `${header}${messageLine({ id: "m1", costUsd: 0.42, message })}\n`);
  return {
    ...tree,
    repoDir,
    headerBytes: Buffer.byteLength(header),
    options: {
      sessionFiles: [tree.filePath],
      cursors: {},
      queuePath: path.join(tree.dir, "queue.jsonl"),
      projectQueuePath: path.join(tree.dir, "project.queue.jsonl"),
    },
  };
}

function writeLifecycleRemote(repoDir, projectKey) {
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".git", "config"),
    `[remote "origin"]\n\turl = https://github.com/${projectKey}.git\n`);
}

function latestCommandCodeProjectRows(queuePath) {
  return new Map(commandCodeRows(queuePath).map((row) => [
    `${row.project_key}|${row.hour_start}`, row,
  ]));
}

function lifecycleProjectRow(projectKey = "acme/lifecycle-fixture", totals = LIFECYCLE_TOTALS) {
  return {
    project_key: projectKey,
    project_ref: `https://github.com/${projectKey}`,
    source: "command-code",
    hour_start: T0,
    ...totals,
  };
}

function roundTripLifecycleCursors(options) {
  options.cursors = JSON.parse(JSON.stringify(options.cursors));
}

for (const removedIndex of [0, 1]) {
  test(`Command Code keeps a duplicate's 1100 tokens after deleting copy ${removedIndex + 1}`, async () => {
    const { dir, filePath, options } = makeLifecycleTree();
    const duplicate = path.join(path.dirname(filePath), "duplicate.jsonl");
    fs.copyFileSync(filePath, duplicate);
    options.sessionFiles = [filePath, duplicate];
    try {
      await parseCommandCodeIncremental(options);
      assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
      assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);
      fs.unlinkSync(options.sessionFiles[removedIndex]);
      options.sessionFiles.splice(removedIndex, 1);
      roundTripLifecycleCursors(options);

      await parseCommandCodeIncremental(options);
      assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
      assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);
      assert.equal(options.cursors.commandCode.messages[LIFECYCLE_KEY].filePath, options.sessionFiles[0]);
      roundTripLifecycleCursors(options);

      const repeat = await parseCommandCodeIncremental(options);
      assert.equal(repeat.recordsProcessed, 0);
      assert.equal(repeat.eventsAggregated, 0);
      assert.equal(repeat.bucketsQueued, 0);
      assert.equal(repeat.projectBucketsQueued, 0);
      assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
      assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("Command Code refreshes moved-file provenance even when accounting does not change", async () => {
  const { dir, filePath, options } = makeLifecycleTree();
  const moved = path.join(path.dirname(filePath), "moved.jsonl");
  try {
    await parseCommandCodeIncremental(options);
    fs.renameSync(filePath, moved);
    options.sessionFiles = [moved];
    roundTripLifecycleCursors(options);
    const move = await parseCommandCodeIncremental(options);
    assert.equal(move.bucketsQueued, 0);
    assert.equal(move.projectBucketsQueued, 0);
    assert.equal(options.cursors.commandCode.messages[LIFECYCLE_KEY].filePath, moved);
    assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);

    roundTripLifecycleCursors(options);
    const repeat = await parseCommandCodeIncremental(options);
    assert.equal(repeat.recordsProcessed, 0);
    assert.equal(repeat.eventsAggregated, 0);
    assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Command Code recovers version-1 file fingerprints with no new cache metadata", async () => {
  const { dir, filePath, options } = makeLifecycleTree();
  const duplicate = path.join(path.dirname(filePath), "duplicate.jsonl");
  fs.copyFileSync(filePath, duplicate);
  options.sessionFiles = [filePath, duplicate];
  try {
    await parseCommandCodeIncremental(options);
    const old = options.cursors.commandCode;
    // The deployed accounting-v1 format has no per-file ownership/header index.
    options.cursors.commandCode = {
      version: 1, messages: old.messages, files: old.files, updatedAt: old.updatedAt,
    };
    fs.unlinkSync(duplicate);
    options.sessionFiles = [filePath];
    roundTripLifecycleCursors(options);
    const recovered = await parseCommandCodeIncremental(options);
    assert.equal(recovered.recordsProcessed, 1, "old fingerprints must be reread once");
    assert.equal(options.cursors.commandCode.version, 1, "the accounting version is unchanged");
    assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);
    roundTripLifecycleCursors(options);
    const repeat = await parseCommandCodeIncremental(options);
    assert.equal(repeat.recordsProcessed, 0);
    assert.equal(repeat.eventsAggregated, 0);
    assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Command Code rereads an already-retracted version-1 survivor instead of keeping a poisoned cache", async () => {
  const { dir, filePath, options } = makeLifecycleTree();
  try {
    const zero = Object.fromEntries(Object.keys(LIFECYCLE_TOTALS).map((key) => [key, 0]));
    const { size, mtimeMs } = fs.statSync(filePath);
    options.cursors = {
      commandCode: { version: 1, messages: {}, files: { [filePath]: { size, mtimeMs } } },
    };
    fs.writeFileSync(options.queuePath, JSON.stringify({ ...LIFECYCLE_ROW, ...zero }) + "\n");
    await parseCommandCodeIncremental(options);
    assert.deepEqual(commandCodeRows(options.queuePath), [{ ...LIFECYCLE_ROW, ...zero }, LIFECYCLE_ROW]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);
    roundTripLifecycleCursors(options);
    const repeat = await parseCommandCodeIncremental(options);
    assert.equal(repeat.recordsProcessed, 0);
    assert.equal(repeat.bucketsQueued, 0);
    assert.deepEqual(commandCodeRows(options.queuePath).at(-1), LIFECYCLE_ROW);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Command Code restores a differing duplicate when the winning transcript is compacted", async () => {
  const { dir, filePath, repoDir, options } = makeLifecycleTree();
  const winner = path.join(path.dirname(filePath), "winner.jsonl");
  fs.writeFileSync(winner, `${headerLine("sess-lifecycle", repoDir)}\n${messageLine({
    id: "m1", inputTokens: 2000, outputTokens: 200, costUsd: 0.84,
  })}\n`);
  options.sessionFiles = [filePath, winner];
  try {
    await parseCommandCodeIncremental(options);
    const winningTotals = {
      ...LIFECYCLE_TOTALS, input_tokens: 2000, output_tokens: 200,
      total_tokens: 2200, billable_total_tokens: 2200, total_cost_usd: 0.84,
    };
    assert.deepEqual(commandCodeRows(options.queuePath), [{ ...LIFECYCLE_ROW, ...winningTotals }]);
    roundTripLifecycleCursors(options);
    await parseCommandCodeIncremental(options);
    assert.deepEqual(commandCodeRows(options.queuePath), [{ ...LIFECYCLE_ROW, ...winningTotals }]);

    fs.writeFileSync(winner, headerLine("sess-lifecycle", repoDir) + "\n");
    roundTripLifecycleCursors(options);
    await parseCommandCodeIncremental(options);
    assert.deepEqual(commandCodeRows(options.queuePath), [{ ...LIFECYCLE_ROW, ...winningTotals }, LIFECYCLE_ROW]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [
      lifecycleProjectRow("acme/lifecycle-fixture", winningTotals), lifecycleProjectRow(),
    ]);
    assert.equal(options.cursors.commandCode.messages[LIFECYCLE_KEY].filePath, filePath);
    roundTripLifecycleCursors(options);
    const repeat = await parseCommandCodeIncremental(options);
    assert.equal(repeat.recordsProcessed, 0);
    assert.equal(repeat.eventsAggregated, 0);
    assert.deepEqual(commandCodeRows(options.queuePath).at(-1), LIFECYCLE_ROW);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [operation, code] of [
  ["open", "EACCES"], ["open", "EPERM"], ["open", "EIO"],
  ["stat", "EACCES"], ["final-stat", "EIO"], ["readFile", "EIO"],
]) {
  test(`Command Code propagates ${operation} ${code} without changing either queue or any cursor`, async () => {
    const { dir, filePath, options } = makeLifecycleTree();
    const originalOpen = fsp.open;
    try {
      await parseCommandCodeIncremental(options);
      const before = JSON.parse(JSON.stringify(options.cursors));
      const beforeHourly = fs.readFileSync(options.queuePath);
      const beforeProject = fs.readFileSync(options.projectQueuePath);
      fs.appendFileSync(filePath, messageLine({ id: "m2", costUsd: 0.42 }) + "\n");
      const injected = Object.assign(new Error(`synthetic ${operation} failure`), { code });
      fsp.open = async function (file, ...args) {
        if (file !== filePath) return originalOpen.call(this, file, ...args);
        if (operation === "open") throw injected;
        const handle = await originalOpen.call(this, file, ...args);
        const method = operation === "readFile" ? "readFile" : "stat";
        const originalMethod = handle[method].bind(handle);
        let calls = 0;
        handle[method] = async (...methodArgs) => {
          calls += 1;
          if (operation !== "final-stat" || calls === 2) throw injected;
          return originalMethod(...methodArgs);
        };
        return handle;
      };
      await assert.rejects(parseCommandCodeIncremental(options), (error) => error === injected);
      assert.deepEqual(options.cursors, before, "all cursor state stays failure-atomic");
      assert.deepEqual(fs.readFileSync(options.queuePath), beforeHourly);
      assert.deepEqual(fs.readFileSync(options.projectQueuePath), beforeProject);
      fsp.open = originalOpen;

      await parseCommandCodeIncremental(options);
      const recoveredTotals = {
        ...LIFECYCLE_TOTALS, input_tokens: 2000, output_tokens: 200,
        total_tokens: 2200, billable_total_tokens: 2200,
        total_cost_usd: 0.84, conversation_count: 2,
      };
      assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW, { ...LIFECYCLE_ROW, ...recoveredTotals }]);
      assert.deepEqual(commandCodeRows(options.projectQueuePath), [
        lifecycleProjectRow(), lifecycleProjectRow("acme/lifecycle-fixture", recoveredTotals),
      ]);
      roundTripLifecycleCursors(options);
      const repeat = await parseCommandCodeIncremental(options);
      assert.equal(repeat.recordsProcessed, 0);
      assert.equal(repeat.bucketsQueued, 0);
      assert.equal(repeat.projectBucketsQueued, 0);
    } finally {
      fsp.open = originalOpen;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const replacement of ["missing", "directory"]) {
  test(`Command Code treats a confirmed ${replacement} transcript as deleted`, async () => {
    const { dir, filePath, options } = makeLifecycleTree();
    try {
      await parseCommandCodeIncremental(options);
      fs.unlinkSync(filePath);
      if (replacement === "directory") fs.mkdirSync(filePath);
      await parseCommandCodeIncremental(options);
      const zero = Object.fromEntries(Object.keys(LIFECYCLE_TOTALS).map((key) => [key, 0]));
      assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW, { ...LIFECYCLE_ROW, ...zero }]);
      assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow(), lifecycleProjectRow("acme/lifecycle-fixture", zero)]);
      assert.deepEqual(options.cursors.commandCode.messages, {});
      roundTripLifecycleCursors(options);
      const repeat = await parseCommandCodeIncremental(options);
      assert.equal(repeat.eventsAggregated, 0);
      assert.equal(repeat.bucketsQueued, 0);
      assert.equal(repeat.projectBucketsQueued, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const [level, code] of [["root", "EACCES"], ["project", "EPERM"], ["root", "EIO"]]) {
  test(`Command Code discovery propagates ${level} ${code} instead of returning an empty scan`, async () => {
    const { dir, home, projectDir, filePath } = makeTree();
    const originalReadDir = fsp.readdir;
    const failedPath = level === "root" ? path.join(home, "projects") : projectDir;
    const injected = Object.assign(new Error("synthetic discovery failure"), { code });
    const env = { TOKENTRACKER_COMMANDCODE_HOME: home };
    try {
      fsp.readdir = async function (file, ...args) {
        if (file === failedPath) throw injected;
        return originalReadDir.call(this, file, ...args);
      };
      await assert.rejects(resolveCommandCodeSessionFiles(env), (error) => error === injected);
      fsp.readdir = originalReadDir;
      assert.deepEqual(await resolveCommandCodeSessionFiles(env), [filePath]);
      assert.deepEqual(await resolveCommandCodeSessionFiles({
        TOKENTRACKER_COMMANDCODE_HOME: path.join(dir, "missing"),
      }), []);
    } finally {
      fsp.readdir = originalReadDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("Command Code refreshes Unicode/whitespace-prefixed project headers through the same bounded descriptor", async () => {
  const secret = "SYNTHETIC_BODY_NOT_NEEDED_FOR_PROJECT_REFRESH";
  const { dir, filePath, repoDir, headerBytes, options } = makeLifecycleTree({
    remote: false, prefix: " \t\r\n\r\n  ", message: secret.repeat(4096),
  });
  const originalOpen = fsp.open;
  const originalStat = fsp.stat;
  try {
    await parseCommandCodeIncremental(options);
    assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), []);
    const initialStat = fs.statSync(filePath);
    const hourlyBytes = fs.readFileSync(options.queuePath);
    let opens = 0;
    let headerReadBytes = 0;
    let stats = 0;
    fsp.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args);
      if (file !== filePath) return handle;
      opens += 1;
      const read = handle.read.bind(handle);
      const stat = handle.stat.bind(handle);
      handle.readFile = async () => assert.fail("unchanged message bodies must not be reread");
      handle.stat = async (...statArgs) => { stats += 1; return stat(...statArgs); };
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        headerReadBytes += result.bytesRead;
        assert.equal(result.buffer.toString("utf8").includes(secret), false);
        return result;
      };
      return handle;
    };
    fsp.stat = async function (file, ...args) {
      assert.notEqual(file, filePath, "transcript stat must share its read descriptor");
      return originalStat.call(this, file, ...args);
    };
    writeLifecycleRemote(repoDir, "acme/lifecycle-fixture");
    roundTripLifecycleCursors(options);
    const refreshed = await parseCommandCodeIncremental(options);
    assert.equal(refreshed.recordsProcessed, 0);
    assert.equal(refreshed.eventsAggregated, 1);
    assert.equal(refreshed.bucketsQueued, 0);
    assert.equal(refreshed.projectBucketsQueued, 1);
    assert.equal(opens, 1);
    assert.ok(stats >= 1);
    assert.ok(headerReadBytes > 0 && headerReadBytes <= headerBytes, "only the header byte range is read");
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);
    assert.deepEqual(fs.readFileSync(options.queuePath), hourlyBytes);
    const currentStat = fs.statSync(filePath);
    assert.equal(currentStat.size, initialStat.size);
    assert.equal(currentStat.mtimeMs, initialStat.mtimeMs);
    const persistedStrings = [];
    function collectStrings(value) {
      if (typeof value === "string") persistedStrings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collectStrings);
    }
    collectStrings(options.cursors);
    assert.equal(persistedStrings.some((value) => value.includes(repoDir) || value.includes(secret)), false,
      "neither raw cwd nor message body is persisted");

    writeLifecycleRemote(repoDir, "acme/another-lifecycle-fixture");
    roundTripLifecycleCursors(options);
    const changedRemote = await parseCommandCodeIncremental(options);
    assert.equal(changedRemote.recordsProcessed, 0);
    assert.equal(changedRemote.bucketsQueued, 0);
    assert.equal(changedRemote.projectBucketsQueued, 2);
    const zero = Object.fromEntries(Object.keys(LIFECYCLE_TOTALS).map((key) => [key, 0]));
    const projects = latestCommandCodeProjectRows(options.projectQueuePath);
    assert.deepEqual(projects, new Map([
      [`acme/lifecycle-fixture|${T0}`, lifecycleProjectRow("acme/lifecycle-fixture", zero)],
      [`acme/another-lifecycle-fixture|${T0}`, lifecycleProjectRow("acme/another-lifecycle-fixture")],
    ]));
    const projectBytes = fs.readFileSync(options.projectQueuePath);
    roundTripLifecycleCursors(options);
    const repeat = await parseCommandCodeIncremental(options);
    assert.equal(repeat.recordsProcessed, 0);
    assert.equal(repeat.eventsAggregated, 0);
    assert.equal(repeat.projectBucketsQueued, 0);
    assert.deepEqual(fs.readFileSync(options.queuePath), hourlyBytes);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), projectBytes);
  } finally {
    fsp.open = originalOpen;
    fsp.stat = originalStat;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Command Code propagates an unchanged-header read error without publishing project refresh", async () => {
  const { dir, filePath, repoDir, options } = makeLifecycleTree();
  const originalOpen = fsp.open;
  try {
    await parseCommandCodeIncremental(options);
    const before = JSON.parse(JSON.stringify(options.cursors));
    const hourlyBytes = fs.readFileSync(options.queuePath);
    const projectBytes = fs.readFileSync(options.projectQueuePath);
    writeLifecycleRemote(repoDir, "acme/another-lifecycle-fixture");
    const injected = Object.assign(new Error("synthetic header failure"), { code: "EPERM" });
    fsp.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args);
      if (file === filePath) handle.read = async () => { throw injected; };
      return handle;
    };
    await assert.rejects(parseCommandCodeIncremental(options), (error) => error === injected);
    assert.deepEqual(options.cursors, before);
    assert.deepEqual(fs.readFileSync(options.queuePath), hourlyBytes);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), projectBytes);
    fsp.open = originalOpen;
    const recovered = await parseCommandCodeIncremental(options);
    assert.equal(recovered.projectBucketsQueued, 2);
    assert.deepEqual(latestCommandCodeProjectRows(options.projectQueuePath).get(
      `acme/another-lifecycle-fixture|${T0}`), lifecycleProjectRow("acme/another-lifecycle-fixture"));
    assert.deepEqual(fs.readFileSync(options.queuePath), hourlyBytes);
  } finally {
    fsp.open = originalOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const probe of ["native", "wsl"]) {
  test(`Command Code rejects an incomplete Windows ${probe} home probe`, () => {
    const nativeHome = "C:\\synthetic\\.commandcode";
    const wslHome = "\\\\wsl$\\Synthetic\\home\\fixture\\.commandcode";
    const injected = Object.assign(new Error("synthetic home-probe failure"), { code: "EACCES" });
    const deps = {
      platform: "win32",
      nativeHome,
      existsSync(candidate) {
        if (candidate === (probe === "native" ? nativeHome : wslHome)) throw injected;
        return false;
      },
      discoverWslHome(provider, options) {
        assert.equal(provider, ".commandcode");
        // The shared WSL helper catches failed existence probes. The provider
        // must still surface their observation error before reconciling zero.
        try { options.existsSync(wslHome); } catch (_error) {}
        return null;
      },
    };
    assert.throws(() => resolveCommandCodeHomes({
      TOKENTRACKER_WSL_MODE: probe === "native" ? "native-only" : "wsl-only",
    }, deps), (error) => error === injected);
  });
}

test("Command Code preserves both roots when one discovery fails and recovers pending healthy-root usage", async () => {
  const { dir, home, filePath, repoDir, options } = makeLifecycleTree();
  const secondHome = path.join(dir, "synthetic-wsl", ".commandcode");
  const secondProject = path.join(secondHome, "projects", "second");
  const secondFile = path.join(secondProject, "second.jsonl");
  fs.mkdirSync(secondProject, { recursive: true });
  fs.writeFileSync(secondFile, `${headerLine("second-session", repoDir)}\n${messageLine({ id: "m1", costUsd: 0.42 })}\n`);
  const env = { TOKENTRACKER_WSL_MODE: "both" };
  const deps = {
    platform: "win32", nativeHome: home,
    existsSync: (candidate) => candidate === home,
    discoverWslHome: () => secondHome,
  };
  const originalReadDir = fsp.readdir;
  const sync = async () => {
    options.sessionFiles = await resolveCommandCodeSessionFiles(env, deps);
    return parseCommandCodeIncremental(options);
  };
  try {
    await sync();
    const bothTotals = {
      ...LIFECYCLE_TOTALS, input_tokens: 2000, output_tokens: 200,
      total_tokens: 2200, billable_total_tokens: 2200, total_cost_usd: 0.84, conversation_count: 2,
    };
    assert.deepEqual(commandCodeRows(options.queuePath), [{ ...LIFECYCLE_ROW, ...bothTotals }]);
    const before = JSON.parse(JSON.stringify(options.cursors));
    const hourlyBytes = fs.readFileSync(options.queuePath);
    const projectBytes = fs.readFileSync(options.projectQueuePath);
    fs.appendFileSync(filePath, messageLine({ id: "m2", costUsd: 0.42 }) + "\n");
    const injected = Object.assign(new Error("synthetic second-root failure"), { code: "EIO" });
    fsp.readdir = async function (file, ...args) {
      if (file === secondProject) throw injected;
      return originalReadDir.call(this, file, ...args);
    };
    await assert.rejects(sync(), (error) => error === injected);
    assert.deepEqual(options.cursors, before);
    assert.deepEqual(fs.readFileSync(options.queuePath), hourlyBytes);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), projectBytes);
    fsp.readdir = originalReadDir;
    await sync();
    const recoveredTotals = {
      ...LIFECYCLE_TOTALS, input_tokens: 3000, output_tokens: 300,
      total_tokens: 3300, billable_total_tokens: 3300, total_cost_usd: 1.26, conversation_count: 3,
    };
    assert.deepEqual(commandCodeRows(options.queuePath), [
      { ...LIFECYCLE_ROW, ...bothTotals }, { ...LIFECYCLE_ROW, ...recoveredTotals },
    ]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [
      lifecycleProjectRow("acme/lifecycle-fixture", bothTotals),
      lifecycleProjectRow("acme/lifecycle-fixture", recoveredTotals),
    ]);
    roundTripLifecycleCursors(options);
    const repeat = await sync();
    assert.equal(repeat.recordsProcessed, 0);
    assert.equal(repeat.eventsAggregated, 0);
  } finally {
    fsp.readdir = originalReadDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Command Code keeps long leading whitespace out of its bounded header-only read", async () => {
  const { dir, filePath, repoDir, options } = makeLifecycleTree({
    remote: false, prefix: " ".repeat(70000), message: "synthetic body".repeat(10000),
  });
  const originalOpen = fsp.open;
  try {
    await parseCommandCodeIncremental(options);
    writeLifecycleRemote(repoDir, "acme/lifecycle-fixture");
    fsp.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args);
      if (file === filePath) handle.readFile = async () => assert.fail("leading whitespace must not force a body reread");
      return handle;
    };
    const refreshed = await parseCommandCodeIncremental(options);
    assert.equal(refreshed.recordsProcessed, 0);
    assert.equal(refreshed.projectBucketsQueued, 1);
    assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);
  } finally {
    fsp.open = originalOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Command Code uses one descriptor for cold reads and short Unicode header reads", async () => {
  const { dir, filePath, options } = makeLifecycleTree();
  const originalOpen = fsp.open;
  const originalStat = fsp.stat;
  let opens = 0;
  let fullReads = 0;
  let stats = 0;
  let closes = 0;
  let reads = 0;
  try {
    fsp.stat = async function (file, ...args) {
      assert.notEqual(file, filePath, "no path-based transcript stat is allowed");
      return originalStat.call(this, file, ...args);
    };
    fsp.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args);
      if (file !== filePath) return handle;
      opens += 1;
      const stat = handle.stat.bind(handle);
      const readFile = handle.readFile.bind(handle);
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      handle.stat = async (...values) => { stats += 1; return stat(...values); };
      handle.readFile = async (...values) => { fullReads += 1; return readFile(...values); };
      handle.read = async (buffer, offset, length, position) => {
        reads += 1;
        return read(buffer, offset, Math.min(7, length), position);
      };
      handle.close = async (...values) => { closes += 1; return close(...values); };
      return handle;
    };
    await parseCommandCodeIncremental(options);
    assert.deepEqual({ opens, fullReads, stats, closes, reads }, { opens: 1, fullReads: 1, stats: 2, closes: 1, reads: 0 });
    roundTripLifecycleCursors(options);
    const repeat = await parseCommandCodeIncremental(options);
    assert.equal(repeat.recordsProcessed, 0);
    assert.equal(repeat.eventsAggregated, 0);
    assert.deepEqual({ opens, fullReads, stats, closes }, { opens: 2, fullReads: 1, stats: 4, closes: 2 });
    assert.ok(reads > 1, "short reads must loop until the Unicode header is complete");
    assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow()]);
  } finally {
    fsp.open = originalOpen;
    fsp.stat = originalStat;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Command Code rebuilds a transcript that changes during its cached header read on the same descriptor", async () => {
  const { dir, filePath, options } = makeLifecycleTree();
  const originalOpen = fsp.open;
  try {
    await parseCommandCodeIncremental(options);
    let opens = 0;
    let appended = false;
    let fullReads = 0;
    fsp.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args);
      if (file !== filePath) return handle;
      opens += 1;
      const read = handle.read.bind(handle);
      const readFile = handle.readFile.bind(handle);
      handle.read = async (...values) => {
        const result = await read(...values);
        if (!appended) {
          appended = true;
          fs.appendFileSync(filePath, messageLine({ id: "m2", costUsd: 0.42 }) + "\n");
        }
        return result;
      };
      handle.readFile = async (...values) => { fullReads += 1; return readFile(...values); };
      return handle;
    };
    const changed = await parseCommandCodeIncremental(options);
    assert.equal(opens, 1);
    assert.equal(fullReads, 1);
    assert.equal(changed.recordsProcessed, 2);
    const recoveredTotals = {
      ...LIFECYCLE_TOTALS, input_tokens: 2000, output_tokens: 200,
      total_tokens: 2200, billable_total_tokens: 2200, total_cost_usd: 0.84, conversation_count: 2,
    };
    assert.deepEqual(commandCodeRows(options.queuePath), [LIFECYCLE_ROW, { ...LIFECYCLE_ROW, ...recoveredTotals }]);
    assert.deepEqual(commandCodeRows(options.projectQueuePath), [lifecycleProjectRow(), lifecycleProjectRow("acme/lifecycle-fixture", recoveredTotals)]);
    fsp.open = originalOpen;
    roundTripLifecycleCursors(options);
    const repeat = await parseCommandCodeIncremental(options);
    assert.equal(repeat.recordsProcessed, 0);
    assert.equal(repeat.eventsAggregated, 0);
  } finally {
    fsp.open = originalOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
