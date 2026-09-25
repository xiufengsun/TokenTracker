"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const T0 = "2026-05-01T12:00:00.000Z";
const TOTALS = {
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
const ROW = {
  source: "command-code", model: "deepseek-v4.1-flash", hour_start: T0, ...TOTALS,
};
const PROJECT_ROW = {
  project_key: "acme/synthetic-commandcode-sync",
  project_ref: "https://github.com/acme/synthetic-commandcode-sync",
  source: "command-code", hour_start: T0, ...TOTALS,
};

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

async function withCommandCodeHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-sync-"));
  const previousEnv = process.env;
  const previousHome = os.homedir;
  const previousFetch = globalThis.fetch;
  const commandCodeHome = path.join(home, ".commandcode");
  const projectDir = path.join(commandCodeHome, "projects", "synthetic");
  const filePath = path.join(projectDir, "session-one.jsonl");
  const repoDir = path.join(home, "synthetic-repository");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(repoDir);
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: "session", version: 3, id: "session-one", timestamp: T0, cwd: repoDir }),
    JSON.stringify({
      type: "message", id: "record-one", timestamp: T0,
      model: "deepseek/deepseek-v4.1-flash", message: null,
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.42 },
    }),
  ].join("\n") + "\n");
  // Do not inherit any provider override, credential, proxy or real user home.
  process.env = {
    PATH: previousEnv.PATH || "",
    SystemRoot: previousEnv.SystemRoot || "C:\\Windows",
    HOME: home, USERPROFILE: home, TEMP: home, TMP: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    TOKENTRACKER_COMMANDCODE_HOME: commandCodeHome,
    TOKENTRACKER_WSL_MODE: "native-only",
    TOKENTRACKER_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  };
  os.homedir = () => home;
  globalThis.fetch = async () => assert.fail("Command Code lifecycle tests must stay offline");
  try {
    const { cmdSync } = require("../src/commands/sync");
    const { openCursorStore } = require("../src/lib/cursor-store");
    const sync = async () => {
      const diagnostics = {};
      await cmdSync([
        "--auto", "--from-notify", "--source", "command-code",
        "--background", "--all-local-sources",
      ], { diagnostics, cursorStoreOptions: { forceV2: true } });
      return diagnostics;
    };
    const readCursors = async () => {
      const store = await openCursorStore({
        trackerDir,
        cursorsPath: path.join(trackerDir, "cursors.json"),
        codexRoots: [path.join(home, ".codex")],
        forceV2: true,
      });
      assert.equal(store.mode, "v2");
      return store.cursors;
    };
    await run({
      home, commandCodeHome, projectDir, filePath, repoDir, trackerDir,
      queuePath, projectQueuePath, sync, readCursors,
    });
  } finally {
    process.env = previousEnv;
    os.homedir = previousHome;
    globalThis.fetch = previousFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("cmdSync reconciles the last Command Code transcript's deletion and persists zero on restart", async () => {
  await withCommandCodeHome(async ({ filePath, queuePath, sync, readCursors }) => {
    const initial = await sync();
    assert.equal(initial.cursor_commits, 1);
    assert.deepEqual(readRows(queuePath), [ROW]);
    fs.unlinkSync(filePath);
    const deletion = await sync();
    const zero = Object.fromEntries(Object.keys(TOTALS).map((key) => [key, 0]));
    assert.deepEqual(readRows(queuePath), [ROW, { ...ROW, ...zero }]);
    assert.equal(deletion.cursor_commits, 1);
    assert.deepEqual((await readCursors()).commandCode.messages, {});

    const coreBefore = fs.readFileSync(deletion.cursor_path);
    const repeat = await sync();
    assert.deepEqual(readRows(queuePath), [ROW, { ...ROW, ...zero }]);
    assert.equal(repeat.cursor_commits, 0);
    assert.deepEqual(fs.readFileSync(repeat.cursor_path), coreBefore);
  });
});

test("cmdSync persists a Command Code project-only update despite the v2 no-op optimization", async () => {
  await withCommandCodeHome(async ({ filePath, repoDir, queuePath, projectQueuePath, sync, readCursors }) => {
    await sync();
    assert.deepEqual(readRows(queuePath), [ROW]);
    assert.deepEqual(readRows(projectQueuePath), []);
    const transcriptStat = fs.statSync(filePath);
    const hourlyBytes = fs.readFileSync(queuePath);
    fs.mkdirSync(path.join(repoDir, ".git"));
    fs.writeFileSync(path.join(repoDir, ".git", "config"),
      `[remote "origin"]\n\turl = ${PROJECT_ROW.project_ref}.git\n`);

    const refreshed = await sync();
    assert.deepEqual(readRows(projectQueuePath), [PROJECT_ROW]);
    assert.deepEqual(fs.readFileSync(queuePath), hourlyBytes);
    assert.equal(refreshed.cursor_commits, 1, "project-only writes must publish the associated ledger");
    assert.equal((await readCursors()).commandCode.messages["command-code:session-one|record-one"].projectKey,
      PROJECT_ROW.project_key);
    const currentStat = fs.statSync(filePath);
    assert.equal(currentStat.size, transcriptStat.size);
    assert.equal(currentStat.mtimeMs, transcriptStat.mtimeMs);
    const coreBefore = fs.readFileSync(refreshed.cursor_path);

    // Each cmdSync opens a fresh cursor store, exercising the restart boundary.
    const repeat = await sync();
    assert.equal(repeat.cursor_commits, 0);
    assert.deepEqual(fs.readFileSync(repeat.cursor_path), coreBefore);
    assert.deepEqual(fs.readFileSync(queuePath), hourlyBytes);
    assert.deepEqual(readRows(projectQueuePath), [PROJECT_ROW]);
  });
});

for (const [level, code] of [["root", "EACCES"], ["project", "EPERM"]]) {
  test(`cmdSync preserves Command Code state on a ${level} discovery ${code}, then recovers`, async () => {
    await withCommandCodeHome(async ({ commandCodeHome, projectDir, filePath, queuePath, sync, readCursors }) => {
      const first = await sync();
      const cursorsBefore = await readCursors();
      const queueBefore = fs.readFileSync(queuePath);
      const coreBefore = fs.readFileSync(first.cursor_path);
      const originalReadDir = fsp.readdir;
      const failedPath = level === "root" ? path.join(commandCodeHome, "projects") : projectDir;
      try {
        fsp.readdir = async function (file, ...args) {
          if (file === failedPath) throw Object.assign(new Error("synthetic discovery failure"), { code });
          return originalReadDir.call(this, file, ...args);
        };
        const failed = await sync();
        assert.equal(failed.cursor_commits, 0);
        assert.deepEqual(fs.readFileSync(failed.cursor_path), coreBefore);
        assert.deepEqual(fs.readFileSync(queuePath), queueBefore);
        assert.deepEqual(await readCursors(), cursorsBefore);
      } finally {
        fsp.readdir = originalReadDir;
      }

      const recovered = await sync();
      assert.equal(recovered.cursor_commits, 0);
      assert.deepEqual(readRows(queuePath), [ROW]);
      fs.unlinkSync(filePath);
      await sync();
      const zero = Object.fromEntries(Object.keys(TOTALS).map((key) => [key, 0]));
      assert.deepEqual(readRows(queuePath), [ROW, { ...ROW, ...zero }]);
    });
  });
}
