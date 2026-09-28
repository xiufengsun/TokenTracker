"use strict";

// Issue #652: Codex writes token_usage_record next to token_count. token_count
// stays the source of normal usage; a record is counted only for a compaction
// call, whose token_count repeats the previous cumulative total.

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { parseRolloutIncremental } = require("../src/lib/rollout");
const { parseCodexRolloutFile } = require("../src/lib/codex-rollout-parser");

const SESSION = "019f0000-0000-7000-8000-000000000652";
const FORK = "019f0000-0000-7000-8000-00000000f652";
const MODEL = "gpt-5.5";

function usage(input, cached, output, reasoning = 0, cacheWrite = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function add(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = a[k] + b[k];
  return out;
}

const R1 = usage(1000, 400, 50, 10);
const R2 = usage(2000, 1500, 70, 5, 30);
const RC = usage(240000, 200000, 3000, 0);
const SNAPSHOT = usage(24000, 0, 453, 0);
const C1 = R1;

const line = (obj) => JSON.stringify(obj);
const meta = (id = SESSION, extra = {}) =>
  line({ timestamp: "2026-09-20T04:00:00.000Z", type: "session_meta", payload: { id, cwd: "/tmp", ...extra } });
const turnContext = (ts) =>
  line({ timestamp: ts, type: "turn_context", payload: { turn_id: "t1", model: MODEL, current_date: "2026-09-20" } });
// A replayed or copied record keeps its original response_id.
const tur = (ts, u, responseId = `resp_${ts}`) =>
  line({
    timestamp: ts,
    type: "token_usage_record",
    payload: { thread_id: SESSION, turn_id: "t1", response_id: responseId, usage: u },
  });
const tc = (ts, last, total) =>
  line({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
  });
const taskComplete = (ts) =>
  line({ timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } });
const compacted = (ts) =>
  line({
    timestamp: ts,
    type: "compacted",
    payload: { message: "", replacement_history: [{ type: "message", role: "user", content: [] }] },
  });
const worldState = (ts) => line({ timestamp: ts, type: "world_state", payload: { full: true } });

// Sync-side normalization of one Codex usage object (input excludes cached).
function norm(u) {
  return {
    input_tokens: u.input_tokens - u.cached_input_tokens,
    cached_input_tokens: u.cached_input_tokens,
    cache_creation_input_tokens: u.cache_write_input_tokens || 0,
    output_tokens: u.output_tokens,
    reasoning_output_tokens: u.reasoning_output_tokens,
    total_tokens: u.total_tokens,
  };
}
const sumNorm = (...us) => us.map(norm).reduce((a, b) => add(a, b));
// Session parser totals.total_tokens = input + cache write + output.
const parserTotal = (...us) =>
  us.reduce((s, u) => s + u.input_tokens + (u.cache_write_input_tokens || 0) + u.output_tokens, 0);

// record(RC) -> compacted -> ... -> token_count repeating the previous total
// (advances: false, what Codex writes today) or already including RC.
function compactionLines({ advances }) {
  const afterCompaction = advances ? add(C1, RC) : C1;
  return [
    meta(),
    turnContext("2026-09-20T04:00:01.000Z"),
    tur("2026-09-20T04:00:10.000Z", R1),
    tc("2026-09-20T04:00:11.000Z", R1, C1),
    tur("2026-09-20T04:00:40.000Z", RC),
    compacted("2026-09-20T04:00:40.050Z"),
    worldState("2026-09-20T04:00:40.060Z"),
    turnContext("2026-09-20T04:00:40.070Z"),
    tc("2026-09-20T04:00:40.080Z", advances ? RC : SNAPSHOT, afterCompaction),
    tur("2026-09-20T04:00:50.000Z", R2),
    tc("2026-09-20T04:00:51.000Z", R2, add(afterCompaction, R2)),
    taskComplete("2026-09-20T04:00:52.000Z"),
  ];
}

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-tur-"));
  try {
    const dir = path.join(tmp, "sessions", "2026", "09", "20");
    await fs.mkdir(dir, { recursive: true });
    const ctx = {
      dir,
      rolloutPath: path.join(dir, `rollout-2026-09-20T12-00-00-${SESSION}.jsonl`),
      forkPath: path.join(dir, `rollout-2026-09-20T12-10-00-${FORK}.jsonl`),
      queuePath: path.join(tmp, "queue.jsonl"),
      cursors: { version: 1, files: {}, updatedAt: null },
    };
    ctx.sync = (files = [ctx.rolloutPath]) =>
      parseRolloutIncremental({ rolloutFiles: files, cursors: ctx.cursors, queuePath: ctx.queuePath });
    await fn(ctx);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function queueTotals(queuePath) {
  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch {
    raw = "";
  }
  const latest = new Map();
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    const row = JSON.parse(l);
    latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }
  const sum = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  for (const row of latest.values()) {
    for (const k of Object.keys(sum)) sum[k] += Number(row[k] || 0);
  }
  return sum;
}

async function syncInChunks(lines, boundaries) {
  let out = null;
  await withTmp(async (ctx) => {
    await fs.writeFile(ctx.rolloutPath, "");
    let written = 0;
    for (const n of boundaries) {
      await fs.appendFile(ctx.rolloutPath, lines.slice(written, n).map((l) => l + "\n").join(""));
      written = n;
      await ctx.sync();
    }
    out = await queueTotals(ctx.queuePath);
  });
  return out;
}

async function parserTotals(lines, chunks = [lines.length]) {
  let out = null;
  await withTmp(async (ctx) => {
    await fs.writeFile(ctx.rolloutPath, "");
    let resumeState = null;
    let offset = 0;
    let tokens = 0;
    let modelTokens = 0;
    let written = 0;
    for (const n of chunks) {
      await fs.appendFile(ctx.rolloutPath, lines.slice(written, n).map((l) => l + "\n").join(""));
      written = n;
      const parsed = await parseCodexRolloutFile(ctx.rolloutPath, {
        startOffset: offset,
        resumeState,
        captureResumeState: true,
        collectModelUsage: true,
      });
      resumeState = parsed.resumeState;
      offset = parsed.endOffset;
      tokens += parsed.totals.total_tokens;
      modelTokens += parsed.modelUsage.reduce((s, r) => s + r.total_tokens, 0);
    }
    out = { tokens, modelTokens };
  });
  return out;
}

const everyLine = (lines) => lines.map((_, i) => i + 1);

test("compaction: the record is counted once, the context snapshot never (sync)", async () => {
  const lines = compactionLines({ advances: false });
  const expected = sumNorm(R1, RC, R2);
  assert.deepEqual(await syncInChunks(lines, [lines.length]), expected);
  assert.deepEqual(await syncInChunks(lines, everyLine(lines)), expected);
  for (let cut = 1; cut < lines.length; cut += 1) {
    assert.deepEqual(await syncInChunks(lines, [cut, lines.length]), expected, `cut at ${cut}`);
  }
});

test("compaction: a token_count that already includes the call counts it once (sync)", async () => {
  const lines = compactionLines({ advances: true });
  const expected = sumNorm(R1, RC, R2);
  assert.deepEqual(await syncInChunks(lines, [lines.length]), expected);
  assert.deepEqual(await syncInChunks(lines, everyLine(lines)), expected);
});

test("compaction: repeated sync is a no-op", async () => {
  await withTmp(async (ctx) => {
    await fs.writeFile(ctx.rolloutPath, compactionLines({ advances: false }).join("\n") + "\n");
    await ctx.sync();
    const first = await queueTotals(ctx.queuePath);
    const again = await ctx.sync();
    assert.equal(again.eventsAggregated, 0);
    assert.deepEqual(await queueTotals(ctx.queuePath), first);
    assert.deepEqual(first, sumNorm(R1, RC, R2));
  });
});

test("compaction: a record not immediately followed by compacted is not counted", async () => {
  const lines = compactionLines({ advances: false });
  const spaced = [...lines.slice(0, 5), worldState("2026-09-20T04:00:40.010Z"), ...lines.slice(5)];
  assert.deepEqual(await syncInChunks(spaced, [spaced.length]), sumNorm(R1, R2));
  assert.equal((await parserTotals(spaced)).tokens, parserTotal(R1, R2));
});

test("records in a file with token_count add nothing beyond token_count", async () => {
  const lines = compactionLines({ advances: true });
  const withoutRecords = lines.filter((l) => !l.includes('"token_usage_record"'));
  assert.deepEqual(
    await syncInChunks(lines, [lines.length]),
    await syncInChunks(withoutRecords, [withoutRecords.length]),
  );
});

test("compaction: session parser counts it the same way, across resumed chunks", async () => {
  const expected = parserTotal(R1, RC, R2);
  for (const lines of [compactionLines({ advances: false }), compactionLines({ advances: true })]) {
    assert.equal((await parserTotals(lines)).tokens, expected);
    assert.equal((await parserTotals(lines, everyLine(lines))).modelTokens, expected);
    for (let cut = 1; cut < lines.length; cut += 1) {
      assert.equal((await parserTotals(lines, [cut, lines.length])).tokens, expected, `cut at ${cut}`);
    }
  }
});

// A fork replays the parent's history in one flush (rows ms apart, records
// keeping the parent's response_ids), then its own live turn arrives seconds
// later.
function forkLines({ replayCompaction = true, liveCompaction = false } = {}) {
  const replay = [
    tur("2026-09-20T04:10:00.001Z", R1, "resp_2026-09-20T04:00:10.000Z"),
    tc("2026-09-20T04:10:00.002Z", R1, C1),
    ...(replayCompaction
      ? [
          tur("2026-09-20T04:10:00.003Z", RC, "resp_2026-09-20T04:00:40.000Z"),
          compacted("2026-09-20T04:10:00.004Z"),
          tc("2026-09-20T04:10:00.005Z", SNAPSHOT, C1),
        ]
      : []),
  ];
  const live = liveCompaction
    ? [
        tur("2026-09-20T04:10:30.000Z", RC),
        compacted("2026-09-20T04:10:30.050Z"),
        tc("2026-09-20T04:10:30.080Z", SNAPSHOT, C1),
      ]
    : [];
  return [
    meta(FORK, { forked_from_id: SESSION }),
    turnContext("2026-09-20T04:10:00.000Z"),
    ...replay,
    ...live,
    tur("2026-09-20T04:10:40.000Z", R2),
    tc("2026-09-20T04:10:40.100Z", R2, add(C1, R2)),
    taskComplete("2026-09-20T04:10:41.000Z"),
  ];
}

test("fork replay: the parent's compaction is counted once overall (sync)", async () => {
  const parent = compactionLines({ advances: false });
  for (const [label, fork, extra] of [
    ["replayed compaction", forkLines(), []],
    ["replayed and live compaction", forkLines({ liveCompaction: true }), [RC]],
  ]) {
    await withTmp(async (ctx) => {
      await fs.writeFile(ctx.rolloutPath, parent.join("\n") + "\n");
      await fs.writeFile(ctx.forkPath, fork.join("\n") + "\n");
      await ctx.sync([ctx.rolloutPath, ctx.forkPath]);
      const both = await queueTotals(ctx.queuePath);
      // Parent: R1 + RC + R2. Fork: the first replayed row (R1, the known
      // bounded residual of the burst detector) + its live R2 (+ a live RC).
      assert.deepEqual(both, sumNorm(R1, RC, R2, R1, R2, ...extra), label);
    });
  }
});

test("fork replay split at every line boundary counts the parent's compaction once (sync)", async () => {
  const parent = compactionLines({ advances: false });
  for (const [fork, extra] of [[forkLines(), []], [forkLines({ liveCompaction: true }), [RC]]]) {
    const expected = sumNorm(R1, RC, R2, R1, R2, ...extra);
    for (let cut = 1; cut < fork.length; cut += 1) {
      await withTmp(async (ctx) => {
        await fs.writeFile(ctx.rolloutPath, parent.join("\n") + "\n");
        await fs.writeFile(ctx.forkPath, fork.slice(0, cut).join("\n") + "\n");
        await ctx.sync([ctx.rolloutPath, ctx.forkPath]);
        await fs.appendFile(ctx.forkPath, fork.slice(cut).join("\n") + "\n");
        await ctx.sync([ctx.rolloutPath, ctx.forkPath]);
        // A split read loses the burst detector, so replayed token_count rows
        // after the cut are counted as on main; the compaction never is.
        const withoutReplayedRecord = fork.map((l) =>
          l.includes("04:10:00.003Z") ? worldState("2026-09-20T04:10:00.003Z") : l,
        );
        const baseline = await syncForkBaseline(parent, withoutReplayedRecord, cut);
        assert.deepEqual(await queueTotals(ctx.queuePath), baseline, `cut at ${cut}`);
      });
    }
    // Whole read: the replay burst is skipped entirely.
    await withTmp(async (ctx) => {
      await fs.writeFile(ctx.rolloutPath, parent.join("\n") + "\n");
      await fs.writeFile(ctx.forkPath, fork.join("\n") + "\n");
      await ctx.sync([ctx.rolloutPath, ctx.forkPath]);
      assert.deepEqual(await queueTotals(ctx.queuePath), expected);
    });
  }
});

// Same two syncs, with the fork's replayed compaction record replaced by an
// unrelated line: what token_count alone yields for this split.
async function syncForkBaseline(parent, fork, cut) {
  let out = null;
  await withTmp(async (ctx) => {
    await fs.writeFile(ctx.rolloutPath, parent.join("\n") + "\n");
    await fs.writeFile(ctx.forkPath, fork.slice(0, cut).join("\n") + "\n");
    await ctx.sync([ctx.rolloutPath, ctx.forkPath]);
    await fs.appendFile(ctx.forkPath, fork.slice(cut).join("\n") + "\n");
    await ctx.sync([ctx.rolloutPath, ctx.forkPath]);
    out = await queueTotals(ctx.queuePath);
  });
  return out;
}

test("copied rollout whose original cursor shard is not loaded counts the compaction once", async () => {
  // The original under sessions/<day>/ was synced earlier; its cursor lives
  // in a day shard this run did not load, so the copy is read as a new file.
  const lines = compactionLines({ advances: false });
  const run = async (fileLines) => {
    let out = null;
    await withTmp(async (ctx) => {
      await fs.writeFile(ctx.rolloutPath, fileLines.join("\n") + "\n");
      await ctx.sync();
      delete ctx.cursors.files[ctx.rolloutPath];
      const copyDir = path.join(path.dirname(path.dirname(ctx.dir)), "21");
      await fs.mkdir(copyDir, { recursive: true });
      const copy = path.join(copyDir, path.basename(ctx.rolloutPath));
      await fs.copyFile(ctx.rolloutPath, copy);
      await ctx.sync([copy]);
      out = await queueTotals(ctx.queuePath);
    });
    return out;
  };
  const withoutCompaction = await run(lines.filter((l) => !l.includes("04:00:40.000Z")));
  assert.deepEqual(await run(lines), add(withoutCompaction, norm(RC)));
});

test("session parser: a compaction repeated across merged files counts once, split or whole", async () => {
  await withTmp(async (ctx) => {
    const lines = compactionLines({ advances: false });
    await fs.writeFile(ctx.rolloutPath, lines.join("\n") + "\n");
    // An archived copy that differs byte-wise (extra field) but repeats the
    // compaction record and its response_id.
    const archived = path.join(path.dirname(ctx.dir), `rollout-2026-09-20T12-00-00-${SESSION}.jsonl`);
    await fs.writeFile(
      archived,
      lines.map((l) => l.replace('"type":"token_usage_record"', '"type":"token_usage_record","copy":1')).join("\n") + "\n",
    );
    const merged = await parseCodexRolloutFile([ctx.rolloutPath, archived], { collectModelUsage: true });
    const single = await parseCodexRolloutFile(ctx.rolloutPath, { collectModelUsage: true });
    assert.equal(merged.totals.total_tokens, single.totals.total_tokens);
  });
  const fork = forkLines();
  const whole = (await parserTotals(fork)).tokens;
  for (let cut = 1; cut < fork.length; cut += 1) {
    assert.equal((await parserTotals(fork, [cut, fork.length])).tokens, whole, `cut at ${cut}`);
  }
});

// Files whose usage only exists as token_usage_record rows are not counted
// from the records; sync flags them so status and sync can warn.
const { countRecordOnlyFiles, formatRecordOnlyWarning } = require("../src/lib/codex-usage-record");

const RECORD_ONLY = [
  meta(),
  turnContext("2026-09-20T04:00:01.000Z"),
  tur("2026-09-20T04:00:10.000Z", R1),
  tur("2026-09-20T04:00:20.000Z", R2),
  taskComplete("2026-09-20T04:00:22.000Z"),
];

test("record-only file: nothing is counted and the file is flagged", async () => {
  await withTmp(async (ctx) => {
    await fs.writeFile(ctx.rolloutPath, RECORD_ONLY.join("\n") + "\n");
    await ctx.sync();
    assert.equal((await queueTotals(ctx.queuePath)).total_tokens, 0);
    assert.deepEqual(ctx.cursors.codexUsageRecordOnlyFiles, { [ctx.rolloutPath]: true });
    assert.equal(countRecordOnlyFiles(ctx.cursors), 1);
    assert.match(formatRecordOnlyWarning(1), /^1 Codex session\(s\) report usage only via token_usage_record/);
    assert.equal((await ctx.sync()).eventsAggregated, 0);
    assert.equal(countRecordOnlyFiles(ctx.cursors), 1);
  });
  assert.equal((await parserTotals(RECORD_ONLY)).tokens, 0);
});

test("record-only flag: set across syncs, never for a record awaiting its token_count", async () => {
  await withTmp(async (ctx) => {
    // A sync between a record and its token_count proves nothing yet.
    await fs.writeFile(ctx.rolloutPath, RECORD_ONLY.slice(0, 3).join("\n") + "\n");
    await ctx.sync();
    assert.equal(countRecordOnlyFiles(ctx.cursors), 0);
    await fs.appendFile(ctx.rolloutPath, RECORD_ONLY[3] + "\n");
    await ctx.sync();
    assert.equal(countRecordOnlyFiles(ctx.cursors), 1);
    // A token_count showing up later makes it a normal file again.
    await fs.appendFile(ctx.rolloutPath, tc("2026-09-20T04:00:31.000Z", R2, add(C1, R2)) + "\n");
    await ctx.sync();
    assert.equal(countRecordOnlyFiles(ctx.cursors), 0);
    assert.ok((await queueTotals(ctx.queuePath)).total_tokens > 0);
  });
});

test("file with both events is not flagged; a deleted flagged file stops warning", async () => {
  await withTmp(async (ctx) => {
    for (const l of compactionLines({ advances: false })) {
      await fs.appendFile(ctx.rolloutPath, l + "\n");
      await ctx.sync();
      assert.equal(countRecordOnlyFiles(ctx.cursors), 0);
    }
    await fs.writeFile(ctx.forkPath, RECORD_ONLY.join("\n") + "\n");
    await ctx.sync([ctx.rolloutPath, ctx.forkPath]);
    assert.equal(countRecordOnlyFiles(ctx.cursors), 1);
    await fs.rm(ctx.forkPath);
    await ctx.sync([ctx.rolloutPath]);
    assert.equal(countRecordOnlyFiles(ctx.cursors), 0);
  });
  assert.equal(formatRecordOnlyWarning(0), null);
});
