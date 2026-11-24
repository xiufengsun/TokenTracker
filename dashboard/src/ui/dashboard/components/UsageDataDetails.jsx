import React from "react";
import { copy } from "../../../lib/copy";

// Kept as non-mounted scan-health copy plumbing. The dashboard and sessions UI no longer render this disclosure.
export function UsageDataDetails({ health }) {
  const unknown = copy("usage.evidence.unknown");
  const date = (value) => { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : unknown; };
  return (
    <details className="mb-4 rounded-lg border border-oai-gray-200 px-4 py-3 text-xs text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
      <summary className="cursor-pointer font-medium">{copy("usage.evidence.title")}</summary>
      <div className="mt-3 space-y-2 break-words">
        <p>{copy("usage.evidence.scope")}</p>
        <p>{copy("usage.evidence.checked", { time: date(health?.checked_at) })}</p>
        <p>{copy("usage.evidence.latest", { time: date(health?.latest_event_at) })}</p>
        <p>{copy("usage.evidence.complete", { time: date(health?.complete_through) })}</p>
        <p>{copy("usage.evidence.coverage", { skipped: health?.skipped_units ?? unknown })}</p>
        <p>{copy("usage.evidence.discovery", { failed: health?.discovery_failed_units ?? unknown })}</p>
        {health?.sources?.map((source) => (
          <p key={source.source}>{copy("usage.evidence.source", { source: source.source, status: copy(source.status === "partial" ? "usage.evidence.partial" : source.status === "observed" ? "usage.evidence.observed" : "usage.evidence.not_observed") })}</p>
        ))}
        <p>{copy("usage.evidence.pricing", { status: health?.pricing?.status || unknown, time: date(health?.pricing?.fetched_at) })}</p>
        <p>{copy("usage.evidence.comparison")}</p>
      </div>
    </details>
  );
}
