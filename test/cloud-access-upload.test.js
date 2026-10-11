const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {drainQueueToCloud}=require('../src/commands/sync');
const {publicAnonFor}=require('./helpers/public-instance-fixture');

test('real HTTP batches share a bounded upload id and commit queue offsets only after accepted writes',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tt-cloud-access-upload-'));
  const queue=path.join(dir,'queue.jsonl'),state=path.join(dir,'queue.state.json');
  const lines=[10,20,30].map((total,i)=>JSON.stringify({source:'codex',model:'gpt-6',hour_start:`2026-10-04T0${i}:00:00Z`,
    input_tokens:total,total_tokens:total,conversation_count:1})+'\n');
  await fs.writeFile(queue,lines.join(''));
  let deny=true;const bodies=[];
  const anonKey=publicAnonFor('cloud-access-upload');
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    assert.equal(req.headers.apikey,anonKey);
    bodies.push(JSON.parse(raw));
    if(deny&&bodies.length===2){
      res.writeHead(429,{'Content-Type':'application/json','Retry-After':'72000'});
      res.end(JSON.stringify({code:'cloud_sync_throttled',next_allowed_at:'2026-10-05T00:00:00Z'}));return;
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,inserted:1,skipped:0,next_allowed_at:'2026-10-05T00:00:00Z',sync_interval_seconds:86400}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const args={baseUrl:`http://127.0.0.1:${server.address().port}`,anonKey,deviceToken:'isolated-device-token',queuePath:queue,
    queueStatePath:state,batchSize:1,maxBatches:5};
  await assert.rejects(drainQueueToCloud(args),error=>{
    assert.equal(error.code,'cloud_sync_throttled');assert.equal(error.retryAfterMs,72000_000);return true;
  });
  assert.equal(JSON.parse(await fs.readFile(state,'utf8')).offset,Buffer.byteLength(lines[0]));
  assert.equal(bodies[0].upload_id,bodies[1].upload_id);
  deny=false;
  const resumed=await drainQueueToCloud(args);
  assert.equal(resumed.inserted,2);assert.equal(resumed.cloudAccess.sync_interval_seconds,86400);
  assert.equal(bodies[2].hourly[0].total_tokens,20,'the rejected row must be retried');
  assert.equal(JSON.parse(await fs.readFile(state,'utf8')).offset,Buffer.byteLength(lines.join('')));
  assert.equal(bodies[2].upload_id,bodies[3].upload_id);assert.notEqual(bodies[0].upload_id,bodies[2].upload_id);
});
