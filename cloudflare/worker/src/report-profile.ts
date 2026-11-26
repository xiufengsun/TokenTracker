import { accountUsage, reportClock } from "./report-usage";
import { publicRowCost as computeRowCost } from "./report-public-pricing";
import {
  fullBadges,
  proBadges as queryProBadges,
  snapshotBounds,
  snapshotRow,
} from "./report-public";
import { reportJson as json } from "./report-account";
const KNOWN_SOURCES = new Set([
  "acode",
  "codex",
  "claude",
  "gemini",
  "cursor",
  "opencode",
  "openclaw",
  "hermes",
  "kiro",
  "copilot",
  "pi-anthropic",
  "pi-github-copilot",
  "pi-copilot",
  "kimi",
  "droid",
  "dumate",
]);
function canonicalSource(s: string) {
  return KNOWN_SOURCES.has(s) ? s : "other";
}

function normalizeTimeZone(value: string | null): string | null {
  const timeZone = value?.trim();
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return null;
  }
}

function normalizeTimeZoneOffset(value: string | null): number | null {
  if (value == null || value === "") return null;
  const offset = Number(value);
  if (!Number.isFinite(offset) || Math.abs(offset) > 14 * 60) return null;
  return Math.trunc(offset);
}

function zonedDayKey(
  date: Date,
  timeZone: string | null,
  offsetMinutes: number | null,
): string {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  }
  const shifted =
    offsetMinutes == null
      ? date
      : new Date(date.getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function addCalendarDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function windowBoundsForPeriod(
  period: string,
  todayDay: string,
): { from_day: string; to_day: string } {
  const now = new Date(`${todayDay}T00:00:00Z`);
  if (period === "week") {
    const d = new Date(now);
    d.setUTCDate(
      d.getUTCDate() - ((d.getUTCDay() + 6) % 7),
    ) /* ISO Mon-start, matches leaderboard-refresh+dashboard */;
    const from = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6);
    return { from_day: from, to_day: d.toISOString().slice(0, 10) };
  }
  if (period === "month") {
    const from = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const to = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    )
      .toISOString()
      .slice(0, 10);
    return { from_day: from, to_day: to };
  }
  // total: use heatmap range (365 days) — caller uses this same bound for trend
  const heatmapStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 364);
  return {
    from_day: heatmapStart.toISOString().slice(0, 10),
    to_day: todayDay,
  };
}

/** Compute current & longest consecutive-day streaks within a date set. */
function computeStreak(
  daysWithActivity: Set<string>,
  todayDay: string,
): { current_days: number; longest_days: number } {
  const todayUTC = new Date(`${todayDay}T00:00:00Z`);
  // Current: start from today; if today has nothing, allow yesterday as starting point.
  let cursor = new Date(todayUTC);
  let current = 0;
  if (!daysWithActivity.has(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  while (daysWithActivity.has(cursor.toISOString().slice(0, 10))) {
    current += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  // Longest: walk all days chronologically.
  const sorted = Array.from(daysWithActivity).sort();
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const d of sorted) {
    const dt = new Date(d + "T00:00:00Z");
    if (prev && dt.getTime() - prev.getTime() === 86_400_000) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
    prev = dt;
  }
  return { current_days: current, longest_days: longest };
}

// ─────────────────────────── Main handler ──────────────────────────
// deno-lint-ignore no-explicit-any
export async function profileReport(
  req: Request,
  db: D1Database,
  caller: string | null,
  blocked: Set<string>,
) {
  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");
  const periodInput = url.searchParams.get("period") || "week";
  const period = ["week", "month", "total"].includes(periodInput)
    ? periodInput
    : "week";
  const timeZone = normalizeTimeZone(url.searchParams.get("tz"));
  const timeZoneOffsetMinutes = normalizeTimeZoneOffset(
    url.searchParams.get("tz_offset_minutes"),
  );
  const now = new Date();
  const todayDay = zonedDayKey(now, timeZone, timeZoneOffsetMinutes);
  if (!userId) return json({ error: "user_id is required" }, 400);
  if (blocked.has(userId.toLowerCase()))
    return json({ error: "Not found" }, 404);

  const isSelf = caller === userId;
  if (url.searchParams.get("view") === "badges") {
    if (!isSelf) return json({ error: "Forbidden" }, 403);
    return json({
      badges: await fullBadges(db, userId, true),
      badges_include_unearned: true,
    });
  }
  if (
    !isSelf &&
    !(await db
      .prepare(
        "SELECT 1 FROM tokentracker_leaderboard_snapshots WHERE user_id=? LIMIT 1",
      )
      .bind(userId)
      .first())
  ) {
    return json({ error: "Not found" }, 404);
  }
  const settings = (await db
    .prepare(
      "SELECT leaderboard_anonymous,show_github_url,github_url FROM tokentracker_user_settings WHERE user_id=?",
    )
    .bind(userId)
    .first<{
      leaderboard_anonymous: number;
      show_github_url: number;
      github_url: string | null;
    }>()) ?? { leaderboard_anonymous: 0, show_github_url: 0, github_url: null };
  const profile = (await db
    .prepare(
      "SELECT display_name,avatar_url FROM tokentracker_user_profiles WHERE user_id=?",
    )
    .bind(userId)
    .first<{ display_name: string | null; avatar_url: string | null }>()) ?? {
    display_name: null,
    avatar_url: null,
  };
  const badges = await fullBadges(db, userId, isSelf);
  const proBadges = await queryProBadges(db, [userId]);
  const periodBounds = windowBoundsForPeriod(period, todayDay);
  const sb = await snapshotBounds(db, period);
  const snap = await snapshotRow(db, userId, period, sb.from_day, sb.to_day);
  const heatmapEndDay = addCalendarDays(todayDay, 1),
    heatmapStartDay = addCalendarDays(heatmapEndDay, -365);
  const periodEndDay = addCalendarDays(periodBounds.to_day, 1);
  const scanStartDay =
    heatmapStartDay < periodBounds.from_day
      ? heatmapStartDay
      : periodBounds.from_day;
  const scanEndDay =
    heatmapEndDay > periodEndDay ? heatmapEndDay : periodEndDay;
  const hasDevice = await db
    .prepare(
      "SELECT 1 FROM tokentracker_devices WHERE user_id=? AND revoked_at IS NULL LIMIT 1",
    )
    .bind(userId)
    .first();
  const clock = reportClock(
    timeZone,
    timeZoneOffsetMinutes === null ? null : String(timeZoneOffsetMinutes),
  );
  const groupedRows = await accountUsage(
    db,
    userId,
    null,
    scanStartDay,
    addCalendarDays(scanEndDay, -1),
    "day",
    clock,
    !hasDevice,
  );
  const heatmapByDay = new Map<string, number>();
  // Per-day model breakdown for the hover tooltip. Same shape the dashboard
  // ActivityHeatmap consumes (cell.models = { [model_name]: tokens }).
  const heatmapModelsByDay = new Map<string, Map<string, number>>();
  const periodByDay = new Map<string, number>();
  const periodByDayCost = new Map<string, number>();
  const periodByProvider = new Map<string, { tokens: number; cost: number }>();
  const periodByModel = new Map<string, number>();
  const modelBreakdown = new Map<string, Record<string, number | string>>();
  let periodTotalTokens = 0;
  let periodTotalCost = 0;

  for (const row of groupedRows) {
    const day = String(row.bucket || "");
    if (!day) continue;
    const tokens = Number(row.total_tokens) || 0;
    const cost = computeRowCost(row);
    if (day >= heatmapStartDay && day < heatmapEndDay) {
      heatmapByDay.set(day, (heatmapByDay.get(day) || 0) + tokens);
      if (row.model && tokens > 0) {
        let dayModels = heatmapModelsByDay.get(day);
        if (!dayModels) {
          dayModels = new Map();
          heatmapModelsByDay.set(day, dayModels);
        }
        dayModels.set(row.model, (dayModels.get(row.model) || 0) + tokens);
      }
    }
    if (day >= periodBounds.from_day && day < periodEndDay) {
      periodByDay.set(day, (periodByDay.get(day) || 0) + tokens);
      periodByDayCost.set(day, (periodByDayCost.get(day) || 0) + cost);
      const src = canonicalSource(row.source);
      const provider = periodByProvider.get(src) || { tokens: 0, cost: 0 };
      provider.tokens += tokens;
      provider.cost += cost;
      periodByProvider.set(src, provider);
      if (row.model)
        periodByModel.set(
          row.model,
          (periodByModel.get(row.model) || 0) + tokens,
        );
      if (row.model) {
        const detail = modelBreakdown.get(row.model) || {
          model_name: row.model,
          total_tokens: 0,
          estimated_cost_usd: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_output_tokens: 0,
        };
        detail.total_tokens = Number(detail.total_tokens) + tokens;
        detail.estimated_cost_usd = Number(detail.estimated_cost_usd) + cost;
        for (const key of [
          "input_tokens",
          "output_tokens",
          "cached_input_tokens",
          "cache_creation_input_tokens",
          "reasoning_output_tokens",
        ] as const) {
          detail[key] = Number(detail[key]) + (Number(row[key]) || 0);
        }
        modelBreakdown.set(row.model, detail);
      }
      periodTotalTokens += tokens;
      periodTotalCost += cost;
    }
  }

  // best_day in period. A grouped zero row is not activity and must not turn
  // an otherwise empty profile into a synthetic "best" day.
  let bestDay: {
    date: string;
    total_tokens: number;
    estimated_cost_usd: number;
  } | null = null;
  for (const [day, tokens] of periodByDay.entries()) {
    if (tokens <= 0) continue;
    if (!bestDay || tokens > bestDay.total_tokens) {
      bestDay = {
        date: day,
        total_tokens: tokens,
        estimated_cost_usd: periodByDayCost.get(day) || 0,
      };
    }
  }

  // favorite_model
  let favoriteModel: { model_name: string; total_tokens: number } | null = null;
  for (const [model, tokens] of periodByModel.entries()) {
    if (!favoriteModel || tokens > favoriteModel.total_tokens) {
      favoriteModel = { model_name: model, total_tokens: tokens };
    }
  }

  // streak (over period — set of active day strings)
  const activeDaySet = new Set(
    Array.from(periodByDay.entries())
      .filter(([, tokens]) => tokens > 0)
      .map(([day]) => day),
  );
  const streak = computeStreak(activeDaySet, todayDay);

  // daily_trend (period, dense — include 0 days so frontend can chart cleanly)
  const dailyTrend: Array<{ date: string; total_tokens: number }> = [];
  for (
    let cur = new Date(`${periodBounds.from_day}T00:00:00Z`);
    cur < new Date(`${periodEndDay}T00:00:00Z`);
    cur.setUTCDate(cur.getUTCDate() + 1)
  ) {
    const day = cur.toISOString().slice(0, 10);
    dailyTrend.push({ date: day, total_tokens: periodByDay.get(day) || 0 });
  }
  // heatmap (365d dense). `models` powers the dashboard ActivityHeatmap's
  // per-cell model breakdown tooltip. Days with no activity get no models
  // key (the heatmap component already handles that gracefully).
  const heatmap: Array<{
    date: string;
    total_tokens: number;
    models?: Record<string, number>;
  }> = [];
  for (
    let cur = new Date(`${heatmapStartDay}T00:00:00Z`);
    cur < new Date(`${heatmapEndDay}T00:00:00Z`);
    cur.setUTCDate(cur.getUTCDate() + 1)
  ) {
    const day = cur.toISOString().slice(0, 10);
    const cell: {
      date: string;
      total_tokens: number;
      models?: Record<string, number>;
    } = {
      date: day,
      total_tokens: heatmapByDay.get(day) || 0,
    };
    const dayModels = heatmapModelsByDay.get(day);
    if (dayModels && dayModels.size > 0) {
      cell.models = Object.fromEntries(dayModels);
    }
    heatmap.push(cell);
  }

  // by_provider sorted desc with percent
  const byProvider = Array.from(periodByProvider.entries())
    .map(([source, v]) => ({
      source,
      total_tokens: v.tokens,
      estimated_cost_usd: v.cost,
      percent: periodTotalTokens > 0 ? v.tokens / periodTotalTokens : 0,
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);

  const activeDays = activeDaySet.size;
  const periodDayCount = dailyTrend.length || 1;
  const avgPerDayUsd = periodTotalCost / periodDayCount;

  const isAnonymous = Boolean(settings.leaderboard_anonymous);
  const displayName = isAnonymous
    ? "Anonymous"
    : profile.display_name || snap?.display_name || "";
  const avatarUrl = isAnonymous
    ? null
    : profile.avatar_url || snap?.avatar_url || null;
  const githubUrl =
    !isAnonymous && settings.show_github_url
      ? settings.github_url || null
      : null;

  return json({
    user: {
      user_id: userId,
      display_name: displayName,
      avatar_url: avatarUrl,
      github_url: githubUrl,
      is_anonymous: isAnonymous,
      pro_active: !isAnonymous && proBadges.has(userId),
      rank: snap?.rank ?? null,
    },
    period: {
      kind: period,
      from: periodBounds.from_day,
      to: periodBounds.to_day,
      time_zone: timeZone,
      time_zone_offset_minutes: timeZoneOffsetMinutes,
      generated_at: snap?.generated_at || new Date().toISOString(),
    },
    totals: {
      // Only the two headline totals use the ranked lifetime snapshot. Activity,
      // daily averages and breakdowns remain bounded by the returned period.
      source: period === "total" ? "leaderboard_snapshot" : "activity_window",
      total_tokens:
        period === "total"
          ? snap?.total_tokens == null
            ? null
            : Number(snap.total_tokens)
          : periodTotalTokens,
      estimated_cost_usd:
        period === "total"
          ? snap?.estimated_cost_usd == null
            ? null
            : Number(snap.estimated_cost_usd)
          : periodTotalCost,
      active_days: activeDays,
      avg_per_day_usd: avgPerDayUsd,
    },
    streak,
    best_day: bestDay,
    models: {
      count: periodByModel.size,
      favorite: favoriteModel,
      breakdown: [...modelBreakdown.values()].sort(
        (a, b) => Number(b.total_tokens) - Number(a.total_tokens),
      ),
    },
    by_provider: byProvider,
    heatmap,
    daily_trend: dailyTrend,
    badges,
    badges_include_unearned: isSelf,
  });
}
