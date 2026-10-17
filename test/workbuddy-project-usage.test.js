"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseWorkbuddyIncremental } = require("../src/lib/rollout");

const time = Date.UTC(2026, 9, 16, 10);

// With no cached tokens the WorkBuddy breakdown reduces to
// total_tokens === prompt_tokens + completion_tokens, so every expected value
// below is exact rather than approximate.
function record(id, prompt, opts = {}) {
  const providerData = {
    model: "deepseek-v4.1-flash",
    rawUsage: { prompt_tokens: prompt, completion_tokens: opts.completion ?? 20 },
  };
  if (opts.messageId) providerData.messageId = opts.messageId;
  const entry = {
    type: "function_call",
    sessionId: opts.session ?? "s1",
    id,
    timestamp: time,
    providerData,
  };
  if (opts.cwd !== null) entry.cwd = opts.cwd;
  return JSON.stringify(entry);
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-workbuddy-project-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, "path-with-dashes", "project");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(project, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/example/workbuddy-project.git\n',
  );
  const file = path.join(dir, "projects", "session.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "");
  return {
    dir,
    project,
    file,
    cursors: {},
    queuePath: path.join(dir, "queue.jsonl"),
    projectQueuePath: path.join(dir, "project.queue.jsonl"),
    projectFiles: [file],
    // Keep the reader off the machine's real WorkBuddy home and database.
    env: { ...process.env, WORKBUDDY_HOME: path.join(dir, "wb-home") },
    publicRepoResolver: async ({ projectRef }) => ({
      status: "public_verified",
      projectKey: "example/workbuddy-project",
      projectRef,
    }),
  };
}

async function rows(file) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("WorkBuddy projects backfill consumed history and stay idempotent", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.file, [
    record("a", 100, { cwd: f.project }),
    record("b", 300, { cwd: f.project }),
    "",
  ].join("\n"));

  // First pass without a project queue, exactly like an install that predates
  // this change: totals only.
  await parseWorkbuddyIncremental({ ...f, projectQueuePath: undefined });
  const aggregateBefore = await fs.readFile(f.queuePath, "utf8");
  f.cursors = JSON.parse(JSON.stringify(f.cursors));

  const backfill = await parseWorkbuddyIncremental(f);
  assert.equal(backfill.recordsProcessed, 0);
  assert.equal(backfill.projectBucketsQueued, 1);
  const projectRow = (await rows(f.projectQueuePath)).at(-1);
  assert.equal(projectRow.project_key, "example/workbuddy-project");
  assert.equal(projectRow.project_ref, "https://github.com/example/workbuddy-project");
  assert.equal(projectRow.source, "workbuddy");
  assert.equal(projectRow.total_tokens, 440);
  assert.equal(projectRow.conversation_count, 2);
  // Backfill must not move the totals queue.
  assert.equal(await fs.readFile(f.queuePath, "utf8"), aggregateBefore);

  const projectBefore = await fs.readFile(f.projectQueuePath, "utf8");
  f.cursors = JSON.parse(JSON.stringify(f.cursors));
  const repeated = await parseWorkbuddyIncremental(f);
  assert.equal(repeated.projectBucketsQueued, 0);
  assert.equal(await fs.readFile(f.projectQueuePath, "utf8"), projectBefore);

  await fs.appendFile(f.file, record("c", 50, { cwd: f.project }) + "\n");
  await parseWorkbuddyIncremental(f);
  assert.equal((await rows(f.queuePath)).at(-1).total_tokens, 510);
  assert.equal((await rows(f.projectQueuePath)).at(-1).total_tokens, 510);
});

test("WorkBuddy project cursor retries a partial final record without losing or doubling it", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.file, record("first", 100, { cwd: f.project }) + "\n");
  await parseWorkbuddyIncremental(f);

  const tail = record("second", 200, { cwd: f.project });
  await fs.appendFile(f.file, tail.slice(0, -4));
  await parseWorkbuddyIncremental(f);
  await fs.appendFile(f.file, tail.slice(-4) + "\n");
  f.cursors = JSON.parse(JSON.stringify(f.cursors));
  await parseWorkbuddyIncremental(f);

  // The project pass commits only fully-read records, so the completed tail is
  // picked up on the next sync.
  //
  // The totals pass is deliberately not compared here: it still commits
  // postStat.size, a pre-existing pattern this change does not touch, so it
  // has already advanced past the unfinished tail and skips that record. The
  // two queues are expected to differ in this specific case until the totals
  // reader is converted to a consumed-offset cursor as well.
  assert.equal((await rows(f.projectQueuePath)).at(-1).total_tokens, 340);
  const before = await fs.readFile(f.projectQueuePath, "utf8");
  await parseWorkbuddyIncremental(f);
  assert.equal(await fs.readFile(f.projectQueuePath, "utf8"), before);
});

test("WorkBuddy project append failure preserves cursors so both queues recover on retry", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.file, record("first", 100, { cwd: f.project }) + "\n");
  await parseWorkbuddyIncremental(f);
  await fs.appendFile(f.file, record("second", 200, { cwd: f.project }) + "\n");

  const before = JSON.stringify(f.cursors);
  const blocked = path.join(f.dir, "blocked-queue");
  await fs.mkdir(blocked);
  await assert.rejects(parseWorkbuddyIncremental({ ...f, projectQueuePath: blocked }));
  // A failed append must not mutate the state the caller still holds: the
  // buckets are staged, so a retry re-derives the same contribution.
  assert.equal(JSON.stringify(f.cursors), before);

  f.cursors = JSON.parse(before);
  await parseWorkbuddyIncremental(f);
  assert.equal((await rows(f.queuePath)).at(-1).total_tokens, 340);
  assert.equal((await rows(f.projectQueuePath)).at(-1).total_tokens, 340);
});

test("WorkBuddy totals append failure leaves the published buckets untouched", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.file, record("first", 100, { cwd: f.project }) + "\n");
  await parseWorkbuddyIncremental(f);
  await fs.appendFile(f.file, record("second", 200, { cwd: f.project }) + "\n");

  const before = JSON.stringify(f.cursors);
  const blocked = path.join(f.dir, "blocked-totals");
  await fs.mkdir(blocked);
  await assert.rejects(parseWorkbuddyIncremental({ ...f, queuePath: blocked }));
  assert.equal(JSON.stringify(f.cursors), before);

  f.cursors = JSON.parse(before);
  await parseWorkbuddyIncremental(f);
  assert.equal((await rows(f.queuePath)).at(-1).total_tokens, 340);
  assert.equal((await rows(f.projectQueuePath)).at(-1).total_tokens, 340);
});

test("WorkBuddy session cwd is read from the file head, not the incremental window", async (t) => {
  const f = await fixture(t);
  // The session opens with a record that omits cwd; the append that follows
  // omits it too. Both still belong to the session's project.
  await fs.appendFile(f.file, record("a", 100, { cwd: null }) + "\n");
  await fs.appendFile(f.file, record("b", 200, { cwd: f.project }) + "\n");
  await parseWorkbuddyIncremental(f);
  assert.equal((await rows(f.projectQueuePath)).at(-1).total_tokens, 340);

  await fs.appendFile(f.file, record("c", 400, { cwd: null }) + "\n");
  await parseWorkbuddyIncremental(f);
  assert.equal((await rows(f.projectQueuePath)).at(-1).total_tokens, 760);
  assert.equal((await rows(f.queuePath)).at(-1).total_tokens, 760);
});

test("WorkBuddy project dedup mirrors the totals pass's entry-id alias", async (t) => {
  const f = await fixture(t);
  // One response id, plus a legacy copy that only kept the same entry id.
  await fs.appendFile(f.file, [
    record("e1", 100, { cwd: f.project, messageId: "m1" }),
    record("e1", 100, { cwd: f.project }),
    "",
  ].join("\n"));
  await parseWorkbuddyIncremental(f);
  assert.equal((await rows(f.queuePath)).at(-1).total_tokens, 120);
  assert.equal((await rows(f.projectQueuePath)).at(-1).total_tokens, 120);
});

test("WorkBuddy project attribution requires a recoverable cwd", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.file, record("first", 100, { cwd: null }) + "\n");
  const result = await parseWorkbuddyIncremental(f);
  assert.equal(result.recordsProcessed, 1);
  assert.equal(result.projectBucketsQueued, 0);
  assert.equal((await rows(f.queuePath)).at(-1).total_tokens, 120);
  await assert.rejects(fs.access(f.projectQueuePath), { code: "ENOENT" });
});

test("WorkBuddy AI variant keeps its own source in project buckets", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.file, record("a", 100, { cwd: f.project }) + "\n");
  await parseWorkbuddyIncremental({ ...f, source: "workbuddy-ai" });
  assert.equal((await rows(f.projectQueuePath)).at(-1).source, "workbuddy-ai");
});

test("WorkBuddy project history stays replayable until cwd appears", async (t) => {
  const f = await fixture(t);
  // First sync sees usage with no cwd yet — totals count it, project does not,
  // and the project cursor must NOT advance past that history.
  await fs.appendFile(f.file, record("early", 100, { cwd: null }) + "\n");
  const first = await parseWorkbuddyIncremental(f);
  assert.equal(first.recordsProcessed, 1);
  assert.equal(first.projectBucketsQueued, 0);
  assert.equal((await rows(f.queuePath)).at(-1).total_tokens, 120);
  await assert.rejects(fs.access(f.projectQueuePath), { code: "ENOENT" });

  // A later append stamps cwd. Both the early record and the new one must
  // land in project usage (240 project tokens for two 120-token rounds).
  await fs.appendFile(f.file, record("late", 100, { cwd: f.project }) + "\n");
  f.cursors = JSON.parse(JSON.stringify(f.cursors));
  await parseWorkbuddyIncremental(f);
  assert.equal((await rows(f.projectQueuePath)).at(-1).total_tokens, 240);
  assert.equal((await rows(f.queuePath)).at(-1).total_tokens, 240);
});

test("WorkBuddy project pass tolerates a JSON null line without aborting", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(
    f.file,
    [record("a", 100, { cwd: f.project }), "null", record("b", 200, { cwd: f.project }), ""].join("\n"),
  );
  await parseWorkbuddyIncremental(f);
  assert.equal((await rows(f.queuePath)).at(-1).total_tokens, 340);
  assert.equal((await rows(f.projectQueuePath)).at(-1).total_tokens, 340);
});
