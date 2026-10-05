"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseCommandCodeIncremental } = require("../src/lib/rollout");

const timestamp = "2026-05-01T12:01:00.000Z";
const hour = "2026-05-01T12:00:00.000Z";

function latestRows(file, project = false) {
  const rows = new Map();
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      rows.set(project ? row.project_key : row.model, row);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return rows;
}

// Recompute expected buckets from durable observations, independently of the
// implementation's subtract/add deltas and ownership cache. Fixed seeds keep
// every failing operation sequence reproducible on all platforms.
for (const seed of [17, 661, 2026]) {
  test(`Command Code lifecycle matches a durable-ledger oracle (seed ${seed})`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-oracle-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const repos = ["alpha", "beta"].map((name) => {
      const repo = path.join(dir, name);
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".git", "config"), `[remote "origin"]\nurl = https://github.com/fixture/${name}.git\n`);
      return repo;
    });
    const files = [0, 1, 2].map((id) => path.join(dir, `${id}.jsonl`));
    const sources = files.map(() => ({ present: true, repo: 0, records: [] }));
    const disk = new Map();
    const ledger = new Map();
    const options = { cursors: {}, queuePath: path.join(dir, "queue.jsonl"), projectQueuePath: path.join(dir, "project.jsonl") };
    let randomState = seed;
    const random = (max) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return (randomState >>> 8) % max;
    };
    const sumRows = (project) => {
      const sums = new Map();
      for (const entry of ledger.values()) {
        const key = project ? `fixture/${entry.repo === 0 ? "alpha" : "beta"}` : entry.model;
        const totals = sums.get(key) || { input_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, total_tokens: 0, conversation_count: 0 };
        totals.input_tokens += entry.input;
        totals.cached_input_tokens += entry.read;
        totals.cache_creation_input_tokens += entry.write;
        totals.output_tokens += entry.output;
        const total = entry.input + entry.read + entry.write + entry.output;
        totals.total_tokens += total;
        totals.conversation_count += total > 0 ? 1 : 0;
        sums.set(key, totals);
      }
      return sums;
    };

    for (let step = 0; step < 90; step++) {
      const index = random(3);
      const source = sources[index];
      const action = random(6);
      if (action === 0) source.present = false;
      else if (action === 1) source.records = [];
      else if (action === 2) source.repo = 1 - source.repo;
      else if (action === 3) {
        sources[index] = structuredClone(sources[(index + 1) % 3]);
        sources[index].present = true;
      } else {
        source.present = true;
        const id = `m${random(7)}`;
        const scale = random(4);
        const entry = { id, model: random(2) ? "model-a" : "model-b", input: scale * 100, read: scale * 30, write: scale * 10, output: scale * 20 };
        const previous = source.records.findIndex((record) => record.id === id);
        if (previous < 0) source.records.push(entry);
        else source.records[previous] = entry;
      }

      const observed = new Map();
      options.sessionFiles = [];
      for (let i = 0; i < sources.length; i++) {
        const current = sources[i];
        if (!current.present) {
          if (disk.has(files[i])) { fs.unlinkSync(files[i]); disk.delete(files[i]); }
          continue;
        }
        const text = [JSON.stringify({ type: "session", id: `session-${i}`, cwd: repos[current.repo] }), ...current.records.map((record) => JSON.stringify({
          type: "message", id: record.id, timestamp, model: record.model,
          usage: { inputTokens: record.input + record.read + record.write, cacheReadTokens: record.read, cacheWriteTokens: record.write, outputTokens: record.output },
        }))].join("\n") + "\n";
        if (disk.get(files[i]) !== text) {
          fs.writeFileSync(files[i], text);
          fs.utimesSync(files[i], new Date(0), new Date(1_800_000_000_000 + step * 1000));
          disk.set(files[i], text);
        }
        options.sessionFiles.push(files[i]);
        for (const record of current.records) observed.set(record.id, { ...record, repo: current.repo });
      }
      for (const [id, record] of observed) {
        if (ledger.has(id) || record.input + record.read + record.write + record.output > 0) ledger.set(id, record);
      }
      options.cursors = JSON.parse(JSON.stringify(options.cursors));
      await parseCommandCodeIncremental(options);
      for (const project of [false, true]) {
        const expected = sumRows(project);
        const actual = latestRows(project ? options.projectQueuePath : options.queuePath, project);
        for (const key of new Set([...expected.keys(), ...actual.keys()])) {
          const row = actual.get(key);
          const total = expected.get(key);
          for (const field of ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "total_tokens", "conversation_count"]) {
            assert.equal(row?.[field] || 0, total?.[field] || 0, `step=${step} project=${project} key=${key} field=${field}`);
          }
          if (row) {
            assert.equal(row.hour_start, hour);
            assert.equal(row.billable_total_tokens, row.total_tokens);
            assert.equal(row.total_cost_usd, 0);
          }
        }
      }
      assert.equal((await parseCommandCodeIncremental(options)).bucketsQueued, 0, `repeat step ${step}`);
    }
  });
}
