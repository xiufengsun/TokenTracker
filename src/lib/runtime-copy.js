const fs = require("node:fs/promises");
const path = require("node:path");
const { writeFileAtomic } = require("./fs");

async function statIfPresent(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureRuntimeDirectory(dir) {
  const target = await statIfPresent(dir);
  if (target?.isDirectory() && !target.isSymbolicLink()) return;
  if (target) await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

// Runtime refreshes run on every desktop launch. Compare bytes instead of
// deleting the installation: identical versions, interrupted copies, and local
// builds with unchanged version numbers all behave correctly. Never follow a
// destination symlink when replacing files or pruning obsolete entries.
async function copyRuntimeTree(from, to) {
  const source = await fs.lstat(from);
  let target = await statIfPresent(to);
  if (source.isSymbolicLink()) {
    const link = await fs.readlink(from);
    const resolved = path.resolve(path.dirname(from), link);
    if (target?.isSymbolicLink()
        && path.resolve(path.dirname(to), await fs.readlink(to)) === resolved) return;
    if (target) await fs.rm(to, { recursive: true, force: true });
    await fs.mkdir(path.dirname(to), { recursive: true });
    // Keep fs.cp's existing default link semantics for npm/pnpm installations.
    await fs.cp(from, to);
    return;
  }

  if (target && (target.isSymbolicLink() || source.isDirectory() !== target.isDirectory())) {
    await fs.rm(to, { recursive: true, force: true });
    target = null;
  }
  if (source.isDirectory()) {
    if (!target) await fs.mkdir(to, { recursive: true });
    const names = await fs.readdir(from);
    const retained = new Set(names);
    for (const name of names) {
      await copyRuntimeTree(path.join(from, name), path.join(to, name));
    }
    for (const name of await fs.readdir(to)) {
      if (!retained.has(name)) {
        await fs.rm(path.join(to, name), { recursive: true, force: true });
      }
    }
    return;
  }

  if (!target) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    return;
  }
  const content = await fs.readFile(from);
  if (target?.isFile() && target.size === source.size
      && content.equals(await fs.readFile(to))) {
    if (process.platform !== "win32" && (source.mode & 0o777) !== (target.mode & 0o777)) {
      await fs.chmod(to, source.mode & 0o777);
    }
    return;
  }
  // Hooks may read the installed runtime while it is refreshed. Publish each
  // changed file atomically so they cannot read a truncated module.
  await writeFileAtomic(to, content, { mode: source.mode & 0o777 });
}

module.exports = { copyRuntimeTree, ensureRuntimeDirectory };
