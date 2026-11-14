# Spec:Dev 变体隔离(Dev Variant Isolation)

版本:v1.4 · 日期:2026-10-29 · 状态:定稿(4 轮双审意见已吸收,见评审史)· P0 已实现(2026-09-05),清理流程补全(2026-10-29)
评审史:R1 代码事实+契约清理 / R2 XcodeGen 精度+一致性 / R3 矛盾+可实现性 / R4 冷读+QA 审计,双审×4 轮已吸收,见文末修订记录
关联:`docs/silent-start-toggle-spec.md`、`docs/silent-startup.md`
范围:仅 macOS `TokenTrackerBar/` P0。决策记录:dev 端口 **7681**;**Dev 不写 Widget 快照**
(用户要求:开发完成后可快速抹除 dev 痕迹);**数据目录 `~/.tokentracker` 共享**。

## 1. 目标

同一 checkout 的 **Debug 构建成为可与正式版并存、且可一键抹除全部痕迹的 Dev 变体**:
两版同时运行互不干扰(端口/设置/Widget 快照),开发完成后按文档 + 脚本一步清理。
**Release 构建产物与上游发行版零差异(官方 bundle id、端口 7680;源级等值改写见 §2)。**

## 2. 非目标

- Windows / Linux 的 Dev 变体(P1)。
- `TOKENTRACKER_HOME` 数据沙箱(P1)。
- `tokentracker-dev://` 独立深链 scheme。
- Dev 图标着色(P1 可选)。
- Release 配置的任何改动(唯一例外:`info.properties` 的 CFBundleName/DisplayName
  改为 `$(PRODUCT_NAME)` 展开——Release 值恒等不变,见 §5/D4)。`bundle-node.sh`、
  发布工作流的任何改动。

## 3. 身份对照表(Debug = Dev 变体)

| 维度 | Debug(Dev 变体) | Release(官方) |
|---|---|---|
| App bundle id | `com.tokentracker.bar.dev` | `com.tokentracker.bar` |
| Widget bundle id | `com.tokentracker.bar.dev.widget` | `com.tokentracker.bar.widget` |
| PRODUCT_NAME(同时驱动 CFBundleName/DisplayName;**仅 app target**,widget 名称有意不改) | `TokenTracker Dev` | `TokenTracker` |
| 本地服务端口 | **7681** | 7680 |
| App Group suite | `group.com.tokentracker.bar.dev` | `group.com.tokentracker.bar` |
| 深链 | `tokentracker://`(同 scheme,最后启动者接管——已知限制) | 同左 |
| 数据目录 | `~/.tokentracker`(共享,§4.4) | 同左 |
| tests target id | 不变(逻辑测试,无 TEST_HOST,不受改名影响) | 不变 |

## 4. 行为契约

1. **并存**:Dev 与正式版同时运行,7681 / 7680 各自 LISTEN,互不杀对方服务器。
   启动期端口清理复用内嵌 CLI 的包身份校验,仅向确认属于 TokenTracker 的监听者发送信号;
   元数据不可读、校验器失败或进程已变化时均跳过,不得仅凭端口或脚本文件名终止未知服务。
2. **设置隔离**:Dev 的全部 UserDefaults.standard 偏好(Silent Start、语言、登录项、
   菜单栏、宠物、灵动岛)落 `com.tokentracker.bar.dev` 域;**切换语言会双写**——dev 标准域
   (`AppleLanguages`)与 dev suite(`tokentracker-locale`),经 §5 的 App Group 重映射。
   对生产域与生产 suite 零写入、零读取。首跑预期:生产语言**不会**带入 Dev——Dev 未设
   语言时按系统语言解析,直到在 Dev 中设置。
3. **Widget 零痕迹**:Debug 下 `WidgetSnapshotWriter.update` 直接 no-op(不写快照、不
   reload timelines、不触碰任何容器);`hasConfiguredWidgets()` 走 WidgetKit 查询,因
   dev widget 扩展无已添加小组件自然返回 false。
4. **数据共享(有意,含已知限制)**:两版都读写 `~/.tokentracker`。已知限制:并发 sync
   可能交错写 `cursors.json` / `queue.state.json` / `project.queue*.json` 等
   read-modify-write 状态文件(极端情况丢游标)。处置:文档注明"避免同时在两版点
   Sync Now";P1 可选加 flock。queue.jsonl 本身 append-only + 读端去重,可控。
5. **深链归属(已知限制)**:`tokentracker://` 由最后启动者接管;生产运行时 Dev 的
   OAuth 回调可能落进生产(Dev 登录静默失败)——重开 Dev 即恢复,不要"顺手修"。
6. **更新检查(本期处置:四处入口 Debug 全部硬关)**:`UpdateChecker.check(silent:)`
   自带两道运行时守卫(autoUpdate 关闭即跳过、非 `/Applications` 前缀路径即跳过),
   但路径守卫对**拷入 `/Applications` 或 `~/Applications` 的 Dev 副本无效**,且
   autoUpdate 默认开——仅靠运行时守卫不足。故四个入口在 Debug 均不编译/硬关:
   (a) SwiftUI 应用菜单 Button(`TokenTrackerBarApp` CommandGroup,`#if !TOKENTRACKER_NATIVE_QA && !DEBUG`);
   (b) 状态栏菜单 updateItem(`StatusBarController.buildMenu`,`#if !DEBUG`;tag 刷新
   观察者自守卫,item 不存在即返回,无需改动);
   (c) `NativeBridge.runAction("checkForUpdates")`(`#if !DEBUG`,仪表盘面板按钮由此失活);
   (d) 启动期静默自检(`TokenTrackerBarApp` didFinishLaunching 的
   `check(silent: true)`,`#if !DEBUG`,v1.1 补)。漏掉任一处都可能无人值守安装官方版。
7. **通知(已知限制)**:Dev 的系统通知与正式版外观一致,不加前缀(最小 diff;区分列 P1)。
8. **抹除**:§7 脚本清偏好/suite/容器/缓存并删 Dev 产物;执行后不留 `.dev` 痕迹,
   **例外三项**(脚本仅指引或系统级不可删):§6-5 登录项(条件存在,须先经菜单关闭)、
   §6-7 通知授权记录、§6-8 EmbeddedServer(可选,经 --clean)。

## 5. 实现要求(机制经 R2 勘误,以此为准)

- **`project.yml` app target**:`settings` 下新增
  ```yaml
      configs:
        Debug:
          PRODUCT_BUNDLE_IDENTIFIER: com.tokentracker.bar.dev
          PRODUCT_NAME: TokenTracker Dev
  ```
  (`configs` 块此前不存在,XcodeGen 默认生成 Debug/Release;精确名匹配只命中 Debug。)
- **`project.yml` widget target**:同样加 `configs.Debug:` 仅覆盖
  `PRODUCT_BUNDLE_IDENTIFIER: com.tokentracker.bar.dev.widget`。
- **`project.yml` app `info.properties`**:把 `CFBundleName` 与 `CFBundleDisplayName`
  改为 `$(PRODUCT_NAME)` 展开(R2 勘误:`INFOPLIST_VALUES` 是无效透传设置,真正生效的是
  `info.properties` 生成的静态 Info.plist,其内 `$(PRODUCT_NAME)`/`$(PRODUCT_BUNDLE_IDENTIFIER)`
  均已验证可展开;`CFBundleName` 无 INFOPLIST_KEY 变体,这是唯一可行机制)。
  Release 的 PRODUCT_NAME 不变 → 官方名不受影响。`LSUIElement = YES` 留在
  `info.properties`,与 config 无关;`INFOPLIST_VALUES` 两行死设置原地保留
  (无效但无害,R2 勘误);info.properties :53 的过时注释同步更新。
- **`Constants.swift:4-5`**:`serverBaseURL`/`serverPort` 改 `#if DEBUG` 7681 `#else` 7680。
- **`ServerManager.swift`**:已核验全部端口引用均走 `Constants.serverPort`(:59/:88/:194/:227)
  ——改 Constants 即全局生效;完成后以 `grep -rn "7680" --include="*.swift" TokenTrackerBar/`
  仅剩 Constants Release 分支为门禁。
- **`Shared/WidgetSnapshot.swift`(`WidgetSharedConstants` 所在,非独立文件)**:
  `appGroupIdentifier`(:18)与 `widgetBundleIdentifier`(:24)均加 `#if DEBUG` `.dev` 变体
  (后者仅用于容器路径推导,DEBUG 下因 update no-op 而不可达,改它为身份一致性)。
- **`Services/WidgetSnapshotWriter.swift`**:`update(from:capturedAt:)` 函数体入口
  `#if DEBUG return`(签名 `@MainActor async`,入口 return 安全,同时省去两次
  fetchRangeSummary API 调用)。
- **`buildMenu()`**:"Check for Updates" 菜单项用 `#if !DEBUG` 包裹插入段(Debug 不出现)。
- 构建前置:每次 `xcodegen generate` 后必须 `ruby scripts/patch-pbxproj-icon.rb`
  (图标补丁与 id/名称无关但会因再生成丢失)。
- Logger subsystem 不改;深链注册不变;entitlements 文件不变(应用非沙盒、无 App Group
  条目,dev suite 经 UserDefaults 即可用,无需授权)。

## 6. Dev 痕迹清单(全部可抹除项)

1. Dev app 产物:DerivedData Debug 产物 `TokenTracker Dev.app`。
2. `~/Library/Preferences/com.tokentracker.bar.dev.plist`(standard 域)。
3. `~/Library/Preferences/group.com.tokentracker.bar.dev.plist`(suite 域;非沙盒应用
   suite plist 落 Preferences,`defaults delete group.…` 经 cfprefsd 安全删除)。
4. `~/Library/Group Containers/group.com.tokentracker.bar.dev/`(若被创建;正常路径不创建),
   以及 Dev widget 的独立沙盒容器 `~/Library/Containers/com.tokentracker.bar.dev.widget/`。
5. SMAppService 登录项(仅当在 Dev 里开启过):系统设置 → 通用 → 登录项显示为
   **TokenTracker Dev**;须在 Dev 仍安装时经菜单关闭,或手动移除。
6. WebKit/缓存类:`~/Library/WebKit/com.tokentracker.bar.dev/`、
   `~/Library/Caches/com.tokentracker.bar.dev/`、`~/Library/HTTPStorages/…dev…`、
   `~/Library/Saved Application State/com.tokentracker.bar.dev.savedState`。
7. UNUserNotificationCenter 授权记录(随 bundle id 残留;系统级无法脚本删,文档注明)。
8. `TokenTrackerBar/EmbeddedServer/`(可选,`bundle-node.sh --clean`)。

**绝不触碰**:`com.tokentracker.bar` 域与 suite、`group.com.tokentracker.bar` 容器、
`~/.tokentracker`、`/Applications/TokenTracker.app`。

## 7. 清理脚本契约(`scripts/dev-cleanup.sh`)

1. 用 AppKit 查询 bundle id 恰为 `com.tokentracker.bar.dev` 的已运行实例并请求正常退出,
   不启动缺席应用、不按路径或端口批量杀进程。等待退出至多 10 秒,由
   `applicationWillTerminate` → `ServerManager.stopServer()` 停止自有服务(含包外 CLI fallback)。
   退出请求失败或超时必须以非零退出,且不继续删除偏好/容器/产物。
2. `defaults delete <域> 2>/dev/null || true`(两域各一次;域不存在时 defaults 以
   非零退出,脚本须容忍。**不得 killall cfprefsd**)。defaults delete 后 cfprefsd 会
   留下空 dict 的孤儿 plist;**域已删除之后,允许 rm 仅限两个 `.dev` 域的孤儿
   plist**(先 delete 后 rm 的顺序保证 cfprefsd 不再持有该域,不会复活;生产域
   plist 仍绝不可触碰)。v1.1 勘误:原"不得 rm Preferences plist"与 §6「执行后不留
   `.dev` 痕迹」矛盾,按孤儿文件语义收窄为上述例外。
3. `rm -rf` §6-4、§6-6 各路径(路径不存在不是失败;**真删除失败须 stderr 报告并以非零
   退出**,v1.1 ④)。
4. 删除 §6-1 的 Dev 产物(glob 定位,`-z` 判空跳过);产物状态行按「已删 / 真删除失败 /
   未找到」三态报告,由产物专属失败标志驱动,不与偏好/缓存/容器失败混判(v1.2)。
   多个产物部分删除成功、部分失败时,失败优先于成功,必须报告「删除失败」并以非零退出。
5. 打印指引:登录项手动移除(§6-5)、通知授权残留(§6-7)、`bundle-node.sh --clean`(§6-8)。
6. 自检:生产域仍存在(`defaults read com.tokentracker.bar` 不因脚本失败)、
   `/Applications/TokenTracker.app` 未被触碰。
**禁止**:删 `~/.tokentracker`、写生产域/生产容器、删正式版 app。

## 8. 验收标准

**QA 前置(构建与产物)**:`(cd TokenTrackerBar && xcodegen generate &&
ruby scripts/patch-pbxproj-icon.rb && xcodebuild -project TokenTrackerBar.xcodeproj
-scheme TokenTrackerBar -configuration Debug build)`;Debug 产物 =
`DerivedData/…/Build/Products/Debug/TokenTracker Dev.app`,`open` 启动。
showBuildSettings 命令同目录运行。

- D1 同跑:先正式版后 Dev,`lsof -nP -iTCP` 显示 7680/7681 双 LISTEN 且双方 node 进程
  存活;反序重测。
- D2 设置隔离(分域断言):Dev 切 Silent Start → `com.tokentracker.bar.dev` 域出现
  `LaunchSilently`;Dev 切语言 → dev 域与 dev suite 均写、生产域与生产 suite 不变;
  生产菜单一切如旧。
- D3 Widget 零痕迹(可执行流程):生产版运行并完成一次刷新后,记录三处快照路径的
  mtime——① App Group 容器 `group.com.tokentracker.bar/widget-snapshot.json`、
  ② 回退目录 `~/Library/Application Support/TokenTrackerBar/`、
  ③ `~/Library/Containers/com.tokentracker.bar.widget/Data/Library/`(精确子路径以
  `WidgetSnapshot.swift` 的 `widgetContainerSnapshotURL` 为准,路径缺失则跳过该项);
  触发刷新 = 启动 Dev(启动即刷);**记录 mtime 后先退出生产版**,否则生产版自动刷新会
  改动 mtime 造成假失败)→ 三处 mtime 全部不变(缺失路径记 skip)。
- D4 身份:Dev 运行时菜单栏应用名 `TokenTracker Dev`(人工目检登录项/菜单列表的截断
  表现,>15 字符已知);Debug 产物 Info.plist 四项
  (CFBundleIdentifier/Name/DisplayName + widget appex id)符合 §3;
  `xcodebuild -showBuildSettings -configuration Debug` 的 PRODUCT_NAME 为
  `TokenTracker Dev`;`-configuration Release` 的 id/PRODUCT_NAME 仍为官方值;Release Info.plist 的
  CFBundleName/CFBundleDisplayName 仍为 `TokenTracker`(plutil 验证 `$(PRODUCT_NAME)`
  展开无回归)。
- D5 深链:最后启动者接管(记录,不判失败)。
- D6 清理:前置 = 生产版在运行;执行 dev-cleanup.sh 后 §6-1/2/3/4/6 项消失,
  生产版仍在运行且 7680 仍 LISTEN;脚本 stdout 含登录项/通知授权/`--clean` 三条指引。
- D7 Release 零差异:**改动前**先采集基线
  `(cd TokenTrackerBar && xcodebuild -project TokenTrackerBar.xcodeproj -scheme TokenTrackerBar
  -showBuildSettings -configuration Release > /tmp/baseline.txt)`,验收时对比
  PRODUCT_BUNDLE_IDENTIFIER / PRODUCT_NAME 两键一致。
- D8 `xcodebuild test -configuration Debug` 通过(tests 为逻辑测试、无 TEST_HOST;
  已核验 tests 目录无 7680/官方 id 字面量,改名不影响)。
- D9 菜单:Debug 的状态栏菜单与 SwiftUI 应用菜单均无 "Check for Updates"
  (两处 `#if !DEBUG`;:1442 tag 观察者自守卫与 entitlements 不变均为代码审查结论)。

## 9. 发布

- 无发布动作:Dev 变体只存在于本地 Debug 构建;Release 产物与上游发行版同轨。

---

## 修订记录

- v1.4(2026-10-29,PR #901 后续评审吸收):§4-1 明确启动清理须通过 CLI 包身份校验,
  校验失败时保留监听进程;§7-4 明确多个产物部分删除失败时,失败状态优先于成功。
- v1.3(2026-10-29,PR #901 最新评审核实):§7-1 改为按精确 Dev bundle id 对已运行实例
  请求正常退出并等待,保留应用自身的 CLI 子进程清理;失败即停止删除。
  §6-4/§7-3 补入 Dev widget 的独立沙盒容器,与 App Group 容器分别清理。
- v1.2(2026-10-28,CodeRabbit PR #901 第二轮行内评审吸收):§7-4 产物状态行三态化——
  产物删除失败由专属 `PRODUCT_FAILED` 标志驱动,偏好/缓存/容器失败不再令「未找到
  Debug 产物」误报为「Debug 产物删除失败」;`CLEANUP_FAILED` 仅作总退出信号。
  §7-3 的 stderr 报告 + 非零退出契约不变。
- v1.1(缺口补全,2026-10-28):① §4-6 扩为四处更新入口(Debug 全硬关)——补
  (c) NativeBridge runAction 与 (d) 启动期静默自检(`#if !DEBUG`),并写明
  `UpdateChecker` 路径守卫对 /Applications、~/Applications 内的 Dev 副本无效、
  autoUpdate 默认开,运行时守卫不足;② §7-2 按"先 delete 后 rm 孤儿 plist"语义
  收窄原禁令(仅限两个 `.dev` 域、永不 killall cfprefsd、生产域绝不可触碰),
  与 §6 零痕迹目标对齐;③ 代码注释勘误:WidgetSnapshot.swift DEBUG 注释不再
  声称 entitlements 需要变更(entitlements config 无关且刻意不改);§4.x 引用
  统一为可解析的平铺记法 §4-1/§4-3;④ §7-3 删除失败语义——容忍路径不存在
  (`rm -rf` 对缺失路径本就返回 0),真删除失败须 stderr 报告并以非零退出
  (`remove_path` helper),CodeRabbit PR #901。
- v0.5(R4 双审吸收):① §4.2 语言双写(dev 域 AppleLanguages + dev suite)与 D2 分域断言对齐,补首跑前置;② §3 PRODUCT_NAME 标注仅 app target;③ §1 改"产物零差异";④ D3 补精确容器路径与"先退生产版"时序;⑤ D4 补截断目检与 Release plist 键检查;⑥ D7 补基线采集;⑦ 新增 QA 前置段;⑧ D6 补脚本 stdout 断言;⑨ D8 改事实陈述;⑩ D9 并入观察者与 entitlements 审查结论。
- v0.4(R3 双审吸收):① **[P0]** "Check for Updates" 有两处插入点(SwiftUI 应用菜单
  TokenTrackerBarApp.swift:24-26 + 状态栏 buildMenu:1235-1240),两处都要 `#if !DEBUG`;
  ② §4.8 抹除例外扩为三项(登录项/通知授权/EmbeddedServer);③ §2 与 D4 补
  info.properties 改写(值不变)的 Release 校验;④ D3 补"记录 mtime 后退出生产版";
  ⑤ §7-2 钉死 `defaults delete || true` 容错并禁止 rm plist / killall cfprefsd;
  ⑥ INFOPLIST_VALUES 死设置原地保留 + info.properties :53 过时注释同步;
  ⑦ project.yml target 级 settings.base 与 configs 共存已核验。
- v0.3(R2 双审吸收):① **[P0 机制勘误]** `INFOPLIST_VALUES` 为无效透传设置——改用
  `info.properties` 的 `$(PRODUCT_NAME)` 展开 + per-config PRODUCT_NAME 驱动名称;
  删除"LSUIElement 会丢"的错误警示;② widget target 补 per-config id 覆盖;③ D2 拆分为
  分域断言并写明首跑语言行为(跟随系统,不继承生产);④ D3 改为三路径 mtime 可执行流程;
  ⑤ 补 D9(更新菜单隐藏)与 D8 字面量注记(tests 无 TEST_HOST,逻辑测试不受改名影响);
  ⑥ §7-5 打印块补通知授权残留;⑦ D6 补生产版运行前置;⑧ D4 补 Debug PRODUCT_NAME 与
  widget appex id 检查;⑨ §4.7 通知不加前缀;⑩ 构建前置补 patch-pbxproj-icon.rb。
- v0.2(R1 双审吸收):ServerManager 零字面量勘误(Constants 已全引用)、
  hasConfiguredWidgets 机制更正、WidgetSharedConstants 实际位于 Shared/WidgetSnapshot.swift
  且 widgetBundleIdentifier 一并 .dev、sync 并发如实记录、痕迹清单补 WebKit/Caches 等、
  脚本与清单对齐、更新菜单隐藏、通知/登录项/suite 位置注记、D8 TEST_HOST 守门。
- v0.1:初稿(三项已确认决策:7681 / Dev 不写 Widget / 数据共享)。
