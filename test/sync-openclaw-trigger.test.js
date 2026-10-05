const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { cmdSync } = require("../src/commands/sync");
const { withHome } = require("./helpers/with-home");

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("sync --from-openclaw records last OpenClaw trigger marker", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-sync-openclaw-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevOpencodeHome = process.env.OPENCODE_HOME;
  const prevTraeHome = process.env.TOKENTRACKER_TRAE_HOME;
  const prevTraeDb = process.env.TOKENTRACKER_TRAE_DB;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    process.env.OPENCODE_HOME = path.join(tmp, ".opencode");
    process.env.TOKENTRACKER_TRAE_HOME = path.join(tmp, ".trae");
    delete process.env.TOKENTRACKER_TRAE_DB;

    await cmdSync(["--from-openclaw"]);

    const markerPath = path.join(tmp, ".tokentracker", "tracker", "openclaw.signal");
    const marker = (await fs.readFile(markerPath, "utf8")).trim();
    assert.ok(marker.length > 0, "expected openclaw marker to be written");
    assert.ok(!Number.isNaN(Date.parse(marker)), "expected openclaw marker to be ISO timestamp");
  } finally {
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (prevOpencodeHome === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prevOpencodeHome;
    if (prevTraeHome === undefined) delete process.env.TOKENTRACKER_TRAE_HOME;
    else process.env.TOKENTRACKER_TRAE_HOME = prevTraeHome;
    if (prevTraeDb === undefined) delete process.env.TOKENTRACKER_TRAE_DB;
    else process.env.TOKENTRACKER_TRAE_DB = prevTraeDb;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("sync keeps Grok hook signal when another sync owns the lock", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-sync-grok-lock-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevOpencodeHome = process.env.OPENCODE_HOME;
  const prevTraeHome = process.env.TOKENTRACKER_TRAE_HOME;
  const prevTraeDb = process.env.TOKENTRACKER_TRAE_DB;
  const prevTokenTrackerGrokHome = process.env.TOKENTRACKER_GROK_HOME;
  const prevGrokHome = process.env.GROK_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    process.env.OPENCODE_HOME = path.join(tmp, ".opencode");
    process.env.TOKENTRACKER_TRAE_HOME = path.join(tmp, ".trae");
    delete process.env.TOKENTRACKER_TRAE_DB;
    delete process.env.TOKENTRACKER_GROK_HOME;
    process.env.GROK_HOME = path.join(tmp, ".grok");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const signalPath = path.join(trackerDir, "grok-last-session.json");
    await fs.mkdir(path.dirname(signalPath), { recursive: true });
    await fs.writeFile(
      signalPath,
      JSON.stringify({
        source: "grok",
        sessionId: "grok-locked",
        model: "grok-build",
        totalTokens: 64,
        messageCount: 2,
        lastActive: "2026-04-05T14:10:00.000Z",
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(trackerDir, "sync.lock"), "locked\n", "utf8");

    await cmdSync(["--auto"]);

    const signal = JSON.parse(await fs.readFile(signalPath, "utf8"));
    assert.equal(signal.sessionId, "grok-locked");
  } finally {
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (prevOpencodeHome === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prevOpencodeHome;
    if (prevTraeHome === undefined) delete process.env.TOKENTRACKER_TRAE_HOME;
    else process.env.TOKENTRACKER_TRAE_HOME = prevTraeHome;
    if (prevTraeDb === undefined) delete process.env.TOKENTRACKER_TRAE_DB;
    else process.env.TOKENTRACKER_TRAE_DB = prevTraeDb;
    if (prevTokenTrackerGrokHome === undefined) delete process.env.TOKENTRACKER_GROK_HOME;
    else process.env.TOKENTRACKER_GROK_HOME = prevTokenTrackerGrokHome;
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("sync queues and consumes Grok hook signal after cursor persistence", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-sync-grok-signal-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevOpencodeHome = process.env.OPENCODE_HOME;
  const prevTraeHome = process.env.TOKENTRACKER_TRAE_HOME;
  const prevTraeDb = process.env.TOKENTRACKER_TRAE_DB;
  const prevTokenTrackerGrokHome = process.env.TOKENTRACKER_GROK_HOME;
  const prevGrokHome = process.env.GROK_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    process.env.OPENCODE_HOME = path.join(tmp, ".opencode");
    process.env.TOKENTRACKER_TRAE_HOME = path.join(tmp, ".trae");
    delete process.env.TOKENTRACKER_TRAE_DB;
    delete process.env.TOKENTRACKER_GROK_HOME;
    process.env.GROK_HOME = path.join(tmp, ".grok");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const signalPath = path.join(trackerDir, "tracker", "grok-last-session.json");
    await fs.mkdir(path.dirname(signalPath), { recursive: true });
    await fs.writeFile(
      signalPath,
      JSON.stringify({
        source: "grok",
        sessionId: "grok-session-hook",
        model: "grok-build",
        totalTokens: 99,
        contextTokensUsed: 20,
        messageCount: 3,
        lastActive: "2026-04-05T14:45:00.000Z",
      }) + "\n",
      "utf8",
    );

    await cmdSync(["--auto"]);

    const rows = await readJsonl(path.join(trackerDir, "queue.jsonl"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "grok");
    assert.equal(rows[0].hour_start, "2026-04-05T14:30:00.000Z");
    assert.equal(rows[0].total_tokens, 99);
    assert.equal(rows[0].conversation_count, 3);
    await assert.rejects(fs.stat(signalPath), /ENOENT/);

    const cursors = JSON.parse(await fs.readFile(path.join(trackerDir, "cursors.json"), "utf8"));
    assert.deepEqual(cursors.grok.seenSessions, ["grok-session-hook"]);

    const firstSnapshots = cursors.grok.sessionSnapshots;
    await cmdSync(["--auto"]);

    const rowsAfterSecondSync = await readJsonl(path.join(trackerDir, "queue.jsonl"));
    assert.equal(rowsAfterSecondSync.length, rows.length);
    await assert.rejects(fs.stat(signalPath), /ENOENT/);

    const cursorsAfterSecondSync = JSON.parse(
      await fs.readFile(path.join(trackerDir, "cursors.json"), "utf8"),
    );
    assert.deepEqual(cursorsAfterSecondSync.grok.sessionSnapshots, firstSnapshots);
  } finally {
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (prevOpencodeHome === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prevOpencodeHome;
    if (prevTraeHome === undefined) delete process.env.TOKENTRACKER_TRAE_HOME;
    else process.env.TOKENTRACKER_TRAE_HOME = prevTraeHome;
    if (prevTraeDb === undefined) delete process.env.TOKENTRACKER_TRAE_DB;
    else process.env.TOKENTRACKER_TRAE_DB = prevTraeDb;
    if (prevTokenTrackerGrokHome === undefined) delete process.env.TOKENTRACKER_GROK_HOME;
    else process.env.TOKENTRACKER_GROK_HOME = prevTokenTrackerGrokHome;
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("sync keeps malformed Grok hook signal without a session id", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-sync-grok-bad-signal-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevOpencodeHome = process.env.OPENCODE_HOME;
  const prevTraeHome = process.env.TOKENTRACKER_TRAE_HOME;
  const prevTraeDb = process.env.TOKENTRACKER_TRAE_DB;
  const prevTokenTrackerGrokHome = process.env.TOKENTRACKER_GROK_HOME;
  const prevGrokHome = process.env.GROK_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    process.env.OPENCODE_HOME = path.join(tmp, ".opencode");
    process.env.TOKENTRACKER_TRAE_HOME = path.join(tmp, ".trae");
    delete process.env.TOKENTRACKER_TRAE_DB;
    delete process.env.TOKENTRACKER_GROK_HOME;
    process.env.GROK_HOME = path.join(tmp, ".grok");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const signalPath = path.join(trackerDir, "grok-last-session.json");
    await fs.mkdir(path.dirname(signalPath), { recursive: true });
    await fs.writeFile(
      signalPath,
      JSON.stringify({
        source: "grok",
        model: "grok-build",
        totalTokens: 99,
        messageCount: 3,
        lastActive: "2026-04-05T14:45:00.000Z",
      }) + "\n",
      "utf8",
    );

    await cmdSync(["--auto"]);

    let signal = JSON.parse(await fs.readFile(signalPath, "utf8"));
    assert.equal(signal.totalTokens, 99);
    assert.deepEqual(await readJsonl(path.join(trackerDir, "queue.jsonl")), []);

    await cmdSync(["--auto"]);

    signal = JSON.parse(await fs.readFile(signalPath, "utf8"));
    assert.equal(signal.totalTokens, 99);
    assert.deepEqual(await readJsonl(path.join(trackerDir, "queue.jsonl")), []);
  } finally {
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (prevOpencodeHome === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prevOpencodeHome;
    if (prevTraeHome === undefined) delete process.env.TOKENTRACKER_TRAE_HOME;
    else process.env.TOKENTRACKER_TRAE_HOME = prevTraeHome;
    if (prevTraeDb === undefined) delete process.env.TOKENTRACKER_TRAE_DB;
    else process.env.TOKENTRACKER_TRAE_DB = prevTraeDb;
    if (prevTokenTrackerGrokHome === undefined) delete process.env.TOKENTRACKER_GROK_HOME;
    else process.env.TOKENTRACKER_GROK_HOME = prevTokenTrackerGrokHome;
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("sync --from-openclaw falls back to previous session totals when jsonl has zero usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-sync-openclaw-fallback-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevOpencodeHome = process.env.OPENCODE_HOME;
  const prevTraeHome = process.env.TOKENTRACKER_TRAE_HOME;
  const prevTraeDb = process.env.TOKENTRACKER_TRAE_DB;
  const prevAgentId = process.env.TOKENTRACKER_OPENCLAW_AGENT_ID;
  const prevSessionId = process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID;
  const prevOpenclawHome = process.env.TOKENTRACKER_OPENCLAW_HOME;
  const prevTotal = process.env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS;
  const prevInput = process.env.TOKENTRACKER_OPENCLAW_PREV_INPUT_TOKENS;
  const prevOutput = process.env.TOKENTRACKER_OPENCLAW_PREV_OUTPUT_TOKENS;
  const prevModel = process.env.TOKENTRACKER_OPENCLAW_PREV_MODEL;
  const prevUpdatedAt = process.env.TOKENTRACKER_OPENCLAW_PREV_UPDATED_AT;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    process.env.OPENCODE_HOME = path.join(tmp, ".opencode");
    process.env.TOKENTRACKER_TRAE_HOME = path.join(tmp, ".trae");
    delete process.env.TOKENTRACKER_TRAE_DB;

    const openclawHome = path.join(tmp, ".openclaw");
    const sessionDir = path.join(openclawHome, "agents", "coding", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session-a.jsonl"),
      [
        JSON.stringify({ type: "session", id: "session-a", timestamp: "2026-02-14T00:00:00.000Z" }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-02-14T00:00:01.000Z",
          message: {
            role: "assistant",
            model: "delivery-mirror",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    process.env.TOKENTRACKER_OPENCLAW_AGENT_ID = "coding";
    process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID = "session-a";
    process.env.TOKENTRACKER_OPENCLAW_HOME = openclawHome;
    process.env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS = "100";
    process.env.TOKENTRACKER_OPENCLAW_PREV_INPUT_TOKENS = "70";
    process.env.TOKENTRACKER_OPENCLAW_PREV_OUTPUT_TOKENS = "30";
    process.env.TOKENTRACKER_OPENCLAW_PREV_MODEL = "gpt-5.3-codex";
    process.env.TOKENTRACKER_OPENCLAW_PREV_UPDATED_AT = "2026-02-14T00:30:00.000Z";

    await cmdSync(["--from-openclaw"]);

    const queuePath = path.join(tmp, ".tokentracker", "tracker", "queue.jsonl");
    const firstRunRows = await readJsonl(queuePath);
    assert.ok(firstRunRows.length > 0, "expected at least one queued row");
    const firstLast = firstRunRows[firstRunRows.length - 1];
    assert.equal(firstLast.source, "openclaw");
    assert.equal(firstLast.total_tokens, 100);
    assert.equal(firstLast.input_tokens, 70);
    assert.equal(firstLast.output_tokens, 30);

    await cmdSync(["--from-openclaw"]);
    const secondRunRows = await readJsonl(queuePath);
    assert.equal(
      secondRunRows.length,
      firstRunRows.length,
      "expected no duplicate queue rows when totals do not change",
    );

    process.env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS = "140";
    process.env.TOKENTRACKER_OPENCLAW_PREV_INPUT_TOKENS = "98";
    process.env.TOKENTRACKER_OPENCLAW_PREV_OUTPUT_TOKENS = "42";
    process.env.TOKENTRACKER_OPENCLAW_PREV_UPDATED_AT = "2026-02-14T00:35:00.000Z";

    await cmdSync(["--from-openclaw"]);
    const thirdRunRows = await readJsonl(queuePath);
    assert.equal(
      thirdRunRows.length,
      firstRunRows.length + 1,
      "expected one new queued row when totals increase",
    );
    const thirdLast = thirdRunRows[thirdRunRows.length - 1];
    assert.equal(thirdLast.source, "openclaw");
    assert.equal(thirdLast.total_tokens, 140);
    assert.equal(thirdLast.input_tokens, 98);
    assert.equal(thirdLast.output_tokens, 42);
  } finally {
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (prevOpencodeHome === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prevOpencodeHome;
    if (prevTraeHome === undefined) delete process.env.TOKENTRACKER_TRAE_HOME;
    else process.env.TOKENTRACKER_TRAE_HOME = prevTraeHome;
    if (prevTraeDb === undefined) delete process.env.TOKENTRACKER_TRAE_DB;
    else process.env.TOKENTRACKER_TRAE_DB = prevTraeDb;
    if (prevAgentId === undefined) delete process.env.TOKENTRACKER_OPENCLAW_AGENT_ID;
    else process.env.TOKENTRACKER_OPENCLAW_AGENT_ID = prevAgentId;
    if (prevSessionId === undefined) delete process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID;
    else process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID = prevSessionId;
    if (prevOpenclawHome === undefined) delete process.env.TOKENTRACKER_OPENCLAW_HOME;
    else process.env.TOKENTRACKER_OPENCLAW_HOME = prevOpenclawHome;
    if (prevTotal === undefined) delete process.env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS;
    else process.env.TOKENTRACKER_OPENCLAW_PREV_TOTAL_TOKENS = prevTotal;
    if (prevInput === undefined) delete process.env.TOKENTRACKER_OPENCLAW_PREV_INPUT_TOKENS;
    else process.env.TOKENTRACKER_OPENCLAW_PREV_INPUT_TOKENS = prevInput;
    if (prevOutput === undefined) delete process.env.TOKENTRACKER_OPENCLAW_PREV_OUTPUT_TOKENS;
    else process.env.TOKENTRACKER_OPENCLAW_PREV_OUTPUT_TOKENS = prevOutput;
    if (prevModel === undefined) delete process.env.TOKENTRACKER_OPENCLAW_PREV_MODEL;
    else process.env.TOKENTRACKER_OPENCLAW_PREV_MODEL = prevModel;
    if (prevUpdatedAt === undefined) delete process.env.TOKENTRACKER_OPENCLAW_PREV_UPDATED_AT;
    else process.env.TOKENTRACKER_OPENCLAW_PREV_UPDATED_AT = prevUpdatedAt;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
