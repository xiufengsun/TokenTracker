"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");
const TRACKER_SRC = path.join(REPO, "bin", "tracker.js");

function stageNpmPrefix(tmp) {
  const pkgRoot = path.join(tmp, "lib", "node_modules", "tokentracker-cli");
  fs.mkdirSync(path.join(pkgRoot, "bin"), { recursive: true });
  fs.cpSync(path.join(REPO, "src"), path.join(pkgRoot, "src"), { recursive: true });
  fs.copyFileSync(TRACKER_SRC, path.join(pkgRoot, "bin", "tracker.js"));
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(pkgRoot, "package.json"));
  return path.join(pkgRoot, "bin", "tracker.js");
}

function writeFakeNpm(tmp) {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const npmPath = path.join(binDir, "npm");
  fs.writeFileSync(
    npmPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"${TOKENTRACKER_TEST_NPM_LOG}\"",
      "exit \"${TOKENTRACKER_TEST_NPM_EXIT:-0}\"",
      "",
    ].join("\n"),
    { encoding: "utf8" },
  );
  fs.chmodSync(npmPath, 0o755);
  return binDir;
}

function runTracker(entry, args, extraEnv = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ...extraEnv },
  });
}

test("npm-prefix layout runs npm install -g and does not treat the tree as a git checkout", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-update-npm-"));
  try {
    const entry = stageNpmPrefix(tmp);
    const fakeBin = writeFakeNpm(tmp);
    const npmLog = path.join(tmp, "npm.log");
    const res = runTracker(entry, ["update"], {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      TOKENTRACKER_TEST_NPM_LOG: npmLog,
    });
    const text = `${res.stdout}${res.stderr}`;
    assert.equal(res.status, 0, text);
    assert.match(res.stdout, /Detected install: npm/);
    assert.match(res.stdout, /Updating TokenTracker via `npm install -g tokentracker-cli@latest`/);
    assert.match(res.stdout, /Update finished/);
    assert.equal(fs.readFileSync(npmLog, "utf8").trim(), "install -g tokentracker-cli@latest");
    assert.doesNotMatch(text, /git checkout/);
    assert.doesNotMatch(res.stderr, /at run \(/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("npm-prefix update forwards a failing npm exit code", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-update-npm-fail-"));
  try {
    const entry = stageNpmPrefix(tmp);
    const fakeBin = writeFakeNpm(tmp);
    const npmLog = path.join(tmp, "npm.log");
    const res = runTracker(entry, ["update"], {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      TOKENTRACKER_TEST_NPM_LOG: npmLog,
      TOKENTRACKER_TEST_NPM_EXIT: "3",
    });
    assert.equal(res.status, 3);
    assert.match(res.stdout, /Detected install: npm/);
    assert.doesNotMatch(res.stdout, /Update finished/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("this repository checkout refuses to self-update", () => {
  const res = runTracker(TRACKER_SRC, ["update"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /Detected install: other/);
  assert.match(res.stderr, /git checkout/);
  assert.match(res.stderr, /git -C /);
  assert.doesNotMatch(`${res.stdout}${res.stderr}`, /Updating TokenTracker via/);
});

test("unknown command from an npm-prefix install prints help without a stack", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-update-unknown-"));
  try {
    const entry = stageNpmPrefix(tmp);
    const res = runTracker(entry, ["not-a-command"]);
    assert.notEqual(res.status, 0);
    const text = `${res.stdout}${res.stderr}`;
    assert.match(text, /Unknown command: not-a-command/);
    assert.match(text, /Usage:/);
    assert.match(text, /\[--debug\] update/);
    assert.doesNotMatch(res.stderr, /at run \(/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
