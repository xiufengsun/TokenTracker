const test = require("node:test");
const { before, after } = test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");

let db;
let waffoDb;
let attemptsDb;
async function financialDatabase(withWaffo = false, withAttempts = false) {
  const fixture = new PGlite();
  await fixture.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE TABLE public.tokentracker_devices (
      id uuid PRIMARY KEY, user_id uuid, created_at timestamptz DEFAULT now()
    );
    GRANT SELECT ON public.tokentracker_devices TO project_admin;
  `);
  await fixture.exec(fs.readFileSync(path.join(__dirname, "../migrations/20261003120000_cloud-subscriptions.sql"), "utf8"));
  if (withWaffo) {
    await fixture.exec(fs.readFileSync(path.join(__dirname, "../migrations/20261007120000_cloud-waffo.sql"), "utf8"));
    await fixture.exec(fs.readFileSync(path.join(__dirname, "../migrations/20261007130000_cloud-waffo-retry.sql"), "utf8"));
    if (withAttempts) {
      await fixture.exec(fs.readFileSync(path.join(__dirname, "../migrations/20261007140000_cloud-waffo-attempts.sql"), "utf8"));
    }
  }
  await fixture.exec("UPDATE tokentracker_cloud_policy SET phase='active', launch_at=now() WHERE environment='sandbox'");
  return fixture;
}
before(async () => {
  db = await financialDatabase();
  waffoDb = await financialDatabase(true);
  attemptsDb = await financialDatabase(true,true);
});
after(async () => { await Promise.all([db?.close(), waffoDb?.close(), attemptsDb?.close()]); });

async function user() {
  const id = randomUUID();
  await db.query("INSERT INTO auth.users VALUES ($1)", [id]);
  return id;
}
async function membership(id, environment = "sandbox") {
  return (await db.query("SELECT cloud_membership($1,$2) AS result", [id, environment])).rows[0].result;
}
async function order(id, provider = "wechat", sku = "cloud_cny_monthly", requestId = randomUUID()) {
  return (await db.query("SELECT cloud_create_order($1,'sandbox',$2,$3,$4) AS result", [id, provider, sku, requestId])).rows[0].result;
}
function payment(o, overrides = {}) {
  return {
    event_id: randomUUID(), kind: "payment", action_id: randomUUID(), order_id: o.id,
    occurred_at: new Date().toISOString(), currency: o.currency,
    base_amount_cents: o.amount_cents, amount_cents: o.amount_cents,
    ...overrides,
  };
}
async function apply(o, event, environment = "sandbox") {
  return (await db.query("SELECT cloud_apply_event($1,$2,$3) AS result", [o.provider, environment, JSON.stringify(event)])).rows[0].result;
}
async function payments(id) {
  return (await db.query("SELECT * FROM tokentracker_cloud_payments WHERE user_id=$1 ORDER BY starts_at", [id])).rows;
}
function refund(event, amount, overrides = {}) {
  return {
    event_id: randomUUID(), kind: "refund", action_id: randomUUID(),
    order_id: event.order_id, occurred_at: new Date().toISOString(),
    transaction_id: event.action_id, currency: event.currency, amount_cents: amount,
    ...overrides,
  };
}

test("migration preserves existing Cloud access until launch and stores the agreed prices", async () => {
  const id = await user();
  assert.equal((await membership(id, "live")).status, "legacy_free");
  await assert.rejects(db.query("SELECT cloud_start_trial($1,'live')",[id]),/not launched/);
  assert.equal((await membership(id)).can_upload_cloud, false);
  assert.deepEqual((await db.query("SELECT amount_cents FROM tokentracker_cloud_catalog ORDER BY sku")).rows.map(r => r.amount_cents), [2900, 24900, 599, 4900]);
});

test("unpublished prices are available to the billing server and denied to direct clients", async () => {
  const fixture = await financialDatabase(true);
  try {
    for (const role of ["anon", "authenticated"]) {
      await fixture.exec(`SET ROLE ${role}`);
      await assert.rejects(fixture.query("SELECT sku,amount_cents FROM tokentracker_cloud_catalog"), /permission denied/);
      await fixture.exec("RESET ROLE");
    }
    await fixture.exec("SET ROLE project_admin");
    assert.equal((await fixture.query("SELECT sku FROM tokentracker_cloud_catalog WHERE active")).rows.length, 4);
  } finally { await fixture.close(); }
});

test("the no-card trial cannot be restarted after it expires", async () => {
  const id = await user();
  const first = (await db.query("SELECT cloud_start_trial($1,'sandbox') AS result", [id])).rows[0].result;
  assert.equal(first.status, "trial");
  assert.equal(first.machine_limit, 5);
  const again = (await db.query("SELECT cloud_start_trial($1,'sandbox') AS result", [id])).rows[0].result;
  assert.equal(again.trial_ends_at, first.trial_ends_at);
  await db.query("UPDATE tokentracker_cloud_accounts SET trial_started_at=now()-interval '8 days', trial_ends_at=now()-interval '1 day' WHERE user_id=$1", [id]);
  const expired = (await db.query("SELECT cloud_start_trial($1,'sandbox') AS result", [id])).rows[0].result;
  assert.equal(expired.status, "expired");
  assert.equal(expired.can_upload_cloud, false);
  assert.equal(expired.can_read_cloud, true);
});

test("existing cloud devices receive a bounded thirty-day transition", async () => {
  const id = await user();
  await db.query("INSERT INTO tokentracker_devices VALUES ($1,$2,now()-interval '1 day')", [randomUUID(), id]);
  const state = await membership(id);
  assert.equal(state.status, "transition");
  assert.equal(state.machine_limit, 5);
  assert.ok(Date.parse(state.transition_ends_at) > Date.now() + 29 * 86400_000);
});

test("checkout retries reuse the same order and cannot change its product", async () => {
  const id = await user();
  const requestId = randomUUID();
  const first = await order(id, "wechat", "cloud_cny_monthly", requestId);
  assert.equal((await order(id, "wechat", "cloud_cny_monthly", requestId)).id, first.id);
  await assert.rejects(order(id, "wechat", "cloud_cny_yearly", requestId), /different purchase/);
  await assert.rejects(order(id, "paddle", "cloud_cny_monthly"), /currency/);
});

test("only one request may create a provider checkout and bound quotes cannot be replaced", async () => {
  const id = await user();
  const o = await order(id, "paddle", "cloud_usd_monthly");
  const claim = async () => (await db.query("SELECT cloud_claim_checkout($1,$2) AS result", [id,o.id])).rows[0].result;
  assert.equal((await claim()).claimed, true);
  assert.equal((await claim()).claimed, false);
  await db.query("SELECT cloud_attach_checkout($1,$2,'txn_checkout','pri_month','https://example.com/checkout')", [id,o.id]);
  assert.equal((await claim()).order.provider_order_id, "txn_checkout");
  await assert.rejects(db.query("SELECT cloud_attach_checkout($1,$2,'txn_changed','pri_month','https://example.com/checkout')", [id,o.id]), /different provider transaction/);
});

test("provider reconciliation is serialized, owned, and bounded across requests",async()=>{
  const id=await user();const o=await order(id);
  const claim=()=>db.query("SELECT cloud_claim_reconciliation($1,$2) AS r",[id,o.id]);
  const results=await Promise.all([claim(),claim(),claim()]);
  assert.equal(results.filter(r=>r.rows[0].r.claimed).length,1);
  assert.ok(results.find(r=>!r.rows[0].r.claimed).rows[0].r.retry_after>0);
  await assert.rejects(db.query("SELECT cloud_claim_reconciliation($1,$2)",[await user(),o.id]),/no rows/);
  await db.query("UPDATE tokentracker_cloud_orders SET last_reconciled_at=now()-interval '31 seconds' WHERE id=$1",[o.id]);
  assert.equal((await claim()).rows[0].r.claimed,true);
});

test("two browser checkouts cannot start duplicate recurring charges, including an ambiguous expired response",async()=>{
  const id=await user();const first=await order(id,"paddle","cloud_usd_monthly");const second=await order(id,"paddle","cloud_usd_yearly");
  assert.equal((await db.query("SELECT cloud_claim_checkout($1,$2) AS r",[id,first.id])).rows[0].r.claimed,true);
  await assert.rejects(db.query("SELECT cloud_claim_checkout($1,$2)",[id,second.id]),/existing checkout/);
  await db.query("UPDATE tokentracker_cloud_orders SET expires_at=now()-interval '1 minute' WHERE id=$1",[first.id]);
  await assert.rejects(db.query("SELECT cloud_claim_checkout($1,$2)",[id,second.id]),/existing checkout/);
  await db.query("SELECT cloud_close_unpaid_order($1,$2)",[id,first.id]);
  assert.equal((await db.query("SELECT cloud_claim_checkout($1,$2) AS r",[id,second.id])).rows[0].r.claimed,true);
});

test("payment replay never grants a second membership term", async () => {
  const id = await user();
  const o = await order(id);
  const event = payment(o);
  assert.equal((await apply(o, event)).applied, true);
  const first = (await payments(id))[0];
  assert.equal((await apply(o, event)).duplicate, true);
  assert.equal((await apply(o, { ...event, event_id: randomUUID() })).status, "duplicate");
  assert.equal((await payments(id)).length, 1);
  assert.equal((await payments(id))[0].ends_at.getTime(), first.ends_at.getTime());
  assert.equal((await membership(id)).status, "active");
  await assert.rejects(db.query("SELECT cloud_start_trial($1,'sandbox')", [id]), /before the first purchase/);
});

test("removing an auth account cannot silently erase its payment and subscription audit trail",async()=>{
  const id=await user();const o=await order(id);await apply(o,payment(o));
  await assert.rejects(db.query("DELETE FROM auth.users WHERE id=$1",[id]),/foreign key constraint/);
  assert.equal((await payments(id)).length,1);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_events WHERE order_id=$1",[o.id])).rows[0].n,1);
});

test("independent fixed-term renewals stack after the already-paid period", async () => {
  const id = await user();
  const firstOrder = await order(id);
  await apply(firstOrder, payment(firstOrder));
  const secondOrder = await order(id, "alipay", "cloud_cny_yearly");
  await apply(secondOrder, payment(secondOrder));
  const rows = await payments(id);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].starts_at.getTime(), rows[0].ends_at.getTime());
  assert.equal(rows[1].ends_at.getUTCFullYear(), rows[1].starts_at.getUTCFullYear() + 1);
  assert.equal(Date.parse((await membership(id)).expires_at), rows[1].ends_at.getTime());
});

test("amount, currency, environment, and modified event identities fail atomically", async () => {
  const id = await user();
  const o = await order(id);
  const event = payment(o);
  await assert.rejects(apply(o, { ...event, amount_cents: 1, base_amount_cents: 1 }), /amount or currency/);
  await assert.rejects(apply(o, { ...event, currency: "USD" }), /amount or currency/);
  await assert.rejects(apply(o, event, "live"), /environment/);
  assert.equal((await payments(id)).length, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tokentracker_cloud_events WHERE order_id=$1", [o.id])).rows[0].n, 0);
  await apply(o, event);
  await assert.rejects(apply(o, { ...event, amount_cents: 3000 }), /identifier.*different/);
});

test("partial refunds preserve access and a full refund cannot be replayed or undone by a late payment", async () => {
  const id = await user();
  const o = await order(id);
  const event = payment(o);
  await apply(o, event);
  const firstRefund = refund(event, 1000);
  await apply(o, firstRefund);
  assert.equal((await membership(id)).status, "active");
  await apply(o, { ...firstRefund, event_id: randomUUID() });
  assert.equal((await payments(id))[0].refunded_cents, 1000);
  await assert.rejects(apply(o, refund(event, 2000)), /invalid refund/);
  await apply(o, refund(event, 1900));
  assert.equal((await membership(id)).can_upload_cloud, false);
  assert.equal((await payments(id))[0].refunded_cents, 2900);
  await apply(o, { ...event, event_id: randomUUID() });
  assert.equal((await membership(id)).can_upload_cloud, false);
});

test("a refunded middle term does not bridge into a future prepaid term", async () => {
  const id = await user();
  const first = await order(id);
  const event = payment(first);
  await apply(first, event);
  const second = await order(id);
  await apply(second, payment(second));
  await apply(first, refund(event, first.amount_cents));
  assert.equal((await membership(id)).can_upload_cloud, false);
  assert.equal((await membership(id)).expires_at, null);
});

test("Alipay cumulative refunds advance monotonically and a final notification applies atomically", async () => {
  const id = await user();
  const o = await order(id,"alipay");
  const paid = payment(o);
  const partial = refund(paid,1000,{refund_total_cents:1000});
  await db.query("SELECT cloud_apply_events('alipay','sandbox',$1)",[JSON.stringify([paid,partial])]);
  assert.equal((await payments(id))[0].refunded_cents,1000);
  const full = refund(paid,2900,{refund_total_cents:2900});
  await apply(o,full);
  assert.equal((await payments(id))[0].refunded_cents,2900);
  assert.equal((await membership(id)).can_upload_cloud,false);
  await apply(o,refund(paid,1500,{refund_total_cents:1500}));
  assert.equal((await payments(id))[0].refunded_cents,2900);

  const other = await user(); const otherOrder = await order(other,"alipay"); const otherPaid = payment(otherOrder);
  await assert.rejects(db.query("SELECT cloud_apply_events('alipay','sandbox',$1)",[
    JSON.stringify([otherPaid,refund(otherPaid,3000,{refund_total_cents:3000})])]),/invalid refund amount/);
  assert.equal((await payments(other)).length,0);
});

test("Paddle subscription events grant no unpaid time and cancellation preserves the paid term", async () => {
  const id = await user();
  const o = await order(id, "paddle", "cloud_usd_monthly");
  const start = new Date();
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  const event = payment(o, { subscription_id: "sub_test", starts_at: start.toISOString(), ends_at: end.toISOString(), amount_cents: 719 });
  const subscription = { event_id: randomUUID(), action_id: randomUUID(), kind: "subscription", order_id: o.id,
    subscription_id: "sub_test", occurred_at: new Date(start.getTime() - 1000).toISOString(), status: "active", cancel_at_period_end: false };
  await apply(o, subscription);
  assert.equal((await membership(id)).can_upload_cloud, false);
  await apply(o, event);
  await apply(o, { ...subscription, event_id: randomUUID(), action_id: randomUUID(), status: "canceled",
    occurred_at: new Date(start.getTime() + 1000).toISOString() });
  assert.equal((await membership(id)).status, "active");
  await apply(o, { ...subscription, event_id: randomUUID(), action_id: randomUUID() });
  const row = (await db.query("SELECT status FROM tokentracker_cloud_subscriptions WHERE user_id=$1", [id])).rows[0];
  assert.equal(row.status, "canceled");
  assert.equal((await payments(id)).length, 1);
});

test("Paddle cannot start a second subscription or replace an unexpired fixed term", async () => {
  const id = await user();
  const o = await order(id);
  await apply(o, payment(o));
  await assert.rejects(order(id, "paddle", "cloud_usd_yearly"), /fixed membership term/);
  const otherId = await user();
  const p = await order(otherId, "paddle", "cloud_usd_monthly");
  await apply(p, { event_id: randomUUID(), action_id: randomUUID(), kind: "subscription", order_id: p.id,
    subscription_id: "sub_other", occurred_at: new Date().toISOString(), status: "active" });
  await assert.rejects(order(otherId, "paddle", "cloud_usd_monthly"), /existing subscription/);
});

test("ownership RLS hides another account's orders and client roles cannot fulfill payments", async () => {
  const owner = await user();
  const stranger = await user();
  const o = await order(owner);
  await db.transaction(async tx => {
    await tx.exec("SET LOCAL ROLE authenticated");
    await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [stranger]);
    assert.equal((await tx.query("SELECT id FROM tokentracker_cloud_orders WHERE id=$1", [o.id])).rows.length, 0);
    const privileges = (await tx.query(`SELECT
      has_table_privilege('authenticated','tokentracker_cloud_orders','UPDATE') AS can_update,
      has_function_privilege('authenticated','cloud_apply_event(text,text,jsonb)','EXECUTE') AS can_apply,
      has_table_privilege('authenticated','tokentracker_cloud_events','SELECT') AS can_read_events`)).rows[0];
    assert.deepEqual(privileges, { can_update: false, can_apply: false, can_read_events: false });
  });
  await db.transaction(async tx => {
    await tx.exec("SET LOCAL ROLE authenticated");
    await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    assert.equal((await tx.query("SELECT id FROM tokentracker_cloud_orders WHERE id=$1", [o.id])).rows.length, 1);
  });
});

async function waffoUser() {
  const id = randomUUID();
  await waffoDb.query('INSERT INTO auth.users VALUES ($1)', [id]);
  return id;
}
async function waffoOrder(id, sku = 'cloud_usd_monthly_fixed', provider = 'waffo') {
  return (await waffoDb.query("SELECT cloud_create_order($1,'sandbox',$2,$3,$4) AS r", [id,provider,sku,randomUUID()])).rows[0].r;
}
async function attachWaffo(o, session = `cs_${randomUUID()}`, price = `PRD_${o.sku}`, url = 'https://test-checkout.example.test/pay') {
  return (await waffoDb.query('SELECT cloud_attach_waffo_checkout($1,$2,$3,$4,$5) AS r', [o.user_id,o.id,session,price,url])).rows[0].r;
}
function waffoPayment(o, overrides = {}) {
  const start = new Date();
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + o.term_months);
  const externalOrder = `ORD_${randomUUID().replaceAll('-', '')}`;
  return payment(o, {
    action_id: `PAY_${randomUUID().replaceAll('-', '')}`, waffo_order_id: externalOrder,
    provider_price_id: `PRD_${o.sku}`,
    ...(o.billing_mode === 'recurring' ? { subscription_id: externalOrder, period_number: 1, starts_at: start.toISOString(), ends_at: end.toISOString() } : {}),
    ...overrides,
  });
}
function waffoRefund(event, amount, overrides = {}) {
  return refund(event, amount, {
    action_id: `REF_${randomUUID().replaceAll('-', '')}`, waffo_order_id: event.waffo_order_id,
    provider_price_id: event.provider_price_id, subscription_id: event.subscription_id,
    ...overrides,
  });
}
async function applyWaffo(events, environment = 'sandbox') {
  return (await waffoDb.query('SELECT cloud_apply_waffo_events($1,$2) AS r', [environment,JSON.stringify(events)])).rows[0].r;
}
async function waffoPayments(id) {
  return (await waffoDb.query('SELECT * FROM tokentracker_cloud_payments WHERE user_id=$1 ORDER BY starts_at', [id])).rows;
}
async function waffoMembership(id) {
  return (await waffoDb.query("SELECT cloud_membership($1,'sandbox') AS r", [id])).rows[0].r;
}
async function recordWaffoPeriod(event, overrides = {}) {
  const e = {...event,...overrides};
  return (await waffoDb.query('SELECT cloud_record_waffo_period($1,$2,$3,$4,$5,$6,$7) AS r',
    [e.order_id,e.environment || 'sandbox',e.waffo_order_id,e.provider_price_id,e.period_number,e.starts_at,e.ends_at])).rows[0].r;
}

test('Waffo migration exposes four globally priced products while keeping live charging in preview', async () => {
  const id = await waffoUser();
  assert.equal((await waffoDb.query("SELECT phase FROM tokentracker_cloud_policy WHERE environment='live'")).rows[0].phase,'preview');
  assert.equal((await waffoDb.query("SELECT cloud_membership($1,'live') AS r",[id])).rows[0].r.status,'legacy_free');
  for (const sku of ['cloud_usd_monthly_fixed','cloud_usd_yearly_fixed','cloud_usd_monthly','cloud_usd_yearly']) {
    const o = await waffoOrder(id,sku);
    const catalog = (await waffoDb.query('SELECT * FROM tokentracker_cloud_catalog WHERE sku=$1',[sku])).rows[0];
    assert.equal(o.amount_cents,catalog.amount_cents);
    assert.equal(o.term_months,catalog.term_months);
    assert.equal(o.currency,catalog.currency);
  }
});

test('Waffo session, external order, and payment identities stay separate and immutable', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id);
  const attached = await attachWaffo(o);
  assert.match(attached.provider_checkout_id,/^cs_/);
  assert.equal(attached.provider_order_id,null);
  assert.equal(attached.waffo_order_id,null);
  await assert.rejects(attachWaffo(o,`cs_${randomUUID()}`),/different Waffo/);
  await assert.rejects(attachWaffo(o,attached.provider_checkout_id,'PRD_different'),/different Waffo/);
  await assert.rejects(attachWaffo(o,attached.provider_checkout_id,attached.provider_price_id,'https://test-checkout.example.test/other'),/different Waffo/);
  await assert.rejects(waffoDb.query('SELECT cloud_attach_waffo_checkout($1,$2,$3,$4,$5)',[await waffoUser(),o.id,attached.provider_checkout_id,attached.provider_price_id,attached.checkout_url]),/no rows/);
  await assert.rejects(waffoDb.query('SELECT cloud_attach_checkout($1,$2,$3,$4,$5)',[id,o.id,'PAY_wrong',attached.provider_price_id,attached.checkout_url]),/Waffo checkout binding/);
  const event = waffoPayment(o); await applyWaffo([event]);
  const persisted = (await waffoDb.query('SELECT * FROM tokentracker_cloud_orders WHERE id=$1',[o.id])).rows[0];
  assert.equal(persisted.provider_checkout_id,attached.provider_checkout_id);
  assert.equal(persisted.waffo_order_id,event.waffo_order_id);
  assert.equal(persisted.provider_order_id,event.action_id);
  assert.equal((await waffoPayments(id))[0].subscription_id,null);
});

test('Waffo payment survives an ambiguous checkout response after its product was bound', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id);
  const quoted = await attachWaffo(o,null,`PRD_${o.sku}`,null);
  assert.equal(quoted.provider_checkout_id,null);
  const event = waffoPayment(o); await applyWaffo([event]);
  assert.equal((await waffoMembership(id)).status,'active');
  const recovered = await attachWaffo(o);
  assert.equal(recovered.status,'paid');
  assert.equal(recovered.provider_order_id,event.action_id);
});

test('Waffo refunds, replays, and financial bindings commit or roll back as one batch', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id); await attachWaffo(o);
  const paid = waffoPayment(o);
  await assert.rejects(applyWaffo([paid,waffoRefund(paid,o.amount_cents+1)]),/invalid refund/);
  assert.equal((await waffoPayments(id)).length,0);
  assert.equal((await waffoDb.query('SELECT waffo_order_id FROM tokentracker_cloud_orders WHERE id=$1',[o.id])).rows[0].waffo_order_id,null);
  assert.equal((await waffoDb.query('SELECT count(*)::int n FROM tokentracker_cloud_events WHERE order_id=$1',[o.id])).rows[0].n,0);
  const partialAmount = Math.floor(o.amount_cents / 3);
  const partial = waffoRefund(paid,partialAmount);
  await applyWaffo([paid,partial]);
  await applyWaffo([paid,partial]);
  await applyWaffo([{...partial,event_id:randomUUID()}]);
  assert.equal((await waffoPayments(id))[0].refunded_cents,partialAmount);
  assert.equal((await waffoMembership(id)).status,'active');
  await applyWaffo([waffoRefund(paid,o.amount_cents-partialAmount)]);
  await applyWaffo([{...paid,event_id:randomUUID()}]);
  assert.equal((await waffoPayments(id)).length,1);
  assert.equal((await waffoMembership(id)).can_upload_cloud,false);
  await assert.rejects(applyWaffo([{...paid,amount_cents:1}]),/identifier.*different/);
});

test('Waffo rejects unbound products, changed amounts, environments, currencies, and external order reuse', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id); const paid = waffoPayment(o);
  await assert.rejects(applyWaffo([paid]),/bound order or product/);
  await attachWaffo(o);
  await assert.rejects(applyWaffo([{...paid,provider_price_id:'PRD_wrong'}]),/bound order or product/);
  await assert.rejects(applyWaffo([{...paid,amount_cents:o.amount_cents-1}]),/invalid paid amount/);
  await assert.rejects(applyWaffo([{...paid,base_amount_cents:1}]),/amount or currency/);
  await assert.rejects(applyWaffo([{...paid,currency:'CNY'}]),/amount or currency/);
  await assert.rejects(applyWaffo([paid],'live'),/provider or environment/);
  await applyWaffo([paid]);
  await assert.rejects(applyWaffo([{...paid,event_id:randomUUID(),waffo_order_id:'ORD_changed'}]),/bound order or product/);
  const other = await waffoOrder(await waffoUser()); await attachWaffo(other);
  await assert.rejects(applyWaffo([waffoPayment(other,{waffo_order_id:paid.waffo_order_id})]),/unique constraint/);
  assert.equal((await waffoPayments(other.user_id)).length,0);
  await assert.rejects(applyWaffo([waffoRefund(paid,1,{order_id:other.id,waffo_order_id:'ORD_other'})]),/refund does not match/);
});

test('Waffo cannot treat a session or external order as a payment, or a fixed term as a subscription', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id); await attachWaffo(o);
  const paid = waffoPayment(o);
  await assert.rejects(applyWaffo([{...paid,action_id:paid.waffo_order_id}]),/payment or refund identity/);
  await assert.rejects(applyWaffo([{...paid,waffo_order_id:`cs_${randomUUID()}`}]),/bound order or product/);
  await assert.rejects(applyWaffo([{...paid,subscription_id:paid.waffo_order_id}]),/billing mode/);
  await assert.rejects(applyWaffo([{...paid,kind:'subscription',status:'active'}]),/billing mode/);
  const recurring = await waffoOrder(await waffoUser(),'cloud_usd_monthly'); await attachWaffo(recurring);
  const subPaid = waffoPayment(recurring);
  await assert.rejects(applyWaffo([{...subPaid,subscription_id:'ORD_other'}]),/billing mode/);
  await assert.rejects(applyWaffo([{...subPaid,ends_at:new Date(Date.parse(subPaid.starts_at)+86400_000).toISOString()}]),/billing period/);
  await assert.rejects(waffoDb.query("SELECT cloud_apply_event('waffo','sandbox',$1)",[JSON.stringify({...subPaid,provider_price_id:'PRD_wrong'})]),/bound order or product/);
});

test('Waffo recurring charges retain the first payment identity and use each verified billing period once', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id,'cloud_usd_monthly'); await attachWaffo(o);
  const first = waffoPayment(o); await recordWaffoPeriod(first); await applyWaffo([first]);
  const nextEnd = new Date(first.ends_at); nextEnd.setUTCMonth(nextEnd.getUTCMonth()+1);
  const renewal = {...first,event_id:randomUUID(),action_id:`PAY_${randomUUID().replaceAll('-','')}`,
    starts_at:first.ends_at,ends_at:nextEnd.toISOString(),period_number:2};
  await recordWaffoPeriod(renewal);
  await applyWaffo([renewal]); await applyWaffo([{...renewal,event_id:randomUUID()}]);
  const rows = await waffoPayments(id);
  assert.equal(rows.length,2);
  assert.equal(rows[1].starts_at.toISOString(),first.ends_at);
  assert.equal(rows[1].ends_at.toISOString(),renewal.ends_at);
  assert.equal(rows[1].subscription_id,first.waffo_order_id);
  const persisted = (await waffoDb.query('SELECT provider_order_id,waffo_order_id FROM tokentracker_cloud_orders WHERE id=$1',[o.id])).rows[0];
  assert.equal(persisted.provider_order_id,first.action_id);
  assert.equal(persisted.waffo_order_id,first.waffo_order_id);
  await assert.rejects(applyWaffo([{...renewal,event_id:randomUUID(),currency:'CNY'}]),/action.*different/);
});

test('Waffo lifecycle grants no unpaid time and ignores late activation after cancellation', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id,'cloud_usd_monthly'); await attachWaffo(o);
  const paid = waffoPayment(o);
  const lifecycle = {...paid,event_id:randomUUID(),action_id:`${paid.waffo_order_id}:active`,kind:'subscription',
    occurred_at:new Date(Date.now()-1000).toISOString(),status:'active',cancel_at_period_end:false,next_billed_at:paid.ends_at};
  await applyWaffo([lifecycle]);
  assert.equal((await waffoMembership(id)).can_upload_cloud,false);
  await recordWaffoPeriod(paid);
  await applyWaffo([paid]);
  const canceled = {...lifecycle,event_id:randomUUID(),action_id:`${paid.waffo_order_id}:canceled`,status:'canceled',
    occurred_at:new Date().toISOString(),cancel_at_period_end:false,next_billed_at:null};
  await applyWaffo([canceled]);
  const late = await applyWaffo([{...lifecycle,event_id:randomUUID()}]);
  assert.equal(late.results[0].status,'outdated');
  assert.equal((await waffoMembership(id)).status,'active');
  const state = (await waffoDb.query('SELECT status,next_billed_at FROM tokentracker_cloud_subscriptions WHERE order_id=$1',[o.id])).rows[0];
  assert.equal(state.status,'canceled'); assert.equal(state.next_billed_at,null);
  const row = (await waffoPayments(id))[0];
  assert.equal(row.ends_at.toISOString(),paid.ends_at);
});

test('Paddle and Waffo cannot claim competing subscriptions even after an ambiguous checkout expires', async () => {
  for (const firstProvider of ['paddle','waffo']) {
    const id = await waffoUser();
    const first = await waffoOrder(id,'cloud_usd_monthly',firstProvider);
    const second = await waffoOrder(id,'cloud_usd_yearly',firstProvider === 'paddle' ? 'waffo' : 'paddle');
    const claim = o => waffoDb.query('SELECT cloud_claim_checkout($1,$2) AS r',[id,o.id]);
    assert.equal((await claim(first)).rows[0].r.claimed,true);
    await assert.rejects(claim(second),/existing checkout/);
    await waffoDb.query("UPDATE tokentracker_cloud_orders SET expires_at=now()-interval '1 minute' WHERE id=$1",[first.id]);
    await assert.rejects(claim(second),/existing checkout/);
    await waffoDb.query('SELECT cloud_close_unpaid_order($1,$2)',[id,first.id]);
    assert.equal((await claim(second)).rows[0].r.claimed,true);
  }
});

test('Waffo recurring purchases recheck newly paid terms and subscriptions at checkout claim', async () => {
  const id = await waffoUser();
  const recurring = await waffoOrder(id,'cloud_usd_yearly');
  const fixed = await waffoOrder(id); await attachWaffo(fixed); await applyWaffo([waffoPayment(fixed)]);
  await assert.rejects(waffoOrder(id,'cloud_usd_monthly'),/fixed membership term/);
  await assert.rejects(waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[id,recurring.id]),/fixed membership term/);
  const otherId = await waffoUser();
  const first = await waffoOrder(otherId,'cloud_usd_monthly'); await attachWaffo(first);
  const second = await waffoOrder(otherId,'cloud_usd_yearly','paddle');
  const paid = waffoPayment(first);
  await applyWaffo([{...paid,event_id:randomUUID(),kind:'subscription',status:'active'}]);
  await assert.rejects(waffoOrder(otherId,'cloud_usd_monthly','paddle'),/existing subscription/);
  await assert.rejects(waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[otherId,second.id]),/existing subscription/);
});

test('Waffo USD fixed purchases remain independent renewals and do not enter recurring checkout rules', async () => {
  const id = await waffoUser(); const first = await waffoOrder(id); const second = await waffoOrder(id,'cloud_usd_yearly_fixed');
  for (const o of [first,second]) {
    assert.equal((await waffoDb.query('SELECT cloud_claim_checkout($1,$2) AS r',[id,o.id])).rows[0].r.claimed,true);
    await attachWaffo(o); await applyWaffo([waffoPayment(o)]);
  }
  const rows = await waffoPayments(id);
  assert.equal(rows.length,2);
  assert.equal(rows[1].starts_at.getTime(),rows[0].ends_at.getTime());
  assert.equal((await waffoDb.query('SELECT count(*)::int n FROM tokentracker_cloud_subscriptions WHERE user_id=$1',[id])).rows[0].n,0);
});

test('a Waffo batch cannot smuggle a different owner and all tentative payments roll back', async () => {
  const first = await waffoOrder(await waffoUser()); const second = await waffoOrder(await waffoUser());
  await attachWaffo(first); await attachWaffo(second);
  await assert.rejects(applyWaffo([waffoPayment(first),waffoPayment(second)]),/one order/);
  assert.equal((await waffoPayments(first.user_id)).length,0);
  assert.equal((await waffoPayments(second.user_id)).length,0);
});

test('Waffo RPCs preserve server-only permissions and ownership RLS', async () => {
  const owner = await waffoUser(); const o = await waffoOrder(owner); const stranger = await waffoUser();
  const privileges = (await waffoDb.query(`SELECT
    has_function_privilege('authenticated','cloud_attach_waffo_checkout(uuid,uuid,text,text,text)','EXECUTE') AS can_attach,
    has_function_privilege('authenticated','cloud_apply_waffo_events(text,jsonb)','EXECUTE') AS can_apply,
    has_function_privilege('anon','cloud_apply_waffo_events(text,jsonb)','EXECUTE') AS anon_apply,
    has_function_privilege('project_admin','cloud_apply_waffo_events(text,jsonb)','EXECUTE') AS server_apply,
    has_function_privilege('project_admin','cloud_apply_event(text,text,jsonb)','EXECUTE') AS legacy_server_apply`)).rows[0];
  assert.deepEqual(privileges,{can_attach:false,can_apply:false,anon_apply:false,server_apply:true,legacy_server_apply:true});
  await waffoDb.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE authenticated');
    await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[stranger]);
    assert.equal((await tx.query('SELECT id FROM tokentracker_cloud_orders WHERE id=$1',[o.id])).rows.length,0);
  });
});

test('Waffo lifecycle period evidence is immutable, service-only, and grants no membership', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id,'cloud_usd_monthly'); await attachWaffo(o);
  const paid = waffoPayment(o);
  const cached = await recordWaffoPeriod(paid);
  assert.equal(cached.period_number,1);
  await recordWaffoPeriod(paid);
  assert.equal((await waffoMembership(id)).can_upload_cloud,false);
  assert.equal((await waffoPayments(id)).length,0);
  await assert.rejects(recordWaffoPeriod(paid,{starts_at:new Date(Date.parse(paid.starts_at)+1000).toISOString()}),/different dates/);
  await assert.rejects(recordWaffoPeriod(paid,{environment:'live'}),/bound order or product/);
  await assert.rejects(recordWaffoPeriod(paid,{provider_price_id:'PRD_other'}),/bound order or product/);
  await assert.rejects(recordWaffoPeriod(paid,{waffo_order_id:'ORD_other'}),/bound order or product/);
  await assert.rejects(recordWaffoPeriod(paid,{period_number:0}),/invalid Waffo subscription billing period/);
  const privileges = (await waffoDb.query(`SELECT
    has_table_privilege('authenticated','tokentracker_cloud_waffo_periods','SELECT') AS can_read,
    has_function_privilege('authenticated','cloud_record_waffo_period(uuid,text,text,text,integer,timestamptz,timestamptz)','EXECUTE') AS can_record,
    has_function_privilege('project_admin','cloud_record_waffo_period(uuid,text,text,text,integer,timestamptz,timestamptz)','EXECUTE') AS server_record`)).rows[0];
  assert.deepEqual(privileges,{can_read:false,can_record:false,server_record:true});
});

test('Waffo payments cannot reuse the current period for an older charge or invent its dates', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id,'cloud_usd_monthly'); await attachWaffo(o);
  const paid = waffoPayment(o);
  await assert.rejects(applyWaffo([paid]),/verified subscription billing period/);
  await recordWaffoPeriod(paid,{period_number:2});
  await assert.rejects(applyWaffo([paid]),/verified subscription billing period/);
  await assert.rejects(applyWaffo([{...paid,period_number:2,starts_at:new Date(Date.parse(paid.starts_at)+1000).toISOString()}]),/verified subscription billing period/);
  await recordWaffoPeriod(paid);
  await applyWaffo([paid]);
  assert.equal((await waffoPayments(id)).length,1);
  assert.equal((await waffoMembership(id)).status,'active');
});

test('Waffo fixed products never require recurring period evidence even with the same USD prices', async () => {
  const o = await waffoOrder(await waffoUser()); await attachWaffo(o);
  assert.equal(o.billing_mode,'fixed'); assert.equal(o.currency,'USD'); assert.equal(o.amount_cents,499);
  const paid = waffoPayment(o);
  await assert.rejects(recordWaffoPeriod(paid,{period_number:1,starts_at:new Date().toISOString(),ends_at:new Date(Date.now()+30*86400_000).toISOString()}),/bound order or product/);
  await applyWaffo([paid]);
  assert.equal((await waffoMembership(o.user_id)).status,'active');
  const active = (await waffoDb.query('SELECT sku,billing_mode,amount_cents FROM tokentracker_cloud_catalog WHERE active ORDER BY sku')).rows;
  assert.deepEqual(active.map(r=>r.amount_cents),[499,499,3999,3999]);
  await assert.rejects(waffoOrder(await waffoUser(),'cloud_cny_monthly'),/no longer available/);
  await assert.rejects(waffoOrder(await waffoUser(),'cloud_usd_monthly_fixed','paddle'),/currency/);
});

test('Waffo migration changes sellable catalog prices without repricing historical pending orders', async () => {
  const historical = await financialDatabase();
  try {
    const id = randomUUID(); await historical.query('INSERT INTO auth.users VALUES ($1)',[id]);
    const requestId = randomUUID();
    const oldOrder = (await historical.query("SELECT cloud_create_order($1,'sandbox','paddle','cloud_usd_monthly',$2) AS r",[id,requestId])).rows[0].r;
    await historical.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261007120000_cloud-waffo.sql'),'utf8'));
    const reused = (await historical.query("SELECT cloud_create_order($1,'sandbox','paddle','cloud_usd_monthly',$2) AS r",[id,requestId])).rows[0].r;
    assert.equal(reused.id,oldOrder.id); assert.equal(reused.amount_cents,599); assert.equal(reused.billing_mode,'recurring');
    assert.equal((await historical.query("SELECT amount_cents FROM tokentracker_cloud_catalog WHERE sku='cloud_usd_monthly'")).rows[0].amount_cents,499);
    const start = new Date(); const end = new Date(start); end.setUTCMonth(end.getUTCMonth()+1);
    const paid = payment(reused,{subscription_id:'sub_historical',starts_at:start.toISOString(),ends_at:end.toISOString()});
    await historical.query("SELECT cloud_apply_event('paddle','sandbox',$1)",[JSON.stringify(paid)]);
    assert.equal((await historical.query('SELECT amount_cents FROM tokentracker_cloud_payments WHERE order_id=$1',[oldOrder.id])).rows[0].amount_cents,599);
  } finally { await historical.close(); }
});

test('Waffo preserves the catalog base price while tracking tax-inclusive payments and refunds', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id); await attachWaffo(o);
  const tax = 50; const paid = waffoPayment(o,{amount_cents:o.amount_cents+tax});
  await applyWaffo([paid]);
  assert.equal((await waffoPayments(id))[0].amount_cents,o.amount_cents+tax);
  assert.equal((await waffoDb.query('SELECT amount_cents FROM tokentracker_cloud_orders WHERE id=$1',[o.id])).rows[0].amount_cents,o.amount_cents);
  await applyWaffo([waffoRefund(paid,o.amount_cents,{action_id:`RFD_${randomUUID().replaceAll('-','')}`})]);
  assert.equal((await waffoMembership(id)).status,'active');
  assert.equal((await waffoPayments(id))[0].refunded_cents,o.amount_cents);
  await applyWaffo([waffoRefund(paid,tax)]);
  assert.equal((await waffoMembership(id)).can_upload_cloud,false);
  assert.equal((await waffoPayments(id))[0].refunded_cents,o.amount_cents+tax);
});

test('Waffo fixed and recurring checkouts cannot both be claimed from competing windows', async () => {
  for (const firstMode of ['fixed','recurring']) {
    const id = await waffoUser();
    const first = await waffoOrder(id,firstMode === 'fixed' ? 'cloud_usd_monthly_fixed' : 'cloud_usd_monthly');
    const second = await waffoOrder(id,firstMode === 'fixed' ? 'cloud_usd_monthly' : 'cloud_usd_monthly_fixed');
    const claim = o => waffoDb.query('SELECT cloud_claim_checkout($1,$2) AS r',[id,o.id]);
    const results = await Promise.allSettled([claim(first),claim(second)]);
    assert.equal(results.filter(r=>r.status === 'fulfilled' && r.value.rows[0].r.claimed).length,1);
    const rejected = results.find(r=>r.status === 'rejected');
    assert.match(rejected.reason.message,/existing checkout/);
    const winner = results[0].status === 'fulfilled' ? first : second;
    const loser = winner.id === first.id ? second : first;
    await waffoDb.query('SELECT cloud_close_unpaid_order($1,$2)',[id,winner.id]);
    assert.equal((await claim(loser)).rows[0].r.claimed,true);
  }
});

test('fixed checkout claim rechecks a subscription activated after the order was prepared', async () => {
  const id = await waffoUser();
  const fixed = await waffoOrder(id); const recurring = await waffoOrder(id,'cloud_usd_monthly'); await attachWaffo(recurring);
  const paid = waffoPayment(recurring);
  const lifecycle = {...paid,event_id:randomUUID(),kind:'subscription',status:'active'};
  await applyWaffo([lifecycle]);
  await assert.rejects(waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[id,fixed.id]),/existing subscription/);
  await assert.rejects(waffoOrder(id),/existing subscription/);
  await applyWaffo([{...lifecycle,event_id:randomUUID(),status:'canceled',occurred_at:new Date(Date.now()+1000).toISOString()}]);
  assert.equal((await waffoDb.query('SELECT cloud_claim_checkout($1,$2) AS r',[id,fixed.id])).rows[0].r.claimed,true);
});

test('a fully refunded fixed purchase releases the paid-term gate for recurring checkout', async () => {
  const id = await waffoUser(); const recurring = await waffoOrder(id,'cloud_usd_monthly');
  const fixed = await waffoOrder(id); await attachWaffo(fixed); const paid = waffoPayment(fixed); await applyWaffo([paid]);
  await assert.rejects(waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[id,recurring.id]),/fixed membership term/);
  await applyWaffo([waffoRefund(paid,paid.amount_cents)]);
  assert.equal((await waffoDb.query('SELECT cloud_claim_checkout($1,$2) AS r',[id,recurring.id])).rows[0].r.claimed,true);
  const subscription = await waffoOrder(id,'cloud_usd_yearly');
  await assert.rejects(waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[id,subscription.id]),/existing checkout/);
});

test('recurring full refund preserves the subscription gate until verified cancellation', async () => {
  const id = await waffoUser(); const o = await waffoOrder(id,'cloud_usd_monthly'); await attachWaffo(o);
  const paid = waffoPayment(o); await recordWaffoPeriod(paid); await applyWaffo([paid]);
  await applyWaffo([waffoRefund(paid,paid.amount_cents)]);
  await assert.rejects(waffoOrder(id,'cloud_usd_monthly'),/existing subscription/);
  await applyWaffo([{...paid,event_id:randomUUID(),kind:'subscription',action_id:`${paid.waffo_order_id}:canceled`,status:'canceled',
    occurred_at:new Date(Date.now()+1000).toISOString(),next_billed_at:null}]);
  const next = await waffoOrder(id,'cloud_usd_monthly');
  assert.equal((await waffoDb.query('SELECT cloud_claim_checkout($1,$2) AS r',[id,next.id])).rows[0].r.claimed,true);
});

async function restartWaffo(o, externalId, requestId = randomUUID(), environment = 'sandbox', owner = o.user_id) {
  return (await waffoDb.query('SELECT cloud_restart_waffo_order($1,$2,$3,$4,$5) AS r',
    [owner,environment,o.id,requestId,externalId])).rows[0].r;
}
async function failedWaffoCheckout(id = undefined, sku = 'cloud_usd_monthly_fixed') {
  const o = await waffoOrder(id || await waffoUser(),sku);
  await waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[o.user_id,o.id]);
  await attachWaffo(o);
  return o;
}

test('concurrent restart requests create one successor and freeze the current catalog quote', async () => {
  const old = await failedWaffoCheckout(); const external = 'ORD_restartConcurrent';
  await waffoDb.query("UPDATE tokentracker_cloud_catalog SET amount_cents=549 WHERE sku='cloud_usd_monthly_fixed'");
  try {
    const requests = Array.from({length:5},()=>randomUUID());
    const results = await Promise.all(requests.map(request=>restartWaffo(old,external,request)));
    assert.equal(new Set(results.map(r=>r.order.id)).size,1);
    assert.equal(results.filter(r=>!r.reused).length,1);
    const next = results[0].order;
    assert.notEqual(next.id,old.id); assert.equal(next.sku,old.sku);
    assert.equal(next.amount_cents,549); assert.equal(next.billing_mode,'fixed');
    assert.equal(next.provider_order_id,null); assert.equal(next.waffo_order_id,null);
    assert.equal(next.provider_checkout_id,null); assert.equal(next.checkout_attempts,0);
    const stored = (await waffoDb.query('SELECT * FROM tokentracker_cloud_orders WHERE id=$1',[old.id])).rows[0];
    assert.equal(stored.status,'closed'); assert.equal(stored.retry_order_id,next.id);
    assert.equal(stored.amount_cents,499); assert.equal(stored.waffo_order_id,external);
    const repeated = await restartWaffo(old,external,requests[0]);
    assert.equal(repeated.reused,true); assert.equal(repeated.order.id,next.id);
    assert.equal((await waffoDb.query('SELECT count(*)::int n FROM tokentracker_cloud_orders WHERE user_id=$1',[old.user_id])).rows[0].n,2);
  } finally { await waffoDb.query("UPDATE tokentracker_cloud_catalog SET amount_cents=499 WHERE sku='cloud_usd_monthly_fixed'"); }
});

test('Waffo restart rejects paid orders including partial and complete refunds', async () => {
  for (const refundAmount of [0,100,499]) {
    const old = await failedWaffoCheckout(); const paid = waffoPayment(old);
    await applyWaffo([paid]);
    if (refundAmount) await applyWaffo([waffoRefund(paid,refundAmount)]);
    await waffoDb.query("UPDATE tokentracker_cloud_orders SET status='closed' WHERE id=$1",[old.id]);
    await assert.rejects(restartWaffo(old,paid.waffo_order_id),/paid Waffo order/);
    assert.equal((await waffoDb.query('SELECT retry_order_id FROM tokentracker_cloud_orders WHERE id=$1',[old.id])).rows[0].retry_order_id,null);
    assert.equal((await waffoDb.query('SELECT count(*)::int n FROM tokentracker_cloud_orders WHERE user_id=$1',[old.user_id])).rows[0].n,1);
  }
});

test('Waffo restart validates owner, environment, provider order, and quote before changing either order', async () => {
  const old = await failedWaffoCheckout(); const external = 'ORD_restartIdentity';
  await waffoDb.query('UPDATE tokentracker_cloud_orders SET waffo_order_id=$1 WHERE id=$2',[external,old.id]);
  await assert.rejects(restartWaffo(old,external,randomUUID(),'sandbox',await waffoUser()),/no rows/);
  await assert.rejects(restartWaffo(old,external,randomUUID(),'live'),/no rows/);
  await assert.rejects(restartWaffo(old,'ORD_wrong'),/unpaid bound order/);
  await assert.rejects(restartWaffo(old,null),/unpaid bound order/);
  const unbound = await waffoOrder(await waffoUser());
  await assert.rejects(restartWaffo(unbound,'ORD_unbound'),/unpaid bound order/);
  assert.equal((await waffoDb.query('SELECT status,retry_order_id FROM tokentracker_cloud_orders WHERE id=$1',[old.id])).rows[0].status,'ready');
  assert.equal((await waffoDb.query('SELECT count(*)::int n FROM tokentracker_cloud_orders WHERE user_id=$1',[old.user_id])).rows[0].n,1);
});

test('Waffo restart cannot hijack an existing request or ignore an uncanceled subscription', async () => {
  const old = await failedWaffoCheckout(); const another = await waffoOrder(old.user_id);
  await assert.rejects(restartWaffo(old,'ORD_requestConflict',another.request_id),/retry request.*another order/);
  const recurring = await failedWaffoCheckout(undefined,'cloud_usd_monthly'); const paid = waffoPayment(recurring);
  const lifecycle = {...paid,event_id:randomUUID(),kind:'subscription',status:'active',next_billed_at:paid.ends_at};
  await applyWaffo([lifecycle]);
  await assert.rejects(restartWaffo(recurring,paid.waffo_order_id),/existing subscription/);
  assert.equal((await waffoDb.query('SELECT status,retry_order_id FROM tokentracker_cloud_orders WHERE id=$1',[recurring.id])).rows[0].status,'ready');
  await applyWaffo([{...lifecycle,event_id:randomUUID(),status:'canceled',next_billed_at:null,occurred_at:new Date(Date.now()+1000).toISOString()}]);
  const next = await restartWaffo(recurring,paid.waffo_order_id);
  assert.equal(next.order.billing_mode,'recurring');
  assert.equal((await waffoDb.query('SELECT cloud_claim_checkout($1,$2) AS r',[recurring.user_id,next.order.id])).rows[0].r.claimed,true);
});

test('a late old payment before the successor claim stops retry even after a full refund', async () => {
  const old = await failedWaffoCheckout(); const paid = waffoPayment(old);
  const next = (await restartWaffo(old,paid.waffo_order_id)).order;
  const late = await applyWaffo([paid]);
  assert.equal(late.results[0].applied,true);
  assert.equal(late.results[0].retry_payment_conflict,false);
  await assert.rejects(waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[old.user_id,next.id]),/previous retry order.*successful payment/);
  await applyWaffo([waffoRefund(paid,paid.amount_cents)]);
  await assert.rejects(waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[old.user_id,next.id]),/previous retry order.*successful payment/);
  await assert.rejects(restartWaffo(old,paid.waffo_order_id),/unpaid bound order|paid Waffo order/);
  assert.equal((await waffoDb.query('SELECT checkout_attempts FROM tokentracker_cloud_orders WHERE id=$1',[next.id])).rows[0].checkout_attempts,0);
  assert.equal((await waffoPayments(old.user_id)).length,1);
});

test('a late old payment after a new checkout is claimed records a visible financial conflict without losing payments', async () => {
  const old = await failedWaffoCheckout(); const paid = waffoPayment(old);
  const next = (await restartWaffo(old,paid.waffo_order_id)).order;
  await waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[old.user_id,next.id]);
  await attachWaffo(next);
  const late = await applyWaffo([paid]);
  assert.equal(late.results[0].applied,true); assert.equal(late.results[0].retry_payment_conflict,true);
  await assert.rejects(waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[old.user_id,next.id]),/previous retry order.*successful payment/);
  const second = waffoPayment(next); const received = await applyWaffo([second]);
  assert.equal(received.results[0].retry_payment_conflict,true);
  assert.equal((await waffoPayments(old.user_id)).length,2);
  const flagged = (await waffoDb.query('SELECT retry_payment_conflict_at FROM tokentracker_cloud_orders WHERE user_id=$1',[old.user_id])).rows;
  assert.ok(flagged.every(r=>r.retry_payment_conflict_at instanceof Date));
  const repeated = await applyWaffo([paid]);
  assert.equal(repeated.results[0].duplicate,true); assert.equal(repeated.results[0].retry_payment_conflict,true);
  assert.equal((await waffoPayments(old.user_id)).length,2);
});

test('retry ancestry is preserved across multiple failed attempts and late payments flag only their owner', async () => {
  const old = await failedWaffoCheckout(); const paid = waffoPayment(old);
  const middle = (await restartWaffo(old,paid.waffo_order_id)).order;
  await waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[old.user_id,middle.id]); await attachWaffo(middle);
  const latest = (await restartWaffo(middle,'ORD_middleFailed')).order;
  await applyWaffo([paid]);
  await assert.rejects(waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[old.user_id,latest.id]),/previous retry order.*successful payment/);
  await assert.rejects(restartWaffo(middle,'ORD_middleFailed'),/paid Waffo order/);
  const unrelated = await failedWaffoCheckout(); await applyWaffo([waffoPayment(unrelated)]);
  assert.equal((await waffoDb.query('SELECT retry_payment_conflict_at FROM tokentracker_cloud_orders WHERE id=$1',[unrelated.id])).rows[0].retry_payment_conflict_at,null);
});

test('the Waffo restart RPC is server-only and successor foreign keys remain constrained', async () => {
  const privileges = (await waffoDb.query(`SELECT
    has_function_privilege('authenticated','cloud_restart_waffo_order(uuid,text,uuid,uuid,text)','EXECUTE') AS user_restart,
    has_function_privilege('anon','cloud_restart_waffo_order(uuid,text,uuid,uuid,text)','EXECUTE') AS anon_restart,
    has_function_privilege('project_admin','cloud_restart_waffo_order(uuid,text,uuid,uuid,text)','EXECUTE') AS server_restart`)).rows[0];
  assert.deepEqual(privileges,{user_restart:false,anon_restart:false,server_restart:true});
  const old = await failedWaffoCheckout(); const next = (await restartWaffo(old,'ORD_constraints')).order;
  await assert.rejects(waffoDb.query('UPDATE tokentracker_cloud_orders SET retry_order_id=id WHERE id=$1',[old.id]),/check constraint/);
  const another = await waffoOrder(await waffoUser());
  await assert.rejects(waffoDb.query('UPDATE tokentracker_cloud_orders SET retry_order_id=$1 WHERE id=$2',[next.id,another.id]),/unique constraint/);
});

test('a successor payment followed by a late predecessor payment preserves both ledgers under the service role', async () => {
  const old = await failedWaffoCheckout(); const paid = waffoPayment(old);
  const next = (await restartWaffo(old,paid.waffo_order_id)).order;
  await waffoDb.query('SELECT cloud_claim_checkout($1,$2)',[old.user_id,next.id]); await attachWaffo(next);
  const first = await applyWaffo([waffoPayment(next)]);
  assert.equal(first.results[0].retry_payment_conflict,false);
  const late = await waffoDb.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE project_admin');
    return (await tx.query("SELECT cloud_apply_waffo_events('sandbox',$1) AS r",[JSON.stringify([paid])])).rows[0].r;
  });
  assert.equal(late.results[0].retry_payment_conflict,true);
  assert.equal((await waffoPayments(old.user_id)).length,2);
  const rows = (await waffoDb.query('SELECT retry_payment_conflict_at FROM tokentracker_cloud_orders WHERE user_id=$1',[old.user_id])).rows;
  assert.ok(rows.every(r=>r.retry_payment_conflict_at instanceof Date));
});

async function attemptUser() {
  const id = randomUUID(); await attemptsDb.query('INSERT INTO auth.users VALUES ($1)',[id]); return id;
}
async function attemptOrder(owner = undefined, sku = 'cloud_usd_monthly_fixed') {
  const id = owner || await attemptUser();
  const o = (await attemptsDb.query("SELECT cloud_create_order($1,'sandbox','waffo',$2,$3) AS r",[id,sku,randomUUID()])).rows[0].r;
  await attemptsDb.query('SELECT cloud_attach_waffo_checkout($1,$2,$3,$4,$5)',[id,o.id,`cs_${randomUUID()}`,`PRD_${o.sku}`,'https://test-checkout.example.test/pay']);
  return o;
}
async function registerAttempt(o, external = `ORD_${randomUUID().replaceAll('-','')}`, overrides = {}) {
  const values = {order_id:o.id,environment:'sandbox',waffo_order_id:external,provider_price_id:`PRD_${o.sku}`,billing_mode:o.billing_mode,...overrides};
  return (await attemptsDb.query('SELECT cloud_register_waffo_attempt($1,$2,$3,$4,$5) AS r',
    [values.order_id,values.environment,values.waffo_order_id,values.provider_price_id,values.billing_mode])).rows[0].r;
}
async function attemptPeriod(event) {
  return (await attemptsDb.query('SELECT cloud_record_waffo_period($1,$2,$3,$4,$5,$6,$7) AS r',
    [event.order_id,'sandbox',event.waffo_order_id,event.provider_price_id,event.period_number,event.starts_at,event.ends_at])).rows[0].r;
}
async function attemptApply(events,environment = 'sandbox') {
  return (await attemptsDb.query('SELECT cloud_apply_waffo_events($1,$2) AS r',[environment,JSON.stringify(events)])).rows[0].r;
}
async function attemptPayments(o) {
  return (await attemptsDb.query('SELECT * FROM tokentracker_cloud_payments WHERE order_id=$1 ORDER BY paid_at,id',[o.id])).rows;
}
async function attemptStored(o) { return (await attemptsDb.query('SELECT * FROM tokentracker_cloud_orders WHERE id=$1',[o.id])).rows[0]; }
async function attemptRestart(o,ids,requestId=randomUUID()) {
  return (await attemptsDb.query("SELECT cloud_restart_waffo_attempts($1,'sandbox',$2,$3,$4) AS r",[o.user_id,o.id,requestId,ids])).rows[0].r;
}
function attemptLifecycle(paid,status='canceled',stamp=new Date().toISOString()) {
  return {...paid,kind:'subscription',event_id:randomUUID(),action_id:`${paid.waffo_order_id}:${status}:${stamp}`,
    status,occurred_at:stamp,next_billed_at:status==='active'?paid.ends_at:null,cancel_at_period_end:status==='canceling'};
}

test('Waffo registered replacement attempts leave canonical identity unset until actual money arrives', async () => {
  const o = await attemptOrder(undefined,'cloud_usd_monthly');
  const first = await registerAttempt(o); const replacement = await registerAttempt(o);
  const canceled = waffoPayment(o,{waffo_order_id:first.waffo_order_id,subscription_id:first.waffo_order_id});
  await attemptPeriod(canceled); await attemptApply([attemptLifecycle(canceled)]);
  assert.equal((await attemptStored(o)).waffo_order_id,null);
  assert.equal((await attemptStored(o)).provider_order_id,null);
  const paid = waffoPayment(o,{waffo_order_id:replacement.waffo_order_id,subscription_id:replacement.waffo_order_id});
  await attemptPeriod(paid); const received = await attemptApply([paid]);
  assert.equal(received.results[0].retry_payment_conflict,false);
  assert.equal((await attemptStored(o)).waffo_order_id,replacement.waffo_order_id);
  assert.equal((await attemptStored(o)).provider_order_id,paid.action_id);
  assert.equal((await attemptPayments(o))[0].waffo_order_id,replacement.waffo_order_id);
});

test('Waffo attempt registration independently checks product, mode, environment, and external owner', async () => {
  const o = await attemptOrder();
  const attempt = await registerAttempt(o);
  const again = await registerAttempt(o,attempt.waffo_order_id);
  assert.equal(again.created_at,attempt.created_at);
  await assert.rejects(registerAttempt(o,attempt.waffo_order_id,{provider_price_id:'PRD_wrong'}),/bound order, product, or billing mode/);
  await assert.rejects(registerAttempt(o,attempt.waffo_order_id,{billing_mode:'recurring'}),/bound order, product, or billing mode/);
  await assert.rejects(registerAttempt(o,attempt.waffo_order_id,{environment:'live'}),/bound order, product, or billing mode/);
  const other = await attemptOrder();
  await assert.rejects(registerAttempt(other,attempt.waffo_order_id),/different order, product, or billing mode/);
  const unknown = waffoPayment(o);
  await assert.rejects(attemptApply([unknown]),/bound order or product/);
  const paid = waffoPayment(o,{waffo_order_id:attempt.waffo_order_id});
  await assert.rejects(attemptApply([{...paid,provider_price_id:'PRD_wrong'}]),/bound order or product/);
  assert.equal((await attemptPayments(o)).length,0);
});

test('each Waffo ORD keeps its own period evidence even when replacement periods share a number', async () => {
  const o = await attemptOrder(undefined,'cloud_usd_monthly');
  const first = await registerAttempt(o); const second = await registerAttempt(o);
  const one = waffoPayment(o,{waffo_order_id:first.waffo_order_id,subscription_id:first.waffo_order_id});
  const start = new Date(Date.parse(one.starts_at)+7*86400_000); const end = new Date(start); end.setUTCMonth(end.getUTCMonth()+1);
  const two = waffoPayment(o,{waffo_order_id:second.waffo_order_id,subscription_id:second.waffo_order_id,starts_at:start.toISOString(),ends_at:end.toISOString()});
  await attemptPeriod(one); await attemptPeriod(two);
  const periods = (await attemptsDb.query('SELECT * FROM tokentracker_cloud_waffo_periods WHERE order_id=$1',[o.id])).rows;
  assert.equal(periods.length,2); assert.ok(periods.every(p=>p.period_number===1));
  await assert.rejects(attemptApply([{...two,starts_at:one.starts_at,ends_at:one.ends_at}]),/verified subscription billing period/);
  await attemptApply([one,two]);
  assert.equal((await attemptPayments(o)).length,2);
  assert.equal((await attemptStored(o)).waffo_order_id,first.waffo_order_id);
});

test('multiple real replacement payments stay in the ledger and flag conflicts without moving canonical IDs', async () => {
  const o = await attemptOrder(); const first = await registerAttempt(o); const second = await registerAttempt(o);
  const one = waffoPayment(o,{waffo_order_id:first.waffo_order_id});
  const two = waffoPayment(o,{waffo_order_id:second.waffo_order_id});
  await attemptApply([one]); const received = await attemptApply([two]);
  assert.equal(received.results[0].retry_payment_conflict,true);
  assert.equal((await attemptPayments(o)).length,2);
  assert.equal((await attemptStored(o)).waffo_order_id,first.waffo_order_id);
  assert.equal((await attemptStored(o)).provider_order_id,one.action_id);
  await attemptApply([two]); assert.equal((await attemptPayments(o)).length,2);
  await assert.rejects(attemptOrder(o.user_id),/payment conflict/);
  const gate = (await attemptsDb.query('SELECT cloud_apply_event($1,$2,$3) AS r',
    ['waffo','sandbox',JSON.stringify(two)])).rows[0].r;
  assert.equal(gate.duplicate,true); assert.equal(gate.retry_payment_conflict,true);
  await assert.rejects(attemptRestart(o,[first.waffo_order_id,second.waffo_order_id]),/unpaid bound order|paid Waffo/);
});

test('Waffo fixed double charges within one ORD are retained while recurring renewals are not flagged', async () => {
  const fixed = await attemptOrder(); const attempt = await registerAttempt(fixed);
  const one = waffoPayment(fixed,{waffo_order_id:attempt.waffo_order_id});
  const two = {...one,event_id:randomUUID(),action_id:`PAY_${randomUUID().replaceAll('-','')}`};
  await attemptApply([one,two]); assert.equal((await attemptPayments(fixed)).length,2);
  assert.ok((await attemptStored(fixed)).retry_payment_conflict_at instanceof Date);
  const recurring = await attemptOrder(undefined,'cloud_usd_monthly'); const recurringAttempt = await registerAttempt(recurring);
  const paid = waffoPayment(recurring,{waffo_order_id:recurringAttempt.waffo_order_id,subscription_id:recurringAttempt.waffo_order_id});
  const end = new Date(paid.ends_at);end.setUTCMonth(end.getUTCMonth()+1);
  const renewal = {...paid,event_id:randomUUID(),action_id:`PAY_${randomUUID().replaceAll('-','')}`,
    starts_at:paid.ends_at,ends_at:end.toISOString(),period_number:2};
  await attemptPeriod(paid); await attemptPeriod(renewal); await attemptApply([paid,renewal]);
  assert.equal((await attemptPayments(recurring)).length,2);
  assert.equal((await attemptStored(recurring)).retry_payment_conflict_at,null);
});

test('Waffo refunds match their real payment attempt rather than the canonical first-paid ORD', async () => {
  const o = await attemptOrder(); const first = await registerAttempt(o); const second = await registerAttempt(o);
  const one = waffoPayment(o,{waffo_order_id:first.waffo_order_id});
  const two = waffoPayment(o,{waffo_order_id:second.waffo_order_id});
  await attemptApply([one,two]);
  const refundTwo = waffoRefund(two,two.amount_cents);
  await assert.rejects(attemptApply([{...refundTwo,waffo_order_id:first.waffo_order_id}]),/refund does not match/);
  await attemptApply([refundTwo]);
  const payments = await attemptPayments(o);
  assert.equal(payments.find(p=>p.transaction_id===one.action_id).refunded_cents,0);
  assert.equal(payments.find(p=>p.transaction_id===two.action_id).refunded_cents,two.amount_cents);
  assert.equal((await attemptStored(o)).waffo_order_id,first.waffo_order_id);
});

test('every still-renewing replacement subscription blocks a new purchase independently', async () => {
  const o = await attemptOrder(undefined,'cloud_usd_monthly'); const first = await registerAttempt(o); const second = await registerAttempt(o);
  const one = waffoPayment(o,{waffo_order_id:first.waffo_order_id,subscription_id:first.waffo_order_id});
  const two = waffoPayment(o,{waffo_order_id:second.waffo_order_id,subscription_id:second.waffo_order_id});
  await attemptApply([attemptLifecycle(one),attemptLifecycle(two,'active')]);
  assert.equal((await attemptStored(o)).waffo_order_id,null);
  await assert.rejects(attemptOrder(o.user_id),/existing subscription/);
  await attemptApply([attemptLifecycle(two,'canceled',new Date(Date.now()+1000).toISOString())]);
  const next = await attemptOrder(o.user_id);
  assert.equal(next.billing_mode,'fixed');
  assert.equal((await attemptsDb.query('SELECT status FROM tokentracker_cloud_subscriptions WHERE order_id=$1',[o.id])).rows.length,2);
});

test('Waffo bundle restart requires every registered ORD and never invents canonical payment identity', async () => {
  const o = await attemptOrder(); const first = await registerAttempt(o); const second = await registerAttempt(o);
  await assert.rejects(attemptRestart(o,[]),/invalid verified/);
  await assert.rejects(attemptRestart(o,[first.waffo_order_id]),/complete registered/);
  await assert.rejects(attemptRestart(o,[first.waffo_order_id,'ORD_wrong']),/complete registered/);
  await assert.rejects(attemptsDb.query("SELECT cloud_restart_waffo_order($1,'sandbox',$2,$3,$4)",
    [o.user_id,o.id,randomUUID(),first.waffo_order_id]),/complete registered/);
  const results = await Promise.all(Array.from({length:4},()=>attemptRestart(o,[second.waffo_order_id,first.waffo_order_id,first.waffo_order_id])));
  assert.equal(new Set(results.map(r=>r.order.id)).size,1);
  assert.equal(results.filter(r=>!r.reused).length,1);
  assert.equal((await attemptStored(o)).waffo_order_id,null);
  assert.equal((await attemptStored(o)).provider_order_id,null);
  const paid = waffoPayment(o,{waffo_order_id:first.waffo_order_id}); await attemptApply([paid]);
  await assert.rejects(attemptsDb.query('SELECT cloud_claim_checkout($1,$2)',[o.user_id,results[0].order.id]),/previous retry order.*successful payment/);
  assert.equal((await attemptPayments(o)).length,1);
});

test('official replacement payments and separate app-order retries share the existing late-payment protection', async () => {
  const o = await attemptOrder(); const one = await registerAttempt(o); const two = await registerAttempt(o);
  const next = (await attemptRestart(o,[one.waffo_order_id,two.waffo_order_id])).order;
  await attemptsDb.query('SELECT cloud_claim_checkout($1,$2)',[o.user_id,next.id]);
  await attemptsDb.query('SELECT cloud_attach_waffo_checkout($1,$2,$3,$4,$5)',[next.user_id,next.id,`cs_${randomUUID()}`,`PRD_${next.sku}`,'https://test-checkout.example.test/pay']);
  const nextAttempt = await registerAttempt(next);
  const received = await attemptApply([waffoPayment(o,{waffo_order_id:two.waffo_order_id})]);
  assert.equal(received.results[0].retry_payment_conflict,true);
  await attemptApply([waffoPayment(next,{waffo_order_id:nextAttempt.waffo_order_id})]);
  assert.equal((await attemptsDb.query('SELECT count(*)::int n FROM tokentracker_cloud_payments WHERE user_id=$1',[o.user_id])).rows[0].n,2);
  assert.ok((await attemptStored(o)).retry_payment_conflict_at instanceof Date);
  assert.ok((await attemptStored(next)).retry_payment_conflict_at instanceof Date);
});

test('Waffo attempt registration, period evidence, and restart bundles remain server-only', async () => {
  const permissions = (await attemptsDb.query(`SELECT
    has_table_privilege('authenticated','tokentracker_cloud_waffo_attempts','SELECT') AS can_read,
    has_function_privilege('authenticated','cloud_register_waffo_attempt(uuid,text,text,text,text)','EXECUTE') AS can_register,
    has_function_privilege('anon','cloud_restart_waffo_attempts(uuid,text,uuid,uuid,text[])','EXECUTE') AS anon_restart,
    has_function_privilege('project_admin','cloud_register_waffo_attempt(uuid,text,text,text,text)','EXECUTE') AS server_register,
    has_function_privilege('project_admin','cloud_restart_waffo_attempts(uuid,text,uuid,uuid,text[])','EXECUTE') AS server_restart`)).rows[0];
  assert.deepEqual(permissions,{can_read:false,can_register:false,anon_restart:false,server_register:true,server_restart:true});
  const o = await attemptOrder(); const registered = await attemptsDb.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE project_admin');
    return (await tx.query("SELECT cloud_register_waffo_attempt($1,'sandbox','ORD_serviceRole',$2,'fixed') AS r",[o.id,`PRD_${o.sku}`])).rows[0].r;
  });
  const event = waffoPayment(o,{waffo_order_id:registered.waffo_order_id});
  await attemptsDb.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE project_admin');
    const applied = (await tx.query("SELECT cloud_apply_waffo_events('sandbox',$1) AS r",[JSON.stringify([event])])).rows[0].r;
    assert.equal(applied.results[0].applied,true);
  });
});

test('attempt migration backfills existing paid and unpaid attempts without losing periods or retry links', async () => {
  const historical = await financialDatabase(true);
  try {
    const create = async sku => {
      const id = randomUUID(); await historical.query('INSERT INTO auth.users VALUES ($1)',[id]);
      const order = (await historical.query("SELECT cloud_create_order($1,'sandbox','waffo',$2,$3) AS r",[id,sku,randomUUID()])).rows[0].r;
      await historical.query('SELECT cloud_attach_waffo_checkout($1,$2,$3,$4,$5)',[id,order.id,`cs_${randomUUID()}`,`PRD_${sku}`,'https://test-checkout.example.test/pay']);
      return order;
    };
    const oldApply = e => historical.query("SELECT cloud_apply_waffo_events('sandbox',$1)",[JSON.stringify([e])]);
    const paidOrder = await create('cloud_usd_monthly_fixed'); const paid = waffoPayment(paidOrder); await oldApply(paid);
    await oldApply(waffoRefund(paid,100));
    const refundedOrder = await create('cloud_usd_monthly_fixed'); const refunded = waffoPayment(refundedOrder);
    await oldApply(refunded); await oldApply(waffoRefund(refunded,refunded.amount_cents));
    const pending = await create('cloud_usd_monthly'); const phase = waffoPayment(pending);
    await historical.query("SELECT cloud_record_waffo_period($1,'sandbox',$2,$3,$4,$5,$6)",
      [phase.order_id,phase.waffo_order_id,phase.provider_price_id,phase.period_number,phase.starts_at,phase.ends_at]);
    await oldApply(attemptLifecycle(phase));
    const failed = await create('cloud_usd_monthly_fixed'); const failedId = 'ORD_historicalFailed';
    const successor = (await historical.query("SELECT cloud_restart_waffo_order($1,'sandbox',$2,$3,$4) AS r",
      [failed.user_id,failed.id,randomUUID(),failedId])).rows[0].r.order;
    await historical.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261007140000_cloud-waffo-attempts.sql'),'utf8'));
    for (const event of [paid,refunded]) {
      const payment = (await historical.query('SELECT * FROM tokentracker_cloud_payments WHERE transaction_id=$1',[event.action_id])).rows[0];
      assert.equal(payment.waffo_order_id,event.waffo_order_id);
      assert.equal((await historical.query('SELECT waffo_order_id FROM tokentracker_cloud_orders WHERE id=$1',[event.order_id])).rows[0].waffo_order_id,event.waffo_order_id);
    }
    assert.equal((await historical.query('SELECT refunded_cents FROM tokentracker_cloud_payments WHERE transaction_id=$1',[refunded.action_id])).rows[0].refunded_cents,refunded.amount_cents);
    assert.equal((await historical.query('SELECT refunded_cents FROM tokentracker_cloud_payments WHERE transaction_id=$1',[paid.action_id])).rows[0].refunded_cents,100);
    assert.equal((await historical.query('SELECT waffo_order_id FROM tokentracker_cloud_orders WHERE id=$1',[pending.id])).rows[0].waffo_order_id,null);
    assert.equal((await historical.query('SELECT count(*)::int n FROM tokentracker_cloud_waffo_periods WHERE order_id=$1',[pending.id])).rows[0].n,1);
    assert.equal((await historical.query('SELECT retry_order_id,waffo_order_id FROM tokentracker_cloud_orders WHERE id=$1',[failed.id])).rows[0].retry_order_id,successor.id);
    assert.equal((await historical.query('SELECT retry_order_id,waffo_order_id FROM tokentracker_cloud_orders WHERE id=$1',[failed.id])).rows[0].waffo_order_id,null);
    const attempts = (await historical.query('SELECT waffo_order_id FROM tokentracker_cloud_waffo_attempts')).rows.map(r=>r.waffo_order_id);
    for (const external of [paid.waffo_order_id,refunded.waffo_order_id,phase.waffo_order_id,failedId]) assert.ok(attempts.includes(external));
    const replacement = 'ORD_historicalReplacement';
    await historical.query("SELECT cloud_register_waffo_attempt($1,'sandbox',$2,$3,'recurring')",[pending.id,replacement,`PRD_${pending.sku}`]);
    const newPaid = waffoPayment(pending,{waffo_order_id:replacement,subscription_id:replacement});
    await historical.query("SELECT cloud_record_waffo_period($1,'sandbox',$2,$3,$4,$5,$6)",
      [newPaid.order_id,newPaid.waffo_order_id,newPaid.provider_price_id,newPaid.period_number,newPaid.starts_at,newPaid.ends_at]);
    await oldApply(newPaid);
    assert.equal((await historical.query('SELECT waffo_order_id FROM tokentracker_cloud_orders WHERE id=$1',[pending.id])).rows[0].waffo_order_id,replacement);
    await oldApply(waffoRefund(paid,paid.amount_cents-100));
    assert.equal((await historical.query('SELECT refunded_cents FROM tokentracker_cloud_payments WHERE transaction_id=$1',[paid.action_id])).rows[0].refunded_cents,paid.amount_cents);
  } finally { await historical.close(); }
});

test('Waffo complete restart bundles accept paginated cohorts above one hundred and stop at one thousand', async () => {
  const o = await attemptOrder();
  const ids = Array.from({length:101},(_,index)=>`ORD_bulk${String(index).padStart(4,'0')}`);
  await Promise.all(ids.map(id=>registerAttempt(o,id)));
  const next = await attemptRestart(o,ids);
  assert.notEqual(next.order.id,o.id); assert.equal(next.reused,false);
  assert.equal((await attemptStored(o)).waffo_order_id,null);
  await assert.rejects(attemptRestart(o,Array.from({length:1001},(_,index)=>`ORD_excess${index}`)),/invalid verified/);
  const replay = await attemptRestart(o,ids);
  assert.equal(replay.reused,true); assert.equal(replay.order.id,next.order.id);
});

test('Waffo sandbox accelerated paid periods preserve exact dates without enabling current uploads, while live geometry stays strict',async()=>{
  const isolated=await financialDatabase(true,true);
  try {
    await isolated.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261007160000_cloud-waffo-sandbox-periods.sql'),'utf8'));
    await isolated.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261008120000_self-hosted-access.sql'),'utf8'));
    await isolated.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=clock_timestamp() WHERE environment='live'");
    const create=async environment=>{
      const owner=randomUUID();await isolated.query('INSERT INTO auth.users VALUES($1)',[owner]);
      const o=(await isolated.query("SELECT cloud_create_order($1,$2,'waffo','cloud_usd_yearly',$3) AS r",[owner,environment,randomUUID()])).rows[0].r;
      const price='PROD_sandboxVerified';const external='ORD_'+randomUUID().replaceAll('-','');
      await isolated.query('SELECT cloud_attach_waffo_checkout($1,$2,NULL,$3,NULL)',[owner,o.id,price]);
      await isolated.query("SELECT cloud_register_waffo_attempt($1,$2,$3,$4,'recurring')",[o.id,environment,external,price]);
      return {...o,price,external};
    };
    const start='2027-10-07T17:08:25.000Z';const end='2027-10-07T17:22:06.000Z';
    const sandbox=await create('sandbox');
    await isolated.query('SELECT cloud_record_waffo_period($1,$2,$3,$4,3,$5,$6)',[sandbox.id,'sandbox',sandbox.external,sandbox.price,start,end]);
    const paid=o=>({...payment(o),action_id:'PAY_'+randomUUID().replaceAll('-',''),waffo_order_id:o.external,
      provider_price_id:o.price,subscription_id:o.external,period_number:3,starts_at:start,ends_at:end});
    const event=paid(sandbox);
    await isolated.query("SELECT cloud_apply_waffo_events('sandbox',$1)",[JSON.stringify([event])]);
    const row=(await isolated.query('SELECT starts_at,ends_at,amount_cents FROM tokentracker_cloud_payments WHERE order_id=$1',[sandbox.id])).rows[0];
    assert.equal(row.starts_at.toISOString(),start);assert.equal(row.ends_at.toISOString(),end);assert.equal(row.amount_cents,3999);
    const state=(await isolated.query("SELECT cloud_membership($1,'sandbox') AS r",[sandbox.user_id])).rows[0].r;
    assert.equal(state.can_upload_cloud,false);assert.equal(state.expires_at,null);assert.notEqual(state.status,'active');
    assert.equal(state.can_read_cloud,false);assert.equal(state.read_only_until,null);
    await assert.rejects(isolated.query('SELECT cloud_record_waffo_period($1,$2,$3,$4,4,$5,$6)',
      [sandbox.id,'sandbox',sandbox.external,sandbox.price,start,start]),/invalid Waffo subscription billing period/);
    await assert.rejects(isolated.query('SELECT cloud_record_waffo_period($1,$2,$3,$4,4,$5,$6)',
      [sandbox.id,'sandbox',sandbox.external,sandbox.price,start,'2030-10-07T17:22:06.000Z']),/invalid Waffo subscription billing period/);
    await assert.rejects(isolated.query('SELECT cloud_record_waffo_period($1,$2,$3,$4,3,$5,$6)',
      [sandbox.id,'sandbox',sandbox.external,sandbox.price,start,'2027-10-07T17:23:06.000Z']),/different dates/);
    const live=await create('live');
    await assert.rejects(isolated.query('SELECT cloud_record_waffo_period($1,$2,$3,$4,3,$5,$6)',
      [live.id,'live',live.external,live.price,start,end]),/invalid Waffo subscription billing period/);
    await isolated.query("INSERT INTO tokentracker_cloud_waffo_periods(order_id,environment,waffo_order_id,period_number,starts_at,ends_at) VALUES($1,'live',$2,3,$3,$4)",
      [live.id,live.external,start,end]);
    await assert.rejects(isolated.query("SELECT cloud_apply_waffo_events('live',$1)",[JSON.stringify([paid(live)])]),/invalid subscription billing period/);
    assert.equal((await isolated.query('SELECT count(*)::int n FROM tokentracker_cloud_payments WHERE order_id=$1',[live.id])).rows[0].n,0);
  } finally {await isolated.close();}
});

test('a future payment cannot extend an already-started refunded membership read-only grace',async()=>{
  const isolated=await financialDatabase(true,true);
  try {
    await isolated.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261007160000_cloud-waffo-sandbox-periods.sql'),'utf8'));
    await isolated.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261008120000_self-hosted-access.sql'),'utf8'));
    const owner=randomUUID();await isolated.query('INSERT INTO auth.users VALUES($1)',[owner]);
    const o=(await isolated.query("SELECT cloud_create_order($1,'sandbox','waffo','cloud_usd_monthly',$2) AS r",[owner,randomUUID()])).rows[0].r;
    const price='PROD_futureGrace';const external='ORD_futureGrace';
    await isolated.query('SELECT cloud_attach_waffo_checkout($1,$2,NULL,$3,NULL)',[owner,o.id,price]);
    await isolated.query("SELECT cloud_register_waffo_attempt($1,'sandbox',$2,$3,'recurring')",[o.id,external,price]);
    const start=new Date(Date.now()-86400_000);const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
    const current={...payment(o),action_id:'PAY_currentGrace',waffo_order_id:external,provider_price_id:price,
      subscription_id:external,period_number:1,starts_at:start.toISOString(),ends_at:end.toISOString()};
    await isolated.query("SELECT cloud_record_waffo_period($1,'sandbox',$2,$3,1,$4,$5)",[o.id,external,price,current.starts_at,current.ends_at]);
    await isolated.query("SELECT cloud_apply_waffo_events('sandbox',$1)",[JSON.stringify([current])]);
    const refunded=waffoRefund(current,current.amount_cents);
    await isolated.query("SELECT cloud_apply_waffo_events('sandbox',$1)",[JSON.stringify([refunded])]);
    const member=()=>isolated.query("SELECT cloud_membership($1,'sandbox') AS r",[owner]);
    const before=(await member()).rows[0].r;assert.equal(before.can_read_cloud,true);assert.equal(before.can_upload_cloud,false);
    const future={...current,event_id:randomUUID(),action_id:'PAY_futureGrace',period_number:2,
      starts_at:'2027-10-07T17:08:25.000Z',ends_at:'2027-10-07T17:22:06.000Z'};
    await isolated.query("SELECT cloud_record_waffo_period($1,'sandbox',$2,$3,2,$4,$5)",[o.id,external,price,future.starts_at,future.ends_at]);
    await isolated.query("SELECT cloud_apply_waffo_events('sandbox',$1)",[JSON.stringify([future])]);
    const after=(await member()).rows[0].r;
    assert.equal(after.can_upload_cloud,false);assert.equal(after.can_read_cloud,true);assert.equal(after.read_only_until,before.read_only_until);
    await isolated.query("UPDATE tokentracker_cloud_payments SET revoked_at=clock_timestamp()-interval '31 days' WHERE transaction_id='PAY_currentGrace'");
    const expired=(await member()).rows[0].r;assert.equal(expired.can_read_cloud,false);assert.equal(expired.can_upload_cloud,false);
    assert.equal((await isolated.query('SELECT count(*)::int n FROM tokentracker_cloud_payments WHERE user_id=$1',[owner])).rows[0].n,2);
  } finally {await isolated.close();}
});
