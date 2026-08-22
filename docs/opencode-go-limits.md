# OpenCode Go usage limits

## Overview

TokenTracker exposes **OpenCode Go** as a usage-limits provider separate from the ordinary local OpenCode session source. The provider reports the three subscription windows that OpenCode calculates on its servers: rolling five-hour usage, weekly usage, and monthly usage.

The preferred source is OpenCode's official authenticated usage endpoint, `GET https://opencode.ai/zen/go/v1/usage`. The endpoint is implemented upstream in [anomalyco/opencode#16513](https://github.com/anomalyco/opencode/pull/16513). The older signed-in dashboard scrape remains available for existing configurations, and a local SQLite cost calculation remains an explicit, non-authoritative estimate.

## Data-source priority

| Priority | Source | Configuration | Semantics |
|---|---|---|---|
| 1 | Official OpenCode Go usage API | `OPENCODE_GO_API_KEY` | Authoritative subscription windows returned as JSON. |
| 2 | Signed-in workspace dashboard scrape | `OPENCODE_GO_AUTH_COOKIE`, optionally `OPENCODE_GO_WORKSPACE_ID` | Legacy compatibility fallback for existing users. |
| 3 | Local `opencode.db` cost aggregation | `TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE=1` | An explicitly labeled historical estimate; it cannot establish current subscription entitlement. |

When an API key is present, TokenTracker calls the official endpoint first. A `401` or `403` response is returned directly so the user can correct the key or subscription. For a transient API failure, a configured cookie-backed scrape is attempted before the optional local estimate.

## Configuration

Configure secrets only in the local environment. API keys and cookies must never be committed, logged, displayed, or placed in client-side dashboard variables.

```dotenv
# Preferred: official OpenCode Go usage API.
OPENCODE_GO_API_KEY=

# Legacy compatibility fallback: signed-in workspace dashboard scrape.
OPENCODE_GO_WORKSPACE_ID=
OPENCODE_GO_AUTH_COOKIE=

# Optional and explicitly unverified local historical estimate.
# TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE=1
```

The workspace ID is optional when the legacy cookie path is used. The module will attempt to resolve it from the signed-in account, but a direct API-key configuration does not need a workspace ID or cookie.

## Official API contract

The request uses a standard Bearer authorization header:

```bash
curl -sS https://opencode.ai/zen/go/v1/usage \
  -H "Authorization: Bearer $OPENCODE_GO_API_KEY"
```

A successful response contains the three usage windows in either of two shapes: the early spec `rollingUsage`/`weeklyUsage`/`monthlyUsage` with `usagePercent` + `resetInSec`, or the live nested shape `{ usage: { rolling: { percent, resetsAt }, ... } }`. Both shapes are parsed as of the nested-shape parser fix (PR pending merge at the time of writing); the service may also include `status` and top-level `useBalance`. `src/lib/opencode-go-limits.js` converts those fields into the provider-panel contract:

```json
{
  "configured": true,
  "source": "api",
  "subscription_status": "active",
  "primary_window": { "used_percent": 42, "reset_at": "2026-01-01T00:00:00.000Z" },
  "secondary_window": { "used_percent": 18, "reset_at": "2026-01-01T00:00:00.000Z" },
  "tertiary_window": { "used_percent": 7, "reset_at": "2026-01-01T00:00:00.000Z" }
}
```

The endpoint returns `401` when the key is absent, invalid, expired, or not entitled to an OpenCode Go subscription; early upstream versions used `401` for both authentication and entitlement failures. Newer upstream versions may return `403` for a missing Go subscription, so TokenTracker handles that response defensively as well. Both cases are surfaced with actionable provider errors.

## Implementation boundaries

The implementation lives in `src/lib/opencode-go-limits.js` and is wired into the shared provider poll in `src/lib/usage-limits.js`. The API and dashboard paths share `buildWindow()`, so dashboard rendering, cache behavior, and the existing `primary_window` / `secondary_window` / `tertiary_window` schema do not change.

The legacy scraper intentionally retains its SSR-hydration and `data-slot` parsers because it is a compatibility path, not a protocol dependency for API-key users. Its workspace-resolution code should not run when a valid API response is available.

## Tests and validation

`test/opencode-go-limits.test.js` covers the API request shape, JSON window mapping, API-key precedence, authentication errors, malformed payload handling, and a temporary-API-failure fallback to the existing dashboard path. The existing tests continue to cover legacy cookie parsing and workspace resolution.

Run the targeted test during development, then execute the repository's complete local validation before requesting review:

```bash
node --test test/opencode-go-limits.test.js
npm run ci:local
```

## Release impact

The implementation changes `src/`, so it follows the release workflow documented in `CLAUDE.md`: maintainers bump the shared package version and ship the updated CLI through npm and the macOS, Windows, and Linux bundles.
