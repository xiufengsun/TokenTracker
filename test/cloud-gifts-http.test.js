const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes, createHash, createHmac } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const billing = require('./helpers/load-cloud-module')('../tokentracker-billing').default;
const fetch = globalThis.fetch;
const previousDeno = globalThis.Deno;
const secret = 'isolated-gift-http-auth-only';
let db, server, base, env;
const sign = (sub, role = 'authenticated') => {
  const head = Buffer.from(JSON.stringify({alg:'HS256'})).toString('base64url');
  const claims = Buffer.from(JSON.stringify({sub,role,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  return head+'.'+claims+'.'+createHmac('sha256',secret).update(head+'.'+claims).digest('base64url');
};
const identifier = value => { assert.match(value,/^[a-z_][a-z0-9_]*$/i); return '"'+value+'"'; };
test.before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
    CREATE TABLE tokentracker_devices(id uuid PRIMARY KEY,user_id uuid,created_at timestamptz DEFAULT now());
    CREATE TABLE tokentracker_user_settings(user_id uuid PRIMARY KEY,leaderboard_anonymous boolean DEFAULT false);
    GRANT USAGE ON SCHEMA auth TO project_admin; GRANT SELECT(id) ON auth.users TO project_admin;
    GRANT SELECT ON tokentracker_devices,tokentracker_user_settings TO project_admin;`);
  for (const name of ['20261003120000_cloud-subscriptions.sql','20261007120000_cloud-waffo.sql',
    '20261007130000_cloud-waffo-retry.sql','20261007140000_cloud-waffo-attempts.sql',
    '20261007150000_cloud-waffo-authorizations.sql','20261007160000_cloud-waffo-sandbox-periods.sql',
    '20261008120000_self-hosted-access.sql','20261009120000_cloud-gifts.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',name),'utf8'));
  }
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now()-interval '1 hour' WHERE environment='sandbox'");
  server = http.createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url,base);
    const send = (status,data) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    try {
      if (url.pathname==='/functions/billing') {
        const result = await billing(new Request(url,{method:req.method,headers:req.headers,...(raw?{body:raw}:{})}));
        res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;
      }
      assert.equal(req.headers.authorization,'Bearer '+env.INSFORGE_SERVICE_ROLE_KEY);
      await db.transaction(async tx => {
        await tx.exec('SET LOCAL ROLE project_admin');
        if (url.pathname.startsWith('/api/database/rpc/')) {
          const params = JSON.parse(raw||'{}'), keys = Object.keys(params);
          const result = await tx.query('SELECT '+identifier(url.pathname.split('/').pop())+'('+keys.map((key,i)=>identifier(key)+' => $'+(i+1)).join(',')+') AS r',
            keys.map(key=>params[key]));
          send(200,result.rows[0].r);return;
        }
        assert.ok(url.pathname.startsWith('/api/database/records/'));
        const params = [], filters = [];
        for (const [key,value] of url.searchParams) {
          if (['select','order','limit'].includes(key)) continue;
          if (value.startsWith('eq.')) {params.push(value.slice(3));filters.push(identifier(key)+'=$'+params.length);}
          else if (value==='not.is.null') filters.push(identifier(key)+' IS NOT NULL');
          else if (value.startsWith('in.(')) {params.push(value.slice(4,-1).split(','));filters.push(identifier(key)+'=ANY($'+params.length+'::text[])');}
          else throw Error('unsupported fixture filter');
        }
        const fields = url.searchParams.get('select')||'*';
        let sql = 'SELECT '+(fields==='*'?'*':fields.split(',').map(identifier).join(','))+' FROM '+identifier(url.pathname.split('/').pop());
        if (filters.length) sql += ' WHERE '+filters.join(' AND ');
        if (url.searchParams.has('order')) {
          const [field,dir] = url.searchParams.get('order').split('.');sql += ' ORDER BY '+identifier(field)+(dir==='desc'?' DESC':' ASC');
        }
        sql += ' LIMIT '+Math.min(100,Number(url.searchParams.get('limit'))||100);
        const result = await tx.query(sql,params);
        send(200,req.headers.accept?.includes('vnd.pgrst.object')?result.rows[0]:result.rows);
      });
    } catch (error) { send(500,{code:error.code||'FIXTURE_ERROR',message:error.message}); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  env = {INSFORGE_BASE_URL:base,INSFORGE_SERVICE_ROLE_KEY:sign(randomUUID(),'project_admin'),ANON_KEY:sign(randomUUID(),'anon'),
    JWT_SECRET:secret,TOKENTRACKER_BILLING_ENVIRONMENT:'sandbox'};
  globalThis.Deno = {env:{get:key=>env[key]}};
  globalThis.fetch = (input,init) => {
    const url = new URL(typeof input==='string'?input:input.url||input.href);
    assert.equal(url.origin,base,'gift flows must never call a payment provider');return fetch(input,init);
  };
});
test.after(async () => { globalThis.fetch=fetch;if(previousDeno===undefined)delete globalThis.Deno;else globalThis.Deno=previousDeno;
  await new Promise(resolve=>server.close(resolve));await db.close(); });
async function user() {const id=randomUUID();await db.query('INSERT INTO auth.users VALUES($1)',[id]);return id;}
async function code() {
  const hex = randomBytes(16).toString('hex').toUpperCase(), raw='TT-PRO-'+hex.match(/.{8}/g).join('-');
  await db.query('SELECT cloud_create_gift_batch($1,$2,$3,$4,$5,$6)',['sandbox',randomUUID(),30,
    new Date(Date.now()+86400000).toISOString(),'HTTP acceptance',JSON.stringify([{code_hash:createHash('sha256').update('TTPRO'+hex).digest('hex'),suffix:hex.slice(-8)}])]);
  return raw;
}
async function api(id,action,value,method) {
  const response = await fetch(base+'/functions/billing?action='+action,{method:method||(value===undefined?'GET':'POST'),
    headers:{...(id?{Authorization:'Bearer '+sign(id)}:{}),'Content-Type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});
  return {response,data:await response.json()};
}

test('actual billing HTTP and SDK redeem for the authenticated actor and server environment without payment setup', async () => {
  const id=await user(), other=await user(), raw=await code(), request=randomUUID();
  const before=await api(id,'account'); assert.equal(before.response.status,200);assert.equal(before.data.gift_redemption_available,true);
  const redeemed=await api(id,'redeem-gift',{code:raw.toLowerCase(),request_id:request,user_id:other,environment:'live'});
  assert.equal(redeemed.response.status,200);assert.equal(redeemed.data.membership.status,'active');
  assert.equal(redeemed.data.membership.environment,'sandbox');assert.equal(redeemed.data.already_redeemed,false);
  assert.equal(redeemed.response.headers.get('cache-control'),'no-store');
  const retry=await api(id,'redeem-gift',{code:raw,request_id:request});assert.equal(retry.data.already_redeemed,true);
  const account=await api(id,'account');assert.equal(account.response.status,200);assert.equal(account.data.gifts[0].id,redeemed.data.gift.id);
  assert.ok(!JSON.stringify(account.data).includes(raw));assert.deepEqual(account.data.payments,[]);assert.deepEqual(account.data.subscriptions,[]);
  assert.equal((await api(other,'redeem-gift',{code:raw,request_id:randomUUID()})).data.error,'gift_code_unavailable');
  assert.equal((await api(other,'account')).data.membership.status,'free');
});

test('unauthenticated and wrong-method requests cannot consume a code; malformed codes get persistent HTTP rate limits', async () => {
  const raw=await code(), id=await user();
  assert.equal((await api(null,'redeem-gift',{code:raw,request_id:randomUUID()})).response.status,401);
  assert.equal((await api(id,'redeem-gift')).response.status,404);
  for (let i=0;i<10;i++) assert.equal((await api(id,'redeem-gift',{code:'invalid',request_id:randomUUID()})).response.status,400);
  const blocked=await api(id,'redeem-gift',{code:raw,request_id:randomUUID()});assert.equal(blocked.response.status,429);
  assert.equal(blocked.data.error,'gift_redemption_rate_limited');assert.ok(Number(blocked.response.headers.get('retry-after'))>0);
  assert.equal((await api(await user(),'redeem-gift',{code:raw,request_id:randomUUID()})).response.status,200);
});

test('business checkout restriction is 409 without consuming the gift and keeps capability visible', async () => {
  const id=await user(), raw=await code();
  await db.query("SELECT cloud_create_order($1,'sandbox','waffo','cloud_usd_monthly_fixed',$2)",[id,randomUUID()]);
  const result=await api(id,'redeem-gift',{code:raw,request_id:randomUUID()});assert.equal(result.response.status,409);assert.equal(result.data.error,'gift_checkout_pending');
  const account=await api(id,'account');assert.equal(account.data.gift_redemption_available,true);assert.equal(account.data.redemption_restriction,'gift_checkout_pending');
  assert.equal((await api(await user(),'redeem-gift',{code:raw,request_id:randomUUID()})).response.status,200);
});
