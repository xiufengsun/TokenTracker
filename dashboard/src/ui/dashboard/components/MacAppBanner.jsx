import React, { useState, useCallback } from "react";
import { motion } from "motion/react";
import { useLoginModal } from "../../../contexts/LoginModalContext.jsx";
import { useInsforgeAuth } from "../../../contexts/InsforgeAuthContext.jsx";
import { ClawdAnimated } from "../../foundation/ClawdAnimated.jsx";
import { useClawdState } from "../../../hooks/useClawdState.js";
import { isNativeLinuxApp } from "../../../lib/native-bridge.js";

const DISMISS_KEY = "macAppBannerDismissed";
const LOGIN_DISMISS_KEY = "leaderboardBannerDismissed";
const RELEASE_URL = "https://github.com/xiufengsun/TokenTracker/releases/latest";

/** True when loaded inside the native macOS app (WKWebView with ?app=1) */
const NATIVE_APP_KEY = "tokentracker_native_app";
const isNativeApp = (() => {
  try {
    if (new URLSearchParams(window.location.search).get("app") === "1") {
      localStorage.setItem(NATIVE_APP_KEY, "1");
      return true;
    }
    return localStorage.getItem(NATIVE_APP_KEY) === "1";
  } catch { return false; }
})();


/**
 * Context-aware banner:
 * - Native app + signed in → Leaderboard entry
 * - Native app + not signed in → Login CTA
 * - Browser → Download App CTA
 */
export function MacAppBanner({ todayTokens = 0, isSyncing = false, enterDelay = 0 }) {
  const { openLoginModal } = useLoginModal();
  const { signedIn: cloudSignedIn } = useInsforgeAuth();
  const clawdState = useClawdState({ todayTokens, isSyncing });
  const dismissKey = isNativeApp ? LOGIN_DISMISS_KEY : DISMISS_KEY;

  const [dismissed, setDismissed] = useState(() => {
    try {
      if (localStorage.getItem(dismissKey) === "1") return true;
      if (!isNativeApp && new URLSearchParams(window.location.search).get("from") === "menubar") {
        localStorage.setItem(DISMISS_KEY, "1");
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissKey, "1");
    } catch {
      // Ignore storage failures; the banner can reappear next session.
    }
  }, [dismissKey]);

  if (dismissed) return null;
  // The Linux app would otherwise fall through to the macOS download CTA.
  if (!isNativeApp && isNativeLinuxApp()) return null;

  // Determine banner content based on context
  let title, subtitle, buttonLabel, buttonIcon, onButtonClick, buttonHref;

  if (isNativeApp && cloudSignedIn) {
    title = "View the Leaderboard";
    subtitle = "Compare your usage globally";
    buttonLabel = "Leaderboard";
    buttonIcon = (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-70">
        <path d="M2 8.5V10h8V8.5M6 1.5v6m0 0L3.5 5M6 7.5l2.5-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" transform="rotate(180 6 6)"/>
      </svg>
    );
    onButtonClick = () => { window.location.pathname = "/leaderboard"; };
  } else if (isNativeApp) {
    title = "Join the Leaderboard";
    subtitle = "Log in to compare your usage with others";
    buttonLabel = "Log In";
    buttonIcon = (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-70">
        <path d="M6.5 1.5h3a1 1 0 011 1v7a1 1 0 01-1 1h-3M5 8.5L7.5 6 5 3.5M7.5 6H1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
    onButtonClick = openLoginModal;
  } else {
    title = "Try the Menu Bar App";
    subtitle = "Always-on stats with Clawd companion";
    buttonLabel = "Download";
    buttonIcon = (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-70">
        <path d="M6 2v6m0 0L3.5 5.5M6 8l2.5-2.5M2 10h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
    buttonHref = RELEASE_URL;
  }

  const ButtonTag = buttonHref ? motion.a : motion.button;
  const buttonProps = buttonHref
    ? { href: buttonHref, target: "_blank", rel: "noopener noreferrer" }
    : { onClick: onButtonClick };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: enterDelay, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-4"
    >
        <div className="flex items-center gap-3">
          <div className="flex-shrink-0">
            <ClawdAnimated state={clawdState} size={56} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-oai-gray-900 dark:text-oai-white">
              {title}
            </div>
            <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mt-0.5">
              {subtitle}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <ButtonTag
              {...buttonProps}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-oai-gray-900 dark:bg-oai-white dark:text-oai-gray-900 rounded-md hover:opacity-90 transition-opacity"
            >
              {buttonLabel}
              {buttonIcon}
            </ButtonTag>
            <button
              onClick={handleDismiss}
              className="p-1 text-oai-gray-400 hover:text-oai-gray-600 dark:hover:text-oai-gray-300 transition-colors"
              aria-label="Dismiss"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M4 4l6 6m0-6L4 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>
    </motion.div>
  );
}
