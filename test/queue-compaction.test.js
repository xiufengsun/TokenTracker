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

test("compactQueueFile skips rewriting >5000 distinct keys when no redundant rows exist", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-compact-distinct-"));
  const queuePath = path.join(tmpDir, "queue.jsonl");

  try {
    const lines = [];
    for (let i = 0; i < 5005; i++) {
      lines.push(JSON.stringify({
        source: "codex",
        model: `model-${i}`,
        hour_start: "2026-07-17T00:00:00.000Z",
        total_tokens: 100,
      }));
    }
    fs.writeFileSync(queuePath, lines.join("\n") + "\n", "utf8");

    const compacted = compactQueueFile(queuePath, false);
    assert.equal(compacted, false, "should skip rewrite when all >5000 keys are distinct");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("compactQueueFile skips compaction when upload state offset is partial", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-compact-partial-"));
  const queuePath = path.join(tmpDir, "queue.jsonl");
  const statePath = path.join(tmpDir, "queue.state.json");

  try {
    const lines = [];
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
    const content = lines.join("\n") + "\n";
    fs.writeFileSync(queuePath, content, "utf8");
    fs.writeFileSync(statePath, JSON.stringify({ offset: 120 }), "utf8");

    const compacted = compactQueueFile(queuePath, false, statePath);
    assert.equal(compacted, false, "should skip compaction while upload offset is partial");
    assert.equal(fs.readFileSync(queuePath, "utf8"), content);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("compactQueueFile selects strictly newer snapshot_verified_at for account_session_state and keeps first on ties", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-compact-session-state-"));
  const queuePath = path.join(tmpDir, "queue.jsonl");

  try {
    const makeState = (sessionId, total, stamp) => ({
      kind: "account_session_state",
      source: "trae-cn",
      session_id: sessionId,
      model: "model-a",
      bucket_start: "2026-10-12T00:00:00.000Z",
      input_tokens: total,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: total,
      snapshot_verified_at: stamp,
    });

    const lines = [
      // Session 1: newer stamp comes first, older comes second -> keep first (100)
      JSON.stringify(makeState("s1", 100, "2026-10-12T00:05:00.000Z")),
      JSON.stringify(makeState("s1", 50, "2026-10-12T00:01:00.000Z")),
      // Session 2: tie stamp -> keep first (200)
      JSON.stringify(makeState("s2", 200, "2026-10-12T00:05:00.000Z")),
      JSON.stringify(makeState("s2", 250, "2026-10-12T00:05:00.000Z")),
      // Session 3: strictly newer stamp comes second -> keep second (350)
      JSON.stringify(makeState("s3", 300, "2026-10-12T00:05:00.000Z")),
      JSON.stringify(makeState("s3", 350, "2026-10-12T00:06:00.000Z")),
    ];
    for (let i = 0; i < 120; i++) {
      lines.push(JSON.stringify({
        source: "codex",
        model: "gpt-5",
        hour_start: "2026-07-17T00:00:00.000Z",
        total_tokens: i + 1,
      }));
    }
    fs.writeFileSync(queuePath, lines.join("\n") + "\n", "utf8");

    assert.equal(compactQueueFile(queuePath, false), true);
    const out = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const bySession = new Map(
      out.filter((r) => r.kind === "account_session_state").map((r) => [r.session_id, r.total_tokens])
    );
    assert.equal(bySession.get("s1"), 100);
    assert.equal(bySession.get("s2"), 200);
    assert.equal(bySession.get("s3"), 350);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
