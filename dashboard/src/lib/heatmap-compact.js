/** Next YYYY-MM-DD, treating the key as a UTC calendar day (same as the edge). */
function nextDayKey(dayKey) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 104 weeks is the edge's own `weeks` clamp; the guard is here so a malformed
// `to` cannot spin the grid loop forever.
const MAX_GRID_DAYS = 104 * 7 + 7;

/**
 * @param {unknown} payload a `tokentracker-account-heatmap` response.
 * @returns {unknown} the dense payload, or `payload` itself when it is not a
 *   well-formed compact response — which is also how a new CLI stays correct
 *   against an edge that predates the compact branch.
 */
export function expandHeatmapCompact(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (payload.format !== "compact") return payload;
  if (!Array.isArray(payload.days)) return payload;
  // Without the dictionary the indices resolve to nothing and every model
  // breakdown would render empty, so refuse the payload instead of silently
  // dropping data.
  if (!Array.isArray(payload.model_names)) return payload;
  if (!DAY_KEY_RE.test(String(payload.from)) || !DAY_KEY_RE.test(String(payload.to))) return payload;

  const names = payload.model_names;
  const byDay = new Map();
  for (const row of payload.days) {
    if (!Array.isArray(row)) continue;
    const [day, total, pairs] = row;
    if (!DAY_KEY_RE.test(String(day))) continue;
    const mdl = {};
    if (Array.isArray(pairs)) {
      // `i + 1 < length` drops a trailing index with no value rather than
      // recording it as 0.
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const name = names[pairs[i]];
        if (typeof name === "string") mdl[name] = Number(pairs[i + 1]) || 0;
      }
    }
    // Last row wins, as Map.set did on the edge.
    byDay.set(String(day), { total: Number(total) || 0, models: mdl });
  }

  const maxValue = Number(payload.max_value) || 0;
  const levelOf = (v) => {
    if (v <= 0) return 0;
    if (maxValue === 0) return 1;
    const r = v / maxValue;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  };

  const cells = [];
  const to = String(payload.to);
  let cursor = String(payload.from);
  while (cursor <= to && cells.length < MAX_GRID_DAYS) {
    const hit = byDay.get(cursor);
    const total = hit ? hit.total : 0;
    cells.push({
      day: cursor,
      total_tokens: total,
      billable_total_tokens: total,
      level: levelOf(total),
      models: hit ? hit.models : null,
    });
    cursor = nextDayKey(cursor);
  }

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return {
    from: payload.from,
    to: payload.to,
    week_starts_on: payload.week_starts_on,
    active_days: payload.active_days,
    streak_days: payload.streak_days,
    weeks,
  };
}

