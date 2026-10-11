const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

let db;
const migration = name => fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8');
test.before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
    CREATE TABLE tokentracker_devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,
      device_name text NOT NULL,platform text,machine_id text,revoked_at timestamptz,
      name_customized boolean NOT NULL DEFAULT false,default_device_name text,created_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX active_machine ON tokentracker_devices(user_id,machine_id) WHERE revoked_at IS NULL;
    CREATE UNIQUE INDEX active_name ON tokentracker_devices(user_id,platform,device_name) WHERE revoked_at IS NULL;
    CREATE TABLE tokentracker_device_machine(device_id uuid PRIMARY KEY,machine_cluster_id text);
    CREATE TABLE tokentracker_device_tokens(id uuid PRIMARY KEY,user_id uuid,device_id uuid,token_hash text UNIQUE,
      revoked_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE tokentracker_device_codes(device_code text PRIMARY KEY,user_code text UNIQUE,status text,
      user_id uuid,expires_at timestamptz,approved_at timestamptz,client_info text,machine_id text);
    CREATE TABLE tokentracker_user_settings(user_id uuid PRIMARY KEY,leaderboard_anonymous boolean DEFAULT false);
    GRANT USAGE ON SCHEMA auth TO project_admin;
    GRANT SELECT(id) ON auth.users TO project_admin;
    GRANT SELECT ON tokentracker_user_settings TO project_admin;
    GRANT ALL ON tokentracker_devices,tokentracker_device_machine,tokentracker_device_tokens,tokentracker_device_codes TO project_admin;`);
  const { functionSql } = require('./helpers/cloud-usage-archive-fixture');
  await db.exec(functionSql(migration('20260719152022_harden-backend-concurrency.sql'),'refresh_tokentracker_device_identity'));
  for (const name of ['20261003120000_cloud-subscriptions.sql', '20261004120000_cloud-machine-access.sql', '20261007120000_cloud-waffo.sql',
    '20261007130000_cloud-waffo-retry.sql', '20261007140000_cloud-waffo-attempts.sql',
    '20261007150000_cloud-waffo-authorizations.sql', '20261007160000_cloud-waffo-sandbox-periods.sql',
    '20261008120000_self-hosted-access.sql', '20261008150000_cloud-pro-badges.sql',
    '20261009120000_cloud-gifts.sql', '20261010225755_cloud-device-safety-cap.sql']) await db.exec(migration(name));
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now()-interval '1 hour'");
});
test.after(async () => db?.close());
async function rpc(name, args) {
  return (await db.query(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS r`, args)).rows[0].r;
}
async function user() {
  const id = randomUUID(); await db.query('INSERT INTO auth.users VALUES($1)', [id]); return id;
}
function code() {
  const hex = randomBytes(16).toString('hex').toUpperCase();
  return { code_hash: createHash('sha256').update('TTPRO' + hex).digest('hex'), suffix: hex.slice(-8) };
}
async function batch(days = 30, environment = 'sandbox', count = 1) {
  const codes = Array.from({ length: count }, code), id = randomUUID();
  const args = [environment, id, days, new Date(Date.now() + 86400000).toISOString(), 'Contributor gifts', JSON.stringify(codes)];
  const result = await rpc('cloud_create_gift_batch', args);
  return { ...result, args, codes };
}
const redeem = (id, value, environment = 'sandbox', request = randomUUID()) =>
  rpc('cloud_redeem_gift', [id, environment, value?.code_hash || value || null, request]);
const member = (id, environment = 'sandbox') => rpc('cloud_membership', [id, environment]);
const account = (id, environment = 'sandbox') => rpc('cloud_gift_account', [id, environment]);
async function historical(id, startsAt, endsAt, environment = 'sandbox') {
  const b = await batch(30, environment), c = (await rpc('cloud_list_gift_codes', [environment, b.id, 1000]))[0];
  const starts = startsAt || new Date(Date.now() - 31 * 86400000).toISOString();
  const end = endsAt || new Date(Date.parse(starts) + 30 * 86400000).toISOString();
  const r = await db.query(`INSERT INTO tokentracker_cloud_gift_grants(code_id,user_id,environment,request_id,duration_days,starts_at,ends_at)
    VALUES($1,$2,$3,$4,30,$5,$6) RETURNING id`, [c.id,id,environment,randomUUID(),starts,end]);
  return r.rows[0].id;
}
async function pay(id, { environment = 'sandbox', days = 30, future = false } = {}) {
  const order = await rpc('cloud_create_order', [id,environment,'waffo','cloud_usd_monthly_fixed',randomUUID()]);
  // A verified provider event, not subscription metadata, creates the paid interval.
  await rpc('cloud_attach_waffo_checkout', [id,order.id,null,'PRD_gift_test',null]);
  const binding = 'ORD_' + randomBytes(12).toString('hex');
  await rpc('cloud_register_waffo_attempt', [order.id,environment,binding,'PRD_gift_test','fixed']);
  const start = new Date(Date.now() + (future ? 86400000 : -1000)), end = new Date(start.getTime() + days * 86400000);
  const event = { event_id: randomUUID(), kind: 'payment', action_id: 'PAY_' + randomBytes(12).toString('hex'),
    order_id: order.id, occurred_at: new Date().toISOString(), currency: 'USD', amount_cents: order.amount_cents,
    base_amount_cents: order.amount_cents, provider_price_id: 'PRD_gift_test', waffo_order_id: binding,
    billing_mode: 'fixed', starts_at: start.toISOString(), ends_at: end.toISOString() };
  await rpc('cloud_apply_waffo_events', [environment,JSON.stringify([event])]);
  const period = (await db.query('SELECT starts_at::text,ends_at::text FROM tokentracker_cloud_payments WHERE order_id=$1',[order.id])).rows[0];
  return { order, event, period };
}

test('batch creation is exact-idempotent, bounded and never returns a raw code or hash in lists', async () => {
  const b = await batch(90, 'sandbox', 3);
  assert.deepEqual(await rpc('cloud_create_gift_batch', b.args), { id:b.id,environment:'sandbox',count:3,reused:true });
  const reordered = [...b.args]; reordered[5] = JSON.stringify([...b.codes].reverse());
  assert.equal((await rpc('cloud_create_gift_batch', reordered)).reused,true);
  const changed = [...b.args]; changed[4] = 'Changed';
  await assert.rejects(rpc('cloud_create_gift_batch', changed), /conflicts/);
  const invalid = [...b.args]; invalid[1] = randomUUID(); invalid[5] = JSON.stringify([{...code(),raw_code:'forbidden'}]);
  await assert.rejects(rpc('cloud_create_gift_batch', invalid), /invalid gift batch codes/);
  await assert.rejects(rpc('cloud_create_gift_batch', ['sandbox',randomUUID(),7,b.args[3],'No',JSON.stringify([code()])]), /invalid gift batch/);
  await assert.rejects(rpc('cloud_create_gift_batch', ['sandbox',randomUUID(),30,b.args[3],'No','[]']), /invalid gift batch/);
  await assert.rejects(rpc('cloud_list_gift_batches', ['sandbox',101]), /invalid gift list/);
  const list = await rpc('cloud_list_gift_batches', ['sandbox',100]);
  assert.equal(list.find(row=>row.id===b.id).code_count,3);
  const codes = await rpc('cloud_list_gift_codes', ['sandbox',b.id,1000]);
  assert.equal(codes.length,3); assert.ok(codes.every(c=>!('code_hash' in c)&&!('code' in c)));
  assert.deepEqual(await rpc('cloud_list_gift_codes',['live',b.id,1000]),[]);
});

test('a gift immediately grants full Pro with an independent immutable ledger and no financial rows', async () => {
  const id = await user(), b = await batch(30), result = await redeem(id,b.codes[0]);
  assert.equal(result.ok,true); assert.equal(result.reused,false); assert.equal(result.gift.state,'active');
  assert.equal(Date.parse(result.gift.ends_at)-Date.parse(result.gift.starts_at),30*86400000);
  assert.equal(result.membership.status,'active'); assert.equal(result.membership.access_source,'gift');
  assert.equal(result.membership.has_gift,true); assert.equal(result.membership.trial_available,false);
  assert.equal(result.membership.machine_limit,99); assert.equal(result.membership.sync_interval_seconds,900);
  assert.equal(result.membership.hourly_history_days,90); assert.equal(result.membership.daily_history_months,24);
  assert.equal((await account(id)).gifts[0].id,result.gift.id);
  for (const table of ['orders','payments','subscriptions','events']) {
    assert.equal((await db.query(`SELECT count(*) AS n FROM tokentracker_cloud_${table} WHERE user_id=$1`, [id]).catch(async error=>{
      if (table!=='events') throw error;
      return db.query('SELECT count(*) AS n FROM tokentracker_cloud_events WHERE order_id IN (SELECT id FROM tokentracker_cloud_orders WHERE user_id=$1)',[id]);
    })).rows[0].n,0);
  }
  await assert.rejects(db.query('UPDATE tokentracker_cloud_gift_grants SET user_id=$1 WHERE id=$2',[await user(),result.gift.id]),/history is immutable/);
});

test('one code has one owner; queued concurrent retries return one grant even after disable or expiry', async () => {
  const id = await user(), other = await user(), b = await batch();
  const results = await Promise.all(Array.from({length:6},()=>redeem(id,b.codes[0])));
  assert.equal(new Set(results.map(r=>r.gift.id)).size,1); assert.equal(results.filter(r=>!r.reused).length,1);
  assert.equal((await redeem(other,b.codes[0])).code,'gift_code_unavailable');
  const disabled = await rpc('cloud_disable_gift_batch',['sandbox',b.id]);
  assert.deepEqual(await rpc('cloud_disable_gift_batch',['sandbox',b.id]),disabled);
  await db.query("UPDATE tokentracker_cloud_gift_batches SET redeem_before=now()-interval '1 day' WHERE id=$1",[b.id]);
  const retry = await redeem(id,b.codes[0]); assert.equal(retry.reused,true); assert.equal(retry.gift.ends_at,results[0].gift.ends_at);
});

test('unclaimed disabled, expired and wrong-environment codes use one generic error', async () => {
  const id = await user(), b = await batch(), expired = await batch(), live = await batch(365,'live');
  await rpc('cloud_disable_gift_batch',['sandbox',b.id]);
  await db.query("UPDATE tokentracker_cloud_gift_batches SET redeem_before=now()-interval '1 day' WHERE id=$1",[expired.id]);
  for (const c of [b.codes[0],expired.codes[0],live.codes[0],null,code()]) {
    const r = await redeem(id,c); assert.equal(r.status,400); assert.equal(r.code,'gift_code_unavailable');
  }
  assert.equal((await redeem(id,live.codes[0],'live')).ok,true);
  assert.equal((await member(id,'sandbox')).status,'free');
});

test('failed attempts persist through business failures and are limited per actor and environment', async () => {
  const id = await user(), b = await batch();
  for (let i=0;i<10;i++) assert.equal((await redeem(id,null)).status,400);
  const blocked = await redeem(id,b.codes[0]); assert.equal(blocked.status,429); assert.ok(blocked.retry_after>0&&blocked.retry_after<=900);
  assert.equal((await db.query('SELECT failed_attempts FROM tokentracker_cloud_gift_attempts WHERE user_id=$1 AND environment=$2',[id,'sandbox'])).rows[0].failed_attempts,10);
  assert.equal((await redeem(await user(),b.codes[0])).ok,true);
  assert.equal((await redeem(id,null,'live')).status,400);
  await db.query("UPDATE tokentracker_cloud_gift_attempts SET window_started_at=now()-interval '16 minutes' WHERE user_id=$1 AND environment='sandbox'",[id]);
  assert.equal((await redeem(id,(await batch()).codes[0])).ok,true);
});

test('paid fixed terms and successive gifts queue contiguously without consuming trial or transition time', async () => {
  const id = await user(), paid = await pay(id), first = await redeem(id,(await batch()).codes[0]);
  assert.equal(Date.parse(first.gift.starts_at),Date.parse(paid.period.ends_at)); assert.equal(first.gift.state,'pending');
  assert.equal(first.membership.access_source,'payment'); assert.equal(first.membership.expires_at,first.gift.ends_at);
  const next = await redeem(id,(await batch(90)).codes[0]); assert.equal(next.gift.starts_at,first.gift.ends_at);
  const trial = await user(); await rpc('cloud_start_trial',[trial,'sandbox']);
  const trialGift = await redeem(trial,(await batch()).codes[0]);
  assert.equal(trialGift.gift.state,'active'); assert.equal(trialGift.membership.access_source,'gift');
  assert.ok(Date.parse(trialGift.gift.starts_at)<Date.parse(trialGift.membership.trial_ends_at));
  const transition = await user();
  await db.query("INSERT INTO tokentracker_devices(id,user_id,device_name,created_at) VALUES($1,$2,'Existing device',now()-interval '5 days')",[randomUUID(),transition]);
  assert.equal((await member(transition)).status,'transition');
  assert.equal((await redeem(transition,(await batch()).codes[0])).gift.state,'active');
});

test('a later refund leaves gift dates unchanged and cannot bridge the refunded paid gap', async () => {
  const id = await user(), paid = await pay(id), gift = await redeem(id,(await batch()).codes[0]);
  await rpc('cloud_apply_waffo_events',['sandbox',JSON.stringify([{event_id:randomUUID(),kind:'refund',action_id:'REF_'+randomBytes(12).toString('hex'),
    order_id:paid.order.id,occurred_at:new Date().toISOString(),transaction_id:paid.event.action_id,
    currency:'USD',amount_cents:paid.order.amount_cents,waffo_order_id:paid.event.waffo_order_id,provider_price_id:'PRD_gift_test'}])]);
  const after = await member(id); assert.equal(after.status,'expired'); assert.equal(after.can_upload_cloud,false);
  assert.equal(after.has_gift,true); assert.equal(after.access_source,'none');
  const record = (await account(id)).gifts[0]; assert.equal(record.starts_at,gift.gift.starts_at); assert.equal(record.ends_at,gift.gift.ends_at);
});

test('renewal and pending checkout restrictions do not consume codes or hide capability', async () => {
  const id = await user(), order = await rpc('cloud_create_order',[id,'sandbox','waffo','cloud_usd_monthly',randomUUID()]);
  const b = await batch();
  assert.equal((await account(id)).gift_redemption_available,true); assert.equal((await account(id)).redemption_restriction,'gift_checkout_pending');
  assert.equal((await redeem(id,b.codes[0])).code,'gift_checkout_pending');
  await db.query("UPDATE tokentracker_cloud_orders SET expires_at=now()-interval '1 hour' WHERE id=$1",[order.id]);
  assert.equal((await redeem(id,b.codes[0])).code,'gift_checkout_pending','TTL does not prove provider settlement is impossible');
  await db.query("UPDATE tokentracker_cloud_orders SET status='closed' WHERE id=$1",[order.id]);
  await db.query(`INSERT INTO tokentracker_cloud_subscriptions(provider,environment,provider_subscription_id,user_id,order_id,status,last_event_at)
    VALUES('waffo','sandbox',$1,$2,$3,'active',now())`,['SUB_'+randomUUID(),id,order.id]);
  assert.equal((await redeem(id,b.codes[0])).code,'gift_requires_renewal_cancel');
  assert.equal((await account(id)).redemption_restriction,'gift_requires_renewal_cancel');
  await db.query('UPDATE tokentracker_cloud_subscriptions SET cancel_at_period_end=true WHERE user_id=$1',[id]);
  assert.equal((await redeem(id,b.codes[0])).ok,true);
});

test('active or scheduled gifts block both checkout entry points and all trial retries', async () => {
  const id = await user(), request = randomUUID(), old = await rpc('cloud_create_order',[id,'sandbox','waffo','cloud_usd_monthly_fixed',request]);
  await db.query("UPDATE tokentracker_cloud_orders SET status='closed' WHERE id=$1",[old.id]);
  await redeem(id,(await batch()).codes[0]);
  for (const sku of ['cloud_usd_monthly','cloud_usd_monthly_fixed']) {
    await assert.rejects(rpc('cloud_create_order',[id,'sandbox','waffo',sku,randomUUID()]),/gift_membership_active/);
  }
  await assert.rejects(rpc('cloud_create_order',[id,'sandbox','waffo','cloud_usd_monthly_fixed',request]),/gift_membership_active/);
  await assert.rejects(rpc('cloud_claim_checkout',[id,old.id]),/gift_membership_active/);
  await assert.rejects(rpc('cloud_start_trial',[id,'sandbox']),/before the first purchase or gift/);
  const scheduled = await user(); await historical(scheduled,new Date(Date.now()+86400000).toISOString());
  await assert.rejects(rpc('cloud_create_order',[scheduled,'sandbox','waffo','cloud_usd_monthly_fixed',randomUUID()]),/gift_membership_active/);
});

test('expiry and revocation give read grace only to intervals that actually began', async () => {
  const expired = await user(); await historical(expired);
  let state = await member(expired); assert.equal(state.status,'expired'); assert.equal(state.can_upload_cloud,false); assert.equal(state.can_read_cloud,true);
  const old = await user(); await historical(old,new Date(Date.now()-62*86400000).toISOString());
  assert.equal((await member(old)).can_read_cloud,false);
  const active = await user(), result = await redeem(active,(await batch()).codes[0]);
  const revoked = await rpc('cloud_revoke_gift',['sandbox',result.gift.id]);
  assert.deepEqual(await rpc('cloud_revoke_gift',['sandbox',result.gift.id]),revoked);
  state = await member(active); assert.equal(state.status,'expired'); assert.equal(state.can_upload_cloud,false); assert.equal(state.can_read_cloud,true);
  assert.equal(state.has_gift,false); assert.equal(state.trial_available,false);
  const future = await user(), futureId = await historical(future,new Date(Date.now()+86400000).toISOString());
  await rpc('cloud_revoke_gift',['sandbox',futureId]);
  state = await member(future); assert.equal(state.status,'free'); assert.equal(state.can_read_cloud,false); assert.equal(state.read_only_until,null);
});

test('gift entitlement reaches actual device issuance and the 99-machine safety guard', async () => {
  const id = await user(), free = await user();
  const issue = actor => rpc('cloud_issue_device_token',[actor,'sandbox','Contributor '+randomUUID(),'web',randomUUID(),[],randomUUID(),randomBytes(32).toString('hex'),false,null]);
  assert.equal((await issue(free)).ok,true,'free accounts keep their community device');
  assert.equal((await issue(free)).code,'cloud_machine_limit');
  const result = await redeem(id,(await batch()).codes[0]);
  for (let i=0;i<99;i++) assert.equal((await issue(id)).ok,true);
  assert.equal((await issue(id)).code,'cloud_machine_limit');
  const access = await rpc('cloud_account_access',[id,'sandbox','hourly']);
  assert.equal(access.ok,true); assert.equal(access.membership.access_source,'gift');
  await rpc('cloud_revoke_gift',['sandbox',result.gift.id]);
  assert.equal((await issue(id)).code,'cloud_machine_limit');
  assert.equal((await rpc('cloud_account_access',[id,'sandbox','hourly'])).membership.can_upload_cloud,false);
});

test('badge reflects current gifts, anonymous and environment policy boundaries, never ranking', async () => {
  const id = await user(), result = await redeem(id,(await batch()).codes[0]);
  assert.deepEqual(await rpc('cloud_pro_badges',[[id],'sandbox']),{[id]:true});
  assert.deepEqual(await rpc('cloud_pro_badges',[[id],'live']),{});
  await db.query('INSERT INTO tokentracker_user_settings VALUES($1,true)',[id]);
  assert.deepEqual(await rpc('cloud_pro_badges',[[id],'sandbox']),{});
  await db.query('UPDATE tokentracker_user_settings SET leaderboard_anonymous=false WHERE user_id=$1',[id]);
  await rpc('cloud_revoke_gift',['sandbox',result.gift.id]);
  assert.deepEqual(await rpc('cloud_pro_badges',[[id],'sandbox']),{});
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='preview' WHERE environment='sandbox'");
  try {
    assert.equal((await account(id)).gift_redemption_available,false);
    assert.equal((await redeem(await user(),(await batch()).codes[0])).code,'gift_not_available');
  } finally { await db.exec("UPDATE tokentracker_cloud_policy SET phase='active' WHERE environment='sandbox'"); }
});

test('self hosted remains free and all gift RPCs and tables are unavailable to client roles', async () => {
  const id = await user(); await db.exec("UPDATE tokentracker_cloud_policy SET hosting_mode='self_hosted' WHERE environment='live'");
  try {
    assert.equal((await member(id,'live')).status,'self_hosted'); assert.equal((await account(id,'live')).gift_redemption_available,false);
    assert.equal((await redeem(id,(await batch(30,'live')).codes[0],'live')).code,'gift_not_available');
    await db.exec('ALTER TABLE tokentracker_user_settings RENAME TO isolated_profile_settings');
    try { assert.deepEqual(await rpc('cloud_pro_badges',[[id],'live']),{}); }
    finally { await db.exec('ALTER TABLE isolated_profile_settings RENAME TO tokentracker_user_settings'); }
  } finally { await db.exec("UPDATE tokentracker_cloud_policy SET hosting_mode='hosted' WHERE environment='live'"); }
  for (const role of ['anon','authenticated']) {
    await db.exec('SET ROLE '+role);
    try {
      await assert.rejects(redeem(id,code()),/permission denied/);
      await assert.rejects(account(id),/permission denied/);
      await assert.rejects(rpc('cloud_list_gift_batches',['sandbox',10]),/permission denied/);
      await assert.rejects(rpc('cloud_create_order_before_gifts',[id,'sandbox','waffo','cloud_usd_monthly',randomUUID()]),/permission denied/);
      for (const table of ['batches','codes','grants','attempts']) {
        await assert.rejects(db.query('SELECT * FROM tokentracker_cloud_gift_'+table),/permission denied/);
      }
    } finally { await db.exec('RESET ROLE'); }
  }
});
