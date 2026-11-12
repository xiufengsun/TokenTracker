# TokenTracker for iPhone

Read-only iPhone companion. It tracks nothing itself; it signs in to
TokenTracker Cloud and shows the usage your computers have synced there.
It only works for accounts with Cloud read access (membership or trial).

- Auth: InsForge PKCE OAuth (GitHub / Google) with the same
  `tokentracker://auth/callback` redirect as the desktop apps, or
  email + password. Tokens live in the keychain.
- Data: the cloud `tokentracker-account-*` edge functions (summary, daily,
  model breakdown, heatmap). Response models are shared with the macOS app
  from `../TokenTrackerBar/TokenTrackerBar/Models/`.
- Not shown: usage limits. They are computed locally on each computer and are
  never uploaded to the cloud.

## Build

Requires Xcode 16+ and XcodeGen on a Mac.

```bash
cd TokenTrackerPhone
xcodegen generate
xcodebuild -scheme TokenTrackerPhone -destination 'platform=iOS Simulator,name=iPhone 16' test
```

## Install on a phone with a free Apple ID

Create `Config/Local.xcconfig` (gitignored):

```
TT_BUNDLE_PREFIX = com.<something-unique-to-you>
DEVELOPMENT_TEAM = <your personal team ID>
```

Then build and install:

```bash
xcodebuild -scheme TokenTrackerPhone -configuration Debug \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  -derivedDataPath build build
xcrun devicectl device install app --device <device id> \
  build/Build/Products/Debug-iphoneos/TokenTracker.app
```

Free-account builds expire after 7 days. Re-run the install to renew. On the
phone, trust the developer profile once under Settings → General →
VPN & Device Management.
