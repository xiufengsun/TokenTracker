const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  parseDeepaiCodeIncremental,
  resolveDeepaiCodeAgentDirs,
  resolveDeepaiCodeSessionsDir,
  resolveDeepaiCodeSessionFiles,
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

// Mirrors a real DeepAI Code session record: pi's `type: "message"` envelope
// with the dedup id on the entry, DeepAI's own gateway provider slug, and
// pi-shaped usage where `input` excludes cacheRead. `cost` is always 0 because
// DeepAI bills through its plan, so it must be ignored, not trusted.
//
// DeepAI Code stamps `usage.reasoning`, which the pi-family parser deliberately
// does NOT fold in: upstream documents reasoning as a subset of `output` (its
// totalTokens = input + output + cacheRead + cacheWrite, verified against every
// logged turn), so adding it again would double-bill tokens. Only
// `usage.reasoningTokens` — a field DeepAI Code never writes — is counted.
function assistantLine({
  id,
  model = "deepseek-v4.1-flash",
  provider = "deepai",
  input,
  output,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
  totalTokens,
  timestamp,
}) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      model,
      provider,
      timestamp,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning,
        totalTokens: totalTokens ?? input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
}

function headerLine(cwd) {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "01a1e478-d387-709c-988b-8d7aabe393cb",
    timestamp: "2026-11-16T13:08:06.152Z",
    cwd,
  });
}

async function writeSession(userdata, { cwdDir, scope = "deepai", lines }) {
  const agentDir = path.join(userdata, "deepai", "pi", scope);
  const sessionDir = path.join(agentDir, "sessions", cwdDir);
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "2026-11-16T13-08-06-152Z_01a1e478-d387-709c-988b-8d7aabe393cb.jsonl");
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return { filePath, agentDir };
}

async function setup() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-deepai-code-"));
  const userdata = path.join(tmp, ".deepai-code", "userdata");
  const env = { ...process.env, HOME: tmp, TOKENTRACKER_DEEPAI_CODE_USERDATA: userdata };
  return {
    tmp,
    userdata,
    env,
    queuePath: path.join(tmp, "queue.jsonl"),
    cleanup: () => fs.rm(tmp, { recursive: true, force: true }),
  };
}

test("resolveDeepaiCodeUserdataDir/agent dirs honor the userdata override", async () => {
  assert.equal(
    resolveDeepaiCodeSessionsDir({
      HOME: "/home/u",
      TOKENTRACKER_DEEPAI_CODE_USERDATA: "/custom/userdata",
    }),
    path.join("/custom/userdata", "deepai", "pi", "deepai", "sessions"),
  );
  assert.deepStrictEqual(
    resolveDeepaiCodeAgentDirs({
      HOME: "/home/u",
      TOKENTRACKER_DEEPAI_CODE_AGENT_DIR: "/custom/agent",
    }),
    ["/custom/agent"],
  );
});

test("resolveDeepaiCodeSessionFiles discovers scopes under <userdata>/deepai/pi and only .jsonl", async () => {
  const ctx = await setup();
  try {
    const a = await writeSession(ctx.userdata, { cwdDir: "--C--Compiler Lab--", lines: [headerLine("C:/Compiler Lab")] });
    const b = await writeSession(ctx.userdata, {
      cwdDir: "--C--Users-maana-Documents-Code-opentavus--",
      scope: "deepai-beta",
      lines: [headerLine("C:/Users/maana/Documents/Code/opentavus")],
    });
    // Non-session files in the agent dir are not usage sources.
    await fs.writeFile(path.join(a.agentDir, "models.json"), "{}\n");
    await fs.writeFile(path.join(a.agentDir, "sessions", "notes.txt"), "x\n");

    const files = resolveDeepaiCodeSessionFiles(ctx.env);
    assert.deepStrictEqual(files, [a.filePath, b.filePath].sort((x, y) => x.localeCompare(y)));
  } finally {
    await ctx.cleanup();
  }
});

test("parseDeepaiCodeIncremental maps pi usage, buckets by half hour, and skips non-usage records", async () => {
  const ctx = await setup();
  try {
    const t1 = Date.UTC(2026, 10, 16, 14, 5, 0); // 14:00 bucket
    const t2 = Date.UTC(2026, 10, 16, 14, 29, 59, 999); // still 14:00
    const t3 = Date.UTC(2026, 10, 16, 14, 30, 0); // 14:30 bucket
    const { filePath } = await writeSession(ctx.userdata, {
      cwdDir: "--C--Users-maana-Documents-Code-Audiomate--",
      lines: [
        headerLine("C:/Users/maana/Documents/Code/Audiomate"),
        JSON.stringify({ type: "user", id: "u-1", timestamp: new Date(t1 - 1000).toISOString(), message: { role: "user", content: "secret prompt" } }),
        assistantLine({ id: "m-1", input: 434, output: 119, cacheRead: 285056, reasoning: 1909, timestamp: t1 }),
        assistantLine({ id: "m-2", input: 2186, output: 3018, cacheRead: 285440, reasoning: 1909, timestamp: t2 }),
        assistantLine({ id: "m-3", model: "glm-5.3-flash", input: 10, output: 5, timestamp: t3 }),
        // A failed turn with all-zero usage must not produce a row.
        assistantLine({ id: "m-4", input: 0, output: 0, timestamp: t1 }),
        "not json",
      ],
    });

    const cursors = { version: 1, files: {}, updatedAt: null };
    const res = await parseDeepaiCodeIncremental({
      sessionFiles: [filePath],
      cursors,
      queuePath: ctx.queuePath,
      env: ctx.env,
    });
    assert.equal(res.eventsAggregated, 3);
    assert.equal(res.bucketsQueued, 2);

    const rows = latestRows(await readJsonLines(ctx.queuePath));
    assert.ok(rows.every((r) => r.source === "deepai"));

    const deepseek = rows.find((r) => r.model === "deepseek-v4.1-flash");
    assert.equal(deepseek.hour_start, "2026-11-16T14:00:00.000Z");
    assert.equal(deepseek.input_tokens, 434 + 2186);
    assert.equal(deepseek.output_tokens, 119 + 3018);
    assert.equal(deepseek.cached_input_tokens, 285056 + 285440);
    assert.equal(deepseek.cache_creation_input_tokens, 0);
    // `usage.reasoning` is a subset of output — never added on top.
    assert.equal(deepseek.reasoning_output_tokens, 0);
    assert.equal(deepseek.total_tokens, (434 + 119 + 285056) + (2186 + 3018 + 285440));
    assert.equal(deepseek.conversation_count, 2);

    const glm = rows.find((r) => r.model === "glm-5.3-flash");
    assert.equal(glm.hour_start, "2026-11-16T14:30:00.000Z");
    assert.equal(glm.input_tokens, 10);
    assert.equal(glm.output_tokens, 5);
    assert.equal(glm.total_tokens, 15);
  } finally {
    await ctx.cleanup();
  }
});

test("parseDeepaiCodeIncremental keeps its own cursor so pi and DeepAI Code never share seenIds", async () => {
  const ctx = await setup();
  try {
    const ts = Date.UTC(2026, 10, 16, 9, 10, 0);
    const { filePath } = await writeSession(ctx.userdata, {
      cwdDir: "--C--Compiler Lab--",
      lines: [
        // A message id pi would also mint must still count once per source.
        assistantLine({ id: "shared-1", input: 50, output: 5, cacheRead: 45, timestamp: ts }),
      ],
    });

    // A cursor store that already holds pi's state, including this id.
    const cursors = {
      version: 1,
      files: {},
      updatedAt: null,
      pi: { seenIds: ["shared-1"], fileOffsets: {}, updatedAt: null },
    };
    const res = await parseDeepaiCodeIncremental({
      sessionFiles: [filePath],
      cursors,
      queuePath: ctx.queuePath,
      env: ctx.env,
    });
    assert.equal(res.eventsAggregated, 1);
    assert.deepStrictEqual(cursors.pi.seenIds, ["shared-1"]);
    assert.deepStrictEqual(cursors.deepai.seenIds, ["shared-1"]);

    const afterFirst = await readJsonLines(ctx.queuePath);
    const [row] = latestRows(afterFirst);
    assert.equal(row.total_tokens, 100);

    // Idempotent: a second sync over an unchanged file adds nothing.
    const r2 = await parseDeepaiCodeIncremental({
      sessionFiles: [filePath],
      cursors,
      queuePath: ctx.queuePath,
      env: ctx.env,
    });
    assert.equal(r2.eventsAggregated, 0);
    assert.equal(r2.bucketsQueued, 0);
    assert.deepStrictEqual(await readJsonLines(ctx.queuePath), afterFirst);
  } finally {
    await ctx.cleanup();
  }
});

test("parseDeepaiCodeIncremental picks up only appended lines on the next sync", async () => {
  const ctx = await setup();
  try {
    const ts = Date.UTC(2026, 10, 17, 3, 0, 0);
    const { filePath } = await writeSession(ctx.userdata, {
      cwdDir: "--C--Users-maana-Documents-Code-opentavus--",
      lines: [assistantLine({ id: "a-1", input: 1000, output: 100, timestamp: ts })],
    });

    const cursors = { version: 1, files: {}, updatedAt: null };
    const opts = () => ({ sessionFiles: [filePath], cursors, queuePath: ctx.queuePath, env: ctx.env });

    await parseDeepaiCodeIncremental(opts());
    await fs.appendFile(
      filePath,
      assistantLine({ id: "a-2", input: 1, output: 2, cacheRead: 3, timestamp: ts + 60_000 }) + "\n",
    );
    // A partially written trailing record must wait for its newline.
    await fs.appendFile(filePath, assistantLine({ id: "a-3", input: 7, output: 7, timestamp: ts }).slice(0, 40));

    const r2 = await parseDeepaiCodeIncremental(opts());
    assert.equal(r2.eventsAggregated, 1);
    let [row] = latestRows(await readJsonLines(ctx.queuePath));
    assert.equal(row.input_tokens, 1001);
    assert.equal(row.output_tokens, 102);
    assert.equal(row.cached_input_tokens, 3);
    assert.equal(row.total_tokens, 1106);
    assert.equal(row.conversation_count, 2);

    // Finish the partial record; the next sync reads it exactly once.
    const full = assistantLine({ id: "a-3", input: 7, output: 7, timestamp: ts });
    const raw = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, raw + full.slice(40) + "\n");
    const r3 = await parseDeepaiCodeIncremental(opts());
    assert.equal(r3.eventsAggregated, 1);
    [row] = latestRows(await readJsonLines(ctx.queuePath));
    assert.equal(row.total_tokens, 1120);
    assert.equal(row.conversation_count, 3);
  } finally {
    await ctx.cleanup();
  }
});
