const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const script = path.join(__dirname, "../TokenTrackerBar/scripts/dev-cleanup.sh");
const source = fs.readFileSync(script, "utf8");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-dev-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.jsonl");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home);
  const widget = path.join(home, "Library/Containers/com.tokentracker.bar.dev.widget");
  const product = path.join(home, "Library/Developer/Xcode/DerivedData/TokenTrackerBar-fixture/Build/Products/Debug/TokenTracker Dev.app");
  const production = path.join(home, "Library/Containers/com.tokentracker.bar.widget");
  const shared = path.join(home, ".tokentracker");
  for (const directory of [widget, product, production, shared]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "keep"), "sentinel");
  }
  // All destructive/platform commands are intercepted. The rm stub refuses
  // every path outside this fixture's temporary home, including real user data.
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const input = command === 'osascript' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({command, args, input}) + '\\n');
if (command === 'osascript' && process.env.FAIL_QUIT) process.exit(1);
if (command === 'rm') for (const arg of args.filter(a => !a.startsWith('-'))) {
  if (!path.resolve(arg).startsWith(process.env.HOME + path.sep)) throw Error('Unsafe removal: ' + arg);
  if (process.env.FAIL_WIDGET && arg.endsWith('com.tokentracker.bar.dev.widget')) process.exit(1);
  if (process.env.FAIL_PRODUCT === arg) process.exit(1);
  fs.rmSync(arg, {recursive: args.includes('-rf'), force: true});
}
`;
  for (const command of ["osascript", "defaults", "rm", "pkill", "sleep"]) {
    fs.writeFileSync(path.join(bin, command), stub, { mode: 0o755 });
  }
  return {
    home, widget, product, production, shared,
    run(extra = {}) {
      return spawnSync("/bin/bash", [script], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FIXTURE_LOG: log, ...extra },
        encoding: "utf8", timeout: 20_000,
      });
    },
    commands: () => fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
  };
}

test("Dev cleanup requests graceful termination before deleting and removes the widget container", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const commands = f.commands();
  assert.equal(commands[0].command, "osascript");
  assert.ok(commands[0].input.includes('com.tokentracker.bar.dev'));
  assert.equal(commands.some(c => c.command === "pkill"), false);
  assert.equal(fs.existsSync(f.widget), false);
  assert.equal(fs.existsSync(f.product), false);
  assert.equal(fs.readFileSync(path.join(f.production, "keep"), "utf8"), "sentinel");
  assert.equal(fs.readFileSync(path.join(f.shared, "keep"), "utf8"), "sentinel");
  assert.equal(f.run().status, 0, "cleanup remains idempotent when the paths are absent");
});

test("Dev cleanup aborts without deletion when graceful termination fails", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const result = f.run({ FAIL_QUIT: "1" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.commands().map(c => c.command), ["osascript"]);
  assert.equal(fs.existsSync(f.widget), true);
  assert.equal(fs.existsSync(f.product), true);
});

test("Dev widget container deletion failures produce a nonzero exit", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const result = f.run({ FAIL_WIDGET: "1" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(f.widget));
  assert.equal(fs.existsSync(f.widget), true);
});

for (const suffix of ["aaa-failed", "zzz-failed"]) {
  test(`Dev product deletion failure wins over success (${suffix})`, { skip: process.platform === "win32" }, t => {
    const f = fixture(t);
    const failedProduct = f.product.replace("TokenTrackerBar-fixture", `TokenTrackerBar-${suffix}`);
    fs.mkdirSync(failedProduct, { recursive: true });
    const result = f.run({ FAIL_PRODUCT: failedProduct });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Debug 产物删除失败/);
    assert.doesNotMatch(result.stdout, /Debug 产物已删除/);
    assert.equal(fs.existsSync(failedProduct), true);
    assert.equal(fs.existsSync(f.product), false);
  });
}

function runQuit(apps, delay = () => {}) {
  const match = source.match(/<<'JXA'\n([\s\S]*?)\nJXA/);
  assert.ok(match, "graceful quit must use a guarded AppKit request, without launching the app");
  vm.runInNewContext(match[1], {
    ObjC: { import() {} }, delay,
    $: { NSRunningApplication: {
      runningApplicationsWithBundleIdentifier(id) {
        assert.equal(id, "com.tokentracker.bar.dev");
        return { count: apps.length, objectAtIndex: i => apps[i] };
      },
    } },
  });
}

test("Dev quit handles no running app, waits for accepted termination, and rejects failure or timeout", () => {
  runQuit([]);
  let quit = false;
  let waits = 0;
  const app = { terminated: false, get terminate() { quit = true; return true; } };
  runQuit([app], () => { waits++; app.terminated = true; });
  assert.equal(quit, true);
  assert.equal(waits, 1);
  assert.throws(() => runQuit([{ terminated: false, terminate: false }]), /quit|退出/);
  let timeoutWaits = 0;
  assert.throws(() => runQuit([{ terminated: false, terminate: true }], () => timeoutWaits++), /timeout|超时/);
  assert.equal(timeoutWaits, 100, "quit must have a bounded ten-second wait");
});
