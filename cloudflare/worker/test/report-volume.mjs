// Benchmark the scheduled report handlers against a disposable, private copy of a restored D1-format snapshot.
// No database rows or identities are returned in the receipt.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { constants, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";

const [source, copy, receipt, communityExpected] = process.argv.slice(2).map(resolvePath);
function resolvePath(value) { return resolve(value); }
assert.ok(source && copy && receipt && dirname(source) === dirname(copy));
assert.ok(!existsSync(copy), "Pass a new, private output filename");
process.umask(0o077);
copyFileSync(source, copy, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
const database = new DatabaseSync(copy);
database.exec("PRAGMA cache_size=-49152;PRAGMA temp_store=FILE;PRAGMA synchronous=NORMAL");
const measurements = [];
const output = {database:"local SQLite clone", limits_seconds_per_D1_statement:30, counts:{}, jobs:{}};
let key = "";
function canonicalFields(input, key) {
  if (!Array.isArray(input)) return input;
  const rows=input.map(row=>Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))));
  return rows.sort((a,b)=>String(a[key]).localeCompare(String(b[key])));
}
function complete(t0, sql) {
  measurements.push({job:key,kind:sql.trim().slice(0,26).replace(/\s+/g," "), milliseconds:Math.round(performance.now()-t0)});
}
function statement(sql,values=[]) {
  // Explicit numbering permits mixing ?1 and ? as D1 does. SQL literals don't need bindings.
  let slot=0;
  const named = sql.replace(/'(?:''|[^'])*'|\?(\d*)/g, (match,n)=>{
    if(match[0]!=="?") return match;
    const index=n?Number(n):slot+1; slot=Math.max(slot,index); return ":v"+index;
  });
  const params=Object.fromEntries(values.map((v,i)=>["v"+(i+1),v]));
  const exec=(read)=>{
    const start=performance.now();
    const st=database.prepare(named);
    const rows=read || st.columns().length ? st.all(params) : null;
    const changes=rows===null ? Number(st.run(params).changes) : Number(database.prepare("SELECT changes() AS n").get().n);
    complete(start,sql);
    return {results:rows??[],meta:{changes}};
  };
  return {bind:(...v)=>statement(sql,v),run:()=>exec(false),all:()=>exec(true),
    first:(col)=>{const r=exec(true).results[0]; return r?(col ? r[col]:r):null;}};
}
const d1={prepare:sql=>statement(sql),batch:statements=>{
  database.exec("BEGIN IMMEDIATE");
  try{const r=statements.map(s=>s.run());database.exec("COMMIT");return r;}
  catch(error){database.exec("ROLLBACK"); throw error;}
}};
try {
  const built=await build({stdin:{contents:`export {scheduledReports} from "./src/report-jobs";
    export {prepareReportDays} from "./src/report-refresh";`,resolveDir:import.meta.dirname+"/.."},bundle:true,write:false,
    platform:"node",format:"esm",target:"node24"});
  const {scheduledReports,prepareReportDays}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].contents).toString("base64"));
  const env={DB:d1,LEADERBOARD_BLOCKED_USER_IDS:""};
  for(const table of ["tokentracker_hourly","tokentracker_devices","tokentracker_account_session_states","tokentracker_leaderboard_rollup_daily_v2","tokentracker_telemetry_daily","tokentracker_user_badges","report_dirty_days"]) {
    output.counts[table]=database.prepare("SELECT count(*) AS n FROM "+table).get().n;
  }
  // Restored rollup rows cover closed days. Sample the busiest recent raw day and mark it dirty.
  const day=database.prepare("SELECT day,count(*) AS n FROM tokentracker_leaderboard_rollup_daily_v2 GROUP BY day ORDER BY n DESC LIMIT 1").get()?.day;
  assert.ok(day && output.counts.tokentracker_hourly>100000,"Full restored data required");
  const watermark = database.prepare("SELECT max(day) AS last FROM tokentracker_leaderboard_rollup_daily_v2").get().last;
  // The restored archive contains closed-day rollups. Append all open raw days.
  database.prepare("INSERT INTO report_dirty_days SELECT DISTINCT substr(hour_start,1,10) AS day FROM tokentracker_hourly WHERE day>? ON CONFLICT(day) DO NOTHING").run(watermark);
  database.prepare("INSERT INTO report_dirty_days SELECT DISTINCT substr(bucket_start,1,10) AS day FROM tokentracker_account_session_states WHERE day>? ON CONFLICT(day) DO NOTHING").run(watermark);
  output.repair_day=day;
  // Drain pending history outside of per-period timings; each iteration uses the actual bounded handler.
  for(let i=0;i<400;i++){
    key="rollup_initialization";
    if(await prepareReportDays(d1,32))break;
    if(i===399) throw new Error("Dirty-day queue failed to drain");
  }
  output.initialized_days_max_ms=Math.max(0,...measurements.filter(m=>m.job==="rollup_initialization").map(m=>m.milliseconds));
  database.exec("DELETE FROM report_refresh_claim");
  function compareCommunity() {
    if (!communityExpected) return;
    const old=JSON.parse(readFileSync(communityExpected,"utf8"));
    const result=JSON.parse(database.prepare("SELECT payload FROM community_snapshot").get().payload);
    const sortKeys={top_models:"name",providers:"name",daily_growth:"day",token_mix:"key",user_distribution:"key",platforms:"name"};
    const mismatches=[];
    for (const [key,value] of Object.entries(old)){
      const normalize=(v)=>canonicalFields(v,sortKeys[key]);
      if(JSON.stringify(normalize(value))!==JSON.stringify(normalize(result[key]))) {
        const a=normalize(value),b=normalize(result[key]);
        if(Array.isArray(a)&&Array.isArray(b)) {
          const differentFields={};
          for(let i=0;i<a.length&&i<b.length;i++)for(const field of Object.keys(a[i]))
            if(a[i][field]!==b[i][field])differentFields[field]=(differentFields[field]||0)+1;
          mismatches.push({key,old_count:a.length,new_count:b.length,differentFields});
        }else mismatches.push({key,source:value,target:result[key]});
      }
    }
    output.community_parity={fields_compared:Object.keys(old).length,mismatches,source_total:old.total_tokens,
      target_total:result.total_tokens,source_growth:old.token_growth_pct,target_growth:result.token_growth_pct};
    console.log("community_parity",JSON.stringify(output.community_parity));
  }
  for(const [label,expr] of Object.entries({monthly:"17,47 * * * *",total:"23 */6 * * *",badges:"32 */6 * * *",community:"17 * * * *",
    anomalies:"41 * * * *",repair:"*/10 * * * *",retention:"12 4 * * *"})){
    key=label;
    if(label==="repair")database.prepare("INSERT INTO report_dirty_days VALUES (?) ON CONFLICT(day) DO NOTHING").run(day);
    const start=performance.now();
    try{await scheduledReports(expr,env);output.jobs[label]={ok:true};}
    catch(e){output.jobs[label]={ok:false,error:e.message.slice(0,150)};}
    const times=measurements.filter(m=>m.job===label);
    output.jobs[label].wall_ms=Math.round(performance.now()-start);
    output.jobs[label].statements=times.length;
    output.jobs[label].max_statement_ms=Math.max(0,...times.map(t=>t.milliseconds));
    if(label==="community" && output.jobs[label].ok) compareCommunity();
    writeFileSync(receipt,JSON.stringify(output,null,2),{mode:0o600});
    console.log(label,JSON.stringify(output.jobs[label]));
  }
}finally{
  database.close();
  rmSync(copy,{force:true});rmSync(copy+"-shm",{force:true});rmSync(copy+"-wal",{force:true});
}
