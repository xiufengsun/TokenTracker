import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { ChevronRight, Cloud, CreditCard, ExternalLink, Info, Monitor, Pause, Play, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useLoginModal } from "../../contexts/LoginModalContext.jsx";
import { useCloudAccount } from "../../hooks/use-cloud-billing.js";
import { cloudBillingRequest, formatCloudMoney } from "../../lib/cloud-billing";
import {
  CLOUD_ORDER_ID_PATTERN,
  openCloudExternal,
  readCloudPurchase,
} from "../../lib/cloud-checkout.js";
import {
  clearCloudDeviceSession,
  isLocalDashboardHost,
} from "../../lib/cloud-sync-prefs";
import { getLocalApiAuthHeaders } from "../../lib/local-api-auth";
import { copy } from "../../lib/copy";
import { beginCloudOrderAction } from "../../lib/cloud-action-intent.js";
import { CloudDeadlinePrompt } from "./CloudContextualPrompt.jsx";
import { RedeemProCode } from "./RedeemProCode.jsx";
import { CloudUsageExport } from "./CloudUsageExport.jsx";
import { CloudActionDialog } from "./CloudActionDialog.jsx";
import { Button } from "../../ui/components/Button.jsx";
import { Card } from "../../ui/components/Card.jsx";
import {
  BillingNotice,
  CloudPaymentConflictNotice,
  cloudMembershipLabel,
  cloudProviderLabel,
  formatCloudDate,
  formatCloudDateTime,
} from "./CloudBillingParts.jsx";

function CloudHelp({ text, label }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger delay={0} closeOnClick={false} aria-label={label}
        onClick={() => setOpen(true)}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-500/40 dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-200">
        <Info size={14} aria-hidden />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" sideOffset={6} className="z-[110]">
          <Tooltip.Popup role="tooltip" className="max-w-[min(320px,calc(100vw-2rem))] rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-xs leading-5 text-oai-gray-600 shadow-lg dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-300">
            {text}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function cloudPlatformLabel(value) {
  if (typeof value !== "string" || !value.trim()) return copy("cloud.devices.platform_unknown");
  if (/^(mac|darwin)/i.test(value)) return copy("leaderboard.community.modal.platform.darwin");
  if (/^win/i.test(value)) return copy("leaderboard.community.modal.platform.win32");
  if (/^linux/i.test(value)) return copy("leaderboard.community.modal.platform.linux");
  return value;
}

function cloudMembershipSummary(membership, endDate) {
  if (!membership) return null;
  const gifted = membership.status === "active" && membership.access_source === "gift";
  if (endDate && Number.isFinite(Date.parse(endDate))) {
    const key = membership.status === "transition" ? "cloud.membership.transition_until"
      : membership.status === "trial" ? "cloud.membership.trial_until"
        : membership.status === "active" ? gifted ? "cloud.membership.gift_until" : "cloud.membership.active_until"
          : membership.status === "expired" && Date.parse(endDate) <= Date.now() ? "cloud.membership.expired_on" : null;
    if (key) return copy(key, { date: formatCloudDate(endDate) });
  }
  return gifted ? copy("cloud.gift.membership_label") : cloudMembershipLabel(membership.status);
}

function CloudMachineList({ auth, machineLimit, accountRevision, selfHosted = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const actionLock = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const userId = auth?.user?.id;
  const getAccessToken = auth?.getAccessToken;
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    try {
      let currentMachineId;
      if (isLocalDashboardHost()) {
        try {
          const headers = await getLocalApiAuthHeaders();
          const response = await fetch("/functions/tokentracker-machine-id", {
            headers,
          });
          if (response.ok)
            currentMachineId = (await response.json())?.machineId;
        } catch {
          /* Cloud list remains available without local identity. */
        }
      }
      const value = await cloudBillingRequest("devices", {
        auth: getAccessToken,
        params: currentMachineId
          ? { current_machine_id: currentMachineId }
          : {},
      });
      if (id === generation.current) {
        setData(value);
        setError(null);
      }
    } catch (reason) {
      if (id === generation.current)
        setError({ ...reason, code: "billing_devices_unavailable" });
    }
  }, [getAccessToken, userId]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [refresh, accountRevision]);
  const remove = async (machineId) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await cloudBillingRequest("remove-device", {
        auth: getAccessToken,
        body: { machine_id: machineId },
      });
      if (!mounted.current) return;
      if (
        data?.machines?.find((machine) => machine.machine_id === machineId)
          ?.is_current
      )
        clearCloudDeviceSession();
      setPending(null);
      await refresh();
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const resume = async (machine) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await cloudBillingRequest("resume-device", {
        auth: getAccessToken,
        body: { machine_id: machine.machine_id },
      });
      if (!mounted.current) return;
      if (machine.is_current) clearCloudDeviceSession();
      setNotice(copy("cloud.devices.resumed"));
      await refresh();
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const machines = data?.machines || [];
  const activeCount =
    data?.machine_count ??
    machines.filter((machine) => {
      return machine.status !== "paused";
    }).length;
  const limit = data?.machine_limit ?? machineLimit;
  const hasFreeSlot = limit == null || activeCount < limit;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1">
          <h3 className="text-sm font-semibold">{copy("cloud.devices.title")}</h3>
          <CloudHelp label={copy("cloud.devices.detail")} text={copy("cloud.devices.detail")} />
        </div>
        <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
          {data
            ? limit == null
              ? copy(selfHosted ? "cloud.devices.unlimited_self_hosted" : "cloud.devices.unlimited", { count: activeCount })
              : copy("cloud.devices.count", { count: activeCount, limit })
            : error
              ? copy("cloud.devices.count_unknown")
              : copy("cloud.catalog.loading")}
        </span>
      </div>
      {data?.over_machine_limit || (limit != null && limit < activeCount) ? (
        <div className="mb-4">
          <BillingNotice>{copy("cloud.devices.over_limit")}</BillingNotice>
        </div>
      ) : null}
      {error ? <BillingNotice error={error} onRetry={refresh} context="account" /> : null}
      {notice ? (
        <div className="mb-3">
          <BillingNotice>{notice}</BillingNotice>
        </div>
      ) : null}
      {!error && data && machines.length === 0 ? (
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("cloud.devices.empty")}
        </p>
      ) : null}
      {machines.length !== 0 ? (
        <ul className="divide-y divide-oai-gray-200 dark:divide-oai-gray-800">
          {machines.map((machine) => (
            <li key={machine.machine_id} className="py-1.5">
              <div className="grid grid-cols-[17px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
                <Monitor
                  size={17}
                  className="col-start-1 row-start-1 text-oai-gray-500 dark:text-oai-gray-400"
                  aria-hidden
                />
                  <p title={machine.name || copy("cloud.devices.unnamed")} className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium">
                    {machine.name || copy("cloud.devices.unnamed")}
                  </p>
                  <div className="col-span-2 col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-oai-gray-500 dark:text-oai-gray-400 sm:col-span-1 sm:col-start-2">
                    <span>{cloudPlatformLabel(machine.platform)}</span>
                    <span aria-hidden>·</span>
                    <span>{machine.last_seen_at
                      ? copy("cloud.devices.last_seen", {
                          date: formatCloudDateTime(machine.last_seen_at),
                        })
                      : copy("cloud.devices.last_seen_unknown")}</span>
                    {machine.is_current ? <><span aria-hidden>·</span><span>{copy("cloud.devices.current")}</span></> : null}
                    {machine.status === "paused" ? <><span aria-hidden>·</span><span>{copy("cloud.devices.paused")}</span></> : null}
                  </div>
                  {machine.status === "paused" && !hasFreeSlot ? (
                    <p className="col-start-2 row-start-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                      {copy("cloud.devices.no_slot")}
                    </p>
                  ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="col-start-3 row-start-1 !min-h-10 !px-2 sm:row-span-2"
                  aria-expanded={machine.status !== "paused" ? pending === machine.machine_id : undefined}
                  aria-controls={pending === machine.machine_id ? `cloud-machine-confirm-${machine.machine_id}` : undefined}
                  onClick={() =>
                    machine.status === "paused"
                      ? resume(machine)
                      : setPending((current) => current === machine.machine_id ? null : machine.machine_id)
                  }
                  disabled={
                    busy || (machine.status === "paused" && !hasFreeSlot)
                  }
                >
                  {machine.status === "paused" ? <Play size={14} className="mr-1.5 shrink-0" aria-hidden /> : <Pause size={14} className="mr-1.5 shrink-0" aria-hidden />}
                  {machine.status === "paused"
                    ? copy("cloud.devices.resume")
                    : copy("cloud.devices.remove")}
                </Button>
              </div>
              {pending === machine.machine_id ? (
                <div id={`cloud-machine-confirm-${machine.machine_id}`} className="mt-3 rounded-lg bg-oai-gray-50 p-3 dark:bg-oai-gray-800">
                  <p className="text-xs leading-5">
                    {copy("cloud.devices.remove_detail")}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => remove(machine.machine_id)}
                      disabled={busy}
                    >
                      {copy("cloud.devices.confirm_remove")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setPending(null)}
                      disabled={busy}
                    >
                      {copy("cloud.action.keep")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RestoreCloudOrder({ recent, pendingOrders, conflictOrders, userId, payments = [], footerActions }) {
  const navigate = useNavigate();
  const [orderId, setOrderId] = useState(recent?.order_id && CLOUD_ORDER_ID_PATTERN.test(recent.order_id) ? recent.order_id : "");
  const [invalid, setInvalid] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const lookupId = useId();
  const inputRef = useRef(null);
  useEffect(() => {
    if (lookupOpen) inputRef.current?.focus();
  }, [lookupOpen]);
  const paidOrderIds = new Set([
    ...payments.map((payment) => payment.order_id).filter((id) => typeof id === "string"),
    ...(pendingOrders || []).filter((order) => order.status === "paid" ||
      ["paid", "partially_refunded", "refunded"].includes(order.payment_state)).map((order) => order.id),
  ].map((id) => id.toLowerCase()));
  const orders = [...(conflictOrders || []), ...(pendingOrders || []).filter((order) =>
    order.retry_payment_conflict_at || !paidOrderIds.has(order.id.toLowerCase()))].filter(
    (order, index, all) => { return all.findIndex((item) => item.id === order.id) === index; },
  );
  return (
    <div className="mt-2 space-y-3">
      {recent?.request_id && !recent.order_id ? (
        <Link
          to={`/billing/checkout?sku=${encodeURIComponent(recent.sku)}`}
          className="mt-3 inline-flex min-h-10 items-center text-sm text-oai-brand underline underline-offset-4"
        >
          {copy("cloud.action.resume_purchase")}
        </Link>
      ) : null}
      {orders.length || payments.length ? <div className="sm:grid sm:grid-cols-[minmax(0,1fr)_auto_minmax(7rem,auto)] sm:gap-x-4">
        <div aria-hidden className="hidden gap-x-4 pb-1 text-xs text-oai-gray-500 dark:text-oai-gray-400 sm:col-span-3 sm:grid sm:grid-cols-subgrid">
          <span>{copy("cloud.history.date")}</span>
          <span className="text-right">{copy("cloud.history.amount")}</span>
          <span className="text-right">{copy("cloud.history.status")}</span>
        </div>
        <ul className="divide-y divide-oai-gray-200 dark:divide-oai-gray-800 sm:col-span-3 sm:grid sm:grid-cols-subgrid">
          {orders.map((order) => {
            const date = typeof order.created_at === "string" && Number.isFinite(Date.parse(order.created_at))
              ? formatCloudDate(order.created_at) : null;
            let amount = null;
            if (Number.isInteger(order.amount_cents) && order.amount_cents >= 0 && ["USD", "CNY"].includes(order.currency)) {
              amount = formatCloudMoney(order.amount_cents, order.currency);
            }
            const status = copy(order.retry_payment_conflict_at ? "cloud.action.review_duplicate_payment" : "cloud.history.pending");
            return (
            <li key={order.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3 sm:col-span-3 sm:grid-cols-subgrid">
              <p className="col-start-1 row-start-1 text-sm tabular-nums">{date || status}</p>
              <p className="col-start-2 row-start-1 text-right text-sm font-medium tabular-nums">{amount}</p>
              {order.provider || date ? <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                {order.provider ? <span>{cloudProviderLabel(order.provider)}</span> : null}
                {date ? <>{order.provider ? <span aria-hidden>·</span> : null}<span>{status}</span></> : null}
              </div> : null}
              <Link
                to={`/billing/checkout?order=${encodeURIComponent(order.id)}`}
                onClick={(event) => {
                  if (order.retry_payment_conflict_at || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
                    !CLOUD_ORDER_ID_PATTERN.test(order.id)) return;
                  event.preventDefault();
                  navigate(beginCloudOrderAction({ orderId: order.id, userId }));
                }}
                className="col-start-2 row-start-2 inline-flex min-h-10 items-center justify-end rounded-sm text-right text-sm underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 sm:col-start-3 sm:row-span-2 sm:row-start-1 sm:self-start sm:items-start"
              >
                <span>{order.retry_payment_conflict_at
                  ? copy("cloud.action.review_duplicate_payment")
                  : copy("cloud.action.resume_order")}</span>
              </Link>
            </li>
            );
          })}
          <CloudPaymentRecords payments={payments} />
        </ul>
      </div> : <>{(!recent?.request_id || recent.order_id) && <p className="py-2 text-sm text-oai-gray-500 dark:text-oai-gray-400">
        {copy("cloud.history.empty")}
      </p>}</>}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <Button variant="ghost" size="sm" className="!h-10 !px-0"
          aria-expanded={lookupOpen} aria-controls={`${lookupId}-panel`}
          onClick={() => setLookupOpen((value) => !value)}>
          {copy("cloud.restore.title")}
        </Button>
        {footerActions}
        </div>
      {lookupOpen ? <div id={`${lookupId}-panel`} className="mt-2">
        <p className="text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
          {copy("cloud.restore.detail")}
        </p>
      <form
        className="mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!CLOUD_ORDER_ID_PATTERN.test(orderId.trim())) {
            setInvalid(true);
            return;
          }
          const id = orderId.trim();
          const conflicting = orders.some((order) => order.id.toLowerCase() === id.toLowerCase() && order.retry_payment_conflict_at);
          navigate(conflicting ? `/billing/checkout?order=${encodeURIComponent(id)}` : beginCloudOrderAction({ orderId: id, userId }));
        }}
      >
        <label
          htmlFor={`${lookupId}-input`}
          className="text-xs text-oai-gray-500 dark:text-oai-gray-400"
        >
          {copy("cloud.checkout.order_id")}
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id={`${lookupId}-input`}
            ref={inputRef}
            value={orderId}
            onChange={(event) => {
              setOrderId(event.target.value);
              setInvalid(false);
            }}
            placeholder={copy("cloud.restore.placeholder")}
            className="min-h-10 min-w-0 flex-1 rounded-md border border-oai-gray-300 bg-transparent px-3 text-sm outline-none focus:border-oai-brand focus:ring-2 focus:ring-inset focus:ring-oai-brand/30 dark:border-oai-gray-700"
            aria-invalid={invalid}
            aria-describedby={invalid ? `${lookupId}-error` : undefined}
          />
          <Button type="submit" variant="secondary">
            {copy("cloud.action.restore")}
          </Button>
        </div>
        {invalid ? (
          <p
            id={`${lookupId}-error`}
            role="alert"
            className="mt-2 text-xs text-red-600 dark:text-red-400"
          >
            {copy("cloud.restore.invalid")}
          </p>
        ) : null}
      </form>
      </div> : null}
      </div>
    </div>
  );
}

function CloudPaymentRecords({ payments }) {
  return <>
    {payments.map((payment) => <li key={payment.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3 sm:col-span-3 sm:grid-cols-subgrid">
      <p className="col-start-1 row-start-1 text-sm tabular-nums">{formatCloudDate(payment.paid_at)}</p>
      <p className="col-start-2 row-start-1 text-right text-sm font-medium tabular-nums">
        {formatCloudMoney(payment.amount_cents, payment.currency)}
      </p>
      <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
        <span>{cloudProviderLabel(payment.provider)}</span>
        <span aria-hidden>·</span>
        <span>{copy("cloud.history.term", { start: formatCloudDate(payment.starts_at), end: formatCloudDate(payment.ends_at) })}</span>
      </div>
      <p className={`col-start-2 row-start-2 text-right text-sm font-medium sm:col-start-3 sm:row-span-1 sm:row-start-1 sm:self-start ${payment.refunded_cents > 0 ? "text-amber-700 dark:text-amber-400" : "text-oai-gray-600 dark:text-oai-gray-300"}`}>
        {payment.refunded_cents > 0
          ? copy("cloud.history.refunded", { amount: formatCloudMoney(payment.refunded_cents, payment.currency) })
          : copy("cloud.history.paid")}
      </p>
    </li>)}
  </>;
}

export function CloudMembershipCard({ showTitle = true, heading, syncControl, active = true }) {
  const values = useCloudAccount();
  return (
    <CloudMembershipAccount
      key={values.auth?.signedIn ? values.auth.user?.id : "signed-out"}
      showTitle={showTitle}
      heading={heading}
      syncControl={syncControl}
      active={active}
      {...values}
    />
  );
}

export function CloudMembershipAccount({ account, auth, loading, error, refresh, showTitle, heading, syncControl, active = true }) {
  const { openLoginModal } = useLoginModal();
  const [activeDialog, setActiveDialog] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    // Hidden settings sections stay mounted, but their portals must leave with the section.
    // Keeping the component preserves an in-flight redemption and its eventual receipt.
    if (!active) setActiveDialog(null);
  }, [active]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const membership = account?.membership;
  const selfHosted = membership?.status === "self_hosted" || membership?.hosting_mode === "self_hosted";
  const paymentConflict = [...(account?.conflict_orders || []), ...(account?.pending_orders || [])]
    .some((order) => order.retry_payment_conflict_at);
  const activeSubscription = !selfHosted && account?.subscriptions?.find((item) =>
    ["active", "trialing", "past_due", "paused", "canceling"].includes(item.status),
  );
  const waffoPortal = !selfHosted && (activeSubscription
    ? activeSubscription.provider === "waffo"
    : account?.payments?.some((payment) => payment.provider === "waffo"));
  const canCancelRenewal =
    activeSubscription && !activeSubscription.cancel_at_period_end && activeSubscription.status !== "canceling";
  const hasRenewal = canCancelRenewal && activeSubscription.status !== "paused";
  const nextBillingDate = activeSubscription?.next_billed_at;
  const knownBillingDate = nextBillingDate && Number.isFinite(Date.parse(nextBillingDate));
  useEffect(() => {
    if (canceling && account && !canCancelRenewal) {
      setCanceling(null);
      setActionError(null);
    }
  }, [account, canceling, canCancelRenewal]);
  const endDate = selfHosted ? null :
    membership?.status === "trial"
      ? membership.trial_ends_at
      : membership?.status === "transition"
        ? membership.transition_ends_at
        : membership?.expires_at;
  const perform = async (operation) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await operation();
    } catch (reason) {
      if (mounted.current) setActionError(reason);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const portal = () =>
    perform(async () => {
      const value = await cloudBillingRequest("portal", {
        auth: auth.getAccessToken,
        body: activeSubscription
          ? { subscription_id: activeSubscription.provider_subscription_id }
          : {},
      });
      if (!mounted.current) return;
      await openCloudExternal(value.url || value.portal_url);
    });
  const cancel = () =>
    perform(async () => {
      await cloudBillingRequest("cancel", {
        auth: auth.getAccessToken,
        body: { subscription_id: canceling },
      });
      if (!mounted.current) return;
      setCanceling(null);
      await refresh();
    });
  const membershipSummary = cloudMembershipSummary(membership, endDate);
  const hasTools = (waffoPortal && !activeSubscription) || membership?.can_read_cloud ||
    (!selfHosted && account?.gift_redemption_available === true);

  if (!auth?.signedIn) {
    return (
      <div className="space-y-4">
      {heading ? <h2 className="shrink-0 !text-2xl font-semibold">{heading}</h2> : null}
      <Card className="tt-cloud-theme">
        {!heading && showTitle ? <h2 className="text-base font-semibold">
          {copy("cloud.membership.title")}
        </h2> : null}
        <p className={`${!heading && showTitle ? "mt-2 " : ""}text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400`}>
          {copy("cloud.membership.signed_out")}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => openLoginModal({ subtitle: copy("cloud.membership.signed_out") })}>
            {copy("cloud.action.sign_in_continue")}
          </Button>
        </div>
      </Card>
      </div>
    );
  }
  return (
    <div className="space-y-4">
    <section aria-label={copy("cloud.membership.title")} className="tt-cloud-theme space-y-3">
      {account?.environment === "sandbox" ? (
        <BillingNotice>{copy("cloud.catalog.sandbox")}</BillingNotice>
      ) : null}
      {paymentConflict ? <CloudPaymentConflictNotice showBillingLink={false} /> : null}
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-2">
            {heading ? <h2 className="shrink-0 !text-2xl font-semibold">{heading}</h2> : null}
            {!heading && showTitle ? <h2 className="inline-flex items-center gap-2 text-base font-semibold">
              <Cloud size={18} className="text-oai-gray-500 dark:text-oai-gray-400" aria-hidden />
              {copy("cloud.membership.title")}
            </h2> : null}
            {membershipSummary ? <span className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
              {membershipSummary}
            </span> : null}
          </div>
          <Button
            onClick={refresh}
            variant="ghost"
            size="sm"
            className="!size-10 shrink-0 !p-0"
            disabled={loading}
            aria-label={copy("cloud.action.refresh_membership")}
          >
            <RefreshCw size={15} className={loading ? "motion-safe:animate-spin" : undefined} aria-hidden />
          </Button>
        </div>
        {membership?.status === "expired" ? <p className="mt-3 max-w-2xl text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
          {membership.can_read_cloud ? copy("cloud.membership.read_only", { date: formatCloudDate(membership.read_only_until) }) : copy("cloud.membership.expired_detail")}
        </p> : null}
        {membership ? <CloudDeadlinePrompt userId={auth.user?.id} membership={membership} subscriptions={account?.subscriptions} className="mt-3" /> : null}
        {!membership && loading ? (
          <p role="status" className="mt-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">
            {copy("cloud.catalog.loading")}
          </p>
        ) : null}
        {activeSubscription ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          {activeSubscription ? <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
            {activeSubscription.status === "paused"
              ? copy("cloud.membership.renewal_paused")
              : activeSubscription.status === "past_due"
                ? copy("cloud.membership.payment_due")
              : hasRenewal
                ? knownBillingDate
                  ? copy("cloud.membership.renews", { date: formatCloudDate(nextBillingDate) })
                  : copy("cloud.membership.renewal_unknown")
                : copy("cloud.membership.renewal_off")}
            </p>
            {canCancelRenewal ? <Button
              aria-expanded={Boolean(canceling)} aria-controls={canceling ? "cloud-cancel-confirm" : undefined}
              onClick={() => setCanceling((current) => current === activeSubscription.provider_subscription_id ? null : activeSubscription.provider_subscription_id)}
              variant="ghost" size="sm" className="!h-10 !px-2" disabled={busy}>
              {copy("cloud.action.cancel_renewal")}
            </Button> : null}
          </div> : null}
        </div> : null}
        {canceling ? (
          <div id="cloud-cancel-confirm" className="mt-4 rounded-lg border border-oai-gray-200 p-4 dark:border-oai-gray-800">
            <p className="text-sm leading-6">
              {endDate
                ? copy("cloud.cancel.detail", { date: formatCloudDate(endDate) })
                : copy("cloud.cancel.no_term")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={cancel} variant="secondary" disabled={busy}>
                {copy("cloud.cancel.confirm")}
              </Button>
              <Button
                onClick={() => setCanceling(null)}
                variant="ghost"
                disabled={busy}
              >
                {copy("cloud.action.keep")}
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="mt-4">
            <BillingNotice error={error} onRetry={refresh} context="account" />
          </div>
        ) : null}
        {actionError && activeDialog !== "billing" ? (
          <div className="mt-4">
            <BillingNotice error={actionError} context="account" />
          </div>
        ) : null}
      </div>
    </section>
      {membership ? <Card className="tt-cloud-theme !rounded-lg" bodyClassName="!py-3">
        <CloudMachineList auth={auth} machineLimit={membership.machine_limit}
          accountRevision={account} selfHosted={selfHosted} />
      </Card> : null}
      {hasTools || account && !selfHosted || syncControl ? <Card className="tt-cloud-theme !rounded-lg" bodyClassName="!py-2">
      <section aria-label={copy("cloud.membership.tools_title")} className="divide-y divide-oai-gray-200 dark:divide-oai-gray-800">
        {!selfHosted ? activeSubscription ? <button type="button" onClick={portal} disabled={busy}
          className="inline-flex h-11 w-full items-center gap-3 rounded-md border-0 bg-transparent p-0 text-left text-sm font-medium text-oai-black transition-colors hover:bg-oai-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oai-gray-500 disabled:opacity-50 dark:text-oai-white dark:hover:bg-oai-gray-800">
          <Cloud size={16} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{copy("cloud.action.manage_subscription")}</span>
          <ExternalLink size={16} className="shrink-0 text-oai-gray-500 dark:text-oai-gray-400" aria-hidden />
        </button> : <Link to="/cloud"
          className="inline-flex h-11 w-full items-center gap-3 rounded-md border-0 bg-transparent p-0 text-left text-sm font-medium text-oai-black transition-colors hover:bg-oai-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oai-gray-500 dark:text-oai-white dark:hover:bg-oai-gray-800">
          <Cloud size={16} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{copy("cloud.action.subscribe")}</span>
          <ChevronRight size={16} className="shrink-0 text-oai-gray-500 dark:text-oai-gray-400" aria-hidden />
        </Link> : null}
        {account && !selfHosted ? <CloudActionDialog open={activeDialog === "billing"}
          onOpenChange={(open) => setActiveDialog(open ? "billing" : null)}
          title={copy("cloud.billing.title")} icon={CreditCard} wide>
            {actionError ? <div className="mb-3"><BillingNotice error={actionError} context="account" /></div> : null}
            <RestoreCloudOrder
              userId={auth.user?.id}
              recent={readCloudPurchase(auth.user?.id)}
              pendingOrders={account?.pending_orders}
              conflictOrders={account?.conflict_orders}
              payments={account.payments}
              footerActions={waffoPortal && !activeSubscription ? <div className="flex items-center gap-0.5">
                <Button onClick={portal} variant="ghost" size="sm" className="!h-10 !px-0" disabled={busy}>
                  {copy("cloud.action.view_bills")}<ExternalLink size={14} className="ml-2" aria-hidden />
                </Button>
              </div> : null}
            />
        </CloudActionDialog> : null}
        {membership?.can_read_cloud ? <CloudUsageExport auth={auth} layout="settings-row"
          dialogOpen={activeDialog === "export"} onDialogOpenChange={(open) => setActiveDialog(open ? "export" : null)} /> : null}
        <RedeemProCode account={account} auth={auth} refresh={refresh} layout="settings-row"
          dialogOpen={activeDialog === "redeem"} onDialogOpenChange={(open) => setActiveDialog(open ? "redeem" : null)} />
        {syncControl ? <section>{syncControl}</section> : null}
      </section>
      </Card> : null}
    </div>
  );
}
