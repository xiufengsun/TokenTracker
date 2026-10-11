import React, { useLayoutEffect, useRef, useState } from "react";
import { Hub } from "@lucasmarkes/hairline/react";
import { ArrowRight, Check, ChevronDown, Cloud, Monitor, Server, ShieldCheck } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  BillingNotice,
  CloudFeatures,
  CloudPaymentConflictNotice,
  SelfHostedCloudState,
  cloudMembershipLabel,
  formatCloudDate,
} from "../components/cloud/CloudBillingParts.jsx";
import { SegmentedControl } from "../components/settings/Controls.jsx";
import {
  useCloudAccount,
  useCloudCatalog,
} from "../hooks/use-cloud-billing.js";
import {
  cloudAnnualSavings,
  cloudCheckoutLaunched,
  formatCloudMoney,
} from "../lib/cloud-billing";
import { copy } from "../lib/copy";
import { Button } from "../ui/components/Button.jsx";
import { Card } from "../ui/components/Card.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { beginCloudAction } from "../lib/cloud-action-intent.js";

function followPlanPointer(event) {
  if (event.pointerType === "touch" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const card = event.currentTarget;
  const bounds = card.getBoundingClientRect();
  card.style.setProperty("--tt-plan-pointer-x", `${event.clientX - bounds.left}px`);
  card.style.setProperty("--tt-plan-pointer-y", `${event.clientY - bounds.top}px`);
}

function PlanFeatures({ items }) {
  return (
    <ul className="space-y-4 py-7 text-sm leading-6">
      {items.map((label) => (
        <li key={label} className="flex items-start gap-3">
          <Check size={16} className="mt-1 shrink-0 text-oai-gray-500 dark:text-oai-gray-400" aria-hidden />
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

export function CloudPage() {
  const catalogState = useCloudCatalog();
  const accountState = useCloudAccount();
  const { state } = useLocation();
  return <CloudPlanView catalogState={catalogState} accountState={accountState}
    initialSelection={state?.cloudPlanSelection} restoreFocus={state?.cloudPlanRestoreFocus} />;
}

export function CloudPlanView({ catalogState, accountState, initialSelection, selection, restoreFocus = false }) {
  const pageRef = useRef(null);
  const proActionsRef = useRef(null);
  const restoredFocus = useRef(false);
  useLayoutEffect(() => {
    const scroller = pageRef.current?.parentElement;
    if (scroller) scroller.scrollTop = 0;
  }, []);
  const navigate = useNavigate();
  const { openLoginModal } = useLoginModal();
  const { catalog, loading, error, refresh } = catalogState;
  const { account, auth, loading: accountLoading, error: accountError, refresh: refreshAccount } = accountState;
  const [chosenBillingMode, setBillingMode] = useState(initialSelection?.billingMode === "fixed" ? "fixed" : "recurring");
  const [chosenTerm, setTerm] = useState(initialSelection?.termMonths === 1 ? 1 : 12);
  const billingMode = selection?.billingMode || chosenBillingMode;
  const term = selection?.termMonths || chosenTerm;
  const membership = account?.membership;
  const hasGiftAccess = membership?.has_gift === true || membership?.access_source === "gift" ||
    account?.gifts?.some((gift) => ["active", "pending"].includes(gift.state));
  const openSubscription = account?.subscriptions?.some((item) =>
    ["active", "trialing", "past_due", "paused"].includes(item.status) && !item.cancel_at_period_end,
  );
  // Extend an existing paid term without starting another renewal contract.
  // Derive the mode during render so newly loaded membership never exposes a recurring SKU.
  const extendsCurrentTerm = membership?.status === "active" && !openSubscription && !hasGiftAccess;
  const selectedBillingMode = extendsCurrentTerm ? "fixed" : billingMode;
  const price = catalog?.prices?.find(
    (item) => item.billing_mode === selectedBillingMode && item.term_months === term,
  );
  const hasSelectedSku = typeof price?.sku === "string" && Boolean(price.sku.trim());
  const monthly = catalog?.prices?.find(
    (item) => item.billing_mode === selectedBillingMode && item.term_months === 1,
  );
  const annual = catalog?.prices?.find(
    (item) => item.billing_mode === selectedBillingMode && item.term_months === 12,
  );
  const currency = price?.currency || "USD";
  const savings = cloudAnnualSavings(monthly, annual);
  const launched = cloudCheckoutLaunched(catalog);
  const providerAvailable = catalog?.providers?.waffo;
  const paymentConflict = [...(account?.conflict_orders || []), ...(account?.pending_orders || [])]
    .some((order) => order.retry_payment_conflict_at);
  const hasCloud =
    membership &&
    ["active", "trial", "transition", "legacy_free"].includes(
      membership.status,
    );
  const trialUnavailable = membership?.trial_available === false;
  const trialAvailable = !auth?.signedIn || membership?.trial_available === true;
  const accountPending = Boolean(auth?.loading || (auth?.signedIn && (accountLoading || accountError || !membership)));
  const managesCurrentPlan = openSubscription || hasGiftAccess;
  const offersTrial = !hasCloud && !openSubscription && !hasGiftAccess && !trialUnavailable;
  const membershipExpiry = membership?.status === "transition" ? membership.transition_ends_at
    : membership?.status === "trial" ? membership.trial_ends_at
      : extendsCurrentTerm ? membership.expires_at : null;
  const purchaseLabel = copy(extendsCurrentTerm ? "cloud.action.renew" : selectedBillingMode === "fixed" ? "cloud.action.buy_pro" : "cloud.action.subscribe");
  const purchaseUnavailable = !hasSelectedSku || !launched || loading || error || accountPending || !providerAvailable || paymentConflict;
  useLayoutEffect(() => {
    if (!restoreFocus || restoredFocus.current || loading || accountPending) return;
    const action = proActionsRef.current?.querySelector("button:not([disabled]), a[href]");
    if (!action) return;
    action.focus();
    restoredFocus.current = true;
  }, [restoreFocus, loading, accountPending]);

  const checkout = (trial = false) => {
    if (!hasSelectedSku) return;
    const nextPath = beginCloudAction({ trial, sku: price?.sku, userId: auth?.signedIn ? auth.user?.id : null });
    if (!auth?.signedIn) {
      openLoginModal({
        nextPath,
        subtitle: copy(trial ? "cloud.login.trial_context" : "cloud.login.purchase_context"),
      });
      return;
    }
    navigate(nextPath);
  };

  if (catalog?.policy?.hosting_mode === "self_hosted" || membership?.status === "self_hosted") {
    return <SelfHostedCloudState />;
  }

  return (
    <div ref={pageRef} className="tt-cloud-theme flex flex-1 flex-col font-oai text-oai-black dark:text-oai-white">
      <main className="tt-cloud-layout relative isolate mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="tt-cloud-art" aria-hidden="true">
          <Hub className="tt-cloud-figure pointer-events-auto w-full translate-x-8" intensity={0.4} play tabIndex={-1} />
        </div>
        <header className="relative z-10 mb-9 max-w-xl">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{copy("cloud.page.title")}</h1>
          <p className="mt-3 text-base leading-7 text-oai-gray-500 dark:text-oai-gray-400">{copy("cloud.page.subtitle")}</p>
        </header>
        {paymentConflict ? <div className="mb-6"><CloudPaymentConflictNotice /></div> : null}
        <div className="tt-plan-grid relative z-10">
          <Card className="tt-plan-card" bodyClassName="tt-plan-body" onPointerMove={followPlanPointer}>
            <div>
              <div className="flex min-h-11 items-center gap-2.5">
                <Monitor size={19} className="text-oai-gray-500 dark:text-oai-gray-400" aria-hidden />
                <h2 className="text-lg font-semibold">{copy("cloud.free.title")}</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">{copy("cloud.free.subtitle")}</p>
            </div>
            <div className="border-b border-oai-gray-200 pb-6 pt-7 dark:border-oai-gray-800">
              <p className="text-3xl font-semibold tracking-tight sm:text-4xl">{copy("cloud.free.price")}</p>
              <p className="mt-3 text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">{copy("cloud.free.forever")}</p>
            </div>
            <PlanFeatures items={[
              copy("cloud.free.tracking"), copy("cloud.free.limits"), copy("cloud.free.desktop"),
              copy("cloud.free.exports"), copy("cloud.plan.local_community"),
            ]} />
            <div className="flex items-center border-t border-oai-gray-200 py-4 dark:border-oai-gray-800">
              <p className="text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">{copy("cloud.free.installations")}</p>
            </div>
            <Button as={Link} to={auth?.signedIn ? "/dashboard" : "/landing#download"} variant="secondary" className="w-full no-underline">{copy(auth?.signedIn ? "cloud.action.open_dashboard" : "cloud.free.cta")}</Button>
            <div aria-hidden />
          </Card>
          <Card className="tt-plan-card border-oai-gray-300 dark:border-oai-gray-600" bodyClassName="tt-plan-body" onPointerMove={followPlanPointer}>
            <div>
              <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h2 className="flex items-center gap-2.5 text-lg font-semibold"><Cloud size={19} className="text-oai-gray-500 dark:text-oai-gray-400" aria-hidden />{copy("cloud.plan.title")}</h2>
                <div role="group" aria-label={copy("cloud.selector.term")} className="tt-pro-period-control shrink-0">
                  <SegmentedControl options={[
                    { value: 1, label: copy("cloud.term.monthly") }, { value: 12, label: copy("cloud.term.yearly") },
                  ]} value={term} onChange={setTerm} />
                </div>
              </div>
              <p className="mt-2 text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">{copy("cloud.plan.subtitle")}</p>
            </div>
            <div className="border-b border-oai-gray-200 pb-6 pt-7 dark:border-oai-gray-800" aria-live="polite">
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">{price ? formatCloudMoney(price.amount_cents, currency) : copy("cloud.price.pending")}</span>
                <span className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy(term === 12 ? "cloud.price.per_year" : "cloud.price.per_month")}</span>
              </p>
              <p className="mt-3 text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">
                <span>{price ? term === 12
                    ? copy("cloud.plan.monthly_equivalent", { equivalent: formatCloudMoney(Math.round(price.amount_cents / 12), currency) })
                    : copy(selectedBillingMode === "fixed" ? "cloud.price.fixed_monthly_total" : "cloud.price.monthly_total", { total: formatCloudMoney(price.amount_cents, currency) })
                  : copy("cloud.price.waiting")}</span>
                {term === 12 && price && savings !== 0 ? <span> · {copy("cloud.price.savings", { percent: savings })}</span> : null}
              </p>
            </div>
            <PlanFeatures items={[
              copy("cloud.plan.anywhere"),
              copy("cloud.plan.sync", { minutes: catalog?.limits?.sync_minutes || 15 }),
              copy("cloud.plan.retained_history", { days: catalog?.limits?.hourly_history_days || 90, months: catalog?.limits?.daily_history_months || 24 }),
              copy("cloud.plan.identity"),
            ]} />
            <div className="border-t border-oai-gray-200 py-4 dark:border-oai-gray-800">
              {offersTrial ? (
                <p className="flex min-h-11 items-center text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("cloud.plan.trial_setup_hint")}
                </p>
              ) : null}
              {!offersTrial && extendsCurrentTerm ? (
                <p className="flex min-h-11 items-center text-sm font-medium">
                  {copy("cloud.billing_mode.fixed")}<span className="ml-2 text-xs font-normal text-oai-gray-500 dark:text-oai-gray-400">{copy("cloud.plan.renewal_off")}</span>
                </p>
              ) : null}
              {managesCurrentPlan ? (
                <p className="flex min-h-11 items-center text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
                  {cloudMembershipLabel(membership?.status)}
                </p>
              ) : null}
              {!offersTrial && !extendsCurrentTerm && !managesCurrentPlan ? <div className="flex items-center justify-between gap-3">
                <label htmlFor="pro-renewal-toggle" className="cursor-pointer text-sm font-medium">{copy("cloud.billing_mode.recurring")}<span className="ml-2 text-xs font-normal text-oai-gray-500 dark:text-oai-gray-400">{copy(billingMode === "recurring" ? "cloud.plan.renewal_hint" : "cloud.plan.renewal_off")}</span></label>
                <button id="pro-renewal-toggle" type="button" role="switch" aria-checked={billingMode === "recurring"} aria-label={copy("cloud.billing_mode.recurring")}
                  onClick={() => setBillingMode((value) => value === "recurring" ? "fixed" : "recurring")}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md">
                  <span aria-hidden className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${billingMode === "recurring" ? "bg-oai-gray-900 dark:bg-oai-gray-100" : "bg-oai-gray-300 dark:bg-oai-gray-700"}`}>
                    <span className={`h-3.5 w-3.5 rounded-full transition-transform motion-reduce:transition-none ${billingMode === "recurring" ? "translate-x-[19px] bg-white dark:bg-oai-gray-900" : "translate-x-[3px] bg-white"}`} />
                  </span>
                </button>
              </div> : null}
            </div>
            <div ref={proActionsRef}>
              {managesCurrentPlan ? <Button as={Link} to="/settings?section=cloud" className="w-full no-underline">{copy("cloud.action.manage_membership")}</Button> : null}
              {!managesCurrentPlan && offersTrial ? <Button type="button" onClick={() => checkout(true)} disabled={!hasSelectedSku || !launched || loading || error || accountPending || !trialAvailable || paymentConflict} className="w-full">
                  {copy("cloud.action.try", { days: catalog?.limits?.trial_days || 7 })}<ArrowRight size={16} className="ml-2" aria-hidden />
                </Button> : null}
              {!managesCurrentPlan && !offersTrial ? <Button type="button" onClick={() => checkout()} disabled={purchaseUnavailable} className="w-full">{purchaseLabel}<ArrowRight size={16} className="ml-2" aria-hidden /></Button> : null}
            </div>
            <div className={`text-center text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400 ${(!managesCurrentPlan && (hasCloud || trialUnavailable)) || hasGiftAccess ? "pt-3" : ""}`}>
              {!managesCurrentPlan && !hasCloud && trialUnavailable ? <p>{copy("cloud.trial.used_hint")}</p> : null}
              {hasCloud && !managesCurrentPlan ? <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                <span>{cloudMembershipLabel(membership?.status)}</span>
                {membershipExpiry ? <span>· {copy("cloud.membership.expires", { date: formatCloudDate(membershipExpiry) })}</span> : null}
                <Link to="/settings?section=cloud" className="inline-flex min-h-8 items-center underline underline-offset-4">{copy("cloud.action.manage_membership")}</Link>
              </div> : null}
              {hasGiftAccess ? <p>{copy("cloud.gift.error_active")}</p> : null}
            </div>
          </Card>
        </div>
        <div className="mt-5 space-y-3">
          {accountError ? <BillingNotice error={accountError} context="account" onRetry={refreshAccount} /> : null}
          {error ? <BillingNotice error={error} onRetry={refresh} /> : null}
          {!error && loading ? <BillingNotice>{copy("cloud.catalog.loading")}</BillingNotice> : null}
          {!error && !loading && !launched ? <BillingNotice>{copy("cloud.catalog.preview")}</BillingNotice> : null}
          {!error && !loading && launched && !providerAvailable ? <BillingNotice>{copy("cloud.catalog.provider_unavailable")}</BillingNotice> : null}
          {!error && !loading && launched && catalog?.environment === "sandbox" ? <BillingNotice>{copy("cloud.catalog.sandbox")}</BillingNotice> : null}
        </div>
        <section className="mt-8 rounded-xl border border-oai-gray-200 bg-white p-6 dark:border-oai-gray-800 dark:bg-oai-gray-900 md:p-7">
          <h2 className="mb-3 text-lg font-semibold">{copy("cloud.plan.faq_title")}</h2>
          <div className="divide-y divide-oai-gray-200 dark:divide-oai-gray-800">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
                {copy("cloud.plan.details_title")}<ChevronDown size={16} className="shrink-0 text-oai-gray-500 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
              </summary>
              <div className="max-w-2xl pb-5"><CloudFeatures limits={catalog?.limits} /><p className="mt-4 text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">{copy("cloud.feature.pro_identity")}</p></div>
            </details>
            {[
              [copy("cloud.faq.local_title"), copy("cloud.faq.local_body")],
              [copy("cloud.faq.cost_title"), copy("cloud.faq.cost_body")],
              [copy("cloud.faq.expiry_title"), copy("cloud.faq.expiry_body")],
              [copy("cloud.faq.platform_title"), copy("cloud.faq.platform_body")],
              [copy("cloud.faq.existing_title"), copy("cloud.faq.existing_body")],
            ].map(([title, body]) => <details key={title} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
                {title}<ChevronDown size={16} className="shrink-0 text-oai-gray-500 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
              </summary>
              <p className="max-w-2xl pb-5 text-sm leading-7 text-oai-gray-500 dark:text-oai-gray-400">{body}</p>
            </details>)}
          </div>
        </section>
        <section className="mt-6 flex flex-col gap-4 rounded-xl border border-oai-gray-200 bg-oai-gray-50 p-6 dark:border-oai-gray-800 dark:bg-oai-gray-900 sm:flex-row sm:items-center sm:justify-between md:p-7">
          <div className="max-w-xl">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Server size={16} aria-hidden />{copy("cloud.self_host.title")}</h2>
            <p className="mt-2 text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400">{copy("cloud.plan.self_host_summary")}</p>
          </div>
          <Button as={Link} to="/self-host" variant="secondary" className="shrink-0 self-start no-underline sm:self-auto">{copy("cloud.self_host.cta")}<ArrowRight size={16} className="ml-2" aria-hidden /></Button>
        </section>
        <footer className="mt-7 flex items-start justify-center gap-2 text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
          <ShieldCheck size={15} className="mt-0.5 shrink-0" aria-hidden />{copy("cloud.feature.privacy_detail")}
        </footer>
      </main>
    </div>
  );
}
