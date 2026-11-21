// Shared synthetic prerequisite tables plus the actual billing migrations.
const fs = require("node:fs");
const path = require("node:path");
const { functionSql } = require("./cloud-usage-archive-fixture");
const migration = name => fs.readFileSync(path.join(__dirname, "../../migrations", name), "utf8");
async function installCloudBillingSchema(db, { afterSubscriptions } = {}) {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE tokentracker_devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,
      device_name text NOT NULL,platform text,machine_id text,revoked_at timestamptz,
      name_customized boolean NOT NULL DEFAULT false,default_device_name text,created_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX active_machine ON tokentracker_devices(user_id,machine_id) WHERE revoked_at IS NULL;
    CREATE UNIQUE INDEX active_name ON tokentracker_devices(user_id,platform,device_name) WHERE revoked_at IS NULL;
    CREATE TABLE tokentracker_device_machine(device_id uuid PRIMARY KEY,machine_cluster_id text);
    CREATE TABLE tokentracker_device_tokens(id uuid PRIMARY KEY,user_id uuid,device_id uuid,token_hash text UNIQUE,
      revoked_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE tokentracker_device_codes(device_code text PRIMARY KEY,user_code text UNIQUE,status text,
      user_id uuid,expires_at timestamptz,approved_at timestamptz,client_info text,machine_id text);
    CREATE TABLE tokentracker_hourly(user_id uuid,device_id uuid,hour_start timestamptz,source text,model text,
      input_tokens bigint,cached_input_tokens bigint,cache_creation_input_tokens bigint,output_tokens bigint,
      reasoning_output_tokens bigint,total_tokens bigint CHECK(total_tokens>=0),billable_total_tokens bigint,
      conversations integer,total_cost_usd numeric,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
      PRIMARY KEY(user_id,device_id,hour_start,source,model));
    GRANT USAGE ON SCHEMA auth TO project_admin;
    GRANT SELECT(id) ON auth.users TO project_admin;
    GRANT ALL ON tokentracker_devices,tokentracker_device_machine,tokentracker_device_tokens,
      tokentracker_device_codes,tokentracker_hourly TO project_admin;`);
  await db.exec(functionSql(migration("20260719152022_harden-backend-concurrency.sql"), "refresh_tokentracker_device_identity"));
  const sessionsSql = migration("20260817120000_account-session-states.sql");
  await db.exec(sessionsSql.slice(0, sessionsSql.indexOf("-- Leaderboard: account-level sources")));
  for (const name of ["20261003120000_cloud-subscriptions.sql", "20261004120000_cloud-machine-access.sql",
    "20261007120000_cloud-waffo.sql", "20261007130000_cloud-waffo-retry.sql",
    "20261007140000_cloud-waffo-attempts.sql", "20261007150000_cloud-waffo-authorizations.sql",
    "20261007160000_cloud-waffo-sandbox-periods.sql",
    "20261008120000_self-hosted-access.sql", "20261009120000_cloud-gifts.sql",
    "20261106011916_cloud-waffo-unused-checkout-retry.sql",
    "20261106014534_cloud-checkout-recovery.sql", "20261117090000_cloud-order-cancellation.sql"]) {
    await db.exec(migration(name));
    if (name === "20261003120000_cloud-subscriptions.sql" && afterSubscriptions) await afterSubscriptions(db);
  }
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now()-interval '1 hour' WHERE environment='sandbox'");
}
module.exports = { installCloudBillingSchema };
