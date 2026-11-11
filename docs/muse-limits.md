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
TokenTracker never reads, refreshes or transmits Muse OAuth tokens; the CLI
uses its own session.

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
| `allowance: null`, `reason: "server_sent_no_usage"` | Idle 0% bars with undated resets (the server omits usage headers until the first prompt of a fresh window). Plan label carried over from the cache. If `auth.json` has `subs_active: false`, treated as no subscription instead |
| `reason: "no_allowance"` / subscription-required text | "subscription required" error; disk cache cleared so stale bars cannot reappear |
| `reason: "credential_rejected"` / not-logged-in text | Reauth error (`auth_action_required: "reauth"`); never masked by the cache |
| Non-zero exit, timeout, invalid JSON | Last-good disk cache when present, otherwise the trimmed CLI error |

## Disk cache

`muse-limits-cache.json` lives in the tracker directory and uses the shared
`createLimitsCache` helper (7-day max age, 12-hour TTL for undated resets).
Entries are partitioned by account: the cache stores a scrypt fingerprint of
`providers.meta.user_email` (or `user_id`) from `auth.json`, never the raw
value, and the fingerprint is re-read at fallback time so an account switch
during a slow CLI call cannot serve the previous account's bars.
