const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const migration = name => fs.readFileSync(path.join(__dirname, '../../migrations', name), 'utf8');
function functionSql(sql, name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  assert.notEqual(start, -1, name);
  const delimiter = sql.slice(start).match(/AS (\$\w*\$)/)[1];
  const body = sql.indexOf(delimiter, start) + delimiter.length;
  return sql.slice(start, sql.indexOf(delimiter + ';', body) + delimiter.length + 1);
}
// Canonical function shape and weekend boundary were read back from the linked
// production project on 2026-10-04. Only test setup defines this dependency;
// the archive migration refuses to overwrite the installed canonical function.
const canonicalTier = `CREATE FUNCTION public.leaderboard_pricing_tier(p_model text,p_hour_start timestamptz)
  RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT CASE
    WHEN lower(p_model) LIKE '%deepseek-v4-flash%' OR lower(p_model) LIKE '%deepseek-v4-pro%' THEN CASE
      WHEN p_hour_start >= timestamptz '2026-08-22T16:00:00Z'
        AND extract(dow FROM ((p_hour_start AT TIME ZONE 'UTC')+interval '8 hours')) IN (0,6) THEN 'off_peak'
      WHEN extract(hour FROM p_hour_start AT TIME ZONE 'UTC')>=1 AND extract(hour FROM p_hour_start AT TIME ZONE 'UTC')<4
        OR extract(hour FROM p_hour_start AT TIME ZONE 'UTC')>=6 AND extract(hour FROM p_hour_start AT TIME ZONE 'UTC')<10
      THEN 'peak' ELSE 'off_peak' END ELSE 'peak' END $f$;`;
async function setup() {
  const pg = new PGlite();
  await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE tokentracker_devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,device_name text,
      platform text,machine_id text,revoked_at timestamptz,name_customized boolean DEFAULT false,
      default_device_name text,created_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX active_machine ON tokentracker_devices(user_id,machine_id) WHERE revoked_at IS NULL;
    CREATE UNIQUE INDEX active_name ON tokentracker_devices(user_id,platform,device_name) WHERE revoked_at IS NULL;
    CREATE TABLE tokentracker_device_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,
      device_id uuid,token_hash text UNIQUE,revoked_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE tokentracker_device_codes(device_code text PRIMARY KEY,user_code text UNIQUE,status text,
      user_id uuid,expires_at timestamptz,approved_at timestamptz,client_info text,machine_id text);
    CREATE TABLE tokentracker_device_machine(device_id uuid PRIMARY KEY,machine_cluster_id text);
    CREATE TABLE tokentracker_hourly(user_id uuid NOT NULL,device_id uuid NOT NULL,source text NOT NULL,
      model text NOT NULL,hour_start timestamptz NOT NULL,input_tokens bigint NOT NULL,
      cached_input_tokens bigint NOT NULL,cache_creation_input_tokens bigint NOT NULL,
      output_tokens bigint NOT NULL,reasoning_output_tokens bigint NOT NULL,total_tokens bigint NOT NULL,
      billable_total_tokens bigint,conversations integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),total_cost_usd numeric NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,device_id,source,model,hour_start));
    CREATE TABLE tokentracker_account_usage_cache(cache_key text PRIMARY KEY,fetched_at timestamptz,result jsonb);
    CREATE TABLE tokentracker_leaderboard_rollup_daily_v2(user_id uuid,source text,model text,pricing_tier text,
      day date,total_tokens bigint,input_tokens bigint,output_tokens bigint,cached_input_tokens bigint,
      cache_creation_input_tokens bigint,reasoning_output_tokens bigint,
      PRIMARY KEY(user_id,source,model,pricing_tier,day));
    CREATE TABLE tokentracker_leaderboard_rollup_meta_v2(id integer PRIMARY KEY,through timestamptz,
      repair_from date,rebuilt_at timestamptz);
    CREATE TABLE tokentracker_leaderboard_snapshots(user_id uuid,period text,from_day date,to_day date,
      rank integer,total_tokens bigint,display_name text,PRIMARY KEY(user_id,period,from_day,to_day));
    CREATE TABLE agentmeter_leaderboard_snapshots(LIKE tokentracker_leaderboard_snapshots INCLUDING ALL);
    CREATE TABLE tokentracker_leaderboard_rollup_daily(user_id uuid,source text,model text,day date,
      total_tokens bigint,input_tokens bigint,output_tokens bigint,cached_input_tokens bigint,
      cache_creation_input_tokens bigint,reasoning_output_tokens bigint,PRIMARY KEY(user_id,source,model,day));
    CREATE TABLE agentmeter_hourly(LIKE tokentracker_hourly INCLUDING ALL);
  `);
  const sessions = migration('20260817120000_account-session-states.sql');
  await pg.exec(sessions.slice(0, sessions.indexOf('-- Leaderboard: account-level sources')));
  await pg.exec(functionSql(sessions, 'leaderboard_hourly_dedup_v2'));
  await pg.exec(functionSql(sessions, 'leaderboard_rollup_daily_advance_v2'));
  await pg.exec(functionSql(migration('20260719152022_harden-backend-concurrency.sql'), 'refresh_tokentracker_device_identity'));
  const candidate = migration('20260904083630_add-single-scan-account-usage-candidate.sql');
  await pg.exec(candidate.replaceAll('account_usage_grouped_single_scan_candidate', 'account_usage_grouped'));
  await pg.exec(functionSql(migration('20260904090000_promote-single-scan-account-usage.sql'), 'account_usage_grouped_v2'));
  await pg.exec(functionSql(migration('20260719152022_harden-backend-concurrency.sql'), 'account_usage_grouped_cached'));
  await pg.exec(canonicalTier);
  // Retain the existing rollup writer and actual insert/delete/update lifetime
  // triggers. Replace its former inline tier only in this isolated fixture.
  const replacement = `CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_replace_v2(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SET work_mem TO '16MB'
 SET hash_mem_multiplier TO '2'
 SET statement_timeout TO '25s'
AS $function$
DECLARE
  v_day timestamptz;
BEGIN
  v_day := date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  WHILE v_day < p_to LOOP
    DELETE FROM public.tokentracker_leaderboard_rollup_daily_v2
    WHERE day = (v_day AT TIME ZONE 'UTC')::date;

    -- pricing_tier is a rollup dimension, not a per-model constant: DeepSeek V4
    -- bills at a different rate inside two UTC windows, and the tier is derived
    -- from hour_start, which a DAILY rollup would otherwise erase. Splitting the
    -- day into (peak, off_peak) rows keeps DeepSeek inside the rollup fast path
    -- instead of forcing a full-history live rescan on every refresh. Every
    -- other model has exactly one tier ('peak'), so its row count is unchanged.
    -- The window and the model match MUST stay identical to the tier expression
    -- in leaderboard_usage_grouped's live tail, or base and tail disagree.
    INSERT INTO public.tokentracker_leaderboard_rollup_daily_v2 (
      user_id, source, model, pricing_tier, day,
      total_tokens, input_tokens, output_tokens,
      cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens
    )
    SELECT
      d.user_id, d.source, d.model,
      public.leaderboard_pricing_tier(d.model, d.hour_start) AS pricing_tier,
      (d.hour_start AT TIME ZONE 'UTC')::date AS day,
      SUM(d.total_tokens), SUM(d.input_tokens), SUM(d.output_tokens),
      SUM(d.cached_input_tokens), SUM(d.cache_creation_input_tokens), SUM(d.reasoning_output_tokens)
    FROM public.leaderboard_hourly_dedup_v2(v_day, v_day + interval '1 day') d
    GROUP BY d.user_id, d.source, d.model,
      public.leaderboard_pricing_tier(d.model, d.hour_start),
      (d.hour_start AT TIME ZONE 'UTC')::date;

    v_day := v_day + interval '1 day';
  END LOOP;

END
$function$
;`;
  await pg.exec(replacement);
  const totals = migration('20260904064000_cache-leaderboard-total-rollup.sql');
  await pg.exec(totals.slice(0, totals.indexOf('CREATE OR REPLACE FUNCTION public.leaderboard_usage_grouped(')));
  await pg.exec(`GRANT ALL ON tokentracker_devices,tokentracker_hourly,tokentracker_device_machine,
    tokentracker_account_usage_cache,tokentracker_leaderboard_rollup_daily_v2,tokentracker_leaderboard_rollup_meta_v2,
    tokentracker_device_tokens,tokentracker_device_codes,tokentracker_leaderboard_snapshots,
    agentmeter_leaderboard_snapshots,tokentracker_leaderboard_rollup_daily,agentmeter_hourly TO project_admin;`);
  return pg;
}
module.exports = { setup, migration, functionSql };
