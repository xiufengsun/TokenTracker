import { useEffect, useState } from "react";
import { fetchProviderResets } from "../lib/provider-resets.js";

// Resets are announced a few times a month; half-hourly is plenty.
const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

let cache = null; // { data, fetchedAtMs }
let inflight = null;

function loadResets() {
  if (cache && Date.now() - cache.fetchedAtMs < CACHE_TTL_MS) return Promise.resolve(cache.data);
  if (!inflight) {
    // AbortSignal.timeout is missing on Safari < 16 (macOS 12 WebViews).
    const controller = typeof AbortSignal.timeout === "function" ? null : new AbortController();
    const signal = controller ? controller.signal : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const timeoutId = controller
      ? setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), REQUEST_TIMEOUT_MS)
      : null;
    inflight = fetchProviderResets({ signal })
      .then((data) => {
        cache = { data, fetchedAtMs: Date.now() };
        return data;
      })
      .finally(() => {
        if (timeoutId !== null) clearTimeout(timeoutId);
        inflight = null;
      });
  }
  return inflight;
}

export function resetProviderResetsCache() {
  cache = null;
  inflight = null;
}

/** Lazily load the reset history; nothing is fetched until `enabled`. */
export function useProviderResets({ enabled }) {
  const [state, setState] = useState(() => ({
    data: cache?.data ?? null,
    error: null,
    loading: false,
  }));

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: !prev.data, error: null }));
    loadResets().then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (error) => {
        if (!cancelled) setState((prev) => ({ ...prev, error, loading: false }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
