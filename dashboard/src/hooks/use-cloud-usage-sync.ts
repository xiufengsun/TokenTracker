import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext";
import { getCloudSyncEnabled, getLastCloudSyncTs, isLocalDashboardHost } from "../lib/cloud-sync-prefs";
import { runCloudUsageSyncIfDue } from "../lib/cloud-sync";

function isSharePath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === "/share" || p === "/share.html" || p.startsWith("/share/");
}

function isCloudSyncRoute(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/login" || p === "/landing") return false;
  if (isSharePath(p)) return false;
  return p === "/" || p === "/dashboard" || p.startsWith("/leaderboard");
}

/**
 * 在 localhost 且处于仪表盘/排行榜路由、已登录、用户未关闭「同步到云端」时，节流触发本地 sync → 云端 ingest。
 */
export function useCloudUsageSync(): void {
  const location = useLocation();
  const insforge = useInsforgeAuth();
  const runRef = useRef<symbol | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(getCloudSyncEnabled);
  useEffect(() => {
    const update = () => setSyncEnabled(getCloudSyncEnabled());
    window.addEventListener("tt.cloudSyncChanged", update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener("tt.cloudSyncChanged", update); window.removeEventListener("storage", update); };
  }, []);

  useEffect(() => {
    if (!isLocalDashboardHost()) return;
    if (!isCloudSyncRoute(location.pathname || "/")) return;
    if (!insforge.enabled || !insforge.signedIn || insforge.loading) return;
    if (!syncEnabled) return;

    let cancelled = false;
    let timer: number;
    const run = async () => {
      if (cancelled || runRef.current || document.visibilityState === "hidden" || !getCloudSyncEnabled()) return;
      window.clearTimeout(timer);
      const task = Symbol("cloud-sync");
      runRef.current = task;
      try {
        await runCloudUsageSyncIfDue(() => insforge.getAccessToken());
      } catch (e) {
        console.warn("[tokentracker] cloud usage sync:", e);
      } finally {
        if (runRef.current === task) runRef.current = null;
        if (!cancelled) {
          const remaining = getLastCloudSyncTs() + 15 * 60 * 1000 - Date.now();
          const delay = remaining > 0 ? remaining + 1000 : 15 * 60 * 1000;
          timer = window.setTimeout(() => void run(), delay);
        }
      }
    };
    timer = window.setTimeout(() => void run(), 2500);
    const onVisible = () => { if (document.visibilityState === "visible") void run(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      runRef.current = null;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [
    location.pathname,
    syncEnabled,
    insforge.enabled,
    insforge.signedIn,
    insforge.loading,
    insforge.getAccessToken,
  ]);
}
