import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useInsforgeAuth } from "./InsforgeAuthContext.jsx";
import { invalidateAccountResponseCache } from "../lib/api";
import {
  CLOUD_USAGE_SYNCED_EVENT,
  getCloudSyncEnabled,
  getCloudUsageReady,
  isLocalDashboardHost,
  syncCloudSyncPrefToLocalServer,
} from "../lib/cloud-sync-prefs";

/**
 * AccountViewContext decides whether the dashboard reads aggregated cloud
 * data (cross-device, via tokentracker-account-*) or the local CLI queue
 * (per-device, via /functions/tokentracker-usage-*).
 *
 * Two host modes:
 *   - localhost dashboard: signed-in user can opt in via Settings →
 *     Account → Cloud sync toggle. When on, reads switch to cloud.
 *   - non-localhost (e.g. www.tokentracker.cc): the local CLI endpoints
 *     are unreachable, so signed-in users are pinned to cloud reads. A
 *     signed-out visitor on the public host has nothing to render — the
 *     consumer is expected to gate on `signedIn` before calling hooks.
 *
 * `revision` increments whenever the resolved mode flips, so dependent
 * hooks can invalidate their state and avoid showing stale data from the
 * other scope while the new fetch is in flight.
 */
const AccountViewContext = createContext(null);

export const CLOUD_SYNC_CHANGE_EVENT = "tt.cloudSyncChanged";
export function emitCloudSyncChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CLOUD_SYNC_CHANGE_EVENT));
}

export function AccountViewProvider({ children }) {
  const auth = useInsforgeAuth();
  const signedIn = Boolean(auth?.signedIn);
  const authEnabled = Boolean(auth?.enabled);
  const authLoading = Boolean(auth?.loading);

  const [localHost, setLocalHost] = useState(() => isLocalDashboardHost());
  const [cloudSyncOn, setCloudSyncOn] = useState(() => getCloudSyncEnabled());
  const [cloudUsageReady, setCloudUsageReady] = useState(() => getCloudUsageReady());
  const [revision, setRevision] = useState(0);
  const cloudUsageReadyRef = React.useRef(cloudUsageReady);

  useEffect(() => {
    setLocalHost(isLocalDashboardHost());
    // Mirror the persisted cloud-sync toggle to the local CLI server so the
    // native popover's cross-device view tracks the same preference.
    syncCloudSyncPrefToLocalServer();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const refresh = () => {
      // Only mirror the toggle state here. Revision bumps are owned by the
      // accountView-flip effect below — bumping in both places caused every
      // toggle to advance revision by 2 and trigger duplicate refetches.
      const next = getCloudSyncEnabled();
      const nextReady = getCloudUsageReady();
      setCloudSyncOn((prev) => (prev === next ? prev : next));
      cloudUsageReadyRef.current = nextReady;
      setCloudUsageReady((prev) => (prev === nextReady ? prev : nextReady));
    };
    window.addEventListener(CLOUD_SYNC_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CLOUD_SYNC_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const invalidateAccountUsage = () => {
      invalidateAccountResponseCache();
      if (cloudUsageReadyRef.current) {
        setRevision((n) => n + 1);
        return;
      }
      cloudUsageReadyRef.current = true;
      setCloudUsageReady(true);
    };
    window.addEventListener(CLOUD_USAGE_SYNCED_EVENT, invalidateAccountUsage);
    return () => window.removeEventListener(CLOUD_USAGE_SYNCED_EVENT, invalidateAccountUsage);
  }, []);

  // Public host: cloud is mandatory for signed-in users; signed-out users
  // get a no-data state (false) but the page should redirect to /login.
  // Local host: opt-in via the toggle.
  const accountView = useMemo(() => {
    if (!authEnabled || !signedIn) return false;
    if (!localHost) return true;
    return cloudSyncOn && cloudUsageReady;
  }, [authEnabled, signedIn, localHost, cloudSyncOn, cloudUsageReady]);

  // Single source of truth for revision bumps: fire when the *resolved*
  // accountView flips. Covers signIn/signOut, host change, and the
  // cloudSyncOn toggle in one place.
  const lastResolved = React.useRef(accountView);
  useEffect(() => {
    if (lastResolved.current !== accountView) {
      invalidateAccountResponseCache();
      lastResolved.current = accountView;
      setRevision((n) => n + 1);
    }
  }, [accountView]);

  // While auth is still resolving, `signedIn` is false, so `accountView`
  // defaults to false (local). For a user who will land on cloud (public host,
  // or cloud-sync opted in on localhost), that makes the dashboard paint local
  // data on first render and then re-paint cloud data once auth resolves — the
  // "double flash". `resolving` lets dependent hooks hold a loading state
  // instead of committing the soon-to-be-discarded local fetch. We only gate
  // when cloud is the *likely* resolved scope; a local-only user (no cloud
  // sync, signed out) must still get instant local data.
  const expectCloud = authEnabled && (!localHost || (cloudSyncOn && cloudUsageReady));
  const resolving = authLoading && expectCloud;

  const value = useMemo(
    () => ({ accountView, revision, localHost, resolving }),
    [accountView, revision, localHost, resolving],
  );

  return (
    <AccountViewContext.Provider value={value}>{children}</AccountViewContext.Provider>
  );
}

export function useAccountView() {
  const ctx = useContext(AccountViewContext);
  if (ctx) return ctx;
  return { accountView: false, revision: 0, localHost: true, resolving: false };
}
