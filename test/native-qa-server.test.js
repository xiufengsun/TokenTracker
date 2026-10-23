"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
// Windows CI copies production node_modules into the smoke fixture and can
// exceed the old 30s spawnSync budget under load. Keep spawnSync under the
// Windows CLI --test-timeout=120000 so Node 22 file-level caps still fit.
test("native QA server enforces isolated local HTTP, actor aliases and core file/process/network fences", { timeout: 120_000 }, () => {
  const child = spawnSync(process.execPath, [path.join(__dirname, "fixtures/native-qa-server-smoke.cjs")], {
    cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 90_000
  });
  assert.equal(
    child.status,
    0,
    [
      `status=${child.status}`,
      `signal=${child.signal}`,
      `error=${child.error && child.error.message}`,
      `stderr=${child.stderr || ""}`,
      `stdout=${child.stdout || ""}`,
    ].join("\n"),
  );
  const proof = JSON.parse(child.stdout.trim());
  assert.equal(proof.guiLaunched, false); assert.equal(proof.bodyReadFromOriginalCore, true);
  assert.equal(proof.remoteRequests, "fixture-only"); assert.equal(proof.personalFileReads, 0);
  assert.ok(proof.counters.blockedFileAccess > 0); assert.ok(proof.counters.blockedProcessLaunch > 0);
  assert.ok(proof.counters.blockedNetwork > 0);
  for (const directory of proof.cleanup) {
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(directory), /^(native-qa-core-fixture-|tokentracker-native-qa-)/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
