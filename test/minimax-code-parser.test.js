const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  parseMinimaxCodeIncremental,
  resolveMinimaxCodeHome,
  resolveMinimaxCodeSessionFiles,
} = require("../src/lib/rollout");

async function readJsonLines(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Latest entry per (source, model, hour_start), the way queue readers do.
function latestRows(rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  return [...byKey.values()];
}

// Mirrors a real MiniMax Code messages.jsonl record: no `type` wrapper, the
// dedup id is the top-level `message_id`, usage is pi-shaped and `input`
// excludes cache reads (132719 + 16692 + 439298 + 0 = 588709).
function assistantLine({
  messageId,
  model = "MiniMax-M2.7",
  input,
  output,
  cacheRead = 0,
  cacheWrite = 0,
  totalTokens,
  timestamp,
}) {
  return JSON.stringify({
    message_id: messageId,
    turn_id: `turn-${messageId}`,
    message: {
      role: "assistant",
      model,
      provider: "minimax",
      timestamp,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: totalTokens ?? input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
}

function userLine(messageId, timestamp) {
  return JSON.stringify({
    message_id: messageId,
    turn_id: `turn-${messageId}`,
    message: { role: "user", timestamp },
  });
}

async function writeSession(home, { date, dir, lines }) {
  const [y, m, d] = date.split("-");
  const sessionDir = path.join(home, "v2", "sessions", y, m, d, dir);
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "messages.jsonl");
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

async function setup() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-minimax-code-"));
  const home = path.join(tmp, ".minimax");
  const env = { ...process.env, HOME: tmp, TOKENTRACKER_MINIMAX_HOME: home };
  return {
    tmp,
    home,
    env,
    queuePath: path.join(tmp, "queue.jsonl"),
    cleanup: () => fs.rm(tmp, { recursive: true, force: true }),
  };
}

test("resolveMinimaxCodeHome honors TOKENTRACKER_MINIMAX_HOME and defaults to ~/.minimax", () => {
  assert.equal(
    resolveMinimaxCodeHome({ HOME: "/home/u", TOKENTRACKER_MINIMAX_HOME: "/custom/mm" }),
    "/custom/mm",
  );
  if (process.platform !== "win32") {
    assert.equal(resolveMinimaxCodeHome({ HOME: "/home/u" }), path.join("/home/u", ".minimax"));
  }
});

test("resolveMinimaxCodeSessionFiles walks the date-nested tree and only picks messages.jsonl", async () => {
  const ctx = await setup();
  try {
    const a = await writeSession(ctx.home, {
      date: "2026-09-01",
      dir: "10-00-00-000-session_QUFB",
      lines: [userLine("u1", Date.UTC(2026, 8, 1, 10))],
    });
    const b = await writeSession(ctx.home, {
      date: "2026-08-31",
      dir: "23-59-59-999-session_QkJC",
      lines: [userLine("u2", Date.UTC(2026, 7, 31, 23))],
    });
    // Subagent transcripts and unrelated files are not usage sources.
    await fs.writeFile(path.join(path.dirname(a), "task-1.readable.v1.jsonl"), "{}\n");
    await fs.writeFile(path.join(ctx.home, "v2", "sessions", "notes.jsonl"), "{}\n");

    const files = resolveMinimaxCodeSessionFiles(ctx.env);
    assert.deepStrictEqual(files, [b, a].sort((x, y) => x.localeCompare(y)));
  } finally {
    await ctx.cleanup();
  }
});

test("parseMinimaxCodeIncremental maps columns, buckets by half hour, and skips zero-usage rows", async () => {
  const ctx = await setup();
  try {
    const t1 = Date.UTC(2026, 8, 20, 14, 5, 0); // 14:00 bucket
    const t2 = Date.UTC(2026, 8, 20, 14, 29, 59, 999); // still 14:00
    const t3 = Date.UTC(2026, 8, 20, 14, 30, 0); // 14:30 bucket
    const filePath = await writeSession(ctx.home, {
      date: "2026-09-20",
      dir: "14-05-00-000-session_ABC",
      lines: [
        userLine("u-1", t1 - 1000),
        assistantLine({
          messageId: "m-1",
          input: 132719,
          output: 16692,
          cacheRead: 439298,
          cacheWrite: 0,
          totalTokens: 588709,
          timestamp: t1,
        }),
        assistantLine({ messageId: "m-2", input: 100, output: 20, cacheRead: 300, cacheWrite: 7, timestamp: t2 }),
        assistantLine({ messageId: "m-3", model: "kimi-for-coding", input: 10, output: 5, timestamp: t3 }),
        // Migrated legacy history: all-zero usage, must not produce a row.
        assistantLine({
          messageId: "legacy-1",
          model: "historical-transcript",
          input: 0,
          output: 0,
          timestamp: t1,
        }),
        "not json",
      ],
    });

    const cursors = { version: 1, files: {}, updatedAt: null };
    const res = await parseMinimaxCodeIncremental({
      sessionFiles: [filePath],
      cursors,
      queuePath: ctx.queuePath,
      env: ctx.env,
    });
    assert.equal(res.eventsAggregated, 3);
    assert.equal(res.bucketsQueued, 2);

    const rows = latestRows(await readJsonLines(ctx.queuePath));
    assert.ok(rows.every((r) => r.source === "minimax-code"));
    assert.ok(!rows.some((r) => r.model === "historical-transcript"));

    const m27 = rows.find((r) => r.model === "MiniMax-M2.7");
    assert.equal(m27.hour_start, "2026-09-20T14:00:00.000Z");
    assert.equal(m27.input_tokens, 132719 + 100);
    assert.equal(m27.output_tokens, 16692 + 20);
    assert.equal(m27.cached_input_tokens, 439298 + 300);
    assert.equal(m27.cache_creation_input_tokens, 7);
    assert.equal(m27.reasoning_output_tokens, 0);
    assert.equal(m27.total_tokens, 588709 + 427);
    assert.equal(m27.conversation_count, 2);

    const kimi = rows.find((r) => r.model === "kimi-for-coding");
    assert.equal(kimi.hour_start, "2026-09-20T14:30:00.000Z");
    assert.equal(kimi.input_tokens, 10);
    assert.equal(kimi.output_tokens, 5);
    assert.equal(kimi.total_tokens, 15);
  } finally {
    await ctx.cleanup();
  }
});

test("parseMinimaxCodeIncremental is idempotent and dedupes message_id across files and syncs", async () => {
  const ctx = await setup();
  try {
    const ts = Date.UTC(2026, 8, 21, 9, 10, 0);
    const first = await writeSession(ctx.home, {
      date: "2026-09-21",
      dir: "09-10-00-000-session_ONE",
      lines: [assistantLine({ messageId: "dup-1", input: 50, output: 5, cacheRead: 45, timestamp: ts })],
    });

    const cursors = { version: 1, files: {}, updatedAt: null };
    const opts = () => ({ cursors, queuePath: ctx.queuePath, env: ctx.env });

    const r1 = await parseMinimaxCodeIncremental(opts());
    assert.equal(r1.eventsAggregated, 1);
    const afterFirst = await readJsonLines(ctx.queuePath);

    // Second sync over an unchanged tree adds nothing.
    const r2 = await parseMinimaxCodeIncremental(opts());
    assert.equal(r2.eventsAggregated, 0);
    assert.equal(r2.bucketsQueued, 0);
    assert.deepStrictEqual(await readJsonLines(ctx.queuePath), afterFirst);

    // A second session file that replays the same message_id is not counted again.
    await writeSession(ctx.home, {
      date: "2026-09-21",
      dir: "09-20-00-000-session_TWO",
      lines: [assistantLine({ messageId: "dup-1", input: 50, output: 5, cacheRead: 45, timestamp: ts })],
    });
    const r3 = await parseMinimaxCodeIncremental(opts());
    assert.equal(r3.eventsAggregated, 0);
    assert.deepStrictEqual(await readJsonLines(ctx.queuePath), afterFirst);

    const [row] = latestRows(afterFirst);
    assert.equal(row.total_tokens, 100);
    assert.ok(first);
  } finally {
    await ctx.cleanup();
  }
});

test("parseMinimaxCodeIncremental picks up only appended lines on the next sync", async () => {
  const ctx = await setup();
  try {
    const ts = Date.UTC(2026, 8, 22, 3, 0, 0);
    const filePath = await writeSession(ctx.home, {
      date: "2026-09-22",
      dir: "03-00-00-000-session_APP",
      lines: [assistantLine({ messageId: "a-1", input: 1000, output: 100, timestamp: ts })],
    });

    const cursors = { version: 1, files: {}, updatedAt: null };
    const opts = () => ({ cursors, queuePath: ctx.queuePath, env: ctx.env });

    await parseMinimaxCodeIncremental(opts());
    await fs.appendFile(
      filePath,
      assistantLine({ messageId: "a-2", input: 1, output: 2, cacheRead: 3, timestamp: ts + 60_000 }) + "\n",
    );
    // A partially written trailing record must wait for its newline.
    await fs.appendFile(filePath, assistantLine({ messageId: "a-3", input: 7, output: 7, timestamp: ts }).slice(0, 40));

    const r2 = await parseMinimaxCodeIncremental(opts());
    assert.equal(r2.eventsAggregated, 1);
    let [row] = latestRows(await readJsonLines(ctx.queuePath));
    assert.equal(row.input_tokens, 1001);
    assert.equal(row.output_tokens, 102);
    assert.equal(row.cached_input_tokens, 3);
    assert.equal(row.total_tokens, 1106);
    assert.equal(row.conversation_count, 2);

    // Finish the partial record; the next sync reads it exactly once.
    const full = assistantLine({ messageId: "a-3", input: 7, output: 7, timestamp: ts });
    const raw = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, raw + full.slice(40) + "\n");
    const r3 = await parseMinimaxCodeIncremental(opts());
    assert.equal(r3.eventsAggregated, 1);
    [row] = latestRows(await readJsonLines(ctx.queuePath));
    assert.equal(row.total_tokens, 1120);
    assert.equal(row.conversation_count, 3);
  } finally {
    await ctx.cleanup();
  }
});
