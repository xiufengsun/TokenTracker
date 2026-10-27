# Plan:Dev 变体隔离实现(执行者:GLM-5.3-Flash-Max)

版本:v0.6 · 2026-09-05 · 5 轮双审通过(R5:A SHIP;B 唯一阻塞=基线判据,已修复) · 依据:`docs/dev-variant-isolation-spec.md`(v1.0 定稿)
执行约束(违反即停):
1. 只改本 plan 列出的文件;需要改其他文件 → STOP 报告。
2. 锚点(文件:行/签名)与真实代码不符 → STOP 报告,不得凭想象改。
3. 不 commit、不 bump 版本、不触发发布。
4. 每任务先跑完成判据再进下一任务。
5. 新增注释仅写代码表达不了的约束;风格与所在文件一致。

## 任务 0:基线(R5-B 修复)
`git status --short > /tmp/dev-variant-baseline.txt`(工作区已含当日 Silent Start 未提交
改动——7.1 改为"相对基线的增量"核对,不再要求恰好等于清单)。

## 任务 1:project.yml — 身份与名称

1. app target(`TokenTrackerBar`)的 `settings:` 块内、`base:` 同级,新增:
   ```yaml
      configs:
        Debug:
          PRODUCT_BUNDLE_IDENTIFIER: com.tokentracker.bar.dev
          PRODUCT_NAME: TokenTracker Dev
   ```
   (YAML 缩进对齐 `base:`;`base:` 内既有键不动,含 `INFOPLIST_VALUES` 两行死设置——原地保留。)
2. widget target(`TokenTrackerWidget`)的 `settings:` 块内同样新增:
   ```yaml
      configs:
        Debug:
          PRODUCT_BUNDLE_IDENTIFIER: com.tokentracker.bar.dev.widget
   ```
3. app `info.properties`:`CFBundleDisplayName: TokenTracker` → `CFBundleDisplayName: $(PRODUCT_NAME)`;
   `CFBundleName: TokenTracker` → `CFBundleName: $(PRODUCT_NAME)`;同步更新 :53 附近的
   过时注释(说明名称随 PRODUCT_NAME/配置变化)。
4. Release 不受影响:base 的 PRODUCT_NAME/ID 均为官方值;`configs` 精确名只命中 Debug。
完成判据:`xcodegen generate && ruby scripts/patch-pbxproj-icon.rb` 成功;然后
`(cd TokenTrackerBar && xcodebuild -project TokenTrackerBar.xcodeproj -scheme TokenTrackerBar -showBuildSettings -configuration Debug 2>/dev/null | grep -E "PRODUCT_BUNDLE_IDENTIFIER|PRODUCT_NAME" | sort -u)`
显示 `.dev` 与 `TokenTracker Dev`;同命令 `-configuration Release` 显示官方值。
(基线:改动前先跑一次 Release 版 -showBuildSettings 存 /tmp/baseline.txt。)

## 任务 2:`TokenTrackerBar/TokenTrackerBar/Utilities/Constants.swift` — 端口

:4-5 改为:
```swift
    #if DEBUG
    static let serverBaseURL = "http://localhost:7681"
    static let serverPort = 7681
    #else
    static let serverBaseURL = "http://localhost:7680"
    static let serverPort = 7680
    #endif
```
完成判据:`grep -rn "7680" --include="*.swift" TokenTrackerBar/`(整树)仅剩 Constants 的 `#else` 分支。

## 任务 3:Shared/WidgetSnapshot.swift — suite/widget id

`WidgetSharedConstants` 两常量**不相邻**(间有文档注释)——将 :16-24 整段替换为下块,
**两段文档注释在 #if/#else 分支内各保留一份**(文档注释置于 #if 之上将不附着到声明):
```swift
    #if DEBUG
    public static let appGroupIdentifier = "group.com.tokentracker.bar.dev"
    public static let widgetBundleIdentifier = "com.tokentracker.bar.dev.widget"
    #else
    public static let appGroupIdentifier = "group.com.tokentracker.bar"
    public static let widgetBundleIdentifier = "com.tokentracker.bar.widget"
    #endif
```
完成判据:`grep -rn "group.com.tokentracker.bar\"" --include="*.swift" TokenTrackerBar/`
仅剩该文件的 Release 分支。

## 任务 4:WidgetSnapshotWriter.swift — update no-op

将函数体**整体**用 `#if !DEBUG … #endif` 包裹(不用"入口 return"——那会触发
unreachable-code 警告;`updateGeneration += 1` 被跳过是安全的:所有调用方随即返回,
无状态残留):
```swift
    static func update(from vm: DashboardViewModel, capturedAt: Date) async {
        #if !DEBUG
        …原函数体逐行保留…
        #endif
    }
```
完成判据:构建通过且**无新增警告**(原判据"无警告新增"保留;Release 分支逐行不变)。

## 任务 5:更新菜单双点隐藏

1. `TokenTrackerBarApp.swift:24-26`(CommandGroup 内 Check for Updates Button):
   三行用 `#if !DEBUG` … `#endif` 包裹;:16-18 的相邻注释同步改为
   "Check for Updates is unavailable in Debug (Dev variant) builds" 语义。
2. `StatusBarController.swift` buildMenu 内 updateItem 插入段:**完整 6 行 :1235-1240**
   (updateTitle、init、.tag、.target、.isEnabled、menu.addItem)整体 `#if !DEBUG` 包裹
   (漏 `menu.addItem` 会报未定义符号)。(:1442 的 tag 观察者自守卫——item 不存在即
   返回——不改。)
3. **第三入口(R2 勘误)**:`Services/NativeBridge.swift:456-461`
   `case "checkForUpdates":`(体含 asyncAfter 跟进 pushSettings)——WebView JS 桥可触发。
   用 `#if !DEBUG` 包裹**整个 case 体(456-461,含 asyncAfter 跟进)**——空 case 经预处理
   后合法(R3 实测 swiftc -typecheck 通过)。
完成判据:构建通过;逐点核验(单靠 grep 不覆盖站点 1)——① 读 TokenTrackerBarApp.swift
  :24-26 确认包裹;② 读 StatusBarController.swift:1235-1240 确认包裹;③ `grep -n -A8 "case \"checkForUpdates\"" TokenTrackerBar/TokenTrackerBar/Services/NativeBridge.swift`
  确认 :456-461 整段在 `#if !DEBUG` 内。

## 任务 6:scripts/dev-cleanup.sh — 新建

```bash
#!/usr/bin/env bash
set -uo pipefail
# Remove every trace of the Debug "TokenTracker Dev" variant. Never touches the
# production domain (com.tokentracker.bar), ~/.tokentracker, or /Applications.
DEV_DOMAIN="com.tokentracker.bar.dev"
DEV_SUITE="group.com.tokentracker.bar.dev"

# 仅按 Dev 产物路径匹配(其他项目的 DerivedData Debug 不会被误伤);
# 不用 osascript quit-by-name —— Dev 未运行时它会先把 Dev 拉起来再退出。
pkill -f "TokenTrackerBar-[^/]*/Build/Products/Debug/TokenTracker Dev.app" 2>/dev/null || true
sleep 2

defaults delete "$DEV_DOMAIN" 2>/dev/null || true
defaults delete "$DEV_SUITE" 2>/dev/null || true

rm -rf "$HOME/Library/Group Containers/$DEV_SUITE" 2>/dev/null
rm -rf "$HOME/Library/WebKit/$DEV_DOMAIN" "$HOME/Library/Caches/$DEV_DOMAIN" 2>/dev/null
rm -rf "$HOME/Library/HTTPStorages/$DEV_DOMAIN" "$HOME/Library/HTTPStorages/$DEV_DOMAIN.binarycookies" 2>/dev/null
rm -rf "$HOME/Library/Saved Application State/$DEV_DOMAIN.savedState" 2>/dev/null

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
[ "$APP_DELETED" -eq 0 ] && echo "   4. Debug 产物已删除。" || echo "   4. 未找到 Debug 产物(可能已删)。"
defaults read com.tokentracker.bar >/dev/null 2>&1 && echo "✅ 自检:生产域完好" || echo "⚠️ 生产域读取失败(请人工确认)"
[ -d "/Applications/TokenTracker.app" ] && echo "✅ 自检:正式版 app 未被触碰" || echo "⚠️ 未找到 /Applications/TokenTracker.app"
```
完成判据:`bash -n scripts/dev-cleanup.sh` 语法通过;`chmod +x`。
(注释:HttpStorages 的 .binarycookies 变体一并清理;pkill 模式
`"TokenTrackerBar-[^/]*/Build/Products/Debug/TokenTracker Dev.app"` 按完整路径匹配,
仅命中 Dev 产物及其内嵌 node,不会误伤其他项目的 Debug 进程或 /Applications 正式版。)

## 任务 7:整体验证(D1-D9 抽本机可跑项)

1. `git status --short`:改动必须恰好为 project.yml、Constants.swift、WidgetSnapshot.swift、
   WidgetSnapshotWriter.swift、TokenTrackerBarApp.swift、StatusBarController.swift、
   scripts/dev-cleanup.sh(新增)、`TokenTrackerBar/TokenTrackerBar/Info.plist`
   (xcodegen 再生成的被跟踪产物,`$(PRODUCT_NAME)` 展开所致,任务 1 必要产物)、
   docs 的 spec/plan 两个 md(状态行,由本工作流更新)。
2. D1 同跑:启动正式版 → 启动 Dev → `lsof -nP -iTCP` 应见 7680/7681 双 LISTEN。
3. D2:Dev 切 Silent Start → `defaults read com.tokentracker.bar.dev LaunchSilently` = 1,
   `defaults read com.tokentracker.bar LaunchSilently` 报不存在(或原值不变)。
   3b. D2 语言双写:Dev 切语言 → `defaults read com.tokentracker.bar.dev AppleLanguages`
   与 `defaults read group.com.tokentracker.bar.dev tokentracker-locale` 均有值;
   生产域与生产 suite 无新值。
   3c. D3 Widget 零痕迹:生产版运行刷新一次,记录三处快照路径 mtime → 退生产版 →
   启动 Dev 刷新 → 三处 mtime 不变三路径(R2 实测):① `~/Library/Group Containers/group.com.tokentracker.bar/widget-snapshot.json`
   ② `~/Library/Application Support/TokenTrackerBar/widget-snapshot.json`
   ③ `~/Library/Containers/com.tokentracker.bar.widget/Data/Library/Application Support/TokenTrackerBar/widget-snapshot.json`
   (路径缺失记 skip)。
4. D4:Debug 产物 Info.plist 实际路径
   `$(ls -d ~/Library/Developer/Xcode/DerivedData/TokenTrackerBar-*/Build/Products/Debug/TokenTracker\ Dev.app)/Contents/Info.plist`,
   `plutil -p … | grep -E "CFBundleIdentifier|CFBundleName|CFBundleDisplayName"` 符合 §3
   (含 widget appex `Contents/PlugIns/TokenTrackerWidget.appex/Contents/Info.plist` 的
   `…dev.widget` id);Release showBuildSettings 与 /tmp/baseline.txt 一致;Release 产物
   Info.plist 的 CFBundleName/DisplayName plutil 验证仍为 `TokenTracker`(**须在任务 6
   清理前完成本项与上面的产物检查**——清理会删除 Debug 产物)。
5. D8:`(cd TokenTrackerBar && xcodebuild test -project TokenTrackerBar.xcodeproj
   -scheme TokenTrackerBar -configuration Debug)` 通过(**必须在 6 之前**——Debug 测试会
   把 `TokenTracker Dev.app` 重新构建进 DerivedData)。
6. D6:前置 = 生产版在运行;跑 dev-cleanup.sh → §6-2/3/4/6 消失、Debug 产物删除、
   stdout 含三条指引、生产域自检输出 ✅;幂等重跑不报错(set -uo 非 -e,容忍缺失);
   若步骤 5 又生成了产物,重跑一次本脚本。
7. 结束态:确认无 Dev 进程残留、重新 `open -a TokenTracker`(正式版),确认 7680 恢复。

## 风险与回退
- xcodegen 再生成会丢图标 → 必须跟 patch-pbxproj-icon.rb(任务 1 已含)。
- 任一端 30 分钟无法定位 → 回滚该文件(git checkout -- <file>),如实汇报。
