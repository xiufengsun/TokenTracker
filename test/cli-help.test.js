const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const { run } = require("../src/cli");

const TRACKER = path.resolve(__dirname, "..", "bin", "tracker.js");

async function captureRun(argv) {
  const prevOut = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExit = process.exitCode;
  let out = "";
  let err = "";
  try {
    process.stdout.write = (chunk) => {
      out += String(chunk || "");
      return true;
    };
    process.stderr.write = (chunk) => {
      err += String(chunk || "");
      return true;
    };
    await run(argv);
    return { out, err, exitCode: process.exitCode };
  } finally {
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
    process.exitCode = prevExit;
  }
}

test("help output uses TokenTracker identifiers", async () => {
  const { out } = await captureRun(["-h"]);

  assert.match(out, /tokentracker/);
  assert.ok(!out.includes("vibe"));
  assert.match(out, /doctor/);
  assert.match(out, /npx tokentracker \[--debug\] update/);
  assert.doesNotMatch(out, /update \[--dry-run\]/);
});

test("unknown command prints help without throwing", async () => {
  const { out, err, exitCode } = await captureRun(["not-a-command"]);
  assert.equal(exitCode, 1);
  assert.match(err, /Unknown command: not-a-command/);
  assert.match(out, /Usage:/);
  assert.match(out, /npx tokentracker \[--debug\] update/);
  assert.equal(err.includes("    at "), false);
});

test("help command prints the same usage text", async () => {
  const { out, exitCode } = await captureRun(["help"]);
  assert.ok(!exitCode);
  assert.match(out, /Usage:/);
});

test("upgrade is an alias of update help", async () => {
  const { out, err, exitCode } = await captureRun(["upgrade", "--help"]);
  assert.ok(!exitCode);
  assert.equal(err, "");
  assert.match(out, /tokentracker update/);
  assert.equal(out.includes("--dry-run"), false);
});

test("CLI process prints help and no stack for an unknown command", () => {
  const res = spawnSync(process.execPath, [TRACKER, "not-a-command"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.notEqual(res.status, 0);
  const text = `${res.stdout}${res.stderr}`;
  assert.match(text, /Unknown command: not-a-command/);
  assert.match(text, /Usage:/);
  assert.doesNotMatch(res.stderr, /at run \(/);
});

test("update --dry-run is rejected without a stack trace", () => {
  const res = spawnSync(process.execPath, [TRACKER, "update", "--dry-run"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.notEqual(res.status, 0);
  assert.match(`${res.stdout}${res.stderr}`, /Unknown option: --dry-run/);
  assert.doesNotMatch(res.stderr, /at parseArgs/);
});
