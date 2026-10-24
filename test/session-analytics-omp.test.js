"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  scanOmpSession,
  discoverSessionFiles,
  buildSessionAnalytics,
  listSessionsForBrowser,
  summarizeSessions,
  sessionsToCsv,
  resolveSessionSidecarPath,
  resumeCommandFor,
} = require("../src/lib/session-analytics");
const { parseOmpIncremental } = require("../src/lib/rollout");

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const SESSION_ID = "019c625b-b900-7000-8000-000000000001";
const SECRET = "private prompt, tool arguments and assistant body";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-omp-sessions-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function header({ id = SESSION_ID, cwd = "/repo/omp-app", title = "Investigate importer" } = {}) {
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

function user(id, time = T0) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(time).toISOString(),
    message: { role: "user", content: [{ type: "text", text: SECRET }], timestamp: time },
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

function writeSession(home, fileName, records, { nested = [] } = {}) {
  const dir = path.join(home, ".omp", "agent", "sessions", "--repo-omp-app--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, records.map(JSON.stringify).join("\n") + "\n");
  if (nested.length) {
    const nestedDir = file.replace(/\.jsonl$/i, "");
    fs.mkdirSync(nestedDir, { recursive: true });
    for (const child of nested) {
      fs.writeFileSync(
        path.join(nestedDir, child.name),
        child.records.map(JSON.stringify).join("\n") + "\n",
      );
    }
  }
  return file;
}

test("OMP sessions count assistant usage once, fold nested subagents, and omit bodies", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({
      id: "aaaaaaaa",
      input: 100,
      output: 20,
      totalTokens: 120,
      tools: ["edit", "task"],
    }),
    assistant({ id: "aaaaaaaa", input: 100, output: 20, totalTokens: 120 }),
  ], {
    nested: [{
      name: "AgentA.jsonl",
      records: [
        header({ id: "child-session", title: null }),
        assistant({ id: "bbbbbbbb", input: 40, output: 10, totalTokens: 50, time: T0 + 5000, model: "claude-sonnet-4-5" }),
      ],
    }],
  });

  const row = await scanOmpSession(file);
  assert.ok(row);
  assert.equal(row.source, "omp");
  assert.equal(row.session_id, SESSION_ID);
  assert.equal(row.total_tokens, 170);
  assert.equal(row.turns, 1);
  assert.equal(row.edit_turns, 1);
  assert.equal(row.subagent_calls >= 1, true);
  assert.equal(row.model, "claude-sonnet-4-5");
  assert.equal(row.title, "Investigate importer");
  assert.equal(row.project_ref, "/repo/omp-app");
  assert.equal(JSON.stringify(row).includes(SECRET), false);

  const browser = listSessionsForBrowser([row]).sessions[0];
  assert.equal(browser.resume_command, `omp --resume ${SESSION_ID}`);
  assert.equal(resumeCommandFor("omp", SESSION_ID), `omp --resume ${SESSION_ID}`);

  const exported = JSON.stringify(summarizeSessions([row])) + sessionsToCsv([row]);
  for (const value of [SECRET, SESSION_ID, "/repo/omp-app"]) {
    assert.equal(exported.includes(value), false);
  }
});

test("OMP discover + sidecar build finds sessions under an isolated home", async (t) => {
  const home = fixture(t);
  writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "cccccccc", input: 10, output: 5, totalTokens: 15 }),
  ]);

  const discovered = await discoverSessionFiles(home, { HOME: home }, { homedir: () => home });
  assert.equal(discovered.omp.length, 1);

  const sessions = await buildSessionAnalytics({ home, force: true });
  assert.equal(sessions.some((row) => row.source === "omp" && row.session_id === SESSION_ID), true);
  assert.equal(fs.existsSync(resolveSessionSidecarPath(home)), true);
});

test("OMP session totals match the hourly sync parser for the same assistant rows", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    assistant({ id: "dddddddd", input: 80, output: 40, cacheRead: 10, cacheWrite: 5, totalTokens: 135 }),
  ]);
  const row = await scanOmpSession(file);
  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  await parseOmpIncremental({
    sessionFiles: [file],
    cursors,
    queuePath,
    env: { HOME: home, OMP_HOME: path.join(home, ".omp") },
  });
  const queued = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].total_tokens, row.total_tokens);
  assert.equal(queued[0].input_tokens, row.tokens.input_tokens);
  assert.equal(queued[0].output_tokens, row.tokens.output_tokens);
  assert.equal(queued[0].cached_input_tokens, row.tokens.cached_input_tokens);
  assert.equal(queued[0].cache_creation_input_tokens, row.tokens.cache_creation_input_tokens);
});

test("resumeCommandFor rejects unsafe omp session ids", () => {
  assert.equal(resumeCommandFor("omp", "abc; rm -rf /"), null);
  assert.equal(resumeCommandFor("omp", "../escape"), null);
  assert.equal(resumeCommandFor("omp", SESSION_ID), `omp --resume ${SESSION_ID}`);
});

test("OMP fork copies that reuse entry ids count tokens once across Sessions", async (t) => {
  const home = fixture(t);
  const parentId = "aaaaaaaa";
  const childId = "bbbbbbbb";
  const parentRecords = [
    header({ id: SESSION_ID }),
    user("u1"),
    assistant({ id: parentId, input: 100, output: 20, totalTokens: 120 }),
  ];
  const forkId = "019c625b-b900-7000-8000-000000000002";
  const parentFile = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, parentRecords);
  const forkFile = writeSession(home, `2026-10-10T13-00-00_${forkId}.jsonl`, [
    header({ id: forkId, title: "Forked investigation" }),
    // Fork retains parent history with the same entry ids, then adds new work.
    ...parentRecords.slice(1),
    user("u2", T0 + 3_600_000),
    assistant({ id: childId, input: 100, output: 20, totalTokens: 120, time: T0 + 3_601_000 }),
  ]);

  const sessions = await buildSessionAnalytics({ home, force: true });
  const ompRows = sessions.filter((row) => row.source === "omp");
  assert.equal(ompRows.length, 2);
  const sessionTokens = ompRows.reduce((sum, row) => sum + row.total_tokens, 0);
  assert.equal(sessionTokens, 240);

  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  await parseOmpIncremental({
    sessionFiles: [parentFile, forkFile],
    cursors,
    queuePath,
    env: { HOME: home, OMP_HOME: path.join(home, ".omp") },
  });
  const queued = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const hourlyTokens = queued.reduce((sum, row) => sum + row.total_tokens, 0);
  assert.equal(hourlyTokens, 240);
  assert.equal(sessionTokens, hourlyTokens);
});

test("OMP duplicate entry ids do not inflate turns, retries, or subagent calls", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 2, totalTokens: 12, tools: ["task"] }),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 2, totalTokens: 12, tools: ["task"] }),
  ]);
  const row = await scanOmpSession(file);
  assert.equal(row.total_tokens, 12);
  assert.equal(row.turns, 1);
  assert.equal(row.retry_turns, 0);
  assert.equal(row.subagent_calls >= 1, true);
  // Nested length may bump the floor, but tool-derived count must not double.
  assert.equal(row.subagent_types.task, 1);
});

test("OMP nested child transcripts do not steal parent edit attribution", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
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
      name: "AgentA.jsonl",
      records: [
        header({ id: "child-session", title: null }),
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
  const row = await scanOmpSession(file);
  assert.equal(row.edit_turns, 1);
  const claude = row.model_usage.find((m) => m.model === "claude-sonnet-4-5");
  const gpt = row.model_usage.find((m) => m.model === "gpt-5");
  assert.equal(claude.edit_turns, 1);
  assert.equal(gpt.edit_turns, 0);
});

test("OMP placeholder message timestamps fall back to the entry date", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    {
      type: "message",
      id: "aaaaaaaa",
      parentId: null,
      timestamp: new Date(T0).toISOString(),
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: SECRET }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 15 },
        timestamp: 1, // placeholder that previously landed in 1970
      },
    },
  ]);
  const row = await scanOmpSession(file);
  assert.equal(row.total_tokens, 15);
  assert.equal(row.started_at.startsWith("2026-10-10"), true);
  assert.equal(row.started_at.startsWith("1970"), false);
});

test("OMP sidecar rebuilds on v26 upgrade and nested-only transcript changes", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 5, totalTokens: 15 }),
  ], {
    nested: [{
      name: "AgentA.jsonl",
      records: [
        header({ id: "child-session", title: null }),
        assistant({ id: "bbbbbbbb", input: 4, output: 1, totalTokens: 5, time: T0 + 2000 }),
      ],
    }],
  });

  // Seed a genuine pre-OMP (v26) sidecar with no omp rows so a no-op cache
  // hit cannot satisfy the upgrade assertion.
  const sidecarPath = resolveSessionSidecarPath(home);
  const metaPath = `${sidecarPath}.meta.json`;
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarPath, "");
  fs.writeFileSync(metaPath, `${JSON.stringify({
    version: 26,
    signature: "stale-v26",
    generated_at: new Date().toISOString(),
    checked_at: new Date().toISOString(),
    files: {},
  })}\n`);

  const afterVersion = await buildSessionAnalytics({ home, force: false, cacheTtlMs: 60 * 60_000 });
  const upgraded = afterVersion.find((row) => row.source === "omp");
  assert.ok(upgraded, "v26 → v27 rebuild must invent OMP rows");
  assert.equal(upgraded.version, 27);
  assert.equal(upgraded.total_tokens, 20);
  assert.equal(JSON.parse(fs.readFileSync(metaPath, "utf8")).version, 27);

  // Touch only the nested child so the dependency signature must invalidate.
  // cacheTtlMs: 0 skips the TTL short-circuit so signature/stat checks run.
  const nestedPath = path.join(file.replace(/\.jsonl$/i, ""), "AgentA.jsonl");
  const nested = fs.readFileSync(nestedPath, "utf8").trimEnd() + "\n" + JSON.stringify(
    assistant({ id: "cccccccc", input: 6, output: 2, totalTokens: 8, time: T0 + 8000 }),
  ) + "\n";
  // Force an mtime advance after the write so coarse filesystems still
  // invalidate the sidecar dependency signature.
  fs.writeFileSync(nestedPath, nested);
  const nextMtime = (Date.now() + 1000) / 1000;
  fs.utimesSync(nestedPath, nextMtime, nextMtime);

  const afterNested = await buildSessionAnalytics({ home, force: false, cacheTtlMs: 0 });
  assert.equal(afterNested.find((row) => row.source === "omp").total_tokens, 28);
});

test("OMP discovery permission errors keep the previous sidecar", async (t) => {
  const home = fixture(t);
  writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    assistant({ id: "aaaaaaaa", input: 10, output: 5, totalTokens: 15 }),
  ]);
  const first = await buildSessionAnalytics({ home, force: true });
  assert.equal(first.find((row) => row.source === "omp").total_tokens, 15);

  const projectDir = path.join(home, ".omp", "agent", "sessions", "--repo-omp-app--");
  const originalReaddir = fs.readdirSync;
  t.after(() => { fs.readdirSync = originalReaddir; });
  fs.readdirSync = function patched(target, options) {
    if (path.resolve(String(target)) === path.resolve(projectDir)) {
      const err = new Error("permission denied");
      err.code = "EACCES";
      throw err;
    }
    return originalReaddir.call(this, target, options);
  };

  const second = await buildSessionAnalytics({ home, force: false, cacheTtlMs: 0 });
  assert.equal(second.find((row) => row.source === "omp")?.total_tokens, 15);
  assert.equal(Array.isArray(second.incompleteDirs) && second.incompleteDirs.length > 0, true);
});

test("OMP malformed UTF-8 records do not abort sibling usage", async (t) => {
  const home = fixture(t);
  const dir = path.join(home, ".omp", "agent", "sessions", "--repo-omp-app--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`);
  const good = JSON.stringify(assistant({ id: "aaaaaaaa", input: 10, output: 5, totalTokens: 15 }));
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from(`${JSON.stringify(header())}\n`, "utf8"),
    Buffer.from([0xff, 0xfe, 0xfd, 0x0a]), // invalid UTF-8 record
    Buffer.from(`${good}\n`, "utf8"),
  ]));
  const row = await scanOmpSession(file);
  assert.ok(row);
  assert.equal(row.total_tokens, 15);
});

test("OMP nested discovery permission errors keep the previous sidecar", async (t) => {
  const home = fixture(t);
  writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    user("u1"),
    assistant({ id: "aaaaaaaa", input: 10, output: 5, totalTokens: 15, tools: ["edit"] }),
  ], {
    nested: [{
      name: "AgentA.jsonl",
      records: [
        header({ id: "child-session", title: null }),
        assistant({ id: "bbbbbbbb", input: 4, output: 1, totalTokens: 5, time: T0 + 2000 }),
      ],
    }],
  });
  const first = await buildSessionAnalytics({ home, force: true });
  assert.equal(first.find((row) => row.source === "omp").total_tokens, 20);

  const nestedDir = path.join(
    home, ".omp", "agent", "sessions", "--repo-omp-app--",
    `2026-10-10T12-00-00_${SESSION_ID}`,
  );
  const originalReaddir = fs.readdirSync;
  t.after(() => { fs.readdirSync = originalReaddir; });
  fs.readdirSync = function patched(target, options) {
    if (path.resolve(String(target)) === path.resolve(nestedDir)) {
      const err = new Error("permission denied");
      err.code = "EACCES";
      throw err;
    }
    return originalReaddir.call(this, target, options);
  };

  const second = await buildSessionAnalytics({ home, force: true, cacheTtlMs: 0 });
  assert.equal(second.find((row) => row.source === "omp")?.total_tokens, 20);
  assert.equal(fs.existsSync(`${resolveSessionSidecarPath(home)}.meta.json.omp-incomplete`), true);
});

test("OMP transcript read permission errors keep the previous sidecar", async (t) => {
  const home = fixture(t);
  const file = writeSession(home, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`, [
    header(),
    assistant({ id: "aaaaaaaa", input: 10, output: 5, totalTokens: 15 }),
  ], {
    nested: [{
      name: "AgentA.jsonl",
      records: [
        header({ id: "child-session", title: null }),
        assistant({ id: "bbbbbbbb", input: 4, output: 1, totalTokens: 5, time: T0 + 2000 }),
      ],
    }],
  });
  const first = await buildSessionAnalytics({ home, force: true });
  assert.equal(first.find((row) => row.source === "omp").total_tokens, 20);

  const originalCreate = fs.createReadStream;
  t.after(() => { fs.createReadStream = originalCreate; });
  fs.createReadStream = function patched(target, options) {
    if (path.resolve(String(target)) === path.resolve(file)) {
      const err = new Error("permission denied");
      err.code = "EACCES";
      throw err;
    }
    return originalCreate.call(this, target, options);
  };

  const second = await buildSessionAnalytics({ home, force: true, cacheTtlMs: 0 });
  assert.equal(second.find((row) => row.source === "omp")?.total_tokens, 20);
  assert.equal(fs.existsSync(`${resolveSessionSidecarPath(home)}.meta.json.omp-incomplete`), true);
});

test("OMP Sessions accepts a final JSONL record without a trailing newline", async (t) => {
  const home = fixture(t);
  const dir = path.join(home, ".omp", "agent", "sessions", "--repo-omp-app--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-10T12-00-00_${SESSION_ID}.jsonl`);
  // No trailing newline after the assistant row — hourly accepts this.
  fs.writeFileSync(
    file,
    `${JSON.stringify(header())}\n${JSON.stringify(assistant({ id: "aaaaaaaa", input: 10, output: 5, totalTokens: 15 }))}`,
  );
  const row = await scanOmpSession(file);
  assert.equal(row.total_tokens, 15);

  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  await parseOmpIncremental({
    sessionFiles: [file],
    cursors,
    queuePath,
    env: { HOME: home, OMP_HOME: path.join(home, ".omp") },
  });
  const queued = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(queued[0].total_tokens, 15);
  assert.equal(row.total_tokens, queued[0].total_tokens);
});
