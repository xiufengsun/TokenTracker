import { isNativeEmbed, isNativeLinuxApp, isNativeWindowsApp } from "./native-bridge.js";

/**
 * Optional Sentry error reporting for the dashboard (hosted web + CLI localhost
 * + macOS / Windows / Linux WebViews).
 *
 * Privacy contract (keep in sync with docs/PRIVACY.md and src/lib/sentry.js):
 * - Off unless VITE_SENTRY_DSN is set at build time (public client DSN).
 * - Disabled in Vite DEV / vitest.
 * - On localhost / native surfaces, consults
 *   /functions/tokentracker-telemetry-pref first (fail-closed), matching
 *   PostHog analytics so TOKENTRACKER_NO_TELEMETRY / DO_NOT_TRACK /
 *   config `"telemetry": false` turn off error reporting too.
 * - Errors only — no Session Replay, no tracing sample by default.
 * - beforeSend scrubs common secret patterns and drops empty-stack
 *   Safari/browser fetch abort noise ("Load failed", etc.).
 */

const SECRET_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|secret|password|dsn)[=:\s]+["']?[^\s"'\\]{8,}/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g;

function scrubString(value) {
  if (typeof value !== "string" || !value) return value;
  return value
    .replace(BEARER_PATTERN, "Bearer [Filtered]")
    .replace(JWT_PATTERN, "[Filtered]")
    .replace(SECRET_PATTERN, "[Filtered]");
}

function scrubValue(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("authorization") ||
        lower.includes("cookie") ||
        lower.includes("password") ||
        lower.includes("secret") ||
        lower.includes("token") ||
        lower.includes("api_key") ||
        lower.includes("apikey")
      ) {
        out[key] = "[Filtered]";
      } else {
        out[key] = scrubValue(nested, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function truncateMaybe(value, max = 240) {
  if (typeof value !== "string") return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated]`;
}

export function scrubEvent(event) {
  if (!event || typeof event !== "object") return event;
  const next = { ...event };
  if (next.message) next.message = truncateMaybe(scrubString(next.message));
  if (next.extra) next.extra = scrubValue(next.extra);
  if (next.contexts) next.contexts = scrubValue(next.contexts);
  if (next.request) next.request = scrubValue(next.request);
  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs
      .filter((crumb) => crumb && crumb.category !== "console")
      .map((crumb) => scrubValue(crumb));
  }
  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((item) => ({
        ...item,
        value: truncateMaybe(scrubString(item?.value)),
      })),
    };
  }
  if (next.user) {
    next.user = { id: typeof next.user.id === "string" ? next.user.id : undefined };
  }
  return next;
}


/**
 * Safari (and some other browsers) surface aborted / flaky fetches as
 * unhandledrejection TypeErrors with empty stacks — "Load failed",
 * "Cancelled", "NetworkError when attempting to fetch resource.", etc.
 * Those are not actionable app bugs (TOKENTRACKER-DASHBOARD-2). Drop only
 * when there are no frames; keep real fetch failures that have stacks.
 */
const BENIGN_NETWORK_NOISE_RE =
  /^(Load failed|Cancelled|canceled|AbortError|The user aborted a request\.?|NetworkError when attempting to fetch resource\.?|Failed to fetch)$/i;

function eventExceptionMessage(event) {
  const fromException = event?.exception?.values?.[0]?.value;
  if (typeof fromException === "string" && fromException.trim()) return fromException.trim();
  if (typeof event?.message === "string" && event.message.trim()) return event.message.trim();
  return "";
}

function eventHasStackFrames(event) {
  const values = event?.exception?.values;
  if (!Array.isArray(values)) return false;
  return values.some((item) => {
    const frames = item?.stacktrace?.frames;
    return Array.isArray(frames) && frames.length > 0;
  });
}

export function isBenignBrowserNetworkNoise(event) {
  if (!event || typeof event !== "object") return false;
  // Require a real exception value — do not drop manual message-only captures.
  const values = event?.exception?.values;
  if (!Array.isArray(values) || values.length === 0) return false;
  const primary = values[0] || {};
  const message = typeof primary.value === "string" ? primary.value.trim() : "";
  if (!message || !BENIGN_NETWORK_NOISE_RE.test(message)) return false;
  if (eventHasStackFrames(event)) return false;
  // Browser fetch/abort noise is TypeError / AbortError / DOMException.
  const type = typeof primary.type === "string" ? primary.type : "";
  if (type && !/^(TypeError|AbortError|DOMException|Error)$/i.test(type)) return false;
  // If Sentry attached a mechanism, only drop unhandled rejections / onerror.
  const mechanism = primary.mechanism?.type || event?.mechanism?.type || "";
  if (mechanism && !/unhandledrejection|onerror|auto\.browser/i.test(mechanism)) {
    return false;
  }
  return true;
}

export function resolveSentryShell() {
  if (typeof window === "undefined") return "web";
  if (isNativeEmbed()) return "mac-app";
  if (isNativeWindowsApp()) return "win-app";
  if (isNativeLinuxApp()) return "linux-app";
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return "cli-localhost";
  return "web";
}

function resolveDsn() {
  const raw = import.meta.env.VITE_SENTRY_DSN;
  return typeof raw === "string" ? raw.trim() : "";
}

function resolveRelease() {
  const version = import.meta.env.VITE_APP_VERSION || import.meta.env.APP_VERSION || "";
  const trimmed = String(version).trim();
  return trimmed ? `tokentracker@${trimmed}` : undefined;
}

let initPromise = null;

function browserDoNotTrackEnabled() {
  if (typeof navigator === "undefined") return false;
  if (navigator.doNotTrack === "1") return true;
  if (navigator.globalPrivacyControl === true) return true;
  return false;
}

async function startSentry(shell) {
  const dsn = resolveDsn();
  if (!dsn) return { enabled: false, reason: "no-dsn" };
  const Sentry = await import("@sentry/react");
  Sentry.init({
    dsn,
    environment: import.meta.env.PROD ? "production" : "development",
    release: resolveRelease(),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // Filter defaults: empty array ADDS to defaults, it does not replace them.
    integrations(defaults) {
      return defaults.filter((integration) => {
        const name = integration?.name || "";
        return name !== "BrowserSession" && name !== "Console";
      });
    },
    beforeSend(event) {
      // Prefer beforeSend over ignoreErrors so we only drop empty-stack
      // network noise and keep real "Failed to fetch" bugs that have frames.
      if (isBenignBrowserNetworkNoise(event)) return null;
      return scrubEvent(event);
    },
    initialScope: {
      tags: {
        shell,
        runtime: "browser",
      },
    },
  });
  return { enabled: true };
}

async function resolveAndStart() {
  if (typeof window === "undefined") return { enabled: false, reason: "no-window" };
  if (import.meta.env.DEV || import.meta.env.MODE === "test") {
    return { enabled: false, reason: "dev-or-test" };
  }
  if (!resolveDsn()) return { enabled: false, reason: "no-dsn" };

  const shell = resolveSentryShell();
  if (shell === "web") {
    // Match PostHog: hosted web has no CLI telemetry pref, so honor browser DNT/GPC.
    if (browserDoNotTrackEnabled()) return { enabled: false, reason: "dnt" };
    return startSentry(shell);
  }

  try {
    const res = await fetch("/functions/tokentracker-telemetry-pref");
    const pref = res.ok ? await res.json() : null;
    if (pref && pref.disabled === false) {
      return startSentry(shell);
    }
    return { enabled: false, reason: "opt-out-or-unknown" };
  } catch {
    return { enabled: false, reason: "pref-unavailable" };
  }
}

/**
 * Fire-and-forget Sentry init. Never throws into the app.
 * Returns the shared init promise so callers can await readiness.
 */
export function initSentry() {
  if (!initPromise) {
    initPromise = resolveAndStart().catch(() => ({ enabled: false, reason: "init-failed" }));
  }
  return initPromise;
}

/**
 * Capture after init settles so early route failures are not dropped while
 * the telemetry-pref fetch is still in flight on localhost / native shells.
 */
export async function captureDashboardException(error, context) {
  try {
    if (import.meta.env.DEV || import.meta.env.MODE === "test") return;
    if (!resolveDsn()) return;
    const result = await initSentry();
    if (!result?.enabled) return;
    const Sentry = await import("@sentry/react");
    if (context?.tags || context?.extra) {
      Sentry.withScope((scope) => {
        if (context.tags) {
          for (const [key, value] of Object.entries(context.tags)) {
            scope.setTag(key, String(value));
          }
        }
        if (context.extra) scope.setExtras(scrubValue(context.extra));
        Sentry.captureException(error);
      });
      return;
    }
    Sentry.captureException(error);
  } catch {
    /* never break the error page */
  }
}
