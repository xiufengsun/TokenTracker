const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { giftCodeHash, giftAccount, redeemGift } = require('./helpers/load-cloud-module')('gifts');

test('code normalization accepts only ASCII formatting and hashes canonical 128-bit values', async () => {
  const hex = randomBytes(16).toString('hex').toUpperCase();
  const code = 'TT-PRO-' + hex.match(/.{8}/g).join('-');
  const expected = createHash('sha256').update('TTPRO' + hex).digest('hex');
  for (const value of [code, code.toLowerCase(), ' \t'+code+'\n', 'TT PRO '+hex]) {
    assert.equal(await giftCodeHash(value),expected);
  }
  for (const value of [null,{},'',code+'A',code.slice(0,-1),code.replaceAll('-','—'),code+'\u200b','Ａ'+code,
    code+'\0',code.repeat(20)]) assert.equal(await giftCodeHash(value),null);
});

test('old schema suppresses only the missing gift capability while unrelated database failures stay visible', async () => {
  const actor = randomUUID();
  for (const code of ['PGRST202','42883']) {
    const client = {database:{rpc:async(name)=>({error:{code,message:'function '+name+' is not found'}})}};
    assert.deepEqual(await giftAccount(client,actor,'sandbox'),{gifts:[],gift_redemption_available:false});
    await assert.rejects(redeemGift(client,actor,'sandbox','invalid',randomUUID()),e=>e.code==='gift_not_available'&&e.status===503);
  }
  for (const error of [{code:'PGRST202',message:'other_function not found'}, {code:'42501',message:'permission denied'},
    {code:'08006',message:'database offline'}, {message:'function cloud_gift_account missing'}]) {
    await assert.rejects(giftAccount({database:{rpc:async()=>({error})}},actor,'sandbox'),e=>e.code==='billing_operation_failed');
  }
});

test('redemption sends only trusted actor, environment, hash and request ID, and business failures are never success', async () => {
  const actor = randomUUID(), request = randomUUID(), hex = randomBytes(16).toString('hex').toUpperCase();
  const raw = 'TT-PRO-' + hex.match(/.{8}/g).join('-'), calls = [];
  let result = {ok:false,status:429,code:'gift_redemption_rate_limited',retry_after:900};
  const client = {database:{rpc:async(name,args)=>{calls.push({name,args});return {data:result};}}};
  assert.deepEqual(await redeemGift(client,actor,'sandbox',raw,request),{status:429,data:{error:result.code,retry_after:900}});
  assert.deepEqual(calls[0],{name:'cloud_redeem_gift',args:{p_user_id:actor,p_environment:'sandbox',
    p_code_hash:createHash('sha256').update('TTPRO'+hex).digest('hex'),p_request_id:request}});
  assert.ok(!JSON.stringify(calls).includes(raw));
  result = {ok:true,gift:{id:randomUUID()},membership:{status:'active'},reused:true};
  assert.deepEqual(await redeemGift(client,actor,'sandbox',raw,request),{status:200,data:{gift:result.gift,membership:result.membership,already_redeemed:true}});
  result = {membership:{status:'active'}};
  await assert.rejects(redeemGift(client,actor,'sandbox',raw,request),e=>e.code==='billing_operation_failed');
});
