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
│                  GitHub / Google (PKCE via ASWebAuthenticationSession), email + password sheet
└── Signed in (Keychain session, single-flight refresh)
    ├── No Cloud read access ─► CloudAccessBlockedView
    │     Explains computer → Cloud → iPhone, shows the account, offers
    │     Check Again / Approve CLI Code / Sign Out. No prices, upgrade prompts or purchase links.
    └── TabView (Liquid Glass tab bar, minimizes on scroll)
        ├── Pulse     horizon (Today · Week · Month · 24M), computer filter, cost + tokens,
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

## 5. States

| State | Where | Behavior |
|---|---|---|
| Signed out | SignInView | OAuth providers from `/api/auth/public-config`, email sheet |
| No Cloud read access / read window ended | CloudAccessBlockedView | Distinct copy per server code, retry, approve CLI code, sign out |
| Cloud active, nothing synced | Pulse empty card | `npx tokentracker@latest init`, approve CLI code, refresh |
| Network or server failure, no cached data | WorkspaceFailureView | Message, Try Again, Settings |
| Partial failure with data | Pulse banner | "Some details couldn't load", Retry |
| Locked | Privacy overlay | Product mark, Face ID / passcode unlock; also covers the app switcher |
