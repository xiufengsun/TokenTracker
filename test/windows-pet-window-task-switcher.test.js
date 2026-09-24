const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "TokenTrackerWin", "PetWindow.cs"),
  "utf8",
);

// #680: ShowInTaskbar = false only removes the taskbar button. Alt+Tab and
// Win+Tab list every top-level window unless it carries WS_EX_TOOLWINDOW, so
// the pet must apply that style on its HWND before it is first shown.
test("Windows pet window hides itself from Alt+Tab / Win+Tab via WS_EX_TOOLWINDOW", () => {
  assert.match(source, /private const long WS_EX_TOOLWINDOW = 0x00000080L;/);
  const onSourceInitialized = source.match(
    /protected override void OnSourceInitialized\(EventArgs e\)\s*\{([\s\S]*?)\n    \}/,
  );
  assert.ok(onSourceInitialized, "OnSourceInitialized must exist");
  assert.match(
    onSourceInitialized[1],
    /SetWindowExStyle\(_hwnd,\s*\(nint\)\(GetWindowExStyle\(_hwnd\)\.ToInt64\(\)\s*\|\s*WS_EX_TOOLWINDOW\)\);/,
    "the tool-window style must be applied to the pet HWND as soon as it exists",
  );
});
