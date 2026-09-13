# CLAUDE.md

Guidance for Claude Code working in this repository. Every line here is loaded into every conversation turn — keep it lean and current.

## Project shape

Token Tracker is a local-first AI token usage tracker.

- **CLI** (`src/`, CommonJS, Node ≥20) — entry `bin/tracker.js` → `src/cli.js`. `serve` runs a local HTTP server on `:7680`, `sync` parses logs into `~/.tokentracker/queue.jsonl`.
- **Dashboard** (`dashboard/`, React 18 + Vite 7 + TS strict + Tailwind) — built to `dashboard/dist/`, served by the CLI locally and by Vercel at `www.tokentracker.cc`.
- **macOS app** (`TokenTrackerBar/`, Swift 5.9, XcodeGen) — menu bar + WidgetKit. `EmbeddedServer/` bundles the CLI runtime + built dashboard so the `.app` is self-contained.
- **Windows app** (`TokenTrackerWin/`, .NET 8 WinForms + WPF + WebView2) — system-tray counterpart of the macOS app. Launches the bundled CLI `serve` on a dynamic loopback port (avoids the DoSvc-held `:7680`), hosts the dashboard in WebView2, registers the `tokentracker://` deep-link for OAuth. Built `EmbeddedServer/` (Node + CLI + dashboard) is bundled by `scripts/bundle-node.ps1` so the `.exe` is self-contained. Dashboard adaptations are gated behind `isNativeWindowsApp()` (`dashboard/src/lib/native-bridge.js`) so macOS/web paths are untouched.

Data flow: AI CLI runs → hook fires → `rollout.js` parses → `queue.jsonl` → local API → dashboard.

For the canonical list of supported providers, grep `parse*Incremental` in `src/lib/rollout.js` — the source of truth, not this file.

## Frequently used commands

```bash
npm test                                  # node --test test/*.test.js  (209 files)
node --test test/<name>.test.js           # single test file
npm run ci:local                          # tests + validations + builds
npm run dashboard:dev                     # Vite dev server with local API mock (port 5173)
npm run dashboard:build                   # build to dashboard/dist/
npm run validate:copy                     # copy registry completeness
npm run validate:ui-hardcode              # no hardcoded UI strings
npm run validate:guardrails               # architecture guardrails
node bin/tracker.js serve --no-sync       # local dashboard server on :7680
```

`npm run dashboard:dev` skips the CLI backend; to verify `src/` changes use `node bin/tracker.js serve`.

## What's where

| Need to... | Look here |
|---|---|
| Add / modify a provider parser | `src/lib/rollout.js` — search `parse*Incremental` |
| Install / uninstall a provider hook | `src/lib/<provider>-hook.js` + register in `src/commands/init.js` + `uninstall.js` |
| Add a local API endpoint | `src/lib/local-api.js` — search `/functions/tokentracker-` |
| Wire a provider into sync | `src/commands/sync.js` (call site + totals aggregation) + `src/commands/status.js` (status reporting) |
| Add pricing for a model | `src/lib/pricing/curated-overrides.json` **+ the canonical edge block in `dashboard/edge-patches/tokentracker-leaderboard-refresh.ts`, copied verbatim into the other 4 edge files** (account-daily / account-summary / account-model-breakdown / leaderboard-profile). `test/edge-pricing-parity.test.js` fails on any drift. Deploy the touched edge functions after editing. |
| Add an OpenCode Go usage-limits row | `src/lib/opencode-go-limits.js` + provider entry in `src/lib/usage-limits.js` + `PROVIDER_LIMIT_SPECS.opencodeGo` in `dashboard/src/ui/dashboard/components/usage-limits-provider-specs.js`. **Authoritative source = the official Go usage API** (`source:'api'`) using `OPENCODE_GO_API_KEY`; the signed-in dashboard scrape (`source:'web'`) remains a legacy compatibility fallback. Local `opencode.db` cost ÷ Go's dollar caps ($12/5h, $30/wk, $60/mo) is only an explicit `TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE=1` estimate because history cannot prove an active subscription. Reads via `readSqliteJsonRowsAsync` so the limits poll never blocks the event loop. |
| Add a Devin usage-limits row | `src/lib/devin-limits.js` + provider entry in `src/lib/usage-limits.js` + `PROVIDER_LIMIT_SPECS.devin`. Source = official `GetPlanStatus` RPC on `server.codeium.com` via `x-auth-token` from the Devin CLI's `credentials.toml`; proto3 implicit-zero decode rules in `docs/devin-limits.md`. **Opt-in**: the provider switch defaults off; only an authenticated `?devin=1` request reaches credentials/network. |
| Add a dashboard page | `dashboard/src/pages/` (lazy-loaded via `React.lazy()` in `App.jsx` — **except `NativeAuthCallbackPage`, which must stay eager-imported**, see Lessons learned) |
| Add UI components | `dashboard/src/ui/dashboard/components/` |
| Add a provider icon | `dashboard/src/ui/dashboard/components/ProviderIcon.jsx` (`PROVIDER_ICON_MAP` keyed by `source.toUpperCase()`) |
| Add user-facing text | `dashboard/src/content/copy.csv` — never hardcode |
| Modify menu bar UI | `TokenTrackerBar/Services/` (controllers) + `Views/` (SwiftUI) |
| Bridge native ↔ web | `TokenTrackerBar/Services/NativeBridge.swift` + `dashboard/src/lib/native-bridge.js` |

## Load-bearing conventions

### Token normalization

```
input_tokens                  = non-cached input only (no cache reads/writes)
cached_input_tokens           = cache reads
cache_creation_input_tokens   = cache writes
reasoning_output_tokens       = reasoning tokens (Codex/every-code fold them into output_tokens for cost)
total_tokens                  = input + output + cache_creation + cache_read + reasoning_output (sum of all columns; Gemini-style rows that omit reasoning still pass invariants if you set the column to 0)
```

**Cost is computed from `input_tokens + output_tokens + cached_input_tokens + cache_creation_input_tokens + reasoning_output_tokens` only — never `total_tokens`** (`computeRowCost` in `src/lib/pricing/index.js`). If a new provider only fills `total_tokens` with input=0/output=0, the dashboard renders **$0 cost** regardless of pricing entries. Distribute the total across columns or extend `computeRowCost`.

### Queue entry

```json
{
  "hour_start": "2026-04-05T14:00:00Z",
  "source": "claude|codex|cursor|gemini|...",
  "model": "claude-opus-4-6|gpt-5.4|...",
  "input_tokens": 0, "output_tokens": 0,
  "cached_input_tokens": 0, "cache_creation_input_tokens": 0,
  "reasoning_output_tokens": 0,
  "total_tokens": 0, "conversation_count": 1
}
```

UTC, half-hour buckets, append-only — readers take the latest entry per `(source, model, hour_start)`.

### Project-wide

- CommonJS in `src/`, ESM + TypeScript strict in `dashboard/`. No mixing.
- Env-var prefixes: `TOKENTRACKER_` for CLI, `VITE_` for dashboard.
- Git commits in **English**, conventional style (`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:` / `ci:`).
- **Privacy**: token counts only — never prompts, messages, or conversation bodies.
- `TokenTrackerBar/EmbeddedServer/` is gitignored; built on demand by `TokenTrackerBar/scripts/bundle-node.sh`.
- After editing `TokenTrackerBar/project.yml`: `(cd TokenTrackerBar && xcodegen generate && ruby scripts/patch-pbxproj-icon.rb)`.

## Release workflow

**Any change under `src/` or `dashboard/` ships npm + DMG + Windows + Linux**, because `TokenTrackerBar/EmbeddedServer/` (macOS), `TokenTrackerWin/EmbeddedServer/` (Windows) and `TokenTrackerLinux/EmbeddedServer/` (Linux AppImage + `.deb` + `.rpm`) all bundle the CLI runtime and built dashboard. Bumping only `package.json` leaves desktop-app users on the stale embedded copy.

The macOS + Windows + Linux release is **one workflow**: `release-dmg.yml` (display name **`release (macOS + Windows + Linux)`**). A `create-release` job validates every version file (via the shared `scripts/version-files.cjs` registry) and makes the `vX.Y.Z` release as a **draft** pinned to the workflow commit, then a macOS `build` job, a `windows` job (which calls the reusable `release-windows.yml` via `workflow_call`) and a `linux` job all `needs: create-release` and run **in parallel**, each checking out that immutable version tag and uploading its assets to the draft with `--clobber`. The `linux` job bundles the embedded runtime (**must** precede `tauri build` — `tauri-build` hard-fails on the missing `EmbeddedServer` resource path), builds **all three Linux packages from one `tauri build`** (AppImage, `.deb`, `.rpm` — the target set is pinned in `tauri.conf.json` and by `bundle_produces_the_three_supported_linux_targets` in `src-tauri/tests/capabilities.rs`), and verifies each package's extracted payload actually contains the runtime before uploading — every format ships from its own bundler and can fail alone, so none is trusted as a proxy for the others. A final `publish` job (`needs: [build, windows, linux]`) verifies all six assets, flips the draft live (`gh release edit --draft=false`), and notifies the Homebrew tap. The draft stays invisible until then, so `releases/latest` never serves a half-published release (and a failed platform leaves it unpublished rather than half-public). Published releases are immutable: a same-version dispatch fails instead of replacing public assets; only a draft pointing to the exact same commit may be resumed. A **single** `gh workflow run "release (macOS + Windows + Linux)" -f version=X.Y.Z` ships **all three** platforms. `release-windows.yml` can still be dispatched standalone to rebuild Windows assets, but only into an existing matching draft created by the combined workflow.

| Change scope | Bump `package.json` (→ `npm run sync-versions` propagates the rest) | Trigger release workflow (→ builds macOS + Windows + Linux) |
|---|---|---|
| `src/` or `dashboard/` | ✅ | ✅ |
| `TokenTrackerBar/` Swift only | ✅ | ✅ |
| `TokenTrackerWin/` only | ✅ | ✅ |
| `TokenTrackerLinux/` only | ✅ | ✅ |
| `dashboard/edge-patches/`, scripts, docs, CI | — | — |

**All nine** managed version locations must match or the workflows' "Verify version" steps fail. The authoritative list lives in `scripts/version-files.cjs` (`VERSION_FILES`) — that registry is what `sync-versions` writes, `validate:versions` checks, and the release workflow's `create-release` job verifies, so adding a platform means editing one array rather than several workflows. Beyond `package.json` it covers `TokenTrackerBar/project.yml` (×2 `MARKETING_VERSION`), `TokenTrackerWin/TokenTrackerWin.csproj`, and the six Linux files (`TokenTrackerLinux/package.json`, its `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `packaging/arch/.../PKGBUILD`). The root `package-lock.json` is not in the registry because `npm version` maintains it, but the release workflow verifies it too.

**Release asset inventory** — the `publish` job refuses to flip the draft live unless all six are present (it checks for each by name; it does not reject extras), and any change to the list must land in the workflow's upload + required-asset steps and in `test/linux-client-workflow.test.js` together:

| Platform | Assets |
|---|---|
| macOS | `TokenTrackerBar.dmg` |
| Windows | `TokenTracker-win-x64.zip`, `TokenTracker-Setup.exe` |
| Linux | `TokenTracker-linux-x86_64.AppImage`, `TokenTracker-linux-x86_64.deb`, `TokenTracker-linux-x86_64.rpm` |

When the user says "release" or "发 release", that is explicit approval for the release commit(s) + push — do not ask again for commit/push permission within that scope.

### Steps

1. Bump the version in **one** place — `package.json` is the single source of truth. Run `npm version <X.Y.Z|patch|minor>` (or, if you edited `package.json` by hand, `npm run sync-versions`): the `version` npm-lifecycle hook runs `scripts/sync-versions.cjs`, which syncs the version into every file listed in `scripts/version-files.cjs` (`project.yml`'s two `MARKETING_VERSION` entries, the Windows `<Version>`, and the Linux `package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` / `tauri.conf.json` / `PKGBUILD`), then `git add`s them so they land in the version commit. They all stay in lockstep automatically — don't hand-edit any of them. (`npm version` also creates a local `vX.Y.Z` tag and a `vX.Y.Z`-style commit message rather than `chore(release): vX.Y.Z`; CI triggers on the package.json version change, not the message.)
2. `git commit && git push origin main` → the canonical `CI` workflow runs. Only after that exact main-branch commit passes the full Linux validators + macOS tests + Windows build does `npm-publish.yml` check out the tested SHA and publish when the version is new. A failed or cancelled CI never reaches npm. **Never push the local `vX.Y.Z` tag (no `--follow-tags`)** — the release workflow creates the tag itself, and a pre-existing tag makes its `create-release` job fail with "version already consumed" (recovery: delete the remote tag, re-dispatch).
3. For DMG-eligible changes: `gh workflow run "release (macOS + Windows + Linux)" -f version=X.Y.Z` → the macOS, Windows and Linux jobs run **in parallel**, producing the DMG, the Windows zip + installer, and — from the Linux job's single `tauri build` — the three Linux packages, each job attaching its own assets to the GitHub Release.
4. Homebrew tap `xiufengsun/homebrew-tokentracker` self-updates via dispatch (~40s if `HOMEBREW_DISPATCH_TOKEN` set) or hourly cron (≤1h fallback). **Never edit the tap repo manually for routine releases.**

Release notes: one English line, no markdown sections (`Fix token stats inflation caused by duplicate queue entries`).

### Local DMG build (testing only — CI is authoritative)

```bash
cd TokenTrackerBar && npm run dashboard:build && ./scripts/bundle-node.sh
xcodegen generate && ruby scripts/patch-pbxproj-icon.rb
xcodebuild -scheme TokenTrackerBar -configuration Release clean build
APP="$(find ~/Library/Developer/Xcode/DerivedData/TokenTrackerBar-*/Build/Products/Release -name 'TokenTracker.app' -maxdepth 1)"
bash scripts/create-dmg.sh "$APP"
```

## Lessons learned (read before touching)

### macOS build & release

- **Icon Composer (`.icon`) needs Xcode 26+**. CI uses `macos-26` runners but a static `TokenTrackerBar/TokenTrackerBar/AppIcon.icns` is committed as fallback for older Xcode. If you update `AppIcon.icon`, regenerate `.icns` from a local Xcode 26 build and commit both.
- **DMG layout on CI needs Homebrew `create-dmg`**. `TokenTrackerBar/scripts/create-dmg.sh` uses AppleScript locally but delegates to `create-dmg` on headless runners. Don't reintroduce a "skip Finder customization on CI" shortcut — produces bare DMGs.
- **CI must ad-hoc sign the `.app` before DMG packaging.** Build flags strip signing entirely; without ad-hoc signing the `.app` + `com.apple.quarantine` xattr triggers Gatekeeper "damaged" rejection (unfixable without Terminal). The workflow signs inner Mach-O (`Resources/EmbeddedServer/node`) first, then the outer bundle with `--entitlements TokenTrackerBar/TokenTrackerBar.entitlements --sign -`. **Never** remove this step without replacing it with Developer ID + notarization.

### Dashboard layout

- **`AppLayout`-wrapped pages use `flex flex-col flex-1`** as the outer wrapper, not `min-h-screen` + own sticky header/footer. Reference: `LimitsPage.jsx` / `LeaderboardPage.jsx` / `SettingsPage.jsx`. `LeaderboardProfilePage.jsx` is intentionally excluded via `isLeaderboardIndexPath` in `App.jsx`.
- **Motion height animations clip box-shadow focus rings.** Use `focus:ring-inset` on inputs inside `AnimatePresence` height-collapsing containers (see `SettingsPage.jsx` Account section).
- **`NativeAuthCallbackPage` must stay eager-imported in `App.jsx`** (do NOT convert it to `React.lazy()` even when adding other lazy pages). Its module captures the OAuth `insforge_code` query param synchronously at module-load time, BEFORE the InsForge SDK's `detectAuthCallback()` runs `cleanUrlParams("insforge_code")` to strip it. Lazy-loading delays the module until the route mounts, by which point the SDK has already wiped the URL — the captured code is `null` and the page falls through to the "Sign-in incomplete" failure state. Regression history: PR splitting the 1.9MB main bundle broke OAuth callback for every user until reverted for this one page.

### Native ↔ web bridge

```
JS → window.webkit.messageHandlers.nativeBridge.postMessage({ type, key?, value?, name? })
Swift → NativeBridge.shared.handle(message:) via WKScriptMessageHandler
Swift → JS: webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('native:settings', { detail }))")
React → useNativeSettings() subscribes
```

After `SMAppService.mainApp.register/unregister` from the bridge (not via `LaunchAtLoginManager.toggle`), call `launchAtLoginManager.refresh()` so the popover menu reflects `@Published isEnabled`.

### Parser correctness

- **Parser dedup**: use `claudeMessageDedupKey()`. Bare `if (msgId && reqId)` fails open on DeepSeek/Kimi/Mimo/MiniMax/Claude sub-agents (no `reqId`) and over-counts 1.6–3.7×.
- **Don't trust `input_tokens` semantics blindly** when adding a new provider. Codex/every-code's `input` includes cached tokens — naive copy inflates cost 6–7×. Verify with raw usage + provider billing dashboard before shipping.
- **`contextTokensUsed`-style fields are usually snapshots, not cumulative.** PR #74 (Grok) shipped on that bad assumption.
- **Mimo (mimocode) mirrors your Claude Code + claude-mem history into its own DB.** It's an OpenCode-fork SQLite (`~/.local/share/mimocode/mimocode.db`) but pulls `~/.claude` sessions in via `claude_import` AND a live observer/session sync — so >99% of rows are anthropic-endpoint turns the Claude parser already counts as `source=claude` (~3.9B mirrored vs ~22M genuine on the dev's box). `readMimoDbMessages()` keys off `providerID`: keep only `mimo`/`xiaomi` (mimo's own runtime); drop everything `anthropic`. That `anthropic` bucket includes mimo-named models the user ran *inside* Claude Code (e.g. `model=mimo-v2.5-pro`, logged in `~/.claude`) — so do NOT key off the model id (re-counts it) and do NOT rely on `claude_import` (misses the observer mirror).
- **Data-migration releases**: stress-test `sync` twice consecutively after touching `sync.js` / cursor schema — second run exposes state pollution the first hides.

### Skills registry mutations

- **`installSkill()` downloads for minutes and only then writes the registry — take every field from a fresh `readRegistry()` at the sync checkpoint, never from the pre-download snapshot.** The guard before `removePath(dest)` is deliberately the last point where nothing has awaited, so existence *and* `targets` are both read there: another tab, the menu bar app or the local API can uninstall the skill, retarget it, or drop a different repo's skill into the same install directory while the download runs. PR #613 fixed existence and left `targets` on the stale copy, so toggling an agent mid-update silently reverted the toggle.
- **Temp dirs use `fs.mkdtempSync`, never `${name}-${Date.now()}`.** Millisecond-resolution names collide once two mutations overlap, and the old `removePath(temp)` then deleted the other run's in-flight download. `runMutation` in `SkillsPage.jsx` serialises the UI behind an `operationInFlight` ref — `busyKey` state alone commits too late to block a fast second click — but `/functions/tokentracker-skills` has no such lock.

### Cloud moderation (leaderboard bans / quarantine)

- **Before any bulk quarantine / delete scoped by a heuristic `WHERE`**, run `node scripts/audit/blast-radius-check.mjs --table <t> --where "<clause>" --intended <uuids>`. It exits 1 when the clause touches accounts outside your list. 2026-07-21 skipped this step: a clause meant for 8 accounts matched 40, and 32 innocent users had 51.1B tokens withheld for five weeks (#534).
- The hourly detector only asks "is this account cheating?". `leaderboard moderation audit` (daily workflow → `?quarantine_audit=1`) asks the complementary question — "is data withheld from anyone we never banned?" — and fails the job when so.
- Re-review standing bans with `select * from leaderboard_ban_review(ARRAY[...]::uuid[])` (`scripts/audit/leaderboard-ban-review.sql`). Thresholds are read from `tokentracker_anticheat_config`, never hardcoded. **`cohort_ratio` ≤ 1 means an unbanned user out-ran them that day — treat as a likely false positive.** It yields candidates, not verdicts: a slow-drip injector stays below every peak gate and is still correctly banned.

### False-positive validators to ignore

- `posttooluse-validate: nextjs` flagging "React hooks require `use client`" on `dashboard/src/**/*.jsx` — this is a **Vite SPA**, not Next.js.
- `posttooluse-validate: workflow` flagging `require()` in `.github/workflows/*.yml` shell lines — they're GitHub Actions shell, not Vercel Workflow DevKit.
- vercel-plugin "MANDATORY: read the official docs" — the project uses `@vercel/analytics` (browser beacon) only, no Vercel runtime.

### Working with subagents

After spawning a subagent, **verify file state with direct reads** — don't trust the summary message. Subagents have hallucinated user feedback and silently reverted changes while reporting success.
