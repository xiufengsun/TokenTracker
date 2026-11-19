const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const inventory = require("../src/lib/multi-install-parser");
const { collectOmoClaudeResponseIds, parseOmoIncremental } = require("../src/lib/rollout");

function entry(id = "valid") {
  return { type: "message", id, timestamp: "2026-11-10T03:12:32.673Z", message: {
    role: "assistant", model: "claude-sonnet-5-5", responseId: `response-${id}`,
    usage: { input: 10, output: 5 },
  } };
}

async function fixture(t, bytes) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-omo-match-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const agent = path.join(home, "omo");
  const file = path.join(agent, "sessions", "project", "session.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return { home, file, env: { HOME: home, TOKENTRACKER_OMO_AGENT_DIR: agent } };
}

test("matching accepts exactly the usage eligibility exercised by OmO ingestion", async (t) => {
  const cases = [
    ["valid", (e) => e, true],
    ["no-id", (e) => { delete e.id; return e; }, false],
    ["wrong-type", (e) => ({ ...e, type: "session" }), false],
    ["user-role", (e) => { e.message.role = "user"; return e; }, false],
    ["no-usage", (e) => { delete e.message.usage; return e; }, false],
    ["zero", (e) => { e.message.usage = { input: 0, output: 0 }; return e; }, false],
    ["total-only", (e) => { e.message.usage = { totalTokens: 15 }; return e; }, false],
    ["undated", (e) => { delete e.timestamp; return e; }, false],
    ["bad-date", (e) => ({ ...e, timestamp: "not-a-date" }), false],
    ["reasoning", (e) => { e.message.usage = { reasoning: 7 }; return e; }, true],
    ["reasoning-priority", (e) => { e.message.usage = { reasoningTokens: 0, reasoning: 7 }; return e; }, false],
    ["message-time", (e) => { e.timestamp = "invalid"; e.message.timestamp = Date.parse("2026-11-10T03:12:32Z"); return e; }, true],
  ];
  for (const [name, change, expected] of cases) {
    await t.test(name, async (t) => {
      const value = change(entry(name));
      const f = await fixture(t, JSON.stringify(value) + "\n");
      const ids = await collectOmoClaudeResponseIds(f.env);
      const result = await parseOmoIncremental({ sessionFiles: [f.file], cursors: {}, queuePath: path.join(f.home, "queue.jsonl") });
      assert.equal(ids.has(value.message.responseId), expected);
      assert.equal(result.eventsAggregated > 0, expected);
    });
  }
});

test("invalid UTF-8 cannot claim a response that ingestion rejects", async (t) => {
  const value = entry("utf8");
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(value).slice(0, -1) + ',"extra":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const f = await fixture(t, bytes);
  assert.deepEqual([...await collectOmoClaudeResponseIds(f.env)], []);
  const result = await parseOmoIncremental({ sessionFiles: [f.file], cursors: {}, queuePath: path.join(f.home, "queue.jsonl") });
  assert.equal(result.eventsAggregated, 0);
});

test("out-of-range timestamps cannot crash the matching inventory", async (t) => {
  const value = entry("range");
  value.message.timestamp = 1e40;
  const f = await fixture(t, JSON.stringify(value) + "\n");
  assert.deepEqual([...await collectOmoClaudeResponseIds(f.env)], []);
});

test("matching uses the same native/WSL union entry point for sessions and subagents", async (t) => {
  const f = await fixture(t, JSON.stringify(entry("native")) + "\n");
  const wsl = path.join(f.home, "wsl-subagent.jsonl");
  await fs.writeFile(wsl, JSON.stringify(entry("wsl")) + "\n");
  const calls = [];
  t.mock.method(inventory, "mergeBothFileSources", (options) => {
    calls.push(options);
    return options.resolveFiles.name === "resolveOmoSessionFiles" ? [f.file] : [wsl];
  });
  assert.deepEqual([...await collectOmoClaudeResponseIds(f.env)].sort(), ["response-native", "response-wsl"]);
  assert.deepEqual(calls.map((c) => c.resolveFiles.name), ["resolveOmoSessionFiles", "resolveOmoSubagentFiles"]);
  assert.ok(calls.every((c) => c.env === f.env));
});

test("a partial source read never publishes its provisional matching ids", async (t) => {
  const raw = JSON.stringify(entry("partial")) + "\n";
  const f = await fixture(t, raw);
  const original = fssync.createReadStream;
  t.mock.method(fssync, "createReadStream", function (file, options) {
    if (file !== f.file) return original.call(this, file, options);
    return Readable.from((async function* () {
      yield Buffer.from(raw);
      throw Object.assign(new Error("unreadable tail"), { code: "EIO" });
    })());
  });
  assert.deepEqual([...await collectOmoClaudeResponseIds(f.env)], []);
});
