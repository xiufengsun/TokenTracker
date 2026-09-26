"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseTraeIncremental } = require("../src/lib/rollout");
const { normalizeTraeModel, normalizeTraeUsage } = require("../src/lib/trae-usage");

const T1 = 1_700_000_000;
const T2 = 1_700_002_000;
const B1 = "2023-11-14T22:00:00.000Z";
const B2 = "2023-11-14T22:30:00.000Z";
const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function tokens(value) {
  return Object.fromEntries(TOKEN_FIELDS.map((key) => [key, value[key]]));
}

function usage(input = 100, output = 10) {
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function turn(overrides = {}) {
  return {
    id: 1,
    session_id: "session-one",
    turn_id: "turn-one",
    created_at: T1,
    model: "gpt-5.2__dollar__dev",
    usage: usage(),
    ...overrides,
  };
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trae-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "history.db");
  fs.writeFileSync(dbPath, "synthetic-database");
  return { dir, dbPath, queuePath: path.join(dir, "queue.jsonl"), cursors: {} };
}

function changed(dbPath) {
  // Change size as well as mtime: tests do not depend on filesystem clock precision.
  fs.appendFileSync(dbPath, "-changed");
}

function queueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

function latest(queuePath, model = "gpt-5.2", bucket = B1) {
  return queueRows(queuePath)
    .filter((row) => !row.kind && row.source === "trae" && row.model === model && row.hour_start === bucket)
    .at(-1);
}

function parse(f, rows, options = {}) {
  return parseTraeIncremental({
    dbPaths: [f.dbPath],
    queuePath: f.queuePath,
    cursors: f.cursors,
    env: {},
    readUsageRows: async () => rows,
    ...options,
  });
}

test("TRAE usage separates cached input and reasoning in the observed inclusive shape", () => {
  const raw = {
    prompt_tokens: 143_924,
    cache_read_input_tokens: 143_488,
    completion_tokens: 1_163,
    reasoning_tokens: 250,
    total_tokens: 145_087,
  };
  const expected = {
    input_tokens: 436,
    cached_input_tokens: 143_488,
    cache_creation_input_tokens: 0,
    output_tokens: 913,
    reasoning_output_tokens: 250,
    total_tokens: 145_087,
  };
  assert.deepEqual(tokens(normalizeTraeUsage(raw)), expected);
  assert.deepEqual(tokens(normalizeTraeUsage(JSON.stringify(raw))), expected);
  assert.deepEqual(tokens(normalizeTraeUsage({
    ...raw, prompt_tokens_total: 0, completion_tokens_total: 0,
  })), expected, "zero aggregate placeholders do not replace observed counters");
});

test("TRAE usage uses the reported total to distinguish inclusive and disjoint caches", () => {
  const raw = {
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
  };
  assert.deepEqual(tokens(normalizeTraeUsage({ ...raw, total_tokens: 150 })), {
    input_tokens: 70,
    cached_input_tokens: 20,
    cache_creation_input_tokens: 10,
    output_tokens: 50,
    reasoning_output_tokens: 0,
    total_tokens: 150,
  });
  assert.deepEqual(tokens(normalizeTraeUsage({ ...raw, total_tokens: 180 })), {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_creation_input_tokens: 10,
    output_tokens: 50,
    reasoning_output_tokens: 0,
    total_tokens: 180,
  });
});

test("TRAE usage rejects malformed, ambiguous, and inconsistent token identities", () => {
  const invalid = [
    undefined,
    null,
    [],
    120,
    "120",
    "not json",
    { total_tokens: 120 },
    { prompt_tokens: -1, completion_tokens: 10, total_tokens: 9 },
    { prompt_tokens: 1.5, completion_tokens: 10, total_tokens: 11.5 },
    { prompt_tokens: 100, completion_tokens: 10, total_tokens: 999 },
    { prompt_tokens: 100, input_tokens: 200, completion_tokens: 10, total_tokens: 110 },
    { prompt_tokens: 100, completion_tokens: 10, output_tokens: 20, total_tokens: 110 },
    { prompt_tokens: 100, completion_tokens: 10, cache_read_input_tokens: 200, total_tokens: 110 },
    { prompt_tokens: 100, completion_tokens: 10, reasoning_tokens: 20, total_tokens: 110 },
    { prompt_tokens: 100, completion_tokens: 10, cache_read_input_tokens: 20 },
    // Either cache or reasoning could be inclusive: the total cannot identify the split.
    { prompt_tokens: 100, completion_tokens: 30, cache_read_input_tokens: 20, reasoning_tokens: 20, total_tokens: 150 },
    // Aggregate totals cannot borrow an individual step's cache count.
    { prompt_tokens: 100, prompt_tokens_total: 1_000, completion_tokens: 10, completion_tokens_total: 100, cache_read_input_tokens: 20, total_tokens: 1_100 },
    { aggregate_prompt_tokens: 100, aggregate_completion_tokens: 10, total_tokens: 110 },
  ];
  for (const raw of invalid) {
    assert.equal(normalizeTraeUsage(raw), null, `rejects ${JSON.stringify(raw)}`);
  }
  assert.deepEqual(tokens(normalizeTraeUsage(usage(0, 0))), {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  });
});

test("TRAE model normalization strips internal suffixes and identifies unknown models", () => {
  assert.equal(normalizeTraeModel("gpt-5.2__dollar__dev"), "gpt-5.2");
  assert.equal(normalizeTraeModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  for (const raw of [null, undefined, "", "   "]) {
    assert.equal(normalizeTraeModel(raw), "trae-unknown");
  }
});

test("TRAE parser accepts object/JSON usage and seconds, milliseconds, or ISO timestamps", async (t) => {
  const f = fixture(t);
  let progress = 0;
  await parse(f, [
    turn(),
    turn({ id: 2, session_id: "session-two", turn_id: "turn-two", created_at: T1 * 1000, usage: JSON.stringify(usage(200, 20)) }),
    turn({ id: 3, session_id: "session-three", turn_id: "turn-three", created_at: new Date(T2 * 1000).toISOString(), model: null }),
  ], { onProgress: () => { progress += 1; } });
  assert.equal(latest(f.queuePath).total_tokens, 330);
  assert.equal(latest(f.queuePath).conversation_count, 2);
  assert.equal(latest(f.queuePath, "trae-unknown", B2).total_tokens, 110);
  assert.equal(latest(f.queuePath, "trae-unknown", B2).conversation_count, 1);
  assert.ok(progress > 0, "reports parsing progress");
  assert.ok(queueRows(f.queuePath).every((row) => row.source === "trae"), "local TRAE usage stays separate from trae-cn");
});

test("TRAE parser is idempotent after a persisted cursor reload and unchanged rescan", async (t) => {
  const f = fixture(t);
  const rows = [turn()];
  await parse(f, rows);
  const before = fs.readFileSync(f.queuePath, "utf8");
  f.cursors = JSON.parse(JSON.stringify(f.cursors));
  const second = await parse(f, rows);
  assert.equal(second.eventsAggregated, 0);
  assert.equal(second.bucketsQueued, 0);
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), before);

  changed(f.dbPath);
  const third = await parse(f, rows);
  assert.equal(third.eventsAggregated, 0, "a file change alone is not new usage");
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), before);
});

test("TRAE parser reconciles turn growth and downward corrections without removing siblings", async (t) => {
  const f = fixture(t);
  const sibling = turn({ id: 2, turn_id: "turn-two", usage: usage(200, 20) });
  await parse(f, [turn(), sibling]);
  assert.equal(latest(f.queuePath).total_tokens, 330);
  assert.equal(latest(f.queuePath).conversation_count, 1, "multiple turns are one session");

  changed(f.dbPath);
  await parse(f, [turn({ usage: usage(150, 15) }), sibling]);
  assert.equal(latest(f.queuePath).total_tokens, 385);
  assert.equal(latest(f.queuePath).conversation_count, 1);

  changed(f.dbPath);
  await parse(f, [turn({ usage: usage(60, 6) }), sibling]);
  assert.equal(latest(f.queuePath).total_tokens, 286);
  assert.equal(latest(f.queuePath).input_tokens, 260);
  assert.equal(latest(f.queuePath).output_tokens, 26);
  assert.equal(latest(f.queuePath).conversation_count, 1);
});

test("TRAE parser upgrades old fingerprints to import newly supported usage without duplicate tokens", async (t) => {
  const f = fixture(t);
  await parse(f, [turn()]);
  f.cursors.trae.version = 1;
  const aggregate = turn({
    id: 2, turn_id: "previously-skipped-turn",
    usage: {
      prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
      prompt_tokens_total: 200, completion_tokens_total: 20,
      cache_read_input_tokens: 40,
    },
  });
  let reads = 0;
  const options = {
    readUsageRows: async () => { reads += 1; return [turn(), aggregate]; },
  };
  const upgraded = await parse(f, [], options);
  assert.equal(reads, 1, "an unchanged old-version store is reread");
  assert.equal(upgraded.eventsAggregated, 1, "the retained turn ledger avoids a duplicate import");
  assert.equal(f.cursors.trae.version, 2);
  assert.equal(latest(f.queuePath).total_tokens, 330);
  assert.equal(latest(f.queuePath).usage_precision, "mixed");
  const queueBefore = fs.readFileSync(f.queuePath, "utf8");
  await parse(f, [], options);
  assert.equal(reads, 1, "the upgraded fingerprint resumes normal incremental skips");
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), queueBefore);
});

test("TRAE parser detects usage updates written only to the SQLite WAL", async (t) => {
  const f = fixture(t);
  const walPath = `${f.dbPath}-wal`;
  fs.writeFileSync(walPath, "initial-wal");
  await parse(f, [turn()]);
  const databaseBefore = fs.statSync(f.dbPath);
  changed(walPath);
  await parse(f, [turn({ usage: usage(200, 20) })]);
  assert.equal(fs.statSync(f.dbPath).mtimeMs, databaseBefore.mtimeMs);
  assert.equal(latest(f.queuePath).total_tokens, 220);
});

test("TRAE parser retracts old model and time buckets when a turn is corrected", async (t) => {
  const f = fixture(t);
  await parse(f, [turn()]);
  changed(f.dbPath);
  await parse(f, [turn({ model: "claude-sonnet-4-6", created_at: T2, usage: usage(40, 4) })]);
  assert.equal(latest(f.queuePath).total_tokens, 0);
  assert.equal(latest(f.queuePath).conversation_count, 0);
  assert.equal(latest(f.queuePath, "claude-sonnet-4-6", B2).total_tokens, 44);
  assert.equal(latest(f.queuePath, "claude-sonnet-4-6", B2).conversation_count, 1);
});

test("TRAE parser accepts explicit zero corrections and retains billed usage after history deletion", async (t) => {
  const f = fixture(t);
  const sibling = turn({ id: 2, session_id: "session-two", turn_id: "turn-two", usage: usage(200, 20) });
  await parse(f, [turn(), sibling]);
  changed(f.dbPath);
  await parse(f, [turn({ usage: usage(0, 0) }), sibling]);
  assert.equal(latest(f.queuePath).total_tokens, 220, "zero replaces the previous contribution");

  const before = fs.readFileSync(f.queuePath, "utf8");
  changed(f.dbPath);
  await parse(f, []);
  assert.equal(latest(f.queuePath).total_tokens, 220, "deleting local history does not refund billed tokens");
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), before);
  changed(f.dbPath);
  await parse(f, [sibling]);
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), before, "restoring a deleted row does not double count");
});

test("TRAE parser isolates database-local ids while deduplicating stable session/turn copies", async (t) => {
  const f = fixture(t);
  const secondDb = path.join(f.dir, "history-copy.db");
  fs.writeFileSync(secondDb, "second-synthetic-database");
  const local = turn({ id: 42, session_id: null, turn_id: null });
  await parse(f, [], {
    dbPaths: [f.dbPath, secondDb],
    readUsageRows: async (dbPath) => [
      local,
      turn({ id: dbPath === f.dbPath ? 50 : 75, session_id: "copied-session", turn_id: "copied-turn", usage: usage(300, 30) }),
    ],
  });
  assert.equal(latest(f.queuePath).total_tokens, 550, "two unrelated local ids plus one stable copied turn");
  const before = fs.readFileSync(f.queuePath, "utf8");
  changed(f.dbPath);
  changed(secondDb);
  await parse(f, [], {
    dbPaths: [secondDb, f.dbPath],
    readUsageRows: async (dbPath) => [
      local,
      turn({ id: dbPath === f.dbPath ? 50 : 75, session_id: "copied-session", turn_id: "copied-turn", usage: usage(300, 30) }),
    ],
  });
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), before, "database ordering does not alter deduplication");
});

test("TRAE parser skips unsupported usage and invalid timestamps without inventing tokens", async (t) => {
  const f = fixture(t);
  await parse(f, [
    turn(),
    turn({ id: 2, turn_id: "invalid-json", usage: "broken-json" }),
    turn({ id: 3, turn_id: "scalar-usage", usage: 999 }),
    turn({ id: 4, turn_id: "total-only", usage: { total_tokens: 999 } }),
    turn({ id: 5, turn_id: "invalid-time", created_at: "not-a-date" }),
    turn({ id: 6, turn_id: "negative-time", created_at: -5 }),
  ]);
  assert.equal(latest(f.queuePath).total_tokens, 110);
  assert.equal(latest(f.queuePath).conversation_count, 1);
});

test("TRAE parser leaves cursors unchanged when a queue append fails and retries the correction", async (t) => {
  const f = fixture(t);
  await parse(f, [turn()]);
  const before = structuredClone(f.cursors);
  const queueBefore = fs.readFileSync(f.queuePath, "utf8");
  const blockedQueue = path.join(f.dir, "queue-is-a-directory");
  fs.mkdirSync(blockedQueue);
  changed(f.dbPath);
  await assert.rejects(parse(f, [turn({ usage: usage(200, 20) })], { queuePath: blockedQueue }));
  assert.deepEqual(f.cursors, before, "failed writes do not mutate existing nested cursor state");
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), queueBefore);
  await parse(f, [turn({ usage: usage(200, 20) })]);
  assert.equal(latest(f.queuePath).total_tokens, 220, "failed write did not consume the database change");
});

test("TRAE parser leaves cursor fingerprints unchanged after a failed database read", async (t) => {
  const f = fixture(t);
  await parse(f, [turn()]);
  changed(f.dbPath);
  const before = structuredClone(f.cursors);
  const queueBefore = fs.readFileSync(f.queuePath, "utf8");
  const result = await parse(f, [], {
    readUsageRows: async () => { throw new Error("synthetic database read failure"); },
  });
  assert.deepEqual(result.errors, [{ database: f.dbPath, message: "synthetic database read failure" }]);
  assert.deepEqual(f.cursors, before);
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), queueBefore);
  await parse(f, [turn({ usage: usage(200, 20) })]);
  assert.equal(latest(f.queuePath).total_tokens, 220, "a successful retry sees the unconsumed change");
});

for (const failedStoreFirst of [false, true]) {
  test(`TRAE parser commits a readable store when the ${failedStoreFirst ? "first" : "last"} store fails and retries without duplicates`, async (t) => {
    const f = fixture(t);
    await parse(f, [turn()]);
    changed(f.dbPath);
    const secondDb = path.join(f.dir, "unreadable-history.db");
    fs.writeFileSync(secondDb, "synthetic-database");
    let failuresRemaining = 2;
    let successfulReads = 0;
    let failingReads = 0;
    const options = {
      dbPaths: failedStoreFirst ? [secondDb, f.dbPath] : [f.dbPath, secondDb],
      readUsageRows: async (dbPath) => {
        if (dbPath === secondDb) {
          failingReads += 1;
          if (failuresRemaining-- > 0) throw new Error("second database failed");
          return [turn({ session_id: "second-session", turn_id: "second-turn", usage: usage(300, 30) })];
        }
        successfulReads += 1;
        return [turn({ usage: usage(200, 20) })];
      },
    };
    const first = await parse(f, [], options);
    assert.deepEqual(first.errors, [{ database: secondDb, message: "second database failed" }]);
    assert.equal(first.eventsAggregated, 1);
    assert.equal(latest(f.queuePath).total_tokens, 220);
    assert.equal(Object.keys(f.cursors.trae.databases).length, 1, "failed reads do not create a fingerprint");
    const queueBefore = fs.readFileSync(f.queuePath, "utf8");

    const second = await parse(f, [], options);
    assert.equal(second.errors.length, 1);
    assert.equal(second.eventsAggregated, 0);
    assert.equal(successfulReads, 1, "an unchanged successful store is not reread");
    assert.equal(failingReads, 2, "an unchanged failed store is retried");
    assert.equal(fs.readFileSync(f.queuePath, "utf8"), queueBefore);

    const recovered = await parse(f, [], options);
    assert.deepEqual(recovered.errors, []);
    assert.equal(recovered.eventsAggregated, 1);
    assert.equal(latest(f.queuePath).total_tokens, 550);
    assert.equal(latest(f.queuePath).conversation_count, 2);
    const afterRecovery = fs.readFileSync(f.queuePath, "utf8");
    await parse(f, [], options);
    assert.equal(fs.readFileSync(f.queuePath, "utf8"), afterRecovery);
  });
}

test("TRAE parser reports inaccessible stores without silently skipping them", async (t) => {
  const f = fixture(t);
  const inaccessibleDb = path.join(f.dir, "permission-denied.db");
  const originalStat = fs.statSync;
  const statMock = t.mock.method(fs, "statSync", function (file, ...args) {
    if (file === inaccessibleDb) {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
    return originalStat.call(this, file, ...args);
  });
  try {
    const result = await parse(f, [turn()], { dbPaths: [inaccessibleDb, f.dbPath] });
    assert.deepEqual(result.errors, [{ database: inaccessibleDb, message: "EACCES: permission denied" }]);
    assert.equal(latest(f.queuePath).total_tokens, 110);
    assert.ok(!JSON.stringify(f.cursors).includes(inaccessibleDb), "error paths stay out of persisted cursors");
  } finally {
    statMock.mock.restore();
  }
});

test("TRAE parser persists no raw identifiers, conversation content, or decryption key", async (t) => {
  const f = fixture(t);
  const canaries = [
    "private-row-identifier-canary",
    "private-session-identifier-canary",
    "private-turn-identifier-canary",
    "private-conversation-context-canary",
    "private-decryption-key-canary",
  ];
  await parse(f, [turn({
    id: canaries[0],
    session_id: canaries[1],
    turn_id: canaries[2],
    context: { messages: [{ text: canaries[3] }] },
    usage: { ...usage(), prompt: canaries[3] },
  })], { env: { TOKENTRACKER_TRAE_SQLCIPHER_KEY: canaries[4] } });
  assert.equal(latest(f.queuePath).total_tokens, 110);
  const persisted = fs.readFileSync(f.queuePath, "utf8") + JSON.stringify(f.cursors);
  for (const canary of canaries) assert.ok(!persisted.includes(canary), `does not persist ${canary}`);
});

test("TRAE parser preserves estimated breakdowns and clears precision after an exact correction", async (t) => {
  const f = fixture(t);
  const aggregate = turn({ usage: {
    prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
    prompt_tokens_total: 200, completion_tokens_total: 20,
    cache_read_input_tokens: 40,
  } });
  const first = await parse(f, [aggregate]);
  assert.equal(first.estimatedRecords, 1);
  assert.equal(latest(f.queuePath).total_tokens, 220);
  assert.equal(latest(f.queuePath).usage_precision, "estimated");
  const queueBefore = fs.readFileSync(f.queuePath, "utf8");
  f.cursors = JSON.parse(JSON.stringify(f.cursors));
  await parse(f, [aggregate]);
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), queueBefore);

  changed(f.dbPath);
  const corrected = await parse(f, [turn({ usage: {
    prompt_tokens: 200, completion_tokens: 20, total_tokens: 220,
    cache_read_input_tokens: 40,
  } })]);
  assert.equal(corrected.estimatedRecords, 0);
  assert.equal(corrected.eventsAggregated, 1, "a precision-only correction is published");
  assert.equal(latest(f.queuePath).total_tokens, 220);
  assert.equal(latest(f.queuePath).usage_precision, undefined);
  assert.equal(queueRows(f.queuePath).length, 2);
});

test("TRAE mixed bucket precision retains estimates from an unchanged store and clears retracted buckets", async (t) => {
  const f = fixture(t);
  const secondDb = path.join(f.dir, "reported.db");
  fs.writeFileSync(secondDb, "reported-store");
  let aggregate = turn({ usage: {
    prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
    prompt_tokens_total: 200, completion_tokens_total: 20,
    cache_read_input_tokens: 40,
  } });
  let reported = turn({ session_id: "reported-session", turn_id: "reported-turn", usage: usage(50, 5) });
  const options = {
    dbPaths: [f.dbPath, secondDb],
    readUsageRows: async (dbPath) => [dbPath === secondDb ? reported : aggregate],
  };
  await parse(f, [], options);
  assert.equal(latest(f.queuePath).usage_precision, "mixed");
  changed(secondDb);
  reported = { ...reported, usage: usage(60, 6) };
  await parse(f, [], options);
  assert.equal(latest(f.queuePath).usage_precision, "mixed", "unchanged estimated contribution remains visible");

  changed(f.dbPath);
  aggregate = { ...aggregate, created_at: T2 };
  await parse(f, [], options);
  assert.equal(latest(f.queuePath).total_tokens, 66);
  assert.equal(latest(f.queuePath).usage_precision, undefined);
  assert.equal(latest(f.queuePath, "gpt-5.2", B2).usage_precision, "estimated");

  changed(f.dbPath);
  aggregate = { ...aggregate, usage: usage(0, 0) };
  await parse(f, [], options);
  assert.equal(latest(f.queuePath, "gpt-5.2", B2).total_tokens, 0);
  assert.equal(latest(f.queuePath, "gpt-5.2", B2).usage_precision, undefined);
});

test("TRAE copied turns cannot replace newer usage with a stale snapshot", async (t) => {
  const f = fixture(t);
  const copy = path.join(f.dir, "copy.db");
  fs.writeFileSync(copy, "copy");
  let newer = turn({ usage: usage(200), updated_at: T2 });
  let older = turn({ usage: usage(50), updated_at: T1 });
  const options = {
    ...f, dbPaths: [f.dbPath, copy], env: {},
    readUsageRows: async (p) => [p === copy ? older : newer],
  };
  await parseTraeIncremental(options);
  assert.equal(latest(f.queuePath).input_tokens, 200);
  changed(copy);
  await parseTraeIncremental(options);
  assert.equal(latest(f.queuePath).input_tokens, 200);
  older = { ...older, usage: usage(25), updated_at: T2 + 1 };
  changed(copy);
  await parseTraeIncremental(options);
  assert.equal(latest(f.queuePath).input_tokens, 25, "a genuinely newer correction is accepted");
  changed(f.dbPath);
  await parseTraeIncremental(options);
  assert.equal(latest(f.queuePath).input_tokens, 25, "former owner is now the stale copy");
});
