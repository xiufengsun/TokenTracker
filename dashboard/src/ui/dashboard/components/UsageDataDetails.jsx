import React from "react";
import { copy } from "../../../lib/copy";
import { limitProviderName } from "../../../lib/limits-providers";

export function UsageDataDetails({ health }) {
  if (health?.status !== "partial") return null;
  const failed = (health.sources || []).filter((source) => {
    return source.status === "partial";
  });
  return (
    <details className="mb-4 rounded-lg border border-oai-gray-200 px-4 py-3 text-xs text-oai-gray-700 dark:border-oai-gray-800 dark:text-oai-gray-300">
      <summary className="cursor-pointer font-medium">{copy("sessions.coverage.partial")}</summary>
      <div className="mt-3 space-y-2 break-words">
        <p>{copy("usage.evidence.scope")}</p>
        {Boolean(health.skipped_units) && <p>{copy("usage.evidence.coverage", { skipped: health.skipped_units })}</p>}
        {Boolean(health.discovery_failed_units) && <p>{copy("usage.evidence.discovery", { failed: health.discovery_failed_units })}</p>}
        {failed.map((source) => (
          <p key={source.source}>{copy("sessions.coverage.source", { source: limitProviderName(source.source), failed: source.failed_units })}</p>
        ))}
      </div>
    </details>
  );
}
