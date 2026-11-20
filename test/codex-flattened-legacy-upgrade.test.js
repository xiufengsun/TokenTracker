"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseRolloutIncremental } = require("../src/lib/rollout");

const HOUR = "2026-02-27T18:00:00.000Z";
const HOUR2 = "2026-07-09T22:30:00.000Z";
const totals = (n) => ({
  input_tokens: n,
  output_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: n,
  billable_total_tokens: n,
  conversation_count: 1,
});
const lines = (records) => records.map((row) => `${JSON.stringify(row)}\n`).join("");
async function latestByModelHour(queuePath) {
  const rows = new Map();
  const raw = (await fs.readFile(queuePath, "utf8")).trim();
  if (!raw) return rows;
  for (const row of raw.split("\n").map(JSON.parse)) {
    rows.set(`${row.model}|${row.hour_start}`, row);
  }
  return rows;
}

// #1052: a pre-#1031 repair flattened per-model hourly keys into
// `codex|unknown|<hour>` while leaving groupQueued + named queue rows intact.
// Upgrading must not re-emit that flattened unknown beside the named rows.
test("#1052 flattened unknown+groupQueued does not re-emit unknown beside named queue rows", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-1052-flat-"));
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.writeFile(queuePath, lines([
      { source: "codex", model: "gpt-5.3-codex", hour_start: HOUR, ...totals(462841) },
      { source: "codex", model: "gpt-5.6-sol", hour_start: HOUR2, ...totals(51133406) },
    ]));
    let cursors = {
      hourly: {
        version: 3,
        buckets: {
          [`codex|unknown|${HOUR}`]: { totals: totals(462841), queuedKey: "old" },
          [`codex|unknown|${HOUR2}`]: {
            totals: totals(96003),
            queuedKey: "old2",
            alignedModel: "gpt-5.6-sol",
          },
        },
        groupQueued: {
          [`codex|${HOUR}`]: "group-key-1",
          [`codex|${HOUR2}`]: "group-key-2",
        },
      },
    };
    const before = await fs.readFile(queuePath, "utf8");
    const result = await parseRolloutIncremental({ rolloutFiles: [], cursors, queuePath });
    assert.equal(result.bucketsQueued, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), before);
    const rows = await latestByModelHour(queuePath);
    assert.equal(rows.has(`unknown|${HOUR}`), false);
    assert.equal(rows.has(`unknown|${HOUR2}`), false);
    assert.equal(rows.get(`gpt-5.3-codex|${HOUR}`).total_tokens, 462841);
    assert.equal(rows.get(`gpt-5.6-sol|${HOUR2}`).total_tokens, 51133406);
    assert.deepEqual(cursors.hourly.groupQueued, {});
    assert.deepEqual(cursors.hourly.modelAttributionPolicy, { codex: "observed" });

    cursors = JSON.parse(JSON.stringify(cursors));
    const stable = await fs.readFile(queuePath, "utf8");
    const second = await parseRolloutIncremental({ rolloutFiles: [], cursors, queuePath });
    assert.equal(second.bucketsQueued, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), stable);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Named models still present in hourly buckets keep the #927 split path.
test("#1052 legacy groups with named buckets still split and zero stale unknown", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-1052-named-"));
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.writeFile(queuePath, lines([
      { source: "codex", model: "unknown", hour_start: HOUR, ...totals(300) },
    ]));
    const cursors = {
      hourly: {
        version: 3,
        buckets: {
          [`codex|gpt-6-astra|${HOUR}`]: { totals: totals(100), queuedKey: "old-a" },
          [`codex|gpt-6.1-sol|${HOUR}`]: { totals: totals(200), queuedKey: "old-b" },
        },
        groupQueued: { [`codex|${HOUR}`]: "old-group-key" },
      },
    };
    await parseRolloutIncremental({ rolloutFiles: [], cursors, queuePath });
    const rows = await latestByModelHour(queuePath);
    assert.equal(rows.get(`gpt-6-astra|${HOUR}`).total_tokens, 100);
    assert.equal(rows.get(`gpt-6.1-sol|${HOUR}`).total_tokens, 200);
    assert.equal(rows.get(`unknown|${HOUR}`).total_tokens, 0);
    assert.deepEqual(cursors.hourly.groupQueued, {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
