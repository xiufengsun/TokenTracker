#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${MACOS_DEVELOPER_ID_P12_BASE64:?Missing Developer ID signing identity}"
: "${MACOS_DEVELOPER_ID_P12_PASSWORD:?Missing Developer ID certificate password}"
: "${APPLE_NOTARY_KEY_P8_BASE64:?Missing Apple notarization API key}"
: "${APPLE_NOTARY_KEY_ID:?Missing Apple notarization key ID}"
: "${APPLE_NOTARY_ISSUER_ID:?Missing Apple notarization issuer ID}"
: "${VERSION:?Missing release version}"

app=${1:?Expected the built app path}
widget="$app/Contents/PlugIns/TokenTrackerWidget.appex"
embedded="$app/Contents/Resources/EmbeddedServer"
[[ -d "$widget" && -x "$embedded/node" ]]

tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/tokentracker-signing.XXXXXX")
keychain="$tmp/signing.keychain-db"
mountpoint="$tmp/disk"
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$mountpoint" -quiet || true
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf -- "$tmp"
}
trap cleanup EXIT

printf '%s' "$MACOS_DEVELOPER_ID_P12_BASE64" | base64 -D > "$tmp/certificate.p12"
printf '%s' "$APPLE_NOTARY_KEY_P8_BASE64" | base64 -D > "$tmp/notary-key.p8"
unset MACOS_DEVELOPER_ID_P12_BASE64 APPLE_NOTARY_KEY_P8_BASE64
password=$(openssl rand -hex 32)
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 10800 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$tmp/certificate.p12" -k "$keychain" -P "$MACOS_DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain"
unset MACOS_DEVELOPER_ID_P12_PASSWORD password
rm -f "$tmp/certificate.p12"

identity=$(security find-identity -v -p codesigning "$keychain" | awk '/"Developer ID Application:/{ print $2 }')
if [[ ! "$identity" =~ ^[A-Fa-f0-9]{40}$ ]]; then
  echo '::error::Expected one valid Developer ID Application signing identity.'
  exit 1
fi
sign=(codesign --force --keychain "$keychain" --sign "$identity" --timestamp)
runtime=("${sign[@]}" --options runtime)

# Node's V8 engine requires JIT under the hardened runtime. Keep this
# entitlement on Node alone. The host and widget retain their own entitlements.
cat > "$tmp/node-entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
</dict>
</plist>
PLIST

# Sign embedded executables before signing the extension and enclosing app.
while IFS= read -r -d '' binary; do
  if [[ "$binary" == "$embedded/node" ]]; then
    "${runtime[@]}" --entitlements "$tmp/node-entitlements.plist" "$binary"
  elif [[ $(file -b "$binary") == *Mach-O* ]]; then
    "${runtime[@]}" "$binary"
  fi
done < <(find "$embedded" -type f \( -name node -o -name '*.dylib' -o -name '*.so' -o -name '*.node' -o -perm -100 \) -print0)

"${runtime[@]}" --entitlements TokenTrackerWidget/TokenTrackerWidget.entitlements "$widget"
"${runtime[@]}" --entitlements TokenTrackerBar/TokenTrackerBar.entitlements "$app"
codesign --verify --deep --strict --verbose=2 "$app"
codesign -d --entitlements :- "$widget" > "$tmp/widget-entitlements.plist"
/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$tmp/widget-entitlements.plist" | grep -qx true

# Exercise the shipped signed runtime before building the installer.
TOKENTRACKER_NO_TELEMETRY=1 "$embedded/node" "$embedded/tokentracker/bin/tracker.js" --version | grep -Fx "v$VERSION"
"$embedded/node" -e 'let sum = 0; for (let i = 0; i < 100000; i++) sum += i; if (sum !== 4999950000) process.exit(1);'

bash scripts/create-dmg.sh "$app"
dmg=build/TokenTrackerBar.dmg
"${sign[@]}" "$dmg"
if ! xcrun notarytool submit "$dmg" --key "$tmp/notary-key.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID" --wait --output-format json > "$tmp/notary-result.json"; then
  echo '::error::Apple notarization did not complete.'
  exit 1
fi
if ! jq -e '.status == "Accepted"' "$tmp/notary-result.json" >/dev/null; then
  echo '::error::Apple rejected the macOS installer. Inspect the notary submission.'
  jq -r '"status=\(.status // "unknown") submission=\(.id // "unknown")"' "$tmp/notary-result.json"
  exit 1
fi

xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --ignore-cache --verbose=2 "$dmg"
mkdir "$mountpoint"
hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mountpoint" -quiet
mounted=true
codesign --verify --deep --strict --verbose=2 "$mountpoint/TokenTracker.app"
spctl --assess --type execute --ignore-cache --verbose=2 "$mountpoint/TokenTracker.app"
