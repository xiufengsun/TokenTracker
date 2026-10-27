#!/usr/bin/env bash
set -uo pipefail

# ─────────────────────────────────────────────
# dev-cleanup.sh
# Remove every trace of the Debug "TokenTracker Dev" variant (spec §7).
# Never touches the production domain (com.tokentracker.bar), the production
# App Group container, ~/.tokentracker, or /Applications/TokenTracker.app.
# Idempotent: safe to run repeatedly.
# ─────────────────────────────────────────────

DEV_DOMAIN="com.tokentracker.bar.dev"
DEV_SUITE="group.com.tokentracker.bar.dev"

# 1. Quit the Dev app. Path-scoped match: only the DerivedData Debug product
#    and its embedded node — other projects' Debug processes are unaffected.
#    (No osascript quit-by-name: it would LAUNCH the app if it isn't running.)
pkill -f "TokenTrackerBar-[^/]*/Build/Products/Debug/TokenTracker Dev.app" 2>/dev/null || true
sleep 2

# 2. Preferences: standard domain + shared-suite domain. `defaults delete`
#    exits nonzero when the domain is missing — tolerated. Never `rm` the
#    Preferences plists and never `killall cfprefsd` (cfprefsd coherence).
defaults delete "$DEV_DOMAIN" 2>/dev/null || true
defaults delete "$DEV_SUITE" 2>/dev/null || true
# cfprefsd leaves an empty-dict plist behind after a domain delete; once the
# domain is forgotten, removing the orphan file is safe and keeps traces at zero.
rm -f "$HOME/Library/Preferences/$DEV_DOMAIN.plist" \
      "$HOME/Library/Preferences/$DEV_SUITE.plist" 2>/dev/null

# 3. Containers / WebKit / caches (tolerate absence).
rm -rf "$HOME/Library/Group Containers/$DEV_SUITE" 2>/dev/null
rm -rf "$HOME/Library/WebKit/$DEV_DOMAIN" "$HOME/Library/Caches/$DEV_DOMAIN" 2>/dev/null
rm -rf "$HOME/Library/HTTPStorages/$DEV_DOMAIN" "$HOME/Library/HTTPStorages/$DEV_DOMAIN.binarycookies" 2>/dev/null
rm -rf "$HOME/Library/Saved Application State/$DEV_DOMAIN.savedState" 2>/dev/null

# 4. Delete the Debug product itself.
APP_DELETED=1
for app in ~/Library/Developer/Xcode/DerivedData/TokenTrackerBar-*/Build/Products/Debug/TokenTracker\ Dev.app; do
  [ -e "$app" ] || continue
  rm -rf "$app" && APP_DELETED=0
done

echo "✅ Dev 痕迹已清理(默认域/suite/容器/缓存/产物)。"
echo "ℹ️  手动检查项:"
echo "   1. 系统设置 → 通用 → 登录项:若存在 'TokenTracker Dev' 请手动移除。"
echo "   2. 通知授权记录随 bundle id 残留,系统级无法脚本删除。"
echo "   3. EmbeddedServer/ 构建产物可用 ./scripts/bundle-node.sh --clean 清理(可选)。"
if [ "$APP_DELETED" -eq 0 ]; then
  echo "   4. Debug 产物已删除。"
else
  echo "   4. 未找到 Debug 产物(可能已删)。"
fi

# 6. Self-check: production must be untouched.
defaults read com.tokentracker.bar >/dev/null 2>&1 && echo "✅ 自检:生产域完好" || echo "⚠️ 生产域读取失败(请人工确认)"
[ -d "/Applications/TokenTracker.app" ] && echo "✅ 自检:正式版 app 未被触碰" || echo "⚠️ 未找到 /Applications/TokenTracker.app"
