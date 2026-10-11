const test=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {platform,fixture}=require("./helpers/self-host-fixture.cjs");
const {install,buildSql,buildMigrationSql}=require("../scripts/self-host/install.cjs");
const {steps}=require("../scripts/self-host/manifest.cjs");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const {buildFunctions}=require("../scripts/self-host/build-functions.cjs");
let instance;
test.before(async()=>{instance=await fixture();});
test.after(async()=>{await instance?.close();});
const query=async(name,args)=>(await instance.db.query(`SELECT ${name}(${args.map((_,i)=>"$"+(i+1)).join(",")}) AS r`,args)).rows[0].r;
const issue=async(owner,name)=>{
  const result=await instance.request("tokentracker-device-token-issue",{device_name:name,platform:"test",machine_id:randomUUID()},owner);
  assert.equal(result.response.status,200,result.data.error);return result.data;
};
const row=tokens=>({hour_start:"2026-10-01T12:00:00Z",source:"codex",model:"gpt-6",input_tokens:tokens,
  output_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,reasoning_output_tokens:0,total_tokens:tokens,
  billable_total_tokens:tokens,total_cost_usd:0,conversation_count:1});
const upload=async(token,rows)=>instance.request("tokentracker-ingest",{buckets:rows},token);

test("clean self-host installation is repeatable and preserves real usage and identities",async()=>{
  assert.equal((await instance.db.query("SELECT count(*)::int n FROM tokentracker_self_host_installations")).rows[0].n,steps().length);
  const owner=await instance.user();const device=await issue(owner,"Preserved host");
  assert.equal((await upload(device.token,[row(100)])).response.status,200);
  await install(instance.db);
  assert.equal((await instance.db.query("SELECT sum(total_tokens)::int n FROM tokentracker_hourly WHERE user_id=$1",[owner])).rows[0].n,100);
  assert.equal((await instance.db.query("SELECT id FROM tokentracker_devices WHERE user_id=$1",[owner])).rows[0].id,device.device_id);
});

test("self-hosted access is explicitly free without paid orders, trials, device quotas, or hosted history windows",async()=>{
  const owner=await instance.user();
  const state=await query("cloud_membership",[owner,"live"]);
  assert.equal(state.status,"self_hosted");assert.equal(state.phase,"active");
  assert.equal(state.can_upload_cloud,true);assert.equal(state.can_read_cloud,true);
  assert.equal(state.machine_limit,null);assert.equal(state.hourly_history_days,null);assert.equal(state.trial_available,false);
  assert.equal((await query("cloud_account_access",[owner,"live","hourly"])).available_from,null);
  for(let i=0;i<7;i++)assert.equal((await issue(owner,"Free host "+i)).membership.status,"self_hosted");
  assert.equal((await query("cloud_list_machines",[owner,"live",null])).machine_count,7);
  await assert.rejects(query("cloud_create_order",[owner,"live","waffo","cloud_usd_monthly",randomUUID()]),/free.*paid order/);
  await assert.rejects(query("cloud_start_trial",[owner,"live"]),/free.*trial/);
  await assert.rejects(query("cloud_membership",[randomUUID(),"live"]),/account does not exist/);
  assert.equal((await instance.db.query("SELECT count(*)::int n FROM tokentracker_cloud_payments")).rows[0].n,0);
});

test("two signed-in devices upload through actual SDK HTTP and private account reads remain isolated",async()=>{
  const owner=await instance.user();const stranger=await instance.user();
  const first=await issue(owner,"Laptop");const second=await issue(owner,"Workstation");
  for(const [device,tokens]of [[first,120],[second,80]]) {
    const result=await upload(device.token,[row(tokens)]);assert.equal(result.response.status,200,result.data.error);
    assert.equal(result.data.upload_scope,"cloud");assert.equal(result.data.membership.status,"self_hosted");
  }
  assert.equal((await upload(first.token,[row(120)])).response.status,200);
  const summary=await instance.request("tokentracker-account-summary?from=2026-10-01&to=2026-10-01&tz=UTC",undefined,owner);
  assert.equal(summary.response.status,200,summary.data.error);
  assert.equal(summary.data.totals.total_tokens,200);
  const foreign=await instance.request("tokentracker-account-summary?from=2026-10-01&to=2026-10-01&tz=UTC&user_id="+owner,undefined,stranger);
  assert.equal(foreign.response.status,200);assert.equal(foreign.data.totals.total_tokens,0);
  const devices=await instance.request("tokentracker-account-devices?from=2026-10-01&to=2026-10-01",undefined,stranger);
  assert.equal(devices.response.status,200);assert.deepEqual(devices.data.devices,[]);
});

test("free self-host policy does not bypass signatures, expiry, token revocation, or account RLS",async()=>{
  const owner=await instance.user();const device=await issue(owner,"Auth boundary");
  const forged=instance.token(owner).slice(0,-3)+"xxx";
  assert.equal((await instance.request("tokentracker-account-summary?from=2026-10-01&to=2026-10-01",undefined,forged)).response.status,401);
  assert.equal((await instance.request("tokentracker-account-summary?from=2026-10-01&to=2026-10-01",undefined,instance.token(owner,"authenticated",1))).response.status,401);
  assert.equal((await upload("unknown-token",[row(100)])).response.status,401);
  const removed=await instance.request("tokentracker-billing?action=remove-device",{machine_id:device.machine_id},owner);
  assert.equal(removed.response.status,200);
  assert.equal((await upload(device.token,[row(100)])).response.status,401);
  const permissions=(await instance.db.query(`SELECT
    has_table_privilege('anon','tokentracker_hourly','SELECT') AS anon_read,
    has_table_privilege('authenticated','tokentracker_hourly','SELECT') AS user_read,
    has_function_privilege('authenticated','cloud_ingest_usage(text,text,jsonb,jsonb,text)','EXECUTE') AS direct_upload,
    has_function_privilege('authenticated','account_summary_wire(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)','EXECUTE') AS direct_private_read`)).rows[0];
  assert.deepEqual(permissions,{anon_read:false,user_read:false,direct_upload:false,direct_private_read:false});
  await instance.db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE authenticated");
    await assert.rejects(tx.query("SELECT * FROM tokentracker_hourly"),/permission denied/);
  }).catch(error=>{if(!/transaction is aborted/.test(error.message))throw error;});
});

test("self-host device authorization points to its own dashboard and the device flow uses that instance",async()=>{
  const owner=await instance.user();
  const code=await instance.request("tokentracker-device-flow-authorize",{client_info:"Self-host CLI",machine_id:randomUUID()});
  assert.equal(code.response.status,200);assert.equal(code.data.verification_uri,"https://private.example.test/device");
  assert.equal(new URL(code.data.verification_uri_complete).origin,"https://private.example.test");
  const pending=await instance.request("tokentracker-device-flow-poll",{device_code:code.data.device_code});
  assert.equal(pending.response.status,200);assert.equal(pending.data.status,"pending");
  const granted=await instance.request("tokentracker-device-flow-grant",{user_code:code.data.user_code},owner);
  assert.equal(granted.response.status,200,granted.data.error);
  const polled=await instance.request("tokentracker-device-flow-poll",{device_code:code.data.device_code});
  assert.equal(polled.response.status,200,polled.data.error);assert.equal(polled.data.status,"approved");
  assert.equal((await upload(polled.data.device_token,[row(50)])).response.status,200);
});

test("private aggregation sees whole-row corrections, timezone buckets, and DeepSeek weekend tiers",async()=>{
  const owner=await instance.user();const device=await issue(owner,"Correctable host");
  await upload(device.token,[row(100)]);
  const args=[owner,null,"2026-10-01T00:00:00Z","2026-10-02T00:00:00Z","hour","Asia/Shanghai",null];
  assert.equal((await query("account_usage_grouped_cached",args))[0].total_tokens,100);
  await upload(device.token,[row(60)]);
  const corrected=await query("account_usage_grouped_cached",args);
  assert.equal(corrected[0].total_tokens,60);assert.equal(corrected[0].bucket,"2026-10-01T20:00:00");
  const weekend={...row(70),model:"deepseek-v4-pro",hour_start:"2026-10-03T02:00:00Z"};
  await upload(device.token,[weekend]);
  const tiers=await query("account_usage_grouped_cached",[owner,null,"2026-10-03T00:00:00Z","2026-10-04T00:00:00Z","day","UTC",null]);
  assert.equal(tiers[0].pricing_tier,"off_peak");
});

test("installer refuses incomplete platform roles, existing unregistered applications, checksum drift, and missing functions",async()=>{
  const unsupported=await platform();
  try {
    await unsupported.exec("REVOKE SELECT(id) ON auth.users FROM project_admin");
    await assert.rejects(install(unsupported),/server role must be able to verify/);
    assert.equal((await unsupported.query("SELECT to_regclass('tokentracker_self_host_installations') AS name")).rows[0].name,null);
  } finally {await unsupported.close();}
  const fresh=await platform();
  try {
    await fresh.exec("CREATE TABLE tokentracker_devices(id uuid)");
    await assert.rejects(install(fresh),/existing unregistered/);
    assert.equal((await fresh.query("SELECT to_regclass('tokentracker_self_host_installations') AS name")).rows[0].name,null);
  } finally {await fresh.close();}
  const before=await instance.db.query("SELECT checksum FROM tokentracker_self_host_installations WHERE step='01-private-baseline'");
  await instance.db.query("UPDATE tokentracker_self_host_installations SET checksum='changed' WHERE step='01-private-baseline'");
  await assert.rejects(install(instance.db),/Installed step has changed/);
  await instance.db.query("UPDATE tokentracker_self_host_installations SET checksum=$1 WHERE step='01-private-baseline'",[before.rows[0].checksum]);
  const isolated=await platform();
  try {
    await install(isolated);await isolated.exec("DROP FUNCTION cloud_account_access(uuid,text,text)");
    await assert.rejects(install(isolated),/Installed function is missing/);
  } finally {await isolated.close();}
});

test("installation and function manifests exclude production data repairs and merchant secrets",async()=>{
  assert.equal(instance.manifest.functions.length,14);
  assert.ok(instance.manifest.functions.some(f=>f.slug==="tokentracker-device-flow-authorize"));
  assert.ok(!instance.manifest.functions.some(f=>/webhook|leaderboard|public-visibility/.test(f.slug)));
  assert.ok(!instance.manifest.serverSecrets.some(name=>/WAFFO|PADDLE|ALIPAY|WECHAT/.test(name)));
  assert.ok(!buildSql().includes("ban-confirmed-leaderboard-manipulation"));
});

test("the policy migration keeps hosted charging semantics and leaves installed usage readers intact",async()=>{
  const db=await platform();
  try {
    for(const step of steps().slice(0,-1))await db.exec(step.sql);
    const before=(await db.query("SELECT pg_get_functiondef('account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)'::regprocedure) AS body")).rows[0].body;
    await db.exec(steps().at(-1).sql);
    const after=(await db.query("SELECT pg_get_functiondef('account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer)'::regprocedure) AS body")).rows[0].body;
    assert.equal(after,before);
    await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=clock_timestamp() WHERE environment='live'");
    const owner=randomUUID();await db.query("INSERT INTO auth.users VALUES($1)",[owner]);
    const free=(await db.query("SELECT cloud_membership($1,'live') AS r",[owner])).rows[0].r;
    assert.equal(free.status,"free");assert.equal(free.machine_limit,1);assert.equal(free.can_upload_cloud,false);assert.equal(free.can_read_cloud,false);
    const trial=(await db.query("SELECT cloud_start_trial($1,'live') AS r",[owner])).rows[0].r;
    assert.equal(trial.status,"trial");assert.equal(trial.machine_limit,5);
    const read=(await db.query("SELECT cloud_account_access($1,'live','hourly') AS r",[owner])).rows[0].r;
    assert.ok(read.available_from);
    assert.ok((await db.query("SELECT cloud_create_order($1,'live','waffo','cloud_usd_monthly',$2) AS r",[owner,randomUUID()])).rows[0].r.id);
  } finally {await db.close();}
});

test("the generated standalone SQL installs atomically and can be executed twice without nested transactions",async()=>{
  const db=await platform();
  try {
    const sql=buildSql();assert.ok(sql.startsWith("BEGIN;\nSELECT pg_advisory_xact_lock("));assert.ok(sql.endsWith("COMMIT;"));
    assert.ok(!buildSql({transactional:false}).startsWith("BEGIN;"));
    await db.exec(sql);await db.exec(sql);
    assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_self_host_installations")).rows[0].n,steps().length);
    assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_policy WHERE hosting_mode='self_hosted'")).rows[0].n,2);
  } finally {await db.close();}
  const broken=await platform();
  try {
    const sql=buildSql().replace("CREATE TABLE public.tokentracker_devices (","SELECT * FROM intentionally_missing_self_host_table; CREATE TABLE public.tokentracker_devices (");
    await assert.rejects(broken.exec(sql),/intentionally_missing_self_host_table/);
    await broken.exec("ROLLBACK");
    assert.equal((await broken.query("SELECT to_regclass('tokentracker_self_host_installations') AS name")).rows[0].name,null);
    assert.equal((await broken.query("SELECT to_regclass('tokentracker_devices') AS name")).rows[0].name,null);
  } finally {await broken.close();}
});

test("platform migration output keeps the installation lock and uses its caller's atomic transaction",async()=>{
  const sql=buildMigrationSql();
  assert.ok(sql.startsWith("SELECT pg_advisory_xact_lock("));
  assert.ok(!sql.startsWith("BEGIN;"));assert.ok(!sql.endsWith("COMMIT;"));
  const db=await platform();
  try {
    await db.transaction(tx=>tx.exec(sql));await db.transaction(tx=>tx.exec(sql));
    assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_self_host_installations")).rows[0].n,steps().length);
  } finally {await db.close();}
  const broken=await platform();
  try {
    await assert.rejects(broken.transaction(tx=>tx.exec(sql+"\nSELECT * FROM intentionally_missing_migration_table")),/intentionally_missing_migration_table/);
    assert.equal((await broken.query("SELECT to_regclass('tokentracker_self_host_installations') AS name")).rows[0].name,null);
  } finally {await broken.close();}
});

test("the CommonJS self-host wrapper uses reserved internal routing and leaves the caller environment intact",async()=>{
  const owner=await instance.user();const environment=globalThis.Deno;
  const previousUrl=instance.env.INSFORGE_BASE_URL;const previousKey=instance.env.INSFORGE_SERVICE_ROLE_KEY;
  instance.env.INSFORGE_INTERNAL_URL=previousUrl;instance.env.API_KEY=previousKey;
  instance.env.INSFORGE_BASE_URL="https://unreachable-public-self-host.example";
  delete instance.env.INSFORGE_SERVICE_ROLE_KEY;
  try {
    const device=await issue(owner,"Reserved runtime routing");
    assert.equal((await upload(device.token,[row(77)])).response.status,200);
    assert.equal(globalThis.Deno,environment);
  } finally {
    instance.env.INSFORGE_BASE_URL=previousUrl;instance.env.INSFORGE_SERVICE_ROLE_KEY=previousKey;
    delete instance.env.INSFORGE_INTERNAL_URL;delete instance.env.API_KEY;
  }
});

test("self-host billing preserves the installed payment dependency locks and the official CommonJS export",async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"self-host-runtime-contract-"));
  try {
    await buildFunctions(directory);
    const code=await fs.readFile(path.join(directory,"tokentracker-billing.js"),"utf8");
    assert.ok(code.startsWith("module.exports = async function(req)"));
    assert.ok(!code.includes('await import("npm:alipay-sdk@'));
    assert.ok(!code.includes('await import("npm:urllib@'));
    const lock=JSON.parse(await fs.readFile(path.join(__dirname,"../package-lock.json"),"utf8"));
    const undici=lock.packages["node_modules/urllib/node_modules/undici"].version;
    assert.ok(code.includes('await import("npm:undici@'+undici+'")'));
    assert.ok(code.includes("File: mod.File || globalThis.File"));
    assert.ok(code.includes('const Buffer = __selfHostModules["node:buffer"].Buffer'));
    await buildFunctions(directory);
    assert.equal(await fs.readFile(path.join(directory,"tokentracker-billing.js"),"utf8"),code);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
