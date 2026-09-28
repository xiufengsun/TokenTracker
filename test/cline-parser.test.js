/**
 * Cline parser unit test (Cline CLI v3 / desktop app — ~/.cline).
 *
 * Cline keeps its own data dir instead of the VS Code globalStorage layout the
 * Roo Code / Kilo Code forks still use:
 *   <clineDir>/data/sessions/<session_id>/<session_id>.messages.json
 *
 * Each assistant turn carries `metrics` = a per-call delta of AI SDK
 * LanguageModelUsage totals, where `inputTokens` ALREADY CONTAINS
 * cacheRead + cacheWrite and `outputTokens` ALREADY CONTAINS reasoning. The
 * assertions below pin that subtraction — copying inputTokens straight into
 * input_tokens would bill the cached prefix twice.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  resolveClineSessionsDir,
  resolveClineSessionsDirs,
  listClineSessionFiles,
  resolveClineSessionFiles,
  resolveClineSessionFilesWithStatus,
  normalizeClineModel,
  parseClineIncremental,
} = require("../src/lib/rollout");

function setupFixture({ sessions, extraFiles = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cline-fix-"));
  const sessionsDir = path.join(home, "data", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (const session of sessions) {
    const sessionDir = path.join(sessionsDir, session.id);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `${session.id}.messages.json`),
      JSON.stringify({ version: 1, sessionId: session.id, messages: session.messages }),
    );
    if (session.model !== undefined || session.importedFrom) {
      const metadata = {
        session_id: session.id,
        provider: "cline",
        ...(session.model === undefined ? {} : { model: session.model }),
        ...(session.importedFrom ? { metadata: { importedFrom: session.importedFrom } } : {}),
      };
      fs.writeFileSync(
        path.join(sessionDir, `${session.id}.json`),
        JSON.stringify(metadata),
      );
    }
  }
  for (const [relative, contents] of Object.entries(extraFiles)) {
    const target = path.join(sessionsDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return home;
}

function fakeEnv(home, extra = {}) {
  return { HOME: home, TOKENTRACKER_CLINE_HOME: home, ...extra };
}

function queueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("parseClineIncremental reads the anonymized real-session fixture", async () => {
  const fixturePath = path.join(__dirname, "fixtures", "cline", "session.messages.json");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cline-fixture-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = {};
    const result = await parseClineIncremental({
      sessionFiles: [{ filePath: fixturePath, sessionId: "fixture-cline-session" }],
      cursors,
      queuePath,
    });
    assert.equal(result.recordsProcessed, 3);
    assert.equal(result.eventsAggregated, 3);
    const [row] = queueRows(queuePath);
    assert.equal(row.source, "cline");
    assert.equal(row.model, "cline-free/deepseek-v4.1-flash");
    assert.equal(row.input_tokens, 21_535);
    assert.equal(row.cached_input_tokens, 10_922);
    assert.equal(row.output_tokens, 1_090);
    assert.equal(row.total_tokens, 33_547);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The local queue is append-only per bucket: a bucket whose totals grew gets a
// new row, and readers keep the last one. Assertions therefore look at the last
// row for a (source, model, hour_start) key, which is also what the dashboard
// and the cloud upsert treat as current.
function lastRowForKey(rows, { model, hourStart }) {
  const matching = rows.filter(
    (row) => row.source === "cline" && row.model === model && row.hour_start === hourStart,
  );
  return matching[matching.length - 1] || null;
}

function writeMessages(home, sessionId, messages, model) {
  const sessionDir = path.join(home, "data", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, `${sessionId}.messages.json`),
    JSON.stringify({ version: 1, sessionId, messages }),
  );
  if (model !== undefined) {
    fs.writeFileSync(
      path.join(sessionDir, `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, provider: "cline", model }),
    );
  }
}

test("resolveClineSessionsDir honors Cline's own env chain and our override", () => {
  const home = "/tmp/cline-home";
  // Cline resolves CLINE_DIR -> <dir>/data -> <dir>/data/sessions.
  assert.equal(
    resolveClineSessionsDir({ HOME: home, CLINE_DIR: "/opt/cline" }),
    path.join("/opt/cline", "data", "sessions"),
  );
  assert.equal(
    resolveClineSessionsDir({ HOME: home, CLINE_DATA_DIR: "/opt/data" }),
    path.join("/opt/data", "sessions"),
  );
  assert.equal(
    resolveClineSessionsDir({ HOME: home, CLINE_SESSION_DATA_DIR: "/opt/sessions" }),
    "/opt/sessions",
  );
  // TokenTracker's own override wins over Cline's.
  assert.equal(
    resolveClineSessionsDir({ HOME: home, TOKENTRACKER_CLINE_HOME: "/tt", CLINE_DIR: "/opt/cline" }),
    path.join("/tt", "data", "sessions"),
  );
  // Default: ~/.cline/data/sessions.
  assert.equal(
    resolveClineSessionsDir({ HOME: home }),
    path.join(home, ".cline", "data", "sessions"),
  );
});

test("resolveClineSessionsDirs does not probe WSL when a path override is set", () => {
  const overridden = resolveClineSessionsDirs(
    { HOME: "/tmp/home", CLINE_DIR: "/opt/cline", TOKENTRACKER_WSL_MODE: "both" },
    { platform: "win32", discoverWslHome: () => "\\\\wsl$\\Ubuntu\\.cline" },
  );
  assert.deepEqual(overridden, [path.join("/opt/cline", "data", "sessions")]);

  // Without an override on win32 the distro copy is unioned in as well.
  const unioned = resolveClineSessionsDirs(
    { HOME: "C:\\Users\\me", TOKENTRACKER_WSL_MODE: "both" },
    { platform: "win32", existsSync: () => false, discoverWslHome: () => "\\\\wsl$\\Ubuntu\\.cline\\data\\sessions" },
  );
  assert.deepEqual(unioned, ["\\\\wsl$\\Ubuntu\\.cline\\data\\sessions"]);
});

test("resolveClineSessionFiles finds root and teammate transcripts", () => {
  const home = setupFixture({
    sessions: [{ id: "session_1_aaa", model: "claude-sonnet-5", messages: [] }],
    extraFiles: { "session_1_aaa/teammate_1.messages.json": JSON.stringify({ messages: [] }) },
  });
  const files = resolveClineSessionFiles(fakeEnv(home));
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((file) => path.basename(file.filePath)).sort(),
    ["session_1_aaa.messages.json", "teammate_1.messages.json"],
  );
  assert.ok(files.every((file) => file.sessionId === "session_1_aaa"));
  assert.ok(files.some((file) => /session_1_aaa\.json$/.test(file.sessionMetaPath)));
  fs.rmSync(home, { recursive: true, force: true });
});

test("parseClineIncremental skips usage copied from an imported source session", async () => {
  const importedAt = Date.UTC(2026, 8, 19, 16, 30, 0);
  const home = setupFixture({
    sessions: [{
      id: "imported-codex",
      model: "gpt-5.4",
      importedFrom: {
        tool: "codex",
        sourceSessionId: "codex-source",
        sourcePath: "/tmp/codex-source.jsonl",
        importedAt: new Date(importedAt).toISOString(),
      },
      messages: [
        {
          id: "copied-turn",
          role: "assistant",
          ts: importedAt - 1,
          modelInfo: { id: "gpt-5.4" },
          metrics: { inputTokens: 1_000, outputTokens: 100 },
        },
        {
          id: "cline-turn",
          role: "assistant",
          ts: importedAt + 1,
          modelInfo: { id: "gpt-5.4" },
          metrics: { inputTokens: 200, outputTokens: 20 },
        },
      ],
    }],
  });
  try {
    const queuePath = path.join(home, "queue.jsonl");
    const result = await parseClineIncremental({
      sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
      cursors: {},
      queuePath,
    });
    assert.equal(result.recordsProcessed, 1);
    assert.equal(result.eventsAggregated, 1);
    const row = queueRows(queuePath).find((candidate) => candidate.source === "cline");
    assert.equal(row.input_tokens, 200);
    assert.equal(row.output_tokens, 20);
    assert.equal(row.conversation_count, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("parseClineIncremental includes teammate transcript usage", async () => {
  const ts = Date.UTC(2026, 8, 19, 16, 30, 0);
  const home = setupFixture({
    sessions: [{
      id: "session_team",
      model: "claude-sonnet-5",
      messages: [{
        id: "root-turn",
        role: "assistant",
        ts,
        modelInfo: { id: "claude-sonnet-5" },
        metrics: { inputTokens: 100, outputTokens: 10 },
      }],
    }],
    extraFiles: {
      "session_team/teammate_1.messages.json": JSON.stringify({
        messages: [{
          id: "root-turn",
          role: "assistant",
          ts,
          modelInfo: { id: "claude-sonnet-5" },
          metrics: { inputTokens: 200, outputTokens: 20 },
        }],
      }),
    },
  });
  try {
    const queuePath = path.join(home, "queue.jsonl");
    const cursors = {};
    const result = await parseClineIncremental({
      sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
      cursors,
      queuePath,
    });
    assert.equal(result.eventsAggregated, 2);
    const rows = queueRows(queuePath);
    const row = lastRowForKey(rows, {
      model: "claude-sonnet-5",
      hourStart: "2026-09-19T16:30:00.000Z",
    });
    assert.equal(row.input_tokens, 300);
    assert.equal(row.output_tokens, 30);
    assert.equal(row.conversation_count, 2);
    const second = await parseClineIncremental({
      sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
      cursors: JSON.parse(JSON.stringify(cursors)),
      queuePath,
    });
    assert.equal(second.eventsAggregated, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("listClineSessionFiles falls back to the first sorted transcript and skips empty dirs", () => {
  const home = setupFixture({ sessions: [] });
  const sessionsDir = path.join(home, "data", "sessions");
  fs.mkdirSync(path.join(sessionsDir, "session_no_meta"), { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "session_no_meta", "renamed.messages.json"),
    JSON.stringify({ messages: [] }),
  );
  fs.mkdirSync(path.join(sessionsDir, "session_no_transcript"), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "session_no_transcript", "notes.txt"), "x");

  const listed = listClineSessionFiles(sessionsDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, "session_no_meta");
  assert.equal(listed[0].sessionMetaPath, null);
  assert.match(listed[0].filePath, /renamed\.messages\.json$/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("listClineSessionFiles propagates permission errors", (t) => {
  t.mock.method(fs, "readdirSync", () => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  });
  assert.throws(() => listClineSessionFiles("/tmp/cline-permission"), { code: "EACCES" });
});

test("Cline discovery distinguishes missing paths from failed directory reads", async (t) => {
  const home = setupFixture({ sessions: [{ id: "discovery", messages: [] }] });
  const sessionsDir = path.join(home, "data", "sessions");
  try {
    for (const target of [sessionsDir, path.join(sessionsDir, "discovery")]) {
      for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EIO"]) {
        await t.test(`${path.basename(target)} ${code}`, (t) => {
          const read = fs.readdirSync;
          t.mock.method(fs, "readdirSync", (dir, ...args) => {
            if (dir === target) throw Object.assign(new Error("synthetic discovery failure"), { code });
            return read(dir, ...args);
          });
          if (code === "ENOENT" || code === "ENOTDIR") {
            assert.deepEqual(listClineSessionFiles(sessionsDir), []);
          } else {
            assert.throws(() => listClineSessionFiles(sessionsDir), { code });
          }
        });
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline discovery only marks a root complete after every session directory is read", (t) => {
  const home = setupFixture({
    sessions: [
      { id: "session_a", messages: [] },
      { id: "session_b", messages: [] },
    ],
  });
  const sessionsDir = path.join(home, "data", "sessions");
  const interruptedSessionDir = path.join(sessionsDir, "session_a");
  try {
    const read = fs.readdirSync;
    t.mock.method(fs, "readdirSync", (dir, ...args) => {
      if (dir === interruptedSessionDir) {
        throw Object.assign(new Error("session directory disappeared"), { code: "ENOENT" });
      }
      return read(dir, ...args);
    });
    const partial = resolveClineSessionFilesWithStatus(fakeEnv(home));
    assert.equal(partial.files.length, 1);
    assert.deepEqual(partial.completedRoots, []);
    assert.deepEqual(partial.errors, []);

    t.mock.restoreAll();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    const missing = resolveClineSessionFilesWithStatus(fakeEnv(home));
    assert.deepEqual(missing.files, []);
    assert.deepEqual(missing.completedRoots, []);
    assert.deepEqual(missing.errors, []);

    fs.mkdirSync(sessionsDir);
    const empty = resolveClineSessionFilesWithStatus(fakeEnv(home));
    assert.deepEqual(empty.files, []);
    assert.deepEqual(empty.completedRoots, [sessionsDir]);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline message fallback keys include the index when timestamps are equal", async () => {
  const ts = Date.UTC(2026, 8, 19, 16, 30, 0);
  const home = setupFixture({
    sessions: [{
      id: "session-key",
      messages: [
        { role: "assistant", ts, metrics: { inputTokens: 100, outputTokens: 1 } },
        { role: "assistant", ts, metrics: { inputTokens: 200, outputTokens: 2 } },
      ],
    }],
  });
  try {
    const cursors = {};
    await parseClineIncremental({
      sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
      cursors,
      queuePath: path.join(home, "queue.jsonl"),
    });
    const row = queueRows(path.join(home, "queue.jsonl")).at(-1);
    assert.equal(row.total_tokens, 303);
    assert.equal(row.conversation_count, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline keeps cursor state unchanged when queue append fails", async (t) => {
  const ts = Date.UTC(2026, 8, 19, 16, 30, 0);
  const home = setupFixture({
    sessions: [{
      id: "session-atomic",
      messages: [{ id: "turn", role: "assistant", ts, metrics: { inputTokens: 100, outputTokens: 1 } }],
    }],
  });
  try {
    const queuePath = path.join(home, "queue.jsonl");
    const cursors = {};
    const files = () => resolveClineSessionFiles(fakeEnv(home));
    await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
    writeMessages(home, "session-atomic", [{
      id: "turn", role: "assistant", ts, metrics: { inputTokens: 200, outputTokens: 2 },
    }]);
    const before = JSON.parse(JSON.stringify(cursors));
    t.mock.method(fsp, "appendFile", async () => {
      throw Object.assign(new Error("queue unavailable"), { code: "EIO" });
    });
    await assert.rejects(
      parseClineIncremental({ sessionFiles: files(), cursors, queuePath }),
      { code: "EIO" },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(cursors)), before);
    t.mock.restoreAll();
    await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
    assert.equal(queueRows(queuePath).at(-1).total_tokens, 202);
    assert.equal(queueRows(queuePath).at(-1).conversation_count, 1);
    const idle = await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
    assert.equal(idle.bucketsQueued, 0);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline migrates timestamp-only keys even when usage has not grown", async () => {
  const ts = Date.UTC(2026, 8, 19, 16, 30);
  const messages = [{ role: "assistant", ts, metrics: { inputTokens: 100 } }];
  const home = setupFixture({ sessions: [{ id: "key-migration", messages }] });
  try {
    const sessionFiles = resolveClineSessionFiles(fakeEnv(home));
    const queuePath = path.join(home, "queue.jsonl");
    let cursors = {};
    await parseClineIncremental({ sessionFiles, cursors, queuePath });
    cursors.cline.messageTotalsByFile[sessionFiles[0].filePath] = { [`ts:${ts}`]: { input: 100 } };
    for (const padding of [" ", "  "]) {
      fs.writeFileSync(sessionFiles[0].filePath, JSON.stringify({ messages }) + padding);
      cursors = JSON.parse(JSON.stringify(cursors));
      const result = await parseClineIncremental({ sessionFiles, cursors, queuePath });
      assert.equal(result.eventsAggregated, 0);
    }
    assert.equal(queueRows(queuePath).at(-1).total_tokens, 100);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline migrates a timestamp fallback when a later rewrite assigns a message id", async () => {
  const ts = Date.UTC(2026, 8, 19, 16, 30);
  const home = setupFixture({ sessions: [{
    id: "id-later", messages: [{ role: "assistant", ts, metrics: { inputTokens: 100, outputTokens: 10 } }],
  }] });
  try {
    const queuePath = path.join(home, "queue.jsonl");
    const cursors = {};
    const files = () => resolveClineSessionFiles(fakeEnv(home));
    await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });

    writeMessages(home, "id-later", [{
      id: "assigned-after-sync",
      role: "assistant",
      ts,
      metrics: { inputTokens: 200, outputTokens: 20 },
    }]);
    const result = await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
    assert.equal(result.eventsAggregated, 1);
    const row = queueRows(queuePath).at(-1);
    assert.equal(row.total_tokens, 220);
    assert.equal(row.conversation_count, 1);
    assert.deepEqual(Object.keys(cursors.cline.messageTotalsByFile[files()[0].filePath]), [
      "assigned-after-sync",
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("normalizeClineModel falls back: modelInfo.id > session model > provider", () => {
  assert.equal(
    normalizeClineModel({ modelInfo: { id: "cline-free/deepseek-v4.1-flash" }, fallbackModel: "x" }),
    "cline-free/deepseek-v4.1-flash",
  );
  assert.equal(
    normalizeClineModel({ modelInfo: { provider: "cline" }, fallbackModel: "claude-sonnet-5" }),
    "claude-sonnet-5",
  );
  assert.equal(
    normalizeClineModel({ modelInfo: { provider: "Open Router" }, fallbackModel: null }),
    "provider:openrouter",
  );
  assert.equal(normalizeClineModel({ modelInfo: null, fallbackModel: null }), "unknown");
});

test("parseClineIncremental subtracts the cached prefix and folds reasoning into output", async () => {
  const ts = Date.UTC(2026, 8, 19, 16, 30, 0); // 2026-09-19T16:30:00Z
  const home = setupFixture({
    sessions: [
      {
        id: "session_bucket",
        model: "cline-free/deepseek-v4.1-flash",
        messages: [
          { id: "msg_user", role: "user", ts, content: [] },
          {
            id: "msg_a",
            role: "assistant",
            ts,
            modelInfo: { id: "cline-free/deepseek-v4.1-flash", provider: "cline" },
            // AI SDK totals: inputTokens includes both cache buckets, and
            // outputTokens includes the reasoning tokens.
            metrics: {
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadTokens: 400,
              cacheWriteTokens: 100,
              reasoningTokenCount: 50,
            },
          },
        ],
      },
    ],
  });

  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  const res = await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors,
    queuePath,
  });
  assert.equal(res.recordsProcessed, 1, "the user turn carries no usage record");
  assert.equal(res.eventsAggregated, 1);
  assert.ok(res.bucketsQueued > 0);

  const row = lastRowForKey(queueRows(queuePath), {
    model: "cline-free/deepseek-v4.1-flash",
    hourStart: "2026-09-19T16:30:00.000Z",
  });
  assert.ok(row, "queue row for the Cline bucket");
  assert.equal(row.input_tokens, 500, "non-cached input only: 1000 - 400 - 100");
  assert.equal(row.cached_input_tokens, 400);
  assert.equal(row.cache_creation_input_tokens, 100);
  assert.equal(row.output_tokens, 200);
  assert.equal(row.reasoning_output_tokens, 50, "reasoning is reported as a subset");
  assert.equal(row.total_tokens, 1200, "inputTokens + outputTokens, reasoning not added twice");
  assert.equal(row.conversation_count, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test("parseClineIncremental counts reported cost and stays idempotent across re-syncs", async () => {
  const ts = Date.UTC(2026, 8, 19, 17, 5, 0);
  const session = {
    id: "session_cost",
    model: "cline-pass/glm-5.3",
    messages: [
      {
        id: "msg_cost",
        role: "assistant",
        ts,
        modelInfo: { id: "cline-pass/glm-5.3", provider: "cline" },
        metrics: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.25 },
      },
    ],
  };
  const home = setupFixture({ sessions: [session] });
  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};

  await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors,
    queuePath,
  });
  const first = lastRowForKey(queueRows(queuePath), {
    model: "cline-pass/glm-5.3",
    hourStart: "2026-09-19T17:00:00.000Z",
  });
  assert.equal(first.total_cost_usd, 0.25, "Cline's own per-call cost is carried through");
  assert.equal(first.input_tokens, 100);
  assert.equal(first.output_tokens, 20);

  // Unchanged file: the mtime/size gate skips it entirely.
  const before = queueRows(queuePath).length;
  const second = await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors,
    queuePath,
  });
  assert.equal(second.recordsProcessed, 0, "unchanged transcript is not re-read");
  assert.equal(queueRows(queuePath).length, before, "nothing re-queued");

  // Same bucket, one more turn appended: the bucket row grows to the new total
  // instead of re-adding the first turn.
  const appended = {
    ...session,
    messages: [
      ...session.messages,
      {
        id: "msg_cost_2",
        role: "assistant",
        ts: ts + 60_000,
        modelInfo: { id: "cline-pass/glm-5.3", provider: "cline" },
        metrics: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.05 },
      },
    ],
  };
  fs.writeFileSync(
    path.join(home, "data", "sessions", session.id, `${session.id}.messages.json`),
    JSON.stringify({ version: 1, sessionId: session.id, messages: appended.messages }),
  );
  const third = await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors,
    queuePath,
  });
  assert.equal(third.eventsAggregated, 1, "only the new turn is counted");
  const grown = lastRowForKey(queueRows(queuePath), {
    model: "cline-pass/glm-5.3",
    hourStart: "2026-09-19T17:00:00.000Z",
  });
  assert.equal(grown.input_tokens, 140);
  assert.equal(grown.output_tokens, 25);
  assert.equal(grown.total_cost_usd, 0.3);
  fs.rmSync(home, { recursive: true, force: true });
});

test("parseClineIncremental adds only the increase when Cline back-fills a counted turn", async () => {
  const ts = Date.UTC(2026, 8, 19, 18, 40, 0);
  const home = setupFixture({ sessions: [] });
  const sessionId = "session_backfill";
  const turn = (metrics) => ({
    id: "msg_same",
    role: "assistant",
    ts,
    modelInfo: { id: "claude-sonnet-5", provider: "anthropic" },
    metrics,
  });
  writeMessages(home, sessionId, [turn({ inputTokens: 100, outputTokens: 10 })], "claude-sonnet-5");

  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  const files = () => resolveClineSessionFiles(fakeEnv(home));
  await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });

  const key = { model: "claude-sonnet-5", hourStart: "2026-09-19T18:30:00.000Z" };
  assert.equal(lastRowForKey(queueRows(queuePath), key).input_tokens, 100);

  // Same message id, larger totals — a streamed turn Cline completed after our
  // first sync saw it. Only the 200/30 increase may be billed.
  writeMessages(
    home,
    sessionId,
    [turn({ inputTokens: 300, outputTokens: 40, cacheReadTokens: 25 })],
    "claude-sonnet-5",
  );
  await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });

  const grown = lastRowForKey(queueRows(queuePath), key);
  // 300 inclusive - 25 cache = 275 non-cached input now; 100 was already
  // counted, so the bucket grows by 175 to 275. The 25 cache-read tokens are
  // billed once, as cached_input_tokens — never subtracted twice.
  assert.equal(grown.input_tokens, 275);
  assert.equal(grown.cached_input_tokens, 25);
  assert.equal(grown.output_tokens, 40);
  assert.equal(grown.total_tokens, 340);
  assert.equal(grown.conversation_count, 1, "a backfill is not a new assistant turn");
  writeMessages(home, sessionId, [turn({
    inputTokens: 300, outputTokens: 40, cacheReadTokens: 25, cost: 0.25,
  })], "claude-sonnet-5");
  await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
  const priced = lastRowForKey(queueRows(queuePath), key);
  assert.equal(priced.conversation_count, 1, "a cost-only backfill is not a new turn");
  assert.equal(priced.total_cost_usd, 0.25);
  assert.equal(priced.total_tokens, 340);
  fs.rmSync(home, { recursive: true, force: true });
});

test("Cline resumes old sessions beyond 50,000 retained turns without replaying usage", async () => {
  const home = setupFixture({ sessions: [] });
  try {
    const sessionId = "fixture-cap";
    const message = (id, inputTokens) => ({
      id, role: "assistant", ts: Date.UTC(2026, 8, 19, 18, 40),
      modelInfo: { id: "fixture-model" }, metrics: { inputTokens, outputTokens: 10 },
    });
    writeMessages(home, sessionId, [message("old", 100)]);
    const queuePath = path.join(home, "queue.jsonl");
    const files = resolveClineSessionFiles(fakeEnv(home));
    let cursors = {};
    await parseClineIncremental({ sessionFiles: files, cursors, queuePath });
    // Synthetic newer sessions exceed the old global eviction threshold.
    writeMessages(home, "fixture-newer", Array.from({ length: 50_001 }, (_, i) => message(`turn-${i}`, 1)));
    const allFiles = () => resolveClineSessionFiles(fakeEnv(home));
    await parseClineIncremental({ sessionFiles: allFiles(), cursors, queuePath });
    const before = queueRows(queuePath).at(-1);
    cursors = JSON.parse(JSON.stringify(cursors));
    writeMessages(home, sessionId, [message("old", 200), message("new", 50)]);
    await parseClineIncremental({ sessionFiles: allFiles(), cursors, queuePath });
    const grown = queueRows(queuePath).at(-1);
    assert.equal(grown.total_tokens - before.total_tokens, 160);
    assert.equal(grown.conversation_count - before.conversation_count, 1);

    cursors = JSON.parse(JSON.stringify(cursors));
    writeMessages(home, sessionId, [message("old", 200), message("new", 50), message("next", 30)]);
    const result = await parseClineIncremental({ sessionFiles: allFiles(), cursors, queuePath });
    assert.equal(result.eventsAggregated, 1);
    const row = queueRows(queuePath).at(-1);
    assert.equal(row.total_tokens - before.total_tokens, 200);
    assert.equal(row.conversation_count - before.conversation_count, 2);

    fs.rmSync(path.join(home, "data", "sessions", sessionId), { recursive: true, force: true });
    await parseClineIncremental({
      sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
      cursors,
      queuePath,
    });
    assert.equal(cursors.cline.messageTotalsByFile[files[0].filePath], undefined);
    assert.equal(cursors.cline.fileOffsets[files[0].filePath], undefined);
    assert.equal(Object.keys(cursors.cline.messageTotalsByFile).length, 1);
    fs.rmSync(path.join(home, "data", "sessions", "fixture-newer"), { recursive: true });
    await parseClineIncremental({ sessionFiles: allFiles(), cursors, queuePath });
    assert.deepEqual(cursors.cline.messageTotalsByFile, {});
    assert.deepEqual(cursors.cline.fileOffsets, {});
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline migrates only previously read transcripts and discards the flat ledger", async (t) => {
  for (const stem of ["fixture-legacy", "renamed-root"]) {
    await t.test(stem, async () => {
      const sessionId = "fixture-legacy";
      const ts = Date.UTC(2026, 8, 19, 18, 40);
      const msg = { id: "shared-id", role: "assistant", ts, metrics: { inputTokens: 100 } };
      const home = setupFixture({ sessions: [{ id: sessionId, messages: [msg] }] });
      try {
        const sessionDir = path.join(home, "data", "sessions", sessionId);
        const rootPath = path.join(sessionDir, `${stem}.messages.json`);
        if (stem !== sessionId) {
          fs.renameSync(path.join(sessionDir, `${sessionId}.messages.json`), rootPath);
        }
        const queuePath = path.join(home, "queue.jsonl");
        let cursors = {};
        const files = () => resolveClineSessionFiles(fakeEnv(home));
        await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
        // Cursor shape written by the previous PR revision, with an unchanged file offset.
        delete cursors.cline.messageTotalsByFile;
        cursors.cline.messageTotals = { [`${sessionId}:shared-id`]: { input: 100 } };
        fs.writeFileSync(path.join(sessionDir, "teammate.messages.json"), JSON.stringify({ messages: [msg] }));
        const migrated = await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
        assert.equal(migrated.eventsAggregated, 1, "new teammate must not inherit root totals");
        assert.equal(queueRows(queuePath).at(-1).total_tokens, 200);
        assert.equal(cursors.cline.messageTotals, undefined, "do not persist two ledgers");
        cursors = JSON.parse(JSON.stringify(cursors));
        fs.writeFileSync(rootPath, JSON.stringify({ messages: [msg], updated_at: ts }));
        const resumed = await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
        assert.equal(resumed.eventsAggregated, 0, "unchanged legacy totals survive a later rewrite");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test("Cline retains cursors when discovery temporarily omits an existing transcript", async () => {
  const home = setupFixture({ sessions: [{
    id: "fixture-omitted", messages: [{
      id: "turn", role: "assistant", ts: Date.UTC(2026, 8, 19), metrics: { inputTokens: 100 },
    }],
  }] });
  try {
    const queuePath = path.join(home, "queue.jsonl");
    const cursors = {};
    const sessionFiles = resolveClineSessionFiles(fakeEnv(home));
    await parseClineIncremental({ sessionFiles, cursors, queuePath });
    await parseClineIncremental({ sessionFiles: [], cursors, queuePath });
    const resumed = await parseClineIncremental({ sessionFiles, cursors, queuePath });
    assert.equal(resumed.eventsAggregated, 0);
    assert.equal(queueRows(queuePath).length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline parser retains missing-root ledgers without a completed scan", async (t) => {
  for (const discovery of ["automatic", "unverified-file-list"]) {
    await t.test(discovery, async () => {
      const home = setupFixture({ sessions: [{
        id: "fixture-gap", messages: [{
          id: "turn", role: "assistant", ts: Date.UTC(2026, 8, 19), metrics: { inputTokens: 100 },
        }],
      }] });
      try {
        const queuePath = path.join(home, "queue.jsonl");
        const cursors = {};
        const env = fakeEnv(home);
        const sessionsDir = path.join(home, "data", "sessions");
        const parkedDir = path.join(home, "parked-sessions");
        await parseClineIncremental({ cursors, queuePath, env });
        const before = JSON.parse(JSON.stringify(cursors.cline));
        fs.renameSync(sessionsDir, parkedDir);
        await parseClineIncremental({
          ...(discovery === "unverified-file-list" ? { sessionFiles: [] } : {}),
          ...(discovery === "unverified-file-list" ? { scanCompleteRoots: [] } : {}),
          cursors, queuePath, env,
        });
        assert.deepEqual(cursors.cline.fileOffsets, before.fileOffsets);
        assert.deepEqual(
          JSON.parse(JSON.stringify(cursors.cline.messageTotalsByFile)), before.messageTotalsByFile,
        );
        fs.renameSync(parkedDir, sessionsDir);
        const resumed = await parseClineIncremental({ cursors, queuePath, env });
        assert.equal(resumed.eventsAggregated, 0);
        assert.equal(queueRows(queuePath).length, 1);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test("Cline reads the checked file even if its path is replaced, then detects the replacement", async (t) => {
  const home = setupFixture({ sessions: [] });
  try {
    const sessionId = "fixture-race";
    const message = (id, inputTokens) => ({
      id, role: "assistant", ts: Date.UTC(2026, 8, 19, 18, 40),
      modelInfo: { id: "fixture-model" }, metrics: { inputTokens, outputTokens: 10 },
    });
    writeMessages(home, sessionId, [message("old", 100)]);
    const files = resolveClineSessionFiles(fakeEnv(home));
    const filePath = files[0].filePath;
    const fixedTime = new Date("2026-09-19T19:00:00Z");
    fs.utimesSync(filePath, fixedTime, fixedTime);
    const read = fs.readFileSync;
    let replaced = false;
    let readDescriptor;
    t.mock.method(fs, "readFileSync", (target, ...args) => {
      if (!replaced && (typeof target === "number" || target === filePath)) {
        replaced = true;
        readDescriptor = target;
        fs.renameSync(filePath, `${filePath}.old`);
        writeMessages(home, sessionId, [message("new", 200)]);
        // Equal size and mtime make inode identity necessary on the next sync.
        fs.utimesSync(filePath, fixedTime, fixedTime);
      }
      return read(target, ...args);
    });
    const cursors = {};
    const queuePath = path.join(home, "queue.jsonl");
    await parseClineIncremental({ sessionFiles: files, cursors, queuePath });
    assert.equal(queueRows(queuePath).at(-1).total_tokens, 110);
    assert.equal(typeof readDescriptor, "number");
    assert.throws(() => fs.fstatSync(readDescriptor), { code: "EBADF" });
    await parseClineIncremental({ sessionFiles: files, cursors, queuePath });
    assert.equal(queueRows(queuePath).at(-1).total_tokens, 320);
    const idle = await parseClineIncremental({ sessionFiles: files, cursors, queuePath });
    assert.equal(idle.recordsProcessed, 0);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline preserves precise file identity across serialized syncs", async (t) => {
  for (const changedField of ["ino", "dev", "mtimeNs"]) {
    await t.test(changedField, async (t) => {
      const home = setupFixture({ sessions: [] });
      try {
        const sessionId = "fixture-precise";
        const turn = (inputTokens, cost) => ({
          id: "fixture-message", role: "assistant", ts: Date.UTC(2026, 8, 19, 18, 40),
          modelInfo: { id: "fixture-model" }, metrics: { inputTokens, outputTokens: 10, cost },
        });
        writeMessages(home, sessionId, [turn(100, 0.1)]);
        const sessionFiles = resolveClineSessionFiles(fakeEnv(home));
        const filePath = sessionFiles[0].filePath;
        const queuePath = path.join(home, "queue.jsonl");
        // Synthetic filesystem metadata: distinct values collide as JavaScript numbers.
        const metadata = { ino: 2n ** 55n, dev: 2n ** 55n, mtimeNs: 1_789_832_750_000_000_000n };
        assert.equal(Number(metadata[changedField]), Number(metadata[changedField] + 1n));
        const fstat = fs.fstatSync;
        t.mock.method(fs, "fstatSync", (fd, options) => {
          const stat = fstat(fd, options);
          if (options?.bigint) {
            Object.assign(stat, metadata, { mtimeMs: metadata.mtimeNs / 1_000_000n });
          } else {
            Object.assign(stat, {
              ino: Number(metadata.ino), dev: Number(metadata.dev),
              mtimeMs: Number(metadata.mtimeNs) / 1_000_000,
            });
          }
          return stat;
        });
        let cursors = {};
        await parseClineIncremental({ sessionFiles, cursors, queuePath });
        cursors = JSON.parse(JSON.stringify(cursors));
        metadata[changedField] += 1n;
        writeMessages(home, sessionId, [turn(200, 0.2)]);
        const changed = await parseClineIncremental({ sessionFiles, cursors, queuePath });
        assert.equal(changed.eventsAggregated, 1, `${changedField} change must trigger a read`);
        const row = queueRows(queuePath).at(-1);
        assert.equal(row.total_tokens, 210);
        assert.equal(row.total_cost_usd, 0.2);
        assert.equal(row.conversation_count, 1);
        const offset = cursors.cline.fileOffsets[filePath];
        for (const key of ["size", "ino", "dev", "mtimeNs"]) {
          assert.equal(typeof offset[key], "string");
        }
        assert.equal(offset[changedField], metadata[changedField].toString());
        cursors = JSON.parse(JSON.stringify(cursors));
        const before = queueRows(queuePath).length;
        const idle = await parseClineIncremental({ sessionFiles, cursors, queuePath });
        assert.equal(idle.recordsProcessed, 0);
        assert.equal(queueRows(queuePath).length, before);
      } finally {
        t.mock.restoreAll();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test("Cline upgrades numeric file cursors without replaying counted usage", async () => {
  const home = setupFixture({ sessions: [] });
  try {
    const sessionId = "fixture-legacy";
    writeMessages(home, sessionId, [{
      id: "fixture-message", role: "assistant", ts: Date.UTC(2026, 8, 19, 18, 40),
      modelInfo: { id: "fixture-model" }, metrics: { inputTokens: 100, outputTokens: 10 },
    }]);
    const sessionFiles = resolveClineSessionFiles(fakeEnv(home));
    const filePath = sessionFiles[0].filePath;
    const queuePath = path.join(home, "queue.jsonl");
    let cursors = {};
    await parseClineIncremental({ sessionFiles, cursors, queuePath });
    const fd = fs.openSync(filePath, "r");
    try {
      const stat = fs.fstatSync(fd);
      cursors.cline.fileOffsets[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    } finally {
      fs.closeSync(fd);
    }
    cursors = JSON.parse(JSON.stringify(cursors));
    const before = queueRows(queuePath).length;
    const upgraded = await parseClineIncremental({ sessionFiles, cursors, queuePath });
    assert.equal(upgraded.recordsProcessed, 1, "old file metadata is rechecked once");
    assert.equal(upgraded.eventsAggregated, 0, "retained message totals prevent replay");
    assert.equal(queueRows(queuePath).length, before);
    assert.equal(typeof cursors.cline.fileOffsets[filePath].mtimeNs, "string");
    cursors = JSON.parse(JSON.stringify(cursors));
    const idle = await parseClineIncremental({ sessionFiles, cursors, queuePath });
    assert.equal(idle.recordsProcessed, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("parseClineIncremental skips turns without usage and counts them once they arrive", async () => {
  const ts = Date.UTC(2026, 8, 19, 19, 10, 0);
  const home = setupFixture({ sessions: [] });
  const sessionId = "session_pending";
  const metricsless = { id: "msg_pending", role: "assistant", ts, modelInfo: { id: "m" } };
  writeMessages(
    home,
    sessionId,
    [
      { id: "msg_user", role: "user", ts, content: [] },
      metricsless,
      // metrics present but empty — Cline writes the shape before the numbers
      { id: "msg_empty", role: "assistant", ts: ts + 1000, metrics: {} },
      // no timestamp: cannot be bucketed
      { id: "msg_no_ts", role: "assistant", metrics: { inputTokens: 9, outputTokens: 1 } },
      // assistant text with all-zero usage: nothing consumed yet
      {
        id: "msg_zero",
        role: "assistant",
        ts: ts + 2000,
        metrics: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ],
  );

  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  const files = () => resolveClineSessionFiles(fakeEnv(home));
  const first = await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
  assert.equal(first.recordsProcessed, 2, "only turns carrying a metrics object are iterated");
  assert.equal(first.eventsAggregated, 0, "no usage yet");
  assert.equal(queueRows(queuePath).filter((r) => r.source === "cline").length, 0);

  // The pending turn completes: it must be counted in FULL (a placeholder must
  // never latch a partial total).
  writeMessages(
    home,
    sessionId,
    [
      { id: "msg_user", role: "user", ts, content: [] },
      { ...metricsless, metrics: { inputTokens: 700, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ],
  );
  const second = await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
  assert.equal(second.eventsAggregated, 1);
  const row = lastRowForKey(queueRows(queuePath), {
    model: "m",
    hourStart: "2026-09-19T19:00:00.000Z",
  });
  assert.equal(row.input_tokens, 700);
  assert.equal(row.output_tokens, 80);
  fs.rmSync(home, { recursive: true, force: true });
});

test("parseClineIncremental reports progress and tolerates unreadable transcripts", async () => {
  const home = setupFixture({ sessions: [{ id: "session_ok", messages: [] }] });
  const sessionsDir = path.join(home, "data", "sessions");
  // A directory whose transcript is not valid JSON must be skipped, not thrown.
  fs.mkdirSync(path.join(sessionsDir, "session_broken"), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "session_broken", "session_broken.messages.json"), "{oops");

  const progress = [];
  const res = await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors: {},
    queuePath: path.join(home, "queue.jsonl"),
    onProgress: (p) => progress.push(p),
  });
  assert.equal(res.recordsProcessed, 0);
  assert.equal(progress.length, 2, "one progress tick per transcript");
  assert.deepEqual(
    progress.map((p) => p.index),
    [1, 2],
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test("Cline closes transcript descriptors on unchanged, malformed and failed reads", async (t) => {
  for (const scenario of ["unchanged", "malformed", "read-error"]) {
    await t.test(scenario, async (t) => {
      const home = setupFixture({ sessions: [{ id: "fixture-close", messages: [] }] });
      try {
        const sessionFiles = resolveClineSessionFiles(fakeEnv(home));
        const filePath = sessionFiles[0].filePath;
        const cursors = {};
        const queuePath = path.join(home, "queue.jsonl");
        if (scenario === "unchanged") {
          await parseClineIncremental({ sessionFiles, cursors, queuePath });
        } else if (scenario === "malformed") {
          fs.writeFileSync(filePath, "{incomplete");
        }
        const open = fs.openSync;
        const read = fs.readFileSync;
        let descriptor;
        t.mock.method(fs, "openSync", (target, ...args) => {
          const fd = open(target, ...args);
          if (target === filePath) descriptor = fd;
          return fd;
        });
        t.mock.method(fs, "readFileSync", (target, ...args) => {
          if (target === descriptor && scenario === "read-error") {
            throw Object.assign(new Error("synthetic transcript read failure"), { code: "EIO" });
          }
          return read(target, ...args);
        });
        const result = await parseClineIncremental({ sessionFiles, cursors, queuePath });
        assert.equal(result.eventsAggregated, 0);
        assert.equal(typeof descriptor, "number");
        assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
        if (scenario !== "unchanged") {
          assert.equal(cursors.cline.fileOffsets[filePath], undefined);
        }
      } finally {
        t.mock.restoreAll();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
