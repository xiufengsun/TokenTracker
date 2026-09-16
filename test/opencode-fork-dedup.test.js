// OpenCode `Session.fork` copies every parent message up to the fork point into
// a brand-new session, preserving `time.created` / `time.completed` and the
// per-message token payload verbatim while minting NEW message ids (verified
// against the shipped opencode 1.18.3 binary: `{...p.info, sessionID, id}`).
// The forked session carries NO parentID, so the copies cannot be linked by
// ancestry — only by content. Since TokenTracker dedupes on
// `sessionID|messageID`, the whole copied prefix used to be counted a second
// time (issue #426).
//
// These tests pin the fingerprint-based dedup: identical
// (time.created, time.completed, every token field, model, providerID, source)
// seen in a DIFFERENT session is a fork copy and must be counted once, while
// genuinely distinct calls — and in-place updates of the same message — must
// keep their full authoritative value.

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { openCursorStore } = require("../src/lib/cursor-store");
const { parseOpencodeIncremental, parseOpencodeDbIncremental } = require("../src/lib/rollout");

const HOUR = "2026-08-06T10:00:00.000Z";

function msg({
  id,
  sessionID,
  created,
  completed,
  input = 0,
  output = 0,
  reasoning = 0,
  cached = 0,
  cacheWrite = 0,
  modelID = "claude-sonnet-5",
  providerID = "anthropic-compat",
}) {
  return {
    id,
    sessionID,
    timeUpdated: completed || created,
    data: {
      id,
      sessionID,
      role: "assistant",
      modelID,
      providerID,
      time: { created, completed: completed || created },
      tokens: {
        input,
        output,
        reasoning,
        cache: { read: cached, write: cacheWrite },
      },
    },
  };
}

async function readQueue(queuePath) {
  const text = await fs.readFile(queuePath, "utf8").catch(() => "");
  if (!text.trim()) return [];
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// The queue is append-only with replacement snapshots: the authoritative value
// for a bucket is the LAST line for its (source, model, hour_start) key.
async function queueTotals(queuePath) {
  const rows = await readQueue(queuePath);
  const latest = new Map();
  for (const row of rows) {
    latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  for (const row of latest.values()) {
    for (const key of Object.keys(totals)) totals[key] += row[key] || 0;
  }
  return totals;
}

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-oc-fork-"));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function newCursors() {
  return { version: 1, files: {}, updatedAt: null };
}

test("parseOpencodeDbIncremental counts a fork-copied prefix once and keeps the fork's genuine continuation", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();

    const base = Date.parse(HOUR);
    // Parent session: three real assistant turns.
    const parent = [
      msg({ id: "msg_p1", sessionID: "ses_parent", created: base + 1000, input: 33101, output: 24 }),
      msg({ id: "msg_p2", sessionID: "ses_parent", created: base + 2000, input: 1905, output: 36 }),
      msg({ id: "msg_p3", sessionID: "ses_parent", created: base + 3000, input: 3639, output: 502, cached: 7040 }),
    ];
    // Fork: byte-identical copies of the prefix under new ids + one real
    // continuation turn that exists ONLY in the fork.
    const fork = [
      msg({ id: "msg_f1", sessionID: "ses_fork", created: base + 1000, input: 33101, output: 24 }),
      msg({ id: "msg_f2", sessionID: "ses_fork", created: base + 2000, input: 1905, output: 36 }),
      msg({ id: "msg_f3", sessionID: "ses_fork", created: base + 3000, input: 3639, output: 502, cached: 7040 }),
      msg({ id: "msg_f4", sessionID: "ses_fork", created: base + 9000, input: 555, output: 66 }),
    ];

    const res = await parseOpencodeDbIncremental({
      dbMessages: [...parent, ...fork],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });

    // 3 parent turns + 1 genuine fork continuation = 4 counted events.
    assert.equal(res.eventsAggregated, 4);
    const totals = await queueTotals(queuePath);
    assert.equal(totals.input_tokens, 33101 + 1905 + 3639 + 555);
    assert.equal(totals.output_tokens, 24 + 36 + 502 + 66);
    assert.equal(totals.cached_input_tokens, 7040);

    // Re-running over the exact same DB snapshot must be a no-op.
    const again = await parseOpencodeDbIncremental({
      dbMessages: [...parent, ...fork],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal(again.eventsAggregated, 0);
    assert.equal(again.bucketsQueued, 0);
    assert.deepEqual(await queueTotals(queuePath), totals);
  });
});

test("sharded OpenCode cursors load only the batch state and preserve fork dedup", async () => {
  await withTmp(async (tmp) => {
    const trackerDir = path.join(tmp, "tracker");
    const cursorsPath = path.join(trackerDir, "cursors.json");
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);
    const parent = msg({
      id: "msg_parent",
      sessionID: "ses_parent",
      created: base + 1000,
      input: 4000,
      output: 40,
    });
    const fork = msg({
      id: "msg_fork",
      sessionID: "ses_fork",
      created: base + 1000,
      input: 4000,
      output: 40,
    });

    await parseOpencodeDbIncremental({
      dbMessages: [parent],
      cursors,
      queuePath,
      source: "opencode",
    });
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(cursorsPath, `${JSON.stringify(cursors)}\n`, "utf8");
    const migrated = await openCursorStore({ trackerDir, cursorsPath, forceV2: true });
    await migrated.commit();

    const store = await openCursorStore({ trackerDir, cursorsPath });
    const result = await parseOpencodeDbIncremental({
      dbMessages: [fork],
      cursors: store.cursors,
      queuePath,
      source: "opencode",
      opencodeCursorStore: store,
    });
    assert.equal(result.eventsAggregated, 0);
    assert.equal((await queueTotals(queuePath)).input_tokens, 4000);
    assert.equal(store.opencodeMessageShardLoadCount, 1);
    assert.equal(store.opencodeFingerprintShardLoadCount, 1);
    assert.equal(store.cursors.opencode.messages["ses_fork|msg_fork"].dedupedForkCopy, true);
    const beforeCommit = await parseOpencodeDbIncremental({
      dbMessages: [fork],
      cursors: store.cursors,
      queuePath,
      source: "opencode",
      opencodeCursorStore: store,
    });
    assert.equal(beforeCommit.eventsAggregated, 0);
    assert.equal(store.cursors.opencode.messages["ses_fork|msg_fork"].dedupedForkCopy, true);
    await store.commit();

    const reopened = await openCursorStore({ trackerDir, cursorsPath });
    const again = await parseOpencodeDbIncremental({
      dbMessages: [fork],
      cursors: reopened.cursors,
      queuePath,
      source: "opencode",
      opencodeCursorStore: reopened,
    });
    assert.equal(again.eventsAggregated, 0);
    assert.equal(again.bucketsQueued, 0);
    assert.equal((await queueTotals(queuePath)).input_tokens, 4000);
  });
});

test("parseOpencodeDbIncremental dedupes a fork discovered in a LATER sync run", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);

    const parent = [
      msg({ id: "msg_p1", sessionID: "ses_parent", created: base + 1000, input: 4000, output: 40 }),
      msg({ id: "msg_p2", sessionID: "ses_parent", created: base + 2000, input: 5000, output: 50 }),
    ];
    await parseOpencodeDbIncremental({
      dbMessages: parent,
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    const afterParent = await queueTotals(queuePath);
    assert.equal(afterParent.input_tokens, 9000);

    // User forks the session; next sync sees parent + fork copies.
    const fork = [
      msg({ id: "msg_f1", sessionID: "ses_fork", created: base + 1000, input: 4000, output: 40 }),
      msg({ id: "msg_f2", sessionID: "ses_fork", created: base + 2000, input: 5000, output: 50 }),
    ];
    const res = await parseOpencodeDbIncremental({
      dbMessages: [...parent, ...fork],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal(res.eventsAggregated, 0);
    assert.deepEqual(await queueTotals(queuePath), afterParent);
  });
});

test("parseOpencodeDbIncremental repairs fork copies counted before fingerprints existed", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);
    const parent = msg({
      id: "msg_parent",
      sessionID: "ses_parent",
      created: base + 1000,
      input: 1000,
      output: 100,
    });
    const fork = msg({
      id: "msg_fork",
      sessionID: "ses_fork",
      created: base + 1000,
      input: 1000,
      output: 100,
    });

    await parseOpencodeDbIncremental({
      dbMessages: [parent],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });

    // Recreate the state shipped before #426: both session/message ids were
    // present and both snapshots had already been added to the same bucket.
    const parentEntry = cursors.opencode.messages["ses_parent|msg_parent"];
    cursors.opencode.messages["ses_fork|msg_fork"] = {
      lastTotals: { ...parentEntry.lastTotals },
      fingerprint: parentEntry.fingerprint,
      updatedAt: new Date().toISOString(),
    };
    const bucket = Object.values(cursors.hourly.buckets)[0];
    for (const key of Object.keys(bucket.totals)) bucket.totals[key] *= 2;
    bucket.queuedKey = null;

    const repaired = await parseOpencodeDbIncremental({
      dbMessages: [parent, fork],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal(repaired.eventsAggregated, 0);
    assert.equal((await queueTotals(queuePath)).input_tokens, 1000);
    assert.equal((await queueTotals(queuePath)).output_tokens, 100);
    assert.equal(bucket.totals.conversation_count, 1);
    assert.equal(
      cursors.opencode.messages["ses_fork|msg_fork"].dedupedForkCopy,
      true,
    );

    const afterRepair = await queueTotals(queuePath);
    await parseOpencodeDbIncremental({
      dbMessages: [parent, fork],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.deepEqual(await queueTotals(queuePath), afterRepair, "repair must be idempotent");
    assert.equal(bucket.totals.conversation_count, 1);
  });
});

test("parseOpencodeDbIncremental dedupes a fork seen BEFORE its parent (order independence)", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);

    const parent = msg({ id: "msg_p1", sessionID: "ses_parent", created: base + 1000, input: 4000, output: 40 });
    const forkCopy = msg({ id: "msg_f1", sessionID: "ses_fork", created: base + 1000, input: 4000, output: 40 });

    // Fork copy first in iteration order.
    const res = await parseOpencodeDbIncremental({
      dbMessages: [forkCopy, parent],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal(res.eventsAggregated, 1);
    const totals = await queueTotals(queuePath);
    assert.equal(totals.input_tokens, 4000);
    assert.equal(totals.output_tokens, 40);
  });
});

test("parseOpencodeDbIncremental keeps genuinely distinct calls that merely share token counts", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);

    const messages = [
      // Same token counts + same model, DIFFERENT timestamps: two real calls.
      msg({ id: "msg_a", sessionID: "ses_a", created: base + 1000, input: 1200, output: 30 }),
      msg({ id: "msg_b", sessionID: "ses_b", created: base + 4000, input: 1200, output: 30 }),
      // Same timestamp, DIFFERENT token counts: two real parallel sub-agents.
      msg({ id: "msg_c", sessionID: "ses_c", created: base + 6000, input: 800, output: 20 }),
      msg({ id: "msg_d", sessionID: "ses_d", created: base + 6000, input: 801, output: 20 }),
      // Same timestamp + same tokens, DIFFERENT model: not a fork copy.
      msg({ id: "msg_e", sessionID: "ses_e", created: base + 8000, input: 700, output: 10, modelID: "claude-sonnet-5" }),
      msg({ id: "msg_f", sessionID: "ses_f", created: base + 8000, input: 700, output: 10, modelID: "gpt-5.4" }),
      // Same timestamp + same tokens + same model, DIFFERENT provider.
      msg({ id: "msg_g", sessionID: "ses_g", created: base + 9000, input: 600, output: 5, providerID: "p1" }),
      msg({ id: "msg_h", sessionID: "ses_h", created: base + 9000, input: 600, output: 5, providerID: "p2" }),
    ];

    const res = await parseOpencodeDbIncremental({
      dbMessages: messages,
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal(res.eventsAggregated, 8);
    const totals = await queueTotals(queuePath);
    assert.equal(totals.input_tokens, 1200 + 1200 + 800 + 801 + 700 + 700 + 600 + 600);
    assert.equal(totals.output_tokens, 30 + 30 + 20 + 20 + 10 + 10 + 5 + 5);
  });
});

test("parseOpencodeDbIncremental never drops a same-session duplicate (fork always creates a new session)", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);

    const res = await parseOpencodeDbIncremental({
      dbMessages: [
        msg({ id: "msg_1", sessionID: "ses_same", created: base + 1000, input: 900, output: 9 }),
        msg({ id: "msg_2", sessionID: "ses_same", created: base + 1000, input: 900, output: 9 }),
      ],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal(res.eventsAggregated, 2);
    const totals = await queueTotals(queuePath);
    assert.equal(totals.input_tokens, 1800);
  });
});

test("fork dedup scans past same-session fingerprint owners", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);
    const owner = msg({ id: "msg_1", sessionID: "ses_same", created: base + 1000, input: 100 });
    await parseOpencodeDbIncremental({
      dbMessages: [owner],
      cursors,
      queuePath,
      source: "opencode",
    });

    const ownerEntry = cursors.opencode.messages["ses_same|msg_1"];
    cursors.opencode.messages["ses_other|msg_2"] = { ...ownerEntry };
    const fork = msg({ id: "msg_3", sessionID: "ses_same", created: base + 1000, input: 100 });
    const result = await parseOpencodeDbIncremental({
      dbMessages: [fork],
      cursors,
      queuePath,
      source: "opencode",
    });

    assert.equal(result.eventsAggregated, 0);
    assert.equal((await queueTotals(queuePath)).input_tokens, 100);
    assert.equal(cursors.opencode.messages["ses_same|msg_3"].dedupedForkCopy, true);
  });
});

test("fingerprint ownership keeps alternate same-session owners after a correction", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);
    const first = msg({ id: "msg_1", sessionID: "ses_same", created: base + 1000, input: 100 });
    const second = msg({ id: "msg_2", sessionID: "ses_same", created: base + 1000, input: 100 });
    await parseOpencodeDbIncremental({
      dbMessages: [first, second],
      cursors,
      queuePath,
      source: "opencode",
    });

    const corrected = msg({ id: "msg_1", sessionID: "ses_same", created: base + 1000, input: 200 });
    const fork = msg({ id: "msg_fork", sessionID: "ses_other", created: base + 1000, input: 100 });
    const result = await parseOpencodeDbIncremental({
      dbMessages: [corrected, fork],
      cursors,
      queuePath,
      source: "opencode",
    });

    assert.equal(result.eventsAggregated, 1);
    assert.equal((await queueTotals(queuePath)).input_tokens, 300);
    assert.equal(cursors.opencode.messages["ses_other|msg_fork"].dedupedForkCopy, true);
  });
});

test("parseOpencodeDbIncremental keeps the authoritative value of an in-place message update", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);

    // Persisted mid-stream at 5 output tokens…
    await parseOpencodeDbIncremental({
      dbMessages: [msg({ id: "msg_1", sessionID: "ses_1", created: base + 1000, input: 100, output: 5 })],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal((await queueTotals(queuePath)).output_tokens, 5);

    // …then finalized at 8. The bucket must hold 8, never 5 + 8 = 13.
    await parseOpencodeDbIncremental({
      dbMessages: [msg({ id: "msg_1", sessionID: "ses_1", created: base + 1000, input: 100, output: 8 })],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    let totals = await queueTotals(queuePath);
    assert.equal(totals.output_tokens, 8);
    assert.equal(totals.input_tokens, 100);
    assert.equal(Object.values(cursors.hourly.buckets)[0].totals.conversation_count, 1);

    // A later authoritative correction can lower one column while raising
    // another. Replace the prior snapshot; do not add a second conversation.
    await parseOpencodeDbIncremental({
      dbMessages: [msg({
        id: "msg_1",
        sessionID: "ses_1",
        created: base + 1000,
        input: 100,
        output: 5,
        cached: 3,
      })],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    totals = await queueTotals(queuePath);
    assert.equal(totals.output_tokens, 5);
    assert.equal(totals.cached_input_tokens, 3);
    assert.equal(totals.input_tokens, 100);
    assert.equal(Object.values(cursors.hourly.buckets)[0].totals.conversation_count, 1);

    // A fork taken AFTER correction still dedupes against the final value.
    const res = await parseOpencodeDbIncremental({
      dbMessages: [
        msg({ id: "msg_1", sessionID: "ses_1", created: base + 1000, input: 100, output: 5, cached: 3 }),
        msg({ id: "msg_f", sessionID: "ses_fork", created: base + 1000, input: 100, output: 5, cached: 3 }),
      ],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    assert.equal(res.eventsAggregated, 0);
    assert.deepEqual(await queueTotals(queuePath), totals);
  });
});

test("parseOpencodeDbIncremental moves an updated message between model/time buckets", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);

    await parseOpencodeDbIncremental({
      dbMessages: [msg({
        id: "msg_move",
        sessionID: "ses_move",
        created: base + 1000,
        completed: base + 1000,
        input: 50,
        output: 10,
        modelID: "model-a",
      })],
      cursors,
      queuePath,
      source: "opencode",
    });
    await parseOpencodeDbIncremental({
      dbMessages: [msg({
        id: "msg_move",
        sessionID: "ses_move",
        created: base + 1000,
        completed: base + 31 * 60 * 1000,
        input: 50,
        output: 10,
        modelID: "model-b",
      })],
      cursors,
      queuePath,
      source: "opencode",
    });

    const totals = await queueTotals(queuePath);
    assert.equal(totals.input_tokens, 50);
    assert.equal(totals.output_tokens, 10);
    const buckets = Object.values(cursors.hourly.buckets);
    assert.equal(buckets.filter((bucket) => bucket.totals.conversation_count === 1).length, 1);
    assert.equal(buckets.reduce((sum, bucket) => sum + bucket.totals.conversation_count, 0), 1);
  });
});

test("fork dedup is scoped per cursor namespace (opencode fork variants stay independent)", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);

    // Same shape under two different OpenCode-fork products. Distinct DBs,
    // distinct namespaces — neither may silence the other.
    await parseOpencodeDbIncremental({
      dbMessages: [msg({ id: "msg_1", sessionID: "ses_1", created: base + 1000, input: 2000, output: 20 })],
      cursors,
      queuePath,
      source: "opencode",
      cursorKey: "opencode",
    });
    const res = await parseOpencodeDbIncremental({
      dbMessages: [msg({ id: "msg_2", sessionID: "ses_2", created: base + 1000, input: 2000, output: 20 })],
      cursors,
      queuePath,
      source: "zcode",
      cursorKey: "zcode",
    });
    assert.equal(res.eventsAggregated, 1);

    const totals = await queueTotals(queuePath);
    assert.equal(totals.input_tokens, 4000);
    assert.equal(totals.output_tokens, 40);
  });
});

test("parseOpencodeIncremental (JSON storage) dedupes fork-copied message files", async () => {
  await withTmp(async (tmp) => {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = newCursors();
    const base = Date.parse(HOUR);

    const write = async (name, m) => {
      const file = path.join(tmp, name);
      await fs.writeFile(file, JSON.stringify(m.data), "utf8");
      return file;
    };

    const parentFile = await write(
      "parent.json",
      msg({ id: "msg_p1", sessionID: "ses_parent", created: base + 1000, input: 7000, output: 70 }),
    );
    const forkFile = await write(
      "fork.json",
      msg({ id: "msg_f1", sessionID: "ses_fork", created: base + 1000, input: 7000, output: 70 }),
    );
    const forkNewFile = await write(
      "fork-new.json",
      msg({ id: "msg_f2", sessionID: "ses_fork", created: base + 5000, input: 300, output: 3 }),
    );

    const res = await parseOpencodeIncremental({
      messageFiles: [parentFile, forkFile, forkNewFile],
      cursors,
      queuePath,
    });
    assert.equal(res.eventsAggregated, 2);

    const totals = await queueTotals(queuePath);
    assert.equal(totals.input_tokens, 7300);
    assert.equal(totals.output_tokens, 73);
  });
});
