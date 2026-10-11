const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const Module=require('node:module');
const { build }=require('esbuild');
const { createHmac,randomUUID }=require('node:crypto');
const secret='isolated-edge-test-secret';
const userId=randomUUID(),deviceId=randomUUID();
const jwt=()=>{
  const head=Buffer.from(JSON.stringify({alg:'HS256'})).toString('base64url');
  const claims=Buffer.from(JSON.stringify({sub:userId,role:'authenticated',exp:Date.now()/1000+3600})).toString('base64url');
  return `${head}.${claims}.${createHmac('sha256',secret).update(head+'.'+claims).digest('base64url')}`;
};
async function load(name) {
  const filename=path.resolve(__dirname,'../dashboard/edge-patches',name+'.ts');
  const out=await build({entryPoints:[filename],bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent',
    plugins:[{name:'isolated-sdk',setup(builder){
      builder.onResolve({filter:/^npm:@insforge\/sdk/},()=>({path:'sdk',namespace:'isolated-sdk'}));
      builder.onLoad({filter:/.*/,namespace:'isolated-sdk'},()=>({contents:'export function createClient(){return globalThis.__cloudAccessClient}',loader:'js'}));
    }}]});
  const module=new Module(filename);module.paths=Module._nodeModulePaths(path.dirname(filename));
  module._compile(out.outputFiles[0].text,filename);return module.exports.default;
}
async function environment(t,client) {
  const priorDeno=globalThis.Deno,priorClient=globalThis.__cloudAccessClient;
  globalThis.Deno={env:{get:key=>({JWT_SECRET:secret,INSFORGE_BASE_URL:'https://cloud.invalid',
    INSFORGE_SERVICE_ROLE_KEY:'isolated-admin',INSFORGE_ANON_KEY:'isolated-anon',TOKENTRACKER_BILLING_ENVIRONMENT:'sandbox'})[key]}};
  globalThis.__cloudAccessClient=client;
  t.after(()=>{globalThis.Deno=priorDeno;globalThis.__cloudAccessClient=priorClient;});
}
for(const name of ['summary','daily','hourly','monthly','heatmap','model-breakdown','devices']) {
  test(`${name} verifies JWT and checks membership before any personal-data RPC or table read`,async t=>{
    const calls=[];const client={database:{rpc:async(name,args)=>{
      calls.push({name,args});return {data:{ok:false,code:'cloud_membership_required',status:402,recovery_url:'https://www.tokentracker.cc/cloud'},error:null};
    },from(){assert.fail('private tables must not be read after denial');}}};
    await environment(t,client);const handler=await load('tokentracker-account-'+name);
    const url='https://cloud.invalid/functions/account?from=2026-10-01&to=2026-10-04&day=2026-10-04';
    const forged=jwt().replace(/.$/,'!');
    assert.equal((await handler(new Request(url,{headers:{Authorization:'Bearer '+forged}}))).status,401);
    assert.equal(calls.length,0);
    const response=await handler(new Request(url,{headers:{Authorization:'Bearer '+jwt()}}));
    assert.equal(response.status,402);assert.equal((await response.json()).code,'cloud_membership_required');
    assert.deepEqual(calls,[{name:'cloud_account_access',args:{p_user_id:userId,p_kind:name==='hourly'?'hourly':'daily',p_environment:'sandbox'}}]);
  });
}

test('membership expiry is checked before an account-summary cache hit',async t=>{
  let allowed=true;const calls=[];
  await environment(t,{database:{rpc:async(name)=>{
    calls.push(name);
    return {data:name==='cloud_account_access'?{ok:allowed,code:'cloud_read_only_expired',status:402,available_from:null}
      :{cost_dims:[],day_rollup:[],range_totals:{}},error:null};
  }}});
  const handler=await load('tokentracker-account-summary');
  const req=()=>new Request('https://cloud.invalid/account?from=2026-10-04&to=2026-10-04',{headers:{Authorization:'Bearer '+jwt()}});
  assert.equal((await handler(req())).status,200);allowed=false;
  assert.equal((await handler(req())).status,402);
  assert.equal(calls.filter(n=>n==='account_summary_wire').length,1);
  assert.equal(calls.filter(n=>n==='cloud_account_access').length,2);
});

test('hourly requests outside the ninety-day window cannot reach aggregation',async t=>{
  const names=[];
  await environment(t,{database:{rpc:async(name)=>{names.push(name);return {data:{ok:true,available_from:'2026-07-07'},error:null};}}});
  const handler=await load('tokentracker-account-hourly');
  const response=await handler(new Request('https://cloud.invalid/account?day=2024-01-01',{headers:{Authorization:'Bearer '+jwt()}}));
  assert.equal(response.status,400);assert.equal((await response.json()).code,'cloud_history_window_exceeded');
  assert.deepEqual(names,['cloud_account_access']);
});

test('ingest preserves within-batch MAX and reports the authoritative cooldown without writing outside its transaction',async t=>{
  let captured;
  await environment(t,{database:{from(table){
    assert.equal(table,'tokentracker_device_tokens');const query={select(){return query},eq(){return query},is(){return query},
      async maybeSingle(){return {data:{user_id:userId,device_id:deviceId},error:null};}};return query;
  },rpc:async(name,args)=>{assert.equal(name,'cloud_ingest_usage');captured=args;
    return {data:{ok:false,code:'cloud_sync_throttled',status:429,retry_after_seconds:86400,next_allowed_at:'2026-10-05T00:00:00Z'},error:null};
  }}});
  const handler=await load('tokentracker-ingest');const uploadId=randomUUID();
  const response=await handler(new Request('https://cloud.invalid/ingest',{method:'POST',headers:{Authorization:'Bearer device-test-token'},
    body:JSON.stringify({upload_id:uploadId,hourly:[{hour_start:'2026-10-04T00:00:00Z',source:'codex',model:'gpt-6',total_tokens:10},
      {hour_start:'2026-10-04T00:00:00Z',source:'codex',model:'gpt-6',total_tokens:50}]})}));
  assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'86400');
  assert.equal(captured.p_rows.length,1);assert.equal(captured.p_rows[0].total_tokens,50);
  assert.equal(captured.p_upload_id,uploadId);assert.equal(captured.p_environment,'sandbox');
});
