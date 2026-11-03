// DeepSeek service-status probe.
//
// status.deepseek.com is a Flashcat(快猫)-hosted Next.js app. Unlike Statuspage.io
// it exposes no public JSON API and sends no CORS headers, so a browser cannot
// read it directly. The page state is, however, inlined in the server render as
// React Server Component "flight" data: the client script pushes JSON chunks via
// self.__next_f.push([1, "<json string>"]). We concatenate those chunks and read
// the single machine-readable signal — the live `active_changes` array.
//
// Semantics (Flashcat change status -> Statuspage.io indicator):
//   operational                                      -> none
//   degraded / degraded_performance / maintenance    -> minor
//   partial_outage                                   -> major
//   major_outage / full_outage                       -> critical
// An empty active_changes array means everything is operational. Anything we
// cannot parse throws, so the caller falls back instead of inventing "all good".

const DEEPSEEK_STATUS_URL = "https://status.deepseek.com/";

const RSC_PUSH_RE = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;

const CHANGE_STATUS_TO_INDICATOR = {
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

function extractFlight(html) {
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("DeepSeek status: expected an HTML document");
  }
  let flight = "";
  let chunks = 0;
  RSC_PUSH_RE.lastIndex = 0;
  let match;
  while ((match = RSC_PUSH_RE.exec(html))) {
    try {
      flight += JSON.parse(match[1]);
    } catch (_error) {
      throw new Error("DeepSeek status: malformed RSC chunk");
    }
    chunks += 1;
  }
  if (chunks === 0) {
    throw new Error("DeepSeek status: no RSC data found");
  }
  return flight;
}

// Return the balanced JSON array that starts at `start` (a '[' in flight).
function sliceJsonArray(flight, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < flight.length; i += 1) {
    const ch = flight[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return flight.slice(start, i + 1);
    }
  }
  throw new Error("DeepSeek status: unterminated active_changes array");
}

function readUpdatedAt(flight) {
  const match = /"initialDataUpdatedAt":(\d{10,})/.exec(flight);
  if (!match) return undefined;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Parse the status.deepseek.com HTML into a Statuspage.io-shaped payload:
 *   { status: { indicator, description }, page: { updated_at } }
 * Throws when the page structure is not understood, so callers fall back
 * instead of reporting a false "operational".
 */
function parseDeepSeekStatusPage(html) {
  const flight = extractFlight(html);
  const marker = '"active_changes":';
  const markerIndex = flight.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error("DeepSeek status: active_changes not found");
  }
  // The value must be an array. If upstream ever reports null / an object /
  // anything else, refuse to guess a healthier-looking array further along the
  // document — throwing keeps the caller on its last-good / "unknown" path
  // instead of inventing a false "operational".
  let arrayStart = markerIndex + marker.length;
  while (arrayStart < flight.length && /\s/.test(flight[arrayStart])) arrayStart += 1;
  if (flight[arrayStart] !== "[") {
    throw new Error("DeepSeek status: active_changes is not an array");
  }
  let changes;
  try {
    changes = JSON.parse(sliceJsonArray(flight, arrayStart));
  } catch (error) {
    throw new Error("DeepSeek status: cannot parse active_changes (" + error.message + ")");
  }
  if (!Array.isArray(changes)) {
    throw new Error("DeepSeek status: active_changes is not an array");
  }

  const updatedAt = readUpdatedAt(flight);
  if (changes.length === 0) {
    return { status: { indicator: "none", description: "" }, page: { updated_at: updatedAt } };
  }

  let worstIndicator = "none";
  let worstRank = -1;
  let descriptions = [];
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    const rawStatus = String(change.status || change.change_status || change.impact || "").toLowerCase();
    const indicator = CHANGE_STATUS_TO_INDICATOR[rawStatus] || "minor";
    const rank = INDICATOR_RANK[indicator];
    const description = typeof change.name === "string" ? change.name
      : typeof change.title === "string" ? change.title
      : typeof change.description === "string" ? change.description
      : "";
    if (rank > worstRank) {
      worstRank = rank;
      worstIndicator = indicator;
      descriptions = description ? [description] : [];
    } else if (rank === worstRank && description) {
      descriptions.push(description);
    }
  }
  // A non-empty array with no readable change is still "something is wrong".
  if (worstRank < 0) worstIndicator = "minor";

  return {
    status: { indicator: worstIndicator, description: descriptions.join("; ") },
    page: { updated_at: updatedAt },
  };
}

module.exports = {
  parseDeepSeekStatusPage,
  DEEPSEEK_STATUS_URL,
};
