const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const http=require("node:http");
const {randomUUID,createHmac}=require("node:crypto");
const {PGlite}=require("@electric-sql/pglite");
const load=require("./helpers/load-cloud-module");
const handlers={billing:load("../tokentracker-billing").default,webhook:load("../tokentracker-paddle-webhook").default};
const {createPaddleCheckout}=load("paddle");
const {paddleConfig}=load("runtime");
const originalFetch=globalThis.fetch;
const secret="isolated-billing-http-test-only";
const users=[randomUUID(),randomUUID()];
let db,server,base,env,transactionCount=0,providerRequestCount=0;
const priceAmount="599";
const legacyOrders=new Map();
const transactions=new Map();
const subscriptions=new Map();
const signToken=(sub,role="authenticated")=>{
  const header=Buffer.from(JSON.stringify({alg:"HS256"})).toString("base64url");
  const value=Buffer.from(JSON.stringify({sub,role,exp:Math.floor(Date.now()/1000)+3600})).toString("base64url");
  return `${header}.${value}.${createHmac("sha256",secret).update(`${header}.${value}`).digest("base64url")}`;
};
const quote=()=>({id:"pri_month",status:"active",tax_mode:"external",trial_period:null,unit_price_overrides:[],
  quantity:{minimum:1,maximum:1},billing_cycle:{interval:"month",frequency:1},unit_price:{amount:priceAmount,currency_code:"USD"}});
const identifier=value=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value))throw Error("bad identifier");return '"'+value+'"';};
test.before(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE TABLE tokentracker_devices(id uuid PRIMARY KEY,user_id uuid,created_at timestamptz DEFAULT now());
    GRANT SELECT ON tokentracker_devices TO project_admin;`);
  await db.exec(fs.readFileSync(path.join(__dirname,"../migrations/20261003120000_cloud-subscriptions.sql"),"utf8"));
  for(const id of users){
    await db.query("INSERT INTO auth.users VALUES($1)",[id]);
    const result=await db.query("SELECT cloud_create_order($1,'sandbox','paddle','cloud_usd_monthly',$2) AS r",[id,randomUUID()]);
    legacyOrders.set(id,result.rows[0].r.id);
  }
  await db.exec(fs.readFileSync(path.join(__dirname,"../migrations/20261007120000_cloud-waffo.sql"),"utf8"));
  await db.exec(fs.readFileSync(path.join(__dirname,"../migrations/20261007130000_cloud-waffo-retry.sql"),"utf8"));
  await db.exec(fs.readFileSync(path.join(__dirname,"../migrations/20261007140000_cloud-waffo-attempts.sql"),"utf8"));
  await db.exec(fs.readFileSync(path.join(__dirname,"../migrations/20261007150000_cloud-waffo-authorizations.sql"),"utf8"));
  await db.exec(fs.readFileSync(path.join(__dirname,"../migrations/20261007160000_cloud-waffo-sandbox-periods.sql"),"utf8"));
  await db.exec(fs.readFileSync(path.join(__dirname,"../migrations/20261008120000_self-hosted-access.sql"),"utf8"));
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now()-interval '1 hour' WHERE environment='sandbox'");
  server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(value));};
    let raw="";for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,base);
    try{
      if(url.pathname.startsWith("/functions/")){
        const handler=url.pathname.endsWith("billing")?handlers.billing:handlers.webhook;
        const result=await handler(new Request(url,{method:req.method,headers:req.headers,...(raw?{body:raw}:{})}));
        res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;
      }
      // The actual InsForge SDK uses this loopback HTTP adapter to reach real PostgreSQL.
      assert.equal(req.headers.authorization,"Bearer "+env.INSFORGE_SERVICE_ROLE_KEY);
      await db.transaction(async tx=>{
        await tx.exec("SET LOCAL ROLE project_admin");
        if(url.pathname.startsWith("/api/database/rpc/")){
          const params=JSON.parse(raw||"{}");const names=Object.keys(params);
          const values=names.map(k=>params[k]&&typeof params[k]==="object"?JSON.stringify(params[k]):params[k]);
          const result=await tx.query(`SELECT ${identifier(url.pathname.split("/").pop())}(${names.map((k,i)=>identifier(k)+" => $"+(i+1)).join(",")}) AS r`,values);
          send(200,result.rows[0].r);return;
        }
        const params=[];const filters=[];
        for(const [key,value]of url.searchParams){
          if(["select","order","limit"].includes(key))continue;
          if(value.startsWith("eq.")){params.push(value.slice(3));filters.push(identifier(key)+"=$"+params.length);}
          else if(value==="not.is.null"){filters.push(identifier(key)+" IS NOT NULL");}
          else if(value.startsWith("in.(")&&value.endsWith(")")){params.push(value.slice(4,-1).split(","));filters.push(identifier(key)+"=ANY($"+params.length+"::text[])");}
          else throw Error("unsupported filter");
        }
        const select=url.searchParams.get("select")||"*";
        let sql=`SELECT ${select==="*"?"*":select.split(",").map(identifier).join(",")} FROM ${identifier(url.pathname.split("/").pop())}`;
        if(filters.length)sql+=" WHERE "+filters.join(" AND ");
        if(url.searchParams.has("order")){const [field,dir]=url.searchParams.get("order").split(".");sql+=" ORDER BY "+identifier(field)+(dir==="desc"?" DESC":" ASC");}
        sql+=" LIMIT "+Math.min(100,Number(url.searchParams.get("limit"))||100);
        const result=await tx.query(sql,params);
        if(req.headers.accept?.includes("vnd.pgrst.object")){
          if(result.rows.length!==1){send(406,{code:"PGRST116",message:"No single object",details:"The result contains "+result.rows.length+" rows"});return;}
          send(200,result.rows[0]);
        }else send(200,result.rows);
      });
    }catch(error){send(500,{code:error.code||"LOCAL_SQL",message:error.message});}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  base="http://127.0.0.1:"+server.address().port;
  env={INSFORGE_BASE_URL:base,INSFORGE_SERVICE_ROLE_KEY:signToken(randomUUID(),"project_admin"),ANON_KEY:signToken(randomUUID(),"anon"),
    JWT_SECRET:secret,TOKENTRACKER_BILLING_ENVIRONMENT:"sandbox",TOKENTRACKER_BILLING_SITE_URL:"https://www.tokentracker.cc",
    PADDLE_API_KEY:"test-only-api",PADDLE_WEBHOOK_SECRET:secret,PADDLE_CLIENT_TOKEN:"test-only-client",
    PADDLE_CLOUD_MONTHLY_PRICE_ID:"pri_month",PADDLE_CLOUD_YEARLY_PRICE_ID:"pri_year"};
  globalThis.Deno={env:{get:key=>env[key]}};
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==="string"?input:input.url||input.href);
    if(url.origin===base)return originalFetch(input,init);
    providerRequestCount++;
    assert.equal(url.origin,"https://sandbox-api.paddle.com","fixtures cannot send merchant requests");
    if(url.pathname.startsWith("/prices/"))return Response.json({data:quote()});
    if(url.pathname==="/transactions"){
      transactionCount++;const body=JSON.parse(init.body);const id="txn_"+randomUUID();
      const data={id,status:"draft",currency_code:"USD",collection_mode:"automatic",custom_data:body.custom_data,
        items:[{quantity:1,price:quote()}],checkout:{url:body.checkout.url+"&_ptxn="+id},updated_at:new Date().toISOString()};
      transactions.set(id,data);return Response.json({data});
    }
    if(url.pathname.startsWith("/transactions/"))return Response.json({data:transactions.get(url.pathname.split("/").pop())});
    if(url.pathname.startsWith("/subscriptions/")){
      const sub=subscriptions.get(url.pathname.split("/")[2]);
      if(url.pathname.endsWith("/cancel")){
        assert.deepEqual(JSON.parse(init.body),{effective_from:"next_billing_period"});
        sub.scheduled_change={action:"cancel"};sub.updated_at=new Date().toISOString();
      }
      return Response.json({data:sub});
    }
    if(url.pathname.includes("/portal-sessions"))return Response.json({data:{customer_id:"ctm_local",urls:{general:{overview:"https://sandbox-customer-portal.paddle.com/cpl_local?token=test-only"}}}});
    throw Error("unexpected provider operation");
  };
});
test.after(async()=>{globalThis.fetch=originalFetch;delete globalThis.Deno;await new Promise(resolve=>server.close(resolve));await db.close();});
async function api(action,value,user=users[0]){
  const response=await originalFetch(base+"/functions/billing?action="+action,{method:value===undefined?"GET":"POST",
    headers:{Authorization:"Bearer "+signToken(user),"Content-Type":"application/json"},...(value===undefined?{}:{body:JSON.stringify(value)})});
  return {response,data:await response.json()};
}
async function webhook(data,type="transaction.completed"){
  const raw=JSON.stringify({event_id:"evt_"+randomUUID(),event_type:type,occurred_at:new Date().toISOString(),data});
  const ts=String(Math.floor(Date.now()/1000));
  const response=await originalFetch(base+"/functions/webhook",{method:"POST",headers:{"Paddle-Signature":`ts=${ts};h1=${createHmac("sha256",secret).update(`${ts}:${raw}`).digest("hex")}`},body:raw});
  return {response,data:await response.json()};
}
async function legacyCheckout(user){
  const order=(await db.query("SELECT * FROM tokentracker_cloud_orders WHERE id=$1",[legacyOrders.get(user)])).rows[0];
  assert.equal(order.amount_cents,599);assert.equal(order.billing_mode,"recurring");
  assert.equal((await db.query("SELECT cloud_claim_checkout($1,$2) AS r",[user,order.id])).rows[0].r.claimed,true);
  const checkout=await createPaddleCheckout(order,paddleConfig());
  return (await db.query("SELECT cloud_attach_checkout($1,$2,$3,$4,$5) AS r",
    [user,order.id,checkout.transactionId,checkout.priceId,checkout.checkoutUrl])).rows[0].r;
}
function paid(data){
  const start=new Date();const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
  return {...data,status:"completed",subscription_id:"sub_"+randomUUID(),customer_id:"ctm_local",updated_at:start.toISOString(),
    billing_period:{starts_at:start.toISOString(),ends_at:end.toISOString()},
    details:{totals:{currency_code:"USD",subtotal:"599",discount:"0",credit:"0",grand_total:"719"}}};
}

test("historical Paddle completion grants once, owner-only cancellation preserves paid time, and refunds remain revoked",async()=>{
  const created=await legacyCheckout(users[0]);
  const txn=paid(transactions.get(new URL(created.checkout_url).searchParams.get("_ptxn")));
  transactions.set(txn.id,txn);subscriptions.set(txn.subscription_id,{...txn,id:txn.subscription_id,status:"active",scheduled_change:null});
  assert.equal((await webhook(txn)).response.status,200);
  assert.equal((await webhook(txn)).response.status,200);
  const account=await api("account");assert.equal(account.response.status,200);assert.equal(account.data.membership.status,"active");assert.equal(account.data.payments.length,1);
  assert.equal((await api("portal",{subscription_id:txn.subscription_id},users[1])).response.status,404);
  assert.equal((await api("reconcile",{id:created.id},users[1])).response.status,404);
  assert.equal((await api("portal",{subscription_id:txn.subscription_id})).response.status,200);
  const cancelled=await api("cancel",{subscription_id:txn.subscription_id});assert.equal(cancelled.response.status,200);
  const after=await api("account");assert.equal(after.data.subscriptions[0].cancel_at_period_end,true);assert.equal(after.data.membership.expires_at,account.data.membership.expires_at);
  const refund={id:"adj_"+randomUUID(),status:"approved",action:"refund",transaction_id:txn.id,currency_code:"USD",totals:{total:"719"}};
  assert.equal((await webhook(refund,"adjustment.updated")).response.status,200);
  assert.equal((await webhook(txn)).response.status,200);
  assert.equal((await api("account")).data.membership.can_upload_cloud,false);
  const ownOrder=await api("order&id="+created.id);
  assert.equal(ownOrder.data.order.payment_state,"refunded");
  assert.equal(ownOrder.data.order.provider_order_id,undefined);
  assert.equal(ownOrder.data.order.amount_cents,599);
  assert.equal(ownOrder.data.order.billing_mode,"recurring");
});

test("an ambiguous historical Paddle checkout binds through a signed callback and reconciles without a second transaction",async()=>{
  const created=await legacyCheckout(users[1]);
  const txn=paid(transactions.get(new URL(created.checkout_url).searchParams.get("_ptxn")));
  await db.query("UPDATE tokentracker_cloud_orders SET provider_order_id=NULL,checkout_url=NULL,status='pending' WHERE id=$1",[created.id]);
  assert.equal((await webhook(txn,"transaction.ready")).response.status,200);
  transactions.set(txn.id,txn);const before=transactionCount;
  const recovered=await api("reconcile",{id:created.id},users[1]);assert.equal(recovered.response.status,200);assert.equal(recovered.data.confirmed,true);
  assert.equal(transactionCount,before);
  const limited=await api("reconcile",{id:created.id},users[1]);assert.equal(limited.response.status,429);assert.ok(Number(limited.response.headers.get("Retry-After"))>0);
  assert.equal((await api("account",undefined,users[1])).data.payments.length,1);
});

test("new non-Waffo purchases are rejected without provider requests or local orders",async()=>{
  const id=randomUUID();await db.query("INSERT INTO auth.users VALUES($1)",[id]);const request_id=randomUUID();
  const before=providerRequestCount;
  for(const provider of ["paddle","wechat","alipay"]){
    const rejected=await api("checkout",{provider,sku:"cloud_usd_monthly",request_id},id);
    assert.equal(rejected.response.status,503);assert.equal(rejected.data.error,"payment_provider_not_configured");
  }
  assert.equal(providerRequestCount,before);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_orders WHERE user_id=$1",[id])).rows[0].n,0);
});
