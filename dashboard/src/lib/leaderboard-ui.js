export function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export function buildPageItems(page, totalPages) {
  const safeTotal = clampInt(totalPages, { min: 0, max: 1_000_000, fallback: 0 });
  const safePage = clampInt(page, { min: 1, max: Math.max(1, safeTotal || 1), fallback: 1 });
  if (safeTotal <= 1) return [1];

  const candidates = new Set([
    1,
    safeTotal,
    safePage - 2,
    safePage - 1,
    safePage,
    safePage + 1,
    safePage + 2,
  ]);

  const sorted = Array.from(candidates)
    .filter((p) => Number.isInteger(p) && p >= 1 && p <= safeTotal)
    .sort((a, b) => a - b);

  const items = [];
  let prev = null;
  for (const p of sorted) {
    if (prev != null && p - prev > 1) items.push(null);
    items.push(p);
    prev = p;
  }
  return items;
}

export function getPaginationFlags({ page, totalPages }) {
  const totalKnown =
    typeof totalPages === "number" && Number.isFinite(totalPages) && totalPages >= 0;
  const safeTotal = totalKnown
    ? clampInt(totalPages, { min: 0, max: 1_000_000, fallback: 0 })
    : null;
  const safePage = clampInt(page, {
    min: 1,
    max: totalKnown ? Math.max(1, safeTotal || 1) : 1_000_000,
    fallback: 1,
  });

  const canPrev = safePage > 1;
  const canNext = totalKnown ? safePage < safeTotal : true;

  return { canPrev, canNext, safePage, safeTotal };
}

export function prependMeRowToPage({ entries, me, meLabel }) {
  const rows = Array.isArray(entries) ? entries : [];
  const meRank = me && typeof me.rank === "number" ? me.rank : null;
  if (!meRank) return rows;
  if (rows.some((e) => Boolean(e?.is_me))) return rows;

  const pinnedRow = {
    rank: meRank,
    is_me: true,
    is_pinned: true,
    user_id: me?.user_id ?? null,
    display_name: meLabel,
    avatar_url: me?.avatar_url ?? null,
    pro_active: me?.pro_active === true,
    github_url: null,
    is_public: false,
    gpt_tokens: me?.gpt_tokens ?? "0",
    claude_tokens: me?.claude_tokens ?? "0",
    gemini_tokens: me?.gemini_tokens ?? "0",
    cursor_tokens: me?.cursor_tokens ?? "0",
    opencode_tokens: me?.opencode_tokens ?? "0",
    openclaw_tokens: me?.openclaw_tokens ?? "0",
    hermes_tokens: me?.hermes_tokens ?? "0",
    kiro_tokens: me?.kiro_tokens ?? "0",
    copilot_tokens: me?.copilot_tokens ?? "0",
    kimi_tokens: me?.kimi_tokens ?? "0",
    other_tokens: me?.other_tokens ?? "0",
    total_tokens: me?.total_tokens ?? "0",
    estimated_cost_usd: me?.estimated_cost_usd ?? null,
    badges: Array.isArray(me?.badges) ? me.badges : [],
  };

  return [pinnedRow, ...rows];
}

export function pageContainingRank(rank, pageSize) {
  const r = Number(rank);
  const s = Number(pageSize);
  if (!Number.isFinite(r) || r < 1) return null;
  if (!Number.isFinite(s) || s < 1) return null;
  return Math.ceil(r / s);
}
