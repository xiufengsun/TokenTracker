import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {accountUsage,reportClock} from "../src/report-usage.ts";

const f=JSON.parse(readFileSync(process.argv[2],"utf8")),sqlite=new DatabaseSync(":memory:");
for(const file of ["0002_hourly","0010_devices"]) sqlite.exec(readFileSync(new URL("../../migrations/"+file+".sql",import.meta.url),"utf8"));
// The source comparison covers legacy rows with NULL evidence.
sqlite.exec(readFileSync(new URL("../../migrations/0043_usage_cost_coverage.sql",import.meta.url),"utf8").split(";")[0]);
const insert=(table,cols,rows)=> {
  if(!rows?.length)return;
  const st=sqlite.prepare("INSERT INTO "+table+"("+cols+") VALUES("+rows[0].map(()=>"?").join(",")+")");
  for(const row of rows)st.run(...row);
};
insert("tokentracker_devices","id,user_id,device_name,revoked_at,created_at",f.devices.map(([id,user,revoked])=>[id,user,id,revoked?"revoked":null,"2020-01-01"]));
insert("tokentracker_device_machine","device_id,machine_cluster_id",f.machine);
const fields="total_tokens,input_tokens,output_tokens,cached_input_tokens,cache_creation_input_tokens,reasoning_output_tokens";
insert("tokentracker_hourly","user_id,device_id,source,model,hour_start,"+fields+",conversations,updated_at,created_at",f.hourly.map(r=>[...r,r[4]]));
insert("tokentracker_account_session_states","user_id,source,model,bucket_start,"+fields+",session_id,snapshot_verified_at,updated_at",
 (f.sessions||[]).map((r,i)=>[...r,String(i),r[3],r[3]]));
const d1={prepare(sql){return {bind(...values){return {all(){
  // node:sqlite accepts a named parameter map; make SQLite's numbered and anonymous
  // slots explicit to give it the same binding order as Workers D1PreparedStatement.
  let slot=0;
  const namedSql=sql.replace(/\?(\d*)/g,(_,n)=>{
    const index=n?Number(n):slot+1;slot=Math.max(slot,index);return ":p"+index;
  });
  const params=Object.fromEntries(values.map((v,i)=>["p"+(i+1),v]));
  return {results:sqlite.prepare(namedSql).all(params)};
}};}};}};
let compared=0;
for(const [i,id] of f.order.entries()) for(const [j,[bucket,tz,offset,from,to]] of f.cases.entries()){
  const actual=await accountUsage(d1,id,null,from,to,bucket,reportClock(tz,String(offset)));
  const expected=f.expected[i][j];
  const key=r=>JSON.stringify([r.bucket,r.source,r.model,r.pricing_tier]);
  const ordered=(a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0;
  actual.sort(ordered);expected.sort(ordered);
  if(actual.length!==expected.length)throw new Error("group count differs: cohort "+i+", case "+j+", actual="+actual.length+", expected="+expected.length+", days="+JSON.stringify([actual.map(r=>r.bucket).slice(0,3),expected.map(r=>r.bucket).slice(0,3)]));
  for(let n=0;n<actual.length;n++){
    for(const [k,v] of Object.entries(expected[n]))if(actual[n][k]!==v)throw new Error("group field differs: "+k+", cohort "+i+", case "+j);
  }
  compared+=actual.length;
}
console.log(JSON.stringify({source:"deployed Postgres account_usage_grouped_v2",snapshot:"2026-10-31 to 11-04 UTC",
  accounts:f.order.length,devices:f.devices.length,hourly_rows:f.hourly.length,sessions:f.sessions?.length??0,comparisons:f.order.length*f.cases.length,
  grouped_rows_compared:compared,matched:true}));
