"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseQoderNewIncremental,
  resolveQoderProjectsDir,
  resolveQoderCnProjectsDir,
  listQoderNewSessionFiles,
} = require("../src/lib/rollout");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-new-"));
}

function tempQueue() {
  const dir = tempDir();
  return {
    dir,
    queuePath: path.join(dir, "queue.jsonl"),
  };
}

function queueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

test("parseQoderNewIncremental aggregates and second sync is no-op", async (t) => {
  const tmp = tempDir();
  const { dir, queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessionFile = path.join(tmp, "proj", "sess1.jsonl");
  const baseRecord = (credits, ts, msgId) => ({
    type: "assistant",
    timestamp: ts,
    uuid: msgId,
    sessionId: "sess-1",
    cwd: "/tmp/proj",
    message: {
      id: msgId,
      role: "assistant",
      model: "qmodel_38max",
      content: [{ type: "tool_use", name: "Read" }],
      usage: { credits, billable: true, input_tokens: 0, output_tokens: 0 },
    },
  });
  writeJsonl(sessionFile, [
    baseRecord(1.5, "2026-08-30T11:00:00.000Z", "m1"),
    baseRecord(2.0, "2026-08-30T11:15:00.000Z", "m2"),
  ]);
  const cursors = {};
  const first = await parseQoderNewIncremental({
    sessionFiles: [sessionFile],
    cursors,
    queuePath,
    sourceKey: "qoder",
    cursorKey: "qoderNew",
  });
  assert.equal(first.messagesProcessed, 2);
  assert.equal(first.eventsAggregated, 2);
  assert.ok(first.bucketsQueued >= 1);
  const before = fs.readFileSync(queuePath, "utf8");
  const second = await parseQoderNewIncremental({
    sessionFiles: [sessionFile],
    cursors,
    queuePath,
    sourceKey: "qoder",
    cursorKey: "qoderNew",
  });
  assert.equal(second.eventsAggregated, 0);
  assert.equal(second.bucketsQueued, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), before);
});

test("parseQoderNewIncremental keeps distinct keys for no-id records in same file", async (t) => {
  const tmp = tempDir();
  const { dir, queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessionFile = path.join(tmp, "sess.jsonl");
  // No message.id nor uuid, same sessionId — fallback must use line index
  const rec = (ts) => ({
    type: "assistant",
    timestamp: ts,
    sessionId: "sess-x",
    cwd: "/tmp/proj",
    message: {
      role: "assistant",
      model: "qmodel_38max",
      content: [{ type: "tool_use", name: "Bash" }],
      usage: { credits: 1.0, billable: true },
    },
  });
  writeJsonl(sessionFile, [
    rec("2026-08-30T11:00:00.000Z"),
    rec("2026-08-30T11:05:00.000Z"),
    rec("2026-08-30T11:10:00.000Z"),
  ]);
  const cursors = {};
  const res = await parseQoderNewIncremental({
    sessionFiles: [sessionFile],
    cursors,
    queuePath,
    sourceKey: "qoder",
    cursorKey: "qoderNew",
  });
  // All three should be counted distinct, not collapsed to 1
  assert.equal(res.messagesProcessed, 3);
  assert.equal(res.eventsAggregated, 3);
  const keys = Object.keys(cursors.qoderNew.messages);
  assert.equal(keys.length, 3);
  // Keys must be distinct
  assert.equal(new Set(keys).size, 3);
});

test("parseQoderNewIncremental corrects precise token change (subtract-on-change)", async (t) => {
  const tmp = tempDir();
  const { dir, queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessionFile = path.join(tmp, "sess.jsonl");
  const mk = (input, output) => ({
    type: "assistant",
    timestamp: "2026-08-30T11:00:00.000Z",
    uuid: "u1",
    sessionId: "sess-1",
    cwd: "/tmp/proj",
    message: {
      id: "m1",
      role: "assistant",
      model: "qmodel_38max",
      content: [{ type: "tool_use", name: "Read" }],
      usage: { input_tokens: input, output_tokens: output, credits: 1.0, billable: true },
    },
  });
  writeJsonl(sessionFile, [mk(100, 50)]);
  const cursors = {};
  await parseQoderNewIncremental({ sessionFiles: [sessionFile], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew" });
  const firstRows = queueRows(queuePath).filter((r) => r.source === "qoder");
  assert.equal(firstRows.at(-1).total_tokens, 150);
  // Correct tokens upward: 100 -> 200 input
  writeJsonl(sessionFile, [mk(200, 50)]);
  const second = await parseQoderNewIncremental({ sessionFiles: [sessionFile], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew" });
  assert.ok(second.eventsAggregated >= 1);
  assert.ok(second.bucketsQueued >= 1);
  const latest = queueRows(queuePath).filter((r) => r.source === "qoder").at(-1);
  // Exact-value assertion pinning the subtract-on-change invariant: the stale
  // 150-token contribution is subtracted before the corrected 250 is added,
  // so the bucket reads exactly 250 (not 400 from double-counting).
  assert.equal(latest.total_tokens, 250);
  assert.equal(latest.input_tokens, 200);
  assert.equal(latest.output_tokens, 50);
  assert.equal(latest.conversation_count, 1);
  assert.equal(latest.usage_precision, undefined);
});

test("parseQoderNewIncremental counts credit-only usage as conversation without token delta", async (t) => {
  const tmp = tempDir();
  const { dir, queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessionFile = path.join(tmp, "sess.jsonl");
  // Credit-billed SDK record with no authoritative token fields: tokens must
  // stay unsupported (no fabricated estimate), but the billable message still
  // counts as conversation activity.
  writeJsonl(sessionFile, [{
    type: "assistant",
    timestamp: "2026-08-30T11:00:00.000Z",
    uuid: "u1",
    sessionId: "sess-credit",
    cwd: "/tmp/proj",
    message: {
      id: "m1",
      role: "assistant",
      model: "qmodel_38max",
      content: [{ type: "tool_use", name: "Read" }],
      usage: { credits: 2.5, billable: true, input_tokens: 0, output_tokens: 0 },
    },
  }]);
  const cursors = {};
  const res = await parseQoderNewIncremental({ sessionFiles: [sessionFile], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew" });
  assert.equal(res.messagesProcessed, 1);
  assert.equal(res.eventsAggregated, 1);
  const row = queueRows(queuePath).find((r) => r.source === "qoder");
  assert.ok(row, "billable credit-only message should still enqueue a conversation row");
  assert.equal(row.total_tokens, 0);
  assert.equal(row.input_tokens, 0);
  assert.equal(row.output_tokens, 0);
  assert.equal(row.conversation_count, 1);
  assert.equal(row.usage_precision, undefined);
});

test("parseQoderNewIncremental migrates legacy jsonl: cursor keys without double count", async (t) => {
  const tmp = tempDir();
  const learn = tempQueue();
  const { dir, queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(learn.dir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessionFile = path.join(tmp, "sess.jsonl");
  writeJsonl(sessionFile, [{
    type: "assistant",
    timestamp: "2026-08-30T11:00:00.000Z",
    uuid: "u1",
    sessionId: "sess-1",
    cwd: "/tmp/proj",
    message: {
      id: "m1",
      role: "assistant",
      model: "qmodel_38max",
      content: [{ type: "tool_use", name: "Read" }],
      usage: { input_tokens: 100, output_tokens: 50, credits: 1.0, billable: true },
    },
  }]);
  // Learn the canonical stored shape with a clean run, then seed it under the
  // legacy "qoder" cursor the way pre-#549 installs persisted JSONL keys.
  const learned = {};
  await parseQoderNewIncremental({ sessionFiles: [sessionFile], cursors: learned, queuePath: learn.queuePath, sourceKey: "qoder", cursorKey: "qoderNew" });
  const learnedEntry = learned.qoderNew.messages["jsonl:sess-1|m1"];
  assert.ok(learnedEntry, "learning run should store the jsonl key");
  const seeded = {
    qoder: {
      messages: {
        "jsonl:sess-1|m1": JSON.parse(JSON.stringify(learnedEntry)),
        "row:legacydb|42": {
          totals: { input_tokens: 7, total_tokens: 7, conversation_count: 1 },
          bucketStart: "2026-08-30T11:00:00.000Z",
          model: "qoder-agent",
        },
      },
      updatedAt: new Date().toISOString(),
    },
  };
  const res = await parseQoderNewIncremental({ sessionFiles: [sessionFile], cursors: seeded, queuePath, sourceKey: "qoder", cursorKey: "qoderNew" });
  // jsonl: key moved to the isolated namespace; legacy row: key preserved.
  assert.ok(!seeded.qoder.messages["jsonl:sess-1|m1"], "jsonl key should leave the legacy cursor");
  assert.ok(seeded.qoder.messages["row:legacydb|42"], "legacy row key should stay");
  assert.ok(seeded.qoderNew.messages["jsonl:sess-1|m1"], "jsonl key should land in qoderNew");
  // Migrated entry matches the current snapshot, so nothing is re-aggregated.
  assert.equal(res.eventsAggregated, 0);
  assert.equal(res.bucketsQueued, 0);
});

test("resolveQoderProjectsDir windows case-insensitive guard", () => {
  const intl = resolveQoderProjectsDir({ home: "C:\\Users\\x", env: { QODER_PROJECTS_DIR: "C:\\Users\\x\\.qoder\\projects" }, platform: "win32", deps: { existsSync: () => true, discoverWslHome: () => null } });
  const cn = resolveQoderCnProjectsDir({ home: "C:\\Users\\x", env: { QODER_CN_PROJECTS_DIR: "c:\\users\\x\\.qoder\\projects" }, platform: "win32", deps: { existsSync: () => true, discoverWslHome: () => null } });
  // Direct guard logic from sync.js uses path.normalize + win32 lower-case
  const winKey = (p) => path.win32.normalize(p).toLowerCase();
  assert.equal(winKey(intl), winKey(cn));
  // Raw strings differ in case
  assert.notEqual(intl, cn);
});

test("resolveQoderCnProjectsDir defaults to ~/.qoder-cn/projects, not the international dir", () => {
  // The new CN app (com.qodercn.app.stable) writes ~/.qoder-cn/projects — a
  // sibling of ~/.qoder, never a shared directory. Defaulting CN onto
  // ~/.qoder/projects made the "CN diverges from international" guards in
  // sync.js/status.js always false, so CN JSONL was silently never parsed.
  const cn = resolveQoderCnProjectsDir({ home: "/Users/test", env: {}, platform: "darwin" });
  const intl = resolveQoderProjectsDir({ home: "/Users/test", env: {}, platform: "darwin" });
  assert.equal(cn, path.join("/Users/test", ".qoder-cn", "projects"));
  assert.equal(intl, path.join("/Users/test", ".qoder", "projects"));
  // The sync.js/status.js divergence guard depends on the defaults differing.
  assert.notEqual(path.normalize(cn), path.normalize(intl));
});

test("resolveQoderCnProjectsDir honors QODER_CN_PROJECTS_DIR and ignores QODER/QODER_PROJECTS_DIR", () => {
  // QODER_HOME / QODER_PROJECTS_DIR belong to the international install and
  // must never redirect the CN resolver onto it (that would double-count the
  // same JSONL under both sources).
  assert.equal(
    resolveQoderCnProjectsDir({
      home: "/Users/test",
      env: { QODER_HOME: "/intl-home", QODER_PROJECTS_DIR: "/intl-projects" },
      platform: "darwin",
    }),
    path.join("/Users/test", ".qoder-cn", "projects"),
  );
  assert.equal(
    resolveQoderCnProjectsDir({
      home: "/Users/test",
      env: { QODER_CN_PROJECTS_DIR: "/cn-sessions/projects" },
      platform: "darwin",
    }),
    path.resolve("/cn-sessions/projects"),
  );
});

test("parseQoderNewIncremental tracks new Qoder CN usage with BYOK model ids and streamed duplicates", async (t) => {
  const tmp = tempDir();
  const { dir, queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Real CN record shape (com.qodercn.app.stable, app 0.1.8 / agent 1.1.44):
  // Anthropic-style precise usage on the main transcript and on subagent
  // transcripts, BYOK model ids embedding an install-local provider UUID,
  // streamed rewrites of the same message id (usage identical), and 'auto'
  // streaming rows without usage.
  const usage = (input, cacheRead, cacheCreation, output) => ({
    input_tokens: input,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    request_id: "b93bd9a7-760f-4838-9641-13762bf33ae4",
  });
  const rec = (msgId, model, u, ts) => ({
    type: "assistant",
    timestamp: ts,
    uuid: `row-${msgId}`,
    sessionId: "cn-sess-1",
    cwd: "/Users/test/proj",
    message: { id: msgId, role: "assistant", model, content: [{ type: "text", text: "ok" }], usage: u },
  });
  const byokModel = "qoder-custom-e60342d2-d1f7-4203-8fe4-7d0d29bbfaee/glm-5.3-flash";
  const mainFile = path.join(tmp, "proj-slug", "cn-sess-1.jsonl");
  writeJsonl(mainFile, [
    rec("m1", byokModel, usage(27_566, 4_928, 0, 1_963), "2026-09-06T02:03:35.000Z"),
    // Streamed rewrite of the same message id: must not double count.
    rec("m1", byokModel, usage(27_566, 4_928, 0, 1_963), "2026-09-06T02:03:36.000Z"),
    rec("m2", byokModel, usage(30_000, 1_000, 200, 400), "2026-09-06T02:10:00.000Z"),
    // Streaming 'auto' rows carry no usage — skipped entirely.
    rec("m3", "auto", null, "2026-09-06T02:11:00.000Z"),
  ]);
  const subagentFile = path.join(tmp, "proj-slug", "cn-sess-1", "subagents", "agent-aExplore-1.jsonl");
  writeJsonl(subagentFile, [
    rec("sub-1", byokModel, usage(11_347, 0, 0, 108), "2026-09-06T02:05:00.000Z"),
  ]);
  const cursors = {};
  const first = await parseQoderNewIncremental({
    sessionFiles: [mainFile, subagentFile],
    cursors,
    queuePath,
    sourceKey: "qoder-cn",
    cursorKey: "qoderCnNew",
  });
  assert.equal(first.messagesProcessed, 3, "three distinct message ids (m1, m2, sub-1)");
  assert.equal(first.eventsAggregated, 3);
  assert.ok(first.bucketsQueued >= 1);

  const cnRows = queueRows(queuePath).filter((row) => row.source === "qoder-cn" && row.model === "glm-5.3-flash");
  assert.equal(cnRows.length, 1, "one half-hour bucket per (model, bucket)");
  assert.equal(
    cnRows[0].input_tokens,
    27_566 + 30_000 + 11_347,
    "input_tokens excludes cache reads (Anthropic semantics)",
  );
  assert.equal(cnRows[0].cached_input_tokens, 4_928 + 1_000 + 0);
  assert.equal(cnRows[0].cache_creation_input_tokens, 200);
  assert.equal(cnRows[0].output_tokens, 1_963 + 400 + 108);
  assert.equal(cnRows[0].total_tokens, 27_566 + 4_928 + 1_963 + 30_000 + 1_200 + 400 + 11_347 + 108);
  assert.equal(cnRows[0].usage_precision, undefined, "precise CN usage must not be marked as a credits estimate");

  // The BYOK UUID must be stripped from bucket keys so model rows don't
  // fragment per install, but the raw id stays in the cursor for reference.
  assert.equal(cursors.qoderCnNew.messages["jsonl:cn-sess-1|m1"]?.model, "glm-5.3-flash");

  // Second sync over the same files is a no-op.
  const before = fs.readFileSync(queuePath, "utf8");
  const second = await parseQoderNewIncremental({
    sessionFiles: [mainFile, subagentFile],
    cursors,
    queuePath,
    sourceKey: "qoder-cn",
    cursorKey: "qoderCnNew",
  });
  assert.equal(second.eventsAggregated, 0);
  assert.equal(second.bucketsQueued, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), before);
});


test("parseQoderNewIncremental uses isolated cursor namespace", async (t) => {
  const tmp = tempDir();
  const { dir, queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessionFile = path.join(tmp, "sess.jsonl");
  writeJsonl(sessionFile, [{
    type: "assistant",
    timestamp: "2026-08-30T11:00:00.000Z",
    uuid: "u1",
    sessionId: "sess-1",
    cwd: "/tmp/proj",
    message: { id: "m1", role: "assistant", model: "qmodel_38max", content: [{ type: "tool_use", name: "Read" }], usage: { credits: 1.0, billable: true } },
  }]);
  const cursors = { qoder: { messages: { legacyKey: { totals: { input_tokens: 1 }, bucketStart: "2026-08-30T11:00:00.000Z", model: "qoder-agent" } }, updatedAt: new Date().toISOString() } };
  await parseQoderNewIncremental({ sessionFiles: [sessionFile], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew" });
  // Legacy cursor untouched, new cursor populated
  assert.ok(cursors.qoder.messages.legacyKey);
  assert.ok(cursors.qoderNew);
  assert.equal(Object.keys(cursors.qoderNew.messages).length, 1);
  assert.equal(cursors.qoderNew.messages["jsonl:sess-1|m1"]?.model, "qmodel_38max");
});

test("parseQoderNewIncremental handles zero credit with only cache-creation tokens (precise, not estimated)", async (t) => {
  const tmp = tempDir();
  const { dir, queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessionFile = path.join(tmp, "sess.jsonl");
  writeJsonl(sessionFile, [{
    type: "assistant",
    timestamp: "2026-08-30T11:00:00.000Z",
    uuid: "u1",
    sessionId: "sess-cache",
    cwd: "/tmp/proj",
    message: {
      id: "m-cache",
      role: "assistant",
      model: "qmodel_38max",
      content: [{ type: "tool_use", name: "Read" }],
      usage: { credits: 0, billable: true, input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 123, output_tokens: 0 },
    },
  }]);
  const cursors = {};
  const res = await parseQoderNewIncremental({ sessionFiles: [sessionFile], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew" });
  assert.equal(res.messagesProcessed, 1);
  assert.equal(res.eventsAggregated, 1);
  const row = queueRows(queuePath).find((r) => r.source === "qoder");
  assert.equal(row.cache_creation_input_tokens, 123);
  assert.equal(row.total_tokens, 123);
  assert.equal(row.input_tokens, 0);
  // Precise cache-creation should not be marked as credits estimate
  assert.equal(row.usage_precision, undefined);
  assert.equal(row.conversation_count, 1);
});

// ── Admission gate: credits prove the call happened even when billable=false ──
//
// Qoder 0.4.x reports every qfmodel row as {tokens: 0, credits: >0,
// billable:false}. The old gate dropped all of them, which erased the whole
// source from the dashboard. These cases pin the three admission signals and,
// just as importantly, the rows that must STAY dropped.

const qRec = (usage, { ts = "2026-09-10T08:00:00.000Z", id, sessionId = "sess-1" } = {}) => {
  const msgId = id || usage.__id || "m1";
  const { __id, ...cleanUsage } = usage;
  return {
    type: "assistant",
    timestamp: ts,
    uuid: msgId,
    sessionId,
    cwd: "/tmp/proj",
    message: {
      id: msgId,
      role: "assistant",
      model: "qfmodel",
      content: [{ type: "text", text: "ok" }],
      usage: cleanUsage,
    },
  };
};

async function runOne(t, records, { sourceKey = "qoder", cursorKey = "qoderNew", cursors = {} } = {}) {
  const tmp = tempDir();
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const sessionFile = path.join(tmp, "proj", "sess1.jsonl");
  writeJsonl(sessionFile, records);
  const { dir, queuePath } = tempQueue();
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const res = await parseQoderNewIncremental({
    sessionFiles: [sessionFile], cursors, queuePath, sourceKey, cursorKey,
  });
  return { res, queuePath, rows: queueRows(queuePath).filter((r) => r.source === sourceKey), cursors, tmp, sessionFile };
}

test("billable:false with real credits counts as activity, no tokens, no cost", async (t) => {
  const { res, rows } = await runOne(t, [
    qRec({ credits: 0.7290659749999999, original_credits: 0.7290659749999999, billable: false,
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  assert.equal(res.messagesProcessed, 1);
  assert.equal(res.eventsAggregated, 1);
  const row = rows.find((r) => r.conversation_count > 0);
  assert.ok(row, "credit-only row must enqueue activity");
  assert.equal(row.total_tokens, 0);
  assert.equal(row.billable_total_tokens, 0);
  assert.equal(row.conversation_count, 1);
  assert.equal(row.total_cost_usd, 0);
  assert.equal(row.usage_precision, undefined, "0 tokens must not be labelled an estimate");
});

test("billable:false with zero credits stays dropped (synthetic / cancelled calls)", async (t) => {
  const { res, rows } = await runOne(t, [
    qRec({ credits: 0, original_credits: 0, billable: false, input_tokens: 0, output_tokens: 0 }),
  ]);
  assert.equal(res.messagesProcessed, 0);
  assert.equal(rows.length, 0);
});

test("gate is a superset of the old behaviour: absent/null/\"true\" billable still count", async (t) => {
  // These three shapes were admitted before the fix (billable !== false). The
  // credits signal may only ADD rows, never remove them.
  const { res, rows } = await runOne(t, [
    qRec({ credits: 0, input_tokens: 0, output_tokens: 0, __id: "a" }),
    qRec({ credits: 0, billable: null, input_tokens: 0, output_tokens: 0, __id: "b" }, { id: "b" }),
    qRec({ credits: 0, billable: "true", input_tokens: 0, output_tokens: 0, __id: "c" }, { id: "c" }),
  ]);
  assert.equal(res.messagesProcessed, 3);
  assert.equal(rows.reduce((s, r) => s + r.conversation_count, 0), 3);
});

test("credits must be a real number: type junk and sub-epsilon noise do not admit", async (t) => {
  const junk = [
    { credits: true }, { credits: "7" }, { credits: [5] }, { credits: {} },
    { credits: 1e999 }, { credits: -5 }, { credits: null }, { credits: 1e-9 },
  ];
  for (const extra of junk) {
    const { res } = await runOne(t, [
      qRec({ billable: false, input_tokens: 0, output_tokens: 0, ...extra }, { id: `junk-${JSON.stringify(extra)}` }),
    ]);
    assert.equal(res.messagesProcessed, 0, `must not admit ${JSON.stringify(extra)}`);
  }
  // 1e-6 is at the floor and must admit.
  const floor = await runOne(t, [qRec({ billable: false, credits: 1e-6, input_tokens: 0, output_tokens: 0, __id: "f" })]);
  assert.equal(floor.res.messagesProcessed, 1);
  // credits:0 with a real original_credits must admit — `??` would take the 0.
  const discounted = await runOne(t, [
    qRec({ billable: false, credits: 0, original_credits: 1.5, input_tokens: 0, output_tokens: 0, __id: "d" }),
  ]);
  assert.equal(discounted.res.messagesProcessed, 1, "max(credits, original_credits) must drive admission");
});

test("a huge numeric timestamp is dropped, not a RangeError that kills the source", async (t) => {
  // Nanosecond epochs pass coerceEpochMs but exceed the ECMAScript TimeClip
  // limit; new Date(ms).toISOString() throws before the bucket helper's own
  // invalid-date guard. One such row must not abort every later sync.
  const { res, rows } = await runOne(t, [
    qRec({ credits: 0.5, billable: false, input_tokens: 0, output_tokens: 0 },
      { id: "ns-epoch", ts: 1_770_000_000_000_000_000 }),
    qRec({ credits: 0.5, billable: false, input_tokens: 0, output_tokens: 0 },
      { id: "good", ts: "2026-09-10T08:00:00.000Z" }),
  ]);
  assert.equal(res.messagesProcessed, 1, "the good row must still be admitted");
  assert.equal(rows.reduce((s, r) => s + r.conversation_count, 0), 1);
});

test("mixed billable true/false in one file both count and keep distinct keys", async (t) => {
  const { res, rows } = await runOne(t, [
    qRec({ credits: 1.0, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "x1", ts: "2026-09-10T08:00:00.000Z" }),
    qRec({ credits: 1.0, billable: true, input_tokens: 0, output_tokens: 0 }, { id: "x2", ts: "2026-09-10T08:05:00.000Z" }),
  ]);
  assert.equal(res.messagesProcessed, 2);
  assert.equal(rows.reduce((s, r) => s + r.conversation_count, 0), 2);
});

test("subagent transcript sharing a sessionId does not clobber or double-count", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(queuePath), { recursive: true, force: true });
  });
  const main = path.join(tmp, "proj", "sess-1.jsonl");
  const sub = path.join(tmp, "proj", "sess-1", "subagents", "agent-1.jsonl");
  const rec = (id) => qRec({ credits: 0.5, billable: false, input_tokens: 0, output_tokens: 0 }, { id, sessionId: "sess-1" });
  writeJsonl(main, [rec("same-id")]);
  writeJsonl(sub, [rec("same-id")]);
  const cursors = {};
  const first = await parseQoderNewIncremental({
    sessionFiles: [main, sub], cursors, queuePath, sourceKey: "qoder-cn", cursorKey: "qoderCnNew",
  });
  // Same sessionId + same message id collapses to one key by design; the point
  // is that it never double counts and the main-transcript copy wins the key
  // regardless of file order — a subagent copy carries conversation_count 0.
  assert.equal(first.messagesProcessed, 1);
  assert.equal(
    cursors.qoderCnNew.messages["jsonl:sess-1|same-id"]?.totals.conversation_count,
    1,
    "main-transcript copy must win the shared key, not the subagent copy",
  );
  // Same outcome when the subagent file is walked first.
  const cursorsReversed = {};
  const reversed = await parseQoderNewIncremental({
    sessionFiles: [sub, main], cursors: cursorsReversed, queuePath, sourceKey: "qoder-cn", cursorKey: "qoderCnNew",
  });
  assert.equal(reversed.messagesProcessed, 1);
  assert.equal(
    cursorsReversed.qoderCnNew.messages["jsonl:sess-1|same-id"]?.totals.conversation_count,
    1,
    "main-transcript copy wins even when the subagent file is walked first",
  );
  const second = await parseQoderNewIncremental({
    sessionFiles: [main, sub], cursors, queuePath, sourceKey: "qoder-cn", cursorKey: "qoderCnNew",
  });
  assert.equal(second.eventsAggregated, 0);
});

test("subagent subagent duplicates keep last-wins; a main copy still promotes over them", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(queuePath), { recursive: true, force: true });
  });
  // Streamed rewrite inside a subagent file: the later row carries the final
  // (larger) usage and must be the one booked — first-wins here would
  // under-count subagent tokens.
  const sub = path.join(tmp, "proj", "sess-1", "subagents", "agent-1.jsonl");
  const main = path.join(tmp, "proj", "sess-1.jsonl");
  writeJsonl(sub, [
    qRec({ credits: 0.5, billable: false, input_tokens: 100, output_tokens: 0 }, { id: "same-id", sessionId: "sess-1", ts: "2026-09-10T08:00:00.000Z" }),
    qRec({ credits: 0.5, billable: false, input_tokens: 1000, output_tokens: 40 }, { id: "same-id", sessionId: "sess-1", ts: "2026-09-10T08:00:01.000Z" }),
  ]);
  const cursors = {};
  const first = await parseQoderNewIncremental({
    sessionFiles: [sub], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  assert.equal(first.messagesProcessed, 1, "rewrites collapse to one key");
  assert.equal(
    cursors.qoderNew.messages["jsonl:sess-1|same-id"]?.totals.total_tokens, 1040,
    "the later rewrite's totals win within a subagent file",
  );
  // A main-transcript copy of the same id still promotes over the subagent copy.
  writeJsonl(main, [
    qRec({ credits: 0.5, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "same-id", sessionId: "sess-1", ts: "2026-09-10T08:00:02.000Z" }),
  ]);
  const second = await parseQoderNewIncremental({
    sessionFiles: [sub, main], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  assert.equal(second.messagesProcessed, 1);
  assert.equal(
    cursors.qoderNew.messages["jsonl:sess-1|same-id"]?.totals.conversation_count, 1,
    "main copy promotes over the existing subagent copy",
  );
});

test("subagent rows are tracked but add no conversation activity", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(queuePath), { recursive: true, force: true });
  });
  const main = path.join(tmp, "proj", "sess-1.jsonl");
  const sub = path.join(tmp, "proj", "sess-1", "subagents", "agent-1.jsonl");
  writeJsonl(main, [qRec({ credits: 1, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "m1", sessionId: "sess-1" })]);
  writeJsonl(sub, [
    qRec({ credits: 2, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "s1", sessionId: "sess-1" }),
    qRec({ credits: 3, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "s2", sessionId: "sess-1" }),
  ]);
  const cursors = {};
  const res = await parseQoderNewIncremental({
    sessionFiles: [main, sub], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  // All three stay tracked (their credits and any later token rewrite need it)
  // but only the main-transcript row counts as conversation activity.
  assert.equal(res.messagesProcessed, 3);
  assert.equal(Object.keys(cursors.qoderNew.messages).length, 3);
  const rows = queueRows(queuePath).filter((r) => r.source === "qoder");
  assert.equal(rows.reduce((s, r) => s + r.conversation_count, 0), 1);
  assert.equal(rows.reduce((s, r) => s + (r.total_tokens || 0), 0), 0);
  for (const row of rows) {
    assert.ok(row.conversation_count > 0 || row.total_tokens > 0,
      "subagent rows must not publish all-zero buckets");
  }
});

test("subagent detection is separator-agnostic (backslash separators)", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(path.dirname(queuePath), { recursive: true, force: true }); });
  // On POSIX a backslash is a plain filename character, so a UNC-shaped path
  // can be created and read for real — this actually exercises the
  // /[\\/]subagents[\\/]/ classification (a WSL \\wsl$ walk produces exactly
  // these separator patterns) instead of only pinning the unreadable-path skip.
  // On Windows the literal-drive-colon form is an invalid path, but path.join
  // already emits backslash separators natively there, which exercises the
  // same regex branch.
  const uncFile = process.platform === "win32"
    ? path.join(tmp, "wsl$", "Ubuntu", "home", "u", ".qoder-cn", "proj", "sess", "subagents", "agent-1.jsonl")
    : path.join(tmp, "C:\\wsl$\\Ubuntu\\home\\u\\.qoder-cn\\proj\\sess\\subagents\\agent-1.jsonl");
  fs.mkdirSync(path.dirname(uncFile), { recursive: true });
  writeJsonl(uncFile, [
    qRec({ credits: 1, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "s1", sessionId: "sess" }),
  ]);
  const cursors = {};
  const res = await parseQoderNewIncremental({
    sessionFiles: [uncFile], cursors, queuePath, sourceKey: "qoder-cn", cursorKey: "qoderCnNew",
  });
  assert.equal(res.messagesProcessed, 1, "backslash path is read, not skipped");
  const [key] = Object.keys(cursors.qoderCnNew.messages);
  assert.equal(cursors.qoderCnNew.messages[key].totals.conversation_count, 0,
    "backslash subagents/ path must classify as a subagent transcript");
  assert.equal(queueRows(queuePath).filter((r) => r.source === "qoder-cn").length, 0,
    "subagent row must not publish an all-zero bucket");
});

test("a subagent row that later gains real tokens is bucketed exactly once", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(queuePath), { recursive: true, force: true });
  });
  const sub = path.join(tmp, "proj", "sess-1", "subagents", "agent-1.jsonl");
  writeJsonl(sub, [qRec({ credits: 1, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "s1", sessionId: "sess-1" })]);
  const cursors = {};
  const first = await parseQoderNewIncremental({
    sessionFiles: [sub], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  assert.equal(first.eventsAggregated, 1);
  assert.equal(queueRows(queuePath).filter((r) => r.source === "qoder").length, 0, "no all-zero row published");
  // Upstream rewrites the row with authoritative tokens.
  writeJsonl(sub, [qRec({ credits: 1, billable: false, input_tokens: 1000, output_tokens: 40 }, { id: "s1", sessionId: "sess-1" })]);
  const second = await parseQoderNewIncremental({
    sessionFiles: [sub], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  assert.equal(second.eventsAggregated, 1);
  const rows = queueRows(queuePath).filter((r) => r.source === "qoder");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_tokens, 1040, "tokens arrive exactly once, not doubled");
  assert.equal(rows[0].conversation_count, 0, "still no conversation activity for a subagent turn");
});

test("deleting a main row retracts its activity without leaving a phantom bucket", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(queuePath), { recursive: true, force: true });
  });
  const file = path.join(tmp, "proj", "sess1.jsonl");
  writeJsonl(file, [
    qRec({ credits: 1, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "a", ts: "2026-09-10T08:00:00.000Z" }),
    qRec({ credits: 1, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "b", ts: "2026-09-10T08:05:00.000Z" }),
  ]);
  const cursors = {};
  await parseQoderNewIncremental({
    sessionFiles: [file], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  const before = queueRows(queuePath).filter((r) => r.source === "qoder");
  assert.equal(before.reduce((s, r) => s + r.conversation_count, 0), 2);
  writeJsonl(file, [
    qRec({ credits: 1, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "a", ts: "2026-09-10T08:00:00.000Z" }),
  ]);
  await parseQoderNewIncremental({
    sessionFiles: [file], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  const after = queueRows(queuePath).filter((r) => r.source === "qoder");
  const latest = after[after.length - 1];
  assert.equal(latest.conversation_count, 1, "retraction must land on the real activity count");
  for (const row of after) {
    assert.ok(row.conversation_count > 0 || row.total_tokens > 0, "no all-zero bucket rows");
  }
});

test("streamed rewrites of one message id count once and restate on change", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(queuePath), { recursive: true, force: true });
  });
  const file = path.join(tmp, "proj", "sess1.jsonl");
  const rec = (tokens) => qRec({ credits: 0.4, billable: false, ...tokens }, { id: "dup" });
  writeJsonl(file, [rec({ input_tokens: 0, output_tokens: 0 }), rec({ input_tokens: 0, output_tokens: 0 })]);
  const cursors = {};
  const first = await parseQoderNewIncremental({
    sessionFiles: [file], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  assert.equal(first.messagesProcessed, 1, "duplicate id collapses to one key");
  assert.equal(cursors.qoderNew.messages["jsonl:sess-1|dup"].totals.conversation_count, 1);
});

test("legacy qoder cursor keys migrate and coexist with the credits admission", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(queuePath), { recursive: true, force: true });
  });
  const file = path.join(tmp, "proj", "sess1.jsonl");
  writeJsonl(file, [qRec({ credits: 3, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "legacy" })]);
  const messageKey = "jsonl:sess-1|legacy";
  const cursors = {
    qoder: {
      messages: {
        [messageKey]: {
          totals: {
            input_tokens: 10, cached_input_tokens: 0, cache_creation_input_tokens: 0,
            output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15,
            billable_total_tokens: 15, total_cost_usd: 0, conversation_count: 1,
          },
          conversationCount: 1,
          bucketStart: "2026-09-10T08:00:00.000Z",
          model: "qfmodel",
          projectKey: null,
          projectRef: null,
          updatedAt: "2026-09-10T08:00:00.000Z",
        },
      },
      updatedAt: "2026-09-10T08:00:00.000Z",
    },
  };
  const first = await parseQoderNewIncremental({
    sessionFiles: [file], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  assert.ok(cursors.qoderNew, "one-time migration must move jsonl: keys into the new namespace");
  assert.equal(cursors.qoder.messages[messageKey], undefined, "legacy namespace must not keep the key");
  assert.equal(first.messagesProcessed, 1);
  const second = await parseQoderNewIncremental({
    sessionFiles: [file], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  assert.equal(second.eventsAggregated, 0, "migration + admission must not double count on the next pass");
});

test("identical files reached through a symlink dedupe by message key", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(queuePath), { recursive: true, force: true });
  });
  const realDir = path.join(tmp, "real");
  const file = path.join(realDir, "sess1.jsonl");
  writeJsonl(file, [qRec({ credits: 1.25, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "s1" })]);
  const linkDir = path.join(tmp, "link");
  try {
    fs.symlinkSync(realDir, linkDir, "dir");
  } catch {
    t.skip("filesystem does not allow symlinks");
    return;
  }
  const both = [file, path.join(linkDir, "sess1.jsonl")];
  const cursors = {};
  const res = await parseQoderNewIncremental({
    sessionFiles: both, cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  assert.equal(res.messagesProcessed, 1, "same content under two paths must count once");
});

test("credit-only activity is idempotent across repeated syncs", async (t) => {
  const tmp = tempDir();
  const { queuePath } = tempQueue();
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(queuePath), { recursive: true, force: true });
  });
  const file = path.join(tmp, "proj", "sess1.jsonl");
  writeJsonl(file, [
    qRec({ credits: 0.5, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "a", ts: "2026-09-10T08:00:00.000Z" }),
    qRec({ credits: 0.5, billable: false, input_tokens: 0, output_tokens: 0 }, { id: "b", ts: "2026-09-10T08:10:00.000Z" }),
  ]);
  const cursors = {};
  const first = await parseQoderNewIncremental({
    sessionFiles: [file], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  const afterFirst = fs.readFileSync(queuePath, "utf8");
  const second = await parseQoderNewIncremental({
    sessionFiles: [file], cursors, queuePath, sourceKey: "qoder", cursorKey: "qoderNew",
  });
  assert.equal(first.messagesProcessed, 2);
  assert.equal(second.eventsAggregated, 0);
  assert.equal(second.bucketsQueued, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), afterFirst, "queue must not grow on re-sync");
});

// Backstop against the failure that erased Qoder from the dashboard: this runs
// the parser over the operator's real transcripts when present, asserting shape
// invariants only (never absolute row counts, since the corpus grows live).
test("real Qoder CN corpus: every credit-bearing row is admitted and carries no tokens", async (t) => {
  const projectsDir = resolveQoderCnProjectsDir({ home: os.homedir(), env: {} });
  if (!fs.existsSync(projectsDir)) {
    t.skip(`no Qoder CN corpus at ${projectsDir}`);
    return;
  }
  const files = await listQoderNewSessionFiles(projectsDir);
  if (files.length === 0) {
    t.skip("empty Qoder CN corpus");
    return;
  }
  let eligible = 0;
  let noIdEligible = 0;
  // Mirror the parser's per-key precedence contract: one booked row per
  // message key, main-session copies beat subagent copies regardless of walk
  // order, and same-class duplicates keep last-wins (a streamed rewrite's
  // later, final usage is the one booked). The expected-token sum reduces per
  // key with exactly that precedence — summing every eligible line would
  // double-count rewrite rows the parser collapses.
  const expectedTokensByKey = new Map();
  let noIdExpectedTokens = 0;
  const keys = new Set();
  // Mirror normalizeQoderNewTokens' per-field truncation and clamping so the
  // queued-token sum can be pinned exactly, whatever usage shapes the corpus
  // carries (0.4.x credit-only rows contribute 0; 0.1.8 precise-token rows
  // contribute their real counts). The cache field reproduces the parser's
  // `??` chain exactly — present-but-null cache_read_input_tokens must fall
  // through to cached_tokens, same as the parser.
  const fieldTokens = (raw) => {
    let value = Number(raw ?? 0);
    if (!Number.isFinite(value) || value < 0) value = 0;
    return Math.trunc(value);
  };
  const usageTokens = (usage) => fieldTokens(usage.input_tokens)
    + fieldTokens(usage.output_tokens)
    + fieldTokens(usage.cache_read_input_tokens ?? usage.cached_tokens)
    + fieldTokens(usage.cache_creation_input_tokens);
  for (const file of files) {
    const isMainSession = !/[\\/]subagents[\\/]/.test(file);
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const msg = record?.message;
      if (record?.type !== "assistant" || msg?.role !== "assistant" || typeof msg.usage !== "object" || !msg.usage) continue;
      // Mirror the parser's token fields, including its OpenAI-style
      // `cached_tokens` fallback for cache reads.
      const hasToken = ["input_tokens", "output_tokens", "cache_creation_input_tokens"]
        .some((f) => Number(msg.usage[f]) > 0)
        || Number(msg.usage.cache_read_input_tokens ?? msg.usage.cached_tokens) > 0;
      const hasCredit = [msg.usage.credits, msg.usage.original_credits]
        .some((v) => typeof v === "number" && Number.isFinite(v) && v >= 1e-6);
      if (!hasToken && !hasCredit && msg.usage.billable === false) continue;
      // Mirror the parser's timestamp gate — rows without a parseable
      // timestamp are dropped before admission, so they are not eligible.
      const rawTs = record.timestamp ?? msg.timestamp;
      const tsOk = typeof rawTs === "number"
        ? Number.isFinite(rawTs)
        : typeof rawTs === "string" && rawTs.trim() !== "" && !Number.isNaN(Date.parse(rawTs));
      if (!tsOk) continue;
      eligible += 1;
      // Mirror qoderNewMessageKey's fallback chain and normalizeMessageKeyPart's
      // trim: message.id, then row uuid, then record id; sessionId (either case
      // convention) qualifies the key when present. Rows with no id at all fall
      // under a per-line fallback key the parser always admits.
      const id = [msg.id, record.uuid, record.id]
        .find((v) => typeof v === "string" && v.trim() !== "")?.trim();
      const sid = [record.sessionId, record.session_id]
        .find((v) => typeof v === "string" && v.trim() !== "")?.trim();
      if (!id) {
        noIdEligible += 1;
        noIdExpectedTokens += usageTokens(msg.usage);
        continue;
      }
      const key = sid ? `${sid}|${id}` : id;
      keys.add(key);
      const prev = expectedTokensByKey.get(key);
      // Match parser precedence: main always beats subagent; within the same
      // class, last-wins so streamed rewrites update the expected token sum.
      if (prev?.isMainSession && !isMainSession) continue;
      expectedTokensByKey.set(key, { isMainSession, tokens: usageTokens(msg.usage) });
    }
  }
  const expectedTokens = Array.from(expectedTokensByKey.values())
    .reduce((sum, e) => sum + e.tokens, noIdExpectedTokens);
  if (eligible === 0) {
    t.skip("no credit-bearing rows in corpus");
    return;
  }
  const { queuePath } = tempQueue();
  t.after(() => { fs.rmSync(path.dirname(queuePath), { recursive: true, force: true }); });
  const cursors = {};
  const first = await parseQoderNewIncremental({
    sessionFiles: files, cursors, queuePath, sourceKey: "qoder-cn", cursorKey: "qoderCnNew",
  });
  const second = await parseQoderNewIncremental({
    sessionFiles: files, cursors, queuePath, sourceKey: "qoder-cn", cursorKey: "qoderCnNew",
  });
  assert.ok(first.messagesProcessed > 0, "the gate must no longer erase the source");
  assert.equal(first.messagesProcessed, keys.size + noIdEligible, "admitted rows must equal distinct message keys");
  assert.equal(second.eventsAggregated, 0, "backfill must be idempotent");
  assert.equal(
    queueRows(queuePath).filter((r) => r.source === "qoder-cn").reduce((s, r) => s + (r.total_tokens || 0), 0),
    expectedTokens,
    "queued tokens must equal exactly what the corpus reports — nothing invented",
  );
  for (const row of queueRows(queuePath).filter((r) => r.source === "qoder-cn")) {
    assert.equal(row.total_cost_usd, 0, "Qoder must not invent cost");
  }
});
