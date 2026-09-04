/**
 * Passive-mode detection tests.
 *
 * Builds synthetic HOME dirs with various combinations of:
 *   - hook installed / missing
 *   - session log dir present / missing
 * and asserts the per-provider `passive` flag matches expectation.
 *
 * Each test owns its own tempdir so concurrent runs don't interfere.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  detectPassiveProviders,
  isPassiveModeActive,
  dirHasFile,
  classifyWritableFailure,
} = require("../src/lib/passive-mode");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "passive-home-"));
}

test("dirHasFile returns false for non-existent dir", () => {
  assert.equal(dirHasFile("/no/such/dir/xyzzy", () => true), false);
});

test("dirHasFile finds nested files within one level", () => {
  const home = tmpHome();
  const sub = path.join(home, "projects", "demo");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "session.jsonl"), "{}");
  assert.equal(dirHasFile(path.join(home, "projects"), (full) => full.endsWith(".jsonl")), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("classifyWritableFailure: ENOENT, EACCES, writable", () => {
  const home = tmpHome();
  const missing = path.join(home, "nope.json");
  assert.equal(classifyWritableFailure(missing), "settings file missing");

  const existing = path.join(home, "ok.json");
  fs.writeFileSync(existing, "{}");
  assert.match(classifyWritableFailure(existing), /writable|hook may have been removed/);

  fs.rmSync(home, { recursive: true, force: true });
});

test("detectPassiveProviders: hook installed + logs → not passive", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".claude", "projects", "demo"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "demo", "session.jsonl"), "{}");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");

  const out = detectPassiveProviders({
    home,
    hookStatus: { claude: true, gemini: true, codex_notify: true, every_code_notify: true, codebuddy: true },
  });
  const claude = out.find((p) => p.name === "claude");
  assert.equal(claude.passive, false, "hook installed, not passive");
  assert.equal(claude.hook_installed, true);
  assert.equal(claude.logs_present, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("detectPassiveProviders: hook missing + logs present → passive", () => {
  const home = tmpHome();
  // No settings.json, but logs exist → classic WSL/UNC failure mode
  fs.mkdirSync(path.join(home, ".claude", "projects", "demo"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "demo", "session.jsonl"), "{}");

  const out = detectPassiveProviders({
    home,
    hookStatus: { claude: false },
  });
  const claude = out.find((p) => p.name === "claude");
  assert.equal(claude.passive, true);
  assert.equal(claude.hook_installed, false);
  assert.equal(claude.logs_present, true);
  assert.equal(claude.hook_failure_reason, "settings file missing");
  assert.equal(isPassiveModeActive(out), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("detectPassiveProviders: hook missing + no logs → NOT passive (provider not in use)", () => {
  const home = tmpHome();
  // No ~/.claude at all
  const out = detectPassiveProviders({ home, hookStatus: { claude: false } });
  const claude = out.find((p) => p.name === "claude");
  assert.equal(claude.passive, false, "no logs → user doesn't use this provider");
  assert.equal(claude.logs_present, false);
});

test("detectPassiveProviders: codex with naked sessions/ dir", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
  // hook unset → passive
  const out = detectPassiveProviders({ home, hookStatus: { codex_notify: false } });
  const codex = out.find((p) => p.name === "codex");
  assert.equal(codex.passive, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("detectPassiveProviders: acode with naked sessions/ dir", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".acode", "sessions"), { recursive: true });
  const out = detectPassiveProviders({ home, hookStatus: { acode_notify: false } });
  const acode = out.find((p) => p.name === "acode");
  assert.equal(acode.passive, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("isPassiveModeActive: false when no provider is passive", () => {
  const out = [
    { name: "claude", passive: false },
    { name: "gemini", passive: false },
  ];
  assert.equal(isPassiveModeActive(out), false);
});
