const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { cmdSync } = require("../src/commands/sync");
const { openLock } = require("../src/lib/fs");
const { DEFAULT_ANON_KEY } = require("../src/lib/runtime-config");

function tokenCountLine({ ts, totalTokens }) {
  const usage = {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } },
  });
}

async function writeCodexRollout(codexHome, date, uuid, totalTokens) {
  const [year, month, day] = date.split("-");
  const dir = path.join(codexHome, "sessions", year, month, day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  await fs.writeFile(filePath, tokenCountLine({ ts: `${date}T00:00:00.000Z`, totalTokens }) + "\n", "utf8");
  return filePath;
}

async function writeEveryCodeRollout(codeHome, date, uuid, totalTokens) {
  const [year, month, day] = date.split("-");
  const dir = path.join(codeHome, "sessions", year, month, day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  await fs.writeFile(filePath, tokenCountLine({ ts: `${date}T00:00:00.000Z`, totalTokens }) + "\n", "utf8");
  return filePath;
}

async function writeAcodeRollout(acodeHome, date, uuid, totalTokens) {
  const [year, month, day] = date.split("-");
  const dir = path.join(acodeHome, "sessions", year, month, day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  const body = [
    JSON.stringify({
      type: "turn_context",
      timestamp: `${date}T00:00:00.000Z`,
      payload: { model: "xopglm52" },
    }),
    tokenCountLine({ ts: `${date}T00:00:01.000Z`, totalTokens }),
  ].join("\n") + "\n";
  await fs.writeFile(filePath, body, "utf8");
  return filePath;
}

async function writeArchivedAcodeRollout(acodeHome, date, uuid, totalTokens) {
  const dir = path.join(acodeHome, "archived_sessions");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  const body = [
    JSON.stringify({
      type: "turn_context",
      timestamp: `${date}T00:00:00.000Z`,
      payload: { model: "xopglm52" },
    }),
    tokenCountLine({ ts: `${date}T00:00:01.000Z`, totalTokens }),
  ].join("\n") + "\n";
  await fs.writeFile(filePath, body, "utf8");
  return filePath;
}

async function writeArchivedCodexRollout(codexHome, date, uuid, totalTokens) {
  const dir = path.join(codexHome, "archived_sessions", "nested", uuid);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  await fs.writeFile(filePath, tokenCountLine({ ts: `${date}T00:00:00.000Z`, totalTokens }) + "\n", "utf8");
  return filePath;
}

async function writeClaudeSession(home, date, sessionId, totalTokens) {
  const dir = path.join(home, ".claude", "projects", "sample");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(
    filePath,
    JSON.stringify({
      type: "assistant",
      timestamp: `${date}T00:00:00.000Z`,
      requestId: `request-${sessionId}`,
      message: {
        id: `message-${sessionId}`,
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: totalTokens,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }) + "\n",
    "utf8",
  );
  return filePath;
}

async function writeReasonixTelemetry(home, sessionId) {
  const dir = path.join(home, ".reasonix", "projects", "sample", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const basePath = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(`${basePath}.telemetry.json`, JSON.stringify({
    version: 2,
    usage: {
      promptTokens: 61,
      cacheMissTokens: 21,
      cacheWriteTokens: 5,
      completionTokens: 9,
      reasoningTokens: 4,
      requestCount: 2,
    },
  }));
  await fs.writeFile(`${basePath}.meta`, JSON.stringify({
    id: sessionId,
    model: "route/deepseek-reasoner",
    updated_at: "2026-06-30T00:00:00.000Z",
  }));
}

async function withTempSyncEnv(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-background-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    TOKENTRACKER_ACODE_HOME: process.env.TOKENTRACKER_ACODE_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    OPENCODE_HOME: process.env.OPENCODE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    TOKENTRACKER_REASONIX_HOME: process.env.TOKENTRACKER_REASONIX_HOME,
    REASONIX_STATE_HOME: process.env.REASONIX_STATE_HOME,
    TOKENTRACKER_DEVICE_TOKEN: process.env.TOKENTRACKER_DEVICE_TOKEN,
    TOKENTRACKER_INSFORGE_BASE_URL: process.env.TOKENTRACKER_INSFORGE_BASE_URL,
    TOKENTRACKER_INSFORGE_ANON_KEY: process.env.TOKENTRACKER_INSFORGE_ANON_KEY,
    TOKENTRACKER_OPENCLAW_HOME: process.env.TOKENTRACKER_OPENCLAW_HOME,
    TOKENTRACKER_OPENCLAW_AGENT_ID: process.env.TOKENTRACKER_OPENCLAW_AGENT_ID,
    TOKENTRACKER_OPENCLAW_PREV_SESSION_ID: process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID,
    TOKENTRACKER_OPENCLAW_SESSION_KEY: process.env.TOKENTRACKER_OPENCLAW_SESSION_KEY,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.TOKENTRACKER_ACODE_HOME = path.join(home, ".acode");
    process.env.GEMINI_HOME = path.join(home, ".gemini");
    process.env.OPENCODE_HOME = path.join(home, ".opencode");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.TOKENTRACKER_OPENCLAW_HOME = path.join(home, ".openclaw");
    delete process.env.TOKENTRACKER_REASONIX_HOME;
    delete process.env.REASONIX_STATE_HOME;
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    delete process.env.TOKENTRACKER_INSFORGE_ANON_KEY;
    delete process.env.TOKENTRACKER_OPENCLAW_AGENT_ID;
    delete process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID;
    delete process.env.TOKENTRACKER_OPENCLAW_SESSION_KEY;
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function countReaddir(fn, predicate = () => true) {
  const realReaddir = fs.readdir;
  let count = 0;
  fs.readdir = async function countedReaddir(target, ...args) {
    if (predicate(String(target))) count += 1;
    return realReaddir.call(this, target, ...args);
  };
  try {
    await fn();
    return count;
  } finally {
    fs.readdir = realReaddir;
  }
}

async function readQueue(home) {
  return fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8");
}

async function readCursors(home) {
  return JSON.parse(await fs.readFile(path.join(home, ".tokentracker", "tracker", "cursors.json"), "utf8"));
}

test("background auto sync skips deep Codex archives", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1000-7000-8000-aaaaaaaaaaaa", 31);
    await writeArchivedCodexRollout(codexHome, "2026-06-30", "019f16bd-1001-7000-8000-aaaaaaaaaaaa", 47);

    const archiveRoot = path.join(codexHome, "archived_sessions");
    const archiveReads = await countReaddir(
      () => cmdSync(["--auto", "--background"]),
      (target) => target === archiveRoot || target.startsWith(`${archiveRoot}${path.sep}`),
    );

    assert.equal(archiveReads, 0);
    const queue = await readQueue(home);
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":31/);
    assert.doesNotMatch(queue, /"total_tokens":47/);
  });
});

test("background drain skips deep Codex archives while retaining drain semantics", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1002-7000-8000-aaaaaaaaaaaa", 53);
    await writeArchivedCodexRollout(codexHome, "2026-06-30", "019f16bd-1003-7000-8000-aaaaaaaaaaaa", 59);

    const archiveRoot = path.join(codexHome, "archived_sessions");
    const archiveReads = await countReaddir(
      () => cmdSync(["--auto", "--background", "--drain"]),
      (target) => target === archiveRoot || target.startsWith(`${archiveRoot}${path.sep}`),
    );

    assert.equal(archiveReads, 0);
    const queue = await readQueue(home);
    assert.match(queue, /"total_tokens":53/);
    assert.doesNotMatch(queue, /"total_tokens":59/);
  });
});

test("Codex notify sync catches up after an overlapping background sync releases the lock", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-1009-7000-8000-aaaaaaaaaaaa",
      73,
    );

    const trackerDir = path.join(home, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const active = await openLock(path.join(trackerDir, "sync.lock"), {
      quietIfLocked: true,
    });
    assert.ok(active);

    const notificationSync = cmdSync(
      ["--auto", "--from-notify", "--source=codex"],
      { lockWaitOptions: { notifyWaitMs: 500, notifyPollMs: 10 } },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await active.release();
    await notificationSync;

    const queue = await readQueue(home);
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":73/);
  });
});

test("native account publication waits for an overlapping sync instead of reporting success", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(
      codexHome,
      "2026-06-30",
      "019f16bd-1010-7000-8000-aaaaaaaaaaaa",
      79,
    );

    const trackerDir = path.join(home, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const active = await openLock(path.join(trackerDir, "sync.lock"), {
      quietIfLocked: true,
    });
    assert.ok(active);

    const publicationSync = cmdSync(
      ["--auto", "--background", "--publish-account"],
      { lockWaitOptions: { priorityWaitMs: 500, priorityPollMs: 10 } },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await active.release();
    await publicationSync;

    const queue = await readQueue(home);
    assert.match(queue, /"source":"codex"/);
    assert.match(queue, /"total_tokens":79/);
  });
});

test("explicit wait-for-lock fails instead of reporting success when the lock stays busy", async () => {
  await withTempSyncEnv(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const lockPath = path.join(trackerDir, "sync.lock");
    const active = await openLock(lockPath, {
      quietIfLocked: true,
    });
    assert.ok(active);

    try {
      await assert.rejects(
        cmdSync(
          ["--wait-for-lock"],
          { lockWaitOptions: { priorityWaitMs: 40, priorityPollMs: 5 } },
        ),
        (error) => error.code === "SYNC_BUSY",
      );
    } finally {
      await active.release();
    }
  });
});

test("manual drain fails explicitly when the sync lock stays busy", async () => {
  await withTempSyncEnv(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const active = await openLock(path.join(trackerDir, "sync.lock"), {
      quietIfLocked: true,
    });
    assert.ok(active);

    try {
      await assert.rejects(
        cmdSync(
          ["--drain"],
          { lockWaitOptions: { priorityWaitMs: 40, priorityPollMs: 5 } },
        ),
        (error) => {
          assert.equal(error.code, "SYNC_BUSY");
          assert.match(error.message, /no refresh was performed/);
          return true;
        },
      );
    } finally {
      await active.release();
    }

    await assert.rejects(readQueue(home), { code: "ENOENT" });
  });
});

test("Codex notify sync accepts an explicit null context", async () => {
  await withTempSyncEnv(async () => {
    await cmdSync(["--auto", "--from-notify", "--source=codex"], null);
  });
});

test("Codex notify sync does not create Acode inventory state", async () => {
  await withTempSyncEnv(async (home) => {
    await writeCodexRollout(
      process.env.CODEX_HOME,
      "2026-06-30",
      "019f16bd-1007-7000-8000-aaaaaaaaaaaa",
      41,
    );

    await cmdSync(["--auto", "--from-notify", "--source=codex"]);

    const cursors = await readCursors(home);
    assert.ok(cursors.codexDayInventoryCache);
    assert.equal(Object.hasOwn(cursors, "acodeDayInventoryCache"), false);
  });
});

test("background auto sync still includes Every Code sessions", async () => {
  await withTempSyncEnv(async (home) => {
    const codeHome = process.env.CODE_HOME;
    await writeEveryCodeRollout(codeHome, "2026-06-30", "019f16bd-1006-7000-8000-aaaaaaaaaaaa", 42);

    await cmdSync(["--auto", "--background"]);

    const queue = await readQueue(home);
    assert.match(queue, /"source":"every-code"/);
    assert.match(queue, /"total_tokens":42/);
  });
});

test("background auto sync includes live Acode sessions but skips archives", async () => {
  await withTempSyncEnv(async (home) => {
    const acodeHome = process.env.TOKENTRACKER_ACODE_HOME;
    await writeAcodeRollout(acodeHome, "2026-06-30", "019f16bd-1100-7000-8000-aaaaaaaaaaaa", 43);
    await writeArchivedAcodeRollout(acodeHome, "2026-06-30", "019f16bd-1101-7000-8000-aaaaaaaaaaaa", 47);

    await cmdSync(["--auto", "--background"]);

    const rows = (await readQueue(home)).trim().split("\n").map(JSON.parse);
    const acodeRows = rows.filter((row) => row.source === "acode");
    assert.equal(acodeRows.length, 1);
    assert.equal(acodeRows[0].model, "xopglm52");
    assert.equal(acodeRows[0].total_tokens, 43);
  });
});

test("Acode notify sync only scans Acode sessions", async () => {
  await withTempSyncEnv(async (home) => {
    await writeCodexRollout(
      process.env.CODEX_HOME,
      "2026-06-30",
      "019f16bd-1102-7000-8000-aaaaaaaaaaaa",
      53,
    );
    await writeAcodeRollout(
      process.env.TOKENTRACKER_ACODE_HOME,
      "2026-06-30",
      "019f16bd-1103-7000-8000-aaaaaaaaaaaa",
      59,
    );

    await cmdSync(["--auto", "--from-notify", "--source=acode"]);

    const rows = (await readQueue(home)).trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.source), ["acode"]);
    assert.equal(rows[0].total_tokens, 59);
  });
});

test("full sync scans Acode archives without recounting a live session copy", async () => {
  await withTempSyncEnv(async (home) => {
    const acodeHome = process.env.TOKENTRACKER_ACODE_HOME;
    const duplicateUuid = "019f16bd-1104-7000-8000-aaaaaaaaaaaa";
    const liveFile = await writeAcodeRollout(acodeHome, "2026-06-30", duplicateUuid, 61);
    const archivedDuplicate = path.join(
      acodeHome,
      "archived_sessions",
      path.basename(liveFile),
    );
    await fs.mkdir(path.dirname(archivedDuplicate), { recursive: true });
    await fs.copyFile(liveFile, archivedDuplicate);
    await writeArchivedAcodeRollout(
      acodeHome,
      "2026-06-30",
      "019f16bd-1105-7000-8000-aaaaaaaaaaaa",
      67,
    );

    await cmdSync([]);

    const rows = (await readQueue(home)).trim().split("\n").map(JSON.parse);
    const acodeRows = rows.filter((row) => row.source === "acode");
    assert.equal(acodeRows.at(-1).total_tokens, 128);
    const cursors = await readCursors(home);
    assert.equal(cursors.acodeHashes.length, 2);
  });
});

test("scoped background sync rejects non-lightweight sources", async () => {
  await withTempSyncEnv(async (home) => {
    const claudeProjectsDir = path.join(home, ".claude", "projects");
    await fs.mkdir(path.join(claudeProjectsDir, "sample"), { recursive: true });

    const claudeReads = await countReaddir(
      () => cmdSync(["--auto", "--background", "--from-notify", "--source=claude"]),
      (target) => target === claudeProjectsDir || target.startsWith(`${claudeProjectsDir}${path.sep}`),
    );

    assert.equal(claudeReads, 0);
    await assert.rejects(readQueue(home), { code: "ENOENT" });
  });
});

test("background auto sync avoids broad provider traversal", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1002-7000-8000-aaaaaaaaaaaa", 22);
    const broadRoots = [
      path.join(home, ".claude"),
      path.join(home, ".gemini"),
      path.join(home, ".opencode"),
      path.join(home, ".local", "share", "mimocode"),
      path.join(home, ".workbuddy"),
    ];
    await Promise.all(broadRoots.map((root) => fs.mkdir(root, { recursive: true })));

    const broadReads = await countReaddir(
      () => cmdSync(["--auto", "--background"]),
      (target) => broadRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`)),
    );

    assert.equal(broadReads, 0);
    const queue = await readQueue(home);
    assert.match(queue, /"total_tokens":22/);
  });
});

test("all-local background sync includes Claude while preserving lightweight behavior", async () => {
  await withTempSyncEnv(async (home) => {
    await writeClaudeSession(home, "2026-06-30", "session-all-local", 53);

    await cmdSync(["--auto", "--background", "--all-local-sources"]);

    const queue = await readQueue(home);
    assert.match(queue, /"source":"claude"/);
    assert.match(queue, /"total_tokens":53/);
    await assert.rejects(
      fs.stat(path.join(home, ".tokentracker", "tracker", "queue.state.json")),
      { code: "ENOENT" },
    );
  });
});

test("all-local background sync includes Reasonix telemetry", async () => {
  await withTempSyncEnv(async (home) => {
    await writeReasonixTelemetry(home, "reasonix-all-local");

    await cmdSync(["--auto", "--background", "--all-local-sources"]);

    const firstQueue = await readQueue(home);
    const [row] = firstQueue.trim().split("\n").map(JSON.parse);
    assert.equal(row.source, "reasonix");
    assert.equal(row.model, "deepseek-reasoner");
    assert.equal(row.input_tokens, 16);
    assert.equal(row.cached_input_tokens, 40);
    assert.equal(row.cache_creation_input_tokens, 5);
    assert.equal(row.output_tokens, 5);
    assert.equal(row.reasoning_output_tokens, 4);
    assert.equal(row.total_tokens, 70);

    await cmdSync(["--auto", "--background", "--all-local-sources"]);
    assert.equal(await readQueue(home), firstQueue);
  });
});

test("all-local background sync refreshes Cursor while default background stays offline", async () => {
  await withTempSyncEnv(async (home) => {
    let fetchCalls = 0;
    const csvText = `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-06-30T10:15:00.000Z","Included","composer-2-fast","No","120","100","30","40","190","0.01"`;
    const context = {
      cursorSyncDeps: {
        isInstalled: () => true,
        extractAuth: () => ({ cookie: "WorkosCursorSessionToken=test", userId: "user_test" }),
        fetchUsageCsv: async () => {
          fetchCalls += 1;
          return csvText;
        },
      },
    };

    await cmdSync(["--auto", "--background"], context);
    assert.equal(fetchCalls, 0, "ordinary background sync must remain local-only");

    await cmdSync(["--auto", "--background", "--all-local-sources"], context);
    assert.equal(fetchCalls, 1, "explicit all-local background sync must honor Cursor");
    const firstQueue = await readQueue(home);
    assert.match(firstQueue, /"source":"cursor"/);
    assert.match(firstQueue, /"model":"composer-2-fast"/);

    await cmdSync(["--auto", "--background", "--all-local-sources"], context);
    assert.equal(fetchCalls, 2);
    assert.equal(await readQueue(home), firstQueue, "the repeated full-history CSV is idempotent");
  });
});

test("default background auto sync includes Reasonix telemetry", async () => {
  await withTempSyncEnv(async (home) => {
    await writeReasonixTelemetry(home, "reasonix-default-background");

    await cmdSync(["--auto", "--background"]);

    const queue = await readQueue(home);
    assert.match(queue, /"source":"reasonix"/);
    assert.match(queue, /"model":"deepseek-reasoner"/);
  });
});

test("background auto sync skips full-source migration and backfill work", async () => {
  await withTempSyncEnv(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const queueStatePath = path.join(trackerDir, "queue.state.json");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      cursorsPath,
      JSON.stringify({
        version: 1,
        files: {},
        hourly: {
          buckets: {
            "codex|gpt-5.5|2026-06-30T00:00:00.000Z": {
              totals: { total_tokens: 99 },
            },
          },
          groupQueued: {
            "codex|2026-06-30T00:00:00.000Z": "old",
          },
        },
        migrations: {},
      }),
      "utf8",
    );
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 123 }), "utf8");

    await cmdSync(["--auto", "--background"]);

    const cursors = await readCursors(home);
    assert.equal(cursors.migrations.rolloutCumulativeDeltaReparse_2026_05, undefined);
    assert.equal(cursors.migrations.cloudConversationsBackfill_2026_06, undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(queueStatePath, "utf8")), { offset: 123 });
    await assert.rejects(readQueue(home), { code: "ENOENT" });
  });
});

test("background auto sync does not upload with cloud credentials", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1003-7000-8000-aaaaaaaaaaaa", 24);
    process.env.TOKENTRACKER_DEVICE_TOKEN = "test-device-token";
    process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://example.invalid";
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error("background sync should not upload");
    };

    try {
      await cmdSync(["--auto", "--background"]);
    } finally {
      global.fetch = originalFetch;
    }

    assert.equal(fetchCalls, 0);
    assert.equal(await fs.stat(path.join(home, ".tokentracker", "tracker", "queue.state.json")).catch(() => null), null);
  });
});

test("explicit account publication uploads after bounded background parsing", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1007-7000-8000-aaaaaaaaaaaa", 64);
    process.env.TOKENTRACKER_DEVICE_TOKEN = "test-device-token";
    process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";
    const originalFetch = global.fetch;
    let ingestCalls = 0;
    let ingestHeaders = null;
    global.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/functions/tokentracker-ingest")) {
        ingestCalls += 1;
        ingestHeaders = options.headers;
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => JSON.stringify({ inserted: 1, skipped: 0 }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    try {
      await cmdSync(["--auto", "--background", "--publish-account"]);
    } finally {
      global.fetch = originalFetch;
    }

    assert.equal(ingestCalls, 1);
    assert.equal(ingestHeaders.apikey, DEFAULT_ANON_KEY);
    const queueState = JSON.parse(
      await fs.readFile(path.join(home, ".tokentracker", "tracker", "queue.state.json"), "utf8"),
    );
    assert.ok(queueState.offset > 0);
  });
});

test("background account publication respects persisted upload failure backoff", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1008-7000-8000-aaaaaaaaaaaa", 65);
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      path.join(trackerDir, "upload.throttle.json"),
      JSON.stringify({
        version: 1,
        nextAllowedAtMs: Date.now() + 60_000,
        backoffUntilMs: Date.now() + 60_000,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(trackerDir, "auto.retry.json"),
      JSON.stringify({ version: 1, retryAtMs: Date.now() + 60_000 }),
      "utf8",
    );
    process.env.TOKENTRACKER_DEVICE_TOKEN = "test-device-token";
    process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";
    const originalFetch = global.fetch;
    let ingestCalls = 0;
    global.fetch = async (url) => {
      if (String(url).endsWith("/functions/tokentracker-ingest")) ingestCalls += 1;
      throw new Error(`unexpected fetch ${url}`);
    };

    try {
      await cmdSync(["--auto", "--background", "--publish-account"]);
    } finally {
      global.fetch = originalFetch;
    }

    assert.equal(ingestCalls, 0);
    assert.equal(
      await fs.stat(path.join(trackerDir, "queue.state.json")).catch(() => null),
      null,
    );
    assert.equal(
      await fs.stat(path.join(trackerDir, "auto.retry.json")).catch(() => null),
      null,
    );
  });
});

test("bounded native publication leaves backlog for the next native tick without spawning full retry", async () => {
  await withTempSyncEnv(async (home) => {
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const queuePath = path.join(trackerDir, "queue.jsonl");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      path.join(trackerDir, "auto.retry.json"),
      JSON.stringify({ version: 1, retryAtMs: Date.now() + 60_000 }),
      "utf8",
    );
    const rows = Array.from({ length: 1_001 }, (_, index) => ({
      source: "codex",
      model: `benchmark-model-${index}`,
      hour_start: "2026-06-30T00:00:00.000Z",
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1,
      billable_total_tokens: 1,
      conversation_count: 1,
    }));
    await fs.writeFile(queuePath, `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");
    process.env.TOKENTRACKER_DEVICE_TOKEN = "test-device-token";
    process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://cloud.example";
    const originalFetch = global.fetch;
    let ingestCalls = 0;
    global.fetch = async (url) => {
      if (String(url).endsWith("/functions/tokentracker-ingest")) {
        ingestCalls += 1;
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => JSON.stringify({ inserted: 200, skipped: 0 }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    try {
      await cmdSync(["--auto", "--background", "--publish-account"]);
    } finally {
      global.fetch = originalFetch;
    }

    const queueState = JSON.parse(
      await fs.readFile(path.join(trackerDir, "queue.state.json"), "utf8"),
    );
    assert.equal(ingestCalls, 5);
    assert.ok(queueState.offset < (await fs.stat(queuePath)).size);
    assert.equal(
      await fs.stat(path.join(trackerDir, "auto.retry.json")).catch(() => null),
      null,
    );
  });
});

test("lightweight flag aliases bounded background sync", async () => {
  await withTempSyncEnv(async (home) => {
    const codexHome = process.env.CODEX_HOME;
    await writeCodexRollout(codexHome, "2026-06-30", "019f16bd-1004-7000-8000-aaaaaaaaaaaa", 36);
    await writeArchivedCodexRollout(codexHome, "2026-06-30", "019f16bd-1005-7000-8000-aaaaaaaaaaaa", 58);

    await cmdSync(["--auto", "--lightweight"]);

    const queue = await readQueue(home);
    assert.match(queue, /"total_tokens":36/);
    assert.doesNotMatch(queue, /"total_tokens":58/);
  });
});
