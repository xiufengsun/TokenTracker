import { snapshotBounds, snapshotRow } from "./report-public";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const BRAND_GREEN = "#059669";
const LABEL_BG = "#555";

// Blocked users must disappear from EVERY public read path, not only the
// leaderboard list/profile endpoints — stale snapshot rows would otherwise
// keep serving their badge after a ban.

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
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
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

// Rough text width for "Verdana, DejaVu Sans, sans-serif" at 11px,
// good enough for shields.io-style badges. (Real shields.io measures glyph
// widths per char; we average ~6.2px which matches their default.)
function textWidth(s: string): number {
  // 6.2px per ASCII char is a tested approximation that lines up with
  // shields.io rendering for most strings.
  return Math.max(s.length * 6.2, 0);
}

interface SnapshotRow {
  user_id: string;
  display_name: string | null;
  rank: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  is_public: boolean | null;
  from_day: string;
  to_day: string;
  generated_at: string;
}

// deno-lint-ignore no-explicit-any
function renderBadgeSvg(opts: {
  label: string;
  value: string;
  style: "flat" | "flat-square";
  color: string;
}): string {
  const { label, value, style, color } = opts;
  const padX = 6;
  const labelWidth = Math.ceil(textWidth(label) + padX * 2);
  const valueWidth = Math.ceil(textWidth(value) + padX * 2);
  const totalWidth = labelWidth + valueWidth;
  const height = 20;
  const rx = style === "flat-square" ? 0 : 3;

  // We render two rect halves to make the corner radius work cleanly on flat
  // style; flat-square sets rx=0 so corners stay sharp.
  const safeLabel = escapeXml(label);
  const safeValue = escapeXml(value);
  const labelTextX = labelWidth / 2;
  const valueTextX = labelWidth + valueWidth / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${safeLabel}: ${safeValue}">
  <title>${safeLabel}: ${safeValue}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="${height}" rx="${rx}" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="${height}" fill="${LABEL_BG}"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${color}"/>
    <rect width="${totalWidth}" height="${height}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${labelTextX * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${labelWidth * 10 - padX * 20}">${safeLabel}</text>
    <text x="${labelTextX * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${labelWidth * 10 - padX * 20}">${safeLabel}</text>
    <text aria-hidden="true" x="${valueTextX * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${valueWidth * 10 - padX * 20}">${safeValue}</text>
    <text x="${valueTextX * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${valueWidth * 10 - padX * 20}">${safeValue}</text>
  </g>
</svg>`;
}

function renderErrorBadge(label: string, message: string): string {
  return renderBadgeSvg({
    label,
    value: message,
    style: "flat",
    color: "#9f9f9f",
  });
}

export default async function (
  req: Request,
  db: D1Database,
  blocked: Set<string>,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return svgResponse(renderErrorBadge("tokentracker", "method"), 405, 0);
  }

  const url = new URL(req.url);
  const userId = (url.searchParams.get("user_id") || "").trim().toLowerCase();
  const metric = (url.searchParams.get("metric") || "tokens").toLowerCase();
  const period = (url.searchParams.get("period") || "total").toLowerCase();
  const style =
    (url.searchParams.get("style") || "flat").toLowerCase() === "flat-square"
      ? "flat-square"
      : "flat";
  const compact = url.searchParams.get("compact") !== "0";
  const customLabel = url.searchParams.get("label");
  const customColor = url.searchParams.get("color");

  if (!userId || !isUuid(userId)) {
    return svgResponse(renderErrorBadge("tokentracker", "bad user_id"), 400, 0);
  }
  if (blocked.has(userId)) {
    return svgResponse(renderErrorBadge("tokentracker", "not found"), 404, 0);
  }

  if (!["tokens", "cost", "rank"].includes(metric)) {
    return svgResponse(renderErrorBadge("tokentracker", "bad metric"), 400, 0);
  }
  if (!["week", "month", "total"].includes(period)) {
    return svgResponse(renderErrorBadge("tokentracker", "bad period"), 400, 0);
  }

  // Public endpoint: use service role key so a caller's stale Authorization
  // can never trigger the InsForge gateway's JWT validator (see
  // tokentracker-leaderboard.ts header for the rationale).
  let from_day: string;
  let to_day: string;
  try {
    const bounds = await snapshotBounds(db, period);
    from_day = bounds.from_day;
    to_day = bounds.to_day;
  } catch {
    return svgResponse(
      renderErrorBadge("tokentracker", "lookup failed"),
      502,
      0,
    );
  }

  let row: SnapshotRow | null;
  try {
    row = (await snapshotRow(
      db,
      userId,
      period,
      from_day,
      to_day,
    )) as SnapshotRow | null;
  } catch {
    return svgResponse(renderErrorBadge("tokentracker", "db error"), 502, 0);
  }

  if (!row) {
    return svgResponse(renderErrorBadge("tokentracker", "not found"), 404, 0);
  }
  if (row.is_public === false) {
    // Privacy gate: anonymous badge for non-public profiles.
    return svgResponse(renderErrorBadge("tokentracker", "private"), 403, 0);
  }

  let value: string;
  if (metric === "tokens") {
    const n = Number(row.total_tokens ?? 0);
    value = compact
      ? `${compactNumber(n)} tokens`
      : `${n.toLocaleString("en-US")} tokens`;
  } else if (metric === "cost") {
    value = formatCost(Number(row.estimated_cost_usd ?? 0));
  } else {
    value = `#${row.rank ?? "?"}`;
  }

  const defaultLabel =
    metric === "rank"
      ? row.display_name
        ? `${row.display_name} rank`
        : "rank"
      : metric === "cost"
        ? "cost"
        : "tokens";
  const label = customLabel?.trim() || defaultLabel;
  const color =
    customColor && /^#?[0-9a-f]{3,8}$/i.test(customColor.trim())
      ? customColor.startsWith("#")
        ? customColor
        : `#${customColor}`
      : BRAND_GREEN;

  const svg = renderBadgeSvg({ label, value, style, color });
  return svgResponse(svg, 200, 60);
}
