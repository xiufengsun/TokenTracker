// Opt-in native PostgreSQL15/17 tests. No gateway HTTP calls or production credentials.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { installCloudBillingSchema } = require("../helpers/cloud-billing-schema-fixture");
const literal = value => value == null ? "NULL" : "'" + String(value).replaceAll("'", "''") + "'";
const id = prefix => prefix + randomUUID().replaceAll("-", "");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function nativeConnectionEnvironment(inherited) {
  const env = { ...inherited, PGHOSTADDR: "127.0.0.1", PGPASSFILE: "/dev/null", PGCONNECT_TIMEOUT: "5",
    PGOPTIONS: "-c lock_timeout=8000 -c statement_timeout=12000 -c idle_in_transaction_session_timeout=15000 -c timezone=UTC" };
  // libpq treats even PGSERVICE="" as a service lookup, not as disabled.
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  return env;
}

function assertNativePostgresVersion(number, major) {
  assert.match(major || "", /^(15|17)$/, "only explicit PostgreSQL15/17 fixture targets allowed");
  assert.equal(Math.floor(number / 10000), Number(major), `native PostgreSQL${major} required`);
}

class PsqlSession {
  constructor() {
    assert.equal(process.env.TOKENTRACKER_NATIVE_POSTGRES, "1", "native tests require explicit opt-in");
    const port = process.env.TOKENTRACKER_TEST_PGPORT;
    assert.match(port || "", /^\d{1,5}$/);
    assert.ok(Number(port) > 0 && Number(port) <= 65535);
    this.buffer = ""; this.stderr = ""; this.pending = null; this.closed = false;
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.child = spawn("psql", ["-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1",
      "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", "tokentracker_cancel_native"], {
      env: nativeConnectionEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      this.buffer += chunk;
      while (this.buffer.includes("\n")) {
        const end = this.buffer.indexOf("\n"), line = this.buffer.slice(0, end).replace(/\r$/, "");
        this.buffer = this.buffer.slice(end + 1);
        if (!this.pending) continue;
        if (line === this.pending.marker) {
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
          pending.resolve(pending.lines.join("\n").trim());
        } else if (line) this.pending.lines.push(line);
      }
    });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-16000); });
    const finish = error => {
      if (this.closed) return;
      this.closed = true;
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
      this.resolveExit();
    };
    this.child.on("error", finish);
    this.child.on("exit", code => finish(new Error(`psql exited ${code}: ${this.stderr}`)));
    this.child.stdin.on("error", error => { if (this.pending) this.pending.reject(error); });
  }
  exec(sql) {
    assert.equal(this.closed, false, "session already closed");
    assert.equal(this.pending, null, "one active query per native connection");
    return new Promise((resolve, reject) => {
      const marker = id("native_done_");
      const timer = setTimeout(() => { this.child.kill("SIGTERM"); reject(new Error("native query exceeded 14s")); }, 14000);
      this.pending = { marker, lines: [], resolve, reject, timer };
      this.child.stdin.write(sql + ";\n\\echo " + marker + "\n");
    });
  }
  async value(sql) {
    return JSON.parse(await this.exec(`SELECT to_jsonb(native_value) FROM (${sql}) AS native_result(native_value)`));
  }
  async close() {
    if (this.closed) return;
    this.child.stdin.end("\\q\n");
    await Promise.race([this.exited, delay(300)]);
    if (!this.closed) this.child.kill("SIGTERM");
    await Promise.race([this.exited, delay(300)]);
    if (!this.closed) { this.child.kill("SIGKILL"); await this.exited; }
  }
}
const cancelSql = f => `SELECT cloud_request_order_cancel(${literal(f.owner)},'sandbox',${literal(f.id)})`;
const finalizeSql = (f, attempts = [f.attempt], checkout = f.checkout) =>
  `SELECT cloud_finalize_order_cancel(${literal(f.owner)},'sandbox',${literal(f.id)},${literal(checkout)},${literal(f.expiry)},ARRAY[${attempts.map(literal).join(",")}]::text[])`;
const paymentSql = f => `SELECT cloud_apply_waffo_events('sandbox',${literal(JSON.stringify([f.event]))}::jsonb)`;
async function seedOrder(db, { issued = true, expired = true, recurring = false, owner = randomUUID(), periodStart = new Date().toISOString() } = {}) {
  await db.exec(`INSERT INTO auth.users(id) VALUES(${literal(owner)}) ON CONFLICT DO NOTHING`);
  const row = await db.value(`SELECT cloud_create_order(${literal(owner)},'sandbox','waffo',${literal(recurring ? "cloud_usd_monthly" : "cloud_usd_monthly_fixed")},${literal(randomUUID())})`);
  const f = { ...row, owner, checkout: id("cs_native"), attempt: id("ORD_"), product: id("PROD_") };
  f.expiry = new Date(Date.now() + (expired ? -7200000 : 3600000)).toISOString();
  if (!issued) return f;
  const operation = await db.value(`SELECT cloud_claim_checkout_tracked(${literal(owner)},'sandbox',${literal(f.id)})`);
  assert.ok(operation.operation_id);
  await db.value(`SELECT cloud_attach_waffo_checkout(${literal(owner)},${literal(f.id)},${literal(f.checkout)},${literal(f.product)},'https://fixture.invalid/checkout',${literal(f.expiry)})`);
  await db.value(`SELECT cloud_finish_checkout_operation(${literal(owner)},'sandbox',${literal(f.id)},${literal(operation.operation_id)},false)`);
  await db.value(`SELECT cloud_register_waffo_attempt(${literal(f.id)},'sandbox',${literal(f.attempt)},${literal(f.product)},${literal(recurring ? "recurring" : "fixed")})`);
  f.event = { order_id: f.id, event_id: id("native_event_"), kind: "payment", action_id: id("PAY_"),
    occurred_at: new Date().toISOString(), waffo_order_id: f.attempt, provider_price_id: f.product,
    currency: row.currency, base_amount_cents: row.amount_cents, amount_cents: row.amount_cents };
  if (recurring) {
    const period = await db.value(`SELECT jsonb_build_object('starts_at',${literal(periodStart)}::timestamptz,'ends_at',${literal(periodStart)}::timestamptz + interval '1 month')`);
    await db.value(`SELECT cloud_record_waffo_period(${literal(f.id)},'sandbox',${literal(f.attempt)},${literal(f.product)},1,${literal(period.starts_at)},${literal(period.ends_at)})`);
    Object.assign(f.event, { subscription_id: f.attempt, period_number: 1, ...period });
  }
  return f;
}
const paidStateSql = f => `SELECT jsonb_build_object('status',o.status,
  'payments',(SELECT count(*) FROM tokentracker_cloud_payments WHERE order_id=o.id),
  'refunded',(SELECT coalesce(sum(refunded_cents),0) FROM tokentracker_cloud_payments WHERE order_id=o.id),
  'orders',(SELECT count(*) FROM tokentracker_cloud_orders WHERE user_id=o.user_id),
  'membership',cloud_membership(o.user_id,'sandbox')->>'status',
  'cancelled_renewals',(SELECT count(*) FROM tokentracker_cloud_subscriptions WHERE order_id=o.id AND cancel_at_period_end))
  FROM tokentracker_cloud_orders o WHERE id=${literal(f.id)}`;
async function assertPaid(db, f) {
  assert.deepEqual(await db.value(paidStateSql(f)), { status: "paid", payments: 1, refunded: 0, orders: 1, membership: "active", cancelled_renewals: 0 });
}

function registerNativeTests() {
  let admin;
  const sessions = new Set();
  async function connect(role = "project_admin") {
    const session = new PsqlSession(); sessions.add(session);
    if (role) await session.exec(`SET ROLE ${role}`);
    session.pid = await session.value("SELECT pg_backend_pid()");
    return session;
  }
  test.before(async () => {
    admin = await connect(null);
    const version = await admin.value("SELECT to_jsonb(current_setting('server_version'))");
    const number = await admin.value("SELECT current_setting('server_version_num')::int");
    assertNativePostgresVersion(number, process.env.TOKENTRACKER_TEST_PGMAJOR || "17");
    console.log(`Native PostgreSQL ${version}; independent psql backends; no provider requests`);
    assert.equal(await admin.value("SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')"), 0, "refuse nonempty test database");
    await installCloudBillingSchema(admin);
  });
  test.after(async () => { await Promise.all([...sessions].map(session => session.close())); });
  async function interleave(firstSql, secondSql, label, lockType = "advisory") {
    const a = await connect(), b = await connect();
    try {
      await a.exec("BEGIN");
      const first = await a.value(firstSql);
      let failure;
      const pending = b.value(secondSql); pending.catch(error => { failure = error; });
      const deadline = Date.now() + 4000;
      let blocked = false;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        blocked = await admin.value(`SELECT ${a.pid}=ANY(pg_blocking_pids(${b.pid}))`);
        if (blocked) break;
        await delay(15);
      }
      assert.equal(blocked, true, `${label}: observer must prove independent connection blocked`);
      assert.equal(await admin.value(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${b.pid} AND NOT granted AND locktype=${literal(lockType)})`), true, `${label}: expected ${lockType} lock`);
      console.log(`${label}: backend ${b.pid} blocked on ${a.pid} (${lockType}); release by COMMIT`);
      await a.exec("COMMIT");
      return { first, second: await pending };
    } finally { await a.close(); await b.close(); sessions.delete(a); sessions.delete(b); }
  }
  for (const first of ["cancel", "payment", "finalize", "payment-before-finalize"]) {
    test(`native paid-wins both lock orders: ${first}, 10 repetitions`, async () => {
      for (let i = 0; i < 10; i++) {
        const f = await seedOrder(admin);
        if (first.includes("finalize")) await admin.value(cancelSql(f));
        const firstSql = first === "cancel" ? cancelSql(f) : first === "finalize" ? finalizeSql(f) : paymentSql(f);
        const secondSql = first === "cancel" || first === "finalize" ? paymentSql(f) : first === "payment" ? cancelSql(f) : finalizeSql(f);
        const result = await interleave(firstSql, secondSql, `${first}[${i}]`);
        if (first === "finalize") assert.equal(result.first.status, "closed");
        if (first === "payment" || first === "payment-before-finalize") assert.equal(result.second.status, "paid");
        await assertPaid(admin, f);
        await admin.value(paymentSql(f)); // actual webhook persistence deduplication
        await assertPaid(admin, f);
      }
    });
  }
  test("native cancellation respects an independently held order row lock", async () => {
    const f = await seedOrder(admin);
    const result = await interleave(`SELECT to_jsonb(o) FROM tokentracker_cloud_orders o WHERE id=${literal(f.id)} FOR UPDATE`, cancelSql(f), "order-row-lock", "transactionid");
    assert.equal(result.second.status, "ready");
  });
  test("native concurrent repeated draft cancellation is atomic and idempotent", async () => {
    for (let i = 0; i < 10; i++) {
      const f = await seedOrder(admin, { issued: false });
      const result = await interleave(cancelSql(f), cancelSql(f), `duplicate-cancel[${i}]`);
      assert.equal(result.first.status, "closed"); assert.equal(result.second.status, "closed");
      assert.equal(result.first.cancel_requested_at, result.second.cancel_requested_at);
      assert.equal(await admin.value(`SELECT count(*)::int FROM tokentracker_cloud_orders WHERE user_id=${literal(f.owner)}`), 1);
    }
  });
  test("native recurring payment preserves active subscription and auto-renew", async () => {
    for (const paymentFirst of [false, true]) {
      const f = await seedOrder(admin, { recurring: true });
      await interleave(paymentFirst ? paymentSql(f) : cancelSql(f), paymentFirst ? cancelSql(f) : paymentSql(f), `recurring-${paymentFirst}`);
      await assertPaid(admin, f);
      assert.deepEqual(await admin.value(`SELECT jsonb_build_object('status',status,'renewal_cancelled',cancel_at_period_end) FROM tokentracker_cloud_subscriptions WHERE order_id=${literal(f.id)}`), { status: "active", renewal_cancelled: false });
    }
  });
  test("native intent serializes cleanup and rejects already-claimed sibling recovery", async () => {
    const f = await seedOrder(admin), sibling = await seedOrder(admin, { owner: f.owner, issued: false });
    const cleanup = await interleave(cancelSql(f), `SELECT cloud_close_unpaid_order(${literal(f.owner)},${literal(f.id)})`, "stale-cleanup");
    assert.equal(cleanup.second.status, "ready");
    const recovery = await interleave(cancelSql(f), `SELECT cloud_begin_checkout_operation(${literal(f.owner)},'sandbox',${literal(sibling.id)})`, "sibling-operation");
    assert.equal(recovery.second.allowed, false);
  });
  test("native in-flight operation, ambiguous receipt and terminal-proof checks fail closed", async () => {
    const f = await seedOrder(admin, { issued: false });
    const begun = await interleave(`SELECT cloud_begin_checkout_operation(${literal(f.owner)},'sandbox',${literal(f.id)})`, cancelSql(f), "operation-before-cancel");
    assert.equal(begun.first.allowed, true); assert.equal(begun.second.status, "pending");
    const denied = await admin.value(`SELECT cloud_begin_checkout_operation(${literal(f.owner)},'sandbox',${literal(f.id)})`); assert.equal(denied.allowed, false);
    await admin.value(`SELECT cloud_finish_checkout_operation(${literal(f.owner)},'sandbox',${literal(f.id)},${literal(begun.first.operation_id)},true)`);
    await admin.value(`SELECT cloud_finish_checkout_operation(${literal(f.owner)},'sandbox',${literal(f.id)},${literal(begun.first.operation_id)},false)`);
    assert.equal(await admin.value(`SELECT uncertain FROM tokentracker_cloud_checkout_operations WHERE id=${literal(begun.first.operation_id)}`), true);
    const issued = await seedOrder(admin); await admin.value(cancelSql(issued));
    assert.equal((await admin.value(finalizeSql(issued, [id("ORD_wrong")]))).status, "ready");
    assert.equal((await admin.value(finalizeSql(issued, [issued.attempt], "cs_wrong"))).status, "ready");
    assert.equal((await admin.value(finalizeSql(issued))).status, "closed", "valid evidence completes after rejecting mismatches");
    for (const condition of ["inflight", "uncertain", "legacy"]) {
      const unknown = await seedOrder(admin); await admin.value(cancelSql(unknown));
      if (condition === "legacy") await admin.exec(`UPDATE tokentracker_cloud_orders SET checkout_tracking_uncertain=true WHERE id=${literal(unknown.id)}`);
      else await admin.exec(`INSERT INTO tokentracker_cloud_checkout_operations(order_id,finished_at,uncertain) VALUES(${literal(unknown.id)},${condition === "inflight" ? "NULL" : "clock_timestamp()"},${condition === "uncertain"})`);
      assert.equal((await admin.value(finalizeSql(unknown))).status, "ready", condition);
    }
    const future = await seedOrder(admin, { expired: false }); await admin.value(cancelSql(future));
    assert.equal((await admin.value(finalizeSql(future))).status, "ready");
    const complete = await seedOrder(admin); await admin.value(cancelSql(complete));
    assert.equal((await admin.value(finalizeSql(complete))).status, "closed");
    assert.equal((await admin.value(finalizeSql(complete))).status, "closed");
  });
  test("native rolling legacy claims remain uncertain and tracked claims attach receipts atomically", async () => {
    const legacy = await seedOrder(admin, { issued: false });
    await admin.value(`SELECT cloud_claim_checkout(${literal(legacy.owner)},${literal(legacy.id)})`);
    const held = await admin.value(cancelSql(legacy));
    assert.equal(held.status, "pending");
    assert.equal(held.checkout_tracking_uncertain, true);
    const recovery = await seedOrder(admin, { issued: false });
    await admin.value(`SELECT cloud_attach_waffo_checkout(${literal(recovery.owner)},${literal(recovery.id)},NULL,${literal(recovery.product)},NULL)`);
    const tracked = await admin.value(`SELECT cloud_claim_checkout_tracked(${literal(recovery.owner)},'sandbox',${literal(recovery.id)})`);
    const recovered = await admin.value(`SELECT cloud_claim_checkout(${literal(recovery.owner)},${literal(recovery.id)})`);
    assert.equal(recovered.claimed, false);
    assert.equal(recovered.order.checkout_tracking_uncertain, true);
    await admin.value(`SELECT cloud_attach_waffo_checkout(${literal(recovery.owner)},${literal(recovery.id)},${literal(recovery.checkout)},${literal(recovery.product)},'https://fixture.invalid/checkout',${literal(recovery.expiry)})`);
    await admin.value(`SELECT cloud_register_waffo_attempt(${literal(recovery.id)},'sandbox',${literal(recovery.attempt)},${literal(recovery.product)},'fixed')`);
    await admin.value(`SELECT cloud_finish_checkout_operation(${literal(recovery.owner)},'sandbox',${literal(recovery.id)},${literal(tracked.operation_id)},false)`);
    assert.equal((await admin.value(cancelSql(recovery))).status, "ready");
    assert.equal((await admin.value(finalizeSql(recovery))).status, "ready");
    const fresh = await seedOrder(admin, { issued: false });
    const { first: claim, second: canceled } = await interleave(
      `SELECT cloud_claim_checkout_tracked(${literal(fresh.owner)},'sandbox',${literal(fresh.id)})`,
      cancelSql(fresh), "tracked-claim/receipt-vs-cancel");
    assert.ok(claim.operation_id);
    assert.equal(canceled.status, "pending");
    assert.equal(canceled.checkout_tracking_uncertain, false);
    assert.equal(await admin.value(`SELECT count(*)::int FROM tokentracker_cloud_checkout_operations WHERE order_id=${literal(fresh.id)}`), 1);
    const duplicate = await admin.value(`SELECT cloud_claim_checkout_tracked(${literal(fresh.owner)},'sandbox',${literal(fresh.id)})`);
    assert.equal(duplicate.cancel_pending, true);
    assert.equal(await admin.value(`SELECT count(*)::int FROM tokentracker_cloud_checkout_operations WHERE order_id=${literal(fresh.id)}`), 1);
  });
  test("native owner isolation, rollback lock release and service-only privileges", async () => {
    const f = await seedOrder(admin, { issued: false }), other = await seedOrder(admin, { issued: false });
    const a = await connect(), b = await connect();
    try {
      await a.exec("BEGIN"); await a.value(cancelSql(f));
      assert.equal((await b.value(cancelSql(other))).status, "closed", "different owner must finish before first transaction releases");
      await a.exec("ROLLBACK");
      assert.equal((await b.value(cancelSql(f))).status, "closed", "rollback releases advisory/row locks");
    } finally { await a.close(); await b.close(); }
    for (const sql of [cancelSql({ ...f, owner: randomUUID() }), cancelSql(f).replace("'sandbox'", "'live'")]) {
      const actor = await connect();
      try { await assert.rejects(actor.value(sql), /no rows|not found/i); } finally { await actor.close(); }
    }
    assert.equal(await admin.value("SELECT has_function_privilege('authenticated','cloud_request_order_cancel(uuid,text,uuid)','EXECUTE')"), false);
    assert.equal(await admin.value("SELECT has_function_privilege('authenticated','cloud_claim_checkout_tracked(uuid,text,uuid)','EXECUTE')"), false);
    assert.equal(await admin.value("SELECT has_table_privilege('authenticated','tokentracker_cloud_checkout_operations','INSERT')"), false);
    assert.equal(await admin.value("SELECT has_table_privilege('authenticated','tokentracker_cloud_tx_markers','INSERT')"), false);
    assert.equal(await admin.value("SELECT has_function_privilege('authenticated','cloud_tx_mark(text,uuid)','EXECUTE')"), false);
    const untrusted = await connect("authenticated");
    try { await assert.rejects(untrusted.value(cancelSql(f)), /permission denied/i); } finally { await untrusted.close(); }
  });
}
module.exports = { assertNativePostgresVersion, nativeConnectionEnvironment, literal, seedOrder, cancelSql, finalizeSql, paymentSql, paidStateSql, assertPaid };
if (require.main === module) registerNativeTests();
