const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { readProBadges } = require("./helpers/load-cloud-module")("pro");

let db;
test.before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
    CREATE TABLE tokentracker_devices (id uuid PRIMARY KEY, user_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE tokentracker_user_settings (user_id uuid PRIMARY KEY, leaderboard_anonymous boolean DEFAULT false);
    GRANT SELECT ON tokentracker_devices,tokentracker_user_settings TO project_admin;`);
  for (const name of ["20261003120000_cloud-subscriptions.sql", "20261008150000_cloud-pro-badges.sql"]) {
    await db.exec(fs.readFileSync(path.join(__dirname, "../migrations", name), "utf8"));
  }
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now()");
});
test.after(async () => db?.close());

async function user() {
  const id = randomUUID();
  await db.query("INSERT INTO auth.users VALUES ($1)", [id]);
  return id;
}
async function pay(id, environment = "live", renewal = null) {
  const order = renewal ? { id: renewal.order_id } :
    (await db.query("SELECT cloud_create_order($1,$2,'paddle','cloud_usd_monthly',$3) AS r",
      [id, environment, randomUUID()])).rows[0].r;
  const start = renewal ? new Date(renewal.ends_at) : new Date(Date.now() - 1000), end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const event = { event_id: randomUUID(), kind: "payment", action_id: randomUUID(), order_id: order.id,
    occurred_at: new Date().toISOString(), currency: "USD", amount_cents: 599, base_amount_cents: 599,
    subscription_id: renewal?.subscription_id || randomUUID(), starts_at: start.toISOString(), ends_at: end.toISOString() };
  await db.query("SELECT cloud_apply_event('paddle',$1,$2)", [environment, JSON.stringify(event)]);
  return event;
}
async function badges(ids, environment = "live") {
  return (await db.query("SELECT cloud_pro_badges($1,$2) AS r", [ids, environment])).rows[0].r;
}
async function refund(event, cents) {
  const r = { event_id: randomUUID(), kind: "refund", action_id: randomUUID(), order_id: event.order_id,
    occurred_at: new Date().toISOString(), transaction_id: event.action_id, currency: "USD", amount_cents: cents };
  await db.query("SELECT cloud_apply_event('paddle','live',$1)", [JSON.stringify(r)]);
}

test("only current paid terms receive Pro, including a canceled renewal", async () => {
  const id = await user();
  const paid = await pay(id);
  assert.deepEqual(await badges([id,id]), { [id]: true });
  // Subscription metadata cannot grant or remove an already paid term.
  await db.query("UPDATE tokentracker_cloud_subscriptions SET status='canceled',cancel_at_period_end=true WHERE provider_subscription_id=$1",
    [paid.subscription_id]);
  assert.deepEqual(await badges([id]), { [id]: true });
  await refund(paid, 100);
  assert.deepEqual(await badges([id]), { [id]: true });
  await refund(paid, 499);
  assert.deepEqual(await badges([id]), {});
});

test("future, expired, trial and free access cannot grant the paid cosmetic", async () => {
  const free = await user();
  const trial = await user();
  await db.query("SELECT cloud_start_trial($1,'live')", [trial]);
  const future = await user();
  await pay(future);
  await db.query("UPDATE tokentracker_cloud_payments SET starts_at=now()+interval '1 day',ends_at=now()+interval '2 days' WHERE user_id=$1", [future]);
  const expired = await user();
  await pay(expired);
  await db.query("UPDATE tokentracker_cloud_payments SET starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' WHERE user_id=$1", [expired]);
  assert.deepEqual(await badges([free,trial,future,expired]), {});
});

test("a refunded future term leaves an earlier active paid term visible", async () => {
  const id = await user();
  const first = await pay(id);
  const next = await pay(id, "live", first);
  await refund(next, 599);
  assert.deepEqual(await badges([id]), { [id]: true });
});

test("anonymous profiles, sandbox payments and preview policy stay private", async () => {
  const hidden = await user();
  await pay(hidden);
  await db.query("INSERT INTO tokentracker_user_settings VALUES ($1,true)", [hidden]);
  const sandbox = await user();
  await pay(sandbox, "sandbox");
  assert.deepEqual(await badges([hidden,sandbox]), {});
  assert.deepEqual(await badges([sandbox], "sandbox"), { [sandbox]: true });
  const paid = await user();
  await pay(paid);
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='preview' WHERE environment='live'");
  try { assert.deepEqual(await badges([paid]), {}); }
  finally { await db.exec("UPDATE tokentracker_cloud_policy SET phase='active' WHERE environment='live'"); }
});

test("only the server can read a bounded batch of badge status", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    try { await assert.rejects(badges([randomUUID()]), /permission denied/); }
    finally { await db.exec("RESET ROLE"); }
  }
  await db.exec("SET ROLE project_admin");
  try {
    assert.deepEqual(await badges([]), {});
    await assert.rejects(badges(Array.from({length:102},randomUUID)), /Too many badge users/);
    await assert.rejects(badges([], "other"), /Invalid badge environment/);
  } finally { await db.exec("RESET ROLE"); }
});

test("edge reads one live batch, ignores truthy or unrelated values, and survives outages", async () => {
  const calls=[];
  const client={database:{rpc:async(name,args)=>{calls.push({name,args});return {data:{a:true,b:"true",c:1,extra:true}};}}};
  assert.deepEqual(await readProBadges(client,["a","b","c","a"]),{a:true,b:false,c:false});
  assert.deepEqual(calls,[{name:"cloud_pro_badges",args:{p_user_ids:["a","b","c"]}}]);
  for (const rpc of [async()=>({error:true}), async()=>({data:[]}), async()=>{throw Error("offline");}]) {
    assert.deepEqual(await readProBadges({database:{rpc}},["a"]),{});
  }
  assert.deepEqual(await readProBadges({database:{rpc:()=>{throw Error("unexpected");}}},[]),{});
});
