const assert = require("node:assert/strict");
const { test } = require("node:test");
const initSqlJs = require("sql.js");
const { withTraeSqlite } = require("../src/lib/trae-sqlite");

let sql;

async function fixture(value, { rootPage = 2 } = {}) {
  sql ||= initSqlJs();
  const SQL = await sql;
  const db = new SQL.Database();
  try {
    db.run("PRAGMA page_size=4096; CREATE TABLE sample(value TEXT);");
    db.run("INSERT INTO sample VALUES (?)", [value]);
    if (rootPage !== 2) {
      db.run(`PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=${rootPage}
        WHERE name='sample';`);
    }
    const bytes = Buffer.from(db.export());
    bytes.writeUInt32BE(rootPage, 28);
    return bytes;
  } finally {
    db.close();
  }
}

function snapshot(bytes) {
  return {
    byteLength: bytes.length,
    read(target, offset) {
      target.fill(0);
      return bytes.copy(target, 0, offset, offset + target.length);
    },
  };
}

test("TRAE SQLite queries project rows and support JSON functions", async () => {
  const bytes = await fixture('{"tokens":123}');
  const result = await withTraeSqlite(snapshot(bytes), (query) =>
    query("SELECT json_extract(value, '$.tokens') AS tokens FROM sample"));
  assert.deepEqual(result, [{ tokens: 123 }]);
});

test("TRAE SQLite reads pages beyond 2 GiB without loading the database", async () => {
  const rootPage = 700000;
  const bytes = await fixture("large-offset", { rootPage });
  let largestOffset = 0;
  let bytesRead = 0;
  const sparse = {
    byteLength: rootPage * 4096,
    read(target, offset) {
      largestOffset = Math.max(largestOffset, offset);
      bytesRead += target.length;
      const physicalOffset = offset >= (rootPage - 1) * 4096
        ? offset - (rootPage - 2) * 4096 : offset;
      return bytes.copy(target, 0, physicalOffset, physicalOffset + target.length);
    },
  };
  const result = await withTraeSqlite(sparse, (query) => query("SELECT value FROM sample"));
  assert.deepEqual(result, [{ value: "large-offset" }]);
  assert.ok(largestOffset > 2 ** 31);
  assert.ok(bytesRead < 64 * 1024, `Read ${bytesRead} bytes for a sparse database`);
});

test("TRAE SQLite refuses writes even when query_only is disabled", async () => {
  const bytes = await fixture("unchanged");
  const before = Buffer.from(bytes);
  await assert.rejects(withTraeSqlite(snapshot(bytes), async (query) => {
    await query("PRAGMA query_only=OFF");
    await query("UPDATE sample SET value='changed'");
  }), /readonly|read.only/i);
  assert.deepEqual(bytes, before);
  assert.deepEqual(await withTraeSqlite(snapshot(bytes), (query) =>
    query("SELECT value FROM sample")), [{ value: "unchanged" }]);
});

test("TRAE SQLite preserves snapshot errors and closes failed reads", async () => {
  const original = new Error("Synthetic authenticated page failure");
  await assert.rejects(withTraeSqlite({
    byteLength: 8192,
    read() { throw original; },
  }, () => assert.fail("A failed database must not reach the query callback")),
  (err) => err === original);
  const bytes = await fixture("recovered");
  assert.deepEqual(await withTraeSqlite(snapshot(bytes), (query) =>
    query("SELECT value FROM sample")), [{ value: "recovered" }]);
});

test("TRAE SQLite preserves errors from pages read during a query", async () => {
  const bytes = await fixture("unreadable");
  const original = new Error("Synthetic later page failure");
  const unreadable = snapshot(bytes);
  unreadable.read = (target, offset) => {
    if (offset >= 4096) throw original;
    return bytes.copy(target, 0, offset, offset + target.length);
  };
  await assert.rejects(withTraeSqlite(unreadable, (query) =>
    query("SELECT value FROM sample")), (err) => err === original);
});

test("TRAE SQLite keeps concurrent snapshots isolated", async () => {
  const [left, right] = await Promise.all([fixture("left"), fixture("right")]);
  const results = await Promise.all([left, right].map((bytes) =>
    withTraeSqlite(snapshot(bytes), async (query) => {
      await new Promise((resolve) => setImmediate(resolve));
      return query("SELECT value FROM sample");
    })));
  assert.deepEqual(results, [[{ value: "left" }], [{ value: "right" }]]);
});

test("TRAE SQLite closes databases when the query callback fails", async () => {
  const bytes = await fixture("reusable");
  const original = new Error("Synthetic consumer failure");
  await assert.rejects(withTraeSqlite(snapshot(bytes), async (query) => {
    await query("SELECT value FROM sample");
    throw original;
  }), (err) => err === original);
  assert.deepEqual(await withTraeSqlite(snapshot(bytes), (query) =>
    query("SELECT value FROM sample")), [{ value: "reusable" }]);
});
