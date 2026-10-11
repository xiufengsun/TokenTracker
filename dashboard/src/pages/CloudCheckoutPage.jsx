import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  BillingNotice,
  CloudPaymentConflictNotice,
  SelfHostedCloudState,
  cloudProviderLabel,
  formatCloudDate,
  formatCloudDateTime,
} from "../components/cloud/CloudBillingParts.jsx";
import {
  useCloudAccount,
  useCloudCatalog,
} from "../hooks/use-cloud-billing.js";
import {
  cloudBillingRequest,
  cloudCheckoutLaunched,
  formatCloudMoney,
} from "../lib/cloud-billing";
import {
  clearCloudPurchase,
  CLOUD_ORDER_ID_PATTERN,
  cloudOrderState,
  getCloudCheckoutRestartRequest,
  getCloudPurchaseRequest,
  openCloudExternal,
  readCloudPurchase,
  saveCloudPurchase,
} from "../lib/cloud-checkout.js";
import { copy } from "../lib/copy";
import { clearCloudAction, consumeCloudAction, readCloudAction } from "../lib/cloud-action-intent";
import { getInsforgeInstanceFingerprint } from "../lib/insforge-config";
import { getCloudSyncEnabled, isLocalDashboardHost } from "../lib/cloud-sync-prefs";
import { detectOS } from "../lib/os";
import { isNativeEmbed, isNativeWindowsApp, isNativeLinuxApp } from "../lib/native-bridge.js";
import { Button } from "../ui/components/Button.jsx";
import { Card } from "../ui/components/Card.jsx";
import { ToggleSwitch } from "../components/settings/Controls.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { CloudPlanView } from "./CloudPage.jsx";

export function CloudCheckoutPage() {
  const navigate = useNavigate();
  const { openLoginModal } = useLoginModal();
  const promptedLogin = useRef(null);
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    // Ignore legacy checkout hints. Only the owned server order controls payment.
    if (!params.has("_ptxn")) return;
    const next = new URLSearchParams(params);
    next.delete("_ptxn");
    setParams(next, { replace: true });
  }, [params, setParams]);
  const {
    catalog,
    loading: catalogLoading,
    error: catalogError,
    refresh: refreshCatalog,
  } = useCloudCatalog();
  const { account, auth, loading: accountLoading, error: accountError, refresh: refreshAccount } = useCloudAccount();
  const orderId = params.get("order") || "";
  const trialIntent = params.get("intent") === "trial";
  const requestedSku = params.get("sku");
  const checkoutPath = `/billing/checkout?${params}`;
  const [orderResult, setOrderResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadingOrder, setLoadingOrder] = useState(Boolean(orderId));
  const [error, setError] = useState(null);
  const [trialMembership, setTrialMembership] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [restartingCheckout, setRestartingCheckout] = useState(false);
  const [directAttempt, setDirectAttempt] = useState(null);
  const autoPayment = useRef(null);
  const mutationLock = useRef(false);
  const generation = useRef(0);
  const refreshedTerminal = useRef(null);
  const mounted = useRef(true);
  const userId = auth?.signedIn ? auth.user?.id : null;
  const backend = getInsforgeInstanceFingerprint();
  const backendScope = useRef(backend);
  backendScope.current = backend;
  const orderScope = useRef(orderId);
  orderScope.current = orderId;
  const accountScope = useRef(userId);
  accountScope.current = userId;
  const currentOrderResult =
    orderResult?.ownerId === userId && orderResult?.backend === backend &&
    (orderId ? orderResult.order?.id?.toLowerCase() === orderId.toLowerCase() : !orderResult.verified && orderResult.createdFrom === checkoutPath)
      ? orderResult : null;
  const currentTrial =
    trialMembership?.ownerId === userId && trialMembership?.backend === backend ? trialMembership : null;
  const currentActionError =
    actionError?.ownerId === userId && actionError?.backend === backend && actionError?.orderId === orderId
      ? actionError.error : null;
  const displayError = error || currentActionError;
  const order = currentOrderResult?.order;
  const membership =
    currentTrial || currentOrderResult?.membership || account?.membership;
  const selfHostedInstance = catalog?.policy?.hosting_mode === "self_hosted" || membership?.status === "self_hosted";
  const sku = order?.sku || requestedSku;
  const price = catalog?.prices?.find((item) => item.sku === sku);
  const currency = order?.currency || price?.currency;
  const amount = order?.amount_cents ?? price?.amount_cents;
  const billingMode = order?.billing_mode || price?.billing_mode;
  const termMonths = order?.term_months || price?.term_months;
  const selectedProvider = order?.provider || "waffo";
  const state = currentTrial
    ? "trial_success"
    : busy && !order
      ? "creating"
      : cloudOrderState(order, membership);
  const launched = cloudCheckoutLaunched(catalog);
  const providerAvailable = Boolean(catalog?.providers?.[selectedProvider]);
  const paymentConflict = Boolean(order?.retry_payment_conflict_at ||
    [...(account?.conflict_orders || []), ...(account?.pending_orders || [])]
      .some((item) => item.retry_payment_conflict_at));
  const hasGiftAccess = membership?.has_gift === true || membership?.access_source === "gift" || account?.membership?.has_gift === true ||
    account?.gifts?.some((gift) => ["active", "pending"].includes(gift.state));
  const canRestartCheckout = order?.provider === "waffo" &&
    order.payment_state === "unpaid" &&
    order.status !== "paid" &&
    ["awaiting", "expired", "canceled"].includes(state) && launched && providerAvailable && !paymentConflict && !hasGiftAccess;
  const requestAuth = auth?.getAccessToken;
  const recent = readCloudPurchase(userId);
  const openSubscription = account?.subscriptions?.some((item) =>
    ["active", "trialing", "past_due", "paused"].includes(item.status) && !item.cancel_at_period_end,
  );
  const hasPaidTerm = membership?.status === "active" || account?.payments?.some((item) => {
    return item.refunded_cents < item.amount_cents && Date.parse(item.ends_at) > Date.now();
  });
  const counterpartPrice = ["fixed", "recurring"].includes(price?.billing_mode)
    ? catalog?.prices?.find((item) => item.currency === price.currency &&
      item.term_months === price.term_months &&
      item.billing_mode === (price.billing_mode === "recurring" ? "fixed" : "recurring"))
    : null;
  // A SKU choice ends as soon as a purchase may have reached the server. Keep
  // ambiguous requests and existing orders bound to their original product.
  const canChooseBillingMode = Boolean(userId && membership && !auth?.loading && !accountLoading && !accountError &&
    state === "review" && !trialIntent && !orderId && !order && !busy &&
    launched && providerAvailable && !catalogLoading && !catalogError && counterpartPrice &&
    !hasPaidTerm && !hasGiftAccess && !openSubscription && !paymentConflict &&
    !recent?.request_id && !recent?.order_id && !account?.pending_orders?.length);
  const switchBillingMode = () => {
    if (!canChooseBillingMode || mutationLock.current) return;
    const purchase = readCloudPurchase(userId);
    if (purchase?.request_id || purchase?.order_id) return;
    const next = new URLSearchParams(params);
    next.set("sku", counterpartPrice.sku);
    setParams(next, { replace: true });
  };
  const pendingAction = readCloudAction(checkoutPath, userId);
  const directAction = pendingAction || (
    directAttempt?.nextPath === checkoutPath && directAttempt?.ownerId === userId && directAttempt?.backend === backend
      ? directAttempt : null
  );
  const loginSubtitle = copy(trialIntent ? "cloud.login.trial_context" : "cloud.login.purchase_context");
  useEffect(() => {
    if (userId) {
      promptedLogin.current = null;
      return;
    }
    if (auth?.loading || catalogLoading || selfHostedInstance || promptedLogin.current === checkoutPath) return;
    promptedLogin.current = checkoutPath;
    openLoginModal({ nextPath: checkoutPath, subtitle: loginSubtitle, closePath: "/cloud" });
  }, [userId, auth?.loading, catalogLoading, selfHostedInstance, checkoutPath, loginSubtitle, openLoginModal]);
  const desktopReturnUrl = catalog?.environment === "live" && !trialIntent &&
    params.getAll("order").length === 1 && CLOUD_ORDER_ID_PATTERN.test(orderId) &&
    ["mac", "windows"].includes(detectOS()) &&
    !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) &&
    !isNativeEmbed() && !isNativeWindowsApp() && !isNativeLinuxApp()
      ? `tokentracker://billing/return?order=${orderId.toLowerCase()}` : null;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refreshOrder = useCallback(async () => {
    if (selfHostedInstance) return null;
    if (!orderId || !userId || accountScope.current !== userId) return null;
    if (!CLOUD_ORDER_ID_PATTERN.test(orderId)) {
      setError({ code: "order_not_found" });
      setLoadingOrder(false);
      return null;
    }
    const id = ++generation.current;
    try {
      const value = await cloudBillingRequest("order", {
        auth: requestAuth,
        params: { id: orderId },
      });
      if (id !== generation.current || accountScope.current !== userId || backendScope.current !== backend)
        return null;
      setOrderResult({ ...value, ownerId: userId, backend, verified: true });
      setError(null);
      const nextState = cloudOrderState(value.order, value.membership);
      if (nextState === "success")
        setActionError(null);
      if (["success", "refunded"].includes(nextState)) {
        const key = `${userId}:${orderId}:${nextState}`;
        if (refreshedTerminal.current !== key) {
          refreshedTerminal.current = key;
          void refreshAccount();
        }
      }
      if (
        ["success", "expired", "canceled", "refunded"].includes(
          cloudOrderState(value.order, value.membership),
        )
      ) {
        const purchase = readCloudPurchase(userId);
        const recovering = value.order.payment_state === "unpaid" && value.order.status !== "paid" &&
          ["expired", "canceled"].includes(cloudOrderState(value.order, value.membership)) &&
          purchase?.retry_order_id === orderId && purchase?.retry_request_id;
        if (purchase?.order_id === orderId && !recovering)
          clearCloudPurchase(userId);
      }
      return value;
    } catch (reason) {
      if (id === generation.current) setError(reason);
      return null;
    } finally {
      if (id === generation.current) setLoadingOrder(false);
    }
  }, [orderId, userId, requestAuth, selfHostedInstance, refreshAccount, backend]);

  useEffect(() => {
    setOrderResult(null);
    setError(null);
    refreshedTerminal.current = null;
    setLoadingOrder(Boolean(orderId && userId));
    void refreshOrder();
    return () => {
      generation.current += 1;
    };
  }, [refreshOrder, orderId, userId]);
  useEffect(() => {
    if (
      selfHostedInstance || !orderId ||
      !userId ||
      ["success", "canceled", "expired", "refunded"].includes(state)
    )
      return;
    const onReturn = () => {
      if (document.visibilityState === "visible") void refreshOrder();
    };
    const timer = window.setInterval(onReturn, 5000);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [orderId, userId, state, refreshOrder, selfHostedInstance]);
  const perform = useCallback(async (operation) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      await operation();
    } catch (reason) {
      if (mounted.current && accountScope.current === userId && backendScope.current === backend)
        setActionError({ ownerId: userId, backend, orderId, error: reason });
    } finally {
      mutationLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [userId, orderId, backend]);

  const createOrder = useCallback((openDirectly = false) =>
    perform(async () => {
      const purchase = getCloudPurchaseRequest(userId, sku, selectedProvider);
      const value = await cloudBillingRequest("checkout", {
        auth: requestAuth,
        body: {
          sku,
          provider: selectedProvider,
          request_id: purchase.request_id,
          mobile: window.matchMedia("(max-width: 640px)").matches,
        },
      });
      if (backendScope.current !== backend) return;
      saveCloudPurchase(userId, { ...purchase, order_id: value.order.id });
      if (!mounted.current || accountScope.current !== userId) return;
      if (openDirectly === true) {
        autoPayment.current = { ownerId: userId, backend, orderId: value.order.id, opened: false };
      }
      setOrderResult({
        ...value,
        ownerId: userId,
        backend,
        createdFrom: checkoutPath,
        order: { ...price, provider: selectedProvider, ...value.order },
      });
      setParams({ order: value.order.id }, { replace: true });
    }), [perform, userId, sku, selectedProvider, requestAuth, price, setParams, backend, checkoutPath]);

  const startTrial = useCallback((continueToUsage = false) =>
    perform(async () => {
      let value;
      try {
        value = await cloudBillingRequest("trial", { auth: requestAuth, body: {} });
      } catch (reason) {
        if (continueToUsage === true && (reason.code || reason.message) === "trial_unavailable") {
          if (mounted.current && accountScope.current === userId && backendScope.current === backend) {
            await refreshAccount();
            if (mounted.current && accountScope.current === userId && backendScope.current === backend) navigate("/cloud", { replace: true });
          }
          return;
        }
        throw reason;
      }
      if (!mounted.current || accountScope.current !== userId || backendScope.current !== backend) return;
      setTrialMembership({ ...value.membership, ownerId: userId, backend });
      if (continueToUsage === true) {
        await refreshAccount();
        if (mounted.current && accountScope.current === userId && backendScope.current === backend) navigate("/dashboard", { replace: true });
      } else {
        void refreshAccount();
      }
    }), [perform, requestAuth, userId, refreshAccount, navigate, backend]);

  useEffect(() => {
    // Only a CTA recorded in this tab may start a mutation after sign-in.
    const action = readCloudAction(checkoutPath, userId);
    if (!action || !userId || busy || auth?.loading || accountLoading || accountError ||
      catalogLoading || catalogError || !membership || selfHostedInstance || !launched) return;
    if (action.orderId) {
      if (action.orderId !== orderId) return;
      const consumed = consumeCloudAction(checkoutPath, userId);
      if (!consumed) return;
      setDirectAttempt({ ...consumed, ownerId: userId });
      if (!paymentConflict) autoPayment.current = { ownerId: userId, backend, orderId, opened: false };
      return;
    }
    if (orderId) return;
    if (!action.trial && (!price || !providerAvailable || !billingMode)) return;
    const consumed = consumeCloudAction(checkoutPath, userId);
    if (!consumed) return;
    setDirectAttempt({ ...consumed, ownerId: userId });
    if (action.trial) {
      if (membership.trial_available) {
        void startTrial(true);
      } else {
        const hasCloudAccess = membership.can_read_cloud || ["active", "trial", "transition"].includes(membership.status);
        navigate(hasCloudAccess ? "/dashboard" : "/cloud", { replace: true });
      }
      return;
    }
    if (hasGiftAccess || openSubscription || (hasPaidTerm && billingMode !== "fixed") || paymentConflict) {
      navigate("/settings?section=cloud", { replace: true });
      return;
    }
    const purchase = readCloudPurchase(userId);
    const pendingOrder = account?.pending_orders?.[0];
    const recoveryId = purchase?.order_id || pendingOrder?.id;
    if (recoveryId && CLOUD_ORDER_ID_PATTERN.test(recoveryId)) {
      autoPayment.current = { ownerId: userId, backend, orderId: recoveryId, opened: false };
      setParams({ order: recoveryId }, { replace: true });
    } else if (purchase?.request_id && (purchase.sku !== sku || purchase.provider !== selectedProvider)) {
      // Recover an ambiguous request on its original product; never make a second order.
      setParams({ sku: purchase.sku }, { replace: true });
    } else {
      void createOrder(true);
    }
  }, [checkoutPath, userId, orderId, busy, auth?.loading, accountLoading, accountError, catalogLoading,
    catalogError, membership, selfHostedInstance, launched, price, providerAvailable, billingMode,
    hasGiftAccess, openSubscription, hasPaidTerm, paymentConflict, account?.pending_orders,
    sku, selectedProvider, startTrial, createOrder, navigate, setParams, backend]);

  useEffect(() => {
    const payment = autoPayment.current;
    if (!payment || payment.opened || payment.ownerId !== userId || payment.backend !== backend || payment.orderId !== orderId || !currentOrderResult?.verified ||
      order?.id?.toLowerCase() !== orderId.toLowerCase() || !order?.checkout_url || state !== "awaiting" || busy || !launched || !providerAvailable || paymentConflict) return;
    payment.opened = true;
    void perform(() => openCloudExternal(order.checkout_url, { sameTab: true }));
  }, [userId, orderId, order?.id, order?.checkout_url, currentOrderResult?.verified, directAttempt?.nextPath, state, busy, launched, providerAvailable, paymentConflict, perform, backend]);

  const reconcile = () =>
    perform(async () => {
      await cloudBillingRequest("reconcile", {
        auth: requestAuth,
        body: { id: orderId },
      });
      if (!mounted.current || accountScope.current !== userId) return;
      await refreshOrder();
      await refreshAccount();
    });

  const restartCheckout = () =>
    perform(async () => {
      const purchase = getCloudCheckoutRestartRequest(userId, order);
      setRestartingCheckout(true);
      try {
        const value = await cloudBillingRequest("restart-checkout", {
          auth: requestAuth,
          body: { id: order.id, request_id: purchase.retry_request_id },
        });
        saveCloudPurchase(userId, {
          sku: order.sku,
          provider: order.provider,
          request_id: purchase.retry_request_id,
          order_id: value.order.id,
        });
        if (!mounted.current || accountScope.current !== userId || orderScope.current !== order.id) return;
        setOrderResult({ ...value, ownerId: userId, backend });
        setParams({ order: value.order.id }, { replace: true });
      } finally {
        if (mounted.current) setRestartingCheckout(false);
      }
    });

  const openPayment = () =>
    perform(async () => {
      await openCloudExternal(order.checkout_url);
    });

  const trialDays = catalog?.limits?.trial_days || 7;
  const localHost = isLocalDashboardHost();
  const needsSyncSetup = localHost && !getCloudSyncEnabled();
  const trialEnd = new Date(Date.now() + trialDays * 86400000).toISOString();
  const preparingText = trialIntent
    ? copy("cloud.checkout.starting_trial")
    : copy("cloud.checkout.creating");
  const headings = {
    review: trialIntent
      ? copy("cloud.checkout.trial_title")
      : copy("cloud.checkout.title"),
    creating: preparingText,
    awaiting: copy("cloud.checkout.awaiting"),
    activating: copy("cloud.checkout.activating"),
    success: copy("cloud.checkout.success"),
    canceled: copy("cloud.checkout.canceled"),
    expired: order?.status === "paid"
      ? copy("cloud.checkout.term_ended")
      : copy("cloud.checkout.expired"),
    refunded: copy("cloud.checkout.refunded"),
    trial_success: copy("cloud.checkout.trial_success"),
  };

  let contentNode = null;
  if (!userId) {
    contentNode = (
      <div className="space-y-5">
        <Button
          onClick={() => openLoginModal({ nextPath: checkoutPath, subtitle: loginSubtitle, closePath: "/cloud" })}
          className="w-full"
          disabled={auth?.loading}
        >
          {copy("cloud.action.sign_in_continue")}
        </Button>
      </div>
    );
  } else if (loadingOrder || (busy && !order)) {
    contentNode = (
      <p role="status" className="flex items-center gap-2 text-sm">
        <Loader2 className="motion-safe:animate-spin" size={17} aria-hidden />
        {loadingOrder
          ? copy("cloud.checkout.loading")
          : preparingText}
      </p>
    );
  } else if (state === "trial_success" || state === "success") {
    contentNode = (
      <div className="space-y-5">
        <CheckCircle2 size={32} className="text-oai-gray-700 dark:text-oai-gray-200" aria-hidden />
        <p className="text-sm leading-6">
          {state === "trial_success"
            ? copy("cloud.trial.ends", {
                date: formatCloudDate(membership.trial_ends_at),
              })
            : copy("cloud.membership.expires", {
                date: formatCloudDate(membership.expires_at),
              })}
        </p>
        {needsSyncSetup || !localHost ? (
          <p className="text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">
            {copy(localHost ? "cloud.onboarding.local_next" : "cloud.onboarding.web_next")}
          </p>
        ) : null}
        <Button as={Link} to={needsSyncSetup ? "/settings?section=cloud" : "/dashboard"} className="w-full no-underline">
          {copy(needsSyncSetup ? "cloud.action.setup_sync" : "cloud.action.open_dashboard")}
        </Button>
        <Link to={needsSyncSetup ? "/dashboard" : "/settings?section=cloud"} className="flex min-h-10 items-center justify-center text-sm underline underline-offset-4">
          {copy(needsSyncSetup ? "cloud.action.open_dashboard" : "cloud.action.manage_membership")}
        </Link>
      </div>
    );
  } else if (state === "review" && !orderId && hasGiftAccess) {
    contentNode = (
      <div className="space-y-5">
        <BillingNotice>{copy("cloud.gift.error_active")}</BillingNotice>
        <Button as={Link} to="/settings?section=cloud" variant="secondary" className="w-full no-underline">
          {copy("cloud.action.manage_membership")}
        </Button>
      </div>
    );
  } else if (state === "review" && !orderId && trialIntent) {
    contentNode = (
      <div className="space-y-5">
        <p className="text-sm leading-6">
          {copy("cloud.trial.disclosure", {
            days: trialDays,
            date: formatCloudDate(trialEnd),
          })}
        </p>
        <p className="text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">
          {copy("cloud.trial.expiry")}
        </p>
        {account?.membership && !account.membership.trial_available ? (
          <div className="space-y-3">
            <BillingNotice>{copy("cloud.error.trial")}</BillingNotice>
            {!price ? <Button as={Link} to="/cloud" variant="secondary" className="w-full no-underline">{copy("cloud.action.view_plans")}</Button> : null}
          </div>
        ) : null}
        <Button
          onClick={startTrial}
          disabled={busy || !launched || !account?.membership?.trial_available}
          className="w-full"
        >
          {copy("cloud.action.start_trial", { days: trialDays })}
        </Button>
        {price && launched && providerAvailable && !busy ? (
          <Button
            as={Link}
            to={`/billing/checkout?sku=${encodeURIComponent(price.sku)}`}
            variant="ghost"
            className="mx-auto flex w-fit no-underline"
          >
            {copy("cloud.plan.skip_trial")}
          </Button>
        ) : null}
      </div>
    );
  } else if (state === "review" && !orderId && price) {
    contentNode = (
      <div className="space-y-5">
        <p className="text-sm leading-6">{copy("cloud.checkout.review")}</p>
        <p className="inline-flex items-center gap-2 text-sm">
          <ShieldCheck size={16} aria-hidden />
          {copy("cloud.checkout.waffo")}
        </p>
        {billingMode ? (
          <p className="text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">
            {billingMode === "fixed"
              ? copy("cloud.checkout.methods_fixed")
              : copy("cloud.checkout.methods_recurring")}
          </p>
        ) : null}
        {billingMode ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">
              {billingMode === "fixed"
                ? copy("cloud.renewal.manual")
                : copy("cloud.renewal.auto")}
            </p>
            {canChooseBillingMode ? (
              <ToggleSwitch checked={billingMode === "recurring"} onChange={switchBillingMode}
                ariaLabel={copy("cloud.billing_mode.recurring")} />
            ) : null}
          </div>
        ) : null}
        {recent?.order_id ? (
          <Button
            as={Link}
            to={`/billing/checkout?order=${encodeURIComponent(recent.order_id)}`}
            className="w-full no-underline"
          >
            {copy("cloud.action.resume_order")}
          </Button>
        ) : null}
        {recent?.request_id && !recent.order_id && recent.sku !== sku ? (
          <Button
            as={Link}
            to={`/billing/checkout?sku=${encodeURIComponent(recent.sku)}`}
            className="w-full no-underline"
          >
            {copy("cloud.action.resume_purchase")}
          </Button>
        ) : null}
        {!recent?.order_id && !(recent?.request_id && recent.sku !== sku) ? <Button
          onClick={createOrder}
          disabled={
            busy || !launched || !providerAvailable || !billingMode || Boolean(recent?.order_id) || paymentConflict
          }
          className="w-full"
        >
          {copy("cloud.action.create_checkout", {
            amount: formatCloudMoney(amount, currency),
          })}
        </Button> : null}
      </div>
    );
  } else if (order) {
    const descriptions = {
      creating: copy("cloud.checkout.pending_creation"),
      awaiting: copy("cloud.checkout.pending_payment"),
      activating: copy("cloud.checkout.received"),
      expired: order?.status === "paid"
        ? copy("cloud.checkout.term_ended_detail")
        : copy("cloud.checkout.expired_detail"),
      canceled: copy("cloud.checkout.canceled_detail"),
      refunded: copy("cloud.checkout.refunded_detail"),
    };
    contentNode = (
      <div className="space-y-5">
        <p className="text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">
          {descriptions[state]}
        </p>
        {state === "awaiting" && order.checkout_url && launched && providerAvailable && !paymentConflict ? (
          <Button
            onClick={openPayment}
            disabled={busy}
            className="w-full"
          >
            {copy("cloud.action.open_payment")}
            <ExternalLink size={15} className="ml-2" aria-hidden />
          </Button>
        ) : null}
        {state !== "refunded" ? (
          <>
            <Button
              onClick={reconcile}
              disabled={busy}
              variant="ghost"
              className="mx-auto flex underline underline-offset-4"
            >
              {busy
                ? copy("cloud.action.checking")
                : copy("cloud.action.check_payment")}
            </Button>
            <p className="text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
              {copy("cloud.checkout.recovery_hint")}
            </p>
          </>
        ) : null}
        {canRestartCheckout ? (
          <details open={state !== "awaiting"} className="border-t border-oai-gray-200 pt-4 dark:border-oai-gray-800">
            <summary className="min-h-10 cursor-pointer text-sm font-medium leading-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
              {copy("cloud.checkout.help_title")}
            </summary>
            <div className="space-y-3 pt-2">
            <p className="text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
              {copy("cloud.checkout.restart_detail")}
            </p>
            <Button
              onClick={restartCheckout}
              disabled={busy}
              variant={state === "awaiting" ? "secondary" : "primary"}
              className="w-full"
            >
              {restartingCheckout
                ? copy("cloud.action.restarting_checkout")
                : copy("cloud.action.restart_checkout")}
            </Button>
            </div>
          </details>
        ) : null}
        {["canceled", "expired"].includes(state) && !paymentConflict ? (
          <Link to="/cloud" className="flex min-h-10 items-center justify-center text-sm underline underline-offset-4">
            {order.status === "paid" ? copy("cloud.action.renew") : copy("cloud.action.choose_plan")}
          </Link>
        ) : null}
        {state === "refunded" ? (
          <Button as={Link} to="/settings?section=cloud" className="w-full no-underline">
            {copy("cloud.action.manage_membership")}
          </Button>
        ) : null}
        <details className="border-t border-oai-gray-200 pt-4 dark:border-oai-gray-800">
          <summary className="min-h-10 cursor-pointer text-xs leading-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            {copy("cloud.checkout.order_id")} · {order.id.slice(0, 8)}
          </summary>
          <p className="mb-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {cloudProviderLabel(order.provider)}
          </p>
          <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {copy("cloud.checkout.order_id")}
          </p>
          <p className="mt-1 break-all font-mono text-xs select-all">
            {order.id}
          </p>
          {order.status !== "paid" && order.expires_at ? (
            <p className="mt-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {copy("cloud.checkout.expires", {
                date: formatCloudDateTime(order.expires_at),
              })}
            </p>
          ) : null}
        </details>
      </div>
    );
  } else {
    contentNode = (
      <BillingNotice>
        {orderId
          ? copy("cloud.error.order_not_found")
          : copy("cloud.checkout.choose_plan")}
      </BillingNotice>
    );
  }

  const notices = (
    <div className="space-y-3">
      {displayError ? (
        <BillingNotice
          error={displayError}
          onRetry={orderId ? (error ? refreshOrder : reconcile) : undefined}
        />
      ) : null}
      {displayError &&
      [
        "subscription_already_exists",
        "fixed_term_still_active",
        "checkout_request_conflict",
        "pending_checkout_exists",
        "gift_membership_active",
      ].includes(displayError.code || displayError.message) ? (
        <Button
          as={Link}
          to="/settings?section=cloud"
          variant="secondary"
          className="no-underline"
        >
          {copy("cloud.action.manage_membership")}
        </Button>
      ) : null}
      {displayError &&
      [
        "authentication_required",
        "invalid_token",
        "invalid_authentication",
      ].includes(displayError.code || displayError.message) ? (
        <Button
          onClick={async () => {
            await auth?.signOut?.();
            promptedLogin.current = checkoutPath;
            openLoginModal({ nextPath: checkoutPath, subtitle: loginSubtitle, closePath: "/cloud" });
          }}
          variant="secondary"
        >
          {copy("cloud.action.sign_in_continue")}
        </Button>
      ) : null}
      {catalogError ? (
        <BillingNotice error={catalogError} onRetry={refreshCatalog} />
      ) : null}
      {accountError ? (
        <BillingNotice error={accountError} onRetry={refreshAccount} />
      ) : null}
      {!catalogError && catalogLoading ? (
        <BillingNotice>{copy("cloud.catalog.loading")}</BillingNotice>
      ) : null}
      {!catalogError && !catalogLoading && !launched ? (
        <BillingNotice>{copy("cloud.catalog.preview")}</BillingNotice>
      ) : null}
      {!catalogError &&
      !catalogLoading &&
      launched &&
      !trialIntent &&
      !displayError &&
      !providerAvailable &&
      ["review", "creating", "awaiting"].includes(state) ? (
        <BillingNotice>
          {copy("cloud.catalog.provider_unavailable")}
        </BillingNotice>
      ) : null}
      {!catalogError &&
      !catalogLoading &&
      launched &&
      catalog?.environment === "sandbox" ? (
        <BillingNotice>{copy("cloud.catalog.sandbox")}</BillingNotice>
      ) : null}
    </div>
  );

  if (selfHostedInstance) {
    return <SelfHostedCloudState />;
  }

  if (!userId && !orderId) {
    return (
      <>
        <CloudPlanView
          catalogState={{ catalog, loading: catalogLoading, error: catalogError, refresh: refreshCatalog }}
          accountState={{ account, auth, loading: accountLoading, error: accountError, refresh: refreshAccount }}
          selection={{ termMonths, billingMode }}
        />
      </>
    );
  }

  if (directAction && userId && !orderId) {
    return (
      <div className="tt-cloud-theme flex flex-1 flex-col font-oai text-oai-black dark:text-oai-white">
        <main className="mx-auto w-full max-w-lg px-4 py-12 sm:px-6">
          <Link to="/cloud" onClick={() => clearCloudAction(checkoutPath)} className="mb-6 inline-flex min-h-10 items-center gap-2 text-sm text-oai-gray-500 dark:text-oai-gray-400">
            <ArrowLeft size={16} aria-hidden />
            {copy("cloud.checkout.back")}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{preparingText}</h1>
          {busy || auth?.loading || catalogLoading || accountLoading ? (
            <p role="status" className="mt-5 flex items-center gap-2 text-sm text-oai-gray-500 dark:text-oai-gray-400">
              <Loader2 className="motion-safe:animate-spin" size={17} aria-hidden />
              {preparingText}
            </p>
          ) : null}
          <div className="mt-5">{notices}</div>
          {displayError && !busy ? (
            <Button onClick={() => trialIntent ? startTrial(true) : createOrder(true)}
              disabled={accountLoading || Boolean(accountError) || catalogLoading || Boolean(catalogError) ||
                !launched || (trialIntent ? !membership?.trial_available : !price || !providerAvailable || paymentConflict || hasGiftAccess || (hasPaidTerm && billingMode !== "fixed") || openSubscription)}
              className="mt-5 w-full">
              {copy("cloud.action.retry")}
            </Button>
          ) : null}
        </main>
      </div>
    );
  }

  return (
    <div className="tt-cloud-theme flex flex-1 flex-col font-oai text-oai-black dark:text-oai-white">
      <main className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6 sm:py-12">
        <Link
          to="/cloud"
          className="mb-7 inline-flex min-h-10 items-center gap-2 text-sm text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand"
        >
          <ArrowLeft size={16} aria-hidden />
          {copy("cloud.checkout.back")}
        </Link>
        <h1
          className="text-3xl font-semibold tracking-tight"
          aria-live="polite"
        >
          {loadingOrder ? copy("cloud.checkout.loading") : headings[state]}
        </h1>
        {catalog?.environment === "sandbox" && !trialIntent ? (
          <p className="mt-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {copy("cloud.price.draft")}
          </p>
        ) : null}

        {paymentConflict ? <div className="mt-5"><CloudPaymentConflictNotice /></div> : null}

        <div className="mt-7">
          <Card bodyClassName="sm:p-7">
            {contentNode}
            {desktopReturnUrl ? (
              <div className="mt-5 space-y-3 border-t border-oai-gray-200 pt-5 dark:border-oai-gray-800">
                <p className="text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("cloud.checkout.return_app_hint")}
                </p>
                <a href={desktopReturnUrl} className="inline-flex min-h-10 items-center text-sm underline underline-offset-4">
                  {copy("cloud.action.open_app")}
                </a>
              </div>
            ) : null}
          </Card>

        </div>
        <div className="mt-5">{notices}</div>
      </main>
    </div>
  );
}
