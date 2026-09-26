const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  cmdSync,
  repairCodexRescanInflation,
  CODEX_RESCAN_DEDUP_REPAIR_KEY,
} = require("../src/commands/sync");

async function makeTempHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-codexrepair-"));
}

function tokenCountLine({ ts, last, total, annotation }) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: { last_token_usage: last, total_token_usage: total },
      ...(annotation == null ? {} : { annotation }),
    },
  });
}

function turnContextLine({ cwd, model = "gpt-4" }) {
  return JSON.stringify({
    type: "turn_context",
    payload: { cwd, model },
  });
}

// Two cumulative events in one half-hour: deltas 100 + 150 → true codex total 250.
const U1 = { input_tokens: 60, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0, total_tokens: 100 };
const T2 = { input_tokens: 150, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 250 };
const U2 = { input_tokens: 90, cached_input_tokens: 0, output_tokens: 60, reasoning_output_tokens: 0, total_tokens: 150 };
const TRUE_CODEX_TOTAL = 250;

async function writeCodexFile(
  home,
  uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  opts = {},
) {
  const dir = path.join(home, ".codex", "sessions", "2025", "12", "17");
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, `rollout-2025-12-17T00-00-00-${uuid}.jsonl`);
  const lines = [
    tokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: U1, total: U1 }),
    tokenCountLine({ ts: "2025-12-17T00:00:01.000Z", last: U2, total: T2 }),
  ];
  if (opts.cwd) lines.unshift(turnContextLine({ cwd: opts.cwd, model: opts.model }));
  await fs.writeFile(
    fp,
    lines.join("\n") + "\n",
    "utf8",
  );
  return fp;
}

const codexBucketTotal = (cursors) =>
  Object.entries(cursors.hourly?.buckets || {})
    .filter(([k]) => k.startsWith("codex|"))
    .reduce((s, [, v]) => s + Number(v.totals?.total_tokens || 0), 0);

const queueRowsBySource = async (queuePath) => {
  const raw = await fs.readFile(queuePath, "utf8");
  const m = {};
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    m[r.source] = m[r.source] || { rows: 0, total: 0 };
    m[r.source].rows += 1;
    m[r.source].total += Number(r.total_tokens || 0);
  }
  return m;
};

const projectBucketTotal = (cursors, source = "codex") =>
  Object.entries(cursors.projectHourly?.buckets || {})
    .filter(([, v]) => v?.source === source)
    .reduce((s, [, v]) => s + Number(v.totals?.total_tokens || 0), 0);

async function withTempSyncEnv(fn) {
  const home = await makeTempHome();
  const saved = {
    HOME: process.env.HOME,
    // os.homedir() reads USERPROFILE on Windows, so isolate it too or the test
    // writes into the developer's real ~/.tokentracker.
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    OPENCODE_HOME: process.env.OPENCODE_HOME,
    DSH_HOME: process.env.DSH_HOME,
    TOKENTRACKER_DSH_HOME: process.env.TOKENTRACKER_DSH_HOME,
    TOKENTRACKER_TRAE_HOME: process.env.TOKENTRACKER_TRAE_HOME,
    TOKENTRACKER_TRAE_DB: process.env.TOKENTRACKER_TRAE_DB,
    TOKENTRACKER_DEVICE_TOKEN: process.env.TOKENTRACKER_DEVICE_TOKEN,
    TOKENTRACKER_AUTO_RETRY_NO_SPAWN: process.env.TOKENTRACKER_AUTO_RETRY_NO_SPAWN,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.GEMINI_HOME = path.join(home, ".gemini");
    process.env.OPENCODE_HOME = path.join(home, ".opencode");
    process.env.TOKENTRACKER_TRAE_HOME = path.join(home, ".trae");
    delete process.env.TOKENTRACKER_TRAE_DB;
    process.env.TOKENTRACKER_DEVICE_TOKEN = "test-device-token";
    process.env.TOKENTRACKER_AUTO_RETRY_NO_SPAWN = "1";
    delete process.env.DSH_HOME;
    delete process.env.TOKENTRACKER_DSH_HOME;
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe("repairCodexRescanInflation (#187) — atomic guarded rebuild", () => {
  it("keeps per-model queue totals stable across three consecutive full-source syncs", async () => {
    await withTempSyncEnv(async (home) => {
      const sessionsDir = path.join(home, ".codex", "sessions", "2026", "09", "05");
      await fs.mkdir(sessionsDir, { recursive: true });
      const count = 100;
      for (let index = 0; index < count; index += 1) {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        const filePath = path.join(sessionsDir, `rollout-2026-09-05T00-00-00-${id}.jsonl`);
        const lines = [
          JSON.stringify({ type: "session_meta", timestamp: "2026-09-05T00:00:00Z", payload: { id } }),
          turnContextLine({ model: "gpt-5.6-sol" }),
          tokenCountLine({ ts: "2026-09-05T00:01:00Z", last: U1, total: U1 }),
          turnContextLine({ model: "gpt-5.6-terra" }),
          tokenCountLine({ ts: "2026-09-05T00:02:00Z", last: U2, total: T2 }),
        ];
        await fs.writeFile(filePath, `${lines.join("\n")}\n`);
      }
      const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
      await cmdSync(["--auto", "--background", "--all-local-sources"]);
      const first = await fs.readFile(queuePath, "utf8");
      const latest = new Map(first.trim().split("\n").map((line) => {
        const row = JSON.parse(line);
        return [`${row.source}|${row.model}|${row.hour_start}`, row];
      }));
      const modelTotals = {};
      for (const row of latest.values()) {
        if (row.source !== "codex") continue;
        modelTotals[row.model] = (modelTotals[row.model] || 0) + row.total_tokens;
      }
      assert.deepEqual(modelTotals, { "gpt-5.6-sol": count * 100, "gpt-5.6-terra": count * 150 });
      for (let pass = 0; pass < 2; pass += 1) {
        await cmdSync(["--auto", "--background", "--all-local-sources"]);
        assert.equal(await fs.readFile(queuePath, "utf8"), first, "unchanged sync must not append or reattribute usage");
      }
    });
  });

  it("does not treat project.queue.jsonl as cloud upload backlog", async () => {
    await withTempSyncEnv(async (home) => {
      const trackerDir = path.join(home, ".tokentracker", "tracker");
      await fs.mkdir(trackerDir, { recursive: true });
      await fs.writeFile(path.join(trackerDir, "queue.jsonl"), "", "utf8");
      await fs.writeFile(path.join(trackerDir, "queue.state.json"), JSON.stringify({ offset: 0 }), "utf8");
      await fs.writeFile(
        path.join(trackerDir, "cursors.json"),
        JSON.stringify({
          version: 1,
          files: {},
          migrations: {
            cloudConversationsBackfill_2026_06: { appliedAt: "2026-01-01T00:00:00.000Z" },
            claudeGroundTruthRepair_2026_05_v4: { appliedAt: "2026-01-01T00:00:00.000Z" },
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(trackerDir, "project.queue.jsonl"),
        JSON.stringify({
          project_ref: "https://github.com/acme/alpha",
          project_key: "acme/alpha",
          source: "codex",
          hour_start: "2025-12-17T00:00:00.000Z",
          total_tokens: 250,
        }) + "\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(trackerDir, "project.queue.state.json"),
        JSON.stringify({ offset: 0 }),
        "utf8",
      );

      let stdout = "";
      const write = process.stdout.write;
      process.stdout.write = function capture(chunk, ...args) {
        stdout += String(chunk);
        return true;
      };
      try {
        await cmdSync([]);
      } finally {
        process.stdout.write = write;
      }

      assert.match(stdout, /Sync finished:/);
      assert.doesNotMatch(stdout, /Remaining:/);
      const retryPath = path.join(trackerDir, "auto.retry.json");
      await assert.rejects(fs.stat(retryPath), { code: "ENOENT" });

      await fs.writeFile(
        path.join(trackerDir, "upload.throttle.json"),
        JSON.stringify({ nextAllowedAtMs: Date.now() + 60_000 }),
        "utf8",
      );
      await cmdSync(["--auto"]);
      await assert.rejects(fs.stat(retryPath), { code: "ENOENT" });
    });
  });

  it("rebuilds inflated codex to the true value, preserves other sources, strips+rebuilds the queue, resets the offset", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");

      // INFLATED state (as if inode re-scans tripled codex): bucket 750, queue carries old-high codex rows.
      await fs.writeFile(
        queuePath,
        [
          JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 250 }),
          JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }),
          JSON.stringify({ source: "claude", model: "opus", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 5000 }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 99999 }), "utf8");

      const cursors = {
        hourly: {
          buckets: {
            "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } }, // 3x inflated
            "claude|opus|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 5000 } },
          },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5, lastTotal: { total_tokens: 750 } } },
        codexHashes: ["stale:key"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, true);

      // codex rebuilt to TRUE value (not the 750 inflation, not 0)
      assert.equal(codexBucketTotal(cursors), TRUE_CODEX_TOTAL);

      // other sources untouched
      assert.equal(cursors.hourly.buckets["claude|opus|2025-12-17T00:00:00.000Z"].totals.total_tokens, 5000);

      // queue: codex rows replaced with clean total, claude row preserved
      const q = await queueRowsBySource(queuePath);
      assert.equal(q.codex.total, TRUE_CODEX_TOTAL, "queue codex rebuilt to true total");
      assert.equal(q.claude.rows, 1);
      assert.equal(q.claude.total, 5000);

      // offset reset, codexHashes rebuilt (2 events), file cursor reinstalled at EOF, key set
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
      assert.equal(cursors.codexHashes.length, 2);
      assert.ok(cursors.files[codexFile] && cursors.files[codexFile].offset > 5);
      assert.ok(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY]);

      // idempotent: second call is a no-op
      assert.equal(
        await repairCodexRescanInflation({ cursors, queuePath, queueStatePath, rolloutFiles: [{ path: codexFile, source: "codex" }] }),
        false,
      );
      assert.equal(codexBucketTotal(cursors), TRUE_CODEX_TOTAL);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("fails closed without mutation when historical rebuild input contains invalid UTF-8", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const raw = await fs.readFile(codexFile);
      const firstNewline = raw.indexOf(0x0a);
      const secondLine = Buffer.from(raw.subarray(firstNewline + 1, raw.length - 1));
      const marker = secondLine.indexOf(Buffer.from('"event_msg"'));
      assert.ok(marker >= 0);
      secondLine[marker + 1] = 0xff;
      await fs.writeFile(
        codexFile,
        Buffer.concat([raw.subarray(0, firstNewline + 1), secondLine, Buffer.from("\n")]),
      );

      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const originalQueue = [
        JSON.stringify({
          source: "codex",
          model: "unknown",
          hour_start: "2025-12-17T00:00:00.000Z",
          total_tokens: TRUE_CODEX_TOTAL,
        }),
        JSON.stringify({
          source: "claude",
          model: "opus",
          hour_start: "2025-12-17T00:00:00.000Z",
          total_tokens: 5000,
        }),
      ].join("\n") + "\n";
      await fs.writeFile(queuePath, originalQueue, "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");
      const cursors = {
        hourly: {
          buckets: {
            "codex|unknown|2025-12-17T00:00:00.000Z": {
              totals: { total_tokens: TRUE_CODEX_TOTAL },
            },
            "claude|opus|2025-12-17T00:00:00.000Z": {
              totals: { total_tokens: 5000 },
            },
          },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5, lastTotal: T2 } },
        codexHashes: ["existing:key"],
        migrations: {},
      };
      const originalCursors = structuredClone(cursors);

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });

      assert.equal(ran, false);
      assert.deepEqual(cursors, originalCursors);
      assert.equal(await fs.readFile(queuePath, "utf8"), originalQueue);
      assert.deepEqual(JSON.parse(await fs.readFile(queueStatePath, "utf8")), { offset: 123 });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rebuilds Codex project usage during rescan repair", async () => {
    const home = await makeTempHome();
    try {
      const repoRoot = path.join(home, "work", "alpha");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
        "utf8",
      );
      const codexFile = await writeCodexFile(home, undefined, { cwd: repoRoot, model: "gpt-4" });
      const hour = "2025-12-17T00:00:00.000Z";
      const projectRef = "https://github.com/acme/alpha";
      const projectKey = "acme/alpha";
      const projectBucketKey = `${projectKey}|codex|${hour}`;
      const claudeProjectBucketKey = `${projectKey}|claude|${hour}`;
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");

      await fs.writeFile(
        queuePath,
        [
          JSON.stringify({ source: "codex", model: "gpt-4", hour_start: hour, total_tokens: 750 }),
          JSON.stringify({ source: "claude", model: "opus", hour_start: hour, total_tokens: 5000 }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(
        projectQueuePath,
        [
          JSON.stringify({
            project_ref: projectRef,
            project_key: projectKey,
            source: "codex",
            hour_start: hour,
            total_tokens: 750,
          }),
          JSON.stringify({
            project_ref: projectRef,
            project_key: projectKey,
            source: "claude",
            hour_start: hour,
            total_tokens: 5000,
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 99999 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 88888 }), "utf8");

      const cursors = {
        hourly: {
          buckets: {
            "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } },
            "claude|opus|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 5000 } },
          },
          groupQueued: {},
        },
        projectHourly: {
          version: 2,
          buckets: {
            [projectBucketKey]: {
              project_ref: projectRef,
              project_key: projectKey,
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 750 },
            },
            [claudeProjectBucketKey]: {
              project_ref: projectRef,
              project_key: projectKey,
              source: "claude",
              hour_start: hour,
              totals: { total_tokens: 5000 },
            },
          },
          projects: {
            [projectKey]: { projectRef, projectKey, status: "public_verified" },
          },
        },
        files: { [codexFile]: { inode: 1, offset: 5, lastTotal: { total_tokens: 750 } } },
        codexHashes: ["stale:key"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, true);

      assert.equal(codexBucketTotal(cursors), TRUE_CODEX_TOTAL);
      assert.equal(projectBucketTotal(cursors, "codex"), TRUE_CODEX_TOTAL);
      assert.equal(projectBucketTotal(cursors, "claude"), 5000);

      const q = await queueRowsBySource(queuePath);
      const pq = await queueRowsBySource(projectQueuePath);
      assert.equal(q.codex.total, TRUE_CODEX_TOTAL);
      assert.equal(q.claude.total, 5000);
      assert.equal(pq.codex.total, TRUE_CODEX_TOTAL);
      assert.equal(pq.claude.total, 5000);

      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 0);
      assert.equal(cursors.files[codexFile].projectOffset, cursors.files[codexFile].offset);
      assert.equal(
        cursors.files[codexFile].projectFileContext.configPath.endsWith(path.join(".git", "config")),
        true,
      );
      assert.equal(cursors.projectHourly.projects[projectKey].status, "public_verified");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips without mutation when existing Codex project usage cannot be rebuilt", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const hour = "2025-12-17T00:00:00.000Z";
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "unknown", hour_start: hour, total_tokens: 750 }) +
          "\n",
        "utf8",
      );
      await fs.writeFile(
        projectQueuePath,
        JSON.stringify({
          project_ref: "https://github.com/acme/alpha",
          project_key: "acme/alpha",
          source: "codex",
          hour_start: hour,
          total_tokens: 750,
        }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 456 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } },
          groupQueued: {},
        },
        projectHourly: {
          version: 2,
          buckets: {
            "acme/alpha|codex|2025-12-17T00:00:00.000Z": {
              project_ref: "https://github.com/acme/alpha",
              project_key: "acme/alpha",
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 750 },
            },
          },
          projects: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal(projectBucketTotal(cursors, "codex"), 750);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, 750);
      assert.equal((await queueRowsBySource(projectQueuePath)).codex.total, 750);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 123);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 456);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips without mutation when Codex project queue rows are malformed", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const hour = "2025-12-17T00:00:00.000Z";
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");
      const malformedProjectRow =
        JSON.stringify({
          project_ref: "https://github.com/acme/alpha",
          source: "codex",
          hour_start: hour,
          total_tokens: 750,
        }) + "\n";

      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "unknown", hour_start: hour, total_tokens: 750 }) +
          "\n",
        "utf8",
      );
      await fs.writeFile(projectQueuePath, malformedProjectRow, "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 456 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal(await fs.readFile(projectQueuePath, "utf8"), malformedProjectRow);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 123);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 456);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips without mutation when Codex project rebuild is partial", async () => {
    const home = await makeTempHome();
    try {
      const repoRoot = path.join(home, "work", "alpha");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
        "utf8",
      );
      const alphaFile = await writeCodexFile(
        home,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        { cwd: repoRoot, model: "gpt-4" },
      );
      const betaFile = await writeCodexFile(home, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee");
      const hour = "2025-12-17T00:00:00.000Z";
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "gpt-4", hour_start: hour, total_tokens: 1500 }) +
          "\n",
        "utf8",
      );
      await fs.writeFile(
        projectQueuePath,
        [
          JSON.stringify({
            project_ref: "https://github.com/acme/alpha",
            project_key: "acme/alpha",
            source: "codex",
            hour_start: hour,
            total_tokens: 750,
          }),
          JSON.stringify({
            project_ref: "https://github.com/acme/beta",
            project_key: "acme/beta",
            source: "codex",
            hour_start: hour,
            total_tokens: 750,
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 456 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 1500 } } },
          groupQueued: {},
        },
        projectHourly: {
          version: 2,
          buckets: {
            "acme/alpha|codex|2025-12-17T00:00:00.000Z": {
              project_ref: "https://github.com/acme/alpha",
              project_key: "acme/alpha",
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 750 },
            },
            "acme/beta|codex|2025-12-17T00:00:00.000Z": {
              project_ref: "https://github.com/acme/beta",
              project_key: "acme/beta",
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 750 },
            },
          },
          projects: {},
        },
        files: {
          [alphaFile]: { inode: 1, offset: 5 },
          [betaFile]: { inode: 2, offset: 5 },
        },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [
          { path: alphaFile, source: "codex" },
          { path: betaFile, source: "codex" },
        ],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 1500);
      assert.equal(projectBucketTotal(cursors, "codex"), 1500);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, 1500);
      assert.equal((await queueRowsBySource(projectQueuePath)).codex.total, 1500);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 123);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 456);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips without mutation when Codex project rebuild lowers an existing key without main repair", async () => {
    const home = await makeTempHome();
    try {
      const repoRoot = path.join(home, "work", "alpha");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n`,
        "utf8",
      );
      const alphaFile = await writeCodexFile(
        home,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        { cwd: repoRoot, model: "gpt-4" },
      );
      const betaFile = await writeCodexFile(
        home,
        "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
        { model: "gpt-4" },
      );
      const hour = "2025-12-17T00:00:00.000Z";
      const projectRef = "https://github.com/acme/alpha";
      const projectKey = "acme/alpha";
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");

      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "gpt-4", hour_start: hour, total_tokens: 500 }) +
          "\n",
        "utf8",
      );
      await fs.writeFile(
        projectQueuePath,
        JSON.stringify({
          project_ref: projectRef,
          project_key: projectKey,
          source: "codex",
          hour_start: hour,
          total_tokens: 500,
        }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 456 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 500 } } },
          groupQueued: {},
        },
        projectHourly: {
          version: 2,
          buckets: {
            "acme/alpha|codex|2025-12-17T00:00:00.000Z": {
              project_ref: projectRef,
              project_key: projectKey,
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: 500 },
            },
          },
          projects: {},
        },
        files: {
          [alphaFile]: { inode: 1, offset: 5 },
          [betaFile]: { inode: 2, offset: 5 },
        },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [
          { path: alphaFile, source: "codex" },
          { path: betaFile, source: "codex" },
        ],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 500);
      assert.equal(projectBucketTotal(cursors, "codex"), 500);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, 500);
      assert.equal((await queueRowsBySource(projectQueuePath)).codex.total, 500);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 123);
      assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 456);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD: skips with zero mutation when a contributing codex file is missing from disk", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }) + "\n", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 42 }), "utf8");

      const goneFile = path.join(home, ".codex", "sessions", "2025", "12", "16", "rollout-GONE-uuid.jsonl");
      const cursors = {
        hourly: { buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } }, groupQueued: {} },
        files: { [codexFile]: { inode: 1, offset: 5 }, [goneFile]: { inode: 2, offset: 5 } }, // goneFile not on disk
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }], // goneFile also absent from scan
      });
      assert.equal(ran, false);

      // nothing destroyed
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, 750);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 42);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY].skipped, true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("SANITY: skips without setting the key (no clear) when files exist but rebuild yields 0 codex buckets", async () => {
    const home = await makeTempHome();
    try {
      // A codex file with NO token_count events → rebuild produces 0 codex buckets.
      const dir = path.join(home, ".codex", "sessions", "2025", "12", "17");
      await fs.mkdir(dir, { recursive: true });
      const emptyFile = path.join(dir, "rollout-2025-12-17T00-00-00-ffffffff-0000-0000-0000-000000000000.jsonl");
      await fs.writeFile(emptyFile, JSON.stringify({ type: "session_meta", payload: { id: "x" } }) + "\n", "utf8");

      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }) + "\n", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 7 }), "utf8");

      const cursors = {
        hourly: { buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } }, groupQueued: {} },
        files: { [emptyFile]: { inode: 1, offset: 5 } },
        codexHashes: [],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: emptyFile, source: "codex" }],
      });
      assert.equal(ran, false);

      // live data untouched, key NOT set (so it retries once the file has real data)
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 7);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("RETRIES after a prior SKIP: a session moved sessions/ -> archived_sessions/ is reproducible by UUID (#187, easonlee05)", async () => {
    const home = await makeTempHome();
    try {
      const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      // The session now lives FLAT in archived_sessions/ (Codex-Manager moved it).
      const archDir = path.join(home, ".codex", "archived_sessions");
      await fs.mkdir(archDir, { recursive: true });
      const archivedFile = path.join(archDir, `rollout-2025-12-17T00-00-00-${uuid}.jsonl`);
      await fs.writeFile(
        archivedFile,
        [
          tokenCountLine({ ts: "2025-12-17T00:00:00.000Z", last: U1, total: U1 }),
          tokenCountLine({ ts: "2025-12-17T00:00:01.000Z", last: U2, total: T2 }),
        ].join("\n") + "\n",
        "utf8",
      );
      // The OLD sessions/ path the cursor still points at no longer exists.
      const staleSessionsPath = path.join(
        home, ".codex", "sessions", "2025", "12", "17",
        `rollout-2025-12-17T00-00-00-${uuid}.jsonl`,
      );

      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 1234 }), "utf8");

      const cursors = {
        hourly: { buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } }, groupQueued: {} },
        files: { [staleSessionsPath]: { inode: 1, offset: 5, lastTotal: { total_tokens: 750 } } },
        codexHashes: [],
        // Prior run SKIPPED (v0.53.3 didn't scan archived) — must NOT block retry.
        migrations: {
          [CODEX_RESCAN_DEDUP_REPAIR_KEY]: { skipped: true, reason: "codex_session_file_missing_or_unscanned", at: "2026-06-17T00:00:00.000Z" },
        },
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: archivedFile, source: "codex" }],
      });

      assert.equal(ran, true, "prior skip must not block the retry");
      assert.equal(codexBucketTotal(cursors), TRUE_CODEX_TOTAL, "de-inflated to true value");
      assert.equal((await queueRowsBySource(queuePath)).codex.total, TRUE_CODEX_TOTAL);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
      // Success now records a string timestamp (final), replacing the skip object.
      assert.equal(typeof cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], "string");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD still defers for a genuinely deleted session (no file with that UUID anywhere in scan)", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home); // a present, scannable session
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 750 }) + "\n", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 88 }), "utf8");

      // A DIFFERENT session UUID that exists nowhere on disk / in the scan.
      const deletedPath = path.join(
        home, ".codex", "sessions", "2025", "12", "10",
        "rollout-2025-12-10T00-00-00-99999999-9999-9999-9999-999999999999.jsonl",
      );
      const cursors = {
        hourly: { buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } }, groupQueued: {} },
        files: { [codexFile]: { inode: 1, offset: 5 }, [deletedPath]: { inode: 2, offset: 5 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors, queuePath, queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });

      assert.equal(ran, false, "an unreproducible deleted session must defer the repair");
      assert.equal(codexBucketTotal(cursors), 750, "nothing mutated");
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 88);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY].skipped, true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GUARD recognizes Windows-style stale Codex cursor paths", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home);
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({
          source: "codex",
          model: "unknown",
          hour_start: "2025-12-17T00:00:00.000Z",
          total_tokens: 750,
        }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 88 }), "utf8");
      const deletedWindowsPath =
        "C:\\Users\\me\\.codex\\sessions\\2025\\12\\10\\rollout-2025-12-10T00-00-00-99999999-9999-9999-9999-999999999999.jsonl";
      const cursors = {
        hourly: {
          buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 750 } } },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5 }, [deletedWindowsPath]: { inode: 2, offset: 5 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexRescanInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 750);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 88);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY].skipped, true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #169 follow-up: fork-replay historical repair. Re-runs the guarded rebuild
// under CODEX_FORK_REPLAY_REPAIR_KEY so history parsed before the same-day
// fork burst detector landed gets rebuilt with the fork-aware parser.
// ---------------------------------------------------------------------------

const {
  repairCodexForkReplayInflation,
  CODEX_FORK_REPLAY_REPAIR_KEY,
} = require("../src/commands/sync");

// A same-day forked rollout: 2 replay rows in one flush (1ms apart), then one
// live turn 30s later. Old parser counted all 3 (total 250+150=400 inflated
// ... replay 100+150, live 50 → phantom 150); fork-aware parser counts the
// first-of-run replay row (no lookahead) + the live turn.
const FORK_R1 = { input_tokens: 60, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0, total_tokens: 100 };
const FORK_R2 = { input_tokens: 90, cached_input_tokens: 0, output_tokens: 60, reasoning_output_tokens: 0, total_tokens: 150 };
const FORK_LIVE = { input_tokens: 30, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 50 };
const FORK_T2 = { input_tokens: 150, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 250 };
const FORK_T3 = { input_tokens: 180, cached_input_tokens: 0, output_tokens: 120, reasoning_output_tokens: 0, total_tokens: 300 };
// first-of-run replay row (100) + live (50): the bounded residual documented at the skip site
const FORK_TRUE_TOTAL = FORK_R1.total_tokens + FORK_LIVE.total_tokens;
const FORK_INFLATED_TOTAL = FORK_R1.total_tokens + FORK_R2.total_tokens + FORK_LIVE.total_tokens;

async function writeForkedCodexFile(home, uuid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff") {
  const dir = path.join(home, ".codex", "sessions", "2025", "12", "17");
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, `rollout-2025-12-17T00-00-00-${uuid}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: uuid, forked_from_id: "019e095c-c041-7b40-b7cb-43ddb153086c", model: "gpt-4" },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-4", current_date: "2025-12-17" } }),
    tokenCountLine({ ts: "2025-12-17T00:00:00.100Z", last: FORK_R1, total: FORK_R1 }),
    tokenCountLine({ ts: "2025-12-17T00:00:00.101Z", last: FORK_R2, total: FORK_T2 }),
    tokenCountLine({ ts: "2025-12-17T00:00:30.101Z", last: FORK_LIVE, total: FORK_T3 }),
  ];
  await fs.writeFile(fp, lines.join("\n") + "\n", "utf8");
  return fp;
}

describe("repairCodexForkReplayInflation (#169 follow-up) — fork replay historical repair", () => {
  it("rebuilds fork-replay-inflated codex history with the fork-aware parser", async () => {
    const home = await makeTempHome();
    try {
      const forkedFile = await writeForkedCodexFile(home);
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");

      // INFLATED state: old parser counted the replay rows.
      await fs.writeFile(
        queuePath,
        [
          JSON.stringify({ source: "codex", model: "gpt-4", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: FORK_INFLATED_TOTAL }),
          JSON.stringify({ source: "claude", model: "opus", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 5000 }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 4321 }), "utf8");

      const cursors = {
        hourly: {
          buckets: {
            "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: FORK_INFLATED_TOTAL } },
            "claude|opus|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 5000 } },
          },
          groupQueued: {},
        },
        files: { [forkedFile]: { inode: 1, offset: 5, lastTotal: { total_tokens: FORK_T3.total_tokens } } },
        codexHashes: [],
        // #187 repair long completed — only the fork key triggers this rebuild.
        migrations: { [CODEX_RESCAN_DEDUP_REPAIR_KEY]: "2026-06-15T00:00:00.000Z" },
      };

      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: forkedFile, source: "codex" }],
      });
      assert.equal(ran, true);

      assert.equal(codexBucketTotal(cursors), FORK_TRUE_TOTAL);
      assert.equal(cursors.hourly.buckets["claude|opus|2025-12-17T00:00:00.000Z"].totals.total_tokens, 5000);

      const q = await queueRowsBySource(queuePath);
      assert.equal(q.codex.total, FORK_TRUE_TOTAL, "queue codex rebuilt without replay phantom");
      assert.equal(q.claude.total, 5000);

      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
      assert.ok(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY]);
      // #187 key untouched
      assert.equal(cursors.migrations[CODEX_RESCAN_DEDUP_REPAIR_KEY], "2026-06-15T00:00:00.000Z");

      // idempotent
      assert.equal(
        await repairCodexForkReplayInflation({
          cursors,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: forkedFile, source: "codex" }],
        }),
        false,
      );
      assert.equal(codexBucketTotal(cursors), FORK_TRUE_TOTAL);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("marks done without a rebuild when no forked rollout exists (pre-gate)", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeCodexFile(home); // NOT forked
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(
        queuePath,
        JSON.stringify({ source: "codex", model: "unknown", hour_start: "2025-12-17T00:00:00.000Z", total_tokens: 250 }) + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 777 }), "utf8");
      const cursors = {
        hourly: {
          buckets: { "codex|unknown|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 250 } } },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 500 } },
        codexHashes: ["keep:me"],
        migrations: {},
      };

      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      // nothing touched, key finalized
      assert.equal(codexBucketTotal(cursors), 250);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 777);
      assert.deepEqual(cursors.codexHashes, ["keep:me"]);
      assert.equal(typeof cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY], "string");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("marks done without a rebuild when the #187 repair rebuilt in the same sync", async () => {
    const home = await makeTempHome();
    try {
      const forkedFile = await writeForkedCodexFile(home);
      const cursors = { hourly: { buckets: {}, groupQueued: {} }, files: {}, codexHashes: [], migrations: {} };
      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath: path.join(home, "queue.jsonl"),
        queueStatePath: path.join(home, "queue.state.json"),
        rolloutFiles: [{ path: forkedFile, source: "codex" }],
        legacyRepairRan: true,
      });
      assert.equal(ran, false);
      assert.equal(typeof cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY], "string");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("defers when cursors record codex history this scan does not cover (pre-gate coverage)", async () => {
    const home = await makeTempHome();
    try {
      // No forked file in THIS scan — but cursors remember a codex session the
      // scan did not include (WSL split / relocated ~/.codex / deleted file).
      // Finalizing here would permanently foreclose the repair; the gate must
      // defer retryably instead.
      const codexFile = await writeCodexFile(home); // NOT forked
      const uncoveredPath = path.join(
        home, ".codex", "sessions", "2025", "12", "10",
        "rollout-2025-12-10T00-00-00-11111111-2222-3333-4444-555555555555.jsonl",
      );
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, "", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 9 }), "utf8");
      const cursors = {
        hourly: { buckets: {}, groupQueued: {} },
        files: { [codexFile]: { inode: 1, offset: 5 }, [uncoveredPath]: { inode: 2, offset: 5 } },
        codexHashes: [],
        migrations: {},
      };

      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY].skipped, true);
      assert.equal(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY].reason, "codex_history_not_covered");

      // Once the scan covers the remembered session (file reappears under a
      // moved path with the same UUID), the retryable sentinel lets the gate
      // finalize.
      const reappeared = path.join(
        home, ".codex", "archived_sessions", "2025", "12", "10",
        "rollout-2025-12-10T00-00-00-11111111-2222-3333-4444-555555555555.jsonl",
      );
      await fs.mkdir(path.dirname(reappeared), { recursive: true });
      await fs.copyFile(codexFile, reappeared);
      const ranAgain = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [
          { path: codexFile, source: "codex" },
          { path: reappeared, source: "codex" },
        ],
      });
      assert.equal(ranAgain, false);
      assert.equal(typeof cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY], "string");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("defers with a retryable sentinel when a candidate head cannot be read (pre-gate indeterminate)", async () => {
    const home = await makeTempHome();
    try {
      // A directory posing as a rollout file: fh.read() fails with EISDIR, so
      // the head scan cannot rule out a fork — the gate must NOT finalize.
      const unreadable = path.join(
        home, ".codex", "sessions", "2025", "12", "17",
        "rollout-2025-12-17T00-00-00-cccccccc-dddd-eeee-ffff-000000000000.jsonl",
      );
      await fs.mkdir(unreadable, { recursive: true });
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, "", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 12 }), "utf8");
      const cursors = { hourly: { buckets: {}, groupQueued: {} }, files: {}, codexHashes: [], migrations: {} };

      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: unreadable, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY].skipped, true);
      assert.equal(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY].reason, "fork_scan_indeterminate");
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 12);

      // Once the readable truth is available, the retryable sentinel lets the
      // gate finalize (here: only a non-forked file remains).
      const codexFile = await writeCodexFile(home);
      const ranAgain = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ranAgain, false);
      assert.equal(typeof cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY], "string");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("defers via the reproducibility guard when a previously-counted session is gone", async () => {
    const home = await makeTempHome();
    try {
      const forkedFile = await writeForkedCodexFile(home);
      const deletedPath = path.join(
        home, ".codex", "sessions", "2025", "12", "10",
        "rollout-2025-12-10T00-00-00-99999999-9999-9999-9999-999999999999.jsonl",
      );
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      await fs.writeFile(queuePath, "", "utf8");
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 55 }), "utf8");
      const cursors = {
        hourly: { buckets: { "codex|gpt-4|2025-12-17T00:00:00.000Z": { totals: { total_tokens: 300 } } }, groupQueued: {} },
        files: { [forkedFile]: { inode: 1, offset: 5 }, [deletedPath]: { inode: 2, offset: 5 } },
        codexHashes: [],
        migrations: {},
      };

      const ran = await repairCodexForkReplayInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: forkedFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 300);
      assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 55);
      assert.equal(cursors.migrations[CODEX_FORK_REPLAY_REPAIR_KEY].skipped, true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Interleaved SessionState historical repair. Multi-agent Codex can emit two
// independent cumulative counters into one rollout; older TokenTracker builds
// treated them as one counter and persisted the cross-stream gaps.
// ---------------------------------------------------------------------------

const {
  repairCodexInterleavedUsageInflation,
  CODEX_USAGE_LINEAGE_REPAIR_KEY,
} = require("../src/commands/sync");

const lineageUsage = (totalTokens) => ({
  input_tokens: totalTokens,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: totalTokens,
});
const LINEAGE_TRUE_TOTAL = 380;

async function writeLineageCodexFile(home, {
  archived = false,
  baseInstructionsBytes = 96 * 1024,
  cwd = null,
  interleaved = true,
  lineagePaddingLines = 0,
  multiAgentVersion = "v2",
  resumedMultiAgent = false,
  tailPaddingLines = 0,
  tokenAnnotation = null,
  uuid = "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb",
} = {}) {
  const dir = archived
    ? path.join(home, ".codex", "archived_sessions", "nested")
    : path.join(home, ".codex", "sessions", "2025", "12", "18");
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, `rollout-2025-12-18T00-00-00-${uuid}.jsonl`);
  const lines = [
    // The real affected rollout's marker begins after byte 95,915. Keep this
    // fixture above the old 64 KiB fork-head window to lock in the wider gate.
    JSON.stringify({
      type: "session_meta",
      payload: { id: uuid, base_instructions: { text: "x".repeat(baseInstructionsBytes) } },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        cwd,
        model: "gpt-5.6",
        ...(resumedMultiAgent || multiAgentVersion != null
          ? { multi_agent_version: resumedMultiAgent ? "none" : multiAgentVersion }
          : {}),
      },
    }),
  ];
  for (let index = 0; index < lineagePaddingLines; index += 1) {
    lines.push(JSON.stringify({
      type: "event_msg",
      payload: { type: "note", text: "x".repeat(32 * 1024) },
    }));
  }
  if (interleaved) {
    lines.push(tokenCountLine({
      ts: "2025-12-18T00:00:00.000Z",
      last: lineageUsage(100),
      total: lineageUsage(100),
      annotation: tokenAnnotation,
    }));
    if (resumedMultiAgent) {
      // Old sessions can be resumed after upgrading Codex. The active marker
      // then appears after an earlier token_count, so the migration must use
      // its bounded tail gate instead of finalizing from the first turn.
      lines.push(JSON.stringify({
        type: "turn_context",
        payload: { cwd, model: "gpt-5.6", multi_agent_version: "v2" },
      }));
    }
    lines.push(
      tokenCountLine({ ts: "2025-12-18T00:00:01.000Z", last: lineageUsage(200), total: lineageUsage(200) }),
      tokenCountLine({ ts: "2025-12-18T00:00:02.000Z", last: lineageUsage(100), total: lineageUsage(100) }),
      tokenCountLine({ ts: "2025-12-18T00:00:03.000Z", last: lineageUsage(50), total: lineageUsage(250) }),
      tokenCountLine({ ts: "2025-12-18T00:00:04.000Z", last: lineageUsage(30), total: lineageUsage(130) }),
    );
  } else {
    lines.push(
      tokenCountLine({ ts: "2025-12-18T00:00:00.000Z", last: lineageUsage(100), total: lineageUsage(100) }),
      tokenCountLine({ ts: "2025-12-18T00:00:01.000Z", last: lineageUsage(150), total: lineageUsage(250) }),
    );
  }
  for (let index = 0; index < tailPaddingLines; index += 1) {
    lines.push(JSON.stringify({
      type: "event_msg",
      payload: { type: "note", text: "x".repeat(32 * 1024) },
    }));
  }
  await fs.writeFile(fp, lines.join("\n") + "\n", "utf8");
  return fp;
}

async function seedInflatedLineageInstall(home, codexFile) {
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  const cursorsPath = path.join(trackerDir, "cursors.json");
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const queueStatePath = path.join(trackerDir, "queue.state.json");
  const hour = "2025-12-18T00:00:00.000Z";
  const inflated = 4_700_000_000;
  await fs.mkdir(trackerDir, { recursive: true });
  await fs.writeFile(
    cursorsPath,
    JSON.stringify({
      version: 1,
      files: { [codexFile]: { inode: 1, offset: 5, lastTotal: lineageUsage(inflated) } },
      hourly: {
        buckets: {
          [`codex|gpt-5.6|${hour}`]: { totals: { total_tokens: inflated } },
        },
        groupQueued: {},
      },
      codexHashes: ["stale:background-lineage"],
      migrations: {},
    }),
    "utf8",
  );
  await fs.writeFile(
    queuePath,
    JSON.stringify({
      source: "codex",
      model: "gpt-5.6",
      hour_start: hour,
      total_tokens: inflated,
    }) + "\n",
    "utf8",
  );
  await fs.writeFile(queueStatePath, JSON.stringify({ offset: 777 }), "utf8");
  return { cursorsPath, queuePath, queueStatePath };
}

describe("repairCodexInterleavedUsageInflation — cumulative lineage repair", () => {
  it("repairs interleaved counters without relying on multi_agent_version metadata", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeLineageCodexFile(home, {
        multiAgentVersion: null,
      });
      const { queuePath, queueStatePath } = await seedInflatedLineageInstall(home, codexFile);
      const cursors = JSON.parse(
        await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"),
      );

      assert.equal(
        await repairCodexInterleavedUsageInflation({
          cursors,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: codexFile, source: "codex" }],
        }),
        true,
      );
      assert.equal(codexBucketTotal(cursors), LINEAGE_TRUE_TOTAL);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, LINEAGE_TRUE_TOTAL);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  for (const [name, separator] of [
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
  ]) {
    it(`repairs valid physical JSONL records containing a Unicode ${name}`, async () => {
      const home = await makeTempHome();
      try {
        const codexFile = await writeLineageCodexFile(home, {
          tokenAnnotation: `before${separator}after`,
        });
        const physicalRecords = (await fs.readFile(codexFile, "utf8")).split("\n");
        assert.ok(physicalRecords[2].includes(separator));
        assert.doesNotThrow(() => JSON.parse(physicalRecords[2]));

        const { queuePath, queueStatePath } = await seedInflatedLineageInstall(home, codexFile);
        const cursors = JSON.parse(
          await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"),
        );

        assert.equal(
          await repairCodexInterleavedUsageInflation({
            cursors,
            queuePath,
            queueStatePath,
            rolloutFiles: [{ path: codexFile, source: "codex" }],
          }),
          true,
        );
        assert.equal(codexBucketTotal(cursors), LINEAGE_TRUE_TOTAL);
        assert.equal((await queueRowsBySource(queuePath)).codex.total, LINEAGE_TRUE_TOTAL);
        assert.equal(typeof cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY], "string");
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    });
  }

  it("counts CRLF bytes exactly when enforcing the lineage scan budget", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeLineageCodexFile(home);
      const content = await fs.readFile(codexFile, "utf8");
      await fs.writeFile(codexFile, content.replaceAll("\n", "\r\n"), "utf8");
      const stat = await fs.stat(codexFile);
      const { queuePath, queueStatePath } = await seedInflatedLineageInstall(home, codexFile);
      const originalQueue = await fs.readFile(queuePath, "utf8");
      const cursors = JSON.parse(
        await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"),
      );

      assert.equal(
        await repairCodexInterleavedUsageInflation({
          cursors,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: codexFile, source: "codex" }],
          maxLineageScanBytes: stat.size - 1,
        }),
        false,
      );
      assert.equal(
        cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY].reason,
        "usage_lineage_scan_indeterminate",
      );
      assert.equal(await fs.readFile(queuePath, "utf8"), originalQueue);

      assert.equal(
        await repairCodexInterleavedUsageInflation({
          cursors,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: codexFile, source: "codex" }],
          maxLineageScanBytes: stat.size,
        }),
        true,
      );
      assert.equal(codexBucketTotal(cursors), LINEAGE_TRUE_TOTAL);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("accepts an unterminated final record when the byte budget equals the file size", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeLineageCodexFile(home);
      const content = await fs.readFile(codexFile, "utf8");
      await fs.writeFile(codexFile, content.slice(0, -1), "utf8");
      const stat = await fs.stat(codexFile);
      const { queuePath, queueStatePath } = await seedInflatedLineageInstall(home, codexFile);
      const cursors = JSON.parse(
        await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"),
      );

      assert.equal(
        await repairCodexInterleavedUsageInflation({
          cursors,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: codexFile, source: "codex" }],
          maxLineageScanBytes: stat.size,
        }),
        true,
      );
      assert.equal(codexBucketTotal(cursors), LINEAGE_TRUE_TOTAL);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("finds interleaved counters in the middle of a file larger than both old metadata windows", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeLineageCodexFile(home, {
        baseInstructionsBytes: 1100 * 1024,
        tailPaddingLines: 40,
      });
      const { queuePath, queueStatePath } = await seedInflatedLineageInstall(home, codexFile);
      const cursors = JSON.parse(
        await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"),
      );

      assert.equal(
        await repairCodexInterleavedUsageInflation({
          cursors,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: codexFile, source: "codex" }],
        }),
        true,
      );
      assert.equal(codexBucketTotal(cursors), LINEAGE_TRUE_TOTAL);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("defers an affected rebuild when any contributing rollout is malformed", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeLineageCodexFile(home);
      const malformedFile = path.join(
        home,
        ".codex",
        "sessions",
        "2025",
        "12",
        "18",
        "rollout-2025-12-18T00-01-00-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl",
      );
      await fs.writeFile(malformedFile, '{"type":"turn_context","payload":\n', "utf8");
      const { queuePath, queueStatePath } = await seedInflatedLineageInstall(home, codexFile);
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");
      await fs.writeFile(projectQueuePath, '{"source":"codex","total_tokens":17}\n', "utf8");
      await fs.writeFile(projectQueueStatePath, '{"offset":321}', "utf8");
      const cursors = JSON.parse(
        await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"),
      );
      cursors.files[malformedFile] = { inode: 2, offset: 5 };
      const originalQueue = await fs.readFile(queuePath, "utf8");
      const originalQueueState = await fs.readFile(queueStatePath, "utf8");
      const originalProjectQueue = await fs.readFile(projectQueuePath, "utf8");
      const originalProjectQueueState = await fs.readFile(projectQueueStatePath, "utf8");
      const originalCursorState = structuredClone({
        files: cursors.files,
        hourly: cursors.hourly,
        projectHourly: cursors.projectHourly,
        codexHashes: cursors.codexHashes,
      });

      assert.equal(
        await repairCodexInterleavedUsageInflation({
          cursors,
          queuePath,
          queueStatePath,
          projectQueuePath,
          projectQueueStatePath,
          rolloutFiles: [
            { path: codexFile, source: "codex" },
            { path: malformedFile, source: "codex" },
          ],
        }),
        false,
      );
      assert.equal(codexBucketTotal(cursors), 4_700_000_000);
      assert.equal(await fs.readFile(queuePath, "utf8"), originalQueue);
      assert.equal(await fs.readFile(queueStatePath, "utf8"), originalQueueState);
      assert.equal(await fs.readFile(projectQueuePath, "utf8"), originalProjectQueue);
      assert.equal(await fs.readFile(projectQueueStatePath, "utf8"), originalProjectQueueState);
      assert.deepEqual(
        {
          files: cursors.files,
          hourly: cursors.hourly,
          projectHourly: cursors.projectHourly,
          codexHashes: cursors.codexHashes,
        },
        originalCursorState,
      );
      assert.equal(
        cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY].reason,
        "usage_lineage_scan_indeterminate",
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("defers atomically when a contributing rollout contains invalid UTF-8", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeLineageCodexFile(home);
      await fs.appendFile(
        codexFile,
        Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
      );
      const { queuePath, queueStatePath } = await seedInflatedLineageInstall(home, codexFile);
      const cursors = JSON.parse(
        await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"),
      );
      const originalQueue = await fs.readFile(queuePath, "utf8");
      const originalQueueState = await fs.readFile(queueStatePath, "utf8");
      const originalCursorState = structuredClone({
        files: cursors.files,
        hourly: cursors.hourly,
        codexHashes: cursors.codexHashes,
      });

      assert.equal(
        await repairCodexInterleavedUsageInflation({
          cursors,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: codexFile, source: "codex" }],
        }),
        false,
      );
      assert.equal(await fs.readFile(queuePath, "utf8"), originalQueue);
      assert.equal(await fs.readFile(queueStatePath, "utf8"), originalQueueState);
      assert.deepEqual(
        { files: cursors.files, hourly: cursors.hourly, codexHashes: cursors.codexHashes },
        originalCursorState,
      );
      assert.equal(
        cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY].reason,
        "usage_lineage_scan_indeterminate",
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("defers without mutation when a contributing rollout changes during rebuild", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeLineageCodexFile(home);
      const { queuePath, queueStatePath } = await seedInflatedLineageInstall(home, codexFile);
      const cursors = JSON.parse(
        await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"),
      );
      const originalQueue = await fs.readFile(queuePath, "utf8");
      const realStat = fs.stat;
      let targetStats = 0;
      fs.stat = async function changedAfterScan(target, ...args) {
        const stat = await realStat.call(this, target, ...args);
        if (String(target) !== codexFile) return stat;
        targetStats += 1;
        if (targetStats <= 2) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          mtimeMs: Number(stat.mtimeMs) + 1,
        });
      };
      try {
        assert.equal(
          await repairCodexInterleavedUsageInflation({
            cursors,
            queuePath,
            queueStatePath,
            rolloutFiles: [{ path: codexFile, source: "codex" }],
          }),
          false,
        );
      } finally {
        fs.stat = realStat;
      }

      assert.ok(targetStats > 2, "repair must revalidate the rollout after rebuilding");
      assert.equal(codexBucketTotal(cursors), 4_700_000_000);
      assert.equal(await fs.readFile(queuePath, "utf8"), originalQueue);
      assert.equal(cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY], undefined);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rebuilds affected main and project history, preserves other sources, resets uploads, and is idempotent", async () => {
    const home = await makeTempHome();
    try {
      const repoRoot = path.join(home, "work", "lineage");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/lineage.git\n`,
        "utf8",
      );
      const codexFile = await writeLineageCodexFile(home, {
        cwd: repoRoot,
        resumedMultiAgent: true,
      });
      const hour = "2025-12-18T00:00:00.000Z";
      const projectKey = "acme/lineage";
      const projectRef = "https://github.com/acme/lineage";
      const inflated = 4_700_000_000;
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const projectQueuePath = path.join(home, "project.queue.jsonl");
      const projectQueueStatePath = path.join(home, "project.queue.state.json");
      await fs.writeFile(
        queuePath,
        [
          JSON.stringify({ source: "codex", model: "gpt-5.6", hour_start: hour, total_tokens: inflated }),
          JSON.stringify({ source: "claude", model: "opus", hour_start: hour, total_tokens: 5000 }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(
        projectQueuePath,
        [
          JSON.stringify({ project_ref: projectRef, project_key: projectKey, source: "codex", hour_start: hour, total_tokens: inflated }),
          JSON.stringify({ project_ref: projectRef, project_key: projectKey, source: "claude", hour_start: hour, total_tokens: 5000 }),
        ].join("\n") + "\n",
        "utf8",
      );
      await fs.writeFile(queueStatePath, JSON.stringify({ offset: 999 }), "utf8");
      await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 888 }), "utf8");

      const cursors = {
        hourly: {
          buckets: {
            [`codex|gpt-5.6|${hour}`]: { totals: { total_tokens: inflated } },
            [`claude|opus|${hour}`]: { totals: { total_tokens: 5000 } },
          },
          groupQueued: {},
        },
        projectHourly: {
          version: 2,
          buckets: {
            [`${projectKey}|codex|${hour}`]: {
              project_ref: projectRef,
              project_key: projectKey,
              source: "codex",
              hour_start: hour,
              totals: { total_tokens: inflated },
            },
            [`${projectKey}|claude|${hour}`]: {
              project_ref: projectRef,
              project_key: projectKey,
              source: "claude",
              hour_start: hour,
              totals: { total_tokens: 5000 },
            },
          },
          projects: { [projectKey]: { projectRef, projectKey, status: "public_verified" } },
        },
        files: { [codexFile]: { inode: 1, offset: 5, lastTotal: lineageUsage(inflated) } },
        codexHashes: ["stale:lineage"],
        migrations: {},
      };

      const args = {
        cursors,
        queuePath,
        queueStatePath,
        projectQueuePath,
        projectQueueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      };
      assert.equal(await repairCodexInterleavedUsageInflation(args), true);
      assert.equal(codexBucketTotal(cursors), LINEAGE_TRUE_TOTAL);
      assert.equal(projectBucketTotal(cursors, "codex"), LINEAGE_TRUE_TOTAL);
      assert.equal(cursors.hourly.buckets[`claude|opus|${hour}`].totals.total_tokens, 5000);
      assert.equal(projectBucketTotal(cursors, "claude"), 5000);

      const queue = await queueRowsBySource(queuePath);
      const projectQueue = await queueRowsBySource(projectQueuePath);
      assert.equal(queue.codex.total, LINEAGE_TRUE_TOTAL);
      assert.equal(queue.claude.total, 5000);
      assert.equal(projectQueue.codex.total, LINEAGE_TRUE_TOTAL);
      assert.equal(projectQueue.claude.total, 5000);

      const uploadState = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
      const projectUploadState = JSON.parse(await fs.readFile(projectQueueStatePath, "utf8"));
      assert.equal(uploadState.offset, 0);
      assert.equal(projectUploadState.offset, 0);
      assert.equal(uploadState.note, "reset_after_codex_usage_lineage_2026_07_v2");
      assert.equal(projectUploadState.note, "reset_after_codex_usage_lineage_2026_07_v2");
      assert.equal(cursors.files[codexFile].tokenUsageBaselines.length, 2);
      assert.equal(typeof cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY], "string");

      const queueAfterRepair = await fs.readFile(queuePath, "utf8");
      const projectQueueAfterRepair = await fs.readFile(projectQueuePath, "utf8");
      assert.equal(await repairCodexInterleavedUsageInflation(args), false);
      assert.equal(await fs.readFile(queuePath, "utf8"), queueAfterRepair);
      assert.equal(await fs.readFile(projectQueuePath, "utf8"), projectQueueAfterRepair);
      assert.equal(codexBucketTotal(cursors), LINEAGE_TRUE_TOTAL);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("defers without mutation when affected history includes an unreproducible session", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeLineageCodexFile(home);
      const deletedPath = path.join(
        home,
        ".codex",
        "sessions",
        "2025",
        "12",
        "10",
        "rollout-2025-12-10T00-00-00-99999999-9999-9999-9999-999999999999.jsonl",
      );
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const originalQueue = JSON.stringify({
        source: "codex",
        model: "gpt-5.6",
        hour_start: "2025-12-18T00:00:00.000Z",
        total_tokens: 4_700_000_000,
      }) + "\n";
      const originalUploadState = JSON.stringify({ offset: 444 });
      await fs.writeFile(queuePath, originalQueue, "utf8");
      await fs.writeFile(queueStatePath, originalUploadState, "utf8");
      const cursors = {
        hourly: {
          buckets: {
            "codex|gpt-5.6|2025-12-18T00:00:00.000Z": {
              totals: { total_tokens: 4_700_000_000 },
            },
          },
          groupQueued: {},
        },
        files: {
          [codexFile]: { inode: 1, offset: 5 },
          [deletedPath]: { inode: 2, offset: 5 },
        },
        codexHashes: ["keep:lineage"],
        migrations: {},
      };

      const ran = await repairCodexInterleavedUsageInflation({
        cursors,
        queuePath,
        queueStatePath,
        rolloutFiles: [{ path: codexFile, source: "codex" }],
      });
      assert.equal(ran, false);
      assert.equal(codexBucketTotal(cursors), 4_700_000_000);
      assert.equal(await fs.readFile(queuePath, "utf8"), originalQueue);
      assert.equal(await fs.readFile(queueStatePath, "utf8"), originalUploadState);
      assert.deepEqual(cursors.codexHashes, ["keep:lineage"]);
      assert.equal(cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY].skipped, true);
      assert.equal(
        cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY].reason,
        "codex_session_unreproducible",
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("marks a covered, single-lineage multi-agent history complete without queue mutation", async () => {
    const home = await makeTempHome();
    try {
      const codexFile = await writeLineageCodexFile(home, { interleaved: false });
      const queuePath = path.join(home, "queue.jsonl");
      const queueStatePath = path.join(home, "queue.state.json");
      const originalQueue = JSON.stringify({
        source: "codex",
        model: "gpt-5.6",
        hour_start: "2025-12-18T00:00:00.000Z",
        total_tokens: 250,
      }) + "\n";
      const originalUploadState = JSON.stringify({ offset: 321 });
      await fs.writeFile(queuePath, originalQueue, "utf8");
      await fs.writeFile(queueStatePath, originalUploadState, "utf8");
      const cursors = {
        hourly: {
          buckets: {
            "codex|gpt-5.6|2025-12-18T00:00:00.000Z": { totals: { total_tokens: 250 } },
          },
          groupQueued: {},
        },
        files: { [codexFile]: { inode: 1, offset: 5 } },
        codexHashes: ["keep:single"],
        migrations: {},
      };

      assert.equal(
        await repairCodexInterleavedUsageInflation({
          cursors,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: codexFile, source: "codex" }],
        }),
        false,
      );
      assert.equal(typeof cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY], "string");
      assert.equal(await fs.readFile(queuePath, "utf8"), originalQueue);
      assert.equal(await fs.readFile(queueStatePath, "utf8"), originalUploadState);
      assert.deepEqual(cursors.codexHashes, ["keep:single"]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("marks complete without scanning when an earlier guarded repair rebuilt this sync", async () => {
    const cursors = { migrations: {} };
    assert.equal(
      await repairCodexInterleavedUsageInflation({
        cursors,
        rolloutFiles: [],
        legacyRepairRan: true,
      }),
      false,
    );
    assert.equal(typeof cursors.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY], "string");
  });

  it("bounds the background lineage scan and leaves an explicit full repair retryable", async () => {
    await withTempSyncEnv(async (home) => {
      const codexFile = await writeLineageCodexFile(home, {
        archived: true,
        lineagePaddingLines: 40,
      });
      const { cursorsPath, queuePath, queueStatePath } =
        await seedInflatedLineageInstall(home, codexFile);

      await cmdSync(["--auto", "--background", "--all-local-sources"]);

      const bounded = JSON.parse(await fs.readFile(cursorsPath, "utf8"));
      assert.equal(
        bounded.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY].reason,
        "usage_lineage_scan_indeterminate",
      );
      assert.equal(
        await repairCodexInterleavedUsageInflation({
          cursors: bounded,
          queuePath,
          queueStatePath,
          rolloutFiles: [{ path: codexFile, source: "codex" }],
        }),
        true,
      );
      assert.equal(codexBucketTotal(bounded), LINEAGE_TRUE_TOTAL);
      assert.equal((await queueRowsBySource(queuePath)).codex.total, LINEAGE_TRUE_TOTAL);
      assert.equal(typeof bounded.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY], "string");
    });
  });

  it("keeps background refreshes alive when the one-time repair commit throws", async () => {
    await withTempSyncEnv(async (home) => {
      const codexFile = await writeLineageCodexFile(home, {
        archived: true,
        resumedMultiAgent: true,
      });
      const { cursorsPath, queuePath } = await seedInflatedLineageInstall(home, codexFile);
      const realRename = fs.rename;
      let injectedFailure = false;
      fs.rename = async function failRepairQueueRename(from, to, ...args) {
        if (
          !injectedFailure &&
          String(to) === queuePath &&
          String(from).startsWith(`${queuePath}.tmp.`)
        ) {
          injectedFailure = true;
          throw new Error("injected repair queue rename failure");
        }
        return realRename.call(this, from, to, ...args);
      };
      try {
        await cmdSync(["--auto", "--background", "--all-local-sources"]);
      } finally {
        fs.rename = realRename;
      }

      assert.equal(injectedFailure, true);
      const persisted = JSON.parse(await fs.readFile(cursorsPath, "utf8"));
      assert.equal(
        persisted.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY].reason,
        "background_repair_requires_full_sync",
      );

      const archiveRoot = path.join(home, ".codex", "archived_sessions");
      const realReaddir = fs.readdir;
      let archiveReads = 0;
      fs.readdir = async function countedReaddir(target, ...args) {
        const value = String(target);
        if (value === archiveRoot || value.startsWith(`${archiveRoot}${path.sep}`)) {
          archiveReads += 1;
        }
        return realReaddir.call(this, target, ...args);
      };
      try {
        await cmdSync(["--auto", "--background", "--all-local-sources"]);
      } finally {
        fs.readdir = realReaddir;
      }
      assert.equal(archiveReads, 0);
    });
  });

  it("repairs an existing native install on its first background sync, then restores lightweight archive scanning", async () => {
    await withTempSyncEnv(async (home) => {
      const codexFile = await writeLineageCodexFile(home, {
        archived: true,
        resumedMultiAgent: true,
      });
      const { cursorsPath, queuePath, queueStatePath } =
        await seedInflatedLineageInstall(home, codexFile);

      await cmdSync(["--auto", "--background", "--all-local-sources"]);

      const repaired = JSON.parse(await fs.readFile(cursorsPath, "utf8"));
      assert.equal(codexBucketTotal(repaired), LINEAGE_TRUE_TOTAL);
      assert.equal(
        typeof repaired.migrations[CODEX_USAGE_LINEAGE_REPAIR_KEY],
        "string",
      );
      assert.equal((await queueRowsBySource(queuePath)).codex.total, LINEAGE_TRUE_TOTAL);
      assert.equal(
        JSON.parse(await fs.readFile(queueStatePath, "utf8")).note,
        "reset_after_codex_usage_lineage_2026_07_v2",
      );

      const archiveRoot = path.join(home, ".codex", "archived_sessions");
      const realReaddir = fs.readdir;
      let archiveReads = 0;
      fs.readdir = async function countedReaddir(target, ...args) {
        const value = String(target);
        if (value === archiveRoot || value.startsWith(`${archiveRoot}${path.sep}`)) {
          archiveReads += 1;
        }
        return realReaddir.call(this, target, ...args);
      };
      try {
        await cmdSync(["--auto", "--background", "--all-local-sources"]);
      } finally {
        fs.readdir = realReaddir;
      }
      assert.equal(archiveReads, 0);
    });
  });
});
