import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Award,
  BarChart3,
  Gauge,
  UsersRound,
  Trophy,
  History,
  LayoutGrid,
  PawPrint,
  Globe,
  Puzzle,
  Activity,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { copy } from "../../lib/copy";
import { cn } from "../../lib/cn";
import { useTheme } from "../../hooks/useTheme.js";
import { useLocale } from "../../hooks/useLocale.js";
import { shouldFetchGithubStars } from "../dashboard/util/should-fetch-github-stars.js";
import { InsforgeUserHeaderControls } from "../../components/InsforgeUserHeaderControls.jsx";
import { isNativeApp, isNativeEmbed, isNativeWindowsApp } from "../../lib/native-bridge.js";

const STORAGE_KEY = "tt.sidebarCollapsed";

export function getNavGroups() {
  // copy() must be called at render time so locale switches apply.
  // Validator regex picks up these literal calls.
  return [
    {
      id: "general",
      label: copy("nav.group.general"),
      items: [
        { id: "usage", to: "/dashboard", icon: BarChart3, label: copy("nav.usage") },
        { id: "sessions", to: "/sessions", icon: History, label: copy("nav.sessions") },
        { id: "limits", to: "/limits", icon: Gauge, label: copy("nav.limits") },
        { id: "leaderboard", to: "/leaderboard", icon: Trophy, label: copy("nav.leaderboard") },
        { id: "achievements", to: "/achievements", icon: Award, label: copy("nav.achievements") },
      ],
    },
    {
      id: "tools",
      label: copy("nav.group.tools"),
      items: [
        { id: "widgets", to: "/widgets", icon: LayoutGrid, label: copy("nav.widgets") },
        { id: "pet", to: "/pet-settings", icon: PawPrint, label: copy("nav.pet") },
        { id: "skills", to: "/skills", icon: Puzzle, label: copy("nav.skills") },
        { id: "ip-check", to: "/ip-check", icon: Globe, label: copy("nav.ip_check") },
        { id: "service-status", to: "/service-status", icon: Activity, label: copy("nav.service_status") },
      ],
    },
    {
      id: "account",
      label: copy("nav.group.account"),
      items: [
        { id: "accounts", to: "/accounts", icon: UsersRound, label: copy("nav.ai_accounts") },
        { id: "settings", to: "/settings", icon: SettingsIcon, label: copy("nav.settings") },
      ],
    },
  ];
}

function readCollapsed() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
        }
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e) => {
      if (e.key === STORAGE_KEY) setCollapsed(e.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { collapsed, toggle };
}

function isActive(pathname, to) {
  if (!pathname) return false;
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (to === "/dashboard") {
    return normalized === "/dashboard" || normalized === "/";
  }
  if (to === "/leaderboard") {
    return normalized === "/leaderboard" || normalized.startsWith("/leaderboard/");
  }
  return normalized === to;
}

function NavGroupLabel({ label, collapsed, first }) {
  if (collapsed) {
    if (first) return null;
    return <div className="mx-2 my-2 h-px bg-oai-gray-200/70 dark:bg-oai-gray-800/70" aria-hidden />;
  }
  return (
    <div
      className={cn(
        "px-3 pb-1 text-[10px] uppercase tracking-wider text-oai-gray-500 dark:text-oai-gray-500",
        first ? "pt-2" : "pt-4",
      )}
    >
      {label}
    </div>
  );
}

function NavItem({ item, collapsed, active, onClick }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] no-underline transition-colors",
        collapsed && "justify-center px-0 py-2",
        active
          ? "bg-oai-gray-200/70 text-oai-black font-medium dark:bg-oai-gray-800 dark:text-white"
          : "text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-200/50 hover:text-oai-black dark:hover:bg-oai-gray-800/60 dark:hover:text-white",
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <Icon className="h-[15px] w-[15px]" aria-hidden />
      </span>
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

/**
 * Tertiary icon button — uniform 40×40 (meets WCAG 2.5.5 close enough; AAA prefers 44).
 */
function IconButton({ as = "button", buttonRef, title, onClick, href, children, className: extraClassName, ...rest }) {
  const className = cn(
    "flex h-10 w-10 items-center justify-center rounded-lg text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
    extraClassName,
  );
  if (as === "a") {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} aria-label={title} className={className} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button ref={buttonRef} type="button" title={title} aria-label={title} onClick={onClick} className={className} {...rest}>
      {children}
    </button>
  );
}

/**
 * Refined GitHub Star pill — Linear "Free plan" style: bordered, tight, with text + count.
 * `glassChrome`: Mac 侧栏毛玻璃上：gray-500 描边 — 亮色 /20 更淡，暗色 dark:/30 保持可见。
 */
function StarPill({ repo = "xiufengsun/TokenTracker", glassChrome = false }) {
  const [stars, setStars] = useState(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!shouldFetchGithubStars({ prefersReducedMotion, screenshotCapture: false })) return;
    fetch(`https://api.github.com/repos/${repo}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && typeof data.stargazers_count === "number") setStars(data.stargazers_count);
      })
      .catch(() => {});
  }, [repo]);

  return (
    <a
      href={`https://github.com/${repo}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={stars !== null ? `Star on GitHub (${stars})` : "Star on GitHub"}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
        glassChrome
          ? "border border-gray-500/20 dark:border-gray-500/30 bg-gray-500/[0.04] dark:bg-gray-500/[0.06] backdrop-blur-[2px] text-oai-gray-700 dark:text-oai-gray-300 hover:bg-gray-500/10 dark:hover:bg-gray-500/12 hover:border-gray-500/30 dark:hover:border-gray-500/40 hover:text-oai-black dark:hover:text-white"
          : "border border-oai-gray-200 dark:border-oai-gray-700 text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white hover:border-oai-gray-300 dark:hover:border-oai-gray-600",
      )}
    >
      <svg height="12" viewBox="0 0 16 16" width="12" className="shrink-0 fill-current">
        <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
      </svg>
      <span>{copy("shared.github.star")}</span>
      {stars !== null && (
        <span className="text-[10px] text-oai-gray-500 dark:text-oai-gray-500 tabular-nums">
          {stars}
        </span>
      )}
    </a>
  );
}

/**
 * Compact theme pill — opens a popover with Light / Dark / System options.
 * Matches StarPill's h-7 height; popover opens upward (bottom-left anchored).
 */
const THEME_OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

function ThemePill({ theme, resolvedTheme, onSetTheme, glassChrome = false }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const ActiveIcon = resolvedTheme === "dark" ? Moon : Sun;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-label="Theme"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Theme"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
          glassChrome
            ? "border border-gray-500/20 dark:border-gray-500/30 bg-gray-500/[0.04] dark:bg-gray-500/[0.06] backdrop-blur-[2px] text-oai-gray-700 dark:text-oai-gray-300 hover:bg-gray-500/10 dark:hover:bg-gray-500/12 hover:border-gray-500/30 dark:hover:border-gray-500/40 hover:text-oai-black dark:hover:text-white"
            : "border border-oai-gray-200 dark:border-oai-gray-700 text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white hover:border-oai-gray-300 dark:hover:border-oai-gray-600",
        )}
      >
        <ActiveIcon className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-2 z-50 min-w-[140px] py-1 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 shadow-lg"
        >
          {THEME_OPTIONS.map(({ value, label, Icon }) => {
            const active = theme === value;
            return (
              <button
                key={value}
                type="button"
                role="menuitem"
                onClick={() => { onSetTheme(value); setOpen(false); }}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] transition-colors",
                  active
                    ? "text-oai-black dark:text-white bg-oai-gray-100 dark:bg-oai-gray-800"
                    : "text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/60 hover:text-oai-black dark:hover:text-white",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * SidebarBody — shared markup used by both desktop sticky Sidebar and mobile Drawer.
 *
 * @param {boolean} collapsed - desktop collapsed state (always false in mobile drawer)
 * @param {() => void} onToggleCollapsed - toggle handler (only shown on desktop)
 * @param {() => void} onItemClick - called after a nav item is clicked (used by drawer to close)
 * @param {boolean} showCloseButton - show X close button instead of collapse toggle (mobile)
 * @param {() => void} onClose - close handler for mobile drawer
 * @param {React.RefObject<HTMLButtonElement>} closeButtonRef - mobile close button focus target
 */
function SidebarBody({
  collapsed,
  onToggleCollapsed,
  onItemClick,
  showCloseButton = false,
  onClose,
  closeButtonRef,
  glassChrome = false,
}) {
  const location = useLocation();
  const pathname = location?.pathname || "/";
  const { theme, resolvedTheme, setTheme } = useTheme();
  // Re-compute copy() via getNavGroups when locale changes, otherwise the
  // labels stay stale after a language switch.
  const { resolvedLocale } = useLocale();
  const navGroups = useMemo(() => getNavGroups(), [resolvedLocale]);

  return (
    <>
      {/* Top: identity only — full-width, aligned with nav items (px-2) */}
      <div className={cn("px-2 pt-2 pb-2", collapsed && "flex justify-center")}>
        {showCloseButton ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <InsforgeUserHeaderControls
                variant="sidebar"
                collapsed={collapsed}
                onAfterAction={onItemClick}
              />
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label={copy("nav.close_menu")}
              title={copy("nav.close_menu")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-oai-gray-500 dark:text-oai-gray-500 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 hover:text-oai-gray-900 dark:hover:text-oai-gray-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
            >
              <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        ) : (
          <InsforgeUserHeaderControls
            variant="sidebar"
            collapsed={collapsed}
            onAfterAction={onItemClick}
          />
        )}
      </div>

      {/* Nav */}
      <nav
        aria-label={copy("nav.nav_label")}
        className="flex-1 px-2 pb-2 flex flex-col overflow-y-auto"
      >
        {navGroups.map((group, groupIdx) => (
          <div key={group.id} className="flex flex-col">
            <NavGroupLabel label={group.label} collapsed={collapsed} first={groupIdx === 0} />
            <div className="flex flex-col gap-0.5">
              {group.items
                // Widgets is a macOS-only feature (system widget gallery); hide it in
                // the Windows tray app per the upstream author's request.
                .filter((item) => !(item.to === "/widgets" && isNativeWindowsApp()))
                .map((item) => (
                  <NavItem
                    key={item.id}
                    item={item}
                    collapsed={collapsed}
                    active={isActive(pathname, item.to)}
                    onClick={onItemClick}
                  />
                ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom: tiny utility row — theme (left) + star & collapse (right), aligned with nav px-2 */}
      <div
        className={cn(
          "flex items-center px-2 py-3",
          collapsed ? "flex-col justify-center gap-2" : "justify-between gap-2",
        )}
      >
        <ThemePill theme={theme} resolvedTheme={resolvedTheme} onSetTheme={setTheme} glassChrome={glassChrome} />
        <div className="flex items-center gap-1.5">
          {!collapsed && <StarPill glassChrome={glassChrome} />}
          {!showCloseButton && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? copy("nav.expand") : copy("nav.collapse")}
              title={collapsed ? copy("nav.expand") : copy("nav.collapse")}
              aria-expanded={!collapsed}
              aria-controls="app-sidebar"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-oai-gray-500 dark:text-oai-gray-500 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 hover:text-oai-gray-900 dark:hover:text-oai-gray-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
            >
              {collapsed ? (
                <ChevronRight className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              ) : (
                <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              )}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Desktop Sidebar — visible only on lg+. Fills its parent's height (which is
 * already bounded by AppLayout's fixed-viewport flex container).
 */
function Sidebar({ collapsed, onToggleCollapsed }) {
  const nativeGlass = useMemo(() => {
    if (typeof window === "undefined") return false;
    return isNativeEmbed() || isNativeApp();
  }, []);

  return (
    <aside
      data-native-sidebar
      id="app-sidebar"
      data-sidebar-state={collapsed ? "collapsed" : "expanded"}
      aria-label={copy("nav.aside_label")}
      className={cn(
        "hidden lg:flex flex-col shrink-0 h-full min-h-0 transition-[width] duration-200",
        collapsed ? "w-[72px]" : "w-[220px]",
      )}
    >
      <SidebarBody collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} glassChrome={nativeGlass} />
    </aside>
  );
}

/**
 * Mobile drawer — slides in from the left, full-height overlay.
 */
function MobileDrawer({ open, onClose, onDesktopBreakpointClose }) {
  const drawerRef = useRef(null);
  const closeButtonRef = useRef(null);

  // Put focus on the close action when the drawer opens and keep keyboard focus
  // inside the modal drawer until it closes.
  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab") return;

      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = drawer.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // An open mobile drawer must be reset when the viewport crosses the desktop
  // breakpoint, otherwise it can reappear on the next narrow-window visit.
  useEffect(() => {
    if (!open || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const desktopQuery = window.matchMedia("(min-width: 1024px)");
    const onBreakpointChange = (event) => {
      if (event.matches) onDesktopBreakpointClose();
    };
    if (desktopQuery.matches) {
      onDesktopBreakpointClose();
      return;
    }
    if (desktopQuery.addEventListener) {
      desktopQuery.addEventListener("change", onBreakpointChange);
      return () => desktopQuery.removeEventListener("change", onBreakpointChange);
    }
    desktopQuery.addListener?.(onBreakpointChange);
    return () => desktopQuery.removeListener?.(onBreakpointChange);
  }, [open, onDesktopBreakpointClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="lg:hidden fixed inset-0 z-[80] flex">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <aside
        ref={drawerRef}
        id="mobile-navigation-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={copy("nav.aside_label")}
        className="relative w-[260px] max-w-[80vw] flex flex-col bg-oai-white dark:bg-oai-gray-900 border-r border-oai-gray-200 dark:border-oai-gray-800 shadow-2xl"
      >
        <SidebarBody
          collapsed={false}
          showCloseButton
          onClose={onClose}
          closeButtonRef={closeButtonRef}
          onItemClick={onClose}
        />
      </aside>
    </div>
  );
}

/**
 * Mobile top bar — shows hamburger + brand on screens < lg.
 */
function MobileTopBar({ open, onOpenDrawer, menuButtonRef }) {
  return (
    <div className="lg:hidden flex items-center justify-between gap-2 px-3 h-14 border-b border-oai-gray-200 dark:border-oai-gray-800">
      <IconButton
        buttonRef={menuButtonRef}
        title={copy("nav.menu")}
        onClick={onOpenDrawer}
        aria-expanded={open}
        aria-controls="mobile-navigation-drawer"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </IconButton>
      <Link
        to="/landing"
        className="flex items-center gap-2 no-underline hover:opacity-80 transition-opacity"
        aria-label="Token Tracker"
      >
        <img src="/app-icon.png" alt="" width={24} height={24} className="rounded-md" />
        <span className="text-sm font-semibold text-oai-black dark:text-oai-white">
          Token Tracker
        </span>
      </Link>
      <div className="w-10 shrink-0" aria-hidden />
    </div>
  );
}

/**
 * AppLayout — outer wash + sidebar + rounded content card on the right.
 *
 * Desktop (lg+): sticky sidebar on the left, rounded content card on the right.
 * Mobile (< lg): full-width content card with a top bar (hamburger + brand);
 *                tapping hamburger opens a slide-in drawer with the same nav.
 */
export function AppLayout({ children }) {
  const { collapsed, toggle } = useSidebarCollapsed();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const mainContentRef = useRef(null);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    // Restore focus to the control that opened the drawer for keyboard and
    // assistive-technology users.
    menuButtonRef.current?.focus();
  }, []);
  const closeDrawerForDesktop = useCallback(() => {
    setDrawerOpen(false);
    const focusMainContent = () => mainContentRef.current?.focus();
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focusMainContent);
    } else {
      focusMainContent();
    }
  }, []);

  /** macOS WKWebView：底层由 NSVisualEffectView 提供模糊，Web 根布局透明，侧栏浮在背景上；浏览器仍用灰色底。 */
  const nativeEmbed = useMemo(() => {
    if (typeof window === "undefined") return false;
    return isNativeEmbed() || isNativeApp();
  }, []);

  return (
    <div
      className={cn(
        "fixed inset-0 flex flex-col text-oai-black dark:text-oai-white font-sans overflow-hidden",
        isNativeWindowsApp() && "tt-native-glass-shell",
        nativeEmbed ? "bg-transparent" : "bg-oai-gray-100 dark:bg-oai-gray-950",
      )}
    >
      {nativeEmbed && (
        <div
          className="h-7 shrink-0"
          style={{ WebkitAppRegion: "drag" }}
          aria-hidden
        />
      )}
      <div className="flex-1 min-h-0 flex">
        <Sidebar collapsed={collapsed} onToggleCollapsed={toggle} />
        <MobileDrawer
          open={drawerOpen}
          onClose={closeDrawer}
          onDesktopBreakpointClose={closeDrawerForDesktop}
        />
        {/* lg：与侧栏内容区对齐 — 侧栏底部按钮区为 px-2 py-3；主卡右侧/底侧用 pr-3 pb-3 与 py-3 视觉一致，避免仅靠 p-2 显得贴边 */}
        {/* Mac App：`lg:pr-3 lg:pb-3` (12pt) 须与 Swift `DashboardChromeMetrics.mainGutterPoints` 一致，主卡圆角由 `--tt-main-card-radius` 注入 */}
        <div className="flex-1 min-w-0 min-h-0 p-2 lg:pl-0 lg:pr-3 lg:pb-3 flex flex-col">
          <div
            className={cn(
              "flex-1 min-h-0 flex flex-col bg-oai-white dark:bg-oai-gray-900 border border-oai-gray-200 dark:border-oai-gray-800 overflow-hidden",
              nativeEmbed ? "tt-native-main-card" : "rounded-2xl",
              !nativeEmbed && "shadow-sm",
            )}
          >
            <MobileTopBar open={drawerOpen} onOpenDrawer={openDrawer} menuButtonRef={menuButtonRef} />
            <div
              ref={mainContentRef}
              id="app-main-content"
              tabIndex={-1}
              className="flex-1 min-h-0 overflow-y-auto"
            >
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
