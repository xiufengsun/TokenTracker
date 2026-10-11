const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup, migration } = require("./helpers/cloud-usage-archive-fixture");
const qa = require("../scripts/cloud-sandbox/qa-database.cjs");

let db, a, c, other, sql, snapshot, token, device, day;
const rpc = async (name, args = []) => (await db.query(`SELECT ${qa.RPC_MAP[name]}(${args.map((_, i) => "$" + (i + 1)).join(",")}) r`, args)).rows[0].r;
const publicRpc = async (name, args = []) => (await db.query(`SELECT ${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) r`, args)).rows[0].r;
const table = name => qa.TABLE_MAP[name];
async function originals() {
  return (await db.query("SELECT p.proname,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT starts_with(p.proname,$1) ORDER BY p.oid", [qa.PREFIX])).rows;
}
async function issue(user, machine = randomUUID()) {
  const hash = randomUUID();
  const result = await rpc("cloud_issue_device_token", [user, "sandbox", "QA " + machine.slice(0, 8), "web", machine, [], randomUUID(), hash, false, null]);
  return { ...result, hash };
}
async function write(user, dev, value, hour = day + "T02:00:00Z") {
  await db.query(`INSERT INTO ${table("tokentracker_hourly")}(user_id,device_id,source,model,hour_start,input_tokens,
    cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,billable_total_tokens,conversations,total_cost_usd)
    VALUES($1,$2,'codex','gpt-6',$3,$4,0,0,0,0,$4,$4,1,0)
    ON CONFLICT(user_id,device_id,source,model,hour_start) DO UPDATE SET input_tokens=excluded.input_tokens,total_tokens=excluded.total_tokens,billable_total_tokens=excluded.billable_total_tokens`, [user, dev, hour, value]);
}
async function truth(user, dev) {
  return (await db.query(`SELECT total_tokens::int n FROM ${qa.RPC_MAP.cloud_usage_hourly}($1,$2,NULL,NULL) ORDER BY hour_start`, [user, dev])).rows.map(row => row.n);
}

test.before(async () => {
  db = await setup();
  for (const name of ["20261003120000_cloud-subscriptions.sql", "20261004120000_cloud-machine-access.sql",
    "20261007120000_cloud-waffo.sql", "20261007130000_cloud-waffo-retry.sql", "20261007140000_cloud-waffo-attempts.sql",
    "20261007150000_cloud-waffo-authorizations.sql", "20261007160000_cloud-waffo-sandbox-periods.sql", "20261008120000_self-hosted-access.sql"]) await db.exec(migration(name));
  const files = ["20260918041500_fold-account-summary-and-heatmap-aggregation.sql", "20260918043000_fold-account-model-breakdown-aggregation.sql",
    "20260918050000_fold-account-daily-aggregation.sql", "20261002090000_compact-account-model-wire.sql", "20261003093000_compact-account-summary-model-wire.sql"];
  for (const name of files) {
    const source = migration(name);
    const functions = [...source.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(match => match[1]);
    for (const name of functions) await db.exec(qa.functionSql(source, name));
  }
  [a, c, other] = [randomUUID(), randomUUID(), randomUUID()];
  for (const user of [a, c, other]) await db.query("INSERT INTO auth.users VALUES($1)", [user]);
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now() WHERE environment='sandbox'");
  // Public financial fixtures exercise the real bridge; the QA installer never writes them.
  const order = await publicRpc("cloud_create_order", [a, "sandbox", "waffo", "cloud_usd_monthly_fixed", randomUUID()]);
  const product = "PROD_" + "T".repeat(22), ord = "ORD_" + "T".repeat(22);
  await publicRpc("cloud_attach_waffo_checkout", [a, order.id, null, product, null]);
  await publicRpc("cloud_register_waffo_attempt", [order.id, "sandbox", ord, product, "fixed"]);
  await publicRpc("cloud_apply_event", ["waffo", "sandbox", JSON.stringify({ event_id: randomUUID(), action_id: "PAY_" + "T".repeat(22),
    kind: "payment", order_id: order.id, waffo_order_id: ord, provider_price_id: product, currency: "USD", amount_cents: 499,
    base_amount_cents: 499, occurred_at: new Date().toISOString() })]);
  snapshot = (await originals()).map(row => row.definition.trimEnd() + ";").join("\n\n");
  sql = qa.buildSql({ allowedUsers: [a, c], baselineSql: snapshot });
  const before = await originals();
  const triggers = (await db.query("SELECT tgrelid,tgname,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY oid")).rows;
  await db.transaction(async tx => tx.exec(sql));
  assert.deepEqual(await originals(), before, "QA must leave every original function unchanged");
  assert.deepEqual((await db.query("SELECT t.tgrelid,t.tgname,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND NOT starts_with(c.relname,$1) ORDER BY t.oid", [qa.PREFIX])).rows, triggers);
  day = (await db.query("SELECT ((now()-interval '120 days') AT TIME ZONE 'UTC')::date::text d")).rows[0].d;
});
test.after(async () => db?.close());

test("maps cover actual handler calls without custom schemas or identifier truncation", () => {
  for (const name of ["cloud_issue_device_token", "cloud_ingest_usage", "cloud_account_access", "cloud_membership",
    "cloud_list_machines", "cloud_remove_machine", "cloud_resume_machine", "cloud_grant_device_code", "account_summary_wire",
    "account_daily_wire", "account_heatmap_wire", "account_model_breakdown_wire", "account_usage_grouped_cached", "account_usage_grouped"]) {
    assert.equal(qa.RPC_MAP[name], qa.PREFIX + name);
  }
  for (const name of Object.values(qa.OBJECT_MAP)) assert.ok(Buffer.byteLength(name) <= 63);
  assert.doesNotMatch(sql, /CREATE SCHEMA|CREATE ROLE|SET(?: LOCAL)? statement_timeout/);
  assert.match(sql, /Source snapshot SHA256/);
  assert.match(qa.rewrite("IF TG_TABLE_NAME='tokentracker_hourly' THEN RETURN NEW; END IF;"), /'tt_cloud_qa_tokentracker_hourly'/);
  assert.match(qa.rewrite("EXECUTE format('DELETE FROM public.%I WHERE user_id=$1',v_table); v_table:='agentmeter_hourly';"), /'tt_cloud_qa_agentmeter_hourly'/);
  assert.match(qa.rewrite("SELECT pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));"), /tt_cloud_qa_lock_key/);
});

test("unreviewed public objects, locks, malformed identities and source drift fail before SQL", () => {
  for (const source of ["SELECT * FROM public.secret_usage", "SELECT * FROM tokentracker_unknown_table",
    "SELECT cloud_future_writer()", "SELECT pg_advisory_xact_lock(hashtext('shared'))", "CREATE SCHEMA leaked"])
    assert.throws(() => qa.rewrite(source), /Unmapped|Unscoped|cannot create/);
  assert.throws(() => qa.buildSql({ allowedUsers: ["*"], baselineSql: snapshot }), /UUID/);
  assert.throws(() => qa.buildSql({ allowedUsers: [a, a], baselineSql: snapshot }), /Invalid/);
  assert.throws(() => qa.buildSql({ allowedUsers: [a], baselineSql: snapshot.replace("FROM public.tokentracker_hourly h", "FROM public.unreviewed_usage h") }), /Unmapped/);
  assert.throws(() => qa.functionSql("CREATE FUNCTION public.other()", "missing"), /Expected one/);
});

test("empty QA tables and scope guards isolate real paid and free users without copying payments", async () => {
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${table("tokentracker_devices")}`)).rows[0].n, 0);
  const actual = await publicRpc("cloud_membership", [a, "sandbox"]);
  assert.deepEqual(await rpc("cloud_membership", [a, "sandbox"]), actual);
  assert.equal(actual.status, "active");
  assert.equal((await rpc("cloud_membership", [c, "sandbox"])).status, "free");
  assert.equal((await rpc("cloud_account_access", [c, "sandbox", "daily"])).code, "cloud_membership_required");
  await assert.rejects(rpc("cloud_membership", [other, "sandbox"]), /allowed sandbox/);
  await assert.rejects(rpc("cloud_membership", [a, "live"]), /allowed sandbox/);
  await assert.rejects(db.query(`INSERT INTO ${table("tokentracker_devices")}(id,user_id,device_name) VALUES($1,$2,'forbidden')`, [randomUUID(), other]), /foreign key/);
  await assert.rejects(rpc("cloud_usage_begin_operation", [randomUUID(), other, "cleanup", "{}"]), /foreign key/);
  await assert.rejects(db.query(`INSERT INTO ${table("tokentracker_usage_archive_generations")}
    (user_id,device_id,day,payload,checksum,row_count,min_revision,max_revision) VALUES($1,$2,$3,'[]','bad',1,0,0)`, [other, randomUUID(), day]), /foreign key/);
  assert.equal((await db.query("SELECT pg_relation_is_updatable($1::regclass,false) bits", [table("tokentracker_cloud_policy")])).rows[0].bits, 0);
  await assert.rejects(db.query(`UPDATE ${table("tokentracker_cloud_policy")} SET phase='preview'`), /cannot update view/);
  assert.equal((await db.query("SELECT phase FROM tokentracker_cloud_policy WHERE environment='sandbox'")).rows[0].phase, "active");
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_class WHERE relname LIKE 'tt_cloud_qa_%payments%' OR relname LIKE 'tt_cloud_qa_%orders%' OR relname LIKE 'tt_cloud_qa_%subscriptions%'")).rows[0].n, 0);
});

test("all QA tables, sequences and functions reject anonymous and authenticated SQL roles", async () => {
  for (const role of ["anon", "authenticated"]) {
    assert.equal((await db.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') allowed`, [role, table("tokentracker_device_tokens")])).rows[0].allowed, false);
    assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, qa.RPC_MAP.cloud_membership + "(uuid,text)"])).rows[0].allowed, false);
    assert.equal((await db.query("SELECT has_sequence_privilege($1,$2,'USAGE') allowed", [role, qa.OBJECT_MAP.tokentracker_usage_revision_seq])).rows[0].allowed, false);
    await assert.rejects(db.transaction(async tx => { await tx.exec("SET LOCAL ROLE " + role); await tx.query(`SELECT * FROM ${table("tokentracker_hourly")}`); }), /permission denied/);
  }
});

test("real QA issuance and ingest never register a token in the original table", async () => {
  const issued = await issue(a); assert.equal(issued.ok, true);
  token = issued.hash; device = issued.device_id;
  const rows = [{ hour_start: day + "T02:00:00Z", source: "codex", model: "gpt-6", input_tokens: 100, cached_input_tokens: 0,
    cache_creation_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 100, billable_total_tokens: 100, conversations: 1, total_cost_usd: 0 }];
  assert.equal((await rpc("cloud_ingest_usage", [token, "sandbox", JSON.stringify(rows), "[]", randomUUID()])).ok, true);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_device_tokens WHERE token_hash=$1", [token])).rows[0].n, 0);
  assert.equal((await db.query(`SELECT cloud_environment FROM ${table("tokentracker_device_tokens")} WHERE token_hash=$1`, [token])).rows[0].cloud_environment, "sandbox");
  assert.equal((await rpc("cloud_ingest_usage", [token, "live", JSON.stringify(rows), "[]", randomUUID()])).code, "cloud_environment_mismatch");
});

test("actual cloned aggregation retains cold truth and decreasing hot corrections", async () => {
  const before = await rpc("account_usage_grouped", [a, [device], day + "T00:00:00Z", day + "T23:59:59Z", "day", "UTC", null]);
  const gen = await rpc("cloud_prepare_usage_archive", [a, device, day]);
  await write(a, device, 60);
  const committed = await rpc("cloud_commit_usage_archive", [gen]);
  assert.equal(committed.deleted_hot_rows, 0);
  assert.deepEqual(await truth(a, device), [60]);
  await write(a, device, 0);
  assert.deepEqual(await truth(a, device), [0]);
  const next = await rpc("cloud_prepare_usage_archive", [a, device, day]);
  assert.equal((await rpc("cloud_commit_usage_archive", [next])).deleted_hot_rows, 1);
  assert.deepEqual(await truth(a, device), [0]);
  const grouped = await rpc("account_usage_grouped", [a, [device], day + "T00:00:00Z", day + "T23:59:59Z", "day", "UTC", null]);
  assert.equal(before[0].total_tokens, 100); assert.equal(grouped[0].total_tokens, 0);
  assert.equal((await rpc("cloud_commit_usage_archive", [next])).already_committed, true);
});

test("QA restore and exact erasure preserve the real ledger and another user's usage", async () => {
  const financial = (await db.query("SELECT to_jsonb(p) r FROM tokentracker_cloud_payments p ORDER BY id")).rows;
  const member = await publicRpc("cloud_membership", [a, "sandbox"]);
  const peer = await issue(c); assert.equal(peer.ok, true); await write(c, peer.device_id, 17);
  const restored = await rpc("cloud_restore_usage_archive", [randomUUID(), a, device, day]);
  assert.equal(restored.restored, true); assert.deepEqual(await truth(a, device), [0]);
  await assert.rejects(rpc("cloud_erase_user_usage", [randomUUID(), a, c]), /confirmation/);
  assert.equal((await rpc("cloud_erase_user_usage", [randomUUID(), a, a])).auth_preserved, true);
  assert.deepEqual(await truth(a, device), []);
  assert.deepEqual(await truth(c, peer.device_id), [17]);
  assert.deepEqual((await db.query("SELECT to_jsonb(p) r FROM tokentracker_cloud_payments p ORDER BY id")).rows, financial);
  assert.deepEqual(await publicRpc("cloud_membership", [a, "sandbox"]), member);
  assert.equal((await db.query("SELECT count(*)::int n FROM auth.users WHERE id=$1", [a])).rows[0].n, 1);
});

test("installer replay preserves QA rows and original RPCs and rejects another scope", async () => {
  const rows = (await db.query(`SELECT to_jsonb(h) r FROM ${table("tokentracker_hourly")} h ORDER BY user_id,hour_start`)).rows;
  const functions = await originals();
  await db.transaction(async tx => tx.exec(sql));
  assert.deepEqual((await db.query(`SELECT to_jsonb(h) r FROM ${table("tokentracker_hourly")} h ORDER BY user_id,hour_start`)).rows, rows);
  assert.deepEqual(await originals(), functions);
  await assert.rejects(db.transaction(async tx => tx.exec(qa.buildSql({ allowedUsers: [a, other], baselineSql: snapshot }))), /another reviewed scope or version/);
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname='tt_cloud_qa'")).rows[0].n, 0);
});

test("a stale source snapshot refuses replay without changing original or QA rows", async () => {
  const before = await originals();
  const rows = (await db.query(`SELECT to_jsonb(h) r FROM ${table("tokentracker_hourly")} h ORDER BY user_id,hour_start`)).rows;
  await assert.rejects(db.transaction(async tx => {
    await tx.exec("CREATE OR REPLACE FUNCTION public.account_usage_grouped_v2(p_user_id uuid,p_device_id uuid,p_from timestamptz,p_to timestamptz,p_trunc text,p_tz text,p_offset_min integer) RETURNS jsonb LANGUAGE sql AS $$ SELECT '[]'::jsonb $$");
    await tx.exec(sql);
  }), /Reviewed source snapshot drift/);
  assert.deepEqual(await originals(), before);
  assert.deepEqual((await db.query(`SELECT to_jsonb(h) r FROM ${table("tokentracker_hourly")} h ORDER BY user_id,hour_start`)).rows, rows);
});
