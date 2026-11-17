const test = require("node:test");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");
const { installCloudBillingSchema } = require("./helpers/cloud-billing-schema-fixture");
const { nativeConnectionEnvironment, literal, seedOrder, cancelSql, finalizeSql, paymentSql, assertPaid } = require("./native/cloud-order-cancellation-postgres.test.cjs");
let pg, db;
test.before(async () => {
  pg = new PGlite();
  db = { exec: sql => pg.exec(sql), value: async sql => Object.values((await pg.query(sql)).rows[0])[0] };
  await installCloudBillingSchema(db);
});
test.after(async () => { await pg.close(); });
test("native-test SQL fixtures execute real migrations, close drafts and finalize receipt-bound expired sessions", async () => {
  const draft = await seedOrder(db, { issued: false });
  assert.equal((await db.value(cancelSql(draft))).status, "closed");
  const issued = await seedOrder(db);
  assert.equal((await db.value(cancelSql(issued))).status, "ready");
  assert.equal((await db.value(finalizeSql(issued))).status, "closed");
});
test("native-test fixed and recurring paid fixtures retain actual entitlement and renewal state", async () => {
  for (const recurring of [false, true]) {
    const f = await seedOrder(db, { recurring });
    await db.value(cancelSql(f));
    await db.value(paymentSql(f));
    await assertPaid(db, f);
    await db.value(paymentSql(f));
    await assertPaid(db, f);
  }
});
test("native-test finalized order still records a later verified paid event without double entitlement", async () => {
  const f = await seedOrder(db);
  await db.value(cancelSql(f));
  assert.equal((await db.value(finalizeSql(f))).status, "closed");
  await db.value(paymentSql(f));
  await assertPaid(db, f);
});
test("native-test future expiry and mismatched attempt proof never finalize", async () => {
  const f = await seedOrder(db, { expired: false });
  await db.value(cancelSql(f));
  assert.equal((await db.value(finalizeSql(f))).status, "ready");
  const expired = await seedOrder(db); await db.value(cancelSql(expired));
  const rejected = await db.value(finalizeSql(expired, ["ORD_wrong"]));
  assert.equal(rejected.status, "ready");
});
test("synthetic SQL literals escape quotes without reimplementing billing logic", () => {
  assert.equal(literal("fixture'quote"), "'fixture''quote'");
  assert.equal(literal(null), "NULL");
});

test("native financial CI uses disposable PostgreSQL17 and no project secrets", () => {
  const fs = require("node:fs"), path = require("node:path");
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/ci.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("  billing-native-postgres:"));
  assert.match(job, /image: postgres:17/);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /timeout-minutes: 8/);
  assert.match(job, /job.services.postgres.ports\[5432\]/);
  assert.match(job, /test\/native\/cloud-order-cancellation-postgres.test.cjs/);
  assert.doesNotMatch(job, /secrets\.|pull_request_target|write-all/);
});

test("recurring native fixture uses PostgreSQL calendar-month boundaries at January month end", async () => {
  const f = await seedOrder(db, { recurring: true, periodStart: "2027-01-31T12:00:00.000Z" });
  assert.equal(new Date(f.event.ends_at).toISOString(), "2027-02-28T12:00:00.000Z");
});

test("native driver removes libpq service selectors instead of setting an empty service name", () => {
  const inherited = { PGSERVICE: "synthetic-service", PGSERVICEFILE: "/fixture/not-read", PGPASSWORD: "fixture-only" };
  const env = nativeConnectionEnvironment(inherited);
  assert.equal("PGSERVICE" in env, false);
  assert.equal("PGSERVICEFILE" in env, false);
  assert.equal(env.PGHOSTADDR, "127.0.0.1");
  assert.equal(env.PGPASSFILE, "/dev/null");
  assert.equal(env.PGPASSWORD, "fixture-only");
  assert.equal(inherited.PGSERVICE, "synthetic-service");
});
