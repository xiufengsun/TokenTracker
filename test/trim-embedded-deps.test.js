"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const initSqlJs = require("sql.js");

const { KEEP, trimEmbeddedDeps } = require("../scripts/trim-embedded-deps.cjs");

const ROOT = path.join(__dirname, "..");

function listFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), relative) : [relative];
  });
}

test("the trimmed wa-sqlite package still runs the TRAE SQLite reader", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nodeModules = path.join(dir, "node_modules");
  const packageDir = path.join(nodeModules, "@journeyapps", "wa-sqlite");
  fs.cpSync(path.join(ROOT, "node_modules", "@journeyapps", "wa-sqlite"), packageDir, { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"));
  fs.copyFileSync(path.join(ROOT, "src", "lib", "trae-sqlite.js"), path.join(dir, "lib", "trae-sqlite.js"));

  const removed = trimEmbeddedDeps(nodeModules);
  assert.ok(removed > 10 * 1024 * 1024, `removes the unused builds (${removed} bytes)`);
  assert.deepEqual(listFiles(packageDir).sort(), [...KEEP["@journeyapps/wa-sqlite"]].sort());

  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE chat_turn (id INTEGER); INSERT INTO chat_turn VALUES (7);");
  const bytes = Buffer.from(db.export());
  db.close();
  const snapshot = {
    byteLength: bytes.length,
    read(target, offset) {
      target.fill(0);
      const count = Math.max(0, Math.min(target.length, bytes.length - offset));
      bytes.copy(target, 0, offset, offset + count);
      return count;
    },
  };
  // Resolves @journeyapps/wa-sqlite from the trimmed copy, not the repo.
  const { withTraeSqlite } = require(path.join(dir, "lib", "trae-sqlite.js"));
  const rows = await withTraeSqlite(snapshot, (query) => query("SELECT id FROM chat_turn"));
  assert.deepEqual(rows, [{ id: 7 }]);
});

test("every desktop bundle step runs the dependency trim", () => {
  for (const script of [
    "TokenTrackerBar/scripts/bundle-node.sh",
    "TokenTrackerWin/scripts/bundle-node.ps1",
    "TokenTrackerLinux/scripts/bundle-node-linux.sh",
  ]) {
    const source = fs.readFileSync(path.join(ROOT, script), "utf8");
    assert.match(source, /trim-embedded-deps\.cjs/, script);
  }
});

test("the trim leaves packages npm did not install to npm", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(trimEmbeddedDeps(dir), 0, "an empty node_modules");
  assert.equal(trimEmbeddedDeps(path.join(dir, "missing")), 0, "no node_modules at all");
});

test("the trim refuses to ship a package missing a runtime file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packageDir = path.join(dir, "@journeyapps", "wa-sqlite");
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), "{}");
  assert.throws(() => trimEmbeddedDeps(dir), /missing dist\/wa-sqlite\.mjs/);
});
