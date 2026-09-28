import React, { useCallback, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { copy } from "../../../lib/copy.ts";
import { useNativeSettings } from "../../../hooks/use-native-settings.js";
import { isNativeLinuxApp, isNativeWindowsApp } from "../../../lib/native-bridge.js";
import { showToast } from "../../components/Toast.jsx";
import { ToggleSwitch } from "../../../components/settings/Controls.jsx";

const DISMISS_KEY = "islandOnboardingDismissed";

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Ignore storage failures; the card can reappear next session.
  }
}

function clearDismissed() {
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    // Ignore storage failures; React state still restores the card now.
  }
}

/**
 * The menu-bar Clawd as a white monochrome glyph, drawn inline with a tight
 * viewBox (body only, no ground shadow / whitespace) so it stays crisp and
 * vertically centers cleanly next to the wing number — mirroring how the real
 * island renders the status-bar icon as a white template image.
 */
function ClawdGlyph({ className }) {
  return (
    <svg viewBox="0 6 15 9" fill="currentColor" aria-hidden="true" className={className}>
      {/* body (white via currentColor) */}
      <rect x="2" y="6" width="11" height="7" />
      <rect x="0" y="9" width="2" height="2" />
      <rect x="13" y="9" width="2" height="2" />
      <rect x="3" y="13" width="1" height="2" />
      <rect x="5" y="13" width="1" height="2" />
      <rect x="9" y="13" width="1" height="2" />
      <rect x="11" y="13" width="1" height="2" />
      {/* eyes punched out to the island's black background */}
      <rect className="fill-black" x="4" y="8" width="1" height="2" />
      <rect className="fill-black" x="10" y="8" width="1" height="2" />
    </svg>
  );
}

/**
 * Pure-CSS miniature of a MacBook display: quiet aurora wallpaper, translucent
 * menu bar, and the Dynamic Island hugging the notch. Tailwind palette colors
 * only (no hex literals) so it passes the ui-hardcode gate and stays crisp in
 * both themes.
 */
function IslandPreview({ reduceMotion }) {
  return (
    <div
      aria-hidden="true"
      className="relative h-24 overflow-hidden rounded-lg bg-slate-950 ring-1 ring-black/10 dark:ring-white/10"
    >
      {/* muted aurora glows — depth without the poster-paint gradient */}
      <div className="absolute -left-10 -top-12 h-36 w-56 rounded-full bg-indigo-600/25 blur-3xl" />
      <div className="absolute -right-8 top-2 h-32 w-48 rounded-full bg-sky-500/15 blur-3xl" />
      <div className="absolute bottom-[-3rem] left-1/3 h-32 w-64 rounded-full bg-fuchsia-500/10 blur-3xl" />

      {/* menu bar */}
      <div className="absolute inset-x-0 top-0 flex h-[16px] items-center justify-between bg-black/45 px-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span className="h-[3px] w-[3px] rounded-full bg-white/60" />
          <span className="h-[3px] w-5 rounded-full bg-white/30" />
          <span className="h-[3px] w-3.5 rounded-full bg-white/20" />
        </div>
        <div className="flex items-center gap-2">
          <span className="h-[3px] w-3 rounded-full bg-white/20" />
          <span className="h-[3px] w-4 rounded-full bg-white/35" />
        </div>
      </div>

      {/* the island, flush with the top edge, hugging the notch — a compact
          pill, not a full-width bar */}
      <motion.div
        className="absolute left-1/2 top-0 flex h-[22px] -translate-x-1/2 items-center rounded-b-[10px] bg-black pl-2 pr-2.5 shadow-lg shadow-black/60 ring-1 ring-white/[0.06]"
        animate={reduceMotion ? undefined : { opacity: [1, 0.94, 1] }}
        transition={reduceMotion ? undefined : { duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
      >
        <span className="flex items-center gap-1.5 text-[9px] font-semibold tracking-tight text-white/90 tabular-nums">
          {/* the real menu-bar Clawd, white template glyph */}
          <ClawdGlyph className="h-[9px] w-[15px] translate-y-[0.5px] text-white/90" />
          8.2M
        </span>
        {/* the physical notch sits here */}
        <span className="mx-2 h-2.5 w-7 rounded-[2px] bg-black" />
        <span className="text-[9px] font-semibold tracking-tight text-white/90 tabular-nums">
          $12.40
        </span>
      </motion.div>
    </div>
  );
}

/**
 * First-run discovery card for the Dynamic Island (macOS Labs feature, off by
 * default).
 *
 * - Native macOS app: shows while the island is disabled; "Turn on" flips the
 *   setting straight through the bridge.
 * - Plain browser on localhost (leftVisible gates this card to local mode):
 *   shows as a preview so the card is easy to iterate on; the CTA deep-links
 *   into the Mac app instead. Windows tray app never sees it.
 *
 * Dismiss (or enabling) hides it permanently via localStorage.
 */
export function IslandOnboardingCard({ enterDelay = 0 }) {
  const { available, settings, setSetting } = useNativeSettings();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [hideMenuBarIcon, setHideMenuBarIcon] = useState(false);
  const reduceMotion = useReducedMotion();

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed();
  }, []);

  const handleEnable = useCallback(() => {
    if (!available) {
      // Browser preview: no bridge to flip — hand off to the Mac app.
      try {
        window.location.href = "tokentracker://open";
      } catch {
        /* ignore */
      }
      return;
    }
    setSetting("dynamicIslandEnabled", true);
    if (hideMenuBarIcon) {
      setSetting("hideMenuBarIcon", true);
    }
    // Never resurface, even if the user later turns the island back off.
    writeDismissed();
    setDismissed(true);
    showToast({
      title: copy("dashboard.island.enabled_toast"),
      data: {
        onUndo: () => {
          setSetting("hideMenuBarIcon", false);
          setSetting("dynamicIslandEnabled", false);
          clearDismissed();
          setDismissed(false);
        },
      },
    });
  }, [available, hideMenuBarIcon, setSetting]);

  // Native gate: island supported (macOS bridge only) and not yet enabled.
  // Settings must have loaded so we don't flash the card before knowing.
  const showInNativeApp =
    available && Boolean(settings?.dynamicIslandSupported) && !settings?.dynamicIslandEnabled;
  // Browser preview gate: no bridge at all (excludes the Windows and Linux
  // apps, which have no macOS bridge but must not see mac-only promos).
  const showAsBrowserPreview = !available && !isNativeWindowsApp() && !isNativeLinuxApp();
  const show = !dismissed && (showInNativeApp || showAsBrowserPreview);

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="island-onboarding-card"
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 0.35, delay: enterDelay, ease: [0.16, 1, 0.3, 1] }
          }
          className="relative rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-4"
        >
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={copy("dashboard.island.dismiss_aria")}
            className="absolute top-2.5 right-2.5 z-10 inline-flex items-center justify-center w-7 h-7 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-300 dark:focus-visible:ring-oai-gray-600 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M4 4l6 6m0-6L4 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>

          <IslandPreview reduceMotion={reduceMotion} />

          <div className="mt-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium tracking-tight text-oai-gray-900 dark:text-oai-white">
                  {copy("dashboard.island.title")}
                </span>
                <span className="px-1.5 py-0.5 text-[8px] font-semibold tracking-wider text-oai-gray-500 bg-oai-gray-100 dark:text-oai-gray-400 dark:bg-oai-gray-800/80 rounded uppercase scale-90 origin-left">
                  {copy("qpd.card.badge")}
                </span>
              </div>
              <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mt-1 leading-snug">
                {copy("dashboard.island.hint")}
              </div>
            </div>
          </div>

          {available ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-oai-gray-50 px-3 py-2.5 dark:bg-oai-gray-800/60">
              <div className="min-w-0">
                <div className="text-xs font-medium text-oai-gray-800 dark:text-oai-gray-200">
                  {copy("settings.labs.island_hide_menubar.label")}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("settings.labs.island_hide_menubar.hint")}
                </div>
              </div>
              <ToggleSwitch
                checked={hideMenuBarIcon}
                onChange={() => setHideMenuBarIcon((value) => !value)}
                ariaLabel={copy("settings.labs.island_hide_menubar.aria")}
              />
            </div>
          ) : null}

          <div className="mt-3 flex items-center gap-3">
            <motion.button
              type="button"
              onClick={handleEnable}
              whileHover={reduceMotion ? undefined : { scale: 1.03 }}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-oai-gray-900 dark:bg-oai-white dark:text-oai-gray-900 rounded-md hover:opacity-90 transition-opacity"
            >
              {available ? copy("dashboard.island.enable") : copy("local_only.open_app")}
            </motion.button>
            <a
              href="/settings?section=labs"
              className="inline-flex items-center gap-0.5 text-xs font-medium text-oai-gray-500 hover:text-oai-gray-700 dark:text-oai-gray-400 dark:hover:text-oai-gray-200 transition-colors"
            >
              {copy("dashboard.island.settings_link")}
              <ArrowUpRight size={12} strokeWidth={2} aria-hidden />
            </a>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
