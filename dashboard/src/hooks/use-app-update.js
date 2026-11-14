import { useCallback, useEffect, useState } from "react";
import { useNativeSettings } from "./use-native-settings.js";

const GITHUB_RELEASE_API_URL =
  "https://api.github.com/repos/xiufengsun/TokenTracker/releases/latest";
const GITHUB_RELEASE_PAGE_URL =
  "https://github.com/xiufengsun/TokenTracker/releases/latest";
const RELEASE_CACHE_KEY = "tt.githubLatestRelease";
const RELEASE_CACHE_TTL_MS = 30 * 60 * 1000;

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
 * Read the cached GitHub release metadata from sessionStorage if still within the TTL.
 * @returns {{ latestVersion: string, htmlUrl: string } | null}
 */
function readCachedRelease() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(RELEASE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.latestVersion !== "string" ||
      typeof parsed.timestamp !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.timestamp > RELEASE_CACHE_TTL_MS) {
      return null;
    }
    return {
      latestVersion: normalizeVersion(parsed.latestVersion),
      htmlUrl: parsed.htmlUrl || GITHUB_RELEASE_PAGE_URL,
    };
  } catch {
    return null;
  }
}

/**
 * Persist GitHub release metadata into sessionStorage with a timestamp.
 * @param {string} latestVersion
 * @param {string} htmlUrl
 */
function writeCachedRelease(latestVersion, htmlUrl) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      RELEASE_CACHE_KEY,
      JSON.stringify({
        latestVersion: normalizeVersion(latestVersion),
        htmlUrl: htmlUrl || GITHUB_RELEASE_PAGE_URL,
        timestamp: Date.now(),
      }),
    );
  } catch {
    /* ignore storage errors */
  }
}

/**
 * Global application update state hook.
 *
 * Consumes native bridge settings when running inside the desktop host and
 * falls back to checking GitHub Releases (with a 30-minute sessionStorage
 * cache) in web mode.
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

  const [webRelease, setWebRelease] = useState(readCachedRelease);

  const nativeSettingsLoading = nativeAvailable && nativeSettings === null;
  const hasExplicitNativeUpdateState =
    nativeAvailable && typeof nativeSettings?.updateAvailable === "boolean";

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      nativeSettingsLoading ||
      hasExplicitNativeUpdateState
    ) {
      return undefined;
    }

    const cached = readCachedRelease();
    if (cached) {
      setWebRelease(cached);
      return undefined;
    }

    let cancelled = false;
    fetch(GITHUB_RELEASE_API_URL)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data || typeof data.tag_name !== "string") return;
        const latestVersion = normalizeVersion(data.tag_name);
        const htmlUrl = data.html_url || GITHUB_RELEASE_PAGE_URL;
        writeCachedRelease(latestVersion, htmlUrl);
        setWebRelease({ latestVersion, htmlUrl });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [hasExplicitNativeUpdateState, nativeSettingsLoading]);

  const nativeLatest = normalizeVersion(nativeSettings?.latestVersion);
  const latestVersion = nativeLatest || webRelease?.latestVersion || "";
  const hasUpdate =
    !nativeSettingsLoading &&
    (hasExplicitNativeUpdateState
      ? Boolean(nativeSettings.updateAvailable)
      : isNewerVersion(currentVersion, latestVersion));

  const updateBusy = Boolean(nativeSettings?.updateBusy);
  const updateStatus = nativeSettings?.updateStatus || null;
  const updateError = nativeSettings?.updateError || null;

  const triggerUpdate = useCallback(() => {
    if (nativeAvailable) {
      if (nativeSettings?.updateAvailable) {
        runAction("updateNow");
      } else {
        runAction("checkForUpdates");
      }
      return;
    }
    if (typeof window !== "undefined") {
      window.open(
        webRelease?.htmlUrl || GITHUB_RELEASE_PAGE_URL,
        "_blank",
        "noopener,noreferrer",
      );
    }
  }, [nativeAvailable, nativeSettings?.updateAvailable, runAction, webRelease?.htmlUrl]);

  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    updateBusy,
    updateStatus,
    updateError,
    triggerUpdate,
  };
}
