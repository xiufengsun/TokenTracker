const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { compactQueueFile } = require("../src/commands/sync");

test("compactQueueFile deduplicates queue entries preserving chronological order", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-compact-test-"));
  const queuePath = path.join(tmpDir, "queue.jsonl");

  try {
    const lines = [];
    // Generate 150 lines with 50 unique keys (3x redundancy > 2x threshold)
    for (let round = 1; round <= 3; round++) {
      for (let i = 0; i < 50; i++) {
        lines.push(JSON.stringify({
          source: "codex",
          model: `model-${i}`,
          hour_start: "2026-07-17T00:00:00.000Z",
          total_tokens: round * 100,
        }));
      }
    }
    fs.writeFileSync(queuePath, lines.join("\n") + "\n", "utf8");

    const compacted = compactQueueFile(queuePath, false);
    assert.equal(compacted, true, "compaction should trigger for >2x redundant rows");

    const resultLines = fs.readFileSync(queuePath, "utf8").trim().split("\n");
    assert.equal(resultLines.length, 50, "should keep exactly 50 unique keys");

    // Verify last-write-wins (round 3 values = 300) and chronological order
    for (let i = 0; i < 50; i++) {
      const parsed = JSON.parse(resultLines[i]);
      assert.equal(parsed.model, `model-${i}`);
      assert.equal(parsed.total_tokens, 300);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("compactQueueFile does not trigger under threshold", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-compact-sub-"));
  const queuePath = path.join(tmpDir, "queue.jsonl");

  try {
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({
        source: "codex",
        model: `model-${i}`,
        hour_start: "2026-07-17T00:00:00.000Z",
        total_tokens: 100,
      }));
    }
    fs.writeFileSync(queuePath, lines.join("\n") + "\n", "utf8");

    const compacted = compactQueueFile(queuePath, false);
    assert.equal(compacted, false, "compaction should not trigger when not redundant");
    assert.equal(fs.readFileSync(queuePath, "utf8").trim().split("\n").length, 50);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
