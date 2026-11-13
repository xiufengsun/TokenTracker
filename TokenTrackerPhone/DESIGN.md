# Token Tracker for iPhone: product design

## 1. What the phone is for

Token Tracker parses AI coding tool logs on the user's computers and syncs token counts to TokenTracker Cloud. The iPhone app tracks nothing itself. It signs in to Cloud and answers three questions a developer asks away from their desk:

1. How much did I spend today, and on which tool and model? (Pulse)
2. Am I spending faster than I planned this day, week, or month? (Pacing)
3. Which computers are syncing, and is my usage private on this phone? (Settings)

Anything that needs local credentials (provider rate limits, launch at login, ports, hooks) stays on the desktop.

## 2. Information architecture

```
RootContainerView
├── Signed out ─► SignInView
│                  Logo, title, one line; GitHub / Google (PKCE via ASWebAuthenticationSession),
│                  email + password sheet; one footer line
└── Signed in (Keychain session, single-flight refresh)
    ├── No Cloud read access ─► CloudAccessBlockedView
    │     Logo, short title, two sentences max, the account, then
    │     Check Access / Approve CLI Code / Switch Account. No prices, upgrade prompts or purchase links.
    └── TabView (Liquid Glass tab bar, minimizes on scroll)
        ├── Pulse     toolbar: computer filter + Share. Horizon (Today · Week · Month · 24M), cost + tokens,
        │             token composition, daily-target bar, link to Pacing, hourly / 30-day chart,
        │             coding tools (tap for models), top models, 18-week heatmap
        ├── Pacing    Used / Remaining toggle, account windows (last 5 hours, today, 7 days,
        │             30 days), per-tool 7d / 30d spend with optional caps and plan renewal date,
        │             note on why provider rate limits are desktop-only
        └── Settings  account, Cloud status, synced computers, privacy (mask costs, app switcher
                      blur, Face ID lock, leaderboard visibility), appearance and units, refresh
```

## 3. Usage and limits: what the data supports

Provider rate limits (Claude 5h / 7d utilization, Codex windows, Cursor plan usage, and so on) are read on the computer with the user's local credentials (`src/lib/usage-limits.js`). Cloud never receives those credentials or readings, and no Cloud endpoint serves them. The phone therefore does not show provider limit percentages or reset times.

What the phone does show comes from existing Cloud endpoints:

- Last 5 hours: sum of `tokentracker-account-hourly` buckets for the current local hour and the four before it (today + yesterday). Whole-hour buckets, so it can include up to 59 extra minutes. Tokens only, because the hourly endpoint has no cost.
- Today, last 7 days, last 30 days: estimated USD from `tokentracker-account-summary` and `tokentracker-account-daily`.
- Per tool: `tokentracker-account-model-breakdown` for the last 7 and 30 days.

A bar is drawn only against a denominator the user chose: a daily / 7-day / 30-day spend target, or a per-tool 7-day / 30-day cap. Without one the row shows numbers only. Today's bar carries the even-pace notch from the shared macOS `LimitPace` engine, because today has a real reset (local midnight). Rolling 7/30-day windows have no reset, so they get no notch or ETA. Plan renewal dates are user-entered; an auto-renewing plan rolls forward by whole cycles once its date passes.

Targets, caps and renewal dates are stored only on the phone (`UserDefaults`).

## 4. Visual system

- Monochrome. Ink is `Color.primary`, so it is black in Light Mode and white in Dark Mode. Surfaces are system grouped backgrounds. The accent color asset is black / white. There is no brand hue.
- Color carries meaning only: orange when a target or cap passes 72%, red at 90% and for errors. Charts, share bars, token composition and the heatmap use grayscale steps of the label color.
- Liquid Glass is for controls: tab bar, segmented horizon / meter controls (`GlassSegmentedControl`), toolbar menus, sign-in and secondary buttons, notices. Data sits on opaque `secondarySystemGroupedBackground` cards so numbers keep contrast. Primary actions use `.glassProminent` tinted with the label color (black button, white text in Light Mode, the reverse in Dark Mode).
- Product mark: the real app icon artwork (`TokenTrackerMark` asset, copied from `TokenTrackerBar/AppIcon-iOS-Default-1024x1024@1x.png`) on sign-in, the lock screen and Cloud-required states. It is never redrawn.
- Provider marks: the dashboard's own assets. `scripts/sync-brand-assets.mjs` reads `PROVIDER_LOGO_MAP`, `PROVIDER_LOGO_CLASS_MAP` and `PROVIDER_ICON_MAP` from `dashboard/src/ui/dashboard/components/ProviderIcon.jsx`, copies the files from `dashboard/public/brand-logos/` (and converts the inline mono SVGs), and generates `ProviderMarkCatalog.generated.swift`. Lookup follows `ProviderIcon()`: logo file, then the `pi-*` fallback, then the inline mono mark. Marks the dashboard draws in `currentColor` or re-inks per theme become template images tinted with the label color. Sources with no mark in the product (Muse Code today) get the dashboard's dashed placeholder circle, never an SF Symbol stand-in.
- Sign-in: official GitHub Mark (template, label color) and four-color Google G (original colors) from `LoginCard.jsx`; email uses the system envelope.
- Type: San Francisco Dynamic Type styles, rounded bold for the hero cost, `.monospacedDigit()` on every number. Labels that must not break (token composition, window captions) use `fixedSize` / `lineLimit(1)` with `ViewThatFits` fallbacks instead of wrapping mid-word.

- Copy: labels, numbers and actions. No feature explainers, no "tap to…" hints, no paragraphs about how the app works. A footer appears only when it carries a fact the screen cannot show (for example "Mask Cost Figures also hides cost on share cards").
- Scroll content ends above the floating tab bar: every tab scroll view uses `scrollEdgeEffectStyle(.hard, for: .bottom)` and the system bottom inset, so the last row is reachable and readable.

## 5. Share

The phone reuses the dashboard's share card, not a new format. Source: `dashboard/src/ui/share/`.

- Entry: Share button in the Pulse toolbar, next to the computer filter. It is disabled until the current period has loaded with usage, so Share never produces a card for an empty, blocked or offline state.
- Data: `ShareCardData.build` ports `build-share-card-data.ts` and `buildTopModels`. Tokens and cost come from the current period's `account-summary`, top models from that period's `account-model-breakdown`, the heatmap from a 52-week `account-heatmap` call (the dashboard's share heatmap), falling back to the Pulse heatmap. Handle follows the dashboard's identity rule (name with non `[A-Za-z0-9._-]` replaced, "Anonymous" for email-like or empty names). There is no rank: the phone does not read the leaderboard, so Broadsheet prints the dashboard's "№ —".
- Mask Cost Figures sets the card cost to nil before rendering; the poster shows `$•••`.
- Styles: `NeonShareCard` (style id `annual-report`, 1080 × 1865, `neon_bg.png`, month heatmap, two stats, two facts, product mark footer, `tokentracker.cc`) and `BroadsheetShareCard` (1200 × 1630, ivory / ink / vermillion from the card's oklch literals, Times New Roman from the card's own serif fallback stack). CSS backdrop blur is approximated with the same translucent fill and an inset hairline.
- Output: `ImageRenderer` at 2× (the dashboard's capture pixel ratio) to PNG, handed to `ShareLink` with the `dashboard.screenshot.twitter_text` caption and `https://www.tokentracker.cc/u/{userId}?ref=share`. Generated on the device, never uploaded.

## 6. States

| State | Where | Behavior |
|---|---|---|
| Signed out | SignInView | OAuth providers from `/api/auth/public-config`, email sheet |
| No Cloud read access / read window ended | CloudAccessBlockedView | Distinct copy per server code, retry, approve CLI code, sign out |
| Cloud active, nothing synced | Pulse empty card | `npx tokentracker@latest init`, approve CLI code, refresh; Share disabled |
| Network or server failure, no cached data | WorkspaceFailureView | Message, Try Again, Settings |
| Partial failure with data | Pulse banner | "Some details couldn't load", Retry |
| Locked | Privacy overlay | Product mark, Face ID / passcode unlock; also covers the app switcher |
