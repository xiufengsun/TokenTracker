"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  scanPiSessions,
  discoverSessionFiles,
  buildSessionAnalytics,
  listSessionsForBrowser,
  summarizeSessions,
  sessionsToCsv,
  resolveSessionSidecarPath,
  resumeCommandFor,
} = require("../src/lib/session-analytics");
const { parsePiIncremental } = require("../src/lib/rollout");

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const SESSION_ID = "019c725b-c900-7000-8000-00000000000a";
const SECRET = "private prompt, tool arguments and assistant body";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pi-sessions-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function header({ id = SESSION_ID, cwd = "/repo/pi-app", title = "Refactor collector" } = {}) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: new Date(T0).toISOString(),
    cwd,
    title,
    titleSource: "auto",
  };
}

function user(id, time = T0, text = SECRET) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(time).toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: time },
  };
}

function assistant({
  id,
  model = "claude-sonnet-4-5",
  input = 100,
  output = 20,
  cacheRead = 0,
  cacheWrite = 0,
  reasoningTokens = 0,
  totalTokens,
  time = T0 + 1000,
  tools = [],
} = {}) {
  const usage = { input, output, cacheRead, cacheWrite, reasoningTokens };
  if (typeof totalTokens === "number") usage.totalTokens = totalTokens;
  const content = [
    { type: "text", text: SECRET },
    ...tools.map((name) => ({ type: "toolCall", name, arguments: { path: SECRET } })),
  ];
  return {
    type: "message",
    id,
    parentId: "parent",
    timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant",
      provider: "anthropic",
      model,
      content,
      usage,
      timestamp: time,
    },
  };
}

function writeSession(home, fileName, records, { dirName = "--repo-pi-app--" } = {}) {
  // pi nests transcripts arbitrarily deep under sessions/<dir>/ — exercise a
  // two-level layout to prove discovery is recursive like the hourly resolver.
  const dir = path.join(home, ".pi", "agent", "sessions", dirName, "2026", "10");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, records.map(JSON.stringify).join("\n") + "\n");
  return file;
}

test("pi sessions count assistant usage once and omit bodies", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 100, output: 20, totalTokens: 120, tools: ["edit"] }),
    // Same entry id re-appended (fork rewrite): must be counted once.
    assistant({ id: "aaaaaaaa", input: 100, output: 20, totalTokens: 120 }),
    user("u2", T0 + 2000, "a different follow-up prompt"),
  ]);

  const rows = await scanPiSessions([file]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.source, "pi");
  assert.equal(row.session_id, SESSION_ID);
  assert.equal(row.total_tokens, 120);
  assert.equal(row.turns, 2);
  assert.equal(row.edit_turns, 1);
  assert.equal(row.retry_turns, 0);
  assert.equal(row.model, "claude-sonnet-4-5");
  assert.equal(row.title, "Refactor collector");
  assert.equal(row.project_ref, "/repo/pi-app");
  assert.equal(JSON.stringify(row).includes(SECRET), false);

  const browser = listSessionsForBrowser([row]).sessions[0];
  // pi opens a specific session with --session; --resume takes no argument.
  assert.equal(browser.resume_command, `pi --session ${SESSION_ID}`);
  assert.equal(resumeCommandFor("pi", SESSION_ID), `pi --session ${SESSION_ID}`);

  const exported = JSON.stringify(summarizeSessions([row])) + sessionsToCsv([row]);
  for (const value of [SECRET, SESSION_ID, "/repo/pi-app"]) {
    assert.equal(exported.includes(value), false);
  }
});

test("pi discover + sidecar build finds nested sessions under an isolated home", async (t) => {
  const home = fixture(t);
  writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "cccccccc", input: 10, output: 5, totalTokens: 15 }),
  ]);

  const discovered = await discoverSessionFiles(home, { HOME: home }, { homedir: () => home });
  assert.equal(discovered.pi.length, 1);
  assert.equal(discovered.omp.length, 0);

  const sessions = await buildSessionAnalytics({ home, force: true });
  assert.equal(sessions.some((row) => row.source === "pi" && row.session_id === SESSION_ID), true);
  assert.equal(fs.existsSync(resolveSessionSidecarPath(home)), true);
});

test("pi session totals match the hourly sync parser for the same assistant rows", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    assistant({ id: "dddddddd", input: 80, output: 40, cacheRead: 10, cacheWrite: 5, totalTokens: 135 }),
  ]);
  const row = (await scanPiSessions([file]))[0];
  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  await parsePiIncremental({
    sessionFiles: [file],
    cursors,
    queuePath,
    env: { HOME: home },
  });
  const queued = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].total_tokens, row.tokens.total_tokens);
  assert.equal(queued[0].input_tokens, row.tokens.input_tokens);
  assert.equal(queued[0].output_tokens, row.tokens.output_tokens);
  assert.equal(queued[0].cached_input_tokens, row.tokens.cached_input_tokens);
  assert.equal(queued[0].cache_creation_input_tokens, row.tokens.cache_creation_input_tokens);
});

test("a pi/omp directory collision is discovered once, as omp", async (t) => {
  const home = fixture(t);
  const shared = path.join(home, "shared-agent");
  // omp's discovery expects sessions/<cwd-dir>/*.jsonl; pi walks recursively,
  // so this layout is discoverable by both.
  const dir = path.join(shared, "sessions", "--repo-shared--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, [
    header(),
    assistant({ id: "eeeeeeee", input: 7, output: 3, totalTokens: 10 }),
  ].map(JSON.stringify).join("\n") + "\n");

  const discovered = await discoverSessionFiles(home, {
    HOME: home,
    TOKENTRACKER_PI_AGENT_DIR: shared,
    TOKENTRACKER_OMP_AGENT_DIR: shared,
  }, { homedir: () => home });
  // The overrides describe the machine's own layout, so they only apply when
  // scanning that same home — pass it via deps.homedir (fixture isolation).
  assert.equal(discovered.omp.length, 1);
  assert.equal(discovered.pi.length, 0);
});
