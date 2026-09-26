"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const initSqlJs = require("sql.js");

const { cmdSync } = require("../src/commands/sync");
const { cmdStatus } = require("../src/commands/status");

// Preserve only process-launch essentials. Provider-specific paths, credentials,
// and upload configuration must never leak into these integration tests.
const SYSTEM_ENV = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "SYSTEMDRIVE", "OS", "PROCESSOR_ARCHITECTURE",
]);
let sqlPromise;

async function withIsolatedTrae(t, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trae-sync-"));
  const traeHome = path.join(home, "trae-data");
  const dbPath = path.join(traeHome, "ModularData", "ai-agent", "database.db");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  const savedEnv = { ...process.env };
  let networkCalls = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    networkCalls += 1;
    throw new Error("TRAE local sync must not make network requests");
  });
  try {
    for (const key of Object.keys(process.env)) {
      if (!SYSTEM_ENV.has(key.toUpperCase()) && !key.startsWith("NODE_TEST_")) delete process.env[key];
    }
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      CODEX_HOME: path.join(home, ".codex"),
      CODE_HOME: path.join(home, ".code"),
      GEMINI_HOME: path.join(home, ".gemini"),
      OPENCODE_HOME: path.join(home, ".opencode"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      TOKENTRACKER_WSL_MODE: "native-only",
      TOKENTRACKER_TRAE_HOME: traeHome,
      TOKENTRACKER_TRAE_CN_HOME: path.join(home, "trae-cn-data"),
      TOKENTRACKER_TRAE_CN_USAGE: "0",
    });
    assert.equal(os.homedir(), home, "sync can only access the isolated home");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const cacheDir = path.join(home, ".tokentracker", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "pricing.json"), "{}");
    let revision = 0;
    const writeUsage = async (input = 100, output = 10, cached = 40, reasoning = 2) => {
      if (!sqlPromise) sqlPromise = initSqlJs();
      const SQL = await sqlPromise;
      const db = new SQL.Database();
      try {
        db.run(`CREATE TABLE chat_turn (
          id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT,
          created_at INTEGER, context TEXT
        )`);
        db.run("INSERT INTO chat_turn VALUES (?, ?, ?, ?, ?)", [
          1,
          "synthetic-session-canary",
          "synthetic-turn-canary",
          1_700_000_000,
          JSON.stringify({
            model_name: "gpt-5.2__dollar__dev",
            messages: [{ text: "synthetic-conversation-canary" }],
            token_usage: {
              prompt_tokens: input,
              completion_tokens: output,
              cache_read_input_tokens: cached,
              reasoning_tokens: reasoning,
              total_tokens: input + output,
            },
          }),
        ]);
        fs.writeFileSync(dbPath, Buffer.from(db.export()));
      } finally {
        db.close();
      }
      // Same-sized SQL updates still need a distinct fingerprint on filesystems
      // with coarse modification-time resolution.
      const stamp = new Date(1_800_000_000_000 + ++revision * 2_000);
      fs.utimesSync(dbPath, stamp, stamp);
    };
    await writeUsage();
    await run({ home, dbPath, trackerDir, writeUsage });
    assert.equal(networkCalls, 0, "local TRAE integration never calls a vendor or upload endpoint");
  } finally {
    fetchMock.mock.restore();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function readQueue(trackerDir) {
  const queuePath = path.join(trackerDir, "queue.jsonl");
  return fs.existsSync(queuePath)
    ? fs.readFileSync(queuePath, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    : [];
}

function readCursors(trackerDir) {
  const cursorsPath = path.join(trackerDir, "cursors.json");
  return fs.existsSync(cursorsPath) ? JSON.parse(fs.readFileSync(cursorsPath, "utf8")) : {};
}

function latestTrae(trackerDir) {
  return readQueue(trackerDir).filter((row) => row.source === "trae" && !row.kind).at(-1);
}

test("auto TRAE sync imports a real database once and reconciles a corrected turn", async (t) => {
  await withIsolatedTrae(t, async ({ trackerDir, writeUsage }) => {
    await cmdSync(["--auto", "--source=trae"]);
    const first = latestTrae(trackerDir);
    assert.ok(first, "source=trae invokes the local database reader");
    assert.equal(first.model, "gpt-5.2");
    assert.equal(first.hour_start, "2023-11-14T22:00:00.000Z");
    assert.equal(first.input_tokens, 60);
    assert.equal(first.cached_input_tokens, 40);
    assert.equal(first.output_tokens, 8);
    assert.equal(first.reasoning_output_tokens, 2);
    assert.equal(first.total_tokens, 110);
    assert.equal(first.conversation_count, 1);
    assert.equal(readCursors(trackerDir).trae.version, 2);

    const queuePath = path.join(trackerDir, "queue.jsonl");
    const before = fs.readFileSync(queuePath, "utf8");
    await cmdSync(["--auto", "--source=trae"]);
    assert.equal(fs.readFileSync(queuePath, "utf8"), before, "second sync does not count the same turn again");

    await writeUsage(50, 8, 20, 2);
    await cmdSync(["--auto", "--source=trae"]);
    const corrected = latestTrae(trackerDir);
    assert.equal(corrected.input_tokens, 30);
    assert.equal(corrected.cached_input_tokens, 20);
    assert.equal(corrected.output_tokens, 6);
    assert.equal(corrected.reasoning_output_tokens, 2);
    assert.equal(corrected.total_tokens, 58, "correction replaces the original contribution");
    assert.equal(corrected.conversation_count, 1);
    assert.equal(readQueue(trackerDir).filter((row) => row.source === "trae" && !row.kind).length, 2);
    const persisted = fs.readFileSync(queuePath, "utf8") + JSON.stringify(readCursors(trackerDir));
    assert.ok(!persisted.includes("synthetic-session-canary"));
    assert.ok(!persisted.includes("synthetic-turn-canary"));
    assert.ok(!persisted.includes("synthetic-conversation-canary"));
  });
});

test("other source scopes and disabled TRAE CN usage do not read the TRAE database", async (t) => {
  await withIsolatedTrae(t, async ({ dbPath, trackerDir }) => {
    const originalReadFile = fsp.readFile;
    let databaseReads = 0;
    const readMock = t.mock.method(fsp, "readFile", function (...args) {
      if (String(args[0]) === dbPath) databaseReads += 1;
      return originalReadFile.apply(this, args);
    });
    try {
      await cmdSync(["--auto", "--from-notify", "--source=codex"]);
      await cmdSync(["--auto", "--from-notify", "--source=trae-cn"]);
      assert.equal(databaseReads, 0);
      assert.equal(readCursors(trackerDir).trae, undefined);
      assert.equal(readCursors(trackerDir).traeCn, undefined);
      assert.equal(latestTrae(trackerDir), undefined);
    } finally {
      readMock.mock.restore();
    }
  });
});

test("a scoped TRAE notification does not import another installed provider", async (t) => {
  await withIsolatedTrae(t, async ({ trackerDir }) => {
    const codexDir = path.join(process.env.CODEX_HOME, "sessions", "2023", "11", "14");
    fs.mkdirSync(codexDir, { recursive: true });
    const tokens = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
    fs.writeFileSync(path.join(codexDir, "rollout-2023-11-14T22-13-20-019f16bd-1000-7000-8000-aaaaaaaaaaaa.jsonl"), JSON.stringify({
      type: "event_msg",
      timestamp: "2023-11-14T22:13:20.000Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: tokens, total_token_usage: tokens },
      },
    }) + "\n");
    await cmdSync(["--auto", "--from-notify", "--source=trae"]);
    assert.equal(latestTrae(trackerDir).total_tokens, 110);
    assert.ok(readQueue(trackerDir).every((row) => row.source === "trae"));
    await cmdSync(["--auto"]);
    assert.ok(readQueue(trackerDir).some((row) => row.source === "codex"), "the other provider is readable in a full scan");
  });
});

test("background sync keeps its narrow gate and all-local background sync includes TRAE", async (t) => {
  await withIsolatedTrae(t, async ({ trackerDir }) => {
    await cmdSync(["--auto", "--background"]);
    assert.equal(latestTrae(trackerDir), undefined);
    assert.equal(readCursors(trackerDir).trae, undefined);

    await cmdSync(["--auto", "--background", "--all-local-sources"]);
    assert.equal(latestTrae(trackerDir).total_tokens, 110);
    assert.equal(latestTrae(trackerDir).conversation_count, 1);
    assert.equal(readQueue(trackerDir).some((row) => row.source === "trae-cn"), false);
  });
});

test("auto TRAE sync reports a failed install while importing the other and retries safely", async (t) => {
  await withIsolatedTrae(t, async ({ home, dbPath, trackerDir }) => {
    const appData = process.platform === "win32"
      ? process.env.APPDATA
      : process.platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME;
    const corruptDb = path.join(appData, "Trae", "ModularData", "ai-agent", "database.db");
    const healthyDb = path.join(appData, "TRAE SOLO", "ModularData", "ai-agent", "database.db");
    fs.mkdirSync(path.dirname(corruptDb), { recursive: true });
    fs.mkdirSync(path.dirname(healthyDb), { recursive: true });
    fs.writeFileSync(corruptDb, "synthetic-corrupt-store");
    fs.copyFileSync(dbPath, healthyDb);
    delete process.env.TOKENTRACKER_TRAE_HOME;
    const warnings = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrMock = t.mock.method(process.stderr, "write", (...args) => {
      const [chunk, encoding, callback] = args;
      if (typeof chunk === "string" && chunk.startsWith("TRAE sync:")) {
        warnings.push(chunk);
        if (typeof encoding === "function") encoding();
        else if (typeof callback === "function") callback();
        return true;
      }
      return originalWrite(...args);
    });
    try {
      await cmdSync(["--auto", "--source=trae"]);
      assert.equal(latestTrae(trackerDir).total_tokens, 110);
      assert.equal(warnings.length, 1, "auto mode surfaces one actionable warning per failed store");
      assert.ok(warnings[0].includes(corruptDb));
      assert.match(warnings[0], /Will retry on the next sync/);
      const queuePath = path.join(trackerDir, "queue.jsonl");
      const before = fs.readFileSync(queuePath, "utf8");
      await cmdSync(["--auto", "--source=trae"]);
      assert.equal(warnings.length, 2, "the failed store is retried even when unchanged");
      assert.equal(fs.readFileSync(queuePath, "utf8"), before, "readable store does not double count");

      fs.copyFileSync(dbPath, corruptDb);
      await cmdSync(["--auto", "--source=trae"]);
      assert.equal(warnings.length, 2, "warning stops after the failed store recovers");
      assert.equal(fs.readFileSync(queuePath, "utf8"), before, "copied turns deduplicate after recovery");
      assert.ok(!JSON.stringify(readCursors(trackerDir)).includes(corruptDb));
    } finally {
      stderrMock.mock.restore();
    }
  });
});

test("status detects TRAE usage databases with the application key and no login storage", async (t) => {
  await withIsolatedTrae(t, async ({ dbPath }) => {
    let output = "";
    const originalWrite = process.stdout.write.bind(process.stdout);
    const stdoutMock = t.mock.method(process.stdout, "write", (...args) => {
      const [chunk, encoding, callback] = args;
      // The test runner also writes binary IPC here; preserve those frames.
      if (typeof chunk === "string" && chunk.startsWith("{")) {
        output += chunk;
        if (typeof encoding === "function") encoding();
        else if (typeof callback === "function") callback();
        return true;
      }
      return originalWrite(...args);
    });
    try {
      await cmdStatus(["--json"]);
    } finally {
      stdoutMock.mock.restore();
    }
    const status = JSON.parse(output);
    assert.equal(status.providers.trae.installed, true);
    assert.equal(status.providers.trae.usage_databases, 1);
    assert.equal(status.providers.trae.detail, dbPath);
    assert.equal(status.providers.trae.usage_key_configured, true);
    assert.equal(status.providers.trae.usage_key_source, "application");
    assert.equal(status.providers.trae.entitlement, undefined);
  });
});
