import { useCallback, useEffect, useState } from "react";
import { resolveAuthAccessToken } from "../lib/auth-token";
import { fetchAccountDevices } from "../lib/api";
import { useLatestRequestGuard } from "./use-latest-request-guard";
import { isLocalDashboardHost } from "../lib/host-mode";
import { readLocalUsageDevices, LOCAL_USAGE_CHANGED_EVENT } from "../lib/local-usage-transfer";

/**
 * Lists range-bound device totals from the current cloud or local view.
 * Offline imports are read only from the local server, without cloud auth.
 */
export function useAccountDevices({
  from,
  to,
  timeZone,
  tzOffsetMinutes,
  accountView = false,
  accountAccessToken = null,
  accountRevision = 0,
  localView = false,
}: any = {}) {
  const local = localView && !accountView && isLocalDashboardHost();
  const enabled = Boolean(local || (accountView && accountAccessToken));
  const [revision, setRevision] = useState(0);
  const [devices, setDevices] = useState<any[]>([]);
  // Account-level sources (e.g. Cursor) have no device attribution; the edge
  // returns their account-wide totals separately so the card can still show
  // them (otherwise its total is short of the dashboard total by their share).
  const [accountSources, setAccountSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const beginRequest = useLatestRequestGuard([
    enabled,
    local,
    from,
    to,
    timeZone,
    tzOffsetMinutes,
    accountAccessToken,
    accountRevision,
  ]);

  const refresh = useCallback(async () => {
    const isCurrent = beginRequest();
    if (!enabled) {
      setDevices([]);
      setAccountSources([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const token = local ? null : await resolveAuthAccessToken(accountAccessToken);
      if (!isCurrent()) return;
      const res = local
        ? await readLocalUsageDevices({ from, to, timeZone, tzOffsetMinutes })
        : await fetchAccountDevices({ from, to, timeZone, tzOffsetMinutes, accessToken: token });
      if (!isCurrent()) return;
      setDevices(Array.isArray(res?.devices) ? res.devices : []);
      setAccountSources(Array.isArray(res?.account_sources) ? res.account_sources : []);
      setRevision(local ? Number(res?.revision) || 0 : 0);
    } catch (e: any) {
      if (!isCurrent()) return;
      setError(e?.message || String(e));
      setDevices([]);
      setAccountSources([]);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [enabled, local, accountAccessToken, from, to, timeZone, tzOffsetMinutes, accountRevision, beginRequest]);

  useEffect(() => {
    if (!local) return;
    window.addEventListener(LOCAL_USAGE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(LOCAL_USAGE_CHANGED_EVENT, refresh);
  }, [local, refresh]);

  useEffect(() => {
    // Device totals are range-bound; clear them before loading a new range so
    // the selector cannot expose an old range under the current period.
    setDevices([]);
    setAccountSources([]);
    setError(null);
    if (enabled) setLoading(true);
    refresh();
  }, [enabled, refresh]);

  return { devices, accountSources, loading, error, refresh, revision };
}
