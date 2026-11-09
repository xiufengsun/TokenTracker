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
  analyticsEntryStatKey,
} = require("../src/lib/session-analytics");
const { parsePiIncremental } = require("../src/lib/rollout");
const { piSessionDependencies } = require("../src/lib/pi-session");

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
  // One `task` tool call and one nested transcript: the nested count is the
  // floor, so the session observed exactly one child.
  assert.equal(row.subagent_calls, 1);
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

test("pi keeps every routed backend's tokens when one model is reached two ways", async (t) => {
  // pi is a router. The Sessions sidecar has one source per row and no place to
  // carry a per-model backend, so both turns land on the model row — see the
  // follow-up noted in the PR description. What must never regress is the
  // accounting: all 45 tokens are present, in as many rows as the reader uses.
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    assistant({ id: "e1", provider: "anthropic", input: 10, output: 5, totalTokens: 15 }),
    assistant({ id: "e2", provider: "github-copilot", input: 20, output: 10, totalTokens: 30, time: T0 + 2000 }),
  ]);
  const row = await scanPiSession(file);
  const rowTokens = row.model_usage.reduce((sum, m) => sum + m.total_tokens, 0);
  assert.equal(row.total_tokens, 45);
  assert.equal(rowTokens, row.total_tokens);
  assert.equal(row.model_usage.some((m) => m.model === "claude-sonnet-4-5"), true);
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
  // The replayed `task` call must not count a second child.
  assert.equal(row.subagent_calls, 1);
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

test("pi entry stat key covers nested transcripts, so a child change rescans the batch", async (t) => {
  // The overall sidecar signature already includes piSessionDependencies, but
  // per-entry reuse compares analyticsEntryStatKey alone. Without the nested
  // transcripts in that key a child that gained usage would reuse old rows.
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 2, totalTokens: 12 }),
  ], {
    nested: [{
      name: "deadbeef/run-1/session.jsonl",
      records: [header({ id: "child-session" }), assistant({ id: "bbbbbbbb", input: 5, output: 1, totalTokens: 6, time: T0 + 5000 })],
    }],
  });

  const before = analyticsEntryStatKey("pi", [file]);
  assert.equal(typeof before, "string");
  assert.match(before, /\|metadata:/);

  const nestedPath = path.join(file.replace(/\.jsonl$/i, ""), "deadbeef", "run-1", "session.jsonl");
  fs.appendFileSync(nestedPath, JSON.stringify(assistant({ id: "cccccccc", input: 100, output: 20, totalTokens: 120, time: T0 + 9000 })) + "\n");

  const after = analyticsEntryStatKey("pi", [file]);
  assert.notEqual(after, before, "a nested transcript change must move the pi entry stat key");

  const sessions = await buildSessionAnalytics({ home, force: true });
  const row = sessions.find((r) => r.source === "pi" && r.session_id === SESSION_ID);
  assert.equal(row.total_tokens, 138);
});

test("pi discovery yields no files and no incomplete entries when the install is absent", async (t) => {
  const home = fixture(t);
  const incomplete = [];
  const discovered = await discoverSessionFiles(home, { HOME: home }, { homedir: () => home, incomplete });
  assert.deepEqual(discovered.pi, []);
  assert.deepEqual(discovered.incomplete, []);
});

test("pi ignores an out-of-range message timestamp and uses the entry envelope instead", async (t) => {
  // A hand-edited or buggy transcript must not take the whole pi batch down:
  // new Date(1e21).toISOString() throws RangeError, so the value is rejected and
  // the entry's ISO timestamp is used.
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    {
      type: "message",
      id: "aaaaaaaa",
      parentId: "parent",
      timestamp: new Date(T0 + 1000).toISOString(),
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        content: [],
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 12 },
        timestamp: 1e21,
      },
    },
  ]);
  const row = await scanPiSession(file);
  assert.equal(row.total_tokens, 12);
  assert.equal(row.ended_at, new Date(T0 + 1000).toISOString());
});

test("pi counts an edit made only inside a nested subagent transcript", async (t) => {
  // The session's only edit happened in a child. The parent's own turn stays
  // unmarked, but the session must not read as unproductive.
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 50, output: 10, totalTokens: 60, tools: [] }),
  ], {
    nested: [{
      name: "deadbeef/run-1/session.jsonl",
      records: [
        header({ id: "child-session" }),
        user("cu1", T0 + 4000),
        assistant({ id: "bbbbbbbb", model: "gpt-5", input: 20, output: 5, totalTokens: 25, time: T0 + 5000, tools: ["edit"] }),
      ],
    }],
  });
  const row = await scanPiSession(file);
  assert.equal(row.edit_turns, 1);
  assert.equal(row.turns, 1);
  const gpt = row.model_usage.find((m) => m.model === "gpt-5");
  assert.equal(gpt.edit_turns, 1);
  assert.equal(row.model_usage.find((m) => m.model === "claude-sonnet-4-5").edit_turns, 0);
});

test("pi assigns replayed entries to the originating session across projects", async (t) => {
  // The fork lives in a cwd dir that sorts before the parent's, so a
  // path-ordered batch would let the fork claim the parent's entry ids and leave
  // the parent looking empty. Start-time ordering must win over path order.
  const home = fixture(t);
  const parentRecords = [
    header({ cwd: "/repo/zzz-parent" }),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 100, output: 20, totalTokens: 120 }),
  ];
  writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, parentRecords, { cwdDir: "--repo-zzz-parent--" });
  const forkId = "01a1bc31-0000-7000-8000-000000000003";
  writeSession(home, `2026-10-10T14-00-00-000Z_${forkId}.jsonl`, [
    header({ id: forkId, cwd: "/repo/aaa-fork", parentSession: SESSION_ID }),
    ...parentRecords.slice(1),
  ], { cwdDir: "--repo-aaa-fork--" });

  const sessions = await buildSessionAnalytics({ home, force: true });
  const parent = sessions.find((row) => row.session_id === SESSION_ID);
  assert.ok(parent, "the originating session must still be listed");
  assert.equal(parent.total_tokens, 120);
  assert.equal(parent.turns, 1);
});

test("pi nested discovery survives a symlink cycle back to an ancestor", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 2, totalTokens: 12 }),
  ], {
    nested: [{
      name: "deadbeef/run-1/session.jsonl",
      records: [header({ id: "child-session" }), assistant({ id: "bbbbbbbb", input: 5, output: 1, totalTokens: 6 })],
    }],
  });
  // Link the nested transcript's own dir back above the sessions root, so a walk
  // that crosses links would both loop and fold every other session's
  // transcripts into this one.
  const nestedDir = path.join(file.replace(/\.jsonl$/i, ""), "deadbeef");
  const sessionsRoot = path.join(home, ".pi", "agent", "sessions");
  try {
    fs.symlinkSync(sessionsRoot, path.join(nestedDir, "loop"), "dir");
  } catch (error) {
    t.skip(`symlinks unavailable on this platform: ${error?.code}`);
    return;
  }
  const row = await scanPiSession(file);
  assert.ok(row);
  assert.equal(row.total_tokens, 18);
  // The cycle test must not just check tokens: the link also has to stay out of
  // the subagent accounting, or a foreign transcript silently joins this session.
  assert.equal(row.subagent_calls, 1);
  assert.deepEqual(row.subagent_types, { session: 1 });

  // The same containment has to hold for the dependency list that feeds the
  // entry stat key, or a foreign transcript would ride the cache signature too.
  assert.equal(piSessionDependencies([file]).length, 2);
});

test("pi nested discovery ignores a symlink without counting foreign transcripts", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00-000Z_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 2, totalTokens: 12 }),
  ], {
    nested: [{
      name: "deadbeef/run-1/session.jsonl",
      records: [header({ id: "child-session" }), assistant({ id: "bbbbbbbb", input: 5, output: 1, totalTokens: 6 })],
    }],
  });
  // A sibling project's session dir linked into this session's nested tree must
  // not be folded in: that would move another session's tokens here.
  const other = writeSession(home, `2026-10-10T11-00-00-000Z_01a1bc31-0000-7000-8000-000000000009.jsonl`, [
    header({ id: "01a1bc31-0000-7000-8000-000000000009", cwd: "/repo/other" }),
    assistant({ id: "cccccccc", input: 500, output: 100, totalTokens: 600 }),
  ], { cwdDir: "--repo-other--" });
  const nestedDir = path.join(file.replace(/\.jsonl$/i, ""), "deadbeef");
  try {
    fs.symlinkSync(path.dirname(other), path.join(nestedDir, "other-project"), "dir");
  } catch (error) {
    t.skip(`symlinks unavailable on this platform: ${error?.code}`);
    return;
  }
  const row = await scanPiSession(file);
  assert.equal(row.total_tokens, 18, "the foreign session's 600 tokens must not land here");
  assert.equal(row.subagent_calls, 1);
  assert.deepEqual(row.subagent_types, { session: 1 });
});
