# TokenTracker for Windows (tray app)

The Windows counterpart of the macOS menu-bar app (`TokenTrackerBar/`). It is a
thin native shell around the same cross-platform pieces — the Node CLI, the local
`tracker serve` server, and the built dashboard — exposed as a resident **system
tray** application.

- **Stack:** .NET 8 WinForms + WebView2 (mirrors the macOS `NSStatusItem` + `WKWebView` design).
- **Scope (MVP):** tray icon, right-click menu (Open Dashboard / Sync Now / Launch at startup / Star on GitHub / Quit), auto-starts the local server, opens the dashboard in an embedded WebView2 window.

## What it does

### Desktop quota

Use the top-right **Close widget** button in either view to hide it. This disables
the widget persistently (including after restart); reopen it from **Desktop quota**
in the tray menu. Closing the widget does not quit the app.


Right-click the tray icon and enable **Desktop quota**. The 320 × 144 DIP
surface shows two remaining-quota bars and actual reset countdowns; click to expand to 360 × 340 DIP.
Use the sliders button to choose up to two provider windows, drag the grip to
move it, and press Escape to collapse. The widget follows the app theme and
language, remembers its position and selection, and hides over fullscreen apps.
Closing the dashboard does not stop its shared 60-second quota polling.
The feature is opt-in and can be hidden from the same tray menu.

Build Windows dashboard assets with `TOKENTRACKER_BUILD_PET=1`; this includes
both `pet.html` and `quota.html`. The quota surface uses a solid layered window
with a clipped rounded region, so it does not require Windows 11 Acrylic.

1. On launch it resolves a Node runtime + the tracker CLI, picks a free loopback
   port, and starts `tracker serve --port <P> --no-sync --no-open`.
2. The tray icon stays resident. Left-click or **Open Dashboard** shows the
   dashboard in a WebView2 window pointed at `http://127.0.0.1:<P>`.
3. On quit (or crash — see Job Object below) the Node server is stopped.

### Why a dynamic port instead of 7680

The macOS app hardcodes `:7680`. On Windows that port is frequently taken:
**Delivery Optimization (DoSvc)** binds `::7680` dual-stack, which also reserves
IPv4 `7680`, so binding fails with `EACCES`. We therefore pick a free loopback
port at launch and pass it explicitly, and always use the literal `127.0.0.1`
(never `localhost`, which resolves to `::1` first and would hit DoSvc).

### Process cleanup

`ServerManager` assigns the Node process to a Windows **Job Object** with
`KILL_ON_JOB_CLOSE`, so the server is terminated even if the tray app is
force-killed (Task Manager "End task" / crash), not just on a graceful Quit.

## Requirements

- Windows 10/11 with the **WebView2 Runtime** (preinstalled on Windows 11; the
  Evergreen runtime is otherwise auto-installed by Edge updates).
- **.NET 8 SDK** to build.
- A Node runtime + the tracker CLI — either bundled (`scripts\bundle-node.ps1`)
  or, for dev, system Node + this repo (see below).

## Build

```powershell
dotnet build -c Debug   # output: bin\Debug\net8.0-windows\TokenTracker.exe
```

The tray icon is committed at `assets\trayicon.ico`. To regenerate it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1
```

## Run in dev (against this repo, no bundle)

`tracker serve` requires a built dashboard, so build it once from the repo root:

```powershell
npm run dashboard:build
```

Then point the app at system Node + the repo CLI via env vars and run it:

```powershell
$env:TOKENTRACKER_NODE  = (Get-Command node).Source
$env:TOKENTRACKER_ENTRY = "$PWD\..\bin\tracker.js"   # from TokenTrackerWin\
.\bin\Debug\net8.0-windows\TokenTracker.exe
```

The exe runs in the tray (no console window). Right-click the tray icon to quit.

## Bundle a self-contained runtime (for distribution)

Mirrors `TokenTrackerBar/scripts/bundle-node.sh`. Downloads the pinned Node
win-x64 binary and copies the CLI source + built dashboard into `EmbeddedServer\`
(gitignored), which `ServerManager` prefers over the dev fallback.

```powershell
npm run dashboard:build                                   # from repo root
powershell -ExecutionPolicy Bypass -File scripts\bundle-node.ps1
dotnet publish -c Release -r win-x64 --self-contained false
```

> The published `EmbeddedServer\` must sit next to `TokenTracker.exe`. Wire it
> into the publish output (copy step / installer) when packaging an installer.

## Not yet implemented (vs. the macOS app)

This is an MVP launcher. The following macOS features are **not** ported yet:

- Live token/cost numbers rendered into the tray icon.
- Native ↔ web bridge (`NativeBridge`) — Settings page menu-bar-pref controls,
  theme sync, OAuth deep-link relay. The dashboard loads in plain web mode.
- Auto-update checker.
- An installer / signed package and a CI workflow to build the `.exe`.
