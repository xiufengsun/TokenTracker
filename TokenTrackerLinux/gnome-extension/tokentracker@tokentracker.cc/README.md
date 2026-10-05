# TokenTracker GNOME Shell extension

Puts today's tokens and cost in the GNOME top bar, next to a pixel Clawd,
like the macOS menu bar item. Clicking it opens a dropdown modelled on the
macOS popover: summary cards, usage limits, the activity heatmap, the usage
trend (day / week / month / total) and top models, plus a sync button and a
link to the dashboard.

It reads everything from the Linux desktop app's local server on
`127.0.0.1:17680`, so the app has to be running. It sends nothing anywhere
else. If something else holds 17680 when the app starts, the app falls back
to a random port and the extension shows "TokenTracker isn't running". Free
the port and restart the app.

Community-maintained: the core team has no GNOME setup to test on, so
report problems with your GNOME version. `metadata.json` lists 45–50.
Tested on 46 (Ubuntu 24.04, Wayland), and on 49 (Fedora 43) and 50
(Fedora 44) in headless shells; 45, 47 and 48 are untested. Styled for the
dark shell theme.

## Install from a checkout

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD/TokenTrackerLinux/gnome-extension/tokentracker@tokentracker.cc" \
  ~/.local/share/gnome-shell/extensions/tokentracker@tokentracker.cc
```

Log out and back in (Wayland can't reload the shell in place), then:

```bash
gnome-extensions enable tokentracker@tokentracker.cc
```

Errors show up in `journalctl --user -b -o cat /usr/bin/gnome-shell`.

## Trying changes without logging out

Run a throwaway headless shell and drive it over D-Bus:

```bash
dbus-run-session -- bash -c '
  gnome-shell --headless --unsafe-mode --virtual-monitor 1600x1400 \
    --wayland-display tt-headless &
  shell=$!
  sleep 12
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval \
    "Main.panel.statusArea[\"tokentracker@tokentracker.cc\"].menu.open(false)"
  sleep 5
  gdbus call --session --dest org.gnome.Shell.Screenshot \
    --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.ScreenshotArea 800 0 800 900 false /tmp/tt.png
  kill $shell'
```

If your terminal is a snap (VS Code), unset `GSETTINGS_SCHEMA_DIR`,
`XDG_DATA_HOME` and `GIO_MODULE_DIR` first or the nested shell crashes.
