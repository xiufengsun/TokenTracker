const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const initSqlJs = require("sql.js");
const { openTraeSnapshot } = require("../src/lib/trae-snapshot");
const { readTraeUsageRows } = require("../src/lib/trae-db");

let sql;

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trae-snapshot-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "database.db");
}

async function fixture(tokens = 10) {
  sql ||= initSqlJs();
  const SQL = await sql;
  const db = new SQL.Database();
  try {
    db.run(`PRAGMA page_size=4096;
      CREATE TABLE chat_turn (id INTEGER PRIMARY KEY, created_at INTEGER, context TEXT);`);
    db.run("INSERT INTO chat_turn VALUES (1, 1770000000000, ?)", [JSON.stringify({
      model_name: "test-model",
      token_usage: { prompt_tokens: tokens, completion_tokens: 2, total_tokens: tokens + 2 },
    })]);
    return Buffer.from(db.export());
  } finally {
    db.close();
  }
}

test("TRAE snapshots read across pages and zero only the unread tail", async (t) => {
  const file = temp(t);
  const bytes = await fixture();
  fs.writeFileSync(file, bytes);
  const snapshot = openTraeSnapshot(file, {});
  try {
    const crossing = Buffer.alloc(32, 0xff);
    assert.equal(snapshot.read(crossing, 4080), 32);
    assert.deepEqual(crossing, bytes.subarray(4080, 4112));
    const tail = Buffer.alloc(32, 0xff);
    assert.equal(snapshot.read(tail, bytes.length - 8), 8);
    assert.deepEqual(tail.subarray(0, 8), bytes.subarray(-8));
    assert.deepEqual(tail.subarray(8), Buffer.alloc(24));
    assert.equal(snapshot.read(tail, bytes.length + 100), 0);
    assert.deepEqual(tail, Buffer.alloc(32));
    assert.equal(snapshot.isStable(), true);
  } finally {
    snapshot.close();
  }
});

test("TRAE snapshots detect changes to the database, WAL, and rollback journal", async (t) => {
  const bytes = await fixture();
  for (const suffix of ["", "-wal", "-journal"]) {
    const file = temp(t);
    fs.writeFileSync(file, bytes);
    const snapshot = openTraeSnapshot(file, {});
    try {
      assert.equal(snapshot.isStable(), true);
      if (suffix) fs.writeFileSync(`${file}${suffix}`, Buffer.alloc(32));
      else fs.utimesSync(file, new Date(1000), new Date(2000));
      assert.equal(snapshot.isStable(), false, `Did not detect ${suffix || "database"} change`);
    } finally {
      snapshot.close();
    }
  }
});

test("TRAE snapshot page cache evicts old pages instead of retaining the file", async (t) => {
  const file = temp(t);
  const first = await fixture();
  const bytes = Buffer.alloc(70 * 4096);
  first.copy(bytes);
  bytes.writeUInt32BE(70, 28);
  fs.writeFileSync(file, bytes);
  const readSync = fs.readSync;
  let fullPageReads = 0;
  t.mock.method(fs, "readSync", (...args) => {
    if (args[3] === 4096) fullPageReads++;
    return readSync(...args);
  });
  const snapshot = openTraeSnapshot(file, {});
  try {
    const page = Buffer.alloc(4096);
    snapshot.read(page, 0);
    snapshot.read(page, 0);
    assert.equal(fullPageReads, 1);
    for (let number = 1; number < 70; number++) snapshot.read(page, number * 4096);
    assert.equal(fullPageReads, 70);
    snapshot.read(page, 0);
    assert.equal(fullPageReads, 71, "Old pages must be evicted from the bounded cache");
  } finally {
    snapshot.close();
  }
});

test("TRAE reader discards a changed snapshot and retries with the complete new state", async (t) => {
  const file = temp(t);
  const [before, after] = await Promise.all([fixture(10), fixture(100)]);
  fs.writeFileSync(file, before);
  const readSync = fs.readSync;
  const openSync = fs.openSync;
  let changed = false;
  let opened = 0;
  t.mock.method(fs, "openSync", (...args) => {
    if (args[0] === file && args[1] === "r") opened++;
    return openSync(...args);
  });
  t.mock.method(fs, "readSync", (...args) => {
    const count = readSync(...args);
    if (!changed && args[3] === 4096 && args[4] === 0) {
      changed = true;
      fs.writeFileSync(file, after);
      fs.utimesSync(file, new Date(3000), new Date(4000));
    }
    return count;
  });
  const rows = await readTraeUsageRows(file, { env: {} });
  assert.equal(opened, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage.prompt_tokens, 100);
});

test("TRAE reader fails after three unstable snapshots instead of publishing mixed rows", async (t) => {
  const file = temp(t);
  fs.writeFileSync(file, await fixture());
  const readSync = fs.readSync;
  let mutations = 0;
  t.mock.method(fs, "readSync", (...args) => {
    const count = readSync(...args);
    if (args[3] === 4096 && args[4] === 0) {
      mutations++;
      fs.utimesSync(file, new Date(1000), new Date(1000 + mutations * 1000));
    }
    return count;
  });
  await assert.rejects(readTraeUsageRows(file, { env: {} }), /database changed during the read/);
  assert.equal(mutations, 3);
});

test("TRAE snapshots close every opened handle when WAL validation fails", async (t) => {
  const file = temp(t);
  fs.writeFileSync(file, await fixture());
  fs.writeFileSync(`${file}-wal`, Buffer.alloc(32, 0xff));
  const openSync = fs.openSync;
  const closeSync = fs.closeSync;
  const live = new Set();
  t.mock.method(fs, "openSync", (...args) => {
    const fd = openSync(...args);
    live.add(fd);
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd) => {
    live.delete(fd);
    return closeSync(fd);
  });
  assert.throws(() => openTraeSnapshot(file, {}), /unsupported WAL format/);
  assert.equal(live.size, 0);
});
