const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const gifts = require("../scripts/pro-gift-codes.cjs");
const posixOnly = { skip: process.platform === "win32" && "Windows project-file credentials remain closed pending NTFS ACL verification" };

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-gift-private-read-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "project.json");
  await fs.writeFile(file, JSON.stringify({ oss_host: "https://backend.example", api_key: "fixture-original-server-key" }), { mode: 0o600 });
  return { dir, file };
}

test("gift project credentials reject public files, links, directories and oversized contents", posixOnly, async t => {
  const { dir, file } = await fixture(t);
  await fs.chmod(file, 0o644);
  await assert.rejects(gifts.connection({ "project-file": file }, {}), /private/);
  await fs.chmod(file, 0o600);
  const link = path.join(dir, "link.json");
  await fs.symlink(file, link);
  await assert.rejects(gifts.connection({ "project-file": link }, {}));
  await assert.rejects(gifts.connection({ "project-file": dir }, {}), /private/);
  await fs.writeFile(file, "x".repeat(65537));
  await assert.rejects(gifts.connection({ "project-file": file }, {}), /private/);
});

test("gift project credentials read the checked descriptor even if its path is replaced", posixOnly, async t => {
  const { dir, file } = await fixture(t);
  const open = fs.open;
  const lstat = fs.lstat;
  let replaced = false;
  async function replaceAfterCheck(info) {
    if (!replaced) {
      replaced = true;
      await fs.rename(file, path.join(dir, "checked-project.json"));
      await fs.writeFile(file, JSON.stringify({ oss_host: "https://replacement.example", api_key: "fixture-replacement-key" }), { mode: 0o600 });
    }
    return info;
  }
  fs.lstat = async (target, ...args) => {
    const info = await lstat(target, ...args);
    return target === file ? replaceAfterCheck(info) : info;
  };
  fs.open = async (target, ...args) => {
    const handle = await open(target, ...args);
    if (target === file) {
      const stat = handle.stat.bind(handle);
      handle.stat = async (...statArgs) => replaceAfterCheck(await stat(...statArgs));
    }
    return handle;
  };
  try {
    assert.deepEqual(await gifts.connection({ "project-file": file }, {}), {
      baseUrl: "https://backend.example", key: "fixture-original-server-key",
    });
    assert.equal(replaced, true);
  } finally { fs.open = open; fs.lstat = lstat; }
});

test("gift project reads remain bounded when the opened file grows after its size check", posixOnly, async t => {
  const { file } = await fixture(t);
  const open = fs.open;
  let closed = false;
  fs.open = async (...args) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    const close = handle.close.bind(handle);
    handle.stat = async () => {
      const info = await stat();
      await fs.appendFile(file, "x".repeat(65537));
      return info;
    };
    handle.close = async () => { closed = true; await close(); };
    return handle;
  };
  try {
    await assert.rejects(gifts.connection({ "project-file": file }, {}), /private/);
    assert.equal(closed, true);
  } finally { fs.open = open; }
});
