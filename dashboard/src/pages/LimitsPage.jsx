import React from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { Bell, BellOff, CalendarClock, Settings as SettingsIcon } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { useUsageLimits } from "../hooks/use-usage-limits";
import { useLimitsDisplayPrefs } from "../hooks/use-limits-display-prefs.js";
import { copy } from "../lib/copy";
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
  const { data: usageLimits, error, isLoading } = useUsageLimits(
    preloadedUsageLimits
      ? { initialRefresh: true, initialState: preloadedUsageLimits, publishToPreloadCache: true }
      : { initialRefresh: true, publishToPreloadCache: true },
  );
  const prefs = useLimitsDisplayPrefs();
  const alerts = useLimitAlertPrefs();
  const [subscriptions, setSubscriptions] = React.useState([]);
  const [subscriptionsError, setSubscriptionsError] = React.useState(false);
  const [subscriptionsOpen, setSubscriptionsOpen] = React.useState(false);
  const subscriptionRefreshRef = React.useRef(0);

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
                qoder={usageLimits?.qoder}
                qoderCn={usageLimits?.qoderCn}
                order={prefs.order}
                visibility={prefs.visibility}
                displayMode={prefs.displayMode}
                subscriptions={subscriptions}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
