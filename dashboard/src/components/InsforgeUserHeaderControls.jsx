import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { useLocale } from "../hooks/useLocale.js";
import { useCloudAccount } from "../hooks/use-cloud-billing.js";
import { isOfficialInsforgeInstance } from "../lib/insforge-config";
import { isNativeApp } from "../lib/native-bridge.js";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";

function pickAvatarUrl(user) {
  if (!user || typeof user !== "object") return null;
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const prof = user.profile && typeof user.profile === "object" ? user.profile : {};
  const u = meta.avatar_url || meta.picture || prof.avatar_url || user.avatar_url;
  return typeof u === "string" && u.trim() ? u.trim() : null;
}

// In TokenTrackerBar WKWebView, third-party avatar CDNs (lh3.googleusercontent.com,
// avatars.githubusercontent.com) intermittently fail to load even when they
// render fine in Safari. Route them through the local CLI server, which fetches
// via Node and serves the bytes as same-origin — that path is reliable.
// On Vercel (no local server) we keep the original URL.
function resolveAvatarSrc(url) {
  if (!url) return null;
  if (!isNativeApp()) return url;
  return `/api/avatar-proxy?url=${encodeURIComponent(url)}`;
}

function initialsFromName(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

export function isCurrentProAccount(account, now = Date.now()) {
  const membership = account?.membership;
  if (account?.environment !== "live" || membership?.environment !== "live"
    || membership.phase !== "active" || membership.status !== "active"
    || ![undefined, "hosted"].includes(membership.hosting_mode)
    || typeof membership.expires_at !== "string" || !Number.isFinite(Date.parse(membership.expires_at))
    || Date.parse(membership.expires_at) <= now) return false;
  // The server derives access_source from current, unrevoked periods. History
  // is capped, so an active period need not be present in the returned arrays.
  return ["payment", "gift", "mixed"].includes(membership.access_source);
}

/**
 * Compact identity control. Avatar click navigates to /settings — all account
 * preferences live there now. Sign-in shows the login modal as before.
 */
export function InsforgeUserHeaderControls({ className, variant = "header", collapsed = false, onAfterAction }) {
  // Subscribe to locale so labels re-render on language switch.
  useLocale();
  const isSidebar = variant === "sidebar";
  const { enabled, loading, signedIn, user, displayName } = useInsforgeAuth();
  const billing = useCloudAccount({ enabled: isSidebar && enabled && !loading && signedIn && isOfficialInsforgeInstance() });
  const proActive = isSidebar && !billing.error && isCurrentProAccount(billing.account);
  const { openLoginModal } = useLoginModal();
  const navigate = useNavigate();
  const avatarUrl = useMemo(() => pickAvatarUrl(user), [user]);
  const avatarSrc = useMemo(() => resolveAvatarSrc(avatarUrl), [avatarUrl]);
  const [avatarFailed, setAvatarFailed] = React.useState(false);

  React.useEffect(() => {
    setAvatarFailed(false);
  }, [avatarSrc]);

  if (!enabled) return null;

  if (loading) {
    return (
      <div
        className={cn("h-9 w-9 shrink-0 rounded-full bg-oai-gray-200 dark:bg-oai-gray-800 animate-pulse", className)}
        aria-hidden
      />
    );
  }

  if (!signedIn) {
    if (isSidebar) {
      return (
        <button
          type="button"
          onClick={() => { openLoginModal(); onAfterAction?.(); }}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-oai-gray-700 dark:text-oai-gray-300 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 min-w-0",
            collapsed ? "h-8 w-8 justify-center px-0" : "w-full",
            className,
          )}
          aria-label={copy("header.auth.sign_in_aria")}
          title={collapsed ? copy("header.auth.sign_in_aria") : undefined}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            <img
              src="/app-icon.png"
              alt=""
              width={18}
              height={18}
              className="h-[18px] w-[18px] rounded"
            />
          </span>
          {!collapsed && <span className="truncate flex-1 text-left">{copy("header.auth.sign_in_aria")}</span>}
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={openLoginModal}
        className={cn(
          "shrink-0 inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors duration-200 ease-out shadow-sm ring-1 ring-oai-gray-200 dark:ring-white/10 bg-oai-gray-900 text-white hover:bg-oai-gray-800 active:bg-oai-gray-950 dark:bg-white dark:text-oai-gray-900 dark:hover:bg-oai-gray-100 dark:active:bg-oai-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-oai-gray-950",
          className,
        )}
        aria-label={copy("header.auth.sign_in_aria")}
      >
        {copy("header.auth.sign_in_aria")}
      </button>
    );
  }

  const handleClick = () => {
    navigate("/settings");
    onAfterAction?.();
  };

  return (
    <div
      className={cn(
        isSidebar ? "relative flex w-full shrink-0 items-center" : "relative flex shrink-0 items-center",
        className,
      )}
    >
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          isSidebar
            ? cn(
                "tt-sidebar-account-control flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 transition-colors min-w-0",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
                collapsed && "justify-center px-0 py-0 h-9 w-9",
              )
            : "flex items-center gap-2 rounded-md pl-1 pr-2 py-1 border border-transparent hover:bg-oai-gray-100 dark:hover:bg-oai-gray-900/80 hover:border-oai-gray-200 dark:hover:border-oai-gray-800 transition-colors",
        )}
        aria-label={proActive ? `${copy("header.auth.open_settings")}, ${copy("leaderboard.pro.badge_aria")}` : copy("header.auth.open_settings")}
        title={isSidebar && collapsed ? (proActive ? `${displayName}, ${copy("leaderboard.pro.badge_aria")}` : displayName) : undefined}
      >
        {isSidebar ? (
          <span className={cn("relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full", proActive && "leaderboard-pro-avatar")}>
            {avatarSrc && !avatarFailed ? (
              <img
                src={avatarSrc}
                alt=""
                width={20}
                height={20}
                className="h-5 w-5 rounded-full object-cover ring-1 ring-oai-gray-300 dark:ring-oai-gray-700"
                referrerPolicy="no-referrer"
                onError={() => setAvatarFailed(true)}
              />
            ) : initialsFromName(displayName) === "?" ? (
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-white ring-1",
                proActive ? "tt-sidebar-pro-fallback" : "bg-oai-brand-600/30 ring-oai-brand-500/50")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3 opacity-80">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
              </span>
            ) : (
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-1",
                proActive ? "tt-sidebar-pro-fallback" : "bg-oai-brand-600 ring-oai-brand-500/50")}>
                {initialsFromName(displayName)}
              </span>
            )}
            {proActive && collapsed && (
              <span aria-hidden title={copy("leaderboard.pro.badge_aria")} className="leaderboard-pro-badge absolute -bottom-1.5 left-1/2 -translate-x-1/2 !px-0.5 !text-[8px] !leading-[10px]">
                {copy("leaderboard.pro.badge")}
              </span>
            )}
          </span>
        ) : avatarSrc && !avatarFailed ? (
          <img
            src={avatarSrc}
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 rounded-full object-cover ring-1 ring-oai-gray-300 dark:ring-oai-gray-700 shrink-0"
            referrerPolicy="no-referrer"
            onError={() => setAvatarFailed(true)}
          />
        ) : initialsFromName(displayName) === "?" ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-oai-brand-600/30 text-white ring-1 ring-oai-brand-500/50">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4 opacity-80">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
          </span>
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-oai-brand-600 text-xs font-semibold text-white ring-1 ring-oai-brand-500/50">
            {initialsFromName(displayName)}
          </span>
        )}
        {proActive && !collapsed && <span aria-hidden title={copy("leaderboard.pro.badge_aria")} className="leaderboard-pro-badge">{copy("leaderboard.pro.badge")}</span>}
        {isSidebar ? (
          !collapsed && (
            <span className="truncate text-[13px] font-medium text-oai-gray-900 dark:text-oai-gray-200 flex-1 text-left min-w-0">
              {displayName}
            </span>
          )
        ) : (
          <span className="hidden sm:inline truncate text-sm font-medium text-oai-gray-900 dark:text-oai-gray-200 max-w-[120px]">
            {displayName}
          </span>
        )}
      </button>
    </div>
  );
}
