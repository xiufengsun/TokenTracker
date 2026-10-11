import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { cloudBillingRequest } from "../lib/cloud-billing";
import { getInsforgeInstanceFingerprint, INSFORGE_INSTANCE_CHANGED_EVENT } from "../lib/insforge-config";

export function useCloudCatalog() {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    cloudBillingRequest("catalog", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setCatalog(value);
          setError(null);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setCatalog(null);
          setError({ ...reason, code: "billing_catalog_unavailable" });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  return {
    catalog,
    loading,
    error,
    refresh: () => setRevision((value) => value + 1),
  };
}

const EMPTY_ACCOUNT = { account: null, loading: false, error: null };
const ACCOUNT_FRESH_MS = 30_000;
const accountScopes = new WeakMap();
const activeAccounts = new Set();
const idleSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_ACCOUNT;

function publishAccount(entry, snapshot) {
  entry.snapshot = snapshot;
  entry.listeners.forEach((listener) => listener());
}

function clearAccount(entry) {
  entry.generation += 1;
  entry.pending = null;
  entry.updatedAt = 0;
  clearTimeout(entry.timer);
  publishAccount(entry, EMPTY_ACCOUNT);
}

function refreshAccount(entry, force = false) {
  if (!entry.listeners.size || entry.backend !== getInsforgeInstanceFingerprint()) return Promise.resolve(null);
  if (entry.pending && !force) return entry.pending;
  const generation = ++entry.generation;
  clearTimeout(entry.timer);
  const current = () => generation === entry.generation && entry.listeners.size > 0
    && entry.backend === getInsforgeInstanceFingerprint();
  entry.pending = Promise.resolve()
    .then(() => current() ? cloudBillingRequest("account", { auth: entry.getAccessToken }) : null)
    .then((account) => {
      if (!current()) return null;
      entry.updatedAt = Date.now();
      publishAccount(entry, { account, loading: false, error: null });
      if (!current()) return null;
      const now = Date.now();
      const boundaries = [account?.membership?.expires_at,
        ...(Array.isArray(account?.payments) ? account.payments : []).flatMap((period) => [period?.starts_at, period?.ends_at]),
        ...(Array.isArray(account?.gifts) ? account.gifts : []).flatMap((period) => [period?.starts_at, period?.ends_at])]
        .map((date) => typeof date === "string" ? Date.parse(date) : NaN).filter((date) => Number.isFinite(date) && date > now);
      if (boundaries.length) {
        entry.timer = setTimeout(() => { void refreshAccount(entry); }, Math.min(Math.min(...boundaries) - now + 10, 2_147_483_647));
      }
      return account;
    }, (error) => {
      if (current()) {
        // A temporary outage must not unmount an already received redemption
        // receipt. Owner/config changes and authorization errors still clear it.
        const transient = error?.code === "billing_network_error" || error?.status >= 500
          || error?.status === 408 || error?.status === 429;
        publishAccount(entry, { account: transient ? entry.snapshot.account : null, loading: false, error });
      }
      return null;
    })
    .finally(() => { if (generation === entry.generation) entry.pending = null; });
  publishAccount(entry, { ...entry.snapshot, loading: true, error: null });
  return entry.pending;
}

function refreshVisibleAccounts() {
  if (document.visibilityState === "visible") activeAccounts.forEach((entry) => { void refreshAccount(entry); });
}
function invalidateAccounts() {
  activeAccounts.forEach(clearAccount);
}

function accountScope(userId, getAccessToken, backend) {
  let scopes = accountScopes.get(getAccessToken);
  if (!scopes) { scopes = new Map(); accountScopes.set(getAccessToken, scopes); }
  const key = JSON.stringify([backend, userId]);
  if (!scopes.has(key)) {
    const entry = { userId, getAccessToken, backend, snapshot: EMPTY_ACCOUNT, listeners: new Set(), generation: 0, pending: null, timer: null, updatedAt: 0 };
    entry.getSnapshot = () => entry.snapshot;
    entry.subscribe = (listener) => {
      const firstActive = activeAccounts.size === 0;
      entry.listeners.add(listener);
      activeAccounts.add(entry);
      if (firstActive) {
        window.addEventListener("focus", refreshVisibleAccounts);
        document.addEventListener("visibilitychange", refreshVisibleAccounts);
        window.addEventListener(INSFORGE_INSTANCE_CHANGED_EVENT, invalidateAccounts);
      }
      if (entry.snapshot === EMPTY_ACCOUNT || entry.snapshot.error || Date.now() - entry.updatedAt > ACCOUNT_FRESH_MS) void refreshAccount(entry);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size) return;
        clearAccount(entry);
        activeAccounts.delete(entry);
        if (!activeAccounts.size) {
          window.removeEventListener("focus", refreshVisibleAccounts);
          document.removeEventListener("visibilitychange", refreshVisibleAccounts);
          window.removeEventListener(INSFORGE_INSTANCE_CHANGED_EVENT, invalidateAccounts);
        }
      };
    };
    scopes.set(key, entry);
  }
  return scopes.get(key);
}

export function useCloudAccount({ enabled = true } = {}) {
  const auth = useInsforgeAuth();
  const userId = auth?.signedIn ? auth.user?.id : null;
  const getAccessToken = auth?.getAccessToken;
  const entry = enabled && userId && typeof getAccessToken === "function"
    ? accountScope(userId, getAccessToken, getInsforgeInstanceFingerprint()) : null;
  const snapshot = useSyncExternalStore(entry?.subscribe || idleSubscribe, entry?.getSnapshot || emptySnapshot, emptySnapshot);
  const refresh = useCallback(() => entry ? refreshAccount(entry, true) : Promise.resolve(null), [entry]);
  return { ...snapshot, refresh, auth };
}
