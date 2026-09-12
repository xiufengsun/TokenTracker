const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  STORE_DIRNAME,
  opencodeFingerprintShardKey,
  opencodeMessageShardKey,
  openCursorStore,
  readCursorStateSummary,
} = require("../src/lib/cursor-store");
const { multiInstallParse } = require("../src/lib/multi-install-parser");
const { purgeProjectUsage } = require("../src/lib/project-usage-purge");

async function withCursorFixture(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-cursor-store-"));
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  const cursorsPath = path.join(trackerDir, "cursors.json");
  const codexDir = path.join(home, ".codex", "sessions");
  const configPath = path.join(home, "repo", ".git", "config");
  await fs.mkdir(trackerDir, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, "[remote \"origin\"]\n", "utf8");
  const configStat = await fs.stat(configPath);

  const day17Dir = path.join(codexDir, "2026", "07", "17");
  const day16Dir = path.join(codexDir, "2026", "07", "16");
  await fs.mkdir(day17Dir, { recursive: true });
  await fs.mkdir(day16Dir, { recursive: true });
  const day17File = path.join(
    day17Dir,
    "rollout-2026-07-17T00-00-00-11111111-1111-4111-8111-111111111111.jsonl",
  );
  const day16File = path.join(
    day16Dir,
    "rollout-2026-07-16T00-00-00-22222222-2222-4222-8222-222222222222.jsonl",
  );
  await fs.writeFile(day17File, "{}\n", "utf8");
  await fs.writeFile(day16File, "{}\n", "utf8");

  const context = {
    configPath,
    configMtimeMs: configStat.mtimeMs,
    configSize: configStat.size,
    configs: [{
      configPath,
      configMtimeMs: configStat.mtimeMs,
      configSize: configStat.size,
    }],
  };
  const cursorFor = (offset) => ({
    inode: 1,
    offset,
    projectOffset: offset,
    projectFileContext: context,
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  const day17Stat = await fs.stat(day17Dir);
  const day16Stat = await fs.stat(day16Dir);
  const statKey = (stat) => [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  const legacy = {
    version: 1,
    updatedAt: "2026-07-17T00:00:00.000Z",
    files: {
      [day17File]: cursorFor(10),
      [day16File]: cursorFor(20),
      [path.join(home, ".claude", "projects", "one.jsonl")]: {
        inode: 2,
        offset: 30,
      },
    },
    codexHashes: [
      "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:01.000Z",
      "22222222-2222-4222-8222-222222222222:2026-07-16T00:00:01.000Z",
    ],
    codexDayInventoryCache: {
      version: 1,
      days: {
        [day17Dir]: {
          statKey: statKey(day17Stat),
          files: [path.basename(day17File)],
        },
        [day16Dir]: {
          statKey: statKey(day16Stat),
          files: [path.basename(day16File)],
        },
      },
    },
    hourly: { buckets: {}, groupQueued: {} },
  };
  await fs.writeFile(cursorsPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  const originalLegacyRaw = await fs.readFile(cursorsPath, "utf8");

  try {
    await fn({
      home,
      trackerDir,
      cursorsPath,
      configPath,
      day17Dir,
      day16Dir,
      day17File,
      day16File,
      legacy,
      originalLegacyRaw,
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function readCurrentGeneration(trackerDir) {
  const storeRoot = path.join(trackerDir, STORE_DIRNAME);
  const manifest = JSON.parse(
    await fs.readFile(path.join(storeRoot, "manifest.json"), "utf8"),
  );
  return {
    manifest,
    ...(await readGenerationFixture(trackerDir, manifest.current)),
  };
}

async function readGenerationFixture(trackerDir, generationId) {
  const storeRoot = path.join(trackerDir, STORE_DIRNAME);
  const directory = path.join(storeRoot, "generations", generationId);
  const metadata = JSON.parse(
    await fs.readFile(path.join(directory, "generation.json"), "utf8"),
  );
  return { directory, metadata };
}

function corruptShardWithoutChangingLength(raw) {
  assert.ok(raw.length > 0);
  const first = raw[0] === "x" ? "y" : "x";
  const corrupted = `${first}${raw.slice(1)}`;
  assert.equal(Buffer.byteLength(corrupted), Buffer.byteLength(raw));
  return corrupted;
}

test("small cursor states keep the legacy single-file path", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath }) => {
    const store = await openCursorStore({
      trackerDir,
      cursorsPath,
      activationBytes: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(store.mode, "legacy");
    store.cursors.updatedAt = "2026-07-18T00:00:00.000Z";
    await store.commit();

    const persisted = JSON.parse(await fs.readFile(cursorsPath, "utf8"));
    assert.equal(persisted.updatedAt, "2026-07-18T00:00:00.000Z");
    assert.ok(Array.isArray(persisted.codexHashes));
  });
});

test("v2 migration rejects malformed legacy cursor state", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath }) => {
    const malformed = '{"version":1,"files":';
    await fs.writeFile(cursorsPath, malformed, "utf8");

    await assert.rejects(
      openCursorStore({ trackerDir, cursorsPath, forceV2: true }),
      (error) => error?.code === "TOKENTRACKER_CURSOR_STORE_CORRUPT",
    );
    assert.equal(await fs.readFile(cursorsPath, "utf8"), malformed);
    await assert.rejects(
      fs.access(path.join(trackerDir, STORE_DIRNAME, "manifest.json")),
      (error) => error?.code === "ENOENT",
    );
  });
});

test("explicit Codex roots shard custom CODEX_HOME session paths", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-custom-codex-root-"));
  try {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const codexRoot = path.join(home, "custom-codex-data");
    const rolloutPath = path.join(
      codexRoot,
      "sessions",
      "2026",
      "07",
      "17",
      "rollout-2026-07-17T00-00-00-custom.jsonl",
    );
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(rolloutPath, "{}\n", "utf8");
    await fs.writeFile(cursorsPath, `${JSON.stringify({
      version: 1,
      files: { [rolloutPath]: { inode: 1, offset: 3 } },
      codexHashes: [],
    })}\n`, "utf8");

    const store = await openCursorStore({
      trackerDir,
      cursorsPath,
      codexRoots: [codexRoot],
      forceV2: true,
    });
    assert.equal(store.cursors.files[rolloutPath], undefined);
    assert.equal(store.fileCount, 1);
    await store.loadCodexFilesForPaths([rolloutPath]);
    assert.equal(store.cursors.files[rolloutPath].offset, 3);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("v2 migration freezes legacy state and lazily loads Codex day shards", async () => {
  await withCursorFixture(async ({
    trackerDir,
    cursorsPath,
    day17File,
    day16File,
    originalLegacyRaw,
  }) => {
    const store = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    assert.equal(store.mode, "v2");
    assert.equal(store.cursors.files[day17File], undefined);
    assert.equal(store.cursors.files[day16File], undefined);
    assert.equal(Object.keys(store.cursors.files).length, 1);
    assert.equal(await fs.readFile(cursorsPath, "utf8"), originalLegacyRaw);

    await store.loadCodexFilesForPaths([day17File]);
    assert.equal(store.fileShardLoadCount, 1);
    assert.equal(store.cursors.files[day17File].offset, 10);
    assert.equal(store.cursors.files[day16File], undefined);
    assert.equal(
      store.codexEventStore.has(
        "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:01.000Z",
      ),
      true,
    );
    store.codexEventStore.add(
      "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:02.000Z",
    );
    store.cursors.files[day17File].offset = 11;
    store.cursors.updatedAt = "2026-07-18T00:00:00.000Z";
    await store.commit();

    assert.equal(await fs.readFile(cursorsPath, "utf8"), originalLegacyRaw);
    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    await reopened.loadCodexFilesForPaths([day17File]);
    assert.equal(reopened.cursors.files[day17File].offset, 11);
    assert.equal(
      reopened.codexEventStore.has(
        "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:02.000Z",
      ),
      true,
    );

    const summary = await readCursorStateSummary({ trackerDir, cursorsPath });
    assert.equal(summary.mode, "v2");
    assert.equal(summary.fileCount, 3);
    assert.equal(summary.codexFileCount, 2);
    assert.equal(summary.codexEventCount, 3);
  });
});

test("unchanged complete cold days skip without loading their cursor shard", async () => {
  await withCursorFixture(async ({
    trackerDir,
    cursorsPath,
    configPath,
    day16File,
  }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    assert.equal(
      await migrated.canSkipCodexDay({
        filePath: day16File,
        dayInventoryCache: migrated.cursors.codexDayInventoryCache,
      }),
      true,
    );
    assert.equal(migrated.fileShardLoadCount, 0);

    await fs.appendFile(configPath, "# changed\n", "utf8");
    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    assert.equal(
      await reopened.canSkipCodexDay({
        filePath: day16File,
        dayInventoryCache: reopened.cursors.codexDayInventoryCache,
      }),
      false,
    );
  });
});

test("a failed generation commit leaves the previous manifest authoritative", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File]);
    migrated.cursors.files[day17File].offset = 15;
    await migrated.commit();

    const failing = await openCursorStore({
      trackerDir,
      cursorsPath,
      failureInjector(stage) {
        if (stage === "beforeManifestSwap") throw new Error("simulated crash");
      },
    });
    await failing.loadCodexFilesForPaths([day17File]);
    failing.cursors.files[day17File].offset = 99;
    await assert.rejects(failing.commit(), /simulated crash/);

    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    await reopened.loadCodexFilesForPaths([day17File]);
    assert.equal(reopened.cursors.files[day17File].offset, 15);
  });
});

test("ordinary commits keep unchanged fallback shards physically independent", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File, day16File }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File]);
    migrated.cursors.files[day17File].offset = 44;
    await migrated.commit();

    const current = await readCurrentGeneration(trackerDir);
    const previous = await readGenerationFixture(trackerDir, current.manifest.previous);
    const shard = current.metadata.codexFiles["2026-07-16"];
    const shardPath = path.join(current.directory, shard.file);
    const raw = await fs.readFile(shardPath, "utf8");
    await fs.writeFile(shardPath, corruptShardWithoutChangingLength(raw), "utf8");

    for (const [shards, shardKey] of [
      ["codexFiles", "2026-07-16"],
      ["codexEvents", "2026-07-16"],
    ]) {
      const currentPath = path.join(current.directory, current.metadata[shards][shardKey].file);
      const previousPath = path.join(previous.directory, previous.metadata[shards][shardKey].file);
      assert.notEqual((await fs.stat(currentPath)).ino, (await fs.stat(previousPath)).ino);
    }

    const recovered = await openCursorStore({ trackerDir, cursorsPath });
    const result = await recovered.loadCodexFilesForPaths([day16File]);
    assert.equal(result.restarted, true);
    assert.equal(recovered.cursors.files[day16File].offset, 20);
  });
});

test("a downgraded legacy writer is detected and remigrated on upgrade", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File, legacy }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File]);
    migrated.cursors.files[day17File].offset = 11;
    await migrated.commit();

    const downgraded = structuredClone(legacy);
    downgraded.files[day17File].offset = 77;
    downgraded.codexHashes.push(
      "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:03.000Z",
    );
    await fs.writeFile(cursorsPath, `${JSON.stringify(downgraded, null, 2)}\n`, "utf8");

    const upgraded = await openCursorStore({ trackerDir, cursorsPath });
    await upgraded.loadCodexFilesForPaths([day17File]);
    assert.equal(upgraded.cursors.files[day17File].offset, 77);
    assert.equal(
      upgraded.codexEventStore.has(
        "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:03.000Z",
      ),
      true,
    );
  });
});

test("commit does not acknowledge a concurrent legacy write it did not migrate", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File, legacy }) => {
    const store = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    const downgraded = structuredClone(legacy);
    downgraded.files[day17File].offset = 77;
    downgraded.updatedAt = "2026-07-19T00:00:00.000Z";
    await fs.writeFile(cursorsPath, `${JSON.stringify(downgraded, null, 2)}\n`, "utf8");

    store.cursors.updatedAt = "2026-07-18T00:00:00.000Z";
    await store.commit();

    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    await reopened.loadCodexFilesForPaths([day17File]);
    assert.equal(reopened.cursors.updatedAt, "2026-07-19T00:00:00.000Z");
    assert.equal(reopened.cursors.files[day17File].offset, 77);
  });
});

test("a corrupt current generation falls back to the previous generation", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File]);
    migrated.cursors.files[day17File].offset = 44;
    await migrated.commit();

    const manifestPath = path.join(trackerDir, STORE_DIRNAME, "manifest.json");
    const current = await readCurrentGeneration(trackerDir);
    const corePath = path.join(current.directory, current.metadata.coreFile);
    await fs.writeFile(corePath, "{broken", "utf8");

    const recovered = await openCursorStore({ trackerDir, cursorsPath });
    await recovered.loadCodexFilesForPaths([day17File]);
    assert.equal(recovered.cursors.files[day17File].offset, 10);
  });
});

test("a current generation with a missing shard falls back to the previous generation", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File]);
    migrated.cursors.files[day17File].offset = 44;
    await migrated.commit();

    const current = await readCurrentGeneration(trackerDir);
    const shard = current.metadata.codexFiles["2026-07-17"];
    await fs.unlink(path.join(current.directory, shard.file));

    const recovered = await openCursorStore({ trackerDir, cursorsPath });
    await recovered.loadCodexFilesForPaths([day17File]);
    assert.equal(recovered.cursors.files[day17File].offset, 10);
  });
});

test("a current generation with a missing event shard falls back to the previous generation", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File }) => {
    const eventKey = "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:01.000Z";
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File]);
    migrated.cursors.files[day17File].offset = 44;
    await migrated.commit();

    const current = await readCurrentGeneration(trackerDir);
    const shard = current.metadata.codexEvents["2026-07-17"];
    await fs.unlink(path.join(current.directory, shard.file));

    const recovered = await openCursorStore({ trackerDir, cursorsPath });
    await recovered.loadCodexFilesForPaths([day17File]);
    assert.equal(recovered.cursors.files[day17File].offset, 10);
    assert.equal(recovered.codexEventStore.has(eventKey), true);
  });
});

test("a malformed current file shard lazily falls back to the previous generation", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File]);
    migrated.cursors.files[day17File].offset = 44;
    await migrated.commit();

    const current = await readCurrentGeneration(trackerDir);
    const shard = current.metadata.codexFiles["2026-07-17"];
    const shardPath = path.join(current.directory, shard.file);
    const raw = await fs.readFile(shardPath, "utf8");
    await fs.writeFile(shardPath, corruptShardWithoutChangingLength(raw), "utf8");

    const recovered = await openCursorStore({ trackerDir, cursorsPath });
    await recovered.loadCodexFilesForPaths([day17File]);
    assert.equal(recovered.cursors.files[day17File].offset, 10);
  });
});

test("a malformed current event shard lazily falls back to the previous generation", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File }) => {
    const baseEvent = "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:01.000Z";
    const addedEvent = "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:02.000Z";
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File]);
    assert.equal(migrated.codexEventStore.has(baseEvent), true);
    migrated.codexEventStore.add(addedEvent);
    migrated.cursors.files[day17File].offset = 44;
    await migrated.commit();

    const current = await readCurrentGeneration(trackerDir);
    const shard = current.metadata.codexEvents["2026-07-17"];
    const shardPath = path.join(current.directory, shard.file);
    const raw = await fs.readFile(shardPath, "utf8");
    await fs.writeFile(shardPath, corruptShardWithoutChangingLength(raw), "utf8");

    const recovered = await openCursorStore({ trackerDir, cursorsPath });
    assert.throws(
      () => recovered.codexEventStore.has(addedEvent),
      (error) => (
        error?.code === "TOKENTRACKER_CURSOR_STORE_RETRY" &&
        error?.cause?.code === "TOKENTRACKER_CURSOR_STORE_CORRUPT"
      ),
    );
    assert.equal(recovered.codexEventStore.has(addedEvent), false);
    assert.equal(recovered.codexEventStore.has(baseEvent), true);
    await recovered.loadCodexFilesForPaths([day17File]);
    assert.equal(recovered.cursors.files[day17File].offset, 10);
  });
});

test("materialization restarts every shard after a lazy generation fallback", async () => {
  await withCursorFixture(async ({
    trackerDir,
    cursorsPath,
    day17File,
    day16File,
  }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File, day16File]);
    migrated.cursors.files[day17File].offset = 44;
    migrated.cursors.files[day16File].offset = 55;
    await migrated.commit();

    const current = await readCurrentGeneration(trackerDir);
    const shard = current.metadata.codexFiles["2026-07-16"];
    const shardPath = path.join(current.directory, shard.file);
    const raw = await fs.readFile(shardPath, "utf8");
    await fs.writeFile(shardPath, corruptShardWithoutChangingLength(raw), "utf8");

    const recovered = await openCursorStore({ trackerDir, cursorsPath });
    const result = await recovered.materializeAllCodexState();
    assert.equal(result.restarted, true);
    assert.equal(recovered.cursors.files[day17File].offset, 10);
    assert.equal(recovered.cursors.files[day16File].offset, 20);
  });
});

test("commit rejects a corrupt required shard without publishing a mixed generation", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath }) => {
    const currentOnlyEvent = "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:01.500Z";
    const newEvent = "11111111-1111-4111-8111-111111111111:2026-07-17T00:00:02.000Z";
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    migrated.codexEventStore.add(currentOnlyEvent);
    await migrated.commit();

    const current = await readCurrentGeneration(trackerDir);
    const shard = current.metadata.codexEvents["2026-07-17"];
    const shardPath = path.join(current.directory, shard.file);
    const raw = await fs.readFile(shardPath, "utf8");
    await fs.writeFile(shardPath, corruptShardWithoutChangingLength(raw), "utf8");

    const storeRoot = path.join(trackerDir, STORE_DIRNAME);
    const manifestPath = path.join(storeRoot, "manifest.json");
    const generationsPath = path.join(storeRoot, "generations");
    const manifestBefore = await fs.readFile(manifestPath, "utf8");
    const generationsBefore = (await fs.readdir(generationsPath)).sort();

    const failing = await openCursorStore({ trackerDir, cursorsPath });
    failing.codexEventStore.add(newEvent);
    await assert.rejects(
      failing.commit(),
      (error) => error?.code === "TOKENTRACKER_CURSOR_STORE_CORRUPT",
    );

    assert.equal(await fs.readFile(manifestPath, "utf8"), manifestBefore);
    assert.deepEqual((await fs.readdir(generationsPath)).sort(), generationsBefore);

    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    assert.throws(
      () => reopened.codexEventStore.has(newEvent),
      (error) => error?.code === "TOKENTRACKER_CURSOR_STORE_RETRY",
    );
    assert.equal(reopened.codexEventStore.has(newEvent), false);
  });
});

test("state summaries prefer a later legacy write over stale v2 state", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, day17File, legacy }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.loadCodexFilesForPaths([day17File]);
    migrated.cursors.files[day17File].offset = 11;
    await migrated.commit();

    const downgraded = structuredClone(legacy);
    downgraded.files[day17File].offset = 77;
    downgraded.updatedAt = "2026-07-19T00:00:00.000Z";
    await fs.writeFile(cursorsPath, `${JSON.stringify(downgraded, null, 2)}\n`, "utf8");

    const summary = await readCursorStateSummary({ trackerDir, cursorsPath });
    assert.equal(summary.mode, "legacy");
    assert.equal(summary.legacyDrift, true);
    assert.equal(summary.cursors.files[day17File].offset, 77);
    assert.equal(summary.codexEventCount, legacy.codexHashes.length);
  });
});

test("OpenCode messages migrate out of core and load by message and fingerprint shard", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, legacy }) => {
    const prepared = structuredClone(legacy);
    const totals = (input) => ({
      input_tokens: input,
      output_tokens: 1,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: input + 1,
    });
    prepared.opencode = {
      messages: {
        "session-a|message-a": {
          lastTotals: totals(10),
          fingerprint: "fingerprint-a",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
        "session-a|message-b": {
          lastTotals: totals(20),
          fingerprint: "fingerprint-a",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
        "session-b|message-c": {
          lastTotals: totals(30),
          fingerprint: "fingerprint-c",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      },
      dbCursor: { version: 1 },
    };
    await fs.writeFile(cursorsPath, `${JSON.stringify(prepared)}\n`, "utf8");

    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    assert.equal(Object.keys(migrated.cursors.opencode.messages).length, 3);
    await migrated.commit();

    const current = await readCurrentGeneration(trackerDir);
    const core = JSON.parse(
      await fs.readFile(path.join(current.directory, current.metadata.coreFile), "utf8"),
    );
    assert.equal(current.metadata.coreFile, "core-v3.json");
    assert.equal(core.opencode.messages, undefined);
    assert.equal(current.metadata.counts.opencodeMessages, 3);
    assert.equal(current.metadata.counts.opencodeFingerprints, 2);

    const compatible = await readGenerationFixture(trackerDir, current.manifest.previous);
    assert.equal(compatible.metadata.coreFile, "core.json");
    const compatibleCore = JSON.parse(
      await fs.readFile(path.join(compatible.directory, compatible.metadata.coreFile), "utf8"),
    );
    assert.equal(Object.keys(compatibleCore.opencode.messages).length, 3);

    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    assert.equal(reopened.cursors.opencode.messages, undefined);
    const loaded = await reopened.loadOpencodeMessagesForBatch({
      messageKeys: ["session-a|message-a"],
      fingerprints: ["fingerprint-a"],
    });
    assert.equal(reopened.cursors.opencode.messages["session-a|message-a"].lastTotals.input_tokens, 10);
    assert.deepEqual(
      Array.from(loaded.fingerprintIndex.get("fingerprint-a")).sort(),
      ["session-a|message-a", "session-a|message-b"],
    );
    assert.equal(reopened.opencodeMessageShardLoadCount, 1);
    assert.equal(reopened.opencodeFingerprintShardLoadCount, 1);
    assert.ok(current.metadata.opencodeMessages[opencodeMessageShardKey("session-a|message-a")]);
    assert.ok(current.metadata.opencodeFingerprints[opencodeFingerprintShardKey("fingerprint-a")]);
  });
});

test("OpenCode shards stay isolated while multi-install parsing selects each namespace", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, legacy }) => {
    const entry = (input, fingerprint) => ({
      lastTotals: { input_tokens: input, total_tokens: input },
      fingerprint,
    });
    const prepared = structuredClone(legacy);
    prepared.opencode = {
      native: { messages: { "native-session|message": entry(10, "native-fingerprint") } },
      wsl: { messages: { "wsl-session|message": entry(20, "wsl-fingerprint") } },
    };
    await fs.writeFile(cursorsPath, `${JSON.stringify(prepared)}\n`, "utf8");
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.commit();

    const store = await openCursorStore({ trackerDir, cursorsPath });
    await multiInstallParse({
      paths: { native: "/native", wsl: "/wsl" },
      providerName: "opencode",
      cursors: store.cursors,
      getParams: (_path, namespace) => ({ namespace }),
      parserFn: async ({ namespace, cursors }) => {
        const messageKey = `${namespace}-session|message`;
        const loaded = await store.loadOpencodeMessagesForBatch({
          namespace,
          messageKeys: [messageKey],
          fingerprints: [`${namespace}-fingerprint`],
        });
        assert.equal(cursors.opencode.messages[messageKey].lastTotals.input_tokens, namespace === "native" ? 10 : 20);
        assert.deepEqual(Array.from(loaded.fingerprintIndex.get(`${namespace}-fingerprint`)), [messageKey]);
        return { recordsProcessed: 1 };
      },
    });
    assert.equal(store.cursors.opencode.native.messages["wsl-session|message"], undefined);
    assert.equal(store.cursors.opencode.wsl.messages["native-session|message"], undefined);
    await store.commit();
    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    await reopened.loadOpencodeMessagesForBatch({
      namespace: "wsl",
      messageKeys: ["wsl-session|message"],
      fingerprints: ["wsl-fingerprint"],
    });
    assert.equal(reopened.cursors.opencode.wsl.messages["wsl-session|message"].lastTotals.input_tokens, 20);
  });
});

test("invalid current and fallback generations fail closed instead of remigrating frozen legacy state", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, originalLegacyRaw }) => {
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.commit();
    const second = await openCursorStore({ trackerDir, cursorsPath });
    await second.commit();
    const current = await readCurrentGeneration(trackerDir);
    const rollback = await readGenerationFixture(trackerDir, current.manifest.rollback);
    const compatible = await readGenerationFixture(trackerDir, current.manifest.previous);
    assert.equal(compatible.metadata.coreFile, "core.json");
    await fs.writeFile(path.join(current.directory, current.metadata.coreFile), "{broken", "utf8");
    await fs.writeFile(path.join(rollback.directory, rollback.metadata.coreFile), "{broken", "utf8");

    await assert.rejects(
      openCursorStore({ trackerDir, cursorsPath }),
      (error) => error?.code === "TOKENTRACKER_CURSOR_STORE_CORRUPT",
    );
    assert.equal(await fs.readFile(cursorsPath, "utf8"), originalLegacyRaw);
  });
});

test("a corrupt OpenCode shard lazily falls back to the rollback generation", async () => {
  await withCursorFixture(async ({ trackerDir, cursorsPath, legacy }) => {
    const prepared = structuredClone(legacy);
    prepared.opencode = {
      messages: {
        "session-a|message-a": {
          lastTotals: { input_tokens: 10, total_tokens: 10 },
          fingerprint: "fingerprint-a",
        },
      },
    };
    await fs.writeFile(cursorsPath, `${JSON.stringify(prepared)}\n`, "utf8");
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.commit();

    const updating = await openCursorStore({ trackerDir, cursorsPath });
    await updating.loadOpencodeMessagesForBatch({
      messageKeys: ["session-a|message-a"],
      fingerprints: ["fingerprint-a"],
    });
    updating.cursors.opencode.messages["session-a|message-a"].lastTotals.input_tokens = 20;
    await updating.commit();

    const current = await readCurrentGeneration(trackerDir);
    const shard = current.metadata.opencodeMessages[
      opencodeMessageShardKey("session-a|message-a")
    ];
    const shardPath = path.join(current.directory, shard.file);
    const raw = await fs.readFile(shardPath, "utf8");
    await fs.writeFile(shardPath, corruptShardWithoutChangingLength(raw), "utf8");

    const recovered = await openCursorStore({ trackerDir, cursorsPath });
    const result = await recovered.loadOpencodeMessagesForBatch({
      messageKeys: ["session-a|message-a"],
      fingerprints: ["fingerprint-a"],
    });
    assert.equal(result.restarted, true);
    assert.equal(
      recovered.cursors.opencode.messages["session-a|message-a"].lastTotals.input_tokens,
      10,
    );
  });
});

test("materializing all Codex shards lets project purge clear frozen historical cursors", async () => {
  await withCursorFixture(async ({
    trackerDir,
    cursorsPath,
    day17File,
    day16File,
    legacy,
  }) => {
    const projectKey = "blocked-project";
    const prepared = structuredClone(legacy);
    prepared.files[day17File].project = { projectKey };
    prepared.files[day16File].project = { projectKey };
    prepared.projectHourly = {
      version: 2,
      buckets: {
        [`${projectKey}|codex|2026-07-17T00:00:00.000Z`]: {
          totals: { total_tokens: 30 },
        },
      },
      projects: {
        [projectKey]: { status: "blocked", purge_pending: true },
      },
    };
    await fs.writeFile(cursorsPath, `${JSON.stringify(prepared, null, 2)}\n`, "utf8");

    const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");
    const projectQueueStatePath = path.join(trackerDir, "project.queue.state.json");
    const queueRaw = `${JSON.stringify({ project_key: projectKey, total_tokens: 30 })}\n`;
    await fs.writeFile(projectQueuePath, queueRaw, "utf8");
    await fs.writeFile(
      projectQueueStatePath,
      JSON.stringify({ offset: Buffer.byteLength(queueRaw) }),
      "utf8",
    );

    const store = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await store.loadCodexFilesForPaths([day17File]);
    assert.equal(store.cursors.files[day16File], undefined);
    await store.materializeAllCodexState();
    assert.equal(store.fileShardLoadCount, 2);

    const result = await purgeProjectUsage({
      projectKey,
      projectQueuePath,
      projectQueueStatePath,
      projectState: store.cursors.projectHourly,
      cursors: store.cursors,
    });
    assert.equal(result.removedProjectCursors, 2);
    await store.commit();

    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    await reopened.materializeAllCodexState();
    assert.equal(reopened.cursors.files[day17File].project, undefined);
    assert.equal(reopened.cursors.files[day16File].project, undefined);
    assert.equal(await fs.readFile(projectQueuePath, "utf8"), "");
  });
});
