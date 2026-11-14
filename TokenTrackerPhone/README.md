# TokenTracker for iPhone

Native iOS 26 companion for TokenTracker Cloud.

Token Tracker for iPhone tracks nothing on the phone. It signs in to TokenTracker Cloud and shows the usage, estimated spend and synced computers that your Mac, Windows and Linux machines upload.

Design: [`DESIGN.md`](./DESIGN.md). Latest review: [`REVIEW.md`](./REVIEW.md).

## What it shows

- Pulse: estimated cost, tokens and sessions for Today, Week, Month or 24 months, for all computers or one. Hourly or 30-day chart, coding tools with real brand marks, top models, 18-week heatmap.
- Pacing: last 5 hours, today, 7 days and 30 days. Bars appear against spend targets and per-tool caps you set on the phone. Plan renewal dates are optional. Provider rate limits stay on the desktop, because they use local credentials.
- Settings: Cloud status, synced computers (pause / resume / rename), CLI pairing-code approval, cost masking, app-switcher blur, Face ID lock, leaderboard visibility, units.
- No in-app purchase and no pricing or upgrade links (App Store 3.1.3(f)).

## Brand assets

Provider marks and the product mark come from the dashboard. After changing `dashboard/src/ui/dashboard/components/ProviderIcon.jsx` or `dashboard/public/brand-logos/`, run:

```bash
node TokenTrackerPhone/scripts/sync-brand-assets.mjs
```

## Screenshots

```bash
TokenTrackerPhone/scripts/capture-screenshots.sh <simulator-udid>   # after a Debug simulator build
```

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
