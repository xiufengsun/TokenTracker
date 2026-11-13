# TokenTracker for iPhone

Native iOS 26 Liquid Glass companion for TokenTracker Cloud.

TokenTracker for iPhone tracks nothing locally on the phone — it signs in to your TokenTracker Cloud account and gives you an actionable mobile view of the AI coding usage, estimated spend, rolling burn windows, and synced computers your Mac, Windows, and Linux machines upload.

See [`DESIGN.md`](./DESIGN.md) for the full product architecture, information architecture, and design rationale.

## Key Capabilities

- **Pulse (Usage & Spend):** Cross-device or per-computer spend and token ledger, cache-hit efficiency, intraday 24-hour and 30-day velocity charts, coding tool & model breakdowns, and an 18-week consistency heatmap.
- **Pacing & Limits:** Synced 5-hour burst, 24-hour, 7-day, and 30-day rolling windows, optional personal spend targets with CodexBar-style even-burn pace notches (shared `LimitPace` engine with macOS), and per-tool plan renewal cycles.
- **Account, Cloud & Phone Privacy:** Cloud status & retention details, remote CLI pairing code approval (`tokentracker login`), computer pause/resume & rename, cost masking (`$•••`), App Switcher blur shield, Face ID lock, and Public Leaderboard visibility settings.
- **App Store 3.1.3(f) Compliant:** Pure companion experience with clear empty/blocked states and zero in-app purchase flows or external pricing/upgrade links.

## Build & Test

Requires Xcode 26+ and `xcodegen` on macOS.

```bash
cd TokenTrackerPhone
xcodegen generate
xcodebuild -project TokenTrackerPhone.xcodeproj \
  -scheme TokenTrackerPhone \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  test
```

## Install on a Personal iPhone

Create `Config/Local.xcconfig` (gitignored):

```xcconfig
TT_BUNDLE_PREFIX = com.<your-unique-prefix>
DEVELOPMENT_TEAM = <your-apple-team-id>
```

Then build and install:

```bash
xcodebuild -project TokenTrackerPhone.xcodeproj \
  -scheme TokenTrackerPhone \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates \
  -derivedDataPath build build
xcrun devicectl device install app --device <device-id> \
  build/Build/Products/Debug-iphoneos/TokenTracker.app
```
