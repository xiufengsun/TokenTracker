import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isNativeEmbed,
  onNativeSettings,
  requestNativeSettings,
  setNativeSetting,
} from "../lib/native-bridge";

/**
 * Display preferences for the Usage Limits panel.
 *
 * Uses Dashboard localStorage as the persistence entry point, then mirrors the
 * full limitsPreferences snapshot through the macOS NativeBridge so the
 * Dashboard and menu bar converge on the same preferences.
 */

import {
  LIMIT_PROVIDER_ICON_KEYS,
  LIMIT_PROVIDER_IDS,
  limitProviderIconKey,
  limitProviderName,
} from "../lib/limits-providers.js";

const ALL_LIMIT_PROVIDERS = LIMIT_PROVIDER_IDS;

export { LIMIT_PROVIDER_ICON_KEYS, limitProviderIconKey, limitProviderName };

const ORDER_KEY = "tt.limits.providerOrder";
const VISIBILITY_KEY = "tt.limits.providerVisibility";
const DISPLAY_MODE_KEY = "tt.limits.displayMode";
const SHOW_SUBSCRIPTIONS_KEY = "tt.limits.showSubscriptions";
const UPDATED_AT_KEY = "tt.limits.updatedAt";
const NATIVE_PREFERENCES_KEY = "limitsPreferences";
const NATIVE_DISPLAY_MODE_KEY = "limitsDisplayMode";

/**
 * Dispatched on `window` whenever a limits-preferences snapshot is applied —
 * the `storage` event never fires in the window that made the change, so
 * same-window consumers (and the native mirror landing through applySnapshot)
 * need this to re-read the saved selection.
 */
export const LIMITS_PREFS_CHANGED_EVENT = "tt:limits-prefs-changed";

export const LIMIT_DISPLAY_MODES = Object.freeze({
  USED: "used",
  REMAINING: "remaining",
});

const VALID_DISPLAY_MODES = new Set(Object.values(LIMIT_DISPLAY_MODES));
const STORAGE_KEYS = new Set([
  ORDER_KEY,
  VISIBILITY_KEY,
  DISPLAY_MODE_KEY,
  SHOW_SUBSCRIPTIONS_KEY,
  UPDATED_AT_KEY,
]);

function defaultOrder() {
  return [...ALL_LIMIT_PROVIDERS];
}

// Providers that read local credentials or call a subscription quota API only
// after the user turns them on in Settings > Usage & Limits > Providers. The
// stored selection doubles as the opt-in flag the local API requires before
// reading credentials, so they default OFF — display-only providers stay on.
const OPT_IN_PROVIDERS = new Set(["devin"]);

function defaultVisibility() {
  return Object.fromEntries(
    ALL_LIMIT_PROVIDERS.map((id) => [id, !OPT_IN_PROVIDERS.has(id)]),
  );
}

function normalizeOrder(value) {
  const known = [];
  if (Array.isArray(value)) {
    for (const id of value) {
      if (ALL_LIMIT_PROVIDERS.includes(id) && !known.includes(id)) {
        known.push(id);
      }
    }
  }
  for (const id of ALL_LIMIT_PROVIDERS) {
    if (!known.includes(id)) known.push(id);
  }
  return known;
}

function normalizeVisibility(value) {
  const merged = defaultVisibility();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return merged;
  }
  for (const id of ALL_LIMIT_PROVIDERS) {
    if (typeof value[id] === "boolean") merged[id] = value[id];
  }
  return merged;
}

function normalizeDisplayMode(value) {
  return VALID_DISPLAY_MODES.has(value) ? value : LIMIT_DISPLAY_MODES.USED;
}

function normalizeShowSubscriptions(value) {
  return typeof value === "boolean" ? value : true;
}

function normalizeUpdatedAt(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const updatedAt = Number(trimmed);
    return Number.isSafeInteger(updatedAt) ? updatedAt : undefined;
  }
  return undefined;
}

function normalizeSnapshot(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    displayMode: normalizeDisplayMode(source.displayMode),
    providerOrder: normalizeOrder(source.providerOrder),
    providerVisibility: normalizeVisibility(source.providerVisibility),
    showSubscriptions: normalizeShowSubscriptions(source.showSubscriptions),
    updatedAt: normalizeUpdatedAt(source.updatedAt),
  };
}

function readOrder() {
  if (typeof window === "undefined") return defaultOrder();
  try {
    const raw = window.localStorage.getItem(ORDER_KEY);
    return normalizeOrder(raw ? JSON.parse(raw) : undefined);
  } catch {
    return defaultOrder();
  }
}

function readVisibility() {
  if (typeof window === "undefined") return defaultVisibility();
  try {
    const raw = window.localStorage.getItem(VISIBILITY_KEY);
    return normalizeVisibility(raw ? JSON.parse(raw) : undefined);
  } catch {
    return defaultVisibility();
  }
}

/** `storage`-event key filter matching every key this module persists. */
export function isLimitsPrefsStorageKey(key) {
  return key === null || STORAGE_KEYS.has(key);
}

/**
 * The saved Devin provider selection — the opt-in fact every usage-limits
 * request must forward. Only an explicit `true` in stored visibility counts;
 * anything else (absent, default-filled, non-boolean) is off.
 */
export function isDevinProviderSelected() {
  return readVisibility().devin === true;
}

function readDisplayMode() {
  if (typeof window === "undefined") return LIMIT_DISPLAY_MODES.USED;
  try {
    const raw = window.localStorage.getItem(DISPLAY_MODE_KEY);
    return VALID_DISPLAY_MODES.has(raw) ? raw : LIMIT_DISPLAY_MODES.USED;
  } catch {
    return LIMIT_DISPLAY_MODES.USED;
  }
}

function readShowSubscriptions() {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SHOW_SUBSCRIPTIONS_KEY);
    if (raw === null) return true;
    return normalizeShowSubscriptions(JSON.parse(raw));
  } catch {
    return true;
  }
}

function readUpdatedAt() {
  if (typeof window === "undefined") return undefined;
  try {
    return normalizeUpdatedAt(window.localStorage.getItem(UPDATED_AT_KEY));
  } catch {
    return undefined;
  }
}

function hasLocalLimitsPreferenceKeys() {
  if (typeof window === "undefined") return false;
  try {
    for (const key of STORAGE_KEYS) {
      if (window.localStorage.getItem(key) !== null) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function readLocalSnapshot() {
  return normalizeSnapshot({
    displayMode: readDisplayMode(),
    providerOrder: readOrder(),
    providerVisibility: readVisibility(),
    showSubscriptions: readShowSubscriptions(),
    updatedAt: readUpdatedAt(),
  });
}

function writeLocalSnapshot(snapshot) {
  if (typeof window === "undefined") return;
  const normalized = normalizeSnapshot(snapshot);
  try {
    window.localStorage.setItem(
      ORDER_KEY,
      JSON.stringify(normalized.providerOrder),
    );
    window.localStorage.setItem(
      VISIBILITY_KEY,
      JSON.stringify(normalized.providerVisibility),
    );
    window.localStorage.setItem(DISPLAY_MODE_KEY, normalized.displayMode);
    window.localStorage.setItem(
      SHOW_SUBSCRIPTIONS_KEY,
      JSON.stringify(normalized.showSubscriptions),
    );
    if (normalized.updatedAt === undefined) {
      window.localStorage.removeItem(UPDATED_AT_KEY);
    } else {
      window.localStorage.setItem(UPDATED_AT_KEY, String(normalized.updatedAt));
    }
  } catch (error) {
    console.warn("[tokentracker] limits preferences localStorage write failed:", error);
  }
}

function toBridgeSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  return {
    displayMode: normalized.displayMode,
    providerOrder: [...normalized.providerOrder],
    providerVisibility: { ...normalized.providerVisibility },
    showSubscriptions: normalized.showSubscriptions,
    updatedAt: normalized.updatedAt ?? null,
  };
}

function nextUpdatedAt(...currentUpdatedAts) {
  let latest;
  for (const value of currentUpdatedAts) {
    const updatedAt = normalizeUpdatedAt(value);
    if (updatedAt === undefined) continue;
    latest = latest === undefined ? updatedAt : Math.max(latest, updatedAt);
  }
  const now = Date.now();
  if (latest !== undefined && now <= latest) {
    return latest + 1;
  }
  return now;
}

function sameOrder(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sameVisibility(a, b) {
  return ALL_LIMIT_PROVIDERS.every((id) => a[id] === b[id]);
}

function samePreferences(a, b) {
  return (
    a.displayMode === b.displayMode &&
    sameOrder(a.providerOrder, b.providerOrder) &&
    sameVisibility(a.providerVisibility, b.providerVisibility) &&
    a.showSubscriptions === b.showSubscriptions
  );
}

function sameSnapshot(a, b) {
  return (
    samePreferences(a, b) &&
    normalizeUpdatedAt(a.updatedAt) === normalizeUpdatedAt(b.updatedAt)
  );
}

function snapshotIsNewer(candidateSnapshot, currentSnapshot) {
  const candidateUpdatedAt = normalizeUpdatedAt(candidateSnapshot.updatedAt);
  const currentUpdatedAt = normalizeUpdatedAt(currentSnapshot.updatedAt);
  return (
    candidateUpdatedAt !== undefined &&
    (currentUpdatedAt === undefined || candidateUpdatedAt > currentUpdatedAt)
  );
}

export function useLimitsDisplayPrefs() {
  const [prefs, setPrefs] = useState(readLocalSnapshot);
  const prefsRef = useRef(prefs);

  const applySnapshot = useCallback((snapshot, options = {}) => {
    const next = normalizeSnapshot(snapshot);
    prefsRef.current = next;
    setPrefs(next);
    if (options.writeLocal) writeLocalSnapshot(next);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(LIMITS_PREFS_CHANGED_EVENT));
    }
    return next;
  }, []);

  const sendNativeSnapshot = useCallback((snapshot) => {
    if (isNativeEmbed()) {
      setNativeSetting(NATIVE_PREFERENCES_KEY, toBridgeSnapshot(snapshot));
    }
  }, []);

  const commitUserChange = useCallback((buildNext) => {
    const localSnapshot = readLocalSnapshot();
    const current = snapshotIsNewer(localSnapshot, prefsRef.current)
      ? applySnapshot(localSnapshot)
      : prefsRef.current;
    const nextValues = normalizeSnapshot(buildNext(current));
    if (samePreferences(current, nextValues)) return;
    const updatedAt = nextUpdatedAt(
      localSnapshot.updatedAt,
      current.updatedAt,
    );
    const next = applySnapshot(
      { ...nextValues, updatedAt },
      { writeLocal: true },
    );
    sendNativeSnapshot(next);
  }, [applySnapshot, sendNativeSnapshot]);

  const setDisplayMode = useCallback((mode) => {
    if (!VALID_DISPLAY_MODES.has(mode)) return;
    commitUserChange((current) => ({ ...current, displayMode: mode }));
  }, [commitUserChange]);

  const setShowSubscriptions = useCallback((value) => {
    commitUserChange((current) => ({ ...current, showSubscriptions: Boolean(value) }));
  }, [commitUserChange]);

  const applyLegacyDisplayMode = useCallback((mode) => {
    if (!VALID_DISPLAY_MODES.has(mode)) return;
    const dashboardSnapshot = readLocalSnapshot();
    if (dashboardSnapshot.updatedAt !== undefined) {
      applySnapshot(dashboardSnapshot);
      return;
    }
    applySnapshot(
      { ...dashboardSnapshot, displayMode: mode, updatedAt: undefined },
      { writeLocal: true },
    );
  }, [applySnapshot]);

  // The macOS bridge now sends full mirror snapshots; the old displayMode field
  // remains only for compatibility.
  useEffect(() => {
    if (!isNativeEmbed()) return undefined;
    const unsubscribe = onNativeSettings((detail) => {
      const nativePrefs = detail?.[NATIVE_PREFERENCES_KEY];
      if (nativePrefs && typeof nativePrefs === "object") {
        const nativeSnapshot = normalizeSnapshot(nativePrefs);
        if (!hasLocalLimitsPreferenceKeys()) {
          applySnapshot(nativeSnapshot, { writeLocal: true });
          return;
        }
        const dashboardSnapshot = readLocalSnapshot();
        if (snapshotIsNewer(nativeSnapshot, dashboardSnapshot)) {
          applySnapshot(nativeSnapshot, { writeLocal: true });
        } else {
          const dashboard = applySnapshot(dashboardSnapshot);
          if (!sameSnapshot(nativeSnapshot, dashboardSnapshot)) {
            sendNativeSnapshot(dashboard);
          }
        }
        return;
      }
      applyLegacyDisplayMode(detail?.[NATIVE_DISPLAY_MODE_KEY]);
    });
    requestNativeSettings();
    return unsubscribe;
  }, [applyLegacyDisplayMode, applySnapshot, sendNativeSnapshot]);

  // Cross-tab updates only apply the local snapshot. They do not create a new
  // timestamp or write back to native.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e) => {
      if (e.key === null || STORAGE_KEYS.has(e.key)) {
        applySnapshot(readLocalSnapshot());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [applySnapshot]);

  const toggle = useCallback((id) => {
    if (!ALL_LIMIT_PROVIDERS.includes(id)) return;
    commitUserChange((current) => ({
      ...current,
      providerVisibility: {
        ...current.providerVisibility,
        [id]: !current.providerVisibility[id],
      },
    }));
  }, [commitUserChange]);

  const setAllVisible = useCallback((visible) => {
    commitUserChange((current) => ({
      ...current,
      providerVisibility: Object.fromEntries(ALL_LIMIT_PROVIDERS.map((id) => [id, Boolean(visible)])),
    }));
  }, [commitUserChange]);

  const moveUp = useCallback((id) => {
    commitUserChange((current) => {
      const idx = current.providerOrder.indexOf(id);
      if (idx <= 0) return current;
      const providerOrder = [...current.providerOrder];
      [providerOrder[idx - 1], providerOrder[idx]] = [
        providerOrder[idx],
        providerOrder[idx - 1],
      ];
      return { ...current, providerOrder };
    });
  }, [commitUserChange]);

  const moveDown = useCallback((id) => {
    commitUserChange((current) => {
      const idx = current.providerOrder.indexOf(id);
      if (idx < 0 || idx >= current.providerOrder.length - 1) return current;
      const providerOrder = [...current.providerOrder];
      [providerOrder[idx], providerOrder[idx + 1]] = [
        providerOrder[idx + 1],
        providerOrder[idx],
      ];
      return { ...current, providerOrder };
    });
  }, [commitUserChange]);

  /**
   * Reorder by dragging `sourceId` to the position of `targetId`.
   * Matches the Swift ReorderDropDelegate behavior.
   */
  const moveToward = useCallback((sourceId, targetId) => {
    if (sourceId === targetId) return;
    commitUserChange((current) => {
      const from = current.providerOrder.indexOf(sourceId);
      const to = current.providerOrder.indexOf(targetId);
      if (from < 0 || to < 0) return current;
      const providerOrder = [...current.providerOrder];
      const [item] = providerOrder.splice(from, 1);
      providerOrder.splice(to, 0, item);
      return { ...current, providerOrder };
    });
  }, [commitUserChange]);

  const reset = useCallback(() => {
    commitUserChange(() => ({
      displayMode: LIMIT_DISPLAY_MODES.USED,
      providerOrder: defaultOrder(),
      providerVisibility: defaultVisibility(),
      showSubscriptions: true,
    }));
  }, [commitUserChange]);

  // Return the currently visible providers in user order.
  const visibleOrdered = useMemo(
    () =>
      prefs.providerOrder.filter(
        (id) => prefs.providerVisibility[id] !== false,
      ),
    [prefs.providerOrder, prefs.providerVisibility],
  );

  return {
    order: prefs.providerOrder,
    visibility: prefs.providerVisibility,
    displayMode: prefs.displayMode,
    showSubscriptions: prefs.showSubscriptions,
    setDisplayMode,
    setShowSubscriptions,
    visibleOrdered,
    toggle,
    setAllVisible,
    moveUp,
    moveDown,
    moveToward,
    reset,
  };
}
