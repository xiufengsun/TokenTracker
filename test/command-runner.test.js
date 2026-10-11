"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { runCommand } = require("../src/lib/command-runner");

test("runCommand handles a stdin pipe failure without an unhandled error", async (t) => {
  const child = new EventEmitter();
  let killed = false;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = new EventEmitter();
  child.stdin.end = () => queueMicrotask(() => {
    child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  });
  child.kill = () => { killed = true; return true; };
  t.mock.method(cp, "spawn", () => child);
  const result = await runCommand(null, "fixture-command", [], { input: "fixture", timeout: 1000 });
  assert.equal(result.error.code, "EPIPE");
  assert.equal(result.status, null);
  assert.equal(killed, true);
});

// These tests stub cp.spawn itself. Injecting a mock commandRunner cannot
// reach the real spawn branch: runCommand early-returns for function
// runners, so options assertions on a mock only prove what the *caller*
// passed — a regression that forces `shell: true` inside the runner (the
// DEP0190 class bug that once broke detectAntigravityProcess) would stay
// invisible. Asserting on the actual cp.spawn call closes that gap.
function stubSpawn() {
  const calls = [];
  const original = cp.spawn;
  cp.spawn = (command, args, options) => {
    calls.push({ command, args, options: { ...options } });
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  return { calls, restore: () => { cp.spawn = original; } };
}

test("runCommand spawns directly by default — no shell, even on Windows", async () => {
  const { calls, restore } = stubSpawn();
  try {
    const args = ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance | ConvertTo-Json"];
    const result = await runCommand(undefined, "powershell.exe", args, { platform: "win32", timeout: 1000 });
    assert.equal(result.status, 0);

    assert.equal(calls.length, 1);
    // The previous regression forced shell execution on win32 inside the
    // runner, which let cmd.exe split the script at `|`. Direct spawn is
    // the contract for every call site that did not opt into useShell.
    assert.equal(calls[0].options.shell, false);
    assert.deepEqual(calls[0].args, args);
    assert.equal(calls[0].command, "powershell.exe");
  } finally {
    restore();
  }
});

test("runCommand quotes the command unconditionally under useShell", async () => {
  const { calls, restore } = stubSpawn();
  try {
    // No whitespace, but `&` is a cmd.exe metacharacter — Windows account
    // names may contain it, and the npm global prefix lives under the
    // user directory. Space-only quoting would leave this path unquoted
    // and cmd.exe would split it at `&`.
    const command = "C:\\Users\\a&b\\AppData\\Roaming\\npm\\arkcli.cmd";
    const result = await runCommand(undefined, command, ["usage", "plan"], {
      platform: "win32",
      useShell: true,
      timeout: 1000,
    });
    assert.equal(result.status, 0);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.shell, true);
    assert.equal(calls[0].command, `"${command}"`);
  } finally {
    restore();
  }
});

test("runCommand leaves the command untouched without useShell", async () => {
  const { calls, restore } = stubSpawn();
  try {
    const command = "C:\\Program Files\\ark cli\\arkcli.cmd";
    await runCommand(undefined, command, ["usage"], { platform: "win32", timeout: 1000 });
    assert.equal(calls[0].command, command);
    assert.equal(calls[0].options.shell, false);
  } finally {
    restore();
  }
});

test("Windows .cmd path with cmd metacharacters survives both spawn modes", async () => {
  // A realistic npm-global install under a Windows account whose name
  // contains `&`: no whitespace, but cmd.exe would split the line at the
  // `&` when the path is handed to a shell unquoted.
  const command = "C:\\Users\\a&b\\AppData\\Roaming\\npm\\arkcli.cmd";
  const args = ["usage", "plan", "--format", "json"];

  const { calls, restore } = stubSpawn();
  try {
    // Shell mode: the whole path must be wrapped in quotes so the joined
    // command line keeps `&` inside a single token.
    await runCommand(undefined, command, args, { platform: "win32", useShell: true, timeout: 1000 });
    assert.equal(calls[0].options.shell, true);
    assert.equal(calls[0].command, `"${command}"`);
    const joinedShell = [calls[0].command, ...calls[0].args].join(" ");
    assert.ok(/^"[^"]*&[^"]*"/.test(joinedShell), "metacharacter must stay inside quotes");

    // Default mode: direct spawn — args array passed through verbatim,
    // no shell to re-parse the line, nothing quoted or split.
    await runCommand(undefined, command, args, { platform: "win32", timeout: 1000 });
    assert.equal(calls[1].options.shell, false);
    assert.equal(calls[1].command, command);
    assert.deepEqual(calls[1].args, args);
  } finally {
    restore();
  }
});
