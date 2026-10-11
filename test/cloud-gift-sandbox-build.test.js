const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHmac, randomUUID } = require('node:crypto');
const { buildCloudFunctions } = require('../scripts/build-cloud-functions.cjs');
const load = require('./helpers/load-cloud-module');
const handler = load('../../../scripts/cloud-sandbox/gifts').default;
const actor = randomUUID(),secret = 'gift-cohort-test-only';
const jwt = role => {
  const h = Buffer.from(JSON.stringify({alg:'HS256'})).toString('base64url');
  const b = Buffer.from(JSON.stringify({sub:actor,exp:Date.now()/1000+60,...(role === undefined ? {} : {role})})).toString('base64url');
  return h+'.'+b+'.'+createHmac('sha256',secret).update(h+'.'+b).digest('base64url');
};

test('gift-only sandbox rejects administrator, missing-role and paid operations before any SDK request', async () => {
  const old = globalThis.Deno, realFetch = globalThis.fetch;
  const env = {JWT_SECRET:secret,TOKENTRACKER_SANDBOX_GIFT_USER_IDS:actor};
  globalThis.Deno = {env:{get:key=>env[key]}};
  let calls = 0;globalThis.fetch = async()=>{calls++;throw Error('unexpected SDK request');};
  try {
    for (const role of ['project_admin',undefined,'anon','service_role']) {
      const r = await handler(new Request('https://qa.invalid/?action=account',{headers:{Authorization:'Bearer '+jwt(role)}}));
      assert.equal(r.status,401);
    }
    for(const action of ['checkout','cancel','trial','portal','restart-checkout','reconcile','devices']) {
      const r = await handler(new Request('https://qa.invalid/?action='+action,{method:'POST',headers:{Authorization:'Bearer '+jwt('authenticated')}}));
      assert.equal(r.status,404);
    }
    assert.equal(calls,0);
  } finally { globalThis.fetch=realFetch;if(old===undefined)delete globalThis.Deno;else globalThis.Deno=old; }
});

test('gift sandbox builds to a distinct artifact with immutable sandbox and pinned payment dependencies', async () => {
  await assert.rejects(buildCloudFunctions({giftSandbox:true,sandbox:true}),/one sandbox/);
  const out = await buildCloudFunctions({giftSandbox:true});
  assert.deepEqual(out.functions,['tokentracker-billing-gifts-sandbox']);
  assert.equal(path.basename(out.output),'cloud-functions-gift-sandbox');
  const source = await fs.readFile(path.join(out.output,out.functions[0]+'.js'),'utf8');
  assert.ok(source.includes('TOKENTRACKER_SANDBOX_GIFT_USER_IDS'));
  assert.ok(source.includes('if (name === "TOKENTRACKER_BILLING_ENVIRONMENT") return "sandbox"'));
  assert.ok(source.includes('Waffo SDK 0.25.0'));
  assert.ok(source.includes('npm:urllib@4.9.1'));
});
