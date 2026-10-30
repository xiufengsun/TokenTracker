# Plan:Silent Start P0 实现(执行者:GLM-5.3-Flash-Max)

版本:v1.0 · 2026-09-04 · 5 轮双审通过(R5 双 SHIP)· P0 已实现,待发布 · 依据:`docs/silent-start-toggle-spec.md`(v1.0 定稿)
评审史:R1 追溯/锚点、R2 Linux/模拟、R3 对抗/风险、R4 冷读/命令审计已吸收
执行约束(先读,违反任何一条即停):
1. **只改 §6.4 触碰文件清单内的文件**;发现需要改清单外文件才能完成 → STOP,报告阻塞。
   唯一例外(文档性更新,任务 5):`docs/silent-start-toggle-spec.md`、`docs/silent-start-toggle-plan.md`、
   `docs/silent-startup.md`。
2. **任何锚点(文件:行、函数名、签名)与真实代码不符 → STOP,报告差异**,不得凭想象改写锚点外逻辑。
3. 不 git commit、不 bump 版本、不改 CI/工作流(发布是后续人工步骤,spec §9)。
4. 每个任务完成后立即运行该任务的"完成判据",不通过不进入下一任务。
5. 代码注释风格与所在文件一致;新增注释仅写"代码本身表达不了的约束"(如 spec §7 已知边界)。

## 任务 0:预读(不改动)

按顺序读:spec 全文 → `TokenTrackerBar/TokenTrackerBar/TokenTrackerBarApp.swift`(123-168)、
`TokenTrackerBar/TokenTrackerBar/Services/StatusBarController.swift`(buildMenu 区、Launch at Login 项区、
toggleLaunchAtLogin 区)、`TokenTrackerBar/TokenTrackerBar/Utilities/Strings.swift`(R2 勘误:
实际在 Utilities/ 而非 Services/;menuLaunchAtLogin 键与 `t()` API)→ `TokenTrackerWin/Program.cs`、`TrayApplicationContext.cs`(ctor、pet 分支 :242、
_trayItem/_startupItem 创建区、ApplyLocaleToMenu、OpenDashboard、OnToggleStartup)、
`SingleInstance.cs`、`PetWindow.cs`(902-925 StoredVisible、WriteSettings 约 :1241-1258)、`NativeLocalization.cs`(19-22)→
`TokenTrackerLinux/src-tauri/src/{main.rs,tray.rs,server.rs(113-125,255,279-286),oauth.rs,lib.rs}`、
`tests/paths.rs`、`capabilities/*.json`。
产出:对照 §6 各锚点,列出任何不符项(应无)。

## 任务 1:macOS

### 1.1 Strings.swift — 新增本地化键(实际路径:`TokenTrackerBar/TokenTrackerBar/Utilities/Strings.swift`)
镜像 `menuLaunchAtLogin` 的写法新增两个键:
- `menuSilentStart`:en `Silent Start` / zh-Hans `静默启动` / zh-Hant `Silent Start` / ja `Silent Start` / ko `Silent Start`
- `menuSilentStartTooltip`:en `Takes effect on next launch` / zh-Hans `下次启动生效` / 其余三语种同 en
(`t()` 的确切参数形态以文件内既有键为准。)

### 1.2 StatusBarController.swift — 常量 + 菜单项 + 动作
- 新增 `static let launchSilentlyKey = "LaunchSilently"`(放在既有 UserDefaults 键常量旁,如
  `hideMenuBarIconKey` 附近)。
- `buildMenu()` 中,**紧随 "Launch at Login" 菜单项之后**插入:
  `state` = `UserDefaults.standard.bool(forKey: Self.launchSilentlyKey) ? .on : .off`;
  `title` = `Strings.menuSilentStart`;`action` = `#selector(toggleSilentStart)`;`target` = self;
  `toolTip` = `Strings.menuSilentStartTooltip`。不加分隔线。镜像 login 项的构造方式(逐属性对齐)。
- 新增:
  ```swift
  @objc func toggleSilentStart() {
      let defaults = UserDefaults.standard
      defaults.set(!defaults.bool(forKey: Self.launchSilentlyKey),
                   forKey: Self.launchSilentlyKey)
      // 菜单每次打开整体重建(buildMenu),勾选态下次打开自然正确;无需就地刷新(spec §6.1)
  }
  ```
  (`@objc`/`private` 修饰与 `toggleLaunchAtLogin` 一致。)
完成判据:`xcodebuild -scheme TokenTrackerBar -configuration Debug build` 通过;`git diff --stat`
只含 `TokenTrackerBarApp.swift`、`StatusBarController.swift`、`Strings.swift`。
构建前置(R2 勘误):仓库内无 `.xcodeproj`(XcodeGen 工程)——若本地不存在,先
`(cd TokenTrackerBar && xcodegen generate && ruby scripts/patch-pbxproj-icon.rb)`(CLAUDE.md 惯例;
生成物不入库,不构成 diff)。
已核验锚点(R1):`Strings.t(_ zhCN:zhTW:ja:ko:)` 参数序为 en/zh-Hans/zh-Hant/ja/ko(Strings.swift:9),
`menuLaunchAtLogin` 在 :243;`StatusBarController` 是 `@MainActor final class … : NSObject`,
`@objc private func` 是既有风格;login 项在 :1210-1213(state :1212,addItem :1213,其后是 toastItem),
插入点无索引假设(更新项按 tag 4242 定位);`static let hideMenuBarIconKey`(:174)是同层常量先例。

### 1.3 TokenTrackerBarApp.swift — 启动门控
把(约 :149-154)
```swift
if NSAppleEventManager.shared().currentAppleEvent?
    .attributeDescriptor(forKeyword: keyAELaunchedAsLogInItem) == nil {
    DashboardPresentationCoordinator.shared.showDashboard()
}
```
改写为:
```swift
let launchedAtLogin = NSAppleEventManager.shared().currentAppleEvent?
    .attributeDescriptor(forKeyword: keyAELaunchedAsLogInItem) != nil
let silentStart = UserDefaults.standard.bool(forKey: StatusBarController.launchSilentlyKey)
if !silentStart && !launchedAtLogin {
    DashboardPresentationCoordinator.shared.showDashboard()
}
```
保留该处原注释语义(补一句:登录项启动保持安静,静默开关开启时任何启动都不弹,spec §4)。
不改 `'lgit` 读取位置;不改 deeplink(:232-251)、reopen(:114-121)、宠物/灵动岛恢复(:136,139)。
完成判据:构建通过;`grep -n "showDashboard" TokenTrackerBar/TokenTrackerBar/TokenTrackerBarApp.swift`
确认 deeplink/reopen 处的 showDashboard 调用未被触碰。
**构建前置(R2/R4 勘误)**:仓库内无 `.xcodeproj`(XcodeGen 工程,gitignored)——构建前先
`(cd TokenTrackerBar && xcodegen generate && ruby scripts/patch-pbxproj-icon.rb)`,且 xcodebuild
必须在该目录内运行:`(cd TokenTrackerBar && xcodebuild -scheme TokenTrackerBar -configuration Debug build)`。
**运行时冒烟(R3 增补,macOS 本地可跑)**:启动构建出的 app → 仪表盘出现;
`defaults write com.tokentracker.bar LaunchSilently -bool YES` → 重启 app → 不弹;
`defaults delete com.tokentracker.bar LaunchSilently` → 重启 app → 恢复弹出。
(门控布尔写反等错误编译期不可见,此冒烟是唯一本地守门。)

## 任务 2:Windows

### 2.1 新建 SilentStart.cs(静态类;SDK 风格 csproj 自动包含,若 csproj 显式列文件则补 ItemGroup)
镜像 `PetWindow` 的 JSON 读写(JsonObject API)与 `NativeLocalization.SettingsPath` 的同值私有常量:
**文件头需要 `using System.Text.Json;` + `using System.Text.Json.Nodes;`(JsonObject 在 Nodes 命名空间);
namespace 与其他文件一致(`namespace TokenTrackerWin;`)。**
```csharp
internal static class SilentStart
{
    // 与 NativeLocalization.cs:19-22 / PetWindow.cs:902-904 同值(各 helper 私有同值常量是既有惯例)
    // 注意:值是运行时构造(Path.Combine + Environment.GetFolderPath),必须 static readonly,不能 const(R4)
    private static readonly string SettingsPath = /* 逐字复制 NativeLocalization.SettingsPath 的构造 */;
    private const string Key = "StartSilently";

    public static bool Enabled
    {
        get { try { var root = ReadRoot(); return root?[Key]?.GetValue<bool>() ?? false; }
               catch { return false; } }   // 损坏/缺失 → false(spec §3)
    }

    public static void Set(bool value)
    {
        try { var root = ReadRoot() ?? new JsonObject(); root[Key] = value; WriteRoot(root); }
        catch { /* 与既有 helper 相同的静默/日志策略 */ }
    }

    private static JsonObject? ReadRoot()  { /* 镜像 StoredVisible 的读取:文件不存在/解析失败 → null */ }
    private static void WriteRoot(JsonObject root) { /* 镜像 WriteSettings 的写盘方式 */ }
}
```
**必须先读 `PetWindow.cs:902-925` 与 `WriteSettings`(约 :1241-1258)再落笔**——API 形态
已核验(R1):System.Text.Json 的 `JsonObject` / `JsonNode.Parse(...)?.AsObject()` +
`GetValue<bool>()`;写盘 = `Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!)` +
`File.WriteAllText(SettingsPath, settings.ToJsonString())`;`SettingsPath` 是
`private static readonly`,两处同值。`Set` 的读-改-写保留未知键(spec §6.2)。

### 2.2 Program.cs — 快照 + 传参 + 二次启动 show
- 在 `launchedAtStartup` 计算后(:15-18 附近)新增:
  ```csharp
  var silentEffective = SilentStart.Enabled || launchedAtStartup;
  ```
- `showPetOnLaunch` 保持 `deepLink is null && !launchedAtStartup` 不变(:77)。
- `new TrayApplicationContext(showPetOnLaunch)`(:78)改为
  `new TrayApplicationContext(showPetOnLaunch, silentEffective)`。
  **本地无运行时检查(R3 记录)**:macOS 上 `dotnet build` 仅编译,exe 不可运行——W1 是
  silentEffective 正确性的唯一守门,执行者不得即兴自测,如实标注"待 CI/用户手测"。
- 单实例分支(:20-32)改为:
  ```csharp
  if (deepLink is not null) { SingleInstance.TryForwardToPrimary(deepLink); }
  else if (!launchedAtStartup) { SingleInstance.TryForwardToPrimary("show"); }
  return;
  ```
  (即 `--startup` 二次实例不发 show;fire-and-forget 语义与深链转发完全一致。
  保留既有 `Diag.Log(... forwarded ...)` 日志行(:29)与注释,仅把转发的载荷换成对应值。)

### 2.3 TrayApplicationContext.cs — ctor 参数 + 宠物门控 + 托盘项
- 新增字段 `private readonly ToolStripMenuItem _silentItem;`(与 `_startupItem` 同层显式声明)。
- ctor 现签名 `public TrayApplicationContext(bool showPetOnLaunch = false)`(:90,唯一调用方
  Program.cs:78)→ 增加 `bool silentEffective` 参数(新增字段保存)。
- 宠物分支(:242 附近)由 `if (PetWindow.StoredVisible ?? showPetOnLaunch)` 改为
  `if (!silentEffective && (PetWindow.StoredVisible ?? showPetOnLaunch))`。
- 托盘项:**紧随 `_startupItem` 创建之后**(模式已核验:`_startupItem = CreateMenuItem("", OnToggleStartup);`
  :160-162,`CreateMenuItem(string, EventHandler)` :256,`_menu.Items.Add(_startupItem)` :186),
  创建 `_silentItem = CreateMenuItem("", OnToggleSilentStart);` 并镜像 `_startupItem.CheckOnClick = false;`
  一行,`_menu.Items.Add(_silentItem)` 紧随 :186 之后;初始 `Checked = SilentStart.Enabled`;
  **在 `ApplyLocaleToMenu` 中加对应行**(既有镜像行:`_startupItem.Text = _strings.LaunchAtLogin;`
  :346,`_strings` 于 :305 经 `TrayStrings.For(...)` 赋值)。
  **⚠ 本地化注意(R1)**:`TrayStrings` 是位置记录 `internal sealed record TrayStrings(...)`
  (TrayStrings.cs:3,`LaunchAtLogin` 在 :11,工厂 `For(locale)` :28)——新增文案键必须
  **同时给 `For()` 内每个语言构造调用补实参**,漏一个编译即失败。en `Silent Start` / zh-Hans `静默启动`。
- 新处理器(镜像 `OnToggleStartup`):
  ```csharp
  private void OnToggleSilentStart(object? sender, EventArgs e)
  {
      var value = !_silentItem.Checked;
      SilentStart.Set(value);
      _silentItem.Checked = value;
  }
  ```
- `OpenDashboard()` 现为 `private`(:414,= EnsureDashboard + ShowDashboard 组合)→ 改 `internal`
  **并改为自 marshal**(R3 发现 P0:`show` 消息从管道监听线程到达,非 UI 线程直接 new WPF
  DashboardWindow 会崩溃;既有 `HandleDeepLink` 就是经 `PostToUi`(TrayApplicationContext.cs:963-972,
  内含 CheckAccess 快路径)自行 marshal 的,:721)。改后形态(镜像 HandleDeepLink 的 marshal 写法,
  执行者先读 PostToUi 再落笔;若 PostToUi 无 HasShutdownStarted 守卫则按其现状,不自行加码):
  ```csharp
  internal void OpenDashboard() => PostToUi(() => { EnsureDashboard(); _dashboard!.ShowDashboard(); });
  ```
  (PostToUi 的 CheckAccess 快路径保证托盘菜单调用仍同步执行,行为不变;管道路径被正确 marshal。
  其余调用方不受影响。)
完成判据(2.2+2.3 合并):
`dotnet build TokenTrackerWin/TokenTrackerWin.csproj -p:EnableWindowsTargeting=true` 通过;
`git diff --stat` 只含 §6.4 Windows 清单内文件。

### 2.4 SingleInstance/Program — show 分支
`Program.cs:83` 的监听接线由 `payload => ctx.HandleDeepLink(payload)` 改为:
```csharp
payload =>
{
    if (payload == "show") { ctx.OpenDashboard(); }
    else { ctx.HandleDeepLink(payload); }
}
```
(`StartListener` 的循环体 `onPayload(line)` 不动;分支必须位于 HandleDeepLink 之前——W4 的
旧实例安全性依赖该顺序。已核验:`ctx` 定义于 :79,在接线点 :83 作用域内。
**线程注记(R3 P0)**:该 lambda 运行在管道线程;`OpenDashboard()` 经 2.3 的 PostToUi 改造后
自 marshal,此分支才是安全的——2.3 未完成前不得先做 2.4。)
`TryForwardToPrimary` 本体不改(单行文本协议天然兼容)。
完成判据:同 2.3 构建;`grep -n '"show"' TokenTrackerWin/SingleInstance.cs TokenTrackerWin/Program.cs`
确认字面量与分支位置正确。

## 任务 3:Linux

### 3.1 lib.rs — 一行
`pub mod settings;`(现序 oauth/paths/server/tray,**插在 server 与 tray 之间**保持字母序)。

### 3.2 新建 settings.rs
```rust
use std::fs;
use std::path::{Path, PathBuf};

const SETTINGS_DIR: &str = "tokentracker";
const SETTINGS_FILE: &str = "settings.json";

/// 纯函数,便于注入测试(禁用 set_var,spec §6.3);签名与 spec §6.3 一致(Option<&str>)。
fn settings_path(xdg_config_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let home = home?;
    let base = match xdg_config_home {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => Path::new(home).join(".config"),
    };
    Some(base.join(SETTINGS_DIR).join(SETTINGS_FILE))
}

fn path_from_env() -> Option<PathBuf> {
    settings_path(
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

/// 读静默开关;文件/键缺失或任何 IO、解析错误 → false(spec §3)。
pub fn silent_start() -> bool {
    let Some(path) = path_from_env() else { return false; };
    let Ok(bytes) = fs::read(&path) else { return false; };
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("silent_start").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

pub fn set_silent_start(value: bool) {
    let Some(path) = path_from_env() else { return; };
    if let Some(dir) = path.parent() {
        // 写侧卫生照抄 server.rs:目录 0700、文件 0600
        let _ = fs::create_dir_all(dir); // TODO(executor): 镜像 server.rs 的 DirBuilder mode(0700)
        let json = serde_json::json!({ "silent_start": value });
        // TODO(executor): 镜像 server.rs 的 OpenOptions mode(0600) + write
    }
}
```
执行者职责:把两处 TODO 替换为对 server.rs 写侧卫生的**逐行镜像**——**完整锚点是 :269-286**
(建目录+写文件循环;`DirBuilder::new().recursive(true).mode(0o700)` 在 :275-278,`OpenOptions`
mode 0o600 + `write_all` 在 :279-285);读侧防伪加固(:302-318,O_NOFOLLOW/uid/mode 检查)**不复制**。
注意 set_silent_start 是覆盖式单键对象(文件形状固定 `{"silent_start": bool}`,新文件无其他写入方)。
`#[cfg(test)] mod tests`(模块内,镜像 `tests/paths.rs` 的手写 TempDir,禁 `set_var`):
- `settings_path` 尊重 XDG_CONFIG_HOME / 回落 $HOME/.config;
- roundtrip:set 后 silent_start() == true;
- 缺失文件 / 损坏 JSON → false(向临时目录写 `not json`);
- **权限断言(L3)**:set 后用 `std::os::unix::fs::PermissionsExt` 断言目录 mode 0o700、
  文件 mode 0o600(`#[cfg(unix)]` 包裹)。
完成判据:`cargo test --manifest-path TokenTrackerLinux/src-tauri/Cargo.toml settings` 通过
(环境无 GTK 导致整体失败时,改跑 `cargo test --offline` 亦不可行则记录并依赖 CI,见任务 4);
`grep -n "TODO" TokenTrackerLinux/src-tauri/src/settings.rs` 必须为空。

### 3.3 main.rs — 可见性门控
setup() 内建窗前读取,Builder 追加一行(位置在 `.min_inner_size` 之后、`.build()` 之前):
```rust
let silent_start = tokentracker_linux::settings::silent_start();
```
```rust
.visible(!silent_start)
```
并在 `report_startup_failure` 或其调用处补一条注释(不改变行为):静默启动下该失败仅写进隐藏
窗口,用户无可见面——已知边界,spec §7。
完成判据:`main.rs` diff 只有常量读取 + 一行 `.visible(...)` + 注释。

### 3.4 tray.rs — CheckMenuItem
- 新增常量 `const SILENT_ID: &str = "silent-start";`(与既有 `OPEN_ID`/`QUIT_ID` 同层,:6-7),
  `with_id` 与 `on_menu_event` 的匹配臂统一使用它(与既有风格一致)。
- `use tauri::menu::CheckMenuItem;`
- `install()` 内读取 `let silent_start = crate::settings::silent_start();`,创建
  ```rust
  let silent_item = CheckMenuItem::with_id(app, SILENT_ID, "Silent Start", true,
                                           silent_start, None::<&str>)?;
  ```
  菜单顺序:`[open, silent_item, quit]`(`Menu::with_items(app, &[&open, &silent_item, &quit])`,
  混用具体类型可编译——元素协变为 `&dyn IsMenuItem`,既有 :29 行即先例)。
- **现有 `.on_menu_event(|app, event| …)` 非 `move` 闭包(R2 勘误)——改为 `move |app, event|`**
  以捕获 `silent_handle`(`let silent_handle = silent_item.clone();` 在闭包外克隆);
  `on_menu_event` 新增分支:
  ```rust
  "silent-start" => {
      let value = !crate::settings::silent_start();
      crate::settings::set_silent_start(value);
      let _ = silent_handle.set_checked(value);
  }
  ```
  (以存储值取反,规避 AppIndicator 自动勾选时序的歧义;`set_checked` 重申目标态。)
完成判据:`tray.rs` 的既有测试仍通过;diff 只含 tray.rs。
**capabilities 约束**:全程不新增 Tauri command、不改 capabilities/*.json——
`cargo test --test capabilities` 必须保持通过(可本地跑则跑,否则 CI)。

## 任务 4:文档更新(§5.2/§6.3/§7 的 docs 承诺)

1. `docs/silent-startup.md` 末尾新增 "Silent Start toggle(P0)" 小节:三端开关位置与行为摘要;
   Windows/Linux 不承载"下次启动生效"提示的原因(§5.2);Linux GNOME 未装 AppIndicator 扩展 +
   静默开 = 无可见入口的边界说明(§7)。
2. `docs/silent-start-toggle-plan.md`(本 plan 的仓库定稿,由本工作流在执行前落盘)与
   `docs/silent-start-toggle-spec.md` 的"实现状态"各补一行(P0 已实现,待发布)。
完成判据:三个 md 文件 diff 均为纯文档增补,无代码文件变动。

## 任务 5:整体验证与报告

1. 触碰文件核对:`git status --short` 必须恰好等于 §6.4 清单 + 任务 4 的三个 md 文档,
   出现其他文件 → 回滚该改动。
2. `npm test`(Node 侧应零失败——本改动不触 src/dashboard,跑一次作回归证据)。
3. macOS:`(cd TokenTrackerBar && xcodebuild -scheme TokenTrackerBar -configuration Debug build)`
   通过后,再跑 Release(M5 用);Windows:
   `dotnet build TokenTrackerWin/TokenTrackerWin.csproj -p:EnableWindowsTargeting=true`(W5;
   首次构建会隐式 NuGet restore 下载 Windows targeting packs,需网络、首次较慢——预期行为非缺陷);
   Linux:`cargo test --manifest-path TokenTrackerLinux/src-tauri/Cargo.toml settings`(L6 专项)。
   **预期校准(R2)**:在 macOS 开发机上 `cargo test` 应可直接
   通过(gtk-sys 是 Linux 目标门控依赖,macOS 不会被拉起);"GTK 缺失"回退仅适用于
   无 GTK 开发包的 Linux 主机,出现时如实记录并标注"CI 验证"。
4. 汇报模板:逐任务状态 / 构建与测试输出摘要 / 无法本地验证的验收项清单
   (M1-M4 手测、W1-W4 手测、L1/L2/L4/L5 手测、L3 的托盘持久化、运行中切换语义与
   菜单位置、G1/G2)留给用户与 CI。

## 风险与回退
- 任一构建任务失败且 30 分钟内无法定位 → 回滚该端改动(保留已完成端),如实汇报。
- 禁止为通过构建而放宽编译警告、删除测试或修改无关文件。
