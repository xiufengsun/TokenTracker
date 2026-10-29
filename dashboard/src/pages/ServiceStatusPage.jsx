import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { copy } from "../lib/copy";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";

// Official public status pages, browser-fetched directly (all endpoints ship
// `access-control-allow-origin: *`, verified per-host) — works identically on
// the deployed web app and the local dashboard, no CLI backend required.
//
// Three probe kinds:
//   statuspage — Statuspage.io/incident.io `/api/v2/status.json` (default)
//   instatus   — Instatus `/summary.json` (page.status UP/HASISSUES)
//   google     — Google's incidents.json feed, filtered by service name
//                (covers Gemini; Google products share one feed)
//
// Providers deliberately absent: Grok + DeepSeek front their status pages
// with bot checks (browser fetch gets 403/HTML), and z.ai / Kiro / Qoder /
// OpenCode expose no public status API at all. Only providers TokenTracker
// actually tracks belong here — this page explains "why is MY provider's
// data red", it is not a general status aggregator.
export const STATUS_PROVIDERS = [
  {
    id: "claude",
    name: "Claude",
    icon: "CLAUDE",
    // status.anthropic.com 302-redirects here; use the canonical host.
    apiUrl: "https://status.claude.com/api/v2/status.json",
    pageUrl: "https://status.claude.com",
  },
  {
    id: "openai",
    name: "OpenAI / Codex",
    icon: "CODEX",
    apiUrl: "https://status.openai.com/api/v2/status.json",
    pageUrl: "https://status.openai.com",
  },
  {
    id: "cursor",
    name: "Cursor",
    icon: "CURSOR",
    apiUrl: "https://status.cursor.com/api/v2/status.json",
    pageUrl: "https://status.cursor.com",
  },
  {
    id: "github",
    name: "GitHub / Copilot",
    icon: "GITHUB",
    apiUrl: "https://www.githubstatus.com/api/v2/status.json",
    pageUrl: "https://www.githubstatus.com",
  },
  {
    id: "gemini",
    name: "Gemini",
    icon: "GEMINI",
    kind: "google",
    serviceName: "Gemini",
    apiUrl: "https://www.google.com/appsstatus/dashboard/incidents.json",
    pageUrl: "https://www.google.com/appsstatus/dashboard",
  },
  {
    id: "kimi",
    name: "Kimi / Moonshot",
    icon: "KIMI",
    apiUrl: "https://status.moonshot.cn/api/v2/status.json",
    pageUrl: "https://status.moonshot.cn",
  },
  {
    id: "minimax",
    name: "MiniMax",
    icon: "MINIMAX",
    apiUrl: "https://status.minimaxi.com/api/v2/status.json",
    pageUrl: "https://status.minimaxi.com",
  },
  {
    id: "zed",
    name: "Zed",
    icon: "ZED",
    kind: "instatus",
    apiUrl: "https://status.zed.dev/summary.json",
    pageUrl: "https://status.zed.dev",
  },
  {
    id: "devin",
    name: "Devin / Cognition",
    icon: "DEVIN",
    // status.devin.ai 302-redirects here; use the canonical host directly.
    apiUrl: "https://www.devinstatus.com/api/v2/status.json",
    pageUrl: "https://www.devinstatus.com",
  },
  {
    id: "factory",
    name: "Factory / Droid",
    icon: "DROID",
    apiUrl: "https://status.factory.ai/api/v2/status.json",
    pageUrl: "https://status.factory.ai",
  },
];

const REFRESH_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;

const VALID_INDICATORS = new Set(["none", "minor", "major", "critical"]);

/** Tailwind classes per Statuspage indicator; `unknown` = probe failed. */
const INDICATOR_STYLES = {
  none: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  minor: { dot: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-400" },
  major: { dot: "bg-orange-500", text: "text-orange-600 dark:text-orange-400" },
  critical: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  unknown: { dot: "bg-oai-gray-400", text: "text-oai-gray-500 dark:text-oai-gray-400" },
};

function indicatorLabel(indicator) {
  switch (indicator) {
    case "none": return copy("status.state.none");
    case "minor": return copy("status.state.minor");
    case "major": return copy("status.state.major");
    case "critical": return copy("status.state.critical");
    default: return copy("status.state.unknown");
  }
}

/** Google incidents feed severity → Statuspage-style indicator. */
const GOOGLE_SEVERITY_TO_INDICATOR = {
  low: "minor",
  medium: "major",
  high: "critical",
};

/** Instatus active-incident impact → Statuspage-style indicator. */
const INSTATUS_IMPACT_TO_INDICATOR = {
  MAJOROUTAGE: "critical",
  PARTIALOUTAGE: "major",
  DEGRADEDPERFORMANCE: "minor",
};

/** Instatus `/summary.json`: page.status is UP/HASISSUES; impacts rank the worst. */
function parseInstatusSummary(body) {
  const pageStatus = body?.page?.status;
  if (typeof pageStatus !== "string") throw new Error("Unexpected payload");
  if (pageStatus === "UP") return { indicator: "none", description: "", updatedAt: null };
  const incidents = Array.isArray(body?.activeIncidents) ? body.activeIncidents : [];
  const rank = { critical: 3, major: 2, minor: 1 };
  let worst = null;
  for (const incident of incidents) {
    const indicator = INSTATUS_IMPACT_TO_INDICATOR[incident?.impact] || "minor";
    if (!worst || rank[indicator] > rank[worst.indicator]) {
      worst = { indicator, description: incident?.name || "", updatedAt: incident?.updated || null };
    }
  }
  // HASISSUES with no incident detail still means "something is wrong".
  return worst || { indicator: "minor", description: "", updatedAt: null };
}

/** Google feed: open incidents have no `end`; pick the most severe for the service. */
function parseGoogleIncidents(body, serviceName) {
  if (!Array.isArray(body)) throw new Error("Unexpected payload");
  const open = body.filter(
    (i) => i && !i.end && (i.service_name === serviceName ||
      (Array.isArray(i.affected_products) && i.affected_products.some((p) => p?.title === serviceName))),
  );
  if (open.length === 0) return { indicator: "none", description: "", updatedAt: null };
  const rank = { critical: 3, major: 2, minor: 1 };
  let worst = null;
  for (const incident of open) {
    const indicator = GOOGLE_SEVERITY_TO_INDICATOR[incident.severity] || "minor";
    if (!worst || rank[indicator] > rank[worst.indicator]) {
      worst = { indicator, description: incident.external_desc || "", updatedAt: incident.modified || null };
    }
  }
  return worst;
}

async function probeStatus(provider) {
  try {
    const res = await fetch(provider.apiUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (provider.kind === "google") {
      return parseGoogleIncidents(body, provider.serviceName);
    }
    if (provider.kind === "instatus") {
      return parseInstatusSummary(body);
    }
    const indicator = body?.status?.indicator;
    if (!VALID_INDICATORS.has(indicator)) throw new Error("Unexpected payload");
    return {
      indicator,
      description: typeof body?.status?.description === "string" ? body.status.description : "",
      updatedAt: typeof body?.page?.updated_at === "string" ? body.page.updated_at : null,
    };
  } catch {
    // CORS/network/timeout/parse failures all render the same "unreachable"
    // state — the status page being down is itself a (weak) signal.
    return { indicator: "unknown", description: "", updatedAt: null };
  }
}

function StatusCard({ provider, result }) {
  const style = INDICATOR_STYLES[result?.indicator] || INDICATOR_STYLES.unknown;
  const loading = result == null;
  return (
    <a
      href={provider.pageUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={copy("status.open_page", { provider: provider.name })}
      title={copy("status.open_page", { provider: provider.name })}
      className="group block no-underline text-inherit rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-4 sm:p-5 transition-colors hover:border-oai-gray-300 dark:hover:border-oai-gray-700 hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <ProviderIcon provider={provider.icon} size={20} />
          <span className="font-medium text-sm sm:text-base truncate">{provider.name}</span>
        </div>
        <span
          aria-hidden
          className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg text-oai-gray-400 transition-colors group-hover:text-oai-black dark:group-hover:text-white"
        >
          <ExternalLink className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {loading ? (
          <span className="h-2 w-2 rounded-full bg-oai-gray-300 dark:bg-oai-gray-700 animate-pulse" aria-hidden />
        ) : (
          <span className="relative flex h-2 w-2" aria-hidden>
            {result.indicator !== "none" && result.indicator !== "unknown" ? (
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${style.dot}`} />
            ) : null}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${style.dot}`} />
          </span>
        )}
        <span className={`text-sm font-medium ${loading ? "text-oai-gray-400" : style.text}`}>
          {loading ? copy("status.state.checking") : indicatorLabel(result.indicator)}
        </span>
      </div>
      {!loading && result.description && result.indicator !== "none" ? (
        <p className="mt-2 text-xs text-oai-gray-500 dark:text-oai-gray-400 break-words">
          {result.description}
        </p>
      ) : null}
    </a>
  );
}

export function ServiceStatusPage() {
  // provider id -> probe result (null while a first read is in flight)
  const [results, setResults] = useState({});
  const [checkedAt, setCheckedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const entries = await Promise.all(
      STATUS_PROVIDERS.map(async (p) => [p.id, await probeStatus(p)]),
    );
    if (!aliveRef.current) return;
    setResults(Object.fromEntries(entries));
    setCheckedAt(new Date());
    setRefreshing(false);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const checkedLabel = useMemo(() => {
    if (!checkedAt) return null;
    return copy("status.last_checked", { time: checkedAt.toLocaleTimeString() });
  }, [checkedAt]);

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-row items-start justify-between gap-4 mb-8">
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-oai-black dark:text-white mb-3">
                {copy("nav.service_status")}
              </h1>
              <p className="text-oai-gray-500 dark:text-oai-gray-400 text-sm sm:text-base">
                {copy("status.page.subtitle")}
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {checkedLabel ? (
                <span className="hidden sm:inline text-xs text-oai-gray-400 dark:text-oai-gray-500">
                  {checkedLabel}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                aria-label={copy("status.refresh")}
                title={copy("status.refresh")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {STATUS_PROVIDERS.map((p) => (
              <StatusCard key={p.id} provider={p} result={results[p.id] ?? null} />
            ))}
          </div>

          <p className="mt-6 text-xs text-oai-gray-400 dark:text-oai-gray-500">
            {copy("status.page.source_note")}
          </p>
        </div>
      </main>
    </div>
  );
}

export default ServiceStatusPage;
