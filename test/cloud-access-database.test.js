const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
let db;
const migration = name => fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8');
before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
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
    CREATE TABLE tokentracker_hourly(user_id uuid,device_id uuid,hour_start timestamptz,source text,model text,
      input_tokens bigint,cached_input_tokens bigint,cache_creation_input_tokens bigint,output_tokens bigint,
      reasoning_output_tokens bigint,total_tokens bigint CHECK(total_tokens>=0),billable_total_tokens bigint,
      conversations integer,total_cost_usd numeric,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
      PRIMARY KEY(user_id,device_id,hour_start,source,model));
    GRANT ALL ON tokentracker_devices,tokentracker_device_machine,tokentracker_device_tokens,
      tokentracker_device_codes,tokentracker_hourly TO project_admin;
  `);
  const hardening = migration('20260719152022_harden-backend-concurrency.sql');
  await db.exec(hardening.slice(hardening.indexOf('CREATE OR REPLACE FUNCTION public.refresh_tokentracker_device_identity('),
    hardening.indexOf('-- One-time', hardening.indexOf('CREATE OR REPLACE FUNCTION public.refresh_tokentracker_device_identity(')))
    .split('CREATE TABLE public.tt_')[0]);
  const sessions = migration('20260817120000_account-session-states.sql');
  await db.exec(sessions.slice(0,sessions.indexOf('-- Leaderboard: account-level sources')));
  await db.exec(migration('20261003120000_cloud-subscriptions.sql'));
  await db.exec(migration('20261004120000_cloud-machine-access.sql'));
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now() WHERE environment='sandbox'");
});
after(async () => { await db?.close(); });
async function rpc(name, args) {
  return (await db.query(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS result`,args)).rows[0].result;
}
async function user(trial=true) {
  const id=randomUUID(); await db.query('INSERT INTO auth.users VALUES($1)',[id]);
  if(trial) await rpc('cloud_start_trial',[id,'sandbox']);
  return id;
}
async function issue(id, machine=randomUUID(), options={}) {
  const token=randomUUID();
  const result=await rpc('cloud_issue_device_token',[id,options.env||'sandbox',options.name||'Device '+machine.slice(0,8),
    options.platform||'web',machine,options.names||[options.name||'Device '+machine.slice(0,8)],randomUUID(),token,false,null]);
  return {...result,token};
}
const list=(id,env='sandbox',current=null)=>rpc('cloud_list_machines',[id,env,current]);
const row=(tokens=100)=>({hour_start:'2026-10-01T12:00:00Z',source:'codex',model:'gpt-6',input_tokens:tokens,
  cached_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:tokens,
  billable_total_tokens:tokens,total_cost_usd:0,conversations:1});
const state=(tokens,stamp,model='a')=>({source:'trae-cn',session_id:'session-1',model,bucket_start:'2026-10-01T12:00:00Z',
  input_tokens:tokens,output_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,reasoning_output_tokens:0,
  total_tokens:tokens,snapshot_verified_at:stamp});
const ingest=(token,rows=[row()],states=[],uploadId=null,env='sandbox')=>rpc('cloud_ingest_usage',[token,env,JSON.stringify(rows),JSON.stringify(states),uploadId]);
async function expire(id,days) {
  await db.query("UPDATE tokentracker_cloud_accounts SET trial_started_at=now()-make_interval(days=>$2::int+7),trial_ends_at=now()-make_interval(days=>$2::int) WHERE user_id=$1",[id,days]);
}

test('preview keeps unlimited legacy enrollment, upload frequency, and private ranges',async()=>{
  const id=await user(false);
  for(let i=0;i<7;i++) assert.equal((await issue(id,randomUUID(),{env:'live'})).ok,true);
  const device=await issue(id,randomUUID(),{env:'live'});
  assert.equal((await list(id,'live')).machine_count,8);
  assert.equal((await rpc('cloud_account_access',[id,'live','hourly'])).available_from,null);
  assert.equal((await ingest(device.token,[row()],[],null,'live')).ok,true);
  assert.equal((await ingest(device.token,[row(80)],[],randomUUID(),'live')).ok,true);
});

test('the online token constraint protects new writes before historical validation',async()=>{
  const id=await user(false);
  await issue(id,randomUUID(),{env:'live'});
  const validated=async()=> (await db.query("SELECT convalidated FROM pg_constraint WHERE conname='tokentracker_device_tokens_cloud_environment_fkey'")).rows[0].convalidated;
  assert.equal(await validated(),false);
  await assert.rejects(db.query("UPDATE tokentracker_device_tokens SET cloud_environment='unknown' WHERE user_id=$1",[id]),/violates foreign key constraint/);
  assert.equal((await db.query('SELECT cloud_environment FROM tokentracker_device_tokens WHERE user_id=$1',[id])).rows[0].cloud_environment,'live');
  await db.transaction(async tx=>{await tx.exec(migration('20261008120001_validate-cloud-token-environment.sql'));});
  assert.equal(await validated(),true);
});

test('client roles cannot enroll, remove devices, fulfill usage, or read another slot table',async()=>{
  await db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE authenticated');
    assert.deepEqual((await tx.query(`SELECT
      has_function_privilege('authenticated','cloud_issue_device_token(uuid,text,text,text,text,text[],uuid,text,boolean,text)','EXECUTE') AS issue,
      has_function_privilege('authenticated','cloud_ingest_usage(text,text,jsonb,jsonb,text)','EXECUTE') AS ingest,
      has_function_privilege('authenticated','cloud_remove_machine(uuid,text,uuid)','EXECUTE') AS remove,
      has_table_privilege('authenticated','tokentracker_cloud_machines','SELECT') AS read`)).rows[0],
      {issue:false,ingest:false,remove:false,read:false});
  });
});

test('parallel admission accepts five slots and refuses the sixth without creating a device',async()=>{
  const id=await user();
  const results=await Promise.all(Array.from({length:9},()=>issue(id)));
  assert.equal(results.filter(r=>r.ok).length,5);
  assert.equal(results.filter(r=>r.code==='cloud_machine_limit').length,4);
  assert.equal((await list(id)).machine_count,5);
  assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_devices WHERE user_id=$1',[id])).rows[0].n,5);
  const old=results.find(r=>r.ok);
  const machine=(await db.query('SELECT machine_id FROM tokentracker_devices WHERE id=$1',[old.device_id])).rows[0].machine_id;
  const reused=await issue(id,machine,{name:'Renamed host'});
  assert.equal(reused.ok,true); assert.equal(reused.machine_id,old.machine_id);
  assert.equal((await list(id)).machine_count,5);
});

test('legacy adoption and renamed default names reuse the occupied slot at quota',async()=>{
  const id=await user(); const legacy=randomUUID();
  await db.query(`INSERT INTO tokentracker_devices(id,user_id,device_name,platform,name_customized,default_device_name)
    VALUES($1,$2,'My custom laptop','web',true,'Token Tracker')`,[legacy,id]);
  const prior=(await list(id)).machines[0];
  for(let i=0;i<4;i++) await issue(id);
  const adopted=await issue(id,'old-seeded-identity',{name:'New hostname',names:['New hostname','Token Tracker']});
  assert.equal(adopted.ok,true);assert.equal(adopted.device_id,legacy);assert.equal(adopted.machine_id,prior.machine_id);
  assert.equal((await db.query('SELECT device_name FROM tokentracker_devices WHERE id=$1',[legacy])).rows[0].device_name,'My custom laptop');
  assert.equal((await list(id)).machine_count,5);
});

test('cluster changes and component merges retain the oldest opaque slot and historical aliases',async()=>{
  const id=await user();const a=await issue(id);const b=await issue(id);
  await db.query('INSERT INTO tokentracker_device_machine VALUES($1,$2),($3,$2)',[a.device_id,'cluster-old',b.device_id]);
  let result=await list(id); assert.equal(result.machine_count,1); const stable=result.machines[0].machine_id;
  await db.query("UPDATE tokentracker_device_machine SET machine_cluster_id='cluster-new' WHERE device_id IN ($1,$2)",[a.device_id,b.device_id]);
  result=await list(id);assert.equal(result.machine_count,1);assert.equal(result.machines[0].machine_id,stable);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_machine_aliases WHERE user_id=$1 AND kind='cluster'",[id])).rows[0].n,2);
});

test('explicit removal revokes old tokens and background issuance cannot reactivate the machine',async()=>{
  const id=await user();const raw='stable-machine-seed';const issued=await issue(id,raw);
  assert.equal((await ingest(issued.token)).ok,true);
  const removed=await rpc('cloud_remove_machine',[id,'sandbox',issued.machine_id]);
  assert.equal(removed.machine_count,0);assert.equal(removed.machines[0].status,'paused');
  assert.equal((await ingest(issued.token)).code,'cloud_device_token_rejected');
  assert.equal((await issue(id,raw)).code,'cloud_machine_paused');
  assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_hourly WHERE user_id=$1',[id])).rows[0].n,1);
  assert.equal((await rpc('cloud_resume_machine',[id,'sandbox',issued.machine_id])).ok,true);
  assert.equal((await ingest(issued.token)).code,'cloud_device_token_rejected');
  assert.equal((await issue(id,raw)).ok,true);
  const stranger=await user();
  assert.equal((await rpc('cloud_remove_machine',[stranger,'sandbox',issued.machine_id])).code,'cloud_machine_not_found');
});

test('expiry gives thirty days of bounded read/export access and only daily community uploads',async()=>{
  const id=await user();const d=await issue(id);
  await expire(id,1);
  const access=await rpc('cloud_account_access',[id,'sandbox','daily']);
  assert.equal(access.ok,true);assert.equal(access.membership.status,'expired');assert.equal(access.membership.can_upload_cloud,false);
  assert.match(access.available_from,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await ingest(d.token,[row()],[],randomUUID())).upload_scope,'community');
  assert.equal((await ingest(d.token,[row(120)],[],randomUUID())).code,'cloud_sync_throttled');
  await expire(id,31);
  assert.equal((await rpc('cloud_account_access',[id,'sandbox','daily'])).code,'cloud_read_only_expired');
  const free=await user(false);assert.equal((await rpc('cloud_account_access',[free,'sandbox','daily'])).code,'cloud_membership_required');
});

test('bounded upload leases permit backfill but reject another round and more than the allowed batches',async()=>{
  const id=await user();const d=await issue(id);const run=randomUUID();
  assert.equal((await ingest(d.token,[row()],[],run)).ok,true);
  assert.equal((await ingest(d.token,[row(90)],[],run)).ok,true);
  let blocked=await ingest(d.token,[row(80)],[],randomUUID());
  assert.equal(blocked.code,'cloud_sync_throttled');assert.ok(blocked.retry_after_seconds<=900 && blocked.retry_after_seconds>890);
  await db.query('UPDATE tokentracker_cloud_machines SET upload_batch_count=100 WHERE id=$1',[d.machine_id]);
  assert.equal((await ingest(d.token,[row(70)],[],run)).code,'cloud_sync_throttled');
  await db.query("UPDATE tokentracker_cloud_machines SET last_upload_at=now()-interval '16 minutes',upload_window_until=now()-interval '15 minutes' WHERE id=$1",[d.machine_id]);
  assert.equal((await ingest(d.token,[row(60)],[],randomUUID())).ok,true);
  assert.equal((await ingest(d.token,Array.from({length:501},()=>row()),[],run)).code,'cloud_upload_size_exceeded');
});

test('hourly whole-row LWW, batch MAX, and strictly newer session corrections are retained atomically',async()=>{
  const id=await user();const d=await issue(id);const run=randomUUID();
  const newer='2026-10-01T14:00:00Z',older='2026-10-01T13:00:00Z';
  assert.equal((await ingest(d.token,[row(10),row(100)],[state(100,newer)],run)).ok,true);
  assert.equal((await ingest(d.token,[row(60)],[state(20,older,'old')],run)).ok,true);
  assert.equal((await db.query('SELECT total_tokens FROM tokentracker_hourly WHERE user_id=$1',[id])).rows[0].total_tokens,60);
  let stored=(await db.query('SELECT total_tokens,model FROM tokentracker_account_session_states WHERE user_id=$1',[id])).rows[0];
  assert.deepEqual(stored,{total_tokens:100,model:'a'});
  await ingest(d.token,[],[state(40,'2026-10-01T15:00:00Z','b')],run);
  stored=(await db.query('SELECT total_tokens,model FROM tokentracker_account_session_states WHERE user_id=$1',[id])).rows[0];
  assert.deepEqual(stored,{total_tokens:40,model:'b'});
  const invalid={...state(50,'2026-10-01T16:00:00Z'),total_tokens:51};
  await assert.rejects(ingest(d.token,[row(300)],[invalid],run),/check constraint/);
  assert.equal((await db.query('SELECT total_tokens FROM tokentracker_hourly WHERE user_id=$1',[id])).rows[0].total_tokens,60);
  assert.equal((await list(id)).machines[0].last_seen_at!==null,true);
});

test('an over-limit legacy account keeps every slot through transition and chooses its own slots afterward',async()=>{
  const id=await user(false);
  for(let i=0;i<7;i++) await db.query("INSERT INTO tokentracker_devices(user_id,device_name,platform,machine_id,created_at) VALUES($1,$2,'web',$2,now()-interval '1 day')",[id,'old-device-'+i]);
  const initial=await list(id);assert.equal(initial.machine_count,7);assert.equal(initial.membership.status,'transition');
  const d=await issue(id,'old-device-0',{name:'old-device-0'});
  assert.equal(d.ok,true);assert.equal((await ingest(d.token)).ok,true);
  assert.equal((await issue(id)).code,'cloud_machine_limit');
});

test('sandbox tokens cannot authorize live ingestion and public clients cannot forge an owner',async()=>{
  const id=await user();const d=await issue(id);
  const target=()=>db.query("SELECT count(*)::int n FROM tokentracker_cloud_machines WHERE user_id=$1 AND environment='live'",[id]);
  assert.equal((await target()).rows[0].n,0);
  assert.equal((await ingest(d.token,[row()],[],null,'live')).code,'cloud_environment_mismatch');
  assert.equal((await target()).rows[0].n,0,'a rejected sandbox token must not enroll any live machine');
  assert.equal((await ingest(d.token,[row()],[],null,null)).code,'cloud_environment_mismatch');
  assert.equal((await target()).rows[0].n,0);
  assert.equal((await ingest('not-a-token')).code,'cloud_device_token_rejected');
});


test('same-hostname machines remain distinct and legacy adoption survives a name conflict',async()=>{
  const id=await user();
  const a=await issue(id,'aaaaaaaa-seed',{name:'MacBook-Pro.local'});
  const b=await issue(id,'bbbbbbbb-seed',{name:'MacBook-Pro.local'});
  assert.notEqual(a.device_id,b.device_id);assert.equal((await list(id)).machine_count,2);
  assert.equal((await db.query('SELECT device_name FROM tokentracker_devices WHERE id=$1',[b.device_id])).rows[0].device_name,'MacBook-Pro.local #bbbbbbbb');
  const orphan=randomUUID();
  await db.query("INSERT INTO tokentracker_devices(id,user_id,device_name,platform) VALUES($1,$2,'Token Tracker (dashboard) #cccccccc','web')",[orphan,id]);
  const adopted=await issue(id,'cccccccc-seed',{name:'MacBook-Pro.local',names:['MacBook-Pro.local','Token Tracker (dashboard) #cccccccc']});
  assert.equal(adopted.device_id,orphan);
  assert.equal((await db.query('SELECT device_name FROM tokentracker_devices WHERE id=$1',[orphan])).rows[0].device_name,'Token Tracker (dashboard) #cccccccc');
});

test('identity refresh merges a legacy slot and preserves its custom name without increasing quota',async()=>{
  const id=await user();const a=await issue(id,'old-machine',{name:'Old name'});
  const orphan=randomUUID();
  await db.query("INSERT INTO tokentracker_devices(id,user_id,device_name,platform,name_customized,default_device_name) VALUES($1,$2,'Custom name','web',true,'New name')",[orphan,id]);
  assert.equal((await list(id)).machine_count,2);
  const issued=await issue(id,'old-machine',{name:'New name'});
  assert.equal(issued.ok,true);assert.equal((await list(id)).machine_count,1);
  assert.equal((await db.query('SELECT device_name FROM tokentracker_devices WHERE id=$1',[a.device_id])).rows[0].device_name,'Custom name');
});

test('the device-flow grant is owner-bound and poll issuance rechecks expiry inside the transaction',async()=>{
  const id=await user(),stranger=await user();const code='a'.repeat(64);
  await db.query("INSERT INTO tokentracker_device_codes VALUES($1,'AAAA-BBBB','pending',NULL,now()+interval '10 minutes',NULL,'darwin-arm64 Host','flow-machine')",[code]);
  assert.equal((await rpc('cloud_grant_device_code',[id,'sandbox','AAAA-BBBB'])).ok,true);
  assert.equal((await rpc('cloud_grant_device_code',[stranger,'sandbox','AAAA-BBBB'])).code,'cloud_device_code_claimed');
  const token=randomUUID();
  const args=[id,'sandbox','Host','cli-device-flow','flow-machine',['Host'],randomUUID(),token,true,code];
  assert.equal((await rpc('cloud_issue_device_token',args)).ok,true);
  await db.query("UPDATE tokentracker_device_codes SET expires_at=now()-interval '1 minute' WHERE device_code=$1",[code]);
  args[6]=randomUUID();args[7]=randomUUID();
  assert.equal((await rpc('cloud_issue_device_token',args)).code,'cloud_device_code_expired');
});


test('paused machine aliases cannot be bypassed by a revoked legacy device row',async()=>{
  const id=await user();const seed='paused-old-seed';const d=await issue(id,seed);
  await rpc('cloud_remove_machine',[id,'sandbox',d.machine_id]);
  await db.query('UPDATE tokentracker_devices SET revoked_at=now() WHERE id=$1',[d.device_id]);
  assert.equal((await issue(id,seed)).code,'cloud_machine_paused');
  assert.equal((await list(id)).machine_count,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_devices WHERE user_id=$1',[id])).rows[0].n,1);
});

test('known slot aliases survive revoked old rows and reuse quota after an explicit resume',async()=>{
  const id=await user();const seed='resumed-old-seed';const d=await issue(id,seed);
  await rpc('cloud_remove_machine',[id,'sandbox',d.machine_id]);
  await db.query('UPDATE tokentracker_devices SET revoked_at=now() WHERE id=$1',[d.device_id]);
  await rpc('cloud_resume_machine',[id,'sandbox',d.machine_id]);
  for(let i=0;i<4;i++) await issue(id);
  const replacement=await issue(id,seed);
  assert.equal(replacement.ok,true);assert.equal(replacement.machine_id,d.machine_id);
  assert.equal((await list(id)).machine_count,5);
});

test('expired over-limit accounts receive the same admission denial for old tokens and new issuance',async()=>{
  const id=await user();let first;
  for(let i=0;i<5;i++){const d=await issue(id,'expiring-'+i,{name:'Device '+i});if(i===0)first=d;}
  await expire(id,1);
  assert.equal((await issue(id,'expiring-0')).code,'cloud_machine_limit');
  assert.equal((await ingest(first.token)).code,'cloud_machine_limit');
});

test('a free account cannot extend its daily community window beyond ten batches',async()=>{
  const id=await user(false);const d=await issue(id);const run=randomUUID();
  for(let i=0;i<10;i++)assert.equal((await ingest(d.token,[row(i+1)],[],run)).ok,true);
  const denied=await ingest(d.token,[row(11)],[],run);
  assert.equal(denied.code,'cloud_sync_throttled');assert.ok(denied.retry_after_seconds>0);
  assert.equal((await db.query('SELECT total_tokens FROM tokentracker_hourly WHERE user_id=$1',[id])).rows[0].total_tokens,10);
});

test('the actual server role can ingest, while an authenticated owner cannot invoke privileged admission',async()=>{
  const id=await user();const token=randomUUID();
  await db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE project_admin');
    const args=[id,'sandbox','Server role device','web','server-role-seed',['Server role device'],randomUUID(),token,false,null];
    const issued=(await tx.query('SELECT cloud_issue_device_token($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result',args)).rows[0].result;
    assert.equal(issued.ok,true);
    const uploaded=(await tx.query("SELECT cloud_ingest_usage($1,'sandbox',$2,'[]'::jsonb,NULL) result",[token,JSON.stringify([row()])])).rows[0].result;
    assert.equal(uploaded.ok,true);
  });
  await assert.rejects(db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE authenticated');
    await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[id]);
    await tx.query("SELECT cloud_list_machines($1,'sandbox',NULL)",[id]);
  }),/permission denied for function/);
});

test('a paid term restores expired private access and existing machine identity without changing local truth',async()=>{
  const id=await user();const seed='renewable-machine';const d=await issue(id,seed);
  await ingest(d.token,[row(120)]);await expire(id,31);
  assert.equal((await rpc('cloud_account_access',[id,'sandbox','daily'])).ok,false);
  const order=await rpc('cloud_create_order',[id,'sandbox','wechat','cloud_cny_monthly',randomUUID()]);
  await rpc('cloud_apply_event',['wechat','sandbox',JSON.stringify({event_id:randomUUID(),kind:'payment',action_id:randomUUID(),
    order_id:order.id,occurred_at:new Date().toISOString(),currency:order.currency,base_amount_cents:order.amount_cents,amount_cents:order.amount_cents})]);
  const access=await rpc('cloud_account_access',[id,'sandbox','daily']);
  assert.equal(access.membership.status,'active');assert.equal(access.ok,true);
  const reissued=await issue(id,seed);assert.equal(reissued.ok,true);assert.equal(reissued.machine_id,d.machine_id);
  await db.query("UPDATE tokentracker_cloud_machines SET last_upload_at=now()-interval '1 hour',upload_window_until=now()-interval '1 hour' WHERE id=$1",[d.machine_id]);
  const uploaded=await ingest(d.token,[row(150)],[],randomUUID());
  assert.equal(uploaded.ok,true);assert.equal(uploaded.upload_scope,'cloud');assert.equal(uploaded.sync_interval_seconds,900);
  assert.equal((await db.query('SELECT total_tokens FROM tokentracker_hourly WHERE user_id=$1',[id])).rows[0].total_tokens,150);
});

// PGlite serializes its JS connections. A SQL trigger deterministically
// interleaves the unguarded legacy writer after the RPC's pre-check, so the
// actual unique indexes decide the conflict rather than a mocked response.
async function withDeviceRace(sql, run, pg=db) {
  await pg.exec(`CREATE FUNCTION test_device_identity_race() RETURNS trigger LANGUAGE plpgsql AS $race$
    BEGIN ${sql} RETURN NEW; END; $race$;
    CREATE TRIGGER test_device_identity_race BEFORE INSERT OR UPDATE ON tokentracker_devices
    FOR EACH ROW EXECUTE FUNCTION test_device_identity_race();`);
  try { await run(); }
  finally { await pg.exec('DROP TRIGGER test_device_identity_race ON tokentracker_devices; DROP FUNCTION test_device_identity_race();'); }
}

test('a legacy rename racing new enrollment returns 409 without absorbing the other machine', async()=>{
  const id=await user(); const other=await issue(id,'rename-racer-existing',{name:'Original custom laptop'});
  await withDeviceRace(`IF TG_OP='INSERT' AND NEW.user_id='${id}'::uuid AND NEW.machine_id='rename-racer-new' THEN
    UPDATE tokentracker_devices SET device_name=NEW.device_name,name_customized=true,
      default_device_name='Original custom laptop' WHERE id='${other.device_id}'::uuid;
    END IF;`,async()=>{
    const result=await issue(id,'rename-racer-new',{name:'Shared hostname'});
    assert.equal(result.ok,false);assert.equal(result.status,409);assert.equal(result.code,'cloud_device_identity_conflict');
    assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_devices WHERE user_id=$1',[id])).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_device_tokens WHERE user_id=$1',[id])).rows[0].n,1);
    assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_machine_aliases WHERE user_id=$1 AND kind='machine' AND alias='rename-racer-new'",[id])).rows[0].n,0);
    const retained=(await db.query('SELECT machine_id,device_name,name_customized FROM tokentracker_devices WHERE id=$1',[other.device_id])).rows[0];
    assert.deepEqual(retained,{machine_id:'rename-racer-existing',device_name:'Shared hostname',name_customized:true});
  });
  const retry=await issue(id,'rename-racer-new',{name:'Shared hostname'});
  assert.equal(retry.ok,true);assert.notEqual(retry.device_id,other.device_id);
  assert.equal((await list(id)).machine_count,2);
});

test('a concurrent exact-machine winner retains its custom name and receives the token at quota',async()=>{
  const id=await user();for(let i=0;i<4;i++) await issue(id);
  const winner=randomUUID();
  await withDeviceRace(`IF TG_OP='INSERT' AND NEW.user_id='${id}'::uuid AND NEW.machine_id='exact-racer-machine'
      AND NEW.id<>'${winner}'::uuid THEN
    INSERT INTO tokentracker_devices(id,user_id,device_name,platform,machine_id,name_customized)
      VALUES('${winner}'::uuid,NEW.user_id,'Concurrent custom label',NEW.platform,NEW.machine_id,true);
    END IF;`,async()=>{
    const result=await issue(id,'exact-racer-machine',{name:'Default hostname'});
    assert.equal(result.ok,true);assert.equal(result.device_id,winner);
    assert.equal((await list(id)).machine_count,5);
    assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_devices WHERE user_id=$1',[id])).rows[0].n,5);
    assert.equal((await db.query('SELECT device_name FROM tokentracker_devices WHERE id=$1',[winner])).rows[0].device_name,'Concurrent custom label');
    assert.equal((await db.query('SELECT device_id FROM tokentracker_device_tokens WHERE token_hash=$1',[result.token])).rows[0].device_id,winner);
  });
});

test('a machine identity racing legacy adoption returns a retryable conflict without leaking a database exception',async()=>{
  const id=await user();const legacy=randomUUID();const winner=randomUUID();
  await db.query("INSERT INTO tokentracker_devices(id,user_id,device_name,platform) VALUES($1,$2,'Legacy host','web')",[legacy,id]);
  await withDeviceRace(`IF TG_OP='UPDATE' AND NEW.id='${legacy}'::uuid AND NEW.machine_id='adoption-racer-machine'
      AND NOT EXISTS(SELECT 1 FROM tokentracker_devices WHERE id='${winner}'::uuid) THEN
    INSERT INTO tokentracker_devices(id,user_id,device_name,platform,machine_id)
      VALUES('${winner}'::uuid,NEW.user_id,'Concurrent exact host',NEW.platform,NEW.machine_id);
    END IF;`,async()=>{
    const result=await issue(id,'adoption-racer-machine',{name:'New label',names:['Legacy host']});
    assert.equal(result.ok,false);assert.equal(result.status,409);assert.equal(result.code,'cloud_device_identity_conflict');
    assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_device_tokens WHERE user_id=$1',[id])).rows[0].n,0);
    assert.equal((await db.query('SELECT machine_id FROM tokentracker_devices WHERE id=$1',[legacy])).rows[0].machine_id,null);
  });
});

test('an exact-machine conflict winner paused during enrollment cannot receive a new token',async()=>{
  const id=await user();const winner=randomUUID();
  await withDeviceRace(`IF TG_OP='INSERT' AND NEW.user_id='${id}'::uuid AND NEW.machine_id='paused-racer-machine'
      AND NEW.id<>'${winner}'::uuid THEN
    INSERT INTO tokentracker_devices(id,user_id,device_name,platform,machine_id)
      VALUES('${winner}'::uuid,NEW.user_id,'Paused concurrent host',NEW.platform,NEW.machine_id);
    PERFORM cloud_remove_machine(NEW.user_id,'sandbox',cloud_bind_device_slot(NEW.user_id,'sandbox','${winner}'::uuid));
    END IF;`,async()=>{
    const result=await issue(id,'paused-racer-machine',{name:'Default hostname'});
    assert.equal(result.ok,false);assert.equal(result.status,403);assert.equal(result.code,'cloud_machine_paused');
    assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_device_tokens WHERE user_id=$1',[id])).rows[0].n,0);
    const machines=await list(id);assert.equal(machines.machine_count,0);assert.equal(machines.machines[0].status,'paused');
  });
});


test('maintenance-lock composition preserves exact-identity conflict handling in the installed issuer',async()=>{
  const {setup}=require('./helpers/cloud-usage-archive-fixture');
  const isolated=await setup();
  const call=async(name,args)=>(await isolated.query(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
  try {
    await isolated.exec(migration('20261003120000_cloud-subscriptions.sql'));
    await isolated.exec(migration('20261004120000_cloud-machine-access.sql'));
    await isolated.exec(migration('20261005120000_cloud-usage-archive.sql'));
    await isolated.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now() WHERE environment='sandbox'");
    const definition=(await isolated.query("SELECT pg_get_functiondef('cloud_issue_device_token(uuid,text,text,text,text,text[],uuid,text,boolean,text)'::regprocedure) definition")).rows[0].definition;
    const maintenanceAt=definition.indexOf('cloud_usage_maintenance_lock(p_user_id)');
    const accountAt=definition.indexOf('cloud_reconcile_machines(p_user_id,p_environment)');
    assert.ok(maintenanceAt>=0 && accountAt>=0 && maintenanceAt<accountAt);
    assert.match(definition,/ON CONFLICT DO NOTHING RETURNING/);
    const id=randomUUID();await isolated.query('INSERT INTO auth.users VALUES($1)',[id]);await call('cloud_start_trial',[id,'sandbox']);
    const other=(await call('cloud_issue_device_token',[id,'sandbox','Original label','web','composed-existing-machine',['Original label'],randomUUID(),randomUUID(),false,null])).device_id;
    await withDeviceRace(`IF TG_OP='INSERT' AND NEW.user_id='${id}'::uuid AND NEW.machine_id='composed-new-machine' THEN
      UPDATE tokentracker_devices SET device_name=NEW.device_name,name_customized=true,
        default_device_name='Original label' WHERE id='${other}'::uuid;
      END IF;`,async()=>{
      const result=await call('cloud_issue_device_token',[id,'sandbox','Racing label','web','composed-new-machine',['Racing label'],randomUUID(),randomUUID(),false,null]);
      assert.equal(result.code,'cloud_device_identity_conflict');assert.equal(result.status,409);
      assert.equal((await isolated.query('SELECT count(*)::int n FROM tokentracker_devices WHERE user_id=$1',[id])).rows[0].n,1);
      assert.equal((await isolated.query('SELECT count(*)::int n FROM tokentracker_device_tokens WHERE user_id=$1',[id])).rows[0].n,1);
    },isolated);
  } finally { await isolated.close(); }
});


test('early purchase preserves old over-limit slots only through the originally promised transition deadline',async()=>{
  const id=await user(false);
  const originalLaunch=(await db.query("SELECT launch_at FROM tokentracker_cloud_policy WHERE environment='sandbox'")).rows[0].launch_at;
  for(let i=0;i<7;i++) await db.query("INSERT INTO tokentracker_devices(user_id,device_name,platform,machine_id,created_at) VALUES($1,$2,'web',$2,now()-interval '60 days')",[id,'paid-grace-'+i]);
  const before=await list(id);assert.equal(before.membership.status,'transition');assert.equal(before.machine_count,7);
  const old=await issue(id,'paid-grace-0',{name:'paid-grace-0'});assert.equal(old.ok,true);
  const uploadId=randomUUID();assert.equal((await ingest(old.token,[row()],[],uploadId)).ok,true);
  assert.equal((await issue(id)).code,'cloud_machine_limit');
  const order=await rpc('cloud_create_order',[id,'sandbox','wechat','cloud_cny_monthly',randomUUID()]);
  await rpc('cloud_apply_event',['wechat','sandbox',JSON.stringify({event_id:randomUUID(),kind:'payment',action_id:randomUUID(),
    order_id:order.id,occurred_at:new Date().toISOString(),currency:order.currency,base_amount_cents:order.amount_cents,amount_cents:order.amount_cents})]);
  const afterPurchase=await list(id);assert.equal(afterPurchase.membership.status,'active');
  assert.equal(afterPurchase.membership.transition_ends_at,before.membership.transition_ends_at);
  assert.equal((await issue(id,'paid-grace-0',{name:'paid-grace-0'})).ok,true);
  assert.equal((await ingest(old.token,[row(120)],[],uploadId)).ok,true);
  assert.equal((await issue(id)).code,'cloud_machine_limit','paying early cannot add an eighth slot');
  try {
    await db.exec("UPDATE tokentracker_cloud_policy SET launch_at=now()-interval '31 days' WHERE environment='sandbox'");
    const expiredGrace=await list(id);assert.equal(expiredGrace.membership.status,'active','the paid term remains active');
    assert.ok(Date.parse(expiredGrace.membership.transition_ends_at)<Date.now());
    assert.equal((await issue(id,'paid-grace-0',{name:'paid-grace-0'})).code,'cloud_machine_limit');
    assert.equal((await ingest(old.token,[row(140)],[],uploadId)).code,'cloud_machine_limit');
    assert.equal((await issue(id)).code,'cloud_machine_limit');
  } finally { await db.query("UPDATE tokentracker_cloud_policy SET launch_at=$1 WHERE environment='sandbox'",[originalLaunch]); }
});

test('Cloud uses a 99-device abuse guard while free uploads and upload protections stay enforced', async () => {
  await db.exec(migration('20261010225755_cloud-device-safety-cap.sql'));
  const id = await user();
  const results = await Promise.all(Array.from({length:103}, () => issue(id)));
  assert.equal(results.filter(result => result.ok).length,99);
  assert.equal(results.filter(result => result.code === 'cloud_machine_limit').length,4);
  const machines = await list(id);
  assert.equal(machines.machine_limit,99);
  assert.equal(machines.machine_count,99);
  assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_devices WHERE user_id=$1',[id])).rows[0].n,99);
  const first = results.find(result => result.ok);
  const identity = (await db.query('SELECT machine_id FROM tokentracker_devices WHERE id=$1',[first.device_id])).rows[0].machine_id;
  assert.equal((await issue(id,identity)).ok,true,'reusing an existing device does not consume a new slot');
  assert.equal((await list(id)).machine_count,99);
  assert.equal((await ingest(first.token)).ok,true,'an admitted device can still upload at the cap');
  assert.equal((await ingest(first.token,[row(200)],[],randomUUID())).code,'cloud_sync_throttled');
  assert.equal((await ingest(first.token,Array.from({length:501},() => row()),[],randomUUID())).code,'cloud_upload_size_exceeded');
  assert.equal((await ingest(randomUUID())).ok,false,'unknown tokens cannot upload');
  await expire(id,1);
  assert.equal((await list(id)).machine_limit,1,'expired membership returns to the free community rule');
  assert.equal((await issue(id)).code,'cloud_machine_limit');
  const free = await user(false);
  assert.equal((await issue(free)).ok,true);
  assert.equal((await issue(free)).code,'cloud_machine_limit');
  assert.equal((await list(free)).machine_limit,1);
  const paid = await user(false);
  const order = await rpc('cloud_create_order',[paid,'sandbox','wechat','cloud_cny_monthly',randomUUID()]);
  await rpc('cloud_apply_event',['wechat','sandbox',JSON.stringify({event_id:randomUUID(),kind:'payment',action_id:randomUUID(),
    order_id:order.id,occurred_at:new Date().toISOString(),currency:order.currency,base_amount_cents:order.amount_cents,amount_cents:order.amount_cents})]);
  const membership = await rpc('cloud_membership',[paid,'sandbox']);
  assert.equal(membership.status,'active');
  assert.equal(membership.machine_limit,99);
  assert.equal(membership.sync_interval_seconds,900);
  await db.transaction(async tx => {
    await tx.query("INSERT INTO tokentracker_devices(user_id,device_name,platform,machine_id,created_at) VALUES($1,'Transition','web','transition-cap',now()-interval '60 days')",[free]);
    const transition = (await tx.query("SELECT cloud_membership($1,'sandbox') result",[free])).rows[0].result;
    assert.equal(transition.status,'transition');
    assert.equal(transition.machine_limit,99);
  });
  const permissions = (await db.query("SELECT has_function_privilege('authenticated','cloud_membership(uuid,text)','EXECUTE') allowed")).rows[0];
  assert.equal(permissions.allowed,false);
});
