const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

test("tracker serve binds before first-run init (#961)", () => {
  const source = fs
    .readFileSync(path.join(repoRoot, "src/commands/serve.js"), "utf8")
    .replace(/\r\n/g, "\n");

  const needsIdx = source.indexOf("const needsFirstRunSetup");
  const listenIdx = source.indexOf("port = await listenOnAvailablePort");
  const initAfterListenIdx = source.indexOf("First time? Setting up Token Tracker");
  assert.ok(needsIdx > 0, "needsFirstRunSetup flag must exist");
  assert.ok(listenIdx > needsIdx, "listener setup must follow the first-run flag");
  assert.ok(initAfterListenIdx > listenIdx, "first-run init must run after listenOnAvailablePort");

  // The pre-listen optional sync must skip when first-run setup is still owed,
  // otherwise we would block the bind the same way as before.
  const preListenSync = source.slice(needsIdx, listenIdx);
  assert.match(
    preListenSync,
    /if \(opts\.sync && !needsFirstRunSetup\)/,
    "blocking startup sync must not run before first-run setup completes",
  );
});
