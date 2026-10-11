const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { buildHookCommand, upsertClaudeUsageHooks, areClaudeUsageHooksConfigured } = require("../src/lib/claude-config");
const { buildGeminiHookCommand } = require("../src/lib/gemini-config");

test("Windows notify commands quote PowerShell literals and repair duplicate legacy hooks", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-windows-hooks-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const notify = "C:\\Users\\O'Brien $user\\notify.cjs";
  const options = { platform: "win32", execPath: "E:\\Token Tracker\\node.exe" };
  const command = buildHookCommand(notify, "claude", options);
  assert.equal(command, "& 'E:\\Token Tracker\\node.exe' 'C:\\Users\\O''Brien $user\\notify.cjs' --source=claude");
  assert.equal(buildGeminiHookCommand(notify, options), command.replace("--source=claude", "--source=gemini"));
  const legacy = buildHookCommand(notify, "claude", { platform: "linux" });
  const settingsPath = path.join(dir, "settings.json");
  const old = '"E:\\\\Token Tracker\\\\node.exe" "C:\\\\Users\\\\O\'Brien $user\\\\notify.cjs" --source=claude';
  const unrelated = { type: "command", command: 'node "C:\\other\\notify.cjs" --source=claude' };
  await fs.writeFile(settingsPath, JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: legacy }, unrelated] }, { matcher: "*", hooks: [{ type: "command", command: old }] },
      { matcher: "ignored-by-stop", hooks: [{ type: "command", command }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: old, args: [], shell: "bash" }] }, { matcher: "*", hooks: [{ type: "command", command: old }] }],
  } }));
  assert.equal(await areClaudeUsageHooksConfigured({ settingsPath, hookCommand: command }), false);
  assert.equal((await upsertClaudeUsageHooks({ settingsPath, hookCommand: command })).changed, true);
  const settings = JSON.parse(await fs.readFile(settingsPath));
  assert.deepEqual(settings.hooks.Stop.flatMap(e => e.hooks), [{ type: "command", command, shell: "powershell" }, unrelated]);
  assert.deepEqual(settings.hooks.SessionEnd.flatMap(e => e.hooks), [{ type: "command", command, shell: "powershell" }]);
  assert.equal(await areClaudeUsageHooksConfigured({ settingsPath, hookCommand: command }), true);
  assert.equal((await upsertClaudeUsageHooks({ settingsPath, hookCommand: command })).changed, false);
});

test("Windows PowerShell actually launches notify with a space, apostrophe and dollar in its path", { skip: process.platform !== "win32" }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt O'Brien $hook-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "notify.cjs");
  await fs.writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  for (const source of ["claude", "codebuddy", "workbuddy", "gemini"]) {
    const command = buildHookCommand(script, source);
    const output = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true });
    assert.deepEqual(JSON.parse(output), [`--source=${source}`]);
  }
});
