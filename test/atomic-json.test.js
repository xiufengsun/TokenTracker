const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { writeJsonAtomicSync } = require("../src/lib/atomic-json");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-atomic-json-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "config.json") };
}

test("atomic JSON writes replace complete documents without leaving temporary files", t => {
  const { dir, file } = fixture(t);
  writeJsonAtomicSync(file, { original: true });
  writeJsonAtomicSync(file, { next: "中文" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { next: "中文" });
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("atomic JSON writes replace a swapped link without modifying the linked file", t => {
  const { dir, file } = fixture(t);
  const other = path.join(dir, "other.json");
  fs.writeFileSync(other, "preserve this file");
  try { fs.symlinkSync(other, file, "file"); }
  catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("File symlink creation requires Windows privileges; CI runs this case");
      return;
    }
    throw error;
  }
  writeJsonAtomicSync(file, { current: true });
  assert.equal(fs.readFileSync(other, "utf8"), "preserve this file");
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { current: true });
});

test("atomic JSON writes keep the previous document and clean their own temporary file on failure", t => {
  const { dir, file } = fixture(t);
  fs.writeFileSync(file, "previous document");
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("fixture rename denied"), { code: "EACCES" }); };
  try { assert.throws(() => writeJsonAtomicSync(file, { next: true }), /fixture rename denied/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, "utf8"), "previous document");
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("a pre-existing temporary path is neither followed nor removed", t => {
  const { dir, file } = fixture(t);
  const uuid = crypto.randomUUID;
  const tmp = `${file}.tmp.fixture-collision`;
  fs.writeFileSync(file, "previous document");
  fs.writeFileSync(tmp, "preserve this existing file");
  crypto.randomUUID = () => "fixture-collision";
  try { assert.throws(() => writeJsonAtomicSync(file, { next: true }), { code: "EEXIST" }); }
  finally { crypto.randomUUID = uuid; }
  assert.equal(fs.readFileSync(tmp, "utf8"), "preserve this existing file");
  assert.equal(fs.readFileSync(file, "utf8"), "previous document");
  assert.equal(fs.readdirSync(dir).length, 2);
});
