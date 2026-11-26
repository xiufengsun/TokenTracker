// Run the seven scheduled handlers through the D1 API on a verified, unbound rehearsal database.
// Source business tables are read-only here. Writable handler tables are copied into per-run scratch tables.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const [account, database, expectedName, profile, receipt, communityExpected] = process.argv.slice(2);
assert.match(account || "", /^[a-f\d]{32}$/u);
assert.match(database || "", /^[a-f\d-]{36}$/u);
assert.match(expectedName || "", /tokentracker.*(?:rehears|volume|validat|qa)/i);
assert.ok(profile && receipt && database !== "6fd95547-4042-40b0-82c6-cca13a279081");
process.umask(0o077);
const base = "https://api.cloudflare.com/client/v4/accounts/" + account + "/d1/database/" + database;
const prefix="tt_reportbench_"+randomBytes(5).toString("hex")+"_";
let credentials;
function token(){
  if (credentials && Date.parse(credentials.expiration_time)>Date.now()+90000) return credentials.oauth_token;
  const policy=statSync(profile);
  assert.ok(policy.uid===process.getuid() && !(policy.mode&0o077),"Use the private cf OAuth file");
  credentials=JSON.parse(readFileSync(profile,"utf8"));
  if (Date.parse(credentials.expiration_time)<=Date.now()+90000) {
    execFileSync(import.meta.dirname+"/../node_modules/.bin/cf",["auth","whoami"],{stdio:"ignore"});
    credentials=JSON.parse(readFileSync(profile,"utf8"));
  }
  assert.ok(Date.parse(credentials.expiration_time)>Date.now());
  return credentials.oauth_token;
}
async function api(path,body) {
  const r=await fetch(base+path,{method:body?"POST":"GET",redirect:"error",signal:AbortSignal.timeout(150000),
    headers:{Authorization:"Bearer "+token(),"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  const reply=await r.json();
  if (!r.ok||!reply.success) {
    const errors=(reply.errors||[]).map(e=>({code:e.code,reason:String(e.message||"").replace(/(['"]).*?\1/g,"[value]").slice(0,100)}));
    throw new Error("Cloudflare HTTP "+r.status+" "+JSON.stringify(errors));
  }
  return reply.result;
}
const info=await api("");
assert.equal(info.name,expectedName);
assert.equal(info.uuid,database);
const output={name:expectedName,database,prefix,counts:{},jobs:{},cleanup:false};
function save(){writeFileSync(receipt,JSON.stringify(output,null,2),{mode:0o600});}
let meter={};
let measuring=false;
async function query(batch) {
  const result=await api("/query",{batch});
  assert.equal(result.length,batch.length);
  for (const entry of result) {
    assert.equal(entry.success,true);
    if (measuring) {
      const m=entry.meta;
      meter.queries++;meter.read+=m.rows_read;meter.written+=m.rows_written;
      meter.sql_ms+=m.duration;meter.max_statement_ms=Math.max(m.duration,meter.max_statement_ms);
    }
  }
  return result;
}
const run=(sql,params=[])=>query([{sql,params}]).then(r=>r[0]);
const byName=new Map();
const created=[];
const writeTables=["report_refresh_claim","report_dirty_days","report_model_rates","community_snapshot",
  "tokentracker_user_badges","tokentracker_leaderboard_anomaly_flags","tokentracker_anticheat_run_state","tokentracker_leaderboard_snapshots"];
const rollup="tokentracker_leaderboard_rollup_daily_v2";
const shadow=name=>prefix+name;
const scopeTable=shadow("days_to_rebuild"),combined=shadow("rollup_read");
let compositeCreated=false,dayScopeCreated=false;
let repairMode=false;
// Map names in the hand-authored SQL, never in user records or bound values.
function rewrite(sql) {
  return sql.replace(/'(?:''|[^'])*'|\b[A-Za-z_]\w*\b/g,s=>{
    if(s===rollup){
      const writesRollup=/^\s*(INSERT\s+INTO|DELETE\s+FROM)\s+tokentracker_leaderboard_rollup_daily_v2\b/i.test(sql);
      return writesRollup?shadow(s):combined;
    }
    return byName.get(s)??s;
  });
}
function mutationSafe(sql) {
  for(const m of sql.matchAll(/\b(?:INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO|DELETE\s+FROM|UPDATE\s+(?!SET\b))\s*([A-Za-z_]\w*)/gi)) {
    if (m[1].toUpperCase() === "SET") continue; // ON CONFLICT ... DO UPDATE SET
    if (!m[1].startsWith(prefix))throw new Error("Mutation refused for non-scratch identifier "+m[1]);
  }
}
function statement(sql,params=[]) {
  const mapped=rewrite(sql);
  mutationSafe(mapped);
  const q={sql:mapped,params};
  return {q,bind:(...v)=>statement(sql,v),all:()=>run(mapped,params),run:()=>run(mapped,params),
    first:async field=>{const row=(await run(mapped,params)).results[0];return row?(field?row[field]:row):null;}};
}
const db={prepare:sql=>statement(sql),batch:ops=>query(ops.map(o=>o.q))};
function ddlMap(sql,original,uniqueName){
  const map=new Map(byName);
  map.set(rollup,shadow(rollup));if(uniqueName)map.set(original,uniqueName);
  return sql.replace(/'(?:''|[^'])*'|\b[A-Za-z_]\w*\b/g,s=>map.get(s)??s);
}
try{
 const built=(await build({stdin:{contents:'export {scheduledReports} from "./src/report-jobs"',resolveDir:import.meta.dirname+"/.."},
  bundle:true,write:false,target:"node24",platform:"node",format:"esm"})).outputFiles[0];
 const {scheduledReports}=await import("data:text/javascript;base64,"+Buffer.from(built.contents).toString("base64"));
 const n=await run("SELECT count(*) AS n FROM "+rollup);
 output.counts.rollup_rows=n.results[0].n;
 const smoke=process.env.TT_REPORT_HARNESS_SMOKE==="1";
 if (smoke) assert.equal(database,"607710e9-2229-460a-bb47-0256130c9e4b","QA mode requires the synthetic QA database");
 else assert.ok(output.counts.rollup_rows>500000,"Full historical rollup required");
 const dayRow=(await run("SELECT day,count(*) AS n FROM "+rollup+" GROUP BY day ORDER BY n DESC,day LIMIT 1")).results[0];
 if(!dayRow)throw new Error("An existing rollup day is required");
 output.repair_day=dayRow.day;
 for(const name of writeTables)byName.set(name,shadow(name));
 save();
 for(const name of [...writeTables,rollup]){
   const obj=(await run("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[name])).results[0];
   assert.ok(obj?.sql,name+" schema unavailable");
   await run(ddlMap(obj.sql));created.push(name);
   // The repair handler needs only its own day of the public rollup. Other handlers read the complete source rollup directly.
   if(!["report_refresh_claim","report_dirty_days","report_model_rates"].includes(name)){
     const filter=name===rollup?" WHERE day=?":"";
     await run("INSERT INTO "+shadow(name)+" SELECT * FROM "+name+filter,name===rollup?[dayRow.day]:[]);
   }
   const indexes=(await run("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",[name])).results;
   for (const idx of indexes) await run(ddlMap(idx.sql,idx.name,shadow(idx.name)));
 }
 for(const name of ["tokentracker_anticheat_run_state","tokentracker_leaderboard_anomaly_flags","tokentracker_leaderboard_snapshots"]){
   const triggers=(await run("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",[name])).results;
   for(const t of triggers){
     const sql=ddlMap(t.sql,t.name,shadow(t.name));
     mutationSafe(sql.replace(/^.*?\bBEGIN\b/is,""));
     await run(sql);
   }
 }
 await run("CREATE TABLE "+scopeTable+"(day TEXT PRIMARY KEY) STRICT");
 dayScopeCreated=true;
 await run("CREATE VIEW "+combined+" AS SELECT * FROM "+rollup+" r WHERE NOT EXISTS(SELECT 1 FROM "+scopeTable+" s WHERE s.day=r.day) UNION ALL SELECT * FROM "+shadow(rollup));
 compositeCreated=true;
 // The snapshot in PG combined its closed-day rollup with an open raw tail. Rebuild that tail locally on D1 too.
 const latest=(await run("SELECT max(day) AS latest FROM "+rollup)).results[0].latest;
 const dirty=(await run("SELECT DISTINCT substr(hour_start,1,10) AS day FROM tokentracker_hourly WHERE hour_start>? UNION SELECT DISTINCT substr(bucket_start,1,10) AS day FROM tokentracker_account_session_states WHERE bucket_start>? ORDER BY day",[latest+"T23:59:59.999999Z",latest+"T23:59:59.999999Z"])).results;
 await run("INSERT INTO "+scopeTable+" SELECT value FROM json_each(?)",[JSON.stringify([dayRow.day,...dirty.map(r=>r.day)])]);
 if(dirty.length)await run("INSERT INTO "+shadow("report_dirty_days")+" SELECT value FROM json_each(?)",[JSON.stringify(dirty.map(r=>r.day))]);
 const schedules={monthly:"17,47 * * * *",total:"23 */6 * * *",badges:"32 */6 * * *",community:"17 * * * *",anomalies:"41 * * * *",repair:"*/10 * * * *",retention:"12 4 * * *",total_warm:"23 */6 * * *"};
 for(const [job,schedule] of Object.entries(schedules)){
   repairMode=job==="repair";
   if (repairMode) await run("INSERT OR IGNORE INTO "+shadow("report_dirty_days")+" VALUES (?)",[dayRow.day]);
   if(job==="total_warm") await run("DELETE FROM "+shadow("report_refresh_claim")+" WHERE kind='total'");
   meter={queries:0,read:0,written:0,sql_ms:0,max_statement_ms:0};measuring=true;
   const t=Date.now();
   try{await scheduledReports(schedule,{DB:db,LEADERBOARD_BLOCKED_USER_IDS:""});output.jobs[job]={ok:true};}
   catch(error){output.jobs[job]={ok:false,error:error.message.slice(0,300)};}
   measuring=false;output.jobs[job]={...output.jobs[job],...meter,wall_ms:Date.now()-t};
   save();console.log(job,JSON.stringify(output.jobs[job]));
   if(job==="community" && output.jobs[job].ok && communityExpected) {
     const result=JSON.parse((await run("SELECT payload FROM "+shadow("community_snapshot")+" WHERE id='total'")).results[0].payload);
     const old=JSON.parse(readFileSync(communityExpected,"utf8"));
     const keys={top_models:"name",providers:"name",daily_growth:"day",token_mix:"key",user_distribution:"key",platforms:"name"};
     const mismatch=[];
     for(const [k,v] of Object.entries(old)){
       const comparable=x=>Array.isArray(x)?x.map(r=>Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b)))).sort((a,b)=>String(a[keys[k]]).localeCompare(String(b[keys[k]]))):x;
       if(JSON.stringify(comparable(v))!==JSON.stringify(comparable(result[k])))mismatch.push(k);
     }
     output.community_parity={field_count:Object.keys(old).length,mismatch,source_total:old.total_tokens,target_total:result.total_tokens};
     save();
   }
 }
}finally{
 measuring=false;repairMode=false;
 if(compositeCreated)await run("DROP VIEW "+combined);
 if(dayScopeCreated)await run("DROP TABLE "+scopeTable);
 for(const name of created.reverse())await run("DROP TABLE "+shadow(name));
 output.cleanup=true;save();
}
if(Object.values(output.jobs).some(r=>!r.ok))process.exitCode=1;
