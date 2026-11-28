"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseClaudeIncremental } = require("../src/lib/rollout");
const { computeClaudeGroundTruthBuckets } = require("../src/lib/claude-categorizer");
const { scanClaudeSession, buildSessionAnalytics } = require("../src/lib/session-analytics");

function assistantLine({ entrypoint, requestId, messageId = "msg_example01", ts = "2026-01-01T00:00:00.000Z" }) {
  const row = {
    type: "assistant",
    timestamp: ts,
    entrypoint,
    userType: "external",
    message: {
      id: messageId,
      role: "assistant",
      model: "claude-opus-5-5",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000 },
    },
  };
  if (requestId) row.requestId = requestId;
  return JSON.stringify(row) + "\n";
}

async function scan(files, cursors, queuePath) {
  return parseClaudeIncremental({
    projectFiles: files,
    cursors,
    queuePath,
    source: "claude",
  });
}

function queuedTotal(queuePath) {
  if (!fs.existsSync(queuePath)) return 0;
  return fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean)
    .reduce((sum, line) => sum + Number(JSON.parse(line).total_tokens || 0), 0);
}

test("cli and sdk-cli copies of the same Claude response are counted once, in either file order and across incremental scans", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-sdk-dedup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases = [
    ["cli-first", ["cli.jsonl", "sdk-cli.jsonl"]],
    ["sdk-first", ["sdk-cli.jsonl", "cli.jsonl"]],
  ];

  for (const [name, order] of cases) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const cli = path.join(dir, "cli.jsonl");
    const sdk = path.join(dir, "sdk-cli.jsonl");
    fs.writeFileSync(cli, assistantLine({ entrypoint: "cli", requestId: "req_example01" }));
    fs.writeFileSync(sdk, assistantLine({ entrypoint: "sdk-cli", ts: "2026-01-01T00:00:00.004Z" }));
    const files = order.map((base) => path.join(dir, base));
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = { files: {} };
    const first = await scan(files, cursors, queuePath);
    assert.equal(first.eventsAggregated, 1, `${name} first scan events`);
    assert.equal(queuedTotal(queuePath), 1120, `${name} first scan tokens`);
    const second = await scan(files, cursors, queuePath);
    assert.equal(second.eventsAggregated, 0, `${name} repeat scan events`);
    assert.equal(queuedTotal(queuePath), 1120, `${name} repeat scan tokens`);
  }

  const split = path.join(root, "incremental");
  fs.mkdirSync(split);
  const cli = path.join(split, "cli.jsonl");
  const sdk = path.join(split, "sdk-cli.jsonl");
  const queuePath = path.join(split, "queue.jsonl");
  const cursors = { files: {} };
  fs.writeFileSync(sdk, assistantLine({ entrypoint: "sdk-cli", ts: "2026-01-01T00:00:00.004Z" }));
  const first = await scan([sdk], cursors, queuePath);
  assert.equal(first.eventsAggregated, 1);
  assert.equal(queuedTotal(queuePath), 1120);
  fs.writeFileSync(cli, assistantLine({ entrypoint: "cli", requestId: "req_example01" }));
  const second = await scan([cli, sdk], cursors, queuePath);
  assert.equal(second.eventsAggregated, 0, "later cli copy with requestId must not recount");
  assert.equal(queuedTotal(queuePath), 1120);

  const splitReqFirst = path.join(root, "incremental-req-first");
  fs.mkdirSync(splitReqFirst);
  const cli2 = path.join(splitReqFirst, "cli.jsonl");
  const sdk2 = path.join(splitReqFirst, "sdk-cli.jsonl");
  const queue2 = path.join(splitReqFirst, "queue.jsonl");
  const cursors2 = { files: {} };
  fs.writeFileSync(cli2, assistantLine({ entrypoint: "cli", requestId: "req_example01" }));
  const firstReq = await scan([cli2], cursors2, queue2);
  assert.equal(firstReq.eventsAggregated, 1);
  fs.writeFileSync(sdk2, assistantLine({ entrypoint: "sdk-cli", ts: "2026-01-01T00:00:00.004Z" }));
  const secondReq = await scan([cli2, sdk2], cursors2, queue2);
  assert.equal(secondReq.eventsAggregated, 0, "later sdk-cli copy must not recount a persisted msgId:requestId");
  assert.equal(queuedTotal(queue2), 1120);
});

test("distinct Claude responses still count separately", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-sdk-distinct-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl");
  fs.writeFileSync(a, assistantLine({ entrypoint: "cli", requestId: "req_a", messageId: "msg_a" }));
  fs.writeFileSync(b, assistantLine({ entrypoint: "sdk-cli", messageId: "msg_b", ts: "2026-01-01T00:00:01.000Z" }));
  const queuePath = path.join(dir, "queue.jsonl");
  const result = await scan([a, b], { files: {} }, queuePath);
  assert.equal(result.eventsAggregated, 2);
  assert.equal(queuedTotal(queuePath), 2240);
});

test("a persisted msgId:requestId hash prevents recounting a later sdk-cli copy", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-legacy-hash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sdk = path.join(dir, "sdk-cli.jsonl");
  fs.writeFileSync(sdk, assistantLine({ entrypoint: "sdk-cli", ts: "2026-01-01T00:00:00.004Z" }));
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = { files: {}, claudeHashes: ["msg_example01:req_example01"] };
  const result = await scan([sdk], cursors, queuePath);
  assert.equal(result.eventsAggregated, 0);
  assert.equal(queuedTotal(queuePath), 0);
});

test("full-sync ground truth also counts the cli and sdk-cli copies once", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ground-truth-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "projects", "demo");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "cli.jsonl"), assistantLine({ entrypoint: "cli", requestId: "req_example01" }));
  fs.writeFileSync(path.join(project, "sdk-cli.jsonl"), assistantLine({ entrypoint: "sdk-cli", ts: "2026-01-01T00:00:00.004Z" }));
  const result = await computeClaudeGroundTruthBuckets({ rootDir });
  const total = result.rows.reduce((sum, row) => sum + Number(row.total_tokens || 0), 0);
  assert.equal(total, 1120);
});


function sessionAssistantLine({ entrypoint, requestId, usage, messageId = "msg_session01", ts = "2026-01-01T00:00:00.000Z", sessionId = "sess-dedup" }) {
  const row = {
    type: "assistant",
    timestamp: ts,
    sessionId,
    entrypoint,
    message: {
      id: messageId,
      role: "assistant",
      model: "claude-opus-5-5",
      usage,
      content: [],
    },
  };
  if (requestId) row.requestId = requestId;
  return `${JSON.stringify(row)}\n`;
}

test("scanClaudeSession keeps billable usage when a zero-usage copy shares the message id, in either file order", async (t) => {
  const billable = { input_tokens: 400, output_tokens: 100 };
  const empty = { input_tokens: 0, output_tokens: 0 };
  const cases = [
    ["sdk-first", ["sdk-cli.jsonl", "cli.jsonl"]],
    ["cli-first", ["cli.jsonl", "sdk-cli.jsonl"]],
  ];
  for (const [name, order] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tt-claude-session-dedup-${name}-`));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cli = path.join(dir, "cli.jsonl");
    const sdk = path.join(dir, "sdk-cli.jsonl");
    fs.writeFileSync(cli, sessionAssistantLine({ entrypoint: "cli", requestId: "req_session01", usage: billable }));
    fs.writeFileSync(sdk, sessionAssistantLine({ entrypoint: "sdk-cli", usage: empty, ts: "2026-01-01T00:00:00.004Z" }));
    const session = await scanClaudeSession(order.map((base) => path.join(dir, base)));
    assert.equal(session.total_tokens, 500, `${name} session tokens`);
    assert.equal(session.tokens.input_tokens, 400, `${name} input tokens`);
    assert.equal(session.tokens.output_tokens, 100, `${name} output tokens`);
    assert.equal(session.performance && typeof session.performance === "object", true, `${name} performance totals object`);
    assert.equal(session.performance.estimated_output_tokens, 0);
  }
});

test("stale Claude session cache is rebuilt when claude_dedup_version is missing", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-claude-dedup-cache-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, ".claude", "projects", "demo");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "sess-dedup.jsonl"), [
    { type: "user", sessionId: "sess-dedup", cwd: projectDir, timestamp: "2026-01-01T00:00:00.000Z", message: { content: "hi" } },
    JSON.parse(sessionAssistantLine({ entrypoint: "cli", requestId: "req_session01", usage: { input_tokens: 400, output_tokens: 100 }, ts: "2026-01-01T00:00:01.000Z" })),
  ].map((row) => `${JSON.stringify(row)}\n`).join(""));
  const first = await buildSessionAnalytics({ home, force: true });
  const claude = first.find((row) => row.source === "claude");
  assert.equal(claude.total_tokens, 500);
  const queue = path.join(home, ".tokentracker", "tracker", "session.queue.jsonl");
  const rows = fs.readFileSync(queue, "utf8").trim().split("\n").map(JSON.parse);
  for (const row of rows) {
    if (row.source !== "claude") continue;
    row.total_tokens = 999;
    if (row.tokens) row.tokens.total_tokens = 999;
  }
  fs.writeFileSync(queue, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const metaPath = `${queue}.meta.json`;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  delete meta.claude_dedup_version;
  fs.writeFileSync(metaPath, `${JSON.stringify(meta)}\n`);
  const rebuilt = await buildSessionAnalytics({ home });
  assert.equal(rebuilt.find((row) => row.source === "claude").total_tokens, 500);
  assert.equal(JSON.parse(fs.readFileSync(metaPath, "utf8")).claude_dedup_version, 1);
  const cached = await buildSessionAnalytics({ home });
  assert.equal(cached.find((row) => row.source === "claude").total_tokens, 500);
});
