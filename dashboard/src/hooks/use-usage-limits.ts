import { useCallback, useEffect, useRef, useState } from "react";
import { getUsageLimits } from "../lib/api";
import { publishUsageLimitsPreloadState } from "../lib/dashboard-preload.js";
import { LIMIT_ALERTS_PREF_KEY } from "./use-limit-alert-prefs";
import { sendPredictiveLimitAlerts } from "../lib/limit-alerts.js";
import { useLatestRequestGuard } from "./use-latest-request-guard";
import {
  isDevinProviderSelected,
  isLimitsPrefsStorageKey,
  LIMITS_PREFS_CHANGED_EVENT,
} from "./use-limits-display-prefs.js";

/**
 * Devin rows must never outlive the user's provider selection: when the
 * switch is off the server is not asked, and any retained/preloaded payload
 * that still carries Devin data is rewritten to the not-configured shape.
 */
function withoutUnselectedDevin(
  value: UsageLimitsData | null,
  devinSelected: boolean,
): UsageLimitsData | null {
  if (!value || devinSelected) return value;
  if (!value.devin) return value;
  // Preserve identity only for the exact empty sentinel, never a disabled
  // payload that still carries quota windows or provider metadata.
  if (value.devin.configured === false && Object.keys(value.devin).length === 1) return value;
  return { ...value, devin: { configured: false } };
}

type CodexLimitWindow = {
  readonly used_percent: number;
  readonly reset_at?: number;
  readonly limit_window_seconds?: number;
};

type CodexCreditWindow = {
  readonly source?: string | null;
  readonly used_percent: number;
  readonly remaining_percent?: number | null;
  readonly reset_at?: string | number | null;
  readonly limit_credits?: number | null;
  readonly used_credits?: number | null;
  readonly remaining_credits?: number | null;
};

type CodexResetCredit = {
  readonly status: string;
  readonly reset_type?: string;
  readonly granted_at?: string;
  readonly expires_at: string;
};

type CodexResetCredits = {
  readonly available_count: number | null;
  readonly total_earned_count: number | null;
  readonly credits: readonly CodexResetCredit[];
};

type CodexUsageLimits = {
  readonly configured: boolean;
  readonly error?: string | null;
  readonly plan_label?: string | null;
  readonly primary_window?: CodexLimitWindow | null;
  readonly secondary_window?: CodexLimitWindow | null;
  readonly credit_window?: CodexCreditWindow | null;
  readonly spark_primary_window?: CodexLimitWindow | null;
  readonly spark_secondary_window?: CodexLimitWindow | null;
  readonly reset_credits?: CodexResetCredits | null;
};

interface UsageLimitsData {
  fetched_at: string;
  claude: { configured: boolean; error?: string | null; plan_label?: string | null; auth_action_required?: string | null; five_hour?: { utilization: number; resets_at?: string }; seven_day?: { utilization: number; resets_at?: string }; seven_day_opus?: { utilization: number; resets_at?: string } | null; extra_usage?: { is_enabled: boolean; monthly_limit?: number | null; used_credits?: number | null; currency?: string | null } | null };
  codex: CodexUsageLimits;
  cursor: { configured: boolean; error?: string | null; plan_label?: string | null; membership_type?: string | null; primary_window?: { used_percent: number; reset_at?: string | null; limit_window_seconds?: number | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null; limit_window_seconds?: number | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null; limit_window_seconds?: number | null } | null; quaternary_window?: { used_percent: number; reset_at?: string | null; limit_window_seconds?: number | null } | null };
  gemini: { configured: boolean; error?: string | null; plan_label?: string | null; account_email?: string | null; account_plan?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
  kimi: { configured: boolean; error?: string | null; plan_label?: string | null; membership_level?: string | null; subscription_type?: string | null; parallel_limit?: number | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
  kiro: { configured: boolean; error?: string | null; plan_label?: string | null; plan_name?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null };
  grok: { configured: boolean; error?: string | null; plan_label?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null };
  antigravity: { configured: boolean; error?: string | null; plan_label?: string | null; auth_action_required?: string | null; account_email?: string | null; account_plan?: string | null; cached?: boolean; cached_at?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null; quaternary_window?: { used_percent: number; reset_at?: string | null } | null };
  zcode: { configured: boolean; error?: string | null; plan_label?: string | null; plan_id?: string | null; plan_kind?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null ; buckets?: Array<{ label?: string; entitlement_id?: string; plan_name?: string | null; period?: string | null; window?: { used_percent: number; reset_at?: string | null } | null }> };
  opencodeGo: { configured: boolean; error?: string | null; plan_label?: string | null; source?: string | null; subscription_status?: "active" | "inactive" | "unknown" | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null };
  qoder: {
    configured: boolean;
    error?: string | null;
    plan_label?: string | null;
    primary_window?: CodexCreditWindow | null;
    secondary_window?: CodexCreditWindow | null;
    cached?: boolean;
    stale?: boolean;
    cached_at?: string | null;
    source?: string | null;
  };
  codingPlan: {
    configured: boolean;
    error?: string | null;
    plan_label?: string | null;
    primary_window?: { used_percent: number; reset_at?: string | null } | null;
    secondary_window?: { used_percent: number; reset_at?: string | null } | null;
    tertiary_window?: { used_percent: number; reset_at?: string | null } | null;
    cached?: boolean;
    stale?: boolean;
    cached_at?: string | null;
    source?: string | null;
  };
  agentPlan: {
    configured: boolean;
    error?: string | null;
    plan_label?: string | null;
    primary_window?: { used_percent: number; reset_at?: string | null } | null;
    secondary_window?: { used_percent: number; reset_at?: string | null } | null;
    tertiary_window?: { used_percent: number; reset_at?: string | null } | null;
    cached?: boolean;
    stale?: boolean;
    cached_at?: string | null;
    source?: string | null;
  };
  devin: {
    configured: boolean;
    error?: string | null;
    plan_label?: string | null;
    auth_action_required?: string | null;
    primary_window?: { used_percent: number; reset_at?: string | null; limit_window_seconds?: number | null } | null;
    secondary_window?: { used_percent: number; reset_at?: string | null; limit_window_seconds?: number | null } | null;
    stale?: boolean;
    cached_at?: string | null;
  };
}

interface UsageLimitsInitialState {
  data?: UsageLimitsData | null;
  error?: string | null;
  status?: string;
}

interface UseUsageLimitsOptions {
  initialRefresh?: boolean;
  initialState?: UsageLimitsInitialState | null;
  publishToPreloadCache?: boolean;
}

export function useUsageLimits(options?: UseUsageLimitsOptions) {
  const hasInitialState = Boolean(options?.initialState);
  // The saved provider selection — the opt-in fact forwarded on every request.
  // Kept in state so a toggle invalidates in-flight work via the
  // latest-request guard below and re-renders with the new selection.
  const [devinSelected, setDevinSelected] = useState(isDevinProviderSelected);
  const [data, setData] = useState<UsageLimitsData | null>(() => (
    hasInitialState
      ? withoutUnselectedDevin(
          options?.initialState?.data ?? null,
          isDevinProviderSelected(),
        )
      : null
  ));
  const [error, setError] = useState<string | null>(() => (
    hasInitialState ? options?.initialState?.error ?? null : null
  ));
  const [isLoading, setIsLoading] = useState(!hasInitialState);
  const initialRefresh = Boolean(options?.initialRefresh);
  const publishToPreloadCache = Boolean(options?.publishToPreloadCache);
  // Mount/cache reads and an explicit refresh can overlap (for example when a
  // user clicks Refresh while the dashboard's preload request is still
  // resolving). Keep only the newest response. Without this guard a slower
  // cache response can overwrite fresh limits fetched by the manual request.
  // The selection is a guard dependency: flipping the Devin switch
  // invalidates every request issued under the previous selection, so a late
  // response fetched while it was enabled can never republish Devin rows.
  const beginRequest = useLatestRequestGuard([devinSelected]);

  // Re-read the saved selection when limits preferences change. Same-window
  // toggles and native-mirror writes arrive via LIMITS_PREFS_CHANGED_EVENT;
  // cross-tab changes arrive via the storage event.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncSelection = () => setDevinSelected(isDevinProviderSelected());
    const onStorage = (event: StorageEvent) => {
      if (isLimitsPrefsStorageKey(event.key)) syncSelection();
    };
    window.addEventListener(LIMITS_PREFS_CHANGED_EVENT, syncSelection);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(LIMITS_PREFS_CHANGED_EVENT, syncSelection);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!data || typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(LIMIT_ALERTS_PREF_KEY) === "1") {
        sendPredictiveLimitAlerts(data);
      }
    } catch { /* restricted webview */ }
  }, [data]);

  const publishSuccessfulState = useCallback(
    (value: UsageLimitsData | null, source: "page-load" | "manual-refresh") => {
      if (!publishToPreloadCache || !value || typeof value !== "object") return;
      publishUsageLimitsPreloadState(
        withoutUnselectedDevin(value, isDevinProviderSelected()),
        { source },
      );
    },
    [publishToPreloadCache],
  );

  const refresh = useCallback(async () => {
    const isCurrent = beginRequest();
    try {
      const res = await getUsageLimits({
        refresh: true,
        devinEnabled: isDevinProviderSelected(),
      });
      if (!isCurrent()) return;
      const nextData = res && typeof res === "object" ? res as UsageLimitsData : null;
      setData(withoutUnselectedDevin(nextData, isDevinProviderSelected()));
      setError(null);
      setIsLoading(false);
      publishSuccessfulState(nextData, "manual-refresh");
    } catch (err) {
      if (!isCurrent()) return;
      setError((err as Error)?.message || String(err));
      setIsLoading(false);
    }
  }, [beginRequest, publishSuccessfulState]);

  const refreshFromServerCache = useCallback(async () => {
    const isCurrent = beginRequest();
    try {
      // Non-forcing read: serve from the server's cache rather than hitting
      // upstream providers, mirroring the mount fetch (forcing on every focus
      // is what tripped Claude's OAuth usage endpoint rate limit).
      const res = await getUsageLimits({
        devinEnabled: isDevinProviderSelected(),
      });
      if (!isCurrent()) return;
      const nextData = res && typeof res === "object" ? res as UsageLimitsData : null;
      setData(withoutUnselectedDevin(nextData, isDevinProviderSelected()));
      setError(null);
      setIsLoading(false);
      publishSuccessfulState(nextData, "page-load");
    } catch (err) {
      if (!isCurrent()) return;
      setError((err as Error)?.message || String(err));
      setIsLoading(false);
    }
  }, [beginRequest, publishSuccessfulState]);

  // Auto-refresh when the dashboard regains focus / becomes visible again —
  // same throttled pattern as use-usage-data.ts, so a left-open Limits page
  // picks up new window utilization without a manual reload.
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const MIN_GAP_MS = 15_000;
    let lastAt = Date.now(); // mount already fired the initial fetch below
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return;
      const nowMs = Date.now();
      if (nowMs - lastAt < MIN_GAP_MS) return;
      lastAt = nowMs;
      void refreshFromServerCache();
    };
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", maybeRefresh);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", maybeRefresh);
    };
  }, [refreshFromServerCache]);

  // A selection change invalidates in-flight work via the guard dependency,
  // drops retained Devin rows immediately when the provider was turned off,
  // and re-reads the server cache under the new selection.
  const previousDevinSelected = useRef(devinSelected);
  useEffect(() => {
    if (previousDevinSelected.current === devinSelected) return;
    previousDevinSelected.current = devinSelected;
    if (!devinSelected) {
      setData((current) => withoutUnselectedDevin(current, false));
    }
    void refreshFromServerCache();
  }, [devinSelected, refreshFromServerCache]);

  useEffect(() => {
    if (hasInitialState && !initialRefresh) return;
    const isCurrent = beginRequest();
    (async () => {
      try {
        // Mount fetch reads the server's cache (in-memory + disk-backed) rather than forcing
        // a live upstream call on every navigation — that repeated forcing is what tripped
        // Claude's OAuth usage endpoint rate limit. Only the manual refresh() forces upstream.
        const res = await getUsageLimits({
          devinEnabled: isDevinProviderSelected(),
        });
        if (!isCurrent()) return;
        const nextData = res && typeof res === "object" ? res as UsageLimitsData : null;
        setData(withoutUnselectedDevin(nextData, isDevinProviderSelected()));
        setError(null);
        publishSuccessfulState(nextData, "page-load");
      } catch (err) {
        if (!isCurrent()) return;
        setError((err as Error)?.message || String(err));
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    })();
  }, [beginRequest, hasInitialState, initialRefresh, publishSuccessfulState]);

  return { data, error, isLoading, refresh };
}
