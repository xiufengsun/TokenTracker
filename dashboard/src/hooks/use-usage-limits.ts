import { useCallback, useEffect, useRef, useState } from "react";
import { getUsageLimits, isLocalhostHost } from "../lib/api";
import { publishUsageLimitsPreloadState } from "../lib/dashboard-preload.js";
import { LIMIT_ALERTS_PREF_KEY } from "./use-limit-alert-prefs";
import { sendPredictiveLimitAlerts } from "../lib/limit-alerts.js";
import { useLatestRequestGuard } from "./use-latest-request-guard";
import {
  hiddenProviderIds,
  isDevinProviderSelected,
  isLimitsPrefsStorageKey,
  LIMITS_PREFS_CHANGED_EVENT,
} from "./use-limits-display-prefs.js";

/**
 * Hidden provider rows must never outlive the user's provider selection
 * (issue 956): when a switch is off the server is not asked for that provider, and
 * any retained/preloaded payload that still carries its data is rewritten to
 * the not-configured shape — the same sentinel an opted-out Devin row uses.
 */
function withoutHiddenProviders(
  value: UsageLimitsData | null,
  hiddenProviders: readonly string[],
): UsageLimitsData | null {
  if (!value || hiddenProviders.length === 0) return value;
  const hidden = new Set(hiddenProviders);
  let changed = false;
  const next = { ...(value as unknown as Record<string, unknown>) };
  for (const key of Object.keys(next)) {
    if (key === "fetched_at" || !hidden.has(key)) continue;
    const row = next[key];
    // Preserve identity only for the exact empty sentinel, never a disabled
    // payload that still carries quota windows or provider metadata.
    if (
      row
      && typeof row === "object"
      && (row as { configured?: unknown }).configured === false
      && Object.keys(row).length === 1
    ) {
      continue;
    }
    next[key] = { configured: false };
    changed = true;
  }
  return changed ? (next as unknown as UsageLimitsData) : value;
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
  grok: { configured: boolean; error?: string | null; plan_label?: string | null; period_type?: "weekly" | "daily" | "monthly" | string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; products?: Array<{ product: string; label: string; window?: { used_percent: number; reset_at?: string | null } | null }> | null };
  antigravity: { configured: boolean; error?: string | null; plan_label?: string | null; auth_action_required?: string | null; account_email?: string | null; account_plan?: string | null; cached?: boolean; cached_at?: string | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null; quaternary_window?: { used_percent: number; reset_at?: string | null } | null };
  zcode: { configured: boolean; error?: string | null; plan_label?: string | null; plan_id?: string | null; plan_kind?: string | null; reset_credits?: { error?: string; five_hour?: Array<{ expires_at: string }>; weekly?: Array<{ expires_at: string }> }; start_plan?: { configured: boolean; error?: string | null; plan_label?: string | null; plan_kind?: string | null; buckets?: Array<{ label?: string; entitlement_id?: string; plan_name?: string | null; period?: string | null; remaining_units?: number | null; total_units?: number | null; window?: { used_percent: number; reset_at?: string | null } | null }> } | null; primary_window?: { used_percent: number; reset_at?: string | null } | null; secondary_window?: { used_percent: number; reset_at?: string | null } | null; tertiary_window?: { used_percent: number; reset_at?: string | null } | null ; buckets?: Array<{ label?: string; entitlement_id?: string; plan_name?: string | null; period?: string | null; window?: { used_percent: number; reset_at?: string | null } | null }> };
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
  // Pay-as-you-go balance card (issue 960): no quota windows, one row per currency.
  deepseek?: {
    configured: boolean;
    error?: string | null;
    is_available?: boolean;
    balances?: ReadonlyArray<{ currency: string; total: number; granted: number; topped_up: number }>;
    credential_source?: string | null;
    stale?: boolean;
    cached_at?: string | null;
  };
  doubao: {
    configured: boolean;
    error?: string | null;
    plan_label?: string | null;
    auth_action_required?: string | null;
    primary_window?: CodexCreditWindow | null;
    secondary_window?: CodexCreditWindow | null;
    tertiary_window?: CodexCreditWindow | null;
    cached?: boolean;
    stale?: boolean;
    cached_at?: string | null;
    source?: string | null;
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
  /**
   * Overrides the prefs-derived hidden set with the effective one (issue 956).
   * LimitsPage subtracts subscription-backed providers — a hidden row a
   * hand-entered subscription keeps on screen must stay in the fetch so the
   * row never degrades to "not connected". Consulted at request time; the
   * hook still tracks the prefs-derived set itself so a toggle refetches.
   */
  getHiddenProviders?: () => readonly string[];
}

export function useUsageLimits(options?: UseUsageLimitsOptions) {
  const localEnabled = isLocalhostHost();
  const hasInitialState = localEnabled && Boolean(options?.initialState);
  // The saved provider selection — the opt-in fact forwarded on every request.
  // Kept in state so a toggle invalidates in-flight work via the
  // latest-request guard below and re-renders with the new selection.
  const [devinSelected, setDevinSelected] = useState(isDevinProviderSelected);
  const [hiddenProviders, setHiddenProviders] = useState<readonly string[]>(hiddenProviderIds);
  // Latest getter by ref: the request path always consults the caller's
  // current view of the effective hidden set without re-subscribing effects.
  const getHiddenRef = useRef(options?.getHiddenProviders);
  getHiddenRef.current = options?.getHiddenProviders;
  const currentHidden = useCallback(
    (): readonly string[] => getHiddenRef.current?.() ?? hiddenProviders,
    [hiddenProviders],
  );
  // The set used to strip retained/preloaded payloads: the effective hidden
  // set PLUS Devin whenever its opt-in is off — the flag gates the request,
  // but a payload fetched before the toggle must still lose its Devin rows
  // immediately (same contract as the pre-gating withoutUnselectedDevin).
  const applyHidden = useCallback(
    (): readonly string[] => {
      const effective = currentHidden();
      return devinSelected ? effective : ["devin", ...effective];
    },
    [currentHidden, devinSelected],
  );
  const [data, setData] = useState<UsageLimitsData | null>(() => (
    hasInitialState
      ? withoutHiddenProviders(
          options?.initialState?.data ?? null,
          applyHidden(),
        )
      : null
  ));
  const [error, setError] = useState<string | null>(() => (
    hasInitialState ? options?.initialState?.error ?? null : null
  ));
  const [isLoading, setIsLoading] = useState(localEnabled && !hasInitialState);
  const initialRefresh = Boolean(options?.initialRefresh);
  const publishToPreloadCache = Boolean(options?.publishToPreloadCache);
  // Mount/cache reads and an explicit refresh can overlap (for example when a
  // user clicks Refresh while the dashboard's preload request is still
  // resolving). Keep only the newest response. Without this guard a slower
  // cache response can overwrite fresh limits fetched by the manual request.
  // The selection is a guard dependency: flipping the Devin switch or any
  // visibility toggle invalidates every request issued under the previous
  // selection, so a late response fetched while it was enabled can never
  // republish rows the user has since hidden.
  const hiddenKey = hiddenProviders.join(",");
  const beginRequest = useLatestRequestGuard([devinSelected, hiddenKey, localEnabled]);

  // Re-read the saved selection when limits preferences change. Same-window
  // toggles and native-mirror writes arrive via LIMITS_PREFS_CHANGED_EVENT;
  // cross-tab changes arrive via the storage event.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncSelection = () => {
      setDevinSelected(isDevinProviderSelected());
      setHiddenProviders(hiddenProviderIds());
    };
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
    if (!localEnabled || !data || typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(LIMIT_ALERTS_PREF_KEY) === "1") {
        sendPredictiveLimitAlerts(data);
      }
    } catch { /* restricted webview */ }
  }, [data, localEnabled]);

  const publishSuccessfulState = useCallback(
    (value: UsageLimitsData | null, source: "page-load" | "manual-refresh") => {
      if (!localEnabled || !publishToPreloadCache || !value || typeof value !== "object") return;
      publishUsageLimitsPreloadState(
        withoutHiddenProviders(value, applyHidden()),
        { source },
      );
    },
    [currentHidden, localEnabled, publishToPreloadCache],
  );

  // Forced manual refresh. Resolves with the payload that was applied (the
  // same object handed to setData, so a caller can read `fetched_at` off it),
  // or null when nothing new was applied — fetch failure, a superseded
  // request, or a non-local host. Callers that just want the refresh keep
  // working: the previous contract was Promise<void>.
  const refresh = useCallback(async (): Promise<UsageLimitsData | null> => {
    if (!localEnabled) return null;
    const isCurrent = beginRequest();
    try {
      const res = await getUsageLimits({
        refresh: true,
        devinEnabled: isDevinProviderSelected(),
        hiddenProviders: currentHidden(),
      });
      if (!isCurrent()) return null;
      const nextData = res && typeof res === "object" ? res as UsageLimitsData : null;
      const next = withoutHiddenProviders(nextData, applyHidden());
      setData(next);
      setError(null);
      setIsLoading(false);
      publishSuccessfulState(next, "manual-refresh");
      return next;
    } catch (err) {
      if (!isCurrent()) return null;
      setError((err as Error)?.message || String(err));
      setIsLoading(false);
      return null;
    }
  }, [applyHidden, beginRequest, currentHidden, localEnabled, publishSuccessfulState]);

  const refreshFromServerCache = useCallback(async () => {
    if (!localEnabled) return;
    const isCurrent = beginRequest();
    try {
      // Non-forcing read: serve from the server's cache rather than hitting
      // upstream providers, mirroring the mount fetch (forcing on every focus
      // is what tripped Claude's OAuth usage endpoint rate limit).
      const res = await getUsageLimits({
        devinEnabled: isDevinProviderSelected(),
        hiddenProviders: currentHidden(),
      });
      if (!isCurrent()) return;
      const nextData = res && typeof res === "object" ? res as UsageLimitsData : null;
      setData(withoutHiddenProviders(nextData, applyHidden()));
      setError(null);
      setIsLoading(false);
      publishSuccessfulState(nextData, "page-load");
    } catch (err) {
      if (!isCurrent()) return;
      setError((err as Error)?.message || String(err));
      setIsLoading(false);
    }
  }, [applyHidden, beginRequest, currentHidden, localEnabled, publishSuccessfulState]);

  // Auto-refresh when the dashboard regains focus / becomes visible again —
  // same throttled pattern as use-usage-data.ts, so a left-open Limits page
  // picks up new window utilization without a manual reload.
  useEffect(() => {
    if (!localEnabled || typeof window === "undefined" || typeof document === "undefined") return;
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
  }, [localEnabled, refreshFromServerCache]);

  // A selection change (Devin opt-in or any visibility toggle) invalidates
  // in-flight work via the guard dependency, drops retained rows for newly
  // hidden providers immediately, and re-reads the server cache under the new
  // selection.
  const previousSelectionKey = useRef(`${isDevinProviderSelected()}|${hiddenProviderIds().join(",")}`);
  useEffect(() => {
    const selectionKey = `${devinSelected}|${hiddenProviders.join(",")}`;
    if (previousSelectionKey.current === selectionKey) return;
    previousSelectionKey.current = selectionKey;
    if (!localEnabled) return;
    setData((current) => withoutHiddenProviders(current, applyHidden()));
    void refreshFromServerCache();
  }, [applyHidden, devinSelected, hiddenProviders, localEnabled, refreshFromServerCache]);

  useEffect(() => {
    if (!localEnabled) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    if (hasInitialState && !initialRefresh) return;
    const isCurrent = beginRequest();
    (async () => {
      try {
        // Mount fetch reads the server's cache (in-memory + disk-backed) rather than forcing
        // a live upstream call on every navigation — that repeated forcing is what tripped
        // Claude's OAuth usage endpoint rate limit. Only the manual refresh() forces upstream.
        const res = await getUsageLimits({
          devinEnabled: isDevinProviderSelected(),
          hiddenProviders: currentHidden(),
        });
        if (!isCurrent()) return;
        const nextData = res && typeof res === "object" ? res as UsageLimitsData : null;
        setData(withoutHiddenProviders(nextData, applyHidden()));
        setError(null);
        publishSuccessfulState(nextData, "page-load");
      } catch (err) {
        if (!isCurrent()) return;
        setError((err as Error)?.message || String(err));
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    })();
  }, [beginRequest, hasInitialState, initialRefresh, localEnabled, publishSuccessfulState]);

  return { data, error, isLoading, refresh };
}
