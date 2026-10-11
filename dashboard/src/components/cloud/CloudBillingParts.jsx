import React from "react";
import { AlertCircle, BarChart3, Cloud, History } from "lucide-react";
import { Link } from "react-router-dom";
import { copy, getCopyLocale } from "../../lib/copy";
import { Button } from "../../ui/components/Button.jsx";

export function cloudBillingErrorText(error, context) {
  const code = error?.code || error?.message;
  if (code === "instance_changed") return copy("instance.configuration.changed");
  if (code === "gift_code_unavailable") return copy("cloud.gift.error_unavailable");
  if (["gift_rate_limited", "gift_redemption_rate_limited"].includes(code)) return copy("cloud.gift.error_rate_limit");
  if (code === "gift_not_available") return copy("cloud.gift.error_not_available");
  if (code === "gift_requires_renewal_cancel") return copy("cloud.gift.error_renewal");
  if (code === "gift_checkout_pending") return copy("cloud.gift.error_checkout");
  if (code === "gift_membership_active") return copy("cloud.gift.error_active");
  if (code === "billing_catalog_unavailable")
    return copy("cloud.error.catalog");
  if (code === "billing_devices_unavailable")
    return copy("cloud.error.devices");
  if (
    [
      "authentication_required",
      "invalid_token",
      "invalid_authentication",
    ].includes(code)
  )
    return copy("cloud.error.auth");
  if (
    [
      "checkout_not_launched",
      "trial_not_launched",
      "billing_not_configured",
      "billing_configuration_invalid",
    ].includes(code)
  )
    return copy("cloud.error.unavailable");
  if (
    [
      "payment_provider_not_configured",
      "waffo_not_configured",
      "paddle_not_configured",
      "wechat_not_configured",
      "alipay_not_configured",
    ].includes(code)
  )
    return context === "account"
      ? copy("cloud.error.account_provider")
      : copy("cloud.error.provider");
  if (code === "subscription_already_exists")
    return copy("cloud.error.subscription_exists");
  if (code === "fixed_term_still_active") return copy("cloud.error.fixed_term");
  if (["checkout_confirmation_pending", "waffo_notification_pending"].includes(code))
    return copy("cloud.checkout.verification_pending");
  if (code === "checkout_already_paid") return copy("cloud.checkout.received");
  if (code === "trial_unavailable") return copy("cloud.error.trial");
  if (code === "order_not_found") return copy("cloud.error.order_not_found");
  if (["checkout_expired", "order_expired"].includes(code))
    return copy("cloud.error.expired");
  if (["checkout_request_conflict", "pending_checkout_exists"].includes(code))
    return copy("cloud.error.request_conflict");
  if (code === "billing_network_error")
    return context === "gift" ? copy("cloud.gift.error_network") : context === "account"
      ? copy("cloud.error.account_network")
      : copy("cloud.error.network");
  if (["invalid_provider_checkout_url", "browser_open_failed"].includes(code))
    return copy("cloud.error.browser");
  if (["machine_limit_exceeded", "cloud_machine_limit"].includes(code))
    return copy("cloud.error.machines");
  if (code === "cloud_machine_paused")
    return copy("cloud.error.machine_paused");
  if (["cloud_membership_required", "cloud_read_only_expired"].includes(code))
    return copy("cloud.error.membership");
  return copy("cloud.error.generic");
}

export function BillingNotice({ children, error, onRetry, context, role }) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-4 text-sm leading-6 text-oai-gray-600 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-300"
      role={error ? "alert" : role || "status"}
    >
      <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {error ? cloudBillingErrorText(error, context) : children}
      </div>
      {onRetry ? (
        <Button variant="ghost" onClick={onRetry} className="shrink-0">
          {copy("cloud.action.retry")}
        </Button>
      ) : null}
    </div>
  );
}

export function CloudPaymentConflictNotice({ showBillingLink = true }) {
  return (
    <BillingNotice role="alert">
      <p>{copy("cloud.checkout.duplicate_payment")}</p>
      {showBillingLink ? (
        <Button as={Link} to="/settings?section=cloud" variant="secondary" className="mt-3 no-underline">
          {copy("cloud.action.view_bills")}
        </Button>
      ) : null}
    </BillingNotice>
  );
}

export function formatCloudDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(getCopyLocale(), {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(date)
    : copy("cloud.date.unknown");
}

export function formatCloudDateTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(getCopyLocale(), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date)
    : copy("cloud.date.unknown");
}

export function cloudMembershipLabel(status) {
  const labels = {
    legacy_free: copy("cloud.status.legacy_free"),
    active: copy("cloud.status.active"),
    trial: copy("cloud.status.trial"),
    transition: copy("cloud.status.transition"),
    expired: copy("cloud.status.expired"),
    free: copy("cloud.status.free"),
    self_hosted: copy("cloud.status.self_hosted"),
  };
  return labels[status] || copy("cloud.status.unknown");
}

export function SelfHostedCloudState() {
  return (
    <div className="tt-cloud-theme flex flex-1 flex-col font-oai text-oai-black dark:text-oai-white">
      <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8 sm:px-6 sm:py-12">
        <h1 className="text-3xl font-semibold tracking-tight">{copy("cloud.self_host.instance_title")}</h1>
        <p className="text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">{copy("cloud.self_host.instance_body")}</p>
        <p className="text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">{copy("cloud.self_host.instance_retention")}</p>
        <div className="flex flex-wrap gap-3">
          <Button as={Link} to="/dashboard" className="no-underline">{copy("cloud.action.open_dashboard")}</Button>
          <Button as={Link} to="/settings?section=cloud" variant="secondary" className="no-underline">{copy("cloud.self_host.manage_devices")}</Button>
        </div>
      </main>
    </div>
  );
}

export function cloudProviderLabel(provider) {
  const labels = {
    waffo: copy("cloud.provider.waffo"),
    paddle: copy("cloud.provider.paddle"),
    wechat: copy("cloud.provider.wechat"),
    alipay: copy("cloud.provider.alipay"),
  };
  return labels[provider] || copy("cloud.provider.unknown");
}

export function CloudFeatures({ limits }) {
  const items = [
    {
      Icon: BarChart3,
      label: copy("cloud.feature.analysis"),
      detail: copy("cloud.feature.analysis_detail"),
    },
    {
      Icon: History,
      label: copy("cloud.feature.history_title"),
      detail: copy("cloud.feature.history", {
        days: limits?.hourly_history_days || 90,
        months: limits?.daily_history_months || 24,
      }),
    },
    {
      Icon: Cloud,
      label: copy("cloud.feature.sync_title"),
      detail: copy("cloud.feature.sync", {
        minutes: limits?.sync_minutes || 15,
      }),
    },
  ];
  return (
    <ul className="space-y-4">
      {items.map(({ Icon, label, detail }) => (
        <li key={label} className="flex items-start gap-3">
          <Icon
            size={17}
            className="mt-0.5 shrink-0 text-oai-gray-600 dark:text-oai-gray-300"
            aria-hidden
          />
          <div>
            <p className="text-sm font-medium">{label}</p>
            <p className="mt-1 text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
              {detail}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
