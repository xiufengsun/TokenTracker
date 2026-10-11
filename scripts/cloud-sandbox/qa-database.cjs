const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const ROOT = path.resolve(__dirname, "../..");
const PREFIX = "tt_cloud_qa_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE_TABLES = [
  "tokentracker_devices", "tokentracker_device_machine", "tokentracker_device_tokens", "tokentracker_device_codes",
  "tokentracker_hourly", "tokentracker_account_session_states", "tokentracker_account_usage_cache",
  "tokentracker_cloud_machines", "tokentracker_cloud_machine_aliases",
  "tokentracker_leaderboard_rollup_daily_v2", "tokentracker_leaderboard_rollup_meta_v2", "tokentracker_leaderboard_rollup_total_v2",
  "tokentracker_leaderboard_snapshots", "agentmeter_leaderboard_snapshots", "tokentracker_leaderboard_rollup_daily", "agentmeter_hourly",
];
const ARCHIVE_TABLES = ["tokentracker_usage_dirty_days", "tokentracker_usage_archive_generations",
  "tokentracker_usage_archive_manifest", "tokentracker_usage_maintenance_operations"];
const SOURCE_FUNCTIONS = [
  "leaderboard_pricing_tier", "tokentracker_upsert_account_session_states", "refresh_tokentracker_device_identity",
  "account_usage_grouped", "account_usage_grouped_v2", "account_usage_grouped_cached",
  "leaderboard_hourly_dedup_v2", "leaderboard_rollup_daily_replace_v2", "leaderboard_rollup_daily_advance_v2",
  "leaderboard_rollup_total_v2_after_insert", "leaderboard_rollup_total_v2_after_delete", "leaderboard_rollup_total_v2_after_update",
  "account_summary_compact", "account_daily_compact", "account_heatmap_compact", "account_model_breakdown_compact",
  "account_summary_wire", "account_daily_wire", "account_heatmap_wire", "account_model_breakdown_wire",
];
const MACHINE_FUNCTIONS = ["cloud_merge_machine_slots", "cloud_bind_device_slot", "cloud_reconcile_machines",
  "cloud_list_machines", "cloud_set_machine_status", "cloud_remove_machine", "cloud_resume_machine",
  "cloud_issue_device_token", "cloud_grant_device_code", "cloud_account_access", "cloud_ingest_usage"];
const ARCHIVE_FUNCTIONS = ["cloud_usage_maintenance_lock", "cloud_usage_written", "cloud_usage_cache_written", "cloud_usage_hourly",
  "cloud_prepare_usage_archive", "cloud_commit_usage_archive", "cloud_merge_usage_archive", "cloud_repair_usage_days",
  "cloud_usage_begin_operation", "cloud_prepare_usage_archive_operation", "cloud_commit_usage_archive_operation",
  "cloud_restore_usage_archive", "cloud_cleanup_usage_archive", "cloud_erase_user_usage", "cloud_usage_maintenance_plan"];
const EXTRA_OBJECTS = ["tokentracker_cloud_policy", "tokentracker_usage_revision_seq", "tokentracker_usage_archive_day_idx",
  "tokentracker_account_usage_cache_user_idx", "cloud_hourly_revision", "cloud_session_revision",
  "cloud_hourly_cache_insert", "cloud_hourly_cache_update", "cloud_session_cache_insert", "cloud_session_cache_update"];
const TABLE_MAP = Object.freeze(Object.fromEntries([...BASE_TABLES, ...ARCHIVE_TABLES, "tokentracker_cloud_policy"].map(name => [name, PREFIX + name])));
const RPC_MAP = Object.freeze(Object.fromEntries([...SOURCE_FUNCTIONS, ...MACHINE_FUNCTIONS, ...ARCHIVE_FUNCTIONS, "cloud_membership"].map(name => [name, PREFIX + name])));
const OBJECT_MAP = Object.freeze({ ...TABLE_MAP, ...RPC_MAP, ...Object.fromEntries(EXTRA_OBJECTS.map(name => [name, PREFIX + name])) });
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const sha = value => createHash("sha256").update(value).digest("hex");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");

function functionSql(source, name) {
  const matches = [...source.matchAll(new RegExp("CREATE(?: OR REPLACE)? FUNCTION public\\." + escape(name) + "\\s*\\(", "g"))];
  if (matches.length !== 1) throw Error("Expected one reviewed function: " + name);
  const start = matches[0].index;
  const header = source.slice(start).match(/\bAS (\$\w*\$)/);
  if (!header) throw Error("Missing function delimiter: " + name);
  const body = start + header.index + header[0].length;
  const end = source.indexOf(header[1], body);
  const terminator = end < 0 ? null : source.slice(end + header[1].length).match(/^\s*;/);
  if (!terminator) throw Error("Missing function terminator: " + name);
  return source.slice(start, end + header[1].length + terminator[0].length);
}

function assertIsolated(source, { membershipBridge = false, policyBridge = false } = {}) {
  const qualified = [...source.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)/gi)].map(match => match[1]);
  for (const name of qualified) {
    if (name.startsWith(PREFIX)) continue;
    if (membershipBridge && name === "cloud_membership") continue;
    if (policyBridge && name === "tokentracker_cloud_policy") continue;
    throw Error("Unmapped public reference: " + name);
  }
  if (/\b(?:tokentracker_[a-z0-9_]+|agentmeter_[a-z0-9_]+)\b/i.test(source.replaceAll("public.tokentracker_cloud_policy", policyBridge ? PREFIX + "policy" : "public.tokentracker_cloud_policy"))) {
    throw Error("Unmapped usage/token object name");
  }
  for (const match of source.matchAll(/\b((?:cloud_|account_|leaderboard_)[a-z0-9_]+)\s*\(/gi)) {
    if (membershipBridge && match[1] === "cloud_membership") continue;
    throw Error("Unmapped RPC reference: " + match[1]);
  }
  if (/\bhashtextextended\s*\(/i.test(source) || /\bhashtext\s*\(/i.test(source)) throw Error("Unscoped advisory lock key");
  if (/\bSET(?: LOCAL)?\s+statement_timeout\b/i.test(source)) throw Error("QA must inherit the platform statement timeout");
  if (/\bCREATE\s+(?:SCHEMA|ROLE)\b/i.test(source)) throw Error("QA cannot create schemas or roles");
}

function rewrite(source) {
  let result = source.replace(/^\s*SET statement_timeout (?:TO|=) [^\n]+\n/gmi, "\n");
  const names = Object.keys(OBJECT_MAP).sort((a, b) => b.length - a.length);
  result = result.replace(new RegExp("\\b(" + names.map(escape).join("|") + ")\\b", "g"), name => OBJECT_MAP[name]);
  result = result.replace(/\bhashtextextended\s*\(/g, "public." + PREFIX + "lock_key(");
  assertIsolated(result);
  return result;
}

function buildSql({ allowedUsers, baselineSql }) {
  if (!Array.isArray(allowedUsers) || allowedUsers.length < 1 || allowedUsers.length > 8 || allowedUsers.some(id => !UUID.test(id))) {
    throw Error("Supply one to eight actual application test-user UUIDs");
  }
  const users = [...new Set(allowedUsers.map(id => id.toLowerCase()))].sort();
  if (users.length !== allowedUsers.length || typeof baselineSql !== "string") throw Error("Invalid QA users or baseline snapshot");
  for (const name of Object.values(OBJECT_MAP)) if (Buffer.byteLength(name) > 63) throw Error("QA identifier exceeds PostgreSQL's limit: " + name);
  const sourceFunctions = SOURCE_FUNCTIONS.map(name => functionSql(baselineSql, name));
  const machineSource = read("migrations/20261004120000_cloud-machine-access.sql");
  const machineFunctions = MACHINE_FUNCTIONS.map(name => functionSql(machineSource, name));
  // Retain the current self-host-aware access rule while using real sandbox membership.
  machineFunctions[MACHINE_FUNCTIONS.indexOf("cloud_account_access")] = functionSql(read("migrations/20261008120000_self-hosted-access.sql"), "cloud_account_access");
  const archive = rewrite(read("migrations/20261005120000_cloud-usage-archive.sql"));
  const clonedFunctions = [...sourceFunctions, ...machineFunctions].map(rewrite).join("\n\n");
  const userArray = "ARRAY[" + users.map(id => literal(id) + "::uuid").join(",") + "]";
  const membership = `CREATE FUNCTION public.${RPC_MAP.cloud_membership}(p_user_id uuid,p_environment text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO public,pg_temp AS $member$
BEGIN
  IF p_environment IS DISTINCT FROM 'sandbox' OR NOT EXISTS (
    SELECT 1 FROM public.${PREFIX}allowed_users WHERE user_id=p_user_id) THEN
    RAISE EXCEPTION 'QA membership requires an allowed sandbox test user';
  END IF;
  RETURN public.cloud_membership(p_user_id,'sandbox');
END $member$;`;
  assertIsolated(membership, { membershipBridge: true });
  const policy = `CREATE VIEW public.${TABLE_MAP.tokentracker_cloud_policy} WITH (security_invoker=true) AS
SELECT environment,phase,launch_at,hosting_mode FROM public.tokentracker_cloud_policy WHERE environment='sandbox' OFFSET 0;`;
  assertIsolated(policy, { policyBridge: true });
  const baseline = BASE_TABLES.map(name => `
CREATE TABLE public.${TABLE_MAP[name]} (LIKE public.${name} INCLUDING ALL);
ALTER TABLE public.${TABLE_MAP[name]} ENABLE ROW LEVEL SECURITY;
DO $scope$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.${TABLE_MAP[name]}'::regclass AND attname='user_id' AND NOT attisdropped) THEN
    ALTER TABLE public.${TABLE_MAP[name]} ADD FOREIGN KEY(user_id) REFERENCES public.${PREFIX}allowed_users(user_id);
  END IF;
END $scope$;`).join("\n");
  const totalsTriggers = ["insert", "delete", "update"].map(action => `CREATE TRIGGER ${PREFIX}total_${action}
AFTER ${action.toUpperCase()} ON public.${TABLE_MAP.tokentracker_leaderboard_rollup_daily_v2}
${action === "insert" ? "REFERENCING NEW TABLE AS new_rows" : action === "delete" ? "REFERENCING OLD TABLE AS old_rows" : "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows"}
FOR EACH STATEMENT EXECUTE FUNCTION public.${RPC_MAP["leaderboard_rollup_total_v2_after_" + action]}();`).join("\n");
  const content = `CREATE TABLE public.${PREFIX}allowed_users(user_id uuid PRIMARY KEY REFERENCES auth.users(id));
INSERT INTO public.${PREFIX}allowed_users SELECT unnest(${userArray});
ALTER TABLE public.${PREFIX}allowed_users ENABLE ROW LEVEL SECURITY;
${baseline}
ALTER TABLE public.${TABLE_MAP.tokentracker_device_tokens} ALTER COLUMN cloud_environment SET DEFAULT 'sandbox';
ALTER TABLE public.${TABLE_MAP.tokentracker_device_tokens} ADD CHECK(cloud_environment='sandbox');
ALTER TABLE public.${TABLE_MAP.tokentracker_cloud_machines} ADD CHECK(environment='sandbox');
ALTER TABLE public.${TABLE_MAP.tokentracker_cloud_machine_aliases} ADD CHECK(environment='sandbox');
ALTER TABLE public.${TABLE_MAP.tokentracker_device_machine} ADD FOREIGN KEY(device_id) REFERENCES public.${TABLE_MAP.tokentracker_devices}(id);
ALTER TABLE public.${TABLE_MAP.tokentracker_device_tokens} ADD FOREIGN KEY(device_id) REFERENCES public.${TABLE_MAP.tokentracker_devices}(id);
ALTER TABLE public.${TABLE_MAP.tokentracker_hourly} ADD FOREIGN KEY(device_id) REFERENCES public.${TABLE_MAP.tokentracker_devices}(id);
ALTER TABLE public.${TABLE_MAP.tokentracker_cloud_machine_aliases} ADD FOREIGN KEY(user_id,environment,machine_id)
  REFERENCES public.${TABLE_MAP.tokentracker_cloud_machines}(user_id,environment,id);
${policy}
CREATE FUNCTION public.${PREFIX}lock_key(p_value text,p_seed bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS $lock$
  SELECT pg_catalog.hashtextextended('tt_cloud_qa:'||p_value,p_seed)
$lock$;
${membership}
${clonedFunctions}
${totalsTriggers}
${archive}
${ARCHIVE_TABLES.map(name => `ALTER TABLE public.${TABLE_MAP[name]} ADD FOREIGN KEY(user_id) REFERENCES public.${PREFIX}allowed_users(user_id);`).join("\n")}`;
  const fingerprint = sha(content);
  const sourceHashes = Object.fromEntries(sourceFunctions.map((source, i) => [SOURCE_FUNCTIONS[i], sha(source)]));
  const sourceMd5 = Object.fromEntries(sourceFunctions.map((source, i) => [SOURCE_FUNCTIONS[i],
    createHash("md5").update(source.replace(/;\s*$/, "").trimEnd() + "\n").digest("hex")]));
  const sourceStamp = JSON.stringify(sourceHashes);
  const knownNames = [...BASE_TABLES, ...ARCHIVE_TABLES, ...EXTRA_OBJECTS, ...SOURCE_FUNCTIONS, ...MACHINE_FUNCTIONS, ...ARCHIVE_FUNCTIONS, "cloud_membership", "allowed_users", "installation", "lock_key"].map(name => name.startsWith(PREFIX) ? name : PREFIX + name);
  const knownArray = "ARRAY[" + [...new Set(knownNames)].map(literal).join(",") + "]";
  const baseNames = "ARRAY[" + BASE_TABLES.map(literal).join(",") + "]";
  const grants = `DO $acl$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid::regclass AS name,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(${knownArray}) AND c.relkind IN ('r','v','S') LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC,anon,authenticated',r.name);
    IF r.relkind='v' THEN EXECUTE format('GRANT SELECT ON %s TO project_admin',r.name);
    ELSE EXECUTE format('GRANT ALL ON %s TO project_admin',r.name); END IF;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY(${knownArray}) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin',r.name);
  END LOOP;
END $acl$;`;
  const validate = `DO $verify$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(${knownArray}) AND c.relkind IN ('r','v','S') LOOP
    IF EXISTS(SELECT 1 FROM pg_class WHERE oid=r.oid AND relkind='r' AND NOT relrowsecurity) THEN
      RAISE EXCEPTION 'QA table requires row-level security';
    END IF;
    IF (SELECT relkind FROM pg_class WHERE oid=r.oid)='S' THEN
      IF has_sequence_privilege('anon',r.oid,'USAGE,SELECT,UPDATE') OR has_sequence_privilege('authenticated',r.oid,'USAGE,SELECT,UPDATE') THEN
        RAISE EXCEPTION 'QA sequence became accessible by a client role';
      END IF;
    ELSIF has_table_privilege('anon',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege('authenticated',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'QA object became readable by a client role';
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY(${knownArray}) LOOP
    IF has_function_privilege('anon',r.oid,'EXECUTE') OR has_function_privilege('authenticated',r.oid,'EXECUTE') THEN
      RAISE EXCEPTION 'QA function became executable by a client role';
    END IF;
  END LOOP;
END $verify$;`;
  return `-- Dedicated QA objects only. Run through the platform's migration transaction.
-- Source snapshot SHA256 ${sha(baselineSql)}; cloned function timeouts are removed.
SET LOCAL lock_timeout='3s';
DO $install$ DECLARE r record; v_name text; v_expected jsonb:=${literal(JSON.stringify(sourceMd5))}::jsonb; BEGIN
  PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('tt_cloud_qa:installer',0));
  FOR v_name IN SELECT jsonb_object_keys(v_expected) LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=v_name)<>1 OR
      (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=v_name)
        IS DISTINCT FROM v_expected->>v_name THEN RAISE EXCEPTION 'Reviewed source snapshot drift: %',v_name; END IF;
  END LOOP;
  IF to_regclass('public.${PREFIX}installation') IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.${PREFIX}installation WHERE id=1 AND fingerprint=${literal(fingerprint)}
      AND allowed_users=to_jsonb(${userArray})) THEN RAISE EXCEPTION 'Existing QA installation has another reviewed scope or version'; END IF;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND starts_with(c.relname,'${PREFIX}')) OR
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND starts_with(p.proname,'${PREFIX}')) THEN
    RAISE EXCEPTION 'Refuse unregistered QA objects';
  END IF;
  IF (SELECT count(*) FROM auth.users WHERE id=ANY(${userArray}))<>${users.length} OR
    NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='project_admin' AND rolbypassrls) THEN
    RAISE EXCEPTION 'Actual application test users and the server role are required';
  END IF;
  FOREACH v_name IN ARRAY ${baseNames} LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_name AND c.relkind='r') THEN
      RAISE EXCEPTION 'Missing verified baseline table %',v_name;
    END IF;
    IF EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=to_regclass('public.'||v_name)
      AND pg_get_expr(d.adbin,d.adrelid) ~ '(nextval|public[.])') THEN
      RAISE EXCEPTION 'Unreviewed shared baseline default in %',v_name;
    END IF;
  END LOOP;
  EXECUTE ${literal(content)};
  CREATE TABLE public.${PREFIX}installation(id integer PRIMARY KEY CHECK(id=1),fingerprint text NOT NULL,
    allowed_users jsonb NOT NULL,source_hashes jsonb NOT NULL,installed_at timestamptz NOT NULL DEFAULT clock_timestamp());
  ALTER TABLE public.${PREFIX}installation ENABLE ROW LEVEL SECURITY;
  INSERT INTO public.${PREFIX}installation VALUES(1,${literal(fingerprint)},to_jsonb(${userArray}),${literal(sourceStamp)}::jsonb,clock_timestamp());
END $install$;
${grants}
${validate}
NOTIFY pgrst,'reload schema';\n`;
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--baseline", "--users", "--output"].includes(argv[i]) || !argv[i + 1] || options[argv[i]]) throw Error("Use --baseline SQL --users UUID,UUID --output .tmp/path.sql");
    options[argv[i]] = argv[i + 1];
  }
  const output = path.resolve(ROOT, options["--output"] || "");
  if (!options["--baseline"] || !options["--users"] || !output.startsWith(path.join(ROOT, ".tmp") + path.sep)) throw Error("QA SQL output must be inside the ignored .tmp directory");
  const sql = buildSql({ allowedUsers: options["--users"].split(","), baselineSql: fs.readFileSync(options["--baseline"], "utf8") });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, sql, { mode: 0o600 });
  console.log("Wrote isolated QA SQL: " + output);
}
module.exports = { PREFIX, BASE_TABLES, SOURCE_FUNCTIONS, MACHINE_FUNCTIONS, ARCHIVE_FUNCTIONS, TABLE_MAP, RPC_MAP, OBJECT_MAP, functionSql, rewrite, assertIsolated, buildSql, main };
if (require.main === module) try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
