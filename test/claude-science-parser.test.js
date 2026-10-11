"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runSql } = require("./helpers/sqlite-write");
const {
  resolveClaudeScienceDbPath,
  resolveClaudeScienceDbPaths,
  readClaudeScienceFrames,
  parseClaudeScienceIncremental,
} = require("../src/lib/rollout");

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function queueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// queue.jsonl is append-only and buckets carry cumulative absolutes; readers
// take the LATEST entry per (source, model, hour_start).
function latestPerBucket(rows) {
  const latest = new Map();
  for (const r of rows) latest.set(`${r.source}|${r.model}|${r.hour_start}`, r);
  return [...latest.values()];
}

// A minimal `frames`-shaped schema — only the columns the parser reads.
const FRAMES_SCHEMA = `
CREATE TABLE frames (
  id text PRIMARY KEY NOT NULL,
  parent_frame_id text,
  agent_name text NOT NULL DEFAULT 'agent',
  status text NOT NULL DEFAULT 'completed',
  model text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  aux_input_tokens integer,
  aux_output_tokens integer,
  aux_cache_read_tokens integer,
  aux_cache_write_tokens integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  completed_at integer,
  conversation_type text NOT NULL DEFAULT 'agent'
);
`;

function seedFrame(dbPath, frame) {
  const cols = [
    "id",
    "parent_frame_id",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "aux_input_tokens",
    "aux_output_tokens",
    "aux_cache_read_tokens",
    "aux_cache_write_tokens",
    "created_at",
    "updated_at",
    "completed_at",
  ];
  const values = cols
    .map((c) => {
      const v = frame[c];
      if (v === undefined || v === null) return "NULL";
      return typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
    })
    .join(", ");
  runSql(dbPath, `INSERT INTO frames (${cols.join(", ")}) VALUES (${values});`);
}

test("resolveClaudeScienceDbPath honors overrides and defaults to ~/.claude-science", () => {
  assert.equal(
    resolveClaudeScienceDbPath({ home: "/home/u", env: {} }),
    path.join("/home/u", ".claude-science", "operon-cli.db"),
  );
  assert.equal(
    resolveClaudeScienceDbPath({ home: "/home/u", env: { CLAUDE_SCIENCE_HOME: "/data/cs" } }),
    path.resolve("/data/cs", "operon-cli.db"),
  );
  assert.equal(
    resolveClaudeScienceDbPath({ home: "/home/u", env: { CLAUDE_SCIENCE_DB_PATH: "/x/y.db" } }),
    path.resolve("/x/y.db"),
  );
});

// Real numbers, captured from the four Anthropic demo frames a fresh Claude
// Science install seeds into operon-cli.db (their `context_data` blob retains
// the demo run's counters). These are the ground truth behind the two
// conventions the parser has to honour: `input_tokens` is cache-INCLUSIVE, and
// aux_* is disjoint, billable usage.
const REAL_FRAMES = [
  { in: 5147303, out: 56725, cr: 4873728, cw: 165888, cost: 5.430224, auxIn: 259081, auxOut: 35707, auxCost: 0.917858 },
  { in: 7040691, out: 65640, cr: 6720000, cw: 210432, cost: 6.867495, auxIn: 335216, auxOut: 27389, auxCost: 0.8499226 },
  { in: 8251244, out: 82224, cr: 7754752, cw: 372224, cost: 8.880716, auxIn: 324978, auxOut: 27187, auxCost: 1.0101734 },
  { in: 3146490, out: 47778, cr: 2908160, cw: 156672, cost: 4.03602, auxIn: 155248, auxOut: 16127, auxCost: 0.5095814 },
];

test("resolveClaudeScienceDbPaths finds default, multi-org and legacy-named DBs", (t) => {
  const dir = tmpdir(t, "tokentracker-cs-paths-");
  const root = path.join(dir, ".claude-science");
  fs.mkdirSync(path.join(root, "orgs", "acme"), { recursive: true });
  fs.mkdirSync(path.join(root, "orgs", "globex"), { recursive: true });
  fs.writeFileSync(path.join(root, "operon-cli.db"), "");
  fs.writeFileSync(path.join(root, "orgs", "acme", "operon-cli.db"), "");
  // Pre-rename filename.
  fs.writeFileSync(path.join(root, "orgs", "globex", "operon.db"), "");
  // A directory without any DB must not produce a phantom path.
  fs.mkdirSync(path.join(root, "orgs", "empty"), { recursive: true });

  const found = resolveClaudeScienceDbPaths({ home: dir, env: {} });
  assert.deepEqual(found.sort(), [
    path.join(root, "operon-cli.db"),
    path.join(root, "orgs", "acme", "operon-cli.db"),
    path.join(root, "orgs", "globex", "operon.db"),
  ].sort());
});

test("resolveClaudeScienceDbPaths returns empty when nothing is installed", (t) => {
  const dir = tmpdir(t, "tokentracker-cs-none-");
  assert.deepEqual(resolveClaudeScienceDbPaths({ home: dir, env: {} }), []);
});

test("on Windows the WSL distro home is scanned for Claude Science", (t) => {
  // Claude Science has no native Windows build — Windows users run it inside
  // WSL, so the DB lives on the distro's ext4 home.
  const dir = tmpdir(t, "tokentracker-cs-wsl-");
  const winHome = path.join(dir, "winhome");
  const wslRoot = path.join(dir, "wsl", ".claude-science");
  fs.mkdirSync(winHome, { recursive: true });
  fs.mkdirSync(wslRoot, { recursive: true });
  fs.writeFileSync(path.join(wslRoot, "operon-cli.db"), "");

  const found = resolveClaudeScienceDbPaths({
    home: winHome,
    env: {},
    deps: { platform: "win32", discoverWslHome: () => wslRoot },
  });
  assert.deepEqual(found, [path.join(wslRoot, "operon-cli.db")]);

  // darwin never probes WSL.
  assert.deepEqual(
    resolveClaudeScienceDbPaths({
      home: winHome,
      env: {},
      deps: { platform: "darwin", discoverWslHome: () => wslRoot },
    }),
    [],
  );
});

test("parseClaudeScienceIncremental aggregates frame tokens into half-hour buckets", async (t) => {
  const dir = tmpdir(t, "tokentracker-cs-");
  const dbPath = path.join(dir, "operon-cli.db");
  const queuePath = path.join(dir, "queue.jsonl");
  runSql(dbPath, FRAMES_SCHEMA);

  // Claude Science convention: input_tokens INCLUDES cache reads and writes.
  // Non-cached input here is 5147303 - 4873728 - 165888 = 107687.
  const f = REAL_FRAMES[0];
  seedFrame(dbPath, {
    id: "frame-1",
    parent_frame_id: null,
    model: "claude-opus-4-8",
    input_tokens: f.in,
    output_tokens: f.out,
    cache_read_tokens: f.cr,
    cache_write_tokens: f.cw,
    created_at: Date.parse("2026-07-07T13:05:00.000Z"),
    updated_at: Date.parse("2026-07-07T13:05:00.000Z"),
    completed_at: Date.parse("2026-07-07T13:05:00.000Z"),
  });
  // A nested child frame (sub-agent) in a different half-hour bucket.
  seedFrame(dbPath, {
    id: "frame-2",
    parent_frame_id: "frame-1",
    model: "claude-opus-4-8",
    input_tokens: 20,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    created_at: Date.parse("2026-07-07T13:40:00.000Z"),
    updated_at: Date.parse("2026-07-07T13:40:00.000Z"),
    completed_at: Date.parse("2026-07-07T13:40:00.000Z"),
  });
  // An OPERON seed frame with no tokens — must be ignored entirely.
  seedFrame(dbPath, {
    id: "frame-empty",
    parent_frame_id: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    created_at: Date.parse("2026-07-07T13:41:00.000Z"),
    updated_at: Date.parse("2026-07-07T13:41:00.000Z"),
    completed_at: null,
  });

  const rows = await readClaudeScienceFrames(dbPath);
  assert.equal(rows.length, 2, "empty frame filtered out by SQL");

  const cursors = {};
  const res = await parseClaudeScienceIncremental({ dbRows: rows, cursors, queuePath });
  assert.equal(res.recordsProcessed, 2);
  assert.equal(res.eventsAggregated, 2);
  assert.equal(res.bucketsQueued, 2);

  const buckets = latestPerBucket(queueRows(queuePath));
  const byBucket = new Map(buckets.map((r) => [r.hour_start, r]));

  const b1 = byBucket.get("2026-07-07T13:00:00.000Z");
  assert.equal(b1.source, "claude-science");
  assert.equal(b1.model, "claude-opus-4-8");
  assert.equal(b1.input_tokens, 107687, "cache peeled back out of input_tokens");
  assert.equal(b1.cached_input_tokens, f.cr);
  assert.equal(b1.cache_creation_input_tokens, f.cw);
  assert.equal(b1.output_tokens, f.out);
  assert.equal(
    b1.total_tokens,
    107687 + f.out + f.cr + f.cw,
    "cache counted once, not twice",
  );
  assert.equal(b1.conversation_count, 1, "root frame counts as one conversation");

  const b2 = byBucket.get("2026-07-07T13:30:00.000Z");
  assert.equal(b2.total_tokens, 30);
  assert.equal(b2.conversation_count, 0, "child frame is not a conversation");
});

// Regression guard for the ~5.6x cost inflation: reproduce Claude Science's own
// pricing over the tokens we emit and require it to match the cost Claude
// Science itself recorded. If input_tokens is ever treated as pure non-cached
// input again, every one of these blows past the tolerance.
test("emitted tokens reprice to Claude Science's own recorded cost", async (t) => {
  const dir = tmpdir(t, "tokentracker-cs-cost-");
  const dbPath = path.join(dir, "operon-cli.db");
  const queuePath = path.join(dir, "queue.jsonl");
  runSql(dbPath, FRAMES_SCHEMA);

  REAL_FRAMES.forEach((frame, i) => {
    seedFrame(dbPath, {
      id: `real-${i}`,
      parent_frame_id: null,
      model: "claude-opus-4-8",
      input_tokens: frame.in,
      output_tokens: frame.out,
      cache_read_tokens: frame.cr,
      cache_write_tokens: frame.cw,
      created_at: Date.parse("2026-07-07T13:05:00.000Z"),
      updated_at: Date.parse("2026-07-07T13:05:00.000Z"),
      completed_at: Date.parse("2026-07-07T13:05:00.000Z"),
    });
  });

  const rows = await readClaudeScienceFrames(dbPath);
  assert.equal(rows.length, REAL_FRAMES.length);

  // Claude Science's own rates for Opus: $5/Mtok in, $25/Mtok out,
  // cache read x0.1, 5-minute cache write x1.25.
  const IN = 5 / 1e6;
  const OUT = 25 / 1e6;
  let priced = 0;
  for (const row of rows) {
    const uncached = row.input_tokens - row.cache_read_tokens - row.cache_write_tokens;
    priced +=
      uncached * IN +
      row.output_tokens * OUT +
      row.cache_read_tokens * IN * 0.1 +
      row.cache_write_tokens * IN * 1.25;
  }
  const recorded = REAL_FRAMES.reduce((s, f) => s + f.cost, 0);
  assert.ok(
    Math.abs(priced - recorded) < 1e-6,
    `repriced ${priced.toFixed(6)} must match Claude Science's ${recorded.toFixed(6)}`,
  );

  // And the aggregate we actually queue must not double count the cache.
  const cursors = {};
  await parseClaudeScienceIncremental({ dbRows: rows, cursors, queuePath });
  const total = latestPerBucket(queueRows(queuePath)).reduce((s, r) => s + r.total_tokens, 0);
  const expected = REAL_FRAMES.reduce((s, f) => s + f.in + f.out, 0);
  assert.equal(total, expected, "total_tokens == input(cache-inclusive) + output");
});

test("aux_* counters are counted as real usage, with their own cache peeled off", async (t) => {
  const dir = tmpdir(t, "tokentracker-cs-aux-");
  const dbPath = path.join(dir, "operon-cli.db");
  const queuePath = path.join(dir, "queue.jsonl");
  runSql(dbPath, FRAMES_SCHEMA);

  const f = REAL_FRAMES[0];
  seedFrame(dbPath, {
    id: "frame-aux",
    parent_frame_id: null,
    model: "claude-opus-4-8",
    input_tokens: f.in,
    output_tokens: f.out,
    cache_read_tokens: f.cr,
    cache_write_tokens: f.cw,
    // Real seed frames record aux input/output with no aux cache columns.
    aux_input_tokens: f.auxIn,
    aux_output_tokens: f.auxOut,
    created_at: Date.parse("2026-07-07T13:05:00.000Z"),
    updated_at: Date.parse("2026-07-07T13:05:00.000Z"),
    completed_at: Date.parse("2026-07-07T13:05:00.000Z"),
  });

  const rows = await readClaudeScienceFrames(dbPath);
  const cursors = {};
  await parseClaudeScienceIncremental({ dbRows: rows, cursors, queuePath });
  const bucket = latestPerBucket(queueRows(queuePath))[0];

  assert.equal(bucket.input_tokens, 107687 + f.auxIn, "aux input joins non-cached input");
  assert.equal(bucket.output_tokens, f.out + f.auxOut, "aux output joins output");
  assert.equal(bucket.total_tokens, f.in + f.out + f.auxIn + f.auxOut);
});

test("an older operon-cli.db without aux_* columns still parses", async (t) => {
  const dir = tmpdir(t, "tokentracker-cs-legacy-");
  const dbPath = path.join(dir, "operon-cli.db");
  const queuePath = path.join(dir, "queue.jsonl");
  // Pre-migration schema: no aux_* columns at all.
  runSql(
    dbPath,
    `CREATE TABLE frames (
      id text PRIMARY KEY NOT NULL,
      parent_frame_id text,
      model text,
      input_tokens integer,
      output_tokens integer,
      cache_read_tokens integer,
      cache_write_tokens integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      completed_at integer
    );`,
  );
  const f = REAL_FRAMES[0];
  runSql(
    dbPath,
    `INSERT INTO frames (id, parent_frame_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at, updated_at, completed_at)
     VALUES ('legacy-1', NULL, 'claude-opus-4-8', ${f.in}, ${f.out}, ${f.cr}, ${f.cw}, ${Date.parse("2026-07-07T13:05:00.000Z")}, ${Date.parse("2026-07-07T13:05:00.000Z")}, ${Date.parse("2026-07-07T13:05:00.000Z")});`,
  );

  const rows = await readClaudeScienceFrames(dbPath);
  assert.equal(rows.length, 1, "missing aux columns must not error the provider out");
  const cursors = {};
  await parseClaudeScienceIncremental({ dbRows: rows, cursors, queuePath });
  const bucket = latestPerBucket(queueRows(queuePath))[0];
  assert.equal(bucket.input_tokens, 107687);
  assert.equal(bucket.total_tokens, f.in + f.out);
});

// Count snapshot directories created while `run` executes. rollout.js resolves
// `node:fs` from the same module cache this file does, so patching mkdtempSync
// here observes its real calls. Without this the UNC assertion below proves
// nothing on POSIX: `//tmp/...` is directly readable, so deleting the snapshot
// branch entirely would still leave the test green.
async function countSnapshots(t, run) {
  const realMkdtemp = fs.mkdtempSync;
  const created = [];
  fs.mkdtempSync = function (prefix, ...rest) {
    const out = realMkdtemp.call(this, prefix, ...rest);
    if (String(prefix).includes("tokentracker-wsl-snap-")) created.push(out);
    return out;
  };
  t.after(() => {
    fs.mkdtempSync = realMkdtemp;
  });
  try {
    const result = await run();
    return { result, created };
  } finally {
    fs.mkdtempSync = realMkdtemp;
  }
}

test("readClaudeScienceFrames snapshots a WAL DB reached over a WSL UNC path", async (t) => {
  // On Windows the DB lives inside WSL and is read over \\wsl.localhost\...;
  // operon-cli.db runs in WAL mode, and SQLite over the 9p/UNC bridge can fail
  // to open the WAL or read a torn state — so the file must be copied locally
  // first. A leading extra slash makes isUncPath() see "//…" while staying
  // readable on POSIX (same stand-in the claude dual-install suite uses).
  const dir = tmpdir(t, "tokentracker-cs-unc-");
  const dbPath = path.join(dir, "operon-cli.db");
  const queuePath = path.join(dir, "queue.jsonl");
  runSql(dbPath, FRAMES_SCHEMA);
  // Force WAL mode so the -wal/-shm sidecars exist and must be snapshotted too.
  runSql(dbPath, "PRAGMA journal_mode=WAL;");
  const f = REAL_FRAMES[0];
  seedFrame(dbPath, {
    id: "unc-1",
    parent_frame_id: null,
    model: "claude-opus-4-8",
    input_tokens: f.in,
    output_tokens: f.out,
    cache_read_tokens: f.cr,
    cache_write_tokens: f.cw,
    created_at: Date.parse("2026-07-07T13:05:00.000Z"),
    updated_at: Date.parse("2026-07-07T13:05:00.000Z"),
    completed_at: Date.parse("2026-07-07T13:05:00.000Z"),
  });

  // A local path must be read in place — snapshotting every read would be pure
  // overhead on the macOS/Linux happy path.
  const direct = await countSnapshots(t, () => readClaudeScienceFrames(dbPath));
  assert.equal(direct.result.length, 1);
  assert.equal(direct.created.length, 0, "local path must not be snapshotted");

  // Both aliases hit isUncPath's prefix branch while remaining readable on
  // the host; this fixture does not establish live WSL mount behavior.
  const uncPath = process.platform === "win32" ? path.toNamespacedPath(dbPath) : `/${dbPath}`;
  const unc = await countSnapshots(t, () => readClaudeScienceFrames(uncPath));
  assert.equal(unc.result.length, 1, "UNC/WAL DB must be snapshotted and read, not skipped");
  assert.equal(unc.created.length, 1, "UNC path must be snapshotted, not read in place");
  assert.ok(
    unc.created.every((snapDir) => !fs.existsSync(snapDir)),
    "snapshot temp dir must be cleaned up after the read",
  );

  const cursors = {};
  await parseClaudeScienceIncremental({ dbRows: unc.result, cursors, queuePath });
  const bucket = latestPerBucket(queueRows(queuePath))[0];
  assert.equal(bucket.input_tokens, 107687);
});

test("parseClaudeScienceIncremental is idempotent across repeated syncs", async (t) => {
  const dir = tmpdir(t, "tokentracker-cs-idem-");
  const dbPath = path.join(dir, "operon-cli.db");
  const queuePath = path.join(dir, "queue.jsonl");
  runSql(dbPath, FRAMES_SCHEMA);
  seedFrame(dbPath, {
    id: "frame-1",
    parent_frame_id: null,
    model: "claude-opus-4",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    created_at: Date.parse("2026-07-07T13:05:00.000Z"),
    updated_at: Date.parse("2026-07-07T13:05:00.000Z"),
    completed_at: Date.parse("2026-07-07T13:05:00.000Z"),
  });

  const cursors = {};
  await parseClaudeScienceIncremental({ dbRows: await readClaudeScienceFrames(dbPath), cursors, queuePath });
  const again = await parseClaudeScienceIncremental({
    dbRows: await readClaudeScienceFrames(dbPath),
    cursors,
    queuePath,
  });
  assert.equal(again.eventsAggregated, 0, "unchanged frames re-read as no-ops");

  const buckets = latestPerBucket(queueRows(queuePath));
  const total = buckets.reduce((s, r) => s + (r.total_tokens || 0), 0);
  assert.equal(total, 150, "totals stay stable, no double counting");
});

test("parseClaudeScienceIncremental subtracts old totals when a frame grows", async (t) => {
  const dir = tmpdir(t, "tokentracker-cs-grow-");
  const dbPath = path.join(dir, "operon-cli.db");
  const queuePath = path.join(dir, "queue.jsonl");
  runSql(dbPath, FRAMES_SCHEMA);
  seedFrame(dbPath, {
    id: "frame-1",
    parent_frame_id: null,
    model: "claude-opus-4",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    created_at: Date.parse("2026-07-07T13:05:00.000Z"),
    updated_at: Date.parse("2026-07-07T13:05:00.000Z"),
    completed_at: Date.parse("2026-07-07T13:05:00.000Z"),
  });

  const cursors = {};
  await parseClaudeScienceIncremental({ dbRows: await readClaudeScienceFrames(dbPath), cursors, queuePath });

  // Frame keeps its id but its counters grow as the turn continues.
  runSql(
    dbPath,
    "UPDATE frames SET input_tokens = 300, output_tokens = 120 WHERE id = 'frame-1';",
  );
  const res = await parseClaudeScienceIncremental({
    dbRows: await readClaudeScienceFrames(dbPath),
    cursors,
    queuePath,
  });
  assert.equal(res.eventsAggregated, 1);

  const buckets = latestPerBucket(queueRows(queuePath));
  const total = buckets.reduce((s, r) => s + (r.total_tokens || 0), 0);
  assert.equal(total, 420, "old contribution replaced, not added on top");
});
