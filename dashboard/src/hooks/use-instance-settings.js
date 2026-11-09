import { useCallback, useEffect, useState } from "react";
import { isLocalDashboardHost } from "../lib/host-mode";

const INSTANCE_CONFIG_PATH = "/functions/tokentracker-instance-config";

const DEFAULT_CONFIG = {
  baseUrl: "",
  officialUrl: "",
  custom: false,
  dashboardUrl: "",
  anonKeySet: false,
  configurationError: null,
};

function normalizeLoaded(data) {
  if (!data || typeof data.baseUrl !== "string" || !data.baseUrl) return null;
  return {
    baseUrl: data.baseUrl,
    officialUrl: typeof data.officialUrl === "string" ? data.officialUrl : "",
    custom: data.custom === true,
    dashboardUrl: typeof data.dashboardUrl === "string" ? data.dashboardUrl : "",
    anonKeySet: data.anonKeySet === true,
    configurationError:
      typeof data.configurationError === "string" && data.configurationError
        ? data.configurationError
        : null,
  };
}

async function authHeaders() {
  const { getLocalApiAuthHeaders } = await import("../lib/local-api-auth");
  return getLocalApiAuthHeaders();
}

async function postInstanceConfig(payload) {
  const { getLocalApiAuthHeaders, clearLocalApiAuthToken } = await import("../lib/local-api-auth");
  let headers = await getLocalApiAuthHeaders();
  let res = await fetch(INSTANCE_CONFIG_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    cache: "no-store",
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    // An instance switch invalidates previously issued local-auth tokens, so a
    // 401 may just mean the cached token predates the switch (e.g. restoring
    // the official cloud right after switching to self-hosted). Re-fetch the
    // token once instead of failing the save.
    clearLocalApiAuthToken();
    headers = await getLocalApiAuthHeaders();
    res = await fetch(INSTANCE_CONFIG_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      cache: "no-store",
      body: JSON.stringify(payload),
    });
  }
  return res;
}

/**
 * Read and save the cloud instance target (official cloud vs self-hosted
 * InsForge deployment) on the local dashboard server.
 *
 * Only runs on a local dashboard host — a public deploy has no local server to
 * talk to, so `available` stays false and no request is made. Saving rewrites
 * config.json server-side; the caller is responsible for reloading the page so
 * the freshly injected runtime config takes over the SDK client.
 */
export function useInstanceSettings() {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(DEFAULT_CONFIG);

  useEffect(() => {
    if (!isLocalDashboardHost()) {
      setAvailable(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(INSTANCE_CONFIG_PATH, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) {
            setAvailable(false);
            setLoading(false);
          }
          return;
        }
        const loaded = normalizeLoaded(await res.json().catch(() => null));
        if (cancelled) return;
        if (!loaded) {
          setAvailable(false);
          setLoading(false);
          return;
        }
        setConfig(loaded);
        setAvailable(true);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setAvailable(false);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next) => {
    const res = await postInstanceConfig({ baseUrl: next.baseUrl, anonKey: next.anonKey || "" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      throw new Error(
        (data && typeof data.error === "string" && data.error) || `HTTP ${res.status}`,
      );
    }
    const loaded = normalizeLoaded(data);
    if (loaded) setConfig(loaded);
    return loaded || data;
  }, []);

  return { available, loading, config, save };
}
