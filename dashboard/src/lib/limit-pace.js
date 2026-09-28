// Time-aware pace + current-rate projection for usage-limit windows.
// Mirrors the macOS app's LimitPace.swift + UsageLimitsView projection so both
// ends compute identical numbers. Pure functions, no UI.

/** Fraction (0..1) of the window elapsed by now, or null if inputs are unusable. */
export function expectedUsedFraction(windowSeconds, secondsUntilReset) {
  if (!(windowSeconds > 0)) return null;
  const fraction = (windowSeconds - secondsUntilReset) / windowSeconds;
  if (!Number.isFinite(fraction)) return null;
  return Math.min(Math.max(fraction, 0), 1);
}

/** True when actual usage is meaningfully ahead of an even burn. */
export function isOverPace(usedFraction, expectedFraction, tolerance = 0.03) {
  return usedFraction > expectedFraction + tolerance;
}

function durationString(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  if (h > 24) return `${Math.floor(h / 24)}d`;
  if (h > 0) return `${h}h`;
  return `${Math.floor(s / 60)}m`;
}

/** Resolve a window's nominal length (seconds) from its spec, when trusted. */
export function resolveWindowSeconds(spec, window) {
  if (typeof spec.windowSeconds === "number") return spec.windowSeconds;
  if (spec.windowSecondsField && window) {
    const v = window[spec.windowSecondsField];
    return typeof v === "number" && v > 0 ? v : null;
  }
  return null;
}

/** Parse a window reset (ISO string or unix seconds) into epoch milliseconds. */
export function resetToMs(isoOrUnix) {
  if (isoOrUnix == null) return NaN;
  return typeof isoOrUnix === "number" ? isoOrUnix * 1000 : Date.parse(isoOrUnix);
}

/**
 * Compute pace marker position + projection for one window.
 * Returns:
 *   pacePercent   display-space marker position (0..100), or null to hide the mark
 *   paceOver      true = ahead of pace (deficit, red), false = on/under (green)
 *   expectedPercent  even-burn % by now (0..100), or null
 *   runsOutEta    "~3h" if projected to exhaust before reset, else null
 *   projectedEnd  projected % by reset (0..100) when it won't run out, else null
 */
export function computePace({ usedPercent, windowSeconds, resetMs, mode, now = Date.now() }) {
  const usedFraction = Math.min(Math.max(Number(usedPercent) || 0, 0), 100) / 100;
  const out = { pacePercent: null, paceOver: false, expectedPercent: null, runsOutEta: null, projectedEnd: null };
  if (!(windowSeconds > 0) || !Number.isFinite(resetMs)) return out;

  const secondsUntilReset = Math.max(0, (resetMs - now) / 1000);
  const expected = expectedUsedFraction(windowSeconds, secondsUntilReset);
  if (expected == null) return out;

  out.expectedPercent = Math.round(expected * 100);
  out.paceOver = isOverPace(usedFraction, expected);

  // Hide the mark only on an unused window. Even small usage needs an
  // even-pace reference (for example, Grok at 3% used / 97% remaining).
  if (usedFraction > 0) {
    const display = mode === "remaining" ? 1 - expected : expected;
    out.pacePercent = display * 100;
  }

  // Project at the current burn rate (rate = used / elapsed).
  if (expected > 0.02 && usedFraction > 0) {
    const elapsedSeconds = windowSeconds * expected;
    const ratePerSecond = usedFraction / elapsedSeconds;
    const projectedAtReset = usedFraction / expected;
    if (projectedAtReset >= 1 && ratePerSecond > 0) {
      out.runsOutEta = durationString((1 - usedFraction) / ratePerSecond);
    } else {
      out.projectedEnd = Math.round(Math.min(projectedAtReset, 1) * 100);
    }
  }

  return out;
}
