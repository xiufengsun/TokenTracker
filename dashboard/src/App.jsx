import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { useLocale } from "./hooks/useLocale.js";
import { ThemeProvider } from "./ui/foundation/ThemeProvider.jsx";
import { useInsforgeAuth } from "./contexts/InsforgeAuthContext.jsx";
import { LoginModalProvider } from "./contexts/LoginModalContext.jsx";
import { getBackendBaseUrl, getLeaderboardBaseUrl } from "./lib/config";
import { isMockEnabled } from "./lib/mock-mode";
import { isScreenshotModeEnabled } from "./lib/screenshot-mode";
import { useCloudUsageSync } from "./hooks/use-cloud-usage-sync";
import { AppLayout } from "./ui/components/Sidebar.jsx";
import { ToastProvider } from "./ui/components/Toast.jsx";
import {
  getLeaderboardPreloadContextKey,
  markDashboardMainContentVisible,
  preloadDashboardPageResources,
  preloadLeaderboardDefaultState,
} from "./lib/dashboard-preload.js";
// Telemetry beacons and modal/palette UI are not first-paint critical; lazy
// loading keeps them out of the eager entry chunk (which the anonymous share
// page also downloads). The providers above must stay eager.
// Every lazy import has a null fallback: after a deploy rotates chunk hashes,
// a client holding the old index.html gets 404s on the new chunks — a rejected
// lazy() would otherwise throw past the outer ErrorBoundary and blank the
// whole app. Telemetry/modals must never have that power.
const nullComponent = () => null;
const Analytics = lazy(() =>
  import("@vercel/analytics/react")
    .then((m) => ({ default: m.Analytics }))
    .catch(() => ({ default: nullComponent })),
);
const SpeedInsights = lazy(() =>
  import("@vercel/speed-insights/react")
    .then((m) => ({ default: m.SpeedInsights }))
    .catch(() => ({ default: nullComponent })),
);
const LoginModal = lazy(() =>
  import("./components/LoginModal.jsx")
    .then((m) => ({ default: m.LoginModal }))
    .catch(() => ({ default: nullComponent })),
);
const CommandPalette = lazy(() =>
  import("./ui/dashboard/components/CommandPalette.jsx")
    .then((m) => ({ default: m.CommandPalette }))
    .catch(() => ({ default: nullComponent })),
);
// NativeAuthCallbackPage must be eager-imported: its module-level code
// captures the OAuth `insforge_code` query param synchronously at app
// boot, BEFORE the InsForge SDK's detectAuthCallback() strips it. Lazy
// loading delays the module until route render, by which point the
// param has already been removed — the page then falls through to the
// "Sign-in incomplete" failure state.
import { NativeAuthCallbackPage } from "./pages/NativeAuthCallbackPage.jsx";

// Pages are lazy-loaded so each route ships in its own chunk; keeps the
// initial main bundle small (was 1.9 MB before splitting, all 11 pages
// were bundled together). Routes are mutually exclusive, so only one
// chunk loads per navigation.
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage.jsx").then((m) => ({ default: m.DashboardPage })),
);
const IpCheckPage = lazy(() => import("./pages/IpCheckPage.jsx"));
const ServiceStatusPage = lazy(() => import("./pages/ServiceStatusPage.jsx"));
const AchievementsPage = lazy(() => import("./pages/AchievementsPage.jsx"));
const LandingPage = lazy(() =>
  import("./pages/LandingPage.jsx").then((m) => ({ default: m.LandingPage })),
);
const LeaderboardPage = lazy(() =>
  import("./pages/LeaderboardPage.jsx").then((m) => ({ default: m.LeaderboardPage })),
);
const LeaderboardProfilePage = lazy(() =>
  import("./pages/LeaderboardProfilePage.jsx").then((m) => ({ default: m.LeaderboardProfilePage })),
);
const LimitsPage = lazy(() =>
  import("./pages/LimitsPage.jsx").then((m) => ({ default: m.LimitsPage })),
);
const AccountsPage = lazy(() => import("./pages/AccountsPage.jsx").then((m) => ({ default: m.AccountsPage })));
const LoginPage = lazy(() =>
  import("./pages/LoginPage.jsx").then((m) => ({ default: m.LoginPage })),
);
const ResetPasswordPage = lazy(() =>
  import("./pages/ResetPasswordPage.jsx").then((m) => ({ default: m.ResetPasswordPage })),
);
const DevicePage = lazy(() => import("./pages/DevicePage.jsx"));
const WrappedPage = lazy(() => import("./pages/WrappedPage.jsx"));
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage.jsx").then((m) => ({ default: m.SettingsPage })),
);
const SkillsPage = lazy(() =>
  import("./pages/SkillsPage.jsx").then((m) => ({ default: m.SkillsPage })),
);
const SessionsPage = lazy(() =>
  import("./pages/SessionsPage.jsx").then((m) => ({ default: m.SessionsPage })),
);
const WidgetsPage = lazy(() =>
  import("./pages/WidgetsPage.jsx").then((m) => ({ default: m.WidgetsPage })),
);
const PetPage = lazy(() =>
  import("./pages/PetPage.jsx").then((m) => ({ default: m.PetPage })),
);

export default function App() {
  // Subscribing to locale here makes App rerender on language switch, which
  // rebuilds every child element reference and triggers copy() re-evaluation
  // across the tree — without unmounting lazy-loaded pages.
  const { resolvedLocale } = useLocale();
  const location = useLocation();
  const insforge = useInsforgeAuth();
  useCloudUsageSync();
  const dashboardMainContentVisibleRef = useRef(false);
  const dashboardResourcePreloadStartedRef = useRef(false);
  const leaderboardStatePreloadContextKeysRef = useRef(new Set());
  const mockEnabled = isMockEnabled();
  const screenshotMode = useMemo(() => {
    if (typeof window === "undefined") return false;
    return isScreenshotModeEnabled(window.location.search);
  }, []);
  const pathname = location?.pathname || "/";
  const pageUrl = new URL(window.location.href);
  const sharePathname = pageUrl.pathname.replace(/\/+$/, "") || "/";
  const shareMatch = sharePathname.match(/^\/share\/([^/?#]+)$/i);
  const tokenFromPath = shareMatch?.[1] || null;
  const tokenFromQuery = pageUrl.searchParams.get("token") || null;
  const publicToken = tokenFromPath || tokenFromQuery;
  const publicMode =
    sharePathname === "/share" ||
    sharePathname === "/share.html" ||
    sharePathname.startsWith("/share/");

  const isLocalMode =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const isDashboardDefaultPath = normalizedPath === "/" || normalizedPath === "/dashboard";
  const isLeaderboardPath = normalizedPath === "/leaderboard";
  // Standalone shareable profile page: /u/:userId (public, anonymous-visible).
  const profileMatch = normalizedPath.match(/^\/u\/([^/]+)$/i);
  const profileUserId = profileMatch ? profileMatch[1] : null;

  const cloudAuthSignedIn = Boolean(insforge.enabled && insforge.signedIn);
  const signedIn = isLocalMode || cloudAuthSignedIn;
  const sessionSoftExpired = false;
  const baseUrl = getBackendBaseUrl();
  const isAuthGateTriggered = !signedIn && !mockEnabled && !isLocalMode;
  const leaderboardAccessMode = mockEnabled
    ? "mock"
    : insforge.loading
      ? "unavailable"
      : cloudAuthSignedIn
        ? "cloud"
        : signedIn
          ? "local"
          : "unavailable";

  const tryPreloadLeaderboardDefaultState = useCallback(() => {
    if (!dashboardMainContentVisibleRef.current) return;
    if (!mockEnabled && insforge.loading) return;
    if (!mockEnabled && !signedIn) return;
    const preloadOptions = {
      accessMode: leaderboardAccessMode,
      baseUrl: getLeaderboardBaseUrl(),
      mockEnabled,
      signedIn,
      authLoading: Boolean(insforge.loading),
      userId: cloudAuthSignedIn ? insforge.user?.id || null : null,
    };
    const contextKey = getLeaderboardPreloadContextKey(preloadOptions);
    if (leaderboardStatePreloadContextKeysRef.current.has(contextKey)) return;
    leaderboardStatePreloadContextKeysRef.current.add(contextKey);
    void preloadLeaderboardDefaultState(preloadOptions);
  }, [
    cloudAuthSignedIn,
    insforge.loading,
    insforge.user?.id,
    leaderboardAccessMode,
    mockEnabled,
    signedIn,
  ]);

  const handleDashboardMainContentVisible = useCallback(() => {
    if (!isDashboardDefaultPath) return;
    if (!dashboardMainContentVisibleRef.current) {
      dashboardMainContentVisibleRef.current = true;
      markDashboardMainContentVisible();
    }
    if (!dashboardResourcePreloadStartedRef.current) {
      dashboardResourcePreloadStartedRef.current = true;
      void preloadDashboardPageResources();
    }
    tryPreloadLeaderboardDefaultState();
  }, [
    isDashboardDefaultPath,
    tryPreloadLeaderboardDefaultState,
  ]);

  useEffect(() => {
    tryPreloadLeaderboardDefaultState();
  }, [tryPreloadLeaderboardDefaultState]);

  const authObject = useMemo(() => {
    if (!insforge.enabled || !cloudAuthSignedIn) return null;
    return {
      getAccessToken: () => insforge.getAccessToken(),
      name: insforge.displayName || "",
      userId: insforge.user?.id || null,
    };
  }, [cloudAuthSignedIn, insforge]);

  let gate = isLocalMode || mockEnabled || screenshotMode ? "dashboard" : "landing";
  if (normalizedPath === "/landing") gate = "landing";
  if (normalizedPath === "/dashboard") gate = "dashboard";
  if (isLeaderboardPath) gate = "dashboard";
  if (profileUserId) gate = "dashboard";

  const isLimitsPath = normalizedPath === "/limits";
  const isAccountsPath = normalizedPath === "/accounts";
  const isSettingsPath = normalizedPath === "/settings";
  const isSkillsPath = normalizedPath === "/skills";
  const isSessionsPath = normalizedPath === "/sessions";
  const isWidgetsPath = normalizedPath === "/widgets";
  const isPetPath = normalizedPath === "/pet-settings";
  const isIpCheckPath = normalizedPath === "/ip-check";
  const isServiceStatusPath = normalizedPath === "/service-status";
  const isAchievementsPath = normalizedPath === "/achievements";
  if (isAccountsPath || isLimitsPath || isSettingsPath || isSkillsPath || isSessionsPath || isWidgetsPath || isPetPath || isIpCheckPath || isServiceStatusPath || isAchievementsPath) gate = "dashboard";

  let PageComponent = DashboardPage;
  if (profileUserId) {
    PageComponent = LeaderboardProfilePage;
  } else if (normalizedPath === "/leaderboard") {
    PageComponent = LeaderboardPage;
  } else if (isLimitsPath) {
    PageComponent = LimitsPage;
  } else if (isAccountsPath) {
    PageComponent = AccountsPage;
  } else if (isSettingsPath) {
    PageComponent = SettingsPage;
  } else if (isSkillsPath) {
    PageComponent = SkillsPage;
  } else if (isSessionsPath) {
    PageComponent = SessionsPage;
  } else if (isWidgetsPath) {
    PageComponent = WidgetsPage;
  } else if (isPetPath) {
    PageComponent = PetPage;
  } else if (isIpCheckPath) {
    PageComponent = IpCheckPage;
  } else if (isServiceStatusPath) {
    PageComponent = ServiceStatusPage;
  } else if (isAchievementsPath) {
    PageComponent = AchievementsPage;
  }

  const showSidebar =
    !publicMode &&
    !isAuthGateTriggered &&
    (normalizedPath === "/dashboard" ||
      normalizedPath === "/" ||
      isLeaderboardPath ||
      isLimitsPath ||
      isAccountsPath ||
      isSettingsPath ||
      isSkillsPath ||
      isSessionsPath ||
      isWidgetsPath ||
      isPetPath ||
      isIpCheckPath ||
      isServiceStatusPath ||
      isAchievementsPath);

  // Public-host gating: on www.tokentracker.cc et al. there is no local
  // CLI :7680 to fall back to, so dashboard / settings / etc. require a
  // signed-in user. publicMode (shared link) and the loading state are
  // exceptions that handle themselves.
  const publicHostNeedsLogin =
    !isLocalMode &&
    !cloudAuthSignedIn &&
    !publicMode &&
    !insforge.loading &&
    gate === "dashboard" &&
    // Public-readable routes must stay reachable for signed-out visitors:
    // /leaderboard and /u/:userId profiles are deliberate no-auth reads
    // (see api.ts getLeaderboard + LeaderboardProfilePage). Without these
    // exclusions the gate would bounce anonymous share-link traffic to /login.
    !isLeaderboardPath &&
    !profileUserId &&
    normalizedPath !== "/login" &&
    normalizedPath !== "/reset-password" &&
    normalizedPath !== "/landing" &&
    normalizedPath !== "/auth/callback" &&
    normalizedPath !== "/auth/native-callback";
  if (publicHostNeedsLogin) {
    return <Navigate to="/login" replace />;
  }

  let content = null;
  if (normalizedPath === "/auth/callback" || normalizedPath === "/auth/native-callback") {
    content = <NativeAuthCallbackPage />;
  } else if (normalizedPath === "/login") {
    content = <LoginPage />;
  } else if (normalizedPath === "/reset-password") {
    content = <ResetPasswordPage />;
  } else if (normalizedPath === "/device") {
    // Headless-CLI device-flow approval page. Standalone (no sidebar) so
    // unsigned visitors hit the embedded sign-in CTA without sidebar nav
    // confusion. Auth check happens inside DevicePage itself.
    content = <DevicePage />;
  } else if (normalizedPath === "/wrapped") {
    // Year-end Wrapped page. Reads from /functions/tokentracker-wrapped
    // (provided by the local CLI server) — no auth required.
    content = <WrappedPage />;
  } else if (gate === "landing") {
    content = <LandingPage signInUrl="/login" signUpUrl="/login" />;
  } else {
    const pageNode = (
      <PageComponent
        key={resolvedLocale}
        baseUrl={baseUrl}
        auth={authObject}
        signedIn={signedIn}
        sessionSoftExpired={sessionSoftExpired}
        signOut={() => (insforge.enabled ? insforge.signOut() : Promise.resolve())}
        publicMode={publicMode}
        publicToken={publicToken}
        userId={profileUserId}
        signInUrl="/login"
        signUpUrl="/login"
        onMainContentVisible={handleDashboardMainContentVisible}
      />
    );
    if (showSidebar) {
      content = <AppLayout>{pageNode}</AppLayout>;
    } else {
      content = pageNode;
    }
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <LoginModalProvider>
            <Suspense fallback={null}>{content}</Suspense>
            <Suspense fallback={null}>
              {showSidebar ? <CommandPalette /> : null}
              <LoginModal />
              <Analytics />
              <SpeedInsights />
            </Suspense>
          </LoginModalProvider>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
