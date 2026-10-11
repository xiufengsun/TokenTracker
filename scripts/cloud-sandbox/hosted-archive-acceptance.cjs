const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, ".tmp/waffo/hosted");
const ORIGIN = "https://srctyff5.us-east.insforge.app";
const MODEL = "qa-archive-controlled-";
const FROM = "2026-06-01T00:00:00Z", TO = "2026-06-04T00:00:00Z";
const PREFIX = "tt_cloud_qa_acceptance_archive_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELPERS = { hold: PREFIX + "hold", write: PREFIX + "write", inspect: PREFIX + "inspect", logical: PREFIX + "logical" };
const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);

function helperSql({ userId, deviceId }) {
  if (!UUID.test(userId || "") || !UUID.test(deviceId || "")) throw Error("Bind helpers to the approved actual user and A1 device UUIDs");
  const guard = `IF p_user_id IS DISTINCT FROM '${userId}'::uuid OR p_device_id IS DISTINCT FROM '${deviceId}'::uuid OR
    NOT EXISTS(SELECT 1 FROM public.tt_cloud_qa_allowed_users WHERE user_id=p_user_id) OR
    NOT EXISTS(SELECT 1 FROM public.tt_cloud_qa_tokentracker_devices WHERE id=p_device_id AND user_id=p_user_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Archive acceptance requires an allowed owner and existing QA device';
  END IF;`;
  return `-- Controlled June sample and QA objects only. Platform migration transaction required.
SET LOCAL lock_timeout='3s';
CREATE TABLE public.${PREFIX}operations(
  operation_id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES public.tt_cloud_qa_allowed_users(user_id),
  device_id uuid NOT NULL REFERENCES public.tt_cloud_qa_tokentracker_devices(id),scope jsonb NOT NULL,result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(user_id='${userId}'::uuid AND device_id='${deviceId}'::uuid));
ALTER TABLE public.${PREFIX}operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.${PREFIX}operations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.${PREFIX}operations TO project_admin;

CREATE FUNCTION public.${HELPERS.hold}(p_user_id uuid,p_device_id uuid,p_hold_ms integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $hold$
DECLARE v_start timestamptz:=clock_timestamp();v_acquired timestamptz;
BEGIN
  ${guard}
  IF p_hold_ms IS NULL OR p_hold_ms NOT BETWEEN 0 AND 2000 THEN RAISE EXCEPTION 'Hold is bounded to 0..2000ms'; END IF;
  PERFORM public.tt_cloud_qa_cloud_usage_maintenance_lock(p_user_id);
  v_acquired:=clock_timestamp();
  PERFORM pg_sleep(p_hold_ms/1000.0);
  RETURN jsonb_build_object('backend_pid',pg_backend_pid(),'started_at',v_start,'acquired_at',v_acquired,
    'finished_at',clock_timestamp(),'wait_ms',extract(epoch FROM v_acquired-v_start)*1000,'hold_ms',p_hold_ms);
END $hold$;

CREATE FUNCTION public.${HELPERS.write}(p_operation uuid,p_user_id uuid,p_device_id uuid,p_action text,p_day date,
  p_value integer DEFAULT 0,p_hold_ms integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $write$
DECLARE v_scope jsonb;v_saved record;v_count integer;v_result jsonb;v_started timestamptz:=clock_timestamp();
BEGIN
  ${guard}
  IF p_operation IS NULL OR p_action NOT IN ('seed','correct') OR p_action IS NULL OR
    p_day IS NULL OR p_day NOT BETWEEN date '2026-06-01' AND date '2026-06-03' OR
    p_value IS NULL OR p_value NOT BETWEEN 0 AND 1000 OR p_hold_ms IS NULL OR p_hold_ms NOT BETWEEN 0 AND 2000 THEN
    RAISE EXCEPTION 'Invalid controlled archive sample scope';
  END IF;
  PERFORM public.tt_cloud_qa_cloud_usage_maintenance_lock(p_user_id);
  v_scope:=jsonb_build_object('action',p_action,'day',p_day,'value',p_value);
  SELECT * INTO v_saved FROM public.${PREFIX}operations WHERE operation_id=p_operation;
  IF FOUND THEN
    IF v_saved.user_id<>p_user_id OR v_saved.device_id<>p_device_id OR v_saved.scope<>v_scope THEN RAISE EXCEPTION 'Acceptance operation scope changed'; END IF;
    RETURN v_saved.result||jsonb_build_object('replayed',true);
  END IF;
  IF p_action='seed' THEN
    IF p_day<>date '2026-06-01' THEN RAISE EXCEPTION 'Seed uses exactly June1..June3'; END IF;
    SELECT count(*) INTO v_count FROM public.tt_cloud_qa_cloud_usage_hourly(p_user_id,p_device_id,timestamptz '${FROM}',timestamptz '${TO}')
      WHERE model LIKE '${MODEL}%';
    IF v_count>0 THEN RAISE EXCEPTION 'Controlled sample already exists; resume its recorded run'; END IF;
    INSERT INTO public.tt_cloud_qa_tokentracker_hourly(user_id,device_id,hour_start,source,model,input_tokens,cached_input_tokens,
      cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,billable_total_tokens,conversations,total_cost_usd)
    SELECT p_user_id,p_device_id,timestamptz '${FROM}'+(n/4)*interval '30 minutes','codex','${MODEL}'||(n%4),
      100+n,0,0,0,0,100+n,100+n,1,0 FROM generate_series(0,575) n;
    GET DIAGNOSTICS v_count=ROW_COUNT;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.tt_cloud_qa_cloud_usage_hourly(p_user_id,p_device_id,
      p_day::timestamp AT TIME ZONE 'UTC',(p_day+1)::timestamp AT TIME ZONE 'UTC')
      WHERE source='codex' AND model='${MODEL}0' AND hour_start=p_day::timestamp AT TIME ZONE 'UTC') THEN
      RAISE EXCEPTION 'Correction requires the existing controlled bucket';
    END IF;
    INSERT INTO public.tt_cloud_qa_tokentracker_hourly(user_id,device_id,hour_start,source,model,input_tokens,cached_input_tokens,
      cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,billable_total_tokens,conversations,total_cost_usd)
    VALUES(p_user_id,p_device_id,p_day::timestamp AT TIME ZONE 'UTC','codex','${MODEL}0',p_value,0,0,0,0,p_value,p_value,1,0)
    ON CONFLICT(user_id,device_id,hour_start,source,model) DO UPDATE SET input_tokens=excluded.input_tokens,
      total_tokens=excluded.total_tokens,billable_total_tokens=excluded.billable_total_tokens,updated_at=clock_timestamp();
    GET DIAGNOSTICS v_count=ROW_COUNT;
  END IF;
  PERFORM pg_sleep(p_hold_ms/1000.0);
  v_result:=jsonb_build_object('backend_pid',pg_backend_pid(),'action',p_action,'rows',v_count,
    'started_at',v_started,'finished_at',clock_timestamp());
  INSERT INTO public.${PREFIX}operations(operation_id,user_id,device_id,scope,result) VALUES(p_operation,p_user_id,p_device_id,v_scope,v_result);
  RETURN v_result;
END $write$;

CREATE FUNCTION public.${HELPERS.inspect}(p_user_id uuid,p_device_id uuid,p_action text)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $inspect$
DECLARE v_key bigint;v_result jsonb;v_plan jsonb;v_rows jsonb;v_sizes jsonb;
BEGIN
  ${guard}
  IF p_action='locks' THEN
    v_key:=public.tt_cloud_qa_lock_key('usage-maintenance:'||p_user_id::text,0);
    SELECT coalesce(jsonb_agg(jsonb_build_object('pid',pid,'granted',granted,'mode',mode)),'[]') INTO v_result
      FROM pg_locks WHERE locktype='advisory' AND objsubid=1 AND classid::bigint=((v_key>>32)&4294967295::bigint)
        AND objid::bigint=(v_key&4294967295::bigint);
    RETURN jsonb_build_object('backend_pid',pg_backend_pid(),'locks',v_result);
  ELSIF p_action='truth' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY hour_start,source,model),'[]') INTO v_result
    FROM public.tt_cloud_qa_cloud_usage_hourly(p_user_id,p_device_id,timestamptz '${FROM}',timestamptz '${TO}') h
    WHERE model LIKE '${MODEL}%';
    RETURN jsonb_build_object('backend_pid',pg_backend_pid(),'rows',v_result);
  ELSIF p_action='metrics' THEN
    SELECT jsonb_build_object('hot_rows',count(*),'hot_datum_bytes',coalesce(sum(pg_column_size(h)),0)) INTO v_rows
    FROM public.tt_cloud_qa_tokentracker_hourly h WHERE user_id=p_user_id AND device_id=p_device_id
      AND hour_start>=timestamptz '${FROM}' AND hour_start<timestamptz '${TO}' AND model LIKE '${MODEL}%';
    SELECT v_rows||jsonb_build_object('packs',count(*),'cold_rows',coalesce(sum(g.row_count),0),
      'payload_datum_bytes',coalesce(sum(pg_column_size(g.payload)),0)) INTO v_rows
    FROM public.tt_cloud_qa_tokentracker_usage_archive_manifest m
    JOIN public.tt_cloud_qa_tokentracker_usage_archive_generations g ON g.id=m.generation_id
    WHERE m.user_id=p_user_id AND m.device_id=p_device_id AND m.day BETWEEN date '2026-06-01' AND date '2026-06-03';
    SELECT jsonb_agg(jsonb_build_object('relation',c.oid::regclass::text,'heap_bytes',pg_relation_size(c.oid),
      'index_bytes',pg_indexes_size(c.oid),'total_bytes',pg_total_relation_size(c.oid),
      'toast_bytes',CASE WHEN c.reltoastrelid=0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END)) INTO v_sizes
    FROM pg_class c WHERE c.oid=ANY(ARRAY[
      'public.tt_cloud_qa_tokentracker_hourly'::regclass,'public.tt_cloud_qa_tokentracker_usage_archive_generations'::regclass,
      'public.tt_cloud_qa_tokentracker_usage_archive_manifest'::regclass,'public.tt_cloud_qa_tokentracker_account_usage_cache'::regclass]);
    RETURN jsonb_build_object('backend_pid',pg_backend_pid(),'sample',v_rows,'shared_qa_relations',v_sizes,
      'cpu_accounting_available',EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_kcache'));
  ELSIF p_action='explain' THEN
    EXECUTE format('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM public.tt_cloud_qa_cloud_usage_hourly(%L::uuid,%L::uuid,%L::timestamptz,%L::timestamptz)',
      p_user_id,p_device_id,'${FROM}','${TO}') INTO v_plan;
    RETURN jsonb_build_object('backend_pid',pg_backend_pid(),'plan',v_plan);
  END IF;
  RAISE EXCEPTION 'Unknown read-only acceptance probe';
END $inspect$;

CREATE FUNCTION public.${HELPERS.logical}(p_user_id uuid,p_device_id uuid,p_action text,p_operation uuid DEFAULT NULL,p_snapshot jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO public,pg_temp AS $logical$
DECLARE v_backup jsonb;v_result jsonb;v_scope jsonb;v_saved record;
BEGIN
  ${guard}
  PERFORM public.tt_cloud_qa_cloud_usage_maintenance_lock(p_user_id);
  IF p_action='backup' THEN
    SELECT jsonb_build_object('user_id',p_user_id,'hourly',coalesce((SELECT jsonb_agg(to_jsonb(h) ORDER BY device_id,hour_start,source,model)
      FROM public.tt_cloud_qa_cloud_usage_hourly(p_user_id,NULL,NULL,NULL) h),'[]'),
      'sessions',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY source,session_id) FROM public.tt_cloud_qa_tokentracker_account_session_states s WHERE user_id=p_user_id),'[]'),
      'daily',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY day,source,model,pricing_tier) FROM public.tt_cloud_qa_tokentracker_leaderboard_rollup_daily_v2 d WHERE user_id=p_user_id),'[]'),
      'totals',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY source,model,pricing_tier) FROM public.tt_cloud_qa_tokentracker_leaderboard_rollup_total_v2 t WHERE user_id=p_user_id),'[]'),
      'operations',coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.tt_cloud_qa_tokentracker_usage_maintenance_operations o WHERE user_id=p_user_id),'[]')) INTO v_backup;
    RETURN v_backup;
  END IF;
  IF p_operation IS NULL OR p_action IS NULL OR p_action NOT IN ('erase','restore') THEN RAISE EXCEPTION 'Explicit bounded logical operation required'; END IF;
  v_scope:=jsonb_build_object('action',p_action,'snapshot_checksum',CASE WHEN p_action='restore' THEN md5(p_snapshot::text) END);
  SELECT * INTO v_saved FROM public.${PREFIX}operations WHERE operation_id=p_operation;
  IF FOUND THEN
    IF v_saved.user_id<>p_user_id OR v_saved.device_id<>p_device_id OR v_saved.scope<>v_scope THEN RAISE EXCEPTION 'Logical operation scope changed'; END IF;
    RETURN v_saved.result||jsonb_build_object('replayed',true);
  END IF;
  IF p_action='erase' THEN
    DELETE FROM public.tt_cloud_qa_tokentracker_hourly WHERE user_id=p_user_id;
    DELETE FROM public.tt_cloud_qa_tokentracker_account_session_states WHERE user_id=p_user_id;
    DELETE FROM public.tt_cloud_qa_tokentracker_usage_archive_manifest WHERE user_id=p_user_id;
    DELETE FROM public.tt_cloud_qa_tokentracker_usage_archive_generations WHERE user_id=p_user_id;
    DELETE FROM public.tt_cloud_qa_tokentracker_usage_dirty_days WHERE user_id=p_user_id;
    DELETE FROM public.tt_cloud_qa_tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=p_user_id::text;
    DELETE FROM public.tt_cloud_qa_tokentracker_leaderboard_rollup_daily_v2 WHERE user_id=p_user_id;
    DELETE FROM public.tt_cloud_qa_tokentracker_leaderboard_rollup_total_v2 WHERE user_id=p_user_id;
    UPDATE public.tt_cloud_qa_tokentracker_usage_maintenance_operations SET status='cancelled' WHERE user_id=p_user_id AND status='prepared';
    v_result:=jsonb_build_object('erased',true,'devices_unchanged',true,'financial_records_unchanged',true);
  ELSE
    IF p_snapshot IS NULL OR pg_column_size(p_snapshot)>2097152 OR p_snapshot->>'user_id' IS DISTINCT FROM p_user_id::text OR
      jsonb_typeof(p_snapshot->'hourly') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'hourly')>2000 OR
      jsonb_typeof(p_snapshot->'sessions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'sessions')>2000 OR
      jsonb_typeof(p_snapshot->'daily') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'daily')>2000 OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(p_snapshot->'hourly') r WHERE r->>'user_id' IS DISTINCT FROM p_user_id::text) OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(p_snapshot->'sessions') r WHERE r->>'user_id' IS DISTINCT FROM p_user_id::text) OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(p_snapshot->'daily') r WHERE r->>'user_id' IS DISTINCT FROM p_user_id::text) OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(p_snapshot->'hourly') r WHERE NOT EXISTS(
        SELECT 1 FROM public.tt_cloud_qa_tokentracker_devices d WHERE d.id=(r->>'device_id')::uuid AND d.user_id=p_user_id)) THEN
      RAISE EXCEPTION 'Invalid scoped logical snapshot';
    END IF;
    IF EXISTS(SELECT 1 FROM public.tt_cloud_qa_cloud_usage_hourly(p_user_id,NULL,NULL,NULL)) OR
      EXISTS(SELECT 1 FROM public.tt_cloud_qa_tokentracker_account_session_states WHERE user_id=p_user_id) THEN
      RAISE EXCEPTION 'Refuse to overwrite usage uploaded after logical erasure';
    END IF;
    INSERT INTO public.tt_cloud_qa_tokentracker_hourly(user_id,device_id,hour_start,source,model,input_tokens,cached_input_tokens,
      cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,billable_total_tokens,conversations,total_cost_usd,created_at,updated_at)
    SELECT user_id,device_id,hour_start,source,model,input_tokens,cached_input_tokens,cache_creation_input_tokens,output_tokens,
      reasoning_output_tokens,total_tokens,billable_total_tokens,conversations,total_cost_usd,created_at,updated_at
    FROM jsonb_populate_recordset(NULL::public.tt_cloud_qa_tokentracker_hourly,p_snapshot->'hourly');
    INSERT INTO public.tt_cloud_qa_tokentracker_account_session_states(user_id,source,session_id,model,bucket_start,input_tokens,
      cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,snapshot_verified_at,updated_at)
    SELECT user_id,source,session_id,model,bucket_start,input_tokens,cached_input_tokens,cache_creation_input_tokens,
      output_tokens,reasoning_output_tokens,total_tokens,snapshot_verified_at,updated_at
    FROM jsonb_populate_recordset(NULL::public.tt_cloud_qa_tokentracker_account_session_states,p_snapshot->'sessions');
    INSERT INTO public.tt_cloud_qa_tokentracker_leaderboard_rollup_daily_v2
      SELECT * FROM jsonb_populate_recordset(NULL::public.tt_cloud_qa_tokentracker_leaderboard_rollup_daily_v2,p_snapshot->'daily');
    v_result:=jsonb_build_object('restored',true,'hourly_rows',jsonb_array_length(p_snapshot->'hourly'),'session_rows',jsonb_array_length(p_snapshot->'sessions'));
  END IF;
  INSERT INTO public.${PREFIX}operations(operation_id,user_id,device_id,scope,result) VALUES(p_operation,p_user_id,p_device_id,v_scope,v_result);
  RETURN v_result;
END $logical$;

REVOKE ALL ON FUNCTION public.${HELPERS.hold}(uuid,uuid,integer),
  public.${HELPERS.write}(uuid,uuid,uuid,text,date,integer,integer),public.${HELPERS.inspect}(uuid,uuid,text),
  public.${HELPERS.logical}(uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.${HELPERS.hold}(uuid,uuid,integer),
  public.${HELPERS.write}(uuid,uuid,uuid,text,date,integer,integer),public.${HELPERS.inspect}(uuid,uuid,text),
  public.${HELPERS.logical}(uuid,uuid,text,uuid,jsonb) TO project_admin;
NOTIFY pgrst,'reload schema';\n`;
}

function credentials(context) {
  const config = JSON.parse(fs.readFileSync(path.join(context, ".insforge/project.json"), "utf8"));
  const origin = new URL(config.oss_host).origin;
  if (origin !== ORIGIN || !config.api_key) throw Error("Use the authorized existing backend's private CLI context");
  return { origin, key: config.api_key };
}
function client(context) {
  const config = credentials(context);
  return async (name, data) => {
    if (!/^tt_cloud_qa_[a-z_][a-z0-9_]*$/.test(name)) throw Error("Only QA RPCs are allowed");
    const start = performance.now();
    const response = await fetch(config.origin + "/api/database/rpc/" + name, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.key }, body: JSON.stringify(data) });
    const body = await response.text();
    if (!response.ok) throw Error("QA RPC " + name + " returned HTTP " + response.status);
    return { status: response.status, latency_ms: performance.now() - start, json_bytes: Buffer.byteLength(body), data: JSON.parse(body) };
  };
}
function recordReader(context) {
  const config = credentials(context);
  const tables = new Set(["tokentracker_cloud_orders", "tokentracker_cloud_payments", "tokentracker_cloud_subscriptions", "tokentracker_cloud_events",
    "tt_cloud_qa_tokentracker_hourly", "tt_cloud_qa_tokentracker_devices", "tt_cloud_qa_tokentracker_device_tokens", "tt_cloud_qa_tokentracker_cloud_machines"]);
  return async (table, filters) => {
    const ownedEvents = table === "tokentracker_cloud_events" && /^in\.\([0-9a-f,-]+\)$/.test(filters.order_id || "");
    if (!tables.has(table) || (!filters.user_id?.startsWith("eq.") && !ownedEvents)) throw Error("Read-only snapshots require a fixed table and exact test user");
    const url = new URL(config.origin + "/api/database/records/" + table);
    for (const [key, value] of Object.entries({ select: "*", limit: "1000", ...filters })) url.searchParams.set(key, value);
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: "Bearer " + config.key } });
    if (!response.ok) throw Error("Scoped read " + table + " returned HTTP " + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length >= 1000) throw Error("Scoped snapshot is invalid or truncated");
    return rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  };
}
async function safeguards(context, scope, sentinel) {
  const read = recordReader(context), rpc = client(context), result = { financial: {} };
  for (const table of ["tokentracker_cloud_orders", "tokentracker_cloud_payments", "tokentracker_cloud_subscriptions"])
    result.financial[table] = await read(table, { user_id: "eq." + scope.p_user_id, environment: "eq.sandbox" });
  const orderIds = result.financial.tokentracker_cloud_orders.map(order => order.id);
  if (!orderIds.every(id => UUID.test(id))) throw Error("Financial event scope has invalid owned order IDs");
  result.financial.tokentracker_cloud_events = orderIds.length ? await read("tokentracker_cloud_events", {
    order_id: "in.(" + orderIds.join(",") + ")", environment: "eq.sandbox" }) : [];
  result.devices = await read("tt_cloud_qa_tokentracker_devices", { user_id: "eq." + scope.p_user_id });
  result.tokens = await read("tt_cloud_qa_tokentracker_device_tokens", { user_id: "eq." + scope.p_user_id,
    select: "id,user_id,device_id,revoked_at,created_at,last_used_at,last_sync_at,cloud_environment" });
  result.machines = await read("tt_cloud_qa_tokentracker_cloud_machines", { user_id: "eq." + scope.p_user_id });
  result.sentinel = await read("tt_cloud_qa_tokentracker_hourly", { user_id: "eq." + sentinel.userId, device_id: "eq." + sentinel.deviceId });
  result.sentinelMembership = (await rpc("tt_cloud_qa_cloud_membership", { p_user_id: sentinel.userId, p_environment: "sandbox" })).data;
  result.membership = (await rpc("tt_cloud_qa_cloud_membership", { p_user_id: scope.p_user_id, p_environment: "sandbox" })).data;
  return result;
}
function save(name, value) {
  if (!/^archive-[a-z0-9-]+\.json$/.test(name)) throw Error("Private archive evidence needs a fixed filename");
  fs.mkdirSync(DIR, { recursive: true });
  const target = path.join(DIR, name), temp = target + "." + randomUUID();
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, target);
}
async function waitForLock(rpc, scope) {
  for (let i = 0; i < 12; i++) {
    const value = await rpc(HELPERS.inspect, { ...scope, p_action: "locks" });
    if (value.data.locks.some(lock => lock.granted)) return value.data;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error("No active QA maintenance holder was observed");
}
async function concurrencyProbe(rpc, scope) {
  const holder = rpc(HELPERS.hold, { ...scope, p_hold_ms: 1500 });
  const observed = await waitForLock(rpc, scope);
  const waiter = rpc(HELPERS.hold, { ...scope, p_hold_ms: 0 });
  const [first, second] = await Promise.all([holder, waiter]);
  if (first.data.backend_pid === second.data.backend_pid || second.data.wait_ms < 100) throw Error("Distinct overlapping SQL backends were not verified");
  const evidence = { observed, holder: first, waiter: second };
  save("archive-lock-probe.json", evidence);
  return evidence;
}

async function coldAcceptance(context, scope, sentinel) {
  const rpc = client(context), filename = path.join(DIR, "archive-checkpoint.json");
  let state;
  if (fs.existsSync(filename)) {
    state = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (canonical(state.scope) !== canonical(scope) || canonical(state.sentinel) !== canonical(sentinel)) throw Error("Archive checkpoint scope changed");
  } else {
    state = { scope, sentinel, operations: {}, results: {} };
    save("archive-checkpoint.json", state);
  }
  const operation = name => { if (!state.operations[name]) { state.operations[name] = randomUUID(); save("archive-checkpoint.json", state); } return state.operations[name]; };
  const step = async (name, fn) => {
    if (state.results[name]) return state.results[name];
    const result = await fn(); state.results[name] = result; save("archive-checkpoint.json", state); return result;
  };
  const before = await safeguards(context, scope, sentinel);
  const summary = value => Object.fromEntries(Object.entries(value).map(([key, data]) => [key, { sha256: sha(canonical(data)), rows: Array.isArray(data) ? data.length : undefined }]));
  save("archive-safeguards-before.json", summary(before));
  const metricsBefore = await step("metrics_before", () => rpc(HELPERS.inspect, { ...scope, p_action: "metrics" }));
  await step("seed", () => rpc(HELPERS.write, { ...scope, p_operation: operation("seed"), p_action: "seed", p_day: "2026-06-01", p_value: 0, p_hold_ms: 0 }));
  const baseline = await step("truth_before", () => rpc(HELPERS.inspect, { ...scope, p_action: "truth" }));
  if (baseline.data.rows.length !== 576) throw Error("Controlled sample did not contain exactly 576 rows");
  const prepared = await step("prepare_june1", () => rpc("tt_cloud_qa_cloud_prepare_usage_archive_operation", {
    ...scope, p_operation: operation("archive_june1"), p_day: "2026-06-01" }));
  const concurrent = await step("concurrent_correction_commit", async () => {
    const correction = rpc(HELPERS.write, { ...scope, p_operation: operation("correct_down"), p_action: "correct", p_day: "2026-06-01", p_value: 60, p_hold_ms: 1500 });
    const observed = await waitForLock(rpc, scope);
    const commit = rpc("tt_cloud_qa_cloud_commit_usage_archive_operation", { p_operation: operation("archive_june1") });
    const [writer, committed] = await Promise.all([correction, commit]);
    if (committed.data.deleted_hot_rows !== 191) throw Error("Revision-safe commit removed the correction");
    return { observed, writer, committed };
  });
  const afterCorrection = await step("truth_down", () => rpc(HELPERS.inspect, { ...scope, p_action: "truth" }));
  const first = rows => rows.find(row => row.model === MODEL + "0" && row.hour_start.startsWith("2026-06-01T00:00:00"));
  if (Number(first(afterCorrection.data.rows)?.total_tokens) !== 60) throw Error("Downward hot correction did not win");
  await step("zero", () => rpc(HELPERS.write, { ...scope, p_operation: operation("correct_zero"), p_action: "correct", p_day: "2026-06-01", p_value: 0, p_hold_ms: 0 }));
  for (const day of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
    const key = "repack_" + day;
    await step(key + "_prepare", () => rpc("tt_cloud_qa_cloud_prepare_usage_archive_operation", { ...scope, p_operation: operation(key), p_day: day }));
    await step(key + "_commit", () => rpc("tt_cloud_qa_cloud_commit_usage_archive_operation", { p_operation: operation(key) }));
  }
  const cold = await step("truth_cold", () => rpc(HELPERS.inspect, { ...scope, p_action: "truth" }));
  if (cold.data.rows.length !== 576 || Number(first(cold.data.rows)?.total_tokens) !== 0) throw Error("Cold truth lost a row or its zero correction");
  const replay = await step("commit_replay", () => rpc("tt_cloud_qa_cloud_commit_usage_archive_operation", { p_operation: operation("repack_2026-06-01") }));
  if (!replay.data.replayed) throw Error("Commit operation replay was not verified");
  const metricsCold = await step("metrics_cold", () => rpc(HELPERS.inspect, { ...scope, p_action: "metrics" }));
  const explain = await step("explain_cold", () => rpc(HELPERS.inspect, { ...scope, p_action: "explain" }));
  const restore = await step("restore_june1", () => rpc("tt_cloud_qa_cloud_restore_usage_archive", {
    ...scope, p_operation: operation("restore_june1"), p_day: "2026-06-01" }));
  const restored = await step("truth_restored", () => rpc(HELPERS.inspect, { ...scope, p_action: "truth" }));
  const strip = rows => rows.map(({ archive_revision, ...row }) => row);
  if (canonical(strip(restored.data.rows)) !== canonical(strip(cold.data.rows))) throw Error("Restore changed complete logical fields");
  const after = await safeguards(context, scope, sentinel);
  if (canonical(after) !== canonical(before)) throw Error("Original financial/device/C sentinel safeguards changed");
  save("archive-safeguards-after.json", summary(after));
  const evidence = { controlled_sample: "576 rows / one existing A1 / three June UTC days", prepared, concurrent, replay,
    metricsBefore, metricsCold, explain, restore, truth_fields_preserved: true, financial_devices_sentinel_unchanged: true };
  save("archive-cold-acceptance.json", evidence);
  return evidence;
}

async function storageMeasurement(context, scope, sentinel) {
  const rpc = client(context), state = JSON.parse(fs.readFileSync(path.join(DIR, "archive-checkpoint.json"), "utf8"));
  if (canonical(state.scope) !== canonical(scope)) throw Error("Storage run must reuse the same controlled sample");
  const before = await safeguards(context, scope, sentinel);
  const step = async (name, call) => {
    if (state.results[name]) return state.results[name];
    if (!state.operations[name]) { state.operations[name] = randomUUID(); save("archive-checkpoint.json", state); }
    const result = await call(state.operations[name]); state.results[name] = result; save("archive-checkpoint.json", state); return result;
  };
  for (const day of ["2026-06-01", "2026-06-02", "2026-06-03"]) await step("measure_restore_" + day, op =>
    rpc("tt_cloud_qa_cloud_restore_usage_archive", { ...scope, p_operation: op, p_day: day }));
  const hot = await step("measure_hot_metrics", () => rpc(HELPERS.inspect, { ...scope, p_action: "metrics" }));
  if (hot.data.sample.hot_rows !== 576) throw Error("Full hot measurement does not contain the complete sample");
  const hotExplain = await step("measure_hot_explain", () => rpc(HELPERS.inspect, { ...scope, p_action: "explain" }));
  for (const day of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
    const name = "measure_archive_" + day;
    if (!state.operations[name]) { state.operations[name] = randomUUID(); save("archive-checkpoint.json", state); }
    await step(name + "_prepare", () => rpc("tt_cloud_qa_cloud_prepare_usage_archive_operation", { ...scope, p_operation: state.operations[name], p_day: day }));
    await step(name + "_commit", () => rpc("tt_cloud_qa_cloud_commit_usage_archive_operation", { p_operation: state.operations[name] }));
  }
  const cold = await step("measure_cold_metrics", () => rpc(HELPERS.inspect, { ...scope, p_action: "metrics" }));
  const coldExplain = await step("measure_cold_explain", () => rpc(HELPERS.inspect, { ...scope, p_action: "explain" }));
  if (cold.data.sample.hot_rows !== 0 || cold.data.sample.cold_rows !== 576) throw Error("Full cold measurement has an unexpected overlay or missing row");
  if (canonical(await safeguards(context, scope, sentinel)) !== canonical(before)) throw Error("Storage measurement changed safeguards");
  const evidence = { hot, cold, hotExplain, coldExplain, scope: "576 controlled QA records; physical relation sizes include other QA fixtures", bill_savings_claimed: false };
  save("archive-storage-measurement.json", evidence);
  return evidence;
}

async function logicalExercise(context, scope, sentinel) {
  const rpc = client(context), file = path.join(DIR, "archive-logical-checkpoint.json");
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {
    scope, sentinel, erase_operation: randomUUID(), restore_operation: randomUUID(), phase: "new" };
  if (canonical(state.scope) !== canonical(scope) || canonical(state.sentinel) !== canonical(sentinel)) throw Error("Logical checkpoint scope changed");
  if (state.phase === "complete") return JSON.parse(fs.readFileSync(path.join(DIR, "archive-logical-acceptance.json"), "utf8"));
  const before = await safeguards(context, scope, sentinel);
  let backup;
  if (state.phase === "new") {
    backup = await rpc(HELPERS.logical, { ...scope, p_action: "backup" });
    save("archive-logical-backup.json", backup.data);
    state.backup_sha256 = sha(canonical(backup.data)); state.phase = "backed_up";
    save("archive-logical-checkpoint.json", state);
  } else backup = { data: JSON.parse(fs.readFileSync(path.join(DIR, "archive-logical-backup.json"), "utf8")) };
  if (sha(canonical(backup.data)) !== state.backup_sha256) throw Error("Private logical backup checksum changed");
  let erased;
  if (state.phase === "backed_up") {
    erased = await rpc(HELPERS.logical, { ...scope, p_action: "erase", p_operation: state.erase_operation });
    const empty = await rpc(HELPERS.logical, { ...scope, p_action: "backup" });
    if (empty.data.hourly.length || empty.data.sessions.length) throw Error("Scoped erasure left logical truth");
    save("archive-logical-erased.json", { erased, empty_rows: 0 });
    state.phase = "erased"; save("archive-logical-checkpoint.json", state);
  }
  const restored = await rpc(HELPERS.logical, { ...scope, p_action: "restore", p_operation: state.restore_operation, p_snapshot: backup.data });
  const afterBackup = await rpc(HELPERS.logical, { ...scope, p_action: "backup" });
  const strip = rows => rows.map(({ archive_revision, ...row }) => row);
  for (const key of ["hourly", "sessions"]) if (canonical(strip(afterBackup.data[key])) !== canonical(strip(backup.data[key]))) throw Error("Logical restore changed complete " + key + " fields");
  for (const key of ["daily", "totals"]) if (canonical(afterBackup.data[key]) !== canonical(backup.data[key])) throw Error("Logical restore changed " + key + " results");
  const replay = await rpc(HELPERS.logical, { ...scope, p_action: "restore", p_operation: state.restore_operation, p_snapshot: backup.data });
  if (!replay.data.replayed || canonical(await safeguards(context, scope, sentinel)) !== canonical(before)) throw Error("Logical recovery replay or safeguards failed");
  const evidence = { backup_sha256: state.backup_sha256, hourly_rows: backup.data.hourly.length, session_rows: backup.data.sessions.length,
    restored, replay, complete_fields_equal_except_revision: true, daily_totals_equal: true, financial_devices_sentinel_unchanged: true,
    vendor_database_restore_claimed: false };
  save("archive-logical-acceptance.json", evidence); state.phase = "complete"; save("archive-logical-checkpoint.json", state); return evidence;
}

async function jwtDailyAcceptance(context, scope, sentinel) {
  const rpc = client(context), before = await safeguards(context, scope, sentinel);
  const initial = await rpc(HELPERS.inspect, { ...scope, p_action: "metrics" });
  if (initial.data.sample.hot_rows !== 576 || initial.data.sample.packs !== 0) throw Error("Restore the complete controlled hot sample before comparing JWT reads");
  const invoke = async () => {
    const start = performance.now();
    const response = await fetch("http://127.0.0.1:5205/ops/invoke", { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({
        original: "tokentracker-account-daily", slug: "tokentracker-account-daily-sandbox", user: "A", method: "GET",
        query: { from: "2026-06-01", to: "2026-06-03", tz: "UTC" } }) });
    const raw = await response.text(), body = JSON.parse(raw);
    if (!response.ok || body.status !== 200) throw Error("Actual signed-user daily handler did not return 200");
    return { proxy_status: response.status, backend_status: body.status, latency_ms: performance.now() - start,
      filtered_proxy_json_bytes: Buffer.byteLength(raw), handler_dto_json_bytes: Buffer.byteLength(JSON.stringify(body.data)), data: body.data };
  };
  const hot = await invoke();
  save("archive-jwt-daily-hot.json", hot);
  for (const day of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
    const op = randomUUID();
    await rpc("tt_cloud_qa_cloud_prepare_usage_archive_operation", { ...scope, p_operation: op, p_day: day });
    await rpc("tt_cloud_qa_cloud_commit_usage_archive_operation", { p_operation: op });
  }
  // The current sample is QA-owned. Force an actual cold scan rather than a 30s cache replay.
  if (!UUID.test(scope.p_user_id)) throw Error("Exact QA cache owner required");
  const sql = "DELETE FROM public.tt_cloud_qa_tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)='" + scope.p_user_id + "'";
  const deletion = spawnSync("npx", ["@insforge/cli", "db", "query", sql, "--json"], { cwd: context, encoding: "utf8" });
  if (deletion.status !== 0) throw Error("Scoped QA cache invalidation failed");
  const cold = await invoke();
  save("archive-jwt-daily-cold.json", cold);
  if (canonical(cold.data) !== canonical(hot.data)) throw Error("Actual JWT daily DTO changed across cold compaction");
  if (canonical(await safeguards(context, scope, sentinel)) !== canonical(before)) throw Error("Actual JWT cold read changed safeguards");
  const evidence = { hot, cold, actual_jwt_from_memory_broker: true, exact_handler_dto_equal: true, qa_cache_invalidated: true,
    controlled_sample_only: true, production_bill_savings_claimed: false };
  save("archive-jwt-daily-acceptance.json", evidence);
  return evidence;
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--helper-sql" && argv.length === 3) {
    fs.mkdirSync(DIR, { recursive: true });
    const sql = helperSql({ userId: argv[1], deviceId: argv[2] }), target = path.join(DIR, "archive-helper.sql");
    fs.writeFileSync(target, sql, { mode: 0o600 });
    console.log(JSON.stringify({ file: target, bytes: Buffer.byteLength(sql), sha256: sha(sql) }));
    return;
  }
  if (argv[0] === "--probe" && argv.length === 4 && UUID.test(argv[2]) && UUID.test(argv[3])) {
    return concurrencyProbe(client(path.resolve(argv[1])), { p_user_id: argv[2], p_device_id: argv[3] })
      .then(result => console.log(JSON.stringify({ distinct_pids: result.holder.data.backend_pid !== result.waiter.data.backend_pid, wait_ms: result.waiter.data.wait_ms })));
  }
  if (argv[0] === "--cold" && argv.length === 6 && argv.slice(2).every(value => UUID.test(value))) {
    return coldAcceptance(path.resolve(argv[1]), { p_user_id: argv[2], p_device_id: argv[3] }, { userId: argv[4], deviceId: argv[5] })
      .then(result => console.log(JSON.stringify({ controlled_rows: 576, cold_rows: result.metricsCold.data.sample.cold_rows,
        payload_bytes: result.metricsCold.data.sample.payload_datum_bytes, complete_fields_preserved: true, safeguards_equal: true })));
  }
  if (["--measure", "--logical", "--jwt-daily"].includes(argv[0]) && argv.length === 6 && argv.slice(2).every(value => UUID.test(value))) {
    const fn = argv[0] === "--measure" ? storageMeasurement : argv[0] === "--logical" ? logicalExercise : jwtDailyAcceptance;
    return fn(path.resolve(argv[1]), { p_user_id: argv[2], p_device_id: argv[3] }, { userId: argv[4], deviceId: argv[5] })
      .then(result => console.log(JSON.stringify(argv[0] === "--measure" ? { hot_datum_bytes: result.hot.data.sample.hot_datum_bytes,
        cold_payload_datum_bytes: result.cold.data.sample.payload_datum_bytes, cpu_accounting_available: result.cold.data.cpu_accounting_available }
        : argv[0] === "--jwt-daily" ? { actual_handler_dto_equal: result.exact_handler_dto_equal,
          hot_json_bytes: result.hot.handler_dto_json_bytes, cold_json_bytes: result.cold.handler_dto_json_bytes }
          : { logical_rows_restored: result.hourly_rows, complete_fields_equal: true, safeguards_equal: true })));
  }
  throw Error("Use --helper-sql USER_UUID A1_DEVICE_UUID; --probe PRIVATE_CONTEXT USER_UUID A1_DEVICE_UUID; or --cold/--measure/--logical PRIVATE_CONTEXT USER_UUID A1_DEVICE_UUID SENTINEL_USER_UUID SENTINEL_DEVICE_UUID");
}
module.exports = { HELPERS, MODEL, FROM, TO, helperSql, client, save, waitForLock, concurrencyProbe, coldAcceptance, storageMeasurement, logicalExercise, jwtDailyAcceptance, safeguards, canonical };
if (require.main === module) Promise.resolve().then(() => main()).catch(error => { console.error(error.message); process.exitCode = 1; });
