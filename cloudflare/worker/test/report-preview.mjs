// Supply a dedicated QA account, scoped to the isolated api-qa deployment.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
const base=process.env.TT_QA_BASE_URL;
assert.equal(base,"https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev");
assert.match(process.env.TT_QA_EMAIL||"",/@example\.invalid$/);
const successes=[];
async function call(path,{body,token,secret,form="json",status=200}={}) {
  const res=await fetch(new URL(path,base),{method:body===undefined?"GET":"POST",redirect:"error",
    headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{}),
      ...(secret?{"x-refresh-secret":secret}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(res.status!==status) {
    const data=await res.json().catch(()=>({}));
    throw new Error(path.split("?")[0]+" HTTP "+res.status+" "+(data.code||data.error||"")+" expected "+status);
  }
  successes.push([path.split("?")[0],status]);
  if(status===204)return null;
  return form==="svg"?res.text():res.json();
}
const route=n=>"/functions/tokentracker-"+n;
const login=await call("/api/auth/sessions?client_type=mobile",{body:{email:process.env.TT_QA_EMAIL,password:process.env.TT_QA_PASSWORD}});
const token=login.accessToken, user=process.env.TT_QA_ID;
assert.ok(token && user);
const account=await call(route("billing")+"?action=account",{token});
assert.equal(account.environment,"sandbox");
if (!account.membership.can_read_cloud) await call(route("billing")+"?action=trial",{token,body:{}});
const pair=await call(route("device-flow-authorize"),{body:{client_info:"report QA",machine_id:"report-validation"}});
await call(route("device-flow-grant"),{token,body:{user_code:pair.user_code}});
const device=await call(route("device-flow-poll"),{body:{device_code:pair.device_code}});
assert.equal(device.status,"approved");
const hour=new Date();hour.setUTCMinutes(0,0,0);
const day=hour.toISOString().slice(0,10), params=new URLSearchParams({from:day,to:day,day,tz:"UTC",device_id:device.device_id});
const baseline=await call(route("account-summary")+"?"+params,{token});
const n=8000;
const model="qa-reports-"+randomUUID();
const body={upload_id:randomUUID(),buckets:[{hour_start:hour.toISOString(),source:"codex",model,total_tokens:n,input_tokens:n,conversation_count:2}]};
await call(route("ingest"),{token:device.device_token,body});
const now=await call(route("account-summary")+"?"+params,{token});
assert.equal(now.totals.total_tokens-baseline.totals.total_tokens,n);
for(const kind of ["hourly","daily","monthly"]) {
 const r=await call(route("account-"+kind)+"?"+params,{token});
 assert.equal(r.data.reduce((tot,row)=>tot+(row.models?.[model]||0),0),n);
}
const mm=await call(route("account-model-breakdown")+"?"+params,{token});
assert.ok(mm.sources.some(s=>s.models.some(m=>m.model===model && m.totals.conversation_count===2)));
const hh=await call(route("account-heatmap")+"?"+params+"&format=compact&weeks=1",{token});
assert.ok(hh.model_names.includes(model));
const dd=await call(route("account-devices")+"?"+params,{token});
assert.ok(dd.devices.some(d=>d.id===device.device_id&&d.total_tokens>=n));
await call(route("account-daily")+"?"+params,{status:401});
await call(route("account-skills"),{token,body:{device_id:device.device_id,skills:[{name:"Demo",key:"demo",directory:"demo"}]}});
assert.ok((await call(route("account-skills"),{token})).devices.some(d=>d.skills.some(s=>s.key==="demo")));
await call(route("public-visibility"),{token,body:{enabled:true,anonymous:true,display_name:"QA private name",github_url:"qa-demo",show_github_url:true}});
const visibility=await call(route("public-visibility"),{token});
assert.equal(visibility.anonymous,true);
const refresh=process.env.TT_QA_REFRESH_SECRET;
assert.ok(refresh);
await call(route("leaderboard-refresh"),{secret:refresh,body:{period:"total",force_refresh:true}});
const board=await call(route("leaderboard")+"?period=total&user_id="+user);
assert.equal(board.me.display_name,"Anonymous");
assert.equal(board.me.avatar_url,null);
assert.equal(board.me.github_url,null);
const profile=await call(route("leaderboard-profile")+"?period=total&user_id="+user);
assert.equal(profile.user.display_name,"Anonymous");assert.equal(profile.user.github_url,null);
assert.equal(profile.totals.total_tokens,board.me.total_tokens);
await call(route("leaderboard-profile")+"?view=badges&user_id="+user,{status:403});
await call(route("user-badges-refresh"),{secret:refresh,body:{}});
const owner=await call(route("leaderboard-profile")+"?view=badges&user_id="+user,{token});
assert.ok(owner.badges.length>0 && owner.badges_include_unearned===true);
for(const slug of ["badge-svg","embed-svg"]) {
 const s=await call(route(slug)+"?period=total&user_id="+user,{form:"svg"});assert.ok(s.includes("<svg"));
}
const anon=randomUUID();
const liked=await call(route("profile-likes"),{body:{target_user_id:user,anon_id:anon,action:"like"}});
assert.equal(liked.liked,true);
const unliked=await call(route("profile-likes"),{body:{target_user_id:user,anon_id:anon,action:"unlike"}});
assert.equal(unliked.liked,false);assert.equal(unliked.count,liked.count-1);
await call(route("telemetry"),{body:{machine_hash:"ab".repeat(32),app_version:"1.5.26",platform:"darwin",shell:"macos"},status:204});
console.log(JSON.stringify({checks:successes.length,uploaded_token_delta:n,anonymous_identity_hidden:true,owner_badges:owner.badges.length,
  public_endpoints:["leaderboard","leaderboard-profile","badge-svg","embed-svg","profile-likes","telemetry"],device_isolation:true}));
