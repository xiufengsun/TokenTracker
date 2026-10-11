const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {plan,publicKey,parse,initializeProducer}=require('../scripts/self-host/acceptance.cjs');

test('self-host acceptance plan is read-only and restricts both targets to distinct loopback origins',()=>{
  const value=plan({a:'http://127.0.0.1:8730',c:'http://127.0.0.1:8750'});
  assert.equal(value.applied,false);
  for(const a of ['https://srctyff5.us-east.insforge.app','http://example.invalid','http://127.0.0.1:8730/path','http://admin:password@127.0.0.1:8730'])
    assert.throws(()=>plan({a,c:'http://127.0.0.1:8750'}));
  assert.throws(()=>plan({a:'http://127.0.0.1:8730',c:'http://127.0.0.1:8730'}));
});

test('private acceptance config rejects exposed files and privileged credentials',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tt-acceptance-key-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'server.env');
  fs.writeFileSync(file,'ACCESS_ANON_KEY=anon_'+ 'a'.repeat(40)+'\n',{mode:0o600});
  // POSIX mode bits cannot certify NTFS privacy. The existing reader refuses
  // this fixture on Windows; never weaken its guard to make acceptance pass.
  if(process.platform==='win32') {
    assert.throws(()=>publicKey(file),/Server environment must be private/);
    return;
  }
  assert.equal(publicKey(file),'anon_'+ 'a'.repeat(40));
  fs.chmodSync(file,0o644);assert.throws(()=>publicKey(file));
  fs.chmodSync(file,0o600);fs.writeFileSync(file,'ACCESS_ANON_KEY=ik_'+ 'a'.repeat(40)+'\n');
  assert.throws(()=>publicKey(file));
});

test('default CLI plan does not require credentials, write a directory or call a backend',()=>{
  const directory=path.join(os.tmpdir(),'tt-plan-unused-'+Date.now());
  const result=spawnSync(process.execPath,['scripts/self-host/acceptance.cjs','--plan','--a','http://127.0.0.1:57300','--c','http://127.0.0.1:57500','--directory',directory],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).applied,false);
  assert.equal(fs.existsSync(directory),false);
  assert.throws(()=>parse(['--unrestricted']));
});

test('production parser initializes canonical private data without personal roots or cloud upload',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'tt-canonical-acceptance-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const tracker=path.join(home,'.tokentracker/tracker');
  fs.mkdirSync(tracker,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(tracker,'config.json'),'{"telemetry":false}\n',{mode:0o600});
  fs.writeFileSync(path.join(tracker,'cloud-sync-pref.json'),'{"enabled":false}\n',{mode:0o600});
  const previousHome=process.env.HOME;
  const result=initializeProducer(home,tracker);
  assert.equal(result.parser_exit,0);
  assert.equal(result.no_cloud_upload,true);
  assert.equal(process.env.HOME,previousHome);
  const cursor=JSON.parse(fs.readFileSync(path.join(tracker,'cursors.json')));
  assert.equal(Object.keys(cursor.hourly.buckets).length,1);
  assert.equal(Object.keys(cursor.files).length,1);
  assert.ok(Object.keys(cursor.files).every(file=>file.startsWith(home+path.sep)));
  const rows=result.queue.trim().split('\n').map(row=>JSON.parse(row));
  assert.equal(rows.reduce((sum,row)=>sum+row.total_tokens,0),333);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tracker,'cloud-sync-pref.json'))).enabled,false);
});
