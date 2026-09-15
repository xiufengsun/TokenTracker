/**
 * InsForge Edge: full profile embed SVG.
 *
 * Returns a 600×180 profile card (dark/light themes) suitable for embedding
 * in tweets, Notion pages, GitHub READMEs, personal sites — anywhere an SVG
 * <img> tag works. Self-contained: no external font dependencies, no fetched
 * avatar (we render a colored initial circle from display_name).
 *
 * Usage:
 *   <img src="https://<insforge>/functions/tokentracker-embed-svg?user_id=<uuid>" />
 *
 * Query params:
 *   user_id  (required) UUID
 *   theme    light | dark             (default: light)
 *   period   week | month | total     (default: total)
 *
 * Privacy: gates on `is_public=true` (the same opt-in that the leaderboard
 * profile endpoint enforces). Private profiles → "private" placeholder SVG.
 *
 * Caching: 60s ISR via Cache-Control.
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Blocked users must disappear from EVERY public read path, not only the
// leaderboard list/profile endpoints — stale snapshot rows would otherwise
// keep serving their embed card after a ban.
const BLOCKED_LEADERBOARD_USER_IDS = new Set(
  (Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS") ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean),
);

const BRAND_GREEN = "#059669";
const PALETTE = {
  light: {
    bg: "#ffffff",
    cardBorder: "#e5e7eb",
    fg: "#0f172a",
    muted: "#64748b",
    accent: BRAND_GREEN,
    chip: "#f1f5f9",
  },
  dark: {
    bg: "#0f172a",
    cardBorder: "#1f2937",
    fg: "#f8fafc",
    muted: "#94a3b8",
    accent: "#34d399",
    chip: "#1e293b",
  },
};

function svgResponse(svg: string, status = 200, cacheSeconds = 60): Response {
  return new Response(svg, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`,
    },
  });
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function compactNumber(n: number): string {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2).replace(/\.?0+$/, "") + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, "") + "K";
  return String(Math.round(n));
}

function formatCost(n: number): string {
  if (n >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  if (n >= 100) return "$" + n.toFixed(0);
  return "$" + n.toFixed(2);
}

// Deterministic hue from a display string so the same user always gets the
// same avatar tint. Saturation/lightness fixed to keep contrast acceptable
// on both light and dark themes.
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function avatarSvg(displayName: string, theme: "light" | "dark"): string {
  const seed = (displayName || "anon").trim() || "anon";
  const hue = hashHue(seed);
  const initial = seed.charAt(0).toUpperCase();
  const fg = theme === "dark" ? "#0f172a" : "#ffffff";
  // Light theme: saturated mid-tone; dark theme: lighter so it pops on dark bg.
  const fill = theme === "dark"
    ? `hsl(${hue} 70% 65%)`
    : `hsl(${hue} 65% 45%)`;
  return `<g transform="translate(36 38)">
    <circle r="32" fill="${fill}" />
    <text x="0" y="0" font-size="32" font-family="Inter, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-weight="600" text-anchor="middle" dominant-baseline="central" fill="${fg}">${escapeXml(initial)}</text>
  </g>`;
}

function placeholderSvg(message: string, theme: "light" | "dark"): string {
  const p = PALETTE[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="180" role="img" aria-label="${escapeXml(message)}">
    <rect width="600" height="180" rx="12" fill="${p.bg}" stroke="${p.cardBorder}" />
    <text x="300" y="100" text-anchor="middle" font-family="Inter, sans-serif" font-size="16" fill="${p.muted}">${escapeXml(message)}</text>
  </svg>`;
}

interface SnapshotRow {
  user_id: string;
  display_name: string | null;
  rank: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  gpt_tokens: number | null;
  claude_tokens: number | null;
  gemini_tokens: number | null;
  cursor_tokens: number | null;
  hermes_tokens: number | null;
  copilot_tokens: number | null;
  is_public: boolean | null;
  generated_at: string;
}

// deno-lint-ignore no-explicit-any
async function windowBounds(client: any, period: string): Promise<{ from_day: string; to_day: string }> {
  const now = new Date();
  if (period === "week") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) /* ISO Mon-start, matches leaderboard-refresh+dashboard */;
    const from_day = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6);
    return { from_day, to_day: d.toISOString().slice(0, 10) };
  }
  if (period === "month") {
    const from_day = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const to_day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    return { from_day, to_day };
  }
  const { data: latest } = await client.database
    .from("tokentracker_leaderboard_snapshots")
    .select("from_day, to_day")
    .eq("period", "total")
    .order("to_day", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = latest as { from_day?: string; to_day?: string } | null;
  return {
    from_day: (row?.from_day ?? "2024-01-01").slice(0, 10),
    to_day: (row?.to_day ?? now.toISOString()).slice(0, 10),
  };
}

function renderProfileCard(opts: {
  row: SnapshotRow;
  theme: "light" | "dark";
  period: string;
}): string {
  const { row, theme, period } = opts;
  const p = PALETTE[theme];
  const displayName = row.display_name || "Anonymous";
  const tokens = compactNumber(Number(row.total_tokens ?? 0));
  const cost = row.estimated_cost_usd == null ? "Partial cost" : formatCost(Number(row.estimated_cost_usd));
  const rank = row.rank ? `#${row.rank}` : "—";

  // Mini provider breakdown (top 3 by tokens). Compact bar so the card
  // doesn't feel empty.
  const providers = [
    { label: "Claude", val: Number(row.claude_tokens ?? 0) },
    { label: "Codex", val: Number(row.gpt_tokens ?? 0) },
    { label: "Gemini", val: Number(row.gemini_tokens ?? 0) },
    { label: "Cursor", val: Number(row.cursor_tokens ?? 0) },
    { label: "Copilot", val: Number(row.copilot_tokens ?? 0) },
    { label: "Hermes", val: Number(row.hermes_tokens ?? 0) },
  ];
  const total = providers.reduce((s, x) => s + x.val, 0);
  const top3 = providers
    .filter((x) => x.val > 0)
    .sort((a, b) => b.val - a.val)
    .slice(0, 3);

  let breakdownX = 460;
  const breakdownY = 100;
  const breakdownLines = top3.length
    ? top3
        .map((bp, i) => {
          const pct = total > 0 ? ((bp.val / total) * 100).toFixed(0) : "0";
          // Stack vertically along the right edge so the line never crosses
          // the TOKENS/COST/RANK chips on the left.
          const y = breakdownY + i * 18;
          return `<text x="${breakdownX}" y="${y}" font-size="11" font-family="Inter, sans-serif" fill="${p.muted}">${escapeXml(bp.label)} ${pct}%</text>`;
        })
        .join("\n  ")
    : `<text x="${breakdownX}" y="${breakdownY}" font-size="11" font-family="Inter, sans-serif" fill="${p.muted}">No provider data yet</text>`;

  const periodLabel = period.charAt(0).toUpperCase() + period.slice(1);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="180" viewBox="0 0 600 180" role="img" aria-label="${escapeXml(displayName)} on TokenTracker">
  <title>${escapeXml(displayName)} — ${tokens} tokens, ${cost}, rank ${rank}</title>
  <rect width="600" height="180" rx="12" fill="${p.bg}" stroke="${p.cardBorder}" />
  ${avatarSvg(displayName, theme)}
  <g font-family="Inter, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif">
    <text x="80" y="38" font-size="20" font-weight="600" fill="${p.fg}">${escapeXml(displayName)}</text>
    <text x="80" y="58" font-size="12" fill="${p.muted}">TokenTracker · ${escapeXml(periodLabel)}</text>

    <g transform="translate(80 90)">
      <rect width="120" height="56" rx="8" fill="${p.chip}" />
      <text x="14" y="22" font-size="11" fill="${p.muted}">TOKENS</text>
      <text x="14" y="44" font-size="20" font-weight="600" fill="${p.fg}">${escapeXml(tokens)}</text>
    </g>
    <g transform="translate(212 90)">
      <rect width="120" height="56" rx="8" fill="${p.chip}" />
      <text x="14" y="22" font-size="11" fill="${p.muted}">COST</text>
      <text x="14" y="44" font-size="20" font-weight="600" fill="${p.fg}">${escapeXml(cost)}</text>
    </g>
    <g transform="translate(344 90)">
      <rect width="100" height="56" rx="8" fill="${p.chip}" />
      <text x="14" y="22" font-size="11" fill="${p.muted}">RANK</text>
      <text x="14" y="44" font-size="20" font-weight="600" fill="${p.accent}">${escapeXml(rank)}</text>
    </g>

    <text x="460" y="88" font-size="11" font-weight="600" fill="${p.muted}">TOP PROVIDERS</text>

    <text x="455" y="40" font-size="11" fill="${p.muted}" text-anchor="end">www.tokentracker.cc</text>
    <text x="585" y="40" font-size="11" font-weight="700" fill="${p.accent}" text-anchor="end">TT</text>
  </g>

  <g>
    ${breakdownLines}
  </g>
</svg>`;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return svgResponse(placeholderSvg("method not allowed", "light"), 405, 0);

  const url = new URL(req.url);
  const userId = (url.searchParams.get("user_id") || "").trim().toLowerCase();
  const theme = (url.searchParams.get("theme") || "light").toLowerCase() === "dark" ? "dark" : "light";
  const period = (url.searchParams.get("period") || "total").toLowerCase();

  if (!userId || !isUuid(userId)) {
    return svgResponse(placeholderSvg("bad user_id", theme), 400, 0);
  }
  if (BLOCKED_LEADERBOARD_USER_IDS.has(userId)) {
    return svgResponse(placeholderSvg("not found", theme), 404, 0);
  }
  if (!["week", "month", "total"].includes(period)) {
    return svgResponse(placeholderSvg("bad period", theme), 400, 0);
  }

  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY");
  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  if (!baseUrl) return svgResponse(placeholderSvg("misconfigured", theme), 500, 0);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey: anonKey ?? undefined,
    isServerMode: true,
  });

  let from_day: string;
  let to_day: string;
  try {
    const bounds = await windowBounds(client, period);
    from_day = bounds.from_day;
    to_day = bounds.to_day;
  } catch {
    return svgResponse(placeholderSvg("lookup failed", theme), 502, 0);
  }

  const { data, error } = await client.database
    .from("tokentracker_leaderboard_snapshots")
    .select(
      "user_id, display_name, rank, total_tokens, estimated_cost_usd, gpt_tokens, claude_tokens, gemini_tokens, cursor_tokens, hermes_tokens, copilot_tokens, is_public, generated_at",
    )
    .eq("user_id", userId)
    .eq("period", period)
    .eq("from_day", from_day)
    .eq("to_day", to_day)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return svgResponse(placeholderSvg("db error", theme), 502, 0);
  const row = data as SnapshotRow | null;
  if (!row) return svgResponse(placeholderSvg("not found", theme), 404, 0);
  if (row.is_public === false) return svgResponse(placeholderSvg("profile is private", theme), 403, 0);

  const svg = renderProfileCard({ row, theme, period });
  return svgResponse(svg, 200, 60);
}
