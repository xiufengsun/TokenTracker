/**
 * Extra scan roots (#657): resolver semantics.
 *
 *   - config.scanRoots.<provider> entries are appended after the caller's base
 *     roots and the process's implicit root (CODEX_HOME / CLAUDE_CONFIG_DIR)
 *   - `~` expands against the injected home
 *   - roots are deduplicated by realpath, so a symlinked spelling of a root
 *     that is already listed is dropped
 *   - a configured root that is not on disk stays in the list (exists=false)
 *     so cursor-path classification is stable while a volume is unmounted,
 *     but is excluded from the walkable extras
 *   - malformed config never throws
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  appendUniqueDirs,
  dedupeDirsByRealpath,
  describeScanRootOrigin,
  extraScanRootPaths,
  describeScanRootState,
  expandHome,
  loadScanRootsConfig,
  normalizeScanRootsConfig,
  resolveEnvRoot,
  resolveScanRoots,
  scanRootDirState,
} = require("../src/lib/scan-roots");

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-scan-roots-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("normalizeScanRootsConfig tolerates junk and accepts a single string", () => {
  assert.deepEqual(normalizeScanRootsConfig(undefined), { codex: [], claude: [] });
  assert.deepEqual(normalizeScanRootsConfig("nope"), { codex: [], claude: [] });
  assert.deepEqual(normalizeScanRootsConfig(["nope"]), { codex: [], claude: [] });
  assert.deepEqual(
    normalizeScanRootsConfig({ codex: " ~/a ", claude: ["", 42, null, "~/b"], other: ["~/c"] }),
    { codex: ["~/a"], claude: ["~/b"] },
  );
});

test("resolveScanRoots orders base, env, config and labels origins", (t) => {
  const home = tmpdir(t);
  const native = path.join(home, ".codex");
  const envRoot = path.join(home, "env-codex");
  const configRoot = path.join(home, "agent", "codex");
  for (const dir of [native, envRoot, configRoot]) fs.mkdirSync(dir, { recursive: true });

  const roots = resolveScanRoots({
    home,
    env: { CODEX_HOME: envRoot },
    config: { scanRoots: { codex: ["~/agent/codex"] } },
    base: { codex: [native], claude: [path.join(home, ".claude")] },
  });

  assert.deepEqual(
    roots.codex.map((entry) => [entry.path, entry.origin, entry.exists]),
    [[native, "native", true], [envRoot, "env", true], [configRoot, "config", true]],
  );
  // ~/.claude does not exist in this fixture home; it stays listed as native.
  assert.deepEqual(
    roots.claude.map((entry) => [entry.path, entry.origin, entry.exists]),
    [[path.join(home, ".claude"), "native", false]],
  );
  assert.deepEqual(extraScanRootPaths(roots.codex), [envRoot, configRoot]);
  assert.equal(describeScanRootOrigin(roots.codex[1], "codex"), "CODEX_HOME");
  assert.equal(describeScanRootOrigin(roots.codex[2], "codex"), "scanRoots");
  assert.equal(describeScanRootOrigin(roots.codex[0], "codex"), "native");
});

test("resolveScanRoots: CLAUDE_CONFIG_DIR is an implicit Claude root, additive to ~/.claude", (t) => {
  const home = tmpdir(t);
  const native = path.join(home, ".claude");
  const configDir = path.join(home, "agent", "claude");
  fs.mkdirSync(native, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  const roots = resolveScanRoots({
    home,
    env: { CLAUDE_CONFIG_DIR: configDir },
    config: null,
    base: { claude: [native] },
  });
  assert.deepEqual(roots.claude.map((e) => [e.path, e.origin]), [[native, "native"], [configDir, "env"]]);
  assert.deepEqual(extraScanRootPaths(roots.claude), [configDir]);
});

test("resolveScanRoots drops an env root already covered by base, and dedupes symlinked spellings", (t) => {
  const home = tmpdir(t);
  const native = path.join(home, ".codex");
  fs.mkdirSync(native, { recursive: true });
  const alias = path.join(home, "codex-link");
  try {
    fs.symlinkSync(native, alias, "dir");
  } catch (_e) {
    t.skip("directory symlinks are not available on this platform");
    return;
  }

  const roots = resolveScanRoots({
    home,
    env: { CODEX_HOME: native },
    config: { scanRoots: { codex: [alias, native, "~/codex-link"] } },
    base: { codex: [native] },
  });
  assert.deepEqual(roots.codex.map((e) => [e.path, e.origin]), [[native, "native"]]);
});

test("resolveScanRoots keeps a missing configured root but does not offer it for walking", (t) => {
  const home = tmpdir(t);
  const missing = path.join(home, "not-here", "codex");
  const roots = resolveScanRoots({
    home,
    env: {},
    config: { scanRoots: { codex: [missing] } },
    base: { codex: [path.join(home, ".codex")] },
  });
  assert.deepEqual(roots.codex.map((e) => [e.path, e.origin, e.exists]), [
    [path.join(home, ".codex"), "native", false],
    [missing, "config", false],
  ]);
  assert.deepEqual(extraScanRootPaths(roots.codex), []);
});

test("dedupeDirsByRealpath / appendUniqueDirs collapse a symlinked projects dir", (t) => {
  const home = tmpdir(t);
  const real = path.join(home, ".claude", "projects");
  fs.mkdirSync(real, { recursive: true });
  const profileB = path.join(home, "profile-b");
  fs.mkdirSync(profileB, { recursive: true });
  try {
    fs.symlinkSync(real, path.join(profileB, "projects"), "dir");
  } catch (_e) {
    t.skip("directory symlinks are not available on this platform");
    return;
  }
  const other = path.join(home, "other", "projects");
  fs.mkdirSync(other, { recursive: true });

  assert.deepEqual(
    dedupeDirsByRealpath([real, path.join(profileB, "projects"), other, path.join(home, "missing-1"), path.join(home, "missing-1")]),
    [real, other, path.join(home, "missing-1")],
  );
  // Base entries are never collapsed against each other (native + WSL pair);
  // extras are collapsed against base and each other.
  assert.deepEqual(
    appendUniqueDirs([real, real], [path.join(profileB, "projects"), other, other]),
    [real, real, other],
  );
});

test("expandHome / resolveScanRoots resolve relative entries against home, never cwd", (t) => {
  const home = tmpdir(t);
  fs.mkdirSync(path.join(home, "agent", "codex"), { recursive: true });
  assert.equal(expandHome("agent/codex", home), path.join(home, "agent", "codex"));
  assert.equal(expandHome("~/agent/codex", home), path.join(home, "agent", "codex"));
  assert.equal(expandHome("~", home), path.resolve(home));
  assert.equal(expandHome("/abs/x/../y", home), path.resolve("/abs/y"));
  assert.equal(expandHome("  ", home), null);

  const cwd = process.cwd();
  const elsewhere = tmpdir(t);
  process.chdir(elsewhere);
  try {
    const roots = resolveScanRoots({
      home,
      env: {},
      config: { scanRoots: { codex: ["agent/codex"] } },
      base: { codex: [path.join(home, ".codex")] },
    });
    assert.deepEqual(roots.codex.map((e) => [e.path, e.origin, e.exists]), [
      [path.join(home, ".codex"), "native", false],
      [path.join(home, "agent", "codex"), "config", true],
    ]);
  } finally {
    process.chdir(cwd);
  }
});

test("resolveEnvRoot normalizes CODEX_HOME / CLAUDE_CONFIG_DIR once: relative values anchor to home, never cwd", (t) => {
  const home = tmpdir(t);
  assert.equal(resolveEnvRoot("codex", { env: {}, home }), null);
  assert.equal(resolveEnvRoot("codex", { env: { CODEX_HOME: "  " }, home }), null);
  assert.equal(resolveEnvRoot("codex", { env: { CODEX_HOME: "profiles/codex" }, home }), path.join(home, "profiles", "codex"));
  assert.equal(resolveEnvRoot("codex", { env: { CODEX_HOME: "~/profiles/codex" }, home }), path.join(home, "profiles", "codex"));
  assert.equal(resolveEnvRoot("codex", { env: { CODEX_HOME: "/abs/codex/" }, home }), path.resolve("/abs/codex"));
  assert.equal(resolveEnvRoot("claude", { env: { CLAUDE_CONFIG_DIR: "profiles/claude" }, home }), path.join(home, "profiles", "claude"));
  assert.equal(resolveEnvRoot("unknown", { env: { CODEX_HOME: "x" }, home }), null);
  // The env entry in resolveScanRoots is the same normalized value.
  const cwd = process.cwd();
  process.chdir(tmpdir(t));
  try {
    const roots = resolveScanRoots({ home, env: { CODEX_HOME: "profiles/codex" }, config: null, base: { codex: [] } });
    assert.deepEqual(roots.codex.map((e) => [e.path, e.origin]), [[path.join(home, "profiles", "codex"), "env"]]);
  } finally {
    process.chdir(cwd);
  }
});

test("scanRootDirState: absence vs stat errors vs a file in place of a directory", (t) => {
  const home = tmpdir(t);
  const dir = path.join(home, "dir");
  fs.mkdirSync(dir);
  const file = path.join(home, "file");
  fs.writeFileSync(file, "");
  assert.deepEqual(scanRootDirState(dir), { exists: true, error: null });
  assert.deepEqual(scanRootDirState(path.join(home, "nope")), { exists: false, error: null });
  assert.deepEqual(scanRootDirState(file), { exists: false, error: null });
  assert.deepEqual(scanRootDirState(path.join(file, "child")), { exists: false, error: null }); // ENOTDIR
  const failing = (code) => ({ statSync: () => { const e = new Error(code); e.code = code; throw e; } });
  assert.deepEqual(scanRootDirState(dir, failing("EACCES")), { exists: false, error: "EACCES" });
  assert.deepEqual(scanRootDirState(dir, failing("ELOOP")), { exists: false, error: "ELOOP" });
  // A directory that stats fine but cannot be listed is unreadable, not present.
  const unlistable = { opendirSync: () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } };
  assert.deepEqual(scanRootDirState(dir, unlistable), { exists: false, error: "EACCES" });

  const roots = resolveScanRoots({
    home,
    env: {},
    config: { scanRoots: { claude: [dir] } },
    base: { claude: [path.join(home, ".claude")] },
    deps: failing("EACCES"),
  });
  const entry = roots.claude.find((e) => e.origin === "config");
  assert.equal(entry.exists, false);
  assert.equal(entry.error, "EACCES");
  assert.deepEqual(extraScanRootPaths(roots.claude), [], "an unreadable root is not offered for walking");
  assert.equal(describeScanRootState(entry), " (unreadable: EACCES)");
  assert.equal(describeScanRootState({ exists: false, error: null }), " (missing)");
  assert.equal(describeScanRootState({ exists: true, error: null }), "");
});

test("a stat-able directory that cannot be listed is reported unreadable, not present (real permissions)", (t) => {
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    t.skip("permission bits are not enforced for this user/platform");
    return;
  }
  const home = tmpdir(t);
  const locked = path.join(home, "locked", "claude");
  fs.mkdirSync(locked, { recursive: true });
  fs.chmodSync(locked, 0o000);
  try {
    assert.equal(fs.statSync(locked).isDirectory(), true, "precondition: stat succeeds");
    assert.deepEqual(scanRootDirState(locked), { exists: false, error: "EACCES" });
    const roots = resolveScanRoots({
      home,
      env: {},
      config: { scanRoots: { claude: [locked] } },
      base: { claude: [path.join(home, ".claude")] },
    });
    const entry = roots.claude.find((e) => e.origin === "config");
    assert.equal(entry.exists, false);
    assert.equal(entry.error, "EACCES");
    assert.deepEqual(extraScanRootPaths(roots.claude), []);
  } finally {
    // Restore before the tmpdir cleanup hook runs, or rmSync fails on the locked dir.
    fs.chmodSync(locked, 0o755);
  }
});

test("loadScanRootsConfig reads config.json under the tracker dir and tolerates its absence", async (t) => {
  const home = tmpdir(t);
  assert.deepEqual(await loadScanRootsConfig({ home }), { codex: [], claude: [] });
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "config.json"), JSON.stringify({ scanRoots: { claude: ["~/x"] } }));
  assert.deepEqual(await loadScanRootsConfig({ home }), { codex: [], claude: ["~/x"] });
  fs.writeFileSync(path.join(trackerDir, "config.json"), "{not json");
  assert.deepEqual(await loadScanRootsConfig({ home }), { codex: [], claude: [] });
});
