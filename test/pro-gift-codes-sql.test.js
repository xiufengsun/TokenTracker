const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const ops = require('../scripts/pro-gift-codes.cjs');

test('operator-generated codes cross the real HTTP/SQL contract and redeem once without financial rows', {skip:process.platform==='win32'}, async () => {
  const db = new PGlite();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-gift-ops-sql-'));
  const file = path.join(await fs.realpath(folder), 'private-codes.json');
  let server;
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
      CREATE TABLE tokentracker_devices(id uuid,user_id uuid,created_at timestamptz);
      CREATE TABLE tokentracker_user_settings(user_id uuid PRIMARY KEY,leaderboard_anonymous boolean);
      GRANT USAGE ON SCHEMA auth TO project_admin; GRANT SELECT ON auth.users,tokentracker_devices,tokentracker_user_settings TO project_admin;`);
    for (const name of ['20261003120000_cloud-subscriptions.sql','20261007120000_cloud-waffo.sql',
      '20261007130000_cloud-waffo-retry.sql','20261007140000_cloud-waffo-attempts.sql',
      '20261007150000_cloud-waffo-authorizations.sql','20261007160000_cloud-waffo-sandbox-periods.sql',
      '20261008120000_self-hosted-access.sql','20261009120000_cloud-gifts.sql']) {
      await db.exec(await fs.readFile(path.join(__dirname,'../migrations',name),'utf8'));
    }
    await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now()-interval '1 hour' WHERE environment='sandbox'");
    server = createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, 'Bearer unit-operator');
        const name = req.url.match(/^\/api\/database\/rpc\/(cloud_[a-z_]+)$/)?.[1];
        assert.ok(name);
        const chunks = []; for await (const c of req) chunks.push(c);
        const input = JSON.parse(Buffer.concat(chunks));
        assert.ok(!JSON.stringify(input).includes('TT-PRO-'));
        const entries = Object.entries(input);
        for (const [key] of entries) assert.match(key, /^p_[a-z_]+$/);
        const result = await db.transaction(async tx => {
          await tx.exec('SET LOCAL ROLE project_admin');
          return tx.query(`SELECT public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) AS value`,
            entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
        });
        res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(result.rows[0].value));
      } catch { res.statusCode = 500; res.end('{}'); }
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const rpc = ops.createRpcClient(baseUrl,'unit-operator');
    const config = { baseUrl };
    const receipt = await ops.run({ action:'generate',environment:'sandbox',days:30,count:2,
      expires:new Date(Date.now()+86400000).toISOString(),label:'Actual SQL contract',out:file },config,rpc);
    assert.equal(receipt.count,2);
    const resumed = await ops.run({action:'generate',environment:'sandbox',resume:file},config,rpc);
    assert.equal(resumed.batch_id,receipt.batch_id); assert.equal(resumed.reused,true);
    const batch = JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(batch.codes[0].suffix.length,8);
    const id = randomUUID(); await db.query('INSERT INTO auth.users VALUES($1)',[id]);
    const request = {p_user_id:id,p_environment:'sandbox',p_code_hash:ops.codeHash(batch.codes[0].code),p_request_id:randomUUID()};
    const claim = await rpc('cloud_redeem_gift',request);
    assert.equal(claim.ok,true); assert.equal(claim.membership.status,'active'); assert.equal(claim.membership.access_source,'gift');
    const repeat = await rpc('cloud_redeem_gift',{...request,p_request_id:randomUUID()});
    assert.equal(repeat.reused,true); assert.equal(repeat.gift.id,claim.gift.id); assert.equal(repeat.gift.ends_at,claim.gift.ends_at);
    await ops.run({action:'disable',environment:'sandbox',batch:receipt.batch_id},config,rpc);
    await assert.rejects(rpc('cloud_redeem_gift',{...request,p_code_hash:ops.codeHash(batch.codes[1].code),p_request_id:randomUUID()}), /rejected/);
    assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_cloud_gift_grants')).rows[0].n,1);
    const existing = await rpc('cloud_membership',{p_user_id:id,p_environment:'sandbox'}); assert.equal(existing.status,'active');
    const listed = await ops.run({action:'codes',environment:'sandbox',batch:receipt.batch_id},config,rpc);
    assert.equal(listed.length,2); assert.ok(!JSON.stringify(listed).includes(batch.codes[0].code_hash));
    assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_cloud_payments')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_cloud_orders')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM tokentracker_cloud_subscriptions')).rows[0].n,0);
  } finally {
    if(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close(); await fs.rm(folder,{recursive:true,force:true});
  }
});
