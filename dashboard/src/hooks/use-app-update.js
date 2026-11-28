import { useCallback } from "react";
import { isNativeWindowsApp } from "../lib/native-bridge.js";
import { useNativeSettings } from "./use-native-settings.js";

/**
 * Strip leading 'v' prefixes and build/prerelease suffixes from a version string.
 * @param {unknown} version
 * @returns {string}
 */
export function normalizeVersion(version) {
  if (typeof version !== "string") return "";
  return version.trim().replace(/^v/i, "").split(/[+-]/)[0];
}

/**
 * Compare two dotted numeric version strings and return true when `latest` > `current`.
 * @param {string} current
 * @param {string} latest
 * @returns {boolean}
 */
export function isNewerVersion(current, latest) {
  const currNorm = normalizeVersion(current);
  const lateNorm = normalizeVersion(latest);
  if (!currNorm || !lateNorm) return false;

  const currParts = currNorm.split(".").map((n) => parseInt(n, 10) || 0);
  const lateParts = lateNorm.split(".").map((n) => parseInt(n, 10) || 0);
  const length = Math.max(currParts.length, lateParts.length);

  for (let i = 0; i < length; i += 1) {
    const currVal = currParts[i] || 0;
    const lateVal = lateParts[i] || 0;
    if (currVal < lateVal) return true;
    if (currVal > lateVal) return false;
  }
  return false;
}

/**
 * Global application update state hook.
 *
 * Scoped strictly to the Windows desktop client (`WebView2` host), consuming
 * native update state, download progress, and error feedback from
 * `native:settings`. Returns inactive defaults on web/cloud, macOS, and Linux.
 */
export function useAppUpdate() {
  const {
    available: nativeAvailable,
    settings: nativeSettings,
    runAction,
  } = useNativeSettings();

  const fallbackVersion = normalizeVersion(
    import.meta.env?.VITE_APP_VERSION || "0.64.2",
  );
  const currentVersion =
    normalizeVersion(nativeSettings?.version) || fallbackVersion;

  const isWindowsHost = isNativeWindowsApp();
  const nativeSettingsLoading = isWindowsHost && nativeSettings === null;
  const isWindowsClient =
    isWindowsHost &&
    nativeAvailable &&
    !nativeSettingsLoading &&
    (nativeSettings?.platform == null || nativeSettings.platform === "windows");

  const nativeLatest = normalizeVersion(nativeSettings?.latestVersion);
  const latestVersion = isWindowsClient ? nativeLatest : "";
  const hasUpdate = isWindowsClient && Boolean(nativeSettings?.updateAvailable);
  const updateInProgress =
    isWindowsClient &&
    (typeof nativeSettings?.updateInProgress === "boolean"
      ? nativeSettings.updateInProgress
      : Boolean(nativeSettings?.updateBusy && nativeLatest));

  const updateBusy = isWindowsClient && Boolean(nativeSettings?.updateBusy);
  const updateStatus = isWindowsClient
    ? nativeSettings?.updateStatus || null
    : null;
  const updateError = isWindowsClient
    ? nativeSettings?.updateError || null
    : null;

  const triggerUpdate = useCallback(() => {
    if (!isWindowsClient) return;
    if (nativeSettings?.updateAvailable) {
      runAction("updateNow");
    } else {
      runAction("checkForUpdates");
    }
  }, [isWindowsClient, nativeSettings?.updateAvailable, runAction]);

  return {
    hasUpdate,
    updateInProgress,
    currentVersion,
    latestVersion,
    updateBusy,
    updateStatus,
    updateError,
    triggerUpdate,
  };
}
