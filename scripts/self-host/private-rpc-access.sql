-- Only the private installer owns these aggregation functions and their bootstrap grants.
REVOKE ALL ON FUNCTION public.account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer),
  public.account_usage_grouped_v2(uuid,uuid,timestamptz,timestamptz,text,text,integer),
  public.account_usage_grouped_cached(uuid,uuid,timestamptz,timestamptz,text,text,integer),
  public.refresh_tokentracker_device_identity(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_grouped(uuid,uuid[],timestamptz,timestamptz,text,text,integer),
  public.account_usage_grouped_v2(uuid,uuid,timestamptz,timestamptz,text,text,integer),
  public.account_usage_grouped_cached(uuid,uuid,timestamptz,timestamptz,text,text,integer),
  public.refresh_tokentracker_device_identity(uuid,uuid,text,text) TO project_admin;