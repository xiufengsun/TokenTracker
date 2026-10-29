# Spec:静默启动用户开关(Silent Start)

版本:v1.6 · 日期:2026-10-29 · 状态:定稿(5 轮双审通过,R5 双 SHIP)· P0 已实现,v1.1 设置页开关已实现,待发布
评审史:R1 代码事实 / R2 语义规范 / R3 矛盾可实现性 / R4 冷读核验+验收审计,双审×4 轮已吸收
关联文档:`docs/silent-startup.md`、`docs/silent-start-toggle-plan.md`
**落盘路径(定稿)**:`docs/silent-start-toggle-spec.md`(`docs/plans/` 被 .gitignore 忽略,
定稿必须落在被 git 跟踪的路径)
范围:macOS `TokenTrackerBar/`、Windows `TokenTrackerWin/`、Linux `TokenTrackerLinux/` 三端 P0。

## 1. 目标

新增持久化用户开关「静默启动 / Silent Start」(布尔,默认**关**):开启后,任何方式的启动都只保留
菜单栏 / 系统托盘存在,**不弹出主面板**(macOS 仪表盘窗口、Windows 宠物、Linux 主窗口);
关闭时,各端行为与 §4.5 的现状基线一致(**唯一例外:§4.3 的 Windows 宠物优先级修复,它即使
在开关关闭时也生效**)。

## 2. 非目标

- 不改变后台行为:本地服务器、日志同步、自动刷新、桌面小组件在开关任何状态下完全一致。
- 不包含:三端统一设置页开关(P2;**v1.1 部分落地:macOS/Windows 面板开关经 §5.3 实现,
  Linux 因 Tauri webview 无原生设置桥接仍遗留**)、Linux 开机自启(P1)、**macOS `'lgit` 检测写法对齐
  LaunchAtLogin-Modern(P1,显式延后以防遗失)**、全局热键(P3)、轻量模式(独立评审)、
  窗口几何持久化、**Windows 自启状态再同步(读 `StartupApproved`,P2)**;
  **本开关不新增任何可见性持久化**(既有 `PetVisible` 行为不变,仅受 §4.3 门控)。
- **实现形态铁律:静默 = 窗口"创建但隐藏"或(macOS/Windows 情形)压根不创建仪表盘窗口——两者都合法;
  禁止"先创建再销毁"的轻量化实现**(Linux WebKitWebProcess 孤儿泄漏先例 clash-verge #6874)。
  Linux 主窗口创建但隐藏;macOS/Windows 的仪表盘懒创建(首次打开或处理深链时才创建)视为等价合法形态。
- 不移除 Windows 既有 `--startup` 参数;持久化开关与参数取"或"(§3)。
- macOS 的菜单栏 popover、灵动岛、桌面宠物的既有行为不受本开关影响(§4.3)。

## 3. 开关定义

| 端 | 存储位置 | 键 | 默认 |
|---|---|---|---|
| macOS | `UserDefaults.standard` | `LaunchSilently`(BOOL) | NO |
| Windows | `%LOCALAPPDATA%\TokenTracker\native-settings.json` | `StartSilently`(bool) | false |
| Linux | `$XDG_CONFIG_HOME/tokentracker/settings.json`(未设时 `~/.config/...`) | `silent_start`(bool) | false |

- 键 / 文件不存在、JSON 损坏或不可读 → 一律按默认值 `false` 处理,不崩溃。
- Linux 路径**刻意不用** Tauri `app.path().app_config_dir()`(会得到 `cc.tokentracker.linux/`
  目录且依赖 AppHandle 不利单测);手写 XDG 解析以遵循仓库既有 `tokentracker` XDG 命名惯例并保持可测性。
- **快照语义**:设置在启动时读取一次,作为本次运行的快照;运行中文件被删 / 损坏不影响当前运行
  (以内存值为准),下次启动按实际文件(损坏 → false)。Windows 侧 `Program.Main` 读一次后传参,
  启动门控一律用快照值;`SilentStart.Enabled` 属性按调用读取(仅托盘处理器等非门控场景使用)。
- **生效时机:仅影响下一次启动(三端统一)**;运行中切换只写存储并更新菜单勾选态,不改变当前窗口
  可见性。
- Windows 等效静默 `silent_effective = StartSilently || 命令行含 --startup`(§4.3)。
- 隐私:仅本机存储的一个布尔,无任何数据外发。

## 4. 行为契约(核心)

### 4.1 启动来源分类

| 来源 | 定义 | 判定 |
|---|---|---|
| manual | 用户主动启动(Finder/Dock 双击、开始菜单、安装后自动运行[无参数]) | 非 login 的常规进程启动 |
| login | 系统登录项拉起 | macOS:`'lgit` Apple 事件;Windows:命令行含 `--startup`;Linux(P1):autostart |
| deeplink | `tokentracker://` 链接(含 OAuth 回调) | URL 协议激活 |
| resummon | 托盘/菜单栏点击、二次启动转发(无深链且非 `--startup`,见 §4.4-3)、macOS Dock reopen | 用户意图 surface |

### 4.2 主面板行为矩阵

| 来源 \ silentStart | OFF(默认) | ON |
|---|---|---|
| manual | macOS:弹仪表盘;Windows:弹(v1.4 勘误:#832 后基线,login 仍不弹;宠物按 §4.3);Linux:弹窗口 | 三端均不弹 |
| login | macOS:不弹(现状);Windows:不弹;Linux(P1):不弹 | 三端均不弹 |
| deeplink | 三端均弹(Linux 的 auth 回调路径现状已弹窗,无需改动) | 三端均弹(含冷启动注记) |
| resummon | 三端均弹 | 三端均弹 |

> 冷启动注记:Windows 首实例启动即携带深链参数时,**deeplink 绕过静默门控必弹仪表盘**
> (该路径不受 `silent_effective` 影响);**宠物不享受深链豁免,任何情况按 §4.3 门控**——
> `silent_effective=true`(开关开或 `--startup`)时一律不弹,`StoredVisible=true` 亦不恢复;
> 仅开关关且手动带深链时按 §4.3 公式正常处理(v1.5 勘误:v1.4 ② 未区分
> `silent_effective` 分支,易误读为深链一律恢复宠物)。

### 4.3 宠物 / 辅助面板规则

- **Windows 宠物**:设 `silent_effective = StartSilently || --startup`。宠物显示条件为
  **`!silent_effective && (PetWindow.StoredVisible ?? showPetOnLaunch)`** ——门控在表达式**外**
  相乘(若折入 `showPetOnLaunch`,`PetVisible=true` 时 `??` 短路会令门控失效,切勿那样写)。
  `showPetOnLaunch` 保持现状 `deepLink is null && !launchedAtStartup` 不变。
  实现:`Program.Main` 计算 `silent_effective` 与 `showPetOnLaunch`,**二者作为参数**传入
  `TrayApplicationContext` 构造器,构造器内 :242 分支改用上式。
  效果:自启或开关开启时宠物一律不弹(修复"宠物覆盖自启静默"存量漏洞);手动启动且开关关时
  逐字保持现状。此项为**唯一**的关态行为变更(修复项)。
- **macOS**:灵动岛、桌面宠物、菜单栏 popover 均不受开关影响(非激活面板不抢焦点,基线保留;
  "藏图标必先开灵动岛"的永零可见面不变量已存在,静默不与其冲突)。
- **Linux**:无辅助面板。

### 4.4 铁律(任何开关状态)

1. 托盘 / 菜单栏"Open Dashboard"点击 → 弹。
2. deeplink → 弹。Windows 仅处理 `auth/callback` 主机(现状);macOS `open|dashboard|auth/*`(现状);
   Linux 由 `oauth::deliver_pending_callback` 成功路径的 `show()+set_focus()` 保证(现状,勿动)。
   Windows 冷启动带深链参数同样必弹(§4.2 注记)。
3. 二次启动转发 → 弹,但 **Windows 携带 `--startup` 的二次实例不发 `activate`**(login 静默优先;
   此时若同时携带深链,深链转发照常、弹窗由深链规则决定)。无深链二次启动发 `activate` 并弹面板
   (修复"静默开 + 再次双击 = 什么都不发生");Linux 单实例回调已弹;macOS reopen 已弹。
4. 后台服务器 / 同步 / 刷新 / 小组件零影响。
5. 静默实现形态见 §2 铁律(创建但隐藏 / macOS、Windows 懒创建;禁止销毁)。

### 4.5 现状基线(开关关闭时逐字保持,唯 §4.3 宠物修复除外)

- macOS:manual 弹、login 不弹(`TokenTrackerBarApp.swift:149-154`)、deeplink 弹、reopen 弹。
- Windows:manual 弹 / login 不弹(v1.4 勘误:#832 后基线如此,关闭时逐字保持;
  宠物按 §4.3(含修复项));deeplink(auth/callback)弹。
- Linux:窗口以可见方式创建并展示加载页 → 仪表盘(`main.rs:274-283`、`start_dashboard`)。

## 5. UI 呈现(P0 范围;设置页开关见 §5.3,三端统一仍为 P2)

### 5.1 位置与形态

| 端 | 位置 | 形态 |
|---|---|---|
| macOS | 状态栏右键菜单,**紧随 "Launch at Login" 项之后**,同组无分隔线 | 可勾选菜单项 |
| Windows | 托盘右键菜单,**`_startupItem` 之后紧邻插入**(`_menu.Items`),无分隔线 | 复选菜单项 |
| Linux | 托盘菜单,"Open Dashboard" 与 "Quit" 之间 | CheckMenuItem(id 固定 `silent-start`) |

### 5.2 文案表(canonical,实现照抄)

| 项 | en | zh-Hans |
|---|---|---|
| 菜单标签(三端) | `Silent Start` | `静默启动` |

- macOS `Strings` 表为五语种(en/zh-Hans/zh-Hant/ja/ko):zh-Hans 用 `静默启动`,
  **zh-Hant/ja/ko 传英文原文 `Silent Start`**(最小 diff,不引入未评审的翻译)。
- "下次启动生效"提示:**三端菜单均不承载**(v1.2 起 macOS 也移除了
  `NSMenuItem.toolTip`,owner 决定——语义由 §3「生效时机」与面板行 hint
  `silentStartHint` 承载;Windows `ToolTipText` 需 `ShowItemToolTips` 且自定义 renderer
  不渲染,Linux CheckMenuItem 无可靠 tooltip,均不做)。
- 勾选态实时反映存储值;切换即时持久化。
- 本地化链路:Windows 新项**必须**接入 `ApplyLocaleToMenu`(创建时空文本,语言切换时统一上文案);
  macOS 新增 `Strings` 键并在 `buildMenu` 使用;Linux 托盘现状即英文硬编码(与 Open Dashboard/Quit
  一致),直接字面量。仓库的 copy.csv / `validate:ui-hardcode` 规则仅约束 dashboard,不约束原生菜单。
- 隐私说明:本开关仅在本机存一个布尔,无任何数据外发。

### 5.3 设置页开关(Panel toggle,v1.1;macOS + Windows)

仪表盘设置页「App 与更新」区块(`MenuBarSection`)在「登录时启动」行下方新增「静默启动」开关,
与托盘/菜单栏菜单项读写**同一份存储**(§3),双向实时同步。Linux 面板不渲染该区块(Tauri
webview 既无 `webkit.messageHandlers.nativeBridge` 也无 `chrome.webview` 桥接,
`MenuBarSection` 因 `available=false` 直接返回 null),无需改动。

| 端 | 状态源(与 §3 同键) | 双向同步路径 |
|---|---|---|
| macOS | `UserDefaults LaunchSilently` | 面板 `setSetting("launchSilently")` → `NativeBridge.applySetting` 写入 → 尾部 `pushSettings()` 回显;菜单 `toggleSilentStart` 写入后主动 `pushSettings()` 推送面板(webview 不存在时 no-op) |
| Windows | `native-settings.json StartSilently` | 面板 → `ApplyDashboardNativeSetting` → `SilentStart.Set` → 尾部 `PushDashboardNativeSettings()` 回显;托盘 `OnToggleSilentStart` 末尾追加 `PushDashboardNativeSettings()`(dashboard 为 null 时 no-op) |

- 行显隐门控沿用 launchAtLogin 惯例 `launchSilentlySupported !== false`:macOS 载荷仅含
  `launchSilently`(无须 supported 键);Windows 载荷推 `launchSilentlySupported = true`——
  与 launchAtLogin 的 macOS-only 处理**刻意相反**:Silent Start 三端皆有,面板同样开放。
- **QA 模式必须隐藏该行**:QA mock 载荷加 `launchSilently: false` +
  `launchSilentlySupported: false`。QA `setSetting` 白名单(`NativeQAProfile.
  permitsNativeMessage`)不含新键,若渲染可点击的开关,点击会触发
  `fatalError("Native QA bridge message rejected")`。
- **新行必须位于 `launchAtLoginSupported` 条件块之外**(Windows 推该键为 false,置于块内
  会连带隐藏);即 launchAtLogin 块之后、syncNow 行之前。
- 文案:入 `copy.csv`(en 基准)+ 5 locale `core.json`;提示语取三端中性措辞,
  zh-Hans「下次启动时仅驻留菜单栏(托盘),不自动打开仪表盘或桌宠。」。
- macOS `applySetting` case 不发 `.nativeSettingsChanged`(无 live 观察者,launchAtLogin
  先例);菜单勾选态仍由 `buildMenu()` 构建期计算(§6.1)。
- web 改动后必须 `npm run dashboard:build` 重建 `dashboard/dist`(构建产物不入库,经
  `bundle-node.sh` 拷入原生端),否则原生面板仍打包旧 bundle。

## 6. 平台实现要求

### 6.1 macOS
- 门控点:`TokenTrackerBarApp.swift` `applicationDidFinishLaunching` 现有 if 条件改写为
  `!silentStart && !launchedAtLogin` 才 `showDashboard()`。**该条件只管辖 manual/login 分支;
  deeplink 的弹显走既有 openUrls 处理路径,与本条件无关,勿动**——deeplink 调用 `showDashboard()`
  时仪表盘窗口懒创建自动生效,窗口不存在也能正确创建并显示(已核实)。
  `launchedAtLogin` 判定沿用现有 `'lgit` Apple 事件读取(位置必须在 didFinishLaunching 内,不得移动)。
- 存储:UserDefaults 读写。
- 菜单实现注:**菜单每次打开时整体重建是现状机制**(`showMenu()` → `buildMenu()` 全量重建,
  Launch at Login 亦如此)——点击 action **只写 UserDefaults**,勾选态在下次 `buildMenu()`
  构建期自然正确,**无需任何运行中刷新 / 通知 / menuNeedsUpdate 机制**;新增 `Strings` 本地化键
  (§5.2 文案表)。
- 禁改:popover、灵动岛、宠物、deeplink、reopen、更新检查路径。

### 6.2 Windows
- 存储:native-settings.json。`SettingsPath` 在各 helper 中是**各自声明的同值私有常量**
  (`NativeLocalization.cs:19-22`、`PetWindow.cs:902-904`),并非共享符号——新访问器采用同构做法:
  静态类 `SilentStart`(同值私有常量 + `Enabled` / `Set(bool)`)。读取损坏 / 缺失回落 false
  (与 `StoredVisible` 的 catch→null 模式一致)。
- 写入**读-改-写保留其他键**:读取文件失败时返回 false,不写入;仅在成功读取但 JSON 损坏或
  根节点不是对象时重建对象。有效 JSON 沿用 read-modify-write(读整体对象 → 改单键 → 写回)。写入发生在
  UI 线程(托盘处理器,与其他 helper 天然串行);temp + `File.Replace` 原子替换为推荐加固,非强制。
- 启动:`Program.Main` **读取一次** `SilentStart.Enabled` 得快照,计算 `silent_effective` 与
  `showPetOnLaunch` 传参(§4.3);仪表盘路径零改动(冷启动带深链参数时照常必弹,§4.2 注记)。
- 托盘:新增复选项,插入 `_startupItem` 之后(交互机制与 `_startupItem` 完全一致——`Click`
  处理器 + 手动 `Checked` 管理,非 `CheckOnClick`),**接入 `ApplyLocaleToMenu`**,文案
  `Silent Start`;处理器:`Set(v)` → 立即置 `_silentItem.Checked = v`(`Set` 本身不碰 UI)。
  不做 tooltip(§5.2)。
- 二次启动:复用 `SingleInstance` 管道协议(单行文本),激活消息为
  **`SingleInstance.ActivateMessage`(线格式字面量恰为 `activate`)**。
  `SingleInstance.StartListener` 先判断 `line == ActivateMessage` 并调用 `onActivate`,
  其余非空 payload 调用 `onDeepLink`。`Program.Main` 提供的两个回调经 WPF Dispatcher
  分别调度 `trayContext.ActivateDashboard()` 与 `trayContext.HandleDeepLink(payload)`。
  二次实例侧:`Program.Main` 单实例分支中,**非 `--startup` 且无深链 → 发送 `ActivateMessage`**;
  失败语义与既有深链转发一致(fire-and-forget,失败即无 surface,二次实例照常退出);
  激活与深链最终只显示同一个仪表盘;**携带 `--startup` 的二次实例不发激活消息**(§4.4-3)。

### 6.3 Linux
- 新模块 `settings.rs`:在 `lib.rs` 增加 `pub mod settings;`(与 paths/server 并列)。
  `XDG_CONFIG_HOME` → `$HOME/.config` 解析;**只复制 server.rs 的写侧卫生**(0700 `DirBuilder::mode`
  + 0600 `OpenOptions::mode` + `serde_json`);读侧的记录防伪加固(O_NOFOLLOW、uid 校验、mode 检查、
  多目录候选)系记录伪造防御,设置文件不需要,不复制。文件形状固定为单键对象
  `{"silent_start": bool}`(新文件,今日无其他写入方;读取容忍未知键)。路径解析写成纯函数
  `settings_path(xdg_config_home: Option<&str>, home: Option<&str>)`(XDG_CONFIG_HOME 有效
  即解析,HOME 仅 `~/.config` fallback 臂必需;两者均无效 → None → 默认 false;v1.3 修正,
  CodeRabbit PR #901——原实现先取 HOME,XDG+无 HOME 的裁剪环境误回退 false 且无法保存);
  单元测试写在模块内 `#[cfg(test)]`,
  用 `tests/paths.rs` 同款手写 TempDir 模式,**禁用 `set_var`**(测试线程竞态)。
  公开 `silent_start()` 与 `set_silent_start(bool)`;任何 IO 错误回落默认 false。
- 窗口:`main.rs` setup 中 `WebviewWindowBuilder` 追加 `.visible(!silent_start)`(API 已核实:
  tauri 2.11 `WebviewWindowBuilder::visible(bool)`);创建时机、加载导航、`start_dashboard` worker
  线程全部不变(隐藏时照常加载,首次 show 即热)。
- **deeplink 无需改动**(R1 勘误):`oauth::deliver_pending_callback` 成功路径自带
  `window.show()+set_focus()`,失败路径 park 后单实例循环回退 `show_main_window`——铁律 2 现状即满足。
- 托盘:`tray.rs` 菜单加入 `CheckMenuItem::with_id(manager, "silent-start", "Silent Start", true,
  初始checked, None::<&str>)`(比 `MenuItem::with_id` 多 `checked` 参数;初始值 = `settings::silent_start()`,
  **由 tray.rs 自行读取,`install` 签名不变**);`on_menu_event` 闭包中持久化并经**克隆的 item 句柄**
  `set_checked` 刷新(AppIndicator/DBusMenu 传播略有延迟)。菜单文案为英文字面量(与既有
  Open Dashboard/Quit 一致,Linux 托盘无本地化基建),"下次启动生效"提示不入菜单、写入 docs。
- 隐藏加载兜底(记录,非本期):若未来"显示即就绪"体验不佳,可加"超时强制显示"兜底定时器,
  列入 P2 评审,本期不做。
- 约束:`capabilities/*.json` 不变(P0 无新增 Tauri command,不触 `build.rs` manifest);
  `src-tauri/tests/capabilities.rs` 必须继续通过。

### 6.4 触碰文件边界(hygiene)

每个端只允许修改本节列出的文件及直接配套(测试/本地化表),PR diff 中**不得出现其他文件**:
- macOS:`TokenTrackerBarApp.swift`、`StatusBarController.swift`、`Strings.swift`(本地化表)。
- Windows:`Program.cs`、`TrayApplicationContext.cs`、`SingleInstance.cs`、新 `SilentStart.cs`
  (或并入现有 helper 文件,二选一)、`TrayStrings`/本地化表。
- Linux:`lib.rs`(一行 mod)、新 `settings.rs`、`main.rs`、`tray.rs`、settings 单测。
- 设置页开关阶段(v1.1)追加:dashboard 侧 `src/components/settings/MenuBarSection.jsx`
  及其测试 `MenuBarSection.test.jsx`、`src/content/copy.csv`、5 locale
  `src/content/i18n/{zh,zh-TW,ja,ko,de}/core.json`;macOS 另含 `NativeBridge.swift`;
  Windows 不新增(`TrayApplicationContext.cs` 已在列);`dashboard/dist` 为构建产物不入库。
- 仓库级:`package.json` 版本 bump(发布时,经 `npm version`,勿手改)。

## 7. 边界与错误处理

- 存储 IO 失败 / JSON 损坏:三端一致回落默认 false;写入失败不崩溃(stderr/日志记录即可)。
  Windows native-settings.json 为多 helper 共享文件,写入必须读-改-写保留他键(§6.2),
  单键损坏的爆炸半径以此约束在"本键"。
- Linux 冷启动 + 静默开 + 服务器启动失败:`report_startup_failure` 仅 eval 进隐藏窗口,用户无可见面
  ——**接受为已知边界**(代码注释注明);可选改进"启动失败时弹窗"留待 P2 评审。
- Linux GNOME 未装 AppIndicator 扩展 + 静默开:无可见入口 → 文档注明,不在本期解决(P3 热键兜底)。
- Windows 任务栏角溢出:Win11 新应用图标默认在可见角,无需代码处理;图标可见性设置可能被系统
  清理(对未运行应用),由一次性提示 + 文档兜底(P2)。
- Wayland hide→show:与既有 close-to-tray 同路径,无新增风险;列入手测项。WebKitGTK 可能延后
  绘制至映射,L2 的"显示即就绪"保持为人工验收项。
- 新旧版本混跑(更新期间):Windows 旧主实例收到未知管道消息 → 忽略(已核实天然安全)。
- **多用户 / 多会话(Windows 快速用户切换、runas、Linux/macOS 多会话)不在本期范围**,
  互斥体与端口冲突属既有行为,本开关不改变。

## 8. 验收标准

**QA 前置(重置、构建、deeplink 测试命令)**
- 重置开关:macOS `defaults delete com.tokentracker.bar LaunchSilently`(bundle-id 已核实
  `project.yml:34`);Windows 删除 `%LOCALAPPDATA%\TokenTracker\native-settings.json` 中的键或整个
  文件(注意会连带重置语言/宠物);Linux 删除 `~/.config/tokentracker/settings.json`。
- deeplink 触发:macOS `open 'tokentracker://auth/callback?insforge_code=test'`;Windows
  `start tokentracker://auth/callback?insforge_code=test`(cmd/运行);Linux `xdg-open '...'`。
- macOS reopen 模拟:启动 → 关闭仪表盘 → 点击 Dock 图标(无 Dock 图标的 agent 应用经
  `open -a TokenTracker` 触发 reopen)。
- Linux 二次启动模拟(L5):再次运行同一可执行文件(如 `./tokentracker-linux &`),单实例机制
  应转发并弹窗。
- 构建命令:macOS `xcodebuild -scheme TokenTrackerBar -configuration Release build`;
  Windows `dotnet build TokenTrackerWin/TokenTrackerWin.csproj`(非 Windows 需
  `-p:EnableWindowsTargeting=true`);Linux `cargo test`(TokenTrackerLinux/src-tauri,需 GTK 环境)。

**macOS**
- M1 开关关(默认):manual 弹 / login 不弹 / deeplink 弹 / reopen 弹,与现状逐项一致。
  login 模拟:设置内开启 Launch at Login → 注销重登(唯一携带 `'lgit` 的路径)。
- M2 开关开:manual 不弹、login 不弹;deeplink、reopen、菜单 Open Dashboard 照常弹。
- M3 菜单勾选态跨启动保持、实时反映存储;切换持久化;**运行中切换不改变当前窗口可见性**;
  en/zh-Hans 文案与 §5.2 表一致;菜单位置紧随 Launch at Login(§5.1)。
- M4 popover / 灵动岛 / 宠物 / 更新检查行为不受开关影响。
- M5 Release 构建通过(见前置命令)。

**Windows**
- W1 开关关:manual 行为与现状一致(仪表盘 manual 弹 / login 不弹,#832 后基线,同 §4.2
  矩阵);`--startup` 时宠物被压制(**宠物优先级修复**,即使 `PetVisible=true`);deeplink 弹。
  login 模拟:直接运行 `TokenTracker.exe --startup`。
- W2 开关开:manual 与 `--startup` 均不弹宠物、不弹仪表盘;deeplink(auth)弹(含冷启动带参);
  **无深链二次启动弹(既有 activate 转发)**;`--startup` 二次启动不弹;`--startup`+深链的二次启动
  弹(深链规则);托盘点击弹。
- W3 开关持久化于 native-settings.json(读-改-写保留其他键,切语言/宠物键不丢;JSON 损坏时
  以新对象重建落盘,开关不再被损坏文件锁死;读取失败时返回 false 且文件内容不变);托盘勾选态
  跨启动保持;**运行中切换不改变当前可见性**;en/zh-Hans 文案与 §5.2 表一致
  (`ApplyLocaleToMenu`);菜单位置紧随 `_startupItem`(§5.1)。
- W4 新二次实例 → 旧主实例:搭建方法 = 以旧版本 exe 为主实例运行,新版本 exe 无深链二次启动;
  #832 起已支持 `activate` 的主实例应激活仪表盘;更早且未识别此消息的主实例将其交给
  深链处理器后忽略,不得崩溃。按旧版本实际协议能力分别验收。
- W5 构建通过,现有测试不回归。

**Linux**
- L1 开关关:启动可见,行为与现状逐项一致。
- L2 开关开:窗口隐藏创建、仪表盘后台加载;托盘 Open Dashboard → 显示且内容就绪(人工验收,
  含 Wayland 手测)。
- L3 settings.json 读写正确(0700/0600);缺失 / 损坏回落 false;托盘切换即持久化并刷新勾选;
  **运行中切换不改变当前窗口可见性**;菜单位置在 Open Dashboard 与 Quit 之间(§5.1)。
- L4 auth 深链在窗口隐藏时到达 → 窗口弹显并完成回调(验证现状路径在 `.visible(false)` 下仍成立)。
- L5 二次启动(单实例,模拟命令见前置)→ 弹窗(现状保持)。
- L6 `capabilities` 测试不回归;settings 模块单元测试通过(`cargo test`,注入式路径,无 `set_var`)。

**通用**
- G1 后台零影响的具体可观测断言:开关两种状态下,本地服务器对回环端口请求正常响应、`sync`
  正常写入 `~/.tokentracker/queue.jsonl`、菜单栏/托盘刷新数据照常更新。
- G2 版本号 bump(经 `npm version` 同步全部九个版本文件,勿手改、勿推本地 tag)+ 三平台
  release 工作流照常(CLAUDE.md)。

## 9. 发布注意

- 三端均为桌面 app 改动 → `npm version` bump 并走 `release (macOS + Windows + Linux)` 工作流。
- Release notes:单行英文,如 `Add Silent Start toggle to launch straight to the menu bar / tray`。

---

## 修订记录(完整,定稿随文件入库)

- v1.6(2026-10-29,PR #901 最新评审核实):§2/§4.4 允许 Windows 仪表盘懒创建;
  §4.4/§6.2/W2/W4 对齐既有 `activate` 消息及独立激活/深链回调;
  §6.2/W3 区分文件读取失败与 JSON 损坏,前者不写回、后者可重建。
- v1.5(2026-10-28,CodeRabbit PR #901 第二轮行内评审吸收):① §4.2 冷启动注记二次勘误——
  v1.4 ② 的「StoredVisible=true 时仍恢复显示」未区分 `silent_effective`,在开关开
  (或 `--startup`)语境下与 §4.3 `!silent_effective &&` 外乘门控矛盾;改为深链仅豁免
  仪表盘门控,宠物任何情况按 §4.3。② W1 验收标准同步 #832 基线:manual 弹 / login 不弹
  (原「仪表盘从不自动弹(manual/login)」为 0.95.0 时代残留,与 §4.2 矩阵矛盾)。
  ③ Windows `SilentStart.Set` 对损坏 JSON 以新对象重建(原仅只读回退 false,损坏文件
  会把开关写路径锁死),W3 同步。
- v1.4(2026-10-28,CodeRabbit PR #901 第二轮行外评审):① §4.2 manual 行与 §4.5 的
  Windows 基线勘误——#832(ActivateMessage 重构)之后 main 的实际行为是「manual 弹 /
  login 不弹」,原文「仪表盘从不自动弹」是 0.95.0 时代基线,已陈旧;**代码不动**(关闭时
  逐字保持 #832 后现状,`test/windows-launch-activation.test.js` 钉死该形状),只修文档。
  驳回 bot「删除 manual 启动的 ActivateDashboard」的建议——那会改变 main 现状行为。
  ② §4.2 冷启动注记措辞勘误:宠物在 `StoredVisible=true` 时按 §4.3 公式恢复,原「已被
  压制」与 §4.3 公式矛盾。③ 驳回「冷启动 deeplink 压制宠物」建议,理由同上。
  ④ 搁置「Release App Group provision」建议:entitlements 无 `application-groups` 为
  存量设计(生产走 widget 容器 fallback),改动牵扯签名验证,留独立 follow-up。
- v1.3(2026-10-28,CodeRabbit PR #901 行内评审):① §6-3 `settings_path` 语义修正——
  XDG_CONFIG_HOME 单独有效即解析,HOME 仅 `~/.config` fallback 臂必需(原实现先取
  HOME,XDG+无 HOME 的裁剪环境误回退 false 且无法保存;补 `settings_path_resolves_xdg_
  config_home_without_home` 单测);② Windows 托盘勾选态同步——面板 `setSetting("launch
  Silently")` 路径补 `_silentItem.Checked = silent`(托盘菜单为常驻 WinForms 对象,不会随
  打开重建,失步会导致下次点击反向写回)。
- v1.2(2026-10-28):移除 macOS 菜单项 tooltip「下次启动生效」(owner 决定;§5.2 同步——
  三端菜单均不承载该提示,语义保留在 §3 生效时机、面板 `silentStartHint` 与本文档)。
- v1.1(设置页开关双审吸收,2026-10-28):① QA mock 补 `launchSilentlySupported: false`
  隐藏新行(QA setSetting 白名单不含新键,防可点击死开关在 QA 下 fatalError);
  ② 面板新行位置钉死:launchAtLoginSupported 条件块之外(Windows 推该键为 false);
  ③ 新增 §5.3;§2 P2 遗留项标注部分落地;§5 标题同步;§6.4 补面板阶段触碰文件;
  ④ 提示语取三端中性措辞(菜单栏/托盘,含桌宠);⑤ macOS applySetting 不发
  `.nativeSettingsChanged`(launchAtLogin 先例)、菜单 toggle 补 `pushSettings()`;
  ⑥ Windows 托盘 toggle 补 `PushDashboardNativeSettings()`;⑦ web 改动后显式重建
  `dashboard/dist` 列入流程;⑧ 范围外记录:Dev 变体面板「检查更新」按钮无效为分支既有问题,
  修复需 payload 新 flag,受 §6.1 禁改更新路径约束,留后续跟进。
- v0.5(R4 双审吸收):① macOS 菜单机制勘误——不存在"重建路径",现状是每次打开整体重建
  (`showMenu()`→`buildMenu()`),action 只写 UserDefaults 即可,删除"禁止 notification/
  menuNeedsUpdate"的错误禁令;② Windows 提示载体砍掉(ToolTipText 需 `ShowItemToolTips` 且
  自定义 renderer 不渲染),提示仅 macOS tooltip + docs;③ `show` 分支位置钉死:Program.cs 以
  lambda 包装监听回调,分支在 `HandleDeepLink` 之前;④ Strings 五语种策略(zh-Hant/ja/ko 用英文);
  ⑤ macOS deeplink 懒创建兼容性写明(已核实);⑥ W2 补 `--startup`+深链组合验收项;
  ⑦ M3/W3/L3 补"运行中切换不改当前可见性";⑧ M3/L3 补菜单位置检查;⑨ §8 补 deeplink 触发、
  reopen 模拟、Linux 二次启动命令与 bundle-id(`com.tokentracker.bar`);⑩ §9/G2 补
  `npm version` 九文件同步与禁推本地 tag;⑪ §2 非目标补 StartupApproved 再同步(P2);
  ⑫ 落盘路径改为被跟踪的 `docs/`(`docs/plans/` 被 .gitignore 忽略)。
- v0.4(R3 双审吸收):① 铁律 5 重新表述——Windows/Linux"创建但隐藏",macOS 懒创建等价合法;
  ② §1/§4.5 标注唯一关态例外=宠物修复;③ "可见性永不持久化"限定为"本开关不新增";④ resummon
  定义补 `--startup` 排除;⑤ `--startup`+深链组合优先级写明;⑥ §5.2 文案表与三端载体;
  ⑦ macOS 菜单状态构建期计算(后经 R4 修正表述);⑧ Windows 复选交互/读写时序/show 分支/
  启动快照单次读取钉死;⑨ settings.rs 模块声明、单测位置、文件形状、托盘 id 与读取归属;
  ⑩ §6.4 触碰文件边界;⑪ §8 补 QA 重置与构建命令。
- v0.3(R2 双审吸收,16 项):① [P0] Windows 宠物门控改在表达式外相乘(原折入
  `showPetOnLaunch` 会被 `PetVisible=true` 的 `??` 短路复活漏洞),改为双参数传参;② §4.5 Windows
  行与 deeplink 矛盾修正;③ `show` 管道消息失败语义=与深链转发一致 fire-and-forget、幂等;
  ④ `--startup` 二次实例不发 show;⑤ 冷启动带深链绕过静默门控显式化;⑥ 快照语义+生效时机
  三端统一;⑦ 共享 JSON 写入串行(UI 线程)+原子替换推荐;⑧ 多用户/多会话 out-of-scope;
  ⑨ 文案统一 Silent Start;⑩ M1/M2 补 login 模拟方法;⑪ `'lgit` 对齐列入非目标(P1);
  ⑫ 窗口销毁禁令升格铁律;⑬ 隐藏加载兜底定时器记录为 P2;⑭ copy.csv 规则仅约束 dashboard +
  隐私行;⑮ G1 改为可观测断言、W4 补搭建方法;⑯ 删除"顺势提取共享常量"选项。
- v0.2(R1 双审吸收,10 项):① Linux auth 回调勘误——`deliver_pending_callback` 成功路径自带
  show+focus,现状已弹窗,删除多余的"deeplink 可见性修复";② Windows 菜单项必须接入
  `ApplyLocaleToMenu`、macOS 需本地化键;③ `silent_effective` 门控机制需明确;④ `SettingsPath`
  为各 helper 私有同值常量、非共享符号;⑤ 写入须读-改-写保留其他键(WriteSettings 空重建缺陷注记);
  ⑥ macOS 菜单状态于 buildMenu 构建期计算;⑦ settings.rs 只复制写侧卫生+纯函数注入+禁 set_var;
  ⑧ 记录 `app_config_dir()` 否决理由;⑨ 冷启动失败隐藏无可见面记为已知边界;⑩ CheckMenuItem
  签名(多 checked 参数)与克隆句柄 set_checked 注记。
- v0.1:初稿(基于 2026-09-04 两轮技术调研与 clash-verge-rev / cc-switch 对照方案)。
