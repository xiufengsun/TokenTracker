const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  cmdSync,
  migrateRolloutCumulativeDeltaBuckets,
} = require("../src/commands/sync");
const {
  filterColdCodexRolloutFiles,
  parseRolloutIncremental,
} = require("../src/lib/rollout");
const {
  STORE_DIRNAME,
  openCursorStore,
  readCursorStateSummary,
} = require("../src/lib/cursor-store");
const { withHome } = require("./helpers/with-home");

const LARGE_HASH_COUNT = 379_000;

function buildProductionScaleHashes() {
  const suffix = "x".repeat(158);
  return Array.from(
    { length: LARGE_HASH_COUNT },
    (_, index) => `${index.toString(36).padStart(6, "0")}:${suffix}`,
  );
}

function codexUsage(totalTokens) {
  return {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
}

function codexTokenEvent(timestamp, totalTokens) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: codexUsage(totalTokens) },
    },
  };
}

async function readJsonlRows(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function withIsolatedCodexHome(prefix, fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const restoreHome = withHome(home);
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = path.join(home, ".codex");
  process.env.CODEX_HOME = codexHome;
  try {
    await fn({
      home,
      codexHome,
      trackerDir: path.join(home, ".tokentracker", "tracker"),
    });
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    restoreHome();
    await fs.rm(home, { recursive: true, force: true });
  }
}

function observeWholeArrayReads(values) {
  const metrics = {
    iterator_reads: 0,
    indexed_reads: 0,
    copy_method_reads: 0,
  };
  const copyMethods = new Set(["concat", "filter", "flat", "flatMap", "map", "slice", "toSpliced"]);
  const proxy = new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) metrics.iterator_reads += 1;
      if (typeof property === "string" && /^\d+$/.test(property)) metrics.indexed_reads += 1;
      if (copyMethods.has(property)) metrics.copy_method_reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxy, metrics };
}

test("idle Codex parsing does not materialize a production-scale hash Set or array copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-hot-"));
  try {
    const hashes = buildProductionScaleHashes();
    const cursorBytes = Buffer.byteLength(JSON.stringify({ version: 1, files: {}, codexHashes: hashes }));
    assert.ok(cursorBytes >= 60 * 1024 * 1024, `expected >=60 MiB, got ${cursorBytes}`);
    assert.ok(cursorBytes <= 62 * 1024 * 1024, `expected <=62 MiB, got ${cursorBytes}`);
    const observedHashes = observeWholeArrayReads(hashes);
    const cursors = { version: 1, files: {}, codexHashes: observedHashes.proxy };

    const diagnostics = {};
    await parseRolloutIncremental({
      rolloutFiles: [],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      source: "codex",
      diagnostics,
    });

    assert.strictEqual(cursors.codexHashes, observedHashes.proxy, "idle parsing must not copy the hash array");
    assert.deepEqual(observedHashes.metrics, {
      iterator_reads: 0,
      indexed_reads: 0,
      copy_method_reads: 0,
    });
    assert.equal(diagnostics.discovered_rollouts, 0);
    assert.equal(diagnostics.stat_candidates, 0);
    assert.equal(diagnostics.content_files_read, 0);
    assert.equal(diagnostics.hash_set_constructions, 0);
    assert.equal(diagnostics.hash_array_materializations, 0);
    assert.equal(diagnostics.hash_array_materialized_items, 0);
    assert.equal(diagnostics.codex_hash_count, LARGE_HASH_COUNT);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex sync skips candidate reductions when diagnostics are disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-no-diagnostics-"));
  try {
    const rolloutFiles = new Proxy([], {
      get(target, property, receiver) {
        if (property === "reduce") {
          throw new Error("diagnostics-disabled paths must not read Array#reduce");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const cursors = { version: 1, files: {}, codexHashes: [] };

    const filtered = await filterColdCodexRolloutFiles({
      rolloutFiles,
      cursors,
      auditDue: true,
    });
    assert.strictEqual(filtered.rolloutFiles, rolloutFiles);

    const parsed = await parseRolloutIncremental({
      rolloutFiles,
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      source: "codex",
    });
    assert.equal(parsed.filesProcessed, 0);
    assert.equal(parsed.eventsAggregated, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cold filtering distinguishes discovered rollouts, cursor keys, parse candidates, and skipped files", async () => {
  const oldPath = path.join(
    "/tmp", "sessions", "2029", "01", "01",
    "rollout-2029-01-01T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
  );
  const activePath = path.join(
    "/tmp", "sessions", "2030", "06", "02",
    "rollout-2030-06-02T00-00-00-bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jsonl",
  );
  const rolloutFiles = [
    { path: oldPath, source: "codex" },
    { path: activePath, source: "codex" },
  ];
  const cursors = {
    version: 1,
    files: {
      [oldPath]: { inode: 1, offset: 100 },
      [activePath]: { inode: 2, offset: 100 },
    },
    codexHashes: [],
  };
  const diagnostics = {};

  const filtered = await filterColdCodexRolloutFiles({
    rolloutFiles,
    cursors,
    diagnostics,
    nowMs: Date.UTC(2030, 5, 2, 12, 0, 0),
    recentDays: 2,
  });

  assert.deepEqual(filtered.rolloutFiles, [rolloutFiles[1]]);
  assert.equal(filtered.skipped, 1);
  assert.equal(diagnostics.discovered_rollouts, 2);
  assert.equal(diagnostics.cursor_keys, 2);
  assert.equal(diagnostics.parse_candidates, 1);
  assert.equal(diagnostics.cold_skipped, 1);
  assert.ok(diagnostics.cold_skipped <= diagnostics.discovered_rollouts);
});

test("v2 cold filtering batches shard decisions and loads by day directory", async () => {
  const oldDir = path.join("/tmp", ".codex", "sessions", "2029", "01", "01");
  const activeDir = path.join("/tmp", ".codex", "sessions", "2030", "06", "02");
  const rolloutFiles = [
    { path: path.join(oldDir, "rollout-2029-01-01T00-00-00-a.jsonl"), source: "codex" },
    { path: path.join(oldDir, "rollout-2029-01-01T01-00-00-b.jsonl"), source: "codex" },
    { path: path.join(activeDir, "rollout-2030-06-02T00-00-00-c.jsonl"), source: "codex" },
    { path: path.join(activeDir, "rollout-2030-06-02T01-00-00-d.jsonl"), source: "codex" },
  ];
  const calls = { skip: 0, load: 0 };
  const codexCursorStore = {
    fileCount: rolloutFiles.length,
    async canSkipCodexDay() {
      calls.skip += 1;
      return true;
    },
    async loadCodexFilesForPaths() {
      calls.load += 1;
    },
  };

  const filtered = await filterColdCodexRolloutFiles({
    rolloutFiles,
    cursors: { version: 1, files: {}, codexDayInventoryCache: { version: 1, days: {} } },
    codexCursorStore,
    nowMs: Date.UTC(2030, 5, 2, 12, 0, 0),
    recentDays: 2,
  });

  assert.deepEqual(filtered.rolloutFiles, rolloutFiles.slice(2));
  assert.equal(filtered.skipped, 2);
  assert.deepEqual(calls, { skip: 1, load: 1 });
});

test("v2 cold filtering parses a grown recent rollout even when its day is skippable (#592)", async () => {
  // The day-level skip keys off the directory stat, which does not change when
  // a file inside it is appended to. A still-open cross-day session must be
  // caught by the per-file growth check before the day skip is consulted.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-cold-growth-"));
  try {
    const now = new Date(2030, 5, 5, 12, 0, 0).getTime();
    const oldDir = path.join(root, ".codex", "sessions", "2030", "06", "02");
    await fs.mkdir(oldDir, { recursive: true });
    const grownPath = path.join(oldDir, "rollout-2030-06-02T00-00-00-a.jsonl");
    const eofPath = path.join(oldDir, "rollout-2030-06-02T01-00-00-b.jsonl");
    const activePath = path.join(root, ".codex", "sessions", "2030", "06", "05", "rollout-2030-06-05T00-00-00-c.jsonl");
    await fs.writeFile(grownPath, "x".repeat(500));
    await fs.writeFile(eofPath, "x".repeat(100));
    const cursors = {
      version: 1,
      files: {
        [grownPath]: { inode: 1, offset: 100, projectOffset: 100 },
        [eofPath]: { inode: 2, offset: 100, projectOffset: 100 },
        [activePath]: { inode: 3, offset: 10, projectOffset: 10 },
      },
      codexDayInventoryCache: { version: 1, days: {} },
    };
    const calls = { skip: 0 };
    const codexCursorStore = {
      fileCount: 3,
      async canSkipCodexDay() {
        calls.skip += 1;
        return true;
      },
      async loadCodexFilesForPaths() {},
    };

    const filtered = await filterColdCodexRolloutFiles({
      rolloutFiles: [
        { path: grownPath, source: "codex" },
        { path: eofPath, source: "codex" },
        { path: activePath, source: "codex" },
      ],
      cursors,
      codexCursorStore,
      nowMs: now,
      recentDays: 2,
    });

    assert.deepEqual(filtered.rolloutFiles.map((entry) => entry.path), [grownPath, activePath]);
    assert.equal(filtered.skipped, 1);
    assert.equal(calls.skip, 1, "the EOF file still takes the day-level skip");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("v2 cold filtering discards partial skip decisions after generation fallback", async () => {
  const oldPath = path.join(
    "/tmp", ".codex", "sessions", "2029", "01", "01", "rollout-old.jsonl",
  );
  const activePath = path.join(
    "/tmp", ".codex", "sessions", "2030", "06", "02", "rollout-active.jsonl",
  );
  const rolloutFiles = [
    { path: oldPath, source: "codex" },
    { path: activePath, source: "codex" },
  ];
  const calls = [];
  const codexCursorStore = {
    fileCount: rolloutFiles.length,
    async canSkipCodexDay() {
      return true;
    },
    async loadCodexFilesForPaths(files) {
      calls.push(files);
      return { restarted: calls.length === 1 };
    },
  };
  const diagnostics = {};

  const filtered = await filterColdCodexRolloutFiles({
    rolloutFiles,
    cursors: { version: 1, files: {}, codexDayInventoryCache: { version: 1, days: {} } },
    codexCursorStore,
    diagnostics,
    nowMs: Date.UTC(2030, 5, 2, 12, 0, 0),
    recentDays: 2,
  });

  assert.strictEqual(filtered.rolloutFiles, rolloutFiles);
  assert.equal(filtered.skipped, 0);
  assert.equal(filtered.restarted, true);
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[1], rolloutFiles);
  assert.equal(diagnostics.cold_skipped, 0);
  assert.equal(diagnostics.parse_candidates, 2);
});

test("Codex sync diagnostics keep candidate counts source-scoped after mixed-source parsing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-mixed-diagnostics-"));
  try {
    const oldPath = path.join(root, "rollout-2029-01-01T00-00-00-old.jsonl");
    const activePath = path.join(root, "rollout-2030-06-02T00-00-00-active.jsonl");
    const everyCodePath = path.join(root, "every-code.jsonl");
    const rolloutFiles = [
      { path: oldPath, source: "codex" },
      { path: activePath, source: "codex" },
      { path: everyCodePath, source: "every-code" },
    ];
    const cursors = {
      version: 1,
      files: {
        [oldPath]: { inode: 1, offset: 100 },
        [activePath]: { inode: 2, offset: 100 },
        [everyCodePath]: { inode: 3, offset: 100 },
      },
      codexHashes: [],
    };
    const diagnostics = {};
    const filtered = await filterColdCodexRolloutFiles({
      rolloutFiles,
      cursors,
      diagnostics,
      nowMs: Date.UTC(2030, 5, 2, 12, 0, 0),
      recentDays: 2,
    });
    assert.equal(diagnostics.discovered_rollouts, 2);
    assert.equal(diagnostics.parse_candidates, 1);

    await parseRolloutIncremental({
      rolloutFiles: filtered.rolloutFiles,
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      diagnostics,
    });
    assert.equal(diagnostics.discovered_rollouts, 2);
    assert.equal(diagnostics.parse_candidates, 1, "Every Code must not inflate the Codex candidate count");
    assert.equal(diagnostics.stat_candidates, 1);
    assert.equal(diagnostics.content_files_read, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a production-scale same-inode append avoids the historical Codex hash Set", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-append-"));
  try {
    const hashes = buildProductionScaleHashes();
    const observedHashes = observeWholeArrayReads(hashes);
    const rolloutPath = path.join(
      root,
      "rollout-2030-06-02T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    );
    const baseline = {
      timestamp: "2030-06-02T00:30:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 4,
            cached_input_tokens: 1,
            cache_creation_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: 6,
          },
        },
      },
    };
    const appended = {
      timestamp: "2030-06-02T01:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_creation_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 14,
          },
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_creation_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 14,
          },
        },
      },
    };
    const baselineLine = `${JSON.stringify(baseline)}\n`;
    await fs.writeFile(rolloutPath, baselineLine, "utf8");
    await fs.appendFile(rolloutPath, `${JSON.stringify(appended)}\n`, "utf8");
    const stat = await fs.stat(rolloutPath);
    const cursors = {
      version: 1,
      files: {
        [rolloutPath]: {
          inode: stat.ino,
          offset: Buffer.byteLength(baselineLine),
          lastTotal: baseline.payload.info.total_token_usage,
        },
      },
      codexHashes: observedHashes.proxy,
    };
    const diagnostics = {};

    const first = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      source: "codex",
      diagnostics,
    });
    assert.equal(first.filesProcessed, 1);
    assert.equal(first.eventsAggregated, 1);
    assert.equal(diagnostics.discovered_rollouts, 1);
    assert.equal(diagnostics.stat_candidates, 1);
    assert.equal(diagnostics.content_files_read, 1);
    assert.equal(diagnostics.hash_set_constructions, 0);
    assert.equal(diagnostics.hash_array_materializations, 0);
    assert.equal(diagnostics.hash_array_materialized_items, 0);
    assert.equal(cursors.codexHashes.length, LARGE_HASH_COUNT + 1);
    assert.strictEqual(cursors.codexHashes, observedHashes.proxy);
    assert.equal(observedHashes.metrics.iterator_reads, 0);
    assert.equal(observedHashes.metrics.indexed_reads, 0);
    assert.equal(observedHashes.metrics.copy_method_reads, 0);

    const persistedHashes = cursors.codexHashes;
    const idleDiagnostics = {};
    await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      source: "codex",
      diagnostics: idleDiagnostics,
    });
    assert.strictEqual(cursors.codexHashes, persistedHashes);
    assert.equal(idleDiagnostics.hash_set_constructions, 0);
    assert.equal(idleDiagnostics.hash_array_materializations, 0);
    assert.equal(idleDiagnostics.content_files_read, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a legacy same-inode append without lastTotal rebuilds its cumulative baseline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-legacy-baseline-"));
  try {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const baselineTimestamp = "2030-06-02T01:00:00.000Z";
    const targetTimestamp = "2030-06-02T01:05:00.000Z";
    const rolloutPath = path.join(
      root,
      `rollout-2030-06-02T01-00-00-${sessionId}.jsonl`,
    );
    const baselineUsage = {
      input_tokens: 20,
      cached_input_tokens: 5,
      cache_creation_input_tokens: 0,
      output_tokens: 4,
      reasoning_output_tokens: 1,
      total_tokens: 24,
    };
    const targetUsage = {
      input_tokens: 35,
      cached_input_tokens: 10,
      cache_creation_input_tokens: 0,
      output_tokens: 9,
      reasoning_output_tokens: 2,
      total_tokens: 44,
    };
    const event = (timestamp, usage) => ({
      timestamp,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage } },
    });
    const baselineLine = `${JSON.stringify(event(baselineTimestamp, baselineUsage))}\n`;
    await fs.writeFile(rolloutPath, baselineLine, "utf8");
    await fs.appendFile(
      rolloutPath,
      `${JSON.stringify(event(targetTimestamp, targetUsage))}\n`,
      "utf8",
    );
    const stat = await fs.stat(rolloutPath);
    const cursors = {
      version: 1,
      files: {
        [rolloutPath]: {
          inode: stat.ino,
          offset: Buffer.byteLength(baselineLine),
        },
      },
      codexHashes: [`${sessionId}:${baselineTimestamp}`],
    };
    const diagnostics = {};

    const result = await parseRolloutIncremental({
      rolloutFiles: [{ path: rolloutPath, source: "codex" }],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      diagnostics,
    });

    assert.equal(result.eventsAggregated, 1);
    assert.equal(diagnostics.hash_set_constructions, 1);
    assert.deepEqual(cursors.files[rolloutPath].lastTotal, targetUsage);
    assert.deepEqual(cursors.codexHashes, [
      `${sessionId}:${baselineTimestamp}`,
      `${sessionId}:${targetTimestamp}`,
    ]);
    const codexTotal = Object.entries(cursors.hourly.buckets)
      .filter(([key]) => key.startsWith("codex|"))
      .reduce((sum, [, bucket]) => sum + Number(bucket.totals.total_tokens || 0), 0);
    assert.equal(codexTotal, 20, "only the cumulative growth after the legacy cursor is new");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an inode rewrite still uses historical Codex hashes without rematerializing the array", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-rewrite-hot-"));
  try {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const timestamp = "2030-06-02T01:00:00.000Z";
    const rolloutPath = path.join(
      root,
      `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`,
    );
    await fs.writeFile(rolloutPath, `${JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_creation_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
          },
        },
      },
    })}\n`, "utf8");
    const stat = await fs.stat(rolloutPath);
    const hashes = [`${sessionId}:${timestamp}`];
    const observedHashes = observeWholeArrayReads(hashes);
    const cursors = {
      version: 1,
      files: {
        [rolloutPath]: { inode: stat.ino + 1, offset: stat.size, lastTotal: null },
      },
      codexHashes: observedHashes.proxy,
    };
    const diagnostics = {};

    const result = await parseRolloutIncremental({
      rolloutFiles: [rolloutPath],
      cursors,
      queuePath: path.join(root, "queue.jsonl"),
      source: "codex",
      diagnostics,
    });

    assert.equal(result.eventsAggregated, 0);
    assert.equal(diagnostics.hash_set_constructions, 1);
    assert.equal(diagnostics.hash_array_materializations, 0);
    assert.strictEqual(cursors.codexHashes, observedHashes.proxy);
    assert.equal(observedHashes.metrics.iterator_reads, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the cumulative-delta migration rebuilds Codex hashes when a session has a stale path cursor", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-migration-"));
  try {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const timestamp = "2030-06-02T01:00:00.000Z";
    const livePath = path.join(
      root,
      "sessions",
      "2030",
      "06",
      "02",
      `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`,
    );
    const archivedPath = path.join(
      root,
      "archived_sessions",
      `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`,
    );
    await fs.mkdir(path.dirname(archivedPath), { recursive: true });
    await fs.writeFile(archivedPath, `${JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_creation_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
          },
        },
      },
    })}\n`, "utf8");
    const stat = await fs.stat(archivedPath);
    const queuePath = path.join(root, "queue.jsonl");
    const cursors = {
      version: 1,
      files: {
        [livePath]: { inode: stat.ino, offset: stat.size },
        [archivedPath]: { inode: stat.ino, offset: stat.size },
      },
      codexHashes: [`${sessionId}:${timestamp}`],
      hourly: {
        buckets: {
          "codex|unknown|2030-06-02T01:00:00.000Z": {
            totals: { total_tokens: 13 },
          },
        },
        groupQueued: {},
      },
    };

    await migrateRolloutCumulativeDeltaBuckets({
      cursors,
      queuePath,
      rolloutFiles: [{ path: archivedPath, source: "codex" }],
    });
    const result = await parseRolloutIncremental({
      rolloutFiles: [{ path: archivedPath, source: "codex" }],
      cursors,
      queuePath,
    });

    assert.equal(result.eventsAggregated, 1);
    assert.deepEqual(cursors.codexHashes, [`${sessionId}:${timestamp}`]);
    assert.equal(
      cursors.hourly.buckets["codex|unknown|2030-06-02T01:00:00.000Z"].totals.total_tokens,
      13,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source-scoped sync preserves audit state and reports the actual cursor commit path and bytes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-sync-commit-"));
  const restoreHome = withHome(home);
  const previousCodexHome = process.env.CODEX_HOME;
  const RealDate = Date;
  const fixedNow = "2030-06-02T12:34:56.789Z";
  const fixedNowMs = RealDate.parse(fixedNow);
  global.Date = class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [fixedNowMs]));
    }

    static now() {
      return fixedNowMs;
    }
  };
  try {
    const codexHome = path.join(home, ".codex");
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const auditState = {
      version: 1,
      lastFullScanAtMs: fixedNowMs - 60 * 60 * 1000,
      lastFullScanAt: "2030-06-02T11:34:56.789Z",
      syncsSinceFullScan: 7,
      lastSkippedFiles: 123,
      updatedAt: "2030-06-02T11:34:56.789Z",
    };
    const expectedAuditState = {
      ...auditState,
      syncsSinceFullScan: 8,
      lastSkippedFiles: 0,
      updatedAt: fixedNow,
    };
    const hashes = buildProductionScaleHashes();
    const initial = {
      version: 1,
      files: {},
      codexHashes: hashes,
      codexColdScanAudit: auditState,
    };
    const initialRaw = `${JSON.stringify(initial)}\n`;
    await fs.writeFile(cursorsPath, initialRaw, "utf8");

    const diagnostics = {};
    await cmdSync(
      ["--auto", "--from-retry", "--source=codex"],
      { diagnostics },
    );

    assert.equal(
      await fs.readFile(cursorsPath, "utf8"),
      initialRaw,
      "v2 migration must keep the downgrade-compatible legacy snapshot frozen",
    );
    const raw = await fs.readFile(diagnostics.cursor_path, "utf8");
    const persisted = JSON.parse(raw);
    assert.deepEqual(persisted, {
      version: 1,
      files: {},
      codexColdScanAudit: expectedAuditState,
      codexDayInventoryCache: { version: 1, days: {} },
      hourly: {
        version: 3,
        buckets: {},
        groupQueued: {},
        updatedAt: fixedNow,
      },
      projectHourly: {
        version: 2,
        buckets: {},
        projects: {},
        updatedAt: fixedNow,
      },
      updatedAt: fixedNow,
    });
    assert.deepEqual(diagnostics, {
      discovered_rollouts: 0,
      cursor_keys: 0,
      parse_candidates: 0,
      stat_candidates: 0,
      cold_skipped: 0,
      content_files_read: 0,
      hash_set_constructions: 0,
      hash_array_materializations: 0,
      hash_array_materialized_items: 0,
      codex_hash_count: LARGE_HASH_COUNT,
      cursor_commits: 1,
      cursor_bytes: Buffer.byteLength(raw),
      cursor_path: diagnostics.cursor_path,
    });
    assert.notEqual(diagnostics.cursor_path, cursorsPath);
    assert.ok(
      diagnostics.cursor_path.includes(`${path.sep}${STORE_DIRNAME}${path.sep}generations${path.sep}`),
    );
    const summary = await readCursorStateSummary({ trackerDir, cursorsPath });
    assert.equal(summary.mode, "v2");
    assert.equal(summary.codexEventCount, LARGE_HASH_COUNT);
  } finally {
    global.Date = RealDate;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    restoreHome();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("v2 source-scoped sync commits a same-inode append without loading historical hashes", async () => {
  await withIsolatedCodexHome("tt-codex-v2-append-", async ({ codexHome, trackerDir }) => {
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const dayDir = path.join(codexHome, "sessions", "2030", "06", "02");
    const rolloutPath = path.join(
      dayDir,
      `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`,
    );
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const queuePath = path.join(trackerDir, "queue.jsonl");
    await fs.mkdir(dayDir, { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });

    const baselineTimestamp = "2030-06-02T00:30:00.000Z";
    const appendedTimestamp = "2030-06-02T00:35:00.000Z";
    const baselineLine = `${JSON.stringify(codexTokenEvent(baselineTimestamp, 10))}\n`;
    const appendedLine = `${JSON.stringify(codexTokenEvent(appendedTimestamp, 25))}\n`;
    const baselineBytes = Buffer.byteLength(baselineLine);
    await fs.writeFile(rolloutPath, `${baselineLine}${appendedLine}`, "utf8");
    const rolloutStat = await fs.stat(rolloutPath);
    await fs.writeFile(cursorsPath, `${JSON.stringify({
      version: 1,
      files: {
        [rolloutPath]: {
          inode: rolloutStat.ino,
          offset: baselineBytes,
          projectOffset: baselineBytes,
          projectFileContext: { absent: true, checkedAtMs: Date.now() },
          lastTotal: codexUsage(10),
        },
      },
      codexHashes: [`${sessionId}:${baselineTimestamp}`],
    })}\n`, "utf8");

    const diagnostics = {};
    await cmdSync(
      ["--auto", "--from-retry", "--source=codex"],
      { diagnostics, cursorStoreOptions: { forceV2: true } },
    );

    assert.equal(diagnostics.content_files_read, 1);
    assert.equal(diagnostics.hash_set_constructions, 0);
    assert.equal(diagnostics.hash_array_materializations, 0);
    assert.equal(diagnostics.codex_hash_count, 2);
    const rows = await readJsonlRows(queuePath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "codex");
    assert.equal(rows[0].total_tokens, 15);

    const store = await openCursorStore({ trackerDir, cursorsPath });
    await store.loadCodexFilesForPaths([rolloutPath]);
    assert.equal(store.cursors.files[rolloutPath].offset, (await fs.stat(rolloutPath)).size);
    assert.equal(store.codexEventStore.has(`${sessionId}:${baselineTimestamp}`), true);
    assert.equal(store.codexEventStore.has(`${sessionId}:${appendedTimestamp}`), true);

    const queueBeforeIdle = await fs.readFile(queuePath, "utf8");
    const idleDiagnostics = {};
    await cmdSync(
      ["--auto", "--from-retry", "--source=codex"],
      { diagnostics: idleDiagnostics },
    );
    assert.equal(await fs.readFile(queuePath, "utf8"), queueBeforeIdle);
    assert.equal(idleDiagnostics.content_files_read, 0);
    assert.equal(idleDiagnostics.hash_set_constructions, 0);
  });
});

test("v2 source-scoped no-op sync keeps the current generation unchanged", async () => {
  await withIsolatedCodexHome("tt-codex-v2-no-op-", async ({ codexHome, trackerDir }) => {
    const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const dayDir = path.join(codexHome, "sessions", "2030", "06", "02");
    const rolloutPath = path.join(
      dayDir,
      `rollout-2030-06-02T00-00-00-${sessionId}.jsonl`,
    );
    await fs.mkdir(dayDir, { recursive: true });
    await fs.writeFile(
      rolloutPath,
      `${JSON.stringify(codexTokenEvent("2030-06-02T00:30:00.000Z", 10))}\n`,
      "utf8",
    );

    const firstDiagnostics = {};
    await cmdSync(
      ["--auto", "--from-notify", "--source=codex"],
      { diagnostics: firstDiagnostics, cursorStoreOptions: { forceV2: true } },
    );
    assert.equal(firstDiagnostics.cursor_commits, 1);

    const manifestPath = path.join(trackerDir, STORE_DIRNAME, "manifest.json");
    const manifestBefore = await fs.readFile(manifestPath, "utf8");
    const coreBefore = await fs.readFile(firstDiagnostics.cursor_path, "utf8");

    const noOpDiagnostics = {};
    await cmdSync(
      ["--auto", "--from-notify", "--source=codex"],
      { diagnostics: noOpDiagnostics, cursorStoreOptions: { forceV2: true } },
    );

    assert.equal(noOpDiagnostics.cursor_commits, 0);
    assert.equal(noOpDiagnostics.cursor_bytes, 0);
    assert.equal(noOpDiagnostics.content_files_read, 0);
    assert.equal(await fs.readFile(manifestPath, "utf8"), manifestBefore);
    assert.equal(await fs.readFile(noOpDiagnostics.cursor_path, "utf8"), coreBefore);
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(trackerDir, STORE_DIRNAME, "deferred-codex-audit.json"),
          "utf8",
        ),
      ).syncsSinceFullScan,
      1,
    );

    await fs.appendFile(
      rolloutPath,
      `${JSON.stringify(codexTokenEvent("2030-06-02T00:35:00.000Z", 25))}\n`,
      "utf8",
    );
    const appendDiagnostics = {};
    await cmdSync(
      ["--auto", "--from-notify", "--source=codex"],
      { diagnostics: appendDiagnostics, cursorStoreOptions: { forceV2: true } },
    );
    assert.equal(appendDiagnostics.cursor_commits, 1);
    assert.notEqual(await fs.readFile(manifestPath, "utf8"), manifestBefore);
    await assert.rejects(
      fs.stat(path.join(trackerDir, STORE_DIRNAME, "deferred-codex-audit.json")),
      { code: "ENOENT" },
    );
  });
});

test("v2 source-scoped sync shards a custom CODEX_HOME outside the default path", async () => {
  await withIsolatedCodexHome("tt-codex-v2-custom-home-", async ({ home, trackerDir }) => {
    const customCodexHome = path.join(home, "custom-codex-data");
    process.env.CODEX_HOME = customCodexHome;
    const dayDir = path.join(customCodexHome, "sessions", "2030", "06", "02");
    const rolloutPath = path.join(
      dayDir,
      "rollout-2030-06-02T00-00-00-custom-home.jsonl",
    );
    const cursorsPath = path.join(trackerDir, "cursors.json");
    await fs.mkdir(dayDir, { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      rolloutPath,
      `${JSON.stringify(codexTokenEvent("2030-06-02T00:00:00.000Z", 10))}\n`,
      "utf8",
    );
    await fs.writeFile(
      cursorsPath,
      `${JSON.stringify({ version: 1, files: {}, codexHashes: [] })}\n`,
      "utf8",
    );

    await cmdSync(
      ["--auto", "--from-retry", "--source=codex"],
      { cursorStoreOptions: { forceV2: true } },
    );

    const summary = await readCursorStateSummary({ trackerDir, cursorsPath });
    assert.equal(summary.codexFileCount, 1);
    const store = await openCursorStore({
      trackerDir,
      cursorsPath,
      codexRoots: [customCodexHome],
    });
    assert.equal(store.cursors.files[rolloutPath], undefined);
    await store.loadCodexFilesForPaths([rolloutPath]);
    assert.ok(store.cursors.files[rolloutPath]);
  });
});

test("v2 source-scoped sync deduplicates an inode rewrite from its day event shard", async () => {
  await withIsolatedCodexHome("tt-codex-v2-rewrite-", async ({ codexHome, trackerDir }) => {
    const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const timestamp = "2030-06-02T01:00:00.000Z";
    const dayDir = path.join(codexHome, "sessions", "2030", "06", "02");
    const rolloutPath = path.join(
      dayDir,
      `rollout-2030-06-02T01-00-00-${sessionId}.jsonl`,
    );
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const queuePath = path.join(trackerDir, "queue.jsonl");
    const line = `${JSON.stringify(codexTokenEvent(timestamp, 20))}\n`;
    await fs.mkdir(dayDir, { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(rolloutPath, line, "utf8");
    await fs.writeFile(
      cursorsPath,
      `${JSON.stringify({ version: 1, files: {}, codexHashes: [] })}\n`,
      "utf8",
    );

    await cmdSync(
      ["--auto", "--from-retry", "--source=codex"],
      { cursorStoreOptions: { forceV2: true } },
    );
    const queueBeforeRewrite = await fs.readFile(queuePath, "utf8");
    const firstStat = await fs.stat(rolloutPath);
    const replacement = `${rolloutPath}.replacement`;
    await fs.writeFile(replacement, line, "utf8");
    await fs.rename(replacement, rolloutPath);
    const replacementStat = await fs.stat(rolloutPath);
    assert.notEqual(replacementStat.ino, firstStat.ino);

    const diagnostics = {};
    await cmdSync(
      ["--auto", "--from-retry", "--source=codex"],
      { diagnostics },
    );

    assert.equal(await fs.readFile(queuePath, "utf8"), queueBeforeRewrite);
    assert.equal(diagnostics.content_files_read, 1);
    assert.equal(diagnostics.hash_set_constructions, 0);
    assert.equal(diagnostics.hash_array_materializations, 0);
    assert.equal(diagnostics.codex_hash_count, 1);
    const summary = await readCursorStateSummary({ trackerDir, cursorsPath });
    assert.equal(summary.codexEventCount, 1);
    const store = await openCursorStore({ trackerDir, cursorsPath });
    await store.loadCodexFilesForPaths([rolloutPath]);
    assert.equal(store.cursors.files[rolloutPath].inode, replacementStat.ino);
  });
});

test("v2 sync restarts the full Codex parse after an event-shard fallback", async () => {
  await withIsolatedCodexHome("tt-codex-v2-event-fallback-", async ({ codexHome, trackerDir }) => {
    const appendSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
    const rewriteSessionId = "eeeeeeee-ffff-4000-8111-222222222222";
    const appendBaselineTimestamp = "2030-06-02T01:00:00.000Z";
    const appendTimestamp = "2030-06-02T01:05:00.000Z";
    const rewriteBaselineTimestamp = "2030-06-02T01:10:00.000Z";
    const rewriteTimestamp = "2030-06-02T01:15:00.000Z";
    const dayDir = path.join(codexHome, "sessions", "2030", "06", "02");
    const appendRolloutPath = path.join(
      dayDir,
      `rollout-2030-06-02T01-00-00-${appendSessionId}.jsonl`,
    );
    const rewriteRolloutPath = path.join(
      dayDir,
      `rollout-2030-06-02T01-10-00-${rewriteSessionId}.jsonl`,
    );
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const queuePath = path.join(trackerDir, "queue.jsonl");
    const appendBaselineLine = `${JSON.stringify(codexTokenEvent(appendBaselineTimestamp, 5))}\n`;
    const appendLine = `${JSON.stringify(codexTokenEvent(appendTimestamp, 15))}\n`;
    const rewriteBaselineLine = `${JSON.stringify(codexTokenEvent(rewriteBaselineTimestamp, 10))}\n`;
    const rewriteLine = `${JSON.stringify(codexTokenEvent(rewriteTimestamp, 20))}\n`;
    await fs.mkdir(dayDir, { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(appendRolloutPath, appendBaselineLine, "utf8");
    await fs.writeFile(rewriteRolloutPath, rewriteBaselineLine, "utf8");
    await fs.writeFile(
      cursorsPath,
      `${JSON.stringify({ version: 1, files: {}, codexHashes: [] })}\n`,
      "utf8",
    );

    await cmdSync(
      ["--auto", "--from-retry", "--source=codex"],
      { cursorStoreOptions: { forceV2: true } },
    );
    const baselineRows = await readJsonlRows(queuePath);
    assert.equal(baselineRows.length, 1);
    assert.equal(baselineRows[0].total_tokens, 15);

    const stableStore = await openCursorStore({ trackerDir, cursorsPath });
    await stableStore.materializeAllCodexState();
    const appendInode = stableStore.cursors.files[appendRolloutPath].inode;
    await stableStore.commit();

    const storeRoot = path.join(trackerDir, STORE_DIRNAME);
    const manifest = JSON.parse(
      await fs.readFile(path.join(storeRoot, "manifest.json"), "utf8"),
    );
    const generationDir = path.join(storeRoot, "generations", manifest.current);
    const metadata = JSON.parse(
      await fs.readFile(path.join(generationDir, "generation.json"), "utf8"),
    );
    const eventShardPath = path.join(
      generationDir,
      metadata.codexEvents["2030-06-02"].file,
    );
    await fs.appendFile(eventShardPath, "corrupt", "utf8");

    await fs.appendFile(appendRolloutPath, appendLine, "utf8");

    const rewriteStat = await fs.stat(rewriteRolloutPath);
    const replacement = `${rewriteRolloutPath}.replacement`;
    await fs.writeFile(replacement, `${rewriteBaselineLine}${rewriteLine}`, "utf8");
    await fs.rename(replacement, rewriteRolloutPath);
    assert.notEqual((await fs.stat(rewriteRolloutPath)).ino, rewriteStat.ino);

    await cmdSync(["--auto", "--from-retry", "--source=codex"]);

    const rows = await readJsonlRows(queuePath);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].source, "codex");
    assert.equal(rows[1].total_tokens, 35);

    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    await reopened.loadCodexFilesForPaths([appendRolloutPath, rewriteRolloutPath]);
    assert.equal(
      reopened.cursors.files[appendRolloutPath].offset,
      (await fs.stat(appendRolloutPath)).size,
    );
    assert.equal(reopened.cursors.files[appendRolloutPath].inode, appendInode);
    assert.equal(
      reopened.cursors.files[rewriteRolloutPath].offset,
      (await fs.stat(rewriteRolloutPath)).size,
    );
    assert.equal(
      reopened.codexEventStore.has(`${appendSessionId}:${appendBaselineTimestamp}`),
      true,
    );
    assert.equal(reopened.codexEventStore.has(`${appendSessionId}:${appendTimestamp}`), true);
    assert.equal(
      reopened.codexEventStore.has(`${rewriteSessionId}:${rewriteBaselineTimestamp}`),
      true,
    );
    assert.equal(reopened.codexEventStore.has(`${rewriteSessionId}:${rewriteTimestamp}`), true);

    const queueBeforeIdle = await fs.readFile(queuePath, "utf8");
    await cmdSync(["--auto", "--from-retry", "--source=codex"]);
    assert.equal(await fs.readFile(queuePath, "utf8"), queueBeforeIdle);
  });
});

test("v2 replays a sync after a failed manifest swap without inflating totals", async () => {
  await withIsolatedCodexHome("tt-codex-v2-replay-", async ({ codexHome, trackerDir }) => {
    const sessionId = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
    const timestamp = "2030-06-02T01:30:00.000Z";
    const dayDir = path.join(codexHome, "sessions", "2030", "06", "02");
    const rolloutPath = path.join(
      dayDir,
      `rollout-2030-06-02T01-30-00-${sessionId}.jsonl`,
    );
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const queuePath = path.join(trackerDir, "queue.jsonl");
    await fs.mkdir(dayDir, { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      rolloutPath,
      `${JSON.stringify(codexTokenEvent(timestamp, 20))}\n`,
      "utf8",
    );
    await fs.writeFile(
      cursorsPath,
      `${JSON.stringify({ version: 1, files: {}, codexHashes: [] })}\n`,
      "utf8",
    );

    await assert.rejects(
      cmdSync(
        ["--auto", "--from-retry", "--source=codex"],
        {
          cursorStoreOptions: {
            forceV2: true,
            failureInjector(stage) {
              if (stage === "beforeManifestSwap") throw new Error("simulated manifest failure");
            },
          },
        },
      ),
      /simulated manifest failure/,
    );
    assert.equal((await readJsonlRows(queuePath)).length, 1);
    const beforeReplay = await readCursorStateSummary({ trackerDir, cursorsPath });
    assert.equal(beforeReplay.codexEventCount, 0);

    await cmdSync(["--auto", "--from-retry", "--source=codex"]);

    const rows = await readJsonlRows(queuePath);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], rows[0]);
    const store = await openCursorStore({ trackerDir, cursorsPath });
    await store.materializeAllCodexState();
    assert.deepEqual(store.cursors.codexHashes, [`${sessionId}:${timestamp}`]);
    const total = Object.entries(store.cursors.hourly.buckets)
      .filter(([key]) => key.startsWith("codex|"))
      .reduce((sum, [, bucket]) => sum + Number(bucket.totals.total_tokens || 0), 0);
    assert.equal(total, 20);
  });
});

test("v2 cursor shards preserve legacy parser output and event hashes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-v2-equivalence-"));
  const RealDate = Date;
  const fixedNowMs = RealDate.parse("2030-06-02T12:34:56.789Z");
  global.Date = class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [fixedNowMs]));
    }

    static now() {
      return fixedNowMs;
    }
  };
  try {
    const sessionId = "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb";
    const rolloutPath = path.join(
      root,
      ".codex",
      "sessions",
      "2030",
      "06",
      "02",
      `rollout-2030-06-02T02-00-00-${sessionId}.jsonl`,
    );
    const events = [
      codexTokenEvent("2030-06-02T02:00:00.000Z", 10),
      codexTokenEvent("2030-06-02T02:05:00.000Z", 25),
    ];
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    await fs.writeFile(
      rolloutPath,
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );

    const legacyTrackerDir = path.join(root, "legacy");
    const v2TrackerDir = path.join(root, "v2");
    await fs.mkdir(legacyTrackerDir, { recursive: true });
    await fs.mkdir(v2TrackerDir, { recursive: true });
    for (const trackerDir of [legacyTrackerDir, v2TrackerDir]) {
      await fs.writeFile(
        path.join(trackerDir, "cursors.json"),
        `${JSON.stringify({ version: 1, files: {}, codexHashes: [] })}\n`,
        "utf8",
      );
    }

    const legacyStore = await openCursorStore({
      trackerDir: legacyTrackerDir,
      activationBytes: Number.MAX_SAFE_INTEGER,
    });
    const v2Store = await openCursorStore({ trackerDir: v2TrackerDir, forceV2: true });
    const parseInto = async (store, trackerDir) => {
      await parseRolloutIncremental({
        rolloutFiles: [{ path: rolloutPath, source: "codex" }],
        cursors: store.cursors,
        codexEventStore: store.codexEventStore,
        queuePath: path.join(trackerDir, "queue.jsonl"),
      });
      await store.commit();
    };
    await parseInto(legacyStore, legacyTrackerDir);
    await parseInto(v2Store, v2TrackerDir);

    assert.equal(
      await fs.readFile(path.join(v2TrackerDir, "queue.jsonl"), "utf8"),
      await fs.readFile(path.join(legacyTrackerDir, "queue.jsonl"), "utf8"),
    );
    const reopenedLegacy = await openCursorStore({
      trackerDir: legacyTrackerDir,
      activationBytes: Number.MAX_SAFE_INTEGER,
    });
    const reopenedV2 = await openCursorStore({ trackerDir: v2TrackerDir });
    await reopenedV2.materializeAllCodexState();
    assert.deepEqual(reopenedV2.cursors, reopenedLegacy.cursors);
  } finally {
    global.Date = RealDate;
    await fs.rm(root, { recursive: true, force: true });
  }
});
