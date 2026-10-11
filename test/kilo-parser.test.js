const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
// child_process is used only for sqlite3 write fixtures; route them through
// in-process node:sqlite (see helpers/sqlite-write) to avoid per-statement spawns.
const { sqliteOnlyCp: cp } = require("./helpers/sqlite-write");
const { test } = require("node:test");

const {
  parseOpencodeDbIncremental,
  readOpencodeDbMessages,
  parseKilocodeIncremental,
  normalizeKilocodeProviderToModel,
  resolveKilocodeRoots,
  resolveKilocodeTaskFiles,
} = require("../src/lib/rollout");

// ─────────────────────────────────────────────────────────────────────────────
// Kilo CLI — kilo.ai @kilocode/plugin (OpenCode-fork SQLite)
// ─────────────────────────────────────────────────────────────────────────────

function buildKiloDb(dbPath, rows) {
  const schema = `
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `;
  cp.execFileSync("sqlite3", [dbPath, schema], { encoding: "utf8" });
  for (const row of rows) {
    const dataJson = JSON.stringify(row.data).replace(/'/g, "''");
    const sql = `INSERT INTO message VALUES('${row.id}','${row.session_id}',${row.time_created},${row.time_updated},'${dataJson}');`;
    cp.execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  }
}

test("Kilo CLI: parseOpencodeDbIncremental with cursorKey='kiloCli' isolates messages from OpenCode index", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kilo-cli-"));
  try {
    const dbPath = path.join(tmp, "kilo.db");
    const ts = 1778568000000; // some real-ish ms
    buildKiloDb(dbPath, [
      {
        id: "msg_kilo_001",
        session_id: "sess_kilo_a",
        time_created: ts,
        time_updated: ts + 1,
        data: {
          id: "msg_kilo_001",
          sessionID: "sess_kilo_a",
          role: "assistant",
          modelID: "inclusionai/ring-2.6-1t:free",
          providerID: "kilo",
          tokens: {
            input: 1000,
            output: 50,
            reasoning: 10,
            cache: { read: 200, write: 0 },
            total: 1260,
          },
          time: { created: ts, completed: ts + 100 },
          path: { cwd: "/tmp/proj", root: "/tmp/proj" },
        },
      },
      {
        id: "msg_kilo_002",
        session_id: "sess_kilo_a",
        time_created: ts + 1000,
        time_updated: ts + 1001,
        data: {
          id: "msg_kilo_002",
          sessionID: "sess_kilo_a",
          role: "assistant",
          modelID: "kilo-auto/free",
          providerID: "kilo",
          tokens: {
            input: 500,
            output: 25,
            reasoning: 0,
            cache: { read: 100, write: 0 },
            total: 625,
          },
          time: { created: ts + 1000, completed: ts + 1100 },
          path: { cwd: "/tmp/proj", root: "/tmp/proj" },
        },
      },
    ]);

    const dbMessages = readOpencodeDbMessages(dbPath);
    assert.equal(dbMessages.length, 2);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1 };

    // Pre-seed opencode cursor state with the SAME message ids to prove
    // the kilo cursor namespace is isolated (without isolation, kilo
    // would dedup against opencode and skip these rows).
    cursors.opencode = {
      messages: {
        "sess_kilo_a|msg_kilo_001": {
          lastTotals: {
            input_tokens: 1000,
            cached_input_tokens: 200,
            cache_creation_input_tokens: 0,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            total_tokens: 1260,
          },
          updatedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    };

    const result = await parseOpencodeDbIncremental({
      dbMessages,
      cursors,
      queuePath,
      source: "kilo-cli",
      cursorKey: "kiloCli",
    });

    // Both messages must be queued — kilo cursor index started empty,
    // so the opencode pre-seed must NOT block dedup.
    assert.equal(result.eventsAggregated, 2);
    assert.ok(result.bucketsQueued > 0);

    // Kilo state was persisted in cursors.kiloCli, not cursors.opencode.
    assert.ok(cursors.kiloCli);
    assert.ok(cursors.kiloCli.messages["sess_kilo_a|msg_kilo_001"]);
    assert.ok(cursors.kiloCli.messages["sess_kilo_a|msg_kilo_002"]);

    // Opencode cursor still has its pre-seeded entry intact.
    assert.ok(cursors.opencode.messages["sess_kilo_a|msg_kilo_001"]);

    // Re-running yields zero new events (now keys are in kilo index).
    const result2 = await parseOpencodeDbIncremental({
      dbMessages,
      cursors,
      queuePath,
      source: "kilo-cli",
      cursorKey: "kiloCli",
    });
    assert.equal(result2.eventsAggregated, 0);

    // Queue rows tagged source=kilo-cli with the right model ids.
    const queueLines = (await fs.readFile(queuePath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const sources = new Set(queueLines.map((r) => r.source));
    const models = new Set(queueLines.map((r) => r.model));
    assert.deepEqual([...sources].sort(), ["kilo-cli"]);
    assert.ok(models.has("inclusionai/ring-2.6-1t:free"));
    assert.ok(models.has("kilo-auto/free"));

    // Token math matches normalizer: total = input + output + reasoning + cache.read + cache.write
    const totalAll = queueLines.reduce((acc, r) => acc + (r.total_tokens || 0), 0);
    assert.equal(totalAll, 1260 + 625);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Kilo Code VS Code extension — passive ui_messages.json scan
// ─────────────────────────────────────────────────────────────────────────────

async function makeKilocodeTask(rootDir, ide, taskUuid, messages) {
  const tasksDir = path.join(
    rootDir,
    ide,
    "User",
    "globalStorage",
    "kilocode.kilo-code",
    "tasks",
    taskUuid,
  );
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(
    path.join(tasksDir, "ui_messages.json"),
    JSON.stringify(messages),
  );
  return path.join(tasksDir, "ui_messages.json");
}

test("Kilo Code: parseKilocodeIncremental aggregates api_req_started + api_req_deleted, skips other says, dedups by (taskUuid, ts)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kilo-code-"));
  try {
    const taskUuid = "019c0242-5d2c-722d-ba0e-0164225df808";
    const baseTs = 1769564400000;
    const filePath = await makeKilocodeTask(tmp, "Cursor", taskUuid, [
      { ts: baseTs + 1, type: "say", say: "text", text: "ignored — not an api event" },
      {
        ts: baseTs + 2,
        type: "say",
        say: "api_req_started",
        text: JSON.stringify({
          apiProtocol: "openai",
          tokensIn: 1000,
          tokensOut: 50,
          cacheReads: 200,
          cacheWrites: 0,
          cost: 0,
          inferenceProvider: "minimax",
        }),
      },
      // api_req_deleted carries the same payload — user removed the turn but
      // the API call already happened, so we must still count it.
      {
        ts: baseTs + 3,
        type: "say",
        say: "api_req_deleted",
        text: JSON.stringify({
          tokensIn: 500,
          tokensOut: 25,
          cacheReads: 100,
          cacheWrites: 0,
          cost: 0,
          // no inferenceProvider — must bucket under provider:unknown
        }),
      },
      // All-zero payload — must not contribute.
      {
        ts: baseTs + 4,
        type: "say",
        say: "api_req_started",
        text: JSON.stringify({
          tokensIn: 0, tokensOut: 0, cacheReads: 0, cacheWrites: 0, inferenceProvider: "minimax",
        }),
      },
    ]);

    const cursors = { version: 1 };
    const queuePath = path.join(tmp, "queue.jsonl");

    const result = await parseKilocodeIncremental({
      taskFiles: [{ filePath, taskUuid, ide: "Cursor" }],
      cursors,
      queuePath,
    });

    assert.equal(result.eventsAggregated, 2);
    assert.equal(result.recordsProcessed, 3); // 2 counted + 1 all-zero (skipped before count++)
    assert.ok(result.bucketsQueued > 0);

    const queueLines = (await fs.readFile(queuePath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const sources = new Set(queueLines.map((r) => r.source));
    assert.deepEqual([...sources], ["kilo-code"]);

    const models = new Map();
    let totalAll = 0;
    for (const r of queueLines) {
      models.set(r.model, (models.get(r.model) || 0) + r.total_tokens);
      totalAll += r.total_tokens;
    }
    assert.ok(models.has("provider:minimax"));
    assert.ok(models.has("provider:unknown"));
    // 1000+50+200 + 500+25+100 = 1875
    assert.equal(totalAll, 1875);

    // Cursor state persisted; per-task ts dedup keys present.
    assert.ok(Array.isArray(cursors.kilocode.seenIds));
    assert.ok(cursors.kilocode.seenIds.includes(`${taskUuid}:${baseTs + 2}`));
    assert.ok(cursors.kilocode.seenIds.includes(`${taskUuid}:${baseTs + 3}`));

    // Second run with the same file (mtime/size unchanged) returns zero —
    // mtime cache short-circuits the read.
    const result2 = await parseKilocodeIncremental({
      taskFiles: [{ filePath, taskUuid, ide: "Cursor" }],
      cursors,
      queuePath,
    });
    assert.equal(result2.eventsAggregated, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Kilo Code: tokens back-filled into an api_req_started placeholder are counted (in-flight race)", async () => {
  // Same Cline-family in-place back-fill behavior as Roo Code — see
  // test/roocode-parser.test.js. The zero placeholder must NOT be marked
  // seen, or the back-filled tokens are dropped forever.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kilo-backfill-"));
  try {
    const taskUuid = "019c0242-5d2c-722d-ba0e-0164225df809";
    const ts = 1769564400000;
    const placeholder = {
      ts,
      type: "say",
      say: "api_req_started",
      text: JSON.stringify({ request: "..." }),
    };
    const filePath = await makeKilocodeTask(tmp, "Cursor", taskUuid, [placeholder]);
    const cursors = { version: 1 };
    const queuePath = path.join(tmp, "queue.jsonl");

    const r1 = await parseKilocodeIncremental({
      taskFiles: [{ filePath, taskUuid, ide: "Cursor" }],
      cursors,
      queuePath,
    });
    assert.equal(r1.eventsAggregated, 0, "in-flight placeholder must not aggregate");

    // Completion: same ts, real tokens written in place.
    await fs.writeFile(
      filePath,
      JSON.stringify([
        {
          ...placeholder,
          text: JSON.stringify({
            apiProtocol: "openai",
            tokensIn: 900,
            tokensOut: 100,
            cacheReads: 0,
            cacheWrites: 0,
            inferenceProvider: "minimax",
          }),
        },
      ]),
    );

    const r2 = await parseKilocodeIncremental({
      taskFiles: [{ filePath, taskUuid, ide: "Cursor" }],
      cursors,
      queuePath,
    });
    assert.equal(r2.eventsAggregated, 1, "back-filled tokens must be counted");

    const r3 = await parseKilocodeIncremental({
      taskFiles: [{ filePath, taskUuid, ide: "Cursor" }],
      cursors,
      queuePath,
    });
    assert.equal(r3.eventsAggregated, 0, "no double count after back-fill");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Kilo Code: normalizeKilocodeProviderToModel sanitizes vendor names and falls back to provider:unknown", () => {
  assert.equal(normalizeKilocodeProviderToModel("Moonshot AI"), "provider:moonshot-ai");
  assert.equal(normalizeKilocodeProviderToModel("minimax"), "provider:minimax");
  assert.equal(normalizeKilocodeProviderToModel("Stealth"), "provider:stealth");
  assert.equal(normalizeKilocodeProviderToModel(""), "provider:unknown");
  assert.equal(normalizeKilocodeProviderToModel(null), "provider:unknown");
  assert.equal(normalizeKilocodeProviderToModel("  /// ###"), "provider:unknown");
});

test("Kilo Code: resolveKilocodeRoots honors TOKENTRACKER_KILOCODE_ROOTS env override", () => {
  const env = { TOKENTRACKER_KILOCODE_ROOTS: ["/tmp/fake-ide", "/tmp/other-ide"].join(path.delimiter) };
  const roots = resolveKilocodeRoots(env);
  assert.deepEqual(roots, ["/tmp/fake-ide", "/tmp/other-ide"]);
});

test("Kilo Code: resolveKilocodeTaskFiles walks tasks/ under all IDE roots", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kilo-code-multi-"));
  try {
    await makeKilocodeTask(tmp, "Cursor", "uuid-cursor-1", [
      { ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1, tokensOut: 1 }) },
    ]);
    await makeKilocodeTask(tmp, "Code", "uuid-vscode-1", [
      { ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1, tokensOut: 1 }) },
    ]);
    const env = {
      TOKENTRACKER_KILOCODE_ROOTS: [path.join(tmp, "Cursor"), path.join(tmp, "Code")].join(path.delimiter),
    };
    const taskFiles = resolveKilocodeTaskFiles(env);
    assert.equal(taskFiles.length, 2);
    const ides = new Set(taskFiles.map((t) => t.ide));
    assert.ok(ides.has("Cursor"));
    assert.ok(ides.has("Code"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
