import React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { Bell, BellOff, CalendarClock, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { useUsageLimits } from "../hooks/use-usage-limits";
import { useLimitsDisplayPrefs } from "../hooks/use-limits-display-prefs.js";
import { copy, getCopyLocale } from "../lib/copy";
import { LimitsPageSkeleton } from "../components/LimitsPageSkeleton.jsx";
import { UsageLimitsPanel } from "../ui/dashboard/components/UsageLimitsPanel.jsx";
import { SubscriptionSettingsCard } from "../ui/dashboard/components/SubscriptionSettingsCard.jsx";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { isMockEnabled } from "../lib/mock-data";
import { readUsageLimitsPreloadState } from "../lib/dashboard-preload.js";
import { useLimitAlertPrefs } from "../hooks/use-limit-alert-prefs";
import { sendPredictiveLimitAlerts } from "../lib/limit-alerts.js";
import { isNativeEmbed, postNativeMessage } from "../lib/native-bridge.js";
import { listSubscriptions } from "../lib/subscription-manager-api";

const IS_LOCAL_HOST =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

const MACOS_NOTIFICATION_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.notifications";

// Compact absolute stamp for the manual-refresh feedback line, in the copy
// locale — same shape as the panel's exact reset-time formatting.
function formatRefreshedAt(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  return new Intl.DateTimeFormat(getCopyLocale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

/**
 * A forced refresh always comes back stamped with a fresh fetched_at, even
 * when the backend served cached rows or a provider errored, so the notice
 * grades the payload instead of trusting the timestamp: "updated" only when
 * every provider row is fresh and error-free, "partial" when any row still
 * reports an error, a stale cache, a disk-cache source, or a failed ZCode
 * extras endpoint (reset cards / Start Plan).
 */
function describeRefreshOutcome(data) {
  const providers = Object.entries(data || {}).filter(
    ([key, value]) => key !== "fetched_at" && value && typeof value === "object"
      && value.configured !== false,
  );
  const errored = providers.filter(([, provider]) => Boolean(provider.error));
  // ZCode folds reset cards and Start Plan grants into its row from separate
  // endpoints; their failures don't set the row-level error but the refresh
  // still didn't bring every quota up to date.
  const extrasErrored = providers.some(([, provider]) =>
    Boolean(provider.start_plan?.error) || Boolean(provider.reset_credits?.error));
  const cached = providers.filter(([, provider]) =>
    provider.provenance?.stale === true
    || provider.provenance?.source === "disk-cache",
  );
  // Every row served from cache with no provider errors means the refresh
  // never reached live data at all; any error row is a partial outcome.
  if (providers.length && errored.length === 0 && !extrasErrored && cached.length === providers.length) {
    return { kind: "stale" };
  }
  if (errored.length || cached.length || extrasErrored) {
    return { kind: "partial", at: data.fetched_at };
  }
  return { kind: "updated", at: data.fetched_at };
}

/**
 * Speech-bubble nudge anchored to the bell: alerts are on, but the system
 * blocks notifications. In the macOS app it deep-links to System Settings →
 * Notifications; in a browser the user has to flip the site permission, so it
 * stays a plain (non-clickable) callout.
 */
function NotificationBlockedBubble() {
  const reduceMotion = useReducedMotion();
  const native = isNativeEmbed();
  const label = copy("limits.alert.blocked");
  const Tag = native ? motion.button : motion.div;
  return (
    <Tag
      type={native ? "button" : undefined}
      onClick={native
        ? () => postNativeMessage({ type: "action", name: "openURL", value: MACOS_NOTIFICATION_SETTINGS_URL })
        : undefined}
      initial={reduceMotion ? false : { opacity: 0, x: 14, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 320, damping: 18 }}
      title={label}
      className={`relative hidden sm:inline-flex min-w-0 max-w-[360px] items-center gap-1.5 rounded-full border border-amber-300/70 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 ${
        native
          ? "cursor-pointer transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
          : ""
      }`}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
      </span>
      <span className="truncate">{label}</span>
      <span
        aria-hidden
        className="absolute left-full top-1/2 -translate-y-1/2 border-[5px] border-transparent border-l-amber-300/80 dark:border-l-amber-500/40"
      />
    </Tag>
  );
}

export function LimitsPage() {
  const preloadedUsageLimits = readUsageLimitsPreloadState();
  const { data: usageLimits, error, isLoading, refresh } = useUsageLimits(
    preloadedUsageLimits
      ? { initialRefresh: true, initialState: preloadedUsageLimits, publishToPreloadCache: true }
      : { initialRefresh: true, publishToPreloadCache: true },
  );
  const prefs = useLimitsDisplayPrefs();
  const alerts = useLimitAlertPrefs();
  const [subscriptions, setSubscriptions] = React.useState([]);
  const [subscriptionsError, setSubscriptionsError] = React.useState(false);
  const [subscriptionsOpen, setSubscriptionsOpen] = React.useState(false);
  const [searchParams] = useSearchParams();
  const subscriptionRefreshRef = React.useRef(0);
  // Manual refresh bookkeeping: a ref guard (not state) blocks a fast second
  // click before the re-render commits, mirroring SkillsPage's
  // operationInFlight pattern; `isRefreshing` only drives the disabled/spin UI.
  const refreshInFlightRef = React.useRef(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [refreshNotice, setRefreshNotice] = React.useState(null);

  const handleManualRefresh = React.useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    setRefreshNotice(null);
    try {
      // The hook's forced refresh keeps stale rows on screen while it runs and
      // resolves with the payload it applied (null when it could not refresh),
      // so the notice never fakes "up to date".
      const next = await refresh();
      setRefreshNotice(next ? describeRefreshOutcome(next) : { kind: "failed" });
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
    }
  }, [refresh]);

  const refreshSubscriptions = React.useCallback(async () => {
    // The subscription store only exists on the local CLI; skip the fetch on
    // the public host where the endpoint would 404.
    if (!IS_LOCAL_HOST && !isMockEnabled()) return;
    const requestId = ++subscriptionRefreshRef.current;
    try {
      const rows = await listSubscriptions();
      // A stale response (e.g. the refresh after a save raced an older GET)
      // must not overwrite the newer state.
      if (requestId !== subscriptionRefreshRef.current) return;
      setSubscriptions(rows);
      setSubscriptionsError(false);
    } catch (_e) {
      if (requestId !== subscriptionRefreshRef.current) return;
      // Keep the rows already on screen: wiping them would make a transient
      // fetch failure look like the subscriptions were deleted.
      setSubscriptionsError(true);
    }
  }, []);

  React.useEffect(() => {
    void refreshSubscriptions();
  }, [refreshSubscriptions]);

  React.useEffect(() => {
    if (searchParams.get("openSubscriptions") === "1") {
      setSubscriptionsOpen(true);
    }
  }, [searchParams]);

  React.useEffect(() => {
    if (alerts.enabled && usageLimits) sendPredictiveLimitAlerts(usageLimits);
  }, [alerts.enabled, usageLimits]);

  // Limits read the local plan/rate-limit tier from the machine running the
  // CLI; there's no cloud source. On the deployed web app, surface the
  // local-only notice instead of an empty panel.
  if (!IS_LOCAL_HOST && !isMockEnabled()) {
    return (
      <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
        <LocalOnlyNotice />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-row items-start justify-between gap-4 mb-8">
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-oai-black dark:text-white mb-3">
                {copy("nav.limits")}
              </h1>
              <p className="text-oai-gray-500 dark:text-oai-gray-400 text-sm sm:text-base">
                {copy("limits.page.subtitle")}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {alerts.enabled && alerts.permissionBlocked ? <NotificationBlockedBubble /> : null}
              <button
                type="button"
                onClick={() => void handleManualRefresh()}
                disabled={isRefreshing}
                aria-label={copy("limits.page.refresh")}
                title={copy("limits.page.refresh")}
                className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden />
              </button>
              <Popover.Root open={subscriptionsOpen} onOpenChange={setSubscriptionsOpen}>
                <Popover.Trigger
                  aria-label={copy("limits.page.openSubscriptions")}
                  title={copy("limits.page.openSubscriptions")}
                  className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
                >
                  <CalendarClock className="h-4 w-4" aria-hidden />
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
                    <Popover.Popup>
                      <SubscriptionSettingsCard
                        subscriptions={subscriptions}
                        onChanged={refreshSubscriptions}
                      />
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
              <button
                type="button"
                onClick={() => void alerts.setEnabled(!alerts.enabled)}
                aria-label={alerts.enabled ? copy("limits.alert.disable") : copy("limits.alert.enable")}
                title={alerts.enabled ? copy("limits.alert.disable") : copy("limits.alert.enable")}
                className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 ${
                  alerts.enabled && alerts.permissionBlocked
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-oai-gray-600 dark:text-oai-gray-400 hover:text-oai-black dark:hover:text-white"
                }`}
              >
                {alerts.enabled ? <Bell className="h-4 w-4" aria-hidden /> : <BellOff className="h-4 w-4" aria-hidden />}
              </button>
              <Link
                to="/settings?section=limits"
                aria-label={copy("limits.page.openSettings")}
                title={copy("limits.page.openSettings")}
                className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
              >
                <SettingsIcon className="h-4 w-4" aria-hidden />
              </Link>
            </div>
          </div>

          <span role="status" className="sr-only">
            {isRefreshing ? copy("limits.page.refresh_loading") : ""}
          </span>
          {refreshNotice?.kind === "updated" ? (
            <p role="status" className="mb-4 text-sm text-emerald-700 dark:text-emerald-300">
              {copy("limits.page.refreshed_at", { time: formatRefreshedAt(refreshNotice.at) })}
            </p>
          ) : null}
          {refreshNotice?.kind === "partial" ? (
            <p role="status" className="mb-4 text-sm text-amber-600 dark:text-amber-400">
              {copy("limits.page.refresh_partial", { time: formatRefreshedAt(refreshNotice.at) })}
            </p>
          ) : null}
          {refreshNotice?.kind === "stale" ? (
            <p role="status" className="mb-4 text-sm text-amber-600 dark:text-amber-400">
              {copy("limits.page.refresh_stale")}
            </p>
          ) : null}
          {refreshNotice?.kind === "failed" ? (
            <p role="status" className="mb-4 text-sm text-amber-600 dark:text-amber-400">
              {copy("limits.page.refresh_failed")}
            </p>
          ) : null}

          {isLoading ? (
            <LimitsPageSkeleton />
          ) : (
            <>
              {error ? (
                <p className="mb-4 text-sm text-red-500 dark:text-red-400">
                  {copy("shared.error.prefix", { error })}
                </p>
              ) : null}
              {subscriptionsError ? (
                <p className="mb-4 text-sm text-amber-600 dark:text-amber-400">
                  {copy("subscriptions.load_error")}
                </p>
              ) : null}
              <UsageLimitsPanel
                claude={usageLimits?.claude}
                codex={usageLimits?.codex}
                cursor={usageLimits?.cursor}
                gemini={usageLimits?.gemini}
                kimi={usageLimits?.kimi}
                kiro={usageLimits?.kiro}
                grok={usageLimits?.grok}
                antigravity={usageLimits?.antigravity}
                copilot={usageLimits?.copilot}
                zcode={usageLimits?.zcode}
                opencodeGo={usageLimits?.opencodeGo}
                commandCode={usageLimits?.commandCode}
                qoder={usageLimits?.qoder}
                qoderCn={usageLimits?.qoderCn}
                codingPlan={usageLimits?.codingPlan}
                agentPlan={usageLimits?.agentPlan}
                devin={usageLimits?.devin}
                order={prefs.order}
                visibility={prefs.visibility}
                displayMode={prefs.displayMode}
                subscriptions={subscriptions}
                showSubscriptions={prefs.showSubscriptions !== false}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
