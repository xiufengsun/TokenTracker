"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseClaudeIncremental } = require("../src/lib/rollout");
const { computeRowCost } = require("../src/lib/pricing");

test("Claude reasoning details survive incremental parsing without double billing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reasoning-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = [
    [{ thinking_tokens: 163 }, 163],
    [{ reasoning_tokens: 163 }, 163],
    [{ thinking_tokens: 0, reasoning_tokens: 163 }, 0],
    [{ thinking_tokens: 0 }, 0],
    [undefined, 0],
    [null, 0],
    [{}, 0],
    [{ thinking_tokens: -1 }, 0],
    [{ thinking_tokens: "invalid" }, 0],
    [{ thinking_tokens: 9999 }, 518],
  ];
  for (const [index, [details, reasoning]] of cases.entries()) {
    const file = path.join(dir, `session-${index}.jsonl`);
    const queuePath = path.join(dir, `queue-${index}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({
      type: "assistant", timestamp: "2026-09-07T03:00:00Z",
      message: { id: `m-${index}`, model: "claude-sonnet-4-6", usage: {
        input_tokens: 420, cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20, output_tokens: 518,
        output_tokens_details: details,
      } },
    }) + "\n");
    const options = { projectFiles: [file], queuePath, cursors: {}, source: "claude" };
    await parseClaudeIncremental(options);
    const saved = fs.readFileSync(queuePath, "utf8");
    const row = JSON.parse(saved.trim().split("\n").at(-1));
    assert.equal(row.reasoning_output_tokens, reasoning, `case ${index}`);
    assert.equal(row.output_tokens, 518 - reasoning);
    assert.equal(row.total_tokens, 1058);
    assert.equal(row.input_tokens + row.cached_input_tokens + row.cache_creation_input_tokens + row.output_tokens + row.reasoning_output_tokens, row.total_tokens);
    assert.equal(computeRowCost(row), 0); // No backend observations: unknown pricing.
    const priced = { ...row, backend_usage: undefined };
    const beforeCost = computeRowCost({ ...priced, output_tokens: 518, reasoning_output_tokens: 0 });
    assert.ok(beforeCost > 0);
    assert.ok(Math.abs(computeRowCost(priced) - beforeCost) < 1e-12);
    await parseClaudeIncremental(options);
    assert.equal(fs.readFileSync(queuePath, "utf8"), saved);
  }
});
