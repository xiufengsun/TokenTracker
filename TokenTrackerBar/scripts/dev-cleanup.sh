#!/usr/bin/env bash
set -uo pipefail

# ─────────────────────────────────────────────
# dev-cleanup.sh
# Remove every trace of the Debug "TokenTracker Dev" variant (spec §7).
# Never touches the production domain (com.tokentracker.bar), the production
# App Group container, ~/.tokentracker, or /Applications/TokenTracker.app.
# Idempotent: safe to run repeatedly. Missing paths are tolerated (rm -rf is
# a no-op on them); REAL deletion failures are reported on stderr and make
# the script exit nonzero.
# ─────────────────────────────────────────────

DEV_DOMAIN="com.tokentracker.bar.dev"
DEV_SUITE="group.com.tokentracker.bar.dev"
CLEANUP_FAILED=0
PRODUCT_FAILED=0

remove_path() {
  # rm -rf returns 0 for absent paths, so a nonzero here is a real failure.
  if ! rm -rf "$1" 2>/dev/null; then
    echo "⚠️  删除失败: $1" >&2
    CLEANUP_FAILED=1
  fi
}

# 1. Ask only already-running Dev instances to quit normally, so
#    applicationWillTerminate stops their owned server (including CLI fallback
#    processes outside the app bundle). Never launch an absent app or signal
#    processes by a broad path/port match. Abort before deleting if quit fails.
if ! osascript -l JavaScript <<'JXA'
ObjC.import("AppKit");
var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.tokentracker.bar.dev");
for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    if (!app.terminated && !app.terminate) throw new Error("Dev app quit request failed");
}
for (var attempt = 0; attempt < 100; attempt++) {
    var running = false;
    for (var i = 0; i < apps.count; i++) {
        if (!apps.objectAtIndex(i).terminated) running = true;
    }
    if (!running) break;
    delay(0.1);
}
for (var i = 0; i < apps.count; i++) {
    if (!apps.objectAtIndex(i).terminated) throw new Error("Dev app quit timeout");
}
JXA
then
  echo "⚠️  Dev app 未能正常退出,已停止清理;请先退出 Dev app 后重试。" >&2
  exit 1
fi

# 2. Preferences: standard domain + shared-suite domain. `defaults delete`
#    exits nonzero when the domain is missing — tolerated. Never `killall
#    cfprefsd` (cfprefsd coherence). cfprefsd leaves an empty-dict plist
#    behind after a domain delete; once the domain is forgotten, removing the
#    orphan file is safe and keeps traces at zero (dev spec §7-2).
defaults delete "$DEV_DOMAIN" 2>/dev/null || true
defaults delete "$DEV_SUITE" 2>/dev/null || true
if ! rm -f "$HOME/Library/Preferences/$DEV_DOMAIN.plist" \
      "$HOME/Library/Preferences/$DEV_SUITE.plist" 2>/dev/null; then
  echo "⚠️  删除失败: .dev Preferences plists" >&2
  CLEANUP_FAILED=1
fi

# 3. Containers / WebKit / caches (tolerate absence, report real failures).
remove_path "$HOME/Library/Group Containers/$DEV_SUITE"
remove_path "$HOME/Library/Containers/$DEV_DOMAIN.widget"
remove_path "$HOME/Library/WebKit/$DEV_DOMAIN"
remove_path "$HOME/Library/Caches/$DEV_DOMAIN"
remove_path "$HOME/Library/HTTPStorages/$DEV_DOMAIN"
remove_path "$HOME/Library/HTTPStorages/$DEV_DOMAIN.binarycookies"
remove_path "$HOME/Library/Saved Application State/$DEV_DOMAIN.savedState"

# 4. Delete the Debug product itself.
APP_DELETED=1
for app in ~/Library/Developer/Xcode/DerivedData/TokenTrackerBar-*/Build/Products/Debug/TokenTracker\ Dev.app; do
  [ -e "$app" ] || continue
  if rm -rf "$app"; then
    APP_DELETED=0
  else
    echo "⚠️  删除失败: $app" >&2
    CLEANUP_FAILED=1
    PRODUCT_FAILED=1
  fi
done

if [ "$CLEANUP_FAILED" -eq 0 ]; then
  echo "✅ Dev 痕迹已清理(默认域/suite/容器/缓存/产物)。"
else
  echo "⚠️  清理完成,但有删除失败项(见上方 ⚠️ 行)。"
fi
echo "ℹ️  手动检查项:"
echo "   1. 系统设置 → 通用 → 登录项:若存在 'TokenTracker Dev' 请手动移除。"
echo "   2. 通知授权记录随 bundle id 残留,系统级无法脚本删除。"
echo "   3. EmbeddedServer/ 构建产物可用 ./scripts/bundle-node.sh --clean 清理(可选)。"
if [ "$PRODUCT_FAILED" -ne 0 ]; then
  echo "   4. Debug 产物删除失败(见上方 ⚠️ 行)。"
elif [ "$APP_DELETED" -eq 0 ]; then
  echo "   4. Debug 产物已删除。"
else
  echo "   4. 未找到 Debug 产物(可能已删)。"
fi

# 6. Self-check: production must be untouched.
defaults read com.tokentracker.bar >/dev/null 2>&1 && echo "✅ 自检:生产域完好" || echo "⚠️ 生产域读取失败(请人工确认)"
[ -d "/Applications/TokenTracker.app" ] && echo "✅ 自检:正式版 app 未被触碰" || echo "⚠️ 未找到 /Applications/TokenTracker.app"

# 7. Exit nonzero when any real deletion failed (absence is not a failure).
if [ "$CLEANUP_FAILED" -ne 0 ]; then
  echo "⚠️  部分路径删除失败(见上方 ⚠️ 行),以非零状态退出。" >&2
  exit 1
fi
