"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const { Readable } = require("node:stream");
const os = require("node:os");
const path = require("node:path");
const { importCoworkUsage, runAdapter } = require("../scripts/cowork-local-adapter.cjs");
const { parseClaudeIncremental, listClaudeProjectFiles } = require("../src/lib/rollout");
const { openLock } = require("../src/lib/fs");
const { computeClaudeGroundTruthBuckets } = require("../src/lib/claude-categorizer");

const packageRoot = path.resolve(__dirname, "..");
/** Build a synthetic per-turn ledger entry, with optional field overrides. */
const event = (overrides = {}) => ({
  v: 1, ts: Date.parse("2026-10-26T07:25:12Z"), surface: "cowork",
  origin: "turn", sessionId: "private-session", isError: false,
  models: { "claude-opus-5-5": {
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 200,
    cost: { usd: 999, basis: "list" },
  } },
  tools: { private: "DO_NOT_COPY" }, ...overrides,
});

/** Run an integration scenario in an isolated home and remove its files afterward. */
async function fixture(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-cowork-"));
  const roots = ["Claude", "Claude-3p"].map((name) =>
    path.join(home, "Library", "Application Support", name, "local-agent-mode-sessions"));
  const ledger = path.join(roots[1], "account", "profile", "usage-ledger", "2026-10-26.ndjson");
  const outputRoot = path.join(home, ".tokentracker", "cowork-adapter", "claude");
  await fs.mkdir(path.dirname(ledger), { recursive: true });
  const write = (events) => fs.writeFile(ledger, events.map(JSON.stringify).join("\n") + "\n");
  try { await fn({ home, roots, ledger, outputRoot, write }); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

/** Parse the generated journal and return the latest aggregate for each bucket. */
async function parse(outputRoot, home, cursors = {}) {
  const queuePath = path.join(home, "parser-queue.jsonl");
  await parseClaudeIncremental({
    projectFiles: await listClaudeProjectFiles(path.join(outputRoot, "projects")),
    cursors, queuePath, source: "claude",
  });
  const raw = await fs.readFile(queuePath, "utf8");
  const latest = new Map();
  for (const line of raw.trim().split("\n")) {
    const row = JSON.parse(line);
    latest.set([row.source, row.model, row.hour_start].join("|"), row);
  }
  return [...latest.values()];
}

/** Inject a read-stream failure after one complete row, retaining the real parser. */
async function withClaudeReadFailure(file, fn) {
  const originalReadStream = fssync.createReadStream;
  let incrementalReads = 0;
  fssync.createReadStream = function (filePath, options) {
    // Let the lineage pre-scan finish; fail the subsequent token read. Other
    // reads (bounded cwd discovery and ground-truth repair) stay functional.
    if (filePath !== file || options?.start == null || options?.end != null || ++incrementalReads === 1)
      return originalReadStream.call(this, filePath, options);
    const tail = fssync.readFileSync(file).subarray(options?.start || 0);
    return Readable.from((async function* () {
      yield tail.subarray(0, tail.indexOf(10) + 1);
      await new Promise((resolve) => setImmediate(resolve));
      throw Object.assign(new Error("simulated Claude read failure"), { code: "EIO" });
    })());
  };
  try { await fn(); }
  finally { fssync.createReadStream = originalReadStream; }
}

test("real parser: exact cache semantics, no private text or invented conversations, stable rescan", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    const first = await importCoworkUsage(f);
    assert.equal(first.imported, 1);
    const cursors = {};
    const rows = await parse(f.outputRoot, f.home, cursors);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_tokens, 100);
    assert.equal(rows[0].output_tokens, 50);
    assert.equal(rows[0].cached_input_tokens, 1000);
    assert.equal(rows[0].cache_creation_input_tokens, 200);
    assert.equal(rows[0].total_tokens, 1350);
    assert.equal(rows[0].conversation_count, 0);
    assert.equal(rows[0].hour_start, "2026-10-26T07:00:00.000Z");
    const files = await listClaudeProjectFiles(path.join(f.outputRoot, "projects"));
    const content = await fs.readFile(files[0], "utf8");
    for (const secret of ["DO_NOT_COPY", "private-session", "999", "tools", "cost"])
      assert.ok(!content.includes(secret), secret);
    const stat = await fs.stat(files[0]);
    assert.equal((await importCoworkUsage(f)).imported, 0);
    assert.deepEqual(await parse(f.outputRoot, f.home, cursors), rows);
    assert.equal((await fs.stat(files[0])).ino, stat.ino);
    // Simulate a fresh device/ground-truth rebuild, without the old cursor.
    assert.deepEqual(await parse(f.outputRoot, f.home, {}), rows);
    const truth = await computeClaudeGroundTruthBuckets({ rootDirs: [path.join(f.outputRoot, "projects")] });
    assert.equal(truth.rows.reduce((sum, row) => sum + row.total_tokens, 0), 1350);
  });
});

test("append and duplicate profiles: each event/model once, history survives source rotation", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    await importCoworkUsage(f);
    const cursors = {};
    await parse(f.outputRoot, f.home, cursors);
    const second = event({ ts: event().ts + 1000, isError: true });
    await f.write([event(), second, second]);
    const copy = path.join(f.roots[0], "account", "profile", "usage-ledger", "2026-10-26.ndjson");
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.copyFile(f.ledger, copy);
    assert.equal((await importCoworkUsage(f)).imported, 1);
    let rows = await parse(f.outputRoot, f.home, cursors);
    assert.equal(rows[0].total_tokens, 2700);
    await fs.rm(f.roots[0], { recursive: true });
    await fs.rm(f.roots[1], { recursive: true });
    assert.equal((await importCoworkUsage(f)).imported, 0);
    rows = await parse(f.outputRoot, f.home, {});
    assert.equal(rows[0].total_tokens, 2700);
  });
});

test("skip partial/malformed/unsupported records, accept the completed tail on next run", async () => {
  await fixture(async (f) => {
    const valid = JSON.stringify(event());
    const invalid = [event({ v: 2 }), event({ surface: "chat" }), event({ origin: "session" }),
      event({ models: { bad: { inputTokens: -1 } } }), event({ ts: "invalid" })];
    await fs.writeFile(f.ledger, invalid.map(JSON.stringify).join("\n") + "\n{bad}\n" + valid.slice(0, -2));
    assert.equal((await importCoworkUsage(f)).imported, 0);
    await fs.appendFile(f.ledger, valid.slice(-2) + "\n");
    assert.equal((await importCoworkUsage(f)).imported, 1);
    assert.equal((await parse(f.outputRoot, f.home))[0].total_tokens, 1350);
  });
});

test("conflicting event counters fail before any records are published", async () => {
  await fixture(async (f) => {
    const changed = event();
    changed.models["claude-opus-5-5"].inputTokens++;
    await f.write([event(), changed]);
    await assert.rejects(importCoworkUsage(f), /conflicting/i);
    assert.deepEqual(await listClaudeProjectFiles(path.join(f.outputRoot, "projects")), []);
    await f.write([event()]);
    await importCoworkUsage(f);
    await f.write([changed]);
    await assert.rejects(importCoworkUsage(f), /conflicting/i);
    assert.equal((await parse(f.outputRoot, f.home))[0].total_tokens, 1350);
  });
});

test("runAdapter shares the native sync lock and preserves unrelated config", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    const dir = path.join(f.home, ".tokentracker", "tracker");
    await fs.mkdir(dir, { recursive: true });
    const configPath = path.join(dir, "config.json");
    const config = { deviceId: "preserve", scanRoots: { claude: ["~/custom-claude"], codex: ["~/custom-codex"] } };
    await fs.writeFile(configPath, JSON.stringify(config));
    const lock = await openLock(path.join(dir, "sync.lock"));
    try {
      const result = await runAdapter({ home: f.home, trackerPackage: packageRoot, refresh: false });
      assert.equal(result.busy, true);
      assert.deepEqual(JSON.parse(await fs.readFile(configPath)), config);
    } finally { await lock.release(); }
    assert.equal((await runAdapter({ home: f.home, trackerPackage: packageRoot, refresh: false })).imported, 1);
    const next = JSON.parse(await fs.readFile(configPath));
    assert.equal(next.deviceId, config.deviceId);
    assert.deepEqual(next.scanRoots.codex, config.scanRoots.codex);
    assert.deepEqual(next.scanRoots.claude, ["~/custom-claude", f.outputRoot]);
    assert.equal((await runAdapter({ home: f.home, trackerPackage: packageRoot, refresh: false })).imported, 0);
    assert.equal(JSON.parse(await fs.readFile(configPath)).scanRoots.claude.length, 2);
  });
});

test("real scoped sync: update Claude, preserve Codex and repeat without growth", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    const dir = path.join(f.home, ".tokentracker", "tracker");
    await fs.mkdir(dir, { recursive: true });
    const baseline = {
      source: "codex", model: "gpt-5", hour_start: "2026-10-26T07:00:00.000Z",
      input_tokens: 123, output_tokens: 7, cached_input_tokens: 0,
      cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
      total_tokens: 130, conversation_count: 1,
    };
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.writeFile(queuePath, JSON.stringify(baseline) + "\n");
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ deviceId: "test-only" }));
    // Running from a checkout must use its runtime, even with a desktop app installed.
    const result = await runAdapter({ home: f.home });
    assert.equal(result.refreshed, true);
    const raw = await fs.readFile(queuePath, "utf8");
    const rows = raw.trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.filter((r) => r.source === "codex"), [baseline]);
    assert.equal(rows.filter((r) => r.source === "claude").at(-1).total_tokens, 1350);
    assert.equal((await runAdapter({ home: f.home, trackerPackage: packageRoot })).refreshed, false);
    assert.equal(await fs.readFile(queuePath, "utf8"), raw);
  });
});

test("recover a partially appended journal after the actual parser has already observed it", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    await importCoworkUsage(f);
    const files = await listClaudeProjectFiles(path.join(f.outputRoot, "projects"));
    const cursors = {};
    await parse(f.outputRoot, f.home, cursors);
    await fs.appendFile(files[0], '{"type":"assistant","interrupted":');
    await parse(f.outputRoot, f.home, cursors);
    await f.write([event(), event({ ts: event().ts + 1000 })]);
    assert.equal((await importCoworkUsage(f)).imported, 1);
    assert.equal((await parse(f.outputRoot, f.home, cursors))[0].total_tokens, 2700);
    assert.equal((await parse(f.outputRoot, f.home, {}))[0].total_tokens, 2700);
  });
});

test("two models on one turn retain both counters and deduplicate separately", async () => {
  await fixture(async (f) => {
    const row = event();
    row.models["claude-sonnet-4"] = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 };
    await f.write([row]);
    assert.equal((await importCoworkUsage(f)).imported, 2);
    const rows = await parse(f.outputRoot, f.home);
    assert.equal(rows.reduce((sum, r) => sum + r.total_tokens, 0), 1368);
    assert.equal((await importCoworkUsage(f)).imported, 0);
  });
});

test("a second bridge instance cannot publish or clear a pending refresh", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    const dir = path.join(f.home, ".tokentracker", "cowork-adapter");
    await fs.mkdir(dir, { recursive: true });
    const pending = path.join(dir, "refresh-pending.json");
    await fs.writeFile(pending, "{}\n");
    const lock = await openLock(path.join(dir, "run.lock"));
    try {
      const result = await runAdapter({ home: f.home, trackerPackage: packageRoot });
      assert.equal(result.busy, true);
      assert.equal(await fs.readFile(pending, "utf8"), "{}\n");
    } finally { await lock.release(); }
  });
});

test("failed refresh retains pending state and retries without duplicating usage or changing upload credentials", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    const sync = require("../src/commands/sync");
    const originalSync = sync.cmdSync;
    const key = "TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN";
    const originalToken = process.env[key];
    const pending = path.join(f.home, ".tokentracker", "cowork-adapter", "refresh-pending.json");
    process.env[key] = "synthetic-test-token";
    try {
      sync.cmdSync = async () => {
        assert.equal(process.env[key], "");
        throw new Error("simulated refresh failure");
      };
      await assert.rejects(runAdapter({ home: f.home }), /simulated refresh failure/);
      assert.equal(process.env[key], "synthetic-test-token");
      await fs.access(pending);
      sync.cmdSync = originalSync;
      const result = await runAdapter({ home: f.home });
      assert.equal(result.imported, 0);
      assert.equal(result.refreshed, true);
      assert.equal(process.env[key], "synthetic-test-token");
      await assert.rejects(fs.access(pending), { code: "ENOENT" });
      assert.equal((await parse(f.outputRoot, f.home))[0].total_tokens, 1350);
    } finally {
      sync.cmdSync = originalSync;
      if (originalToken === undefined) delete process.env[key]; else process.env[key] = originalToken;
    }
  });
});

test("invalid existing configuration is preserved instead of replaced", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    const dir = path.join(f.home, ".tokentracker", "tracker");
    await fs.mkdir(dir, { recursive: true });
    const configPath = path.join(dir, "config.json");
    for (const raw of ["{broken", "null", "[]", '{"scanRoots":{"claude":42}}']) {
      await fs.writeFile(configPath, raw);
      await assert.rejects(runAdapter({ home: f.home }));
      assert.equal(await fs.readFile(configPath, "utf8"), raw);
      assert.deepEqual(await listClaudeProjectFiles(path.join(f.outputRoot, "projects")), []);
    }
  });
});

test("real Claude read failure preserves the retry marker and recovers unchanged ledgers exactly once", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    await runAdapter({ home: f.home });
    const dir = path.join(f.home, ".tokentracker", "tracker");
    const queuePath = path.join(dir, "queue.jsonl");
    const before = await fs.readFile(queuePath, "utf8");
    const [journal] = await listClaudeProjectFiles(path.join(f.outputRoot, "projects"));
    const pending = path.join(f.home, ".tokentracker", "cowork-adapter", "refresh-pending.json");
    await f.write([event(), event({ ts: event().ts + 1000 }), event({ ts: event().ts + 2000 })]);
    await withClaudeReadFailure(journal, async () => {
      await assert.rejects(runAdapter({ home: f.home }), { code: "EIO" });
    });
    await fs.access(pending);
    assert.equal(await fs.readFile(queuePath, "utf8"), before);

    // Nothing new to import: the pending marker alone must trigger recovery.
    const recovered = await runAdapter({ home: f.home });
    assert.equal(recovered.imported, 0);
    assert.equal(recovered.refreshed, true);
    await assert.rejects(fs.access(pending), { code: "ENOENT" });
    const after = await fs.readFile(queuePath, "utf8");
    const rows = after.trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter((row) => row.source === "claude").at(-1).total_tokens, 4050);
    assert.equal((await runAdapter({ home: f.home })).refreshed, false);
    assert.equal(await fs.readFile(queuePath, "utf8"), after);
    const truth = await computeClaudeGroundTruthBuckets({ rootDirs: [path.join(f.outputRoot, "projects")] });
    assert.equal(truth.rows.reduce((sum, row) => sum + row.total_tokens, 0), 4050);
  });
});

test("ordinary sync callers retain best-effort handling of Claude read failures", async () => {
  await fixture(async (f) => {
    await f.write([event()]);
    await runAdapter({ home: f.home, refresh: false });
    const [journal] = await listClaudeProjectFiles(path.join(f.outputRoot, "projects"));
    const { cmdSync } = require("../src/commands/sync");
    await withClaudeReadFailure(journal, async () => {
      await assert.doesNotReject(cmdSync(["--auto", "--source", "claude"], {
        home: f.home,
        trackerDataDir: path.join(f.home, ".tokentracker", "tracker"),
        scanSources: ["claude"],
      }));
    });
  });
});
