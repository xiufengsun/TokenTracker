"use strict";

const { getPricingHealth } = require("./pricing");
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
// Allowlist the wire shape. Never send scanner exceptions, filenames or roots.
function sessionHealth(sessions, { from = "", to = "" } = {}) {
  const observed = sessions?.scanHealth;
  const skipped = Math.max(0, Number(sessions?.skippedFiles) || 0);
  const discoveryFailures = Array.isArray(sessions?.incompleteDirs) ? sessions.incompleteDirs.length : 0;
  let latest = null;
  for (const row of sessions || []) {
    const cutoff = iso(row.ended_at);
    if (cutoff && (!latest || cutoff > latest)) latest = cutoff;
  }
  const sources = Object.entries(observed?.sources || {}).filter(([source]) => /^[a-z][a-z0-9-]{0,40}$/.test(source)).map(([source, item]) => ({
    source, status: item.failed_units > 0 ? "partial" : item.status === "observed" ? "observed" : "not_observed",
    discovered_units: Math.max(0, Number(item.discovered_units) || 0), failed_units: Math.max(0, Number(item.failed_units) || 0),
  }));
  return { scope: "local_sessions", status: skipped > 0 || discoveryFailures > 0 || sources.some((item) => item.failed_units > 0) || sessions?.sidecarReadFailed ? "partial" : observed ? "observed" : "unknown",
    checked_at: iso(observed?.checked_at), latest_event_at: latest,
    // Latest observed event is not a completeness watermark.
    complete_through: null, malformed_records: null, skipped_units: skipped, discovery_failed_units: discoveryFailures, sources,
    range: { from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null, to: /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null },
    pricing: getPricingHealth(),
    comparison: { local: "local_session_inventory", cloud_account: "deduplicated_uploaded_account", leaderboard: "eligible_public_snapshot",
      cloud_cutoff: null, leaderboard_cutoff: null, reconciled: false },
  };
}
module.exports = { sessionHealth };
