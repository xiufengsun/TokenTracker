# iPhone app review

Branch `feat/ios-product-redesign`, reviewed on top of `5e382d0c`. Three review rounds, committed locally as `87c39d03`, `81a0f027` and `f44931c5`. Nothing was pushed.

## What I found

Design (owner feedback, confirmed in the first-pass screenshots):

- The theme was emerald: green tinted glass, green prominent buttons, green tab and chart tints, an emerald/cyan background glow. The GitHub mark sat on a green pill and was hard to read.
- Provider icons were SF Symbols with made-up colors (`sparkles` for Claude, `terminal` for Codex, `cursorarrow.rays` for Cursor, `wand.and.stars` for Muse). None of them were the marks the product uses.
- The product logo was `BoltIcon` (a redrawn SF-style bolt) on a green tile, not the app icon artwork.
- Token composition labels wrapped mid-word ("Outp ut", "Cach e read") because four label/value pairs were squeezed into one row.

Data honesty:

- Pacing drew bars with no real denominator. 30-day bars were a constant 55% when no target was set, and 7-day and 5-hour bars came from made-up ratios.
- Per-tool "5h burst" assigned hourly tokens by model name. A model used by two tools was counted for both. A "window rolls over in 1h" countdown came from the oldest active hour. No provider window has that reset.
- Plan renewal dates never advanced, so an auto-renewing plan showed "renews today" forever after its first date.

Function:

- The Settings "Pause" button calls `tokentracker-billing?action=remove-device`. It runs `cloud_set_machine_status(..., 'paused')` (`migrations/20261004120000_cloud-machine-access.sql:140`), which frees the sync slot and revokes the machine's upload tokens. It ran with one tap and no confirmation, while the dashboard confirms first (`cloud.devices.remove_detail`).
- Billing and pairing failures showed raw codes such as `cloud_machine_limit` and `cloud_device_code_expired`, because those edge functions put the code in `error`.
- Synced Computers listed every machine twice: once from billing (pause/resume) and again from `account-devices` (rename), with the "Synced Nh ago" age computed against the device clock.
- Face ID lock applied only when returning from background, not on a cold launch. The launch and foreground paths could also open two prompts at once.
- After sign-out the workspace was reset twice, and "Refresh Cloud Data Now" reported success even when the refresh failed.

## What I changed

Round 1, theme and brand (`87c39d03`):

- Monochrome palette. `Palette.ink` is `Color.primary`, the accent color asset is black / white, and orange and red appear only for targets at 72% and 90%, plus errors. Charts, share bars, token composition and the heatmap use grayscale steps.
- `scripts/sync-brand-assets.mjs` reads `PROVIDER_LOGO_MAP`, `PROVIDER_LOGO_CLASS_MAP` and `PROVIDER_ICON_MAP` from `ProviderIcon.jsx`. It copies `dashboard/public/brand-logos/*`, converts the inline mono SVGs, and generates `ProviderMarkCatalog.generated.swift` (51 keys, 44 assets). Lookup matches `ProviderIcon()`, including the `pi-*` fallback. Marks the dashboard draws in `currentColor` or re-inks per theme become template images.
- `TokenTrackerMark` is the real app icon PNG. It now appears on sign-in, the lock overlay and the Cloud-required screens. `BoltShape.swift` is no longer compiled into the phone target.
- Sign-in buttons are neutral glass with label ink. The GitHub Mark stays template-tinted and the Google G keeps its colors, both at 20 pt.
- Token composition is a 2×2 grid, or one column at the largest text sizes, with `fixedSize` labels.
- Face ID lock now applies on cold launch, and a single `unlock()` guard serializes the prompts.

Round 2, data honesty (`81a0f027`):

- Each Pacing window shows its numbers. A bar is drawn only against a target or cap the user set. Only Today gets the even-pace notch and ETA, because only Today has a real reset (local midnight).
- "Last 5 hours" covers the current local hour plus the four before it, and the UI says so.
- Per-tool cards show 7-day and 30-day cost and tokens from `account-model-breakdown`, plus optional caps and renewal. The cross-source 5h attribution and invented reset are gone.
- `TrackedToolBudget.upcomingRenewal` rolls auto-renewing plans forward by whole cycles.
- I rewrote `DESIGN.md` for the monochrome system and the real data sources.

Round 3, Cloud actions and polish (`81a0f027`, `f44931c5`):

- Pause now asks for confirmation, in wording that matches the dashboard. Resume runs with one tap.
- Synced Computers shows one row per machine, plus slot usage ("2 of 99 slots") and an over-limit footer. Rename is a swipe or context action, offered only when exactly one `account-devices` row matches the machine name.
- `CloudError.friendlyMessages` covers machine-slot, pairing-code and availability codes. Unknown `cloud_*` codes never reach the UI.
- Small fixes: Settings shows sync age against the snapshot time, refresh reports only real success, the GitHub link uses the GitHub Mark, and the leaderboard row uses `trophy` instead of `globe`. The Pacing toolbar has one Spend Targets entry instead of two.
- At accessibility text sizes the Pulse bridge wraps instead of truncating.

## Verification

- Build: `xcodegen generate` and `xcodebuild … -destination 'platform=iOS Simulator,id=<iPhone 18 Pro>' build`. Xcode 27.1, iOS 27.1 Simulator SDK, deployment target 26.0. `** BUILD SUCCEEDED **`, with no Swift warnings from the edited files.
- Tests: `xcodebuild … test` ran 24 tests with 0 failures. That count includes 8 new ones: provider-mark resolution (including the `pi-*` fallback and the check that every catalog asset loads from the bundle), the trailing 5-hour window, per-tool profiles, plan renewal rollover, and readable errors for raw codes.
- Screenshots: `scripts/capture-screenshots.sh <udid>` produced 18 PNGs at 1206×2622 in `Screenshots/`. They cover sign-in, Pulse (top, tools, models), Pacing (top, tools) and Settings (top, privacy), each in Light and Dark where it matters, plus Cloud access required, Cloud read expired, empty first sync and offline error. I also checked the home-screen icon and the largest Dynamic Type size by hand.
- API audit: I checked every endpoint the client calls against `dashboard/edge-patches/*.ts` and the migrations. No decode mismatches. All five usage endpoints honor `device_id`.

## Known limitations

- No provider rate limits on the phone. Claude, Codex, Cursor and other plan utilization and resets are read with local credentials (`src/lib/usage-limits.js`) and never reach Cloud, so no endpoint serves them. Showing them would need a backend upload path, which this branch does not add.
- Muse Code has no mark anywhere in the product (`ProviderIcon.jsx` falls back to the dashed placeholder), so the phone shows the same placeholder. Adding a real Muse asset to `dashboard/public/brand-logos/` and rerunning `sync-brand-assets.mjs` fixes both.
- `account-devices` lists only devices with `revoked_at IS NULL` (`tokentracker-account-devices.ts:229`). Whether pausing a machine also revokes its device row, which would hide it from the Pulse computer filter and from rename, still needs checking against a real account. The billing machine list, and so pause / resume, is unaffected.
- `account-hourly` has no cost, so "Last 5 hours" is tokens only, in whole local hours.
- Rename depends on the machine name matching exactly one device row. Machines with duplicate names cannot be renamed from the phone.
- `device_id` values that are not UUIDs fall back to account-wide data on the server without an error. The app only sends ids returned by `account-devices`, so this does not happen in practice.
- Screenshots come from the Debug-only `SimulatorLaunchScenario` fixtures. I did not test against a live Cloud account in this session, and OAuth / Keychain behavior was not re-run on a device.
- Currency conversion uses the dashboard's fixed default rates.

## Round 4: concise UI and Share

The owner's review of the round 3 screenshots: the screens read like a product pitch, and Share was missing.

Copy and layout:

- Sign-in keeps the logo, "Token Tracker", one line, the three sign-in buttons and one footer line. The three feature cards are gone.
- Pulse: the pacing bridge reads "Claude Code · 86% of cap" over "$91.37 · last 7 days". "Cache hit 74%", "Updated 16:20", "Activity", "Last 30 Days" replace the longer captions.
- Pacing: removed the "Estimated spend synced…" subtitle, the pace-notch footnote and "Tap a tool to…". Window captions are "Tokens · this hour + previous 4" and "Target in ~5h". The rate-limit card is one line. Target and cap sheets lost their footers.
- Settings: "Approve CLI Code", one-line Cloud footer, the synced-computers footer only when over the slot limit, shorter labels throughout.
- Cloud access required: logo, title, two sentences, the account, Check Access / Approve CLI Code / Switch Account. The three-step tutorial is gone. Empty first sync: title, "Run this on your computer:", the command, two buttons.
- Tab bar: Pulse, Pacing and Settings use `scrollEdgeEffectStyle(.hard, for: .bottom)`. `02d`, `04c` and `06c` show each tab scrolled to the end with the last row (sync time, rate-limit note, Sign Out) above the bar.

Share:

- Share sits in the Pulse toolbar next to the computer filter. It stays disabled until the current period has loaded with usage, so empty, blocked and offline states can't produce a card.
- `ShareCardData` ports `build-share-card-data.ts` and `buildTopModels`: period from the Pulse horizon, the period's summary tokens and cost, top 3 models with `provider/model` folding and one-decimal shares, a 52-week heatmap, and the dashboard's handle rule. Rank is not fetched, so Broadsheet prints the dashboard's "№ —". Mask Cost Figures drops the amount before rendering.
- `NeonShareCard` and `BroadsheetShareCard` follow the JSX layouts at their canvas sizes, with `neon_bg.png`, the official mark, the dashboard palettes and copy. `ImageRenderer` produces a 2× PNG for `ShareLink`, with the `dashboard.screenshot.twitter_text` caption and `/u/{userId}?ref=share`.

Verification: `xcodebuild … test` on the iPhone 18 Pro Simulator ran 36 tests with 0 failures. 12 are new, covering period mapping, summary-only totals, cost masking, cost formatting, top models, handle, heatmap counts, hook priority, profile URL, caption, and PNG rendering of both variants. `capture-screenshots.sh` produced 23 PNGs, including `11-share-neon-preview` and `11b-share-broadsheet-preview`. A grep for green / emerald / mint / `bolt.fill` in the Swift sources finds nothing. `TokenTrackerMark.png` and `neon_bg.png` are byte-identical to their dashboard / macOS sources.

Limits: the screenshots stop at the preview sheet. I did not drive the system share sheet itself or post to X. Broadsheet uses Times New Roman, the next entry in the card's own serif stack, because Instrument Serif isn't on iOS. Neon's CSS backdrop blur is approximated with a translucent fill and hairline.
