# Muse Code subscription quota

Muse Code (Meta's coding agent for Muse Spark) exposes the signed-in
subscription's rolling allowance through its own CLI:

```bash
muse usage --json
```

TokenTracker spawns the user's local `muse` binary with exactly those
arguments and renders two windows: the rolling **5-hour** window
(`allowance.window`) and the **weekly** window (`allowance.weekly`). Each
carries `usedPercent` (clamped to 0–100) and `resetsAtMs`. The plan badge comes
from `allowance.tier` (`power` → `Power`, `muse_pro` → `Pro`, and so on).
`readMuseAuthMetadata` reads `~/.config/muse/auth.json` (or `MUSE_AUTH_PATH`)
locally only to extract non-secret `providers.meta.user_email` / `user_id` (for
the scrypt cache-partition key) and `subs_active`; TokenTracker never selects,
returns, logs, refreshes, or transmits OAuth token fields — the `muse` CLI uses
its own session.

## Binary discovery

Discovery is spawn-free until install evidence exists, so machines without
Muse Code pay zero subprocesses and report `{ configured: false }`.

| Platform | Probe order |
|---|---|
| Windows | `MUSE_INSTALL_DIR` or `%LOCALAPPDATA%\Programs\muse` → `.muse-version` → `muse-bin-<version>.exe` (spawned directly, no `cmd.exe`) → newest `muse-bin-*.exe` (semver + `-R<build>.<patch>`) → `muse.cmd` / `muse.exe` → `%APPDATA%\npm` → `where muse` |
| macOS / Linux | `MUSE_INSTALL_DIR` or `~/.local/bin` (the official `install.sh` default) → `.muse-version` → `muse-bin-<version>` → newest `muse-bin-*` → `muse` launcher → common global bin dirs (Homebrew, `/usr/local/bin`, bun, npm-global, volta, nvm, fnm) → `which muse` |

A launcher found on PATH (including a symlink) is upgraded to the native
`muse-bin-<version>` beside it when one exists. Install evidence is any of
`~/.config/muse` (`XDG_CONFIG_HOME`), the auth file (`MUSE_AUTH_PATH`),
`~/.local/share/muse` (`XDG_DATA_HOME`, `TOKENTRACKER_MUSE_HOME`), or the
Windows install directory.

The child runs with `MUSE_NO_AUTO_UPDATE=1` so a background quota poll never
triggers the launcher's self-update, and with `resolvedCliEnvironment` so a
Finder-launched macOS app still finds the binary's runtime.

## Response states

| CLI result | Rendered as |
|---|---|
| `allowance` with a usable window | Live 5h + weekly bars; written to the disk cache |
| `allowance: null`, `reason: "server_sent_no_usage"` | Idle 0% 5h bar (`reset_at: null`), because the server omits usage headers until a prompt is sent in the active 5h session/window; preserves the current account's cached weekly bar (reported with its original capture time and `disk-cache` / `stale: true` provenance) while its `reset_at` is still in the future, otherwise `secondary_window: null` (unknown). Plan label carried over from the matching account's cache. If `auth.json` has `subs_active: false`, treated as no subscription instead |
| `reason: "no_allowance"` / subscription-required text | "subscription required" error; disk cache cleared so stale bars cannot reappear |
| `reason: "credential_rejected"` / not-logged-in text | Reauth error (`auth_action_required: "reauth"`); never masked by the cache |
| Non-zero exit, timeout, invalid JSON | Last-good disk cache for the signed-in account when present, otherwise the trimmed CLI error |

## Disk cache

`muse-limits-cache.json` lives in the active tracker directory (`~/.tokentracker/tracker` by default, or a custom `trackerDir` via `dirOverride: "trackerDir"`) and uses the shared `createLimitsCache` helper (7-day max age, 12-hour TTL for undated resets, `identityRequired: true`).

Entries are strictly bound to the signed-in account:
- Cache reads, writes, and cached `plan_label` lookups require a non-empty scrypt fingerprint of `providers.meta.user_email` (or `user_id`) from `auth.json` and fail closed (`null`) when `auth.json` is missing, unreadable, or lacks an account identifier (for example after sign-out).
- `fetchMuseLimits` snapshots `readMuseAuthMetadata` before and after `muse usage --json`. If `auth.json` presence or account identity changes while the CLI is in flight, the pre-switch response is neither returned for the new session nor written to the disk cache; fallback re-reads only the post-spawn account's own cache.
- Internal `profile_identity` metadata is stripped from both live and cached fallback public records.

The entry's `cached_at` is always the time of the poll that wrote it, so a freshly observed idle 5h window (which has no `reset_at`) keeps the full 12-hour undated TTL. When an idle poll carries a weekly window forward, that window's original capture time is stored separately in `secondary_captured_at`; public records (live and cached fallback) report the older of the two as `cached_at`, and the internal field is stripped.
