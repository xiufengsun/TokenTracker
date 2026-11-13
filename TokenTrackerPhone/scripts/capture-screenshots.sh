#!/usr/bin/env bash
# Captures the README / review screenshots from the Debug build's
# deterministic launch scenarios (see Models/SimulatorLaunchScenario.swift).
#
# Usage: scripts/capture-screenshots.sh <simulator-udid>
# Build first:
#   xcodebuild -project TokenTrackerPhone.xcodeproj -scheme TokenTrackerPhone \
#     -destination "platform=iOS Simulator,id=<udid>" -derivedDataPath build build
set -euo pipefail

UDID="${1:?simulator UDID required}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HERE/build/Build/Products/Debug-iphonesimulator/TokenTracker.app"
OUT="${OUT:-$HERE/Screenshots}"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Info.plist")"

xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 \
  --cellularBars 4 --wifiBars 3 --dataNetwork wifi
xcrun simctl install "$UDID" "$APP"
mkdir -p "$OUT"

# name  appearance  scenario  [scroll anchor]
shots=(
  "01-sign-in-light            light signin"
  "01b-sign-in-dark            dark  signin"
  "02-pulse-light              light active"
  "02b-pulse-tools-light       light active tools"
  "02c-pulse-models-light      light active models"
  "03-pulse-dark               dark  active"
  "03b-pulse-tools-dark        dark  active tools"
  "04-pacing-light             light limits"
  "04b-pacing-tools-light      light limits tools"
  "05-pacing-dark              dark  limits"
  "05b-pacing-tools-dark       dark  limits tools"
  "06-settings-light           light settings"
  "06b-settings-privacy-light  light settings privacy"
  "07-settings-dark            dark  settings"
  "08-cloud-access-required    light cloud-required"
  "08b-cloud-read-expired-dark dark  cloud-expired"
  "09-empty-first-sync         light empty"
  "10-offline-error-dark       dark  error"
)

for row in "${shots[@]}"; do
  read -r name appearance scenario anchor <<<"$row"
  xcrun simctl ui "$UDID" appearance "$appearance"
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  args=(--scenario "$scenario")
  [[ -n "${anchor:-}" ]] && args+=(--scroll "$anchor")
  xcrun simctl launch "$UDID" "$BUNDLE_ID" "${args[@]}" >/dev/null
  sleep 5
  xcrun simctl io "$UDID" screenshot --type=png "$OUT/$name.png" >/dev/null 2>&1
  echo "captured $name"
done

xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl status_bar "$UDID" clear
