-- Historical maintenance snapshots are server-only, just like their source
-- device/token tables. Preserve all rows and owner/service access while closing
-- the default PostgREST grants discovered during the Pro launch audit.
-- InsForge's migration runner owns the transaction; explicit BEGIN/COMMIT
-- statements are rejected by its SQL safety checks.
SET LOCAL lock_timeout = '3s';
DO $migration$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tt_split_anchor_devices_backup_20260721',
    'tt_split_anchor_tokens_backup_20260721'
  ] LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    END IF;
  END LOOP;
END
$migration$;
