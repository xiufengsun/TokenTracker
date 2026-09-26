import React, { useCallback, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { copy } from "../../../lib/copy.ts";
import { usePetSettings } from "../../../hooks/use-pet-settings.js";
import { isNativeLinuxApp } from "../../../lib/native-bridge.js";
import { ClawdAnimated } from "../../foundation/ClawdAnimated.jsx";

const DISMISS_KEY = "linuxPetCardDismissed";

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
 * Home-page discovery card for the Linux app's floating desktop pet — the
 * Linux stand-in for the macOS promos hidden there (PR 674).
 *
 * Linux app only. Shows while the pet is off; "Show pet" turns it on through
 * the same pet bridge the Pet page uses, which also hides the card. Dismiss
 * hides it permanently via localStorage.
 */
export function LinuxPetCard({ enterDelay = 0 }) {
  const { available, settings, setSetting } = usePetSettings();
  const [dismissed, setDismissed] = useState(readDismissed);
  const reduceMotion = useReducedMotion();

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed();
  }, []);

  const handleShow = useCallback(() => {
    setSetting("visible", true);
  }, [setSetting]);

  const show = isNativeLinuxApp() && available && !settings.visible && !dismissed;

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="linux-pet-card"
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
            aria-label={copy("dashboard.linux_pet.dismiss_aria")}
            className="absolute top-2.5 right-2.5 z-10 inline-flex items-center justify-center w-7 h-7 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-300 dark:focus-visible:ring-oai-gray-600 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M4 4l6 6m0-6L4 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>

          <div className="flex items-center gap-3 pr-6">
            <div className="flex-shrink-0">
              <ClawdAnimated state="happy" size={56} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium tracking-tight text-oai-gray-900 dark:text-oai-white">
                {copy("dashboard.linux_pet.title")}
              </div>
              <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mt-1 leading-snug">
                {copy("dashboard.linux_pet.hint")}
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <motion.button
              type="button"
              onClick={handleShow}
              whileHover={reduceMotion ? undefined : { scale: 1.03 }}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-oai-gray-900 dark:bg-oai-white dark:text-oai-gray-900 rounded-md hover:opacity-90 transition-opacity"
            >
              {copy("dashboard.linux_pet.show")}
            </motion.button>
            <a
              href="/pet-settings"
              className="inline-flex items-center gap-0.5 text-xs font-medium text-oai-gray-500 hover:text-oai-gray-700 dark:text-oai-gray-400 dark:hover:text-oai-gray-200 transition-colors"
            >
              {copy("dashboard.linux_pet.settings_link")}
              <ArrowUpRight size={12} strokeWidth={2} aria-hidden />
            </a>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
