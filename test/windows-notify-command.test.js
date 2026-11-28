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

test("Windows notify commands use a cross-shell form when paths have no shell metacharacters", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-windows-portable-hooks-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const notify = "C:\\Program Files\\TokenTracker\\notify.cjs";
  const options = { platform: "win32", execPath: "E:\\Token Tracker\\node.exe" };
  const command = buildHookCommand(notify, "claude", options);
  // execPath has a space and may not be on PATH (bundled desktop Node). Wrap
  // the real executable in unquoted powershell.exe so bash/cmd/PowerShell can
  // all launch it without a leading `&`.
  assert.equal(command, `powershell.exe -NoProfile -Command "& 'E:/Token Tracker/node.exe' 'C:/Program Files/TokenTracker/notify.cjs' --source=claude"`);
  const safeExec = buildHookCommand(notify, "claude", { platform: "win32", execPath: "C:\\nodejs\\node.exe" });
  assert.equal(safeExec, 'C:/nodejs/node.exe "C:/Program Files/TokenTracker/notify.cjs" --source=claude');
  assert.equal(buildGeminiHookCommand(notify, options), command.replace("--source=claude", "--source=gemini"));
  assert.equal(command.startsWith("& '"), false);

  const settingsPath = path.join(dir, "settings.json");
  const legacyPs = "& 'E:\\Token Tracker\\node.exe' 'C:\\Program Files\\TokenTracker\\notify.cjs' --source=claude";
  await fs.writeFile(settingsPath, JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: legacyPs, shell: "powershell" }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: legacyPs, shell: "powershell" }] }],
  } }));
  assert.equal(await areClaudeUsageHooksConfigured({ settingsPath, hookCommand: command }), false);
  assert.equal((await upsertClaudeUsageHooks({ settingsPath, hookCommand: command })).changed, true);
  const settings = JSON.parse(await fs.readFile(settingsPath));
  assert.deepEqual(settings.hooks.Stop.flatMap(e => e.hooks), [{ type: "command", command }]);
  assert.deepEqual(settings.hooks.SessionEnd.flatMap(e => e.hooks), [{ type: "command", command }]);
  assert.equal(await areClaudeUsageHooksConfigured({ settingsPath, hookCommand: command }), true);
  assert.equal((await upsertClaudeUsageHooks({ settingsPath, hookCommand: command })).changed, false);
});

test("Windows notify commands keep a spaced bundled Node executable instead of PATH node", () => {
  const notify = "C:\\Users\\Jane Doe\\.tokentracker\\bin\\notify.cjs";
  const embedded = "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\TokenTracker\\EmbeddedServer\\node.exe";
  const command = buildHookCommand(notify, "claude", { platform: "win32", execPath: embedded });
  assert.equal(
    command,
    `powershell.exe -NoProfile -Command "& 'C:/Users/Jane Doe/AppData/Local/Programs/TokenTracker/EmbeddedServer/node.exe' 'C:/Users/Jane Doe/.tokentracker/bin/notify.cjs' --source=claude"`,
  );
  assert.equal(command.startsWith("& '"), false);
  assert.match(command, /EmbeddedServer\/node\.exe/);
  assert.doesNotMatch(command, /(?:^|\s)node(?:\s|$)/);
});



test("Windows notify commands treat 8.3 short-name tildes as portable", () => {
  const notify = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\tt Jane Doe hook\\notify.cjs";
  const embedded = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\tt Jane Doe hook\\EmbeddedServer\\node.exe";
  const command = buildHookCommand(notify, "claude", { platform: "win32", execPath: embedded });
  assert.equal(
    command,
    `powershell.exe -NoProfile -Command "& 'C:/Users/RUNNER~1/AppData/Local/Temp/tt Jane Doe hook/EmbeddedServer/node.exe' 'C:/Users/RUNNER~1/AppData/Local/Temp/tt Jane Doe hook/notify.cjs' --source=claude"`,
  );
  const safeExec = buildHookCommand(notify, "claude", {
    platform: "win32",
    execPath: "C:\\Users\\RUNNER~1\\nodejs\\node.exe",
  });
  assert.equal(safeExec, 'C:/Users/RUNNER~1/nodejs/node.exe "C:/Users/RUNNER~1/AppData/Local/Temp/tt Jane Doe hook/notify.cjs" --source=claude');
});

test("Windows hook repair does not treat a notify command with trailing actions as the same hook", async (t) => {
  const { notifyIdentity } = require("../src/lib/notify-command");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-windows-hook-trail-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const notify = "C:\\Program Files\\TokenTracker\\notify.cjs";
  const options = { platform: "win32", execPath: "E:\\Token Tracker\\node.exe" };
  const command = buildHookCommand(notify, "claude", options);
  const withExtra = `${command} && echo KEEP_THIS`;
  assert.ok(notifyIdentity(command));
  assert.equal(notifyIdentity(withExtra), null);

  const settingsPath = path.join(dir, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: withExtra }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: withExtra }] }],
  } }));
  assert.equal(await areClaudeUsageHooksConfigured({ settingsPath, hookCommand: command }), false);
  assert.equal((await upsertClaudeUsageHooks({ settingsPath, hookCommand: command })).changed, true);
  const settings = JSON.parse(await fs.readFile(settingsPath));
  const stopHooks = settings.hooks.Stop.flatMap((e) => e.hooks);
  const sessionHooks = settings.hooks.SessionEnd.flatMap((e) => e.hooks);
  assert.ok(stopHooks.some((hook) => hook.command === withExtra));
  assert.ok(stopHooks.some((hook) => hook.command === command));
  assert.ok(sessionHooks.some((hook) => hook.command === withExtra));
  assert.ok(sessionHooks.some((hook) => hook.command === command));
});

test("Windows hooks launch a spaced bundled Node when node is not on PATH", { skip: process.platform !== "win32" }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt Jane Doe hook-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const embedDir = path.join(dir, "TokenTracker", "EmbeddedServer");
  await fs.mkdir(embedDir, { recursive: true });
  const bundled = path.join(embedDir, "node.exe");
  await fs.copyFile(process.execPath, bundled);
  const script = path.join(dir, "notify.cjs");
  await fs.writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const command = buildHookCommand(script, "claude", { platform: "win32", execPath: bundled });
  assert.match(command, /^powershell\.exe -NoProfile -Command "/);
  const root = process.env.SystemRoot || "C:\\Windows";
  const system32 = path.join(root, "System32");
  const powershellHome = path.join(system32, "WindowsPowerShell", "v1.0");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = `${powershellHome}${path.delimiter}${system32}`;
  const output = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  assert.deepEqual(JSON.parse(output), ["--source=claude"]);
});
