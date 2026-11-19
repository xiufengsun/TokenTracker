import React, { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { copy } from "../../../lib/copy";
import { formatCompactNumber, formatUsdCurrency } from "../../../lib/format";
import { sessionModels, sessionOwnCost, sessionOwnTokens, summarizeSessions } from "../../../lib/sessions-insights";
import { formatDuration, formatWhen } from "../../../lib/session-format";
import { useCurrency } from "../../../hooks/useCurrency";
import { useLocale } from "../../../hooks/useLocale";
import { ProviderIcon } from "./ProviderIcon.jsx";
import { SessionPerformance } from "./SessionPerformance.jsx";

const TOKEN_ROWS = [
  { key: "input_tokens", label: () => copy("dashboard.projects.detail.comp_input") },
  { key: "cached_input_tokens", label: () => copy("dashboard.projects.detail.comp_cached") },
  { key: "cache_creation_input_tokens", label: () => copy("dashboard.projects.detail.comp_cache_write") },
  { key: "output_tokens", label: () => copy("dashboard.projects.detail.comp_output") },
  { key: "reasoning_output_tokens", label: () => copy("dashboard.projects.detail.comp_reasoning") },
];

const SIGNAL_ROWS = [
  { key: "turns", label: () => copy("sessions.col.turns") },
  { key: "edit_turns", label: () => copy("sessions.col.edits") },
  { key: "retry_turns", label: () => copy("sessions.detail.retries") },
  { key: "subagent_calls", label: () => copy("sessions.card.subagents") },
  { key: "tool_calls", grokOnly: true, label: () => copy("sessions.detail.tools") },
  { key: "tool_failures", grokOnly: true, label: () => copy("sessions.detail.tool_failures") },
  { key: "error_count", grokOnly: true, label: () => copy("sessions.detail.errors") },
  { key: "model_calls", grokOnly: true, label: () => copy("sessions.detail.model_calls") },
  { key: "compaction_count", grokOnly: true, label: () => copy("sessions.detail.compactions") },
];

function costSourceLabel(source) {
  if (source === "provider_reported") return copy("sessions.detail.cost_reported");
  if (source === "model_pricing") return copy("sessions.detail.cost_estimated");
  if (source === "mixed") return copy("sessions.detail.cost_mixed");
  return copy("sessions.detail.cost_unknown");
}

function pricingSourceLabel(source) {
  if (String(source || "").startsWith("litellm")) return copy("sessions.detail.pricing_litellm");
  if (String(source || "").startsWith("curated")) return copy("sessions.detail.pricing_curated");
  return null;
}

function modelCostIsKnown(cost, reportedSingleModel) {
  return reportedSingleModel || Number(cost) > 0;
}

function Stat({ label, children }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4">
      <dt className="text-sm text-oai-gray-600 dark:text-oai-gray-300">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm tabular-nums text-oai-black dark:text-white">{children}</dd>
    </div>
  );
}

function Kpi({ label, title, className = "", children }) {
  return (
    <div className={`min-w-0 border-oai-gray-200 px-3 py-2.5 dark:border-oai-gray-800 ${className}`} title={title}>
      <dt className="truncate text-xs text-oai-gray-500 dark:text-oai-gray-400">{label}</dt>
      <dd className="mt-0.5 truncate text-base font-medium tabular-nums text-oai-black dark:text-white">{children}</dd>
    </div>
  );
}

export function SessionDetailModal({ session, subagents = [], onClose }) {
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  const { currency, rate } = useCurrency();
  const { resolvedLocale } = useLocale();
  const formatCost = (value) => formatUsdCurrency(value, { currency, rate });
  const models = sessionModels(session);
  const descendants = useMemo(() => summarizeSessions(subagents), [subagents]);
  const ownTokens = sessionOwnTokens(session);
  const usageUnavailable = session.usage_precision === "unavailable";
  const ownCost = sessionOwnCost(session);
  const subagentTokens = Number(session.subagent_total_tokens ?? descendants.tokens);
  const subagentCost = Number(session.subagent_cost_usd ?? descendants.cost);
  const performance = session.performance;
  const hasSpeed = Number(performance?.estimated_tokens_per_second) > 0 && Number(performance?.estimated_request_count) > 0;
  const hasFirstResponse = Number(performance?.first_response_sample_count) > 0
    && performance?.first_response_ms != null
    && Number.isFinite(Number(performance.first_response_ms));
  const firstResponseParams = hasFirstResponse ? {
    seconds: (Number(performance.first_response_ms) / 1000).toFixed(2),
    count: performance.first_response_sample_count,
  } : null;
  const hasReasoning = Number(session.reasoning_output_tokens) > 0;
  const isGrok = session.source === "grok";
  const isAntigravity = session.source === "antigravity";
  const signalIsRecorded = (key, grokOnly) => {
    if (isAntigravity) return key === "model_calls" ? !usageUnavailable : key === "turns" && session.turns > 0;
    return typeof session[key] === "number" && (!grokOnly || isGrok);
  };
  const contextAvailable = isGrok && Number(session.context_window_tokens) > 0;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), summary, [tabindex="0"]') || []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [onClose]);

  const hasSubagents = subagentTokens > 0 || subagentCost > 0;
  const combinedPartial = session.cost_is_partial || (hasSubagents && descendants.costIsPartial);
  // The headline numbers cover the whole thread; the breakdown below them only
  // appears when there is something to break down.
  const ledger = [
    { label: copy("sessions.detail.own"), tokens: ownTokens, cost: ownCost, partial: session.cost_is_partial },
    { label: copy("sessions.detail.subagents"), tokens: subagentTokens, cost: subagentCost, partial: descendants.costIsPartial },
  ];
  const title = session.agent_nickname || session.title || session.project_key || copy("sessions.project.unknown");
  const duration = formatDuration(session.duration_ms);
  const metaParts = [
    session.project_key && session.project_key !== title ? session.project_key : null,
    formatWhen(session.started_at, resolvedLocale),
    duration,
  ].filter(Boolean);
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/20 dark:bg-black/40"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={copy("sessions.detail.title")}
        tabIndex={-1}
        className="flex h-full w-full max-w-[36rem] flex-col border-l border-oai-gray-200 bg-white dark:border-oai-gray-800 dark:bg-oai-gray-950"
      >
        {/* A div, not a header element: the macOS app pads every header element by 36px. */}
        <div className="flex shrink-0 items-start gap-3 border-b border-oai-gray-200 px-5 py-4 dark:border-oai-gray-800">
          <span className="shrink-0 pt-0.5 text-oai-gray-600 dark:text-oai-gray-300">
            <ProviderIcon provider={String(session.source || "").toUpperCase()} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-base font-semibold leading-6 text-oai-black dark:text-white">{title}</h2>
            <p className="mt-0.5 break-words text-xs tabular-nums text-oai-gray-500 dark:text-oai-gray-400">{metaParts.join(" · ")}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={copy("sessions.detail.close")} className="-mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-oai-gray-500 hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white sm:h-9 sm:w-9">
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
          <section aria-label={copy("sessions.detail.consumption")}>
            <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-oai-gray-200 dark:border-oai-gray-800">
              <Kpi label={copy("sessions.col.tokens")}>{usageUnavailable ? copy("sessions.detail.not_recorded") : formatCompactNumber(ownTokens + subagentTokens)}</Kpi>
              <Kpi label={copy("sessions.col.cost")} className="border-l">{usageUnavailable ? copy("sessions.detail.not_recorded") : combinedPartial && ownCost + subagentCost === 0 ? copy("dashboard.cost_breakdown.unpriced_label") : <>{combinedPartial ? "≥" : ""}{formatCost(ownCost + subagentCost)}</>}</Kpi>
              <Kpi label={copy("sessions.summary.speed")} className="border-t" title={hasSpeed ? copy("sessions.performance.samples", { count: performance.estimated_request_count }) : copy("sessions.detail.no_speed")}>
                {hasSpeed ? <SessionPerformance performance={performance} /> : "—"}
              </Kpi>
              <Kpi label={copy("sessions.performance.first_response")} className="border-l border-t" title={copy("sessions.performance.first_response_method")}>
                {hasFirstResponse
                  ? (Number(performance.first_response_sample_count) === 1
                    ? copy("sessions.performance.first_response_value_single", firstResponseParams)
                    : copy("sessions.performance.first_response_value", firstResponseParams))
                  : "—"}
              </Kpi>
            </dl>
            {hasSubagents ? (
              <dl className="mt-3 space-y-1.5">
                {ledger.map((row) => (
                  <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_80px_88px] items-baseline gap-3 text-sm">
                    <dt className="text-oai-gray-600 dark:text-oai-gray-300">{row.label}</dt>
                    <dd className="text-right tabular-nums">{formatCompactNumber(row.tokens)}</dd>
                    <dd className="text-right tabular-nums">{row.partial && row.cost === 0 ? copy("dashboard.cost_breakdown.unpriced_label") : <>{row.partial ? "≥" : ""}{formatCost(row.cost)}</>}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="mt-3 text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
              {copy("sessions.detail.cost_source")} · {costSourceLabel(session.cost_source)}
              {session.cost_is_partial ? <span className="text-amber-700 dark:text-amber-300"> · {copy("sessions.cost.partial_title")}</span> : null}
              {session.usage_is_incomplete ? <span className="text-amber-700 dark:text-amber-300"> · {copy("sessions.badge.partial_usage")}</span> : null}
            </p>
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-medium text-oai-black dark:text-white">{copy("sessions.detail.tokens")}</h3>
            <dl className="mt-2 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
              {TOKEN_ROWS.map(({ key, label }) => <Stat key={key} label={label()}>{usageUnavailable ? copy("sessions.detail.not_recorded") : session[key] == null ? "—" : formatCompactNumber(session[key])}</Stat>)}
            </dl>
          </section>

          <section className="mt-6">
            <div className="grid grid-cols-[minmax(0,1fr)_80px_88px] items-baseline gap-3">
              <h3 className="text-sm font-medium text-oai-black dark:text-white">{copy("sessions.detail.models")}</h3>
              <span className="text-right text-xs text-oai-gray-500 dark:text-oai-gray-400" aria-hidden>{copy("sessions.col.tokens")}</span>
              <span className="text-right text-xs text-oai-gray-500 dark:text-oai-gray-400" aria-hidden>{copy("sessions.col.cost")}</span>
            </div>
            <ul className="mt-1 divide-y divide-oai-gray-100 dark:divide-oai-gray-800/70">
              {models.map((model) => {
                const unpriced = model.pricing?.status === "unpriced";
                const reportedSingleModel = session.cost_source === "provider_reported" && models.length === 1;
                const modelCost = reportedSingleModel ? ownCost : model.cost_usd;
                const hasKnownCost = modelCostIsKnown(modelCost, reportedSingleModel);
                return (
                  <li key={model.model} className="py-2.5">
                    <div className="grid grid-cols-[minmax(0,1fr)_80px_88px] items-baseline gap-3 text-sm">
                      <span className="min-w-0 break-words text-oai-black dark:text-white">{model.model || copy("sessions.model.unknown")}</span>
                      <span className="text-right tabular-nums">{usageUnavailable ? copy("sessions.detail.not_recorded") : formatCompactNumber(model.total_tokens)}</span>
                      <span className="text-right tabular-nums">{usageUnavailable ? copy("sessions.detail.not_recorded") : unpriced && !hasKnownCost ? "—" : formatCost(modelCost)}</span>
                    </div>
                    {/* Per-model speed and the pricing disclosure share one muted
                        line under the model so a single-model session stays two
                        lines tall. */}
                    {model.pricing ? (
                      <details className="group text-xs text-oai-gray-500 dark:text-oai-gray-400">
                        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 sm:min-h-0 sm:pt-1 [&::-webkit-details-marker]:hidden">
                          <SessionPerformance performance={model.performance} className="tabular-nums" />
                          <span className="underline decoration-dotted underline-offset-4 group-open:no-underline">{copy("sessions.detail.pricing_details")}</span>
                        </summary>
                        <div className="space-y-1 pt-1.5 leading-5">
                          {unpriced ? <p>{copy("sessions.detail.pricing_unpriced")}</p> : null}
                          {model.pricing.status === "free" ? <p>{copy("sessions.detail.pricing_free")}</p> : null}
                          {model.pricing.status === "priced" ? <p>{copy("sessions.detail.pricing_rates", { input: model.pricing.input, output: model.pricing.output, cacheRead: model.pricing.cache_read, cacheWrite: model.pricing.cache_write })}</p> : null}
                          {pricingSourceLabel(model.pricing.source) ? <p>{pricingSourceLabel(model.pricing.source)}</p> : null}
                        </div>
                      </details>
                    ) : <SessionPerformance performance={model.performance} className="block pt-1 text-xs tabular-nums text-oai-gray-500 dark:text-oai-gray-400" />}
                  </li>
                );
              })}
            </ul>
          </section>

          <details className="mt-5 border-t border-oai-gray-200 dark:border-oai-gray-800">
            <summary className="flex min-h-11 cursor-pointer items-center rounded text-sm font-medium text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-white">{copy("sessions.detail.signals")}</summary>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 pb-4 sm:grid-cols-2">
              {SIGNAL_ROWS.map(({ key, label, grokOnly }) => (
                <Stat key={key} label={label()}>{signalIsRecorded(key, grokOnly) ? formatCompactNumber(session[key]) : copy("sessions.detail.not_recorded")}</Stat>
              ))}
            </dl>
            {isGrok && session.usage_precision ? <p className="pb-3 text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">{copy("sessions.grok.runtime_breakdown", { calls: formatCompactNumber(session.model_calls), seconds: (Number(session.api_duration_ms || 0) / 1000).toFixed(1), tools: formatCompactNumber(session.tool_calls), errors: formatCompactNumber(session.error_count) })}</p> : null}
            {contextAvailable ? <p className="pb-3 text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">{copy("sessions.grok.context_breakdown", { used: formatCompactNumber(session.context_tokens_used), window: formatCompactNumber(session.context_window_tokens), percent: Number(session.context_usage_percent || 0).toFixed(0) })}</p> : null}
          </details>

          <details className="border-t border-oai-gray-200 dark:border-oai-gray-800">
            <summary className="flex min-h-11 cursor-pointer items-center rounded text-sm font-medium text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-white">{copy("sessions.detail.identifiers")}</summary>
            <dl className="space-y-3 pb-4">
              <div><dt className="text-xs text-oai-gray-600 dark:text-oai-gray-300">{copy("sessions.detail.session_id")}</dt><dd className="mt-1 break-all font-mono text-xs leading-5">{session.session_id || session.session_hash}</dd></div>
              {session.project_ref ? <div><dt className="text-xs text-oai-gray-600 dark:text-oai-gray-300">{copy("sessions.detail.local_path")}</dt><dd className="mt-1 break-all font-mono text-xs leading-5">{session.project_ref}</dd></div> : null}
              {session.resume_command ? <div><dt className="text-xs text-oai-gray-600 dark:text-oai-gray-300">{copy("sessions.detail.resume_command")}</dt><dd className="mt-1 break-all font-mono text-xs leading-5">{session.resume_command}</dd></div> : null}
            </dl>
          </details>

          <div className="mt-2 space-y-1.5 border-t border-oai-gray-200 pt-4 text-xs leading-5 text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
            {hasSpeed ? <p>{copy("sessions.performance.method")}</p> : null}
            {hasReasoning ? <p>{copy("sessions.detail.reasoning_note")}</p> : null}
            <p>{copy("sessions.privacy")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
