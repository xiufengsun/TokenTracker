const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(repoRoot, "TokenTrackerWin", file), "utf8");

const dashboard = read("DashboardWindow.cs");
const helper = read("MaximizedWorkArea.cs");

function methodBody(source, signature) {
  const match = source.match(new RegExp(`${signature}\\s*\\{([\\s\\S]*?)\\n    \\}`));
  return match ? match[1] : null;
}

// #1152: Maximizing the borderless WPF dashboard (WindowStyle.None + custom
// WindowChrome) covers a visible Windows taskbar. The host must answer
// WM_GETMINMAXINFO with the current monitor's work area (rcWork), not the
// fullscreen rcMonitor and not only the primary SystemParameters.WorkArea.
test("Windows dashboard WndProc constrains maximize via WM_GETMINMAXINFO", () => {
  assert.match(dashboard, /private const int WM_GETMINMAXINFO = 0x0024;/);
  assert.match(dashboard, /private const int MONITOR_DEFAULTTONEAREST = 0x00000002;/);

  const wndProc = methodBody(
    dashboard,
    "private nint DashboardWndProc\\(nint hwnd, int msg, nint wParam, nint lParam, ref bool handled\\)",
  );
  assert.ok(wndProc, "DashboardWndProc must exist");
  assert.match(wndProc, /msg == WM_GETMINMAXINFO/);
  assert.match(wndProc, /ApplyMaximizedWorkArea\(\s*hwnd,\s*lParam\s*\)/);

  const minMaxBranch = wndProc.match(
    /if \(msg == WM_GETMINMAXINFO\)\s*\{([\s\S]*?)\}/,
  );
  assert.ok(minMaxBranch, "WM_GETMINMAXINFO must have its own branch");
  assert.doesNotMatch(
    minMaxBranch[1],
    /handled\s*=\s*true/,
    "leave WM_GETMINMAXINFO unhandled so WPF can still apply MinWidth/MinHeight",
  );

  // The existing tilt-wheel hook must stay in the same procedure.
  assert.match(wndProc, /msg != WM_MOUSEHWHEEL/);
});

test("maximize uses the current monitor's rcWork, not fullscreen rcMonitor", () => {
  const apply = methodBody(
    dashboard,
    "private static void ApplyMaximizedWorkArea\\(nint hwnd, nint lParam\\)",
  );
  assert.ok(apply, "ApplyMaximizedWorkArea must exist");
  assert.match(apply, /MonitorFromWindow\(\s*hwnd,\s*MONITOR_DEFAULTTONEAREST\s*\)/);
  assert.match(apply, /GetMonitorInfo\(/);
  assert.match(apply, /info\.rcWork/);
  assert.match(apply, /info\.rcMonitor/);
  assert.match(apply, /MaximizedWorkArea\.TryCompute\(/);
  assert.doesNotMatch(
    apply,
    /SystemParameters\.WorkArea/,
    "maximize must not use the primary-only SystemParameters.WorkArea",
  );

  // Size comes from the work area; rcMonitor is only the origin for ptMaxPosition.
  const compute = methodBody(
    helper,
    "public static bool TryCompute\\(ScreenRect work, ScreenRect monitor, out Placement placement\\)",
  );
  assert.ok(compute, "MaximizedWorkArea.TryCompute must exist");
  assert.match(compute, /work\.Width/);
  assert.match(compute, /work\.Height/);
  assert.match(compute, /work\.Left - monitor\.Left/);
  assert.match(compute, /work\.Top - monitor\.Top/);
  assert.doesNotMatch(
    compute,
    /monitor\.Width|monitor\.Height|monitor\.Right - monitor\.Left|monitor\.Bottom - monitor\.Top/,
    "placement size must come from rcWork, not rcMonitor",
  );
});

test("dashboard hook is installed once the HWND exists", () => {
  const initialized = methodBody(
    dashboard,
    "protected override void OnSourceInitialized\\(EventArgs e\\)",
  );
  assert.ok(initialized, "OnSourceInitialized must exist");
  assert.match(
    initialized,
    /HwndSource\.FromHwnd\(_hwnd\)\?\.AddHook\(DashboardWndProc\)/,
  );
});
