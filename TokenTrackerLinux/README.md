# TokenTracker Linux Client

A Tauri desktop client for TokenTracker. It is the Linux counterpart of the macOS
menu bar app and the Windows tray app: a native shell that starts the bundled
TokenTracker CLI on a loopback port, loads the same dashboard in a WebKitGTK
window, and keeps a tray icon alive.

Two distribution paths are supported:

- **Release packages** — an **AppImage**, a **`.deb`** and an **`.rpm`**, built
  by CI and attached to every release.
- **Arch package** — a `PKGBUILD` for building from a local checkout.

## Install

All three release packages carry the same embedded Node runtime and dashboard.

### AppImage

Self-contained — besides the Node runtime and the built dashboard it carries
GTK3, WebKitGTK (including the `WebKitWebProcess` / `WebKitNetworkProcess`
helpers) and appindicator, so it runs on any reasonably current glibc distro
with no package manager and no GUI dependencies. Download
`TokenTracker-linux-x86_64.AppImage` from the
[latest release](https://github.com/xiufengsun/TokenTracker/releases/latest),
then:

```bash
chmod +x TokenTracker-linux-x86_64.AppImage
./TokenTracker-linux-x86_64.AppImage
```

AppImages need FUSE. On distros that ship FUSE 3 only, install `fuse3`
(Debian/Ubuntu: `sudo apt install libfuse2t64` for older AppImage runtimes). To
run without FUSE at all:

```bash
./TokenTracker-linux-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun
```

### Debian / Ubuntu (apt)

```bash
sudo apt install ./TokenTracker-linux-x86_64.deb
```

Needs `libappindicator3-1`, which lives in Ubuntu's **universe** component and
is absent from Debian 12; use the AppImage there, which carries its own copy.

### Fedora / RHEL (dnf)

```bash
sudo dnf install ./TokenTracker-linux-x86_64.rpm
```

The `.deb` and `.rpm` link against the system GTK/WebKit rather than bundling
them — ~55MB against the AppImage's ~120MB, at the cost of a real dependency
list. The `.deb` declares `libwebkit2gtk-4.1-0`, `libgtk-3-0`,
`libayatana-appindicator3-1` and `libappindicator3-1`; the `.rpm` requires the
equivalent `libwebkit2gtk-4.1.so.0`, `libgtk-3.so.0` and
`libappindicator3.so.1`.

## Build the Arch package

```bash
cd TokenTrackerLinux/packaging/arch/tokentracker-linux
makepkg -si
```

> **Packaging scope:** this PKGBUILD builds from a local repository checkout. It
> is not ready for AUR publication or clean-chroot builds, and does not promise
> byte-identical artifacts.

Uninstall with `sudo pacman -R tokentracker-linux`.

## Run

Start **TokenTracker** from your application launcher, or run
`tokentracker-linux` (Arch package) / the AppImage directly.

On launch the window shows a loading screen while the bundled server starts, then
navigates to the dashboard. If the runtime cannot be found the window reports the
error and lists every location it checked, rather than hanging on the splash.

## Window and tray behaviour

- Closing the window hides it to the tray; the app keeps syncing in the
  background.
- Tray **Open Dashboard** restores the window.
- Tray **Quit** stops the bundled Node server and exits.

### The tray menu is the only tray interaction

Left-clicking the tray icon does **not** raise the window, and this is a platform
limitation rather than a bug. Linux tray icons go through
libayatana-appindicator, whose backend in the `tray-icon` crate never emits click
events — both Tauri and `tray-icon` document it as *"Linux: Unsupported. The
event is not emitted even though the icon is shown."* libappindicator opens the
menu on left click anyway, so **Open Dashboard** is the first menu item.

### GNOME does not show tray icons by default

GNOME removed StatusNotifierItem support, so on stock GNOME (including Ubuntu's
default session) **the tray icon will not appear at all**. Install the
[AppIndicator and KStatusNotifierItem Support](https://extensions.gnome.org/extension/615/appindicator-support/)
extension:

```bash
# Debian / Ubuntu
sudo apt install gnome-shell-extension-appindicator
# Fedora
sudo dnf install gnome-shell-extension-appindicator
```

Then enable it (GNOME Extensions app) and log out and back in. KDE Plasma, XFCE,
Cinnamon and MATE show the icon with no extra setup.

Until the extension is installed, closing the window hides the app with no way to
get it back from the tray — quit it from the launcher or with `pkill
tokentracker-linux`.

### The window is blank, or the app exits immediately

WebKitGTK renders through DMA-BUF by default. On some Wayland setups — most
reliably NVIDIA's proprietary driver — that path either paints a permanently
blank webview or loses the Wayland connection outright, exiting non-zero with:

```
Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.
```

The client therefore sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before starting
GTK. To retry the accelerated renderer, set it explicitly — an explicit value is
never overridden:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=0 tokentracker-linux
```

WebKitGTK treats the variable as "set and not `0`", so `=0` genuinely restores
the accelerated path while any other value (including an empty string) disables
it.

Note that when the webview aborts this way the app never reaches its shutdown
path, so the bundled Node server is left running and keeps port 17680. Since
OAuth sign-in requires that exact port, a later launch will fall back to a
random port and browser sign-in will fail until the orphan is stopped:

```bash
pkill -f 'tokentracker/bin/tracker.js serve'
```

## Sign-in

The app prefers a **fixed loopback port, 17680**, because OAuth redirect URLs
have to be registered server-side. Email sign-in works on any port; browser-based
Google/GitHub sign-in needs `http://127.0.0.1:17680/auth/callback`, so if
something else already holds 17680 the app falls back to a random port and OAuth
will not complete until 17680 is free again.

The AppImage registers a per-user `.desktop` handler for the
`tokentracker://` OAuth callback on first launch and refreshes it whenever the
AppImage moves. This requires `xdg-mime` (normally provided by `xdg-utils`). The
Arch package installs the equivalent handler system-wide.

## Logs

The bundled server's stderr goes to
`${XDG_STATE_HOME:-$HOME/.local/state}/tokentracker/server.log`, falling back to
`/tmp/tokentracker-server.log`. The log rotates once it passes 5 MB, keeping a
single `server.log.1` generation.

## Development

```bash
npm ci --prefix TokenTrackerLinux
TOKENTRACKER_BUILD_PET=1 npm run dashboard:build   # from the repo root; includes pet.html
npm --prefix TokenTrackerLinux run bundle:node # stages EmbeddedServer/
npm --prefix TokenTrackerLinux run dev
```

`TOKENTRACKER_BUILD_PET=1` adds `pet.html`, the page the floating desktop pet
loads (tray → **Show Pet**, or the dashboard's Pet page). Without it the pet
window has nothing to show.

`bundle:node` must run before any bundling build: `tauri.bundle.conf.json`
declares `EmbeddedServer` as a bundle resource and `tauri-build` fails on a
missing resource path.

Tests:

```bash
cd TokenTrackerLinux/src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
```

Build dependencies: `webkit2gtk-4.1`, `gtk3`, `libayatana-appindicator`,
`librsvg`, `pkgconf` (plus the `-dev`/`-devel` packages on Debian/Fedora).
