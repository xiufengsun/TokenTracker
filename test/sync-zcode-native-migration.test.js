const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  repairZcodeInclusiveTokenMigration,
  repairZcodeNativeUsageMigration,
} = require("../src/commands/sync");

function row(source, model, hour, total) {
  return JSON.stringify({
    hour_start: hour,
    source,
    model,
    input_tokens: total,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
    conversation_count: 1,
  });
}

test("native ZCode migration purges legacy rows once and preserves unrelated usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-native-repair-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const projectQueueStatePath = path.join(tmp, "project.queue.state.json");
    const hour = "2026-06-15T09:00:00Z";
    await fs.writeFile(queuePath, [row("zcode", "GLM-5.2", hour, 12), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(projectQueuePath, [row("zcode", "GLM-5.2", hour, 12), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 100 }));
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      zcode: { messages: { "legacy|row": { lastTotals: { total_tokens: 12 }, attribution: `${hour}\tGLM-5.2\t\t` } } },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${hour}`]: { totals: { total_tokens: 12 } },
          [`codex|gpt-5|${hour}`]: { totals: { total_tokens: 20 } },
        },
        groupQueued: { [`zcode|${hour}`]: "legacy", [`codex|${hour}`]: "keep" },
      },
      projectHourly: {
        buckets: {
          [`project|zcode|${hour}`]: { totals: { total_tokens: 12 } },
          [`project|codex|${hour}`]: { totals: { total_tokens: 20 } },
        },
      },
      migrations: {},
    };

    const changed = await repairZcodeNativeUsageMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
      rebuildFloorMs: 0,
    });
    assert.equal(changed, true);
    const mainRows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const zcodeRetractions = mainRows.filter((entry) => entry.source === "zcode");
    assert.equal(zcodeRetractions.length, 1, "cloud replay retains one zero for the removed key");
    assert.equal(zcodeRetractions[0].total_tokens, 0);
    assert.equal((await fs.readFile(projectQueuePath, "utf8")).includes('"source":"zcode"'), false);
    assert.ok(cursors.hourly.buckets[`codex|gpt-5|${hour}`]);
    assert.ok(!Object.keys(cursors.hourly.buckets).some((key) => key.startsWith("zcode|")));
    assert.ok(!Object.keys(cursors.projectHourly.buckets).some((key) => key.includes("|zcode|")));
    assert.equal(cursors.zcode, undefined);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
    assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 0);

    const changedAgain = await repairZcodeNativeUsageMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
    });
    assert.equal(changedAgain, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("inclusive-token ZCode migration retracts prior totals and resets replay once", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-inclusive-repair-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const projectQueueStatePath = path.join(tmp, "project.queue.state.json");
    const hour = "2026-08-31T09:00:00Z";
    await fs.writeFile(queuePath, [row("zcode", "GLM-5.2", hour, 100), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(projectQueuePath, [row("zcode", "GLM-5.2", hour, 100), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 100 }));
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      zcode: { messages: { "legacy|row": { lastTotals: { total_tokens: 100 }, attribution: `${hour}\tGLM-5.2\t\t` } } },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${hour}`]: { totals: { total_tokens: 100 } },
          [`codex|gpt-5|${hour}`]: { totals: { total_tokens: 20 } },
        },
        groupQueued: { [`zcode|${hour}`]: "inflated", [`codex|${hour}`]: "keep" },
      },
      projectHourly: {
        buckets: {
          [`project|zcode|${hour}`]: { totals: { total_tokens: 100 } },
          [`project|codex|${hour}`]: { totals: { total_tokens: 20 } },
        },
      },
      migrations: {},
    };

    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
      rebuildFloorMs: 0,
    }), true);
    const replayRows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(replayRows.filter((entry) => entry.source === "zcode").length, 1);
    assert.equal(replayRows.find((entry) => entry.source === "zcode").total_tokens, 0);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).note,
      "reset_after_zcode_inclusive_token_repair_2026_09");
    assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).note,
      "reset_after_zcode_inclusive_token_repair_2026_09");
    assert.equal(cursors.zcode, undefined);

    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
    }), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

const {
  repairZcodePruneWindowRestore,
  resolveZcodeRebuildFloorMs,
  ZCODE_PRUNE_WINDOW_RESTORE_KEY,
} = require("../src/commands/sync");

test("zcode wipe preserves pre-window queue rows and buckets (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-preserve-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const projectQueueStatePath = path.join(tmp, "project.queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    const liveHour = "2026-10-10T09:00:00.000Z";
    const floorMs = Date.parse("2026-09-17T00:00:00.000Z");
    await fs.writeFile(queuePath, [
      row("zcode", "GLM-5.2", oldHour, 5000),
      row("zcode", "GLM-5.2", liveHour, 100),
      row("codex", "gpt-5", liveHour, 20),
    ].join("\n") + "\n");
    await fs.writeFile(projectQueuePath, [
      row("zcode", "GLM-5.2", oldHour, 5000),
      row("zcode", "GLM-5.2", liveHour, 100),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 100 }));
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      zcode: { messages: { "x": { lastTotals: { total_tokens: 100 } } } },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 5000 } },
          [`zcode|GLM-5.2|${liveHour}`]: { totals: { total_tokens: 100 } },
          [`codex|gpt-5|${liveHour}`]: { totals: { total_tokens: 20 } },
        },
        groupQueued: {
          [`zcode|${oldHour}`]: "keep",
          [`zcode|${liveHour}`]: "wipe",
        },
      },
      projectHourly: {
        buckets: {
          [`proj|zcode|${oldHour}`]: { totals: { total_tokens: 5000 } },
          [`proj|zcode|${liveHour}`]: { totals: { total_tokens: 100 } },
        },
      },
      migrations: {},
    };

    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
      rebuildFloorMs: floorMs,
    }), true);

    const mainRows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const zcodeRows = mainRows.filter((entry) => entry.source === "zcode");
    assert.equal(zcodeRows.some((entry) => entry.hour_start === oldHour && entry.total_tokens === 5000), true);
    assert.equal(zcodeRows.some((entry) => entry.hour_start === liveHour && entry.total_tokens === 0), true);
    assert.ok(cursors.hourly.buckets[`zcode|GLM-5.2|${oldHour}`]);
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${liveHour}`], undefined);
    assert.ok(cursors.hourly.groupQueued[`zcode|${oldHour}`]);
    assert.equal(cursors.hourly.groupQueued[`zcode|${liveHour}`], undefined);
    assert.ok(cursors.projectHourly.buckets[`proj|zcode|${oldHour}`]);
    assert.equal(cursors.projectHourly.buckets[`proj|zcode|${liveHour}`], undefined);
    assert.equal(cursors.migrations.zcodeInclusiveTokenRepair_2026_09.preservedMain, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode wipe skips when rebuild floor is unavailable but history exists (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-skip-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const hour = "2026-09-01T09:00:00.000Z";
    await fs.writeFile(queuePath, row("zcode", "GLM-5.2", hour, 5000) + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 10 }));
    const cursors = {
      hourly: {
        buckets: { [`zcode|GLM-5.2|${hour}`]: { totals: { total_tokens: 5000 } } },
        groupQueued: {},
      },
      migrations: {},
    };
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: null,
    }), false);
    assert.equal(cursors.migrations.zcodeInclusiveTokenRepair_2026_09.skipped, true);
    assert.equal(JSON.parse((await fs.readFile(queuePath, "utf8")).trim()).total_tokens, 5000);
    assert.ok(cursors.hourly.buckets[`zcode|GLM-5.2|${hour}`]);

    // Retry succeeds once a floor is known.
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);
    assert.ok(cursors.migrations.zcodeInclusiveTokenRepair_2026_09.appliedAt);
    assert.ok(cursors.hourly.buckets[`zcode|GLM-5.2|${hour}`]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode prune-window restore lifts pre-window peaks from queue backups (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-restore-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    const liveHour = "2026-10-10T09:00:00.000Z";
    const backupPath = `${queuePath}.bak.2026-10-17T00-00-00-000Z`;
    await fs.writeFile(backupPath, [
      row("zcode", "GLM-5.2", oldHour, 9000),
      row("zcode", "GLM-5.2", liveHour, 50),
    ].join("\n") + "\n");
    await fs.writeFile(queuePath, [
      row("zcode", "GLM-5.2", oldHour, 0),
      row("zcode", "GLM-5.2", liveHour, 80),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 999 }));
    const cursors = {
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 0 } },
          [`zcode|GLM-5.2|${liveHour}`]: { totals: { total_tokens: 80 } },
        },
        groupQueued: {},
      },
      migrations: {},
    };

    assert.equal(await repairZcodePruneWindowRestore({
      cursors,
      queuePath,
      queueStatePath,
      dbPaths: [],
    }), false, "no floor and no db => skip");
    assert.equal(cursors.migrations[ZCODE_PRUNE_WINDOW_RESTORE_KEY].skipped, true);

    // {skipped:true} must retry once a floor is known (do not delete the key).
    assert.equal(await repairZcodePruneWindowRestore({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);

    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const restored = rows.filter((entry) => entry.source === "zcode" && entry.hour_start === oldHour);
    assert.ok(restored.some((entry) => entry.total_tokens === 9000));
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${oldHour}`].totals.total_tokens, 9000);
    // In-window backup peak must not clobber the live higher value.
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${liveHour}`].totals.total_tokens, 80);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
    assert.equal(cursors.migrations[ZCODE_PRUNE_WINDOW_RESTORE_KEY].restored, 1);

    assert.equal(await repairZcodePruneWindowRestore({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), false, "one-shot");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode restore re-appends when live queue retracted high→0 (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-high-zero-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    const backupPath = `${queuePath}.bak.2026-10-17T00-00-00-000Z`;
    await fs.writeFile(backupPath, row("zcode", "GLM-5.2", oldHour, 9000) + "\n");
    // Historical peak 9000 then repair retraction 0 — last-wins is 0.
    await fs.writeFile(queuePath, [
      row("zcode", "GLM-5.2", oldHour, 9000),
      row("zcode", "GLM-5.2", oldHour, 0),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      hourly: {
        buckets: { [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 9000 } } },
        groupQueued: {},
      },
      migrations: {},
    };
    assert.equal(await repairZcodePruneWindowRestore({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const zcode = rows.filter((entry) => entry.source === "zcode" && entry.hour_start === oldHour);
    assert.equal(zcode.at(-1).total_tokens, 9000);
    assert.equal(cursors.migrations[ZCODE_PRUNE_WINDOW_RESTORE_KEY].restored, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode wipe skips floorless repair when only queue history exists (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-queue-only-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const hour = "2026-09-01T09:00:00.000Z";
    await fs.writeFile(queuePath, row("zcode", "GLM-5.2", hour, 5000) + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 10 }));
    const cursors = { migrations: {} };
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: null,
    }), false);
    assert.equal(cursors.migrations.zcodeInclusiveTokenRepair_2026_09.skipped, true);
    assert.equal(JSON.parse((await fs.readFile(queuePath, "utf8")).trim()).total_tokens, 5000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode wipe keeps pre-window message cursor to avoid double-count (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-cursor-keep-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    const liveHour = "2026-10-10T09:00:00.000Z";
    await fs.writeFile(queuePath, [
      row("zcode", "GLM-5.2", oldHour, 5000),
      row("zcode", "GLM-5.2", liveHour, 100),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 1 }));
    const cursors = {
      zcode: {
        messages: {
          "old-session|msg-1": {
            lastTotals: { total_tokens: 5000 },
            attribution: `${oldHour}\tGLM-5.2\t\t`,
          },
          "live-session|msg-2": {
            lastTotals: { total_tokens: 100 },
            attribution: `${liveHour}\tGLM-5.2\t\t`,
          },
        },
      },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 5000 } },
          [`zcode|GLM-5.2|${liveHour}`]: { totals: { total_tokens: 100 } },
        },
        groupQueued: {},
      },
      migrations: {},
    };
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);
    assert.ok(cursors.zcode?.messages?.["old-session|msg-1"], "pre-window dedup kept");
    assert.equal(cursors.zcode.messages["live-session|msg-2"], undefined, "in-window cursor cleared");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${oldHour}`].totals.total_tokens, 5000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode wipe keeps unattributed pre-window cursor to avoid double-count (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-unattr-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    await fs.writeFile(queuePath, row("zcode", "GLM-5.2", oldHour, 5000) + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 1 }));
    const cursors = {
      zcode: {
        messages: {
          "old-session|msg-1": { lastTotals: { total_tokens: 5000 } },
        },
      },
      hourly: {
        buckets: { [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 5000 } } },
        groupQueued: {},
      },
      migrations: {},
    };
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);
    assert.ok(cursors.zcode?.messages?.["old-session|msg-1"], "unattributed pre-window kept");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${oldHour}`].totals.total_tokens, 5000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveZcodeRebuildFloorMs returns null without readable DBs", () => {
  assert.equal(resolveZcodeRebuildFloorMs([]), null);
  assert.equal(resolveZcodeRebuildFloorMs([path.join(os.tmpdir(), "missing-zcode.sqlite")]), null);
});
