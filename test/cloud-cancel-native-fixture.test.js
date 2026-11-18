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

test("native financial CI covers production PostgreSQL15 and PostgreSQL17 with no project secrets", () => {
  const fs = require("node:fs"), path = require("node:path");
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/ci.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("  billing-native-postgres:"));
  assert.match(job, /postgres: \[15, 17\]/);
  assert.match(job, /image: postgres:\$\{\{ matrix.postgres \}\}/);
  assert.match(job, /TOKENTRACKER_TEST_PGMAJOR: \$\{\{ matrix.postgres \}\}/);
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

test("native server guard requires its explicit supported service version", () => {
  const { assertNativePostgresVersion } = require("./native/cloud-order-cancellation-postgres.test.cjs");
  assert.doesNotThrow(() => assertNativePostgresVersion(150018, "15"));
  assert.doesNotThrow(() => assertNativePostgresVersion(170012, "17"));
  assert.throws(() => assertNativePostgresVersion(150018, "17"));
  for (const major of ["", "16", "15;unexpected"]) assert.throws(() => assertNativePostgresVersion(150018, major));
});

test("legacy checkout claim after migration is not a never-issued cancellable draft", async () => {
  const f = await seedOrder(db, { issued: false });
  await db.value(`SELECT cloud_claim_checkout(${literal(f.owner)},${literal(f.id)})`);
  const result = await db.value(cancelSql(f));
  assert.equal(result.status, "pending");
  assert.equal(result.checkout_tracking_uncertain, true);
});

test("legacy claimed-false recovery cannot reuse a tracked operation as provenance", async () => {
  const f = await seedOrder(db, { issued: false });
  await db.value(`SELECT cloud_attach_waffo_checkout(${literal(f.owner)},${literal(f.id)},NULL,${literal(f.product)},NULL)`);
  const tracked = await db.value(`SELECT cloud_claim_checkout_tracked(${literal(f.owner)},'sandbox',${literal(f.id)})`);
  assert.ok(tracked.operation_id);
  const legacy = await db.value(`SELECT cloud_claim_checkout(${literal(f.owner)},${literal(f.id)})`);
  assert.equal(legacy.claimed, false);
  assert.equal(legacy.order.checkout_tracking_uncertain, true);
  await db.value(`SELECT cloud_attach_waffo_checkout(${literal(f.owner)},${literal(f.id)},${literal(f.checkout)},${literal(f.product)},'https://fixture.invalid/checkout',${literal(f.expiry)})`);
  await db.value(`SELECT cloud_register_waffo_attempt(${literal(f.id)},'sandbox',${literal(f.attempt)},${literal(f.product)},'fixed')`);
  await db.value(`SELECT cloud_finish_checkout_operation(${literal(f.owner)},'sandbox',${literal(f.id)},${literal(tracked.operation_id)},false)`);
  assert.equal((await db.value(cancelSql(f))).status, "ready");
  assert.equal((await db.value(finalizeSql(f))).status, "ready", "known expired receipt cannot erase legacy recovery uncertainty");
});

test("cancellation migration is accepted by official InsForge session-configuration guards", () => {
  const fs = require("node:fs"), path = require("node:path");
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/20261117090000_cloud-order-cancellation.sql"), "utf8");
  assert.doesNotMatch(sql, /\bset_config\s*\(/i);
  assert.doesNotMatch(sql, /\bcurrent_setting\s*\(/i);
});
test("stale transaction markers cannot finalize and clients cannot write markers", async () => {
  const f = await seedOrder(db);
  assert.equal((await db.value(cancelSql(f))).status, "ready");
  await db.exec(`INSERT INTO tokentracker_cloud_tx_markers(txid,kind,order_id) VALUES(txid_current()-1,'order_cancel_finalizing',${literal(f.id)})`);
  await assert.rejects(db.exec(`UPDATE tokentracker_cloud_orders SET status='closed' WHERE id=${literal(f.id)}`), /order cancellation is pending/i);
  assert.equal((await db.value(`SELECT status FROM tokentracker_cloud_orders WHERE id=${literal(f.id)}`)), "ready");
  assert.equal(await db.value("SELECT has_table_privilege('authenticated','tokentracker_cloud_tx_markers','INSERT')"), false);
  assert.equal(await db.value("SELECT has_function_privilege('authenticated','cloud_tx_mark(text,uuid)','EXECUTE')"), false);
});
