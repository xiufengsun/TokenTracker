# Silent startup (launch to background without showing the panel)

> **Implementation status (2026-09-04):** the Silent Start toggle (P0) is implemented on all
> three desktop clients — macOS menu item `Silent Start`, Windows tray item `Silent Start`
> (next to Launch at Login), Linux tray `CheckMenuItem`. Persisted per platform
> (`LaunchSilently` / `StartSilently` / `silent_start`), default OFF; takes effect on next
> launch. See `docs/silent-start-toggle-spec.md` for the behavior contract.
> Note: the "takes effect on next launch" hint ships as a macOS tooltip only; Windows and
> Linux tray menus have no reliable tooltip carrier, so this documentation is the carrier.
> GNOME without the AppIndicator extension shows no tray icon at all — with Silent Start
> enabled on such a desktop the app has no visible entry point (global hotkey is the
> planned P3 mitigation).

Research for a "silent startup" feature: when the desktop app is launched — especially auto-launched
at login — it should run in the background (menu bar / system tray only) and **not** show its main
panel. Covers all three desktop clients: macOS (`TokenTrackerBar/`), Windows (`TokenTrackerWin/`),
Linux (`TokenTrackerLinux/`, Tauri v2).

Research date: 2026-09-04. Findings verified against Apple/Microsoft/Tauri primary docs and the
plugins' source; current code paths verified by direct reads. File:line references are against the
tree at the time of writing.

## TL;DR

1. **All three platforms already have part of the plumbing** — the feature is smaller than it looks:
   - **macOS**: login-item launches *already* stay quiet (Apple-event `lgit` check at
     `TokenTrackerBar/TokenTrackerBarApp.swift:149-154`); only manual launches auto-open the
     dashboard window. Missing: a user-facing preference (today it is hard-coded).
   - **Windows**: the autostart Run key *already* passes `--startup`
     (`TokenTrackerWin/LaunchAtStartup.cs:59-65`) and `Program.cs:73-78` already stays tray-only for
     it — **except the desktop pet**, which overrides silence via `PetWindow.StoredVisible`
     (`TrayApplicationContext.cs:242`). The dashboard window never auto-opens.
   - **Linux**: nothing exists yet — the main window is always visible
     (`TokenTrackerLinux/src-tauri/src/main.rs:274-283` builds it without `.visible(false)`), there
     is no autostart plugin, and there are no launch args beyond OAuth callbacks.
2. **You cannot pass a `--silent` flag through macOS `SMAppService.mainApp`** (register() takes no
   arguments), so a per-launch flag only works on Windows (Run key args) and Linux
   (`.desktop` `Exec` args). On macOS the preference must be persisted and read at
   `applicationDidFinishLaunching`, and login launches are detected via the Apple event (already
   implemented).
3. **WebView panels survive a hidden start on every platform**: WKWebView creation is already lazy on
   macOS (zero cost until first show); WebView2 initializes only from window `Loaded` on Windows
   (hidden start just defers Chromium) and already runs with background-throttling disabled; wry on
   Linux loads the URL while hidden, so the dashboard is warm by the first `show()`.
4. **Recommended shape**: a persisted "start silently" preference (default: silent for login/autostart
   launches, keep current behavior for manual launches), plus `tauri-plugin-autostart` with a
   `--hidden` arg as the new Linux login-launch mechanism. Decisions still open — see
   [Open product questions](#open-product-questions).

---

## Current state per platform

### macOS (`TokenTrackerBar/`)

The app is an agent app (`LSUIElement = YES`, `TokenTrackerBar/project.yml:39-51`; policy toggles to
`.regular` while the dashboard is open — `Services/DashboardPresentationCoordinator.swift:52-55`).
There is no `main.swift`; everything starts in
`applicationDidFinishLaunching` (`TokenTrackerBar/TokenTrackerBarApp.swift:123-168`).

What is shown at launch today:

| Surface | Shown at launch? | Where |
|---|---|---|
| Dashboard **window** (NSWindow + WKWebView) | **Only on manual launch.** Login-item launches skip it: `if NSAppleEventManager.shared().currentAppleEvent?.attributeDescriptor(forKeyword: keyAELaunchedAsLogInItem) == nil { DashboardPresentationCoordinator.shared.showDashboard() }` | `TokenTrackerBarApp.swift:149-154` |
| Menu bar popover (NSPopover) | Never (opens only on status-item click) | `Services/StatusBarController.swift:819-917` |
| Desktop pet / Dynamic Island panels | Restored unconditionally, but non-activating (`orderFrontRegardless` / `.nonactivatingPanel`) | `TokenTrackerBarApp.swift:136,139` |
| WKWebView | Created lazily inside `presentWindow()` — a silent start pays **zero** webview cost | `Services/DashboardWindowController.swift:67-200` |

Other load-bearing facts:

- **Launch-at-login** is `SMAppService.mainApp.register()` with **no arguments**
  (`Services/LaunchAtLoginManager.swift:30,44-46`; auto-enabled on first run via the
  `LaunchAtLoginAutoEnabled` UserDefaults key). A second registration path exists in the bridge
  (`Services/NativeBridge.swift:433-446`).
- The app parses **no CLI arguments at all** (`CommandLine.arguments` appears only in icon-generation
  helper scripts), and `SMAppService.mainApp` cannot carry them anyway (see
  [Apple research](#appendix-a--macos-primary-source-findings)).
- Settings are plain `UserDefaults.standard` string keys; the native↔web bridge already pushes a
  settings payload including `launchAtLogin` and applies changes via `case "launchAtLogin"`
  (`Services/NativeBridge.swift:239-240, 321-324`; dispatched as `native:settings`, line 259). A new
  `launchSilently` key slots straight into this machinery. Native menu item lives at
  `StatusBarController.swift:1210-1213`; web toggle at
  `dashboard/src/components/settings/MenuBarSection.jsx:20-74`.
- Deep links (`tokentracker://open|dashboard|auth/...`) force `showDashboard()`
  (`TokenTrackerBarApp.swift:232-251`, `Services/DashboardWindowController.swift:485-503`) — correct,
  and must keep working through a silent start. `applicationShouldHandleReopen` shows the dashboard on
  Dock/Finder re-open (`TokenTrackerBarApp.swift:114-121`).
- The embedded server lifecycle (`ServerManager.ensureServerRunning()`, `TokenTrackerBarApp.swift:157`)
  is fully independent of window visibility — a silent start still serves `:7680`, syncs, and feeds
  widgets.
- ⚠️ **The existing login detection differs from the proven snippet.** LaunchAtLogin-Modern checks
  `event?.eventID == kAEOpenApplication && event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem`
  ([source](https://github.com/sindresorhus/LaunchAtLogin-Modern/blob/main/Sources/LaunchAtLogin/LaunchAtLogin.swift));
  our code reads `attributeDescriptor(forKeyword: keyAELaunchedAsLogInItem)` directly on the event.
  Both target the same `'lgit` marker (documented in
  `AE.framework/Headers/AERegistry.h`: "If present in a kAEOpenApplication event, application was
  launched as a login item and probably shouldn't open up untitled documents"), but if silent start
  ever fails on some macOS version, align with the Modern package's implementation and verify at
  runtime. The Apple event is only valid **inside** `applicationDidFinishLaunching` — fine today.

### Windows (`TokenTrackerWin/`)

Single WinExe (WinForms `ApplicationContext` + WPF windows + WebView2CompositionControl). Startup is
`Program.Main(string[] args)` (`TokenTrackerWin/Program.cs:9-88`).

What is shown at launch today:

| Surface | Shown at launch? | Where |
|---|---|---|
| Dashboard window (WPF + WebView2) | **Never** auto-opens — created lazily by `EnsureDashboard()`, shown only by tray click / deep link | `TrayApplicationContext.cs:609-626, 414-424`; `Program.cs:73-78` |
| Tray icon | Always | `TrayApplicationContext.cs:208-219` |
| Desktop pet | **Yes**, unless a deep link or `--startup` launch *and* no stored pet preference — `PetWindow.StoredVisible ?? showPetOnLaunch` means a persisted `PetVisible: true` **overrides** the `--startup` silence | `TrayApplicationContext.cs:242-253` |

Other load-bearing facts:

- **Autostart already passes the flag**: HKCU `Software\Microsoft\Windows\CurrentVersion\Run` value
  `TokenTracker` = `"...exe" --startup` (`LaunchAtStartup.cs:12,18,59-65`), parsed at
  `Program.cs:15-18` (`LaunchAtStartup.StartupArgument`), and `showPetOnLaunch = deepLink is null &&
  !launchedAtStartup` (`Program.cs:73-78`). The installer deliberately does not register autostart and
  its post-install run passes no args (`installer/TokenTracker.iss:71-76`) — i.e., "manual launch"
  semantics.
- **WebView2 initializes from `Loaded`** (`DashboardWindow.cs:147-160` → `EnsureCoreWebView2Async` at
  `:330`; pet likewise at `PetWindow.cs:157,262`), so it is coupled to *first show* — a hidden start
  simply defers Chromium cost to the first open. Once running hidden, JS keeps executing because
  background throttling is already disabled via browser args (`DashboardWindow.cs:315-328`), and the
  tray summary path already skips WebView reads while hidden (`TrayApplicationContext.cs:902-916`).
  Minimize already collapses the WebView visual to avoid a DirectComposition ghost
  (`DashboardWindow.cs:117-139`) — precedent for visibility toggles.
- Close-to-tray exists everywhere: `DashboardWindow.OnClosing` cancels + `Hide()`
  (`DashboardWindow.cs:1028-1041`); Escape and the injected web close button route to the same hide
  (`:140, :501`).
- Single instance: named mutex; second launches forward `tokentracker://` payloads over a named pipe
  and exit — they do **not** show the existing window (`Program.cs:20-32`,
  `SingleInstance.cs:22-60`). `HandleDeepLink` shows the dashboard for auth callbacks
  (`TrayApplicationContext.cs:699-726`).
- Settings: single JSON `%LOCALAPPDATA%\TokenTracker\native-settings.json` shared by
  `NativeLocalization`/`NativeTheme`/`Currency`/`PetWindow` (existing keys include `PetVisible`).
  A `StartSilently` key would follow the `PetWindow.WriteSettings` pattern
  (`PetWindow.cs:1241-1258`, `NativeTheme.cs:43-54`). Tray menu already has a "Launch at Login"
  checkbox (`TrayApplicationContext.cs:160-162, 731-735`).
- Note: the dashboard Settings page's `launchAtLogin` toggle is **macOS-only** — the Windows host
  implements no `launchAtLogin` bridge cases (`DashboardWindow.cs:425-507`), so any new Windows
  setting should either go tray-menu-first or extend `WebMessageReceived`.

### Linux (`TokenTrackerLinux/`, Tauri v2)

Window is built **programmatically** in `setup()` — `tauri.conf.json` has `"windows": []`
(`TokenTrackerLinux/src-tauri/tauri.conf.json:13`). Builder call at
`TokenTrackerLinux/src-tauri/src/main.rs:274-283` has **no `.visible(false)`**, so the window is
always shown at launch (it paints `src/index.html` as a loading screen while the embedded Node server
boots, then navigates to the dashboard — `start_dashboard`, `main.rs:91-137`).

Other load-bearing facts:

- **Close-to-tray already exists**: `WindowEvent::CloseRequested` → `prevent_close()` + `hide()`
  (`main.rs:290-295`). So hide/show round-trips are already part of normal usage.
- **Tray is menu-only by design** — a documented comment explains that `TrayIconEvent` is never
  emitted on Linux (`src/tray.rs:14-25`); "Open Dashboard" is the first menu item →
  `show_main_window` (`tray.rs:50-56`, `unminimize + show + set_focus`), "Quit" → `app.exit(0)`.
- **Single instance** is registered first with argv access (`main.rs:251-258`): a second launch
  forwards OAuth callbacks or falls through to `tray::show_main_window` — i.e., "user launched the exe
  again" already surfaces the window.
- **Launch args**: `initial_args` is collected (`main.rs:245`) but only scanned for OAuth callbacks
  (`main.rs:265-269`). No `--hidden`-style flag exists.
- **No autostart plugin** (`Cargo.toml:21-23`: only `tauri-plugin-single-instance`).
- Window creation *must* stay up-front (comment at `main.rs:271-273`): the tray's "Open Dashboard"
  needs a "main" window to raise, and `start_dashboard` runs on a worker thread. A `visible(false)`
  build preserves both.
- Capabilities: `core:default` + `allow-open-oauth`
  (`src-tauri/capabilities/default.json:6`) — no window show/hide permissions granted to JS today,
  and `tests/capabilities.rs` asserts on the capability files; if the frontend ever needs to call
  `window.show()` itself, extend capabilities there deliberately.

## Platform mechanism research (primary sources)

### macOS

- **"Silent start" is the AppKit default.** Nothing is shown at launch unless code does it —
  `applicationDidFinishLaunching` merely signals init completion
  ([docs](https://developer.apple.com/documentation/appkit/nsapplicationdelegate/applicationdidfinishlaunching(_:))). Reference agent apps (Rectangle, Stats, Maccy, MonitorControl) are all
  `LSUIElement` + never call show at launch, which is why they need no flag at all
  ([Rectangle Info.plist](https://github.com/rxhanson/Rectangle/blob/master/Rectangle/Info.plist),
  [Stats Info.plist](https://github.com/exelban/stats/blob/master/Stats/Supporting%20Files/Info.plist),
  [Maccy Info.plist](https://github.com/p0deje/Maccy/blob/master/Maccy/Info.plist)).
- **`SMAppService.mainApp` passes no arguments**, and the API "doesn't provide any way to
  differentiate between automatic login launch and manual launches"
  ([SMAppService docs](https://developer.apple.com/documentation/servicemanagement/smappservice),
  [LaunchAtLogin-Legacy #33](https://github.com/sindresorhus/LaunchAtLogin-Legacy/issues#33) →
  [issue](https://github.com/sindresorhus/LaunchAtLogin-Legacy/issues/33)). Detection therefore rides
  on the `'lgit` Apple-event marker
  ([LaunchAtLogin-Modern source](https://github.com/sindresorhus/LaunchAtLogin-Modern/blob/main/Sources/LaunchAtLogin/LaunchAtLogin.swift)),
  valid only inside `applicationDidFinishLaunching`. A guaranteed custom flag would require
  `SMAppService.agent(plistName:)` with our own `ProgramArguments`
  ([Calendr example](https://github.com/pakerwreah/Calendr/blob/master/Calendr/Providers/LaunchServiceProvider.swift))
  — heavier, and not needed if the preference is persisted instead.
- **Pitfalls**: don't call `NSApp.activate(ignoringOtherApps: true)` from a silent start
  ([docs](https://developer.apple.com/documentation/appkit/nsapplication/activate(ignoringotherapps:)));
  `NSPanel.hidesOnDeactivate` defaults to true (panels vanish when app inactive — ours are
  non-activating, which is fine)
  ([Window Programming Guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/WinPanel/Concepts/UsingPanels.html));
  popover `show(relativeTo:of:)` is a no-op if the positioning view isn't visible
  ([NSPopover.show](https://developer.apple.com/documentation/appkit/nspopover/show(relativeto:of:preferrededge:))).
- Details in [Appendix A](#appendix-a--macos-primary-source-findings).

### Windows

- **Canonical hidden-start pattern for WinForms**: `SetVisibleCore(false)` gating — not `Hide()` in
  `Shown` (flashes) nor `Opacity = 0` (extra moving parts)
  ([SetVisibleCore docs](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.form.setvisiblecore?view=windowsdesktop-8.0),
  [canonical SO thread](https://stackoverflow.com/questions/70272/single-form-hide-on-startup)).
  **Our architecture doesn't need it**: there is no startup form at all — `ApplicationContext` +
  lazily created windows.
- **WebView2 runs fine while hidden**: initialization is independent of visibility; hidden means "not
  rendered" + Chromium throttling (~100 ms timers → ~1 s) but JS continues
  ([ICoreWebView2Controller](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller),
  [WebView2Feedback#3070](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3070)). Edge cases
  to know: blank-on-first-show when created under raw `SW_HIDE` in Win32
  ([#4763](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4763)), hidden host suppresses
  child popups/auth dialogs ([#5167](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5167)),
  `document.visibilitychange` never fires for host-hidden windows
  ([#2681](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2681)).
- **Run-key args are sanctioned** — the value *is* a command line ("The data value for a key is a
  command line no longer than 260 characters"), and Windows may deliberately delay Run-key apps so
  they don't "interfere with the foreground user experience"
  ([Run and RunOnce Registry Keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)).
  The `--minimized`/`--hidden` flag convention is de-facto, not mandated. Alternatives: Startup-folder
  shortcut args ([IShellLink::SetArguments](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishelllinka-setarguments)),
  Task Scheduler `LogonTrigger`
  ([docs](https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger)). The existing
  `--startup` flag already matches the convention.
- Full citations in [Appendix B](#appendix-b--windows-primary-source-findings).

### Linux / Tauri v2

- **Hidden window at startup**: `app.windows[].visible` config key (default `true`;
  [config reference](https://v2.tauri.app/reference/config/)) — but since the window is
  builder-created here, the equivalent is `.visible(false)` on `WebviewWindowBuilder`. Later
  `window.show()` / `unminimize()` / `set_focus()` from Rust
  ([WebviewWindow docs](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html)).
  **wry loads the URL while hidden** (`load_uri` runs unconditionally; visibility only gates
  `show_all()`) — the dashboard is warm at first show
  ([wry webkitgtk backend](https://github.com/tauri-apps/wry/blob/dev/src/webkitgtk/mod.rs)).
- **Tray on Linux is menu-only** — `TrayIconEvent` "Linux: Unsupported"; left-click opens the context
  menu via libappindicator anyway ([TrayIconEvent docs](https://docs.rs/tauri/latest/tauri/tray/enum.TrayIconEvent.html))
  — our `tray.rs` already models this correctly. GNOME needs
  `gnome-shell-extension-appindicator` ([ArchWiki](https://wiki.archlinux.org/title/GNOME)); the
  runtime dlopens `libayatana-appindicator3.so.1` then `libappindicator3.so.1`
  ([libappindicator-sys](https://docs.rs/crate/libappindicator-sys/latest)) — deb/rpm should list the
  ayatana lib in depends.
- **`tauri-plugin-autostart` v2** wraps the `auto-launch` crate
  ([source](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)):
  `init(MacosLauncher, Some(vec!["--hidden"]))`, `enable()/disable()/is_enabled()`. Verified
  per-platform behavior: **Linux** writes `~/.config/autostart/<app>.desktop` with
  `Exec=<path> --hidden` (args survive;
  [auto-launch linux.rs](https://github.com/teamortix/auto-launch/blob/master/src/linux.rs));
  **AppImage self-locates** via the `APPIMAGE` env var
  ([plugin src](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/autostart/src/lib.rs),
  [Env docs](https://docs.rs/tauri/latest/tauri/struct.Env.html)) — but the absolute path goes stale
  after the AppImage moves/updates, so re-`enable()` after updates; **Windows** writes the HKCU Run
  key with args plus a `StartupApproved` blob; **macOS** writes a LaunchAgent plist with
  `ProgramArguments` (note: we would *not* use it there — we already have SMAppService).
- **`tauri-plugin-single-instance`** callback receives `argv`
  ([source](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/lib.rs))
  — a second launch carrying no `--hidden` flag means "user launched it", so the primary can show the
  window (matches the current fall-through behavior at `main.rs:257`).
- **Pitfalls**: Wayland hide→show can leave CSD titlebar buttons dead until a compositor configure
  ([tao#1299](https://github.com/tauri-apps/tao/issues/1299)) — worth a manual test since our
  close-to-tray already hides/shows; window positioning is ignored on Wayland
  ([tao#566](https://github.com/tauri-apps/tao/issues/566)); hidden-start rendering quirks on some GL
  stacks need `WEBKIT_DISABLE_COMPOSITING_MODE=1`/`WEBKIT_DISABLE_DMABUF_RENDERER=1`
  ([tauri#15936](https://github.com/tauri-apps/tauri/issues/15936)) — we already default the DMABUF
  var (`main.rs:39-43`).
- Details in [Appendix C](#appendix-c--tauri-v2-primary-source-findings).

## Recommended design

### Shared behavior contract

1. **Silent for auto-launches** (login item / Run key / XDG autostart): app starts with menu-bar /
   tray presence only. No main window, no focus stealing. Server, sync, and tray still run.
2. **Manual launches keep today's semantics**: macOS shows the dashboard (current behavior),
   Windows shows pet per stored preference, Linux shows the window.
3. **A persisted "start silently" preference** controls (1) per app, because only Windows/Linux can
   use a per-launch flag; on macOS the flag channel doesn't exist. Default: follow (1)/(2) — i.e.
   silent when auto-launched, unless the user opts into "open dashboard at login".
4. **User-initiated surfaces always win**: tray/menu-bar click, `tokentracker://` deep links (incl.
   OAuth callbacks), `applicationShouldHandleReopen` (macOS), second-instance forwarding.

### macOS implementation sketch

Everything hangs off `TokenTrackerBarApp.swift:149-154`:

- Add `UserDefaults` key (e.g. `LaunchSilently`, default: only login launches are silent — preserving
  today's behavior) and extend the condition: `if silent (login launch || user pref) { skip show }`.
- Add the toggle in three places, mirroring `launchAtLogin`: the status-bar menu
  (`StatusBarController.swift:1210-1213`), `NativeBridge.pushSettings` payload + `applySetting` switch
  (`NativeBridge.swift:239-240, 321-324`), and `dashboard/src/components/settings/MenuBarSection.jsx`.
- No `--silent` arg work: `SMAppService.mainApp` can't carry it
  (`LaunchAtLoginManager.swift:30`).
- Optional hardening: align the `'lgit` check with LaunchAtLogin-Modern's
  `paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue` form.

### Windows implementation sketch

- The main gap is the **pet** (`TrayApplicationContext.cs:242`): decide that `--startup` (and any new
  "start silently" preference) suppresses the pet regardless of `PetWindow.StoredVisible` — e.g.
  `if (!silent) { pet per StoredVisible }`, restoring the pet on first user show of the tray menu.
- Optional: persist `StartSilently` in `native-settings.json` (pattern:
  `PetWindow.WriteSettings`, `PetWindow.cs:1241-1258`) + a tray-menu checkbox next to "Launch at
  Login" (`TrayApplicationContext.cs:160-162`).
- No dashboard work needed — it already never auto-opens, and WebView2 simply initializes at first
  show. Keep `Program.cs`'s `--startup` flag as-is; it already equals the platform convention.

### Linux implementation sketch

- In `main.rs`: read `initial_args` for `--hidden`/`--startup` (same flag name as Windows for
  consistency), and conditionally add `.visible(false)` to the `WebviewWindowBuilder`
  (`main.rs:274-283`). The window still exists for the tray menu and still loads/navigates while
  hidden — `tray::show_main_window` (`tray.rs:50-56`) needs no changes.
- Single-instance callback (`main.rs:251-258`): keep showing the window when the second launch has no
  hidden flag (user intent); skip the show when it does.
- Add `tauri-plugin-autostart = "2"` with `Some(vec!["--hidden"])`; persist the enabled state choice
  behind a tray-menu item ("Launch at Login") or dashboard setting. Re-`enable()` after AppImage
  updates (stale absolute path).
- Guardrails: `tests/capabilities.rs` unaffected (no capability changes needed); manual-test the
  Wayland hide→show round trip ([tao#1299](https://github.com/tauri-apps/tao/issues/1299)); consider
  adding `libayatana-appindicator3-1` to the .deb depends if not already pulled in.

## Open product questions

1. **Should manual (Dock/Finder/Start-menu) launches also be silent?** Today macOS deliberately opens
   the dashboard on manual launch (`TokenTrackerBarApp.swift:148-154` comment). Options: keep manual
   = show (recommended), or make silence universal with an "open dashboard on launch" opt-in.
2. **Windows pet vs. silence**: should `--startup` beats `StoredVisible` (recommended — silent start
   means *nothing* pops), or should the pet be exempt because it's considered ambience, not a panel?
3. **Does "launch at login" imply silent?** Recommended: yes, silent-at-login is the default and the
   extra preference only exists to opt *out* of silence (i.e. "also open the dashboard at login").
   This matches platform norms (Microsoft delays Run-key apps to avoid foreground interference;
   Apple's `'lgit` header comment says login-launched apps "probably shouldn't open up untitled
   documents").
4. **Linux scope**: silent start is near-free, but launch-at-login on Linux is a brand-new capability
   (plugin + tray item + AppImage path staleness). Ship together, or silent-start args first?

## Appendix A — macOS primary-source findings

- `applicationDidFinishLaunching(_:)` — "Tells the delegate that the app's initialization is complete
  but it hasn't received its first event"; nothing is auto-presented.
  https://developer.apple.com/documentation/appkit/nsapplicationdelegate/applicationdidfinishlaunching(_:)
- `LSUIElement` — "the app is an agent app that runs in the background and doesn't appear in the
  Dock". https://developer.apple.com/documentation/bundleresources/information-property-list/lsuielement
- `NSApplication.ActivationPolicy` — `.regular` / `.accessory` / `.prohibited` semantics;
  settable at runtime.
  https://developer.apple.com/documentation/appkit/nsapplication/activationpolicy-swift.enum
- `SMAppService` — `mainApp` login item; `register()` takes no arguments; `agent(plistName:)` allows a
  custom `ProgramArguments` plist inside `Contents/Library/LaunchAgents/`.
  https://developer.apple.com/documentation/servicemanagement/smappservice
- `keyAELaunchedAsLogInItem = 'lgit'` — "If present in a kAEOpenApplication event, application was
  launched as a login item and probably shouldn't open up untitled documents, etc. Mac OS X 10.4 and
  later." (`AE.framework/Headers/AERegistry.h`, quoted in
  [LaunchAtLogin-Modern source](https://github.com/sindresorhus/LaunchAtLogin-Modern/blob/main/Sources/LaunchAtLogin/LaunchAtLogin.swift))
- No way to distinguish login vs manual launch via SMAppService API itself:
  https://github.com/sindresorhus/LaunchAtLogin-Legacy/issues/33 (maintainer statement; also
  https://stackoverflow.com/questions/74699425/smappservice-register-how-to-detect-launch-at-startup-login-vs-regular-launc)
- Reference implementations of silent agent apps: Rectangle
  https://github.com/rxhanson/Rectangle/blob/master/Rectangle/LaunchOnLogin.swift · Stats
  https://github.com/exelban/stats/blob/master/Kit/helpers.swift · Maccy
  https://github.com/p0deje/Maccy/blob/master/Maccy/Settings/GeneralSettingsPane.swift (uses
  LaunchAtLogin-Modern)
- `activate(ignoringOtherApps:)` focus-stealing guidance:
  https://developer.apple.com/documentation/appkit/nsapplication/activate(ignoringotherapps:)
- `NSPanel.hidesOnDeactivate` default-true behavior:
  https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/WinPanel/Concepts/UsingPanels.html
- `NSPopover.show` no-op when positioning view invisible:
  https://developer.apple.com/documentation/appkit/nspopover/show(relativeto:of:preferrededge:)
- macOS 15 release notes (no AppKit popover/panel behavior changes affecting this):
  https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes

## Appendix B — Windows primary-source findings

- `Form.SetVisibleCore(bool)` — canonical no-flash hidden start:
  https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.form.setvisiblecore?view=windowsdesktop-8.0
  + https://stackoverflow.com/questions/70272/single-form-hide-on-startup
- `NotifyIcon` official pattern (icon, Visible=true, context menu with Exit, double-click restore):
  https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.notifyicon?view=windowsdesktop-8.0
- Run/RunOnce registry keys — value is a command line (args sanctioned, 260-char cap); system may
  delay execution to avoid foreground interference:
  https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys
- Startup folder + shortcut arguments: https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid ·
  https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishelllinka-setarguments
- Task Scheduler `LogonTrigger` (UserId/Delay): https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger
- `StartupTask` (packaged apps; user in control; UWP startup apps start minimized):
  https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.startuptask
- `ICoreWebView2Controller.IsVisible` — hidden = not rendered, throttled, caches purged; recommended
  to toggle with window minimize: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller
- WebView2 initialization independent of visibility:
  https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.winforms.webview2?view=webview2-dotnet-1.0.2792.45 ·
  https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.winforms.webview2.ensurecorewebview2async?view=webview2-dotnet-1.0.2792.45
- Known hidden-mode issues: timer throttling #3070 (→ standing #1172) · visibilitychange never fires
  #2681/#4879 · blank first show when created under SW_HIDE in raw Win32 #4763 · hidden host
  suppresses popups/auth dialogs #5167 · IsVisible flip can steal foreground #398 · windowless
  rendering unsupported #20/#547 — all under https://github.com/MicrosoftEdge/WebView2Feedback
- `ShowInTaskbar` runtime toggling recreates the HWND (avoid):
  https://github.com/dotnet/winforms/issues/6421 (fix https://github.com/dotnet/winforms/pull/6989)
- Ghost tray icon if NotifyIcon not disposed: https://github.com/dotnet/winforms/issues/6996
- Second-instance args forwarding via `WindowsFormsApplicationBase.OnStartupNextInstance`:
  https://learn.microsoft.com/en-us/dotnet/api/microsoft.visualbasic.applicationservices.windowsformsapplicationbase.onstartupnextinstance?view=windowsdesktop-8.0

## Appendix C — Tauri v2 primary-source findings

- Config reference (`app.windows[].visible`, trayIcon keys; `showMenuOnLeftClick` "Linux:
  Unsupported"): https://v2.tauri.app/reference/config/
- System tray guide (TrayIconBuilder, show-window snippet, menu events): https://v2.tauri.app/learn/system-tray/
- `WebviewWindow::show/hide/unminimize/set_focus`: https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html
- `WindowEvent::CloseRequested` + `CloseRequestApi::prevent_close`: https://docs.rs/tauri/latest/tauri/enum.WindowEvent.html ·
  https://docs.rs/tauri/latest/tauri/struct.CloseRequestApi.html
- `TrayIconEvent` — Click "Linux: Unsupported", DoubleClick "Windows Only": https://docs.rs/tauri/latest/tauri/tray/enum.TrayIconEvent.html
- Linux tray stack: `tray-icon` gtk backend → libappindicator (ayatana first):
  https://github.com/tauri-apps/tray-icon/blob/dev/src/platform_impl/gtk/mod.rs ·
  https://docs.rs/crate/libappindicator-sys/latest · GNOME appindicator extension requirement:
  https://wiki.archlinux.org/title/GNOME
- `tauri-plugin-autostart` (source, permissions): https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart ·
  https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/autostart/permissions/default.toml
- `auto-launch` per-platform behavior (`.desktop` Exec args / HKCU Run + StartupApproved / LaunchAgent
  plist; AppImage via `APPIMAGE` env): https://github.com/teamortix/auto-launch/blob/master/src/linux.rs ·
  https://github.com/teamortix/auto-launch/blob/master/src/windows.rs ·
  https://github.com/teamortix/auto-launch/blob/master/src/macos.rs ·
  https://docs.rs/tauri/latest/tauri/struct.Env.html
- `tauri-plugin-single-instance` (argv in callback; register first): https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/lib.rs ·
  https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/README.md
- wry loads the URL while hidden (visibility only gates `show_all`; X11 hidden-start needs ~3
  `set_visible` calls): https://github.com/tauri-apps/wry/blob/dev/src/webkitgtk/mod.rs
- Wayland caveats: CSD buttons dead after hide→show https://github.com/tauri-apps/tao/issues/1299 ·
  positioning ignored https://github.com/tauri-apps/tao/issues/566 · tray icon missing in some
  launch modes https://github.com/tauri-apps/tauri/issues/14234 · blank window / DMABUF envs
  https://github.com/tauri-apps/tauri/issues/15936
- freedesktop autostart spec (`~/.config/autostart/*.desktop`, `Exec` args, `Hidden=true`):
  https://specifications.freedesktop.org/autostart/latest/
- Window show/hide JS permissions (`core:window:allow-show` etc.):
  https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/permissions/window/autogenerated/reference.md
