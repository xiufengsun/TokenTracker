import React from "react";
import { Card } from "../../components";
import { copy } from "../../../lib/copy";
import { useQualityPerDollarPref } from "../../../hooks/use-quality-per-dollar-pref.js";
import { useQualityPerDollar } from "../../../hooks/use-quality-per-dollar";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";

function money(n) {
  if (n == null) return "—";
  if (n === 0) return "$0";
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function pct(rate) {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

// Calculate the average token cost per accepted outcome (PR).
// Highly intuitive alternative to raw Qual/$.
function avgCostPerAcc(cost_usd, accepted) {
  if (accepted == null || accepted === 0) return "—";
  if (cost_usd == null || cost_usd === 0) return "—";
  const perAcc = cost_usd / accepted;
  return perAcc < 1 ? `$${perAcc.toFixed(4)}` : `$${perAcc.toFixed(2)}`;
}

function Row({ row }) {
  const costPartial = row.cost_status === "partial";
  const costLabel = costPartial ? copy("usage.cost.partial") : money(row.cost_usd);
  return (
    <tr className="border-t border-oai-gray-100 dark:border-oai-gray-800/60 hover:bg-oai-gray-50/40 dark:hover:bg-oai-gray-800/10 transition-colors">
      <td className="py-2.5 pr-2 font-mono text-[11px] text-oai-gray-700 dark:text-oai-gray-300 truncate max-w-[80px] xs:max-w-[110px] sm:max-w-[140px]" title={row.key}>
        {row.key}
      </td>
      <td className="py-2.5 px-1.5 text-right tabular-nums text-oai-gray-600 dark:text-oai-gray-400">{costLabel}</td>
      <td className="py-2.5 px-1.5 text-right tabular-nums text-oai-gray-600 dark:text-oai-gray-400">
        {row.accepted}/{row.outcomes}
      </td>
      <td className="py-2.5 px-1.5 text-right tabular-nums text-oai-gray-600 dark:text-oai-gray-400">{pct(row.acceptance_rate)}</td>
      <td className="py-2.5 pl-2 pr-2 text-right tabular-nums font-semibold text-oai-black dark:text-oai-white">{costPartial ? copy("usage.cost.partial") : avgCostPerAcc(row.cost_usd, row.accepted)}</td>
    </tr>
  );
}

/**
 * Opt-in quality-per-dollar / Effective-Tokens card.
 *
 * Renders ONLY when both (a) the Labs toggle is on AND (b) the outcomes sidecar
 * actually has data (available && rows). Otherwise returns null so the
 * dashboard looks exactly as it does today. See GitHub issue 229.
 */
export function QualityPerDollarCard({ from, to, deviceId = null }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const { enabled } = useQualityPerDollarPref();
  const { data, loading } = useQualityPerDollar({ enabled, from, to, deviceId });

  if (!enabled) return null;
  const models = (data && data.available && Array.isArray(data.by_model) ? data.by_model : []).filter(
    (r) => r.outcomes > 0 && r.key !== "unknown",
  );
  if (!models.length) return null; // toggle on but no data → render nothing new

  const top = models.slice(0, 6);
  const totals = data.totals || {};
  const totalsCost = totals.cost_status === "partial"
    ? copy("usage.cost.partial")
    : money(totals.cost_usd);
  const subtitle = `${copy("qpd.card.subtitle")}${loading ? ` ${copy("qpd.card.updating")}` : ""}`;

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-medium text-oai-black dark:text-oai-white">{copy("qpd.card.title")}</h3>
        <span className="px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-oai-gray-500 bg-oai-gray-100 dark:text-oai-gray-400 dark:bg-oai-gray-800/80 rounded uppercase">
          {copy("qpd.card.badge")}
        </span>
      </div>
      <p className="mb-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">{subtitle}</p>

      <div className="w-full overflow-x-auto oai-scrollbar">
        <table className="w-full text-xs min-w-[340px] sm:min-w-0">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-oai-gray-400 dark:text-oai-gray-500">
              <th className="pb-1.5 pr-2 text-left font-medium">{copy("qpd.card.col_model")}</th>
              <th className="pb-1.5 px-1.5 text-right font-medium">{copy("qpd.card.col_cost")}</th>
              <th className="pb-1.5 px-1.5 text-right font-medium">{copy("qpd.card.col_accepted")}</th>
              <th className="pb-1.5 px-1.5 text-right font-medium">{copy("qpd.card.col_rate")}</th>
              <th className="pb-1.5 pl-2 pr-2 text-right font-medium" title={copy("qpd.card.qpd_tooltip")}>{copy("qpd.card.col_qpd")}</th>
            </tr>
          </thead>
          <tbody>
            {top.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-oai-gray-200 dark:border-oai-gray-800 pt-2.5 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
        <span>
          {copy("qpd.card.totals", {
            accepted: totals.accepted ?? 0,
            outcomes: totals.outcomes ?? 0,
            cost: totalsCost,
          })}
        </span>
        <span title={`${copy("qpd.card.et_tooltip")} · ${formatTokensTooltip(totals.effective_tokens)}`}>
          {copy("qpd.card.et", {
            tokens: formatTokens(totals.effective_tokens),
            rate: pct(totals.acceptance_rate),
          })}
        </span>
      </div>

      {totals.outcomes < 15 && (
        <p className="mt-3 text-[10px] text-oai-gray-400 dark:text-oai-gray-500 italic border-t border-oai-gray-100 dark:border-oai-gray-800/40 pt-2">
          * {copy("qpd.card.sparse_notice", "Tip: Spark outcomes dataset might skew Quality/$ ratios. For precise metrics, select a narrower time window.")}
        </p>
      )}
    </Card>
  );
}
