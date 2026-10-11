const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { resolveOpenclawCommand, runOpenclawCli } = require("../src/lib/openclaw-cli");

async function fixture(t, metadata = { name: "openclaw", bin: { openclaw: "entry.cjs" } }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-openclaw-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, "npm & %TT_EXPAND% ! ^ (中文)");
  const packageDir = path.join(prefix, "node_modules", "openclaw");
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(prefix, "openclaw.cmd"), "@echo off\r\nexit /b 99\r\n");
  await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify(metadata));
  const entry = path.join(packageDir, "entry.cjs");
  await fs.writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  return { root, prefix, packageDir, entry };
}

test("OpenClaw Windows npm entry resolves from case-insensitive quoted PATH without a shell", async (t) => {
  const { prefix, entry } = await fixture(t);
  const resolved = resolveOpenclawCommand({ Path: `"${prefix}"` }, "win32");
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.prefixArgs, [await fs.realpath(entry)]);
});

test("OpenClaw Windows resolution preserves native executable and PATH precedence", async (t) => {
  const { root, prefix } = await fixture(t);
  const first = path.join(root, "native");
  await fs.mkdir(first);
  const executable = path.join(first, "openclaw.exe");
  await fs.writeFile(executable, "native executable lookup fixture");
  assert.deepEqual(resolveOpenclawCommand({ PATH: `${first};${prefix}` }, "win32"), {
    command: executable, prefixArgs: [],
  });
});

test("OpenClaw Windows npm resolution rejects wrong package and non-JS bin entries", async (t) => {
  for (const metadata of [
    { name: "other", bin: { openclaw: "entry.cjs" } },
    { name: "openclaw", bin: { openclaw: "entry.cmd" } },
    { name: "openclaw", bin: {} },
  ]) {
    const { prefix } = await fixture(t, metadata);
    assert.throws(() => resolveOpenclawCommand({ PATH: prefix }, "win32"), { code: "EINVAL" });
  }
});

test("OpenClaw Windows npm bin cannot escape its package", async (t) => {
  const { prefix } = await fixture(t, { name: "openclaw", bin: "../../outside.cjs" });
  await fs.writeFile(path.join(prefix, "outside.cjs"), "throw Error('must never run');");
  assert.throws(() => resolveOpenclawCommand({ PATH: prefix }, "win32"), { code: "EINVAL" });
});

test("OpenClaw Windows missing and unsupported shims fail without falling through to another installation", async (t) => {
  assert.throws(() => resolveOpenclawCommand({ PATH: "" }, "win32"), { code: "ENOENT" });
  const { root, prefix } = await fixture(t);
  const first = path.join(root, "custom-shim");
  await fs.mkdir(first);
  await fs.writeFile(path.join(first, "openclaw.cmd"), "@echo off\r\nexit /b 99\r\n");
  assert.throws(() => resolveOpenclawCommand({ PATH: `${first};${prefix}` }, "win32"), { code: "EINVAL" });
});

test("OpenClaw Windows npm execution preserves literal special characters in arguments", {
  skip: process.platform !== "win32" && "Requires a native Windows Node process",
}, async (t) => {
  const { prefix } = await fixture(t);
  const args = ["plugins", "install", "--link", "C:\\配置 & %TT_EXPAND% ! ^ (项目)\\one", 'literal "quote"', "a|b>c"];
  const result = runOpenclawCli(args, { ...process.env, PATH: prefix, TT_EXPAND: "unexpected expansion" });
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("OpenClaw process errors and signal termination cannot be mistaken for success", async (t) => {
  const { prefix } = await fixture(t);
  const outcomes = [
    { error: Object.assign(new Error("missing"), { code: "ENOENT" }), status: null },
    { error: Object.assign(new Error("invalid shim"), { code: "EINVAL" }), status: null },
    { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), status: null },
    { status: null, signal: "SIGTERM", stdout: "", stderr: "" },
    { status: 2, stdout: "", stderr: "bad config" },
    { status: 0, stdout: "installed", stderr: "" },
  ];
  const calls = [];
  t.mock.method(cp, "spawnSync", (command, args, options) => {
    calls.push({ command, args, options });
    return outcomes.shift();
  });
  const env = { PATH: prefix };
  assert.equal(runOpenclawCli(["plugins", "install"], env).skippedReason, "openclaw-cli-missing");
  assert.equal(runOpenclawCli(["plugins", "install"], env).skippedReason, "openclaw-cli-error");
  assert.equal(runOpenclawCli(["hooks", "install"], env).skippedReason, "openclaw-cli-error");
  assert.equal(runOpenclawCli(["hooks", "install"], env).skippedReason, "openclaw-hooks-install-failed");
  assert.equal(runOpenclawCli(["plugins", "install"], env).skippedReason, "openclaw-plugins-install-failed");
  assert.equal(runOpenclawCli(["plugins", "install"], env).code, 0);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(({ options }) => options.shell === false && options.windowsHide && options.timeout === 30_000));
  const skipped = runOpenclawCli(["hooks", "install"], { TOKENTRACKER_SKIP_OPENCLAW_CLI: "1" });
  assert.equal(skipped.skippedReason, "openclaw-cli-missing");
  assert.equal(calls.length, 6, "explicit skip must not start any process");
});
