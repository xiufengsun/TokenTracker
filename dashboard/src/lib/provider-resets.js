// Provider-wide Claude Code / Codex limit resets, automatic or banked. Neither
// vendor's API exposes this history, so it comes from the third-party tracker
// claude-resets.com, fetched straight from the browser (it sends CORS `*`).

export const PROVIDER_RESETS_URL = "https://claude-resets.com/api/resets";
export const PROVIDER_RESETS_SOURCE_URL = "https://claude-resets.com";
export const RESET_PROVIDERS = ["claude", "codex"];
export const RESET_TYPE_BANKED = "banked";
export const RESET_TYPE_REGULAR = "regular";

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  // `policy` entries are limit changes (e.g. "weekly limits +50%"), not resets.
  if (raw.kind !== "reset") return null;
  const ms = Date.parse(raw.date);
  if (!Number.isFinite(ms)) return null;
  return {
    id: typeof raw.id === "string" ? raw.id : String(ms),
    date: new Date(ms).toISOString(),
    type: raw.resetType === RESET_TYPE_BANKED ? RESET_TYPE_BANKED : RESET_TYPE_REGULAR,
    scope: typeof raw.scope === "string" && raw.scope.trim() ? raw.scope.trim() : null,
    note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null,
    url: typeof raw.url === "string" && /^https:\/\//.test(raw.url) ? raw.url : null,
  };
}

/** Map the tracker payload to `{ claude: Event[], codex: Event[] }`, oldest first. */
export function normalizeProviderResets(payload) {
  const providers = payload?.providers;
  if (!providers || typeof providers !== "object") {
    throw new Error("Unexpected reset tracker response");
  }
  const out = {};
  for (const id of RESET_PROVIDERS) {
    const events = Array.isArray(providers[id]?.events) ? providers[id].events : [];
    out[id] = events
      .map(normalizeEvent)
      .filter(Boolean)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  }
  return out;
}

export async function fetchProviderResets({ fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(PROVIDER_RESETS_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`Reset tracker returned HTTP ${res.status}`);
  return normalizeProviderResets(await res.json());
}

function dayKeyFormatter(timeZone) {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-CA", timeZone ? { ...options, timeZone } : options);
  } catch {
    return new Intl.DateTimeFormat("en-CA", options);
  }
}

/** Group events by `YYYY-MM-DD` in `timeZone` (the heatmap's day buckets). */
export function groupResetsByDay(events, { timeZone } = {}) {
  const fmt = dayKeyFormatter(timeZone);
  const byDay = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const day = fmt.format(new Date(event.date));
    const bucket = byDay.get(day) || { regular: [], banked: [] };
    bucket[event.type === RESET_TYPE_BANKED ? "banked" : "regular"].push(event);
    byDay.set(day, bucket);
  }
  return byDay;
}
