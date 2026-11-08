"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  scanPiSession,
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
const SESSION_ID = "01a1bc31-0000-7000-8000-000000000001";
const SECRET = "private prompt, tool arguments and assistant body";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pi-sessions-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// pi's v3 header carries no title; cwd is the only project signal.
function header({ id = SESSION_ID, cwd = "/repo/pi-app", parentSession } = {}) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: new Date(T0).toISOString(),
    cwd,
    ...(parentSession ? { parentSession } : {}),
  };
}

function user(id, time = T0, content = SECRET) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(time).toISOString(),
    message: { role: "user", content: [{ type: "text", text: content }], timestamp: time },
  };
}

// pi reports usage with `reasoning` (a subset of `output`) and `totalTokens`
// that already folds it in, which is what the hourly reader sums on.
function assistant({
  id,
  model = "claude-sonnet-4-5",
  provider = "anthropic",
  input = 100,
  output = 20,
  cacheRead = 0,
  cacheWrite = 0,
  totalTokens,
  time = T0 + 1000,
  tools = [],
} = {}) {
  const usage = { input, output, cacheRead, cacheWrite, reasoning: 0, cost: 0 };
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
      provider,
      model,
      content,
      usage,
      timestamp: time,
    },
  };
}

function writeSession(home, fileName, records, { nested = [], cwdDir = "--repo-pi-app--" } = {}) {
  const dir = path.join(home, ".pi", "agent", "sessions", cwdDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, records.map(JSON.stringify).join("\n") + "\n");
  for (const child of nested) {
    // pi-subagents forks transcripts to <stem>/<hash>/run-N/session.jsonl.
    const childPath = path.join(file.replace(/\.jsonl$/i, ""), child.name);
    fs.mkdirSync(path.dirname(childPath), { recursive: true });
    fs.writeFileSync(childPath, child.records.map(JSON.stringify).join("\n") + "\n");
  }
  return file;
}

test("pi sessions count assistant usage once, fold nested subagents, and omit bodies", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({
      id: "aaaaaaaa",
      input: 100,
      output: 20,
      totalTokens: 120,
      tools: ["edit", "task"],
    }),
    // The same entry id replayed (tree re-write) must not count twice.
    assistant({ id: "aaaaaaaa", input: 100, output: 20, totalTokens: 120 }),
  ], {
    nested: [{
      name: "deadbeef/run-1/session.jsonl",
      records: [
        header({ id: "child-session", cwd: "/repo/pi-app" }),
        assistant({ id: "bbbbbbbb", input: 40, output: 10, totalTokens: 50, time: T0 + 5000 }),
      ],
    }],
  });

  const row = await scanPiSession(file);
  assert.ok(row);
  assert.equal(row.source, "pi");
  assert.equal(row.session_id, SESSION_ID);
  assert.equal(row.total_tokens, 170);
  assert.equal(row.turns, 1);
  assert.equal(row.edit_turns, 1);
  assert.equal(row.subagent_calls >= 1, true);
  assert.equal(row.model, "claude-sonnet-4-5");
  assert.equal(row.title, null);
  assert.equal(row.project_ref, "/repo/pi-app");
  assert.equal(JSON.stringify(row).includes(SECRET), false);

  const browser = listSessionsForBrowser([row]).sessions[0];
  assert.equal(browser.resume_command, `pi --session ${SESSION_ID}`);
  assert.equal(resumeCommandFor("pi", SESSION_ID), `pi --session ${SESSION_ID}`);

  const exported = JSON.stringify(summarizeSessions([row])) + sessionsToCsv([row]);
  for (const value of [SECRET, SESSION_ID, "/repo/pi-app"]) {
    assert.equal(exported.includes(value), false);
  }
});

test("pi discover + sidecar build finds sessions under an isolated home", async (t) => {
  const home = fixture(t);
  writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "cccccccc", input: 10, output: 5, totalTokens: 15 }),
  ]);

  const discovered = await discoverSessionFiles(home, { HOME: home }, { homedir: () => home });
  assert.equal(discovered.pi.length, 1);

  const sessions = await buildSessionAnalytics({ home, force: true });
  assert.equal(sessions.some((row) => row.source === "pi" && row.session_id === SESSION_ID), true);
  assert.equal(fs.existsSync(resolveSessionSidecarPath(home)), true);
});

test("pi session totals match the hourly sync parser for the same assistant rows", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    assistant({ id: "dddddddd", input: 80, output: 40, cacheRead: 10, cacheWrite: 5, totalTokens: 135 }),
  ]);
  const row = await scanPiSession(file);
  const queuePath = path.join(home, "queue.jsonl");
  await parsePiIncremental({
    sessionFiles: [file],
    cursors: {},
    queuePath,
    env: { HOME: home, TOKENTRACKER_PI_AGENT_DIR: path.join(home, ".pi", "agent") },
  });
  const queued = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].total_tokens, row.total_tokens);
  assert.equal(queued[0].input_tokens, row.tokens.input_tokens);
  assert.equal(queued[0].output_tokens, row.tokens.output_tokens);
  assert.equal(queued[0].cached_input_tokens, row.tokens.cached_input_tokens);
  assert.equal(queued[0].cache_creation_input_tokens, row.tokens.cache_creation_input_tokens);
});

test("pi usage keeps one model per routed backend out of the same model row", async (t) => {
  // pi is a router: the same model id reached through two providers is priced
  // differently, but the Sessions row keys by model like every other source.
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    assistant({ id: "e1", provider: "anthropic", input: 10, output: 5, totalTokens: 15 }),
    assistant({ id: "e2", provider: "github-copilot", input: 20, output: 10, totalTokens: 30, time: T0 + 2000 }),
  ]);
  const row = await scanPiSession(file);
  assert.equal(row.total_tokens, 45);
  assert.equal(row.model_usage.length, 1);
  assert.equal(row.model_usage[0].model, "claude-sonnet-4-5");
});

test("resumeCommandFor rejects unsafe pi session ids", () => {
  assert.equal(resumeCommandFor("pi", "abc; rm -rf /"), null);
  assert.equal(resumeCommandFor("pi", "../escape"), null);
  assert.equal(resumeCommandFor("pi", SESSION_ID), `pi --session ${SESSION_ID}`);
});

test("pi fork copies that reuse entry ids count tokens once across Sessions", async (t) => {
  const home = fixture(t);
  const parentRecords = [
    header({ id: SESSION_ID }),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 100, output: 20, totalTokens: 120 }),
  ];
  const forkId = "01a1bc31-0000-7000-8000-000000000002";
  const parentFile = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, parentRecords);
  writeSession(home, `2026-10-10T13-00-00-000Z_${forkId}.jsonl`, [
    // pi --fork replays the parent transcript, then adds new work.
    ...parentRecords.slice(1),
    user("u2", T0 + 3_600_000),
    assistant({ id: "bbbbbbbb", input: 100, output: 20, totalTokens: 120, time: T0 + 3_601_000 }),
  ], { cwdDir: "--repo-pi-app--" });

  const sessions = await buildSessionAnalytics({ home, force: true });
  const piRows = sessions.filter((row) => row.source === "pi");
  assert.equal(piRows.length, 2);
  const sessionTokens = piRows.reduce((sum, row) => sum + row.total_tokens, 0);
  assert.equal(sessionTokens, 240);

  const queuePath = path.join(home, "queue.jsonl");
  await parsePiIncremental({
    sessionFiles: [parentFile, ...fs.readdirSync(path.dirname(parentFile))
      .filter((name) => name.endsWith(".jsonl") && name.includes(forkId))
      .map((name) => path.join(path.dirname(parentFile), name))],
    cursors: {},
    queuePath,
    env: { HOME: home, TOKENTRACKER_PI_AGENT_DIR: path.join(home, ".pi", "agent") },
  });
  const queued = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const hourlyTokens = queued.reduce((sum, row) => sum + row.total_tokens, 0);
  assert.equal(hourlyTokens, 240);
  assert.equal(sessionTokens, hourlyTokens);
});

test("pi session_info renames the session and an empty name clears it", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 2, totalTokens: 12 }),
    {
      type: "session_info",
      id: "n1",
      parentId: "aaaaaaaa",
      timestamp: new Date(T0 + 2000).toISOString(),
      name: "  Fix importer retry loop  ",
    },
  ]);
  const row = await scanPiSession(file);
  assert.equal(row.title, "Fix importer retry loop");

  const cleared = writeSession(home, `2026-10-10T12-05-00-000Z_${SESSION_ID}-2.jsonl`, [
    header({ id: `${SESSION_ID}-2` }),
    user("u1"),
    assistant({ id: "bbbbbbbb", input: 10, output: 2, totalTokens: 12 }),
    { type: "session_info", id: "n2", parentId: "bbbbbbbb", timestamp: new Date(T0 + 2000).toISOString(), name: "   " },
  ]);
  const clearedRow = await scanPiSession(cleared);
  assert.equal(clearedRow.title, null);
});

test("pi model_change names the backend for a usage row without its own model", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    {
      type: "model_change",
      id: "m1",
      parentId: "u1",
      timestamp: new Date(T0 + 500).toISOString(),
      provider: "openrouter",
      modelId: "deepseek-v4-pro",
    },
    {
      type: "message",
      id: "aaaaaaaa",
      parentId: "m1",
      timestamp: new Date(T0 + 1000).toISOString(),
      message: {
        role: "assistant",
        provider: "openrouter",
        content: [{ type: "text", text: SECRET }],
        usage: { input: 30, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 36 },
        timestamp: T0 + 1000,
      },
    },
  ]);
  const row = await scanPiSession(file);
  assert.equal(row.model, "deepseek-v4-pro");
  assert.equal(row.total_tokens, 36);
});

test("pi duplicate entry ids do not inflate turns, retries, or subagent calls", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 2, totalTokens: 12, tools: ["task"] }),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 2, totalTokens: 12, tools: ["task"] }),
  ]);
  const row = await scanPiSession(file);
  assert.equal(row.total_tokens, 12);
  assert.equal(row.turns, 1);
  assert.equal(row.retry_turns, 0);
  assert.equal(row.subagent_calls >= 1, true);
  assert.equal(row.subagent_types.task, 1);
});

test("pi nested child transcripts do not steal parent edit attribution", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({
      id: "aaaaaaaa",
      model: "claude-sonnet-4-5",
      input: 50,
      output: 10,
      totalTokens: 60,
      tools: ["edit"],
    }),
  ], {
    nested: [{
      name: "deadbeef/run-1/session.jsonl",
      records: [
        header({ id: "child-session" }),
        assistant({
          id: "bbbbbbbb",
          model: "gpt-5",
          input: 20,
          output: 5,
          totalTokens: 25,
          time: T0 + 5000,
          tools: [],
        }),
      ],
    }],
  });
  const row = await scanPiSession(file);
  assert.equal(row.edit_turns, 1);
  const claude = row.model_usage.find((m) => m.model === "claude-sonnet-4-5");
  const gpt = row.model_usage.find((m) => m.model === "gpt-5");
  assert.equal(claude.edit_turns, 1);
  assert.equal(gpt.edit_turns, 0);
});

test("pi discovery yields no files and no incomplete entries when the install is absent", async (t) => {
  const home = fixture(t);
  const incomplete = [];
  const discovered = await discoverSessionFiles(home, { HOME: home }, { homedir: () => home, incomplete });
  assert.deepEqual(discovered.pi, []);
  assert.deepEqual(discovered.incomplete, []);
});
