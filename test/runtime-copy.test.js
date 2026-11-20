const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { copyRuntimeTree, ensureRuntimeDirectory } = require("../src/lib/runtime-copy");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-runtime-copy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const from = path.join(root, "source");
  const to = path.join(root, "installed");
  await fs.mkdir(path.join(from, "src"), { recursive: true });
  await fs.writeFile(path.join(from, "package.json"), '{"version":"1.0.0"}');
  await fs.writeFile(path.join(from, "src", "cli.js"), "module.exports = 1;");
  return { root, from, to };
}

test("unchanged runtime refresh does not rewrite installed files", async (t) => {
  const { from, to } = await fixture(t);
  await copyRuntimeTree(from, to);
  const file = path.join(to, "src", "cli.js");
  await fs.utimes(file, new Date(1000), new Date(1000));
  const before = await fs.stat(file);
  await copyRuntimeTree(from, to);
  const after = await fs.stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
  assert.equal(await fs.readFile(file, "utf8"), "module.exports = 1;");
});

test("refresh repairs missing/corrupt files and same-version, same-size edits", async (t) => {
  const { from, to } = await fixture(t);
  await copyRuntimeTree(from, to);
  const changed = path.join(from, "src", "cli.js");
  const stamp = await fs.stat(changed);
  await fs.writeFile(changed, "module.exports = 2;");
  await fs.utimes(changed, stamp.atime, stamp.mtime);
  await fs.unlink(path.join(to, "package.json"));
  await fs.writeFile(path.join(to, "obsolete.js"), "old");
  await fs.mkdir(path.join(to, "obsolete-dir"));
  await fs.writeFile(path.join(to, "obsolete-dir", "old.js"), "old");
  await copyRuntimeTree(from, to);
  assert.equal(await fs.readFile(path.join(to, "src", "cli.js"), "utf8"), "module.exports = 2;");
  assert.deepEqual(await fs.readdir(to), ["package.json", "src"]);
  assert.equal(JSON.parse(await fs.readFile(path.join(to, "package.json"))).version, "1.0.0");
  await fs.writeFile(path.join(to, "src", "cli.js"), "module.exports = 9;");
  await copyRuntimeTree(from, to);
  assert.equal(await fs.readFile(path.join(to, "src", "cli.js"), "utf8"), "module.exports = 2;");
});

test("refresh handles files becoming directories and directories becoming files", async (t) => {
  const { from, to } = await fixture(t);
  await fs.mkdir(to);
  await fs.writeFile(path.join(to, "src"), "was a file");
  await fs.mkdir(path.join(to, "package.json"));
  await copyRuntimeTree(from, to);
  assert.equal((await fs.stat(path.join(to, "src"))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(to, "package.json"))).isFile(), true);
});

test("refresh replaces destination directory links without modifying their target", async (t) => {
  const { root, from, to } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep.txt"), "untouched");
  await fs.mkdir(to);
  await fs.symlink(outside, path.join(to, "src"), process.platform === "win32" ? "junction" : "dir");
  await copyRuntimeTree(from, to);
  assert.deepEqual(await fs.readdir(outside), ["keep.txt"]);
  assert.equal((await fs.lstat(path.join(to, "src"))).isSymbolicLink(), false);
});

test("runtime parent preparation replaces junctions without modifying external files", async (t) => {
  const { root, to } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep.txt"), "untouched");
  await fs.symlink(outside, to, process.platform === "win32" ? "junction" : "dir");
  await ensureRuntimeDirectory(to);
  assert.deepEqual(await fs.readdir(outside), ["keep.txt"]);
  assert.deepEqual(await fs.readdir(to), []);
  assert.equal((await fs.lstat(to)).isSymbolicLink(), false);
});

test("refresh preserves runtime dependency symlinks", async (t) => {
  const { from, to } = await fixture(t);
  try {
    await fs.symlink("cli.js", path.join(from, "src", "linked.js"));
  } catch (error) {
    if (error.code === "EPERM") return t.skip("file symlinks require Windows developer mode");
    throw error;
  }
  await copyRuntimeTree(from, to);
  await copyRuntimeTree(from, to);
  assert.equal((await fs.lstat(path.join(to, "src", "linked.js"))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(to, "src", "linked.js"), "utf8"), "module.exports = 1;");
});
