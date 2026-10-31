// OpenCode service-status probe.
//
// status.opencode.ai/api/status is OpenCode's official status feed — a custom
// JSON schema served without CORS headers, so the browser cannot read it and
// the local app relays it. Shape (verified against the live feed 2026-11-01):
//   { updatedAt: <ms epoch>, since, stale, status: "operational",
//     components: [{ service, status, reason, models, breakdown, speed }, ...] }
//
// Mapping to the Statuspage.io contract:
//   operational                    -> none
//   degraded / maintenance         -> minor
//   partial_outage                 -> major
//   major / full outage            -> critical
// Unknown non-operational statuses degrade to minor: report "something is
// wrong" rather than a false green. The reading is the worst of the top-level
// status and every component; anything we cannot parse throws, so callers fall
// back to last-good/unknown instead of inventing a false "operational".

const OPENCODE_STATUS_TO_INDICATOR = {
  operational: "none",
  degraded: "minor",
  degraded_performance: "minor",
  maintenance: "minor",
  under_maintenance: "minor",
  partial_outage: "major",
  major_outage: "critical",
  full_outage: "critical",
  outage: "critical",
};

const INDICATOR_RANK = { none: 0, minor: 1, major: 2, critical: 3 };

function statusToIndicator(status) {
  return OPENCODE_STATUS_TO_INDICATOR[String(status || "").toLowerCase()] || "minor";
}

/**
 * Parse the api/status payload into the Statuspage.io shape:
 *   { status: { indicator, description }, page: { updated_at } }
 * Throws when the payload is not understood.
 */
function parseOpenCodeStatusPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("OpenCode status: expected a JSON object");
  }
  if (typeof payload.status !== "string" || payload.status.length === 0) {
    throw new Error("OpenCode status: missing top-level status string");
  }
  const components = payload.components === undefined ? [] : payload.components;
  if (!Array.isArray(components)) {
    throw new Error("OpenCode status: components is not an array");
  }

  let worstIndicator = statusToIndicator(payload.status);
  let worstRank = INDICATOR_RANK[worstIndicator];
  const affected = [];
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    if (typeof component.service !== "string" || typeof component.status !== "string") {
      throw new Error("OpenCode status: malformed component entry");
    }
    const indicator = statusToIndicator(component.status);
    if (INDICATOR_RANK[indicator] > worstRank) {
      worstRank = INDICATOR_RANK[indicator];
      worstIndicator = indicator;
    }
    if (indicator !== "none" && component.service) affected.push(component.service);
  }

  const updatedAt = typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt) && payload.updatedAt > 0
    ? new Date(payload.updatedAt).toISOString()
    : undefined;

  return {
    status: {
      indicator: worstIndicator,
      description: affected.join("; "),
    },
    page: { updated_at: updatedAt },
  };
}

module.exports = {
  parseOpenCodeStatusPayload,
};
