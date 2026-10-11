import React from "react";
import { cn } from "../lib/cn";

function hashHue(input) {
  let h = 0;
  const s = String(input ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

function initialsFromName(displayName) {
  const t = String(displayName ?? "").trim();
  if (!t) return "?";
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0][0] || "";
    const b = parts[1][0] || "";
    return `${a}${b}`.toUpperCase();
  }
  return t.slice(0, 2).toUpperCase();
}

const SIZE_CLASS = {
  sm: "h-7 w-7 min-h-7 min-w-7 text-[10px]",
  md: "h-8 w-8 min-h-8 min-w-8 text-[11px]",
  lg: "h-14 w-14 min-h-14 min-w-14 text-base",
  xl: "h-[68px] w-[68px] min-h-[68px] min-w-[68px] text-xl",
};

/**
 * Avatar for leaderboard rows: remote URL when present, otherwise deterministic initials + color.
 */
export function LeaderboardAvatar({
  avatarUrl,
  displayName,
  seed,
  size = "md",
  proActive = false,
  className,
}) {
  const dim = SIZE_CLASS[size] || SIZE_CLASS.md;
  const hue = hashHue(seed ?? displayName ?? "");
  const safeUrl = typeof avatarUrl === "string" ? avatarUrl.trim() : "";
  const [failed, setFailed] = React.useState(false);
  const proFrame = proActive === true ? "leaderboard-pro-avatar" : null;

  React.useEffect(() => {
    setFailed(false);
  }, [safeUrl]);

  if (safeUrl && !failed) {
    return (
      <img
        src={safeUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn("rounded-full object-cover ring-1 ring-white/10", dim, className, proFrame)}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-1 ring-white/10",
        dim,
        className,
        proFrame,
      )}
      style={{ backgroundColor: `hsl(${hue} 42% 34%)` }}
      aria-hidden
    >
      {initialsFromName(displayName)}
    </div>
  );
}
