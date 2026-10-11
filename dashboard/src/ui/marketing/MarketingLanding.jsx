import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { getDashboardEntryPath } from "../../lib/host-mode";
import { HeaderGithubStar } from "../components/HeaderGithubStar.jsx";
import { InsforgeUserHeaderControls } from "../../components/InsforgeUserHeaderControls.jsx";
import { useInsforgeAuth } from "../../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../../contexts/LoginModalContext.jsx";
import { STATUSPAGE_URL } from "../../lib/config";
import { LV3_CSS_VARS } from "./v3/palette.js";
import { REPO_URL } from "../../lib/config";
import { LegalLinks } from "../components/LegalLinks.jsx";
import { useCommunityStats } from "../../hooks/use-community-stats.js";
import { HeroSection } from "./v3/HeroSection.jsx";
import { ToolsStrip } from "./v3/ToolsStrip.jsx";
import { HowItWorksSection } from "./v3/HowItWorksSection.jsx";
import { CapabilitiesSection } from "./v3/CapabilitiesSection.jsx";
import { PrivacySection } from "./v3/PrivacySection.jsx";
import { LeaderboardSection } from "./v3/LeaderboardSection.jsx";
import { DownloadSection } from "./v3/DownloadSection.jsx";

/**
 * Landing v3 — "token galaxy". A dark, deep-space purple marketing page:
 * WebGL particle hero, GSAP ScrollTrigger storytelling, and live community
 * stats. Section markup lives under ./v3/; this file orchestrates them plus
 * the auth-aware header and the footer.
 */
export function MarketingLanding({
  copy,
  reduceMotion,
  screenshotMode,
  effectsReady,
  signInUrl,
  signUpUrl,
  installCommand,
  installCopied,
  onCopyInstallCommand,
}) {
  // One switch for every scroll/canvas animation on the page: reduced motion
  // and the visual-baseline screenshot job both get the complete static page.
  const animate = !reduceMotion && !screenshotMode;
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const isLocalMode =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const { signedIn, loading: authLoading } = useInsforgeAuth();
  const { openLoginModal } = useLoginModal();

  const stats = useCommunityStats();
  const tokenFallback = Number(copy("landing.v3.stats.fallback_tokens")) || 0;
  const devsFallback = Number(copy("landing.v3.stats.fallback_devs")) || 0;
  const githubLabel = copy("landing.cta.secondary");

  return (
    <div
      className="relative min-h-screen overflow-x-hidden bg-[color:var(--lv3-bg)] text-oai-white font-oai antialiased dark"
      style={LV3_CSS_VARS}
    >
      <header
        className={cn(
          "sticky top-0 z-50 transition-all duration-300",
          scrolled
            ? "bg-oai-gray-950/80 backdrop-blur-md border-b border-oai-gray-900"
            : "bg-transparent border-b border-transparent",
        )}
      >
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3 sm:gap-5">
            <Link
              to={signUpUrl || "/"}
              className="flex items-center gap-3 no-underline outline-none rounded focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:ring-offset-oai-gray-950 transition-opacity hover:opacity-80"
            >
              <img src="/app-icon.png" alt="" width={24} height={24} className="rounded-md" />
              <span className="whitespace-nowrap text-sm font-semibold uppercase tracking-wide text-white">
                Token Tracker
              </span>
            </Link>
            <div className="hidden sm:block">
              <HeaderGithubStar />
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 sm:gap-5 md:gap-6">
            <Link
              to="/cloud"
              className="hidden min-h-10 items-center text-sm font-medium text-oai-gray-400 transition-colors hover:text-white focus-visible:underline sm:inline-flex"
            >
              {copy("cloud.nav")}
            </Link>
            {/* Leaderboard 纯文字导航链接 — 移动端收起（正文有醒目的榜单 CTA 兜底） */}
            <Link
              to="/leaderboard"
              className="hidden select-none text-sm font-medium text-oai-gray-400 outline-none transition-colors duration-200 hover:text-white focus-visible:underline sm:inline"
            >
              {copy("nav.leaderboard")}
            </Link>

            {/* 未登录场景下，Open Dashboard 应该作为次级文字导航链接并排展示 */}
            {!signedIn && !authLoading && (
              <Link
                to={getDashboardEntryPath()}
                className="hidden select-none text-sm font-medium text-oai-gray-400 outline-none transition-colors duration-200 hover:text-white focus-visible:underline sm:inline"
              >
                {copy("landing.v2.cta.primary")}
              </Link>
            )}

            {/* Dashboard / Sign In 按钮及头像区 */}
            <div className="flex items-center gap-2.5 sm:gap-3.5">
              {authLoading ? (
                <div className="h-8 w-16 animate-pulse rounded-[8px] bg-white/10" aria-hidden />
              ) : signedIn ? (
                // 已登录：Open Dashboard 升级为主行动实色按钮
                <>
                  <Link
                    to={getDashboardEntryPath()}
                    className="inline-flex h-8 select-none items-center justify-center rounded-[8px] bg-white px-3.5 text-xs font-bold text-oai-gray-950 shadow-sm transition-all duration-200 hover:bg-oai-gray-100 active:scale-[0.98]"
                  >
                    {copy("landing.v2.cta.primary")}
                  </Link>
                  {/* 已登录时，优雅挂载头像控件 */}
                  <InsforgeUserHeaderControls />
                </>
              ) : (
                // 未登录：Sign In 展示为主行动实色按钮，点击唤起 Modal
                <button
                  type="button"
                  onClick={openLoginModal}
                  className="inline-flex h-8 min-w-[80px] select-none items-center justify-center rounded-[8px] bg-white px-3.5 text-xs font-bold text-oai-gray-950 shadow-sm transition-all duration-200 hover:bg-oai-gray-100 active:scale-[0.98]"
                >
                  {copy("header.auth.sign_in_aria")}
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="-mt-14">
        <HeroSection
          copy={copy}
          animate={animate}
          effectsReady={effectsReady}
          stats={stats}
          tokenFallback={tokenFallback}
          devsFallback={devsFallback}
          installCommand={installCommand}
          installCopied={installCopied}
          onCopyInstallCommand={onCopyInstallCommand}
          githubLabel={githubLabel}
        />
        {/* Show the product first (capabilities + screenshot), enumerate the
            supported agents, THEN explain the mechanism. */}
        <CapabilitiesSection
          copy={copy}
          animate={animate}
          screenshotSrc="/dashboard-dark.png"
          screenshotAlt={copy("landing.screenshot.alt")}
        />
        <ToolsStrip copy={copy} animate={animate} />
        <HowItWorksSection copy={copy} animate={animate} />
        <PrivacySection copy={copy} animate={animate} />
        <LeaderboardSection
          copy={copy}
          animate={animate}
          stats={stats}
          tokenFallback={tokenFallback}
          devsFallback={devsFallback}
        />
        <DownloadSection
          copy={copy}
          animate={animate}
          installCommand={installCommand}
          installCopied={installCopied}
          onCopyInstallCommand={onCopyInstallCommand}
          githubLabel={githubLabel}
        />
      </main>

      <footer className="border-t border-oai-gray-900 bg-oai-gray-950 py-12">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-4 text-sm text-oai-gray-400 sm:flex-row sm:px-6">
          <p>{copy("landing.v2.footer.line")}</p>
          <div className="flex flex-wrap items-center justify-center gap-6">
            <Link to="/cloud" className="font-medium text-oai-gray-400 transition-colors hover:text-white">
              {copy("cloud.nav")}
            </Link>
            <a
              href={STATUSPAGE_URL}
              className="font-medium text-oai-gray-400 transition-colors hover:text-white"
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy("landing.v2.nav.status")}
            </a>
            <a
              href={REPO_URL}
              className="font-medium text-oai-gray-400 transition-colors hover:text-white"
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy("landing.v2.nav.github")}
            </a>
            <LegalLinks />
            {isLocalMode && (
              <Link
                to={signInUrl}
                className="font-medium text-[color:var(--lv3-accent-soft)] transition-colors hover:text-white"
              >
                {copy("landing.cta.primary")} &rarr;
              </Link>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
