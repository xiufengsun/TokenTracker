const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { parseWorkbuddyIncremental } = require("../src/lib/rollout");

test("WorkBuddy trace totals and cursor describe the opened file when the path is replaced", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-workbuddy-trace-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "trace.json");
  const queuePath = path.join(root, "queue.jsonl");
  const trace = (id, model, input) => JSON.stringify({ trace: {
    traceId: id, startedAt: "2026-04-05T14:00:00.000Z",
    metadata: { sessionId: id, modelInfo: { models: [model], totalInputTokens: input, totalOutputTokens: 3 } },
  } });
  fs.writeFileSync(file, trace("first", "hy3-preview-agent", 11));
  const checked = fs.statSync(file);
  const stat = fs.statSync;
  const fstat = fs.fstatSync;
  const open = fs.openSync;
  let traceFd;
  let replaced = false;
  function replaceAfterCheck(info) {
    if (!replaced) {
      replaced = true;
      fs.renameSync(file, path.join(root, "checked-trace.json"));
      fs.writeFileSync(file, trace("second-with-a-longer-new-session-id", "gpt-5", 21));
    }
    return info;
  }
  fs.openSync = (target, ...args) => {
    const fd = open(target, ...args);
    if (target === file) traceFd = fd;
    return fd;
  };
  fs.statSync = (target, ...args) => {
    const info = stat(target, ...args);
    return target === file ? replaceAfterCheck(info) : info;
  };
  fs.fstatSync = (fd, ...args) => {
    const info = fstat(fd, ...args);
    return fd === traceFd ? replaceAfterCheck(info) : info;
  };
  const cursors = { version: 1 };
  const options = { projectFiles: [{ path: file, kind: "trace" }], cursors, queuePath,
    env: { WORKBUDDY_HOME: root, HOME: root } };
  try {
    const first = await parseWorkbuddyIncremental(options);
    assert.equal(first.eventsAggregated, 1);
    assert.equal(replaced, true);
  } finally { fs.openSync = open; fs.statSync = stat; fs.fstatSync = fstat; }
  const rows = () => fs.readFileSync(queuePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows()[0].input_tokens, 11);
  assert.equal(cursors.workbuddy.fileOffsets[file].size, checked.size);
  assert.equal(cursors.workbuddy.fileOffsets[file].ino, checked.ino);
  assert.equal((await parseWorkbuddyIncremental(options)).eventsAggregated, 1);
  assert.equal(rows().find(row => row.model === "gpt-5").input_tokens, 21);
  assert.equal((await parseWorkbuddyIncremental(options)).eventsAggregated, 0);
});
