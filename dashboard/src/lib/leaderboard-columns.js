import { cn } from "./cn";

/**
 * Leaderboard token columns: one column per provider (no aggregated "Other").
 * `key` matches API / mock field names on each entry.
 */
export const LEADERBOARD_TOKEN_COLUMNS = [
  { key: "gpt_tokens", copyKey: "leaderboard.column.codex", icon: "/brand-logos/codex.svg" },
  { key: "claude_tokens", copyKey: "leaderboard.column.claude", icon: "/brand-logos/claude-code.svg" },
  { key: "gemini_tokens", copyKey: "leaderboard.column.gemini", icon: "/brand-logos/gemini.svg" },
  { key: "cursor_tokens", copyKey: "leaderboard.column.cursor", icon: "/brand-logos/cursor.svg" },
  { key: "kiro_tokens", copyKey: "leaderboard.column.kiro", icon: "/brand-logos/kiro.svg" },
  { key: "copilot_tokens", copyKey: "leaderboard.column.copilot", icon: "/brand-logos/copilot.svg" },
  { key: "kimi_tokens", copyKey: "leaderboard.column.kimi", icon: "/brand-logos/kimi.svg" },
  { key: "opencode_tokens", copyKey: "leaderboard.column.opencode", icon: "/brand-logos/opencode.svg" },
  { key: "openclaw_tokens", copyKey: "leaderboard.column.openclaw", icon: "/brand-logos/openclaw.svg" },
  { key: "hermes_tokens", copyKey: "leaderboard.column.hermes", icon: "/brand-logos/hermes.svg" },
  { key: "other_tokens", copyKey: "leaderboard.column.supplemental", icon: null },
];

// Divider between the two sticky columns lives on the SECOND cell's left
// edge (not the first cell's right edge), and that cell is shifted 1px
// left (`left-[71px]`) so it overlaps the rank column by a pixel. Without
// the overlap, sub-pixel rendering on retina displays can leak a 1px gap
// between the cells where the scrolling background shows through.
// Rank column is narrower on phones (the medal badge is only 28px) so the
// User + Total columns fit on-screen without horizontal scroll. The User
// sticky `left` offset tracks the rank width: 55px (=56-1) on mobile,
// 71px (=72-1) at sm+. The 1px overlap avoids a retina sub-pixel seam.
export const LB_STICKY_TH_RANK =
  "sticky left-0 z-40 w-14 min-w-14 max-w-14 sm:w-[72px] sm:min-w-[72px] sm:max-w-[72px] bg-white dark:bg-oai-gray-950 px-2.5 sm:px-4 py-4 align-middle";

export const LB_STICKY_TH_USER =
  "sticky left-[55px] sm:left-[71px] z-40 min-w-[96px] sm:min-w-[200px] max-w-[170px] sm:max-w-[min(260px,45vw)] border-l border-r border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-950 px-3 sm:px-4 py-4 align-middle";

/** Second sticky column on profile page (Rank + Total; no User column in table) */
export const LB_STICKY_TH_TOTAL =
  "sticky left-[55px] sm:left-[71px] z-40 min-w-[6rem] border-l border-r border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-950 px-2.5 sm:px-4 py-4";

export function lbStickyTdRank(isMe) {
  return cn(
    "sticky left-0 z-30 w-14 min-w-14 max-w-14 sm:w-[72px] sm:min-w-[72px] sm:max-w-[72px] px-2.5 sm:px-4 py-4 whitespace-nowrap",
    isMe
      ? "bg-oai-gray-50 dark:bg-oai-gray-900"
      : "bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900",
  );
}

export function lbStickyTdUser(isMe) {
  // hover:z-50 lifts the cell above the sticky <th> (z-40) so the GitHub
  // tooltip — confined to this td's stacking context — can paint over the
  // table header on row 1.
  return cn(
    "sticky left-[55px] sm:left-[71px] z-30 hover:z-50 min-w-[96px] sm:min-w-[200px] max-w-[170px] sm:max-w-[min(260px,45vw)] border-l border-r border-oai-gray-200 dark:border-oai-gray-800 px-3 sm:px-4 py-4 min-w-0",
    isMe
      ? "bg-oai-gray-50 dark:bg-oai-gray-900"
      : "bg-white dark:bg-oai-gray-950 group-hover:bg-oai-gray-50 dark:group-hover:bg-oai-gray-900",
  );
}

/** Second sticky body cell when the column is Total (profile table) */
export function lbStickyTdTotalOnly(isMe) {
  return cn(
    "sticky left-[55px] sm:left-[71px] z-30 min-w-[6rem] border-l border-r border-oai-gray-200 dark:border-oai-gray-800 px-2.5 sm:px-4 py-4 whitespace-nowrap",
    isMe
      ? "bg-oai-gray-50 dark:bg-oai-gray-900"
      : "bg-white dark:bg-oai-gray-950",
  );
}
