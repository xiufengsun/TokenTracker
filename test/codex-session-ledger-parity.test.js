const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const runtime = process.env.TOKENTRACKER_TEST_RUNTIME || path.join(__dirname, "..");
const { scanCodexSession, buildSessionAnalytics } = require(path.join(runtime, "src/lib/session-analytics"));
const { parseRolloutIncremental } = require(path.join(runtime, "src/lib/rollout"));
const usage = n => ({ input_tokens:n, cached_input_tokens:0, output_tokens:0, reasoning_output_tokens:0, total_tokens:n });
const record = (ms,last,total) => ({ timestamp:new Date(Date.UTC(2026,6,2,0,0,0,ms)).toISOString(), type:"event_msg", payload:{type:"token_count",info:{last_token_usage:usage(last),total_token_usage:usage(total)}} });
const context = (ms, model, date="2026-07-02") => ({ timestamp:new Date(Date.UTC(2026,6,2,0,0,0,ms)).toISOString(),type:"turn_context",payload:{model,current_date:date}});
for (const crossDay of [false,true]) test(`session usage matches ledger for ${crossDay ? 'cross-day' : 'same-day'} forks and duplicate copies`, async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"tt-session-ledger-"));
  try {
    const id="11111111-1111-4111-8111-111111111111";
    const file=path.join(directory,`rollout-2026-07-02T00-00-00-${id}.jsonl`);
    const reset=record(12000,0,0);reset.payload.info.last_token_usage.total_tokens=5000;
    const records=[{timestamp:"2026-07-02T00:00:00.000Z",type:"session_meta",payload:{id,forked_from_id:"parent"}},...(crossDay ? [context(0,"parent-model","2026-07-01")] : []),record(1,10,10),record(2,20,30),context(3,"model-a"),record(4,30,60),record(10000,40,100),reset,context(15000,"model-b"),record(20000,50,50)];
    await fs.writeFile(file,records.map(x=>JSON.stringify(x)+"\n").join(""));
    const cursors={hourly:{version:3,buckets:{},groupQueued:{},modelAttributionPolicy:{codex:"observed"}}};
    await parseRolloutIncremental({rolloutFiles:[file],cursors,queuePath:path.join(directory,"queue.jsonl")});
    const expected=Object.fromEntries(Object.entries(cursors.hourly.buckets).map(([key,bucket])=>[key.split("|")[1],bucket.totals.total_tokens]));
    const row=await scanCodexSession(file);
    assert.deepEqual(Object.fromEntries(row.model_usage.filter(x=>x.total_tokens>0).map(x=>[x.model,x.total_tokens])),expected);
    assert.equal(row.tokens.total_tokens,crossDay ? 90 : 100);
    const copied=path.join(directory,"copy",path.basename(file));await fs.mkdir(path.dirname(copied));await fs.copyFile(file,copied);
    const union=await scanCodexSession([file,copied]);assert.equal(union.tokens.total_tokens,row.tokens.total_tokens);
    assert.deepEqual(union.model_usage.map(x=>[x.model,x.total_tokens]),row.model_usage.map(x=>[x.model,x.total_tokens]));
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test("session ledger preserves total-only legacy usage before timestamp deduplication",async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"tt-session-reported-total-"));
  try{
    const id="22222222-2222-4222-8222-222222222222";
    const file=path.join(directory,`rollout-2026-07-02T00-00-00-${id}.jsonl`);
    const first=record(1,0,10000);first.payload.info.last_token_usage.total_tokens=42;
    const records=[{timestamp:"2026-07-02T00:00:00.000Z",type:"session_meta",payload:{id}},first,context(1,"model-a"),record(1,60,10060)];
    await fs.writeFile(file,records.map(x=>JSON.stringify(x)+"\n").join(""));
    const row=await scanCodexSession(file);assert.equal(row.tokens.total_tokens,42);
    assert.deepEqual(row.model_usage.filter(x=>x.total_tokens>0).map(x=>[x.model,x.total_tokens]),[["unknown",42]]);
    assert.equal(row.usage_buckets.reduce((n,r)=>n+r.total_tokens,0),42);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test("unversioned Codex cache is rebuilt and survives reload while other sources retain their rows",async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"tt-codex-cache-version-"));
  try{
    const id="33333333-3333-4333-8333-333333333333";
    const file=path.join(home,".codex/sessions/2026/07/02",`rollout-2026-07-02T00-00-00-${id}.jsonl`);
    await fs.mkdir(path.dirname(file),{recursive:true});
    const records=[{timestamp:"2026-07-02T00:00:00.000Z",type:"session_meta",payload:{id,forked_from_id:"parent"}},record(1,10,10),record(2,20,30)];
    await fs.writeFile(file,records.map(x=>JSON.stringify(x)+"\n").join(""));
    const claude=path.join(home,".claude/projects/test/session.jsonl");await fs.mkdir(path.dirname(claude),{recursive:true});
    await fs.writeFile(claude,JSON.stringify({timestamp:"2026-07-02T00:00:01.000Z",type:"assistant",sessionId:"claude-session",uuid:"message-one",message:{id:"message-one",model:"claude-sonnet-4",usage:{input_tokens:7,output_tokens:3},content:[]}})+"\n");
    const first=await buildSessionAnalytics({home});assert.equal(first.find(r=>r.source==="codex").total_tokens,10);
    const preserved=first.filter(r=>r.source!=="codex");assert.equal(preserved.length,1);
    const queue=path.join(home,".tokentracker/tracker/session.queue.jsonl");
    const rows=(await fs.readFile(queue,"utf8")).trim().split("\n").map(JSON.parse);
    for(const row of rows)if(row.source==="codex"){row.total_tokens=999;row.tokens.total_tokens=999;row.model_usage[0].total_tokens=999;row.usage_buckets[0].total_tokens=999;}
    await fs.writeFile(queue,rows.map(r=>JSON.stringify(r)+"\n").join(""));
    const meta=JSON.parse(await fs.readFile(queue+".meta.json"));delete meta.codex_usage_version;await fs.writeFile(queue+".meta.json",JSON.stringify(meta));
    const second=await buildSessionAnalytics({home});assert.equal(second.find(r=>r.source==="codex").total_tokens,10);
    assert.deepEqual(second.filter(r=>r.source!=="codex"),preserved);
    assert.equal(JSON.parse(await fs.readFile(queue+".meta.json")).codex_usage_version,1);
    const cached=await buildSessionAnalytics({home});const codex=cached.find(r=>r.source==="codex");
    assert.equal(codex.total_tokens,10);assert.equal(codex.model_usage[0].total_tokens,10);assert.equal(codex.usage_buckets[0].total_tokens,10);
  }finally{await fs.rm(home,{recursive:true,force:true});}
});
