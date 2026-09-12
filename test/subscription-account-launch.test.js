const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { launchInTerminal, terminalScript, terminalEnvironment } = require("../src/lib/subscription-account-launch");
const { createAccount, bindIdentity, updateAccount } = require("../src/lib/subscription-accounts");

async function fixture(t) {
  const trackerDir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-launch-"));
  t.after(() => fs.rm(trackerDir, { recursive: true, force: true }));
  const account = await createAccount({ trackerDir, provider: "codex", label: "Work" });
  await bindIdentity({ trackerDir, id: account.id, identity: { key: "fixture-account" } });
  return { trackerDir, id: account.id, cwd: trackerDir };
}

test("button launch opens a private fixed-command script, with correct store and account", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await launchInTerminal({ ...f, platform: "darwin", runFile: async (command, args, options) => {
    calls++; assert.equal(command, "/usr/bin/open"); assert.deepEqual(args.slice(0, 3), ["-n", "-a", "Terminal"]);
    assert.equal(options.env.npm_config_prefix, undefined);
    const script = await fs.readFile(args[3], "utf8");
    assert.ok(script.includes(`'run' '${f.id}'`)); assert.ok(script.includes(`'--store' '${f.trackerDir}'`));
    assert.equal((await fs.stat(args[3])).mode & 0o777, 0o700);
  } });
  assert.equal(result.status, "dispatched"); assert.equal(calls, 1);
  await launchInTerminal({ ...f, provider: "codex", auto: true, platform: "darwin", probe: async () => ({ state: "available" }), runFile: async (_command, args) => {
    assert.ok((await fs.readFile(args[3], "utf8")).includes("'auto' 'codex'"));
  } });
});

test("rotation with unknown quota is reported to the UI before any terminal is opened", async (t) => {
  const f = await fixture(t);
  const result = await launchInTerminal({ ...f, provider: "codex", auto: true,
    probe: async () => ({ state: "unknown", reason: "credentials_unavailable" }),
    runFile: async () => assert.fail("Do not open an immediately failing terminal") });
  assert.deepEqual(result, { status: "blocked", issues: [{ id: f.id, reason: "credentials_unavailable" }] });
  await assert.rejects(fs.access(path.join(f.trackerDir, "subscription-accounts", "launches")));
});

test("terminal startup removes npm prefixes without changing the parent environment", () => {
  const inherited = { PATH: "/usr/bin", npm_config_prefix: "/dashboard", NPM_CONFIG_PREFIX: "/other", npm_lifecycle_event: "dev", INIT_CWD: "/project", HOME: "/user" };
  assert.deepEqual(terminalEnvironment(inherited), { PATH: "/usr/bin", HOME: "/user" });
  assert.equal(inherited.npm_config_prefix, "/dashboard");
});

test("launch validates account state, provider, project directory and cleans failed launch scripts", async (t) => {
  const f = await fixture(t);
  const runFile = async () => assert.fail("must not open terminal");
  await assert.rejects(launchInTerminal({ ...f, id: "../escape", runFile }));
  await assert.rejects(launchInTerminal({ ...f, cwd: "relative", runFile }));
  await assert.rejects(launchInTerminal({ ...f, cwd: f.cwd + "\ncommand", runFile }));
  await assert.rejects(launchInTerminal({ ...f, provider: "other", auto: true, runFile }));
  await assert.rejects(launchInTerminal({ ...f, auto: "yes", runFile }));
  await assert.rejects(launchInTerminal({ ...f, platform: "darwin", runFile: async () => { throw new Error("unavailable"); } }));
  assert.deepEqual(await fs.readdir(path.join(f.trackerDir, "subscription-accounts", "launches")), []);
  await updateAccount({ ...f, archived: true });
  await assert.rejects(launchInTerminal({ ...f, runFile }));
});

test("POSIX script preserves literal shell characters in paths without running substitutions", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell");
  const f = await fixture(t);
  const cwd = path.join(f.trackerDir, "project ' $(touch INJECTED)");
  await fs.mkdir(cwd);
  const file = path.join(f.trackerDir, "fixture.command");
  await fs.writeFile(file, terminalScript({ ...f, cwd, platform: "darwin", args: ["help"] }));
  const { stdout } = await promisify(execFile)("/bin/sh", [file], { cwd: f.trackerDir, timeout: 10000 });
  assert.match(stdout, /accounts add/);
  await assert.rejects(fs.access(path.join(f.trackerDir, "INJECTED")));
  await assert.rejects(fs.access(file));
});

test("Linux launch detaches rather than timing out the interactive session", async (t) => {
  const f = await fixture(t);
  let detached = false;
  await launchInTerminal({ ...f, platform: "linux", spawnImpl: (command, args, options) => {
    assert.equal(command, "x-terminal-emulator"); assert.deepEqual(args.slice(0, 2), ["-e", "/bin/sh"]);
    assert.equal(options.shell, false); assert.equal(options.detached, true);
    const child = new EventEmitter(); child.unref = () => { detached = true; }; queueMicrotask(() => child.emit("spawn")); return child;
  } });
  assert.ok(detached);
});
