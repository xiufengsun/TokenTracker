const fs=require("node:fs/promises");
const path=require("node:path");
const {createHash}=require("node:crypto");
const manifest=require("./manifest.cjs");
const digest=sql=>createHash("sha256").update(sql).digest("hex");
const literal=value=>"'"+value.replaceAll("'","''")+"'";
function buildSql({transactional=true}={}) {
  const preflight=`DO $preflight$ BEGIN
    IF to_regclass('auth.users') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR
      NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') OR
      NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') OR
      NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_admin' AND rolbypassrls) THEN
      RAISE EXCEPTION 'Install the compatible InsForge auth schema and API roles first';
    END IF;
    IF NOT has_schema_privilege('project_admin','auth','USAGE') OR
      NOT has_column_privilege('project_admin','auth.users','id','SELECT') THEN
      RAISE EXCEPTION 'The InsForge server role must be able to verify auth.users.id';
    END IF;
    IF to_regclass('public.tokentracker_self_host_installations') IS NULL AND
      (to_regclass('public.tokentracker_devices') IS NOT NULL OR to_regclass('public.tokentracker_cloud_policy') IS NOT NULL) THEN
      RAISE EXCEPTION 'This clean installer refuses an existing unregistered TokenTracker database';
    END IF;
  END $preflight$;
  CREATE TABLE IF NOT EXISTS public.tokentracker_self_host_installations(
    step text PRIMARY KEY,checksum text NOT NULL,installed_at timestamptz NOT NULL DEFAULT clock_timestamp());
  ALTER TABLE public.tokentracker_self_host_installations ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.tokentracker_self_host_installations FROM PUBLIC,anon,authenticated;
  GRANT ALL ON public.tokentracker_self_host_installations TO project_admin;`;
  const steps=manifest.steps().map(step=>{
    const checksum=digest(step.sql);
    return `DO $install$ DECLARE v_checksum text; BEGIN
      SELECT checksum INTO v_checksum FROM public.tokentracker_self_host_installations WHERE step = ${literal(step.id)};
      IF FOUND AND v_checksum <> ${literal(checksum)} THEN RAISE EXCEPTION 'Installed step has changed: %',${literal(step.id)}; END IF;
      IF NOT FOUND THEN
        EXECUTE ${literal(step.sql)};
        INSERT INTO public.tokentracker_self_host_installations(step,checksum) VALUES (${literal(step.id)},${literal(checksum)});
      END IF;
    END $install$;`;
  });
  const verify=`DO $verify$ DECLARE v_name text; BEGIN
    FOREACH v_name IN ARRAY ARRAY['tokentracker_devices','tokentracker_device_codes','tokentracker_device_tokens',
      'tokentracker_hourly','tokentracker_device_machine','tokentracker_account_session_states','tokentracker_cloud_machines'] LOOP
      IF to_regclass('public.'||v_name) IS NULL THEN RAISE EXCEPTION 'Installed table is missing: %',v_name; END IF;
    END LOOP;
    FOREACH v_name IN ARRAY ARRAY['cloud_membership(uuid,text)','cloud_account_access(uuid,text,text)',
      'cloud_ingest_usage(text,text,jsonb,jsonb,text)','cloud_issue_device_token(uuid,text,text,text,text,text[],uuid,text,boolean,text)',
      'account_summary_wire(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'account_daily_wire(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'account_heatmap_wire(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)',
      'account_model_breakdown_wire(uuid,uuid,timestamptz,timestamptz,text,integer,text,text)'] LOOP
      IF to_regprocedure('public.'||v_name) IS NULL THEN RAISE EXCEPTION 'Installed function is missing: %',v_name; END IF;
      IF has_function_privilege('anon','public.'||v_name,'EXECUTE') OR
        has_function_privilege('authenticated','public.'||v_name,'EXECUTE') THEN
        RAISE EXCEPTION 'Private function is exposed to a client role: %',v_name;
      END IF;
    END LOOP;
  END $verify$;`;
  const sql=[preflight,...steps,verify,`UPDATE public.tokentracker_cloud_policy SET hosting_mode = 'self_hosted',phase = 'active',launch_at = coalesce(launch_at,clock_timestamp());\nNOTIFY pgrst,'reload schema';`].join("\n\n");
  return transactional
    ? "BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('tokentracker:self-host-install',0));\n"+sql+"\nCOMMIT;"
    : sql;
}
async function install(db) {
  return db.transaction(async tx=>{
    await tx.exec("SELECT pg_advisory_xact_lock(hashtextextended('tokentracker:self-host-install',0))");
    await tx.exec(buildSql({transactional:false}));
  });
}
function buildMigrationSql() {
  return "SELECT pg_advisory_xact_lock(hashtextextended('tokentracker:self-host-install',0));\n"+buildSql({transactional:false});
}
async function main() {
  const args=process.argv.slice(2);
  const migration=args[0]==="--migration";
  const flagged=migration||args[0]==="--sql";
  const output=args[flagged?1:0];
  if(!output||args.length!==(flagged?2:1)||output.startsWith("--"))throw Error("Usage: node scripts/self-host/install.cjs [--sql|--migration] /absolute/path/to/install.sql");
  const target=path.resolve(output);
  await fs.writeFile(target,(migration?buildMigrationSql():buildSql())+"\n",{mode:0o600});
  console.log(`Wrote self-host ${migration?"platform migration":"standalone transaction"} SQL to ${target}`);
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={buildSql,buildMigrationSql,install};
