-- Cosmetic membership status is read in one batch; it never changes ranking.
CREATE OR REPLACE FUNCTION public.cloud_pro_badges(
  p_user_ids uuid[], p_environment text DEFAULT 'live'
) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_environment NOT IN ('live', 'sandbox') OR p_environment IS NULL THEN
    RAISE EXCEPTION 'Invalid badge environment';
  END IF;
  IF coalesce(cardinality(p_user_ids), 0) > 101 THEN
    RAISE EXCEPTION 'Too many badge users';
  END IF;
  RETURN coalesce((
    SELECT jsonb_object_agg(u.user_id::text, true)
    FROM (SELECT DISTINCT unnest(p_user_ids) AS user_id) u
    WHERE u.user_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.tokentracker_cloud_policy
        WHERE environment = p_environment AND phase = 'active')
      AND NOT EXISTS (SELECT 1 FROM public.tokentracker_user_settings s
        WHERE s.user_id = u.user_id AND s.leaderboard_anonymous)
      AND EXISTS (SELECT 1 FROM public.tokentracker_cloud_payments p
        WHERE p.user_id = u.user_id AND p.environment = p_environment
          AND p.starts_at <= statement_timestamp() AND p.ends_at > statement_timestamp()
          AND p.refunded_cents < p.amount_cents AND p.revoked_at IS NULL)
  ), '{}'::jsonb);
END;
$fn$;

REVOKE ALL ON FUNCTION public.cloud_pro_badges(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_pro_badges(uuid[], text) TO project_admin;
NOTIFY pgrst, 'reload schema';
