import React, { useSyncExternalStore } from "react";
import { Cloud, X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { copy } from "../../lib/copy";
import { beginCloudAction } from "../../lib/cloud-action-intent.js";
import {
  cloudContextualPromptDecision,
  cloudDeadlinePromptDecision,
  cloudPromptRevision,
  dismissCloudPrompt,
  readCloudPromptState,
  subscribeCloudPrompts,
} from "../../lib/cloud-prompt-policy.js";
import { Button } from "../../ui/components/Button.jsx";
import { formatCloudDate } from "./CloudBillingParts.jsx";

export function useCloudPromptState(userId) {
  useSyncExternalStore(subscribeCloudPrompts, cloudPromptRevision, () => 0);
  return readCloudPromptState(userId);
}

function PromptPanel({ userId, decision, onContinueLocal, localHost, onTrialClick }) {
  if (!decision) return null;
  const deadline = decision.kind === "deadline";
  return (
    <section className="tt-cloud-theme rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-4 dark:border-oai-gray-800 dark:bg-oai-gray-900" aria-label={copy("cloud.prompt.label")}>
      <div className="flex items-start gap-3">
        <Cloud size={17} className="mt-0.5 shrink-0 text-oai-gray-600 dark:text-oai-gray-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-6 text-oai-gray-700 dark:text-oai-gray-200">
            {copy(decision.bodyKey, deadline ? { date: formatCloudDate(decision.date) } : undefined)}
          </p>
          {!deadline ? <p className="mt-2 text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy("cloud.prompt.free")}</p> : null}
          {!deadline ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button as={Link} to={onTrialClick ? "/cloud" : decision.href} onClick={onTrialClick} variant="secondary" className="no-underline">
                {copy(decision.ctaKey)}
              </Button>
              {localHost && onContinueLocal ? (
                <Button onClick={onContinueLocal} variant="ghost">{copy("cloud.prompt.local")}</Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <button type="button" onClick={() => dismissCloudPrompt(userId, decision.scene)}
          aria-label={copy("cloud.prompt.dismiss")}
          className="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-md text-oai-gray-500 hover:bg-oai-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-gray-500 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800">
          <X size={16} aria-hidden />
        </button>
      </div>
    </section>
  );
}

export function CloudContextualPrompt({ userId, panel = "dashboard", onContinueLocal, localHost = false, className }) {
  const navigate = useNavigate();
  const state = useCloudPromptState(userId);
  const intentional = Boolean(state.intent && (panel !== "sync" || state.intent === "sync"));
  const decision = cloudContextualPromptDecision({ ...state, userId, scene: state.intent, intentional });
  if (!decision) return null;
  const onTrialClick = decision.kind === "promotion" && decision.ctaKey === "cloud.prompt.try" ? (event) => {
    // Modified clicks retain the ordinary plans link and create no action.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const current = readCloudPromptState(userId);
    const currentDecision = cloudContextualPromptDecision({ ...current, userId, scene: current.intent,
      intentional: Boolean(current.intent && (panel !== "sync" || current.intent === "sync")) });
    const prices = Array.isArray(current.catalog?.prices) ? current.catalog.prices.filter((price) =>
      typeof price?.sku === "string" && price.sku.trim() && Number.isFinite(price.amount_cents) && price.amount_cents > 0 &&
      ["USD", "CNY"].includes(price.currency) && [1, 12].includes(price.term_months) && ["recurring", "fixed"].includes(price.billing_mode),
    ) : [];
    const price = prices.find((item) => item.term_months === 12 && item.billing_mode === "recurring") || prices[0];
    navigate(currentDecision?.ctaKey === "cloud.prompt.try" && price
      ? beginCloudAction({ trial: true, sku: price.sku, userId }) : "/cloud");
  } : undefined;
  const content = <PromptPanel userId={userId} decision={decision} onContinueLocal={onContinueLocal} localHost={localHost} onTrialClick={onTrialClick} />;
  if (className) { return <div className={className}>{content}</div>; }
  return content;
}

export function CloudDeadlinePrompt({ userId, membership, subscriptions, className }) {
  useCloudPromptState(userId);
  const decision = cloudDeadlinePromptDecision({ userId, membership, subscriptions });
  if (!decision) return null;
  const content = <PromptPanel userId={userId} decision={decision} />;
  if (className) { return <div className={className}>{content}</div>; }
  return content;
}
