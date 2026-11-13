# TokenTracker for iPhone — First-Principles Product Design

## 1. Product Thesis & Core Jobs

TokenTracker helps developers understand how they consume AI coding tools (Claude Code, Codex, Cursor, Gemini CLI, Muse Code, Kimi, DeepSeek, and others). Desktop computers already parse local session logs and sync privacy-safe hourly buckets to TokenTracker Cloud.

On a phone, the user is not debugging raw log files or reading wide multi-column tables. A phone app serves three concrete, high-frequency jobs:

1. **Glance at spend & velocity ("How much did I burn today, and on what?")**
   Check today's estimated cost against a 30-day baseline, inspect token cache efficiency, see hourly or 30-day velocity, and drill into which coding tools or models drove the spend across all synced computers—or isolated to one specific Mac, Linux box, or PC.
2. **Stay ahead of limits & burn pace ("Am I burning too fast before my window resets?")**
   Understand rolling consumption windows (5-hour bursts, 24-hour daily spend, 7-day rolling, and 30-day rolling) alongside personal spend targets, even-burn pace markers, and tool subscription renewal cycles.
3. **Control account, synced machines, & phone privacy ("Which machines are syncing, and is my screen private?")**
   Check Cloud status and retention windows, pause or resume Cloud uploads per computer, rename machines, approve an 8-character CLI `tokentracker login` code right from the phone, mask dollar figures in public, lock with Face ID, and manage public leaderboard visibility.

---

## 2. Information Architecture & Navigation

Instead of shrinking the desktop web dashboard into a single endless scroll of cards (or bolting disconnected tabs onto a desktop clone), the app uses a native **3-tab iOS 26 Liquid Glass `TabView`** (`.tabBarMinimizeBehavior(.onScrollDown)`):

```
RootContainerView
├── Unauthenticated ──► SignInView
│                         • GitHub / Google PKCE OAuth (ASWebAuthenticationSession)
│                         • Email + Password sheet
│
└── Authenticated (Keychain-backed CloudSession with single-flight refresh)
    ├── No Cloud Read Access ──► CloudAccessBlockedView (App Store 3.1.3(f) compliant)
    │                              • Explains computer → Cloud → iPhone data flow
    │                              • Distinguishes missing access vs. expired read window
    │                              • Retry, Approve CLI Code, or Sign Out / Switch Account
    │                              • Zero pricing links, upgrade prompts, or external purchase CTAs
    │
    └── Active Cloud Read Access ──► Native Liquid Glass TabView
        ├── Tab 1: Pulse (Usage & Spend)
        │     • Liquid Glass Horizon Strip (Today · Week · Month · 24M)
        │     • Toolbar Computer Scope Menu (All Macs & PCs, individual machines, Approve CLI Code)
        │     • Spend & Token Ledger (hero cost, 30d avg ratio badge, daily target pace bar, input/output/cache split)
        │     • Live Pacing Bridge Pill (interactive glass pill surfacing hottest tool target or 5h burst → jumps to Pacing)
        │     • Timeline Chart (24h intraday bar chart on Today; 30-day Cost/Tokens toggleable velocity chart on longer horizons)
        │     • Coding Tools Ledger (ranked tools with share bars; tap any tool for a model-level breakdown sheet)
        │     • Top Models & 18-Week Activity Consistency Heatmap (with streak lower-bound handling)
        │
        ├── Tab 2: Pacing (Windows, Targets & Cycles)
        │     • Liquid Glass Meter Mode Toggle (Used vs. Remaining — matching macOS menu bar semantics)
        │     • Account Rolling Windows Card (5h burst from `account-hourly`, Today 24h, 7d rolling, 30d rolling)
        │     • CodexBar-style Pace Notch (`LimitPace` shared from macOS) showing whether spend is ahead or under even-burn pace
        │     • Per-Tool Window & Plan Cards (Claude Code, Codex, Cursor, Muse Code, etc. with 5h/7d/30d metrics, optional spend caps, and billing renewal cycles)
        │     • Architectural Honesty Disclosure explaining why local CLI OAuth quota credentials stay on desktop
        │
        └── Tab 3: Settings (Account, Cloud, Privacy & Preferences)
              • Account Identity (display name, email, one-tap copyable Account ID)
              • TokenTracker Cloud Status (active/trial/gift/read-only state, sync cadence, retention, Approve CLI Code)
              • Synced Computers (`tokentracker-billing?action=devices` pause/resume + `tokentracker-device-rename`)
              • Privacy & Security (Mask Cost Figures, App Switcher blur shield, Face ID / Passcode lock, Public Leaderboard visibility editor via `tokentracker-public-visibility`)
              • Appearance & Units (System/Light/Dark, Currency USD/EUR/GBP/CNY/JPY/HKD, Compact vs. Exact tokens, K/M/B vs. 万/亿, Used vs. Remaining bars)
              • Session & Sync (Auto-refresh cadence: on open / 5m / 15m, manual refresh, Sign Out confirmation)
```

---

## 3. How Usage, Limits, and Settings Fit Together

### Honest Cloud Architecture for Usage + Limits
A critical product truth discovered in the codebase (`src/lib/usage-limits.js`, `dashboard/src/pages/LimitsPage.jsx`, `migrations/`):
- Live provider rate-limit percentages (such as Claude OAuth `five_hour`/`seven_day` utilization, Codex `wham` windows and reset-credit banks, or DeepSeek wallet balances) are polled directly on the desktop machine using local CLI credentials and browser cookies. **TokenTracker Cloud intentionally never uploads local provider credentials or live local rate-limit scrapes.**
- Pretending the phone has live OAuth quota percentages when no Cloud endpoint exists would violate data honesty; omitting limits altogether leaves the user blind to burn rate on mobile.

Our design resolves this cleanly without backend changes:
1. **Real Cloud Rolling Windows:** Using `tokentracker-account-hourly` (today + yesterday), `tokentracker-account-daily`, `tokentracker-account-summary?rolling=1`, and `tokentracker-account-model-breakdown`, the app computes genuine **5-hour trailing burst**, **24-hour**, **7-day**, and **30-day** token and estimated-cost windows per account and per coding tool.
2. **Shared Pace Engine (`LimitPace.swift`):** When the user sets a daily/weekly/monthly spend target or a per-tool budget + renewal date on iPhone, the app runs the exact same `LimitPace` math and CodexBar-style notched progress bar (`PaceMeterBar`) used in the macOS menu bar app—showing whether burn is ahead of or below even pace, plus projected exhaustion ETA.
3. **Coherent Cross-Linking:** Usage and limits are connected, not siloed. On **Pulse**, the Spend Ledger renders the daily target pace bar inline, and the **Live Pacing Bridge** surfaces the hottest tool budget or active 5-hour burst window one tap away from **Pacing**.
4. **Explicit Transparency:** A dedicated note in **Pacing & Limits** clearly explains that desktop-only live OAuth rate caps remain on-device for security, while iPhone tracks synced Cloud rolling windows, spend targets, and plan cycles.

### Actionable Companion Settings
Settings is designed specifically for a mobile companion rather than duplicating desktop-only settings (like launch-at-login or local port configuration):
- **Remote CLI Pairing (`tokentracker-device-flow-grant`):** Developers running `tokentracker login` on a headless Linux box or laptop can type the `XXXX-XXXX` pairing code directly on their iPhone to authorize the machine.
- **Machine Management (`tokentracker-billing?action=devices` & `tokentracker-device-rename`):** View last-seen timestamps, pause/resume Cloud uploads per machine, and rename computers.
- **Phone-Native Privacy:** One-tap cost masking (`$•••`) for public spaces, automatic blur shield in the iOS App Switcher, optional Face ID / Passcode lock on foreground return, and full control over Public Leaderboard visibility (`tokentracker-public-visibility`).

---

## 4. Native iOS 26 Liquid Glass Visual System

Built against the iOS 26+ SwiftUI SDK (`IPHONEOS_DEPLOYMENT_TARGET = 26.0`):
- **System Liquid Glass Navigation & Controls:** Floating Liquid Glass tab bar with `.tabBarMinimizeBehavior(.onScrollDown)`, `GlassEffectContainer` morphing horizon pills (`.glassEffect(..., in: .capsule)` + `.glassEffectID`), and `.buttonStyle(.glassProminent)` / `.buttonStyle(.glass)` actions.
- **Hierarchy Between Chrome and Data:** Following Apple's Liquid Glass guidance, translucent glass is reserved for navigation, floating filter pills, notices, and primary interactive controls—never stacked glass-on-glass behind dense charts. Data cards (`TelemetrySurface`) use semantic system grouped backgrounds over a subtle emerald/cyan `AtmosphericGlassCanvas` so numbers, charts, and heatmaps maintain crisp contrast in both Light and Dark Mode.
- **Typography & Numerals:** Native San Francisco Dynamic Type hierarchy (`largeTitle` down to `caption2`), rounded bold display figures for primary spend, and `.monospacedDigit()` across every token count, cost, percentage, and countdown so columns never jitter.
