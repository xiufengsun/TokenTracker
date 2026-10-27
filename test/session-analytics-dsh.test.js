/**
 * DeepSeek Harness (dsh) session-browser reader test.
 *
 * The harness persists one append-only JSONL log per session under
 * "$DSH_HOME/sessions/<project-key>/<session-id>/session[.vN].jsonl[.zstd]".
 * This suite builds synthetic trees under a tempdir and verifies that the
 * session browser:
 *   - counts each assistant usage event once and never keeps prompt or
 *     tool-argument text in the row or the sidecar
 *   - attributes a replayed (seeded) transcript to the log that created the
 *     messages, so a fork cannot bill the parent's tokens twice
 *   - links a subagent session to its parent thread while a fork is reported
 *     as a branch of it
 *   - discovers zstd, versioned and legacy artifacts and picks one per session
 *   - drops handshake-only sessions and ignores the terminal seed marker's
 *     timestamp
 *   - plugs into buildSessionAnalytics off $DSH_HOME
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { test } = require("node:test");

const {
  buildSessionAnalytics,
  discoverSessionFiles,
  listSessionsForBrowser,
  resolveSessionSidecarPath,
  sessionsToCsv,
} = require("../src/lib/session-analytics");
const {
  discoverDshSessionFiles,
  dshTranscriptCacheStatsForTests,
  readDshSessions,
  resetDshTranscriptCacheForTests,
  setDshTranscriptCacheEventLimitForTests,
} = require("../src/lib/dsh-session");
const { scanDshSessions } = require("../src/lib/session-analytics");

const T0 = Date.UTC(2026, 4, 1, 12, 0, 0);
const SECRET = "private prompt text and tool arguments";
const PARENT_ID = "8f1c9d42-0000-4000-8000-000000000001";
const CHILD_ID = "8f1c9d42-0000-4000-8000-000000000002";
const FORK_ID = "8f1c9d42-0000-4000-8000-000000000003";
const PARENT_SESSION = "session-" + PARENT_ID;

// Read a temp harness home through the same path the sidecar uses, so rows are
// finalized (total_tokens, model_usage) exactly as the browser will see them.
async function readRows(dshHome) {
  return scanDshSessions(discoverDshSessionFiles([dshHome]));
}

async function zstdCompress(data) {
  if (typeof zlib.zstdCompressSync === "function") {
    return zlib.zstdCompressSync(data);
  }
  return Buffer.from(await require("@mongodb-js/zstd").compress(data));
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dsh-sessions-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function dshHeader(options) {
  const opts = options || {};
  return Object.assign({
    type: "session",
    version: 4,
    id: opts.id || PARENT_ID,
    createdAt: typeof opts.createdAt === "number" ? opts.createdAt : T0,
    cwd: opts.cwd || "/repo/harness-app",
  }, opts.extra || {});
}

function titleEntry(title, time) {
  return { type: "session/title", seq: 1, time: time || T0 + 500, data: { title: title, messageSeqs: [1], source: { kind: "llm" } } };
}

function userEntry(id, options) {
  const opts = options || {};
  return {
    type: "user/message",
    seq: 2,
    time: typeof opts.time === "number" ? opts.time : T0 + 1000,
    data: { role: "user", id: id, content: [{ type: "text", text: opts.text || SECRET }], source: { kind: "user" } },
  };
}

function assistantEntry(id, options) {
  const opts = options || {};
  return {
    type: "assistant/message",
    seq: 3,
    time: typeof opts.time === "number" ? opts.time : T0 + 2000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: SECRET }],
        source: { kind: "model", provider: "deepseek-official", model: opts.model || "deepseek-v4-pro" },
        id: id,
      },
      usage: {
        inputTokens: typeof opts.input === "number" ? opts.input : 100,
        outputTokens: typeof opts.output === "number" ? opts.output : 20,
        cacheReadTokens: typeof opts.cacheRead === "number" ? opts.cacheRead : 0,
        cacheWriteTokens: typeof opts.cacheWrite === "number" ? opts.cacheWrite : 0,
        reasoningTokens: typeof opts.reasoningTokens === "number" ? opts.reasoningTokens : 0,
      },
      stream: false,
    },
  };
}

function toolEntry(callId, name, options) {
  const opts = options || {};
  return {
    type: "tool/call",
    seq: 4,
    time: typeof opts.time === "number" ? opts.time : T0 + 2500,
    data: { turn: 1, step: 1, callId: callId, name: name, arguments: { path: SECRET } },
  };
}

function endSeedEntry(time) {
  return { type: "session/end-seed", seq: 9, time: time, data: {} };
}

async function writeTranscript(dshHome, options) {
  const opts = options || {};
  const project = opts.project || "--repo-harness-app--";
  const session = opts.session || PARENT_ID;
  const name = opts.name || "session.v4.jsonl";
  const dir = path.join(dshHome, "sessions", project, session);
  fs.mkdirSync(dir, { recursive: true });
  const text = opts.records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const file = path.join(dir, name);
  if (opts.zstd) {
    // Split across two frames: the harness appends one frame per flush.
    const bytes = Buffer.concat([
      await zstdCompress(Buffer.from(text.slice(0, 60))),
      await zstdCompress(Buffer.from(text.slice(60))),
    ]);
    fs.writeFileSync(file, bytes);
  } else {
    fs.writeFileSync(file, text);
  }
  return file;
}

test("DSH sessions count assistant usage once and keep bodies out of the row", async (t) => {
  const dshHome = path.join(fixture(t), ".dsh");
  await writeTranscript(dshHome, {
    records: [
      dshHeader(),
      titleEntry("Investigate importer"),
      titleEntry("Investigate importer failure"),
      userEntry("u-1"),
      assistantEntry("m-1", { input: 100, output: 20, cacheRead: 40 }),
      // Re-emitted on replay: same message id, same usage -> one charge.
      assistantEntry("m-1", { input: 100, output: 20, cacheRead: 40 }),
      toolEntry("c-1", "edit"),
      toolEntry("c-2", "subagent"),
      assistantEntry("m-2", { time: T0 + 3000, input: 50, output: 10 }),
    ],
  });

  const rows = await readRows(dshHome);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.session_id, PARENT_ID);
  assert.equal(row.title, "Investigate importer failure");
  assert.equal(row.project_ref, "/repo/harness-app");
  assert.equal(row.turns, 1);
  assert.equal(row.edit_turns, 1);
  assert.equal(row.subagent_calls, 1);
  assert.deepEqual(row.subagent_types, { subagent: 1 });
  assert.equal(row.model, "deepseek-v4-pro");
  assert.deepEqual(row.tokens, {
    input_tokens: 150,
    cached_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 30,
    reasoning_output_tokens: 0,
    total_tokens: 220,
  });
  assert.equal(JSON.stringify(row).includes(SECRET), false);

  const browser = listSessionsForBrowser(rows);
  assert.equal(browser.session_count, 1);
  assert.equal(browser.sessions[0].source, "dsh");
  assert.equal(browser.sessions[0].thread_kind, "root");

  const csv = sessionsToCsv(rows);
  assert.match(csv, /"dsh"/);
  assert.equal(csv.includes(SECRET), false);
});

test("a seeded fork is attributed to the transcript that created each message", async (t) => {
  const dshHome = path.join(fixture(t), ".dsh");
  await writeTranscript(dshHome, {
    session: "parent-session",
    records: [
      dshHeader({ id: PARENT_SESSION }),
      titleEntry("Parent run"),
      userEntry("u-parent"),
      assistantEntry("m-parent", { input: 100, output: 20 }),
    ],
  });
  await writeTranscript(dshHome, {
    session: "fork-session",
    records: [
      // Fork: the harness replays the parent log, then continues on its own.
      dshHeader({
        id: "session-" + FORK_ID,
        createdAt: T0 + 60000,
        extra: { isSeeded: true, parentSession: PARENT_SESSION },
      }),
      userEntry("u-parent", { time: T0 + 1000 }),
      assistantEntry("m-parent", { time: T0 + 2000, input: 100, output: 20 }),
      userEntry("u-fork", { time: T0 + 61000 }),
      assistantEntry("m-fork", { time: T0 + 62000, input: 7, output: 3 }),
    ],
  });

  const rows = await readRows(dshHome);
  assert.equal(rows.length, 2);
  const parent = rows.find((row) => row.session_id === PARENT_ID);
  const fork = rows.find((row) => row.session_id === FORK_ID);
  assert.equal(parent.tokens.total_tokens, 120);
  // Only the fork's own message counts; the replay belongs to the parent.
  assert.equal(fork.tokens.total_tokens, 10);
  assert.equal(fork.forked_from_id, PARENT_ID);
  assert.equal(fork.parent_session_id, null);
  assert.equal(parent.forked_from_id, null);
  assert.equal(parent.tokens.total_tokens + fork.tokens.total_tokens, 130);
});

test("subagent sessions link to their parent thread and a root session does not", async (t) => {
  const dshHome = path.join(fixture(t), ".dsh");
  await writeTranscript(dshHome, {
    session: "parent-session",
    records: [
      dshHeader({ id: PARENT_SESSION }),
      userEntry("u-parent"),
      assistantEntry("m-parent"),
    ],
  });
  await writeTranscript(dshHome, {
    session: CHILD_ID,
    records: [
      dshHeader({
        id: CHILD_ID,
        createdAt: T0 + 5000,
        extra: { origin: "subagent", delegationDepth: 1, parentSession: PARENT_SESSION },
      }),
      userEntry("u-child"),
      assistantEntry("m-child", { time: T0 + 6000, input: 11, output: 4 }),
    ],
  });

  const rows = await readRows(dshHome);
  const child = rows.find((row) => row.session_id === CHILD_ID);
  assert.equal(child.parent_session_id, PARENT_ID);
  assert.equal(child.forked_from_id, null);
  assert.equal(child.thread_source, "subagent");

  const browser = listSessionsForBrowser(rows, {});
  const browserRow = (sessionId) => browser.sessions.find((row) => row.session_id === sessionId) || {};
  const kindOf = (sessionId) => browserRow(sessionId).thread_kind || null;
  assert.equal(kindOf(CHILD_ID), "subagent");
  assert.equal(kindOf(PARENT_ID), "root");
  // The dashboard nests on parent_session_hash and rolls child usage into the
  // root, so a dsh thread has to publish the same aggregate every other
  // thread-aware source does.
  assert.equal(browserRow(CHILD_ID).parent_session_hash, browserRow(PARENT_ID).session_hash);
  assert.equal(browserRow(PARENT_ID).direct_subagent_count, 1);
  assert.equal(browserRow(PARENT_ID).descendant_subagent_count, 1);
  assert.equal(browserRow(PARENT_ID).subagent_total_tokens, child.tokens.total_tokens);
  assert.equal(browserRow(PARENT_ID).combined_total_tokens,
    browserRow(PARENT_ID).own_total_tokens + child.tokens.total_tokens);
});

test("zstd, versioned and legacy artifacts are discovered once per session", async (t) => {
  const dshHome = path.join(fixture(t), ".dsh");
  const compressed = await writeTranscript(dshHome, {
    records: [dshHeader(), userEntry("u-zstd"), assistantEntry("m-zstd")],
    name: "session.v4.jsonl.zstd",
    zstd: true,
  });
  // A backup copy of another format never becomes a second session row.
  fs.writeFileSync(path.join(path.dirname(compressed), "session.jsonl.bak"), "");
  await writeTranscript(dshHome, {
    session: CHILD_ID,
    records: [dshHeader({ id: CHILD_ID }), userEntry("u-legacy"), assistantEntry("m-legacy", { input: 5, output: 5 })],
    name: "session.jsonl",
  });

  const files = discoverDshSessionFiles([dshHome]);
  assert.equal(files.length, 2);
  assert.equal(files.filter((file) => file.endsWith(".zstd")).length, 1);
  assert.equal(files.some((file) => file.endsWith(".bak")), false);

  const rows = await readRows(dshHome);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + row.tokens.total_tokens, 0), 130);
});

test("handshake-only sessions are dropped and the seed marker never extends a session", async (t) => {
  const dshHome = path.join(fixture(t), ".dsh");
  await writeTranscript(dshHome, {
    session: "empty",
    records: [dshHeader({ id: "empty-1" }), endSeedEntry(T0 + 51 * 24 * 3600000)],
  });
  await writeTranscript(dshHome, {
    session: "live",
    records: [
      dshHeader({ id: PARENT_SESSION, createdAt: T0 }),
      userEntry("u-1", { time: T0 + 1000 }),
      assistantEntry("m-1", { time: T0 + 60000 }),
      // Written weeks later (seed finalization) and carries no usage.
      endSeedEntry(T0 + 51 * 24 * 3600000),
    ],
  });

  const rows = await readRows(dshHome);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, PARENT_ID);
  assert.equal(rows[0].ended_at, new Date(T0 + 60000).toISOString());
  assert.equal(rows[0].active_ms, 60000);
});

test("buildSessionAnalytics discovers the fixture harness home and prices the rows", async (t) => {
  const home = fixture(t);
  await writeTranscript(path.join(home, ".dsh"), {
    records: [
      dshHeader(),
      titleEntry("Priced session"),
      userEntry("u-1"),
      assistantEntry("m-1", { input: 1000000, output: 0 }),
    ],
  });
  // An explicit override points at the *machine* harness home, so it must not
  // leak the developer's own transcripts into an unrelated (fixture) home.
  const previous = process.env.DSH_HOME;
  delete process.env.TOKENTRACKER_DSH_HOME;
  process.env.DSH_HOME = path.join(home, "elsewhere", "not-used");
  try {
    const discovered = await discoverSessionFiles(home);
    assert.equal(discovered.dsh.length, 1);
    assert.equal(discovered.dsh[0].startsWith(path.join(home, ".dsh") + path.sep), true);

    const sessions = await buildSessionAnalytics({ home: home, force: true });
    const dshRows = sessions.filter((row) => row.source === "dsh");
    assert.equal(dshRows.length, 1);
    assert.equal(dshRows[0].cost_usd > 0, true);
    assert.equal(fs.existsSync(resolveSessionSidecarPath(home)), true);
    assert.equal(fs.existsSync(resolveSessionSidecarPath(home) + ".meta.json.dsh-incomplete"), false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("injected context messages never open a turn", async (t) => {
  const dshHome = path.join(fixture(t), ".dsh");
  const inject = (kind, text, time) => ({
    type: "user/message",
    seq: 2,
    time: time,
    data: { role: "user", id: "inj-" + kind, content: [{ type: "text", text: text }], source: { kind: kind } },
  });
  await writeTranscript(dshHome, {
    records: [
      dshHeader(),
      // The harness records every injected block as a user-role message. Only
      // the real prompt counts as a turn.
      inject("time-context", "now: 2026-05-01T12:00:00Z", T0 + 900),
      inject("dsh-mnemon", SECRET, T0 + 950),
      userEntry("u-real", { time: T0 + 1000 }),
      assistantEntry("m-1"),
      toolEntry("c-1", "write"),
      inject("skill-catalog", "skills: a, b", T0 + 2100),
      inject("ptc-mode", "mode: ptc", T0 + 2200),
      assistantEntry("m-2", { time: T0 + 3000, input: 10, output: 5 }),
    ],
  });

  const rows = await readRows(dshHome);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turns, 1);
  assert.equal(rows[0].edit_turns, 1);
  assert.equal(JSON.stringify(rows[0]).includes(SECRET), false);
});

test("an unreadable transcript keeps the last complete rows and retries", async (t) => {
  const home = fixture(t);
  const dshHome = path.join(home, ".dsh");
  await writeTranscript(dshHome, {
    session: "readable",
    records: [dshHeader({ id: PARENT_ID }), userEntry("u-1"), assistantEntry("m-1")],
  });

  {
    const first = (await buildSessionAnalytics({ home: home, force: true })).filter((row) => row.source === "dsh");
    assert.equal(first.length, 1);
    assert.equal(first.skippedFiles || 0, 0);

    // One log the reader cannot decode makes the whole batch partial: the
    // readable session must not be cached as a complete inventory that hides it.
    const broken = path.join(dshHome, "sessions", "--repo--", "broken", "session.jsonl.zstd");
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(64, 0x41)]));

    const second = await buildSessionAnalytics({ home: home, force: true });
    const dshRows = second.filter((row) => row.source === "dsh");
    // The readable session is refreshed once - not duplicated by the retained copy.
    assert.equal(dshRows.filter((row) => row.session_id === PARENT_ID).length, 1);
    assert.equal(second.skippedFiles > 0, true);
    assert.equal(fs.existsSync(resolveSessionSidecarPath(home) + ".meta.json.dsh-incomplete"), true);

    fs.rmSync(broken);
    const third = await buildSessionAnalytics({ home: home, force: true });
    assert.equal(third.filter((row) => row.source === "dsh").length, 1);
    assert.equal(fs.existsSync(resolveSessionSidecarPath(home) + ".meta.json.dsh-incomplete"), false);
  }
});

test("appending to a transcript invalidates the cached parse", async (t) => {
  const dshHome = path.join(fixture(t), ".dsh");
  const file = await writeTranscript(dshHome, {
    records: [dshHeader({ id: PARENT_ID }), userEntry("u-1"), assistantEntry("m-1", { input: 100, output: 20 })],
  });

  const first = await readRows(dshHome);
  assert.equal(first[0].tokens.total_tokens, 120);
  // Repeated reads must be stable (the reader memoizes parsed transcripts).
  const again = await readRows(dshHome);
  assert.equal(again[0].tokens.total_tokens, 120);

  fs.appendFileSync(file, JSON.stringify(assistantEntry("m-2", { time: T0 + 5000, input: 30, output: 10 })) + "\n");
  const grown = await readRows(dshHome);
  assert.equal(grown[0].tokens.total_tokens, 160);
});

test("a transcript that disappears before it is read is counted, not dropped", async (t) => {
  const dshHome = path.join(fixture(t), ".dsh");
  const missing = path.join(dshHome, "sessions", "--repo--", "gone", "session.v4.jsonl");
  const skipped = [];
  const rows = await readDshSessions([missing], { onSkip: (filePath, error) => skipped.push({ filePath, error }) });
  assert.equal(rows.length, 0);
  assert.equal(rows.skippedFiles, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].filePath, missing);
  // rollout.readDshSessionText answers null for a missing path, so the reader
  // has to turn that into a failure the caller can see.
  assert.match(String(skipped[0].error && skipped[0].error.message), /missing or unreadable/);
});

test("the transcript cache budget tracks event metadata, not entry count", async (t) => {
  const dshHome = path.join(fixture(t), ".dsh");
  const first = await writeTranscript(dshHome, {
    session: "cache-a",
    records: [dshHeader({ id: PARENT_ID }), userEntry("u-a"), assistantEntry("m-a")],
  });
  const second = await writeTranscript(dshHome, {
    session: "cache-b",
    records: [dshHeader({ id: CHILD_ID }), userEntry("u-b"), assistantEntry("m-b")],
  });
  resetDshTranscriptCacheForTests();
  t.after(() => resetDshTranscriptCacheForTests());
  try {
    // Each transcript parses to two events (one turn, one usage).
    await readDshSessions([first, second]);
    assert.equal(dshTranscriptCacheStatsForTests().size, 2);
    assert.equal(dshTranscriptCacheStatsForTests().events, 4);

    // A cache hit refreshes recency without double counting the events.
    await readDshSessions([first, second]);
    assert.equal(dshTranscriptCacheStatsForTests().size, 2);
    assert.equal(dshTranscriptCacheStatsForTests().events, 4);

    // Shrink the budget, then grow the second transcript to force an eviction.
    setDshTranscriptCacheEventLimitForTests(3);
    fs.appendFileSync(second, JSON.stringify(assistantEntry("m-b2", { time: T0 + 5000 })) + "\n");
    await readDshSessions([first, second]);
    const stats = dshTranscriptCacheStatsForTests();
    assert.equal(stats.size, 1);
    assert.equal(stats.events, 3);
    assert.equal(stats.limit, 3);
  } finally {
    resetDshTranscriptCacheForTests();
  }
});
