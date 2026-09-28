const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseAtomCodeIncremental,
  resolveAtomCodeSessionFiles,
  resolveAtomCodeLegacyFiles,
  resolveAtomCodeDataRoot,
} = require("../src/lib/rollout");

async function readQueueRecords(queuePath) {
  const raw = await fs.readFile(queuePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function requestLine({ model, estimatedTokens, requestId, sessionId }) {
  // Mirrors a real AtomCode v5 session-log line: one LLM request with a
  // prompt-side context estimate. Conversation bodies are omitted here —
  // the reader must not need them.
  return JSON.stringify({
    cache_epoch: 1,
    context_window: 1000000,
    estimated_tokens: estimatedTokens,
    message_count: 5,
    messages: [],
    model,
    options: {},
    request_id: requestId,
    session_id: sessionId,
    step: requestId,
    tool_count: 3,
    tools: [],
    turn_id: 1,
  });
}

const SESSION_UUID = "8e6d800c-8c6b-41b9-8e6a-5e72b1484710";
const SESSION_FILE = `2026-08-07_22-20-10_575-${SESSION_UUID}-t1-p32092-i1.jsonl`;

async function writeDatalog(root, { jsonlLines, legacy }) {
  const projectDir = path.join(root, "EOH-Vbeta-3d3a3168");
  await fs.mkdir(projectDir, { recursive: true });
  if (jsonlLines) {
    await fs.writeFile(path.join(projectDir, SESSION_FILE), jsonlLines.join("\n") + "\n", "utf8");
  }
  if (legacy) {
    const llmDir = path.join(root, "EOH_Vbeta-d36f823e", "llm");
    await fs.mkdir(llmDir, { recursive: true });
    await fs.writeFile(
      path.join(llmDir, "2026-07-01_00-24-31_773.json"),
      JSON.stringify({
        context_window: 200000,
        model: legacy.model,
        request: { estimated_tokens: legacy.estimatedTokens, message_count: 2, messages: [], tool_count: 1, tools: [] },
        response: { duration_ms: 9407, reasoning_content: "", text: "", tool_calls: [] },
        session_id: "",
        step: 0,
        timestamp: "2026-07-01_00-24-31_773",
      }),
      "utf8",
    );
  }
  return projectDir;
}

// AtomCode filenames carry local wall-clock time. Build the expected UTC
// half-hour bucket from the same local Date so the assertion stays correct
// on any machine TZ.
function expectedHalfHourIso(localDate) {
  return new Date(Math.floor(localDate.getTime() / 1800000) * 1800000).toISOString();
}

test("parseAtomCodeIncremental aggregates per-request estimates into 30-min buckets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-atomcode-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const sessionFile = path.join(tmp, "proj", SESSION_FILE);
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        requestLine({ model: "GLM-5.2", estimatedTokens: 8900, requestId: 1, sessionId: SESSION_UUID }),
        requestLine({ model: "GLM-5.2", estimatedTokens: 11492, requestId: 2, sessionId: SESSION_UUID }),
        requestLine({ model: "deepseek-v4-flash", estimatedTokens: 0, requestId: 3, sessionId: SESSION_UUID }),
        requestLine({ model: "GLM-5.2", estimatedTokens: 13951, requestId: 4, sessionId: SESSION_UUID }),
        "not-json-garbage",
      ].join("\n") + "\n",
      "utf8",
    );

    const cursors = {};
    const result = await parseAtomCodeIncremental({
      sessionFiles: [sessionFile],
      cursors,
      queuePath,
    });

    // 4 parseable records (garbage line is not a record); the zero-estimate
    // line dedupes without contributing usage.
    assert.equal(result.recordsProcessed, 4);
    assert.equal(result.eventsAggregated, 3);
    assert.equal(result.bucketsQueued >= 1, true);

    const records = await readQueueRecords(queuePath);
    const atomcodeRows = records.filter((r) => r.source === "atomcode");
    assert.equal(atomcodeRows.length >= 1, true);
    const glmRow = atomcodeRows.find((r) => r.model === "GLM-5.2");
    assert.ok(glmRow, "GLM-5.2 bucket should be queued");
    assert.equal(glmRow.input_tokens, 8900 + 11492 + 13951);
    assert.equal(glmRow.total_tokens, 8900 + 11492 + 13951);
    assert.equal(glmRow.output_tokens, 0);
    assert.equal(
      glmRow.hour_start,
      expectedHalfHourIso(new Date(2026, 7, 7, 22, 20, 10, 575)),
      "filename local time must map to the UTC half-hour bucket",
    );

    // Three emitted requests plus the zero-estimate line all dedupe.
    assert.equal(cursors.atomcode.seenIds.length, 4);

    // Second run over the same files is a pure no-op.
    const second = await parseAtomCodeIncremental({
      sessionFiles: [sessionFile],
      cursors,
      queuePath,
    });
    assert.equal(second.eventsAggregated, 0);
    assert.equal(second.bucketsQueued, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAtomCodeIncremental picks up appended lines via the file offset cursor", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-atomcode-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const sessionFile = path.join(tmp, "proj", SESSION_FILE);
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      [requestLine({ model: "GLM-5.2", estimatedTokens: 1000, requestId: 1, sessionId: SESSION_UUID })].join("\n") + "\n",
      "utf8",
    );
    const cursors = {};
    await parseAtomCodeIncremental({ sessionFiles: [sessionFile], cursors, queuePath });

    await fs.appendFile(
      sessionFile,
      requestLine({ model: "GLM-5.2", estimatedTokens: 2000, requestId: 2, sessionId: SESSION_UUID }) + "\n",
      "utf8",
    );
    const result = await parseAtomCodeIncremental({ sessionFiles: [sessionFile], cursors, queuePath });
    assert.equal(result.recordsProcessed, 1);
    assert.equal(result.eventsAggregated, 1);

    const records = await readQueueRecords(queuePath);
    // Queued rows are absolute bucket states: the newest row for a bucket is
    // authoritative, so read the last one instead of summing.
    const rows = records.filter((r) => r.source === "atomcode" && r.model === "GLM-5.2");
    assert.equal(rows.length, 2);
    assert.equal(rows[rows.length - 1].input_tokens, 3000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("parseAtomCodeIncremental reads the legacy llm/*.json generation exactly once", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-atomcode-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const legacyFile = path.join(tmp, "proj2", "llm", "2026-07-01_00-24-31_773.json");
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    await fs.writeFile(
      legacyFile,
      JSON.stringify({
        context_window: 200000,
        model: "GLM-5.2",
        request: { estimated_tokens: 3356, message_count: 2, messages: [], tool_count: 1, tools: [] },
        response: { duration_ms: 9407 },
        session_id: "",
        step: 0,
        timestamp: "2026-07-01_00-24-31_773",
      }),
      "utf8",
    );

    const cursors = {};
    const first = await parseAtomCodeIncremental({ legacyFiles: [legacyFile], cursors, queuePath });
    assert.equal(first.eventsAggregated, 1);
    const second = await parseAtomCodeIncremental({ legacyFiles: [legacyFile], cursors, queuePath });
    assert.equal(second.eventsAggregated, 0);

    const records = await readQueueRecords(queuePath);
    const rows = records.filter((r) => r.source === "atomcode");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "GLM-5.2");
    assert.equal(rows[0].input_tokens, 3356);
    assert.equal(
      rows[0].hour_start,
      expectedHalfHourIso(new Date(2026, 6, 1, 0, 24, 31, 773)),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("AtomCode resolvers discover both generations and honor TOKENTRACKER_ATOMCODE_HOME", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-atomcode-"));
  const prevHome = process.env.TOKENTRACKER_ATOMCODE_HOME;
  try {
    process.env.TOKENTRACKER_ATOMCODE_HOME = tmp;
    const datalogRoot = path.join(tmp, "datalog");
    await writeDatalog(datalogRoot, {
      jsonlLines: [requestLine({ model: "GLM-5.2", estimatedTokens: 8900, requestId: 1, sessionId: SESSION_UUID })],
      legacy: { model: "GLM-5.2", estimatedTokens: 3356 },
    });
    // Stray files that must never be picked up.
    await fs.writeFile(path.join(datalogRoot, "EOH-Vbeta-3d3a3168", SESSION_FILE.replace(".jsonl", ".md")), "summary", "utf8");
    await fs.writeFile(path.join(tmp, "loose.txt"), "noise", "utf8");

    assert.equal(resolveAtomCodeDataRoot(process.env), path.join(tmp, "datalog"));
    const sessionFiles = resolveAtomCodeSessionFiles(process.env);
    assert.equal(sessionFiles.length, 1);
    assert.ok(sessionFiles[0].endsWith(".jsonl"));
    const legacyFiles = resolveAtomCodeLegacyFiles(process.env);
    assert.equal(legacyFiles.length, 1);
    assert.ok(legacyFiles[0].includes(path.join("llm")));

    const cursors = {};
    const result = await parseAtomCodeIncremental({ cursors, queuePath: path.join(tmp, "queue.jsonl"), env: process.env });
    assert.equal(result.eventsAggregated, 2);
  } finally {
    if (prevHome === undefined) delete process.env.TOKENTRACKER_ATOMCODE_HOME;
    else process.env.TOKENTRACKER_ATOMCODE_HOME = prevHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("AtomCode resolvers return empty when the datalog root is missing", () => {
  const env = { TOKENTRACKER_ATOMCODE_HOME: path.join(os.tmpdir(), "tt-atomcode-missing-" + Date.now()) };
  assert.deepEqual(resolveAtomCodeSessionFiles(env), []);
  assert.deepEqual(resolveAtomCodeLegacyFiles(env), []);
});
