import React, { useCallback, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { copy } from "../../../lib/copy.ts";
import { isNativeLinuxApp } from "../../../lib/native-bridge.js";
import { ClawdGlyph } from "./IslandOnboardingCard.jsx";

const DISMISS_KEY = "linuxTopBarCardDismissed";
const SETUP_URL =
  "https://github.com/xiufengsun/TokenTracker/tree/main/TokenTrackerLinux/gnome-extension/tokentracker@tokentracker.cc#readme";

// Sample figures for the illustration — not copy, never translated.
const PREVIEW_READOUT = "8.2M · $12.40";

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

/**
 * Pure-CSS miniature of the GNOME top bar with the TokenTracker indicator:
 * Activities pill on the left, clock in the middle, Clawd + today's tokens and
 * spend beside the system icons. Tailwind palette colors only (no hex
 * literals) so it passes the ui-hardcode gate.
 */
function TopBarPreview() {
  return (
    <div
      aria-hidden="true"
      className="relative h-24 overflow-hidden rounded-lg bg-slate-800 ring-1 ring-black/10 dark:ring-white/10"
    >
      <div className="absolute -left-10 top-4 h-36 w-56 rounded-full bg-orange-500/20 blur-3xl" />
      <div className="absolute -right-8 top-8 h-32 w-48 rounded-full bg-purple-600/25 blur-3xl" />

      {/* top bar */}
      <div className="absolute inset-x-0 top-0 flex h-[22px] items-center justify-between bg-black px-2.5">
        <span className="h-[7px] w-7 rounded-full bg-white/70" />
        <span className="absolute left-1/2 h-[3px] w-10 -translate-x-1/2 rounded-full bg-white/60" />
        <div className="flex items-center gap-2">
          {/* the TokenTracker indicator, highlighted like an open menu */}
          <span className="flex items-center gap-1 rounded-full bg-white/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-tight text-white/90 tabular-nums">
            <ClawdGlyph className="h-[9px] w-[15px] translate-y-[0.5px] text-white/90" />
            {PREVIEW_READOUT}
          </span>
          <span className="h-[5px] w-[5px] rounded-full bg-white/50" />
          <span className="h-[5px] w-[5px] rounded-full bg-white/50" />
          <span className="h-[5px] w-2.5 rounded-sm bg-white/50" />
        </div>
      </div>

      {/* the dropdown peeking out under the indicator */}
      <div className="absolute right-10 top-[26px] w-28 rounded-md bg-oai-gray-900/95 p-1.5 ring-1 ring-white/10">
        <div className="flex gap-1">
          <span className="h-5 flex-1 rounded bg-white/10" />
          <span className="h-5 flex-1 rounded bg-white/10" />
        </div>
        <span className="mt-1.5 block h-[3px] w-3/4 rounded-full bg-white/30" />
        <span className="mt-1 block h-[3px] w-1/2 rounded-full bg-white/20" />
        <span className="mt-1 block h-[3px] w-2/3 rounded-full bg-white/20" />
      </div>
    </div>
  );
}

/**
 * Home-page discovery card for the GNOME Shell top-bar extension — the Linux
 * counterpart of the macOS menu bar item, whose promo is hidden on Linux.
 *
 * Linux app only. "Set up" opens the extension's install guide in the system
 * browser (the app routes target="_blank" links there). Dismiss hides it
 * permanently via localStorage.
 */
export function LinuxTopBarCard({ enterDelay = 0 }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const reduceMotion = useReducedMotion();

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed();
  }, []);

  const show = isNativeLinuxApp() && !dismissed;

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="linux-topbar-card"
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
            aria-label={copy("dashboard.linux_topbar.dismiss_aria")}
            className="absolute top-2.5 right-2.5 z-10 inline-flex items-center justify-center w-7 h-7 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-300 dark:focus-visible:ring-oai-gray-600 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M4 4l6 6m0-6L4 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>

          <TopBarPreview />

          <div className="mt-4 min-w-0">
            <div className="text-sm font-medium tracking-tight text-oai-gray-900 dark:text-oai-white">
              {copy("dashboard.linux_topbar.title")}
            </div>
            <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mt-1 leading-snug">
              {copy("dashboard.linux_topbar.hint")}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <motion.a
              href={SETUP_URL}
              target="_blank"
              rel="noopener noreferrer"
              whileHover={reduceMotion ? undefined : { scale: 1.03 }}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-oai-gray-900 dark:bg-oai-white dark:text-oai-gray-900 rounded-md hover:opacity-90 transition-opacity"
            >
              {copy("dashboard.linux_topbar.setup")}
              <ArrowUpRight size={12} strokeWidth={2} aria-hidden />
            </motion.a>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
