const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  parseOmoIncremental,
  parseOmpIncremental,
  resolveOmoAgentDir,
  resolveOmoSessionFiles,
  resolveOmoSubagentFiles,
  omoAgentDirCollidesWithOmp,
} = require("../src/lib/rollout");
const { computeRowCost, ensurePricingLoaded } = require("../src/lib/pricing");

async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function sessionHeader(cwd) {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "01a045b8-b010-77b7-b18e-3a841db5be42",
    timestamp: new Date().toISOString(),
    ...(cwd ? { cwd } : {}),
  });
}

// Mirrors a real OmO assistant record: reasoning is spelled `reasoning`, and
// totalTokens deliberately excludes it (input+output+cacheRead+cacheWrite).
function omoAssistantLine({
  id,
  model = "grok-4.6",
  provider = "xai",
  input,
  output,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
  totalTokens,
  timestamp,
}) {
  const usage = { input, output, cacheRead, cacheWrite, reasoning };
  if (typeof totalTokens === "number") usage.totalTokens = totalTokens;
  return JSON.stringify({
    type: "message",
    id,
    parentId: "parent-1",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      provider,
      model,
      usage,
      timestamp,
    },
  });
}

async function writeSession(root, lines) {
  const sessionsDir = path.join(root, "sessions", "--test--");
  await fs.mkdir(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, "session.jsonl");
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

test("parseOmoIncremental reads OmO's `reasoning` field and keeps totalTokens exclusive of it", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omo-"));
  try {
    const ts = Date.UTC(2026, 7, 27, 23, 28, 16);
    const filePath = await writeSession(tmp, [
      sessionHeader(),
      omoAssistantLine({
        id: "7ae3734f",
        input: 28646,
        output: 630,
        cacheRead: 512,
        cacheWrite: 0,
        reasoning: 218,
        totalTokens: 29788,
        timestamp: ts,
      }),
    ]);
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const res = await parseOmoIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(res.eventsAggregated, 1);

    const [row] = await readJsonLines(queuePath);
    assert.equal(row.source, "omo");
    assert.equal(row.model, "grok-4.6");
    assert.equal(row.input_tokens, 28646);
    assert.equal(row.output_tokens, 630);
    assert.equal(row.cached_input_tokens, 512);
    assert.equal(row.reasoning_output_tokens, 218);
    // Reasoning is a subset of output, so it must NOT inflate the total.
    assert.equal(row.total_tokens, 29788);
    assert.equal(
      row.total_tokens,
      row.input_tokens + row.output_tokens + row.cached_input_tokens + row.cache_creation_input_tokens,
    );
    assert.equal(row.hour_start, "2026-08-27T23:00:00.000Z");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmpIncremental ignores the OmO `reasoning` spelling so omp accounting is unchanged", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-spelling-"));
  try {
    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const filePath = await writeSession(tmp, [
      sessionHeader(),
      omoAssistantLine({
        id: "msg-1",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        input: 100,
        output: 20,
        reasoning: 42,
        totalTokens: 120,
        timestamp: ts,
      }),
    ]);
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });

    const [row] = await readJsonLines(queuePath);
    assert.equal(row.source, "omp");
    assert.equal(row.reasoning_output_tokens, 0);
    assert.equal(row.total_tokens, 120);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("omo and omp keep independent cursors and source buckets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omo-omp-"));
  try {
    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const omoRoot = path.join(tmp, "omo");
    const ompRoot = path.join(tmp, "omp");
    const omoFile = await writeSession(omoRoot, [
      sessionHeader(),
      omoAssistantLine({ id: "omo-1", input: 10, output: 5, totalTokens: 15, timestamp: ts }),
    ]);
    const ompFile = await writeSession(ompRoot, [
      sessionHeader(),
      omoAssistantLine({ id: "omp-1", input: 70, output: 3, totalTokens: 73, timestamp: ts }),
    ]);

    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    await parseOmoIncremental({ sessionFiles: [omoFile], cursors, queuePath });
    await parseOmpIncremental({ sessionFiles: [ompFile], cursors, queuePath });

    assert.ok(cursors.omo, "omo owns its own cursor namespace");
    assert.ok(cursors.omp, "omp owns its own cursor namespace");
    assert.deepEqual(cursors.omo.seenIds, ["omo-1"]);
    assert.deepEqual(cursors.omp.seenIds, ["omp-1"]);

    const rows = await readJsonLines(queuePath);
    const bySource = new Map(rows.map((row) => [row.source, row]));
    assert.equal(bySource.get("omo").input_tokens, 10);
    assert.equal(bySource.get("omp").input_tokens, 70);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveOmoAgentDir honors TOKENTRACKER_OMO_AGENT_DIR and ignores pi/omp overrides", async () => {
  const explicit = path.join(os.tmpdir(), "explicit-omo-agent");
  assert.equal(
    resolveOmoAgentDir({ TOKENTRACKER_OMO_AGENT_DIR: explicit }),
    explicit,
  );

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omo-home-"));
  try {
    // win32 resolution only reports an install root that actually exists.
    await fs.mkdir(path.join(home, ".omo", "agent"), { recursive: true });
    // PI_CODING_AGENT_DIR / PI_CONFIG_DIR belong to pi and oh-my-pi. OmO must
    // not claim them, otherwise a three-way collision reappears.
    const piDir = path.join(home, "pi-agent-dir");
    const resolved = resolveOmoAgentDir({
      HOME: home,
      PI_CODING_AGENT_DIR: piDir,
      PI_CONFIG_DIR: ".pi",
    });
    assert.notEqual(resolved, piDir);
    assert.equal(resolved, path.join(home, ".omo", "agent"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("resolveOmoSessionFiles and resolveOmoSubagentFiles scan the OmO agent dir", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omo-scan-"));
  try {
    const agentDir = path.join(tmp, "agent");
    const cwdDir = path.join(agentDir, "sessions", "--D--personal-app--");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(path.join(cwdDir, "main.jsonl"), "", "utf8");
    await fs.writeFile(path.join(cwdDir, "notes.md"), "", "utf8");
    const nested = path.join(cwdDir, "extensions", "goal");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "sub.jsonl"), "", "utf8");

    const env = { TOKENTRACKER_OMO_AGENT_DIR: agentDir };
    assert.deepEqual(resolveOmoSessionFiles(env), [path.join(cwdDir, "main.jsonl")]);
    assert.deepEqual(resolveOmoSubagentFiles(env), [path.join(nested, "sub.jsonl")]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("computeRowCost does not bill OmO reasoning on top of output", async () => {
  await ensurePricingLoaded();
  const base = {
    model: "claude-opus-5",
    input_tokens: 1_000,
    output_tokens: 1_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const omoWithout = computeRowCost({ ...base, source: "omo" });
  const omoWith = computeRowCost({ ...base, source: "omo", reasoning_output_tokens: 500 });
  assert.ok(omoWithout > 0, "pricing must be resolvable for the fixture model");
  assert.equal(omoWith, omoWithout, "OmO folds reasoning into output — never double-bill it");

  // A provider that reports reasoning as additive still pays for it.
  const additiveWithout = computeRowCost({ ...base, source: "omp" });
  const additiveWith = computeRowCost({ ...base, source: "omp", reasoning_output_tokens: 500 });
  assert.ok(additiveWith > additiveWithout);
});

test("parseOmoIncremental fallback total excludes reasoning when totalTokens is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omo-fallback-"));
  try {
    const ts = Date.UTC(2026, 7, 27, 23, 28, 16);
    const filePath = await writeSession(tmp, [
      sessionHeader(),
      omoAssistantLine({
        id: "no-total",
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheWrite: 0,
        reasoning: 30,
        timestamp: ts,
      }),
    ]);
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    await parseOmoIncremental({ sessionFiles: [filePath], cursors, queuePath });
    const [row] = await readJsonLines(queuePath);
    assert.equal(row.reasoning_output_tokens, 30);
    assert.equal(row.total_tokens, 170, "100+50+20+0, reasoning already in output");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseOmoIncremental second run on an unchanged file queues no new buckets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omo-resync-"));
  try {
    const ts = Date.UTC(2026, 3, 5, 14, 10, 0);
    const filePath = await writeSession(tmp, [
      sessionHeader(),
      omoAssistantLine({ id: "once", input: 10, output: 5, totalTokens: 15, timestamp: ts }),
    ]);
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    const first = await parseOmoIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(first.eventsAggregated, 1);
    assert.equal(first.bucketsQueued, 1);

    const second = await parseOmoIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
    assert.equal((await readJsonLines(queuePath)).length, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("omoAgentDirCollidesWithOmp is true only when both overrides resolve to the same dir", async () => {
  const shared = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omo-collide-"));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omo-other-"));
  try {
    assert.equal(
      omoAgentDirCollidesWithOmp({
        TOKENTRACKER_OMO_AGENT_DIR: shared,
        TOKENTRACKER_OMP_AGENT_DIR: shared,
      }),
      true,
    );
    assert.equal(
      omoAgentDirCollidesWithOmp({
        TOKENTRACKER_OMO_AGENT_DIR: shared,
        TOKENTRACKER_OMP_AGENT_DIR: other,
      }),
      false,
    );
  } finally {
    await fs.rm(shared, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});

test("parseOmpIncremental ignores a placeholder message timestamp instead of bucketing it at 1970", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omp-epoch-"));
  try {
    const withTimestamps = (line, messageTs, entryTs) => {
      const entry = JSON.parse(line);
      entry.message.timestamp = messageTs;
      if (entryTs === undefined) delete entry.timestamp;
      else entry.timestamp = entryTs;
      return JSON.stringify(entry);
    };
    const base = { model: "claude-sonnet-4-5", provider: "anthropic", output: 5, totalTokens: 15, timestamp: 0 };
    const filePath = await writeSession(tmp, [
      sessionHeader(),
      // Placeholder on the message, real ISO time on the entry: use the entry.
      withTimestamps(omoAssistantLine({ ...base, id: "msg-1", input: 10 }), 1, "2026-09-15T09:40:00.000Z"),
      // Nothing usable: skip rather than invent a bucket.
      withTimestamps(omoAssistantLine({ ...base, id: "msg-2", input: 10 }), 1, undefined),
    ]);
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };

    await parseOmpIncremental({ sessionFiles: [filePath], cursors, queuePath });

    const rows = await readJsonLines(queuePath);
    assert.deepEqual(rows.map((r) => r.hour_start), ["2026-09-15T09:30:00.000Z"]);
    assert.equal(rows[0].total_tokens, 15);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
