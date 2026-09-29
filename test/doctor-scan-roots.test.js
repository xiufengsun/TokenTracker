/**
 * Extra scan roots (#657) in the doctor report: extras are listed, a missing
 * configured root warns, and installs without extras get no additional check.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDoctorReport } = require("../src/lib/doctor");

async function report(scanRoots) {
  return buildDoctorReport({
    runtime: { baseUrl: null },
    diagnostics: { scan_roots: scanRoots },
    fetch: async () => { throw new Error("network must not be used"); },
    paths: {},
  });
}

test("doctor: no extra scan roots → no scan_roots check", async () => {
  const r = await report({
    codex: [{ path: "~/.codex", origin: "native", exists: true }],
    claude: [{ path: "~/.claude", origin: "native", exists: true }],
  });
  assert.equal(r.checks.some((check) => check.id === "scan_roots.extra"), false);
});

test("doctor: extra scan roots present → ok, listing each root", async () => {
  const r = await report({
    codex: [
      { path: "~/.codex", origin: "native", exists: true },
      { path: "~/agent/codex", origin: "config", exists: true },
    ],
    claude: [
      { path: "~/.claude", origin: "native", exists: true },
      { path: "~/agent/claude", origin: "env", exists: true },
    ],
  });
  const check = r.checks.find((c) => c.id === "scan_roots.extra");
  assert.ok(check);
  assert.equal(check.status, "ok");
  assert.equal(check.detail, "2 extra scan root(s) present: codex ~/agent/codex, claude ~/agent/claude");
  assert.equal(check.meta.roots.length, 2);
});

test("doctor: a missing or unreadable configured root → warn naming it", async () => {
  const r = await report({
    codex: [{ path: "~/.codex", origin: "native", exists: true }, { path: "~/gone/codex", origin: "config", exists: false, error: null }],
    claude: [
      { path: "~/.claude", origin: "native", exists: true },
      { path: "~/agent/claude", origin: "config", exists: true },
      { path: "~/locked/claude", origin: "config", exists: false, error: "EACCES" },
    ],
  });
  const check = r.checks.find((c) => c.id === "scan_roots.extra");
  assert.equal(check.status, "warn");
  assert.equal(check.detail, "2 of 3 extra scan root(s) unavailable: codex ~/gone/codex, claude ~/locked/claude (unreadable: EACCES)");
  assert.equal(r.summary.warn >= 1, true);
});
