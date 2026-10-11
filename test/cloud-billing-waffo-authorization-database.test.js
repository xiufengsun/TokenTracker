const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");

test("zero-amount card checks are durable, private, immutable evidence and never paid access", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      CREATE TABLE tokentracker_devices(id uuid PRIMARY KEY,user_id uuid,created_at timestamptz DEFAULT now());
      GRANT SELECT ON tokentracker_devices TO project_admin;`);
    for (const migration of ["20261003120000_cloud-subscriptions.sql", "20261007120000_cloud-waffo.sql",
      "20261007130000_cloud-waffo-retry.sql", "20261007140000_cloud-waffo-attempts.sql",
      "20261007150000_cloud-waffo-authorizations.sql"]) {
      await db.exec(fs.readFileSync(path.join(__dirname,"../migrations",migration),"utf8"));
    }
    await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now() WHERE environment='sandbox'");
    const userId = randomUUID();
    await db.query("INSERT INTO auth.users VALUES ($1)",[userId]);
    const order = (await db.query("SELECT cloud_create_order($1,'sandbox','waffo','cloud_usd_monthly',$2) AS r",
      [userId,randomUUID()])).rows[0].r;
    const product = "PROD_0123456789012345678901";
    const attempt = "ORD_0123456789012345678901";
    await db.query("SELECT cloud_attach_waffo_checkout($1,$2,$3,$4,$5)",
      [userId,order.id,`cs_${randomUUID()}`,product,"https://checkout.example.test/pay"]);
    await db.query("SELECT cloud_register_waffo_attempt($1,'sandbox',$2,$3,'recurring')",[order.id,attempt,product]);
    const event = { event_id:"verified-card-check",kind:"authorization",action_id:"PAY_0123456789012345678901",
      transaction_id:"PAY_0123456789012345678901",order_id:order.id,waffo_order_id:attempt,
      provider_price_id:product,subscription_id:attempt,currency:"USD",amount_cents:0,
      base_amount_cents:499,period_number:0,occurred_at:new Date().toISOString() };
    const record = e => db.query("SELECT cloud_record_waffo_authorization('sandbox',$1)",[JSON.stringify(e)]);
    await record(event);
    await record(event);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM tokentracker_cloud_waffo_authorizations")).rows[0].n,1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM tokentracker_cloud_payments")).rows[0].n,0);
    const current = (await db.query("SELECT provider_order_id,waffo_order_id,status FROM tokentracker_cloud_orders WHERE id=$1",[order.id])).rows[0];
    assert.deepEqual(current,{provider_order_id:null,waffo_order_id:null,status:"ready"});
    assert.equal((await db.query("SELECT cloud_membership($1,'sandbox') AS r",[userId])).rows[0].r.can_upload_cloud,false);
    for (const changed of [{amount_cents:1},{period_number:1},{currency:"CNY"},{base_amount_cents:3999},
      {waffo_order_id:"ORD_other"},{starts_at:new Date().toISOString()},{transaction_id:"PAY_other"}]) {
      await assert.rejects(record({...event,...changed}),/invalid|different evidence/);
    }
    await assert.rejects(record({...event,event_id:"changed-proof"}),/different evidence/);
    const privileges = (await db.query(`SELECT
      has_table_privilege('authenticated','tokentracker_cloud_waffo_authorizations','SELECT') AS read,
      has_function_privilege('anon','cloud_record_waffo_authorization(text,jsonb)','EXECUTE') AS execute`)).rows[0];
    assert.deepEqual(privileges,{read:false,execute:false});
    const starts = new Date();
    const ends = new Date(starts); ends.setUTCMonth(ends.getUTCMonth()+1);
    await db.query("SELECT cloud_record_waffo_period($1,'sandbox',$2,$3,1,$4,$5)",[order.id,attempt,product,starts.toISOString(),ends.toISOString()]);
    const paid = {...event,event_id:"actual-payment",kind:"payment",action_id:"PAY_actual",
      transaction_id:"PAY_actual",amount_cents:499,period_number:1,starts_at:starts.toISOString(),ends_at:ends.toISOString()};
    await db.query("SELECT cloud_apply_waffo_events('sandbox',$1)",[JSON.stringify([paid])]);
    assert.equal((await db.query("SELECT cloud_membership($1,'sandbox') AS r",[userId])).rows[0].r.can_upload_cloud,true);
    assert.equal((await db.query("SELECT provider_order_id FROM tokentracker_cloud_orders WHERE id=$1",[order.id])).rows[0].provider_order_id,"PAY_actual");
  } finally {
    await db.close();
  }
});
