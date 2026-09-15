/**
 * End-to-end test for `tracker status --json` / `--light` / `--diagnostics`.
 *
 * Boots the real CLI in a child process against the real ~/.tokentracker
 * state, then asserts the output shape. Designed to catch regressions where
 * a future refactor of status.js drops/renames a top-level summary key that
 * AI agents or CI scripts depend on.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TRACKER = path.resolve(__dirname, "..", "bin", "tracker.js");

function runStatus(args) {
  const res = spawnSync(process.execPath, [TRACKER, "status", ...args], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return res;
}

test("status --json emits a JSON object with required summary fields", () => {
  const res = runStatus(["--json"]);
  assert.equal(res.status, 0, `exit code: ${res.status} stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.ok("version" in parsed, "missing top-level key: version");
  for (const key of [
    "generated_at",
    "base_url",
    "device_token_set",
    "queue",
    "hooks",
    "providers",
    "copilot",
    "subscriptions",
  ]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  assert.ok("pending_bytes" in parsed.queue);
  assert.ok("claude" in parsed.hooks);
  assert.ok("openclaw_session_plugin_conversation_access" in parsed.hooks);
  assert.ok("app_db_has_file" in parsed.copilot);
  assert.ok("app_db_path" in parsed.copilot);
  assert.equal(typeof parsed.device_token_set, "boolean");
});

test("status --light renders an ASCII table with key columns", () => {
  const res = runStatus(["--light"]);
  assert.equal(res.status, 0, `exit code: ${res.status} stderr=${res.stderr}`);
  // table separators show up at top, between header/body, and at bottom
  const sepCount = (res.stdout.match(/^\+-+\+-+\+$/gm) || []).length;
  assert.ok(sepCount >= 3, `expected ≥3 separator lines, got ${sepCount}`);
  // No ANSI / emoji / spinner artifacts
  assert.ok(!/ \[/.test(res.stdout), "ANSI escapes leaked");
  assert.match(res.stdout, /^\| Version/m);
  assert.match(res.stdout, /^\| Key /m);
  assert.match(res.stdout, /^\| Queue pending/m);
  assert.match(res.stdout, /^\| Hook · claude/m);
});

test("status --diagnostics still emits raw diagnostics JSON (back-compat)", () => {
  const res = runStatus(["--diagnostics"]);
  assert.equal(res.status, 0, `exit code: ${res.status} stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  // diagnostics has a different shape: `ok`, `version`, `env`, `paths`
  assert.ok("env" in parsed && "paths" in parsed, "diagnostics shape changed");
  assert.ok(!("hooks" in parsed), "summary keys must not leak into diagnostics");
});

test("status default (no flag) still prints the human-readable list", () => {
  const res = runStatus([]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^TokenTracker v/);
  assert.match(res.stdout, /Status:/);
  assert.match(res.stdout, /^- Queue: \d+ bytes pending/m);
});

test("status --bogus rejects unknown flag", () => {
  const res = runStatus(["--bogus"]);
  assert.notEqual(res.status, 0, "unknown flag must be rejected");
  assert.match(res.stderr + res.stdout, /Unknown option: --bogus/);
  assert.doesNotMatch(res.stderr, /at parseArgs/);
});

test("status --json --no-spinner is accepted (no-spinner is a no-op for status)", () => {
  const res = runStatus(["--json", "--no-spinner"]);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.ok("queue" in parsed);
});
