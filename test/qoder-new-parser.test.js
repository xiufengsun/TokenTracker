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
