-- Application tables only. InsForge owns auth.users, auth.uid(), and API roles.
CREATE TABLE public.tokentracker_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_name text NOT NULL,
  platform text,
  machine_id text,
  revoked_at timestamptz,
  name_customized boolean NOT NULL DEFAULT false,
  default_device_name text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX tokentracker_devices_machine_unique ON public.tokentracker_devices(user_id,machine_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX tokentracker_devices_active_unique ON public.tokentracker_devices(user_id,platform,device_name) WHERE revoked_at IS NULL;
CREATE TABLE public.tokentracker_device_machine (
  device_id uuid PRIMARY KEY REFERENCES public.tokentracker_devices(id) ON DELETE CASCADE,
  machine_cluster_id text NOT NULL
);
CREATE TABLE public.tokentracker_device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.tokentracker_devices(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.tokentracker_device_codes (
  device_code text PRIMARY KEY,
  user_code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','used','expired')),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  client_info text,
  machine_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.tokentracker_hourly (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.tokentracker_devices(id) ON DELETE CASCADE,
  hour_start timestamptz NOT NULL,
  source text NOT NULL,
  model text NOT NULL,
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  cached_input_tokens bigint NOT NULL CHECK (cached_input_tokens >= 0),
  cache_creation_input_tokens bigint NOT NULL CHECK (cache_creation_input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  reasoning_output_tokens bigint NOT NULL CHECK (reasoning_output_tokens >= 0),
  total_tokens bigint NOT NULL CHECK (total_tokens >= 0),
  billable_total_tokens bigint,
  conversations integer NOT NULL CHECK (conversations >= 0),
  total_cost_usd numeric NOT NULL DEFAULT 0 CHECK (total_cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,device_id,hour_start,source,model)
);
CREATE INDEX tokentracker_hourly_user_time_idx ON public.tokentracker_hourly(user_id,hour_start);
CREATE TABLE public.tokentracker_account_usage_cache (
  cache_key text PRIMARY KEY, fetched_at timestamptz NOT NULL, result jsonb NOT NULL
);
ALTER TABLE public.tokentracker_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_device_machine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_device_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_account_usage_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_devices,public.tokentracker_device_machine,public.tokentracker_device_tokens,
  public.tokentracker_device_codes,public.tokentracker_hourly,public.tokentracker_account_usage_cache FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.tokentracker_devices,public.tokentracker_device_machine,public.tokentracker_device_tokens,
  public.tokentracker_device_codes,public.tokentracker_hourly,public.tokentracker_account_usage_cache TO project_admin;

CREATE INDEX tokentracker_account_usage_cache_owner_idx
  ON public.tokentracker_account_usage_cache((split_part(cache_key,chr(31),2)));
CREATE FUNCTION public.self_host_invalidate_usage_cache() RETURNS trigger LANGUAGE plpgsql
SET search_path = public,pg_temp AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    DELETE FROM public.tokentracker_account_usage_cache
      WHERE split_part(cache_key,chr(31),2) IN (SELECT DISTINCT user_id::text FROM changed_new);
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM public.tokentracker_account_usage_cache
      WHERE split_part(cache_key,chr(31),2) IN (SELECT DISTINCT user_id::text FROM changed_old);
  ELSE
    DELETE FROM public.tokentracker_account_usage_cache
      WHERE split_part(cache_key,chr(31),2) IN (
        SELECT user_id::text FROM changed_new UNION SELECT user_id::text FROM changed_old);
  END IF;
  RETURN NULL;
END;
$fn$;
CREATE TRIGGER self_host_hourly_insert_cache AFTER INSERT ON public.tokentracker_hourly
  REFERENCING NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION public.self_host_invalidate_usage_cache();
CREATE TRIGGER self_host_hourly_update_cache AFTER UPDATE ON public.tokentracker_hourly
  REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION public.self_host_invalidate_usage_cache();
CREATE TRIGGER self_host_hourly_delete_cache AFTER DELETE ON public.tokentracker_hourly
  REFERENCING OLD TABLE AS changed_old FOR EACH STATEMENT EXECUTE FUNCTION public.self_host_invalidate_usage_cache();
REVOKE ALL ON FUNCTION public.self_host_invalidate_usage_cache() FROM PUBLIC,anon,authenticated;
