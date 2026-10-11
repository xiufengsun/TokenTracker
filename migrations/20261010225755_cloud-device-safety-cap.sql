-- Cloud device admission is an abuse guard, not a five-device plan quota.
-- Preserve all existing membership, gift, expiry and self-hosted semantics.
SET LOCAL lock_timeout = '3s';

ALTER FUNCTION public.cloud_membership(uuid,text)
  RENAME TO cloud_membership_before_device_safety_cap;

CREATE FUNCTION public.cloud_membership(p_user_id uuid,p_environment text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog,public,pg_temp AS $fn$
DECLARE
  v_state jsonb := public.cloud_membership_before_device_safety_cap(p_user_id,p_environment);
BEGIN
  IF v_state->>'hosting_mode' IS DISTINCT FROM 'self_hosted'
    AND v_state->>'status' IN ('active','trial','transition') THEN
    RETURN v_state || jsonb_build_object('machine_limit',99);
  END IF;
  RETURN v_state;
END;
$fn$;

REVOKE ALL ON FUNCTION public.cloud_membership(uuid,text),
  public.cloud_membership_before_device_safety_cap(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_membership(uuid,text),
  public.cloud_membership_before_device_safety_cap(uuid,text) TO project_admin;

COMMENT ON FUNCTION public.cloud_membership(uuid,text) IS
  'Hosted Cloud members have a 99-device safety cap. Free community uploads retain one device; self-hosted access is unchanged.';

NOTIFY pgrst,'reload schema';
